/* UI smoke test (Lead): load every script like index.html does (browser mode, flat
   L5XStudio namespace), drive the App through the main happy paths with a minimal DOM
   stub, and assert the wiring. Catches missing exports, typos and null refs without a
   real browser. Modules that have not been delivered yet are skipped with a notice. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = [
  "js/util.js", "js/xml.js", "js/operands.js", "js/ir.js", "js/rll-parse.js",
  "js/rll-serialize.js", "js/st-parse.js", "js/st-serialize.js", "js/lang-convert.js",
  "js/fbd-parse.js", "js/fbd-serialize.js", "js/fbd-convert.js", "js/dataflow.js",
  "js/l5x-model.js", "js/resolve.js", "js/io-map.js", "js/graph-layout.js",
  "js/render/svg.js", "js/render/udt.js", "js/render/diagram.js", "js/render/ladder.js",
  "js/render/fbd.js", "js/ui/editor-st.js", "js/ui/iopanel.js", "js/ui/convert.js",
  "js/export.js", "js/schema-validate.js", "js/io-list.js", "js/l5k-data.js",
  "js/codegen-c.js", "js/health.js", "js/acd.js",
  "js/ui/validation-panel.js", "js/ui/iolist-panel.js", "js/ui/health-panel.js",
  "js/ui/aoi-panel.js", "js/ui/acd-panel.js",
  "js/conveyor/model.js", "js/conveyor/designer2d.js", "js/conveyor/render3d.js",
  "js/conveyor/parts.js", "js/data/parts-catalog.js", "js/data/conveyor-templates.js",
  "js/conveyor/l5xgen.js", "js/conveyor/hmi.js", "js/ui/conveyor-panel.js",
  "js/data/schema-v32.js", "js/data/schema-v33.js", "js/data/schema-v34.js",
  "js/data/schema-v35.js", "js/data/schema-v36.js", "js/data/schema-v37.js",
  "js/dnet.js", "js/module-usage.js", "js/mermaid-render.js", "js/dnet-html.js", "js/ui/module-panel.js", "js/ui/zoom-view.js", "js/ui/dnet-panel.js", "js/ui/app.js"
];

/* ---------- minimal DOM stub ---------- */
let nextId = 0;
function makeCtx2d() {
  const calls = { count: 0 };
  const noop = function () { calls.count++; };
  const ctx = {
    calls: calls,
    canvas: null,
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    globalAlpha: 1, lineCap: "", lineJoin: "",
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, rect: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    arc: noop, ellipse: noop, bezierCurveTo: noop, quadraticCurveTo: noop, translate: noop,
    rotate: noop, scale: noop, setTransform: noop, resetTransform: noop, transform: noop,
    fillText: noop, strokeText: noop, measureText: function (t) { return { width: String(t).length * 6 }; },
    setLineDash: noop, getLineDash: function () { return []; },
    createLinearGradient: function () { return { addColorStop: noop }; },
    drawImage: noop, putImageData: noop, getImageData: function () { return { data: [] }; },
    clip: noop
  };
  return ctx;
}
function makeEl(tag) {
  const el = {
    _id: ++nextId,
    tagName: String(tag || "div").toUpperCase(),
    children: [], parentNode: null,
    className: "", value: "", dataset: {}, title: "", width: 800, height: 600,
    style: { cssText: "", display: "", left: "", top: "", width: "", height: "" },
    attrs: {}, _ev: {}, _innerHTML: "",
    getContext: function (type) { return type === "2d" ? makeCtx2d() : null; },
    toDataURL: function () { return "data:image/png;base64,"; },
    set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
    get innerHTML() { return this._innerHTML; },
    textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); },
    getAttribute(k) { return k === "class" ? this.className : this.attrs[k] !== undefined ? this.attrs[k] : null; },
    appendChild(c) {
      if (c && c.parentNode) c.parentNode.removeChild(c);
      if (c) { c.parentNode = this; this.children.push(c); }
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    insertBefore(c, ref) {
      if (c && c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      c.parentNode = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    addEventListener(type, fn) { (this._ev[type] = this._ev[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = this._ev[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(type, ev) {
      const l = this._ev[type] || [];
      ev = ev || { preventDefault() { }, stopPropagation() { }, target: this };
      l.forEach(f => f.call(this, ev));
      return true;
    },
    click() { this.dispatch("click", { preventDefault() { }, stopPropagation() { }, target: this }); },
    focus() { }, blur() { },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get firstElementChild() { return this.children[0] || null; },
    get childNodes() { return this.children; },
    offsetWidth: 800, offsetHeight: 600, clientWidth: 800, clientHeight: 600,
    scrollWidth: 800, scrollHeight: 600, scrollTop: 0, scrollLeft: 0,
    getBBox() { return { width: 60, height: 18, x: 0, y: 0 }; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }; },
    closest() { return null; },
    scrollIntoView() { },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    createSVGPoint() { return { matrixTransform() { return { x: 0, y: 0 }; } }; },
    querySelectorAll(sel) {
      const out = [];
      function matches(n) {
        if (sel === "*") return true;
        if (sel.startsWith(".")) return n.className.split(/\s+/).includes(sel.slice(1));
        return false;
      }
      (function walk(n) {
        for (const c of n.children) {
          if (matches(c)) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; }
  };
  return el;
}
const document = {
  createElement: t => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  createTextNode: t => { const e = makeEl("#text"); e.textContent = String(t); return e; },
  addEventListener() { }, removeEventListener() { },
  body: makeEl("body")
};
function makeWindow() {
  const win = {
    document: document,
    addEventListener() { }, removeEventListener() { },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    getComputedStyle: () => ({ width: "100px" }),
    performance: { now: () => Date.now() },
    URL: { createObjectURL: () => "blob:stub", revokeObjectURL() { } },
    Blob: function (parts) { this.parts = parts; },
    DecompressionStream: typeof DecompressionStream !== "undefined" ? DecompressionStream : undefined,
    TextDecoder: TextDecoder,
    location: { protocol: "file:", href: "file:///stub" }
  };
  win.self = win;
  win.window = win;
  return win;
}

/* ---------- load all scripts browser-style ---------- */
const win = makeWindow();
win.root = win;
const loaded = [];
const skipped = [];
for (const rel of SCRIPTS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { skipped.push(rel); continue; }
  try {
    const src = fs.readFileSync(full, "utf8");
    const fn = new Function("window", "self", "document", "root", src);
    fn.call(win, win, win, document, win);
    loaded.push(rel);
    if (rel.indexOf("dnet-panel") !== -1) console.log("in-loop after dnet-panel:", typeof win.L5XStudio.DeviceNetPanel, "| root===win:", win.root === win, "| self===win:", win.self === win);
    if (rel.indexOf("app.js") !== -1) console.log("in-loop after app.js: DnetPanel=", typeof win.L5XStudio.DeviceNetPanel, "| App=", typeof win.L5XStudio.App, "| same obj?", win.L5XStudio === win.root.L5XStudio);
  } catch (e) {
    console.log("SCRIPT LOAD FAILED:", rel, e.message);
    process.exit(1);
  }
}
if (skipped.length) console.log("note: skipped not-yet-delivered modules: " + skipped.join(", "));
const NS = win.L5XStudio;
console.log("postload DnetPanel:", typeof NS.DnetPanel, "| keys:", Object.keys(NS).length, "| loaded:", loaded.length);
assert.ok(NS && NS.App, "L5XStudio.App exists");
assert.ok(NS.parseL5X && NS.parseSt && NS.ladToSt && NS.ladToFbd && NS.exportL5X, "core modules exist");
assert.ok(NS.renderDataflow && NS.LadderEditor && NS.FbdEditor && NS.StEditor, "editors exist");
assert.ok(NS.renderUdtTree && NS.resolveOperand && NS.resolveIoPoint && NS.IOPanel, "panels exist");
console.log("ok   all available scripts load, exports wired (" + loaded.length + " scripts)");

function waitFor(fn, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let v = null;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timeout"));
      setTimeout(poll, 25);
    })();
  });
}

(async function main() {
  /* ---------- drive the app (L5X) ---------- */
  const app = new NS.App(document.createElement("div"));

  /* ---------- redesigned shell: activity rail, dashboard, command palette ---------- */
  {
    const railBtns = app.rail.querySelectorAll(".rail-btn");
    assert.ok(railBtns.length >= 12, "activity rail items: " + railBtns.length);
    const btnText = b => (b.textContent || "") + " " + b.children.map(c => c.textContent || "").join(" ");
    const railText = railBtns.map(btnText).join("|");
    assert.ok(/Modules/.test(railText), "Modules workspace in rail");
    assert.ok(/Conveyor/.test(railText), "Conveyor workspace in rail");
    assert.ok(/Validate/.test(railText), "Validate in rail");
    // home dashboard cards
    app._welcome();
    const cards = app.view.querySelectorAll(".welcome-card");
    assert.ok(cards.length >= 8, "dashboard cards: " + cards.length);
    const cardText = cards.map(c => c.children.map(x => x.textContent || "").join(" ")).join("|");
    assert.ok(/Module I\/O/.test(cardText), "dashboard card for Module I/O");
    assert.ok(/Conveyor studio/.test(cardText), "dashboard card for Conveyor studio");
    // command palette: open, list, filter
    app._openPalette();
    assert.ok(app.paletteVisible, "palette opens");
    assert.ok(app._paletteItems.length >= 10, "palette commands: " + app._paletteItems.length);
    app._renderPalette("module io");
    assert.ok(app._paletteFiltered.length >= 1, "palette filter finds Module I/O");
    assert.ok(/Module I\/O/.test(app._paletteFiltered[0].label), "filtered command is Module I/O");
    app._closePalette();
    assert.ok(!app.paletteVisible, "palette closes");
    console.log("ok   shell: activity rail + dashboard + command palette (" + railBtns.length + " rail items)");
  }

  const sampleRllPath = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/samples/controller.L5X";
  if (!fs.existsSync(sampleRllPath)) {
    console.log("skip project-dependent smoke checks (SAMPLE_RLL sample not available; set L5X_STUDIO_SAMPLE_RLL)");
    console.log("ui-smoke: shell checks passed");
    return;
  }
  const sampleRll = fs.readFileSync(sampleRllPath, "utf8");
  app.loadText("SAMPLE_RLL.L5X", sampleRll);
  assert.ok(app.model, "model loaded");
  assert.ok(app.tabs.length >= 1, "project tab opened");
  console.log("ok   app loads SAMPLE_RLL.L5X and renders project diagram");

  // let the deferred schema validation run
  if (typeof NS.validateModel === "function") {
    await waitFor(() => app.validationResult, 3000);
    console.log("ok   schema validation ran on load: " +
      ((app.validationResult.errors || []).length) + " errors, " +
      ((app.validationResult.warnings || []).length) + " warnings");
  } else console.log("skip schema validation (module not delivered yet)");

  const prog = app.model.programs.find(p => p.routines.length);
  const rout = prog.routines.find(r => r.type === "RLL");
  app.selection = { type: "routine", program: prog.name, routine: rout.name };
  app._openTab("routine");
  const rtab = app.tabs.find(t => t.type === "routine");
  assert.ok(rtab.el.children.length >= 3, "routine view rendered");
  console.log("ok   routine view renders (" + prog.name + "/" + rout.name + ")");

  const editorBtn = rtab.el.querySelectorAll(".subtab-btn")[1];
  assert.ok(editorBtn, "editor subtab button");
  editorBtn.click();
  assert.ok(app.editor, "editor constructed");
  const edZoom = rtab.el.querySelectorAll(".editor-zoom")[0];
  assert.ok(edZoom && edZoom.querySelectorAll(".btn").length >= 4, "ladder editor zoom controls");
  assert.ok(rtab.el.style.display === "" || rtab.el.style.display === "flex", "tab page keeps flex display (no inline block)");
  rtab.el.querySelectorAll(".subtab-btn")[0].click();
  assert.ok(rtab.el.querySelectorAll(".diagram-hint").length >= 1, "diagram pan/zoom hint shown");
  rtab.el.querySelectorAll(".subtab-btn")[1].click();
  console.log("ok   ladder editor constructed for RLL routine (zoom controls, flex tab page, pan/zoom hint)");

  app._openTab("io");
  app._inspectOperand("PDP:I.Data", null);
  assert.ok(app.ioPanel, "io panel");
  console.log("ok   I/O panel resolves PDP:I.Data");

  app._openTab("convert");
  /* regression: the target buttons must actually call the panel (this.preview was called with
     the button as `this` before — clicking "to Structured Text" threw a TypeError) */
  const targetBtns = app.convertPanel.container.querySelectorAll(".conv-btn");
  assert.ok(targetBtns.length >= 3, "convert target buttons: " + targetBtns.length);
  const stBtn = targetBtns.find(b => /Structured Text/.test((b.textContent || "") + " " + b.children.map(x => x.textContent || "").join(" ")));
  assert.ok(stBtn, "to Structured Text button");
  stBtn.click();
  assert.ok(app.convertPanel.staged, "clicking the target button stages the conversion");
  assert.ok(app.convertPanel.previewBox && app.convertPanel.previewBox.children.length > 0,
    "convert panel shows a text preview");
  app.convertPanel.apply();
  const r2 = app.model.findRoutine(prog.name, rout.name);
  assert.equal(r2.pendingType, "ST", "routine converted to ST");
  console.log("ok   convert tab converts " + prog.name + "/" + rout.name + " to ST (target button click + preview)");

  /* click conversion targets in the other direction too (ST -> FBD -> LAD) */
  app._openTab("convert");
  const fbdBtn = app.convertPanel.container.querySelectorAll(".conv-btn").find(b => /Function Block/.test((b.textContent || "") + " " + b.children.map(x => x.textContent || "").join(" ")));
  assert.ok(fbdBtn, "to Function Block button");
  fbdBtn.click();
  assert.ok(app.convertPanel.staged, "ST -> FBD staged via button");
  app.convertPanel.apply();
  assert.equal(app.model.findRoutine(prog.name, rout.name).pendingType, "FBD", "routine converted to FBD via button");
  app._openTab("convert");
  const ladBtn = app.convertPanel.container.querySelectorAll(".conv-btn").find(b => /Ladder/.test((b.textContent || "") + " " + b.children.map(x => x.textContent || "").join(" ")));
  assert.ok(ladBtn, "to Ladder button");
  ladBtn.click();
  assert.ok(app.convertPanel.staged, "FBD -> LAD staged via button");
  app.convertPanel.apply();
  assert.equal(app.model.findRoutine(prog.name, rout.name).pendingType, "RLL", "routine converted back to Ladder via button");
  console.log("ok   convert target buttons work for ST/FBD/LAD (no this-binding errors)");

  /* leave the routine converted to ST for the display checks below */
  app._openTab("convert");
  const stBtn2 = app.convertPanel.container.querySelectorAll(".conv-btn").find(b => /Structured Text/.test((b.textContent || "") + " " + b.children.map(x => x.textContent || "").join(" ")));
  assert.ok(stBtn2, "to Structured Text button (again)");
  stBtn2.click();
  app.convertPanel.apply();
  assert.equal(app.model.findRoutine(prog.name, rout.name).pendingType, "ST", "routine ends converted to ST");

  /* converting the routine to Ladder shows a graphical ladder in the routine editor */
  app._openTab("convert");
  const toLadBtn = app.convertPanel.container.querySelectorAll(".conv-btn").find(b => /Ladder/.test((b.textContent || "") + " " + b.children.map(x => x.textContent || "").join(" ")));
  assert.ok(toLadBtn, "to Ladder button present");
  toLadBtn.click();
  app.convertPanel.apply();
  assert.equal(app.model.findRoutine(prog.name, rout.name).pendingType, "RLL", "routine staged as RLL");
  app._openTab("routine");
  const rtabLad = app.tabs.find(t => t.type === "routine");
  const routineLadSvg = rtabLad.el.querySelectorAll(".lad-editor-svg")[0];
  assert.ok(routineLadSvg, "routine editor renders the converted ladder as a ladder diagram");
  assert.ok(app.editor && /LadderEditor/.test(app.editor.constructor.name), "LadderEditor is the active editor");
  const routineLadText = (routineLadSvg.textContent || "") + " " + (routineLadSvg.children || []).map(function (c) { return (c.textContent || "") + " " + (c.children || []).map(function (x) { return x.textContent || ""; }).join(" "); }).join(" ");
  assert.ok(routineLadText.length > 10, "ladder diagram contains instruction text");
  console.log("ok   routine conversion to Ladder renders a graphical ladder (not text)");
  /* restore ST for the export/display assertions that follow */
  app._openTab("convert");
  const backSt = app.convertPanel.container.querySelectorAll(".conv-btn").find(b => /Structured Text/.test(b.textContent || ""));
  backSt.click();
  app.convertPanel.apply();
  assert.equal(app.model.findRoutine(prog.name, rout.name).pendingType, "ST", "routine restored to ST after the ladder check");

  app._openTab("routine");
  const rtabs = rtab.el.querySelectorAll(".subtab-btn");
  assert.equal(rtabs.length, 3, "diagram / editor / text subtabs");
  // the converted routine auto-opens in the editor (was blank before the layout fix)
  assert.ok(app.editor, "ST editor auto-opened after conversion");
  // editor host must hold real content (flex layout regression guard)
  const editorHosts = rtab.el.querySelectorAll(".editor-host");
  assert.ok(editorHosts.length > 0 && editorHosts[0].children.length > 0, "editor host has content");
  // Text tab always displays the converted routine
  rtabs[2].click();
  const textPre = rtab.el.querySelectorAll(".routine-text")[0];
  assert.ok(textPre && String(textPre.textContent).length > 0, "Text tab shows the converted routine");
  assert.ok(/:=/.test(String(textPre.textContent)) || /;/.test(String(textPre.textContent)) || String(textPre.textContent).length > 20,
    "converted ST text content present");
  console.log("ok   converted routine displays in the editor and text views");
  // diagram view still renders after conversion
  rtabs[0].click();
  assert.ok(rtab.el.querySelectorAll(".diagram-host").length > 0, "diagram host after conversion");
  console.log("ok   converted routine diagram view renders");

  const dirty = NS.dirtyRoutines(app.model);
  assert.ok(dirty.length >= 1, "dirty routines staged");
  const exported = NS.exportL5X(app.model, {});
  assert.ok(exported.text.includes("<STContent>"), "export contains ST content");
  console.log("ok   export produces modified L5X text");

  app.selection = { type: "routine", program: prog.name, routine: rout.name };
  app._openTab("convert");
  app.convertPanel.preview("fbd");
  assert.ok(app.convertPanel.staged, "fbd staged");
  app.convertPanel.apply();
  app._openTab("routine");
  rtab.el.querySelectorAll(".subtab-btn")[1].click();
  assert.ok(app.editor, "FBD editor constructed");
  console.log("ok   FBD editor constructed after conversion");

  app.selection = { type: "udt", name: app.model.dataTypes[0].name };
  app._openTab("udt");
  console.log("ok   UDT view renders " + app.model.dataTypes[0].name);

  /* ---------- new feature views (present when modules delivered) ---------- */
  if (typeof NS.IoListPanel === "function") {
    app._openTab("iolist");
    assert.ok(app._panels.iolist, "io list panel constructed");
    console.log("ok   I/O list panel renders");
  } else console.log("skip I/O list panel (module not delivered yet)");

  if (typeof NS.ValidationPanel === "function") {
    app._openTab("validation");
    assert.ok(app._panels.validation, "validation panel constructed");
    console.log("ok   validation panel renders");
  } else console.log("skip validation panel (module not delivered yet)");

  if (typeof NS.HealthPanel === "function") {
    app._openTab("health");
    assert.ok(app._panels.health, "health panel constructed");
    console.log("ok   health panel renders");
  } else console.log("skip health panel (module not delivered yet)");

  if (typeof NS.ModuleIoPanel === "function") {
    app._openTab("moduleio");
    assert.ok(app._panels.moduleio, "module I/O panel constructed");
    const mtab = app.tabs.find(t => t.type === "moduleio");
    const rows = mtab.el.querySelectorAll(".module-row");
    assert.ok(rows.length > 3, "module rows rendered: " + rows.length);
    const rowText = r => (r.textContent || "") + " " + r.children.map(c => c.textContent || "").join(" ");
    const gr = rows.find(r => /GROUP01/.test(rowText(r)));
    assert.ok(gr, "GROUP01 module row present");
    gr.click();
    const mhost = mtab.el.querySelectorAll(".mermaid-viewport")[0];
    assert.ok(mhost && mhost.querySelectorAll(".mermaid-canvas").length > 0, "module dataflow rendered in the pannable viewport");
    assert.ok(mhost.querySelectorAll(".mermaid-canvas")[0].innerHTML.indexOf("<svg") === 0, "Mermaid SVG inside the viewport");
    const subtabs = mtab.el.querySelectorAll(".subtab-btn");
    assert.equal(subtabs.length, 4, "module / inter-module / schematic / bit-map views");
    subtabs[1].click();
    assert.ok(mtab.el.querySelectorAll(".mermaid-viewport").length > 0, "inter-module flow viewport rendered");
    assert.ok(mtab.el.querySelectorAll(".comm-summary").length > 0, "communication summary rendered");
    subtabs[2].click();
    const shost = mtab.el.querySelectorAll(".schematic-host")[0];
    assert.ok(shost && /^<svg/.test(shost.innerHTML), "terminal schematic rendered");
    subtabs[3].click();
    assert.ok(mtab.el.querySelectorAll(".data-table").length >= 2, "bit-map tables rendered");
    const btns = mtab.el.querySelectorAll(".btn");
    const proj = btns.find(b => /Project overview/.test((b.textContent || "") + " " + b.children.map(c => c.textContent || "").join(" ")));
    assert.ok(proj, "project overview button");
    proj.click();
    const phost = mtab.el.querySelectorAll(".mermaid-viewport")[0];
    assert.ok(phost && phost.querySelectorAll(".mermaid-canvas")[0].innerHTML.indexOf("<svg") === 0, "project module network rendered as Mermaid SVG");
    console.log("ok   module I/O panel: module list, pannable Mermaid SVG, inter-module flow, schematic, bit map, project overview");

    /* rail navigation + palette deep-link into a specific module */
    const railBtns2 = app.rail.querySelectorAll(".rail-btn");
    const btnText2 = b => (b.textContent || "") + " " + b.children.map(c => c.textContent || "").join(" ");
    const modulesRail = railBtns2.find(b => /Modules/.test(btnText2(b)));
    assert.ok(modulesRail, "Modules rail button");
    app._openTab("project");
    modulesRail.click();
    assert.ok(app.tabs.some(t => t.id === "moduleio"), "rail opens Module I/O");
    assert.ok(app.railBtns.modules.className.indexOf("active") !== -1, "rail highlights active workspace");
    app._openPalette();
    app._renderPalette("GROUP01");
    const modCmd = app._paletteFiltered.find(c => /module\.GROUP01/.test(c.id));
    assert.ok(modCmd, "palette deep-link command for GROUP01");
    app._paletteRun(modCmd);
    assert.ok(app._panels.moduleio && app._panels.moduleio.selected === "GROUP01", "palette jumps to module GROUP01");
    console.log("ok   shell: rail navigation + palette deep-link to a module");

    /* DeviceNet .dnt merge: remote nodes + L5X scanner image words in the same view */
    const dntPath = "C:/samples/devicenet/zone-template.dnt";
    if (typeof NS.parseDnt === "function" && fs.existsSync(dntPath)) {
      const dnt = NS.parseDnt(fs.readFileSync(dntPath), { fileName: "ZONE_TEMPLATE.dnt" });
      assert.ok(dnt.devices.length >= 10, "parsed .dnt nodes: " + dnt.devices.length);
      // global open flow: the network is attached at the app level and merges everywhere
      app.openDnt("ZONE_TEMPLATE.dnt", fs.readFileSync(dntPath));
      app._openTab("moduleio");
      const panel = app._panels.moduleio;
      panel.refresh();
      const dnRows = mtab.el.querySelectorAll(".module-row");
      assert.ok(dnRows.some(r => /ZPA-1 4-ZONE/.test(rowText(r))), "DeviceNet node in the module list");
      assert.ok(dnRows.some(r => /CT-1,2/.test(rowText(r))), "zone card nodes in the module list");
      // inter-module view: comms summary + DeviceNet table with L5X image words
      mtab.el.querySelectorAll(".subtab-btn")[1].click();
      const tables = mtab.el.querySelectorAll(".data-table");
      assert.ok(tables.length >= 2, "DeviceNet + communication tables");
      const tableText = tables.map(t => t.children.map(c => c.children.map(x => x.textContent || "").join(" ")).join(" ")).join(" ");
      assert.ok(/Local:1:I\.Data\[100\]/.test(tableText), "L5X scanner image words shown for the DeviceNet nodes");
      assert.ok(/1799-ZCIOV/.test(tableText), "DeviceNet catalogs shown");
      // node detail facts + word table
      const zpaRow = mtab.el.querySelectorAll(".module-row").find(r => /ZPA-1 4-ZONE/.test(rowText(r)));
      zpaRow.click();
      const facts = mtab.el.querySelectorAll(".module-fact").map(f => f.children.map(c => c.textContent || "").join(" ")).join(" | ");
      assert.ok(/DeviceNet MAC/.test(facts), "MAC fact present");
      mtab.el.querySelectorAll(".subtab-btn")[3].click();
      const factTables = mtab.el.querySelectorAll(".data-table");
      const detailText = factTables.map(t => t.children.map(c => c.children.map(x => x.textContent || "").join(" ")).join(" ")).join(" ");
      assert.ok(/Local:1:I\.Data\[100\]/.test(detailText), "L5X words in the node detail");
      console.log("ok   DeviceNet .dnt merge: remote nodes + L5X scanner image words + node detail");

      /* standalone DeviceNet workspace + global open flow */
      app._openTab("dnet");
      if (!app._panels || !app._panels.dnet) console.log("DEBUG panels:", app._panels ? Object.keys(app._panels).join(",") : "null", "| activeTab:", app.activeTab, "| DnetPanel:", typeof NS.DnetPanel, "| tabs:", app.tabs.map(t => t.type + "=" + t.id).join(" "));
      assert.ok(app._panels && app._panels.dnet, "DeviceNet panel constructed");
      const dtab = app.tabs.find(t => t.type === "dnet");
      const dnRows2 = dtab.el.querySelectorAll(".dnet-row");
      assert.ok(dnRows2.length >= 10, "DeviceNet node rows: " + dnRows2.length);
      const dnText = dtab.el.querySelectorAll(".data-table").map(t => t.children.map(r => r.children.map(x => x.textContent || "").join(" ")).join(" ")).join(" ");
      assert.ok(/1799-ZCIOV/.test(dnText), "zone card catalog in the DeviceNet table");
      const factVals = dtab.el.querySelectorAll(".module-fact-value").map(f => f.textContent || "").join(" ");
      assert.ok(/75 ms/.test(factVals), "scanner EPR shown");
      const zciovRow = Array.from(dnRows2).find(r => /1799-ZCIOV|ZPA-1 4-ZONE/.test(r.children.map(x => x.textContent || "").join(" ")));
      assert.ok(zciovRow, "1799-ZCIOV row");
      zciovRow.click();
      const ddetail = dtab.el.querySelectorAll(".dnet-node-view")[0];
      assert.ok(ddetail && /local logic/.test((ddetail.textContent || "") + " " + ddetail.children.map(x => x.textContent || "").join(" ")), "local-logic marker for the zone card");
      const dmmd = dtab.el.querySelectorAll(".mermaid-viewport")[0];
      assert.ok(dmmd && dmmd.querySelectorAll(".mermaid-canvas")[0].innerHTML.indexOf("<svg") === 0, "DeviceNet network Mermaid rendered in a pannable viewport");
      const dzoom = dtab.el.querySelectorAll(".zoom-tools");
      assert.ok(dzoom.length >= 1 && dzoom[0].querySelectorAll(".btn").length >= 4, "DeviceNet diagram zoom controls");
      /* node table header and rows structurally aligned (real <tr>/<td>, no button rows) */
      const dtable = dtab.el.querySelectorAll(".dnet-table")[0];
      assert.ok(dtable, "DeviceNet nodes table");
      const headCells = dtable.children[0].children.filter(c => c.tagName === "TH");
      const bodyRows = dtable.children.filter(r => r.tagName === "TR" && r.className.indexOf("dnet-row") !== -1);
      assert.ok(bodyRows.length >= 10, "DeviceNet table rows: " + bodyRows.length);
      assert.equal(bodyRows[0].children.length, headCells.length, "row cells match header cells (" + bodyRows[0].children.length + ")");
      console.log("ok   DeviceNet workspace: standalone network view + local-logic zone cards");

      /* DeviceNet node configuration view: sidebar tree + node tab */
      const dnetTree = app.tree ? app.tree.querySelectorAll(".tree-dnet")[0] : null;
      assert.ok(dnetTree, "DeviceNet section in the sidebar tree");
      const dnetLeaves = dnetTree.querySelectorAll(".dnet-leaf");
      assert.ok(dnetLeaves.length >= 10, "DeviceNet node leaves: " + dnetLeaves.length);
      const zpaLeaf = dnetLeaves.find(l => /ZPA-1/.test(l.textContent || ""));
      assert.ok(zpaLeaf, "zone card node leaf in the tree");
      zpaLeaf.click();
      const nodeTab = app.tabs.find(t => t.type === "dnetnode");
      assert.ok(nodeTab, "DeviceNet node tab opened");
      assert.ok(/DN 02|ZPA-1/.test(nodeTab.label || nodeTab.btn.textContent || ""), "node tab label identifies the device");
      assert.ok(nodeTab.el.querySelectorAll(".dnet-node-view").length === 1, "node configuration view rendered");
      const nodeTabs = nodeTab.el.querySelectorAll(".dnet-node-tabs")[0];
      assert.ok(nodeTabs && nodeTabs.children.length >= 5, "node view tabs (logic/parameters/zone/points/raw)");
      const paramRows = nodeTab.el.querySelectorAll(".dnet-param-table")[0];
      assert.ok(paramRows && paramRows.children.length > 2, "EDS parameter table rows");
      nodeTabs.children[2].click();   // zone mapping
      const zoneGrid = nodeTab.el.querySelectorAll(".dnet-zone-grid")[0];
      assert.ok(zoneGrid && zoneGrid.children.length >= 5, "zone mapping grid (byte rows)");
      const zoneText = zoneGrid.children.map(r => r.children.map(c => c.textContent || "").join(" ")).join(" ");
      assert.ok(/Byte 0/.test(zoneText), "zone data byte labels");
      const zoneMap = nodeTab.el.querySelectorAll(".dnet-zone-map")[0];
      assert.ok(zoneMap && zoneMap.children.length > 60, "zone-data bit cross reference rows: " + (zoneMap ? zoneMap.children.length : 0));
      const zoneMapText = zoneMap.children.map(function (r) { return r.children.map(function (c) { return c.textContent || ""; }).join(" "); }).join(" | ");
      assert.ok(/Zone Data \(Byte 0,Bit 0\)/.test(zoneMapText), "zone bits listed in the cross reference");
      assert.ok(/Zone Cnxn|MAC/.test(zoneMapText), "zone connection per byte mapped");
      assert.ok(/Local:1:I\.Data\[/.test(zoneMapText) || /outside I\/O assembly/.test(zoneMapText), "scanner image bit or assembly note per zone bit");
      nodeTabs.children[3].click();   // point labels
      const pointChips = nodeTab.el.querySelectorAll(".dnet-point-chip");
      assert.ok(pointChips.length >= 10, "point label chips: " + pointChips.length);
      nodeTabs.children[4].click();   // raw config
      const raw = nodeTab.el.querySelectorAll(".dnet-raw-strings")[0];
      assert.ok(raw && (raw.textContent || "").length > 100, "raw configuration strings listed");
      const nodeDl = nodeTab.el.querySelectorAll(".module-subbar")[0];
      assert.ok(nodeDl && nodeDl.querySelectorAll(".btn").length >= 1, "node JSON download button");
      console.log("ok   DeviceNet node code view: sidebar node -> parameters, zone mapping, point labels, raw config");

      /* every DeviceNet node is reachable through the command palette too */
      const dnetCmds = app._paletteCommands().filter(c => /^dnetnode\./.test(c.id));
      assert.ok(dnetCmds.length >= 10, "palette DeviceNet node commands: " + dnetCmds.length);


      /* RSNetWorx HTML export: decoded function-block logic merged into the .dnt network */
      const dnetHtmlPath = path.join(ROOT, "demo", "devicenet-html", "ZONE_TEMPLATE.html");
      if (fs.existsSync(dnetHtmlPath)) {
        const beforeNets = app.dnts.length;
        const htmlParsed = app.openDnetHtml("ZONE_TEMPLATE.html", fs.readFileSync(dnetHtmlPath, "utf8"));
        assert.ok(htmlParsed && htmlParsed.summary.devicesWithLogic >= 9,
          "HTML logic export parsed: " + (htmlParsed ? htmlParsed.summary.devicesWithLogic : 0) + " devices with logic");
        assert.ok(htmlParsed.summary.blocks >= 700, "function blocks parsed: " + htmlParsed.summary.blocks);
        assert.equal(app.dnts.length, beforeNets, "HTML merged into the existing .dnt network");
        const matched = app.dnts.find(n => n.fileName === "ZONE_TEMPLATE.dnt");
        assert.ok(matched && matched.logicExport && matched.logicFileName, "logic export attached to the network");
        const zpaNode = matched.devices.find(d => d.macId === 2);
        assert.ok(zpaNode && zpaNode.hasLogic && zpaNode.logic.count >= 60, "zone card logic parsed: " + (zpaNode && zpaNode.logic ? zpaNode.logic.count : 0));
        app.openDnetNode("ZONE_TEMPLATE.dnt", 2);
        const ntab = app.tabs.filter(t => t.type === "dnetnode").pop();
        const ltabs = ntab.el.querySelectorAll(".dnet-node-tabs")[0];
        assert.ok(ltabs && ltabs.children.length >= 5, "logic tab added to the node view");
        ltabs.children[0].click();
        const canvas = ntab.el.querySelectorAll(".dnet-logic-canvas")[0];
        assert.ok(canvas && canvas.innerHTML.indexOf("<svg") === 0 && canvas.innerHTML.indexOf("fbd-block") !== -1,
          "FBD logic rendered from the HTML export");
        const ltable = ntab.el.querySelectorAll(".dnet-logic-table")[0];
        assert.ok(ltable && ltable.children.length > 30, "function-block table rows: " + (ltable ? ltable.children.length : 0));
        assert.ok(/SR LATCH|ON DELAY TIMER/.test(canvas.innerHTML), "block types rendered");
        assert.ok(ntab.el.querySelectorAll(".zoom-tools")[0], "logic view has pan/zoom controls");
        // annotated FBD uses the configured local-logic labels
        assert.ok(/Latch_1|Timer_1/.test(canvas.innerHTML), "configured block tags on the FBD");
        assert.ok(/Jam Latch|Move-In Timer/.test(canvas.innerHTML), "configured descriptions on the FBD");
        const langBar = ntab.el.querySelectorAll(".dnet-logic-bar")[0];
        assert.ok(langBar && langBar.children.length >= 6, "logic language switcher buttons");
        const langBtns = langBar.querySelectorAll(".btn");
        const byText = function (re) { return langBtns.find(function (b) { return re.test(b.textContent || ""); }); };
        const ladBtn = byText(/^Ladder$/); assert.ok(ladBtn, "Ladder language button");
        ladBtn.click();
        assert.ok(ntab.el.querySelectorAll(".dnet-ladder-host")[0], "graphical ladder host in the Logic tab");
        const ladSvg = ntab.el.querySelectorAll(".lad-editor-svg")[0];
        assert.ok(ladSvg, "ladder rendered as a real ladder SVG, not text");
        const deepText = function (el) {
          return (el.textContent || "") + " " + (el.children || []).map(deepText).join(" ");
        };
        const ladText = deepText(ladSvg);
        assert.ok(/OTL|OTE/.test(ladText), "ladder instructions drawn in the SVG");
        assert.ok(/Latch_1|Jam Latch/.test(ladText), "ladder SVG carries the configured labels");
        const ladPre = ntab.el.querySelectorAll(".dnet-logic-code")[0];
        assert.ok(ladPre && /OTL\(|OTE\(/.test(ladPre.textContent || ""), "ladder text also available (downloadable)");
        byText(/^Structured Text$/).click();
        code = ntab.el.querySelectorAll(".dnet-logic-code")[0];
        assert.ok(code && /:=/.test(code.textContent || "") && /SR_LATCH|TON\(|TOF\(/.test(code.textContent || ""), "ST rendition rendered");
        byText(/^Labels$/).click();
        const xref = ntab.el.querySelectorAll(".dnet-xref-table");
        assert.ok(xref.length >= 1 && xref[0].children.length > 5, "cross-reference tables rendered");
        const xrefText = xref.map(function (t) { return t.children.map(function (r) { return r.children.map(function (c) { return c.textContent || ""; }).join(" "); }).join(" "); }).join(" | ");
        assert.ok(/DIP\.|CNB\.|DOP\.|PNB\./.test(xrefText), "I/O aliases with addresses in the cross reference");
        assert.ok(/Jam Latch|Move-In Timer/.test(xrefText), "configured block descriptions in the cross reference");
        // back to FBD so later assertions see the graph
        byText(/^FBD$/).click();
        assert.ok(ntab.el.querySelectorAll(".dnet-logic-canvas")[0], "FBD view restored");
        const fbdLeaf = app.tree.querySelectorAll(".dnet-leaf").find(l => /FBD/.test(l.textContent || ""));
        assert.ok(fbdLeaf, "sidebar node leaves mark decoded FBD logic");
        app._openTab("dnet");
        const dnetTabEl = app.tabs.find(t => t.type === "dnet");
        const factsEl = dnetTabEl.el.querySelectorAll(".module-facts")[0];
        const factsText = factsEl.children.map(f => (f.textContent || "") + " " + (f.children || []).map(x => x.textContent || "").join(" ")).join(" ");
        assert.ok(/Logic export/.test(factsText), "DeviceNet facts show the attached logic export");
        console.log("ok   RSNetWorx HTML logic export: merged, FBD logic tab, block table, tree badge");
      }

      /* Home dashboard / close-all must not strand the user */
      for (const t of app.tabs.slice()) app._closeTab(t.id);
      assert.equal(app.tabs.length, 0, "all tabs closed");
      const cardsAfter = app.view.querySelectorAll(".welcome-card");
      assert.ok(cardsAfter.length >= 8, "dashboard cards after closing all tabs");
      const ioCard = Array.from(cardsAfter).find(c => /I\/O list/.test(c.children.map(x => x.textContent || "").join(" ")));
      assert.ok(ioCard, "feature card present");
      ioCard.click();
      const reopened = app.tabs.filter(t => t.type === "iolist");
      assert.ok(reopened.length >= 1, "feature reopens from the dashboard");
      assert.ok(app.view.contains(reopened[0].el), "tab page back in the view");
      app._railClick({ tab: "project", needsModel: true });
      assert.ok(app.tabs.some(t => t.type === "project"), "rail reopens a view after Home");
      console.log("ok   home/close-tabs: features reopen from dashboard and rail");
    } else console.log("skip DeviceNet merge (no .dnt sample or parser)");
  } else console.log("skip module I/O panel (module not delivered yet)");

  /* tabs identify their contents and can be closed */
  {
    const routines = [];
    for (const p of app.model.programs) for (const r of p.routines) routines.push({ program: p.name, routine: r.name });
    const openKeys = new Set(app.tabs.map(t => t.id));
    const candidates = routines.filter(r => !openKeys.has("routine:" + r.program + "/" + r.routine)).slice(0, 2);
    assert.ok(candidates.length >= 1, "fresh routine candidates");
    for (const cand of candidates) {
      app.selection = { type: "routine", program: cand.program, routine: cand.routine };
      app._openTab("routine");
    }
    const routineTabs = app.tabs.filter(t => t.type === "routine");
    assert.ok(routineTabs.length >= 2, "one tab per routine: " + routineTabs.length);
    const labels = routineTabs.map(t => t.label);
    assert.equal(new Set(labels).size, labels.length, "routine tab labels are distinct");
    assert.ok(routineTabs.some(t => t.label === candidates[0].routine), "tab labelled with its routine name");
    assert.ok(routineTabs.some(t => t.title && t.title.indexOf(" / ") !== -1), "tab title carries program / routine context");
    const closeTarget = routineTabs[routineTabs.length - 1];
    const before = app.tabs.length;
    app._closeTab(closeTarget.id);
    assert.equal(app.tabs.length, before - 1, "tab closed");
    assert.ok(!app.tabs.some(t => t.id === closeTarget.id), "closed tab removed");
    console.log("ok   tabs: per-routine labels/titles + closeable tabs");
  }

  if (typeof NS.generateC === "function") {
    const res = NS.generateC(app.model, { programFilter: prog.name, routineFilter: rout.name });
    assert.ok(res.files && Object.keys(res.files).length >= 1, "C files generated");
    console.log("ok   C export generates " + Object.keys(res.files).join(", "));
  } else console.log("skip C export (module not delivered yet)");

  /* ---------- SAMPLE_ST: native ST routine (site sample) ---------- */
  const sampleStPath = process.env.L5X_STUDIO_SAMPLE_ST || "C:/samples/structured-text.L5X";
  if (fs.existsSync(sampleStPath)) {
  
    const sampleSt = fs.readFileSync(sampleStPath, "utf8");
    app.loadText("SAMPLE_ST.L5X", sampleSt);
    const stProg = app.model.programs.find(p => p.routines.some(r => r.type === "ST"));
    const stRout = stProg.routines.find(r => r.type === "ST");
    app.selection = { type: "routine", program: stProg.name, routine: stRout.name };
    app._openTab("routine");
    app.tabs.find(t => t.type === "routine").el.querySelectorAll(".subtab-btn")[1].click();
    assert.ok(app.editor, "ST editor for native ST routine");
    console.log("ok   native ST routine opens in ST editor (" + stRout.name + ")");
  
    app._openTab("io");
    app._inspectOperand("Network1:I.Data[2].1", { program: stProg.name });
    console.log("ok   SAMPLE_ST Network1:I.Data[2].1 resolved in I/O panel");
  

  } else console.log("skip SAMPLE_ST native-ST checks (SAMPLE_ST sample not available)");

  /* ---------- ACD metadata ---------- */
  if (typeof NS.readAcd === "function") {
    const acdPath = path.join(ROOT, "..", "repo-analysis", "acd", "resources", "ACDTestsWithAOI.ACD");
    if (fs.existsSync(acdPath)) {
      const buf = fs.readFileSync(acdPath);
      app.loadAcd("ACDTestsWithAOI.ACD", buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      await waitFor(() => app.acd, 10000);
      assert.ok(app.acd.dataTypes.length > 100, "ACD data types");
      assert.ok(app.tabs.find(t => t.type === "acd"), "ACD tab opened");
      assert.ok(app._panels.acd, "ACD panel constructed");
      console.log("ok   ACD metadata view renders (" + app.acd.dataTypes.length + " data types, " + app.acd.tags.length + " tags)");
    } else console.log("skip ACD load (corpus file missing)");
  } else console.log("skip ACD (module not loaded)");

  if (typeof NS.AoiPanel === "function") {
    // AOI panel requires an L5X with AOIs; load the LogixLibraries AOI corpus
    const aoiPath = path.join(ROOT, "..", "repo-analysis", "LogixLibraries", "src", "Device", "Rockwell", "PowerFlex 525", "Dvc_PF525_AOI.L5X");
    if (fs.existsSync(aoiPath)) {
      app.loadText("Dvc_PF525_AOI.L5X", fs.readFileSync(aoiPath, "utf8"));
      const n = app.model.addOnInstructions.length;
      if (n > 0) {
        app._openTab("aoi");
        assert.ok(app._panels.aoi, "AOI panel constructed");
        console.log("ok   AOI panel renders (" + n + " AOI definitions)");
      }
    } else console.log("skip AOI panel (corpus missing)");
  } else console.log("skip AOI panel (module not delivered yet)");

  /* ---------- Conveyor Design Studio ---------- */
  if (typeof NS.ConveyorPanel === "function") {
    app._openTab("conveyor");
    const panel = app._panels.conveyor;
    assert.ok(panel, "conveyor panel constructed");
    assert.ok(panel.design, "design loaded");
    assert.ok(panel.computed && panel.computed.totals.zones > 0, "design computed");
    console.log("ok   conveyor studio renders design (" + panel.computed.totals.segments +
      " segments, " + panel.computed.totals.zones + " zones)");
    const subviews = ["view3d", "components", "bom", "logic", "hmi"];
    for (const v of subviews) {
      try {
        panel.subview = v;
        panel._renderSubview();
        console.log("ok   conveyor subview renders: " + v);
      } catch (e) {
        console.log("FAIL conveyor subview " + v + ": " + e.message);
        process.exit(1);
      }
    }
    if (typeof NS.selectComponents === "function") {
      const sel = NS.selectComponents(panel.design, panel.computed, {});
      assert.ok(sel.zones.length > 0, "component selection");
      console.log("ok   conveyor components selected for " + sel.zones.length + " zones");
    }
    if (typeof NS.generateConveyorL5x === "function") {
      const g = NS.generateConveyorL5x(panel.design, panel.computed, { mode: "program" });
      assert.ok(g.l5x && g.l5x.length > 500, "generated L5X");
      console.log("ok   conveyor L5X generated (" + Math.round(g.l5x.length / 1024) + " KB, " +
        (g.warnings || []).length + " warnings)");
    }
    if (typeof NS.generateHmiHtml === "function") {
      const html = NS.generateHmiHtml(panel.design, panel.computed, {});
      assert.ok(html.indexOf("<canvas") !== -1, "HMI canvas");
      console.log("ok   conveyor HMI HTML generated (" + Math.round(html.length / 1024) + " KB)");
    }
  } else console.log("skip conveyor studio (module not delivered yet)");

  console.log("\nui-smoke: all checks passed");
})().catch(e => { console.log("UI SMOKE FAILED: " + (e && e.stack || e)); process.exit(1); });
