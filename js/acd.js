/* L5X Studio - acd.js (Lead). Browser/Node reader for Rockwell .ACD project archives,
   based on the archive format reverse-engineered by hutcheb/acd (MIT):
   the file ends with a record table (528-byte records) holding UTF-16LE file names,
   lengths and offsets; payloads are either raw or gzip-compressed (magic 1f 8b).
   The archive carries QuickInfo.XML (controller identity) and TagInfo.XML (the full
   data-type / tag database with exact byte/bit offsets). Binary logic databases
   (Comps.Dat etc.) are NOT parsed: this is a metadata reader only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const XML = (typeof module !== "undefined" && module.exports) ? require("./xml.js") : root.L5XStudio;
  const isNode = typeof module !== "undefined" && module.exports;

  const RECORD_SIZE = 528;

  /* ---- inflate helpers (browser DecompressionStream / Node zlib) ---- */
  async function inflateGzip(bytes) {
    if (typeof DecompressionStream !== "undefined" && typeof Response !== "undefined") {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (isNode) {
      const zlib = require("zlib");
      return new Uint8Array(zlib.gunzipSync(Buffer.from(bytes)));
    }
    throw new Error("No gzip decompressor available in this environment");
  }

  function decodeText(bytes) {
    if (!bytes || !bytes.length) return "";
    let enc = "utf-8", off = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { enc = "utf-16le"; off = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { enc = "utf-16be"; off = 2; }
    else if (bytes[0] === 0x3c && bytes[1] === 0x00) enc = "utf-16le";
    else if (bytes[0] === 0x00 && bytes[1] === 0x3c) enc = "utf-16be";
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) off = 3;
    return new TextDecoder(enc).decode(bytes.subarray(off));
  }

  /* ---- archive parse ---- */
  function parseArchive(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = bytes.length;
    if (size < 16) throw new Error("File too small to be an ACD archive");
    if (bytes[0] !== 0x0d || bytes[1] !== 0x0a) throw new Error("Not a Rockwell ACD file (bad magic)");
    const noFiles = dv.getUint32(size - 8, true);
    if (!noFiles || noFiles > 100000) throw new Error("Invalid ACD record table (" + noFiles + " files)");
    const recordOffset = size - noFiles * RECORD_SIZE - 8;
    if (recordOffset < 0) throw new Error("Invalid ACD record table offset");
    const records = [];
    for (let i = 0; i < noFiles; i++) {
      const recStart = recordOffset + i * RECORD_SIZE;
      let name = "";
      let p = recStart;
      let guard = 0;
      while (p + 1 < size && guard++ < 260) {
        const lo = bytes[p], hi = bytes[p + 1];
        p += 2;
        if (lo === 0 && hi === 0) break;
        name += String.fromCharCode(lo | (hi << 8));
      }
      const fileLength = dv.getUint32(recStart + 520, true);
      const fileOffset = dv.getUint32(recStart + 524, true);
      records.push({ index: i, name: name, size: fileLength, offset: fileOffset, compressed: false });
    }
    return records;
  }

  async function readAcd(buffer, opts) {
    opts = opts || {};
    const records = parseArchive(buffer);
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const want = opts.extract || ["QuickInfo.XML", "TagInfo.XML", "TextualVersionInfo.Dat", "FileInfo.Dat"];
    const extracted = {};
    const warnings = [];
    for (const rec of records) {
      const end = rec.offset + rec.size;
      if (rec.offset < 0 || end > bytes.length) {
        warnings.push("Skipping out-of-bounds record: " + rec.name);
        continue;
      }
      const payload = bytes.subarray(rec.offset, end);
      rec.compressed = payload.length > 1 && payload[0] === 0x1f && payload[1] === 0x8b;
      if (want.indexOf(rec.name) === -1 && !opts.extractAll) continue;
      try {
        const inflated = rec.compressed ? await inflateGzip(payload) : payload;
        extracted[rec.name] = { bytes: inflated, text: decodeText(inflated) };
      } catch (e) {
        warnings.push("Could not decompress " + rec.name + ": " + e.message);
      }
    }
    const result = {
      ok: true,
      files: records,
      extracted: extracted,
      controller: null,
      quickInfo: null,
      tagInfo: null,
      dataTypes: [],
      tags: [],
      programs: [],
      warnings: warnings
    };
    if (extracted["QuickInfo.XML"]) {
      try {
        result.quickInfo = XML.parseXml(extracted["QuickInfo.XML"].text);
        result.controller = parseQuickInfo(result.quickInfo);
      } catch (e) { warnings.push("Could not parse QuickInfo.XML: " + e.message); }
    }
    if (extracted["TagInfo.XML"]) {
      try {
        result.tagInfo = XML.parseXml(extracted["TagInfo.XML"].text);
        const t = parseTagInfo(result.tagInfo);
        result.dataTypes = t.dataTypes;
        result.tags = t.tags;
        result.programs = t.programs;
        result.tagInfoName = t.name;
      } catch (e) { warnings.push("Could not parse TagInfo.XML: " + e.message); }
    }
    if (extracted["TextualVersionInfo.Dat"]) {
      try {
        const txt = extracted["TextualVersionInfo.Dat"].text;
        const m = txt.match(/Version\s*\n=+\s*\n([\s\S]{0,2000})/);
        result.versionInfoExcerpt = m ? m[1].split("\n").slice(0, 10).join("\n") : null;
      } catch (e) { /* non-fatal */ }
    }
    return result;
  }

  /* QuickInfo.XML -> controller identity */
  function parseQuickInfo(plain) {
    const c = {};
    const rootEl = XML.children(plain)[0] || plain;
    c.name = XML.attr(rootEl, "Name") || "";
    c.description = (XML.textOf(XML.child(rootEl, "Description")) || "").trim();
    const sw = XML.child(rootEl, "SWVersion");
    c.swVersion = sw ? (XML.attr(sw, "String") || XML.textOf(sw)) : "";
    const di = XML.child(rootEl, "DeviceIdentity");
    if (di) {
      c.deviceIdentity = {
        vendorId: XML.attr(di, "VendorID"), productType: XML.attr(di, "ProductType"),
        productCode: XML.attr(di, "ProductCode"),
        majorRevision: XML.attr(di, "MajorRevision"), minorRevision: XML.attr(di, "MinorRevision")
      };
    }
    const slot = XML.child(rootEl, "ControllerSlot");
    c.slot = slot ? XML.attr(slot, "SlotNumber") : null;
    c.schemaVersion = XML.textOf(XML.child(rootEl, "SchemaVersion")).trim() || null;
    return c;
  }

  /* TagInfo.XML -> data types + tags (controller and program scoped) */
  function parseMemberNode(node) {
    const m = {
      name: XML.attr(node, "Name") || "",
      dataType: XML.attr(node, "DataType") || "",
      offset: XML.attr(node, "Offset") !== undefined ? parseInt(XML.attr(node, "Offset"), 10) : null,
      bit: XML.attr(node, "Bit") !== undefined ? parseInt(XML.attr(node, "Bit"), 10) : null,
      hidden: XML.attr(node, "Hidden") === "true",
      externalAccess: XML.attr(node, "ExtAcc") || null,
      index: XML.attr(node, "Index") !== undefined ? parseInt(XML.attr(node, "Index"), 10) : null,
      dimensions: [],
      children: null,
      description: null
    };
    const dims = XML.child(node, "Dimensions");
    if (dims) {
      const d = XML.children(dims, "Dim")[0];
      if (d) m.dimensions = [parseInt(XML.attr(d, "Size") || "0", 10)];
    }
    const nested = XML.child(node, "Members");
    if (nested) {
      m.children = XML.children(nested, "Member").map(parseMemberNode);
    }
    return m;
  }

  /* Rockwell predefined / instruction-defined data types that are not user UDTs. */
  var SYSTEM_TYPE_RE = /^(ALARM|ALARM_ANALOG|ALARM_CONDITION|ALARM_DIGITAL|ALARM_SET|ALARM_SET_CONTROL|AUX_VALVE_CONTROL|AXIS_|CAM_|COORDINATE_SYSTEM|MOTION_GROUP|MOTION_INSTRUCTION|MOTION_|PID_|PIDE_|TOTALIZER|DC_|DDE_|HART_|MSG_|MSG$|MESSAGE$|STRING$|TIMER$|COUNTER$|CONTROL$|BOOL$|SINT$|INT$|DINT$|LINT$|REAL$|LREAL$|SCL_|SCP_|SFC_|ROUTINE_|RUNG_|STEP_|ACTION_|TRANSITION_|EMERGENCY_STOP|SAFETY_|REDUNDANT_)/;
  function classifyDataType(name) {
    if (/^AB:/.test(name)) return "Module";
    if (SYSTEM_TYPE_RE.test(name)) return "System";
    var base = ["BOOL", "SINT", "INT", "DINT", "LINT", "REAL", "LREAL", "STRING", "TIMER", "COUNTER", "CONTROL", "MESSAGE", "DT", "DTL", "FBD_", "BCD", "EXT_"];
    for (var i = 0; i < base.length; i++) if (name === base[i]) return "System";
    return "User";
  }

  function parseTagInfo(plain) {
    const rootEl = XML.children(plain)[0] || plain;
    const out = { name: XML.attr(rootEl, "Name") || "", dataTypes: [], tags: [], programs: [] };
    const dts = XML.child(rootEl, "DataTypes");
    if (dts) {
      for (const dt of XML.children(dts, "DataType")) {
        const rec = {
          name: XML.attr(dt, "Name") || "",
          size: XML.attr(dt, "Size") !== undefined ? parseInt(XML.attr(dt, "Size"), 10) : null,
          class: classifyDataType(XML.attr(dt, "Name") || ""),
          members: []
        };
        const mem = XML.child(dt, "Members");
        if (mem) rec.members = XML.children(mem, "Member").map(parseMemberNode);
        out.dataTypes.push(rec);
      }
    }
    function parseTag(node, scope) {
      const tag = {
        name: XML.attr(node, "Name") || "",
        dataType: XML.attr(node, "DataType") || "",
        externalAccess: XML.attr(node, "ExtAcc") || null,
        scope: scope,
        description: (XML.textOf(XML.child(node, "Description")) || "").trim() || null,
        dimensions: []
      };
      const dims = XML.child(node, "Dimensions");
      if (dims) {
        const d = XML.children(dims, "Dim")[0];
        if (d) tag.dimensions = [parseInt(XML.attr(d, "Size") || "0", 10)];
      }
      return tag;
    }
    const tags = XML.child(rootEl, "Tags");
    if (tags) for (const t of XML.children(tags, "Tag")) out.tags.push(parseTag(t, "controller"));
    const progs = XML.child(rootEl, "Programs");
    if (progs) {
      for (const pr of XML.children(progs, "Program")) {
        const program = { name: XML.attr(pr, "Name") || "", tags: [] };
        const ptags = XML.child(pr, "Tags");
        if (ptags) for (const t of XML.children(ptags, "Tag")) {
          const rec = parseTag(t, "program:" + program.name);
          program.tags.push(rec);
          out.tags.push(rec);
        }
        out.programs.push(program);
      }
    }
    return out;
  }

  /* Convert an ACD data type to the memberTree shape used by render/udt.js.
     ACD gives exact offsets/bits, so annotateMembers is bypassed by the caller;
     this tree keeps offset/bit on each member for display. */
  function dataTypeToMemberTree(dt) {
    return {
      name: dt.name,
      dataType: dt.name,
      dimension: 0,
      radix: null,
      hidden: false,
      externalAccess: null,
      description: null,
      sizeBytes: dt.size,
      children: (dt.members || []).map(function conv(m) {
        return {
          name: m.name,
          dataType: m.dataType,
          dimension: m.dimensions && m.dimensions.length ? m.dimensions[0] : 0,
          radix: null,
          hidden: m.hidden,
          externalAccess: m.externalAccess,
          description: null,
          acdOffset: m.offset,
          acdBit: m.bit,
          children: m.children ? m.children.map(conv) : null
        };
      }),
      elements: null
    };
  }

  return {
    readAcd: readAcd, parseArchive: parseArchive, parseQuickInfo: parseQuickInfo,
    parseTagInfo: parseTagInfo, dataTypeToMemberTree: dataTypeToMemberTree,
    decodeText: decodeText, inflateGzip: inflateGzip
  };
});
