/* L5X Studio - test/t8-conveyor-gen.test.js
   Conveyor Design Studio template extractor + L5X generator + HMI generator tests.

   Model v2 engineering scheme (js/conveyor/model.js, SAMPLE_RLL semantics):
     - chained straight / curved / spiral segments, angled joints with rounded edges;
     - one 1799ER block + one NETS[1].ZPA[g] UDT instance per ZONE GROUP of <=8 zones
       (roller conveyors) and one instantiated ZPA1_<n>ZONE_SCAN_ZONE routine per group;
     - belt conveyors (design.conveyorType "belt") generate per-segment belt drives
       (RUN_CMD latch + SAFETY_OK/fault interlocks, PowerFlex 525 AOI when requested)
       instead of per-zone ZPA scan routines;
     - scan zones + tray/barcode tracking: TRAY_TRACK UDT, TRACK_TBL/TRACK_COUNT/
       TRACK_RESET tags, scanner tags, TRACK_INIT/SCAN/MOVE/CLEAR routines (authored
       in ST, converted to ladder via L5XStudio.stToLad).

   Covers (docs/CONVEYOR.md T-F):
     1. extractor output inventory + determinism
     2. roller program/controller generation (group scans, Main JSR order, tags,
        ENET dimensions, schema 0 errors)
     3. curve/spiral geometry recorded in routine descriptions/Main comments
     4. belt mode drive section (+ optional PowerFlex 525 AOI embedding/call)
     5. scan zones + tray tracking routines/tags + schema/parse-back
     6. HMI: canvas + simulator executes, belt/spiral/scanner drawing, tray table,
        tag CSV (zones + tracking/scanner tags), graphics spec (layout + tracking)

   Node runner:  node test/t8-conveyor-gen.test.js   (exit non-zero on failure)
*/
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const JS = p => require(path.join(ROOT, "js", p));

const model = JS("conveyor/model.js");
const L5X = JS("l5x-model.js");
const schema = JS("schema-validate.js");
const gen = JS("conveyor/l5xgen.js");
const hmi = JS("conveyor/hmi.js");

const TEMPLATES_FILE = path.join(ROOT, "js", "data", "conveyor-templates.js");
const TEMPLATES = require(TEMPLATES_FILE);
const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || null;

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) {
    fail++; failures.push(name + ": " + (e && e.stack || e));
    console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 10).join("\n     "));
  }
}
function section(name) { console.log("\n--- " + name + " ---"); }

/* ------------------------------------------------------------------ designs */

