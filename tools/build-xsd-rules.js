#!/usr/bin/env node
/* L5X Studio - tools/build-xsd-rules.js
   Compile the Rockwell L5X XML schema (XSD) files into compact JS rule tables used by
   js/schema-validate.js. Plain Node, dependency-free beyond js/xml.js.

   Usage:
     node tools/build-xsd-rules.js [xsdDir] [outDir]

   Defaults: ../../repo-analysis/l5x-schema/schemas -> ../js/data
   For every l5x-vNN.xsd found it writes js/data/schema-vNN.js (classic script + CommonJS).

   Compiled rules shape (see docs/IMPROVEMENTS.md T1):
     { version: "vNN",
       elements: { "<global element name>": { type: "<TypeName>" } },
       complexTypes: { "<TypeName>": { elements: [ { name, type, min, max, choice, ... } ],
                                      attributes: { "<Attr>": { required, enum, base, default? } },
                                      any: bool, mixed: bool } },
       simpleTypes: { "<TypeName>": { base: "xs:string", enum: [...]|null } } }
*/
"use strict";

const fs = require("fs");
const path = require("path");
const XML = require("../js/xml.js");

/* XML Schema built-in datatypes (local name only). Anything else is a user type. */
const XSD_BUILTIN_TYPES = {
  string: 1, boolean: 1, decimal: 1, float: 1, double: 1, duration: 1, dateTime: 1,
  time: 1, date: 1, gYearMonth: 1, gYear: 1, gMonthDay: 1, gDay: 1, gMonth: 1,
  hexBinary: 1, base64Binary: 1, anyURI: 1, QName: 1, NOTATION: 1,
  normalizedString: 1, token: 1, language: 1, NMTOKEN: 1, NMTOKENS: 1,
  Name: 1, NCName: 1, ID: 1, IDREF: 1, IDREFS: 1, ENTITY: 1, ENTITIES: 1,
  integer: 1, nonPositiveInteger: 1, negativeInteger: 1, nonNegativeInteger: 1,
  positiveInteger: 1, long: 1, int: 1, short: 1, byte: 1, unsignedLong: 1,
  unsignedInt: 1, unsignedShort: 1, unsignedByte: 1
};

/* Values Studio writes in real exports but that the shipped XSD enumerations miss.
   Kept deliberately tiny: only values observed in valid Rockwell exports
   (repo-analysis/LogixLibraries corpus, Studio v35). */
const KNOWN_ENUM_EXTRAS = {
  TagUsageEnum: ["Public"]   // program-tag "Public" usage added by later Studio firmware
};

/* ---------------- XML helpers (namespace-prefix agnostic) ---------------- */

function localName(node) {
  const n = (node && node.name) || (typeof node === "string" ? node : "");
  const i = n.indexOf(":");
  return i < 0 ? n : n.slice(i + 1);
}
function elementChildren(node, name) {
  const out = [];
  const kids = (node && node.children) || [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k || k.type !== "element") continue;
    if (name === undefined || localName(k) === name) out.push(k);
  }
  return out;
}
function firstChild(node, name) {
  const list = elementChildren(node, name);
  return list.length ? list[0] : null;
}
function intVal(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  if (v === "unbounded") return -1;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : dflt;
}
function normalizeTypeName(t) {
  if (!t) return null;
  const ln = localName(t);
  if (XSD_BUILTIN_TYPES[ln]) return "xs:" + ln;
  return t;
}

/* ---------------- compiler ---------------- */

/* simpleType body -> { base, enum }  (base may still name another simpleType) */
function parseSimpleBody(simpleTypeNode) {
  const restr = firstChild(simpleTypeNode, "restriction");
  if (!restr) {
    // list/union (none in the L5X schemas) - treat as string content
    return { base: "xs:string", enum: null };
  }
  const base = normalizeTypeName(restr.attrs.base || "xs:string");
  const values = elementChildren(restr, "enumeration").map(function (e) { return e.attrs.value; });
  return { base: base, enum: values.length ? values : null };
}

