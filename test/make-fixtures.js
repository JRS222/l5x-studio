// One-off fixture generator for L5X Studio (Lead). Generates test/fixtures/*.json
// from the three real L5X files and prints instruction-op frequency stats.
const fs = require("fs");

function parseXml(xmlText) {
  const text = xmlText.replace(/^\uFEFF/, "");
  const pos = { i: 0 };
  function skipWs() { while (pos.i < text.length && /\s/.test(text[pos.i])) pos.i++; }
  function parseAttrs() {
    const attrs = {};
    while (pos.i < text.length) {
      skipWs();
      const c = text[pos.i];
      if (c === ">" || c === "/" || c === "?") break;
      const m = /^[^\s=/>]+/.exec(text.slice(pos.i));
      if (!m) break;
      const name = m[0]; pos.i += name.length;
      skipWs();
      if (text[pos.i] !== "=") { attrs[name] = ""; continue; }
      pos.i++;
      skipWs();
      const q = text[pos.i];
      if (q === '"' || q === "'") { pos.i++; let val = ""; while (pos.i < text.length && text[pos.i] !== q) { val += text[pos.i++]; } pos.i++; attrs[name] = val; }
      else { const m2 = /^[^\s>]*/.exec(text.slice(pos.i)); attrs[name] = m2[0]; pos.i += m2[0].length; }
    }
    return attrs;
  }
  function parseNode(depth) {
    depth = depth || 0;
    if (depth > 200) throw new Error("XML depth exceeded near: " + JSON.stringify(text.slice(pos.i, pos.i + 120)));
    skipWs();
    if (pos.i >= text.length) return null;
    if (text.startsWith("<!--", pos.i)) { pos.i = text.indexOf("-->", pos.i) + 3; return null; }
    if (text.startsWith("<?", pos.i)) { pos.i = text.indexOf("?>", pos.i) + 2; return null; }
    if (text.startsWith("<![CDATA[", pos.i)) {
      const e = text.indexOf("]]>", pos.i);
      const seg = text.slice(pos.i + 9, e);
      pos.i = e + 3;
      return { type: "cdata", text: seg };
    }
    if (text.startsWith("<!", pos.i)) { pos.i = text.indexOf(">", pos.i) + 1; return null; }
    if (text[pos.i] !== "<") {
      let e = text.indexOf("<", pos.i);
      if (e === -1) e = text.length;
      const seg = text.slice(pos.i, e);
      pos.i = e;
      return { type: "text", text: seg };
    }
    if (text[pos.i + 1] === "/") return null; // closing tag: let parent loop handle it
    pos.i++;
    if (text.startsWith("![CDATA[", pos.i)) {
      const e = text.indexOf("]]>", pos.i);
      const seg = text.slice(pos.i + 8, e);
      pos.i = e + 3;
      return { type: "cdata", text: seg };
    }
    if (text[pos.i] === "/" || text[pos.i] === "!" || text[pos.i] === "?") { pos.i = text.indexOf(">", pos.i) + 1; return null; }
    const m = /^[A-Za-z_][\w.:-]*/.exec(text.slice(pos.i));
    if (!m) { pos.i++; return null; }
    const name = m[0]; pos.i += name.length;
    const attrs = parseAttrs();
    skipWs();
    const node = { type: "element", name, attrs, children: [] };
    if (text[pos.i] === "/") { pos.i += 2; return node; }
    if (text[pos.i] === ">") pos.i++;
    while (pos.i < text.length) {
      if (text.startsWith("</", pos.i)) { pos.i = text.indexOf(">", pos.i) + 1; break; }
      const child = parseNode(depth + 1);
      if (child) node.children.push(child);
      if (pos.i >= text.length) break;
    }
    return node;
  }
  const kids = [];
  while (pos.i < text.length) { const c = parseNode(); if (c) kids.push(c); }
  return { type: "element", name: "#doc", attrs: {}, children: kids };
}
function first(node, name) { return (node && node.children || []).find(c => c.type === "element" && c.name === name); }
function all(node, name) { return (node && node.children || []).filter(c => c.type === "element" && c.name === name); }
function textOf(node) { if (!node) return ""; return (node.children || []).filter(c => c.type === "text" || c.type === "cdata").map(c => c.text).join(""); }

