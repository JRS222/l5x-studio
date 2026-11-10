/* L5X Studio - io-map.js (Lead). Module tree and tag -> physical I/O point mapping.
   See CONTRACT section 9. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const RES = (typeof module !== "undefined" && module.exports) ? require("./resolve.js") : root.L5XStudio;
  const OP = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;

  /* Modules sorted into a hierarchy: Local (chassis) root, then its children. */
  function buildModuleTree(model) {
    const nodes = model.modules.map(function (m) {
      const isLocal = m.name === "Local" || m.parentModule === m.name;
      const inChassis = m.parentModule === "Local" && !isLocal && m.parentModPortId !== "" &&
        !/Ethernet|DeviceNet|ControlNet/i.test((m.ports.find(function (p) { return p.upstream; }) || {}).type || "");
      return {
        name: m.name, catalogNumber: m.catalogNumber, parentModule: m.parentModule,
        parentModPortId: m.parentModPortId, inhibited: m.inhibited, majorFault: m.majorFault,
        keying: m.keying, ports: m.ports, ioImages: m.ioImages, communications: m.communications,
        isLocal: isLocal,
        slot: (m.parentModule === "Local" && !isLocal && /^\d+$/.test(m.parentModPortId)) ? parseInt(m.parentModPortId, 10) : null,
        localTagPrefix: (m.parentModule === "Local" && !isLocal && /^\d+$/.test(m.parentModPortId)) ? "Local:" + m.parentModPortId : null,
        nameTagPrefix: isLocal ? null : m.name
      };
    });
    return nodes;
  }

  /* The I/O image tree for a module+direction (memberTree or null). */
  function imageFor(model, moduleName, slot, direction) {
    const mod = model.modules.find(function (m) {
      if (slot !== null && slot !== undefined) return m.parentModule === "Local" && m.parentModPortId === String(slot);
      return m.name === moduleName;
    });
    if (!mod || !mod.ioImages) return { module: mod || null, tree: null };
    const tree = direction === "Input" ? mod.ioImages.input : direction === "Output" ? mod.ioImages.output : mod.ioImages.config;
    return { module: mod, tree: tree || null };
  }

  /* Resolve an operand to a physical I/O point. */
  function resolveIoPoint(model, operandText, scope) {
    const r = RES.resolveOperand(model, operandText, scope);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.kind === "literal") return { ok: false, error: "Operand is a literal, not a tag" };
    const head = r.chain[0];
    if (!r.isModuleTag && !(head && head.scope === "module")) {
      return { ok: false, error: "Not a module I/O tag", resolved: r };
    }
    const mod = head.module || model.modules.find(function (m) { return m.name === head.moduleName; }) || null;
    let direction = head.ioDirection;
    if (!direction) direction = "Input";
    // walk chain to produce the point description
    let memberPath = "";
    let bit = null, word = null, lastMember = null, prev = null;
    for (let i = 1; i < r.chain.length; i++) {
      const c = r.chain[i];
      if (c.kind !== "member") continue;
      if (c.name !== null && c.index !== null) memberPath += (memberPath ? "." : "") + c.name + "[" + c.index + "]";
      else if (c.name !== null) memberPath += (memberPath ? "." : "") + c.name;
      else if (c.bit) memberPath += "." + c.index;
      else memberPath += "[" + c.index + "]";
      if (c.bit) bit = parseInt(c.index, 10);
      else if (c.arrayIndex && prev && prev.name === "Data" && word === null) word = c.index;
      lastMember = c;
      prev = c;
    }
    let dataType = r.type || (lastMember && lastMember.type) || (head.module && head.module.ioImages && direction === "Input" ? head.module.ioImages.input && head.module.ioImages.input.dataType : null) || "";
    let value = lastMember && lastMember.elementValue != null ? lastMember.elementValue : null;
    return {
      ok: true,
      point: {
        operand: operandText,
        moduleName: mod ? mod.name : head.moduleName,
        catalogNumber: mod ? mod.catalogNumber : "",
        parentModule: mod ? mod.parentModule : "",
        slotOrPort: head.slot !== null && head.slot !== undefined ? String(head.slot) :
          (mod && mod.parentModule === "Local" ? (mod.parentModPortId || "net") : (mod && (mod.ports.find(function (p) { return p.upstream; }) || {}).address || "")),
        rack: mod && mod.parentModule === "Local" ? "Local chassis" : (mod ? mod.parentModule : ""),
        direction: direction,
        dataType: dataType,
        memberPath: memberPath || "(root)",
        bit: bit, word: word, value: value,
        description: lastMember && lastMember.description || (head.module ? head.module.catalogNumber || "" : ""),
        module: mod
      }
    };
  }

  /* List all leaf points of a module image (direction: Input/Output/Config). */
  function listModulePoints(model, moduleName, direction) {
    const mod = model.modules.find(function (m) { return m.name === moduleName; });
    if (!mod || !mod.ioImages) return [];
    const tree = direction === "Input" ? mod.ioImages.input : direction === "Output" ? mod.ioImages.output : mod.ioImages.config;
    if (!tree) return [];
    const points = [];
    (function walk(node, path) {
      const kids = node.children || [];
      if (!kids.length) {
        if (node.name) points.push({ name: path.join("."), type: node.dataType || node.type, value: node.value, raw: node });
        return;
      }
      for (const c of kids) {
        if (c.elements && c.elements.length) {
          for (const el of c.elements) {
            points.push({ name: path.concat([c.name + el.index]).join("."), type: c.dataType, value: el.value, raw: el });
          }
        } else if ((c.children && c.children.length)) {
          walk(c, path.concat([c.name]));
        } else {
          points.push({ name: path.concat([c.name]).join("."), type: c.dataType, value: c.value, raw: c });
        }
      }
    })(tree, []);
    return points;
  }

  /* Bits set in a Logix literal like "2#1010", "16#2A", "10", "1". */
  function valueBits(value) {
    if (value === null || value === undefined) return null;
    let num = null, width = 0;
    const s = String(value).trim();
    let m = s.match(/^2#([01_]+)$/i);
    if (m) { const bits = m[1].replace(/_/g, ""); num = parseInt(bits, 2); width = bits.length; }
    else {
      m = s.match(/^16#([0-9a-f_]+)$/i);
      if (m) { const hex = m[1].replace(/_/g, ""); num = parseInt(hex, 16); width = hex.length * 4; }
      else {
        m = s.match(/^-?\d+$/);
        if (m) { num = parseInt(s, 10); width = 32; }
        else return null;
      }
    }
    if (num === null || isNaN(num)) return null;
    const bits = [];
    for (let i = 0; i < width; i++) if (num & (1 << i)) bits.push(i);
    return bits;
  }

  /* Point count hint from the module image data type names (e.g. AB:1799_DI10:I:0 -> 10). */
  function pointCountHint(dataType) {
    if (!dataType) return null;
    const m = String(dataType).match(/_(?:DI|DO|IQ|OX|IA|OA|IB|OB)(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /* Physical location summary for a module (best-effort from L5X metadata). */
  function describeModuleLocation(mod) {
    if (!mod) return "";
    if (mod.parentModule === "Local" && /^\d+$/.test(mod.parentModPortId)) {
      return "Local chassis, slot " + mod.parentModPortId;
    }
    const up = mod.ports.find(function (p) { return p.upstream; });
    if (up && up.type && up.address) return "via " + up.type + " @ " + up.address + " (parent " + mod.parentModule + ")";
    if (up && up.type) return "via " + up.type + " (parent " + mod.parentModule + ")";
    return "parent " + mod.parentModule;
  }

  return { buildModuleTree: buildModuleTree, imageFor: imageFor, resolveIoPoint: resolveIoPoint,
    listModulePoints: listModulePoints, valueBits: valueBits, pointCountHint: pointCountHint,
    describeModuleLocation: describeModuleLocation };
});
