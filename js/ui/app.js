/* L5X Studio - ui/app.js (Lead). Application shell: file loading, project tree, tabs,
   diagram views, editor hosting, conversion, export. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const NS = function () { return root.L5XStudio; };

  function h(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === "onclick") e.addEventListener("click", attrs[k]);
      else if (k === "title") e.title = attrs[k];
      else if (k === "style") e.style.cssText = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  var KIND_TO_TYPE = { lad: "RLL", st: "ST", fbd: "FBD" };
  var TYPE_TO_KIND = { RLL: "lad", ST: "st", FBD: "fbd", SFC: "sfc" };

  function App(rootEl) {
    if (!(this instanceof App)) return new App(rootEl);
    this.root = rootEl;
    this.model = null;
    this.selection = null;
    this.tabs = [];           // [{ id, label, el, render }]
    this.activeTab = null;
    this.dnts = [];            // parsed DeviceNet .dnt networks (persist across project loads)
    this.dntHtmls = [];        // RSNetWorx HTML logic exports (matched to networks by file name)
    this._dntStamp = 0;
    this.editor = null;       // current editor instance
    this._build();
    this._wireHeader();
  }

  App.prototype._build = function () {
    const r = this.root;
    r.innerHTML = "";
    /* ---------- top bar: identity + file actions + command palette ---------- */
    const header = h("header", "app-header");
    r.appendChild(header);
    const headerRow = header;
    headerRow.appendChild(h("span", "app-logo", "L5X Studio"));
    this.btnSidebar = h("button", "btn btn-icon", "\u2630");
    this.btnSidebar.title = "Show / hide the project tree";
    headerRow.appendChild(this.btnSidebar);
    this.projectName = h("span", "project-name", "no project loaded");
    headerRow.appendChild(this.projectName);
    headerRow.appendChild(h("span", "header-spacer"));
    this.btnPalette = h("button", "btn btn-palette", "\u2318K  Search commands\u2026");
    this.btnPalette.title = "Command palette (Ctrl+K): every view, routine, module and action";
    headerRow.appendChild(this.btnPalette);
    this.btnOpen = h("button", "btn", "Open L5X\u2026");
    this.btnExport = h("button", "btn btn-primary", "Export L5X");
    headerRow.appendChild(this.btnOpen);
    headerRow.appendChild(this.btnExport);
    this.fileInput = h("input", null, null, { type: "file", accept: ".L5X,.l5x,.ACD,.acd,.DNT,.dnt,.html,.htm", hidden: true });
    headerRow.appendChild(this.fileInput);

    /* ---------- body: activity rail | project tree | tabbed workspace ---------- */
    const main = h("div", "app-main");
    r.appendChild(main);
    this.rail = h("nav", "activity-rail");
    this.rail.setAttribute("aria-label", "Workspaces");
    main.appendChild(this.rail);
    this.sidebar = h("aside", "sidebar");
    this.tree = h("div", "project-tree");
    this.sidebar.appendChild(this.tree);
    main.appendChild(this.sidebar);
    const content = h("div", "content");
    this.tabBar = h("nav", "tab-bar");
    content.appendChild(this.tabBar);
    this.view = h("div", "view");
    content.appendChild(this.view);
    main.appendChild(content);

    /* ---------- bottom status bar ---------- */
    const footer = h("footer", "app-footer");
    this.modelInfo = h("span", "footer-info", "Ready \u2014 open an L5X export or an ACD archive");
    this.statusEl = h("span", "status-bar", "");
    footer.appendChild(this.modelInfo);
    footer.appendChild(this.statusEl);
    r.appendChild(footer);

    this.dropOverlay = h("div", "drop-overlay", "Drop an .L5X or .ACD file to open");
    this.dropOverlay.style.display = "none";
    r.appendChild(this.dropOverlay);

    this._buildRail();
    this._buildPalette();
    this._welcome();
    this._updateRailAvailability();
  };

  /* ================= activity rail (workspace navigation) ================= */

  App.prototype._railGroups = function () {
    return [
      {
        label: "Project", items: [
          { id: "tree", label: "Explorer", glyph: "\u25a4", title: "Show / hide the project tree", action: "sidebar" },
          { id: "project", label: "Diagram", glyph: "\u25c8", title: "Project dataflow diagram", tab: "project", needsModel: true },
          { id: "welcome", label: "Home", glyph: "\u2302", title: "Dashboard / quick start", action: "home" }
        ]
      },
      {
        label: "Inspect", items: [
          { id: "io", label: "I/O map", glyph: "\u21c4", title: "Tag \u2192 physical I/O point mapping", tab: "io", needsModel: true },
          { id: "iolist", label: "I/O list", glyph: "\u2261", title: "I/O list with logic references, filters and export", tab: "iolist", needsModel: true },
          { id: "modules", label: "Modules", glyph: "\u25a6", title: "Module-level I/O dataflow: hardware vs network I/O, used bits, Mermaid diagram", tab: "moduleio", needsModel: true },
          { id: "dnet", label: "DeviceNet", glyph: "\u26c1", title: "DeviceNet network analysis (.dnt) \u2014 standalone or merged with the open project", tab: "dnet" },
          { id: "udt", label: "UDTs", glyph: "\u25eb", title: "Data type / UDT shape viewer", tab: "udt", needsModel: true },
          { id: "acd", label: "ACD", glyph: "\u25c9", title: "ACD archive metadata browser", tab: "acd", needsAcd: true },
          { id: "aoi", label: "AOIs", glyph: "\u2699", title: "Add-On Instruction library browser", tab: "aoi", needsModel: true }
        ]
      },
      {
        label: "Analyze", items: [
          { id: "validation", label: "Validate", glyph: "\u2713", title: "Official L5X schema validation (v32\u2013v38)", tab: "validation" },
          { id: "health", label: "Health", glyph: "\u2665", title: "Project health report: unused tags, unresolved operands, uncalled routines", tab: "health", needsModel: true }
        ]
      },
      {
        label: "Build", items: [
          { id: "conveyor", label: "Conveyor", glyph: "\u26d3", title: "Conveyor design studio: draw, size, BOM, L5X + HMI generation", tab: "conveyor" },
          { id: "convert", label: "Convert", glyph: "\u21cb", title: "Convert routines LAD \u2194 FBD \u2194 ST", tab: "convert", needsModel: true },
          { id: "exportc", label: "Export C", glyph: "C", title: "Generate the C translation of the project", action: "exportc", needsModel: true }
        ]
      }
    ];
  };

  App.prototype._buildRail = function () {
    const self = this;
    this.rail.innerHTML = "";
    this.railBtns = {};
    for (const group of this._railGroups()) {
      const g = h("div", "rail-group");
      g.appendChild(h("div", "rail-group-label", group.label));
      for (const item of group.items) {
        const b = h("button", "rail-btn");
        b.title = item.title || item.label;
        b.appendChild(h("span", "rail-glyph", item.glyph));
        b.appendChild(h("span", "rail-text", item.label));
        b.setAttribute("data-rail", item.id);
        (function (it) {
          b.addEventListener("click", function () { self._railClick(it); });
        })(item);
        this.railBtns[item.id] = b;
        g.appendChild(b);
      }
      this.rail.appendChild(g);
    }
  };

  App.prototype._railClick = function (item) {
    if (item.needsModel && !this.model) {
      this.status("Open an L5X project first (Ctrl+O).", true);
      this.fileInput.click();
      return;
    }
    if (item.needsAcd && !this.acd) {
      this.status("Open an ACD archive first (Open \u2192 .ACD).", true);
      return;
    }
    if (item.action === "sidebar") { this._toggleSidebar(); return; }
    if (item.action === "home") { this._welcome(); this._activateTab(null); return; }
    if (item.action === "exportc") { this.exportProjectC(); return; }
    if (item.tab) this._openTab(item.tab);
  };

  App.prototype._updateRail = function (tabId, type) {
    const map = {
      project: "project", io: "io", iolist: "iolist", moduleio: "modules", udt: "udt", acd: "acd",
      aoi: "aoi", validation: "validation", health: "health", conveyor: "conveyor", convert: "convert", dnet: "dnet",
      dnetnode: "dnet", routine: "project"
    };
    const active = map[type || tabId] || null;
    for (const id of Object.keys(this.railBtns || {})) {
      this.railBtns[id].className = "rail-btn" + (id === active ? " active" : "");
    }
  };

  App.prototype._updateRailAvailability = function () {
    for (const group of this._railGroups()) {
      for (const item of group.items) {
        const b = this.railBtns[item.id];
        if (!b) continue;
        const missing = (item.needsModel && !this.model) || (item.needsAcd && !this.acd);
        b.className = "rail-btn" + (missing ? " unavailable" : "");
      }
    }
    this._updateFooter();
  };

  App.prototype._toggleSidebar = function () {
    if (!this.sidebar) return;
    this.sidebar.style.display = this.sidebar.style.display === "none" ? "" : "none";
  };

  App.prototype._updateFooter = function () {
    if (!this.modelInfo) return;
    if (this.model) {
      const routineCount = this.model.programs.reduce(function (a, p) { return a + p.routines.length; }, 0);
      this.modelInfo.textContent = this.model.fileName + " \u00b7 " + this.model.controller.name +
        " \u00b7 " + this.model.programs.length + " programs / " + routineCount + " routines \u00b7 " +
        this.model.dataTypes.length + " data types \u00b7 " + this.model.modules.length + " modules";
    } else if (this.acd) {
      this.modelInfo.textContent = this.acdFileName + " \u00b7 ACD metadata \u00b7 logic not parsed";
    } else {
      this.modelInfo.textContent = "Ready \u2014 open an L5X export or an ACD archive";
    }
  };

  /* ================= command palette ================= */

  App.prototype._buildPalette = function () {
    const self = this;
    const overlay = h("div", "palette-overlay");
    overlay.style.display = "none";
    const box = h("div", "palette");
    const input = h("input", "palette-input", null, { type: "text", placeholder: "Search commands, routines, modules, data types\u2026" });
    const list = h("div", "palette-list");
    const hint = h("div", "palette-hint", "\u2191\u2193 navigate \u00b7 Enter run \u00b7 Esc close");
    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(hint);
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) self._closePalette(); });
    input.addEventListener("input", function () { self._renderPalette(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { self._movePalette(1); if (e.preventDefault) e.preventDefault(); }
      else if (e.key === "ArrowUp") { self._movePalette(-1); if (e.preventDefault) e.preventDefault(); }
      else if (e.key === "Enter") { self._runPaletteIndex(self._paletteIndex || 0); if (e.preventDefault) e.preventDefault(); }
      else if (e.key === "Escape") { self._closePalette(); }
    });
    this.root.appendChild(overlay);
    this.paletteEl = overlay;
    this.paletteInput = input;
    this.paletteList = list;
    this.paletteVisible = false;
    this._paletteFiltered = [];
    this._paletteIndex = 0;
  };

  App.prototype._paletteCommands = function () {
    const self = this;
    const cmds = [
      { id: "file.open", group: "File", label: "Open L5X / ACD file\u2026", kbd: "Ctrl+O", run: function () { self.fileInput.click(); } },
      { id: "file.export", group: "File", label: "Export L5X", kbd: "Ctrl+S", run: function () { self.exportProject(); } },
      { id: "file.exportc", group: "File", label: "Export C translation of the project", run: function () { self.exportProjectC(); } },
      { id: "view.welcome", group: "Workspace", label: "Home \u2014 dashboard / quick start", run: function () { self._welcome(); self._activateTab(null); } },
      { id: "view.project", group: "Workspace", label: "Project dataflow diagram", run: function () { self._openTab("project"); } },
      { id: "view.io", group: "Workspace", label: "I/O map \u2014 tag \u2192 physical point", run: function () { self._openTab("io"); } },
      { id: "view.iolist", group: "Workspace", label: "I/O list \u2014 references, filters, export", run: function () { self._openTab("iolist"); } },
      { id: "view.moduleio", group: "Workspace", label: "Module I/O \u2014 module-level dataflow (hardware vs network I/O, Mermaid)", run: function () { self._openTab("moduleio"); } },
      { id: "view.dnet", group: "Workspace", label: "DeviceNet network analysis (.dnt)", run: function () { self._openTab("dnet"); } },
      { id: "file.opendnt", group: "File", label: "Open DeviceNet network (.dnt)\u2026", run: function () { self.fileInput.click(); } },
      { id: "file.opendnthtml", group: "File", label: "Open RSNetWorx logic export (.html)\u2026", run: function () { self.fileInput.click(); } },
      { id: "view.udt", group: "Workspace", label: "Data types / UDT shape viewer", run: function () { if (self.model) self._openTab("udt"); } },
      { id: "view.acd", group: "Workspace", label: "ACD metadata browser", run: function () { if (self.acd) self._openTab("acd"); } },
      { id: "view.aoi", group: "Workspace", label: "Add-On Instruction library", run: function () { if (self.model) self._openTab("aoi"); } },
      { id: "view.validation", group: "Analyze", label: "Validate \u2014 L5X schema check", run: function () { self._openTab("validation"); } },
      { id: "view.health", group: "Analyze", label: "Project health report", run: function () { if (self.model) self._openTab("health"); } },
      { id: "view.convert", group: "Build", label: "Convert routines LAD \u2194 FBD \u2194 ST", run: function () { if (self.model) self._openTab("convert"); } },
      { id: "view.conveyor", group: "Build", label: "Conveyor design studio", run: function () { self._openTab("conveyor"); } }
    ];
    if (this.model) {
      for (const p of this.model.programs) {
        for (const rt of p.routines) {
          (function (prog, routine) {
            cmds.push({
              id: "routine." + prog + "." + routine,
              group: "Go to routine",
              label: prog + " / " + routine,
              run: function () {
                self.selection = { type: "routine", program: prog, routine: routine };
                self._openTab("routine");
              }
            });
          })(p.name, rt.name);
        }
      }
      for (const m of (this.model.modules || []).slice(0, 120)) {
        (function (name, catalog) {
          cmds.push({
            id: "module." + name,
            group: "Go to module (Module I/O)",
            label: "Module I/O \u2014 " + name + (catalog ? "  (" + catalog + ")" : ""),
            run: function () { self._openModuleIo(name); }
          });
        })(m.name, m.catalogNumber);
      }
      for (const dt of (this.model.dataTypes || []).slice(0, 120)) {
        (function (name) {
          cmds.push({
            id: "udt." + name,
            group: "Go to data type",
            label: "Data type \u2014 " + name,
            run: function () { self.selection = { type: "udt", name: name }; self._openTab("udt"); }
          });
        })(dt.name);
      }
    }
    if (this.dnts && this.dnts.length) {
      for (const net of this.dnts) {
        for (const dev of (net.devices || []).slice(0, 120)) {
          (function (fileName, macId, name, catalog) {
            cmds.push({
              id: "dnetnode." + fileName + "." + macId,
              group: "DeviceNet nodes",
              label: "MAC " + macId + (name ? " \u2014 " + name : "") + (catalog ? " (" + catalog + ")" : "") + "  \u00b7  " + fileName,
              run: function () { self.openDnetNode(fileName, macId); }
            });
          })(net.fileName, dev.macId, dev.name, dev.catalogNumber);
        }
      }
    }
    return cmds;
  };

  App.prototype._openPalette = function () {
    if (!this.paletteEl) return;
    this.paletteVisible = true;
    this.paletteEl.style.display = "flex";
    this.paletteInput.value = "";
    this._renderPalette("");
    try { this.paletteInput.focus(); } catch (e) { /* stub DOM */ }
  };

  App.prototype._closePalette = function () {
    if (!this.paletteEl) return;
    this.paletteVisible = false;
    this.paletteEl.style.display = "none";
  };

  App.prototype._renderPalette = function (query) {
    const self = this;
    function norm(s) {
      return String(s || "").toLowerCase()
        .replace(/\//g, "")                 // "I/O" -> "io"
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    const q = norm(query);
    const all = this._paletteCommands();
    const filtered = q ? all.filter(function (c) { return norm(c.label + " " + c.group + " " + c.id).indexOf(q) !== -1; }) : all;
    this._paletteFiltered = filtered;
    this._paletteIndex = 0;
    this.paletteList.innerHTML = "";
    let lastGroup = null;
    filtered.slice(0, 200).forEach(function (cmd) {
      if (cmd.group !== lastGroup) {
        self.paletteList.appendChild(h("div", "palette-group", cmd.group));
        lastGroup = cmd.group;
      }
      const item = h("button", "palette-item");
      item.appendChild(h("span", "palette-label", cmd.label));
      if (cmd.kbd) item.appendChild(h("span", "palette-kbd", cmd.kbd));
      (function (c) {
        item.addEventListener("click", function () { self._paletteRun(c); });
      })(cmd);
      self.paletteList.appendChild(item);
    });
    if (!filtered.length) this.paletteList.appendChild(h("div", "palette-empty", "No matching command."));
    this._paletteItems = this.paletteList.querySelectorAll(".palette-item");
    this._paletteSetActive(0);
  };

  App.prototype._paletteSetActive = function (idx) {
    const items = this._paletteItems || [];
    if (!items.length) return;
    const i = Math.max(0, Math.min(items.length - 1, idx));
    this._paletteIndex = i;
    items.forEach(function (el, k) { el.className = "palette-item" + (k === i ? " active" : ""); });
  };

  App.prototype._movePalette = function (delta) {
    this._paletteSetActive((this._paletteIndex || 0) + delta);
  };

  App.prototype._runPaletteIndex = function (idx) {
    const cmd = (this._paletteFiltered || [])[idx];
    if (cmd) this._paletteRun(cmd);
  };

  App.prototype._paletteRun = function (cmd) {
    this._closePalette();
    try { cmd.run(); } catch (e) {
      this.status("Command failed: " + e.message, true);
      console.error(e);
    }
  };

  App.prototype._openModuleIo = function (moduleName) {
    this._pendingModule = moduleName || null;
    if (!this.model) { this.status("Open an L5X project first.", true); return; }
    this._openTab("moduleio");
  };

  /* ================= home dashboard ================= */
  App.prototype._welcome = function () {
    const self = this;
    const v = this.view;
    v.innerHTML = "";
    const w = h("div", "welcome");
    const hero = h("div", "welcome-hero");
    hero.appendChild(h("div", "welcome-logo", "L5X Studio"));
    hero.appendChild(h("div", "welcome-text",
      "Studio for Rockwell Logix projects: inspect dataflow, I/O and module wiring, edit routines in " +
      "ladder / function block / structured text, convert between languages, validate, and generate " +
      "conveyor designs with BOM, L5X and HMI."));
    const heroActions = h("div", "welcome-actions");
    const openBtn = h("button", "btn btn-primary btn-lg", "Open an L5X / ACD file\u2026");
    openBtn.addEventListener("click", function () { self.fileInput.click(); });
    heroActions.appendChild(openBtn);
    const paletteBtn = h("button", "btn btn-lg", "\u2318K  Search everything");
    paletteBtn.addEventListener("click", function () { self._openPalette(); });
    heroActions.appendChild(paletteBtn);
    hero.appendChild(heroActions);
    hero.appendChild(h("div", "welcome-hint", "Tip: drag & drop a file, or press Ctrl+K anywhere to jump to any view, routine or module."));
    w.appendChild(hero);

    const groups = [
      {
        title: "Inspect & understand", cards: [
          { tab: "project", glyph: "\u25c8", title: "Project diagram", desc: "Controller-wide dataflow of tags, routines and I/O.", needsModel: true },
          { tab: "io", glyph: "\u21c4", title: "I/O map", desc: "Map any tag (any scope) to its physical module point.", needsModel: true },
          { tab: "iolist", glyph: "\u2261", title: "I/O list", desc: "Commissioning list with logic references and buffer tags.", needsModel: true },
          { tab: "moduleio", glyph: "\u25a6", title: "Module I/O", desc: "Hardware vs network I/O, used bits, Mermaid dataflow, terminal schematic.", needsModel: true },
          { tab: "udt", glyph: "\u25eb", title: "Data types", desc: "UDT shape with nested members, byte/bit layout.", needsModel: true },
          { tab: "acd", glyph: "\u25c9", title: "ACD metadata", desc: "Open .ACD archives: controller, data types, tag database.", needsAcd: true }
        ]
      },
      {
        title: "Edit & convert", cards: [
          { tab: "routine", glyph: "\u25a4", title: "Routine editors", desc: "Ladder, function block and structured text editors (select a routine in the tree).", needsModel: true },
          { tab: "convert", glyph: "\u21cb", title: "Convert", desc: "Convert routines LAD \u2194 FBD \u2194 ST with warnings and preview.", needsModel: true },
          { tab: "aoi", glyph: "\u2699", title: "AOI library", desc: "Add-On Instruction parameters, local tags and routines.", needsModel: true }
        ]
      },
      {
        title: "Analyze & ship", cards: [
          { tab: "validation", glyph: "\u2713", title: "Validation", desc: "Official L5X schema check (v32\u2013v38) of loads and exports.", needsModel: true },
          { tab: "health", glyph: "\u2665", title: "Health report", desc: "Unused tags, unresolved operands, uncalled routines.", needsModel: true },
          { action: "exportc", glyph: "C", title: "Export C", desc: "Translate routines to C for verification and porting.", needsModel: true }
        ]
      },
      {
        title: "Generate & build", cards: [
          { tab: "conveyor", glyph: "\u26d3", title: "Conveyor studio", desc: "Draw roller/belt conveyors, merges and transfers; get BOM, L5X and HMI.", needsModel: false },
          { tab: "dnet", glyph: "\u26c1", title: "DeviceNet (.dnt)", desc: "Analyse RSNetWorx DeviceNet networks; merges into the open project\u2019s module dataflow.", needsModel: false }
        ]
      }
    ];
    const grid = h("div", "welcome-groups");
    for (const group of groups) {
      const g = h("div", "welcome-group");
      g.appendChild(h("div", "welcome-group-title", group.title));
      const cards = h("div", "welcome-cards");
      for (const c of group.cards) {
        const card = h("button", "welcome-card");
        card.appendChild(h("span", "welcome-card-glyph", c.glyph));
        card.appendChild(h("span", "welcome-card-title", c.title));
        card.appendChild(h("span", "welcome-card-desc", c.desc));
        const missing = (c.needsModel && !self.model) || (c.needsAcd && !self.acd);
        if (missing) card.className = "welcome-card needs-project";
        card.title = missing ? "Open a project first" : c.title;
        (function (spec, miss) {
          card.addEventListener("click", function () {
            if (miss) { self.status("Open a project first (Ctrl+O).", true); self.fileInput.click(); return; }
            if (spec.action === "exportc") self.exportProjectC();
            else if (spec.tab) self._openTab(spec.tab);
          });
        })(c, missing);
        cards.appendChild(card);
      }
      g.appendChild(cards);
      grid.appendChild(g);
    }
    w.appendChild(grid);
    v.appendChild(w);
  };

  App.prototype._wireHeader = function () {
    const self = this;
    this.btnOpen.addEventListener("click", function () { self.fileInput.click(); });
    this.fileInput.addEventListener("change", function () {
      const f = self.fileInput.files && self.fileInput.files[0];
      if (f) self.loadFile(f);
      self.fileInput.value = "";
    });
    this.btnExport.addEventListener("click", function () { self.exportProject(); });
    this.btnSidebar.addEventListener("click", function () { self._toggleSidebar(); });
    this.btnPalette.addEventListener("click", function () { self._openPalette(); });
    // keyboard shortcuts
    document.addEventListener("keydown", function (e) {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const key = String(e.key || "").toLowerCase();
      if (key === "k") { e.preventDefault(); if (self.paletteVisible) self._closePalette(); else self._openPalette(); }
      else if (key === "o") { e.preventDefault(); self.fileInput.click(); }
      else if (key === "s") { e.preventDefault(); self.exportProject(); }
    });
    // drag & drop
    let dragDepth = 0;
    document.addEventListener("dragenter", function (e) {
      e.preventDefault();
      dragDepth++;
      self.dropOverlay.style.display = "block";
    });
    document.addEventListener("dragleave", function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) self.dropOverlay.style.display = "none";
    });
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      self.dropOverlay.style.display = "none";
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) self.loadFile(f);
    });
  };

  App.prototype.status = function (msg, isError) {
    this.statusEl.textContent = msg || "";
    this.statusEl.className = "status-bar" + (isError ? " error" : "");
  };

  App.prototype.loadFile = function (file) {
    const self = this;
    const isAcd = /\.acd$/i.test(file.name);
    const isDnt = /\.dnt$/i.test(file.name);
    const isHtmlReport = /\.(html?|htm)$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = function () {
      try {
        if (isAcd) self.loadAcd(file.name, reader.result);
        else if (isDnt) self.openDnt(file.name, reader.result);
        else if (isHtmlReport) self.openDnetHtml(file.name, String(reader.result));
        else self.loadText(file.name, String(reader.result));
      } catch (e) {
        self.status("Failed to load " + file.name + ": " + e.message, true);
        console.error(e);
      }
    };
    reader.onerror = function () { self.status("Failed to read file " + file.name, true); };
    if (isAcd || isDnt) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  /* Open a DeviceNet network file (.dnt). The network is analysed standalone in the DeviceNet
     workspace and — when a project is open — merged into the Module I/O dataflow. */
  App.prototype.openDnt = function (fileName, bytes) {
    const ns = NS();
    if (typeof ns.parseDnt !== "function") {
      this.status("DeviceNet (.dnt) parser is not available.", true);
      return null;
    }
    try {
      const parsed = ns.parseDnt(bytes, { fileName: fileName });
      parsed.fileName = fileName;
      this.dnts = this.dnts.filter(function (d) { return d.fileName !== fileName; });
      this.dnts.push(parsed);
      if (this.tree) this._attachDnetLogic(parsed);
      this._dntStamp++;
      if (this.model) { this._panels = {}; this._moduleStamp = (this._moduleStamp || 0) + 1; }
      if (this.tree) this._buildTree();
      this.status("Opened DeviceNet network " + fileName + ": " + parsed.devices.length +
        " remote device(s)" + (parsed.scannerInfo && parsed.scannerInfo.eprMs ? " (scanner EPR " + parsed.scannerInfo.eprMs + " ms)" : "") + ".");
      this._openTab("dnet");
      return parsed;
    } catch (e) {
      this.status("Failed to parse " + fileName + ": " + e.message, true);
      return null;
    }
  };

  App.prototype._requireModel = function () {
    if (!this.model) { this.status("Load an L5X project first (ACD files are metadata-only).", true); return false; }
    return true;
  };

  /* Load a Rockwell .ACD archive: metadata view (controller identity, data types with
     exact offsets, tag database, archive files). Logic is not decoded. */
  App.prototype.loadAcd = function (fileName, arrayBuffer) {
    const self = this;
    const ns = NS();
    if (typeof ns.readAcd !== "function") { this.status("ACD reader not loaded.", true); return; }
    ns.readAcd(arrayBuffer).then(function (res) {
      self.acd = res;
      self.acdFileName = fileName;
      self.model = null;
      self.selection = null;
      self.editor = null;
      self.validationResult = null;
      self._tagWebCache = null;
      self._panels = {};
      self.tabs = [];
      self.tabBar.innerHTML = "";
      self.view.innerHTML = "";
      self.activeTab = null;
      const ctrl = res.controller || {};
      self.projectName.textContent = fileName + " \u00b7 " + (ctrl.name || res.tagInfoName || "ACD") +
        (ctrl.swVersion ? " (" + ctrl.swVersion + ")" : "");
      self._buildTree();
      self._updateRailAvailability();
      self._openTab("acd");
      self.status("Opened ACD metadata: " + res.dataTypes.length + " data types, " +
        res.tags.length + " tags, " + res.programs.length + " programs, " +
        res.files.length + " archive files (logic not parsed \u2014 export L5X for full features).");
    }).catch(function (e) {
      self.status("Failed to read ACD: " + e.message, true);
      console.error(e);
    });
  };

  App.prototype.loadText = function (fileName, text) {
    const ns = NS();
    const model = ns.parseL5X(text);
    model.fileName = fileName;
    this.model = model;
    this.acd = null;
    this.acdFileName = null;
    this.selection = null;
    this.editor = null;
    this.validationResult = null;
    this._tagWebCache = null;
    this._panels = {};
    // reset tab state (old tabs close over the previous model)
    this.tabs = [];
    this.tabBar.innerHTML = "";
    this.view.innerHTML = "";
    this.activeTab = null;
    this.projectName.textContent = fileName + " \u00b7 " + model.controller.name +
      " (" + model.controller.processorType + " v" + model.controller.majorRev + "." + model.controller.minorRev + ")";
    this._buildTree();
    this._updateRailAvailability();
    this._openTab("project");
    this.status("Loaded " + model.programs.length + " programs, " +
      model.programs.reduce(function (a, p) { return a + p.routines.length; }, 0) + " routines, " +
      model.dataTypes.length + " data types, " + model.modules.length + " modules, " +
      model.tags.controller.length + " controller tags.");
    // run schema validation in the background (when the validator module is loaded)
    const self = this;
    setTimeout(function () {
      try {
        self.runValidation();
        const vtab = self.tabs.find(function (t) { return t.type === "validation"; });
        if (vtab) self._renderValidation();
      } catch (e) { console.warn("Validation skipped:", e.message); }
    }, 60);
  };

  /* ---------------- project tree ---------------- */
  App.prototype._buildTree = function () {
    if (this.acd && !this.model) { this._buildAcdTree(); return; }
    if (!this.model) { this._buildDnetTree(); return; }
    const self = this;
    const model = this.model;
    const tree = this.tree;
    tree.innerHTML = "";
    const root = h("div", "tree-root");
    // Controller
    const ctrl = h("div", "tree-node");
    const ctrlHead = h("div", "tree-head tree-project", model.controller.name + "  \u00b7  " + model.controller.processorType);
    ctrl.appendChild(ctrlHead);
    ctrlHead.addEventListener("click", function () { self._openTab("project"); });
    root.appendChild(ctrl);

    function folder(label) {
      const node = h("div", "tree-node");
      const head = h("div", "tree-head tree-folder", "\u25b8 " + label);
      const body = h("div", "tree-body");
      body.style.display = "none";
      node.appendChild(head); node.appendChild(body);
      head.addEventListener("click", function () {
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "block";
        head.textContent = (open ? "\u25b8 " : "\u25be ") + label;
      });
      return { node: node, body: body };
    }

    // Data types
    const dtf = folder("Data Types (" + model.dataTypes.length + ")");
    for (const dt of model.dataTypes) {
      const item = h("div", "tree-leaf", dt.name);
      item.title = dt.description || dt.family;
      item.addEventListener("click", function () {
        self.selection = { type: "udt", name: dt.name };
        self._openTab("udt");
      });
      dtf.body.appendChild(item);
    }
    root.appendChild(dtf.node);

    // Tags
    const tf = folder("Tags");
    const ctlTags = folder("Controller tags (" + model.tags.controller.length + ")");
    for (const t of model.tags.controller) {
      const item = h("div", "tree-leaf tag-leaf", t.name + (t.aliasFor ? "  \u21d2" : "") + (t.tagType === "Alias" ? "  (alias)" : ""));
      item.title = t.dataType + (t.description ? "\n" + t.description : "");
      item.addEventListener("click", function () { self._inspectOperand(t.name, null); });
      ctlTags.body.appendChild(item);
    }
    tf.body.appendChild(ctlTags.node);
    root.appendChild(tf.node);

    // Modules
    const mf = folder("Modules (" + model.modules.length + ")");
    for (const m of model.modules) {
      const item = h("div", "tree-leaf module-leaf", m.name + "  \u00b7  " + m.catalogNumber);
      item.title = (m.parentModule === "Local" ? "slot " + m.parentModPortId : "via " + m.parentModule);
      item.addEventListener("click", function () {
        self.selection = { type: "module", name: m.name };
        self._openTab("io");
      });
      mf.body.appendChild(item);
    }
    root.appendChild(mf.node);

    // Programs
    const pf = folder("Programs (" + model.programs.length + ")");
    for (const p of model.programs) {
      const pnode = h("div", "tree-node");
      const phead = h("div", "tree-head tree-folder", "\u25b8 " + p.name);
      const pbody = h("div", "tree-body");
      pbody.style.display = "none";
      pnode.appendChild(phead); pnode.appendChild(pbody);
      phead.addEventListener("click", function () {
        const open = pbody.style.display !== "none";
        pbody.style.display = open ? "none" : "block";
        phead.textContent = (open ? "\u25b8 " : "\u25be ") + p.name;
      });
      if (model.tags.programs[p.name] && model.tags.programs[p.name].length) {
        const ptags = folder("Tags (" + model.tags.programs[p.name].length + ")");
        for (const t of model.tags.programs[p.name]) {
          const item = h("div", "tree-leaf tag-leaf", t.name + (t.aliasFor ? "  \u21d2" : "") + (t.tagType === "Alias" ? "  (alias)" : ""));
          item.title = t.dataType + (t.description ? "\n" + t.description : "");
          (function (tn, pn) {
            item.addEventListener("click", function () { self._inspectOperand(tn, { program: pn }); });
          })(t.name, p.name);
          ptags.body.appendChild(item);
        }
        pbody.appendChild(ptags.node);
      }
      const routs = folder("Routines (" + p.routines.length + ")");
      for (const rt of p.routines) {
        const kind = TYPE_TO_KIND[rt.pendingType || rt.type] || "raw";
        const item = h("div", "tree-leaf routine-leaf",
          rt.name + "  [" + (rt.pendingType || rt.type) + "]");
        (function (pn, rn) {
          item.addEventListener("click", function () {
            self.selection = { type: "routine", program: pn, routine: rn };
            self._openTab("routine");
          });
        })(p.name, rt.name);
        routs.body.appendChild(item);
      }
      pbody.appendChild(routs.node);
      pf.body.appendChild(pnode);
    }
    root.appendChild(pf.node);

    // Add-On Instructions
    if (model.addOnInstructions && model.addOnInstructions.length) {
      const af = folder("Add-On Instructions (" + model.addOnInstructions.length + ")");
      for (const aoi of model.addOnInstructions) {
        const item = h("div", "tree-leaf aoi-leaf", aoi.name + "  \u00b7 rev " + (aoi.revision || "?"));
        item.title = (aoi.description || "") + "\n" + aoi.parameters.length + " parameters, " +
          (aoi.localTags || []).length + " local tags, " + (aoi.routines || []).length + " routines";
        (function (name) {
          item.addEventListener("click", function () {
            self._openTab("aoi");
            if (self._panels.aoi) { self._panels.aoi.selected = name; self._panels.aoi.refresh(); }
          });
        })(aoi.name);
        af.body.appendChild(item);
      }
      root.appendChild(af.node);
    }
    this._appendDnetTree(root);
    tree.appendChild(root);
  };

  /* Tree for an .ACD metadata-only view */
  App.prototype._buildAcdTree = function () {
    const self = this;
    const acd = this.acd;
    const tree = this.tree;
    tree.innerHTML = "";
    const root = h("div", "tree-root");
    const ctrl = (acd.controller || {});
    const head = h("div", "tree-head tree-project",
      (ctrl.name || acd.tagInfoName || "ACD project") + "  \u00b7  " + (ctrl.swVersion || "ACD"));
    head.addEventListener("click", function () {
      self._openTab("acd");
      if (self._panels.acd) { self._panels.acd.view = "types"; self._panels.acd.refresh(); }
    });
    root.appendChild(head);
    const items = [
      ["Data types (" + acd.dataTypes.length + ")", "types"],
      ["Controller tags (" + acd.tags.filter(function (t) { return t.scope === "controller"; }).length + ")", "ctags"],
      ["Program tags (" + acd.tags.filter(function (t) { return t.scope !== "controller"; }).length + ")", "ptags"],
      ["Archive files (" + acd.files.length + ")", "files"]
    ];
    for (const [label, view] of items) {
      const it = h("div", "tree-leaf", label);
      (function (v) {
        it.addEventListener("click", function () {
          self._openTab("acd");
          if (self._panels.acd) { self._panels.acd.view = v; self._panels.acd.refresh(); }
        });
      })(view);
      root.appendChild(it);
    }
    const note = h("div", "tree-note", "ACD logic is stored in binary databases and is not parsed. Export L5X for dataflow/editing.");
    root.appendChild(note);
    this._appendDnetTree(root);
    tree.appendChild(root);
  };

  /* ---------------- tabs ---------------- */
  App.prototype._openTab = function (id, opts) {
    const tabs = {
      project: { label: "Project diagram", render: this._renderProjectDiagram.bind(this) },
      routine: { label: "Routine", render: this._renderRoutine.bind(this) },
      udt: { label: "Data type", render: this._renderUdt.bind(this) },
      io: { label: "I/O map", render: this._renderIo.bind(this) },
      convert: { label: "Convert", render: this._renderConvert.bind(this) },
      iolist: { label: "I/O list", render: this._renderIoList.bind(this) },
      validation: { label: "Validation", render: this._renderValidation.bind(this) },
      health: { label: "Health", render: this._renderHealth.bind(this) },
      aoi: { label: "Add-On Instructions", render: this._renderAoi.bind(this) },
      acd: { label: "ACD metadata", render: this._renderAcd.bind(this) },
      moduleio: { label: "Module I/O", render: this._renderModuleIo.bind(this) },
      dnet: { label: "DeviceNet", render: this._renderDnet.bind(this) },
      dnetnode: { label: "DeviceNet node", render: this._renderDnetNode.bind(this) },
      conveyor: { label: "Conveyor studio", render: this._renderConveyor.bind(this) }
    };
    const def = tabs[id];
    if (!def) return;
    opts = opts || {};
    /* Tabs identify their contents. Per-item views (routines, data types) get their own tab,
       labelled with the item name and titled with the full context; global views keep one tab. */
    let key = opts.key, label = opts.label || def.label, title = opts.title || "";
    if (!key) {
      if (id === "routine" && this.selection && this.selection.type === "routine") {
        key = "routine:" + this.selection.program + "/" + this.selection.routine;
        label = this.selection.routine;
        title = this.selection.program + " / " + this.selection.routine + " \u2014 ladder / FBD / ST routine";
      } else if (id === "udt" && this.selection && this.selection.name) {
        key = "udt:" + this.selection.name;
        label = this.selection.name;
        title = "Data type " + this.selection.name;
      } else {
        key = id;
      }
    }
    // reuse existing tab
    let tab = this.tabs.find(function (t) { return t.id === key; });
    if (!tab) {
      tab = { id: key, key: key, type: id, label: label, title: title, el: h("div", "tab-page") };
      this.tabs.push(tab);
      const btn = h("button", "tab-btn");
      btn.title = title || label;
      btn.appendChild(h("span", "tab-btn-label", label));
      const close = h("span", "tab-close", "\u00d7");
      close.title = "Close tab";
      (function (self, tabId) {
        close.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          self._closeTab(tabId);
        });
      })(this, key);
      btn.appendChild(close);
      btn.addEventListener("click", (function () { this._activateTab(key); }).bind(this));
      tab.btn = btn;
      this.tabBar.appendChild(btn);
    }
    // a clean workspace: the Home dashboard replaces the view, so re-opening any view
    // must clear it before the tab page is attached again
    if (this.view) this.view.innerHTML = "";
    this._activateTab(key);
    def.render();
  };

  /* Close a tab; if it was active, activate the neighbouring tab (or the home dashboard). */
  App.prototype._closeTab = function (id) {
    const idx = this.tabs.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    const tab = this.tabs[idx];
    if (tab.el && tab.el.parentNode && tab.el.remove) tab.el.remove();
    if (tab.btn && tab.btn.parentNode && tab.btn.remove) tab.btn.remove();
    this.tabs.splice(idx, 1);
    if (this.activeTab !== id) return;
    this.activeTab = null;
    if (this.tabs.length) {
      this._activateTab(this.tabs[Math.max(0, idx - 1)].id);
    } else {
      this._updateRail(null);
      this._welcome();
    }
  };

  /* The tab element currently being rendered (type = base view id such as "routine"). */
  App.prototype._tabForRender = function (type) {
    const active = this.tabs.find(function (t) { return t.id === this.activeTab; }, this);
    if (active && active.type === type) return active;
    return this.tabs.find(function (t) { return t.type === type; }, this) || null;
  };

  App.prototype._activateTab = function (id) {
    for (const t of this.tabs) {
      const on = t.id === id;
      t.btn.className = "tab-btn" + (on ? " active" : "");
      t.el.style.display = on ? "" : "none";
      if (on) {
        if (t.el.parentNode !== this.view) this.view.appendChild(t.el);
      }
    }
    this.activeTab = id;
    const tab = this.tabs.find(function (t) { return t.id === id; });
    this._updateRail(id, tab ? tab.type : id);
  };

  /* ---------------- project diagram ---------------- */
  App.prototype._renderProjectDiagram = function () {
    const ns = NS();
    const tab = this._tabForRender("project");
    tab.el.innerHTML = "";
    const head = h("div", "view-toolbar");
    head.appendChild(h("span", "view-title", "Controller-wide dataflow"));
    head.appendChild(h("span", "view-hint", "click a tag node to resolve it to a physical I/O point"));
    const refreshBtn = h("button", "btn", "Refresh");
    head.appendChild(refreshBtn);
    tab.el.appendChild(head);
    const body = h("div", "diagram-host");
    tab.el.appendChild(body);
    const note = h("div", "view-note");
    tab.el.appendChild(note);
    const self = this;
    function draw() {
      body.innerHTML = "";
      note.textContent = "";
      let graph = null;
      try { graph = ns.buildTagWeb(self.model, {}); }
      catch (e) { note.textContent = "Tag web build failed: " + e.message; return; }
      // prune for display
      const maxNodes = 700;
      if (graph.nodes.length > maxNodes) {
        graph.nodes.sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
        const kept = new Set(graph.nodes.slice(0, maxNodes).map(function (n) { return n.id; }));
        graph.nodes = graph.nodes.filter(function (n) { return kept.has(n.id); });
        graph.edges = graph.edges.filter(function (e) { return kept.has(e.from) && kept.has(e.to); });
        note.textContent = "Graph pruned to the " + maxNodes + " most-connected nodes (" + (kept.size) + " shown).";
      }
      ns.renderDataflow(body, graph, {
        onNodeClick: function (node) {
          if (node.tag) self._inspectOperand(node.tag, null);
        }
      });
    }
    refreshBtn.addEventListener("click", draw);
    draw();
  };

  /* ---------------- routine view ---------------- */
  App.prototype._renderRoutine = function () {
    const ns = NS();
    const sel = this.selection;
    const model = this.model;
    const tab = this._tabForRender("routine");
    tab.el.innerHTML = "";
    if (!sel || sel.type !== "routine") {
      tab.el.appendChild(h("div", "view-note", "Select a routine in the project tree."));
      return;
    }
    const r = model.findRoutine(sel.program, sel.routine);
    if (!r) {
      tab.el.appendChild(h("div", "view-note", "Routine not found."));
      return;
    }
    const self = this;
    const currentType = r.pendingType || r.type;
    const kind = TYPE_TO_KIND[currentType] || "raw";
    const converted = !!r.pendingType && r.pendingType !== r.type;
    const toolbar = h("div", "view-toolbar");
    toolbar.appendChild(h("span", "view-title", sel.routine));
    toolbar.appendChild(h("span", "view-subtitle", sel.program + " \u00b7 " + currentType));
    if (converted) {
      const badge = h("span", "pill warn", "converted \u2192 " + currentType + " (staged, not saved)");
      badge.title = "The routine content is converted in memory. Review it below, then use Export L5X to write the modified project.";
      toolbar.appendChild(badge);
    }
    const convertBtn = h("button", "btn", "Convert\u2026");
    convertBtn.addEventListener("click", function () { self._openTab("convert"); });
    toolbar.appendChild(convertBtn);
    const exportCBtn = h("button", "btn", "Export C");
    exportCBtn.title = "Generate a C translation of this routine (l5x2c-style, for verification/porting)";
    exportCBtn.addEventListener("click", function () { self.exportRoutineC(sel.program, sel.routine); });
    toolbar.appendChild(exportCBtn);
    const exportBtn = h("button", "btn", "Export L5X");
    exportBtn.addEventListener("click", function () { self.exportProject(); });
    toolbar.appendChild(exportBtn);
    tab.el.appendChild(toolbar);

    const subtabs = h("div", "subtab-bar");
    const subDefs = [
      { id: "diagram", label: "Dataflow diagram" },
      { id: "editor", label: "Editor" },
      { id: "text", label: "Text" }
    ];
    const subBtns = {};
    for (const sd of subDefs) {
      const b = h("button", "subtab-btn", sd.label);
      b.addEventListener("click", (function (id) { self._routineSubview = id; setActive(id); }).bind(this, sd.id));
      subBtns[sd.id] = b;
      subtabs.appendChild(b);
    }
    tab.el.appendChild(subtabs);
    const subBody = h("div", "subtab-body");
    tab.el.appendChild(subBody);
    const errBox = h("div", "view-note");
    tab.el.appendChild(errBox);

    let ir = null;
    try { ir = model.getRoutineIR(sel.program, sel.routine); }
    catch (e) { errBox.textContent = "Could not parse routine content: " + e.message; }
    if (!ir) ir = { kind: "lad", rungs: [] };

    function routineText() {
      const c = r.content || {};
      if (c.kind === "st") return (c.text || "").replace(/\r\n/g, "\n");
      if (c.kind === "rll") {
        return (c.rungs || []).map(function (rg, i) {
          const lines = [];
          const num = rg.number !== undefined ? rg.number : i;
          if (rg.comment) lines.push("// " + String(rg.comment).replace(/\r?\n/g, "\n// "));
          lines.push("Rung " + num + ": " + (rg.text || "") + (rg.type && rg.type !== "N" ? "   [type " + rg.type + "]" : ""));
          return lines.join("\n");
        }).join("\n\n");
      }
      if (c.kind === "fbd" || c.kind === "sfc" || c.kind === "raw") return c.xmlText || "";
      return "(no content)";
    }

    function setActive(id) {
      for (const k of Object.keys(subBtns)) subBtns[k].className = "subtab-btn" + (k === id ? " active" : "");
      errBox.textContent = "";
      if (id === "diagram") showDiagram();
      else if (id === "editor") showEditor();
      else showText();
    }

    function showDiagram() {
      subBody.innerHTML = "";
      const host = h("div", "diagram-host");
      subBody.appendChild(host);
      let graph = null;
      try {
        graph = kind === "fbd" ? ns.buildFbdDataflow(ir, {}) : ns.buildRoutineDataflow(ir, { routineName: sel.routine });
      } catch (e) {
        errBox.textContent = "Dataflow build failed: " + e.message + " (use the Text tab to view the routine)";
        return;
      }
      ns.renderDataflow(host, graph, {
        onNodeClick: function (node) {
          if (node.tag) self._inspectOperand(node.tag, { program: sel.program });
        }
      });
      host.appendChild(h("div", "diagram-hint", "Drag to pan \u00b7 wheel to zoom"));
    }

    function showText() {
      subBody.innerHTML = "";
      const pre = h("pre", "routine-text");
      pre.textContent = routineText();
      subBody.appendChild(pre);
    }

    function showEditor() {
      subBody.innerHTML = "";
      self.editor = null;
      const shell = h("div", "editor-shell");
      const editorBar = h("div", "module-subbar");
      editorBar.appendChild(h("span", "view-hint",
        kind === "st" ? "Structured text editor \u2014 syntax errors are reported in the status bar."
          : "Scroll to move around the routine \u00b7 use the zoom controls to scale the rungs/blocks."));
      shell.appendChild(editorBar);
      const host = h("div", "editor-host");
      shell.appendChild(host);
      subBody.appendChild(shell);
      try {
        if (kind === "lad" && typeof ns.LadderEditor === "function") {
          self.editor = new ns.LadderEditor({
            container: host, ir: ir,
            ctx: { model: model, program: sel.program, routine: sel.routine },
            onChange: function (newIr) {
              const content = model.irToContent(sel.program, sel.routine, newIr);
              model.setRoutineContent(sel.program, sel.routine, "RLL", content);
              self.status("Rung edit staged for " + sel.program + "/" + sel.routine);
            }
          });
          if (self.editor && typeof self.editor.render === "function") self.editor.render();
        } else if (kind === "fbd" && typeof ns.FbdEditor === "function") {
          self.editor = new ns.FbdEditor({
            container: host, ir: ir,
            ctx: { model: model, program: sel.program, routine: sel.routine },
            onChange: function (newIr) {
              const content = model.irToContent(sel.program, sel.routine, newIr);
              model.setRoutineContent(sel.program, sel.routine, "FBD", content);
              self.status("FBD edit staged for " + sel.program + "/" + sel.routine);
            }
          });
          if (self.editor && typeof self.editor.render === "function") self.editor.render();
        } else if (kind === "st" && typeof ns.StEditor === "function") {
          self.editor = new ns.StEditor({
            container: host, ir: ir,
            ctx: { model: model, program: sel.program, routine: sel.routine },
            onChange: function (newIr) {
              const content = model.irToContent(sel.program, sel.routine, newIr);
              model.setRoutineContent(sel.program, sel.routine, "ST", content);
              self.status("ST edit staged for " + sel.program + "/" + sel.routine);
            },
            onDiagnostics: function (errors) {
              self.status(errors && errors.length ? errors.length + " syntax error(s) in " + sel.routine : "", !!errors && errors.length);
            }
          });
          if (self.editor && typeof self.editor.render === "function") self.editor.render();
        } else {
          host.appendChild(h("div", "view-note",
            "No visual editor is available for this routine kind (" + currentType + "). Use the Text tab to view/edit the content, or Convert it to LAD/ST/FBD first."));
          const pre = h("pre", "routine-text");
          pre.textContent = routineText();
          host.appendChild(pre);
        }
        if (self.editor && host.children.length === 0) {
          // editor constructed but rendered nothing: never show a blank pane
          const pre = h("pre", "routine-text");
          pre.textContent = routineText();
          host.appendChild(h("div", "view-note", "Editor produced no visible content for this routine; showing the routine text instead."));
          host.appendChild(pre);
        }
      } catch (e) {
        host.innerHTML = "";
        host.appendChild(h("div", "view-note err", "Editor failed to open: " + e.message + " \u2014 showing the routine text instead."));
        const pre = h("pre", "routine-text");
        pre.textContent = routineText();
        host.appendChild(pre);
        self.editor = null;
        console.error(e);
      }
      /* zoom controls for the graphical editors (CSS zoom keeps hit-testing correct) */
      if ((kind === "lad" || kind === "fbd") && self.editor && typeof ns.editorZoomControls === "function") {
        try {
          editorBar.appendChild(ns.editorZoomControls(host, {
            target: function () { return host.querySelector("svg"); }
          }));
        } catch (e2) { /* controls are optional */ }
      }
    }

    const preferred = this._routineSubview || (converted ? "editor" : "diagram");
    const start = subBtns[preferred] ? preferred : "diagram";
    setActive(start);
  };

  /* ---------------- UDT view ---------------- */
  App.prototype._renderUdt = function () {
    const ns = NS();
    const tab = this._tabForRender("udt");
    tab.el.innerHTML = "";
    const sel = this.selection;
    if (!sel || sel.type !== "udt") {
      tab.el.appendChild(h("div", "view-note", "Select a data type in the project tree."));
      return;
    }
    const toolbar = h("div", "view-toolbar");
    toolbar.appendChild(h("span", "view-title", "Data type shape"));
    const picker = h("select", null);
    for (const dt of this.model.dataTypes) {
      const o = h("option", null, dt.name);
      o.value = dt.name;
      if (dt.name === sel.name) o.selected = true;
      picker.appendChild(o);
    }
    toolbar.appendChild(picker);
    tab.el.appendChild(toolbar);
    const body = h("div", "udt-host");
    tab.el.appendChild(body);
    const self = this;
    function draw() {
      ns.renderUdtTree(body, self.model, picker.value, {});
    }
    picker.addEventListener("change", function () {
      self.selection = { type: "udt", name: picker.value };
      draw();
    });
    draw();
  };

  /* ---------------- I/O map view ---------------- */
  App.prototype._renderIo = function () {
    const tab = this._tabForRender("io");
    tab.el.innerHTML = "";
    const toolbar = h("div", "view-toolbar");
    toolbar.appendChild(h("span", "view-title", "I/O map \u2014 tag to physical point"));
    tab.el.appendChild(toolbar);
    const body = h("div", "iop-host");
    tab.el.appendChild(body);
    this.ioPanel = new NS().IOPanel({
      container: body,
      app: {
        model: this.model,
        inspectOperand: this._inspectOperand.bind(this),
        selectModule: function (name) { }
      },
      scope: this.selection && this.selection.type === "routine" ? { program: this.selection.program } : null
    });
  };

  /* ---------------- convert view ---------------- */
  App.prototype._renderConvert = function () {
    const tab = this._tabForRender("convert");
    tab.el.innerHTML = "";
    this.convertPanel = new NS().ConversionPanel({
      container: tab.el,
      app: {
        model: this.model,
        getSelection: (function () { return this.selection; }).bind(this),
        onRoutineConverted: this.onRoutineConverted.bind(this)
      }
    });
    this.convertPanel.refresh();
  };

  App.prototype.onRoutineConverted = function (program, routine, kind, warnings) {
    this.status("Converted " + program + "/" + routine + " to " +
      (kind === "lad" ? "ladder" : kind === "st" ? "structured text" : "function block") +
      " (" + (warnings || []).length + " warnings)");
    // open the converted routine straight in the editor so the result is visible
    this._routineSubview = "editor";
    if (this.selection && this.selection.type === "routine" &&
        this.selection.program === program && this.selection.routine === routine) {
      this._openTab("routine");
    }
    this._buildTree();
  };

  /* ---------------- operand inspection ---------------- */
  App.prototype._inspectOperand = function (operandText, scope) {
    this._openTab("io");
    if (this.ioPanel) {
      this.ioPanel.setScope(scope || null);
      this.ioPanel.inspect(operandText);
    }
  };

  App.prototype.getSelection = function () { return this.selection; };

  /* ---------------- export ---------------- */
  App.prototype.exportProject = function () {
    const ns = NS();
    if (!this.model) { this.status("No project loaded", true); return; }
    const dirty = ns.dirtyRoutines(this.model);
    if (!dirty.length) {
      this.status("No changes staged \u2014 nothing to export.", true);
      return;
    }
    const result = ns.exportL5X(this.model, {});
    const blob = new Blob([result.text], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = (this.model.fileName || "project.L5X").replace(/\.L5X$/i, "");
    a.href = url;
    a.download = base + "-modified.L5X";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    this.status("Exported " + dirty.length + " changed routine(s)" +
      (result.warnings.length ? " \u00b7 " + result.warnings.length + " warning(s): " + result.warnings.slice(0, 3).join(" | ") : ""),
      result.warnings.length > 0);
    console.log("Export warnings:", result.warnings);
  };

  /* ---------------- app hooks for panels ---------------- */
  App.prototype._makeHooks = function () {
    const app = this;
    if (this._hooks) return this._hooks;
    this._hooks = {
      get model() { return app.model; },
      get acd() { return app.acd; },
      get acdFileName() { return app.acdFileName; },
      get dnts() { return app.dnts; },
      get dntHtmls() { return app.dntHtmls; },
      get dntStamp() { return app._dntStamp; },
      openDnt: function (name, bytes) { return app.openDnt(name, bytes); },
      openDnetNode: function (fileName, mac) { return app.openDnetNode(fileName, mac); },
      openDnetHtml: function (name, text) { return app.openDnetHtml(name, text); },
      openDnetHtmlFile: function () { return app.openDnetHtmlFile(); },
      attachDntFile: function (file) {
        const fr = new FileReader();
        fr.onload = function () { app.openDnt(file.name, fr.result); };
        fr.onerror = function () { app.status("Could not read " + file.name, true); };
        fr.readAsArrayBuffer(file);
      },
      status: function (msg, isError) { app.status(msg, isError); },
      openRoutine: function (program, routine) {
        app.selection = { type: "routine", program: program, routine: routine };
        app._openTab("routine");
      },
      getValidationResult: function () { return app.validationResult; },
      setValidationResult: function (r) { app.validationResult = r; },
      runValidation: function () { return app.runValidation(); },
      tagWeb: function () { return app._getTagWeb(); }
    };
    return this._hooks;
  };

  App.prototype._getPanel = function (name, factory) {
    if (!this._panels) this._panels = {};
    if (!this._panels[name]) this._panels[name] = factory();
    return this._panels[name];
  };

  /* Views render into a fresh body element each time. Reusing a cached panel would keep a
     stale, detached container (panels then render into a removed node), so view panels are
     recreated per render; any state that must survive lives on the app hooks instead. */
  App.prototype._newPanel = function (name, factory) {
    if (!this._panels) this._panels = {};
    this._panels[name] = factory();
    return this._panels[name];
  };

  App.prototype._getTagWeb = function () {
    const ns = NS();
    if (!this.model) return { nodes: [], edges: [] };
    if (!this._tagWebCache || this._tagWebModel !== this.model) {
      this._tagWebCache = ns.buildTagWeb(this.model, {});
      this._tagWebModel = this.model;
    }
    return this._tagWebCache;
  };

  /* ---------------- I/O list view ---------------- */
  App.prototype._renderIoList = function () {
    const ns = NS();
    const tab = this._tabForRender("iolist");
    tab.el.innerHTML = "";
    if (typeof ns.IoListPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "I/O list module is not loaded."));
      return;
    }
    const head = h("div", "view-toolbar");
    head.appendChild(h("span", "view-title", "I/O list"));
    head.appendChild(h("span", "view-hint", "module image points with logic references, buffer tags and CSV/Markdown export"));
    tab.el.appendChild(head);
    const body = h("div", "iolist-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("iolist", (function () {
      return new ns.IoListPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  /* ---------------- Validation view ---------------- */
  App.prototype._renderValidation = function () {
    const ns = NS();
    const tab = this._tabForRender("validation");
    tab.el.innerHTML = "";
    if (typeof ns.ValidationPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "Schema validation module is not loaded."));
      return;
    }
    const head = h("div", "view-toolbar");
    head.appendChild(h("span", "view-title", "L5X schema validation"));
    const self = this;
    const runBtn = h("button", "btn btn-primary", "Validate project");
    runBtn.addEventListener("click", function () {
      self.runValidation();
      if (self._panels.validation) self._panels.validation.refresh();
    });
    head.appendChild(runBtn);
    tab.el.appendChild(head);
    const body = h("div", "validation-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("validation", (function () {
      return new ns.ValidationPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  App.prototype.runValidation = function () {
    const ns = NS();
    if (!this.model) { this.status("Load an L5X project first.", true); return null; }
    if (typeof ns.validateModel !== "function") {
      this.status("Schema validation module is not loaded.", true);
      return null;
    }
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    try {
      const res = ns.validateModel(this.model, {});
      const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      res.elapsedMs = Math.round(t1 - t0);
      this.validationResult = res;
      const errs = (res.errors || []).length, warns = (res.warnings || []).length;
      this.status("Schema validation" + (res.schemaVersion ? " (" + res.schemaVersion + ")" : "") +
        ": " + errs + " error(s), " + warns + " warning(s) in " + res.elapsedMs + " ms", errs > 0);
      console.log("Validation: " + errs + " errors, " + warns + " warnings (schema " +
        (res.schemaVersion || "?") + ", " + res.elapsedMs + " ms)");
      return res;
    } catch (e) {
      this.status("Schema validation failed: " + e.message, true);
      console.error(e);
      return null;
    }
  };

  /* ---------------- Health view ---------------- */
  App.prototype._renderHealth = function () {
    const ns = NS();
    const tab = this._tabForRender("health");
    tab.el.innerHTML = "";
    if (typeof ns.HealthPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "Health analysis module is not loaded."));
      return;
    }
    const body = h("div", "health-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("health", (function () {
      return new ns.HealthPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  /* ---------------- AOI view ---------------- */
  App.prototype._renderAoi = function () {
    const ns = NS();
    const tab = this._tabForRender("aoi");
    tab.el.innerHTML = "";
    if (typeof ns.AoiPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "AOI browser module is not loaded."));
      return;
    }
    const body = h("div", "aoi-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("aoi", (function () {
      return new ns.AoiPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  /* ---------------- ACD metadata view ---------------- */
  App.prototype._renderAcd = function () {
    const ns = NS();
    const tab = this._tabForRender("acd");
    tab.el.innerHTML = "";
    if (typeof ns.AcdPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "ACD panel module is not loaded."));
      return;
    }
    const body = h("div", "acd-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("acd", (function () {
      return new ns.AcdPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
    /* ACD archives carry metadata (controller, data types, tag database) but their logic lives
       in binary component databases. Everything that can work from metadata is available here;
       opening the project's L5X export unlocks the full feature set, and attached DeviceNet
       networks merge into both. */
    const note = h("div", "view-note",
      "The ACD gives metadata (data types, tags, controller identity). Logic views (routines, conversion, " +
      "health, full I/O usage) need the project\u2019s L5X export \u2014 use Open L5X\u2026 with the matching export " +
      "(e.g. SAMPLE_RLL.L5X). Attach a DeviceNet .dnt below to add the remote DeviceNet layer.");
    body.appendChild(note);
    if (typeof ns.DnetPanel === "function") {
      const dnetBody = h("div", "dnet-host");
      body.appendChild(dnetBody);
      const dnetPanel = this._newPanel("acd-dnet", (function () {
        return new ns.DnetPanel({ container: dnetBody, app: this._makeHooks() });
      }).bind(this));
      dnetPanel.refresh();
    }
  };

  /* ---------------- C export ---------------- */
  App.prototype._downloadFiles = function (files, opts) {
    const names = Object.keys(files || {});
    if (!names.length) { this.status("Nothing to download.", true); return; }
    for (const name of names) {
      const blob = new Blob([files[name]], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ((opts && opts.prefix) ? opts.prefix + "-" : "") + name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
  };

  App.prototype.exportRoutineC = function (program, routine) {
    const ns = NS();
    if (!this.model) { this.status("Load an L5X project first.", true); return; }
    if (typeof ns.generateC !== "function") { this.status("C code generator module is not loaded.", true); return; }
    try {
      const res = ns.generateC(this.model, {
        programFilter: program, routineFilter: routine,
        filenameBase: "plcmodel"
      });
      this._downloadFiles(res.files, { prefix: (program + "_" + routine).replace(/[^\w-]+/g, "_") });
      this.status("Exported C for " + program + "/" + routine +
        (res.warnings.length ? " \u00b7 " + res.warnings.length + " warning(s)" : ""), res.warnings.length > 0);
      console.log("C generation warnings:", res.warnings);
    } catch (e) {
      this.status("C generation failed: " + e.message, true);
      console.error(e);
    }
  };

  App.prototype.exportProjectC = function () {
    const ns = NS();
    if (!this.model) { this.status("Load an L5X project first.", true); return; }
    if (typeof ns.generateC !== "function") { this.status("C code generator module is not loaded.", true); return; }
    try {
      const base = (this.model.fileName || "plcmodel").replace(/\.L5X$/i, "").replace(/[^\w-]+/g, "_");
      const res = ns.generateC(this.model, { filenameBase: "plcmodel" });
      this._downloadFiles(res.files, { prefix: base });
      this.status("Exported C program for the project (" + Object.keys(res.files).join(", ") + ")" +
        (res.warnings.length ? " \u00b7 " + res.warnings.length + " warning(s)" : ""), res.warnings.length > 0);
      console.log("C generation warnings:", res.warnings);
    } catch (e) {
      this.status("C generation failed: " + e.message, true);
      console.error(e);
    }
  };

  /* ---------------- Module I/O ---------------- */
  /* ---------------- DeviceNet networks ---------------- */
  /* DeviceNet networks + remote nodes in the project sidebar (like routines: click a node and
     its configuration "code" opens in a tab). */
  App.prototype._appendDnetTree = function (root) {
    const self = this;
    if (!this.dnts || !this.dnts.length) return;
    const section = h("div", "tree-node tree-dnet");
    const head = h("div", "tree-head tree-folder", "\u25b8 DeviceNet networks (" + this.dnts.length + ")");
    const body = h("div", "tree-body");
    body.style.display = "none";
    section.appendChild(head); section.appendChild(body);
    head.addEventListener("click", function () {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      head.textContent = (open ? "\u25b8 " : "\u25be ") + "DeviceNet networks (" + self.dnts.length + ")";
    });
    for (const net of this.dnts) {
      const netNode = h("div", "tree-node");
      const netHead = h("div", "tree-head tree-project",
        (net.fileName || "network") + "  \u00b7  " + (net.devices || []).length + " nodes" +
        (net.scannerInfo && net.scannerInfo.eprMs ? "  \u00b7  EPR " + net.scannerInfo.eprMs + " ms" : ""));
      netHead.title = "Open the DeviceNet network workspace";
      netHead.addEventListener("click", function () { self._openTab("dnet"); });
      netNode.appendChild(netHead);
      const netBody = h("div", "tree-body");
      for (const dev of (net.devices || [])) {
        (function (dev2) {
          const item = h("div", "tree-leaf dnet-leaf",
            "MAC " + dev2.macId + "  \u00b7  " + (dev2.name || "") + (dev2.catalogNumber ? "  \u00b7  " + dev2.catalogNumber : "") +
            (dev2.hasLogic ? "  \u00b7  FBD " + dev2.logic.count : ""));
          item.title = ["MAC " + dev2.macId, dev2.name, dev2.catalogNumber, dev2.transferType].filter(Boolean).join(" \u00b7 ");
          item.addEventListener("click", function () { self.openDnetNode(net.fileName, dev2.macId); });
          netBody.appendChild(item);
        })(dev);
      }
      netNode.appendChild(netBody);
      body.appendChild(netNode);
    }
    root.appendChild(section);
  };

  App.prototype._buildDnetTree = function () {
    const tree = this.tree;
    if (!tree) return;
    tree.innerHTML = "";
    const root = h("div", "tree-root");
    this._appendDnetTree(root);
    tree.appendChild(root);
    const section = root.children[0];
    if (section && section.children && section.children[1]) section.children[1].style.display = "block";
  };

  App.prototype.openDnetNode = function (fileName, mac, label) {
    const net = (this.dnts || []).find(function (n) { return n.fileName === fileName; });
    const dev = net ? (net.devices || []).find(function (d) { return d.macId === mac; }) : null;
    const nice = "DN " + String(mac).padStart(2, "0") + (dev && dev.name ? " " + dev.name : "");
    this._openTab("dnetnode", {
      key: "dnetnode:" + fileName + ":" + mac,
      label: label || nice,
      title: "DeviceNet node \u00b7 " + fileName + " \u00b7 MAC " + mac + (dev && dev.name ? " \u00b7 " + dev.name : "")
    });
  };

  /* Match a parsed RSNetWorx HTML logic export to its .dnt network and attach per-node logic. */
  App.prototype._attachDnetLogic = function (net) {
    if (!net || !this.dntHtmls || !this.dntHtmls.length) return false;
    const base = function (p) { return String(p || "").split(/[\\/]/).pop().replace(/\.(dnt|html?|htm)$/i, "").toLowerCase(); };
    const html = this.dntHtmls.find(function (h) {
      return base(h.dntFileName || h.fileName) === base(net.fileName) || base(h.networkName) === base(net.fileName) || base(h.fileName) === base(net.fileName);
    });
    if (!html) return false;
    net.logicExport = html;
    net.logicFileName = html.fileName;
    for (const node of (net.devices || [])) {
      const hd = (html.devices || []).find(function (x) { return x.address === node.macId || x.macId === node.macId; }) ||
        (html.devices || []).find(function (x) { return (x.name || "").toUpperCase() === (node.name || "").toUpperCase(); });
      if (hd) {
        const ns = NS();
        try {
          if (typeof ns.parseLocalLabels === "function" && typeof ns.annotateLogic === "function") {
            ns.annotateLogic(hd, ns.parseLocalLabels(node.pluginStrings || [], node.pluginTagMap || []));
          }
        } catch (e) { /* labels are an enhancement; keep the plain logic */ }
        node.logic = hd.logic || null;
        node.logicDevice = hd;
        node.hasLogic = !!(hd.logic && hd.logic.count);
        node.noLogic = !!hd.noLogic;
        if (!node.htmlParameters) node.htmlParameters = hd.parameters || [];
      }
    }
    return true;
  };

  /* Open an RSNetWorx "Export to HTML" report: adds the device logic (function-block rendition
     of the card's ladder) to the matching .dnt network, or browses standalone when no .dnt is open. */
  App.prototype.openDnetHtml = function (fileName, text) {
    const ns = NS();
    if (typeof ns.parseRsnetHtml !== "function") { this.status("DeviceNet HTML report parser is not loaded.", true); return null; }
    let parsed;
    try { parsed = ns.parseRsnetHtml(text, { fileName: fileName }); }
    catch (e) { this.status("Failed to parse " + fileName + " as an RSNetWorx report: " + e.message, true); return null; }
    parsed.fileName = fileName;
    this.dntHtmls = (this.dntHtmls || []).filter(function (h) { return h.fileName !== fileName; });
    this.dntHtmls.push(parsed);
    const base = function (p) { return String(p || "").split(/[\\/]/).pop().replace(/\.(dnt|html?|htm)$/i, "").toLowerCase(); };
    const target = (this.dnts || []).find(function (d) {
      return base(d.fileName) === base(fileName) || base(d.fileName) === base(parsed.dntFileName || "") ||
        base(d.fileName) === base(parsed.networkName || "");
    });
    if (target) {
      this._attachDnetLogic(target);
      this._dntStamp++;
      if (this.model) this._panels = {};
      this.status("Opened RSNetWorx logic export " + fileName + ": " + parsed.summary.devicesWithLogic + " device(s) with logic, " +
        parsed.summary.blocks + " function blocks \u2014 merged into " + target.fileName + ".");
      if (this.tree) this._buildTree();
      this._openTab("dnet");
      return parsed;
    }
    /* standalone: make a browsable network record from the report */
    const devices = (parsed.devices || []).map(function (d) {
      return {
        macId: d.address, name: d.name, catalogNumber: d.catalogNumber, transferType: null,
        inputBytes: undefined, outputBytes: undefined, pluginStrings: [], labels: { zoneData: [], other: [] },
        logic: d.logic || null, logicDevice: d, hasLogic: !!(d.logic && d.logic.count), noLogic: !!d.noLogic,
        htmlParameters: d.parameters || [], description: d.description || null
      };
    });
    const net = {
      fileName: parsed.dntFileName ? String(parsed.dntFileName).split(/[\\/]/).pop() : fileName,
      network: { name: parsed.networkName || fileName, declaredDeviceCount: devices.length, deviceCount: devices.length },
      devices: devices, scanner: null, warnings: [], fromHtml: true,
      logicExport: parsed, logicFileName: fileName
    };
    this.dnts = (this.dnts || []).filter(function (d) { return d.fileName !== net.fileName; });
    this.dnts.push(net);
    this._dntStamp++;
    if (this.model) this._panels = {};
    this.status("Opened device logic from " + fileName + " (no matching .dnt loaded): " + devices.length +
      " device(s), " + parsed.summary.blocks + " function blocks.");
    if (this.tree) this._buildTree();
    this._openTab("dnet");
    return parsed;
  };

  App.prototype.openDnetHtmlFile = function () {
    if (this.fileInput) this.fileInput.click();
  };
  App.prototype._renderDnetNode = function () {
    const ns = NS();
    const tab = this._tabForRender("dnetnode");
    if (!tab) return;
    const m = /^dnetnode:(.*):(\d+)$/.exec(this.activeTab || "");
    const fileName = m ? m[1] : ((this.dnts[0] || {}).fileName);
    const mac = m ? parseInt(m[2], 10) : 0;
    tab.el.innerHTML = "";
    const body = h("div", "dnet-host");
    tab.el.appendChild(body);
    if (typeof ns.DnetNodePanel !== "function") {
      body.appendChild(h("div", "view-note", "DeviceNet node view is not loaded."));
      return;
    }
    const panel = this._newPanel("dnetnode:" + fileName + ":" + mac, (function () {
      return new ns.DnetNodePanel({ container: body, app: this._makeHooks(), fileName: fileName, mac: mac });
    }).bind(this));
    panel.refresh();
  };

  App.prototype._renderDnet = function () {
    const ns = NS();
    const tab = this._tabForRender("dnet");
    if (!tab) return;
    tab.el.innerHTML = "";
    if (typeof ns.DnetPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "DeviceNet panel is not loaded."));
      return;
    }
    const body = h("div", "dnet-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("dnet", (function () {
      return new ns.DnetPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  App.prototype._renderModuleIo = function () {
    const ns = NS();
    const tab = this._tabForRender("moduleio");
    tab.el.innerHTML = "";
    if (typeof ns.ModuleIoPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "Module I/O panel is not loaded."));
      return;
    }
    const body = h("div", "module-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("moduleio", (function () {
      return new ns.ModuleIoPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    // deep-link: palette / I/O-list "open module" jumps straight to a module
    if (this._pendingModule) {
      panel.selected = this._pendingModule;
      panel.projectView = false;
      this._pendingModule = null;
    }
    panel.refresh();
  };

  /* ---------------- Conveyor studio ---------------- */
  App.prototype._renderConveyor = function () {
    const ns = NS();
    const tab = this._tabForRender("conveyor");
    tab.el.innerHTML = "";
    if (typeof ns.ConveyorPanel !== "function") {
      tab.el.appendChild(h("div", "view-note", "Conveyor studio module is not loaded."));
      return;
    }
    const body = h("div", "conveyor-host");
    tab.el.appendChild(body);
    const panel = this._newPanel("conveyor", (function () {
      return new ns.ConveyorPanel({ container: body, app: this._makeHooks() });
    }).bind(this));
    panel.refresh();
  };

  return { App: App };
});
