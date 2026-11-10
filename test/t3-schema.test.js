/* T1 - L5X schema validation tests (owner: schema-validator)
   Covers: compiled rule tables (tools/build-xsd-rules.js -> js/data/schema-vNN.js),
   runtime API js/schema-validate.js (version picking, validation rules, caps, stats),
   js/ui/validation-panel.js pure helpers + Node-require safety, real projects
   (SAMPLE_RLL / SAMPLE_PROCESS / SAMPLE_ST), the Lead demo export, LogixLibraries corpus samples,
   negative tests and performance.

   Run: node test/t3-schema.test.js      (exits non-zero on failure) */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const WORKSPACE = path.join(ROOT, "..");
const REPO = path.join(WORKSPACE, "repo-analysis");
const XSD_DIR = path.join(REPO, "l5x-schema", "schemas");

const buildTool = require(path.join(ROOT, "tools", "build-xsd-rules.js"));
const modelApi = require(path.join(ROOT, "js", "l5x-model.js"));
const XML = require(path.join(ROOT, "js", "xml.js"));
const sv = require(path.join(ROOT, "js", "schema-validate.js"));
const panelApi = require(path.join(ROOT, "js", "ui", "validation-panel.js"));

const VERSIONS = ["v32", "v33", "v34", "v35", "v36", "v37", "v38"];

let pass = 0, fail = 0;
class SkipModel extends Error {}
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) {
    if (e instanceof SkipModel) { console.log("SKIP " + name + " (site sample not available)"); return; }
    fail++;
    console.log("FAIL " + name);
    console.log("     " + String(e && e.stack ? e.stack : e).split("\n").slice(0, 4).join("\n     "));
  }
}
function skip(name, why) { console.log("SKIP " + name + " (" + why + ")"); }

/* fixed report data for the final summary */
const report = { schemas: [], files: [], perf: {}, negatives: 0, corpus: [] };

/* --------------------------- helpers --------------------------- */

function requireRules(version) {
  return require(path.join(ROOT, "js", "data", "schema-" + version + ".js"));
}
function validateXml(xmlText, opts) {
  const rules = requireRules("v32");
  return sv.validateL5x(XML.parseXml(xmlText), rules, opts || {});
}
function codes(result) {
  return {
    errors: result.errors.map(function (e) { return e.code; }),
    warnings: result.warnings.map(function (w) { return w.code; })
  };
}
function hasCode(result, code) {
  return result.errors.some(function (e) { return e.code === code; }) ||
    result.warnings.some(function (w) { return w.code === code; });
}
function wrapController(inner, ctrlAttrs) {
  return '<RSLogix5000Content SoftwareRevision="32.03"><Controller Name="CTRL"' +
    (ctrlAttrs || "") + ">" + inner + "</Controller></RSLogix5000Content>";
}

const modelCache = {};
function loadModel(file) {
  if (!file || !fs.existsSync(file)) throw new SkipModel("site sample not available");
  if (!modelCache[file]) {
    const t0 = Date.now();
    const text = fs.readFileSync(file, "utf8");
    const model = modelApi.parseL5X(text);
    model.fileName = path.basename(file);
    modelCache[file] = { model: model, text: text, readMs: Date.now() - t0 };
  }
  return modelCache[file];
}
function firstExisting(list) {
  for (const p of list) if (fs.existsSync(p)) return p;
  return null;
}

const SAMPLE_RLL_FILE = firstExisting([
  "",
  ""
]);
const SAMPLE_PROCESS_FILE = firstExisting([
  ""
]);
const SAMPLE_ST_FILE = firstExisting([
  ""
]);
const DEMO_FILE = firstExisting([path.join(ROOT, "demo", "SAMPLE-project-modified.L5X")]);
const CORPUS_SYSTEM = path.join(REPO, "LogixLibraries", "src", "System", "System_Program.L5X");
const CORPUS_AOI = path.join(REPO, "LogixLibraries", "src", "Device", "Rockwell",
  "PowerFlex 525", "Dvc_PF525_AOI.L5X");

/* =============================================================
   1. build tool + generated rule tables
   ============================================================= */

console.log("\n--- compiled schema rules ---");

t("build tool exports main() and compiler (runnable as node tools/build-xsd-rules.js)", function () {
  assert.equal(typeof buildTool.main, "function");
  assert.equal(typeof buildTool.compileXsdText, "function");
  assert.equal(typeof buildTool.compileSchemaFile, "function");
  const src = fs.readFileSync(path.join(ROOT, "tools", "build-xsd-rules.js"), "utf8");
  assert.ok(/require\.main\s*===\s*module/.test(src), "CLI entry guard present");
});

