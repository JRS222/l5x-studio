/* L5X Studio - test/t2-editors.test.js (T2). Node tests for FBD support, graph layout,
   renderers and the three editors. Run: node test/t2-editors.test.js (exit non-zero on failure). */
"use strict";
const assert = require("node:assert");
const fbdParse = require("../js/fbd-parse.js");
const fbdSer = require("../js/fbd-serialize.js");
const fbdConv = require("../js/fbd-convert.js");
const layout = require("../js/graph-layout.js");
const svgMod = require("../js/render/svg.js");
const diagram = require("../js/render/diagram.js");
const ladder = require("../js/render/ladder.js");
const fbdRender = require("../js/render/fbd.js");
const stEditor = require("../js/ui/editor-st.js");
const sampleRll = require("./fixtures/sampleRll-rll.json");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok   - " + name);
  } catch (e) {
    failures++;
    console.error("FAIL - " + name);
    console.error("       " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e));
  }
}

/* ---- self-contained RLL neutral-text parser/serializer (mirrors CONTRACT section 2;
        used because T1's rll modules may still be stubs) ---- */
function parseRllText(text) {
  let s = String(text).replace(/;\s*$/, "").trim();
  let i = 0;
  function skipWs() { while (i < s.length && /\s/.test(s[i])) i++; }
  function parseInstr() {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(s.slice(i));
    if (!m) throw new Error("bad instruction at " + i + ": " + s.slice(i, i + 30));
    i += m[0].length;
    const args = [];
    for (;;) {
      skipWs();
      if (s[i] === ")") { i++; break; }
      args.push(parseArg());
      skipWs();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === ")") { i++; break; }
      throw new Error("bad argument list at " + i);
    }
    return { op: m[1], args: args };
  }
  function parseArg() {
    let arg = "";
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) { arg += s[i + 1]; i += 2; continue; }
        arg += s[i++];
      }
      if (s[i] === '"') i++;
      return '"' + arg + '"';
    }
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "[") depth++;
      if (c === "]") depth--;
      if ((c === "," || c === ")") && depth === 0) break;
      arg += c;
      i++;
    }
    return arg.trim();
  }
  function parseLegList() {
    const legs = [];
    for (;;) {
      legs.push(parseBranch());
      skipWs();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") { i++; break; }
      throw new Error("bad branch list at " + i);
    }
    return { kind: "parallel", legs: legs };
  }
  function parseBranch() {
    skipWs();
    const items = [];
    while (i < s.length) {
      skipWs();
      if (s[i] === "]") { i++; break; }
      if (s[i] === "[") { i++; items.push(parseLegList()); continue; }
      items.push(parseInstr());
    }
    return { kind: "series", items: items };
  }
  skipWs();
  return parseBranch();
}
function serializeRll(branch) {
  if (branch.kind === "parallel") {
    return "[" + branch.legs.map(serializeRll).join(" ,") + " ]";
  }
  return branch.items.map(function (it) {
    if (it.kind) return serializeRll(it);
    return it.op + "(" + (it.args || []).join(",") + ")";
  }).join("");
}
function walkBranch(branch, cb) {
  if (branch.kind === "series") {
    for (const it of branch.items || []) { if (it.kind) walkBranch(it, cb); else cb(it); }
  } else {
    for (const leg of branch.legs || []) walkBranch(leg, cb);
  }
}
function rungSignature(root) {
  const ops = [];
  const operands = [];
  walkBranch(root, function (instr) {
    ops.push(instr.op);
    for (const a of instr.args || []) if (a !== "?" && a !== "") operands.push(a);
  });
  return { ops: ops.join("|"), operands: operands.slice().sort().join("|") };
}
function mkRung(number, items) {
  return { number: number, type: "N", comment: null, root: { kind: "series", items: items } };
}
function mkInstr(op, args) { return { op: op, args: args }; }
function mkParallel(legs) {
  return { kind: "parallel", legs: legs.map(function (l) { return { kind: "series", items: l }; }) };
}

