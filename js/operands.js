/* L5X Studio - operands.js (Lead). Parse operand/tag reference syntax shared by
   dataflow, resolution, I/O mapping and editors. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var INT_RE = /^[+-]?\d+(_\d+)*$/;
  var FLOAT_RE = /^[+-]?(\d+(_\d+)*(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
  var BASED_RE = /^(16|2|8)#[0-9a-fA-F_]+$/;
  var STR_RE = /^'(?:[^']|'')*'$/; // rough Logix string literal
  var BOOL_RE = /^(TRUE|FALSE)$/i;
  var TIME_RE = /^T#/i;

  /* Return the literal type of an operand text, or null if it is a tag reference. */
  function literalType(text) {
    if (text === "?") return "placeholder";
    if (BOOL_RE.test(text)) return "bool";
    if (BASED_RE.test(text)) return "int";
    if (INT_RE.test(text)) return "int";
    if (FLOAT_RE.test(text)) return "float";
    if (TIME_RE.test(text)) return "time";
    if (STR_RE.test(text)) return "str";
    return null;
  }
  function isLiteral(text) { return literalType(text) !== null; }

  var TAG_NAME_CHARS = "[A-Za-z_][A-Za-z0-9_]*";
  /* Base tag: identifier optionally containing ':' (module tags like Local:1:I / Network1:I),
     or special system names like S:FS. Handles [index] / .member / .bit suffixes. */
  function parseOperand(text) {
    text = String(text).trim();
    var out = {
      raw: text,
      isLiteral: false, literalType: null,
      baseTag: null, isModuleTag: false, scopeHint: null,
      members: [], isPlaceholder: text === "?"
    };
    var lt = literalType(text);
    if (lt !== null) { out.isLiteral = true; out.literalType = lt === "placeholder" ? null : lt; return out; }
    var i = 0, n = text.length;
    // base tag name: chars up to first '.', '[' or ':' (keep ':' as part of name)
    var base = "";
    while (i < n) {
      var ch = text[i];
      if (ch === "." || ch === "[") break;
      base += ch; i++;
    }
    base = base.trim();
    if (!base) return out;
    out.baseTag = base;
    out.isModuleTag = base.indexOf(":") !== -1;
    if (out.isModuleTag) out.scopeHint = base.split(":")[0];
    while (i < n) {
      if (text[i] === ".") {
        i++;
        var name = "";
        while (i < n && text[i] !== "." && text[i] !== "[") { name += text[i]; i++; }
        // purely numeric "member" is a bit index (Logix member names are never numeric)
        if (/^\d+$/.test(name)) out.members.push({ name: null, index: name, bit: true });
        else out.members.push({ name: name, index: null });
      } else if (text[i] === "[") {
        var depth = 1, j = i + 1, idx = "";
        while (j < n && depth > 0) {
          if (text[j] === "[") depth++;
          else if (text[j] === "]") depth--;
          if (depth === 0) break;
          idx += text[j]; j++;
        }
        out.members.push({ name: null, index: idx.trim() });
        i = j + 1;
      } else i++;
    }
    return out;
  }

  function parseTagPath(text) { return parseOperand(text); }

  /* Heuristic: does this text look like a tag reference rather than a literal? */
  function isLikelyTag(text) {
    if (isLiteral(text)) return false;
    var p = parseOperand(text);
    return !!p.baseTag && /^[A-Za-z_]/.test(p.baseTag);
  }

  /* Format a JS value as a Logix literal. */
  function literalText(value, radix) {
    radix = radix || 10;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") {
      if (radix === 16) return "16#" + Math.round(value).toString(16).toUpperCase();
      if (radix === 2) return "2#" + Math.round(value).toString(2);
      return String(value);
    }
    return "'" + String(value).replace(/'/g, "$'") + "'";
  }

  /* Describe an operand in human terms: "AFCS[NDX].RUN_INTERLOCK" etc. */
  function describeOperand(text) {
    var p = parseOperand(text);
    if (p.isPlaceholder) return "(unassigned)";
    if (p.isLiteral) return "literal " + text;
    var s = p.baseTag;
    for (var i = 0; i < p.members.length; i++) {
      var m = p.members[i];
      if (m.name !== null && m.index !== null) s += "." + m.name + "[" + m.index + "]";
      else if (m.name !== null) s += "." + m.name;
      else if (m.bit) s += "." + m.index;
      else s += "[" + m.index + "]";
    }
    return s;
  }

  /* Rebuild canonical text from a parsed operand (name[idx].name ordering). */
  function canonicalize(text) {
    var p = parseOperand(text);
    if (p.isLiteral || p.isPlaceholder) return text;
    var s = p.baseTag;
    for (var i = 0; i < p.members.length; i++) {
      var m = p.members[i];
      if (m.name !== null && m.index !== null) s += "." + m.name + "[" + m.index + "]";
      else if (m.name !== null) s += "." + m.name;
      else if (m.bit) s += "." + m.index;
      else s += "[" + m.index + "]";
    }
    return s;
  }

  return { literalType: literalType, isLiteral: isLiteral, parseOperand: parseOperand,
    parseTagPath: parseTagPath, isLikelyTag: isLikelyTag, literalText: literalText,
    describeOperand: describeOperand, canonicalize: canonicalize };
});
