/* L5X Studio - conveyor/l5xgen.js (Conveyor Design Studio).
   Template-driven L5X program generator: turns a conveyor design (shared model
   js/conveyor/model.js v3) into an importable Rockwell L5X export built from the
   real SAMPLE_RLL ZPA templates (js/data/conveyor-templates.js, produced by
   tools/extract-conveyor-templates.js).

   Architecture (matches SAMPLE_RLL ZPA semantics and the shared model):
     - ROLLER conveyors: one 1799ER-IQ10XOQ10/A block and one NETS[1].ZPA[g] UDT
       instance per ZONE GROUP of up to 8 zones; one template routine
       ZPA1_<n>ZONE_SCAN_ZONE per group instantiated with ZPA[1] -> ZPA[<group>],
       timer/status array slots kept at the zone-within-group index 1..n. Curved
       groups use the standardised tapered-roller radius and the geometry (radius,
       taper standard, spiral pitch/height/direction, helix slope) is recorded in
       the generated routine descriptions and Main rung comments.
     - BELT conveyors (design.conveyorType "belt"): a BELT_<SEG>_DRIVE control
       section (RUN_CMD latch with SAFETY_OK/fault interlocks, spare 1799ER group
       I/O bits for the run contactor / fault input, and the PowerFlex 525 AOI call
       when opts.aois includes "Dvc_PF525") instead of per-zone ZPA scan routines.
       Belt designs still get the per-group I/O mapping blocks/routines.
     - MERGE JUNCTIONS (computed.merges[]): one MERGE_<name> routine per spur->main
       merge; alternating/main/spur priority release arbitration between the spur
       last zone and the merge zone's upstream main zone, granting via
       NETS[1].ZPA[g].INPUTS.8 with an 8 s blocked-release grant swap.
     - TRANSFER DEVICES (computed.transfers[]: pusher / rotary table / pop-up):
       one 1799ER device block each (XFER01.., IPs after the ZPA blocks), mapped into
       XFERnn_INPUTS/XFERnn_OUTPUTS DINT tags + appended ENET words + per-bit BOOL
       alias tags; PUSHER_<name>/ROTARY_<name>/POPUP_<name> control routines authored
       in ST and converted to ladder with L5XStudio.stToLad.
     - SCAN ZONES + TRAY TRACKING (any conveyor type, design.tracking.enabled):
       TRAY_TRACK UDT, TRACK_TBL[]/TRACK_COUNT/TRACK_RESET controller tags,
       per-scanner <SCAN>_BARCODE/<SCAN>_GOOD_READ tags and the TRACK_INIT/
       TRACK_SCAN/TRACK_MOVE/TRACK_CLEAR routines (also ST -> ladder).
     - INIT_CONFIG initialises all zones' INPUTS.8 = 1 (normal release permission;
       merge routines override the two upstream zones) plus the ENET offsets, group
       config and merge timer presets.

   API (docs/CONVEYOR.md T-F):
     generateConveyorL5x(design, computed, opts) -> { ok, l5x, warnings, stats, files }
       opts.mode = "program" (default) | "controller"
       opts.aois = ["Dvc_DiscreteIn", "Dvc_PF525", ...]   optional AOI embedding
       opts.softwareRevision / opts.baseTemplateVersion    L5X SoftwareRevision
       opts.programName / opts.controllerName              name overrides
       opts.templates                                      template object override (tests)

   Program-mode Main order: INIT_CONFIG, IO_MAIN, TRACK_INIT (first scan),
   ZPA_MAPPING FOR loop (roller only), one JSR per ZPA group scan (roller only),
   belt drive JSRs (belt only), merge routines, transfer device routines,
   TRACK_MOVE, TRACK_SCAN, TRACK_CLEAR.

   After building, the result is re-parsed with js/l5x-model.js and schema-validated
   with js/schema-validate.js; every schema error is surfaced as a "SCHEMA:" warning
   (generation never throws for schema issues). Template assumptions / deviations are
   always reported in warnings (nothing is silently dropped).
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && !!module.exports;
  const XML = NODE ? require("../xml.js") : (root.L5XStudio || {});
  const MODEL = NODE ? require("./model.js") : (root.L5XStudio || {});
  const STP = NODE ? require("../st-parse.js") : (root.L5XStudio || {});
  const RLLSER = NODE ? require("../rll-serialize.js") : (root.L5XStudio || {});
  const CONVERT = NODE ? require("../lang-convert.js") : (root.L5XStudio || {});

  const GENERATOR_VERSION = "2.1.0";

  /* Support routines cloned once from the SAMPLE_RLL project (roller mode only). */
  const SUPPORT_ROUTINES = [
    "ZPA_MAPPING", "ZPA_MAPPING_GET_OFFSET", "ZPA_TIMER_CONFIG",
    "ZPA_SCAN_ZONE_VARS", "ZPA_SCAN_ZONE_VARS_ONE_BACK",
    "ACK_JAMS_ZPA", "CUSTOM_CODE_ZPA_BITS", "INIT_ZPA_STATUS"
  ];

  /* Instruction argument indexes that are NOT tag references. */
  const NON_TAG_ARGS = {
    JSR: [0], SBR: [0], RET: [0], JMP: [0], LBL: [0], FOR: [0], NXT: [0],
    GSV: [0, 1, 2], SSV: [0, 1, 2]
  };

  const MODULE_CATALOG = "1799ER-IQ10XOQ10/A";
  const ENET_OFFSET = 1;        // first ENET word / device-status node index
  const ENET_FIRST_ADDR = 1;
  const TRACK_DRIVE_TYPES = { DINT: 1, INT: 1, SINT: 1, LINT: 1 };

  /* ---------------- template library ---------------- */

  function loadTemplates(opts) {
    if (opts && opts.templates) return opts.templates;
    try {
      if (NODE) return require("../data/conveyor-templates.js");
      return (root.L5XStudio && root.L5XStudio.CONVEYOR_TEMPLATES) || null;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- generic helpers ---------------- */

  function ind(depth) { return new Array(depth + 1).join("  "); }
  function escAttr(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function attrsStr(attrs) {
    if (!attrs) return "";
    let s = "";
    const keys = Object.keys(attrs);
    for (let i = 0; i < keys.length; i++) {
      if (attrs[keys[i]] === undefined || attrs[keys[i]] === null) continue;
      s += " " + keys[i] + "=\"" + escAttr(attrs[keys[i]]) + "\"";
    }
    return s;
  }
  function splitCdata(text) {
    return String(text === undefined || text === null ? "" : text).split("]]>").join("]]]]><![CDATA[>");
  }
  function cdata(text) { return "<![CDATA[" + splitCdata(text) + "]]>"; }
  function el(depth, name, attrs, childLines) {
    const pad = ind(depth);
    const head = "<" + name + attrsStr(attrs);
    if (!childLines || !childLines.length) return [pad + head + "/>"];
    return [pad + head + ">"].concat(childLines, [pad + "</" + name + ">"]);
  }
  function textElement(depth, name, text) { return ind(depth) + "<" + name + ">" + cdata(text) + "</" + name + ">"; }
  function sanitizeName(name, fallback) { return MODEL.sanitizeName ? MODEL.sanitizeName(name, fallback) : String(name || fallback || "X"); }
  function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
  function round(v, d) { const p = Math.pow(10, d || 0); return Math.round(Number(v) * p) / p; }
  function utf8Length(s) {
    if (NODE && typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* Indent a raw XML snippet at the requested depth. CDATA content is never modified. */
  function indentXmlSnippet(xml, depth) {
    const pad = ind(depth);
    const src = String(xml || "");
    let out = "";
    let atLineStart = true;
    let inCdata = false;
    let i = 0;
    while (i < src.length) {
      if (!inCdata && atLineStart) { out += pad; atLineStart = false; }
      if (inCdata) {
        const k = src.indexOf("]]>", i);
        const end = k === -1 ? src.length : k + 3;
        out += src.slice(i, end);
        i = end;
        inCdata = false;
        continue;
      }
      if (src.slice(i, i + 9) === "<![CDATA[") { inCdata = true; continue; }
      let j = i;
      while (j < src.length && src[j] !== "\n" && src.slice(j, j + 9) !== "<![CDATA[") j++;
      out += src.slice(i, j);
      if (j < src.length && src[j] === "\n") { out += "\n"; atLineStart = true; j++; }
      i = j;
    }
    return out;
  }

  /* ---------------- tag XML ---------------- */

  function makeTagXml(name, dataType, dimension, opts) {
    opts = opts || {};
    if (opts.aliasFor) {
      return "<Tag Name=\"" + escAttr(name) + "\" TagType=\"Alias\" DataType=\"" + escAttr(dataType) +
        "\" Constant=\"false\" ExternalAccess=\"Read/Write\" AliasFor=\"" + escAttr(opts.aliasFor) + "\"/>";
    }
    const attrs = { Name: name, TagType: "Base", DataType: dataType };
    if (dimension) attrs.Dimensions = String(dimension);
    if (opts.radix !== null) attrs.Radix = opts.radix || "Decimal";
    attrs.Constant = "false";
    attrs.ExternalAccess = "Read/Write";
    return "<Tag " + attrsStr(attrs) + "/>";
  }
  function tagNameOf(tagXml) {
    const m = /<Tag\b[^>]*\bName="([^"]*)"/.exec(String(tagXml || ""));
    return m ? m[1] : null;
  }
  function setTagDimension(tagXml, dimension) {
    const xml = String(tagXml);
    if (/\sDimensions="[^"]*"/.test(xml)) return xml.replace(/\sDimensions="[^"]*"/, " Dimensions=\"" + dimension + "\"");
    return xml.replace(/<Tag\b/, "<Tag Dimensions=\"" + dimension + "\"");
  }
  function withTagData(tagXml, l5kText) {
    const data = "<Data Format=\"L5K\">" + cdata(l5kText) + "</Data>";
    const xml = String(tagXml).trim();
    if (/\/>$/.test(xml)) return xml.replace(/\/>$/, ">" + data + "</Tag>");
    return xml.replace(/<\/Tag>$/, data + "</Tag>");
  }
  function dataTypeNameOf(dtXml) {
    const m = /<DataType\b[^>]*\bName="([^"]*)"/.exec(String(dtXml || ""));
    return m ? m[1] : null;
  }

  function customStringTypeXml(len) {
    return "<DataType Name=\"STRING_" + len + "\" Family=\"StringFamily\" Class=\"User\"><Members>" +
      "<Member Name=\"LEN\" DataType=\"DINT\" Dimension=\"0\" Radix=\"Decimal\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "<Member Name=\"DATA\" DataType=\"SINT\" Dimension=\"" + len + "\" Radix=\"ASCII\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "</Members></DataType>";
  }
  function trayTrackUdtXml(barcodeLen) {
    return "<DataType Name=\"TRAY_TRACK\" Family=\"NoFamily\" Class=\"User\"><Members>" +
      "<Member Name=\"Barcode\" DataType=\"STRING_" + barcodeLen + "\" Dimension=\"0\" Radix=\"NullType\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "<Member Name=\"Zone\" DataType=\"DINT\" Dimension=\"0\" Radix=\"Decimal\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "<Member Name=\"Seq\" DataType=\"DINT\" Dimension=\"0\" Radix=\"Decimal\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "<Member Name=\"Valid\" DataType=\"BOOL\" Dimension=\"0\" Radix=\"Decimal\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "<Member Name=\"Timestamp\" DataType=\"DINT\" Dimension=\"0\" Radix=\"Decimal\" Hidden=\"false\" ExternalAccess=\"Read/Write\"/>" +
      "</Members></DataType>";
  }
  function zpaConfigUdts(templates) {
    const out = {};
    if (templates.udts && templates.udts.CONFIG_ZPA) out.CONFIG_ZPA = templates.udts.CONFIG_ZPA;
    return out;
  }

  /* ---------------- routine XML ---------------- */

  function rungLines(depth, rung, index) {
    const children = [];
    if (rung.comment !== null && rung.comment !== undefined && String(rung.comment).length) {
      children.push(textElement(depth + 1, "Comment", rung.comment));
    }
    children.push(textElement(depth + 1, "Text", rung.text));
    return el(depth, "Rung", {
      Number: rung.number === undefined ? index : rung.number,
      Type: rung.type || "N"
    }, children);
  }
  function routineLines(depth, routine) {
    const children = [];
    if (routine.description) children.push(textElement(depth + 1, "Description", routine.description));
    const contentLines = [];
    const rungs = routine.rungs || [];
    for (let i = 0; i < rungs.length; i++) contentLines.push.apply(contentLines, rungLines(depth + 2, rungs[i], i));
    if (routine.type === "ST") {
      children.push(el(depth + 1, "STContent", {}, routine.stLines.map(function (line, i) {
        return el(depth + 2, "Line", { Number: i }, [ind(depth + 2) + "<![CDATA[" + splitCdata(line) + "]]>"]);
      })));
      return el(depth, "Routine", { Name: routine.name, Type: "ST" }, children);
    }
    children.push(el(depth + 1, "RLLContent", {}, contentLines));
    return el(depth, "Routine", { Name: routine.name, Type: "RLL" }, children);
  }

  /* Author a routine in ST and convert it to ladder through L5XStudio.stToLad.
     (Both editors then work: the routine round-trips LAD -> ST.) */
  function buildStRoutine(name, description, stText, warnings) {
    if (!STP || typeof STP.parseSt !== "function" || !CONVERT || typeof CONVERT.stToLad !== "function" || !RLLSER) {
      warnings.push("Tracking routine " + name + ": ST/ladder conversion modules are not loaded; emitted as ST.");
      return {
        name: name, type: "ST",
        description: description,
        stLines: String(stText).split(/\r?\n/).map(function (l) { return l.replace(/\t/g, "   "); }),
        rungs: []
      };
    }
    let stIR;
    try { stIR = STP.parseSt(stText); }
    catch (e) {
      warnings.push("Tracking routine " + name + ": generated ST did not parse (" + e.message + "); emitted as ST.");
      return { name: name, type: "ST", description: description, stLines: String(stText).split(/\r?\n/), rungs: [] };
    }
    const conv = CONVERT.stToLad(stIR);
    const rungs = [];
    (conv.ir.rungs || []).forEach(function (r, i) {
      let text = "";
      try { text = RLLSER.serializeRllRung(r.root); } catch (e) { text = "NOP()"; }
      if (!text) text = "NOP()";
      if (!/;\s*$/.test(text)) text += ";";
      rungs.push({ number: i, type: "N", comment: r.comment || null, text: text });
    });
    for (const w of (conv.warnings || [])) {
      if (w.kind === "unsupported") {
        warnings.push("Tracking routine " + name + ": ST->LAD conversion warning: " + w.msg);
      }
    }
    return { name: name, type: "RLL", description: description + " (authored in ST, converted to ladder).", rungs: rungs };
  }

  /* ---------------- instruction/tag scanning ---------------- */

  function instructionCalls(rungText) {
    const out = [];
    const txt = String(rungText || "");
    const re = /([A-Za-z_][A-Za-z0-9_]*)\(/g;
    let m;
    while ((m = re.exec(txt))) {
      const op = m[1];
      let depth = 1;
      let j = re.lastIndex;
      let argsTxt = "";
      while (j < txt.length && depth > 0) {
        const c = txt[j];
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
        argsTxt += c;
        j++;
      }
      const args = [];
      let cur = "", d = 0, inStr = false;
      for (let i = 0; i < argsTxt.length; i++) {
        const c = argsTxt[i];
        if (c === "\"") inStr = !inStr;
        if (!inStr && c === "(") d++;
        if (!inStr && c === ")") d--;
        if (!inStr && d === 0 && c === ",") { args.push(cur.trim()); cur = ""; continue; }
        cur += c;
      }
      args.push(cur.trim());
      out.push({ op: op, args: args });
    }
    return out;
  }
  function scanOperandTagNames(arg, tagNames) {
    let s = String(arg === undefined || arg === null ? "" : arg).trim();
    if (!s || s === "?") return;
    if (s === "Local") return;                        // local controller module operand
    if (/^".*"$/.test(s)) return;
    if (/^[+-]?(?:\d|\.\d)/.test(s)) return;
    if (/^(TRUE|FALSE)$/i.test(s)) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*)/.exec(s);
    if (m && m[1].indexOf(":") === -1) tagNames.add(m[1]);
    const re = /\[([^\]]*)\]/g;
    let mm;
    while ((mm = re.exec(s))) {
      const inner = mm[1];
      const ire = /[A-Za-z_][A-Za-z0-9_]*/g;
      let im;
      while ((im = ire.exec(inner))) {
        const before = inner.slice(0, im.index);
        if (((before.match(/"/g) || []).length) % 2 === 1) continue;
        const id = im[0];
        if (/^(TRUE|FALSE|AND|OR|XOR|NOT|MOD)$/i.test(id)) continue;
        tagNames.add(id);
      }
    }
  }
  function routineTagRefs(routine) {
    const names = new Set();
    for (const rung of (routine.rungs || [])) {
      for (const call of instructionCalls(rung.text || "")) {
        const skip = NON_TAG_ARGS[call.op] || [];
        for (let i = 0; i < call.args.length; i++) {
          if (skip.indexOf(i) !== -1) continue;
          scanOperandTagNames(call.args[i], names);
        }
      }
    }
    return Array.from(names).sort();
  }
  function isModuleTagRef(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /:(I|O|C)$/.test(name);
  }

  /* ---------------- geometry notes (curves, tapers, spirals) ---------------- */

  function segmentGeometryNote(seg) {
    if (!seg) return "unknown geometry";
    const bits = [];
    bits.push(seg.conveyorType === "belt" ? "belt conveyor" : "roller conveyor");
    if (seg.kind === "curve") {
      bits.push("CURVE radius R=" + seg.radiusM + " m, sweep " + seg.curveDeg + " deg");
      if (seg.taper) {
        if (seg.taper.standardId) {
          bits.push("tapered rollers " + seg.taper.standardId + " (delta " +
            round((seg.taper.deltaM || 0) * 1000, 1) + " mm, cone half-angle " +
            seg.taper.coneHalfAngleDeg + " deg" + (seg.taper.withinTolerance ? "" : ", NON-STANDARD radius") + ")");
        } else {
          bits.push("tapered rollers (requested radius outside the standardised taper set)");
        }
      }
    } else if (seg.kind === "spiral") {
      const sp = seg.spiral || {};
      bits.push("SPIRAL " + (sp.direction || "up") + " direction, pitch " + sp.pitchM + " m, height " + sp.heightM +
        " m, slope " + sp.slopeDeg + " deg, " + sp.turns + " turns, radius R=" + seg.radiusM + " m");
    } else {
      bits.push("straight");
    }
    if (round(seg.turnDeg, 3)) bits.push("joint turn " + seg.turnDeg + " deg (rounded edge)");
    if (seg.taper && seg.taper.standardId) bits.push("taper standard " + seg.taper.standardId);
    return bits.join("; ");
  }

  function groupGeometryNote(group, segments) {
    const seg = (segments || []).find(function (s) { return s.name === group.segmentName; });
    return seg ? segmentGeometryNote(seg) : "geometry unknown";
  }

  /* ---------------- roller: template instantiation per ZPA group ---------------- */

  function remapGroupText(text, group1, counters) {
    return String(text || "").replace(/(NETS\s*\[[^\]]*\]\s*\.\s*ZPA\s*\[\s*)(\d+)(\s*\])/g,
      function (m, p1, num, p2) {
        if (num === "1") return p1 + group1 + p2;
        if (counters) counters.otherGroupRefs++;
        return m;
      });
  }

  function selectZoneTemplate(templates, templateZones) {
    const n = Math.max(2, Math.min(8, templateZones || 2));
    const name = "ZPA1_" + n + "ZONE_SCAN_ZONE";
    if (!templates.routines[name]) throw new Error("Template routine missing: " + name + " (template library incomplete)");
    return { name: name, variant: n };
  }

  function instantiateGroupRoutine(group, segments, templates, warnings) {
    const templateZones = Math.max(2, Math.min(8, group.templateZones || group.zoneCount || 2));
    const sel = selectZoneTemplate(templates, templateZones);
    const tpl = templates.routines[sel.name];
    if (!tpl) throw new Error("Template routine missing: " + sel.name);
    const counters = { otherGroupRefs: 0 };
    const rungs = (tpl.rungs || []).map(function (r) {
      return {
        number: r.number, type: r.type || "N",
        comment: r.comment === undefined ? null : r.comment,
        text: remapGroupText(r.text, group.index1Based, counters)
      };
    });
    if (counters.otherGroupRefs > 0) {
      warnings.push("Group " + group.index1Based + ": " + counters.otherGroupRefs +
        " template ZPA reference(s) used a literal group index other than 1 and were left unchanged.");
    }
    if (group.zoneCount < 2) {
      warnings.push("Group " + group.index1Based + " (" + group.segmentName + ") has 1 zone; the 2-zone template " +
        sel.name + " is used and the template's second zone is unconnected (see model warning).");
    }
    const zoneRange = group.zoneIndexes1Based && group.zoneIndexes1Based.length
      ? group.zoneIndexes1Based[0] + ".." + group.zoneIndexes1Based[group.zoneIndexes1Based.length - 1] : "?";
    const geom = groupGeometryNote(group, segments);
    const desc = (tpl.description ? tpl.description + "\n" : "") +
      "Instantiated from template " + sel.name + " for ZPA group " + group.index1Based +
      " (" + group.segmentName + ", " + group.zoneCount + " zone(s), global zones " + zoneRange +
      ", NETS[1].ZPA[" + group.index1Based + "], block " + group.blockName + ").\nGeometry: " + geom + ".";
    return {
      name: "ZPA_G" + group.index1Based + "_" + templateZones + "ZONE_SCAN",
      type: "RLL", description: desc, rungs: rungs,
      template: sel.name, groupIndex1Based: group.index1Based,
      segmentName: group.segmentName, zoneCount: group.zoneCount, geometry: geom
    };
  }

  /* ---------------- tracking (TRAY_TRACK) ---------------- */

  function sensorRefForZone(zone, computed) {
    const seg = computed.segments.find(function (s) { return s.name === zone.segmentName; });
    const bit = zone.zoneInGroup1Based - 1;
    if (seg && seg.conveyorType === "belt") {
      return "ENET_INPUTS[" + zone.groupIndex1Based + "]." + bit;
    }
    return "NETS[1].ZPA[" + zone.groupIndex1Based + "].INPUTS." + bit;
  }

  function scanZoneTagNames(scanZone) {
    let base = sanitizeName(scanZone.tagName || (scanZone.name + "_BARCODE"), "SCAN1_BARCODE");
    if (!/_BARCODE$/.test(base)) base += "_BARCODE";
    return { barcode: base, goodRead: base.replace(/_BARCODE$/, "_GOOD_READ") };
  }

  function buildTrackingSection(design, computed, warnings) {
    const tr = computed.tracking;
    if (!tr || !tr.enabled) {
      if (design.tracking && design.tracking.enabled) warnings.push("Tray tracking is enabled in the design but could not be computed; no tracking logic generated.");
      return null;
    }
    const scanZones = computed.scannedZones || [];
    if (!scanZones.length) {
      warnings.push("Tray tracking is enabled but there is no scan zone - TRACK_SCAN will contain no scanner reads.");
    }
    const barcodeLen = tr.barcodeLen;
    const maxTrays = tr.maxTrays;
    const zones = computed.zones;
    const zoneCount = zones.length;

    const udts = {};
    udts["STRING_" + barcodeLen] = customStringTypeXml(barcodeLen);
    udts.TRAY_TRACK = trayTrackUdtXml(barcodeLen);

    const controllerTags = [
      makeTagXml("TRACK_TBL", "TRAY_TRACK", maxTrays),
      makeTagXml("TRACK_COUNT", "DINT", 0),
      makeTagXml("TRACK_RESET", "BOOL", 0)
    ];
    const programTags = {
      TRACK_NDX: makeTagXml("TRACK_NDX", "DINT", 0),
      TRACK_MOVE_ZONE: makeTagXml("TRACK_MOVE_ZONE", "DINT", 0),
      TRACK_INIT_DONE: makeTagXml("TRACK_INIT_DONE", "BOOL", 0),
      TRACK_SENS_PREV: makeTagXml("TRACK_SENS_PREV", "BOOL", zoneCount)
    };
    const scanInfo = [];
    scanZones.forEach(function (sz) {
      const names = scanZoneTagNames(sz);
      controllerTags.push(makeTagXml(names.barcode, "STRING_" + barcodeLen, 0, { radix: null }));
      controllerTags.push(makeTagXml(names.goodRead, "BOOL", 0));
      const seen = names.goodRead.replace(/_GOOD_READ$/, "_SEEN");
      programTags[seen] = makeTagXml(seen, "BOOL", 0);
      scanInfo.push({ name: sz.name, barcodeTag: names.barcode, goodReadTag: names.goodRead, seenTag: seen, zoneIndex1Based: sz.zoneIndex1Based });
    });

    /* --- TRACK_INIT: clear the table + edge memory on first scan --- */
    const initLines = [
      "// One-shot tray tracking initialisation (TRACK_INIT_DONE = 0 at download)",
      "IF NOT TRACK_INIT_DONE THEN",
      "  TRACK_COUNT := 0;",
      "  FOR TRACK_NDX := 0 TO " + (maxTrays - 1) + " DO",
      "    TRACK_TBL[TRACK_NDX].Valid := 0;",
      "    TRACK_TBL[TRACK_NDX].Zone := 0;",
      "    TRACK_TBL[TRACK_NDX].Seq := 0;",
      "    TRACK_TBL[TRACK_NDX].Timestamp := 0;",
      "  END_FOR;",
      "  FOR TRACK_NDX := 0 TO " + (zoneCount - 1) + " DO",
      "    TRACK_SENS_PREV[TRACK_NDX] := 0;",
      "  END_FOR;",
      "  TRACK_INIT_DONE := 1;",
      "END_IF;"
    ];

    /* --- TRACK_SCAN: barcode read -> next ring slot --- */
    const scanLines = [];
    scanInfo.forEach(function (si, i) {
      scanLines.push("// Scan zone " + si.name + ": barcode read into TRACK_TBL slot (TRACK_COUNT MOD " + maxTrays + ")");
      if (si.zoneIndex1Based) {
        scanLines.push("IF " + si.goodReadTag + " AND NOT " + si.seenTag + " THEN");
        scanLines.push("  TRACK_NDX := TRACK_COUNT MOD " + maxTrays + ";");
        scanLines.push("  COP(" + si.barcodeTag + ", TRACK_TBL[TRACK_NDX].Barcode, 1);");
        scanLines.push("  TRACK_TBL[TRACK_NDX].Zone := " + si.zoneIndex1Based + ";");
        scanLines.push("  MOV(TRACK_COUNT, TRACK_TBL[TRACK_NDX].Seq);");
        scanLines.push("  TRACK_TBL[TRACK_NDX].Timestamp := 0;");
        scanLines.push("  TRACK_TBL[TRACK_NDX].Valid := 1;");
        scanLines.push("  TRACK_COUNT := TRACK_COUNT + 1;");
        scanLines.push("  " + si.seenTag + " := 1;");
        scanLines.push("END_IF;");
        scanLines.push("IF NOT " + si.goodReadTag + " THEN");
        scanLines.push("  " + si.seenTag + " := 0;");
        scanLines.push("END_IF;");
      } else {
        scanLines.push("// (scan zone is not allocated to a ZPA zone - no tracking write)");
      }
    });
    scanLines.push("// The <SCAN>_BARCODE / <SCAN>_GOOD_READ tags are populated by the external");
    scanLines.push("// scanner (MSG/CIP) interface - see generator warnings for spare I/O bit mapping.");

    /* --- TRACK_MOVE: zone sensor falling edge advances the tray --- */
    const moveLines = [];
    zones.forEach(function (zone, i) {
      const sensor = sensorRefForZone(zone, computed);
      moveLines.push("// " + zone.segmentName + " zone " + zone.zoneInSegment1Based + ": sensor falling edge -> tray leaves zone " + zone.index1Based);
      moveLines.push("IF NOT " + sensor + " AND TRACK_SENS_PREV[" + i + "] THEN");
      moveLines.push("  TRACK_MOVE_ZONE := " + zone.index1Based + ";");
      moveLines.push("END_IF;");
      moveLines.push("TRACK_SENS_PREV[" + i + "] := " + sensor + ";");
    });
    moveLines.push("// Advance the tray found in the cleared zone (or invalidate it after the last zone)");
    moveLines.push("IF TRACK_MOVE_ZONE > 0 THEN");
    moveLines.push("  FOR TRACK_NDX := 0 TO " + (maxTrays - 1) + " DO");
    moveLines.push("    IF TRACK_TBL[TRACK_NDX].Valid AND TRACK_TBL[TRACK_NDX].Zone = TRACK_MOVE_ZONE THEN");
    moveLines.push("      IF TRACK_MOVE_ZONE >= " + zoneCount + " THEN");
    moveLines.push("        TRACK_TBL[TRACK_NDX].Valid := 0;");
    moveLines.push("      ELSE");
    moveLines.push("        TRACK_TBL[TRACK_NDX].Zone := TRACK_MOVE_ZONE + 1;");
    moveLines.push("      END_IF;");
    moveLines.push("    END_IF;");
    moveLines.push("  END_FOR;");
    moveLines.push("  TRACK_MOVE_ZONE := 0;");
    moveLines.push("END_IF;");

    /* --- TRACK_CLEAR: HMI/stop-reset clears the table --- */
    const clearLines = [
      "// Clear the tracking table when TRACK_RESET (HMI / stop-reset) is on",
      "IF TRACK_RESET THEN",
      "  TRACK_COUNT := 0;",
      "  FOR TRACK_NDX := 0 TO " + (maxTrays - 1) + " DO",
      "    TRACK_TBL[TRACK_NDX].Valid := 0;",
      "    TRACK_TBL[TRACK_NDX].Zone := 0;",
      "  END_FOR;",
      "  TRACK_INIT_DONE := 0;",
      "END_IF;"
    ];

    const routines = [
      buildStRoutine("TRACK_INIT", "Tray tracking table initialisation (first scan): clears TRACK_TBL and the zone edge memory.", initLines.join("\n"), warnings),
      buildStRoutine("TRACK_SCAN", "Tray tracking barcode scan: on GOOD_READ copies the scanner barcode into the next TRACK_TBL ring slot with its zone and sequence.", scanLines.join("\n"), warnings),
      buildStRoutine("TRACK_MOVE", "Tray tracking move: on each zone sensor falling edge advances the tray to the next zone (clears it after the last zone).", moveLines.join("\n"), warnings),
      buildStRoutine("TRACK_CLEAR", "Tray tracking clear: TRACK_RESET clears the tray table and forces a re-init.", clearLines.join("\n"), warnings)
    ];

    /* scanner I/O allocation notes (spare input bits of the zone group blocks) */
    const spareBits = [];
    scanZones.forEach(function (sz) {
      let note = sz.name + " (" + (sz.type || "barcode") + ")";
      if (sz.zoneIndex1Based) {
        const zone = zones[sz.zoneIndex1Based - 1];
        const segment = computed.segments.find(function (s) { return s.name === zone.segmentName; });
        const group = computed.groups.find(function (g) { return g.index1Based === zone.groupIndex1Based; });
        if (group) {
          const spare = group.zoneCount;
          if (spare < 8) note += " -> spare input ZPA" + String(group.index1Based).padStart(2, "0") + ":I.Data." + spare;
          else note += " -> no spare input bit in its ZPA group (use a separate scanner block)";
        }
      }
      spareBits.push(note);
    });

    return {
      udts: udts,
      controllerTags: controllerTags,
      programTags: programTags,
      routines: routines,
      info: {
        enabled: true, maxTrays: maxTrays, barcodeLen: barcodeLen,
        zoneCount: zoneCount, scanZones: scanZones.length,
        scanInfo: scanInfo, spareBits: spareBits,
        tagPrefix: tr.tagPrefix || "TRACK"
      }
    };
  }

  /* ---------------- belt conveyors ---------------- */

  function buildBeltSection(design, computed, templates, aoi, warnings) {
    const beltSegments = computed.segments.filter(function (s) { return s.conveyorType === "belt"; });
    if (!beltSegments.length) return null;
    const pf525 = !!(aoi && aoi.entries && aoi.entries.indexOf("Dvc_PF525") !== -1);
    const controllerTags = [makeTagXml("SAFETY_OK", "BOOL", 0)];
    const programTags = {};
    const routines = [];
    const drives = [];

    beltSegments.forEach(function (seg) {
      const S = sanitizeName(seg.name, "BELT");
      const runCmd = S + "_RUN_CMD";
      const driveRun = S + "_DRIVE_RUN";
      const driveFault = S + "_DRIVE_FAULT";
      const driveStatus = S + "_DRIVE_STATUS";
      controllerTags.push(makeTagXml(runCmd, "BOOL", 0));
      controllerTags.push(makeTagXml(driveRun, "BOOL", 0));
      controllerTags.push(makeTagXml(driveFault, "BOOL", 0));
      controllerTags.push(makeTagXml(driveStatus, "DINT", 0));
      const geom = segmentGeometryNote(seg);
      const rungs = [];
      rungs.push({
        number: 0, type: "N",
        comment: "START/STOP LATCH: " + seg.name + " RUN_CMD latches DRIVE_RUN; fault or SAFETY_OK drops it",
        text: "[XIC(" + runCmd + ")XIO(" + driveFault + ")XIC(SAFETY_OK)]OTL(" + driveRun + ");"
      });
      rungs.push({
        number: 1, type: "N",
        comment: "STOP/FAULT INTERLOCK: clears the drive latch",
        text: "[XIO(" + runCmd + ") ,XIC(" + driveFault + ") ,XIO(SAFETY_OK)]OTU(" + driveRun + ");"
      });
      const groups = computed.groups.filter(function (g) { return g.segmentId === seg.id; });
      let spareGroup = null;
      for (const g of groups) {
        if (g.zoneCount < 8) { spareGroup = g; break; }
      }
      if (spareGroup) {
        const outRef = spareGroup.blockName + ":O.Data." + spareGroup.zoneCount;
        const inRef = spareGroup.blockName + ":I.Data." + spareGroup.zoneCount;
        rungs.push({
          number: 2, type: "N",
          comment: "DRIVE RUN CONTACTOR on spare 1799ER group output bit (" + outRef + ")",
          text: "[XIC(" + driveRun + ")]OTE(" + outRef + ");"
        });
        rungs.push({
          number: 3, type: "N",
          comment: "DRIVE READY/FAULT contact on spare 1799ER group input bit (" + inRef + ")",
          text: "[XIC(" + inRef + ")]OTE(" + driveFault + ");"
        });
        warnings.push("Belt segment " + seg.name + ": drive run contactor mapped to " + outRef + " and fault contact read from " + inRef +
          " (spare I/O bit of its zone group block); verify the field wiring.");
      } else {
        warnings.push("Belt segment " + seg.name + ": no spare I/O bit on its ZPA group blocks; the drive run/fault interface must be wired manually.");
      }
      if (pf525) {
        programTags[S + "_PF525_DRIVE"] = makeTagXml(S + "_PF525_DRIVE", "Dvc_PF525", 0, { radix: null });
        programTags[S + "_READ_MSG"] = makeTagXml(S + "_READ_MSG", "MESSAGE", 0, { radix: null });
        programTags[S + "_WRITE_MSG"] = makeTagXml(S + "_WRITE_MSG", "MESSAGE", 0, { radix: null });
        programTags[S + "_MSG_DATA"] = makeTagXml(S + "_MSG_DATA", "DINT", 65);
        programTags[S + "_DEVICE_CLASS"] = makeTagXml(S + "_DEVICE_CLASS", "ST_Sys_DeviceClass", 0, { radix: null });
        rungs.push({
          number: rungs.length, type: "N",
          comment: "PowerFlex 525 AOI call (Dvc_PF525 embedded). Interface tags " + S + "_PF525_DRIVE/_READ_MSG/_WRITE_MSG/_MSG_DATA/_DEVICE_CLASS are declared; the module I/O data parameters are unconnected (?) - create the PowerFlex 525 module and finish the interface wiring.",
          text: "Dvc_PF525(" + S + "_PF525_DRIVE,Local,?,?," + S + "_READ_MSG," + S + "_WRITE_MSG," + S + "_MSG_DATA," + S + "_DEVICE_CLASS);"
        });
        warnings.push("Belt segment " + seg.name + ": PowerFlex 525 AOI (Dvc_PF525) embedded and called; the module (Ref_DataIn/Ref_DataOut) and message wiring must be completed after import.");
      }
      if (!pf525) {
        warnings.push("Belt segment " + seg.name + ": PowerFlex 525 AOI not embedded (opts.aois does not include Dvc_PF525); " +
          "drive control uses simple RUN_CMD/DRIVE_RUN/DRIVE_FAULT/DRIVE_STATUS tags and SAFETY_OK.");
      }
      routines.push({
        name: "BELT_" + S + "_DRIVE", type: "RLL",
        description: "Belt conveyor drive control for " + seg.name + " (" + geom + "). " +
          "RUN_CMD latch with DRIVE_FAULT and SAFETY_OK interlocks" + (pf525 ? "; PowerFlex 525 AOI call" : "") +
          "; drive status word " + driveStatus + " is written by the drive interface.",
        rungs: rungs
      });
      drives.push({
        segment: seg.name, routine: "BELT_" + S + "_DRIVE", geometry: geom,
        runCmdTag: runCmd, runTag: driveRun, faultTag: driveFault, statusTag: driveStatus,
        pf525: pf525
      });
    });

    return { controllerTags: controllerTags, programTags: programTags, routines: routines, drives: drives, pf525: pf525 };
  }

  /* ---------------- merge junctions (ZPA spur -> main line) ---------------- */

  function findZoneByIndex(computed, index1Based) {
    return (computed.zones || []).find(function (z) { return z.index1Based === index1Based; }) || null;
  }
  function zoneSensorRef(zone) {
    if (!zone) return null;
    if (zone.conveyorType === "belt") return "ENET_INPUTS[" + zone.groupIndex1Based + "]." + (zone.zoneInGroup1Based - 1);
    return "NETS[1].ZPA[" + zone.groupIndex1Based + "].INPUTS." + (zone.zoneInGroup1Based - 1);
  }
  function zoneReleaseRef(zone) {
    return "NETS[1].ZPA[" + zone.groupIndex1Based + "].INPUTS.8";
  }

  function buildMergeSection(computed, warnings) {
    const merges = computed.merges || [];
    if (!merges.length) return null;
    const controllerTags = [];
    const programTags = {};
    const routines = [];
    const infos = [];
    merges.forEach(function (mg, i) {
      const P = sanitizeName(mg.name, "MERGE" + (i + 1));
      const mergeZone = findZoneByIndex(computed, mg.mergeZoneIndex1Based);
      const spurZone = findZoneByIndex(computed, mg.spurZoneIndex1Based);
      let mainZone = mg.upstreamMainZone ? findZoneByIndex(computed, mg.upstreamMainZone) : null;
      if (!mainZone && mg.mergeZoneIndex1Based > 1) mainZone = findZoneByIndex(computed, mg.mergeZoneIndex1Based - 1);
      if (!mergeZone || !spurZone || !mainZone) {
        warnings.push("Merge " + mg.name + ": merge/spur/main-upstream zone mapping is incomplete - merge routine skipped.");
        return;
      }
      const mainSens = zoneSensorRef(mainZone);
      const spurSens = zoneSensorRef(spurZone);
      const mergeSens = zoneSensorRef(mergeZone);
      const mainGrantRef = zoneReleaseRef(mainZone);
      const spurGrantRef = zoneReleaseRef(spurZone);
      const priority = mg.priority || "alternate";
      const tagMainGrant = "MERGE_" + P + "_MAIN_GRANT";
      const tagSpurGrant = "MERGE_" + P + "_SPUR_GRANT";
      const tagMainReq = "MERGE_" + P + "_MAIN_REQ";
      const tagSpurReq = "MERGE_" + P + "_SPUR_REQ";
      const tagOcc = "MERGE_" + P + "_OCC";
      const tagLastMain = "MERGE_" + P + "_LAST_MAIN";
      const tagMainTmr = "MERGE_" + P + "_MAIN_TMR";
      const tagSpurTmr = "MERGE_" + P + "_SPUR_TMR";
      controllerTags.push(makeTagXml(tagMainGrant, "BOOL", 0));
      controllerTags.push(makeTagXml(tagSpurGrant, "BOOL", 0));
      programTags[tagMainReq] = makeTagXml(tagMainReq, "BOOL", 0);
      programTags[tagSpurReq] = makeTagXml(tagSpurReq, "BOOL", 0);
      programTags[tagOcc] = makeTagXml(tagOcc, "BOOL", 0);
      programTags[tagLastMain] = makeTagXml(tagLastMain, "BOOL", 0);
      programTags[tagMainTmr] = makeTagXml(tagMainTmr, "TIMER", 0, { radix: null });
      programTags[tagSpurTmr] = makeTagXml(tagSpurTmr, "TIMER", 0, { radix: null });
      function condMain() {
        const base = "XIO(" + tagOcc + ")XIC(" + tagMainReq + ")";
        if (priority === "main") return base;
        if (priority === "spur") return base + "XIO(" + tagSpurReq + ")";
        return base + "[XIO(" + tagSpurReq + ") ,XIO(" + tagLastMain + ") ]";
      }
      function condSpur() {
        const base = "XIO(" + tagOcc + ")XIC(" + tagSpurReq + ")";
        if (priority === "spur") return base;
        if (priority === "main") return base + "XIO(" + tagMainReq + ")";
        return base + "[XIO(" + tagMainReq + ") ,XIC(" + tagLastMain + ") ]";
      }
      const rungs = [];
      const add = function (comment, text) { rungs.push({ number: rungs.length, type: "N", comment: comment, text: text }); };
      add("MERGE " + P + ": priority=" + priority + ", merge zone " + mg.mergeZoneIndex1Based +
        " (block " + mg.mergeBlockName + "), main upstream zone " + mainZone.index1Based + " (block " + mainZone.blockName + "), " +
        "spur last zone " + spurZone.index1Based + " (block " + spurZone.blockName + "); release grants on NETS[1].ZPA[g].INPUTS.8",
        "XIC(" + mainSens + ")OTE(" + tagMainReq + ");");
      add("MERGE " + P + ": spur upstream zone requesting release?",
        "XIC(" + spurSens + ")OTE(" + tagSpurReq + ");");
      add("MERGE " + P + ": merge zone entry sensor (downstream occupied?)",
        "XIC(" + mergeSens + ")OTE(" + tagOcc + ");");
      add("MERGE " + P + ": GRANT MAIN - grant release to the main upstream zone (set its INPUTS.8 = 1, hold spur = 0)",
        condMain() + "[" + "OTL(" + tagMainGrant + ") ,OTU(" + tagSpurGrant + ") ,MOV(0," + spurGrantRef + ") ,MOV(1," + mainGrantRef +
        ") ,OTL(" + tagLastMain + ") ]");
      add("MERGE " + P + ": GRANT SPUR - grant release to the spur last zone (set its INPUTS.8 = 1, hold main = 0)",
        condSpur() + "[" + "OTU(" + tagMainGrant + ") ,OTL(" + tagSpurGrant + ") ,MOV(0," + mainGrantRef + ") ,MOV(1," + spurGrantRef +
        ") ,OTU(" + tagLastMain + ") ]");
      add("MERGE " + P + ": merge zone occupied - hold BOTH upstream zones (INPUTS.8 = 0)",
        "XIC(" + tagOcc + ")[OTU(" + tagMainGrant + ") ,OTU(" + tagSpurGrant + ") ,MOV(0," + mainGrantRef + ") ,MOV(0," + spurGrantRef + ") ]");
      add("MERGE " + P + ": idle with no requests - restore both INPUTS.8 = 1 (normal running)",
        "XIO(" + tagOcc + ")XIO(" + tagMainReq + ")XIO(" + tagSpurReq + ")XIO(" + tagMainGrant + ")XIO(" + tagSpurGrant +
        ")MOV(1," + mainGrantRef + ")MOV(1," + spurGrantRef + ");");
      add("MERGE " + P + ": 8 s blocked-release timeout for the main grant",
        "XIC(" + tagMainGrant + ")XIC(" + tagMainReq + ")TON(" + tagMainTmr + ",?,?);");
      add("MERGE " + P + ": 8 s blocked-release timeout for the spur grant",
        "XIC(" + tagSpurGrant + ")XIC(" + tagSpurReq + ")TON(" + tagSpurTmr + ",?,?);");
      add("MERGE " + P + ": main grant timed out (upstream sensor stayed blocked) - SWAP the grant to the spur",
        "XIC(" + tagMainTmr + ".DN)[OTU(" + tagMainGrant + ") ,OTL(" + tagSpurGrant + ") ,MOV(1," + spurGrantRef + ") ,MOV(0," +
        mainGrantRef + ") ,OTU(" + tagLastMain + ") ,RES(" + tagMainTmr + ") ,RES(" + tagSpurTmr + ") ]");
      add("MERGE " + P + ": spur grant timed out (upstream sensor stayed blocked) - SWAP the grant to the main line",
        "XIC(" + tagSpurTmr + ".DN)[OTU(" + tagSpurGrant + ") ,OTL(" + tagMainGrant + ") ,MOV(1," + mainGrantRef + ") ,MOV(0," +
        spurGrantRef + ") ,OTL(" + tagLastMain + ") ,RES(" + tagMainTmr + ") ,RES(" + tagSpurTmr + ") ]");
      routines.push({
        name: "MERGE_" + P, type: "RLL",
        description: "Merge junction " + mg.name + " generated by L5X Studio: priority=" + priority +
          "; merge zone " + mg.mergeZoneIndex1Based + " (block " + mg.mergeBlockName + ", entry sensor bit " + (mergeZone.zoneInGroup1Based - 1) +
          "), main upstream zone " + mainZone.index1Based + " (block " + mainZone.blockName + "), spur last zone " +
          spurZone.index1Based + " (block " + spurZone.blockName + "), spur end segment " +
          (mg.spurEndSegmentName || "?") + ". Alternating/shortest release arbitration: sets the granted upstream zone's " +
          "NETS[1].ZPA[g].INPUTS.8 = 1 and the other = 0 (templates consume it next scan). If a granted upstream zone stays " +
          "blocked for 8 s the grant is swapped (jam/timeout handling).",
        rungs: rungs
      });
      infos.push({
        name: mg.name, routine: "MERGE_" + P, priority: priority,
        mergeZone: mg.mergeZoneIndex1Based, mainZone: mainZone.index1Based, spurZone: spurZone.index1Based,
        mergeBlock: mg.mergeBlockName, spurBlock: mg.spurBlockName, gapM: mg.gapM,
        mainGrantTag: tagMainGrant, spurGrantTag: tagSpurGrant,
        mainGrantRef: mainGrantRef, spurGrantRef: spurGrantRef,
        x: mg.x, y: mg.y, angleDeg: mg.angleDeg
      });
    });
    if (!routines.length) return null;
    return { controllerTags: controllerTags, programTags: programTags, routines: routines, merges: infos };
  }

  /* ---------------- transfer devices (pusher / rotary table / pop-up) ---------------- */

  function buildDeviceSection(design, computed, templates, warnings) {
    const transfers = computed.transfers || [];
    if (!transfers.length) return null;
    const controllerTags = [];
    const programTags = {};
    const routines = [];
    const devices = [];
    transfers.forEach(function (tf, i) {
      const block = tf.ioBlock;
      const S = sanitizeName(tf.name, "XFER" + (i + 1));
      const inputMap = (MODEL.transferInputMap ? MODEL.transferInputMap(tf.type) : []);
      const outputMap = (MODEL.transferOutputMap ? MODEL.transferOutputMap(tf.type) : []);
      const st = [];
      controllerTags.push(makeTagXml(block + "_INPUTS", "DINT", 0));
      controllerTags.push(makeTagXml(block + "_OUTPUTS", "DINT", 0));
      controllerTags.push(makeTagXml(block + "_STATUS", "DINT", 0));
      controllerTags.push(makeTagXml(block + "_FAULT", "BOOL", 0));
      const aliasPre = S + "_";
      inputMap.forEach(function (b) {
        controllerTags.push(makeTagXml(aliasPre + b.name, "BOOL", 0, { aliasFor: block + "_INPUTS." + b.bit }));
      });
      outputMap.forEach(function (b) {
        controllerTags.push(makeTagXml(aliasPre + b.name, "BOOL", 0, { aliasFor: block + "_OUTPUTS." + b.bit }));
      });
      function bitIn(name) {
        const b = inputMap.find(function (x) { return x.name === name; });
        return b ? aliasPre + b.name : null;
      }
      function bitOut(name) {
        const b = outputMap.find(function (x) { return x.name === name; });
        return b ? aliasPre + b.name : null;
      }
      const cmdName = "XFER_CMD_" + S;
      if (tf.type === "popup_transfer") {
        controllerTags.push(makeTagXml(cmdName + "_LEFT", "BOOL", 0));
        controllerTags.push(makeTagXml(cmdName + "_RIGHT", "BOOL", 0));
      } else {
        controllerTags.push(makeTagXml(cmdName, "BOOL", 0));
      }
      const descBits = "inputs: " + inputMap.map(function (b) { return b.name + "=" + b.bit; }).join(", ") +
        "; outputs: " + outputMap.map(function (b) { return b.name + "=" + b.bit; }).join(", ");
      const stateTag = block + "_STATE";
      programTags[stateTag] = makeTagXml(stateTag, "DINT", 0);
      const timerTags = [];
      if (tf.type === "pusher") {
        const extendTmr = block + "_EXTEND_TMR", retractTmr = block + "_RETRACT_TMR";
        programTags[extendTmr] = makeTagXml(extendTmr, "TIMER", 0, { radix: null });
        programTags[retractTmr] = makeTagXml(retractTmr, "TIMER", 0, { radix: null });
        const EXT = bitOut("EXTEND_SOL"), RET = bitOut("RETRACT_SOL"), EN = bitOut("DIVERT_ENABLE");
        const RET_SW = bitIn("RETRACTED_SW"), EXT_SW = bitIn("EXTENDED_SW");
        const TRAY = bitIn("TRAY_PRESENT"), DOWN = bitIn("DOWNSTREAM_CLEAR");
        const extendMs = Math.max(100, Math.round(((tf.pusher && tf.pusher.extendTimeS) || 0.8) * 1000));
        const stateDesc = "0 = idle, 1 = extending, 2 = extended, 3 = retracting";
        [
          "// PUSHER " + S + " (one-way divert, block " + block + "): state " + stateDesc,
          "// I/O: " + descBits,
          "IF " + block + "_STATE = 0 THEN",
          "  " + EXT + " := 0;",
          "  " + RET + " := 1;",
          "  " + EN + " := 1;",
          "  IF " + cmdName + " AND " + TRAY + " AND " + DOWN + " THEN",
          "    " + block + "_STATE := 1;",
          "  END_IF;",
          "END_IF;",
          "IF " + block + "_STATE = 1 THEN",
          "  " + EXT + " := 1;",
          "  " + RET + " := 0;",
          "  IF " + EXT_SW + " THEN",
          "    " + block + "_STATE := 2;",
          "  END_IF;",
          "  TON(" + extendTmr + ", " + extendMs + ", " + extendTmr + ".ACC);",
          "  IF " + extendTmr + ".DN THEN",
          "    " + block + "_FAULT := 1;",
          "    " + block + "_STATE := 3;",
          "  END_IF;",
          "END_IF;",
          "IF " + block + "_STATE = 2 THEN",
          "  " + EXT + " := 1;",
          "  IF NOT " + TRAY + " THEN",
          "    " + block + "_STATE := 3;",
          "  END_IF;",
          "END_IF;",
          "IF " + block + "_STATE = 3 THEN",
          "  " + EXT + " := 0;",
          "  " + RET + " := 1;",
          "  IF " + RET_SW + " THEN",
          "    " + block + "_STATE := 0;",
          "    " + block + "_FAULT := 0;",
          "  END_IF;",
          "  TON(" + retractTmr + ", " + extendMs + ", " + retractTmr + ".ACC);",
          "  IF " + retractTmr + ".DN THEN",
          "    " + block + "_FAULT := 1;",
          "    " + block + "_STATE := 0;",
          "  END_IF;",
          "END_IF;"
        ].forEach(function (l) { st.push(l); });
      } else if (tf.type === "rotary_table") {
        const stepDeg = Math.max(15, Math.min(180, (tf.rotary && tf.rotary.stepDeg) || 90));
        const positions = Math.max(2, Math.round(360 / stepDeg));
        const rotateTmr = block + "_ROTATE_TMR";
        programTags[rotateTmr] = makeTagXml(rotateTmr, "TIMER", 0, { radix: null });
        const HOME = bitIn("HOME_SW"), P90 = bitIn("POS_90_SW"), P180 = bitIn("POS_180_SW"), P270 = bitIn("POS_270_SW");
        const TRAY = bitIn("TRAY_PRESENT");
        const CW = bitOut("ROTATE_CW"), CCW = bitOut("ROTATE_CCW"), EN = bitOut("TABLE_ENABLE"), BRK = bitOut("TABLE_BRAKE");
        const posTag = "XFER_POS_" + S;
        controllerTags.push(makeTagXml(posTag, "INT", 0));
        controllerTags.push(makeTagXml("XFER_DEST_" + S, "INT", 0));
        const rotateMs = Math.max(500, Math.round(((tf.rotary && tf.rotary.rotateTimeS) || 3) * 1000));
        st.push("// ROTARY TABLE " + S + " (bidirectional router, block " + block + "): " + positions + " positions of " + stepDeg + " deg");
        st.push("// I/O: " + descBits);
        st.push("// XFER_POS_" + S + " = current position status (0.." + (positions - 1) + "); XFER_DEST_" + S + " = requested destination (writable by route logic/HMI)");
        st.push("IF " + HOME + " THEN");
        st.push("  " + posTag + " := 0;");
        st.push("ELSIF " + P90 + " THEN");
        st.push("  " + posTag + " := 1;");
        st.push("ELSIF " + P180 + " THEN");
        st.push("  " + posTag + " := 2;");
        st.push("ELSIF " + P270 + " THEN");
        st.push("  " + posTag + " := 3;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 0 THEN");
        st.push("  " + CW + " := 0;");
        st.push("  " + CCW + " := 0;");
        st.push("  " + BRK + " := 0;");
        st.push("  " + EN + " := 1;");
        st.push("  IF " + cmdName + " AND " + TRAY + " THEN");
        st.push("    IF " + "XFER_DEST_" + S + " = " + posTag + " THEN");
        st.push("      XFER_DEST_" + S + " := (" + posTag + " + 1) MOD " + positions + ";");
        st.push("    END_IF;");
        st.push("    " + block + "_DIFF := (XFER_DEST_" + S + " - " + posTag + " + " + positions + ") MOD " + positions + ";");
        st.push("    IF " + block + "_DIFF <= " + Math.floor(positions / 2) + " THEN");
        st.push("      " + block + "_DIR := 1;");
        st.push("    ELSE");
        st.push("      " + block + "_DIR := 0;");
        st.push("    END_IF;");
        st.push("    " + block + "_STATE := 1;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 1 THEN");
        st.push("  " + BRK + " := 1;");
        st.push("  IF " + block + "_DIR = 1 THEN");
        st.push("    " + CW + " := 1;");
        st.push("    " + CCW + " := 0;");
        st.push("  ELSE");
        st.push("    " + CW + " := 0;");
        st.push("    " + CCW + " := 1;");
        st.push("  END_IF;");
        st.push("  IF " + posTag + " = XFER_DEST_" + S + " THEN");
        st.push("    " + block + "_STATE := 2;");
        st.push("  END_IF;");
        st.push("  TON(" + rotateTmr + ", " + rotateMs + ", " + rotateTmr + ".ACC);");
        st.push("  IF " + rotateTmr + ".DN THEN");
        st.push("    " + block + "_FAULT := 1;");
        st.push("    " + block + "_STATE := 3;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 2 THEN");
        st.push("  " + CW + " := 0;");
        st.push("  " + CCW + " := 0;");
        st.push("  " + BRK + " := 0;");
        st.push("  IF NOT " + cmdName + " THEN");
        st.push("    " + block + "_STATE := 0;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 3 THEN");
        st.push("  " + CW + " := 0;");
        st.push("  " + CCW + " := 0;");
        st.push("  " + BRK + " := 0;");
        st.push("  IF NOT " + cmdName + " THEN");
        st.push("    " + block + "_FAULT := 0;");
        st.push("    " + block + "_STATE := 0;");
        st.push("  END_IF;");
        st.push("END_IF;");
        programTags[block + "_DIFF"] = makeTagXml(block + "_DIFF", "DINT", 0);
        programTags[block + "_DIR"] = makeTagXml(block + "_DIR", "DINT", 0);
      } else {
        const raiseTmr = block + "_RAISE_TMR", xferTmr = block + "_XFER_TMR", lowerTmr = block + "_LOWER_TMR";
        programTags[raiseTmr] = makeTagXml(raiseTmr, "TIMER", 0, { radix: null });
        programTags[xferTmr] = makeTagXml(xferTmr, "TIMER", 0, { radix: null });
        programTags[lowerTmr] = makeTagXml(lowerTmr, "TIMER", 0, { radix: null });
        programTags[block + "_DIR"] = makeTagXml(block + "_DIR", "DINT", 0);
        const UP = bitIn("POPUP_UP_SW"), DOWN_SW = bitIn("POPUP_DOWN_SW"), TRAY = bitIn("TRAY_PRESENT");
        const LEFT_CLEAR = bitIn("LEFT_CLEAR"), RIGHT_CLEAR = bitIn("RIGHT_CLEAR");
        const RAISE = bitOut("RAISE"), LOWER = bitOut("LOWER"), BELT_L = bitOut("BELT_LEFT"), BELT_R = bitOut("BELT_RIGHT"), EN = bitOut("XFER_ENABLE");
        const raiseMs = Math.max(200, Math.round(((tf.popup && tf.popup.raiseTimeS) || 0.5) * 1000));
        const xferMs = 8000;
        st.push("// POPUP TRANSFER " + S + " (bidirectional cross transfer, block " + block + "): state 0 = idle, 1 = raising, 2 = transferring, 3 = lowering, 4 = fault");
        st.push("// I/O: " + descBits);
        st.push("IF " + block + "_STATE = 0 THEN");
        st.push("  " + RAISE + " := 0;");
        st.push("  " + LOWER + " := 1;");
        st.push("  " + BELT_L + " := 0;");
        st.push("  " + BELT_R + " := 0;");
        st.push("  " + EN + " := 1;");
        st.push("  IF " + TRAY + " AND " + DOWN_SW + " THEN");
        st.push("    IF " + cmdName + "_LEFT AND " + LEFT_CLEAR + " THEN");
        st.push("      " + block + "_DIR := 1;");
        st.push("      " + block + "_STATE := 1;");
        st.push("    END_IF;");
        st.push("    IF " + cmdName + "_RIGHT AND " + RIGHT_CLEAR + " THEN");
        st.push("      " + block + "_DIR := 2;");
        st.push("      " + block + "_STATE := 1;");
        st.push("    END_IF;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 1 THEN");
        st.push("  " + RAISE + " := 1;");
        st.push("  " + LOWER + " := 0;");
        st.push("  IF " + UP + " THEN");
        st.push("    " + block + "_STATE := 2;");
        st.push("  END_IF;");
        st.push("  TON(" + raiseTmr + ", " + raiseMs + ", " + raiseTmr + ".ACC);");
        st.push("  IF " + raiseTmr + ".DN THEN");
        st.push("    " + block + "_FAULT := 1;");
        st.push("    " + block + "_STATE := 4;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 2 THEN");
        st.push("  " + RAISE + " := 0;");
        st.push("  " + LOWER + " := 0;");
        st.push("  IF " + block + "_DIR = 1 THEN");
        st.push("    " + BELT_L + " := 1;");
        st.push("    " + BELT_R + " := 0;");
        st.push("  END_IF;");
        st.push("  IF " + block + "_DIR = 2 THEN");
        st.push("    " + BELT_L + " := 0;");
        st.push("    " + BELT_R + " := 1;");
        st.push("  END_IF;");
        st.push("  IF NOT " + TRAY + " THEN");
        st.push("    " + block + "_STATE := 3;");
        st.push("  END_IF;");
        st.push("  TON(" + xferTmr + ", " + xferMs + ", " + xferTmr + ".ACC);");
        st.push("  IF " + xferTmr + ".DN THEN");
        st.push("    " + block + "_FAULT := 1;");
        st.push("    " + block + "_STATE := 4;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 3 THEN");
        st.push("  " + RAISE + " := 0;");
        st.push("  " + LOWER + " := 1;");
        st.push("  " + BELT_L + " := 0;");
        st.push("  " + BELT_R + " := 0;");
        st.push("  IF " + DOWN_SW + " THEN");
        st.push("    " + block + "_STATE := 0;");
        st.push("  END_IF;");
        st.push("  TON(" + lowerTmr + ", " + raiseMs + ", " + lowerTmr + ".ACC);");
        st.push("  IF " + lowerTmr + ".DN THEN");
        st.push("    " + block + "_FAULT := 1;");
        st.push("    " + block + "_STATE := 4;");
        st.push("  END_IF;");
        st.push("END_IF;");
        st.push("IF " + block + "_STATE = 4 THEN");
        st.push("  " + RAISE + " := 0;");
        st.push("  " + LOWER + " := 1;");
        st.push("  " + BELT_L + " := 0;");
        st.push("  " + BELT_R + " := 0;");
        st.push("  IF NOT " + cmdName + "_LEFT AND NOT " + cmdName + "_RIGHT THEN");
        st.push("    " + block + "_FAULT := 0;");
        st.push("    " + block + "_STATE := 0;");
        st.push("  END_IF;");
        st.push("END_IF;");
      }
      const routineName = (tf.type === "pusher" ? "PUSHER_" : tf.type === "rotary_table" ? "ROTARY_" : "POPUP_") + S;
      const description = tf.typeLabel + " control for " + tf.name + " (block " + block + ", " + tf.segmentName +
        ", offset " + tf.offsetM + " m)" +
        (tf.type === "pusher" ? " - ONE-WAY divert (extend/retract; no reverse divert)" : tf.type === "rotary_table"
          ? " - BIDIRECTIONAL router (shortest-path CW/CCW rotation; positions from " + ((tf.rotary && tf.rotary.stepDeg) || 90) + " deg step)"
          : " - BIDIRECTIONAL cross transfer (left/right, interlocks LEFT_CLEAR/RIGHT_CLEAR)") +
        ". I/O bit map: " + descBits + ".";
      routines.push(buildStRoutine(routineName, description, st.join("\n"), warnings));
      devices.push({
        name: tf.name, type: tf.type, typeLabel: tf.typeLabel, ioBlock: block, ip: tf.ip,
        routine: routineName, stateTag: stateTag, statusTag: block + "_STATUS", faultTag: block + "_FAULT",
        cmdTags: tf.type === "popup_transfer" ? [cmdName + "_LEFT", cmdName + "_RIGHT"] : [cmdName],
        posTag: tf.type === "rotary_table" ? "XFER_POS_" + S : null,
        inputMap: inputMap, outputMap: outputMap, aliasPrefix: aliasPre,
        x: tf.x, y: tf.y, angleDeg: tf.angleDeg, zoneIndex1Based: tf.zoneIndex1Based,
        bidirectional: !!tf.bidirectional, directions: tf.directions
      });
    });
    if (!routines.length) return null;
    return { controllerTags: controllerTags, programTags: programTags, routines: routines, devices: devices };
  }

  /* ---------------- generated routines (main / init / io) ---------------- */

  function buildMainRoutine(spec, warnings) {
    const rungs = [];
    const push = function (comment, text) {
      rungs.push({ number: rungs.length, type: "N", comment: comment, text: text });
    };
    push("INITIALISE CONFIGURATION (ENET offsets" + (spec.hasZpa ? ", ZPA group count, per-group NUM_OF_ZONES/SENSOR_IO" : "") + ")",
      "JSR(INIT_CONFIG,0);");
    if (spec.includeIoMain) push("READ FIELD I/O / WRITE FIELD OUTPUTS (IO_MAIN)", "JSR(IO_MAIN,0);");
    if (spec.tracking) push("TRAY TRACKING INIT (first scan clears TRACK_TBL)", "JSR(TRACK_INIT,0);");
    if (spec.hasZpa) {
      push("MAP ENET I/O WORDS <-> NETS[1].ZPA GROUPS (ZPA_MAPPING loop over NUM_OF_ZPA_NODES)",
        "[SUB(CONFIG_ZPA.ENET_OFFSET,1,MAP_OFFSET_INT) ,FOR(ZPA_MAPPING,ZPA_NDX,1,NETS[1].NUM_OF_ZPA_NODES,1) ];");
    }
    spec.groupRoutines.forEach(function (r) {
      push(r.segmentName + " group " + r.groupIndex1Based + ": " + r.zoneCount + " zone(s) -> " + r.template +
        " | " + r.geometry, "JSR(" + r.name + ",0);");
    });
    (spec.beltRoutines || []).forEach(function (d) {
      push("BELT DRIVE " + d.segment + " | " + d.geometry, "JSR(" + d.routine + ",0);");
    });
    (spec.mergeRoutines || []).forEach(function (m) {
      push("MERGE " + m.name + " (priority " + m.priority + "): main zone " + m.mainZone + ", merge zone " + m.mergeZone +
        ", spur zone " + m.spurZone, "JSR(" + m.routine + ",0);");
    });
    (spec.transferRoutines || []).forEach(function (d) {
      push((d.typeLabel || "TRANSFER") + " " + d.name + " (block " + d.ioBlock + ")" +
        (d.bidirectional ? " - bidirectional" : " - one-way divert"), "JSR(" + d.routine + ",0);");
    });
    if (spec.tracking) {
      push("TRAY TRACKING MOVE (zone sensor falling edges)", "JSR(TRACK_MOVE,0);");
      push("TRAY TRACKING SCAN (barcode reads)", "JSR(TRACK_SCAN,0);");
      push("TRAY TRACKING CLEAR (TRACK_RESET)", "JSR(TRACK_CLEAR,0);");
    }
    return {
      name: "Main", type: "RLL",
      description: "Main scan generated by L5X Studio: INIT_CONFIG" + (spec.includeIoMain ? ", IO_MAIN" : "") +
        (spec.tracking ? ", TRACK_INIT" : "") + (spec.hasZpa ? ", ZPA_MAPPING loop, one JSR per ZPA group scan" : "") +
        ((spec.beltRoutines || []).length ? ", one JSR per belt drive" : "") +
        ((spec.mergeRoutines || []).length ? ", one JSR per merge junction" : "") +
        ((spec.transferRoutines || []).length ? ", one JSR per transfer device" : "") +
        (spec.tracking ? ", TRACK_MOVE, TRACK_SCAN, TRACK_CLEAR" : "") + ".",
      rungs: rungs
    };
  }

  function buildInitConfigRoutine(groups, zones, hasZpa, merges, warnings) {
    const rungs = [];
    const mergePresets = (merges || []).map(function (m) {
      return "MOV(8000," + m.mainGrantTag.replace(/_MAIN_GRANT$/, "_MAIN_TMR") + ".PRE);" +
        "MOV(8000," + m.spurGrantTag.replace(/_SPUR_GRANT$/, "_SPUR_TMR") + ".PRE);";
    }).join("");
    if (hasZpa) {
      rungs.push({
        number: 0, type: "N",
        comment: "NETWORK / ENET CONFIG: group count + first ENET word and device-status node" +
          ((merges || []).length ? " + merge 8 s timeout presets" : ""),
        text: "MOV(" + groups.length + ",NETS[1].NUM_OF_ZPA_NODES);" +
          "MOV(" + ENET_OFFSET + ",CONFIG_ZPA.ENET_OFFSET);" +
          "MOV(" + ENET_FIRST_ADDR + ",CONFIG_ZPA.FIRST_ADDR);" + mergePresets
      });
      groups.forEach(function (group, i) {
        let text = "MOV(1,NETS[1].ZPA[" + group.index1Based + "].INPUTS.8);" +
          "MOV(" + group.zoneCount + ",NETS[1].ZPA[" + group.index1Based + "].CONFIG.NUM_OF_ZONES);";
        for (let k = 1; k <= group.zoneCount; k++) {
          text += "MOV(" + (k - 1) + ",NETS[1].ZPA[" + group.index1Based + "].CONFIG.SENSOR_IO[" + k + "]);";
        }
        rungs.push({
          number: i + 1, type: "N",
          comment: "ZPA GROUP " + group.index1Based + " (" + group.segmentName + ", block " + group.blockName +
            "): release permission INPUTS.8 = 1, NUM_OF_ZONES / SENSOR_IO",
          text: text
        });
      });
      return {
        name: "INIT_CONFIG", type: "RLL",
        description: "Runtime configuration generated by L5X Studio: NETS[1].NUM_OF_ZPA_NODES = " + groups.length +
          ", CONFIG_ZPA.ENET_OFFSET = " + ENET_OFFSET + ", CONFIG_ZPA.FIRST_ADDR = " + ENET_FIRST_ADDR +
          ", all zones' NETS[1].ZPA[g].INPUTS.8 = 1 (normal release permission; merge routines override the two upstream zones)" +
          ", per-group NUM_OF_ZONES and SENSOR_IO" +
          ((merges || []).length ? " and 8 s merge blocked-release timer presets" : "") + ". " +
          "The CONFIG_ZPA UDT revision used by the templates has no NUM_OF_ZONES/SENSOR_IO members; those live on the " +
          "per-group ZPA_CONFIG structure and are set there.",
        rungs: rungs
      };
    }
    rungs.push({
      number: 0, type: "N",
      comment: "ENET CONFIG: first ENET word and device-status node",
      text: "MOV(" + ENET_OFFSET + ",CONFIG_ZPA.ENET_OFFSET);" +
        "MOV(" + ENET_FIRST_ADDR + ",CONFIG_ZPA.FIRST_ADDR);"
    });
    return {
      name: "INIT_CONFIG", type: "RLL",
      description: "Runtime configuration generated by L5X Studio (belt mode): CONFIG_ZPA.ENET_OFFSET = " + ENET_OFFSET +
        ", CONFIG_ZPA.FIRST_ADDR = " + ENET_FIRST_ADDR + " used by the group I/O mapping routines.",
      rungs: rungs
    };
  }

  function buildEnetRoutines(templates, groupBlocks, transfers, warnings) {
    const inTpl = templates.routines.ENET_ZPA_INPUTS;
    const outTpl = templates.routines.ENET_ZPA_OUTPUTS;
    if (!inTpl || !inTpl.rungs || inTpl.rungs.length < 2) throw new Error("Template routine ENET_ZPA_INPUTS missing from the template library");
    if (!outTpl || !outTpl.rungs || outTpl.rungs.length < 2) throw new Error("Template routine ENET_ZPA_OUTPUTS missing from the template library");
    function instantiate(tpl, blocks, kind, warnings) {
      const setup = tpl.rungs[0];
      const pattern = tpl.rungs[1].text;
      if (pattern.indexOf("ZPA01") === -1) warnings.push("ENET template pattern for " + kind + " does not contain the expected ZPA01 module reference.");
      const rungs = [{ number: 0, type: "N", comment: setup.comment === undefined ? null : setup.comment, text: setup.text }];
      blocks.forEach(function (block, i) {
        rungs.push({
          number: i + 1, type: "N",
          comment: "ZPA #" + (i + 1) + " " + kind + " (group block " + block.name + ")",
          text: pattern.split("ZPA01").join(block.name)
        });
      });
      return rungs;
    }
    const inRungs = instantiate(inTpl, groupBlocks, "INPUTS", warnings);
    const outRungs = instantiate(outTpl, groupBlocks, "OUTPUTS", warnings);
    (transfers || []).forEach(function (tf) {
      const block = tf.ioBlock;
      inRungs.push({
        number: inRungs.length, type: "N",
        comment: "DEVICE " + block + " INPUTS (" + tf.name + ", " + tf.typeLabel + ") -> " + block +
          "_INPUTS + ENET_INPUTS word + GSV module fault",
        text: "[ADD(ZPA_IO_TMP,1,ZPA_IO_TMP) ,ADD(ZPA_CURR_NODE,1,ZPA_CURR_NODE) ,MOV(" + block + ":I.Data," + block +
          "_INPUTS) ,MOV(" + block + ":I.Data,ENET_INPUTS[ZPA_IO_TMP]) ,GSV(Module," + block +
          ",FaultCode,ENET_DEVICE_STATUS[ZPA_CURR_NODE]) ]"
      });
      outRungs.push({
        number: outRungs.length, type: "N",
        comment: "DEVICE " + block + " OUTPUTS (" + tf.name + ", " + tf.typeLabel + "): " + block +
          "_OUTPUTS -> device block word -> ENET_OUTPUTS word",
        text: "[ADD(ZPA_IO_TMP,1,ZPA_IO_TMP) ,MOV(" + block + "_OUTPUTS," + block + ":O.Data) ,MOV(" + block +
          ":O.Data,ENET_OUTPUTS[ZPA_IO_TMP]) ]"
      });
    });
    const totalWords = groupBlocks.length + (transfers || []).length;
    return {
      inputs: {
        name: "IO_ENET_INPUTS", type: "RLL",
        description: "I/O mapping generated by L5X Studio: copy each ZPAxx 1799ER group input word into ENET_INPUTS " +
          "(and read the module fault code via GSV), then each transfer device block word into XFERnn_INPUTS + a following " +
          "ENET_INPUTS word. " + groupBlocks.length + " zone group block(s) + " + (transfers || []).length +
          " device block(s) = " + totalWords + " ENET words.",
        rungs: inRungs
      },
      outputs: {
        name: "IO_ENET_OUTPUTS", type: "RLL",
        description: "I/O mapping generated by L5X Studio: copy ENET_OUTPUTS words to each ZPAxx 1799ER group output word, " +
          "and each XFERnn_OUTPUTS DINT to its device block output word (ENET word appended after the zone groups). " +
          totalWords + " ENET words.",
        rungs: outRungs
      }
    };
  }

  function buildIoMainRoutine(blocks, hasZpa, warnings) {
    const groupBlocks = (blocks || []).filter(function (b) { return !b.deviceType; });
    const rungs = [];
    rungs.push({ number: 0, type: "N", comment: "READ ZPA MODULE + DEVICE INPUT WORDS INTO ENET_INPUTS", text: "JSR(IO_ENET_INPUTS,0);" });
    if (hasZpa) {
      groupBlocks.forEach(function (block, i) {
        rungs.push({
          number: rungs.length, type: "N",
          comment: "ZPA GROUP " + (i + 1) + " (" + block.name + ") <-> NETS[1].ZPA[" + (i + 1) + "]",
          text: "MOV(ENET_INPUTS[" + (i + ENET_OFFSET) + "],NETS[1].ZPA[" + (i + 1) + "].INPUTS);" +
            "MOV(NETS[1].ZPA[" + (i + 1) + "].OUTPUTS,ENET_OUTPUTS[" + (i + ENET_OFFSET) + "]);"
        });
      });
    }
    rungs.push({ number: rungs.length, type: "N", comment: "WRITE ENET_OUTPUTS TO ZPA MODULE + DEVICE OUTPUT WORDS", text: "JSR(IO_ENET_OUTPUTS,0);" });
    return {
      name: "IO_MAIN", type: "RLL",
      description: "Field I/O mapping chain generated by L5X Studio: " +
        (hasZpa ? "ENET_INPUTS -> NETS[1].ZPA[g].INPUTS, NETS[1].ZPA[g].OUTPUTS -> ENET_OUTPUTS, " : "") +
        "ENET words <-> ZPAxx 1799ER group words and XFERnn device words. CONFIG_ZPA.ENET_OFFSET is " + ENET_OFFSET + " (set by INIT_CONFIG).",
      rungs: rungs
    };
  }

  /* ---------------- tags ---------------- */

  function configZpaInitialData() {
    const zeros10 = "[0,0,0,0,0,0,0,0,0,0]";
    return "[0,0," + zeros10 + "," + zeros10 + "," + ENET_OFFSET + "," + ENET_FIRST_ADDR + ",0,0,0]";
  }

  function buildControllerTagXmls(templates, groups, hasZpa, extraTags, totalWords, warnings) {
    totalWords = totalWords || groups.length;
    const tagMap = {};
    const names = Object.keys(templates.tagTemplates || {}).sort();
    names.forEach(function (name) {
      if (!hasZpa && ["CONFIG_ZPA", "ENET_INPUTS", "ENET_OUTPUTS", "ENET_DEVICE_STATUS"].indexOf(name) === -1) return;
      tagMap[name] = templates.tagTemplates[name];
    });
    if (tagMap.CONFIG_ZPA) tagMap.CONFIG_ZPA = withTagData(tagMap.CONFIG_ZPA, configZpaInitialData());
    if (tagMap.ENET_INPUTS) tagMap.ENET_INPUTS = setTagDimension(tagMap.ENET_INPUTS, totalWords * 2);
    if (tagMap.ENET_OUTPUTS) tagMap.ENET_OUTPUTS = setTagDimension(tagMap.ENET_OUTPUTS, totalWords * 2);
    if (tagMap.ENET_DEVICE_STATUS) tagMap.ENET_DEVICE_STATUS = setTagDimension(tagMap.ENET_DEVICE_STATUS, totalWords + 1);
    (extraTags || []).forEach(function (xml) {
      const name = tagNameOf(xml);
      if (name && !tagMap[name]) tagMap[name] = xml;
    });
    for (const n of ["CONFIG_ZPA", "ENET_INPUTS", "ENET_OUTPUTS", "ENET_DEVICE_STATUS"]) {
      if (!tagMap[n]) warnings.push("Controller tag template missing: " + n + " (generated I/O mapping references it).");
    }
    if (hasZpa) {
      for (const n of ["GFX", "NETS"]) {
        if (!tagMap[n]) warnings.push("Controller tag template missing: " + n + " (ZPA template logic references it).");
      }
      if (!tagMap.ZPA_MERGE) warnings.push("Controller tag template ZPA_MERGE missing (optional merge logic not generated).");
    }
    return Object.keys(tagMap).sort().map(function (n) { return tagMap[n]; });
  }

  function programTagsForRoutines(templates, routines, warnings, extraProgramTags, extraControllerTagNames) {
    const controllerTags = templates.tagTemplates || {};
    const controllerNameSet = {};
    Object.keys(controllerTags).forEach(function (n) { controllerNameSet[n] = true; });
    Object.keys(extraControllerTagNames || {}).forEach(function (n) { controllerNameSet[n] = true; });
    const programTagTemplates = Object.assign({}, templates.programTags || {}, extraProgramTags || {});
    const needed = new Set();
    const missing = {};
    for (const routine of routines) {
      for (const ref of routineTagRefs(routine)) {
        if (controllerNameSet[ref]) continue;
        if (isModuleTagRef(ref)) continue;
        if (programTagTemplates[ref]) { needed.add(ref); continue; }
        missing[ref] = true;
      }
    }
    Object.keys(missing).sort().forEach(function (ref) {
      warnings.push("TAG UNRESOLVED: generated routine references '" + ref +
        "' which is neither a template controller tag nor a declared program tag. Declare it in the target project.");
    });
    return Array.from(needed).sort().map(function (n) { return programTagTemplates[n]; });
  }

  /* ---------------- AOI library embedding ---------------- */

  function selectAoiEntries(templates, requested, warnings) {
    const library = templates.aoiLibrary || [];
    const byName = {};
    for (const entry of library) { byName[entry.name] = entry; byName[String(entry.name).toUpperCase()] = entry; }
    const chosen = [];
    const seen = {};
    for (const name of requested) {
      const entry = byName[name] || byName[String(name).toUpperCase()];
      if (!entry) {
        warnings.push("AOI not found in the extracted library: " + name +
          " (available: " + library.map(function (e) { return e.name; }).join(", ") + ")");
        continue;
      }
      if (seen[entry.name]) continue;
      seen[entry.name] = true;
      chosen.push(entry);
    }
    return chosen;
  }

  function buildAoiSection(templates, requested, warnings) {
    if (!requested || !requested.length) return null;
    const entries = selectAoiEntries(templates, requested, warnings);
    if (!entries.length) return null;
    const dtByName = {}, dtOrder = [], aoiByName = {}, aoiOrder = [];
    function addDataType(xml) {
      const name = dataTypeNameOf(xml);
      if (!name) return;
      if (dtByName[name]) {
        if (dtByName[name] !== xml) warnings.push("AOI data type '" + name + "' appears with different definitions in the library; keeping the first.");
        return;
      }
      dtByName[name] = xml;
      dtOrder.push(name);
    }
    function addAoi(name, xml) {
      if (aoiByName[name]) {
        if (aoiByName[name] !== xml) warnings.push("AOI '" + name + "' appears with different definitions in the library; keeping the first.");
        return;
      }
      aoiByName[name] = xml;
      aoiOrder.push(name);
    }
    for (const entry of entries) {
      for (const xml of (entry.dataTypeXml || [])) addDataType(xml);
      for (const dep of (entry.dependencyAoiXml || [])) addAoi(dep.name, dep.xml);
      addAoi(entry.name, entry.xmlAoi);
    }
    const generatedUdts = templates.udts || {};
    const dataTypes = [];
    for (const name of dtOrder) {
      if (generatedUdts[name]) {
        warnings.push("AOI data type '" + name + "' collides with a generated UDT template; the UDT template is kept.");
        continue;
      }
      dataTypes.push(dtByName[name]);
    }
    return {
      dataTypes: dataTypes, aois: aoiOrder.map(function (n) { return aoiByName[n]; }),
      entries: entries.map(function (e) { return e.name; }), allAoiNames: aoiOrder.slice()
    };
  }

  /* ---------------- document assembly ---------------- */

  function datatypesSection(depth, udtXmls, aoi) {
    const lines = [];
    const seen = {};
    (udtXmls || []).forEach(function (xml) {
      const name = dataTypeNameOf(xml);
      if (name) seen[name] = true;
      lines.push(indentXmlSnippet(xml, depth + 1));
    });
    if (aoi && aoi.dataTypes) for (const xml of aoi.dataTypes) {
      const name = dataTypeNameOf(xml);
      if (name && seen[name]) continue;
      lines.push(indentXmlSnippet(xml, depth + 1));
    }
    return el(depth, "DataTypes", {}, lines);
  }
  function aoiSection(depth, aoi) {
    if (!aoi || !aoi.aois.length) return [];
    return el(depth, "AddOnInstructionDefinitions", {}, aoi.aois.map(function (xml) { return indentXmlSnippet(xml, depth + 1); }));
  }
  function tagSection(depth, tagXmls) {
    return el(depth, "Tags", {}, tagXmls.map(function (xml) { return indentXmlSnippet(xml, depth + 1); }));
  }
  function programSection(depth, programName, mainRoutineName, routines, tagXmls) {
    const children = [];
    children.push.apply(children, tagSection(depth + 1, tagXmls));
    const routineLinesOut = [];
    for (const routine of routines) routineLinesOut.push.apply(routineLinesOut, routineLines(depth + 2, routine));
    children.push(el(depth + 1, "Routines", {}, routineLinesOut));
    return el(depth, "Program", {
      Name: programName, MainRoutineName: mainRoutineName, Type: "Normal",
      Disabled: "false", UseAsFolder: "false"
    }, children);
  }
  function rootOpen(targetType, targetName, containsContext, softwareRevision) {
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
      "<RSLogix5000Content SchemaRevision=\"1.0\" SoftwareRevision=\"" + escAttr(softwareRevision) +
      "\" TargetName=\"" + escAttr(targetName) + "\" TargetType=\"" + escAttr(targetType) +
      "\" ContainsContext=\"" + (containsContext ? "true" : "false") + "\">"
    ];
  }
  function parseSnippet(xml) { return XML.children(XML.parseXml(xml))[0]; }
  function serializeNode(node) { return XML.nodeToXmlString(node, { indent: "" }); }

  function buildModules(templates, design, computed, warnings) {
    const localTpl = templates.localModule;
    const moduleTpl = templates.moduleTemplate;
    if (!localTpl) throw new Error("localModule template missing");
    if (!moduleTpl) throw new Error("moduleTemplate missing");
    const localNode = parseSnippet(localTpl);
    const ctrl = design.controller || {};
    localNode.attrs.Name = "Local";
    localNode.attrs.CatalogNumber = String(ctrl.processorType || localNode.attrs.CatalogNumber || "1756-L83E");
    if (ctrl.majorRev !== undefined && ctrl.majorRev !== null && ctrl.majorRev !== "") localNode.attrs.Major = String(ctrl.majorRev);
    if (ctrl.minorRev !== undefined && ctrl.minorRev !== null && ctrl.minorRev !== "") localNode.attrs.Minor = String(ctrl.minorRev);
    localNode.attrs.ParentModule = "Local";
    localNode.attrs.ParentModPortId = "1";
    localNode.attrs.Inhibited = "false";
    localNode.attrs.MajorFault = "false";
    const ekey = XML.child(localNode, "EKey");
    if (ekey) ekey.attrs.State = "Disabled";
    const moduleXmls = [serializeNode(localNode)];
    computed.blocks.forEach(function (block) {
      const node = parseSnippet(moduleTpl);
      node.attrs.Name = block.name;
      node.attrs.ParentModule = "Local";
      node.attrs.ParentModPortId = "2";
      node.attrs.Inhibited = "false";
      node.attrs.MajorFault = "false";
      const ports = XML.child(node, "Ports");
      let replaced = false;
      if (ports) for (const port of XML.children(ports, "Port")) {
        if (XML.attr(port, "Id") === "2") { port.attrs.Address = block.ip; replaced = true; }
      }
      if (!replaced) warnings.push("Module template has no Ethernet port Id=2; IP " + block.ip + " not applied to " + block.name);
      const comm = XML.child(node, "Communications");
      if (comm) {
        const conns = XML.child(comm, "Connections");
        if (conns) for (const conn of XML.children(conns, "Connection")) {
          if (conn.attrs.RPI) conn.attrs.RPI = "10000";
        }
      }
      moduleXmls.push(serializeNode(node));
    });
    return { moduleXmls: moduleXmls };
  }

  function taskSection(depth, programNames) {
    const scheduled = programNames.map(function (n) { return ind(depth + 2) + "<ScheduledProgram Name=\"" + escAttr(n) + "\"/>"; });
    return el(depth, "Task", { Name: "MainTask", Type: "CONTINUOUS", Priority: "10", Watchdog: "500" },
      el(depth + 1, "ScheduledPrograms", {}, scheduled));
  }

  function udtXmlList(templates, hasZpa, extraUdts) {
    const map = {};
    if (hasZpa) {
      Object.keys(templates.udts || {}).forEach(function (n) { map[n] = templates.udts[n]; });
    } else {
      const zpaUdts = zpaConfigUdts(templates);
      Object.keys(zpaUdts).forEach(function (n) { map[n] = zpaUdts[n]; });
    }
    Object.keys(extraUdts || {}).forEach(function (n) { map[n] = extraUdts[n]; });
    return Object.keys(map).sort().map(function (n) { return map[n]; });
  }

  /* ---------------- public API ---------------- */

  function generateConveyorL5x(design, computed, opts) {
    opts = opts || {};
    const mode = opts.mode === "controller" ? "controller" : "program";
    const warnings = [];
    const t0 = Date.now();
    if (!design || typeof design !== "object") throw new Error("generateConveyorL5x: design object required");
    if (!MODEL.computeDesign) throw new Error("generateConveyorL5x: conveyor model not loaded (L5XStudio.computeDesign missing)");
    const comp = computed || MODEL.computeDesign(design);
    const zones = comp.zones || [];
    const groups = comp.groups || [];
    const blocks = comp.blocks || [];
    const segments = comp.segments || [];
    if (!zones.length || !groups.length) throw new Error("generateConveyorL5x: design has no zones/groups");
    const templates = loadTemplates(opts);
    if (!templates || !templates.routines) {
      throw new Error("generateConveyorL5x: conveyor template library missing " +
        "(js/data/conveyor-templates.js). Run: node tools/extract-conveyor-templates.js");
    }

    /* ---------- AOI library (needed early: belt mode calls Dvc_PF525) ---------- */
    const aoi = buildAoiSection(templates, opts.aois, warnings);
    if (opts.aois && opts.aois.length && !aoi) warnings.push("Requested AOI library entries could not be embedded (see warnings above).");

    /* ---------- roller groups: one template scan routine per group ---------- */
    const segmentsById = {};
    segments.forEach(function (s) { segmentsById[s.id] = s; });
    const rollerGroups = groups.filter(function (g) {
      const seg = segmentsById[g.segmentId];
      return seg && seg.conveyorType !== "belt";
    });
    const hasZpa = rollerGroups.length > 0;
    if (hasZpa && rollerGroups.length !== groups.length) {
      warnings.push((groups.length - rollerGroups.length) + " group(s) belong to belt segments; per-zone ZPA scan logic is generated only for roller groups.");
    }
    if (groups.length > 63) {
      warnings.push("Design has " + groups.length + " ZPA groups but NETS[].ZPA holds 64 (index 0..63); group indices >= 64 are out of range - split the design into multiple networks.");
    }
    const groupRoutines = rollerGroups.map(function (group) { return instantiateGroupRoutine(group, segments, templates, warnings); });

    /* ---------- support routines (roller mode only) ---------- */
    const supportRoutines = [];
    if (hasZpa) {
      for (const name of SUPPORT_ROUTINES) {
        const tpl = templates.routines[name];
        if (!tpl) { warnings.push("Support routine template missing from the library: " + name + " (omitted)."); continue; }
        supportRoutines.push({ name: name, type: "RLL", description: tpl.description, rungs: deepClone(tpl.rungs || []) });
      }
    } else {
      warnings.push("Belt conveyor mode: the SAMPLE_RLL ZPA template support routines are not generated (only the group I/O mapping and drive/tracking logic).");
    }

    /* ---------- belt drives ---------- */
    const belt = buildBeltSection(design, comp, templates, aoi, warnings);

    /* ---------- transfer devices (pusher / rotary table / pop-up) ---------- */
    const deviceSection = buildDeviceSection(design, comp, templates, warnings);

    /* ---------- merge junctions (ZPA spur -> main line; roller mode only) ---------- */
    let mergeSection = null;
    if ((comp.merges || []).length) {
      if (hasZpa) {
        mergeSection = buildMergeSection(comp, warnings);
      } else {
        warnings.push("Merge junction(s) present but the design has no roller (ZPA) groups: merge arbitration routines are not generated in belt mode.");
      }
    }

    /* ---------- tray tracking ---------- */
    const tracking = buildTrackingSection(design, comp, warnings);

    /* ---------- generated routines ---------- */
    const totalWords = groups.length + (deviceSection ? deviceSection.devices.length : 0);
    const initConfig = buildInitConfigRoutine(groups, zones, hasZpa, mergeSection ? mergeSection.merges : [], warnings);
    const groupBlocks = blocks.filter(function (b) { return !b.deviceType; });
    const enet = buildEnetRoutines(templates, groupBlocks, deviceSection ? deviceSection.devices : [], warnings);
    const ioMain = buildIoMainRoutine(blocks, hasZpa, warnings);
    const mainRoutine = buildMainRoutine({
      groupRoutines: groupRoutines,
      beltRoutines: belt ? belt.drives : [],
      mergeRoutines: mergeSection ? mergeSection.merges : [],
      transferRoutines: deviceSection ? deviceSection.devices : [],
      tracking: !!tracking,
      includeIoMain: mode === "program",
      hasZpa: hasZpa
    }, warnings);

    /* ---------- tags ---------- */
    const extraControllerTags = [];
    if (belt) extraControllerTags.push.apply(extraControllerTags, belt.controllerTags);
    if (deviceSection) extraControllerTags.push.apply(extraControllerTags, deviceSection.controllerTags);
    if (mergeSection) extraControllerTags.push.apply(extraControllerTags, mergeSection.controllerTags);
    if (tracking) extraControllerTags.push.apply(extraControllerTags, tracking.controllerTags);
    const extraControllerTagNames = {};
    extraControllerTags.forEach(function (xml) {
      const n = tagNameOf(xml);
      if (n) extraControllerTagNames[n] = true;
    });
    const controllerTagXmls = buildControllerTagXmls(templates, groups, hasZpa, extraControllerTags, totalWords, warnings);

    const extraProgramTags = Object.assign({},
      belt ? belt.programTags : {},
      deviceSection ? deviceSection.programTags : {},
      mergeSection ? mergeSection.programTags : {},
      tracking ? tracking.programTags : {});
    const extraUdts = Object.assign({}, tracking ? tracking.udts : {});
    const udtXmls = udtXmlList(templates, hasZpa, extraUdts);

    const programName = sanitizeName(opts.programName || design.name, "CONVEYOR");
    const controllerName = sanitizeName(opts.controllerName || (design.controller && design.controller.name), "CONVEYOR_PLC");
    const softwareRevision = String(opts.softwareRevision || opts.baseTemplateVersion ||
      (templates.sourceInfo && templates.sourceInfo.sampleRllSoftwareRevision) || "32.03");

    const lines = [];
    const stats = {
      routines: 0, zones: zones.length, groups: groups.length, blocks: blocks.length,
      tags: 0, udts: udtXmls.length, modules: 0, aois: aoi ? aoi.aois.length : 0, schemaErrors: 0,
      conveyorType: comp.conveyorType || design.conveyorType || "roller",
      curvedZones: (comp.totals && comp.totals.curvedZones) || 0,
      spiralRiseM: (comp.totals && comp.totals.spiralRiseM) || 0,
      scanZones: (comp.scannedZones || []).length,
      tracking: !!tracking,
      beltDrives: belt ? belt.drives.length : 0,
      pf525: !!(belt && belt.pf525),
      merges: mergeSection ? mergeSection.merges.length : 0,
      transfers: deviceSection ? deviceSection.devices.length : 0,
      deviceBlocks: deviceSection ? deviceSection.devices.length : 0,
      pushers: deviceSection ? deviceSection.devices.filter(function (d) { return d.type === "pusher"; }).length : 0,
      rotaryTables: deviceSection ? deviceSection.devices.filter(function (d) { return d.type === "rotary_table"; }).length : 0,
      popupTransfers: deviceSection ? deviceSection.devices.filter(function (d) { return d.type === "popup_transfer"; }).length : 0,
      enetWords: totalWords
    };

    if ((design.conveyorType || "roller") === "belt" || (belt && belt.drives.length)) {
      warnings.push("Belt conveyor mode: " + (belt ? belt.drives.length : 0) + " belt drive(s) generated (no per-zone ZPA scan routines). " +
        "Zone sensor group blocks and the ENET I/O mapping are still generated for tracking / diagnostics.");
    }

    if (mode === "program") {
      const allRoutines = [mainRoutine, initConfig, ioMain, enet.inputs, enet.outputs]
        .concat(groupRoutines)
        .concat(belt ? belt.routines : [])
        .concat(mergeSection ? mergeSection.routines : [])
        .concat(deviceSection ? deviceSection.routines : [])
        .concat(tracking ? tracking.routines : [])
        .concat(supportRoutines);
      const programTags = programTagsForRoutines(templates, allRoutines, warnings, extraProgramTags, extraControllerTagNames);
      lines.push.apply(lines, rootOpen("Program", programName, true, softwareRevision));
      const ctrlChildren = [];
      ctrlChildren.push.apply(ctrlChildren, datatypesSection(2, udtXmls, aoi));
      ctrlChildren.push.apply(ctrlChildren, aoiSection(2, aoi));
      ctrlChildren.push.apply(ctrlChildren, tagSection(2, controllerTagXmls));
      ctrlChildren.push.apply(ctrlChildren, el(2, "Programs", {}, programSection(3, programName, "Main", allRoutines, programTags)));
      lines.push.apply(lines, el(1, "Controller", { Use: "Context", Name: controllerName }, ctrlChildren));
      lines.push("</RSLogix5000Content>");
      stats.routines = allRoutines.length;
      stats.tags = controllerTagXmls.length + programTags.length;
      stats.segments = segments.length;
      stats.programTags = programTags.length;
      stats.controllerTags = controllerTagXmls.length;
      const l5x = lines.join("\n") + "\n";
      warnings.push("Program export: module tags (ZPAxx:I.Data / ZPAxx:O.Data / XFERnn:I.Data / XFERnn:O.Data) must already exist " +
        "in the target controller. Use the controller-mode export (or the BOM I/O list) to create the " + blocks.length +
        " 1799ER module(s) (zone groups + transfer devices) first.");
      warnings.push("Program scope: " + programName + " - Main calls INIT_CONFIG" +
        (tracking ? ", TRACK_INIT" : "") + (hasZpa ? ", the ZPA_MAPPING FOR loop and " + groupRoutines.length + " group scan routine(s)" : "") +
        (belt ? ", " + belt.drives.length + " belt drive routine(s)" : "") +
        (mergeSection ? ", " + mergeSection.merges.length + " merge routine(s)" : "") +
        (deviceSection ? ", " + deviceSection.devices.length + " transfer device routine(s)" : "") +
        (tracking ? ", TRACK_MOVE/TRACK_SCAN/TRACK_CLEAR" : "") + ".");
      finishWarnings(warnings, comp, design, templates, hasZpa, belt, tracking, aoi, deviceSection, mergeSection);
      return finish(l5x, warnings, stats, mode, programName, t0);
    }

    /* ------------------------------ controller mode ------------------------------ */
    const designRoutines = [mainRoutine, initConfig]
      .concat(groupRoutines)
      .concat(belt ? belt.routines : [])
      .concat(mergeSection ? mergeSection.routines : [])
      .concat(deviceSection ? deviceSection.routines : [])
      .concat(tracking ? tracking.routines : [])
      .concat(supportRoutines);
    const ioProgramRoutines = [{
      name: "MAIN", type: "RLL",
      description: "IO_MASTER_MAPPER main generated by L5X Studio: read the ZPA group block words into ENET_INPUTS, then write ENET_OUTPUTS to the blocks.",
      rungs: [
        { number: 0, type: "N", comment: "READ ZPA GROUP INPUT WORDS", text: "JSR(IO_ENET_INPUTS,0);" },
        { number: 1, type: "N", comment: "WRITE ZPA GROUP OUTPUT WORDS", text: "JSR(IO_ENET_OUTPUTS,0);" }
      ]
    }, enet.inputs, enet.outputs];
    const designProgramTags = programTagsForRoutines(templates, designRoutines, warnings, extraProgramTags, extraControllerTagNames);
    const ioProgramTags = programTagsForRoutines(templates, ioProgramRoutines, warnings, {}, extraControllerTagNames);
    const modules = buildModules(templates, design, comp, warnings);

    lines.push.apply(lines, rootOpen("Controller", controllerName, false, softwareRevision));
    const ctrlChildren = [];
    ctrlChildren.push.apply(ctrlChildren, datatypesSection(2, udtXmls, aoi));
    ctrlChildren.push.apply(ctrlChildren, el(2, "Modules", {}, modules.moduleXmls.map(function (xml) { return indentXmlSnippet(xml, 3); })));
    ctrlChildren.push.apply(ctrlChildren, aoiSection(2, aoi));
    ctrlChildren.push.apply(ctrlChildren, tagSection(2, controllerTagXmls));
    const programsLines = [];
    programsLines.push.apply(programsLines, programSection(3, programName, "Main", designRoutines, designProgramTags));
    programsLines.push.apply(programsLines, programSection(3, "IO_MASTER_MAPPER", "MAIN", ioProgramRoutines, ioProgramTags));
    ctrlChildren.push.apply(ctrlChildren, el(2, "Programs", {}, programsLines));
    ctrlChildren.push.apply(ctrlChildren, el(2, "Tasks", {}, taskSection(3, ["IO_MASTER_MAPPER", programName])));
    const controllerAttrs = {
      Use: "Target", Name: controllerName,
      ProcessorType: String((design.controller && design.controller.processorType) ||
        (templates.localModule && /CatalogNumber="([^"]+)"/.exec(templates.localModule) || [])[1] || "1756-L83E"),
      MajorRev: String((design.controller && design.controller.majorRev) || "32"),
      MinorRev: String((design.controller && design.controller.minorRev) || "14")
    };
    lines.push.apply(lines, el(1, "Controller", controllerAttrs, ctrlChildren));
    lines.push("</RSLogix5000Content>");

    stats.routines = designRoutines.length + ioProgramRoutines.length;
    stats.tags = controllerTagXmls.length + designProgramTags.length + ioProgramTags.length;
    stats.modules = modules.moduleXmls.length;
    stats.segments = segments.length;
    stats.programs = 2;
    stats.task = "MainTask";
    stats.controllerTags = controllerTagXmls.length;
    const l5x = lines.join("\n") + "\n";
    warnings.push("Controller export: Local module cloned from SAMPLE_RLL (" +
      (design.controller && design.controller.processorType || "1756-L83E") + "); " + blocks.length +
      " " + MODULE_CATALOG + " module(s) created for " + groups.length + " zone group(s) + " +
      (deviceSection ? deviceSection.devices.length : 0) + " transfer device block(s) (ParentModule=Local port 2, RPI 10 ms).");
    warnings.push("Task MainTask (CONTINUOUS, priority 10, watchdog 500 ms) schedules IO_MASTER_MAPPER then " + programName + ".");
    warnings.push("IO_MASTER_MAPPER runs before the conveyor program, so the ZPAxx:O / XFERnn:O output words are written with a " +
      "one-scan latency; add a second JSR(IO_ENET_OUTPUTS) at the end of the conveyor program if outputs must be current in the same scan.");
    finishWarnings(warnings, comp, design, templates, hasZpa, belt, tracking, aoi, deviceSection, mergeSection);
    return finish(l5x, warnings, stats, mode, programName, t0);
  }

  function finishWarnings(warnings, comp, design, templates, hasZpa, belt, tracking, aoi, deviceSection, mergeSection) {
    const totals = comp.totals || {};
    const segments = comp.segments || [];
    if (hasZpa) {
      warnings.push("ZPA groups: " + totals.groups + " group(s) for " + totals.zones + " zone(s); one 1799ER group block and one " +
        "NETS[1].ZPA[g] instance per group. Each scan routine is instantiated from ZPA1_<n>ZONE_SCAN_ZONE with ZPA[1] -> " +
        "ZPA[<group slot>]; the timer/status array slots stay 1..n (zone-within-group) as required by the SAMPLE_RLL templates.");
      warnings.push("Group I/O words: input bits 0..7 are the 8 zone sensors of the group, output bits 0..7 the zone run " +
        "commands; remaining bits are group handshakes handled by the template logic. Cross-group/cross-segment handshake " +
        "wiring (ZPA.INPUTS.8 / OUTPUTS.8) is template-level and is NOT generated.");
      warnings.push("INIT_CONFIG sets NETS[1].NUM_OF_ZPA_NODES=" + (comp.groups || []).length + ", CONFIG_ZPA.ENET_OFFSET=" + ENET_OFFSET +
        ", CONFIG_ZPA.FIRST_ADDR=" + ENET_FIRST_ADDR + ", all zones' NETS[1].ZPA[g].INPUTS.8 = 1 (normal release permission; merge " +
        "routines override the two upstream zones) and per-group NETS[1].ZPA[g].CONFIG.NUM_OF_ZONES/SENSOR_IO. " +
        "The CONFIG_ZPA UDT revision used by the templates has no NUM_OF_ZONES/SENSOR_IO members, so the zone metadata is " +
        "written on the ZPA_CONFIG structure it actually exists on.");
    }
    if (totals.curvedZones) {
      const curves = segments.filter(function (s) { return s.kind === "curve"; });
      const tapers = [];
      curves.forEach(function (s) {
        if (s.taper && s.taper.standardId && tapers.indexOf(s.taper.standardId) === -1) tapers.push(s.taper.standardId);
      });
      warnings.push("Curved geometry: " + totals.curvedZones + " curved zone(s) in " + curves.length + " curve segment(s)" +
        (tapers.length ? ", standardised tapered rollers: " + tapers.join(", ") : "") +
        ". Curve radius / taper standard are recorded in the scan routine descriptions and Main rung comments " +
        "(plus computed.totals.taperedRollerCount=" + (totals.taperedRollerCount || 0) + ").");
    }
    const spirals = segments.filter(function (s) { return s.kind === "spiral"; });
    if (spirals.length) {
      warnings.push("Spiral geometry: " + spirals.length + " spiral segment(s), total rise " + totals.spiralRiseM + " m; " +
        spirals.map(function (s) {
          return s.name + " " + (s.spiral ? s.spiral.direction + " pitch " + s.spiral.pitchM + " m / height " + s.spiral.heightM +
            " m / slope " + s.spiral.slopeDeg + " deg" : "spiral");
        }).join("; ") + ". Pitch/height/direction are recorded in the scan routine descriptions and Main rung comments.");
      warnings.push("Spiral zone counts follow the helix length (" + totals.zones + " zones in " + totals.groups +
        " group(s) for this design); the generator creates one scan routine per group (no per-zone routines).");
    }
    if (totals.roundedJoints) {
      warnings.push("Rounded joints: " + totals.roundedJoints + " angled joint(s) with rounded outer edges (fillet radius = half width).");
    }
    if (belt) {
      warnings.push("Belt drive(s): " + belt.drives.length + ". RUN_CMD latch with SAFETY_OK and DRIVE_FAULT interlocks; " +
        "SAFETY_OK must be driven by the safety circuit (or forced for commissioning)." + (belt.pf525 ? " Dvc_PF525 embedded and called." : ""));
    }
    if (tracking) {
      const ti = tracking.info;
      warnings.push("Tray tracking: TRAY_TRACK UDT (Barcode STRING_" + ti.barcodeLen + ", Zone, Seq, Valid, Timestamp), " +
        "TRACK_TBL[" + ti.maxTrays + "], TRACK_COUNT, TRACK_RESET + " + ti.scanZones + " scanner tag pair(s); routines TRACK_INIT/" +
        "TRACK_SCAN/TRACK_MOVE/TRACK_CLEAR are authored in ST and converted to ladder with L5XStudio.stToLad.");
      warnings.push("Scanner interface: <SCAN>_BARCODE / <SCAN>_GOOD_READ must be populated by the external scanner (MSG/CIP) " +
        "interface - no MSG instruction is generated. Suggested spare input bits: " + ti.spareBits.join("; ") + ".");
      warnings.push("TRACK_TBL.Timestamp is written as 0; add a GSV(WallClockTime) / time source if real timestamps are required. " +
        "TRACK_RESET is the HMI/stop-reset request that clears the table.");
      if (ti.scanZones === 0) warnings.push("No scan zones are defined: TRACK_SCAN has no barcode writes (tracking table stays empty).");
    }
    if (mergeSection && mergeSection.merges.length) {
      warnings.push("Merge junctions: " + mergeSection.merges.length + " generated (priority alternating/main/spur release arbitration). " +
        "Each MERGE_<name> routine reads both upstream zones' sensors and the merge-zone entry sensor, then grants release by setting " +
        "the granted upstream zone's NETS[1].ZPA[g].INPUTS.8 = 1 and the other = 0 (templates consume it next scan). " +
        "A grant that stays blocked for 8 s is swapped to the other upstream zone.");
      mergeSection.merges.forEach(function (m) {
        warnings.push("MERGE " + m.name + ": priority " + m.priority + ", merge zone " + m.mergeZone + " (block " + m.mergeBlock +
          "), main upstream zone " + m.mainZone + ", spur last zone " + m.spurZone + (m.gapM !== null ? ", spur gap " + m.gapM + " m" : "") +
          " - grant tags " + m.mainGrantTag + " / " + m.spurGrantTag + ".");
      });
      warnings.push("Merge grant writes to NETS[1].ZPA[g].INPUTS.8 happen AFTER the ZPA group scans (as instructed), so they are " +
        "consumed by the next scan; ZPA_MAPPING rewrites INPUTS from the ENET words at the start of each scan.");
    }
    if (deviceSection && deviceSection.devices.length) {
      const devs = deviceSection.devices;
      warnings.push("Transfer devices: " + devs.length + " device block(s) " + devs.map(function (d) { return d.ioBlock + "(" + d.type + ")"; }).join(", ") +
        "; one 1799ER block each, names XFERnn, IPs sequential after the ZPA group blocks. I/O mapped into XFERnn_INPUTS/XFERnn_OUTPUTS " +
        "DINT tags and appended ENET_INPUTS/OUTPUTS words, with per-bit BOOL alias tags (e.g. PUSHER1_EXTENDED_SW, PUSHER1_EXTEND_SOL). " +
        "Control routines PUSHER_<name>/ROTARY_<name>/POPUP_<name> are authored in ST and converted to ladder with L5XStudio.stToLad.");
      warnings.push("Device ENET word allocation: zone groups use ENET words 1.." + (comp.groups || []).length + "; device blocks use words " +
        ((comp.groups || []).length + 1) + ".." + ((comp.groups || []).length + devs.length) + " (ENET arrays are dimensioned with headroom, " +
        "ENET_DEVICE_STATUS includes the device nodes). Status/fault tags: " + devs.map(function (d) { return d.statusTag + "/" + d.faultTag; }).join(", ") + ".");
      devs.forEach(function (d) {
        if (d.type === "pusher") {
          warnings.push("PUSHER " + d.name + ": ONE-WAY divert (extend on tray present + downstream clear, latch until extended switch, " +
            "retract; extend/retract jam fault). There is no reverse divert path by design.");
        } else if (d.type === "rotary_table") {
          warnings.push("ROTARY " + d.name + ": BIDIRECTIONAL router - rotate request tag " + d.cmdTags[0] + ", destination tag " +
            "XFER_DEST_" + sanitizeName(d.name) + " (route logic/HMI writes it), current position status " + d.posTag +
            "; direction chosen by shortest path (CW/CCW), brake release + rotate timeout fault.");
        } else {
          warnings.push("POPUP " + d.name + ": BIDIRECTIONAL cross transfer - command tags " + d.cmdTags.join(" / ") +
            "; raise until POPUP_UP_SW, BELT_LEFT/BELT_RIGHT until tray gone, lower/interlocks LEFT_CLEAR/RIGHT_CLEAR, jam timers/faults.");
        }
      });
    }
    if (aoi) {
      warnings.push("AOI library embedded: " + aoi.entries.join(", ") +
        " (+ dependent AOIs: " + aoi.allAoiNames.join(", ") + "). Review revision conflicts before importing into a project " +
        "that already defines these AOIs.");
      if (hasZpa) {
        warnings.push("AOI definitions in a Program-context export are only imported if the target project does not already define them.");
      }
    }
    warnings.push("Templates: " + (templates.meta && templates.meta.extractionDate ? "extracted " + templates.meta.extractionDate : "library") +
      ", SAMPLE_RLL software revision " + ((templates.sourceInfo && templates.sourceInfo.sampleRllSoftwareRevision) || "?") + ".");
  }

  function finish(l5x, warnings, stats, mode, programName, t0) {
    stats.generatorVersion = GENERATOR_VERSION;
    stats.mode = mode;
    stats.programName = programName;
    stats.sizeBytes = utf8Length(l5x);
    stats.generationMs = Date.now() - t0;
    let parsed = null;
    let schemaErrors = 0;
    try {
      const L5X = NODE ? require("../l5x-model.js") : (root.L5XStudio || {});
      const SV = NODE ? require("../schema-validate.js") : (root.L5XStudio || {});
      if (L5X && typeof L5X.parseL5X === "function") {
        parsed = L5X.parseL5X(l5x);
        if (SV && typeof SV.validateModel === "function") {
          const vr = SV.validateModel(parsed, {});
          schemaErrors = (vr.errors || []).length;
          stats.schemaErrors = schemaErrors;
          stats.schemaWarnings = (vr.warnings || []).length;
          stats.schemaVersion = vr.schemaVersion || null;
          for (const issue of (vr.errors || []).slice(0, 40)) {
            warnings.push("SCHEMA: " + (issue.path || "") + " [" + issue.code + "] " + issue.message);
          }
        }
      }
    } catch (e) {
      warnings.push("SCHEMA: generated L5X could not be re-parsed/validated: " + (e && e.message || e));
    }
    const safeName = sanitizeName(programName, "CONVEYOR");
    const files = {};
    files[safeName + (mode === "controller" ? "-controller" : "") + ".L5X"] = l5x;
    stats.parsedPrograms = parsed ? parsed.programs.length : 0;
    return { ok: schemaErrors === 0, l5x: l5x, warnings: warnings, stats: stats, files: files };
  }

  return {
    generateConveyorL5x: generateConveyorL5x,
    GENERATOR_VERSION: GENERATOR_VERSION,
    SUPPORT_ROUTINES: SUPPORT_ROUTINES,
    ENET_OFFSET: ENET_OFFSET,
    ENET_FIRST_ADDR: ENET_FIRST_ADDR,
    remapGroupText: remapGroupText,
    selectZoneTemplate: selectZoneTemplate,
    loadTemplates: loadTemplates
  };
});