/* ---- 1. FBD XML round-trip on a hand-built fbdIR ---- */
const HAND_FBD = {
  kind: "fbd",
  sheetSize: "Letter (8.5x11in)",
  sheetOrientation: "Landscape",
  sheets: [{
    number: "1",
    /* canonical order (mirrors serializeFbdXml grouping): IRef*, ORef*, Block*... */
    blocks: [
      { kind: "iref", id: "0", x: 40, y: 40, operand: "Start" },
      { kind: "iref", id: "1", x: 40, y: 180, operand: "Stop" },
      { kind: "iref", id: "2", x: 40, y: 320, operand: "Run" },
      { kind: "oref", id: "8", x: 1340, y: 120, operand: "Done" },
      { kind: "block", type: "AND", id: "3", x: 300, y: 100, visiblePins: ["In1", "In2", "Out"] },
      { kind: "block", type: "NOT", id: "4", x: 300, y: 200, visiblePins: ["In", "Out"] },
      { kind: "block", type: "OR", id: "5", x: 560, y: 120, visiblePins: ["In1", "In2", "Out"] },
      { kind: "block", type: "TON", id: "6", x: 820, y: 120, operand: "RunTimer", visiblePins: ["EnableIn", "PRE", "Reset", "ACC", "DN"] },
      { kind: "block", type: "MOV", id: "7", x: 1080, y: 120, operand: "OutTag", visiblePins: ["In", "Out"], raw: { Vendor: "Acme" } }
    ],
    wires: [
      { from: { id: "0" }, to: { id: "3", param: "In1" } },
      { from: { id: "1" }, to: { id: "3", param: "In2" } },
      { from: { id: "2" }, to: { id: "4", param: "In" } },
      { from: { id: "3", param: "Out" }, to: { id: "5", param: "In1" } },
      { from: { id: "4", param: "Out" }, to: { id: "5", param: "In2" } },
      { from: { id: "5", param: "Out" }, to: { id: "6", param: "EnableIn" } },
      { from: { id: "6", param: "DN" }, to: { id: "7", param: "In" } },
      { from: { id: "7", param: "Out" }, to: { id: "8" } },
      { from: { id: "6", param: "ACC" }, to: { id: "6", param: "PRE" }, feedback: true }
    ],
    textBoxes: [{ id: "9", x: 200, y: 20, width: "0", text: "Main flow" }],
    attachments: [{ from: "9", to: "3" }]
  }]
};

test("fbd XML: serialize -> parse deep-equals hand-built fbdIR", function () {
  const xml = fbdSer.serializeFbdXml(HAND_FBD);
  const back = fbdParse.parseFbdXml(xml);
  assert.deepStrictEqual(back, HAND_FBD);
});

test("fbd XML: FBDContent header and manual element order within Sheet", function () {
  const xml = fbdSer.serializeFbdXml(HAND_FBD);
  assert.ok(xml.indexOf('<FBDContent SheetSize="Letter (8.5x11in)" SheetOrientation="Landscape">') === 0);
  assert.ok(xml.indexOf('<Sheet Number="1">') !== -1);
  const pos = function (needle) { return xml.indexOf(needle); };
  assert.ok(pos("<IRef") < pos("<ORef"));
  assert.ok(pos("<ORef") < pos("<Block"));
  assert.ok(pos("<Block") < pos("<Wire"));
  assert.ok(pos("<Wire") < pos("<FeedbackWire"));
  assert.ok(pos("<FeedbackWire") < pos("<TextBox"));
  assert.ok(pos("<TextBox") < pos("<Attachment"));
  /* IRef source pin omits FromParam; ORef target omits ToParam */
  assert.ok(xml.indexOf('<Wire FromID="0" ToID="3" ToParam="In1"/>') !== -1);
  assert.ok(xml.indexOf('FromID="7" FromParam="Out" ToID="8"') !== -1);
  /* unknown attribute preserved */
  assert.ok(xml.indexOf('Vendor="Acme"') !== -1);
});

