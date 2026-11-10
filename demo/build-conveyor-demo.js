/* DEMO (Lead): builds the complete conveyor design package for the demo layout:
   - design JSON
   - component selection + bill of materials (CSV + Markdown)
   - generated L5X (program-export and controller-export), schema-validated
   - HMI graphics (HTML5) + tag list CSV + graphics spec
   Run: node demo/build-conveyor-demo.js
   Output: demo/conveyor/  */
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
const conveyorModel = JS("conveyor/model.js");
const parts = JS("conveyor/parts.js");
const gen = JS("conveyor/l5xgen.js");
let hmi = null;
try { hmi = JS("conveyor/hmi.js"); } catch (e) { /* not delivered yet */ }

const OUT = path.join(__dirname, "conveyor");
fs.mkdirSync(OUT, { recursive: true });

function demoDesigns() {
  const M = conveyorModel;
  const base = M.createDefaultDesign();
  const d1 = JSON.parse(JSON.stringify(base));
  d1.name = "DEMO_CONVEYOR";
  d1.conveyorType = "roller";
  d1.controller.name = "CONVEYOR_PLC";
  d1.network.baseIp = "192.168.1.100";
  d1.segments = [
    { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null },
    { id: "seg2", name: "SEG2", kind: "curve", turnDeg: 0, curveDeg: 90, radiusM: 1.748, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg3", name: "SEG3", kind: "straight", turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg4", name: "SPIRAL1", kind: "spiral", turnDeg: 0, radiusM: 1.2, widthM: 0.6, zoneLengthM: 1, spiral: { pitchM: 0.8, heightM: 2.4, direction: "up" }, motorSeries: null, driverCard: null },
    { id: "spur1", name: "SPUR1", kind: "straight", x: 3.95, y: 3.0, z: 0, rotationDeg: 270, turnDeg: 0, lengthM: 2.72, widthM: 0.6, zones: 2, zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null }
  ];
  d1.merges = [{ id: "merge1", name: "MERGE1", mainSegmentId: "seg2", offsetM: 1.0, spurEndSegmentId: "spur1", priority: "alternate" }];
  d1.transfers = [
    { id: "xfer1", name: "PUSHER1", type: "pusher", segmentId: "seg3", offsetM: 1.5, side: "right", extendTimeS: 0.8 },
    { id: "xfer2", name: "ROTARY1", type: "rotary_table", segmentId: "seg3", offsetM: 2.5, stepDeg: 90, homeAngleDeg: 0 },
    { id: "xfer3", name: "POPUP1", type: "popup_transfer", segmentId: "seg1", offsetM: 3.0, directions: ["left", "right"], beltCount: 3 }
  ];
  d1.scanZones = [{ id: "scan1", name: "SCAN1", segmentId: "seg1", offsetM: 2.5, type: "barcode", side: "right", tagName: null }];
  d1.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  const d2 = JSON.parse(JSON.stringify(base));
  d2.name = "BELT_CONVEYOR";
  d2.conveyorType = "belt";
  d2.controller.name = "BELT_PLC";
  d2.network.baseIp = "192.168.1.120";
  d2.segments = [
    { id: "b1", name: "BELT1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 6, widthM: 0.8, zones: 3, zoneLengthM: 2, motorSeries: null, driverCard: null },
    { id: "b2", name: "SPIRAL_UP", kind: "spiral", turnDeg: 0, radiusM: 1.4, widthM: 0.8, zoneLengthM: 2, spiral: { pitchM: 0.9, heightM: 2.7, direction: "up" }, motorSeries: null, driverCard: null },
    { id: "b3", name: "BELT2", kind: "straight", turnDeg: 30, lengthM: 4, widthM: 0.8, zones: 2, zoneLengthM: 2, motorSeries: null, driverCard: null }
  ];
  d2.scanZones = [{ id: "scan1", name: "SCAN_IN", segmentId: "b1", offsetM: 5, type: "barcode", side: "right", tagName: null }];
  d2.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  return [d1, d2];
}

for (const design of demoDesigns()) {
  const computed = conveyorModel.computeDesign(design);
  const validation = conveyorModel.validateDesign(design);
  const stem = design.name;
  console.log("design:", stem, "·", computed.totals.segments, "segments ·",
    computed.totals.zones, "zones ·", computed.totals.conveyorLengthM.toFixed(1), "m ·",
    computed.totals.groups, "groups ·", computed.conveyorType,
    computed.totals.spiralRiseM ? "· spiral " + computed.totals.spiralRiseM + " m" : "",
    computed.totals.scanZones ? "· " + computed.totals.scanZones + " scanner(s)" : "",
    computed.totals.trackingEnabled ? "· tracking" : "");
  console.log("validation:", validation.ok ? "ok" : "ERRORS", validation.warnings.length, "warnings");
  fs.writeFileSync(path.join(OUT, stem + "-design.json"), conveyorModel.designToJson(design), "utf8");

  /* components + BOM */
  const selections = parts.selectComponents(design, computed, {});
  const bom = parts.buildBom(design, computed, selections, {});
  fs.writeFileSync(path.join(OUT, stem + "-bom.csv"), parts.bomToCsv(bom.rows), "utf8");
  fs.writeFileSync(path.join(OUT, stem + "-bom.md"), parts.bomToMarkdown(bom.rows, bom.totals), "utf8");
  console.log("BOM:", bom.rows.length, "lines · total $" + bom.totals.grandTotal.toFixed(2));

  /* L5X program + controller exports */
  const schema = JS("schema-validate.js");
  for (const mode of ["program", "controller"]) {
    const res = gen.generateConveyorL5x(design, computed, { mode: mode });
    const file = path.join(OUT, stem + (mode === "controller" ? "-controller" : "") + ".L5X");
    fs.writeFileSync(file, res.l5x, "utf8");
    try {
      const parsed = modelApi.parseL5X(res.l5x);
      const vr = schema.validateModel(parsed, {});
      const errs = (vr.errors || []).length;
      console.log(mode + " export:", (res.l5x.length / 1024).toFixed(0) + " KB ·",
        (res.stats && res.stats.routines) || "?", "routines ·", errs, "schema errors,",
        (vr.warnings || []).length, "warnings");
      if (errs) console.log("  SCHEMA ERRORS:", JSON.stringify((vr.errors || []).slice(0, 5)));
    } catch (e) {
      console.log(mode + " export: parse/validation failed:", e.message);
    }
  }

  /* HMI graphics package */
  if (hmi) {
    const html = hmi.generateHmiHtml(design, computed, {});
    fs.writeFileSync(path.join(OUT, stem + "-hmi.html"), html, "utf8");
    fs.writeFileSync(path.join(OUT, stem + "-tag-list.csv"), hmi.generateTagListCsv(design, computed), "utf8");
    fs.writeFileSync(path.join(OUT, stem + "-graphics-spec.md"), hmi.generateGraphicsSpec(design, computed), "utf8");
    console.log("HMI:", (html.length / 1024).toFixed(0) + " KB self-contained HTML · tag list + graphics spec written");
  } else {
    console.log("HMI generator not delivered yet - skipped");
  }
}
console.log("\nartifacts in demo/conveyor/:");
for (const f of fs.readdirSync(OUT)) {
  console.log("  ", f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + " KB");
}