function makeDesign(name) {
  const d = model.createDefaultDesign();
  d.name = name;
  return d;
}
/* 2 segments / 6 zones (4 + 2) -> 2 ZPA groups / 2 blocks */
function rollerDesign(name) {
  const d = makeDesign(name || "T8_CONVEYOR");
  d.segments = [
    { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg2", name: "SEG2", kind: "straight", x: 4.05, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null }
  ];
  return d;
}
/* straight + curve + spiral (roller) */
function curveSpiralDesign(name) {
  const d = makeDesign(name || "CURVE_SPIRAL");
  d.segments = [
    { id: "c1", name: "CURVE1", kind: "curve", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, radiusM: 1.2, curveDeg: 90, widthM: 0.6, zones: 4, zoneLengthM: 1 },
    { id: "sp1", name: "SPIRAL1", kind: "spiral", x: 0, y: 0, z: 0, turnDeg: 0, radiusM: 1.2, spiral: { pitchM: 0.5, heightM: 1.5, direction: "up" }, widthM: 0.6, zoneLengthM: 1 },
    { id: "s3", name: "SEG3", kind: "straight", turnDeg: 30, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  return d;
}
/* Lead integration3 demo: 3 segments / 9 zones (4 + 2 + 3) -> 3 groups */
function demoDesign9(name) {
  const d = makeDesign(name || "DEMO_CONVEYOR");
  d.segments = [
    { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1 },
    { id: "seg2", name: "SEG2", kind: "straight", x: 4.05, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "seg3", name: "SEG3", kind: "straight", x: 6.1, y: 0, z: 0, rotationDeg: -30, turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1 }
  ];
  return d;
}
/* belt conveyor: 2 belt segments / 6 zones */
function beltDesign(name) {
  const d = makeDesign(name || "BELT_LINE");
  d.conveyorType = "belt";
  d.segments = [
    { id: "b1", name: "BELT1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1 },
    { id: "b2", name: "BELT2", kind: "straight", turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  return d;
}
/* roller conveyor with 2 scan zones + tracking */
function trackingDesign(name) {
  const d = rollerDesign(name || "TRACK_ROLLER");
  d.scanZones = [
    { id: "sc1", name: "SCAN1", segmentId: "seg1", offsetM: 1.0, type: "barcode", side: "right" },
    { id: "sc2", name: "SCAN2", segmentId: "seg2", offsetM: 1.0, type: "barcode", side: "left" }
  ];
  d.tracking = { enabled: true, maxTrays: 8, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  return d;
}
function beltTrackingDesign(name) {
  const d = beltDesign(name || "TRACK_BELT");
  d.scanZones = [{ id: "sca", name: "SCANA", segmentId: "b1", offsetM: 2.0, type: "barcode", side: "right" }];
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 24, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  return d;
}
/* main line (straight + curve + straight) + spur chain + merge + pusher/rotary/popup */
function deviceMergeDesign(name) {
  const d = makeDesign(name || "FULL_LINE");
  d.segments = [
    { id: "main1", name: "MAIN1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1 },
    { id: "main2", name: "MAIN2", kind: "curve", turnDeg: 0, radiusM: 1.414, curveDeg: 45, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "main3", name: "MAIN3", kind: "straight", turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1 },
    { id: "spur1", name: "SPUR1", kind: "straight", newChain: true, x: 0, y: 2, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "spur2", name: "SPUR2", kind: "straight", turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  d.merges = [{ id: "mg1", name: "MERGE1", mainSegmentId: "main3", spurEndSegmentId: "spur2", offsetM: 2.0, priority: "alternate" }];
  d.transfers = [
    { id: "tf1", name: "PUSHER1", type: "pusher", segmentId: "main1", offsetM: 2.0, side: "right", extendTimeS: 0.8 },
    { id: "tf2", name: "ROTARY1", type: "rotary_table", segmentId: "main3", offsetM: 1.5, stepDeg: 90, rotateTimeS: 3.0 },
    { id: "tf3", name: "POPUP1", type: "popup_transfer", segmentId: "main2", offsetM: 0.5, directions: ["left", "right"], beltCount: 3, raiseTimeS: 0.5 }
  ];
  d.scanZones = [{ id: "sc1", name: "SCAN1", segmentId: "main1", offsetM: 1.0, type: "barcode", side: "right" }];
  d.tracking = { enabled: true, maxTrays: 8, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  return d;
}

/* ------------------------------------------------------------- test helpers */

function parseAndValidate(res) {
  const parsed = L5X.parseL5X(res.l5x);
  const vr = schema.validateModel(parsed, {});
  return { parsed, vr };
}
function routineByName(program, name) { return program.routines.find(r => r.name === name) || null; }
function routineText(program, name) {
  const r = routineByName(program, name);
  assert.ok(r, "routine " + name + " exists");
  return r.content.rungs.map(x => (x.comment ? "/* " + x.comment + " */ " : "") + x.text).join(" ");
}
function rungTexts(program, name) {
  const r = routineByName(program, name);
  assert.ok(r, "routine " + name + " exists");
  return r.content.rungs.map(x => x.text);
}
function controllerTag(parsed, name) { return parsed.tags.controller.find(t => t.name === name); }
function programTags(parsed, programName) { return parsed.tags.programs[programName] || []; }
function dataTypeNames(parsed) { return parsed.dataTypes.map(d => d.name); }
function csvParse(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === "\"") { if (text[i + 1] === "\"") { cur += "\""; i++; } else inQ = false; }
      else cur += c;
    } else if (c === "\"") inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
/* Run the self-contained HMI page's inline script under a DOM stub. */
function runHmiScript(html) {
  const scripts = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  assert.equal(scripts.length, 1, "one inline script");
  let drawCalls = 0;
  const ctx = {};
  for (const fn of ["save", "restore", "beginPath", "closePath", "moveTo", "lineTo", "stroke", "fill",
    "fillRect", "strokeRect", "clearRect", "arc", "translate", "rotate", "setTransform", "fillText", "rect", "clip", "setLineDash"]) {
    ctx[fn] = function () { drawCalls++; };
  }
  ctx.measureText = function () { return { width: 10 }; };
  const listeners = {};
  const buttons = {};
  const elements = {};
  function makeEl(id) {
    const el = {
      id: id, className: "", style: {}, innerHTML: "", _ev: {},
      addEventListener(t2, fn) { (this._ev[t2] = this._ev[t2] || []).push(fn); },
      click() { (this._ev.click || []).forEach(fn => fn({})); }
    };
    elements[id] = el;
    return el;
  }
  const canvas = {
    width: 1100, height: 460, style: {},
    getContext: function () { return ctx; },
    addEventListener: function (t2, fn) { (listeners[t2] = listeners[t2] || []).push(fn); },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 1100, height: 460 }; }
  };
  const documentStub = {
    getElementById: function (id) {
      if (id === "hmi-canvas") return canvas;
      if (elements[id]) return elements[id];
      return makeEl(id);
    }
  };
  let raf = null;
  const windowStub = { requestAnimationFrame: function (fn) { raf = fn; } };
  const run = new Function("window", "document", "Date", scripts[0]);
  run(windowStub, documentStub, Date);
  assert.ok(drawCalls > 50, "initial draw produced canvas calls (" + drawCalls + ")");
  assert.equal(typeof raf, "function", "animation loop registered");
  for (let i = 0; i < 3; i++) { const f = raf; raf = null; f(); assert.equal(typeof raf, "function", "loop continues"); }
  const before = drawCalls;
  elements["btn-run"].click();
  elements["btn-sim"].click();
  for (let i = 0; i < 8; i++) { const f = raf; raf = null; f(); }
  const clickFns = listeners.click || [];
  for (let px = 100; px <= 900; px += 30) for (const fn of clickFns) fn({ clientX: px, clientY: 230 });
  for (let i = 0; i < 3; i++) { const f = raf; raf = null; f(); }
  assert.ok(drawCalls > before, "simulation frames redraw the conveyor");
  // device command buttons (pusher/rotary/pop-up) and merge grant cells, if present
  const devButtons = Object.keys(elements).filter(k => /^dev-\d+-\d+$/.test(k));
  for (const k of devButtons) { try { elements[k].click(); } catch (e) { /* ignore */ } }
  for (let i = 0; i < 3; i++) { const f = raf; raf = null; f(); }
  const stateCells = Object.keys(elements).filter(k => /^dev-state-/.test(k));
  if (stateCells.length) {
    assert.ok(stateCells.every(k => elements[k].innerHTML !== ""), "device state cells updated by the simulator");
  }
  elements["btn-stop"].click();
  elements["btn-reset"].click();
  const f = raf; raf = null; f();
  assert.equal(typeof raf, "function", "loop alive after reset");
  return { elements: elements, drawCalls: drawCalls, devButtons: devButtons };
}

/* ========================================================================== */
section("template extractor output (js/data/conveyor-templates.js)");

t("generated data file exists and loads (classic script + CommonJS)", () => {
  assert.ok(fs.existsSync(TEMPLATES_FILE), "conveyor-templates.js present");
  const text = fs.readFileSync(TEMPLATES_FILE, "utf8");
  assert.ok(text.indexOf("CONVEYOR_TEMPLATES") !== -1, "browser namespace assignment present");
  assert.ok(text.indexOf("module.exports") !== -1, "CommonJS export present");
  assert.ok(text.indexOf("do not edit by hand") !== -1, "generated-file header present");
  assert.ok(TEMPLATES && typeof TEMPLATES === "object", "require() returns the template object");
});

t("sourceInfo records SAMPLE_RLL + extraction metadata", () => {
  const si = TEMPLATES.sourceInfo;
  assert.ok(typeof si.sampleRllFile === "string" && si.sampleRllFile.length > 3, "sampleRllFile: " + si.sampleRllFile);
  assert.ok(/^\d+\.\d+/.test(String(si.sampleRllSoftwareRevision)), "controller software revision");
  assert.equal(si.sampleRllController.processorType, "1756-L83E", "controller processor type");
  assert.ok(/^\d{4}-\d{2}-\d{2}/.test(si.extractionDate), "extractionDate: " + si.extractionDate);
  assert.ok(Array.isArray(si.aoiFiles) && si.aoiFiles.length >= 4, "AOI source files recorded");
  assert.deepEqual(si.unresolvedTemplateRefs, [], "all template operand refs resolved");
});

t("7 zone-count scan variants are present and well formed", () => {
  const variants = Object.keys(TEMPLATES.routines).filter(n => /^ZPA1_[2-8]ZONE_SCAN_ZONE$/.test(n)).sort();
  assert.equal(variants.length, 7, "variants: " + variants.join(","));
  const expectedRungs = { 2: 27, 3: 40, 4: 53, 5: 66, 6: 79, 7: 92, 8: 105 };
  for (const name of variants) {
    const r = TEMPLATES.routines[name];
    assert.equal(r.type, "RLL", name + " type");
    assert.equal(r.rungs.length, expectedRungs[Number(/^ZPA1_(\d)/.exec(name)[1])], name + " rung count");
  }
});

t("support + IO mapping routines + UDTs + modules + tags are present", () => {
  for (const n of ["ZPA_MAIN", "ZPA_MAPPING", "ZPA_MAPPING_GET_OFFSET", "ZPA_TIMER_CONFIG",
    "ZPA_SCAN_ZONE_VARS", "ZPA_SCAN_ZONE_VARS_ONE_BACK", "ACK_JAMS_ZPA", "CUSTOM_CODE_ZPA_BITS",
    "INIT_ZPA_STATUS", "ENET_ZPA_INPUTS", "ENET_ZPA_OUTPUTS"]) {
    assert.ok(TEMPLATES.routines[n] && TEMPLATES.routines[n].rungs.length > 0, "routine " + n);
  }
  for (const n of ["ZPA", "ZPA_CONFIG", "CONFIG_ZPA", "ZPA_MERGE", "NETWORKS", "GFX"]) {
    assert.ok(TEMPLATES.udts[n], "UDT " + n);
    assert.ok(TEMPLATES.udts[n].indexOf("<DataType Name=\"" + n + "\"") === 0, n + " DataType element");
  }
  assert.ok(Object.keys(TEMPLATES.udts).length >= 8, "transitive UDT closure: " + Object.keys(TEMPLATES.udts).join(","));
  assert.ok(TEMPLATES.moduleTemplate.indexOf("CatalogNumber=\"1799ER-IQ10XOQ10/A\"") !== -1, "1799ER module template");
  assert.ok(TEMPLATES.localModule.indexOf("CatalogNumber=\"1756-L83E\"") !== -1, "Local module template");
  for (const n of ["CONFIG_ZPA", "ENET_INPUTS", "ENET_OUTPUTS", "ENET_DEVICE_STATUS", "GFX", "NETS", "ZPA_MERGE"]) {
    assert.ok(TEMPLATES.tagTemplates[n], "controller tag template " + n);
    assert.ok(TEMPLATES.tagTemplates[n].indexOf("<Data") === -1, n + " declaration only");
  }
  assert.ok(Object.keys(TEMPLATES.programTags).length >= 10, "program tag templates");
});

t("AOI library has the 4 LogixLibraries AOIs with dependencies", () => {
  assert.ok(TEMPLATES.aoiLibrary.length >= 4, "4 AOI entries");
  const names = TEMPLATES.aoiLibrary.map(a => a.name);
  for (const n of ["Dvc_DiscreteIn", "Dvc_DiscreteOut", "Dvc_Stacklight", "Dvc_PF525"]) {
    assert.ok(names.indexOf(n) !== -1, "AOI entry " + n);
  }
  for (const entry of TEMPLATES.aoiLibrary) {
    assert.ok(entry.xmlAoi.indexOf("<AddOnInstructionDefinition") === 0, entry.name + " xmlAoi");
    assert.ok(Array.isArray(entry.dataTypeXml) && entry.dataTypeXml.length > 0, entry.name + " dependent DataTypes");
    assert.ok(Array.isArray(entry.parameters) && entry.parameters.length > 0, entry.name + " parameters");
    assert.ok(typeof entry.notes === "string" && entry.notes.length > 20, entry.name + " notes");
  }
  const pf = TEMPLATES.aoiLibrary.find(a => a.name === "Dvc_PF525");
  assert.ok(pf.dependencyAoiNames.indexOf("Sys_Dvc") !== -1, "PF525 dependent AOI Sys_Dvc");
});

t("extractor is deterministic (fresh rebuild equals committed data file)", () => {
  const aoiDir = path.join(ROOT, "..", "repo-analysis", "LogixLibraries", "src", "Device");
  if (!fs.existsSync(SAMPLE_RLL) || !fs.existsSync(aoiDir)) {
    console.log("     (skipped: SAMPLE_RLL.L5X / AOI corpus not on this machine)"); return;
  }
  const tool = require(path.join(ROOT, "tools", "extract-conveyor-templates.js"));
  const fresh = tool.buildTemplates({});
  function stripDates(x) {
    const c = JSON.parse(JSON.stringify(x));
    delete c.meta.extractionDate;
    delete c.sourceInfo.extractionDate;
    return c;
  }
  assert.deepEqual(stripDates(fresh), stripDates(TEMPLATES), "template library is up to date (re-run tools/extract-conveyor-templates.js)");
});

/* ========================================================================== */
section("roller program mode (2 segments / 6 zones / 2 groups)");

const DESIGN = rollerDesign();
const COMPUTED = model.computeDesign(DESIGN);
const RES = gen.generateConveyorL5x(DESIGN, COMPUTED, { mode: "program" });
const { parsed: PARSED, vr: VR } = parseAndValidate(RES);
const PROGRAM = PARSED.programs[0];
const GROUPS = COMPUTED.groups;
const BLOCKS = COMPUTED.blocks;

t("program-mode result envelope + stats", () => {
  assert.ok(RES.ok, "ok");
  assert.ok(RES.l5x.length > 50000, "L5X text " + RES.l5x.length);
  assert.ok(RES.warnings.length > 0, "warnings reported");
  assert.equal(Object.keys(RES.files)[0], "T8_CONVEYOR.L5X", "suggested filename");
  const s = RES.stats;
  assert.equal(s.mode, "program");
  assert.equal(s.zones, 6, "zones");
  assert.equal(s.groups, 2, "groups");
  assert.equal(s.blocks, 2, "blocks");
  assert.ok(s.routines >= 14, "routines " + s.routines);
  assert.ok(s.udts >= 8, "UDTs " + s.udts);
  assert.equal(s.schemaErrors, 0, "schema errors");
  assert.equal(s.conveyorType, "roller", "conveyor type");
  assert.equal(s.tracking, false, "no tracking");
});

t("program-mode generation re-parses with TargetType=Program + Controller Use=Context", () => {
  assert.equal(PARSED.programs.length, 1, "one program");
  assert.equal(PROGRAM.name, "T8_CONVEYOR", "program name");
  assert.equal(PROGRAM.mainRoutineName, "Main", "main routine name");
  const x = PARSED.raw.rootNode;
  assert.equal(x.attrs.TargetType, "Program", "TargetType");
  assert.equal(x.attrs.ContainsContext, "true", "ContainsContext");
  assert.equal(x.children.find(c => c.type === "element" && c.name === "Controller").attrs.Use, "Context", "Controller Use=Context");
});

t("schema validation: 0 errors for the generated program", () => {
  assert.equal(VR.errors.length, 0, "schema errors: " + JSON.stringify(VR.errors.slice(0, 5)));
  assert.ok(VR.schemaVersion, "schema version picked: " + VR.schemaVersion);
});

t("routines: Main + one scan per roller group + INIT_CONFIG + IO mapping + support", () => {
  const names = PROGRAM.routines.map(r => r.name);
  for (const n of ["Main", "ZPA_G1_4ZONE_SCAN", "ZPA_G2_2ZONE_SCAN", "INIT_CONFIG", "IO_ENET_INPUTS",
    "IO_ENET_OUTPUTS", "IO_MAIN", "ZPA_MAPPING", "ZPA_MAPPING_GET_OFFSET", "ZPA_TIMER_CONFIG",
    "ZPA_SCAN_ZONE_VARS", "ZPA_SCAN_ZONE_VARS_ONE_BACK", "ACK_JAMS_ZPA", "CUSTOM_CODE_ZPA_BITS", "INIT_ZPA_STATUS"]) {
    assert.ok(names.indexOf(n) !== -1, "routine " + n + " (have: " + names.join(",") + ")");
  }
  assert.equal(PROGRAM.routines.filter(r => /ZONE_SCAN$/.test(r.name)).length, GROUPS.length, "one scan per group");
  for (const n of names) {
    const ir = L5X.getRoutineIR(PARSED, PROGRAM.name, n);
    assert.ok(ir && ir.kind === "lad", "routine " + n + " parses to IR");
  }
});

t("Main JSR order: INIT_CONFIG -> IO_MAIN -> ZPA_MAPPING FOR -> one JSR per group", () => {
  const main = routineByName(PROGRAM, "Main");
  const rungs = main.content.rungs;
  assert.equal(rungs[0].text, "JSR(INIT_CONFIG,0);", "1st rung: INIT_CONFIG");
  assert.equal(rungs[1].text, "JSR(IO_MAIN,0);", "2nd rung: IO_MAIN");
  assert.ok(/FOR\(ZPA_MAPPING/.test(rungs[2].text), "3rd rung: ZPA_MAPPING FOR loop");
  assert.ok(/SUB\(CONFIG_ZPA\.ENET_OFFSET,1,MAP_OFFSET_INT\)/.test(rungs[2].text), "ENET offset setup from ZPA_MAIN");
  for (let i = 0; i < GROUPS.length; i++) {
    assert.ok(/JSR\(ZPA_G\d+_\d+ZONE_SCAN,0\)/.test(rungs[3 + i].text), "group scan JSR at rung " + (3 + i));
  }
  const jsrs = rungs.filter(r => /JSR\(/.test(r.text));
  assert.equal(jsrs.length, 2 + GROUPS.length, "JSR count = INIT_CONFIG + IO_MAIN + one per group");
  assert.ok(!/TRACK_/.test(rungs.map(r => r.text).join(" ")), "no tracking JSRs when tracking is disabled");
});

t("group slot remapping: ZPA[1] -> ZPA[g], timer slots kept 1..n", () => {
  const g1 = routineText(PROGRAM, "ZPA_G1_4ZONE_SCAN");
  const g2 = routineText(PROGRAM, "ZPA_G2_2ZONE_SCAN");
  function zpaIndices(text) {
    return Array.from(new Set((text.match(/NETS\[\d+\]\.ZPA\[(\d+)\]/g) || [])
      .map(s => parseInt(/ZPA\[(\d+)\]/.exec(s)[1], 10)))).sort((a, b) => a - b);
  }
  assert.deepEqual(zpaIndices(g1), [1], "group 1 scan references only ZPA[1]");
  assert.deepEqual(zpaIndices(g2), [2], "group 2 scan references only ZPA[2]");
  assert.ok(/NETS\[1\]\.ZPA\[2\]\.JAM_TIMER\[2\]/.test(g2), "group 2 zone 2 jam timer uses slot 2");
  assert.ok(/NETS\[1\]\.ZPA\[1\]\.ZONE_HOURS_TIMER\[4\]/.test(g1), "group 1 zone 4 hours timer uses slot 4");
  assert.ok(!/ZPA\[5\]|ZPA\[6\]/.test(g2), "group 2 does not reference global zone indexes");
  const all = PARSED.programs[0].routines.map(r => (r.content.rungs || []).map(x => x.text).join(" ")).join(" ");
  const allZpa = Array.from(new Set((all.match(/NETS\[\d+\]\.ZPA\[(\d+)\]/g) || []).map(s => parseInt(/ZPA\[(\d+)\]/.exec(s)[1], 10))));
  assert.ok(Math.max.apply(null, allZpa) <= GROUPS.length, "no ZPA[k] beyond group count");
  assert.equal(allZpa.indexOf(0), -1, "no ZPA[0] references");
});

t("controller tags: ENET dimensions, CONFIG_ZPA initial data, geometry-independent", () => {
  const enetIn = controllerTag(PARSED, "ENET_INPUTS");
  const devStatus = controllerTag(PARSED, "ENET_DEVICE_STATUS");
  assert.equal(enetIn.dimension, GROUPS.length * 2, "ENET_INPUTS = groups*2");
  assert.equal(controllerTag(PARSED, "ENET_OUTPUTS").dimension, GROUPS.length * 2, "ENET_OUTPUTS = groups*2");
  assert.equal(devStatus.dimension, GROUPS.length + 1, "ENET_DEVICE_STATUS = groups+1");
  const config = controllerTag(PARSED, "CONFIG_ZPA");
  assert.equal(config.initial.text, "[0,0,[0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0],1,1,0,0,0]", "CONFIG_ZPA initial data");
  for (const n of ["GFX", "NETS", "SORTER", "CONFIG_SORTER", "TOTAL_ZONES_FULL", "ZPA_MERGE"]) {
    assert.ok(controllerTag(PARSED, n), "controller tag " + n);
  }
});

t("program tags + IO mapping routines cover every group block", () => {
  const tags = programTags(PARSED, PROGRAM.name).map(t => t.name);
  for (const n of ["MAP_OFFSET_INT", "ZPA_NDX", "STOP_JOG_ONE_SHOT", "ZPA_IO_TMP", "ZPA_CURR_NODE"]) {
    assert.ok(tags.indexOf(n) !== -1, "program tag " + n);
  }
  const inputs = routineByName(PROGRAM, "IO_ENET_INPUTS");
  assert.equal(inputs.content.rungs.length, 1 + BLOCKS.length, "IO_ENET_INPUTS rungs = setup + one per group");
  const inText = inputs.content.rungs.map(r => r.text).join(" ");
  for (const block of BLOCKS) {
    assert.ok(inText.indexOf("MOV(" + block.name + ":I.Data,ENET_INPUTS[ZPA_IO_TMP])") !== -1, "input mapping " + block.name);
    assert.ok(inText.indexOf("GSV(Module," + block.name + ",FaultCode,ENET_DEVICE_STATUS[ZPA_CURR_NODE])") !== -1, "GSV " + block.name);
  }
  for (let g = 1; g <= GROUPS.length; g++) {
    assert.ok(routineText(PROGRAM, "IO_MAIN").indexOf("ENET_INPUTS[" + g + "],NETS[1].ZPA[" + g + "].INPUTS") !== -1, "IO_MAIN group " + g);
  }
});

/* ========================================================================== */
section("curve + spiral geometry");

const CURVE_DESIGN = curveSpiralDesign();
const CURVE_COMPUTED = model.computeDesign(CURVE_DESIGN);
const RES_CURVE = gen.generateConveyorL5x(CURVE_DESIGN, CURVE_COMPUTED, { mode: "program" });
const { parsed: PARSED_CURVE, vr: VR_CURVE } = parseAndValidate(RES_CURVE);
const CURVE_PROGRAM = PARSED_CURVE.programs[0];

t("curve/spiral design computes geometry totals", () => {
  assert.ok(CURVE_COMPUTED.totals.curvedZones > 0, "curved zones: " + CURVE_COMPUTED.totals.curvedZones);
  assert.ok(Math.abs(CURVE_COMPUTED.totals.spiralRiseM - 1.5) < 0.01, "spiral rise 1.5 m, got " + CURVE_COMPUTED.totals.spiralRiseM);
  assert.equal(CURVE_COMPUTED.segments.length, 3, "3 segments");
  const spiral = CURVE_COMPUTED.segments.find(s => s.kind === "spiral");
  assert.ok(spiral && spiral.spiral && spiral.spiral.heightM === 1.5, "spiral segment record");
  const curve = CURVE_COMPUTED.segments.find(s => s.kind === "curve");
  assert.ok(curve && curve.taper && curve.taper.standardId, "curve has a standardized taper record");
});

t("curve/spiral generation: schema 0 errors + geometry in descriptions/comments", () => {
  assert.ok(RES_CURVE.ok, "ok");
  assert.equal(VR_CURVE.errors.length, 0, "schema errors: " + JSON.stringify(VR_CURVE.errors.slice(0, 5)));
  // routine descriptions mention radius / taper / spiral
  const scans = CURVE_PROGRAM.routines.filter(r => /ZONE_SCAN$/.test(r.name));
  assert.equal(scans.length, CURVE_COMPUTED.groups.length, "one scan routine per group");
  const desc = scans.map(r => r.description || "").join("\n");
  assert.ok(/CURVE radius R=1\.2/.test(desc), "curve radius in routine description");
  assert.ok(/tapered rollers TS-/.test(desc), "taper standard in routine description");
  assert.ok(/SPIRAL up direction, pitch 0\.5 m, height 1\.5 m/.test(desc), "spiral pitch/height in routine description");
  assert.ok(/slope [\d.]+ deg/.test(desc), "spiral slope in routine description");
  // Main rung comments record the geometry too
  const main = routineByName(CURVE_PROGRAM, "Main");
  const comments = main.content.rungs.map(r => r.comment || "").join("\n");
  assert.ok(/CURVE radius R=1\.2/.test(comments), "curve radius in Main comments");
  assert.ok(/SPIRAL up direction, pitch 0\.5 m, height 1\.5 m/.test(comments), "spiral geometry in Main comments");
  assert.ok(/taper standard TS-/.test(comments), "taper standard in Main comments");
  // generation still scales one routine per group (no per-zone routines)
  assert.ok(CURVE_PROGRAM.routines.filter(r => /ZONE_SCAN$/.test(r.name)).length === CURVE_COMPUTED.groups.length, "no per-zone routines");
  // long spiral: groups of <= 8 zones
  CURVE_COMPUTED.groups.forEach(g => assert.ok(g.zoneCount <= 8, "group <= 8 zones"));
});

t("curve/spiral controller mode: schema 0 errors, modules = groups + Local", () => {
  const res = gen.generateConveyorL5x(CURVE_DESIGN, CURVE_COMPUTED, { mode: "controller" });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors: " + JSON.stringify(vr.errors.slice(0, 5)));
  assert.equal(parsed.modules.length, CURVE_COMPUTED.groups.length + 1, "modules = groups + Local");
  assert.ok(res.warnings.some(w => /Spiral geometry/i.test(w)), "spiral warning summary");
  assert.ok(res.warnings.some(w => /Curved geometry/i.test(w)), "curve warning summary");
});

/* ========================================================================== */
section("belt conveyor mode");

const BELT_DESIGN = beltDesign();
const BELT_COMPUTED = model.computeDesign(BELT_DESIGN);
const RES_BELT = gen.generateConveyorL5x(BELT_DESIGN, BELT_COMPUTED, { mode: "program" });
const { parsed: PARSED_BELT, vr: VR_BELT } = parseAndValidate(RES_BELT);
const BELT_PROGRAM = PARSED_BELT.programs[0];

t("belt mode: no ZPA scan routines, one drive routine per belt segment", () => {
  assert.ok(RES_BELT.ok, "ok");
  assert.equal(VR_BELT.errors.length, 0, "schema errors: " + JSON.stringify(VR_BELT.errors.slice(0, 5)));
  assert.equal(BELT_COMPUTED.totals.conveyorType, "belt", "computed conveyor type");
  assert.equal(BELT_COMPUTED.totals.beltSegments, 2, "2 belt segments");
  const names = BELT_PROGRAM.routines.map(r => r.name);
  assert.equal(names.filter(n => /ZONE_SCAN$/.test(n)).length, 0, "no ZPA scan routines in belt mode");
  assert.ok(names.indexOf("BELT_BELT1_DRIVE") !== -1, "belts: " + names.join(","));
  assert.ok(names.indexOf("BELT_BELT2_DRIVE") !== -1, "second belt drive routine");
  assert.ok(names.indexOf("ZPA_G1_4ZONE_SCAN") === -1, "no roller group scans");
  // drive tags
  for (const s of ["BELT1", "BELT2"]) {
    assert.ok(controllerTag(PARSED_BELT, s + "_RUN_CMD"), s + "_RUN_CMD tag");
    assert.ok(controllerTag(PARSED_BELT, s + "_DRIVE_RUN"), s + "_DRIVE_RUN tag");
    assert.ok(controllerTag(PARSED_BELT, s + "_DRIVE_FAULT"), s + "_DRIVE_FAULT tag");
    assert.ok(controllerTag(PARSED_BELT, s + "_DRIVE_STATUS"), s + "_DRIVE_STATUS tag");
  }
  assert.ok(controllerTag(PARSED_BELT, "SAFETY_OK"), "SAFETY_OK interlock tag");
  // I/O mapping blocks still generated for the zone sensor groups
  assert.ok(controllerTag(PARSED_BELT, "ENET_INPUTS"), "group I/O mapping tag present");
  const names2 = BELT_PROGRAM.routines.map(r => r.name);
  assert.ok(names2.indexOf("IO_ENET_INPUTS") !== -1 && names2.indexOf("IO_ENET_OUTPUTS") !== -1, "group I/O mapping routines present");
  // latch / interlock logic
  const drive = routineText(BELT_PROGRAM, "BELT_BELT1_DRIVE");
  assert.ok(/XIC\(BELT1_RUN_CMD\)/.test(drive), "RUN_CMD in latch");
  assert.ok(/OTL\(BELT1_DRIVE_RUN\)/.test(drive), "DRIVE_RUN latched");
  assert.ok(/XIC\(SAFETY_OK\)/.test(drive), "SAFETY_OK interlock");
  assert.ok(/OTU\(BELT1_DRIVE_RUN\)/.test(drive), "DRIVE_RUN unlatched on fault/safety");
  // main JSRs the belt drives
  const mainText = rungTexts(BELT_PROGRAM, "Main").join(" ");
  assert.ok(/JSR\(BELT_BELT1_DRIVE,0\)/.test(mainText), "Main JSRs belt 1 drive");
  assert.ok(/JSR\(BELT_BELT2_DRIVE,0\)/.test(mainText), "Main JSRs belt 2 drive");
  assert.ok(!/ZPA_MAPPING/.test(mainText), "no ZPA_MAPPING loop in belt mode");
  assert.ok(RES_BELT.warnings.some(w => /PowerFlex 525 AOI not embedded/i.test(w)), "warning when PF525 not requested");
});

t("belt mode with PowerFlex 525 AOI: embedded and called, schema 0 errors", () => {
  const res = gen.generateConveyorL5x(BELT_DESIGN, BELT_COMPUTED, { mode: "program", aois: ["Dvc_PF525"] });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors: " + JSON.stringify(vr.errors.slice(0, 5)));
  const aois = parsed.addOnInstructions.map(a => a.name);
  assert.ok(aois.indexOf("Dvc_PF525") !== -1, "Dvc_PF525 AOI embedded: " + aois.join(","));
  assert.ok(aois.indexOf("Sys_Dvc") !== -1, "dependent AOI Sys_Dvc embedded");
  const program = parsed.programs[0];
  const allText = program.routines.map(r => (r.content.rungs || []).map(x => x.text).join(" ")).join(" ");
  assert.ok(/Dvc_PF525\(BELT1_PF525_DRIVE,Local,\?,\?,BELT1_READ_MSG,BELT1_WRITE_MSG,BELT1_MSG_DATA,BELT1_DEVICE_CLASS\)/.test(allText),
    "PowerFlex 525 AOI call generated for belt 1");
  assert.ok(res.stats.pf525 === true, "stats.pf525");
  assert.ok(res.warnings.some(w => /Dvc_PF525\) embedded and called/i.test(w)), "PF525 embedded warning");
});

t("belt controller mode: modules = groups + Local, task + IO program, schema 0 errors", () => {
  const res = gen.generateConveyorL5x(BELT_DESIGN, BELT_COMPUTED, { mode: "controller", aois: ["Dvc_PF525"] });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors: " + JSON.stringify(vr.errors.slice(0, 5)));
  assert.equal(parsed.modules.length, BELT_COMPUTED.groups.length + 1, "modules = groups + Local");
  assert.equal(parsed.tasks.length, 1, "MainTask");
  const io = parsed.programs.find(p => p.name === "IO_MASTER_MAPPER");
  assert.ok(io && io.routines.some(r => r.name === "IO_ENET_INPUTS"), "IO_MASTER_MAPPER program present");
});

/* ========================================================================== */
section("scan zones + tray tracking");

const TRACK_DESIGN = trackingDesign();
const TRACK_COMPUTED = model.computeDesign(TRACK_DESIGN);
const RES_TRACK = gen.generateConveyorL5x(TRACK_DESIGN, TRACK_COMPUTED, { mode: "program" });
const { parsed: PARSED_TRACK, vr: VR_TRACK } = parseAndValidate(RES_TRACK);
const TRACK_PROGRAM = PARSED_TRACK.programs[0];

t("tracking: TRAY_TRACK UDT + TRACK_TBL/TRACK_COUNT/scanner tags generated", () => {
  assert.ok(RES_TRACK.ok, "ok");
  assert.equal(VR_TRACK.errors.length, 0, "schema errors: " + JSON.stringify(VR_TRACK.errors.slice(0, 5)));
  const udts = dataTypeNames(PARSED_TRACK);
  assert.ok(udts.indexOf("TRAY_TRACK") !== -1, "TRAY_TRACK UDT");
  assert.ok(udts.indexOf("STRING_20") !== -1, "custom STRING_20 type for barcodeLen=20");
  const tbl = controllerTag(PARSED_TRACK, "TRACK_TBL");
  assert.ok(tbl, "TRACK_TBL tag");
  assert.equal(tbl.dataType, "TRAY_TRACK", "TRACK_TBL data type");
  assert.equal(tbl.dimension, 8, "TRACK_TBL = maxTrays");
  assert.equal(controllerTag(PARSED_TRACK, "TRACK_COUNT").dataType, "DINT", "TRACK_COUNT DINT");
  assert.ok(controllerTag(PARSED_TRACK, "TRACK_RESET"), "TRACK_RESET tag");
  for (const sz of TRACK_COMPUTED.scannedZones) {
    const barcode = controllerTag(PARSED_TRACK, sz.name + "_BARCODE");
    const good = controllerTag(PARSED_TRACK, sz.name + "_GOOD_READ");
    assert.ok(barcode, sz.name + "_BARCODE tag");
    assert.equal(barcode.dataType, "STRING_20", sz.name + " barcode type");
    assert.ok(good && good.dataType === "BOOL", sz.name + "_GOOD_READ tag");
  }
  // spare input-bit allocation warning
  assert.ok(RES_TRACK.warnings.some(w => /spare input/i.test(w)), "scanner spare input-bit mapping warning");
  assert.ok(RES_TRACK.stats.tracking === true, "stats.tracking");
  assert.equal(RES_TRACK.stats.scanZones, 2, "stats.scanZones");
});

t("tracking: TRACK_INIT/SCAN/MOVE/CLEAR routines present and parse to IR", () => {
  const names = TRACK_PROGRAM.routines.map(r => r.name);
  for (const n of ["TRACK_INIT", "TRACK_SCAN", "TRACK_MOVE", "TRACK_CLEAR"]) {
    assert.ok(names.indexOf(n) !== -1, "tracking routine " + n);
    const ir = L5X.getRoutineIR(PARSED_TRACK, TRACK_PROGRAM.name, n);
    assert.ok(ir && ir.kind === "lad", n + " parses to ladder IR (ST authored, converted)");
  }
  // ladder rungs generated from ST conversion
  assert.ok(routineByName(TRACK_PROGRAM, "TRACK_SCAN").content.rungs.length >= 3, "TRACK_SCAN rungs");
  const scan = routineText(TRACK_PROGRAM, "TRACK_SCAN");
  assert.ok(/COP\(SCAN1_BARCODE,TRACK_TBL\[TRACK_NDX\]\.Barcode,1\)/.test(scan), "barcode COP into TRAY_TRACK");
  assert.ok(/TRACK_TBL\[TRACK_NDX\]\.Valid :=|MOV\(1,TRACK_TBL\[TRACK_NDX\]\.Valid\)/.test(scan) || /MOV\(1,TRACK_TBL\[TRACK_NDX\]\.Valid\)/.test(scan), "valid bit write");
  const move = routineText(TRACK_PROGRAM, "TRACK_MOVE");
  assert.ok(/TRACK_SENS_PREV\[0\]/.test(move), "sensor falling-edge memory");
  assert.ok(/NETS\[1\]\.ZPA\[1\]\.INPUTS\.0/.test(move), "roller sensor read from ZPA group input bit");
  assert.ok(/TRACK_MOVE_ZONE/.test(move), "tray zone advance");
});

t("tracking: Main JSR order includes TRACK_INIT before mapping and MOVE/SCAN/CLEAR after scans", () => {
  const main = routineByName(TRACK_PROGRAM, "Main");
  const texts = main.content.rungs.map(r => r.text);
  const iInit = texts.findIndex(x => /JSR\(INIT_CONFIG,0\)/.test(x));
  const iIo = texts.findIndex(x => /JSR\(IO_MAIN,0\)/.test(x));
  const iTrackInit = texts.findIndex(x => /JSR\(TRACK_INIT,0\)/.test(x));
  const iMap = texts.findIndex(x => /FOR\(ZPA_MAPPING/.test(x));
  const iScan = texts.findIndex(x => /JSR\(ZPA_G\d+_\d+ZONE_SCAN,0\)/.test(x));
  const iMove = texts.findIndex(x => /JSR\(TRACK_MOVE,0\)/.test(x));
  const iTrackScan = texts.findIndex(x => /JSR\(TRACK_SCAN,0\)/.test(x));
  const iClear = texts.findIndex(x => /JSR\(TRACK_CLEAR,0\)/.test(x));
  assert.ok(iInit === 0, "INIT_CONFIG first");
  assert.ok(iIo === 1, "IO_MAIN second");
  assert.ok(iTrackInit === 2, "TRACK_INIT third (first scan)");
  assert.ok(iMap > iTrackInit, "ZPA_MAPPING after TRACK_INIT");
  assert.ok(iScan > iMap, "group scans after mapping");
  assert.ok(iMove > iScan && iTrackScan > iMove && iClear > iTrackScan, "TRACK_MOVE -> TRACK_SCAN -> TRACK_CLEAR after group scans");
});

t("tracking: belt design uses ENET_INPUTS sensor bits and stays schema clean", () => {
  const d = beltTrackingDesign();
  const c = model.computeDesign(d);
  const res = gen.generateConveyorL5x(d, c, { mode: "program" });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors: " + JSON.stringify(vr.errors.slice(0, 5)));
  const program = parsed.programs[0];
  const move = routineText(program, "TRACK_MOVE");
  assert.ok(/ENET_INPUTS\[1\]\./.test(move), "belt sensor read from ENET_INPUTS group word");
  assert.ok(!/ZPA_MAPPING/.test(rungTexts(program, "Main").join(" ")), "no ZPA mapping in belt mode");
  assert.ok(controllerTag(parsed, "TRACK_TBL"), "tracking table in belt mode");
});

/* ========================================================================== */
section("controller mode (roller)");

const RES_CONTROLLER = gen.generateConveyorL5x(DESIGN, COMPUTED, { mode: "controller" });
const { parsed: PARSED_CONTROLLER, vr: VR_CONTROLLER } = parseAndValidate(RES_CONTROLLER);

t("controller mode: modules = groups + Local with design IPs, tasks, schema 0 errors", () => {
  assert.ok(RES_CONTROLLER.ok, "ok");
  assert.equal(RES_CONTROLLER.stats.modules, GROUPS.length + 1, "modules = groups + Local");
  assert.equal(PARSED_CONTROLLER.modules.length, GROUPS.length + 1, "parsed modules");
  assert.ok(PARSED_CONTROLLER.modules.find(m => m.name === "Local"), "Local module");
  const zpa = PARSED_CONTROLLER.modules.filter(m => /^ZPA\d\d$/.test(m.name));
  assert.deepEqual(zpa.map(m => m.name), BLOCKS.map(b => b.name), "module names = group blocks");
  for (const m of zpa) {
    assert.equal(m.catalogNumber, "1799ER-IQ10XOQ10/A", m.name + " catalog");
    const expected = BLOCKS.find(b => b.name === m.name).ip;
    assert.equal(m.ports.filter(p => p.address)[0].address, expected, m.name + " IP");
  }
  const task = PARSED_CONTROLLER.tasks[0];
  assert.equal(task.name, "MainTask", "task name");
  assert.equal(task.type, "CONTINUOUS", "task type");
  assert.ok(task.programs.indexOf("T8_CONVEYOR") !== -1 && task.programs.indexOf("IO_MASTER_MAPPER") !== -1, "both programs scheduled");
  assert.equal(PARSED_CONTROLLER.programs.length, 2, "two programs");
  assert.equal(VR_CONTROLLER.errors.length, 0, "schema errors: " + JSON.stringify(VR_CONTROLLER.errors.slice(0, 5)));
  for (const p of PARSED_CONTROLLER.programs) for (const r of p.routines) {
    assert.ok(L5X.getRoutineIR(PARSED_CONTROLLER, p.name, r.name), "IR for " + p.name + "/" + r.name);
  }
});

/* ========================================================================== */
section("merge junctions + transfer devices (model v3)");

const DEV_DESIGN = deviceMergeDesign();
const DEV_COMPUTED = model.computeDesign(DEV_DESIGN);
const RES_DEV = gen.generateConveyorL5x(DEV_DESIGN, DEV_COMPUTED, { mode: "program" });
const { parsed: PARSED_DEV, vr: VR_DEV } = parseAndValidate(RES_DEV);
const DEV_PROGRAM = PARSED_DEV.programs[0];
const DEV_GROUPS = DEV_COMPUTED.groups;
const DEV_TRANSFERS = DEV_COMPUTED.transfers;
const DEV_MERGES = DEV_COMPUTED.merges;

t("device/merge design allocates device blocks, IPs and merge mapping", () => {
  assert.equal(DEV_COMPUTED.totals.groups, 5, "5 ZPA groups");
  assert.equal(DEV_COMPUTED.totals.deviceBlocks, 3, "3 device blocks");
  assert.equal(DEV_COMPUTED.totals.blocks, 8, "8 blocks total");
  assert.equal(DEV_COMPUTED.totals.merges, 1, "1 merge");
  assert.equal(DEV_COMPUTED.totals.transfers, 3, "3 transfers");
  assert.deepEqual(DEV_TRANSFERS.map(t => t.ioBlock), ["XFER01", "XFER02", "XFER03"], "device block names sequential");
  const lastZoneIp = DEV_GROUPS[DEV_GROUPS.length - 1].ip;
  assert.equal(DEV_TRANSFERS[0].ip, "192.168.1.105", "device IPs start after the ZPA blocks");
  assert.equal(DEV_TRANSFERS[0].ioBlock, "XFER01", "pusher block");
  assert.equal(DEV_TRANSFERS[1].type, "rotary_table", "rotary table");
  assert.equal(DEV_TRANSFERS[2].type, "popup_transfer", "pop-up transfer");
  const mg = DEV_MERGES[0];
  assert.equal(mg.name, "MERGE1", "merge name");
  assert.equal(mg.priority, "alternate", "merge priority");
  assert.equal(mg.mergeZoneIndex1Based, 8, "merge zone");
  assert.equal(mg.spurZoneIndex1Based, 13, "spur last zone");
  assert.equal(mg.upstreamMainZone, 7, "main upstream zone");
  assert.equal(DEV_COMPUTED.totals.scanZones, 1, "1 scan zone");
});

t("device/merge program mode: schema 0 errors + all routines parse to IR", () => {
  assert.ok(RES_DEV.ok, "ok");
  assert.equal(VR_DEV.errors.length, 0, "schema errors: " + JSON.stringify(VR_DEV.errors.slice(0, 8)));
  assert.equal(RES_DEV.stats.deviceBlocks, 3, "stats.deviceBlocks");
  assert.equal(RES_DEV.stats.merges, 1, "stats.merges");
  assert.equal(RES_DEV.stats.pushers, 1, "stats.pushers");
  assert.equal(RES_DEV.stats.rotaryTables, 1, "stats.rotaryTables");
  assert.equal(RES_DEV.stats.popupTransfers, 1, "stats.popupTransfers");
  assert.equal(RES_DEV.stats.enetWords, 8, "ENET words = groups + devices");
  const names = DEV_PROGRAM.routines.map(r => r.name);
  for (const n of ["MERGE_MERGE1", "PUSHER_PUSHER1", "ROTARY_ROTARY1", "POPUP_POPUP1"]) {
    assert.ok(names.indexOf(n) !== -1, "routine " + n + " (have " + names.join(",") + ")");
    const ir = L5X.getRoutineIR(PARSED_DEV, DEV_PROGRAM.name, n);
    assert.ok(ir && ir.kind === "lad", n + " parses to ladder IR (ST authored, converted)");
  }
  assert.equal(DEV_PROGRAM.routines.filter(r => /^TRACK_/.test(r.name)).length, 4, "tracking routines still present");
});

t("device I/O mapping: XFERnn DINT tags + bit alias tags + ENET words + GSV", () => {
  for (const block of ["XFER01", "XFER02", "XFER03"]) {
    assert.equal(controllerTag(PARSED_DEV, block + "_INPUTS").dataType, "DINT", block + "_INPUTS DINT");
    assert.equal(controllerTag(PARSED_DEV, block + "_OUTPUTS").dataType, "DINT", block + "_OUTPUTS DINT");
    assert.equal(controllerTag(PARSED_DEV, block + "_STATUS").dataType, "DINT", block + "_STATUS DINT");
    assert.ok(controllerTag(PARSED_DEV, block + "_FAULT"), block + "_FAULT BOOL");
  }
  // convenience BOOL alias tags for each named input/output bit
  const aliases = {};
  for (const tag of PARSED_DEV.tags.controller) if (tag.tagType === "Alias") aliases[tag.name] = tag;
  assert.equal(aliases.PUSHER1_EXTENDED_SW.aliasFor, "XFER01_INPUTS.1", "PUSHER1_EXTENDED_SW alias");
  assert.equal(aliases.PUSHER1_RETRACTED_SW.aliasFor, "XFER01_INPUTS.0", "PUSHER1_RETRACTED_SW alias");
  assert.equal(aliases.PUSHER1_EXTEND_SOL.aliasFor, "XFER01_OUTPUTS.0", "PUSHER1_EXTEND_SOL alias");
  assert.equal(aliases.ROTARY1_HOME_SW.aliasFor, "XFER02_INPUTS.0", "ROTARY1_HOME_SW alias");
  assert.equal(aliases.ROTARY1_ROTATE_CW.aliasFor, "XFER02_OUTPUTS.0", "ROTARY1_ROTATE_CW alias");
  assert.equal(aliases.POPUP1_POPUP_UP_SW.aliasFor, "XFER03_INPUTS.0", "POPUP1_POPUP_UP_SW alias");
  assert.equal(aliases.POPUP1_BELT_LEFT.aliasFor, "XFER03_OUTPUTS.2", "POPUP1_BELT_LEFT alias");
  // command / status tags
  for (const n of ["XFER_CMD_PUSHER1", "XFER_CMD_ROTARY1", "XFER_CMD_POPUP1_LEFT", "XFER_CMD_POPUP1_RIGHT",
    "XFER_POS_ROTARY1", "XFER_DEST_ROTARY1"]) {
    assert.ok(controllerTag(PARSED_DEV, n), "controller tag " + n);
  }
  // ENET dimensions / device mapping rungs
  assert.equal(controllerTag(PARSED_DEV, "ENET_INPUTS").dimension, 16, "ENET_INPUTS = enetWords*2");
  assert.equal(controllerTag(PARSED_DEV, "ENET_OUTPUTS").dimension, 16, "ENET_OUTPUTS = enetWords*2");
  assert.equal(controllerTag(PARSED_DEV, "ENET_DEVICE_STATUS").dimension, 9, "ENET_DEVICE_STATUS = enetWords+1");
  const inputs = routineByName(DEV_PROGRAM, "IO_ENET_INPUTS");
  assert.equal(inputs.content.rungs.length, 1 + DEV_GROUPS.length + DEV_TRANSFERS.length, "IO_ENET_INPUTS rungs");
  const inText = inputs.content.rungs.map(r => r.text).join(" ");
  for (const tf of DEV_TRANSFERS) {
    assert.ok(inText.indexOf("MOV(" + tf.ioBlock + ":I.Data," + tf.ioBlock + "_INPUTS)") !== -1, "device input " + tf.ioBlock);
    assert.ok(inText.indexOf("MOV(" + tf.ioBlock + ":I.Data,ENET_INPUTS[ZPA_IO_TMP])") !== -1, "device ENET input " + tf.ioBlock);
    assert.ok(inText.indexOf("GSV(Module," + tf.ioBlock + ",FaultCode,ENET_DEVICE_STATUS[ZPA_CURR_NODE])") !== -1, "device GSV " + tf.ioBlock);
  }
  const outText = routineByName(DEV_PROGRAM, "IO_ENET_OUTPUTS").content.rungs.map(r => r.text).join(" ");
  for (const tf of DEV_TRANSFERS) {
    assert.ok(outText.indexOf("MOV(" + tf.ioBlock + "_OUTPUTS," + tf.ioBlock + ":O.Data)") !== -1, "device output " + tf.ioBlock);
  }
});

t("merge routine: arbitration grants, priority and 8 s timeout swap", () => {
  const merge = routineByName(DEV_PROGRAM, "MERGE_MERGE1");
  assert.ok(merge, "MERGE_MERGE1 routine");
  const desc = merge.description || "";
  assert.ok(/priority=alternate/.test(desc), "priority in description");
  assert.ok(/merge zone 8/.test(desc), "merge zone in description");
  assert.ok(/main upstream zone 7/.test(desc), "main upstream zone in description");
  assert.ok(/spur last zone 13/.test(desc), "spur zone in description");
  // grants write INPUTS.8 for the two upstream zones (main zone 7 -> group 3, spur zone 13 -> group 5)
  const text = merge.content.rungs.map(r => r.text).join(" ");
  assert.ok(text.indexOf("MOV(1,NETS[1].ZPA[3].INPUTS.8)") !== -1, "main grant sets zone 7 (group 3) INPUTS.8 = 1");
  assert.ok(text.indexOf("MOV(0,NETS[1].ZPA[5].INPUTS.8)") !== -1, "spur hold clears zone 13 (group 5) INPUTS.8 = 0");
  assert.ok(text.indexOf("MOV(1,NETS[1].ZPA[5].INPUTS.8)") !== -1, "spur grant sets zone 13 INPUTS.8 = 1");
  assert.ok(text.indexOf("MOV(0,NETS[1].ZPA[3].INPUTS.8)") !== -1, "main hold clears zone 7 INPUTS.8 = 0");
  assert.ok(/TON\(MERGE_MERGE1_MAIN_TMR,\?,\?\)/.test(text), "main blocked-release timer");
  assert.ok(/TON\(MERGE_MERGE1_SPUR_TMR,\?,\?\)/.test(text), "spur blocked-release timer");
  assert.ok(/XIC\(MERGE_MERGE1_MAIN_TMR\.DN\)/.test(text), "main timeout swap rung");
  assert.ok(/XIC\(MERGE_MERGE1_SPUR_TMR\.DN\)/.test(text), "spur timeout swap rung");
  assert.ok(controllerTag(PARSED_DEV, "MERGE_MERGE1_MAIN_GRANT"), "main grant status tag");
  assert.ok(controllerTag(PARSED_DEV, "MERGE_MERGE1_SPUR_GRANT"), "spur grant status tag");
});

t("INIT_CONFIG: INPUTS.8 release permission + merge timeout presets", () => {
  const init = routineByName(DEV_PROGRAM, "INIT_CONFIG");
  const text = init.content.rungs.map(r => r.text).join(" ");
  for (let g = 1; g <= DEV_GROUPS.length; g++) {
    assert.ok(text.indexOf("MOV(1,NETS[1].ZPA[" + g + "].INPUTS.8)") !== -1, "group " + g + " INPUTS.8 = 1");
  }
  assert.ok(text.indexOf("MOV(8000,MERGE_MERGE1_MAIN_TMR.PRE)") !== -1, "main merge timer preset 8000 ms");
  assert.ok(text.indexOf("MOV(8000,MERGE_MERGE1_SPUR_TMR.PRE)") !== -1, "spur merge timer preset 8000 ms");
});

t("transfer routines: pusher / rotary / pop-up ST-authored logic", () => {
  const pusher = routineByName(DEV_PROGRAM, "PUSHER_PUSHER1");
  const pt = pusher.content.rungs.map(r => r.text).join(" ");
  assert.ok(/PUSHER1_EXTEND_SOL/.test(pt) && /PUSHER1_RETRACT_SOL/.test(pt), "pusher solenoids");
  assert.ok(/PUSHER1_EXTENDED_SW/.test(pt) && /PUSHER1_RETRACTED_SW/.test(pt), "pusher limit switches");
  assert.ok(/PUSHER1_TRAY_PRESENT/.test(pt) && /PUSHER1_DOWNSTREAM_CLEAR/.test(pt), "pusher interlocks");
  assert.ok(/TON\(XFER01_EXTEND_TMR,800,XFER01_EXTEND_TMR\.ACC\)/.test(pt), "pusher extend timer");
  assert.ok(/XFER01_FAULT/.test(pt), "pusher jam fault");
  assert.ok(/one-way/i.test(pusher.description || ""), "one-way divert documented");
  const rotary = routineByName(DEV_PROGRAM, "ROTARY_ROTARY1");
  const rt = rotary.content.rungs.map(r => r.text).join(" ");
  assert.ok(/ROTARY1_ROTATE_CW/.test(rt) && /ROTARY1_ROTATE_CCW/.test(rt), "rotary CW/CCW outputs");
  assert.ok(/ROTARY1_TABLE_BRAKE/.test(rt) && /ROTARY1_TABLE_ENABLE/.test(rt), "rotary brake/enable");
  assert.ok(/XFER_POS_ROTARY1/.test(rt) && /XFER_DEST_ROTARY1/.test(rt), "rotary position/destination tags");
  assert.ok(/XFER02_ROTATE_TMR/.test(rt), "rotary timeout timer");
  assert.ok(/bidirectional/i.test(rotary.description || ""), "bidirectional router documented");
  const popup = routineByName(DEV_PROGRAM, "POPUP_POPUP1");
  const ut = popup.content.rungs.map(r => r.text).join(" ");
  assert.ok(/POPUP1_RAISE/.test(ut) && /POPUP1_LOWER/.test(ut), "popup raise/lower");
  assert.ok(/POPUP1_BELT_LEFT/.test(ut) && /POPUP1_BELT_RIGHT/.test(ut), "popup belt directions");
  assert.ok(/POPUP1_LEFT_CLEAR/.test(ut) && /POPUP1_RIGHT_CLEAR/.test(ut), "popup side interlocks");
  assert.ok(/XFER03_RAISE_TMR/.test(ut) && /XFER03_XFER_TMR/.test(ut) && /XFER03_LOWER_TMR/.test(ut), "popup timers");
  assert.ok(/bidirectional/i.test(popup.description || ""), "bidirectional cross transfer documented");
});

t("Main JSR order: ... group scans, merge routines, transfer routines, tracking", () => {
  const main = routineByName(DEV_PROGRAM, "Main");
  const texts = main.content.rungs.map(r => r.text);
  const idx = (re) => texts.findIndex(x => re.test(x));
  const iInit = idx(/JSR\(INIT_CONFIG,0\)/);
  const iIo = idx(/JSR\(IO_MAIN,0\)/);
  const iTrackInit = idx(/JSR\(TRACK_INIT,0\)/);
  const iMap = idx(/FOR\(ZPA_MAPPING/);
  const iGroup = idx(/JSR\(ZPA_G\d+_\d+ZONE_SCAN,0\)/);
  const iMerge = idx(/JSR\(MERGE_MERGE1,0\)/);
  const iDevice = idx(/JSR\(PUSHER_PUSHER1,0\)/);
  const iRotary = idx(/JSR\(ROTARY_ROTARY1,0\)/);
  const iPopup = idx(/JSR\(POPUP_POPUP1,0\)/);
  const iMove = idx(/JSR\(TRACK_MOVE,0\)/);
  const iScan = idx(/JSR\(TRACK_SCAN,0\)/);
  const iClear = idx(/JSR\(TRACK_CLEAR,0\)/);
  assert.ok(iInit === 0, "INIT_CONFIG first");
  assert.ok(iIo === 1, "IO_MAIN second");
  assert.ok(iTrackInit === 2, "TRACK_INIT third");
  assert.ok(iMap > iTrackInit, "ZPA_MAPPING after TRACK_INIT");
  assert.ok(iGroup > iMap, "group scans after mapping");
  assert.ok(iMerge > iGroup, "merge routines after group scans");
  assert.ok(iDevice > iMerge && iRotary > iDevice && iPopup > iRotary, "transfer routines after merge routines");
  assert.ok(iMove > iPopup && iScan > iMove && iClear > iScan, "tracking MOVE/SCAN/CLEAR after transfer routines");
  const mergeComment = main.content.rungs[iMerge].comment || "";
  assert.ok(/priority alternate/.test(mergeComment), "merge comment records priority");
});

t("device/merge controller mode: device modules, schema 0 errors", () => {
  const res = gen.generateConveyorL5x(DEV_DESIGN, DEV_COMPUTED, { mode: "controller" });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors: " + JSON.stringify(vr.errors.slice(0, 8)));
  assert.equal(parsed.modules.length, DEV_COMPUTED.blocks.length + 1, "modules = blocks + Local");
  const names = parsed.modules.map(m => m.name);
  for (const block of ["ZPA01", "ZPA05", "XFER01", "XFER02", "XFER03", "Local"]) {
    assert.ok(names.indexOf(block) !== -1, "module " + block + " (have " + names.join(",") + ")");
  }
  for (const tf of DEV_TRANSFERS) {
    const mod = parsed.modules.find(m => m.name === tf.ioBlock);
    assert.equal(mod.catalogNumber, "1799ER-IQ10XOQ10/A", tf.ioBlock + " catalog");
    assert.equal(mod.ports.filter(p => p.address)[0].address, tf.ip, tf.ioBlock + " IP " + tf.ip);
  }
  assert.equal(res.stats.modules, 9, "9 modules (Local + 5 groups + 3 devices)");
  assert.ok(parsed.tasks[0].programs.indexOf("FULL_LINE") !== -1, "design program scheduled");
});

t("device/merge HMI: Y junctions, device symbols, device table + command buttons", () => {
  const html = hmi.generateHmiHtml(DEV_DESIGN, DEV_COMPUTED, {});
  assert.ok(html.indexOf("Merge junctions") !== -1, "merge junction panel");
  assert.ok(html.indexOf("MERGE1") !== -1, "merge name in HMI");
  assert.ok(/main grant|Merge grant \(main\)/.test(html), "merge grant legend");
  assert.ok(html.indexOf("Transfer devices") !== -1, "device table panel");
  assert.ok(html.indexOf("PUSHER1") !== -1 && html.indexOf("ROTARY1") !== -1 && html.indexOf("POPUP1") !== -1, "device names");
  assert.ok(html.indexOf("dev-0-0") !== -1 && html.indexOf("dev-1-0") !== -1 && html.indexOf("dev-2-0") !== -1, "device command buttons");
  assert.ok(html.indexOf("dev-2-1") !== -1, "popup left/right command buttons");
  assert.ok(html.indexOf("merge-grant-MERGE1") !== -1, "merge grant status cell");
  assert.ok(html.indexOf("drawMergeJunctions") !== -1 && html.indexOf("drawTransfers") !== -1, "merge/device drawing code");
  const run = runHmiScript(html);
  assert.ok(run.devButtons.length >= 4, "device command buttons wired in the simulator");
  assert.ok(run.elements["merge-grant-MERGE1"], "merge grant cell exists");
});

t("device/merge CSV + graphics spec include device tags, merge priorities", () => {
  const csv = hmi.generateTagListCsv(DEV_DESIGN, DEV_COMPUTED);
  assert.ok(csv.indexOf("XFER01_INPUTS") !== -1, "XFER01_INPUTS row");
  assert.ok(csv.indexOf("XFER01_OUTPUTS") !== -1, "XFER01_OUTPUTS row");
  assert.ok(csv.indexOf("PUSHER1_EXTENDED_SW") !== -1, "device alias row");
  assert.ok(csv.indexOf("XFER_CMD_ROTARY1") !== -1, "rotary command row");
  assert.ok(csv.indexOf("XFER_POS_ROTARY1") !== -1, "rotary position row");
  assert.ok(csv.indexOf("MERGE_MERGE1_MAIN_GRANT") !== -1, "merge grant row");
  assert.ok(/priority alternate/.test(csv), "merge priority in CSV description");
  const spec = hmi.generateGraphicsSpec(DEV_DESIGN, DEV_COMPUTED);
  assert.ok(spec.indexOf("## Merge junctions") !== -1, "merge junction spec section");
  assert.ok(/^\| MERGE1 \| alternate \|/m.test(spec), "merge priority row in spec");
  assert.ok(spec.indexOf("## Transfer devices") !== -1, "transfer device spec section");
  assert.ok(/^\| PUSHER1 \| Pusher \/ divert \|/m.test(spec), "pusher device row");
  assert.ok(/^\| ROTARY1 \| Rotary table \|/m.test(spec), "rotary device row");
  assert.ok(/^\| POPUP1 \| Cross-belt pop-up transfer \|/m.test(spec), "popup device row");
  assert.ok(spec.indexOf("Device symbol legend") !== -1, "device symbol legend");
  assert.ok(spec.indexOf("bidirectional router") !== -1, "rotary bidirectional note");
});

/* ========================================================================== */
section("HMI generator (base roller design)");

const HMI_HTML = hmi.generateHmiHtml(DESIGN, COMPUTED, {});
const TAG_CSV = hmi.generateTagListCsv(DESIGN, COMPUTED);
const GRAPHICS_SPEC = hmi.generateGraphicsSpec(DESIGN, COMPUTED);

t("HMI HTML: self-contained page with canvas + conveyor graphics", () => {
  assert.ok(HMI_HTML.indexOf("<canvas") !== -1, "canvas element");
  assert.ok(HMI_HTML.indexOf("id=\"hmi-canvas\"") !== -1, "canvas id");
  assert.ok(HMI_HTML.indexOf("T8_CONVEYOR") !== -1, "design name in header");
  assert.ok(HMI_HTML.indexOf("CONVEYOR_PLC") !== -1, "controller name in header");
  assert.ok(/<b>6<\/b> zones/.test(HMI_HTML), "zone count in header");
  assert.ok(/<b>2<\/b> ZPA groups/.test(HMI_HTML), "group count in header");
  assert.ok(HMI_HTML.indexOf("SEG1_Z1") !== -1 && HMI_HTML.indexOf("SEG2_Z2") !== -1, "zone labels");
  assert.ok(HMI_HTML.indexOf("NETS[1].ZPA[1]") !== -1 && HMI_HTML.indexOf("NETS[1].ZPA[2]") !== -1, "group tag paths");
  assert.ok(HMI_HTML.indexOf("ZPA01:I.Data.0") !== -1 && HMI_HTML.indexOf("ZPA01:O.Data.0") !== -1, "zone I/O addresses");
  for (const label of ["Stopped", "Running", "Full", "Jam"]) assert.ok(HMI_HTML.indexOf(label) !== -1, "legend " + label);
  for (const btn of ["Run", "Stop", "Reset", "Sim"]) assert.ok(HMI_HTML.indexOf(">" + btn + "<") !== -1, "button " + btn);
  assert.equal((HMI_HTML.match(/https?:\/\//g) || []).length, 0, "no external http refs");
  assert.equal((HMI_HTML.match(/<link\b/g) || []).length, 0, "no external stylesheet link");
  assert.ok(HMI_HTML.length > 8000, "non-trivial page (" + HMI_HTML.length + " bytes)");
});

t("HMI simulator JS executes under a DOM stub", () => {
  runHmiScript(HMI_HTML);
});

t("HMI belt + spiral + scanner rendering", () => {
  const c = model.computeDesign(CURVE_DESIGN);
  const html1 = hmi.generateHmiHtml(CURVE_DESIGN, c, {});
  assert.ok(/SPIRAL/.test(html1), "spiral badge code/content");
  assert.ok(html1.indexOf("SPIRAL1") !== -1, "spiral segment name in page");
  const belt = beltTrackingDesign();
  const bc = model.computeDesign(belt);
  const html2 = hmi.generateHmiHtml(belt, bc, {});
  assert.ok(html2.indexOf("drawBelt") !== -1 || html2.indexOf("belt band") !== -1 || /belt/.test(html2), "belt band drawing code");
  assert.ok(html2.indexOf("Belt drives") !== -1, "belt drive table panel");
  assert.ok(html2.indexOf("SCANA") !== -1, "scanner marker label");
  assert.ok(html2.indexOf("Tray tracking") !== -1, "tray tracking panel");
  runHmiScript(html2);
});

t("tag list CSV: zone rows + tracking/scanner/drive tags", () => {
  const rows = csvParse(TAG_CSV).filter(r => r.length > 1);
  assert.deepEqual(rows[0], ["Tag", "DataType", "Description", "Address", "Direction", "Zone"], "header columns");
  const zoneRows = rows.slice(1).filter(r => /(_SENSOR$)|(sensor input)/i.test(r[2]));
  assert.equal(zoneRows.length, COMPUTED.zones.length, "one zone row per zone");
  COMPUTED.zones.forEach(function (zone, i) {
    const label = zone.segmentName + "_Z" + zone.zoneInSegment1Based;
    const row = zoneRows[i];
    const bit = zone.zoneInGroup1Based - 1;
    assert.ok(row[0].indexOf(label + "_SENSOR") === 0, "sensor tag " + label);
    assert.equal(row[3], zone.blockName + ":I.Data." + bit, "input address " + label);
    assert.equal(Number(row[5]), zone.index1Based, "zone number " + label);
  });
  // tracking design CSV includes tracking + scanner tags
  const c = model.computeDesign(TRACK_DESIGN);
  const csv = hmi.generateTagListCsv(TRACK_DESIGN, c);
  const text = csv;
  assert.ok(text.indexOf("TRACK_TBL") !== -1, "TRACK_TBL row");
  assert.ok(text.indexOf("TRACK_COUNT") !== -1, "TRACK_COUNT row");
  assert.ok(text.indexOf("TRACK_RESET") !== -1, "TRACK_RESET row");
  assert.ok(text.indexOf("SCAN1_BARCODE") !== -1 && text.indexOf("SCAN1_GOOD_READ") !== -1, "scanner tag rows");
  // belt design CSV includes drive tags
  const bc = model.computeDesign(BELT_DESIGN);
  const beltCsv = hmi.generateTagListCsv(BELT_DESIGN, bc);
  for (const tag of ["BELT1_RUN_CMD", "BELT1_DRIVE_RUN", "BELT1_DRIVE_FAULT", "BELT1_DRIVE_STATUS"]) {
    assert.ok(beltCsv.indexOf(tag) !== -1, "belt CSV row " + tag);
  }
});

t("graphics spec: layout rows, tracking panel, scanner + geometry sections", () => {
  assert.ok(GRAPHICS_SPEC.length > 400, "spec length " + GRAPHICS_SPEC.length);
  assert.ok(/^# T8_CONVEYOR/m.test(GRAPHICS_SPEC), "title");
  const layoutRows = GRAPHICS_SPEC.split("\n").filter(l => /^\| SEG\d+_Z\d+ \| 0\.\d+ \|/.test(l));
  assert.equal(layoutRows.length, COMPUTED.zones.length, "normalised layout rows = zones");
  const bindingRows = GRAPHICS_SPEC.split("\n").filter(l => /^\| SEG\d+_Z\d+ \| NETS\[1\]\.ZPA\[\d\] \| ZPA\d\d:I\.Data\.\d/.test(l));
  assert.equal(bindingRows.length, COMPUTED.zones.length, "tag binding rows = zones");
  assert.ok(GRAPHICS_SPEC.indexOf("## Scanner elements") !== -1, "scanner elements section");
  assert.ok(GRAPHICS_SPEC.indexOf("## Tray tracking panel") !== -1, "tracking panel section");
  assert.ok(/stopped \| #41505f/.test(GRAPHICS_SPEC), "state palette documented");
  // tracking spec has the panel columns + tags
  const c = model.computeDesign(TRACK_DESIGN);
  const trackSpec = hmi.generateGraphicsSpec(TRACK_DESIGN, c);
  assert.ok(/Tray tracking panel/.test(trackSpec), "tracking panel section");
  assert.ok(/TRACK_TBL\[8\]/.test(trackSpec), "TRACK_TBL size documented");
  assert.ok(/STRING_20/.test(trackSpec), "barcode string width documented");
  assert.ok(/SCAN1_BARCODE \/ SCAN1_GOOD_READ/.test(trackSpec), "scanner tags documented");
  // curve/spiral spec has geometry rows
  const cc = model.computeDesign(CURVE_DESIGN);
  const curveSpec = hmi.generateGraphicsSpec(CURVE_DESIGN, cc);
  assert.ok(/## Conveyor geometry/.test(curveSpec), "geometry section");
  assert.ok(/^\| CURVE1 \| curve \|/m.test(curveSpec), "curve segment geometry row");
  assert.ok(/^\| SPIRAL1 \| spiral \|/m.test(curveSpec), "spiral segment geometry row");
  assert.ok(/pitch 0\.5 m/.test(curveSpec), "spiral pitch in spec");
});

/* ========================================================================== */
section("edge cases");

t("single-zone segment (2-zone template, second zone unconnected) generates cleanly", () => {
  const d = makeDesign("ONE_ZONE");
  d.segments = [{ id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 1, widthM: 0.6, zones: 1, zoneLengthM: 1 }];
  const c = model.computeDesign(d);
  assert.equal(c.groups[0].templateZones, 2, "template padded to 2 zones");
  const res = gen.generateConveyorL5x(d, c, { mode: "program" });
  const { parsed, vr } = parseAndValidate(res);
  assert.ok(res.ok, "ok");
  assert.equal(vr.errors.length, 0, "schema errors");
  assert.ok(res.warnings.some(w => /1 zone/i.test(w)), "warning about 1 zone");
});

t("10-zone segment auto-splits into 2 groups (8 + 2)", () => {
  const d = makeDesign("BIG_SEGMENT");
  d.segments = [{ id: "b1", name: "BIG", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 10, widthM: 0.6, zones: 10, zoneLengthM: 1 }];
  const c = model.computeDesign(d);
  assert.equal(c.totals.groups, 2, "2 groups");
  const res = gen.generateConveyorL5x(d, c, { mode: "program" });
  const { parsed, vr } = parseAndValidate(res);
  assert.equal(vr.errors.length, 0, "schema errors");
  const scans = parsed.programs[0].routines.filter(r => /ZONE_SCAN$/.test(r.name));
  assert.equal(scans.length, 2, "one scan routine per group");
  assert.ok(scans.some(r => /ZPA_G1_8ZONE_SCAN/.test(r.name)) && scans.some(r => /ZPA_G2_2ZONE_SCAN/.test(r.name)), "8-zone + 2-zone templates");
});

t("9-zone / 3-segment demo design (Lead integration layout) generates cleanly", () => {
  const d = demoDesign9();
  const c = model.computeDesign(d);
  assert.equal(c.totals.zones, 9, "9 zones");
  assert.equal(c.totals.groups, 3, "3 groups");
  const prog = gen.generateConveyorL5x(d, c, { mode: "program" });
  const { parsed, vr } = parseAndValidate(prog);
  assert.equal(vr.errors.length, 0, "program schema errors");
  const scans = parsed.programs[0].routines.filter(r => /ZONE_SCAN$/.test(r.name));
  assert.equal(scans.length, 3, "3 group scan routines");
  assert.equal(controllerTag(parsed, "ENET_INPUTS").dimension, 6, "ENET_INPUTS dims = groups*2");
  const ctrl = gen.generateConveyorL5x(d, c, { mode: "controller" });
  const { parsed: pc, vr: vc } = parseAndValidate(ctrl);
  assert.equal(vc.errors.length, 0, "controller schema errors");
  assert.equal(pc.modules.length, 4, "3 groups + Local");
  const html = hmi.generateHmiHtml(d, c, {});
  assert.ok(html.indexOf("SEG3_Z3") !== -1, "last zone rendered in HMI");
  assert.ok(html.indexOf("<b>3</b> ZPA groups") !== -1, "group count in HMI header");
});

/* ========================================================================== */
console.log("\n=================================================");
console.log("t8 conveyor-gen: " + pass + " passed, " + fail + " failed");
console.log("template library: " + Object.keys(TEMPLATES.routines).length + " routines, " +
  Object.keys(TEMPLATES.udts).length + " UDTs, " + Object.keys(TEMPLATES.tagTemplates).length +
  " controller tag templates, " + TEMPLATES.aoiLibrary.length + " AOIs, " +
  Math.round(fs.statSync(TEMPLATES_FILE).size / 1024) + " KB");
console.log("roller program: " + RES.stats.routines + " routines, " + RES.stats.groups + " groups, " +
  Math.round(RES.l5x.length / 1024) + " KB, schema errors " + RES.stats.schemaErrors);
console.log("curve/spiral program: " + RES_CURVE.stats.routines + " routines, " + RES_CURVE.stats.groups +
  " groups, " + RES_CURVE.stats.curvedZones + " curved zones, " + Math.round(RES_CURVE.l5x.length / 1024) +
  " KB, schema errors " + RES_CURVE.stats.schemaErrors);
console.log("belt program: " + RES_BELT.stats.routines + " routines, " + RES_BELT.stats.beltDrives +
  " drives, " + Math.round(RES_BELT.l5x.length / 1024) + " KB, schema errors " + RES_BELT.stats.schemaErrors);
console.log("tracking program: " + RES_TRACK.stats.routines + " routines, " + RES_TRACK.stats.scanZones +
  " scan zones, " + Math.round(RES_TRACK.l5x.length / 1024) + " KB, schema errors " + RES_TRACK.stats.schemaErrors);
console.log("controller mode: " + RES_CONTROLLER.stats.routines + " routines, " + RES_CONTROLLER.stats.modules +
  " modules, " + Math.round(RES_CONTROLLER.l5x.length / 1024) + " KB, schema errors " + RES_CONTROLLER.stats.schemaErrors);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("- " + f.split("\n").slice(0, 5).join("\n  "));
}
process.exit(fail ? 1 : 0);
