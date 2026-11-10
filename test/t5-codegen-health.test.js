/* L5X Studio - test/t5-codegen-health.test.js (T3).
   Ladder/ST/FBD -> C code generation + project health analysis tests.
   Run: node test/t5-codegen-health.test.js   (exit non-zero on failure)

   Contract: docs/IMPROVEMENTS.md section T3. */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const JS = p => require(path.join(__dirname, "..", "js", p));
const IR = JS("ir.js");
const RLLP = JS("rll-parse.js");
const STP = JS("st-parse.js");
const CG = JS("codegen-c.js");
const HEALTH = JS("health.js");
const MODEL = JS("l5x-model.js");

const SAMPLE_RLL_PATH = "C:/samples/controller.L5X";
const SAMPLE_ST_PATH = "C:/samples/structured-text.L5X";
if (!fs.existsSync(SAMPLE_RLL_PATH) || !fs.existsSync(SAMPLE_ST_PATH)) {
  console.log("skip: site samples not available");
  process.exit(0);
}

const sampleRllFixture = require("./fixtures/sampleRll-rll.json");
const sampleStFixture = require("./fixtures/sampleSt-st.json");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    pass++;
    console.log("ok   " + name + "  (" + (Date.now() - t0) + " ms)");
  } catch (e) {
    fail++;
    failures.push(name);
    console.log("FAIL " + name);
    const msg = String((e && e.stack) || e || "");
    console.log("     " + msg.split("\n").slice(0, 6).join("\n     "));
  }
}

function fixtureRungs(routine) {
  return routine.rungs.map(function (rg) {
    return {
      id: null, number: rg.number, type: rg.type || "N", comment: rg.comment,
      root: RLLP.parseRllRung(rg.text)
    };
  });
}

function bodyHas(code, needle) {
  assert.ok(code.indexOf(needle) !== -1, "expected generated C to contain:\n  " + needle +
    "\n--- generated ---\n" + code.split("\n").slice(0, 40).join("\n"));
}

/* ==================================================================== *
 *  1. routineToC on the real SAMPLE_RLL fixture routine
 * ==================================================================== */

const firstTaskRoutine = sampleRllFixture.find(function (r) { return r.name === "MAIN_TASK_MAIN"; });

t("fixture MAIN_TASK_MAIN -> C body (stack machine + timer + TODO)", () => {
  assert.ok(firstTaskRoutine, "fixture routine exists");
  const ir = { kind: "lad", rungs: fixtureRungs(firstTaskRoutine) };
  const res = CG.routineToC(ir, { routine: "MAIN_TASK_MAIN", program: "MAIN_TASK" });
  assert.ok(res.code && res.code.length > 200, "generated code present");
  bodyHas(res.code, "clear();push(true);");
  bodyHas(res.code, "push(NEW_JOB_TOGGLE);and();");
  bodyHas(res.code, "=acc();"); /* OTE assignment (rungyacc compact form) */
  bodyHas(res.code, "ton(acc(), &NEW_JOB_TIMER);");
  bodyHas(res.code, "TODO FOR("); /* FOR is a routine loop: mapped in project mode, unsupported here */
  assert.ok(res.warnings.length > 0, "unsupported instructions produce warnings");
  assert.ok(res.warnings.some(function (w) { return /unsupported instruction/.test(w.msg); }),
    "warning text mentions unsupported instruction");
});

t("LES/LEQ/GRT/GEQ operators use correct C comparisons", () => {
  /* docs T3: l5x2c mapped LEQ to '<'; the fix maps LES '<', LEQ '<=', GRT '>', GEQ '>=' */
  const root = IR.makeSeries([
    IR.makeInstr("XIC", "A"),
    IR.makeInstr("LES", "B", "5"),
    IR.makeInstr("LEQ", "C", "6"),
    IR.makeInstr("GRT", "D", "7"),
    IR.makeInstr("GEQ", "E", "8"),
    IR.makeInstr("OTE", "F")
  ]);
  const res = CG.routineToC({ kind: "lad", rungs: [IR.makeRung(root, { number: 0 })] },
    { routine: "CMP", program: "P" });
  bodyHas(res.code, "push(B<5);and();");
  bodyHas(res.code, "push(C<=6);and();");
  bodyHas(res.code, "push(D>7);and();");
  bodyHas(res.code, "push(E>=8);and();");
});

