/* L5X Studio - io-list.js (T2). I/O list generation from module I/O images + logic.
   Reference semantics: tnunnink/ioList (DeviceTag / GetDeviceTagsStep /
   FindReferencesStep / DetermineBuffersStep / CreateTableStep / WriteCsvStep).
   Contract: docs/IMPROVEMENTS.md, T2.

   Public API:
     buildIoListRows(model, opts) -> row[]
     defaultIoListColumns() -> [{key,label,enabled}]
     toCsv(rows, columns) -> string            (RFC 4180)
     toMarkdown(rows, columns) -> string
     applyFilters(rows, filters) -> row[]
   Extra helpers (stable for the panel / other modules): getCellText, summarizeRows. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && module.exports;
  const XML = NODE ? require("./xml.js") : root.L5XStudio;
  const OPR = NODE ? require("./operands.js") : root.L5XStudio;
  const IR = NODE ? require("./ir.js") : root.L5XStudio;
  const IOMAP = NODE ? require("./io-map.js") : root.L5XStudio;
  const DATAFLOW = NODE ? require("./dataflow.js") : root.L5XStudio;
  const MODEL = NODE ? require("./l5x-model.js") : root.L5XStudio;

  /* --------------------------------------------------------------- constants */

  const DIRECTIONS = [
    { name: "Input", letter: "I" },
    { name: "Output", letter: "O" },
    { name: "Config", letter: "C" }
  ];
  const NETWORK_PORT_RE = /Ethernet|ControlNet|DeviceNet|HART|Profibus|Modbus|BACnet|CANopen|CompoNet|AS-?Interface|Serial|RS-?232|RS-?485|DH-?485|Data\s*Highway|Profinet|EtherNet|ENET|ModbusTCP|MQTT/i;
  const MOVE_OPS = { MOV: 1, COP: 1, CPS: 1, FLL: 1 };
  const MAX_REFERENCES = 50;

  /* per-model indexes, weak so a reloaded model rebuilds */
  const REF_INDEX_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
  const TAGWEB_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;

  /* -------------------------------------------------------------- model util */

  function norm(s) { return String(s === null || s === undefined ? "" : s).trim().toUpperCase(); }
  function lower(s) { return String(s === null || s === undefined ? "" : s).toLowerCase(); }

  function rawModuleChildren(model) {
    try {
      const ctrl = model && model.raw && model.raw.controllerNode;
      if (!ctrl) return [];
      const mods = XML.child(ctrl, "Modules");
      return mods ? XML.children(mods, "Module") : [];
    } catch (e) { return []; }
  }

  function moduleDescription(rawNode) {
    if (!rawNode) return null;
    try { return XML.textOf(XML.child(rawNode, "Description")) || null; } catch (e) { return null; }
  }

  /* Decorated Data child of a tag-ish element (ConfigTag/InputTag/OutputTag).
     Some L5X exports store BOTH `<Data>` (undecoded bytes) and
     `<Data Format="Decorated">`; the model keeps only the first, so recover the
     decorated tree from the raw XML when possible. */
  function decoratedDataTree(tagNode) {
    if (!tagNode) return null;
    try {
      const datas = XML.children(tagNode, "Data");
      for (const d of datas) {
        if (XML.attr(d, "Format") === "Decorated") {
          const tree = MODEL.parseDecoratedTree(d);
          if (tree) return tree;
        }
      }
    } catch (e) { /* tolerant */ }
    return null;
  }

  /* Per-module image trees with raw-XML fallback for formats the model dropped
     (undecoded first `<Data>` hides the decorated sibling). */
  function moduleImages(model, module, rawNode) {
    const out = { input: null, output: null, config: null };
    if (rawNode) {
      try {
        const comms = XML.child(rawNode, "Communications");
        if (comms) {
          out.config = decoratedDataTree(XML.child(comms, "ConfigTag"));
          const conns = XML.child(comms, "Connections");
          const connList = conns ? XML.children(conns, "Connection") : [];
          for (const conn of connList) {
            if (!out.input) out.input = decoratedDataTree(XML.child(conn, "InputTag"));
            if (!out.output) out.output = decoratedDataTree(XML.child(conn, "OutputTag"));
          }
        }
      } catch (e) { /* tolerant */ }
    }
    const mImgs = (module && module.ioImages) || {};
    if (!out.input && mImgs.input) out.input = mImgs.input;
    if (!out.output && mImgs.output) out.output = mImgs.output;
    if (!out.config && mImgs.config) out.config = mImgs.config;
    return out;
  }

  function treeHasPoints(tree) {
    if (!tree) return false;
    if (tree.children && tree.children.length) return true;
    if (tree.elements && tree.elements.length) return true;
    return tree.value !== null && tree.value !== undefined && tree.value !== "";
  }

  /* ------------------------------------------------------------------ address */

  /* Physical location of a module: "Chassis" (backplane/remote chassis, addressed
     by Local:<slot> / Adapter:<slot>) or "Network" (addressed by module name). */
  function addressInfo(model, module, index, treeNodes) {
    const parent = (model.modules || []).find(function (m) { return m.name === module.parentModule; });
    const up = (module.ports || []).find(function (p) { return p.upstream; });
    const parentPort = parent ? (parent.ports || []).find(function (p) {
      return String(p.id) === String(module.parentModPortId);
    }) : null;
    const selfRoot = module.name === module.parentModule;
    const upType = up && up.type ? up.type : (parentPort && parentPort.type ? parentPort.type : "");
    const chassis = !selfRoot && !!parent && !!upType && !NETWORK_PORT_RE.test(upType);
    const treeNode = treeNodes && treeNodes[index];
    let slot = null;
    if (up && /^\d+$/.test(String(up.address || ""))) slot = parseInt(up.address, 10);
    else if (/^\d+$/.test(String(module.parentModPortId || ""))) slot = parseInt(module.parentModPortId, 10);
    let prefix = null;
    let localChassis = false;
    if (chassis) {
      const parentName = parent.name;
      if (parentName === "Local") {
        prefix = "Local:" + (slot !== null ? slot : module.parentModPortId);
        localChassis = true;
      } else {
        prefix = parentName + ":" + (slot !== null ? slot : module.parentModPortId);
      }
    } else if (module.name) {
      prefix = module.name;
    } else if (treeNode && treeNode.localTagPrefix && treeHasPoints((module.ioImages || {}).input)) {
      prefix = treeNode.localTagPrefix; // last resort: chassis-style tag for unnamed modules
      localChassis = prefix === "Local:" + slot;
    }
    const rack = parent ? (parent.name === "Local" ? "Local chassis" : parent.name) : "";
    return {
      exists: !!parent || selfRoot,
      selfRoot: selfRoot,
      chassis: chassis,
      moduleKind: chassis ? "Chassis" : "Network",
      prefix: prefix,
      localChassis: localChassis,
      rack: rack,
      slot: slot,
      slotOrAddress: chassis ? (slot === null ? String(module.parentModPortId || "") : String(slot))
        : (up && up.address ? String(up.address) : String(module.parentModPortId || "")),
      parentName: parent ? parent.name : ""
    };
  }

  /* ---------------------------------------------------- image point enumeration */

  /* Enumerate leaf points of a module image memberTree. Point = one physical value:
     a scalar member, or one element of an array member. Mirrors io-map.js
     listModulePoints but also keeps the parent member name (for ConfigTag
     engineering values) and each member description. */
  function enumerateImagePoints(tree) {
    const points = [];
    if (!tree) return points;

    function pushLeaf(member, path, parentName) {
      const name = path.filter(function (p) { return p !== ""; }).join(".");
      if (!name) return;
      points.push({
        name: name,
        dataType: member.dataType || null,
        value: member.value === null || member.value === undefined ? null : member.value,
        description: member.description || null,
        parentName: parentName === undefined ? null : parentName,
        raw: member
      });
    }

    function pushElements(member, path) {
      const basePath = path.concat([member.name || ""]).filter(function (p) { return p !== ""; });
      for (const el of member.elements || []) {
        const seg = (member.name || "") + (el.index || "");
        const name = basePath.slice(0, -1).concat([seg]).filter(function (p) { return p !== ""; }).join(".");
        if (!name) continue;
        points.push({
          name: name,
          dataType: member.dataType || null,
          value: el.value === null || el.value === undefined ? null : el.value,
          description: member.description || null,
          parentName: member.name || null,
          raw: member
        });
      }
    }

    function walk(node, path, parentName) {
      if (!node) return;
      const kids = node.children || [];
      if (kids.length) {
        for (const kid of kids) {
          if (kid.elements && kid.elements.length) pushElements(kid, path);
          else if (kid.children && kid.children.length) walk(kid, path.concat([kid.name || ""]), kid.name || null);
          else pushLeaf(kid, path.concat([kid.name || ""]), parentName);
        }
        return;
      }
      if (node.elements && node.elements.length) {
        pushElements(node, node.name ? path : path);
        return;
      }
      if (node.value !== null && node.value !== undefined && node.name) {
        pushLeaf(node, path.concat([node.name]), parentName);
      }
    }

    walk(tree, [], null);
    return points;
  }

  /* Flatten the module ConfigTag structure into name -> value leaves. */
  function flattenConfig(tree) {
    const leaves = [];
    function walk(node, prefix) {
      if (!node) return;
      const kids = node.children || [];
      if (kids.length) {
        for (const kid of kids) {
          if (kid.elements && kid.elements.length) {
            for (const el of kid.elements) {
              leaves.push({ name: (kid.name || "") + (el.index || ""), path: prefix.concat([(kid.name || "") + (el.index || "")]).join("."), value: el.value });
            }
          } else if (kid.children && kid.children.length) {
            walk(kid, prefix.concat([kid.name || ""]));
          } else if (kid.name) {
            leaves.push({ name: kid.name, path: prefix.concat([kid.name]).join("."), value: kid.value });
          }
        }
        return;
      }
      if (node.elements && node.elements.length) {
        for (const el of node.elements) {
          const n = (node.name || "") + (el.index || "");
          leaves.push({ name: n, path: prefix.concat([n]).join("."), value: el.value });
        }
        return;
      }
      if (node.name && node.value !== null && node.value !== undefined) {
        leaves.push({ name: node.name, path: prefix.concat([node.name]).join("."), value: node.value });
      }
    }
    walk(tree, []);
    return leaves;
  }

  /* tnunnink DeviceTag engineering values: ConfigTag members named
     <ParentMember>.HighEngineering / LowEngineering / Unit (case insensitive,
     direct name fallback when the parent member is absent). */
  function engineeringValues(row, configLeaves) {
    const res = { unit: "", high: "", low: "" };
    if (!configLeaves || !configLeaves.length) return res;
    const parent = lower(row.pointParentName || "");
    const pointPath = lower(row.pointPath || "");
    function find(suffix) {
      const want = lower(suffix);
      // 1. <parent>.HighEngineering / <parent>HighEngineering
      if (parent) {
        const dotted = parent + "." + want;
        const glued = parent + want;
        for (const leaf of configLeaves) {
          const name = lower(leaf.name), path = lower(leaf.path);
          if (path === dotted || name === dotted || name === glued) return leaf.value;
        }
      }
      // 2. direct member name
      for (const leaf of configLeaves) if (lower(leaf.name) === want) return leaf.value;
      // 3. member name ends with the suffix and starts with the parent member
      if (parent) {
        for (const leaf of configLeaves) {
          const name = lower(leaf.name);
          if (name.endsWith(want) && name.indexOf(parent) === 0) return leaf.value;
        }
      }
      // 4. flat channel members: Ch0HighEngineering for point "Ch0Data"
      for (const leaf of configLeaves) {
        const name = lower(leaf.name);
        if (!name.endsWith(want)) continue;
        const prefix = name.slice(0, name.length - want.length);
        if (prefix && pointPath.indexOf(prefix) === 0) return leaf.value;
      }
      return null;
    }
    const high = find("HighEngineering");
    const low = find("LowEngineering");
    const unit = find("Unit") !== null ? find("Unit") : find("Units");
    if (high !== null && high !== undefined) res.high = String(high);
    if (low !== null && low !== undefined) res.low = String(low);
    if (unit !== null && unit !== undefined) res.unit = String(unit);
    return res;
  }

  /* ---------------------------------------------------------- reference index */

  function buildTagScopes(model) {
    const controller = new Set();
    const programs = {};
    for (const t of (model.tags && model.tags.controller) || []) controller.add(norm(t.name));
    for (const p of Object.keys((model.tags && model.tags.programs) || {})) {
      programs[p] = new Set();
      for (const t of model.tags.programs[p] || []) programs[p].add(norm(t.name));
    }
    return { controller: controller, programs: programs };
  }

  function scopeFor(baseTag, program, scopes) {
    if (String(baseTag).indexOf(":") !== -1) return "module";
    if (program && scopes.programs[program] && scopes.programs[program].has(norm(baseTag))) return "program:" + program;
    if (scopes.controller.has(norm(baseTag))) return "controller";
    return "controller";
  }

  /* Member text of an operand relative to its base tag: "Data[2].1" for
     "GROUP01:I.Data[2].1" + base "GROUP01:I". */
  function memberText(operand, baseTag) {
    let s = String(operand === null || operand === undefined ? "" : operand).trim();
    if (baseTag && s.length >= baseTag.length && norm(s.slice(0, baseTag.length)) === norm(baseTag)) {
      s = s.slice(baseTag.length);
    }
    return s.replace(/^\s*\./, "").trim();
  }

  function buildAliasMap(model) {
    const map = Object.create(null);
    function add(tag, program) {
      if (!tag || tag.tagType !== "Alias" || !tag.aliasFor) return;
      let parsed = null;
      try { parsed = OPR.parseOperand(tag.aliasFor); } catch (e) { return; }
      if (!parsed || !parsed.baseTag || !isModuleBase(parsed.baseTag)) return;
      const key = lower(tag.name);
      (map[key] || (map[key] = [])).push({
        alias: tag.name, target: tag.aliasFor, baseTag: parsed.baseTag,
        targetMember: memberText(tag.aliasFor, parsed.baseTag), program: program || null
      });
    }
    for (const t of (model.tags && model.tags.controller) || []) add(t, null);
    const progs = (model.tags && model.tags.programs) || {};
    for (const p of Object.keys(progs)) for (const t of progs[p]) add(t, p);
    return map;
  }

  function isModuleBase(baseTag) { return String(baseTag || "").indexOf(":") !== -1; }

  function buildReferenceIndex(model) {
    const refsByBase = Object.create(null);
    const moves = [];
    const scopes = buildTagScopes(model);
    const aliasMap = buildAliasMap(model);

    function addRef(operand, program, routine, kind, via) {
      if (!operand || typeof operand !== "string") return;
      let p;
      try { p = OPR.parseOperand(operand); } catch (e) { return; }
      if (!p || !p.baseTag || p.isLiteral || p.isPlaceholder) return;
      const base = p.baseTag;
      const entry = {
        operand: operand.trim(), baseTag: base, memberText: memberText(operand, base),
        program: program || null, routine: routine || null,
        scope: scopeFor(base, program, scopes), kind: kind || "read", via: via || null
      };
      const key = lower(base);
      (refsByBase[key] || (refsByBase[key] = [])).push(entry);
      if (!via) {
        const aliases = aliasMap[lower(base)];
        if (aliases) {
          for (const a of aliases) {
            if (a.program && program && a.program !== program) continue;
            const suffix = entry.memberText ? (entry.memberText.charAt(0) === "[" ? entry.memberText : "." + entry.memberText) : "";
            addRef(a.target + suffix, program, routine, kind, base);
          }
        }
      }
    }

    function addMove(op, program, routine, sources, dests) {
      if (!sources.length || !dests.length) return;
      moves.push({ op: op, program: program || null, routine: routine || null, sources: sources, dests: dests });
    }

    function parsedRef(text) {
      if (!text || typeof text !== "string") return null;
      let p;
      try { p = OPR.parseOperand(text); } catch (e) { return null; }
      if (!p || !p.baseTag || p.isLiteral || p.isPlaceholder) return null;
      return { operand: text.trim(), baseTag: p.baseTag, memberText: memberText(text, p.baseTag) };
    }

    function handleInstr(instr, program, routine) {
      const sem = IR.LAD_OP_SEMANTICS[instr.op] || { reads: "all" };
      const args = instr.args || [];
      const reads = sem.reads === "all" ? args.map(function (_, i) { return i; }) : (sem.reads || []);
      const writes = sem.writes || [];
      for (let i = 0; i < args.length; i++) {
        const isRead = reads.indexOf(i) !== -1;
        const isWrite = writes.indexOf(i) !== -1;
        if (!isRead && !isWrite) continue;
        addRef(args[i], program, routine, isRead && isWrite ? "readwrite" : (isWrite ? "write" : "read"));
      }
      if (MOVE_OPS[instr.op] && sem.destArg !== null && sem.destArg !== undefined) {
        const dst = parsedRef(args[sem.destArg]);
        const srcs = [];
        for (let i = 0; i < args.length; i++) {
          if (i === sem.destArg) continue;
          if (reads.indexOf(i) === -1) continue;
          const r = parsedRef(args[i]);
          if (r) srcs.push(r);
        }
        if (dst) addMove(instr.op, program, routine, srcs, [dst]);
      }
    }

    function stCall(fn, args, program, routine) {
      const sem = IR.LAD_OP_SEMANTICS[String(fn || "").toUpperCase()] || { reads: "all" };
      const n = (args || []).length;
      const reads = sem.reads === "all" ? args.map(function (_, i) { return i; }) : (sem.reads || []);
      const writes = sem.writes || [];
      const srcs = [], dsts = [];
      for (let i = 0; i < n; i++) {
        const a = args[i];
        const val = a && a.kind === "namedArg" ? a.value : a;
        if (!val || val.kind !== "ref") continue;
        const isDest = sem.destArg !== null && sem.destArg !== undefined && i === sem.destArg && !(a && a.kind === "namedArg");
        addRef(val.path, program, routine, isDest ? "write" : "read");
        const pr = parsedRef(val.path);
        if (!pr) continue;
        if (isDest) dsts.push(pr); else srcs.push(pr);
      }
      const op = String(fn || "").toUpperCase();
      if (MOVE_OPS[op]) addMove(op, program, routine, srcs, dsts);
    }

    function walkExprRefs(expr, program, routine) {
      if (!expr) return;
      IR.walkExpr(expr, function (e) {
        if (e && e.kind === "ref") addRef(e.path, program, routine, "read");
      });
    }

    function walkSt(stmts, program, routine) {
      for (const s of stmts || []) {
        if (!s) continue;
        switch (s.kind) {
          case "assign":
            addRef(s.target, program, routine, "write");
            walkExprRefs(s.value, program, routine);
            break;
          case "call":
            stCall(s.fn, s.args, program, routine);
            break;
          case "if":
            for (const b of s.branches || []) {
              if (b.cond) walkExprRefs(b.cond, program, routine);
              walkSt(b.statements, program, routine);
            }
            break;
          case "for":
            addRef(s.index, program, routine, "write");
            walkExprRefs(s.from, program, routine);
            walkExprRefs(s.to, program, routine);
            if (s.by) walkExprRefs(s.by, program, routine);
            walkSt(s.statements, program, routine);
            break;
          case "while": case "repeat":
            walkExprRefs(s.cond, program, routine);
            walkSt(s.statements, program, routine);
            break;
          case "case":
            walkExprRefs(s.expr, program, routine);
            for (const c of s.cases || []) {
              for (const l of c.labels || []) walkExprRefs(l, program, routine);
              walkSt(c.statements, program, routine);
            }
            walkSt(s.elseStatements, program, routine);
            break;
          default: break;
        }
      }
    }

    for (const prog of model.programs || []) {
      for (const routine of prog.routines || []) {
        let ir = null;
        try {
          ir = model.getRoutineIR ? model.getRoutineIR(prog.name, routine.name) : null;
        } catch (e) { ir = null; }
        if (!ir) continue;
        if (ir.kind === "lad") {
          for (const rung of ir.rungs || []) {
            try { IR.walkInstrs(rung.root, function (instr) { handleInstr(instr, prog.name, routine.name); }); }
            catch (e) { /* tolerated: keep other routines */ }
          }
        } else if (ir.kind === "st") {
          walkSt(ir.statements, prog.name, routine.name);
        }
      }
    }

    return { refsByBase: refsByBase, moves: moves, aliasMap: aliasMap };
  }

  function referenceIndexFor(model) {
    if (REF_INDEX_CACHE && REF_INDEX_CACHE.has(model)) return REF_INDEX_CACHE.get(model);
    const index = buildReferenceIndex(model);
    if (REF_INDEX_CACHE) REF_INDEX_CACHE.set(model, index);
    return index;
  }

  function tagWebFor(model) {
    if (TAGWEB_CACHE && TAGWEB_CACHE.has(model)) return TAGWEB_CACHE.get(model);
    let web = { nodes: [], edges: [] };
    try { web = DATAFLOW.buildTagWeb(model, {}); } catch (e) { /* tolerant */ }
    if (TAGWEB_CACHE) TAGWEB_CACHE.set(model, web);
    return web;
  }

  /* ----------------------------------------------- references per module point */

  function pathsRelated(rowPath, refMember) {
    const r = norm(rowPath);
    const m = norm(refMember);
    if (!m) return true;        // whole-image reference
    if (!r) return true;
    if (m === r) return true;
    if (m.indexOf(r + ".") === 0 || m.indexOf(r + "[") === 0) return true; // bit/child inside this point
    if (r.indexOf(m + ".") === 0 || r.indexOf(m + "[") === 0) return true; // this point is inside the operand
    return false;
  }

  function matchReferences(index, baseTag, rowPath, dataType) {
    const list = index.refsByBase[lower(baseTag)];
    if (!list || !list.length) return [];
    const seen = Object.create(null);
    const out = [];
    // For BOOL points inside an integer word (e.g. GROUP01:I.Data.2 on an INT word)
    // the row path alone does not appear in the operand. Also accept references
    // that point at a bit of a word this row represents.
    for (const ref of list) {
      if (!pathsRelated(rowPath, ref.memberText)) continue;
      const key = (ref.program || "") + "\u0000" + (ref.routine || "") + "\u0000" +
        (ref.via || "") + "\u0000" + ref.kind;
      if (seen[key]) continue;
      seen[key] = true;
      out.push({
        program: ref.program, routine: ref.routine, scope: ref.scope,
        kind: ref.kind, address: ref.operand, via: ref.via
      });
      if (out.length >= MAX_REFERENCES) break;
    }
    return out;
  }

  /* --------------------------------------------------- buffer tag determination */

  function baseTagLooksLikeModule(label) { return String(label || "").indexOf(":") !== -1; }

  function stripIndexes(text) {
    return String(text || "").replace(/\[[^\]]*\]/g, "").replace(/\.\./g, ".").replace(/\.+$/, "").trim();
  }

  function tagDescriptionLookup(model) {
    const map = Object.create(null);
    function add(list) {
      for (const t of list || []) {
        if (!t || !t.name) continue;
        const k = lower(t.name);
        if (!(k in map)) map[k] = t.description || "";
      }
    }
    add(model.tags && model.tags.controller);
    const progs = (model.tags && model.tags.programs) || {};
    for (const p of Object.keys(progs)) add(progs[p]);
    return map;
  }

  function buildBufferLookup(tagWeb) {
    const incoming = Object.create(null);
    const outgoing = Object.create(null);
    if (!tagWeb || !tagWeb.nodes) return { incoming: incoming, outgoing: outgoing };
    const byId = Object.create(null);
    for (const n of tagWeb.nodes) if (n && n.id) byId[n.id] = n;
    function labelOf(node) { return node && node.label ? String(node.label) : ""; }
    for (const e of tagWeb.edges || []) {
      const from = byId[e.from];
      const to = byId[e.to];
      if (!from || !to) continue;
      const fl = lower(labelOf(from)), tl = lower(labelOf(to));
      if (!fl || !tl || fl === tl) continue;
      (outgoing[fl] || (outgoing[fl] = [])).push({ node: to, text: to.tag || labelOf(to) });
      (incoming[tl] || (incoming[tl] = [])).push({ node: from, text: from.tag || labelOf(from) });
    }
    return { incoming: incoming, outgoing: outgoing };
  }

  function nodeReads(node) { return !!node && /read/.test(String(node.kind || "")); }
  function nodeWrites(node) { return !!node && /write/.test(String(node.kind || "")); }

  /* Candidate buffer base tags from ONE tag-web edge (contract semantics), used
     when the per-routine MOV/COP index does not resolve a point-specific buffer.
     The tag web aggregates nodes per base tag, so only accept a candidate whose
     last-seen operand member is related to the row's point (or is the whole
     image) — otherwise every point of the module would claim the same buffer. */
  function bufferFromTagWeb(buffers, baseTag, rowPath, direction) {
    const key = lower(baseTag);
    const candidates = [];
    if (direction === "Output") {
      for (const c of buffers.incoming[key] || []) if (nodeReads(c.node)) candidates.push(c.text);
    } else {
      for (const c of buffers.outgoing[key] || []) if (nodeWrites(c.node)) candidates.push(c.text);
    }
    for (const cand of candidates) {
      if (!cand) continue;
      const candMember = memberText(cand, baseTag);
      if (candMember && !pathsRelated(rowPath, candMember)) continue;
      if (baseTagLooksLikeModule(cand)) continue;
      if (lower(cand) === key) continue;
      const cleaned = stripIndexes(cand);
      if (!cleaned || lower(cleaned) === key) continue;
      return cleaned;
    }
    return "";
  }

  function buildMoveMaps(moves) {
    const bySrc = Object.create(null);
    const byDst = Object.create(null);
    for (const m of moves) {
      for (const s of m.sources) (bySrc[lower(s.baseTag)] || (bySrc[lower(s.baseTag)] = [])).push({ move: m, ref: s });
      for (const d of m.dests) (byDst[lower(d.baseTag)] || (byDst[lower(d.baseTag)] = [])).push({ move: m, ref: d });
    }
    return { bySrc: bySrc, byDst: byDst };
  }

  function bufferFromMoves(moveMaps, baseTag, rowPath, direction) {
    const list = direction === "Output" ? moveMaps.byDst[lower(baseTag)] : moveMaps.bySrc[lower(baseTag)];
    if (!list) return "";
    for (const item of list) {
      if (!pathsRelated(rowPath, item.ref.memberText)) continue;
      const targets = direction === "Output" ? item.move.sources : item.move.dests;
      for (const t of targets) {
        if (!t.baseTag || baseTagLooksLikeModule(t.baseTag)) continue;
        return stripIndexes(t.baseTag + (t.memberText ? "." + t.memberText : ""));
      }
    }
    return "";
  }

  function detectBuffer(row, baseTag, direction, ctx) {
    const fromMoves = bufferFromMoves(ctx.moveMaps, baseTag, row.pointPath, direction);
    if (fromMoves) return { tag: fromMoves, source: "moves" };
    const fromWeb = bufferFromTagWeb(ctx.buffers, baseTag, row.pointPath, direction);
    if (fromWeb) return { tag: fromWeb, source: "tagweb" };
    return null;
  }

  /* ------------------------------------------------------------------- row API */

  function moduleRowDescription(model, module, rawNode, point) {
    if (point && point.description) return point.description;
    const md = moduleDescription(rawNode);
    if (md) return md;
    return "";
  }

  function makeRow(model, module, info, dir, point, imageTree, ctx) {
    const baseTag = info.prefix + ":" + dir.letter;
    const p = point.name || "";
    const address = baseTag + (p ? (p.charAt(0) === "[" ? p : "." + p) : "");
    const references = matchReferences(ctx.index, baseTag, p, point.dataType);
    const used = references.length > 0;
    const rowStub = {
      pointPath: p, pointParentName: point.parentName, moduleName: module.name
    };
    const buffer = (typeof point === "undefined") ? null : detectBuffer(rowStub, baseTag, dir.name, ctx);
    const eng = engineeringValues(rowStub, ctx.configLeaves ? ctx.configLeaves[module.name] : null);
    const dataType = point.dataType || (imageTree && imageTree.dataType) || "";
    return {
      moduleName: module.name || info.prefix || "",
      catalogNumber: module.catalogNumber || "",
      rack: info.rack,
      slotOrAddress: info.slotOrAddress,
      direction: dir.name,
      address: address,
      pointPath: p,
      dataType: dataType,
      description: moduleRowDescription(model, module, ctx.rawNodes[ctx.moduleIndex], point),
      value: point.value === null || point.value === undefined ? "" : String(point.value),
      used: used,
      references: references,
      bufferTag: buffer ? buffer.tag : "",
      bufferDescription: buffer && buffer.tag ? (ctx.descriptions[lower(buffer.tag.split(".")[0])] || "") : "",
      unit: eng.unit,
      high: eng.high,
      low: eng.low,
      moduleKind: info.moduleKind,
      inhibited: !!module.inhibited,
      localAddress: info.localChassis ? address : "",
      // extras (handy for the UI / health analysis)
      baseTag: baseTag,
      nameAddress: info.chassis && module.name ? module.name + ":" + dir.letter + (p ? (p.charAt(0) === "[" ? p : "." + p) : "") : "",
      bufferSource: buffer ? buffer.source : "",
      parentMember: point.parentName || ""
    };
  }

  /* Generic third-party ETHERNET-MODULE config images are opaque padding byte
     arrays (e.g. Data[404] SINT). They are not useful I/O list rows; the module
     input/output images are still emitted. */
  function isGenericEthernetConfig(tree) {
    if (!tree) return false;
    return /^AB:ETHERNET_MODULE/i.test(String(tree.dataType || ""));
  }

  function buildIoListRows(model, opts) {
    opts = opts || {};
    if (!model || !model.modules) return [];
    const rows = [];
    let treeNodes = [];
    try { treeNodes = IOMAP.buildModuleTree(model) || []; } catch (e) { treeNodes = []; }
    const rawNodes = rawModuleChildren(model);
    const index = opts.referenceIndex || referenceIndexFor(model);
    const tagWeb = opts.tagWeb || tagWebFor(model);
    const ctx = {
      index: index,
      buffers: buildBufferLookup(tagWeb),
      moveMaps: buildMoveMaps(index.moves),
      descriptions: tagDescriptionLookup(model),
      configLeaves: {},
      rawNodes: rawNodes,
      moduleIndex: 0
    };
    const onlyDirections = opts.directions && opts.directions.length
      ? opts.directions.map(function (d) { return norm(d); })
      : null;
    const onlyDirection = opts.direction ? norm(opts.direction) : null;

    for (let i = 0; i < model.modules.length; i++) {
      const module = model.modules[i];
      ctx.moduleIndex = i;
      const info = addressInfo(model, module, i, treeNodes);
      if (!info || !info.prefix || info.selfRoot) continue;
      const images = moduleImages(model, module, rawNodes[i]);
      let configLeaves = null;
      if (images.config) configLeaves = flattenConfig(images.config);
      ctx.configLeaves[module.name] = configLeaves;

      for (const dir of DIRECTIONS) {
        if (onlyDirection && onlyDirection !== norm(dir.name)) continue;
        if (onlyDirections && onlyDirections.indexOf(norm(dir.name)) === -1) continue;
        const tree = dir.name === "Input" ? images.input : dir.name === "Output" ? images.output : images.config;
        if (!tree || !treeHasPoints(tree)) continue;
        if (dir.name === "Config" && isGenericEthernetConfig(tree)) continue;
        const points = enumerateImagePoints(tree);
        for (const point of points) rows.push(makeRow(model, module, info, dir, point, tree, ctx));
      }
    }
    if (opts.filters) return applyFilters(rows, opts.filters);
    return rows;
  }

  /* ------------------------------------------------------------------ columns */

  function defaultIoListColumns() {
    return [
      { key: "moduleName", label: "Module", enabled: true },
      { key: "catalogNumber", label: "Catalog", enabled: true },
      { key: "address", label: "Address", enabled: true },
      { key: "direction", label: "Direction", enabled: true },
      { key: "pointPath", label: "Point", enabled: true },
      { key: "description", label: "Description", enabled: true },
      { key: "dataType", label: "Data type", enabled: true },
      { key: "used", label: "Used", enabled: true },
      { key: "references", label: "References", enabled: true },
      { key: "bufferTag", label: "Buffer tag", enabled: true },
      { key: "bufferDescription", label: "Buffer description", enabled: true },
      { key: "unit", label: "Unit", enabled: true },
      { key: "high", label: "High", enabled: true },
      { key: "low", label: "Low", enabled: true },
      { key: "localAddress", label: "Local address", enabled: true },
      { key: "rack", label: "Rack", enabled: true },
      { key: "slotOrAddress", label: "Slot / address", enabled: true }
    ];
  }

  const COLUMN_ALIASES = {
    module: "moduleName", catalog: "catalogNumber", point: "pointPath",
    buffer: "bufferTag", bufferDescription: "bufferDescription",
    slot: "slotOrAddress", dataType: "dataType"
  };

  function resolveColumnKey(key) {
    if (key === null || key === undefined) return "";
    const k = String(key);
    return COLUMN_ALIASES[k] || k;
  }

  function columnsInUse(columns) {
    let list = columns && columns.length ? columns : defaultIoListColumns();
    list = list.map(function (c) {
      return typeof c === "string" ? { key: c, label: c, enabled: true } : c;
    });
    return list.filter(function (c) { return c && c.enabled !== false && c.key !== undefined; });
  }

  function uniqueStrings(list) {
    const seen = Object.create(null);
    const out = [];
    for (const s of list) {
      const k = lower(s);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(s);
    }
    return out;
  }

  function getCellText(row, key) {
    if (!row) return "";
    const k = resolveColumnKey(key);
    switch (k) {
      case "used": return row.used ? "yes" : "no";
      case "references": {
        const refs = (row.references || []).map(function (r) {
          const who = [r.program, r.routine].filter(Boolean).join("/");
          return who + (r.via ? " (via " + r.via + ")" : "");
        });
        return uniqueStrings(refs).join("; ");
      }
      case "inhibited": return row.inhibited ? "yes" : "no";
      default: break;
    }
    const v = row[k];
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function csvField(value) {
    const s = value === null || value === undefined ? "" : String(value);
    if (/[",\r\n]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }

  function toCsv(rows, columns) {
    const cols = columnsInUse(columns);
    const out = [];
    out.push(cols.map(function (c) { return csvField(c.label !== undefined ? c.label : c.key); }).join(","));
    for (const row of rows || []) {
      out.push(cols.map(function (c) { return csvField(getCellText(row, resolveColumnKey(c.key))); }).join(","));
    }
    return out.join("\r\n");
  }

  function mdField(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");
  }

  function toMarkdown(rows, columns) {
    const cols = columnsInUse(columns);
    const lines = [];
    lines.push("| " + cols.map(function (c) { return mdField(c.label !== undefined ? c.label : c.key); }).join(" | ") + " |");
    lines.push("| " + cols.map(function () { return "---"; }).join(" | ") + " |");
    for (const row of rows || []) {
      lines.push("| " + cols.map(function (c) { return mdField(getCellText(row, resolveColumnKey(c.key))); }).join(" | ") + " |");
    }
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ filters */

  function matchesSubstring(haystack, needle) {
    return lower(haystack).indexOf(lower(needle)) !== -1;
  }

  function applyFilters(rows, filters) {
    let out = rows || [];
    if (!filters) return out.slice();
    if (filters.unusedOnly) out = out.filter(function (r) { return !r.used; });
    if (filters.usedOnly) out = out.filter(function (r) { return !!r.used; });
    if (filters.direction && !/^(all|any|)$/i.test(String(filters.direction))) {
      const want = norm(filters.direction);
      out = out.filter(function (r) { return norm(r.direction) === want; });
    }
    if (filters.module && String(filters.module).trim()) {
      const q = String(filters.module).trim();
      out = out.filter(function (r) {
        return matchesSubstring(r.moduleName, q) || matchesSubstring(r.catalogNumber, q) ||
          matchesSubstring(r.rack, q) || matchesSubstring(r.localAddress, q);
      });
    }
    if (filters.search && String(filters.search).trim()) {
      const q = String(filters.search).trim();
      out = out.filter(function (r) {
        return matchesSubstring(r.address, q) || matchesSubstring(r.description, q) ||
          matchesSubstring(r.pointPath, q) || matchesSubstring(r.moduleName, q) ||
          matchesSubstring(r.catalogNumber, q) || matchesSubstring(r.bufferTag, q) ||
          matchesSubstring(r.bufferDescription, q);
      });
    }
    if (filters.used !== undefined && filters.used !== null) {
      out = out.filter(function (r) { return !!r.used === !!filters.used; });
    }
    return out;
  }

  function summarizeRows(rows) {
    const summary = { rows: (rows || []).length, used: 0, unused: 0, withBuffer: 0, modules: 0, directions: { Input: 0, Output: 0, Config: 0 } };
    const modules = new Set();
    for (const r of rows || []) {
      if (r.used) summary.used++; else summary.unused++;
      if (r.bufferTag) summary.withBuffer++;
      if (r.moduleName) modules.add(r.moduleName);
      if (r.direction && summary.directions[r.direction] !== undefined) summary.directions[r.direction]++;
    }
    summary.modules = modules.size;
    return summary;
  }

  return {
    buildIoListRows: buildIoListRows,
    defaultIoListColumns: defaultIoListColumns,
    toCsv: toCsv,
    toMarkdown: toMarkdown,
    applyFilters: applyFilters,
    getCellText: getCellText,
    summarizeRows: summarizeRows,
    // exported for tests / other modules
    enumerateImagePoints: enumerateImagePoints,
    flattenConfig: flattenConfig
  };
});
