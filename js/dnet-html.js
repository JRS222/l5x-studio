/* L5X Studio — RSNetWorx HTML report parser: DeviceNet node logic + local-logic cross reference.
 *
 * RSNetWorx "File → Print/Export to HTML" produces a device report. Each configurable device page
 * carries parameter tables and a **Logic** table with columns `Seq No | Attributes | Bound to`
 * (the card's ladder logic ported to a function-block rendition). The EDS applet plugin storage
 * (inside the .dnt) carries the user tag names and local-logic I/O aliases used by that logic:
 *
 *   CFbIDofTag:  Latch_1 -> FB 1,  Timer_5 -> FB 19, ...
 *   aliases:     "ZONE 1 PE" -> DIP.8 (device input),  "Out-of-Service from GFX" -> CNB.10
 *                (consumed network bit),  "%Tray Present ..." -> PNB.1 (produced network bit),
 *                "Run Zone 1 Motor" -> DOP.8 (device output)
 *
 * The module parses all of it, annotates the function blocks with their configured labels and
 * renders the logic as a layered FBD drawing plus ST / ladder renditions.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ HTML helpers */
  function decodeEntities(s) {
    return String(s || "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  function textOf(html) {
    return decodeEntities(String(html || "")
      .replace(/<BR\s*\/?>/gi, "\n")
      .replace(/<SMALL>/gi, "").replace(/<\/SMALL>/gi, "")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").trim();
  }
  function oneLine(html) { return textOf(html).replace(/\s+/g, " ").trim(); }
  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function isRsnetHtml(text) {
    return typeof text === "string" && /RSNetWorx for DeviceNet/i.test(text) && /DEVICE_TITLE/.test(text);
  }
  function rowCells(rowHtml) {
    const cells = [];
    const re = /<T[HD][^>]*>([\s\S]*?)(?=<T[HD][^>]*>|<\/TR>|<\/TABLE>)/gi;
    let m;
    while ((m = re.exec(rowHtml))) cells.push(m[1]);
    return cells;
  }

  /* ------------------------------------------------------------------ report parsing */
  function parseKeyValueTable(tableHtml) {
    const out = {};
    for (const row of (tableHtml.match(/<TR[\s\S]*?<\/TR>/gi) || [])) {
      const cells = rowCells(row);
      if (cells.length < 2) continue;
      out[oneLine(cells[0]).replace(/:$/, "")] = textOf(cells[1]);
    }
    return out;
  }
  function parseAttributes(cellHtml) {
    const blocks = String(cellHtml || "").split(/<BR\s*\/?>/i);
    const type = oneLine(blocks[0] || "").replace(/\s+/g, " ").trim();
    const params = [];
    for (let i = 1; i < blocks.length; i++) {
      const line = oneLine(blocks[i]);
      if (!line) continue;
      const m = /^([A-Za-z][A-Za-z0-9 /()-]*?):\s*(.*)$/.exec(line);
      if (m) params.push({ name: m[1].trim(), value: m[2].trim() });
    }
    return { type: type, params: params };
  }
  function parseBindings(cellHtml) {
    const out = [];
    for (const raw of String(cellHtml || "").split(/<BR\s*\/?>/i)) {
      if (!raw || !raw.trim()) continue;
      const complement = /\(complement\)/i.test(raw);
      const line = oneLine(raw.replace(/\(complement\)/gi, " "));
      if (!line) continue;
      const m = /^(.*?):\s*Function Block\s+(\d+)\s*(?:\(([^)]*)\))?/i.exec(line);
      if (m) {
        out.push({ input: m[1].trim() || "Input", complement: complement, targetSeq: parseInt(m[2], 10), targetType: (m[3] || "").trim() || null, external: false });
      } else {
        out.push({ input: line, complement: complement, targetSeq: null, targetType: null, external: true });
      }
    }
    return out;
  }
  function parseLogicTable(tableHtml) {
    const blocks = [];
    for (const row of (tableHtml.match(/<TR[\s\S]*?<\/TR>/gi) || [])) {
      const cells = rowCells(row);
      if (cells.length < 2) continue;
      const seqText = oneLine(cells[0]).replace(/[^0-9]/g, "");
      if (!seqText) continue;
      const seq = parseInt(seqText, 10);
      if (isNaN(seq)) continue;
      const attr = parseAttributes(cells[1]);
      if (!attr.type) continue;
      const bindings = parseBindings(cells[2] || "");
      blocks.push({ seq: seq, type: attr.type, params: attr.params, bindings: bindings });
    }
    blocks.sort(function (a, b) { return a.seq - b.seq; });
    const bySeq = {};
    for (const b of blocks) bySeq[b.seq] = b;
    return { blocks: blocks, bySeq: bySeq, count: blocks.length };
  }
  function parseDeviceParameters(sectionHtml) {
    const out = [];
    for (const t of (sectionHtml.match(/<TABLE[^>]*>[\s\S]*?<\/TABLE>/gi) || [])) {
      if (!/Parameter Name/i.test(t)) continue;
      for (const row of (t.match(/<TR[\s\S]*?<\/TR>/gi) || [])) {
        const cells = rowCells(row);
        if (cells.length < 3) continue;
        const inst = oneLine(cells[0]);
        if (!/^\d+$/.test(inst)) continue;
        out.push({ instance: parseInt(inst, 10), name: oneLine(cells[1]), value: textOf(cells[2]) });
      }
    }
    return out;
  }
  function parseRsnetHtml(text, opts) {
    opts = opts || {};
    if (!isRsnetHtml(text)) throw new Error("not an RSNetWorx DeviceNet HTML report");
    const parsed = { fileName: opts.fileName || null, dntFileName: null, networkName: null, devices: [], warnings: [] };
    const fileRow = /<td id="TABLE_TITLE">Filename:<\/td><td id="TABLE_TEXT">([\s\S]*?)<\/td>/i.exec(text);
    if (fileRow) parsed.dntFileName = oneLine(fileRow[1]);
    const netRow = /<div id="REPORT_HEADING1">Network Properties<\/div>[\s\S]*?<td id="TABLE_TITLE">Name:<\/td><td id="TABLE_TEXT">([\s\S]*?)<\/td>/i.exec(text);
    if (netRow) parsed.networkName = oneLine(netRow[1]);
    const sections = text.split(/(?=<div id="DEVICE_TITLE">)/).slice(1);
    for (const section of sections) {
      const titleDiv = /<div id="DEVICE_TITLE">([\s\S]*?)<\/div>/i.exec(section);
      const titleInner = titleDiv ? titleDiv[1] : "";
      const anchorMatch = /<a NAME="([^"]+)"/i.exec(titleInner) || /<a NAME="([^"]+)"/i.exec(section);
      const anchor = anchorMatch ? anchorMatch[1] : "";
      const title = oneLine(titleInner) || anchor;
      const addrMatch = /Address\s+(\d+)\s*,?\s*(.*)$/i.exec(anchor || title);
      if (!addrMatch) continue;
      const address = parseInt(addrMatch[1], 10);
      const device = {
        address: address, macId: address, name: addrMatch[2].trim() || title, title: title,
        fields: {}, parameters: [], logic: null, noLogic: false
      };
      const headEnd = section.search(/<TH[^>]*>\s*Instance/i);
      const headPart = headEnd > 0 ? section.slice(0, headEnd) : section;
      for (const t of (headPart.match(/<TABLE[^>]*>[\s\S]*?<\/TABLE>/gi) || [])) Object.assign(device.fields, parseKeyValueTable(t));
      if (device.fields["Name"]) device.name = device.fields["Name"];
      const typeText = device.fields["Type"] || "";
      const cat = /^([0-9A-Za-z-]+)/.exec(typeText);
      device.catalogNumber = device.fields["Catalog"] || (cat ? cat[1] : null);
      device.description = device.fields["Description"] || null;
      device.parameters = parseDeviceParameters(section);
      const logicTable = (section.match(/<TABLE[^>]*>[\s\S]*?<\/TABLE>/gi) || [])
        .find(function (t) { return /Seq No/i.test(t) && /Attributes/i.test(t) && /Bound to/i.test(t); });
      if (logicTable) device.logic = parseLogicTable(logicTable);
      else if (/No logic found/i.test(section)) device.noLogic = true;
      parsed.devices.push(device);
    }
    if (!parsed.devices.length) throw new Error("no device sections found in the HTML report");
    const withLogic = parsed.devices.filter(function (d) { return d.logic && d.logic.count; });
    parsed.summary = {
      devices: parsed.devices.length,
      devicesWithLogic: withLogic.length,
      blocks: withLogic.reduce(function (n, d) { return n + d.logic.count; }, 0)
    };
    return parsed;
  }

  /* ------------------------------------------------------------------ local labels */
  const TAG_RE = /^(Latch|Timer|Counter)_(\d+)$/;
  const ADDR_RE = /^(DIP|DOP|CNB|PNB|CIP|POP)\.(\d+)$/;
  const VALUE_RE = /^(-?\d+(?:\.\d+)?|\d+ ms)$/;
  const NOISE = { "DeviceNet": 1, "Preset": 1, "Timebase": 1, "Accumulator": 1, "ms": 1 };
  const ADDR_KIND = {
    DIP: "device input point", DOP: "device output point",
    CNB: "consumed network bit", PNB: "produced network bit",
    CIP: "consumed input point", POP: "produced output point"
  };
  function classifyAddress(addr) {
    const m = ADDR_RE.exec(addr);
    if (!m) return null;
    return { prefix: m[1], offset: parseInt(m[2], 10), kind: ADDR_KIND[m[1]] || "I/O reference" };
  }
  function isClassMarker(s) {
    if (!s || /\s/.test(s)) return false;
    if (/^C[A-Z][A-Za-z0-9]{2,}$/.test(s)) return true;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && /(Instr|Logic|Element|Operand|Object|Block|Data|Config|Tag|Class|Def)/i.test(s);
  }
  function isGenericLabel(s) {
    return /^Network (Input|Output) \d+$/.test(s) || /^Zone Data \(/.test(s) ||
      /^Input \d+$/.test(s) || /^Output \d+$/.test(s) || /^\d+ Zone$/.test(s) || /^Zone Data$/.test(s);
  }
  function looksDescriptive(s) {
    if (!s) return false;
    if (TAG_RE.test(s) || ADDR_RE.test(s) || VALUE_RE.test(s)) return false;
    if (NOISE[s] || s === "DeviceNet" || isClassMarker(s) || isGenericLabel(s)) return false;
    return /[A-Za-z]{2}/.test(s);
  }
  function cleanLabel(s) {
    return String(s || "").replace(/^[\s"']+/, "").replace(/[\s"']+$/, "").trim();
  }

  function parseLocalLabels(pluginStrings, tagMap) {
    const strings = (pluginStrings || []).slice();
    const tagToSeq = {};
    for (const t of (tagMap || [])) if (t && t.name) tagToSeq[t.name] = t.seq;
    const aliases = [];
    const blockTags = {};
    const seenAlias = {};
    let currentTag = null;
    let lastDescriptive = null;
    let lastDescriptiveIdx = -1;
    function ensureTag(tag) {
      if (!blockTags[tag]) blockTags[tag] = { tag: tag, seq: tagToSeq[tag] || null, description: null, inputLabels: [] };
      return blockTags[tag];
    }
    for (let i = 0; i < strings.length; i++) {
      const s = strings[i];
      if (!s || isClassMarker(s)) continue;
      if (TAG_RE.test(s)) {
        const bt = ensureTag(s);
        currentTag = s;
        if (!bt.description && lastDescriptive && lastDescriptiveIdx >= i - 3) bt.description = cleanLabel(lastDescriptive);
        lastDescriptive = null; lastDescriptiveIdx = -1;
        continue;
      }
      if (ADDR_RE.test(s)) {
        let network = false, label = null;
        for (let back = i - 1; back >= 0 && back >= i - 3; back--) {
          const t = strings[back];
          if (!t) continue;
          if (t === "DeviceNet") { network = true; continue; }
          if (isClassMarker(t) || NOISE[t] || VALUE_RE.test(t) || TAG_RE.test(t) || ADDR_RE.test(t) || isGenericLabel(t)) break;
          if (looksDescriptive(t)) { label = cleanLabel(t); break; }
        }
        if (label && !seenAlias[label + "|" + s]) {
          seenAlias[label + "|" + s] = 1;
          const info = classifyAddress(s);
          aliases.push({ label: label, address: s, prefix: info.prefix, offset: info.offset, kind: info.kind, network: network });
        }
        lastDescriptive = null; lastDescriptiveIdx = -1;
        continue;
      }
      if (VALUE_RE.test(s) || NOISE[s] || s === "DeviceNet" || isGenericLabel(s) || !looksDescriptive(s)) continue;
      const nextSig = strings[i + 1];
      const nextIsAddr = nextSig && ADDR_RE.test(nextSig);
      const nextIsTag = nextSig && TAG_RE.test(nextSig);
      if (currentTag && !nextIsAddr && !nextIsTag) {
        const bt = ensureTag(currentTag);
        const lab = cleanLabel(s);
        if (lab && bt.inputLabels.indexOf(lab) === -1 && bt.inputLabels.length < 6) bt.inputLabels.push(lab);
      }
      if (!nextIsAddr || nextIsTag) { lastDescriptive = s; lastDescriptiveIdx = i; }
    }
    return { aliases: aliases, blockTags: blockTags, tagToSeq: tagToSeq };
  }

  function annotateLogic(device, local) {
    if (!device || !device.logic || !local) return device;
    device.localAliases = local.aliases || [];
    const bySeq = {};
    for (const tagName of Object.keys(local.blockTags || {})) {
      const bt = local.blockTags[tagName];
      if (bt && bt.seq) bySeq[bt.seq] = bt;
    }
    let named = 0;
    for (const b of (device.logic.blocks || [])) {
      const match = bySeq[b.seq];
      if (!match) continue;
      b.tag = match.tag;
      b.description = match.description || match.tag;
      if ((match.inputLabels || []).length) b.inputLabels = match.inputLabels.slice(0, 4);
      named++;
    }
    device.logic.namedBlocks = named;
    return device;
  }

  /* ------------------------------------------------------------------ input slots */
  function safeIdent(s) { return String(s || "").replace(/[^A-Za-z0-9_]/g, "_"); }
  function inputIndex(name, fallback) {
    const n = String(name || "").toLowerCase();
    if (/reset/.test(n)) return 1;
    const m = /(\d+)/.exec(n);
    if (m) return Math.max(0, parseInt(m[1], 10) - 1);
    if (/^input$/i.test(name)) return 0;
    return fallback;
  }
  function blockSlotCount(b) {
    const t = String(b.type || "").toUpperCase();
    const maxBound = (b.bindings || []).reduce(function (m, e, i) { return Math.max(m, inputIndex(e.input, i)); }, -1);
    if (t === "AND" || t === "OR" || t === "SR LATCH" || t === "RS LATCH" || t === "UP COUNTER" || t === "DOWN COUNTER") return Math.max(2, maxBound + 1);
    if (/TIMER/.test(t)) return 1;
    return Math.max(1, (b.bindings || []).length);
  }
  function inputSlots(b) {
    const slots = blockSlotCount(b);
    const out = [];
    for (let i = 0; i < slots; i++) out.push({ index: i, bound: null });
    (b.bindings || []).forEach(function (e, i) {
      const idx = inputIndex(e.input, i);
      if (idx >= 0 && idx < slots) out[idx].bound = e;
      else out.push({ index: slots, bound: e });
    });
    return out;
  }
  function slotLabel(b, slot) {
    const labels = b.inputLabels || [];
    if (labels[slot.index]) return cleanLabel(labels[slot.index]);
    if (labels.length === 1) return cleanLabel(labels[0]);
    return "IO" + b.seq + "_" + (slot.index + 1);
  }
  function slotSource(b, slot) {
    if (slot.bound && slot.bound.targetSeq) return "FB" + slot.bound.targetSeq;
    return slotLabel(b, slot);
  }
  function slotTerm(b, slot) {
    return ((slot.bound && slot.bound.complement) ? "XIO(" : "XIC(") + safeIdent(slotSource(b, slot)) + ")";
  }
  function blockTag(b) { return safeIdent(b.tag || ("FB" + b.seq)); }
  function blockComment(b) {
    let s = "";
    if (b.tag && b.description) s = b.tag + " \u2014 " + b.description;
    else s = b.tag || b.description || "";
    return s ? "   // " + String(s).replace(/\n/g, " ") : "";
  }

  /* ------------------------------------------------------------------ conversions */
  function logicToSt(device) {
    const lines = [];
    lines.push("// DeviceNet device logic \u2014 " + (device.name || "device") + " (MAC " + device.macId + ")");
    lines.push("// Source: RSNetWorx function-block (FBD) rendition of the card's ladder logic.");
    lines.push("// Configured labels come from the card's local-logic configuration (inferred).");
    lines.push("");
    for (const b of (device.logic ? device.logic.blocks : [])) {
      const t = String(b.type || "").toUpperCase();
      const tag = blockTag(b);
      const params = (b.params || []).map(function (p) { return p.value; });
      const slots = inputSlots(b);
      const srcs = slots.map(function (sl) {
        const src = slotSource(b, sl);
        return (sl.bound && sl.bound.complement) ? "NOT " + src : src;
      });
      let expr;
      if (t === "AND") expr = srcs.join(" AND ");
      else if (t === "OR") expr = srcs.join(" OR ");
      else if (t === "SR LATCH" || t === "RS LATCH") expr = t.replace(" ", "_") + "(" + (srcs[0] || "FALSE") + ", " + (srcs[1] || "FALSE") + ")";
      else if (t === "ON DELAY TIMER") expr = "TON(" + (srcs[0] || "FALSE") + ", " + (params[0] || "0") + ", " + (params[1] || "10 ms") + ")";
      else if (t === "OFF DELAY TIMER") expr = "TOF(" + (srcs[0] || "FALSE") + ", " + (params[0] || "0") + ", " + (params[1] || "10 ms") + ")";
      else if (t === "PULSE TIMER") expr = "TP(" + (srcs[0] || "FALSE") + ", " + (params[0] || "0") + ", " + (params[1] || "10 ms") + ")";
      else if (t === "UP COUNTER") expr = "CTU(" + (srcs[0] || "FALSE") + ", " + (params[0] || "0") + ")";
      else expr = tag;
      lines.push(tag + " := " + expr + ";" + blockComment(b));
    }
    return lines.join("\n") + "\n";
  }

  /* readable ladder rendition: boolean blocks become rung condition networks (series for AND,
     parallel branches for OR) with an output instruction; latches/timers/counters are instruction
     lines. Complete and inspectable, but not byte-compatible with any vendor import. */
  function logicToLad(device) {
    const lines = [];
    lines.push("// Ladder rendition of the DeviceNet device logic \u2014 " + (device.name || "device") + " (MAC " + device.macId + ")");
    lines.push("// Derived from the RSNetWorx FBD export; configured local-logic labels shown where known.");
    lines.push("");
    for (const b of (device.logic ? device.logic.blocks : [])) {
      const t = String(b.type || "").toUpperCase();
      const tag = blockTag(b);
      const slots = inputSlots(b);
      const comment = blockComment(b);
      if (t === "AND") { lines.push(slots.map(function (sl) { return slotTerm(b, sl); }).join(" ") + " OTE(" + tag + ")" + comment); continue; }
      if (t === "OR") { lines.push("[" + slots.map(function (sl) { return slotTerm(b, sl); }).join(" , ") + " ] OTE(" + tag + ")" + comment); continue; }
      if (t === "SR LATCH" || t === "RS LATCH") {
        lines.push(slotTerm(b, slots[0]) + " OTL(" + tag + ")" + (comment ? comment + " (set)" : ""));
        lines.push(slotTerm(b, slots[1]) + " OTU(" + tag + ")" + (comment ? comment + " (reset)" : ""));
        continue;
      }
      const p = (b.params || []).map(function (x) { return x.name + "=" + x.value; }).join(", ");
      const op = t === "ON DELAY TIMER" ? "TON" : t === "OFF DELAY TIMER" ? "TOF" : t === "PULSE TIMER" ? "TP" : t === "UP COUNTER" ? "CTU" : "FB";
      lines.push(slotSource(b, slots[0] || { index: 0 }) + " " + op + "(" + tag + (p ? ", " + p : "") + ")" + comment);
    }
    return lines.join("\n") + "\n";
  }

  function ladSeries(items) { return { kind: "series", items: items || [] }; }
  function ladParallel(legs) { return { kind: "parallel", legs: legs || [] }; }
  function ladInstr(op, args) { return { op: op, args: (args || []).map(String) }; }
  function ladCond(slot, b) {
    const src = safeIdent(slotSource(b, slot));
    return ladInstr((slot.bound && slot.bound.complement) ? "XIO" : "XIC", [src]);
  }
  /* Ladder IR for the decoded device logic: boolean blocks become rung condition networks with an
     output instruction; latches become set/reset rungs; timers/counters become instruction rungs.
     The LadderEditor renders this as a real ladder (read-only) in the Logic tab. */
  function logicToLadIR(device) {
    const rungs = [];
    let number = 0;
    function push(root, comment) {
      rungs.push({ number: number++, type: "N", comment: comment || null, root: root });
    }
    for (const b of (device.logic ? device.logic.blocks : [])) {
      const t = String(b.type || "").toUpperCase();
      const tag = safeIdent(b.tag || ("FB" + b.seq));
      const slots = inputSlots(b);
      const comment = b.tag && b.description ? b.tag + " \u2014 " + b.description : (b.tag || b.description || "");
      if (t === "AND") {
        const items = slots.map(function (sl) { return ladCond(sl, b); });
        items.push(ladInstr("OTE", [tag]));
        push(ladSeries(items), comment);
      } else if (t === "OR") {
        const legs = slots.map(function (sl) { return ladSeries([ladCond(sl, b)]); });
        push(ladSeries([ladParallel(legs), ladInstr("OTE", [tag])]), comment);
      } else if (t === "SR LATCH" || t === "RS LATCH") {
        push(ladSeries([ladCond(slots[0], b), ladInstr("OTL", [tag])]), comment ? comment + " (set)" : null);
        push(ladSeries([ladCond(slots[1], b), ladInstr("OTU", [tag])]), comment ? comment + " (reset)" : null);
      } else {
        const params = (b.params || []).map(function (p) { return p.value; });
        const op = t === "ON DELAY TIMER" ? "TON" : t === "OFF DELAY TIMER" ? "TOF" : t === "PULSE TIMER" ? "TP" : t === "UP COUNTER" ? "CTU" : "NOP";
        push(ladSeries([ladCond(slots[0] || { index: 0 }, b), ladInstr(op, [tag].concat(params.slice(0, 2)))]), comment);
      }
    }
    return { kind: "lad", rungs: rungs };
  }

  function logicLabelsTable(device) {
    const rows = [];
    const blockByDesc = {};
    for (const b of (device.logic ? device.logic.blocks : [])) if (b.description) blockByDesc[b.description] = b;
    for (const a of ((device && device.localAliases) || [])) {
      const blk = blockByDesc[a.label] || null;
      rows.push({ label: cleanLabel(a.label), address: a.address || "-", kind: a.kind || "-", block: blk ? ("FB" + blk.seq + (blk.tag ? " " + blk.tag : "")) : "-", network: !!a.network });
    }
    const tags = [];
    for (const b of (device.logic ? device.logic.blocks : [])) {
      if (b.tag) tags.push({ seq: b.seq, tag: b.tag, type: b.type, description: b.description || "", inputs: (b.inputLabels || []).map(cleanLabel).join(", ") });
    }
    return { aliases: rows, tags: tags };
  }
  function aliasRows(device) { return ((device && device.localAliases) || []).slice(); }

  function logicReport(device) {
    if (!device || !device.logic) return "# " + ((device && device.name) || "device") + "\n\nNo logic found.\n";
    const lines = ["# DeviceNet logic \u2014 " + (device.name || "device") + " (MAC " + device.macId + ")", ""];
    lines.push("- Blocks: " + device.logic.count + (device.logic.namedBlocks ? " (" + device.logic.namedBlocks + " with configured tags)" : ""));
    for (const b of device.logic.blocks) {
      let line = b.seq + ". **" + b.type + "**";
      for (const p of (b.params || [])) line += " \u00b7 " + p.name + " " + p.value;
      if (b.tag) line += " \u00b7 " + b.tag + (b.description ? " (" + b.description + ")" : "");
      lines.push(line);
      for (const e of (b.bindings || [])) {
        lines.push("   - " + e.input + (e.complement ? " (complement)" : "") + " \u2190 " +
          (e.targetSeq ? "Function Block " + e.targetSeq + (e.targetType ? " (" + e.targetType + ")" : "") : "external/unbound"));
      }
    }
    if ((device.localAliases || []).length) {
      lines.push("", "## Local-logic I/O aliases", "");
      for (const a of device.localAliases) lines.push("- " + cleanLabel(a.label) + " \u2192 " + (a.address || "(label)") + (a.kind ? " [" + a.kind + "]" : ""));
    }
    return lines.join("\n") + "\n";
  }

  /* ------------------------------------------------------------------ FBD rendering */
  const TYPE_CLASS = {
    "SR LATCH": "latch", "RS LATCH": "latch",
    "AND": "gate", "OR": "gate", "NOT": "gate", "XOR": "gate",
    "ON DELAY TIMER": "timer", "OFF DELAY TIMER": "timer", "PULSE TIMER": "timer", "RETENTIVE TIMER": "timer",
    "UP COUNTER": "counter", "DOWN COUNTER": "counter"
  };
  const SVG_COLORS = {
    fb: ["#16232f", "#4a6a86", "#dce7ef"],
    gate: ["#16232f", "#4f8bb0", "#e2eef7"],
    latch: ["#1b2f22", "#5f9f6f", "#e2f5e6"],
    timer: ["#241f33", "#8f6db0", "#ece2f5"],
    counter: ["#332617", "#b08a4f", "#f5ecd9"],
    input: ["#121c26", "#4a545e", "#9fb2c2"]
  };
  function blockClass(type) { return TYPE_CLASS[String(type || "").toUpperCase()] || "fb"; }
  function blockLabel(block) {
    let label = String(block.seq) + " \u00b7 " + block.type;
    for (const p of (block.params || [])) label += " | " + p.name + " " + p.value;
    return label.replace(/"/g, "'");
  }
  function logicLayers(device) {
    const logic = device && device.logic;
    if (!logic || !logic.count) return [];
    const blocks = logic.blocks;
    const incoming = {};
    for (const b of blocks) incoming[b.seq] = (b.bindings || []).map(function (e) { return e.targetSeq; }).filter(function (s) { return s && logic.bySeq[s]; });
    const layer = {};
    function depth(seq, seen) {
      if (layer[seq] !== undefined) return layer[seq];
      if (seen[seq]) return 0;
      seen[seq] = true;
      const ins = incoming[seq] || [];
      layer[seq] = ins.length ? 1 + Math.max.apply(null, ins.map(function (s) { return depth(s, seen); })) : 0;
      return layer[seq];
    }
    for (const b of blocks) depth(b.seq, {});
    const layers = [];
    for (const b of blocks) {
      const l = layer[b.seq] || 0;
      (layers[l] = layers[l] || []).push(b);
    }
    return layers;
  }

  function logicMermaid(device, opts) {
    opts = opts || {};
    const logic = device && device.logic;
    const lines = ["flowchart LR"];
    if (!logic || !logic.count) {
      lines.push('EMPTY["No logic in this device configuration"]:::fb');
      return lines.join("\n");
    }
    const blocks = logic.blocks || [];
    const keep = {};
    if (!opts.all) {
      for (const b of blocks) {
        if ((b.bindings || []).length) { keep[b.seq] = true; for (const e of b.bindings) if (e.targetSeq) keep[e.targetSeq] = true; }
      }
      if (Object.keys(keep).length < 12) for (const b of blocks) keep[b.seq] = true;
    } else {
      for (const b of blocks) keep[b.seq] = true;
    }
    const shown = blocks.filter(function (b) { return keep[b.seq]; });
    const emitted = {};
    for (const b of shown) {
      emitted[b.seq] = true;
      lines.push('  FB' + b.seq + '["' + blockLabel(b) + '"]:::' + blockClass(b.type));
    }
    let unboundN = 0;
    for (const b of shown) {
      for (const bound of (b.bindings || [])) {
        if (bound.targetSeq && emitted[bound.targetSeq] && logic.bySeq[bound.targetSeq]) {
          lines.push('  FB' + bound.targetSeq + ' -->|' + ((bound.complement ? "NOT " : "") + bound.input).replace(/\|/g, "/") + '| FB' + b.seq);
        } else if (!bound.targetSeq) {
          const inId = "IN" + (++unboundN);
          lines.push('  ' + inId + '(["' + bound.input + '"] ):::input');
          lines.push('  ' + inId + ' -->|' + (bound.complement ? "NOT" : "input") + '| FB' + b.seq);
        }
      }
      if (!(b.bindings || []).length) {
        lines.push('  INU' + b.seq + '(["unbound input"]):::input');
        lines.push('  INU' + b.seq + ' -->|in| FB' + b.seq);
      }
    }
    if (shown.length < blocks.length) lines.push('  MORE["... ' + (blocks.length - shown.length) + ' unlinked block(s) not shown \u2014 enable Show all blocks"]:::input');
    lines.push("  classDef fb fill:#16232f,stroke:#4a6a86,color:#dce7ef;");
    lines.push("  classDef gate fill:#1b2b3a,stroke:#4f8bb0,color:#e2eef7;");
    lines.push("  classDef latch fill:#243a2a,stroke:#5f9f6f,color:#e2f5e6;");
    lines.push("  classDef timer fill:#2a2438,stroke:#8f6db0,color:#ece2f5;");
    lines.push("  classDef counter fill:#3a2f22,stroke:#b08a4f,color:#f5ecd9;");
    lines.push("  classDef input fill:#121c26,stroke:#55636f,color:#9fb2c2;");
    return lines.join("\n");
  }

  function logicSvg(device, opts) {
    opts = opts || {};
    const empty = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120">' +
      '<rect x="0" y="0" width="640" height="120" fill="#0d141b"/>' +
      '<text x="20" y="60" fill="#9fb2c2" font-family="monospace" font-size="13">No logic in this device configuration</text></svg>';
    const logic = device && device.logic;
    if (!logic || !logic.count) return { svg: empty, width: 640, height: 120, boxes: {} };
    const layers = logicLayers(device);
    const BOX_W = opts.boxWidth || 240;
    const COL_GAP = opts.colGap || 120;
    const ROW_GAP = opts.rowGap || 18;
    const HEAD = 22;
    const ROW_H = 15;
    const blocks = logic.blocks;
    const boxes = {};
    let maxX = 0, maxY = 0;
    const parts = [];
    for (let li = 0; li < layers.length; li++) {
      const col = layers[li] || [];
      const x = 40 + li * (BOX_W + COL_GAP);
      let y = 40;
      for (const b of col) {
        const slotList = inputSlots(b);
        const params = (b.params || []).length;
        const desc = (b.tag || b.description) ? 1 : 0;
        const h = HEAD + 16 + desc * ROW_H + (params ? ROW_H : 0) + Math.max(1, slotList.length) * ROW_H + 8;
        boxes[b.seq] = { x: x, y: y, w: BOX_W, h: h, params: params, desc: desc, slots: slotList };
        y += h + ROW_GAP;
      }
      maxX = Math.max(maxX, x + BOX_W);
      maxY = Math.max(maxY, y);
    }
    maxX += 40; maxY += 30;
    parts.push('<defs><marker id="fbd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="#7f9bad"/></marker></defs>');
    parts.push('<rect x="0" y="0" width="' + maxX + '" height="' + maxY + '" fill="#0d141b"/>');
    /* edges (behind boxes) */
    for (const b of blocks) {
      for (const e of (b.bindings || [])) {
        const src = e.targetSeq && boxes[e.targetSeq];
        const dst = boxes[b.seq];
        if (!src || !dst) continue;
        let rowIndex = 0;
        for (let k = 0; k < (dst.slots || []).length; k++) if (dst.slots[k].bound === e) { rowIndex = k; break; }
        const y1 = src.y + HEAD + 16 + (src.desc || 0) * ROW_H;
        const y2 = dst.y + HEAD + 16 + (dst.desc || 0) * ROW_H + (dst.params || 0) * ROW_H + rowIndex * ROW_H + ROW_H / 2;
        const x1 = src.x + src.w, x2 = dst.x;
        const c = e.complement ? "#b08a4f" : "#5c7f9b";
        parts.push('<path d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + 55) + ' ' + y1 + ', ' + (x2 - 55) + ' ' + y2 + ', ' + x2 + ' ' + y2 +
          '" fill="none" stroke="' + c + '" stroke-width="1.4"' + (e.complement ? ' stroke-dasharray="5 3"' : '') + ' marker-end="url(#fbd-arrow)"/>');
      }
    }
    /* boxes */
    for (const b of blocks) {
      const box = boxes[b.seq];
      if (!box) continue;
      const cls = blockClass(b.type);
      const colors = SVG_COLORS[cls] || SVG_COLORS.fb;
      parts.push('<g class="fbd-block fbd-' + cls + '" data-seq="' + b.seq + '">');
      parts.push('<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="6" fill="' + colors[0] + '" stroke="' + colors[1] + '" stroke-width="1.2"/>');
      parts.push('<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + HEAD + '" rx="6" fill="' + colors[1] + '" opacity="0.22"/>');
      parts.push('<text x="' + (box.x + 8) + '" y="' + (box.y + 15) + '" fill="' + colors[1] + '" font-family="monospace" font-size="11">#' + b.seq + '</text>');
      parts.push('<text x="' + (box.x + 44) + '" y="' + (box.y + 15) + '" fill="' + colors[2] + '" font-family="monospace" font-size="11.5" font-weight="bold">' + esc(b.type) + '</text>');
      let ty = box.y + HEAD + 15;
      if (b.tag || b.description) {
        const descText = (b.tag ? b.tag : "") + (b.tag && b.description ? " \u2014 " : "") + (b.description || "");
        parts.push('<text x="' + (box.x + 8) + '" y="' + ty + '" fill="#d9b96a" font-family="monospace" font-size="10" font-style="italic">' + esc(descText) + '</text>');
        ty += ROW_H;
      }
      if ((b.params || []).length) {
        const ptext = b.params.map(function (p) { return p.name + " " + p.value; }).join(" \u00b7 ");
        parts.push('<text x="' + (box.x + 8) + '" y="' + ty + '" fill="#9fb2c2" font-family="monospace" font-size="10">' + esc(ptext) + '</text>');
        ty += ROW_H;
      }
      if (box.slots && box.slots.length) {
        for (const sl of box.slots) {
          const inputLabel = (sl.bound && sl.bound.input) || ("Input " + (sl.index + 1));
          const mark = sl.bound ? (sl.bound.complement ? " (\u00ac)" : "") : " (I/O)";
          const label = inputLabel + mark + " \u2190 " + slotSource(b, sl);
          parts.push('<text x="' + (box.x + 8) + '" y="' + ty + '" fill="' + (sl.bound ? "#c9d6e0" : "#8fa3b3") + '" font-family="monospace" font-size="10">' + esc(label) + '</text>');
          ty += ROW_H;
        }
      } else {
        parts.push('<text x="' + (box.x + 8) + '" y="' + ty + '" fill="#6f8494" font-family="monospace" font-size="10">no inputs</text>');
      }
      parts.push('</g>');
    }
    const header = '<svg xmlns="http://www.w3.org/2000/svg" width="' + maxX + '" height="' + maxY +
      '" viewBox="0 0 ' + maxX + ' ' + maxY + '" style="background:#0d141b;display:block">';
    return { svg: header + parts.join("") + '</svg>', width: maxX, height: maxY, boxes: boxes };
  }

  return {
    isRsnetHtml: isRsnetHtml,
    parseRsnetHtml: parseRsnetHtml,
    logicMermaid: logicMermaid,
    logicLayers: logicLayers,
    logicSvg: logicSvg,
    parseLocalLabels: parseLocalLabels,
    annotateLogic: annotateLogic,
    logicToSt: logicToSt,
    logicToLad: logicToLad,
    logicToLadIR: logicToLadIR,
    logicLabelsTable: logicLabelsTable,
    aliasRows: aliasRows,
    classifyAddress: classifyAddress,
    logicReport: logicReport,
    blockClass: blockClass
  };
});
