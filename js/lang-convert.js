/* L5X Studio - lang-convert.js (T1). LAD <-> ST conversion. See CONTRACT section 4.
   Lossless LAD->ST->LAD: ladToSt tags statements with non-enumerable provenance
   metadata (_ladGroup / _ladSeg / _ladInstr / _ladRungText / _ladFor / _ladNxt);
   stToLad consumes it to reconstruct the original rung grouping exactly.
   Metadata is invisible to JSON/serialization, so parsed ST text (no metadata)
   goes through the honest structural mapping instead. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;
  const OPR = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
  const STP = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;
  const RLLP = (typeof module !== "undefined" && module.exports) ? require("./rll-parse.js") : root.L5XStudio;
  const RLLS = (typeof module !== "undefined" && module.exports) ? require("./rll-serialize.js") : root.L5XStudio;

  const SEM = IR.LAD_OP_SEMANTICS;

  function setMeta(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value: value, enumerable: false, writable: true, configurable: true });
    } catch (e) { /* frozen object: ignore */ }
  }
  function getMeta(obj, key) { return obj ? obj[key] : undefined; }

  function warn(warnings, kind, rung, msg) {
    warnings.push({ kind: kind, rung: rung, msg: msg });
  }

  /* ----------------------------------------------------------- helpers */

  function operandToExpr(text) {
    text = String(text);
    if (text === "?") return IR.makeRef("?");
    // string literals (including $ escapes which operands.STR_RE does not cover)
    if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") return IR.makeLiteral(text);
    if (OPR.isLiteral(text)) return IR.makeLiteral(text);
    return IR.makeRef(text);
  }

  function operandText(expr) {
    if (!expr) return "?";
    if (expr.kind === "ref") return expr.path;
    if (expr.kind === "literal") return expr.value;
    if (expr.kind === "paren") return operandText(expr.inner);
    return IR.exprToString(expr, 0);
  }

  function foldAnd(list) {
    if (!list || list.length === 0) return null;
    let e = list[0];
    for (let i = 1; i < list.length; i++) e = IR.makeBinary("AND", e, list[i]);
    return e;
  }

  function isFlatOperand(e) {
    if (!e) return false;
    if (e.kind === "paren") return isFlatOperand(e.inner);
    return e.kind === "ref" || e.kind === "literal";
  }

  function isConditionOp(op) {
    const sem = SEM[op];
    if (!sem) return false;
    return sem.role === "condition" || op === "NOP";
  }

  function hasOutputs(branch) {
    if (!branch) return false;
    if (branch.op) return !isConditionOp(branch.op);
    if (branch.kind === "parallel") return (branch.legs || []).some(hasOutputs);
    return (branch.items || []).some(it => {
      if (it.op) return !isConditionOp(it.op);
      return hasOutputs(it);
    });
  }

  /* ---- condition expr building (LAD condition instructions -> ST expr) ---- */

  const CMP_OP = { EQU: "=", NEQ: "<>", GRT: ">", GEQ: ">=", LES: "<", LEQ: "<=" };

  function condExprFor(instr, warnings, rung) {
    const op = instr.op, a = instr.args || [];
    switch (op) {
      case "XIC": return IR.makeRef(a[0]);
      case "XIO": return IR.makeUnary("NOT", IR.makeRef(a[0]));
      case "AFI": return IR.makeLiteral("FALSE");
      case "NOP": return null;
      case "EQU": case "NEQ": case "GRT": case "GEQ": case "LES": case "LEQ":
        return IR.makeBinary(CMP_OP[op], operandToExpr(a[0]), operandToExpr(a[1]));
      case "LIM":
        return IR.makeBinary("AND",
          IR.makeBinary(">=", operandToExpr(a[1]), operandToExpr(a[0])),
          IR.makeBinary("<=", operandToExpr(a[1]), operandToExpr(a[2])));
      case "MEQ":
        warn(warnings, "unsupported", rung, "MEQ in rung condition not supported; term dropped");
        return null;
      case "CMP":
        try { return STP.parseStExpression(a[0]); }
        catch (e) {
          warn(warnings, "unsupported", rung, "CMP expression not parseable: " + e.message);
          return null;
        }
      default:
        return null;
    }
  }

  /* OR-expr of a condition-only branch; null means "always TRUE". */
  function orExpr(branch, warnings, rung) {
    if (!branch) return null;
    if (branch.op) {
      const ce = condExprFor(branch, warnings, rung);
      return ce;
    }
    if (branch.kind === "parallel") {
      const terms = [];
      for (const leg of branch.legs || []) {
        const le = orExpr(leg, warnings, rung);
        if (le === null) return null; // empty leg => OR TRUE
        if (le) terms.push(le);
      }
      if (terms.length === 0) return null;
      let e = terms[0];
      for (let i = 1; i < terms.length; i++) e = IR.makeBinary("OR", e, terms[i]);
      return e;
    }
    let e = null;
    for (const it of branch.items || []) {
      if (it.op) {
        const ce = condExprFor(it, warnings, rung);
        if (ce) e = e ? IR.makeBinary("AND", e, ce) : ce;
      } else {
        const oe = orExpr(it, warnings, rung);
        if (oe) e = e ? IR.makeBinary("AND", e, oe) : e; // empty branch: AND TRUE
      }
    }
    return e;
  }

  /* ---- rung segmentation (exported for tests / round-trip normalization) ----
     cond: list of ST exprs (for the ST text); condItems: the ORIGINAL condition
     branch items (instrs and condition-only parallel nodes) verbatim, used for
     exact LAD reconstruction. */

  function processBranch(branch, condList, condItems, segs, warnings, rung) {
    if (!branch) return;
    if (branch.op) {
      if (isConditionOp(branch.op)) {
        const ce = condExprFor(branch, warnings, rung);
        if (ce) condList.push(ce);
        condItems.push(branch);
      } else {
        segs.push({ cond: condList.slice(), condItems: condItems.slice(), instr: branch });
      }
      return;
    }
    if (branch.kind === "parallel") {
      if (!hasOutputs(branch)) {
        const term = orExpr(branch, warnings, rung);
        if (term) condList.push(term);
        condItems.push(branch);
      } else {
        for (const leg of branch.legs || []) {
          if (!hasOutputs(leg)) {
            // condition-only leg inside an output-parallel: record it after the
            // previous segment so the reconstruction keeps the leg verbatim
            const lc = condList.slice();
            const li = condItems.slice();
            processBranch(leg, lc, li, [], warnings, rung);
            const rec = { cond: lc, condItems: li, instr: null };
            if (segs.length) {
              const last = segs[segs.length - 1];
              if (!last.condOnly) last.condOnly = [];
              last.condOnly.push(rec);
            } else {
              segs.push(Object.assign({ cond: condList.slice(), condItems: condItems.slice() },
                { instr: null, condOnly: [rec] }));
            }
            continue;
          }
          const lc = condList.slice();
          const li = condItems.slice();
          processBranch(leg, lc, li, segs, warnings, rung);
        }
      }
      return;
    }
    for (const it of branch.items || []) {
      if (it.op) {
        if (isConditionOp(it.op)) {
          const ce = condExprFor(it, warnings, rung);
          if (ce) condList.push(ce);
          condItems.push(it);
        } else {
          segs.push({ cond: condList.slice(), condItems: condItems.slice(), instr: it });
        }
      } else {
        if (!hasOutputs(it)) {
          const term = orExpr(it, warnings, rung);
          if (term) condList.push(term);
          condItems.push(it);
        } else {
          for (const leg of it.legs || []) {
            if (!hasOutputs(leg)) {
              const lc = condList.slice();
              const li = condItems.slice();
              processBranch(leg, lc, li, [], warnings, rung);
              const rec = { cond: lc, condItems: li, instr: null };
              if (segs.length) {
                const last = segs[segs.length - 1];
                if (!last.condOnly) last.condOnly = [];
                last.condOnly.push(rec);
              } else {
                segs.push(Object.assign({ cond: condList.slice(), condItems: condItems.slice() },
                  { instr: null, condOnly: [rec] }));
              }
              continue;
            }
            const lc = condList.slice();
            const li = condItems.slice();
            processBranch(leg, lc, li, segs, warnings, rung);
          }
        }
      }
    }
  }

  /* expand segments: fold attached condition-only records into the segment list */
  function expandSegments(segs) {
    const out = [];
    for (const s of segs) {
      out.push({ cond: foldAnd(s.cond), condItems: (s.condItems || []).slice(), instr: s.instr });
      for (const c of s.condOnly || []) {
        out.push({ cond: foldAnd(c.cond), condItems: (c.condItems || []).slice(), instr: null });
      }
    }
    return out;
  }

  /* Merge segments (same source rung) back into one branch: recursive
     reconstruction of the shared condition tree. instr: null marks a
     condition-only parallel leg. Preserves the operand multiset exactly. */
  function mergeLegsToBranch(legs) {
    if (!legs || legs.length === 0) return IR.makeSeries([]);
    const itemText = it => (it.op ? RLLS.serializeRllRung(IR.makeSeries([it])) : RLLS.serializeRllRung(it));

    function rec(segs) {
      if (segs.length === 1) {
        if (segs[0].instr === null) return IR.makeSeries(segs[0].condItems);
        return IR.makeSeries(segs[0].condItems.concat([segs[0].instr]));
      }
      // hoist leading empty-remainder output legs (outputs before further conditions)
      const hoisted = [];
      while (segs.length > 1 && segs[0].condItems.length === 0 && segs[0].instr !== null &&
             segs.some(s => s.condItems.length > 0)) {
        hoisted.push(segs[0].instr);
        segs = segs.slice(1);
      }
      if (hoisted.length) return IR.makeSeries(hoisted.concat([rec(segs)]));
      // longest common prefix (only over output segments; condition-only legs
      // keep their own conditions so their instructions are not duplicated)
      const shareable = segs.filter(s => s.instr !== null);
      let prefix = shareable.length ? shareable[0].condItems.map(itemText) : [];
      for (const seg of shareable) {
        const t = seg.condItems.map(itemText);
        let i = 0;
        while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
        prefix = prefix.slice(0, i);
      }
      if (prefix.length > 0) {
        // condition-only legs whose condition equals the prefix exactly claim it:
        // they become sibling legs with their full condition
        const claimers = segs.filter(s => s.instr === null &&
          s.condItems.length === prefix.length &&
          s.condItems.every((it, k) => itemText(it) === prefix[k]));
        if (claimers.length) {
          const others = segs.filter(s => claimers.indexOf(s) === -1);
          const claimLegs = claimers.map(s => IR.makeSeries(s.condItems));
          const recOther = others.length ? rec(others) : IR.makeSeries([]);
          const legs = recOther.kind === "parallel" ? recOther.legs.slice() : [recOther];
          return IR.makeParallel(legs.concat(claimLegs));
        }
        const items = shareable[0].condItems.slice(0, prefix.length);
        const stripped = segs.map(s => {
          if (s.instr === null) {
            const matches = s.condItems.length >= prefix.length &&
              prefix.every((t, k) => itemText(s.condItems[k]) === t);
            return matches ? { condItems: s.condItems.slice(prefix.length), instr: null } : s;
          }
          return { condItems: s.condItems.slice(prefix.length), instr: s.instr };
        });
        return IR.makeSeries(items.concat([rec(stripped)]));
      }
      // group consecutive segments by their first condition item
      const groups = [];
      for (const seg of segs) {
        const key = seg.condItems.length ? itemText(seg.condItems[0]) : "";
        const last = groups.length ? groups[groups.length - 1] : null;
        if (last && last.key === key) last.segs.push(seg);
        else groups.push({ key: key, firstItem: seg.condItems[0] || null, segs: [seg] });
      }
      const legs = groups.map(g => {
        if (g.key === "") {
          if (g.segs.length === 1) {
            return g.segs[0].instr === null ? IR.makeSeries([]) : IR.makeSeries([g.segs[0].instr]);
          }
          return IR.makeParallel(g.segs.map(s =>
            s.instr === null ? IR.makeSeries([]) : IR.makeSeries([s.instr])));
        }
        const stripped = g.segs.map(s => ({ condItems: s.condItems.slice(1), instr: s.instr }));
        return IR.makeSeries([g.firstItem, rec(stripped)]);
      });
      if (legs.length === 1) return legs[0];
      return IR.makeParallel(legs);
    }

    return rec(legs.map(l => ({ condItems: (l.condItems || []).slice(), instr: l.instr })));
  }

  /* Public: split a rung branch into output segments.
     Returns [{ cond: expr|null, condItems: [branchItems], instr|null }]. */
  function segmentsOfRung(root) {
    const warnings = [];
    const segs = [];
    processBranch(root, [], [], segs, warnings, null);
    return expandSegments(segs);
  }

  /* Merge segments (same source rung) back into one branch. Exported for tests. */
  function prefixMergeSegments(segments) {
    const legs = segments.map(seg => ({
      condItems: (seg.condItems && seg.condItems.length)
        ? seg.condItems.slice()
        : (seg.cond ? branchItems(exprToBranch(seg.cond)) : []),
      instr: seg.instr
    }));
    return mergeLegsToBranch(legs);
  }

  /* ------------------------------------------------------------- LAD -> ST */

  const CALL_OPS = {
    TON: 1, TOF: 1, RTO: 1, TONR: 1, CTU: 1, CTD: 1, RES: 1,
    JSR: 1, SBR: 1, RET: 1, GSV: 1, SSV: 1, MSG: 1, AVE: 1,
    BSL: 1, BSR: 1, CONCAT: 1, DTOS: 1, MID: 1, DELETE: 1, FIND: 1,
    INSERT: 1, SIZE: 1, TOD: 1, STOD: 1, RTOD: 1, DTOR: 1, STOR: 1,
    RTOS: 1, SWPB: 1, BTD: 1, COP: 1, CPS: 1, FLL: 1, LN: 1, LOG: 1,
    SIN: 1, COS: 1, TAN: 1, ASN: 1, ACS: 1, ATN: 1, DEG: 1, RAD: 1,
    TRN: 1, LOWER: 1, UPPER: 1, IOT: 1, TND: 1, MCR: 1, UID: 1, UIE: 1
  };
  /* timer/counter calls: blank preset/accum becomes <tag>.PRE / <tag>.ACC */
  const TIMER_OPS = { TON: 1, TOF: 1, RTO: 1, TONR: 1, CTU: 1, CTD: 1 };
  /* calls where empty parameters are legal ST */
  const EMPTY_OK_OPS = { GSV: 1, SSV: 1, MSG: 1 };

  function timerCallArgs(op, a) {
    const t = String(a[0] || "");
    return (a || []).map((x, i) => {
      if (String(x) === "?") {
        if (i === 1 && t && t !== "?") return IR.makeRef(t + ".PRE");
        if (i === 2 && t && t !== "?") return IR.makeRef(t + ".ACC");
        return IR.makeLiteral("");
      }
      return operandToExpr(x);
    });
  }

  /* call arguments with '?' placeholders: empty ST arguments (+ warning) */
  function placeholderCallArgs(op, a, warnings, rung) {
    const legal = EMPTY_OK_OPS[op];
    warn(warnings, legal ? "info" : "unsupported", rung,
      "unassigned '?' parameter in " + op + " emitted as empty argument");
    return (a || []).map(x => String(x) === "?" ? IR.makeLiteral("") : operandToExpr(x));
  }

  function segToStmt(seg, warnings, rung) {
    const instr = seg.instr;
    const cond = foldAnd(seg.cond);
    const op = instr.op, a = instr.args || [];
    const oe = i => operandToExpr(a[i]);
    const wrap = stmt => cond ? IR.makeIf([{ cond: cond, statements: [stmt] }]) : stmt;
    const call = (fn, argExprs) => wrap({ kind: "call", fn: fn, args: argExprs, comment: null });
    const callRaw = fn => call(fn, a.map(x => operandToExpr(x)));
    switch (op) {
      case "OTE":
        return IR.makeAssign(a[0], cond || IR.makeLiteral("1"));
      case "OTL":
        return IR.makeAssign(a[0], cond ? IR.makeBinary("OR", IR.makeRef(a[0]), cond) : IR.makeLiteral("1"));
      case "OTU":
        return IR.makeAssign(a[0], cond ? IR.makeBinary("AND", IR.makeRef(a[0]), IR.makeUnary("NOT", cond)) : IR.makeLiteral("0"));
      case "ONS":
        warn(warnings, "unsupported", rung, "ONS edge detection has no ST equivalent; converted to plain assignment");
        return IR.makeAssign(a[0], cond || IR.makeLiteral("1"));
      case "OSR":
      case "OSF":
        warn(warnings, "unsupported", rung, op + " edge detection has no ST equivalent; converted to plain assignment");
        return IR.makeAssign(a[1] !== undefined ? a[1] : a[0], cond || IR.makeLiteral("1"));
      case "MOV":
        return wrap(IR.makeAssign(a[1], oe(0)));
      case "ADD": return wrap(IR.makeAssign(a[2], IR.makeBinary("+", oe(0), oe(1))));
      case "SUB": return wrap(IR.makeAssign(a[2], IR.makeBinary("-", oe(0), oe(1))));
      case "MUL": return wrap(IR.makeAssign(a[2], IR.makeBinary("*", oe(0), oe(1))));
      case "DIV": return wrap(IR.makeAssign(a[2], IR.makeBinary("/", oe(0), oe(1))));
      case "MOD": return wrap(IR.makeAssign(a[2], IR.makeBinary("MOD", oe(0), oe(1))));
      case "NEG": return wrap(IR.makeAssign(a[1], IR.makeUnary("-", oe(0))));
      case "ABS": return wrap(IR.makeAssign(a[1], IR.makeCall("ABS", [oe(0)])));
      case "SQR": return wrap(IR.makeAssign(a[1], IR.makeBinary("*", oe(0), oe(0))));
      case "SQRT": return wrap(IR.makeAssign(a[1], IR.makeCall("SQRT", [oe(0)])));
      case "CLR": return wrap(IR.makeAssign(a[0], IR.makeLiteral("0")));
      case "CPT":
        try { return wrap(IR.makeAssign(a[0], STP.parseStExpression(a[1]))); }
        catch (e) {
          warn(warnings, "unsupported", rung, "CPT expression not parseable: " + e.message);
          return IR.makeComment(op + "(" + (a || []).join(",") + ")");
        }
      case "AND": return wrap(IR.makeAssign(a[2], IR.makeBinary("AND", oe(0), oe(1))));
      case "OR": return wrap(IR.makeAssign(a[2], IR.makeBinary("OR", oe(0), oe(1))));
      case "XOR": return wrap(IR.makeAssign(a[2], IR.makeBinary("XOR", oe(0), oe(1))));
      case "NOT": return wrap(IR.makeAssign(a[1], IR.makeUnary("NOT", oe(0))));
      case "JMP":
        warn(warnings, "unsupported", rung, "JMP has no ST equivalent; emitted as comment");
        return IR.makeComment("JMP(" + (a || []).join(",") + ")");
      case "LBL":
        return IR.makeComment("LBL(" + (a || []).join(",") + ")");
      default:
        if (TIMER_OPS[op]) return call(op, timerCallArgs(op, a));
        if ((a || []).some(x => String(x) === "?")) {
          return call(op, placeholderCallArgs(op, a, warnings, rung));
        }
        if (CALL_OPS[op]) return callRaw(op);
        warn(warnings, "unsupported", rung, "unsupported instruction " + op + " emitted as ST call");
        if ((a || []).length === 0) return IR.makeComment(op + "()");
        return callRaw(op);
    }
  }

  function ladToSt(ladIR) {
    const warnings = [];
    const items = []; // {kind:"comment"|"seg"|"for"|"nxt", ...}
    for (const r of ladIR.rungs || []) {
      if (r.comment) {
        const c = IR.makeComment(r.comment);
        setMeta(c, "_ladGroup", r.number);
        items.push({ kind: "comment", stmt: c });
      }
      const segs = [];
      processBranch(r.root, [], [], segs, warnings, r.number);
      if (segs.length === 0) {
        warn(warnings, "info", r.number, "rung has no output instruction; converted to comment");
        const c = IR.makeComment(RLLS.serializeRllRung(r.root));
        setMeta(c, "_ladGroup", r.number);
        setMeta(c, "_ladRungText", true);
        items.push({ kind: "comment", stmt: c });
        continue;
      }
      for (const seg of segs) {
        if (!seg.instr) continue; // condition-only leg: carried by the previous stmt's metadata
        if (seg.instr.op === "FOR") items.push({ kind: "for", seg: seg, rung: r.number });
        else if (seg.instr.op === "NXT") items.push({ kind: "nxt", seg: seg, rung: r.number });
        else {
          const stmt = segToStmt(seg, warnings, r.number);
          setMeta(stmt, "_ladGroup", r.number);
          setMeta(stmt, "_ladSeg", {
            cond: seg.cond, condItems: seg.condItems, instr: seg.instr, condOnly: seg.condOnly
          });
          items.push({ kind: "stmt", stmt: stmt });
        }
      }
    }

    // pass 2: FOR/NXT pairing across the routine
    const statements = [];
    const loopStack = []; // { label, forStmt }
    const target = () => loopStack.length ? loopStack[loopStack.length - 1].forStmt.statements : statements;

    function closeFor(frame) {
      warn(warnings, "unsupported", frame.rung, "FOR(" + frame.label + ") has no matching NXT; emitted as plain loop");
      setMeta(frame.forStmt, "_ladUnmatched", true);
    }

    for (const item of items) {
      if (item.kind === "comment") { target().push(item.stmt); continue; }
      if (item.kind === "for") {
        const seg = item.seg, a = seg.instr.args || [];
        if (seg.cond && seg.cond.length) warn(warnings, "info", item.rung, "condition on FOR rung ignored");
        const by = a[4] !== undefined && a[4] !== "?" ? operandToExpr(a[4]) : null;
        const f = IR.makeFor(a[1] || "?", operandToExpr(a[2]), operandToExpr(a[3]), by, []);
        setMeta(f, "_ladGroup", item.rung);
        setMeta(f, "_ladFor", { cond: seg.cond, condItems: seg.condItems, instr: seg.instr });
        target().push(f);
        loopStack.push({ label: a[0], forStmt: f, args: (a || []).slice(), rung: item.rung });
        continue;
      }
      if (item.kind === "nxt") {
        const seg = item.seg, a = seg.instr.args || [];
        if (seg.cond && seg.cond.length) warn(warnings, "info", item.rung, "condition on NXT ignored");
        let idx = -1;
        for (let k = loopStack.length - 1; k >= 0; k--) {
          if (loopStack[k].label === a[0]) { idx = k; break; }
        }
        if (idx === -1) {
          warn(warnings, "unsupported", item.rung, "NXT(" + a[0] + ") has no matching FOR; emitted as comment");
          const c = IR.makeComment("NXT(" + (a || []).join(",") + ")");
          setMeta(c, "_ladGroup", item.rung);
          setMeta(c, "_ladInstr", { op: "NXT", args: (a || []).slice() });
          setMeta(c, "_ladCondItems", seg.condItems);
          target().push(c);
          continue;
        }
        for (let k = loopStack.length - 1; k > idx; k--) closeFor(loopStack.pop());
        const frame = loopStack.pop();
        setMeta(frame.forStmt, "_ladNxt", { cond: seg.cond, instr: seg.instr });
        continue;
      }
      target().push(item.stmt);
    }
    while (loopStack.length) closeFor(loopStack.pop());

    return { ir: IR.makeStIR(statements), warnings: warnings };
  }

  /* ------------------------------------------------------------- ST -> LAD */

  /* strict boolean expr (refs, TRUE/FALSE, AND/OR/NOT, parens) */
  function isBoolExpr(e) {
    if (!e) return false;
    switch (e.kind) {
      case "ref": return true;
      case "literal": return e.value.toUpperCase() === "TRUE" || e.value.toUpperCase() === "FALSE";
      case "unary": return e.op === "NOT" && isBoolExpr(e.operand);
      case "binary": return (e.op === "AND" || e.op === "OR") && isBoolExpr(e.left) && isBoolExpr(e.right);
      case "paren": return isBoolExpr(e.inner);
      default: return false;
    }
  }

  /* negate a ladder branch by De Morgan; null means TRUE */
  function negateBranch(b) {
    if (!b) return null;
    if (b.op) return negateItem(b);
    if (b.kind === "series" && (b.items || []).length === 0) {
      return IR.makeSeries([IR.makeInstr("AFI")]); // NOT TRUE = FALSE
    }
    if (b.kind === "parallel") {
      const items = (b.legs || []).map(negateBranch)
        .filter(x => x !== null && !(x.kind === "series" && (x.items || []).length === 0));
      if (items.length === 0) return null;
      if (items.length === 1) return items[0];
      return IR.makeSeries(items);
    }
    const legs = [];
    for (const it of b.items || []) {
      const neg = negateItem(it);
      if (neg === null) continue; // NOT TRUE -> FALSE term; OR with FALSE is identity
      legs.push(neg);
    }
    if (legs.length === 0) return null;
    if (legs.length === 1) return IR.makeSeries([legs[0]]);
    return IR.makeParallel(legs.map(leg =>
      leg && (leg.kind === "series" || leg.kind === "parallel") ? leg : IR.makeSeries([leg])));
  }

  function negateItem(it) {
    if (!it) return null;
    if (!it.op) return negateBranch(it);
    const op = it.op, a = it.args || [];
    switch (op) {
      case "XIC": return IR.makeInstr("XIO", a[0]);
      case "XIO": return IR.makeInstr("XIC", a[0]);
      case "AFI": return null; // NOT FALSE = TRUE
      case "EQU": return IR.makeInstr("NEQ", a[0], a[1]);
      case "NEQ": return IR.makeInstr("EQU", a[0], a[1]);
      case "GRT": return IR.makeInstr("LEQ", a[0], a[1]);
      case "GEQ": return IR.makeInstr("LES", a[0], a[1]);
      case "LES": return IR.makeInstr("GEQ", a[0], a[1]);
      case "LEQ": return IR.makeInstr("GRT", a[0], a[1]);
      case "NOP": return IR.makeInstr("NOP");
      default: return null;
    }
  }

  /* strict boolean expr -> branch (exported). null when not representable. */
  function boolExprToBranch(expr) {
    if (!expr) return null;
    switch (expr.kind) {
      case "ref": return IR.makeSeries([IR.makeInstr("XIC", expr.path)]);
      case "literal": {
        const v = String(expr.value).toUpperCase();
        if (v === "TRUE") return IR.makeSeries([]);
        if (v === "FALSE") return IR.makeSeries([IR.makeInstr("AFI")]);
        return null;
      }
      case "paren": return boolExprToBranch(expr.inner);
      case "unary":
        if (expr.op === "NOT") return negateBranch(boolExprToBranch(expr.operand));
        return null;
      case "binary": {
        const l = boolExprToBranch(expr.left);
        const r = boolExprToBranch(expr.right);
        if (!l || !r) return null;
        if (expr.op === "AND") return IR.makeSeries((l.items || []).concat(r.items || []));
        if (expr.op === "OR") {
          const legs = [];
          const add = b => {
            if (b.kind === "parallel") legs.push(...(b.legs || []));
            else legs.push(b);
          };
          add(l); add(r);
          return IR.makeParallel(legs);
        }
        return null;
      }
      default: return null;
    }
  }

  const CMP_TO_INSTR = { "=": "EQU", "<>": "NEQ", ">": "GRT", ">=": "GEQ", "<": "LES", "<=": "LEQ" };
  const ARITH_TO_LAD = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "MOD": "MOD", "**": "EXPT" };

  /* simple integer literal value, or null */
  function intLiteral(e) {
    if (!e || e.kind !== "literal") return null;
    const v = String(e.value).trim();
    if (!/^[0-9]+$/.test(v) && !/^-[0-9]+$/.test(v)) return null;
    const n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }
  /* expression of the form `ref ± integer` */
  function refPlusLiteral(e) {
    if (e && e.kind === "paren") return refPlusLiteral(e.inner);
    if (!e || e.kind !== "binary") return null;
    if (e.op !== "+" && e.op !== "-") return null;
    const k = intLiteral(e.right);
    if (k === null) return null;
    if (e.left && e.left.kind === "ref") return { ref: e.left.path, k: e.op === "+" ? k : -k };
    return null;
  }
  /* comparison against `ref ± 1` where an integer type lets us drop the arithmetic:
       A > (R - 1)  <=>  A >= R        A >= (R + 1) <=> A > R
       A < (R + 1)  <=>  A <= R        A <= (R - 1) <=> A < R
     (assumes integer operands; reported as an info warning) */
  function simplifyOffsetCompare(op, flatText, refPath, k, arithOnRight) {
    if (arithOnRight) {
      if (op === ">" && k === -1) return { op: ">=", left: flatText, right: refPath };
      if (op === ">=" && k === 1) return { op: ">", left: flatText, right: refPath };
      if (op === "<" && k === 1) return { op: "<=", left: flatText, right: refPath };
      if (op === "<=" && k === -1) return { op: "<", left: flatText, right: refPath };
      return null;
    }
    const flip = { ">": "<", ">=": "<=", "<": ">", "<=": ">=" }[op];
    return flip ? simplifyOffsetCompare(flip, flatText, refPath, k, true) : null;
  }
  /* flat comparison for an expression: [{op,left,right,simplified}] or null.
     Handles both-flat comparisons and the integer ±1 arithmetic forms. */
  function normalizeComparison(expr) {
    if (!expr || expr.kind !== "binary" || !CMP_TO_INSTR[expr.op]) return null;
    const op = expr.op;
    const lFlat = isFlatOperand(expr.left) ? operandText(expr.left) : null;
    const rFlat = isFlatOperand(expr.right) ? operandText(expr.right) : null;
    if (lFlat !== null && rFlat !== null) return { op: op, left: lFlat, right: rFlat, simplified: false };
    if (lFlat !== null) {
      const rp = refPlusLiteral(expr.right);
      if (rp) {
        const s = simplifyOffsetCompare(op, lFlat, rp.ref, rp.k, true);
        if (s) return { op: s.op, left: s.left, right: s.right, simplified: true };
      }
    } else if (rFlat !== null) {
      const lp = refPlusLiteral(expr.left);
      if (lp) {
        const s = simplifyOffsetCompare(op, rFlat, lp.ref, lp.k, false);
        if (s) return { op: s.op, left: s.left, right: s.right, simplified: true };
      }
    }
    return null;
  }
  /* flatten an arithmetic operand into a tag/literal. When the operand is an arithmetic
     expression a helper tag (L5X_TMP_n) is allocated and its computation is queued in
     ctx.pre as an unconditional rung emitted before the IF (auto-declared on export). */
  function ensureFlatOperand(expr, ctx) {
    if (!expr) return null;
    if (isFlatOperand(expr)) return operandText(expr);
    if (expr.kind === "paren") return ensureFlatOperand(expr.inner, ctx);
    if (expr.kind === "unary" && expr.op === "-") {
      if (expr.operand && expr.operand.kind === "literal") return "-" + operandText(expr.operand);
      const inner = ensureFlatOperand(expr.operand, ctx);
      if (inner === null) return null;
      const t = ctx.temp();
      ctx.pre.push([IR.makeInstrArgs("NEG", [inner, t])]);
      return t;
    }
    if (expr.kind === "binary" && ARITH_TO_LAD[expr.op]) {
      const a = ensureFlatOperand(expr.left, ctx);
      const b = ensureFlatOperand(expr.right, ctx);
      if (a === null || b === null) return null;
      const t = ctx.temp();
      ctx.pre.push([IR.makeInstrArgs(ARITH_TO_LAD[expr.op], [a, b, t])]);
      return t;
    }
    return null;
  }

  /* extended expr -> branch for rung CONDITIONS (refs, TRUE/FALSE, AND/OR/NOT,
     parens and comparisons; arithmetic in comparisons flattened via helper tags
     when a ctx is supplied); null if not representable */
  function exprToBranch(expr, ctx) {
    if (!expr) return null;
    switch (expr.kind) {
      case "ref": return IR.makeSeries([IR.makeInstr("XIC", expr.path)]);
      case "literal": {
        const v = String(expr.value).toUpperCase();
        if (v === "TRUE") return IR.makeSeries([]);
        if (v === "FALSE") return IR.makeSeries([IR.makeInstr("AFI")]);
        return null;
      }
      case "paren": return exprToBranch(expr.inner, ctx);
      case "unary": {
        if (expr.op !== "NOT") return null;
        const inner = exprToBranch(expr.operand, ctx);
        return inner === null ? null : negateBranch(inner);
      }
      case "binary": {
        if (CMP_TO_INSTR[expr.op]) {
          const cmp = normalizeComparison(expr);
          if (cmp) {
            if (cmp.simplified && ctx && ctx.warnOnce) ctx.warnOnce("IF comparison uses integer ±1 arithmetic; simplified to " + cmp.op + ".");
            return IR.makeSeries([IR.makeInstr(CMP_TO_INSTR[cmp.op], cmp.left, cmp.right)]);
          }
          if (ctx) {
            const l = ensureFlatOperand(expr.left, ctx);
            const r = ensureFlatOperand(expr.right, ctx);
            if (l !== null && r !== null) {
              ctx.warnOnce("IF condition computed a helper tag (auto-declared DINT) for an arithmetic comparison (" + expr.op + ").");
              return IR.makeSeries([IR.makeInstr(CMP_TO_INSTR[expr.op], l, r)]);
            }
          }
          return null;
        }
        if (expr.op === "AND" || expr.op === "OR") {
          const l = exprToBranch(expr.left, ctx);
          const r = exprToBranch(expr.right, ctx);
          if (!l || !r) return null;
          if (expr.op === "AND") return IR.makeSeries(branchItems(l).concat(branchItems(r)));
          const legs = [];
          if (l.kind === "parallel") legs.push(...(l.legs || []));
          else legs.push(l);
          if (r.kind === "parallel") legs.push(...(r.legs || []));
          else legs.push(r);
          return IR.makeParallel(legs);
        }
        return null;
      }
      default: return null;
    }
  }

  /* top-level items of a condition branch (series items, or [branch]) */
  function branchItems(b) {
    if (!b) return [];
    if (b.kind === "series" && (b.items || []).length === 0) return [];
    if (b.kind === "series") return b.items.slice();
    return [b];
  }

  /* merge two condition branches: series concat, dropping empty branches */
  function combineCond(outer, inner) {
    if (!outer) return inner || null;
    if (!inner) return outer;
    const items = [];
    const add = b => {
      if (!b) return;
      if (b.kind === "series" && (b.items || []).length === 0) return;
      items.push(b);
    };
    add(outer); add(inner);
    return IR.makeSeries(items);
  }

  /* native ladder instruction for an assignment value; returns {op, args} or null */
  const CALL_DEST_OPS = {
    ABS: 1, SQR: 1, SQRT: 1, TRN: 1, DTOS: 1, STOD: 1, RTOD: 1, DTOR: 1, STOR: 1, RTOS: 1,
    TOD: 1, LN: 1, LOG: 1, SIN: 1, COS: 1, TAN: 1, ASN: 1, ACS: 1, ATN: 1, DEG: 1, RAD: 1,
    LOWER: 1, UPPER: 1
  };

  function nativeLadInstr(v, warnings) {
    if (!v) return null;
    if (v.kind === "literal" || v.kind === "ref") return { op: "MOV", args: [operandText(v)] };
    if (v.kind === "binary" && isFlatOperand(v.left) && isFlatOperand(v.right)) {
      const map = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "MOD": "MOD" };
      if (map[v.op]) return { op: map[v.op], args: [operandText(v.left), operandText(v.right)] };
      return null;
    }
    if (v.kind === "unary" && v.op === "-" && isFlatOperand(v.operand)) {
      return { op: "NEG", args: [operandText(v.operand)] };
    }
    if (v.kind === "call" && (v.args || []).length === 1 && isFlatOperand(v.args[0])) {
      const fn = v.fn.toUpperCase();
      if (CALL_DEST_OPS[fn]) return { op: fn, args: [operandText(v.args[0])] };
      if (fn === "COP") return { op: "COP", args: [operandText(v.args[0]), "1"] };
      warn(warnings, "unsupported", null, "call " + v.fn + " not representable as a ladder instruction; emitted as CPT");
      return null;
    }
    if (v.kind === "call") {
      warn(warnings, "unsupported", null, "call " + v.fn + " not representable as a ladder instruction; emitted as CPT");
      return null;
    }
    return null;
  }

  function stToLad(stIR) {
    const warnings = [];
    const rungs = [];
    let pendingComment = [];
    let labelN = 0;
    const newLabel = p => p + (labelN++);
    let tempCount = 0;          // helper tags for arithmetic in IF conditions
    const tempNames = [];

    /* merge state: current rung group */
    let cur = null; // { key, legs: [{condItems, instr}] }

    function takeComment() {
      if (pendingComment.length === 0) return null;
      const c = pendingComment.join("\n");
      pendingComment = [];
      return c;
    }
    function flushCur() {
      if (!cur) return;
      const branch = mergeLegsToBranch(cur.legs);
      rungs.push(IR.makeRung(branch, { number: rungs.length, comment: takeComment() }));
      cur = null;
    }
    function addLeg(key, condItems, instr) {
      if (key !== null && cur && cur.key === key) {
        cur.legs.push({ condItems: condItems, instr: instr });
        return;
      }
      flushCur();
      cur = { key: key, legs: [{ condItems: condItems, instr: instr }] };
    }
    function emitPlainRung(items, condItems) {
      flushCur();
      const list = [];
      const add = it => {
        if (!it) return;
        if (it.kind === "series" && (it.items || []).length === 0) return;
        list.push(it);
      };
      if (condItems) add(condItems);
      for (const it of items) add(it);
      rungs.push(IR.makeRung(IR.makeSeries(list), { number: rungs.length, comment: takeComment() }));
    }

    /* candidate from a plain (metadata-less) statement: returns {condItems, instr}|null */
    function honestCandidate(s, condItems) {
      const target = s.target;
      const v = s.value;
      if (v && v.kind === "binary" && v.op === "OR" && v.left && v.left.kind === "ref" && v.left.path === target) {
        const b = exprToBranch(v.right);
        if (b) return { condItems: condItems.concat(branchItems(b)), instr: IR.makeInstr("OTL", target) };
      }
      if (v && v.kind === "binary" && v.op === "AND" && v.left && v.left.kind === "ref" && v.left.path === target &&
          v.right && v.right.kind === "unary" && v.right.op === "NOT") {
        const b = exprToBranch(v.right.operand);
        if (b) return { condItems: condItems.concat(branchItems(b)), instr: IR.makeInstr("OTU", target) };
      }
      if (isBoolExpr(v)) {
        const b = boolExprToBranch(v);
        if (b) return { condItems: condItems.concat(branchItems(b)), instr: IR.makeInstr("OTE", target) };
        warn(warnings, "unsupported", rungs.length, "boolean expression not representable as ladder; emitted as CPT");
        return { condItems: condItems, instr: IR.makeInstr("CPT", target, IR.exprToString(v, 0)) };
      }
      const nat = nativeLadInstr(v, warnings);
      if (nat) return { condItems: condItems, instr: IR.makeInstrArgs(nat.op, nat.args.concat([target])) };
      return { condItems: condItems, instr: IR.makeInstr("CPT", target, IR.exprToString(v, 0)) };
    }

    /* add a metadata-backed statement (and its condition-only leg records) to
       the current rung group */
    function addSegLegs(stmt, outerItems) {
      const seg = getMeta(stmt, "_ladSeg");
      const g = getMeta(stmt, "_ladGroup");
      const cItems = (seg.condItems && seg.condItems.length)
        ? outerItems.concat(seg.condItems)
        : outerItems.slice();
      addLeg("G:" + g, cItems, seg.instr);
      for (const c of seg.condOnly || []) {
        const ccItems = (c.condItems && c.condItems.length)
          ? outerItems.concat(c.condItems)
          : outerItems.slice();
        addLeg("G:" + g, ccItems, null);
      }
    }

    function processStmts(stmts, cond) {
      for (const s of stmts) {
        if (!s) continue;
        switch (s.kind) {
          case "comment": {
            const g = getMeta(s, "_ladGroup");
            if (getMeta(s, "_ladRungText")) {
              // whole-rung fallback comment: re-parse and emit as a rung
              flushCur();
              let branch = null;
              try { branch = RLLP.parseRllRung(s.text); } catch (e) { branch = IR.makeSeries([IR.makeInstr("NOP")]); }
              rungs.push(IR.makeRung(branch, { number: rungs.length, comment: takeComment() }));
            } else if (getMeta(s, "_ladInstr")) {
              const m = getMeta(s, "_ladInstr");
              const cc = getMeta(s, "_ladCondItems") || [];
              addLeg(g !== undefined ? "G:" + g : "I:" + JSON.stringify(m),
                cc.slice(), IR.makeInstrArgs(m.op, m.args));
            } else {
              // a comment belongs to the NEXT rung: flush the open group first
              if (cur) flushCur();
              pendingComment.push(s.text);
            }
            break;
          }
          case "empty": addLeg("E:" + labelN++, [], IR.makeInstr("NOP")); break;
          case "exit":
            warn(warnings, "unsupported", rungs.length, "EXIT approximated as RET()");
            if (s.comment) pendingComment.push(s.comment);
            addLeg(null, [], IR.makeInstr("RET"));
            break;
          case "return":
            if (s.comment) pendingComment.push(s.comment);
            addLeg(null, [], IR.makeInstr("RET"));
            break;
          case "assign": {
            const seg = getMeta(s, "_ladSeg");
            const outerItems = branchItems(cond);
            if (seg) {
              addSegLegs(s, outerItems);
            } else {
              if (s.comment) pendingComment.push(s.comment);
              const cand = honestCandidate(s, outerItems);
              const key = cand.condItems.length ? "C:" + cand.condItems.map(x => RLLS.serializeRllRung(x.kind === "series" ? x : IR.makeSeries([x]))).join("&") : null;
              addLeg(key, cand.condItems, cand.instr);
            }
            break;
          }
          case "call": {
            const seg = getMeta(s, "_ladSeg");
            const outerItems = branchItems(cond);
            if (seg) {
              addSegLegs(s, outerItems);
            } else {
              if (s.comment) pendingComment.push(s.comment);
              const args = [];
              for (const a of s.args || []) {
                if (a && a.kind === "namedArg") {
                  warn(warnings, "unsupported", rungs.length, "named argument '" + a.name + "' passed positionally");
                  args.push(operandText(a.value));
                } else {
                  args.push(operandText(a));
                }
              }
              const key = outerItems.length ? "C:" + outerItems.map(x => RLLS.serializeRllRung(x.kind === "series" ? x : IR.makeSeries([x]))).join("&") : null;
              addLeg(key, outerItems, IR.makeInstrArgs(String(s.fn).toUpperCase(), args));
            }
            break;
          }
          case "if": {
            const seg = getMeta(s, "_ladSeg");
            if (seg) {
              addSegLegs(s, branchItems(cond));
              break;
            }
            doIf(s, cond);
            break;
          }
          case "for": doFor(s, cond); break;
          case "while": doWhile(s, cond); break;
          case "repeat": doRepeat(s, cond); break;
          case "case": doCase(s, cond); break;
          default:
            warn(warnings, "unsupported", rungs.length, "unsupported statement kind " + s.kind + "; emitted as comment");
            pendingComment.push(JSON.stringify(s));
        }
      }
    }

    function doIf(s, cond) {
      flushCur();
      if (s.comment) pendingComment.push(s.comment);
      const conds = (s.branches || []).map(b => b.cond);
      /* IF is a rung condition network in ladder: refs/AND/OR/NOT/compares map directly.
         Arithmetic inside a comparison is flattened through helper tags (auto-declared
         DINTs) whose computation is emitted as a gated rung before the branches. */
      const ctx = {
        pre: [],
        temp: function () { const n = "L5X_TMP_" + (++tempCount); tempNames.push(n); return n; },
        warnOnce: function (msg) {
          ctx._warned = ctx._warned || {};
          if (ctx._warned[msg]) return;
          ctx._warned[msg] = true;
          warn(warnings, "info", rungs.length, msg);
        }
      };
      const rawFor = conds.map(c => {
        if (c === null) return null;
        const cb = exprToBranch(c, ctx);
        if (!cb) warn(warnings, "unsupported", rungs.length, "IF condition not representable in ladder: " + IR.exprToString(c, 0));
        return cb;
      });
      for (const pre of ctx.pre) emitPlainRung(pre, cond || null);
      const branchFor = [];
      for (let i = 0; i < conds.length; i++) {
        const c = conds[i];
        let b;
        if (c === null) {
          // ELSE: NOT c1 AND NOT c2 ... (over the RAW conditions)
          const parts = [];
          for (let j = 0; j < i; j++) {
            const nb = negateBranch(rawFor[j]);
            if (nb) parts.push(nb);
          }
          b = parts.length ? parts.reduce((acc, x) => combineCond(acc, x), null) : null;
        } else {
          let parts = [];
          if (rawFor[i]) parts.push(rawFor[i]);
          for (let j = 0; j < i; j++) {
            const nb = negateBranch(rawFor[j]);
            if (nb) parts.push(nb);
          }
          b = parts.length ? parts.reduce((acc, x) => combineCond(acc, x), null) : null;
        }
        branchFor.push(b);
      }
      for (let i = 0; i < s.branches.length; i++) {
        const b = s.branches[i];
        processStmts(b.statements, combineCond(cond, branchFor[i]));
      }
    }

    function doFor(s, cond) {
      const meta = getMeta(s, "_ladFor");
      if (meta) {
        if (getMeta(s, "_ladUnmatched")) {
          // unmatched FOR: merge the FOR instruction back into its source rung's group,
          // keeping its rung condition items for reconstruction
          const cItems = (meta.condItems && meta.condItems.length)
            ? branchItems(cond).concat(meta.condItems)
            : branchItems(cond);
          addLeg("G:" + getMeta(s, "_ladGroup"), cItems, IR.makeInstrArgs(meta.instr.op, meta.instr.args));
          processStmts(s.statements, cond);
          return;
        }
        flushCur();
        emitPlainRung([IR.makeInstrArgs(meta.instr.op, meta.instr.args)], cond);
        processStmts(s.statements, cond);
        const nxt = getMeta(s, "_ladNxt");
        emitPlainRung([nxt ? IR.makeInstrArgs(nxt.instr.op, nxt.instr.args)
          : IR.makeInstr("NXT", meta.instr.args[0])], null);
        return;
      }
      flushCur();
      if (s.comment) pendingComment.push(s.comment);
      const lbl = newLabel("L");
      const init = operandText(s.from);
      const term = operandText(s.to);
      const step = s.by ? operandText(s.by) : "1";
      emitPlainRung([IR.makeInstr("FOR", lbl, s.index, init, term, step)], cond);
      processStmts(s.statements, cond);
      emitPlainRung([IR.makeInstr("NXT", lbl)], null);
    }

    function doWhile(s, cond) {
      flushCur();
      if (s.comment) pendingComment.push(s.comment);
      warn(warnings, "info", rungs.length, "WHILE converted to a LBL/JMP loop");
      const loopLbl = newLabel("W");
      const endLbl = newLabel("W");
      emitPlainRung([IR.makeInstr("LBL", loopLbl)], null);
      const cb = exprToBranch(s.cond);
      if (!cb) {
        warn(warnings, "unsupported", rungs.length, "WHILE condition not representable; loop exit emitted as unconditional JMP");
        emitPlainRung([IR.makeInstr("JMP", endLbl)], cond);
      } else {
        const neg = negateBranch(cb) || IR.makeSeries([]);
        emitPlainRung([neg, IR.makeInstr("JMP", endLbl)], cond);
      }
      processStmts(s.statements, cond);
      emitPlainRung([IR.makeInstr("JMP", loopLbl)], cond);
      emitPlainRung([IR.makeInstr("LBL", endLbl)], null);
    }

    function doRepeat(s, cond) {
      flushCur();
      if (s.comment) pendingComment.push(s.comment);
      warn(warnings, "info", rungs.length, "REPEAT converted to a LBL/JMP loop");
      const loopLbl = newLabel("R");
      emitPlainRung([IR.makeInstr("LBL", loopLbl)], null);
      processStmts(s.statements, cond);
      const cb = exprToBranch(s.cond);
      if (!cb) {
        warn(warnings, "unsupported", rungs.length, "REPEAT condition not representable; emitted as unconditional JMP");
        emitPlainRung([IR.makeInstr("JMP", loopLbl)], cond);
      } else {
        const neg = negateBranch(cb) || IR.makeSeries([]);
        emitPlainRung([neg, IR.makeInstr("JMP", loopLbl)], cond);
      }
    }

    function doCase(s, cond) {
      flushCur();
      if (s.comment) pendingComment.push(s.comment);
      warn(warnings, "info", rungs.length, "CASE converted to ladder condition rungs");
      // raw per-case matches: OR of (expr = label)
      const rawCase = s.cases.map(c => {
        const parts = [];
        for (const label of c.labels) {
          const cb = exprToBranch(IR.makeBinary("=", s.expr, label));
          if (cb) parts.push(cb);
          else warn(warnings, "unsupported", rungs.length, "CASE label not representable: " + IR.exprToString(label, 0));
        }
        return parts.length ? parts.reduce((acc, x) => combineCond(acc, x), null) : null;
      });
      const caseCond = [];
      for (let i = 0; i < s.cases.length; i++) {
        const parts = [];
        if (rawCase[i]) parts.push(rawCase[i]);
        for (let j = 0; j < i; j++) {
          const nb = negateBranch(rawCase[j]);
          if (nb) parts.push(nb);
        }
        const cc = parts.length ? parts.reduce((acc, x) => combineCond(acc, x), null) : null;
        caseCond.push(cc);
        processStmts(s.cases[i].statements, combineCond(cond, cc));
      }
      if (s.elseStatements && s.elseStatements.length) {
        const parts = [];
        for (let j = 0; j < rawCase.length; j++) {
          const nb = negateBranch(rawCase[j]);
          if (nb) parts.push(nb);
        }
        const ee = parts.length ? parts.reduce((acc, x) => combineCond(acc, x), null) : null;
        processStmts(s.elseStatements, combineCond(cond, ee));
      }
    }

    processStmts(stIR.statements || [], null);
    flushCur();
    if (pendingComment.length) {
      rungs.push(IR.makeRung([IR.makeInstr("NOP")], { number: rungs.length, comment: pendingComment.join("\n") }));
      pendingComment = [];
    }
    return { ir: IR.makeLadIR(rungs), warnings: warnings, tempTags: tempNames };
  }

  /* ladder branch tree (condition-class instructions only) -> boolean expr */
  function branchToBoolExpr(branch) {
    if (!branch) return null;
    if (branch.op) return condExprFor(branch, [], null);
    if (branch.kind === "parallel") {
      const terms = [];
      for (const leg of branch.legs || []) {
        const e = branchToBoolExpr(leg);
        if (e) terms.push(e);
      }
      if (terms.length === 0) return null;
      let e = terms[0];
      for (let i = 1; i < terms.length; i++) e = IR.makeBinary("OR", e, terms[i]);
      return e;
    }
    let e = null;
    for (const it of branch.items || []) {
      const ce = it.op ? condExprFor(it, [], null) : branchToBoolExpr(it);
      if (ce) e = e ? IR.makeBinary("AND", e, ce) : ce;
    }
    return e;
  }

  return {
    ladToSt: ladToSt, stToLad: stToLad,
    boolExprToBranch: boolExprToBranch, branchToBoolExpr: branchToBoolExpr,
    /* extra exports for tests / reuse */
    exprToBranch: exprToBranch, segmentsOfRung: segmentsOfRung,
    prefixMergeSegments: prefixMergeSegments
  };
});