t("all 7 schema rule files exist and are non-trivial", function () {
  for (const v of VERSIONS) {
    const file = path.join(ROOT, "js", "data", "schema-" + v + ".js");
    assert.ok(fs.existsSync(file), "missing " + file);
    const size = fs.statSync(file).size;
    assert.ok(size > 100000, v + " rule file too small: " + size);
    const rules = requireRules(v);
    assert.equal(rules.version, v, v + " version field");
    report.schemas.push({ version: v, bytes: size });
  }
});

t("compiled rules shape has elements/complexTypes/simpleTypes", function () {
  const rules = requireRules("v32");
  assert.ok(rules.elements && typeof rules.elements === "object");
  assert.ok(rules.complexTypes && typeof rules.complexTypes === "object");
  assert.ok(rules.simpleTypes && typeof rules.simpleTypes === "object");
  assert.ok(Object.keys(rules.complexTypes).length >= 130,
    "complexTypes count " + Object.keys(rules.complexTypes).length);
  assert.ok(Object.keys(rules.simpleTypes).length >= 130,
    "simpleTypes count " + Object.keys(rules.simpleTypes).length);
  assert.ok(Object.keys(rules.elements).length >= 200,
    "global elements count " + Object.keys(rules.elements).length);
  const controller = rules.complexTypes.ControllerType;
  assert.ok(controller, "ControllerType compiled");
  assert.ok(controller.elements.some(function (e) { return e.name === "Programs"; }));
  assert.ok(controller.elements.some(function (e) { return e.name === "Tags"; }));
  const tag = rules.complexTypes.TagType;
  assert.ok(tag.attributes.Name, "TagType.Name attribute");
  assert.equal(tag.attributes.Name.required, false);
  assert.ok(tag.elements.some(function (e) { return e.name === "Data" && e.choice === true; }),
    "TagType Data is a choice alternative");
  // enumeration resolution
  assert.deepStrictEqual(rules.simpleTypes.BoolEnum.enum.slice(0, 2), ["false", "true"]);
  assert.ok(rules.simpleTypes.RadixEnum.enum.indexOf("Decimal") >= 0);
  assert.ok(rules.simpleTypes.RoutineTypeEnum.enum.indexOf("RLL") >= 0);
  assert.ok(rules.simpleTypes.TagUsageEnum.enum.indexOf("Public") >= 0,
    "tolerated newer-firmware usage value compiled in");
  // required attributes come from use="required"
  const moduleType = rules.complexTypes.ModuleType;
  for (const a of ["Vendor", "ProductType", "ProductCode", "Major", "Minor"]) {
    assert.equal(moduleType.attributes[a].required, true, a + " required");
  }
  // xs:any tolerance recorded on the anonymous ExtendedProperties type
  const anon = Object.keys(rules.complexTypes).filter(function (k) { return rules.complexTypes[k].any; });
  assert.ok(anon.length >= 1, "xs:any preserved in rules");
  // mixed content flag
  assert.equal(rules.complexTypes.DescriptionType.mixed, true);
});

t("committed data files match a fresh compile of the real XSDs (not stale)", function () {
  if (!fs.existsSync(XSD_DIR)) { skip("fresh compile check", "XSD dir not present at " + XSD_DIR); return; }
  for (const v of VERSIONS) {
    const xsd = path.join(XSD_DIR, "l5x-" + v + ".xsd");
    assert.ok(fs.existsSync(xsd), "missing XSD " + xsd);
    const compiled = buildTool.compileXsdText(fs.readFileSync(xsd, "utf8"), "l5x-" + v + ".xsd");
    assert.deepStrictEqual(compiled.stats.problems, [], v + " has unresolved type references");
    assert.equal(compiled.stats.complexTypes, 138, v + " complexTypes");
    assert.equal(compiled.stats.simpleTypes, 137, v + " simpleTypes");
    assert.equal(compiled.stats.enumerations, 696, v + " enumerations (incl. tolerated extras)");
    assert.equal(compiled.stats.anyTypes, 1, v + " xs:any types");
    const committed = requireRules(v);
    assert.deepStrictEqual(committed.version, compiled.rules.version, v + " version");
    assert.deepStrictEqual(committed.elements, compiled.rules.elements, v + " elements stale");
    assert.deepStrictEqual(committed.complexTypes, compiled.rules.complexTypes, v + " complexTypes stale");
    assert.deepStrictEqual(committed.simpleTypes, compiled.rules.simpleTypes, v + " simpleTypes stale");
  }
});