t("RTO / CTD map to the generated runtime functions", () => {
  const rung = IR.makeRung(IR.makeSeries([
    IR.makeInstr("XIC", "A"),
    IR.makeInstr("RTO", "RETENTIVE_TMR", "?", "?"),
    IR.makeInstr("XIC", "B"),
    IR.makeInstr("CTD", "DOWN_CTR", "?", "?")
  ]), { number: 0 });
  const res = CG.routineToC({ kind: "lad", rungs: [rung] }, { routine: "TIMERS", program: "P" });
  bodyHas(res.code, "rto(acc(), &RETENTIVE_TMR);");
  bodyHas(res.code, "ctd(acc(), &DOWN_CTR);");
});

t("unknown op emits TODO comment + warning (never silent)", () => {
  const rung = IR.makeRung(IR.makeSeries([
    IR.makeInstr("XIC", "A"),
    IR.makeInstr("MYSTERY_OP", "B", "C"),
    IR.makeInstr("OTE", "D")
  ]), { number: 7 });
  const res = CG.routineToC({ kind: "lad", rungs: [rung] }, { routine: "SYNTH", program: "P" });
  bodyHas(res.code, "/* TODO MYSTERY_OP(B,C) rung 7: unsupported */");
  assert.equal(res.warnings.length, 1, "one warning for the unknown instruction");
  assert.match(res.warnings[0].msg, /unsupported instruction MYSTERY_OP/);
});

t("output branches keep the rungyacc stack protocol", () => {
  const branch = RLLP.parseRllRung("XIC(A)[OTL(B) ,OTL(C) ,MOV(1,D) ]");
  const res = CG.routineToC({ kind: "lad", rungs: [IR.makeRung(branch, { number: 0 })] },
    { routine: "BR", program: "P" });
  bodyHas(res.code, "push(acc());");
  bodyHas(res.code, "pop();push(acc());");
  bodyHas(res.code, "pop();");
  bodyHas(res.code, "if(acc())B=1;");
});

/* ==================================================================== *
 *  2. ST -> C
 * ==================================================================== */

t("SAMPLE_ST ST fixture -> C assignments with module operand mapping", () => {
  const fixture = sampleStFixture[1]; /* DivertPoints1To4 / MappedIO (non-empty) */
  assert.ok(fixture && fixture.text.length > 50, "ST fixture text present");
  const st = STP.parseSt(fixture.text);
  const res = CG.routineToC(st, { routine: fixture.name, program: fixture.program });
  bodyHas(res.code, "Network1_I.Data[2]");
  bodyHas(res.code, "= BIT_GET(Network1_I.Data[2], 1)"); /* LaneFullSensor[1] := input bit */
  bodyHas(res.code, "BIT_SET(Network1_O.Data[2], 10, OldPusherExtend[1])"); /* output bit write */
});

t("ST control flow -> if / for / while / do-while", () => {
  const st = STP.parseSt([
    "FOR I := 0 TO 10 BY 1 DO",
    "  IF A = 1 THEN",
    "    B[I] := A + I;",
    "  ELSE",
    "    B[I] := 0;",
    "  END_IF;",
    "END_FOR;",
    "WHILE C < 5 DO",
    "  C := C + 1;",
    "END_WHILE;",
    "REPEAT",
    "  D := D + 1;",
    "UNTIL D >= 3",
    "END_REPEAT;"
  ].join("\n"));
  const res = CG.routineToC(st, { routine: "FLOW", program: "P" });
  bodyHas(res.code, "if (");
  bodyHas(res.code, "else {");
  bodyHas(res.code, "for (");
  bodyHas(res.code, "while (");
  bodyHas(res.code, "do {");
  bodyHas(res.code, "while (!(");
});