test("fbd XML: parse tolerates a full <Routine> wrapper", function () {
  const xml = fbdSer.serializeFbdXml(HAND_FBD);
  const wrapped = '<Routine Name="R1" Type="FBD">' + xml + "</Routine>";
  const back = fbdParse.parseFbdXml(wrapped);
  assert.deepStrictEqual(back, HAND_FBD);
});

/* ---- 2. LAD <-> FBD round trips on synthetic rungs ---- */
test("ladToFbd/fbdToLad: XIC(a)XIC(b)OTE(c) round-trips structurally", function () {
  const lad = { kind: "lad", rungs: [mkRung(0, [mkInstr("XIC", ["a"]), mkInstr("XIC", ["b"]), mkInstr("OTE", ["c"])])] };
  const fbd = fbdConv.ladToFbd(lad);
  assert.strictEqual(fbd.ir.kind, "fbd");
  const back = fbdConv.fbdToLad(fbd.ir);
  assert.deepStrictEqual(back.ir.rungs, lad.rungs);
});

test("ladToFbd/fbdToLad: XIC(a)[XIC(b),XIC(c)]OTE(d) round-trips structurally", function () {
  const lad = {
    kind: "lad",
    rungs: [mkRung(0, [
      mkInstr("XIC", ["a"]),
      mkParallel([[mkInstr("XIC", ["b"])], [mkInstr("XIC", ["c"])]]),
      mkInstr("OTE", ["d"])
    ])]
  };
  const fbd = fbdConv.ladToFbd(lad);
  const back = fbdConv.fbdToLad(fbd.ir);
  assert.deepStrictEqual(back.ir.rungs, lad.rungs);
});

test("ladToFbd/fbdToLad: MOV(src,dst) rung round-trips structurally", function () {
  const lad = { kind: "lad", rungs: [mkRung(0, [mkInstr("MOV", ["src", "dst"])])] };
  const fbd = fbdConv.ladToFbd(lad);
  const back = fbdConv.fbdToLad(fbd.ir);
  assert.deepStrictEqual(back.ir.rungs, lad.rungs);
});

test("ladToFbd/fbdToLad: XIC(t.en)TON(t,?,?) round-trips structurally", function () {
  const lad = { kind: "lad", rungs: [mkRung(0, [mkInstr("XIC", ["t.en"]), mkInstr("TON", ["t", "?", "?"])])] };
  const fbd = fbdConv.ladToFbd(lad);
  const back = fbdConv.fbdToLad(fbd.ir);
  assert.deepStrictEqual(back.ir.rungs, lad.rungs);
});

test("ladToFbd: conditioned MOV warns about approximated enable semantics", function () {
  const lad = { kind: "lad", rungs: [mkRung(0, [mkInstr("XIC", ["a"]), mkInstr("MOV", ["s", "d"])])] };
  const fbd = fbdConv.ladToFbd(lad);
  assert.ok(fbd.warnings.length >= 1, "expected an enable-approximation warning");
  assert.ok(/approximat/i.test(fbd.warnings[0].msg));
  const back = fbdConv.fbdToLad(fbd.ir);
  const sig1 = rungSignature(lad.rungs[0].root);
  const sig2 = rungSignature(back.ir.rungs[0].root);
  assert.strictEqual(sig1.ops, sig2.ops);
  assert.strictEqual(sig1.operands, sig2.operands);
});

test("ladToFbd: unknown op becomes a generic block (never dropped) with a warning", function () {
  const lad = { kind: "lad", rungs: [mkRung(0, [mkInstr("CONCAT", ["A", "B", "Dest"])])] };
  const fbd = fbdConv.ladToFbd(lad);
  const blocks = fbd.ir.sheets[0].blocks;
  assert.ok(blocks.some(function (b) { return b.type === "CONCAT"; }), "CONCAT block must exist");
  assert.ok(fbd.warnings.length >= 1);
});

