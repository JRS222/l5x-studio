/* L5X Studio - test/integration2.js (Lead). Cross-feature integration for the
   improvement round: schema validation, I/O list, L5K decoding, C export, health,
   ACD metadata and AOI support, exercised over the three real L5X projects.
   Sections whose module has not been delivered yet are skipped with a notice. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
let schema, ioList, l5k, codegen, health, acdApi;
function tryRequire(p, name) {
  try { return require(path.join(__dirname, "..", "js", p)); }
  catch (e) { console.log("skip " + name + " (module not delivered: " + e.code + ")"); return null; }
}
schema = tryRequire("schema-validate.js", "schema validation");
ioList = tryRequire("io-list.js", "I/O list");
l5k = tryRequire("l5k-data.js", "L5K decoding");
codegen = tryRequire("codegen-c.js", "C export");
health = tryRequire("health.js", "health analysis");
acdApi = tryRequire("acd.js", "ACD reader");

const FILES = [
  "C:/samples/controller.L5X",
  "C:/samples/sample-file",
  "C:/samples/structured-text.L5X"
];
if (!FILES[0] || !fs.existsSync(FILES[0])) { console.log("skip: site sample not available (set the sample path in the test file)"); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 6).join("\n     ")); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 6).join("\n     ")); }
}

(async () => {
  const models = {};
  for (const f of FILES) {
    const name = path.basename(f);
    const model = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
    model.fileName = name;
    models[name] = model;
  }

  /* ---- schema validation ---- */
  if (schema) {
    for (const name of Object.keys(models)) {
      t("schema: " + name + " validates", () => {
        const res = schema.validateModel(models[name], {});
        assert.ok(res, "result");
        assert.equal((res.errors || []).length, 0,
          "errors: " + JSON.stringify((res.errors || []).slice(0, 5)));
        console.log("     " + name + ": schema " + (res.schemaVersion || "?") +
          ", " + (res.warnings || []).length + " warning(s)" +
          (res.elapsedMs !== undefined ? ", " + res.elapsedMs + " ms" : ""));
      });
    }
    t("schema: SAMPLE_RLL export stays valid", () => {
      const m = modelApi.parseL5X(fs.readFileSync(FILES[0], "utf8"));
      const prog = m.programs[0].name, rout = m.programs[0].routines[0];
      const ir = modelApi.getRoutineIR(m, prog, rout.name);
      const conv = JS("lang-convert.js").ladToSt(ir);
      m.setRoutineContent(prog, rout.name, "ST", modelApi.irToContent(m, prog, rout.name, conv.ir));
      const exported = JS("export.js").exportL5X(m, {}).text;
      const m2 = modelApi.parseL5X(exported);
      const res = schema.validateModel(m2, {});
      assert.equal((res.errors || []).length, 0,
        "export errors: " + JSON.stringify((res.errors || []).slice(0, 5)));
    });
  }

  /* ---- I/O list ---- */
  if (ioList) {
    for (const name of Object.keys(models)) {
      t("iolist: " + name, () => {
        const rows = ioList.buildIoListRows(models[name], {});
        assert.ok(rows.length > 0, "rows");
        const cols = ioList.defaultIoListColumns();
        assert.ok(cols.length >= 10, "columns");
        const csv = ioList.toCsv(rows, cols);
        assert.ok(csv.split(/\r?\n/).length >= rows.length + 1, "csv line count");
        const md = ioList.toMarkdown(rows, cols);
        assert.ok(md.indexOf("|") !== -1, "markdown table");
        const unusedOnly = ioList.applyFilters(rows, { unusedOnly: true });
        assert.ok(unusedOnly.length <= rows.length, "unused filter");
        const inputs = ioList.applyFilters(rows, { direction: "Input" });
        assert.ok(inputs.length <= rows.length, "direction filter");
        console.log("     " + name + ": " + rows.length + " points, " +
          rows.filter(r => r.used).length + " used, " +
          rows.filter(r => r.bufferTag).length + " with buffer tags");
      });
    }
    t("iolist: SAMPLE_RLL addresses match module images", () => {
      const rows = ioList.buildIoListRows(models["SAMPLE_RLL.L5X"], {});
      assert.ok(rows.some(r => /GR0\d?:[IO]/.test(r.address || "")), "GR module addresses present");
      assert.ok(rows.some(r => r.moduleName === "PDP"), "PDP present");
    });
  }

  /* ---- L5K decoding ---- */
  if (l5k) {
    t("l5k: decodes real tag initial values", () => {
      const model = models["SAMPLE_RLL.L5X"];
      let decoded = 0;
      for (const tag of model.tags.controller.slice(0, 40)) {
        if (!tag.initial) continue;
        const val = l5k.tagInitialValue(model, tag);
        assert.ok(val, "value for " + tag.name);
        decoded++;
      }
      assert.ok(decoded > 0, "no L5K values decoded");
      console.log("     decoded " + decoded + " controller tag initial values");
    });
    t("l5k: value forms", () => {
      assert.deepEqual(l5k.parseL5kValue("[1,2,3]", "DINT", null).kind, "array");
      assert.equal(l5k.parseL5kValue("2#1010", "BOOL", null).kind === "raw" ||
        l5k.parseL5kValue("2#1010", "BOOL", null).kind === "scalar", true);
      const bad = l5k.parseL5kValue("[1,2", "DINT", null);
      assert.ok(bad.kind === "raw", "malformed input is raw");
    });
  }

  /* ---- C export ---- */
  if (codegen) {
    t("codegen: SAMPLE_RLL project to C", () => {
      const t0 = Date.now();
      const res = codegen.generateC(models["SAMPLE_RLL.L5X"], { filenameBase: "plcmodel" });
      const ms = Date.now() - t0;
      const files = Object.keys(res.files || {});
      assert.ok(files.length >= 1, "files");
      const all = files.map(f => res.files[f]).join("\n");
      assert.ok(/typedef struct timer/.test(all) || /plcmodel/.test(all), "runtime present");
      assert.ok(all.length > 1000, "non-trivial output");
      assert.ok(Array.isArray(res.warnings), "warnings");
      console.log("     " + files.join(", ") + " (" + Math.round(all.length / 1024) + " KB) in " + ms + " ms, warnings=" + res.warnings.length);
    });
    t("codegen: ST routine to C (SAMPLE_ST)", () => {
      const model = models["SAMPLE_ST.L5X"];
      const prog = model.programs.find(p => p.routines.some(r => r.type === "ST"));
      const rout = prog.routines.find(r => r.type === "ST");
      const res = codegen.generateC(model, { programFilter: prog.name, routineFilter: rout.name });
      const all = Object.keys(res.files).map(f => res.files[f]).join("\n");
      assert.ok(all.length > 200, "output");
    });
  }

  /* ---- health ---- */
  if (health) {
    t("health: SAMPLE_RLL report", () => {
      const rep = health.analyzeProject(models["SAMPLE_RLL.L5X"], {});
      assert.ok(rep.summary, "summary");
      assert.equal(rep.summary.programs, 17);
      assert.equal(rep.summary.routines, 211);
      assert.equal(rep.summary.controllerTags, 77);
      assert.ok(Array.isArray(rep.unusedTags), "unusedTags");
      assert.ok(Array.isArray(rep.unresolvedOperands), "unresolvedOperands");
      assert.ok(Array.isArray(rep.uncalledRoutines), "uncalledRoutines");
      const md = health.toMarkdownReport(rep);
      assert.ok(md.length > 200, "markdown report");
      console.log("     unusedTags=" + rep.unusedTags.length + " unresolved=" + rep.unresolvedOperands.length +
        " uncalled=" + rep.uncalledRoutines.length + " findings=" + (rep.findings || []).length);
    });
  }

  /* ---- ACD metadata vs L5X ---- */
  if (acdApi) {
    const ACD_REAL = process.env.L5X_STUDIO_ACD || null;
    const ACD_CORPUS = path.join(__dirname, "..", "..", "repo-analysis", "acd", "resources", "ACDTestsWithAOI.ACD");
    const acdFile = fs.existsSync(ACD_REAL) ? ACD_REAL : (fs.existsSync(ACD_CORPUS) ? ACD_CORPUS : null);
    if (acdFile) {
      await ta("acd: metadata matches project", async () => {
        const b = fs.readFileSync(acdFile);
        const res = await acdApi.readAcd(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        assert.ok(res.dataTypes.length > 100, "data types");
        assert.ok(res.tags.length > 10, "tags");
        assert.ok(res.controller && res.controller.name, "controller name");
        console.log("     " + path.basename(acdFile) + ": " + res.dataTypes.length + " data types, " +
          res.tags.length + " tags, " + res.programs.length + " programs");
        if (path.basename(acdFile).indexOf("SAMPLE_RLL") !== -1) {
          const model = models["SAMPLE_RLL.L5X"];
          assert.equal(res.controller.name, model.controller.name);
          const acdTags = new Set(res.tags.filter(t => t.scope === "controller").map(t => t.name));
          for (const tag of model.tags.controller) assert.ok(acdTags.has(tag.name), "tag " + tag.name);
        }
      });
    } else console.log("skip ACD (no ACD file present)");
  }

  /* ---- AOI corpus robustness ---- */
  t("aoi: LogixLibraries corpus parses", () => {
    const dir = path.join(__dirname, "..", "..", "repo-analysis", "LogixLibraries");
    if (!fs.existsSync(dir)) { console.log("     (corpus missing, skipped)"); return; }
    const candidates = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.L5X$/i.test(e.name)) candidates.push(p);
      }
    })(dir);
    if (!candidates.length) { console.log("     (no L5X files in corpus)"); return; }
    const sample = candidates.filter(p => /_AOI\.L5X$/i.test(p)).slice(0, 3);
    let parsed = 0, aoidefs = 0;
    for (const f of sample) {
      const m = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
      parsed++;
      aoidefs += m.addOnInstructions.length;
    }
    assert.ok(parsed > 0, "parsed files");
    console.log("     " + parsed + " corpus files parsed, " + aoidefs + " AOI definitions");
  });

  console.log("\nintegration2: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FATAL: " + (e && e.stack || e)); process.exit(1); });