t("generated files also work as browser classic scripts (namespace registration)", function () {
  for (const v of VERSIONS) {
    const file = path.join(ROOT, "js", "data", "schema-" + v + ".js");
    const sandbox = { self: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
    const ns = sandbox.self.L5XStudio;
    assert.ok(ns && ns.SCHEMA_RULES, v + " namespace assigned");
    assert.equal(ns.SCHEMA_RULES[v].version, v);
    assert.ok(Object.keys(ns.SCHEMA_RULES[v].complexTypes).length >= 130);
  }
});

/* =============================================================
   2. schema version API
   ============================================================= */

console.log("\n--- version API ---");

t("availableSchemaVersions() returns v32..v38 sorted", function () {
  assert.deepStrictEqual(sv.availableSchemaVersions(), VERSIONS);
});

t("pickSchemaVersion uses SoftwareRevision first two digits", function () {
  assert.equal(sv.pickSchemaVersion({ controller: { softwareRevision: "32.03" } }), "v32");
  assert.equal(sv.pickSchemaVersion({ controller: { softwareRevision: "35.00" } }), "v35");
  assert.equal(sv.pickSchemaVersion({ controller: { softwareRevision: "38.11" } }), "v38");
});

t("pickSchemaVersion falls back to root attrs then newest available", function () {
  // 24 is below the oldest compiled schema -> newest available per contract fallback
  assert.equal(sv.pickSchemaVersion({ controller: { softwareRevision: "24.00" } }), "v38");
  assert.equal(sv.pickSchemaVersion({}), "v38");
  const model = { controller: {}, raw: { rootNode: { attrs: { SchemaRevision: "1.0", SoftwareRevision: "34.02" } } } };
  assert.equal(sv.pickSchemaVersion(model), "v34");
  assert.equal(sv.pickSchemaVersion(null), "v38");
});

t("validateModel honours opts.version and rejects unknown versions", function () {
  const model = loadModel(SAMPLE_RLL_FILE).model;
  const r32 = sv.validateModel(model, { version: "v32" });
  assert.equal(r32.stats.version, "v32");
  const r33 = sv.validateModel(model, { version: "v33" });
  assert.equal(r33.stats.version, "v33");
  assert.equal(r33.ok, true, "SAMPLE_RLL also validates against v33");
  const bad = sv.validateModel(model, { version: "v99" });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "NO_SCHEMA");
});

t("summarizeResult returns { errors, warnings, ok }", function () {
  assert.deepStrictEqual(sv.summarizeResult({ errors: [], warnings: [] }), { errors: 0, warnings: 0, ok: true });
  const res = validateXml(wrapController("<Tags><Tag DataType='DINT'/></Tags>"));
  const sum = sv.summarizeResult(res);
  assert.equal(sum.ok, false);
  assert.equal(sum.errors, res.errors.length);
  assert.equal(sum.warnings, res.warnings.length);
});

/* =============================================================
   3. real projects: SAMPLE_RLL / SAMPLE_PROCESS / SAMPLE_ST / demo export
   ============================================================= */

console.log("\n--- real projects ---");

function realFileTest(label, file, expectedVersion, minElements) {
  t(label + " validates with 0 errors", function () {
    if (!file) { console.log("     (skipped: " + label + " not available on this machine)"); return; }
    const loaded = loadModel(file);
    const res = sv.validateModel(loaded.model);
    assert.equal(res.ok, true, label + " errors: " + res.errors.slice(0, 5).map(function (e) {
      return e.code + "@" + e.path + " :: " + e.message;
    }).join(" | "));
    assert.deepStrictEqual(res.errors, []);
    assert.equal(res.stats.version, expectedVersion, label + " schema version");
    assert.ok(res.stats.elements >= minElements, label + " elements " + res.stats.elements);
    const fileReport = {
      label: label, file: path.basename(file), version: res.stats.version,
      errors: res.errors.length, warnings: res.warnings.length,
      elements: res.stats.elements, attributes: res.stats.attributes, ok: res.ok
    };
    report.files.push(fileReport);
    console.log("     " + fileReport.file + ": schema " + fileReport.version + ", " +
      fileReport.errors + " errors, " + fileReport.warnings + " warnings, " +
      fileReport.elements + " elements, " + fileReport.attributes + " attributes");
  });
}

