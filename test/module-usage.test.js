/* L5X Studio — module-level I/O dataflow tests (module-usage.js + mermaid renderer).
 *
 * Covers the SAMPLE_RLL project (real EtherNet/IP 1799ER blocks, chassis 1756-DNB,
 * PowerFlex drives, controller) and a generated conveyor L5X project, plus the
 * Mermaid text builders, the offline Mermaid SVG renderer, the terminal schematic
 * and the usage report.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODEL = require("../js/l5x-model.js");
const USAGE = require("../js/module-usage.js");
const MERMAID = require("../js/mermaid-render.js");

const ROOT = path.join(__dirname, "..");
const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/samples/controller.L5X";
const LOCAL_SAMPLE_RLL = path.join(ROOT, "..", "samples", "SAMPLE_RLL.L5X");

let passed = 0, failed = 0, skipped = 0;
const failures = [];
class Skip extends Error {}
function t(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) {
    if (e instanceof Skip) { skipped++; console.log("skip " + name + " (" + e.message + ")"); return; }
    failed++; failures.push({ name: name, error: e }); console.log("FAIL " + name + "\n     " + e.message);
  }
}

function sampleRllPath() {
  if (fs.existsSync(SAMPLE_RLL)) return SAMPLE_RLL;
  return LOCAL_SAMPLE_RLL;
}

let alModel = null, alAnalysis = null;
function sampleRllModel() {
  if (!alModel) {
    const p = sampleRllPath();
    if (!p || !fs.existsSync(p)) throw new Skip("SAMPLE_RLL.L5X sample not available (set L5X_STUDIO_SAMPLE_RLL)");
    
    alModel = MODEL.parseL5X(fs.readFileSync(p, "utf8"));
    alAnalysis = USAGE.analyzeModules(alModel, {});
  }
  return alModel;
}
function analysis() { sampleRllModel(); return alAnalysis; }

/* ------------------------------------------------------------------ catalog */
t("capacityFromCatalog: discrete and analog catalogs", () => {
  let c = USAGE.capacityFromCatalog("1799ER-IQ10XOQ10/A");
  assert.equal(c.inputBits, 10);
  assert.equal(c.outputBits, 10);
  c = USAGE.capacityFromCatalog("1756-IA16");
  assert.equal(c.inputBits, 16);
  c = USAGE.capacityFromCatalog("1756-OB16");
  assert.equal(c.outputBits, 16);
  c = USAGE.capacityFromCatalog("1756-IF16");
  assert.equal(c.inputPoints, 16);
  assert.equal(c.inputBits, null);
  assert.equal(USAGE.capacityFromCatalog("1756-EN2T"), null);
});

/* ------------------------------------------------------------- SAMPLE_RLL analysis */
t("analysis: module inventory of SAMPLE_RLL", () => {
  const a = analysis();
  assert.ok(a.modules.length >= 70, "named modules " + a.modules.length);
  assert.ok(a.summary.unnamedModules >= 10, "unnamed peripherals skipped: " + a.summary.unnamedModules);
  assert.ok(a.summary.bridges >= 1, "fieldbus bridges " + a.summary.bridges);
  assert.equal(a.summary.controllers, 1);
  assert.ok(a.summary.network >= 60, "network modules " + a.summary.network);
  assert.ok(a.summary.subdevices >= 0, "named sub devices " + a.summary.subdevices);
  assert.ok(a.summary.hardware >= 1, "hardware modules " + a.summary.hardware);
  assert.ok(a.summary.usedPoints > 100, "used points " + a.summary.usedPoints);
  assert.ok(a.summary.totalPoints > 3000, "total points " + a.summary.totalPoints);
  assert.ok(a.controller, "controller name");
  assert.ok(a.notes.some(n => /ENET_INPUTS/.test(n)), "shared buffer note");
});