function compileXsdText(xsdText, sourceName) {
  const doc = XML.parseXml(String(xsdText));
  let schema = null;
  if (doc && localName(doc) === "schema") schema = doc;
  else {
    const top = (doc && doc.children) || [];
    for (let i = 0; i < top.length; i++) {
      if (top[i] && top[i].type === "element" && localName(top[i]) === "schema") { schema = top[i]; break; }
    }
  }
  if (!schema) throw new Error("No <xs:schema> root element found" + (sourceName ? " in " + sourceName : ""));

  const versionMatch = /^l5x-(v\d+)\.xsd$/i.exec(sourceName || "");
  const version = versionMatch ? versionMatch[1].toLowerCase() : null;

  /* pass 1: named simple types (may reference each other) */
  const rawSimple = {};
  const simpleTypeNodes = elementChildren(schema, "simpleType");
  for (const st of simpleTypeNodes) {
    if (st.attrs.name) rawSimple[st.attrs.name] = parseSimpleBody(st);
  }
  const simpleTypes = {};
  function resolveSimple(name, chain) {
    if (simpleTypes[name]) return simpleTypes[name];
    const raw = rawSimple[name];
    if (!raw) return null;
    if (chain && chain.indexOf(name) >= 0) return { base: "xs:string", enum: null }; // cycle guard
    let base = raw.base, enumVals = raw.enum;
    if (base && base.indexOf("xs:") !== 0 && rawSimple[base]) {
      const parent = resolveSimple(base, (chain || []).concat([name]));
      if (parent) { base = parent.base; if (!enumVals) enumVals = parent.enum; }
    }
    const rec = { base: base || "xs:string", enum: enumVals || null };
    if (rec.enum && KNOWN_ENUM_EXTRAS[name]) {
      for (const extra of KNOWN_ENUM_EXTRAS[name]) {
        if (rec.enum.indexOf(extra) < 0) rec.enum.push(extra);
      }
    }
    simpleTypes[name] = rec;
    return rec;
  }
  Object.keys(rawSimple).forEach(function (n) { resolveSimple(n, []); });

  const complexTypes = {};
  const elements = {};

  function resolveTypeRef(typeName) {
    if (!typeName) return { base: "xs:string", enum: null };
    const norm = normalizeTypeName(typeName);
    if (norm.indexOf("xs:") === 0) return { base: norm, enum: null };
    const st = simpleTypes[norm];
    if (st) return { base: st.base, enum: st.enum };
    return { base: null, enum: null }; // named complex type
  }

  function addAttribute(attributes, attrNode) {
    const name = attrNode.attrs.name;
    if (!name) return;
    let ref = resolveTypeRef(attrNode.attrs.type);
    const inline = firstChild(attrNode, "simpleType");
    if (inline) {
      const r = parseSimpleBody(inline);
      ref = { base: r.base, enum: r.enum };
    }
    const rec = {
      required: attrNode.attrs.use === "required",
      enum: ref.enum || null,
      base: ref.base || "xs:string"
    };
    if (attrNode.attrs.default !== undefined) rec.default = attrNode.attrs.default;
    if (attrNode.attrs.fixed !== undefined) rec.fixed = attrNode.attrs.fixed;
    attributes[name] = rec;
  }

  function parseElementDecl(elemNode, state) {
    if (!elemNode.attrs.name) return null; // xs:element ref= is not used by the L5X schemas
    const name = elemNode.attrs.name;
    const ownMin = intVal(elemNode.attrs.minOccurs, 1);
    const ownMax = intVal(elemNode.attrs.maxOccurs, 1);

    let type = normalizeTypeName(elemNode.attrs.type);
    let enumVals = null, base = null;
    const inlineSimple = firstChild(elemNode, "simpleType");
    const inlineComplex = firstChild(elemNode, "complexType");
    if (inlineSimple) {
      const r = parseSimpleBody(inlineSimple);
      base = r.base; enumVals = r.enum; type = null;
    } else if (inlineComplex) {
      const anonName = "#anon:" + (state.parentTypeName || "?") + "/" + name;
      complexTypes[anonName] = parseComplexType(inlineComplex, anonName);
      type = anonName;
    } else if (type && type.indexOf("xs:") !== 0 && simpleTypes[type]) {
      base = simpleTypes[type].base;
      enumVals = simpleTypes[type].enum || null;
    }

    const effectiveMin = state.inChoice ? 0 : ownMin * state.minMult;
    const effectiveMax = state.maxMult === -1 ? -1 : ownMax * state.maxMult;
    const decl = {
      name: name,
      type: type || null,
      min: effectiveMin,
      max: effectiveMax,
      choice: !!state.inChoice
    };
    if (enumVals) decl.enum = enumVals;
    if (base && base !== "xs:string") decl.base = base;
    return decl;
  }

  function walkGroup(groupNode, out, state) {
    const groupLocal = localName(groupNode);
    const groupMin = intVal(groupNode.attrs.minOccurs, 1);
    const groupMax = intVal(groupNode.attrs.maxOccurs, 1);
    const inChoice = !!state.inChoice || groupLocal === "choice";
    const minMult = state.minMult * groupMin;
    const maxMult = (state.maxMult === -1 || groupMax === -1) ? -1 : state.maxMult * groupMax;
    const nextState = {
      inChoice: inChoice,
      minMult: minMult,
      maxMult: maxMult,
      parentTypeName: state.parentTypeName
    };
    const kids = elementChildren(groupNode);
    for (const child of kids) {
      const ln = localName(child);
      if (ln === "element") {
        const decl = parseElementDecl(child, nextState);
        if (decl) out.elements.push(decl);
      } else if (ln === "sequence" || ln === "choice" || ln === "all") {
        walkGroup(child, out, nextState);
      } else if (ln === "any") {
        out.any = true;
      }
    }
  }

  function parseComplexType(node, typeName) {
    const out = { elements: [], attributes: {}, any: false, mixed: node.attrs.mixed === "true" };
    for (const a of elementChildren(node, "attribute")) addAttribute(out.attributes, a);
    for (const child of elementChildren(node)) {
      const ln = localName(child);
      if (ln === "sequence" || ln === "choice" || ln === "all") {
        walkGroup(child, out, {
          inChoice: ln === "choice",
          minMult: 1,
          maxMult: 1,
          parentTypeName: typeName
        });
      } else if (ln === "any") {
        out.any = true;
      }
      // xs:attributeGroup / complexContent / simpleContent never occur in the L5X schemas
    }
    return out;
  }

  /* pass 2: named complex types */
  for (const ct of elementChildren(schema, "complexType")) {
    if (ct.attrs.name) complexTypes[ct.attrs.name] = parseComplexType(ct, ct.attrs.name);
  }
  /* pass 3: global element declarations (root + nillable helpers) */
  for (const e of elementChildren(schema, "element")) {
    if (!e.attrs.name) continue;
    const rec = { type: normalizeTypeName(e.attrs.type) || null };
    if (e.attrs.nillable === "true") rec.nillable = true;
    elements[e.attrs.name] = rec;
  }

  const rules = {
    version: version || "v0",
    elements: elements,
    complexTypes: complexTypes,
    simpleTypes: simpleTypes
  };
  const stats = auditRules(rules, sourceName);
  return { rules: rules, stats: stats };
}

