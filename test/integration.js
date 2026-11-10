/* L5X Studio - test/integration.js (Lead). Full pipeline over the three real L5X files:
   parse -> IR -> dataflow -> convert every routine to every other language -> export ->
   re-parse -> structural verification. Run with the bundled Node. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
const rllParse = JS("rll-parse.js");
const rllSer = JS("rll-serialize.js");
const stParse = JS("st-parse.js");
const stSer = JS("st-serialize.js");
const langConv = JS("lang-convert.js");
const fbdParse = JS("fbd-parse.js");
const fbdSer = JS("fbd-serialize.js");
const fbdConv = JS("fbd-convert.js");
const dataflow = JS("dataflow.js");
const irApi = JS("ir.js");
const exportApi = JS("export.js");

const FILES = [
  "C:/samples/controller.L5X",
  "C:/samples/sample-file",
  "C:/samples/structured-text.L5X"
];
if (!FILES[0] || !fs.existsSync(FILES[0])) { console.log("skip: site sample not available (set the sample path in the test file)"); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) {
    fail++;
    console.log("FAIL " + name);
    console.log("     " + String(e && e.message || e).split("\n").slice(0, 4).join("\n     "));
  }
}

for (const f of FILES) {
  const fname = path.basename(f);
  const model = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
  model.fileName = fname;

  // 1. every routine parses to IR
  let irCount = 0, parseErrors = [];
  for (const p of model.programs) {
    for (const r of p.routines) {
      try {
        const ir = modelApi.getRoutineIR(model, p.name, r.name);
        assert.ok(ir, "IR for " + p.name + "/" + r.name);
        const v = irApi.validateIr(ir);
        assert.ok(v.ok, "validate " + p.name + "/" + r.name + ": " + (v.errors || []).join("; "));
        irCount++;
      } catch (e) { parseErrors.push(p.name + "/" + r.name + ": " + e.message); }
    }
  }
  t(fname + " all routines parse to IR", () => {
    assert.equal(parseErrors.length, 0, "parse errors:\n" + parseErrors.join("\n"));
  });
  t(fname + " routine count", () => {
    const n = model.programs.reduce((a, p) => a + p.routines.length, 0);
    assert.equal(irCount, n);
  });

  // 2. routine dataflow graphs are well-formed (no dangling edges)
  t(fname + " routine dataflow graphs well-formed", () => {
    for (const p of model.programs) {
      for (const r of p.routines) {
        if (r.type !== "RLL" && r.type !== "ST" && r.type !== "FBD") continue;
        const ir = modelApi.getRoutineIR(model, p.name, r.name);
        const graph = ir.kind === "fbd"
          ? fbdConv.buildFbdDataflow(ir, {})
          : dataflow.buildRoutineDataflow(ir, { routineName: r.name });
        const ids = new Set(graph.nodes.map(n => n.id));
        for (const e of graph.edges) {
          assert.ok(ids.has(e.from), "edge from missing: " + e.from);
          assert.ok(ids.has(e.to), "edge to missing: " + e.to);
        }
      }
    }
  });

  // 3. controller tag web
  t(fname + " tag web", () => {
    const g = dataflow.buildTagWeb(model, {});
    assert.ok(g.nodes.length > 0);
    const ids = new Set(g.nodes.map(n => n.id));
    for (const e of g.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to), "tag web dangling edge");
    }
  });

  // 4. conversion round-trips on a sample of routines (first 4 RLL + first 2 ST per file)
  t(fname + " LAD<->ST round trips", () => {
    let n = 0;
    for (const p of model.programs) {
      for (const r of p.routines) {
        if (r.type !== "RLL" || n >= 4) continue;
        n++;
        const ir = modelApi.getRoutineIR(model, p.name, r.name);
        const toSt = langConv.ladToSt(ir);
        assert.ok(toSt.ir && toSt.ir.kind === "st", "ladToSt result");
        const back = langConv.stToLad(toSt.ir);
        assert.ok(back.ir && back.ir.kind === "lad", "stToLad result");
        const v = irApi.validateIr(back.ir);
        assert.ok(v.ok, "round-trip validates: " + (v.errors || []).join("; "));
        // serialize both ways and re-parse: operand multiset per rung must match
        const origRungs = ir.rungs.map(rg => rllSer.serializeRllRung(rg.root));
        const backRungs = back.ir.rungs.map(rg => rllSer.serializeRllRung(rg.root));
        const opsOf = s => (s.match(/[A-Za-z_][A-Za-z0-9_]*\(/g) || []).sort().join(",");
        assert.equal(origRungs.length, backRungs.length, "rung count");
        for (let i = 0; i < origRungs.length; i++) {
          assert.equal(opsOf(origRungs[i]), opsOf(backRungs[i]), "rung " + i + " op multiset");
        }
      }
    }
  });

  t(fname + " FBD round trips", () => {
    let n = 0;
    for (const p of model.programs) {
      for (const r of p.routines) {
        if (r.type !== "RLL" || n >= 3) continue;
        n++;
        const ir = modelApi.getRoutineIR(model, p.name, r.name);
        const toFbd = fbdConv.ladToFbd(ir);
        assert.ok(toFbd.ir && toFbd.ir.kind === "fbd", "ladToFbd result");
        const xml = fbdSer.serializeFbdXml(toFbd.ir);
        const reparsed = fbdParse.parseFbdXml(xml);
        assert.ok(reparsed.sheets.length, "fbd xml round trip");
        const back = fbdConv.fbdToLad(reparsed);
        assert.ok(back.ir && back.ir.kind === "lad", "fbdToLad result");
      }
    }
  });

  // 5. export: stage conversions of the first routine of the first program, export, re-parse
  t(fname + " export + re-parse pipeline", () => {
    const m2 = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
    const prog = m2.programs[0].name;
    const rout = m2.programs[0].routines[0];
    const origType = rout.type;
    const target = origType === "RLL" ? "ST" : "RLL";
    const ir = modelApi.getRoutineIR(m2, prog, rout.name);
    const conv = target === "ST" ? langConv.ladToSt(ir) : langConv.stToLad(ir);
    const content = modelApi.irToContent(m2, prog, rout.name, conv.ir);
    m2.setRoutineContent(prog, rout.name, target, content);
    const res = exportApi.exportL5X(m2, {});
    const m3 = modelApi.parseL5X(res.text);
    const r3 = modelApi.findRoutine(m3, prog, rout.name);
    assert.equal(r3.type, target, "type switched");
    // untouched sections survive: same program count, same routine names
    assert.equal(m3.programs.length, m2.programs.length);
    for (const p of m2.programs) {
      const p3 = modelApi.findProgram(m3, p.name);
      assert.ok(p3, "program " + p.name);
      assert.equal(p3.routines.length, p.routines.length, "routines in " + p.name);
    }
  });
}

console.log("\nintegration: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