realFileTest("SAMPLE_RLL.L5X", SAMPLE_RLL_FILE, "v32", 70000);
realFileTest("SAMPLE_PROCESS.L5X", SAMPLE_PROCESS_FILE, "v38", 30000);       // SW 24.00 -> newest fallback
realFileTest("SAMPLE_ST.L5X", SAMPLE_ST_FILE, "v38", 150000);    // SW 30.00 -> newest fallback
realFileTest("demo export SAMPLE-project-modified.L5X", DEMO_FILE, "v32", 70000);

t("SAMPLE_RLL model picks v32 and has only tolerated warnings", function () {
  const res = sv.validateModel(loadModel(SAMPLE_RLL_FILE).model);
  assert.equal(sv.pickSchemaVersion(loadModel(SAMPLE_RLL_FILE).model), "v32");
  assert.ok(res.warnings.length <= 10, "warnings are few: " + res.warnings.length);
  for (const w of res.warnings) assert.equal(w.severity, "warning");
});

t("validateL5x accepts both plain root element and #doc wrapper (Node/browser parity)", function () {
  const loaded = loadModel(SAMPLE_RLL_FILE);
  const rules = requireRules("v32");
  const direct = sv.validateL5x(loaded.model.raw.rootNode, rules, {});
  assert.equal(direct.ok, true, "direct root node");
  assert.equal(direct.stats.version, "v32");
  const wrapped = sv.validateL5x(loaded.model.xml, rules, {});
  assert.equal(wrapped.ok, true, "#doc wrapper");
  assert.equal(wrapped.stats.elements, direct.stats.elements);
});

t("validateL5x reports unknown root element", function () {
  const res = sv.validateL5x(XML.parseXml("<Bogus/>"), requireRules("v32"), {});
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "UNKNOWN_ELEMENT");
  assert.equal(sv.validateL5x(null, requireRules("v32"), {}).errors[0].code, "NO_ROOT");
  assert.equal(sv.validateL5x(XML.parseXml("<A/>"), null, {}).errors[0].code, "NO_SCHEMA");
});

/* =============================================================
   4. LogixLibraries corpus samples
   ============================================================= */

console.log("\n--- LogixLibraries corpus ---");

function corpusTest(label, file) {
  t("corpus " + label + " validates with 0 errors", function () {
    if (!fs.existsSync(file)) { skip("corpus " + label, "file not present"); return; }
    const loaded = loadModel(file);
    const res = sv.validateModel(loaded.model);
    assert.deepStrictEqual(res.errors.map(function (e) {
      return e.code + "@" + e.path + " :: " + e.message;
    }), [], "corpus errors");
    assert.ok(res.ok);
    report.corpus.push({ label: label, version: res.stats.version,
      errors: 0, warnings: res.warnings.length, elements: res.stats.elements });
    console.log("     " + label + ": schema " + res.stats.version + ", 0 errors, " +
      res.warnings.length + " warnings (newer-firmware extensions tolerated), " +
      res.stats.elements + " elements");
  });
}

corpusTest("System_Program.L5X", CORPUS_SYSTEM);
corpusTest("Dvc_PF525_AOI.L5X", CORPUS_AOI);

/* =============================================================
   5. negative tests (hand-crafted XML)
   ============================================================= */

console.log("\n--- negative tests ---");

t("missing Name on <Tag> -> REQUIRED_ATTR error", function () {
  const res = validateXml(wrapController("<Tags><Tag DataType='DINT' TagType='Base'/></Tags>"));
  assert.equal(res.ok, false);
  const err = res.errors.filter(function (e) { return e.code === "REQUIRED_ATTR"; });
  assert.ok(err.length >= 1, "REQUIRED_ATTR raised");
  assert.ok(/Tags\/Tag/.test(err[0].path), "path " + err[0].path);
  assert.ok(/Name/.test(err[0].message));
  report.negatives++;
});

t("bad Radix enum -> BAD_ENUM error", function () {
  const res = validateXml(wrapController(
    "<Tags><Tag Name='T' TagType='Base' Radix='Bogus' DataType='DINT'/></Tags>"));
  const err = res.errors.filter(function (e) { return e.code === "BAD_ENUM"; });
  assert.equal(err.length, 1, "one BAD_ENUM: " + res.errors.map(function (e) { return e.code; }));
  assert.ok(/Radix/.test(err[0].message));
  report.negatives++;
});

