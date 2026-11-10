/* L5X Studio - schema-validate.js
   Runtime L5X XML schema validator driven by the compiled rule tables
   (js/data/schema-v32.js ... schema-v38.js, built by tools/build-xsd-rules.js).

   Public API (docs/IMPROVEMENTS.md T1):
     availableSchemaVersions() -> ["v32", ..., "v38"]
     pickSchemaVersion(model)  -> "vNN" | null
     validateL5x(plainRootNode, rules, opts) -> { ok, errors, warnings, stats }
     validateModel(model, opts) -> result
     summarizeResult(result) -> { errors, warnings, ok }

   Issues: { path, code, message, severity } with codes
     REQUIRED_ATTR | UNKNOWN_ATTR | UNKNOWN_ELEMENT | BAD_ENUM | TOO_MANY | ORDER |
     MISSING_CONTENT | ROUTINE_TYPE_MISMATCH (custom Routine Type<->content sanity rule).
   opts: { maxIssues = 500, strictUnknown = false, version | schemaVersion }

   Works as a classic browser script (L5XStudio namespace) and under CommonJS.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && !!module.exports;
  const nodeRequire = NODE ? require : null;
  const XML = NODE ? require("./xml.js") : (root.L5XStudio || {});

  const DEFAULT_MAX_ISSUES = 500;

  /* Rockwell L5X exports name every named component; the XSD declares Name as optional on
     all of them (the real Studio exporter always writes it). Requiring it for these element
     names is a pragmatic identity rule on top of the grammar. Deliberately EXCLUDED:
       Module - child modules (ParentModule=...) legitimately have no Name in Studio exports;
       Structure / Array / DataValue - decorated <Data> members without Name. */
  const IDENTITY_ELEMENTS = {
    Tag: 1, Program: 1, Routine: 1, DataType: 1, Member: 1,
    AddOnInstructionDefinition: 1, Parameter: 1, LocalTag: 1, Connection: 1,
    Label: 1, Task: 1, Trend: 1, Pen: 1, QuickWatchList: 1, ScheduledProgram: 1,
    Dependency: 1, EncodedData: 1
  };
  const CONTENT_ELEMENTS = {
    RLLContent: 1, FBDContent: 1, SFCContent: 1, STContent: 1,
    ExternalContent: 1, EncryptedContent: 1, EncodedContent: 1
  };

  /* xs built-in numeric bases we check for value sanity (invalid => BAD_ENUM error). */
  const INTEGER_RANGES = {
    "xs:unsignedLong": [0, "18446744073709551615"],
    "xs:unsignedInt": [0, 4294967295],
    "xs:unsignedShort": [0, 65535],
    "xs:unsignedByte": [0, 255],
    "xs:long": ["-9223372036854775808", "9223372036854775807"],
    "xs:int": [-2147483648, 2147483647],
    "xs:short": [-32768, 32767],
    "xs:byte": [-128, 127],
    "xs:integer": null,
    "xs:nonNegativeInteger": [0, null],
    "xs:positiveInteger": [1, null],
    "xs:negativeInteger": [null, -1],
    "xs:nonPositiveInteger": [null, 0]
  };
  const FLOAT_BASES = { "xs:float": 1, "xs:double": 1, "xs:decimal": 1 };

  /* ---------------- namespace / rule-table loading ---------------- */

  const rulesByVersion = {};   // version -> compiled rules (both Node and browser-ish envs)
  let nodeScanned = false;

  function namespace() {
    if (NODE) return {};
    return (root && root.L5XStudio) || {};
  }

  function compareVersions(a, b) {
    return parseInt(String(a).slice(1), 10) - parseInt(String(b).slice(1), 10);
  }

  function rulesFromModule(mod, version) {
    if (!mod) return null;
    if (mod.SCHEMA_RULES && mod.SCHEMA_RULES[version]) return mod.SCHEMA_RULES[version];
    if (mod[version] && mod[version].version === version) return mod[version];
    if (mod.version === version) return mod;
    if (mod.rules && mod.rules.version === version) return mod.rules;
    if (mod.default) return rulesFromModule(mod.default, version);
    return null;
  }

  function loadRules(version) {
    version = String(version || "");
    if (!/^v\d+$/.test(version)) return null;
    if (rulesByVersion[version]) return rulesByVersion[version];
    const ns = namespace();
    if (ns.SCHEMA_RULES && ns.SCHEMA_RULES[version]) {
      rulesByVersion[version] = ns.SCHEMA_RULES[version];
      return rulesByVersion[version];
    }
    if (NODE) {
      try {
        const mod = nodeRequire("./data/schema-" + version + ".js");
        const rules = rulesFromModule(mod, version);
        if (rules) { rulesByVersion[version] = rules; return rules; }
      } catch (e) { /* file not generated (yet) */ }
    }
    return null;
  }

  function scanNodeDataFiles() {
    if (!NODE || nodeScanned) return;
    nodeScanned = true;
    try {
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const dir = path.join(__dirname, "data");
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (let i = 0; i < files.length; i++) {
        const m = /^schema-(v\d+)\.js$/.exec(files[i]);
        if (m) loadRules(m[1]);
      }
    } catch (e) { /* ignore: rules may be absent in a Node env without generated data */ }
  }

  function availableSchemaVersions() {
    if (NODE) scanNodeDataFiles();
    const seen = {};
    let k;
    for (k in rulesByVersion) if (Object.prototype.hasOwnProperty.call(rulesByVersion, k)) seen[k] = true;
    const ns = namespace();
    if (ns.SCHEMA_RULES) {
      const keys = Object.keys(ns.SCHEMA_RULES);
      for (let i = 0; i < keys.length; i++) if (/^v\d+$/.test(keys[i])) seen[keys[i]] = true;
    }
    return Object.keys(seen).sort(compareVersions);
  }

  /* ---------------- version picking ---------------- */

  function versionFromRevision(rev) {
    if (rev === undefined || rev === null) return null;
    const s = String(rev).trim();
    const m = /^(\d{1,3})/.exec(s);
    if (!m) return null;
    let digits = m[1];
    if (digits.length > 2) digits = digits.slice(0, 2);
    const n = parseInt(digits, 10);
    if (!isFinite(n) || n < 1) return null;
    return "v" + n;
  }

  function pushVersionCandidate(list, rev) {
    const v = versionFromRevision(rev);
    if (v && list.indexOf(v) < 0) list.push(v);
  }

  function pickSchemaVersion(model) {
    const versions = availableSchemaVersions();
    if (!versions.length) return null;
    const m = model || {};
    const ctrl = m.controller || {};
    const candidates = [];
    pushVersionCandidate(candidates, ctrl.softwareRevision);
    pushVersionCandidate(candidates, ctrl.schemaRevision);
    const rootNodes = [];
    if (m.raw && m.raw.rootNode) rootNodes.push(m.raw.rootNode);
    if (m.xml) rootNodes.push(m.xml);
    for (let i = 0; i < rootNodes.length; i++) {
      const attrs = rootNodes[i] && rootNodes[i].attrs;
      if (!attrs) continue;
      pushVersionCandidate(candidates, attrs.SoftwareRevision);
      pushVersionCandidate(candidates, attrs.SchemaRevision);
      pushVersionCandidate(candidates, attrs.TargetRevision);
    }
    for (let i = 0; i < candidates.length; i++) {
      if (versions.indexOf(candidates[i]) >= 0) return candidates[i];
    }
    // No derivable (or available) version: newest compiled schema (contract fallback).
    return versions[versions.length - 1];
  }

  /* ---------------- small plain-node helpers ---------------- */

  function localName(name) {
    const s = String(name || "");
    const i = s.indexOf(":");
    return i < 0 ? s : s.slice(i + 1);
  }
  function elementChildren(node, name) {
    const out = [];
    const kids = (node && node.children) || [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (!k || k.type !== "element") continue;
      if (name === undefined || localName(k.name) === name) out.push(k);
    }
    return out;
  }
  function textOfNode(node) {
    if (XML.textOf) return XML.textOf(node);
    return ((node && node.children) || []).filter(function (c) {
      return c && (c.type === "text" || c.type === "cdata");
    }).map(function (c) { return c.text; }).join("");
  }
  function isNamespaceAttr(name) {
    return name === "xmlns" || name.indexOf("xmlns:") === 0 ||
      name.indexOf("xml:") === 0 || name.indexOf("xsi:") === 0;
  }

  /* ---------------- value checks ---------------- */

  function toBigIntSafe(s) {
    try { return typeof BigInt !== "undefined" ? BigInt(s) : null; } catch (e) { return undefined; }
  }

  function integerError(base, text) {
    const s = String(text).trim();
    if (!/^[+-]?\d+$/.test(s)) return "not an integer";
    const range = INTEGER_RANGES[base];
    if (!range) return null;
    const big = toBigIntSafe(s);
    if (big === null || big === undefined) return null; // BigInt unavailable: skip range check
    const lo = range[0] === null ? null : toBigIntSafe(String(range[0]));
    const hi = range[1] === null ? null : toBigIntSafe(String(range[1]));
    if (lo !== null && big < lo) return "below minimum " + range[0];
    if (hi !== null && big > hi) return "above maximum " + range[1];
    return null;
  }

  function numericError(base, text) {
    const s = String(text).trim();
    if (INTEGER_RANGES.hasOwnProperty(base)) return integerError(base, s);
    if (FLOAT_BASES[base]) {
      if (s === "INF" || s === "-INF" || s === "NaN") return null;
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return "not a floating point number";
      return null;
    }
    if (base === "xs:boolean") {
      if (!/^(true|false|1|0)$/.test(s)) return "not a boolean (true|false|1|0)";
      return null;
    }
    return null;
  }

  /* ---------------- validateL5x ---------------- */

  function validateL5x(plainRootNode, rules, opts) {
    opts = opts || {};
    const maxIssues = (opts.maxIssues === undefined || opts.maxIssues === null)
      ? DEFAULT_MAX_ISSUES : Number(opts.maxIssues);
    const cap = (isFinite(maxIssues) && maxIssues > 0) ? maxIssues : Infinity;
    const strictUnknown = !!opts.strictUnknown;

    const errors = [];
    const warnings = [];
    const stats = {
      version: (rules && rules.version) || null,
      elements: 0,
      attributes: 0,
      maxDepth: 0,
      issues: 0,
      truncated: false,
      fileName: null
    };
    const result = { ok: true, errors: errors, warnings: warnings, stats: stats };

    function total() { return errors.length + warnings.length; }

    function addIssue(list, severity, path, code, message) {
      if (total() >= cap) { stats.truncated = true; return false; }
      list.push({ path: path || "", code: code, message: message, severity: severity });
      return true;
    }
    function addError(path, code, message) { return addIssue(errors, "error", path, code, message); }
    function addWarning(path, code, message) {
      if (strictUnknown) return addIssue(errors, "error", path, code, message);
      return addIssue(warnings, "warning", path, code, message);
    }

    function fail(path, code, message) {
      addError(path, code, message);
      result.ok = false;
      stats.issues = errors.length + warnings.length;
      return result;
    }

    if (!rules || !rules.complexTypes) return fail("", "NO_SCHEMA", "No compiled schema rules were provided");
    if (!plainRootNode) return fail("", "NO_ROOT", "No XML root node was provided");

    /* Unwrap the virtual #doc root produced by js/xml.js parseXml. */
    let root = plainRootNode;
    if (root && root.type === "element" && /^#(doc|document|root)$/.test(root.name || "")) {
      const top = elementChildren(root);
      root = top.length ? top[0] : null;
    }
    if (!root || root.type !== "element") return fail("", "NO_ROOT", "No XML element root node was provided");

    /* Resolve the root type: global element decl, else "<Name>Type" complex type. */
    const rootName = localName(root.name);
    let rootTypeName = null;
    const rootDecl = rules.elements && rules.elements[rootName];
    if (rootDecl && rootDecl.type) rootTypeName = rootDecl.type;
    else if (rules.complexTypes[rootName + "Type"]) rootTypeName = rootName + "Type";
    if (!rootTypeName || !rules.complexTypes[rootTypeName]) {
      return fail(rootName, "UNKNOWN_ELEMENT",
        "Root element <" + rootName + "> is not declared in schema " + (rules.version || "?"));
    }

    function checkAttributeValue(decl, value, path, attrName) {
      const text = String(value);
      if (decl.enum) {
        if (decl.enum.indexOf(text) < 0) {
          const shown = decl.enum.slice(0, 10).join(", ") + (decl.enum.length > 10 ? ", ..." : "");
          addError(path, "BAD_ENUM",
            "Invalid value \"" + text + "\" for attribute \"" + attrName + "\" \u2014 expected one of: " + shown);
        }
        return;
      }
      if (decl.base && (INTEGER_RANGES.hasOwnProperty(decl.base) || FLOAT_BASES[decl.base] || decl.base === "xs:boolean")) {
        const why = numericError(decl.base, text);
        if (why) {
          addError(path, "BAD_ENUM",
            "Invalid " + decl.base + " value \"" + text + "\" for attribute \"" + attrName + "\" (" + why + ")");
        }
      }
    }

    function validateAttributes(node, ct, path) {
      const attrs = (node && node.attrs) || {};
      const declared = ct.attributes || {};
      const attrPath = path || localName(node.name);
      /* Reference/Context exports (ExportOptions "References"/"Context") contain minimal
         stub elements, e.g. <Module Use="Reference" Name="GROUP01"/>, that omit required
         module attributes in real Studio output. */
      const partialStub = attrs.Use === "Reference" || attrs.Use === "Context";
      const names = Object.keys(attrs);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (isNamespaceAttr(name)) continue;
        stats.attributes++;
        const decl = declared[name];
        if (!decl) {
          addWarning(attrPath, "UNKNOWN_ATTR",
            "Unknown attribute \"" + name + "\" on <" + localName(node.name) + "> (not declared in " +
            (rules && rules.version ? rules.version : "schema") + "; tolerated for newer firmware)");
          continue;
        }
        checkAttributeValue(decl, attrs[name], attrPath, name);
      }
      /* required attributes (relaxed for Reference/Context stub elements) */
      if (!partialStub) {
        const declaredNames = Object.keys(declared);
        for (let i = 0; i < declaredNames.length; i++) {
          const name = declaredNames[i];
          if (declared[name].required && attrs[name] === undefined) {
            addError(attrPath, "REQUIRED_ATTR",
              "Missing required attribute \"" + name + "\" on <" + localName(node.name) + ">");
          }
        }
        /* identity rule: named components always carry Name in Studio exports */
        if (declared.Name && attrs.Name === undefined && !declared.Name.required &&
            IDENTITY_ELEMENTS[localName(node.name)]) {
          addError(attrPath, "REQUIRED_ATTR",
            "Missing required Name attribute on <" + localName(node.name) + "> (named component)");
        }
      }
    }

    function checkRoutineType(node, path) {
      const type = node.attrs && node.attrs.Type;
      if (!type) return;
      const expected = { RLL: "RLLContent", ST: "STContent", FBD: "FBDContent" }[type];
      if (!expected) return;
      const kids = elementChildren(node);
      const names = kids.map(function (k) { return localName(k.name); });
      if (names.indexOf(expected) >= 0) return;
      const contentKids = names.filter(function (n) { return CONTENT_ELEMENTS[n]; });
      /* Studio exports empty routines as <Routine Name=".." Type="RLL"/> with no content
         element at all - that is valid, only a *contradicting* content element is an error. */
      if (!contentKids.length) return;
      addError(path, "ROUTINE_TYPE_MISMATCH",
        "Routine Type=\"" + type + "\" must contain <" + expected + "> but contains <" +
        contentKids.join(">, <") + ">");
    }

    function walkElement(node, typeName, path, depth) {
      if (stats.truncated) return;
      stats.elements++;
      if (depth > stats.maxDepth) stats.maxDepth = depth;
      const name = localName(node.name);
      const ct = typeName && rules.complexTypes ? rules.complexTypes[typeName] : null;
      const simple = typeName && rules.simpleTypes ? rules.simpleTypes[typeName] : null;

      if (ct) validateAttributes(node, ct, path);

      /* simple-typed element: value-level checks (enum / numeric) */
      if (simple) {
        const text = textOfNode(node).trim();
        if (text !== "") {
          if (simple.enum && simple.enum.indexOf(text) < 0) {
            addError(path, "BAD_ENUM",
              "Invalid value \"" + text + "\" for element <" + name + "> \u2014 expected one of: " +
              simple.enum.slice(0, 10).join(", "));
          } else if (simple.base && (INTEGER_RANGES.hasOwnProperty(simple.base) ||
                     FLOAT_BASES[simple.base] || simple.base === "xs:boolean")) {
            const why = numericError(simple.base, text);
            if (why) addError(path, "BAD_ENUM",
              "Invalid " + simple.base + " value \"" + text + "\" for element <" + name + "> (" + why + ")");
          }
        }
        return; // simple content cannot have element children
      }

      if (ct) {
        const declared = ct.elements || [];
        const byName = {};
        for (let i = 0; i < declared.length; i++) {
          if (!byName[declared[i].name]) byName[declared[i].name] = { decl: declared[i], pos: i };
        }
        const kids = elementChildren(node);
        /* per-name sibling counts for readable "Tag[3]" paths */
        const nameCounts = {};
        for (let i = 0; i < kids.length; i++) {
          const kn = localName(kids[i].name);
          nameCounts[kn] = (nameCounts[kn] || 0) + 1;
        }
        const seen = {};
        const counts = {};
        let lastStrictPos = -1;
        for (let i = 0; i < kids.length; i++) {
          if (stats.truncated) break;
          const child = kids[i];
          const childName = localName(child.name);
          const idx = (seen[childName] || 0) + 1;
          seen[childName] = idx;
          const label = nameCounts[childName] > 1 ? childName + "[" + idx + "]" : childName;
          const childPath = path ? path + "/" + label : label;
          const entry = byName[childName];
          if (!entry) {
            if (ct.any) continue; // xs:any tolerance: custom extensions are allowed here
            addWarning(childPath, "UNKNOWN_ELEMENT",
              "Element <" + childName + "> is not declared in " + typeName +
              " (tolerated as a newer/extension element)");
            continue;
          }
          const decl = entry.decl;
          counts[childName] = (counts[childName] || 0) + 1;
          if (decl.max >= 0 && counts[childName] > decl.max) {
            addError(childPath, "TOO_MANY",
              "Element <" + childName + "> occurs " + counts[childName] +
              " times but maxOccurs is " + decl.max + " in " + typeName);
          }
          if (!decl.choice) {
            if (entry.pos < lastStrictPos) {
              addError(childPath, "ORDER",
                "Element <" + childName + "> is out of schema order in " + typeName +
                (declared[lastStrictPos] ? " (expected after <" + declared[lastStrictPos].name + ">)" : ""));
            } else {
              lastStrictPos = entry.pos;
            }
          }
          if (decl.type && (rules.complexTypes[decl.type] || rules.simpleTypes[decl.type])) {
            walkElement(child, decl.type, childPath, depth + 1);
          } else {
            /* inline xs:any / untyped inline complex type: tolerate content wholesale */
            stats.elements++;
          }
        }
        /* missing required content */
        for (let i = 0; i < declared.length; i++) {
          const decl = declared[i];
          if (decl.min > 0 && !decl.choice && !counts[decl.name]) {
            addError(path ? path + "/" + decl.name : decl.name, "MISSING_CONTENT",
              "Missing required element <" + decl.name + "> (minOccurs=" + decl.min + ") in " + typeName);
          }
        }
        if (localName(node.name) === "Routine") checkRoutineType(node, path || "Routine");
        return;
      }

      /* Unknown/undeclared complex type: leave its content alone (we cannot know the grammar). */
    }

    walkElement(root, rootTypeName, "", 0);
    result.ok = errors.length === 0;
    stats.issues = errors.length + warnings.length;
    return result;
  }

  /* ---------------- validateModel / summarize ---------------- */

  function emptyResult(version) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      stats: { version: version || null, elements: 0, attributes: 0, maxDepth: 0,
        issues: 0, truncated: false, fileName: null }
    };
  }

  function validateModel(model, opts) {
    opts = opts || {};
    if (!model) {
      const res = emptyResult(null);
      res.errors.push({ path: "", code: "NO_ROOT", message: "No model provided", severity: "error" });
      res.stats.issues = 1;
      return res;
    }
    const versions = availableSchemaVersions();
    if (!versions.length) {
      const res = emptyResult(null);
      res.errors.push({ path: "", code: "NO_SCHEMA",
        message: "No compiled L5X schema rules found (run tools/build-xsd-rules.js)", severity: "error" });
      res.stats.issues = 1;
      return res;
    }
    let version = opts.version || opts.schemaVersion || null;
    if (version) {
      version = String(version);
      if (version.charAt(0) !== "v") version = "v" + version;
      if (versions.indexOf(version) < 0) {
        const res = emptyResult(version);
        res.errors.push({ path: "", code: "NO_SCHEMA",
          message: "Requested schema version " + version + " is not available (have: " + versions.join(", ") + ")",
          severity: "error" });
        res.stats.issues = 1;
        return res;
      }
    } else {
      version = pickSchemaVersion(model);
      if (!version) version = versions[versions.length - 1];
    }
    const rules = loadRules(version);
    if (!rules) {
      const res = emptyResult(version);
      res.errors.push({ path: "", code: "NO_SCHEMA",
        message: "Could not load compiled rules for schema " + version, severity: "error" });
      res.stats.issues = 1;
      return res;
    }
    const rootNode = (model.raw && model.raw.rootNode) || model.xml || null;
    const result = validateL5x(rootNode, rules, opts);
    result.stats.version = version;
    result.stats.fileName = model.fileName || null;
    result.schemaVersion = version;
    return result;
  }

  function summarizeResult(result) {
    const errors = result && result.errors ? result.errors.length : 0;
    const warnings = result && result.warnings ? result.warnings.length : 0;
    return { errors: errors, warnings: warnings, ok: errors === 0 };
  }

  return {
    availableSchemaVersions: availableSchemaVersions,
    pickSchemaVersion: pickSchemaVersion,
    validateL5x: validateL5x,
    validateModel: validateModel,
    summarizeResult: summarizeResult
  };
});