t("analysis: network module GROUP01 (1799ER) has connection + used bits", () => {
  const a = analysis();
  const m = a.modules.find(x => x.name === "GROUP01");
  assert.ok(m, "GROUP01 present");
  assert.equal(m.kind, "network");
  assert.equal(m.protocol, "EtherNet/IP");
  assert.equal(m.ip, "192.168.1.51");
  assert.equal(m.rpi, "7000");
  assert.equal(m.catalogNumber, "1799ER-IQ10XOQ10/A");
  assert.equal(m.capacity.inputBits, 10);
  assert.equal(m.capacity.outputBits, 10);
  assert.equal(m.summary.totalInputBits, 10);
  assert.equal(m.inputBytes, 6, "input image bytes (DOMParser values may carry whitespace)");
  assert.equal(m.outputBytes, 2, "output image bytes: [2] array");
  assert.equal(m.summary.wordMappedInputBits, 10, "image word mapped");
  assert.ok(m.summary.usedInputBits >= 4, "specific used input bits " + m.summary.usedInputBits);
  assert.ok(m.summary.usedOutputBits >= 0);
  assert.ok(m.summary.usedPoints >= 1, "used image points");
  // the image word is mapped into the shared ENET buffers
  const buffers = m.buffers.map(b => b.buffer);
  assert.ok(buffers.indexOf("ENET_INPUTS") !== -1, "ENET_INPUTS mapping");
  assert.ok(buffers.indexOf("ENET_OUTPUTS") !== -1, "ENET_OUTPUTS mapping");
  // bit 0 is used via a mapped-buffer reference
  const b0 = m.inputBits[0];
  assert.ok(b0.used, "bit 0 used");
  assert.ok(/mapped buffer/.test(b0.how.join("; ")), "bit 0 how: " + b0.how.join("; "));
});

t("analysis: PDP network block + 1756-DNB chassis module", () => {
  const a = analysis();
  const p = a.modules.find(x => x.name === "PDP");
  assert.equal(p.kind, "network");
  assert.equal(p.ip, "192.168.1.10");
  assert.equal(p.rpi, "20000");
  const n = a.modules.find(x => x.name === "Network1");
  assert.equal(n.kind, "hardware");
  assert.equal(n.protocol, "Backplane (chassis)");
  assert.equal(n.slot, 1);
  assert.equal(n.catalogNumber, "1756-DNB");
  assert.ok(n.points.length >= 200, "DNB image points " + n.points.length);
  assert.ok(n.inputBytes >= 400, "DNB input bytes " + n.inputBytes);
});

t("analysis: controller module and sub-devices", () => {
  const a = analysis();
  const cpu = a.modules.find(x => x.kind === "controller");
  assert.ok(cpu, "controller module");
  assert.equal(cpu.catalogNumber, "1756-L83E");
  assert.ok(a.modules.every(function (m) { return m.kind !== "subdevice" || m.kindLabel === "Sub-device"; }));
  // unnamed peripheral modules (PowerFlex DSI) are skipped from the named module list
  assert.ok(a.summary.unnamedModules >= 10, "unnamed peripherals counted: " + a.summary.unnamedModules);
});

/* ------------------------------------------------------------------ mermaid */
t("mermaid: per-module diagram + statuses", () => {
  const mm = USAGE.moduleMermaid(analysis(), "GROUP01");
  assert.ok(/^flowchart LR/.test(mm), "flowchart header");
  assert.ok(mm.indexOf("GROUP01") !== -1, "module node");
  assert.ok(mm.indexOf("ENET_INPUTS") !== -1, "buffer tag node");
  assert.ok(mm.indexOf("IN_0") !== -1, "input bit node");
  assert.ok(mm.indexOf("OUT_0") !== -1, "output bit node");
  assert.ok(/:::used/.test(mm), "used class");
  assert.ok(/:::netip|:::netdn|:::mapped/.test(mm), "word-mapped bits carry a transport class");
  assert.ok(/classDef used/.test(mm), "classDef");
  // every node declaration is well-formed
  const nodeLines = mm.split("\n").filter(l => /^\s+[A-Za-z0-9_]+\[".*"\]/.test(l));
  assert.ok(nodeLines.length > 10, "node definitions " + nodeLines.length);
});

t("mermaid: project diagram contains module kinds and connections", () => {
  const pm = USAGE.projectMermaid(analysis());
  assert.ok(/^flowchart LR/.test(pm), "flowchart header");
  assert.ok(/controller/.test(pm), "controller node");
  assert.ok(/EtherNet\/IP/.test(pm), "network edges");
  assert.ok(/chassis/.test(pm), "hardware edges");
  assert.ok(/:::net/.test(pm), "network class");
  assert.ok(/:::hw/.test(pm), "hardware class");
  assert.ok(pm.split("\n").length > 100, "project diagram is substantial");
});