t("Routine Type='ST' containing <RLLContent> -> ROUTINE_TYPE_MISMATCH", function () {
  const res = validateXml(wrapController(
    "<Programs><Program Name='P'><Routines>" +
    "<Routine Name='R' Type='ST'><RLLContent/></Routine>" +
    "</Routines></Program></Programs>"));
  assert.equal(res.ok, false);
  const err = res.errors.filter(function (e) { return e.code === "ROUTINE_TYPE_MISMATCH"; });
  assert.equal(err.length, 1);
  assert.ok(/STContent/.test(err[0].message));
  report.negatives++;
});

t("empty routine without content element is valid Studio output", function () {
  const res = validateXml(wrapController(
    "<Programs><Program Name='P'><Routines><Routine Name='R' Type='RLL'/></Routines>" +
    "</Program></Programs>"));
  assert.deepStrictEqual(res.errors, []);
});

t("unknown attribute/element are warnings (errors in strictUnknown mode)", function () {
  const xml = wrapController("<DataTypes/><NewThing/>", ' Foo="1"');
  const loose = validateXml(xml);
  assert.equal(loose.ok, true, "tolerant by default");
  assert.ok(codes(loose).warnings.indexOf("UNKNOWN_ATTR") >= 0);
  assert.ok(codes(loose).warnings.indexOf("UNKNOWN_ELEMENT") >= 0);
  const strict = validateXml(xml, { strictUnknown: true });
  assert.equal(strict.ok, false);
  assert.ok(codes(strict).errors.indexOf("UNKNOWN_ATTR") >= 0);
  assert.ok(codes(strict).errors.indexOf("UNKNOWN_ELEMENT") >= 0);
  report.negatives++;
});

t("out-of-order element -> ORDER error", function () {
  const res = validateXml(wrapController("<Programs/><DataTypes/>"));
  assert.equal(res.ok, false);
  assert.ok(codes(res).errors.indexOf("ORDER") >= 0, "ORDER raised: " + codes(res).errors);
  report.negatives++;
});

t("maxOccurs violation -> TOO_MANY error", function () {
  const res = validateXml(wrapController("<Tags/><Tags/>"));
  assert.equal(res.ok, false);
  assert.ok(codes(res).errors.indexOf("TOO_MANY") >= 0, "TOO_MANY raised: " + codes(res).errors);
  report.negatives++;
});

t("missing required attribute (xs:use=required) -> REQUIRED_ATTR", function () {
  const res = validateXml(wrapController("<Modules><Module Name='M'/></Modules>"));
  assert.equal(res.ok, false);
  const req = res.errors.filter(function (e) { return e.code === "REQUIRED_ATTR"; });
  assert.ok(req.length >= 5, "expected >=5 required attrs, got " + req.length);
  for (const a of ["Vendor", "ProductType", "ProductCode", "Major", "Minor"]) {
    assert.ok(req.some(function (e) { return e.message.indexOf(a) >= 0; }), "mentions " + a);
  }
  report.negatives++;
});

t("invalid numeric base value -> BAD_ENUM error", function () {
  const res = validateXml(wrapController(
    "<Tags><Tag Name='T' TagType='Base' DataType='DINT' UId='not-a-number'/></Tags>"));
  assert.equal(res.ok, false);
  assert.ok(codes(res).errors.indexOf("BAD_ENUM") >= 0);
  assert.ok(/UId/.test(res.errors[0].message));
  report.negatives++;
});

t("Reference/Context stub modules tolerate omitted required attributes", function () {
  const res = validateXml(wrapController(
    "<Modules><Module Use='Reference' Name='M'/></Modules>"));
  assert.deepStrictEqual(res.errors, [], "stub module tolerated");
});

t("xs:any container tolerates unknown children", function () {
  const res = validateXml(wrapController(
    "<Modules><Module Name='M' Vendor='1' ProductType='1' ProductCode='1' Major='1'" +
    " Minor='1' ParentModPortId='0'><ExtendedProperties><CustomThing foo='1'/></ExtendedProperties>" +
    "</Module></Modules>"));
  assert.deepStrictEqual(res.errors, []);
  assert.ok(!hasCode(res, "UNKNOWN_ELEMENT"), "no UNKNOWN_ELEMENT inside xs:any");
});