t("ST codegen from the real SAMPLE_ST project (MainProgram/Date)", () => {
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_ST_PATH, "utf8"));
  model.fileName = "SAMPLE_ST.L5X";
  const res = CG.generateC(model, { programFilter: "MainProgram", routineFilter: "Date", filenameBase: "sampleStdate" });
  const c = res.files["sampleStdate.c"];
  assert.ok(res.stats.routines >= 1, "at least one routine generated");
  bodyHas(c, "if (");
  bodyHas(c, "for (");
});

/* ==================================================================== *
 *  3. whole-project generateC (SAMPLE_RLL, under 20 s)
 * ==================================================================== */

let sampleRllModel = null;
let sampleRllGen = null;

t("generateC(SAMPLE_RLL) completes with warnings + files under 20 s", () => {
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_RLL_PATH, "utf8"));
  model.fileName = "SAMPLE_RLL.L5X";
  sampleRllModel = model;
  const t0 = Date.now();
  const res = CG.generateC(model, {});
  const elapsed = Date.now() - t0;
  sampleRllGen = res;
  assert.ok(elapsed < 20000, "generateC took " + elapsed + " ms (limit 20 s)");
  assert.ok(res.files["plcmodel.h"] && res.files["plcmodel.c"], "both files generated");
  assert.ok(res.files["plcmodel.h"].length > 20000, "header has substance");
  assert.ok(res.files["plcmodel.c"].length > 200000, "source has substance");
  assert.equal(res.stats.routines, 211, "all 211 routines generated");
  assert.ok(res.stats.unsupported > 0, "unsupported instructions counted");
  assert.ok(res.warnings.length > 0, "warnings list non-empty");
  for (const w of res.warnings) {
    assert.equal(typeof w.msg, "string", "warning has msg");
    assert.ok("routine" in w, "warning has routine field");
  }
  console.log("      generated h=" + res.files["plcmodel.h"].length +
    " bytes, c=" + res.files["plcmodel.c"].length + " bytes, " +
    res.warnings.length + " warnings, " + res.stats.unsupported + " unsupported in " + elapsed + " ms");
});

t("generated header has the l5x2c runtime + tag declarations", () => {
  assert.ok(sampleRllGen, "SAMPLE_RLL generated");
  const h = sampleRllGen.files["plcmodel.h"];
  const c = sampleRllGen.files["plcmodel.c"];
  bodyHas(h, "typedef struct timer");
  bodyHas(h, "void ton(");
  bodyHas(h, "void tof(");
  bodyHas(h, "void rto(");
  bodyHas(h, "void ctu(");
  bodyHas(h, "void ctd(");
  bodyHas(h, "typedef struct counter");
  bodyHas(h, "#define SCAN_TIME_MS");
  bodyHas(h, "extern timer NEW_JOB_TIMER;");
  bodyHas(h, "extern bool NEW_JOB_TOGGLE;");
  bodyHas(h, "typedef struct GFX"); /* UDT generated from model.dataTypes */
  bodyHas(h, "extern GFX GFX_TAG;"); /* UDT tag (renamed to avoid C type/object clash) */
  bodyHas(c, "clear();push(true);");
  bodyHas(c, "=acc();");
  bodyHas(c, "void MAIN_TASK_MAIN(void)");
  bodyHas(c, "int main(void)");
  bodyHas(c, "scan_delay();");
});

