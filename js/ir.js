/* L5X Studio - ir.js (T1). Intermediate representation shared by LAD/ST/FBD.
   See docs/CONTRACT.md section 1 for the exact shapes. Dependency-free. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- factories */

  function makeInstr(op) {
    const args = [];
    for (let i = 1; i < arguments.length; i++) args.push(String(arguments[i]));
    return { op: op, args: args };
  }
  function makeInstrArgs(op, args) {
    return { op: op, args: (args || []).map(String) };
  }
  function makeSeries(items) {
    return { kind: "series", items: items || [] };
  }
  function makeParallel(legs) {
    return { kind: "parallel", legs: legs || [] };
  }
  function makeRung(rootOrItems, opts) {
    opts = opts || {};
    let root;
    if (rootOrItems && (rootOrItems.kind === "series" || rootOrItems.kind === "parallel")) {
      root = rootOrItems;
    } else {
      root = makeSeries(Array.isArray(rootOrItems) ? rootOrItems : []);
    }
    return {
      id: opts.id,
      number: opts.number !== undefined ? opts.number : 0,
      type: opts.type !== undefined ? opts.type : "N",
      comment: opts.comment !== undefined ? opts.comment : null,
      root: root
    };
  }
  function makeLadIR(rungs) { return { kind: "lad", rungs: rungs || [] }; }
  function makeStIR(statements) { return { kind: "st", statements: statements || [] }; }

  function makeAssign(target, value, comment) {
    return { kind: "assign", target: String(target), value: value, comment: comment !== undefined ? comment : null };
  }
  function makeRef(path) { return { kind: "ref", path: String(path) }; }
  function makeLiteral(text) { return { kind: "literal", value: String(text) }; }
  function makeBinary(op, left, right) { return { kind: "binary", op: op, left: left, right: right }; }
  function makeUnary(op, operand) { return { kind: "unary", op: op, operand: operand }; }
  function makeParen(inner) { return { kind: "paren", inner: inner }; }
  function makeCall(fn, args) { return { kind: "call", fn: String(fn), args: args || [] }; }
  function makeNamedArg(name, value) { return { kind: "namedArg", name: String(name), value: value }; }
  function makeIf(branches, comment) {
    return { kind: "if", branches: branches || [], comment: comment !== undefined ? comment : null };
  }
  function makeFor(index, from, to, by, statements, comment) {
    return {
      kind: "for", index: String(index), from: from, to: to,
      by: by !== undefined ? by : null, statements: statements || [],
      comment: comment !== undefined ? comment : null
    };
  }
  function makeWhile(cond, statements, comment) {
    return { kind: "while", cond: cond, statements: statements || [], comment: comment !== undefined ? comment : null };
  }
  function makeRepeat(cond, statements, comment) {
    return { kind: "repeat", cond: cond, statements: statements || [], comment: comment !== undefined ? comment : null };
  }
  function makeCase(expr, cases, elseStatements, comment) {
    return {
      kind: "case", expr: expr, cases: cases || [],
      elseStatements: elseStatements !== undefined ? elseStatements : null,
      comment: comment !== undefined ? comment : null
    };
  }
  function makeComment(text) { return { kind: "comment", text: String(text) }; }
  function makeEmpty() { return { kind: "empty" }; }
  function makeExit() { return { kind: "exit" }; }
  function makeReturn() { return { kind: "return" }; }

  /* ------------------------------------------------------------------ clone */

  function deepCloneIr(x) {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(deepCloneIr);
    const o = {};
    for (const k of Object.keys(x)) o[k] = deepCloneIr(x[k]);
    return o;
  }

  /* -------------------------------------------------------------- kind check */

  function irKind(ir) {
    if (!ir || typeof ir !== "object") return null;
    if (ir.kind === "lad" || ir.kind === "st" || ir.kind === "fbd") return ir.kind;
    return null;
  }

  /* ----------------------------------------------------------------- walking */

  const BRANCH_KINDS = { series: 1, parallel: 1 };

  /* Walk every instruction of a LAD branch tree, or every statement of an ST
     statement list (or stIR), or a single instr. cb(node, ctx).
     LAD ctx: { kind:"lad", rung, path:[{item}|{leg,item},...] }
     ST  ctx: { kind:"st", path:[indices] } */
  function walkInstrs(branchOrStmts, cb) {
    if (!branchOrStmts) return;
    if (Array.isArray(branchOrStmts)) { walkStmts(branchOrStmts, cb); return; }
    if (branchOrStmts.kind === "lad") {
      (branchOrStmts.rungs || []).forEach(r => walkBranch(r.root, cb, { kind: "lad", rung: r.number, path: [] }));
      return;
    }
    if (branchOrStmts.kind === "st") { walkStmts(branchOrStmts.statements, cb); return; }
    if (branchOrStmts.kind === "series" || branchOrStmts.kind === "parallel") {
      walkBranch(branchOrStmts, cb, { kind: "lad", rung: null, path: [] });
      return;
    }
    if (branchOrStmts.kind === "fbd") return; // block traversal is T2's concern
    if (typeof branchOrStmts.op === "string" && Array.isArray(branchOrStmts.args)) {
      cb(branchOrStmts, { kind: "lad", rung: null, path: [] });
    }
  }

  function walkBranch(branch, cb, ctx) {
    if (!branch) return;
    if (branch.kind === "series") {
      (branch.items || []).forEach((it, i) => {
        const sub = Object.assign({}, ctx, { path: ctx.path.concat([{ item: i }]) });
        if (it && (it.kind === "series" || it.kind === "parallel")) walkBranch(it, cb, sub);
        else if (it && typeof it.op === "string") cb(it, sub);
      });
    } else if (branch.kind === "parallel") {
      (branch.legs || []).forEach((leg, k) => {
        const sub = Object.assign({}, ctx, {
          path: ctx.path.concat([{ leg: k, item: 0 }])
        });
        walkBranch(leg, cb, sub);
      });
    }
  }

  function walkStmts(stmts, cb) {
    (stmts || []).forEach((s, i) => {
      cb(s, { kind: "st", path: [i] });
      const inner = [];
      if (s.kind === "if") (s.branches || []).forEach(b => inner.push(b.statements));
      else if (s.kind === "for" || s.kind === "while" || s.kind === "repeat") inner.push(s.statements);
      else if (s.kind === "case") {
        (s.cases || []).forEach(c => inner.push(c.statements));
        if (s.elseStatements) inner.push(s.elseStatements);
      }
      inner.forEach(stmts2 => walkStmts(stmts2, cb));
    });
  }

  /* Visit every expression node (pre-order), including named args. */
  function walkExpr(expr, cb) {
    if (!expr || typeof expr !== "object") return;
    cb(expr);
    switch (expr.kind) {
      case "unary": walkExpr(expr.operand, cb); break;
      case "binary": walkExpr(expr.left, cb); walkExpr(expr.right, cb); break;
      case "paren": walkExpr(expr.inner, cb); break;
      case "call":
        (expr.args || []).forEach(a => {
          if (a && a.kind === "namedArg") walkExpr(a.value, cb);
          else walkExpr(a, cb);
        });
        break;
      case "namedArg": walkExpr(expr.value, cb); break;
    }
  }

  /* ---------------------------------------------------------- exprToString */

  const BIN_PREC = {
    "OR": 1, "XOR": 2, "AND": 3, "&": 3,
    "=": 4, "<>": 4, "<": 4, ">": 4, "<=": 4, ">=": 4,
    "+": 5, "-": 5, "*": 6, "/": 6, "MOD": 6,
    "**": 8
  };
  const UNARY_PREC = 7;
  /* ops whose right operand must be parenthesized when it has equal precedence */
  const RIGHT_ASSOC_UNSAFE = { "-": 1, "/": 1, "MOD": 1, "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1 };
  const BINARY_OPS = Object.keys(BIN_PREC);

  function precOf(expr) {
    if (!expr) return 9;
    switch (expr.kind) {
      case "binary": return BIN_PREC[expr.op] !== undefined ? BIN_PREC[expr.op] : 9;
      case "unary": return UNARY_PREC;
      default: return 9; // literal / ref / call / paren are atoms
    }
  }

  function exprToString(expr, parentPrec) {
    parentPrec = parentPrec === undefined ? 0 : parentPrec;
    if (!expr || typeof expr !== "object") return String(expr);
    switch (expr.kind) {
      case "literal": return String(expr.value);
      case "ref": return String(expr.path);
      case "paren": return "(" + exprToString(expr.inner, 0) + ")";
      case "unary": {
        let t = expr.op === "NOT" ? "NOT " : String(expr.op);
        const p = precOf(expr.operand);
        const need = p < UNARY_PREC;
        t += need ? "(" + exprToString(expr.operand, 0) + ")" : exprToString(expr.operand, UNARY_PREC);
        return parentPrec > UNARY_PREC ? "(" + t + ")" : t;
      }
      case "binary": {
        const p = BIN_PREC[expr.op] !== undefined ? BIN_PREC[expr.op] : 9;
        let lp = precOf(expr.left);
        let rp = precOf(expr.right);
        let l = (lp < p || (lp === p && expr.op === "**"))
          ? "(" + exprToString(expr.left, 0) + ")" : exprToString(expr.left, p);
        let r = (rp < p || (rp === p && RIGHT_ASSOC_UNSAFE[expr.op]))
          ? "(" + exprToString(expr.right, 0) + ")" : exprToString(expr.right, expr.op === "**" ? p : p + 1);
        let t = l + " " + expr.op + " " + r;
        return parentPrec > p ? "(" + t + ")" : t;
      }
      case "call": {
        const args = (expr.args || []).map(a =>
          a && a.kind === "namedArg" ? a.name + " := " + exprToString(a.value, 0) : exprToString(a, 0));
        return String(expr.fn) + "(" + args.join(", ") + ")";
      }
      case "namedArg": return expr.name + " := " + exprToString(expr.value, 0);
      default: return String(expr.value !== undefined ? expr.value : expr.path !== undefined ? expr.path : "");
    }
  }

  /* -------------------------------------------------------------- validation */

  const UNARY_OPS = { "NOT": 1, "-": 1, "+": 1 };

  function validateIr(ir) {
    const errors = [];
    if (!ir || typeof ir !== "object") return { ok: false, errors: ["IR is not an object"] };
    const kind = irKind(ir);
    if (!kind) return { ok: false, errors: ["IR has no valid kind (lad|st|fbd)"] };
    if (kind === "lad") {
      if (!Array.isArray(ir.rungs)) errors.push("lad.rungs must be an array");
      else ir.rungs.forEach((r, i) => {
        const pre = "rungs[" + i + "]";
        if (!r || typeof r !== "object") { errors.push(pre + " is not an object"); return; }
        if (r.number === undefined || r.number === null) errors.push(pre + ".number missing");
        if (typeof r.type !== "string") errors.push(pre + ".type must be a string");
        if (r.comment !== null && r.comment !== undefined && typeof r.comment !== "string")
          errors.push(pre + ".comment must be null or string");
        if (!r.root) errors.push(pre + ".root missing");
        else validateBranch(r.root, pre + ".root", errors);
      });
    } else if (kind === "st") {
      if (!Array.isArray(ir.statements)) errors.push("st.statements must be an array");
      else ir.statements.forEach((s, i) => validateStmt(s, "statements[" + i + "]", errors));
    } else if (kind === "fbd") {
      if (!Array.isArray(ir.sheets)) errors.push("fbd.sheets must be an array");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function validateBranch(b, pre, errors) {
    if (!b || typeof b !== "object") { errors.push(pre + " is not an object"); return; }
    if (b.kind === "series") {
      if (!Array.isArray(b.items)) errors.push(pre + ".items must be an array");
      else b.items.forEach((it, i) => {
        if (!it) { errors.push(pre + ".items[" + i + "] is empty"); return; }
        if (typeof it.op === "string") validateInstr(it, pre + ".items[" + i + "]", errors);
        else validateBranch(it, pre + ".items[" + i + "]", errors);
      });
    } else if (b.kind === "parallel") {
      if (!Array.isArray(b.legs)) errors.push(pre + ".legs must be an array");
      else b.legs.forEach((leg, k) => validateBranch(leg, pre + ".legs[" + k + "]", errors));
    } else {
      errors.push(pre + " has unknown branch kind " + JSON.stringify(b.kind));
    }
  }

  function validateInstr(instr, pre, errors) {
    if (!instr || typeof instr !== "object") { errors.push(pre + " is not an object"); return; }
    if (typeof instr.op !== "string" || !instr.op) errors.push(pre + ".op must be a non-empty string");
    if (!Array.isArray(instr.args)) errors.push(pre + ".args must be an array");
    else instr.args.forEach((a, k) => {
      if (typeof a !== "string") errors.push(pre + ".args[" + k + "] must be a string");
    });
  }

  function validateStmt(s, pre, errors) {
    if (!s || typeof s !== "object") { errors.push(pre + " is not an object"); return; }
    const kinds = {
      assign: 1, call: 1, if: 1, for: 1, while: 1, repeat: 1, case: 1,
      exit: 1, return: 1, comment: 1, empty: 1
    };
    if (!kinds[s.kind]) { errors.push(pre + " has unknown statement kind " + JSON.stringify(s.kind)); return; }
    switch (s.kind) {
      case "assign":
        if (typeof s.target !== "string") errors.push(pre + ".target must be a string");
        validateExpr(s.value, pre + ".value", errors);
        break;
      case "call":
        if (typeof s.fn !== "string" || !s.fn) errors.push(pre + ".fn must be a non-empty string");
        if (!Array.isArray(s.args)) errors.push(pre + ".args must be an array");
        else s.args.forEach((a, k) => validateExpr(a, pre + ".args[" + k + "]", errors));
        break;
      case "if":
        if (!Array.isArray(s.branches) || s.branches.length === 0) errors.push(pre + ".branches must be a non-empty array");
        else s.branches.forEach((b, k) => {
          if (!b || typeof b !== "object") { errors.push(pre + ".branches[" + k + "] invalid"); return; }
          if (b.cond !== null) validateExpr(b.cond, pre + ".branches[" + k + "].cond", errors);
          if (!Array.isArray(b.statements)) errors.push(pre + ".branches[" + k + "].statements must be an array");
          else b.statements.forEach((s2, j) => validateStmt(s2, pre + ".branches[" + k + "].statements[" + j + "]", errors));
        });
        break;
      case "for":
        if (typeof s.index !== "string") errors.push(pre + ".index must be a string");
        validateExpr(s.from, pre + ".from", errors);
        validateExpr(s.to, pre + ".to", errors);
        if (s.by !== null) validateExpr(s.by, pre + ".by", errors);
        if (!Array.isArray(s.statements)) errors.push(pre + ".statements must be an array");
        else s.statements.forEach((s2, j) => validateStmt(s2, pre + ".statements[" + j + "]", errors));
        break;
      case "while":
      case "repeat":
        validateExpr(s.cond, pre + ".cond", errors);
        if (!Array.isArray(s.statements)) errors.push(pre + ".statements must be an array");
        else s.statements.forEach((s2, j) => validateStmt(s2, pre + ".statements[" + j + "]", errors));
        break;
      case "case":
        validateExpr(s.expr, pre + ".expr", errors);
        if (!Array.isArray(s.cases)) errors.push(pre + ".cases must be an array");
        else s.cases.forEach((c, k) => {
          if (!c || !Array.isArray(c.labels)) errors.push(pre + ".cases[" + k + "].labels must be an array");
          else c.labels.forEach((l, j) => validateExpr(l, pre + ".cases[" + k + "].labels[" + j + "]", errors));
          if (!c || !Array.isArray(c.statements)) errors.push(pre + ".cases[" + k + "].statements must be an array");
          else c.statements.forEach((s2, j) => validateStmt(s2, pre + ".cases[" + k + "].statements[" + j + "]", errors));
        });
        if (s.elseStatements !== null) {
          if (!Array.isArray(s.elseStatements)) errors.push(pre + ".elseStatements must be null or array");
          else s.elseStatements.forEach((s2, j) => validateStmt(s2, pre + ".elseStatements[" + j + "]", errors));
        }
        break;
      case "comment":
        if (typeof s.text !== "string") errors.push(pre + ".text must be a string");
        break;
    }
  }

  function validateExpr(e, pre, errors) {
    if (!e || typeof e !== "object") { errors.push(pre + " is not an expression object"); return; }
    switch (e.kind) {
      case "literal":
        if (typeof e.value !== "string") errors.push(pre + ".value must be a string");
        break;
      case "ref":
        if (typeof e.path !== "string" || !e.path) errors.push(pre + ".path must be a non-empty string");
        break;
      case "unary":
        if (!UNARY_OPS[e.op]) errors.push(pre + ".op must be NOT, - or +");
        validateExpr(e.operand, pre + ".operand", errors);
        break;
      case "binary":
        if (BINARY_OPS.indexOf(e.op) === -1) errors.push(pre + ".op not allowed: " + e.op);
        validateExpr(e.left, pre + ".left", errors);
        validateExpr(e.right, pre + ".right", errors);
        break;
      case "paren":
        validateExpr(e.inner, pre + ".inner", errors);
        break;
      case "call":
        if (typeof e.fn !== "string" || !e.fn) errors.push(pre + ".fn must be a non-empty string");
        if (!Array.isArray(e.args)) errors.push(pre + ".args must be an array");
        else e.args.forEach((a, k) => validateExpr(a, pre + ".args[" + k + "]", errors));
        break;
      case "namedArg":
        if (typeof e.name !== "string" || !e.name) errors.push(pre + ".name must be a non-empty string");
        validateExpr(e.value, pre + ".value", errors);
        break;
      default:
        errors.push(pre + " has unknown expression kind " + JSON.stringify(e.kind));
    }
  }

  /* ------------------------------------------------------ instruction table */

  /* op -> { role: "condition"|"output"|"data"|"call"|"other",
            reads: [argIndex] (or "all"), writes: [argIndex],
            destArg: index|null (destination argument for MOV-family / timer family),
            control: true for control-flow instructions (no tag operands) }
     Used by lang-convert and dataflow. */
  const TIMER = (op) => ({ role: "output", reads: [0, 1, 2], writes: [0, 2], destArg: 0 });
  const LAD_OP_SEMANTICS = {
    XIC: { role: "condition", reads: [0] },
    XIO: { role: "condition", reads: [0] },
    OTE: { role: "output", writes: [0] },
    OTL: { role: "output", writes: [0] },
    OTU: { role: "output", writes: [0] },
    ONS: { role: "output", reads: [0], writes: [0] },
    OSR: { role: "output", reads: [0], writes: [0, 1] },
    OSF: { role: "output", reads: [0], writes: [0, 1] },
    AFI: { role: "condition" },
    NOP: { role: "other" },
    TON: TIMER(), TOF: TIMER(), RTO: TIMER(), TONR: TIMER(),
    CTU: { role: "output", reads: [0, 1, 2], writes: [0, 2], destArg: 0 },
    CTD: { role: "output", reads: [0, 1, 2], writes: [0, 2], destArg: 0 },
    RES: { role: "output", reads: [0], writes: [0], destArg: 0 },
    ADD: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    SUB: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    MUL: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    DIV: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    MOD: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    NEG: { role: "data", reads: [0], writes: [1], destArg: 1 },
    ABS: { role: "data", reads: [0], writes: [1], destArg: 1 },
    SQR: { role: "data", reads: [0], writes: [1], destArg: 1 },
    SQRT: { role: "data", reads: [0], writes: [1], destArg: 1 },
    CPT: { role: "data", reads: [1], writes: [0], destArg: 0 },
    CLR: { role: "data", writes: [0], destArg: 0 },
    EQU: { role: "condition", reads: [0, 1] },
    NEQ: { role: "condition", reads: [0, 1] },
    GRT: { role: "condition", reads: [0, 1] },
    GEQ: { role: "condition", reads: [0, 1] },
    LES: { role: "condition", reads: [0, 1] },
    LEQ: { role: "condition", reads: [0, 1] },
    LIM: { role: "condition", reads: [0, 1, 2] },
    MEQ: { role: "condition", reads: [0, 1, 2] },
    CMP: { role: "condition", reads: [0] },
    MOV: { role: "data", reads: [0], writes: [1], destArg: 1 },
    COP: { role: "data", reads: [0, 2], writes: [1], destArg: 1 },
    CPS: { role: "data", reads: [0, 2], writes: [1], destArg: 1 },
    FLL: { role: "data", reads: [0, 2], writes: [1], destArg: 1 },
    SWPB: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    BTD: { role: "data", reads: [0, 1, 3, 4], writes: [2], destArg: 2 },
    AND: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    OR: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    XOR: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    NOT: { role: "data", reads: [0], writes: [1], destArg: 1 },
    JSR: { role: "call", reads: "all" },
    SBR: { role: "call", reads: "all" },
    RET: { role: "call", reads: "all" },
    JMP: { role: "call", control: true },
    LBL: { role: "call", control: true },
    FOR: { role: "call", reads: [1, 2, 3, 4], writes: [1], control: true },
    NXT: { role: "call", control: true },
    GSV: { role: "data", reads: [0, 1, 2], writes: [3], destArg: 3 },
    SSV: { role: "data", reads: [0, 1, 2, 3] },
    MSG: { role: "output", reads: [0], writes: [0], destArg: 0 },
    AVE: { role: "data", reads: [0, 1, 3, 4, 5], writes: [2], destArg: 2 },
    CONCAT: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    DTOS: { role: "data", reads: [0], writes: [1], destArg: 1 },
    BSL: { role: "output", reads: [0, 1, 2, 3], writes: [0], destArg: 0 },
    BSR: { role: "output", reads: [0, 1, 2, 3], writes: [0], destArg: 0 },
    MID: { role: "data", reads: [0, 1, 2], writes: [3], destArg: 3 },
    DELETE: { role: "data", reads: [0, 1, 2], writes: [3], destArg: 3 },
    FIND: { role: "data", reads: [0, 1, 2], writes: [3], destArg: 3 },
    INSERT: { role: "data", reads: [0, 1, 2], writes: [3], destArg: 3 },
    SIZE: { role: "data", reads: [0, 1], writes: [2], destArg: 2 },
    TOD: { role: "data", reads: [0], writes: [1], destArg: 1 },
    STOD: { role: "data", reads: [0], writes: [1], destArg: 1 },
    RTOD: { role: "data", reads: [0], writes: [1], destArg: 1 },
    DTOR: { role: "data", reads: [0], writes: [1], destArg: 1 },
    STOR: { role: "data", reads: [0], writes: [1], destArg: 1 },
    RTOS: { role: "data", reads: [0], writes: [1], destArg: 1 },
    TRN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    LN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    LOG: { role: "data", reads: [0], writes: [1], destArg: 1 },
    SIN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    COS: { role: "data", reads: [0], writes: [1], destArg: 1 },
    TAN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    ASN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    ACS: { role: "data", reads: [0], writes: [1], destArg: 1 },
    ATN: { role: "data", reads: [0], writes: [1], destArg: 1 },
    DEG: { role: "data", reads: [0], writes: [1], destArg: 1 },
    RAD: { role: "data", reads: [0], writes: [1], destArg: 1 },
    LOWER: { role: "data", reads: [0], writes: [1], destArg: 1 },
    UPPER: { role: "data", reads: [0], writes: [1], destArg: 1 },
    IOT: { role: "output", writes: [0], destArg: 0 },
    TND: { role: "call", control: true },
    MCR: { role: "call", control: true },
    UID: { role: "call", control: true },
    UIE: { role: "call", control: true }
  };

  return {
    makeInstr: makeInstr, makeInstrArgs: makeInstrArgs, makeSeries: makeSeries,
    makeParallel: makeParallel, makeRung: makeRung, makeLadIR: makeLadIR, makeStIR: makeStIR,
    makeAssign: makeAssign, makeRef: makeRef, makeLiteral: makeLiteral, makeBinary: makeBinary,
    makeUnary: makeUnary, makeParen: makeParen, makeCall: makeCall, makeNamedArg: makeNamedArg,
    makeIf: makeIf, makeFor: makeFor, makeWhile: makeWhile, makeRepeat: makeRepeat,
    makeCase: makeCase, makeComment: makeComment, makeEmpty: makeEmpty, makeExit: makeExit,
    makeReturn: makeReturn,
    deepCloneIr: deepCloneIr, irKind: irKind, walkInstrs: walkInstrs, walkExpr: walkExpr,
    validateIr: validateIr, exprToString: exprToString, LAD_OP_SEMANTICS: LAD_OP_SEMANTICS
  };
});
