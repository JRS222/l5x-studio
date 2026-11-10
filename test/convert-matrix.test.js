/* L5X Studio — conversion matrix tests.
 *
 * Regression coverage for the Convert feature: every routine in a real project must convert
 * between LAD / FBD / ST, and the produced content must parse back through the model (that is
 * what the editor and the Convert panel do). Covers the dynamic-bit-reference operand forms
 * (`Tag.[expr]`, `Tag[expr].[n]`) that used to break LAD→ST for ~49 SAMPLE_RLL routines.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODEL = require("../js/l5x-model.js");
const LC = require("../js/lang-convert.js");
const FC = require("../js/fbd-convert.js");
const STP = require("../js/st-parse.js");
const STS = require("../js/st-serialize.js");

const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/samples/controller.L5X";
const SAMPLE_ST = process.env.L5X_STUDIO_SAMPLE_ST || "C:/samples/structured-text.L5X";

let checks = 0, failures = 0;
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok - " + name); }
  catch (e) {
    failures++;
    console.error("FAIL - " + name);
    console.error("    " + String((e && e.stack) || e));
  }
}

/* ------------------------------------------------------------ ST operand forms */
check("ST: dynamic bit references Tag.[expr] parse", () => {
  const src = [
    "INPUTS.[NDX_ZONE_IO] := 1;",
    "IF NETS[NDX_NET].ZPA[NDX].INPUTS.[NDX_ZONE_IO] THEN",
    "   X := Y;",
    "END_IF;",
    "ENET_OUTPUTS[MAP_OFFSET_INT].[0] := GR[GR_NDX].FULL_LIGHT_IO;",
    "IF SORTER[IDX].RESET.[CMD_BIT] AND NOT A[0].B THEN",
    "   C := 1;",
    "END_IF;"
  ].join("\n");
  const ir = STP.parseSt(src);
  assert.ok(ir && ir.kind === "st", "ST IR");
  assert.equal(ir.statements.length >= 4, true, "statements parsed");
  const text = STS.serializeSt(ir);
  assert.ok(text.indexOf("INPUTS.[NDX_ZONE_IO]") !== -1, "dynamic bit literal preserved");
  assert.ok(text.indexOf("ENET_OUTPUTS[MAP_OFFSET_INT].[0]") !== -1, "bracket bit preserved");
  const ir2 = STP.parseSt(text);
  assert.ok(ir2 && ir2.statements.length === ir.statements.length, "round trip stable");
});

check("ST: dynamic bit references round-trip through expression parser", () => {
  const ir = STP.parseStExpression("NETS[1].ZPA[NDX].INPUTS.[NDX_ZONE_IO] AND A[0].B.[2]");
  const text = STS.serializeStExpression ? STS.serializeStExpression(ir) : null;
  if (text) assert.ok(text.indexOf(".[") !== -1, "serialized dynamic bit form: " + text);
});

/* ------------------------------------------------------- conversion matrix */
function roundTrip(model, program, routine) {
  const ir = model.getRoutineIR(program, routine);
  const cur = ir.kind;
  if (cur === "sfc") return null;
  const r = model.programs.find(function (p) { return p.name === program; }).routines.find(function (x) { return x.name === routine; });
  const saved = { content: r.content, type: r.type, pendingType: r.pendingType };
  const results = [];
  try {
    for (const target of ["st", "fbd", "lad"]) {
      if (target === cur) continue;
      let res;
      if (target === "st") res = cur === "lad" ? LC.ladToSt(ir) : FC.fbdToSt(ir);
      else if (target === "fbd") res = cur === "lad" ? FC.ladToFbd(ir) : FC.stToFbd(ir);
      else res = cur === "st" ? LC.stToLad(ir) : FC.fbdToLad(ir);
      assert.ok(res && res.ir, "conversion result for " + cur + "->" + target);
      const type = { st: "ST", fbd: "FBD", lad: "RLL" }[target];
      const content = model.irToContent(program, routine, res.ir);
      r.content = content; r.type = type; r.pendingType = type;
      const back = model.getRoutineIR(program, routine);  // parse like the editor/convert panel does
      assert.ok(back && (back.kind === target || (target === "lad" && back.rungs)), "re-parsed " + cur + "->" + target);
      results.push(cur + "->" + target);
    }
  } finally {
    r.content = saved.content; r.type = saved.type; r.pendingType = saved.pendingType;
  }
  return results;
}

check("convert: LAD↔ST↔FBD matrix on routines with dynamic bit refs (SAMPLE_RLL)", () => {
  if (!fs.existsSync(SAMPLE_RLL)) { console.log("    (SAMPLE_RLL not available — skipped body)"); return; }
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_RLL, "utf8"));
  const targets = ["GR/GROUP_CYCLE", "GR/MAPPING_CT", "GR/MAPPING_CT_FULL_LIGHT_MAIN",
    "HARD_CODE_ZPA/COUNT_FULL_ZONES_SUB", "GR/MAPPING_PUSHER_SAMPLE_ST", "GR/GROUP_REALIGN"];
  let converted = 0;
  for (const key of targets) {
    const parts = key.split("/");
    const r = model.programs.find(function (p) { return p.name === parts[0]; }).routines.find(function (x) { return x.name === parts[1]; });
    assert.ok(r, "routine " + key + " found");
    const out = roundTrip(model, parts[0], parts[1]);
    assert.ok(out && out.length >= 2, "converted " + key + " to " + (out || []).join(", "));
    converted += out.length;
  }
  assert.ok(converted >= 12, "conversions performed: " + converted);
});

