/* L5X Studio - graph-layout.js (T2). Layered (Sugiyama-lite) DAG layout for dataflow graphs.
   See CONTRACT section 7. Pure logic - no DOM, no NaN positions ever.
   Algorithm: longest-path layering (sources at layer 0), cycles broken by marking back
   edges via DFS (they stay in the output and are rendered as-is), then 2 barycenter
   ordering passes (forward + backward), then grid placement. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function fin(v) { return Number.isFinite(v) ? v : 0; }

  function graphLayout(graph, opts) {
    opts = opts || {};
    const direction = opts.direction === "TB" ? "TB" : "LR";
    const nodeW = fin(opts.nodeW !== undefined ? opts.nodeW : 150);
    const nodeH = fin(opts.nodeH !== undefined ? opts.nodeH : 34);
    const hGap = fin(opts.hGap !== undefined ? opts.hGap : 40);
    const vGap = fin(opts.vGap !== undefined ? opts.vGap : 24);
    const nodes = (graph.nodes || []).map(function (n) { return Object.assign({}, n); });
    const edges = (graph.edges || []).map(function (e) { return Object.assign({}, e); });

    const index = {};
    nodes.forEach(function (n, i) { index[n.id] = i; });
    const adj = nodes.map(function () { return []; });      // [ {to, edgeIdx} ]
    const rev = nodes.map(function () { return []; });      // [ {from, edgeIdx} ]
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = index[e.from], b = index[e.to];
      if (a === undefined || b === undefined) continue; // dangling edge: kept in output, not laid out
      adj[a].push({ to: b, edgeIdx: i });
      rev[b].push({ from: a, edgeIdx: i });
    }

    /* 1. Mark back edges. A back edge is any edge that prevents a strict forward
       layering: cycle edges (detected when a Kahn topological pass stalls on a
       strongly-connected leftover set) and "backward" edges whose target layer is
       not deeper than their source layer. We iterate: mark -> re-layer -> re-scan
       until stable, so back edges stay in the output (rendered as-is) but never
       disturb the layering. */
    const back = new Set(); // edge indexes
    function markAndLayer() {
      let marked = true;
      while (marked) {
        marked = false;
        /* Kahn pass ignoring marked edges; leftover nodes indicate cycles */
        const indeg = nodes.map(function () { return 0; });
        for (let i = 0; i < edges.length; i++) {
          if (back.has(i)) continue;
          const e = edges[i];
          const a = index[e.from], b = index[e.to];
          if (a === undefined || b === undefined) continue;
          indeg[b]++;
        }
        const queue = [];
        const order = [];
        for (let i = 0; i < nodes.length; i++) if (indeg[i] === 0) queue.push(i);
        while (queue.length) {
          const v = queue.shift();
          order.push(v);
          for (const entry of adj[v]) {
            if (back.has(entry.edgeIdx)) continue;
            const w = entry.to;
            if (--indeg[w] === 0) queue.push(w);
          }
        }
        if (order.length < nodes.length) {
          /* nodes stuck in cycles: mark one edge among them and retry */
          const leftover = new Set();
          for (let i = 0; i < nodes.length; i++) if (indeg[i] > 0) leftover.add(i);
          for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            const a = index[e.from], b = index[e.to];
            if (a === undefined || b === undefined || back.has(i)) continue;
            if (leftover.has(a) && leftover.has(b)) {
              back.add(i);
              marked = true;
              break;
            }
          }
          if (!marked) {
            /* defensive: mark any edge leaving a leftover node */
            for (let i = 0; i < edges.length; i++) {
              const e = edges[i];
              const a = index[e.from];
              if (a === undefined || back.has(i)) continue;
              if (leftover.has(a)) { back.add(i); marked = true; break; }
            }
          }
          continue;
        }
        /* longest-path layering in Kahn order, ignoring back edges */
        const layer = nodes.map(function () { return 0; });
        for (const v of order) {
          for (const entry of rev[v]) {
            if (back.has(entry.edgeIdx)) continue;
            const u = entry.from;
            if (layer[v] < layer[u] + 1) layer[v] = layer[u] + 1;
          }
        }
        /* scan: any edge whose target is not deeper marks a back edge */
        for (let i = 0; i < edges.length; i++) {
          if (back.has(i)) continue;
          const e = edges[i];
          const a = index[e.from], b = index[e.to];
          if (a === undefined || b === undefined) continue;
          if (layer[b] <= layer[a]) {
            back.add(i);
            marked = true;
            break;
          }
        }
        if (!marked) return layer;
      }
      /* fallback (should not happen): plain longest-path relaxation */
      const layer = nodes.map(function () { return 0; });
      for (let iter = 0; iter < nodes.length + 1; iter++) {
        let changed = false;
        for (let i = 0; i < edges.length; i++) {
          if (back.has(i)) continue;
          const e = edges[i];
          const a = index[e.from], b = index[e.to];
          if (a === undefined || b === undefined) continue;
          if (layer[b] < layer[a] + 1) { layer[b] = layer[a] + 1; changed = true; }
        }
        if (!changed) break;
      }
      return layer;
    }
    const layer = markAndLayer();
    for (const i of back) edges[i].back = true;

    /* 3. Initial in-layer order = original node order. Two barycenter passes. */
    const layers = {};                 // layerNo -> [nodeIdx]
    let maxLayerNo = 0;
    nodes.forEach(function (n, i) {
      const L = layer[i];
      if (L > maxLayerNo) maxLayerNo = L;
      (layers[L] = layers[L] || []).push(i);
    });
    const orderIdx = nodes.map(function (n, i) { return i; }); // node -> index within its layer

    function initOrder() {
      for (let L = 0; L <= maxLayerNo; L++) {
        const list = layers[L] || [];
        list.forEach(function (n, i) { orderIdx[n] = i; });
      }
    }
    initOrder();

    function pass(useForward) {
      const targetDelta = useForward ? 1 : -1;
      const order = [];
      if (useForward) { for (let L = 0; L <= maxLayerNo; L++) order.push(L); }
      else { for (let L = maxLayerNo; L >= 0; L--) order.push(L); }
      for (const L of order) {
        const list = layers[L] || [];
        const scored = list.map(function (n) {
          const nb = useForward ? adj[n] : rev[n];
          let sum = 0, count = 0;
          for (const entry of nb) {
            if (back.has(entry.edgeIdx)) continue;
            const w = useForward ? entry.to : entry.from;
            if (layer[w] !== L + targetDelta) continue;
            sum += orderIdx[w];
            count++;
          }
          const bary = count ? sum / count : orderIdx[n];
          return { n: n, bary: bary, tie: orderIdx[n] };
        });
        scored.sort(function (a, b) {
          const d = a.bary - b.bary;
          if (Math.abs(d) < 1e-9) return a.tie - b.tie;
          return d;
        });
        scored.forEach(function (s, i) { orderIdx[s.n] = i; });
        layers[L] = scored.map(function (s) { return s.n; });
      }
    }
    pass(true);   // forward: barycenter of neighbors in the NEXT layer
    pass(false);  // backward: barycenter of neighbors in the PREVIOUS layer

    /* 4. Assign positions. Rows centered vertically so the graph looks balanced. */
    const rowOf = {};
    let maxRows = 1;
    for (let L = 0; L <= maxLayerNo; L++) {
      const list = layers[L] || [];
      if (list.length > maxRows) maxRows = list.length;
      list.forEach(function (n, i) { rowOf[n] = i; });
    }
    const rowSpan = nodeH + vGap;
    const colSpan = nodeW + hGap;
    nodes.forEach(function (n, i) {
      const L = layer[i];
      const r = rowOf[i] !== undefined ? rowOf[i] : 0;
      const rowOffset = (maxRows - (layers[L] ? layers[L].length : 0)) * rowSpan / 2;
      if (direction === "TB") {
        n.x = fin(rowOffset + r * rowSpan);
        n.y = fin(L * colSpan);
      } else {
        n.x = fin(L * colSpan);
        n.y = fin(rowOffset + r * rowSpan);
      }
      n.w = nodeW;
      n.h = nodeH;
    });

    const width = fin(maxLayerNo * colSpan + nodeW);
    const height = fin((maxRows - 1) * rowSpan + nodeH);
    return { nodes: nodes, edges: edges, width: Math.max(width, 1), height: Math.max(height, 1) };
  }

  return { graphLayout: graphLayout };
});
