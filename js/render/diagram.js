/* L5X Studio - render/diagram.js (T2). Render a dataflow graph to SVG with pan/zoom and
   selection. computeDiagramLayout is pure (Node-testable); the DOM parts degrade to a
   no-op without a document. Node kind colors per CONTRACT section 8:
     tag-read=blue, tag-write=green, tag-readwrite=amber, func=gray, logic=purple,
     branch=teal, value=white, ref=slate. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const layout = typeof module !== "undefined" && module.exports ? require("../graph-layout.js") : root.L5XStudio;
  const svg = typeof module !== "undefined" && module.exports ? require("./svg.js") : root.L5XStudio;

  const COLORS = {
    "tag-read": "#1e88e5",
    "tag-write": "#2e7d32",
    "tag-readwrite": "#ffb300",
    "func": "#757575",
    "logic": "#8e24aa",
    "branch": "#00897b",
    "value": "#ffffff",
    "ref": "#546e7a"
  };

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElementNS === "function";
  }

  /* Pure: run graphLayout and return the laid-out graph (nodes carry x/y/w/h). */
  function computeDiagramLayout(graph, opts) {
    if (layout && typeof layout.graphLayout === "function") return layout.graphLayout(graph, opts);
    /* minimal fallback so this helper never throws */
    const nodes = (graph.nodes || []).map(function (n, i) {
      return Object.assign({}, n, { x: i * 190, y: 0, w: 150, h: 34 });
    });
    return { nodes: nodes, edges: (graph.edges || []).map(function (e) { return Object.assign({}, e); }),
      width: nodes.length * 190 + 150, height: 34 };
  }

  function renderDataflow(container, graph, opts) {
    if (!container || !hasDom() || !svg || !svg.el) return null;
    opts = opts || {};
    const laid = computeDiagramLayout(graph, opts);
    const W = Math.max(laid.width + 120, 300);
    const H = Math.max(laid.height + 120, 200);
    const node = svg.el("svg", {
      width: W, height: H, className: "l5x-diagram",
      viewBox: "0 0 " + W + " " + H,
      style: { display: "block", background: "#f7f9fa", cursor: "grab", "user-select": "none" }
    });
    node.appendChild(svg.el("defs", null, svg.el("marker", {
      id: "l5x-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse"
    }, svg.el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#90a4ae" }))));
    const layer = svg.el("g", { className: "diagram-layer" });
    node.appendChild(layer);

    const byId = {};
    for (const n of laid.nodes) byId[n.id] = n;

    /* edges (beziers with arrowheads) */
    for (const e of laid.edges) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) continue;
      const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2;
      const x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
      layer.appendChild(svg.el("path", {
        d: svg.edgePath(x1, y1, x2, y2, opts.direction === "TB" ? "TB" : "LR"),
        fill: "none", stroke: e.back ? "#e53935" : "#90a4ae",
        "stroke-width": 1.5,
        "stroke-dasharray": e.back ? "6,4" : undefined,
        "marker-end": "url(#l5x-arrow)",
        className: "diagram-edge",
        "data-from": e.from, "data-to": e.to
      }, e.label ? svg.el("title", null, String(e.label)) : null));
    }

    /* nodes */
    for (const n of laid.nodes) {
      const fill = COLORS[n.kind] || "#cfd8dc";
      const textFill = (n.kind === "value" || n.kind === "branch") ? "#263238" : "#ffffff";
      const g = svg.el("g", { transform: "translate(" + n.x + "," + n.y + ")", className: "diagram-node", cursor: "pointer" });
      g.appendChild(svg.el("rect", {
        x: 0, y: 0, width: n.w, height: n.h, rx: 6,
        fill: fill, stroke: "#455a64", "stroke-width": 1
      }));
      const label = n.label !== undefined && n.label !== "" ? n.label : (n.tag !== undefined ? n.tag : (n.op || n.id));
      g.appendChild(svg.el("text", {
        x: n.w / 2, y: n.h / 2 + 4, "text-anchor": "middle", "font-size": 12, fill: textFill
      }, String(label)));
      g.appendChild(svg.el("title", null, String(label)));
      g.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (opts.onNodeClick) opts.onNodeClick(n);
      });
      layer.appendChild(g);
    }

    /* pan (drag background) + zoom (wheel) */
    let tx = 0, ty = 0, k = 1;
    let dragging = false, sx = 0, sy = 0;
    function applyTransform() {
      layer.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + k + ")");
    }
    applyTransform();
    node.addEventListener("mousedown", function (ev) {
      if (ev.target !== node && !(ev.target.classList && ev.target.classList.contains("diagram-layer"))) return;
      dragging = true; sx = ev.clientX - tx; sy = ev.clientY - ty;
      node.style.cursor = "grabbing";
      ev.preventDefault();
    });
    const docMove = function (ev) {
      if (!dragging) return;
      tx = ev.clientX - sx; ty = ev.clientY - sy;
      applyTransform();
    };
    const docUp = function () { dragging = false; node.style.cursor = "grab"; };
    if (document.addEventListener) {
      document.addEventListener("mousemove", docMove);
      document.addEventListener("mouseup", docUp);
    }
    node.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      const delta = ev.deltaY > 0 ? 0.9 : 1.1;
      const nk = Math.max(0.2, Math.min(5, k * delta));
      const rect = node.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      tx = px - ((px - tx) / k) * nk;
      ty = py - ((py - ty) / k) * nk;
      k = nk;
      applyTransform();
    }, { passive: false });

    if (typeof container.replaceChildren === "function") container.replaceChildren(node);
    else { container.innerHTML = ""; container.appendChild(node); }
    return { svg: node, layout: laid };
  }

  return { renderDataflow: renderDataflow, computeDiagramLayout: computeDiagramLayout };
});
