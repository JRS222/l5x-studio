/* L5X Studio - test/t7-conveyor-parts.test.js (T-E "conveyor-parts")
   Verifies the roller/driver-card data port, part-number builders, compatibility
   rules, recommendRoller, component selection for a 2-segment/6-zone design, BOM
   arithmetic/CSV/markdown, and the generated parts catalog.

   Run: node test/t7-conveyor-parts.test.js
   Exits non-zero when any assertion fails. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "js", "conveyor", "parts.js"));
const M = require(path.join(ROOT, "js", "conveyor", "model.js"));

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) {
    fail++;
    failures.push(name);
    const detail = e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : String(e);
    console.log("FAIL " + name + "\n     " + detail);
  }
}
function approx(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= (tol === undefined ? 1e-6 : tol),
    (msg || "approx") + ": expected " + expected + " +/- " + (tol === undefined ? 1e-6 : tol) + ", got " + actual);
}

/* ---- shared fixtures ---------------------------------------------------- */
/* Baseline application inputs = the source tool's defaults (15.1" BF, 1.9" dia,
   down-spiral, standard drive, cardboard packages). */
const BASE_INP = {
  packageMaterial: "Cardboard", wlbsMax: 200, droller: 1.9, lbf: 15.1,
  curveType: "Down Spiral", driveStyle: "Standard",
  hspiral: 10, pitch: 3, cableLength: 40, quantity: 1, taperDiameter: 2.2
};
function inp(overrides) { return Object.assign({}, BASE_INP, overrides || {}); }

/* Demo design required by the contract: 2 segments / 6 zones, all straight. */
function demoDesign() {
  const design = M.createDefaultDesign();
  design.name = "DEMO_2SEG_6ZONE";
  design.segments = [
    { id: "seg1", name: "SEG1", kind: "straight", x: 0, y: 0, rotationDeg: 0,
      lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "seg2", name: "SEG2", kind: "straight", x: 4.05, y: 0, rotationDeg: 0,
      lengthM: 2, widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null }
  ];
  return design;
}

/* Minimal RFC 4180 CSV parser (for the round-trip test). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* handled with \n */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const CATEGORY_SET = new Set(P.PART_CATEGORIES);

/* Source reference: the community roller part-number generator the data/algorithms
   were ported from (docs/CONVEYOR.md reference material; read-only). When this file
   is present we prove the port is faithful; when absent the check is skipped. */
const SOURCE_HTML = "C:/samples/sample-file";

/* Extract a `const NAME = ...;` literal from the source HTML (bracket matching that
   ignores brackets inside quoted strings). */
function extractSourceLiteral(html, name) {
  const startTok = "const " + name + " = ";
  const start = html.indexOf(startTok);
  if (start < 0) throw new Error("source literal not found: " + name);
  let i = start + startTok.length;
  const open = html[i];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = null, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start + startTok.length, i);
}

/* ======================================================================== */
/* 0. SOURCE FIDELITY (data port)                                          */
/* ======================================================================== */
t("port fidelity: data tables exactly match the source roller tool", () => {
  if (!fs.existsSync(SOURCE_HTML)) {
    console.log("     (source HTML not available - fidelity check skipped)");
    return;
  }
  const html = fs.readFileSync(SOURCE_HTML, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  const tables = ["ROLLER_DB", "MU_TABLE", "VENDORS", "SERIES_SPECS", "DRIVER_CARDS", "SPEED_CODES"];
  for (const table of tables) {
    vm.runInContext("var " + table + " = " + extractSourceLiteral(html, table) + ";", sandbox,
      { filename: "source:" + table });
  }
  /* ROLLER_DB: every source field must be identical (we only append brand/series) */
  assert.equal(sandbox.ROLLER_DB.length, P.ROLLER_DB.length, "roller count");
  sandbox.ROLLER_DB.forEach((src, i) => {
    for (const key of Object.keys(src)) {
      assert.deepStrictEqual(P.ROLLER_DB[i][key], src[key],
        "roller " + (i + 1) + " field " + key + " matches source");
    }
  });
  for (const table of ["MU_TABLE", "VENDORS", "SERIES_SPECS", "DRIVER_CARDS", "SPEED_CODES"]) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P[table])),
      JSON.parse(JSON.stringify(sandbox[table])), table + " ported verbatim");
  }
});

/* ======================================================================== */
/* 1. DATA PORT                                                             */
/* ======================================================================== */
t("roller database ported (20 rollers, brands/series derived)", () => {
  assert.equal(P.ROLLER_DB.length, 20, "roller count");
  /* NB: the source tool groups the four MR-* legacy sample rollers under its
     "Itoh Denki" comment but rollerBrand()/parseSeries() correctly classify them
     as Microroll (legacy RC-format alias of InfiniDrive). */
  const itoh = P.ROLLER_DB.filter(r => r.brand === "itoh").length;
  const id = P.ROLLER_DB.filter(r => r.brand === "infinidrive").length;
  const micro = P.ROLLER_DB.filter(r => r.brand === "microroll").length;
  assert.equal(itoh, 8, "itoh roller count");
  assert.equal(id, 8, "infinidrive roller count");
  assert.equal(micro, 4, "legacy MR- roller count");
  assert.equal(itoh + id + micro, 20, "all rollers classified");
  for (const r of P.ROLLER_DB) {
    for (const key of ["psn", "pn", "desc", "boh", "status", "len", "grooved", "braking", "tapered", "idealFrame", "repl"]) {
      assert.ok(key in r, r.pn + " has field " + key);
    }
  }
  const ts = P.getRollerByPn("MR-AD-48-361-40-YWGQ/TS");
  assert.ok(ts && ts.tapered === true, "tapered roller present");
});

t("series specs ported (9 Itoh + 8 InfiniDrive + Microroll alias)", () => {
  const keys = Object.keys(P.SERIES_SPECS);
  assert.equal(keys.length, 18, "series count");
  for (const k of ["PM486FE", "PM486FS", "PM635KT", "RD48", "RD63S", "GM48", "FM24095", "MICROROLL"]) {
    assert.ok(P.SERIES_SPECS[k], "series " + k);
  }
  assert.equal(P.SERIES_SPECS.RD48.diameter, 48);
  assert.equal(P.SERIES_SPECS["PM486FE"].brand, "itoh");
  assert.equal(P.SERIES_SPECS.MICROROLL.alias, "infinidrive");
});

t("driver card registry ported (23 cards, all series-referenced cards exist)", () => {
  const names = Object.keys(P.DRIVER_CARDS);
  assert.equal(names.length, 23, "card count");
  for (const name of names) {
    const c = P.DRIVER_CARDS[name];
    assert.ok(c.brand && c.family, name + " brand/family");
    assert.ok(Array.isArray(c.rollerSeries) && c.rollerSeries.length > 0, name + " rollerSeries");
  }
  /* every card referenced by a series must exist in the registry */
  for (const s of Object.keys(P.SERIES_SPECS)) {
    const spec = P.SERIES_SPECS[s];
    for (const c of (spec.cards || []).concat(spec.brakeCards || [])) {
      assert.ok(P.DRIVER_CARDS[c], "series " + s + " references known card " + c);
    }
  }
  assert.equal(P.DRIVER_CARDS["C100Z-35"].motorWattage, "35 W");
  assert.equal(P.DRIVER_CARDS["HB-510"].family, "zpa");
});

t("MU table + speed tables + brands ported", () => {
  assert.equal(P.MU_TABLE.Straight.Cardboard, 0.10);
  assert.equal(P.MU_TABLE.Tapered.Cardboard, 0.15);
  assert.equal(P.MU_TABLE.Tapered.Steel, 0.03);
  assert.equal(Object.keys(P.SPEED_CODES).length, 16, "speed model count");
  assert.equal(P.SPEED_CODES.RD48.length, 9, "RD48 speed codes");
  assert.equal(P.SPEED_CODES["PM486FE"].length, 5, "PM486FE speed codes");
  assert.deepStrictEqual(Object.keys(P.BRANDS).sort(), ["infinidrive", "itoh", "microroll"]);
  assert.equal(P.BRANDS.itoh.vfpm, 45);
  assert.equal(P.BRANDS.microroll.vfpm, 40);
  assert.equal(P.VENDORS.length, 4);
});

/* ======================================================================== */
/* 2. SERIES / BRAND / CARD LOOKUPS                                         */
/* ======================================================================== */
t("parseSeries resolves every documented format", () => {
  assert.equal(P.parseSeries("PM486FS-55-268-D-024-KF"), "PM486FS");
  assert.equal(P.parseSeries("PM486FE-45-528-D-024-P2-0S"), "PM486FE");
  assert.equal(P.parseSeries("PM635KT-…"), "PM635KT");
  assert.equal(P.parseSeries("MR-AD-48-361-40-YWGQ"), "MICROROLL");
  assert.equal(P.parseSeries("RC A DU42 G 0500 HTS 12 A 0 X"), "RD48");
  assert.equal(P.parseSeries("RC B DU42 G 0600 HTS 16 A 0 X"), "RD50");
  assert.equal(P.parseSeries("RC C DU42 G 0800 HTS 27 A 0 X"), "RD57");
  assert.equal(P.parseSeries("RC D DU42 N 0400 HTS 9 A 0 X"), "RD60");
  assert.equal(P.parseSeries("RC E DU42 C 0600 HTA 27 C 1 X"), "RD63");
  assert.equal(P.parseSeries("RA E DU42 M 0600 HTA 16 C 1 X"), "RD63S");
  assert.equal(P.parseSeries("GM A DU42 S 0000 GMO 27 A 0 A"), "GM48");
  assert.equal(P.parseSeries("RD48"), "RD48");
  assert.equal(P.parseSeries("RD63S"), "RD63S");
  assert.equal(P.parseSeries("FM24095"), "FM24095");
  assert.equal(P.parseSeries("NOT-A-ROLLER"), null);
  assert.equal(P.parseSeries(""), null);
  assert.equal(P.parseSeries(null), null);
});

t("rollerBrand classifies part numbers", () => {
  assert.equal(P.rollerBrand("PM486FE-45-364-D-024-G-B"), "itoh");
  assert.equal(P.rollerBrand("CB-016S7"), "itoh");
  assert.equal(P.rollerBrand("HB-510"), "itoh");
  assert.equal(P.rollerBrand("MR-AD-48-361-40-YWGQ"), "microroll");
  assert.equal(P.rollerBrand("RC A DU42 G 0500 HTS 12 A 0 X"), "infinidrive");
  assert.equal(P.rollerBrand("GM A DU42 S 0000 GMO 27 A 0 A"), "infinidrive");
  assert.equal(P.rollerBrand("RD48"), "infinidrive");
  assert.equal(P.rollerBrand("FM24095"), "infinidrive");
  assert.equal(P.rollerBrand("nope"), null);
  assert.equal(P.rollerBrand(null), null);
});

t("getRollerByPn / isBrakeRoller", () => {
  const r = P.getRollerByPn("MR-BD-48-361-40-YWGQ-1168MM");
  assert.ok(r && r.pn === "MR-BD-48-361-40-YWGQ-1168MM");
  assert.equal(P.isBrakeRoller(r), true);
  assert.equal(P.isBrakeRoller(P.getRollerByPn("PM486FS-55-366-D-024-P2-JH")), false);
  assert.equal(P.isBrakeRoller(null), false);
  assert.equal(P.getRollerByPn("does-not-exist"), null);
});

