/* L5X Studio - rll-serialize.js (T1). Branch IR -> ladder neutral text. See CONTRACT section 2. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function serInstr(instr) {
    const args = (instr.args || []).map(a => (a === "" ? "?" : String(a)));
    return instr.op + "(" + args.join(",") + ")";
  }

  function serItem(item) {
    if (!item) return "";
    if (item.kind === "series" || item.kind === "parallel") return serBranch(item);
    return serInstr(item);
  }

  function serBranch(branch) {
    if (!branch) return "";
    if (branch.kind === "parallel") {
      const legs = branch.legs || [];
      if (legs.length === 0) return "";
      if (legs.length === 1) return serBranch(legs[0]); // single-leg parallel: no brackets
      return "[" + legs.map(serBranch).join(" ,") + " ]";
    }
    // series
    return (branch.items || []).map(serItem).join("");
  }

  /* Canonical neutral text WITHOUT trailing ';'. */
  function serializeRllRung(branch) {
    return serBranch(branch);
  }

  return { serializeRllRung: serializeRllRung };
});
