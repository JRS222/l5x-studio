/* L5X Studio - render/ladder.js (T2). Visual ladder editor (SVG) + pure cell-geometry helper.
   See CONTRACT section 8.
   - ladderLayout(rungIR, opts) is pure: returns the cell array for one rung with
     width/height/rails attached as properties. Cells: { id, x, y, w, h, kind:
     "instr"|"coil"|"bracket", instr?, path }. path = [{item:i}, {leg:k, item:j}, ...]
     from the rung root (leg steps use {leg:k}).
   - LadderEditor: SVG rendering with rails left/right, branch brackets, coils at the
     series end, click-select (orange outline), right-click menu (Insert/Delete/Add
     branch leg), "+" insert buttons between instructions and at rung ends, and an
     onChange(newIR) callback after every mutation. All IR mutations are DOM-free and
     work in Node (rendering degrades gracefully without a document).
   - LAD_INSTRUCTION_DEFS: palette grouped by category covering the CONTRACT section 2
     op list with per-arg names/hints and isCondition/isOutput flags. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const svg = typeof module !== "undefined" && module.exports ? require("./svg.js") : root.L5XStudio;
  const utilDep = typeof module !== "undefined" && module.exports ? require("../util.js") : root.L5XStudio;
  const util = (utilDep && utilDep.util) || utilDep;

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElementNS === "function";
  }
  function clone(x) {
    if (util && util.deepClone) return util.deepClone(x);
    return JSON.parse(JSON.stringify(x));
  }

  /* ---------------- palette definitions ---------------- */
  function D(op, name, category, args, isCondition, isOutput) {
    return {
      op: op, name: name, category: category,
      args: args.map(function (a) { return { name: a[0], hint: a[1] }; }),
      isCondition: !!isCondition, isOutput: !!isOutput
    };
  }
  const LAD_INSTRUCTION_DEFS = [
    D("XIC", "Examine If Closed", "Relay", [["Operand", "BOOL tag or bit"]], true, false),
    D("XIO", "Examine If Open", "Relay", [["Operand", "BOOL tag or bit"]], true, false),
    D("OTE", "Output Energize", "Relay", [["Operand", "BOOL tag"]], false, true),
    D("OTL", "Output Latch", "Relay", [["Operand", "BOOL tag"]], false, true),
    D("OTU", "Output Unlatch", "Relay", [["Operand", "BOOL tag"]], false, true),
    D("ONS", "One Shot", "Relay", [["Storage Bit", "BOOL storage bit"]], false, true),
    D("OSR", "One Shot Rising", "Relay", [["Storage Bit", "BOOL storage bit"], ["Output Bit", "BOOL output bit"]], false, true),
    D("OSF", "One Shot Falling", "Relay", [["Storage Bit", "BOOL storage bit"], ["Output Bit", "BOOL output bit"]], false, true),
    D("AFI", "Always False", "Relay", [], true, false),
    D("NOP", "No Operation", "Relay", [], false, false),
    D("TON", "Timer On Delay", "Timer/Counter", [["Timer", "TIMER tag"], ["Preset", "time (e.g. T#2s) or ms"], ["Accum", "accum tag"]], false, true),
    D("TOF", "Timer Off Delay", "Timer/Counter", [["Timer", "TIMER tag"], ["Preset", "time or ms"], ["Accum", "accum tag"]], false, true),
    D("RTO", "Retentive Timer On", "Timer/Counter", [["Timer", "TIMER tag"], ["Preset", "time or ms"], ["Accum", "accum tag"]], false, true),
    D("TONR", "Timer On (FBD form)", "Timer/Counter", [["Timer", "TIMER tag"], ["Preset", "time or ms"], ["Accum", "accum tag"]], false, true),
    D("CTU", "Count Up", "Timer/Counter", [["Counter", "COUNTER tag"], ["Preset", "int"], ["Accum", "accum tag"]], false, true),
    D("CTD", "Count Down", "Timer/Counter", [["Counter", "COUNTER tag"], ["Preset", "int"], ["Accum", "accum tag"]], false, true),
    D("RES", "Reset", "Timer/Counter", [["Structure", "TIMER/COUNTER tag"]], false, true),
    D("ADD", "Add", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("SUB", "Subtract", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("MUL", "Multiply", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("DIV", "Divide", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("MOD", "Modulo", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("NEG", "Negate", "Compute/Math", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("ABS", "Absolute Value", "Compute/Math", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("SQR", "Square", "Compute/Math", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("SQRT", "Square Root", "Compute/Math", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("CPT", "Compute", "Compute/Math", [["Dest", "tag"], ["Expression", "expression text"]], false, true),
    D("CLR", "Clear", "Compute/Math", [["Dest", "tag"]], false, true),
    D("EQU", "Equal", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("NEQ", "Not Equal", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("GRT", "Greater Than", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("GEQ", "Greater/Equal", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("LES", "Less Than", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("LEQ", "Less/Equal", "Compute/Math", [["Source A", "tag or literal"], ["Source B", "tag or literal"]], true, false),
    D("LIM", "Limit Test", "Compute/Math", [["Low Limit", "tag or literal"], ["Test", "tag or literal"], ["High Limit", "tag or literal"]], true, false),
    D("MEQ", "Masked Equal", "Compute/Math", [["Source", "tag or literal"], ["Mask", "tag or literal"], ["Compare", "tag or literal"]], true, false),
    D("CMP", "Compare", "Compute/Math", [["Expression", "expression text"]], true, false),
    D("MOV", "Move", "Move/Logical", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("COP", "Copy", "Move/Logical", [["Source", "tag"], ["Dest", "tag"], ["Length", "count"]], false, true),
    D("CPS", "Synchronous Copy", "Move/Logical", [["Source", "tag"], ["Dest", "tag"], ["Length", "count"]], false, true),
    D("FLL", "Fill", "Move/Logical", [["Source", "tag or literal"], ["Dest", "tag"], ["Length", "count"]], false, true),
    D("SWPB", "Swap Bytes", "Move/Logical", [["Source", "tag"], ["Order", "REVERSE/WORD/LONG"], ["Dest", "tag"]], false, true),
    D("BTD", "Bit Field Distribute", "Move/Logical", [["Source", "tag"], ["Source Bit", "bit"], ["Length", "count"], ["Dest", "tag"], ["Dest Bit", "bit"]], false, true),
    D("AND", "Bitwise AND", "Move/Logical", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("OR", "Bitwise OR", "Move/Logical", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("XOR", "Bitwise XOR", "Move/Logical", [["Source A", "tag or literal"], ["Source B", "tag or literal"], ["Dest", "tag"]], false, true),
    D("NOT", "Bitwise NOT", "Move/Logical", [["Source", "tag or literal"], ["Dest", "tag"]], false, true),
    D("BSL", "Bit Shift Left", "Move/Logical", [["Array", "array tag"], ["Control", "CONTROL tag"], ["Source Bit", "bit"], ["Length", "count"]], false, true),
    D("BSR", "Bit Shift Right", "Move/Logical", [["Array", "array tag"], ["Control", "CONTROL tag"], ["Source Bit", "bit"], ["Length", "count"]], false, true),
    D("JSR", "Jump to Subroutine", "Program Control", [["Routine", "routine name"], ["Input Count", "0"], ["Inputs", "param tags..."]], false, true),
    D("SBR", "Subroutine", "Program Control", [["Parameters", "param tags..."]], false, true),
    D("RET", "Return", "Program Control", [["Parameters", "return tags..."]], false, true),
    D("JMP", "Jump to Label", "Program Control", [["Label", "label name"]], false, true),
    D("LBL", "Label", "Program Control", [["Label", "label name"]], false, true),
    D("FOR", "For Loop", "Program Control", [["Label", "label name"], ["Index", "index tag"], ["Initial", "value"], ["Terminal", "value"], ["Step", "value"]], false, true),
    D("NXT", "Next (loop end)", "Program Control", [["Label", "label name"]], false, true),
    D("GSV", "Get System Value", "Misc", [["Class", "class name"], ["Instance", "instance"], ["Attribute", "attribute"], ["Dest", "tag"]], false, true),
    D("SSV", "Set System Value", "Misc", [["Class", "class name"], ["Instance", "instance"], ["Attribute", "attribute"], ["Source", "tag"]], false, true),
    D("MSG", "Message", "Misc", [["Control", "MESSAGE tag"]], false, true),
    D("AVE", "Average", "Misc", [["Array", "array tag"], ["Dimension", "dim"], ["Control", "CONTROL tag"], ["Length", "count"], ["Dest", "tag"]], false, true),
    D("CONCAT", "String Concatenate", "Misc", [["Source A", "string"], ["Source B", "string"], ["Dest", "string tag"]], false, true),
    D("DTOS", "DINT to String", "Misc", [["Source", "DINT"], ["Dest", "string tag"]], false, true),
    D("TOD", "Bcd To Decimal", "Misc", [["Source", "BCD"], ["Dest", "DINT"]], false, true),
    D("STOD", "String to DINT", "Misc", [["Source", "string"], ["Dest", "DINT"]], false, true),
    D("RTOD", "Real to DINT", "Misc", [["Source", "REAL"], ["Dest", "DINT"]], false, true),
    D("DTOR", "DINT to Real", "Misc", [["Source", "DINT"], ["Dest", "REAL"]], false, true),
    D("STOR", "String to Real", "Misc", [["Source", "string"], ["Dest", "REAL"]], false, true),
    D("MID", "String Middle", "Misc", [["Source", "string"], ["Start", "int"], ["Length", "int"], ["Dest", "string tag"]], false, true),
    D("DELETE", "String Delete", "Misc", [["Source", "string"], ["Start", "int"], ["Length", "int"], ["Dest", "string tag"]], false, true),
    D("FIND", "String Find", "Misc", [["Source", "string"], ["Search", "string"], ["Start", "int"], ["Result", "tag"]], false, true),
    D("INSERT", "String Insert", "Misc", [["Source", "string"], ["Insert", "string"], ["Position", "int"], ["Dest", "string tag"]], false, true),
    D("SIZE", "Size", "Misc", [["Source", "array tag"], ["Dimension", "dim"], ["Dest", "tag"]], false, true)
  ];
  const DEFS_BY_OP = {};
  for (const d of LAD_INSTRUCTION_DEFS) DEFS_BY_OP[d.op] = d;

  /* ---------------- pure layout ---------------- */
  const CW = 96, CH = 32, GX = 18, GY = 16, BW = 12, BRGAP = 10, X0 = 40;

  function ladderLayout(rungIR, opts) {
    opts = opts || {};
    const root = (rungIR && rungIR.root) ? rungIR.root
      : (rungIR && (rungIR.kind === "series" || rungIR.kind === "parallel")) ? rungIR
      : { kind: "series", items: [] };
    const cells = [];
    let nid = 0;
    const isOutOp = function (op) {
      const d = DEFS_BY_OP[op];
      return !!d && d.isOutput;
    };
    function instrCell(instr, x, y, path, kind) {
      const cell = {
        id: "n" + (nid++), x: x, y: y, w: CW, h: CH,
        kind: kind || "instr", instr: instr, path: path.slice(), row: 0
      };
      cells.push(cell);
      return CW;
    }
    function layoutSeries(items, x, y, path) {
      let cx = x, h = CH;
      for (let i = 0; i < (items || []).length; i++) {
        const item = items[i];
        const p = path.concat([{ item: i }]);
        let w;
        if (item.kind === "series") {
          const r = layoutSeries(item.items, cx, y, p);
          w = r.w; h = Math.max(h, r.h);
        } else if (item.kind === "parallel") {
          const r = layoutParallel(item, cx, y, p);
          w = r.w; h = Math.max(h, r.h);
        } else {
          w = instrCell(item, cx, y, p, isOutOp(item.op) ? "coil" : "instr");
        }
        cx += w + GX;
      }
      const w = (items && items.length) ? cx - x - GX : 0;
      return { w: Math.max(0, w), h: h };
    }
    function layoutParallel(node, x, y, path) {
      let totalH = 0, maxW = 0;
      const legX = x + BW + BRGAP;
      const results = [];
      for (let k = 0; k < node.legs.length; k++) {
        const leg = node.legs[k];
        const r = layoutSeries(leg.items || [], legX, y + totalH, path.concat([{ leg: k }]));
        results.push(r);
        maxW = Math.max(maxW, r.w);
        totalH += r.h + GY;
      }
      if (node.legs.length) totalH -= GY;
      totalH = Math.max(totalH, CH);
      cells.push({
        id: "b" + (nid++), x: x, y: y, w: BW, h: totalH,
        kind: "bracket", side: "left", path: path.slice()
      });
      cells.push({
        id: "b" + (nid++), x: x + BW + BRGAP + maxW + BRGAP, y: y, w: BW, h: totalH,
        kind: "bracket", side: "right", path: path.slice()
      });
      return { w: BW * 2 + BRGAP * 2 + maxW, h: totalH };
    }
    let dim;
    if (root.kind === "parallel") {
      /* whole rung is a parallel: treat as one parallel node at X0 */
      const r = layoutParallel(root, X0, 0, []);
      dim = { w: r.w, h: r.h };
    } else {
      dim = layoutSeries(root.items || [], X0, 0, []);
    }
    const RAIL_GAP = 26;
    const rails = {
      left: { x: X0 - RAIL_GAP, w: 4, y: 0, h: Math.max(dim.h, CH) },
      right: { x: X0 + dim.w + RAIL_GAP, w: 4, y: 0, h: Math.max(dim.h, CH) }
    };
    cells.width = dim.w;
    cells.height = Math.max(dim.h, CH);
    cells.rails = rails;
    cells.x0 = X0;
    return cells;
  }

  /* path helpers (DOM-free) */
  function resolvePath(root, path) {
    let node = root;
    for (const step of path || []) {
      if (step.leg !== undefined) node = node && node.legs ? node.legs[step.leg] : null;
      else node = node && node.items ? node.items[step.item] : null;
      if (!node) return null;
    }
    return node;
  }
  function seriesOfPath(root, path) {
    /* Walk all steps but the last; return { container, index } for an item-indexed target
       or { container, legIndex } when the last step is a leg step. */
    let node = root;
    for (let i = 0; i < (path || []).length - 1; i++) {
      const step = path[i];
      if (step.leg !== undefined) node = node && node.legs ? node.legs[step.leg] : null;
      else node = node && node.items ? node.items[step.item] : null;
      if (!node) return null;
    }
    if (!path || !path.length) return { container: root, index: -1 };
    const last = path[path.length - 1];
    if (last.leg !== undefined) return { container: node, legIndex: last.leg };
    return { container: node, index: last.item };
  }
  function normalizeSeries(series) {
    if (!series.items || series.items.length === 0) {
      series.items = [{ op: "NOP", args: [] }];
    }
    return series;
  }

  /* ---------------- editor ---------------- */
  function LadderEditor(opts) {
    if (!(this instanceof LadderEditor)) return new LadderEditor(opts);
    this.opts = opts || {};
    this.container = this.opts.container || null;
    this.ir = this.opts.ir ? clone(this.opts.ir) : { kind: "lad", rungs: [] };
    if (!Array.isArray(this.ir.rungs)) this.ir.rungs = [];
    this.ctx = this.opts.ctx || null;
    this.onChange = this.opts.onChange || null;
    this.readOnly = !!this.opts.readOnly;
    this.selection = null;      // { rungIndex, path, argIndex, cellId }
    this._idMap = {};           // cellId -> { rungIndex, instr }
    this._menuEl = null;
    this._domReady = hasDom() && !!this.container;
    this.render();
  }

  LadderEditor.prototype._rungByNumber = function (number) {
    for (let i = 0; i < this.ir.rungs.length; i++) {
      if (this.ir.rungs[i].number === number) return { rung: this.ir.rungs[i], index: i };
    }
    return null;
  };

  LadderEditor.prototype._mutate = function () {
    if (this.onChange) this.onChange(clone(this.ir));
    this.render();
  };

  LadderEditor.prototype.render = function () {
    if (!this._domReady) return;
    const self = this;
    this.container.innerHTML = "";
    this._idMap = {};
    if (!svg || !svg.el) return;
    let yCursor = 8;
    const maxW = 700;
    const svgRoot = svg.el("svg", { className: "lad-editor-svg", style: "background:#fff;display:block;" });
    const rootG = svg.el("g", { className: "lad-root" });
    svgRoot.appendChild(rootG);

    for (let ri = 0; ri < this.ir.rungs.length; ri++) {
      const rung = this.ir.rungs[ri];
      const cells = ladderLayout(rung);
      const rungW = Math.max(cells.width + 100, maxW);
      const rungH = cells.height + 28;
      const g = svg.el("g", { className: "lad-rung", transform: "translate(0," + yCursor + ")" });
      g.appendChild(svg.el("text", { x: 4, y: rungH / 2 + 4, "font-size": 11, fill: "#78909c" }, String(rung.number)));
      /* rails */
      const rails = cells.rails || {};
      g.appendChild(svg.el("rect", { x: rails.left ? rails.left.x : 8, y: 10, width: 4, height: rungH - 20, fill: "#455a64" }));
      g.appendChild(svg.el("rect", { x: rails.right ? rails.right.x : rungW - 40, y: 10, width: 4, height: rungH - 20, fill: "#455a64" }));
      /* wires: consecutive cells in the same row */
      const rows = {};
      for (const c of cells) {
        if (c.kind === "bracket") continue;
        const y = c.y + c.h / 2 + 14;
        (rows[y] = rows[y] || []).push(c);
      }
      for (const yKey of Object.keys(rows)) {
        const row = rows[yKey].sort(function (a, b) { return a.x - b.x; });
        for (let i = 1; i < row.length; i++) {
          const a = row[i - 1], b = row[i];
          if (b.x - (a.x + a.w) > GX * 2.5) continue;
          g.appendChild(svg.el("line", {
            x1: a.x + a.w, y1: Number(yKey), x2: b.x, y2: Number(yKey),
            stroke: "#455a64", "stroke-width": 1.5
          }));
        }
      }
      /* cells */
      for (const c of cells) {
        if (c.kind === "bracket") {
          g.appendChild(svg.el("rect", {
            x: c.x, y: c.y + 14, width: c.w, height: c.h,
            rx: 3, fill: "#eceff1", stroke: "#455a64", "stroke-width": 1
          }));
          continue;
        }
        const isSel = this.selection && this.selection.rungIndex === ri && this.selection.cellId === c.id;
        const coil = c.kind === "coil";
        const rect = svg.el("rect", {
          x: c.x, y: c.y + 14, width: c.w, height: c.h,
          rx: coil ? c.h / 2 : 5,
          fill: isSel ? "#fff3e0" : (coil ? "#e8f5e9" : "#ffffff"),
          stroke: isSel ? "#ff9800" : "#37474f",
          "stroke-width": isSel ? 3 : 1.5,
          cursor: "pointer"
        });
        rect.addEventListener("click", function (ev) {
          ev.stopPropagation();
          self._selectCell(ri, c);
        });
        rect.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          self._showMenu(ev, ri, c);
        });
        g.appendChild(rect);
        const argsText = (c.instr.args || []).map(function (a) { return a === "" ? "?" : a; }).join(",");
        g.appendChild(svg.el("text", {
          x: c.x + c.w / 2, y: c.y + 14 + 13, "text-anchor": "middle", "font-size": 11, fill: "#263238",
          "font-weight": "bold"
        }, c.instr.op));
        g.appendChild(svg.el("text", {
          x: c.x + c.w / 2, y: c.y + 14 + 26, "text-anchor": "middle", "font-size": 9, fill: "#546e7a"
        }, String(argsText).slice(0, 22)));
        /* unique cell id for selection API */
        const uid = "r" + ri + "_" + c.id;
        this._idMap[uid] = { rungIndex: ri, instr: c.instr };
        rect.setAttribute("data-cell", uid);
      }
      /* "+" insert buttons: between consecutive cells of the main row and at rung end */
      const mainRow = [];
      for (const c of cells) {
        if (c.kind === "bracket") continue;
        if (c.path.length === 0 || (c.path[0] && c.path[0].leg === undefined)) mainRow.push(c);
      }
      mainRow.sort(function (a, b) { return a.x - b.x; });
      const plusSpots = [];
      for (let i = 0; i < mainRow.length; i++) {
        const a = mainRow[i];
        const b = mainRow[i + 1];
        if (b && b.x - (a.x + a.w) < GX * 2.5) continue;
        plusSpots.push({ x: b ? (a.x + a.w + b.x) / 2 : a.x + a.w + GX / 2, path: a.path });
      }
      if (!mainRow.length) plusSpots.push({ x: cells.x0, path: [] });
      for (const spot of plusSpots) {
        const btn = svg.el("circle", {
          cx: spot.x, cy: 14 + rungH / 2 - 6, r: 5,
          fill: "#4caf50", stroke: "#fff", "stroke-width": 1.5, cursor: "pointer", opacity: 0.5
        });
        btn.setAttribute("data-path", JSON.stringify(spot.path));
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          const p = JSON.parse(btn.getAttribute("data-path"));
          self.insertInstr(rung.number, p, { op: "XIC", args: ["?"] });
        });
        btn.addEventListener("mouseenter", function () { btn.setAttribute("opacity", 1); });
        btn.addEventListener("mouseleave", function () { btn.setAttribute("opacity", 0.5); });
        g.appendChild(btn);
      }
      if (rung.comment) {
        g.appendChild(svg.el("text", { x: 8, y: 12, "font-size": 10, fill: "#78909c" }, String(rung.comment).slice(0, 80)));
      }
      rootG.appendChild(g);
      yCursor += rungH + 14;
    }
    svgRoot.setAttribute("width", Math.max(maxW, 600));
    svgRoot.setAttribute("height", Math.max(yCursor, 60));
    this.container.appendChild(svgRoot);
    this._svgRoot = svgRoot;
  };

  LadderEditor.prototype._selectCell = function (ri, cell) {
    this.selection = { rungIndex: ri, path: cell.path, argIndex: -1, cellId: cell.id };
    this.render();
    if (this.opts.onSelect) {
      this.opts.onSelect({ rung: this.ir.rungs[ri], rungIndex: ri, instr: cell.instr, path: cell.path });
    }
  };

  LadderEditor.prototype._showMenu = function (ev, ri, cell) {
    if (this.readOnly) return;
    const self = this;
    this._closeMenu();
    const menu = document.createElement("div");
    menu.className = "lad-menu";
    menu.style.cssText = "position:absolute;background:#fff;border:1px solid #bbb;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:50;font:12px sans-serif;";
    const rect = this.container.getBoundingClientRect();
    menu.style.left = (ev.clientX - rect.left) + "px";
    menu.style.top = (ev.clientY - rect.top) + "px";
    const items = [
      { label: "Insert XIC after", fn: function () { self.insertInstr(self.ir.rungs[ri].number, cell.path, { op: "XIC", args: ["?"] }); } },
      { label: "Delete", fn: function () { self.deleteInstr(self.ir.rungs[ri].number, cell.path); } },
      { label: "Add branch leg", fn: function () { self.addParallelLeg(self.ir.rungs[ri].number, cell.path); } }
    ];
    for (const it of items) {
      const b = document.createElement("div");
      b.textContent = it.label;
      b.style.cssText = "padding:5px 12px;cursor:pointer;";
      b.addEventListener("mouseenter", function () { b.style.background = "#e3f2fd"; });
      b.addEventListener("mouseleave", function () { b.style.background = ""; });
      b.addEventListener("click", function () { self._closeMenu(); it.fn(); });
      menu.appendChild(b);
    }
    this.container.appendChild(menu);
    this._menuEl = menu;
    const closer = function () { self._closeMenu(); document.removeEventListener("mousedown", closer); };
    setTimeout(function () { document.addEventListener("mousedown", closer); }, 0);
  };
  LadderEditor.prototype._closeMenu = function () {
    if (this._menuEl && this._menuEl.parentNode) this._menuEl.parentNode.removeChild(this._menuEl);
    this._menuEl = null;
  };

  /* --- API --- */
  LadderEditor.prototype.getIR = function () { return this.ir; };
  LadderEditor.prototype.setIR = function (ir) {
    this.ir = ir ? clone(ir) : { kind: "lad", rungs: [] };
    if (!Array.isArray(this.ir.rungs)) this.ir.rungs = [];
    this.selection = null;
    this.render();
  };
  LadderEditor.prototype.selectInstr = function (id) {
    const hit = this._idMap[id];
    if (!hit) return null;
    return { instr: hit.instr, rung: this.ir.rungs[hit.rungIndex] };
  };
  LadderEditor.prototype.setSelection = function (id) {
    const hit = this._idMap[id];
    if (!hit) return;
    this.selection = { rungIndex: hit.rungIndex, path: [], cellId: id };
    this.render();
  };
  LadderEditor.prototype.addRung = function (afterNumber) {
    const found = this._rungByNumber(afterNumber);
    const idx = found ? found.index : this.ir.rungs.length - 1;
    const base = idx >= 0 ? this.ir.rungs[idx].number : -1;
    const rung = {
      number: base + 1, type: "N", comment: null,
      root: { kind: "series", items: [{ op: "XIC", args: ["?"] }] }
    };
    this.ir.rungs.splice(idx + 1, 0, rung);
    for (let i = idx + 2; i < this.ir.rungs.length; i++) this.ir.rungs[i].number = this.ir.rungs[i - 1].number + 1;
    this._mutate();
    return rung;
  };
  LadderEditor.prototype.deleteRung = function (number) {
    const found = this._rungByNumber(number);
    if (!found) return false;
    this.ir.rungs.splice(found.index, 1);
    for (let i = 0; i < this.ir.rungs.length; i++) this.ir.rungs[i].number = i;
    this._mutate();
    return true;
  };
  LadderEditor.prototype.insertInstr = function (rungNumber, path, instr) {
    const found = this._rungByNumber(rungNumber);
    if (!found) return false;
    const root = found.rung.root;
    if (!path || !path.length) {
      root.items.push(clone(instr));
      this._mutate();
      return true;
    }
    const loc = seriesOfPath(root, path);
    if (!loc) return false;
    if (loc.legIndex !== undefined) {
      const leg = loc.container.legs ? loc.container.legs[loc.legIndex] : null;
      if (!leg) return false;
      leg.items.push(clone(instr));
      this._mutate();
      return true;
    }
    if (!loc.container || !Array.isArray(loc.container.items)) return false;
    loc.container.items.splice(loc.index + 1, 0, clone(instr));
    this._mutate();
    return true;
  };
  LadderEditor.prototype.setOperand = function (rungNumber, path, argIndex, value) {
    const found = this._rungByNumber(rungNumber);
    if (!found) return false;
    const node = resolvePath(found.rung.root, path);
    if (!node || node.op === undefined) return false;
    if (!Array.isArray(node.args)) node.args = [];
    node.args[argIndex] = value;
    this._mutate();
    return true;
  };
  LadderEditor.prototype.deleteInstr = function (rungNumber, path) {
    const found = this._rungByNumber(rungNumber);
    if (!found) return false;
    const loc = seriesOfPath(found.rung.root, path);
    if (!loc) return false;
    if (loc.legIndex !== undefined) return false; // legs are removed via deleteParallelLeg
    if (!loc.container || !Array.isArray(loc.container.items)) return false;
    loc.container.items.splice(loc.index, 1);
    normalizeSeries(loc.container);
    this._mutate();
    return true;
  };
  LadderEditor.prototype.addParallelLeg = function (rungNumber, path) {
    const found = this._rungByNumber(rungNumber);
    if (!found) return false;
    const node = resolvePath(found.rung.root, path);
    const newLeg = { kind: "series", items: [{ op: "XIC", args: ["?"] }] };
    if (node && node.kind === "parallel") {
      node.legs.push(newLeg);
      this._mutate();
      return true;
    }
    if (node && node.kind === "series") {
      const par = { kind: "parallel", legs: [node, newLeg] };
      if (!path || !path.length) {
        found.rung.root = par;
      } else {
        const loc = seriesOfPath(found.rung.root, path);
        if (!loc || loc.legIndex !== undefined) return false;
        loc.container.items.splice(loc.index, 1, par);
      }
      this._mutate();
      return true;
    }
    /* instruction: wrap it together with a new leg into a parallel */
    const loc = seriesOfPath(found.rung.root, path);
    if (!loc || loc.legIndex !== undefined) return false;
    const par = { kind: "parallel", legs: [{ kind: "series", items: [node] }, newLeg] };
    loc.container.items.splice(loc.index, 1, par);
    this._mutate();
    return true;
  };
  LadderEditor.prototype.deleteParallelLeg = function (rungNumber, path, legIndex) {
    const found = this._rungByNumber(rungNumber);
    if (!found) return false;
    const node = resolvePath(found.rung.root, path);
    if (!node || node.kind !== "parallel" || !node.legs || node.legs.length <= 1) return false;
    node.legs.splice(legIndex, 1);
    this._mutate();
    return true;
  };

  return {
    LadderEditor: LadderEditor,
    ladderLayout: ladderLayout,
    LAD_INSTRUCTION_DEFS: LAD_INSTRUCTION_DEFS
  };
});