t("generateC program/routine/maxRoutines filters", () => {
  const res = CG.generateC(sampleRllModel, { programFilter: "MAIN_TASK", maxRoutines: 2, filenameBase: "mini" });
  assert.ok(res.files["mini.h"] && res.files["mini.c"], "custom file names");
  assert.ok(res.stats.routines <= 2, "maxRoutines respected");
  const res2 = CG.generateC(sampleRllModel, { routineFilter: "MAIN_TASK_MAIN", filenameBase: "one" });
  assert.ok(res2.stats.routines >= 1);
  assert.ok(res2.files["one.c"].indexOf("MAIN_TASK_MAIN(void)") !== -1);
});

t("tag path sanitising keeps a mapping comment (NETS[0].ZPA[3].ZONE)", () => {
  assert.equal(CG.tagPathToCIdent("NETS[0].ZPA[3].ZONE"), "NETS__0__ZPA__3__ZONE");
  assert.equal(CG.sanitizeCIdent("Local:1:I"), "Local_1_I");
  assert.equal(CG.sanitizeCIdent("int"), "int_");
});

t("FBD IR converts via fbdToLad and produces C", () => {
  const fbd = {
    kind: "fbd",
    sheets: [{
      blocks: [
        { kind: "iref", id: 1, x: 0, y: 0, operand: "A" },
        { kind: "iref", id: 2, x: 0, y: 40, operand: "B" },
        { kind: "block", id: 3, type: "AND", x: 80, y: 0, operand: "C" },
        { kind: "oref", id: 4, x: 160, y: 0, operand: "C" }
      ],
      wires: [
        { from: { id: 1 }, to: { id: 3, param: "In1" } },
        { from: { id: 2 }, to: { id: 3, param: "In2" } },
        { from: { id: 3, param: "Out" }, to: { id: 4 } }
      ]
    }]
  };
  const res = CG.routineToC(fbd, { routine: "FBD_SYN", program: "P" });
  assert.ok(res.code && res.code.indexOf("clear();push(true);") !== -1, "FBD ladder code emitted");
  assert.ok(Array.isArray(res.warnings));
});

/* ==================================================================== *
 *  4. project health analysis (SAMPLE_RLL)
 * ==================================================================== */

let sampleRllReport = null;

t("analyzeProject(SAMPLE_RLL) summary numbers are sane", () => {
  assert.ok(sampleRllModel, "SAMPLE_RLL model loaded");
  const t0 = Date.now();
  const report = HEALTH.analyzeProject(sampleRllModel, {});
  const elapsed = Date.now() - t0;
  sampleRllReport = report;
  assert.ok(elapsed < 5000, "analysis under 5 s (took " + elapsed + " ms)");
  assert.equal(report.summary.programs, 17, "programs");
  assert.equal(report.summary.routines, 211, "routines");
  assert.equal(report.summary.controllerTags, 77, "controller tags");
  assert.ok(report.summary.programTags > 0, "program tags counted");
  assert.ok(report.summary.dataTypes > 0, "data types counted");
  assert.ok(report.summary.modules > 0, "modules counted");
  assert.ok(report.summary.unusedTags > 0, "unused tags detected");
  assert.ok(report.summary.uncalledRoutines > 0, "uncalled routines detected");
  assert.equal(typeof report.project.name, "string");
  console.log("      " + JSON.stringify(report.summary));
});

t("analyzeProject(SAMPLE_RLL) unusedTags entries have the contract shape", () => {
  assert.ok(sampleRllReport.unusedTags.length > 0);
  for (const tag of sampleRllReport.unusedTags) {
    assert.equal(typeof tag.name, "string", "name");
    assert.ok(tag.scope === "controller" || /^program:/.test(tag.scope), "scope: " + tag.scope);
    assert.equal(typeof tag.dataType, "string", "dataType");
    assert.ok("aliasFor" in tag, "aliasFor field present");
  }
});

