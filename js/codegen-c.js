/* L5X Studio - codegen-c.js (T3). Ladder / ST / FBD -> C code generation.
   Modeled on alairjunior/l5x2c (rungyacc.py + plcmodel.template): the ladder neutral text
   is compiled to a boolean stack machine (clear/push/and/or/acc) and timers/counters use
   Rockwell semantics.  Output is a translation aid; unsupported instructions are reported, never dropped.

   Public API:
     generateC(model, opts) -> { files: { "<base>.h": string, "<base>.c": string },
                                 warnings: [{ routine, msg }],
                                 stats: { routines, unsupported, ... } }
     routineToC(ir, ctx)   -> { code, warnings }

   The generated program is a verification / porting artefact, not a cycle-accurate
   simulation: tag initial values are not imported from the L5K data and unsupported
   instructions are emitted as `/* TODO ... *\/` comments plus warnings (never dropped
   silently). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;
  const OP = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
  const STP = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;
  const FBDC = (typeof module !== "undefined" && module.exports) ? require("./fbd-convert.js") : root.L5XStudio;
  const LAD_SEM = IR.LAD_OP_SEMANTICS || {};

  /* ================================================================== *
   *  small text helpers
   * ================================================================== */

  const C_KEYWORDS = {
    auto: 1, break: 1, case: 1, char: 1, const: 1, continue: 1, default: 1, do: 1,
    double: 1, else: 1, enum: 1, extern: 1, float: 1, for: 1, goto: 1, if: 1,
    inline: 1, int: 1, long: 1, register: 1, restrict: 1, return: 1, short: 1,
    signed: 1, sizeof: 1, static: 1, struct: 1, switch: 1, typedef: 1, union: 1,
    unsigned: 1, void: 1, volatile: 1, while: 1, _Bool: 1, bool: 1, true: 1, false: 1,
    and: 1, or: 1, not: 1, xor: 1, bitand: 1, bitor: 1, compl: 1
  };

  function sanitizeCIdent(text) {
    let s = String(text === undefined || text === null ? "" : text).trim();
    s = s.replace(/[^A-Za-z0-9_]/g, "_");
    if (!s) s = "_";
    if (/^[0-9]/.test(s)) s = "_" + s;
    if (C_KEYWORDS[s]) s = s + "_";
    return s;
  }

  /* Index text -> identifier fragment (numeric indices keep their digits: NETS[0] -> __0). */
  function sanitizeIndexIdent(text) {
    const t = String(text === undefined || text === null ? "" : text).trim();
    if (/^\d+$/.test(t)) return t;
    const s = t.replace(/[^A-Za-z0-9_]/g, "_");
    if (!s) return "_";
    return /^[0-9]/.test(s) ? "_" + s : s;
  }

  /* Full operand path -> flat C identifier, e.g.
     NETS[0].ZPA[3].ZONE -> NETS__0__ZPA__3__ZONE.
     Used for opaque/synthesised declarations and for the mapping comments. */
  function tagPathToCIdent(operandText) {
    const p = OP.parseOperand(operandText);
    if (!p.baseTag) return sanitizeCIdent(operandText);
    let s = sanitizeCIdent(p.baseTag);
    for (const m of p.members) {
      if (m.name !== null && m.index !== null) s += "__" + sanitizeCIdent(m.name) + "__" + sanitizeIndexIdent(m.index);
      else if (m.name !== null) s += "__" + sanitizeCIdent(m.name);
      else if (m.bit) s += "__" + sanitizeIndexIdent(m.index);
      else s += "__" + sanitizeIndexIdent(m.index);
    }
    return s;
  }

  function cComment(text, indent) {
    const s = String(text === undefined || text === null ? "" : text)
      .replace(/\*\//g, "* /").replace(/\r\n|\r|\n/g, " ");
    return (indent || "") + "/* " + s + " */";
  }

  function indentLines(code, n) {
    const pad = "    ".repeat(n || 1);
    return String(code || "").split("\n").map(function (l) { return l ? pad + l : l; }).join("\n");
  }

  function padEnd(s, n) {
    s = String(s);
    return s.length >= n ? s : s + " ".repeat(n - s.length);
  }

  /* Split a text on a separator only at nesting depth 0 ([] () '' "" aware). */
  function splitTopLevel(text, sep) {
    const out = [];
    let cur = "", depth = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        cur += ch;
        if (ch === quote && text[i - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
      if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  /* ---- literals ---------------------------------------------------- */

  function parseBasedLiteral(text) {
    const m = String(text).trim().match(/^(2|8|16)#([0-9a-fA-F_]+)$/);
    if (!m) return null;
    const base = parseInt(m[1], 10);
    const digits = m[2].replace(/_/g, "");
    let value = 0;
    for (let i = 0; i < digits.length; i++) {
      const d = parseInt(digits[i], base);
      if (isNaN(d)) return null;
      value = value * base + d;
    }
    return value;
  }

  function parseTimeLiteral(text) {
    const m = String(text).trim().match(/^T#([0-9A-Za-z_.]+)$/i);
    if (!m) return null;
    const body = m[1].replace(/_/g, "");
    let total = 0, matched = false, rest = body;
    rest = rest.replace(/(\d+(?:\.\d+)?)(MS|US|D|H|M|S)/gi, function (all, num, unit) {
      matched = true;
      const u = unit.toUpperCase();
      const mult = u === "D" ? 86400000 : u === "H" ? 3600000 : u === "M" ? 60000 :
        u === "S" ? 1000 : u === "MS" ? 1 : 0.001;
      total += parseFloat(num) * mult;
      return "";
    });
    if (!matched || rest.trim() !== "") return null;
    return Math.round(total);
  }

  function cStringLiteral(text) {
    let s = String(text);
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") s = s.slice(1, -1);
    /* Logix $ escapes: $' -> ', $$ -> $, $xx -> char code (keep simple) */
    s = s.replace(/\$\$/g, "$").replace(/\$'/g, "'");
    s = s.replace(/\$([0-9A-Fa-f]{2})/g, function (all, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") out += "\\\\";
      else if (ch === '"') out += '\\"';
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
    }
    return out + '"';
  }

  /* Literal text -> C constant text (null when the operand is not a literal). */
  function cLiteral(text) {
    const t = String(text === undefined || text === null ? "" : text).trim();
    if (t === "" || t === "?") return null;
    if (/^(TRUE)$/i.test(t)) return "true";
    if (/^(FALSE)$/i.test(t)) return "false";
    const based = parseBasedLiteral(t);
    if (based !== null) {
      if (based >= 2147483648) return "(int32_t)0x" + based.toString(16).toUpperCase();
      if (based < 0) return "-" + Math.abs(based);
      return "0x" + based.toString(16).toUpperCase();
    }
    if (/^[+-]?\d+(_\d+)*$/.test(t)) return t.replace(/_/g, "");
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return t;
    const tm = parseTimeLiteral(t);
    if (tm !== null) return String(tm);
    if (/^'(?:[^']|'')*'$/.test(t)) return cStringLiteral(t);
    return null;
  }

  /* Literal text usable as a C integer expression, with a numeric fallback. */
  function literalAsNumber(text) {
    const lit = cLiteral(text);
    if (lit === null) return null;
    if (parseBasedLiteral(text) !== null) return lit;
    if (/^[+-]?\d+$/.test(lit)) return lit;
    if (parseTimeLiteral(text) !== null) return lit;
    return null;
  }

  /* ================================================================== *
   *  C type model (primitives, predefined Rockwell structs, UDTs)
   * ================================================================== */

  const C_PRIMITIVES = {
    BOOL: "bool", SINT: "int8_t", INT: "int16_t", DINT: "int32_t",
    LINT: "int64_t", REAL: "float", LREAL: "double"
  };

  /* Rockwell predefined (non-UDT) data types we can express as C structs. */
  const PREDEF_STRUCTS = [
    {
      name: "timer", dataType: "TIMER", runtimeDefined: true,
      fields: [["EN", "bool"], ["TT", "bool"], ["DN", "bool"], ["PRE", "int32_t"], ["ACC", "int32_t"]]
    },
    {
      name: "counter", dataType: "COUNTER", runtimeDefined: true,
      fields: [["CD", "bool"], ["CU", "bool"], ["DN", "bool"], ["OV", "bool"],
        ["UN", "bool"], ["PRE", "int32_t"], ["ACC", "int32_t"]]
    },
    {
      name: "control", dataType: "CONTROL",
      fields: [["EN", "bool"], ["EU", "bool"], ["DN", "bool"], ["EM", "bool"], ["ER", "bool"],
        ["UL", "bool"], ["IN", "bool"], ["FD", "bool"], ["LEN", "int32_t"], ["POS", "int32_t"]]
    },
    {
      name: "message", dataType: "MESSAGE",
      fields: [["REQ", "int32_t"], ["DN", "int32_t"], ["ER", "int32_t"], ["EN", "int32_t"],
        ["ST", "int32_t"], ["EW", "int32_t"], ["TO", "int32_t"], ["EN_CC", "int32_t"],
        ["REQ_LEN", "int32_t"], ["Instance", "int32_t"], ["Path", "int8_t", 256]]
    },
    {
      name: "string_t", dataType: "STRING",
      fields: [["LEN", "int32_t"], ["DATA", "int8_t", 82]]
    }
  ];

  const PREDEF_BY_TYPE = {};
  const PREDEF_MEMBERS = {};
  for (const p of PREDEF_STRUCTS) {
    PREDEF_BY_TYPE[p.dataType] = p.name;
    const m = {};
    for (const f of p.fields) m[f[0]] = { name: f[0], dataType: f[1], dimension: f[2] || 0 };
    PREDEF_MEMBERS[p.dataType] = m;
  }
  const RESERVED_TYPES = new Set(["bool", "int8_t", "int16_t", "int32_t", "int64_t",
    "float", "double", "timer", "counter", "control", "message", "string_t"]);

  function primitiveCType(typeName) {
    if (!typeName) return null;
    return C_PRIMITIVES[typeName] || null;
  }

  /* Build a registry of user data types from model.dataTypes.
     Returns { byName: Map(name -> {name, cName, members: [memberTree], deps}),
               order: [entry]  (dependencies first) }. */
  function buildUdtRegistry(model, warnings) {
    const byName = new Map();
    for (const dt of (model && model.dataTypes) || []) {
      if (!dt || !dt.name) continue;
      const members = [];
      for (const m of dt.members || []) {
        members.push({
          name: m.name || "",
          dataType: m.dataType || "",
          dimension: m.dimension || 0,
          children: m.children || null,
          description: m.description || null
        });
      }
      byName.set(dt.name, {
        name: dt.name, cName: null, members: members, deps: [], cyclic: false
      });
    }
    /* unique C type names */
    const used = new Set(RESERVED_TYPES);
    for (const name of Array.from(byName.keys()).sort()) {
      const e = byName.get(name);
      let c = sanitizeCIdent(name);
      if (used.has(c)) c = c + "_UDT";
      while (used.has(c)) c = c + "_";
      e.cName = c;
      used.add(c);
    }
    /* dependencies + topological order (recursive DFS, cycle tolerated) */
    for (const e of byName.values()) {
      const deps = [];
      for (const m of e.members) {
        if (!m.children && byName.has(m.dataType) && m.dataType !== e.name) deps.push(m.dataType);
        if (m.children) {
          for (const c of m.children) if (byName.has(c.dataType)) deps.push(c.dataType);
        }
      }
      e.deps = deps.filter(function (d, i) { return deps.indexOf(d) === i; });
    }
    const order = [];
    const state = {};
    function visit(name) {
      const e = byName.get(name);
      if (!e || state[name] === 2) return;
      if (state[name] === 1) { e.cyclic = true; return; }
      state[name] = 1;
      for (const d of e.deps) visit(d);
      state[name] = 2;
      order.push(e);
    }
    for (const name of byName.keys()) visit(name);
    return { byName: byName, order: order };
  }

  /* C type text for a Rockwell data type name (without array suffix). */
  function dataTypeToC(typeName, udts, warnings, contextText) {
    if (!typeName) {
      if (warnings) warnings.push("missing data type" + (contextText ? " for " + contextText : "") + "; using int32_t");
      return "int32_t";
    }
    if (C_PRIMITIVES[typeName]) return C_PRIMITIVES[typeName];
    if (PREDEF_BY_TYPE[typeName]) return PREDEF_BY_TYPE[typeName];
    if (udts && udts.byName.has(typeName)) return udts.byName.get(typeName).cName;
    if (warnings) {
      warnings.push("data type " + typeName + (contextText ? " (" + contextText + ")" : "") +
        " has no C mapping; declared as int32_t");
    }
    return "int32_t";
  }

  /* ================================================================== *
   *  stack-machine runtime header (ported from l5x2c/plcmodel.template)
   * ================================================================== */

  const RUNTIME_HEADER = [
    "#include <assert.h>",
    "#include <stdint.h>",
    "#include <stdbool.h>",
    "#include <math.h>",
    "#include <string.h>",
    "",
    "/***************************************************",
    " *              Stack control functions            *",
    " **************************************************/",
    "#ifndef STACK_SIZE",
    "#define STACK_SIZE 128",
    "#endif",
    "static bool stack[STACK_SIZE] = { false };",
    "static int top = 0;",
    "",
    "static bool acc(void) { return stack[top - 1]; }",
    "static void push(bool x) { assert(top < STACK_SIZE); stack[top++] = x; }",
    "static bool pop(void) { assert(top > 0); return stack[--top]; }",
    "static void and(void) { bool a = pop(); bool b = pop(); push(a && b); } /* l5x2c: rungyacc mapping */",
    "static void or(void) { bool a = pop(); bool b = pop(); push(a || b); }",
    "static void clear(void) { top = 0; }",
    "",
    "/***************************************************",
    " *                Model functions                  *",
    " **************************************************/",
    "static int get_scan_time(void) { return SCAN_TIME_MS; }",
    "",
    "/***************************************************",
    " *                Timer Structure                  *",
    " **************************************************/",
    "typedef struct timer {",
    "    bool EN;",
    "    bool TT;",
    "    bool DN;",
    "    int32_t PRE;",
    "    int32_t ACC;",
    "} timer;",
    "",
    "/***************************************************",
    " *                Timer Functions                  *",
    " **************************************************/",
    "/* Based on Rockwell's manual (ported from l5x2c plcmodel.template) */",
    "static void ton(bool enable, timer *t) {",
    "    if (!enable) {",
    "        t->DN = false;",
    "        t->ACC = 0;",
    "        t->TT = false;",
    "        t->EN = false;",
    "    } else {",
    "        t->TT = true;",
    "        if (t->DN) {",
    "            t->TT = false;",
    "            t->EN = true;",
    "            return;",
    "        } else if (!t->EN) {",
    "            t->EN = true;",
    "        } else {",
    "            t->ACC += get_scan_time();",
    "            if (t->ACC < 0) {",
    "                t->ACC = 2147483647;",
    "                t->TT = false;",
    "                t->DN = true;",
    "                t->EN = true;",
    "            } else if (t->ACC >= t->PRE) {",
    "                t->TT = false;",
    "                t->DN = true;",
    "                t->EN = true;",
    "            }",
    "        }",
    "    }",
    "}",
    "",
    "/* Based on Rockwell's manual (ported from l5x2c plcmodel.template) */",
    "static void tof(bool enable, timer *t) {",
    "    if (enable) {",
    "        t->DN = true;",
    "        t->ACC = 0;",
    "        t->TT = false;",
    "        t->EN = true;",
    "    } else {",
    "        t->TT = true;",
    "        if (!t->DN) {",
    "            t->TT = false;",
    "            t->EN = false;",
    "            return;",
    "        } else if (t->EN) {",
    "            t->EN = false;",
    "        } else {",
    "            t->ACC += get_scan_time();",
    "            if (t->ACC < 0) {",
    "                t->ACC = 2147483647;",
    "                t->TT = false;",
    "                t->DN = false;",
    "                t->EN = false;",
    "            } else if (t->ACC >= t->PRE) {",
    "                t->TT = false;",
    "                t->DN = false;",
    "                t->EN = false;",
    "            }",
    "        }",
    "    }",
    "}",
    "",
    "/* Retentive timer on: ACC and DN are retained while the rung is false.",
    "   Added in the spirit of the l5x2c template (RTO is not in the upstream file). */",
    "static void rto(bool enable, timer *t) {",
    "    if (enable) {",
    "        t->EN = true;",
    "        if (t->DN) {",
    "            t->TT = false;",
    "            return;",
    "        }",
    "        t->TT = true;",
    "        t->ACC += get_scan_time();",
    "        if (t->ACC < 0) {",
    "            t->ACC = 2147483647;",
    "            t->TT = false;",
    "            t->DN = true;",
    "        } else if (t->ACC >= t->PRE) {",
    "            t->TT = false;",
    "            t->DN = true;",
    "        }",
    "    } else {",
    "        t->EN = false;",
    "        t->TT = false;",
    "    }",
    "}",
    "",
    "/***************************************************",
    " *              Counter Structure                  *",
    " **************************************************/",
    "typedef struct counter {",
    "    bool CD;",
    "    bool CU;",
    "    bool DN;",
    "    bool OV;",
    "    bool UN;",
    "    int32_t PRE;",
    "    int32_t ACC;",
    "} counter;",
    "",
    "/***************************************************",
    " *              Counter Functions                  *",
    " **************************************************/",
    "/* Based on Rockwell's manual (ported from l5x2c plcmodel.template) */",
    "static void ctu(bool enable, counter *c) {",
    "    bool ov = false;",
    "    if (enable) {",
    "        if (!c->CU) {",
    "            c->CU = true;",
    "            if (c->ACC == 2147483647) ov = true;",
    "            c->ACC += 1;",
    "            if (ov) {",
    "                if (c->UN) {",
    "                    c->UN = false;",
    "                    c->OV = false;",
    "                } else {",
    "                    c->OV = true;",
    "                    return;",
    "                }",
    "            }",
    "        }",
    "        if (!c->UN && !c->OV) {",
    "            if (c->ACC < c->PRE) c->DN = false; else c->DN = true;",
    "        }",
    "    } else {",
    "        c->CU = false;",
    "        if (!c->UN && !c->OV) {",
    "            if (c->ACC < c->PRE) c->DN = false; else c->DN = true;",
    "        }",
    "    }",
    "}",
    "",
    "/* Count down, added in the spirit of the l5x2c template (not in the upstream file). */",
    "static void ctd(bool enable, counter *c) {",
    "    if (enable) {",
    "        if (!c->CD) {",
    "            c->CD = true;",
    "            if (!c->UN && !c->OV) {",
    "                if (c->ACC > (-2147483647 - 1)) {",
    "                    c->ACC -= 1;",
    "                } else {",
    "                    c->UN = true;",
    "                }",
    "            }",
    "        }",
    "        if (!c->UN && !c->OV) {",
    "            if (c->ACC <= c->PRE) c->DN = true; else c->DN = false;",
    "        }",
    "    } else {",
    "        c->CD = false;",
    "        if (!c->UN && !c->OV) {",
    "            if (c->ACC <= c->PRE) c->DN = true; else c->DN = false;",
    "        }",
    "    }",
    "}",
    "",
    "/***************************************************",
    " *              Reset Functions                    *",
    " **************************************************/",
    "/* RES instruction: reset the accumulator and status bits (Rockwell semantics).",
    "   obj is a `timer *` when is_counter == 0, else a `counter *`. */",
    "static void res(bool enable, void *obj, int is_counter) {",
    "    if (!enable || !obj) return;",
    "    if (is_counter) {",
    "        counter *c = (counter *)obj;",
    "        c->ACC = 0; c->DN = false; c->OV = false; c->UN = false;",
    "    } else {",
    "        timer *t = (timer *)obj;",
    "        t->ACC = 0; t->DN = false; t->TT = false;",
    "    }",
    "}",
    "",
    "/***************************************************",
    " *           Bit access helper macros              *",
    " **************************************************/",
    "/* Word/bit access used for I/O image operands such as Network1:I.Data[2].1 */",
    "#define BIT_GET(value, bit) (((value) >> (bit)) & 1)",
    "#define BIT_SET(lvalue, bit, value) \\",
    "    ((lvalue) = (int32_t)(((lvalue) & ~(1 << (bit))) | (((value) & 1) << (bit))))",
    "",
    "/* Rockwell STRING equality (whole-structure compare) */",
    "#define STRING_EQUAL(a, b) (memcmp(&(a), &(b), sizeof(string_t)) == 0)",
    ""
  ].join("\n");

  /* ================================================================== *
   *  project context (declarations + operand -> C mapping)
   * ================================================================== */

  const NON_TAG_ARGS = {
    JSR: [0], JMP: [0], LBL: [0], FOR: [0], NXT: [0],
    GSV: [0, 1, 2], SSV: [0, 1, 2]
  };

  const INPUT_CLASS = {
    XIC: 1, XIO: 1, ONS: 1, EQU: 1, NEQ: 1, GRT: 1, GEQ: 1, LES: 1, LEQ: 1,
    LIM: 1, MEQ: 1, CMP: 1, AFI: 1, NOP: 1
  };

  /* Rockwell neutral-text element types where the data type is known from context. */
  function dirFromModuleBase(baseTag) {
    const parts = String(baseTag).split(":");
    if (parts.length < 2) return null;
    const last = parts[parts.length - 1].toUpperCase();
    if (!/^[IOCS]$/.test(last)) return null;
    return { host: parts[0], slot: parts.length >= 3 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null, dir: last };
  }

  function findModuleForBase(model, baseTag) {
    const d = dirFromModuleBase(baseTag);
    if (!d) return null;
    if (d.host === "Local" && d.slot !== null) {
      for (const m of model.modules || []) {
        if (m.name === "Local" || m.parentModule !== "Local") continue;
        const up = (m.ports || []).find(function (p) { return p.upstream; });
        if (up && String(up.address) === String(d.slot)) return m;
      }
      return (model.modules || []).find(function (m) { return m.name === "Local"; }) || null;
    }
    return (model.modules || []).find(function (m) { return m.name === d.host; }) || null;
  }

  function moduleImageTree(model, module, dir) {
    if (!module) return null;
    if (dir === "I" && module.ioImages) return module.ioImages.input || null;
    if (dir === "O" && module.ioImages) return module.ioImages.output || null;
    if (dir === "C" && module.ioImages) return module.ioImages.config || null;
    if (dir === "S") {
      const conns = (module.communications && module.communications.connections) || [];
      const st = conns.find(function (c) { return /status/i.test(c.name || ""); }) ||
        conns.find(function (c) { return String(c.type || "").toLowerCase() === "input" && c.input; });
      return (st && st.input) || null;
    }
    return null;
  }

  function keyFor(scope, baseTag) { return String(scope || "") + "\u0000" + String(baseTag); }

  /* ---- raw-node helpers (plain nodes from js/xml.js) ----------------- */

  function rawElements(node, name) {
    if (!node || !node.children) return [];
    const out = [];
    for (const c of node.children) {
      if (c && c.type === "element" && (!name || c.name === name)) out.push(c);
    }
    return out;
  }
  function rawAttr(node, name) {
    return node && node.attrs ? node.attrs[name] : undefined;
  }

  /* Rockwell stores multi-dimensional array dimensions as "30 61" (or with commas).
     The project model only keeps the first dimension, so recover the full list from
     the raw plain nodes (read-only). */
  function collectRawDimensions(model) {
    const map = new Map();
    const ctrl = model && model.raw && model.raw.controllerNode;
    if (!ctrl) return map;
    function addTags(tagsNode, programName) {
      for (const t of rawElements(tagsNode, "Tag")) {
        const name = rawAttr(t, "Name");
        const dims = rawAttr(t, "Dimensions");
        if (!name || !dims) continue;
        const list = String(dims).trim().split(/[\s,]+/).map(function (s) { return parseInt(s, 10); })
          .filter(function (n) { return !isNaN(n) && n > 0; });
        if (list.length) map.set(String(programName || "") + "\u0000" + name, list);
      }
    }
    const ctrlTags = rawElements(ctrl, "Tags");
    if (ctrlTags.length) addTags(ctrlTags[0], null);
    for (const programs of rawElements(ctrl, "Programs")) {
      for (const p of rawElements(programs, "Program")) {
        const pname = rawAttr(p, "Name");
        const tags = rawElements(p, "Tags");
        if (tags.length) addTags(tags[0], pname);
      }
    }
    return map;
  }

  function createGen(model, opts) {
    const warnings = [];
    const udts = buildUdtRegistry(model, warnings);
    const gen = {
      model: model, opts: opts || {}, warnings: warnings, unsupported: 0,
      udts: udts,
      decls: new Map(), declOrder: [],
      typedefLines: [], typedefNames: new Set(), tagDefLines: [],
      aliasDefs: [], systemDefs: [],
      imageStructs: new Map(), synthStructs: new Map(),
      routineFns: new Map(),
      usedIdents: new Set(),
      finalized: false,
      currentRoutine: null
    };
    /* Identifiers that must not be reused for tags: C/runtime/predefined type names
       and all UDT type names (C puts typedef names in the ordinary namespace). */
    const RESERVED_IDENTS = ["acc", "push", "pop", "and", "or", "clear", "top", "stack",
      "ton", "tof", "rto", "ctu", "ctd", "res", "get_scan_time", "scan_delay", "main",
      "BIT_GET", "BIT_SET", "SCAN_TIME_MS", "STACK_SIZE", "first_scan", "spin",
      "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
      "bool", "true", "false", "float", "double", "timer", "counter", "control", "message",
      "string_t", "pow", "sqrt", "assert"];
    for (const id of RESERVED_IDENTS) gen.usedIdents.add(id);
    for (const e of udts.byName.values()) if (e.cName) gen.usedIdents.add(e.cName);

    gen.noteWarning = function (routine, msg) {
      warnings.push({ routine: routine || gen.currentRoutine || null, msg: String(msg) });
    };

    gen.rawDims = collectRawDimensions(model);

    gen.noteUnsupported = function (env, instr, rungNumber) {
      gen.unsupported++;
      const args = (instr.args || []).map(function (x) { return x === undefined ? "?" : x; }).join(",");
      gen.noteWarning(env.routine, "unsupported instruction " + instr.op + "(" + args + ") in rung " +
        rungNumber + " of " + env.routine + "; emitted as TODO comment");
    };

    /* IR codegen entry points (assigned here; the functions are hoisted module-wide) */
    gen.ladRungToC = ladRungToC;
    gen.ladIRToC = ladIRToC;
    gen.stIRToC = stIRToC;

    /* ---------------- declarations ---------------- */

    function addTypedef(name, text) {
      if (gen.typedefNames.has(name)) return name;
      gen.typedefNames.add(name);
      gen.typedefLines.push(text);
      return name;
    }

    function allocIdent(base, programName, isProgramTag) {
      const plain = sanitizeCIdent(base);
      const prefixed = isProgramTag && programName
        ? sanitizeCIdent(programName) + "__" + plain : plain;
      let candidate = prefixed;
      if (!gen.usedIdents.has(candidate)) { gen.usedIdents.add(candidate); return candidate; }
      /* collision with a type/runtime/tag identifier: qualify or suffix */
      if (!isProgramTag && programName) {
        candidate = sanitizeCIdent(programName) + "__" + plain;
        if (!gen.usedIdents.has(candidate)) { gen.usedIdents.add(candidate); return candidate; }
      }
      let suffix = "_TAG", i = 2;
      while (gen.usedIdents.has(candidate + suffix)) suffix = "_TAG" + i++;
      candidate = candidate + suffix;
      gen.usedIdents.add(candidate);
      return candidate;
    }

    /* Register one operand reference and create its declaration lazily. */
    gen.registerRef = function (operandText, programName) {
      const text = String(operandText === undefined || operandText === null ? "" : operandText).trim();
      if (!text || text === "?") return null;
      if (OP.isLiteral(text)) return null;
      const p = OP.parseOperand(text);
      if (!p.baseTag) return null;
      const base = p.baseTag;
      /* system tag */
      if (/^S:/.test(base)) {
        const scope = "system";
        const key = keyFor(scope, base);
        if (gen.decls.has(key)) return gen.decls.get(key);
        const d = {
          kind: "system", baseTag: base, original: base, program: null,
          ident: "S__" + sanitizeCIdent(base.slice(2) || "TAG"),
          dataType: base === "S:FS" ? "BOOL" : "DINT", dimension: 0, cType: base === "S:FS" ? "bool" : "int32_t",
          members: null, record: null
        };
        if (gen.usedIdents.has(d.ident)) d.ident = d.ident + "_" + gen.decls.size;
        gen.usedIdents.add(d.ident);
        d.late = !!gen.finalized;
        gen.decls.set(key, d); gen.declOrder.push({ key: key, decl: d });
        return d;
      }
      /* module I/O tag */
      if (dirFromModuleBase(base)) {
        const key = keyFor("module", base);
        if (gen.decls.has(key)) {
          const existing = gen.decls.get(key);
          existing.paths.push(p.members);
          return existing;
        }
        const mod = findModuleForBase(model, base);
        const tree = moduleImageTree(model, mod, dirFromModuleBase(base).dir);
        const d = {
          kind: "module", baseTag: base, original: base, program: null, module: mod,
          imageTree: tree, imageDir: dirFromModuleBase(base).dir,
          ident: allocIdent(base, null, false),
          dataType: tree ? tree.dataType : null, dimension: 0,
          cType: null, members: null, record: null,
          paths: [p.members], built: false, late: !!gen.finalized
        };
        gen.decls.set(key, d); gen.declOrder.push({ key: key, decl: d });
        return d;
      }
      /* regular tag: program scope first, then controller */
      let record = null, scopeProgram = null;
      const pTags = (model.tags && model.tags.programs && model.tags.programs[programName]) || [];
      record = pTags.find(function (t) { return t.name === base; }) || null;
      if (record) scopeProgram = programName;
      if (!record) {
        record = ((model.tags && model.tags.controller) || []).find(function (t) { return t.name === base; }) || null;
      }
      const scope = record && record.program ? "program:" + record.program : (record ? "controller" : "implicit:" + (programName || ""));
      const key = keyFor(scope, base);
      if (gen.decls.has(key)) {
        const existing = gen.decls.get(key);
        /* record additional member paths for opaque/synthesised struct generation */
        if (!existing.built && existing.paths) existing.paths.push(p.members);
        return existing;
      }
      const isProgramTag = !!(record && record.program);
      const d = {
        kind: record ? (record.aliasFor || record.tagType === "Alias" ? "alias" : "tag") : "implicit",
        baseTag: base, original: base, program: record ? record.program : scopeProgram,
        ident: allocIdent(base, record ? record.program : scopeProgram, isProgramTag),
        dataType: record ? record.dataType : "", dimension: record ? record.dimension || 0 : 0,
        cType: null, members: null, record: record,
        paths: [p.members], built: false, late: !!gen.finalized
      };
      if (record) {
        d.rawDimList = gen.rawDims.get(String(record.program || "") + "\u0000" + record.name) ||
          gen.rawDims.get("\u0000" + record.name) || null;
      }
      if (!record) gen.noteWarning(null, "undeclared tag " + base + " referenced" + (programName ? " in program " + programName : "") + "; declared implicitly");
      gen.decls.set(key, d); gen.declOrder.push({ key: key, decl: d });
      return d;
    };

    /* member lookup on a declaration's type: returns {memberTree|null, typeName} */
    function memberDef(decl, memberName) {
      if (!decl) return null;
      if (decl.kind === "module") {
        const tree = decl.imageTree || decl.synthTree;
        if (tree && tree.children) {
          const c = tree.children.find(function (x) { return x.name === memberName; });
          if (c) return { dataType: c.dataType, dimension: c.dimension || 0, children: c.children || null };
          return null;
        }
        /* synthesised opaque structure: members were inferred from the referenced paths */
        if (decl.synthName) return { dataType: null, dimension: 0, children: null, synth: true };
        return null;
      }
      const dtName = decl.dataType;
      if (PREDEF_MEMBERS[dtName]) {
        const m = PREDEF_MEMBERS[dtName][memberName];
        if (m) return { dataType: m.dataType, dimension: m.dimension || 0, children: null };
        return null;
      }
      if (gen.udts.byName.has(dtName)) {
        const e = gen.udts.byName.get(dtName);
        const m = e.members.find(function (x) { return x.name === memberName; });
        if (m) return { dataType: m.dataType, dimension: m.dimension || 0, children: m.children };
      }
      if (decl.synthName) return { dataType: null, dimension: 0, children: null, synth: true };
      return null;
    }

    /* C expression for an array index text (numeric literal or a tag expression). */
    gen.indexToC = function (env, indexText) {
      const t = String(indexText === undefined || indexText === null ? "0" : indexText).trim();
      const lit = literalAsNumber(t);
      if (lit !== null) return lit;
      let expr = null;
      try { expr = STP.parseStExpression(t); } catch (e) { expr = null; }
      if (expr) return gen.exprToC(env, expr, null);
      /* last resort: treat the whole index text as a tag reference */
      const code = gen.operandToC(env, t, "read");
      if (code) return code;
      env.warn("could not translate array index '" + t + "'; using 0");
      return "0";
    };

    /* Multidimensional subscripts: L5X writes TAG[a,b] for TAG[a][b]. */
    gen.indexSuffixToC = function (env, indexText) {
      const text = String(indexText === undefined || indexText === null ? "0" : indexText).trim();
      const parts = splitTopLevel(text, ",");
      if (parts.length > 1) {
        return parts.map(function (p) { return "[" + gen.indexToC(env, p) + "]"; }).join("");
      }
      return "[" + gen.indexToC(env, text) + "]";
    };

    /* Build a C member-access expression for `base` + members.
       Returns { code, lastBit, lvalueCode } (lvalueCode set when the expression is assignable). */
    gen.accessExpr = function (env, operandText, role) {
      const p = OP.parseOperand(operandText);
      const decl = gen.registerRef(operandText, env.program);
      if (!decl) return null;
      if (decl.late) {
        env.warnOnce("late:" + decl.baseTag, "operand " + decl.baseTag +
          " was not seen while collecting declarations; emitted as TODO");
        return null;
      }
      if (decl.kind === "alias") {
        return { code: decl.ident, lastBit: null, lvalueCode: decl.ident };
      }
      let code = decl.ident;
      let current = decl;
      let lastBit = null;
      let lvalue = decl.ident;
      for (let i = 0; i < p.members.length; i++) {
        const m = p.members[i];
        if (m.name === "" && m.index === null) {
          /* L5X bit syntax: TAG.[BIT_TAG] / TAG.[5] (member name is empty) */
          const next = p.members[i + 1];
          if (next && next.name === null) {
            lastBit = gen.indexToC(env, next.index);
            code = "BIT_GET(" + lvalue + ", " + lastBit + ")";
            i++;
            continue;
          }
          continue; /* stray '.' - ignore */
        }
        if (m.name !== null && m.index !== null) {
          const def = memberDef(current, m.name);
          code += "." + sanitizeCIdent(m.name);
          lvalue = code;
          if (def) current = def;
          code += gen.indexSuffixToC(env, m.index);
          lvalue = code;
          lastBit = null;
        } else if (m.name !== null) {
          const def = memberDef(current, m.name);
          if (!def && !(current && current.synth)) {
            env.warnOnce("member " + m.name + " not found on " +
              (current.dataType || (current.baseTag || "type")) + " (emitted as ." + sanitizeCIdent(m.name) + ")");
          }
          code += "." + sanitizeCIdent(m.name);
          lvalue = code;
          if (def) current = def;
          lastBit = null;
        } else if (m.bit) {
          lastBit = m.index;
          code = "BIT_GET(" + lvalue + ", " + gen.indexToC(env, m.index) + ")";
        } else {
          /* array index on the current value */
          code += gen.indexSuffixToC(env, m.index);
          lvalue = code;
          lastBit = null;
        }
      }
      return { code: code, lastBit: lastBit, lvalueCode: lvalue };
    };

    gen.operandToC = function (env, operandText, role) {
      const text = String(operandText === undefined || operandText === null ? "" : operandText).trim();
      if (!text || text === "?") return null;
      const lit = cLiteral(text);
      /* cLiteral returns null for non-literals; but "TRUE"/time/etc are literals */
      if (lit !== null && OP.isLiteral(text)) return lit;
      if (OP.isLiteral(text)) {
        env.warn("literal '" + text + "' has no C constant mapping; emitted as 0");
        return "0";
      }
      const acc = gen.accessExpr(env, text, role);
      if (!acc) return null;
      return acc.code;
    };

    /* Lvalue C expression (no bit access); null when not assignable. */
    gen.lvalueToC = function (env, operandText) {
      const acc = gen.accessExpr(env, operandText, "write");
      if (!acc) return null;
      if (acc.lastBit !== null) return null;
      return acc.lvalueCode;
    };

    /* Produce a C statement assigning `valueCode` to the operand (handles bit targets). */
    gen.assignStmt = function (env, operandText, valueCode, trailingSemi) {
      const semicolon = trailingSemi === false ? "" : ";";
      const acc = gen.accessExpr(env, operandText, "write");
      if (!acc) return null;
      if (acc.lastBit !== null) {
        return "BIT_SET(" + acc.lvalueCode + ", " + acc.lastBit + ", " + valueCode + ")" + semicolon;
      }
      /* compact rungyacc-style assignment: "TAG=acc();" */
      return acc.lvalueCode + "=" + valueCode + semicolon;
    };

    /* Type name of an operand (for boolean/integer operator choices). */
    gen.typeOfOperand = function (operandText, programName) {
      const text = String(operandText || "").trim();
      if (!text || text === "?") return null;
      const p = OP.parseOperand(text);
      if (p.isLiteral) {
        if (p.literalType === "bool") return "BOOL";
        if (p.literalType === "int") return "DINT";
        if (p.literalType === "float") return "REAL";
        return null;
      }
      let decl = null;
      if (gen.finalized) {
        /* do not create declarations during code emission; look up only */
        decl = gen.findDecl(text, programName);
      } else {
        try { decl = gen.registerRef(text, programName); } catch (e) { decl = null; }
      }
      if (!decl) return null;
      let typeName = decl.dataType;
      let current = decl;
      for (let i = 0; i < p.members.length; i++) {
        const m = p.members[i];
        if (m.name === "" && m.index === null) {
          const next = p.members[i + 1];
          if (next && next.name === null) { typeName = "BOOL"; i++; }
          continue;
        }
        if (m.bit) typeName = "BOOL";
        else if (m.name !== null) {
          const def = memberDef(current, m.name);
          if (def) { typeName = def.dataType; current = def; }
          else typeName = null;
        }
      }
      if (!typeName && decl.kind === "module") {
        /* bit access on an image word is BOOL; otherwise unknown */
        let bit = false;
        for (const m of p.members) if (m.bit) bit = true;
        if (bit) return "BOOL";
      }
      if (typeName === "BIT") return "BOOL";
      return typeName;
    };

    /* Look up an already registered declaration without creating one. */
    gen.findDecl = function (operandText, programName) {
      const p = OP.parseOperand(operandText);
      const base = p.baseTag;
      if (!base) return null;
      if (/^S:/.test(base)) return gen.decls.get(keyFor("system", base)) || null;
      if (dirFromModuleBase(base)) return gen.decls.get(keyFor("module", base)) || null;
      const pTags = (model.tags && model.tags.programs && model.tags.programs[programName]) || [];
      const programRecord = pTags.find(function (t) { return t.name === base; });
      if (programRecord) return gen.decls.get(keyFor("program:" + programName, base)) || null;
      const ctrlRecord = ((model.tags && model.tags.controller) || []).find(function (t) { return t.name === base; });
      if (ctrlRecord) return gen.decls.get(keyFor("controller", base)) || null;
      return gen.decls.get(keyFor("implicit:" + (programName || ""), base)) || null;
    };

    /* ---------------- structs ---------------- */

    function emitStructBody(fields, structName) {
      const lines = ["typedef struct " + structName + " {"];
      for (const f of fields) {
        lines.push("    " + f.type + " " + f.name + (f.array ? "[" + f.array + "]" : "") + ";" +
          (f.comment ? " /* " + f.comment + " */" : ""));
      }
      lines.push("} " + structName + ";");
      return lines.join("\n");
    }

    function imageFieldType(node, decl) {
      const kids = node.children || [];
      if (kids.length) return null; /* nested struct handled by caller */
      const localWarnings = [];
      const c = dataTypeToC(node.dataType, gen.udts, localWarnings, node.name || "module member");
      for (const w of localWarnings) {
        gen.noteWarning(decl.program, "module image " + decl.baseTag + ": " + w);
      }
      return c || "int32_t";
    }

    /* Build a struct typedef for a module image tree. Returns the struct type name,
       or null when the tree has no usable member information. */
    function buildImageStruct(decl) {
      const tree = decl.imageTree;
      if (!tree) return null;
      const baseName = "MOD_" + sanitizeCIdent(decl.baseTag);
      function emitNode(node, typeName) {
        const kids = node.children || [];
        if (!kids.length) return null;
        const fields = [];
        for (const child of kids) {
          const childName = sanitizeCIdent(child.name || "member");
          const nestedName = typeName + "__" + childName;
          const nested = emitNode(child, nestedName);
          if (nested) {
            fields.push({ type: nested, name: childName, comment: child.dataType || null });
          } else {
            const ctype = imageFieldType(child, decl);
            const count = child.elements ? child.elements.length : (child.dimension || 0);
            fields.push({
              type: ctype, name: childName, array: count > 0 ? count : 0,
              comment: (child.dataType || "") + (count > 0 ? "[" + count + "]" : "")
            });
          }
        }
        addTypedef(typeName, emitStructBody(fields, typeName));
        return typeName;
      }
      const rootName = emitNode(tree, baseName);
      return rootName;
    }

    /* Synthesise a struct from the member paths referenced for an opaque module/type. */
    function buildSynthStruct(decl, baseName) {
      const root = { fields: new Map(), indexSeen: 0 };
      function ensureChild(node) {
        if (!node.child) node.child = { fields: new Map(), indexSeen: 0 };
        return node.child;
      }
      function recordArray(node, indexText) {
        const num = parseInt(String(indexText).replace(/[^0-9]/g, ""), 10);
        node.indexSeen = Math.max(node.indexSeen, isNaN(num) ? 64 : num + 1);
      }
      function ensureField(node, name) {
        let f = node.fields.get(name);
        if (!f) {
          f = { name: name, child: null, kind: "scalar", indexSeen: 0 };
          node.fields.set(name, f);
        }
        return f;
      }
      for (const memberPath of decl.paths || []) {
        let node = root;
        for (let i = 0; i < memberPath.length; i++) {
          const m = memberPath[i];
          const last = i === memberPath.length - 1;
          if (m.bit) break; /* bit access works on the parent word */
          if (m.name !== null && m.index !== null) {
            const f = ensureField(node, sanitizeCIdent(m.name));
            f.kind = "array";
            recordArray(f, m.index);
            if (last) break;
            node = ensureChild(f);
            continue;
          }
          if (m.name !== null) {
            const f = ensureField(node, sanitizeCIdent(m.name));
            /* NAME[index] where what follows is only bits/indices -> a word array
               (typical I/O image layout: Data[2], Data[3].0) */
            const next = memberPath[i + 1];
            if (next && next.name === null && !next.bit) {
              let j = i + 2;
              while (j < memberPath.length && (memberPath[j].bit || memberPath[j].name === null)) j++;
              if (j >= memberPath.length) {
                recordArray(f, next.index);
                f.kind = "array";
                break;
              }
            }
            if (last) {
              f.kind = "scalar";
              break;
            }
            f.kind = "struct";
            node = ensureChild(f);
            continue;
          }
          /* index-only: applies to the node reached so far */
          recordArray(node, m.index);
        }
      }
      function emitNode(node, typeName) {
        const fields = [];
        for (const f of Array.from(node.fields.values())) {
          if (f.child) {
            const childType = typeName + "__" + f.name;
            emitNode(f.child, childType);
            const arrLen = Math.max(f.indexSeen, f.child.indexSeen);
            fields.push({ type: childType, name: f.name, array: arrLen > 0 ? arrLen : 0 });
          } else {
            fields.push({ type: "int32_t", name: f.name, array: f.indexSeen > 0 ? f.indexSeen : 0 });
          }
        }
        if (!fields.length) {
          fields.push({ type: "uint8_t", name: "_reserved", array: 8, comment: "opaque storage" });
        }
        addTypedef(typeName, emitStructBody(fields, typeName));
        return typeName;
      }
      let name = baseName;
      while (gen.typedefNames.has(name)) name = name + "_";
      emitNode(root, name);
      return { type: name, array: root.indexSeen > 0 ? root.indexSeen : 0 };
    }

    /* ---------------- finalise declarations ---------------- */

    /* Full C declarator dimension suffix, e.g. "[30][61]". */
    function dimSuffix(d) {
      if (d.dimList && d.dimList.length) {
        return d.dimList.map(function (n) { return "[" + n + "]"; }).join("");
      }
      return d.dimension > 0 ? "[" + d.dimension + "]" : "";
    }

    function finalizeDecl(d) {
      if (d.built) return;
      d.built = true;
      if (d.kind === "module") {
        let imageType = null;
        if (d.imageTree && d.imageTree.children && d.imageTree.children.length) {
          imageType = buildImageStruct(d);
        }
        if (!imageType) {
          const synth = buildSynthStruct(d, "IMG_" + sanitizeCIdent(d.baseTag));
          d.cType = synth.type;
          d.dimension = synth.array || 0;
          d.synthName = synth.type;
          gen.noteWarning(d.program, "module I/O image for " + d.baseTag +
            " has no member metadata; synthesised opaque structure " + synth.type +
            " from the referenced member paths (field types guessed as int32_t)");
        } else {
          d.cType = imageType;
        }
      } else if (d.kind === "alias") {
        d.cType = null; /* macro emitted below */
      } else if (d.kind === "system") {
        d.cType = d.dataType === "BOOL" ? "bool" : "int32_t";
      } else if (d.kind === "implicit") {
        const synth = buildSynthStruct(d, "IMPL_" + sanitizeCIdent(d.baseTag));
        d.cType = synth.type;
        d.dimension = synth.array || 0;
        d.synthName = synth.type;
      } else {
        const known = primitiveCType(d.dataType) || PREDEF_BY_TYPE[d.dataType] ||
          (gen.udts.byName.has(d.dataType) ? gen.udts.byName.get(d.dataType).cName : null);
        if (!known) {
          const synth = buildSynthStruct(d, "OPAQUE_" + sanitizeCIdent(d.dataType || d.baseTag));
          d.cType = synth.type;
          d.dimension = d.dimension || synth.array || 0;
          d.synthName = synth.type;
          gen.noteWarning(d.program, "tag " + d.baseTag + " has data type '" + d.dataType +
            "' with no C mapping; synthesised opaque structure " + synth.type);
        } else {
          d.cType = known;
        }
        if (d.rawDimList && d.rawDimList.length) d.dimList = d.rawDimList;
      }
      if (!d.dimList) d.dimList = d.dimension > 0 ? [d.dimension] : [];
    }

    function finalizePending() {
      /* decls can be added while finalising aliases (alias targets); loop until stable */
      for (let i = 0; i < gen.declOrder.length; i++) finalizeDecl(gen.declOrder[i].decl);
    }

    gen.buildDeclarations = function () {
      /* 1. user data types (dependencies first) */
      for (const e of gen.udts.order) {
        const fields = [];
        const fieldNames = new Set();
        for (const m of e.members) {
          let name = sanitizeCIdent(m.name);
          while (fieldNames.has(name)) name = name + "_";
          fieldNames.add(name);
          let ctype;
          const dim = m.dimension || 0;
          const memberWarnings = [];
          if (m.children && m.children.length) {
            /* inline nested structure (rare for UDT definitions) */
            const inlineName = e.cName + "__" + name;
            const nestedFields = m.children.map(function (c) {
              const cc = dataTypeToC(c.dataType, gen.udts, memberWarnings, e.name + "." + name + "." + c.name);
              return { type: cc, name: sanitizeCIdent(c.name), array: c.dimension || 0 };
            });
            addTypedef(inlineName, emitStructBody(nestedFields, inlineName));
            ctype = inlineName;
          } else if (m.dataType === "BIT") {
            ctype = "bool"; /* Rockwell BIT members are declared as standalone bools */
          } else {
            ctype = dataTypeToC(m.dataType, gen.udts, memberWarnings, e.name + "." + m.name);
          }
          for (const w of memberWarnings) gen.noteWarning(null, "UDT " + e.name + ": " + w);
          fields.push({ type: ctype, name: name, array: dim > 0 ? dim : 0 });
        }
        addTypedef(e.cName, emitStructBody(fields, e.cName));
      }

      /* 2. module image / synthesised structures + tag declarations */
      finalizePending();

      /* 3. aliases (macros); registering alias targets may add new declarations */
      for (let i = 0; i < gen.declOrder.length; i++) {
        const d = gen.declOrder[i].decl;
        if (d.kind !== "alias") continue;
        const targetText = d.record && d.record.aliasFor;
        if (!targetText) {
          gen.noteWarning(d.program, "alias " + d.baseTag + " has no AliasFor target; declared as int32_t");
          d.cType = "int32_t"; d.dimension = 0; d.aliasFallback = true;
          continue;
        }
        const p = OP.parseOperand(targetText);
        const hasBit = p.members.some(function (m) { return m.bit; });
        const targetDecl = gen.registerRef(targetText, d.program);
        if (!targetDecl || hasBit) {
          const t = targetDecl && targetDecl.dataType
            ? dataTypeToC(targetDecl.dataType, gen.udts, null, d.baseTag) : "int32_t";
          d.cType = t;
          d.dimension = targetDecl ? targetDecl.dimension || 0 : 0;
          d.dimList = targetDecl ? (targetDecl.dimList || []) : [];
          gen.noteWarning(d.program, "alias " + d.baseTag + " target " + targetText +
            " is not a simple lvalue; declared as a separate " + t);
          continue;
        }
        /* build the target expression without env warnings */
        const fakeEnv = {
          program: d.program, routine: null,
          warn: function () {}, warnOnce: function () {}
        };
        const code = gen.operandToC(fakeEnv, targetText, "read");
        if (!code) { d.cType = "int32_t"; d.dimension = 0; d.aliasFallback = true; continue; }
        d.aliasMacro = code;
      }

      /* finalise any declarations registered while resolving aliases */
      finalizePending();
      gen.finalized = true;

      /* 4. tag declaration text (extern in .h, definition in .c) */
      for (const entry of gen.declOrder) {
        const d = entry.decl;
        if (d.kind === "alias") {
          if (d.aliasMacro) {
            gen.aliasDefs.push("#define " + d.ident + " (" + d.aliasMacro + ") /* AliasFor " + d.record.aliasFor + " */");
            continue;
          }
          if (!d.cType) d.cType = "int32_t";
        }
        const comment = "/* " + d.original + (d.dataType ? " : " + d.dataType : "") +
          (d.program ? " (program " + d.program + ")" : "") + " */";
        gen.tagDefLines.push("extern " + d.cType + " " + d.ident + dimSuffix(d) + "; " + comment);
        d.definitionLine = d.cType + " " + d.ident + dimSuffix(d) + "; " + comment;
      }
      return gen;
    };

    gen.requireDefinitions = function () {
      const defs = [];
      for (const entry of gen.declOrder) {
        const d = entry.decl;
        if (d.kind === "alias" && d.aliasMacro) continue;
        if (d.definitionLine) defs.push(d.definitionLine);
      }
      return defs;
    };

    /* ---------------- expression codegen (ST expressions) ---------------- */

    function exprType(env, e) {
      if (!e) return null;
      switch (e.kind) {
        case "literal": {
          const lit = String(e.value || "");
          if (/^(TRUE|FALSE)$/i.test(lit)) return "BOOL";
          if (/^'/.test(lit)) return "STRING";
          const n = cLiteral(lit);
          if (n === null) return null;
          if (parseTimeLiteral(lit) !== null) return "DINT";
          if (parseBasedLiteral(lit) !== null) return "DINT";
          if (/\./.test(lit)) return "REAL";
          return "DINT";
        }
        case "ref":
          return gen.typeOfOperand(e.path, env.program);
        case "paren":
          return exprType(env, e.inner);
        case "unary":
          if (e.op === "NOT") return "BOOL";
          return exprType(env, e.operand);
        case "binary": {
          const op = e.op;
          if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") return "BOOL";
          const l = exprType(env, e.left), r = exprType(env, e.right);
          if (op === "AND" || op === "OR" || op === "XOR") {
            if (l === "BOOL" || r === "BOOL" || l === null || r === null) return "BOOL";
            return l;
          }
          if (l === "BOOL" || r === "BOOL") return "BOOL";
          if (l === "REAL" || r === "REAL") return "REAL";
          return "DINT";
        }
        case "call":
          return null;
        default:
          return null;
      }
    }
    gen.exprType = exprType;

    function isBoolType(t) { return t === "BOOL"; }
    function isFloatType(t) { return t === "REAL" || t === "LREAL"; }

    gen.exprToC = function (env, e, hintType) {
      if (!e) return "0";
      switch (e.kind) {
        case "literal": {
          const code = cLiteral(e.value);
          if (code === null) {
            env.warn("literal '" + e.value + "' has no C mapping; emitted as 0");
            return "0";
          }
          return code;
        }
        case "ref": {
          const code = gen.operandToC(env, e.path, "read");
          if (code === null) {
            env.warn("could not translate operand '" + e.path + "'; emitted as 0");
            return "0";
          }
          return code;
        }
        case "paren": return "(" + gen.exprToC(env, e.inner, hintType) + ")";
        case "unary": {
          const t = e.op === "NOT" ? "BOOL" : exprType(env, e.operand);
          const inner = gen.exprToC(env, e.operand, t);
          if (e.op === "NOT") return isBoolType(t) || t === null ? "(!(" + inner + "))" : "(~(" + inner + "))";
          return "(" + (e.op === "-" ? "-" : "+") + "(" + inner + "))";
        }
        case "binary": {
          const lt = exprType(env, e.left), rt = exprType(env, e.right);
          const l = gen.exprToC(env, e.left, lt);
          const r = gen.exprToC(env, e.right, rt);
          const bool = isBoolType(lt) || isBoolType(rt);
          if (lt === "STRING" || rt === "STRING") {
            if (e.op === "=") return "(STRING_EQUAL(" + l + ", " + r + "))";
            if (e.op === "<>") return "(!STRING_EQUAL(" + l + ", " + r + "))";
            env.warn("relational comparison of STRING values has no C mapping; emitted as false");
            return "false";
          }
          switch (e.op) {
            case "AND": return bool ? "((" + l + ") && (" + r + "))" : "((" + l + ") & (" + r + "))";
            case "OR": return bool ? "((" + l + ") || (" + r + "))" : "((" + l + ") | (" + r + "))";
            case "XOR": return bool ? "((" + l + ") != (" + r + "))" : "((" + l + ") ^ (" + r + "))";
            case "&": return "((" + l + ") & (" + r + "))";
            case "=": return "((" + l + ") == (" + r + "))";
            case "<>": return "((" + l + ") != (" + r + "))";
            case "<": return "((" + l + ") < (" + r + "))";
            case ">": return "((" + l + ") > (" + r + "))";
            case "<=": return "((" + l + ") <= (" + r + "))";
            case ">=": return "((" + l + ") >= (" + r + "))";
            case "+": return "((" + l + ") + (" + r + "))";
            case "-": return "((" + l + ") - (" + r + "))";
            case "*": return "((" + l + ") * (" + r + "))";
            case "/": return "((" + l + ") / (" + r + "))";
            case "MOD": return "((" + l + ") %% (" + r + "))".replace("%%", "%");
            case "**": return "(pow((double)(" + l + "), (double)(" + r + ")))";
            default:
              env.warn("ST operator '" + e.op + "' has no C mapping; emitted as 0");
              return "0";
          }
        }
        case "call": {
          const fn = sanitizeCIdent(e.fn);
          const args = [];
          for (const a of e.args || []) {
            if (a && a.kind === "namedArg") {
              env.warn("named argument " + a.name + " has no C equivalent; passed positionally");
              args.push(gen.exprToC(env, a.value, null));
            } else {
              args.push(gen.exprToC(env, a, null));
            }
          }
          return fn + "(" + args.join(", ") + ")";
        }
        case "namedArg":
          return gen.exprToC(env, e.value, null);
        default:
          env.warn("ST expression kind '" + e.kind + "' has no C mapping; emitted as 0");
          return "0";
      }
    };

    return gen;
  }

  /* ================================================================== *
   *  standalone gen (routineToC without a project model)
   * ================================================================== */

  function structuralOperandToC(env, operandText) {
    const text = String(operandText === undefined || operandText === null ? "" : operandText).trim();
    if (!text || text === "?") return null;
    if (OP.isLiteral(text)) {
      const lit = cLiteral(text);
      return lit;
    }
    const p = OP.parseOperand(text);
    if (!p.baseTag) return null;
    let code = sanitizeCIdent(p.baseTag);
    let lvalue = code;
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      if (m.name === "" && m.index === null) {
        const next = p.members[i + 1];
        if (next && next.name === null) {
          code = "BIT_GET(" + lvalue + ", " + structuralIndexToC(env, next.index) + ")";
          i++;
        }
        continue;
      }
      if (m.name !== null && m.index !== null) {
        code += "." + sanitizeCIdent(m.name);
        lvalue = code;
        code += "[" + structuralIndexToC(env, m.index) + "]";
        lvalue = code;
      } else if (m.name !== null) {
        code += "." + sanitizeCIdent(m.name);
        lvalue = code;
      } else if (m.bit) {
        code = "BIT_GET(" + lvalue + ", " + structuralIndexToC(env, m.index) + ")";
      } else {
        code += "[" + structuralIndexToC(env, m.index) + "]";
        lvalue = code;
      }
    }
    return code;
  }
  function structuralIndexToC(env, indexText) {
    const lit = literalAsNumber(indexText);
    if (lit !== null) return lit;
    try {
      return new StandaloneGen().exprToC(env, STP.parseStExpression(String(indexText)), null);
    } catch (e) {
      return sanitizeCIdent(indexText);
    }
  }

  function StandaloneGen() {
    this.model = null;
    this.opts = {};
  }
  StandaloneGen.prototype.operandToC = function (env, text) {
    return structuralOperandToC(env, text);
  };
  StandaloneGen.prototype.lvalueToC = function (env, text) {
    const p = OP.parseOperand(String(text || ""));
    if (!p.baseTag) return null;
    let code = sanitizeCIdent(p.baseTag);
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      if (m.name === "" && m.index === null) {
        const next = p.members[i + 1];
        if (next && next.name === null) return null; /* bit access is not an lvalue */
        continue;
      }
      if (m.bit) return null;
      if (m.name !== null && m.index !== null) code += "." + sanitizeCIdent(m.name) + "[" + structuralIndexToC(env, m.index) + "]";
      else if (m.name !== null) code += "." + sanitizeCIdent(m.name);
      else code += "[" + structuralIndexToC(env, m.index) + "]";
    }
    return code;
  };
  StandaloneGen.prototype.assignStmt = function (env, text, valueCode) {
    const p = OP.parseOperand(String(text || ""));
    let lvalue = sanitizeCIdent(p.baseTag || "?");
    let lastBit = null;
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      if (m.name === "" && m.index === null) {
        const next = p.members[i + 1];
        if (next && next.name === null) { lastBit = structuralIndexToC(env, next.index); i++; }
        continue;
      }
      if (m.name !== null && m.index !== null) { lvalue += "." + sanitizeCIdent(m.name) + "[" + structuralIndexToC(env, m.index) + "]"; lastBit = null; }
      else if (m.name !== null) { lvalue += "." + sanitizeCIdent(m.name); lastBit = null; }
      else if (m.bit) { lastBit = structuralIndexToC(env, m.index); }
      else { lvalue += "[" + structuralIndexToC(env, m.index) + "]"; lastBit = null; }
    }
    if (lastBit !== null) return "BIT_SET(" + lvalue + ", " + lastBit + ", " + valueCode + ");";
    return lvalue + "=" + valueCode + ";";
  };
  StandaloneGen.prototype.typeOfOperand = function () { return null; };
  StandaloneGen.prototype.exprType = function (env, e) {
    if (!e) return null;
    if (e.kind === "literal") {
      if (/^(TRUE|FALSE)$/i.test(String(e.value))) return "BOOL";
      return "DINT";
    }
    if (e.kind === "binary" && ["=", "<>", "<", ">", "<=", ">="].indexOf(e.op) !== -1) return "BOOL";
    if (e.kind === "unary" && e.op === "NOT") return "BOOL";
    if (e.kind === "binary" && (e.op === "AND" || e.op === "OR" || e.op === "XOR")) return "BOOL";
    return null;
  };
  StandaloneGen.prototype.indexToC = function (env, text) { return structuralIndexToC(env, text); };
  StandaloneGen.prototype.exprToC = function (env, e, hintType) {
    if (!e) return "0";
    switch (e.kind) {
      case "literal": {
        const c = cLiteral(e.value);
        if (c !== null) return c;
        env.warn("literal '" + e.value + "' has no C mapping; emitted as 0");
        return "0";
      }
      case "ref": return this.operandToC(env, e.path) || "0";
      case "paren": return "(" + this.exprToC(env, e.inner, hintType) + ")";
      case "unary": {
        const inner = this.exprToC(env, e.operand, hintType);
        return e.op === "NOT" ? "(!(" + inner + "))" : "(" + e.op + "(" + inner + "))";
      }
      case "binary": {
        const l = this.exprToC(env, e.left, null);
        const r = this.exprToC(env, e.right, null);
        const table = { AND: "&&", OR: "||", XOR: "!=", "&": "&", "=": "==", "<>": "!=", "<": "<",
          ">": ">", "<=": "<=", ">=": ">=", "+": "+", "-": "-", "*": "*", "/": "/", "MOD": "%",
          "**": "**" };
        if (e.op === "**") return "pow((double)(" + l + "), (double)(" + r + "))";
        const mapped = table[e.op];
        if (!mapped) { env.warn("ST operator '" + e.op + "' has no C mapping; emitted as 0"); return "0"; }
        return "((" + l + ") " + mapped + " (" + r + "))";
      }
      case "call": {
        return sanitizeCIdent(e.fn) + "(" + (e.args || []).map((a) => a && a.kind === "namedArg" ? this.exprToC(env, a.value, null) : this.exprToC(env, a, null)).join(", ") + ")";
      }
      case "namedArg": return this.exprToC(env, e.value, null);
      default: return "0";
    }
  };
  /* IR-to-C entry points used by routineToC for model-less generation. */
  StandaloneGen.prototype.ladIRToC = function (gen, env, ir, indent) {
    return ladIRToC(gen, env, ir, indent);
  };
  StandaloneGen.prototype.stIRToC = function (gen, env, ir, indent) {
    return stIRToC(gen, env, ir, indent);
  };
  StandaloneGen.prototype.routineFn = function () { return null; };
  StandaloneGen.prototype.noteUnsupported = function (env, instr, rungNumber) {
    this.unsupported = (this.unsupported || 0) + 1;
    env.warn("unsupported instruction " + instr.op + " in rung " + rungNumber + "; emitted as TODO comment");
  };
  StandaloneGen.prototype.findDecl = function () { return null; };

  /* ================================================================== *
   *  LAD codegen (ported from l5x2c/rungyacc.py)
   * ================================================================== */

  function warnOnce(env, key, msg) {
    env._once = env._once || {};
    if (env._once[key]) return;
    env._once[key] = true;
    env.warn(msg);
  }

  function makeEnv(gen, routineName, programName) {
    const warnings = [];
    const env = {
      gen: gen, program: programName, routine: routineName, warnings: warnings,
      warn: function (msg) { warnings.push({ routine: routineName, msg: String(msg) }); },
      warnOnce: function (key, msg) { warnOnce(env, key, msg); }
    };
    return env;
  }

  function operandOrEmpty(gen, env, operand, op, rungNumber) {
    const code = gen.operandToC(env, operand, "read");
    if (code === null) {
      env.warn("instruction " + op + " in rung " + rungNumber + ": operand '" + operand + "' has no C mapping");
      return null;
    }
    return code;
  }

  function translateInputInstr(gen, env, instr, rungNumber, indent) {
    const op = instr.op;
    const args = instr.args || [];
    const ind = "    ".repeat(indent);
    function a(i) { return operandOrEmpty(gen, env, args[i], op, rungNumber); }
    switch (op) {
      case "XIC": {
        const x = a(0);
        return ind + (x === null ? "push(false);and();" : "push(" + x + ");and();");
      }
      case "XIO": {
        const x = a(0);
        return ind + (x === null ? "push(false);and();" : "push(!" + x + ");and();");
      }
      case "ONS": {
        /* Ported verbatim from l5x2c rungyacc.py p_input_instruction_ons. */
        const read = a(0);
        const write = gen.assignStmt(env, args[0], "acc()", false);
        if (read === null || write === null) {
          return ind + "/* TODO ONS(" + args.join(",") + ") rung " + rungNumber + ": unsupported operands */";
        }
        return ind + "if(" + read + "==acc()){if(acc()){pop();push(false);}}else{" + write + ";} /* ONS */";
      }
      case "EQU":
      case "NEQ": {
        const l = a(0), r = a(1);
        const op2 = op === "EQU" ? "==" : "!=";
        return ind + (l === null || r === null
          ? "push(false);and(); /* TODO " + op + " rung " + rungNumber + " */"
          : "push(" + l + op2 + r + ");and();");
      }
      case "GRT": case "GEQ": case "LES": case "LEQ": {
        const l = a(0), r = a(1);
        /* Fix relative to l5x2c: LES is '<', LEQ is '<=' (upstream mapped LEQ to '<'). */
        const cmp = op === "GRT" ? ">" : op === "GEQ" ? ">=" : op === "LES" ? "<" : "<=";
        return ind + (l === null || r === null
          ? "push(false);and(); /* TODO " + op + " rung " + rungNumber + " */"
          : "push(" + l + cmp + r + ");and();");
      }
      case "LIM": {
        const low = a(0), value = a(1), high = a(2);
        if (low === null || value === null || high === null) {
          return ind + "push(false);and(); /* TODO LIM rung " + rungNumber + " */";
        }
        env.warn("rung " + rungNumber + ": LIM mapping is a faithful port of l5x2c (inclusive bounds); verify boundary semantics");
        /* Ported from l5x2c rungyacc.py p_input_instruction_lim (inclusive LIM). */
        const code = "if(acc()){if(" + low + "<=" + high + "){if(" + low + ">=" + value + "||" + value + ">=" + high + "){pop();push(false);}}else{if(" + low + "<=" + value + "||" + value + "<=" + high + "){pop();push(false);}}}";
        return ind + code + " /* LIM */";
      }
      case "AFI":
        return ind + "push(false);and();";
      case "NOP":
        return ind + "/* NOP */";
      case "MEQ":
      case "CMP": {
        gen.noteUnsupported(env, instr, rungNumber);
        return ind + "push(acc());and(); /* TODO " + op + "(" + args.map(function (x) { return x === undefined ? "?" : x; }).join(",") + ") rung " + rungNumber + ": unsupported */";
      }
      default:
        gen.noteUnsupported(env, instr, rungNumber);
        return ind + "push(acc());and(); /* TODO " + op + "(" + args.map(function (x) { return x === undefined ? "?" : x; }).join(",") + ") rung " + rungNumber + ": unsupported */";
    }
  }

  function translateInputItem(gen, env, item, rungNumber, indent) {
    if (!item) return "";
    if (item.kind === "series") return translateInputList(gen, env, item.items, rungNumber, indent);
    if (item.kind === "parallel") return translateInputBranch(gen, env, item, rungNumber, indent);
    if (typeof item.op === "string") return translateInputInstr(gen, env, item, rungNumber, indent);
    return "";
  }

  function translateInputList(gen, env, items, rungNumber, indent) {
    const out = [];
    for (const it of items || []) {
      const code = translateInputItem(gen, env, it, rungNumber, indent);
      if (code) out.push(code);
    }
    return out.join("\n");
  }

  function translateInputBranch(gen, env, branch, rungNumber, indent) {
    /* rungyacc: input_branch : LBRA input_level RBRA ->
         push(false);push(true); <levels joined by or();push(true);> or();and(); */
    const ind = "    ".repeat(indent);
    const legs = branch.legs || [];
    if (!legs.length) return ind + "/* empty branch */";
    const parts = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const code = translateInputItem(gen, env, leg, rungNumber, indent + 1);
      parts.push(code || ("    ".repeat(indent + 1) + "/* empty leg */"));
    }
    const joined = parts.join("\n" + ind + "or();push(true);\n");
    return ind + "push(false);push(true);\n" + joined + "\n" + ind + "or();and();";
  }

  function isInputClass(item) {
    if (!item) return true;
    if (item.kind === "series") return item.items.every(isInputClass);
    if (item.kind === "parallel") return item.legs.every(isInputClass);
    if (typeof item.op === "string") return !!INPUT_CLASS[item.op];
    return false;
  }

  function splitSeries(items) {
    let k = 0;
    while (k < items.length && isInputClass(items[k])) k++;
    return { inputItems: items.slice(0, k), outputItems: items.slice(k) };
  }

  function translateOutputInstr(gen, env, instr, rungNumber, indent) {
    const op = instr.op;
    const args = instr.args || [];
    const ind = "    ".repeat(indent);
    function a(i) { return operandOrEmpty(gen, env, args[i], op, rungNumber); }
    function assign(i, valueCode) {
      const stmt = gen.assignStmt(env, args[i], valueCode);
      if (stmt === null) {
        env.warn("instruction " + op + " in rung " + rungNumber + ": destination '" + args[i] + "' has no C mapping");
        return null;
      }
      return stmt;
    }
    switch (op) {
      case "OTE": {
        const st = assign(0, "acc()");
        return ind + (st === null ? "/* TODO OTE rung " + rungNumber + " */" : st);
      }
      case "OTL": {
        const st = assign(0, "1");
        return ind + (st === null ? "/* TODO OTL rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "OTU": {
        const st = assign(0, "0");
        return ind + (st === null ? "/* TODO OTU rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "RES": {
        const lv = gen.lvalueToC(env, args[0]);
        if (lv === null) { gen.noteUnsupported(env, instr, rungNumber); return ind + "/* TODO RES(" + args.join(",") + ") rung " + rungNumber + ": unsupported */"; }
        const typeName = gen.typeOfOperand(args[0], env.program) || "";
        const isCounter = String(typeName).toUpperCase() === "COUNTER";
        return ind + "if(acc())res(acc(), &" + lv + ", " + (isCounter ? "1" : "0") + ");";
      }
      case "MOV": {
        const src = a(0);
        const st = assign(1, src === null ? "0" : src);
        return ind + (st === null ? "/* TODO MOV rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "ADD": case "SUB": case "MUL": case "DIV": case "MOD": {
        const l = a(0), r = a(1);
        const cOp = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%" }[op];
        const st = assign(2, "(" + (l === null ? "0" : l) + " " + cOp + " " + (r === null ? "0" : r) + ")");
        return ind + (st === null ? "/* TODO " + op + " rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "NEG": case "ABS": case "SQR": case "SQRT": {
        const src = a(0);
        const s = src === null ? "0" : src;
        let value;
        if (op === "NEG") value = "-(" + s + ")";
        else if (op === "ABS") value = "((" + s + ") < 0 ? -(" + s + ") : (" + s + "))";
        else if (op === "SQR") value = "((" + s + ") * (" + s + "))";
        else value = "sqrt((double)(" + s + "))";
        const st = assign(1, value);
        return ind + (st === null ? "/* TODO " + op + " rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "AND": case "OR": case "XOR": {
        const l = a(0), r = a(1);
        const cOp = op === "AND" ? "&" : op === "OR" ? "|" : "^";
        const st = assign(2, "((" + (l === null ? "0" : l) + ") " + cOp + " (" + (r === null ? "0" : r) + "))");
        return ind + (st === null ? "/* TODO " + op + " rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "NOT": {
        const src = a(0);
        const st = assign(1, "~(" + (src === null ? "0" : src) + ")");
        return ind + (st === null ? "/* TODO NOT rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "CLR": {
        const st = assign(0, "0");
        return ind + (st === null ? "/* TODO CLR rung " + rungNumber + " */" : "if(acc())" + st);
      }
      case "CPT": {
        const dest = gen.lvalueToC(env, args[0]);
        if (dest === null) { gen.noteUnsupported(env, instr, rungNumber); return ind + "/* TODO CPT rung " + rungNumber + ": unsupported destination */"; }
        let expr = null;
        try { expr = STP.parseStExpression(args[1] || ""); } catch (e) { expr = null; }
        if (!expr) {
          gen.noteUnsupported(env, instr, rungNumber);
          return ind + "/* TODO CPT(" + args.join(",") + ") rung " + rungNumber + ": unsupported expression */";
        }
        return ind + "if(acc())" + dest + " = " + gen.exprToC(env, expr, null) + ";";
      }
      case "TON": case "TOF": case "RTO": {
        const lv = gen.lvalueToC(env, args[0]);
        if (lv === null) { gen.noteUnsupported(env, instr, rungNumber); return ind + "/* TODO " + op + " rung " + rungNumber + ": unsupported timer tag */"; }
        const typeName = String(gen.typeOfOperand(args[0], env.program) || "").toUpperCase();
        if (typeName && typeName !== "TIMER") {
          env.warn("instruction " + op + " in rung " + rungNumber + ": tag " + args[0] + " is " + typeName + ", not TIMER");
        }
        if (/\S/.test(String(args[1] || "?").replace("?", "")) || /\S/.test(String(args[2] || "?").replace("?", ""))) {
          env.warn("instruction " + op + " in rung " + rungNumber + ": PRE/ACC operands are taken from the tag (ladder placeholders ignored)");
        }
        return ind + op.toLowerCase() + "(acc(), &" + lv + ");";
      }
      case "CTU": case "CTD": {
        const lv = gen.lvalueToC(env, args[0]);
        if (lv === null) { gen.noteUnsupported(env, instr, rungNumber); return ind + "/* TODO " + op + " rung " + rungNumber + ": unsupported counter tag */"; }
        return ind + op.toLowerCase() + "(acc(), &" + lv + ");";
      }
      case "FOR": {
        /* Rockwell ladder FOR: FOR(routine_name,index,initial,terminal,step) repeatedly
           calls the routine for the index range (neutral-text manual p.243). */
        const fn = gen.routineFn(env.program, args[0]);
        const idx = gen.lvalueToC(env, args[1]);
        const init = gen.operandToC(env, args[2], "read");
        const term = gen.operandToC(env, args[3], "read");
        const step = gen.operandToC(env, args[4], "read");
        if (!fn || idx === null || init === null || term === null || step === null) {
          gen.noteUnsupported(env, instr, rungNumber);
          return ind + "/* TODO FOR(" + args.map(function (x) { return x === undefined ? "?" : x; }).join(",") +
            ") rung " + rungNumber + ": unsupported */";
        }
        return ind + "if(acc()){ " + idx + "=" + init + "; for (; ((" + step + ") >= 0) ? (" + idx + " <= " + term +
          ") : (" + idx + " >= " + term + "); " + idx + " += (" + step + ")) { " + fn + "(); } } /* FOR routine loop */";
      }
      case "JSR": {
        const target = args[0];
        const fn = gen.routineFn(env.program, target);
        if (!fn) {
          gen.noteUnsupported(env, instr, rungNumber);
          return ind + "/* TODO JSR(" + args.join(",") + ") rung " + rungNumber + ": routine " + target + " not found */";
        }
        const params = args.length > 1 ? String(args[1]) : "0";
        if (params !== "?" && params !== "0" && params !== "") {
          env.warn("rung " + rungNumber + ": JSR parameters for routine " + target + " are not passed (generated C routines take no parameters)");
        }
        return ind + "if(acc())" + fn + "();";
      }
      default: {
        gen.noteUnsupported(env, instr, rungNumber);
        return ind + "/* TODO " + op + "(" + args.map(function (x) { return x === undefined ? "?" : x; }).join(",") + ") rung " + rungNumber + ": unsupported */";
      }
    }
  }

  function translateOutputLevel(gen, env, branch, rungNumber, indent) {
    if (!branch) return "";
    const items = branch.kind === "series" ? branch.items : [branch];
    const split = splitSeries(items);
    const out = [];
    const inputCode = translateInputList(gen, env, split.inputItems, rungNumber, indent);
    if (inputCode) out.push(inputCode);
    for (const it of split.outputItems) {
      if (it && it.kind === "parallel") out.push(translateOutputBranch(gen, env, it, rungNumber, indent));
      else if (it && typeof it.op === "string") out.push(translateOutputInstr(gen, env, it, rungNumber, indent));
    }
    return out.join("\n");
  }

  function translateOutputBranch(gen, env, branch, rungNumber, indent) {
    /* rungyacc: output_branch : LBRA output_level RBRA ->
         push(acc()); <levels joined by pop();push(acc());> pop(); */
    const ind = "    ".repeat(indent);
    const legs = branch.legs || [];
    if (!legs.length) return ind + "/* empty output branch */";
    const parts = [];
    for (const leg of legs) {
      const code = translateOutputLevel(gen, env, leg, rungNumber, indent + 1);
      parts.push(code || ("    ".repeat(indent + 1) + "/* empty output leg */"));
    }
    return ind + "push(acc());\n" + parts.join("\n" + ind + "pop();push(acc());\n") + "\n" + ind + "pop();";
  }

  function translateOutputList(gen, env, items, rungNumber, indent) {
    const out = [];
    for (const it of items || []) {
      if (!it) continue;
      if (it.kind === "parallel") out.push(translateOutputBranch(gen, env, it, rungNumber, indent));
      else if (typeof it.op === "string") {
        if (INPUT_CLASS[it.op]) out.push(translateInputInstr(gen, env, it, rungNumber, indent));
        else out.push(translateOutputInstr(gen, env, it, rungNumber, indent));
      }
    }
    return out.join("\n");
  }

  function ladRungToC(gen, env, rung, indent) {
    const number = rung.number;
    const ind = "    ".repeat(indent);
    const out = [];
    if (rung.comment) out.push(cComment("rung " + number + ": " + rung.comment, ind));
    else out.push(ind + "/* rung " + number + " */");
    const root = rung.root || { kind: "series", items: [] };
    const items = root.kind === "series" ? root.items : [root];
    if (!items.length) return out.join("\n");
    const split = splitSeries(items);
    out.push(ind + "clear();push(true);");
    const inputCode = translateInputList(gen, env, split.inputItems, number, indent);
    if (inputCode) out.push(inputCode);
    const outputCode = translateOutputList(gen, env, split.outputItems, number, indent);
    if (outputCode) out.push(outputCode);
    return out.join("\n");
  }
  function ladIRToC(gen, env, ladIR, indent) {
    const blocks = [];
    for (const rung of ladIR.rungs || []) {
      try {
        blocks.push(ladRungToC(gen, env, rung, indent));
      } catch (e) {
        blocks.push("    ".repeat(indent) + "/* TODO codegen error in rung " + rung.number + ": " +
          String((e && e.message) || e).replace(/\*\//g, "* /") + " */");
        gen.noteUnsupported(env, { op: "CODEGEN", args: [] }, rung.number);
      }
    }
    return blocks.join("\n");
  }

  /* ================================================================== *
   *  ST codegen
   * ================================================================== */

  const ST_INSTR_DEST = {
    MOV: 1, COP: 1, ADD: 2, SUB: 2, MUL: 2, DIV: 2, MOD: 2, NEG: 1, ABS: 1,
    SQR: 1, SQRT: 1, CLR: 0, CPT: 0, TON: 0, TOF: 0, RTO: 0, CTU: 0, CTD: 0, RES: 0
  };

  function stCommentLines(text) {
    return String(text || "").split(/\r\n|\r|\n/).map(function (l) { return "/* " + l.replace(/\*\//g, "* /") + " */"; });
  }

  function stmtToC(gen, env, stmt, indent) {
    const ind = "    ".repeat(indent);
    if (!stmt) return "";
    switch (stmt.kind) {
      case "comment":
        return stCommentLines(stmt.text).map(function (l) { return ind + l; }).join("\n");
      case "empty":
        return;
      case "assign": {
        const target = gen.lvalueToC(env, stmt.target);
        if (target === null) {
          const assign = gen.assignStmt(env, stmt.target, gen.exprToC(env, stmt.value, null));
          if (assign === null) {
            env.warn("assignment target '" + stmt.target + "' has no C mapping; statement emitted as comment");
            return ind + "/* " + stmt.target + " := ...; (unsupported target) */";
          }
          return ind + assign;
        }
        const value = gen.exprToC(env, stmt.value, null);
        return ind + target + " = " + value + ";";
      }
      case "call": {
        const fn = String(stmt.fn || "").toUpperCase();
        const args = stmt.args || [];
        const destIdx = ST_INSTR_DEST[fn];
        if (destIdx !== undefined) {
          const dest = stmt.destIndex !== undefined ? stmt.destIndex : destIdx;
          const destArg = args[dest];
          const destText = destArg && destArg.kind === "ref" ? destArg.path : null;
          if (fn === "TON" || fn === "TOF" || fn === "RTO") {
            const lv = destText ? gen.lvalueToC(env, destText) : null;
            if (lv) return ind + fn.toLowerCase() + "(true, &" + lv + ");";
          }
          if (fn === "CTU" || fn === "CTD") {
            const lv = destText ? gen.lvalueToC(env, destText) : null;
            if (lv) return ind + fn.toLowerCase() + "(true, &" + lv + ");";
          }
          if (fn === "RES") {
            const lv = destText ? gen.lvalueToC(env, destText) : null;
            if (lv) {
              const isCounter = String(gen.typeOfOperand(destText, env.program) || "").toUpperCase() === "COUNTER";
              return ind + "res(true, &" + lv + ", " + (isCounter ? "1" : "0") + ");";
            }
          }
          const stmtCode = lvStmt(gen, env, fn, args, dest, destText);
          if (stmtCode) return ind + stmtCode;
        }
        /* generic call: emit as a C call, warning that no runtime mapping exists */
        const callCode = gen.exprToC(env, { kind: "call", fn: stmt.fn, args: args }, null);
        env.warnOnce("stcall:" + fn, "ST instruction " + fn + " has no C runtime mapping; emitted as a C call (provide an implementation when porting)");
        return ind + callCode + ";";
      }
      case "if": {
        const lines = [];
        const branches = stmt.branches || [];
        for (let i = 0; i < branches.length; i++) {
          const b = branches[i];
          const head = i === 0 ? ind + "if" : ind + "else if";
          if (b.cond === null) {
            lines.push(ind + "else {");
          } else {
            lines.push(head + " (" + gen.exprToC(env, b.cond, "BOOL") + ") {");
          }
          const body = stmtListToC(gen, env, b.statements || [], indent + 1);
          if (body) lines.push(body);
          lines.push(ind + "}");
        }
        return lines.join("\n");
      }
      case "for": {
        const index = gen.lvalueToC(env, stmt.index) || sanitizeCIdent(stmt.index);
        const from = gen.exprToC(env, stmt.from, null);
        const to = gen.exprToC(env, stmt.to, null);
        const by = stmt.by ? gen.exprToC(env, stmt.by, null) : "1";
        const cond = "((" + by + ") >= 0) ? (" + index + " <= " + to + ") : (" + index + " >= " + to + ")";
        const body = stmtListToC(gen, env, stmt.statements || [], indent + 1);
        return ind + "for (" + index + " = " + from + "; " + cond + "; " + index + " += (" + by + ")) {" +
          (body ? "\n" + body + "\n" + ind : "") + "}";
      }
      case "while": {
        const body = stmtListToC(gen, env, stmt.statements || [], indent + 1);
        return ind + "while (" + gen.exprToC(env, stmt.cond, "BOOL") + ") {" +
          (body ? "\n" + body + "\n" + ind : "") + "}";
      }
      case "repeat": {
        const body = stmtListToC(gen, env, stmt.statements || [], indent + 1);
        return ind + "do {" + (body ? "\n" + body + "\n" + ind : "") + "} while (!(" +
          gen.exprToC(env, stmt.cond, "BOOL") + "));";
      }
      case "case": {
        const lines = [ind + "switch (" + gen.exprToC(env, stmt.expr, null) + ") {"];
        for (const c of stmt.cases || []) {
          for (const label of c.labels || []) {
            const lit = label.kind === "literal" ? cLiteral(label.value) : null;
            if (lit === null) {
              env.warn("CASE label has no C constant mapping; case skipped");
              continue;
            }
            lines.push(ind + "    case " + lit + ":");
          }
          const body = stmtListToC(gen, env, c.statements || [], indent + 2);
          if (body) lines.push(body);
          lines.push(ind + "        break;");
        }
        if (stmt.elseStatements) {
          lines.push(ind + "    default:");
          const body = stmtListToC(gen, env, stmt.elseStatements, indent + 2);
          if (body) lines.push(body);
          lines.push(ind + "        break;");
        }
        lines.push(ind + "}");
        return lines.join("\n");
      }
      case "exit":
        return ind + "break; /* EXIT */";
      case "return":
        return ind + "return;";
      default:
        env.warn("ST statement kind '" + stmt.kind + "' has no C mapping; emitted as comment");
        return ind + "/* " + stmt.kind + " (unsupported) */";
    }

    function lvStmt(gen2, env2, fn2, args2, dest, destText) {
      if (!destText) return null;
      const destLv = gen2.lvalueToC(env2, destText);
      if (destLv === null) return null;
      const reads = [];
      for (let i = 0; i < args2.length; i++) {
        if (i === dest) continue;
        const a = args2[i];
        const val = a && a.kind === "namedArg" ? a.value : a;
        reads.push(gen2.exprToC(env2, val, null));
      }
      const src = reads.length ? reads : ["0"];
      switch (fn2) {
        case "MOV": return destLv + " = " + src[0] + ";";
        case "ADD": return destLv + " = (" + src[0] + ") + (" + (src[1] || "0") + ");";
        case "SUB": return destLv + " = (" + src[0] + ") - (" + (src[1] || "0") + ");";
        case "MUL": return destLv + " = (" + src[0] + ") * (" + (src[1] || "0") + ");";
        case "DIV": return destLv + " = (" + src[0] + ") / (" + (src[1] || "1") + ");";
        case "MOD": return destLv + " = (" + src[0] + ") % (" + (src[1] || "1") + ");";
        case "NEG": return destLv + " = -(" + src[0] + ");";
        case "ABS": return destLv + " = ((" + src[0] + ") < 0 ? -(" + src[0] + ") : (" + src[0] + "));";
        case "SQR": return destLv + " = ((" + src[0] + ") * (" + src[0] + "));";
        case "SQRT": return destLv + " = sqrt((double)(" + src[0] + "));";
        case "CLR": return destLv + " = 0;";
        case "CPT": return destLv + " = " + gen2.exprToC(env2, args2[1], null) + ";";
        default: return null;
      }
    }
  }

  function stmtListToC(gen, env, stmts, indent) {
    const out = [];
    for (const s of stmts || []) {
      const code = stmtToC(gen, env, s, indent);
      if (code) out.push(code);
    }
    return out.join("\n");
  }

  function stIRToC(gen, env, stIR, indent) {
    return stmtListToC(gen, env, stIR.statements || [], indent);
  }

  /* ================================================================== *
   *  routineToC / generateC
   * ================================================================== */

  function ensureEnv(gen, ctx) {
    ctx = ctx || {};
    const routine = ctx.routine || ctx.routineName || "routine";
    const program = ctx.program || ctx.programName || null;
    let env;
    if (gen && typeof gen.operandToC === "function") {
      env = makeEnv(gen, routine, program);
    } else {
      const sgen = new StandaloneGen();
      env = makeEnv(sgen, routine, program);
    }
    return env;
  }

  /* Convert any IR to C body code. Exported for tests (docs T3).
     ctx: { routine, program, model? } — when no project generator is supplied a model-less
     structural mapping of operands is used (good enough for code-shape assertions). */
  function routineToC(ir, ctx) {
    ctx = ctx || {};
    const gen = (ctx && ctx.gen) || null;
    const env = ensureEnv(gen, ctx);
    const kind = IR.irKind(ir);
    let code = "";
    try {
      if (kind === "lad") code = env.gen.ladIRToC(env.gen, env, ir, 1);
      else if (kind === "st") code = (env.gen.stIRToC || stIRToC)(env.gen, env, ir, 1);
      else if (kind === "fbd") {
        const conv = (FBDC && FBDC.fbdToLad) ? FBDC.fbdToLad(ir) : null;
        if (!conv || !conv.ir) {
          env.warn("FBD conversion failed; routine emitted as TODO");
          code = "    /* TODO FBD routine could not be converted to ladder */";
        } else {
          for (const w of conv.warnings || []) env.warn("FBD: " + (w.msg || w.kind || w));
          code = env.gen.ladIRToC(env.gen, env, conv.ir, 1);
        }
      } else {
        env.warn("unsupported routine IR kind " + kind);
        code = "    /* TODO unsupported routine kind " + kind + " */";
      }
    } catch (e) {
      env.warn("codegen exception: " + String((e && e.message) || e));
      code = "    /* TODO codegen exception: " + String((e && e.message) || e).replace(/\*\//g, "* /") + " */";
    }
    return { code: code, warnings: env.warnings };
  }

  /* Collect operand references from an IR so declarations can be built first. */
  function collectIrRefs(gen, ir, programName, warnings) {
    const visited = new Set();
    /* tags used inside array/bit index expressions (e.g. TAG[NDX_ZONE]) */
    function collectIndexRefs(text) {
      if (!text || !gen.decls) return;
      const p = OP.parseOperand(String(text));
      for (const m of p.members) {
        if (m.index === null || m.index === undefined) continue;
        let expr = null;
        try { expr = STP.parseStExpression(String(m.index)); } catch (e) { expr = null; }
        if (!expr) continue;
        IR.walkExpr(expr, function (e) {
          if (e && e.kind === "ref" && e.path) gen.registerRef(e.path, programName);
        });
      }
    }
    function ref(text) {
      if (!text || text === "?") return;
      if (!gen.registerRef(text, programName)) return;
      collectIndexRefs(text);
    }
    function exprRefs(e) {
      if (!e || typeof e !== "object") return;
      switch (e.kind) {
        case "ref": ref(e.path); break;
        case "unary": exprRefs(e.operand); break;
        case "binary": exprRefs(e.left); exprRefs(e.right); break;
        case "paren": exprRefs(e.inner); break;
        case "call":
          for (const a of e.args || []) {
            if (a && a.kind === "namedArg") exprRefs(a.value); else exprRefs(a);
          }
          break;
        case "namedArg": exprRefs(e.value); break;
      }
    }
    function stmts(list) {
      for (const s of list || []) {
        if (!s) continue;
        switch (s.kind) {
          case "assign": ref(s.target); exprRefs(s.value); break;
          case "call":
            for (let i = 0; i < (s.args || []).length; i++) {
              const a = s.args[i];
              const val = a && a.kind === "namedArg" ? a.value : a;
              exprRefs(val);
            }
            break;
          case "if":
            for (const b of s.branches || []) { if (b.cond) exprRefs(b.cond); stmts(b.statements); }
            break;
          case "for":
            ref(s.index); exprRefs(s.from); exprRefs(s.to); if (s.by) exprRefs(s.by); stmts(s.statements);
            break;
          case "while": case "repeat": exprRefs(s.cond); stmts(s.statements); break;
          case "case":
            exprRefs(s.expr);
            for (const c of s.cases || []) { stmts(c.statements); }
            stmts(s.elseStatements);
            break;
        }
      }
    }
    const kind = IR.irKind(ir);
    if (kind === "lad") {
      IR.walkInstrs(ir, function (instr) {
        const args = instr.args || [];
        if (visited.has(instr)) return;
        visited.add(instr);
        const skip = NON_TAG_ARGS[instr.op] || [];
        if (instr.op === "CPT" || instr.op === "CMP") {
          const exprIdx = instr.op === "CPT" ? 1 : 0;
          for (let i = 0; i < args.length; i++) {
            if (i === exprIdx) {
              let e = null;
              try { e = STP.parseStExpression(args[i]); } catch (err) { e = null; }
              if (e) exprRefs(e); else ref(args[i]);
            } else if (skip.indexOf(i) === -1) ref(args[i]);
          }
          return;
        }
        for (let i = 0; i < args.length; i++) {
          if (skip.indexOf(i) !== -1) continue;
          ref(args[i]);
        }
      });
    } else if (kind === "st") {
      stmts(ir.statements);
    } else if (kind === "fbd") {
      let conv = null;
      try { conv = FBDC && FBDC.fbdToLad ? FBDC.fbdToLad(ir) : null; } catch (e) { conv = null; }
      if (conv && conv.ir) {
        for (const w of conv.warnings || []) {
          if (warnings) warnings.push({ routine: null, msg: "FBD conversion: " + (w.msg || w.kind || String(w)) });
        }
        collectIrRefs(gen, conv.ir, programName, warnings);
      }
    }
  }

  function getRoutineIR(model, program, routine, warnings) {
    const kind = routine.pendingType || routine.type;
    try {
      if (typeof model.getRoutineIR === "function") {
        const ir = model.getRoutineIR(program.name, routine.name);
        if (ir) return { ir: ir, kind: kind };
      }
    } catch (e) {
      if (warnings) warnings.push({ routine: routine.name, msg: "could not parse routine: " + String((e && e.message) || e) });
    }
    const content = routine.content || {};
    try {
      if (kind === "RLL" && content.kind === "rll") {
        /* direct import keeps browser/Node parity */
        const RLLP = (typeof module !== "undefined" && module.exports) ? require("./rll-parse.js") : root.L5XStudio;
        const built = (content.rungs || []).map(function (rg, i) {
          let branch;
          try { branch = RLLP.parseRllRung(rg.text || ""); }
          catch (e) { branch = { kind: "series", items: [] }; }
          return { id: null, number: rg.number !== undefined ? rg.number : i, type: rg.type || "N", comment: rg.comment, root: branch };
        });
        return { ir: { kind: "lad", rungs: built }, kind: "RLL" };
      }
      if (kind === "ST" && content.kind === "st") {
        const STP2 = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;
        return { ir: STP2.parseSt(content.text || ""), kind: "ST" };
      }
      if (kind === "FBD" && content.kind === "fbd") {
        const FBDP = (typeof module !== "undefined" && module.exports) ? require("./fbd-parse.js") : root.L5XStudio;
        return { ir: FBDP.parseFbdXml(content.xmlText || ""), kind: "FBD" };
      }
    } catch (e) {
      if (warnings) warnings.push({ routine: routine.name, msg: "could not parse routine: " + String((e && e.message) || e) });
    }
    return { ir: null, kind: kind };
  }

  function assignRoutineNames(model, picks, reserved) {
    /* picks: [{program, routine}] */
    const counts = new Map();
    for (const p of picks) counts.set(p.routine.name, (counts.get(p.routine.name) || 0) + 1);
    const used = new Set();
    if (reserved) for (const id of reserved) used.add(id);
    const map = new Map(); /* program\u0000routine -> fn name */
    for (const p of picks) {
      let base = sanitizeCIdent(p.routine.name);
      if (counts.get(p.routine.name) > 1) base = sanitizeCIdent(p.program.name) + "__" + base;
      let name = base, i = 2;
      while (used.has(name)) { name = base + "_FN" + (i === 2 ? "" : i); i++; }
      used.add(name);
      if (reserved) reserved.add(name);
      map.set(String(p.program.name) + "\u0000" + String(p.routine.name), name);
    }
    return map;
  }

  function selectRoutines(model, opts) {
    const picks = [];
    for (const program of model.programs || []) {
      if (opts.programFilter && program.name !== opts.programFilter) continue;
      for (const routine of program.routines || []) {
        if (opts.routineFilter) {
          const needle = String(opts.routineFilter).toLowerCase();
          if (String(routine.name).toLowerCase().indexOf(needle) === -1) continue;
        }
        picks.push({ program: program, routine: routine });
        if (opts.maxRoutines && picks.length >= opts.maxRoutines) return picks;
      }
    }
    return picks;
  }

  /* Order routines for emission: main routine of each program first, then JSR targets,
     then anything unreachable (with a warning). */
  function orderRoutines(picks, gen, irs, warnings) {
    const byProgram = new Map();
    for (const p of picks) {
      if (!byProgram.has(p.program.name)) byProgram.set(p.program.name, []);
      byProgram.get(p.program.name).push(p);
    }
    const key = function (program, routine) { return String(program) + "\u0000" + String(routine); };
    const pickedSet = new Set(picks.map(function (p) { return key(p.program.name, p.routine.name); }));
    const emitted = new Set();
    const order = [];
    const jsrTargetsOf = function (p) {
      const ir = irs.get(key(p.program.name, p.routine.name));
      if (!ir) return [];
      const targets = [];
      if (IR.irKind(ir) === "lad") {
        IR.walkInstrs(ir, function (instr) {
          if ((instr.op === "JSR" || instr.op === "FOR") && instr.args && instr.args[0] && instr.args[0] !== "?") {
            targets.push(instr.args[0]);
          }
        });
      }
      return targets;
    };
    for (const [programName, list] of byProgram) {
      const mainName = (list[0] && list[0].program.mainRoutineName) || null;
      const main = list.find(function (p) { return p.routine.name === mainName; });
      const queue = [];
      if (main) queue.push(main);
      else if (warnings) warnings.push({ routine: null, msg: "program " + programName + " has no main routine in the generated set; routines emitted in declaration order" });
      while (queue.length) {
        const p = queue.shift();
        const k = key(p.program.name, p.routine.name);
        if (emitted.has(k)) continue;
        emitted.add(k);
        order.push(p);
        for (const target of jsrTargetsOf(p)) {
          for (const cand of list) {
            if (cand.routine.name === target && !emitted.has(key(cand.program.name, cand.routine.name))) queue.push(cand);
          }
        }
      }
      for (const p of list) {
        const k = key(p.program.name, p.routine.name);
        if (!emitted.has(k)) {
          emitted.add(k);
          order.push(p);
          if (warnings) warnings.push({ routine: p.routine.name, msg: "routine " + p.program.name + "/" + p.routine.name + " is not reachable from the main routine/JSR chain; emitted at the end" });
        }
      }
    }
    return order;
  }

  function generateC(model, opts) {
    opts = opts || {};
    const options = {
      programFilter: opts.programFilter || null,
      routineFilter: opts.routineFilter || null,
      maxRoutines: opts.maxRoutines !== undefined && opts.maxRoutines !== null ? opts.maxRoutines : null,
      filenameBase: opts.filenameBase || "plcmodel",
      scanTimeMs: opts.scanTimeMs !== undefined && opts.scanTimeMs !== null ? opts.scanTimeMs : 10
    };
    const base = String(options.filenameBase).replace(/\.(h|c)$/i, "");
    const picks = selectRoutines(model, options);
    const gen = createGen(model, options);
    const warnings = gen.warnings;
    gen.noteUnsupported = function (env, instr, rungNumber) {
      gen.unsupported++;
      const args = (instr.args || []).map(function (x) { return x === undefined ? "?" : x; }).join(",");
      gen.noteWarning(env.routine, "unsupported instruction " + instr.op + "(" + args + ") in rung " + rungNumber +
        " of " + env.routine + "; emitted as TODO comment");
    };

    /* ---- pass 1: parse IRs + collect referenced tags ---- */
    const irs = new Map();
    const routineOrderList = [];
    for (const p of picks) {
      const res = getRoutineIR(model, p.program, p.routine, warnings);
      const key = String(p.program.name) + "\u0000" + String(p.routine.name);
      irs.set(key, res.ir);
      routineOrderList.push({ pick: p, ir: res.ir, kind: res.kind });
      if (!res.ir) {
        warnings.push({
          routine: p.routine.name,
          msg: "routine " + p.program.name + "/" + p.routine.name + " has type " + (p.routine.pendingType || p.routine.type) +
            " and no parseable content; emitted as an empty routine"
        });
        continue;
      }
      try { collectIrRefs(gen, res.ir, p.program.name, warnings); }
      catch (e) { warnings.push({ routine: p.routine.name, msg: "reference collection failed: " + String((e && e.message) || e) }); }
    }

    /* ---- pass 2: build declarations (typedefs, externs) ---- */
    try { gen.buildDeclarations(); }
    catch (e) {
      warnings.push({ routine: null, msg: "declaration build failed: " + String((e && e.message) || e) });
    }

    /* routine function names: assigned after declarations so they do not collide with
       tag identifiers or UDT typedef names (all share C's ordinary identifier namespace) */
    gen.routineFns = assignRoutineNames(model, picks, gen.usedIdents);
    gen.routineFn = function (programName, routineName) {
      return gen.routineFns.get(String(programName) + "\u0000" + String(routineName)) ||
        gen.routineFns.get(String(programName) + "\u0000" + String(routineName).toUpperCase()) || null;
    };

    /* ---- pass 3: emit routine bodies in execution order ---- */
    const ordered = orderRoutines(picks, gen, irs, warnings);
    const orderedKeys = new Set(ordered.map(function (p) { return String(p.program.name) + "\u0000" + String(p.routine.name); }));
    const bodyParts = [];
    let emittedRoutines = 0;
    for (const p of ordered) {
      const key = String(p.program.name) + "\u0000" + String(p.routine.name);
      const ir = irs.get(key);
      const fn = gen.routineFn(p.program.name, p.routine.name) || sanitizeCIdent(p.routine.name);
      gen.currentRoutine = p.routine.name;
      const head = [
        "/* ------------------------------------------------------------------",
        " * routine: " + p.program.name + " / " + p.routine.name +
          "  (type " + (p.routine.pendingType || p.routine.type) + ")",
        " * ------------------------------------------------------------------ */",
        "void " + fn + "(void) {"
      ];
      let body = "";
      if (!ir) {
        body = "    /* TODO routine has no parseable content */";
      } else {
        const converted = routineToC(ir, { gen: gen, program: p.program.name, routine: p.routine.name });
        body = converted.code || "    /* empty routine */";
        for (const w of converted.warnings) warnings.push(w);
      }
      head.push(body);
      head.push("}");
      bodyParts.push(head.join("\n"));
      emittedRoutines++;
    }

    /* ---- header + source ---- */
    const projectName = (model.controller && model.controller.name) || model.fileName || "(unknown project)";
    const udtCount = gen.udts.byName.size;
    const tagCount = gen.declOrder.length;

    const headerLines = [];
    headerLines.push("/* " + base + ".h - generated by L5X Studio (js/codegen-c.js)");
    headerLines.push(" * Project: " + projectName);
    headerLines.push(" * Controller: " + ((model.controller && (model.controller.processorType + " " +
      model.controller.majorRev + "." + model.controller.minorRev)) || "unknown"));
    headerLines.push(" * Routines: " + emittedRoutines + "   Data types: " + udtCount + "   Tag declarations: " + tagCount);
    headerLines.push(" * Scan time: " + options.scanTimeMs + " ms");
    headerLines.push(" *");
    headerLines.push(" * Based on l5x2c by Alair Dias Junior (https://github.com/alairjunior/l5x2c):");
    headerLines.push(" *   ladder neutral text -> boolean stack machine, Rockwell timer/counter semantics.");
    headerLines.push(" * Fix relative to l5x2c: LES maps to '<' and LEQ to '<=' (upstream mapped LEQ to '<').");
    headerLines.push(" * Note: tag initial values (L5K data) are NOT imported; set PRE/etc. before running.");
    headerLines.push(" * Unsupported instructions are emitted as TODO comments, never silently dropped.");
    headerLines.push(" */");
    headerLines.push("#ifndef " + base.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H");
    headerLines.push("#define " + base.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H");
    headerLines.push("");
    headerLines.push("#define SCAN_TIME_MS " + options.scanTimeMs);
    headerLines.push("");
    headerLines.push(RUNTIME_HEADER);
    headerLines.push("/***************************************************");
    headerLines.push(" *             Predefined data types               *");
    headerLines.push(" **************************************************/");
    for (const p of PREDEF_STRUCTS) {
      if (p.runtimeDefined) continue; /* timer/counter are defined in the runtime block above */
      const lines = ["typedef struct " + p.name + " {"];
      for (const f of p.fields) lines.push("    " + f[1] + " " + f[0] + (f[2] ? "[" + f[2] + "]" : "") + ";");
      lines.push("} " + p.name + ";");
      headerLines.push(lines.join("\n"));
    }
    headerLines.push("");
    headerLines.push("/***************************************************");
    headerLines.push(" *        User defined data types (UDTs)           *");
    headerLines.push(" **************************************************/");
    if (!gen.typedefLines.length) headerLines.push("/* (none referenced) */");
    else headerLines.push(gen.typedefLines.join("\n\n"));
    headerLines.push("");
    headerLines.push("/***************************************************");
    headerLines.push(" *        Tag declarations (original -> C)         *");
    headerLines.push(" **************************************************/");
    if (!gen.aliasDefs.length && !gen.tagDefLines.length) headerLines.push("/* (no tags referenced) */");
    if (gen.aliasDefs.length) {
      headerLines.push("/* aliases (Rockwell AliasFor) */");
      headerLines.push(gen.aliasDefs.join("\n"));
      headerLines.push("");
    }
    if (gen.tagDefLines.length) headerLines.push(gen.tagDefLines.join("\n"));
    headerLines.push("");
    headerLines.push("#endif /* " + base.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H */");
    headerLines.push("");
    const headerText = headerLines.join("\n");

    const sourceLines = [];
    sourceLines.push("/* " + base + ".c - generated by L5X Studio (js/codegen-c.js)");
    sourceLines.push(" * Project: " + projectName + "   Scan time: " + options.scanTimeMs + " ms");
    sourceLines.push(" * " + emittedRoutines + " routine(s), " + gen.unsupported + " unsupported instruction(s) emitted as TODO.");
    sourceLines.push(" */");
    sourceLines.push("#include \"" + base + ".h\"");
    sourceLines.push("");
    sourceLines.push("/***************************************************");
    sourceLines.push(" *                 Tag definitions                 *");
    sourceLines.push(" **************************************************/");
    const defs = gen.requireDefinitions();
    sourceLines.push(defs.length ? defs.join("\n") : "/* (none) */");
    sourceLines.push("");
    sourceLines.push("/***************************************************");
    sourceLines.push(" *                    Routines                     *");
    sourceLines.push(" **************************************************/");
    /* forward declarations so JSR targets can be called before their definition */
    const protoLines = [];
    for (const p of ordered) {
      const fn = gen.routineFn(p.program.name, p.routine.name);
      if (fn) protoLines.push("void " + fn + "(void);");
    }
    if (protoLines.length) {
      sourceLines.push("/* forward declarations */");
      sourceLines.push(protoLines.join("\n"));
      sourceLines.push("");
    }
    const unsupportedCount = gen.unsupported;
    sourceLines.push(bodyParts.join("\n\n"));
    sourceLines.push("");
    sourceLines.push("/***************************************************");
    sourceLines.push(" *                      Main                       *");
    sourceLines.push(" **************************************************/");
    sourceLines.push("static void scan_delay(void) {");
    sourceLines.push("    /* portable busy-wait placeholder for a real scan delay */");
    sourceLines.push("    volatile unsigned long spin = (unsigned long)SCAN_TIME_MS * 1000UL;");
    sourceLines.push("    while (spin-- > 0UL) { /* spin */ }");
    sourceLines.push("}");
    sourceLines.push("");
    sourceLines.push("int main(void) {");
    sourceLines.push("    bool first_scan = true;");
    /* S:FS first-scan flag simulation */
    const sysFs = gen.declOrder.find(function (e) { return e.decl.kind === "system" && e.decl.baseTag === "S:FS"; });
    if (sysFs) sourceLines.push("    " + sysFs.decl.ident + " = false; /* S:FS first scan flag (simulated) */");
    sourceLines.push("    for (;;) {");
    if (sysFs) sourceLines.push("        " + sysFs.decl.ident + " = first_scan; /* S:FS */");
    const mainCalls = [];
    for (const program of model.programs || []) {
      if (options.programFilter && program.name !== options.programFilter) continue;
      const mainName = program.mainRoutineName;
      const mainPick = picks.find(function (p) { return p.program.name === program.name && p.routine.name === mainName; });
      const pad = "        ";
      if (!mainPick) {
        mainCalls.push(pad + "/* " + program.name + ": no main routine in the generated set */");
        continue;
      }
      const fn = gen.routineFns.get(String(program.name) + "\u0000" + String(mainName));
      if (!fn) {
        mainCalls.push(pad + "/* " + program.name + ": main routine " + mainName + " was filtered out */");
        continue;
      }
      if (program.disabled) {
        mainCalls.push(pad + "/* " + program.name + " is disabled in the project: " + fn + "(); */");
      } else {
        mainCalls.push(pad + fn + "(); /* " + program.name + " main routine */");
      }
    }
    for (const line of mainCalls) sourceLines.push(line);
    sourceLines.push("        first_scan = false;");
    sourceLines.push("        scan_delay(); /* update timers via get_scan_time()/SCAN_TIME_MS */");
    sourceLines.push("    }");
    sourceLines.push("    return 0;");
    sourceLines.push("}");
    sourceLines.push("");
    const sourceText = sourceLines.join("\n");

    const files = {};
    files[base + ".h"] = headerText;
    files[base + ".c"] = sourceText;
    return {
      files: files,
      warnings: warnings,
      stats: {
        routines: emittedRoutines,
        unsupported: unsupportedCount,
        warnings: warnings.length,
        tags: tagCount,
        dataTypes: udtCount,
        headerBytes: headerText.length,
        sourceBytes: sourceText.length
      }
    };
  }

  return {
    generateC: generateC,
    routineToC: routineToC,
    sanitizeCIdent: sanitizeCIdent,
    tagPathToCIdent: tagPathToCIdent,
    cLiteral: cLiteral
  };
});
