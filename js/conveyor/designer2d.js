/* L5X Studio - conveyor/designer2d.js (teammate "conveyor-2d3d").
   Canvas-2D drawing editor for the Conveyor Design Studio (conveyor model v2).

   Draws the conveyor plan view from L5XStudio.computeDesign(design). Model v2 support:
     - the conveyor body is ONE filled polygon per segment built from the rounded model
       edges (leftEdge/rightEdge with round joins), so angled joints and curves have a
       proper rounded outline instead of a plain strip,
     - zone panels from zone.quad (alternating tints; tapered-roller zones tinted),
     - zone dividers, zone labels, per-zone sensor dots and motor squares (roller beds),
     - roller ticks when zoomed in; belt conveyors draw a continuous band with a dashed
       centreline, head/tail pulleys and a head drive box,
     - rounded joint fillets annotated with an R/turn-angle arc label (computed.joints),
     - elevated runs: dashed body outline, spiral glyph and "+x.x m" elevation badges,
     - scanner/camera stations from computed.scannedZones (rotated reader glyph + name/
       barcode tag labels, offset to the requested side across the belt),
     - tray tracking labels T1..Tn from computed.tracking and an emphasized outline on
       zones with a scanned tray,
     - model v3: merge junction throat polygons (rounded Y-junction from the spur end to
       the main-line merge point, spur flow arrow, MERGE label, highlighted release zone;
       warning colour + "THROAT PLATE x.xx m GAP" badge when the gap exceeds 1 m) and
       transfer devices (pusher cylinder/piston/plate, rotary table disc with bidirectional
       curved arrows + step angle, pop-up platform rectangle with cross belts + bidirectional
       arrows), plus I/O block markers/labels (XFERxx) near each device.
   Also draws the grid, segment name/length (+BELT/SPIRAL) labels, flow arrow, selection
   highlight, scale bar and cursor readout.

   Interactions (browser only):
     - left click  : select zone (if inside one) else segment -> onSelect(sel)
     - left drag on a segment : move it in the world XY plane (model.updateSegment,
       onChange(newDesign) on every move)
     - wheel : zoom around the cursor
     - middle drag / space-drag / left drag on empty canvas : pan
     - Del / Backspace : delete the selected segment (model.removeSegment + onChange)
   Background click with nothing under the cursor emits onSelect({kind:null,...}) so a
   properties panel can clear itself.

   Pure exports (Node-testable, no DOM):
     worldToScreen(view, pt) / screenToWorld(view, pt)
     hitTestSegment(computed, worldPt, opts?) -> computed segment object | null
     hitTestZone(computed, worldPt, opts?)    -> computed zone object   | null
     renderScene(ctx, computed, opts?)        -> { view, segments, zones }
     fitView(computed, width, height, padding?) -> { scale, offsetX, offsetY }
     segmentBodyPolygon(seg) / zoneQuadPolygon(zone) / pointInPolygon(pt, poly) helpers

   A "view" is { scale, offsetX, offsetY } in CSS pixels per world metre + screen
   offset. World y maps to screen y without a flip (top view; positive rotation appears
   clockwise on screen). ctx only needs the standard canvas-2D methods listed in
   docs/CONVEYOR.md; dashed lines are drawn as explicit segments (no setLineDash) so a
   plain recording stub works.

   UMD/module conventions follow the rest of the app. Sibling dependencies are resolved through
   require("./model.js") in Node and the flat L5XStudio namespace in the browser (the
   browser resolves lazily, so script order only matters before computeDesign is used).
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ===================================================================== */
  /* dependencies                                                          */
  /* ===================================================================== */

  function browserRoot() {
    /* index.html declares the global `root`; fall back to globalThis/self so the
       module also works when it is loaded by a bare test harness. */
    if (typeof root !== "undefined" && root) return root;
    if (typeof globalThis !== "undefined" && globalThis) return globalThis;
    if (typeof self !== "undefined" && self) return self;
    return null;
  }

  function getModelApi() {
    if (typeof module !== "undefined" && module.exports) {
      try { return require("./model.js"); } catch (e) { return null; }
    }
    const r = browserRoot();
    return r && r.L5XStudio ? r.L5XStudio : null;
  }

  function createDefaultDesignSafe() {
    const m = getModelApi();
    return m && typeof m.createDefaultDesign === "function" ? m.createDefaultDesign() : null;
  }

  function computeDesignSafe(design) {
    const m = getModelApi();
    if (m && typeof m.computeDesign === "function" && design) {
      try { return m.computeDesign(design); } catch (e) { /* fall through */ }
    }
    return emptyComputed();
  }

  function emptyComputed() {
    return {
      segments: [], zones: [], blocks: [], totals: {}, warnings: [],
      merges: [], transfers: [],
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }
    };
  }

  function cloneDesign(design, api) {
    try {
      if (api && typeof api.deepClone === "function") return api.deepClone(design);
      return JSON.parse(JSON.stringify(design));
    } catch (e) { return design; }
  }

  /* ===================================================================== */
  /* small numeric helpers                                                 */
  /* ===================================================================== */

  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }
  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function roundTo(v, digits) {
    const p = Math.pow(10, digits || 0);
    return Math.round(v * p) / p;
  }
  function finitePoint(p) {
    if (!p) return { x: 0, y: 0 };
    if (Array.isArray(p)) return { x: num(p[0], 0), y: num(p[1], 0) };
    return { x: num(p.x, 0), y: num(p.y, 0) };
  }

  /* ===================================================================== */
  /* default colours (dark industrial theme, matches css/styles.css)       */
  /* ===================================================================== */

  const DEFAULT_COLORS = {
    background: "#12161c",
    grid: "#1b222b",
    gridMajor: "#26303c",
    axis: "#33404f",
    bandStroke: "#0b0e12",
    zoneDivider: "#a9b8c9",
    zoneLabel: "#c7d2de",
    zoneLabelSelected: "#ffffff",
    segmentLabel: "#e6edf5",
    sensor: "#39c08a",
    sensorStroke: "#0d1117",
    motor: "#e6b450",
    motorStroke: "#1a1408",
    sensorLeader: "#41586b",
    rollerTick: "rgba(255,255,255,0.14)",
    flowArrow: "rgba(230,237,245,0.75)",
    selectedSegment: "#4d9fff",
    selectedZoneStroke: "#4d9fff",
    zoneSelectionFill: "#2f5f92",
    hud: "#8b94a3",
    hudStrong: "#d9dee7",
    /* conveyor-model v2 additions: elevated runs, joints, belt drives, scanners, tracking */
    elevated: "#7fd0ff",
    elevatedBadge: "#a5e4ff",
    joint: "#7fd0ff",
    jointLabel: "#a5e4ff",
    spiral: "#39c08a",
    beltFill: "#2c3138",
    beltAlt: "#333941",
    beltMark: "rgba(207,216,225,0.45)",
    beltPulley: "#9aa7b4",
    beltDrive: "#e6b450",
    scanner: "#c792ea",
    scannerBeam: "rgba(199,146,234,0.55)",
    scannerLens: "#f3e4ff",
    scannerStroke: "#2a1b35",
    track: "#39c08a",
    trackScanned: "#e6b450",
    taperTint: "#5c4a2c",
    /* model v3: merge junctions + transfer devices */
    merge: "#3fb6c9",
    mergeFill: "#1d3d47",
    mergeWarn: "#e06c6c",
    mergeWarnFill: "#3d1f1f",
    mergeZoneFill: "rgba(63,182,201,0.30)",
    mergeZoneStroke: "#7fe0ec",
    mergeLabel: "#8fe8f2",
    throatPlate: "#e6b450",
    transferPusher: "#e6b450",
    transferPusherFill: "#453614",
    transferRotary: "#4d9fff",
    transferRotaryFill: "#1c3450",
    transferPopup: "#39c08a",
    transferPopupFill: "#15392b",
    transferStroke: "#0d1117",
    transferBelt: "#9aa7b4",
    deviceBlock: "#c7d2de",
    /* per-segment strip palettes: fill / alternate zone tint / rail line / tapered-zone tint */
    conveyorPalettes: [
      { fill: "#24405a", alt: "#2a4b69", rail: "#8fb4d9", taper: "#2f5472" },
      { fill: "#1f4a3d", alt: "#255848", rail: "#8fd9bd", taper: "#2a5d4d" },
      { fill: "#3d3558", alt: "#463d64", rail: "#bcaee6", taper: "#4f4570" },
      { fill: "#4d3c26", alt: "#59462e", rail: "#e0bf94", taper: "#63502f" },
      { fill: "#2b4356", alt: "#325065", rail: "#a4c6dd", taper: "#38576e" },
      { fill: "#38472a", alt: "#41542f", rail: "#b9d49a", taper: "#4b5e35" }
    ]
  };

  function resolveColors(overrides) {
    const colors = Object.assign({}, DEFAULT_COLORS);
    if (overrides && typeof overrides === "object") {
      for (const k of Object.keys(overrides)) {
        if (overrides[k] !== undefined && overrides[k] !== null) colors[k] = overrides[k];
      }
    }
    if (!Array.isArray(colors.conveyorPalettes) || !colors.conveyorPalettes.length) {
      colors.conveyorPalettes = DEFAULT_COLORS.conveyorPalettes;
    }
    return colors;
  }

  /* ===================================================================== */
  /* view helpers (pure)                                                   */
  /* ===================================================================== */

  function sanitizeView(view) {
    const v = view || {};
    let scale = num(v.scale, NaN);
    if (!Number.isFinite(scale) || scale <= 0) scale = num(v.k, 1);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    let ox = v.offsetX;
    if (ox === undefined && v.offset && typeof v.offset === "object") ox = v.offset.x;
    if (ox === undefined) ox = v.tx;
    let oy = v.offsetY;
    if (oy === undefined && v.offset && typeof v.offset === "object") oy = v.offset.y;
    if (oy === undefined) oy = v.ty;
    return { scale: scale, offsetX: num(ox, 0), offsetY: num(oy, 0) };
  }

  function worldToScreen(view, pt) {
    const v = sanitizeView(view);
    const p = finitePoint(pt);
    return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
  }

  function screenToWorld(view, pt) {
    const v = sanitizeView(view);
    const p = finitePoint(pt);
    return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };
  }

  function polylineLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return len;
  }

  /* Point + tangent angle at distance t (0..length) along a polyline. */
  function pointAtDistance(pts, t) {
    if (!pts || !pts.length) return { x: 0, y: 0, angleDeg: 0 };
    if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, angleDeg: 0 };
    const dist = clampNum(t, 0, polylineLength(pts));
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, ay = pts[i - 1].y;
      const bx = pts[i].x, by = pts[i].y;
      const d = Math.hypot(bx - ax, by - ay);
      if (acc + d >= dist || i === pts.length - 1) {
        const f = d === 0 ? 0 : clampNum((dist - acc) / d, 0, 1);
        return {
          x: ax + (bx - ax) * f,
          y: ay + (by - ay) * f,
          angleDeg: Math.atan2(by - ay, bx - ax) * 180 / Math.PI
        };
      }
      acc += d;
    }
    const p = pts[pts.length - 1];
    return { x: p.x, y: p.y, angleDeg: 0 };
  }

  /* Closest point on a polyline; returns { dist, t, x, y, angleDeg } or null. */
  function projectOnPolyline(pts, p) {
    if (!pts || pts.length < 2 || !p) return null;
    const px = num(p.x, 0), py = num(p.y, 0);
    let best = null;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, ay = pts[i - 1].y;
      const bx = pts[i].x, by = pts[i].y;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const segLen = Math.sqrt(len2);
      let f = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      f = clampNum(f, 0, 1);
      const qx = ax + dx * f, qy = ay + dy * f;
      const d = Math.hypot(px - qx, py - qy);
      if (!best || d < best.dist) {
        best = {
          dist: d,
          t: acc + segLen * f,
          x: qx, y: qy,
          angleDeg: segLen > 0 ? Math.atan2(dy, dx) * 180 / Math.PI : 0
        };
      }
      acc += segLen;
    }
    return best;
  }

  /* Sub-polyline between distances t0..t1 (used for zone bands on curves). */
  function slicePolyline(pts, t0, t1) {
    if (!pts || pts.length < 2) return pts ? pts.slice() : [];
    const a0 = clampNum(t0, 0, polylineLength(pts));
    const a1 = clampNum(t1, 0, polylineLength(pts));
    const out = [];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, ay = pts[i - 1].y;
      const bx = pts[i].x, by = pts[i].y;
      const edge = Math.hypot(bx - ax, by - ay);
      const e0 = acc, e1 = acc + edge;
      acc = e1;
      if (edge <= 0) continue;
      if (e1 <= a0 || e0 >= a1) continue;
      const s = Math.max(a0, e0), e = Math.min(a1, e1);
      if (e - s < 1e-12) continue;
      const f0 = (s - e0) / edge, f1 = (e - e0) / edge;
      const p0 = { x: ax + (bx - ax) * f0, y: ay + (by - ay) * f0 };
      const p1 = { x: ax + (bx - ax) * f1, y: ay + (by - ay) * f1 };
      const last = out[out.length - 1];
      if (!last || Math.hypot(last.x - p0.x, last.y - p0.y) > 1e-9) out.push(p0);
      out.push(p1);
    }
    if (!out.length) return [pts[0], pts[pts.length - 1]];
    return out;
  }

  /* Offset a polyline sideways by `offset` (positive = left of travel). Uses averaged
     adjacent normals with a miter scale so curves keep their width. */
  function offsetPolyline(pts, offset) {
    const out = [];
    if (!pts || !pts.length) return out;
    if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y }];
    for (let i = 0; i < pts.length; i++) {
      let nx, ny;
      if (i === 0) {
        const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
        const d = Math.hypot(dx, dy) || 1;
        nx = -dy / d; ny = dx / d;
      } else if (i === pts.length - 1) {
        const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
        const d = Math.hypot(dx, dy) || 1;
        nx = -dy / d; ny = dx / d;
      } else {
        const d1x = pts[i].x - pts[i - 1].x, d1y = pts[i].y - pts[i - 1].y;
        const d2x = pts[i + 1].x - pts[i].x, d2y = pts[i + 1].y - pts[i].y;
        const l1 = Math.hypot(d1x, d1y) || 1, l2 = Math.hypot(d2x, d2y) || 1;
        const n1x = -d1y / l1, n1y = d1x / l1;
        const n2x = -d2y / l2, n2y = d2x / l2;
        let mx = n1x + n2x, my = n1y + n2y;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-9) { nx = n1x; ny = n1y; }
        else {
          mx /= ml; my /= ml;
          const cosHalf = mx * n1x + my * n1y;
          const miter = cosHalf > 1e-6 ? 1 / cosHalf : 1;
          nx = mx * miter; ny = my * miter;
        }
      }
      out.push({ x: pts[i].x + nx * offset, y: pts[i].y + ny * offset });
    }
    return out;
  }

  /* Closed polygon for a strip of the given half-width along a polyline. */
  function bandPolygon(pts, halfWidth) {
    const left = offsetPolyline(pts, halfWidth);
    const right = offsetPolyline(pts, -halfWidth);
    const loop = left.slice();
    for (let i = right.length - 1; i >= 0; i--) loop.push(right[i]);
    return loop;
  }

  /* --- model v2: chained geometry / rounded edges / zone quads -------------- */

  function pt2(p) {
    if (!p) return { x: 0, y: 0 };
    return { x: num(p.x, 0), y: num(p.y, 0) };
  }

  /* Closed plan-view body polygon of a segment: leftEdge forward + rightEdge backward.
     model v2 provides rounded-join edges (leftEdge/rightEdge) so angled joints and paths
     are drawn as one filled polygon instead of a plain strip. Falls back to a
     centreline-offset band for older computed objects. */
  function segmentBodyPolygon(seg) {
    if (!seg) return [];
    const left = Array.isArray(seg.leftEdge) ? seg.leftEdge : null;
    const right = Array.isArray(seg.rightEdge) ? seg.rightEdge : null;
    if (left && right && left.length >= 2 && right.length >= 2) {
      const poly = [];
      for (let i = 0; i < left.length; i++) poly.push(pt2(left[i]));
      for (let i = right.length - 1; i >= 0; i--) poly.push(pt2(right[i]));
      return poly;
    }
    const pts = Array.isArray(seg.polyline) ? seg.polyline : [];
    if (pts.length < 2) return [];
    return bandPolygon(pts.map(pt2), num(seg.widthM, 0.6) / 2);
  }

  /* Plan-view quad polygon of a zone (model v2 zone.quad); [] when unavailable. */
  function zoneQuadPolygon(zone) {
    if (!zone) return [];
    if (Array.isArray(zone.quad) && zone.quad.length >= 3) return zone.quad.map(pt2);
    return [];
  }

  /* Even-odd point-in-polygon for [{x,y}] vertices. */
  function pointInPolygon(pt, poly) {
    if (!poly || poly.length < 3) return false;
    const x = num(pt && pt.x, 0), y = num(pt && pt.y, 0);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = num(poly[i].x, 0), yi = num(poly[i].y, 0);
      const xj = num(poly[j].x, 0), yj = num(poly[j].y, 0);
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function distPointToSegment2D(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let f = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    f = clampNum(f, 0, 1);
    return Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f));
  }

  function distToPolygonEdges(p, poly) {
    if (!poly || poly.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const d = distPointToSegment2D(p, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  /* ---- model v3: merge junctions + transfer devices (pure geometry) -------- */

  function dirAtAngle(angleDeg) {
    const a = num(angleDeg, 0) * Math.PI / 180;
    return { x: Math.cos(a), y: Math.sin(a) };
  }
  function normalAtAngle(angleDeg) {
    const t = dirAtAngle(angleDeg);
    return { x: -t.y, y: t.x }; // plan left normal
  }
  function centroidOf(poly) {
    if (!poly || !poly.length) return { x: 0, y: 0 };
    let sx = 0, sy = 0;
    for (const p of poly) { sx += num(p.x, 0); sy += num(p.y, 0); }
    return { x: sx / poly.length, y: sy / poly.length };
  }

  /* Replace polygon corners with sampled quadratic rounds (returns points only). */
  function roundedPolygon(pts, radius) {
    if (!pts || pts.length < 3) return pts ? pts.slice() : [];
    const r = Math.max(0, num(radius, 0));
    if (r <= 0) return pts.slice();
    const out = [];
    const steps = 4;
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
      const v2x = next.x - cur.x, v2y = next.y - cur.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) {
        out.push({ x: num(cur.x, 0), y: num(cur.y, 0) });
        continue;
      }
      const rr = Math.min(r, l1 * 0.45, l2 * 0.45);
      const a = { x: cur.x + v1x / l1 * rr, y: cur.y + v1y / l1 * rr };
      const b = { x: cur.x + v2x / l2 * rr, y: cur.y + v2y / l2 * rr };
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, mt = 1 - t;
        out.push({
          x: mt * mt * a.x + 2 * mt * t * cur.x + t * t * b.x,
          y: mt * mt * a.y + 2 * mt * t * cur.y + t * t * b.y
        });
      }
    }
    return out;
  }

  /* Merge Y-junction throat: the spur end cross-section joined to the main-line
     cross-section at the merge point, with a rounded throat polygon.
     warning = gap (spur end -> merge point) > 1.0 m, which needs a throat plate. */
  function mergeThroatGeometry(computed, merge) {
    if (!computed || !merge) return null;
    const mainSeg = findSegment(computed, merge.mainSegmentId) || null;
    const spurSeg = findSegment(computed, merge.spurEndSegmentId) || null;
    const M = { x: num(merge.x, 0), y: num(merge.y, 0) };
    const mainAngle = num(merge.angleDeg, mainSeg ? mainSeg.endHeadingDeg : 0);
    const mainHalf = mainSeg ? num(mainSeg.widthM, 0.6) / 2 : 0.3;
    const spurHalf = spurSeg ? num(spurSeg.widthM, 0.6) / 2 : 0.3;
    const E = (spurSeg && spurSeg.end)
      ? { x: num(spurSeg.end.x, M.x), y: num(spurSeg.end.y, M.y) }
      : { x: M.x, y: M.y };
    const spurAngle = spurSeg ? num(spurSeg.endHeadingDeg, mainAngle) : mainAngle;
    const measuredGap = Math.hypot(E.x - M.x, E.y - M.y);
    const reportedGap = merge.gapM === undefined || merge.gapM === null ? measuredGap : num(merge.gapM, measuredGap);
    const warning = reportedGap > 1.0;
    const mainN = normalAtAngle(mainAngle);
    const spurN = normalAtAngle(spurAngle);
    const mLeft = { x: M.x + mainN.x * mainHalf, y: M.y + mainN.y * mainHalf };
    const mRight = { x: M.x - mainN.x * mainHalf, y: M.y - mainN.y * mainHalf };
    const eLeft = { x: E.x + spurN.x * spurHalf, y: E.y + spurN.y * spurHalf };
    const eRight = { x: E.x - spurN.x * spurHalf, y: E.y - spurN.y * spurHalf };
    const rawPolygon = [eLeft, eRight, mRight, mLeft];
    const polygon = roundedPolygon(rawPolygon, Math.min(mainHalf, spurHalf) * 0.45);
    const center = centroidOf(polygon);
    const spurDir = measuredGap > 1e-6
      ? { x: (M.x - E.x) / measuredGap, y: (M.y - E.y) / measuredGap }
      : dirAtAngle(spurAngle);
    const arrowLen = Math.max(0.35, Math.min(1.2, reportedGap));
    const labels = [String(merge.name || "MERGE")];
    if (warning) labels.push("THROAT PLATE " + reportedGap.toFixed(2) + " m GAP");
    return {
      name: String(merge.name || "MERGE"),
      mergePoint: M,
      spurEnd: E,
      spurAngleDeg: spurAngle,
      mainAngleDeg: mainAngle,
      spurHalfWidthM: spurHalf,
      mainHalfWidthM: mainHalf,
      gapM: reportedGap,
      measuredGapM: measuredGap,
      warning: warning,
      polygon: polygon,
      rawPolygon: rawPolygon,
      center: center,
      spurDirection: spurDir,
      flowArrow: {
        from: { x: center.x - spurDir.x * arrowLen * 0.5, y: center.y - spurDir.y * arrowLen * 0.5 },
        to: { x: center.x + spurDir.x * arrowLen * 0.5, y: center.y + spurDir.y * arrowLen * 0.5 }
      },
      mergeZoneIndex1Based: merge.mergeZoneIndex1Based === undefined ? null : merge.mergeZoneIndex1Based,
      mergeBlockName: merge.mergeBlockName || null,
      priority: merge.priority || "alternate",
      labels: labels
    };
  }

  /* Transfer device 2D symbol geometry (world XY plan coordinates). Also returns the
     device I/O block name/label and marker position. */
  function transferSymbolGeometry(computed, transfer) {
    if (!computed || !transfer) return null;
    const seg = findSegment(computed, transfer.segmentId) || ((computed.segments || [])[0] || null);
    const half = seg ? num(seg.widthM, 0.6) / 2 : 0.3;
    const angleDeg = num(transfer.angleDeg, 0);
    const t = dirAtAngle(angleDeg);
    const n = normalAtAngle(angleDeg);
    const center = { x: num(transfer.x, 0), y: num(transfer.y, 0) };
    const side = String(transfer.side || "right").toLowerCase() === "left" ? "left" : "right";
    const sideSign = side === "left" ? 1 : -1;
    const type = String(transfer.type || "pusher");
    const zoneLabel = transfer.zoneIndex1Based ? "Z" + transfer.zoneIndex1Based : "";
    const blockLabel = [transfer.ioBlock, transfer.name, zoneLabel].filter(Boolean).join(" \u00b7 ");
    const out = {
      kind: type,
      name: transfer.name || "XFER",
      typeLabel: transfer.typeLabel || type,
      center: center, tangent: t, normal: n, angleDeg: angleDeg,
      side: side, sideSign: sideSign,
      bidirectional: !!transfer.bidirectional,
      directions: Array.isArray(transfer.directions) ? transfer.directions.slice() : [],
      polygon: [], belts: [], arrows: [], arcs: [],
      piston: null, plate: null, circle: null, radius: null, mount: null,
      labels: [], blockName: transfer.ioBlock || null, blockLabel: blockLabel,
      blockMarker: {
        x: center.x + t.x * (half + 0.8), y: center.y + t.y * (half + 0.8)
      },
      zoneIndex1Based: transfer.zoneIndex1Based === undefined ? null : transfer.zoneIndex1Based
    };
    if (type === "rotary_table") {
      const R = Math.max(0.24, Math.min(0.6, half * 1.2));
      out.radius = R;
      out.circle = { cx: center.x, cy: center.y, r: R };
      const arcR = R * 0.62;
      out.arcs = [
        { cx: center.x, cy: center.y, r: arcR, a0Deg: angleDeg - 70, a1Deg: angleDeg + 70, cw: false, dirSign: 1 },
        { cx: center.x, cy: center.y, r: arcR, a0Deg: angleDeg + 70, a1Deg: angleDeg - 70, cw: true, dirSign: -1 }
      ];
      const step = num(transfer.rotary && transfer.rotary.stepDeg, 90);
      out.labels.push("ROTARY " + step + "\u00b0");
    } else if (type === "popup_transfer") {
      const hl = 0.28;
      const hw = half + 0.15;
      out.polygon = [
        { x: center.x - t.x * hl - n.x * hw, y: center.y - t.y * hl - n.y * hw },
        { x: center.x + t.x * hl - n.x * hw, y: center.y + t.y * hl - n.y * hw },
        { x: center.x + t.x * hl + n.x * hw, y: center.y + t.y * hl + n.y * hw },
        { x: center.x - t.x * hl + n.x * hw, y: center.y - t.y * hl + n.y * hw }
      ];
      const count = Math.max(1, Math.round(num(transfer.popup && transfer.popup.beltCount, 3)));
      for (let i = 0; i < count; i++) {
        const f = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * 2 * hl * 0.7;
        out.belts.push({
          a: { x: center.x + t.x * f - n.x * hw, y: center.y + t.y * f - n.y * hw },
          b: { x: center.x + t.x * f + n.x * hw, y: center.y + t.y * f + n.y * hw }
        });
      }
      const dirs = out.directions.length ? out.directions : ["left", "right"];
      for (const d of dirs) {
        const sign = d === "left" ? 1 : -1;
        out.arrows.push({
          a: { x: center.x, y: center.y },
          b: { x: center.x + n.x * sign * (hw + 0.3), y: center.y + n.y * sign * (hw + 0.3) },
          dirSign: sign, kind: "flow"
        });
      }
      out.labels.push("POP-UP \u00d7" + count);
    } else {
      const mountDist = half + 0.6;
      const mount = { x: center.x + n.x * sideSign * mountDist, y: center.y + n.y * sideSign * mountDist };
      const tipDist = half + 0.04;
      const tip = { x: center.x + n.x * sideSign * tipDist, y: center.y + n.y * sideSign * tipDist };
      const bodyCenter = { x: mount.x + n.x * sideSign * 0.12, y: mount.y + n.y * sideSign * 0.12 };
      const bodyHalfT = 0.10, bodyHalfN = 0.17;
      out.mount = mount;
      out.piston = {
        from: mount, to: tip, dirSign: sideSign,
        extendTimeS: num(transfer.pusher && transfer.pusher.extendTimeS, 0.8)
      };
      out.plate = {
        a: { x: tip.x - t.x * 0.2, y: tip.y - t.y * 0.2 },
        b: { x: tip.x + t.x * 0.2, y: tip.y + t.y * 0.2 }
      };
      out.polygon = [
        { x: bodyCenter.x - t.x * bodyHalfT - n.x * sideSign * bodyHalfN, y: bodyCenter.y - t.y * bodyHalfT - n.y * sideSign * bodyHalfN },
        { x: bodyCenter.x + t.x * bodyHalfT - n.x * sideSign * bodyHalfN, y: bodyCenter.y + t.y * bodyHalfT - n.y * sideSign * bodyHalfN },
        { x: bodyCenter.x + t.x * bodyHalfT + n.x * sideSign * bodyHalfN, y: bodyCenter.y + t.y * bodyHalfT + n.y * sideSign * bodyHalfN },
        { x: bodyCenter.x - t.x * bodyHalfT + n.x * sideSign * bodyHalfN, y: bodyCenter.y - t.y * bodyHalfT + n.y * sideSign * bodyHalfN }
      ];
      out.arrows.push({ a: mount, b: tip, dirSign: sideSign, kind: "flow" });
      out.labels.push("PUSHER");
    }
    out.labels.push(blockLabel);
    return out;
  }

  function contentBounds(computed) {
    const segs = (computed && computed.segments) || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let maxWidth = 0;
    for (const seg of segs) {
      maxWidth = Math.max(maxWidth, num(seg.widthM, 0.6));
      const sources = [seg.polyline || [], seg.leftEdge || [], seg.rightEdge || []];
      for (const pts of sources) {
        for (const p of pts) {
          if (!p) continue;
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    const pad = maxWidth / 2 + 0.5; // room for the strip sides / labels
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  /* Fit the computed design into a width x height canvas view. */
  function fitView(computed, width, height, padding) {
    const w = Math.max(40, num(width, 800));
    const h = Math.max(40, num(height, 600));
    const pad = padding === undefined ? 44 : Math.max(0, num(padding, 44));
    const b = contentBounds(computed);
    const spanX = Math.max(0.5, b.maxX - b.minX);
    const spanY = Math.max(0.5, b.maxY - b.minY);
    let scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    if (!Number.isFinite(scale) || scale <= 0) scale = 100;
    scale = clampNum(scale, 0.01, 100000);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { scale: scale, offsetX: w / 2 - cx * scale, offsetY: h / 2 - cy * scale };
  }

  function chooseGridStep(scale) {
    const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 250, 500, 1000];
    for (const s of steps) if (s * scale >= 26) return s;
    return 1000;
  }

  /* ===================================================================== */
  /* hit testing (pure)                                                    */
  /* ===================================================================== */

  function findSegment(computed, segmentId) {
    const segs = (computed && computed.segments) || [];
    for (const s of segs) if (s.id === segmentId) return s;
    return null;
  }

  function findZone(seg, zoneIndex) {
    const zones = (seg && seg.zones) || [];
    for (let i = 0; i < zones.length; i++) {
      if (zones[i].index === zoneIndex || i === zoneIndex) return zones[i];
    }
    return null;
  }

  /* Returns the computed segment under a world point (or null). Topmost (last drawn)
     segment wins. Hit testing uses the rounded-edge body polygon first, then falls back
     to the centreline + half-width test (spiral plan coils overlap, so both are useful).
     opts.tolerance adds world-unit slack (e.g. 5 px / view.scale). */
  function hitTestSegment(computed, worldPt, opts) {
    if (!computed || !worldPt) return null;
    const segs = computed.segments || [];
    const extra = Math.max(0, num(opts && opts.tolerance, 0));
    const p = finitePoint(worldPt);
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      if (!seg) continue;
      const body = segmentBodyPolygon(seg);
      if (body.length >= 3) {
        if (pointInPolygon(p, body)) return seg;
        if (extra > 0 && distToPolygonEdges(p, body) <= extra) return seg;
      }
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      if (!seg || !seg.polyline || seg.polyline.length < 2) continue;
      const half = num(seg.widthM, 0.6) / 2;
      const pr = projectOnPolyline(seg.polyline, p);
      if (pr && pr.dist <= half + extra) return seg;
    }
    return null;
  }

  /* Returns the computed zone under a world point (global .index), or null.
     Uses the zone quad first (exact), then tolerance around the quad, then the
     centreline-length fallback for older/synthetic computed objects. */
  function hitTestZone(computed, worldPt, opts) {
    if (!computed || !worldPt) return null;
    const zones = computed.zones || [];
    const p = finitePoint(worldPt);
    const extra = Math.max(0, num(opts && opts.tolerance, 0));
    for (let i = zones.length - 1; i >= 0; i--) {
      const quad = zoneQuadPolygon(zones[i]);
      if (quad.length >= 3 && pointInPolygon(p, quad)) return zones[i];
    }
    if (extra > 0) {
      for (let i = zones.length - 1; i >= 0; i--) {
        const quad = zoneQuadPolygon(zones[i]);
        if (quad.length >= 3 && distToPolygonEdges(p, quad) <= extra) return zones[i];
      }
    }
    const seg = hitTestSegment(computed, p, opts);
    if (!seg) return null;
    const segZones = seg.zones || [];
    if (!segZones.length) return null;
    const pr = projectOnPolyline(seg.polyline || [], p);
    if (!pr) return segZones[0];
    const len = num(seg.lengthM, polylineLength(seg.polyline || []));
    if (!(len > 0)) return segZones[0];
    const zoneLen = len / segZones.length;
    const idx = clampNum(Math.floor(pr.t / zoneLen), 0, segZones.length - 1);
    return segZones[Math.round(idx)] || segZones[0];
  }

  /* ===================================================================== */
  /* canvas drawing primitives (only the ctx methods listed in the docs)   */
  /* ===================================================================== */

  function polylinePath(ctx, pts) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }

  function strokePolyline(ctx, pts, color, lineWidth) {
    if (!pts || pts.length < 2) return;
    if (color) ctx.strokeStyle = color;
    if (lineWidth !== undefined) ctx.lineWidth = lineWidth;
    polylinePath(ctx, pts);
    ctx.stroke();
  }

  function polygonPath(ctx, pts) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[0].x, pts[0].y);
  }

  function fillPolygon(ctx, pts, color) {
    if (!pts || pts.length < 3) return;
    if (color) ctx.fillStyle = color;
    polygonPath(ctx, pts);
    ctx.fill();
  }

  function strokePolygon(ctx, pts, color, lineWidth) {
    if (!pts || pts.length < 3) return;
    if (color) ctx.strokeStyle = color;
    if (lineWidth !== undefined) ctx.lineWidth = lineWidth;
    polygonPath(ctx, pts);
    ctx.stroke();
  }

  function drawCircle(ctx, x, y, radius, fill, stroke, lineWidth) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth === undefined ? 1 : lineWidth;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function squarePath(ctx, x, y, size) {
    const h = size / 2;
    ctx.beginPath();
    ctx.moveTo(x - h, y - h);
    ctx.lineTo(x + h, y - h);
    ctx.lineTo(x + h, y + h);
    ctx.lineTo(x - h, y + h);
    ctx.lineTo(x - h, y - h);
  }

  /* ===================================================================== */
  /* scene renderer (pure; designed for a recording ctx stub in tests)     */
  /* ===================================================================== */

  function drawGrid(ctx, view, width, height, colors, opts) {
    const topLeft = screenToWorld(view, { x: 0, y: 0 });
    const bottomRight = screenToWorld(view, { x: width, y: height });
    const minX = Math.min(topLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, bottomRight.y);
    const step = num(opts.gridStepM, chooseGridStep(view.scale));
    if (!(step > 0) || step * view.scale < 4) return;
    const maxLines = 4000;

    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    let i0 = Math.ceil(minX / step), i1 = Math.floor(maxX / step);
    for (let i = i0; i <= i1 && i - i0 < maxLines; i++) {
      if (i % 5 === 0) continue;
      const sx = i * step * view.scale + view.offsetX;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }
    let j0 = Math.ceil(minY / step), j1 = Math.floor(maxY / step);
    for (let j = j0; j <= j1 && j - j0 < maxLines; j++) {
      if (j % 5 === 0) continue;
      const sy = j * step * view.scale + view.offsetY;
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }
    ctx.stroke();

    ctx.strokeStyle = colors.gridMajor;
    ctx.beginPath();
    for (let i = i0; i <= i1 && i - i0 < maxLines; i++) {
      if (i % 5 !== 0) continue;
      const sx = i * step * view.scale + view.offsetX;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }
    for (let j = j0; j <= j1 && j - j0 < maxLines; j++) {
      if (j % 5 !== 0) continue;
      const sy = j * step * view.scale + view.offsetY;
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }
    ctx.stroke();

    /* world origin axes */
    const origin = worldToScreen(view, { x: 0, y: 0 });
    if (origin.x >= 0 && origin.x <= width) strokePolyline(ctx, [{ x: origin.x, y: 0 }, { x: origin.x, y: height }], colors.axis, 1);
    if (origin.y >= 0 && origin.y <= height) strokePolyline(ctx, [{ x: 0, y: origin.y }, { x: width, y: origin.y }], colors.axis, 1);
  }

  function drawFlowArrow(ctx, pts, len, view, colors) {
    if (!pts || pts.length < 2 || !(len > 0)) return;
    const t = clampNum(len * 0.1, 0.05, 0.6);
    const q = pointAtDistance(pts, t);
    const s = worldToScreen(view, q);
    const a = q.angleDeg * Math.PI / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const nx = -uy, ny = ux;
    const size = 6;
    ctx.beginPath();
    ctx.moveTo(s.x + ux * size, s.y + uy * size);
    ctx.lineTo(s.x - ux * size * 0.6 + nx * size * 0.9, s.y - uy * size * 0.6 + ny * size * 0.9);
    ctx.lineTo(s.x - ux * size * 0.6 - nx * size * 0.9, s.y - uy * size * 0.6 - ny * size * 0.9);
    ctx.lineTo(s.x + ux * size, s.y + uy * size);
    ctx.fillStyle = colors.flowArrow;
    ctx.fill();
  }

  /* ---- extra drawing primitives (only documented ctx methods used) -------- */

  /* Dashed polyline built from explicit dash segments (no setLineDash needed). */
  function strokeDashedPolyline(ctx, pts, color, lineWidth, dashLen, gapLen) {
    if (!pts || pts.length < 2) return;
    const dash = Math.max(0.5, num(dashLen, 6));
    const gap = Math.max(0.5, num(gapLen, 5));
    if (color) ctx.strokeStyle = color;
    if (lineWidth !== undefined) ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let drawing = true;
    let remaining = dash;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ex = b.x - a.x, ey = b.y - a.y;
      const edgeLen = Math.hypot(ex, ey);
      if (edgeLen < 1e-9) continue;
      let t = 0;
      while (t < edgeLen - 1e-9) {
        const step = Math.min(remaining, edgeLen - t);
        const t0 = t / edgeLen, t1 = (t + step) / edgeLen;
        if (drawing) {
          ctx.moveTo(a.x + ex * t0, a.y + ey * t0);
          ctx.lineTo(a.x + ex * t1, a.y + ey * t1);
        }
        t += step;
        remaining -= step;
        if (remaining <= 1e-9) {
          drawing = !drawing;
          remaining = drawing ? dash : gap;
        }
      }
    }
    ctx.stroke();
  }

  function strokeDashedPolygon(ctx, pts, color, lineWidth, dashLen, gapLen) {
    if (!pts || pts.length < 3) return;
    const closed = pts.concat([pts[0]]);
    strokeDashedPolyline(ctx, closed, color, lineWidth, dashLen, gapLen);
  }

  function rectPath(ctx, x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y);
  }

  /* Small circular-arrow glyph marking a spiral / inclined run. */
  function drawSpiralGlyph(ctx, x, y, radius, color) {
    const r = Math.max(3, num(radius, 5.5));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0.6, 5.5);
    ctx.stroke();
    const a = 0.6;
    const tipX = x + r * Math.cos(a), tipY = y + r * Math.sin(a);
    const tx = -Math.sin(a), ty = Math.cos(a);
    const nx = Math.cos(a), ny = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(tipX + tx * 4, tipY + ty * 4);
    ctx.lineTo(tipX - nx * 3, tipY - ny * 3);
    ctx.lineTo(tipX + nx * 3, tipY + ny * 3);
    ctx.lineTo(tipX + tx * 4, tipY + ty * 4);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* --- segment body: one rounded-edge polygon from model leftEdge/rightEdge --- */
  function drawSegmentBand(ctx, seg, si, view, colors, sel, opts) {
    const pts = Array.isArray(seg.polyline) ? seg.polyline : [];
    if (pts.length < 2) return;
    const body = segmentBodyPolygon(seg);
    if (body.length < 3) return;
    const screenBody = body.map(function (p) { return worldToScreen(view, p); });
    const half = num(seg.widthM, 0.6) / 2;
    const planLen = polylineLength(pts);
    const palette = colors.conveyorPalettes[si % colors.conveyorPalettes.length];
    const isBelt = (seg.conveyorType || "roller") === "belt";
    const zones = Array.isArray(seg.zones) ? seg.zones : [];
    const selectedSeg = !!(sel && sel.segmentId !== null && sel.segmentId !== undefined && sel.segmentId === seg.id);
    const selZone = selectedSeg && sel.kind === "zone" ? sel.zoneIndex : null;

    fillPolygon(ctx, screenBody, isBelt ? colors.beltFill : palette.fill);

    /* zone panels from the computed zone quads (rounded joints included) */
    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      const quad = zoneQuadPolygon(z);
      if (quad.length < 3) continue;
      const poly = quad.map(function (p) { return worldToScreen(view, p); });
      let fill;
      if (isBelt) fill = (zi % 2 === 0) ? colors.beltAlt : colors.beltFill;
      else if (z.rollerType === "tapered") fill = palette.taper || palette.alt;
      else fill = (zi % 2 === 0) ? palette.fill : palette.alt;
      const isSelected = selZone !== null && (z.index === selZone || zi === selZone);
      if (isSelected) fill = colors.zoneSelectionFill;
      fillPolygon(ctx, poly, fill);
    }

    if (isBelt) {
      /* continuous belt: dashed centreline + head/tail pulleys + drive box */
      const planPts = pts.map(function (p) { return worldToScreen(view, p); });
      strokeDashedPolyline(ctx, planPts, colors.beltMark, 1.2, 6, 5);
      const s0 = worldToScreen(view, pts[0]), s1 = worldToScreen(view, pts[pts.length - 1]);
      const pr = Math.max(3, half * view.scale * 0.7);
      drawCircle(ctx, s0.x, s0.y, pr, colors.beltPulley, colors.bandStroke, 1.2);
      drawCircle(ctx, s1.x, s1.y, pr, colors.beltPulley, colors.bandStroke, 1.2);
      const aStart = num(seg.startHeadingDeg, 0) * Math.PI / 180;
      ctx.save();
      ctx.translate(s0.x, s0.y);
      ctx.rotate(aStart);
      ctx.fillStyle = colors.beltDrive;
      ctx.fillRect(-6, -(pr + 12), 12, 9);
      ctx.strokeStyle = colors.motorStroke;
      ctx.lineWidth = 1;
      rectPath(ctx, -6, -(pr + 12), 12, 9);
      ctx.stroke();
      ctx.restore();
    }

    /* strip outline + coloured rail lines along both sides (rounded edges) */
    const left = (Array.isArray(seg.leftEdge) && seg.leftEdge.length >= 2)
      ? seg.leftEdge.map(function (p) { return worldToScreen(view, p); })
      : offsetPolyline(pts, half).map(function (p) { return worldToScreen(view, p); });
    const right = (Array.isArray(seg.rightEdge) && seg.rightEdge.length >= 2)
      ? seg.rightEdge.map(function (p) { return worldToScreen(view, p); })
      : offsetPolyline(pts, -half).map(function (p) { return worldToScreen(view, p); });
    strokePolyline(ctx, left, colors.bandStroke, 3);
    strokePolyline(ctx, right, colors.bandStroke, 3);
    strokePolyline(ctx, left, isBelt ? colors.beltPulley : palette.rail, 1.5);
    strokePolyline(ctx, right, isBelt ? colors.beltPulley : palette.rail, 1.5);

    /* roller ticks (roller conveyors only; distributed along the plan length) */
    const pitch = num(opts.rollerPitchM, 0);
    const halfPx = half * view.scale;
    if (!isBelt && pitch > 0 && planLen > 0 && pitch * view.scale >= 3) {
      const len3 = num(seg.lengthM, planLen) || planLen;
      const n = Math.min(500, Math.floor(len3 / pitch + 1e-9));
      ctx.strokeStyle = colors.rollerTick;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const tPlan = planLen * Math.min(1, (i * pitch) / len3);
        const q = pointAtDistance(pts, tPlan);
        const a = q.angleDeg * Math.PI / 180;
        const nx = -Math.sin(a), ny = Math.cos(a);
        const s = worldToScreen(view, q);
        ctx.moveTo(s.x - nx * halfPx, s.y - ny * halfPx);
        ctx.lineTo(s.x + nx * halfPx, s.y + ny * halfPx);
      }
      ctx.stroke();
    }

    drawFlowArrow(ctx, pts, planLen, view, colors);
  }

  function drawSegmentDetails(ctx, seg, si, view, colors, sel, info) {
    info = info || {};
    const pts = Array.isArray(seg.polyline) ? seg.polyline : [];
    if (pts.length < 2) return;
    const zones = Array.isArray(seg.zones) ? seg.zones : [];
    const half = num(seg.widthM, 0.6) / 2;
    const halfPx = half * view.scale;
    const planLen = polylineLength(pts);
    const isBelt = (seg.conveyorType || "roller") === "belt";
    const z0 = num(seg.zStart, 0), z1 = num(seg.zEnd, 0);
    const elevated = Math.abs(z0) > 0.05 || Math.abs(z1) > 0.05 || Math.abs(z1 - z0) > 0.05;

    /* elevated runs get a dashed/hatched outline in the plan view */
    if (elevated) {
      strokeDashedPolygon(ctx, segmentBodyPolygon(seg).map(function (p) { return worldToScreen(view, p); }),
        colors.elevated, 1.25, 7, 6);
    }

    if (zones.length) {
      /* zone divider lines (start edge of each zone quad) */
      if (zones.length > 1) {
        ctx.strokeStyle = colors.zoneDivider;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        for (let zi = 1; zi < zones.length; zi++) {
          const quad = zoneQuadPolygon(zones[zi]);
          if (quad.length < 4) continue;
          const a = worldToScreen(view, quad[0]);
          const b = worldToScreen(view, quad[3]);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }

      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        const quad = zoneQuadPolygon(z);
        let cx, cy, angleDeg, startX, startY;
        if (quad.length >= 4) {
          cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
          cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
          startX = (quad[0].x + quad[3].x) / 2;
          startY = (quad[0].y + quad[3].y) / 2;
          angleDeg = num(z.angleDeg, 0);
        } else {
          const qm = pointAtDistance(pts, planLen * (zi + 0.5) / zones.length);
          const q0 = pointAtDistance(pts, planLen * zi / zones.length);
          cx = qm.x; cy = qm.y; angleDeg = qm.angleDeg;
          startX = q0.x; startY = q0.y;
        }
        const a = angleDeg * Math.PI / 180;
        const nx = -Math.sin(a), ny = Math.cos(a);
        const sMid = worldToScreen(view, { x: cx, y: cy });
        const sStart = worldToScreen(view, { x: startX, y: startY });
        const isSelected = !!(sel && sel.segmentId === seg.id && sel.kind === "zone" &&
          (sel.zoneIndex === z.index || sel.zoneIndex === zi));
        const track = info.trackByZone ? info.trackByZone[z.index1Based] : null;
        const scanned = !!(info.trackingEnabled && track && track.scanned);

        /* scanned zone: emphasized outline */
        if (scanned && quad.length >= 3) {
          strokePolygon(ctx, quad.map(function (p) { return worldToScreen(view, p); }), colors.trackScanned, 1.6);
        }

        /* sensor dot at the zone start, on the +normal (left) side */
        const dotX = sStart.x + nx * (halfPx + 10);
        const dotY = sStart.y + ny * (halfPx + 10);
        strokePolyline(ctx, [
          { x: sStart.x + nx * halfPx, y: sStart.y + ny * halfPx },
          { x: dotX, y: dotY }
        ], colors.sensorLeader, 1);
        drawCircle(ctx, dotX, dotY, 4.2, colors.sensor, colors.sensorStroke, 1.25);

        /* motor marker at the zone centre (roller conveyors; belt drive is in the band) */
        if (!isBelt) {
          ctx.save();
          ctx.translate(sMid.x, sMid.y);
          ctx.rotate(a);
          ctx.fillStyle = colors.motor;
          ctx.fillRect(-5.5, -5.5, 11, 11);
          ctx.strokeStyle = colors.motorStroke;
          ctx.lineWidth = 1.25;
          squarePath(ctx, 0, 0, 11);
          ctx.stroke();
          ctx.restore();
        }

        /* zone index label on the -normal (right) side */
        const labelX = sMid.x - nx * (halfPx + 14);
        const labelY = sMid.y - ny * (halfPx + 14);
        ctx.fillStyle = isSelected ? colors.zoneLabelSelected : colors.zoneLabel;
        ctx.font = isSelected ? 'bold 12px "Segoe UI", Roboto, sans-serif' : '11px "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Z" + num(z.zoneInSegment1Based, zi + 1), labelX, labelY);

        /* tracking slot label (T1..Tn) + scanned emphasis */
        let extra = 14;
        if (info.trackingEnabled && track) {
          extra = 26;
          ctx.fillStyle = scanned ? colors.trackScanned : colors.track;
          ctx.font = 'bold 10.5px "Cascadia Mono", Consolas, monospace';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("T" + track.trackIndex1Based, sMid.x - nx * (halfPx + extra), sMid.y - ny * (halfPx + extra));
        }

        /* elevation badge (+x.x m) on elevated runs */
        const zVal = num(z.z, 0);
        if (elevated && Math.abs(zVal) >= 0.1) {
          const off = halfPx + extra + 12;
          ctx.fillStyle = colors.elevatedBadge;
          ctx.font = '10px "Cascadia Mono", Consolas, monospace';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText((zVal >= 0 ? "+" : "") + zVal.toFixed(1) + " m", sMid.x - nx * off, sMid.y - ny * off);
        }
      }
    }

    /* segment name + length (+ belt/spiral/elevation) label near the start */
    const tLabel = clampNum(planLen * 0.08, 0, 0.6);
    const qL = pointAtDistance(pts, tLabel);
    const aL = qL.angleDeg * Math.PI / 180;
    const nxL = -Math.sin(aL), nyL = Math.cos(aL);
    const sL = worldToScreen(view, qL);
    ctx.fillStyle = colors.segmentLabel;
    ctx.font = 'bold 12.5px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let label = String(seg.name !== undefined && seg.name !== null ? seg.name : ("SEG" + (si + 1))) +
      "  ·  " + num(seg.lengthM, planLen).toFixed(1) + " m";
    if (isBelt) label += "  ·  BELT";
    if (seg.spiral) {
      const rise = Math.abs(num(seg.spiral.heightM, z1 - z0));
      label += "  ·  SPIRAL " + (String(seg.spiral.direction).toLowerCase() === "down" ? "DOWN" : "UP") +
        " +" + rise.toFixed(1) + " m";
    } else if (elevated) {
      label += "  ·  z " + z0.toFixed(1) + "\u2192" + z1.toFixed(1) + " m";
    }
    const segLabelX = sL.x - nxL * (halfPx + 34);
    const segLabelY = sL.y - nyL * (halfPx + 34);
    ctx.fillText(label, segLabelX, segLabelY);
    if (seg.spiral) drawSpiralGlyph(ctx, segLabelX - 70, segLabelY, 5, colors.spiral);
  }

  /* Filled fillet discs at chain joints, drawn UNDER the segment bodies: a circle of
     radius filletRadiusM (= half the strip width) centred on the joint vertex is exactly
     the model's round-join corner, so it completes the rounded outer edge between two
     segments without a wedge gap. */
  function drawJointFill(ctx, scene, view, colors) {
    const joints = (scene && scene.joints) || [];
    if (!joints.length) return;
    const segs = (scene && scene.segments) || [];
    const palettes = colors.conveyorPalettes;
    for (const j of joints) {
      const p = j.point || { x: 0, y: 0 };
      const g = worldToScreen(view, { x: num(p.x, 0), y: num(p.y, 0) });
      const rPx = Math.max(1, num(j.filletRadiusM, 0.3) * view.scale);
      const seg = segs[j.index] || segs[segs.length - 1];
      const isBelt = seg && String(seg.conveyorType || "").toLowerCase() === "belt";
      const palette = palettes[(j.index || 0) % palettes.length];
      drawCircle(ctx, g.x, g.y, rPx, isBelt ? colors.beltFill : palette.fill, null, 0);
    }
  }

  /* Rounded joint fillets: an arc centred on the joint vertex with the fillet radius
     (half the strip width by construction of model offsetPolyline round joins). Only
     angled joints are annotated; zero-turn chain joints need no fillet. */
  function drawJoints(ctx, scene, view, colors) {
    const joints = (scene && scene.joints) || [];
    const segs = (scene && scene.segments) || [];
    for (const j of joints) {
      const turn = num(j.turnDeg, 0);
      if (Math.abs(turn) < 0.5) continue;
      const prev = segs[j.index - 1];
      const p = j.point || { x: 0, y: 0 };
      const g = worldToScreen(view, { x: num(p.x, 0), y: num(p.y, 0) });
      const rPx = Math.max(4, num(j.filletRadiusM, 0.3) * view.scale);
      const prevEnd = prev ? num(prev.endHeadingDeg, 0) : 0;
      const sideSign = turn >= 0 ? -1 : 1; // outer edge normal direction
      const a0 = (prevEnd + sideSign * 90) * Math.PI / 180;
      const sweep = turn * Math.PI / 180;
      ctx.beginPath();
      ctx.arc(g.x, g.y, rPx, a0, a0 + sweep, sweep < 0);
      ctx.strokeStyle = colors.joint;
      ctx.lineWidth = 2;
      ctx.stroke();
      const mid = a0 + sweep / 2;
      ctx.fillStyle = colors.jointLabel;
      ctx.font = '10.5px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("R" + num(j.filletRadiusM, 0.3).toFixed(2) + " \u00b7 " + Math.round(Math.abs(turn)) + "\u00b0",
        g.x + (rPx + 16) * Math.cos(mid), g.y + (rPx + 16) * Math.sin(mid));
    }
  }

  /* Barcode / camera scan-station markers from computed.scannedZones[]. */
  function drawScanners(ctx, scene, view, colors) {
    const scans = (scene && scene.scannedZones) || [];
    if (!scans.length) return;
    const segs = (scene && scene.segments) || [];
    for (const s of scans) {
      const seg = segs.find(function (x) { return x.id === s.segmentId; }) || null;
      const width = seg ? num(seg.widthM, 0.6) : 0.6;
      const a = num(s.angleDeg, 0) * Math.PI / 180;
      const nx = -Math.sin(a), ny = Math.cos(a);
      const side = String(s.side || "right").toLowerCase() === "left" ? 1 : -1;
      const off = width / 2 + 0.3;
      const wx = num(s.x, 0) + nx * off * side;
      const wy = num(s.y, 0) + ny * off * side;
      const center = worldToScreen(view, { x: num(s.x, 0), y: num(s.y, 0) });
      const p = worldToScreen(view, { x: wx, y: wy });
      strokePolyline(ctx, [center, p], colors.scannerBeam, 1);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(a);
      ctx.fillStyle = colors.scanner;
      ctx.fillRect(-9, -6, 18, 12);
      ctx.strokeStyle = colors.scannerStroke;
      ctx.lineWidth = 1.2;
      rectPath(ctx, -9, -6, 18, 12);
      ctx.stroke();
      ctx.strokeStyle = colors.scannerStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (String(s.type || "barcode").toLowerCase() === "camera") {
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        for (let i = -3; i <= 3; i += 2) {
          ctx.moveTo(i, -4);
          ctx.lineTo(i, 4);
        }
        ctx.stroke();
      }
      ctx.fillStyle = colors.scannerLens;
      ctx.beginPath();
      ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      /* horizontal labels for readability */
      ctx.fillStyle = colors.scanner;
      ctx.font = 'bold 10.5px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.name || "SCAN") + " \u00b7 " +
        (String(s.type || "barcode").toLowerCase() === "camera" ? "CAMERA" : "BARCODE"), p.x + 13, p.y - 7);
      ctx.fillStyle = colors.hud;
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.tagName || ""), p.x + 13, p.y + 7);
    }
  }

  function drawSelection(ctx, computed, sel, view, colors) {
    if (!sel || !sel.segmentId) return;
    const seg = findSegment(computed, sel.segmentId);
    if (!seg) return;
    if (sel.kind === "zone" && sel.zoneIndex !== null && sel.zoneIndex !== undefined) {
      const zones = seg.zones || [];
      const zone = zones.reduce(function (acc, z, i) {
        return (z.index === sel.zoneIndex || i === sel.zoneIndex) ? z : acc;
      }, null);
      const quad = zoneQuadPolygon(zone);
      if (quad.length >= 3) {
        strokePolygon(ctx, quad.map(function (p) { return worldToScreen(view, p); }), colors.selectedZoneStroke, 2);
      }
    }
    const body = segmentBodyPolygon(seg).map(function (p) { return worldToScreen(view, p); });
    if (body.length >= 3) {
      if (sel.kind === "segment") strokePolygon(ctx, body, colors.selectedSegment, 2.5);
      else strokePolygon(ctx, body, colors.selectedSegment, 1.25);
    }
  }

  function findZoneByIndex1Based(computed, index1Based) {
    if (index1Based === null || index1Based === undefined) return null;
    const zones = (computed && computed.zones) || [];
    for (const z of zones) if (z.index1Based === index1Based) return z;
    return null;
  }

  /* 2D arrow (screen coords): line plus a small filled head. */
  function drawArrow2D(ctx, from, to, color, lineWidth, headSize) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const ux = dx / len, uy = dy / len;
    const hs = Math.max(3, num(headSize, 6));
    strokePolyline(ctx, [from, to], color, lineWidth === undefined ? 1.5 : lineWidth);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - ux * hs - uy * hs * 0.55, to.y - uy * hs + ux * hs * 0.55);
    ctx.lineTo(to.x - ux * hs + uy * hs * 0.55, to.y - uy * hs - ux * hs * 0.55);
    ctx.lineTo(to.x, to.y);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* Highlight the merge release zone on the main line (drawn under the details). */
  function drawMergeZones(ctx, computed, view, colors) {
    const merges = (computed && computed.merges) || [];
    if (!merges.length) return;
    for (const mg of merges) {
      const zone = findZoneByIndex1Based(computed, mg.mergeZoneIndex1Based);
      const quad = zoneQuadPolygon(zone);
      if (quad.length < 3) continue;
      const poly = quad.map(function (p) { return worldToScreen(view, p); });
      fillPolygon(ctx, poly, colors.mergeZoneFill);
      strokePolygon(ctx, poly, colors.mergeZoneStroke, 1.8);
    }
  }

  /* Merge throat polygons (Y-junction), spur flow arrow, labels + gap warning. */
  function drawMerges(ctx, computed, view, colors) {
    const merges = (computed && computed.merges) || [];
    if (!merges.length) return;
    for (const mg of merges) {
      const geo = mergeThroatGeometry(computed, mg);
      if (!geo || geo.polygon.length < 3) continue;
      const poly = geo.polygon.map(function (p) { return worldToScreen(view, p); });
      const mainColor = geo.warning ? colors.mergeWarn : colors.merge;
      fillPolygon(ctx, poly, geo.warning ? colors.mergeWarnFill : colors.mergeFill);
      strokePolygon(ctx, poly, mainColor, geo.warning ? 2.2 : 1.6);

      /* spur flow arrow through the throat */
      drawArrow2D(ctx,
        worldToScreen(view, geo.flowArrow.from),
        worldToScreen(view, geo.flowArrow.to),
        mainColor, 1.8, 6);

      const c = worldToScreen(view, geo.center);
      let text = geo.name;
      if (geo.mergeBlockName) text += " \u00b7 " + geo.mergeBlockName;
      if (geo.mergeZoneIndex1Based) text += " Z" + geo.mergeZoneIndex1Based;
      if (geo.priority && geo.priority !== "alternate") text += " \u00b7 " + geo.priority;
      ctx.fillStyle = colors.mergeLabel;
      ctx.font = 'bold 11px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, c.x, c.y - 14);

      if (geo.warning) {
        const mid = worldToScreen(view, {
          x: (geo.spurEnd.x + geo.mergePoint.x) / 2,
          y: (geo.spurEnd.y + geo.mergePoint.y) / 2
        });
        ctx.fillStyle = colors.mergeWarn;
        ctx.font = 'bold 10.5px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("THROAT PLATE \u00b7 " + geo.gapM.toFixed(2) + " m GAP", mid.x + 14, mid.y + 14);
      }
    }
  }

  /* Transfer device symbols (pusher / rotary table / pop-up) + I/O block markers. */
  function drawTransfers(ctx, computed, view, colors) {
    const transfers = (computed && computed.transfers) || [];
    if (!transfers.length) return;
    for (const tf of transfers) {
      const geo = transferSymbolGeometry(computed, tf);
      if (!geo) continue;
      const c = worldToScreen(view, geo.center);
      const halfPx = Math.max(4, 0.3 * view.scale);

      if (geo.kind === "rotary_table") {
        const rPx = Math.max(5, geo.radius * view.scale);
        drawCircle(ctx, c.x, c.y, rPx, colors.transferRotaryFill, colors.transferRotary, 1.8);
        drawCircle(ctx, c.x, c.y, rPx * 0.42, null, colors.transferRotary, 1);
        for (const arc of geo.arcs) {
          const a0 = arc.a0Deg * Math.PI / 180;
          const a1 = arc.a1Deg * Math.PI / 180;
          const r = Math.max(3, arc.r * view.scale);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, a0, a1, !!arc.cw);
          ctx.strokeStyle = colors.transferRotary;
          ctx.lineWidth = 2;
          ctx.stroke();
          /* arrowhead at the arc end, tangent to the rotation direction */
          const sweepSign = arc.cw ? -1 : 1;
          const ex = c.x + r * Math.cos(a1);
          const ey = c.y + r * Math.sin(a1);
          const tx = -Math.sin(a1) * sweepSign;
          const ty = Math.cos(a1) * sweepSign;
          drawArrow2D(ctx,
            { x: ex - tx * 10, y: ey - ty * 10 },
            { x: ex + tx * 0.01, y: ey + ty * 0.01 },
            colors.transferRotary, 1.6, 6);
        }
        ctx.fillStyle = colors.transferRotary;
        ctx.font = 'bold 10.5px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("ROTARY " + num(tf.rotary && tf.rotary.stepDeg, 90) + "\u00b0", c.x, c.y + rPx + 13);
      } else if (geo.kind === "popup_transfer") {
        const poly = geo.polygon.map(function (p) { return worldToScreen(view, p); });
        fillPolygon(ctx, poly, colors.transferPopupFill);
        strokePolygon(ctx, poly, colors.transferPopup, 1.8);
        for (const belt of geo.belts) {
          strokePolyline(ctx, [worldToScreen(view, belt.a), worldToScreen(view, belt.b)],
            colors.transferBelt, 2);
        }
        for (const arrow of geo.arrows) {
          drawArrow2D(ctx, worldToScreen(view, arrow.a), worldToScreen(view, arrow.b),
            colors.transferPopup, 1.8, 6);
        }
        const nScreen = normalAtAngle(geo.angleDeg);
        ctx.fillStyle = colors.transferPopup;
        ctx.font = 'bold 10.5px "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("POP-UP \u00d7" + geo.belts.length,
          c.x + nScreen.x * (halfPx + 26), c.y + nScreen.y * (halfPx + 26));
      } else {
        /* pusher: cylinder body + piston/arrow + pusher plate on the requested side */
        const poly = geo.polygon.map(function (p) { return worldToScreen(view, p); });
        fillPolygon(ctx, poly, colors.transferPusherFill);
        strokePolygon(ctx, poly, colors.transferPusher, 1.8);
        if (geo.piston) {
          const from = worldToScreen(view, geo.piston.from);
          const to = worldToScreen(view, geo.piston.to);
          const retract = worldToScreen(view, geo.mount);
          strokePolyline(ctx, [retract, from], colors.transferPusher, 4);
          drawArrow2D(ctx, from, to, colors.transferPusher, 2, 7);
        }
        if (geo.plate) {
          strokePolyline(ctx, [worldToScreen(view, geo.plate.a), worldToScreen(view, geo.plate.b)],
            colors.transferPusher, 4);
        }
        const nScreen = normalAtAngle(geo.angleDeg);
        const labelOffset = halfPx + 34;
        ctx.fillStyle = colors.transferPusher;
        ctx.font = 'bold 10.5px "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("PUSHER",
          c.x + nScreen.x * labelOffset * geo.sideSign,
          c.y + nScreen.y * labelOffset * geo.sideSign);
      }

      /* device I/O block marker + label near the device */
      const bm = worldToScreen(view, geo.blockMarker);
      strokePolyline(ctx, [c, bm], colors.deviceBlock, 1);
      ctx.fillStyle = colors.deviceBlock;
      ctx.fillRect(bm.x - 4, bm.y - 4, 8, 8);
      ctx.strokeStyle = colors.transferStroke;
      ctx.lineWidth = 1;
      squarePath(ctx, bm.x, bm.y, 8);
      ctx.stroke();
      ctx.fillStyle = colors.deviceBlock;
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(geo.blockLabel || (geo.blockName || ""), bm.x + 8, bm.y);
    }
  }

  function formatMeters(v) {
    const n = num(v, 0);
    return String(Math.round(n * 1000) / 1000) + " m";
  }

  function drawHud(ctx, view, width, height, colors, opts) {
    const pad = 12;
    if (opts.title) {
      ctx.fillStyle = colors.hudStrong;
      ctx.font = 'bold 13px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(opts.title), pad, pad + 8);
    }
    if (opts.subtitle) {
      ctx.fillStyle = colors.hud;
      ctx.font = '11.5px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(opts.subtitle), pad, pad + 26);
    }
    if (opts.hint) {
      ctx.fillStyle = colors.hud;
      ctx.font = '11px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(opts.hint), pad, height - pad - 26);
    }

    /* scale bar (bottom left) */
    const step = num(opts.gridStepM, chooseGridStep(view.scale));
    const barPx = step * view.scale;
    if (barPx >= 24 && barPx <= width * 0.6) {
      const x0 = pad, y0 = height - pad - 6;
      strokePolyline(ctx, [{ x: x0, y: y0 }, { x: x0 + barPx, y: y0 }], colors.hudStrong, 1.5);
      strokePolyline(ctx, [{ x: x0, y: y0 - 4 }, { x: x0, y: y0 + 4 }], colors.hudStrong, 1.5);
      strokePolyline(ctx, [{ x: x0 + barPx, y: y0 - 4 }, { x: x0 + barPx, y: y0 + 4 }], colors.hudStrong, 1.5);
      ctx.fillStyle = colors.hud;
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(formatMeters(step), x0 + barPx + 8, y0);
    }

    /* live cursor position (optional) */
    if (opts.cursor && Number.isFinite(opts.cursor.x) && Number.isFinite(opts.cursor.y)) {
      ctx.fillStyle = colors.hud;
      ctx.font = '11.5px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("x " + opts.cursor.x.toFixed(2) + " m   y " + opts.cursor.y.toFixed(2) + " m",
        width - pad, height - pad - 6);
    }
  }

  function drawEmpty(ctx, width, height, colors) {
    ctx.fillStyle = colors.hud;
    ctx.font = '14px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No conveyor segments \u2014 add a segment to start designing", width / 2, height / 2);
  }

  /* Render the whole conveyor scene.
     opts: { view, width, height, selection, rollerPitchM, showGrid, showHud,
             showJoints, showScanners, showMerges, showTransfers,
             title, subtitle, hint, cursor, gridStepM, colors }
     Returns { view, segments, zones, merges, transfers }. */
  function renderScene(ctx, computed, opts) {
    if (!ctx || typeof ctx !== "object") return null;
    opts = opts || {};
    const fallbackW = (ctx.canvas && num(ctx.canvas.width, 0)) || 800;
    const fallbackH = (ctx.canvas && num(ctx.canvas.height, 0)) || 600;
    const width = Math.max(1, num(opts.width, fallbackW));
    const height = Math.max(1, num(opts.height, fallbackH));
    const colors = resolveColors(opts.colors);
    const scene = computed || emptyComputed();
    const segments = Array.isArray(scene.segments) ? scene.segments : [];
    const zones = Array.isArray(scene.zones) ? scene.zones : [];
    const merges = Array.isArray(scene.merges) ? scene.merges : [];
    const transfers = Array.isArray(scene.transfers) ? scene.transfers : [];
    const view = sanitizeView(opts.view || fitView(scene, width, height));
    const sel = opts.selection || null;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    if (opts.showGrid !== false) drawGrid(ctx, view, width, height, colors, opts);

    if (!segments.length) {
      drawEmpty(ctx, width, height, colors);
      if (opts.showHud !== false) drawHud(ctx, view, width, height, colors, opts);
      return { view: view, segments: 0, zones: 0, merges: merges.length, transfers: transfers.length };
    }

    /* model v2 overlays: tray tracking slots / scanned zones */
    const tracking = scene.tracking && scene.tracking.enabled ? scene.tracking : null;
    const trackByZone = {};
    if (tracking && Array.isArray(tracking.zones)) {
      for (const t of tracking.zones) {
        if (t && t.zoneIndex1Based !== undefined) trackByZone[t.zoneIndex1Based] = t;
      }
    }
    const info = { trackingEnabled: !!tracking, trackByZone: trackByZone };

    /* rounded joint fillets first: they fill the wedge gaps between chained bodies */
    drawJointFill(ctx, scene, view, colors);
    for (let si = 0; si < segments.length; si++) {
      drawSegmentBand(ctx, segments[si], si, view, colors, sel, opts);
    }
    if (opts.showMerges !== false) {
      drawMergeZones(ctx, scene, view, colors);
    }
    for (let si = 0; si < segments.length; si++) {
      drawSegmentDetails(ctx, segments[si], si, view, colors, sel, info);
    }
    if (opts.showJoints !== false) drawJoints(ctx, scene, view, colors);
    if (opts.showScanners !== false) drawScanners(ctx, scene, view, colors);
    if (opts.showMerges !== false) drawMerges(ctx, scene, view, colors);
    if (opts.showTransfers !== false) drawTransfers(ctx, scene, view, colors);
    drawSelection(ctx, scene, sel, view, colors);
    if (opts.showHud !== false) drawHud(ctx, view, width, height, colors, opts);

    return {
      view: view, segments: segments.length, zones: zones.length,
      merges: merges.length, transfers: transfers.length
    };
  }

  /* ===================================================================== */
  /* DOM helpers                                                           */
  /* ===================================================================== */

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElement === "function";
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || el.nodeName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }

  function devicePixelRatioSafe() {
    try {
      if (typeof window !== "undefined" && window && Number.isFinite(window.devicePixelRatio)) {
        return clampNum(window.devicePixelRatio, 1, 2);
      }
    } catch (e) { /* ignore */ }
    return 1;
  }

  function measureSize(container, canvas) {
    let w = 0, h = 0;
    try {
      if (container && typeof container.clientWidth === "number") {
        w = container.clientWidth; h = container.clientHeight;
      }
    } catch (e) { /* ignore */ }
    if ((!w || !h) && canvas) {
      try {
        w = w || canvas.clientWidth || 0;
        h = h || canvas.clientHeight || 0;
      } catch (e) { /* ignore */ }
    }
    return {
      width: Math.max(60, Math.round(w || 800)),
      height: Math.max(60, Math.round(h || 600))
    };
  }

  /* ===================================================================== */
  /* ConveyorDesigner2D                                                    */
  /* ===================================================================== */

  function ConveyorDesigner2D(opts) {
    if (!(this instanceof ConveyorDesigner2D)) return new ConveyorDesigner2D(opts);
    opts = opts || {};
    this.container = opts.container || null;
    this.onChange = typeof opts.onChange === "function" ? opts.onChange : null;
    this.onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
    this.onHover = typeof opts.onHover === "function" ? opts.onHover : null;
    this.onViewChange = typeof opts.onViewChange === "function" ? opts.onViewChange : null;
    this.colors = opts.colors || null;
    this.rollerPitchM = opts.rollerPitchM;
    this._design = opts.design || createDefaultDesignSafe();
    this._computed = computeDesignSafe(this._design);
    this._selection = { kind: null, segmentId: null, zoneIndex: null };
    this._canvas = null;
    this._ctx = null;
    this._doc = null;
    this._width = Math.max(60, num(opts.width, 800));
    this._height = Math.max(60, num(opts.height, 600));
    this._dpr = 1;
    this._view = fitView(this._computed, this._width, this._height);
    this._drag = null;
    this._spaceDown = false;
    this._cursorWorld = null;
    this._destroyed = false;
    this._listeners = [];
    this._handlers = {};
    this._resizeObserver = null;
    this._initDom();
  }

  /* Create the canvas inside `container` and wire the listeners (browser only). */
  ConveyorDesigner2D.prototype._initDom = function () {
    if (!hasDom()) return; // Node / headless: constructor must not throw
    const doc = document;
    let canvas;
    try { canvas = doc.createElement("canvas"); } catch (e) { return; }
    canvas.className = "conv-2d-canvas";
    try { canvas.setAttribute("tabindex", "0"); } catch (e) { /* ignore */ }
    if (canvas.style) {
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.outline = "none";
      canvas.style.cursor = "crosshair";
      canvas.style.touchAction = "none";
    }
    let ctx = null;
    try { ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null; } catch (e) { ctx = null; }
    if (this.container && typeof this.container.appendChild === "function") this.container.appendChild(canvas);
    else if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = ctx;
    if (!ctx || typeof canvas.addEventListener !== "function") { this._canvas = null; this._ctx = null; return; }
    this._doc = doc;
    this._dpr = devicePixelRatioSafe();
    this._bindEvents();
    this.resize();
    this.zoomToFit();
  };

  ConveyorDesigner2D.prototype._listen = function (target, type, fn, options) {
    if (!target || typeof target.addEventListener !== "function") return;
    try { target.addEventListener(type, fn, options); }
    catch (e) { try { target.addEventListener(type, fn); } catch (e2) { return; } }
    this._listeners.push({ target: target, type: type, fn: fn, options: options });
  };

  ConveyorDesigner2D.prototype._bindEvents = function () {
    const canvas = this._canvas, doc = this._doc;
    if (!canvas) return;
    const h = this._handlers = {
      mousedown: (ev) => this._onMouseDown(ev),
      mousemove: (ev) => this._onMouseMove(ev),
      mouseleave: (ev) => this._onMouseLeave(ev),
      wheel: (ev) => this._onWheel(ev),
      contextmenu: (ev) => { if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); },
      docmove: (ev) => this._onDocMouseMove(ev),
      docup: (ev) => this._onMouseUp(ev),
      keydown: (ev) => this._onKeyDown(ev),
      keyup: (ev) => this._onKeyUp(ev)
    };
    this._listen(canvas, "mousedown", h.mousedown);
    this._listen(canvas, "mousemove", h.mousemove);
    this._listen(canvas, "mouseleave", h.mouseleave);
    this._listen(canvas, "wheel", h.wheel, { passive: false });
    this._listen(canvas, "contextmenu", h.contextmenu);
    if (doc) {
      this._listen(doc, "mousemove", h.docmove);
      this._listen(doc, "mouseup", h.docup);
      this._listen(doc, "keydown", h.keydown);
      this._listen(doc, "keyup", h.keyup);
    }
    if (this.container && typeof ResizeObserver !== "undefined") {
      try {
        this._resizeObserver = new ResizeObserver(() => { if (!this._destroyed) this.resize(); });
        this._resizeObserver.observe(this.container);
      } catch (e) { this._resizeObserver = null; }
    } else if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
      this._listen(window, "resize", () => { if (!this._destroyed) this.resize(); });
    }
  };

  ConveyorDesigner2D.prototype._eventPoint = function (ev) {
    let left = 0, top = 0;
    try {
      const rect = this._canvas && this._canvas.getBoundingClientRect ? this._canvas.getBoundingClientRect() : null;
      if (rect) { left = num(rect.left, 0); top = num(rect.top, 0); }
    } catch (e) { left = 0; top = 0; }
    const cx = num(ev && ev.clientX, num(ev && ev.pageX, 0));
    const cy = num(ev && ev.clientY, num(ev && ev.pageY, 0));
    return { x: cx - left, y: cy - top };
  };

  ConveyorDesigner2D.prototype._rollerPitch = function () {
    if (Number.isFinite(Number(this.rollerPitchM)) && Number(this.rollerPitchM) > 0) return Number(this.rollerPitchM);
    const d = this._design && this._design.defaults;
    if (d && Number.isFinite(Number(d.rollerPitchM)) && Number(d.rollerPitchM) > 0) return Number(d.rollerPitchM);
    return null;
  };

  ConveyorDesigner2D.prototype._syncSize = function () {
    if (!this._canvas) return false;
    const size = measureSize(this.container, this._canvas);
    const dpr = devicePixelRatioSafe();
    let changed = false;
    if (size.width !== this._width) { this._width = size.width; changed = true; }
    if (size.height !== this._height) { this._height = size.height; changed = true; }
    if (dpr !== this._dpr) { this._dpr = dpr; changed = true; }
    const bw = Math.max(1, Math.round(this._width * this._dpr));
    const bh = Math.max(1, Math.round(this._height * this._dpr));
    if (this._canvas.width !== bw || this._canvas.height !== bh) {
      this._canvas.width = bw;
      this._canvas.height = bh;
      changed = true;
    }
    return changed;
  };

  ConveyorDesigner2D.prototype.resize = function () {
    if (this._destroyed) return this;
    const canvas = this._canvas;
    if (!canvas) {
      const size = measureSize(this.container, null);
      this._width = size.width; this._height = size.height;
      return this;
    }
    const prevW = this._width, prevH = this._height;
    this._syncSize();
    if (this._width !== prevW || this._height !== prevH) {
      /* keep the world point at the canvas centre while the panel resizes */
      this._view.offsetX += (this._width - prevW) / 2;
      this._view.offsetY += (this._height - prevH) / 2;
    }
    this.redraw();
    return this;
  };

  ConveyorDesigner2D.prototype.redraw = function () {
    if (this._destroyed || !this._canvas || !this._ctx) return false;
    this._syncSize();
    const ctx = this._ctx;
    try { if (typeof ctx.setTransform === "function") ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0); }
    catch (e) { /* ignore */ }
    const totals = (this._computed && this._computed.totals) || {};
    const bounds = (this._computed && this._computed.bounds) || {};
    const segCount = num(totals.segments, ((this._computed && this._computed.segments) || []).length);
    const zoneCount = num(totals.zones, ((this._computed && this._computed.zones) || []).length);
    const lengthM = num(totals.conveyorLengthM, 0);
    const zRange = Math.max(0, num(bounds.zRange, 0));
    const conveyorType = String((this._computed && this._computed.conveyorType) || "roller").toUpperCase();
    const title = this._design && this._design.name ? String(this._design.name) : "CONVEYOR";
    let subtitle = conveyorType + " · " + segCount + " segment" + (segCount === 1 ? "" : "s") + " · " +
      zoneCount + " zone" + (zoneCount === 1 ? "" : "s") + " · " + lengthM.toFixed(1) + " m";
    if (zRange > 0.05) subtitle += " · rise " + zRange.toFixed(1) + " m";
    if (this._computed && this._computed.tracking && this._computed.tracking.enabled) {
      const track = this._computed.tracking;
      subtitle += " · tracking " + ((track.zones && track.zones.length) || 0) + " slots";
      if (this._computed.scannedZones && this._computed.scannedZones.length) {
        subtitle += " · " + this._computed.scannedZones.length + " scan";
      }
    }
    if (this._computed && this._computed.merges && this._computed.merges.length) {
      subtitle += " · " + this._computed.merges.length + " merge" +
        (this._computed.merges.length === 1 ? "" : "s");
    }
    if (this._computed && this._computed.transfers && this._computed.transfers.length) {
      subtitle += " · " + this._computed.transfers.length + " transfer" +
        (this._computed.transfers.length === 1 ? "" : "s") +
        (totals.deviceBlocks ? " / " + totals.deviceBlocks + " I/O blocks" : "");
    }
    renderScene(ctx, this._computed, {
      view: this._view,
      width: this._width,
      height: this._height,
      selection: this._selection,
      colors: this.colors || undefined,
      rollerPitchM: this._rollerPitch(),
      title: title,
      subtitle: subtitle,
      hint: "drag segment = move · wheel = zoom · drag background = pan · Del = delete",
      cursor: this._cursorWorld
    });
    return true;
  };

  ConveyorDesigner2D.prototype._emitViewChange = function () {
    if (this.onViewChange) this.onViewChange(this.getView());
  };

  ConveyorDesigner2D.prototype._publicSelection = function () {
    const s = this._selection || { kind: null, segmentId: null, zoneIndex: null };
    return {
      kind: s.kind || null,
      segmentId: s.segmentId === undefined ? null : s.segmentId,
      zoneIndex: s.zoneIndex === undefined ? null : s.zoneIndex,
      zoneIndex1Based: s.zoneIndex1Based === undefined ? null : s.zoneIndex1Based,
      zoneInSegment: s.zoneInSegment === undefined ? null : s.zoneInSegment,
      segmentName: s.segmentName === undefined ? null : s.segmentName,
      zone: s.zone || null
    };
  };

  ConveyorDesigner2D.prototype._select = function (sel, emit) {
    if (sel && sel.segmentId !== null && sel.segmentId !== undefined) {
      this._selection = {
        kind: sel.kind || "segment",
        segmentId: sel.segmentId,
        zoneIndex: sel.zoneIndex === undefined ? null : sel.zoneIndex,
        zoneIndex1Based: sel.zoneIndex1Based === undefined ? null : sel.zoneIndex1Based,
        zoneInSegment: sel.zoneInSegment === undefined ? null : sel.zoneInSegment,
        segmentName: sel.segmentName === undefined ? null : sel.segmentName,
        zone: sel.zone || null
      };
    } else {
      this._selection = { kind: null, segmentId: null, zoneIndex: null };
    }
    this.redraw();
    if (emit && this.onSelect) this.onSelect(this._publicSelection());
  };

  ConveyorDesigner2D.prototype._onMouseDown = function (ev) {
    if (this._destroyed || !this._canvas) return;
    const pt = this._eventPoint(ev);
    const world = screenToWorld(this._view, pt);
    this._cursorWorld = world;
    const button = ev && ev.button !== undefined ? ev.button : 0;
    const forcePan = button === 1 || this._spaceDown;
    const tol = 5 / Math.max(1e-6, this._view.scale);
    this._drag = null;
    if (forcePan) {
      this._drag = {
        mode: "pan", startScreen: pt, startOffsetX: this._view.offsetX,
        startOffsetY: this._view.offsetY, moved: false, background: true
      };
    } else {
      const hitZone = hitTestZone(this._computed, world, { tolerance: tol });
      const hitSeg = hitZone ? findSegment(this._computed, hitZone.segmentId)
        : hitTestSegment(this._computed, world, { tolerance: tol });
      const designSeg = hitSeg && this._design && Array.isArray(this._design.segments)
        ? this._design.segments.filter(function (s) { return s.id === hitSeg.id; })[0]
        : null;
      if (hitSeg && designSeg) {
        this._select({
          kind: hitZone ? "zone" : "segment",
          segmentId: hitSeg.id,
          zoneIndex: hitZone ? hitZone.index : null,
          zoneIndex1Based: hitZone ? hitZone.index1Based : null,
          zoneInSegment: hitZone ? hitZone.zoneInSegment : null,
          segmentName: hitSeg.name,
          zone: hitZone || null
        }, true);
        this._drag = {
          mode: "segment", segId: hitSeg.id, startScreen: pt, startWorld: world,
          baseDesign: this._design, baseX: num(designSeg.x, 0), baseY: num(designSeg.y, 0),
          moved: false
        };
      } else {
        this._drag = {
          mode: "pan", startScreen: pt, startOffsetX: this._view.offsetX,
          startOffsetY: this._view.offsetY, moved: false, background: true
        };
      }
    }
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (this._canvas.focus) { try { this._canvas.focus(); } catch (e) { /* ignore */ } }
    if (this._canvas.style) this._canvas.style.cursor = this._drag.mode === "segment" ? "move" : "grabbing";
  };

  ConveyorDesigner2D.prototype._onMouseMove = function (ev) {
    if (this._destroyed || this._drag || !this._canvas) return;
    const pt = this._eventPoint(ev);
    const world = screenToWorld(this._view, pt);
    this._cursorWorld = world;
    const tol = 5 / Math.max(1e-6, this._view.scale);
    const hitZone = hitTestZone(this._computed, world, { tolerance: tol });
    const hitSeg = hitZone ? findSegment(this._computed, hitZone.segmentId)
      : hitTestSegment(this._computed, world, { tolerance: tol });
    const cursor = this._spaceDown ? "grab" : (hitSeg ? "pointer" : "crosshair");
    if (this._canvas.style && this._canvas.style.cursor !== cursor) this._canvas.style.cursor = cursor;
    if (this.onHover) {
      this.onHover({
        world: world,
        hit: hitSeg ? {
          kind: hitZone ? "zone" : "segment",
          segmentId: hitSeg.id,
          zoneIndex: hitZone ? hitZone.index : null
        } : null
      });
    }
    this.redraw();
  };

  ConveyorDesigner2D.prototype._onMouseLeave = function () {
    if (this._destroyed) return;
    this._cursorWorld = null;
    if (this._canvas && this._canvas.style && !this._drag) this._canvas.style.cursor = "crosshair";
    this.redraw();
  };

  /* True when the canvas is no longer in the live document (a host panel re-rendered
     and dropped us). Detached instances disable themselves so multiple editor
     generations cannot both react to keyboard/mouse events. */
  ConveyorDesigner2D.prototype._isDetached = function () {
    const canvas = this._canvas;
    if (!canvas) return true;
    if (canvas.isConnected === false) return true;
    if (canvas.isConnected === undefined && canvas.parentNode === null) return true;
    return false;
  };

  ConveyorDesigner2D.prototype._onDocMouseMove = function (ev) {
    if (this._destroyed) return;
    if (this._isDetached()) { this.destroy(); return; }
    if (!this._drag) return;
    const drag = this._drag;
    const pt = this._eventPoint(ev);
    const dx = pt.x - drag.startScreen.x;
    const dy = pt.y - drag.startScreen.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    this._cursorWorld = screenToWorld(this._view, pt);

    if (drag.mode === "pan") {
      this._view.offsetX = drag.startOffsetX + dx;
      this._view.offsetY = drag.startOffsetY + dy;
      this.redraw();
      this._emitViewChange();
      return;
    }

    if (drag.mode === "segment") {
      if (!this._design || !Array.isArray(this._design.segments)) return;
      const api = getModelApi();
      if (!api || typeof api.updateSegment !== "function") return;
      const world = screenToWorld(this._view, pt);
      const nx = roundTo(drag.baseX + (world.x - drag.startWorld.x), 3);
      const ny = roundTo(drag.baseY + (world.y - drag.startWorld.y), 3);
      const designSeg = drag.baseDesign.segments.filter(function (s) { return s.id === drag.segId; })[0];
      if (!designSeg) return;
      const currentSeg = this._design.segments.filter(function (s) { return s.id === drag.segId; })[0];
      if (currentSeg && nx === num(currentSeg.x, 0) && ny === num(currentSeg.y, 0)) return;
      const newDesign = api.updateSegment(drag.baseDesign, drag.segId, { x: nx, y: ny });
      this._design = newDesign;
      this._computed = computeDesignSafe(newDesign);
      this.redraw();
      if (this.onChange) this.onChange(cloneDesign(newDesign, api));
    }
  };

  ConveyorDesigner2D.prototype._onMouseUp = function (ev) {
    if (this._destroyed) return;
    const drag = this._drag;
    this._drag = null;
    if (drag && drag.mode === "pan" && drag.background && !drag.moved && this._selection.segmentId) {
      this._select({ kind: null, segmentId: null, zoneIndex: null }, true);
    }
    if (this._canvas && this._canvas.style) {
      this._canvas.style.cursor = this._spaceDown ? "grab" : "crosshair";
    }
  };

  ConveyorDesigner2D.prototype._zoomAt = function (pt, factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const before = screenToWorld(this._view, pt);
    const newScale = clampNum(this._view.scale * factor, 0.01, 100000);
    if (newScale === this._view.scale) return;
    this._view.scale = newScale;
    this._view.offsetX = pt.x - before.x * newScale;
    this._view.offsetY = pt.y - before.y * newScale;
    this.redraw();
    this._emitViewChange();
  };

  ConveyorDesigner2D.prototype._onWheel = function (ev) {
    if (this._destroyed || !this._canvas) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    const pt = this._eventPoint(ev);
    const delta = num(ev && ev.deltaY, 0);
    const factor = Math.pow(1.0015, -delta);
    this._zoomAt(pt, factor);
  };

  ConveyorDesigner2D.prototype._onKeyDown = function (ev) {
    if (this._destroyed || !this._canvas) return;
    if (this._isDetached()) { this.destroy(); return; }
    if (isEditableTarget(ev && ev.target)) return;
    const key = String(ev && ev.key !== undefined ? ev.key : "");
    const code = num(ev && ev.keyCode, 0);
    if (key === " " || key === "Spacebar" || code === 32) {
      this._spaceDown = true;
      if (this._canvas.style) this._canvas.style.cursor = "grab";
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      return;
    }
    const isDel = key === "Delete" || key === "Backspace" || code === 46 || code === 8;
    if (!isDel) return;
    const sel = this._selection;
    if (!sel || sel.segmentId === null || sel.segmentId === undefined) return;
    const api = getModelApi();
    if (!api || typeof api.removeSegment !== "function" || !this._design) return;
    const newDesign = api.removeSegment(this._design, sel.segmentId);
    this._drag = null;
    this._select({ kind: null, segmentId: null, zoneIndex: null }, false);
    this._design = newDesign;
    this._computed = computeDesignSafe(newDesign);
    this.redraw();
    if (this.onChange) this.onChange(cloneDesign(newDesign, api));
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
  };

  ConveyorDesigner2D.prototype._onKeyUp = function (ev) {
    if (this._destroyed) return;
    const key = String(ev && ev.key !== undefined ? ev.key : "");
    const code = num(ev && ev.keyCode, 0);
    if (key === " " || key === "Spacebar" || code === 32) {
      this._spaceDown = false;
      if (this._canvas && this._canvas.style) {
        this._canvas.style.cursor = this._drag && this._drag.mode === "segment" ? "move" : "crosshair";
      }
    }
  };

  /* ---------------------------------------------------------------- API */

  ConveyorDesigner2D.prototype.setDesign = function (design) {
    if (!design || typeof design !== "object") return this;
    this._drag = null;
    this._design = design;
    this._computed = computeDesignSafe(design);
    if (this._selection.segmentId && !findSegment(this._computed, this._selection.segmentId)) {
      this._selection = { kind: null, segmentId: null, zoneIndex: null };
    }
    this.redraw();
    return this;
  };

  ConveyorDesigner2D.prototype.getDesign = function () { return this._design; };
  ConveyorDesigner2D.prototype.getComputed = function () { return this._computed; };
  ConveyorDesigner2D.prototype.getSelection = function () { return this._publicSelection(); };

  ConveyorDesigner2D.prototype.setSelection = function (sel) {
    /* accept either a selection object or a bare segment id (the properties panel
       selects segments by id: designer.setSelection(segmentId)). */
    if (typeof sel === "string" || typeof sel === "number") {
      this._select({ kind: "segment", segmentId: sel, zoneIndex: null }, false);
    } else {
      this._select(sel || null, false);
    }
    return this;
  };

  ConveyorDesigner2D.prototype.zoomToFit = function () {
    this._view = fitView(this._computed, this._width, this._height);
    this.redraw();
    this._emitViewChange();
    return this.getView();
  };

  ConveyorDesigner2D.prototype.getView = function () {
    return {
      scale: this._view.scale,
      offsetX: this._view.offsetX,
      offsetY: this._view.offsetY,
      offset: { x: this._view.offsetX, y: this._view.offsetY }
    };
  };

  ConveyorDesigner2D.prototype.setView = function (view) {
    this._view = sanitizeView(view);
    this.redraw();
    this._emitViewChange();
    return this;
  };

  ConveyorDesigner2D.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._drag = null;
    for (const l of this._listeners) {
      try { l.target.removeEventListener(l.type, l.fn, l.options); } catch (e) { /* ignore */ }
      try { if (l.options) l.target.removeEventListener(l.type, l.fn); } catch (e) { /* ignore */ }
    }
    this._listeners = [];
    this._handlers = {};
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
      this._resizeObserver = null;
    }
    const canvas = this._canvas;
    if (canvas && canvas.parentNode && typeof canvas.parentNode.removeChild === "function") {
      try { canvas.parentNode.removeChild(canvas); } catch (e) { /* ignore */ }
    }
    this._canvas = null;
    this._ctx = null;
    this._doc = null;
  };

  /* ===================================================================== */
  /* exports                                                               */
  /* ===================================================================== */

  return {
    ConveyorDesigner2D: ConveyorDesigner2D,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    hitTestSegment: hitTestSegment,
    hitTestZone: hitTestZone,
    renderScene: renderScene,
    fitView: fitView,
    /* model v2 pure geometry helpers (useful for panels and tests) */
    segmentBodyPolygon: segmentBodyPolygon,
    zoneQuadPolygon: zoneQuadPolygon,
    pointInPolygon: pointInPolygon,
    /* model v3 merge/transfer pure geometry helpers */
    mergeThroatGeometry: mergeThroatGeometry,
    transferSymbolGeometry: transferSymbolGeometry,
    roundedPolygon: roundedPolygon,
    /* exposed for panels / tests that want the same palette */
    DESIGNER2D_DEFAULT_COLORS: DEFAULT_COLORS,
    DESIGNER2D_GRID_STEP: chooseGridStep
  };
});
