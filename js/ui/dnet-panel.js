/* L5X Studio — DeviceNet network panel (.dnt).
 *
 * Standalone view for an RSNetWorx DeviceNet network file: scanner configuration, the node
 * table (MAC / name / catalog / transfer / I/O sizes / scan-list bit offsets), per-node EDS
 * parameters and — when an L5X project is open — the merged view with the scanner's L5X image
 * words. 1799-ZCIOV nodes are flagged as running local logic on the card (network inputs in,
 * local zone logic out), which is the pattern the user described for SAMPLE_ST-style systems.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && module.exports;
  const DNET = NODE ? require("../dnet.js") : null;
  const MERMAID = NODE ? require("../mermaid-render.js") : null;
  const USAGE = NODE ? require("../module-usage.js") : null;
  const ZOOM = NODE ? require("./zoom-view.js") : null;

  function dnet() { return NODE ? DNET : (root.L5XStudio || {}); }
  function zoomView() { return NODE ? ZOOM : (root.L5XStudio || {}); }
  function hasUsage() { const u = usage(); return !!(u && typeof u.analyzeModules === "function" && typeof u.mergeDeviceNetIntoAnalysis === "function"); }
  function htmlReport() { return NODE ? require("../dnet-html.js") : (root.L5XStudio || {}); }
  function mermaid() { return NODE ? MERMAID : (root.L5XStudio || {}); }
  function usage() { return NODE ? USAGE : (root.L5XStudio || {}); }

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
  function safeStatus(app, msg, isError) {
    if (app && typeof app.status === "function") { try { app.status(msg, isError); } catch (e) { /* noop */ } }
  }
  function downloadText(fileName, text, mime) {
    try {
      if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
      const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      return true;
    } catch (e) { return false; }
  }

  /* Mermaid text for one DeviceNet network: scanner -> nodes, protocol colours, local-logic marks. */
  function networkMermaid(parsed, opts) {
    opts = opts || {};
    const L = [];
    L.push("flowchart LR");
    L.push("  classDef scanner fill:#0d47a1,stroke:#64b5f6,color:#fff,stroke-width:2px");
    L.push("  classDef polled fill:#1b5e20,stroke:#66bb6a,color:#fff");
    L.push("  classDef cos fill:#1565c0,stroke:#42a5f5,color:#fff");
    L.push("  classDef logic fill:#3e1a5e,stroke:#ba68c8,color:#fff");
    L.push("  classDef netdn fill:#6d3d00,stroke:#ff9800,color:#fff");
    const name = (parsed.network && parsed.network.name) || (parsed.fileName || "DeviceNet network");
    const si = parsed.scannerInfo;
    const S = "SCANNER";
    const sLines = [name, "DeviceNet network"];
    if (si) sLines.push("EPR " + (si.eprMs || "?") + " ms \u00b7 interscan " + (si.interscanDelayMs || "?") + " ms" + "\u00b7 poll ratio " + (si.pollRatio || "?"));
    L.push("  " + S + "[\"" + sLines.map(function (x) { return String(x).replace(/"/g, "'").replace(/\n/g, "<br/>"); }).join("<br/>") + "\"]:::scanner");
    const seen = {};
    for (const d of (parsed.devices || [])) {
      const id = "DN" + d.macId;
      if (seen[id]) continue;
      seen[id] = true;
      const isZciov = /1799-ZCIOV/i.test(d.catalogNumber || "");
      const lines = [d.name || ("Node " + d.macId), (d.catalogNumber || "device"), "MAC " + d.macId];
      if (d.transferType) lines.push(d.transferType);
      if (d.inputBytes !== undefined) lines.push("in " + d.inputBytes + " B" + (d.inputBitOffset ? " @bit " + d.inputBitOffset : "") + " \u00b7 out " + (d.outputBytes !== undefined ? d.outputBytes : "?") + " B");
      if (opts.l5x && d.l5xInputRange) lines.push("L5X " + d.l5xInputRange);
      if (isZciov) lines.push("\u2699 local logic (zone card)");
      const cls = isZciov ? "logic" : /poll/i.test(d.transferType || "") ? "polled" : "cos";
      L.push("  " + id + "[\"" + lines.map(function (x) { return String(x).replace(/"/g, "'"); }).join("<br/>") + "\"]:::" + cls);
      L.push("  " + S + " -->|\"DeviceNet \u00b7 MAC " + d.macId + "\"| " + id);
      if (isZciov) {
        const netNode = "NET_" + d.macId;
        L.push("  " + netNode + "[\"network words\u2192 local logic\":::netdn]");
        L.push("  " + id + " --> " + netNode);
      }
    }
    return L.join("\n") + "\n";
  }

  function DeviceNetPanel(opts) {
    if (!(this instanceof DeviceNetPanel)) return new DeviceNetPanel(opts);
    opts = opts || {};
    this.container = opts.container || null;
    this.app = opts.app || {};
    this.selectedMac = null;
  }

  DeviceNetPanel.prototype.setContainer = function (c) { this.container = c; };
  DeviceNetPanel.prototype._networks = function () {
    const fromApp = this.app.dnts;
    if (fromApp && fromApp.length) return fromApp;
    return [];
  };

  DeviceNetPanel.prototype.refresh = function () {
    if (!this.container) return;
    this.container.innerHTML = "";
    const self = this;
    const D = dnet();
    const MER = mermaid();
    const networks = this._networks();
    const model = this.app.model;

    const toolbar = h("div", "view-toolbar");
    toolbar.appendChild(h("span", "view-title", "DeviceNet networks (.dnt)"));
    toolbar.appendChild(h("span", "view-subtitle", networks.length
      ? networks.length + " network(s) \u00b7 " + networks.reduce(function (a, n) { return a + (n.devices || []).length; }, 0) + " devices"
      : "no network file loaded"));
    const attach = h("button", "btn btn-sm btn-accent", "Open DeviceNet (.dnt)\u2026");
    const input = h("input", null, null, { type: "file", accept: ".dnt", hidden: true });
    attach.addEventListener("click", function () { try { input.click(); } catch (e) { /* stub */ } });
    input.addEventListener("change", function () {
      const f = input.files && input.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = function () {
        try { self.app.openDnt(f.name, fr.result); } catch (e) { safeStatus(self.app, "DNT open failed: " + e.message, true); }
        input.value = "";
      };
      fr.readAsArrayBuffer(f);
    });
    toolbar.appendChild(attach);
    toolbar.appendChild(input);
    if (self.app && typeof self.app.openDnetHtmlFile === "function") {
      const logicBtn = h("button", "btn btn-sm", "Open logic export (.html)\u2026");
      logicBtn.title = "Open the RSNetWorx Export-to-HTML report to view the cards decoded function-block logic";
      logicBtn.addEventListener("click", function () { self.app.openDnetHtmlFile(); });
      toolbar.appendChild(logicBtn);
    }
    for (const n of networks) {
      const chip = h("button", "btn btn-sm", n.fileName + (n === self._activeNet() ? " \u2713" : ""));
      (function (net) {
        chip.addEventListener("click", function () { self._activeName = net.fileName; self.refresh(); });
      })(n);
      toolbar.appendChild(chip);
    }
    this.container.appendChild(toolbar);

    if (!networks.length) {
      const box = h("div", "welcome");
      const note = h("div", "view-note",
        "Open an RSNetWorx DeviceNet network file (.dnt) to analyse its scanner configuration, " +
        "nodes, transfer types and scan-list bit offsets. If an L5X/ACD project is also open, " +
        "the devices merge into the Module I/O and Inter-module flow views with their scanner image words.");
      box.appendChild(note);
      box.appendChild(h("div", "welcome-actions"));
      box.firstChild; // keep structure simple
      this.container.appendChild(box);
      return;
    }

    const net = this._activeNet() || networks[0];
    const parsed = net;
    const modelInfo = model
      ? "Merged into the open project (" + (model.fileName || model.controller.name || "project") + ")."
      : "No project open \u2014 open the matching L5X export to map these nodes into the module dataflow.";

    /* scanner + merge info */
    const facts = h("div", "module-facts");
    const fact = function (label, value) {
      const f = h("div", "module-fact");
      f.appendChild(h("span", "module-fact-label", label));
      f.appendChild(h("span", "module-fact-value", value === null || value === undefined || value === "" ? "-" : String(value)));
      facts.appendChild(f);
    };
    const si = parsed.scannerInfo;
    fact("Network", parsed.network.name);
    fact("Scanner", si ? "yes" : "no scanner (template library)");
    if (si) {
      fact("EPR", si.eprMs + " ms");
      fact("Interscan", si.interscanDelayMs + " ms");
      fact("Poll ratio", si.pollRatio);
      fact("Retries", si.transmitRetries);
    }
    fact("Mapped devices", parsed.devices.length);
    fact("Declared", parsed.network.declaredDeviceCount);
    if (parsed.logicExport) {
      const lb = (parsed.devices || []).reduce(function (n, d) { return n + (d.hasLogic ? d.logic.count : 0); }, 0);
      fact("Logic export", parsed.logicFileName + " (" + lb + " function blocks)");
    }
    fact("Project link", modelInfo);
    this.container.appendChild(facts);

    /* downloads */
    const bar = h("div", "module-subbar");
    const dl = function (label, name, text, mime) {
      const b = h("button", "btn btn-sm", label);
      b.addEventListener("click", function () {
        if (!downloadText(name, text, mime)) safeStatus(self.app, "Download not available.", true);
      });
      bar.appendChild(b);
    };
    const mmd = networkMermaid(parsed, { l5x: !!model });
    dl("Download .mmd", "devicenet-" + (parsed.fileName || "network") + ".mmd", mmd, "text/plain");
    dl("Download .svg", "devicenet-" + (parsed.fileName || "network") + ".svg", MER.renderToSvg(mmd), "image/svg+xml");
    dl("Download .json", "devicenet-" + (parsed.fileName || "network") + ".json", JSON.stringify(parsed, null, 1), "application/json");
    this.container.appendChild(bar);

    /* layout: table + diagram + node detail */
    const layout = h("div", "dnet-layout");
    const left = h("div", "dnet-left");
    const right = h("div", "dnet-right");
    layout.appendChild(left);
    layout.appendChild(right);
    this.container.appendChild(layout);

    /* node table */
    left.appendChild(h("div", "panel-title", "Nodes" + (parsed.devices.length ? " (" + parsed.devices.length + ")" : "")));
    const table = h("table", "data-table dnet-table");
    const thr = h("tr");
    ["MAC", "Name", "Catalog", "Transfer", "In / Out", "Bit offsets", "L5X image words"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    table.appendChild(thr);
    for (const d of parsed.devices) {
      /* real table rows: a <button> child of <table> is invalid HTML and shifts the columns */
      const tr = document.createElement("tr");
      tr.className = "dnet-row" + (this.selectedMac === d.macId ? " active" : "");
      tr.setAttribute("tabindex", "0");
      tr.appendChild(h("td", "mono", String(d.macId)));
      tr.appendChild(h("td", null, d.name || ""));
      tr.appendChild(h("td", "mono", d.catalogNumber || "-"));
      tr.appendChild(h("td", null, d.transferType || "-"));
      tr.appendChild(h("td", "mono", (d.inputBytes !== undefined ? d.inputBytes : "?") + " / " + (d.outputBytes !== undefined ? d.outputBytes : "?")));
      tr.appendChild(h("td", "mono", (d.inputBitOffset !== undefined ? d.inputBitOffset : "-") + " / " + (d.outputBitOffset !== undefined ? d.outputBitOffset : "-")));
      tr.appendChild(h("td", "mono", [d.l5xInputRange, d.l5xOutputRange].filter(Boolean).join(" | ") || "-"));
      (function (mac) {
        tr.addEventListener("click", function () { self.selectedMac = mac; self._renderDetail(right, parsed, model); });
      })(d.macId);
      table.appendChild(tr);
    }
    left.appendChild(table);

    /* diagram (pannable + zoomable) */
    right.appendChild(h("div", "panel-title", "Network diagram"));
    const Z = zoomView();
    if (Z && typeof Z.buildMermaidView === "function") {
      Z.buildMermaidView(right, mmd, MER, {
        downloads: false, source: false,
        baseName: "devicenet-" + (parsed.fileName || "network"),
        app: this.app,
        hint: "Drag to pan \u00b7 wheel to zoom \u00b7 Fit / 100% to reset."
      });
    } else {
      const host = h("div", "mermaid-host");
      right.appendChild(host);
      try { MER.renderInto(host, mmd); } catch (e) { host.appendChild(h("div", "view-note", "render failed: " + e.message)); }
    }
    const hint = h("div", "view-hint",
      "Legend: green = polled I/O, blue = COS/cyclic, purple = 1799-ZCIOV with local logic on the card (network words in \u2192 local zone logic out), orange = network words.");
    right.appendChild(hint);
    this._renderDetail(right, parsed, model);
  };

  DeviceNetPanel.prototype._activeNet = function () {
    const nets = this._networks();
    if (!nets.length) return null;
    if (this._activeName) {
      const m = nets.find(function (n) { return n.fileName === this._activeName; }, this);
      if (m) return m;
    }
    this._activeName = nets[0].fileName;
    return nets[0];
  };

  /* Known EDS parameter meanings for the 1799-ZCIOV zone card (inferred from the RSNetWorx
     configuration + SAMPLE_ST analysis; the EDS applet itself does not ship friendly names). */
  const ZCIOV_PARAM_HINTS = {
    14: "Zone produced EPR (ms)",
    16: "Zone 1 connection MAC ID",
    17: "Zone 2 connection MAC ID",
    18: "Zone 3 connection MAC ID",
    19: "Zone 4 connection MAC ID"
  };

  function nodeFacts(d, network) {
    const facts = [
      ["File", network && network.fileName || "-"],
      ["Network", network && network.network && network.network.name || "-"],
      ["MAC", String(d.macId)],
      ["Catalog", d.catalogNumber || "-"],
      ["Transfer", d.transferType || "-"],
      ["I/O bytes", (d.inputBytes !== undefined ? d.inputBytes : "?") + " in / " + (d.outputBytes !== undefined ? d.outputBytes : "?") + " out"],
      ["Bit offsets", (d.inputBitOffset !== undefined ? d.inputBitOffset : "-") + " / " + (d.outputBitOffset !== undefined ? d.outputBitOffset : "-")]
    ];
    if (d.pluginStrings && d.pluginStrings.length) facts.push(["Config strings", String(d.pluginStrings.length)]);
    if (d.hasLogic) facts.push(["Decoded logic", d.logic.count + " function blocks (FBD export)"]);
    else if (network && network.logicExport) facts.push(["Decoded logic", (d.noLogic ? "none (report: no logic)" : "not in report")]);
    if (network && network.logicFileName) facts.push(["Logic export", network.logicFileName]);
    if (d.labels && d.labels.zoneCount) facts.push(["Zones", String(d.labels.zoneCount)]);
    return facts;
  }

  function renderNodeCode(container, opts) {
    opts = opts || {};
    const app = opts.app || null;
    const network = opts.network || null;
    const devices = (network && network.devices) || [];
    const d = devices.find(x => x.macId === opts.mac) ||
      devices.find(x => /1799-ZCIOV/i.test(x.catalogNumber || "")) || devices[0];
    container.innerHTML = "";
    const view = h("div", "dnet-node-view");
    container.appendChild(view);
    if (!d) { view.appendChild(h("div", "view-note", "No DeviceNet node selected (no nodes in this network).")); return { node: null }; }
    const isZciov = /1799-ZCIOV/i.test(d.catalogNumber || "");
    const title = h("div", "panel-title", "DeviceNet node \u00b7 MAC " + d.macId + (d.name ? " \u00b7 " + d.name : "") + (d.catalogNumber ? " \u00b7 " + d.catalogNumber : ""));
    view.appendChild(title);
    const facts = h("div", "module-facts");
    for (const f of nodeFacts(d, network)) {
      const b = h("div", "module-fact");
      b.appendChild(h("span", "module-fact-label", f[0]));
      b.appendChild(h("span", "module-fact-value", f[1]));
      facts.appendChild(b);
    }
    view.appendChild(facts);
    if (isZciov) {
      view.appendChild(h("div", "conv-note ok",
        "1799-ZCIOV zone card \u2014 local logic on the device: network input words carry the sensor/command bits over " +
        "DeviceNet and the card executes its own zone logic from them (config below is the card's own mapping)."));
    }
    /* toolbar */
    const bar = h("div", "module-subbar");
    if (opts.showOpenTab !== false && app && typeof app.openDnetNode === "function" && network) {
      const openBtn = h("button", "btn btn-sm", "Open in a tab");
      openBtn.addEventListener("click", function () { app.openDnetNode(network.fileName, d.macId); });
      bar.appendChild(openBtn);
    }
    const dl = h("button", "btn btn-sm", "Download node JSON");
    dl.addEventListener("click", function () {
      const data = { file: network && network.fileName, mac: d.macId, name: d.name, catalog: d.catalogNumber,
        transfer: d.transferType, inputBytes: d.inputBytes, outputBytes: d.outputBytes,
        pluginStorageBytes: d.pluginStorageBytes, labels: d.labels,
        parameters: (d.applet && d.applet.parameters) || [], pointLabels: d.pluginStrings || [] };
      const text = JSON.stringify(data, null, 2);
      if (typeof Blob !== "undefined" && typeof URL !== "undefined") {
        try {
          const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
          const a = document.createElement("a");
          a.href = url; a.download = "devicenet-" + d.macId + "-" + (d.catalogNumber || "node").replace(/[^A-Za-z0-9_-]/g, "_") + ".json";
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
        } catch (e) { /* stub DOM */ }
      }
    });
    bar.appendChild(dl);
    view.appendChild(bar);
    /* tabs */
    const H = htmlReport();
    const logicDevice = d.logicDevice || (network && network.logicExport ? (network.logicExport.devices || []).find(function (x) { return x.address === d.macId || x.macId === d.macId; }) : null);
    const hasExport = !!(network && network.logicExport);
    const logicCount = (logicDevice && logicDevice.logic) ? logicDevice.logic.count : 0;
    const tabDefs = [
      ["logic", "Logic" + (logicCount ? " (" + logicCount + ")" : "")],
      ["params", "Parameters"], ["zone", "Zone mapping"], ["points", "Point labels"], ["raw", "Raw config"]
    ];
    const btns = h("div", "subtab-bar dnet-node-tabs");
    const body = h("div", "subtab-body dnet-node-body");
    view.appendChild(btns); view.appendChild(body);
    const renderers = {};
    let active = null;
    function show(key) {
      active = key;
      Array.from(btns.children).forEach(b => { b.className = "subtab-btn" + (b.dataset.tab === key ? " active" : ""); });
      body.innerHTML = "";
      if (renderers[key]) renderers[key](body);
    }
    for (const [key, label] of tabDefs) {
      const b = h("button", "subtab-btn", label);
      b.dataset.tab = key;
      b.addEventListener("click", function () { show(key); });
      btns.appendChild(b);
    }
    renderers.logic = function (host) {
      if (!hasExport) {
        host.appendChild(h("div", "view-note",
          "No RSNetWorx logic export is attached. RSNetWorx ports the card's ladder logic to a function-block (FBD) rendition: open that HTML report to view it here."));
        if (app && typeof app.openDnetHtmlFile === "function") {
          const b = h("button", "btn btn-sm", "Open RSNetWorx logic export (.html)\u2026");
          b.addEventListener("click", function () { app.openDnetHtmlFile(); });
          host.appendChild(b);
        }
        return;
      }
      const card = logicDevice || ((network.logicExport.devices || []).find(function (x) { return x.address === d.macId || x.macId === d.macId; }));
      const logic = card && card.logic;
      if (!logic || !logic.count) {
        host.appendChild(h("div", "view-note", "The RSNetWorx export reports " +
          (card && card.noLogic ? "\"No logic found\" for this device." : "no logic blocks for this device.")));
        return;
      }
      const Z = zoomView();
      const aliases = (card.localAliases || []);
      host.appendChild(h("div", "view-hint",
        "RSNetWorx exports the card's ladder logic as function blocks (its FBD rendition): " + logic.count + " blocks" +
        (logic.namedBlocks ? " \u00b7 " + logic.namedBlocks + " with configured local-logic tags" : "") +
        (aliases.length ? " \u00b7 " + aliases.length + " I/O alias label(s) cross-referenced" : "") +
        ". Drag to pan \u00b7 wheel to zoom \u00b7 dashed edges are complemented (NOT) inputs."));
      const bar = h("div", "module-subbar dnet-logic-bar");
      const content = h("div", "dnet-logic-content");
      let current = "fbd";
      const buttons = {};
      function renderLang(lang) {
        current = lang;
        Object.keys(buttons).forEach(function (k) { buttons[k].className = "btn btn-sm" + (k === lang ? " btn-accent" : ""); });
        content.innerHTML = "";
        if (lang === "fbd") {
          const viewport = h("div", "mermaid-viewport dnet-logic-viewport");
          const canvas = h("div", "mermaid-canvas dnet-logic-canvas");
          viewport.appendChild(canvas);
          try { canvas.innerHTML = H.logicSvg(card).svg; }
          catch (e) { canvas.appendChild(h("div", "view-note", "Logic render failed: " + e.message)); }
          content.appendChild(viewport);
          if (Z && typeof Z.attachPanZoom === "function") {
            const ctrl = Z.attachPanZoom(viewport, canvas, {});
            if (typeof Z.zoomToolbar === "function") content.appendChild(Z.zoomToolbar(ctrl));
          }
          content.appendChild(h("div", "panel-title", "Function blocks (configured labels shown where available)"));
          const tbl = h("table", "data-table dnet-logic-table");
          const thr = h("tr");
          ["Seq", "Tag / label", "Type", "Parameters", "Bound inputs"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
          tbl.appendChild(thr);
          for (const b of logic.blocks) {
            const tr = h("tr");
            tr.appendChild(h("td", "mono", String(b.seq)));
            tr.appendChild(h("td", null, (b.tag ? b.tag : "") + (b.tag && b.description ? " \u2014 " : "") + (b.description || "") || "-"));
            tr.appendChild(h("td", null, b.type));
            tr.appendChild(h("td", "mono", (b.params || []).map(function (p) { return p.name + " " + p.value; }).join(" \u00b7 ") || "-"));
            tr.appendChild(h("td", "mono", (b.bindings || []).map(function (e) {
              return e.input + (e.complement ? " (NOT)" : "") + " \u2190 " + (e.targetSeq ? "FB" + e.targetSeq : "I/O");
            }).join(", ") || "I/O inputs"));
            tbl.appendChild(tr);
          }
          content.appendChild(tbl);
        } else if (lang === "lad") {
          content.appendChild(h("div", "view-hint",
            "Ladder rendition of the device logic (read-only). Boolean blocks become rung condition networks; " +
            "latches become set/reset rungs; timers/counters become instruction rungs \u2014 configured labels used where known."));
          const host2 = h("div", "dnet-ladder-host");
          const NS2 = (typeof root !== "undefined" && root && root.L5XStudio) || {};
          let rendered = false;
          if (typeof H.logicToLadIR === "function" && typeof NS2.LadderEditor === "function") {
            try {
              const ed = new NS2.LadderEditor({ container: host2, ir: H.logicToLadIR(card), readOnly: true });
              if (ed && typeof ed.render === "function") ed.render();
              rendered = true;
            } catch (e) { host2.appendChild(h("div", "view-note", "Ladder rendering failed: " + e.message)); }
          }
          content.appendChild(host2);
          if (!rendered) {
            const pre0 = h("pre", "routine-text dnet-logic-code");
            pre0.textContent = H.logicToLad(card);
            content.appendChild(pre0);
          }
          const det = h("details", "mermaid-text");
          det.appendChild(h("summary", null, "Ladder text (downloadable)"));
          const pre1 = h("pre", "routine-text dnet-logic-code");
          pre1.textContent = H.logicToLad(card);
          det.appendChild(pre1);
          content.appendChild(det);
        } else if (lang === "st") {
          const pre = h("pre", "routine-text dnet-logic-code");
          pre.textContent = H.logicToSt(card);
          content.appendChild(pre);
        } else if (lang === "labels") {
          const rows = typeof H.logicLabelsTable === "function" ? H.logicLabelsTable(card) : { aliases: [], tags: [] };
          content.appendChild(h("div", "view-hint",
            "Local-logic labels recovered from the card's configuration (inferred). Where a label maps onto a block, the FBD uses it for the block tag/input."));
          content.appendChild(h("div", "panel-title", "I/O aliases (" + rows.aliases.length + ")"));
          const t1 = h("table", "data-table dnet-xref-table");
          const h1 = h("tr"); ["Label", "Address", "Kind", "Used by"].forEach(function (t) { h1.appendChild(h("th", null, t)); }); t1.appendChild(h1);
          for (const r of rows.aliases) {
            const tr = h("tr");
            tr.appendChild(h("td", null, r.label));
            tr.appendChild(h("td", "mono", r.address));
            tr.appendChild(h("td", null, r.kind));
            tr.appendChild(h("td", "mono", r.block));
            t1.appendChild(tr);
          }
          content.appendChild(t1);
          content.appendChild(h("div", "panel-title", "Blocks with configured tags (" + rows.tags.length + ")"));
          const t2 = h("table", "data-table dnet-xref-table");
          const h2 = h("tr"); ["FB", "Tag", "Type", "Description", "Input labels"].forEach(function (t) { h2.appendChild(h("th", null, t)); }); t2.appendChild(h2);
          for (const r of rows.tags) {
            const tr = h("tr");
            tr.appendChild(h("td", "mono", "FB" + r.seq));
            tr.appendChild(h("td", "mono", r.tag));
            tr.appendChild(h("td", null, r.type));
            tr.appendChild(h("td", null, r.description));
            tr.appendChild(h("td", null, r.inputs || "-"));
            t2.appendChild(tr);
          }
          content.appendChild(t2);
        } else {
          const pre = h("pre", "routine-text dnet-logic-code");
          pre.textContent = JSON.stringify({ device: card.name, mac: card.macId, blocks: logic.blocks, aliases: card.localAliases || [] }, null, 2);
          content.appendChild(pre);
        }
      }
      for (const pair of [["fbd", "FBD"], ["lad", "Ladder"], ["st", "Structured Text"], ["labels", "Labels"], ["json", "JSON"]]) {
        (function (lang, label) {
          const b = h("button", "btn btn-sm", label);
          b.dataset.lang = lang;
          b.addEventListener("click", function () { renderLang(lang); });
          buttons[lang] = b;
          bar.appendChild(b);
        })(pair[0], pair[1]);
      }
      const dl = h("button", "btn btn-sm", "Download");
      dl.title = "Download the current rendition (FBD .svg / .lad / .st / labels .json)";
      dl.addEventListener("click", function () {
        if (!Z || typeof Z.downloadText !== "function") return;
        const base = "devicenet-mac" + card.macId + "-logic";
        if (current === "fbd") {
          const canvas = content.querySelector(".dnet-logic-canvas");
          Z.downloadText(base + ".svg", canvas ? canvas.innerHTML : "", "image/svg+xml");
        } else if (current === "lad") Z.downloadText(base + ".lad.txt", H.logicToLad(card));
        else if (current === "st") Z.downloadText(base + ".st.txt", H.logicToSt(card));
        else if (current === "labels") Z.downloadText(base + ".labels.json", JSON.stringify(H.logicLabelsTable(card), null, 2), "application/json");
        else {
          const pre = content.querySelector("pre");
          Z.downloadText(base + ".json", pre ? pre.textContent : "", "application/json");
        }
      });
      bar.appendChild(dl);
      host.appendChild(bar);
      host.appendChild(content);
      renderLang("fbd");
    };

    renderers.params = function (host) {
      const params = (d.applet && d.applet.parameters) || [];
      if (d.applet && d.applet.deviceName) host.appendChild(h("div", "view-hint", "EDS device: " + d.applet.deviceName));
      if (!params.length) { host.appendChild(h("div", "view-note", "No EDS applet configuration was stored for this node.")); return; }
      const tbl = h("table", "data-table dnet-param-table");
      const thr = h("tr");
      ["#", "Name", "Value", "Meaning (inferred)"].forEach(t => thr.appendChild(h("th", null, t)));
      tbl.appendChild(thr);
      for (const p of params) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", String(p.index)));
        tr.appendChild(h("td", null, p.name || ""));
        tr.appendChild(h("td", "mono", String(p.value)));
        const hint = isZciov && ZCIOV_PARAM_HINTS[p.index];
        tr.appendChild(h("td", "view-hint", hint || ""));
        tbl.appendChild(tr);
      }
      host.appendChild(tbl);
      if (isZciov) host.appendChild(h("div", "view-hint",
        "Meanings marked \u201cinferred\u201d come from the RSNetWorx configuration report, not from an EDS file."));
    };
    renderers.zone = function (host) {
      const labels = d.labels || { zoneData: [], other: [] };
      const zoneTags = (d.zoneTags && d.zoneTags.length)
        ? d.zoneTags
        : (labels.zoneData || []).map(function (z) { return { byte: z.byte, bit: z.bit, label: z.label, tagId: null }; });
      if (!zoneTags.length) {
        host.appendChild(h("div", "view-note", "This node does not expose zone/point mapping labels in its configuration stream."));
        if ((labels.other || []).length) {
          const pre = h("pre", "routine-text");
          pre.textContent = (labels.other || []).join("\n");
          host.appendChild(pre);
        }
        return;
      }
      /* zone connection parameters (friendly names come from the RSNetWorx HTML export) */
      const ZCIOV_PARAM_NAMES = {
        4: "Input Values (7-0)", 5: "Input Values (9-8)",
        6: "Output Fault State", 7: "Output Fault Value", 8: "Output Idle State", 9: "Output Idle Value",
        10: "Consumed I/O Assembly", 11: "Network Status Override", 12: "Comm Status Override",
        13: "Auto Run ZIP", 14: "Zone Produced - EPR", 15: "Zone Produced - PIT",
        16: "Zone Cnxn #1 - MacID", 17: "Zone Cnxn #2 - MacID", 18: "Zone Cnxn #3 - MacID", 19: "Zone Cnxn #4 - MacID",
        20: "Zone Cnxn #1 - Health", 21: "Zone Cnxn #2 - Health", 22: "Zone Cnxn #3 - Health", 23: "Zone Cnxn #4 - Health",
        24: "Zone Cnxn #1 - Mask", 25: "Zone Cnxn #2 - Mask", 26: "Zone Cnxn #3 - Mask", 27: "Zone Cnxn #4 - Mask",
        28: "Zone Cnxn #1 - Offset", 29: "Zone Cnxn #2 - Offset", 30: "Zone Cnxn #3 - Offset", 31: "Zone Cnxn #4 - Offset",
        32: "Zone Cnxn #1 - EPR", 33: "Zone Cnxn #2 - EPR", 34: "Zone Cnxn #3 - EPR", 35: "Zone Cnxn #4 - EPR",
        36: "Cnxn 1 Security Key Value", 37: "Cnxn 2 Security Key Value", 38: "Cnxn 3 Security Key Value", 39: "Cnxn 4 Security Key Value",
        40: "Module Security Key Value", 41: "Data Security", 42: "Zone Control", 43: "Quick Connect",
        1: "Autobaud", 2: "Off-to-On Delay", 3: "On-to-Off Delay"
      };
      const isZciov = /1799-ZCIOV/i.test(d.catalogNumber || "");
      let params = (logicDevice && logicDevice.parameters) || d.htmlParameters || (d.applet && d.applet.parameters) || [];
      if (params.length && !/(Zone Cnxn|MacID)/i.test(params.map(function (p) { return p.name || ""; }).join(" "))) {
        params = params.map(function (p) {
          const friendly = isZciov && ZCIOV_PARAM_NAMES[p.index];
          return friendly ? { index: p.index, name: friendly, value: p.value } : p;
        });
      }
      const conns = [];
      for (const p of params) {
        const m = /Zone Cnxn #(\d+)\s*-\s*(MacID|EPR|Offset|Health)/i.exec(p.name || "");
        if (!m) continue;
        const idx = parseInt(m[1], 10) - 1;
        conns[idx] = conns[idx] || { index: idx + 1 };
        conns[idx][m[2].toLowerCase()] = p.value;
      }
      const connList = conns.filter(Boolean);
      const bytes = Math.max.apply(null, zoneTags.map(function (z) { return z.byte; })) + 1;
      const perConn = connList.length ? Math.max(1, Math.floor(bytes / connList.length)) : 0;
      function connForByte(byte) {
        if (!connList.length || !perConn) return null;
        return connList[Math.min(connList.length - 1, Math.floor(byte / perConn))];
      }
      /* merged L5X plan: map the card's consumed I/O assembly bits onto scanner image words */
      const analysis = (function () {
        try {
          if (!app || !app.model || !hasUsage()) return null;
          if (app._zonePlanStamp !== app._dntStamp || app._zonePlanModel !== app.model) {
            app._zonePlan = hasUsage() ? usage().mergeDeviceNetIntoAnalysis(usage().analyzeModules(app.model), app.dnts || [], {}) : null;
            app._zonePlanStamp = app._dntStamp;
            app._zonePlanModel = app.model;
          }
          return app._zonePlan;
        } catch (e) { return null; }
      })();
      const pseudo = analysis ? (analysis.modules || []).find(function (m) { return m.devicenet && m.macId === d.macId; }) : null;
      const inBits = d.inputBitLength || 0;
      const inOff = d.inputBitOffset || 0;
      function assemblyBit(bitIndex) {
        if (bitIndex >= inBits) return null;
        const abs = inOff + bitIndex;
        const word = Math.floor(abs / 32);
        const bitInWord = abs % 32;
        if (!pseudo) return { operand: "input word " + word + "." + bitInWord, used: null, refs: [] };
        const w = (pseudo.l5xInputWords || []).find(function (x) { return x.word === word; });
        if (!w) return { operand: "input word " + word + "." + bitInWord, used: null, refs: [] };
        return { operand: w.address + "." + bitInWord, used: w.used, refs: (w.references || []) };
      }
      /* legend + aligned grid */
      host.appendChild(h("div", "view-hint",
        "The dots are the card's configured zone-data tag database: " + zoneTags.length + " bits across " + bytes +
        " byte(s)" + (connList.length ? " carried on " + connList.length + " zone connection(s)" : "") +
        ". \u25cf = the bit has a configured tag (tag id shown on hover/table); the table below cross-references each bit with its zone connection and, where the byte lies inside the DeviceNet I/O assembly, the PLC scanner image bit."));
      const grid = h("table", "data-table dnet-zone-grid");
      const thr = h("tr");
      thr.appendChild(h("th", "dnet-zone-byte-col", "Byte"));
      for (let bit = 0; bit < 8; bit++) thr.appendChild(h("th", "dnet-zone-bit-col", "Bit " + bit));
      grid.appendChild(thr);
      const byByte = {};
      for (const z of zoneTags) { (byByte[z.byte] = byByte[z.byte] || {})[z.bit] = z; }
      const sortedBytes = Object.keys(byByte).map(Number).sort(function (a, b) { return a - b; });
      for (const byte of sortedBytes) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono dnet-zone-byte-col", "Byte " + byte));
        for (let bit = 0; bit < 8; bit++) {
          const z = byByte[byte][bit];
          const cell = h("td", z ? "mono dnet-zone-on dnet-zone-bit-col" : "mono dnet-zone-bit-col", z ? "\u25cf" : "");
          if (z) cell.title = z.label + (z.tagId !== null ? " (tag id " + z.tagId + ")" : "");
          tr.appendChild(cell);
        }
        grid.appendChild(tr);
      }
      host.appendChild(grid);
      /* per-bit cross reference */
      host.appendChild(h("div", "panel-title", "Zone-data bit cross reference"));
      const map = h("table", "data-table dnet-zone-map");
      const mh = h("tr");
      ["Zone-data bit", "Tag id", "Zone connection", "DeviceNet input assembly bit", "Used by"].forEach(function (t) { mh.appendChild(h("th", null, t)); });
      map.appendChild(mh);
      for (const z of zoneTags) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", z.label));
        tr.appendChild(h("td", "mono", z.tagId !== null && z.tagId !== undefined ? String(z.tagId) : "-"));
        const conn = connForByte(z.byte);
        tr.appendChild(h("td", null, conn
          ? ("#" + conn.index + (conn.macid ? " MAC " + conn.macid : "") + (conn.epr ? " \u00b7 EPR " + conn.epr : "") + (conn.offset !== undefined ? " \u00b7 offset " + conn.offset : ""))
          : "-"));
        const ab = assemblyBit(z.byte * 8 + z.bit);
        tr.appendChild(h("td", "mono", ab ? ab.operand : "outside I/O assembly (zone-connection data)"));
        tr.appendChild(h("td", "mono", ab && ab.refs && ab.refs.length
          ? ab.refs.map(function (r) { return r.program + "/" + r.routine; }).slice(0, 3).join(", ")
          : (ab && ab.used === false ? "not referenced" : (ab ? "-" : "-"))));
        map.appendChild(tr);
      }
      host.appendChild(map);
      host.appendChild(h("div", "view-hint",
        "Association of bytes with zone connections is inferred from the configured connection offsets; " +
        "the scanner image column uses the DNT scan-list offset and requires the matching L5X for word addresses."));
      if ((labels.other || []).length) {
        const det = h("details", "mermaid-text");
        det.appendChild(h("summary", null, "Other configuration labels (" + labels.other.length + ")"));
        const pre = h("pre", "routine-text dnet-label-list");
        pre.textContent = labels.other.join("\n");
        det.appendChild(pre);
        host.appendChild(det);
      }
    };

    renderers.points = function (host) {
      const labels = d.labels || {};
      const groups = [
        ["Network inputs", labels.networkInputs || []],
        ["Network outputs", labels.networkOutputs || []],
        ["Local inputs", labels.inputs || []],
        ["Local outputs", labels.outputs || []]
      ];
      let any = false;
      for (const [name, list] of groups) {
        if (!list.length) continue;
        any = true;
        host.appendChild(h("div", "panel-title", name + " (" + list.length + ")"));
        const grid = h("div", "dnet-point-grid");
        list.slice(0, 64).forEach(function (x) { grid.appendChild(h("span", "dnet-point-chip", x.label)); });
        host.appendChild(grid);
      }
      if (!any) host.appendChild(h("div", "view-note", "No point labels were stored for this node."));
    };
    renderers.raw = function (host) {
      host.appendChild(h("div", "view-hint", "Printable strings recovered from the node's EDS Applet Plugin Storage stream (" +
        (d.pluginStorageBytes || 0) + " bytes, " + (d.pluginStrings || []).length + " strings)."));
      const pre = h("pre", "routine-text dnet-raw-strings");
      pre.textContent = (d.pluginStrings || []).join("\n") || "(no strings)";
      host.appendChild(pre);
    };
    /* L5X scanner image words (when a project is open) */
    const model = opts.model || (app && app.model) || null;
    if (model && (d.l5xInputWords || []).concat(d.l5xOutputWords || []).length) {
      const wordsBox = h("div", "dnet-node-words");
      wordsBox.appendChild(h("div", "panel-title", "Scanner image words in the L5X"));
      const tbl = h("table", "data-table");
      const thr = h("tr");
      ["Word", "Used", "References"].forEach(t => thr.appendChild(h("th", null, t)));
      tbl.appendChild(thr);
      for (const w of (d.l5xInputWords || []).concat(d.l5xOutputWords || [])) {
        const tr = h("tr");
        tr.appendChild(h("td", "mono", w.address));
        tr.appendChild(h("td", null, w.used ? "yes" : "no"));
        tr.appendChild(h("td", "mono", (w.references || []).map(r => r.program + "/" + r.routine).slice(0, 3).join(", ")));
        tbl.appendChild(tr);
      }
      wordsBox.appendChild(tbl);
      view.appendChild(wordsBox);
    }
    show("params");
    return { node: d };
  }

  function DnetNodePanel(opts) {
    if (!(this instanceof DnetNodePanel)) return new DnetNodePanel(opts);
    this.app = opts.app;
    this.container = opts.container;
    this.fileName = opts.fileName;
    this.mac = opts.mac;
    this.refresh();
  }
  DnetNodePanel.prototype.refresh = function () {
    const nets = (this.app && this.app.dnts) || [];
    const net = nets.find(n => n.fileName === this.fileName) || nets[0] || null;
    return renderNodeCode(this.container, { app: this.app, network: net, mac: this.mac, model: (this.app && this.app.model) || null, showOpenTab: false });
  };

  DeviceNetPanel.prototype._renderDetail = function (right, parsed, model) {
    /* dedicated host: the node code view must not wipe the network diagram rendered below */
    let host = right.querySelector ? right.querySelector(".dnet-node-host") : null;
    if (!host) {
      host = h("div", "dnet-node-host");
      right.appendChild(host);
    }
    this._nodeView = renderNodeCode(host, {
      app: this.app, network: parsed, mac: this.selectedMac, model: model, showOpenTab: true
    });
  };

  return { DeviceNetPanel: DeviceNetPanel, DnetPanel: DeviceNetPanel, DnetNodePanel: DnetNodePanel,
    renderNodeCode: renderNodeCode, networkMermaid: networkMermaid };
});
