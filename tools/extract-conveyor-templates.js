#!/usr/bin/env node
/* L5X Studio - tools/extract-conveyor-templates.js
   Dev-time extractor for the Conveyor Design Studio template library.

   Parses the real SAMPLE_RLL.L5X ZPA project (program HARD_CODE_ZPA plus support
   programs) and the LogixLibraries AOI exports, then writes a deterministic
   classic-script / CommonJS data file:
       js/data/conveyor-templates.js

   Extracted contracts (see docs/CONVEYOR.md T-F):
     udts            required UDT XML strings (ZPA, ZPA_CONFIG, CONFIG_ZPA,
                     ZPA_MERGE, NETWORKS, GFX) + transitive UDT dependencies
     routines        { name: {type, description, sourceProgram, rungs[]} } for the
                     7 zone-count scan templates + support routines + ENET mapping
                     patterns
     moduleTemplate  1799ER-IQ10XOQ10/A module XML (PDP clone basis)
     localModule     1756-L83E Local module XML (controller export basis)
     tagTemplates    controller tag XML declarations (no initial <Data>) used by the
                     templates; the generator adjusts Dimensions / adds initial data
     programTags     program-scope tag declarations referenced by the templates,
                     resolved from the source programs (no initial <Data>)
     aoiLibrary      per LogixLibraries AOI export: target AOI XML, dependent AOIs,
                     dependent DataTypes, parameters, source files, notes
     sourceInfo      source file paths, extraction date, SAMPLE_RLL software revision

   Usage:
     node tools/extract-conveyor-templates.js [<SAMPLE_RLL.L5X>] [<outFile>] [<AOI dir>]
   Defaults:
     SAMPLE_RLL   C:/samples/sample-file
     out      js/data/conveyor-templates.js
     AOI dir  ../../repo-analysis/LogixLibraries/src/Device (next to this workspace)

   Output is deterministic (sorted keys / arrays) except for the date-only
   `extractionDate` stamp (override with env CONVEYOR_EXTRACTION_DATE).
*/
"use strict";

const fs = require("fs");
const path = require("path");
const XML = require("../js/xml.js");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..");
const EXTRACTOR_VERSION = "1.0.0";

const DEFAULTS = {
  sampleRll: process.env.L5X_STUDIO_SAMPLE_RLL || "SAMPLE_RLL.L5X",
  out: path.join(ROOT, "js", "data", "conveyor-templates.js"),
  aoiDir: path.join(WORKSPACE, "repo-analysis", "LogixLibraries", "src", "Device")
};

/* ---- contract inventory ---------------------------------------------------- */

const REQUIRED_UDTS = ["ZPA", "ZPA_CONFIG", "CONFIG_ZPA", "ZPA_MERGE", "NETWORKS", "GFX"];

/* Controller tags always emitted by the generator (contract T-F tagTemplates). */
const REQUIRED_TAGS = ["CONFIG_ZPA", "ENET_INPUTS", "ENET_OUTPUTS", "ENET_DEVICE_STATUS",
  "ZPA_MERGE", "GFX", "NETS"];

/* Routines to extract. [source program, routine name]. */
const TARGET_ROUTINES = [
  ["HARD_CODE_ZPA", "ZPA1_2ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_3ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_4ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_5ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_6ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_7ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA1_8ZONE_SCAN_ZONE"],
  ["HARD_CODE_ZPA", "ZPA_MAIN"],
  ["HARD_CODE_ZPA", "ZPA_MAPPING"],
  ["HARD_CODE_ZPA", "ZPA_MAPPING_GET_OFFSET"],
  ["ZPA_FAST", "ZPA_SCAN_ZONE_VARS"],
  ["ZPA_FAST", "ZPA_SCAN_ZONE_VARS_ONE_BACK"],
  ["SERVICE_GFX_SLOW", "ACK_JAMS_ZPA"],
  ["LAST_TASK", "CUSTOM_CODE_ZPA_BITS"],
  ["MAIN_TASK", "INIT_ZPA_STATUS"],
  ["IO_MASTER_MAPPER", "ENET_ZPA_INPUTS"],
  ["IO_MASTER_MAPPER", "ENET_ZPA_OUTPUTS"],
  ["ZPA_GFX", "ZPA_TIMER_CONFIG"]
];