t("mermaid renderer: parse + layout + SVG", () => {
  const text = [
    "flowchart LR",
    "  classDef used fill:#1b5e20,stroke:#66bb6a,color:#fff",
    "  A[\"Module<br/>GROUP01\"]:::used",
    "  B[\"Tag<br/>ENET_INPUTS\"]",
    "  A -->|\"bit 0\"| B",
    "  A -->|\"word\"| C[\"Routine<br/>ENET_INPUTS\"]"
  ].join("\n");
  const g = MERMAID.parse(text);
  assert.equal(g.direction, "LR");
  assert.equal(Object.keys(g.nodes).length, 3);
  assert.equal(g.edges.length, 2);
  assert.equal(g.nodes.A.cls, "used");
  const laid = MERMAID.layout(g);
  const ax = laid.positions.A, bx = laid.positions.B;
  assert.ok(bx.x > ax.x, "B is to the right of A (LR)");
  const svg = MERMAID.renderToSvg(text);
  assert.ok(svg.indexOf("<svg") === 0, "svg output");
  assert.ok(svg.indexOf("GROUP01") !== -1, "label");
  assert.ok(svg.indexOf("#1b5e20") !== -1, "class fill used");
  assert.ok(svg.indexOf("marker-end") !== -1, "arrow marker");
  assert.ok(svg.length > 500, "svg size");
  // top-down variant
  const g2 = MERMAID.parse(text.replace("flowchart LR", "flowchart TD"));
  assert.equal(g2.direction, "TD");
  const svg2 = MERMAID.renderToSvg(g2 ? text.replace("flowchart LR", "flowchart TD") : text);
  assert.ok(svg2.indexOf("<svg") === 0);
});

t("mermaid renderer: renders the real module diagram", () => {
  const a = analysis();
  const mm = USAGE.moduleMermaid(a, "GROUP01");
  const svg = MERMAID.renderToSvg(mm);
  assert.ok(svg.indexOf("<svg") === 0);
  // count rendered node rectangles
  const rects = (svg.match(/<rect /g) || []).length;
  assert.ok(rects > 12, "node rectangles " + rects);
  const pm = USAGE.projectMermaid(a);
  const ps = MERMAID.renderToSvg(pm);
  assert.ok(ps.length > 5000, "project svg substantial: " + ps.length);
  const wm = /width=\"(\d+)\"/.exec(ps);
  const hm = /height=\"(\d+)\"/.exec(ps);
  assert.ok(+wm[1] > 400, "project svg width " + wm[1]);
  assert.ok(+hm[1] > 400, "project svg height " + hm[1]);
});

/* ---------------------------------------------------------------- schematic */
t("schematic: terminal-level module view", () => {
  const svg = USAGE.moduleSchematicSvg(analysis(), "GROUP01");
  assert.ok(svg.indexOf("<svg") === 0);
  assert.ok(svg.indexOf("GROUP01") !== -1, "module name");
  assert.ok(svg.indexOf("1799ER-IQ10XOQ10/A") !== -1, "catalog");
  for (let i = 0; i < 10; i++) {
    assert.ok(svg.indexOf(">I" + i + "<") !== -1, "input terminal I" + i);
    assert.ok(svg.indexOf(">O" + i + "<") !== -1, "output terminal O" + i);
  }
  assert.ok(/ENET_INPUTS/.test(svg), "buffer tag on the schematic");
  const missing = USAGE.moduleSchematicSvg(analysis(), "NOT_A_MODULE");
  assert.ok(/module not found/.test(missing));
});

