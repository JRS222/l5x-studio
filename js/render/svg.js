/* L5X Studio - render/svg.js (T2). SVG element helpers (namespace-safe) + pure path helpers.
   DOM helpers are guarded: in Node (no document) el()/text()/clear() degrade to plain
   descriptors or no-ops, so requiring this module never crashes. edgePath is pure and
   always returns a valid path string (never NaN). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElementNS === "function";
  }
  function setAttr(node, k, v) {
    if (k === "className") node.setAttribute("class", String(v));
    else node.setAttribute(k, String(v));
  }
  function appendChildren(node, children) {
    if (children === undefined || children === null) return;
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c === undefined || c === null) continue;
      if (typeof c === "string" || typeof c === "number") {
        node.appendChild(document.createTextNode(String(c)));
      } else if (c && c.__text !== undefined) {
        node.appendChild(document.createTextNode(String(c.__text)));
      } else if (c && c.nodeType) {
        node.appendChild(c);
      }
    }
  }

  /* Create an SVG element in the SVG namespace. attrs: {..}; children: string|node|array.
     Returns null outside a DOM (callers must guard). */
  function el(tag, attrs, children) {
    if (!hasDom()) return null;
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null) continue;
        if (k === "style" && typeof v === "object") {
          let css = "";
          for (const p of Object.keys(v)) css += p + ":" + v[p] + ";";
          node.setAttribute("style", css);
        } else setAttr(node, k, v);
      }
    }
    appendChildren(node, children);
    return node;
  }

  /* Text node factory. Outside a DOM returns a descriptor {__text} that el() understands. */
  function text(str) {
    if (!hasDom()) return { __text: String(str) };
    return document.createTextNode(String(str));
  }

  /* Remove all children of a DOM node. No-op without a DOM. */
  function clear(node) {
    if (!node || typeof node.removeChild !== "function") return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* Pure: smooth cubic bezier path between two points.
     direction "LR": control points split the horizontal span (left-right flows);
     direction "TB": control points split the vertical span (top-bottom flows).
     Always returns a valid "M x y C ..." string; non-finite inputs coerce to 0. */
  function edgePath(x1, y1, x2, y2, direction) {
    const r = function (v) {
      const n = Number(v);
      return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
    };
    x1 = r(x1); y1 = r(y1); x2 = r(x2); y2 = r(y2);
    if (direction === "TB") {
      const my = r((y1 + y2) / 2);
      return "M " + x1 + " " + y1 + " C " + x1 + " " + my + ", " + x2 + " " + my + ", " + x2 + " " + y2;
    }
    const mx = r((x1 + x2) / 2);
    return "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
  }

  return { el: el, text: text, clear: clear, edgePath: edgePath };
});
