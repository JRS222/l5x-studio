/* L5X Studio - conveyor/render3d.js (teammate "conveyor-2d3d").
   WebGL 3D view for the Conveyor Design Studio (conveyor model v3: chained + spur chains).

   Draws the conveyor from L5XStudio.computeDesign(design) as a stylised machine:
     - one coloured floor panel per zone (thin slab from the zone quad) on roller beds,
       or coloured zone decals on top of the continuous belt band,
     - two side rails whose runs follow the ROUNDED model edges (leftEdge/rightEdge),
       including angled joints, curves and spiral elevation,
     - roller cylinders across the belt width every rollerPitchM; tapered rollers under
       curves/spirals are truncated cones (radius grows by taper.deltaM across the face),
     - belt conveyors: continuous belt band + head/tail pulleys + head drive box,
     - support legs every legSpacingM (at least 2 stations/segment) down to the floor,
     - a small sensor box above the rail at each zone start, a motor marker beside each
       roller-zone centre,
     - scanner/camera devices at computed.scannedZones (offset across the belt width),
     - side plates bridging angled chain joints,
     - model v3: merge junction throat plates + spur rail links joining the main rails
       (warning colour when the spur gap exceeds 1 m), and transfer devices: pusher
       cylinder + plate, rotary table platform/turntable with bidirectional arrow decals,
       cross-belt pop-up platform with popup belts, raise/lower indicator posts and
       I/O device marker blocks.
   Spirals are helices: segment polyline z values raise the deck, so rails, rollers and
   the belt follow the helix automatically. Lighting is a directional light + ambient
   term in the vertex shader (flat per-face normals from the geometry builder).

   Camera: orbit (left drag = rotate, wheel = zoom/dolly, right drag or shift+drag = pan).

   Node safety: this file never touches the DOM at require() time. `Conveyor3D` has no
   throw without a WebGL context - it only builds the CPU geometry, and render() is a
   no-op returning false. Feature detection is done through `hasWebGLSupport()`.

   Pure exports (Node-testable):
     buildConveyorGeometry(computed, opts?) -> { positions, normals, indices, colors,
                                                counts, bounds }
       opts: { conveyorType, rollerPitchM=0.1, legSpacingM=1.5, pulleyDiameterM=0.12,
               taperDeltaM, panelColors, rollerColor, railColor, legColor, sensorColor,
               motorColor, beltColor, pulleyColor, scannerColor, mergeThroatColor,
               mergeWarnColor, rotaryColor, popupColor, pusherColor, ...dimension overrides }
       counts: { segments, rails, rollers, taperedRollers, legs, sensors, motors, panels,
                 pulleys, beltSegments, scanners, joints, merges, mergeRailLinks,
                 transfers, pushers, rotaryTables, popupTransfers, popupBelts,
                 deviceMarkers } - logical part counts, e.g. rails = 2 per segment,
       rollers = ceil(length/pitch)+1 per roller segment, taperedRollers <= rollers,
       2 mergeRailLinks per merge, popupBelts = beltCount per pop-up transfer.
     mat4Identity / mat4Multiply / mat4Translate / mat4RotateX / mat4RotateY / mat4Scale /
     mat4Perspective / mat4LookAt, plus mat4Inverse and mat4TransformPoint helpers.
   Matrix layout is column-major (WebGL convention): m[col * 4 + row].
   World mapping: model (x, y, z) -> 3D (x, z, y): +Y is up (elevation) and Z is the plan
   y axis.

   UMD/module conventions follow the rest of the app.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ===================================================================== */
  /* dependencies (lazy so require() is safe without a DOM)                */
  /* ===================================================================== */

  function browserRoot() {
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
    return {
      segments: [], zones: [], blocks: [], totals: {}, warnings: [],
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }
    };
  }

  /* ===================================================================== */
  /* numeric helpers                                                       */
  /* ===================================================================== */

  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }
  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* Cumulative 3D length of a model polyline ([{x,y,z}]; y is plan, z is elevation). */
  function polylineLength3(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y,
        num(pts[i].z, 0) - num(pts[i - 1].z, 0));
    }
    return len;
  }

  /* Plan (horizontal) length of a model polyline. */
  function polylinePlanLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return len;
  }

  /* Point + plan tangent angle + elevation at 3D distance t along a model polyline. */
  function pointAtDistance3(pts, t) {
    if (!pts || !pts.length) return { x: 0, y: 0, z: 0, angleDeg: 0 };
    if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, z: num(pts[0].z, 0), angleDeg: 0 };
    const dist = clampNum(t, 0, polylineLength3(pts));
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, ay = pts[i - 1].y;
      const bx = pts[i].x, by = pts[i].y;
      const az = num(pts[i - 1].z, 0), bz = num(pts[i].z, 0);
      const d = Math.hypot(bx - ax, by - ay, bz - az);
      if (acc + d >= dist || i === pts.length - 1) {
        const f = d === 0 ? 0 : clampNum((dist - acc) / d, 0, 1);
        return {
          x: ax + (bx - ax) * f,
          y: ay + (by - ay) * f,
          z: az + (bz - az) * f,
          angleDeg: Math.atan2(by - ay, bx - ax) * 180 / Math.PI
        };
      }
      acc += d;
    }
    const p = pts[pts.length - 1];
    return { x: p.x, y: p.y, z: num(p.z, 0), angleDeg: 0 };
  }

  /* Orthonormal horizontal plan basis for a heading: tangent along travel, normal across
     the belt (3D: x=plan x, y=elevation/up, z=plan y). */
  function planBasis(angleDeg) {
    const a = num(angleDeg, 0) * Math.PI / 180;
    return {
      tangent: { x: Math.cos(a), y: 0, z: Math.sin(a) },
      normal: { x: -Math.sin(a), y: 0, z: Math.cos(a) }
    };
  }

  /* model polyline point {x, y, z} -> 3D world {x, y: elevation, z: plan y} */
  function modelTo3D(p) {
    return { x: num(p && p.x, 0), y: num(p && p.z, 0), z: num(p && p.y, 0) };
  }

  function normalize3(v) {
    const len = Math.hypot(v.x, v.y, v.z);
    if (len < 1e-12) return { x: 0, y: 1, z: 0 };
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }
  function cross3(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  /* ===================================================================== */
  /* mat4 helpers (column-major, WebGL convention)                         */
  /* ===================================================================== */

  function mat4Identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function mat4Multiply(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function mat4Translate(x, y, z) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, num(x, 0), num(y, 0), num(z, 0), 1];
  }

  function mat4Scale(x, y, z) {
    return [num(x, 1), 0, 0, 0, 0, num(y, 1), 0, 0, 0, 0, num(z, 1), 0, 0, 0, 0, 1];
  }

  function mat4RotateX(rad) {
    const c = Math.cos(num(rad, 0)), s = Math.sin(num(rad, 0));
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  }

  function mat4RotateY(rad) {
    const c = Math.cos(num(rad, 0)), s = Math.sin(num(rad, 0));
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  }

  function mat4Perspective(fovyRad, aspect, near, far) {
    const fovy = num(fovyRad, Math.PI / 4);
    const asp = num(aspect, 1) || 1;
    const n = Math.max(1e-6, num(near, 0.1));
    const f = Math.max(n + 1e-6, num(far, 1000));
    const fv = 1 / Math.tan(fovy / 2);
    const out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    out[0] = fv / asp;
    out[5] = fv;
    out[10] = (f + n) / (n - f);
    out[11] = -1;
    out[14] = (2 * f * n) / (n - f);
    return out;
  }

  function mat4LookAt(eye, center, up) {
    const ex = num(eye && eye.x, 0), ey = num(eye && eye.y, 0), ez = num(eye && eye.z, 0);
    const cx = num(center && center.x, 0), cy = num(center && center.y, 0), cz = num(center && center.z, 0);
    const ux0 = num(up && up.x, 0), uy0 = num(up && up.y, 1), uz0 = num(up && up.z, 0);
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let len = Math.hypot(zx, zy, zz);
    if (len < 1e-9) { zx = 0; zy = 0; zz = 1; } else { zx /= len; zy /= len; zz /= len; }
    let xx = uy0 * zz - uz0 * zy;
    let xy = uz0 * zx - ux0 * zz;
    let xz = ux0 * zy - uy0 * zx;
    len = Math.hypot(xx, xy, xz);
    if (len < 1e-9) {
      /* up is parallel to the view direction: pick an arbitrary perpendicular axis */
      xx = 1; xy = 0; xz = 0;
    } else { xx /= len; xy /= len; xz /= len; }
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    /* column-major: each group of 4 is one column; rows are the camera basis vectors */
    return [
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez),
      -(yx * ex + yy * ey + yz * ez),
      -(zx * ex + zy * ey + zz * ez),
      1
    ];
  }

  /* Inverse of a 4x4 column-major matrix (glMatrix style); null if singular. */
  function mat4Inverse(m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det || !Number.isFinite(det)) return null;
    det = 1 / det;
    return [
      (a11 * b11 - a12 * b10 + a13 * b09) * det,
      (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det,
      (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det,
      (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det,
      (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det,
      (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det,
      (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det,
      (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det,
      (a20 * b03 - a21 * b01 + a22 * b00) * det
    ];
  }

  function mat4TransformPoint(m, p) {
    const x = num(p && p.x, 0), y = num(p && p.y, 0), z = num(p && p.z, 0);
    const w = p && p.w !== undefined ? num(p.w, 1) : 1;
    return {
      x: m[0] * x + m[4] * y + m[8] * z + m[12] * w,
      y: m[1] * x + m[5] * y + m[9] * z + m[13] * w,
      z: m[2] * x + m[6] * y + m[10] * z + m[14] * w,
      w: m[3] * x + m[7] * y + m[11] * z + m[15] * w
    };
  }

  /* ===================================================================== */
  /* geometry builder                                                      */
  /* ===================================================================== */

  const GEOM = {
    panelTopY: 0.02,
    panelThicknessM: 0.03,
    railY: 0.09,
    railHeightM: 0.10,
    railWidthM: 0.05,
    rollerY: 0.17,
    rollerRadiusM: 0.035,
    rollerInsetM: 0.01,
    legHeightM: 0.65,
    legSizeM: 0.05,
    legInsetM: 0.02,
    sensorY: 0.34,
    sensorSizeM: 0.05,
    motorY: 0.13,
    motorSizeM: [0.22, 0.12, 0.09],
    cylinderSides: 10,
    /* model v2: belt conveyors and scanners */
    beltTopY: 0.06,
    pulleyDiameterM: 0.12,
    scannerY: 0.32,
    scannerSizeM: [0.14, 0.18, 0.09]
  };

  const ZONE_PANEL_COLORS = ["#2f6ea8", "#2f8a6a", "#9a7b2f", "#6a55a8", "#3b7a8a", "#a84f6e"];
  const PART_COLORS = {
    roller: "#9aa7b4",
    rail: "#7c8894",
    leg: "#5b6570",
    sensor: "#39c08a",
    motor: "#e6b450",
    belt: "#2f343b",
    pulley: "#9aa7b4",
    scanner: "#c792ea",
    mergeThroat: "#7c8894",
    mergeWarn: "#e06c6c",
    rotary: "#4d9fff",
    rotaryTop: "#dfe7f2",
    popup: "#39c08a",
    popupBelt: "#9aa7b4",
    popupUp: "#39c08a",
    popupDown: "#8b94a3",
    pusher: "#e6b450",
    deviceMarker: "#c792ea"
  };

  function hexToRgb(hex) {
    if (Array.isArray(hex) && hex.length >= 3) {
      return [clampNum(num(hex[0], 0), 0, 1), clampNum(num(hex[1], 0), 0, 1), clampNum(num(hex[2], 0), 0, 1)];
    }
    let s = String(hex === undefined || hex === null ? "#9aa7b4" : hex).replace(/^#/, "");
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return [0.6, 0.6, 0.6];
    const n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function newMesh() {
    return {
      positions: [], normals: [], indices: [], colors: [],
      bounds: { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
    };
  }

  function meshTrack(mesh, x, y, z) {
    const b = mesh.bounds;
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
  }

  function faceNormal(a, b, c) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return { x: 0, y: 1, z: 0 };
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  function pushVertex(mesh, p, n, color) {
    mesh.positions.push(p.x, p.y, p.z);
    mesh.normals.push(n.x, n.y, n.z);
    mesh.colors.push(color[0], color[1], color[2]);
    meshTrack(mesh, p.x, p.y, p.z);
  }

  function addTriangle(mesh, a, b, c, color, normal) {
    const n = normal || faceNormal(a, b, c);
    const base = mesh.positions.length / 3;
    pushVertex(mesh, a, n, color);
    pushVertex(mesh, b, n, color);
    pushVertex(mesh, c, n, color);
    mesh.indices.push(base, base + 1, base + 2);
  }

  function addQuad(mesh, a, b, c, d, color, normal) {
    const n = normal || faceNormal(a, b, c);
    const base = mesh.positions.length / 3;
    pushVertex(mesh, a, n, color);
    pushVertex(mesh, b, n, color);
    pushVertex(mesh, c, n, color);
    pushVertex(mesh, d, n, color);
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function vecAdd(base, u, su, v, sv, w, sw) {
    return {
      x: base.x + u.x * su + v.x * sv + w.x * sw,
      y: base.y + u.y * su + v.y * sv + w.y * sw,
      z: base.z + u.z * su + v.z * sv + w.z * sw
    };
  }

  /* Oriented box: centre + orthonormal axes u, v, w (right-handed) + half extents. */
  function addBox(mesh, center, u, v, w, hx, hy, hz, color) {
    const P = function (sx, sy, sz) {
      return {
        x: center.x + u.x * sx * hx + v.x * sy * hy + w.x * sz * hz,
        y: center.y + u.y * sx * hx + v.y * sy * hy + w.y * sz * hz,
        z: center.z + u.z * sx * hx + v.z * sy * hy + w.z * sz * hz
      };
    };
    /* +u */ addQuad(mesh, P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), color);
    /* -u */ addQuad(mesh, P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), color);
    /* +v */ addQuad(mesh, P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), color);
    /* -v */ addQuad(mesh, P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), color);
    /* +w */ addQuad(mesh, P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), color);
    /* -w */ addQuad(mesh, P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), color);
  }

  /* Closed cylinder: centre, unit axis, radius, half length. */
  function addCylinder(mesh, center, axis, radius, halfLength, sides, color) {
    const axLen = Math.hypot(axis.x, axis.y, axis.z);
    if (axLen < 1e-12 || !(radius > 0) || !(halfLength > 0)) return;
    const ax = { x: axis.x / axLen, y: axis.y / axLen, z: axis.z / axLen };
    const helper = Math.abs(ax.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let e1 = {
      x: helper.y * ax.z - helper.z * ax.y,
      y: helper.z * ax.x - helper.x * ax.z,
      z: helper.x * ax.y - helper.y * ax.x
    };
    let l = Math.hypot(e1.x, e1.y, e1.z) || 1;
    e1 = { x: e1.x / l, y: e1.y / l, z: e1.z / l };
    const e2 = {
      x: ax.y * e1.z - ax.z * e1.y,
      y: ax.z * e1.x - ax.x * e1.z,
      z: ax.x * e1.y - ax.y * e1.x
    };
    const n = Math.max(4, Math.round(num(sides, GEOM.cylinderSides)));
    const ringA = [], ringB = [];
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const c = Math.cos(th) * radius, s = Math.sin(th) * radius;
      const px = e1.x * c + e2.x * s;
      const py = e1.y * c + e2.y * s;
      const pz = e1.z * c + e2.z * s;
      ringA.push({
        x: center.x - ax.x * halfLength + px,
        y: center.y - ax.y * halfLength + py,
        z: center.z - ax.z * halfLength + pz
      });
      ringB.push({
        x: center.x + ax.x * halfLength + px,
        y: center.y + ax.y * halfLength + py,
        z: center.z + ax.z * halfLength + pz
      });
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      addQuad(mesh, ringA[i], ringA[j], ringB[j], ringB[i], color);
    }
    const capA = { x: center.x - ax.x * halfLength, y: center.y - ax.y * halfLength, z: center.z - ax.z * halfLength };
    const capB = { x: center.x + ax.x * halfLength, y: center.y + ax.y * halfLength, z: center.z + ax.z * halfLength };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      addTriangle(mesh, capB, ringB[i], ringB[j], color);
      addTriangle(mesh, capA, ringA[j], ringA[i], color);
    }
  }

  /* Truncated cone (tapered roller): radius varies from rA at -halfLength to rB at
     +halfLength along the axis. Used for tapered rollers under curves/spirals. */
  function addTaperedCylinder(mesh, center, axis, rA, rB, halfLength, sides, color) {
    const axLen = Math.hypot(axis.x, axis.y, axis.z);
    if (axLen < 1e-12 || !(rA > 0) || !(rB > 0) || !(halfLength > 0)) return;
    const ax = { x: axis.x / axLen, y: axis.y / axLen, z: axis.z / axLen };
    const helper = Math.abs(ax.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let e1 = {
      x: helper.y * ax.z - helper.z * ax.y,
      y: helper.z * ax.x - helper.x * ax.z,
      z: helper.x * ax.y - helper.y * ax.x
    };
    let l = Math.hypot(e1.x, e1.y, e1.z) || 1;
    e1 = { x: e1.x / l, y: e1.y / l, z: e1.z / l };
    const e2 = {
      x: ax.y * e1.z - ax.z * e1.y,
      y: ax.z * e1.x - ax.x * e1.z,
      z: ax.x * e1.y - ax.y * e1.x
    };
    const n = Math.max(4, Math.round(num(sides, GEOM.cylinderSides)));
    const ringA = [], ringB = [];
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const ca = Math.cos(th), sa = Math.sin(th);
      const pxA = e1.x * ca * rA + e2.x * sa * rA;
      const pyA = e1.y * ca * rA + e2.y * sa * rA;
      const pzA = e1.z * ca * rA + e2.z * sa * rA;
      const pxB = e1.x * ca * rB + e2.x * sa * rB;
      const pyB = e1.y * ca * rB + e2.y * sa * rB;
      const pzB = e1.z * ca * rB + e2.z * sa * rB;
      ringA.push({
        x: center.x - ax.x * halfLength + pxA,
        y: center.y - ax.y * halfLength + pyA,
        z: center.z - ax.z * halfLength + pzA
      });
      ringB.push({
        x: center.x + ax.x * halfLength + pxB,
        y: center.y + ax.y * halfLength + pyB,
        z: center.z + ax.z * halfLength + pzB
      });
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      addQuad(mesh, ringA[i], ringA[j], ringB[j], ringB[i], color);
    }
    const capA = { x: center.x - ax.x * halfLength, y: center.y - ax.y * halfLength, z: center.z - ax.z * halfLength };
    const capB = { x: center.x + ax.x * halfLength, y: center.y + ax.y * halfLength, z: center.z + ax.z * halfLength };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      addTriangle(mesh, capB, ringB[i], ringB[j], color);
      addTriangle(mesh, capA, ringA[j], ringA[i], color);
    }
  }

  /* Rail box run along a model edge polyline ([{x,y,z}] with elevation). */
  function addRailRun(mesh, edge, railH, railW, railY, color) {
    if (!Array.isArray(edge) || edge.length < 2) return;
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1], b = edge[i];
      const ax = num(a.x, 0), ay = num(a.y, 0), az = num(a.z, 0);
      const bx = num(b.x, 0), by = num(b.y, 0), bz = num(b.z, 0);
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const edgeLen = Math.hypot(dx, dy, dz);
      if (edgeLen < 1e-9) continue;
      const planLen = Math.hypot(dx, dy);
      if (planLen < 1e-9) continue;
      const u = normalize3({ x: dx, y: dz, z: dy });
      const w = { x: -dy / planLen, y: 0, z: dx / planLen };
      const v = normalize3(cross3(w, u));
      const mid = { x: (ax + bx) / 2, y: (az + bz) / 2 + railY, z: (ay + by) / 2 };
      addBox(mesh, mid, u, v, w, edgeLen / 2, railH / 2, railW / 2, color);
    }
  }

  /* Continuous belt band (top surface quads following the centreline, incl. elevation). */
  function addBeltBand(mesh, pts, half, beltTopY, color) {
    for (let i = 1; i < pts.length; i++) {
      const a = modelTo3D(pts[i - 1]), b = modelTo3D(pts[i]);
      const dx = b.x - a.x, dz = b.z - a.z;
      const planLen = Math.hypot(dx, dz);
      if (planLen < 1e-9) continue;
      const nx = -dz / planLen, nz = dx / planLen;
      const aL = { x: a.x + nx * half, y: a.y + beltTopY, z: a.z + nz * half };
      const aR = { x: a.x - nx * half, y: a.y + beltTopY, z: a.z - nz * half };
      const bL = { x: b.x + nx * half, y: b.y + beltTopY, z: b.z + nz * half };
      const bR = { x: b.x - nx * half, y: b.y + beltTopY, z: b.z - nz * half };
      addQuad(mesh, aL, bL, bR, aR, color);
    }
  }

  /* Flat coloured decal quad on the belt surface (zone colour). */
  function addBeltZoneDecal(mesh, zone, y, color) {
    const basis = planBasis(num(zone.angleDeg, 0));
    const cx = num(zone.x, 0), cz = num(zone.y, 0);
    const hl = Math.max(0.02, num(zone.lengthM, 1) / 2);
    const hw = Math.max(0.02, num(zone.widthM, 0.6) / 2);
    const t = basis.tangent, n = basis.normal;
    const p1 = { x: cx - t.x * hl + n.x * hw, y: y, z: cz - t.z * hl + n.z * hw };
    const p2 = { x: cx - t.x * hl - n.x * hw, y: y, z: cz - t.z * hl - n.z * hw };
    const p3 = { x: cx + t.x * hl - n.x * hw, y: y, z: cz + t.z * hl - n.z * hw };
    const p4 = { x: cx + t.x * hl + n.x * hw, y: y, z: cz + t.z * hl + n.z * hw };
    /* (p1, p4, p3, p2) winds counter-clockwise seen from above -> +Y normal */
    addQuad(mesh, p1, p4, p3, p2, color);
  }

  function rollerCountFor(length, pitch) {
    if (!(length > 0) || !(pitch > 0)) return 0;
    return Math.floor(length / pitch + 1e-6) + 1;
  }

  function makePartColors(opts) {
    return {
      roller: hexToRgb(opts.rollerColor || PART_COLORS.roller),
      rail: hexToRgb(opts.railColor || PART_COLORS.rail),
      leg: hexToRgb(opts.legColor || PART_COLORS.leg),
      sensor: hexToRgb(opts.sensorColor || PART_COLORS.sensor),
      motor: hexToRgb(opts.motorColor || PART_COLORS.motor),
      belt: hexToRgb(opts.beltColor || PART_COLORS.belt),
      pulley: hexToRgb(opts.pulleyColor || PART_COLORS.pulley),
      scanner: hexToRgb(opts.scannerColor || PART_COLORS.scanner),
      mergeThroat: hexToRgb(opts.mergeThroatColor || PART_COLORS.mergeThroat),
      mergeWarn: hexToRgb(opts.mergeWarnColor || PART_COLORS.mergeWarn),
      rotary: hexToRgb(opts.rotaryColor || PART_COLORS.rotary),
      rotaryTop: hexToRgb(opts.rotaryTopColor || PART_COLORS.rotaryTop),
      popup: hexToRgb(opts.popupColor || PART_COLORS.popup),
      popupBelt: hexToRgb(opts.popupBeltColor || PART_COLORS.popupBelt),
      popupUp: hexToRgb(opts.popupUpColor || PART_COLORS.popupUp),
      popupDown: hexToRgb(opts.popupDownColor || PART_COLORS.popupDown),
      pusher: hexToRgb(opts.pusherColor || PART_COLORS.pusher),
      deviceMarker: hexToRgb(opts.deviceMarkerColor || PART_COLORS.deviceMarker),
      panels: (Array.isArray(opts.panelColors) && opts.panelColors.length ? opts.panelColors : ZONE_PANEL_COLORS).map(hexToRgb)
    };
  }

  function zoneColor(env, zone, localIndex) {
    const gi = Number(zone && zone.index);
    const idx = Number.isFinite(gi) ? gi : localIndex;
    const list = env.panels;
    return list[((idx % list.length) + list.length) % list.length];
  }

  function dimsFromOptions(opts) {
    return {
      railY: num(opts.railY, GEOM.railY),
      railH: Math.max(0.01, num(opts.railHeightM, GEOM.railHeightM)),
      railW: Math.max(0.01, num(opts.railWidthM, GEOM.railWidthM)),
      panelY: num(opts.panelTopY, GEOM.panelTopY),
      panelT: Math.max(0.005, num(opts.panelThicknessM, GEOM.panelThicknessM)),
      rollerY: num(opts.rollerY, GEOM.rollerY),
      rollerR: Math.max(0.005, num(opts.rollerRadiusM, GEOM.rollerRadiusM)),
      legH: Math.max(0.05, num(opts.legHeightM, GEOM.legHeightM)),
      legSize: Math.max(0.01, num(opts.legSizeM, GEOM.legSizeM)),
      sensorSize: Math.max(0.01, num(opts.sensorSizeM, GEOM.sensorSizeM)),
      sensorY: num(opts.sensorY, GEOM.sensorY),
      motorY: num(opts.motorY, GEOM.motorY),
      motorBox: Array.isArray(opts.motorSizeM) ? opts.motorSizeM : GEOM.motorSizeM,
      sides: Math.round(num(opts.cylinderSides, GEOM.cylinderSides)),
      pitch: Math.max(0.01, num(opts.rollerPitchM, 0.1)),
      legSpacing: Math.max(0.2, num(opts.legSpacingM, 1.5)),
      beltTopY: num(opts.beltTopY, GEOM.beltTopY),
      pulleyR: Math.max(0.01, num(opts.pulleyDiameterM, GEOM.pulleyDiameterM) / 2),
      scannerSize: Array.isArray(opts.scannerSizeM) ? opts.scannerSizeM : GEOM.scannerSizeM,
      scannerY: num(opts.scannerY, GEOM.scannerY),
      rollerInset: Math.max(0.001, num(opts.rollerInsetM, GEOM.rollerInsetM)),
      legInset: Math.max(0, num(opts.legInsetM, GEOM.legInsetM))
    };
  }

  /* Simple per-vertex plan offset (fallback when computed leftEdge/rightEdge are absent). */
  function offsetPlanPolyline(pts, dist) {
    const out = [];
    if (!pts || !pts.length) return out;
    for (let i = 0; i < pts.length; i++) {
      let dx, dy;
      if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
      else if (i === pts.length - 1) { dx = pts[i].x - pts[i - 1].x; dy = pts[i].y - pts[i - 1].y; }
      else { dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y; }
      const len = Math.hypot(dx, dy) || 1;
      out.push({ x: pts[i].x - dy / len * dist, y: pts[i].y + dx / len * dist, z: num(pts[i].z, 0) });
    }
    return out;
  }

  /* One chained segment: rounded-edge rails, roller bed or belt band, legs, zone
     sensors/motors. All y values are belt elevation (0 = base design plane), x/z are
     the plan coordinates; a spiral's polyline raises y along the helix. */
  function buildSegmentGeometry(mesh, counts, seg, segIndex, opts, env) {
    const pts = seg && seg.polyline;
    if (!pts || pts.length < 2) return;
    counts.segments += 1;
    const width = Math.max(0.05, num(seg.widthM, num(opts.widthM, 0.6)));
    const half = width / 2;
    const length = Math.max(0.01, num(seg.lengthM, polylineLength3(pts)));
    const zones = Array.isArray(seg.zones) && seg.zones.length ? seg.zones : null;
    const isBelt = String(seg.conveyorType || opts.conveyorType || "roller").toLowerCase() === "belt";
    const up = { x: 0, y: 1, z: 0 };
    const d = dimsFromOptions(opts);
    const floorY = -d.legH;

    /* --- coloured zone floor panels (roller) / zone decals on the belt --- */
    if (zones) {
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        const color = zoneColor(env, z, zi);
        const deckZ = num(z.z, 0);
        if (isBelt) {
          addBeltZoneDecal(mesh, z, deckZ + d.beltTopY + 0.002, color);
        } else {
          const basis = planBasis(num(z.angleDeg, 0));
          addBox(mesh, {
            x: num(z.x, 0), y: deckZ + d.panelY - d.panelT / 2, z: num(z.y, 0)
          }, basis.tangent, up, basis.normal,
            Math.max(0.02, num(z.lengthM, 1) / 2), d.panelT / 2, half, color);
        }
        counts.panels += 1;
      }
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const planLen = Math.hypot(dx, dy);
        if (planLen < 1e-9) continue;
        const basis = planBasis(Math.atan2(dy, dx) * 180 / Math.PI);
        const deckZ = (num(a.z, 0) + num(b.z, 0)) / 2;
        addBox(mesh, {
          x: (a.x + b.x) / 2, y: deckZ + d.panelY - d.panelT / 2, z: (a.y + b.y) / 2
        }, basis.tangent, up, basis.normal, planLen / 2, d.panelT / 2, half, env.panels[0]);
      }
      counts.panels += 1;
    }

    /* --- two side rails per segment along the rounded model edges --- */
    const leftEdge = (Array.isArray(seg.leftEdge) && seg.leftEdge.length >= 2) ? seg.leftEdge : null;
    const rightEdge = (Array.isArray(seg.rightEdge) && seg.rightEdge.length >= 2) ? seg.rightEdge : null;
    if (leftEdge && rightEdge) {
      addRailRun(mesh, leftEdge, d.railH, d.railW, d.railY, env.rail);
      addRailRun(mesh, rightEdge, d.railH, d.railW, d.railY, env.rail);
    } else {
      addRailRun(mesh, offsetPlanPolyline(pts, half), d.railH, d.railW, d.railY, env.rail);
      addRailRun(mesh, offsetPlanPolyline(pts, -half), d.railH, d.railW, d.railY, env.rail);
    }
    counts.rails += 2;

    /* --- belt band + pulleys or roller bed --- */
    if (isBelt) {
      counts.beltSegments += 1;
      addBeltBand(mesh, pts, half, d.beltTopY, env.belt);
      const b0 = planBasis(num(seg.startHeadingDeg, 0));
      const b1 = planBasis(num(seg.endHeadingDeg, 0));
      const p0 = pts[0], p1 = pts[pts.length - 1];
      const pulleyY = d.beltTopY - d.pulleyR * 0.5;
      addCylinder(mesh, {
        x: num(p0.x, 0), y: num(p0.z, 0) + pulleyY, z: num(p0.y, 0)
      }, b0.normal, d.pulleyR, Math.max(0.05, half - 0.005), d.sides, env.pulley);
      addCylinder(mesh, {
        x: num(p1.x, 0), y: num(p1.z, 0) + pulleyY, z: num(p1.y, 0)
      }, b1.normal, d.pulleyR, Math.max(0.05, half - 0.005), d.sides, env.pulley);
      counts.pulleys += 2;
      /* head drive box off the belt side */
      addBox(mesh, {
        x: num(p0.x, 0) + b0.normal.x * (half + 0.13),
        y: num(p0.z, 0) + d.motorY,
        z: num(p0.y, 0) + b0.normal.z * (half + 0.13)
      }, b0.tangent, up, b0.normal, 0.09, 0.07, 0.07, env.motor);
      counts.motors += 1;
    } else {
      const rollerCount = rollerCountFor(length, d.pitch);
      const rollerHalf = Math.max(0.01, half - d.rollerInset);
      const taper = seg.taper || null;
      const taperDelta = Math.max(0, num(taper && taper.deltaM, num(opts.taperDeltaM, 0)));
      const tapered = !!(taper && taperDelta > 0);
      for (let i = 0; i < rollerCount; i++) {
        const q = pointAtDistance3(pts, Math.min(length, i * d.pitch));
        const basis = planBasis(q.angleDeg);
        const center = { x: q.x, y: q.z + d.rollerY, z: q.y };
        if (tapered) {
          addTaperedCylinder(mesh, center, basis.normal, d.rollerR, d.rollerR + taperDelta / 2,
            rollerHalf, d.sides, env.roller);
          counts.taperedRollers += 1;
        } else {
          addCylinder(mesh, center, basis.normal, d.rollerR, rollerHalf, d.sides, env.roller);
        }
        counts.rollers += 1;
      }
    }

    /* --- support legs to the floor, at least 2 stations per segment --- */
    const stations = Math.max(2, Math.ceil(length / d.legSpacing) + 1);
    for (let s = 0; s < stations; s++) {
      const t = stations > 1 ? (length * s) / (stations - 1) : 0;
      const q = pointAtDistance3(pts, t);
      const basis = planBasis(q.angleDeg);
      const legTop = q.z + d.railY - d.railH / 2;
      const legH = legTop - floorY;
      if (!(legH > 0.05)) continue;
      const offs = half - d.legInset;
      for (const side of [-1, 1]) {
        addBox(mesh, {
          x: q.x + basis.normal.x * offs * side,
          y: (legTop + floorY) / 2,
          z: q.y + basis.normal.z * offs * side
        }, basis.tangent, up, basis.normal, d.legSize / 2, legH / 2, d.legSize / 2, env.leg);
        counts.legs += 1;
      }
    }

    /* --- sensor at each zone start + motor at each zone centre (roller) --- */
    if (zones) {
      for (let zi = 0; zi < zones.length; zi++) {
        const t0 = length * zi / zones.length;
        const tMid = length * (zi + 0.5) / zones.length;
        const qStart = pointAtDistance3(pts, t0);
        const qMid = pointAtDistance3(pts, tMid);
        const bStart = planBasis(qStart.angleDeg);
        const bMid = planBasis(qMid.angleDeg);
        const sensorOff = half + 0.06;
        addBox(mesh, {
          x: qStart.x + bStart.normal.x * sensorOff,
          y: qStart.z + d.sensorY,
          z: qStart.y + bStart.normal.z * sensorOff
        }, bStart.tangent, up, bStart.normal, d.sensorSize / 2, d.sensorSize / 2, d.sensorSize / 2, env.sensor);
        counts.sensors += 1;
        if (!isBelt) {
          const motorOff = half + 0.07;
          addBox(mesh, {
            x: qMid.x + bMid.normal.x * motorOff,
            y: qMid.z + d.motorY,
            z: qMid.y + bMid.normal.z * motorOff
          }, bMid.tangent, up, bMid.normal,
            Math.max(0.02, num(d.motorBox[0], GEOM.motorSizeM[0]) / 2),
            Math.max(0.02, num(d.motorBox[1], GEOM.motorSizeM[1]) / 2),
            Math.max(0.02, num(d.motorBox[2], GEOM.motorSizeM[2]) / 2), env.motor);
          counts.motors += 1;
        }
      }
    }
  }

  /* Scanner/camera devices at computed.scannedZones positions, offset across the width. */
  function buildScannerGeometry(mesh, counts, computed, opts, env) {
    const scans = (computed && Array.isArray(computed.scannedZones)) ? computed.scannedZones : [];
    if (!scans.length) return;
    const segs = (computed && computed.segments) || [];
    const d = dimsFromOptions(opts);
    const up = { x: 0, y: 1, z: 0 };
    for (const s of scans) {
      const seg = segs.find(function (x) { return x.id === s.segmentId; });
      const width = seg ? num(seg.widthM, 0.6) : 0.6;
      const basis = planBasis(num(s.angleDeg, 0));
      const side = String(s.side || "right").toLowerCase() === "left" ? 1 : -1;
      const off = width / 2 + 0.22;
      const cx = num(s.x, 0) + basis.normal.x * off * side;
      const cz = num(s.y, 0) + basis.normal.z * off * side;
      const cy = num(s.z, 0) + d.scannerY;
      addBox(mesh, { x: cx, y: cy, z: cz }, basis.tangent, up, basis.normal,
        Math.max(0.02, num(d.scannerSize[0], 0.14) / 2),
        Math.max(0.02, num(d.scannerSize[1], 0.18) / 2),
        Math.max(0.02, num(d.scannerSize[2], 0.09) / 2), env.scanner);
      counts.scanners += 1;
    }
  }

  /* Side plates bridging angled chain joints (rounded fillet is in the rail runs). */
  function buildJointGeometry(mesh, counts, computed, opts, env) {
    const joints = (computed && Array.isArray(computed.joints)) ? computed.joints : [];
    if (!joints.length) return;
    const segs = (computed && computed.segments) || [];
    const d = dimsFromOptions(opts);
    const up = { x: 0, y: 1, z: 0 };
    for (const j of joints) {
      const turn = num(j.turnDeg, 0);
      if (Math.abs(turn) < 0.5) continue;
      const prev = segs[j.index - 1];
      const heading = prev ? num(prev.endHeadingDeg, 0) : 0;
      const basis = planBasis(heading + turn / 2);
      const p = j.point || { x: 0, y: 0, z: 0 };
      addBox(mesh, {
        x: num(p.x, 0), y: num(p.z, 0) + d.railY, z: num(p.y, 0)
      }, basis.tangent, up, basis.normal, 0.03, d.railH / 2 + 0.01,
        Math.max(0.1, num(j.widthM, 0.6) / 2 + 0.04), env.rail);
      counts.joints += 1;
    }
  }

  /* ---- model v3: merge junctions + transfer devices (pure geometry) ------ */

  function roundedPolygonPlan(pts, radius) {
    if (!pts || pts.length < 3) return pts ? pts.slice() : [];
    const r = Math.max(0, num(radius, 0));
    if (r <= 0) return pts.slice();
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
      const v2x = next.x - cur.x, v2y = next.y - cur.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) { out.push({ x: num(cur.x, 0), y: num(cur.y, 0) }); continue; }
      const rr = Math.min(r, l1 * 0.45, l2 * 0.45);
      const a = { x: cur.x + v1x / l1 * rr, y: cur.y + v1y / l1 * rr };
      const b = { x: cur.x + v2x / l2 * rr, y: cur.y + v2y / l2 * rr };
      for (let s = 0; s <= 4; s++) {
        const t = s / 4, mt = 1 - t;
        out.push({
          x: mt * mt * a.x + 2 * mt * t * cur.x + t * t * b.x,
          y: mt * mt * a.y + 2 * mt * t * cur.y + t * t * b.y
        });
      }
    }
    return out;
  }

  /* Plan-view throat of a merge: spur end cross-section -> main cross-section. */
  function mergeJunction2D(computed, merge) {
    if (!computed || !merge) return null;
    const segs = computed.segments || [];
    const find = function (id) { return segs.find(function (s) { return s.id === id; }) || null; };
    const mainSeg = find(merge.mainSegmentId);
    const spurSeg = find(merge.spurEndSegmentId);
    const M = { x: num(merge.x, 0), y: num(merge.y, 0) };
    const mainAngle = num(merge.angleDeg, mainSeg ? mainSeg.endHeadingDeg : 0);
    const mainHalf = mainSeg ? num(mainSeg.widthM, 0.6) / 2 : 0.3;
    const spurHalf = spurSeg ? num(spurSeg.widthM, 0.6) / 2 : 0.3;
    const E = (spurSeg && spurSeg.end)
      ? { x: num(spurSeg.end.x, M.x), y: num(spurSeg.end.y, M.y), z: num(spurSeg.end.z, 0) }
      : { x: M.x, y: M.y, z: num(merge.z, 0) };
    const spurAngle = spurSeg ? num(spurSeg.endHeadingDeg, mainAngle) : mainAngle;
    const measuredGap = Math.hypot(E.x - M.x, E.y - M.y);
    const reportedGap = (merge.gapM === undefined || merge.gapM === null) ? measuredGap : num(merge.gapM, measuredGap);
    const mB = planBasis(mainAngle), sB = planBasis(spurAngle);
    const mLeft = { x: M.x + mB.normal.x * mainHalf, y: M.y + mB.normal.z * mainHalf };
    const mRight = { x: M.x - mB.normal.x * mainHalf, y: M.y - mB.normal.z * mainHalf };
    const eLeft = { x: E.x + sB.normal.x * spurHalf, y: E.y + sB.normal.z * spurHalf };
    const eRight = { x: E.x - sB.normal.x * spurHalf, y: E.y - sB.normal.z * spurHalf };
    return {
      mergePoint: M, spurEnd: E, mainAngleDeg: mainAngle, spurAngleDeg: spurAngle,
      mainHalfWidthM: mainHalf, spurHalfWidthM: spurHalf,
      gapM: reportedGap, measuredGapM: measuredGap,
      warning: reportedGap > 1.0,
      polygon: roundedPolygonPlan([eLeft, eRight, mRight, mLeft], Math.min(mainHalf, spurHalf) * 0.45)
    };
  }

  /* Box beam between two 3D points (rail links, merge nose). */
  function addBeam(mesh, a, b, width, height, color) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    const u = { x: dx / len, y: dy / len, z: dz / len };
    const up = { x: 0, y: 1, z: 0 };
    let w = cross3(u, up);
    if (Math.hypot(w.x, w.y, w.z) < 1e-9) w = { x: 0, y: 0, z: 1 };
    w = normalize3(w);
    const v = normalize3(cross3(w, u));
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    addBox(mesh, center, u, v, w, len / 2, Math.max(0.005, num(height, 0.05)) / 2,
      Math.max(0.005, num(width, 0.05)) / 2, color);
  }

  /* Extruded slab from a plan polygon (merge throat plate). */
  function addSlabFromPolygon(mesh, poly, yTop, thickness, color) {
    if (!poly || poly.length < 3) return;
    const y = num(yTop, 0), t = Math.max(0.005, num(thickness, 0.03));
    const top = poly.map(function (p) { return { x: num(p.x, 0), y: y, z: num(p.y, 0) }; });
    const bottom = poly.map(function (p) { return { x: num(p.x, 0), y: y - t, z: num(p.y, 0) }; });
    let cx = 0, cz = 0;
    for (const p of top) { cx += p.x; cz += p.z; }
    cx /= top.length; cz /= top.length;
    const topC = { x: cx, y: y, z: cz };
    const botC = { x: cx, y: y - t, z: cz };
    const upN = { x: 0, y: 1, z: 0 }, downN = { x: 0, y: -1, z: 0 };
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length;
      addTriangle(mesh, topC, top[i], top[j], color, upN);
      addTriangle(mesh, botC, bottom[j], bottom[i], color, downN);
      addQuad(mesh, top[i], top[j], bottom[j], bottom[i], color);
    }
  }

  /* Flat raised arrow decal on a horizontal plane (transfer direction glyphs). */
  function addFlatArrow(mesh, center, dir, y, length, width, color) {
    const len = Math.max(0.05, num(length, 0.4));
    const halfW = Math.max(0.01, num(width, 0.05)) / 2;
    const dx = num(dir && dir.x, 1), dy = num(dir && dir.y, 0);
    const dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    const px = -uy, py = ux;
    const yy = num(y, 0);
    const P = function (x2, y2) { return { x: x2, y: yy, z: y2 }; };
    const shaftEnd = { x: center.x + ux * len * 0.6, y: center.y + uy * len * 0.6 };
    const tip = { x: center.x + ux * len, y: center.y + uy * len };
    const upN = { x: 0, y: 1, z: 0 };
    addQuad(mesh,
      P(center.x - px * halfW, center.y - py * halfW),
      P(shaftEnd.x - px * halfW, shaftEnd.y - py * halfW),
      P(shaftEnd.x + px * halfW, shaftEnd.y + py * halfW),
      P(center.x + px * halfW, center.y + py * halfW), color, upN);
    addTriangle(mesh,
      P(shaftEnd.x - px * halfW * 2.2, shaftEnd.y - py * halfW * 2.2),
      P(shaftEnd.x + px * halfW * 2.2, shaftEnd.y + py * halfW * 2.2),
      P(tip.x, tip.y), color, upN);
  }

  /* Merge throat plates + spur rails joining the main rails. */
  function buildMergeGeometry(mesh, counts, computed, opts, env) {
    const merges = (computed && Array.isArray(computed.merges)) ? computed.merges : [];
    if (!merges.length) return;
    const d = dimsFromOptions(opts);
    const up = { x: 0, y: 1, z: 0 };
    for (const mg of merges) {
      const geo = mergeJunction2D(computed, mg);
      if (!geo) continue;
      const deck = Math.max(num(geo.spurEnd.z, 0), num(geo.mergePoint.z, 0));
      addSlabFromPolygon(mesh, geo.polygon, deck + d.panelY + 0.005, 0.03,
        geo.warning ? env.mergeWarn : env.mergeThroat);
      counts.merges += 1;
      const railY = deck + d.railY;
      const sB = planBasis(geo.spurAngleDeg), mB = planBasis(geo.mainAngleDeg);
      const spurL = { x: geo.spurEnd.x + sB.normal.x * geo.spurHalfWidthM, y: railY, z: geo.spurEnd.y + sB.normal.z * geo.spurHalfWidthM };
      const spurR = { x: geo.spurEnd.x - sB.normal.x * geo.spurHalfWidthM, y: railY, z: geo.spurEnd.y - sB.normal.z * geo.spurHalfWidthM };
      const mainL = { x: geo.mergePoint.x + mB.normal.x * geo.mainHalfWidthM, y: railY, z: geo.mergePoint.y + mB.normal.z * geo.mainHalfWidthM };
      const mainR = { x: geo.mergePoint.x - mB.normal.x * geo.mainHalfWidthM, y: railY, z: geo.mergePoint.y - mB.normal.z * geo.mainHalfWidthM };
      addBeam(mesh, spurL, mainL, d.railW, d.railH, env.rail);
      addBeam(mesh, spurR, mainR, d.railW, d.railH, env.rail);
      counts.mergeRailLinks += 2;
    }
  }

  function transferSegmentWidth(computed, tf) {
    const segs = (computed && computed.segments) || [];
    const seg = segs.find(function (s) { return s.id === tf.segmentId; });
    return seg ? num(seg.widthM, 0.6) : 0.6;
  }

  function addDeviceMarker(mesh, counts, center3, tangent, env) {
    addBox(mesh, {
      x: center3.x + tangent.x * 0.8, y: center3.y + 0.45, z: center3.z + tangent.z * 0.8
    }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
      0.05, 0.06, 0.05, env.deviceMarker);
    counts.deviceMarkers += 1;
  }

  /* Transfer devices: pusher, rotary table, cross-belt pop-up transfer. */
  function buildTransferGeometry(mesh, counts, computed, opts, env) {
    const transfers = (computed && Array.isArray(computed.transfers)) ? computed.transfers : [];
    if (!transfers.length) return;
    const d = dimsFromOptions(opts);
    const up = { x: 0, y: 1, z: 0 };
    for (const tf of transfers) {
      const half = transferSegmentWidth(computed, tf) / 2;
      const basis = planBasis(num(tf.angleDeg, 0));
      const center = { x: num(tf.x, 0), y: num(tf.z, 0), z: num(tf.y, 0) };
      const type = String(tf.type || "pusher");
      if (type === "rotary_table") {
        const R = Math.max(0.24, Math.min(0.6, half * 1.2));
        addCylinder(mesh, { x: center.x, y: center.y + 0.035, z: center.z },
          up, R, 0.035, 18, env.rotary);
        addCylinder(mesh, { x: center.x, y: center.y + 0.085, z: center.z },
          up, R * 0.84, 0.015, 18, env.rotaryTop);
        /* bidirectional rotation glyph: two flat arrows in opposite directions */
        addFlatArrow(mesh, { x: center.x + basis.tangent.x * R * 0.10, y: center.z + basis.tangent.z * R * 0.10 },
          { x: basis.tangent.x, y: basis.tangent.z }, center.y + 0.105, R * 1.15, R * 0.42, env.rotary);
        addFlatArrow(mesh, { x: center.x - basis.tangent.x * R * 0.10, y: center.z - basis.tangent.z * R * 0.10 },
          { x: -basis.tangent.x, y: -basis.tangent.z }, center.y + 0.108, R * 1.15, R * 0.42, env.rotaryTop);
        counts.rotaryTables += 1;
        addDeviceMarker(mesh, counts, center, basis.tangent, env);
      } else if (type === "popup_transfer") {
        const hl = 0.28, hw = half + 0.15;
        addBox(mesh, { x: center.x, y: center.y + 0.04, z: center.z },
          basis.tangent, up, basis.normal, hl, 0.02, hw, env.popup);
        const count = Math.max(1, Math.round(num(tf.popup && tf.popup.beltCount, 3)));
        for (let i = 0; i < count; i++) {
          const f = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * 2 * hl * 0.7;
          addCylinder(mesh, {
            x: center.x + basis.tangent.x * f, y: center.y + 0.095, z: center.z + basis.tangent.z * f
          }, basis.normal, 0.035, Math.max(0.05, hw - 0.01), 8, env.popupBelt);
          counts.popupBelts += 1;
        }
        /* guide posts + raise/lower indication pads (green = raised, grey = lowered) */
        for (const st of [-1, 1]) {
          for (const sn of [-1, 1]) {
            addBox(mesh, {
              x: center.x + basis.tangent.x * st * 0.24 + basis.normal.x * sn * hw,
              y: center.y + 0.09,
              z: center.z + basis.tangent.z * st * 0.24 + basis.normal.z * sn * hw
            }, basis.tangent, up, basis.normal, 0.02, 0.09, 0.02, env.popup);
          }
        }
        addBox(mesh, {
          x: center.x + basis.tangent.x * 0.34,
          y: center.y + 0.24,
          z: center.z + basis.tangent.z * 0.34
        }, basis.tangent, up, basis.normal, 0.05, 0.06, 0.05, env.popupUp);
        addBox(mesh, {
          x: center.x - basis.tangent.x * 0.34,
          y: center.y + 0.05,
          z: center.z - basis.tangent.z * 0.34
        }, basis.tangent, up, basis.normal, 0.05, 0.02, 0.05, env.popupDown);
        counts.popupTransfers += 1;
        addDeviceMarker(mesh, counts, center, basis.tangent, env);
      } else {
        const sideSign = String(tf.side || "right").toLowerCase() === "left" ? 1 : -1;
        const mount = {
          x: center.x + basis.normal.x * sideSign * (half + 0.55),
          y: center.y + 0.18,
          z: center.z + basis.normal.z * sideSign * (half + 0.55)
        };
        addCylinder(mesh, mount, basis.normal, 0.05, 0.17, 10, env.pusher);
        const tip = {
          x: center.x + basis.normal.x * sideSign * (half + 0.04),
          y: center.y + 0.18,
          z: center.z + basis.normal.z * sideSign * (half + 0.04)
        };
        addBox(mesh, tip, basis.tangent, up, basis.normal, 0.22, 0.1, 0.02, env.pusher);
        addBeam(mesh, mount, tip, 0.05, 0.05, env.pusher);
        counts.pushers += 1;
        addDeviceMarker(mesh, counts, center, basis.tangent, env);
      }
    }
  }

  /* Build combined conveyor geometry for a computed design (see header). */
  function buildConveyorGeometry(computed, opts) {
    opts = opts || {};
    const o = Object.assign({}, opts);
    if (o.conveyorType === undefined) o.conveyorType = computed && computed.conveyorType;
    const mesh = newMesh();
    const counts = {
      segments: 0, rails: 0, rollers: 0, taperedRollers: 0, legs: 0,
      sensors: 0, motors: 0, panels: 0, pulleys: 0, beltSegments: 0,
      scanners: 0, joints: 0,
      merges: 0, mergeRailLinks: 0,
      transfers: 0, pushers: 0, rotaryTables: 0, popupTransfers: 0,
      popupBelts: 0, deviceMarkers: 0
    };
    const env = makePartColors(o);
    const segments = computed && Array.isArray(computed.segments) ? computed.segments : [];
    for (let i = 0; i < segments.length; i++) {
      buildSegmentGeometry(mesh, counts, segments[i], i, o, env);
    }
    buildJointGeometry(mesh, counts, computed, o, env);
    buildScannerGeometry(mesh, counts, computed, o, env);
    buildMergeGeometry(mesh, counts, computed, o, env);
    buildTransferGeometry(mesh, counts, computed, o, env);
    counts.transfers = counts.pushers + counts.rotaryTables + counts.popupTransfers;
    const b = mesh.bounds;
    if (!Number.isFinite(b.minX)) {
      mesh.bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    }
    return {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      colors: mesh.colors,
      counts: counts,
      bounds: mesh.bounds
    };
  }

  /* ===================================================================== */
  /* WebGL shaders / feature detection                                     */
  /* ===================================================================== */

  const VERTEX_SHADER = [
    "attribute vec3 aPosition;",
    "attribute vec3 aNormal;",
    "attribute vec3 aColor;",
    "uniform mat4 uMVP;",
    "uniform vec3 uLightDir;",
    "varying vec3 vColor;",
    "void main() {",
    "  vec3 n = normalize(aNormal);",
    "  vec3 l = normalize(uLightDir);",
    "  float diff = max(dot(n, l), 0.0);",
    "  float sky = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0) * 0.10;",
    "  vColor = aColor * (0.40 + 0.68 * diff) + vec3(0.02, 0.025, 0.035) * sky;",
    "  gl_Position = uMVP * vec4(aPosition, 1.0);",
    "}"
  ].join("\n");

  const FRAGMENT_SHADER = [
    "precision mediump float;",
    "varying vec3 vColor;",
    "void main() {",
    "  gl_FragColor = vec4(vColor, 1.0);",
    "}"
  ].join("\n");

  function hasWebGLSupport() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
    try {
      const canvas = document.createElement("canvas");
      if (!canvas || typeof canvas.getContext !== "function") return false;
      return !!(canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }

  function hasDom() {
    return typeof document !== "undefined" && typeof document.createElement === "function";
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    let ok = false;
    try { ok = !!gl.getShaderParameter(shader, gl.COMPILE_STATUS); } catch (e) { ok = false; }
    if (!ok) {
      try { gl.deleteShader(shader); } catch (e2) { /* ignore */ }
      return null;
    }
    return shader;
  }

  function devicePixelRatioSafe() {
    try {
      if (typeof window !== "undefined" && window && Number.isFinite(window.devicePixelRatio)) {
        return clampNum(window.devicePixelRatio, 1, 2);
      }
    } catch (e) { /* ignore */ }
    return 1;
  }

  /* ===================================================================== */
  /* Conveyor3D                                                            */
  /* ===================================================================== */

  function Conveyor3D(opts) {
    if (!(this instanceof Conveyor3D)) return new Conveyor3D(opts);
    opts = opts || {};
    this.container = opts.container || null;
    this.options = opts;
    this._design = opts.design || createDefaultDesignSafe();
    this._computed = computeDesignSafe(this._design);
    this._geometry = buildConveyorGeometry(this._computed, this._geometryOpts());
    this.camera = {
      yaw: num(opts.yaw, 0.72),
      pitch: num(opts.pitch, 0.60),
      distance: num(opts.distance, 6),
      target: { x: 0, y: 0.2, z: 0 }
    };
    this._canvas = null;
    this._gl = null;
    this._program = null;
    this._attribs = null;
    this._uniforms = null;
    this._buffers = null;
    this._indexCount = 0;
    this._indexType = 0;
    this._listeners = [];
    this._drag = null;
    this._resizeObserver = null;
    this._destroyed = false;
    this._dpr = 1;
    this._frameCamera();
    if (Number.isFinite(Number(opts.distance)) && Number(opts.distance) > 0) this.camera.distance = Number(opts.distance);
    this._init();
  }

  Conveyor3D.prototype._geometryOpts = function () {
    const d = (this._design && this._design.defaults) || {};
    const belt = d.belt || {};
    const o = this.options || {};
    return {
      conveyorType: (this._design && this._design.conveyorType) || "roller",
      rollerPitchM: num(o.rollerPitchM, num(d.rollerPitchM, 0.1)),
      legSpacingM: num(o.legSpacingM, 1.5),
      pulleyDiameterM: num(o.pulleyDiameterM, num(belt.pulleyDiameterM, 0.12)),
      beltTopY: o.beltTopY,
      taperDeltaM: o.taperDeltaM,
      panelColors: o.panelColors,
      rollerColor: o.rollerColor,
      railColor: o.railColor,
      legColor: o.legColor,
      sensorColor: o.sensorColor,
      motorColor: o.motorColor,
      beltColor: o.beltColor,
      pulleyColor: o.pulleyColor,
      scannerColor: o.scannerColor
    };
  };

  Conveyor3D.prototype._frameCamera = function () {
    const b = this._geometry && this._geometry.bounds;
    if (b && Number.isFinite(b.minX)) {
      this.camera.target = {
        x: (b.minX + b.maxX) / 2,
        y: (b.minY + b.maxY) / 2,
        z: (b.minZ + b.maxZ) / 2
      };
      /* include the vertical span so spirals are fully framed */
      const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, b.maxY - b.minY,
        Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ), 1);
      this.camera.distance = Math.max(1.2, span * 1.25);
    }
    return this;
  };

  Conveyor3D.prototype._init = function () {
    if (!hasDom() || !hasWebGLSupport()) return this; // Node or no WebGL: CPU-only instance
    let canvas;
    try { canvas = document.createElement("canvas"); } catch (e) { return this; }
    canvas.className = "conv-3d-canvas";
    if (canvas.style) {
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.outline = "none";
      canvas.style.cursor = "grab";
      canvas.style.touchAction = "none";
    }
    let gl = null;
    /* Prefer WebGL2 (native 32-bit indices for very long designs), then WebGL1. Both
       accept the GLSL ES 1.00 shaders used below. */
    try {
      const opts = { antialias: true, alpha: false, depth: true };
      gl = canvas.getContext("webgl2", opts) ||
        canvas.getContext("webgl", opts) ||
        canvas.getContext("experimental-webgl", opts);
    } catch (e) { gl = null; }
    if (!gl) return this;
    if (this.container && typeof this.container.appendChild === "function") this.container.appendChild(canvas);
    else if (document.body && typeof document.body.appendChild === "function") document.body.appendChild(canvas);
    this._canvas = canvas;
    this._gl = gl;
    this._dpr = devicePixelRatioSafe();
    try {
      this._initGL();
      this._bindEvents();
      this._syncSize();
      this.render();
    } catch (e) {
      /* Never throw out of the constructor: degrade to a CPU-only instance and take
         the half-initialised canvas back out of the DOM. */
      try {
        if (canvas.parentNode && typeof canvas.parentNode.removeChild === "function") {
          canvas.parentNode.removeChild(canvas);
        }
      } catch (e2) { /* ignore */ }
      this._gl = null;
      this._canvas = null;
    }
    return this;
  };

  Conveyor3D.prototype._initGL = function () {
    const gl = this._gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) throw new Error("Conveyor3D: shader compile failed");
    const program = gl.createProgram();
    if (!program) throw new Error("Conveyor3D: createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    let linked = false;
    try { linked = !!gl.getProgramParameter(program, gl.LINK_STATUS); } catch (e) { linked = false; }
    if (!linked) throw new Error("Conveyor3D: program link failed");
    try { gl.deleteShader(vs); gl.deleteShader(fs); } catch (e) { /* ignore */ }
    this._program = program;
    this._attribs = {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      color: gl.getAttribLocation(program, "aColor")
    };
    this._uniforms = {
      mvp: gl.getUniformLocation(program, "uMVP"),
      light: gl.getUniformLocation(program, "uLightDir")
    };
    this._buffers = {
      position: gl.createBuffer(),
      normal: gl.createBuffer(),
      color: gl.createBuffer(),
      index: gl.createBuffer()
    };
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._upload();
  };

  Conveyor3D.prototype._upload = function () {
    const gl = this._gl, g = this._geometry, b = this._buffers;
    if (!gl || !g || !b) return;
    const vertexCount = Math.floor(g.positions.length / 3);
    let indexType = gl.UNSIGNED_SHORT;
    let IndexArray = Uint16Array;
    if (vertexCount > 65535) {
      /* WebGL2 supports 32-bit indices natively; WebGL1 needs the OES extension. */
      let isWebGL2 = false;
      try {
        isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      } catch (e) { isWebGL2 = false; }
      if (isWebGL2) {
        IndexArray = Uint32Array;
        indexType = gl.UNSIGNED_INT;
      } else {
        let ext = null;
        try { ext = gl.getExtension ? gl.getExtension("OES_element_index_uint") : null; } catch (e) { ext = null; }
        if (ext) { IndexArray = Uint32Array; indexType = gl.UNSIGNED_INT; }
      }
    }
    const indices = (vertexCount > 65535 && IndexArray === Uint16Array)
      ? g.indices.filter(function (i) { return i <= 65535; })
      : g.indices;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.position);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.positions), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.normal);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.normals), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.colors), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new IndexArray(indices), gl.STATIC_DRAW);
    this._indexCount = indices.length;
    this._indexType = indexType;
  };

  Conveyor3D.prototype._listen = function (target, type, fn, options) {
    if (!target || typeof target.addEventListener !== "function") return;
    try { target.addEventListener(type, fn, options); }
    catch (e) { try { target.addEventListener(type, fn); } catch (e2) { return; } }
    this._listeners.push({ target: target, type: type, fn: fn, options: options });
  };

  Conveyor3D.prototype._bindEvents = function () {
    const canvas = this._canvas;
    if (!canvas) return;
    const doc = canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const h = this._handlers = {
      mousedown: (ev) => this._onMouseDown(ev),
      wheel: (ev) => this._onWheel(ev),
      contextmenu: (ev) => { if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); },
      docmove: (ev) => this._onDocMouseMove(ev),
      docup: (ev) => this._onMouseUp(ev)
    };
    this._listen(canvas, "mousedown", h.mousedown);
    this._listen(canvas, "wheel", h.wheel, { passive: false });
    this._listen(canvas, "contextmenu", h.contextmenu);
    if (doc) {
      this._listen(doc, "mousemove", h.docmove);
      this._listen(doc, "mouseup", h.docup);
    }
    if (this.container && typeof ResizeObserver !== "undefined") {
      try {
        this._resizeObserver = new ResizeObserver(() => { if (!this._destroyed) { this._syncSize(); this.render(); } });
        this._resizeObserver.observe(this.container);
      } catch (e) { this._resizeObserver = null; }
    } else if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
      this._listen(window, "resize", () => { if (!this._destroyed) { this._syncSize(); this.render(); } });
    }
  };

  Conveyor3D.prototype._syncSize = function () {
    const canvas = this._canvas;
    if (!canvas) return false;
    let w = 0, h = 0;
    try {
      if (this.container && typeof this.container.clientWidth === "number") {
        w = this.container.clientWidth; h = this.container.clientHeight;
      }
    } catch (e) { /* ignore */ }
    if (!w || !h) {
      try { w = w || canvas.clientWidth || 0; h = h || canvas.clientHeight || 0; } catch (e) { /* ignore */ }
    }
    w = Math.max(60, Math.round(w || 800));
    h = Math.max(60, Math.round(h || 600));
    const dpr = devicePixelRatioSafe();
    this._dpr = dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      return true;
    }
    return false;
  };

  Conveyor3D.prototype._eye = function () {
    const cam = this.camera;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return {
      x: cam.target.x + cam.distance * cp * Math.sin(cam.yaw),
      y: cam.target.y + cam.distance * sp,
      z: cam.target.z + cam.distance * cp * Math.cos(cam.yaw)
    };
  };

  Conveyor3D.prototype._viewMatrix = function () {
    return mat4LookAt(this._eye(), this.camera.target, { x: 0, y: 1, z: 0 });
  };

  /* Draw one frame. Returns false when there is no WebGL context (Node/headless). */
  Conveyor3D.prototype.render = function () {
    if (this._destroyed || !this._gl || !this._program || !this._canvas) return false;
    const gl = this._gl, canvas = this._canvas;
    this._syncSize();
    const w = canvas.width || 1, h = canvas.height || 1;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.062, 0.078, 0.102, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this._program);
    const proj = mat4Perspective(45 * Math.PI / 180, w / Math.max(1, h), 0.05, 500);
    const view = this._viewMatrix();
    const mvp = mat4Multiply(proj, view);
    if (this._uniforms.mvp) gl.uniformMatrix4fv(this._uniforms.mvp, false, new Float32Array(mvp));
    if (this._uniforms.light) gl.uniform3f(this._uniforms.light, 0.45, 0.85, 0.35);
    const a = this._attribs, b = this._buffers;
    if (a.position >= 0) {
      gl.enableVertexAttribArray(a.position);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.position);
      gl.vertexAttribPointer(a.position, 3, gl.FLOAT, false, 0, 0);
    }
    if (a.normal >= 0) {
      gl.enableVertexAttribArray(a.normal);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.normal);
      gl.vertexAttribPointer(a.normal, 3, gl.FLOAT, false, 0, 0);
    }
    if (a.color >= 0) {
      gl.enableVertexAttribArray(a.color);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
      gl.vertexAttribPointer(a.color, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.index);
    gl.drawElements(gl.TRIANGLES, this._indexCount, this._indexType, 0);
    return true;
  };

  Conveyor3D.prototype._onMouseDown = function (ev) {
    if (this._destroyed || !this._canvas) return;
    const button = ev && ev.button !== undefined ? ev.button : 0;
    const mode = (button === 2 || (ev && ev.shiftKey)) ? "pan" : "orbit";
    this._drag = {
      mode: mode,
      startX: num(ev && ev.clientX, 0),
      startY: num(ev && ev.clientY, 0),
      startYaw: this.camera.yaw,
      startPitch: this.camera.pitch,
      startTarget: {
        x: this.camera.target.x, y: this.camera.target.y, z: this.camera.target.z
      },
      moved: false
    };
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (this._canvas.focus) { try { this._canvas.focus(); } catch (e) { /* ignore */ } }
    if (this._canvas.style) this._canvas.style.cursor = "grabbing";
  };

  /* True when the canvas was detached from the live document by a host re-render. */
  Conveyor3D.prototype._isDetached = function () {
    const canvas = this._canvas;
    if (!canvas) return true;
    if (canvas.isConnected === false) return true;
    if (canvas.isConnected === undefined && canvas.parentNode === null) return true;
    return false;
  };

  Conveyor3D.prototype._onDocMouseMove = function (ev) {
    if (this._destroyed) return;
    if (this._isDetached()) { this.dispose(); return; }
    if (!this._drag || !this._canvas) return;
    const drag = this._drag;
    const dx = num(ev && ev.clientX, 0) - drag.startX;
    const dy = num(ev && ev.clientY, 0) - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    drag.moved = true;
    if (drag.mode === "orbit") {
      this.camera.yaw = drag.startYaw - dx * 0.008;
      this.camera.pitch = clampNum(drag.startPitch - dy * 0.008, -1.5, 1.5);
    } else {
      const view = this._viewMatrix();
      const right = { x: view[0], y: view[4], z: view[8] };
      const upCam = { x: view[1], y: view[5], z: view[9] };
      const k = Math.max(0.0005, this.camera.distance * 0.0016);
      this.camera.target = {
        x: drag.startTarget.x - right.x * dx * k + upCam.x * dy * k,
        y: drag.startTarget.y - right.y * dx * k + upCam.y * dy * k,
        z: drag.startTarget.z - right.z * dx * k + upCam.z * dy * k
      };
    }
    this.render();
  };

  Conveyor3D.prototype._onMouseUp = function () {
    if (this._destroyed) return;
    this._drag = null;
    if (this._canvas && this._canvas.style) this._canvas.style.cursor = "grab";
  };

  Conveyor3D.prototype._onWheel = function (ev) {
    if (this._destroyed || !this._canvas) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    const delta = num(ev && ev.deltaY, 0);
    this.camera.distance = clampNum(this.camera.distance * Math.exp(delta * 0.0012), 0.4, 250);
    this.render();
  };

  /* ---------------------------------------------------------------- API */

  Conveyor3D.prototype.setDesign = function (design, options) {
    if (!design || typeof design !== "object") return this;
    const prevCount = (this._computed && Array.isArray(this._computed.segments)) ? this._computed.segments.length : 0;
    this._design = design;
    this._computed = computeDesignSafe(design);
    this._geometry = buildConveyorGeometry(this._computed, this._geometryOpts());
    const nextCount = (this._computed && Array.isArray(this._computed.segments)) ? this._computed.segments.length : 0;
    const frame = (options && options.frame !== undefined) ? !!options.frame : (nextCount !== prevCount);
    if (frame) this._frameCamera();
    if (this._gl) {
      try { this._upload(); } catch (e) { /* keep the old buffers */ }
      this.render();
    }
    return this;
  };

  Conveyor3D.prototype.getDesign = function () { return this._design; };
  Conveyor3D.prototype.getComputed = function () { return this._computed; };
  Conveyor3D.prototype.getGeometry = function () { return this._geometry; };
  Conveyor3D.prototype.getCamera = function () {
    return {
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      distance: this.camera.distance,
      target: { x: this.camera.target.x, y: this.camera.target.y, z: this.camera.target.z }
    };
  };

  Conveyor3D.prototype.frameCamera = function () {
    this._frameCamera();
    this.render();
    return this;
  };

  Conveyor3D.prototype.resize = function () {
    if (this._syncSize()) this.render();
    else this.render();
    return this;
  };

  Conveyor3D.prototype.dispose = function () {
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
    const gl = this._gl;
    if (gl) {
      try {
        if (this._buffers) {
          for (const k of Object.keys(this._buffers)) {
            if (this._buffers[k]) gl.deleteBuffer(this._buffers[k]);
          }
        }
        if (this._program) gl.deleteProgram(this._program);
      } catch (e) { /* ignore */ }
    }
    this._gl = null;
    this._program = null;
    this._buffers = null;
    if (this._canvas && this._canvas.parentNode && typeof this._canvas.parentNode.removeChild === "function") {
      try { this._canvas.parentNode.removeChild(this._canvas); } catch (e) { /* ignore */ }
    }
    this._canvas = null;
  };

  /* ===================================================================== */
  /* exports                                                               */
  /* ===================================================================== */

  return {
    Conveyor3D: Conveyor3D,
    buildConveyorGeometry: buildConveyorGeometry,
    hasWebGLSupport: hasWebGLSupport,
    mat4Identity: mat4Identity,
    mat4Multiply: mat4Multiply,
    mat4Translate: mat4Translate,
    mat4RotateX: mat4RotateX,
    mat4RotateY: mat4RotateY,
    mat4Scale: mat4Scale,
    mat4Perspective: mat4Perspective,
    mat4LookAt: mat4LookAt,
    mat4Inverse: mat4Inverse,
    mat4TransformPoint: mat4TransformPoint,
    RENDER3D_GEOM: GEOM,
    RENDER3D_PART_COLORS: PART_COLORS
  };
});
