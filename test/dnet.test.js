/* L5X Studio — DeviceNet .dnt network import tests.
 *
 * Covers the reverse-engineered RSNetWorx DeviceNet reader (js/dnet.js), the merge into the
 * module-level I/O analysis (js/module-usage.js) and the L5X scanner-image correlation:
 * scanlist bit offsets -> <scanner>:I.Data[n] / O.Data[n] words.
 */
"use strict";
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const DNET = require("../js/dnet.js");
const USAGE = require("../js/module-usage.js");
const MODEL = require("../js/l5x-model.js");
const MERMAID = require("../js/mermaid-render.js");

const DNT_DIR = process.env.L5X_STUDIO_DNT_DIR || "C:/samples/sample-file";
const FILES = {
  lcs: path.join(DNT_DIR, "ZONE_TEMPLATE.dnt"),
  tray: path.join(DNT_DIR, "TRAY-CONVEYOR-TEMPLATE.dnt"),
  zonecard: path.join(DNT_DIR, "zone-card code.dnt")
};
const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/samples/controller.L5X";

let checks = 0, failures = 0;
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok - " + name); }
  catch (e) { failures++; console.error("FAIL - " + name); console.error("    " + String((e && e.stack) || e)); }
}
function have(f) { return fs.existsSync(f); }

/* --------------------------------------------------------------- parser */
check("dnt: isDnt detects OLE2/CFB signature", () => {
  if (!have(FILES.lcs)) { console.log("    (sample .dnt files not available — skipped)"); return; }
  assert.equal(DNET.isDnt(fs.readFileSync(FILES.lcs)), true);
  assert.equal(DNET.isDnt(new Uint8Array([1, 2, 3, 4])), false);
  assert.equal(DNET.isDnt(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), false, "needs full CFB header");
});

check("dnt: parse ZONE_TEMPLATE (scanner + 11 nodes, verified offsets)", () => {
  if (!have(FILES.lcs)) { console.log("    (sample .dnt files not available — skipped)"); return; }
  const r = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  assert.equal(r.isDnt, true);
  assert.equal(r.network.declaredDeviceCount, 12);
  assert.equal(r.devices.length, 11, "11 mapped nodes (scanner slot excluded)");
  assert.ok(r.scanner, "scanner stream parsed");
  assert.equal(r.scannerInfo.eprMs, 75);
  assert.equal(r.scannerInfo.interscanDelayMs, 10);
  const byMac = {};
  for (const d of r.devices) byMac[d.macId] = d;
  assert.equal(byMac[1].catalogNumber, "100-DNY42R");
  assert.equal(byMac[1].inputBitOffset, 320);
  assert.equal(byMac[2].catalogNumber, "1799-ZCIOV");
  assert.equal(byMac[2].inputBitOffset, 3200, "ZPA input offset 3200 bits (verified against HTML)");
  assert.equal(byMac[2].outputBitOffset, 3200);
  assert.equal(byMac[2].inputBytes, 7);
  assert.equal(byMac[2].outputBytes, 2);
  assert.equal(byMac[3].inputBitOffset, 960);
  assert.equal(byMac[3].inputBitLength, 32);
  assert.equal(r.devices.filter(d => d.catalogNumber === "1799-ZCIOV").length, 9, "9 zone cards");
  assert.ok(/COS|Cyclic/.test(byMac[2].transferType));
});

check("dnt: parse TRAY template (24 devices, no scanner) and zone card template", () => {
  if (!have(FILES.tray)) { console.log("    (sample .dnt files not available — skipped)"); return; }
  const t = DNET.parseDnt(fs.readFileSync(FILES.tray), { fileName: "TRAY-CONVEYOR-TEMPLATE.dnt" });
  assert.equal(t.devices.length, 23);
  assert.equal(t.network.declaredDeviceCount, 24);
  assert.equal(t.scanner, null, "template has no scanner");
  assert.ok(t.devices.some(d => /1-ZONE CONVEYOR/.test(d.name)));
  const a = DNET.parseDnt(fs.readFileSync(FILES.zonecard), { fileName: "zone-card code.dnt" });
  assert.equal(a.devices.length, 4);
  assert.ok(a.devices.some(d => /Scan Zone/.test(d.name)));
});

check("dnt: ArrayBuffer input + graceful failures", () => {
  if (!have(FILES.lcs)) { console.log("    (sample .dnt files not available — skipped)"); return; }
  const buf = fs.readFileSync(FILES.lcs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = DNET.parseDnt(ab, { fileName: "x.dnt" });
  assert.equal(r.devices.length, 11);
  assert.throws(() => DNET.parseDnt(new Uint8Array([1, 2, 3, 4])), /not a readable OLE2|small/i);
});

/* ---------------------------------------------------------------- merge */
function sampleRllAnalysis() {
  if (!have(SAMPLE_RLL)) return null;
  const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_RLL, "utf8"));
  return USAGE.analyzeModules(model, {});
}