t("compatibleCardsForSeries honours series + brake variants", () => {
  const rd = P.compatibleCardsForSeries("RD48", false);
  assert.ok(rd.indexOf("C100Z-35") >= 0, "RD48 includes C100Z-35");
  assert.ok(rd.indexOf("C100B") >= 0, "RD48 includes C100B");
  const rdBrake = P.compatibleCardsForSeries("RD48", true);
  assert.ok(rdBrake.indexOf("C100B") >= 0, "RD48 brake includes C100B");
  assert.ok(rdBrake.indexOf("C100Z-35") === -1, "RD48 brake excludes C100Z-35 (non-brake card)");
  assert.ok(rdBrake.length > 0 && rdBrake.length < rd.length, "brake list is a subset");
  const itoh = P.compatibleCardsForSeries("PM486FE", false);
  assert.deepStrictEqual(itoh, ["CB-016S7", "CBM-105F", "HB-510", "IB-E03A"]);
  const itohBrake = P.compatibleCardsForSeries("PM486FE", true);
  assert.deepStrictEqual(itohBrake, ["CB-016BS7-UL", "HBM-604B-UL"]);
  /* every returned card exists and lists the series (or is a brake/alias card) */
  for (const c of rd.concat(rdBrake, itoh, itohBrake)) assert.ok(P.DRIVER_CARDS[c], "card exists: " + c);
  assert.deepStrictEqual(P.compatibleCardsForSeries("NOPE", false), []);
  /* Microroll alias resolves to InfiniDrive cards */
  const mr = P.compatibleCardsForSeries("MICROROLL", false);
  assert.ok(mr.length > 0 && mr.indexOf("C100B") >= 0, "MICROROLL resolves to InfiniDrive cards");
});

t("findClosestSpeedCode matches the source algorithm (closest top speed)", () => {
  const rd = P.findClosestSpeedCode("RD48", 68);
  assert.ok(rd && rd.best.code === "27" && Math.abs(rd.diff) < 1e-9, "RD48 68 FPM -> code 27");
  /* source fidelity: Itoh codes are gear classes, so 60 FPM picks the closest fpmHigh (24) */
  const itoh = P.findClosestSpeedCode("PM486FE", 60);
  assert.ok(itoh && itoh.best.code === "35" && itoh.best.fpmHigh === 24, "PM486FE 60 FPM -> code 35 (source behaviour)");
  assert.equal(P.findClosestSpeedCode("NOPE", 60), null);
  /* EXTENSION pickSpeedCodeForTarget uses the published speed RANGE instead */
  const pick = P.pickSpeedCodeForTarget("PM486FE", 60);
  assert.ok(pick && pick.best.code === "30", "range-aware pick for 60 FPM -> code 30");
  const pickRd = P.pickSpeedCodeForTarget("RD48", 60);
  assert.ok(pickRd && pickRd.best.code === "27", "range-aware pick RD48 60 FPM -> code 27");
});

/* ======================================================================== */
/* 3. MECHANICS + PART-NUMBER BUILDERS                                      */
/* ======================================================================== */
t("calcDerived implements the source friction/torque formulas", () => {
  const d = P.calcDerived(BASE_INP);
  assert.equal(d.rollerBody, "Tapered");
  assert.equal(d.muStatic, 0.15);
  approx(d.theta, 5.454803430246373, 1e-9, "theta deg");
  approx(d.fTangential, 200 * 0.15 * Math.cos(d.theta * Math.PI / 180), 1e-9, "tangential force");
  approx(d.torque, d.fTangential * (1.9 / 2 * 0.15), 1e-9, "torque");
  const straight = P.calcDerived(inp({ curveType: "Straight" }));
  assert.equal(straight.rollerBody, "Straight");
  assert.equal(straight.muStatic, 0.10);
  assert.equal(straight.theta, 0);
  approx(straight.fTangential, 20, 1e-9, "straight tangential force");
});

t("lroller converts BF inches to tube length mm", () => {
  assert.equal(P.lroller(BASE_INP), 364);            /* round((15.1-0.78)*25.4) */
  assert.equal(P.lroller({ lbf: 15.0 }), 361);       /* 14.22*25.4 = 361.19 */
  assert.equal(P.lroller({ lbf: 0 }), -20);
});

t("buildItohPart produces the documented Itoh format", () => {
  const d = P.calcDerived(BASE_INP);
  assert.equal(P.buildItohPart(BASE_INP, d, 45), "PM486FE-45-364-D-024-G-B");
  assert.equal(P.buildItohPart(inp({ driveStyle: "Pulley" }), d, 45), "PM486FE-45-364-D-024-A-B");
  assert.equal(P.buildItohPart(inp({ curveType: "Straight" }), d, 30), "PM486FE-30-364-D-024-G-A");
  assert.match(P.buildItohPart(BASE_INP, d, 45), /^PM486FE-\d+-\d+-D-024-[AG]-[AB]$/);
  /* EXTENSION: series override keeps the source format */
  assert.match(P.buildItohPart(BASE_INP, d, 45, { series: "PM570FE" }), /^PM570FE-45-364-D-024-G-B$/);
});

t("buildMicrorollPart produces the documented legacy MR- format", () => {
  const d = P.calcDerived(BASE_INP);
  assert.equal(P.buildMicrorollPart(BASE_INP, d, 45), "MR-BD-364-45YWGQ");
  assert.match(P.buildMicrorollPart(BASE_INP, d, 45), /^MR-[AB]D-\d+-\d+Y[ZW][AG]Q$/);
  assert.equal(P.buildMicrorollPart(inp({ curveType: "Up Spiral" }), d, 40), "MR-AD-364-40YZGQ");
});

t("buildInfiniDrivePart produces the documented positional format", () => {
  const part = P.buildInfiniDrivePart(BASE_INP);
  assert.equal(part, "RC A DU42 G 0384 HTS 27 A 0 X"); /* BF 15.1" -> 0384 mm */
  assert.match(part, /^RC A DU42 G \d{4} HTS \d{2} A 0 X$/);
  assert.equal(P.buildInfiniDrivePart(inp({ driveStyle: "Pulley" })), "RC A DU42 P 0384 HTS 27 A 0 X");
  assert.equal(P.buildInfiniDrivePart(BASE_INP, { series: "RD50" }), "RC B DU42 G 0384 HTS 27 A 0 X");
  assert.equal(P.buildInfiniDrivePart(BASE_INP, { series: "RD63S" }), "RA E DU42 G 0384 HTS 27 A 0 X");
  assert.equal(P.buildInfiniDrivePart(BASE_INP, { series: "GM48" }), "GM A DU42 S 0000 GMO 27 A 0 A");
});

t("buildIdlerPart generates positional idler / documented Itoh placeholder", () => {
  const part = P.buildIdlerPart({ lbf: 23.622 }, { series: "RD48" });
  assert.equal(part, "RC A D000 G 0600 HTS XX A 0 X");
  assert.match(part, /D000 .* XX /);
  assert.match(P.buildIdlerPart({ lbf: 15 }, { series: "PM486FE" }), /^PM486FE-IDLER-\d+$/);
});

/* ======================================================================== */
/* 4. validateRoller                                                        */
/* ======================================================================== */
t("validateRoller accepts valid rollers", () => {
  const dStraight = P.calcDerived(inp({ curveType: "Straight" }));
  const straight = P.getRollerByPn("PM486FS-55-366-D-024-P2-JH"); /* grooved, frame 15", no taper */
  assert.equal(P.validateRoller(straight, inp({ curveType: "Straight" }), dStraight), "Valid");
  assert.deepStrictEqual(P.validateRollerReasons(straight, inp({ curveType: "Straight" }), dStraight), []);

  const curve = inp({ curveType: "Flat Curve" });
  const dCurve = P.calcDerived(curve);
  const tapered = P.getRollerByPn("MR-AD-48-361-40-YWGQ/TS"); /* tapered + grooved, frame 14.99" */
  assert.equal(P.validateRoller(tapered, curve, dCurve), "Valid");
});

t("validateRoller rejects frame-length mismatch", () => {
  const d = P.calcDerived(inp({ curveType: "Straight" }));
  const roller = P.getRollerByPn("MR-AD-48-742-40-YWGQ"); /* frame 29.99" */
  assert.equal(P.validateRoller(roller, inp({ curveType: "Straight" }), d), "Invalid");
  const reasons = P.validateRollerReasons(roller, inp({ curveType: "Straight" }), d);
  assert.ok(reasons.some(r => /frame/i.test(r)), "frame reason: " + reasons.join("; "));
});

t("validateRoller rejects taper/brake/groove/pulley mismatches", () => {
  const flat = inp({ curveType: "Flat Curve" });
  const dFlat = P.calcDerived(flat);
  /* tapered body required but roller is not tapered */
  assert.equal(P.validateRoller(P.getRollerByPn("MR-AD-48-361-40-YWGQ"), flat, dFlat), "Invalid");

  const down = inp({ curveType: "Down Spiral" });
  const dDown = P.calcDerived(down);
  /* down spiral needs braking, this one has no brake */
  assert.equal(P.validateRoller(P.getRollerByPn("MR-AD-48-361-40-YWGQ/TS"), down, dDown), "Invalid");

  /* standard drive needs grooves */
  const nonGrooved = inp({ curveType: "Straight", lbf: 16.69 });
  assert.equal(P.validateRoller(P.getRollerByPn("INF-RD60-001"), nonGrooved, P.calcDerived(nonGrooved)), "Invalid");

  /* pulley drive is incompatible with a tapered roller */
  const pulley = inp({ curveType: "Straight", driveStyle: "Pulley", lbf: 12.992125984252 });
  assert.equal(P.validateRoller(P.getRollerByPn("PM486FS-30-315-D-024-JT-P2-OS"), pulley, P.calcDerived(pulley)), "Invalid");

  assert.equal(P.validateRoller(null, BASE_INP, P.calcDerived(BASE_INP)), "Invalid");
});

/* ======================================================================== */
/* 5. recommendRoller                                                       */
/* ======================================================================== */
t("recommendRoller returns roller + card + speed code (InfiniDrive demo)", () => {
  const rec = P.recommendRoller({ widthM: 0.6, zoneLengthM: 1.0, targetFpm: 60, application: "zpa" });
  assert.ok(rec.partNumber, "part number");
  assert.equal(rec.brand, "infinidrive");
  assert.equal(rec.series, "RD48");
  assert.match(rec.partNumber, /^RC A DU42 G 0600 HTS 27 A 0 X$/);
  assert.ok(rec.roller && rec.roller.pn === rec.partNumber, "roller.pn mirrors partNumber");
  assert.ok(rec.driverCard && P.DRIVER_CARDS[rec.driverCard], "driver card in registry");
  assert.ok(P.compatibleCardsForSeries(rec.series, rec.isBrake).indexOf(rec.driverCard) >= 0,
    "recommended card is compatible");
  assert.equal(rec.driverCard, "C100Z-35", "35 W ZPA card for RD48");
  assert.equal(rec.speedCode, "27");
  assert.ok(Array.isArray(rec.warnings) && rec.warnings.length > 0, "warnings explain generated P/N");
  assert.ok(rec.inp.lbf > 23 && rec.inp.lbf < 24, "metric width mapped to inches");
});

t("recommendRoller supports Itoh Denki series + range-aware speed code", () => {
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa", series: "PM486FE" });
  assert.equal(rec.brand, "itoh");
  assert.equal(rec.series, "PM486FE");
  assert.equal(rec.partNumber, "PM486FE-30-580-D-024-G-A");
  assert.equal(rec.driverCard, "HB-510", "ZPA card for Itoh series");
  assert.equal(rec.speedCode, "30");
});

t("recommendRoller prefers a matching database roller when frame matches", () => {
  /* 15.0" BF = 0.381 m -> PM486FS-55-366-D-024-P2-JH (frame 15.0") validates */
  const rec = P.recommendRoller({ widthM: 15.0 / (1000 / 25.4), targetFpm: 60, application: "standard", series: "PM486FS" });
  assert.equal(rec.partNumber, "PM486FS-55-366-D-024-P2-JH");
  assert.ok(!rec.roller.synthesized, "DB roller, not synthesized");
});

