/* L5X Studio - t1-lang.test.js (T1). Language core tests.
   Run: node test/t1-lang.test.js  (exit non-zero on failure) */
"use strict";
const assert = require("assert");
const IR = require("../js/ir.js");
const RLLP = require("../js/rll-parse.js");
const RLLS = require("../js/rll-serialize.js");
const STP = require("../js/st-parse.js");
const STS = require("../js/st-serialize.js");
const LC = require("../js/lang-convert.js");
const DF = require("../js/dataflow.js");

const sampleRll = require("./fixtures/sampleRll-rll.json");
const sampleProcess = require("./fixtures/sampleProcess-rll.json");
const sampleSt = require("./fixtures/sampleSt-st.json");

let failures = 0;
let checks = 0;
function check(name, fn) {
  checks++;
  try {
    fn();
    console.log("ok - " + name);
  } catch (e) {
    failures++;
    console.error("FAIL - " + name);
    console.error("    " + String((e && e.message) || e));
    if (e && e.stack) {
      const lines = e.stack.split("\n").slice(1, 5).join("\n    ");
      console.error("    " + lines);
    }
  }
}

/* drop undefined fields so deepStrictEqual ignores optional absent fields */
function clean(x) { return JSON.parse(JSON.stringify(x)); }
function deepEqualNoUndef(a, b, msg) {
  assert.deepStrictEqual(clean(a), clean(b), msg);
}

/* ------------------------------------------------------------------ RLL */

function testRllRoundTrip(name, text) {
  check("rll round-trip: " + name, () => {
    const p1 = RLLP.parseRllRung(text);
    const ser = RLLS.serializeRllRung(p1);
    const p2 = RLLP.parseRllRung(ser);
    deepEqualNoUndef(p1, p2, "round-trip mismatch for: " + text + "\n  serialized: " + ser);
  });
}

check("rll: every fixture rung parses without error", () => {
  let count = 0;
  for (const routine of sampleRll.concat(sampleProcess)) {
    for (const rung of routine.rungs) {
      const b = RLLP.parseRllRung(rung.text); // throws on error
      assert.ok(b && b.kind === "series", "rung root must be a series");
      count++;
    }
  }
  console.log("      (" + count + " fixture rungs parsed)");
});

check("rll: fixture round-trips (sampleRll + sampleProcess)", () => {
  for (const routine of sampleRll.concat(sampleProcess)) {
    for (const rung of routine.rungs) {
      const p1 = RLLP.parseRllRung(rung.text);
      const ser = RLLS.serializeRllRung(p1);
      const p2 = RLLP.parseRllRung(ser);
      deepEqualNoUndef(p1, p2, "round-trip mismatch in " + routine.name + " rung " + rung.number +
        "\n  text: " + rung.text + "\n  ser:  " + ser);
    }
  }
});

testRllRoundTrip("SOR/EOR ignored", "SOR XIC(A) EOR XIO(B) OTE(C);");
testRllRoundTrip("AFI/NOP", "AFI()NOP()OTE(X)");
testRllRoundTrip("quoted args with escaped quotes", 'CONCAT("a""b",X,Y)');
testRllRoundTrip("quoted arg with comma", 'MID("a,b",1,2,DST)');
testRllRoundTrip("single-leg bracket flattens", "[XIC(A)]");
testRllRoundTrip("nested branches", "[[XIC(A) ,XIC(B)] ,XIC(C) ]OTE(D)");
testRllRoundTrip("empty parallel leg", "XIC(A)[OTL(B) ,]");
testRllRoundTrip("literals incl negative/based", "ADD(-1,2#1010,X)SUB(16#FF,8#77,Y)");
testRllRoundTrip("bit index after dot", "XIC(SORTER[1].VFD.[CMD_RUN_BIT])OTE(Z)");
testRllRoundTrip("module tag ref", "XIC(S:FS)OTU(ALREADY_IN_LIST)");

check("rll: empty arg normalizes to '?' (GSV)", () => {
  const b = RLLP.parseRllRung("GSV(CONTROLLERDEVICE,,Status,PLC_STATUS)");
  assert.deepStrictEqual(b.items[0].args, ["CONTROLLERDEVICE", "?", "Status", "PLC_STATUS"]);
  assert.strictEqual(RLLS.serializeRllRung(b), "GSV(CONTROLLERDEVICE,?,Status,PLC_STATUS)");
});

