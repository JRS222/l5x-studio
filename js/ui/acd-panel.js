/* L5X Studio - ui/acd-panel.js (Lead). ACD metadata browser: controller identity,
   data types with exact Rockwell byte/bit offsets, controller/program tag databases,
   and the embedded archive file list. Logic is NOT available from an ACD here. */
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

  function fmtSize(n) {
    if (n === null || n === undefined) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function AcdPanel(opts) {
    if (!(this instanceof AcdPanel)) return new AcdPanel(opts);
    this.app = opts.app;
    this.container = opts.container;
    this.view = "types";
    this.selectedType = null;
    this.search = "";
    this._build();
  }

  AcdPanel.prototype._build = function () {
    const c = this.container;
    c.innerHTML = "";
    this.banner = h("div", "acd-banner");
    c.appendChild(this.banner);
    this.controllerBox = h("div", "acd-controller");
    c.appendChild(this.controllerBox);
    this.tabBar = h("div", "subtab-bar");
    const tabs = [["types", "Data types"], ["ctags", "Controller tags"], ["ptags", "Program tags"], ["files", "Archive files"]];
    this.tabBtns = {};
    for (const [id, label] of tabs) {
      const b = h("button", "subtab-btn", label);
      b.addEventListener("click", (function (v) { this.view = v; this._renderView(); }).bind(this, id));
      this.tabBtns[id] = b;
      this.tabBar.appendChild(b);
    }
    c.appendChild(this.tabBar);
    this.body = h("div", "acd-body");
    c.appendChild(this.body);
  };

  AcdPanel.prototype.refresh = function () {
    const acd = this.app.acd;
    const c = this.controllerBox;
    c.innerHTML = "";
    if (!acd) {
      this.banner.textContent = "Open a .ACD project file to browse its metadata.";
      this.body.innerHTML = "";
      return;
    }
    this.banner.innerHTML = "";
    this.banner.appendChild(h("b", null, "ACD metadata view. "));
    this.banner.appendChild(h("span", null,
      "Controller identity, data types (with exact Rockwell byte/bit offsets) and the tag database are read directly from the project archive. " +
      "Logic and I/O configuration live in Rockwell's binary databases and are not decoded here \u2014 export an L5X from Studio 5000 for dataflow, editing and I/O mapping."));
    const ctrl = acd.controller || {};
    const rows = [
      ["Project", this.app.acdFileName || acd.tagInfoName || ""],
      ["Controller", ctrl.name || ""],
      ["Description", ctrl.description || ""],
      ["Software", ctrl.swVersion || ""],
      ["Device", ctrl.deviceIdentity ? ("vendor " + ctrl.deviceIdentity.vendorId + " \u00b7 type " + ctrl.deviceIdentity.productType +
        " \u00b7 code " + ctrl.deviceIdentity.productCode + " \u00b7 rev " + ctrl.deviceIdentity.majorRevision + "." + ctrl.deviceIdentity.minorRevision) : ""],
      ["Data types", acd.dataTypes.length + " (" + acd.dataTypes.filter(d => d.class === "User").length + " user)"],
      ["Tags", acd.tags.length + " (" + acd.tags.filter(t => t.scope === "controller").length + " controller-scoped)"],
      ["Programs", acd.programs.length],
      ["Archive files", acd.files.length]
    ];
    const table = h("table", "data-table acd-info");
    for (const [k, v] of rows) {
      if (!v && k !== "Controller") continue;
      const tr = h("tr");
      tr.appendChild(h("th", null, k));
      tr.appendChild(h("td", null, v));
      table.appendChild(tr);
    }
    c.appendChild(table);
    this._renderView();
  };

  AcdPanel.prototype._renderView = function () {
    for (const id of Object.keys(this.tabBtns)) this.tabBtns[id].className = "subtab-btn" + (id === this.view ? " active" : "");
    const body = this.body;
    body.innerHTML = "";
    const acd = this.app.acd;
    if (!acd) return;
    if (this.view === "types") this._renderTypes();
    else if (this.view === "ctags") this._renderTags(acd.tags.filter(t => t.scope === "controller"), "Controller-scoped tags");
    else if (this.view === "ptags") this._renderProgramTags();
    else this._renderFiles();
  };

  AcdPanel.prototype._renderTypes = function () {
    const self = this;
    const acd = this.app.acd;
    const wrap = h("div", "acd-types");
    const left = h("div", "acd-types-list");
    const right = h("div", "acd-types-detail");
    const search = h("input", "search-input", null, { type: "text", placeholder: "Filter data types\u2026" });
    search.value = this.search || "";
    search.addEventListener("input", function () { self.search = search.value; renderList(); });
    left.appendChild(search);
    const list = h("div", "acd-types-scroll");
    left.appendChild(list);
    const details = h("div", "acd-types-scroll");
    right.appendChild(details);

    let selected = this.selectedType || (acd.dataTypes[0] && acd.dataTypes[0].name);
    function renderList() {
      list.innerHTML = "";
      const filter = (self.search || "").toLowerCase();
      let shown = 0;
      for (const dt of acd.dataTypes) {
        if (filter && dt.name.toLowerCase().indexOf(filter) === -1) continue;
        shown++;
        const item = h("div", "acd-type-item" + (dt.name === selected ? " selected" : ""));
        item.appendChild(h("span", "acd-type-name", dt.name));
        item.appendChild(h("span", "acd-type-meta", dt.class + (dt.size !== null ? " \u00b7 " + dt.size + " B" : "") + " \u00b7 " + dt.members.length + " members"));
        (function (name) {
          item.addEventListener("click", function () {
            self.selectedType = name;
            renderList();
            renderDetail(name);
          });
        })(dt.name);
        list.appendChild(item);
      }
      if (!shown) list.appendChild(h("div", "acd-empty", "No matching data types"));
    }
    function renderDetail(name) {
      details.innerHTML = "";
      const dt = acd.dataTypes.find(d => d.name === name);
      if (!dt) return;
      const head = h("div", "acd-detail-head");
      head.appendChild(h("span", "acd-detail-title", dt.name));
      head.appendChild(h("span", "acd-detail-sub", dt.class + " \u00b7 " + (dt.size !== null ? dt.size + " bytes" : "size unknown") + " \u00b7 " + dt.members.length + " members"));
      details.appendChild(head);
      const table = h("table", "data-table acd-members");
      const thr = h("tr");
      ["Member", "Type", "Dim", "Offset", "Bit", "Size", "Access", "Flags"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      (function walk(members, depth) {
        for (const m of members) {
          const tr = h("tr");
          const nameCell = h("td", "acd-member-name");
          nameCell.style.paddingLeft = (8 + depth * 16) + "px";
          nameCell.textContent = (depth ? "\u21b3 " : "") + (m.name || "(unnamed)");
          tr.appendChild(nameCell);
          tr.appendChild(h("td", "mono", m.dataType));
          tr.appendChild(h("td", null, m.dimensions && m.dimensions.length ? "[" + m.dimensions.join(",") + "]" : ""));
          tr.appendChild(h("td", "mono", m.offset !== null ? String(m.offset) : ""));
          tr.appendChild(h("td", "mono", m.bit !== null ? String(m.bit) : ""));
          tr.appendChild(h("td", null, ""));
          tr.appendChild(h("td", null, m.externalAccess || ""));
          tr.appendChild(h("td", null, m.hidden ? "hidden" : ""));
          table.appendChild(tr);
          if (m.children && m.children.length) walk(m.children, depth + 1);
        }
      })(dt.members || [], 0);
      details.appendChild(table);
    }
    renderList();
    if (selected) renderDetail(selected);
    wrap.appendChild(left);
    wrap.appendChild(right);
    this.body.appendChild(wrap);
  };

  AcdPanel.prototype._renderTags = function (tags, title) {
    const wrap = h("div", "acd-tags");
    wrap.appendChild(h("div", "acd-section-title", title + " (" + tags.length + ")"));
    const search = h("input", "search-input", null, { type: "text", placeholder: "Filter tags\u2026" });
    wrap.appendChild(search);
    const table = h("table", "data-table");
    const thr = h("tr");
    ["Name", "Data type", "Dim", "External access", "Description"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    table.appendChild(thr);
    function renderRows() {
      while (table.children.length > 1) table.removeChild(table.lastChild);
      const f = search.value.toLowerCase();
      for (const t of tags) {
        if (f && t.name.toLowerCase().indexOf(f) === -1) continue;
        const tr = h("tr");
        tr.appendChild(h("td", "mono", t.name));
        tr.appendChild(h("td", "mono", t.dataType));
        tr.appendChild(h("td", null, t.dimensions && t.dimensions.length ? "[" + t.dimensions.join(",") + "]" : ""));
        tr.appendChild(h("td", null, t.externalAccess || ""));
        tr.appendChild(h("td", null, t.description || ""));
        table.appendChild(tr);
      }
    }
    search.addEventListener("input", renderRows);
    renderRows();
    wrap.appendChild(table);
    this.body.appendChild(wrap);
  };

  AcdPanel.prototype._renderProgramTags = function () {
    const acd = this.app.acd;
    const wrap = h("div", "acd-programs");
    for (const p of acd.programs) {
      wrap.appendChild(h("div", "acd-section-title", p.name + " \u00b7 " + p.tags.length + " program-scoped tags"));
      const table = h("table", "data-table");
      const thr = h("tr");
      ["Name", "Data type", "Dim", "External access", "Description"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      for (const t of p.tags) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", t.name));
        tr.appendChild(h("td", "mono", t.dataType));
        tr.appendChild(h("td", null, t.dimensions && t.dimensions.length ? "[" + t.dimensions.join(",") + "]" : ""));
        tr.appendChild(h("td", null, t.externalAccess || ""));
        tr.appendChild(h("td", null, t.description || ""));
        table.appendChild(tr);
      }
      wrap.appendChild(table);
    }
    this.body.appendChild(wrap);
  };

  AcdPanel.prototype._renderFiles = function () {
    const acd = this.app.acd;
    const wrap = h("div", "acd-files");
    wrap.appendChild(h("div", "acd-section-title", "Embedded archive files (" + acd.files.length + ")"));
    const table = h("table", "data-table");
    const thr = h("tr");
    ["File", "Size", "Stored"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    table.appendChild(thr);
    for (const f of acd.files) {
      const tr = h("tr");
      tr.appendChild(h("td", "mono", f.name));
      tr.appendChild(h("td", null, fmtSize(f.size)));
      tr.appendChild(h("td", null, f.compressed ? "gzip" : "raw"));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    this.body.appendChild(wrap);
  };

  return { AcdPanel: AcdPanel };
});
