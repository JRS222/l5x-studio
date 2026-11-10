/* L5X Studio — RSNetWorx HTML logic exports (DeviceNet node logic).
 *
 * RSNetWorx ports the DeviceNet card's ladder logic to a function-block (FBD) rendition in its
 * "Export to HTML" report. We parse that Logic table (Seq No | Attributes | Bound to) and render
 * it as a layered FBD view in the node tab.
 */
"use strict";
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const H = require("../js/dnet-html.js");
const DNET = require("../js/dnet.js");
const MER = require("../js/mermaid-render.js");

const DIR = process.env.L5X_STUDIO_DNET_HTML || path.join(__dirname, "..", "demo", "devicenet-html");
const LCS = path.join(DIR, "ZONE_TEMPLATE.html");
const ZONECARD = path.join(DIR, "zone-card code.html");

let checks = 0, failures = 0, skipped = 0;
class Skip extends Error {}
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok - " + name); }
  catch (e) {
    if (e instanceof Skip) { skipped++; console.log("skip - " + name + " (" + e.message + ")"); return; }
    failures++; console.error("FAIL - " + name); console.error("    " + String((e && e.stack) || e));
  }
}
function load(file) {
  if (!file || !fs.existsSync(file)) throw new Skip("RSNetWorx HTML sample not available: " + file);
  return H.parseRsnetHtml(fs.readFileSync(file, "utf8"), { fileName: path.basename(file) });
}

check("html: recognises an RSNetWorx DeviceNet report and rejects other HTML", () => {
  if (!fs.existsSync(LCS)) throw new Skip("RSNetWorx HTML sample not available");
  assert.ok(H.isRsnetHtml(fs.readFileSync(LCS, "utf8")), "LCS report detected");
  assert.ok(!H.isRsnetHtml("<html><body>hello</body></html>"), "plain HTML rejected");
  assert.throws(() => H.parseRsnetHtml("<html></html>", {}), /RSNetWorx|device/i);
});

check("html: ZONE_TEMPLATE report — devices, logic availability, block totals", () => {
  const parsed = load(LCS);
  assert.equal(parsed.dntFileName, "H:\\ZONE_TEMPLATE.dnt", "original .dnt path from the report");
  assert.equal(parsed.networkName, "ZONE_TEMPLATE");
  assert.equal(parsed.summary.devices, 12, "devices: " + parsed.summary.devices);
  assert.equal(parsed.summary.devicesWithLogic, 9, "devices with logic: " + parsed.summary.devicesWithLogic);
  assert.equal(parsed.summary.blocks, 712, "function blocks: " + parsed.summary.blocks);
  const byName = {};
  for (const d of parsed.devices) byName[d.name] = d;
  assert.ok(byName["POWER DISTRIBUTION"] && byName["POWER DISTRIBUTION"].noLogic, "power distribution reports no logic");
  assert.equal(byName["ZPA-1 4-ZONE"].logic.count, 64, "zone card blocks");
  assert.equal(byName["CT-1,2"].logic.count, 81, "CT card blocks");
  assert.equal(byName["ZPA-1 4-ZONE"].catalogNumber, "1799-ZCIOV");
  assert.ok(byName["ZPA-1 4-ZONE"].parameters.length >= 40, "EDS parameters parsed from the report");
  assert.equal(byName["ZPA-1 4-ZONE"].address, 2);
});

check("html: logic blocks — types, parameters, bindings and complements", () => {
  const parsed = load(LCS);
  const zpa = parsed.devices.find(d => d.name === "ZPA-1 4-ZONE");
  const b1 = zpa.logic.bySeq[1];
  assert.equal(b1.type, "SR LATCH");
  assert.equal(b1.bindings.length, 2, "latch input + reset");
  assert.equal(b1.bindings[0].input, "Input");
  assert.equal(b1.bindings[0].targetSeq, 16);
  assert.equal(b1.bindings[0].targetType, "ON DELAY TIMER");
  assert.equal(b1.bindings[1].input, "Reset");
  assert.equal(b1.bindings[1].targetSeq, 17);
  const b2 = zpa.logic.bySeq[2];
  assert.equal(b2.type, "AND");
  assert.equal(b2.bindings[0].input, "Input 2");
  assert.equal(b2.bindings[0].complement, true, "complement (NOT) flag");
  assert.equal(b2.bindings[0].targetSeq, 1);
  const timer = zpa.logic.bySeq[5];
  assert.equal(timer.type, "OFF DELAY TIMER");
  assert.deepEqual(timer.params.map(p => [p.name, p.value]), [["Preset", "200"], ["Timebase", "10 ms"]]);
  assert.equal(timer.bindings[0].targetSeq, 4);
  const seqs = zpa.logic.blocks.map(b => b.seq);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), "blocks sorted by sequence");
});