check("rll: invalid bare token throws", () => {
  assert.throws(() => RLLP.parseRllRung("XIC(A) GARBAGE OTE(B)"), /Unexpected token/);
});

/* ------------------------------------------------------------------- ST */

check("st: every fixture ST routine parses without error", () => {
  for (const routine of sampleSt) {
    const st = STP.parseSt(routine.text); // throws on error
    assert.strictEqual(st.kind, "st");
  }
});

check("st: fixture round-trips (sampleSt)", () => {
  for (const routine of sampleSt) {
    const st = STP.parseSt(routine.text);
    const ser = STS.serializeSt(st);
    const st2 = STP.parseSt(ser);
    deepEqualNoUndef(st, st2, "ST round-trip mismatch in " + routine.name + "\n  ser: " + ser);
  }
});

const ST_COMPLEX = [
  "(* Header block comment *)",
  "FOR Y := 0 To IndexAmountOfTrackingArray BY 1 DO",
  "  IF ScanSectionNextIndex2 = 0 THEN",
  "    IF TrackingArray[2].DataTrackingArray[Y].DestinationDINT = 0 AND (TrackingArray[2].DataTrackingArray[Y].ID <> 0) THEN",
  "      DTOS(TrackingArray[2].DataTrackingArray[Y].ID, TrackingArray[2].DataTrackingArray[Y].IDstring);  //Converting ID",
  "      MID(TrackingArray[2].DataTrackingArray[Y].IDstring, 1, 1, TrackingArray[2].DataTrackingArray[Y].DestinationString);",
  "      STOD(TrackingArray[2].DataTrackingArray[Y].DestinationString, TrackingArray[2].DataTrackingArray[Y].DestinationDINT);",
  "    END_IF;",
  "  ELSIF Y > 40 THEN",
  "    CONCAT(String.SystemStatus, String.NewPackage, TrackingArray[2].DataTrackingArray[Y].InductionStatus);",
  "  ELSE",
  "    COP(TrackingArray[2].DataTrackingArray[Y].InductionStatus, EventLog.Event[EventLog.NextEventIndex], 1);",
  "  END_IF;",
  "END_FOR;",
  "IF EventLog.EventWork = 3 Then",
  "  EventDelayTMR.PRE := 100;",
  "  EventDelayTMR.TimerEnable := 1;",
  "  TONR(EventDelayTMR);",
  "End_IF;",
  "x := 16#FF AND 2#1010;",
  "y := -1 + 2 ** 3 * 4;",
  "z := 'it$'s';",
  "w := 1_000 + 1.5e3;",
  "t := T#500ms;",
  "MSG(Control := Fwd, CtrlTag := Bit);",
  "RETURN();"
].join("\n");

check("st: complex sample parses without error", () => {
  const st = STP.parseSt(ST_COMPLEX);
  const val = IR.validateIr(st);
  assert.ok(val.ok, "complex sample IR invalid: " + val.errors.join("; "));
});

check("st: complex sample round-trips", () => {
  const st = STP.parseSt(ST_COMPLEX);
  const ser = STS.serializeSt(st);
  const st2 = STP.parseSt(ser);
  deepEqualNoUndef(st, st2, "complex ST round-trip mismatch\n  ser:\n" + ser);
});

check("st: WHILE/REPEAT/CASE/EXIT parse + round-trip", () => {
  const src = [
    "WHILE W < 10 DO W := W + 1; END_WHILE;",
    "REPEAT R := R - 1; UNTIL R <= 0 END_REPEAT;",
    "CASE Sel OF 1, 2: A := 1; 3: A := 2; ELSE A := 0; END_CASE;",
    "EXIT;",
    "FOR I := 1 TO 10 DO NOP_DINT := NOP_DINT + I; END_FOR;"
  ].join("\n");
  const st = STP.parseSt(src);
  const ser = STS.serializeSt(st);
  const st2 = STP.parseSt(ser);
  deepEqualNoUndef(st, st2, "control-flow ST round-trip mismatch\n  ser:\n" + ser);
});