t("recommendRoller brake application selects brake roller/card", () => {
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 45, application: "brake" });
  assert.equal(rec.isBrake, true);
  assert.equal(rec.roller.braking, true, "synthesized brake roller");
  assert.ok(rec.driverCard && P.DRIVER_CARDS[rec.driverCard], "brake-capable card");
  assert.ok(P.compatibleCardsForSeries(rec.series, true).indexOf(rec.driverCard) >= 0,
    "card is from the brake list");
});

t("recommendRoller respects requested driver card override", () => {
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa",
    series: "RD48", driverCard: "C100Z-35" });
  assert.equal(rec.driverCard, "C100Z-35");
  const bad = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa",
    series: "RD48", driverCard: "CB-016S7" }); /* Itoh card on an InfiniDrive roller */
  assert.notEqual(bad.driverCard, "CB-016S7", "incompatible override rejected");
  assert.ok(bad.warnings.some(w => /CB-016S7/.test(w)), "override warning");
});

t("recommendRoller unknown series falls back to design default RD48", () => {
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa", series: "NO_SUCH_SERIES" });
  assert.equal(rec.series, "RD48");
  assert.ok(rec.partNumber && rec.driverCard);
});

t("recommendRoller low-temp env and out-of-range width produce warnings", () => {
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa", env: "lt" });
  assert.ok(rec.warnings.some(w => /low-temperature/i.test(w)), "low temp warning");
  const narrow = P.recommendRoller({ widthM: 0.1, targetFpm: 60, application: "zpa" });
  assert.ok(narrow.warnings.some(w => /between-frame length/i.test(w)), "width range warning");
});

/* ======================================================================== */
/* 5b. MODEL V2 - standardized tapered rollers (curve/spiral segments)     */
/* ======================================================================== */
t("taper helpers: standard series, delta and radius metadata", () => {
  assert.equal(P.normalizeTaperSeries("MR-AD-48-/TS"), "MICROROLL");
  assert.equal(P.normalizeTaperSeries("PM486FS"), "PM486FS");
  assert.equal(P.normalizeTaperSeries("nonsense"), "PM486FS", "falls back to the model taper default");
  const radii = M.standardCurveRadii(0.6);
  assert.ok(radii.length >= 6, "standard curve radii");
  const ts20 = radii.find(r => r.id === "TS-20");
  assert.ok(ts20 && Math.abs(ts20.radiusM - 1.748) < 0.005, "TS-20 gives R1.748 m at 600 mm width");
  assert.equal(ts20.series, "PM486FS");
  const nearest = M.nearestStandardTaper(0.6, 1.748);
  assert.equal(nearest.standard.id, "TS-20");
  assert.equal(nearest.ok, true, "requested radius within tolerance");
  const info = P.taperStandardInfo({ standardId: "TS-20", series: "PM486FS", deltaM: 0.02,
    standardRadiusM: 1.748, requestedRadiusM: 1.748, deviationPct: 0, withinTolerance: true,
    coneHalfAngleDeg: 0.955 });
  assert.equal(info.standardId, "TS-20");
  assert.equal(info.deltaM, 0.02);
  assert.equal(info.deltaMm, 20);
  assert.equal(info.radiusM, 1.748);
  assert.match(info.label, /PM486FS taper 20 mm \(TS-20\)/);
});

t("buildTaperedRollerPart/buildTaperedIdlerPart encode the standard taper", () => {
  const taper = { standardId: "TS-20", series: "PM486FS", deltaM: 0.02, standardRadiusM: 1.748,
    requestedRadiusM: 1.748, deviationPct: 0, withinTolerance: true };
  const bf = 0.6 * (1000 / 25.4); /* 600 mm face width */
  const straight = inp({ lbf: bf, curveType: "Flat Curve" });
  const down = inp({ lbf: bf, curveType: "Down Spiral" });
  const mot = P.buildTaperedRollerPart(straight, P.calcDerived(straight), "30", taper, { series: "PM486FS" });
  assert.equal(mot, "PM486FS-30-580-D-024-G-A-TS20");
  const brake = P.buildTaperedRollerPart(down, P.calcDerived(down), "30", taper,
    { series: "PM486FS", braking: true });
  assert.equal(brake, "PM486FS-30-580-D-024-G-B-TS20");
  assert.match(P.buildTaperedIdlerPart(straight, taper, { series: "PM486FS" }), /^PM486FS-IDLER-\d+-TS20$/);
  /* Microroll TS-26 uses the legacy "/TS" sleeve suffix */
  const mr = P.buildTaperedRollerPart(down, P.calcDerived(down), null,
    { standardId: "TS-26", series: "MR-AD-48-/TS", deltaM: 0.026, withinTolerance: true }, {});
  assert.match(mr, /^MR-BD-\d+-\d+YWGQ\/TS$/);
});

t("recommendRoller with a taper record returns tapered P/N + taper metadata", () => {
  const taper = { standardId: "TS-20", series: "PM486FS", deltaM: 0.02, standardRadiusM: 1.748,
    requestedRadiusM: 1.748, deviationPct: 0, withinTolerance: true, coneHalfAngleDeg: 0.955 };
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa",
    series: "PM486FS", taper: taper });
  assert.equal(rec.isTapered, true);
  assert.equal(rec.taper.standardId, "TS-20");
  assert.match(rec.partNumber, /^PM486FS-30-580-D-024-G-A-TS20$/);
  assert.match(rec.roller.desc, /taper 20 mm \(TS-20\)/);
  assert.match(rec.roller.desc, /R1\.748 m/);
  assert.equal(rec.roller.tapered, true);
  assert.equal(rec.roller.braking, false);
  assert.ok(rec.driverCard && P.DRIVER_CARDS[rec.driverCard], "driver card selected");
  const brake = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa",
    series: "PM486FS", taper: taper, brake: true });
  assert.equal(brake.isBrake, true);
  assert.match(brake.partNumber, /-G-B-TS20$/);
  assert.match(brake.roller.desc, /brake/);
});

/* ======================================================================== */
/* 6. selectComponents (2 segments / 6 zones)                              */
/* ======================================================================== */
const design = demoDesign();
const computed = M.computeDesign(design);
assert.equal(computed.totals.zones, 6, "fixture has 6 zones");
const selections = P.selectComponents(design, computed, {});

t("selectComponents: 6 zones / 6 motorized rollers / 6 cards / 6 sensors / 2 blocks", () => {
  assert.equal(selections.zones.length, 6, "zone rows");
  assert.equal(selections.zones.filter(z => z.motorized === true).length, 6, "motorized rollers");
  assert.equal(selections.zones.filter(z => z.driverCard).length, 6, "driver cards");
  assert.equal(selections.zones.filter(z => z.sensorPn).length, 6, "sensors");
  /* one 1799ER block serves a whole ZPA group: 2 segments -> 2 groups/blocks */
  const uniqueBlocks = new Set(selections.zones.map(z => z.blockName).filter(Boolean));
  assert.equal(uniqueBlocks.size, 2, "I/O blocks (one per ZPA group)");
  assert.equal(selections.stats.motorizedRollers, 6);
  assert.equal(selections.stats.driverCards, 6);
  assert.equal(selections.stats.sensors, 6);
  assert.equal(selections.stats.blocks, 2, "one block per group");
  assert.deepStrictEqual(selections.errors, [], "no selection errors");
});

t("selectComponents: idle rollers = ceil(zoneLength/rollerPitch) per zone; 60 total", () => {
  assert.equal(selections.segmentRollers.length, 2, "segment roller rows");
  const s1 = selections.segmentRollers.find(s => s.segmentName === "SEG1");
  const s2 = selections.segmentRollers.find(s => s.segmentName === "SEG2");
  assert.equal(s1.motorizedCount, 4);
  assert.equal(s2.motorizedCount, 2);
  assert.equal(s1.idleCount, 40, "SEG1: 4 zones x ceil(1.0/0.1) idle");
  assert.equal(s2.idleCount, 20, "SEG2: 2 zones x ceil(1.0/0.1) idle");
  const totalIdle = selections.segmentRollers.reduce((a, s) => a + s.idleCount, 0);
  assert.ok(totalIdle > 0, "idle roller qty > 0");
  assert.equal(totalIdle, 60);
  assert.match(s1.idleRollerPn, /D000/);
  assert.ok(s1.idleRollerPn !== selections.zones[0].rollerPn, "idler P/N differs from motorized");
});

t("selectComponents: per-zone fields per contract", () => {
  selections.zones.forEach((z, i) => {
    assert.equal(z.zoneIndex, i, "zone index");
    assert.ok(z.segmentName && z.zoneName, "segment/zone names");
    assert.equal(z.zoneName, z.segmentName + "_Z" + (z.zoneInSegment + 1), "zoneName format");
    assert.ok(z.rollerSeries && z.rollerPn && z.rollerDesc, "roller fields");
    assert.equal(z.motorized, true);
    assert.equal(z.driverCard, "C100Z-35", "design default card honoured");
    assert.equal(z.driverDesc.length > 0, true, "driver description");
    assert.equal(z.sensorPn, "BANQS18VP6LPQ8", "sensor resolved from catalog");
    assert.match(z.sensorDesc, /PHOTO/i);
    assert.match(z.blockName, /^ZPA\d{2}$/);
    assert.equal(z.blockCatalog, "1799ER-IQ10XOQ10/A");
    assert.equal(z.blockPn, "1799ER-IQ10XOQ10", "block P/N normalised via catalog");
    assert.equal(z.cable, "CBL-M12-5M", "per-zone cable");
    assert.ok(Array.isArray(z.warnings), "per-zone warnings array");
  });
});

t("selectComponents: deterministic + computed auto-derives when omitted", () => {
  const again = P.selectComponents(design, computed, {});
  assert.deepStrictEqual(again, selections, "deterministic output");
  const auto = P.selectComponents(design, null, {});
  assert.equal(auto.zones.length, 6, "computed derived from design");
  const empty = P.selectComponents({ name: "EMPTY", segments: [] }, null, {});
  assert.equal(empty.zones.length, 0);
  assert.ok(empty.warnings.length > 0);
});

t("selectComponents: design motorSeries/driverCard overrides + warnings", () => {
  const d2 = demoDesign();
  d2.defaults.motorSeries = "PM486FE";
  /* C100Z-35 (model default) is not an Itoh card -> warning + recommended card used */
  const sel = P.selectComponents(d2, M.computeDesign(d2), {});
  assert.match(sel.zones[0].rollerPn, /^PM486FE-/);
  assert.match(sel.zones[0].rollerPn, /^PM486FE-30-\d+-D-024-G-A$/);
  assert.equal(sel.zones[0].driverCard, "HB-510");
  assert.ok(sel.warnings.some(w => /C100Z-35/.test(w)), "incompatible configured card warned");
  assert.ok(sel.warnings.some(w => /Itoh Denki idler/i.test(w)), "Itoh idler placeholder warned");
});

/* ======================================================================== */
/* 6b. MODEL V2 - curve/spiral tapered roller selection                    */
/* ======================================================================== */
function curveDesign() {
  const d = M.createDefaultDesign();
  d.name = "CURVE_DEMO";
  d.segments = [
    { id: "s1", name: "SEG1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0,
      lengthM: 4, widthM: 0.6, zones: 4, zoneLengthM: 1, motorSeries: null, driverCard: null },
    { id: "s2", name: "CURVE", kind: "curve", turnDeg: 0, curveDeg: 90, radiusM: 1.748,
      widthM: 0.6, zones: 2, zoneLengthM: 1, motorSeries: null, driverCard: null }
  ];
  return d;
}
const curveD = curveDesign();
const curveC = M.computeDesign(curveD);
assert.equal(curveC.totals.curvedZones, 2, "curve fixture has 2 curved zones");
const curveSel = P.selectComponents(curveD, curveC, {});

