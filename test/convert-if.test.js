/* L5X Studio — ST → LAD conversion of IF conditions.
 *
 * An IF in structured text is a ladder rung condition network: refs/AND/OR/NOT and
 * comparisons map straight to XIC/XIO/EQU/... instructions, ELSE/ELSIF map to branches,
 * and arithmetic inside a comparison is flattened through helper tags (auto-declared DINTs).
 * These tests cover the four conditions in SAMPLE_ST that used to produce
 * "IF condition not representable in ladder".
 */
"use strict";
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const MODEL = require("../js/l5x-model.js");
const LC = require("../js/lang-convert.js");
const STS = require("../js/st-serialize.js");
const EXPORT = require("../js/export.js");
const SCHEMA = require("../js/schema-validate.js");

const SAMPLE_ST = process.env.L5X_STUDIO_SAMPLE_ST || "C:/samples/structured-text.L5X";
const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/samples/controller.L5X";

let checks = 0, failures = 0, skipped = 0;
class Skip extends Error {}
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok - " + name); }
  catch (e) {
    if (e instanceof Skip) { skipped++; console.log("skip - " + name + " (" + e.message + ")"); return; }
    failures++; console.error("FAIL - " + name); console.error("    " + String((e && e.stack) || e));
  }
}
function load(file) {
  if (!file || !fs.existsSync(file)) throw new Skip("project sample not available: " + file);
  return MODEL.parseL5X(fs.readFileSync(file, "utf8"));
}

/* ---------------------------------------------------------- synthetic forms */
check("if: arithmetic equality uses a helper tag (X = Y - 1)", () => {
  const ir = STS.serializeSt ? null : null;
  const STP = require("../js/st-parse.js");
  const st = STP.parseSt("IF A = B - 1 THEN X := 1; END_IF;");
  const res = LC.stToLad(st);
  const content = { kind: "rll" };
  const unrep = (res.warnings || []).filter(w => /not representable/i.test(w.msg));
  assert.equal(unrep.length, 0, "no unrepresentable warning");
  assert.ok((res.tempTags || []).length === 1, "one helper tag: " + JSON.stringify(res.tempTags));
  const text = JSON.stringify(res.ir);
  assert.ok(text.indexOf("SUB") !== -1, "SUB computes the helper value");
  assert.ok(text.indexOf(res.tempTags[0]) !== -1, "comparison uses the helper tag");
});

check("if: integer ±1 comparison is simplified without a helper tag (A > B - 1 -> GEQ)", () => {
  const STP = require("../js/st-parse.js");
  const st = STP.parseSt("IF A > B - 1 THEN X := 1; END_IF;");
  const res = LC.stToLad(st);
  assert.equal((res.warnings || []).filter(w => /not representable/i.test(w.msg)).length, 0);
  assert.equal((res.tempTags || []).length, 0, "no helper tag for the ±1 form");
  const ser = require("../js/rll-serialize.js").serializeRllRung(res.ir.rungs[0].root || res.ir.rungs[0].branch || res.ir.rungs[0]);
  assert.ok(/GEQ\(A,B\)/.test(ser), "simplified to GEQ(A,B): " + ser.slice(0, 120));
});

/* ------------------------------------------------------------ real projects */
check("if: every ST routine in SAMPLE_ST/SAMPLE_RLL converts with zero unrepresentable IF conditions", () => {
  const files = [SAMPLE_ST, SAMPLE_RLL].filter(f => fs.existsSync(f));
  if (files.length === 0) throw new Skip("SAMPLE_ST/SAMPLE_RLL samples not available");
  let routines = 0, bad = [];
  for (const file of files) {
    const model = load(file);
    for (const p of model.programs) {
      for (const r of p.routines) {
        let ir;
        try { ir = model.getRoutineIR(p.name, r.name); } catch (e) { continue; }
        if (ir.kind !== "st") continue;
        routines++;
        const res = LC.stToLad(ir);
        for (const w of (res.warnings || [])) if (/not representable/i.test(w.msg)) bad.push(p.name + "/" + r.name + ": " + w.msg);
      }
    }
  }
  assert.ok(routines > 5, "ST routines converted: " + routines);
  assert.equal(bad.length, 0, bad.slice(0, 5).join(" | "));
});

