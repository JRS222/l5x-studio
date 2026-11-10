/* L5X Studio - dataflow.js (T1). Dataflow graphs from IR and from the whole project.
   See CONTRACT section 6 for the graph shape. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;
  const OPR = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
  const RLLP = (typeof module !== "undefined" && module.exports) ? require("./rll-parse.js") : root.L5XStudio;
  const STP = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;

  const SEM = IR.LAD_OP_SEMANTICS;

  function semFor(op) {
    return SEM[op] || { role: "other", reads: null, writes: [], destArg: null };
  }

  /* access kinds */
  const K_READ = "tag-read", K_WRITE = "tag-write", K_RW = "tag-readwrite";

  function mergeKind(kind, read, write) {
    if (read && write) return K_RW;
    if (read) return K_READ;
    return K_WRITE;
  }

  /* ---------------------------------------------------- routine dataflow */

  function buildRoutineDataflow(ir, opts) {
    opts = opts || {};
    const routineName = opts.routineName || "routine";
    const program = opts.program || null;
    const simplify = opts.simplify !== false;
    const graph = { nodes: [], edges: [] };
    let seq = 0;

    const reg = {}; // key -> node
    const edgeKeys = {};

    function nodeId(kind, text) {
      return kind + ":" + routineName + ":" + (text === undefined || text === null ? "" : text) +
        (simplify ? "" : ":" + (seq++));
    }

    function ensureNode(kind, label, extra, key) {
      if (simplify && key !== undefined) {
        const existing = reg[key];
        if (existing) {
          if (extra && extra.tag !== undefined && existing.tag === undefined) existing.tag = extra.tag;
          return existing;
        }
      }
      const node = Object.assign({ id: nodeId(kind, label), label: label, kind: kind }, extra || {});
      graph.nodes.push(node);
      if (simplify && key !== undefined) reg[key] = node;
      return node;
    }

    function addEdge(from, to, kind, label) {
      if (!from || !to) return;
      if (from === to) return;
      const key = from.id + "|" + kind + "|" + to.id;
      if (edgeKeys[key]) return;
      edgeKeys[key] = true;
      graph.edges.push({ from: from.id, to: to.id, kind: kind, label: label });
    }

    /* operand -> node. Literals become "value" nodes; '?' skipped (null). */
    function operandNode(text, read, write, ctx) {
      if (text === undefined || text === null) return null;
      text = String(text).trim();
      if (text === "?" || text === "") return null;
      const isStr = text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'";
      if (isStr || OPR.isLiteral(text)) {
        const n = ensureNode("value", text, {}, "value|" + text);
        if (ctx) { n.op = ctx.op; n.index = ctx.index; }
        return n;
      }
      const kind = mergeKind("", read, write);
      const scope = OPR.parseOperand(text).isModuleTag ? "module"
        : (program ? "program:" + program : "controller");
      const n = ensureNode(kind, text,
        { tag: text, op: ctx ? ctx.op : undefined, scope: scope, index: ctx ? ctx.index : undefined },
        kind + "|" + text);
      return n;
    }

    if (IR.irKind(ir) === "lad") {
      buildLad(ir);
    } else if (IR.irKind(ir) === "st") {
      buildSt(ir.statements || []);
    }
    return graph;

    /* ---------- LAD ---------- */
    function buildLad(ladIR) {
      for (const rung of ladIR.rungs || []) {
        const logic = ensureNode("logic", "Rung " + rung.number, { rung: rung.number }, null);
        // branch nodes: created per parallel node during walk
        const branches = new Map(); // pathKey -> branch node
        IR.walkInstrs(rung.root, (instr, ctx) => {
          const sem = semFor(instr.op);
          const args = instr.args || [];
          const reads = sem.reads === "all" ? args.map((_, i) => i) : (sem.reads || []);
          const writes = sem.writes || [];
          const isRead = i => reads.indexOf(i) !== -1;
          const isWrite = i => writes.indexOf(i) !== -1;

          // attach to branch node when inside a parallel leg
          let sink = logic;
          if (ctx.path.length && ctx.path[ctx.path.length - 1].leg !== undefined) {
            const key = ctx.path.map(p => (p.leg !== undefined ? "L" + p.leg : "I" + p.item)).join(".");
            let bnode = branches.get(key);
            if (!bnode) {
              bnode = ensureNode("branch", "OR", {}, null);
              branches.set(key, bnode);
              addEdge(bnode, logic, "data");
            }
            sink = bnode;
          }

          // per-arg access nodes
          const argNodes = args.map((a, i) =>
            operandNode(a, isRead(i), isWrite(i), { op: instr.op, index: i }));

          for (let i = 0; i < args.length; i++) {
            const n = argNodes[i];
            if (!n) continue;
            if (isRead(i)) addEdge(n, sink, "data");
            if (isWrite(i)) addEdge(logic, n, "data");
          }

          // src -> dst data movement (MOV / ADD family)
          if (sem.destArg !== null && sem.destArg !== undefined && sem.role === "data") {
            const dest = argNodes[sem.destArg];
            if (!dest) return;
            const func = ensureNode("func", instr.op, { op: instr.op }, null);
            const srcs = reads.filter(i => i !== sem.destArg && argNodes[i]);
            for (const i of srcs) addEdge(argNodes[i], func, "data");
            addEdge(func, dest, "data");
          }
        });
      }
    }

    /* ---------- ST ---------- */
    function buildSt(stmts) {
      const targetsOf = stmts2 => {
        const out = [];
        for (const s of stmts2) {
          if (!s) continue;
          if (s.kind === "assign") {
            const t = operandNode(s.target, false, true, {});
            if (t) out.push(t);
          } else if (s.kind === "call") {
            const sem = semFor(String(s.fn).toUpperCase());
            const args = s.args || [];
            if (sem.destArg !== null && sem.destArg !== undefined && args[sem.destArg] &&
                !(args[sem.destArg].kind === "namedArg")) {
              const t = operandNode(args[sem.destArg].path !== undefined ? args[sem.destArg].path
                : args[sem.destArg].value, false, true, {});
              if (t) out.push(t);
            }
          }
        }
        return out;
      };

      function exprRefs(expr) {
        const out = [];
        IR.walkExpr(expr, e => {
          if (e.kind === "ref") {
            const n = operandNode(e.path, true, false, {});
            if (n) out.push(n);
          } else if (e.kind === "literal") {
            const n = operandNode(e.value, true, false, {});
            if (n) out.push(n);
          }
        });
        return out;
      }

      function walk(stmts2) {
        for (const s of stmts2) {
          if (!s) continue;
          switch (s.kind) {
            case "assign": {
              const target = operandNode(s.target, false, true, {});
              const refs = exprRefs(s.value);
              if (s.value && s.value.kind === "call") {
                const func = ensureNode("func", s.value.fn, { op: s.value.fn }, null);
                refs.forEach(r => addEdge(r, func, "data"));
                if (target) addEdge(func, target, "data");
              } else {
                refs.forEach(r => addEdge(r, target, "data"));
              }
              break;
            }
            case "call": {
              const sem = semFor(String(s.fn).toUpperCase());
              const args = s.args || [];
              const func = ensureNode("func", s.fn, { op: String(s.fn).toUpperCase() }, null);
              let dest = null;
              args.forEach((a, i) => {
                const val = a && a.kind === "namedArg" ? a.value : a;
                if (val && val.kind === "ref") {
                  const isDest = sem.destArg !== null && sem.destArg !== undefined && i === sem.destArg && a.kind !== "namedArg";
                  const n = operandNode(val.path, !isDest, isDest, {});
                  addEdge(n, func, "data");
                  if (isDest) dest = n;
                } else if (val && val.kind === "literal") {
                  const n = operandNode(val.value, true, false, {});
                  addEdge(n, func, "data");
                }
              });
              if (dest) addEdge(func, dest, "data");
              break;
            }
            case "if": {
              const logic = ensureNode("logic", "IF", { op: "IF" }, null);
              (s.branches || []).forEach(b => {
                if (b.cond) exprRefs(b.cond).forEach(r => addEdge(r, logic, "control"));
                const targets = targetsOf(b.statements);
                targets.forEach(t => addEdge(logic, t, "control"));
                walk(b.statements);
              });
              break;
            }
            case "for": case "while": case "repeat": {
              const logic = ensureNode("logic", s.kind.toUpperCase(), { op: s.kind.toUpperCase() }, null);
              if (s.cond) exprRefs(s.cond).forEach(r => addEdge(r, logic, "control"));
              const targets = targetsOf(s.statements);
              targets.forEach(t => addEdge(logic, t, "control"));
              walk(s.statements);
              break;
            }
            case "case": {
              const logic = ensureNode("logic", "CASE", { op: "CASE" }, null);
              exprRefs(s.expr).forEach(r => addEdge(r, logic, "control"));
              (s.cases || []).forEach(c => {
                const targets = targetsOf(c.statements);
                targets.forEach(t => addEdge(logic, t, "control"));
                walk(c.statements);
              });
              if (s.elseStatements) {
                const targets = targetsOf(s.elseStatements);
                targets.forEach(t => addEdge(logic, t, "control"));
                walk(s.elseStatements);
              }
              break;
            }
            default: break;
          }
        }
      }
      walk(stmts);
    }
  }

  /* ------------------------------------------------------ controller tag web */

  function buildTagWeb(model, opts) {
    opts = opts || {};
    const graph = { nodes: [], edges: [] };
    const nodesById = new Map();
    const edgeKeys = new Map();

    function tagNameSet(list) {
      const s = new Set();
      for (const t of list || []) if (t && t.name) s.add(t.name);
      return s;
    }
    const controllerTags = tagNameSet(model.tags && model.tags.controller);
    const programTags = {};
    for (const p of Object.keys((model.tags && model.tags.programs) || {})) {
      programTags[p] = tagNameSet(model.tags.programs[p]);
    }

    function scopeOf(baseTag, programName) {
      if (baseTag.indexOf(":") !== -1) return "module";
      if (programName && programTags[programName] && programTags[programName].has(baseTag)) {
        return "program:" + programName;
      }
      if (controllerTags.has(baseTag)) return "controller";
      return "controller"; // default when undeclared
    }

    function tagNode(baseTag, programName, read, write, rawText) {
      const scope = scopeOf(baseTag, programName);
      const id = "tag|" + scope + "|" + baseTag;
      let node = nodesById.get(id);
      if (!node) {
        node = {
          id: id, label: baseTag,
          kind: mergeKind("", read, write),
          tag: rawText || baseTag,
          scope: scope, program: programName, programs: programName ? [programName] : []
        };
        nodesById.set(id, node);
        graph.nodes.push(node);
      } else {
        const prevRead = node.kind === K_READ || node.kind === K_RW;
        const prevWrite = node.kind === K_WRITE || node.kind === K_RW;
        node.kind = mergeKind("", prevRead || read, prevWrite || write);
        if (programName && node.programs.indexOf(programName) === -1) node.programs.push(programName);
      }
      return node;
    }

    function addEdge(from, to, kind) {
      if (!from || !to || from === to) return;
      const key = from.id + "|" + kind + "|" + to.id;
      if (edgeKeys.has(key)) return;
      edgeKeys.set(key, true);
      graph.edges.push({ from: from.id, to: to.id, kind: kind });
    }

    function operandBase(text) {
      if (text === undefined || text === null) return null;
      text = String(text).trim();
      if (text === "" || text === "?") return null;
      if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") return null;
      const p = OPR.parseOperand(text);
      if (!p.baseTag) return null; // literal
      return p.baseTag;
    }

    function handleInstr(instr, programName) {
      const sem = semFor(instr.op);
      const args = instr.args || [];
      const reads = sem.reads === "all" ? args.map((_, i) => i) : (sem.reads || []);
      const writes = sem.writes || [];
      const readNodes = [], writeNodes = [];
      args.forEach((a, i) => {
        const base = operandBase(a);
        if (!base) return;
        const rd = reads.indexOf(i) !== -1;
        const wr = writes.indexOf(i) !== -1;
        const n = tagNode(base, programName, rd, wr, a);
        if (rd) readNodes.push(n);
        if (wr) writeNodes.push(n);
      });
      // data movement edges
      if (sem.destArg !== null && sem.destArg !== undefined && sem.role === "data") {
        const dst = writeNodes[0]; // dest is the write node
        for (let i = 0; i < args.length; i++) {
          if (i === sem.destArg) continue;
          const base = operandBase(args[i]);
          if (!base) continue;
          const src = tagNode(base, programName, true, false, args[i]);
          addEdge(src, dst, "data");
        }
      }
    }

    function handleStStmts(stmts, programName) {
      for (const s of stmts) {
        if (!s) continue;
        switch (s.kind) {
          case "assign": {
            const tBase = operandBase(s.target);
            const tNode = tBase ? tagNode(tBase, programName, false, true, s.target) : null;
            IR.walkExpr(s.value, e => {
              if (e.kind !== "ref") return;
              const base = operandBase(e.path);
              if (!base) return;
              const rn = tagNode(base, programName, true, false, e.path);
              addEdge(rn, tNode, "data");
            });
            break;
          }
          case "call": {
            const sem = semFor(String(s.fn).toUpperCase());
            const args = s.args || [];
            const reads = sem.reads === "all" ? args.map((_, i) => i) : (sem.reads || []);
            const writes = sem.writes || [];
            const argNodes = [];
            args.forEach((a, i) => {
              const val = a && a.kind === "namedArg" ? a.value : a;
              const isDest = sem.destArg !== null && sem.destArg !== undefined &&
                i === sem.destArg && a && a.kind !== "namedArg";
              if (!val) return;
              const text = val.kind === "ref" ? val.path : (val.kind === "literal" ? val.value : null);
              const base = text !== null ? operandBase(text) : null;
              if (!base) return;
              const rd = reads.indexOf(i) !== -1;
              const n = tagNode(base, programName, rd, isDest, text);
              argNodes.push({ node: n, isDest: isDest });
            });
            const dest = argNodes.find(x => x.isDest);
            if (dest) argNodes.forEach(x => { if (!x.isDest) addEdge(x.node, dest.node, "data"); });
            break;
          }
          case "if":
            (s.branches || []).forEach(b => {
              if (b.cond) IR.walkExpr(b.cond, e => {
                if (e.kind === "ref") {
                  const base = operandBase(e.path);
                  if (base) tagNode(base, programName, true, false, e.path);
                }
              });
              handleStStmts(b.statements, programName);
            });
            break;
          case "for": case "while": case "repeat":
            if (s.cond) IR.walkExpr(s.cond, e => {
              if (e.kind === "ref") {
                const base = operandBase(e.path);
                if (base) tagNode(base, programName, true, false, e.path);
              }
            });
            handleStStmts(s.statements, programName);
            break;
          case "case":
            IR.walkExpr(s.expr, e => {
              if (e.kind === "ref") {
                const base = operandBase(e.path);
                if (base) tagNode(base, programName, true, false, e.path);
              }
            });
            (s.cases || []).forEach(c => handleStStmts(c.statements, programName));
            if (s.elseStatements) handleStStmts(s.elseStatements, programName);
            break;
          default: break;
        }
      }
    }

    for (const prog of model.programs || []) {
      for (const routine of prog.routines || []) {
        const content = routine.content || {};
        if (content.kind === "rll") {
          for (const rung of content.rungs || []) {
            let branch;
            try { branch = RLLP.parseRllRung(rung.text); }
            catch (e) { continue; } // tolerate broken rung text in tag web
            IR.walkInstrs(branch, instr => handleInstr(instr, prog.name));
          }
        } else if (content.kind === "st") {
          let st;
          try { st = STP.parseSt(content.text); }
          catch (e) { continue; }
          handleStStmts(st.statements, prog.name);
        }
      }
    }
    return graph;
  }

  return { buildRoutineDataflow: buildRoutineDataflow, buildTagWeb: buildTagWeb };
});
