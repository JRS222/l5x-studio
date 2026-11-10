/* L5X Studio - fbd-convert.js (T2). FBD <-> LAD conversion, FBD <-> ST composition and
   FBD dataflow graphs. See CONTRACT section 5.

   Conventions locked in here:
   - Boolean gates are <Block Type="AND|OR|XOR|NOT"> WITHOUT an Operand. Pins:
     AND/OR/XOR: In1, In2, Out; NOT: In, Out. IREFs are the boolean leaves; XIO -> NOT gate;
     AFI -> IREF with operand "FALSE"; always-true conditions -> IREF "TRUE".
   - Instruction-derived blocks carry Operand = the destination tag. Pin names:
     MOV/COP/CPS/FLL/NEG/ABS/SQR/SQRT/NOT: In (+Length for COP/CPS/FLL), Out
     ADD/SUB/MUL/DIV/MOD/AND/OR/XOR: In1, In2, Out
     EQU/NEQ/GRT/GEQ/LES/LEQ: In1, In2, Out ; LIM/MEQ: In1..In3, Out (comparison blocks,
     no operand)
     TON/TOF/RTO/TONR: EnableIn, PRE, Reset in; DN, TT, ACC out ; CTU: CUEnable/PRE/Reset,
     DN, ACC ; CTD: CDEnable/PRE/Reset, DN, ACC ; RES: no pins.
   - A rung condition that precedes an output instruction is AND-gated with the block
     result into an OREF (enable semantics approximated, warning emitted). Timer/counter
     blocks get EnableIn/CUEnable/CDEnable wired from the condition instead.
   - T1 modules (lang-convert) are composed when implemented; a local fallback keeps
     fbdToSt/stToFbd functional before T1 lands (callReady() bridges both worlds). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const lang = typeof module !== "undefined" && module.exports ? require("./lang-convert.js") : root.L5XStudio;
  const operands = typeof module !== "undefined" && module.exports ? require("./operands.js") : root.L5XStudio;
  const utilDep = typeof module !== "undefined" && module.exports ? require("./util.js") : root.L5XStudio;
  const util = (utilDep && utilDep.util) || utilDep;

  /* ---- semantic tables ---- */
  const GATE_TYPES = { AND: 1, OR: 1, XOR: 1, NOT: 1 };
  const GATE_IN_PINS = { AND: ["In1", "In2"], OR: ["In1", "In2"], XOR: ["In1", "In2"], NOT: ["In"] };
  const COND_INSTR = { XIC: 1, XIO: 1, EQU: 1, NEQ: 1, GRT: 1, GEQ: 1, LES: 1, LEQ: 1, LIM: 1, MEQ: 1, AFI: 1, NOP: 1 };
  const CMP_TYPES = { EQU: 2, NEQ: 2, GRT: 2, GEQ: 2, LES: 2, LEQ: 2, LIM: 3, MEQ: 3 };
  const BOOL_OUTPUTS = { OTE: 1, OTL: 1, OTU: 1, ONS: 1, OSR: 1, OSF: 1 };

  /* Ladder op -> FBD block mapping. inPins[i] corresponds to ladder args after skipping
     the operand/dest arg (destArg). destArg===0 means args[0] is the block operand. */
  const LAD_TO_FBD = {
    MOV: { inPins: ["In"], destArg: 1 },
    COP: { inPins: ["In", "Length"], destArg: 2 },
    CPS: { inPins: ["In", "Length"], destArg: 2 },
    FLL: { inPins: ["In", "Length"], destArg: 1 },
    ADD: { inPins: ["In1", "In2"], destArg: 2 },
    SUB: { inPins: ["In1", "In2"], destArg: 2 },
    MUL: { inPins: ["In1", "In2"], destArg: 2 },
    DIV: { inPins: ["In1", "In2"], destArg: 2 },
    MOD: { inPins: ["In1", "In2"], destArg: 2 },
    NEG: { inPins: ["In"], destArg: 1 },
    ABS: { inPins: ["In"], destArg: 1 },
    SQR: { inPins: ["In"], destArg: 1 },
    SQRT: { inPins: ["In"], destArg: 1 },
    CLR: { inPins: [], destArg: 0 },
    CPT: { inPins: ["In"], destArg: 0 },
    AND: { inPins: ["In1", "In2"], destArg: 2 },
    OR: { inPins: ["In1", "In2"], destArg: 2 },
    XOR: { inPins: ["In1", "In2"], destArg: 2 },
    NOT: { inPins: ["In"], destArg: 1 },
    TON: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "EnableIn" },
    TOF: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "EnableIn" },
    RTO: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "EnableIn" },
    TONR: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "EnableIn" },
    CTU: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "CUEnable" },
    CTD: { inPins: ["PRE", "ACC"], destArg: 0, enablePin: "CDEnable" },
    RES: { inPins: [], destArg: 0 },
    FOR: { inPins: ["In1", "In2", "In3", "In4"], destArg: 1 },
    NXT: { inPins: [], destArg: 0 },
    JMP: { inPins: [], destArg: 0 },
    LBL: { inPins: [], destArg: 0 },
    GSV: { inPins: ["In1", "In2", "In3"], destArg: 3 },
    SSV: { inPins: ["In1", "In2", "In3"], destArg: 3 },
    MSG: { inPins: [], destArg: 0 },
    AVE: { inPins: ["In1", "In2", "In3", "In4"], destArg: 4 },
    BSL: { inPins: ["In1", "In2", "In3"], destArg: 1 },
    BSR: { inPins: ["In1", "In2", "In3"], destArg: 1 }
  };

  /* FBD block type -> ladder instruction mapping (inverse of the above). */
  const FBD_TO_LAD = {
    MOV: { pins: ["In"], operandFirst: false },
    COP: { pins: ["In", "Length"], operandFirst: false },
    CPS: { pins: ["In", "Length"], operandFirst: false },
    FLL: { pins: ["In", "Length"], operandFirst: false },
    ADD: { pins: ["In1", "In2"], operandFirst: false },
    SUB: { pins: ["In1", "In2"], operandFirst: false },
    MUL: { pins: ["In1", "In2"], operandFirst: false },
    DIV: { pins: ["In1", "In2"], operandFirst: false },
    MOD: { pins: ["In1", "In2"], operandFirst: false },
    NEG: { pins: ["In"], operandFirst: false },
    ABS: { pins: ["In"], operandFirst: false },
    SQR: { pins: ["In"], operandFirst: false },
    SQRT: { pins: ["In"], operandFirst: false },
    CLR: { pins: [], operandFirst: false },
    CPT: { pins: ["In"], operandFirst: true },
    AND: { pins: ["In1", "In2"], operandFirst: false },
    OR: { pins: ["In1", "In2"], operandFirst: false },
    XOR: { pins: ["In1", "In2"], operandFirst: false },
    NOT: { pins: ["In"], operandFirst: false },
    TON: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "EnableIn" },
    TOF: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "EnableIn" },
    RTO: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "EnableIn" },
    TONR: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "EnableIn" },
    CTU: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "CUEnable" },
    CTD: { pins: ["PRE", "ACC"], operandFirst: true, enablePin: "CDEnable" },
    RES: { pins: [], operandFirst: true },
    FOR: { pins: ["In1", "In2", "In3", "In4"], operandFirst: false, insertAt: 1 },
    NXT: { pins: [], operandFirst: true },
    JMP: { pins: [], operandFirst: true },
    LBL: { pins: [], operandFirst: true },
    GSV: { pins: ["In1", "In2", "In3"], operandFirst: false },
    SSV: { pins: ["In1", "In2", "In3"], operandFirst: false },
    MSG: { pins: [], operandFirst: true },
    AVE: { pins: ["In1", "In2", "In3", "In4"], operandFirst: false },
    BSL: { pins: ["In1", "In2", "In3"], operandFirst: false, insertAt: 1 },
    BSR: { pins: ["In1", "In2", "In3"], operandFirst: false, insertAt: 1 }
  };

  /* ---- small helpers ---- */
  function clone(x) { return util && util.deepClone ? util.deepClone(x) : JSON.parse(JSON.stringify(x)); }

  /* Call a T1 function when it is implemented; return null when it still throws
     "not implemented". Bridges the window while T1 is in flight. */
  function callReady(fn, args, self) {
    if (typeof fn !== "function") return null;
    try { return fn.apply(self, args); }
    catch (e) {
      if (/not implemented/i.test(String(e && e.message))) return null;
      throw e;
    }
  }

  function isLiteralText(text) {
    if (operands && operands.isLikelyTag) return !operands.isLikelyTag(text);
    if (text === undefined || text === null) return true;
    return /^\s*(\?|TRUE|FALSE|[-+]?\d|16#[0-9a-fA-F_]+|2#[01_]+|8#[0-7_]+|'.*'|T#)/.test(String(text));
  }
  function makeInstr(op, args) {
    let list;
    if (arguments.length === 2 && Array.isArray(args)) list = args.slice();
    else {
      list = [];
      for (let i = 1; i < arguments.length; i++) list.push(arguments[i] === undefined ? "?" : arguments[i]);
    }
    return { op: op, args: list };
  }
  function makeSeries(items) { return { kind: "series", items: items || [] }; }
  function makeParallel(legs) {
    return { kind: "parallel", legs: (legs || []).map(function (l) { return l.kind ? l : makeSeries(l); }) };
  }
  function warn(list, kind, rung, msg) { list.push({ kind: kind, rung: rung, msg: msg }); }

  /* ============================================================================
   * LAD -> FBD
   * ========================================================================== */
  function ladToFbd(ladIR) {
    const warnings = [];
    const sheet = { blocks: [], wires: [], textBoxes: [], attachments: [] };
    const ctx = {
      counter: 0, blocks: sheet.blocks, wires: sheet.wires, warnings: warnings,
      rungNumber: -1
    };
    function newId() { ctx.counter += 1; return String(ctx.counter); }
    function wire(from, fromParam, to, toParam) {
      const w = {
        from: { id: String(from && from.id !== undefined ? from.id : from) },
        to: { id: String(to && to.id !== undefined ? to.id : to) }
      };
      if (fromParam !== undefined) w.from.param = fromParam;
      if (toParam !== undefined) w.to.param = toParam;
      ctx.wires.push(w);
    }
    function makeIref(operand) {
      const b = { kind: "iref", id: newId(), x: 0, y: 0, operand: String(operand) };
      ctx.blocks.push(b);
      return b;
    }
    function makeOref(operand) {
      const b = { kind: "oref", id: newId(), x: 0, y: 0, operand: String(operand) };
      ctx.blocks.push(b);
      return b;
    }
    function makeGate(type) {
      const pins = GATE_IN_PINS[type].slice();
      pins.push("Out");
      const b = { kind: "block", type: type, id: newId(), x: 0, y: 0, visiblePins: pins };
      ctx.blocks.push(b);
      return b;
    }
    /* ref: { id, param? } - param present for gate/block output pins. */
    function andRefs(a, b) {
      if (!a) return b;
      if (!b) return a;
      const g = makeGate("AND");
      wire(a, a.param, g, "In1");
      wire(b, b.param, g, "In2");
      return { id: g.id, param: "Out" };
    }
    function orRefs(a, b) {
      if (!a || !b) return a || b; // a missing ref means "always true" already
      const g = makeGate("OR");
      wire(a, a.param, g, "In1");
      wire(b, b.param, g, "In2");
      return { id: g.id, param: "Out" };
    }
    function condInstrRef(instr) {
      const op = instr.op, args = instr.args || [];
      if (op === "NOP") return null;
      if (op === "XIC") return { id: makeIref(args[0] === undefined ? "?" : args[0]).id };
      if (op === "XIO") {
        const g = makeGate("NOT");
        wire({ id: makeIref(args[0] === undefined ? "?" : args[0]).id }, undefined, g, "In");
        return { id: g.id, param: "Out" };
      }
      if (op === "AFI") return { id: makeIref("FALSE").id };
      if (CMP_TYPES[op]) {
        const n = CMP_TYPES[op];
        const pins = [];
        for (let i = 0; i < n; i++) pins.push("In" + (i + 1));
        pins.push("Out");
        const b = { kind: "block", type: op, id: newId(), x: 0, y: 0, visiblePins: pins };
        ctx.blocks.push(b);
        for (let i = 0; i < n; i++) {
          const a = args[i];
          if (a === undefined || a === "?") continue;
          wire({ id: makeIref(a).id }, undefined, b, "In" + (i + 1));
        }
        return { id: b.id, param: "Out" };
      }
      return null;
    }
    /* branch with only condition instructions -> ref of its boolean result */
    function condForBranch(branch) {
      if (branch.kind === "series") {
        let acc = null;
        for (const item of branch.items) {
          if (item.kind === "series" || item.kind === "parallel") {
            const r = condForBranch(item);
            acc = r === null ? acc : andRefs(acc, r);
          } else {
            const r = condInstrRef(item);
            acc = r === null ? acc : andRefs(acc, r);
          }
        }
        return acc;
      }
      if (branch.kind === "parallel") {
        let acc = null;
        for (const leg of branch.legs) {
          const r = condForBranch(leg);
          if (r === null) {
            /* an empty/NOP leg is an always-true path, so the whole parallel is
               always true (its other legs are electrically dead in ladder too) */
            warn(ctx.warnings, "unsupported", ctx.rungNumber,
              "parallel branch with empty leg treated as always-true; dead leg logic not wired");
            return null;
          }
          acc = acc ? orRefs(acc, r) : r;
        }
        return acc;
      }
      return null;
    }
    function branchHasOutputs(branch) {
      let found = false;
      (function walk(node) {
        if (found) return;
        if (!node) return;
        if (node.op !== undefined) {
          if (!COND_INSTR[node.op]) found = true;
          return;
        }
        if (node.kind === "series") for (const i of node.items) walk(i);
        else if (node.kind === "parallel") for (const l of node.legs) walk(l);
      })(branch);
      return found;
    }
    function emitOutput(instr, cond) {
      const op = instr.op, args = instr.args || [];
      if (BOOL_OUTPUTS[op]) {
        if (op !== "OTE") warn(warnings, "unsupported", ctx.rungNumber, op + " approximated as OREF");
        const o = makeOref(args[0] === undefined ? "?" : args[0]);
        const src = cond || { id: makeIref("TRUE").id };
        wire(src, src.param, o, undefined);
        return;
      }
      if (op === "JSR" || op === "SBR" || op === "RET") {
        const el = { kind: op.toLowerCase(), id: newId(), x: 0, y: 0 };
        if (op === "JSR") {
          el.routine = args[0] === undefined ? "?" : args[0];
          el.in = args.slice(2);
          /* JSR supports an EnableIn pin in FBD: wire the rung condition there */
          if (cond) wire(cond, cond.param, el, "EnableIn");
        } else if (op === "SBR") {
          el.ret = args.slice();
        } else {
          el.in = args.slice();
        }
        ctx.blocks.push(el);
        return;
      }
      const m = LAD_TO_FBD[op];
      if (m) {
        const pins = m.inPins.slice();
        pins.push("Out");
        const b = { kind: "block", type: op, id: newId(), x: 0, y: 0, visiblePins: pins };
        let operand;
        let pinArgs;
        if (m.destArg === 0) {
          operand = args[0];
          pinArgs = args.slice(1, 1 + m.inPins.length);
        } else {
          operand = args[m.destArg];
          pinArgs = args.filter(function (a, i) { return i !== m.destArg; }).slice(0, m.inPins.length);
        }
        if (operand !== undefined && operand !== "?" && isLiteralText(operand)) {
          warn(warnings, "unsupported", ctx.rungNumber,
            op + " destination " + operand + " is a literal; generated fbd_<n> DINT tag used");
          operand = "fbd_" + b.id;
        }
        if (operand !== undefined) b.operand = String(operand);
        ctx.blocks.push(b);
        for (let i = 0; i < m.inPins.length; i++) {
          const a = pinArgs[i];
          if (a === undefined || a === "?" || a === "") continue;
          wire({ id: makeIref(a).id }, undefined, b, m.inPins[i]);
        }
        if (m.enablePin) {
          if (cond) wire(cond, cond.param, b, m.enablePin);
        } else if (cond) {
          warn(warnings, "unsupported", ctx.rungNumber,
            "ladder enable semantics approximated with an AND gate on " + op);
          const g = makeGate("AND");
          wire(cond, cond.param, g, "In1");
          wire({ id: b.id, param: "Out" }, "Out", g, "In2");
          const o = makeOref(operand !== undefined ? operand : "fbd_" + b.id);
          wire({ id: g.id, param: "Out" }, "Out", o, undefined);
        }
        return;
      }
      /* Unknown op: generic block fallback - never silently drop logic. The last
         tag-like argument becomes the block operand (destination); every other
         argument becomes an input pin. */
      warn(warnings, "unsupported", ctx.rungNumber, op + " emitted as generic FBD block");
      let destIdx = -1;
      for (let i = args.length - 1; i >= 0; i--) {
        if (args[i] && args[i] !== "?" && !isLiteralText(args[i])) { destIdx = i; break; }
      }
      const pins = [];
      for (let i = 0; i < args.length; i++) if (i !== destIdx) pins.push("In" + (i + 1));
      pins.push("Out");
      const b = { kind: "block", type: op, id: newId(), x: 0, y: 0, visiblePins: pins };
      let dest = destIdx >= 0 ? args[destIdx] : null;
      if (dest === null) {
        dest = "fbd_" + b.id;
        warn(warnings, "unsupported", ctx.rungNumber, op + " has no tag destination; used " + dest);
      }
      b.operand = String(dest);
      ctx.blocks.push(b);
      for (let i = 0; i < args.length; i++) {
        if (i === destIdx) continue;
        const a = args[i];
        if (a === undefined || a === "?" || a === "") continue;
        wire({ id: makeIref(a).id }, undefined, b, "In" + (i + 1));
      }
    }
    function processSeries(items, cond) {
      let acc = cond || null;
      for (const item of items) {
        if (item.kind === "series" || item.kind === "parallel") {
          if (branchHasOutputs(item)) {
            if (item.kind === "parallel") {
              for (const leg of item.legs) processSeries(leg.items, acc);
            } else {
              processSeries(item.items, acc);
            }
          } else {
            const r = condForBranch(item);
            acc = r === null ? acc : andRefs(acc, r);
          }
        } else if (item.op !== undefined) {
          if (COND_INSTR[item.op]) {
            const r = condInstrRef(item);
            acc = r === null ? acc : andRefs(acc, r);
          } else {
            emitOutput(item, acc);
          }
        }
      }
      return acc;
    }

    for (const rung of ladIR.rungs || []) {
      ctx.rungNumber = rung.number;
      const firstBlockIdx = sheet.blocks.length;
      const root = rung.root || makeSeries([]);
      if (root.kind === "parallel") {
        for (const leg of root.legs || []) processSeries(leg.items || [], null);
      } else {
        processSeries(root.items || [], null);
      }
      if (rung.comment) {
        const firstBlock = sheet.blocks[firstBlockIdx];
        if (firstBlock) {
          const tb = { id: newId(), x: 0, y: 0, width: "0", text: String(rung.comment) };
          sheet.textBoxes.push(tb);
          sheet.attachments.push({ from: tb.id, to: firstBlock.id });
        }
      }
    }
    autoLayoutSheet(sheet);
    return {
      ir: { kind: "fbd", sheets: [sheet], sheetSize: "Letter (8.5x11in)", sheetOrientation: "Landscape" },
      warnings: warnings
    };
  }

  /* Auto-place blocks: x increases with dataflow depth (left->right), y spreads. */
  function autoLayoutSheet(sheet) {
    const blocks = sheet.blocks || [];
    const wires = sheet.wires || [];
    const depth = {};
    blocks.forEach(function (b) { depth[String(b.id)] = 0; });
    const incoming = {};
    for (const w of wires) {
      const k = String(w.to.id);
      (incoming[k] = incoming[k] || []).push(String(w.from.id));
    }
    for (let iter = 0; iter < blocks.length + 1; iter++) {
      let changed = false;
      for (const b of blocks) {
        const id = String(b.id);
        const srcs = incoming[id] || [];
        for (const s of srcs) {
          if (depth[s] !== undefined && depth[id] < depth[s] + 1) { depth[id] = depth[s] + 1; changed = true; }
        }
      }
      if (!changed) break;
    }
    const groups = {};
    blocks.forEach(function (b) { const d = depth[String(b.id)]; (groups[d] = groups[d] || []).push(b); });
    const keys = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    const DX = 280, DY = 150;
    keys.forEach(function (d) {
      groups[d].forEach(function (b, i) { b.x = 40 + d * DX; b.y = 40 + i * DY; });
    });
    /* text boxes hover above their attached block */
    const byId = {};
    blocks.forEach(function (b) { byId[String(b.id)] = b; });
    for (const tb of sheet.textBoxes || []) {
      tb.x = 40;
      tb.y = 10;
    }
    for (const a of sheet.attachments || []) {
      const target = byId[String(a.to)];
      if (target) {
        const tbx = (sheet.textBoxes || []).filter(function (t) { return String(t.id) === String(a.from); })[0];
        if (tbx) { tbx.x = target.x; tbx.y = Math.max(10, target.y - 34); }
      }
    }
    return sheet;
  }

  /* ============================================================================
   * FBD -> LAD
   * ========================================================================== */
  function fbdToLad(fbdIR) {
    const warnings = [];
    const rungs = [];
    let rungNo = 0;
    function addRung(items, comment) {
      rungs.push({ number: rungNo++, type: "N", comment: comment !== undefined ? comment : null,
        root: makeSeries(items) });
      return rungs[rungs.length - 1];
    }
    function addWarning(kind, msg) { warn(warnings, kind, rungNo, msg); }

    for (let si = 0; si < (fbdIR.sheets || []).length; si++) {
      convertSheet(fbdIR.sheets[si], si);
    }

    function convertSheet(sheet, si) {
      const blocks = sheet.blocks || [];
      const wires = sheet.wires || [];
      const byId = {};
      blocks.forEach(function (b) { byId[String(b.id)] = b; });
      const wireIn = {};
      const wireOut = {};
      for (const w of wires) {
        const ki = String(w.to.id) + "|" + (w.to.param !== undefined ? w.to.param : "");
        wireIn[ki] = w;
        const ko = String(w.from.id) + "|" + (w.from.param !== undefined ? w.from.param : "");
        (wireOut[ko] = wireOut[ko] || []).push(w);
      }
      const commentFor = {};
      const tbById = {};
      (sheet.textBoxes || []).forEach(function (tb) { tbById[String(tb.id)] = tb; });
      (sheet.attachments || []).forEach(function (a) {
        const tb = tbById[String(a.from)];
        if (tb) commentFor[String(a.to)] = tb.text;
      });

      /* cycle detection (Kahn) - only warns, never drops */
      const indeg = {};
      blocks.forEach(function (b) { indeg[String(b.id)] = 0; });
      const outWiresById = {};
      for (const w of wires) {
        const f = String(w.from.id), t = String(w.to.id);
        (outWiresById[f] = outWiresById[f] || []).push(w);
        if (byId[f] && byId[t]) indeg[t]++;
      }
      const queue = blocks.filter(function (b) { return indeg[String(b.id)] === 0; });
      let seen = 0;
      while (queue.length) {
        const b = queue.shift();
        seen++;
        for (const w of outWiresById[String(b.id)] || []) {
          const t = String(w.to.id);
          if (byId[t] && --indeg[t] === 0) queue.push(byId[t]);
        }
      }
      if (seen < blocks.length) {
        addWarning("unsupported", "cycle detected in sheet " + (si + 1) + "; execution order approximated by position");
      }

      /* execution order: sort by X then Y */
      const sorted = blocks.slice().sort(function (a, b) {
        return (a.x - b.x) || (a.y - b.y);
      });
      const emittedBlocks = new Set();
      const handledOrefs = new Set();
      const handledGates = new Set();
      const pendingMovs = [];

      /* resolve an operand text for an input pin; "?" when unwired */
      function resolveArg(id, pin) {
        const w = wireIn[String(id) + "|" + pin];
        if (!w) return "?";
        return resolveOperandRef(w.from, 0);
      }
      function resolveOperandRef(ref, depth) {
        if (depth > 20) return "?";
        const b = byId[String(ref.id)];
        if (!b) return "?";
        if (b.kind === "iref") return b.operand !== undefined ? b.operand : "?";
        if (b.kind === "block" || b.kind === "function") {
          if (b.operand !== undefined) {
            if (ref.param && ref.param !== "Out" && ref.param !== "Dest" && ref.param !== "Destination") {
              return b.operand + "." + ref.param;
            }
            return b.operand;
          }
          return "?";
        }
        if (b.kind === "icon") {
          /* input connector: continue from the matching output connector (same sheet) */
          const ocon = blocks.filter(function (x) { return x.kind === "ocon" && x.name === b.name; })[0];
          if (!ocon) { addWarning("unsupported", "wire connector " + (b.name || "?") + " not resolved (cross-sheet)"); return b.name || "?"; }
          const w = wireIn[String(ocon.id) + "|"];
          return w ? resolveOperandRef(w.from, depth + 1) : "?";
        }
        if (b.kind === "ocon") {
          const w = wireIn[String(b.id) + "|"];
          return w ? resolveOperandRef(w.from, depth + 1) : "?";
        }
        return "?";
      }

      /* boolean branch for a source pin; returns array of instr/branch items (empty = always true) */
      function resolveBoolWire(w, depth) {
        if (!w) return [];
        return resolveBoolFrom(w.from, (depth || 0) + 1);
      }
      function negateItems(items) {
        /* De Morgan complement of a condition list (NOT gate). */
        if (items.length === 0) return [makeInstr("AFI")]; // NOT true = false
        if (items.length === 1 && items[0].op !== undefined) {
          if (items[0].op === "XIC") return [makeInstr("XIO", items[0].args[0])];
          if (items[0].op === "XIO") return [makeInstr("XIC", items[0].args[0])];
          if (items[0].op === "AFI") return [];
          addWarning("unsupported", "negation of " + items[0].op + " approximated (kept as-is)");
          return [items[0]];
        }
        if (items.length === 1 && (items[0].kind === "series" || items[0].kind === "parallel")) {
          if (items[0].kind === "series") {
            const legs = items[0].items.map(function (it) {
              const n = negateItems([it]);
              if (n.length === 0) return null;
              return n.length === 1 && n[0].kind ? n[0] : makeSeries(n);
            }).filter(Boolean);
            if (!legs.length) return [];
            return [makeParallel(legs)];
          }
          const parts = [];
          for (const leg of items[0].legs) {
            const n = negateItems(leg.items);
            if (n.length) parts.push(n.length === 1 && n[0].kind ? n[0] : makeSeries(n));
          }
          return parts.length ? [makeSeries(parts)] : [];
        }
        /* mixed list: AND of items -> negate whole list as parallel of negated items */
        const legs = items.map(function (it) {
          const n = negateItems([it]);
          if (n.length === 0) return null;
          return n.length === 1 && n[0].kind ? n[0] : makeSeries(n);
        }).filter(Boolean);
        if (!legs.length) return [];
        return [makeParallel(legs)];
      }
      function resolveBoolFrom(ref, depth) {
        if (depth > 40) return [];
        const b = byId[String(ref.id)];
        if (!b) return [];
        if (b.kind === "iref") {
          const op = b.operand !== undefined ? b.operand : "?";
          if (op === "FALSE" || op === "0") return [makeInstr("AFI")];
          if (op === "TRUE" || op === "1") return [];
          return [makeInstr("XIC", op)];
        }
        if (b.kind === "icon") {
          const ocon = blocks.filter(function (x) { return x.kind === "ocon" && x.name === b.name; })[0];
          if (!ocon) { addWarning("unsupported", "wire connector " + (b.name || "?") + " not resolved (cross-sheet)"); return [makeInstr("XIC", b.name || "?")]; }
          const w = wireIn[String(ocon.id) + "|"];
          return w ? resolveBoolWire(w, depth + 1) : [];
        }
        if (b.kind === "ocon") {
          const w = wireIn[String(b.id) + "|"];
          return w ? resolveBoolWire(w, depth + 1) : [];
        }
        if (b.kind === "block" || b.kind === "function") {
          const stype = (b.type || "").toUpperCase();
          if (GATE_TYPES[stype] && b.operand === undefined) {
            if (stype === "NOT") {
              const cw = wireIn[String(b.id) + "|In"];
              const inner = cw ? resolveBoolWire(cw, depth + 1) : [];
              return negateItems(inner);
            }
            if (stype === "AND") {
              const a = wireIn[String(b.id) + "|In1"];
              const c = wireIn[String(b.id) + "|In2"];
              const la = a ? resolveBoolWire(a, depth + 1) : [];
              const lc = c ? resolveBoolWire(c, depth + 1) : [];
              return la.concat(lc);
            }
            if (stype === "OR") {
              const a = wireIn[String(b.id) + "|In1"];
              const c = wireIn[String(b.id) + "|In2"];
              const la = a ? resolveBoolWire(a, depth + 1) : [];
              const lc = c ? resolveBoolWire(c, depth + 1) : [];
              if (!la.length || !lc.length) return []; // one leg always true
              const mk = function (items) {
                return items.length === 1 && items[0].kind ? items[0] : makeSeries(items);
              };
              return [makeParallel([mk(la), mk(lc)])];
            }
            if (stype === "XOR") {
              const a = wireIn[String(b.id) + "|In1"];
              const c = wireIn[String(b.id) + "|In2"];
              const la = a ? resolveBoolWire(a, depth + 1) : [];
              const lc = c ? resolveBoolWire(c, depth + 1) : [];
              const na = negateItems(la), nc = negateItems(lc);
              const mk = function (items) {
                return items.length === 1 && items[0].kind ? items[0] : makeSeries(items);
              };
              /* XOR: (a AND NOT c) OR (NOT a AND c) */
              const legA = la.length && nc.length ? mk(la.concat(nc)) : null;
              const legB = lc.length && na.length ? mk(na.concat(lc)) : null;
              const legs = [legA, legB].filter(Boolean);
              if (!legs.length) return [makeInstr("AFI")];
              return [makeParallel(legs)];
            }
          }
          if (CMP_TYPES[stype] && b.operand === undefined) {
            const n = CMP_TYPES[stype];
            const args = [];
            for (let i = 0; i < n; i++) args.push(resolveArg(String(b.id), "In" + (i + 1)));
            return [makeInstr(stype, args)];
          }
          if (b.operand !== undefined) {
            if (ref.param && ref.param !== "Out" && ref.param !== "Dest" && ref.param !== "Destination") {
              return [makeInstr("XIC", b.operand + "." + ref.param)];
            }
            return [makeInstr("XIC", b.operand)];
          }
          addWarning("unsupported", "block " + (b.type || "?") + " used as boolean condition; AFI used");
          return [makeInstr("AFI")];
        }
        return [];
      }

      /* ---- pass 1: instructions (data blocks, timers, JSR/SBR/RET) ---- */
      for (const b of sorted) {
        const id = String(b.id);
        if (b.kind === "jsr") {
          const args = [b.routine !== undefined ? b.routine : "?", "0"].concat(b.in || []);
          const condItems = [];
          const ew = wireIn[id + "|EnableIn"];
          if (ew) {
            const items = resolveBoolWire(ew, 0);
            condItems.push.apply(condItems, items);
          }
          addRung(condItems.concat([makeInstr("JSR", args)]), commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        if (b.kind === "sbr") {
          const args = (b.ret || []).length ? b.ret : (b.in || []);
          addRung([makeInstr("SBR", args)], commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        if (b.kind === "ret") {
          const args = (b.in || []).length ? b.in : (b.ret || []);
          addRung([makeInstr("RET", args)], commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        if (b.kind !== "block" && b.kind !== "function") continue;
        const type = (b.type || "").toUpperCase();
        if (GATE_TYPES[type] && b.operand === undefined) continue; // gates handled with OREFs
        if (CMP_TYPES[type] && b.operand === undefined) continue;  // comparison condition blocks
        const m = FBD_TO_LAD[type];
        if (!m) {
          addWarning("unsupported", "unknown FBD block type " + type + "; emitted as instruction");
          const pinArgs = (b.visiblePins || []).filter(function (p) { return p !== "Out"; })
            .map(function (p) { return resolveArg(id, p); });
          if (b.operand !== undefined) pinArgs.push(b.operand);
          addRung([makeInstr(type, pinArgs)], commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        if (type === "RES") {
          addRung([makeInstr("RES", b.operand !== undefined ? b.operand : "?")], commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        if (m.enablePin) {
          const condItems = [];
          const ew = wireIn[id + "|" + m.enablePin];
          if (ew) {
            const items = resolveBoolWire(ew, 0);
            condItems.push.apply(condItems, items);
          }
          const args = [b.operand !== undefined ? b.operand : "?"];
          for (const p of m.pins) args.push(resolveArg(id, p));
          addRung(condItems.concat([makeInstr(type, args)]), commentFor[id]);
          emittedBlocks.add(id);
          continue;
        }
        /* plain data block */
        const args = m.pins.map(function (p) { return resolveArg(id, p); });
        const operandArg = b.operand !== undefined ? b.operand : "?";
        if (m.insertAt !== undefined) args.splice(m.insertAt, 0, operandArg);
        else if (!m.operandFirst) args.push(operandArg);
        else args.unshift(operandArg);
        const condItems = [];
        /* AND-gate enable pattern: AND(In1=cond, In2=block.Out) -> OREF */
        for (const w of wireOut[id + "|Out"] || []) {
          const t = byId[String(w.to.id)];
          if (!t || t.kind !== "block" || (t.type || "").toUpperCase() !== "AND" || t.operand !== undefined) continue;
          handledGates.add(String(t.id));
          const otherPin = w.to.param === "In1" ? "In2" : "In1";
          const ow = wireIn[String(t.id) + "|" + otherPin];
          if (ow) {
            const items = resolveBoolWire(ow, 0);
            condItems.push.apply(condItems, items);
          } else {
            addWarning("unsupported", "AND gate enable input missing; block left unconditional");
          }
          for (const go of wireOut[String(t.id) + "|Out"] || []) {
            const tgt = byId[String(go.to.id)];
            if (tgt && tgt.kind === "oref") {
              handledOrefs.add(String(tgt.id));
              if (tgt.operand !== b.operand) {
                pendingMovs.push({ src: b.operand !== undefined ? b.operand : "?", dst: tgt.operand || "?", comment: commentFor[String(t.id)] });
              }
            }
          }
        }
        addRung(condItems.concat([makeInstr(type, args)]), commentFor[id]);
        emittedBlocks.add(id);
      }
      for (const mv of pendingMovs) {
        addRung([makeInstr("MOV", mv.src, mv.dst)], mv.comment);
        addWarning("unsupported", "enable semantics on MOV " + mv.src + " -> " + mv.dst + " approximated");
      }

      /* ---- pass 2: OREFs -> boolean rungs ---- */
      for (const b of sorted) {
        if (b.kind !== "oref") continue;
        const id = String(b.id);
        if (handledOrefs.has(id)) continue;
        const operand = b.operand !== undefined ? b.operand : "?";
        const w = wireIn[id + "|"];
        if (!w) {
          addWarning("unsupported", "OREF " + operand + " has no source wire; NOP rung emitted");
          addRung([makeInstr("NOP")], "OREF " + operand + " has no source wire");
          continue;
        }
        const src = byId[String(w.from.id)];
        const param = w.from.param;
        if (src && (src.kind === "block" || src.kind === "function")) {
          const stype = (src.type || "").toUpperCase();
          if (GATE_TYPES[stype] && src.operand === undefined) {
            const items = resolveBoolWire(w, 0);
            addRung(items.concat([makeInstr("OTE", operand)]), commentFor[String(w.from.id)]);
            continue;
          }
          if (CMP_TYPES[stype] && src.operand === undefined) {
            const n = CMP_TYPES[stype];
            const args = [];
            for (let i = 0; i < n; i++) args.push(resolveArg(String(src.id), "In" + (i + 1)));
            addRung([makeInstr(stype, args), makeInstr("OTE", operand)], commentFor[String(src.id)]);
            continue;
          }
          if (src.operand !== undefined && (param === undefined || param === "Out" || param === "Dest" || param === "Destination")) {
            if (src.operand === operand && emittedBlocks.has(String(src.id))) continue;
            addRung([makeInstr("MOV", src.operand, operand)], commentFor[String(src.id)]);
            continue;
          }
          if (src.operand !== undefined && param) {
            addRung([makeInstr("XIC", src.operand + "." + param), makeInstr("OTE", operand)], commentFor[String(src.id)]);
            continue;
          }
          addWarning("unsupported", "OREF " + operand + " sourced from unpinned block " + (src.type || "?") + "; NOP rung emitted");
          addRung([makeInstr("NOP")], "OREF " + operand + " source unresolved");
          continue;
        }
        const items = resolveBoolWire(w, 0);
        addRung(items.concat([makeInstr("OTE", operand)]), commentFor[String(w.from.id)]);
      }
    }

    return { ir: { kind: "lad", rungs: rungs }, warnings: warnings };
  }

  /* ============================================================================
   * FBD <-> ST (composed through LAD; local fallback while T1 is in flight)
   * ========================================================================== */
  function fbdToSt(fbdIR) {
    const lad = fbdToLad(fbdIR);
    const r = callReady(lang.ladToSt, [lad.ir]);
    if (r && r.ir) return { ir: r.ir, warnings: lad.warnings.concat(r.warnings || []) };
    const fb = fallbackLadToSt(lad.ir);
    return { ir: fb.ir, warnings: lad.warnings.concat(fb.warnings) };
  }
  function stToFbd(stIR) {
    const r = callReady(lang.stToLad, [stIR]);
    const lad = r && r.ir ? r : fallbackStToLad(stIR);
    const fbd = ladToFbd(lad.ir);
    return { ir: fbd.ir, warnings: (lad.warnings || []).concat(fbd.warnings) };
  }

  /* ---------- minimal fallback: LAD -> ST ---------- */
  function fallbackLadToSt(ladIR) {
    const warnings = [];
    const statements = [];
    function mkExpr(a) { return isLiteralText(a) ? { kind: "literal", value: a } : { kind: "ref", path: a }; }
    function andE(a, b) {
      if (a === null || a === undefined) return b === undefined ? null : b;
      if (b === null || b === undefined) return a;
      return { kind: "binary", op: "AND", left: a, right: b };
    }
    function instrExpr(item) {
      if (item.op === "XIC") return { kind: "ref", path: item.args[0] };
      if (item.op === "XIO") return { kind: "unary", op: "NOT", operand: { kind: "ref", path: item.args[0] } };
      if (item.op === "AFI") return { kind: "literal", value: "FALSE" };
      if (item.op === "NOP") return null;
      if (CMP_TYPES[item.op]) {
        if (item.op === "EQU") return { kind: "binary", op: "=", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        if (item.op === "NEQ") return { kind: "binary", op: "<>", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        if (item.op === "GRT") return { kind: "binary", op: ">", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        if (item.op === "GEQ") return { kind: "binary", op: ">=", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        if (item.op === "LES") return { kind: "binary", op: "<", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        if (item.op === "LEQ") return { kind: "binary", op: "<=", left: mkExpr(item.args[0]), right: mkExpr(item.args[1]) };
        warnings.push({ kind: "unsupported", rung: null, msg: item.op + " fallback conversion approximated" });
        return { kind: "literal", value: "TRUE" };
      }
      return null;
    }
    function branchExpr(items) {
      let expr = null;
      for (const item of items) {
        if (item.op !== undefined) expr = andE(expr, instrExpr(item));
        else if (item.kind === "series") expr = andE(expr, branchExpr(item.items));
        else if (item.kind === "parallel") {
          const legs = item.legs.map(function (l) { return branchExpr(l.items); });
          let e = null;
          for (const l of legs) {
            if (l === null || l === undefined) { e = null; break; }
            e = e === null ? l : { kind: "binary", op: "OR", left: e, right: l };
          }
          expr = andE(expr, e);
        }
      }
      return expr;
    }
    function stmtFor(instr, cond) {
      const op = instr.op, args = instr.args || [];
      const ref = function (a) { return { kind: "ref", path: a }; };
      const guard = function (s) {
        if (cond === null || cond === undefined) { statements.push(s); }
        else statements.push({ kind: "if", branches: [{ cond: cond, statements: [s] }] });
      };
      if (op === "OTE") {
        statements.push({ kind: "assign", target: args[0], value: cond === null ? { kind: "literal", value: "1" } : cond });
      } else if (op === "OTL") {
        statements.push({
          kind: "assign", target: args[0],
          value: cond === null ? { kind: "literal", value: "1" } : { kind: "binary", op: "OR", left: ref(args[0]), right: cond }
        });
      } else if (op === "OTU") {
        statements.push({
          kind: "assign", target: args[0],
          value: cond === null ? { kind: "literal", value: "0" } : { kind: "binary", op: "AND", left: ref(args[0]), right: { kind: "unary", op: "NOT", operand: cond } }
        });
      } else if (op === "MOV") {
        statements.push({ kind: "assign", target: args[1], value: mkExpr(args[0]) });
      } else if (op === "ADD" || op === "SUB" || op === "MUL" || op === "DIV" || op === "MOD") {
        const sym = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "MOD" }[op];
        statements.push({ kind: "assign", target: args[2], value: { kind: "binary", op: sym, left: mkExpr(args[0]), right: mkExpr(args[1]) } });
      } else if (op === "NEG" || op === "ABS" || op === "SQR" || op === "SQRT") {
        const fn = { NEG: "-", ABS: "ABS", SQR: "SQR", SQRT: "SQRT" }[op];
        const v = fn === "-" ? { kind: "unary", op: "-", operand: mkExpr(args[0]) } : { kind: "call", fn: fn, args: [mkExpr(args[0])] };
        statements.push({ kind: "assign", target: args[1], value: v });
      } else if (op === "TON" || op === "TOF" || op === "RTO" || op === "TONR" || op === "CTU" || op === "CTD" || op === "RES" || op === "SBR" || op === "RET" || op === "JSR") {
        guard({ kind: "call", fn: op, args: args.map(mkExpr) });
      } else {
        warnings.push({ kind: "unsupported", rung: null, msg: op + " emitted as fallback call" });
        guard({ kind: "call", fn: op, args: args.map(mkExpr) });
      }
    }
    function walkSeries(items, condExpr) {
      let cond = condExpr || null;
      let outs = [];
      const flush = function () {
        if (outs.length) {
          for (const o of outs) stmtFor(o, cond);
          outs = [];
        }
      };
      for (const item of items || []) {
        if (item.op !== undefined) {
          if (COND_INSTR[item.op]) { flush(); cond = andE(cond, instrExpr(item)); }
          else outs.push(item);
        } else if (item.kind === "parallel") {
          flush();
          for (const leg of item.legs) walkSeries(leg.items, cond);
        } else if (item.kind === "series") {
          flush();
          cond = andE(cond, branchExpr(item.items));
        }
      }
      flush();
    }
    for (const rung of ladIR.rungs || []) {
      if (rung.comment) statements.push({ kind: "comment", text: rung.comment });
      const root = rung.root || makeSeries([]);
      if (root.kind === "parallel") {
        for (const leg of root.legs || []) walkSeries(leg.items, null);
      } else {
        walkSeries(root.items, null);
      }
    }
    return { ir: { kind: "st", statements: statements }, warnings: warnings };
  }

  /* ---------- minimal fallback: ST -> LAD ---------- */
  function fallbackStToLad(stIR) {
    const warnings = [];
    const rungs = [];
    let rungNo = 0;
    let labelCounter = 0;
    function exprToBranch(expr) {
      if (!expr) return makeSeries([]);
      if (expr.kind === "ref") return makeSeries([makeInstr("XIC", expr.path)]);
      if (expr.kind === "literal") {
        if (/^(TRUE|1)$/i.test(String(expr.value))) return makeSeries([]);
        if (/^(FALSE|0)$/i.test(String(expr.value))) return makeSeries([makeInstr("AFI")]);
        warnings.push({ kind: "unsupported", rung: rungNo, msg: "literal condition " + expr.value + " treated as FALSE" });
        return makeSeries([makeInstr("AFI")]);
      }
      if (expr.kind === "unary" && expr.op === "NOT") {
        const inner = exprToBranch(expr.operand);
        return negateBranch(inner);
      }
      if (expr.kind === "paren") return exprToBranch(expr.inner);
      if (expr.kind === "binary" && expr.op === "AND") {
        const a = exprToBranch(expr.left), b = exprToBranch(expr.right);
        return makeSeries(a.items.concat(b.items));
      }
      if (expr.kind === "binary" && expr.op === "OR") {
        const a = exprToBranch(expr.left), b = exprToBranch(expr.right);
        return makeParallel([a, b]);
      }
      warnings.push({ kind: "unsupported", rung: rungNo, msg: "condition expression kind " + expr.kind + " approximated; CPT used" });
      return makeSeries([makeInstr("XIC", "?")]);
    }
    function negateBranch(branch) {
      /* De Morgan complement of a branch tree */
      if (branch.kind === "series") {
        const legs = branch.items.map(function (it) {
          return negateBranch(it.kind ? it : makeSeries([it]));
        });
        return makeParallel(legs);
      }
      if (branch.kind === "parallel") {
        const items = [];
        for (const leg of branch.legs) {
          const n = negateBranch(leg);
          items.push.apply(items, n.items);
        }
        return makeSeries(items);
      }
      /* single instruction: swap XIC/XIO; AFI (never true) becomes always true */
      if (branch.op === "XIC") return makeSeries([makeInstr("XIO", branch.args[0])]);
      if (branch.op === "XIO") return makeSeries([makeInstr("XIC", branch.args[0])]);
      if (branch.op === "AFI") return makeSeries([]);
      return makeSeries([branch]);
    }
    function assignRung(target, value, cond) {
      /* boolean expression -> branch + OTE */
      const isBool = function (e) {
        if (!e) return false;
        if (e.kind === "ref" || (e.kind === "literal" && /^(TRUE|FALSE)$/i.test(String(e.value)))) return true;
        if (e.kind === "unary" && e.op === "NOT") return isBool(e.operand);
        if (e.kind === "paren") return isBool(e.inner);
        if (e.kind === "binary" && (e.op === "AND" || e.op === "OR")) return isBool(e.left) && isBool(e.right);
        return false;
      };
      if (isBool(value)) {
        const items = cond.items.concat(exprToBranch(value).items);
        rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries(items.concat([makeInstr("OTE", target)])) });
        return;
      }
      if (value && value.kind === "binary" && ["+", "-", "*", "/", "MOD"].indexOf(value.op) !== -1) {
        const opMap = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "MOD": "MOD" };
        const asArg = function (e) { return e.kind === "ref" ? e.path : e.kind === "literal" ? e.value : "?"; };
        const items = cond.items.concat([makeInstr(opMap[value.op], asArg(value.left), asArg(value.right), target)]);
        rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries(items) });
        return;
      }
      /* fallback: CPT */
      const exprText = exprToText(value);
      const items = cond.items.concat([makeInstr("CPT", target, exprText)]);
      rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries(items) });
    }
    function exprToText(e) {
      if (!e) return "TRUE";
      if (e.kind === "ref") return e.path;
      if (e.kind === "literal") return String(e.value);
      if (e.kind === "unary") return e.op + " " + exprToText(e.operand);
      if (e.kind === "paren") return "(" + exprToText(e.inner) + ")";
      if (e.kind === "binary") return exprToText(e.left) + " " + e.op + " " + exprToText(e.right);
      if (e.kind === "call") return e.fn + "(" + e.args.map(exprToText).join(",") + ")";
      return "?";
    }
    function emitStatement(stmt, cond) {
      cond = cond || makeSeries([]);
      if (stmt.kind === "assign") { assignRung(stmt.target, stmt.value, cond); return; }
      if (stmt.kind === "call") {
        const args = stmt.args.map(function (a) { return a.kind === "literal" ? String(a.value) : a.kind === "ref" ? a.path : "?"; });
        const items = cond.items.concat([makeInstr(stmt.fn, args)]);
        rungs.push({ number: rungNo++, type: "N", comment: stmt.comment || null, root: makeSeries(items) });
        return;
      }
      if (stmt.kind === "if") {
        let prevCond = null;
        for (let i = 0; i < stmt.branches.length; i++) {
          const br = stmt.branches[i];
          let branchCond;
          if (br.cond) {
            const base = exprToBranch(br.cond);
            branchCond = i === 0 ? base : makeSeries(base.items.concat(negateBranch(prevCond).items));
            prevCond = base;
          } else {
            const negs = stmt.branches.filter(function (x) { return x.cond; }).map(function (x) { return exprToBranch(x.cond); });
            let acc = null;
            for (const n of negs) {
              const nn = negateBranch(n);
              acc = acc === null ? nn : makeSeries(acc.items.concat(nn.items));
            }
            branchCond = acc || makeSeries([]);
          }
          for (const s of br.statements) emitStatement(s, branchCond);
        }
        return;
      }
      if (stmt.kind === "comment") {
        const r = { number: rungNo++, type: "N", comment: stmt.text, root: makeSeries([makeInstr("NOP")]) };
        rungs.push(r);
        return;
      }
      if (stmt.kind === "empty" || stmt.kind === "exit" || stmt.kind === "return") {
        const op = stmt.kind === "return" ? "RET" : "NOP";
        rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries([makeInstr(op)]) });
        return;
      }
      if (stmt.kind === "for" || stmt.kind === "while" || stmt.kind === "repeat") {
        const label = "L" + (labelCounter++);
        const from = exprToText(stmt.from), to = exprToText(stmt.to);
        rungs.push({ number: rungNo++, type: "N", comment: stmt.comment || null,
          root: makeSeries([makeInstr("FOR", label, stmt.index, from, to, stmt.by ? exprToText(stmt.by) : "1")]) });
        for (const s of stmt.statements) emitStatement(s, null);
        rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries([makeInstr("NXT", label)]) });
        warnings.push({ kind: "unsupported", rung: rungNo, msg: stmt.kind + " loop emitted as FOR/NXT ladder" });
        return;
      }
      warnings.push({ kind: "unsupported", rung: rungNo, msg: "statement kind " + stmt.kind + " emitted as NOP" });
      rungs.push({ number: rungNo++, type: "N", comment: null, root: makeSeries([makeInstr("NOP")]) });
    }
    let pendingComment = null;
    for (const stmt of stIR.statements || []) {
      if (stmt.kind === "comment") { pendingComment = stmt.text; continue; }
      emitStatement(stmt, null);
      if (pendingComment !== null && rungs.length) { rungs[rungs.length - 1].comment = pendingComment; pendingComment = null; }
    }
    if (pendingComment !== null) {
      rungs.push({ number: rungNo++, type: "N", comment: pendingComment, root: makeSeries([makeInstr("NOP")]) });
    }
    return { ir: { kind: "lad", rungs: rungs }, warnings: warnings };
  }

  /* ============================================================================
   * FBD dataflow graph (same shape as dataflow.js)
   * ========================================================================== */
  function buildFbdDataflow(fbdIR, opts) {
    opts = opts || {};
    const simplify = opts.simplify !== false;
    const nodes = [];
    const edges = [];
    const seen = new Set();
    let si = 0;
    for (const sheet of fbdIR.sheets || []) {
      const byId = {};
      (sheet.blocks || []).forEach(function (b) { byId[String(b.id)] = b; });
      const nodeFor = {};
      (sheet.blocks || []).forEach(function (b) {
        const id = String(b.id);
        let node = null;
        if (b.kind === "iref") {
          const key = simplify ? "iref|" + (b.operand || "") : "iref|s" + si + "|" + id;
          node = { id: key, label: b.operand !== undefined ? b.operand : "IREF", kind: "tag-read", tag: b.operand };
        } else if (b.kind === "oref") {
          const key = simplify ? "oref|" + (b.operand || "") : "oref|s" + si + "|" + id;
          node = { id: key, label: b.operand !== undefined ? b.operand : "OREF", kind: "tag-write", tag: b.operand };
        } else if (b.kind === "block" || b.kind === "function") {
          const isGate = GATE_TYPES[(b.type || "").toUpperCase()] && b.operand === undefined;
          node = { id: "blk|s" + si + "|" + id,
            label: (b.type || "?") + (b.operand !== undefined ? " " + b.operand : ""),
            kind: isGate ? "logic" : "func", op: b.type, tag: b.operand };
        } else if (b.kind === "jsr" || b.kind === "sbr" || b.kind === "ret") {
          node = { id: "blk|s" + si + "|" + id, label: (b.kind || "").toUpperCase() + (b.routine ? " " + b.routine : ""),
            kind: "func", op: b.kind.toUpperCase() };
        } else if (b.kind === "icon" || b.kind === "ocon") {
          node = { id: "blk|s" + si + "|" + id, label: b.name !== undefined ? b.name : (b.kind || "").toUpperCase(), kind: "ref" };
        }
        if (node) {
          nodeFor[id] = node.id;
          if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); }
        }
      });
      for (const w of sheet.wires || []) {
        const a = nodeFor[String(w.from.id)], b = nodeFor[String(w.to.id)];
        if (a === undefined || b === undefined || !byId[String(w.from.id)] || !byId[String(w.to.id)]) continue;
        edges.push({ from: a, to: b, kind: "data" });
      }
      si++;
    }
    return { nodes: nodes, edges: edges };
  }

  return { fbdToLad: fbdToLad, ladToFbd: ladToFbd, fbdToSt: fbdToSt, stToFbd: stToFbd,
    buildFbdDataflow: buildFbdDataflow };
});
