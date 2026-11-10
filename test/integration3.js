/* L5X Studio - test/integration3.js (Lead). Conveyor Design Studio end-to-end:
   design model -> geometry/zones -> components -> BOM -> L5X generation -> schema validation
   -> HMI graphics. Sections whose module is not delivered yet are skipped. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
const conveyorModel = JS("conveyor/model.js");
let parts, gen, hmi;
function tryRequire(p, name) {
  try { return require(path.join(__dirname, "..", "js", p)); }
  catch (e) { console.log("skip " + name + " (not delivered: " + e.code + ")"); return null; }
}
parts = tryRequire("conveyor/parts.js", "conveyor parts");
gen = tryRequire("conveyor/l5xgen.js", "L5X generator");
hmi = tryRequire("conveyor/hmi.js", "HMI generator");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 6).join("\n     ")); }
}

/* demo design: 3 segments / 9 zones */
function demoDesign() {
  const d = conveyorModel.createDefaultDesign();
  d.name = "DEMO_CONVEYOR";
  d.segments = [
    { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, rotationDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg2", name: "SEG2", kind: "straight", x: 4.05, y: 0, rotationDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg3", name: "SEG3", kind: "straight", x: 6.1, y: 0, rotationDeg: -30, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1, motorSeries: null, driverCard: null }
  ];
  return d;
}

/* ---- design model ---- */
t("model: default design computes", () => {
  const design = conveyorModel.createDefaultDesign();
  const c = conveyorModel.computeDesign(design);
  assert.equal(c.totals.segments, 1);
  assert.equal(c.totals.zones, 4);
  assert.equal(c.totals.groups, 1, "one ZPA group of 4 zones");
  assert.equal(c.totals.blocks, 1, "one I/O block per group");
  assert.ok(c.zones.every(z => /^ZPA\d\d$/.test(z.blockName)), "block names");
  assert.ok(c.segments[0].zones.length === 4, "segment zones");
  const v = conveyorModel.validateDesign(design);
  assert.ok(v.ok, "valid: " + v.errors.join("; "));
});

t("model: 3-segment demo geometry + group allocation", () => {
  const design = demoDesign();
  const c = conveyorModel.computeDesign(design);
  assert.equal(c.totals.zones, 9);
  assert.equal(c.totals.groups, 3, "one group per segment");
  assert.equal(c.totals.blocks, 3);
  const v = conveyorModel.validateDesign(design);
  assert.ok(v.ok, "valid: " + v.errors.join("; "));
  // zone indices 1-based sequential across the design
  for (let i = 0; i < c.zones.length; i++) assert.equal(c.zones[i].index1Based, i + 1);
  // segment -> its own group/block, zone-in-group bits 0..n-1
  const seg1 = c.zones.filter(z => z.segmentId === "seg1");
  const seg2 = c.zones.filter(z => z.segmentId === "seg2");
  const seg3 = c.zones.filter(z => z.segmentId === "seg3");
  assert.equal(new Set(seg1.map(z => z.blockName)).size, 1);
  assert.equal(seg1[0].blockName, "ZPA01");
  assert.equal(seg2[0].blockName, "ZPA02");
  assert.equal(seg3[0].blockName, "ZPA03");
  assert.deepEqual(seg2.map(z => z.zoneInGroup1Based), [1, 2]);
  assert.deepEqual(seg2.map(z => z.sensorBit), [0, 1]);
  // segment zone counts
  const counts = c.segments.map(s => s.zones.length);
  assert.deepEqual(counts, [4, 2, 3]);
  // IPs sequential and unique per group
  const ips = c.blocks.map(b => b.ip);
  assert.equal(new Set(ips).size, 3, "unique IPs: " + ips.join(","));
  // placement: seg2 continues seg1
  const s1 = c.segments[0], s2 = c.segments[1];
  assert.ok(Math.abs(s2.start.x - (s1.end.x + 0.05)) < 0.2, "segment continuation");
  // a 10-zone segment splits into two groups of <=8
  const big = conveyorModel.createDefaultDesign();
  big.segments = [{ id: "b1", name: "BIG", kind: "straight", x: 0, y: 0, rotationDeg: 0, lengthM: 10, widthM: 0.6, zones: 10, zoneLengthM: 1, motorSeries: null, driverCard: null }];
  const bc = conveyorModel.computeDesign(big);
  assert.equal(bc.totals.groups, 2, "10 zones -> 2 groups");
  assert.deepEqual(bc.groups.map(g => g.zoneCount), [8, 2]);
  assert.equal(bc.zones[8].zoneInGroup1Based, 1, "second group starts at zone-in-group 1");
  assert.equal(bc.zones[8].blockName, "ZPA02");
  // curve segment geometry
  const cd = conveyorModel.createDefaultDesign();
  cd.segments = [{ id: "c1", name: "CURVE1", kind: "curve", x: 0, y: 0, rotationDeg: 0, curveDeg: 45, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }];
  const cc = conveyorModel.computeDesign(cd);
  assert.ok(cc.bounds.width > 0 && cc.bounds.height > 0, "curve bounds");
});