/* ---- 3. graphLayout ---- */
test("graphLayout: 12-node chain/branch graph, finite positions, no NaN, cycle broken by back edges", function () {
  const graph = {
    nodes: ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]
      .map(function (id) { return { id: id, label: id }; }),
    edges: [
      { from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" },
      { from: "n3", to: "n4" }, { from: "n4", to: "n5" },
      { from: "n1", to: "n6" }, { from: "n6", to: "n7" }, { from: "n7", to: "n8" },
      { from: "n8", to: "n9" }, { from: "n9", to: "n10" },
      { from: "n3", to: "n11" },
      { from: "n10", to: "n2" },   /* backward (non-cycle) reference: tolerated, layout stays finite */
      { from: "n5", to: "n1" }     /* closes the cycle n1->n2->n3->n4->n5->n1 */
    ]
  };
  const cyclePairs = [
    ["n1", "n2"], ["n2", "n3"], ["n3", "n4"], ["n4", "n5"], ["n5", "n1"]
  ];
  const out = layout.graphLayout(graph, {});
  assert.strictEqual(out.nodes.length, 12);
  assert.strictEqual(out.edges.length, 13, "no edges dropped");
  for (const n of out.nodes) {
    assert.ok(Number.isFinite(n.x), "x finite for " + n.id);
    assert.ok(Number.isFinite(n.y), "y finite for " + n.id);
    assert.ok(Number.isFinite(n.w) && Number.isFinite(n.h));
    assert.ok(n.x >= 0 && n.y >= 0, "positions non-negative");
    assert.ok(n.x + n.w <= out.width + 0.001, "within width");
    assert.ok(n.y + n.h <= out.height + 0.001, "within height");
  }
  assert.ok(Number.isFinite(out.width) && out.width > 0);
  assert.ok(Number.isFinite(out.height) && out.height > 0);
  /* the cycle must be broken by marking at least one of its edges as a back edge,
     and every cycle edge must still be present in the output */
  let markedInCycle = 0;
  for (const pair of cyclePairs) {
    const e = out.edges.filter(function (x) { return x.from === pair[0] && x.to === pair[1]; })[0];
    assert.ok(e, "cycle edge " + pair[0] + "->" + pair[1] + " kept");
    if (e.back) markedInCycle++;
  }
  assert.ok(markedInCycle >= 1, "at least one cycle edge marked as back");
  /* layering: n5 must be deeper (further right) than n0 */
  const n0 = out.nodes.filter(function (n) { return n.id === "n0"; })[0];
  const n5 = out.nodes.filter(function (n) { return n.id === "n5"; })[0];
  assert.ok(n5.x > n0.x, "downstream node placed further right");
});

test("graphLayout: TB direction swaps axes", function () {
  const graph = { nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] };
  const out = layout.graphLayout(graph, { direction: "TB" });
  const a = out.nodes.filter(function (n) { return n.id === "a"; })[0];
  const b = out.nodes.filter(function (n) { return n.id === "b"; })[0];
  assert.ok(b.y > a.y, "downstream node placed lower");
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
});

/* ---- 4. ladderLayout geometry ---- */
test("ladderLayout: sane geometry, no overlaps, rails present", function () {
  const rung = mkRung(0, [
    mkInstr("XIC", ["a"]),
    mkParallel([[mkInstr("XIC", ["b"])], [mkInstr("XIC", ["c"])]]),
    mkInstr("OTE", ["d"])
  ]);
  const cells = ladder.ladderLayout(rung);
  assert.strictEqual(cells.length, 6, "4 instruction cells + 2 brackets");
  for (const c of cells) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.w) && Number.isFinite(c.h));
    assert.ok(c.w > 0 && c.h > 0);
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, "no overlap between cell " + a.id + " and " + b.id);
    }
  }
  assert.ok(cells.width > 0 && cells.height > 0);
  assert.ok(cells.rails && cells.rails.left && cells.rails.right);
  assert.ok(cells.rails.right.x > cells.rails.left.x);
  /* coils at the end: the OTE cell sits right of all XIC cells in the main row */
  const coil = cells.filter(function (c) { return c.kind === "coil"; })[0];
  assert.ok(coil, "OTE rendered as a coil");
  const conds = cells.filter(function (c) { return c.kind === "instr"; });
  for (const c of conds) assert.ok(c.x < coil.x, "coil right of conditions");
});

