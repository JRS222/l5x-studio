/* L5X Studio - conveyor/hmi.js (Conveyor Design Studio).
   Self-contained HMI graphics generator for a conveyor design:
     generateHmiHtml(design, computed, opts)  -> standalone HTML5 HMI page (inline CSS+JS)
     generateTagListCsv(design, computed)     -> CSV tag list for SCADA / graphics import
     generateGraphicsSpec(design, computed)   -> markdown graphics specification

   The HTML page renders the conveyor top view from the computed geometry on a
   <canvas>: straight / curved / spiral segments, belt-band animation, ZPA zones
   coloured by simulator state (stopped / running / full / jam), zone labels,
   sensor dots, motor squares / belt drives, scan-zone (barcode scanner) markers,
   spiral height badges, merge Y junctions with alternating grant indication and
   pusher / rotary-table / pop-up transfer device symbols with live state colours.
   A small package simulator (Run/Stop/Reset/Sim, click a zone to toggle its sensor,
   jam after 8 s blocked, merge arbitration, device command buttons) drives a TRAY
   TRACKING table (slot, barcode, zone, state) and the device/merge tables. The
   right-hand panel lists the group ZPA tag mapping, tray tracking, belt drives,
   merge junctions and transfer devices. No external resources of any kind are
   referenced (fully offline / file:// safe).
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NODE = typeof module === "object" && !!module.exports;
  const MODEL = NODE ? require("./model.js") : (root.L5XStudio || {});

  const HMI_VERSION = "2.1.0";
  const JAM_SECONDS = 8;

  const STATE_COLORS = {
    stopped: { fill: "#41505f", stroke: "#6b7c8d", label: "Stopped" },
    running: { fill: "#1f7a4d", stroke: "#3fd68a", label: "Running" },
    full: { fill: "#a8781f", stroke: "#f0c24b", label: "Full" },
    jam: { fill: "#9e2f2a", stroke: "#ff6b60", label: "Jam" }
  };

  /* ------------------------------------------------------------------ helpers */

  function escHtml(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function csvCell(value) {
    const s = String(value === undefined || value === null ? "" : value);
    if (/[",\r\n]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }
  function csvRow(cells) { return cells.map(csvCell).join(","); }
  function fixed(n, d) {
    const v = Number(n);
    if (!isFinite(v)) return "";
    return v.toFixed(d === undefined ? 3 : d);
  }
  function round(v, d) { const p = Math.pow(10, d || 0); return Math.round(Number(v) * p) / p; }
  function computeIfMissing(design, computed) {
    if (computed && computed.zones && computed.zones.length) return computed;
    if (!MODEL.computeDesign) throw new Error("Conveyor model not loaded (L5XStudio.computeDesign missing)");
    return MODEL.computeDesign(design);
  }
  function zoneLabel(zone, segmentName) {
    return (segmentName || zone.segmentName || "SEG") + "_Z" + (zone.zoneInSegment1Based || 1);
  }
  function blockName(zone) { return zone.blockName || "ZPA01"; }
  /* Bit within the group's 1799ER input/output word: zone-within-group - 1
     (input bits 0..7 = the 8 zone sensors, output bits 0..7 = the run commands). */
  function zoneIoBit(zone) {
    const k = zone.zoneInGroup1Based || zone.zoneInSegment1Based || 1;
    return Math.max(0, Math.min(9, k - 1));
  }
  function zoneInputAddress(zone) { return blockName(zone) + ":I.Data." + zoneIoBit(zone); }
  function zoneOutputAddress(zone) { return blockName(zone) + ":O.Data." + zoneIoBit(zone); }
  /* One NETS[1].ZPA[g] instance per ZPA group (up to 8 zones). */
  function zonePlcPath(zone) { return "NETS[1].ZPA[" + (zone.groupIndex1Based || 1) + "]"; }
  function zoneStatusPath(zone) {
    return zonePlcPath(zone) + ".ZONE_STATUS[" + (zone.zoneInGroup1Based || 1) + "]";
  }
  function designCounts(computed) {
    const totals = computed.totals || {};
    return {
      segments: totals.segments || (computed.segments || []).length,
      zones: totals.zones || (computed.zones || []).length,
      groups: totals.groups || (computed.groups || []).length,
      blocks: totals.blocks || (computed.blocks || []).length,
      lengthM: totals.conveyorLengthM || 0,
      curvedZones: totals.curvedZones || 0,
      spiralRiseM: totals.spiralRiseM || 0,
      beltSegments: totals.beltSegments || 0,
      scanZones: totals.scanZones || 0,
      trackingEnabled: !!totals.trackingEnabled
    };
  }
  function scanTagNames(scanZone) {
    let base = String(scanZone.tagName || (scanZone.name || "SCAN1") + "_BARCODE").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!/_BARCODE$/.test(base)) base += "_BARCODE";
    return { barcode: base, goodRead: base.replace(/_BARCODE$/, "_GOOD_READ") };
  }

  /* --------------------------------------------------------- HMI page data */

  function buildHmiData(design, computed, opts) {
    opts = opts || {};
    const counts = designCounts(computed);
    const bounds = computed.bounds || { minX: 0, minY: 0, width: 1, height: 1 };
    const segByName = {};
    (computed.segments || []).forEach(function (seg) { segByName[seg.name] = seg; });
    const zones = [];
    (computed.segments || []).forEach(function (seg) {
      seg.zones.forEach(function (zone) {
        const spiral = seg.spiral || null;
        zones.push({
          index: zone.index1Based,
          label: zoneLabel(zone, seg.name),
          segment: seg.name,
          segmentKind: seg.kind,
          zoneInSegment: zone.zoneInSegment1Based,
          group: zone.groupIndex1Based || 1,
          zoneInGroup: zone.zoneInGroup1Based || 1,
          block: blockName(zone),
          ip: zone.ip || "",
          x: zone.x, y: zone.y,
          angleDeg: Math.round((zone.angleDeg || 0) * 1000) / 1000,
          lengthM: zone.lengthM,
          widthM: zone.widthM,
          curved: !!zone.curved,
          conveyorType: zone.conveyorType || seg.conveyorType || "roller",
          radiusM: zone.radiusM || null,
          taperStandardId: zone.taper && zone.taper.standardId ? zone.taper.standardId : null,
          spiral: spiral ? {
            direction: spiral.direction, pitchM: spiral.pitchM, heightM: spiral.heightM,
            slopeDeg: spiral.slopeDeg, turns: spiral.turns, z: round(zone.z || 0, 2)
          } : null,
          sensorName: zone.sensorName || (seg.name + "_Z" + zone.zoneInSegment1Based + "_SENSOR"),
          motorName: zone.motorName || (seg.name + "_Z" + zone.zoneInSegment1Based + "_RUN"),
          inputAddress: zoneInputAddress(zone),
          outputAddress: zoneOutputAddress(zone),
          plcPath: zonePlcPath(zone),
          statusPath: zoneStatusPath(zone),
          driveLabel: (zone.conveyorType || seg.conveyorType) === "belt" ? sanitizeDriveName(seg.name) : null
        });
      });
    });
    const segments = (computed.segments || []).map(function (seg) {
      return {
        name: seg.name, kind: seg.kind, conveyorType: seg.conveyorType,
        radiusM: seg.radiusM || null,
        curveDeg: seg.curveDeg || 0,
        taperStandardId: seg.taper && seg.taper.standardId ? seg.taper.standardId : null,
        taperDeltaM: seg.taper && seg.taper.deltaM ? seg.taper.deltaM : null,
        spiral: seg.spiral ? {
          direction: seg.spiral.direction, pitchM: seg.spiral.pitchM, heightM: seg.spiral.heightM,
          slopeDeg: seg.spiral.slopeDeg, turns: seg.spiral.turns
        } : null,
        zoneCount: seg.zones.length,
        lengthM: seg.lengthM,
        zStart: seg.zStart, zEnd: seg.zEnd
      };
    });
    const scanZones = (computed.scannedZones || []).map(function (sz) {
      const names = scanTagNames(sz);
      return {
        name: sz.name, type: sz.type || "barcode", side: sz.side || "right",
        zoneIndex: sz.zoneIndex1Based || 0,
        blockName: sz.blockName || "",
        x: sz.x, y: sz.y, angleDeg: round(sz.angleDeg || 0, 2),
        barcodeTag: names.barcode, goodReadTag: names.goodRead
      };
    });
    let tracking = null;
    if (computed.tracking && computed.tracking.enabled) {
      tracking = {
        enabled: true,
        maxTrays: computed.tracking.maxTrays,
        barcodeLen: computed.tracking.barcodeLen,
        zoneCount: computed.tracking.zones ? computed.tracking.zones.length : counts.zones,
        scanZones: scanZones.length,
        tagPrefix: computed.tracking.tagPrefix || "TRACK",
        scanZoneIndexes: scanZones.map(function (s) { return s.zoneIndex; })
      };
    }
    const drives = (computed.segments || []).filter(function (s) { return s.conveyorType === "belt"; }).map(function (s) {
      const S = sanitizeDriveName(s.name);
      return {
        segment: s.name, runCmdTag: S + "_RUN_CMD", runTag: S + "_DRIVE_RUN",
        faultTag: S + "_DRIVE_FAULT", statusTag: S + "_DRIVE_STATUS"
      };
    });
    const merges = (computed.merges || []).map(function (mg, i) {
      const P = sanitizeSymbol(mg.name, "MERGE" + (i + 1));
      return {
        name: mg.name, priority: mg.priority || "alternate",
        x: mg.x, y: mg.y, angleDeg: round(mg.angleDeg || 0, 2), gapM: mg.gapM,
        mergeZone: mg.mergeZoneIndex1Based, mainZone: mg.upstreamMainZone, spurZone: mg.spurZoneIndex1Based,
        mergeBlock: mg.mergeBlockName, spurBlock: mg.spurBlockName,
        mainGrantTag: "MERGE_" + P + "_MAIN_GRANT", spurGrantTag: "MERGE_" + P + "_SPUR_GRANT"
      };
    });
    const transfers = (computed.transfers || []).map(function (tf, i) {
      const block = tf.ioBlock;
      const S = sanitizeSymbol(tf.name, "XFER" + (i + 1));
      const inputMap = MODEL.transferInputMap ? MODEL.transferInputMap(tf.type) : [];
      const outputMap = MODEL.transferOutputMap ? MODEL.transferOutputMap(tf.type) : [];
      const alias = function (map) {
        return map.map(function (b) { return { name: S + "_" + b.name, bit: b.bit, description: b.description }; });
      };
      return {
        name: tf.name, type: tf.type, typeLabel: tf.typeLabel,
        x: tf.x, y: tf.y, angleDeg: round(tf.angleDeg || 0, 2),
        ioBlock: block, ip: tf.ip, side: tf.side, bidirectional: !!tf.bidirectional,
        directions: tf.directions || [], zoneIndex: tf.zoneIndex1Based || 0,
        cmdTags: tf.type === "popup_transfer" ? ["XFER_CMD_" + S + "_LEFT", "XFER_CMD_" + S + "_RIGHT"] : ["XFER_CMD_" + S],
        statusTag: block + "_STATUS", faultTag: block + "_FAULT", stateTag: block + "_STATE",
        posTag: tf.type === "rotary_table" ? "XFER_POS_" + S : null,
        destTag: tf.type === "rotary_table" ? "XFER_DEST_" + S : null,
        inputs: alias(inputMap), outputs: alias(outputMap)
      };
    });
    return {
      version: HMI_VERSION,
      designName: design.name || "CONVEYOR",
      controllerName: (design.controller && design.controller.name) || "PLC",
      processorType: (design.controller && design.controller.processorType) || "",
      conveyorType: computed.conveyorType || design.conveyorType || "roller",
      segments: counts.segments,
      zones: counts.zones,
      groups: counts.groups,
      blocks: counts.blocks,
      lengthM: counts.lengthM,
      curvedZones: counts.curvedZones,
      spiralRiseM: counts.spiralRiseM,
      beltSegments: counts.beltSegments,
      jamSeconds: JAM_SECONDS,
      bounds: { minX: bounds.minX, minY: bounds.minY, width: bounds.width, height: bounds.height },
      zoneStates: zones,
      segmentsInfo: segments,
      scanZones: scanZones,
      tracking: tracking,
      drives: drives,
      merges: merges,
      transfers: transfers,
      palette: {
        stopped: STATE_COLORS.stopped.fill, running: STATE_COLORS.running.fill,
        full: STATE_COLORS.full.fill, jam: STATE_COLORS.jam.fill
      }
    };
  }
  function sanitizeDriveName(name) {
    if (MODEL.sanitizeName) return MODEL.sanitizeName(name, "BELT");
    return String(name || "BELT").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  }
  function sanitizeSymbol(name, fallback) {
    if (MODEL.sanitizeName) return MODEL.sanitizeName(name, fallback);
    return String(name || fallback || "XFER").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  }

  function jsonForScript(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  /* ------------------------------------------------------------ HMI page */

  function regionStyle() {
    return [
      "html,body{margin:0;padding:0;height:100%;background:#10161c;color:#d7e2ec;",
      "font-family:Consolas,'Segoe UI',Roboto,Arial,sans-serif;}",
      "*{box-sizing:border-box;}",
      ".hmi{display:flex;flex-direction:column;height:100%;min-height:100vh;}",
      ".hmi-header{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;padding:12px 18px;",
      "background:linear-gradient(90deg,#16212b,#1d2c39);border-bottom:2px solid #2b5169;}",
      ".hmi-header h1{font-size:17px;margin:0;letter-spacing:.06em;color:#8fd0ff;font-weight:600;}",
      ".hmi-header .meta{font-size:12px;color:#93a7b8;}",
      ".hmi-header .meta b{color:#dfe9f2;font-weight:600;}",
      ".hmi-main{display:flex;flex:1;min-height:0;gap:12px;padding:12px;}",
      ".hmi-stage{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;}",
      ".hmi-canvas-wrap{position:relative;flex:1;min-height:260px;background:#0b1116;",
      "border:1px solid #27404f;border-radius:6px;overflow:hidden;}",
      "#hmi-canvas{display:block;width:100%;height:100%;cursor:crosshair;}",
      ".hmi-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
      ".hmi-btn{background:#1d2c39;color:#cfe6f7;border:1px solid #35637f;border-radius:4px;",
      "padding:6px 14px;font-size:13px;font-family:inherit;cursor:pointer;letter-spacing:.04em;}",
      ".hmi-btn:hover{background:#26404f;border-color:#4d8db1;}",
      ".hmi-btn.run{border-color:#2f7d55;color:#9cf0c2;}",
      ".hmi-btn.stop{border-color:#8a4a3a;color:#ffc3ad;}",
      ".hmi-btn.reset{border-color:#6d6a3a;color:#f0e6a8;}",
      ".hmi-btn.sim{background:#233448;}",
      ".hmi-btn.active{background:#2a5c78;border-color:#67b7e0;color:#fff;}",
      ".hmi-status{margin-left:auto;font-size:12px;color:#9fb6c7;}",
      ".hmi-status b{color:#ffd166;font-weight:600;}",
      ".hmi-legend{display:flex;gap:16px;font-size:12px;color:#a9bccb;flex-wrap:wrap;padding:2px 2px;}",
      ".hmi-legend span{display:inline-flex;align-items:center;gap:6px;}",
      ".hmi-dot{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid rgba(255,255,255,.25);}",
      ".hmi-panel{width:440px;max-width:46vw;display:flex;flex-direction:column;min-height:0;",
      "background:#121b22;border:1px solid #27404f;border-radius:6px;overflow:hidden;}",
      ".hmi-panel h2{margin:0;padding:8px 12px;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;",
      "color:#7fb6d6;background:#16232e;border-top:1px solid #223a49;border-bottom:1px solid #223a49;}",
      ".hmi-panel h2:first-child{border-top:0;}",
      ".hmi-table-host{flex:1;overflow:auto;min-height:110px;}",
      ".hmi-table-host.short{flex:0 0 auto;max-height:230px;}",
      "table{border-collapse:collapse;width:100%;font-size:11.5px;}",
      "th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #1d2b36;white-space:nowrap;}",
      "th{position:sticky;top:0;background:#17252f;color:#8fb3c9;font-weight:600;font-size:10.5px;",
      "letter-spacing:.06em;text-transform:uppercase;z-index:1;}",
      "td.mono{font-family:Consolas,monospace;color:#b9d7ea;}",
      "td.zone{color:#ffd166;font-weight:600;}",
      "td.state-stopped{color:#93a7b8;} td.state-running{color:#3fd68a;}",
      "td.state-full{color:#f0c24b;} td.state-jam{color:#ff6b60;font-weight:700;}",
      ".hmi-notes{padding:7px 12px;font-size:10.5px;color:#7d94a5;border-top:1px solid #1d2b36;line-height:1.45;}",
      ".hmi-notes code{color:#9fd0ef;}",
      ".hmi-btn.dev{padding:1px 7px;font-size:10px;margin:0 2px;border-radius:3px;}",
      "td.state-idle{color:#93a7b8;} td.state-active{color:#f0c24b;font-weight:600;}",
      "td.state-fault{color:#ff6b60;font-weight:700;}",
      "@media (max-width:980px){.hmi-main{flex-direction:column;}.hmi-panel{width:auto;max-width:none;}}"
    ].join("");
  }

  function generateHmiHtml(design, computed, opts) {
    opts = opts || {};
    const comp = computeIfMissing(design, computed);
    const data = buildHmiData(design, comp, opts);
    const title = opts.title || (data.designName + " HMI");

    const zoneRows = data.zoneStates.map(function (z) {
      return "          <tr data-zone=\"" + z.index + "\">" +
        "<td class=\"zone\">" + escHtml(z.label) + "</td>" +
        "<td class=\"mono\">" + escHtml(z.block) + "</td>" +
        "<td class=\"mono\">" + escHtml(z.plcPath) + "</td>" +
        "<td class=\"mono\">" + escHtml(z.inputAddress) + "</td>" +
        "<td class=\"mono\">" + escHtml(z.outputAddress) + "</td>" +
        "<td class=\"mono\">" + escHtml(z.ip) + "</td></tr>";
    }).join("\n");

    let legend = Object.keys(STATE_COLORS).map(function (k) {
      const c = STATE_COLORS[k];
      return "<span><i class=\"hmi-dot\" style=\"background:" + c.fill + ";border-color:" + c.stroke + "\"></i>" +
        escHtml(c.label) + "</span>";
    }).join("");
    legend += "<span><i class=\"hmi-dot\" style=\"background:#101a22;border-color:#7fd4ff\"></i>Scanner</span>" +
      "<span><i class=\"hmi-dot\" style=\"background:#2b3a47;border-color:#8fd0ff\"></i>Belt</span>" +
      "<span><i class=\"hmi-dot\" style=\"background:#1f7a4d;border-color:#3fd68a\"></i>Merge grant (main)</span>" +
      "<span><i class=\"hmi-dot\" style=\"background:#1d5c8a;border-color:#7fd4ff\"></i>Merge grant (spur)</span>" +
      "<span><i class=\"hmi-dot\" style=\"background:#8a6a1f;border-color:#f0c24b\"></i>Device active</span>";

    const hasTracking = !!data.tracking;
    const trackingPanel = hasTracking ? [
      "      <h2>Tray tracking</h2>",
      "      <div class=\"hmi-table-host short\"><table id=\"track-table\">",
      "        <thead><tr><th>Slot</th><th>Barcode</th><th>Zone</th><th>State</th></tr></thead>",
      "        <tbody id=\"track-body\"></tbody></table></div>"
    ] : [];
    const driveRows = data.drives.map(function (d) {
      return "        <tr><td class=\"mono\">" + escHtml(d.segment) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.runTag) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.faultTag) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.statusTag) + "</td></tr>";
    }).join("\n");
    const drivePanel = data.drives.length ? [
      "      <h2>Belt drives</h2>",
      "      <div class=\"hmi-table-host short\"><table id=\"drive-table\">",
      "        <thead><tr><th>Segment</th><th>Run</th><th>Fault</th><th>Status</th></tr></thead>",
      "        <tbody>",
      driveRows,
      "        </tbody></table></div>"
    ] : [];
    const deviceRows = data.transfers.map(function (d, i) {
      const commands = d.cmdTags.map(function (tag, c) {
        const label = d.type === "pusher" ? (c === 0 ? "Divert" : "Cmd") : d.type === "rotary_table" ? "Rotate" : (c === 0 ? "Left" : "Right");
        return "<button class=\"hmi-btn dev\" type=\"button\" id=\"dev-" + i + "-" + c + "\" title=\"" + escHtml(tag) + "\">" + label + "</button>";
      }).join(" ");
      return "        <tr><td class=\"mono\">" + escHtml(d.name) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.typeLabel) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.ioBlock) + "</td>" +
        "<td class=\"mono\">" + escHtml(d.ip) + "</td>" +
        "<td class=\"mono\" id=\"dev-state-" + i + "\">idle</td>" +
        "<td class=\"mono\" id=\"dev-fault-" + i + "\">0</td>" +
        "<td>" + commands + "</td></tr>";
    }).join("\n");
    const devicePanel = data.transfers.length ? [
      "      <h2>Transfer devices</h2>",
      "      <div class=\"hmi-table-host short\"><table id=\"device-table\">",
      "        <thead><tr><th>Name</th><th>Type</th><th>Block</th><th>IP</th><th>State</th><th>Fault</th><th>Command</th></tr></thead>",
      "        <tbody>",
      deviceRows,
      "        </tbody></table></div>"
    ] : [];
    const mergeRows = data.merges.map(function (m) {
      return "        <tr><td class=\"mono\">" + escHtml(m.name) + "</td>" +
        "<td class=\"mono\">" + escHtml(m.priority) + "</td>" +
        "<td class=\"mono\">" + (m.mergeZone || "") + "</td>" +
        "<td class=\"mono\">" + (m.mainZone || "") + "</td>" +
        "<td class=\"mono\">" + (m.spurZone || "") + "</td>" +
        "<td class=\"mono\" id=\"merge-grant-" + escHtml(m.name) + "\">-</td></tr>";
    }).join("\n");
    const mergePanel = data.merges.length ? [
      "      <h2>Merge junctions</h2>",
      "      <div class=\"hmi-table-host short\"><table id=\"merge-table\">",
      "        <thead><tr><th>Merge</th><th>Priority</th><th>Merge zone</th><th>Main upstream</th><th>Spur zone</th><th>Grant</th></tr></thead>",
      "        <tbody>",
      mergeRows,
      "        </tbody></table></div>"
    ] : [];

    const metaExtra = (data.conveyorType === "belt" ? "belt conveyor" : "roller conveyor") +
      (data.curvedZones ? " &middot; <b>" + data.curvedZones + "</b> curved zones" : "") +
      (data.spiralRiseM ? " &middot; spiral rise <b>" + fixed(data.spiralRiseM, 2) + " m</b>" : "") +
      (data.scanZones.length ? " &middot; <b>" + data.scanZones.length + "</b> scan zone(s)" : "") +
      (data.merges.length ? " &middot; <b>" + data.merges.length + "</b> merge(s)" : "") +
      (data.transfers.length ? " &middot; <b>" + data.transfers.length + "</b> transfer device(s)" : "") +
      (hasTracking ? " &middot; tracking <b>" + data.tracking.maxTrays + " trays</b>" : "");

    const html = [];
    html.push("<!DOCTYPE html>");
    html.push("<html lang=\"en\">");
    html.push("<head>");
    html.push("<meta charset=\"utf-8\">");
    html.push("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    html.push("<title>" + escHtml(title) + "</title>");
    html.push("<style>" + regionStyle() + "</style>");
    html.push("</head>");
    html.push("<body>");
    html.push("<div class=\"hmi\">");
    html.push("  <header class=\"hmi-header\">");
    html.push("    <h1>" + escHtml(data.designName) + " &mdash; CONVEYOR HMI</h1>");
    html.push("    <div class=\"meta\">PLC <b>" + escHtml(data.controllerName) + "</b>" +
      (data.processorType ? " (" + escHtml(data.processorType) + ")" : "") +
      " &middot; <b>" + data.segments + "</b> segments &middot; <b>" + data.zones + "</b> zones &middot; " +
      "<b>" + data.groups + "</b> ZPA groups &middot; <b>" + data.blocks + "</b> I/O blocks &middot; <b>" +
      fixed(data.lengthM, 1) + " m</b> &middot; " + metaExtra + "</div>");
    html.push("  </header>");
    html.push("  <main class=\"hmi-main\">");
    html.push("    <section class=\"hmi-stage\">");
    html.push("      <div class=\"hmi-canvas-wrap\"><canvas id=\"hmi-canvas\" width=\"1100\" height=\"460\"></canvas></div>");
    html.push("      <div class=\"hmi-controls\">");
    html.push("        <button class=\"hmi-btn run\" id=\"btn-run\" type=\"button\">Run</button>");
    html.push("        <button class=\"hmi-btn stop\" id=\"btn-stop\" type=\"button\">Stop</button>");
    html.push("        <button class=\"hmi-btn reset\" id=\"btn-reset\" type=\"button\">Reset</button>");
    html.push("        <button class=\"hmi-btn sim\" id=\"btn-sim\" type=\"button\">Sim</button>");
    html.push("        <span class=\"hmi-status\" id=\"sim-status\">conveyor <b>stopped</b> &middot; click a zone to toggle its sensor</span>");
    html.push("      </div>");
    html.push("      <div class=\"hmi-legend\">" + legend + "</div>");
    html.push("    </section>");
    html.push("    <aside class=\"hmi-panel\">");
    html.push("      <h2>Zone tag mapping</h2>");
    html.push("      <div class=\"hmi-table-host\"><table id=\"tag-map\">");
    html.push("        <thead><tr><th>Zone</th><th>Block</th><th>PLC tag path</th><th>Input</th><th>Output</th><th>IP</th></tr></thead>");
    html.push("        <tbody>");
    html.push(zoneRows);
    html.push("        </tbody></table></div>");
    html.push(trackingPanel.join("\n"));
    html.push(drivePanel.join("\n"));
    html.push(mergePanel.join("\n"));
    html.push(devicePanel.join("\n"));
    html.push("      <div class=\"hmi-notes\">");
    html.push("        Simulator only &mdash; values are not read from the PLC. " +
      "One <code>NETS[1].ZPA[g]</code> group covers up to 8 zones; zone k of the group uses input/output bit k-1 " +
      "of the group's 1799ER word and <code>ZONE_STATUS[k]</code> (0 normal, 1 full, 2 jam, 20 jam acknowledged). " +
      "Scanner tags <code>&lt;SCAN&gt;_BARCODE</code>/<code>&lt;SCAN&gt;_GOOD_READ</code> are populated by the external " +
      "scanner MSG/CIP interface. Jam is raised after " + data.jamSeconds + " s blocked.");
    html.push("      </div>");
    html.push("    </aside>");
    html.push("  </main>");
    html.push("</div>");
    html.push("<script>");
    html.push("var HMI_DATA = " + jsonForScript(data) + ";");
    html.push("(function () {");
    html.push("  \"use strict\";");
    html.push("  var DATA = HMI_DATA;");
    html.push("  var ZONES = DATA.zoneStates;");
    html.push("  var JAM_MS = DATA.jamSeconds * 1000;");
    html.push("  var COLORS = DATA.palette;");
    html.push("  var STATE_NAMES = [\"stopped\", \"running\", \"full\", \"jam\"];");
    html.push("  var SEGMENTS = {};");
    html.push("  DATA.segmentsInfo.forEach(function (s) { SEGMENTS[s.name] = s; });");
    html.push("  var SCAN_BY_ZONE = {};");
    html.push("  DATA.scanZones.forEach(function (s) { if (s.zoneIndex) SCAN_BY_ZONE[s.zoneIndex] = s; });");
    html.push("  var canvas = document.getElementById(\"hmi-canvas\");");
    html.push("  var ctx = canvas.getContext(\"2d\");");
    html.push("  var statusEl = document.getElementById(\"sim-status\");");
    html.push("  var simBtn = document.getElementById(\"btn-sim\");");
    html.push("  var trackBody = document.getElementById(\"track-body\");");
    html.push("  var TRACK = DATA.tracking || null;");
    html.push("  var sim = { running: false, auto: false, hover: -1, now: 0, nextId: 1,");
    html.push("              zones: ZONES.map(function () { return { pkg: null, state: 0, blockedMs: 0 }; }),");
    html.push("              merges: DATA.merges.map(function () { return { mainGrant: false, spurGrant: false, lastMain: false, blockedMs: 0, grant: \"\" }; }),");
    html.push("              devices: DATA.transfers.map(function () { return { state: 0, fault: 0, seqStart: 0, seq: 0 }; }),");
    html.push("              trays: {}, spawnAt: 0, lastTick: 0 };");
    html.push("  var view = { scale: 1, ox: 0, oy: 0, screen: [], zoneScreen: {}, transferScreen: [] };");
    html.push("  function fitView() {");
    html.push("    var b = DATA.bounds;");
    html.push("    var pad = 30;");
    html.push("    var sx = (canvas.width - pad * 2) / Math.max(0.001, b.width);");
    html.push("    var sy = (canvas.height - pad * 2) / Math.max(0.001, b.height);");
    html.push("    view.scale = Math.min(sx, sy);");
    html.push("    view.ox = pad + (canvas.width - pad * 2 - b.width * view.scale) / 2 - b.minX * view.scale;");
    html.push("    view.oy = pad + (canvas.height - pad * 2 - b.height * view.scale) / 2 - b.minY * view.scale;");
    html.push("  }");
    html.push("  function worldToScreen(x, y) { return { x: view.ox + x * view.scale, y: view.oy + y * view.scale }; }");
    html.push("  function stateName(z) { return STATE_NAMES[sim.zones[z].state] || \"stopped\"; }");
    html.push("  function spawnPackage(zoneIndex) {");
    html.push("    var pkg = { id: sim.nextId++, barcode: null, zone: zoneIndex + 1 };");
    html.push("    sim.zones[zoneIndex].pkg = pkg;");
    html.push("    sim.zones[zoneIndex].state = 2;");
    html.push("    return pkg;");
    html.push("  }");
    html.push("  function traySlot(pkg) { return TRACK ? (pkg.id % TRACK.maxTrays) : 0; }");
    html.push("  function upsertTray(pkg) {");
    html.push("    if (!TRACK || !pkg.barcode) return;");
    html.push("    sim.trays[traySlot(pkg)] = { slot: traySlot(pkg), barcode: pkg.barcode, zone: pkg.zone, id: pkg.id };");
    html.push("  }");
    html.push("  function renderTracking() {");
    html.push("    if (!trackBody || !TRACK) return;");
    html.push("    var rows = [];");
    html.push("    for (var s = 0; s < TRACK.maxTrays; s++) {");
    html.push("      var t = sim.trays[s];");
    html.push("      var st = t ? (sim.zones[Math.max(0, Math.min(sim.zones.length - 1, t.zone - 1))].state) : 0;");
    html.push("      rows.push(\"<tr><td class=\\\"mono\\\">\" + s + \"</td><td class=\\\"mono\\\">\" +");
    html.push("        (t ? t.barcode : \"&mdash;\") + \"</td><td class=\\\"zone\\\">\" +");
    html.push("        (t ? t.zone : \"\") + \"</td><td class=\\\"state-\" + STATE_NAMES[st] + \"\\\">\" +");
    html.push("        (t ? STATE_NAMES[st] : \"empty\") + \"</td></tr>\");");
    html.push("    }");
    html.push("    trackBody.innerHTML = rows.join(\"\");");
    html.push("  }");
    html.push("  function updateStatus() {");
    html.push("    var jams = sim.zones.filter(function (z) { return z.state === 3; }).length;");
    html.push("    var trays = 0; for (var k in sim.trays) if (sim.trays.hasOwnProperty(k)) trays++;");
    html.push("    var activeDev = sim.devices.filter(function (d) { return d.state !== 0; }).length;");
    html.push("    var grants = DATA.merges.map(function (m, mi) { return sim.merges[mi].grant || \"-\"; }).filter(function (g) { return g !== \"-\"; }).length;");
    html.push("    statusEl.innerHTML = (sim.running ? \"running\" : \"stopped\") +");
    html.push("      (sim.auto ? \" \\u00b7 sim auto\" : \"\") +");
    html.push("      (jams ? \" \\u00b7 <b>\" + jams + \" jam(s)</b>\" : \"\") +");
    html.push("      (TRACK ? \" \\u00b7 \" + trays + \" tracked tray(s)\" : \"\") +");
    html.push("      (DATA.merges.length ? \" \\u00b7 \" + grants + \" merge grant(s)\" : \"\") +");
    html.push("      (DATA.transfers.length ? \" \\u00b7 \" + activeDev + \" device(s) active\" : \"\");");
    html.push("  }");
    html.push("  function drawBelt(zone, s, w) {");
    html.push("    ctx.fillStyle = \"#26333d\";");
    html.push("    ctx.fillRect(-s / 2, -w / 2, s, w);");
    html.push("    var spacing = 14;");
    html.push("    var off = (sim.now * 0.014) % spacing;");
    html.push("    ctx.save();");
    html.push("    ctx.beginPath();");
    html.push("    ctx.rect(-s / 2, -w / 2, s, w);");
    html.push("    ctx.clip();");
    html.push("    ctx.strokeStyle = \"rgba(143,208,255,0.45)\";");
    html.push("    ctx.lineWidth = 2;");
    html.push("    for (var x = -s / 2 - w + off; x < s / 2 + w; x += spacing) {");
    html.push("      ctx.beginPath(); ctx.moveTo(x, -w / 2); ctx.lineTo(x + w, w / 2); ctx.stroke();");
    html.push("    }");
    html.push("    ctx.restore();");
    html.push("    ctx.strokeStyle = \"rgba(143,208,255,0.7)\";");
    html.push("    ctx.strokeRect(-s / 2, -w / 2, s, w);");
    html.push("  }");
    /* --- merges / transfer devices --- */
    html.push("  var DEVICE_STATE_NAMES = { pusher: [\"idle\", \"extending\", \"extended\", \"retracting\"],");
    html.push("    rotary_table: [\"idle\", \"rotating\", \"at position\", \"returning\"],");
    html.push("    popup_transfer: [\"idle\", \"raising\", \"transferring\", \"lowering\", \"fault\"] };");
    html.push("  function deviceStateName(d, i) { var names = DEVICE_STATE_NAMES[d.type] || [\"idle\", \"active\"]; return names[sim.devices[i].state] || \"idle\"; }");
    html.push("  function deviceTimings(d) { if (d.type === \"pusher\") return [500, 1500, 500]; if (d.type === \"rotary_table\") return [1100, 1400, 500]; return [600, 1500, 600]; }");
    html.push("  function renderDevices() {");
    html.push("    for (var i = 0; i < DATA.transfers.length; i++) {");
    html.push("      var el = document.getElementById(\"dev-state-\" + i);");
    html.push("      if (el) el.innerHTML = deviceStateName(DATA.transfers[i], i);");
    html.push("      var fe = document.getElementById(\"dev-fault-\" + i);");
    html.push("      if (fe) fe.innerHTML = sim.devices[i].fault ? \"1\" : \"0\";");
    html.push("    }");
    html.push("    for (var m = 0; m < DATA.merges.length; m++) {");
    html.push("      var me = document.getElementById(\"merge-grant-\" + DATA.merges[m].name);");
    html.push("      if (me) me.innerHTML = sim.merges[m].grant || \"-\";");
    html.push("    }");
    html.push("  }");
    html.push("  function triggerDevice(index) {");
    html.push("    var d = DATA.transfers[index]; if (!d) return;");
    html.push("    var dev = sim.devices[index]; if (dev.state !== 0) return;");
    html.push("    dev.state = 1; dev.seqStart = Date.now();");
    html.push("    for (var c = 0; c < 4; c++) { var btn = document.getElementById(\"dev-\" + index + \"-\" + c); if (btn) btn.className = \"hmi-btn dev active\"; }");
    html.push("  }");
    html.push("  function drawMergeJunctions() {");
    html.push("    for (var i = 0; i < DATA.merges.length; i++) {");
    html.push("      var m = DATA.merges[i]; var ms = sim.merges[i];");
    html.push("      var mz = view.zoneScreen[m.mergeZone], mn = view.zoneScreen[m.mainZone], sp = view.zoneScreen[m.spurZone];");
    html.push("      if (!mz) continue;");
    html.push("      if (mn) { ctx.strokeStyle = ms.mainGrant ? \"#3fd68a\" : \"rgba(90,120,140,0.7)\"; ctx.lineWidth = ms.mainGrant ? 3 : 2; ctx.beginPath(); ctx.moveTo(mn.x, mn.y); ctx.lineTo(mz.x, mz.y); ctx.stroke(); }");
    html.push("      if (sp) { ctx.strokeStyle = ms.spurGrant ? \"#7fd4ff\" : \"rgba(90,120,140,0.55)\"; ctx.lineWidth = ms.spurGrant ? 3 : 2; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(mz.x, mz.y); ctx.stroke(); ctx.setLineDash([]); }");
    html.push("      var c = worldToScreen(m.x, m.y);");
    html.push("      ctx.fillStyle = \"#101a22\"; ctx.strokeStyle = ms.mainGrant ? \"#3fd68a\" : ms.spurGrant ? \"#7fd4ff\" : \"#8fa7b8\"; ctx.lineWidth = 1.5;");
    html.push("      ctx.beginPath(); ctx.arc(c.x, c.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();");
    html.push("      ctx.fillStyle = \"#cfe6f7\"; ctx.font = \"10px Consolas, monospace\"; ctx.textAlign = \"center\";");
    html.push("      ctx.fillText(m.name, c.x, c.y - 12);");
    html.push("      ctx.fillStyle = \"#f0c24b\"; ctx.font = \"9px Consolas, monospace\";");
    html.push("      ctx.fillText(\"ALT \" + ms.grant, c.x, c.y + 19);");
    html.push("    }");
    html.push("  }");
    html.push("  function drawTransfers() {");
    html.push("    view.transferScreen = [];");
    html.push("    for (var i = 0; i < DATA.transfers.length; i++) {");
    html.push("      var d = DATA.transfers[i]; var dev = sim.devices[i];");
    html.push("      var p = worldToScreen(d.x, d.y);");
    html.push("      var active = dev.state !== 0; var fault = dev.fault;");
    html.push("      var colour = fault ? \"#ff6b60\" : (active ? \"#f0c24b\" : \"#9fb6c7\");");
    html.push("      view.transferScreen.push({ i: i, x: p.x, y: p.y });");
    html.push("      ctx.save(); ctx.translate(p.x, p.y);");
    html.push("      if (d.type === \"pusher\") {");
    html.push("        var dir = d.side === \"left\" ? -1 : 1;");
    html.push("        ctx.fillStyle = colour; ctx.fillRect(-8, -8, 16, 16);");
    html.push("        ctx.strokeStyle = \"#0b1116\"; ctx.lineWidth = 1; ctx.strokeRect(-8, -8, 16, 16);");
    html.push("        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dir * (active ? 26 : 18), 0); ctx.strokeStyle = colour; ctx.lineWidth = 3; ctx.stroke();");
    html.push("      } else if (d.type === \"rotary_table\") {");
    html.push("        ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill();");
    html.push("        ctx.strokeStyle = \"#0b1116\"; ctx.lineWidth = 1; ctx.stroke();");
    html.push("        ctx.save(); ctx.rotate((active ? sim.now * 0.006 : 0) % (Math.PI * 2));");
    html.push("        ctx.beginPath(); ctx.moveTo(-7, -3); ctx.lineTo(7, 3); ctx.moveTo(7, -3); ctx.lineTo(-7, 3); ctx.strokeStyle = \"#0b1116\"; ctx.lineWidth = 1.5; ctx.stroke();");
    html.push("        ctx.restore();");
    html.push("      } else {");
    html.push("        ctx.fillStyle = colour; ctx.fillRect(-10, -8, 20, 16);");
    html.push("        if (dev.state === 1 || dev.state === 2) { ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.strokeRect(-13, -11, 26, 22); }");
    html.push("        ctx.strokeStyle = \"#0b1116\"; ctx.lineWidth = 1.5;");
    html.push("        ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(-4, 0); ctx.moveTo(18, 0); ctx.lineTo(4, 0); ctx.stroke();");
    html.push("      }");
    html.push("      ctx.restore();");
    html.push("      ctx.fillStyle = colour; ctx.font = \"9px Consolas, monospace\"; ctx.textAlign = \"center\";");
    html.push("      ctx.fillText(d.name, p.x, p.y - 15);");
    html.push("    }");
    html.push("  }");
    html.push("  function updateMergeSim(dt) {");
    html.push("    for (var i = 0; i < DATA.merges.length; i++) {");
    html.push("      var m = DATA.merges[i]; var ms = sim.merges[i];");
    html.push("      var mainPkg = m.mainZone ? sim.zones[m.mainZone - 1].pkg : null;");
    html.push("      var spurPkg = m.spurZone ? sim.zones[m.spurZone - 1].pkg : null;");
    html.push("      var mergeBusy = m.mergeZone ? !!sim.zones[m.mergeZone - 1].pkg : false;");
    html.push("      var mainGrant = false; var spurGrant = false;");
    html.push("      if (!mergeBusy && (mainPkg || spurPkg)) {");
    html.push("        if (mainPkg && spurPkg) {");
    html.push("          if (m.priority === \"main\") mainGrant = true;");
    html.push("          else if (m.priority === \"spur\") spurGrant = true;");
    html.push("          else { if (ms.lastMain) spurGrant = true; else mainGrant = true; }");
    html.push("        } else if (mainPkg) mainGrant = true; else spurGrant = true;");
    html.push("      }");
    html.push("      if (mainGrant) ms.lastMain = true;");
    html.push("      if (spurGrant) ms.lastMain = false;");
    html.push("      if (mainGrant && mainPkg) { ms.blockedMs += dt; if (ms.blockedMs > JAM_MS) { mainGrant = false; spurGrant = true; ms.blockedMs = 0; ms.lastMain = false; } }");
    html.push("      else if (spurGrant && spurPkg) { ms.blockedMs += dt; if (ms.blockedMs > JAM_MS) { mainGrant = true; spurGrant = false; ms.blockedMs = 0; ms.lastMain = true; } }");
    html.push("      else ms.blockedMs = 0;");
    html.push("      ms.mainGrant = mainGrant; ms.spurGrant = spurGrant;");
    html.push("      ms.grant = mainGrant ? \"MAIN\" : (spurGrant ? \"SPUR\" : \"HOLD\");");
    html.push("      var mz = m.mergeZone ? sim.zones[m.mergeZone - 1] : null;");
    html.push("      if (mainGrant && mainPkg && mz && !mz.pkg) { mz.pkg = mainPkg; mz.state = 2; sim.zones[m.mainZone - 1].pkg = null; mainPkg.zone = m.mergeZone; }");
    html.push("      if (spurGrant && spurPkg && mz && !mz.pkg) { mz.pkg = spurPkg; mz.state = 2; sim.zones[m.spurZone - 1].pkg = null; spurPkg.zone = m.mergeZone; }");
    html.push("    }");
    html.push("  }");
    html.push("  function updateDeviceSim() {");
    html.push("    var now = Date.now();");
    html.push("    for (var i = 0; i < DATA.transfers.length; i++) {");
    html.push("      var d = DATA.transfers[i]; var dev = sim.devices[i];");
    html.push("      if (dev.state === 0) continue;");
    html.push("      var timings = deviceTimings(d);");
    html.push("      var elapsed = now - dev.seqStart; var total = 0; var state = 0;");
    html.push("      for (var s = 0; s < timings.length; s++) { total += timings[s]; if (elapsed < total) { state = s + 1; break; } }");
    html.push("      if (elapsed >= total) {");
    html.push("        dev.state = 0; dev.seqStart = 0;");
    html.push("        for (var c = 0; c < 4; c++) { var b = document.getElementById(\"dev-\" + i + \"-\" + c); if (b) b.className = \"hmi-btn dev\"; }");
    html.push("      } else dev.state = state;");
    html.push("    }");
    html.push("  }");
    html.push("  function draw() {");
    html.push("    fitView();");
    html.push("    ctx.setTransform(1, 0, 0, 1, 0, 0);");
    html.push("    ctx.clearRect(0, 0, canvas.width, canvas.height);");
    html.push("    ctx.fillStyle = \"#0b1116\";");
    html.push("    ctx.fillRect(0, 0, canvas.width, canvas.height);");
    html.push("    ctx.strokeStyle = \"rgba(80,120,150,0.13)\";");
    html.push("    ctx.lineWidth = 1;");
    html.push("    for (var gx = 0; gx < canvas.width; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, canvas.height); ctx.stroke(); }");
    html.push("    for (var gy = 0; gy < canvas.height; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(canvas.width, gy); ctx.stroke(); }");
    html.push("    view.screen = [];");
    html.push("    for (var i = 0; i < ZONES.length; i++) {");
    html.push("      var zone = ZONES[i];");
    html.push("      var zs = sim.zones[i];");
    html.push("      var c = worldToScreen(zone.x, zone.y);");
    html.push("      var s = Math.max(6, zone.lengthM * view.scale);");
    html.push("      var w = Math.max(4, zone.widthM * view.scale);");
    html.push("      view.screen.push({ i: i, cx: c.x, cy: c.y, halfL: s / 2, halfW: w / 2, angle: zone.angleDeg * Math.PI / 180 });");
    html.push("      view.zoneScreen[zone.index] = c;");
    html.push("      ctx.save();");
    html.push("      ctx.translate(c.x, c.y);");
    html.push("      ctx.rotate(zone.angleDeg * Math.PI / 180);");
    html.push("      if (zone.conveyorType === \"belt\") {");
    html.push("        drawBelt(zone, s, w);");
    html.push("      } else {");
    html.push("        ctx.fillStyle = COLORS[stateName(i)];");
    html.push("        ctx.strokeStyle = (i === sim.hover) ? \"#ffffff\" : \"rgba(210,235,255,0.45)\";");
    html.push("        ctx.lineWidth = i === sim.hover ? 2 : 1;");
    html.push("        ctx.fillRect(-s / 2, -w / 2, s, w);");
    html.push("        ctx.strokeRect(-s / 2, -w / 2, s, w);");
    html.push("        ctx.strokeStyle = \"rgba(190,225,250,0.35)\";");
    html.push("        ctx.beginPath(); ctx.moveTo(s / 2, -w / 2); ctx.lineTo(s / 2, w / 2); ctx.stroke();");
    html.push("        ctx.fillStyle = zs.state === 2 ? \"#ffd166\" : \"#7fd4ff\";");
    html.push("        ctx.beginPath(); ctx.arc(-s / 2 + 3, -w / 2 + 3, 3.2, 0, Math.PI * 2); ctx.fill();");
    html.push("        ctx.fillStyle = zs.state === 1 ? \"#3fd68a\" : \"#5d7f96\";");
    html.push("        ctx.fillRect(-4, -4, 8, 8);");
    html.push("      }");
    html.push("      ctx.restore();");
    html.push("      ctx.fillStyle = \"#cfe6f7\";");
    html.push("      ctx.font = \"11px Consolas, monospace\";");
    html.push("      ctx.textAlign = \"center\";");
    html.push("      ctx.textBaseline = \"middle\";");
    html.push("      ctx.fillText(zone.label, c.x, c.y - w / 2 - 9);");
    html.push("    }");
    html.push("    // spiral height badges (one per spiral segment)");
    html.push("    var badgeDone = {};");
    html.push("    for (var b = 0; b < ZONES.length; b++) {");
    html.push("      var z = ZONES[b];");
    html.push("      if (!z.spiral || badgeDone[z.segment]) continue;");
    html.push("      badgeDone[z.segment] = true;");
    html.push("      var pc = worldToScreen(z.x, z.y);");
    html.push("      ctx.fillStyle = \"#101a22\";");
    html.push("      ctx.strokeStyle = \"#f0c24b\";");
    html.push("      ctx.lineWidth = 1;");
    html.push("      ctx.fillRect(pc.x - 58, pc.y + 16, 116, 17);");
    html.push("      ctx.strokeRect(pc.x - 58, pc.y + 16, 116, 17);");
    html.push("      ctx.fillStyle = \"#f0c24b\";");
    html.push("      ctx.font = \"10px Consolas, monospace\";");
    html.push("      ctx.fillText(\"SPIRAL \" + z.spiral.direction + \" \" + z.spiral.heightM + \" m\", pc.x, pc.y + 25);");
    html.push("    }");
    html.push("    // scan-zone (barcode scanner) markers");
    html.push("    for (var k = 0; k < DATA.scanZones.length; k++) {");
    html.push("      var sz = DATA.scanZones[k];");
    html.push("      var sp = worldToScreen(sz.x, sz.y);");
    html.push("      ctx.save();");
    html.push("      ctx.translate(sp.x, sp.y);");
    html.push("      ctx.rotate(sz.angleDeg * Math.PI / 180);");
    html.push("      ctx.fillStyle = \"rgba(127,212,255,0.85)\";");
    html.push("      ctx.beginPath();");
    html.push("      ctx.moveTo(0, -11); ctx.lineTo(9, 0); ctx.lineTo(0, 11); ctx.lineTo(-9, 0);");
    html.push("      ctx.closePath(); ctx.fill();");
    html.push("      ctx.strokeStyle = \"#0b1116\"; ctx.lineWidth = 1; ctx.stroke();");
    html.push("      ctx.restore();");
    html.push("      ctx.fillStyle = \"#7fd4ff\";");
    html.push("      ctx.font = \"10px Consolas, monospace\";");
    html.push("      ctx.textAlign = \"left\";");
    html.push("      ctx.fillText(sz.name, sp.x + 12, sp.y - 12);");
    html.push("    }");
    html.push("    // merge junctions and transfer device symbols");
    html.push("    drawMergeJunctions();");
    html.push("    drawTransfers();");
    html.push("  }");
    html.push("  function zoneAt(px, py) {");
    html.push("    var pts = view.screen;");
    html.push("    for (var i = pts.length - 1; i >= 0; i--) {");
    html.push("      var p = pts[i];");
    html.push("      var dx = px - p.cx, dy = py - p.cy;");
    html.push("      var ca = Math.cos(-p.angle), sa = Math.sin(-p.angle);");
    html.push("      var rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;");
    html.push("      if (Math.abs(rx) <= p.halfL + 2 && Math.abs(ry) <= p.halfW + 2) return p.i;");
    html.push("    }");
    html.push("    return -1;");
    html.push("  }");
    html.push("  function canvasPoint(ev) {");
    html.push("    var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: canvas.width, height: canvas.height };");
    html.push("    var sx = canvas.width / (r.width || canvas.width);");
    html.push("    var sy = canvas.height / (r.height || canvas.height);");
    html.push("    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };");
    html.push("  }");
    html.push("  function assignBarcode(pkg, zoneIndex) {");
    html.push("    var scan = SCAN_BY_ZONE[zoneIndex + 1];");
    html.push("    if (!scan) return;");
    html.push("    if (!pkg.barcode) pkg.barcode = (TRACK ? TRACK.tagPrefix.substring(0, 5) : \"TRAY\") + \"-\" +");
    html.push("      (\"0000\" + pkg.id).slice(-4);");
    html.push("    upsertTray(pkg);");
    html.push("  }");
    html.push("  canvas.addEventListener(\"mousemove\", function (ev) {");
    html.push("    var p = canvasPoint(ev);");
    html.push("    var z = zoneAt(p.x, p.y);");
    html.push("    if (z !== sim.hover) { sim.hover = z; canvas.style.cursor = z >= 0 ? \"pointer\" : \"crosshair\"; draw(); }");
    html.push("  });");
    html.push("  canvas.addEventListener(\"mouseleave\", function () { sim.hover = -1; draw(); });");
    html.push("  canvas.addEventListener(\"click\", function (ev) {");
    html.push("    var p = canvasPoint(ev);");
    html.push("    var z = zoneAt(p.x, p.y);");
    html.push("    if (z < 0) {");
    html.push("      for (var ti = 0; ti < view.transferScreen.length; ti++) {");
    html.push("        var ts = view.transferScreen[ti];");
    html.push("        if (Math.abs(p.x - ts.x) <= 16 && Math.abs(p.y - ts.y) <= 16) { triggerDevice(ts.i); draw(); renderDevices(); return; }");
    html.push("      }");
    html.push("      return;");
    html.push("    }");
    html.push("    var zs = sim.zones[z];");
    html.push("    if (zs.pkg) {");
    html.push("      if (zs.pkg.barcode) delete sim.trays[traySlot(zs.pkg)];");
    html.push("      zs.pkg = null; zs.blockedMs = 0; zs.state = sim.running ? 1 : 0;");
    html.push("    } else {");
    html.push("      var pkg = spawnPackage(z);");
    html.push("      assignBarcode(pkg, z);");
    html.push("    }");
    html.push("    draw(); renderTracking(); updateStatus();");
    html.push("  });");
    html.push("  function tick() {");
    html.push("    var now = Date.now();");
    html.push("    var dt = Math.min(250, now - (sim.lastTick || now));");
    html.push("    sim.lastTick = now;");
    html.push("    sim.now = now;");
    html.push("    if (sim.running) {");
    html.push("      if (sim.auto && now >= sim.spawnAt) {");
    html.push("        sim.spawnAt = now + 2600;");
    html.push("        if (!sim.zones[0].pkg && sim.zones[0].state !== 3) {");
    html.push("          var fresh = spawnPackage(0);");
    html.push("          assignBarcode(fresh, 0);");
    html.push("        }");
    html.push("      }");
    html.push("      for (var i = sim.zones.length - 1; i >= 0; i--) {");
    html.push("        var zs = sim.zones[i];");
    html.push("        var next = i + 1 < sim.zones.length ? sim.zones[i + 1] : null;");
    html.push("        if (zs.state === 3) continue;");
    html.push("        if (zs.pkg) {");
    html.push("          var downstreamFree = !next || (!next.pkg && next.state !== 3);");
    html.push("          if (downstreamFree) {");
    html.push("            if (next) {");
    html.push("              next.pkg = zs.pkg; zs.pkg = null; next.blockedMs = 0; next.state = 2;");
    html.push("              next.pkg.zone = i + 2;");
    html.push("              assignBarcode(next.pkg, i + 1);");
    html.push("            } else {");
    html.push("              if (zs.pkg.barcode) delete sim.trays[traySlot(zs.pkg)];");
    html.push("              zs.pkg = null;");
    html.push("            }");
    html.push("            zs.blockedMs = 0; zs.state = 1;");
    html.push("          } else {");
    html.push("            zs.blockedMs += dt;");
    html.push("            zs.state = zs.blockedMs >= JAM_MS ? 3 : 2;");
    html.push("          }");
    html.push("        } else if (zs.state !== 2) {");
    html.push("          zs.state = 1;");
    html.push("        }");
    html.push("      }");
    html.push("      updateMergeSim(dt);");
    html.push("    }");
    html.push("    updateDeviceSim();");
    html.push("    draw(); renderTracking(); renderDevices(); updateStatus();");
    html.push("  }");
    html.push("  function setRunning(v) { sim.running = v; if (v) sim.lastTick = Date.now(); draw(); updateStatus(); }");
    html.push("  document.getElementById(\"btn-run\").addEventListener(\"click\", function () { setRunning(true); });");
    html.push("  document.getElementById(\"btn-stop\").addEventListener(\"click\", function () { setRunning(false); });");
    html.push("  document.getElementById(\"btn-reset\").addEventListener(\"click\", function () {");
    html.push("    sim.running = false; sim.auto = false;");
    html.push("    simBtn.className = \"hmi-btn sim\";");
    html.push("    for (var i = 0; i < sim.zones.length; i++) { sim.zones[i].pkg = null; sim.zones[i].blockedMs = 0; sim.zones[i].state = 0; }");
    html.push("    for (var mi = 0; mi < sim.merges.length; mi++) { sim.merges[mi].mainGrant = false; sim.merges[mi].spurGrant = false; sim.merges[mi].grant = \"\"; sim.merges[mi].blockedMs = 0; }");
    html.push("    for (var di = 0; di < sim.devices.length; di++) { sim.devices[di].state = 0; sim.devices[di].fault = 0; }");
    html.push("    sim.trays = {};");
    html.push("    draw(); renderTracking(); renderDevices(); updateStatus();");
    html.push("  });");
    html.push("  simBtn.addEventListener(\"click\", function () {");
    html.push("    sim.auto = !sim.auto; sim.spawnAt = Date.now();");
    html.push("    simBtn.className = \"hmi-btn sim\" + (sim.auto ? \" active\" : \"\");");
    html.push("    updateStatus();");
    html.push("  });");
    html.push("  for (var ti = 0; ti < DATA.transfers.length; ti++) {");
    html.push("    for (var ci = 0; ci < DATA.transfers[ti].cmdTags.length; ci++) {");
    html.push("      (function (idx) {");
    html.push("        var btn = document.getElementById(\"dev-\" + idx + \"-\" + ci);");
    html.push("        if (btn) btn.addEventListener(\"click\", function () { triggerDevice(idx); draw(); renderDevices(); });");
    html.push("      })(ti);");
    html.push("    }");
    html.push("  }");
    html.push("  if (window.requestAnimationFrame) {");
    html.push("    (function loop() { tick(); window.requestAnimationFrame(loop); })();");
    html.push("  } else { setInterval(tick, 100); }");
    html.push("})();");
    html.push("</script>");
    html.push("</body>");
    html.push("</html>");
    return html.join("\n") + "\n";
  }

  /* ---------------------------------------------------------- tag list CSV */

  function generateTagListCsv(design, computed) {
    const comp = computeIfMissing(design, computed);
    const rows = [];
    rows.push(csvRow(["Tag", "DataType", "Description", "Address", "Direction", "Zone"]));
    (comp.zones || []).forEach(function (zone) {
      const label = zoneLabel(zone);
      const sensor = zone.sensorName || (label + "_SENSOR");
      const motor = zone.motorName || (label + "_RUN");
      const desc = label + " sensor input (" + blockName(zone) + " group " + zonePlcPath(zone) + "); run command " +
        motor + " at " + zoneOutputAddress(zone) + "; status " + zoneStatusPath(zone);
      rows.push(csvRow([sensor, "BOOL", desc, zoneInputAddress(zone), "Input", zone.index1Based]));
    });
    /* scan-zone / tracking tags */
    const scanZones = comp.scannedZones || [];
    scanZones.forEach(function (sz) {
      const names = scanTagNames(sz);
      const zoneNote = sz.zoneIndex1Based ? "zone " + sz.zoneIndex1Based : "unallocated";
      rows.push(csvRow([names.barcode, "STRING_" + ((comp.tracking && comp.tracking.barcodeLen) || 20),
        "Scanner barcode result (" + sz.name + ", " + zoneNote + ") - written by the external scanner MSG/CIP interface",
        "external scanner interface", "Input", sz.zoneIndex1Based || ""]));
      rows.push(csvRow([names.goodRead, "BOOL",
        "Scanner good-read pulse (" + sz.name + ") - written by the external scanner MSG/CIP interface",
        "external scanner interface", "Input", sz.zoneIndex1Based || ""]));
    });
    if (comp.tracking && comp.tracking.enabled) {
      const tr = comp.tracking;
      rows.push(csvRow(["TRACK_TBL", "TRAY_TRACK[" + tr.maxTrays + "]",
        "Tray tracking table (Barcode STRING_" + tr.barcodeLen + ", Zone, Seq, Valid, Timestamp)",
        "TRACK_TBL", "Internal", "all"]));
      rows.push(csvRow(["TRACK_COUNT", "DINT", "Tray tracking ring-buffer sequence counter", "TRACK_COUNT", "Internal", "all"]));
      rows.push(csvRow(["TRACK_RESET", "BOOL", "HMI / stop-reset tray table clear request", "TRACK_RESET", "Output", "all"]));
    }
    (comp.segments || []).forEach(function (seg) {
      if (seg.conveyorType !== "belt") return;
      const S = sanitizeDriveName(seg.name);
      rows.push(csvRow([S + "_RUN_CMD", "BOOL", "Belt drive run request (" + seg.name + ")", S + "_RUN_CMD", "Output", "all"]));
      rows.push(csvRow([S + "_DRIVE_RUN", "BOOL", "Belt drive running feedback / command (" + seg.name + ")", S + "_DRIVE_RUN", "Output", "all"]));
      rows.push(csvRow([S + "_DRIVE_FAULT", "BOOL", "Belt drive fault feedback (" + seg.name + ")", S + "_DRIVE_FAULT", "Input", "all"]));
      rows.push(csvRow([S + "_DRIVE_STATUS", "DINT", "Belt drive status word (" + seg.name + ")", S + "_DRIVE_STATUS", "Input", "all"]));
    });
    /* merge junction tags */
    (comp.merges || []).forEach(function (mg, i) {
      const P = sanitizeSymbol(mg.name, "MERGE" + (i + 1));
      rows.push(csvRow(["MERGE_" + P + "_MAIN_GRANT", "BOOL",
        "Merge " + mg.name + " release grant to the main upstream zone " + (mg.upstreamMainZone || "?") + " (priority " + (mg.priority || "alternate") + ")",
        "MERGE_" + P + "_MAIN_GRANT", "Internal", mg.mergeZoneIndex1Based || ""]));
      rows.push(csvRow(["MERGE_" + P + "_SPUR_GRANT", "BOOL",
        "Merge " + mg.name + " release grant to the spur last zone " + (mg.spurZoneIndex1Based || "?") + " (priority " + (mg.priority || "alternate") + ")",
        "MERGE_" + P + "_SPUR_GRANT", "Internal", mg.mergeZoneIndex1Based || ""]));
    });
    /* transfer device tags */
    (comp.transfers || []).forEach(function (tf, i) {
      const block = tf.ioBlock;
      const S = sanitizeSymbol(tf.name, "XFER" + (i + 1));
      const inputMap = MODEL.transferInputMap ? MODEL.transferInputMap(tf.type) : [];
      const outputMap = MODEL.transferOutputMap ? MODEL.transferOutputMap(tf.type) : [];
      rows.push(csvRow([block + "_INPUTS", "DINT", tf.typeLabel + " " + tf.name + " input image word (" + block + ")", block + ":I.Data", "Input", tf.zoneIndex1Based || "all"]));
      rows.push(csvRow([block + "_OUTPUTS", "DINT", tf.typeLabel + " " + tf.name + " output image word (" + block + ")", block + ":O.Data", "Output", tf.zoneIndex1Based || "all"]));
      inputMap.forEach(function (b) {
        rows.push(csvRow([S + "_" + b.name, "BOOL", tf.name + " input bit " + b.bit + " (" + b.description + ")",
          block + "_INPUTS." + b.bit, "Input", tf.zoneIndex1Based || "all"]));
      });
      outputMap.forEach(function (b) {
        rows.push(csvRow([S + "_" + b.name, "BOOL", tf.name + " output bit " + b.bit + " (" + b.description + ")",
          block + "_OUTPUTS." + b.bit, "Output", tf.zoneIndex1Based || "all"]));
      });
      if (tf.type === "popup_transfer") {
        rows.push(csvRow(["XFER_CMD_" + S + "_LEFT", "BOOL", "Pop-up " + tf.name + " transfer-left command", "XFER_CMD_" + S + "_LEFT", "Output", tf.zoneIndex1Based || "all"]));
        rows.push(csvRow(["XFER_CMD_" + S + "_RIGHT", "BOOL", "Pop-up " + tf.name + " transfer-right command", "XFER_CMD_" + S + "_RIGHT", "Output", tf.zoneIndex1Based || "all"]));
      } else {
        rows.push(csvRow(["XFER_CMD_" + S, "BOOL", tf.typeLabel + " " + tf.name + " route/rotate command", "XFER_CMD_" + S, "Output", tf.zoneIndex1Based || "all"]));
      }
      if (tf.type === "rotary_table") {
        rows.push(csvRow(["XFER_POS_" + S, "INT", "Rotary table " + tf.name + " current position status", "XFER_POS_" + S, "Internal", tf.zoneIndex1Based || "all"]));
        rows.push(csvRow(["XFER_DEST_" + S, "INT", "Rotary table " + tf.name + " requested destination position", "XFER_DEST_" + S, "Output", tf.zoneIndex1Based || "all"]));
      }
      rows.push(csvRow([block + "_STATUS", "DINT", tf.typeLabel + " " + tf.name + " status word", block + "_STATUS", "Internal", tf.zoneIndex1Based || "all"]));
      rows.push(csvRow([block + "_FAULT", "BOOL", tf.typeLabel + " " + tf.name + " fault", block + "_FAULT", "Input", tf.zoneIndex1Based || "all"]));
    });
    return rows.join("\r\n") + "\r\n";
  }

  /* ------------------------------------------------------- graphics spec */

  function generateGraphicsSpec(design, computed) {
    const comp = computeIfMissing(design, computed);
    const counts = designCounts(comp);
    const bounds = comp.bounds || { minX: 0, minY: 0, width: 1, height: 1 };
    const scanZones = comp.scannedZones || [];
    const tracking = comp.tracking && comp.tracking.enabled ? comp.tracking : null;
    const segments = comp.segments || [];
    const lines = [];
    lines.push("# " + (design.name || "CONVEYOR") + " - HMI Graphics Specification");
    lines.push("");
    lines.push("Generated by L5X Studio (conveyor HMI generator, v" + HMI_VERSION + "). " +
      "Use this as the implementation brief for a PlantPAx / FactoryTalk View screen.");
    lines.push("");
    lines.push("## Screen");
    lines.push("");
    lines.push("| Property | Value |");
    lines.push("| --- | --- |");
    lines.push("| Screen | " + opts_title(design) + " |");
    lines.push("| Controller | " + escHtml((design.controller && design.controller.name) || "PLC") + " |");
    lines.push("| Conveyor type | " + (comp.conveyorType || design.conveyorType || "roller") + " |");
    lines.push("| Segments | " + counts.segments + " |");
    lines.push("| Zones | " + counts.zones + " |");
    lines.push("| ZPA groups | " + counts.groups + " |");
    lines.push("| I/O blocks | " + counts.blocks + " |");
    lines.push("| Conveyor length | " + fixed(counts.lengthM, 2) + " m |");
    lines.push("| Curved zones | " + counts.curvedZones + " |");
    lines.push("| Spiral rise | " + fixed(counts.spiralRiseM, 2) + " m |");
    lines.push("| Belt segments | " + counts.beltSegments + " |");
    lines.push("| Scan zones | " + counts.scanZones + " |");
    lines.push("| Merge junctions | " + ((comp.merges || []).length) + " |");
    lines.push("| Transfer devices | " + ((comp.transfers || []).length) + " |");
    lines.push("| Tray tracking | " + (tracking ? "enabled (" + tracking.maxTrays + " trays)" : "disabled") + " |");
    lines.push("| Canvas | 1100 x 460 px logical, dark industrial theme (#10161c background) |");
    lines.push("| Coordinate system | normalised 0..1 (x right, y down), zone rectangles are centred at x,y with w x h and rotation |");
    lines.push("");
    lines.push("## Plant tag model");
    lines.push("");
    lines.push("- One `NETS[1].ZPA[g]` group instance per 1799ER block covers up to 8 zones; the group input word bits 0..7 are the zone sensors and the output word bits 0..7 are the zone run commands.");
    lines.push("- Zone k of a group uses input/output bit k-1 and `NETS[1].ZPA[g].ZONE_STATUS[k]`; group status words start at `CONFIG_ZPA.FIRST_ADDR` (1 in the generated project).");
    lines.push("");
    lines.push("## Zone state colours");
    lines.push("");
    lines.push("| State | Fill | Stroke | Meaning |");
    lines.push("| --- | --- | --- | --- |");
    lines.push("| stopped | " + STATE_COLORS.stopped.fill + " | " + STATE_COLORS.stopped.stroke + " | motor stopped, zone clear |");
    lines.push("| running | " + STATE_COLORS.running.fill + " | " + STATE_COLORS.running.stroke + " | motor running |");
    lines.push("| full | " + STATE_COLORS.full.fill + " | " + STATE_COLORS.full.stroke + " | package present (sensor made) |");
    lines.push("| jam | " + STATE_COLORS.jam.fill + " | " + STATE_COLORS.jam.stroke + " | package blocked longer than " + JAM_SECONDS + " s |");
    lines.push("");
    lines.push("## Conveyor geometry");
    lines.push("");
    lines.push("| Segment | Kind | Type | Zones | Radius / curve | Taper standard | Spiral |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    segments.forEach(function (seg) {
      const geom = seg.kind === "curve" ? ("R=" + (seg.radiusM || "?") + " m / " + (seg.curveDeg || 0) + " deg")
        : seg.kind === "spiral" && seg.spiral ? (seg.spiral.direction + " pitch " + seg.spiral.pitchM + " m / height " + seg.spiral.heightM + " m / slope " + seg.spiral.slopeDeg + " deg")
        : "straight";
      lines.push("| " + seg.name + " | " + seg.kind + " | " + seg.conveyorType + " | " + seg.zones.length + " | " +
        (seg.kind === "curve" || seg.kind === "spiral" ? "R=" + (seg.radiusM || "?") + " m" : "-") + " | " +
        (seg.taper && seg.taper.standardId ? seg.taper.standardId : "-") + " | " +
        (seg.kind === "curve" ? (seg.curveDeg + " deg") : geom) + " |");
    });
    lines.push("");
    lines.push("## Zone layout rectangles (normalised 0..1)");
    lines.push("");
    lines.push("| Zone | x | y | w | h | Rotation deg | Sensor tag | Motor tag | Status tag path |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    (comp.zones || []).forEach(function (zone) {
      const nx = (zone.x - bounds.minX) / Math.max(0.000001, bounds.width);
      const ny = (zone.y - bounds.minY) / Math.max(0.000001, bounds.height);
      const nw = zone.lengthM / Math.max(0.000001, bounds.width);
      const nh = zone.widthM / Math.max(0.000001, bounds.height);
      const label = zoneLabel(zone);
      lines.push("| " + label + " | " + fixed(nx, 4) + " | " + fixed(ny, 4) + " | " + fixed(nw, 4) +
        " | " + fixed(nh, 4) + " | " + fixed(zone.angleDeg || 0, 1) + " | " +
        (zone.sensorName || (label + "_SENSOR")) + " | " + (zone.motorName || (label + "_RUN")) + " | " +
        zoneStatusPath(zone) + " |");
    });
    lines.push("");
    lines.push("## Tag bindings");
    lines.push("");
    lines.push("| Zone | Group | Input address | Output address | Status tag path | Block | IP |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    (comp.zones || []).forEach(function (zone) {
      lines.push("| " + zoneLabel(zone) + " | " + zonePlcPath(zone) + " | " + zoneInputAddress(zone) + " | " +
        zoneOutputAddress(zone) + " | " + zoneStatusPath(zone) + " | " + blockName(zone) + " | " + (zone.ip || "") + " |");
    });
    /* scanner elements */
    lines.push("");
    lines.push("## Scanner elements (scan zones)");
    lines.push("");
    lines.push("| Scan zone | Type | Side | Zone | Block | Marker x,y (normalised) | Tags |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    scanZones.forEach(function (sz) {
      const nx = (sz.x - bounds.minX) / Math.max(0.000001, bounds.width);
      const ny = (sz.y - bounds.minY) / Math.max(0.000001, bounds.height);
      const names = scanTagNames(sz);
      lines.push("| " + sz.name + " | " + (sz.type || "barcode") + " | " + (sz.side || "right") + " | " +
        (sz.zoneIndex1Based || "-") + " | " + (sz.blockName || "-") + " | " + fixed(nx, 4) + ", " + fixed(ny, 4) +
        " | " + names.barcode + " / " + names.goodRead + " |");
    });
    if (!scanZones.length) lines.push("| (none) | | | | | | |");
    lines.push("");
    lines.push("Scanner elements are drawn as a diamond marker at the scan-zone position with the scanner name; " +
      "the barcode/good-read tags are populated by the external scanner MSG/CIP interface (no MSG logic is generated).");
    lines.push("");
    /* tray tracking panel */
    lines.push("## Tray tracking panel");
    lines.push("");
    if (tracking) {
      lines.push("| Panel property | Value |");
      lines.push("| --- | --- |");
      lines.push("| Panel rectangle (normalised) | x=0.68, y=0.12, w=0.30, h=0.80 (right side) |");
      lines.push("| Background | #121b22, border #27404f |");
      lines.push("| Columns | Slot | Barcode | Zone | State |");
      lines.push("| Rows | " + tracking.maxTrays + " (one per TRACK_TBL slot) |");
      lines.push("| Table tag | TRACK_TBL[" + tracking.maxTrays + "] of TRAY_TRACK |");
      lines.push("| Count tag | TRACK_COUNT (DINT) |");
      lines.push("| Clear command | TRACK_RESET (BOOL) |");
      lines.push("| State colours | running #1f7a4d, full #a8781f, jam #9e2f2a, empty #41505f |");
      lines.push("| Barcode width | " + tracking.barcodeLen + " characters (STRING_" + tracking.barcodeLen + ") |");
      lines.push("");
      lines.push("The panel mirrors the PLC tray table: Slot = Seq MOD " + tracking.maxTrays + ", Barcode = TRAY_TRACK.Barcode, " +
        "Zone = TRAY_TRACK.Zone (global zone index), State = ZONE_STATUS of the tray's zone.");
    } else {
      lines.push("Tray tracking is disabled for this design (no TRACK_TBL panel required).");
    }
    lines.push("");
    lines.push("## Merge junctions");
    lines.push("");
    if ((comp.merges || []).length) {
      lines.push("| Merge | Priority | Merge zone | Main upstream zone | Spur last zone | Spur gap m | Grant tags | Y-junction x,y (normalised) |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      (comp.merges || []).forEach(function (mg, i) {
        const P = sanitizeSymbol(mg.name, "MERGE" + (i + 1));
        const nx = ((mg.x || 0) - bounds.minX) / Math.max(0.000001, bounds.width);
        const ny = ((mg.y || 0) - bounds.minY) / Math.max(0.000001, bounds.height);
        lines.push("| " + mg.name + " | " + (mg.priority || "alternate") + " | " + (mg.mergeZoneIndex1Based || "?") + " | " +
          (mg.upstreamMainZone || "?") + " | " + (mg.spurZoneIndex1Based || "?") + " | " +
          (mg.gapM !== null && mg.gapM !== undefined ? fixed(mg.gapM, 2) : "-") + " | MERGE_" + P + "_MAIN_GRANT / MERGE_" + P +
          "_SPUR_GRANT | " + fixed(nx, 4) + ", " + fixed(ny, 4) + " |");
      });
      lines.push("");
      lines.push("Draw the merge as a Y junction: main-line upstream zone -> merge zone (solid) and spur last zone -> merge zone " +
        "(dashed). Highlight the granted side (main = green #3fd68a, spur = blue #7fd4ff); the grant alternates according to the " +
        "priority (alternate/main/spur) and swaps after an 8 s blocked release. Grant tags are controller BOOL tags.");
    } else {
      lines.push("No merge junctions in this design.");
    }
    lines.push("");
    lines.push("## Transfer devices");
    lines.push("");
    if ((comp.transfers || []).length) {
      lines.push("| Device | Type | I/O block | IP | Zone | One-way / bidirectional | Command tags | Status / fault tags | Input bits | Output bits |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      (comp.transfers || []).forEach(function (tf, i) {
        const S = sanitizeSymbol(tf.name, "XFER" + (i + 1));
        const inputMap = MODEL.transferInputMap ? MODEL.transferInputMap(tf.type) : [];
        const outputMap = MODEL.transferOutputMap ? MODEL.transferOutputMap(tf.type) : [];
        const cmds = tf.type === "popup_transfer" ? "XFER_CMD_" + S + "_LEFT / _RIGHT" : "XFER_CMD_" + S;
        lines.push("| " + tf.name + " | " + tf.typeLabel + " | " + tf.ioBlock + " | " + tf.ip + " | " +
          (tf.zoneIndex1Based || "?") + " | " + (tf.bidirectional ? "bidirectional" : "one-way") + " | " + cmds + " | " +
          tf.ioBlock + "_STATUS / " + tf.ioBlock + "_FAULT | " +
          inputMap.map(function (b) { return b.name + "=" + b.bit; }).join(", ") + " | " +
          outputMap.map(function (b) { return b.name + "=" + b.bit; }).join(", ") + " |");
      });
      lines.push("");
      lines.push("Device symbol legend: pusher = square + arrow (colours: idle #9fb6c7, extended #f0c24b, fault #ff6b60); " +
        "rotary table = circle + rotating cross (rotating #f0c24b, at position #3fd68a); pop-up transfer = rectangle with left/right " +
        "arrows (raised = double border, transferring = #f0c24b). The device table panel (right side) lists Name / Type / Block / IP / " +
        "State / Fault and provides command buttons (Divert, Rotate, Left, Right) on the simulator.");
      if ((comp.transfers || []).some(function (t) { return t.type === "rotary_table"; })) {
        const rot = (comp.transfers || []).filter(function (t) { return t.type === "rotary_table"; })[0];
        lines.push("");
        lines.push("Rotary table " + rot.name + ": bidirectional router - rotate toward XFER_DEST_" + sanitizeSymbol(rot.name) +
          " (route logic/HMI writes the destination), current position in XFER_POS_" + sanitizeSymbol(rot.name) +
          ", direction chosen by shortest path (ROTATE_CW/ROTATE_CCW outputs), brake release, rotate timeout fault.");
      }
    } else {
      lines.push("No transfer devices in this design.");
    }
    lines.push("");
    lines.push("## Layout");
    lines.push("");
    lines.push("- Header strip: design name, controller name, conveyor type, segment/zone/group/block counts, curved zones, spiral rise, scan zones, tracking.");
    lines.push("- Left region: top-view conveyor strip (one rectangle per zone, rotated to the segment angle). Belt zones are drawn as a moving belt band; spiral segments show a height badge.");
    lines.push("- Zone label " + (comp.zones && comp.zones.length ? zoneLabel(comp.zones[0]) : "SEG1_Z1") +
      " above each zone; sensor dot at the leading edge; motor square in the zone centre (belt zones: belt band animation instead of the motor square).");
    lines.push("- Scan-zone diamond markers with the scanner name are drawn on top of the conveyor strip.");
    lines.push("- Merge Y junctions: main-line and spur lines meet at the merge zone; the granted upstream side is highlighted (main green, spur blue).");
    lines.push("- Transfer device symbols on their segment: pusher (square + arrow), rotary table (circle + cross), pop-up transfer (rectangle + left/right arrows) with live state colours.");
    lines.push("- Command row: Run / Stop / Reset / Sim buttons; status text on the right (jams, tracked trays, merge grants, active devices).");
    lines.push("- Legend: four state swatches (stopped/running/full/jam) plus scanner, belt, merge-grant and device markers.");
    lines.push("- Right region: zone tag mapping table (Zone, Block, PLC tag path, Input, Output, IP)" +
      (tracking ? ", then the Tray tracking panel (Slot, Barcode, Zone, State)" : "") +
      ((comp.segments || []).some(function (s) { return s.conveyorType === "belt"; }) ? ", then the belt drive table (Segment, Run, Fault, Status)" : "") +
      ((comp.merges || []).length ? ", then the Merge junction table (Merge, Priority, zones, Grant)" : "") +
      ((comp.transfers || []).length ? ", then the Transfer device table with command buttons (Divert/Rotate/Left/Right)." : "."));
    lines.push("- Zone status values: 0 = normal, 1 = full, 2 = jammed, 4 = out of service, 5 = 24 V loss, 6 = comm loss, 20 = jam acknowledged.");
    lines.push("");
    return lines.join("\n");
  }
  function opts_title(design) { return (design.name || "CONVEYOR") + "_HMI"; }

  return {
    generateHmiHtml: generateHmiHtml,
    generateTagListCsv: generateTagListCsv,
    generateGraphicsSpec: generateGraphicsSpec,
    HMI_VERSION: HMI_VERSION,
    STATE_COLORS: STATE_COLORS,
    zoneInputAddress: zoneInputAddress,
    zoneOutputAddress: zoneOutputAddress,
    zonePlcPath: zonePlcPath,
    zoneStatusPath: zoneStatusPath
  };
});
