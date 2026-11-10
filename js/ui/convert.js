/* L5X Studio - ui/convert.js (Lead). Routine language conversion panel (LAD/ST/FBD). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function h(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === "onclick") e.addEventListener("click", attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  var KIND_TO_TYPE = { lad: "RLL", st: "ST", fbd: "FBD" };
  var KIND_LABEL = { lad: "Ladder", st: "Structured Text", fbd: "Function Block" };

  function ConversionPanel(opts) {
    if (!(this instanceof ConversionPanel)) return new ConversionPanel(opts);
    this.app = opts.app;
    this.container = opts.container;
    this.lastWarnings = [];
    this._build();
  }

  ConversionPanel.prototype._build = function () {
    const c = this.container;
    c.innerHTML = "";
    c.appendChild(h("div", "panel-title", "Convert routine language"));
    this.info = h("div", "conv-info", "");
    c.appendChild(this.info);
    const targets = h("div", "conv-targets");
    const panel = this;
    for (const kind of ["st", "fbd", "lad"]) {
      const b = h("button", "btn conv-btn", "to " + KIND_LABEL[kind]);
      b.dataset.kind = kind;
      b.title = "Convert this routine to " + KIND_LABEL[kind] + " (preview first, then apply)";
      (function (k) {
        b.addEventListener("click", function () { panel.preview(k); });
      })(kind);
      targets.appendChild(b);
    }
    c.appendChild(targets);
    this.warnBox = h("div", "conv-warnings");
    c.appendChild(this.warnBox);
    this.previewBox = h("div", "conv-preview-box");
    c.appendChild(this.previewBox);
    this.applyRow = h("div", "conv-apply");
    const apply = h("button", "btn btn-primary", "Apply conversion to routine");
    apply.addEventListener("click", (function () { this.apply(); }).bind(this));
    this.applyRow.appendChild(apply);
    c.appendChild(this.applyRow);
    this.applyRow.style.display = "none";
  };

  ConversionPanel.prototype.refresh = function () {
    const sel = this.app.getSelection && this.app.getSelection();
    if (this.previewBox) this.previewBox.innerHTML = "";
    if (!sel || sel.type !== "routine") {
      this.info.textContent = "Open a routine first.";
      this.warnBox.innerHTML = "";
      this.applyRow.style.display = "none";
      this.staged = null;
      return;
    }
    const r = this.app.model.findRoutine(sel.program, sel.routine);
    const kind = (r.pendingType || r.type) === "RLL" ? "lad" : (r.pendingType || r.type) === "ST" ? "st" : "fbd";
    this.info.textContent = "Routine " + sel.program + " / " + sel.routine + " is currently " + KIND_LABEL[kind] + ".";
    this.warnBox.innerHTML = "";
    this.applyRow.style.display = "none";
    this.staged = null;
  };

  /* Text form of a staged routine content (for the preview pane). */
  function contentText(content) {
    if (!content) return "";
    if (content.kind === "st") return content.text || "";
    if (content.kind === "rll") {
      return (content.rungs || []).map(function (rg, i) {
        const lines = [];
        if (rg.comment) lines.push("// " + String(rg.comment).replace(/\r?\n/g, "\n// "));
        lines.push("Rung " + (rg.number !== undefined ? rg.number : i) + ": " + (rg.text || ""));
        return lines.join("\n");
      }).join("\n\n");
    }
    return content.xmlText || "";
  }

  ConversionPanel.prototype.preview = function (targetKind) {
    const ns = root.L5XStudio;
    const sel = this.app.getSelection();
    if (!sel || sel.type !== "routine") return;
    const model = this.app.model;
    const r = model.findRoutine(sel.program, sel.routine);
    const curKind = (r.pendingType || r.type) === "RLL" ? "lad" : (r.pendingType || r.type) === "ST" ? "st" : "fbd";
    if (curKind === targetKind) {
      this.warnBox.innerHTML = "";
      this.warnBox.appendChild(h("div", "conv-note", "Already " + KIND_LABEL[targetKind] + "."));
      this.applyRow.style.display = "none";
      this.staged = null;
      return;
    }
    let ir = null, result = null;
    try { ir = model.getRoutineIR(sel.program, sel.routine); }
    catch (e) { this._fail("Could not parse routine: " + e.message); return; }
    try {
      if (targetKind === "st") {
        result = curKind === "lad" ? ns.ladToSt(ir) : ns.fbdToSt(ir);
      } else if (targetKind === "fbd") {
        result = curKind === "lad" ? ns.ladToFbd(ir) : ns.stToFbd(ir);
      } else {
        result = curKind === "st" ? ns.stToLad(ir) : ns.fbdToLad(ir);
      }
    } catch (e) {
      this._fail("Conversion failed: " + e.message);
      return;
    }
    this.staged = { kind: targetKind, ir: result.ir, warnings: result.warnings || [] };
    this.warnBox.innerHTML = "";
    const n = (result.warnings || []).length;
    this.warnBox.appendChild(h("div", n ? "conv-note warn" : "conv-note ok",
      n ? n + " warning(s) \u2014 review before applying." : "Conversion produced no warnings."));
    if (n) {
      const ul = h("ul", "conv-warn-list");
      for (const w of result.warnings) {
        const li = h("li", "conv-warn-item",
          (w.rung !== undefined && w.rung !== null ? "[rung " + w.rung + "] " : "") + w.msg);
        ul.appendChild(li);
      }
      this.warnBox.appendChild(ul);
    }
    this.applyRow.style.display = "block";
    // show the converted routine text so the result is verifiable before applying
    this.previewBox.innerHTML = "";
    try {
      const content = model.irToContent(sel.program, sel.routine, result.ir);
      const text = contentText(content);
      const lines = text ? text.split(/\r?\n/).length : 0;
      this.previewBox.appendChild(h("div", "conv-note",
        "Preview \u2014 " + KIND_LABEL[targetKind] + " (" + lines + " line" + (lines === 1 ? "" : "s") + "):"));
      const pre = h("pre", "routine-text");
      pre.textContent = text.length > 12000
        ? text.slice(0, 12000) + "\n\n\u2026 (truncated \u2014 apply, then open the routine to review the full content)"
        : text;
      this.previewBox.appendChild(pre);
    } catch (e) {
      this.previewBox.innerHTML = "";
      this.previewBox.appendChild(h("div", "conv-note warn", "Preview unavailable: " + e.message));
    }
  };

  ConversionPanel.prototype._fail = function (msg) {
    this.warnBox.innerHTML = "";
    this.warnBox.appendChild(h("div", "conv-note err", msg));
    if (this.previewBox) this.previewBox.innerHTML = "";
    this.applyRow.style.display = "none";
    this.staged = null;
  };

  ConversionPanel.prototype.apply = function () {
    if (!this.staged) return;
    const sel = this.app.getSelection();
    const model = this.app.model;
    const content = model.irToContent(sel.program, sel.routine, this.staged.ir);
    model.setRoutineContent(sel.program, sel.routine, KIND_TO_TYPE[this.staged.kind], content);
    this.app.onRoutineConverted(sel.program, sel.routine, this.staged.kind, this.staged.warnings);
    this.refresh();
  };

  return { ConversionPanel: ConversionPanel };
});