t("curve zones select standardized tapered rollers (TS-20, 20 mm, R1.748 m)", () => {
  const seg = curveC.segments[1];
  assert.equal(seg.taper.standardId, "TS-20");
  assert.equal(seg.taper.deltaM, 0.02);
  assert.ok(Math.abs(seg.taper.standardRadiusM - 1.748) < 0.005, "standard radius");
  assert.equal(seg.taper.withinTolerance, true);
  const curved = curveSel.zones.filter(z => z.curved);
  assert.equal(curved.length, 2, "two tapered zones");
  for (const z of curved) {
    assert.equal(z.rollerType, "tapered");
    assert.match(z.rollerPn, /^PM486FS-\d+-\d+-D-024-G-A-TS20$/);
    assert.match(z.rollerDesc, /taper 20 mm \(TS-20\)/);
    assert.match(z.rollerDesc, /R1\.748 m/);
    assert.ok(z.taper && z.taper.standardId === "TS-20");
    assert.equal(z.taper.deltaMm, 20);
    assert.equal(z.driverCard, "HB-510", "Itoh ZPA card for the tapered Itoh series");
  }
  const straight = curveSel.zones.filter(z => z.segmentName === "SEG1");
  assert.equal(straight.length, 4);
  assert.ok(straight.every(z => z.rollerType === "cylindrical"), "straight zones stay cylindrical");
  assert.ok(curveSel.stats.taperedRollers > 0);
  assert.equal(curveSel.stats.taperedRollerZones, 2);
  assert.ok(curveSel.warnings.some(w => /Curved\/spiral zones use PM486FS/.test(w)),
    "mixed tapered/cylindrical roller types warned");
});

t("curve segment rollers: tapered idler count = rollerCountApprox - 1 per zone", () => {
  const segRow = curveSel.segmentRollers.find(s => s.segmentName === "CURVE");
  assert.ok(segRow, "curved segment roller row");
  assert.equal(segRow.rollerType, "tapered");
  assert.equal(segRow.taper.standardId, "TS-20");
  assert.match(segRow.idleRollerPn, /^PM486FS-IDLER-\d+-TS20$/);
  const expected = curveC.zones.filter(z => z.curved)
    .reduce((a, z) => a + Math.max(0, z.rollerCountApprox - 1), 0);
  assert.equal(segRow.idleCount, expected, "tapered idler count from rollerCountApprox");
});

t("taper feasibility: non-standard radius / excessive delta are warned", () => {
  const d = M.createDefaultDesign();
  d.segments = [{ id: "c1", name: "C1", kind: "curve", curveDeg: 90, radiusM: 1.3,
    widthM: 0.6, zones: 2, zoneLengthM: 1 }];
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  const w = sel.warnings.find(x => /not a standard tapered-roller radius/.test(x));
  assert.ok(w, "non-standard radius warning present: " + sel.warnings.join(" | "));
  assert.match(w, /nearest TS-\d+/);
  assert.match(w, /% off/);

  const tight = M.createDefaultDesign();
  tight.segments = [{ id: "c2", name: "C2", kind: "curve", curveDeg: 90, radiusM: 0.4,
    widthM: 0.6, zones: 2, zoneLengthM: 1 }];
  const tc = M.computeDesign(tight);
  const tsel = P.selectComponents(tight, tc, {});
  assert.ok(tsel.warnings.some(x => /taper delta/.test(x) && /beyond the standardized set/.test(x)),
    "excessive taper delta warning: " + tsel.warnings.join(" | "));
});

/* ---- down spiral: braking rollers + brake driver cards ------------------ */
const spiralD = M.createDefaultDesign();
spiralD.name = "SPIRAL_DOWN";
spiralD.segments = [{ id: "sp1", name: "SPIRAL_DN", kind: "spiral", radiusM: 1.748,
  widthM: 0.6, zoneLengthM: 2.5, spiral: { pitchM: 0.5, heightM: 0.5, direction: "down" },
  motorSeries: null, driverCard: null }];
const spiralC = M.computeDesign(spiralD);
const spiralSel = P.selectComponents(spiralD, spiralC, {});

t("down spiral selects braking tapered rollers + brake driver card + warning", () => {
  assert.ok(spiralC.totals.taperedRollerCount > 0, "spiral has tapered rollers");
  const z = spiralSel.zones[0];
  assert.equal(z.rollerType, "tapered");
  assert.match(z.rollerPn, /-G-B-TS20$/, "braking (-B) tapered P/N");
  assert.match(z.rollerDesc, /brake/);
  assert.ok(P.compatibleCardsForSeries(z.rollerSeries, true).indexOf(z.driverCard) >= 0,
    "driver card from the brake list: " + z.driverCard);
  assert.ok(spiralSel.warnings.some(w => /down spiral requires BRAKING tapered rollers/i.test(w)),
    "down spiral warning");
  assert.ok(spiralSel.warnings.every(w => !/does not document brake control/.test(w)),
    "brake-capable card accepted");
});

/* ---- belt conveyor selection ------------------------------------------- */
function beltDesign(overrides) {
  const d = M.createDefaultDesign();
  d.name = "BELT_CONVEYOR";
  d.conveyorType = "belt";
  d.segments = [
    { id: "b1", name: "BELT1", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0, turnDeg: 0,
      lengthM: 6, widthM: 0.8, zones: 3, zoneLengthM: 2, motorSeries: null, driverCard: null },
    { id: "b2", name: "SPIRAL_UP", kind: "spiral", turnDeg: 0, radiusM: 1.4, widthM: 0.8,
      zoneLengthM: 2, spiral: { pitchM: 0.9, heightM: 2.7, direction: "up" },
      motorSeries: null, driverCard: null },
    { id: "b3", name: "BELT2", kind: "straight", turnDeg: 30, lengthM: 4, widthM: 0.8,
      zones: 2, zoneLengthM: 2, motorSeries: null, driverCard: null }
  ];
  d.scanZones = [{ id: "scan1", name: "SCAN_IN", segmentId: "b1", offsetM: 5,
    type: "barcode", side: "right", tagName: null }];
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20, trayLengthM: 0.6,
    trayGapM: 0.3, tagPrefix: "TRACK" };
  if (overrides) Object.assign(d.defaults.belt, overrides);
  return d;
}
const beltD = beltDesign();
const beltC = M.computeDesign(beltD);
const beltSel = P.selectComponents(beltD, beltC, {});

t("belt design: no ZPA rollers/cards/blocks; belt components per segment", () => {
  assert.equal(beltC.totals.beltSegments, 3, "3 belt segments");
  assert.equal(beltSel.zones.filter(z => z.motorized).length, 0, "no motorized ZPA rollers");
  assert.equal(beltSel.segmentRollers.length, 0, "no roller segments");
  assert.equal(beltSel.stats.blocks, 0, "no ZPA blocks for a belt conveyor");
  assert.equal(beltSel.stats.beltSegments, 3);
  assert.equal(beltSel.stats.beltDrives, 3);
  assert.equal(beltSel.stats.pulleys, 6);
  assert.equal(beltSel.belts.length, 3);
  for (const b of beltSel.belts) {
    assert.match(b.beltPn, /^BELT-.*-BF800$/);
    assert.match(b.headPulleyPn, /^PULLEY-HD-D120-BF800$/);
    assert.match(b.tailPulleyPn, /^PULLEY-TL-D120-BF800$/);
    assert.equal(b.vfdPn, "25B-D2P3N104", "0.75 kW PowerFlex 525");
    assert.equal(b.commCardPn, "25-COMM-E2P");
    assert.equal(b.driveMotorPn, "MOTOR-GM-0P75KW-4P");
    assert.match(b.tensionerPn, /^TENSIONER-BELT-BF800$/);
    assert.equal(b.trackingSensors, 2, "2 belt-tracking sensors per belt drive");
  }
  const expectedLen = beltC.segments.reduce((a, s) => a + s.lengthM, 0);
  assert.ok(Math.abs(beltSel.stats.beltLengthM - expectedLen) < 0.05, "belt length incl spiral");
  assert.ok(beltSel.stats.beltLengthM > 30, "spiral included in belt length");
});

t("belt design: scan zone selection + tracking state", () => {
  assert.equal(beltSel.scanners.length, 1);
  const s = beltSel.scanners[0];
  assert.equal(s.type, "barcode");
  assert.equal(s.scannerPn, "MATRIX-220-210-010", "vendor-style barcode scanner estimate");
  assert.equal(s.scannerSource, "estimate");
  assert.ok(s.zoneIndex1Based > 0 && s.tagName, "scan zone mapped to a ZPA zone tag");
  assert.equal(beltSel.tracking.enabled, true);
  assert.equal(beltSel.stats.trackingEnabled, true);
});

t("belt spiral slope limits + belt down spiral warnings", () => {
  const steep = beltDesign();
  steep.segments[1].spiral = { pitchM: 1.8, heightM: 1.8, direction: "up" }; /* ~11.6 deg */
  const sc = M.computeDesign(steep);
  const ssel = P.selectComponents(steep, sc, {});
  assert.ok(ssel.warnings.some(w => /belt spiral slope .*exceeds the recommended/i.test(w)),
    "belt spiral slope warning: " + ssel.warnings.join(" | "));
  const down = beltDesign();
  down.segments[1].spiral = { pitchM: 0.9, heightM: 2.7, direction: "down" };
  const dc = M.computeDesign(down);
  const dsel = P.selectComponents(down, dc, {});
  assert.ok(dsel.warnings.some(w => /down spiral on a belt conveyor.*brake\/backstop/i.test(w)),
    "belt down spiral warning: " + dsel.warnings.join(" | "));
});

/* ---- scan zones: readers, mounts, cables -------------------------------- */
t("scan zones: one scanner/camera per scanned zone with mount + cable", () => {
  const d = M.createDefaultDesign();
  d.name = "SCAN_DEMO";
  d.segments = [{ id: "s1", name: "SEG1", kind: "straight", lengthM: 4, widthM: 0.6,
    zones: 4, zoneLengthM: 1 }];
  d.scanZones = [
    { id: "sc1", name: "SCAN_1", segmentId: "s1", offsetM: 1.5, type: "barcode" },
    { id: "sc2", name: "SCAN_2", segmentId: "s1", offsetM: 3.0, type: "camera" }
  ];
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20 };
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  assert.equal(sel.scanners.length, 2);
  const bar = sel.scanners.find(s => s.type === "barcode");
  const cam = sel.scanners.find(s => s.type === "camera");
  assert.ok(bar && bar.scannerPn, "barcode reader selected");
  assert.ok(cam && cam.scannerPn, "camera selected");
  if (cam.scannerSource === "parts-catalog") {
    assert.match(cam.scannerPn, /^DMR-302X/, "plant-catalog camera assembly used");
  } else {
    assert.match(cam.scannerPn, /^CAM-/, "estimate camera P/N when the catalog has no camera");
  }
  assert.ok(sel.scanners.every(s => s.mountPn && s.cablePn), "mount + cable per scanner");
  assert.equal(sel.stats.scanners, 2);
  assert.equal(sel.stats.scanZones, 2);
});

t("tracking/scan-zone pairing warnings", () => {
  const d = M.createDefaultDesign();
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20 };
  const sel = P.selectComponents(d, M.computeDesign(d), {});
  assert.ok(sel.warnings.some(w => /no scan zones are defined/i.test(w)),
    "tracking without scan zones warns");
  const d2 = M.createDefaultDesign();
  d2.scanZones = [{ id: "s1", name: "SCAN", segmentId: "seg1", offsetM: 1, type: "barcode" }];
  const sel2 = P.selectComponents(d2, M.computeDesign(d2), {});
  assert.ok(sel2.warnings.some(w => /tray tracking is disabled/i.test(w)),
    "scan zones without tracking warns");
});

/* ======================================================================== */
/* 6f. MODEL V3 - merge junctions + transfer devices                       */
/* ======================================================================== */
/* Main line + two spur lines feeding merge junctions (one close gap 0.5 m and one
   far gap 1.2 m), plus one pusher, one rotary table (90 deg) and one pop-up. */