check("if: SAMPLE_ST DistanceCalculationBelt1 arithmetic condition is represented with a helper tag", () => {
  const model = load(SAMPLE_ST);
  const res = LC.stToLad(model.getRoutineIR("MainProgram", "DistanceCalculationBelt1"));
  assert.ok((res.tempTags || []).length >= 1, "helper tag allocated");
  const content = model.irToContent("MainProgram", "DistanceCalculationBelt1", res.ir);
  const texts = (content.rungs || []).map(g => g.text).join("\n");
  assert.ok(/SUB\(ScanSectionNextIndex1,1,L5X_TMP_1\)/.test(texts), "helper computation rung");
  assert.ok(/EQU\(X,L5X_TMP_1\)/.test(texts), "IF condition compares against the helper tag");
  /* back to ST: the helper computation appears as a normal statement */
  const st = LC.ladToSt(res.ir);
  const stText = STS.serializeSt(st.ir);
  assert.ok(/L5X_TMP_1 := ScanSectionNextIndex1 - 1;/.test(stText), "round-trip ST shows the helper computation");
  const ir2 = require("../js/st-parse.js").parseSt(stText);
  assert.ok(ir2 && ir2.statements.length > 0, "round-trip ST parses");
});

check("if: SAMPLE_ST SystemConfiguration ±1 comparisons simplify to flat ladder compares", () => {
  const model = load(SAMPLE_ST);
  const res = LC.stToLad(model.getRoutineIR("MainProgram", "SystemConfiguration"));
  assert.equal((res.warnings || []).filter(w => /not representable/i.test(w.msg)).length, 0, "no unrepresentable condition");
  assert.equal((res.tempTags || []).length, 0, "no helper tags needed");
  const content = model.irToContent("MainProgram", "SystemConfiguration", res.ir);
  const texts = (content.rungs || []).map(g => g.text).join("\n");
  assert.ok(/GEQ\(AdjustedDivertWindowLowLimitInInches\[1\],AdjustedDivertWindowHighLimitInInches\[1\]\)/.test(texts),
    "low-limit condition simplified to GEQ against the high limit");
  assert.ok(/LEQ\(AdjustedDivertWindowHighLimitInInches\[1\],AdjustedDivertWindowLowLimitInInches\[1\]\)/.test(texts),
    "high-limit condition simplified to LEQ against the low limit");
});

/* --------------------------------------------- export/schema with helper tags */
check("if: exported L5X with a helper tag stays schema-clean (auto-declared DINT)", () => {
  const model = load(SAMPLE_ST);
  const res = LC.stToLad(model.getRoutineIR("MainProgram", "DistanceCalculationBelt1"));
  const content = model.irToContent("MainProgram", "DistanceCalculationBelt1", res.ir);
  model.setRoutineContent("MainProgram", "DistanceCalculationBelt1", "RLL", content);
  const out = EXPORT.exportL5X(model, {});
  const text = out.text || out.l5x || "";
  assert.ok(text.indexOf("L5X_TMP_1") !== -1, "helper tag referenced in the export");
  assert.ok((out.warnings || []).some(w => /Auto-declared controller-scope tag: L5X_TMP_1/.test(w)),
    "helper tag auto-declared (warning present)");
  const parsed = MODEL.parseL5X(text);
  const vr = SCHEMA.validateModel(parsed, {});
  assert.equal((vr.errors || []).length, 0, "schema errors: " + JSON.stringify((vr.errors || []).slice(0, 3)));
});

check("if: ELSIF/ELSE conditions still convert to ladder branches", () => {
  const STP = require("../js/st-parse.js");
  const st = STP.parseSt("IF A > 10 THEN X := 1; ELSIF B THEN X := 2; ELSE X := 3; END_IF;");
  const res = LC.stToLad(st);
  assert.equal((res.warnings || []).filter(w => /not representable/i.test(w.msg)).length, 0, "no unrepresentable condition");
  const rungs = res.ir.rungs.length;
  assert.ok(rungs >= 1, "rungs produced: " + rungs);
  const all = res.ir.rungs.map(g => JSON.stringify(g)).join(" ");
  assert.ok(all.indexOf("GRT") !== -1 && all.indexOf("XIC") !== -1, "compare + ref conditions present");
});

console.log("\nconvert-if: " + (checks - failures - skipped) + " passed, " + failures + " failed, " + skipped + " skipped (sample-dependent)");
if (failures) process.exitCode = 1;
