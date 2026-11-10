/* L5X Studio - render/fbd.js (T2). Visual function block editor (SVG) + pure placement/pin
   helpers. See CONTRACT section 8.
   Pin conventions (match fbd-convert.js):
     AND/OR/XOR: In1, In2 -> Out ; NOT: In -> Out
     MOV/COP/FLL/NEG/ABS/SQR/SQRT: In (+Length) -> Out
     ADD/SUB/MUL/DIV/MOD: In1, In2 -> Out
     TON/TOF/RTO/TONR: EnableIn, PRE, Reset -> DN, TT, ACC
     CTU: CUEnable, PRE, Reset -> DN, ACC ; CTD: CDEnable, PRE, Reset -> DN, ACC
     IREF: single Out pin (FromParam omitted in XML); OREF: single In pin (ToParam omitted).
   Pure helpers are DOM-free; the editor degrades gracefully in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const svg = typeof module !== "undefined" && module.exports ? require("./svg.js") : root.L5XStudio;
  const utilDep = typeof module !== "undefined" && module.exports ? require("../util.js") : root.L5XStudio;
  const util = (utilDep && utilDep.util) || utilDep;

  const BLOCK_W = 130;
  const PIN_Y0 = 26;
  const PIN_DY = 18;

  const PIN_TABLE = {
    AND: { in: ["In1", "In2"], out: ["Out"] },
    OR: { in: ["In1", "In2"], out: ["Out"] },
    XOR: { in: ["In1", "In2"], out: ["Out"] },
    NOT: { in: ["In"], out: ["Out"] },
    MOV: { in: ["In"], out: ["Out"] },
    COP: { in: ["In", "Length"], out: ["Out"] },
    CPS: { in: ["In", "Length"], out: ["Out"] },
    FLL: { in: ["In", "Length"], out: ["Out"] },
    ADD: { in: ["In1", "In2"], out: ["Out"] },
    SUB: { in: ["In1", "In2"], out: ["Out"] },
    MUL: { in: ["In1", "In2"], out: ["Out"] },
    DIV: { in: ["In1", "In2"], out: ["Out"] },
    MOD: { in: ["In1", "In2"], out: ["Out"] },
    NEG: { in: ["In"], out: ["Out"] },
    ABS: { in: ["In"], out: ["Out"] },
    SQR: { in: ["In"], out: ["Out"] },
    SQRT: { in: ["In"], out: ["Out"] },
    EQU: { in: ["In1", "In2"], out: ["Out"] },
    NEQ: { in: ["In1", "In2"], out: ["Out"] },
    GRT: { in: ["In1", "In2"], out: ["Out"] },
    GEQ: { in: ["In1", "In2"], out: ["Out"] },
    LES: { in: ["In1", "In2"], out: ["Out"] },
    LEQ: { in: ["In1", "In2"], out: ["Out"] },
    LIM: { in: ["In1", "In2", "In3"], out: ["Out"] },
    MEQ: { in: ["In1", "In2", "In3"], out: ["Out"] },
    TON: { in: ["EnableIn", "PRE", "Reset"], out: ["DN", "TT", "ACC"] },
    TOF: { in: ["EnableIn", "PRE", "Reset"], out: ["DN", "TT", "ACC"] },
    RTO: { in: ["EnableIn", "PRE", "Reset"], out: ["DN", "ACC"] },
    TONR: { in: ["EnableIn", "PRE", "Reset"], out: ["DN", "ACC"] },
    TOFR: { in: ["EnableIn", "PRE", "Reset"], out: ["DN", "ACC"] },
    CTU: { in: ["CUEnable", "PRE", "Reset"], out: ["DN", "ACC"] },
    CTD: { in: ["CDEnable", "PRE", "Reset"], out: ["DN", "ACC"] },
    RES: { in: [], out: [] },
    JSR: { in: [], out: [] },
    SBR: { in: [], out: [] },
    RET: { in: [], out: [] }
  };

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElementNS === "function";
  }
  function clone(x) {
    if (util && util.deepClone) return util.deepClone(x);
    return JSON.parse(JSON.stringify(x));
  }

  /* Pure: pin list + block dimensions for a drawing element.
     Returns { w, h, pins: [{ name, side: "in"|"out", x, y }] }. */
  function fbdPins(block) {
    const w = BLOCK_W;
    if (block.kind === "iref") {
      return { w: w, h: 46, pins: [{ name: "Out", side: "out", x: w, y: PIN_Y0 }] };
    }
    if (block.kind === "oref") {
      return { w: w, h: 46, pins: [{ name: "In", side: "in", x: 0, y: PIN_Y0 }] };
    }
    if (block.kind === "jsr" || block.kind === "sbr" || block.kind === "ret") {
      return { w: w, h: 46, pins: [] };
    }
    if (block.kind === "icon" || block.kind === "ocon") {
      return { w: 70, h: 40, pins: block.kind === "icon"
        ? [{ name: "Out", side: "out", x: 70, y: 20 }]
        : [{ name: "In", side: "in", x: 0, y: 20 }] };
    }
    let pins = PIN_TABLE[(block.type || "").toUpperCase()];
    if (!pins) {
      if (block.visiblePins && block.visiblePins.length) {
        const names = block.visiblePins.slice();
        const out = names.pop();
        pins = { in: names, out: out !== undefined ? [out] : [] };
      } else {
        pins = { in: ["In"], out: ["Out"] };
      }
    }
    const rows = Math.max(pins.in.length, pins.out.length, 1);
    const h = PIN_Y0 + rows * PIN_DY + 8;
    const list = [];
    pins.in.forEach(function (name, i) {
      list.push({ name: name, side: "in", x: 0, y: PIN_Y0 + i * PIN_DY });
    });
    pins.out.forEach(function (name, i) {
      list.push({ name: name, side: "out", x: w, y: PIN_Y0 + i * PIN_DY });
    });
    return { w: w, h: h, pins: list };
  }

  /* Pure: auto-place blocks with x increasing by dataflow depth, y spread.
     Missing ids get unique string ids. Returns a NEW sheet object. */
  function fbdAutoLayout(sheetIR, opts) {
    opts = opts || {};
    const blocks = (sheetIR.blocks || []).map(function (b) { return Object.assign({}, b); });
    const used = new Set();
    blocks.forEach(function (b) { if (b.id !== undefined) used.add(String(b.id)); });
    let counter = 0;
    blocks.forEach(function (b) {
      if (b.id === undefined) {
        while (used.has(String(counter))) counter++;
        b.id = String(counter++);
      }
    });
    const depth = {};
    blocks.forEach(function (b) { depth[String(b.id)] = 0; });
    const incoming = {};
    for (const w of sheetIR.wires || []) {
      (incoming[String(w.to.id)] = incoming[String(w.to.id)] || []).push(String(w.from.id));
    }
    for (let iter = 0; iter < blocks.length + 1; iter++) {
      let changed = false;
      for (const b of blocks) {
        const id = String(b.id);
        for (const s of incoming[id] || []) {
          if (depth[s] !== undefined && depth[id] < depth[s] + 1) { depth[id] = depth[s] + 1; changed = true; }
        }
      }
      if (!changed) break;
    }
    const groups = {};
    blocks.forEach(function (b) { const d = depth[String(b.id)]; (groups[d] = groups[d] || []).push(b); });
    const keys = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    const DX = opts.dx !== undefined ? opts.dx : 260;
    const DY = opts.dy !== undefined ? opts.dy : 150;
    const X0 = opts.x0 !== undefined ? opts.x0 : 40;
    const Y0 = opts.y0 !== undefined ? opts.y0 : 40;
    keys.forEach(function (d) {
      groups[d].forEach(function (b, i) { b.x = X0 + d * DX; b.y = Y0 + i * DY; });
    });
    const out = Object.assign({}, sheetIR, { blocks: blocks });
    return out;
  }

  /* ------------------------------------------------------------------ */
  function FbdEditor(opts) {
    if (!(this instanceof FbdEditor)) return new FbdEditor(opts);
    this.opts = opts || {};
    this.container = this.opts.container || null;
    this.ir = this.opts.ir ? clone(this.opts.ir) : { kind: "fbd", sheets: [] };
    if (!Array.isArray(this.ir.sheets) || !this.ir.sheets.length) {
      this.ir.sheets = [{ number: "1", blocks: [], wires: [], textBoxes: [], attachments: [] }];
    }
    this.ctx = this.opts.ctx || null;
    this.onChange = this.opts.onChange || null;
    this.selection = null;      // block id
    this.pendingWire = null;    // { id, param, side }
    this._keyHandler = null;
    this._svg = null;
    this._domReady = hasDom() && !!this.container;
    this._bindKeys();
    if (this._domReady) this._buildChrome();
  }

  FbdEditor.prototype._bindKeys = function () {
    if (!this._domReady || this._keyHandler) return;
    const self = this;
    this._keyHandler = function (e) {
      if (e.key === "Delete" || e.key === "Backspace") {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        if (self.selection !== null) { self.deleteSelection(); }
      } else if (e.key === "Escape") {
        self.pendingWire = null;
        self.render();
      }
    };
    document.addEventListener("keydown", this._keyHandler);
  };

  FbdEditor.prototype._buildChrome = function () {
    const wrap = document.createElement("div");
    wrap.className = "fbd-editor";
    wrap.style.cssText = "position:relative;width:100%;height:100%;overflow:auto;background:#fafafa;";
    const palette = document.createElement("div");
    palette.className = "fbd-palette";
    palette.style.cssText = "padding:4px;border-bottom:1px solid #ccc;background:#fff;position:sticky;top:0;z-index:5;";
    const kinds = ["IREF", "OREF", "AND", "OR", "NOT", "XOR", "ADD", "SUB", "MUL", "DIV", "MOD", "MOV", "TON", "CTU", "JSR"];
    const self = this;
    for (const k of kinds) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = k;
      btn.className = "fbd-palette-btn";
      btn.addEventListener("click", function () { self.addBlock(k); });
      palette.appendChild(btn);
    }
    this._svgHost = document.createElement("div");
    this._svgHost.className = "fbd-canvas";
    this._svgHost.style.cssText = "position:relative;";
    this._overlay = document.createElement("div");
    this._overlay.style.cssText = "position:absolute;z-index:10;";
    wrap.appendChild(palette);
    wrap.appendChild(this._svgHost);
    wrap.appendChild(this._overlay);
    this.container.innerHTML = "";
    this.container.appendChild(wrap);
  };

  FbdEditor.prototype.render = function () {
    if (!this._domReady) return;
    const self = this;
    const host = this._svgHost;
    host.innerHTML = "";
    if (!svg || !svg.el) return;
    let totalH = 0;
    const svgs = [];
    (this.ir.sheets || []).forEach(function (sheet, si) {
      const s = self._renderSheet(sheet, si, totalH);
      if (s) { svgs.push(s); totalH += s.h + 60; }
    });
    for (const s of svgs) host.appendChild(s.node);
  };

  FbdEditor.prototype._pinAt = function (block, pinName) {
    const info = fbdPins(block);
    for (const p of info.pins) if (p.name === pinName) return p;
    return null;
  };

  FbdEditor.prototype._renderSheet = function (sheet, si, yOff) {
    const self = this;
    const S = 1;
    let maxX = 500, maxY = 300;
    sheet.blocks.forEach(function (b) { maxX = Math.max(maxX, (b.x || 0) + 260); maxY = Math.max(maxY, (b.y || 0) + 260); });
    const W = maxX + 60, H = maxY + 40;
    const node = svg.el("svg", { width: W, height: H, className: "fbd-sheet", style: "display:block;" });
    if (!node) return null;
    node.appendChild(svg.el("defs", null, svg.el("marker", {
      id: "fbd-arrow-" + si, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse"
    }, svg.el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#546e7a" }))));
    const g = svg.el("g", { className: "fbd-layer" });
    node.appendChild(g);

    /* wires under blocks */
    for (const w of sheet.wires || []) {
      const f = sheet.blocks.filter(function (b) { return String(b.id) === String(w.from.id); })[0];
      const t = sheet.blocks.filter(function (b) { return String(b.id) === String(w.to.id); })[0];
      if (!f || !t) continue;
      const fi = self._pinAt(f, w.from.param !== undefined ? w.from.param : "Out");
      const ti = self._pinAt(t, w.to.param !== undefined ? w.to.param : "In");
      if (!fi || !ti) continue;
      const x1 = f.x + fi.x, y1 = f.y + fi.y, x2 = t.x + ti.x, y2 = t.y + ti.y;
      g.appendChild(svg.el("path", {
        d: svg.edgePath(x1, y1, x2, y2, "LR"),
        fill: "none",
        stroke: w.feedback ? "#e91e63" : "#546e7a",
        "stroke-width": 1.6,
        "stroke-dasharray": w.feedback ? "5,3" : undefined,
        "marker-end": "url(#fbd-arrow-" + si + ")"
      }));
    }

    /* blocks */
    for (const b of sheet.blocks) {
      const info = fbdPins(b);
      const isSel = this.selection !== null && String(this.selection) === String(b.id);
      const bg = { iref: "#e3f2fd", oref: "#e8f5e9", icon: "#fff9c4", ocon: "#fff9c4",
        block: "#ffffff", "function": "#f3e5f5", jsr: "#fff3e0", sbr: "#fff3e0", ret: "#fff3e0" }[b.kind] || "#ffffff";
      const bgG = svg.el("g", { transform: "translate(" + b.x + "," + b.y + ")", className: "fbd-block" });
      bgG.appendChild(svg.el("rect", {
        x: 0, y: 0, width: info.w, height: info.h, rx: 4,
        fill: bg, stroke: isSel ? "#ff9800" : "#37474f",
        "stroke-width": isSel ? 3 : 1.5
      }));
      let label = "";
      if (b.kind === "iref" || b.kind === "oref") label = b.operand !== undefined ? b.operand : "?";
      else if (b.kind === "block" || b.kind === "function") label = (b.type || "?") + (b.operand !== undefined ? " " + b.operand : "");
      else if (b.kind === "jsr") label = "JSR " + (b.routine !== undefined ? b.routine : "?");
      else if (b.kind === "sbr") label = "SBR";
      else if (b.kind === "ret") label = "RET";
      else label = b.name !== undefined ? b.name : b.kind.toUpperCase();
      bgG.appendChild(svg.el("text", {
        x: info.w / 2, y: 12, "text-anchor": "middle", "font-size": 11, fill: "#263238"
      }, String(label).slice(0, 26)));
      for (const p of info.pins) {
        const isPending = this.pendingWire && String(this.pendingWire.id) === String(b.id) && this.pendingWire.param === p.name;
        const pin = svg.el("circle", {
          cx: p.x, cy: p.y, r: 4.5,
          fill: isPending ? "#ff9800" : (p.side === "in" ? "#4fc3f7" : "#81c784"),
          stroke: "#263238", "stroke-width": 1, className: "fbd-pin"
        });
        pin.setAttribute("data-pin", p.name);
        pin.setAttribute("data-side", p.side);
        pin.setAttribute("data-block", String(b.id));
        const selfRef = this;
        pin.addEventListener("click", function (e) {
          e.stopPropagation();
          const side = pin.getAttribute("data-side");
          if (selfRef.pendingWire) {
            const pw = selfRef.pendingWire;
            if (pw.side === "out" && side === "in") {
              const from = { id: pw.id };
              if (pw.param !== undefined && !(pw.side === "out" && pw.isRef)) from.param = pw.param;
              const to = { id: pin.getAttribute("data-block") };
              const toParam = pin.getAttribute("data-pin");
              const tBlock = sheet.blocks.filter(function (x) { return String(x.id) === to.id; })[0];
              if (!(tBlock && (tBlock.kind === "oref" || tBlock.kind === "ocon"))) to.param = toParam;
              sheet.wires.push({ from: from, to: to });
              selfRef.pendingWire = null;
              selfRef._mutate();
            } else {
              selfRef.pendingWire = null;
              selfRef.render();
            }
            return;
          }
        });
        pin.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          const side = pin.getAttribute("data-side");
          if (side !== "out") return;
          const bId = pin.getAttribute("data-block");
          const bRef = sheet.blocks.filter(function (x) { return String(x.id) === bId; })[0];
          const isRef = bRef && (bRef.kind === "iref" || bRef.kind === "icon");
          selfRef.pendingWire = { id: bId, param: pin.getAttribute("data-pin"), side: "out", isRef: isRef };
          selfRef.render();
        });
        bgG.appendChild(pin);
      }
      bgG.addEventListener("click", function (e) {
        e.stopPropagation();
        self.selection = String(b.id);
        self.render();
        if (self.opts.onSelect) self.opts.onSelect({ block: b, sheetIndex: si });
      });
      bgG.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        if (b.kind === "iref" || b.kind === "oref" || b.kind === "block" || b.kind === "function" || b.kind === "jsr") {
          self._editOperand(b);
        }
      });
      g.appendChild(bgG);
    }

    /* text boxes */
    for (const tb of sheet.textBoxes || []) {
      const w = 180, h = 26;
      const tg = svg.el("g", { transform: "translate(" + tb.x + "," + tb.y + ")", className: "fbd-textbox" });
      tg.appendChild(svg.el("rect", { x: 0, y: 0, width: w, height: h, fill: "#ffffe0", stroke: "#9e9d24", "stroke-width": 1 }));
      tg.appendChild(svg.el("text", { x: 4, y: 16, "font-size": 10, fill: "#827717" }, String(tb.text || "").slice(0, 40)));
      g.appendChild(tg);
    }

    /* attachments: dashed links textbox -> block */
    for (const a of sheet.attachments || []) {
      const tb = (sheet.textBoxes || []).filter(function (t) { return String(t.id) === String(a.from); })[0];
      const t = sheet.blocks.filter(function (b) { return String(b.id) === String(a.to); })[0];
      if (!tb || !t) continue;
      g.appendChild(svg.el("line", {
        x1: tb.x + 180, y1: tb.y + 13, x2: t.x, y2: t.y + 13,
        stroke: "#9e9d24", "stroke-width": 1, "stroke-dasharray": "3,3"
      }));
    }

    return { node: node, h: H };
  };

  FbdEditor.prototype._editOperand = function (block) {
    if (!this._domReady) return;
    const self = this;
    const overlay = this._overlay;
    overlay.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = block.operand !== undefined ? block.operand : "";
    input.style.cssText = "position:absolute;left:" + (block.x + 4) + "px;top:" + (block.y + 18) + "px;width:120px;font-size:11px;";
    overlay.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const commit = function () {
      if (done) return;
      done = true;
      block.operand = input.value;
      overlay.innerHTML = "";
      self._mutate();
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") commit(); if (e.key === "Escape") { done = true; overlay.innerHTML = ""; } });
  };

  FbdEditor.prototype._mutate = function () {
    if (this.onChange) this.onChange(clone(this.ir));
    this.render();
  };

  /* --- API --- */
  FbdEditor.prototype.getIR = function () { return this.ir; };
  FbdEditor.prototype.setIR = function (ir) {
    this.ir = ir ? clone(ir) : { kind: "fbd", sheets: [] };
    if (!Array.isArray(this.ir.sheets) || !this.ir.sheets.length) {
      this.ir.sheets = [{ number: "1", blocks: [], wires: [], textBoxes: [], attachments: [] }];
    }
    this.selection = null;
    this.pendingWire = null;
    this.render();
  };

  FbdEditor.prototype._nextId = function (sheet) {
    const used = new Set();
    sheet.blocks.forEach(function (b) { used.add(String(b.id)); });
    (sheet.textBoxes || []).forEach(function (t) { used.add(String(t.id)); });
    let n = 0;
    while (used.has(String(n))) n++;
    return String(n);
  };

  FbdEditor.prototype.addBlock = function (kind) {
    const sheet = this.ir.sheets[0];
    const id = this._nextId(sheet);
    let maxX = 40;
    sheet.blocks.forEach(function (b) { maxX = Math.max(maxX, (b.x || 0) + 260); });
    const x = maxX, y = 40;
    let b;
    const K = String(kind).toUpperCase();
    if (K === "IREF") b = { kind: "iref", id: id, x: x, y: y, operand: "tag" };
    else if (K === "OREF") b = { kind: "oref", id: id, x: x, y: y, operand: "tag" };
    else if (K === "JSR") b = { kind: "jsr", id: id, x: x, y: y, routine: "routine_01" };
    else if (PIN_TABLE[K]) {
      b = { kind: "block", type: K, id: id, x: x, y: y };
      const pins = PIN_TABLE[K].in.concat(PIN_TABLE[K].out);
      if (pins.length) b.visiblePins = pins;
      if (K === "TON" || K === "TOF" || K === "RTO" || K === "TONR" || K === "TOFR") b.operand = "timer_01";
      else if (K === "CTU" || K === "CTD") b.operand = "counter_01";
      else if (K !== "AND" && K !== "OR" && K !== "XOR" && K !== "NOT" && K !== "RES") b.operand = "dest_01";
    } else {
      b = { kind: "block", type: K, id: id, x: x, y: y, visiblePins: ["In1", "In2", "Out"], operand: "dest_01" };
    }
    sheet.blocks.push(b);
    this.selection = String(id);
    this._mutate();
    return b;
  };

  FbdEditor.prototype.deleteSelection = function () {
    if (this.selection === null) return;
    const sel = String(this.selection);
    for (const sheet of this.ir.sheets) {
      sheet.blocks = sheet.blocks.filter(function (b) { return String(b.id) !== sel; });
      sheet.wires = sheet.wires.filter(function (w) {
        return String(w.from.id) !== sel && String(w.to.id) !== sel;
      });
      sheet.attachments = (sheet.attachments || []).filter(function (a) {
        return String(a.from) !== sel && String(a.to) !== sel;
      });
    }
    this.selection = null;
    this._mutate();
  };

  FbdEditor.prototype.selectBlock = function (id) {
    this.selection = id === undefined ? null : String(id);
    this.render();
  };

  return { FbdEditor: FbdEditor, fbdAutoLayout: fbdAutoLayout, fbdPins: fbdPins };
});
