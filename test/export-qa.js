/* Final export QA (Lead): stage mixed conversions on all three real projects, export,
   write the exported files to test/out/, and report sizes/checksums for external
   well-formedness validation (run validate-exports.ps1 after this). */
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));
const modelApi = JS("l5x-model.js");
const langConv = JS("lang-convert.js");
const fbdConv = JS("fbd-convert.js");
const exportApi = JS("export.js");

const FILES = [
  "C:/samples/controller.L5X",
  "C:/samples/sample-file",
  "C:/samples/structured-text.L5X"
];
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

for (const f of FILES) {
  const name = path.basename(f).replace(/\.L5X$/i, "");
  const model = modelApi.parseL5X(fs.readFileSync(f, "utf8"));
  const rll = [], st = [];
  for (const p of model.programs) for (const r of p.routines) {
    if (r.type === "RLL" && rll.length < 2) rll.push({ p: p.name, r });
    if (r.type === "ST" && st.length < 1) st.push({ p: p.name, r });
  }
  const tasks = [];
  if (rll[0]) tasks.push({ prog: rll[0].p, rout: rll[0].r.name, target: "ST" });
  if (rll[1]) tasks.push({ prog: rll[1].p, rout: rll[1].r.name, target: "FBD" });
  if (st[0]) tasks.push({ prog: st[0].p, rout: st[0].r.name, target: "RLL" });
  for (const tk of tasks) {
    const ir = modelApi.getRoutineIR(model, tk.prog, tk.rout);
    let conv;
    if (tk.target === "ST") conv = langConv.ladToSt(ir);
    else if (tk.target === "RLL") conv = langConv.stToLad(ir);
    else conv = fbdConv.ladToFbd(ir);
    const content = modelApi.irToContent(model, tk.prog, tk.rout, conv.ir);
    model.setRoutineContent(tk.prog, tk.rout, tk.target, content);
  }
  const res = exportApi.exportL5X(model, {});
  const outFile = path.join(outDir, name + "-modified.L5X");
  fs.writeFileSync(outFile, res.text, "utf8");
  // re-parse with our parser as a sanity check
  const m2 = modelApi.parseL5X(res.text);
  const wrong = [];
  for (const tk of tasks) {
    const r2 = modelApi.findRoutine(m2, tk.prog, tk.rout);
    if (!r2 || r2.type !== tk.target) wrong.push(tk.prog + "/" + tk.rout);
  }
  console.log(name + ": exported " + (res.text.length / 1048576).toFixed(2) + " MB, " +
    tasks.length + " routines converted, warnings=" + res.warnings.length +
    (wrong.length ? " BAD: " + wrong.join(",") : " ok"));
  for (const w of res.warnings) console.log("    warn: " + w);
}
console.log("exports written to test/out/");