/* Basic self-check: every referenced named type must exist; count the grammar features. */
function auditRules(rules, sourceName) {
  let attributes = 0, elementDecls = 0, requiredAttrs = 0, enums = 0, choices = 0;
  let anyTypes = 0, mixedTypes = 0;
  const known = function (t) {
    return t.indexOf("xs:") === 0 || !!rules.complexTypes[t] || !!rules.simpleTypes[t];
  };
  const problems = [];
  for (const t of Object.keys(rules.simpleTypes)) {
    if (rules.simpleTypes[t].enum) enums += rules.simpleTypes[t].enum.length;
  }
  for (const ctName of Object.keys(rules.complexTypes)) {
    const ct = rules.complexTypes[ctName];
    if (ct.any) anyTypes++;
    if (ct.mixed) mixedTypes++;
    for (const a of Object.keys(ct.attributes)) {
      attributes++;
      if (ct.attributes[a].required) requiredAttrs++;
    }
    for (const el of ct.elements) {
      elementDecls++;
      if (el.choice) choices++;
      if (el.type && !known(el.type)) problems.push(ctName + " -> element <" + el.name + "> unknown type " + el.type);
    }
  }
  for (const g of Object.keys(rules.elements)) {
    const t = rules.elements[g].type;
    if (t && !known(t)) problems.push("global element <" + g + "> unknown type " + t);
  }
  return {
    source: sourceName || null,
    version: rules.version,
    globalElements: Object.keys(rules.elements).length,
    complexTypes: Object.keys(rules.complexTypes).length,
    simpleTypes: Object.keys(rules.simpleTypes).length,
    elementDecls: elementDecls,
    attributes: attributes,
    requiredAttrs: requiredAttrs,
    enumerations: enums,
    choiceElements: choices,
    anyTypes: anyTypes,
    mixedTypes: mixedTypes,
    problems: problems
  };
}

/* ---------------- generated file rendering ---------------- */

