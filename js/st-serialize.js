/* L5X Studio - st-serialize.js (T1). stIR -> Logix structured text. See CONTRACT section 3. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IR = (typeof module !== "undefined" && module.exports) ? require("./ir.js") : root.L5XStudio;

  const IND = "   ";

  function pad(n) { return IND.repeat(n); }

  /* trailing comment: ' // text' for single-line, ' (* text *)' for multi-line */
  function trail(comment) {
    if (comment === null || comment === undefined || comment === "") return "";
    if (comment.indexOf("\n") !== -1) return " (* " + comment + " *)";
    return " // " + comment;
  }

  function exprText(e) {
    return IR.exprToString(e, 0);
  }

  function emitStmts(stmts, ind, out) {
    for (const s of stmts) emitStmt(s, ind, out);
  }

  function emitStmt(s, ind, out) {
    const p = pad(ind);
    switch (s.kind) {
      case "assign":
        out.push(p + s.target + " := " + exprText(s.value) + ";" + trail(s.comment));
        break;
      case "call": {
        const args = (s.args || []).map(a =>
          a && a.kind === "namedArg" ? a.name + " := " + exprText(a.value) : exprText(a));
        out.push(p + s.fn + "(" + args.join(", ") + ");" + trail(s.comment));
        break;
      }
      case "if": {
        const b0 = s.branches[0];
        out.push(p + "IF " + exprText(b0.cond) + " THEN" + (s.comment !== null && s.comment !== undefined ? trail(s.comment) : ""));
        emitStmts(b0.statements, ind + 1, out);
        for (let i = 1; i < s.branches.length; i++) {
          const b = s.branches[i];
          if (b.cond === null) {
            out.push(p + "ELSE");
          } else {
            out.push(p + "ELSIF " + exprText(b.cond) + " THEN");
          }
          emitStmts(b.statements, ind + 1, out);
        }
        out.push(p + "END_IF;");
        break;
      }
      case "for":
        out.push(p + "FOR " + s.index + " := " + exprText(s.from) + " TO " + exprText(s.to) +
          (s.by ? " BY " + exprText(s.by) : "") + " DO" + (s.comment !== null && s.comment !== undefined ? trail(s.comment) : ""));
        emitStmts(s.statements, ind + 1, out);
        out.push(p + "END_FOR;");
        break;
      case "while":
        out.push(p + "WHILE " + exprText(s.cond) + " DO" + (s.comment !== null && s.comment !== undefined ? trail(s.comment) : ""));
        emitStmts(s.statements, ind + 1, out);
        out.push(p + "END_WHILE;");
        break;
      case "repeat":
        out.push(p + "REPEAT");
        emitStmts(s.statements, ind + 1, out);
        out.push(p + "UNTIL " + exprText(s.cond));
        out.push(p + "END_REPEAT;");
        break;
      case "case":
        out.push(p + "CASE " + exprText(s.expr) + " OF");
        for (const c of s.cases) {
          out.push(pad(ind + 1) + c.labels.map(exprText).join(", ") + ":");
          emitStmts(c.statements, ind + 2, out);
        }
        if (s.elseStatements && s.elseStatements.length) {
          out.push(pad(ind + 1) + "ELSE");
          emitStmts(s.elseStatements, ind + 2, out);
        }
        out.push(p + "END_CASE;");
        break;
      case "exit":
        out.push(p + "EXIT;" + trail(s.comment));
        break;
      case "return":
        out.push(p + "RETURN;" + trail(s.comment));
        break;
      case "comment":
        if (s.text.indexOf("\n") !== -1) out.push(p + "(* " + s.text + " *)");
        else out.push(p + "// " + s.text);
        break;
      case "empty":
        out.push("");
        break;
      default:
        out.push(p + "// <unsupported statement " + String(s && s.kind) + ">");
    }
  }

  /* Canonical ST text: '\n' line endings, 3-space indent. */
  function serializeSt(stIR) {
    const out = [];
    emitStmts(stIR.statements || [], 0, out);
    return out.join("\n");
  }

  return { serializeSt: serializeSt };
});