check("merge: DeviceNet nodes attach to the DNB scanner bridge", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const a = sampleRllAnalysis();
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  const merged = USAGE.mergeDeviceNetIntoAnalysis(a, [parsed], {});
  assert.ok(merged.devnet, "devnet data present");
  assert.equal(merged.devnet.bridge, "Network1");
  assert.equal(merged.devnet.devices.length, 11);
  assert.equal(merged.summary.devicenetDevices, 11);
  const bridge = merged.modules.find(m => m.name === "Network1");
  assert.equal(bridge.children.length, 11);
  // pseudo modules were added to the module list
  const zpa = merged.modules.find(m => m.name === "ZPA-1 4-ZONE");
  assert.ok(zpa && zpa.devicenet, "ZPA pseudo-module");
  assert.equal(zpa.macId, 2);
  assert.equal(zpa.kind, "devicenet");
  const note = merged.notes.join("\n");
  assert.ok(/EPR 75 ms/.test(note), "scanner note");
});

check("merge: scanlist bit offsets map onto the L5X scanner image words", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const a = sampleRllAnalysis();
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  const merged = USAGE.mergeDeviceNetIntoAnalysis(a, [parsed], {});
  const zpa = merged.modules.find(m => m.name === "ZPA-1 4-ZONE");
  assert.equal(zpa.l5xInputRange, "Local:1:I.Data[100] \u2026 Local:1:I.Data[101]", "ZPA -> I.Data[100..101]");
  assert.equal(zpa.l5xOutputRange, "Local:1:O.Data[100]");
  const ct = merged.modules.find(m => m.name === "CT-1,2");
  assert.equal(ct.l5xInputRange, "Local:1:I.Data[30]", "CT-1,2 -> I.Data[30]");
  const pwr = merged.modules.find(m => m.name === "POWER DISTRIBUTION");
  assert.equal(pwr.l5xInputRange, "Local:1:I.Data[10]", "power distribution -> I.Data[10]");
  // per-node word tables carry usage + references
  assert.ok(Array.isArray(zpa.l5xInputWords) && zpa.l5xInputWords.length === 2);
  assert.ok(zpa.l5xInputWords.every(w => typeof w.used === "boolean" && Array.isArray(w.references)));
  // all pseudo modules appear in the analysis module list
  assert.equal(merged.modules.filter(m => m.devicenet).length, 11);
});

check("merge: inter-module diagram shows the DeviceNet layer with MAC + L5X words", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const a = sampleRllAnalysis();
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  const merged = USAGE.mergeDeviceNetIntoAnalysis(a, [parsed], {});
  const mm = USAGE.interModuleMermaid(merged, {});
  assert.ok(mm.indexOf("BR_Network1") !== -1, "DNB bridge node");
  assert.ok(/ZPA-1 4-ZONE/.test(mm), "ZPA node");
  assert.ok(/MAC 2/.test(mm), "MAC id on the edge/label");
  assert.ok(/Local:1:I.Data\[100\]/.test(mm), "L5X image word in the label");
  assert.ok(/DeviceNet \u00b7 MAC/.test(mm) || /DeviceNet/.test(mm), "DeviceNet edge label");
  const svg = MERMAID.renderToSvg(mm);
  assert.ok(svg.indexOf("<svg") === 0);
  assert.ok(svg.length > 5000, "rendered svg");
  // scanner bridge label carries DeviceNet + device count
  assert.ok(/11 remote device\(s\)/.test(mm));
});

