/* L5X Studio - resolve.js (Lead). Resolve an operand reference through scopes, aliases,
   and UDT member chains. See CONTRACT section 9. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const OP = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;

  var PREDEF = {
    BOOL: { bits: 1 }, SINT: { bits: 8 }, INT: { bits: 16 }, DINT: { bits: 32 },
    LINT: { bits: 64 }, REAL: { bits: 32 }, LREAL: { bits: 64 },
    COUNTER: { bits: 136 }, TIMER: { bits: 136 }, CONTROL: { bits: 136 },
    MESSAGE: { bits: 424 }, STRING: { bits: 704 }
  };

  function typeBits(typeName) {
    if (!typeName) return 0;
    const t = typeName.toUpperCase().replace(/^AB:[^:]+:/, "").replace(/:I:\d+$/, "").replace(/:O:\d+$/, "");
    if (PREDEF[t]) return PREDEF[t].bits;
    return 0;
  }

  function findTagRecord(model, baseTag, scope) {
    if (scope && scope.program && model.tags.programs[scope.program]) {
      const r = model.tags.programs[scope.program].find(function (t) { return t.name === baseTag; });
      if (r) return r;
    }
    const r2 = model.tags.controller.find(function (t) { return t.name === baseTag; });
    if (r2) return r2;
    return null;
  }

  /* Split a module base tag like "Network1:I" or "Local:1:I" or "Local:1:O.Data" into
     { moduleName, slot, direction }. */
  function splitModuleTag(baseTag) {
    const parts = baseTag.split(":");
    if (parts.length < 2) return null;
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (last === "I" || last === "O" || last === "C" || last === "S") {
      const direction = last;
      if (parts.length === 2) return { moduleName: first, slot: null, direction: direction };
      if (parts.length >= 3 && /^\d+$/.test(parts[1]))
        return { moduleName: first, slot: parseInt(parts[1], 10), direction: direction };
    }
    // e.g. "Module:I.Something" where parseOperand already split members - baseTag keeps "Module:I"
    if (/^[IO]$/.test(parts[parts.length - 1]))
      return { moduleName: parts[0], slot: parts.length >= 3 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null, direction: parts[parts.length - 1] };
    return { moduleName: first, slot: null, direction: null };
  }

  /* Resolve an operand text. Returns:
     { ok:true, kind:"literal"|"tag", raw, ... } on success,
     { ok:false, error, partial } on failure (partial carries what was resolved so far). */
  function resolveOperand(model, operandText, scope) {
    const p = OP.parseOperand(operandText);
    if (p.isLiteral || p.isPlaceholder)
      return { ok: true, kind: "literal", raw: operandText, literalType: p.literalType, isPlaceholder: p.isPlaceholder, chain: [] };
    if (!p.baseTag)
      return { ok: false, error: "Cannot parse operand: " + operandText, partial: null };

    const chain = [];
    let currentType = null;
    let ioDirection = null;
    let isModuleTag = p.isModuleTag;

    if (p.isModuleTag) {
      const mt = splitModuleTag(p.baseTag);
      if (!mt) return { ok: false, error: "Cannot parse module tag: " + p.baseTag, partial: null };
      const mod = model.modules.find(function (m) {
        if (mt.slot !== null && m.parentModule === "Local" && m.parentModPortId === String(mt.slot)) return true;
        return m.name === mt.moduleName;
      });
      if (!mod && mt.slot === null && mt.moduleName === "Local") {
        // Local:I with no slot (controller-level, e.g. Local:S:FS)
      }
      chain.push({
        kind: "tag", scope: "module", name: p.baseTag, type: null,
        moduleName: mt.moduleName, slot: mt.slot,
        ioDirection: mt.direction === "I" ? "Input" : mt.direction === "O" ? "Output" : mt.direction === "C" ? "Config" : null
      });
      ioDirection = chain[0].ioDirection;
      if (mod) {
        chain[0].module = mod;
        // type of the image
        const img = mod.ioImages && (mt.direction === "I" ? mod.ioImages.input : mt.direction === "O" ? mod.ioImages.output : mod.ioImages.config);
        if (img) chain[0].type = img.dataType;
      }
      currentType = chain[0].type;
    } else {
      // scope lookup with alias following
      let rec = findTagRecord(model, p.baseTag, scope);
      if (!rec) {
        // predefined system tags (S:FS etc.) have no declaration in L5X
        if (p.baseTag === "S" || /^S:/.test(p.baseTag)) {
          chain.push({ kind: "tag", scope: "system", name: p.baseTag, type: null, record: null });
          return {
            ok: true, kind: "tag", raw: operandText, chain: chain,
            baseTag: p.baseTag, type: null, isModuleTag: false, ioDirection: null,
            note: "predefined system tag"
          };
        }
        return { ok: false, error: "Tag not found: " + p.baseTag + (scope && scope.program ? " (program " + scope.program + ")" : ""), partial: chain };
      }
      let hops = 0;
      while (rec && rec.aliasFor && hops < 10) {
        const alias = OP.parseOperand(rec.aliasFor);
        chain.push({ kind: "tag", scope: rec.program ? "program:" + rec.program : "controller", name: rec.name, type: rec.dataType, aliasOf: rec.aliasFor, record: rec });
        hops++;
        if (alias.isModuleTag) {
          const mt = splitModuleTag(alias.baseTag);
          const mod = mt && model.modules.find(function (m) {
            if (mt.slot !== null && m.parentModule === "Local" && m.parentModPortId === String(mt.slot)) return true;
            return m.name === mt.moduleName;
          });
          chain.push({
            kind: "tag", scope: "module", name: alias.baseTag, type: null,
            moduleName: mt ? mt.moduleName : null, slot: mt ? mt.slot : null,
            ioDirection: mt && (mt.direction === "I" ? "Input" : mt.direction === "O" ? "Output" : mt.direction === "C" ? "Config" : null)
          });
          const img = mod && mt && mod.ioImages && (mt.direction === "I" ? mod.ioImages.input : mt.direction === "O" ? mod.ioImages.output : mod.ioImages.config);
          chain[chain.length - 1].type = img ? img.dataType : null;
          chain[chain.length - 1].module = mod;
          // alias member path is prepended to the operand members
          const aliasMembers = alias.members;
          const merged = aliasMembers.concat(p.members.map(function (m) { return { name: m.name, index: m.index }; }));
          return walkMembers(model, chain, operandText, merged, scope);
        }
        // tag-to-tag alias
        rec = findTagRecord(model, alias.baseTag, scope);
        if (!rec) return { ok: false, error: "Alias target not found: " + alias.baseTag, partial: chain };
        const aliasMembers = alias.members;
        const merged = aliasMembers.concat(p.members.map(function (m) { return { name: m.name, index: m.index }; }));
        // continue loop with merged members against rec's type
        return walkMembersFromTag(model, chain, operandText, rec, merged);
      }
      chain.push({ kind: "tag", scope: rec.program ? "program:" + rec.program : "controller", name: rec.name, type: rec.dataType, record: rec });
      currentType = rec.dataType;
      return walkMembersFromTag(model, chain, operandText, rec, p.members);
    }
    return walkMembers(model, chain, operandText, p.members, scope);
  }

  function walkMembersFromTag(model, chain, operandText, rec, members) {
    let type = rec.dataType;
    if (rec.dimension > 0 && members.length && members[0].name === null) {
      // array index on the tag itself
      chain.push({ kind: "member", name: null, index: members[0].index, type: rec.dataType, dim: rec.dimension, tagArray: true });
      members = members.slice(1);
    }
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const dt = model.dataTypes.find(function (d) { return d.name === type; });
      if (!dt) {
        // predefined type or unknown: record best-effort
        chain.push({ kind: "member", name: m.name, index: m.index, type: type, unresolved: true });
        if (type === "STRING" && m.name === "DATA") type = "SINT";
        else type = null;
        continue;
      }
      let child = null;
      if (m.name !== null) child = dt.members.find(function (c) { return c.name === m.name; });
      if (!child) {
        chain.push({ kind: "member", name: m.name, index: m.index, type: null, unresolved: true, error: "Member " + m.name + " not found in " + type });
        return { ok: true, kind: "tag", raw: operandText, chain: chain, baseTag: chain[chain.length - 1].name, type: null, isModuleTag: false, partial: true };
      }
      chain.push({ kind: "member", name: m.name, index: m.index, type: child.dataType, dim: child.dimension, description: child.description });
      type = child.dataType;
      if (child.dimension > 0 && m.index === null) {
        // array member referenced without index: keep type
      }
    }
    return {
      ok: true, kind: "tag", raw: operandText, chain: chain,
      baseTag: chain[chain.length - 1].name || rec.name,
      type: type, isModuleTag: false, ioDirection: null
    };
  }

  /* Walk members through a module image tree. members: [{name, index}] */
  function walkMembers(model, chain, operandText, members, scope) {
    const head = chain[chain.length - 1];
    let tree = null;
    if (head && head.module && head.module.ioImages) {
      const d = head.ioDirection;
      tree = d === "Input" ? head.module.ioImages.input : d === "Output" ? head.module.ioImages.output : head.module.ioImages.config;
    }
    if (head && !head.module && head.moduleName === "Local") {
      const loc = model.modules.find(function (m) { return m.name === "Local"; });
      if (loc) { head.module = loc; tree = loc.ioImages && (head.ioDirection === "Input" ? loc.ioImages.input : loc.ioDirection === "Output" ? loc.ioImages.output : loc.ioImages.config); }
    }
    if (!tree) {
      return { ok: true, kind: "tag", raw: operandText, chain: chain, baseTag: head.name, type: null, isModuleTag: true, ioDirection: head.ioDirection, note: "no I/O image structure in L5X" };
    }
    let node = tree;
    let type = tree.dataType;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      // bit index (.5): applies to the current element/word
      if (m.bit) {
        chain.push({ kind: "member", name: null, index: m.index, type: type, bit: true });
        continue;
      }
      // array index ([2]) on the current array node
      if (m.name === null) {
        const isArray = node && (node.elements || (node.dimension || 0) > 0);
        chain.push({ kind: "member", name: null, index: m.index, type: type, arrayIndex: isArray });
        if (isArray && node) {
          if (node.elements) {
            const idx = String(m.index).replace(/[\[\]]/g, "");
            const el = node.elements.find(function (e) { return String(e.index).replace(/[\[\]]/g, "") === idx; });
            if (el) chain[chain.length - 1].elementValue = el.value;
          }
          node = (node.children && node.children.length) ? node : null;
          type = node ? node.dataType : type;
        }
        continue;
      }
      if (!node) {
        chain.push({ kind: "member", name: m.name, index: m.index, type: type, unresolved: true });
        type = null;
        continue;
      }
      let child = null;
      if (m.name !== null) child = (node.children || []).find(function (c) { return c.name === m.name; });
      if (!child && m.name !== null && node.name === m.name) child = node;
      if (child) {
        if (m.index !== null) {
          chain.push({ kind: "member", name: m.name, index: m.index, type: child.dataType, dim: child.dimension || 0 });
          if (child.elements) {
            const idx = String(m.index).replace(/[\[\]]/g, "");
            const el = child.elements.find(function (e) { return String(e.index).replace(/[\[\]]/g, "") === idx; });
            if (el) chain[chain.length - 1].elementValue = el.value;
          }
          if (child.children && child.children.length) node = child;
          else node = null;
          type = child.dataType;
        } else {
          chain.push({ kind: "member", name: m.name, index: null, type: child.dataType, dim: child.dimension || 0 });
          node = child; type = child.dataType;
        }
        continue;
      }
      chain.push({ kind: "member", name: m.name, index: m.index, type: null, unresolved: true });
      type = null; node = null;
    }
    return {
      ok: true, kind: "tag", raw: operandText, chain: chain, baseTag: head.name,
      type: type, isModuleTag: true, ioDirection: head.ioDirection
    };
  }

  /* Human text of a resolution chain. */
  function describeChain(chain) {
    let s = "";
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      if (c.kind === "tag") {
        if (c.aliasOf) s += "alias " + c.name + " -> ";
        else s += c.name + (c.ioDirection ? " (" + c.ioDirection + ")" : c.scope && c.scope.indexOf("program") === 0 ? " [program]" : c.scope === "controller" ? " [controller]" : c.scope === "module" ? " [module]" : "");
      } else {
        s += c.name !== null ? "." + c.name : "[" + c.index + "]";
        if (c.index !== null && c.name !== null) s = s.replace(/\.[^.\[]*$/, "") + "." + c.name + "[" + c.index + "]";
      }
    }
    return s;
  }

  return { resolveOperand: resolveOperand, findTagRecord: findTagRecord,
    splitModuleTag: splitModuleTag, describeChain: describeChain, typeBits: typeBits };
});