check("html: zone card report — four zone configurations", () => {
  const parsed = load(ZONECARD);
  assert.equal(parsed.summary.devices, 4);
  assert.equal(parsed.summary.devicesWithLogic, 4);
  assert.equal(parsed.summary.blocks, 174);
  const names = parsed.devices.map(d => d.name);
  assert.ok(names.indexOf("Scan Zone (2 ZONES)") !== -1, "2-zone config: " + names.join(", "));
  assert.ok(names.indexOf("NORMAL (1 ZONES)") !== -1, "1-zone config");
  assert.equal(parsed.devices.find(d => d.name === "Scan Zone (2 ZONES)").logic.count, 36);
});

check("html: layered FBD SVG renders every block, edges and parameters", () => {
  const parsed = load(LCS);
  const zpa = parsed.devices.find(d => d.name === "ZPA-1 4-ZONE");
  const r = H.logicSvg(zpa);
  assert.ok(r.svg.indexOf("<svg") === 0, "SVG document");
  const boxes = (r.svg.match(/class="fbd-block /g) || []).length;
  assert.equal(boxes, 64, "one FBD box per function block: " + boxes);
  const edges = (r.svg.match(/marker-end="url\(#fbd-arrow\)"/g) || []).length;
  assert.ok(edges >= 60, "FB-to-FB edges: " + edges);
  assert.ok(r.svg.indexOf("Preset 200") !== -1, "timer parameters in the box");
  assert.ok(r.svg.indexOf("(\u00ac)") !== -1, "complement marker in binding rows");
  assert.ok(r.width > 2000 && r.height > 600, "drawing size " + r.width + "x" + r.height);
  const layers = H.logicLayers(zpa);
  assert.equal(layers.length, 12, "dependency layers: " + layers.length);
  const empty = H.logicSvg({ logic: null });
  assert.ok(empty.svg.indexOf("No logic") !== -1, "empty-state SVG");
});

check("html: mermaid + markdown logic representations", () => {
  const parsed = load(LCS);
  const zpa = parsed.devices.find(d => d.name === "ZPA-1 4-ZONE");
  const mmd = H.logicMermaid(zpa, { all: true });
  assert.ok(/^flowchart LR/m.test(mmd), "mermaid flowchart");
  assert.ok(/FB1\["1 \u00b7 SR LATCH"\]:::latch/.test(mmd), "block node with latch class");
  assert.ok(/-->\|/.test(mmd), "edges carry input labels");
  const svg = MER.renderToSvg(mmd);
  assert.ok(/^<svg/.test(svg) && svg.length > 10000, "mermaid renderer handles the logic graph (" + svg.length + " chars)");
  const md = H.logicReport(zpa);
  assert.ok(/DeviceNet logic/.test(md) && /SR LATCH/.test(md) && /Function Block 16/.test(md), "markdown report");
});


check("html: local-logic cross reference from the card configuration", () => {
  const dntPath = "C:/samples/devicenet/zone-template.dnt";
  if (!fs.existsSync(dntPath)) { console.log("    (ZONE_TEMPLATE.dnt not available — skipped)"); return; }
  const parsedDnt = DNET.parseDnt(fs.readFileSync(dntPath), { fileName: "ZONE_TEMPLATE.dnt" });
  const node = parsedDnt.devices.find(d => d.macId === 2);
  const dev = load(LCS).devices.find(d => d.address === 2);
  const local = H.parseLocalLabels(node.pluginStrings, node.pluginTagMap);
  H.annotateLogic(dev, local);
  assert.equal(node.pluginTagMap.length, 23, "decoded tag map entries: " + node.pluginTagMap.length);
  assert.equal(node.pluginTagMap[0].name, "Latch_1");
  assert.equal(node.pluginTagMap[0].seq, 1);
  assert.equal(dev.logic.namedBlocks, 23, "annotated blocks: " + dev.logic.namedBlocks);
  const latch = dev.logic.bySeq[1];
  assert.equal(latch.tag, "Latch_1");
  assert.ok(/Jam Latch/i.test(latch.description), "latch description: " + latch.description);
  const timer5 = dev.logic.bySeq[16];
  assert.equal(timer5.tag, "Timer_5");
  assert.ok(/Jam Timer/i.test(timer5.description), "timer description: " + timer5.description);
  assert.ok(local.aliases.length >= 10, "I/O aliases: " + local.aliases.length);
  const dip = local.aliases.find(a => a.prefix === "DIP");
  assert.ok(dip && dip.kind === "device input point", "device input alias kind");
  const cnb = local.aliases.find(a => a.prefix === "CNB" || a.prefix === "PNB");
  assert.ok(cnb && /network bit/.test(cnb.kind), "network bit alias kind");
});

check("html: ST / ladder renditions use the configured labels", () => {
  const dntPath = "C:/samples/devicenet/zone-template.dnt";
  if (!fs.existsSync(dntPath)) { console.log("    (ZONE_TEMPLATE.dnt not available — skipped)"); return; }
  const parsedDnt = DNET.parseDnt(fs.readFileSync(dntPath), { fileName: "ZONE_TEMPLATE.dnt" });
  const node = parsedDnt.devices.find(d => d.macId === 2);
  const dev = load(LCS).devices.find(d => d.address === 2);
  H.annotateLogic(dev, H.parseLocalLabels(node.pluginStrings, node.pluginTagMap));
  const st = H.logicToSt(dev);
  assert.ok(/Latch_1 := SR_LATCH\(/.test(st), "ST latch assignment uses the configured tag");
  assert.ok(/Jam Latch/.test(st), "ST comments carry the configured description");
  assert.ok(/:=/.test(st) && /IO\d+_\d+/.test(st), "ST placeholders for unbound inputs");
  const lad = H.logicToLad(dev);
  assert.ok(/OTL\(Latch_1\)/.test(lad) && /OTU\(Latch_1\)/.test(lad), "ladder set/reset rungs use the configured tag");
  assert.ok(/OTE\(FB2\)|OTE\(FB\d+\)/.test(lad), "ladder output rungs produced");
  const ir = H.logicToLadIR(dev);
  assert.ok(ir && ir.kind === "lad" && ir.rungs.length >= 60, "ladder IR rungs: " + (ir ? ir.rungs.length : 0));
  const ser = require("../js/rll-serialize.js");
  const texts = ir.rungs.map(function (g) { try { return ser.serializeRllRung(g.root); } catch (e) { return ""; } }).join("\n");
  assert.ok(/OTL\(Latch_1\)/.test(texts), "ladder IR contains the latch set rung");
  assert.ok(/OTE\(FB2\)|OTE\(FB\d+\)/.test(texts), "ladder IR contains boolean output rungs");
  assert.ok(/TOF\(Timer_1/.test(texts), "ladder IR contains timer instruction rungs");
  const table = H.logicLabelsTable(dev);
  assert.ok(table.aliases.length >= 10, "label rows: " + table.aliases.length);
  assert.ok(table.tags.length >= 20, "tagged block rows: " + table.tags.length);
});

check("html: FBD drawing is annotated with configured tags and I/O placeholders", () => {
  const dntPath = "C:/samples/devicenet/zone-template.dnt";
  if (!fs.existsSync(dntPath)) { console.log("    (ZONE_TEMPLATE.dnt not available — skipped)"); return; }
  const parsedDnt = DNET.parseDnt(fs.readFileSync(dntPath), { fileName: "ZONE_TEMPLATE.dnt" });
  const node = parsedDnt.devices.find(d => d.macId === 2);
  const dev = load(LCS).devices.find(d => d.address === 2);
  H.annotateLogic(dev, H.parseLocalLabels(node.pluginStrings, node.pluginTagMap));
  const svg = H.logicSvg(dev).svg;
  assert.ok(svg.indexOf("Latch_1") !== -1, "tag text on a block");
  assert.ok(/Jam Latch|Move-In Timer/.test(svg), "configured description text on a block");
  assert.ok((svg.match(/\(I\/O\)/g) || []).length >= 10, "unbound inputs shown as I/O placeholders");
  assert.ok((svg.match(/class="fbd-block /g) || []).length === 64, "all blocks still drawn");
});

console.log("\ndnet-html: " + (checks - failures - skipped) + " passed, " + failures + " failed, " + skipped + " skipped (sample-dependent)");
if (failures) process.exitCode = 1;
