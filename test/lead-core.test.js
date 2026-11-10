/* Lead-owned core tests: model parsing, resolution, I/O mapping, export surgery. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
const resolveApi = JS("resolve.js");
const ioMapApi = JS("io-map.js");
const operandsApi = JS("operands.js");
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
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n     ") : e)); }
}

const models = {};
for (const f of FILES) {
  const name = path.basename(f);
  const model = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
  model.fileName = name;
  models[name] = model;
  t(name + " parses", () => {
    assert.ok(model.controller.name, "controller name present");
    assert.ok(model.programs.length > 0, "programs present");
    assert.ok(model.modules.length > 0, "modules present");
    assert.ok(model.dataTypes.length > 0, "datatypes present");
  });
  t(name + " routines parsed", () => {
    const n = model.programs.reduce((a, p) => a + p.routines.length, 0);
    assert.ok(n > 0, "routines present");
    for (const p of model.programs) for (const r of p.routines) {
      assert.ok(r.content, "routine content: " + p.name + "/" + r.name);
      if (r.type === "RLL") {
        assert.ok(r.content.kind === "rll" && Array.isArray(r.content.rungs), "rll content shape");
        for (const rg of r.content.rungs) assert.equal(typeof rg.text, "string", "rung text string");
      }
    }
  });
}

// operand parsing
t("operands.parseOperand module tag", () => {
  const p = operandsApi.parseOperand("Network1:I.Data[2].1");
  assert.equal(p.baseTag, "Network1:I");
  assert.ok(p.isModuleTag);
  assert.deepStrictEqual(p.members.map(m => [m.name, m.index]), [["Data", null], [null, "2"], [null, "1"]]);
  assert.equal(p.members[2].bit, true);
});
t("operands.parseOperand udt array", () => {
  const p = operandsApi.parseOperand("AFCS[NDX].RUN_INTERLOCK");
  assert.equal(p.baseTag, "AFCS");
  assert.deepStrictEqual(p.members.map(m => [m.name, m.index]), [[null, "NDX"], ["RUN_INTERLOCK", null]]);
});
t("operands literals", () => {
  assert.equal(operandsApi.literalType("16#FF"), "int");
  assert.equal(operandsApi.literalType("2#1010"), "int");
  assert.equal(operandsApi.literalType("-3.5"), "float");
  assert.equal(operandsApi.literalType("TRUE"), "bool");
  assert.equal(operandsApi.literalType("MyTag"), null);
});

// SAMPLE_ST: Network1:I.Data[2].1 resolves to the DNB module input image
t("SAMPLE_ST Network1:I.Data[2].1 -> physical point", () => {
  const model = models["SAMPLE_ST.L5X"];
  const r = resolveApi.resolveOperand(model, "Network1:I.Data[2].1", null);
  assert.ok(r.ok, "resolves: " + (r.error || ""));
  assert.ok(r.isModuleTag);
  assert.equal(r.ioDirection, "Input");
  const pt = ioMapApi.resolveIoPoint(model, "Network1:I.Data[2].1", null);
  assert.ok(pt.ok, "io point: " + (pt.error || ""));
  assert.equal(pt.point.moduleName, "Network1");
  assert.match(pt.point.catalogNumber, /(DNB|EN2DN)/);
  assert.equal(pt.point.direction, "Input");
  assert.equal(pt.point.bit, 1);
  assert.equal(pt.point.word, "2");
});

// SAMPLE_ST: Network1:O.Data[2].10 output point
t("SAMPLE_ST Network1:O.Data[2].10 -> output point", () => {
  const model = models["SAMPLE_ST.L5X"];
  const pt = ioMapApi.resolveIoPoint(model, "Network1:O.Data[2].10", null);
  assert.ok(pt.ok);
  assert.equal(pt.point.direction, "Output");
  assert.equal(pt.point.bit, 10);
});

// SAMPLE_RLL: PDP:I.Data -> block I/O module input image
t("SAMPLE_RLL PDP:I.Data -> physical point", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const pt = ioMapApi.resolveIoPoint(model, "PDP:I.Data", null);
  assert.ok(pt.ok, pt.error || "");
  assert.equal(pt.point.moduleName, "PDP");
  assert.match(pt.point.catalogNumber, /1799ER/);
  assert.equal(pt.point.direction, "Input");
});

// SAMPLE_RLL module tree sanity
t("SAMPLE_RLL module tree", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const tree = ioMapApi.buildModuleTree(model);
  const local = tree.find(m => m.name === "Local");
  assert.ok(local && local.isLocal);
  const dnb = tree.find(m => m.name === "Network1");
  assert.equal(dnb.slot, 1);
  const pdp = tree.find(m => m.name === "PDP");
  assert.ok(pdp);
  // PDP is Ethernet-attached, referenced by name
  assert.ok(!pdp.localTagPrefix || pdp.nameTagPrefix === "PDP");
});

// SAMPLE_RLL UDT shape
t("SAMPLE_RLL UDT CONFIG_GR shape", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const dt = modelApi.findDataType(model, "CONFIG_GR");
  assert.ok(dt, "UDT exists");
  assert.ok(dt.members.length > 0);
  const center = dt.members.find(m => m.name === "CENTERING_OFFSET");
  assert.ok(center, "member exists");
  assert.equal(center.dimension, 100);
  assert.equal(center.dataType, "INT");
});

// export: stage a change on a copy and verify surgery
t("export surgery on SAMPLE_RLL", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const prog = model.programs[0].name;
  const rout = model.programs[0].routines[0];
  const original = model.rawText;
  // stage: same content, new type ST
  model.setRoutineContent(prog, rout.name, "ST", { kind: "st", text: "// test\nX := 1;\n" });
  const res = exportApi.exportL5X(model, {});
  assert.ok(res.text.length > original.length - 6000, "length plausible");
  assert.ok(res.text.includes("<STContent>"), "ST content present");
  assert.ok(res.text.includes('Type="ST"'), "routine type switched");
  // re-parse the exported text
  const m2 = modelApi.parseL5X(res.text);
  const r2 = modelApi.findRoutine(m2, prog, rout.name);
  assert.equal(r2.type, "ST");
  assert.equal(r2.content.text.trim(), "// test\nX := 1;");
  // untouched routines still parse with same rung count
  const r3 = modelApi.findRoutine(m2, prog, model.programs[0].routines[1].name);
  assert.equal(r3.content.rungs.length, model.programs[0].routines[1].content.rungs.length);
});

// export: auto-declared tags
t("export auto-declares new tags", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const prog = model.programs[0].name;
  const rout = model.programs[0].routines[0];
  model.setRoutineContent(prog, rout.name, "ST", { kind: "st", text: "BRAND_NEW_TAG_1234 := 5;\n" });
  const res = exportApi.exportL5X(model, {});
  assert.ok(res.text.includes('Name="BRAND_NEW_TAG_1234"'), "tag declared");
  const m2 = modelApi.parseL5X(res.text);
  const rec = resolveApi.findTagRecord(m2, "BRAND_NEW_TAG_1234", { program: prog });
  assert.ok(rec, "tag found after re-parse");
});

// export: GSV module-name args must NOT be auto-declared
t("export skips GSV module names", () => {
  const model = models["SAMPLE_RLL.L5X"];
  const prog = model.programs[0].name;
  const rout = model.programs[0].routines[0];
  model.setRoutineContent(prog, rout.name, "RLL", {
    kind: "rll",
    rungs: [{ number: 0, type: "N", comment: null, text: "GSV(Module,GROUP01,FaultCode,ENET_DEVICE_STATUS[0]);" }]
  });
  const res = exportApi.exportL5X(model, {});
  assert.ok(!res.text.includes('Name="GROUP01"') || res.text.includes('<Module Name="GROUP01"'), "no GROUP01 tag auto-declared");
});

// value bits
t("ioMap.valueBits", () => {
  assert.deepStrictEqual(ioMapApi.valueBits("2#1010"), [1, 3]);
  assert.deepStrictEqual(ioMapApi.valueBits("16#8000_0000"), [31]);
  assert.deepStrictEqual(ioMapApi.valueBits("7"), [0, 1, 2]);
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
