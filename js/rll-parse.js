/* L5X Studio - rll-parse.js (T1). Ladder neutral text -> branch IR. See CONTRACT section 2. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;

  /* Tokenize neutral ladder text into:
     {t:"instr", op, args} | {t:"lb"} | {t:"rb"} | {t:"comma"} */
  function tokenize(text) {
    const tokens = [];
    let i = 0, n = text.length;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "[") { tokens.push({ t: "lb" }); i++; continue; }
      if (c === "]") { tokens.push({ t: "rb" }); i++; continue; }
      if (c === ",") { tokens.push({ t: "comma" }); i++; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
        const id = text.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === "(") {
          // scan args: quote-aware, bracket-aware, nested parens tolerated
          const args = [];
          let cur = "";
          let depth = 1;
          let p = k + 1;
          let lastWasComma = false;
          while (p < n && depth > 0) {
            const ch = text[p];
            if (ch === '"' || ch === "'") {
              const q = ch;
              cur += ch; p++;
              lastWasComma = false;
              while (p < n) {
                if (q === "'" && text[p] === "$") { cur += text.slice(p, p + 2); p += 2; continue; } // $x escape
                cur += text[p];
                if (text[p] === q) {
                  if (text[p + 1] === q) { cur += q; p += 2; continue; } // doubled escape
                  p++; break;
                }
                p++;
              }
              continue;
            }
            if (ch === "(") { depth++; cur += ch; p++; lastWasComma = false; continue; }
            if (ch === ")") {
              depth--;
              if (depth === 0) break;
              cur += ch; p++;
              continue;
            }
            if (ch === "[") {
              let bd = 1;
              cur += ch; p++;
              lastWasComma = false;
              while (p < n && bd > 0) {
                const bc = text[p];
                if (bc === '"' || bc === "'") {
                  const q = bc;
                  cur += bc; p++;
                  while (p < n) {
                    cur += text[p];
                    if (text[p] === q) { p++; break; }
                    p++;
                  }
                  continue;
                }
                if (bc === "[") bd++;
                else if (bc === "]") bd--;
                cur += bc; p++;
              }
              continue;
            }
            if (ch === "," && depth === 1) {
              args.push(pushArg(cur));
              cur = "";
              lastWasComma = true;
              p++;
              continue;
            }
            cur += ch; p++;
            lastWasComma = false;
          }
          if (depth !== 0) throw new Error("Unbalanced parentheses in instruction " + id + "(...)");
          // push the final arg unless the list ended with a trailing comma
          if (!lastWasComma && cur.trim() !== "") args.push(pushArg(cur));
          tokens.push({ t: "instr", op: id, args: args });
          i = p + 1;
          continue;
        }
        // bare identifier: only SOR/EOR are tolerated (ignored)
        const up = id.toUpperCase();
        if (up === "SOR" || up === "EOR") { i = j; continue; }
        throw new Error("Unexpected token '" + id + "' at position " + i + " in rung text");
      }
      throw new Error("Unexpected character '" + c + "' at position " + i + " in rung text");
    }
    return tokens;

    function pushArg(raw) {
      const t = raw.trim();
      return t === "" ? "?" : t;
    }
  }

  /* Parser over tokens. Returns the root branch (a series). */
  function parseTokens(tokens) {
    let pos = 0;
    function peek() { return tokens[pos] || { t: "eof" }; }
    function next() { return tokens[pos++] || { t: "eof" }; }

    /* Parse a leg: a series of items, stopping at rb / comma / eof.
       Returns { branch } — the caller inspects the next token. */
    function parseLeg(stopAtComma) {
      const items = [];
      for (;;) {
        const tok = peek();
        if (tok.t === "eof") break;
        if (tok.t === "rb") break;            // caller consumes
        if (tok.t === "comma") {
          if (!stopAtComma) throw new Error("Unexpected ',' in rung text");
          break;                               // caller consumes
        }
        if (tok.t === "lb") {
          next();
          const legs = [];
          let hadComma = false;
          // first leg
          const firstLeg = parseLeg(true);
          legs.push(firstLeg.branch);
          let after = peek();
          while (after.t === "comma") {
            next();
            hadComma = true;
            legs.push(parseLeg(true).branch);
            after = peek();
          }
          if (after.t !== "rb") throw new Error("Unbalanced '[' in rung text (missing ']')");
          next();
          if (legs.length === 1 && !hadComma) {
            // degenerate single-leg group: flatten into the enclosing series
            for (const it of legs[0].items) items.push(it);
          } else {
            items.push(IR.makeParallel(legs));
          }
          continue;
        }
        if (tok.t === "instr") {
          next();
          items.push(IR.makeInstrArgs(tok.op, tok.args));
          continue;
        }
        throw new Error("Unexpected token in rung text");
      }
      return { branch: IR.makeSeries(items) };
    }

    return parseLeg(false).branch;
  }

  /* Parse one rung's neutral text (no XML). */
  function parseRllRung(text) {
    let t = String(text).trim();
    while (t.endsWith(";")) t = t.slice(0, -1).trim();
    if (t === "") return IR.makeSeries([]);
    return parseTokens(tokenize(t));
  }

  return { parseRllRung: parseRllRung, _tokenizeRll: tokenize };
});
