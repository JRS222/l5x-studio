/* L5X Studio - ui/conveyor-panel.js (Lead). Conveyor Design Studio: 2D drawing editor,
   3D view, component selection, BOM, L5X generation and HMI generation, wired to the
   template-driven generators and the roller/parts databases. */
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
  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "";
    return Number(n).toFixed(d === undefined ? 2 : d);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return "";
    return "$" + Number(n).toFixed(2);
  }

  function demoDesigns() {
    const M = root.L5XStudio;
    const base = M.createDefaultDesign();
    /* roller demo: straight -> 90 deg curve with standard tapered rollers -> straight ->
       up-spiral; one barcode scan zone and tray tracking enabled */
    const d1 = JSON.parse(JSON.stringify(base));
    d1.name = "DEMO_CONVEYOR";
    d1.conveyorType = "roller";
    d1.segments = [
      { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null },
      { id: "seg2", name: "SEG2", kind: "curve", turnDeg: 0, curveDeg: 90, radiusM: 1.748, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null },
      { id: "seg3", name: "SEG3", kind: "straight", turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1, motorSeries: null, driverCard: null },
      { id: "seg4", name: "SPIRAL1", kind: "spiral", turnDeg: 0, radiusM: 1.2, widthM: 0.6, zoneLengthM: 1, spiral: { pitchM: 0.8, heightM: 2.4, direction: "up" }, motorSeries: null, driverCard: null },
      { id: "spur1", name: "SPUR1", kind: "straight", x: 4.95, y: 3.2, z: 0, rotationDeg: 270, turnDeg: 0, lengthM: 2.9, widthM: 0.6, zones: 2, zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null }
    ];
    d1.merges = [{ id: "merge1", name: "MERGE1", mainSegmentId: "seg2", offsetM: 1.0, spurEndSegmentId: "spur1", priority: "alternate" }];
    d1.transfers = [
      { id: "xfer1", name: "PUSHER1", type: "pusher", segmentId: "seg3", offsetM: 1.5, side: "right", extendTimeS: 0.8 },
      { id: "xfer2", name: "ROTARY1", type: "rotary_table", segmentId: "seg3", offsetM: 2.5, stepDeg: 90, homeAngleDeg: 0 },
      { id: "xfer3", name: "POPUP1", type: "popup_transfer", segmentId: "seg1", offsetM: 3.0, directions: ["left", "right"], beltCount: 3 }
    ];
    d1.scanZones = [{ id: "scan1", name: "SCAN1", segmentId: "seg1", offsetM: 2.5, type: "barcode", side: "right", tagName: null }];
    d1.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
    /* belt demo: belted incline spiral section */
    const d2 = JSON.parse(JSON.stringify(base));
    d2.name = "BELT_CONVEYOR";
    d2.conveyorType = "belt";
    d2.segments = [
      { id: "b1", name: "BELT1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 6, widthM: 0.8, zones: 3, zoneLengthM: 2, motorSeries: null, driverCard: null },
      { id: "b2", name: "SPIRAL_UP", kind: "spiral", turnDeg: 0, radiusM: 1.4, widthM: 0.8, zoneLengthM: 2, spiral: { pitchM: 0.9, heightM: 2.7, direction: "up" }, motorSeries: null, driverCard: null },
      { id: "b3", name: "BELT2", kind: "straight", turnDeg: 30, lengthM: 4, widthM: 0.8, zones: 2, zoneLengthM: 2, motorSeries: null, driverCard: null }
    ];
    d2.scanZones = [{ id: "scan1", name: "SCAN_IN", segmentId: "b1", offsetM: 5, type: "barcode", side: "right", tagName: null }];
    d2.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
    return { DEMO_CONVEYOR: d1, BELT_CONVEYOR: d2, SINGLE_STRAIGHT: JSON.parse(JSON.stringify(base)) };
  }

  function ConveyorPanel(opts) {
    if (!(this instanceof ConveyorPanel)) return new ConveyorPanel(opts);
    this.app = opts.app;
    this.container = opts.container;
    const M = root.L5XStudio;
    this.design = (this.app.conveyorDesign) || demoDesigns().DEMO_CONVEYOR;
    this.subview = "design";
    this.selectedSegmentId = null;
    this._designer = null;
    this._view3d = null;
    this._lastGen = null;
    this._build();
  }

  ConveyorPanel.prototype._build = function () {
    const self = this;
    const M = root.L5XStudio;
    const c = this.container;
    c.innerHTML = "";
    const bar = h("div", "conv-toolbar");
    this.nameInput = h("input", "search-input conv-name", null, { type: "text", title: "Design name" });
    this.nameInput.value = this.design.name;
    this.nameInput.addEventListener("change", function () {
      self.design.name = String(self.nameInput.value || "CONVEYOR").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      self.nameInput.value = self.design.name;
      self._changed(true);
    });
    bar.appendChild(h("span", "conv-toolbar-label", "Design"));
    bar.appendChild(this.nameInput);
    const typeSel = h("select", "conv-mode");
    typeSel.title = "Conveyor type";
    for (const t of [["roller", "Roller / ZPA"], ["belt", "Belt conveyor"]]) {
      const o = h("option", null, t[1]);
      o.value = t[0];
      if ((this.design.conveyorType || "roller") === t[0]) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.addEventListener("change", function () {
      const d = root.L5XStudio.deepClone(self.design);
      d.conveyorType = typeSel.value;
      self._setDesign(d);
    });
    bar.appendChild(typeSel);
    const demoBtn = h("button", "btn", "Load demo");
    demoBtn.addEventListener("click", function () {
      const d = demoDesigns();
      self._setDesign(JSON.parse(JSON.stringify(d.DEMO_CONVEYOR)));
      self.app.status("Loaded roller demo conveyor (curve + spiral + scan zone + tracking).");
    });
    bar.appendChild(demoBtn);
    const beltDemoBtn = h("button", "btn", "Load belt demo");
    beltDemoBtn.addEventListener("click", function () {
      const d = demoDesigns();
      self._setDesign(JSON.parse(JSON.stringify(d.BELT_CONVEYOR)));
      self.app.status("Loaded belt conveyor demo (inclined spiral + scan zone + tracking).");
    });
    bar.appendChild(beltDemoBtn);
    const saveBtn = h("button", "btn", "Save design JSON");
    saveBtn.addEventListener("click", function () { self._download(self.design.name + "-design.json", JSON.stringify(self.design, null, 2), "application/json"); });
    bar.appendChild(saveBtn);
    this.loadInput = h("input", null, null, { type: "file", accept: ".json", hidden: true });
    const loadBtn = h("button", "btn", "Load design");
    loadBtn.addEventListener("click", function () { self.loadInput.click(); });
    this.loadInput.addEventListener("change", function () {
      const f = self.loadInput.files && self.loadInput.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = function () {
        try { self._setDesign(JSON.parse(String(r.result))); self.app.status("Loaded design " + f.name); }
        catch (e) { self.app.status("Invalid design JSON: " + e.message, true); }
      };
      r.readAsText(f);
      self.loadInput.value = "";
    });
    bar.appendChild(loadBtn);
    bar.appendChild(this.loadInput);
    const spacer = h("span", "conv-toolbar-spacer");
    bar.appendChild(spacer);
    this.countsEl = h("span", "conv-counts");
    bar.appendChild(this.countsEl);
    this.validationEl = h("span", "conv-validation");
    bar.appendChild(this.validationEl);
    c.appendChild(bar);

    this.subBar = h("div", "subtab-bar");
    const subs = [["design", "Design (2D)"], ["view3d", "3D view"], ["components", "Components"], ["bom", "BOM"], ["logic", "L5X logic"], ["hmi", "HMI graphics"]];
    this.subBtns = {};
    for (const [id, label] of subs) {
      const b = h("button", "subtab-btn", label);
      b.addEventListener("click", (function (v) { this.subview = v; this._renderSubview(); }).bind(this, id));
      this.subBtns[id] = b;
      this.subBar.appendChild(b);
    }
    c.appendChild(this.subBar);
    this.body = h("div", "conv-body");
    c.appendChild(this.body);
    this._recompute();
    this._renderSubview();
  };

  ConveyorPanel.prototype._recompute = function () {
    const M = root.L5XStudio;
    this.computed = M.computeDesign(this.design);
    this.validation = M.validateDesign(this.design);
    const t = this.computed.totals;
    const bits = [t.segments + " seg", t.zones + " zones", t.groups + " grp", fmt(t.conveyorLengthM, 1) + " m"];
    if (t.curvedZones) bits.push(t.curvedZones + " curved");
    if (t.spiralRiseM) bits.push("spiral " + fmt(t.spiralRiseM, 1) + " m");
    if (t.taperedRollerCount) bits.push(t.taperedRollerCount + " tapered rollers");
    if (t.beltSegments) bits.push(t.beltSegments + " belt seg");
    if (t.scanZones) bits.push(t.scanZones + " scanners");
    if (t.trackingEnabled) bits.push("tracking ON");
    if (t.merges) bits.push(t.merges + " merge" + (t.merges === 1 ? "" : "s"));
    if (t.transfers) {
      const kinds = [];
      if (t.pushers) kinds.push(t.pushers + " pusher" + (t.pushers === 1 ? "" : "s"));
      if (t.rotaryTables) kinds.push(t.rotaryTables + " rotary");
      if (t.popupTransfers) kinds.push(t.popupTransfers + " pop-up");
      bits.push(t.transfers + " transfer" + (t.transfers === 1 ? "" : "s") + " (" + kinds.join(", ") + ")");
    }
    this.countsEl.textContent = bits.join(" \u00b7 ");
    this.validationEl.innerHTML = "";
    if (this.validation.errors.length) {
      this.validationEl.appendChild(h("span", "pill err", this.validation.errors.length + " errors"));
      this.validationEl.title = this.validation.errors.join("\n");
    } else {
      this.validationEl.appendChild(h("span", "pill ok", "design valid"));
    }
    if (this.validation.warnings.length) {
      const w = h("span", "pill warn", this.validation.warnings.length + " warnings");
      w.title = this.validation.warnings.join("\n");
      this.validationEl.appendChild(w);
    }
    if (this.app) this.app.conveyorDesign = this.design;
  };

  ConveyorPanel.prototype._changed = function (fromDesigner) {
    this._recompute();
    if (this.subview === "components" || this.subview === "bom" || this.subview === "logic" || this.subview === "hmi") this._renderSubview();
    if (this.subview === "view3d" && this._view3d && this._view3d.setDesign) this._view3d.setDesign(this.design);
  };

  ConveyorPanel.prototype._setDesign = function (design) {
    const M = root.L5XStudio;
    this.design = design;
    this.nameInput.value = design.name;
    this.selectedSegmentId = null;
    this._recompute();
    if (this._designer && this._designer.setDesign) this._designer.setDesign(design);
    if (this._view3d && this._view3d.setDesign) this._view3d.setDesign(design);
    this._renderSubview();
  };

  ConveyorPanel.prototype._renderSubview = function () {
    for (const id of Object.keys(this.subBtns)) this.subBtns[id].className = "subtab-btn" + (id === this.subview ? " active" : "");
    const body = this.body;
    body.innerHTML = "";
    if (this.subview === "design") this._renderDesign();
    else if (this.subview === "view3d") this._render3d();
    else if (this.subview === "components") this._renderComponents();
    else if (this.subview === "bom") this._renderBom();
    else if (this.subview === "logic") this._renderLogic();
    else if (this.subview === "hmi") this._renderHmi();
  };

  /* ---------------- 2D design + properties ---------------- */
  ConveyorPanel.prototype._renderDesign = function () {
    const self = this;
    const ns = root.L5XStudio;
    const split = h("div", "conv-design-split");
    const canvasHost = h("div", "conv-canvas-host");
    const props = h("div", "conv-props");
    split.appendChild(canvasHost);
    split.appendChild(props);
    this.body.appendChild(split);

    if (typeof ns.ConveyorDesigner2D === "function") {
      canvasHost.innerHTML = "";
      this._designer = new ns.ConveyorDesigner2D({
        container: canvasHost,
        design: this.design,
        onChange: function (d) {
          self.design = d;
          self._changed(true);
          self._renderProps(props);
        },
        onSelect: function (sel) {
          self.selectedSegmentId = sel && sel.segmentId ? sel.segmentId : null;
          self._renderProps(props);
        }
      });
    } else {
      canvasHost.appendChild(h("div", "view-note", "2D editor module not loaded yet."));
      canvasHost.appendChild(this._fallbackPreview());
    }
    this._renderProps(props);
  };

  /* Simple pure-HTML/SVG fallback preview so the panel is useful before the 2D module lands */
  ConveyorPanel.prototype._fallbackPreview = function () {
    const c = this.computed;
    const b = c.bounds;
    const scale = Math.min(700 / Math.max(0.001, b.width), 240 / Math.max(0.001, b.height));
    const svg = document.createElementNS ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : h("div");
    if (svg.setAttribute) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "320");
      svg.setAttribute("viewBox", (b.minX * scale - 20) + " " + (b.minY * scale - 20) + " " +
        (b.width * scale + 40) + " " + (b.height * scale + 40));
    }
    for (const seg of c.segments) {
      for (const z of seg.zones) {
        if (svg.appendChild) {
          const rectEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          const w = z.lengthM * scale, hh = z.widthM * scale;
          rectEl.setAttribute("x", z.x * scale - w / 2);
          rectEl.setAttribute("y", z.y * scale - hh / 2);
          rectEl.setAttribute("width", w);
          rectEl.setAttribute("height", hh);
          rectEl.setAttribute("transform", "rotate(" + z.angleDeg + " " + (z.x * scale) + " " + (z.y * scale) + ")");
          rectEl.setAttribute("fill", "#2a3744");
          rectEl.setAttribute("stroke", "#4d9fff");
          rectEl.setAttribute("stroke-width", "1");
          svg.appendChild(rectEl);
        }
      }
    }
    return svg;
  };

  ConveyorPanel.prototype._renderProps = function (host) {
    const self = this;
    const ns = root.L5XStudio;
    host.innerHTML = "";
    const segs = this.design.segments;
    const sel = segs.find(function (s) { return s.id === self.selectedSegmentId; }) || segs[0] || null;
    this.selectedSegmentId = sel ? sel.id : null;
    host.appendChild(h("div", "panel-title", "Segments"));
    const list = h("div", "conv-seg-list");
    for (const s of segs) {
      const item = h("div", "conv-seg-item" + (s.id === this.selectedSegmentId ? " selected" : ""));
      item.appendChild(h("span", "conv-seg-name", s.name));
      item.appendChild(h("span", "conv-seg-meta", s.zones + " zones \u00b7 " + fmt(s.lengthM, 1) + " m"));
      (function (id) {
        item.addEventListener("click", function () {
          self.selectedSegmentId = id;
          if (self._designer && self._designer.setSelection) self._designer.setSelection(id);
          self._renderProps(host);
        });
      })(s.id);
      list.appendChild(item);
    }
    host.appendChild(list);
    const btnRow = h("div", "conv-seg-actions");
    const addBtn = h("button", "btn btn-sm", "+ Add segment");
    addBtn.addEventListener("click", function () {
      const M = ns;
      let x = 0;
      let y = 0;
      if (segs.length) {
        const last = self.computed.segments[segs.length - 1];
        x = last.end.x + 0.1;
        y = last.end.y;
      }
      const d = M.addSegment(self.design, {
        name: "SEG" + (segs.length + 1), x: x, y: y,
        lengthM: 2, zones: 2
      });
      self._setDesign(d);
    });
    btnRow.appendChild(addBtn);
    if (sel) {
      const delBtn = h("button", "btn btn-sm", "Delete");
      delBtn.addEventListener("click", function () {
        if (self.design.segments.length <= 1) { self.app.status("A design needs at least one segment.", true); return; }
        self._setDesign(ns.removeSegment(self.design, sel.id));
      });
      btnRow.appendChild(delBtn);
    }
    host.appendChild(btnRow);

    if (!sel) return;
    const form = h("div", "conv-form");
    function getPath(obj, key) {
      return key.split(".").reduce(function (o, k) { return o === undefined || o === null ? undefined : o[k]; }, obj);
    }
    function setPath(patch, key, value) {
      const parts = key.split(".");
      let t = patch;
      for (let i = 0; i < parts.length - 1; i++) { t[parts[i]] = t[parts[i]] || {}; t = t[parts[i]]; }
      t[parts[parts.length - 1]] = value;
    }
    function field(label, key, type, opts) {
      const row = h("div", "conv-field");
      row.appendChild(h("label", null, label));
      const cur = getPath(sel, key);
      let input;
      if (type === "select") {
        input = h("select", null);
        for (const o of opts || []) {
          const op = h("option", null, o.label !== undefined ? o.label : o);
          op.value = o.value !== undefined ? o.value : o;
          if (String(cur === undefined || cur === null ? "" : cur) === String(op.value)) op.selected = true;
          input.appendChild(op);
        }
      } else {
        input = h("input", null, null, { type: type || "text" });
        input.value = cur !== undefined && cur !== null ? cur : "";
      }
      input.addEventListener("change", function () {
        const patch = {};
        let v = input.value;
        if (type === "number") v = input.value === "" ? null : parseFloat(input.value);
        setPath(patch, key, v);
        self._setDesign(ns.updateSegment(self.design, sel.id, patch));
      });
      row.appendChild(input);
      form.appendChild(row);
    }
    field("Name", "name");
    field("Kind", "kind", "select", [
      { value: "straight", label: "Straight" },
      { value: "curve", label: "Curve (tapered rollers)" },
      { value: "spiral", label: "Spiral (inclined)" }
    ]);
    field("Conveyor type", "conveyorType", "select", [
      { value: "", label: "Design default (" + (this.design.conveyorType || "roller") + ")" },
      { value: "roller", label: "Roller / ZPA" },
      { value: "belt", label: "Belt" }
    ]);
    if (sel.kind === "curve" || sel.kind === "spiral") {
      /* standardised turning radius from the tapered-roller frustum relation */
      const width = Number(sel.widthM || (this.design.defaults && this.design.defaults.widthM) || 0.6);
      const standards = ns.standardCurveRadii(width);
      const radiusRow = h("div", "conv-field");
      radiusRow.appendChild(h("label", null, "Radius (m)"));
      const radInput = h("input", null, null, { type: "number", step: "0.01", min: "0.2" });
      radInput.value = sel.radiusM !== undefined && sel.radiusM !== null ? sel.radiusM : "";
      radInput.addEventListener("change", function () {
        self._setDesign(ns.updateSegment(self.design, sel.id, { radiusM: parseFloat(radInput.value) }));
      });
      radiusRow.appendChild(radInput);
      form.appendChild(radiusRow);
      const stdRow = h("div", "conv-field");
      stdRow.appendChild(h("label", null, "Standard taper"));
      const stdSel = h("select", null);
      const opt0 = h("option", null, "custom radius (not standardised)");
      opt0.value = "";
      stdSel.appendChild(opt0);
      for (const st of standards) {
        const o = h("option", null, st.id + " \u2014 R" + st.radiusM + " m (\u0394" + Math.round(st.deltaM * 1000) + " mm, " + (st.series || "") + ")");
        o.value = String(st.radiusM);
        if (sel.radiusM && Math.abs(Number(sel.radiusM) - st.radiusM) < 0.004) o.selected = true;
        stdSel.appendChild(o);
      }
      stdSel.addEventListener("change", function () {
        if (!stdSel.value) return;
        self._setDesign(ns.updateSegment(self.design, sel.id, { radiusM: parseFloat(stdSel.value) }));
      });
      stdRow.appendChild(stdSel);
      form.appendChild(stdRow);
      const segC = this.computed.segments.find(function (s) { return s.id === sel.id; });
      if (segC && segC.taper) {
        const t = segC.taper;
        const note = h("div", t.withinTolerance === false ? "conv-note warn" : "conv-note");
        if (t.standardId) {
          note.textContent = "Standard " + t.standardId + ": \u0394 " + (t.deltaM * 1000).toFixed(1) +
            " mm, cone half-angle " + t.coneHalfAngleDeg + "\u00b0" +
            (t.withinTolerance ? " \u2014 matches the requested radius." :
              " \u2014 requested radius deviates " + t.deviationPct + "% from the standard radius " + t.standardRadiusM + " m.");
        } else note.textContent = "No standard tapered roller available for this width.";
        form.appendChild(note);
      }
    }
    if (sel.kind === "curve") field("Curve angle (deg)", "curveDeg", "number");
    field("Width (m)", "widthM", "number");
    field("Zone length (m)", "zoneLengthM", "number");
    if (sel.kind !== "spiral") field("Zones", "zones", "number");
    else {
      const segC2 = this.computed.segments.find(function (s) { return s.id === sel.id; });
      form.appendChild(h("div", "conv-note", "Spiral zones are derived from the helix length (" +
        (segC2 ? segC2.zones.length : "?") + " zones at " + (sel.zoneLengthM || 1) + " m)."));
    }
    field("Rotation (deg)", "rotationDeg", "number");
    if (this.design.segments.findIndex(function (s) { return s.id === sel.id; }) > 0) {
      field("Joint turn (deg)", "turnDeg", "number");
      form.appendChild(h("div", "conv-note", "Angled joints get a rounded edge automatically (fillet radius = half the conveyor width), so product flows through the corner."));
    }
    if (sel.kind === "spiral") {
      field("Spiral pitch (m/turn)", "spiral.pitchM", "number");
      field("Spiral height (m)", "spiral.heightM", "number");
      field("Spiral direction", "spiral.direction", "select", [{ value: "up", label: "Up" }, { value: "down", label: "Down" }]);
      const segC3 = this.computed.segments.find(function (s) { return s.id === sel.id; });
      if (segC3 && segC3.spiral) {
        form.appendChild(h("div", "conv-note", "Helix: " + segC3.spiral.turns + " turns, slope " + segC3.spiral.slopeDeg +
          "\u00b0, rise " + segC3.spiral.heightM + " m (" + segC3.spiral.direction + ")."));
      }
    }
    host.appendChild(form);
    this._renderScanProps(host, sel);
    this._renderTrackingProps(host);
    this._renderMergeProps(host);
    this._renderTransferProps(host);
    if (this.computed.totals.zones > 0) {
      const note = h("div", "conv-note",
        "Segment zones map to NETS[1].ZPA groups; I/O blocks " + this._blockRangeFor(sel.id) + ".");
      host.appendChild(note);
    }
  };

  /* scan zones editor (barcode / camera readers) */
  ConveyorPanel.prototype._renderScanProps = function (host, sel) {
    const self = this;
    const ns = root.L5XStudio;
    const box = h("div", "conv-props-section");
    box.appendChild(h("div", "panel-title", "Scan zones (" + (this.design.scanZones || []).length + ")"));
    const list = h("div", "conv-scan-list");
    for (const sz of (this.design.scanZones || [])) {
      const item = h("div", "conv-scan-item");
      const head = h("div", "conv-scan-head");
      head.appendChild(h("span", "conv-scan-name", sz.name || sz.id));
      const del = h("button", "btn btn-sm", "\u00d7");
      del.title = "Remove scan zone";
      (function (id) {
        del.addEventListener("click", function () { self._setDesign(ns.removeScanZone(self.design, id)); });
      })(sz.id);
      head.appendChild(del);
      item.appendChild(head);
      const segmentOptions = this.design.segments.map(function (s) { return { value: s.id, label: s.name }; });
      const row = h("div", "conv-field");
      row.appendChild(h("label", null, "Segment"));
      const segSel = h("select", null);
      for (const o of segmentOptions) {
        const op = h("option", null, o.label);
        op.value = o.value;
        if (o.value === sz.segmentId) op.selected = true;
        segSel.appendChild(op);
      }
      segSel.addEventListener("change", function () {
        self._setDesign(ns.updateScanZone(self.design, sz.id, { segmentId: segSel.value }));
      });
      row.appendChild(segSel);
      item.appendChild(row);
      const row2 = h("div", "conv-field");
      row2.appendChild(h("label", null, "Offset (m)"));
      const off = h("input", null, null, { type: "number", step: "0.1", min: "0" });
      off.value = sz.offsetM;
      off.addEventListener("change", function () {
        self._setDesign(ns.updateScanZone(self.design, sz.id, { offsetM: parseFloat(off.value) }));
      });
      row2.appendChild(off);
      item.appendChild(row2);
      const row3 = h("div", "conv-field");
      row3.appendChild(h("label", null, "Reader"));
      const typeSel = h("select", null);
      for (const t of [["barcode", "Barcode scanner"], ["camera", "Camera / vision"]]) {
        const op = h("option", null, t[1]);
        op.value = t[0];
        if ((sz.type || "barcode") === t[0]) op.selected = true;
        typeSel.appendChild(op);
      }
      typeSel.addEventListener("change", function () {
        self._setDesign(ns.updateScanZone(self.design, sz.id, { type: typeSel.value }));
      });
      row3.appendChild(typeSel);
      item.appendChild(row3);
      list.appendChild(item);
    }
    box.appendChild(list);
    const add = h("button", "btn btn-sm", "+ Add scan zone");
    add.addEventListener("click", function () {
      const seg = sel || self.design.segments[0];
      const segC = self.computed.segments.find(function (s) { return s.id === (seg && seg.id); }) || self.computed.segments[0];
      const off = segC ? Math.min(Math.max(0.5, segC.lengthM * 0.5), Math.max(0, segC.lengthM - 0.1)) : 1;
      self._setDesign(ns.addScanZone(self.design, { segmentId: segC ? segC.id : undefined, offsetM: round2(off) }));
    });
    box.appendChild(add);
    host.appendChild(box);
  };

  function round2(n) { return Math.round(n * 100) / 100; }

  /* tray tracking settings */
  ConveyorPanel.prototype._renderTrackingProps = function (host) {
    const self = this;
    const ns = root.L5XStudio;
    const tr = this.design.tracking || (this.design.tracking = { enabled: false, maxTrays: 16, barcodeLen: 20 });
    const box = h("div", "conv-props-section");
    box.appendChild(h("div", "panel-title", "Tray tracking"));
    const row = h("div", "conv-field");
    row.appendChild(h("label", null, "Enabled"));
    const chk = h("input", null, null, { type: "checkbox" });
    chk.checked = !!tr.enabled;
    chk.addEventListener("change", function () {
      const d = ns.deepClone(self.design);
      d.tracking = Object.assign({}, d.tracking || {}, { enabled: chk.checked });
      self._setDesign(d);
    });
    row.appendChild(chk);
    box.appendChild(row);
    const numField = function (label, key, value, step) {
      const r = h("div", "conv-field");
      r.appendChild(h("label", null, label));
      const inp = h("input", null, null, { type: "number", step: step || "1", min: "1" });
      inp.value = value;
      inp.addEventListener("change", function () {
        const d = ns.deepClone(self.design);
        d.tracking = Object.assign({}, d.tracking || {}, { [key]: parseFloat(inp.value) });
        self._setDesign(d);
      });
      r.appendChild(inp);
      box.appendChild(r);
    };
    numField("Max trays", "maxTrays", tr.maxTrays || 16);
    numField("Barcode length", "barcodeLen", tr.barcodeLen || 20);
    numField("Tray length (m)", "trayLengthM", tr.trayLengthM || 0.6, "0.1");
    host.appendChild(box);
  };

  ConveyorPanel.prototype._zoneBaseFor = function (segmentId) {
    let base = 0;
    for (const s of this.computed.segments) {
      if (s.id === segmentId) return base;
      base += s.zones.length;
    }
    return base;
  };
  ConveyorPanel.prototype._blockRangeFor = function (segmentId) {
    const zones = this.computed.segments.find(s => s.id === segmentId);
    if (!zones || !zones.zones.length) return "-";
    return zones.zones[0].blockName + ".." + zones.zones[zones.zones.length - 1].blockName;
  };

  /* merge junctions (spur line feeding a main-line zone, alternating release) */
  ConveyorPanel.prototype._renderMergeProps = function (host) {
    const self = this;
    const ns = root.L5XStudio;
    const list = this.design.merges || [];
    const box = h("div", "conv-props-section");
    box.appendChild(h("div", "panel-title", "Merge junctions (" + list.length + ")"));
    const segOptions = this.design.segments.map(function (s) { return { value: s.id, label: s.name }; });
    for (const mg of list) {
      const item = h("div", "conv-scan-item");
      const head = h("div", "conv-scan-head");
      head.appendChild(h("span", "conv-scan-name", mg.name || mg.id));
      const del = h("button", "btn btn-sm", "\u00d7");
      del.title = "Remove merge";
      (function (id) { del.addEventListener("click", function () { self._setDesign(ns.removeMerge(self.design, id)); }); })(mg.id);
      head.appendChild(del);
      item.appendChild(head);
      const nameRow = h("div", "conv-field");
      nameRow.appendChild(h("label", null, "Name"));
      const nameInp = h("input", null, null, { type: "text" });
      nameInp.value = mg.name || "";
      nameInp.addEventListener("change", function () {
        self._setDesign(ns.updateMerge(self.design, mg.id, { name: nameInp.value }));
      });
      nameRow.appendChild(nameInp);
      item.appendChild(nameRow);
      const mainRow = h("div", "conv-field");
      mainRow.appendChild(h("label", null, "Main segment"));
      const mainSel = h("select", null);
      for (const o of segOptions) {
        const op = h("option", null, o.label); op.value = o.value;
        if (o.value === mg.mainSegmentId) op.selected = true;
        mainSel.appendChild(op);
      }
      mainSel.addEventListener("change", function () { self._setDesign(ns.updateMerge(self.design, mg.id, { mainSegmentId: mainSel.value })); });
      mainRow.appendChild(mainSel);
      item.appendChild(mainRow);
      const offRow = h("div", "conv-field");
      offRow.appendChild(h("label", null, "Merge at (m)"));
      const off = h("input", null, null, { type: "number", step: "0.1", min: "0" });
      off.value = mg.offsetM;
      off.addEventListener("change", function () { self._setDesign(ns.updateMerge(self.design, mg.id, { offsetM: parseFloat(off.value) })); });
      offRow.appendChild(off);
      item.appendChild(offRow);
      const spurRow = h("div", "conv-field");
      spurRow.appendChild(h("label", null, "Spur end seg."));
      const spurSel = h("select", null);
      for (const o of segOptions) {
        const op = h("option", null, o.label); op.value = o.value;
        if (o.value === mg.spurEndSegmentId) op.selected = true;
        spurSel.appendChild(op);
      }
      spurSel.addEventListener("change", function () { self._setDesign(ns.updateMerge(self.design, mg.id, { spurEndSegmentId: spurSel.value })); });
      spurRow.appendChild(spurSel);
      item.appendChild(spurRow);
      const prioRow = h("div", "conv-field");
      prioRow.appendChild(h("label", null, "Release priority"));
      const prioSel = h("select", null);
      for (const [v, l] of [["alternate", "Alternating"], ["main", "Main line first"], ["spur", "Spur first"]]) {
        const op = h("option", null, l); op.value = v;
        if ((mg.priority || "alternate") === v) op.selected = true;
        prioSel.appendChild(op);
      }
      prioSel.addEventListener("change", function () { self._setDesign(ns.updateMerge(self.design, mg.id, { priority: prioSel.value })); });
      prioRow.appendChild(prioSel);
      item.appendChild(prioRow);
      const cm = this.computed.merges.find(function (m) { return m.id === mg.id; });
      if (cm) {
        const note = h("div", "conv-note", "Merge zone Z" + (cm.mergeZoneIndex1Based || "?") +
          " \u00b7 spur zone Z" + (cm.spurZoneIndex1Based || "?") +
          (cm.gapM !== null ? " \u00b7 throat gap " + cm.gapM + " m" : ""));
        if (cm.gapM !== null && cm.gapM > 1.0) note.className = "conv-note warn";
        item.appendChild(note);
      }
      box.appendChild(item);
    }
    const add = h("button", "btn btn-sm", "+ Add merge junction");
    add.addEventListener("click", function () {
      const segs = self.design.segments;
      self._setDesign(ns.addMerge(self.design, {
        mainSegmentId: segs[0] && segs[0].id,
        spurEndSegmentId: segs.length > 1 ? segs[segs.length - 1].id : (segs[0] && segs[0].id)
      }));
    });
    box.appendChild(add);
    host.appendChild(box);
  };

  /* transfer devices: pusher / rotary table / cross-belt pop-up */
  ConveyorPanel.prototype._renderTransferProps = function (host) {
    const self = this;
    const ns = root.L5XStudio;
    const list = this.design.transfers || [];
    const box = h("div", "conv-props-section");
    box.appendChild(h("div", "panel-title", "Transfer devices (" + list.length + ")"));
    const segOptions = this.design.segments.map(function (s) { return { value: s.id, label: s.name }; });
    const TYPE_LABEL = { pusher: "Pusher / divert", rotary_table: "Rotary table", popup_transfer: "Cross-belt pop-up" };
    for (const tf of list) {
      const type = tf.type || "pusher";
      const item = h("div", "conv-scan-item");
      const head = h("div", "conv-scan-head");
      head.appendChild(h("span", "conv-scan-name", (tf.name || tf.id) + " \u00b7 " + TYPE_LABEL[type]));
      const del = h("button", "btn btn-sm", "\u00d7");
      del.title = "Remove transfer";
      (function (id) { del.addEventListener("click", function () { self._setDesign(ns.removeTransfer(self.design, id)); }); })(tf.id);
      head.appendChild(del);
      item.appendChild(head);
      const nameRow = h("div", "conv-field");
      nameRow.appendChild(h("label", null, "Name"));
      const nameInp = h("input", null, null, { type: "text" });
      nameInp.value = tf.name || "";
      nameInp.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { name: nameInp.value })); });
      nameRow.appendChild(nameInp);
      item.appendChild(nameRow);
      const typeRow = h("div", "conv-field");
      typeRow.appendChild(h("label", null, "Type"));
      const typeSel = h("select", null);
      for (const v of ["pusher", "rotary_table", "popup_transfer"]) {
        const op = h("option", null, TYPE_LABEL[v]); op.value = v;
        if (type === v) op.selected = true;
        typeSel.appendChild(op);
      }
      typeSel.addEventListener("change", function () {
        const patch = { type: typeSel.value };
        if (typeSel.value === "popup_transfer") { patch.directions = ["left", "right"]; patch.beltCount = 3; }
        if (typeSel.value === "rotary_table") { patch.stepDeg = 90; patch.homeAngleDeg = 0; }
        if (typeSel.value === "pusher") { patch.side = "right"; patch.extendTimeS = 0.8; }
        self._setDesign(ns.updateTransfer(self.design, tf.id, patch));
      });
      typeRow.appendChild(typeSel);
      item.appendChild(typeRow);
      const segRow = h("div", "conv-field");
      segRow.appendChild(h("label", null, "Segment"));
      const segSel = h("select", null);
      for (const o of segOptions) {
        const op = h("option", null, o.label); op.value = o.value;
        if (o.value === tf.segmentId) op.selected = true;
        segSel.appendChild(op);
      }
      segSel.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { segmentId: segSel.value })); });
      segRow.appendChild(segSel);
      item.appendChild(segRow);
      const offRow = h("div", "conv-field");
      offRow.appendChild(h("label", null, "At (m)"));
      const off = h("input", null, null, { type: "number", step: "0.1", min: "0" });
      off.value = tf.offsetM;
      off.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { offsetM: parseFloat(off.value) })); });
      offRow.appendChild(off);
      item.appendChild(offRow);
      if (type === "pusher") {
        const sideRow = h("div", "conv-field");
        sideRow.appendChild(h("label", null, "Divert side"));
        const sideSel = h("select", null);
        for (const v of ["left", "right"]) {
          const op = h("option", null, v === "left" ? "Left" : "Right"); op.value = v;
          if ((tf.side || "right") === v) op.selected = true;
          sideSel.appendChild(op);
        }
        sideSel.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { side: sideSel.value })); });
        sideRow.appendChild(sideSel);
        item.appendChild(sideRow);
      } else if (type === "rotary_table") {
        const stepRow = h("div", "conv-field");
        stepRow.appendChild(h("label", null, "Step (deg)"));
        const stepInp = h("input", null, null, { type: "number", step: "15", min: "15", max: "180" });
        stepInp.value = tf.stepDeg !== undefined ? tf.stepDeg : 90;
        stepInp.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { stepDeg: parseFloat(stepInp.value) })); });
        stepRow.appendChild(stepInp);
        item.appendChild(stepRow);
        item.appendChild(h("div", "conv-note", "Rotary tables are bidirectional: generated logic drives CW/CCW rotation with home and 90/180/270 position interlocks."));
      } else {
        const dirRow = h("div", "conv-field");
        dirRow.appendChild(h("label", null, "Directions"));
        const left = h("input", null, null, { type: "checkbox" });
        const right = h("input", null, null, { type: "checkbox" });
        const dirs = tf.directions && tf.directions.length ? tf.directions : ["left", "right"];
        left.checked = dirs.indexOf("left") !== -1;
        right.checked = dirs.indexOf("right") !== -1;
        function setDirs() {
          const out = [];
          if (left.checked) out.push("left");
          if (right.checked) out.push("right");
          self._setDesign(ns.updateTransfer(self.design, tf.id, { directions: out }));
        }
        left.addEventListener("change", setDirs);
        right.addEventListener("change", setDirs);
        dirRow.appendChild(left);
        dirRow.appendChild(h("span", "conv-note-inline", "left"));
        dirRow.appendChild(right);
        dirRow.appendChild(h("span", "conv-note-inline", "right"));
        item.appendChild(dirRow);
        const beltRow = h("div", "conv-field");
        beltRow.appendChild(h("label", null, "Cross belts"));
        const belts = h("input", null, null, { type: "number", step: "1", min: "1", max: "6" });
        belts.value = tf.beltCount !== undefined ? tf.beltCount : 3;
        belts.addEventListener("change", function () { self._setDesign(ns.updateTransfer(self.design, tf.id, { beltCount: parseFloat(belts.value) })); });
        beltRow.appendChild(belts);
        item.appendChild(beltRow);
        item.appendChild(h("div", "conv-note", "Bidirectional cross-belt pop-up transfer: LEFT and RIGHT belt outputs with side-clear interlocks."));
      }
      const ct = this.computed.transfers.find(function (t) { return t.id === tf.id; });
      if (ct) item.appendChild(h("div", "conv-note", "I/O block " + ct.ioBlock + " \u00b7 zone Z" + (ct.zoneIndex1Based || "?") + " \u00b7 " + ct.ip));
      box.appendChild(item);
    }
    const btnRow = h("div", "conv-seg-actions");
    for (const [type, label] of [["pusher", "+ Pusher"], ["rotary_table", "+ Rotary table"], ["popup_transfer", "+ Pop-up transfer"]]) {
      const b = h("button", "btn btn-sm", label);
      (function (t) {
        b.addEventListener("click", function () {
          const segs = self.design.segments;
          self._setDesign(ns.addTransfer(self.design, { type: t, segmentId: segs[0] && segs[0].id }));
        });
      })(type);
      btnRow.appendChild(b);
    }
    box.appendChild(btnRow);
    host.appendChild(box);
  };

  /* ---------------- 3D view ---------------- */
  ConveyorPanel.prototype._render3d = function () {
    const ns = root.L5XStudio;
    const host = h("div", "conv-3d-host");
    this.body.appendChild(host);
    if (typeof ns.Conveyor3D === "function") {
      this._view3d = new ns.Conveyor3D({ container: host, design: this.design });
    } else {
      host.appendChild(h("div", "view-note", "3D renderer module not loaded yet."));
      host.appendChild(this._fallbackPreview());
    }
  };

  /* ---------------- components ---------------- */
  ConveyorPanel.prototype._getSelections = function () {
    const ns = root.L5XStudio;
    if (typeof ns.selectComponents !== "function") return null;
    try { return ns.selectComponents(this.design, this.computed, {}); }
    catch (e) { return { error: e.message }; }
  };

  ConveyorPanel.prototype._renderComponents = function () {
    const self = this;
    const ns = root.L5XStudio;
    if (typeof ns.selectComponents !== "function") {
      this.body.appendChild(h("div", "view-note", "Parts engine module not loaded yet."));
      return;
    }
    const sel = this._getSelections();
    if (sel.error) { this.body.appendChild(h("div", "view-note", "Component selection failed: " + sel.error)); return; }
    const wrap = h("div", "conv-table-host");
    wrap.appendChild(h("div", "panel-title", "Component selection (" + sel.zones.length + " zones)"));
    const table = h("table", "data-table");
    const thr = h("tr");
    ["Zone", "Block", "Motorized roller", "Driver card", "Sensor", "Notes"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    table.appendChild(thr);
    for (const z of sel.zones) {
      const tr = h("tr");
      tr.appendChild(h("td", "mono", z.zoneName || z.zoneIndex));
      tr.appendChild(h("td", "mono", z.blockName));
      tr.appendChild(h("td", "mono", (z.rollerPn || "") + (z.rollerDesc ? " \u00b7 " + z.rollerDesc : "")));
      tr.appendChild(h("td", "mono", z.driverCard || ""));
      tr.appendChild(h("td", "mono", z.sensorPn || z.sensorDesc || ""));
      tr.appendChild(h("td", "conv-warn-cell", (z.warnings || []).join("; ")));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    if (sel.warnings && sel.warnings.length) {
      wrap.appendChild(h("div", "conv-note warn", sel.warnings.length + " warning(s): " + sel.warnings.slice(0, 5).join(" | ")));
    }
    this.body.appendChild(wrap);
  };

  /* ---------------- BOM ---------------- */
  ConveyorPanel.prototype._renderBom = function () {
    const ns = root.L5XStudio;
    if (typeof ns.buildBom !== "function") { this.body.appendChild(h("div", "view-note", "BOM module not loaded yet.")); return; }
    const sel = this._getSelections();
    if (!sel || sel.error) { this.body.appendChild(h("div", "view-note", "Component selection failed.")); return; }
    let bom;
    try { bom = ns.buildBom(this.design, this.computed, sel, {}); }
    catch (e) { this.body.appendChild(h("div", "view-note", "BOM build failed: " + e.message)); return; }
    this._lastBom = bom;
    const wrap = h("div", "conv-table-host");
    const bar = h("div", "conv-export-row");
    const csvBtn = h("button", "btn btn-sm", "Export CSV");
    csvBtn.addEventListener("click", function () { self._download(self.design.name + "-BOM.csv", ns.bomToCsv(bom.rows), "text/csv"); });
    bar.appendChild(csvBtn);
    const self = this;
    const mdBtn = h("button", "btn btn-sm", "Export Markdown");
    mdBtn.addEventListener("click", function () { self._download(self.design.name + "-BOM.md", ns.bomToMarkdown(bom.rows, bom.totals), "text/markdown"); });
    bar.appendChild(mdBtn);
    const total = bom.totals && bom.totals.grandTotal;
    bar.appendChild(h("span", "conv-total", "Total: " + fmtMoney(total)));
    wrap.appendChild(bar);
    const table = h("table", "data-table");
    const thr = h("tr");
    ["Category", "P/N", "Description", "Qty", "Unit", "Extended", "Source"].forEach(function (t) { thr.appendChild(h("th", null, t)); });
    table.appendChild(thr);
    for (const r of bom.rows) {
      const tr = h("tr");
      tr.appendChild(h("td", null, r.category));
      tr.appendChild(h("td", "mono", r.pn || ""));
      tr.appendChild(h("td", null, r.description || ""));
      tr.appendChild(h("td", null, String(r.qty)));
      tr.appendChild(h("td", null, fmtMoney(r.unitCost)));
      tr.appendChild(h("td", null, fmtMoney(r.extended)));
      tr.appendChild(h("td", null, r.source || ""));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    if (bom.totals && bom.totals.byCategory) {
      const tc = h("div", "conv-totals");
      for (const k of Object.keys(bom.totals.byCategory)) {
        tc.appendChild(h("span", "conv-total-item", k + ": " + fmtMoney(bom.totals.byCategory[k])));
      }
      wrap.appendChild(tc);
    }
    this.body.appendChild(wrap);
  };

  /* ---------------- L5X logic ---------------- */
  ConveyorPanel.prototype._renderLogic = function () {
    const self = this;
    const ns = root.L5XStudio;
    if (typeof ns.generateConveyorL5x !== "function") {
      this.body.appendChild(h("div", "view-note", "L5X generator module not loaded yet."));
      return;
    }
    const wrap = h("div", "conv-logic");
    const bar = h("div", "conv-export-row");
    const modeSel = h("select", "conv-mode");
    for (const [v, l] of [["program", "Program export (import into existing project)"], ["controller", "Controller export (standalone new project)"]]) {
      const o = h("option", null, l);
      o.value = v;
      modeSel.appendChild(o);
    }
    bar.appendChild(modeSel);
    const gen = h("button", "btn btn-primary", "Generate L5X");
    bar.appendChild(gen);
    wrap.appendChild(bar);
    const out = h("div", "conv-logic-out");
    wrap.appendChild(out);
    this.body.appendChild(wrap);
    gen.addEventListener("click", function () {
      out.innerHTML = "";
      const t0 = Date.now();
      let res;
      try { res = ns.generateConveyorL5x(self.design, self.computed, { mode: modeSel.value }); }
      catch (e) {
        out.appendChild(h("div", "view-note err", "Generation failed: " + e.message));
        return;
      }
      self._lastGen = res;
      const ms = Date.now() - t0;
      const stats = res.stats || {};
      out.appendChild(h("div", "conv-gen-stats",
        "Generated in " + ms + " ms \u00b7 " + (stats.routines || 0) + " routines \u00b7 " +
        (stats.zones || 0) + " zones \u00b7 " + (stats.tags || 0) + " tags \u00b7 " +
        (stats.modules || 0) + " modules \u00b7 " + fmt((res.l5x || "").length / 1024, 0) + " KB" +
        " \u00b7 " + (res.warnings || []).length + " warning(s)"));
      // schema validation of the generated text
      if (typeof ns.parseL5X === "function" && typeof ns.validateModel === "function") {
        try {
          const gm = ns.parseL5X(res.l5x);
          const vr = ns.validateModel(gm, {});
          const errs = (vr.errors || []).length, warns = (vr.warnings || []).length;
          out.appendChild(h("div", errs ? "view-note err" : "view-note ok",
            "Schema validation: " + errs + " error(s), " + warns + " warning(s)"));
          if (errs) {
            const ul = h("ul", "conv-err-list");
            for (const e of (vr.errors || []).slice(0, 10)) ul.appendChild(h("li", null, (e.path || "") + ": " + e.message));
            out.appendChild(ul);
          }
        } catch (e) {
          out.appendChild(h("div", "view-note warn", "Generated L5X could not be re-parsed: " + e.message));
        }
      }
      const btns = h("div", "conv-export-row");
      const dl = h("button", "btn", "Download .L5X");
      dl.addEventListener("click", function () {
        self._download(self.design.name + (modeSel.value === "controller" ? "-controller" : "") + ".L5X", res.l5x, "application/xml");
      });
      btns.appendChild(dl);
      const openBtn = h("button", "btn", "Open in L5X Studio");
      openBtn.addEventListener("click", function () {
        if (self.app && self.app.loadText) {
          self.app.loadText(self.design.name + ".L5X", res.l5x);
          self.app.status("Opened generated conveyor L5X in the project views.");
        }
      });
      btns.appendChild(openBtn);
      out.appendChild(btns);
      if ((res.warnings || []).length) {
        const ul = h("ul", "conv-warn-list");
        for (const w of res.warnings.slice(0, 20)) ul.appendChild(h("li", null, w));
        out.appendChild(ul);
      }
      const pre = h("pre", "conv-preview", (res.l5x || "").slice(0, 20000) + ((res.l5x || "").length > 20000 ? "\n\n\u2026 (" + Math.round((res.l5x || "").length / 1024) + " KB total, download for full file)" : ""));
      out.appendChild(pre);
      self.app.status("Generated " + modeSel.value + " L5X (" + ((res.l5x || "").length / 1024).toFixed(0) + " KB)");
    });
  };

  /* ---------------- HMI ---------------- */
  ConveyorPanel.prototype._renderHmi = function () {
    const self = this;
    const ns = root.L5XStudio;
    if (typeof ns.generateHmiHtml !== "function") {
      this.body.appendChild(h("div", "view-note", "HMI generator module not loaded yet."));
      return;
    }
    let html = "";
    try { html = ns.generateHmiHtml(this.design, this.computed, {}); }
    catch (e) { this.body.appendChild(h("div", "view-note err", "HMI generation failed: " + e.message)); return; }
    const wrap = h("div", "conv-hmi");
    const bar = h("div", "conv-export-row");
    const dl = h("button", "btn", "Download HMI .html");
    dl.addEventListener("click", function () { self._download(self.design.name + "-HMI.html", html, "text/html"); });
    bar.appendChild(dl);
    if (typeof ns.generateTagListCsv === "function") {
      const t = h("button", "btn", "Download tag list CSV");
      t.addEventListener("click", function () { self._download(self.design.name + "-tags.csv", ns.generateTagListCsv(self.design, self.computed), "text/csv"); });
      bar.appendChild(t);
    }
    if (typeof ns.generateGraphicsSpec === "function") {
      const g = h("button", "btn", "Download graphics spec");
      g.addEventListener("click", function () { self._download(self.design.name + "-graphics-spec.md", ns.generateGraphicsSpec(self.design, self.computed), "text/markdown"); });
      bar.appendChild(g);
    }
    bar.appendChild(h("span", "conv-note-inline", fmt(html.length / 1024, 0) + " KB self-contained HTML5 HMI"));
    wrap.appendChild(bar);
    const frameWrap = h("div", "conv-hmi-frame");
    const frame = h("iframe", "conv-hmi-iframe", null, { sandbox: "allow-scripts" });
    try { frame.srcdoc = html; } catch (e) { /* older browsers: skip preview */ }
    frameWrap.appendChild(frame);
    wrap.appendChild(frameWrap);
    this.body.appendChild(wrap);
  };

  /* ---------------- helpers ---------------- */
  ConveyorPanel.prototype._download = function (name, text, mime) {
    try {
      const blob = new Blob([text], { type: mime || "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) { if (this.app) this.app.status("Download failed: " + e.message, true); }
  };

  ConveyorPanel.prototype.refresh = function () { this._recompute(); this._renderSubview(); };

  return { ConveyorPanel: ConveyorPanel, conveyorDemoDesigns: demoDesigns };
});