check("st: expression parsing (structure)", () => {
  const e = STP.parseStExpression;
  let t = e("a + b * c");
  assert.strictEqual(t.op, "+");
  assert.strictEqual(t.right.op, "*");
  t = e("a * b + c");
  assert.strictEqual(t.op, "+");
  assert.strictEqual(t.left.op, "*");
  t = e("-2 ** 2");
  assert.strictEqual(t.kind, "unary");
  assert.strictEqual(t.operand.op, "**");
  t = e("2 ** 3 ** 2");
  assert.strictEqual(t.op, "**");
  assert.strictEqual(t.right.op, "**"); // right-assoc
  t = e("NOT a AND b");
  assert.strictEqual(t.op, "AND");
  assert.strictEqual(t.left.kind, "unary");
  t = e("a = b OR c > d");
  assert.strictEqual(t.op, "OR");
  t = e("(a + b) * c");
  assert.strictEqual(t.left.kind, "paren");
  t = e("TrackingArray[1].DataTrackingArray[X].DestinationDINT");
  assert.strictEqual(t.kind, "ref");
  assert.strictEqual(t.path, "TrackingArray[1].DataTrackingArray[X].DestinationDINT");
  t = e("Network1:I.Data[2].1");
  assert.strictEqual(t.path, "Network1:I.Data[2].1");
  t = e("S:FS");
  assert.strictEqual(t.path, "S:FS");
  t = e("'a$'b'");
  assert.strictEqual(t.kind, "literal");
  assert.strictEqual(t.value, "'a$'b'");
  t = e("16#FF AND 2#1010 OR 8#77");
  assert.strictEqual(t.op, "OR");
  t = e("x ** 2 + 1");
  assert.strictEqual(t.op, "+");
  assert.strictEqual(t.left.op, "**");
});

check("st: exprToString canonical + round-trip", () => {
  const mk = (op, l, r) => IR.makeBinary(op, l, r);
  const cases = [
    [mk("-", IR.makeRef("a"), mk("-", IR.makeRef("b"), IR.makeRef("c"))), "a - (b - c)"],
    [mk("+", mk("*", IR.makeRef("a"), IR.makeRef("b")), IR.makeRef("c")), "a * b + c"],
    [mk("**", IR.makeRef("a"), mk("**", IR.makeRef("b"), IR.makeRef("c"))), "a ** b ** c"],
    [mk("**", mk("**", IR.makeRef("a"), IR.makeRef("b")), IR.makeRef("c")), "(a ** b) ** c"],
    [mk("OR", mk("AND", IR.makeRef("a"), IR.makeRef("b")), IR.makeRef("c")), "a AND b OR c"],
    [IR.makeUnary("NOT", mk("AND", IR.makeRef("a"), IR.makeRef("b"))), "NOT (a AND b)"],
    [IR.makeUnary("-", mk("**", IR.makeLiteral("2"), IR.makeLiteral("2"))), "-2 ** 2"],
    [mk("/", IR.makeRef("a"), mk("*", IR.makeRef("b"), IR.makeRef("c"))), "a / (b * c)"],
    [mk("MOD", IR.makeRef("a"), IR.makeRef("b")), "a MOD b"],
    [mk("<>", IR.makeRef("a"), IR.makeRef("b")), "a <> b"]
  ];
  for (const [expr, expected] of cases) {
    assert.strictEqual(IR.exprToString(expr), expected);
    // string-level round-trip: serialize -> parse -> serialize must be stable
    const s2 = IR.exprToString(STP.parseStExpression(expected));
    assert.strictEqual(s2, expected, "exprToString round-trip failed for " + expected);
  }
  // parse-normal-form trees deep-equal round-trip
  const nf = mk("-", mk("-", IR.makeRef("a"), IR.makeRef("b")), IR.makeRef("c"));
  assert.strictEqual(IR.exprToString(nf), "a - b - c");
  deepEqualNoUndef(STP.parseStExpression("a - b - c"), nf);
  // call expr
  const c = IR.makeCall("DTOS", [IR.makeRef("A"), IR.makeRef("B")]);
  assert.strictEqual(IR.exprToString(c), "DTOS(A, B)");
  const n = IR.makeCall("MSG", [IR.makeNamedArg("Control", IR.makeRef("Fwd"))]);
  assert.strictEqual(IR.exprToString(n), "MSG(Control := Fwd)");
});

/* ------------------------------------------------------------ validateIr */

