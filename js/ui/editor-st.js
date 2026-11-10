/* L5X Studio - ui/editor-st.js (T2). Structured text editor with line numbers and live
   diagnostics. See CONTRACT section 8.
   - StEditor: textarea + line-number gutter inside a "st-editor" container; 400 ms
     debounced parse via parseSt; onDiagnostics(errors with {line, col, msg}) on failure,
     onChange(stIR) on success. Content = serializeSt(ir) on init and on .setIR() when the
     serialized form differs.
   - annotateStErrors(text) is pure and Node-testable: it attempts the real parseSt (T1)
     first and maps thrown positions; while T1 is in flight it falls back to a local
     scanner (unbalanced parens/brackets, unterminated strings, missing semicolons,
     IF/END_IF pairing, empty assignment RHS). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const stParse = typeof module !== "undefined" && module.exports ? require("../st-parse.js") : root.L5XStudio;
  const stSer = typeof module !== "undefined" && module.exports ? require("../st-serialize.js") : root.L5XStudio;
  const utilDep = typeof module !== "undefined" && module.exports ? require("../util.js") : root.L5XStudio;
  const util = (utilDep && utilDep.util) || utilDep;

  function hasDom() {
    return typeof document !== "undefined";
  }
  function callReady(fn, args) {
    if (typeof fn !== "function") return null;
    try { return fn.apply(null, args); }
    catch (e) {
      if (/not implemented/i.test(String(e && e.message))) return null;
      throw e;
    }
  }

  /* ---------- pure diagnostics ---------- */
  function mapParseError(e, text) {
    const msg = String(e && e.message ? e.message : e);
    let line = e && e.line ? e.line : null;
    let col = e && e.col !== undefined ? e.col : (e && e.column !== undefined ? e.column : null);
    if (line === null || col === null) {
      const lm = /line\s*[:=]?\s*(\d+)/i.exec(msg);
      const cm = /col(?:umn)?\s*[:=]?\s*(\d+)/i.exec(msg);
      if (lm) line = parseInt(lm[1], 10);
      if (cm) col = parseInt(cm[1], 10);
    }
    if (line === null) line = 1;
    if (col === null) col = 1;
    return [{ line: Math.max(1, line), col: Math.max(1, col), msg: msg }];
  }

  /* Local fallback scanner used while T1's parseSt is not implemented. */
  function localStScan(text) {
    const errors = [];
    const lines = String(text).split(/\r\n|\r|\n/);
    const stack = []; // [ { ch: "(", line, col } ]
    let ifDepth = 0;
    const openAt = { "(": ")", "[": "]" };
    const closeAt = { ")": "(", "]": "[" };
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      /* strip comments (string-naive but adequate for the fallback) */
      let stripped = line;
      const cIdx = stripped.indexOf("//");
      if (cIdx !== -1) stripped = stripped.slice(0, cIdx);
      let i = 0, inStr = false;
      while (i < stripped.length) {
        const ch = stripped[i];
        if (ch === "'") {
          if (inStr) inStr = false;
          else inStr = true;
          i++;
          continue;
        }
        if (inStr) { i++; continue; }
        if (ch === "(" || ch === "[") { stack.push({ ch: ch, line: li + 1, col: i + 1 }); }
        else if (ch === ")" || ch === "]") {
          const top = stack.pop();
          if (!top || openAt[top.ch] !== ch) {
            errors.push({ line: li + 1, col: i + 1, msg: "unmatched '" + ch + "'" });
          }
        }
        i++;
      }
      if (inStr) errors.push({ line: li + 1, col: stripped.length + 1, msg: "unterminated string literal" });
      const kw = /^\s*(IF|CASE|FOR|WHILE|REPEAT|END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT|THEN|ELSIF|ELSE|DO|UNTIL|OF|BY|TO|EXIT|RETURN)\b/i.exec(stripped);
      if (kw) {
        const k = kw[1].toUpperCase();
        if (k === "IF") ifDepth++;
        else if (k === "END_IF") { ifDepth--; if (ifDepth < 0) { errors.push({ line: li + 1, col: 1, msg: "END_IF without matching IF" }); ifDepth = 0; } }
      }
      const trimmed = stripped.trim();
      if (!trimmed || kw) continue;
      const isStatementLike = /:=|^\s*[A-Za-z_][\w:.\[\]]*(\(|$)/.test(trimmed);
      if (isStatementLike && !/;\s*$/.test(trimmed)) {
        errors.push({ line: li + 1, col: Math.max(1, trimmed.length + 1), msg: "missing ';' at end of statement" });
      }
      if (/:=\s*;?\s*$/.test(trimmed)) {
        errors.push({ line: li + 1, col: Math.max(1, trimmed.length + 1), msg: "missing expression after ':='" });
      }
    }
    for (const open of stack) {
      errors.push({ line: open.line, col: open.col, msg: "unclosed '" + open.ch + "'" });
    }
    if (ifDepth > 0) errors.push({ line: lines.length, col: 1, msg: "IF without END_IF" });
    return errors;
  }

  function annotateStErrors(text) {
    if (stParse && typeof stParse.parseSt === "function") {
      try {
        stParse.parseSt(String(text));
        return [];
      } catch (e) {
        if (!/not implemented/i.test(String(e && e.message))) {
          return mapParseError(e, String(text));
        }
        /* T1 not landed yet: fall through to local scan */
      }
    }
    return localStScan(String(text));
  }

  /* Minimal ST serializer used only while T1's serializeSt is missing. */
  function fallbackSerializeSt(stIR) {
    const out = [];
    function expr(e) {
      if (!e) return "TRUE";
      if (e.kind === "ref") return e.path;
      if (e.kind === "literal") return String(e.value);
      if (e.kind === "unary") return e.op + " " + expr(e.operand);
      if (e.kind === "paren") return "(" + expr(e.inner) + ")";
      if (e.kind === "binary") return expr(e.left) + " " + e.op + " " + expr(e.right);
      if (e.kind === "call") return e.fn + "(" + e.args.map(expr).join(", ") + ")";
      if (e.kind === "namedArg") return e.name + " := " + expr(e.value);
      return "?";
    }
    function stmt(s, indent) {
      const pad = "   ".repeat(indent);
      if (s.kind === "assign") return pad + s.target + " := " + expr(s.value) + ";";
      if (s.kind === "call") return pad + s.fn + "(" + s.args.map(expr).join(", ") + ");";
      if (s.kind === "comment") return pad + "// " + s.text;
      if (s.kind === "empty") return "";
      if (s.kind === "exit") return pad + "EXIT;";
      if (s.kind === "return") return pad + "RETURN;";
      if (s.kind === "if") {
        const parts = [];
        s.branches.forEach(function (b, i) {
          if (b.cond) parts.push(pad + (i === 0 ? "IF " : "ELSIF ") + expr(b.cond) + " THEN");
          else parts.push(pad + "ELSE");
          for (const sub of b.statements) parts.push(stmt(sub, indent + 1));
        });
        parts.push(pad + "END_IF;");
        return parts.join("\n");
      }
      if (s.kind === "for") {
        const parts = [pad + "FOR " + s.index + " := " + expr(s.from) + " TO " + expr(s.to) + (s.by ? " BY " + expr(s.by) : "") + " DO"];
        for (const sub of s.statements) parts.push(stmt(sub, indent + 1));
        parts.push(pad + "END_FOR;");
        return parts.join("\n");
      }
      if (s.kind === "while") {
        const parts = [pad + "WHILE " + expr(s.cond) + " DO"];
        for (const sub of s.statements) parts.push(stmt(sub, indent + 1));
        parts.push(pad + "END_WHILE;");
        return parts.join("\n");
      }
      if (s.kind === "repeat") {
        const parts = [pad + "REPEAT"];
        for (const sub of s.statements) parts.push(stmt(sub, indent + 1));
        parts.push(pad + "UNTIL " + expr(s.cond) + " END_REPEAT;");
        return parts.join("\n");
      }
      if (s.kind === "case") {
        const parts = [pad + "CASE " + expr(s.expr) + " OF"];
        for (const c of s.cases) {
          parts.push(pad + "   " + c.labels.map(expr).join(", ") + ":");
          for (const sub of c.statements) parts.push(stmt(sub, indent + 2));
        }
        if (s.elseStatements) {
          parts.push(pad + "   ELSE");
          for (const sub of s.elseStatements) parts.push(stmt(sub, indent + 2));
        }
        parts.push(pad + "END_CASE;");
        return parts.join("\n");
      }
      return pad + "// unsupported statement";
    }
    for (const s of stIR.statements || []) {
      const line = stmt(s, 0);
      if (line !== "") out.push(line);
    }
    return out.join("\n");
  }

  /* ---------- editor ---------- */
  function StEditor(opts) {
    if (!(this instanceof StEditor)) return new StEditor(opts);
    this.opts = opts || {};
    this.container = this.opts.container || null;
    this.ir = this.opts.ir || { kind: "st", statements: [] };
    this.ctx = this.opts.ctx || null;
    this.onChange = this.opts.onChange || null;
    this.onDiagnostics = this.opts.onDiagnostics || null;
    this._serialized = this._serialize(this.ir);
    this._domReady = hasDom() && !!this.container;
    this._debounced = util && util.debounce
      ? util.debounce(this._reparse.bind(this), 400)
      : (function (self) {
        let t = null;
        const fn = function () {
          if (t !== null) clearTimeout(t);
          t = setTimeout(function () { self._reparse(); }, 400);
        };
        fn.cancel = function () { if (t !== null) { clearTimeout(t); t = null; } };
        return fn;
      })(this);
    if (this._domReady) this._build();
  }

  StEditor.prototype._serialize = function (ir) {
    const r = callReady(stSer.serializeSt, [ir]);
    if (r !== null) return String(r);
    return fallbackSerializeSt(ir);
  };

  StEditor.prototype._build = function () {
    const self = this;
    const wrap = document.createElement("div");
    wrap.className = "st-editor";
    wrap.style.cssText = "position:relative;display:flex;width:100%;height:100%;background:#1e1e1e;overflow:hidden;";
    const gutter = document.createElement("div");
    gutter.className = "st-gutter";
    gutter.style.cssText = "width:44px;background:#252526;color:#858585;font:12px/1.5 Consolas,monospace;text-align:right;padding:8px 6px 8px 0;overflow:hidden;user-select:none;";
    const ta = document.createElement("textarea");
    ta.className = "st-textarea";
    ta.spellcheck = false;
    ta.style.cssText = "flex:1;background:#1e1e1e;color:#d4d4d4;font:12px/1.5 Consolas,monospace;border:none;outline:none;resize:none;padding:8px;white-space:pre;overflow:auto;";
    ta.value = this._serialized;
    wrap.appendChild(gutter);
    wrap.appendChild(ta);
    this.container.innerHTML = "";
    this.container.appendChild(wrap);
    this._ta = ta;
    this._gutter = gutter;
    const updateGutter = function () {
      const n = ta.value.split(/\r\n|\r|\n/).length;
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push(String(i));
      gutter.textContent = lines.join("\n");
      gutter.scrollTop = ta.scrollTop;
    };
    ta.addEventListener("input", function () {
      updateGutter();
      self._debounced();
    });
    ta.addEventListener("scroll", function () { gutter.scrollTop = ta.scrollTop; });
    updateGutter();
  };

  StEditor.prototype._reparse = function () {
    if (!this._domReady) return;
    const text = this._ta.value;
    const errors = annotateStErrors(text);
    if (errors.length) {
      if (this.onDiagnostics) this.onDiagnostics(errors);
      return;
    }
    if (stParse && typeof stParse.parseSt === "function") {
      try {
        const ir = stParse.parseSt(text);
        if (this.onDiagnostics) this.onDiagnostics([]);
        if (this.onChange) this.onChange(ir);
        return;
      } catch (e) {
        if (!/not implemented/i.test(String(e && e.message))) {
          if (this.onDiagnostics) this.onDiagnostics(mapParseError(e, text));
          return;
        }
      }
    }
    /* parseSt not implemented yet: report clean, no IR change */
    if (this.onDiagnostics) this.onDiagnostics([]);
  };

  /* --- API --- */
  StEditor.prototype.getIR = function () { return this.ir; };
  StEditor.prototype.setIR = function (ir) {
    this.ir = ir || { kind: "st", statements: [] };
    const ser = this._serialize(this.ir);
    if (ser !== this._serialized) {
      this._serialized = ser;
      if (this._domReady) {
        this._ta.value = ser;
        this._ta.dispatchEvent(new Event("input", { bubbles: false }));
      }
    }
  };
  StEditor.prototype.getContent = function () {
    return this._domReady ? this._ta.value : this._serialized;
  };

  return { StEditor: StEditor, annotateStErrors: annotateStErrors };
});
