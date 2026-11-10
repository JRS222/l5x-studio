/* L5X Studio - fbd-serialize.js (T2). fbdIR -> L5X <FBDContent> XML. See CONTRACT section 5.
   Emits elements in the exact manual order within each <Sheet>:
   Description, IRef*, ORef*, ICon*, OCon*, Block*, AddOnInstruction*, JSR*, SBR*, RET*,
   Wire*, FeedbackWire*, Function*, TextBox*, Attachment*.
   Wire pin conventions: FromParam omitted for IRef sources, ToParam omitted for ORef
   targets (undefined param = omitted). Block Operand/ArrayName go on the <Array> child
   element (manual L5X form); a block without array info self-closes with Operand omitted.
   Mirrors the conventions locked in fbd-parse.js for exact round trips. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const dep = typeof module !== "undefined" && module.exports ? require("./util.js") : root.L5XStudio;
  const util = (dep && dep.util) || dep;

  function esc(v) {
    const s = String(v);
    if (util && util.xmlAttrEscape) return util.xmlAttrEscape(s);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function cdata(v) {
    const s = String(v);
    if (util && util.cdataSafe) return util.cdataSafe(s);
    return s.replace(/]]>/g, "]]]]><![CDATA[>");
  }
  function attrLine(name, value) { return ' ' + name + '="' + esc(value) + '"'; }
  function extraAttrs(raw) {
    let s = "";
    if (raw) {
      for (const k of Object.keys(raw)) s += attrLine(k, raw[k]);
    }
    return s;
  }
  /* pairs: array of [name, value]; undefined values are omitted. */
  function emitSelfClose(indent, tag, pairs, raw) {
    let s = indent + "<" + tag;
    for (const p of pairs) if (p[1] !== undefined) s += attrLine(p[0], p[1]);
    s += extraAttrs(raw);
    s += "/>\n";
    return s;
  }

  function emitIrefOref(indent, b) {
    const tag = b.kind === "iref" ? "IRef" : "ORef";
    return emitSelfClose(indent, tag,
      [["ID", b.id], ["X", b.x], ["Y", b.y], ["Operand", b.operand], ["HideDesc", b.hiddenDesc]], b.raw);
  }
  function emitIconOcon(indent, b) {
    const tag = b.kind === "icon" ? "ICon" : "OCon";
    return emitSelfClose(indent, tag,
      [["ID", b.id], ["X", b.x], ["Y", b.y], ["Name", b.name]], b.raw);
  }
  function emitBlock(indent, b) {
    const pairs = [["Type", b.type], ["ID", b.id], ["X", b.x], ["Y", b.y]];
    if (b.visiblePins !== undefined) pairs.push(["VisiblePins", b.visiblePins.join(" ")]);
    if (b.hiddenDesc !== undefined) pairs.push(["HideDesc", b.hiddenDesc]);
    if (b.autotuneTag !== undefined) pairs.push(["AutotuneTag", b.autotuneTag]);
    if (b.arrayName !== undefined || b.operand !== undefined) {
      let s = indent + "<Block";
      for (const p of pairs) if (p[1] !== undefined) s += attrLine(p[0], p[1]);
      s += extraAttrs(b.raw) + ">\n";
      s += indent + "  <Array";
      if (b.arrayName !== undefined) s += attrLine("Name", b.arrayName);
      if (b.operand !== undefined) s += attrLine("Operand", b.operand);
      s += "/>\n";
      s += indent + "</Block>\n";
      return s;
    }
    return emitSelfClose(indent, "Block", pairs, b.raw);
  }
  function emitAoi(indent, b) {
    const pairs = [["ID", b.id], ["X", b.x], ["Y", b.y], ["Name", b.name]];
    let s = indent + "<AddOnInstruction";
    for (const p of pairs) if (p[1] !== undefined) s += attrLine(p[0], p[1]);
    s += extraAttrs(b.raw);
    const kids = b.rawChildren || [];
    if (!kids.length) { s += "/>\n"; return s; }
    s += ">\n";
    for (const k of kids) {
      s += indent + "  <" + k.name;
      for (const ak of Object.keys(k.attrs || {})) s += attrLine(ak, k.attrs[ak]);
      s += "/>\n";
    }
    s += indent + "</AddOnInstruction>\n";
    return s;
  }
  function emitJsrSbrRet(indent, b) {
    const tag = b.kind.toUpperCase();
    return emitSelfClose(indent, tag,
      [["ID", b.id], ["X", b.x], ["Y", b.y], ["Routine", b.routine],
       ["In", b.in !== undefined ? b.in.join(" ") : undefined],
       ["Ret", b.ret !== undefined ? b.ret.join(" ") : undefined]], b.raw);
  }
  function emitWire(indent, w) {
    const tag = w.feedback ? "FeedbackWire" : "Wire";
    return emitSelfClose(indent, tag,
      [["FromID", w.from && w.from.id], ["FromParam", w.from && w.from.param],
       ["ToID", w.to && w.to.id], ["ToParam", w.to && w.to.param]], w.raw);
  }
  function emitFunction(indent, b) {
    return emitSelfClose(indent, "Function",
      [["Type", b.type], ["ID", b.id], ["X", b.x], ["Y", b.y]], b.raw);
  }
  function emitTextBox(indent, tb) {
    let s = indent + "<TextBox" + attrLine("ID", tb.id) + attrLine("X", tb.x) + attrLine("Y", tb.y);
    if (tb.width !== undefined) s += attrLine("Width", tb.width);
    s += extraAttrs(tb.raw) + "><![CDATA[" + cdata(tb.text) + "]]></TextBox>\n";
    return s;
  }
  function emitAttachment(indent, a) {
    return emitSelfClose(indent, "Attachment", [["FromID", a.from], ["ToID", a.to]], a.raw);
  }

  /* Exact manual element order for the element groups within a sheet. */
  const BLOCK_ORDER = ["iref", "oref", "icon", "ocon", "block", "aoi", "jsr", "sbr", "ret"];

  function emitSheet(sheet, index) {
    const indent = "    ";
    const num = sheet.number !== undefined ? sheet.number : String(index + 1);
    let s = "  <Sheet" + attrLine("Number", num) + extraAttrs(sheet.raw) + ">\n";
    if (sheet.name !== undefined) {
      s += indent + "<Description><![CDATA[" + cdata(sheet.name) + "]]></Description>\n";
    }
    const blocks = sheet.blocks || [];
    for (const kind of BLOCK_ORDER) {
      for (const b of blocks) {
        if (b.kind !== kind) continue;
        if (kind === "iref" || kind === "oref") s += emitIrefOref(indent, b);
        else if (kind === "icon" || kind === "ocon") s += emitIconOcon(indent, b);
        else if (kind === "block") s += emitBlock(indent, b);
        else if (kind === "aoi") s += emitAoi(indent, b);
        else s += emitJsrSbrRet(indent, b);
      }
    }
    /* manual order: Wire* then FeedbackWire* (non-feedback wires first) */
    for (const w of sheet.wires || []) if (!w.feedback) s += emitWire(indent, w);
    for (const w of sheet.wires || []) if (w.feedback) s += emitWire(indent, w);
    for (const b of blocks) if (b.kind === "function") s += emitFunction(indent, b);
    for (const tb of sheet.textBoxes || []) s += emitTextBox(indent, tb);
    for (const a of sheet.attachments || []) s += emitAttachment(indent, a);
    s += "  </Sheet>\n";
    return s;
  }

  function serializeFbdXml(fbdIR) {
    if (!fbdIR || !Array.isArray(fbdIR.sheets)) {
      throw new Error("serializeFbdXml: invalid fbdIR (missing sheets array)");
    }
    const size = fbdIR.sheetSize !== undefined ? fbdIR.sheetSize : "Letter (8.5x11in)";
    const orient = fbdIR.sheetOrientation !== undefined ? fbdIR.sheetOrientation : "Landscape";
    let s = "<FBDContent" + attrLine("SheetSize", size) + attrLine("SheetOrientation", orient)
      + extraAttrs(fbdIR.raw) + ">\n";
    fbdIR.sheets.forEach(function (sheet, i) { s += emitSheet(sheet, i); });
    s += "</FBDContent>\n";
    return s;
  }

  return { serializeFbdXml: serializeFbdXml };
});