check("validateIr: valid lad/st pass, invalid fail", () => {
  const lad = IR.makeLadIR([IR.makeRung([IR.makeInstr("XIC", "A"), IR.makeInstr("OTE", "B")],
    { number: 0 })]);
  assert.ok(IR.validateIr(lad).ok);
  const st = IR.makeStIR([IR.makeAssign("X", IR.makeBinary("+", IR.makeRef("A"), IR.makeLiteral("1")))]);
  assert.ok(IR.validateIr(st).ok);
  const badLad = { kind: "lad", rungs: [{ number: 0, type: "N", comment: null, root: { kind: "weird" } }] };
  assert.ok(!IR.validateIr(badLad).ok);
  const badSt = { kind: "st", statements: [{ kind: "assign", target: "X", value: { kind: "nope" } }] };
  assert.ok(!IR.validateIr(badSt).ok);
  const badExpr = { kind: "st", statements: [{ kind: "assign", target: "X", value: { kind: "binary", op: "??", left: { kind: "ref", path: "A" }, right: { kind: "ref", path: "B" } } }] };
  assert.ok(!IR.validateIr(badExpr).ok);
});

/* ------------------------------------------------- LAD -> ST -> LAD */

function buildLadFromFixture(routine) {
  return IR.makeLadIR(routine.rungs.map(r =>
    IR.makeRung(RLLP.parseRllRung(r.text), { number: r.number, comment: r.comment || null })));
}