/* ---- 5. annotateStErrors ---- */
test("annotateStErrors: reports line-numbered errors for a bad snippet", function () {
  const errors = stEditor.annotateStErrors("IF x THEN\n  y := 1;\nEND_IF\nz := ;");
  assert.ok(Array.isArray(errors) && errors.length >= 1, "errors reported");
  for (const e of errors) {
    assert.ok(Number.isInteger(e.line) && e.line >= 1, "line number present");
    assert.ok(Number.isInteger(e.col) && e.col >= 1, "col number present");
    assert.strictEqual(typeof e.msg, "string");
  }
});

test("annotateStErrors: clean snippet yields no errors", function () {
  const errors = stEditor.annotateStErrors("y := 1;\nIF x THEN\n  y := 2;\nEND_IF\n");
  assert.deepStrictEqual(errors, []);
});

/* ---- 6. edgePath ---- */
test("edgePath: valid bezier path strings, LR and TB, NaN-safe", function () {
  const p1 = svgMod.edgePath(0, 0, 100, 50, "LR");
  assert.match(p1, /^M -?\d+(\.\d+)? -?\d+(\.\d+)? /);
  assert.ok(p1.indexOf("C") !== -1, "has cubic control points");
  assert.ok(p1.indexOf("NaN") === -1);
  const p2 = svgMod.edgePath(10, 10, 30, 90, "TB");
  assert.ok(p2.indexOf("C") !== -1);
  assert.ok(p2.indexOf("NaN") === -1);
  const p3 = svgMod.edgePath(NaN, undefined, 10, 20, "LR");
  assert.ok(p3.indexOf("NaN") === -1, "NaN inputs coerced to 0");
  assert.match(p3, /^M /);
});

/* ---- 7. computeDiagramLayout ---- */
test("computeDiagramLayout: pure layout of a small graph", function () {
  const graph = {
    nodes: [{ id: "a", label: "A", kind: "tag-read", tag: "A" }, { id: "b", label: "B", kind: "func", op: "MOV" }, { id: "c", label: "C", kind: "tag-write", tag: "C" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }]
  };
  const out = diagram.computeDiagramLayout(graph, {});
  assert.strictEqual(out.nodes.length, 3);
  for (const n of out.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.w) && Number.isFinite(n.h));
  }
  assert.ok(out.width > 0 && out.height > 0);
  assert.strictEqual(out.edges.length, 2);
});

/* ---- 8. real fixture rung: LAD -> FBD -> LAD equivalence ---- */
test("fixture sampleRll rung 0 converts LAD->FBD->LAD with same ops and operand multiset", function () {
  const text = sampleRll[0].rungs[0].text;
  const root = parseRllText(text);
  const lad = { kind: "lad", rungs: [{ number: 0, type: "N", comment: null, root: root }] };
  const fbd = fbdConv.ladToFbd(lad);
  const back = fbdConv.fbdToLad(fbd.ir);
  assert.strictEqual(back.ir.rungs.length, 1);
  const s1 = rungSignature(root);
  const s2 = rungSignature(back.ir.rungs[0].root);
  assert.strictEqual(s1.ops, s2.ops);
  assert.strictEqual(s1.operands, s2.operands);
  assert.strictEqual(serializeRll(back.ir.rungs[0].root), serializeRll(root));
  assert.strictEqual(serializeRll(root), "XIC(NEW_JOB_TOGGLE)TON(NEW_JOB_TIMER,?,?)");
});