function mergeTransferDesign() {
  const d = M.createDefaultDesign();
  d.name = "MERGES_TRANSFERS";
  d.segments = [
    { id: "main", name: "MAIN", kind: "straight", x: 0, y: 0, z: 0, rotationDeg: 0,
      turnDeg: 0, lengthM: 6, widthM: 0.6, zones: 6, zoneLengthM: 1, newChain: true,
      motorSeries: null, driverCard: null },
    { id: "spurA", name: "SPURA", kind: "straight", x: 4, y: -2.5, z: 0,
      rotationDeg: 90, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2,
      zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null },
    { id: "spurB", name: "SPURB", kind: "straight", x: 5, y: -3.2, z: 0,
      rotationDeg: 90, turnDeg: 0, lengthM: 2, widthM: 0.6, zones: 2,
      zoneLengthM: 1, newChain: true, motorSeries: null, driverCard: null }
  ];
  d.merges = [
    { id: "mg1", name: "MERGE1", mainSegmentId: "main", offsetM: 4,
      spurEndSegmentId: "spurA", priority: "alternate" },
    { id: "mg2", name: "MERGE2", mainSegmentId: "main", offsetM: 5,
      spurEndSegmentId: "spurB", priority: "main" }
  ];
  d.transfers = [
    { id: "t1", name: "PUSHER1", type: "pusher", segmentId: "main", offsetM: 1.5,
      side: "right", extendTimeS: 0.8 },
    { id: "t2", name: "ROTARY1", type: "rotary_table", segmentId: "main", offsetM: 2.5,
      stepDeg: 90, homeAngleDeg: 0 },
    { id: "t3", name: "POPUP1", type: "popup_transfer", segmentId: "main", offsetM: 3.5,
      directions: ["left", "right"], beltCount: 3 }
  ];
  return d;
}
const mtD = mergeTransferDesign();
const mtC = M.computeDesign(mtD);
const mtSel = P.selectComponents(mtD, mtC, {});

t("model v3: merge + transfer model data flows through the selection", () => {
  assert.equal(mtC.totals.merges, 2, "2 merge junctions");
  assert.equal(mtC.totals.transfers, 3, "3 transfer devices");
  assert.equal(mtC.totals.deviceBlocks, 3, "one device I/O block per transfer");
  assert.equal(mtC.merges.length, 2);
  assert.equal(mtC.transfers.length, 3);
  const mg = mtC.merges[0];
  assert.ok(mg.mergeZoneIndex1Based >= 1 && mg.spurZoneIndex1Based >= 1,
    "merge/spur zones mapped");
  assert.ok(Math.abs(mg.gapM - 0.5) < 1e-6, "close spur gap 0.5 m: " + mg.gapM);
  const far = mtC.merges[1];
  assert.ok(far.gapM > 1.0, "far spur gap > 1 m: " + far.gapM);
  /* selection: merges/transfers present, stats expose the new devices */
  assert.equal(mtSel.merges.length, 2);
  assert.equal(mtSel.transfers.length, 3);
  assert.deepStrictEqual(mtSel.errors, []);
  assert.equal(mtSel.stats.merges, 2);
  assert.equal(mtSel.stats.transfers, 3);
  assert.equal(mtSel.stats.pushers, 1);
  assert.equal(mtSel.stats.rotaryTables, 1);
  assert.equal(mtSel.stats.popupTransfers, 1);
  assert.equal(mtSel.stats.bidirectionalTransfers, 2, "rotary + pop-up are bidirectional");
  assert.equal(mtSel.stats.deviceBlocks, 3);
  assert.equal(mtSel.stats.ioBlocksTotal, mtSel.stats.blocks + 3,
    "device blocks add to the ZPA group blocks");
  assert.equal(mtSel.stats.blocks, 3, "3 ZPA groups (1 main + 2 spur segments)");
});

t("model v3: merge junction hardware (nose/throat kit, presence sensor, guides)", () => {
  const close = mtSel.merges[0];
  assert.equal(close.gapM, 0.5);
  assert.ok(close.noseKit, "nose/throat plate kit for gap > 0.3 m");
  assert.match(close.noseKit.pn, /^MERGE-NOSE-BF600-G500$/);
  assert.match(close.noseKit.description, /500 mm spur gap/);
  const cats = close.components.map(c => c.category + ":" + c.pn);
  assert.ok(cats.some(c => /^Sensors:/.test(c)), "extra merge presence sensor");
  assert.ok(cats.some(c => /^Mechanical:MERGE-GUIDE-BF600$/.test(c)), "merge guide rails/brackets");
  /* the merge zone rollers/cards are part of the normal zone selection (no double) */
  assert.equal(close.mergeZoneIndex1Based, mtC.merges[0].mergeZoneIndex1Based);
  assert.equal(mtSel.zones.filter(z => z.zoneIndex === close.mergeZoneIndex1Based - 1).length, 1,
    "merge zone selected once by the zone logic");

  const far = mtSel.merges[1];
  assert.ok(far.noseKit, "far-gap merge still gets a nose kit");
  assert.match(far.noseKit.pn, /G1200$/);
  assert.ok(far.warnings.some(w => /throat plate adapter is REQUIRED/i.test(w)),
    "gap > 1.0 m throat plate warning");
  assert.ok(far.warnings.some(w => /priority 'main'/i.test(w)),
    "non-alternating priority warning");
  assert.ok(close.warnings.length === 0, "close alternate-priority merge has no warnings");
  assert.ok(mtSel.warnings.some(w => /throat plate adapter is REQUIRED/i.test(w)),
    "merge warnings bubble up to the selection warnings");
});

t("model v3: pusher transfer components (kit, air prep, valve cable, one-way)", () => {
  const pusher = mtSel.transfers.find(t => t.type === "pusher");
  assert.ok(pusher, "pusher selection present");
  assert.equal(pusher.bidirectional, false);
  assert.equal(pusher.ioBlock.name, "XFER01");
  assert.ok(pusher.ioBlock.pn && pusher.ioBlock.ip, "device I/O block info");
  assert.equal(pusher.ioBlock.inputMap.length, 4, "pusher input map");
  assert.equal(pusher.ioBlock.outputMap.length, 3, "pusher output map");
  const kit = pusher.components.find(c => /Pneumatic pusher kit/i.test(c.description));
  assert.ok(kit, "pneumatic pusher kit row");
  assert.equal(kit.qty, 1);
  assert.match(kit.description, /one-way divert \(single direction: right\)/i);
  assert.ok(pusher.components.some(c => /Air preparation/i.test(c.description)), "air prep row");
  assert.ok(pusher.components.some(c => c.category === "Cabling"), "valve cable row");
  assert.ok(pusher.warnings.some(w => /one-way divert/i.test(w)), "one-way divert warning");
});

t("model v3: rotary table components (assembly, drive, controller, 4 sensors, cable)", () => {
  const rotary = mtSel.transfers.find(t => t.type === "rotary_table");
  assert.ok(rotary, "rotary table selection present");
  assert.equal(rotary.bidirectional, true);
  const assembly = rotary.components.find(c => /Turntable assembly/i.test(c.description));
  assert.ok(assembly && assembly.qty === 1, "turntable assembly (top plate + bearing ring)");
  assert.match(assembly.description, /bidirectional router/i);
  const drive = rotary.components.find(c => c.category === "Power");
  assert.ok(drive, "turntable drive row");
  const controller = rotary.components.find(c => c.category === "Driver cards");
  assert.ok(controller, "controller / I/O module row");
  const positions = rotary.components.find(c => /position sensor/i.test(c.description));
  assert.ok(positions, "position sensor set");
  assert.equal(positions.qty, 4, "home + 90/180/270 for a 90 deg step");
  assert.ok(rotary.components.some(c => c.category === "Cabling"), "power/control cable row");
  assert.ok(rotary.warnings.some(w => /bidirectional/i.test(w)),
    "bidirectional transfer warning");
  /* non-90 deg index uses the 2-sensor minimum and warns */
  const d = mergeTransferDesign();
  d.transfers = [{ id: "r45", name: "ROT45", type: "rotary_table", segmentId: "main",
    offsetM: 2, stepDeg: 45 }];
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  const pos45 = sel.transfers[0].components.find(x => /position sensor/i.test(x.description));
  assert.equal(pos45.qty, 2, "2 position sensors minimum for a non-90 deg index");
  assert.ok(sel.transfers[0].warnings.some(w => /non-90 deg index/i.test(w)), "index warning");
  const d2 = mergeTransferDesign();
  d2.transfers = [{ id: "r15", name: "ROT15", type: "rotary_table", segmentId: "main",
    offsetM: 2, stepDeg: 15 }];
  const sel2 = P.selectComponents(d2, M.computeDesign(d2), {});
  assert.ok(sel2.transfers[0].warnings.some(w => /outside the recommended 30\.\.180/i.test(w)),
    "stepDeg outside 30..180 warning");
});

t("model v3: pop-up transfer components (cross-belt qty = beltCount, lift, motor, limits, sensors)", () => {
  const popup = mtSel.transfers.find(t => t.type === "popup_transfer");
  assert.ok(popup, "pop-up selection present");
  assert.equal(popup.bidirectional, true);
  const modules = popup.components.find(c => /Cross-belt transfer module/i.test(c.description));
  assert.ok(modules, "cross-belt module row");
  assert.equal(modules.qty, 3, "qty = popup.beltCount");
  assert.match(modules.description, /BIDIRECTIONAL \(left\/right belt direction\)/);
  assert.ok(popup.components.some(c => /raise\/lower mechanism/i.test(c.description)), "lift kit row");
  const motor = popup.components.find(c => c.category === "Power");
  assert.ok(motor && /chain drive/i.test(motor.description), "one chain-drive motor per transfer");
  const limits = popup.components.find(c => /limit switch/i.test(c.description));
  assert.ok(limits && limits.qty === 2, "2 up/down limit switches");
  const sensors = popup.components.find(c => /tray presence/i.test(c.description));
  assert.ok(sensors && sensors.qty === 3, "3 tray/side-clear sensors");
  assert.ok(popup.components.some(c => c.category === "Cabling"), "cable row");
  assert.ok(popup.warnings.some(w => /bidirectional/i.test(w)), "bidirectional warning");
  /* wide unit: beltCount > 4 warns */
  const d = mergeTransferDesign();
  d.transfers = [{ id: "p5", name: "POP5", type: "popup_transfer", segmentId: "main",
    offsetM: 3, directions: ["left", "right"], beltCount: 5 }];
  const sel = P.selectComponents(d, M.computeDesign(d), {});
  const wide = sel.transfers[0].components.find(c => /Cross-belt transfer module/i.test(c.description));
  assert.equal(wide.qty, 5);
  assert.ok(sel.transfers[0].warnings.some(w => /wide unit/i.test(w)), "beltCount > 4 warning");
});

t("model v3: many transfer devices on one network warns", () => {
  const d = mergeTransferDesign();
  d.transfers = [];
  for (let i = 0; i < 9; i++) {
    d.transfers.push({ id: "px" + i, name: "PUSHER" + (i + 1), type: "pusher",
      segmentId: "main", offsetM: 0.5 + i * 0.6, side: "right" });
  }
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  assert.equal(sel.stats.deviceBlocks, 9);
  assert.ok(sel.warnings.some(w => /many transfer devices/i.test(w)),
    "many devices warning: " + sel.warnings.join(" | "));
});

/* ======================================================================== */
/* 7. buildBom                                                              */
/* ======================================================================== */
const bom = P.buildBom(design, computed, selections, {});