function renderRulesSource(rules, xsdFileName) {
  const version = rules.version;
  const lines = [];
  lines.push("/* L5X Studio - js/data/schema-" + version + ".js (GENERATED FILE - DO NOT EDIT)");
  lines.push("   Compiled by tools/build-xsd-rules.js from " + (xsdFileName || "l5x-" + version + ".xsd"));
  lines.push("   Rockwell L5X XML schema grammar -> L5XStudio.SCHEMA_RULES[\"" + version + "\"]");
  lines.push("   Browser: classic script assigning the namespace; Node: module.exports = rules");
  lines.push("   (a non-enumerable .SCHEMA_RULES registry is attached for namespace-style loaders).");
  lines.push("   Regenerate with: node tools/build-xsd-rules.js <xsdDir> <outDir> */");
  lines.push("(function (root) {");
  lines.push('  "use strict";');
  lines.push("  var RULES = {");
  lines.push('    "version": ' + JSON.stringify(version) + ",");
  lines.push('    "elements": ' + JSON.stringify(rules.elements) + ",");
  lines.push('    "complexTypes": ' + JSON.stringify(rules.complexTypes) + ",");
  lines.push('    "simpleTypes": ' + JSON.stringify(rules.simpleTypes));
  lines.push("  };");
  lines.push("  var REGISTRY = {};");
  lines.push("  REGISTRY[" + JSON.stringify(version) + "] = RULES;");
  lines.push('  if (typeof module === "object" && module.exports) {');
  lines.push("    module.exports = RULES;");
  lines.push("    try {");
  lines.push('      Object.defineProperty(RULES, "SCHEMA_RULES", { value: REGISTRY, enumerable: false });');
  lines.push("    } catch (e) { RULES.SCHEMA_RULES = REGISTRY; }");
  lines.push("  } else {");
  lines.push("    root.L5XStudio = root.L5XStudio || {};");
  lines.push("    root.L5XStudio.SCHEMA_RULES = root.L5XStudio.SCHEMA_RULES || {};");
  lines.push("    root.L5XStudio.SCHEMA_RULES[" + JSON.stringify(version) + "] = RULES;");
  lines.push("  }");
  lines.push('})(typeof self !== "undefined" ? self : this);');
  lines.push("");
  return lines.join("\n");
}

function compileSchemaFile(xsdPath) {
  const text = fs.readFileSync(xsdPath, "utf8");
  return compileXsdText(text, path.basename(xsdPath));
}

/* ---------------- main ---------------- */

function main(argv) {
  argv = argv || [];
  const xsdDir = path.resolve(argv[0] || path.join(__dirname, "..", "..", "repo-analysis", "l5x-schema", "schemas"));
  const outDir = path.resolve(argv[1] || path.join(__dirname, "..", "js", "data"));
  if (!fs.existsSync(xsdDir)) {
    console.error("XSD directory not found: " + xsdDir);
    process.exitCode = 2;
    return null;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(xsdDir)
    .filter(function (f) { return /^l5x-v\d+\.xsd$/i.test(f); })
    .sort(function (a, b) {
      return parseInt(/(\d+)/.exec(a)[1], 10) - parseInt(/(\d+)/.exec(b)[1], 10);
    });
  if (!files.length) {
    console.error("No l5x-vNN.xsd files found in " + xsdDir);
    process.exitCode = 2;
    return null;
  }
  const summary = [];
  for (const f of files) {
    const compiled = compileSchemaFile(path.join(xsdDir, f));
    const version = compiled.rules.version;
    const outPath = path.join(outDir, "schema-" + version + ".js");
    const text = renderRulesSource(compiled.rules, f);
    fs.writeFileSync(outPath, text, "utf8");
    const row = compiled.stats;
    row.output = outPath;
    row.bytes = Buffer.byteLength(text, "utf8");
    row.sourceBytes = fs.statSync(path.join(xsdDir, f)).size;
    summary.push(row);
    console.log("  " + version + ": " + row.complexTypes + " complexTypes, " + row.simpleTypes +
      " simpleTypes, " + row.enumerations + " enums, " + row.elementDecls + " element decls, " +
      row.attributes + " attrs (" + row.requiredAttrs + " required), " + row.bytes + " bytes -> " + path.basename(outPath));
    if (row.problems.length) {
      console.warn("  WARNING " + version + ": " + row.problems.length + " unresolved type reference(s)");
      for (const p of row.problems.slice(0, 10)) console.warn("    " + p);
    }
  }
  console.log("Compiled " + summary.length + " schema(s) into " + outDir);
  return summary;
}

module.exports = {
  compileXsdText: compileXsdText,
  compileSchemaFile: compileSchemaFile,
  renderRulesSource: renderRulesSource,
  auditRules: auditRules,
  main: main
};

if (require.main === module) main(process.argv.slice(2));