check("convert: full matrix over every SAMPLE_RLL + SAMPLE_ST routine (no failures)", () => {
  const files = [SAMPLE_RLL, SAMPLE_ST].filter(function (f) { return fs.existsSync(f); });
  if (!files.length) { console.log("    (no projects available — skipped body)"); return; }
  let total = 0, converted = 0;
  const failuresList = [];
  for (const file of files) {
    const model = MODEL.parseL5X(fs.readFileSync(file, "utf8"));
    for (const p of model.programs) {
      for (const rt of p.routines) {
        total++;
        try {
          const out = roundTrip(model, p.name, rt.name);
          converted += out ? out.length : 0;
        } catch (e) {
          failuresList.push(p.name + "/" + rt.name + ": " + e.message);
        }
      }
    }
  }
  assert.equal(failuresList.length, 0, failuresList.slice(0, 8).join(" | "));
  assert.ok(converted > 500, "conversions performed: " + converted);
  console.log("    routines: " + total + ", successful conversions: " + converted);
});

/* ---------------------------------------------- Convert-panel style flow */
check("convert: apply-all flow keeps content parseable (ST then FBD then LAD)", () => {
  if (!fs.existsSync(SAMPLE_RLL)) { console.log("    (SAMPLE_RLL not available — skipped body)"); return; }
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_RLL, "utf8"));
  const program = "GR", routine = "MAPPING_CT_FULL_LIGHT_MAIN";
  const r = model.programs.find(function (p) { return p.name === program; }).routines.find(function (x) { return x.name === routine; });
  const original = JSON.stringify(r.content);
  // LAD -> ST
  let ir = model.getRoutineIR(program, routine);
  assert.equal(ir.kind, "lad");
  let res = LC.ladToSt(ir);
  model.setRoutineContent(program, routine, "ST", model.irToContent(program, routine, res.ir));
  let back = model.getRoutineIR(program, routine);
  assert.equal(back.kind, "st", "converted to ST");
  // ST -> FBD
  res = FC.stToFbd(back);
  model.setRoutineContent(program, routine, "FBD", model.irToContent(program, routine, res.ir));
  back = model.getRoutineIR(program, routine);
  assert.equal(back.kind, "fbd", "converted to FBD");
  // FBD -> LAD
  res = FC.fbdToLad(back);
  model.setRoutineContent(program, routine, "RLL", model.irToContent(program, routine, res.ir));
  back = model.getRoutineIR(program, routine);
  assert.ok(back.kind === "lad" && back.rungs.length >= 1, "converted back to ladder");
  // content survived and parses; restore
  assert.ok(JSON.stringify(r.content).indexOf("ENET_OUTPUTS") !== -1, "operand content preserved");
  r.content = JSON.parse(original);
  r.type = "RLL"; r.pendingType = null;
});

/* -------------------------------------------- conversions of models with AOIs / ST */
check("convert: native ST routine converts to LAD and FBD", () => {
  if (!fs.existsSync(SAMPLE_ST)) { console.log("    (SAMPLE_ST not available — skipped body)"); return; }
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_ST, "utf8"));
  let found = null;
  for (const prog of model.programs) {
    for (const r of prog.routines) {
      if (r.type !== "ST") continue;
      const c = r.content || {};
      const text = (c.text || "").trim();
      if (!text) continue;
      const ir0 = model.getRoutineIR(prog.name, r.name);
      if (ir0 && ir0.statements && ir0.statements.length) { found = { prog: prog.name, r: r, ir: ir0 }; break; }
    }
    if (found) break;
  }
  assert.ok(found, "non-empty native ST routine found");
  const p = { name: found.prog };
  const rt = found.r;
  const ir = found.ir;
  assert.equal(ir.kind, "st", "native ST IR");
  assert.ok(ir.statements.length >= 1, "ST statements");
  const toLad = LC.stToLad(ir);
  assert.ok(toLad && toLad.ir.rungs.length >= 1, "ST -> LAD rungs");
  const toFbd = FC.stToFbd(ir);
  assert.ok(toFbd && toFbd.ir && toFbd.ir.kind === "fbd", "ST -> FBD sheets");
  // apply both back through the model
  const saved = { content: rt.content, type: rt.type, pendingType: rt.pendingType };
  try {
    for (const [kind, res, type] of [["lad", toLad, "RLL"], ["fbd", toFbd, "FBD"]]) {
      model.setRoutineContent(p.name, rt.name, type, model.irToContent(p.name, rt.name, res.ir));
      const back = model.getRoutineIR(p.name, rt.name);
      assert.ok(back && back.kind === kind, "applied " + kind);
    }
  } finally {
    rt.content = saved.content; rt.type = saved.type; rt.pendingType = saved.pendingType;
  }
});

console.log("\nconvert-matrix: " + (checks - failures) + " passed, " + failures + " failed");
if (failures) process.exitCode = 1;