const files = [
  "C:/samples/controller.L5X",
  "C:/samples/sample-file",
  "C:/samples/structured-text.L5X"
];
const out = { sources: {} };
for (const f of files) {
  const doc = parseXml(fs.readFileSync(f, "utf8"));
  const ctrl = first(doc, "Controller") || first(first(doc, "RSLogix5000Content"), "Controller");
  if (!ctrl) { console.log("NO CONTROLLER in", f, "top:", JSON.stringify(doc.children.map(c => c.name))); continue; }
  console.log("controller children in", f.split("/").pop(), ":", JSON.stringify(ctrl.children.filter(c => c.type === "element").map(c => c.name)));
  const key = f.split("/").pop();
  const src = { routines: [] };
  const programs = first(ctrl, "Programs");
  for (const p of all(programs, "Program")) {
    const routines = first(p, "Routines");
    for (const r of all(routines, "Routine")) {
      const name = r.attrs.Name, type = r.attrs.Type;
      if (type === "RLL") {
        const rll = first(r, "RLLContent");
        const rungs = all(rll, "Rung").map(rg => ({
          number: rg.attrs.Number || "", type: rg.attrs.Type || "",
          comment: textOf(first(rg, "Comment")), text: textOf(first(rg, "Text"))
        }));
        const plain = textOf(rll);
        src.routines.push({ program: p.attrs.Name, name, type, rungs: rungs.length ? rungs : null, plain: rungs.length ? null : plain });
      } else if (type === "ST") {
        const st = first(r, "STContent");
        const lines = all(st, "Line").map(l => textOf(l)).join("\n");
        src.routines.push({ program: p.attrs.Name, name, type, text: lines || textOf(st) });
      }
    }
  }
  out.sources[key] = src;
}

const fxDir = "l5x-studio/test/fixtures";
fs.mkdirSync(fxDir, { recursive: true });
const pick = (src, names, max = 3) => src.routines.filter(r => names.some(n => r.name === n)).slice(0, max);
const sampleRll = out.sources["SAMPLE_RLL.L5X"];
const sampleProcess = out.sources["SAMPLE_PROCESS.L5X"];
const sampleSt = out.sources["SAMPLE_ST.L5X"];
fs.writeFileSync(fxDir + "/sampleRll-rll.json", JSON.stringify(pick(sampleRll, ["MAIN_TASK_MAIN", "GROUP_CYCLE", "BUILD_SOCKET_MSG_DISCHARGED"]), null, 1));
fs.writeFileSync(fxDir + "/sampleProcess-rll.json", JSON.stringify(pick(sampleProcess, ["AFCS_MAIN"]), null, 1));
fs.writeFileSync(fxDir + "/sampleSt-st.json", JSON.stringify(pick(sampleSt, ["MappedIO", "Date", "EventLogInterface"]), null, 1));
console.log("sampleRll rll routines:", sampleRll.routines.length);
console.log("sampleProcess rll routines:", sampleProcess.routines.length);
console.log("sampleSt st routines:", sampleSt.routines.filter(r => r.type === "ST").length);
const ops = new Map();
for (const src of Object.values(out.sources)) {
  for (const r of src.routines) {
    const texts = r.rungs ? r.rungs.map(x => x.text) : r.plain ? r.plain.split("\n") : [];
    for (const t of texts) {
      const m = t.match(/[A-Za-z_][A-Za-z0-9_]*\(/g);
      if (m) for (const o of m) { const k = o.slice(0, -1); ops.set(k, (ops.get(k) || 0) + 1); }
    }
  }
}
console.log("distinct ops:", ops.size);
console.log([...ops.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ":" + v).join(" "));
