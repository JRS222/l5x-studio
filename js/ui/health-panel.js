/* L5X Studio - ui/health-panel.js (T3). Project health panel.
   DOM-only class; the module can be require()d in Node (no DOM access at load time).

   new L5XStudio.HealthPanel({ container, app })  where app provides:
     app.model                 parsed project model
     app.status(msg, isError)  status bar hook (optional)
     app.openRoutine(program, routine)  open a routine in the editor (optional)
   Methods: refresh() (re-runs the analysis), exportMarkdown(), render(). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HEALTH = (typeof module !== "undefined" && module.exports) ? require("../health.js") : null;

  const MAX_ROWS = 150;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function btn(label, cls, onClick) {
    const b = el("button", "btn" + (cls ? " " + cls : ""), label);
    b.addEventListener("click", onClick);
    return b;
  }

  function healthApi() {
    if (typeof module !== "undefined" && module.exports) return HEALTH;
    return root.L5XStudio;
  }

  function HealthPanel(opts) {
    if (!(this instanceof HealthPanel)) return new HealthPanel(opts);
    opts = opts || {};
    this.app = opts.app || {};
    this.container = opts.container;
    this.report = null;
    this._sections = [];
    this._built = false;
    this._build();
  }

  HealthPanel.prototype._build = function () {
    const c = this.container;
    if (!c) throw new Error("HealthPanel: container is required");
    c.innerHTML = "";
    try {
      if (c.classList && typeof c.classList.add === "function") c.classList.add("health-panel");
      else if (typeof c.className === "string") c.className += (c.className ? " " : "") + "health-panel";
    } catch (e) { /* non-DOM container stub */ }

    const head = el("div", "health-toolbar");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border, #333);";
    const title = el("div", "panel-title", "Project health");
    title.style.cssText = "border-bottom:0;padding:0;flex:1 1 auto;";
    head.appendChild(title);
    this.analyzeBtn = btn("Re-analyze", "btn-primary", (function () { this.refresh(); }).bind(this));
    this.exportBtn = btn("Export report (Markdown)", null, (function () { this.exportMarkdown(); }).bind(this));
    head.appendChild(this.analyzeBtn);
    head.appendChild(this.exportBtn);
    c.appendChild(head);

    this.statusEl = el("div", "health-status");
    this.statusEl.style.cssText = "padding:4px 12px;font-size:12px;color:var(--fg-dim, #999);";
    c.appendChild(this.statusEl);

    this.cardsEl = el("div", "health-cards");
    this.cardsEl.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px;";
    c.appendChild(this.cardsEl);

    this.findingsEl = el("div", "health-findings");
    this.findingsEl.style.cssText = "padding:0 12px 8px;";
    c.appendChild(this.findingsEl);

    this.bodyEl = el("div", "health-sections");
    this.bodyEl.style.cssText = "padding:0 12px 16px;overflow:auto;";
    c.appendChild(this.bodyEl);
    this._built = true;
  };

  HealthPanel.prototype.refresh = function () {
    const ns = healthApi();
    const model = this.app.model;
    if (!model) {
      this._setStatus("No project loaded \u2014 open an L5X file first.", true);
      if (this.cardsEl) this.cardsEl.innerHTML = "";
      if (this.findingsEl) this.findingsEl.innerHTML = "";
      if (this.bodyEl) this.bodyEl.innerHTML = "";
      return null;
    }
    try {
      this.report = ns.analyzeProject(model, {});
    } catch (e) {
      this._setStatus("Health analysis failed: " + ((e && e.message) || e), true);
      return null;
    }
    this._setStatus("Analyzed " + this.report.summary.programs + " programs, " +
      this.report.summary.routines + " routines, " + this.report.summary.controllerTags +
      " controller tags.", false);
    this.render();
    if (typeof this.app.status === "function") {
      this.app.status("Health: " + this.report.findings.length + " finding(s), " +
        this.report.unusedTags.length + " unused tag(s), " +
        this.report.uncalledRoutines.length + " uncalled routine(s).");
    }
    return this.report;
  };

  HealthPanel.prototype._setStatus = function (msg, isError) {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.style.color = isError ? "var(--err, #e55)" : "var(--fg-dim, #999)";
  };

  /* ---------------- rendering ---------------- */

  function card(label, value, color) {
    const d = el("div", "health-card");
    d.style.cssText = "min-width:110px;background:var(--bg2,#222);border:1px solid var(--border,#333);" +
      "border-radius:6px;padding:8px 12px;";
    const v = el("div", "health-card-value", String(value));
    v.style.cssText = "font-size:22px;font-weight:700;color:" + (color || "var(--fg,#ddd)") + ";";
    const l = el("div", "health-card-label", label);
    l.style.cssText = "font-size:11.5px;color:var(--fg-dim,#999);";
    d.appendChild(v);
    d.appendChild(l);
    return d;
  }

  HealthPanel.prototype._renderCards = function () {
    const rep = this.report;
    const s = rep.summary || {};
    const findings = rep.findings || [];
    const errors = findings.filter(function (f) { return f.severity === "error"; }).length;
    const warnings = findings.filter(function (f) { return f.severity === "warning"; }).length;
    this.cardsEl.innerHTML = "";
    this.cardsEl.appendChild(card("errors", errors, "var(--err, #e55)"));
    this.cardsEl.appendChild(card("warnings", warnings, "#e0a030"));
    this.cardsEl.appendChild(card("unused tags", s.unusedTags));
    this.cardsEl.appendChild(card("uncalled routines", s.uncalledRoutines));
    this.cardsEl.appendChild(card("unresolved operands", s.unresolvedOperands));
    this.cardsEl.appendChild(card("unused I/O points", s.unusedIoPoints));
    this.cardsEl.appendChild(card("routines", s.routines));
    this.cardsEl.appendChild(card("tags", (s.controllerTags || 0) + (s.programTags || 0)));
  };

  HealthPanel.prototype._renderFindings = function () {
    this.findingsEl.innerHTML = "";
    const findings = (this.report && this.report.findings) || [];
    if (!findings.length) {
      const ok = el("div", "health-ok", "\u2713 No findings.");
      ok.style.color = "#4c9";
      this.findingsEl.appendChild(ok);
      return;
    }
    const ul = el("ul", "health-finding-list");
    ul.style.cssText = "list-style:none;margin:0;padding:0;font-size:12.5px;";
    for (const f of findings) {
      const li = el("li", "health-finding sev-" + f.severity);
      li.style.cssText = "padding:2px 0;color:" +
        (f.severity === "error" ? "var(--err,#e55)" : f.severity === "warning" ? "#e0a030" : "var(--fg-dim,#999)") + ";";
      li.textContent = (f.severity || "info").toUpperCase() + " \u2014 " + f.message;
      ul.appendChild(li);
    }
    this.findingsEl.appendChild(ul);
  };

  HealthPanel.prototype._section = function (title, count, buildRows, opts) {
    opts = opts || {};
    const wrap = el("div", "health-section");
    wrap.style.cssText = "margin:10px 0;border:1px solid var(--border,#333);border-radius:6px;overflow:hidden;";
    const head = el("div", "health-section-head");
    head.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;" +
      "background:var(--bg2,#222);user-select:none;";
    const toggle = el("span", null, count ? "\u25b8" : "\u00a0");
    toggle.style.cssText = "color:var(--fg-dim,#999);width:12px;";
    head.appendChild(toggle);
    const t = el("span", null, title + " (" + count + ")");
    t.style.cssText = "font-weight:600;";
    head.appendChild(t);
    wrap.appendChild(head);
    const body = el("div", "health-section-body");
    body.style.cssText = "padding:6px 10px;";
    body.appendChild(buildRows());
    wrap.appendChild(body);
    if (opts.startOpen && count) {
      toggle.textContent = "\u25be";
    } else {
      body.style.display = "none";
    }
    head.addEventListener("click", function () {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      toggle.textContent = open ? "\u25b8" : "\u25be";
    });
    this.bodyEl.appendChild(wrap);
    return wrap;
  };

  HealthPanel.prototype._table = function (headers, rows, onRowClick) {
    if (!rows.length) {
      const none = el("div", "health-none", "(none)");
      none.style.cssText = "color:var(--fg-dim,#999);font-size:12px;";
      return none;
    }
    const wrap = el("div", "health-table-wrap");
    const table = el("table", "health-table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
    const thead = el("thead");
    const tr = el("tr");
    for (const h of headers) {
      const th = el("th", null, h);
      th.style.cssText = "text-align:left;padding:3px 6px;border-bottom:1px solid var(--border,#333);" +
        "color:var(--fg-dim,#999);font-weight:600;";
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = el("tbody");
    const shown = rows.slice(0, MAX_ROWS);
    shown.forEach(function (row, i) {
      const r = el("tr");
      if (onRowClick) {
        r.style.cursor = "pointer";
        r.title = "Open routine";
        r.addEventListener("click", function () { onRowClick(row, i); });
        r.addEventListener("mouseover", function () { r.style.background = "var(--bg3,#2a2a2a)"; });
        r.addEventListener("mouseout", function () { r.style.background = ""; });
      }
      row.forEach(function (cellValue, ci) {
        const td = el("td", null, cellValue === null || cellValue === undefined ? "" : String(cellValue));
        td.style.cssText = "padding:2px 6px;border-bottom:1px solid var(--border,#2a2a2a);word-break:break-all;" +
          (ci === 0 ? "font-family:'Cascadia Mono',Consolas,monospace;" : "");
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (rows.length > MAX_ROWS) {
      const note = el("div", "health-more", "\u2026 " + (rows.length - MAX_ROWS) + " more row(s) \u2014 export the report for the full list");
      note.style.cssText = "color:var(--fg-dim,#999);font-size:11px;padding:4px 0;";
      wrap.appendChild(note);
    }
    return wrap;
  };

  HealthPanel.prototype.render = function () {
    if (!this._built || !this.report) return;
    this._renderCards();
    this._renderFindings();
    this.bodyEl.innerHTML = "";
    const rep = this.report;
    const self = this;
    const openRoutine = function (program, routine) {
      if (typeof self.app.openRoutine === "function") self.app.openRoutine(program, routine);
      else if (typeof self.app.status === "function") self.app.status("Open routine: " + program + " / " + routine);
    };

    this._section("Unused tags", rep.unusedTags.length, function () {
      return self._table(["Tag", "Scope", "Data type", "Alias for"],
        rep.unusedTags.map(function (t) { return [t.name, t.scope, t.dataType, t.aliasFor || ""]; }));
    }, { startOpen: false });

    this._section("Unresolved operands", rep.unresolvedOperands.length, function () {
      return self._table(["Program", "Routine", "Operand", "Count"],
        rep.unresolvedOperands.map(function (u) { return [u.program, u.routine, u.operand, u.count]; }),
        function (row) { openRoutine(row[0], row[1]); });
    }, { startOpen: rep.unresolvedOperands.length > 0 });

    this._section("Uncalled routines", rep.uncalledRoutines.length, function () {
      return self._table(["Program", "Routine"],
        rep.uncalledRoutines.map(function (r) { return [r.program, r.routine]; }),
        function (row) { openRoutine(row[0], row[1]); });
    }, { startOpen: rep.uncalledRoutines.length > 0 });

    this._section("Empty routines", rep.emptyRoutines.length, function () {
      return self._table(["Program", "Routine"],
        rep.emptyRoutines.map(function (r) { return [r.program, r.routine]; }),
        function (row) { openRoutine(row[0], row[1]); });
    }, { startOpen: false });

    this._section("Unused I/O points", rep.unusedIoPoints.length, function () {
      return self._table(["Module", "Direction", "Point", "Address"],
        rep.unusedIoPoints.map(function (p) { return [p.moduleName, p.direction, p.point, p.address]; }));
    }, { startOpen: false });

    this._section("Add-on instruction usage", rep.aoiUsage.length, function () {
      return self._table(["Name", "Used by", "Definition found"],
        rep.aoiUsage.map(function (a) {
          return [a.name,
            (a.usedBy || []).map(function (u) { return u.program + " / " + u.routine; }).join(", "),
            a.definitionFound ? "yes" : "no"];
        }));
    }, { startOpen: false });
  };

  /* ---------------- export ---------------- */

  HealthPanel.prototype.exportMarkdown = function () {
    const ns = healthApi();
    if (!this.report) this.refresh();
    if (!this.report) return;
    const md = ns.toMarkdownReport(this.report);
    const projectName = (this.report.project && this.report.project.name) || "project";
    const fileName = String(projectName).replace(/[^A-Za-z0-9._-]+/g, "_") + "-health.md";
    try {
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      if (typeof this.app.status === "function") this.app.status("Health report exported: " + fileName);
    } catch (e) {
      if (typeof this.app.status === "function") this.app.status("Export failed: " + ((e && e.message) || e), true);
    }
    return md;
  };

  return { HealthPanel: HealthPanel };
});
