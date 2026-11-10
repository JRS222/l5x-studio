/* L5X Studio - l5k-data.js (T2). Decoding of tag initial values: L5K textual form
   (arrays / based literals / strings / nested structures), the undecoded binary
   `<Data>` byte form used by some exports, and Decorated data trees.
   Reference semantics: jvalenzuela/l5x tag.py (integer/bit/real/structure/array value
   access) translated to the plain-object model from js/l5x-model.js.

   Public API (docs/IMPROVEMENTS.md, T2):
     parseL5kValue(text, dataType, model) -> parsed
     describeL5kValue(parsed) -> string
     tagInitialValue(model, tagRecord) -> { format, parsed }
     formatL5kValue(decoded, dataType) -> string
   Extra helpers used by the I/O list: parseDecoratedValue(tree, dataType, model).
   Never throws: unparseable input returns { kind:"raw", value:<text>, warning }. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && module.exports;

  /* ------------------------------------------------------------------ types */

  const INT_WIDTH = { SINT: 1, INT: 2, DINT: 4, LINT: 8 };
  const ELEMENTARY = { SINT: 1, INT: 1, DINT: 1, LINT: 1, BOOL: 1, REAL: 1, STRING: 1, BIT: 1 };

  function uc(v) { return String(v === null || v === undefined ? "" : v).toUpperCase(); }
  function isElementary(dt) { return !!ELEMENTARY[uc(dt)]; }

  function findDataType(model, name) {
    if (!model || !name || !model.dataTypes) return null;
    const target = uc(name);
    for (let i = 0; i < model.dataTypes.length; i++) {
      if (uc(model.dataTypes[i].name) === target) return model.dataTypes[i];
    }
    return null;
  }

  /* Members of a structure that carry a value in the L5K flattened form. BIT
     members are overlays into a backing word member (Target/BitNumber in the
     L5X), so they are not emitted separately. */
  function structMembers(dt) {
    if (!dt || !dt.members) return [];
    return dt.members.filter(function (m) { return uc(m.dataType) !== "BIT"; });
  }

  /* ------------------------------------------------------------- result shape */

  function makeResult(kind, type, value, elements, raw, extra) {
    const res = {
      kind: kind,
      type: type === undefined || type === null ? null : type,
      raw: raw === undefined || raw === null ? null : String(raw),
      value: value === undefined ? null : value,
      elements: elements || null
    };
    if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) res[k] = extra[k];
    return res;
  }

  function rawResult(text, dataType, warning) {
    return makeResult("raw", dataType, text === null || text === undefined ? "" : String(text), null,
      text === null || text === undefined ? "" : String(text),
      { warning: warning || "unrecognized L5K value" });
  }

  function parseError(m) { const e = new Error(m); e.l5kParse = true; return e; }

  /* --------------------------------------------------------- L5K text parser */

  var WHITESPACE_RE = /[\s\u0000]+/g;

  /* Collapse the pretty-printed whitespace the exporters put inside CDATA. */
  function normalizeText(text) {
    if (text === null || text === undefined) return "";
    return String(text).replace(WHITESPACE_RE, " ").trim();
  }

  function ParseError(msg) { this.message = msg; }

  /* Recursive-descent parser for the L5K data literal grammar:
       value   := array | string | based-int | number | TRUE | FALSE
       array   := "[" (value ("," value)*)? "]"
       string  := "'" chars "'"   (with $ escapes)
     Bare identifiers are kept as { t:"ident" } so the `[TypeName][...]` structure
     literal prefix can be recognised by the caller. */
  function Tokenizer(s) {
    this.s = s;
    this.pos = 0;
    this.n = s.length;
  }

  Tokenizer.prototype.skipWs = function () {
    while (this.pos < this.n && /\s/.test(this.s[this.pos])) this.pos++;
  };

  Tokenizer.prototype.parseValue = function () {
    this.skipWs();
    if (this.pos >= this.n) throw new ParseError("unexpected end of value");
    const ch = this.s[this.pos];
    if (ch === "[") return this.parseArray();
    if (ch === "'" || ch === "\"") return this.parseString(ch);
    return this.parseBare();
  };

  /* returns the parsed token plus the (whitespace-trimmed) remainder text */
  Tokenizer.prototype.parseAll = function () {
    const v = this.parseValue();
    this.skipWs();
    return { value: v, rest: this.s.slice(this.pos) };
  };

  Tokenizer.prototype.parseArray = function () {
    this.pos++; // [
    const items = [];
    this.skipWs();
    if (this.pos < this.n && this.s[this.pos] === "]") { this.pos++; return { t: "array", items: items }; }
    for (;;) {
      items.push(this.parseValue());
      this.skipWs();
      if (this.pos >= this.n) throw new ParseError("unterminated array");
      const ch = this.s[this.pos];
      if (ch === ",") {
        this.pos++;
        this.skipWs();
        if (this.pos < this.n && this.s[this.pos] === "]") throw new ParseError("trailing comma in array");
        continue;
      }
      if (ch === "]") { this.pos++; break; }
      throw new ParseError("unexpected '" + ch + "' inside array");
    }
    return { t: "array", items: items };
  };

  Tokenizer.prototype.parseString = function (quote) {
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.n) {
      let ch = this.s[this.pos++];
      if (ch === quote) return { t: "string", value: out };
      if (ch === "$") {
        if (this.pos >= this.n) throw new ParseError("dangling $ escape");
        const nx = this.s[this.pos];
        if (nx === "$" || nx === "'" || nx === "\"" || nx === "\\") { out += nx; this.pos++; }
        else if (/[0-9A-Fa-f]/.test(nx) && this.pos + 1 < this.n && /[0-9A-Fa-f]/.test(this.s[this.pos + 1])) {
          out += String.fromCharCode(parseInt(this.s.substr(this.pos, 2), 16));
          this.pos += 2;
        } else { out += nx; this.pos++; }
      } else out += ch;
    }
    throw new ParseError("unterminated string literal");
  };

  Tokenizer.prototype.parseBare = function () {
    const start = this.pos;
    while (this.pos < this.n && !/[,()\[\]\s]/.test(this.s[this.pos])) this.pos++;
    const text = this.s.slice(start, this.pos);
    if (!text) throw new ParseError("empty token");
    return classifyBare(text);
  };

  function classifyBare(text) {
    var m = text.match(/^([0-9A-Fa-f]{1,2})#([0-9A-Za-z_]+)$/);
    if (m) {
      const radix = parseInt(m[1], 10);
      if (radix === 2 || radix === 8 || radix === 10 || radix === 16) {
        const digits = m[2].replace(/_/g, "");
        const num = parseInt(digits, radix);
        if (!isNaN(num)) {
          return { t: "int", value: num, raw: text, radix: radix, digits: digits, width: digits.length * (radix === 16 ? 4 : radix === 8 ? 3 : radix === 2 ? 1 : 0) };
        }
      }
    }
    if (/^[+-]?\d+$/.test(text)) return { t: "int", value: parseInt(text, 10), raw: text };
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return { t: "real", value: parseFloat(text), raw: text };
    if (/^TRUE$/i.test(text)) return { t: "bool", value: 1, raw: text };
    if (/^FALSE$/i.test(text)) return { t: "bool", value: 0, raw: text };
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return { t: "ident", name: text, raw: text };
    throw new ParseError("unrecognized token '" + text + "'");
  }

  function tokenRaw(node) {
    if (!node) return "";
    if (node.raw !== undefined) return node.raw;
    if (node.t === "array") return "[" + node.items.map(tokenRaw).join(",") + "]";
    if (node.t === "string") return "''";
    return "";
  }

  /* ---------------------------------------------------------- byte-form decode */

  var BYTE_DUMP_RE = /^[0-9A-Fa-f]{2}(?:[ \t]+[0-9A-Fa-f]{2})+$/;

  /* Undecoded `<Data>` payloads are hex bytes, little-endian, exactly as RSLogix
     writes them (e.g. DINT 5 -> "05 00 00 00", REAL 0 -> "00 00 00 00"). */
  function looksLikeByteDump(s) { return BYTE_DUMP_RE.test(s); }

  function signed8(b) { return (b << 24) >> 24; }
  function signed16(lo, hi) { return ((lo | (hi << 8)) << 16) >> 16; }
  function signed32(b0, b1, b2, b3) { return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0; }

  function decodeReal32(b0, b1, b2, b3) {
    try {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint8(0, b0); dv.setUint8(1, b1); dv.setUint8(2, b2); dv.setUint8(3, b3);
      return dv.getFloat32(0, true);
    } catch (e) { return null; }
  }

  function decodeLint64(bytes) {
    if (typeof BigInt !== "function") return null;
    let acc = BigInt(0);
    for (let i = 7; i >= 0; i--) acc = (acc << BigInt(8)) | BigInt(bytes[i] & 0xff);
    const signedVal = BigInt.asIntN(64, acc);
    const num = Number(signedVal);
    return { value: num, risky: BigInt(num) !== signedVal };
  }

  /* Decode the hex-byte payload for a declared elementary data type. Returns null
     when the type is not representable this way (UDTs etc. -> caller raw-falls back). */
  function decodeBytes(bytes, dataType) {
    const dt = uc(dataType);
    const n = bytes.length;
    if (!n) return null;
    if (dt === "BOOL") {
      const bits = [];
      for (let i = 0; i < n && bits.length < 32 * 8; i++) {
        for (let b = 0; b < 8; b++) bits.push((bytes[i] >> b) & 1);
      }
      return { kind: "array", value: bits, elements: bits.map(function (v) { return { value: v, raw: v ? "1" : "0" }; }), fromBytes: true };
    }
    if (dt === "SINT") {
      const vals = bytes.map(signed8);
      return arrayOrScalar(vals, 1);
    }
    if (dt === "INT" && n >= 2) {
      const vals = [];
      for (let i = 0; i + 1 < n; i += 2) vals.push(signed16(bytes[i], bytes[i + 1]));
      return arrayOrScalar(vals, 2);
    }
    if (dt === "DINT" && n >= 4) {
      const vals = [];
      for (let i = 0; i + 3 < n; i += 4) vals.push(signed32(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]));
      return arrayOrScalar(vals, 4);
    }
    if (dt === "LINT" && n >= 8) {
      const vals = [];
      let risky = false;
      for (let i = 0; i + 7 < n; i += 8) {
        const r = decodeLint64(bytes.slice(i, i + 8));
        if (r === null) return null;
        if (r.risky) risky = true;
        vals.push(r.value);
      }
      const out = arrayOrScalar(vals, 8);
      if (risky) out.warning = "LINT value exceeds the exact integer range of JavaScript numbers";
      return out;
    }
    if (dt === "REAL" && n >= 4) {
      const vals = [];
      for (let i = 0; i + 3 < n; i += 4) {
        const v = decodeReal32(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
        if (v === null) return null;
        vals.push(v);
      }
      return arrayOrScalar(vals, 4);
    }
    if (dt === "STRING" && n >= 4) {
      const len = signed32(bytes[0], bytes[1], bytes[2], bytes[3]);
      const chars = bytes.slice(4, 4 + Math.max(0, Math.min(len, 82)));
      let str = "";
      for (let i = 0; i < chars.length; i++) str += String.fromCharCode(chars[i]);
      return { kind: "string", value: str, elements: [{ value: str, raw: quoteL5k(str) }], length: len };
    }
    return null;
  }

  function arrayOrScalar(vals, width) {
    if (vals.length === 1) {
      return { kind: "scalar", value: vals[0], elements: [{ value: vals[0], raw: String(vals[0]) }], fromBytes: true };
    }
    return { kind: "array", value: vals, elements: vals.map(function (v) { return { value: v, raw: String(v) }; }), fromBytes: true };
  }

  /* ------------------------------------------------------- decorated tree decode */

  /* Convert a memberTree (l5x-model.js) initial value tree to a parsed result.
     Values in decorated data are raw literal strings per member data type. */
  function parseDecoratedValue(tree, dataType, model) {
    if (!tree) return rawResult("", dataType, "no decorated data");
    try {
      return decodeDecoratedNode(tree, model);
    } catch (e) {
      return rawResult(tree && tree.value, dataType, "decorated value decode failed: " + e.message);
    }
  }

  function decodeDecoratedNode(node, model) {
    if (!node) return makeResult("scalar", null, null, null, "");
    const type = node.dataType || null;
    if (node.children && node.children.length) {
      const value = {};
      const elements = [];
      for (const child of node.children) {
        const sub = decodeDecoratedNode(child, model);
        value[child.name] = sub.value;
        elements.push({ name: child.name, value: sub.value, dataType: child.dataType || null });
      }
      return makeResult("struct", type, value, elements, null, { dataType: type });
    }
    if (node.elements && node.elements.length) {
      const vals = [];
      const elements = [];
      for (const el of node.elements) {
        const sub = parseL5kScalarText(el.value, type, model);
        vals.push(sub.value);
        elements.push({ index: el.index, value: sub.value });
      }
      return makeResult("array", type, vals, elements, null, { dataType: type });
    }
    if (node.value !== null && node.value !== undefined) {
      const sub = parseL5kValue(node.value, type, model);
      sub.elements = sub.elements || [{ value: sub.value, raw: String(node.value) }];
      return sub;
    }
    return makeResult("scalar", type, null, null, "");
  }

  /* Scalar string value from decorated data, coerced for BOOL/etc. */
  function parseL5kScalarText(text, dataType, model) {
    const parsed = parseL5kValue(text, dataType, model);
    if (parsed.kind === "scalar") return parsed;
    // decorated members are always scalars; if our parser disagrees keep the text
    return makeResult("scalar", dataType, parsed.value, null, String(text));
  }

  /* ---------------------------------------------------------- text finalization */

  function stringValue(node) {
    let s = node.value;
    const nul = s.indexOf("\u0000");
    if (nul !== -1) s = s.slice(0, nul);
    return s;
  }

  function isStringPair(node) {
    return node && node.t === "array" && node.items.length >= 2 &&
      node.items[0] && node.items[0].t === "int" &&
      node.items[1] && node.items[1].t === "string";
  }

  function decodeNodePlain(node, model) {
    if (!node) return null;
    switch (node.t) {
      case "int": case "real": case "bool": return node.value;
      case "string": return stringValue(node);
      case "ident": return node.name;
      case "array": return node.items.map(function (it) { return decodeNodePlain(it, model); });
      case "struct": {
        const items = node.items && node.items.t === "array" ? node.items.items : [];
        return { type: node.typeName, value: items.map(function (it) { return decodeNodePlain(it, model); }) };
      }
      default: return null;
    }
  }

  function nodeScalarValue(node, dataType) {
    const dt = uc(dataType);
    if (node.t === "bool") return node.value ? 1 : 0;
    if (node.t === "int" || node.t === "real") {
      if (dt === "BOOL") return node.value ? 1 : 0;
      return node.value;
    }
    if (node.t === "string") return stringValue(node);
    return decodeNodePlain(node, null);
  }

  /* Build the parsed result for an array node given the declared data type. */
  function buildArrayParsed(node, dataType, model, rawText) {
    const dt = uc(dataType);
    const dtDef = findDataType(model, dataType);
    const items = node.items;

    if (dtDef) {
      const members = structMembers(dtDef);
      if (items.length && items.length === members.length && !(items.every(function (it) { return it.t === "array"; }) && members.length !== items.length)) {
        const value = {};
        const elements = [];
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          const sub = decodeMemberValue(items[i], m, model);
          value[m.name] = sub.value;
          elements.push({ name: m.name, value: sub.value, dataType: m.dataType });
        }
        return makeResult("struct", dtDef.name || dataType, value, elements, rawText,
          { dataType: dtDef.name || dataType, memberCount: members.length });
      }
      // array of structure instances: [[a,b],[c,d]] for a UDT array tag
      if (items.length && items.every(function (it) { return it.t === "array"; })) {
        const vals = [];
        const elements = [];
        for (let i = 0; i < items.length; i++) {
          const sub = buildArrayParsed(items[i], dataType, model, rawText);
          vals.push(sub.value);
          elements.push({ index: "[" + i + "]", value: sub.value });
        }
        return makeResult("array", dtDef.name || dataType, vals, elements, rawText,
          { elementType: dtDef.name || dataType, structType: dtDef.name || dataType });
      }
      const plain = items.map(function (it) { return decodeNodePlain(it, model); });
      return makeResult("struct", dtDef.name || dataType, plain,
        plain.map(function (v, i) { return { name: (structMembers(dtDef)[i] || {}).name, value: v }; }), rawText,
        { dataType: dtDef.name || dataType, warning: "structure value has " + items.length +
            " element(s) but data type declares " + members.length + " members; kept as ordered array" });
    }

    const plain = items.map(function (it) { return nodeScalarValue(it, dataType); });
    const elements = items.map(function (it, i) { return { value: plain[i], raw: tokenRaw(it) }; });
    return makeResult("array", dataType, plain, elements, rawText, { dataType: dataType });
  }

  /* Decode one structure member value (node) for a memberTree from l5x-model.js. */
  function decodeMemberValue(node, member, model) {
    const dt = uc(member.dataType);
    const dtDef = findDataType(model, member.dataType);
    if (node.t === "string" && dt !== "STRING") return { value: stringValue(node) };
    if (dt === "STRING") return { value: stringValue(node) };
    if (member.dimension && member.dimension > 0) {
      // array member: value must arrive as a nested array
      if (node.t === "array") {
        const vals = [];
        for (const it of node.items) {
          if (dtDef && it.t === "array") vals.push(buildArrayParsed(it, member.dataType, model, "").value);
          else if (it.t === "array") vals.push(it.items.map(function (x) { return decodeNodePlain(x, model); }));
          else vals.push(nodeScalarValue(it, member.dataType));
        }
        return { value: vals };
      }
      return { value: nodeScalarValue(node, member.dataType) };
    }
    if (dtDef) {
      if (node.t === "array") {
        return { value: buildArrayParsed(node, member.dataType, model, "").value };
      }
      return { value: decodeNodePlain(node, model) };
    }
    return { value: nodeScalarValue(node, member.dataType) };
  }

  /* String data types: scalar STRING value arrives as [length,'chars']; a STRING
     array tag arrives as [[len,'s'],...]. */
  function buildStringParsed(node, dataType, rawText) {
    if (node.t === "string") {
      const v = stringValue(node);
      return makeResult("string", "STRING", v, [{ value: v, raw: quoteL5k(v) }], rawText, { length: v.length });
    }
    if (node.t === "array") {
      if (isStringPair(node)) {
        const v = stringValue(node.items[1]);
        return makeResult("string", "STRING", v, [{ value: v, raw: quoteL5k(v) }], rawText,
          { length: node.items[0].value, declaredLength: node.items[0].value, stringLength: v.length });
      }
      const pairs = node.items;
      if (pairs.length && pairs.every(isStringPair)) {
        const vals = pairs.map(function (p) { return stringValue(p.items[1]); });
        return makeResult("array", "STRING", vals, vals.map(function (v) { return { value: v, raw: quoteL5k(v) }; }), rawText,
          { elementType: "STRING" });
      }
      if (!pairs.length) return makeResult("string", "STRING", "", [], rawText);
    }
    return rawResult(rawText, dataType, "not a recognisable STRING value");
  }

  function buildScalarParsed(node, dataType, rawText) {
    const dt = uc(dataType);
    if (dt === "STRING") return buildStringParsed(node, dataType, rawText);
    if (node.t === "array") {
      // A scalar-typed tag should not have an array literal; keep it decodable.
      return buildArrayParsed(node, dataType, null, rawText);
    }
    const value = nodeScalarValue(node, dataType);
    const extra = { dataType: dataType };
    if (dt === "BOOL" && node.t === "int" && node.radix !== undefined && node.width > 1) {
      // e.g. 2#1010 on a BOOL tag: the word encodes several bits. Keep the scalar
      // boolean value (nonzero = ON) but expose the decoded bit pattern.
      const bits = [];
      for (let i = 0; i < node.width; i++) bits.push((node.value >> i) & 1);
      extra.bits = bits;
      extra.bitPattern = true;
    }
    if (dt === "LINT" && typeof value === "number" && Math.abs(value) > 9007199254740991) {
      extra.warning = "LINT value exceeds the exact integer range of JavaScript numbers";
    }
    return makeResult("scalar", dataType, value, [{ value: value, raw: tokenRaw(node) }], rawText, extra);
  }

  /* Top-level: a structure literal may be prefixed with its type name:
       [MyType] [v1,v2,...]
     The exporters in practice write the bare flattened array, but older L5K
     dumps and hand-written files use the prefix; tolerate both. */
  function parseStructuredText(s, dataType, model, raw) {
    const tok = new Tokenizer(s);
    const first = tok.parseAll();
    let node = first.value;
    let structType = null;
    if (node.t === "array" && node.items.length === 1 && node.items[0].t === "ident" &&
        first.rest && first.rest.trim().charAt(0) === "[") {
      structType = node.items[0].name;
      const tok2 = new Tokenizer(first.rest.trim());
      const second = tok2.parseAll();
      if (second.value.t !== "array") throw new ParseError("type-prefixed structure literal without member array");
      node = { t: "struct", typeName: structType, items: second.value };
      if (second.rest && second.rest.trim()) throw new ParseError("trailing data after structure literal");
    } else if (first.rest && first.rest.trim()) {
      throw new ParseError("trailing data after value: " + first.rest.trim().slice(0, 24));
    }

    if (node.t === "struct") {
      const dtDef = findDataType(model, structType) || findDataType(model, dataType);
      if (dtDef) {
        const sub = buildArrayParsed(node.items, dtDef.name, model, raw);
        sub.kind = "struct";
        sub.type = dtDef.name;
        if (!sub.warning) sub.warning = undefined;
        return sub;
      }
      const plain = node.items.items.map(function (it) { return decodeNodePlain(it, model); });
      return makeResult("struct", structType || dataType, plain, plain.map(function (v, i) { return { index: i, value: v }; }), raw,
        { warning: "structure type " + (structType || dataType) + " is not declared in the project; kept as ordered array" });
    }
    if (node.t === "array") {
      const dt = uc(dataType);
      if (dt === "STRING") return buildStringParsed(node, dataType, raw);
      const dtDef = findDataType(model, dataType);
      if (dtDef) return buildArrayParsed(node, dataType, model, raw);
      const plain = node.items.map(function (it) { return nodeScalarValue(it, dataType); });
      return makeResult("array", dataType, plain,
        node.items.map(function (it, i) { return { value: plain[i], raw: tokenRaw(it) }; }), raw,
        { dataType: dataType });
    }
    return buildScalarParsed(node, dataType, raw);
  }

  /* ----------------------------------------------------------------- public API */

  function parseL5kValue(text, dataType, model) {
    const raw = text === null || text === undefined ? "" : String(text);
    try {
      const s = normalizeText(text);
      const dt = uc(dataType);
      if (!s) return makeResult("scalar", dataType, null, null, raw, { warning: "empty initial value" });

      // Undecoded binary payload (no Format attribute in L5X): little-endian bytes.
      if (looksLikeByteDump(s)) {
        const bytes = s.split(/\s+/).map(function (h) { return parseInt(h, 16); });
        const bytesDecoded = decodeBytes(bytes, dataType);
        if (bytesDecoded) {
          const res = makeResult(bytesDecoded.kind, dataType, bytesDecoded.value, bytesDecoded.elements, raw, {
            encoding: "raw-bytes", fromBytes: true
          });
          if (bytesDecoded.warning) res.warning = bytesDecoded.warning;
          return res;
        }
        return rawResult(raw, dataType,
          "undecoded binary L5K data for data type " + (dataType || "(unknown)") + " is not supported" +
          " (decoded in Decorated form only)");
      }

      // A bare TRUE/FALSE/type name is parsed by the normal tokenizer below.
      return parseStructuredText(s, dataType, model, raw);
    } catch (e) {
      return rawResult(raw, dataType, (e && e.message) ? e.message : "unrecognized L5K value");
    }
  }

  /* ------------------------------------------------------------------ describe */

  function oneLine(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      if (!isFinite(v)) return String(v);
      if (Math.abs(v) >= 1e7 || (v !== 0 && Math.abs(v) < 1e-4)) return v.toExponential(4);
      return String(v);
    }
    if (typeof v === "string") {
      const s = v.length > 40 ? v.slice(0, 37) + "..." : v;
      return "'" + s.replace(/\u0000/g, "\\0") + "'";
    }
    if (typeof v === "boolean") return v ? "1" : "0";
    if (Array.isArray(v)) return arrayDescription(v);
    if (typeof v === "object") {
      if (typeof v.type === "string" && Array.isArray(v.value)) {
        return "{" + v.type + "} " + arrayDescription(v.value);
      }
      return "{" + Object.keys(v).slice(0, 6).map(function (k) { return k + ": " + oneLine(v[k]); }).join(", ") + "}";
    }
    return String(v);
  }

  function arrayDescription(arr) {
    const n = arr.length;
    if (!n) return "[]";
    // compress runs of identical scalar values
    const parts = [];
    let i = 0;
    while (i < n) {
      let j = i + 1;
      while (j < n && primitiveEq(arr[j], arr[i])) j++;
      const run = j - i;
      if (run >= 3) parts.push(oneLine(arr[i]) + " \u00d7" + run);
      else for (let k = i; k < j; k++) parts.push(oneLine(arr[k]));
      i = j;
    }
    if (parts.length > 10) {
      return "[" + n + " values] " + parts.slice(0, 6).join(", ") + ", \u2026, " + parts.slice(-2).join(", ");
    }
    return parts.join(", ");
  }

  function primitiveEq(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a === "object" || typeof b === "object") return false;
    return false;
  }

  function describeL5kValue(parsed) {
    try {
      if (!parsed) return "";
      const v = parsed.value;
      switch (parsed.kind) {
        case "raw":
          return "raw: " + (parsed.raw || "").slice(0, 80);
        case "string": {
          const s = v === null || v === undefined ? "" : String(v);
          return "'" + (s.length > 60 ? s.slice(0, 57) + "..." : s) + "' (" + s.length + " chars)";
        }
        case "scalar":
          return oneLine(v);
        case "array":
          return (parsed.elements && parsed.elements.length && typeof parsed.elements[0] === "object" &&
            parsed.elements[0] && parsed.elements[0].name !== undefined && parsed.elements[0].name !== null
            ? "[" + parsed.elements.length + "] " + parsed.elements.slice(0, 8).map(function (e) {
              return e.name + "=" + oneLine(e.value);
            }).join(", ")
            : "[" + (Array.isArray(v) ? v.length : 0) + "] " + arrayDescription(Array.isArray(v) ? v : []));
        case "struct": {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const keys = Object.keys(v);
            const shown = keys.slice(0, 8).map(function (k) { return k + "=" + oneLine(v[k]); });
            return "{" + (parsed.type || "structure") + "} " + shown.join(", ") +
              (keys.length > 8 ? ", \u2026 (" + keys.length + " members)" : "");
          }
          return "{" + (parsed.type || "structure") + "} " +
            arrayDescription(Array.isArray(v) ? v : (parsed.elements || []).map(function (e) { return e.value; }));
        }
        default:
          return oneLine(v);
      }
    } catch (e) {
      return parsed && parsed.raw ? String(parsed.raw).slice(0, 80) : "";
    }
  }

  /* ------------------------------------------------------------------- format */

  function quoteL5k(s) {
    s = String(s === null || s === undefined ? "" : s);
    let out = "'";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = s.charCodeAt(i);
      if (ch === "$") out += "$$";
      else if (ch === "'") out += "$'";
      else if (code < 32 || code > 126) out += "$" + ("0" + code.toString(16).toUpperCase()).slice(-2);
      else out += ch;
    }
    return out + "'";
  }

  function formatPlain(v, dataType) {
    const dt = uc(dataType);
    if (v === null || v === undefined) return dt === "STRING" ? "''" : "0";
    if (typeof v === "boolean") return v ? "1" : "0";
    if (typeof v === "number") {
      if (!isFinite(v)) return "0";
      if (dt === "BOOL") return v ? "1" : "0";
      return String(v);
    }
    if (typeof v === "string") return quoteL5k(v);
    if (Array.isArray(v)) return "[" + v.map(function (x) { return formatPlain(x, dataType); }).join(",") + "]";
    if (typeof v === "object") {
      if (typeof v.type === "string" && Array.isArray(v.value)) {
        return "[" + v.value.map(function (x) { return formatPlain(x, dataType); }).join(",") + "]";
      }
      const keys = Object.keys(v);
      return "[" + keys.map(function (k) { return formatPlain(v[k], dataType); }).join(",") + "]";
    }
    return String(v);
  }

  function formatL5kValue(decoded, dataType) {
    try {
      if (decoded && typeof decoded === "object" && decoded.kind) {
        switch (decoded.kind) {
          case "raw":
            return decoded.raw === null || decoded.raw === undefined ? "" : String(decoded.raw);
          case "string":
            return quoteL5k(decoded.value === null || decoded.value === undefined ? "" : decoded.value);
          case "scalar":
            return formatPlain(decoded.value, dataType);
          case "array": {
            let vals;
            if (Array.isArray(decoded.value)) vals = decoded.value;
            else if (decoded.elements) vals = decoded.elements.map(function (e) {
              return e && typeof e === "object" && "value" in e ? e.value : e;
            });
            else vals = [];
            return "[" + vals.map(function (x) { return formatL5kValue(x, dataType); }).join(",") + "]";
          }
          case "struct": {
            const v = decoded.value;
            if (v && typeof v === "object" && !Array.isArray(v)) {
              return "[" + Object.keys(v).map(function (k) { return formatL5kValue(v[k], dataType); }).join(",") + "]";
            }
            if (Array.isArray(v)) return "[" + v.map(function (x) { return formatL5kValue(x, dataType); }).join(",") + "]";
            return formatPlain(v, dataType);
          }
          default:
            return formatPlain(decoded.value, dataType);
        }
      }
      return formatPlain(decoded, dataType);
    } catch (e) {
      return decoded && typeof decoded.raw === "string" ? decoded.raw : "";
    }
  }

  /* -------------------------------------------------------------- tag initial */

  function adjustParsedForRecord(parsed, tagRecord) {
    if (!parsed || !tagRecord) return parsed;
    const dt = uc(tagRecord.dataType);
    const dim = parseInt(tagRecord.dimension || 0, 10) || 0;
    if (parsed.fromBytes && dt === "BOOL" && parsed.kind === "array") {
      const bits = Array.isArray(parsed.value) ? parsed.value : [];
      if (dim > 0) {
        const sliced = bits.slice(0, dim);
        if (sliced.length !== bits.length) {
          parsed.elements = sliced.map(function (v) { return { value: v, raw: v ? "1" : "0" }; });
          parsed.value = sliced;
          parsed.dimension = dim;
        }
      } else if (bits.length) {
        // a scalar BOOL tag encoded in a 4-byte word: keep the boolean value
        parsed.kind = "scalar";
        parsed.value = bits[0] ? 1 : 0;
        parsed.elements = [{ value: parsed.value, raw: parsed.value ? "1" : "0" }];
        parsed.dimension = 0;
      }
      return parsed;
    }
    if (parsed.kind === "array" && dim > 0 && Array.isArray(parsed.value) && parsed.value.length > dim && parsed.fromBytes) {
      parsed.value = parsed.value.slice(0, dim);
      if (parsed.elements) parsed.elements = parsed.elements.slice(0, dim);
    }
    return parsed;
  }

  function tagInitialValue(model, tagRecord) {
    try {
      if (!tagRecord || !tagRecord.initial) return null;
      const init = tagRecord.initial;
      if (init.format === "Decorated") {
        const parsed = parseDecoratedValue(init.tree, tagRecord.dataType, model);
        return { format: "Decorated", parsed: parsed, tree: init.tree };
      }
      if (init.format === "Message") {
        return { format: "Message", parsed: makeResult("raw", tagRecord.dataType, init.text || "", null, init.text, { warning: "message tag parameters are not decoded" }) };
      }
      let parsed = parseL5kValue(init.text, tagRecord.dataType, model);
      parsed = adjustParsedForRecord(parsed, tagRecord);
      return { format: init.format || "L5K", parsed: parsed, text: init.text === undefined ? null : init.text };
    } catch (e) {
      return { format: (tagRecord && tagRecord.initial && tagRecord.initial.format) || "L5K",
        parsed: rawResult(tagRecord && tagRecord.initial ? tagRecord.initial.text : "", tagRecord ? tagRecord.dataType : null,
          "initial value decode failed: " + (e && e.message)) };
    }
  }

  return {
    parseL5kValue: parseL5kValue,
    describeL5kValue: describeL5kValue,
    tagInitialValue: tagInitialValue,
    formatL5kValue: formatL5kValue,
    parseDecoratedValue: parseDecoratedValue,
    // small helpers useful to other modules / tests
    looksLikeByteDump: looksLikeByteDump,
    normalizeText: normalizeText,
    isElementary: isElementary
  };
});