t("buildBom: groups P/Ns with expected quantities", () => {
  assert.ok(Array.isArray(bom.rows) && bom.rows.length >= 8, "BOM rows");
  const find = (cat, pnPart) => bom.rows.find(r => r.category === cat && r.pn.indexOf(pnPart) >= 0);
  assert.equal(find("Rollers", "RC A DU42").qty, 6, "6 motorized rollers");
  assert.equal(find("Rollers", "RC A D000").qty, 60, "60 idle rollers");
  assert.equal(find("Driver cards", "C100Z-35").qty, 6, "6 driver cards");
  assert.equal(find("Sensors", "BANQS18VP6LPQ8").qty, 6, "6 sensors");
  assert.equal(find("I/O", "1799ER-IQ10XOQ10").qty, 2, "2 I/O blocks (one per ZPA group)");
  /* grouping: P/Ns unique within a category */
  const keys = bom.rows.map(r => r.category + "\u0000" + r.pn);
  assert.equal(new Set(keys).size, keys.length, "rows grouped by category+P/N");
  for (const r of bom.rows) {
    assert.ok(CATEGORY_SET.has(r.category), "valid category: " + r.category);
    assert.ok(["roller-db", "parts-catalog", "estimate"].indexOf(r.source) >= 0, "source: " + r.source);
    assert.equal(typeof r.unitCost, "number");
    assert.equal(typeof r.extended, "number");
  }
});

t("buildBom: extended == qty*unitCost and totals add up", () => {
  let sum = 0;
  const catSums = {};
  for (const r of bom.rows) {
    assert.equal(r.extended, Math.round(r.qty * r.unitCost * 100) / 100,
      "extended arithmetic for " + r.pn);
    sum += r.extended;
    catSums[r.category] = Math.round(((catSums[r.category] || 0) + r.extended) * 100) / 100;
  }
  assert.equal(bom.totals.grandTotal, Math.round(sum * 100) / 100, "grand total = sum of extended");
  assert.equal(bom.totals.currency, "USD");
  assert.deepStrictEqual(bom.totals.byCategory, catSums, "byCategory sums match rows");
  const catTotal = Object.keys(bom.totals.byCategory).reduce((a, k) => a + bom.totals.byCategory[k], 0);
  assert.equal(Math.round(catTotal * 100) / 100, bom.totals.grandTotal, "category totals = grand total");
  assert.ok(bom.totals.grandTotal > 5000 && bom.totals.grandTotal < 50000, "plausible demo total");
  assert.ok(bom.totals.itemCount > bom.rows.length, "more items than lines");
  assert.ok(bom.warnings.some(w => /estimated unit costs/i.test(w)), "estimate warning");
});

t("buildBom: catalog costs used where available, estimates otherwise", () => {
  const block = bom.rows.find(r => r.category === "I/O");
  assert.equal(block.source, "parts-catalog");
  assert.equal(block.unitCost, 348.84, "1799ER catalog local cost");
  const bracket = bom.rows.find(r => r.category === "Mechanical" && r.pn === "1799-BRKD");
  assert.equal(bracket.unitCost, 26, "catalog online cost fallback");
  const roller = bom.rows.find(r => r.category === "Rollers" && /DU42/.test(r.pn));
  assert.equal(roller.source, "estimate", "synthesized roller cost is an estimate");
});

t("buildBom: tolerates missing selections (auto-selects)", () => {
  const auto = P.buildBom(design, computed, null, {});
  assert.deepStrictEqual(auto.rows, bom.rows, "auto-selected BOM equals explicit BOM");
});

/* ======================================================================== */
/* 7b. MODEL V2 BOMs: tapered rollers, belt conveyors, scan zones          */
/* ======================================================================== */
t("curve BOM: tapered roller rows carry taper id/delta/radius; qty = rollerCount sum", () => {
  const cbom = P.buildBom(curveD, curveC, curveSel, {});
  const taperedRows = cbom.rows.filter(r => r.category === "Rollers" && r.taper);
  assert.equal(taperedRows.length, 2, "motorized + idler tapered rows");
  const motorized = taperedRows.find(r => !/IDLER/i.test(r.pn));
  const idle = taperedRows.find(r => /IDLER/i.test(r.pn));
  assert.ok(motorized && idle, "motorized/idle tapered rows");
  assert.equal(motorized.taper.standardId, "TS-20");
  assert.equal(motorized.taper.deltaMm, 20);
  assert.equal(motorized.taper.deltaM, 0.02);
  assert.ok(Math.abs(motorized.taper.radiusM - 1.748) < 0.005, "standard radius on the BOM row");
  assert.match(motorized.description, /taper 20 mm \(TS-20\)/);
  assert.match(motorized.description, /R1\.748 m/);
  assert.equal(motorized.qty, curveC.totals.curvedZones,
    "one motorized tapered roller per curved zone");
  assert.ok(idle.qty > 0, "tapered idler quantity");
  assert.equal(motorized.qty + idle.qty, curveC.totals.taperedRollerCount,
    "tapered roller qty = curved-zone rollerCountApprox sum");
  assert.equal(cbom.totals.taperedLines, 2);
  /* straight zones still use cylindrical rollers */
  assert.ok(cbom.rows.some(r => r.category === "Rollers" && /RC A DU42/.test(r.pn)),
    "cylindrical motorized rollers for straight zones");
});

t("belt BOM: belt length, pulleys, PF525 drive, tracking sensors, tensioner, scanner", () => {
  const bbom = P.buildBom(beltD, beltC, beltSel, {});
  const find = (cat, re) => bbom.rows.find(r => r.category === cat && re.test(r.pn));
  const belt = find("Mechanical", /^BELT-/);
  assert.ok(belt, "belt row");
  const expectedLen = beltC.segments.reduce((a, s) => a + s.lengthM, 0);
  assert.ok(Math.abs(belt.qty - expectedLen) < 0.05,
    "belt qty = total belt length in m incl. spiral (" + belt.qty + " vs " + expectedLen + ")");
  assert.ok(belt.qty > 30, "spiral length included");
  assert.equal(find("Mechanical", /^PULLEY-HD-/).qty, 3, "one head pulley per belt segment");
  assert.equal(find("Mechanical", /^PULLEY-TL-/).qty, 3, "one tail pulley per belt segment");
  assert.equal(find("Mechanical", /^TENSIONER-/).qty, 3, "one tensioner per belt segment");
  assert.equal(find("Driver cards", /^25B-D2P3N104$/).qty, 3, "PF525 per belt drive");
  assert.equal(find("Driver cards", /^25-COMM-E2P$/).qty, 3, "comm card per belt drive");
  assert.equal(find("Power", /^MOTOR-GM-/).qty, 3, "one drive motor per belt segment");
  assert.equal(find("Sensors", /^BANQS18VP6LPQ8$/).qty, 6, "2 belt-tracking sensors x 3 belts");
  assert.equal(find("Sensors", /^MATRIX-220-210-010$/).qty, 1, "one scanner per scan zone");
  assert.equal(find("Mechanical", /^MNT-SCAN-/).qty, 1, "scanner mounting kit");
  assert.equal(find("Cabling", /^CBL-M12D-RJ45-5M$/).qty, 1, "scanner cable");
  /* belt conveyor manufacturers no ZPA blocks/rollers */
  assert.equal(bbom.rows.filter(r => r.category === "I/O").length, 0, "no ZPA I/O blocks");
  assert.equal(bbom.rows.filter(r => r.category === "Rollers").length, 0, "no ZPA rollers");
  assert.ok(bbom.totals.grandTotal > 0);
  /* arithmetic holds with fractional belt quantities */
  let sum = 0;
  for (const r of bbom.rows) {
    assert.equal(r.extended, Math.round(r.qty * r.unitCost * 100) / 100, "extended for " + r.pn);
    sum += r.extended;
  }
  assert.equal(bbom.totals.grandTotal, Math.round(sum * 100) / 100);
  /* legacy {zones} selections still get belt/scan components filled in */
  const partial = P.buildBom(beltD, beltC, { zones: beltSel.zones }, {});
  assert.ok(partial.rows.some(r => r.category === "Mechanical" && /^BELT-/.test(r.pn)),
    "belt rows filled for legacy selections");
  assert.ok(partial.rows.some(r => /^MATRIX-/.test(r.pn)), "scanner row filled for legacy selections");
});

t("belt BOM: 2.2 kW motor uses the plant-catalog PowerFlex 525 P/N and cost", () => {
  const d = beltDesign({ motorKw: 2.2 });
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  assert.equal(sel.belts[0].vfdPn, "25B-D6P0N104");
  const b = P.buildBom(d, c, sel, {});
  const vfd = b.rows.find(r => r.pn === "25B-D6P0N104");
  if (P.lookupPart("25B-D6P0N104")) {
    /* the real plant catalog carries this P/N: catalog description + cost win */
    assert.equal(sel.belts[0].vfdSource, "parts-catalog");
    assert.equal(vfd.source, "parts-catalog");
    assert.equal(vfd.unitCost, 783.1, "catalog cost for 25B-D6P0N104");
  } else {
    assert.equal(sel.belts[0].vfdSource, "estimate", "fallback catalog keeps a realistic PF525 P/N");
    assert.equal(vfd.unitCost, 520, "estimated PF525 cost");
  }
});

t("scan-zone BOM: reader + mounting kit + cable rows", () => {
  const d = M.createDefaultDesign();
  d.name = "SCAN_BOM";
  d.segments = [{ id: "s1", name: "SEG1", kind: "straight", lengthM: 4, widthM: 0.6,
    zones: 4, zoneLengthM: 1 }];
  d.scanZones = [{ id: "sc1", name: "SCAN_1", segmentId: "s1", offsetM: 2, type: "barcode" }];
  d.tracking = { enabled: true, maxTrays: 16, barcodeLen: 20 };
  const c = M.computeDesign(d);
  const sel = P.selectComponents(d, c, {});
  const sbom = P.buildBom(d, c, sel, {});
  const scanner = sbom.rows.find(r => r.category === "Sensors" && /^MATRIX-220-210-010$/.test(r.pn));
  assert.ok(scanner, "scanner row in Sensors");
  assert.equal(scanner.qty, 1);
  const mount = sbom.rows.find(r => r.category === "Mechanical" && /^MNT-SCAN-/.test(r.pn));
  assert.ok(mount && mount.qty === 1, "scanner mounting kit row");
  const cable = sbom.rows.find(r => r.category === "Cabling" && /^CBL-M12D-RJ45-5M$/.test(r.pn));
  assert.ok(cable && cable.qty === 1, "scanner cable row");
  assert.equal(sbom.totals.scanners, 1);
});

/* ======================================================================== */
/* 7c. MODEL V3 BOMs: merge junctions + transfer devices                   */
/* ======================================================================== */
const mtBom = P.buildBom(mtD, mtC, mtSel, {});
const mtRows = (cat, re) => mtBom.rows.filter(r => r.category === cat && re.test(r.pn));
const mtRow = (cat, re) => mtBom.rows.find(r => r.category === cat && re.test(r.pn));

t("merge BOM: nose/throat plate kit (gap dimension), extra presence sensor, guides", () => {
  const nose = mtRows("Mechanical", /^MERGE-NOSE-/);
  assert.equal(nose.length, 2, "one nose kit per merge with gap > 0.3 m");
  assert.equal(nose.reduce((a, r) => a + r.qty, 0), 2);
  const pns = nose.map(r => r.pn).sort();
  assert.match(pns[0], /G1200$/, "far gap 1.2 m encoded in the P/N");
  assert.match(pns[1], /G500$/, "close gap 0.5 m encoded in the P/N");
  assert.ok(nose.every(r => /mm spur gap/.test(r.description)), "gap dimension in the description");
  const guides = mtRows("Mechanical", /^MERGE-GUIDE-/);
  assert.equal(guides.length, 1, "one guide-rail P/N");
  assert.equal(guides[0].qty, 2, "guide rails/brackets per merge");
  /* presence sensor shares the zone photoeye P/N: 10 zones + 2 merges + 3 pop-up = 15 */
  const photoeye = mtRows("Sensors", /^BANQS18VP6LPQ8$/);
  assert.equal(photoeye.length, 1);
  assert.equal(photoeye[0].qty, 15, "zone + merge presence + pop-up sensors grouped");
  assert.ok(mtBom.warnings.some(w => /throat plate adapter is REQUIRED/i.test(w)),
    "gap > 1.0 m warning in the BOM warnings");
});

