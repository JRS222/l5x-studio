/* L5X Studio - health.js (T3). Project health / cross-reference analysis.
   Report structure is stable; see the health panel for the rendered report.

   analyzeProject(model, opts) -> report
     summary / unusedTags / unresolvedOperands / uncalledRoutines / emptyRoutines /
     unusedIoPoints / aoiUsage / findings (+ project info)
   toMarkdownReport(report) -> markdown string

   Node/browser parity: classic UMD factory, require() in Node, L5XStudio namespace
   in the browser. The I/O rows come from js/io-list.js when it is loaded (T2 workstream),
   with a fall-back to js/io-map.js module image points. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;
  const OP = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
  const RLLP = (typeof module !== "undefined" && module.exports) ? require("./rll-parse.js") : root.L5XStudio;
  const STP = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;
  const IOMAP = (typeof module !== "undefined" && module.exports) ? require("./io-map.js") : root.L5XStudio;
  const FBDC = (typeof module !== "undefined" && module.exports) ? require("./fbd-convert.js") : root.L5XStudio;
  const FBDP = (typeof module !== "undefined" && module.exports) ? require("./fbd-parse.js") : root.L5XStudio;

  const LAD_SEM = (IR && IR.LAD_OP_SEMANTICS) || {};

  /* Args that are NOT tag references (routine names, labels, GSV class/instance/attr). */
  const NON_TAG_ARGS = {
    JSR: [0], JMP: [0], LBL: [0], FOR: [0], NXT: [0],
    GSV: [0, 1, 2], SSV: [0, 1, 2]
  };

  /* Instructions the LAD op table does not list but which are standard Rockwell
     instructions (used to separate AOI candidates from platform instructions). */
  const STD_OPS = {
    AFI: 1, NOP: 1, SBR: 1, RET: 1, TND: 1, MCR: 1, UID: 1, UIE: 1, IOT: 1,
    FLL: 1, COP: 1, CPS: 1, BTD: 1, SWPB: 1, AVE: 1, BSL: 1, BSR: 1, MSG: 1,
    GSV: 1, SSV: 1, CONCAT: 1, DTOS: 1, MID: 1, DELETE: 1, INSERT: 1, FIND: 1,
    SIZE: 1, TOD: 1, STOD: 1, RTOD: 1, DTOR: 1, STOR: 1, RTOS: 1, TONR: 1,
    FBD: 1, JMP: 1, LBL: 1, FOR: 1, NXT: 1, JSR: 1, OSR: 1, OSF: 1
  };

  const MODULE_TAG_RE = /^[A-Za-z_][A-Za-z0-9_]*:(\d+:)?[IOCS]$/;

  function isSystemTag(baseTag) {
    return baseTag === "S" || baseTag.indexOf("S:") === 0;
  }

  function isModuleTagPattern(baseTag) {
    return MODULE_TAG_RE.test(baseTag);
  }

  function identityOf(record, programName) {
    if (!record) return null;
    return record.program ? "program|" + record.program + "|" + record.name
      : "controller|" + record.name;
  }

  function getIoListApi() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        const api = require("./io-list.js");
        if (api && typeof api.buildIoListRows === "function") return api;
      } catch (e) { /* T2 module not present yet */ }
      return null;
    }
    if (typeof root !== "undefined" && root && root.L5XStudio &&
        typeof root.L5XStudio.buildIoListRows === "function") {
      return root.L5XStudio;
    }
    return null;
  }

  function truncate(text, n) {
    const s = String(text === undefined || text === null ? "" : text);
    return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
  }

  function literalLike(text) {
    return OP.isLiteral(text);
  }

  /* Build the reference index for one routine. Returns:
       { refs: [operand text], ops: Set(op names), jsr: Set(target names) } */
  function scanIr(ir, programName, routineName) {
    const kind = IR.irKind(ir);
    const result = { refs: [], ops: new Set(), jsr: new Set() };

    function addOperand(text, skipList, index) {
      if (index !== undefined && skipList && skipList.indexOf(index) !== -1) return;
      const t = String(text === undefined || text === null ? "" : text).trim();
      if (!t || t === "?") return;
      result.refs.push(t);
    }
    function addExprRefs(expr) {
      IR.walkExpr(expr, function (e) {
        if (e && e.kind === "ref") addOperand(e.path);
      });
    }
    function scanInstr(instr) {
      const op = String(instr.op || "");
      if (op) result.ops.add(op);
      const args = instr.args || [];
      const skip = NON_TAG_ARGS[op] || [];
      /* JSR(routine,...) and FOR(routine,index,...) reference routines to call */
      if ((op === "JSR" || op === "FOR") && args[0]) result.jsr.add(String(args[0]).trim());
      if (op === "CPT" || op === "CMP") {
        const exprIdx = op === "CPT" ? 1 : 0;
        for (let i = 0; i < args.length; i++) {
          if (i === exprIdx) {
            let expr = null;
            try { expr = STP.parseStExpression(args[i]); } catch (e) { expr = null; }
            if (expr) addExprRefs(expr);
          } else {
            addOperand(args[i], skip, i);
          }
        }
        return;
      }
      for (let i = 0; i < args.length; i++) addOperand(args[i], skip, i);
    }
    function scanStmts(stmts) {
      for (const s of stmts || []) {
        if (!s) continue;
        switch (s.kind) {
          case "assign":
            addOperand(s.target);
            addExprRefs(s.value);
            break;
          case "call":
            if (s.fn) result.ops.add(String(s.fn));
            for (const a of s.args || []) {
              const val = a && a.kind === "namedArg" ? a.value : a;
              addExprRefs(val);
            }
            break;
          case "if":
            for (const b of s.branches || []) {
              if (b.cond) addExprRefs(b.cond);
              scanStmts(b.statements);
            }
            break;
          case "for":
            addOperand(s.index);
            addExprRefs(s.from); addExprRefs(s.to);
            if (s.by) addExprRefs(s.by);
            scanStmts(s.statements);
            break;
          case "while":
          case "repeat":
            addExprRefs(s.cond);
            scanStmts(s.statements);
            break;
          case "case":
            addExprRefs(s.expr);
            for (const c of s.cases || []) scanStmts(c.statements);
            scanStmts(s.elseStatements);
            break;
          default: break;
        }
      }
    }

    if (kind === "lad") {
      IR.walkInstrs(ir, function (instr) { scanInstr(instr); });
    } else if (kind === "st") {
      scanStmts(ir.statements);
    } else if (kind === "fbd") {
      let conv = null;
      try { conv = FBDC && FBDC.fbdToLad ? FBDC.fbdToLad(ir) : null; } catch (e) { conv = null; }
      if (conv && conv.ir && IR.irKind(conv.ir) === "lad") {
        IR.walkInstrs(conv.ir, function (instr) { scanInstr(instr); });
      }
    }
    return result;
  }

  function parseRoutineContent(program, routine) {
    const content = routine.content || {};
    const type = routine.pendingType || routine.type;
    try {
      if (type === "RLL" && content.kind === "rll") {
        const rungs = (content.rungs || []).map(function (rg, i) {
          let branch;
          try { branch = RLLP.parseRllRung(rg.text || ""); }
          catch (e) { branch = { kind: "series", items: [] }; }
          return {
            id: null, number: rg.number !== undefined ? rg.number : i,
            type: rg.type || "N", comment: rg.comment, root: branch
          };
        });
        return { kind: "lad", rungs: rungs };
      }
      if (type === "ST" && content.kind === "st") return STP.parseSt(content.text || "");
      if (type === "FBD" && content.kind === "fbd") {
        let ir = null;
        try { ir = FBDP.parseFbdXml(content.xmlText || ""); } catch (e) { ir = null; }
        if (ir && IR.irKind(ir) === "fbd") return ir;
        return null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function isEmptyRoutine(routine) {
    const content = routine.content || {};
    const type = routine.pendingType || routine.type;
    if (type === "RLL") return !content.rungs || content.rungs.length === 0;
    if (type === "ST") return !content.text || String(content.text).trim() === "";
    if (type === "FBD") return !content.xmlText || String(content.xmlText).trim() === "";
    return !content.text && !content.xmlText && !(content.rungs && content.rungs.length);
  }

  /* ==================================================================== *
   *  analyzeProject
   * ==================================================================== */

  function analyzeProject(model, opts) {
    opts = opts || {};
    if (!model) throw new Error("analyzeProject: model is required");
    const programs = model.programs || [];
    const controllerTags = (model.tags && model.tags.controller) || [];
    const programTagMap = (model.tags && model.tags.programs) || {};
    const dataTypes = model.dataTypes || [];
    const modules = model.modules || [];
    const aoiDefs = model.addOnInstructions || [];

    const controllerNames = new Set();
    for (const t of controllerTags) controllerNames.add(t.name);
    const programTagNames = {};
    for (const p of Object.keys(programTagMap)) {
      programTagNames[p] = new Set();
      for (const t of programTagMap[p] || []) programTagNames[p].add(t.name);
    }
    const moduleNames = new Set();
    for (const m of modules) if (m.name) moduleNames.add(m.name);
    const aoiNames = new Set();
    for (const a of aoiDefs) if (a.name) aoiNames.add(a.name);

    const used = new Set();                 /* identity keys of referenced tags */
    const usedBases = new Set();            /* "module|<base>" style used refs */
    const unresolvedMap = new Map();        /* program|routine|operand -> {count} */
    const aoiRefs = new Map();              /* aoi name -> array of {program,routine} */
    const allOps = new Map();               /* op name (upper) -> {count, def?} */
    const jsrTargets = new Set();
    const routineScanInfo = new Map();      /* program|routine -> {ops, jsr, refs} */

    let routineCount = 0;
    let programTagCount = 0;
    for (const p of programs) programTagCount += (programTagMap[p.name] || []).length;

    function markRecord(record) {
      if (!record) return;
      const id = identityOf(record);
      if (id) used.add(id);
    }

    /* follow AliasFor chains to mark the target tag used as well */
    function markAliasTargets(record, programName, depth) {
      if (!record || !record.aliasFor || (depth || 0) > 10) return;
      const alias = OP.parseOperand(record.aliasFor);
      if (!alias.baseTag) return;
      const base = alias.baseTag;
      if (isSystemTag(base)) { used.add("system|" + base); return; }
      if (isModuleTagPattern(base)) { used.add("module|" + base); return; }
      const progTags = programTagMap[programName] || [];
      const prec = progTags.find(function (t) { return t.name === base; });
      if (prec) {
        markRecord(prec);
        markAliasTargets(prec, programName, (depth || 0) + 1);
        return;
      }
      const crec = controllerTags.find(function (t) { return t.name === base; });
      if (crec) {
        markRecord(crec);
        markAliasTargets(crec, programName, (depth || 0) + 1);
      }
    }

    function classifyRef(baseTag, programName, routineName, operandText) {
      if (isSystemTag(baseTag)) { used.add("system|" + baseTag); return true; }
      if (isModuleTagPattern(baseTag)) {
        used.add("module|" + baseTag);
        usedBases.add(baseTag.split(":")[0] + ":" + baseTag.split(":").pop());
        return true;
      }
      /* program scope first, then controller */
      const progTags = programTagMap[programName] || [];
      const prec = progTags.find(function (t) { return t.name === baseTag; });
      if (prec) {
        markRecord(prec);
        markAliasTargets(prec, programName, 0);
        return true;
      }
      const crec = controllerTags.find(function (t) { return t.name === baseTag; });
      if (crec) {
        markRecord(crec);
        markAliasTargets(crec, programName, 0);
        return true;
      }
      return false;
    }

    for (const p of programs) {
      for (const r of p.routines || []) {
        routineCount++;
        const ir = parseRoutineContent(p, r);
        const info = { ops: new Map(), jsr: new Set(), refs: 0 };
        routineScanInfo.set(p.name + "\u0000" + r.name, info);
        if (!ir) continue;
        let scan = null;
        try { scan = scanIr(ir, p.name, r.name); } catch (e) { scan = null; }
        if (!scan) continue;
        for (const opName of scan.ops) {
          const up = String(opName).toUpperCase();
          info.ops.set(up, (info.ops.get(up) || 0) + 1);
          const existing = allOps.get(up) || { count: 0 };
          existing.count++;
          allOps.set(up, existing);
          if (aoiNames.has(String(opName)) || aoiNames.has(up)) {
            if (!aoiRefs.has(String(opName))) aoiRefs.set(String(opName), []);
            aoiRefs.get(String(opName)).push({ program: p.name, routine: r.name });
          }
        }
        for (const target of scan.jsr) {
          jsrTargets.add(target);
          info.jsr.add(target);
        }
        for (const operand of scan.refs) {
          if (!operand) continue;
          const parsed = OP.parseOperand(operand);
          if (parsed.isLiteral || parsed.isPlaceholder || !parsed.baseTag) continue;
          info.refs++;
          if (!classifyRef(parsed.baseTag, p.name, r.name, operand)) {
            const key = p.name + "\u0000" + r.name + "\u0000" + operand;
            const rec = unresolvedMap.get(key) || { program: p.name, routine: r.name, operand: operand, count: 0 };
            rec.count++;
            unresolvedMap.set(key, rec);
          }
        }
      }
    }

    /* ---------------- unused tags ---------------- */
    const unusedTags = [];
    for (const t of controllerTags) {
      if (!used.has("controller|" + t.name)) {
        unusedTags.push({
          name: t.name,
          scope: "controller",
          dataType: t.dataType || "",
          aliasFor: t.aliasFor || null
        });
      }
    }
    for (const progName of Object.keys(programTagMap)) {
      for (const t of programTagMap[progName] || []) {
        if (!used.has("program|" + progName + "|" + t.name)) {
          unusedTags.push({
            name: t.name,
            scope: "program:" + progName,
            dataType: t.dataType || "",
            aliasFor: t.aliasFor || null
          });
        }
      }
    }
    unusedTags.sort(function (a, b) {
      if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    /* ---------------- unresolved operands ---------------- */
    const unresolvedOperands = Array.from(unresolvedMap.values()).sort(function (a, b) {
      if (a.program !== b.program) return a.program < b.program ? -1 : 1;
      if (a.routine !== b.routine) return a.routine < b.routine ? -1 : 1;
      return a.operand < b.operand ? -1 : 1;
    });

    /* ---------------- uncalled / empty routines ---------------- */
    const uncalledRoutines = [];
    const emptyRoutines = [];
    const calledNames = new Set();
    for (const target of jsrTargets) calledNames.add(String(target));
    for (const p of programs) {
      for (const r of p.routines || []) {
        if (isEmptyRoutine(r)) emptyRoutines.push({ program: p.name, routine: r.name });
        const isMain = p.mainRoutineName && r.name === p.mainRoutineName;
        if (isMain) continue;
        if (calledNames.has(r.name)) continue;
        uncalledRoutines.push({ program: p.name, routine: r.name });
      }
    }
    uncalledRoutines.sort(function (a, b) {
      if (a.program !== b.program) return a.program < b.program ? -1 : 1;
      return a.routine < b.routine ? -1 : a.routine > b.routine ? 1 : 0;
    });
    emptyRoutines.sort(function (a, b) {
      if (a.program !== b.program) return a.program < b.program ? -1 : 1;
      return a.routine < b.routine ? -1 : a.routine > b.routine ? 1 : 0;
    });

    /* ---------------- unused I/O points ---------------- */
    const unusedIoPoints = computeUnusedIoPoints(model, usedBases, opts);

    /* ---------------- AOI usage ---------------- */
    const aoiUsage = [];
    const seenAoi = new Set();
    for (const def of aoiDefs) {
      if (!def || !def.name) continue;
      seenAoi.add(def.name);
      const by = aoiRefs.get(def.name) || aoiRefs.get(def.name.toUpperCase()) || [];
      aoiUsage.push({
        name: def.name,
        usedBy: dedupeRoutineRefs(by),
        definitionFound: true
      });
    }
    /* instruction names used in routines that look like add-on instructions but have no
       definition in this export (e.g. imported AOI not included). */
    for (const opName of allOps.keys()) {
      if (seenAoi.has(opName)) continue;
      if (seenAoi.has(opName.toUpperCase())) continue;
      if (LAD_SEM[opName] || STD_OPS[opName]) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opName)) continue;
      const by = aoiRefs.get(opName) || aoiRefs.get(opName.toUpperCase()) || [];
      aoiUsage.push({
        name: opName,
        usedBy: dedupeRoutineRefs(by),
        definitionFound: false
      });
    }
    aoiUsage.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

    /* ---------------- findings ---------------- */
    const findings = [];
    if (unusedTags.length) {
      const ctrl = unusedTags.filter(function (t) { return t.scope === "controller"; }).length;
      const prog = unusedTags.length - ctrl;
      findings.push({
        severity: "warning",
        category: "unused-tags",
        message: unusedTags.length + " unused tag" + (unusedTags.length === 1 ? "" : "s") +
          " (" + ctrl + " controller, " + prog + " program scope)",
        details: { controller: ctrl, program: prog }
      });
    }
    if (unresolvedOperands.length) {
      const routines = new Set(unresolvedOperands.map(function (u) { return u.program + "\u0000" + u.routine; }));
      const total = unresolvedOperands.reduce(function (a, u) { return a + u.count; }, 0);
      findings.push({
        severity: "warning",
        category: "unresolved-operands",
        message: total + " unresolved operand reference" + (total === 1 ? "" : "s") +
          " in " + routines.size + " routine" + (routines.size === 1 ? "" : "s"),
        details: { count: total, routines: routines.size }
      });
    }
    if (uncalledRoutines.length) {
      findings.push({
        severity: "warning",
        category: "uncalled-routines",
        message: uncalledRoutines.length + " routine" + (uncalledRoutines.length === 1 ? "" : "s") +
          " not called from any main routine or JSR",
        details: { count: uncalledRoutines.length }
      });
    }
    if (emptyRoutines.length) {
      findings.push({
        severity: "info",
        category: "empty-routines",
        message: emptyRoutines.length + " empty routine" + (emptyRoutines.length === 1 ? "" : "s"),
        details: { count: emptyRoutines.length }
      });
    }
    if (unusedIoPoints.length) {
      findings.push({
        severity: "info",
        category: "unused-io-points",
        message: unusedIoPoints.length + " I/O point" + (unusedIoPoints.length === 1 ? "" : "s") +
          " referenced by no logic",
        details: { count: unusedIoPoints.length }
      });
    }
    const undefinedAois = aoiUsage.filter(function (a) { return !a.definitionFound; });
    if (undefinedAois.length) {
      findings.push({
        severity: "warning",
        category: "aoi-usage",
        message: undefinedAois.length + " add-on instruction" + (undefinedAois.length === 1 ? "" : "s") +
          " referenced without a definition in this export",
        details: { names: undefinedAois.map(function (a) { return a.name; }) }
      });
    }
    const unusedAois = aoiUsage.filter(function (a) { return a.definitionFound && a.usedBy.length === 0; });
    if (unusedAois.length) {
      findings.push({
        severity: "info",
        category: "aoi-usage",
        message: unusedAois.length + " add-on instruction definition" + (unusedAois.length === 1 ? "" : "s") +
          " never used in logic",
        details: { names: unusedAois.map(function (a) { return a.name; }) }
      });
    }

    const report = {
      project: {
        name: (model.controller && model.controller.name) || model.fileName || "(unknown project)",
        fileName: model.fileName || null,
        controller: model.controller || {},
        processorType: (model.controller && model.controller.processorType) || "",
        softwareRevision: (model.controller && model.controller.softwareRevision) || "",
        programCount: programs.length,
        routineCount: routineCount
      },
      summary: {
        programs: programs.length,
        routines: routineCount,
        controllerTags: controllerTags.length,
        programTags: programTagCount,
        dataTypes: dataTypes.length,
        modules: modules.length,
        unusedTags: unusedTags.length,
        unresolvedOperands: unresolvedOperands.reduce(function (a, u) { return a + u.count; }, 0),
        uncalledRoutines: uncalledRoutines.length,
        unusedIoPoints: unusedIoPoints.length,
        aoiCount: aoiDefs.length
      },
      unusedTags: unusedTags,
      unresolvedOperands: unresolvedOperands,
      uncalledRoutines: uncalledRoutines,
      emptyRoutines: emptyRoutines,
      unusedIoPoints: unusedIoPoints,
      aoiUsage: aoiUsage,
      findings: findings
    };
    return report;
  }

  function dedupeRoutineRefs(list) {
    const seen = new Set();
    const out = [];
    for (const ref of list || []) {
      const key = ref.program + "\u0000" + ref.routine;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ program: ref.program, routine: ref.routine });
    }
    return out;
  }

  /* ---------------------------------------------------------------- I/O */

  function computeUnusedIoPoints(model, usedBases, opts) {
    const ioApi = getIoListApi();
    if (ioApi) {
      let rows = [];
      try { rows = ioApi.buildIoListRows(model, opts.ioListOptions || {}) || []; }
      catch (e) { rows = []; }
      const points = [];
      for (const row of rows) {
        if (!row || row.used) continue;
        points.push({
          moduleName: row.moduleName || "",
          direction: row.direction || "",
          point: row.pointPath || row.point || row.address || "",
          address: row.address || row.pointPath || ""
        });
      }
      return points;
    }
    /* fall-back: module image leaves, considered used when the module image direction
       is referenced anywhere (coarse; js/io-list.js gives exact per-point references). */
    if (!IOMAP || typeof IOMAP.listModulePoints !== "function") return [];
    const usedDirections = new Set();
    for (const base of usedBases) usedDirections.add(base);
    const points = [];
    for (const mod of model.modules || []) {
      if (!mod || !mod.name || !mod.ioImages) continue;
      for (const [dirKey, direction] of [["input", "Input"], ["output", "Output"], ["config", "Config"]]) {
        if (!mod.ioImages[dirKey]) continue;
        if (usedDirections.has(mod.name + ":" + direction[0])) continue; /* referenced */
        let leaves = [];
        try { leaves = IOMAP.listModulePoints(model, mod.name, direction) || []; }
        catch (e) { leaves = []; }
        for (const leaf of leaves) {
          points.push({
            moduleName: mod.name,
            direction: direction,
            point: leaf.name || "",
            address: mod.name + ":" + direction[0] + "." + (leaf.name || "")
          });
        }
      }
    }
    return points;
  }

  /* ==================================================================== *
   *  Markdown report
   * ==================================================================== */

  const MAX_TABLE_ROWS = 120;

  function mdCell(text) {
    return String(text === undefined || text === null ? "" : text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  function mdTable(headers, rows, emptyText) {
    const out = [];
    out.push("| " + headers.join(" | ") + " |");
    out.push("|" + headers.map(function () { return "---"; }).join("|") + "|");
    if (!rows.length) {
      out.push("| " + emptyText + " |" + headers.slice(1).map(function () { return ""; }).join(" | ") + " |");
      return out.join("\n");
    }
    const shown = rows.slice(0, MAX_TABLE_ROWS);
    for (const row of shown) {
      out.push("| " + row.map(mdCell).join(" | ") + " |");
    }
    if (rows.length > MAX_TABLE_ROWS) {
      out.push("| \u2026 " + (rows.length - MAX_TABLE_ROWS) + " more row(s) \u2026 |" +
        headers.slice(1).map(function () { return ""; }).join(" | ") + " |");
    }
    return out.join("\n");
  }

  function toMarkdownReport(report) {
    if (!report) throw new Error("toMarkdownReport: report is required");
    const p = report.project || {};
    const s = report.summary || {};
    const lines = [];
    lines.push("# Project Health Report \u2014 " + (p.name || "(unknown project)"));
    lines.push("");
    lines.push("| Project | Value |");
    lines.push("|---|---|");
    lines.push("| File | " + mdCell(p.fileName || "(not set)") + " |");
    lines.push("| Controller | " + mdCell((p.controller && p.controller.name) || p.name || "") + " |");
    lines.push("| Processor | " + mdCell((p.processorType || "") +
      ((p.controller && p.controller.majorRev) ? " v" + p.controller.majorRev + "." + p.controller.minorRev : "")) + " |");
    lines.push("| Software revision | " + mdCell(p.softwareRevision || "") + " |");
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Count |");
    lines.push("|---|---|");
    const summaryRows = [
      ["Programs", s.programs],
      ["Routines", s.routines],
      ["Controller tags", s.controllerTags],
      ["Program tags", s.programTags],
      ["Data types", s.dataTypes],
      ["Modules", s.modules],
      ["Add-on instructions", s.aoiCount],
      ["Unused tags", s.unusedTags],
      ["Unresolved operands", s.unresolvedOperands],
      ["Uncalled routines", s.uncalledRoutines],
      ["Unused I/O points", s.unusedIoPoints]
    ];
    for (const row of summaryRows) lines.push("| " + row[0] + " | " + row[1] + " |");
    lines.push("");
    lines.push("## Findings");
    lines.push("");
    const findings = report.findings || [];
    if (!findings.length) lines.push("No findings.");
    for (const f of findings) {
      const sev = String(f.severity || "info").toUpperCase();
      lines.push("- **" + sev + "** \u2014 " + f.message + " (`" + (f.category || "general") + "`)");
    }
    lines.push("");
    lines.push("## Unused Tags");
    lines.push("");
    lines.push(mdTable(["Tag", "Scope", "Data type", "Alias for"],
      (report.unusedTags || []).map(function (t) { return [t.name, t.scope, t.dataType, t.aliasFor || ""]; }),
      "(none)"));
    lines.push("");
    lines.push("## Unresolved Operands");
    lines.push("");
    lines.push(mdTable(["Program", "Routine", "Operand", "Count"],
      (report.unresolvedOperands || []).map(function (u) { return [u.program, u.routine, u.operand, u.count]; }),
      "(none)"));
    lines.push("");
    lines.push("## Uncalled Routines");
    lines.push("");
    lines.push(mdTable(["Program", "Routine"],
      (report.uncalledRoutines || []).map(function (r) { return [r.program, r.routine]; }),
      "(none)"));
    lines.push("");
    lines.push("## Empty Routines");
    lines.push("");
    lines.push(mdTable(["Program", "Routine"],
      (report.emptyRoutines || []).map(function (r) { return [r.program, r.routine]; }),
      "(none)"));
    lines.push("");
    lines.push("## Unused I/O Points");
    lines.push("");
    lines.push(mdTable(["Module", "Direction", "Point", "Address"],
      (report.unusedIoPoints || []).map(function (pt) { return [pt.moduleName, pt.direction, pt.point, pt.address]; }),
      "(none)"));
    lines.push("");
    lines.push("## Add-On Instruction Usage");
    lines.push("");
    lines.push(mdTable(["Name", "Used by", "Definition found"],
      (report.aoiUsage || []).map(function (a) {
        return [a.name, (a.usedBy || []).map(function (u) { return u.program + " / " + u.routine; }).join(", "),
          a.definitionFound ? "yes" : "no"];
      }),
      "(none)"));
    lines.push("");
    return lines.join("\n");
  }

  return { analyzeProject: analyzeProject, toMarkdownReport: toMarkdownReport };
});
