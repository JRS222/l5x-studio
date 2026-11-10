/* L5X Studio - st-parse.js (T1). Logix structured text -> stIR. See CONTRACT section 3. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;

  const KEYWORDS = {
    IF: 1, THEN: 1, ELSIF: 1, ELSE: 1, END_IF: 1,
    CASE: 1, OF: 1, END_CASE: 1,
    FOR: 1, TO: 1, BY: 1, DO: 1, END_FOR: 1,
    WHILE: 1, END_WHILE: 1, REPEAT: 1, UNTIL: 1, END_REPEAT: 1,
    EXIT: 1, RETURN: 1,
    AND: 1, OR: 1, XOR: 1, MOD: 1, NOT: 1,
    TRUE: 1, FALSE: 1
  };

  const BIN_PREC = {
    "OR": 1, "XOR": 2, "AND": 3, "&": 3,
    "=": 4, "<>": 4, "<": 4, ">": 4, "<=": 4, ">=": 4,
    "+": 5, "-": 5, "*": 6, "/": 6, "MOD": 6,
    "**": 8
  };

  /* --------------------------------------------------------------- lexer */

  function tokenize(src) {
    const tokens = [];
    let i = 0, line = 1;
    const n = src.length;
    /* Scan a "[ ... ]" subscript, handling nested brackets and quoted strings.
       Returns the index just past the closing bracket. */
    function scanBracket(j) {
      let depth = 1, k = j + 1;
      while (k < n && depth > 0) {
        const bc = src[k];
        if (bc === "'") {
          k++;
          while (k < n) {
            const sc = src[k];
            if (sc === "$") { k += 2; continue; }
            if (sc === "'") { k++; break; }
            k++;
          }
          continue;
        }
        if (bc === "[") depth++;
        else if (bc === "]") depth--;
        k++;
      }
      return k;
    }
    while (i < n) {
      const c = src[i];
      if (c === "\n") { line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
      if (c === "/" && src[i + 1] === "/") {
        let j = i + 2;
        while (j < n && src[j] !== "\n") j++;
        tokens.push({ t: "lcom", v: src.slice(i + 2, j), line: line });
        i = j;
        continue;
      }
      if (c === "(" && src[i + 1] === "*") {
        let j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === ")")) {
          if (src[j] === "\n") line++;
          j++;
        }
        if (j >= n) throw new Error("Unterminated (* *) comment at line " + line);
        tokens.push({ t: "bcom", v: src.slice(i + 2, j).trim(), line: line });
        i = j + 2;
        continue;
      }
      if (c === "'") {
        let j = i + 1, raw = "'";
        while (j < n) {
          const ch = src[j];
          if (ch === "$") { raw += src.slice(j, j + 2); j += 2; continue; }
          if (ch === "'") { raw += "'"; j++; break; }
          raw += ch; j++;
        }
        tokens.push({ t: "str", v: raw, line: line });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        let j = i, raw = "";
        if (c === ".") { raw += "."; j++; }
        while (j < n && /[0-9_]/.test(src[j])) { raw += src[j]; j++; }
        if (src[j] === "#") {
          raw += "#"; j++;
          while (j < n && /[0-9a-fA-F_]/.test(src[j])) { raw += src[j]; j++; }
        } else {
          if (src[j] === ".") {
            raw += "."; j++;
            while (j < n && /[0-9_]/.test(src[j])) { raw += src[j]; j++; }
          }
          if (src[j] === "e" || src[j] === "E") {
            let k = j + 1;
            if (src[k] === "+" || src[k] === "-") k++;
            if (/[0-9]/.test(src[k] || "")) {
              raw += src.slice(j, k);
              j = k;
              while (j < n && /[0-9_]/.test(src[j])) { raw += src[j]; j++; }
            }
          }
        }
        tokens.push({ t: "num", v: raw, line: line });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        let raw = src.slice(i, j);
        if (src[j] === "#") {
          // time literal: T#1s, T#500ms, T#1D_2H ...
          while (j < n && /[#A-Za-z0-9_.\-]/.test(src[j])) { raw += src[j]; j++; }
          tokens.push({ t: "time", v: raw, line: line });
          i = j;
          continue;
        }
        // ref continuations: :<num|ident>  .<ident|num>  [raw]
        for (;;) {
          if (src[j] === ":") {
            let k = j + 1;
            if (/[0-9]/.test(src[k] || "")) {
              while (k < n && /[0-9]/.test(src[k])) k++;
            } else if (/[A-Za-z_]/.test(src[k] || "")) {
              while (k < n && /[A-Za-z0-9_]/.test(src[k])) k++;
            } else break;
            raw += src.slice(j, k); j = k;
            continue;
          }
          if (src[j] === ".") {
            let k = j + 1;
            if (/[A-Za-z_]/.test(src[k] || "")) {
              while (k < n && /[A-Za-z0-9_]/.test(src[k])) k++;
            } else if (/[0-9]/.test(src[k] || "")) {
              while (k < n && /[0-9]/.test(src[k])) k++;
            } else if (src[k] === "[") {
              // dynamic bit reference: Tag.[expr] (e.g. NETS[1].ZPA[2].INPUTS.[NDX])
              k = scanBracket(k);
              raw += src.slice(j, k); j = k;
              continue;
            } else break;
            raw += src.slice(j, k); j = k;
            continue;
          }
          if (src[j] === "[") {
            const k = scanBracket(j);
            raw += src.slice(j, k); j = k;
            continue;
          }
          break;
        }
        tokens.push({ t: "ref", v: raw, line: line });
        i = j;
        continue;
      }
      // operators
      const two = src.slice(i, i + 2);
      if (two === ":=" || two === "<=" || two === ">=" || two === "<>" || two === "**") {
        tokens.push({ t: "op", v: two, line: line });
        i += 2;
        continue;
      }
      if ("=<>+-*/&(),[].;:".indexOf(c) !== -1) {
        tokens.push({ t: "op", v: c, line: line });
        i++;
        continue;
      }
      throw new Error("Unexpected character '" + c + "' at line " + line);
    }
    tokens.push({ t: "eof", line: line });
    return tokens;
  }

  /* --------------------------------------------------------------- parser */

  function Parser(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }
  Parser.prototype.peek = function () { return this.toks[this.pos]; };
  Parser.prototype.peek2 = function () { return this.toks[this.pos + 1] || this.toks[this.toks.length - 1]; };
  Parser.prototype.next = function () { return this.toks[this.pos++]; };
  Parser.prototype.error = function (msg, tok) {
    tok = tok || this.peek();
    throw new Error("ST parse error at line " + tok.line + ": " + msg + " (found " + JSON.stringify(tok.v !== undefined ? tok.v : tok.t) + ")");
  };
  Parser.prototype.isKw = function (kw) {
    const t = this.peek();
    return t.t === "ref" && t.v.toUpperCase() === kw;
  };
  Parser.prototype.expectKw = function (kw) {
    const t = this.peek();
    if (t.t !== "ref" || t.v.toUpperCase() !== kw) this.error("expected keyword " + kw, t);
    return this.next();
  };
  Parser.prototype.expectOp = function (v) {
    const t = this.peek();
    if (t.t !== "op" || t.v !== v) this.error("expected '" + v + "'", t);
    return this.next();
  };
  Parser.prototype.eatSemicolon = function () {
    const t = this.peek();
    if (t.t === "op" && t.v === ";") { this.next(); return t.line; }
    return null;
  };
  Parser.prototype.requireSemicolon = function () {
    const line = this.eatSemicolon();
    if (line === null) this.error("expected ';'");
    return line;
  };
  /* Collect trailing comments that start on the given source line. */
  Parser.prototype.trailingComments = function (line) {
    const parts = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "lcom" && t.line === line) { this.next(); parts.push(t.v.trim()); continue; }
      if (t.t === "bcom" && t.line === line) { this.next(); parts.push(t.v.trim()); continue; }
      break;
    }
    return parts.length ? parts.join("\n") : null;
  };

  /* ----- expressions ----- */

  Parser.prototype.parseExpr = function (minPrec) {
    minPrec = minPrec || 0;
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t.t === "op" && BIN_PREC[t.v] !== undefined) op = t.v;
      else if (t.t === "ref" && (t.v.toUpperCase() === "AND" || t.v.toUpperCase() === "OR" ||
                t.v.toUpperCase() === "XOR" || t.v.toUpperCase() === "MOD")) op = t.v.toUpperCase();
      if (op === null) break;
      const prec = BIN_PREC[op];
      if (prec < minPrec) break;
      this.next();
      const rightMin = op === "**" ? prec : prec + 1;
      const right = this.parseExpr(rightMin);
      left = IR.makeBinary(op, left, right);
    }
    return left;
  };

  Parser.prototype.parseUnary = function () {
    const t = this.peek();
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      this.next();
      return IR.makeUnary(t.v, this.parseUnary());
    }
    if (t.t === "ref" && t.v.toUpperCase() === "NOT") {
      this.next();
      return IR.makeUnary("NOT", this.parseUnary());
    }
    return this.parsePow();
  };

  Parser.prototype.parsePow = function () {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t.t === "op" && t.v === "**") {
      this.next();
      return IR.makeBinary("**", base, this.parseUnary());
    }
    return base;
  };

  Parser.prototype.parsePrimary = function () {
    const t = this.peek();
    if (t.t === "num") { this.next(); return IR.makeLiteral(t.v); }
    if (t.t === "str") { this.next(); return IR.makeLiteral(t.v); }
    if (t.t === "time") { this.next(); return IR.makeLiteral(t.v); }
    if (t.t === "op" && t.v === "(") {
      this.next();
      const e = this.parseExpr();
      this.expectOp(")");
      return IR.makeParen(e);
    }
    if (t.t === "ref") {
      const up = t.v.toUpperCase();
      if (up === "TRUE" || up === "FALSE") { this.next(); return IR.makeLiteral(up); }
      this.next();
      const t2 = this.peek();
      if (t2.t === "op" && t2.v === "(") {
        this.next();
        return IR.makeCall(t.v, this.parseArgs());
      }
      return IR.makeRef(t.v);
    }
    this.error("expected expression", t);
  };

  Parser.prototype.parseArgs = function () {
    const args = [];
    const t = this.peek();
    if (t.t === "op" && t.v === ")") { this.next(); return args; }
    for (;;) {
      const a = this.peek();
      const b = this.peek2();
      if (a.t === "op" && (a.v === "," || a.v === ")")) {
        // empty argument (e.g. GSV(a, , b))
        args.push(IR.makeLiteral(""));
      } else if (a.t === "ref" && b.t === "op" && b.v === ":=") {
        const name = a.v;
        this.next(); this.next();
        args.push(IR.makeNamedArg(name, this.parseExpr()));
      } else {
        args.push(this.parseExpr());
      }
      const c = this.peek();
      if (c.t === "op" && c.v === ",") { this.next(); continue; }
      this.expectOp(")");
      break;
    }
    return args;
  };

  /* ----- statements ----- */

  Parser.prototype.parseStatementList = function (stopKws) {
    const stmts = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "eof") break;
      if (t.t === "ref" && stopKws.indexOf(t.v.toUpperCase()) !== -1) break;
      if (t.t === "lcom") { this.next(); stmts.push(IR.makeComment(t.v.trim())); continue; }
      if (t.t === "bcom") { this.next(); stmts.push(IR.makeComment(t.v.trim())); continue; }
      if (t.t === "op" && t.v === ";") { this.next(); continue; } // lone ';' dropped
      stmts.push(this.parseStatement());
    }
    return stmts;
  };

  Parser.prototype.parseStatement = function () {
    const t = this.peek();
    if (t.t !== "ref") {
      // could be a case label (only reachable inside parseCaseBody) or an error
      this.error("expected statement", t);
    }
    const up = t.v.toUpperCase();
    switch (up) {
      case "IF": return this.parseIf();
      case "CASE": return this.parseCase();
      case "FOR": return this.parseFor();
      case "WHILE": return this.parseWhile();
      case "REPEAT": return this.parseRepeat();
      case "EXIT": {
        this.next();
        const line = this.requireSemicolon();
        const c = this.trailingComments(line);
        return { kind: "exit", comment: c };
      }
      case "RETURN": {
        this.next();
        const t2 = this.peek();
        if (t2.t === "op" && t2.v === "(") {
          this.next();
          const t3 = this.peek();
          if (t3.t === "op" && t3.v === ")") this.next();
          else this.error("expected ')' after RETURN(");
        }
        const line = this.requireSemicolon();
        const c = this.trailingComments(line);
        return { kind: "return", comment: c };
      }
    }
    const t2 = this.peek2();
    if (t2.t === "op" && t2.v === ":=") {
      this.next(); this.next();
      const value = this.parseExpr();
      const line = this.requireSemicolon();
      const c = this.trailingComments(line);
      return IR.makeAssign(t.v, value, c);
    }
    if (t2.t === "op" && t2.v === "(") {
      this.next(); this.next();
      const args = this.parseArgs();
      const line = this.requireSemicolon();
      const c = this.trailingComments(line);
      return { kind: "call", fn: t.v, args: args, comment: c };
    }
    this.error("expected ':=' or '(' after " + t.v, t);
  };

  Parser.prototype.parseIf = function () {
    this.next(); // IF
    const cond = this.parseExpr();
    this.expectKw("THEN");
    const comment = this.trailingComments(this.toks[this.pos - 1].line);
    const branches = [];
    let stmts = this.parseStatementList(["ELSIF", "ELSE", "END_IF"]);
    branches.push({ cond: cond, statements: stmts });
    for (;;) {
      if (this.isKw("ELSIF")) {
        const tElsif = this.next();
        const c2 = this.parseExpr();
        this.expectKw("THEN");
        const c3 = this.trailingComments(this.toks[this.pos - 1].line);
        let st2 = this.parseStatementList(["ELSIF", "ELSE", "END_IF"]);
        if (c3 !== null) st2 = [IR.makeComment(c3)].concat(st2);
        branches.push({ cond: c2, statements: st2 });
        continue;
      }
      if (this.isKw("ELSE")) {
        this.next();
        const st3 = this.parseStatementList(["END_IF"]);
        branches.push({ cond: null, statements: st3 });
      }
      this.expectKw("END_IF");
      break;
    }
    this.eatSemicolon();
    return IR.makeIf(branches, comment);
  };

  Parser.prototype.parseFor = function () {
    this.next(); // FOR
    const idx = this.peek();
    if (idx.t !== "ref") this.error("expected index variable in FOR", idx);
    this.next();
    this.expectOp(":=");
    const from = this.parseExpr();
    this.expectKw("TO");
    const to = this.parseExpr();
    let by = null;
    if (this.isKw("BY")) { this.next(); by = this.parseExpr(); }
    this.expectKw("DO");
    const comment = this.trailingComments(this.toks[this.pos - 1].line);
    const stmts = this.parseStatementList(["END_FOR"]);
    this.expectKw("END_FOR");
    this.eatSemicolon();
    return IR.makeFor(idx.v, from, to, by, stmts, comment);
  };

  Parser.prototype.parseWhile = function () {
    this.next(); // WHILE
    const cond = this.parseExpr();
    this.expectKw("DO");
    const comment = this.trailingComments(this.toks[this.pos - 1].line);
    const stmts = this.parseStatementList(["END_WHILE"]);
    this.expectKw("END_WHILE");
    this.eatSemicolon();
    return IR.makeWhile(cond, stmts, comment);
  };

  Parser.prototype.parseRepeat = function () {
    this.next(); // REPEAT
    const stmts = this.parseStatementList(["UNTIL"]);
    this.expectKw("UNTIL");
    const cond = this.parseExpr();
    this.expectKw("END_REPEAT");
    this.eatSemicolon();
    return IR.makeRepeat(cond, stmts, null);
  };

  Parser.prototype.parseCase = function () {
    this.next(); // CASE
    const expr = this.parseExpr();
    this.expectKw("OF");
    const comment = this.trailingComments(this.toks[this.pos - 1].line);
    const cases = [];
    let elseStatements = null;
    for (;;) {
      const t = this.peek();
      if (t.t === "ref" && t.v.toUpperCase() === "ELSE") {
        this.next();
        elseStatements = this.parseCaseBody(["END_CASE"]);
        this.expectKw("END_CASE");
        break;
      }
      if (t.t === "ref" && t.v.toUpperCase() === "END_CASE") { this.next(); break; }
      // labels: comma list of expressions terminated by ':'
      const labels = [];
      for (;;) {
        const lt = this.peek();
        if (lt.t !== "ref" && lt.t !== "num" && lt.t !== "str" && lt.t !== "time" && !(lt.t === "op" && lt.v === "(")) {
          this.error("expected CASE label", lt);
        }
        labels.push(this.parseExpr());
        const c = this.peek();
        if (c.t === "op" && c.v === ",") { this.next(); continue; }
        break;
      }
      this.expectOp(":");
      const body = this.parseCaseBody(["ELSE", "END_CASE"]);
      cases.push({ labels: labels, statements: body });
    }
    this.eatSemicolon();
    return IR.makeCase(expr, cases, elseStatements, comment);
  };

  /* Statements inside a CASE body: stops at a label (expr followed by ':'),
     ELSE or END_CASE. */
  Parser.prototype.parseCaseBody = function (stopKws) {
    const stmts = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "eof") break;
      if (t.t === "ref" && stopKws.indexOf(t.v.toUpperCase()) !== -1) break;
      // label lookahead: primary followed by ':' (not ':=')
      if ((t.t === "ref" || t.t === "num" || t.t === "str" || t.t === "time" || (t.t === "op" && t.v === "(")) &&
          this.isLabelColon()) break;
      if (t.t === "lcom") { this.next(); stmts.push(IR.makeComment(t.v.trim())); continue; }
      if (t.t === "bcom") { this.next(); stmts.push(IR.makeComment(t.v.trim())); continue; }
      if (t.t === "op" && t.v === ";") { this.next(); continue; }
      stmts.push(this.parseStatement());
    }
    return stmts;
  };

  /* Is the token after the upcoming primary a ':' that is not ':='? */
  Parser.prototype.isLabelColon = function () {
    // scan: primary expression tokens end at first ':' / ':=' / ',' / ';' / eof
    let k = this.pos;
    let depth = 0;
    for (;;) {
      const t = this.toks[k];
      if (!t || t.t === "eof") return false;
      if (t.t === "op") {
        if (t.v === "(") depth++;
        else if (t.v === ")") { if (depth === 0) return false; depth--; }
        else if (depth === 0 && (t.v === ":" || t.v === ":=" || t.v === "," || t.v === ";")) {
          return t.v === ":";
        }
      }
      k++;
    }
  };

  /* ----- entry points ----- */

  function parseSt(text) {
    const p = new Parser(tokenize(String(text)));
    const stmts = p.parseStatementList([]);
    if (p.peek().t !== "eof") p.error("unexpected trailing input");
    return IR.makeStIR(stmts);
  }

  function parseStExpression(text) {
    const p = new Parser(tokenize(String(text)));
    const e = p.parseExpr();
    if (p.peek().t !== "eof") p.error("unexpected trailing input in expression");
    return e;
  }

  return { parseSt: parseSt, parseStExpression: parseStExpression };
});
