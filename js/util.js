/* L5X Studio - util.js (Lead). Generic helpers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  let _uid = 0;
  function uid(prefix) { return (prefix || "id") + "_" + (++_uid).toString(36) + Math.random().toString(36).slice(2, 7); }
  function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function deepClone(x) {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(deepClone);
    const o = {};
    for (const k of Object.keys(x)) o[k] = deepClone(x[k]);
    return o;
  }
  function debounce(fn, ms) {
    let t = null;
    const wrapped = function () {
      const args = arguments, self = this;
      if (t !== null) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    wrapped.cancel = function () { if (t !== null) { clearTimeout(t); t = null; } };
    return wrapped;
  }
  function xmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function xmlAttrEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function cdataSafe(s) { // split "]]>" so content can live inside CDATA
    return String(s).replace(/]]>/g, "]]]]><![CDATA[>");
  }
  function splitLines(s) { return String(s).split(/\r\n|\r|\n/); }
  function truncate(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, n - 1) + "\u2026"; }
  function formatList(items, conj) {
    items = items || [];
    if (items.length === 0) return "";
    if (items.length === 1) return String(items[0]);
    if (items.length === 2) return items[0] + " " + (conj || "and") + " " + items[1];
    return items.slice(0, -1).join(", ") + ", " + (conj || "and") + " " + items[items.length - 1];
  }
  return { uid: uid, assert: assert, clamp: clamp, deepClone: deepClone, debounce: debounce,
    xmlEscape: xmlEscape, xmlAttrEscape: xmlAttrEscape, cdataSafe: cdataSafe,
    splitLines: splitLines, truncate: truncate, formatList: formatList };
});