/* AOI exports to harvest (name -> path relative to WORKSPACE). */
const AOI_FILES = [
  { name: "Dvc_DiscreteIn", file: "repo-analysis/LogixLibraries/src/Device/Generic/Dvc_DiscreteIn_AOI.L5X" },
  { name: "Dvc_DiscreteOut", file: "repo-analysis/LogixLibraries/src/Device/Generic/Dvc_DiscreteOut_AOI.L5X" },
  { name: "Dvc_Stacklight", file: "repo-analysis/LogixLibraries/src/Device/Generic/Dvc_Stacklight_AOI.L5X" },
  { name: "Dvc_PF525", file: "repo-analysis/LogixLibraries/src/Device/Rockwell/PowerFlex 525/Dvc_PF525_AOI.L5X" }
];

const PRIORITY_UDTS = ["ZPA", "ZPA_CONFIG", "CONFIG_ZPA", "ZPA_MERGE", "NETWORKS", "GFX"];

/* Instruction argument indexes that are NOT tag references. */
const NON_TAG_ARGS = {
  JSR: [0], SBR: [0], RET: [0], JMP: [0], LBL: [0], FOR: [0],
  GSV: [0, 1, 2], SSV: [0, 1, 2]
};

/* ---- small helpers --------------------------------------------------------- */