/* ------------------------------------------------------------------- report */
t("report: markdown summary + detailed modules", () => {
  const md = USAGE.moduleReport(analysis(), { modules: ["GROUP01", "PDP", "Network1"] });
  assert.ok(md.indexOf("# Module I/O & dataflow report") === 0);
  assert.ok(md.indexOf("| module | catalog | kind |") !== -1, "summary table");
  assert.ok(md.indexOf("## GROUP01") !== -1, "GROUP01 section");
  assert.ok(md.indexOf("## Network1") !== -1, "Network1 section");
  assert.ok(md.indexOf("| bit | address | status |") !== -1, "bit table");
  assert.ok(md.indexOf("word-mapped") !== -1, "word-mapped status");
  assert.ok(md.indexOf("CAD models") !== -1, "CAD limitation noted");
  // every module appears in the summary table
  const rows = md.split("\n").filter(l => /^\| \S+ \| 1799ER|^\| \S+ \| 1756/.test(l));
  assert.ok(rows.length >= 5, "summary rows " + rows.length);
});

/* ------------------------------------------------- generated conveyor project */
t("generated conveyor L5X: module I/O analysis", () => {
  const CM = require("../js/conveyor/model.js");
  const GEN = require("../js/conveyor/l5xgen.js");
  const d = CM.createDefaultDesign();
  d.name = "MODTEST";
  d.segments = [
    { id: "s1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1, newChain: true },
    { id: "s2", name: "SEG2", kind: "straight", x: 3, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  d.transfers = [
    { id: "t1", name: "PUSHER1", type: "pusher", segmentId: "s2", offsetM: 0.8, side: "right" },
    { id: "t2", name: "ROTARY1", type: "rotary_table", segmentId: "s2", offsetM: 1.5, stepDeg: 90 }
  ];
  d.scanZones = [{ id: "sc1", name: "SCAN1", segmentId: "s1", offsetM: 1.5, type: "barcode", side: "right" }];
  d.tracking = { enabled: true, maxTrays: 8, barcodeLen: 20 };
  const c = CM.computeDesign(d);
  const res = GEN.generateConveyorL5x(d, c, { mode: "controller" });
  const gm = MODEL.parseL5X(res.l5x);
  const a = USAGE.analyzeModules(gm, {});
  assert.ok(a.modules.length >= 4, "modules " + a.modules.length);
  const zpa = a.modules.find(m => /^ZPA0?1/.test(m.name));
  assert.ok(zpa, "ZPA block module: " + a.modules.map(m => m.name).join(","));
  assert.equal(zpa.kind, "network");
  assert.ok(zpa.ip, "ZPA module has an IP");
  assert.equal(zpa.summary.totalInputBits, 10);
  assert.ok(zpa.summary.wordMappedInputBits === 10, "zone image word mapped");
  const dev = a.modules.find(m => /^XFER0?1/.test(m.name));
  assert.ok(dev, "device block module");
  assert.equal(dev.kind, "network");
  assert.ok(dev.capacity && dev.capacity.inputBits === 10, "device capacity");
  const mm = USAGE.moduleMermaid(a, zpa.name);
  assert.ok(mm.indexOf(zpa.name) !== -1);
  const svg = MERMAID.renderToSvg(mm);
  assert.ok(svg.indexOf("<svg") === 0);
  const md = USAGE.moduleReport(a, { modules: [zpa.name, dev.name] });
  assert.ok(md.indexOf("## " + zpa.name) !== -1);
});

/* ------------------------------------------------------------- robustness */
t("robustness: empty/odd projects do not throw", () => {
  const min = MODEL.parseL5X('<?xml version="1.0"?><RSLogix5000Content SchemaRevision="1.0"><Controller Name="C" ProcessorType="1756-L83E"/></RSLogix5000Content>');
  const a = USAGE.analyzeModules(min, {});
  assert.ok(Array.isArray(a.modules));
  assert.ok(USAGE.moduleMermaid(a, "nope").indexOf("not found") !== -1);
  const svg = USAGE.moduleSchematicSvg(a, "nope");
  assert.ok(svg.indexOf("<svg") === 0);
  const md = USAGE.moduleReport(a, {});
  assert.ok(md.indexOf("Module I/O") !== -1);
});

console.log("\nmodule-usage: " + passed + " passed, " + failed + " failed, " + skipped + " skipped (sample-dependent)");
if (failed) {
  for (const f of failures) console.log("\n--- " + f.name + " ---\n" + (f.error && f.error.stack || f.error));
  process.exit(1);
}
