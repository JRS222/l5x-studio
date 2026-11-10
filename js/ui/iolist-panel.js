/* L5X Studio - ui/iolist-panel.js (T2). I/O list view: toolbar filters, column
   picker, sortable-free data table, CSV/Markdown export via Blob download.
   Contract: docs/IMPROVEMENTS.md, T2 UI panel.
   DOM-only class; loading this file in Node must not throw (no DOM access at
   module scope, only inside the constructor/methods). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && module.exports;
  const IO_LIST = NODE ? require("../io-list.js") : null;

  function io() { return NODE ? IO_LIST : (root.L5XStudio || {}); }

  function h(tag, cls, text, attrs) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "type") el.type = attrs[k];
        else if (k === "checked") el.checked = attrs[k];
        else if (k === "value") el.value = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    return el;
  }

  function labelWith(control, text) {
    const label = h("label");
    label.appendChild(control);
    label.appendChild(document.createTextNode(" " + text));
    return label;
  }

  function safeStatus(app, msg, isError) {
    if (app && typeof app.status === "function") {
      try { app.status(msg, isError); } catch (e) { /* UI status must never break the view */ }
    }
  }

  /* ------------------------------------------------------------------- class */

  function IoListPanel(opts) {
    if (!(this instanceof IoListPanel)) return new IoListPanel(opts);
    opts = opts || {};
    this.container = opts.container;
    this.app = opts.app || {};
    this.maxRenderRows = typeof opts.maxRenderRows === "number" ? opts.maxRenderRows : 500;
    this.filters = { unusedOnly: false, usedOnly: false, direction: "all", module: "", search: "" };
    this.columns = (io().defaultIoListColumns ? io().defaultIoListColumns() : []);
    this._allRows = [];
    this._filteredRows = [];
    this._rowsModel = null;
    this._message = "";
    this._menuOpen = false;
    this._build();
  }

  IoListPanel.prototype._build = function () {
    const c = this.container;
    if (!c) return;
    if (typeof c.innerHTML === "string") c.innerHTML = "";
    else while (c.firstChild) c.removeChild(c.firstChild);

    const toolbar = h("div", "iolist-toolbar");
    const self = this;

    /* unused / used toggles */
    const cbUnused = h("input", null, null, { type: "checkbox" });
    const unusedLabel = labelWith(cbUnused, "Unused only");
    const cbUsed = h("input", null, null, { type: "checkbox" });
    const usedLabel = labelWith(cbUsed, "Used only");
    toolbar.appendChild(unusedLabel);
    toolbar.appendChild(usedLabel);
    this.unusedCb = cbUnused;
    this.usedCb = cbUsed;
    cbUnused.addEventListener("change", function () {
      self.filters.unusedOnly = !!cbUnused.checked;
      if (cbUnused.checked) { self.filters.usedOnly = false; cbUsed.checked = false; }
      self._renderTable();
    });
    cbUsed.addEventListener("change", function () {
      self.filters.usedOnly = !!cbUsed.checked;
      if (cbUsed.checked) { self.filters.unusedOnly = false; cbUnused.checked = false; }
      self._renderTable();
    });

    /* direction */
    const dirSel = h("select");
    for (const d of ["all", "Input", "Output", "Config"]) {
      const o = h("option", null, d === "all" ? "All directions" : d, { value: d });
      dirSel.appendChild(o);
    }
    dirSel.value = "all";
    this.dirSel = dirSel;
    dirSel.addEventListener("change", function () {
      self.filters.direction = dirSel.value || "all";
      self._renderTable();
    });
    toolbar.appendChild(labelWith(dirSel, "Direction"));

    /* module + search */
    const modInput = h("input", null, null, { type: "text", placeholder: "Module (e.g. GROUP01, PDP)" });
    const searchInput = h("input", null, null, { type: "text", placeholder: "Search address / description" });
    this.moduleInput = modInput;
    this.searchInput = searchInput;
    modInput.addEventListener("input", function () {
      self.filters.module = modInput.value;
      self._renderTable();
    });
    searchInput.addEventListener("input", function () {
      self.filters.search = searchInput.value;
      self._renderTable();
    });
    toolbar.appendChild(modInput);
    toolbar.appendChild(searchInput);

    /* column picker */
    const colWrap = h("div", "iolist-columns");
    const colBtn = h("button", "btn btn-sm", "Columns");
    const colMenu = h("div", "iolist-columns-menu");
    this.colMenu = colMenu;
    this.columns.forEach(function (col) {
      const cb = h("input", null, null, { type: "checkbox" });
      cb.checked = col.enabled !== false;
      cb.addEventListener("change", function () {
        col.enabled = !!cb.checked;
        self._renderTable();
      });
      colMenu.appendChild(labelWith(cb, col.label || col.key));
    });
    colBtn.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      self._menuOpen = !self._menuOpen;
      if (self._menuOpen) colMenu.className = "iolist-columns-menu open";
      else colMenu.className = "iolist-columns-menu";
    });
    colWrap.appendChild(colBtn);
    colWrap.appendChild(colMenu);
    toolbar.appendChild(colWrap);

    /* exports */
    const csvBtn = h("button", "btn btn-sm", "Export CSV");
    const mdBtn = h("button", "btn btn-sm", "Export Markdown");
    csvBtn.addEventListener("click", function () { self.exportCsv(); });
    mdBtn.addEventListener("click", function () { self.exportMarkdown(); });
    toolbar.appendChild(csvBtn);
    toolbar.appendChild(mdBtn);

    const count = h("span", "iolist-count", "");
    this.countEl = count;
    toolbar.appendChild(count);

    const wrap = h("div", "iolist-table-wrap");
    this.tableWrap = wrap;

    c.appendChild(toolbar);
    c.appendChild(wrap);
    this._renderTable();
  };

  IoListPanel.prototype._projectName = function () {
    const model = this.app && this.app.model;
    let name = "";
    if (model) {
      name = model.controller && model.controller.name ? model.controller.name : "";
      if (!name && model.fileName) name = String(model.fileName).replace(/\.L5X$/i, "");
    }
    name = String(name || "project").replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
    return name || "project";
  };

  IoListPanel.prototype._showMessage = function (msg) {
    this._message = msg || "";
    if (!this.tableWrap) return;
    if (typeof this.tableWrap.innerHTML === "string") this.tableWrap.innerHTML = "";
    else while (this.tableWrap.firstChild) this.tableWrap.removeChild(this.tableWrap.firstChild);
    if (msg) this.tableWrap.appendChild(h("div", "view-note", msg));
  };

  /* Rebuild rows for the current project and re-render. */
  IoListPanel.prototype.refresh = function () {
    try {
      const model = this.app && this.app.model;
      if (!model) {
        this._allRows = [];
        this._rowsModel = null;
        this._filteredRows = [];
        if (this.countEl) this.countEl.textContent = "";
        this._showMessage("Open an L5X project to build the I/O list.");
        return;
      }
      if (this._rowsModel !== model) {
        const opts = {};
        if (this.app && typeof this.app.tagWeb === "function") {
          try { const web = this.app.tagWeb(); if (web) opts.tagWeb = web; } catch (e) { /* ignore */ }
        }
        const api = io();
        this._allRows = api.buildIoListRows ? api.buildIoListRows(model, opts) : [];
        this._rowsModel = model;
        this._renderTable();
        safeStatus(this.app, this._allRows.length + " I/O point(s) across " +
          model.modules.length + " module(s)");
      } else {
        this._renderTable();
      }
    } catch (e) {
      this._allRows = [];
      this._filteredRows = [];
      if (this.countEl) this.countEl.textContent = "";
      this._showMessage("I/O list failed: " + (e && e.message ? e.message : e));
      safeStatus(this.app, "I/O list failed: " + (e && e.message ? e.message : e), true);
    }
  };

  IoListPanel.prototype.reload = function () {
    this._rowsModel = null;
    this.refresh();
  };

  IoListPanel.prototype._visibleColumns = function () {
    return (this.columns || []).filter(function (c) { return c && c.enabled !== false; });
  };

  IoListPanel.prototype._renderTable = function () {
    if (!this.tableWrap) return;
    const api = io();
    const all = this._allRows || [];
    const rows = api.applyFilters ? api.applyFilters(all, this.filters) : all.slice();
    this._filteredRows = rows;
    if (this.countEl) {
      const noun = rows.length === 1 ? "row" : "rows";
      this.countEl.textContent = rows.length + " " + noun +
        (rows.length !== all.length ? " of " + all.length : "") +
        (this._message ? " \u00b7 " + this._message : "");
    }
    if (typeof this.tableWrap.innerHTML === "string") this.tableWrap.innerHTML = "";
    else while (this.tableWrap.firstChild) this.tableWrap.removeChild(this.tableWrap.firstChild);

    if (!rows.length) {
      this.tableWrap.appendChild(h("div", "view-note", all.length
        ? "No rows match the current filters."
        : "No module I/O image points found in this project."));
      return;
    }

    const cols = this._visibleColumns();
    const table = h("table", "data-table");
    const thead = h("thead");
    const headRow = h("tr");
    cols.forEach(function (col) {
      const th = h("th", null, col.label || col.key);
      if (col.key === "address") th.className = "mono";
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = h("tbody");
    const limit = Math.min(rows.length, this.maxRenderRows);
    for (let i = 0; i < limit; i++) {
      const row = rows[i];
      const tr = h("tr", i % 2 ? "iolist-row-odd" : "iolist-row-even");
      if (tr.style) tr.style.background = i % 2 ? "rgba(255,255,255,0.025)" : "";
      for (const col of cols) {
        const text = api.getCellText ? api.getCellText(row, col.key) : String(row[col.key] === undefined ? "" : row[col.key]);
        const td = h("td", col.key === "address" ? "mono" : null, text);
        if (col.key === "used") td.className = row.used ? "iolist-used" : "iolist-unused";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.tableWrap.appendChild(table);
    if (rows.length > limit) {
      this.tableWrap.appendChild(h("div", "view-note",
        "Showing the first " + limit + " of " + rows.length +
        " rows (all rows are included in the CSV/Markdown export)."));
    }
  };

  IoListPanel.prototype._export = function (kind) {
    const api = io();
    const rows = this._filteredRows || [];
    const cols = this._visibleColumns();
    let text;
    if (kind === "csv") text = api.toCsv ? api.toCsv(rows, cols) : "";
    else text = api.toMarkdown ? api.toMarkdown(rows, cols) : "";
    const name = this._projectName() + "-io-list." + (kind === "csv" ? "csv" : "md");
    const win = (typeof window !== "undefined" && window) || root || {};
    try {
      const BlobCtor = (win && win.Blob) || (typeof Blob !== "undefined" ? Blob : null);
      const URLCtor = (win && win.URL) || (typeof URL !== "undefined" ? URL : null);
      if (!BlobCtor || !URLCtor || typeof URLCtor.createObjectURL !== "function") {
        safeStatus(this.app, "Download is not available in this environment", true);
        return;
      }
      const mime = kind === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8";
      const blob = new BlobCtor([text], { type: mime });
      const url = URLCtor.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      if (document.body) document.body.appendChild(a);
      a.click();
      if (document.body) document.body.removeChild(a);
      const later = (win && typeof win.setTimeout === "function") ? win.setTimeout
        : (typeof setTimeout === "function" ? setTimeout : function () {});
      later(function () { try { URLCtor.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 4000);
      safeStatus(this.app, "Exported " + name + " (" + rows.length + " rows)");
    } catch (e) {
      safeStatus(this.app, "Export failed: " + (e && e.message ? e.message : e), true);
    }
  };

  IoListPanel.prototype.exportCsv = function () { this._export("csv"); };
  IoListPanel.prototype.exportMarkdown = function () { this._export("markdown"); };

  /* current filtered rows / all rows — useful for tests and for the Lead */
  IoListPanel.prototype.getRows = function () { return (this._filteredRows || []).slice(); };
  IoListPanel.prototype.getAllRows = function () { return (this._allRows || []).slice(); };

  return { IoListPanel: IoListPanel };
});
