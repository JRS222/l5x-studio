/* L5X Studio - ui/validation-panel.js (T1)
   Schema validation panel: schema version selector, "Validate loaded project" button,
   status line (ok / errors / warnings) and a grouped issue list (errors first).

   DOM-only panel class; requiring this file in Node never touches document.
   Pure helpers (groupIssues / formatValidationSummary) are exported for Node tests.

   Usage: new L5XStudio.ValidationPanel({ container, app })
     app hooks: model, status(msg, err), getValidationResult(), setValidationResult(result),
                runValidation(version?)  (Lead-owned pipeline: validateModel + store + rerender)
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && !!module.exports;

  /* ---------- pure helpers (Node-safe) ---------- */

  function summarize(result) {
    if (NODE) {
      const sv = require("../schema-validate.js");
      return sv.summarizeResult(result);
    }
    const ns = (root && root.L5XStudio) || {};
    if (ns.summarizeResult) return ns.summarizeResult(result);
    return {
      errors: (result && result.errors ? result.errors.length : 0),
      warnings: (result && result.warnings ? result.warnings.length : 0),
      ok: !(result && result.errors && result.errors.length)
    };
  }

  /* Group a validation result into [{severity,label,items}] with errors first. */
  function groupIssues(result) {
    const errors = (result && result.errors) || [];
    const warnings = (result && result.warnings) || [];
    const groups = [];
    if (errors.length) groups.push({ severity: "error", label: "Errors", items: errors.slice() });
    if (warnings.length) groups.push({ severity: "warning", label: "Warnings", items: warnings.slice() });
    return groups;
  }

  /* One-line human summary, e.g. "schema v32: 0 errors, 1 warning". */
  function formatValidationSummary(result) {
    const sum = summarize(result);
    const version = (result && result.stats && result.stats.version) ||
      (result && result.schemaVersion) || "?";
    const ew = sum.errors === 1 ? "error" : "errors";
    const ww = sum.warnings === 1 ? "warning" : "warnings";
    const truncated = !!(result && result.stats && result.stats.truncated);
    return "schema " + version + ": " + sum.errors + " " + ew + ", " + sum.warnings + " " + ww +
      (truncated ? " (issue list truncated)" : "");
  }

  /* ---------- DOM helpers ---------- */

  function h(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "onclick") e.addEventListener("click", attrs[k]);
        else if (k === "title") e.title = attrs[k];
        else if (k === "style") e.setAttribute("style", attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    return e;
  }

  function validationApi() {
    if (NODE) {
      try { return require("../schema-validate.js"); } catch (e) { return {}; }
    }
    return ((root && root.L5XStudio) || {});
  }

  /* ---------- panel ---------- */

  function ValidationPanel(opts) {
    if (!(this instanceof ValidationPanel)) return new ValidationPanel(opts);
    opts = opts || {};
    this.app = opts.app || {};
    this.container = opts.container || null;
    this.result = null;
    this._built = false;
    this._build();
  }

  ValidationPanel.prototype._build = function () {
    const container = this.container;
    if (!container || typeof document === "undefined") return;
    container.innerHTML = "";

    const wrap = h("div", "validation-panel",
      null, { style: "display:flex;flex-direction:column;min-height:0;height:100%;" });
    const toolbar = h("div", "validation-toolbar",
      null, { style: "display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);flex:0 0 auto;flex-wrap:wrap;" });
    toolbar.appendChild(h("span", "validation-label", "Schema",
      { style: "color:var(--fg-dim);font-size:12.5px;" }));

    const select = h("select", "validation-schema",
      null, { style: "background:var(--bg2);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:12.5px;" });
    const api = validationApi();
    const versions = typeof api.availableSchemaVersions === "function"
      ? api.availableSchemaVersions() : [];
    select.appendChild(h("option", null, "Auto (detect)", { value: "" }));
    if (versions.length) {
      for (const v of versions) select.appendChild(h("option", null, v, { value: v }));
    } else {
      select.appendChild(h("option", null, "no schemas loaded", { value: "" }));
      select.disabled = true;
    }
    toolbar.appendChild(select);

    const button = h("button", "btn btn-primary", "Validate loaded project");
    toolbar.appendChild(button);
    wrap.appendChild(toolbar);

    const statusEl = h("div", "validation-status",
      null, { style: "padding:8px 12px;font-size:12.5px;border-bottom:1px solid var(--border);flex:0 0 auto;color:var(--fg-dim);" });
    wrap.appendChild(statusEl);

    const listEl = h("div", "validation-issues",
      null, { style: "padding:6px 12px 12px;overflow:auto;flex:1 1 auto;min-height:0;font-size:12px;" });
    wrap.appendChild(listEl);

    container.appendChild(wrap);

    this._select = select;
    this._statusEl = statusEl;
    this._listEl = listEl;
    this._button = button;
    this._built = true;

    const self = this;
    button.addEventListener("click", function () { self.runValidation(); });
    select.addEventListener("change", function () {
      if (self.result || (self.app && typeof self.app.getValidationResult === "function" && self.app.getValidationResult())) {
        self.runValidation();
      }
    });

    this.refresh();
  };

  ValidationPanel.prototype.getSelectedVersion = function () {
    if (!this._select) return null;
    return this._select.value || null;
  };

  /* Run validation: prefer the Lead-owned pipeline hook, otherwise validate locally.
     "" / null version = Auto (pick from the project's SoftwareRevision). */
  ValidationPanel.prototype.runValidation = function () {
    const app = this.app || {};
    const api = validationApi();
    const version = this.getSelectedVersion();
    let result = null;
    if (typeof app.runValidation === "function") {
      const out = app.runValidation(version || undefined);
      if (out && (out.errors || out.ok !== undefined)) result = out;
      else if (typeof app.getValidationResult === "function") result = app.getValidationResult();
      /* The Lead pipeline may ignore a requested schema version: honour an explicit
         selection here (the app stores last result through setValidationResult). */
      if (version && result && result.stats && result.stats.version &&
          result.stats.version !== version && app.model && typeof api.validateModel === "function") {
        const requested = api.validateModel(app.model, { version: version });
        if (typeof app.setValidationResult === "function") app.setValidationResult(requested);
        if (typeof app.status === "function") {
          const sum = summarize(requested);
          app.status(formatValidationSummary(requested), sum.errors > 0);
        }
        result = requested;
      }
    } else if (app.model && typeof api.validateModel === "function") {
      result = api.validateModel(app.model, version ? { version: version } : undefined);
      if (typeof app.setValidationResult === "function") app.setValidationResult(result);
      if (typeof app.status === "function") {
        const sum = summarize(result);
        app.status(formatValidationSummary(result), sum.errors > 0);
      }
    } else {
      if (typeof app.status === "function") app.status("Load an L5X project first.", true);
    }
    if (result) this.result = result;
    this.refresh(result);
    return result;
  };

  /* Re-render from the stored result (app.getValidationResult first). */
  ValidationPanel.prototype.refresh = function (overrideResult) {
    if (!this._built) return;
    const app = this.app || {};
    let result = overrideResult || this.result;
    if (typeof app.getValidationResult === "function") {
      const stored = app.getValidationResult();
      if (stored) result = stored;
    }
    if (!result) {
      this._statusEl.textContent = "Not validated yet \u2014 click \u201cValidate loaded project\u201d.";
      this._statusEl.style.color = "var(--fg-dim)";
      this._listEl.innerHTML = "";
      return;
    }
    this.result = result;
    this._renderStatus(result);
    this._renderIssues(result);
  };

  ValidationPanel.prototype._renderStatus = function (result) {
    const sum = summarize(result);
    const version = (result.stats && result.stats.version) || result.schemaVersion || "";
    if (this._select && this._select.value && version && this._select.value !== version) {
      this._select.value = version;
    }
    const el = this._statusEl;
    el.textContent = formatValidationSummary(result);
    if (sum.errors > 0) el.style.color = "var(--err)";
    else if (sum.warnings > 0) el.style.color = "var(--write)";
    else el.style.color = "var(--read)";
    const file = result.stats && result.stats.fileName;
    if (file) el.textContent = file + " \u2014 " + el.textContent;
  };

  ValidationPanel.prototype._renderIssues = function (result) {
    const list = this._listEl;
    list.innerHTML = "";
    const groups = groupIssues(result);
    if (!groups.length) {
      list.appendChild(h("div", null, "No schema issues found. \u2713",
        { style: "color:var(--read);padding:6px 0;" }));
      return;
    }
    for (const group of groups) {
      const head = h("div", "validation-group-title",
        group.label + " (" + group.items.length + ")",
        { style: "font-weight:700;margin:8px 0 4px;color:" +
          (group.severity === "error" ? "var(--err)" : "var(--write)") + ";" });
      list.appendChild(head);
      for (const issue of group.items) {
        const row = h("div", "validation-issue validation-issue-" + group.severity,
          null, { style: "display:flex;gap:8px;padding:2px 0;align-items:baseline;" });
        row.appendChild(h("span", "validation-issue-code", issue.code || "",
          { style: "flex:0 0 auto;font-family:'Cascadia Mono',Consolas,monospace;font-size:10.5px;opacity:.75;min-width:118px;" }));
        row.appendChild(h("span", "validation-issue-path", issue.path || "",
          { style: "flex:0 0 auto;color:var(--accent);font-family:'Cascadia Mono',Consolas,monospace;font-size:11.5px;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
            title: issue.path || "" }));
        row.appendChild(h("span", "validation-issue-msg", issue.message || "",
          { style: "flex:1 1 auto;color:var(--fg);" }));
        list.appendChild(row);
      }
    }
  };

  return {
    ValidationPanel: ValidationPanel,
    groupIssues: groupIssues,
    formatValidationSummary: formatValidationSummary
  };
});
