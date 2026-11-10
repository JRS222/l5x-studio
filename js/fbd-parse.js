/* L5X Studio - fbd-parse.js (T2). L5X <FBDContent> XML -> fbdIR. See CONTRACT section 5.
   Round-trip contract: parseFbdXml(serializeFbdXml(x)) deep-equals x.
   Conventions locked in here (mirrored by fbd-serialize.js):
   - ids are STRINGS everywhere (block ids, wire endpoint ids, textbox/attachment ids).
   - x/y are numbers (unsigned grid coords, default 0).
   - unknown attributes are kept per element in `raw` (canonical attributes are NOT in raw).
   - visiblePins/in/ret are arrays of strings (space-separated in L5X) or undefined.
   - feedback wires carry feedback:true; normal wires have no feedback field.
   - parse normalizes sheetSize/sheetOrientation (defaults Letter/Landscape) and sheet.number
     (attr or ordinal), so a round trip through this parser always carries those fields. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const dep = typeof module !== "undefined" && module.exports ? require("./xml.js") : root.L5XStudio;
  const xml = (dep && dep.xml) || dep;
  if (!xml || typeof xml.parseXml !== "function") {
    throw new Error("fbd-parse: xml dependency missing");
  }

  /* Canonical (typed) attributes per element kind; anything else goes into `raw`. */
  const CANON = {
    iref: ["ID", "X", "Y", "Operand", "HideDesc"],
    oref: ["ID", "X", "Y", "Operand", "HideDesc"],
    icon: ["ID", "X", "Y", "Name"],
    ocon: ["ID", "X", "Y", "Name"],
    block: ["Type", "ID", "X", "Y", "VisiblePins", "HideDesc", "AutotuneTag"],
    aoi: ["ID", "X", "Y", "Name"],
    jsr: ["ID", "X", "Y", "Routine", "In", "Ret"],
    sbr: ["ID", "X", "Y", "Routine", "Ret"],
    ret: ["ID", "X", "Y", "Routine", "In"],
    "function": ["Type", "ID", "X", "Y"],
    textbox: ["ID", "X", "Y", "Width"],
    attachment: ["FromID", "ToID"],
    wire: ["FromID", "FromParam", "ToID", "ToParam"]
  };

  function extraAttrs(attrs, canonical) {
    const out = {};
    for (const k of Object.keys(attrs || {})) {
      if (canonical.indexOf(k) === -1) out[k] = attrs[k];
    }
    return out;
  }
  function setRaw(obj, attrs, canonical) {
    const extra = extraAttrs(attrs, canonical);
    if (Object.keys(extra).length) obj.raw = extra;
    return obj;
  }
  function intVal(v) {
    if (v === undefined || v === null || v === "") return 0;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : 0;
  }
  /* L5X separates pin names with spaces; tolerate commas too (L5K style). */
  function splitWs(v) {
    if (v === undefined) return undefined;
    return String(v).split(/[ \t\r\n,]+/).filter(function (s) { return s.length > 0; });
  }
  function idOf(attrs, counter) {
    if (attrs.ID !== undefined && attrs.ID !== "") return String(attrs.ID);
    counter.n += 1;
    return "gen" + counter.n;
  }

  function parseSheet(node, index) {
    const sheet = { blocks: [], wires: [], textBoxes: [], attachments: [] };
    sheet.number = xml.attr(node, "Number") !== undefined && xml.attr(node, "Number") !== ""
      ? String(xml.attr(node, "Number")) : String(index + 1);
    setRaw(sheet, node.attrs, ["Number"]);
    const desc = xml.child(node, "Description");
    if (desc) sheet.name = xml.textOf(desc);
    const counter = { n: 0 };
    for (const el of xml.children(node)) {
      const attrs = el.attrs || {};
      const name = el.name;
      if (name === "IRef" || name === "ORef") {
        const kind = name === "IRef" ? "iref" : "oref";
        const b = { kind: kind, id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        if (attrs.Operand !== undefined) b.operand = attrs.Operand;
        if (attrs.HideDesc !== undefined) b.hiddenDesc = attrs.HideDesc;
        setRaw(b, attrs, CANON[kind]);
        sheet.blocks.push(b);
      } else if (name === "ICon" || name === "OCon") {
        const kind = name === "ICon" ? "icon" : "ocon";
        const b = { kind: kind, id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        if (attrs.Name !== undefined) b.name = attrs.Name;
        setRaw(b, attrs, CANON[kind]);
        sheet.blocks.push(b);
      } else if (name === "Block") {
        const b = { kind: "block", type: attrs.Type !== undefined ? attrs.Type : "",
          id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        if (attrs.VisiblePins !== undefined) b.visiblePins = splitWs(attrs.VisiblePins);
        if (attrs.HideDesc !== undefined) b.hiddenDesc = attrs.HideDesc;
        if (attrs.AutotuneTag !== undefined) b.autotuneTag = attrs.AutotuneTag;
        const arr = xml.child(el, "Array");
        if (arr) {
          if (arr.attrs && arr.attrs.Operand !== undefined) b.operand = arr.attrs.Operand;
          if (arr.attrs && arr.attrs.Name !== undefined) b.arrayName = arr.attrs.Name;
        } else if (attrs.Operand !== undefined) {
          b.operand = attrs.Operand;
        }
        setRaw(b, attrs, CANON.block);
        sheet.blocks.push(b);
      } else if (name === "AddOnInstruction") {
        const b = { kind: "aoi", id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        if (attrs.Name !== undefined) b.name = attrs.Name;
        const kids = xml.children(el).map(function (c) {
          return { name: c.name, attrs: c.attrs || {} };
        });
        if (kids.length) b.rawChildren = kids;
        setRaw(b, attrs, CANON.aoi);
        sheet.blocks.push(b);
      } else if (name === "JSR" || name === "SBR" || name === "RET") {
        const kind = name.toLowerCase();
        const b = { kind: kind, id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        if (attrs.Routine !== undefined) b.routine = attrs.Routine;
        if (attrs.In !== undefined) b.in = splitWs(attrs.In);
        if (attrs.Ret !== undefined) b.ret = splitWs(attrs.Ret);
        setRaw(b, attrs, CANON[kind]);
        sheet.blocks.push(b);
      } else if (name === "Function") {
        const b = { kind: "function", type: attrs.Type !== undefined ? attrs.Type : "",
          id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y) };
        setRaw(b, attrs, CANON["function"]);
        sheet.blocks.push(b);
      } else if (name === "Wire" || name === "FeedbackWire") {
        const w = {
          from: { id: String(attrs.FromID !== undefined ? attrs.FromID : "0") },
          to: { id: String(attrs.ToID !== undefined ? attrs.ToID : "0") }
        };
        if (attrs.FromParam !== undefined) w.from.param = attrs.FromParam;
        if (attrs.ToParam !== undefined) w.to.param = attrs.ToParam;
        if (name === "FeedbackWire") w.feedback = true;
        setRaw(w, attrs, CANON.wire);
        sheet.wires.push(w);
      } else if (name === "TextBox") {
        const tb = { id: idOf(attrs, counter), x: intVal(attrs.X), y: intVal(attrs.Y),
          text: xml.textOf(el) };
        if (attrs.Width !== undefined) tb.width = attrs.Width;
        setRaw(tb, attrs, CANON.textbox);
        sheet.textBoxes.push(tb);
      } else if (name === "Attachment") {
        const a = {
          from: String(attrs.FromID !== undefined ? attrs.FromID : "0"),
          to: String(attrs.ToID !== undefined ? attrs.ToID : "0")
        };
        setRaw(a, attrs, CANON.attachment);
        sheet.attachments.push(a);
      }
      /* Unknown element kinds are tolerated and skipped (per contract). */
    }
    return sheet;
  }

  function parseFbdXml(xmlText) {
    if (xmlText === null || xmlText === undefined || String(xmlText).trim() === "") {
      throw new Error("parseFbdXml: empty input");
    }
    const doc = xml.parseXml(String(xmlText));
    let fbdc = null;
    (function find(node) {
      if (fbdc || !node) return;
      if (node.name === "FBDContent") { fbdc = node; return; }
      if (node.children) {
        for (const c of node.children) {
          if (c.type === "element") find(c);
        }
      }
    })(doc);
    if (!fbdc) throw new Error("parseFbdXml: no <FBDContent> element found");
    const ir = { kind: "fbd", sheets: [] };
    const attrs = fbdc.attrs || {};
    ir.sheetSize = attrs.SheetSize !== undefined ? attrs.SheetSize : "Letter (8.5x11in)";
    ir.sheetOrientation = attrs.SheetOrientation !== undefined ? attrs.SheetOrientation : "Landscape";
    const extra = extraAttrs(attrs, ["SheetSize", "SheetOrientation"]);
    if (Object.keys(extra).length) ir.raw = extra;
    let idx = 0;
    for (const sheetNode of xml.children(fbdc, "Sheet")) {
      ir.sheets.push(parseSheet(sheetNode, idx++));
    }
    return ir;
  }

  return { parseFbdXml: parseFbdXml };
});