t("transfer BOM: pusher kit / rotary table / pop-up rows and quantities", () => {
  /* pusher: kit + air prep + valve cable */
  const pusherKit = mtBom.rows.find(r => /Pneumatic pusher kit/i.test(r.description));
  assert.ok(pusherKit && pusherKit.category === "Mechanical", "pneumatic pusher kit row");
  assert.equal(pusherKit.qty, 1);
  assert.match(pusherKit.description, /one-way divert/i);
  assert.ok(mtBom.rows.some(r => /Air preparation/i.test(r.description)), "air prep/filter row");
  const valveCable = mtBom.rows.find(r => r.category === "Cabling" && /Pusher valve cable/i.test(r.description));
  assert.ok(valveCable && valveCable.qty === 1, "pusher valve cable row");

  /* rotary: assembly + drive + controller + 4 position sensors + cable */
  const assembly = mtRow("Mechanical", /^ROTARY-TABLE-ASSY-/);
  assert.ok(assembly && assembly.qty === 1, "turntable assembly row");
  const drive = mtBom.rows.find(r => r.category === "Power" && /Turntable drive/i.test(r.description));
  assert.ok(drive && drive.qty === 1, "turntable drive (motor + reducer) row");
  const controller = mtRow("Driver cards", /^25B-D2P3N104$/);
  assert.ok(controller && controller.qty === 1, "rotary controller / IO module row");
  const posSensors = mtRow("Sensors", /^872C-D8NE18-A2$/);
  assert.ok(posSensors, "rotary position sensor row");
  assert.equal(posSensors.qty, 4, "home + 90/180/270 for a 90 deg step");
  assert.ok(mtBom.rows.some(r => r.category === "Cabling" && /Rotary table/i.test(r.description)),
    "rotary power/control cable row");

  /* pop-up: cross-belt modules qty = beltCount + lift + motor + 2 limits + 3 sensors + cable */
  const modules = mtRow("Mechanical", /^XBT-MODULE-/);
  assert.ok(modules, "cross-belt module row");
  assert.equal(modules.qty, 3, "cross-belt modules qty = popup.beltCount");
  assert.match(modules.description, /BIDIRECTIONAL/i);
  assert.ok(mtBom.rows.some(r => /raise\/lower mechanism/i.test(r.description)), "pop-up lift kit row");
  assert.ok(mtBom.rows.some(r => /Cross-belt transfer drive motor/i.test(r.description)), "pop-up drive row");
  const limits = mtRow("Sensors", /^LS-MECH-1NO1NC$/);
  assert.ok(limits && limits.qty === 2, "2 up/down limit switches");
  const popupCable = mtBom.rows.find(r => r.category === "Cabling" && /Cross-belt transfer/i.test(r.description));
  assert.ok(popupCable && popupCable.qty === 1, "pop-up cable row");

  assert.equal(mtBom.totals.merges, 2);
  assert.equal(mtBom.totals.transfers, 3);
  assert.equal(mtBom.totals.pushers, 1);
  assert.equal(mtBom.totals.rotaryTables, 1);
  assert.equal(mtBom.totals.popupTransfers, 1);
  assert.equal(mtBom.totals.bidirectionalTransfers, 2);
});

t("device I/O blocks are in the I/O category (not ZPA group blocks)", () => {
  const io = mtBom.rows.filter(r => r.category === "I/O");
  assert.equal(io.length, 1, "all 1799ER blocks share one P/N row");
  assert.equal(io[0].qty, 6, "3 ZPA group blocks + 3 transfer device blocks");
  assert.equal(mtBom.totals.deviceBlocks, 3);
  assert.equal(mtBom.totals.ioBlocks, 6);
  assert.equal(mtSel.stats.blocks, 3, "ZPA group blocks only");
  assert.ok((io[0].notes || []).some(n => /device i\/o/i.test(n)), "device I/O noted on the row");
  /* device blocks have their own P/N entries in the model */
  const deviceBlocks = mtC.blocks.filter(b => !!b.deviceType);
  assert.equal(deviceBlocks.length, 3);
  assert.ok(deviceBlocks.every(b => b.ip && b.catalogNumber), "device blocks have ip + catalog");
});

t("model v3 BOM totals add up (merge/transfer rows included)", () => {
  let sum = 0;
  const catSums = {};
  for (const r of mtBom.rows) {
    assert.ok(CATEGORY_SET.has(r.category), "valid category: " + r.category);
    assert.equal(r.extended, Math.round(r.qty * r.unitCost * 100) / 100,
      "extended arithmetic for " + r.pn);
    sum += r.extended;
    catSums[r.category] = Math.round(((catSums[r.category] || 0) + r.extended) * 100) / 100;
  }
  assert.equal(mtBom.totals.grandTotal, Math.round(sum * 100) / 100, "grand total = sum of extended");
  assert.deepStrictEqual(mtBom.totals.byCategory, catSums, "byCategory sums match rows");
  const catTotal = Object.keys(catSums).reduce((a, k) => a + catSums[k], 0);
  assert.equal(Math.round(catTotal * 100) / 100, mtBom.totals.grandTotal);
  assert.ok(mtBom.totals.grandTotal > 20000, "merge + transfer demo is a substantial BOM");
  /* all existing API outputs still work on this design */
  const csv = P.bomToCsv(mtBom.rows);
  assert.ok(csv.split("\r\n").filter(Boolean).length === mtBom.rows.length + 1);
  const md = P.bomToMarkdown(mtBom.rows, mtBom.totals);
  assert.ok(md.indexOf(mtBom.totals.grandTotal.toFixed(2)) >= 0);
  /* auto-select fallback also includes merge/transfer components */
  const auto = P.buildBom(mtD, mtC, null, {});
  assert.deepStrictEqual(auto.rows, mtBom.rows, "auto-selected BOM equals explicit BOM");
});

/* ======================================================================== */
/* 8. CSV + Markdown                                                        */
/* ======================================================================== */
t("bomToCsv: RFC4180 header + round-trip", () => {
  const csv = P.bomToCsv(bom.rows);
  assert.ok(csv.endsWith("\r\n"), "trailing CRLF");
  assert.ok(csv.indexOf("\r\n") > 0, "CRLF line endings");
  const parsed = parseCsv(csv);
  assert.deepStrictEqual(parsed[0],
    ["Category", "P/N", "Description", "Qty", "Unit Cost", "Extended", "Source"]);
  assert.equal(parsed.length, bom.rows.length + 1, "header + one line per row");
  for (let i = 0; i < bom.rows.length; i++) {
    const r = bom.rows[i], line = parsed[i + 1];
    assert.equal(line[0], r.category);
    assert.equal(line[1], r.pn);
    assert.equal(line[2], r.description);
    assert.equal(line[3], String(r.qty));
    assert.equal(Number(line[4]), r.unitCost);
    assert.equal(Number(line[5]), r.extended);
    assert.equal(line[6], r.source);
  }
});

t("bomToCsv: quotes commas, quotes and newlines", () => {
  const rows = [{
    category: "Mechanical", pn: "TEST,1", description: 'Bracket, "heavy" duty\nwith newline',
    qty: 2, unitCost: 1.5, extended: 3, source: "estimate"
  }];
  const csv = P.bomToCsv(rows);
  assert.ok(csv.indexOf('"TEST,1"') >= 0, "comma quoted");
  assert.ok(csv.indexOf('"Bracket, ""heavy"" duty\nwith newline"') >= 0, "quotes doubled");
  const parsed = parseCsv(csv);
  assert.equal(parsed[1][1], "TEST,1");
  assert.equal(parsed[1][2], 'Bracket, "heavy" duty\nwith newline');
  assert.equal(parsed[1][4], "1.50", "two-decimal money formatting");
  assert.equal(P.bomToCsv([]).split("\r\n").filter(Boolean).length, 1, "header only for empty rows");
});

t("bomToMarkdown: table + category totals + grand total", () => {
  const md = P.bomToMarkdown(bom.rows, bom.totals);
  assert.ok(md.indexOf("# Bill of Materials") === 0);
  assert.ok(md.indexOf("| Category | P/N | Description | Qty | Unit Cost | Extended | Source |") >= 0);
  const dataLines = md.split("\n").filter(l => l.startsWith("| Rollers") || l.startsWith("| Driver cards") ||
    l.startsWith("| Sensors") || l.startsWith("| I/O") || l.startsWith("| Cabling") ||
    l.startsWith("| Power") || l.startsWith("| Mechanical"));
  assert.ok(dataLines.length >= bom.rows.length, "one line per row");
  assert.ok(md.indexOf("## Totals by category") >= 0);
  assert.ok(md.indexOf("$" + bom.totals.grandTotal.toFixed(2) + " USD") >= 0, "grand total rendered");
  /* markdown escaping */
  const one = P.bomToMarkdown([{ category: "I/O", pn: "A|B", description: "x|y", qty: 1,
    unitCost: 1, extended: 1, source: "estimate" }], null);
  assert.ok(one.indexOf("A\\|B") >= 0 && one.indexOf("x\\|y") >= 0, "pipes escaped");
});

/* ======================================================================== */
/* 9. PARTS CATALOG                                                         */
/* ======================================================================== */
const stats = P.catalogStats();

t("parts catalog loads (real workbook: >600 parts, >80 SAMPLE_ST rows)", () => {
  assert.equal(stats.loaded, true, "catalog loaded");
  const realWorkbook = stats.sourceFile && /site master parts list$/.test(stats.sourceFile);
  if (realWorkbook) {
    assert.ok(stats.parts > 600, "parts > 600 (got " + stats.parts + ")");
    assert.ok(stats.siteRows >= 80, "site-group rows >= 80 (got " + stats.siteRows + ")");
    assert.equal(stats.warning, null, "no fallback warning for the real workbook");
  } else {
    /* synthetic fallback is allowed when the Q: drive is unavailable */
    console.log("     (catalog fallback in use: " + (stats.warning || "unknown") + ")");
    assert.ok(stats.parts > 0, "fallback catalog still usable");
  }
  assert.ok(stats.uniquePns > 500, "unique P/Ns");
  assert.ok(typeof stats.generatedAt === "string" && stats.generatedAt.length >= 10, "generatedAt");
});

t("catalog lookups: P/N, NSN, revision suffix, row mapping", () => {
  const block = P.lookupPart("1799ER-IQ10XOQ10/A");
  assert.ok(block, "block lookup with /A revision suffix");
  assert.equal(block.pn, "1799ER-IQ10XOQ10");
  assert.equal(block.unitCostLocal, 348.8448);
  const sensor = P.lookupPart("BANQS18VP6LPQ8");
  assert.ok(sensor && /PHOTO/.test(sensor.description), "sensor P/N lookup");
  /* NSN with dashed formatting (3010-18-000-7963 style) resolves too */
  const byNsn = P.lookupPart("3915070006264");
  assert.ok(byNsn && byNsn.pn === "MR-AD-48-361-40-YWGQ", "NSN lookup resolves roller");
  assert.ok(byNsn.siteParts && byNsn.siteParts.unitPrice > 0, "SAMPLE_ST historical price attached");
  assert.equal(P.lookupPart("definitely-not-a-part"), null);
  assert.equal(P.lookupPart(""), null);
});

t("searchParts / describePart / partUnitCost", () => {
  const photos = P.searchParts("PHOTO");
  assert.ok(photos.length > 0, "photo search hits");
  assert.ok(photos.some(p => /PHOTO/i.test(p.description)), "descriptions match");
  assert.ok(P.searchParts("1799ER").length > 0, "1799ER hits");
  assert.ok(P.searchParts("roller").length > 0, "roller hits");
  assert.deepStrictEqual(P.searchParts(""), [], "empty query returns []");
  const limited = P.searchParts("ROLLER", { limit: 3 });
  assert.equal(limited.length, 3, "limit respected");
  const desc = P.describePart("1799ER-IQ10XOQ10/A");
  assert.ok(typeof desc === "string" && /DUAL PORT/.test(desc) && /\$/.test(desc), "describePart: " + desc);
  assert.ok(P.describePart("PM486FS-55-366-D-024-P2-JH").indexOf("PM486FS") >= 0, "describe roller DB part");
  assert.equal(P.describePart("nope-nope"), null);
  assert.equal(P.partUnitCost(P.lookupPart("1799ER-IQ10XOQ10/A")), 348.8448);
  assert.equal(P.partUnitCost(null), null);
});