const opsOf = s => (s.match(/[A-Za-z_][A-Za-z0-9_]*\(/g) || []).sort().join(",");

const warningStats = {};

check("ladToSt: statement-level mapping checks", () => {
  const one = text => LC.ladToSt(IR.makeLadIR([IR.makeRung(RLLP.parseRllRung(text), { number: 0, comment: null })]));
  let r;

  r = one("XIC(a)OTE(b)");
  assert.strictEqual(r.ir.statements.length, 1);
  assert.deepStrictEqual(clean(r.ir.statements[0]), { kind: "assign", target: "b", value: { kind: "ref", path: "a" }, comment: null });

  r = one("XIC(a)MOV(x,y)");
  assert.strictEqual(r.ir.statements[0].kind, "if");
  assert.strictEqual(r.ir.statements[0].branches[0].statements[0].kind, "assign");

  r = one("OTU(x)");
  assert.deepStrictEqual(clean(r.ir.statements[0]),
    { kind: "assign", target: "x", value: { kind: "literal", value: "0" }, comment: null });

  r = one("XIC(a)OTL(b)");
  assert.strictEqual(r.ir.statements[0].value.op, "OR");

  r = one("XIC(a)TON(t,?,?)");
  assert.strictEqual(r.ir.statements[0].kind, "if");
  assert.strictEqual(r.ir.statements[0].branches[0].statements[0].fn, "TON");

  r = one("ADD(a,b,c)");
  assert.strictEqual(r.ir.statements[0].value.op, "+");

  r = one("XIC(a)ONS(b)OTE(c)");
  assert.ok(r.warnings.some(w => w.kind === "unsupported" && /ONS/.test(w.msg)));
  assert.strictEqual(r.ir.statements.length, 2);

  r = one("XIC(a)[MOV(1,x) ,MOV(2,y) ]");
  assert.strictEqual(r.ir.statements.length, 2);

  r = one("FOR(L1,i,1,10,1)");
  assert.ok(r.warnings.some(w => /FOR\(L1\)/.test(w.msg)));
});

check("ladToSt/serializeSt/parseSt/stToLad: '?' operands survive the text pipeline", () => {
  // the app stages ST as text; ladToSt output must be re-parseable (no '?')
  const lad = IR.makeLadIR([
    IR.makeRung(RLLP.parseRllRung("XIC(Start)TON(NewTimer,?,?);"), { number: 0, comment: null }),
    IR.makeRung(RLLP.parseRllRung("GSV(CONTROLLERDEVICE,,Status,0);"), { number: 1, comment: null }),
    IR.makeRung(RLLP.parseRllRung("TONR(RetTimer,?,?);"), { number: 2, comment: null })
  ]);
  const toSt = LC.ladToSt(lad);
  const text = STS.serializeSt(toSt.ir);
  assert.ok(text.indexOf("?") === -1, "ST text must not contain '?':\n" + text);
  assert.ok(/TON\(NewTimer, NewTimer\.PRE, NewTimer\.ACC\)/.test(text), "timer PRE/ACC mapping missing:\n" + text);
  assert.ok(/GSV\(CONTROLLERDEVICE, , Status, 0\)/.test(text), "GSV empty argument missing:\n" + text);
  assert.ok(/TONR\(RetTimer, RetTimer\.PRE, RetTimer\.ACC\)/.test(text), "TONR PRE/ACC mapping missing:\n" + text);
  assert.ok(toSt.warnings.some(w => w.kind === "info" && /GSV/.test(w.msg)), "GSV empty-param info warning expected");

  const st2 = STP.parseSt(text); // must not throw
  const lad2 = LC.stToLad(st2);
  assert.ok(IR.validateIr(st2).ok);
  assert.ok(IR.validateIr(lad2.ir).ok);
  assert.strictEqual(lad2.ir.rungs.length, 3);
  // GSV empty parameter round-trips to a '?' operand in ladder text
  assert.strictEqual(RLLS.serializeRllRung(lad2.ir.rungs[1].root), "GSV(CONTROLLERDEVICE,?,Status,0)");
  // timer call round-trips with PRE/ACC operands (semantically equal to ?,?)
  assert.strictEqual(RLLS.serializeRllRung(lad2.ir.rungs[0].root),
    "XIC(Start)TON(NewTimer,NewTimer.PRE,NewTimer.ACC)");
});

check("ladToSt/stToLad: routine-level rung count + per-rung op multiset", () => {
  for (const routine of sampleRll.concat(sampleProcess)) {
    const lad = buildLadFromFixture(routine);
    const toSt = LC.ladToSt(lad);
    assert.ok(IR.validateIr(toSt.ir).ok, "ladToSt output invalid: " + routine.name);
    const back = LC.stToLad(toSt.ir);
    assert.ok(IR.validateIr(back.ir).ok, "stToLad output invalid: " + routine.name);

    const stat = { unsupported: 0, info: 0, rungs: routine.rungs.length };
    toSt.warnings.forEach(w => stat[w.kind]++);
    back.warnings.forEach(w => stat[w.kind]++);
    warningStats[routine.name] = stat;

    assert.strictEqual(back.ir.rungs.length, lad.rungs.length,
      "rung count changed in " + routine.name);
    for (let i = 0; i < lad.rungs.length; i++) {
      const origText = RLLS.serializeRllRung(lad.rungs[i].root);
      const backText = RLLS.serializeRllRung(back.ir.rungs[i].root);
      assert.strictEqual(opsOf(backText), opsOf(origText),
        "rung " + i + " op multiset changed in " + routine.name +
        "\n  orig: " + origText + "\n  back: " + backText);
      // comments survive
      assert.strictEqual(back.ir.rungs[i].comment || null, lad.rungs[i].comment || null,
        "rung " + i + " comment changed in " + routine.name);
    }
  }
});

check("ladToSt/stToLad: reconstructed branches match segment merge", () => {
  for (const routine of sampleRll.concat(sampleProcess)) {
    for (const r of routine.rungs) {
      const root = RLLP.parseRllRung(r.text);
      const one = IR.makeLadIR([IR.makeRung(root, { number: r.number, comment: r.comment || null })]);
      const toSt = LC.ladToSt(one);
      const back = LC.stToLad(toSt.ir);
      const segs = LC.segmentsOfRung(root);
      if (segs.length === 0) {
        // whole-rung fallback: reconstructed from serialized text
        assert.strictEqual(back.ir.rungs.length, 1, "no-output rung must produce one rung");
        deepEqualNoUndef(back.ir.rungs[0].root, root, "no-output rung must round-trip verbatim");
        continue;
      }
      assert.strictEqual(back.ir.rungs.length, 1, "one rung in, one rung out: " + routine.name + " rung " + r.number);
      const expected = LC.prefixMergeSegments(segs);
      deepEqualNoUndef(back.ir.rungs[0].root, expected,
        "reconstruction mismatch: " + routine.name + " rung " + r.number +
        "\n  text: " + r.text +
        "\n  back: " + RLLS.serializeRllRung(back.ir.rungs[0].root) +
        "\n  exp:  " + RLLS.serializeRllRung(expected));
    }
  }
});

/* ------------------------------------------------- ST -> LAD -> ST */

/* normalize ST statements: merge consecutive comments, hoist stmt comments,
   flatten if-chains (and nested ifs) into single-branch ifs with explicit
   conditions, canonicalize TRUE/FALSE literals, strip paren nodes,
   map return/exit to RET() calls, drop named-arg names. */
function normExpr(e) {
  if (!e) return e;
  const c = {};
  for (const k of Object.keys(e)) {
    if (k === "left" || k === "right" || k === "operand" || k === "inner") continue;
    c[k] = e[k];
  }
  switch (e.kind) {
    case "literal": c.value = e.value.toUpperCase() === "TRUE" ? "1" : e.value.toUpperCase() === "FALSE" ? "0" : e.value; break;
    case "paren": return normExpr(e.inner);
    case "unary": {
      // NOT over a comparison normalizes to the inverse comparison (negateBranch)
      const INV = { "=": "<>", "<>": "=", ">": "<=", ">=": "<", "<": ">=", "<=": ">" };
      if (e.op === "NOT" && e.operand && e.operand.kind === "binary" && INV[e.operand.op]) {
        const c = normExpr(e.operand);
        c.op = INV[e.operand.op];
        return c;
      }
      c.operand = normExpr(e.operand);
      break;
    }
    case "binary": c.left = normExpr(e.left); c.right = normExpr(e.right); break;
    case "call": c.args = e.args.map(a => normExpr(a && a.kind === "namedArg" ? a.value : a)); break;
    case "namedArg": return normExpr(e.value);
  }
  return c;
}
function pushComment(out, text) {
  const last = out.length ? out[out.length - 1] : null;
  if (last && last.kind === "comment") last.text = last.text + "\n" + text;
  else out.push({ kind: "comment", text: text });
}
function flattenIfs(stmts, baseCond, out) {
  for (const s of stmts) {
    if (!s) continue;
    if (s.kind === "comment") { pushComment(out, s.text); continue; }
    if (s.kind === "if") {
      const conds = s.branches.map(b => b.cond ? normExpr(b.cond) : null);
      if (s.comment) pushComment(out, s.comment);
      s.branches.forEach((b, i) => {
        const parts = [];
        if (conds[i]) parts.push(conds[i]);
        for (let j = 0; j < i; j++) {
          if (conds[j]) parts.push({ kind: "unary", op: "NOT", operand: conds[j] });
        }
        let c = parts.length ? parts.reduce((acc, x) => ({ kind: "binary", op: "AND", left: acc, right: x })) : null;
        c = normExpr(c);
        if (baseCond) c = c ? normExpr({ kind: "binary", op: "AND", left: baseCond, right: c }) : baseCond;
        flattenIfs(b.statements, c, out);
      });
      continue;
    }
    if (s.kind === "for" || s.kind === "while" || s.kind === "repeat" || s.kind === "case") {
      if (s.comment) pushComment(out, s.comment);
      if (s.kind === "for") {
        const body = [];
        flattenIfs(s.statements, null, body);
        out.push({ kind: "for", index: s.index, from: normExpr(s.from), to: normExpr(s.to),
          by: s.by ? normExpr(s.by) : null, statements: body });
      } else if (s.kind === "while" || s.kind === "repeat") {
        const body = [];
        flattenIfs(s.statements, null, body);
        out.push(s.kind === "while"
          ? { kind: "while", cond: normExpr(s.cond), statements: body }
          : { kind: "repeat", cond: normExpr(s.cond), statements: body });
      } else {
        const cases = s.cases.map(c => {
          const body = [];
          flattenIfs(c.statements, null, body);
          return { labels: c.labels.map(normExpr), statements: body };
        });
        const els = s.elseStatements ? (() => { const b = []; flattenIfs(s.elseStatements, null, b); return b; })() : null;
        out.push({ kind: "case", expr: normExpr(s.expr), cases: cases, elseStatements: els });
      }
      continue;
    }
    if (s.kind === "assign") {
      if (s.comment) pushComment(out, s.comment);
      const stmt = { kind: "assign", target: s.target, value: normExpr(s.value) };
      if (baseCond) out.push({ kind: "if", branches: [{ cond: baseCond, statements: [stmt] }] });
      else out.push(stmt);
      continue;
    }
    if (s.kind === "call") {
      if (s.comment) pushComment(out, s.comment);
      const stmt = {
        kind: "call", fn: s.fn,
        args: s.args.map(a => normExpr(a && a.kind === "namedArg" ? a.value : a))
      };
      if (baseCond) out.push({ kind: "if", branches: [{ cond: baseCond, statements: [stmt] }] });
      else out.push(stmt);
      continue;
    }
    if (s.kind === "return" || s.kind === "exit") {
      const stmt = { kind: "call", fn: "RET", args: [] };
      if (baseCond) out.push({ kind: "if", branches: [{ cond: baseCond, statements: [stmt] }] });
      else out.push(stmt);
      continue;
    }
    if (s.kind === "empty") continue;
    out.push(JSON.parse(JSON.stringify(s)));
  }
  return out;
}
function normStmts(stmts) { return flattenIfs(stmts, null, []); }

check("stToLad/ladToSt: fixture ST round-trips", () => {
  for (const routine of sampleSt) {
    const st = STP.parseSt(routine.text);
    const lad = LC.stToLad(st);
    assert.ok(IR.validateIr(lad.ir).ok, "stToLad output invalid: " + routine.name);
    const back = LC.ladToSt(lad.ir);
    assert.ok(IR.validateIr(back.ir).ok, "ladToSt output invalid: " + routine.name);
    const expected = normStmts(st.statements, []);
    const got = normStmts(back.ir.statements, []);
    deepEqualNoUndef(got, expected, "ST round-trip mismatch in " + routine.name);
  }
});

check("stToLad/ladToSt: complex sample round-trips (normalized)", () => {
  const st = STP.parseSt(ST_COMPLEX);
  const lad = LC.stToLad(st);
  assert.ok(IR.validateIr(lad.ir).ok);
  const back = LC.ladToSt(lad.ir);
  assert.ok(IR.validateIr(back.ir).ok);
  const expected = normStmts(st.statements, []);
  const got = normStmts(back.ir.statements, []);
  deepEqualNoUndef(got, expected, "complex ST round-trip mismatch\n" +
    "  got:\n" + STS.serializeSt(back.ir));
});

check("stToLad/ladToSt: De Morgan NOT distributes (documented)", () => {
  const st = STP.parseSt("b := NOT (a AND c);");
  const lad = LC.stToLad(st);
  const back = LC.ladToSt(lad.ir);
  const txt = STS.serializeSt(back.ir);
  assert.strictEqual(txt, "b := NOT a OR NOT c;");
});

check("stToLad: WHILE/REPEAT/CASE/EXIT never silently dropped", () => {
  const src = "WHILE W < 10 DO W := W + 1; END_WHILE;\n" +
    "REPEAT R := R - 1; UNTIL R <= 0 END_REPEAT;\n" +
    "CASE Sel OF 1, 2: A := 1; 3: A := 2; ELSE A := 0; END_CASE;\n" +
    "EXIT;\n";
  const st = STP.parseSt(src);
  const lad = LC.stToLad(st);
  assert.ok(IR.validateIr(lad.ir).ok);
  const back = LC.ladToSt(lad.ir);
  assert.ok(IR.validateIr(back.ir).ok);
  const backText = STS.serializeSt(back.ir);
  for (const op of ["W", "R", "Sel", "A"]) {
    assert.ok(backText.indexOf(op) !== -1, "tag " + op + " dropped from control-flow conversion");
  }
  const kinds = { info: 0, unsupported: 0 };
  lad.warnings.forEach(w => kinds[w.kind]++);
  assert.ok(kinds.unsupported >= 1, "EXIT must warn");
  assert.ok(kinds.info >= 3, "WHILE/REPEAT/CASE must warn (info)");
});

/* ------------------------------------------------------------ dataflow */

check("dataflow: buildRoutineDataflow on fixture LAD + ST (no dangling edges)", () => {
  const lad = buildLadFromFixture(sampleRll[0]);
  const g1 = DF.buildRoutineDataflow(lad, { routineName: "MAIN_TASK_MAIN" });
  const ids1 = new Set(g1.nodes.map(n => n.id));
  assert.ok(g1.nodes.length > 5, "expected nodes");
  for (const e of g1.edges) {
    assert.ok(ids1.has(e.from), "dangling edge from " + e.from);
    assert.ok(ids1.has(e.to), "dangling edge to " + e.to);
  }
  const st = STP.parseSt(sampleSt[1].text);
  const g2 = DF.buildRoutineDataflow(st, { routineName: "MappedIO" });
  const ids2 = new Set(g2.nodes.map(n => n.id));
  assert.ok(g2.nodes.length > 5, "expected ST nodes");
  for (const e of g2.edges) {
    assert.ok(ids2.has(e.from), "dangling edge from " + e.from);
    assert.ok(ids2.has(e.to), "dangling edge to " + e.to);
  }
  // simplify: one node per (kind, operand)
  const reads = g2.nodes.filter(n => n.kind === "tag-read" && n.tag === "Network1:I.Data[2].1");
  assert.strictEqual(reads.length, 1, "duplicate tag-read nodes despite simplify");
});

check("dataflow: buildTagWeb on a hand-built model", () => {
  const model = {
    programs: [
      {
        name: "MainProg",
        routines: [
          {
            name: "MainRung", type: "RLL",
            content: {
              kind: "rll",
              rungs: [
                { number: "0", type: "N", comment: null, text: "XIC(Start)MOV(InVal,OutVal);" },
                { number: "1", type: "N", comment: null, text: "XIC(Go)ADD(InVal,2,SumVal)OTE(Done);" },
                { number: "2", type: "N", comment: null, text: "XIC(Network1:I.Data[0].0)OTE(OutBit);" }
              ]
            }
          },
          {
            name: "Calc", type: "ST",
            content: { kind: "st", text: "Result := InVal + Offset;\nCOP(Result, Buff, 4);\nLocalVal := 1;\nTONR(DelayTMR);\n" }
          }
        ]
      }
    ],
    tags: {
      controller: ["Start", "InVal", "OutVal", "Go", "SumVal", "Done", "OutBit", "Result", "Buff", "Offset", "DelayTMR"]
        .map(name => ({ name: name })),
      programs: { MainProg: [{ name: "LocalVal" }] }
    },
    modules: []
  };
  const g = DF.buildTagWeb(model);
  const byId = {};
  for (const n of g.nodes) byId[n.id] = n;
  const ids = new Set(g.nodes.map(n => n.id));

  assert.ok(byId["tag|controller|Start"], "controller tag node missing");
  assert.strictEqual(byId["tag|controller|Start"].kind, "tag-read");
  assert.strictEqual(byId["tag|controller|OutVal"].kind, "tag-write");
  assert.strictEqual(byId["tag|controller|InVal"].kind, "tag-read");
  assert.strictEqual(byId["tag|controller|SumVal"].kind, "tag-write");
  assert.strictEqual(byId["tag|controller|Done"].kind, "tag-write");
  assert.strictEqual(byId["tag|controller|Result"].kind, "tag-readwrite"); // written by assign, read by COP
  assert.strictEqual(byId["tag|controller|Buff"].kind, "tag-write");
  assert.strictEqual(byId["tag|controller|Offset"].kind, "tag-read");
  assert.strictEqual(byId["tag|controller|DelayTMR"].kind, "tag-readwrite"); // TONR reads+writes arg 0
  assert.ok(byId["tag|program:MainProg|LocalVal"], "program tag node missing");
  assert.strictEqual(byId["tag|program:MainProg|LocalVal"].kind, "tag-write");
  assert.ok(byId["tag|module|Network1:I"], "module tag node missing");
  assert.strictEqual(byId["tag|module|Network1:I"].kind, "tag-read");
  // literals omitted
  assert.ok(!byId["tag|controller|2"], "literal must not create a tag node");
  assert.ok(!byId["tag|controller|1"], "literal must not create a tag node");
  // data edges: MOV InVal->OutVal, ADD InVal->SumVal, InVal/Offset->Result, COP Result->Buff
  const edge = (a, b) => g.edges.some(e => e.from === "tag|controller|" + a && e.to === "tag|controller|" + b);
  assert.ok(edge("InVal", "OutVal"), "missing InVal->OutVal edge");
  assert.ok(edge("InVal", "SumVal"), "missing InVal->SumVal edge");
  assert.ok(edge("InVal", "Result"), "missing InVal->Result edge");
  assert.ok(edge("Offset", "Result"), "missing Offset->Result edge");
  assert.ok(edge("Result", "Buff"), "missing Result->Buff edge");
  // no dangling edges
  for (const e of g.edges) {
    assert.ok(ids.has(e.from), "dangling tag-web edge from " + e.from);
    assert.ok(ids.has(e.to), "dangling tag-web edge to " + e.to);
  }
});

/* ---------------------------------------------------------------- summary */

console.log("");
console.log("=== warning summary per fixture routine (whole-routine conversions) ===");
const hdr = "routine".padEnd(32) + "rungs".padStart(6) + "unsupported".padStart(13) + "info".padStart(7);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const routine of sampleRll.concat(sampleProcess)) {
  const s = warningStats[routine.name];
  if (!s) continue;
  console.log(routine.name.padEnd(32) + String(s.rungs).padStart(6) +
    String(s.unsupported).padStart(13) + String(s.info).padStart(7));
}
console.log("");
console.log("checks run: " + checks + ", failures: " + failures);
if (failures > 0) {
  console.error("FAILED");
  process.exitCode = 1;
} else {
  console.log("ALL TESTS PASSED");
}
