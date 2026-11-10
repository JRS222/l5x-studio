/* L5X Studio — module-level I/O & dataflow analysis.
 *
 * For every module in a project this derives:
 *   - what it is (controller / hardware chassis module / EtherNet/IP network device /
 *     DeviceNet sub-device), its connection facts (IP, RPI, slot, image sizes),
 *   - which image points (Fault/Data/...) and which individual I/O bits are used,
 *   - the tags/buffers and routines that reference them (the dataflow),
 * and it can render the result as
 *   - Mermaid flowchart text (renderable in any Mermaid viewer / mermaid.live),
 *   - an SVG terminal-level schematic (a front-panel view of the module showing the
 *     used inputs/outputs and where their signals go; this substitutes for importing
 *     Rockwell CAD models, which cannot be embedded offline).
 *
 * Classic-script module: browser global L5XStudio, Node require().
 */
(function (factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./l5x-model.js"),
      require("./io-list.js"),
      require("./util.js")
    );
  } else {
    var root = typeof window !== "undefined" ? window : this;
    root.L5XStudio = root.L5XStudio || {};
    root.L5XStudio = Object.assign(root.L5XStudio, factory(root.L5XStudio, root.L5XStudio, root.L5XStudio));
  }
})(function (MODEL, IOLIST, UTIL) {
  "use strict";

  const BITS = { BOOL: 1, SINT: 8, INT: 16, DINT: 32, LINT: 64, REAL: 32, LREAL: 64 };
  const DISCRETE_PREFIX = /^(1799ER|1799|1734|1746|1756-I[A-Z]*|1756-O[A-Z]*|5069-I|5069-O)/i;

  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function round(v, d) { const m = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * m) / m; }
  function bytesOfDataType(dt) {
    const m = /^(SINT|INT|DINT|LINT|REAL|LREAL|BOOL)$/i.exec(String(dt || "").trim());
    if (m) return Math.max(1, BITS[m[1].toUpperCase()] / 8);
    return 0;
  }
  function bitsOfDataType(dt) {
    const m = /^(SINT|INT|DINT|LINT|BOOL)$/i.exec(String(dt || "").trim());
    if (!m) return 0;
    return BITS[m[1].toUpperCase()];
  }
  function structureBytes(node) {
    if (!node) return 0;
    const dim = Math.max(1, num(node.dimension, 0) + 1);
    let b = bytesOfDataType(node.dataType);
    if (node.children && node.children.length) {
      b = node.children.reduce(function (a, c) { return a + structureBytes(c); }, 0);
    }
    return b * dim;
  }

  /* ------------------------------------------------------------------ helpers */
  function controllerName(model) {
    const c = model && model.controller ? model.controller : null;
    return (c && c.name) || "Controller";
  }

  function firstPortOfType(mod, type) {
    return (mod.ports || []).find(function (p) { return String(p.type || "").toLowerCase() === String(type || "").toLowerCase(); }) || null;
  }

  function classifyModule(model, mod) {
    const name = mod.name;
    if (!mod.parentModule || name === controllerName(model) || /^Local$/i.test(name)) {
      return { kind: "controller", protocol: "Controller", slot: null, ip: null };
    }
    const parent = model.modules.find(function (m) { return m.name === mod.parentModule; });
    const eth = firstPortOfType(mod, "Ethernet");
    const icp = firstPortOfType(mod, "ICP");
    const devnet = firstPortOfType(mod, "DeviceNet");
    const parentIsController = !parent || !parent.parentModule || /^Local$/i.test(String(parent.name));
    if (parentIsController && eth) {
      return { kind: "network", protocol: "EtherNet/IP", slot: null, ip: eth.address || null };
    }
    if (parentIsController && icp) {
      const slot = Number(icp.address);
      return { kind: "hardware", protocol: "Backplane (chassis)", slot: isFinite(slot) ? slot : icp.address, ip: null };
    }
    if (parent && devnet) return { kind: "subdevice", protocol: "DeviceNet", slot: null, ip: null };
    if (parent && !parentIsController) {
      const pdev = parent.ports && parent.ports.find(function (p) { return p.id === mod.parentModPortId; });
      return { kind: "subdevice", protocol: pdev ? String(pdev.type) : "Sub-device", slot: null, ip: pdev ? pdev.address : null };
    }
    return { kind: "hardware", protocol: "Backplane (chassis)", slot: null, ip: null };
  }

  /* Discrete I/O capacity derived from the catalog number, when it encodes it. */
  function capacityFromCatalog(cat) {
    const s = String(cat || "");
    const m = /IQ(\d+)[A-Z]*XOQ?(\d+)/i.exec(s) || /IQ(\d+)X?O?Q?(\d+)/i.exec(s);
    if (m) return { inputBits: +m[1], outputBits: +m[2], source: "catalog" };
    const m2 = /^1756-([IO])([A-Z]*)(\d+)$/i.exec(s);
    if (m2) {
      const dir = m2[1].toUpperCase(), family = m2[2].toUpperCase(), n = +m2[3];
      const analog = family === "F" || family === "R";
      if (analog) {
        return dir === "I" ? { inputBits: null, inputPoints: n, outputBits: 0, source: "catalog-analog" }
          : { inputBits: 0, outputBits: null, outputPoints: n, source: "catalog-analog" };
      }
      if (dir === "I") return { inputBits: n, outputBits: 0, source: "catalog" };
      return { inputBits: 0, outputBits: n, source: "catalog" };
    }
    return null;
  }

  function collectRoutineTexts(model) {
    const out = [];
    for (const p of (model.programs || [])) {
      for (const r of (p.routines || [])) {
        const c = r.content || {};
        let text = "";
        if (c.kind === "rll") text = (c.rungs || []).map(function (x) { return (x.text || ""); }).join(" ; ");
        else if (c.kind === "st") text = c.text || "";
        else if (c.kind === "fbd" || c.kind === "sfc") text = c.xmlText || "";
        else text = c.xmlText || "";
        out.push({ program: p.name, routine: r.name, text: text, kind: c.kind });
      }
    }
    return out;
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* ------------------------------------------------------------------ analysis */
  function analyzeModules(model, opts) {
    opts = opts || {};
    const rows = IOLIST.buildIoListRows(model, { maxRows: opts.maxRows || 100000 });
    const rowsByModule = {};
    for (const r of rows) {
      if (!r.moduleName) continue;
      (rowsByModule[r.moduleName] = rowsByModule[r.moduleName] || []).push(r);
    }
    const routines = collectRoutineTexts(model);
    const notes = [];
    const byName = {};
    for (const m of (model.modules || [])) byName[m.name] = m;

    /* project-wide bit references on the shared I/O buffers (e.g. ENET_INPUTS[..].3) */
    const bufferBits = {}; // buffer base -> { bit -> [{routine, program}] }
    for (const rt of routines) {
      const re = /\b(ENET_INPUTS|ENET_OUTPUTS|ENET_LOCAL_INPUTS|ENET_LOCAL_OUTPUTS)\s*\[[^\]]*\]\s*\.\s*(?:\[(\d+)\]|(\d+))/g;
      let m;
      while ((m = re.exec(rt.text))) {
        const base = m[1], bit = m[2] !== undefined ? +m[2] : +m[3];
        bufferBits[base] = bufferBits[base] || {};
        (bufferBits[base][bit] = bufferBits[base][bit] || []).push({ program: rt.program, routine: rt.routine });
      }
    }
    /* ZPA per-zone copy: module word -> NETS[x].ZPA[n].INPUTS/OUTPUTS (bit-for-bit) */
    const zoneCopy = { inputs: false, outputs: false, producers: [] };
    for (const rt of routines) {
      if (/MOV\s*\(\s*ENET_INPUTS\s*\[[^\]]*\]\s*,\s*NETS\s*\[\s*\d+\s*\]\s*\.\s*ZPA\s*\[[^\]]*\]\s*\.\s*INPUTS\s*\)/i.test(rt.text)) {
        zoneCopy.inputs = true; zoneCopy.producers.push(rt.program + "/" + rt.routine);
      }
      if (/MOV\s*\(\s*NETS\s*\[\s*\d+\s*\]\s*\.\s*ZPA\s*\[[^\]]*\]\s*\.\s*OUTPUTS\s*,\s*ENET_OUTPUTS\s*\[[^\]]*\]\s*\)/i.test(rt.text)) {
        zoneCopy.outputs = true;
      }
    }
    if (zoneCopy.inputs) {
      notes.push("Zone sensor words are copied bit-for-bit from ENET_INPUTS into NETS[1].ZPA[n].INPUTS (" +
        zoneCopy.producers.slice(0, 3).join(", ") + "); module input bits 0..7 therefore feed zone scan logic.");
    }
    if (Object.keys(bufferBits).length) {
      notes.push("Bits reported as \"mapped buffer\" come from constant bit indexes read on the shared " +
        Object.keys(bufferBits).join(" / ") +
        " buffers; exact bit-to-module ownership is established at runtime by the mapping offsets (CONFIG_*.ENET_OFFSET / MAPPING_GET_OFFSET).");
    }

    const modules = [];
    let unnamedModules = 0;
    for (const mod of (model.modules || [])) {
      if (!mod.name) { unnamedModules++; continue; }  // e.g. PowerFlex DSI peripheral modules (no Name in L5X)
      const cls = classifyModule(model, mod);
      const rowList = rowsByModule[mod.name] || [];
      const conn = mod.communications && mod.communications.connections && mod.communications.connections[0];
      const inputBytes = conn && conn.input ? structureBytes(conn.input) : 0;
      const outputBytes = (function () {
        const structured = conn && conn.output ? structureBytes(conn.output) : 0;
        if (structured) return structured;
        const val = conn && conn.output ? String(conn.output.value || "").trim() : "";
        const single = /^\[(\d+)\]$/.exec(val);
        if (single) return +single[1];  // e.g. "[2]" = a 2-byte output array
        const nums = val.match(/\d+/g);
        return nums ? nums.length : (mod.communications && mod.communications.primCxnOutputSize ? num(mod.communications.primCxnOutputSize, 0) : 0);
      })();
      const rpi = conn ? conn.rpi : (mod.communications && mod.communications.rpi);
      const capacity = capacityFromCatalog(mod.catalogNumber);
      const inputWordBits = {};
      if (conn && conn.input && conn.input.children) {
        for (const ch of conn.input.children) {
          const b = bitsOfDataType(ch.dataType);
          if (b) inputWordBits[ch.name] = b;
        }
      }

      /* word-level mappings (MOV module:I.Data -> buffer) and reverse writes */
      const buffers = [];
      const directRefs = { input: {}, output: {} };
      const modRe = new RegExp("\\b" + escapeRe(mod.name) + "\\s*:\\s*([IO])\\s*\\.\\s*([A-Za-z0-9_]+(?:\\[\\d+\\])?)(?:\\s*\\.\\s*(\\d+)|\\s*\\[\\s*(\\d+)\\s*\\]\\s*\\.\\s*(\\d+))?", "g");
      for (const rt of routines) {
        let m;
        modRe.lastIndex = 0;
        while ((m = modRe.exec(rt.text))) {
          const dir = m[1] === "I" ? "input" : "output";
          const member = m[2];
          const bit = m[3] !== undefined ? +m[3] : (m[5] !== undefined ? +m[5] : null);
          if (bit !== null) {
            directRefs[dir][bit] = directRefs[dir][bit] || [];
            directRefs[dir][bit].push({ program: rt.program, routine: rt.routine });
          }
        }
        // MOV(Module:I.Data, BUFFER[idx]) style mappings
        const moveRe = new RegExp("MOV\\s*\\(\\s*" + escapeRe(mod.name) + "\\s*:\\s*([IO])\\s*\\.\\s*([A-Za-z0-9_]+)\\s*,\\s*([A-Za-z0-9_\\[\\]]+)\\s*\\)", "gi");
        let mm;
        while ((mm = moveRe.exec(rt.text))) {
          const dir = mm[1] === "I" ? "input" : "output";
          const bufferExpr = mm[3];
          const base = /^([A-Za-z0-9_]+)/.exec(bufferExpr)[1];
          buffers.push({ direction: dir, member: mm[2], buffer: base, expression: bufferExpr, routine: rt.program + "/" + rt.routine });
        }
        const writeRe = new RegExp("MOV\\s*\\(\\s*([A-Za-z0-9_\\[\\]]+)\\s*,\\s*" + escapeRe(mod.name) + "\\s*:\\s*O\\s*\\.\\s*([A-Za-z0-9_]+)\\s*\\)", "gi");
        let wm;
        while ((wm = writeRe.exec(rt.text))) {
          buffers.push({ direction: "output", member: wm[2], buffer: /^([A-Za-z0-9_]+)/.exec(wm[1])[1], expression: wm[1], routine: rt.program + "/" + rt.routine });
        }
      }

      /* per-bit usage for discrete input / output words.
         Bits are counted used when:
           - the module address is referenced bit-wise anywhere (GROUP01:I.Data.5), or
           - the module image word is mapped into a shared I/O buffer (ENET_INPUTS/OUTPUTS)
             and that buffer is read bit-wise elsewhere. Exact bit ownership is runtime
             (CONFIG_*.ENET_OFFSET), so such bits are reported as "mapped buffer" usage. */
      function bitUsage(dir) {
        const capBits = capacity ? (dir === "input" ? capacity.inputBits : capacity.outputBits) : null;
        const hasImageWord = dir === "input" ? !!(inputWordBits && inputWordBits.Data) : (outputBytes > 0);
        const total = capBits !== null && capBits !== undefined ? capBits : (hasImageWord ? 16 : 0);
        if (!total) return [];
        const dirName = dir === "input" ? "Input" : "Output";
        const wordRows = rowList.filter(function (r) { return r.direction === dirName && r.used; });
        const wordRoutines = [];
        for (const wr of wordRows) {
          for (const ref of (wr.references || [])) {
            const k = ref.program + "/" + ref.routine;
            if (wordRoutines.indexOf(k) === -1) wordRoutines.push(k);
          }
        }
        const wordMapped = wordRows.length > 0;
        const bits = [];
        const mapped = {}; // bit -> {buffer, refs}
        for (const b of buffers) {
          if (b.direction !== dir) continue;
          const shared = bufferBits[b.buffer] || {};
          for (const bit of Object.keys(shared)) {
            if (!mapped[bit]) mapped[bit] = { buffer: b.buffer, refs: shared[bit] };
          }
        }
        for (let bit = 0; bit < total; bit++) {
          const direct = directRefs[dir][bit] || [];
          const m = mapped[bit] || null;
          const how = [];
          const refs = [];
          if (direct.length) { how.push("direct bit reference"); refs.push.apply(refs, direct); }
          if (m) {
            how.push("mapped buffer " + m.buffer + "[..]." + bit);
            refs.push.apply(refs, m.refs);
          }
          if (wordMapped) how.push("image word used" + (wordRows[0] ? " by " + wordRows[0].pointPath : ""));
          bits.push({
            bit: bit,
            address: mod.name + ":" + (dir === "input" ? "I" : "O") + ".Data." + bit,
            used: direct.length > 0 || !!m,
            wordUsed: wordMapped,
            how: how,
            references: refs.slice(0, 6)
          });
        }
        return bits;
      }

      const inputBits = bitUsage("input");
      const outputBits = bitUsage("output");
      const points = rowList.map(function (r) {
        return {
          address: r.address, direction: r.direction, pointPath: r.pointPath || r.point,
          dataType: r.dataType || null, used: !!r.used, references: (r.references || []).slice(0, 8),
          bufferTag: r.bufferTag || ""
        };
      }).sort(function (a, b) { return (a.direction === b.direction ? 0 : a.direction < b.direction ? -1 : 1) || String(a.pointPath || "").localeCompare(String(b.pointPath || "")); });

      const tagRefs = {};
      for (const r of rowList) {
        for (const ref of (r.references || [])) {
          if (ref.kind === "read" || ref.kind === "write") tagRefs[r.address] = tagRefs[r.address] || { address: r.address, reads: 0, writes: 0, routines: [] };
          if (ref.kind === "read") tagRefs[r.address].reads++;
          if (ref.kind === "write") tagRefs[r.address].writes++;
          const key = ref.program + "/" + ref.routine;
          if (tagRefs[r.address].routines.indexOf(key) === -1) tagRefs[r.address].routines.push(key);
        }
      }

      const usedIn = inputBits.filter(function (b) { return b.used; }).length;
      const usedOut = outputBits.filter(function (b) { return b.used; }).length;
      const wordMappedIn = inputBits.length && inputBits.some(function (b) { return b.wordUsed; }) ? inputBits.length : 0;
      const wordMappedOut = outputBits.length && outputBits.some(function (b) { return b.wordUsed; }) ? outputBits.length : 0;
      const usedPoints = points.filter(function (p) { return p.used; }).length;

      modules.push(Object.assign({
        name: mod.name,
        catalogNumber: mod.catalogNumber || "",
        parentModule: mod.parentModule || null,
        parentModPortId: mod.parentModPortId || null,
        ports: (mod.ports || []).map(function (p) { return { id: p.id, address: p.address, type: p.type, upstream: p.upstream, hasBus: p.hasBus }; }),
        vendor: mod.vendor || "",
        productType: mod.productType || "",
        inhibited: !!mod.inhibited,
        kind: cls.kind,
        kindLabel: cls.kind === "controller" ? "Controller"
          : cls.kind === "network" ? "Network I/O"
          : cls.kind === "hardware" ? "Hardware I/O"
          : cls.kind === "subdevice" ? "Sub-device" : "Module",
        protocol: cls.protocol,
        slot: cls.slot,
        ip: cls.ip,
        rpi: rpi !== undefined && rpi !== null ? String(rpi) : null,
        connectionName: conn ? conn.name : null,
        inputBytes: inputBytes,
        outputBytes: outputBytes,
        capacity: capacity,
        points: points,
        buffers: buffers,
        inputBits: inputBits,
        outputBits: outputBits,
        zoneCopy: zoneCopy,
        tagRefs: Object.keys(tagRefs).map(function (k) { return tagRefs[k]; }),
        summary: {
          usedInputBits: usedIn, totalInputBits: inputBits.length,
          usedOutputBits: usedOut, totalOutputBits: outputBits.length,
          wordMappedInputBits: wordMappedIn, wordMappedOutputBits: wordMappedOut,
          usedPoints: usedPoints, totalPoints: points.length
        }
      }, rowsByModule[mod.name] ? {} : {}));
    }

    /* ---- communication topology: parent/child relations, bridges, transport ---- */
    const FIELD_BUSES = { "DeviceNet": 1, "ControlNet": 1, "DH+": 1, "Data Highway Plus": 1, "RIO": 1, "Remote I/O": 1, "Profibus": 1, "Modbus": 1, "Serial": 1 };
    const byParent = {};
    for (const m of modules) {
      if (!m.parentModule || m.parentModule === m.name) continue;
      (byParent[m.parentModule] = byParent[m.parentModule] || []).push(m);
    }
    for (const m of modules) {
      m.children = (byParent[m.name] || []).map(function (c) { return c.name; });
      m.childModules = (byParent[m.name] || []).map(function (c) {
        return { name: c.name, catalogNumber: c.catalogNumber, protocol: c.protocol, kind: c.kind, usedPoints: c.summary.usedPoints, ip: c.ip };
      });
      const buses = {};
      for (const c of (byParent[m.name] || [])) if (!FIELD_BUSES[c.protocol]) buses[c.protocol] = true;
      m.busLabel = Object.keys(buses).join(" / ") || m.protocol;
      const fieldPort = (m.ports || []).find(function (p) { return FIELD_BUSES[p.type]; });
      m.fieldBus = fieldPort ? String(fieldPort.type) : null;
      if (m.fieldBus) m.busLabel = m.fieldBus;
      m.isBridge = m.kind !== "controller" && (!!m.fieldBus || m.children.length > 0);
      if (m.kind === "controller") m.transportLabel = "Controller (local chassis)";
      else if (m.kind === "network") m.transportLabel = "EtherNet/IP network I/O";
      else if (m.kind === "hardware") m.transportLabel = m.isBridge
        ? "Chassis bridge (" + (m.fieldBus || m.busLabel || "backplane") + ")"
        : "Local chassis I/O (backplane slot " + (m.slot !== null && m.slot !== undefined ? m.slot : "?") + ")";
      else m.transportLabel = (m.protocol || "Network") + " remote I/O (sub-device)";
      // how this module's image words move: local wiring vs network transport
      m.wordTransport = m.kind === "controller" ? "local"
        : (m.kind === "hardware" && !m.isBridge) ? "backplane/local wiring"
        : m.kind === "network" ? "network word over EtherNet/IP"
        : "network word over " + (m.fieldBus || m.protocol || "fieldbus");
    }
    const networks = [];
    for (const m of modules) {
      if (m.kind === "controller" || !m.isBridge) continue;
      networks.push({
        bridge: m.name,
        bridgeCatalog: m.catalogNumber,
        bus: m.fieldBus || m.busLabel,
        protocol: m.protocol,
        slot: m.slot !== null && m.slot !== undefined ? m.slot : null,
        ip: m.ip,
        rpi: m.rpi,
        imagePoints: m.summary.totalPoints,
        usedPoints: m.summary.usedPoints,
        scanListInL5x: m.children.length > 0,
        devices: (byParent[m.name] || []).map(function (c) { return c.name; }),
        deviceCount: (byParent[m.name] || []).length
      });
    }
    // Ethernet devices that hang directly off the controller
    const directEthernet = modules.filter(function (m) {
      return m.kind === "network" && !m.isBridge && m.parentModule && m.parentModule !== m.name &&
        (byParent[m.parentModule] || []).indexOf(m) !== -1 && modules.some(function (p) { return p.name === m.parentModule && p.kind === "controller"; });
    }).map(function (m) { return m.name; });

    const summary = {
      controller: controllerName(model),
      modules: modules.length,
      network: modules.filter(function (m) { return m.kind === "network"; }).length,
      hardware: modules.filter(function (m) { return m.kind === "hardware"; }).length,
      subdevices: modules.filter(function (m) { return m.kind === "subdevice"; }).length,
      controllers: modules.filter(function (m) { return m.kind === "controller"; }).length,
      bridges: networks.length,
      directEthernetDevices: directEthernet.length,
      unnamedModules: unnamedModules,
      networks: networks,
      usedPoints: modules.reduce(function (a, m) { return a + m.summary.usedPoints; }, 0),
      totalPoints: modules.reduce(function (a, m) { return a + m.summary.totalPoints; }, 0),
      usedInputBits: modules.reduce(function (a, m) { return a + m.summary.usedInputBits; }, 0),
      usedOutputBits: modules.reduce(function (a, m) { return a + m.summary.usedOutputBits; }, 0),
      wordMappedInputBits: modules.reduce(function (a, m) { return a + (m.summary.wordMappedInputBits || 0); }, 0),
      wordMappedOutputBits: modules.reduce(function (a, m) { return a + (m.summary.wordMappedOutputBits || 0); }, 0)
    };
    if (unnamedModules) notes.push(unnamedModules + " unnamed peripheral module(s) skipped (e.g. PowerFlex DSI peripherals have no Name in the L5X).");
    const missingScan = networks.filter(function (n) { return !n.scanListInL5x && n.bus && /DeviceNet|ControlNet|DH\\+/i.test(n.bus); });
    if (missingScan.length) notes.push(missingScan.map(function (n) { return n.bridge; }).join(", ") +
      ": fieldbus scan list (remote device MAC IDs/catalog numbers) is not stored in the L5X — import the matching .dnt/network configuration to list the remote devices.");
    if (networks.length || directEthernet.length) {
      notes.push("Communication topology: " + networks.length + " bridge segment(s)" +
        networks.map(function (n) { return " " + n.bridge + " (" + n.bus + ", " + n.deviceCount + " devices)"; }).join(",") +
        "; " + directEthernet.length + " EtherNet/IP device(s) directly on the controller.");
    }
    modules.sort(function (a, b) {
      const order = { controller: 0, network: 1, hardware: 2, subdevice: 3 };
      return (order[a.kind] - order[b.kind]) || String(a.name).localeCompare(String(b.name));
    });
    return { controller: summary.controller, modules: modules, summary: summary, notes: notes, zoneCopy: zoneCopy, bufferBits: bufferBits };
  }

  /* ------------------------------------------------------------------ inter-module topology */
  /* How the controller talks to the remote I/O: controller -> bridges (chassis comm modules,
     DeviceNet/ControlNet scanners, Ethernet bridges) -> remote devices, labelled with the bus
     protocol and connection facts, plus where image words are exchanged. */
  function interModuleMermaid(analysis, opts) {
    opts = opts || {};
    const L = [];
    L.push("flowchart LR");
    L.push("  classDef controller fill:#311b92,stroke:#9575cd,color:#fff,stroke-width:2px");
    L.push("  classDef bridge fill:#004d40,stroke:#26a96c,color:#fff,stroke-width:2px");
    L.push("  classDef device fill:#0d47a1,stroke:#64b5f6,color:#fff");
    L.push("  classDef remote fill:#37474f,stroke:#78909c,color:#fff");
    L.push("  classDef tag fill:#4a148c,stroke:#ba68c8,color:#fff");
    L.push("  classDef empty fill:#263238,stroke:#455a64,color:#90a4ae");
    L.push("  classDef netip fill:#0d5c46,stroke:#26a96c,color:#fff");
    L.push("  classDef netdn fill:#6d3d00,stroke:#ff9800,color:#fff");
    L.push("  classDef netcn fill:#0d3b66,stroke:#42a5f5,color:#fff");
    L.push("  classDef netdhp fill:#6b1010,stroke:#ef5350,color:#fff");
    L.push("  classDef logic fill:#3e1a5e,stroke:#ba68c8,color:#fff");
    const ctrl = analysis.modules.find(function (m) { return m.kind === "controller"; });
    const ctrlId = "CTRL";
    L.push("  " + ctrlId + "[\"" + merLabel((ctrl ? ctrl.name : analysis.controller || "Controller") +
      "<br/>" + (ctrl ? ctrl.catalogNumber : "") + "<br/>controller") + "\"]:::controller");
    const bridges = analysis.modules.filter(function (m) { return m.isBridge && m.kind !== "controller"; });
    const childNames = {};
    for (const b of bridges) for (const c of b.children) childNames[c] = true;
    const used = analysis.modules.filter(function (m) { return m.kind !== "controller" && !m.isBridge; });
    const direct = used.filter(function (m) { return !childNames[m.name]; });
    /* bridges first */
    for (const b of bridges) {
      const id = "BR_" + merNode(b.name);
      const bus = b.fieldBus || (b.childModules || []).map(function (c) { return c.protocol; })
        .filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(" / ") || b.busLabel || "fieldbus";
      const lines = [b.name, b.catalogNumber, "bridge \u00b7 " + bus];
      if (b.slot !== null && b.slot !== undefined) lines.push("chassis slot " + b.slot);
      if (b.ip) lines.push(b.ip);
      const kids = (b.childModules || []);
      lines.push(kids.length ? kids.length + " remote device(s)" : "scan list not in L5X");
      const bCls = b.fieldBus ? moduleProtocolClass(b) : "bridge";
      L.push("  " + id + "[\"" + merLabel(lines.join("<br/>")) + "\"]:::" + bCls);
      L.push("  " + ctrlId + " -->|\"" + merLabel("backplane" + (b.slot !== null && b.slot !== undefined ? " slot " + b.slot : "")) + "\"| " + id);
      for (const c of kids) {
        const cid = "DEV_" + merNode(c.name);
        const cMod = analysis.modules.find(function (m) { return m.name === c.name; });
        const bits = cMod && cMod.devicenet
          ? ((cMod.l5xInputRange ? "in " + cMod.l5xInputRange : "") + (cMod.l5xOutputRange ? " | out " + cMod.l5xOutputRange : ""))
          : cMod ? (cMod.summary.usedInputBits + "/" + cMod.summary.totalInputBits + " in, " +
            cMod.summary.usedOutputBits + "/" + cMod.summary.totalOutputBits + " out") : "";
        const isLogicCard = cMod && cMod.devicenet && /1799-ZCIOV/i.test(cMod.catalogNumber || "");
        const devLabel = cMod && cMod.devicenet
          ? [c.name, c.catalogNumber, (cMod.macId !== null && cMod.macId !== undefined ? "MAC " + cMod.macId + " \u00b7 " : "") + (cMod.rpi || "DeviceNet"), bits]
            .concat(isLogicCard ? ["local logic on the card (zone card)"] : [])
          : [c.name, c.catalogNumber, c.protocol || "remote I/O", bits];
        L.push("  " + cid + "[\"" + merLabel(devLabel.filter(function (x) { return x; }).join("<br/>")) + "\"]:::" +
          (isLogicCard ? "logic" : (cMod && (cMod.summary.usedPoints || cMod.devicenet) ? "device" : "empty")));
        L.push("  " + id + " -->|\"" + merLabel((cMod && cMod.devicenet ? "DeviceNet \u00b7 MAC " + cMod.macId : (c.protocol || bus))) + "\"| " + cid);
      }
      if (!kids.length && bus) {
        const sid = "SEG_" + merNode(b.name);
        L.push("  " + sid + "[\"" + merLabel(bus + " segment<br/>" + b.summary.totalPoints +
          " image points<br/>devices not in L5X") + "\"]:::remote");
        L.push("  " + id + " -->|\"" + merLabel(bus) + "\"| " + sid);
      }
    }
    /* devices directly on the controller (EtherNet/IP, or local chassis I/O) */
    for (const m of direct) {
      const id = "DEV_" + merNode(m.name);
      const lines = [m.name];
      if (m.catalogNumber) lines.push(m.catalogNumber);
      if (m.kind === "network") {
        lines.push("EtherNet/IP" + (m.ip ? " " + m.ip : ""));
        if (m.rpi) lines.push("RPI " + m.rpi + " \u00b5s");
      } else if (m.kind === "hardware") {
        lines.push("local chassis I/O" + (m.slot !== null && m.slot !== undefined ? " slot " + m.slot : ""));
      } else {
        lines.push(m.transportLabel || m.protocol);
      }
      if (m.summary.usedPoints) lines.push(m.summary.usedPoints + "/" + m.summary.totalPoints + " points used");
      L.push("  " + id + "[\"" + merLabel(lines.join("<br/>")) + "\"]:::" + (m.summary.usedPoints ? "device" : "empty"));
      const lbl = m.kind === "network" ? "EtherNet/IP" + (m.rpi ? " \u00b7 RPI " + m.rpi : "") : (m.kind === "hardware" ? "backplane" : (m.protocol || "I/O"));
      L.push("  " + ctrlId + " -->|\"" + merLabel(lbl) + "\"| " + id);
    }
    /* optional: which image words are exchanged over the network */
    if (opts.includeWords) {
      const buffers = {};
      for (const m of direct.concat(bridges)) {
        for (const b of (m.buffers || [])) {
          if (!buffers[b.buffer]) {
            buffers[b.buffer] = "BUF_" + merNode(b.buffer);
            L.push("  " + buffers[b.buffer] + "[\"" + merLabel(b.buffer) + "\"]:::tag");
          }
        }
      }
      for (const m of direct) {
        for (const b of (m.buffers || [])) {
          if (m.summary.usedPoints) L.push("  DEV_" + merNode(m.name) + " -->|\"" + merLabel((b.direction === "input" ? "I" : "O") + ".Data word") + "\"| " + buffers[b.buffer]);
        }
      }
    }
    return L.join("\n") + "\n";
  }

  /* ------------------------------------------------------------------ mermaid */
  function merNode(id) { return String(id).replace(/[^A-Za-z0-9_]/g, "_"); }
  function merLabel(text) { return String(text).replace(/"/g, "'").replace(/\n/g, "<br/>"); }

  function moduleMermaid(analysis, moduleName, opts) {
    opts = opts || {};
    const mod = analysis.modules.find(function (m) { return m.name === moduleName; });
    if (!mod) return "flowchart LR\n  missing[\"module " + merLabel(moduleName) + " not found\"]\n";
    const L = [];
    L.push("flowchart LR");
    L.push("  classDef module fill:#0d47a1,stroke:#64b5f6,color:#fff,stroke-width:2px");
    L.push("  classDef used fill:#1b5e20,stroke:#66bb6a,color:#fff");
    L.push("  classDef mapped fill:#1565c0,stroke:#42a5f5,color:#fff");
    L.push("  classDef unused fill:#263238,stroke:#455a64,color:#90a4ae");
    L.push("  classDef tag fill:#4a148c,stroke:#ba68c8,color:#fff");
    L.push("  classDef routine fill:#e65100,stroke:#ffb74d,color:#fff");
    L.push("  classDef net fill:#004d40,stroke:#26a96c,color:#fff");
    L.push("  classDef hw fill:#e65100,stroke:#ffb74d,color:#fff");
    /* network-transport colours: image words exchanged over a network get their own colour
       per bus type, and locally wired words stay grey/purple */
    L.push("  classDef netip fill:#0d5c46,stroke:#26a96c,color:#fff");
    L.push("  classDef netdn fill:#6d3d00,stroke:#ff9800,color:#fff");
    L.push("  classDef netcn fill:#0d3b66,stroke:#42a5f5,color:#fff");
    L.push("  classDef netdhp fill:#6b1010,stroke:#ef5350,color:#fff");
    L.push("  classDef local fill:#37474f,stroke:#78909c,color:#e0e7ee");
    const protoCls = moduleProtocolClass(mod);
    const M = "M_" + merNode(mod.name);
    const title = mod.name + "<br/>" + mod.catalogNumber + "<br/>" + mod.kindLabel +
      (mod.ip ? "<br/>" + mod.ip : "") + (mod.slot !== null && mod.slot !== undefined ? "<br/>slot " + mod.slot : "") +
      (mod.rpi ? "<br/>RPI " + mod.rpi + " us" : "");
    L.push("  " + M + "[\"" + merLabel(title) + "\"]:::" + (mod.kind === "network" ? "net" : mod.kind === "hardware" ? "hw" : "module"));
    const tagIndex = {};
    let tagCount = 0;
    function tagNode(name) {
      if (tagIndex[name] !== undefined) return tagIndex[name];
      const id = "T" + (tagCount++);
      tagIndex[name] = id;
      L.push("  " + id + "[\"" + merLabel(name) + "\"]:::tag");
      return id;
    }
    const routineIndex = {};
    let routineCount = 0;
    function routineNode(name) {
      if (routineIndex[name] !== undefined) return routineIndex[name];
      const id = "R" + (routineCount++);
      routineIndex[name] = id;
      L.push("  " + id + "[\"" + merLabel(name) + "\"]:::routine");
      return id;
    }
    /* image word nodes: module -> word -> buffer tag (keeps the graph a DAG and readable).
       Network-transported words carry their bus colour and the transport in the label. */
    const wordIds = {};
    function wordNode(direction, bits) {
      if (wordIds[direction]) return wordIds[direction];
      const member = direction === "input" ? "I.Data" : "O.Data";
      const id = direction === "input" ? "W_IN" : "W_OUT";
      const used = bits.filter(function (b) { return b.used; }).length;
      const mapped = bits.filter(function (b) { return b.wordUsed; }).length;
      const transport = (mod.wordTransport && /network|backplane/i.test(mod.wordTransport)) ? mod.wordTransport : null;
      const wCls = protoCls === "local" ? "tag" : protoCls;
      L.push("  " + id + "[\"" + member + " word<br/>" + bits.length + " bits \u00b7 " + used +
        " used \u00b7 " + mapped + " word-mapped" + (transport ? "<br/>" + merLabel(transport) : "") + "\"]:::" + wCls);
      L.push("  " + M + " -->|\"" + member + (transport ? " \u00b7 " + merLabel(transport) : "") + "\"| " + id);
      wordIds[direction] = id;
      return id;
    }
    /* distinct bits are shown attached to the module; used bits continue to their routines */
    const showSpare = opts.showSpare === undefined ? true : !!opts.showSpare;
    function emitBits(bits, dir, prefix, bufferDirection) {
      const buffers = (mod.buffers || []).filter(function (b) { return b.direction === bufferDirection; });
      const visible = showSpare ? bits : (bits.some(function (b) { return b.used || b.wordUsed; }) ? bits.filter(function (b) { return b.used || b.wordUsed; }) : bits);
      bits = visible;
      if (!bits.length) return;
      const word = wordNode(bufferDirection, bits);
      if (buffers.length) {
        for (const b of buffers) L.push("  " + word + " -->|\"mapped\"| " + tagNode(b.buffer));
      }
      for (const b of bits) {
        const bitId = prefix + b.bit;
        const used = !!b.used, wordUsed = !!b.wordUsed;
        const cls = used ? "used" : wordUsed ? protoCls : "unused";
        const status = used ? "used" : wordUsed ? "network word" : "spare";
        L.push("  " + bitId + "[\"" + dir + b.bit + "<br/>.Data." + b.bit + "\"]:::" + cls);
        L.push("  " + M + " -->|\"" + status + "\"| " + bitId);
        if (!used) continue;
        const directOnly = (b.how || []).some(function (h) { return /direct/i.test(h); });
        if (!directOnly) continue;
        const seen = {};
        for (const ref of (b.references || [])) {
          const key = ref.program + "/" + ref.routine;
          if (seen[key]) continue;
          seen[key] = true;
          L.push("  " + bitId + " -->|\"bit " + b.bit + "\"| " + routineNode(key));
        }
      }
    }
    emitBits(mod.inputBits, "I", "IN_", "input");
    emitBits(mod.outputBits, "O", "OUT_", "output");
    return L.join("\n") + "\n";
  }

  /* Colour class for how a module's image words travel: per-network-type colours for network
     words (EtherNet/IP green, DeviceNet orange, ControlNet blue, DH+ red), grey for local. */
  function moduleProtocolClass(m) {
    if (!m) return "local";
    if (m.devicenet) return "netdn";
    if (m.fieldBus) {
      const fb = String(m.fieldBus).toLowerCase();
      if (fb.indexOf("devicenet") !== -1) return "netdn";
      if (fb.indexOf("controlnet") !== -1) return "netcn";
      if (fb.indexOf("dh+") !== -1 || fb.indexOf("data highway") !== -1) return "netdhp";
      return "netbus";
    }
    if (m.kind === "network") return "netip";
    if (m.kind === "hardware" && !m.isBridge) return "local";
    return "netbus";
  }

  function collectRoutineNamesForModule(mod) {
    const out = [];
    for (const b of mod.inputBits.concat(mod.outputBits)) {
      for (const r of b.references || []) {
        const k = r.program + "/" + r.routine;
        if (out.indexOf(k) === -1) out.push(k);
      }
    }
    return out;
  }

  function projectMermaid(analysis, opts) {
    opts = opts || {};
    const L = [];
    L.push("flowchart LR");
    L.push("  classDef controller fill:#311b92,stroke:#9575cd,color:#fff,stroke-width:2px");
    L.push("  classDef net fill:#004d40,stroke:#26a96c,color:#fff");
    L.push("  classDef hw fill:#e65100,stroke:#ffb74d,color:#fff");
    L.push("  classDef sub fill:#37474f,stroke:#78909c,color:#fff");
    L.push("  classDef unusedM fill:#263238,stroke:#455a64,color:#90a4ae");
    const controller = analysis.modules.find(function (m) { return m.kind === "controller"; });
    const ctrlId = controller ? "M_" + merNode(controller.name) : "C";
    let ctrlLabel = analysis.controller || "Controller";
    if (controller) ctrlLabel = controller.name + "<br/>" + controller.catalogNumber + "<br/>controller";
    L.push("  " + ctrlId + "[\"" + merLabel(ctrlLabel) + "\"]:::controller");
    const emitted = {};
    const moduleId = function (m) { return "M_" + merNode(m.name); };
    const bufferIds = {};
    let bufferCount = 0;
    let moduleCount = 0;
    for (const m of analysis.modules) {
      if (m.kind === "controller") continue;
      if (opts.maxModules && moduleCount >= opts.maxModules) break;
      moduleCount++;
      const id = moduleId(m);
      if (emitted[id]) continue;
      emitted[id] = true;
      const cls = m.kind === "network" ? "net" : m.kind === "hardware" ? "hw" : "sub";
      const lines = [m.name, m.catalogNumber, m.kindLabel];
      if (m.kind === "network" && m.ip) lines.push(m.ip);
      if (m.kind === "network" && m.rpi) lines.push("RPI " + m.rpi + " us");
      if (m.kind === "hardware" && m.slot !== null && m.slot !== undefined) lines.push("slot " + m.slot);
      if (m.summary.usedPoints) lines.push(m.summary.usedPoints + "/" + m.summary.totalPoints + " points used");
      else lines.push("unused");
      L.push("  " + id + "[\"" + merLabel(lines.join("<br/>")) + "\"]:::" + cls);
      // connection edge: network/hardware modules from the controller, sub-devices from their parent
      let parentId = ctrlId;
      let edgeLabel = m.kind === "network" ? "EtherNet/IP" + (m.rpi ? " · RPI " + m.rpi + " us" : "") :
        m.kind === "hardware" ? "chassis" + (m.slot !== null && m.slot !== undefined ? " slot " + m.slot : "") :
        "sub-device";
      if (m.kind === "subdevice" && m.parentModule) {
        const parent = analysis.modules.find(function (x) { return x.name === m.parentModule; });
        if (parent) { parentId = moduleId(parent); edgeLabel = m.protocol || "sub-device"; }
      }
      L.push("  " + parentId + " -->|\"" + merLabel(edgeLabel) + "\"| " + id);
      // buffer tag nodes for modules whose image word is used
      if (m.buffers && m.buffers.length && m.summary.usedPoints > 0) {
        const buf = m.buffers[0].buffer;
        if (bufferIds[buf] === undefined) {
          bufferIds[buf] = "B_" + merNode(buf) + "_" + (bufferCount++);
          L.push("  " + bufferIds[buf] + "[\"" + merLabel(buf) + "\"]:::tag");
        }
        L.push("  " + id + " -->|\"" + (m.buffers[0].direction === "input" ? "I" : "O") + ".Data\"| " + bufferIds[buf]);
      }
    }
    L.push("  classDef tag fill:#4a148c,stroke:#ba68c8,color:#fff");
    return L.join("\n") + "\n";
  }

  /* ------------------------------------------------------------------ schematic */
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /* Terminal-level front view of a module: inputs on the left, outputs on the right,
     used channels highlighted and wired to their tag/buffer. Returns SVG text. */
  function moduleSchematicSvg(analysis, moduleName, opts) {
    opts = opts || {};
    const mod = analysis.modules.find(function (m) { return m.name === moduleName; });
    if (!mod) return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"480\" height=\"80\"><text x=\"10\" y=\"30\">module not found: " + esc(moduleName) + "</text></svg>";
    const W = opts.width || 980;
    const rowH = 22;
    const inBits = mod.inputBits.length ? mod.inputBits : [];
    const outBits = mod.outputBits.length ? mod.outputBits : [];
    const rows = Math.max(inBits.length, outBits.length, 1);
    const H = 150 + rows * rowH + 40;
    const terminalW = 300, terminalH = 120;
    const leftX = 70, rightX = W - 70;
    const moduleTop = 70;
    const g = [];
    g.push("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + W + "\" height=\"" + H + "\" font-family=\"Segoe UI, Arial, sans-serif\">");
    g.push("<rect width=\"" + W + "\" height=\"" + H + "\" fill=\"#0f141a\" stroke=\"#2a3646\"/>");
    g.push("<text x=\"24\" y=\"30\" fill=\"#e6edf3\" font-size=\"16\" font-weight=\"600\">" + esc(mod.name) + " — " + esc(mod.kindLabel) + "</text>");
    g.push("<text x=\"24\" y=\"50\" fill=\"#8fa8bf\" font-size=\"12\">" + esc(mod.catalogNumber) + " · " + esc(mod.protocol) +
      (mod.ip ? " · " + esc(mod.ip) : "") + (mod.slot !== null && mod.slot !== undefined ? " · slot " + esc(mod.slot) : "") +
      (mod.rpi ? " · RPI " + esc(mod.rpi) + " µs" : "") + "</text>");
    g.push("<rect x=\"" + (W / 2 - terminalW / 2) + "\" y=\"" + moduleTop + "\" width=\"" + terminalW + "\" height=\"" + terminalH +
      "\" rx=\"10\" fill=\"#16202b\" stroke=\"" + (mod.kind === "network" ? "#26a96c" : "#ffb74d") + "\" stroke-width=\"2\"/>");
    g.push("<text x=\"" + (W / 2) + "\" y=\"" + (moduleTop + 26) + "\" text-anchor=\"middle\" fill=\"#e6edf3\" font-size=\"14\" font-weight=\"600\">" + esc(mod.name) + "</text>");
    g.push("<text x=\"" + (W / 2) + "\" y=\"" + (moduleTop + 46) + "\" text-anchor=\"middle\" fill=\"#8fa8bf\" font-size=\"11\">" + esc(mod.catalogNumber) + "</text>");
    g.push("<text x=\"" + (W / 2) + "\" y=\"" + (moduleTop + 68) + "\" text-anchor=\"middle\" fill=\"#8fa8bf\" font-size=\"11\">" +
      esc(mod.summary.usedInputBits + "/" + mod.summary.totalInputBits + " inputs · " + mod.summary.usedOutputBits + "/" + mod.summary.totalOutputBits + " outputs used") + "</text>");
    // input terminals (left) / output terminals (right)
    const startY = moduleTop + 80;
    for (let i = 0; i < rows; i++) {
      const y = startY + i * rowH;
      const inBit = inBits[i], outBit = outBits[i];
      if (inBit) {
        const used = inBit.used, wordUsed = inBit.wordUsed;
        const col = used ? "#66bb6a" : wordUsed ? "#42a5f5" : "#37474f";
        g.push("<line x1=\"" + leftX + "\" y1=\"" + y + "\" x2=\"" + (W / 2 - terminalW / 2) + "\" y2=\"" + y + "\" stroke=\"" + col + "\" stroke-width=\"" + (used ? 2 : 1) + "\"/>");
        g.push("<circle cx=\"" + leftX + "\" cy=\"" + y + "\" r=\"4\" fill=\"" + col + "\"/>");
        g.push("<text x=\"" + (leftX - 10) + "\" y=\"" + (y + 4) + "\" text-anchor=\"end\" fill=\"" + ((used || wordUsed) ? "#e6edf3" : "#607d8b") + "\" font-size=\"11\">I" + inBit.bit + "</text>");
        if (used) g.push("<text x=\"" + (leftX + 12) + "\" y=\"" + (y + 4) + "\" fill=\"#8fa8bf\" font-size=\"10\">" + esc((inBit.how || []).join("; ").slice(0, 60)) + "</text>");
      }
      if (outBit) {
        const used = outBit.used, wordUsed = outBit.wordUsed;
        const col = used ? "#ffb74d" : wordUsed ? "#42a5f5" : "#37474f";
        g.push("<line x1=\"" + (W / 2 + terminalW / 2) + "\" y1=\"" + y + "\" x2=\"" + rightX + "\" y2=\"" + y + "\" stroke=\"" + col + "\" stroke-width=\"" + (used ? 2 : 1) + "\"/>");
        g.push("<circle cx=\"" + rightX + "\" cy=\"" + y + "\" r=\"4\" fill=\"" + col + "\"/>");
        g.push("<text x=\"" + (rightX + 10) + "\" y=\"" + (y + 4) + "\" fill=\"" + ((used || wordUsed) ? "#e6edf3" : "#607d8b") + "\" font-size=\"11\">O" + outBit.bit + "</text>");
        if (used) g.push("<text x=\"" + (rightX - 12) + "\" y=\"" + (y + 4) + "\" text-anchor=\"end\" fill=\"#8fa8bf\" font-size=\"10\">" + esc((outBit.how || []).join("; ").slice(0, 60)) + "</text>");
      }
    }
    // buffer tags under the module
    let bx = W / 2 - terminalW / 2;
    const by = moduleTop + terminalH + 26;
    for (const b of (mod.buffers || []).slice(0, 3)) {
      g.push("<rect x=\"" + bx + "\" y=\"" + by + "\" width=\"180\" height=\"30\" rx=\"6\" fill=\"#1b1230\" stroke=\"#ba68c8\"/>");
      g.push("<text x=\"" + (bx + 10) + "\" y=\"" + (by + 19) + "\" fill=\"#e1bee7\" font-size=\"11\">" + esc((b.direction === "input" ? "I" : "O") + ".Data → " + b.buffer) + "</text>");
      bx += 196;
    }
    g.push("</svg>");
    return g.join("\n");
  }

  /* ------------------------------------------------------------------ report */
  function moduleReport(analysis, opts) {
    opts = opts || {};
    const lines = [];
    const s = analysis.summary;
    lines.push("# Module I/O & dataflow report — " + (analysis.controller || "project"));
    lines.push("");
    lines.push("- modules: **" + s.modules + "** (" + s.network + " network, " + s.hardware + " hardware, " +
      s.subdevices + " sub-devices, " + s.controllers + " controller" + (s.unnamedModules ? ", " + s.unnamedModules + " unnamed peripherals skipped" : "") + ")");
    if (s.bridges) lines.push("- communication: **" + s.bridges + "** fieldbus bridge(s), **" + (s.directEthernetDevices || 0) + "** EtherNet/IP device(s) directly on the controller" + (s.devicenetDevices ? ", **" + s.devicenetDevices + "** DeviceNet device(s) from attached .dnt network(s)" : "") + ".");
    lines.push("- used image points: **" + s.usedPoints + "/" + s.totalPoints + "**; used discrete input bits: **" +
      s.usedInputBits + "**; used output bits: **" + s.usedOutputBits + "**");
    lines.push("");
    lines.push("| module | catalog | kind | protocol | address | RPI (µs) | used in/out bits | used points |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const m of analysis.modules) {
      lines.push("| " + m.name + " | " + m.catalogNumber + " | " + m.kindLabel + " | " + m.protocol + " | " +
        (m.ip || (m.slot !== null && m.slot !== undefined ? "slot " + m.slot : "-")) + " | " + (m.rpi || "-") + " | " +
        m.summary.usedInputBits + "/" + m.summary.totalInputBits + " in, " + m.summary.usedOutputBits + "/" + m.summary.totalOutputBits + " out | " +
        m.summary.usedPoints + "/" + m.summary.totalPoints + " |");
    }
    lines.push("");
    const detailed = opts.modules || analysis.modules.filter(function (m) { return m.summary.usedPoints > 0; }).map(function (m) { return m.name; });
    for (const name of detailed) {
      const m = analysis.modules.find(function (x) { return x.name === name; });
      if (!m) continue;
      lines.push("## " + m.name + " — " + m.catalogNumber + " (" + m.kindLabel + ")");
      lines.push("");
      lines.push("- protocol: " + m.protocol + (m.ip ? " · IP " + m.ip : "") + (m.slot !== null && m.slot !== undefined ? " · slot " + m.slot : "") + (m.rpi ? " · RPI " + m.rpi + " µs" : ""));
      lines.push("- image: input " + m.inputBytes + " B, output " + m.outputBytes + " B" +
        (m.capacity ? "; discrete capacity " + m.capacity.inputBits + " in / " + m.capacity.outputBits + " out (" + m.capacity.source + ")" : ""));
      lines.push("");
      lines.push("| bit | address | status | how / tags | routines |");
      lines.push("|---|---|---|---|---|");
      for (const b of m.inputBits.concat(m.outputBits)) {
        if (!b.used && !b.wordUsed) continue;
        lines.push("| " + b.bit + " | " + b.address + " | " + (b.used ? "used" : "word-mapped") + " | " + (b.how || []).join("; ") + " | " +
          (b.references || []).map(function (r) { return r.program + "/" + r.routine; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4).join(", ") + " |");
      }
      lines.push("");
    }
    if (analysis.notes && analysis.notes.length) {
      lines.push("## Notes");
      for (const n of analysis.notes) lines.push("- " + n);
      lines.push("- CAD models: Rockwell CAD files cannot be loaded offline; the schematic SVG provided is a terminal-level connection view of each module.");
    }
    return lines.join("\n") + "\n";
  }

  /* ---- DeviceNet <-> L5X scanner image correlation -------------------------
     The DNT scanlist stores each node's input/output assembly bit offset relative to
     the scanner's Image table. The L5X exposes that image as <bridge>:I.Data[n] /
     <bridge>:O.Data[n] words, so the bit offset maps directly onto the words the PLC
     logic reads/writes. This function computes that word range and whether the words
     are referenced in the project. */
  function devnetWordPlan(bridge, direction) {
    const dirName = direction === "input" ? "Input" : "Output";
    const dataPoints = (bridge.points || []).filter(function (p) {
      return p.direction === dirName && /^Data\[\d+\]$/.test(String(p.pointPath || ""));
    });
    if (!dataPoints.length) return null;
    const bytes = direction === "input" ? bridge.inputBytes : bridge.outputBytes;
    const totalBits = bytes ? bytes * 8 : 0;
    let bits = totalBits && dataPoints.length ? Math.round(totalBits / dataPoints.length) : 32;
    if (bits !== 16 && bits !== 32) bits = 32;
    const usage = {};
    for (const p of dataPoints) usage[p.address] = { used: !!p.used, references: p.references || [] };
    const sample = String(dataPoints[0].address || "");
    const mm = /^(.*Data\[)\d+\]$/.exec(sample);
    const prefix = mm ? mm[1] : (bridge.name + ":" + (direction === "input" ? "I" : "O") + ".Data[");
    return { bits: bits, prefix: prefix, usage: usage, count: dataPoints.length };
  }
  function devnetWords(plan, bitOffset, bitLength) {
    if (!plan || !bitLength) return [];
    const start = Math.floor((bitOffset || 0) / plan.bits);
    const end = Math.floor(((bitOffset || 0) + bitLength - 1) / plan.bits);
    const out = [];
    for (let i = start; i <= end && out.length < 32; i++) {
      const address = plan.prefix + i + "]";
      const u = plan.usage[address] || { used: false, references: [] };
      out.push({ word: i, address: address, used: u.used, references: u.references });
    }
    return out;
  }
  function devnetRange(words) {
    if (!words || !words.length) return null;
    return words[0].address + (words.length > 1 ? " \u2026 " + words[words.length - 1].address : "");
  }
  /* ------------------------------------------------------------------ DeviceNet merge */
  /* Merge parsed .dnt DeviceNet network descriptions into an analysis: each remote DeviceNet
     device becomes a module under its scanner bridge, so the inter-module topology and the
     module list show a fully inclusive system (PLC + remote DeviceNet I/O). */
  function mergeDeviceNetIntoAnalysis(analysis, devnet, opts) {
    opts = opts || {};
    const devices = [];
    for (const f of (devnet || [])) {
      for (const d of (f.devices || [])) devices.push(Object.assign({ file: f.fileName || f.file || "" }, d));
    }
    if (!devices.length) {
      analysis.notes.push("DeviceNet file(s) contained no devices to merge.");
      return analysis;
    }
    const bridges = analysis.modules.filter(function (m) {
      return m.isBridge && m.kind !== "controller" && /DeviceNet|ControlNet|DH\+|fieldbus/i.test((m.fieldBus || "") + " " + (m.busLabel || ""));
    });
    let bridge = null;
    if (opts.bridge) bridge = analysis.modules.find(function (m) { return m.name === opts.bridge; }) || null;
    if (!bridge) {
      const dnb = bridges.filter(function (m) { return /DNB|DeviceNet/i.test((m.catalogNumber || "") + " " + (m.fieldBus || "")); });
      bridge = dnb[0] || bridges[0] || analysis.modules.find(function (m) { return m.isBridge && m.kind !== "controller"; }) || null;
    }
    const inPlan = devnetWordPlan(bridge, "input");
    const outPlan = devnetWordPlan(bridge, "output");
    const parsedFiles = (devnet || []);
    if (!bridge) {
      analysis.notes.push("DeviceNet file(s) loaded, but the L5X has no fieldbus bridge module (e.g. 1756-DNB) to attach them to.");
      analysis.devnet = { files: (devnet || []).map(function (f) { return f.fileName || f.file || ""; }), devices: devices, bridge: null };
      return analysis;
    }
    const net = (analysis.summary.networks || []).find(function (n) { return n.bridge === bridge.name; });
    for (const d of devices) {
      const mac = d.macId !== undefined && d.macId !== null ? d.macId : null;
      const name = d.name || ("DN" + (mac !== null ? String(mac).padStart(2, "0") + " " : "") + (d.catalogNumber || "device"));
      const words = function (bytes) { return bytes ? Math.ceil(bytes / 2) : 0; };
      const pseudo = {
        name: name,
        catalogNumber: d.catalogNumber || "",
        parentModule: bridge.name,
        kind: "devicenet",
        kindLabel: "DeviceNet device",
        protocol: "DeviceNet",
        transportLabel: "DeviceNet remote I/O",
        wordTransport: "network word over DeviceNet",
        ip: null, slot: null,
        rpi: d.rpi !== undefined && d.rpi !== null ? String(d.rpi) : null,
        macId: mac,
        inputBytes: d.inputBytes || 0,
        outputBytes: d.outputBytes || 0,
        inputWords: words(d.inputBytes || 0),
        outputWords: words(d.outputBytes || 0),
        scanOffsetIn: d.inputBitOffset !== undefined ? d.inputBitOffset : (d.scanOffsetIn !== undefined ? d.scanOffsetIn : null),
        scanOffsetOut: d.outputBitOffset !== undefined ? d.outputBitOffset : (d.scanOffsetOut !== undefined ? d.scanOffsetOut : null),
        connectionType: d.connectionType || d.connection || null,
        inputBits: [], outputBits: [], points: [], buffers: [],
        children: [], childModules: [], fieldBus: null, isBridge: false,
        summary: { usedInputBits: 0, totalInputBits: 0, usedOutputBits: 0, totalOutputBits: 0,
          wordMappedInputBits: 0, wordMappedOutputBits: 0, usedPoints: 0, totalPoints: 0 },
        devnet: true, devicenet: true, deviceFile: d.file || null
      };
      const inWords = devnetWords(inPlan, d.inputBitOffset, d.inputBitLength);
      const outWords = devnetWords(outPlan, d.outputBitOffset, d.outputBitLength);
      pseudo.l5xInputWords = inWords;
      pseudo.l5xOutputWords = outWords;
      pseudo.l5xInputRange = devnetRange(inWords);
      pseudo.l5xOutputRange = devnetRange(outWords);
      pseudo.l5xWordsUsed = inWords.concat(outWords).filter(function (w) { return w.used; }).length;
      d.l5xInputWords = inWords;
      d.l5xOutputWords = outWords;
      d.l5xInputRange = pseudo.l5xInputRange;
      d.l5xOutputRange = pseudo.l5xOutputRange;
      d.l5xWordsUsed = pseudo.l5xWordsUsed;
      analysis.modules.push(pseudo);
      bridge.children.push(pseudo.name);
      bridge.childModules.push({ name: pseudo.name, catalogNumber: pseudo.catalogNumber, protocol: "DeviceNet", kind: "devicenet", usedPoints: 0, ip: null });
      if (net) { net.devices.push(pseudo.name); net.deviceCount++; net.scanListInL5x = true; }
      d.moduleName = pseudo.name;
      d.bridge = bridge.name;
    }
    analysis.summary.subdevices = (analysis.summary.subdevices || 0) + devices.length;
    analysis.summary.devicenetDevices = devices.length;
    const scanner = parsedFiles.length ? parsedFiles[0].scannerInfo : null;
    analysis.devnet = {
      files: parsedFiles.map(function (f) { return f.fileName || f.file || ""; }),
      devices: devices, bridge: bridge.name, bus: bridge.fieldBus || bridge.busLabel,
      scannerInfo: scanner || null,
      l5xWordPlan: { input: inPlan ? { bits: inPlan.bits, count: inPlan.count } : null, output: outPlan ? { bits: outPlan.bits, count: outPlan.count } : null }
    };
    if (scanner && scanner.eprMs) {
      analysis.notes.push("DeviceNet scanner " + bridge.name + ": EPR " + scanner.eprMs + " ms, interscan " +
        scanner.interscanDelayMs + " ms, poll ratio " + scanner.pollRatio + ", retries " + scanner.transmitRetries +
        (bridge.rpi ? " (PLC-scanner RPI " + bridge.rpi + " \u00b5s from the L5X)" : "") + ".");
    }
    analysis.notes.push("DeviceNet: " + devices.length + " remote device(s) from " +
      (devnet || []).length + " file(s) attached to bridge " + bridge.name +
      (bridge.fieldBus ? " (" + bridge.fieldBus + ")" : "") + ".");
    return analysis;
  }

  const api = {
    analyzeModules, moduleMermaid, projectMermaid, interModuleMermaid, moduleSchematicSvg, moduleReport,
    mergeDeviceNetIntoAnalysis,
    classifyModule, capacityFromCatalog, structureBytes, bytesOfDataType
  };
  return api;
});