check("merge: report includes DeviceNet devices", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const merged = USAGE.mergeDeviceNetIntoAnalysis(sampleRllAnalysis(), [DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" })], {});
  const md = USAGE.moduleReport(merged, { modules: [] });
  assert.ok(/1799-ZCIOV/.test(md), "catalog appears in report");
  assert.ok(/DeviceNet/.test(md));
});

/* ------------------------------------------------- UI-level smoke (no DOM) */
check("colors: network transport colours + local-logic marking", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  // standalone network diagram
  const netMm = require("../js/ui/dnet-panel.js").networkMermaid(parsed, { l5x: false });
  assert.ok(/:::netdn/.test(netMm), "DeviceNet transport colour class");
  assert.ok(/:::logic/.test(netMm), "local-logic class for 1799-ZCIOV");
  assert.ok(/local logic \(zone card\)/.test(netMm), "local logic label");
  assert.ok(/MAC 2/.test(netMm), "MAC ids on edges");
  // merged project diagrams
  const merged = USAGE.mergeDeviceNetIntoAnalysis(sampleRllAnalysis(), [parsed], {});
  const modMm = USAGE.moduleMermaid(merged, "GROUP01");
  assert.ok(/:::netip/.test(modMm), "EtherNet/IP word colour on module diagram");
  assert.ok(/network word over EtherNet\/IP/.test(modMm), "transport label on the image word");
  const inter = USAGE.interModuleMermaid(merged, {});
  assert.ok(/:::logic/.test(inter), "zone cards marked as local-logic in inter-module flow");
  assert.ok(/BR_Network1/.test(inter) && /netdn/.test(inter), "DeviceNet bridge coloured by bus");
});
check("node config: plugin-storage labels expose the card's local mapping", () => {
  if (!have(FILES.lcs)) { console.log("    (LCS sample not available — skipped)"); return; }
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  const zpa = parsed.devices.find(d => /1799-ZCIOV|ZPA-1/.test((d.catalogNumber || "") + " " + (d.name || "")));
  assert.ok(zpa, "zone card node in ZONE_TEMPLATE.dnt");
  assert.ok((zpa.pluginStrings || []).length > 50, "config strings: " + (zpa.pluginStrings || []).length);
  assert.equal(zpa.labels.zoneCount, 4, "4-zone card");
  assert.equal(zpa.labels.zoneData.length, 64, "zone data byte/bit labels (8 bytes x 8 bits)");
  assert.ok(zpa.labels.inputs.length >= 8, "local input labels: " + zpa.labels.inputs.length);
  assert.ok(zpa.labels.networkInputs.length >= 32, "network input labels: " + zpa.labels.networkInputs.length);
  assert.ok(zpa.pluginStrings.indexOf("Zone Data (Byte 0,Bit 0)") !== -1, "zone data label text");
  assert.ok((zpa.pluginTagMap || []).length >= 20, "decoded tag-name map entries: " + (zpa.pluginTagMap || []).length);
  const latchTag = (zpa.pluginTagMap || []).find(function (t) { return t.name === "Latch_1"; });
  assert.ok(latchTag && latchTag.seq >= 1, "Latch_1 maps to a function block sequence");
  assert.equal(zpa.pluginTagMap[0].name, "Latch_1", "tag map starts with Latch_1");
  assert.equal((zpa.zoneTags || []).length, 64, "zone-data tag database bits: " + (zpa.zoneTags || []).length);
  assert.deepEqual(zpa.zoneTags[0], { byte: 0, bit: 0, label: "Zone Data (Byte 0,Bit 0)", tagId: 33 });
  assert.equal(zpa.zoneTags[63].byte, 7);
  assert.equal(zpa.zoneTags[63].bit, 7);
  assert.equal(zpa.zoneTags[63].tagId, 96);
  const classify = DNET.extractZoneTags;
  assert.ok(typeof classify === "function", "extractZoneTags exported");
  // classifier sanity on synthetic input
  const cls = DNET.classifyNodeLabels(["Zone Data (Byte 1,Bit 2)", "2 Zone", "Network Input 7", "Input 3", "Output 5", "SAMPLE"]);
  assert.equal(cls.zoneData.length, 1, "classified zone label");
  assert.equal(cls.zoneCount, 2, "classified zone count");
  assert.equal(cls.networkInputs.length, 1, "classified network input");
  assert.equal(cls.inputs.length, 1, "classified input");
  assert.equal(cls.outputs.length, 1, "classified output");
  assert.equal(cls.other.length, 1, "classified other label");
  // node view panel is exported for the tab/sidebar flow
  const panel = require("../js/ui/dnet-panel.js");
  assert.ok(typeof panel.DnetNodePanel === "function", "DnetNodePanel exported");
  assert.ok(typeof panel.renderNodeCode === "function", "renderNodeCode exported");
});
check("merge: repeated analysis is stable (idempotent inputs)", () => {
  if (!have(FILES.lcs) || !have(SAMPLE_RLL)) { console.log("    (samples not available — skipped)"); return; }
  const parsed = DNET.parseDnt(fs.readFileSync(FILES.lcs), { fileName: "ZONE_TEMPLATE.dnt" });
  const a1 = USAGE.mergeDeviceNetIntoAnalysis(sampleRllAnalysis(), [parsed], {});
  const a2 = USAGE.mergeDeviceNetIntoAnalysis(sampleRllAnalysis(), [parsed], {});
  assert.equal(a1.modules.length, a2.modules.length);
  assert.equal(a1.devnet.devices.length, a2.devnet.devices.length);
});

console.log("\ndnet: " + (checks - failures) + " passed, " + failures + " failed");
if (failures) process.exitCode = 1;
