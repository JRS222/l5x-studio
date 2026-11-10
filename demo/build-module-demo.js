/* Build the module-level I/O dataflow demo artifacts:
 *   demo/module-diagrams/
 *     SAMPLE_RLL-project.mmd / .svg          — project module network (Mermaid)
 *     SAMPLE_RLL-GROUP01.mmd / .svg / -schematic.svg
 *     SAMPLE_RLL-PDP.mmd  ... , SAMPLE_RLL-Network1 ... (network + chassis examples)
 *     SAMPLE_RLL-module-report.md            — usage report (used bits/points per module)
 *     SAMPLE_RLL-module-usage.json           — full machine-readable analysis
 *     CONVEYOR-DEMO-* .mmd/.svg          — generated conveyor project modules (ZPA + device blocks)
 *
 * Mermaid text renders in any Mermaid viewer (mermaid.live); the .svg files are rendered
 * offline by js/mermaid-render.js so the diagrams can be opened without a network.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const MODEL = require("../js/l5x-model.js");
const USAGE = require("../js/module-usage.js");
const MERMAID = require("../js/mermaid-render.js");

const OUT = path.join(__dirname, "module-diagrams");
const SAMPLE_RLL = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/path/to/controller.L5X";
const CONVEYOR = path.join(__dirname, "conveyor", "DEMO_CONVEYOR-controller.L5X");

fs.mkdirSync(OUT, { recursive: true });

function write(name, text) {
  fs.writeFileSync(path.join(OUT, name), text, "utf8");
  return name + " (" + (text.length / 1024).toFixed(1) + " KB)";
}

function buildProject(label, file, moduleNames) {
  const model = MODEL.parseL5X(fs.readFileSync(file, "utf8"));
  const a = USAGE.analyzeModules(model, {});
  const written = [];
  written.push(write(label + "-project.mmd", USAGE.projectMermaid(a)));
  written.push(write(label + "-project.svg", MERMAID.renderToSvg(USAGE.projectMermaid(a))));
  written.push(write(label + "-intermodule.mmd", USAGE.interModuleMermaid(a, {})));
  written.push(write(label + "-intermodule.svg", MERMAID.renderToSvg(USAGE.interModuleMermaid(a, {}))));
  written.push(write(label + "-module-report.md", USAGE.moduleReport(a, { modules: moduleNames })));
  written.push(write(label + "-module-usage.json", JSON.stringify(a, null, 1)));
  for (const name of moduleNames) {
    const m = a.modules.find(x => x.name === name);
    if (!m) { console.log("  module " + name + " not in " + label); continue; }
    const mm = USAGE.moduleMermaid(a, name);
    written.push(write(label + "-" + name + ".mmd", mm));
    written.push(write(label + "-" + name + ".svg", MERMAID.renderToSvg(mm)));
    written.push(write(label + "-" + name + "-schematic.svg", USAGE.moduleSchematicSvg(a, name)));
  }
  console.log(label + ": " + a.summary.modules + " modules (" + a.summary.network + " network, " +
    a.summary.hardware + " hardware, " + a.summary.subdevices + " sub-devices), used points " +
    a.summary.usedPoints + "/" + a.summary.totalPoints + "; files: " + written.length);
  for (const w of written) console.log("  ", w);
  return a;
}

let sampleRllOk = false;
if (fs.existsSync(SAMPLE_RLL)) {
  buildProject("SAMPLE_RLL", SAMPLE_RLL, ["GROUP01", "PDP", "Network1", "IND01", "SORTER01"]);
  sampleRllOk = true;
} else {
  console.log("SAMPLE_RLL.L5X not found (" + SAMPLE_RLL + ") - skipped");
}

if (fs.existsSync(CONVEYOR)) {
  const model = MODEL.parseL5X(fs.readFileSync(CONVEYOR, "utf8"));
  const a = USAGE.analyzeModules(model, {});
  const names = a.modules.filter(m => m.kind !== "controller" && m.summary.totalInputBits > 0).slice(0, 6).map(m => m.name);
  buildProject("CONVEYOR-DEMO", CONVEYOR, names);
} else {
  console.log("generated conveyor demo not found (" + CONVEYOR + ") - run demo/build-conveyor-demo.js first");
}

/* Optional: merge a DeviceNet network configuration (.dnt) into the SAMPLE_RLL analysis so the
   demo shows the fully inclusive PLC + remote DeviceNet system (nodes behind the 1756-DNB). */
const SAMPLE_DNT = path.join(OUT, "ZONE_TEMPLATE.dnt");
try {
  const DNET = require("../js/dnet.js");
  if (sampleRllOk && fs.existsSync(SAMPLE_DNT)) {
    const parsed = DNET.parseDnt(fs.readFileSync(SAMPLE_DNT), { fileName: "ZONE_TEMPLATE.dnt" });
    const model = MODEL.parseL5X(fs.readFileSync(SAMPLE_RLL, "utf8"));
    const merged = USAGE.mergeDeviceNetIntoAnalysis(USAGE.analyzeModules(model, {}), [parsed], {});
    write("SAMPLE_RLL-intermodule-with-dnt.mmd", USAGE.interModuleMermaid(merged, {}));
    write("SAMPLE_RLL-intermodule-with-dnt.svg", MERMAID.renderToSvg(USAGE.interModuleMermaid(merged, {})));
    write("SAMPLE_RLL-module-usage-with-dnt.json", JSON.stringify(merged, null, 1));
    write("SAMPLE_RLL-module-report-with-dnt.md", USAGE.moduleReport(merged, { modules: [] }));
    const lines = ["# DeviceNet network from ZONE_TEMPLATE.dnt", ""];
    if (merged.devnet.scannerInfo) {
      lines.push("Scanner `" + merged.devnet.bridge + "` (1756-DNB): EPR " + merged.devnet.scannerInfo.eprMs +
        " ms, interscan " + merged.devnet.scannerInfo.interscanDelayMs + " ms, poll ratio " + merged.devnet.scannerInfo.pollRatio +
        ", retries " + merged.devnet.scannerInfo.transmitRetries + ".");
      lines.push("");
    }
    lines.push("| MAC | Name | Catalog | Transfer | I/O bytes | L5X image words |");
    lines.push("|---|---|---|---|---|---|");
    for (const d of merged.devnet.devices) {
      lines.push("| " + d.macId + " | " + (d.name || "") + " | " + (d.catalogNumber || "") + " | " + (d.transferType || "") +
        " | " + d.inputBytes + " / " + d.outputBytes + " | " + [d.l5xInputRange, d.l5xOutputRange].filter(Boolean).join(" | ") + " |");
    }
    write("SAMPLE_RLL-devicenet-devices.md", lines.join("\n") + "\n");
    console.log("DeviceNet merge: " + merged.devnet.devices.length + " nodes attached to " + merged.devnet.bridge);
  }
} catch (e) { console.log("DeviceNet merge skipped:", e.message); }

console.log("\nartifacts in demo/module-diagrams/:");
for (const f of fs.readdirSync(OUT)) {
  console.log("  ", f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + " KB");
}