t("MISSING_CONTENT enforced for minOccurs>=1 (synthetic rules)", function () {
  const rules = {
    version: "vTest",
    elements: { Root: { type: "RootType" } },
    complexTypes: {
      RootType: {
        elements: [
          { name: "Required", type: "xs:string", min: 1, max: 1, choice: false },
          { name: "Optional", type: "xs:string", min: 0, max: 1, choice: false }
        ],
        attributes: {}
      }
    },
    simpleTypes: {}
  };
  const res = sv.validateL5x(XML.parseXml("<Root><Optional>x</Optional></Root>"), rules, {});
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "MISSING_CONTENT");
  const okRes = sv.validateL5x(XML.parseXml("<Root><Required>x</Required></Root>"), rules, {});
  assert.deepStrictEqual(okRes.errors, []);
  report.negatives++;
});

t("maxIssues caps output and marks stats.truncated", function () {
  let xml = '<RSLogix5000Content><Controller Name="C">';
  for (let i = 0; i < 40; i++) xml += '<Junk' + i + ' Foo="1" Bar="2"/>';
  xml += "</Controller></RSLogix5000Content>";
  const res = validateXml(xml, { maxIssues: 5 });
  assert.ok(res.errors.length + res.warnings.length <= 5,
    "issues " + (res.errors.length + res.warnings.length));
  assert.equal(res.stats.truncated, true);
  // default cap is 500
  const def = validateXml(xml);
  assert.ok(def.errors.length + def.warnings.length <= 500);
});

/* =============================================================
   6. UI panel module
   ============================================================= */

console.log("\n--- validation panel ---");

t("validation-panel module requires in Node without DOM", function () {
  assert.equal(typeof panelApi.ValidationPanel, "function");
  assert.equal(typeof panelApi.groupIssues, "function");
  assert.equal(typeof panelApi.formatValidationSummary, "function");
  const p = new panelApi.ValidationPanel({ container: null, app: {} });
  assert.equal(typeof p.refresh, "function");
  assert.equal(typeof p.runValidation, "function");
  p.refresh(); // must not throw without DOM
});

t("panel.groupIssues puts errors first and groups severities", function () {
  const groups = panelApi.groupIssues({
    errors: [{ path: "A", code: "X", message: "m", severity: "error" }],
    warnings: [{ path: "B", code: "Y", message: "n", severity: "warning" },
      { path: "C", code: "Z", message: "o", severity: "warning" }]
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].severity, "error");
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[1].severity, "warning");
  assert.equal(groups[1].items.length, 2);
  assert.deepStrictEqual(panelApi.groupIssues({ errors: [], warnings: [] }), []);
});

t("panel.formatValidationSummary reports counts and schema version", function () {
  const s = panelApi.formatValidationSummary({
    errors: [], warnings: [1, 2], stats: { version: "v32", truncated: false }
  });
  assert.ok(/v32/.test(s));
  assert.ok(/0 errors/.test(s));
  assert.ok(/2 warnings/.test(s));
  const e = panelApi.formatValidationSummary({
    errors: [{}, {}], warnings: [], stats: { version: "v38" }
  });
  assert.ok(/2 errors/.test(e));
});

t("panel.runValidation fallback validates app.model and stores result", function () {
  const stored = { result: null };
  const app = {
    model: loadModel(SAMPLE_RLL_FILE).model,
    runValidation: undefined,
    getValidationResult: function () { return stored.result; },
    setValidationResult: function (r) { stored.result = r; },
    status: function () {}
  };
  const p = new panelApi.ValidationPanel({ container: null, app: app });
  const res = p.runValidation();
  assert.ok(res && res.errors, "result returned");
  assert.equal(res.ok, true);
  assert.equal(stored.result, res, "stored through app.setValidationResult");
});

t("panel.runValidation prefers Lead app.runValidation hook", function () {
  const hookResult = { ok: true, errors: [], warnings: [], stats: { version: "v32" } };
  let calledWith = null;
  const app = {
    model: { controller: {} },
    runValidation: function (version) { calledWith = version; return hookResult; },
    getValidationResult: function () { return null; },
    setValidationResult: function () {},
    status: function () {}
  };
  const p = new panelApi.ValidationPanel({ container: null, app: app });
  const res = p.runValidation();
  assert.equal(res, hookResult);
  assert.equal(panelApi.groupIssues(res).length, 0);
  p.refresh();
});

