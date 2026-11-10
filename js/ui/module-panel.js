/* L5X Studio — Module I/O panel.
 *
 * Module-level dataflow view: for each module shows whether it is hardware (chassis
 * slot) or network (EtherNet/IP) I/O, its connection facts (IP, RPI, image sizes),
 * which image points and I/O bits are used, the tags/buffers and routines touching
 * them, and renders the result as an (offline-rendered) Mermaid diagram, a terminal
 * schematic, or bit-level tables. Provides Mermaid (.mmd / .svg), schematic SVG,
 * usage JSON and report Markdown downloads.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && module.exports;
  const USAGE = NODE ? require("../module-usage.js") : null;
  const MERMAID = NODE ? require("../mermaid-render.js") : null;

  function usage() { return NODE ? USAGE : (root.L5XStudio || {}); }
  function mermaid() { return NODE ? MERMAID : (root.L5XStudio || {}); }

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

  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    const m = Math.pow(10, d === undefined ? 0 : d);
    return String(Math.round(n * m) / m);
  }

  function safeStatus(app, msg, isError) {
    if (app && typeof app.status === "function") {
      try { app.status(msg, isError); } catch (e) { /* never break the view */ }
    }
  }

  /* Download a text blob from the browser; no-op under Node / stub DOM. */
  function downloadText(fileName, text, mime) {
    try {
      if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
      const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  function ModuleIoPanel(opts) {
    if (!(this instanceof ModuleIoPanel)) return new ModuleIoPanel(opts);
    opts = opts || {};
    this.container = opts.container || null;
    this.app = opts.app || {};
    this.selected = null;
    this.view = "mermaid";     // mermaid | schematic | bits
    this.projectView = false;
    this.showSpare = false;
    this.showWords = false;
    this.view = "mermaid";
    this.devnetFiles = [];     // attached parsed .dnt networks
    this.attachBridge = null;  // scanner bridge to attach a .dnt to when there are several
    this._devnet = [];
    this.search = "";
    this._analysis = null;
    this._analysisModel = null;
  }

  ModuleIoPanel.prototype.setContainer = function (container) { this.container = container; };

  ModuleIoPanel.prototype._devnetKey = function () {
    const files = this.app.dnts && this.app.dnts.length ? this.app.dnts : (this._devnet || []);
    return (this.app.dntStamp || 0) + "|" + files.map(function (f) { return f.fileName || "dnt"; }).join("|");
  };

  ModuleIoPanel.prototype._getAnalysis = function () {
    const model = this.app.model;
    if (!model) return null;
    if (this._analysis && this._analysisModel === model && this._analysisDevnet === this._devnetKey()) return this._analysis;
    const U = usage();
    const ns = this.app.ns ? this.app.ns() : (root && root.L5XStudio);
    try {
      let a = U.analyzeModules(model, {});
      const devnetFiles = (this.app.dnts && this.app.dnts.length) ? this.app.dnts : (this._devnet || []);
      if (devnetFiles.length && typeof U.mergeDeviceNetIntoAnalysis === "function") {
        a = U.mergeDeviceNetIntoAnalysis(a, devnetFiles, { bridge: this.attachBridge || null });
      }
      this._analysis = a;
      this._analysisModel = model;
      this._analysisDevnet = this._devnetKey();
      return this._analysis;
    } catch (e) {
      if (this.app && this.app.status) this.app.status("Module analysis failed: " + e.message, true);
      return null;
    }
  };

  ModuleIoPanel.prototype.invalidate = function () { this._analysis = null; this._analysisModel = null; };

  ModuleIoPanel.prototype.refresh = function () {
    if (!this.container) return;
    this.container.innerHTML = "";
    const self = this;
    const U = usage();
    if (typeof U.analyzeModules !== "function") {
      this.container.appendChild(h("div", "view-note", "Module usage analysis module is not loaded."));
      return;
    }
    if (!this.app.model) {
      this.container.appendChild(h("div", "view-note", "Open an L5X project first to see its module-level I/O dataflow."));
      return;
    }
    const analysis = this._getAnalysis();
    if (!analysis) return;
    const s = analysis.summary;

    /* toolbar */
    const toolbar = h("div", "view-toolbar");
    toolbar.appendChild(h("span", "view-title", "Module I/O \u00b7 dataflow"));
    toolbar.appendChild(h("span", "view-subtitle",
      s.modules + " modules \u00b7 " + s.network + " network \u00b7 " + s.hardware + " hardware \u00b7 " +
      s.subdevices + " sub-devices" + (s.unnamedModules ? " \u00b7 " + s.unnamedModules + " unnamed peripherals skipped" : "") + " \u00b7 " + s.usedPoints + "/" + s.totalPoints + " points used"));
    const search = h("input", "module-search", null, { type: "search", placeholder: "filter modules\u2026" });
    search.value = this.search;
    search.addEventListener("input", function () { self.search = search.value; self._renderList(listHost, analysis); });
    toolbar.appendChild(search);
    const projBtn = h("button", "btn btn-sm", this.projectView ? "Module detail" : "Project overview");
    projBtn.addEventListener("click", function () { self.projectView = !self.projectView; self.refresh(); });
    toolbar.appendChild(projBtn);
    const networkNames = ((analysis.summary && analysis.summary.networks) || []).map(function (n) { return n.bridge; });
    if (networkNames.length > 1) {
      const bridgeSel = h("select", "module-search");
      bridgeSel.title = "Which scanner bridge the attached DeviceNet file belongs to";
      const auto = h("option", null, "DeviceNet bridge: auto");
      auto.value = "";
      bridgeSel.appendChild(auto);
      for (const b of networkNames) {
        const o = h("option", null, b);
        o.value = b;
        if (self.attachBridge === b) o.selected = true;
        bridgeSel.appendChild(o);
      }
      bridgeSel.addEventListener("change", function () {
        self.attachBridge = bridgeSel.value || null;
        self._analysis = null;
        self._analysisDevnet = null;
        self.refresh();
      });
      toolbar.appendChild(bridgeSel);
    }
    const repBtn = h("button", "btn btn-sm", "Download report (.md)");
    repBtn.addEventListener("click", function () {
      const md = U.moduleReport(analysis, {});
      if (!downloadText("module-io-report.md", md, "text/markdown")) safeStatus(self.app, "Report download not available.", true);
      else safeStatus(self.app, "Module I/O report downloaded.");
    });
    toolbar.appendChild(repBtn);
    const jsonBtn = h("button", "btn btn-sm", "Download usage (.json)");
    jsonBtn.addEventListener("click", function () {
      const json = JSON.stringify(analysis, null, 1);
      if (!downloadText("module-usage.json", json, "application/json")) safeStatus(self.app, "JSON download not available.", true);
    });
    toolbar.appendChild(jsonBtn);
    /* attach DeviceNet network configuration (.dnt) so remote devices are part of the picture */
    const dntBtn = h("button", "btn btn-sm btn-accent", "Attach DeviceNet (.dnt)\u2026");
    dntBtn.title = "Attach an RSNetWorx .dnt file: its remote DeviceNet devices are merged into the module topology and inter-module flow.";
    const dntInput = h("input", null, null, { type: "file", accept: ".dnt", hidden: true });
    dntBtn.addEventListener("click", function () { try { dntInput.click(); } catch (e) { /* stub */ } });
    dntInput.addEventListener("change", function () {
      const f = dntInput.files && dntInput.files[0];
      if (f) self._attachDnt(f);
      dntInput.value = "";
    });
    toolbar.appendChild(dntBtn);
    toolbar.appendChild(dntInput);
    const attached = (this.app.dnts && this.app.dnts.length) ? this.app.dnts : this._devnet;
    if (attached.length) {
      const chip = h("span", "dnt-chip", "DeviceNet: " + attached.map(function (f) { return f.fileName; }).join(", "));
      chip.title = "Attached DeviceNet network configuration file(s)";
      toolbar.appendChild(chip);
    }
    this.container.appendChild(toolbar);

    const layout = h("div", "module-layout");
    const listHost = h("div", "module-list");
    const detailHost = h("div", "module-detail");
    layout.appendChild(listHost);
    layout.appendChild(detailHost);
    this.container.appendChild(layout);
    this._renderList(listHost, analysis);
    this._renderDetail(detailHost, analysis);
  };

  ModuleIoPanel.prototype._renderList = function (host, analysis) {
    const self = this;
    host.innerHTML = "";
    host.appendChild(h("div", "panel-title", "Modules"));
    const q = String(this.search || "").toLowerCase();
    const mods = analysis.modules.filter(function (m) {
      if (!q) return true;
      return (m.name + " " + m.catalogNumber + " " + m.kindLabel + " " + (m.ip || "")).toLowerCase().indexOf(q) !== -1;
    });
    if (!mods.length) { host.appendChild(h("div", "view-note", "No module matches the filter.")); return; }
    let lastKind = null;
    for (const m of mods) {
      if (m.kind !== lastKind) {
        host.appendChild(h("div", "module-kind-head", m.kind === "network" ? "Network I/O" :
          m.kind === "hardware" ? "Hardware I/O" : m.kind === "controller" ? "Controller" :
          m.kind === "devicenet" ? "DeviceNet remote devices (from .dnt)" : "Sub-devices"));
        lastKind = m.kind;
      }
      const row = h("button", "module-row" + (this.selected === m.name && !this.projectView ? " active" : ""));
      row.appendChild(h("span", "module-row-name", m.name));
      row.appendChild(h("span", "module-badge " + m.kind, m.kind === "network" ? "NET" : m.kind === "hardware" ? "HW" : m.kind === "controller" ? "CPU" : m.kind === "devicenet" ? "DN" : "SUB"));
      const used = m.summary.usedPoints;
      row.appendChild(h("span", "module-row-meta",
        (m.ip ? m.ip : m.slot !== null && m.slot !== undefined ? "slot " + m.slot : "") +
        (used ? " \u00b7 " + used + "/" + m.summary.totalPoints : "")));
      (function (name) {
        row.addEventListener("click", function () { self.selected = name; self.projectView = false; self.refresh(); });
      })(m.name);
      host.appendChild(row);
    }
  };

  ModuleIoPanel.prototype._renderDetail = function (host, analysis) {
    host.innerHTML = "";
    if (this.projectView) { this._renderProject(host, analysis); return; }
    const mod = analysis.modules.find(function (m) { return m.name === this.selected; }, this) ||
      analysis.modules.find(function (m) { return m.summary.usedPoints > 0; }) || analysis.modules[0];
    if (!mod) { host.appendChild(h("div", "view-note", "No modules in this project.")); return; }
    this.selected = mod.name;
    const self = this;

    const head = h("div", "module-head");
    head.appendChild(h("span", "module-title", mod.name));
    head.appendChild(h("span", "module-badge " + mod.kind, mod.kindLabel));
    head.appendChild(h("span", "module-cat", mod.catalogNumber));
    if (mod.inhibited) head.appendChild(h("span", "pill warn", "inhibited"));
    host.appendChild(head);
    const facts = h("div", "module-facts");
    const fact = function (label, value) {
      const f = h("div", "module-fact");
      f.appendChild(h("span", "module-fact-label", label));
      f.appendChild(h("span", "module-fact-value", value === null || value === undefined || value === "" ? "-" : String(value)));
      facts.appendChild(f);
    };
    fact("Protocol", mod.protocol);
    fact("EtherNet/IP address", mod.ip);
    fact("Chassis slot", mod.slot);
    fact("RPI", mod.rpi ? mod.rpi + " \u00b5s" : null);
    fact("Connection", mod.connectionName);
    fact("Transport", mod.transportLabel || (mod.kind === "network" ? "EtherNet/IP network I/O" : mod.kind === "hardware" ? "Local chassis I/O" : mod.protocol));
    fact("Word transport", mod.wordTransport || (mod.kind === "network" ? "network word over EtherNet/IP" : "local"));
    if (mod.devicenet) {
      fact("DeviceNet MAC", mod.macId);
      fact("Transfer", mod.transferType || (mod.rpi ? "DeviceNet" : null));
      fact("DNT file", mod.deviceFile);
    }
    fact("Image", "in " + fmt(mod.inputBytes) + " B / out " + fmt(mod.outputBytes) + " B");
    fact("I/O bits", mod.summary.usedInputBits + "/" + mod.summary.totalInputBits + " in, " +
      mod.summary.usedOutputBits + "/" + mod.summary.totalOutputBits + " out" +
      (mod.summary.wordMappedInputBits || mod.summary.wordMappedOutputBits ? " (+word-mapped " +
        (mod.summary.wordMappedInputBits || 0) + "/" + (mod.summary.wordMappedOutputBits || 0) + ")" : ""));
    host.appendChild(facts);

    const tabs = h("div", "subtab-bar");
    const defs = [
      { id: "mermaid", label: "Module diagram" },
      { id: "intermodule", label: "Inter-module flow" },
      { id: "schematic", label: "Terminal schematic" },
      { id: "bits", label: "Bit map" }
    ];
    const tabBtns = {};
    for (const d of defs) {
      const b = h("button", "subtab-btn" + (this.view === d.id ? " active" : ""), d.label);
      (function (id) {
        b.addEventListener("click", function () {
          self.view = id;
          for (const k of Object.keys(tabBtns)) tabBtns[k].className = "subtab-btn" + (k === id ? " active" : "");
          self._renderBody(body, analysis, mod);
        });
      })(d.id);
      tabBtns[d.id] = b;
      tabs.appendChild(b);
    }
    host.appendChild(tabs);
    const body = h("div", "subtab-body");
    host.appendChild(body);
    this._renderBody(body, analysis, mod);
  };

  ModuleIoPanel.prototype._renderBody = function (body, analysis, mod) {
    body.innerHTML = "";
    const self = this;
    const U = usage();
    const MER = mermaid();
    if (this.view === "mermaid") {
      const text = U.moduleMermaid(analysis, mod.name, { showSpare: this.showSpare });
      this._mermaidView(body, text, "module-" + mod.name, {
        hint: "Drag to pan \u00b7 wheel to zoom \u00b7 Fit resets. Routines per bit are listed in the Bit map tab.",
        toggles: [{
          label: "show spare bits",
          checked: !!this.showSpare,
          onChange: function (v) { self.showSpare = v; self._renderBody(body, analysis, mod); }
        }]
      });
      if (mod.kind === "network" || mod.kind === "hardware" || mod.kind === "devicenet") {
        body.appendChild(h("div", "view-note",
          "Legend: green = bits referenced in logic, blue = image word used (image words are exchanged over " +
          (mod.fieldBus || (mod.kind === "network" ? "EtherNet/IP" : "the backplane")) +
          " \u2014 exact bit ownership is resolved at runtime by the mapping offsets), grey = spare. " +
          "Rockwell CAD models cannot be embedded offline; the Terminal schematic tab is the connection view."));
      }
      return;
    }
    if (this.view === "intermodule") {
      this._renderInterModule(body, analysis);
      return;
    }
    if (this.view === "schematic") {
      const svg = U.moduleSchematicSvg(analysis, mod.name, {});
      const bar = h("div", "module-subbar");
      const dlBtn = h("button", "btn btn-sm", "Download .svg");
      dlBtn.addEventListener("click", function () {
        if (!downloadText("module-" + mod.name + "-schematic.svg", svg, "image/svg+xml")) safeStatus(self.app, "Download not available.", true);
      });
      bar.appendChild(dlBtn);
      bar.appendChild(h("span", "view-hint", "Front-panel terminal view: used channels are wired, spares left grey."));
      body.appendChild(bar);
      const host = h("div", "schematic-host");
      host.innerHTML = svg;
      body.appendChild(host);
      return;
    }
    /* bit map */
    const wrap = h("div", "module-bits");
    const section = function (title, bits) {
      const box = h("div", "module-bit-section");
      box.appendChild(h("div", "panel-title", title));
      if (!bits.length) { box.appendChild(h("div", "view-note", "This module has no discrete points for this direction.")); wrap.appendChild(box); return; }
      const table = h("table", "data-table");
      const thr = h("tr");
      ["Bit", "Address", "Status", "Usage / tags", "Routines"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      for (const b of bits) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", String(b.bit)));
        tr.appendChild(h("td", "mono", b.address));
        tr.appendChild(h("td", null, b.used ? "used" : b.wordUsed ? ("word-mapped \u00b7 " + (mod.wordTransport || "network word")) : "spare"));
        tr.appendChild(h("td", null, (b.how || []).join("; ")));
        tr.appendChild(h("td", "mono", (b.references || []).map(function (r) { return r.program + "/" + r.routine; })
          .filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4).join(", ")));
        table.appendChild(tr);
      }
      box.appendChild(table);
      wrap.appendChild(box);
    };
    section("Discrete inputs (" + mod.name + ":I.Data)", mod.inputBits);
    section("Discrete outputs (" + mod.name + ":O.Data)", mod.outputBits);

    if ((mod.buffers || []).length) {
      const box = h("div", "module-bit-section");
      box.appendChild(h("div", "panel-title", "Word mapping (image \u2192 buffer tags)"));
      const table = h("table", "data-table");
      const thr = h("tr");
      ["Direction", "Member", "Buffer", "Expression", "Routine"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      for (const b of mod.buffers) {
        const tr = h("tr");
        tr.appendChild(h("td", null, b.direction));
        tr.appendChild(h("td", "mono", b.member));
        tr.appendChild(h("td", "mono", b.buffer));
        tr.appendChild(h("td", "mono", b.expression));
        tr.appendChild(h("td", "mono", b.routine));
        table.appendChild(tr);
      }
      box.appendChild(table);
      wrap.appendChild(box);
    }
    if (mod.devicenet) {
      const box = h("div", "module-bit-section");
      box.appendChild(h("div", "panel-title", "DeviceNet node (from the attached .dnt)"));
      box.appendChild(h("div", "view-hint",
        "MAC " + mod.macId + " \u00b7 " + (mod.transferType || "DeviceNet") + " \u00b7 " + mod.name +
        (mod.deviceFile ? " \u00b7 " + mod.deviceFile : "")));
      const words = (mod.l5xInputWords || []).concat(mod.l5xOutputWords || []);
      if (words.length) {
        const table = h("table", "data-table");
        const thr = h("tr");
        ["L5X image word", "Used by logic", "References"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
        table.appendChild(thr);
        for (const w of words) {
          const tr = h("tr");
          tr.appendChild(h("td", "mono", w.address));
          tr.appendChild(h("td", null, w.used ? "yes" : "no"));
          tr.appendChild(h("td", "mono", (w.references || []).map(function (r) { return r.program + "/" + r.routine; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 3).join(", ")));
          table.appendChild(tr);
        }
        box.appendChild(table);
      } else {
        box.appendChild(h("div", "view-note", "No scanner image mapping available (the L5X bridge has no Data[] image points or the .dnt has no scanner scanlist)."));
      }
      wrap.appendChild(box);
    }
    if ((mod.tagRefs || []).length) {
      const box = h("div", "module-bit-section");
      box.appendChild(h("div", "panel-title", "Point references"));
      const table = h("table", "data-table");
      const thr = h("tr");
      ["Address", "Reads", "Writes", "Routines"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      for (const r of mod.tagRefs) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", r.address));
        tr.appendChild(h("td", null, fmt(r.reads)));
        tr.appendChild(h("td", null, fmt(r.writes)));
        tr.appendChild(h("td", "mono", (r.routines || []).slice(0, 4).join(", ")));
        table.appendChild(tr);
      }
      box.appendChild(table);
      wrap.appendChild(box);
    }
    body.appendChild(wrap);
  };

  /* Inter-module communication flow: controller -> bridges -> remote I/O (+ attached .dnt devices) */
  ModuleIoPanel.prototype._renderInterModule = function (body, analysis) {
    const self = this;
    const U = usage();
    const text = U.interModuleMermaid(analysis, { includeWords: !!this.showWords });
    const bar = h("div", "module-subbar");
    const wordsWrap = h("label", "module-check");
    const wordsChk = h("input", null, null, { type: "checkbox" });
    wordsChk.checked = !!this.showWords;
    wordsChk.addEventListener("change", function () { self.showWords = wordsChk.checked; self._renderInterModule(body, analysis); });
    wordsWrap.appendChild(wordsChk);
    wordsWrap.appendChild(h("span", null, " show I/O word transport"));
    bar.appendChild(wordsWrap);
    body.appendChild(bar);
    const s = analysis.summary || {};
    const summary = h("div", "module-bit-section");
    summary.appendChild(h("div", "panel-title", "Communication summary"));
    const chips = h("div", "comm-summary");
    const chip = function (label, value) {
      const c = h("div", "comm-chip");
      c.appendChild(h("span", "comm-chip-label", label));
      c.appendChild(h("span", "comm-chip-value", value === undefined || value === null || value === "" ? "-" : String(value)));
      chips.appendChild(c);
    };
    chip("Controller", analysis.controller || "?");
    chip("Fieldbus bridges", s.bridges || 0);
    chip("EtherNet/IP devices", s.directEthernetDevices || 0);
    chip("DeviceNet files", this._devnet.length ? this._devnet.map(function (f) { return f.fileName; }).join(", ") : "none attached");
    if (analysis.devnet) chip("DeviceNet devices", (analysis.devnet.devices || []).length);
    summary.appendChild(chips);
    const nets = (s.networks || []);
    if (nets.length) {
      const table = h("table", "data-table");
      const thr = h("tr");
      ["Bridge", "Bus", "Slot / IP", "RPI (\u00b5s)", "Remote devices", "Image points", "Scan list"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
      table.appendChild(thr);
      for (const n of nets) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", n.bridge));
        tr.appendChild(h("td", null, n.bus || "-"));
        tr.appendChild(h("td", "mono", n.slot !== null && n.slot !== undefined ? "slot " + n.slot : (n.ip || "-")));
        tr.appendChild(h("td", "mono", n.rpi || "-"));
        tr.appendChild(h("td", null, String(n.deviceCount)));
        tr.appendChild(h("td", "mono", String(n.imagePoints || 0)));
        tr.appendChild(h("td", null, n.scanListInL5x ? "in L5X" : "not in L5X \u2014 attach .dnt"));
        table.appendChild(tr);
      }
      summary.appendChild(table);
    }
    if (analysis.devnet) {
      const dn = analysis.devnet;
      const dbox = h("div", "module-bit-section");
      dbox.appendChild(h("div", "panel-title", "DeviceNet network" + (dn.bridge ? " \u2014 attached to " + dn.bridge : "")));
      if (dn.scannerInfo) {
        dbox.appendChild(h("div", "view-hint",
          "Scanner config from the .dnt: EPR " + (dn.scannerInfo.eprMs || "?") + " ms \u00b7 interscan " +
          (dn.scannerInfo.interscanDelayMs || "?") + " ms \u00b7 poll ratio " + (dn.scannerInfo.pollRatio || "?") +
          " \u00b7 retries " + (dn.scannerInfo.transmitRetries || "?") +
          (dn.l5xWordPlan && dn.l5xWordPlan.input ? " \u00b7 L5X image word " + dn.l5xWordPlan.input.bits + "-bit (" + dn.l5xWordPlan.input.count + " words)" : "")));
      }
      const dtable = h("table", "data-table");
      const dthr = h("tr");
      ["MAC", "Name", "Catalog", "Transfer", "I/O bytes", "L5X image words", "Used"].forEach(function (t) { dthr.appendChild(h("th", null, t)); });
      dtable.appendChild(dthr);
      for (const d of dn.devices) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", d.macId !== undefined ? String(d.macId) : "-"));
        tr.appendChild(h("td", null, d.name || ""));
        tr.appendChild(h("td", "mono", d.catalogNumber || "-"));
        tr.appendChild(h("td", null, d.transferType || "-"));
        tr.appendChild(h("td", "mono", (d.inputBytes !== undefined ? d.inputBytes : "?") + " / " + (d.outputBytes !== undefined ? d.outputBytes : "?")));
        tr.appendChild(h("td", "mono", [d.l5xInputRange, d.l5xOutputRange].filter(Boolean).join(" | ") || "-"));
        tr.appendChild(h("td", null, d.l5xWordsUsed !== undefined ? String(d.l5xWordsUsed) : "-"));
        dtable.appendChild(tr);
      }
      dbox.appendChild(dtable);
      summary.appendChild(dbox);
    }
    body.appendChild(summary);
    this._mermaidView(body, text, "inter-module", {
      hint: "Controller \u2192 bridges \u2192 remote I/O. Drag to pan \u00b7 wheel to zoom. Attach the matching DeviceNet .dnt file to include its remote devices."
    });
  };

  /* Shared Mermaid view: rendered SVG in a pannable/zoomable viewport + copy/download/zoom controls. */
  ModuleIoPanel.prototype._mermaidView = function (body, text, baseName, opts) {
    opts = opts || {};
    const Z = (typeof root !== "undefined" && root && root.L5XStudio && root.L5XStudio.buildMermaidView)
      ? root.L5XStudio : null;
    if (Z) {
      return Z.buildMermaidView(body, text, mermaid(), {
        baseName: baseName,
        toggles: opts.toggles || [],
        hint: opts.hint,
        app: this.app
      });
    }
    /* fallback (no shared helper): render into a plain host */
    const bar = h("div", "module-subbar");
    const dlBtn = h("button", "btn btn-sm", "Download .mmd");
    dlBtn.addEventListener("click", function () { downloadText(baseName + ".mmd", text, "text/plain"); });
    bar.appendChild(dlBtn);
    body.appendChild(bar);
    const host = h("div", "mermaid-host");
    body.appendChild(host);
    try { mermaid().renderInto(host, text); } catch (e) { host.appendChild(h("div", "view-note", "Mermaid render failed: " + e.message)); }
    const det = h("details", "mermaid-text");
    det.appendChild(h("summary", null, "Mermaid source"));
    const pre = h("pre", "routine-text");
    pre.textContent = text;
    det.appendChild(pre);
    body.appendChild(det);
    return null;
  };
  ModuleIoPanel.prototype._attachDnt = function (file) {
    const self = this;
    const ns = (typeof window !== "undefined" && window.L5XStudio) ? window.L5XStudio
      : (typeof root !== "undefined" && root && root.L5XStudio) ? root.L5XStudio : {};
    const handle = function (buffer) {
      if (typeof ns.parseDnt !== "function") {
        safeStatus(self.app, "DNT parser is not available in this build.", true);
        return;
      }
      try {
        const res = ns.parseDnt(buffer) || {};
        res.fileName = file && file.name ? file.name : "network.dnt";
        if (self.app && typeof self.app.openDnt === "function") {
          self.app.openDnt(res.fileName, buffer);
          self._analysis = null;
          self._analysisDevnet = null;
          safeStatus(self.app, "Attached " + res.fileName + ": " + ((res.devices || []).length) +
            " DeviceNet device(s) merged into the module topology.");
          self.refresh();
        } else {
          self._devnet.push(res);
          self._analysis = null;
          self._analysisDevnet = null;
          safeStatus(self.app, "Attached " + res.fileName + ": " + ((res.devices || []).length) +
            " DeviceNet device(s) merged into the module topology.");
          self.refresh();
        }
      } catch (e) {
        safeStatus(self.app, "DNT parse failed: " + e.message, true);
      }
    };
    try {
      if (file && typeof file.arrayBuffer === "function") {
        file.arrayBuffer().then(handle, function () { safeStatus(self.app, "Could not read " + (file && file.name) + ".", true); });
      } else if (file && typeof FileReader !== "undefined") {
        const fr = new FileReader();
        fr.onload = function () { handle(fr.result); };
        fr.onerror = function () { safeStatus(self.app, "Could not read " + (file && file.name) + ".", true); };
        fr.readAsArrayBuffer(file);
      } else {
        safeStatus(self.app, "This environment cannot read .dnt files.", true);
      }
    } catch (e) {
      safeStatus(self.app, "DNT attach failed: " + e.message, true);
    }
  };

  ModuleIoPanel.prototype._renderProject = function (host, analysis) {
    const self = this;
    const U = usage();
    host.appendChild(h("div", "panel-title", "Project module network \u2014 " + (analysis.controller || "controller")));
    const s = analysis.summary;
    host.appendChild(h("div", "view-hint",
      s.modules + " modules: " + s.network + " EtherNet/IP network I/O, " + s.hardware + " chassis hardware I/O, " +
      (s.subdevices || 0) + " sub-devices" + (s.bridges ? ", " + s.bridges + " fieldbus bridge(s)" : "") +
      ". Drag to pan, wheel to zoom."));
    const body = h("div", "subtab-body");
    host.appendChild(body);
    this._mermaidView(body, U.projectMermaid(analysis), "project-modules", {
      hint: "Module-level network overview; use the Inter-module flow tab for protocol/bridge detail."
    });
  };

  return { ModuleIoPanel: ModuleIoPanel };
});