function sortedObject(keys, makeValue) {
  const out = {};
  keys.slice().sort().forEach(function (k) { out[k] = makeValue(k); });
  return out;
}
function normText(s) {
  return String(s === undefined || s === null ? "" : s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function localPath(abs) {
  const rel = path.relative(WORKSPACE, abs);
  return (rel && rel.indexOf("..") !== 0) ? rel.replace(/\\/g, "/") : abs;
}
function attr(node, name) { return XML.attr(node, name); }
function child(node, name) { return XML.child(node, name); }
function children(node, name) { return XML.children(node, name); }
function textOf(node) { return XML.textOf(node); }

/* Compact (whitespace-minimised) plain-node serializer: keeps attribute order,
   element order and CDATA nodes verbatim, drops only inter-element formatting. */
function serializeCompact(node) {
  if (!node) return "";
  if (node.type === "text") return String(node.text || "");
  if (node.type === "cdata") return "<![CDATA[" + String(node.text || "") + "]]>";
  if (node.type !== "element") return "";
  let s = "<" + node.name;
  const attrs = node.attrs || {};
  for (const k of Object.keys(attrs)) {
    s += " " + k + "=\"" + String(attrs[k]).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;") + "\"";
  }
  const kids = node.children || [];
  if (!kids.length) return s + "/>";
  s += ">";
  for (const k of kids) s += serializeCompact(k);
  return s + "</" + node.name + ">";
}

/* Serialise a tag/UDT/module element without its <Data>/<DefaultData> children. */
function declarationXml(node) {
  const clone = JSON.parse(JSON.stringify(node));
  clone.children = (clone.children || []).filter(function (c) {
    return !(c.type === "element" && (c.name === "Data" || c.name === "DefaultData"));
  });
  const xml = serializeCompact(clone);
  return xml;
}

/* ---- instruction / operand tag scanner ------------------------------------- */

function instructionCalls(rungText) {
  const out = [];
  const txt = String(rungText || "");
  const re = /([A-Za-z_][A-Za-z0-9_]*)\(/g;
  let m;
  while ((m = re.exec(txt))) {
    const op = m[1];
    let depth = 1;
    let j = re.lastIndex;
    let argsTxt = "";
    while (j < txt.length && depth > 0) {
      const c = txt[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      argsTxt += c;
      j++;
    }
    const args = [];
    let cur = "", d = 0, inStr = false;
    for (let i = 0; i < argsTxt.length; i++) {
      const c = argsTxt[i];
      if (c === "\"") inStr = !inStr;
      if (!inStr && c === "(") d++;
      if (!inStr && c === ")") d--;
      if (!inStr && d === 0 && c === ",") { args.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    args.push(cur.trim());
    out.push({ op: op, args: args });
  }
  return out;
}

function scanOperandTagNames(arg, tagNames) {
  let s = String(arg === undefined || arg === null ? "" : arg).trim();
  if (!s || s === "?") return;
  if (/^".*"$/.test(s)) return;                     // string literal
  if (/^[+-]?(?:\d|\.\d)/.test(s)) return;          // numeric / radix literal
  if (/^(TRUE|FALSE)$/i.test(s)) return;
  const m = /^([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*)/.exec(s);
  if (m) {
    const base = m[1];
    if (base.indexOf(":") === -1) tagNames.add(base);   // module tags handled separately
  }
  const re = /\[([^\]]*)\]/g;
  let mm;
  while ((mm = re.exec(s))) {
    const inner = mm[1];
    const ire = /[A-Za-z_][A-Za-z0-9_]*/g;
    let im;
    while ((im = ire.exec(inner))) {
      const before = inner.slice(0, im.index);
      const quotes = (before.match(/"/g) || []).length;
      if (quotes % 2 === 1) continue;
      const id = im[0];
      if (/^(TRUE|FALSE|AND|OR|XOR|NOT|MOD)$/i.test(id)) continue;
      tagNames.add(id);
    }
  }
}

/* All tag names referenced by one RLL routine (base tags + array-index tags). */
function routineTagRefs(routineNode) {
  const content = child(routineNode, "RLLContent");
  const rungs = content ? children(content, "Rung") : [];
  const tagNames = [];
  const seen = new Set();
  for (const rung of rungs) {
    const txt = textOf(child(rung, "Text")) || "";
    for (const call of instructionCalls(txt)) {
      const skip = NON_TAG_ARGS[call.op] || [];
      for (let i = 0; i < call.args.length; i++) {
        if (skip.indexOf(i) !== -1) continue;
        const set = new Set();
        scanOperandTagNames(call.args[i], set);
        set.forEach(function (n) { if (!seen.has(n)) { seen.add(n); tagNames.push(n); } });
      }
    }
  }
  return tagNames.sort();
}

/* ---- SAMPLE_RLL extraction ----------------------------------------------------- */

function extractSiteProject(sampleRllPath) {
  const text = fs.readFileSync(sampleRllPath, "utf8");
  const doc = XML.parseXml(text);
  const rootNode = XML.children(doc)[0];
  if (!rootNode || rootNode.name !== "RSLogix5000Content") {
    throw new Error("Not an L5X export: " + sampleRllPath);
  }
  const ctrl = child(rootNode, "Controller");
  if (!ctrl) throw new Error("L5X export has no <Controller> element: " + sampleRllPath);

  const controller = {
    name: attr(ctrl, "Name") || "",
    processorType: attr(ctrl, "ProcessorType") || "",
    majorRev: attr(ctrl, "MajorRev") || "",
    minorRev: attr(ctrl, "MinorRev") || "",
    softwareRevision: attr(rootNode, "SoftwareRevision") || "",
    exportDate: attr(rootNode, "ExportDate") || ""
  };

  /* --- data types --- */
  const dtNodes = {};
  for (const dt of children(child(ctrl, "DataTypes"), "DataType")) {
    dtNodes[attr(dt, "Name")] = dt;
  }
  const missingUdts = REQUIRED_UDTS.filter(function (n) { return !dtNodes[n]; });
  if (missingUdts.length) throw new Error("SAMPLE_RLL is missing required UDT(s): " + missingUdts.join(", "));

  /* --- programs / program tags / routines --- */
  const programs = {};
  const progTags = {};        // name -> [{program, node}]
  for (const p of children(child(ctrl, "Programs"), "Program")) {
    const pname = attr(p, "Name");
    programs[pname] = p;
    const tagsNode = child(p, "Tags");
    if (!tagsNode) continue;
    for (const t of children(tagsNode, "Tag")) {
      const n = attr(t, "Name");
      (progTags[n] = progTags[n] || []).push({ program: pname, node: t });
    }
  }

  const routines = {};
  const routineOrder = [];
  const unresolved = [];
  const routineRefs = {};
  for (const spec of TARGET_ROUTINES) {
    const pname = spec[0], rname = spec[1];
    const prog = programs[pname];
    if (!prog) throw new Error("SAMPLE_RLL program not found: " + pname);
    const routsNode = child(prog, "Routines");
    const rnode = routsNode ? children(routsNode, "Routine").find(function (r) {
      return attr(r, "Name") === rname;
    }) : null;
    if (!rnode) throw new Error("SAMPLE_RLL routine not found: " + pname + "/" + rname);
    const rtype = attr(rnode, "Type") || "RLL";
    if (rtype !== "RLL") throw new Error("Expected RLL template routine " + pname + "/" + rname + " (got " + rtype + ")");
    const content = child(rnode, "RLLContent");
    const rungNodes = content ? children(content, "Rung") : [];
    const rungs = rungNodes.map(function (rung) {
      return {
        number: parseInt(attr(rung, "Number") || "0", 10) || 0,
        type: attr(rung, "Type") || "N",
        comment: (function () {
          const c = child(rung, "Comment");
          const v = c ? normText(textOf(c)) : null;
          return v === null ? null : v.replace(/[ \t]+\n/g, "\n");
        })(),
        text: normText(textOf(child(rung, "Text")) || "")
      };
    });
    const descNode = child(rnode, "Description");
    routines[rname] = {
      type: "RLL",
      description: descNode ? normText(textOf(descNode)) : null,
      sourceProgram: pname,
      mainRoutine: rname === "ZPA_MAIN" ? true : false,
      rungs: rungs
    };
    routineOrder.push(rname);
    routineRefs[rname] = routineTagRefs(rnode);
  }

  /* --- controller tags --- */
  const ctrlTags = {};
  for (const t of children(child(ctrl, "Tags"), "Tag")) ctrlTags[attr(t, "Name")] = t;
  const requiredTagMissing = REQUIRED_TAGS.filter(function (n) { return !ctrlTags[n]; });
  if (requiredTagMissing.length) throw new Error("SAMPLE_RLL is missing required controller tag(s): " + requiredTagMissing.join(", "));

  const missingProgTags = {};
  const programTagSources = {};
  for (const rname of Object.keys(routines).sort()) {
    for (const ref of routineRefs[rname]) {
      if (ctrlTags[ref]) continue;
      const own = routines[rname].sourceProgram;
      const candidates = progTags[ref];
      if (!candidates) { missingProgTags[ref] = true; continue; }
      if (programTagSources[ref]) continue;
      const pick = candidates.find(function (c) { return c.program === own; }) || candidates[0];
      programTagSources[ref] = { program: pick.program, node: pick.node, others: candidates.length > 1 };
    }
  }
  for (const n of Object.keys(missingProgTags)) unresolved.push(n);

  /* --- controller tag collection: required + referenced by template routines --- */
  const controllerTagSet = {};
  REQUIRED_TAGS.forEach(function (n) { controllerTagSet[n] = true; });
  for (const rname of Object.keys(routines).sort()) {
    for (const ref of routineRefs[rname]) if (ctrlTags[ref]) controllerTagSet[ref] = true;
  }

  /* --- UDT closure from tag templates + required UDT roots --- */
  const tagTypes = {};
  for (const n of Object.keys(controllerTagSet)) tagTypes[attr(ctrlTags[n], "DataType")] = true;
  for (const n of Object.keys(programTagSources)) {
    const dt = attr(programTagSources[n].node, "DataType");
    if (dt) tagTypes[dt] = true;
  }
  REQUIRED_UDTS.forEach(function (n) { tagTypes[n] = true; });
  const udtNames = [];
  const udtSeen = {};
  const stack = Object.keys(tagTypes).sort();
  while (stack.length) {
    const n = stack.pop();
    if (udtSeen[n]) continue;
    udtSeen[n] = true;
    const dtNode = dtNodes[n];
    if (!dtNode) continue;             // built-in data type
    udtNames.push(n);
    for (const m of children(child(dtNode, "Members"), "Member")) {
      const t = attr(m, "DataType");
      if (t && !udtSeen[t]) stack.push(t);
    }
  }
  udtNames.sort(function (a, b) {
    const pa = PRIORITY_UDTS.indexOf(a), pb = PRIORITY_UDTS.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  /* --- module templates --- */
  const modulesNode = child(ctrl, "Modules");
  const modNodes = modulesNode ? children(modulesNode, "Module") : [];
  const pdp = modNodes.find(function (m) { return attr(m, "Name") === "PDP"; });
  const local = modNodes.find(function (m) { return attr(m, "Name") === "Local"; });
  if (!pdp) throw new Error("SAMPLE_RLL module template 'PDP' not found");
  if (!local) throw new Error("SAMPLE_RLL 'Local' controller module not found");
  if (attr(pdp, "CatalogNumber") !== "1799ER-IQ10XOQ10/A") {
    throw new Error("Unexpected PDP catalog number: " + attr(pdp, "CatalogNumber"));
  }

  return {
    controller: controller,
    udts: udtNames,
    dtNodes: dtNodes,
    controllerTagSet: Object.keys(controllerTagSet).sort(),
    ctrlTags: ctrlTags,
    programTagSources: programTagSources,
    routines: routines,
    routineOrder: routineOrder,
    unresolvedRefs: unresolved,
    moduleTemplate: serializeCompact(pdp),
    localModule: serializeCompact(local),
    sampleRllBytes: Buffer.byteLength(text, "utf8")
  };
}

/* ---- AOI extraction -------------------------------------------------------- */

function extractAoiFile(absFile, displayPath) {
  const text = fs.readFileSync(absFile, "utf8");
  const doc = XML.parseXml(text);
  const rootNode = XML.children(doc)[0];
  if (!rootNode) throw new Error("Empty AOI L5X: " + absFile);
  const ctrl = child(rootNode, "Controller") || rootNode;
  const aoiNodes = {};
  const aoiOrder = [];
  for (const a of children(child(ctrl, "AddOnInstructionDefinitions"), "AddOnInstructionDefinition")) {
    aoiNodes[attr(a, "Name")] = a;
    aoiOrder.push(attr(a, "Name"));
  }
  const dtNodes = {};
  for (const dt of children(child(ctrl, "DataTypes"), "DataType")) dtNodes[attr(dt, "Name")] = dt;
  const targetName = String(attr(rootNode, "TargetName") || "").trim();
  if (!aoiNodes[targetName]) {
    throw new Error("AOI export " + absFile + " does not contain its TargetName AOI '" + targetName + "'");
  }

  /* AOI dependency closure (declared Dependencies + LocalTag/Parameter data types). */
  const aoiDeps = {};
  function listedAoiDeps(aoiNode) {
    const deps = [];
    const depsNode = child(aoiNode, "Dependencies");
    if (depsNode) {
      for (const d of children(depsNode, "Dependency")) {
        if ((attr(d, "Type") || "").indexOf("AddOnInstruction") === 0 && aoiNodes[attr(d, "Name")]) {
          deps.push(attr(d, "Name"));
        }
      }
    }
    const localTags = child(aoiNode, "LocalTags");
    if (localTags) for (const lt of children(localTags, "LocalTag")) {
      const t = attr(lt, "DataType");
      if (aoiNodes[t] && deps.indexOf(t) === -1) deps.push(t);
    }
    const params = child(aoiNode, "Parameters");
    if (params) for (const p of children(params, "Parameter")) {
      const t = attr(p, "DataType");
      if (aoiNodes[t] && deps.indexOf(t) === -1) deps.push(t);
    }
    return deps;
  }
  const topo = [];
  const visiting = {};
  const visited = {};
  function visit(name) {
    if (visited[name]) return;
    if (visiting[name]) return;   // dependency cycle: keep both, sorted later
    visiting[name] = true;
    const deps = listedAoiDeps(aoiNodes[name]);
    deps.slice().sort().forEach(visit);
    visited[name] = true;
    topo.push(name);
  }
  visit(targetName);
  const target = aoiNodes[targetName];

  /* Dependent data types: params/local tags of the target closure + member closure. */
  const dtTypeSet = {};
  for (const name of topo) {
    const a = aoiNodes[name];
    const params = child(a, "Parameters");
    if (params) for (const p of children(params, "Parameter")) {
      const t = attr(p, "DataType");
      if (dtNodes[t]) dtTypeSet[t] = true;
    }
    const localTags = child(a, "LocalTags");
    if (localTags) for (const lt of children(localTags, "LocalTag")) {
      const t = attr(lt, "DataType");
      if (dtNodes[t]) dtTypeSet[t] = true;
    }
  }
  const dtStack = Object.keys(dtTypeSet);
  while (dtStack.length) {
    const n = dtStack.pop();
    const dt = dtNodes[n];
    if (!dt) continue;
    for (const m of children(child(dt, "Members"), "Member")) {
      const t = attr(m, "DataType");
      if (dtNodes[t] && !dtTypeSet[t]) { dtTypeSet[t] = true; dtStack.push(t); }
    }
  }
  const depDtNames = Object.keys(dtTypeSet).sort();

  const params = [];
  const paramsNode = child(target, "Parameters");
  if (paramsNode) for (const p of children(paramsNode, "Parameter")) {
    params.push({
      name: attr(p, "Name") || "",
      tagType: attr(p, "TagType") || "Base",
      dataType: attr(p, "DataType") || "",
      usage: attr(p, "Usage") || "",
      dimension: parseInt(attr(p, "Dimensions") || "0", 10) || 0,
      constant: attr(p, "Constant") === "true",
      required: attr(p, "Required") === "true",
      visible: attr(p, "Visible") !== "false",
      description: child(p, "Description") ? normText(textOf(child(p, "Description"))) : null
    });
  }

  return {
    name: targetName,
    description: child(target, "Description") ? normText(textOf(child(target, "Description"))) : null,
    revision: attr(target, "Revision") || null,
    vendor: attr(target, "Vendor") || null,
    softwareRevision: attr(rootNode, "SoftwareRevision") || "",
    targetExportDate: attr(rootNode, "ExportDate") || "",
    xmlAoi: serializeCompact(target),
    dependencyAoiNames: topo.filter(function (n) { return n !== targetName; }),
    dependencyAoiXml: topo.filter(function (n) { return n !== targetName; }).map(function (n) {
      return { name: n, xml: serializeCompact(aoiNodes[n]) };
    }),
    dataTypeNames: depDtNames,
    dataTypeXml: depDtNames.map(function (n) { return serializeCompact(dtNodes[n]); }),
    parameters: params,
    files: [displayPath],
    notes: "Embedded from the LogixLibraries AOI export (" + displayPath + "). " +
      "Includes dependent AOIs [" + topo.filter(function (n) { return n !== targetName; }).join(", ") + "] " +
      "and " + depDtNames.length + " dependent DataType(s); AOI logic is Structured Text (v35). " +
      "Requires a controller project that does not already define these AOIs (check revision conflicts before import)."
  };
}

/* ---- main build ------------------------------------------------------------ */

function buildTemplates(opts) {
  opts = opts || {};
  const sampleRllPath = opts.sampleRll || DEFAULTS.sampleRll;
  const aoiDir = opts.aoiDir || DEFAULTS.aoiDir;
  const extractionDate = process.env.CONVEYOR_EXTRACTION_DATE ||
    new Date().toISOString().slice(0, 10);

  const siteProject = extractSiteProject(sampleRllPath);

  const udts = sortedObject(alb.udts, function (n) { return serializeCompact(alb.dtNodes[n]); });

  const routines = sortedObject(Object.keys(alb.routines), function (n) {
    const r = alb.routines[n];
    return {
      type: r.type,
      description: r.description,
      sourceProgram: r.sourceProgram,
      rungs: r.rungs
    };
  });

  const tagTemplates = sortedObject(alb.controllerTagSet, function (n) {
    return declarationXml(alb.ctrlTags[n]);
  });

  const programTags = sortedObject(Object.keys(alb.programTagSources), function (n) {
    return declarationXml(alb.programTagSources[n].node);
  });
  const programTagSources = {};
  Object.keys(alb.programTagSources).sort().forEach(function (n) {
    programTagSources[n] = alb.programTagSources[n].program;
  });

  /* AOI library */
  const aoiLibrary = [];
  const aoiFilesInfo = [];
  for (const spec of AOI_FILES) {
    const abs = path.join(WORKSPACE, spec.file);
    if (!fs.existsSync(abs)) {
      console.warn("WARN: AOI source missing, skipped: " + abs);
      continue;
    }
    const display = localPath(abs);
    const entry = extractAoiFile(abs, display);
    aoiLibrary.push(entry);
    aoiFilesInfo.push({
      name: entry.name,
      file: display,
      bytes: fs.statSync(abs).size,
      softwareRevision: entry.softwareRevision,
      exportDate: entry.targetExportDate,
      dependentAois: entry.dependencyAoiNames,
      dependentDataTypes: entry.dataTypeNames
    });
  }
  aoiLibrary.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  const missingRoutineNames = TARGET_ROUTINES.map(function (s) { return s[1]; })
    .filter(function (n) { return !routines[n]; });
  if (missingRoutineNames.length) throw new Error("Missing template routines: " + missingRoutineNames.join(", "));
  const zoneVariants = Object.keys(routines).filter(function (n) { return /^ZPA1_[2-8]ZONE_SCAN_ZONE$/.test(n); });
  if (zoneVariants.length !== 7) throw new Error("Expected 7 zone-count scan templates, found " + zoneVariants.length);

  const templates = {
    meta: {
      generator: "L5X Studio tools/extract-conveyor-templates.js",
      extractorVersion: EXTRACTOR_VERSION,
      extractionDate: extractionDate,
      requiredUdts: REQUIRED_UDTS.slice(),
      requiredTags: REQUIRED_TAGS.slice(),
      zoneScanTemplates: Object.keys(routines).filter(function (n) { return /ZPA1_[2-8]ZONE_SCAN_ZONE/.test(n); }).sort(),
      note: "Generated file - do not edit by hand. Re-run tools/extract-conveyor-templates.js."
    },
    sourceInfo: {
      sampleRllFile: path.resolve(sampleRllPath),
      sampleRllBytes: alb.sampleRllBytes,
      sampleRllController: alb.controller,
      sampleRllExportDate: alb.controller.exportDate,
      sampleRllSoftwareRevision: alb.controller.softwareRevision,
      extractionDate: extractionDate,
      extractorVersion: EXTRACTOR_VERSION,
      aoiFiles: aoiFilesInfo,
      unresolvedTemplateRefs: alb.unresolvedRefs.slice().sort()
    },
    udts: udts,
    routines: routines,
    moduleTemplate: alb.moduleTemplate,
    localModule: alb.localModule,
    controller: alb.controller,
    tagTemplates: tagTemplates,
    programTags: programTags,
    programTagSources: programTagSources,
    aoiLibrary: aoiLibrary,
    stats: {
      udts: Object.keys(udts).length,
      routines: Object.keys(routines).length,
      zoneScanTemplates: zoneVariants.length,
      tagTemplates: Object.keys(tagTemplates).length,
      programTags: Object.keys(programTags).length,
      aoiLibrary: aoiLibrary.length
    }
  };
  return templates;
}

function renderDataFile(templates, outFile) {
  const json = JSON.stringify(templates, null, 1);
  const header =
    "/* L5X Studio - js/data/conveyor-templates.js (GENERATED FILE - do not edit by hand)\n" +
    "   Conveyor Design Studio template library extracted from the real SAMPLE_RLL ZPA project\n" +
    "   and the LogixLibraries AOI exports.\n" +
    "   Source: " + templates.sourceInfo.sampleRllFile + "\n" +
    "   SAMPLE_RLL software revision: " + templates.sourceInfo.sampleRllSoftwareRevision + "\n" +
    "   Extracted: " + templates.sourceInfo.extractionDate + " by " + templates.meta.generator + "\n" +
    "   Regenerate: node tools/extract-conveyor-templates.js\n" +
    "   Shapes: udts{name:xml}, routines{name:{type,description,sourceProgram,rungs[]}},\n" +
    "           moduleTemplate/localModule (xml), tagTemplates{name:xml}, programTags{name:xml},\n" +
    "           aoiLibrary[{name,xmlAoi,dependencyAoiXml,dataTypeXml,parameters,files,notes}]. */\n";
  const body =
    "(function (root) {\n" +
    "  \"use strict\";\n" +
    "  var CONVEYOR_TEMPLATES = " + json + ";\n\n" +
    "  if (typeof module === \"object\" && module.exports) module.exports = CONVEYOR_TEMPLATES;\n" +
    "  else {\n" +
    "    root.L5XStudio = root.L5XStudio || {};\n" +
    "    root.L5XStudio.CONVEYOR_TEMPLATES = CONVEYOR_TEMPLATES;\n" +
    "  }\n" +
    "})(typeof self !== \"undefined\" ? self : this);\n";
  fs.writeFileSync(outFile, header + body, "utf8");
  return Buffer.byteLength(header + body, "utf8");
}

function main(argv) {
  const sampleRll = argv[2] || DEFAULTS.sampleRll;
  const outFile = argv[3] ? path.resolve(argv[3]) : DEFAULTS.out;
  const aoiDir = argv[4] ? path.resolve(argv[4]) : DEFAULTS.aoiDir;
  const t0 = Date.now();
  console.log("extract-conveyor-templates: " + sampleRll);
  const templates = buildTemplates({ sampleRll: sampleRll, aoiDir: aoiDir });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const bytes = renderDataFile(templates, outFile);
  const stats = templates.stats;
  console.log("  UDTs: " + stats.udts + " (" + Object.keys(templates.udts).join(", ") + ")");
  console.log("  routines: " + stats.routines + " (zone scan variants: " + stats.zoneScanTemplates + ")");
  console.log("  moduleTemplate + localModule: " + templates.moduleTemplate.length + " + " + templates.localModule.length + " bytes");
  console.log("  controller tag templates: " + stats.tagTemplates + " (" + Object.keys(templates.tagTemplates).join(", ") + ")");
  console.log("  program tags: " + stats.programTags + " (" + Object.keys(templates.programTags).join(", ") + ")");
  console.log("  AOI library: " + stats.aoiLibrary + " (" + templates.aoiLibrary.map(function (a) { return a.name; }).join(", ") + ")");
  if (templates.sourceInfo.unresolvedTemplateRefs.length) {
    console.log("  WARN unresolved template refs: " + templates.sourceInfo.unresolvedTemplateRefs.join(", "));
  }
  console.log("  wrote " + outFile + " (" + Math.round(bytes / 1024) + " KB) in " + (Date.now() - t0) + " ms");
  return { outFile: outFile, bytes: bytes, templates: templates };
}

if (require.main === module) {
  try { main(process.argv); }
  catch (e) { console.error("extract-conveyor-templates FAILED: " + (e && e.stack || e)); process.exit(1); }
}

module.exports = { main: main, buildTemplates: buildTemplates, renderDataFile: renderDataFile };