t("panel.runValidation honours explicit schema selection when the hook ignores it", function () {
  const autoResult = { ok: true, errors: [], warnings: [], stats: { version: "v32" } };
  const stored = { result: null };
  const app = {
    model: loadModel(SAMPLE_RLL_FILE).model,
    runValidation: function () { return autoResult; },
    getValidationResult: function () { return stored.result; },
    setValidationResult: function (r) { stored.result = r; },
    status: function () {}
  };
  const p = new panelApi.ValidationPanel({ container: null, app: app });
  p._select = { value: "v33" }; // simulate the DOM select without a DOM
  const res = p.runValidation();
  assert.equal(res.stats.version, "v33", "explicit selection wins");
  assert.equal(res.ok, true);
  assert.equal(stored.result, res, "stored through app.setValidationResult");
  assert.equal(autoResult.stats.version, "v32");
});

t("browser-parity: classic scripts register namespace and validate without CommonJS", function () {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  sandbox.self = sandbox; // browsers: self === window === global object
  // index.html defines this global for the UMD modules' browser fallback path
  vm.runInContext('var root = typeof self !== "undefined" ? self : this;', sandbox);
  const load = function (rel) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  };
  load("js/xml.js");
  for (const v of VERSIONS) load(path.join("js", "data", "schema-" + v + ".js"));
  load("js/schema-validate.js");
  const ns = sandbox.L5XStudio;
  assert.ok(ns, "L5XStudio namespace created");
  assert.equal(typeof ns.validateModel, "function");
  assert.equal(typeof ns.validateL5x, "function");
  assert.equal(typeof ns.ValidationPanel, "undefined"); // panel is a separate script tag
  assert.equal(ns.availableSchemaVersions().join(","), VERSIONS.join(","),
    "versions from namespace registry");
  const xml = '<RSLogix5000Content SoftwareRevision="32.03"><Controller Name="C">' +
    "<Tags><Tag Name='T' TagType='Base' DataType='DINT'/></Tags></Controller></RSLogix5000Content>";
  const model = {
    fileName: "browser-parity.L5X",
    controller: { softwareRevision: "32.03" },
    raw: { rootNode: ns.parseXml(xml) }
  };
  const res = ns.validateModel(model);
  assert.equal(res.ok, true);
  assert.equal(res.stats.version, "v32");
});

/* ---- tiny DOM stub for panel rendering in browser-mode (no jsdom dependency) ---- */
function makeDomStub() {
  let nextId = 0;
  function el(tag) {
    return {
      _id: ++nextId, tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
      className: "", value: "", dataset: {}, title: "", style: {}, attrs: {}, _ev: {},
      _text: "", _innerHTML: "",
      set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
      get innerHTML() { return this._innerHTML; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
      appendChild(c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
        if (c) { c.parentNode = this; this.children.push(c); }
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      },
      addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
      dispatch(t, ev) { (this._ev[t] || []).forEach(function (f) { f.call(this, ev || {}); }); return true; }
    };
  }
  return { document: { createElement: el }, el: el };
}

t("panel renders and honours schema select in browser mode (DOM stub)", function () {
  const dom = makeDomStub();
  const sandbox = { console: console, document: dom.document };
  vm.createContext(sandbox);
  sandbox.self = sandbox;
  vm.runInContext('var root = typeof self !== "undefined" ? self : this;', sandbox);
  const load = function (rel) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  };
  load("js/xml.js");
  load("js/schema-validate.js");
  for (const v of VERSIONS) load(path.join("js", "data", "schema-" + v + ".js"));
  load("js/ui/validation-panel.js");
  const ns = sandbox.L5XStudio;
  assert.equal(typeof ns.ValidationPanel, "function", "panel registered in browser mode");

  const xml = '<RSLogix5000Content SoftwareRevision="32.03"><Controller Name="C">' +
    "<Tags><Tag Name='T' TagType='Base' DataType='DINT'/></Tags></Controller></RSLogix5000Content>";
  const model = { fileName: "ui.L5X", controller: { softwareRevision: "32.03" }, raw: { rootNode: ns.parseXml(xml) } };
  let stored = ns.validateModel(model);
  const statuses = [];
  const app = {
    model: model,
    status: function (msg, isErr) { statuses.push([msg, !!isErr]); },
    getValidationResult: function () { return stored; },
    setValidationResult: function (r) { stored = r; },
    runValidation: function () { stored = ns.validateModel(model); return stored; }
  };
  const container = dom.el("div");
  const p = new ns.ValidationPanel({ container: container, app: app });
  assert.equal(container.children.length, 1, "panel body built");
  const wrap = container.children[0];
  assert.equal(wrap.children.length, 3, "toolbar + status + issue list");
  const statusEl = wrap.children[1];
  assert.ok(/schema v32/.test(statusEl.textContent), "status shows schema: " + statusEl.textContent);
  assert.ok(/0 errors/.test(statusEl.textContent));
  // explicit schema selection goes through the Lead runValidation hook
  const toolbar = wrap.children[0];
  const select = toolbar.children[1];
  assert.equal(select.children.length, VERSIONS.length + 1, "Auto + 7 versions");
  select.value = "v33";
  select.dispatch("change");
  assert.equal(stored.stats.version, "v33", "explicit selection validated with v33");
  assert.ok(/schema v33/.test(statusEl.textContent));
  // error rendering
  const badModel = {
    fileName: "bad.L5X", controller: { softwareRevision: "32.03" },
    raw: { rootNode: ns.parseXml('<RSLogix5000Content><Controller Name="C"><Tags><Tag DataType="DINT"/></Tags></Controller></RSLogix5000Content>') }
  };
  stored = ns.validateModel(badModel);
  p.refresh();
  const listEl = wrap.children[2];
  assert.ok(/Errors \(1\)/.test(listEl.children[0].textContent), "error group rendered");
  assert.ok(/1 error/.test(statusEl.textContent));
});

