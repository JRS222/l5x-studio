/* L5X Studio - test/t6-conveyor-view.test.js (teammate "conveyor-2d3d").
   Tests for js/conveyor/designer2d.js and js/conveyor/render3d.js:
     - UMD/browser-global loading and Node-safe requires of both modules,
     - mat4 identity / multiply / transforms / perspective / lookAt / inverse,
     - buildConveyorGeometry part counts + array consistency for the default and a
       synthetic 2-segment design (straight + rotated) plus a curved segment,
     - 2D pure helpers: world<->screen, fitView, hitTestSegment / hitTestZone,
     - renderScene() against a strict recording stub (only the documented ctx methods),
     - ConveyorDesigner2D / Conveyor3D constructor + method Node-safety (no DOM).
   Run: node test/t6-conveyor-view.test.js   (exits non-zero on failure) */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const model = require(path.join(ROOT, "js", "conveyor", "model.js"));
const d2d = require(path.join(ROOT, "js", "conveyor", "designer2d.js"));
const r3d = require(path.join(ROOT, "js", "conveyor", "render3d.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) {
    fail++;
    const stack = e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : String(e);
    console.log("FAIL " + name + "\n     " + stack);
  }
}
function approx(actual, expected, eps, msg) {
  const e = eps === undefined ? 1e-9 : eps;
  assert.ok(Number.isFinite(actual), (msg || "") + ": not finite (" + actual + ")");
  assert.ok(Math.abs(actual - expected) <= e, (msg || "") + ": expected " + expected + " got " + actual);
}
function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }

/* ---------------------------------------------------------------- fixtures */

/* Model v2 chained design requested by the Lead:
   straight(3 m, 3 zones) + curve(90 deg, R1.75, 2 zones) + straight(30 deg angled joint)
   + spiral(up, pitch 0.8, height 2.4) + scan zone + tracking enabled. */
function syntheticDesign() {
  const d = model.createDefaultDesign();
  d.name = "SYNTH_CHAIN";
  d.conveyorType = "roller";
  d.segments = [
    { id: "s1", name: "SEG_A", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "s2", name: "SEG_B", kind: "curve", curveDeg: 90, radiusM: 1.75, turnDeg: 0, lengthM: 2.75, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "s3", name: "SEG_C", kind: "straight", turnDeg: 30, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "s4", name: "SEG_D", kind: "spiral", radiusM: 1.2, spiral: { pitchM: 0.8, heightM: 2.4, direction: "up" }, widthM: 0.6, zoneLengthM: 2.5, motorSeries: null, driverCard: null }
  ];
  d.scanZones = [{
    id: "scan1", name: "SCAN_ENTRY", segmentId: "s2", offsetM: 1.0,
    type: "barcode", side: "right", tagName: "ENTRY_BC"
  }];
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6, trayGapM: 0.3, tagPrefix: "TRACK" };
  return d;
}

/* Roller curve-only design (tapered rollers). */
function curveDesign() {
  const d = model.createDefaultDesign();
  d.name = "CURVE_ONE";
  d.segments = [{
    id: "c1", name: "CURVE1", kind: "curve", curveDeg: 90, radiusM: 1.75,
    x: 0, y: 0, rotationDeg: 0, lengthM: 2.75, widthM: 0.6, zones: 3, zoneLengthM: 1,
    motorSeries: null, driverCard: null
  }];
  return d;
}

/* Belt conveyor design: straight belt + inclined belt spiral (head/tail pulleys). */
function beltDesign() {
  const d = model.createDefaultDesign();
  d.name = "BELT_DEMO";
  d.conveyorType = "belt";
  d.segments = [
    { id: "b1", name: "BELT_A", kind: "straight", lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1 },
    { id: "b2", name: "BELT_B", kind: "spiral", radiusM: 1.2, spiral: { pitchM: 0.8, heightM: 1.6, direction: "up" }, widthM: 0.6, zones: 4, zoneLengthM: 2 }
  ];
  return d;
}

/* Model v3 design: main line (4 m/4 zones + curve + 3 m/3 zones) with a separate
   spur chain (newChain, 2 zones) merging in, plus one pusher, one rotary table and
   one cross-belt pop-up transfer (each gets an XFERxx device I/O block). */