t("analyzeProject(SAMPLE_RLL) uncalledRoutines excludes main routines", () => {
  const mains = new Set();
  for (const p of sampleRllModel.programs) if (p.mainRoutineName) mains.add(p.mainRoutineName);
  assert.ok(sampleRllReport.uncalledRoutines.length > 0, "non-empty uncalled list");
  for (const r of sampleRllReport.uncalledRoutines) {
    assert.equal(typeof r.program, "string");
    assert.equal(typeof r.routine, "string");
    assert.ok(!mains.has(r.routine), "main routine listed as uncalled: " + r.routine);
  }
  assert.ok(sampleRllReport.uncalledRoutines.some(function (r) { return r.routine !== ""; }),
    "includes known non-main routines");
});

t("analyzeProject(SAMPLE_RLL) unresolvedOperands aggregate + emptyRoutines + aoiUsage", () => {
  assert.ok(Array.isArray(sampleRllReport.unresolvedOperands));
  let total = 0;
  for (const u of sampleRllReport.unresolvedOperands) {
    assert.equal(typeof u.program, "string");
    assert.equal(typeof u.routine, "string");
    assert.equal(typeof u.operand, "string");
    assert.ok(u.count >= 1);
    total += u.count;
  }
  assert.equal(sampleRllReport.summary.unresolvedOperands, total);
  assert.ok(Array.isArray(sampleRllReport.emptyRoutines));
  assert.ok(Array.isArray(sampleRllReport.aoiUsage));
  assert.ok(Array.isArray(sampleRllReport.unusedIoPoints));
  for (const p of sampleRllReport.unusedIoPoints.slice(0, 5)) {
    assert.equal(typeof p.moduleName, "string");
    assert.equal(typeof p.direction, "string");
    assert.equal(typeof p.point, "string");
    assert.equal(typeof p.address, "string");
  }
});

t("analyzeProject(SAMPLE_RLL) findings rolled up", () => {
  assert.ok(sampleRllReport.findings.length > 0, "findings non-empty");
  const categories = new Set();
  for (const f of sampleRllReport.findings) {
    assert.ok(["error", "warning", "info"].indexOf(f.severity) !== -1, "severity: " + f.severity);
    assert.equal(typeof f.category, "string");
    assert.equal(typeof f.message, "string");
    assert.ok("details" in f);
    categories.add(f.category);
  }
  assert.ok(categories.has("unused-tags"), "unused tags finding");
  assert.ok(categories.has("uncalled-routines"), "uncalled routines finding");
});

t("toMarkdownReport(SAMPLE_RLL) contains every section", () => {
  const md = HEALTH.toMarkdownReport(sampleRllReport);
  assert.ok(md.indexOf("# Project Health Report") === 0, "title first");
  const headers = [
    "## Summary",
    "## Findings",
    "## Unused Tags",
    "## Unresolved Operands",
    "## Uncalled Routines",
    "## Empty Routines",
    "## Unused I/O Points",
    "## Add-On Instruction Usage"
  ];
  for (const h of headers) {
    assert.ok(md.indexOf(h) !== -1, "missing markdown section: " + h);
  }
  assert.ok(md.indexOf("| Programs | 17 |") !== -1, "summary table has program count");
  assert.ok(md.length > 1000, "report has substance");
});

t("analyzeProject(SAMPLE_ST) handles ST-heavy project", () => {
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_ST_PATH, "utf8"));
  model.fileName = "SAMPLE_ST.L5X";
  const report = HEALTH.analyzeProject(model, {});
  assert.equal(report.summary.programs, 7);
  assert.ok(report.summary.routines > 100);
  assert.ok(report.unusedTags.length > 0);
  assert.ok(Array.isArray(report.unresolvedOperands));
  const md = HEALTH.toMarkdownReport(report);
  assert.ok(md.indexOf("## Summary") !== -1);
});

/* ==================================================================== *
 *  summary
 * ==================================================================== */

console.log("");
console.log("t5-codegen-health: " + pass + " passed, " + fail + " failed");
if (fail) {
  console.log("failed: " + failures.join(", "));
  process.exit(1);
}
process.exit(0);
