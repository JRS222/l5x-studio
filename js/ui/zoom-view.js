/* L5X Studio — shared zoom/pan view helpers.
 *
 * Used by the diagram views (module dataflow, inter-module flow, DeviceNet network) and the
 * ladder/FBD editors. Provides:
 *   attachPanZoom(viewport, canvas, opts)  — drag to pan, wheel to zoom, fit / 100 %
 *   buildMermaidView(body, text, MER, opts)— toolbar + pannable/zoomable rendered Mermaid + source
 *   editorZoomControls(container, target)  — − / + / 100% / Fit buttons for editor SVGs
 * Everything is DOM-guarded so the module can be loaded in Node without throwing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function safeStatus(app, msg, isError) {
    if (app && typeof app.status === "function") { try { app.status(msg, isError); } catch (e) { /* noop */ } }
  }
  function downloadText(fileName, text, mime) {
    try {
      if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
      const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ pan/zoom */
  /* Wraps a canvas element in the supplied viewport element. The canvas is transformed with
     translate+scale; the viewport itself is also a scroll container so that the browser can
     still scroll when the content is larger than the viewport. */
  function attachPanZoom(viewport, canvas, opts) {
    opts = opts || {};
    let zoom = 1, panX = 8, panY = 8, dragging = false, startX = 0, startY = 0;
    function clamp(z) { return Math.max(0.1, Math.min(6, z)); }
    function apply() {
      canvas.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
      canvas.style.transformOrigin = "0 0";
    }
    function contentSize() {
      let w = 800, hgt = 600;
      try {
        const svg = canvas.querySelector ? canvas.querySelector("svg") : null;
        if (svg && svg.getBoundingClientRect) {
          const r = svg.getBoundingClientRect();
          if (r.width) w = r.width;
          if (r.height) hgt = r.height;
        } else if (canvas.scrollWidth) {
          w = canvas.scrollWidth; hgt = canvas.scrollHeight;
        }
      } catch (e) { /* stub DOM */ }
      return { w: w, h: hgt };
    }
    function fit() {
      const n = contentSize();
      const vw = viewport.clientWidth || 800, vh = viewport.clientHeight || 600;
      zoom = clamp(Math.min((vw - 24) / Math.max(n.w, 1), (vh - 24) / Math.max(n.h, 1), 1) || 1);
      panX = Math.max(8, (vw - n.w * zoom) / 2);
      panY = 8;
      apply();
    }
    function zoomBy(d, cx, cy) {
      const before = zoom;
      zoom = clamp(zoom + d);
      if (cx !== undefined && before) {
        panX = cx - ((cx - panX) * zoom / before);
        panY = cy - ((cy - panY) * zoom / before);
      }
      apply();
    }
    function reset() { zoom = 1; panX = 8; panY = 8; apply(); }
    function center() { panX = 8; panY = 8; apply(); }

    viewport.addEventListener("wheel", function (e) {
      if (e.preventDefault) e.preventDefault();
      let rect = { left: 0, top: 0 };
      try { rect = viewport.getBoundingClientRect(); } catch (err) { /* stub */ }
      zoomBy(e.deltaY > 0 ? -0.12 : 0.12, (e.clientX || 0) - rect.left, (e.clientY || 0) - rect.top);
    }, { passive: false });
    viewport.addEventListener("mousedown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      startX = (e.clientX || 0) - panX;
      startY = (e.clientY || 0) - panY;
      viewport.className = (viewport.className || "").replace(/\s*grabbing/, "") + " grabbing";
      if (e.preventDefault) e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      panX = (e.clientX || 0) - startX;
      panY = (e.clientY || 0) - startY;
      apply();
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      viewport.className = (viewport.className || "").replace(/\s*grabbing/, "");
    });
    apply();
    return { fit: fit, reset: reset, zoomBy: zoomBy, center: center, getZoom: function () { return zoom; } };
  }

  /* Small toolbar with zoom controls operating on a pan/zoom controller. */
  function zoomToolbar(controller) {
    const bar = h("span", "zoom-tools");
    const mk = function (label, title, fn) {
      const b = h("button", "btn btn-sm", label);
      b.title = title;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    mk("\u2212", "Zoom out", function () { controller.zoomBy(-0.15); });
    mk("+", "Zoom in", function () { controller.zoomBy(0.15); });
    mk("Fit", "Fit diagram to the view", function () { controller.fit(); });
    mk("100%", "Actual size", function () { controller.reset(); });
    return bar;
  }

  /* Zoom controls for an editor SVG/host (CSS zoom preserves hit testing). */
  function editorZoomControls(host, opts) {
    opts = opts || {};
    const bar = h("span", "zoom-tools editor-zoom");
    let pct = 100;
    function apply() {
      const target = opts.target && opts.target() ? opts.target() : host;
      try {
        if (target && target.style) target.style.zoom = String(pct / 100);
      } catch (e) { /* stub */ }
      label.textContent = pct + "%";
    }
    const label = h("span", "zoom-level", pct + "%");
    const mk = function (text, title, fn) {
      const b = h("button", "btn btn-sm", text);
      b.title = title;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    mk("\u2212", "Zoom out", function () { pct = Math.max(30, pct - 15); apply(); });
    mk("+", "Zoom in", function () { pct = Math.min(300, pct + 15); apply(); });
    mk("Fit", "Fit width", function () {
      try {
        const target = opts.target && opts.target() ? opts.target() : host;
        const root = target && (target.querySelector ? (target.querySelector("svg") || target) : target);
        const svg = root && root.getBoundingClientRect ? root : null;
        const w = svg ? svg.width || svg.getBoundingClientRect().width : 0;
        const vw = host.clientWidth || 800;
        if (w > 0) { pct = Math.max(30, Math.min(300, Math.round((vw - 24) / (w / (pct / 100)) * 100))); }
        else pct = 100;
        apply();
      } catch (e) { pct = 100; apply(); }
    });
    mk("100%", "Actual size", function () { pct = 100; apply(); });
    bar.appendChild(label);
    return bar;
  }

  /* ------------------------------------------------------------------ mermaid view */
  /* Shared pannable/zoomable Mermaid view with downloads and optional toggles. */
  function buildMermaidView(body, text, MER, opts) {
    opts = opts || {};
    const app = opts.app || null;
    const bar = h("div", "module-subbar");
    if (opts.downloads !== false) {
      const copyBtn = h("button", "btn btn-sm", "Copy Mermaid");
      copyBtn.addEventListener("click", function () {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            safeStatus(app, "Mermaid diagram copied to the clipboard.");
            return;
          }
        } catch (e) { /* fall through */ }
        if (!downloadText(opts.baseName + ".mmd", text)) safeStatus(app, "Clipboard not available; use Download .mmd.", true);
      });
      bar.appendChild(copyBtn);
      const dlBtn = h("button", "btn btn-sm", "Download .mmd");
      dlBtn.addEventListener("click", function () { if (!downloadText(opts.baseName + ".mmd", text)) safeStatus(app, "Download not available.", true); });
      bar.appendChild(dlBtn);
      const svgBtn = h("button", "btn btn-sm", "Download .svg");
      svgBtn.addEventListener("click", function () { if (!downloadText(opts.baseName + ".svg", MER.renderToSvg(text), "image/svg+xml")) safeStatus(app, "Download not available.", true); });
      bar.appendChild(svgBtn);
    }
    for (const t of (opts.toggles || [])) {
      const wrap = h("label", "module-check");
      const chk = h("input");
      chk.type = "checkbox";
      chk.checked = !!t.checked;
      (function (toggle) {
        chk.addEventListener("change", function () { toggle.onChange(chk.checked); });
      })(t);
      wrap.appendChild(chk);
      wrap.appendChild(h("span", null, " " + t.label));
      bar.appendChild(wrap);
    }
    body.appendChild(bar);
    const viewport = h("div", "mermaid-viewport");
    const canvas = h("div", "mermaid-canvas");
    viewport.appendChild(canvas);
    body.appendChild(viewport);
    try { canvas.innerHTML = MER.renderToSvg(text); } catch (e) { canvas.appendChild(h("div", "view-note", "Mermaid render failed: " + e.message)); }
    const ctrl = attachPanZoom(viewport, canvas, opts);
    bar.appendChild(zoomToolbar(ctrl));
    if (opts.hint) bar.appendChild(h("span", "view-hint", opts.hint));
    try { ctrl.fit(); } catch (e) { /* stub DOM */ }
    if (opts.source !== false) {
      const det = h("details", "mermaid-text");
      det.appendChild(h("summary", null, "Mermaid source"));
      const pre = h("pre", "routine-text");
      pre.textContent = text;
      det.appendChild(pre);
      body.appendChild(det);
    }
    return { viewport: viewport, canvas: canvas, controller: ctrl };
  }

  return {
    attachPanZoom: attachPanZoom,
    zoomToolbar: zoomToolbar,
    editorZoomControls: editorZoomControls,
    buildMermaidView: buildMermaidView,
    downloadText: downloadText
  };
});