/* ---- 9. editors construct and mutate without a DOM ---- */
test("editors construct in Node without a DOM and support IR mutations", function () {
  let ladderChanges = 0;
  const led = new ladder.LadderEditor({
    ir: { kind: "lad", rungs: [mkRung(0, [mkInstr("XIC", ["a"])])] },
    onChange: function () { ladderChanges++; }
  });
  led.addRung(0);
  assert.strictEqual(led.getIR().rungs.length, 2);
  assert.ok(ladderChanges >= 1);
  led.insertInstr(0, [{ item: 0 }], mkInstr("XIO", ["b"]));
  assert.strictEqual(led.getIR().rungs[0].root.items.length, 2);
  assert.strictEqual(led.getIR().rungs[0].root.items[1].op, "XIO");
  led.setOperand(0, [{ item: 1 }], 0, "c");
  assert.strictEqual(led.getIR().rungs[0].root.items[1].args[0], "c");
  led.addParallelLeg(0, [{ item: 0 }]);
  assert.strictEqual(led.getIR().rungs[0].root.items[0].kind, "parallel");
  assert.strictEqual(led.getIR().rungs[0].root.items[0].legs.length, 2);
  led.deleteParallelLeg(0, [{ item: 0 }], 1);
  assert.strictEqual(led.getIR().rungs[0].root.items[0].legs.length, 1);
  led.deleteInstr(0, [{ item: 1 }]);
  assert.strictEqual(led.getIR().rungs[0].root.items.length, 1);
  led.deleteRung(0);
  assert.strictEqual(led.getIR().rungs.length, 1);

  let fbdChanges = 0;
  const fed = new fbdRender.FbdEditor({
    ir: JSON.parse(JSON.stringify(HAND_FBD)),
    onChange: function () { fbdChanges++; }
  });
  const added = fed.addBlock("ADD");
  assert.ok(added.id !== undefined);
  assert.ok(fed.getIR().sheets[0].blocks.some(function (b) { return b.type === "ADD"; }));
  assert.ok(fbdChanges >= 1);
  fed.deleteSelection();
  assert.ok(!fed.getIR().sheets[0].blocks.some(function (b) { return b.type === "ADD"; }));

  let stChanges = 0, diagCalls = 0;
  const sed = new stEditor.StEditor({
    ir: { kind: "st", statements: [{ kind: "assign", target: "x", value: { kind: "literal", value: "1" } }] },
    onChange: function () { stChanges++; },
    onDiagnostics: function () { diagCalls++; }
  });
  assert.strictEqual(typeof sed.getIR, "function");
  assert.strictEqual(typeof sed.getContent, "function");
  assert.strictEqual(typeof sed.setIR, "function");
  sed.setIR(sed.getIR());
});