t("model: add/update/remove segment", () => {
  let d = conveyorModel.createDefaultDesign();
  d = conveyorModel.addSegment(d, { name: "SEG2", x: 4, y: 0, zones: 3, lengthM: 3 });
  assert.equal(d.segments.length, 2);
  d = conveyorModel.updateSegment(d, d.segments[1].id, { zones: 4 });
  assert.equal(d.segments[1].zones, 4);
  d = conveyorModel.removeSegment(d, d.segments[1].id);
  assert.equal(d.segments.length, 1);
});

/* ---- curves: frustum-standardised turning radius + tapered rollers ---- */
function curvedDesign() {
  const d = conveyorModel.createDefaultDesign();
  d.name = "CURVED";
  d.segments = [
    { id: "s1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1 },
    { id: "s2", name: "CURVE1", kind: "curve", turnDeg: 0, curveDeg: 90, radiusM: 1.748, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "s3", name: "SEG2", kind: "straight", turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  return d;
}
t("model: tapered-roller curve + rounded joint", () => {
  const c = conveyorModel.computeDesign(curvedDesign());
  const curve = c.segments.find(s => s.kind === "curve");
  assert.ok(curve.radiusM > 1.5 && curve.radiusM < 2, "curve radius " + curve.radiusM);
  assert.ok(curve.taper && curve.taper.standardId === "TS-20", "standard taper " + (curve.taper && curve.taper.standardId));
  assert.ok(Math.abs(curve.taper.deltaM - 0.020) < 0.001, "taper delta 20 mm");
  assert.ok(curve.taper.withinTolerance, "requested radius matches the standard");
  // frustum relation: R = W*D_avg/delta
  const fromFrustum = conveyorModel.taperRadiusFromFrustum({
    widthM: 0.6, smallDiameterM: curve.taper.smallDiameterM, largeDiameterM: curve.taper.largeDiameterM
  });
  assert.ok(Math.abs(fromFrustum - curve.radiusM) < 0.01, "frustum radius " + fromFrustum + " vs " + curve.radiusM);
  const curvedZones = c.zones.filter(z => z.curved);
  assert.ok(curvedZones.length >= 2, "curved zones");
  assert.ok(curvedZones.every(z => z.rollerType === "tapered"), "tapered rollers on curves");
  assert.ok(c.totals.taperedRollerCount > 0, "tapered roller count " + c.totals.taperedRollerCount);
  // rounded joints between chained segments
  assert.equal(c.joints.length, 2, "two chained joints");
  assert.ok(c.joints.every(j => j.rounded === true), "joints rounded");
  assert.ok(c.joints.every(j => Math.abs(j.filletRadiusM - 0.3) < 0.001), "fillet = half width");
  // curve length = R*theta
  assert.ok(Math.abs(curve.lengthM - curve.radiusM * Math.PI / 2) < 0.01, "arc length " + curve.lengthM);
  // standard taper table
  const standards = conveyorModel.standardCurveRadii(0.6);
  assert.ok(standards.length >= 5, "standard taper table");
  assert.ok(standards.every(s => s.radiusM > 0 && s.coneHalfAngleDeg > 0), "standard radii valid");
  const near = conveyorModel.nearestStandardTaper(0.6, 1.6);
  assert.ok(near && near.standard && near.radiusM > 0, "nearest standard taper");
});

/* ---- spirals (up and down) ---- */
t("model: spiral helix geometry + limits", () => {
  const d = conveyorModel.createDefaultDesign();
  d.segments = [
    { id: "s1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "s2", name: "SPIRAL_UP", kind: "spiral", turnDeg: 0, radiusM: 1.2, widthM: 0.6, zoneLengthM: 1, spiral: { pitchM: 0.8, heightM: 2.4, direction: "up" } }
  ];
  const c = conveyorModel.computeDesign(d);
  const sp = c.segments[1];
  assert.ok(sp.spiral && sp.spiral.direction === "up", "spiral up");
  assert.ok(Math.abs(sp.spiral.heightM - 2.4) < 0.001, "height");
  assert.ok(Math.abs(sp.spiral.slopeDeg - 6.06) < 0.2, "slope " + sp.spiral.slopeDeg);
  assert.ok(c.bounds.zRange > 2.3, "z range " + c.bounds.zRange);
  assert.ok(sp.zones.length > 10, "spiral zones derived from helix length: " + sp.zones.length);
  const v = conveyorModel.validateDesign(d);
  assert.ok(v.ok, "spiral valid: " + v.errors.join("; "));
  // down spiral gets a braking recommendation (roller conveyor)
  const down = JSON.parse(JSON.stringify(d));
  down.segments[1].spiral.direction = "down";
  const dv = conveyorModel.validateDesign(down);
  assert.ok(dv.warnings.some(w => /braking/i.test(w)), "down spiral braking warning");
  // slope beyond the maximum is rejected (tight radius + max pitch -> >18 deg)
  const steep = JSON.parse(JSON.stringify(d));
  steep.segments[1].radiusM = 0.6;
  steep.segments[1].spiral.pitchM = 2.0;
  const sv = conveyorModel.validateDesign(steep);
  assert.ok(sv.errors.some(e => /slope/i.test(e)), "steep spiral rejected: " + sv.errors.join("; "));
});

/* ---- belt conveyors ---- */
t("model: belt conveyor design", () => {
  const d = conveyorModel.createDefaultDesign();
  d.name = "BELT";
  d.conveyorType = "belt";
  d.segments = [
    { id: "b1", name: "BELT1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 5, widthM: 0.8, zones: 3, zoneLengthM: 2 },
    { id: "b2", name: "SPIRAL_UP", kind: "spiral", turnDeg: 0, radiusM: 1.4, widthM: 0.8, zoneLengthM: 2, spiral: { pitchM: 0.9, heightM: 2.7, direction: "up" } }
  ];
  const c = conveyorModel.computeDesign(d);
  assert.equal(c.conveyorType, "belt");
  assert.equal(c.totals.beltSegments, 2);
  assert.ok(c.segments.every(s => s.taper === null), "belt segments do not use tapered rollers");
  assert.ok(c.totals.spiralRiseM > 2.6, "spiral rise " + c.totals.spiralRiseM);
  const v = conveyorModel.validateDesign(d);
  assert.ok(v.ok, "belt design valid: " + v.errors.join("; "));
});

/* ---- scan zones + tray tracking ---- */
t("model: scan zones + tray tracking", () => {
  const d = curvedDesign();
  d.scanZones = [
    { id: "sc1", name: "SCAN1", segmentId: "s1", offsetM: 1.5, type: "barcode", side: "right" },
    { id: "sc2", name: "SCAN2", segmentId: "s3", offsetM: 1.0, type: "camera", side: "left" }
  ];
  d.tracking = { enabled: true, maxTrays: 12, barcodeLen: 24, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRAY" };
  const c = conveyorModel.computeDesign(d);
  assert.equal(c.scannedZones.length, 2);
  assert.ok(c.scannedZones.every(s => s.zoneIndex1Based >= 1 && s.tagName), "scanner tag names");
  assert.ok(c.tracking && c.tracking.enabled, "tracking enabled");
  assert.equal(c.tracking.zones.length, c.zones.length, "track zone per zone");
  assert.equal(c.tracking.scanZones, 2);
  assert.equal(c.tracking.maxTrays, 12);
  assert.ok(c.tracking.zones.some(z => z.scanned), "scanned zones flagged");
  const v = conveyorModel.validateDesign(d);
  assert.ok(v.ok, "design valid: " + v.errors.join("; "));
  // tracking on without scanners warns
  const d2 = curvedDesign();
  d2.tracking = { enabled: true, maxTrays: 8, barcodeLen: 20 };
  const v2 = conveyorModel.validateDesign(d2);
  assert.ok(v2.warnings.some(w => /no scan zone/i.test(w)), "tracking-without-scanner warning");
});

/* ---- merge junctions + bidirectional transfer devices ---- */
function mergeTransferDesign() {
  const d = curvedDesign(); // s1 straight 3 m / s2 90 deg curve / s3 straight 2 m
  // the curve merge point (offset 1.0 m on s2) is at ~(3.95, 0.28); the spur ends there
  d.segments.push({
    id: "spur1", name: "SPUR1", kind: "straight",
    x: 3.95, y: 3.0, z: 0, rotationDeg: 270, turnDeg: 0,
    lengthM: 2.72, widthM: 0.6, zones: 2, zoneLengthM: 1, newChain: true
  });
  d.merges = [{ id: "mg1", name: "MERGE1", mainSegmentId: "s2", offsetM: 1.0, spurEndSegmentId: "spur1", priority: "alternate" }];
  d.transfers = [
    { id: "t1", name: "PUSHER1", type: "pusher", segmentId: "s3", offsetM: 0.8, side: "right", extendTimeS: 0.8 },
    { id: "t2", name: "ROTARY1", type: "rotary_table", segmentId: "s3", offsetM: 1.5, stepDeg: 90, homeAngleDeg: 0 },
    { id: "t3", name: "POPUP1", type: "popup_transfer", segmentId: "s1", offsetM: 2.0, directions: ["left", "right"], beltCount: 3 }
  ];
  return d;
}
t("model: merge junction (spur feeds main line)", () => {
  const d = mergeTransferDesign();
  const c = conveyorModel.computeDesign(d);
  assert.equal(c.merges.length, 1);
  const mg = c.merges[0];
  assert.ok(mg.mergeZoneIndex1Based >= 1, "merge zone " + mg.mergeZoneIndex1Based);
  assert.ok(mg.spurZoneIndex1Based >= 1, "spur zone " + mg.spurZoneIndex1Based);
  assert.equal(mg.priority, "alternate");
  assert.ok(typeof mg.gapM === "number", "throat gap computed: " + mg.gapM);
  assert.ok(mg.gapM < 1.2, "spur ends near the merge point (gap " + mg.gapM + " m)");
  const v = conveyorModel.validateDesign(d);
  assert.ok(v.ok, "merge design valid: " + v.errors.join("; "));
  // missing spur / bad offset are errors
  const bad = JSON.parse(JSON.stringify(d));
  bad.merges[0].spurEndSegmentId = "nope";
  assert.ok(conveyorModel.validateDesign(bad).errors.length > 0, "missing spur rejected");
  const bad2 = JSON.parse(JSON.stringify(d));
  bad2.merges[0].offsetM = 999;
  assert.ok(conveyorModel.validateDesign(bad2).errors.length > 0, "out-of-range merge offset rejected");
});

t("model: pusher + rotary table + bidirectional pop-up transfer", () => {
  const d = mergeTransferDesign();
  const c = conveyorModel.computeDesign(d);
  assert.equal(c.transfers.length, 3);
  const byType = {};
  c.transfers.forEach(t => { byType[t.type] = t; });
  assert.ok(byType.pusher && !byType.pusher.bidirectional, "pusher is one-way");
  assert.deepEqual(byType.pusher.directions, ["right"]);
  assert.ok(byType.rotary_table && byType.rotary_table.bidirectional, "rotary table bidirectional");
  assert.equal(byType.rotary_table.rotary.stepDeg, 90);
  assert.ok(byType.popup_transfer && byType.popup_transfer.bidirectional, "popup bidirectional");
  assert.deepEqual(byType.popup_transfer.directions, ["left", "right"]);
  assert.equal(byType.popup_transfer.popup.beltCount, 3);
  // one device I/O block each, after the zone groups, IPs sequential
  const deviceBlocks = c.blocks.filter(b => !!b.deviceType);
  assert.equal(deviceBlocks.length, 3, "device blocks " + deviceBlocks.map(b => b.name).join(","));
  assert.ok(deviceBlocks.every(b => b.catalogNumber === conveyorModel.BLOCK_CATALOG));
  assert.equal(new Set(c.blocks.map(b => b.ip)).size, c.blocks.length, "unique IPs");
  assert.equal(c.totals.merges, 1);
  assert.equal(c.totals.transfers, 3);
  assert.equal(c.totals.pushers, 1);
  assert.equal(c.totals.rotaryTables, 1);
  assert.equal(c.totals.popupTransfers, 1);
  assert.equal(c.totals.bidirectionalTransfers, 2);
  assert.equal(c.totals.deviceBlocks, 3);
  // standard I/O bit maps
  assert.ok(conveyorModel.transferInputMap("pusher").some(i => i.name === "EXTENDED_SW"));
  assert.ok(conveyorModel.transferOutputMap("pusher").some(o => o.name === "EXTEND_SOL"));
  assert.ok(conveyorModel.transferInputMap("rotary_table").some(i => i.name === "POS_90_SW"));
  assert.ok(conveyorModel.transferOutputMap("rotary_table").some(o => o.name === "ROTATE_CCW"));
  assert.ok(conveyorModel.transferInputMap("popup_transfer").some(i => i.name === "LEFT_CLEAR"));
  assert.ok(conveyorModel.transferOutputMap("popup_transfer").some(o => o.name === "BELT_RIGHT"));
  // validation: unknown type and duplicate names are errors
  const bad = JSON.parse(JSON.stringify(d));
  bad.transfers[0].type = "turntable";
  assert.ok(conveyorModel.validateDesign(bad).errors.length > 0, "unknown transfer type rejected");
  const dup = JSON.parse(JSON.stringify(d));
  dup.transfers[1].name = dup.transfers[0].name;
  assert.ok(conveyorModel.validateDesign(dup).errors.length > 0, "duplicate transfer name rejected");
  // add/update/remove helpers
  let d2 = conveyorModel.addTransfer(d, { type: "popup_transfer" });
  assert.equal(d2.transfers.length, 4);
  d2 = conveyorModel.updateTransfer(d2, d2.transfers[3].id, { beltCount: 5 });
  assert.equal(d2.transfers[3].beltCount, 5);
  d2 = conveyorModel.removeTransfer(d2, d2.transfers[3].id);
  d2 = conveyorModel.addMerge(d2, {});
  assert.equal(d2.merges.length, 2);
  d2 = conveyorModel.removeMerge(d2, d2.merges[1].id);
  assert.equal(d2.merges.length, 1);
});

/* ---- components + BOM ---- */
let selections = null;
if (parts) {
  t("parts: component selection for demo", () => {
    const c = conveyorModel.computeDesign(demoDesign());
    selections = parts.selectComponents(demoDesign(), c, {});
    assert.ok(selections && selections.zones, "zones");
    assert.equal(selections.zones.length, 9, "one selection per zone");
    const withRoller = selections.zones.filter(z => z.rollerPn || z.rollerSeries);
    assert.ok(withRoller.length > 0, "rollers selected");
    const withCard = selections.zones.filter(z => z.driverCard);
    assert.ok(withCard.length > 0, "driver cards selected");
    console.log("     roller P/N e.g. " + (withRoller[0].rollerPn || withRoller[0].rollerSeries) +
      " · card e.g. " + (withCard[0].driverCard) +
      " · warnings " + (selections.warnings || []).length);
  });
  t("parts: BOM for demo", () => {
    const c = conveyorModel.computeDesign(demoDesign());
    const bom = parts.buildBom(demoDesign(), c, selections, {});
    assert.ok(bom.rows.length > 0, "rows");
    assert.ok(bom.totals && typeof bom.totals.grandTotal === "number", "totals");
    const total = bom.rows.reduce((a, r) => a + (r.extended || 0), 0);
    assert.ok(Math.abs(total - bom.totals.grandTotal) < 0.02, "totals add up: " + total + " vs " + bom.totals.grandTotal);
    const csv = parts.bomToCsv(bom.rows);
    assert.ok(csv.split("\n").length >= bom.rows.length, "csv lines");
    console.log("     BOM: " + bom.rows.length + " lines, grand total " + bom.totals.grandTotal.toFixed(2));
  });
}

/* ---- L5X generation ---- */
let generated = null;
if (gen) {
  t("l5x: program-mode generation", () => {
    const design = demoDesign();
    const c = conveyorModel.computeDesign(design);
    const res = gen.generateConveyorL5x(design, c, { mode: "program" });
    assert.ok(res && res.l5x && res.l5x.length > 1000, "L5X text");
    generated = res;
    const parsed = modelApi.parseL5X(res.l5x);
    assert.ok(parsed, "parses");
    const prog = parsed.programs.find(p => p.name === design.name);
    assert.ok(prog, "program " + design.name);
    assert.ok(prog.routines.length >= 3, "routines: " + prog.routines.length);
    const scans = prog.routines.filter(r => /ZONE_SCAN/i.test(r.name));
    assert.equal(scans.length, 3, "one scan routine per group: " + scans.map(r => r.name).join(","));
    assert.ok(parsed.dataTypes.length >= 3, "UDTs: " + parsed.dataTypes.length);
    assert.ok(parsed.tags.controller.length > 0, "tags");
    // ENET array dimension = groups*2
    const enet = parsed.tags.controller.find(t => t.name === "ENET_INPUTS");
    if (enet) assert.equal(enet.dimension, 6, "ENET_INPUTS dims = groups*2, got " + enet.dimension);
    // zone remapping: scans use their group slot (1..3), never zone ids 4..9
    const allScanText = scans.map(r => (r.content.rungs || []).map(x => x.text).join(" ")).join(" ");
    const zpaIdx = [...allScanText.matchAll(/ZPA\[(\d+)\]/g)].map(m => parseInt(m[1], 10));
    assert.ok(zpaIdx.length > 0, "scan routines reference ZPA");
    assert.ok(zpaIdx.every(i => i >= 1 && i <= 3), "scan ZPA indexes are group slots 1..3, got " + [...new Set(zpaIdx)].join(","));
    console.log("     program mode: " + prog.routines.length + " routines, " +
      scans.length + " group scans, " + parsed.dataTypes.length + " UDTs, " +
      parsed.tags.controller.length + " controller tags, " +
      Math.round(res.l5x.length / 1024) + " KB, warnings=" + (res.warnings || []).length);
  });
  t("l5x: generated program validates against the official schema", () => {
    const schema = JS("schema-validate.js");
    const parsed = modelApi.parseL5X(generated.l5x);
    const vr = schema.validateModel(parsed, {});
    assert.equal((vr.errors || []).length, 0,
      "schema errors: " + JSON.stringify((vr.errors || []).slice(0, 6)));
    console.log("     schema " + (vr.schemaVersion || "?") + ": 0 errors, " + (vr.warnings || []).length + " warnings");
  });
  t("l5x: controller-mode generation", () => {
    const design = demoDesign();
    const c = conveyorModel.computeDesign(design);
    const res = gen.generateConveyorL5x(design, c, { mode: "controller" });
    assert.ok(res.l5x.length > 2000, "controller L5X");
    const parsed = modelApi.parseL5X(res.l5x);
    assert.equal(parsed.modules.length, c.totals.groups + 1,
      "modules = groups + Local, got " + parsed.modules.length);
    assert.ok(parsed.tasks.length >= 1, "tasks");
    const schema = JS("schema-validate.js");
    const vr = schema.validateModel(parsed, {});
    assert.equal((vr.errors || []).length, 0,
      "schema errors: " + JSON.stringify((vr.errors || []).slice(0, 6)));
    console.log("     controller mode: " + parsed.modules.length + " modules, " +
      parsed.tasks.length + " tasks, " + Math.round(res.l5x.length / 1024) + " KB");
  });
  t("l5x: generated project opens in the app pipeline", () => {
    const c = conveyorModel.computeDesign(demoDesign());
    const res = gen.generateConveyorL5x(demoDesign(), c, { mode: "program" });
    const m = modelApi.parseL5X(res.l5x);
    const prog = m.programs[0];
    const routine = prog.routines.find(r => r.type === "RLL");
    assert.ok(routine, "generated RLL routine");
    // every generated routine parses to IR/dataflow cleanly
    for (const p of m.programs) {
      for (const r of p.routines) {
        const ir = modelApi.getRoutineIR(m, p.name, r.name);
        assert.ok(ir, "IR for " + r.name);
      }
    }
    console.log("     generated project: all routines parse to IR");
  });
}

/* ---- HMI generation ---- */
if (hmi) {
  t("hmi: self-contained HTML5 HMI", () => {
    const design = demoDesign();
    const c = conveyorModel.computeDesign(design);
    const html = hmi.generateHmiHtml(design, c, {});
    assert.ok(html.indexOf("<canvas") !== -1, "canvas");
    assert.ok(html.indexOf("SEG1_Z1") !== -1 || html.indexOf("SEG1") !== -1, "zone labels");
    assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org/g, "")), "no external URLs");
    assert.ok(html.length > 3000, "non-trivial");
    const csv = hmi.generateTagListCsv(design, c);
    const lines = csv.trim().split(/\r?\n/);
    assert.ok(lines.length >= 9, "tag rows for 9 zones: " + lines.length);
    const spec = hmi.generateGraphicsSpec(design, c);
    assert.ok(spec.length > 200, "graphics spec");
    console.log("     HMI: " + Math.round(html.length / 1024) + " KB, tag rows " + lines.length + ", spec " + Math.round(spec.length / 1024) + " KB");
  });
}

console.log("\nintegration3: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