function devicesDesign() {
  const d = model.createDefaultDesign();
  d.name = "SYNTH_DEVICES";
  d.conveyorType = "roller";
  d.segments = [
    { id: "m1", name: "MAIN_A", kind: "straight", newChain: true, x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0, lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1 },
    { id: "m2", name: "MAIN_B", kind: "curve", turnDeg: 0, curveDeg: 90, radiusM: 1.748, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "m3", name: "MAIN_C", kind: "straight", turnDeg: 0, lengthM: 3, widthM: 0.6, zones: 3, zoneLengthM: 1 },
    /* spur chain: starts 2.4 m below the main line, runs +Y and stops 0.4 m short */
    { id: "sp1", name: "SPUR", kind: "straight", newChain: true, x: 2.6, y: -2.4, z: 0, rotationDeg: 90, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  d.merges = [{
    id: "mg1", name: "MERGE1", mainSegmentId: "m1", spurEndSegmentId: "sp1",
    offsetM: 2.6, priority: "alternate"
  }];
  d.transfers = [
    { id: "x1", name: "PUSHER1", type: "pusher", segmentId: "m1", offsetM: 1.0, side: "right", extendTimeS: 0.8 },
    { id: "x2", name: "ROTARY1", type: "rotary_table", segmentId: "m1", offsetM: 3.2, stepDeg: 90, homeAngleDeg: 0 },
    { id: "x3", name: "POPUP1", type: "popup_transfer", segmentId: "m3", offsetM: 1.5, directions: ["left", "right"], beltCount: 3 }
  ];
  return d;
}

const defaultDesign = model.createDefaultDesign();
const computedDefault = model.computeDesign(defaultDesign);
const computedSynthetic = model.computeDesign(syntheticDesign());
const computedCurve = model.computeDesign(curveDesign());
const computedBelt = model.computeDesign(beltDesign());
const computedDevices = model.computeDesign(devicesDesign());

/* Expected roller count for the 3D builder (matches its formula exactly). */
function expectedRollers(computed, pitch) {
  const p = pitch || 0.1;
  return (computed.segments || []).reduce(function (acc, seg) {
    const isBelt = String(seg.conveyorType || computed.conveyorType || "roller").toLowerCase() === "belt";
    if (isBelt) return acc;
    return acc + Math.floor(num0(seg.lengthM) / p + 1e-6) + 1;
  }, 0);
}
function num0(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/* --------------------------------------------------- recording ctx stub */
/* Deliberately implements ONLY the canvas-2D methods listed in CONVEYOR.md so that the
   renderer's claimed "recording stub" compatibility is actually tested. */
function recordingCtx() {
  const calls = [];
  const ops = {};
  const ctx = { calls: calls, ops: ops };
  const methods = ["clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "fill",
    "arc", "save", "restore", "translate", "rotate", "setTransform", "fillText"];
  for (const m of methods) {
    ctx[m] = function () {
      const entry = { op: m, args: Array.prototype.slice.call(arguments) };
      calls.push(entry);
      (ops[m] = ops[m] || []).push(entry);
    };
  }
  const props = ["fillStyle", "strokeStyle", "lineWidth", "font", "textAlign", "textBaseline", "globalAlpha", "lineCap", "lineJoin"];
  for (const p of props) {
    let value;
    Object.defineProperty(ctx, p, {
      get: function () { return value; },
      set: function (v) {
        value = v;
        const entry = { op: "set:" + p, args: [v] };
        calls.push(entry);
        (ops["set:" + p] = ops["set:" + p] || []).push(entry);
      },
      enumerable: true, configurable: true
    });
  }
  return ctx;
}
function badNumericArgs(calls, onlyOps) {
  const bad = [];
  for (const c of calls) {
    if (onlyOps && onlyOps.indexOf(c.op) < 0) continue;
    for (const a of c.args) {
      if (typeof a === "number" && !Number.isFinite(a)) bad.push(c.op + "(" + c.args.join(",") + ")");
    }
  }
  return bad;
}
function colorsSet(ctx, prop) {
  return (ctx.ops["set:" + prop] || []).map(function (c) { return String(c.args[0]); });
}

/* ========================================================================= */
/* A. module exports / UMD browser-global loading                            */
/* ========================================================================= */

t("A1 designer2d exports the required API", () => {
  for (const k of ["ConveyorDesigner2D", "worldToScreen", "screenToWorld",
    "hitTestSegment", "hitTestZone", "renderScene"]) {
    assert.equal(typeof d2d[k], "function", "export " + k);
  }
  assert.equal(typeof d2d.fitView, "function", "export fitView");
  /* model v2 helpers used for rounded-edge/zone polygon tests */
  for (const k of ["segmentBodyPolygon", "zoneQuadPolygon", "pointInPolygon"]) {
    assert.equal(typeof d2d[k], "function", "export " + k);
  }
  /* model v3 merge/transfer pure geometry helpers */
  for (const k of ["mergeThroatGeometry", "transferSymbolGeometry", "roundedPolygon"]) {
    assert.equal(typeof d2d[k], "function", "export " + k);
  }
});

t("A2 render3d exports the required API", () => {
  for (const k of ["Conveyor3D", "buildConveyorGeometry"]) {
    assert.equal(typeof r3d[k], "function", "export " + k);
  }
  for (const k of ["mat4Identity", "mat4Multiply", "mat4Translate", "mat4RotateX",
    "mat4RotateY", "mat4Scale", "mat4Perspective", "mat4LookAt"]) {
    assert.equal(typeof r3d[k], "function", "export " + k);
  }
});

function loadBrowserGlobals() {
  const sandbox = { console: console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.root = sandbox;
  vm.createContext(sandbox);
  const files = ["js/conveyor/model.js", "js/conveyor/designer2d.js", "js/conveyor/render3d.js"];
  for (const rel of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  }
  return sandbox.L5XStudio;
}

t("A3 UMD browser-global path loads flat into L5XStudio namespace", () => {
  const L5X = loadBrowserGlobals();
  assert.ok(L5X, "browser L5XStudio namespace exists");
  assert.equal(typeof L5X.ConveyorDesigner2D, "function", "designer class on global");
  assert.equal(typeof L5X.Conveyor3D, "function", "3D class on global");
  assert.equal(typeof L5X.buildConveyorGeometry, "function", "geometry builder on global");
  assert.equal(typeof L5X.computeDesign, "function", "model is shared on global");
  const design = L5X.createDefaultDesign();
  const computed = L5X.computeDesign(design);
  assert.equal(computed.totals.zones, 4, "computed zones in browser sandbox");
  const seg = L5X.hitTestSegment(computed, { x: 2, y: 0 });
  assert.ok(seg && seg.id === "seg1", "browser hit-test uses shared model output");
  const geo = L5X.buildConveyorGeometry(computed, {});
  assert.ok(geo.counts.rollers > 10, "browser geometry builds");
  assert.equal(geo.counts.taperedRollers, 0, "model v2 counts include taperedRollers");
  const body = L5X.segmentBodyPolygon(computed.segments[0]);
  assert.equal(body.length, computed.segments[0].leftEdge.length + computed.segments[0].rightEdge.length,
    "rounded-edge body polygon from model v2 edges");
  const designer = new L5X.ConveyorDesigner2D({ container: null, design: design });
  assert.ok(Number.isFinite(designer.getView().scale), "headless designer (no DOM in sandbox)");
  const view = new L5X.Conveyor3D({ container: null, design: design });
  assert.equal(view.render(), false, "no WebGL in sandbox: render no-op");
});

/* ========================================================================= */
/* B. mat4 math                                                              */
/* ========================================================================= */

function xf(m, p) {
  const q = r3d.mat4TransformPoint(m, { x: p[0], y: p[1], z: p[2] });
  return [q.x, q.y, q.z, q.w];
}
function xfN(m, p) {
  const q = xf(m, p);
  return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
}

t("B1 mat4Identity layout", () => {
  assert.deepStrictEqual(r3d.mat4Identity(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

t("B2 identity is the multiply identity", () => {
  const I = r3d.mat4Identity();
  const M = r3d.mat4Multiply(r3d.mat4Translate(1, 2, 3), r3d.mat4RotateY(0.4));
  for (let i = 0; i < 16; i++) approx(r3d.mat4Multiply(I, M)[i], M[i], 1e-12, "I*M[" + i + "]");
  for (let i = 0; i < 16; i++) approx(r3d.mat4Multiply(M, I)[i], M[i], 1e-12, "M*I[" + i + "]");
});

t("B3 translate / scale / rotate transforms points correctly", () => {
  let q = xf(r3d.mat4Translate(1, 2, 3), [0, 0, 0]);
  assert.deepStrictEqual(q, [1, 2, 3, 1]);
  q = xf(r3d.mat4Translate(1, 2, 3), [1, 0, 0]);
  assert.deepStrictEqual(q, [2, 2, 3, 1]);
  q = xf(r3d.mat4Scale(2, 3, 4), [1, 2, 3]);
  assert.deepStrictEqual(q, [2, 6, 12, 1]);

  /* rotateX(+90deg): +Y -> +Z (right-handed) */
  q = xf(r3d.mat4RotateX(Math.PI / 2), [0, 1, 0]);
  approx(q[0], 0, 1e-12); approx(q[1], 0, 1e-12); approx(q[2], 1, 1e-12);
  /* rotateY(+90deg): +X -> -Z */
  q = xf(r3d.mat4RotateY(Math.PI / 2), [1, 0, 0]);
  approx(q[0], 0, 1e-12); approx(q[1], 0, 1e-12); approx(q[2], -1, 1e-12);
  /* composition applies the right-hand matrix first: T(1,2,3) * S(2,2,2) => 2p+offset */
  const TS = r3d.mat4Multiply(r3d.mat4Translate(1, 2, 3), r3d.mat4Scale(2, 2, 2));
  q = xf(TS, [1, 1, 1]);
  assert.deepStrictEqual(q, [3, 4, 5, 1]);
});

t("B4 mat4Perspective maps near/far planes to -1/+1 NDC", () => {
  const proj = r3d.mat4Perspective(Math.PI / 2, 1, 0.1, 100);
  let ndc = xfN(proj, [0, 0, -0.1]);
  approx(ndc[2], -1, 1e-6, "near z NDC");
  ndc = xfN(proj, [0, 0, -100]);
  approx(ndc[2], 1, 1e-6, "far z NDC");
  /* fov 90 deg / aspect 1: a point at x = |z| is exactly on the frustum edge */
  ndc = xfN(proj, [0.1, 0, -0.1]);
  approx(ndc[0], 1, 1e-9, "frustum edge x");
  ndc = xfN(proj, [-0.1, 0, -0.1]);
  approx(ndc[0], -1, 1e-9, "frustum edge -x");
});

t("B5 mat4LookAt puts the eye at the view-space origin", () => {
  const eye = { x: 0, y: 2, z: 5 }, center = { x: 0, y: 0, z: 0 }, up = { x: 0, y: 1, z: 0 };
  const view = r3d.mat4LookAt(eye, center, up);
  const pEye = xf(view, [eye.x, eye.y, eye.z]);
  approx(pEye[0], 0, 1e-9); approx(pEye[1], 0, 1e-9); approx(pEye[2], 0, 1e-9);
  const dist = Math.sqrt(29);
  const pCenter = xf(view, [0, 0, 0]);
  approx(pCenter[0], 0, 1e-9); approx(pCenter[1], 0, 1e-9); approx(pCenter[2], -dist, 1e-9);
  /* camera right = +X for this setup: the world centre + X unit lands 1 unit to the
     right of the view-space centre (same depth), so the rotation is not transposed */
  const pRight = xf(view, [1, 0, 0]);
  approx(pRight[0], 1, 1e-9); approx(pRight[1], 0, 1e-9); approx(pRight[2], -dist, 1e-9);
  const pUp = xf(view, [0, 1, 0]);
  assert.ok(pUp[1] > 0.9, "world +Y (camera up-ish) maps to positive view Y: " + pUp[1]);
  assert.ok(Math.abs(pUp[2]) > 0.1, "camera is pitched, so world +Y also moves in depth");
  /* degenerate eye==center must not produce NaN */
  const degenerate = r3d.mat4LookAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.ok(degenerate.every(Number.isFinite), "degenerate lookAt finite");
});

t("B6 mat4Inverse round-trips composed transforms", () => {
  const M = r3d.mat4Multiply(
    r3d.mat4Translate(1.5, -2, 3),
    r3d.mat4Multiply(r3d.mat4RotateY(0.7),
      r3d.mat4Multiply(r3d.mat4RotateX(-0.4), r3d.mat4Scale(2, 1, 0.5))));
  const inv = r3d.mat4Inverse(M);
  assert.ok(inv, "inverse exists");
  const I = r3d.mat4Multiply(M, inv);
  const expected = r3d.mat4Identity();
  for (let i = 0; i < 16; i++) approx(I[i], expected[i], 1e-9, "M*inv[" + i + "]");
  const p = [3, -1, 7];
  const round = xf(inv, xf(M, p).slice(0, 3));
  approx(round[0], p[0], 1e-9); approx(round[1], p[1], 1e-9); approx(round[2], p[2], 1e-9);
  assert.equal(r3d.mat4Inverse([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null, "singular -> null");
});

/* ========================================================================= */
/* C. geometry builder                                                       */
/* ========================================================================= */

function checkGeometryArrays(geo) {
  assert.equal(geo.positions.length, geo.normals.length, "positions/normals length");
  assert.equal(geo.positions.length, geo.colors.length, "positions/colors length");
  assert.equal(geo.positions.length % 3, 0, "positions are xyz triples");
  assert.ok(geo.positions.length > 0, "geometry is not empty");
  assert.equal(geo.indices.length % 3, 0, "indices are triangles");
  assert.ok(geo.indices.length > 0, "triangles present");
  const vertexCount = geo.positions.length / 3;
  for (const idx of geo.indices) {
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < vertexCount, "index in range: " + idx);
  }
  for (let i = 0; i < geo.positions.length; i++) assert.ok(Number.isFinite(geo.positions[i]), "position finite");
  for (let i = 0; i < geo.normals.length; i += 3) {
    const len = Math.hypot(geo.normals[i], geo.normals[i + 1], geo.normals[i + 2]);
    approx(len, 1, 1e-6, "unit normal at vertex " + i / 3);
  }
  for (let i = 0; i < geo.colors.length; i++) {
    assert.ok(geo.colors[i] >= 0 && geo.colors[i] <= 1, "colour component in 0..1: " + geo.colors[i]);
  }
  const b = geo.bounds;
  for (const k of ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"]) {
    assert.ok(Number.isFinite(b[k]), "bounds " + k + " finite");
  }
  assert.ok(b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ, "bounds ordered");
}

t("C1 default design geometry counts (one 4-zone 4 m segment)", () => {
  const geo = r3d.buildConveyorGeometry(computedDefault, { rollerPitchM: 0.1 });
  checkGeometryArrays(geo);
  assert.equal(geo.counts.segments, 1, "segments");
  assert.equal(geo.counts.rails, 2, "2 rails per segment");
  assert.equal(geo.counts.panels, 4, "one floor panel per zone");
  assert.equal(geo.counts.sensors, 4, "sensor per zone");
  assert.equal(geo.counts.motors, 4, "motor per zone");
  assert.equal(geo.counts.taperedRollers, 0, "straight roller bed is cylindrical");
  assert.equal(geo.counts.pulleys, 0, "no pulleys on a roller conveyor");
  assert.equal(geo.counts.scanners, 0, "no scan stations in the default design");
  assert.ok(geo.counts.legs >= 2 * geo.counts.segments, "legs >= 2 per segment");
  const expectedRollers = Math.ceil(4 / 0.1) + 1; // => 41
  assert.ok(Math.abs(geo.counts.rollers - expectedRollers) <= 1,
    "rollers ~ ceil(length/pitch)+1, got " + geo.counts.rollers);
  assert.equal(geo.counts.rollers, 41, "exact roller count for 4 m / 0.1 m");
  /* bounds: along +X, strip centred on Z=0, legs below the deck, sensors above */
  approx(geo.bounds.minX, -0.035, 0.01, "roller caps at x=0");
  approx(geo.bounds.maxX, 4.035, 0.01, "roller caps at x=4");
  assert.ok(geo.bounds.minY < -0.3, "legs extend below the rails");
  assert.ok(geo.bounds.maxY > 0.1, "sensors/motors above the deck");
  approx(geo.bounds.minZ, -(0.3 + 0.05), 0.06, "rail/roller side extent");
  approx(geo.bounds.maxY - geo.bounds.minY, 0.365 + 0.65, 0.1, "deck+legs vertical extent");
});

t("C2 synthetic chained design geometry counts (straight+curve+straight+spiral)", () => {
  const geo = r3d.buildConveyorGeometry(computedSynthetic, { rollerPitchM: 0.1, legSpacingM: 1.5 });
  checkGeometryArrays(geo);
  assert.equal(geo.counts.segments, 4, "4 chained segments");
  assert.equal(geo.counts.rails, 8, "2 rails per segment");
  assert.equal(geo.counts.panels, computedSynthetic.zones.length, "one zone panel per zone");
  assert.equal(geo.counts.panels, 16, "3+2+2+9 zones");
  assert.equal(geo.counts.sensors, 16, "sensor per zone");
  assert.equal(geo.counts.motors, 16, "motor per roller zone");
  assert.equal(geo.counts.rollers, expectedRollers(computedSynthetic, 0.1),
    "rollers = sum(floor(3D length/pitch)+1), got " + geo.counts.rollers);
  assert.ok(geo.counts.rollers > 300, "4 segments / ~30.5 m => >300 rollers");
  const straightRollers = expectedRollers({ segments: [computedSynthetic.segments[0]] }, 0.1) +
    expectedRollers({ segments: [computedSynthetic.segments[2]] }, 0.1);
  assert.equal(geo.counts.taperedRollers, geo.counts.rollers - straightRollers,
    "curve + spiral rollers are tapered, straight runs cylindrical");
  assert.equal(geo.counts.scanners, 1, "one scanner device from scannedZones");
  assert.equal(geo.counts.joints, 1, "one angled joint side plate (30 deg joint)");
  assert.equal(geo.counts.beltSegments, 0, "roller design");
  assert.ok(geo.counts.legs >= 2 * geo.counts.segments, "legs >= 2 per segment");
  /* plan extents from the chained model bounds */
  assert.ok(geo.bounds.maxX > 4.5, "chain extends along +X");
  assert.ok(geo.bounds.maxZ > 3.5, "chain extends along +Z (plan y)");
});

t("C3 rollerPitch / legSpacing options change the part counts", () => {
  const coarse = r3d.buildConveyorGeometry(computedDefault, { rollerPitchM: 0.2 });
  assert.equal(coarse.counts.rollers, 21, "4 m / 0.2 m => 21 rollers");
  const dense = r3d.buildConveyorGeometry(computedDefault, { rollerPitchM: 0.05 });
  assert.ok(dense.counts.rollers > coarse.counts.rollers, "smaller pitch => more rollers");
  const sparseLegs = r3d.buildConveyorGeometry(computedDefault, { legSpacingM: 5 });
  assert.equal(sparseLegs.counts.legs, 4, "min 2 stations x 2 legs");
  assert.ok(dense.positions.length > coarse.positions.length, "vertex count grows with rollers");
});

t("C4 curve segment geometry: tapered rollers (truncated cones)", () => {
  assert.equal(computedCurve.zones[0].curved, true, "model marks curve zones curved");
  assert.equal(computedCurve.zones[0].rollerType, "tapered", "and tapered");
  const geo = r3d.buildConveyorGeometry(computedCurve, { rollerPitchM: 0.1 });
  checkGeometryArrays(geo);
  assert.equal(geo.counts.segments, 1);
  assert.equal(geo.counts.rails, 2);
  assert.equal(geo.counts.panels, 3, "curve zone panels follow the polyline");
  assert.equal(geo.counts.sensors, 3);
  assert.equal(geo.counts.motors, 3);
  assert.ok(geo.counts.rollers > 20, "rollers along the arc");
  assert.equal(geo.counts.taperedRollers, geo.counts.rollers, "every curve roller is tapered");
  assert.ok(geo.counts.taperedRollers > 0, "tapered roller geometry present");

  /* tapered rollers really are wider than cylindrical ones: the largest roller radius
     at deck level on the curve = baseRadius + taperDelta/2 (taper.deltaM from the model).
     Filter the y band to the roller tops (sensor boxes start at 0.315, motors at 0.19). */
  function rollerBandMaxY(g) {
    let maxY = -Infinity;
    for (let i = 1; i < g.positions.length; i += 3) {
      const y = g.positions[i];
      if (y > 0.195 && y < 0.30) maxY = Math.max(maxY, y);
    }
    return maxY;
  }
  const straightMax = rollerBandMaxY(r3d.buildConveyorGeometry(computedDefault, { rollerPitchM: 0.1 }));
  const curveMax = rollerBandMaxY(geo);
  assert.ok(curveMax > straightMax + 0.002,
    "tapered roller radius grows across the face: curve " + curveMax.toFixed(4) + " vs straight " + straightMax.toFixed(4));
});

t("C5 empty computed design yields empty but well-formed geometry", () => {
  const geo = r3d.buildConveyorGeometry({ segments: [], zones: [] }, {});
  assert.equal(geo.positions.length, 0);
  assert.equal(geo.indices.length, 0);
  assert.deepStrictEqual(geo.counts, {
    segments: 0, rails: 0, rollers: 0, taperedRollers: 0, legs: 0,
    sensors: 0, motors: 0, panels: 0, pulleys: 0, beltSegments: 0,
    scanners: 0, joints: 0,
    merges: 0, mergeRailLinks: 0,
    transfers: 0, pushers: 0, rotaryTables: 0, popupTransfers: 0,
    popupBelts: 0, deviceMarkers: 0
  });
  assert.ok(Number.isFinite(geo.bounds.minX) && Number.isFinite(geo.bounds.maxZ), "bounds stay finite");
});

t("C6 unique zone panel colours are present", () => {
  const geo = r3d.buildConveyorGeometry(computedSynthetic, {});
  const seen = new Set();
  for (let i = 0; i < geo.colors.length; i += 3) {
    seen.add(geo.colors[i].toFixed(3) + "," + geo.colors[i + 1].toFixed(3) + "," + geo.colors[i + 2].toFixed(3));
  }
  assert.ok(seen.size >= 8, "at least 7 zone colours + part colours, got " + seen.size);
});

t("C7 spiral segment: 3D helix points and elevated geometry", () => {
  const spiral = computedSynthetic.segments[3];
  assert.equal(spiral.kind, "spiral");
  assert.ok(spiral.polyline.length > 30, "helix is sampled");
  const zs = spiral.polyline.map(function (p) { return p.z; });
  approx(zs[0], 0, 1e-9, "spiral starts at deck level");
  approx(zs[zs.length - 1], 2.4, 1e-6, "spiral rises 2.4 m");
  for (let i = 1; i < zs.length; i++) {
    assert.ok(zs[i] >= zs[i - 1] - 1e-9, "spiral z is monotonic (up direction)");
  }
  const geo = r3d.buildConveyorGeometry(computedSynthetic, { rollerPitchM: 0.1 });
  assert.ok(geo.bounds.maxY >= 2.4, "3D geometry reaches the spiral height: " + geo.bounds.maxY);
  let elevated = 0;
  for (let i = 1; i < geo.positions.length; i += 3) if (geo.positions[i] > 2.0) elevated++;
  assert.ok(elevated > 100, "many 3D vertices are on the elevated helix: " + elevated);
  /* a down spiral design must run the other way */
  const down = model.createDefaultDesign();
  down.segments = [{
    id: "d1", name: "DOWN", kind: "spiral", radiusM: 1.2,
    spiral: { pitchM: 0.8, heightM: 1.6, direction: "down" }, widthM: 0.6, zoneLengthM: 2
  }];
  const downComputed = model.computeDesign(down);
  approx(downComputed.segments[0].zEnd, -1.6, 1e-6, "down spiral descends");
  const downGeo = r3d.buildConveyorGeometry(downComputed, {});
  assert.ok(downGeo.bounds.minY < -0.7, "down spiral geometry descends below the deck");
});

t("C8 belt conveyor geometry: continuous band + pulleys + no rollers", () => {
  const geo = r3d.buildConveyorGeometry(computedBelt, { rollerPitchM: 0.1, pulleyDiameterM: 0.12 });
  checkGeometryArrays(geo);
  assert.equal(geo.counts.beltSegments, 2, "all belt segments rendered as belts");
  assert.equal(geo.counts.rollers, 0, "belt conveyors have no roller bed");
  assert.equal(geo.counts.taperedRollers, 0, "no tapered rollers on a belt");
  assert.equal(geo.counts.pulleys, 4, "head + tail pulley per belt segment");
  assert.equal(geo.counts.motors, 2, "head drive box per belt segment");
  assert.equal(geo.counts.panels, computedBelt.zones.length, "zone decals on the belt");
  assert.equal(geo.counts.joints, 0, "no angled joints in this belt design");
  assert.ok(geo.positions.length > 3000, "belt band/rails/legs produce geometry");
  assert.ok(geo.bounds.maxY >= 1.6, "inclined belt rises: " + geo.bounds.maxY);
  assert.ok(geo.bounds.minY < 0, "belt legs go down to the floor");
});

t("C9 scanner device geometry at scannedZones", () => {
  const scan = computedSynthetic.scannedZones[0];
  const geo = r3d.buildConveyorGeometry(computedSynthetic, {});
  assert.equal(geo.counts.scanners, 1, "one scanner box");
  /* scanner sits beside the belt at the scan position, elevated above the deck */
  let found = false;
  for (let i = 0; i < geo.positions.length; i += 3) {
    const x = geo.positions[i], y = geo.positions[i + 1], z = geo.positions[i + 2];
    if (Math.abs(x - scan.x) < 0.7 && Math.abs(z - scan.y) < 0.7 && y > 0.2 && y < 0.5) { found = true; break; }
  }
  assert.ok(found, "scanner device vertices near the scanned zone position");
});

t("C10 model v3 devices: 3D merge throat + transfer geometry counts", () => {
  assert.equal(computedDevices.merges.length, 1, "one merge junction");
  assert.equal(computedDevices.transfers.length, 3, "three transfer devices");
  const geo = r3d.buildConveyorGeometry(computedDevices, { rollerPitchM: 0.1 });
  checkGeometryArrays(geo);
  assert.equal(geo.counts.segments, 4, "3 main-chain + 1 spur-chain segments");
  assert.equal(geo.counts.rails, 8, "2 rails per segment (incl. spur)");
  assert.equal(geo.counts.panels, 11, "4+2+3 main zones + 2 spur zones");
  assert.equal(geo.counts.rollers, expectedRollers(computedDevices, 0.1), "roller bed for all segments");
  assert.equal(geo.counts.taperedRollers, expectedRollers({ segments: [computedDevices.segments[1]] }, 0.1),
    "curve rollers are tapered");
  assert.equal(geo.counts.merges, 1, "one merge throat plate");
  assert.equal(geo.counts.mergeRailLinks, 2, "two spur rail links joining the main rails");
  assert.equal(geo.counts.transfers, 3, "three transfer assemblies");
  assert.equal(geo.counts.pushers, 1, "one pusher");
  assert.equal(geo.counts.rotaryTables, 1, "one rotary table");
  assert.equal(geo.counts.popupTransfers, 1, "one pop-up transfer");
  assert.equal(geo.counts.popupBelts, 3, "pop-up beltCount=3 cross belts");
  assert.equal(geo.counts.deviceMarkers, 3, "one I/O marker per device block");
  /* spur chain is included in the geometry bounds (plan Z in 3D) */
  assert.ok(geo.bounds.minZ < -2.0, "spur chain extends the 3D bounds: " + geo.bounds.minZ);
  assert.ok(geo.bounds.maxX > 5.5, "main chain extends along 3D X");
});

t("C11 model v3 devices: merge throat + devices sit near the model positions", () => {
  const merge = computedDevices.merges[0];
  const geo = r3d.buildConveyorGeometry(computedDevices, {});
  /* merge throat plate (deck-level slab) near the merge point */
  let nearMerge = 0;
  for (let i = 0; i < geo.positions.length; i += 3) {
    const x = geo.positions[i], y = geo.positions[i + 1], z = geo.positions[i + 2];
    if (Math.abs(x - merge.x) < 0.6 && Math.abs(z - merge.y) < 0.6 && y > 0 && y < 0.3) nearMerge++;
  }
  assert.ok(nearMerge > 10, "merge throat plate vertices at the merge point: " + nearMerge);
  /* rotary platform disc near the rotary transfer centre */
  const rotary = computedDevices.transfers[1];
  let nearRotary = 0;
  for (let i = 0; i < geo.positions.length; i += 3) {
    const x = geo.positions[i], y = geo.positions[i + 1], z = geo.positions[i + 2];
    if (Math.abs(x - rotary.x) < 0.7 && Math.abs(z - rotary.y) < 0.7 && y > 0.05 && y < 0.25) nearRotary++;
  }
  assert.ok(nearRotary > 50, "rotary table platform vertices near its centre: " + nearRotary);
  /* warning throat plate geometry builds without throwing when the gap is large */
  const warned = JSON.parse(JSON.stringify(computedDevices));
  warned.merges[0].gapM = 1.5;
  const warnGeo = r3d.buildConveyorGeometry(warned, {});
  assert.equal(warnGeo.counts.merges, 1, "warning throat plate still built");
  checkGeometryArrays(warnGeo);
});

/* ========================================================================= */
/* D. 2D pure helpers: view / fit / hit testing                              */
/* ========================================================================= */

t("D1 worldToScreen / screenToWorld are inverse and handle aliases", () => {
  const view = { scale: 120, offsetX: -40, offsetY: 35 };
  const s = d2d.worldToScreen(view, { x: 1.5, y: -0.25 });
  approx(s.x, 1.5 * 120 - 40, 1e-12);
  approx(s.y, -0.25 * 120 + 35, 1e-12);
  const back = d2d.screenToWorld(view, s);
  approx(back.x, 1.5, 1e-12);
  approx(back.y, -0.25, 1e-12);
  /* array points + offset-object view shape are accepted */
  const s2 = d2d.worldToScreen({ scale: 10, offset: { x: 5, y: 7 } }, [1, 2]);
  assert.deepStrictEqual(s2, { x: 15, y: 27 });
  /* broken views degrade to scale 1 instead of NaN */
  const safe = d2d.worldToScreen({ scale: 0, offsetX: "x", offsetY: null }, { x: 3, y: 4 });
  assert.deepStrictEqual(safe, { x: 3, y: 4 });
});

t("D2 fitView centres the design and gives a sane scale", () => {
  const view = d2d.fitView(computedDefault, 900, 600);
  assert.ok(view.scale > 10, "scale positive and usable: " + view.scale);
  const cPt = d2d.worldToScreen(view, { x: 2, y: 0 }); // centre of the default 4 m segment
  approx(cPt.x, 450, 1, "design centre x");
  approx(cPt.y, 300, 1, "design centre y");
  const view2 = d2d.fitView(computedSynthetic, 1000, 400, 20);
  assert.ok(view2.scale > 0 && Number.isFinite(view2.offsetX) && Number.isFinite(view2.offsetY));
  const b = computedSynthetic.bounds;
  const c2 = d2d.worldToScreen(view2, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  approx(c2.x, 500, 1, "synthetic chain centre x");
  approx(c2.y, 200, 1, "synthetic chain centre y");
  const view3 = d2d.fitView(computedBelt, 800, 600, 30);
  assert.ok(view3.scale > 0 && Number.isFinite(view3.offsetX), "belt design (elevated) fits");
  const empty = d2d.fitView({ segments: [] }, 500, 500);
  assert.ok(Number.isFinite(empty.scale) && empty.scale > 0, "empty fitView finite");
});

t("D3 hitTestSegment: default design", () => {
  assert.equal(d2d.hitTestSegment(computedDefault, { x: 2, y: 0 }).id, "seg1", "centre hit");
  assert.equal(d2d.hitTestSegment(computedDefault, { x: 0.1, y: 0.29 }).id, "seg1", "inside half width");
  assert.equal(d2d.hitTestSegment(computedDefault, { x: 2, y: 0.31 }), null, "outside half width");
  assert.equal(d2d.hitTestSegment(computedDefault, { x: 2, y: 0.34 }, { tolerance: 0.05 }).id, "seg1", "tolerance hit");
  assert.equal(d2d.hitTestSegment(computedDefault, { x: 99, y: 99 }), null, "far away is null");
  assert.equal(d2d.hitTestSegment({ segments: [] }, { x: 0, y: 0 }), null, "empty computed");
});

t("D4 hitTestZone: default design zone mapping", () => {
  assert.equal(d2d.hitTestZone(computedDefault, { x: 0.5, y: 0 }).index, 0, "zone 0");
  assert.equal(d2d.hitTestZone(computedDefault, { x: 1.2, y: 0 }).index, 1, "zone 1");
  assert.equal(d2d.hitTestZone(computedDefault, { x: 2.5, y: 0 }).index, 2, "zone 2");
  assert.equal(d2d.hitTestZone(computedDefault, { x: 3.99, y: 0 }).index, 3, "zone 3");
  assert.equal(d2d.hitTestZone(computedDefault, { x: 2.5, y: 2 }), null, "off conveyor");
  /* tolerance reaches just past the strip end, then the centreline fallback clamps */
  assert.equal(d2d.hitTestZone(computedDefault, { x: 4.5, y: 0 }, { tolerance: 0.6 }).index, 3,
    "tolerance + clamped t yields the last zone");
});

t("D5 hit testing synthetic chained design (straight/curve/straight/spiral)", () => {
  /* straight A: 3 m / 3 zones */
  const seg1 = d2d.hitTestSegment(computedSynthetic, { x: 1.5, y: 0 });
  assert.equal(seg1.id, "s1");
  const zone1 = d2d.hitTestZone(computedSynthetic, { x: 1.5, y: 0 });
  assert.equal(zone1.segmentId, "s1");
  assert.equal(zone1.zoneInSegment, 1, "second of 3 zones");
  assert.equal(zone1.index, 1, "global 0-based zone index");

  /* curve B (R1.75, 90 deg): point at 30 deg around the arc */
  const seg2 = d2d.hitTestSegment(computedSynthetic, { x: 3.875, y: 0.2345 });
  assert.equal(seg2.id, "s2", "curve body hit");
  const zone2 = d2d.hitTestZone(computedSynthetic, { x: 3.875, y: 0.2345 });
  assert.equal(zone2.segmentId, "s2");
  assert.equal(zone2.curved, true, "curve zone marked curved");
  assert.equal(zone2.rollerType, "tapered", "curve zone uses tapered rollers");

  /* straight C after the 30 deg angled joint (heading 120 deg) */
  const seg3 = d2d.hitTestSegment(computedSynthetic, { x: 4.5, y: 2.183 });
  assert.equal(seg3.id, "s3");
  assert.equal(d2d.hitTestZone(computedSynthetic, { x: 4.5, y: 2.183 }).segmentId, "s3");

  /* spiral D starts at the end of C; last segment wins at the shared joint vertex */
  const seg4 = d2d.hitTestSegment(computedSynthetic, { x: 3.75, y: 3.4821 });
  assert.equal(seg4.id, "s4", "spiral is the last chain segment");
  assert.equal(d2d.hitTestSegment(computedSynthetic, { x: 99, y: 99 }), null, "far away is null");
  assert.equal(d2d.hitTestZone(computedSynthetic, { x: 3.875, y: 0.2345 }, { tolerance: 0.05 }).segmentId,
    "s2", "tolerance hit inside the curve");
});

t("D6 hitTestSegment: chain segments meet at rounded joints (last drawn wins)", () => {
  const chain = model.createDefaultDesign();
  chain.segments = [
    { id: "a", name: "A", kind: "straight", x: 0, y: 0, rotationDeg: 0, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 },
    { id: "b", name: "B", kind: "straight", turnDeg: 90, lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1 }
  ];
  const c = model.computeDesign(chain);
  assert.equal(c.segments[1].start.x, c.segments[0].end.x, "chained: B starts at A end");
  assert.equal(c.joints.length, 1, "one rounded joint");
  assert.equal(c.joints[0].rounded, true);
  const hit = d2d.hitTestSegment(c, { x: 2, y: 0 });
  assert.equal(hit.id, "b", "last segment is on top at the shared joint");
});

t("D7 rounded-edge body / zone quad pure helpers", () => {
  const seg = computedSynthetic.segments[1]; // curve with rounded joins
  const body = d2d.segmentBodyPolygon(seg);
  assert.equal(body.length, seg.leftEdge.length + seg.rightEdge.length,
    "body polygon = leftEdge forward + rightEdge backward");
  assert.ok(body.length > 40, "rounded-join curve edges are densely sampled: " + body.length);
  assert.ok(seg.leftEdge.length > 20, "model curve edges carry the rounded radius");
  const flat = body.every(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); });
  assert.ok(flat, "body polygon points finite");
  const zone = computedSynthetic.zones[0];
  const quad = d2d.zoneQuadPolygon(zone);
  assert.equal(quad.length, 4, "zone quad has 4 corners");
  assert.ok(d2d.pointInPolygon({ x: zone.x, y: zone.y }, quad), "zone centre is inside its quad");
  assert.ok(!d2d.pointInPolygon({ x: zone.x + 5, y: zone.y }, quad), "far point is outside the quad");
  /* body polygon hit test covers the rounded outer edge of the angled joint */
  const joint = computedSynthetic.joints[1]; // 30 deg joint on s3
  assert.ok(Math.abs(joint.turnDeg - 30) < 1e-9, "joint record carries the turn angle");
  const nearJoint = d2d.hitTestSegment(computedSynthetic, { x: joint.point.x, y: joint.point.y });
  assert.ok(nearJoint && (nearJoint.id === "s3" || nearJoint.id === "s2"), "joint point hits a chained segment");
});

t("D8 model v3 merge junction: throat polygon + gap from the model", () => {
  const merge = computedDevices.merges[0];
  const geo = d2d.mergeThroatGeometry(computedDevices, merge);
  assert.ok(geo, "merge throat geometry exists");
  assert.ok(geo.polygon.length >= 8, "rounded throat polygon has sampled corners: " + geo.polygon.length);
  assert.ok(geo.polygon.every(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); }),
    "throat polygon points finite");
  approx(geo.measuredGapM, merge.gapM, 1e-6, "gap from spur end to merge point matches the model");
  approx(geo.measuredGapM, 0.4, 0.02, "spur ends 0.4 m short of the merge point");
  approx(geo.spurEnd.x, 2.6, 1e-3, "spur end x");
  approx(geo.spurEnd.y, -0.4, 1e-3, "spur end y");
  approx(geo.mergePoint.x, 2.6, 1e-3, "merge point x");
  approx(geo.mergePoint.y, 0, 1e-3, "merge point on the main centreline");
  assert.equal(geo.warning, false, "small gaps need no throat plate");
  assert.equal(geo.mergeBlockName, merge.mergeBlockName, "merge block name passed through");
  assert.ok(geo.labels.indexOf("MERGE1") >= 0, "MERGE label");
  /* the throat polygon covers the gap between spur end and merge point */
  const mid = { x: (geo.spurEnd.x + geo.mergePoint.x) / 2, y: (geo.spurEnd.y + geo.mergePoint.y) / 2 };
  assert.ok(d2d.pointInPolygon(mid, geo.polygon), "throat polygon spans the gap");
  /* flow arrow points along the spur direction toward the main line */
  assert.ok(geo.flowArrow.to.y > geo.flowArrow.from.y, "spur flow arrow points +Y toward the main");
  /* a >1 m gap switches to the throat-plate warning */
  const warningGeo = d2d.mergeThroatGeometry(computedDevices,
    Object.assign({}, merge, { gapM: 1.5 }));
  assert.equal(warningGeo.warning, true, "gap > 1 m warns");
  assert.ok(warningGeo.labels.some(function (s) { return s.indexOf("THROAT PLATE") >= 0; }),
    "throat plate badge text");
  assert.ok(warningGeo.labels.some(function (s) { return s.indexOf("1.50") >= 0; }), "gap distance in badge");
});

t("D9 model v3 transfer symbols: pusher / rotary / pop-up geometry", () => {
  const pusher = computedDevices.transfers[0];
  const rotary = computedDevices.transfers[1];
  const popup = computedDevices.transfers[2];

  const p = d2d.transferSymbolGeometry(computedDevices, pusher);
  assert.equal(p.kind, "pusher");
  assert.equal(p.polygon.length, 4, "pusher cylinder body rectangle");
  assert.ok(p.piston && p.plate, "pusher has piston + plate");
  assert.ok(p.arrows.length === 1 && !p.bidirectional, "pusher is one-way");
  /* piston extends perpendicular to the conveyor flow */
  const pv = { x: p.piston.to.x - p.piston.from.x, y: p.piston.to.y - p.piston.from.y };
  const dot = pv.x * p.tangent.x + pv.y * p.tangent.y;
  approx(dot, 0, 1e-9, "piston is perpendicular to flow");
  assert.ok(p.labels.indexOf("PUSHER") >= 0, "PUSHER label");
  assert.equal(p.blockName, pusher.ioBlock, "I/O block name");
  assert.ok(p.blockLabel.indexOf(pusher.ioBlock) >= 0 && p.blockLabel.indexOf("Z" + pusher.zoneIndex1Based) >= 0,
    "block label shows block + zone: " + p.blockLabel);

  const r = d2d.transferSymbolGeometry(computedDevices, rotary);
  assert.equal(r.kind, "rotary_table");
  assert.ok(r.radius > 0 && r.circle, "rotary disc geometry");
  assert.equal(r.arcs.length, 2, "two rotation arcs");
  assert.deepStrictEqual(r.arcs.map(function (a) { return a.dirSign; }).sort(), [-1, 1],
    "rotation arcs are bidirectional");
  assert.ok(r.labels.some(function (s) { return s.indexOf("ROTARY") >= 0 && s.indexOf("90") >= 0; }),
    "rotary step-degrees label");
  assert.equal(r.bidirectional, true);
  assert.equal(r.blockName, rotary.ioBlock);

  const u = d2d.transferSymbolGeometry(computedDevices, popup);
  assert.equal(u.kind, "popup_transfer");
  assert.equal(u.polygon.length, 4, "pop-up platform rectangle");
  assert.equal(u.belts.length, 3, "beltCount cross-belt lines");
  assert.equal(u.arrows.length, 2, "bidirectional transfer arrows");
  assert.deepStrictEqual(u.arrows.map(function (a) { return a.dirSign; }).sort(), [-1, 1],
    "arrows point both ways");
  assert.ok(u.labels.some(function (s) { return s.indexOf("POP-UP") >= 0; }), "POP-UP label");
  assert.equal(u.blockName, popup.ioBlock);
  /* belt lines run across the conveyor width (perpendicular to flow) */
  const bv = { x: u.belts[0].b.x - u.belts[0].a.x, y: u.belts[0].b.y - u.belts[0].a.y };
  approx(bv.x * u.tangent.x + bv.y * u.tangent.y, 0, 1e-9, "cross belts run across the belt");
});

t("D10 model v3 multi-chain: spur chain included in bounds/fitView/hit-testing", () => {
  assert.equal(devicesDesign().segments[3].newChain, true, "spur starts its own chain");
  assert.equal(computedDevices.segments.length, 4, "all segments (main + spur) are computed");
  assert.equal(computedDevices.joints.length, 2, "joints only between chained main segments");
  assert.ok(computedDevices.bounds.minY < -2.0, "computed bounds include the spur chain");
  const view = d2d.fitView(computedDevices, 1200, 900);
  const spurStart = d2d.worldToScreen(view, { x: 2.6, y: -2.4 });
  assert.ok(spurStart.x > 0 && spurStart.x < 1200 && spurStart.y > 0 && spurStart.y < 900,
    "fitView frames the spur chain");
  assert.equal(d2d.hitTestSegment(computedDevices, { x: 2.6, y: -2.4 }).id, "sp1",
    "spur chain is hit-testable");
  assert.equal(d2d.hitTestSegment(computedDevices, { x: 1.5, y: 0 }).id, "m1", "main chain still hit-testable");
});

/* ========================================================================= */
/* E. renderScene against a recording stub                                   */
/* ========================================================================= */

t("E1 renderScene draws the default design without throwing", () => {
  const ctx = recordingCtx();
  const res = d2d.renderScene(ctx, computedDefault, { width: 800, height: 600 });
  assert.ok(res && res.segments === 1 && res.zones === 4, "returns summary");
  assert.ok(ctx.calls.length > 50, "recorded plenty of calls: " + ctx.calls.length);

  assert.ok(ctx.ops.clearRect, "clearRect called");
  assert.deepStrictEqual(ctx.ops.clearRect[0].args, [0, 0, 800, 600], "clears whole canvas");
  assert.ok(ctx.ops.fillRect, "fillRect called (background / motors)");
  assert.ok(ctx.ops.fill, "fill called (strips / markers)");
  assert.ok(ctx.ops.stroke, "stroke called (rails / grid / dividers)");
  assert.ok(ctx.ops.beginPath, "beginPath called");
  assert.ok(ctx.ops.arc, "arc called (sensor dots)");
  assert.ok(ctx.ops.fillText.length >= 5, "zone + segment + scale labels drawn: " + ctx.ops.fillText.length);
  assert.ok(ctx.ops.save.length > 0 && ctx.ops.save.length === ctx.ops.restore.length, "save/restore balanced");
  assert.ok(ctx.ops.translate.length > 0 && ctx.ops.rotate.length > 0, "motor markers use translate/rotate");

  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  for (const want of ["Z1", "Z2", "Z3", "Z4"]) assert.ok(labels.indexOf(want) >= 0, "zone label " + want);
  assert.ok(labels.some(function (s) { return s.indexOf("SEG1") >= 0; }), "segment name label");

  const bad = badNumericArgs(ctx.calls);
  assert.deepStrictEqual(bad, [], "no NaN/Infinity coordinates");
  const fills = colorsSet(ctx, "fillStyle");
  assert.ok(fills.length > 0 && fills.every(function (s) { return s.length > 0; }), "fillStyle values set");
});

t("E2 renderScene with selection / HUD options", () => {
  const ctx = recordingCtx();
  const view = d2d.fitView(computedDefault, 900, 600);
  const res = d2d.renderScene(ctx, computedDefault, {
    width: 900, height: 600, view: view,
    selection: { kind: "zone", segmentId: "seg1", zoneIndex: 2 },
    title: "CONVEYOR_1", subtitle: "1 segment · 4 zones", hint: "drag me",
    cursor: { x: 1.25, y: -0.5 }, rollerPitchM: 0.1
  });
  assert.ok(res && res.view.scale === view.scale, "passes the supplied view through");
  const fills = colorsSet(ctx, "fillStyle");
  assert.ok(fills.indexOf(d2d.DESIGNER2D_DEFAULT_COLORS.zoneSelectionFill) >= 0, "selected zone fill drawn");
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  assert.ok(labels.indexOf("CONVEYOR_1") >= 0, "title drawn");
  assert.ok(labels.some(function (s) { return s.indexOf("x 1.25") >= 0; }), "cursor readout drawn");
  assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates");
});

t("E3 renderScene: segment selection + empty design + colours override", () => {
  const ctxA = recordingCtx();
  d2d.renderScene(ctxA, computedSynthetic, {
    width: 700, height: 500,
    selection: { kind: "segment", segmentId: "s2", zoneIndex: null }
  });
  assert.ok(ctxA.ops.stroke.length > 0);
  assert.deepStrictEqual(badNumericArgs(ctxA.calls), [], "no NaN coordinates (selection)");

  const ctxB = recordingCtx();
  const resB = d2d.renderScene(ctxB, { segments: [], zones: [], bounds: null }, { width: 400, height: 300 });
  assert.deepStrictEqual({ segments: resB.segments, zones: resB.zones }, { segments: 0, zones: 0 });
  assert.ok(ctxB.ops.fillText.length > 0, "empty-state message drawn");
  assert.ok(ctxB.ops.stroke.length > 0, "grid still drawn");

  const ctxC = recordingCtx();
  d2d.renderScene(ctxC, computedDefault, { width: 640, height: 480, colors: { background: "#ffffff" } });
  assert.ok(colorsSet(ctxC, "fillStyle").indexOf("#ffffff") >= 0, "colour override used");
});

t("E4 renderScene: stale selection and bad computed never throw", () => {
  const ctx = recordingCtx();
  d2d.renderScene(ctx, computedDefault, {
    width: 300, height: 200,
    selection: { kind: "segment", segmentId: "does-not-exist", zoneIndex: null }
  });
  const ctx2 = recordingCtx();
  d2d.renderScene(ctx2, null, { width: 300, height: 200 });
  const ctx3 = recordingCtx();
  const res = d2d.renderScene(ctx3, computedDefault, {});
  assert.ok(res.view.scale > 0, "default width/height fallback works");
  assert.equal(d2d.renderScene(null, computedDefault, {}), null, "null ctx tolerated");
});

t("E5 renderScene synthetic chain: scanners, tracking labels, joints, elevation", () => {
  const ctx = recordingCtx();
  const res = d2d.renderScene(ctx, computedSynthetic, {
    width: 1400, height: 900, rollerPitchM: 0.1,
    title: "SYNTH_CHAIN", subtitle: "ROLLER · 4 segments"
  });
  assert.equal(res.segments, 4);
  assert.equal(res.zones, 16);
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  /* tracking slots T1..Tn */
  assert.ok(labels.indexOf("T1") >= 0, "tracking label T1 drawn");
  assert.ok(labels.indexOf("T16") >= 0, "tracking label T16 drawn");
  /* scanner marker name + barcode tag */
  assert.ok(labels.some(function (s) { return s.indexOf("SCAN_ENTRY") >= 0; }), "scan station name label");
  assert.ok(labels.some(function (s) { return s.indexOf("ENTRY_BC") >= 0; }), "scan tag label");
  /* rounded joint fillet annotation */
  assert.ok(labels.some(function (s) { return s.indexOf("R0.30") >= 0; }), "joint fillet radius label");
  assert.ok(labels.some(function (s) { return s.indexOf("30") >= 0; }), "joint turn angle label");
  /* spiral / elevation indicators */
  assert.ok(labels.some(function (s) { return s.indexOf("SPIRAL") >= 0; }), "spiral segment label");
  assert.ok(labels.some(function (s) { return s.indexOf("+2.4 m") >= 0; }), "elevation badge +2.4 m");
  assert.ok(ctx.ops.arc.length >= 16, "arcs for sensors, joint fillets and scan glyphs: " + ctx.ops.arc.length);
  assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in the chained scene");
  /* dashed drawing is simulated with explicit moveTo/lineTo segments */
  assert.ok(ctx.ops.moveTo.length > 200, "dashed outline broken into segments: " + ctx.ops.moveTo.length);
});

t("E6 renderScene: tracking labels only when tracking is enabled", () => {
  const ctx = recordingCtx();
  d2d.renderScene(ctx, computedDefault, { width: 800, height: 600 });
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  assert.ok(!labels.some(function (s) { return /^T\d+$/.test(s); }), "no Tn labels without tracking");
  assert.equal(computedDefault.tracking, null, "model leaves tracking null when disabled");
});

t("E7 renderScene belt conveyor: continuous band, pulleys, BELT label", () => {
  const ctx = recordingCtx();
  const res = d2d.renderScene(ctx, computedBelt, { width: 1200, height: 800, rollerPitchM: 0.1 });
  assert.equal(res.segments, 2);
  assert.equal(res.zones, computedBelt.zones.length);
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  assert.ok(labels.some(function (s) { return s.indexOf("BELT") >= 0; }), "belt segment label");
  assert.ok(ctx.ops.arc.length >= 8, "pulley + sensor arcs drawn");
  assert.ok(ctx.ops.fillRect.length >= 2, "head drive boxes drawn");
  assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in the belt scene");
});

t("E8 renderScene model v3 devices: merge throat, transfer symbols, I/O labels", () => {
  const ctx = recordingCtx();
  const res = d2d.renderScene(ctx, computedDevices, { width: 1400, height: 1000, rollerPitchM: 0.1 });
  assert.equal(res.segments, 4);
  assert.equal(res.zones, 11);
  assert.equal(res.merges, 1, "render summary reports merges");
  assert.equal(res.transfers, 3, "render summary reports transfers");
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  assert.ok(labels.some(function (s) { return s.indexOf("MERGE1") >= 0; }), "MERGE1 label");
  assert.ok(labels.some(function (s) { return s.indexOf("PUSHER") >= 0; }), "PUSHER label");
  assert.ok(labels.some(function (s) { return s.indexOf("ROTARY") >= 0; }), "ROTARY label");
  assert.ok(labels.some(function (s) { return s.indexOf("POP-UP") >= 0; }), "POP-UP label");
  for (const block of ["XFER01", "XFER02", "XFER03"]) {
    assert.ok(labels.some(function (s) { return s.indexOf(block) >= 0; }), "device I/O label " + block);
  }
  /* merge release zone highlighted with the merge zone fill */
  assert.ok(colorsSet(ctx, "fillStyle").indexOf(d2d.DESIGNER2D_DEFAULT_COLORS.mergeZoneFill) >= 0,
    "merge zone highlight drawn");
  /* throat fill + bidirectional rotation arrows use extra arcs */
  assert.ok(ctx.ops.arc.length >= 14, "rotation arcs / sensor circles drawn: " + ctx.ops.arc.length);
  assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in the devices scene");
});

t("E9 renderScene model v3: >1 m merge gap uses warning throat + badge", () => {
  const warned = JSON.parse(JSON.stringify(computedDevices));
  warned.merges[0].gapM = 1.5;
  const ctx = recordingCtx();
  d2d.renderScene(ctx, warned, { width: 1200, height: 900, rollerPitchM: 0.1 });
  const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
  assert.ok(labels.some(function (s) { return s.indexOf("THROAT PLATE") >= 0; }), "throat plate badge");
  assert.ok(labels.some(function (s) { return s.indexOf("1.50") >= 0; }), "gap distance shown");
  const fills = colorsSet(ctx, "fillStyle");
  const strokes = colorsSet(ctx, "strokeStyle");
  assert.ok(fills.indexOf(d2d.DESIGNER2D_DEFAULT_COLORS.mergeWarnFill) >= 0, "warning throat fill");
  assert.ok(strokes.indexOf(d2d.DESIGNER2D_DEFAULT_COLORS.mergeWarn) >= 0, "warning throat outline");
  assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in the warning scene");
});

/* ========================================================================= */
/* F. Node-safety of the classes                                             */
/* ========================================================================= */

t("F1 ConveyorDesigner2D constructs and works headless", () => {
  const designer = new d2d.ConveyorDesigner2D();
  assert.ok(designer instanceof d2d.ConveyorDesigner2D);
  assert.equal(designer.getComputed().totals.zones, 4, "default design computed");
  const view = designer.getView();
  assert.ok(Number.isFinite(view.scale) && view.scale > 0, "view scale finite");
  assert.ok(Number.isFinite(view.offsetX) && Number.isFinite(view.offsetY), "view offsets finite");
  assert.equal(designer.redraw(), false, "redraw is a no-op without DOM");
  assert.equal(typeof designer.setDesign, "function");
  assert.equal(typeof designer.zoomToFit, "function");
  assert.equal(typeof designer.destroy, "function");
});

t("F2 ConveyorDesigner2D API: setDesign/getComputed/selection/view/destroy", () => {
  let changes = 0, selects = 0;
  const designer = new d2d.ConveyorDesigner2D({
    container: null,
    design: defaultDesign,
    onChange: function () { changes++; },
    onSelect: function () { selects++; }
  });
  designer.setDesign(syntheticDesign());
  assert.equal(designer.getComputed().totals.segments, 4, "recomputed after setDesign");
  assert.equal(designer.getComputed().totals.zones, 16, "zone total after setDesign");
  assert.equal(designer.getComputed().totals.joints, 3, "chained joints after setDesign");
  assert.equal(designer.getComputed().totals.scanZones, 1, "scan zone count");
  assert.equal(designer.getComputed().totals.trackingEnabled, true, "tracking enabled");
  assert.equal(changes, 0, "setDesign does not emit onChange");

  designer.setSelection({ kind: "zone", segmentId: "s2", zoneIndex: 5 });
  const sel = designer.getSelection();
  assert.equal(sel.kind, "zone");
  assert.equal(sel.segmentId, "s2");
  assert.equal(sel.zoneIndex, 5);

  /* the properties panel selects segments by bare id: setSelection(segmentId) */
  designer.setSelection("s1");
  const sel2 = designer.getSelection();
  assert.equal(sel2.kind, "segment", "bare string selects a segment");
  assert.equal(sel2.segmentId, "s1");
  assert.equal(sel2.zoneIndex, null, "segment-only selection has no zone");

  designer.setView({ scale: 10, offsetX: 5, offsetY: 7 });
  const mapped = d2d.worldToScreen(designer.getView(), { x: 0, y: 0 });
  assert.deepStrictEqual(mapped, { x: 5, y: 7 }, "getView feeds worldToScreen");

  /* model v3: merges + transfer devices in the computed design */
  designer.setDesign(devicesDesign());
  const dev = designer.getComputed();
  assert.equal(dev.totals.merges, 1, "merge count in computed totals");
  assert.equal(dev.totals.transfers, 3, "transfer count in computed totals");
  assert.equal(dev.totals.deviceBlocks, 3, "device I/O block count");
  assert.equal(dev.merges[0].name, "MERGE1", "merge record available to panels");
  assert.deepStrictEqual(dev.transfers.map(function (t) { return t.type; }).sort(),
    ["popup_transfer", "pusher", "rotary_table"], "all transfer types computed");

  const fitted = designer.zoomToFit();
  assert.ok(Number.isFinite(fitted.scale) && fitted.scale > 0, "zoomToFit view finite");
  designer.resize();
  designer.destroy();
  assert.doesNotThrow(function () { designer.setDesign(defaultDesign); }, "post-destroy calls safe");
  designer.destroy(); // idempotent
  assert.equal(selects, 0, "no synthetic UI events headless");
});

t("F3 Conveyor3D constructs and works headless (no WebGL)", () => {
  const view = new r3d.Conveyor3D({ container: null, design: defaultDesign });
  assert.ok(view instanceof r3d.Conveyor3D);
  assert.equal(view.render(), false, "render is a no-op without WebGL");
  const geo = view.getGeometry();
  assert.ok(geo && geo.counts.segments === 1, "CPU geometry still built");
  const cam = view.getCamera();
  assert.ok(Number.isFinite(cam.yaw) && Number.isFinite(cam.pitch) && Number.isFinite(cam.distance));
  assert.ok(cam.distance > 0, "camera framed on geometry");
  assert.ok(Number.isFinite(cam.target.x) && Number.isFinite(cam.target.z), "camera target finite");
});

t("F4 Conveyor3D API: setDesign/render/resize/dispose", () => {
  const view = new r3d.Conveyor3D({ container: null, design: defaultDesign, rollerPitchM: 0.2 });
  assert.equal(view.getGeometry().counts.rollers, 21, "rollerPitch option honoured");
  /* an explicit constructor rollerPitch override persists across setDesign */
  view.setDesign(syntheticDesign());
  const pitchOverrideExpected = expectedRollers(computedSynthetic, 0.2);
  assert.equal(view.getGeometry().counts.segments, 4);
  assert.equal(view.getGeometry().counts.rollers, pitchOverrideExpected, "0.2 m pitch override kept");
  assert.ok(view.getGeometry().counts.taperedRollers > 0, "tapered rollers after setDesign");
  assert.ok(view.getGeometry().counts.scanners === 1, "scanner geometry after setDesign");
  assert.equal(view.render(), false, "still no WebGL");
  assert.doesNotThrow(function () { view.resize(); });
  assert.doesNotThrow(function () { view.frameCamera(); });
  assert.doesNotThrow(function () { view.dispose(); });
  assert.doesNotThrow(function () { view.dispose(); }, "dispose idempotent");
  assert.equal(view.render(), false, "render after dispose");

  /* without an override, setDesign follows the design's own defaults (0.1 m) */
  const view2 = new r3d.Conveyor3D({ container: null, design: defaultDesign });
  view2.setDesign(syntheticDesign());
  assert.equal(view2.getGeometry().counts.rollers, expectedRollers(computedSynthetic, 0.1),
    "design defaults used after setDesign");
  assert.equal(view2.getGeometry().counts.segments, 4);
  assert.ok(view2.getCamera().distance > 0, "camera re-framed when segment count changes");
  assert.ok(view2.getGeometry().bounds.maxY >= 2.4, "camera frames the tall spiral geometry");
  view2.dispose();
});

t("F5 3D feature detection is safe outside a browser", () => {
  assert.equal(r3d.hasWebGLSupport(), false, "no WebGL support in Node");
  assert.doesNotThrow(function () { new r3d.Conveyor3D(); });
  assert.doesNotThrow(function () { new r3d.Conveyor3D({ container: {} }); });
});

t("F6 Conveyor3D model v3: merge/transfer geometry through setDesign", () => {
  const view = new r3d.Conveyor3D({ container: null, design: devicesDesign() });
  assert.equal(view.render(), false, "no WebGL in Node");
  const geo = view.getGeometry();
  assert.equal(geo.counts.merges, 1, "merge throat plate built from the design");
  assert.equal(geo.counts.pushers, 1, "pusher built");
  assert.equal(geo.counts.rotaryTables, 1, "rotary table built");
  assert.equal(geo.counts.popupTransfers, 1, "pop-up transfer built");
  assert.equal(geo.counts.popupBelts, 3, "pop-up cross belts built");
  assert.ok(geo.bounds.minZ < -2.0, "spur chain framed by the camera bounds");
  const cam = view.getCamera();
  assert.ok(Number.isFinite(cam.distance) && cam.distance > 0, "camera framed on the devices design");
  view.dispose();
});

/* ========================================================================= */
/* G. fake-DOM smoke tests (exercise the browser code paths in Node)         */
/* ========================================================================= */

/* Minimal document/window/canvas doubles. The 2D canvas returns the same strict
   recording ctx stub, so a mounted designer can be driven end-to-end. */
function fakeDomWith(options) {
  options = options || {};
  const listeners = { doc: {}, win: {} };
  const state = { lastCanvas: null, lastCtx: null, focused: false, gl: options.gl || null };
  function makeCanvas() {
    const canvasListeners = {};
    const canvas = {
      tagName: "CANVAS",
      className: "",
      width: 300,
      height: 150,
      style: {},
      parentNode: null,
      ownerDocument: null,
      clientWidth: 800,
      clientHeight: 600,
      addEventListener: function (type, fn) { (canvasListeners[type] = canvasListeners[type] || []).push(fn); },
      removeEventListener: function (type, fn) {
        const a = canvasListeners[type] || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      fire: function (type, ev) {
        for (const fn of (canvasListeners[type] || []).slice()) fn(ev);
      },
      listenerCount: function () {
        let n = 0;
        for (const k of Object.keys(canvasListeners)) n += canvasListeners[k].length;
        return n;
      },
      focus: function () { state.focused = true; },
      setAttribute: function () {},
      getBoundingClientRect: function () { return { left: 0, top: 0, width: 800, height: 600 }; },
      getContext: function (type) {
        if (type === "2d") { state.lastCtx = recordingCtx(); return state.lastCtx; }
        if (state.gl && (type === "webgl" || type === "experimental-webgl")) return state.gl;
        return null;
      }
    };
    state.lastCanvas = canvas;
    return canvas;
  }
  const container = {
    clientWidth: 800,
    clientHeight: 600,
    children: [],
    appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild: function (c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
  };
  const doc = {
    createElement: function (tag) {
      if (tag === "canvas") return makeCanvas();
      return { tagName: String(tag).toUpperCase(), style: {}, appendChild: function () {} };
    },
    body: { appendChild: function () {} },
    addEventListener: function (type, fn) { (listeners.doc[type] = listeners.doc[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      const a = listeners.doc[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire: function (type, ev) {
      for (const fn of (listeners.doc[type] || []).slice()) fn(ev);
    },
    listenerCount: function () {
      let n = 0;
      for (const k of Object.keys(listeners.doc)) n += listeners.doc[k].length;
      return n;
    }
  };
  const win = {
    devicePixelRatio: 2,
    addEventListener: function (type, fn) { (listeners.win[type] = listeners.win[type] || []).push(fn); },
    removeEventListener: function () {},
    fire: function (type, ev) {
      for (const fn of (listeners.win[type] || []).slice()) fn(ev);
    }
  };
  return { state: state, container: container, doc: doc, win: win, makeCanvas: makeCanvas };
}

t("G1 ConveyorDesigner2D mounts, draws, selects, drags, zooms and deletes in a fake DOM", () => {
  const dom = fakeDomWith();
  global.document = dom.doc;
  global.window = dom.win;
  try {
    const events = { changes: [], selects: [] };
    const designer = new d2d.ConveyorDesigner2D({
      container: dom.container,
      design: model.createDefaultDesign(),
      onChange: function (design) { events.changes.push(design); },
      onSelect: function (sel) { events.selects.push(sel); }
    });
    /* mount */
    assert.equal(dom.container.children.length, 1, "canvas appended to container");
    const canvas = dom.container.children[0];
    assert.ok(canvas.width > 0 && canvas.height > 0, "canvas backing store sized");
    assert.equal(canvas.width, 1600, "devicePixelRatio 2 applied to width");
    assert.equal(designer.redraw(), true, "redraw works with a DOM");
    assert.ok(dom.state.lastCtx && dom.state.lastCtx.ops.fillText.length > 0, "canvas 2D drawing happened");

    /* click to select the segment (canvas centre is a zone boundary -> zone selection) */
    const sc = d2d.worldToScreen(designer.getView(), { x: 2.5, y: 0 });
    canvas.fire("mousedown", { button: 0, clientX: sc.x, clientY: sc.y, preventDefault: function () {} });
    dom.doc.fire("mouseup", {});
    assert.equal(events.selects.length, 1, "one onSelect emitted");
    assert.equal(events.selects[0].kind, "zone", "zone under the cursor selected");
    assert.equal(events.selects[0].segmentId, "seg1");
    assert.equal(events.selects[0].zoneIndex, 2, "global 0-based zone index");
    assert.equal(designer.getSelection().segmentId, "seg1", "selection stored");

    /* drag the selected segment 50 px to the right */
    const scale = designer.getView().scale;
    canvas.fire("mousedown", { button: 0, clientX: sc.x, clientY: sc.y, preventDefault: function () {} });
    dom.doc.fire("mousemove", { clientX: sc.x + 50, clientY: sc.y });
    dom.doc.fire("mouseup", {});
    assert.equal(events.changes.length, 1, "onChange emitted during drag");
    approx(events.changes[0].segments[0].x, 50 / scale, 0.01, "segment moved by 50px / scale");
    approx(events.changes[0].segments[0].y, 0, 0.01, "no vertical movement");
    assert.equal(designer.getComputed().totals.segments, 1, "design still valid after drag");

    /* wheel zooms, pan drags the view */
    const scaleBefore = designer.getView().scale;
    canvas.fire("wheel", { deltaY: -120, clientX: 400, clientY: 300, preventDefault: function () {} });
    assert.ok(designer.getView().scale > scaleBefore, "wheel zoomed in");
    const offsetBefore = designer.getView().offsetX;
    canvas.fire("mousedown", { button: 0, clientX: 5, clientY: 5, preventDefault: function () {} });
    dom.doc.fire("mousemove", { clientX: 25, clientY: 5 });
    dom.doc.fire("mouseup", {});
    approx(designer.getView().offsetX, offsetBefore + 20, 0.01, "background drag panned the view");

    /* Delete removes the selected segment and notifies the host */
    canvas.fire("mousedown", { button: 0, clientX: 400, clientY: 300, preventDefault: function () {} });
    dom.doc.fire("mouseup", {});
    const changesBeforeDelete = events.changes.length;
    dom.doc.fire("keydown", { key: "Delete", target: { tagName: "DIV" }, preventDefault: function () {} });
    assert.equal(events.changes.length, changesBeforeDelete + 1, "delete emitted onChange");
    assert.equal(designer.getComputed().totals.segments, 0, "segment removed");
    assert.equal(designer.getSelection().kind, null, "selection cleared after delete");

    /* a host panel re-render detaches the canvas: the editor self-disables on the next
       document activity so stale editor generations never react to keys/mouse again */
    canvas.isConnected = false;
    dom.doc.fire("mousemove", { clientX: 10, clientY: 10 });
    assert.equal(dom.container.children.length, 0, "detached designer removed its canvas");
    assert.equal(canvas.listenerCount(), 0, "all canvas listeners removed");
    assert.equal(dom.doc.listenerCount(), 0, "all document listeners removed");
    designer.destroy(); // idempotent
    assert.doesNotThrow(function () { designer.setDesign(model.createDefaultDesign()); });
  } finally {
    delete global.document;
    delete global.window;
  }
});

function fakeGl() {
  const calls = [];
  function fn(name) {
    return function () { calls.push({ name: name, args: Array.prototype.slice.call(arguments) }); };
  }
  function rec(name) {
    return function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
      return {};
    };
  }
  return {
    calls: calls,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406, TRIANGLES: 0x0004, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405,
    DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
    createShader: rec("createShader"), shaderSource: fn("shaderSource"), compileShader: fn("compileShader"),
    getShaderParameter: function () { return true; }, deleteShader: fn("deleteShader"),
    createProgram: rec("createProgram"), attachShader: fn("attachShader"), linkProgram: fn("linkProgram"),
    getProgramParameter: function () { return true; }, deleteProgram: fn("deleteProgram"),
    getAttribLocation: function (p, name) { return { aPosition: 0, aNormal: 1, aColor: 2 }[name]; },
    getUniformLocation: function () { return {}; },
    createBuffer: rec("createBuffer"), bindBuffer: fn("bindBuffer"), bufferData: fn("bufferData"),
    deleteBuffer: fn("deleteBuffer"),
    enable: fn("enable"), disable: fn("disable"), viewport: fn("viewport"),
    clearColor: fn("clearColor"), clear: fn("clear"), useProgram: fn("useProgram"),
    uniformMatrix4fv: fn("uniformMatrix4fv"), uniform3f: fn("uniform3f"),
    enableVertexAttribArray: fn("enableVertexAttribArray"),
    vertexAttribPointer: fn("vertexAttribPointer"),
    drawElements: fn("drawElements"),
    getExtension: function () { return null; }
  };
}

t("G2 Conveyor3D initialises WebGL, uploads buffers and renders in a fake DOM", () => {
  const gl = fakeGl();
  const dom = fakeDomWith({ gl: gl });
  global.document = dom.doc;
  global.window = dom.win;
  try {
    assert.equal(r3d.hasWebGLSupport(), true, "feature detection sees the fake context");
    const view = new r3d.Conveyor3D({ container: dom.container, design: model.createDefaultDesign() });
    assert.equal(dom.container.children.length, 1, "3D canvas appended");
    const canvas = dom.container.children[0];
    assert.equal(canvas.width, 1600, "devicePixelRatio applied");
    assert.equal(view.render(), true, "render() draws a frame with WebGL");
    const names = gl.calls.map(function (c) { return c.name; });
    for (const op of ["createShader", "createProgram", "linkProgram", "createBuffer",
      "bufferData", "uniformMatrix4fv", "drawElements"]) {
      assert.ok(names.indexOf(op) >= 0, "GL call made: " + op);
    }
    const uploads = gl.calls.filter(function (c) { return c.name === "bufferData"; });
    assert.equal(uploads.length, 4, "position/normal/colour/index buffers uploaded");
    const draws = gl.calls.filter(function (c) { return c.name === "drawElements"; });
    assert.ok(draws.length >= 1 && draws[draws.length - 1].args[1] > 0, "drawElements has an index count");
    assert.ok(gl.calls.some(function (c) { return c.name === "clearColor"; }), "frame cleared");
    /* resize + design replacement + dispose through the GL path */
    view.setDesign(syntheticDesign());
    assert.equal(view.render(), true, "render after setDesign");
    /* a host re-render detaches the canvas: the 3D view disposes itself on next activity */
    canvas.isConnected = false;
    dom.doc.fire("mousemove", { clientX: 5, clientY: 5 });
    assert.equal(dom.container.children.length, 0, "detached 3D view removed its canvas");
    assert.equal(dom.doc.listenerCount(), 0, "3D document listeners removed");
    assert.equal(view.render(), false, "detached view is disposed");
    assert.doesNotThrow(function () { view.dispose(); }, "dispose idempotent");
    assert.ok(gl.calls.some(function (c) { return c.name === "deleteProgram"; }), "program deleted");
  } finally {
    delete global.document;
    delete global.window;
  }
});

t("G3 model-v2 chain design mounts and renders in a fake DOM (scanner/tracking/elevation)", () => {
  const dom = fakeDomWith();
  global.document = dom.doc;
  global.window = dom.win;
  try {
    const designer = new d2d.ConveyorDesigner2D({
      container: dom.container,
      design: syntheticDesign()
    });
    assert.equal(dom.container.children.length, 1, "canvas appended");
    assert.equal(designer.redraw(), true, "redraw works with a DOM");
    const ctx = dom.state.lastCtx;
    assert.ok(ctx && ctx.ops.fillText.length > 20, "chained scene labels drawn: " + (ctx && ctx.ops.fillText.length));
    const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
    assert.ok(labels.some(function (s) { return s.indexOf("SCAN_ENTRY") >= 0; }), "scanner label in DOM render");
    assert.ok(labels.indexOf("T1") >= 0, "tracking label in DOM render");
    assert.ok(labels.some(function (s) { return s.indexOf("SPIRAL") >= 0; }), "spiral label in DOM render");
    assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in DOM render");

    /* belt design also renders through the mounted editor path */
    designer.setDesign(beltDesign());
    assert.equal(designer.getComputed().totals.conveyorType, "belt");
    assert.equal(designer.redraw(), true, "belt design redraw");
    assert.ok(colorsSet(dom.state.lastCtx, "fillStyle").length > 0, "belt colours set");
    designer.destroy();
    assert.equal(dom.container.children.length, 0, "canvas removed on destroy");
  } finally {
    delete global.document;
    delete global.window;
  }
});

t("G4 model-v3 devices design mounts and renders (merge + transfer symbols)", () => {
  const dom = fakeDomWith();
  global.document = dom.doc;
  global.window = dom.win;
  try {
    const designer = new d2d.ConveyorDesigner2D({ container: dom.container, design: devicesDesign() });
    assert.equal(designer.redraw(), true, "redraw works with a DOM");
    const ctx = dom.state.lastCtx;
    const labels = ctx.ops.fillText.map(function (c) { return String(c.args[0]); });
    assert.ok(labels.some(function (s) { return s.indexOf("MERGE1") >= 0; }), "merge label in DOM render");
    assert.ok(labels.some(function (s) { return s.indexOf("PUSHER") >= 0; }), "pusher label in DOM render");
    assert.ok(labels.some(function (s) { return s.indexOf("ROTARY") >= 0; }), "rotary label in DOM render");
    assert.ok(labels.some(function (s) { return s.indexOf("POP-UP") >= 0; }), "pop-up label in DOM render");
    assert.ok(labels.some(function (s) { return s.indexOf("XFER01") >= 0; }), "device I/O label in DOM render");
    assert.deepStrictEqual(badNumericArgs(ctx.calls), [], "no NaN coordinates in DOM render");
    assert.ok(ctx.ops.arc.length > 0 && ctx.ops.save.length === ctx.ops.restore.length,
      "arcs drawn and save/restore balanced");
    designer.destroy();
    assert.equal(dom.container.children.length, 0, "canvas removed on destroy");
  } finally {
    delete global.document;
    delete global.window;
  }
});

/* ========================================================================= */

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