t("catalog data file is a classic script (browser) and a Node module", () => {
  const file = path.join(ROOT, "js", "data", "parts-catalog.js");
  assert.ok(fs.existsSync(file), "generated catalog exists");
  /* Node side */
  const nodeCatalog = require(file);
  assert.ok(Array.isArray(nodeCatalog.parts) && nodeCatalog.parts.length > 0);
  assert.ok(Array.isArray(nodeCatalog.siteParts));
  /* Browser side: run the file with a fake global, no module object */
  const sandbox = { self: {} };
  sandbox.self.L5XStudio = {};
  const code = fs.readFileSync(file, "utf8");
  vm.runInNewContext(code, sandbox, { filename: "parts-catalog.js" });
  assert.ok(sandbox.self.L5XStudio.PARTS_CATALOG, "browser global assigned");
  assert.equal(sandbox.self.L5XStudio.PARTS_CATALOG.parts.length, nodeCatalog.parts.length);
});

t("catalog build script output is deterministic metadata", () => {
  const catalog = require(path.join(ROOT, "js", "data", "parts-catalog.js"));
  assert.ok(catalog.generatedAt, "generatedAt present");
  assert.ok(catalog.source && catalog.source.sheets, "source metadata");
  if (catalog.source.workflow === "master-parts-list") {
    assert.deepStrictEqual(catalog.source.sheets,
      ["site master parts list", "site group code"]);
    assert.ok(catalog.source.partsRows > 600);
  }
  /* records are stable shapes */
  const firstPart = catalog.parts[0];
  for (const key of ["pn", "nsn", "oem", "cage", "description", "type", "unitCostLocal", "unitCostOnline"]) {
    assert.ok(key in firstPart, "part field " + key);
  }
  if (catalog.siteParts.length) {
    for (const key of ["psn", "description", "boh", "commCode", "replacementPsn"]) {
      assert.ok(key in catalog.siteParts[0], "sampleSt field " + key);
    }
  }
});

/* ======================================================================== */
/* 10. UMD / API SURFACE                                                    */
/* ======================================================================== */
t("parts.js exports the full contract API", () => {
  const required = [
    "ROLLER_DB", "SERIES_SPECS", "DRIVER_CARDS", "MU_TABLE", "BRANDS",
    "parseSeries", "getRollerByPn", "rollerBrand", "compatibleCardsForSeries",
    "isBrakeRoller", "findClosestSpeedCode", "buildItohPart", "buildMicrorollPart",
    "buildInfiniDrivePart", "validateRoller", "calcDerived", "lroller", "recommendRoller",
    "lookupPart", "searchParts", "describePart", "catalogStats",
    "selectComponents", "buildBom", "bomToCsv", "bomToMarkdown",
    /* model v2 additions */
    "buildTaperedRollerPart", "buildTaperedIdlerPart", "buildBeltPart", "buildPulleyPart",
    "normalizeTaperSeries", "taperStandardInfo", "PF525_MODELS", "TAPER_SERIES_ALIASES",
    "ESTIMATED_UNIT_COSTS", "BOM_ITEMS"
  ];
  for (const name of required) {
    assert.ok(name in P, "missing export " + name);
    assert.notEqual(P[name], undefined, "undefined export " + name);
  }
  for (const name of ["buildItohPart", "buildMicrorollPart", "buildInfiniDrivePart",
    "buildIdlerPart", "buildTaperedRollerPart", "buildTaperedIdlerPart",
    "buildBeltPart", "buildPulleyPart", "normalizeTaperSeries", "taperStandardInfo",
    "validateRoller", "calcDerived", "lroller", "recommendRoller", "selectComponents",
    "buildBom", "bomToCsv", "bomToMarkdown", "lookupPart", "searchParts",
    "describePart", "catalogStats", "parseSeries", "getRollerByPn", "rollerBrand",
    "compatibleCardsForSeries", "isBrakeRoller", "findClosestSpeedCode"]) {
    assert.equal(typeof P[name], "function", name + " is a function");
  }
});

t("parts.js is Node-safe without a DOM", () => {
  assert.equal(typeof global.document, "undefined", "test runs without DOM");
  const rec = P.recommendRoller({ widthM: 0.6, targetFpm: 60, application: "zpa" });
  assert.ok(rec.partNumber);
  assert.ok(P.buildBom(demoDesign(), M.computeDesign(demoDesign())).rows.length > 0);
  /* belt + tapered selection paths also run DOM-free */
  assert.ok(P.selectComponents(beltD, beltC, {}).belts.length === 3);
  assert.ok(P.selectComponents(curveD, curveC, {}).stats.taperedRollerZones === 2);
  /* model v3 merge/transfer paths also run DOM-free */
  const mt = P.selectComponents(mtD, mtC, {});
  assert.equal(mt.merges.length, 2);
  assert.equal(mt.transfers.length, 3);
  assert.ok(mt.merges.concat(mt.transfers).every(x => x.components.length > 0));
});

/* ======================================================================== */
/* 11. DEMO BOM SUMMARY + RESULT                                            */
/* ======================================================================== */
function printBomSummary() {
  const sel = P.selectComponents(design, computed, {});
  const bill = P.buildBom(design, computed, sel, {});
  const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
  const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
  console.log("");
  console.log("DEMO DESIGN: " + design.name + " -> " + computed.totals.segments + " segments, " +
    computed.totals.zones + " zones, " + computed.totals.conveyorLengthM + " m");
  console.log("  motorized rollers: " + sel.stats.motorizedRollers +
    " | idle rollers: " + sel.stats.idleRollers +
    " | cards: " + sel.stats.driverCards +
    " | sensors: " + sel.stats.sensors +
    " | I/O blocks: " + sel.stats.blocks);
  console.log("");
  console.log("  " + pad("CATEGORY", 13) + pad("P/N", 34) + padL("QTY", 5) + "  " +
    padL("UNIT", 10) + "  " + padL("EXTENDED", 11) + "  SOURCE");
  console.log("  " + "-".repeat(13) + " " + "-".repeat(33) + " " + "-".repeat(4) + "  " +
    "-".repeat(9) + "  " + "-".repeat(10) + "  " + "-".repeat(12));
  for (const r of bill.rows) {
    const pn = r.pn.length > 32 ? r.pn.slice(0, 31) + "\u2026" : r.pn;
    console.log("  " + pad(r.category, 13) + pad(pn, 34) + padL(r.qty, 5) + "  " +
      padL("$" + r.unitCost.toFixed(2), 10) + "  " + padL("$" + r.extended.toFixed(2), 11) + "  " + r.source);
  }
  console.log("  " + "-".repeat(13) + " " + "-".repeat(33) + " " + "-".repeat(4) + "  " +
    "-".repeat(9) + "  " + "-".repeat(10));
  console.log("  " + pad("", 13) + pad("", 34) + padL("", 5) + "  " + padL("GRAND TOTAL", 10) + "  " +
    padL("$" + bill.totals.grandTotal.toFixed(2), 11) + "  " + bill.totals.currency);
  console.log("");
  for (const cat of Object.keys(bill.totals.byCategory)) {
    console.log("    " + pad(cat, 16) + "$" + bill.totals.byCategory[cat].toFixed(2));
  }
  return bill;
}

const demoBill = printBomSummary();

/* model v2 coverage summary (curve/spiral tapered rollers + belt conveyors) */
const curveBill = P.buildBom(curveD, curveC, curveSel, {});
const beltBill = P.buildBom(beltD, beltC, beltSel, {});
console.log("");
console.log("MODEL V2 COVERAGE");
console.log("  curve design: " + curveC.totals.curvedZones + " curved zones, " +
  curveC.totals.taperedRollerCount + " tapered rollers, BOM $" +
  curveBill.totals.grandTotal.toFixed(2) + " (" +
  curveSel.stats.taperedRollerZones + " motorized + " +
  (curveSel.stats.taperedRollers - curveSel.stats.taperedRollerZones) + " idler tapered)");
const taperRow = curveBill.rows.find(r => r.taper && !/IDLER/i.test(r.pn));
console.log("    taper row: " + taperRow.pn + " | " +
  taperRow.taper.standardId + " delta " + taperRow.taper.deltaMm + " mm | R" +
  taperRow.taper.radiusM + " m | qty " + taperRow.qty);
console.log("  belt design: " + beltC.totals.beltSegments + " belt segments, " +
  beltSel.stats.beltLengthM + " m belt, " + beltSel.stats.pulleys + " pulleys, " +
  beltSel.stats.beltDrives + " PF525 drives, " + beltSel.stats.scanners + " scanner(s), BOM $" +
  beltBill.totals.grandTotal.toFixed(2));
console.log("  tapered-roller BOM rows: " + curveBill.totals.taperedLines +
  " | belt BOM lines: " + beltBill.rows.length);

/* model v3 coverage summary (merge junctions + transfer devices) */
console.log("");
console.log("MODEL V3 COVERAGE");
console.log("  merge/transfer design: " + mtC.totals.zones + " zones, " +
  mtSel.stats.merges + " merges, " + mtSel.stats.transfers + " transfers (" +
  mtSel.stats.pushers + " pusher, " + mtSel.stats.rotaryTables + " rotary, " +
  mtSel.stats.popupTransfers + " pop-up), " + mtSel.stats.deviceBlocks + " device I/O blocks, BOM $" +
  mtBom.totals.grandTotal.toFixed(2) + " (" + mtBom.rows.length + " lines)");
const noseRows = mtBom.rows.filter(r => /^MERGE-NOSE-/.test(r.pn));
const pusherRow = mtBom.rows.find(r => /Pneumatic pusher kit/i.test(r.description));
const rotaryPos = mtBom.rows.find(r => /^872C-D8NE18-A2$/.test(r.pn));
const popupRow = mtBom.rows.find(r => /^XBT-MODULE-/.test(r.pn));
const ioRow = mtBom.rows.find(r => r.category === "I/O");
console.log("    merge nose kits: " + noseRows.map(r => r.pn + " x" + r.qty).join(", "));
console.log("    pusher kit: " + (pusherRow && pusherRow.pn) + " | rotary position sensors: " +
  (rotaryPos && rotaryPos.qty) + " | pop-up modules: " + (popupRow && popupRow.qty));
console.log("    I/O row: " + (ioRow && ioRow.pn) + " qty " + (ioRow && ioRow.qty) +
  " (" + mtSel.stats.blocks + " ZPA groups + " + mtSel.stats.deviceBlocks + " devices)");

/* summary */
console.log("");
console.log("RESULT: " + pass + " passed, " + fail + " failed");
console.log("catalog: " + stats.parts + " parts (" + stats.uniquePns + " unique P/Ns), " +
  stats.siteRows + " site-group rows, " + stats.withCost + " with a cost, source=" + stats.sourceFile);
console.log("roller data: " + P.ROLLER_DB.length + " rollers, " + Object.keys(P.SERIES_SPECS).length +
  " series, " + Object.keys(P.DRIVER_CARDS).length + " driver cards, " +
  Object.keys(P.SPEED_CODES).length + " speed tables");
console.log("demo BOM: " + demoBill.rows.length + " lines, grand total $" +
  demoBill.totals.grandTotal.toFixed(2) + " " + demoBill.totals.currency);
if (fail) {
  console.log("FAILURES: " + failures.join(", "));
  process.exit(1);
}
process.exit(0);
