/* L5X Studio - ui/aoi-panel.js (Lead). Add-On Instruction browser: definition metadata,
   parameters, local tags and routines (with content preview). */
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
      else if (k === "title") e.title = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function AoiPanel(opts) {
    if (!(this instanceof AoiPanel)) return new AoiPanel(opts);
    this.app = opts.app;
    this.container = opts.container;
    this.selected = null;
    this.search = "";
    this._build();
  }

  AoiPanel.prototype._build = function () {
    this.container.innerHTML = "";
    this.wrap = h("div", "aoi-wrap");
    this.container.appendChild(this.wrap);
    this.refresh();
  };

  AoiPanel.prototype.refresh = function () {
    const self = this;
    const ns = root.L5XStudio;
    const model = this.app.model;
    this.wrap.innerHTML = "";
    if (!model) { this.wrap.appendChild(h("div", "view-note", "Load an L5X project first.")); return; }
    const aois = model.addOnInstructions || [];
    if (!aois.length) {
      this.wrap.appendChild(h("div", "view-note", "This project defines no Add-On Instructions."));
      return;
    }
    const left = h("div", "aoi-list");
    const right = h("div", "aoi-detail");
    const search = h("input", "search-input", null, { type: "text", placeholder: "Filter AOIs\u2026" });
    search.value = this.search;
    search.addEventListener("input", function () {
      self.search = search.value;
      self._renderList(list, aois);
    });
    left.appendChild(search);
    const list = h("div", "aoi-scroll");
    left.appendChild(list);
    const detail = h("div", "aoi-scroll");
    right.appendChild(detail);
    this._renderList = function (host, items) {
      host.innerHTML = "";
      const f = (self.search || "").toLowerCase();
      let shown = 0;
      for (const aoi of items) {
        if (f && aoi.name.toLowerCase().indexOf(f) === -1) continue;
        shown++;
        const it = h("div", "aoi-item" + (aoi.name === self.selected ? " selected" : ""));
        it.appendChild(h("div", "aoi-item-name", aoi.name));
        it.appendChild(h("div", "aoi-item-meta",
          "rev " + (aoi.revision || "?") + " \u00b7 " + aoi.parameters.length + " params \u00b7 " +
          (aoi.localTags || []).length + " local tags \u00b7 " + (aoi.routines || []).length + " routines"));
        (function (name) { it.addEventListener("click", function () { self.selected = name; self.refresh(); }); })(aoi.name);
        host.appendChild(it);
      }
      if (!shown) host.appendChild(h("div", "acd-empty", "No matching AOIs"));
    };
    this._renderList(list, aois);
    const cur = aois.find(a => a.name === this.selected) || aois[0];
    this.selected = cur.name;
    this._renderDetail(detail, cur);
    this.wrap.appendChild(left);
    this.wrap.appendChild(right);
  };

  AoiPanel.prototype._renderDetail = function (host, aoi) {
    const ns = root.L5XStudio;
    const head = h("div", "aoi-head");
    head.appendChild(h("span", "aoi-title", aoi.name));
    head.appendChild(h("span", "aoi-sub",
      (aoi.class || "Standard") + " \u00b7 revision " + (aoi.revision || "?") +
      (aoi.vendor ? " \u00b7 " + aoi.vendor : "")));
    host.appendChild(head);
    if (aoi.description) host.appendChild(h("div", "aoi-description", aoi.description));

    const meta = h("div", "aoi-meta");
    const facts = [];
    if (aoi.createdDate) facts.push("created " + aoi.createdDate + (aoi.createdBy ? " by " + aoi.createdBy : ""));
    if (aoi.editedDate) facts.push("edited " + aoi.editedDate + (aoi.editedBy ? " by " + aoi.editedBy : ""));
    facts.push("prescan " + (aoi.executePrescan ? "yes" : "no"));
    facts.push("postscan " + (aoi.executePostscan ? "yes" : "no"));
    facts.push("EnableInFalse " + (aoi.executeEnableInFalse ? "yes" : "no"));
    meta.textContent = facts.join(" \u00b7 ");
    host.appendChild(meta);

    // parameters
    host.appendChild(h("div", "aoi-section-title", "Parameters (" + aoi.parameters.length + ")"));
    const pt = h("table", "data-table");
    const thr = h("tr");
    ["Name", "Tag type", "Data type", "Dim", "Usage", "Description"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    pt.appendChild(thr);
    for (const p of aoi.parameters) {
      const tr = h("tr");
      tr.appendChild(h("td", "mono", p.name));
      tr.appendChild(h("td", null, p.tagType));
      tr.appendChild(h("td", "mono", p.dataType + (p.dimension && p.dimension !== "0" ? "[" + p.dimension + "]" : "")));
      tr.appendChild(h("td", null, p.dimension !== "0" ? p.dimension : ""));
      tr.appendChild(h("td", null, p.usage));
      tr.appendChild(h("td", null, p.description || ""));
      pt.appendChild(tr);
    }
    host.appendChild(pt);

    // local tags
    const localTags = aoi.localTags || [];
    host.appendChild(h("div", "aoi-section-title", "Local tags (" + localTags.length + ")"));
    if (localTags.length) {
      const lt = h("table", "data-table");
      const lth = h("tr");
      ["Name", "Data type", "Dim", "Description"].forEach(function (t) { lth.appendChild(h("th", null, t)); });
      lt.appendChild(lth);
      for (const t of localTags) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", t.name));
        tr.appendChild(h("td", "mono", t.dataType));
        tr.appendChild(h("td", null, t.dimension ? String(t.dimension) : ""));
        tr.appendChild(h("td", null, t.description || ""));
        lt.appendChild(tr);
      }
      host.appendChild(lt);
    } else host.appendChild(h("div", "aoi-empty", "none"));

    // routines
    const routines = aoi.routines || [];
    host.appendChild(h("div", "aoi-section-title", "Routines (" + routines.length + ")"));
    if (!routines.length) { host.appendChild(h("div", "aoi-empty", "none")); return; }
    for (const r of routines) {
      const box = h("div", "aoi-routine");
      const hd = h("div", "aoi-routine-head");
      hd.textContent = r.name + "  [" + r.type + "]";
      box.appendChild(hd);
      const pre = h("pre", "aoi-routine-body");
      pre.textContent = this._routineText(r);
      box.appendChild(pre);
      host.appendChild(box);
    }
  };

  AoiPanel.prototype._routineText = function (r) {
    const ns = root.L5XStudio;
    try {
      if (r.type === "RLL") {
        const rungs = (r.content && r.content.rungs) || [];
        return rungs.map(function (rg, i) {
          const parts = ["Rung " + (rg.number !== undefined ? rg.number : i) + ":"];
          if (rg.comment) parts.push("// " + rg.comment);
          parts.push(rg.text || "");
          return parts.join("\n");
        }).join("\n\n");
      }
      if (r.type === "ST") return (r.content && r.content.text) || "";
      if (r.type === "FBD") {
        const fp = ns.parseFbdXml;
        if (typeof fp === "function" && r.content && r.content.xmlText) {
          const ir = fp(r.content.xmlText);
          const lines = [];
          for (const sheet of ir.sheets || []) {
            lines.push("Sheet" + (sheet.number !== undefined ? " " + sheet.number : "") + ": " + (sheet.blocks || []).length + " blocks, " + (sheet.wires || []).length + " wires");
            for (const b of sheet.blocks || []) lines.push("  " + (b.kind || "block") + " " + (b.type || "") + (b.operand ? "  " + b.operand : ""));
          }
          return lines.join("\n");
        }
        return "(FBD content)";
      }
      return (r.content && (r.content.text || r.content.xmlText)) || "(content)";
    } catch (e) { return "(could not render routine: " + e.message + ")"; }
  };

  return { AoiPanel: AoiPanel };
});