/* =============================================================
   7. performance
   ============================================================= */

console.log("\n--- performance ---");

t("validation of SAMPLE_RLL is under 3 seconds", function () {
  if (!SAMPLE_RLL_FILE) { skip("SAMPLE_RLL perf", "file not found"); return; }
  const model = loadModel(SAMPLE_RLL_FILE).model;
  // warm the rules cache, then time the real validation (not the file parse)
  sv.validateModel(model);
  const t0 = Date.now();
  const res = sv.validateModel(model);
  const ms = Date.now() - t0;
  report.perf.sampleRllValidateMs = ms;
  report.perf.sampleRllElements = res.stats.elements;
  assert.equal(res.ok, true);
  assert.ok(ms < 3000, "SAMPLE_RLL validation took " + ms + "ms (limit 3000ms)");
  console.log("     SAMPLE_RLL validate: " + ms + "ms for " + res.stats.elements + " elements (" +
    Math.round(res.stats.elements / Math.max(ms, 1)) + " elements/ms)");
});

t("validation of SAMPLE_ST (196k elements) stays interactive (< 5s)", function () {
  if (!SAMPLE_ST_FILE) { skip("SAMPLE_ST perf", "file not found"); return; }
  const model = loadModel(SAMPLE_ST_FILE).model;
  sv.validateModel(model);
  const t0 = Date.now();
  const res = sv.validateModel(model);
  const ms = Date.now() - t0;
  report.perf.sampleStValidateMs = ms;
  assert.equal(res.ok, true);
  assert.ok(ms < 5000, "SAMPLE_ST validation took " + ms + "ms");
  console.log("     SAMPLE_ST validate: " + ms + "ms for " + res.stats.elements + " elements");
});

/* =============================================================
   summary
   ============================================================= */

console.log("\n================ T1 SCHEMA VALIDATION SUMMARY ================");
console.log("Schema versions compiled:");
for (const s of report.schemas) {
  console.log("  " + s.version + "  " + (s.bytes / 1024).toFixed(1) + " KiB");
}
console.log("Real files validated:");
for (const f of report.files) {
  console.log("  " + f.file + ": schema " + f.version + ", " + f.errors + " errors, " +
    f.warnings + " warnings (" + f.elements + " elements, " + f.attributes + " attributes)");
}
for (const c of report.corpus) {
  console.log("  corpus " + c.label + ": schema " + c.version + ", " + c.errors + " errors, " +
    c.warnings + " warnings (" + c.elements + " elements)");
}
console.log("Negative tests exercised: " + report.negatives + " crafted error scenarios");
console.log("Performance: SAMPLE_RLL " + (report.perf.sampleRllValidateMs || "?") + "ms, SAMPLE_ST " +
  (report.perf.sampleStValidateMs || "?") + "ms (validation only, file parse excluded)");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