/* ---- 10. pure FBD helpers ---- */
test("fbdPins: known block pin conventions", function () {
  const ton = fbdRender.fbdPins({ kind: "block", type: "TON" });
  const names = ton.pins.map(function (p) { return p.name; });
  assert.ok(names.indexOf("EnableIn") !== -1 && names.indexOf("PRE") !== -1 && names.indexOf("DN") !== -1);
  const enable = ton.pins.filter(function (p) { return p.name === "EnableIn"; })[0];
  assert.strictEqual(enable.side, "in");
  assert.strictEqual(enable.x, 0);
  const dn = ton.pins.filter(function (p) { return p.name === "DN"; })[0];
  assert.strictEqual(dn.side, "out");
  assert.ok(dn.x > 0);
  const and = fbdRender.fbdPins({ kind: "block", type: "AND" });
  const andNames = and.pins.map(function (p) { return p.name; });
  assert.deepStrictEqual(andNames.slice().sort(), ["In1", "In2", "Out"]);
  const iref = fbdRender.fbdPins({ kind: "iref" });
  assert.strictEqual(iref.pins.length, 1);
  assert.strictEqual(iref.pins[0].side, "out");
  for (const p of iref.pins) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("fbdAutoLayout: x increases with dataflow depth, ids unique", function () {
  const sheet = {
    blocks: [
      { kind: "iref", id: "0", x: 0, y: 0, operand: "a" },
      { kind: "iref", id: "1", x: 0, y: 0, operand: "b" },
      { kind: "block", type: "AND", id: "2", x: 0, y: 0 },
      { kind: "oref", id: "3", x: 0, y: 0, operand: "c" },
      { kind: "oref", id: undefined, x: 0, y: 0, operand: "z" }
    ],
    wires: [
      { from: { id: "0" }, to: { id: "2", param: "In1" } },
      { from: { id: "1" }, to: { id: "2", param: "In2" } },
      { from: { id: "2", param: "Out" }, to: { id: "3" } }
    ]
  };
  const out = fbdRender.fbdAutoLayout(sheet, {});
  for (const b of out.blocks) assert.ok(b.id !== undefined, "every block has an id");
  const ids = new Set(out.blocks.map(function (b) { return String(b.id); }));
  assert.strictEqual(ids.size, out.blocks.length, "ids unique");
  const byId = {};
  out.blocks.forEach(function (b) { byId[String(b.id)] = b; });
  assert.ok(byId["2"].x > byId["0"].x, "gate right of its input");
  assert.ok(byId["3"].x > byId["2"].x, "oref right of the gate");
  for (const b of out.blocks) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
  }
});

/* ---- 11. FBD <-> ST composition + dataflow ---- */
test("fbdToSt / stToFbd compose through LAD without throwing", function () {
  const st = fbdConv.fbdToSt(HAND_FBD);
  assert.strictEqual(st.ir.kind, "st");
  assert.ok(Array.isArray(st.warnings));

  const stIR = {
    kind: "st",
    statements: [{
      kind: "assign", target: "c",
      value: { kind: "binary", op: "AND", left: { kind: "ref", path: "a" }, right: { kind: "ref", path: "b" } }
    }]
  };
  const r = fbdConv.stToFbd(stIR);
  assert.strictEqual(r.ir.kind, "fbd");
  assert.ok(r.ir.sheets[0].blocks.length > 0);
  const back = fbdConv.fbdToLad(r.ir);
  assert.deepStrictEqual(back.ir.rungs[0].root.items.map(function (x) { return x.op; }), ["XIC", "XIC", "OTE"]);
});

test("buildFbdDataflow: no dangling edges, kind coloring present", function () {
  const g = fbdConv.buildFbdDataflow(HAND_FBD, { simplify: false });
  assert.ok(g.nodes.length > 0);
  assert.ok(g.edges.length > 0);
  const ids = new Set(g.nodes.map(function (n) { return n.id; }));
  for (const e of g.edges) {
    assert.ok(ids.has(e.from), "edge source exists: " + e.from);
    assert.ok(ids.has(e.to), "edge target exists: " + e.to);
  }
  const kinds = g.nodes.map(function (n) { return n.kind; });
  assert.ok(kinds.indexOf("tag-read") !== -1);
  assert.ok(kinds.indexOf("tag-write") !== -1);
  assert.ok(kinds.indexOf("func") !== -1 || kinds.indexOf("logic") !== -1);
});

/* ---- 12. FBD editor round-trips through serialize after edits ---- */
test("FbdEditor mutations survive an fbd XML round-trip", function () {
  const fed = new fbdRender.FbdEditor({ ir: JSON.parse(JSON.stringify(HAND_FBD)), onChange: function () { } });
  fed.addBlock("XOR");
  const xml = fbdSer.serializeFbdXml(fed.getIR());
  const back = fbdParse.parseFbdXml(xml);
  assert.ok(back.sheets[0].blocks.some(function (b) { return b.type === "XOR"; }));
});

console.log("");
if (failures) {
  console.error(failures + " test(s) FAILED");
  process.exit(1);
} else {
  console.log("all tests passed");
}
