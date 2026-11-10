/* L5X Studio - render/udt.js (Lead). "Shape" viewer for user-defined data types and any
   memberTree (module I/O images, tag initial values). HTML tree with byte/bit layout. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const UTIL = (typeof module !== "undefined" && module.exports) ? require("./util.js") : root.L5XStudio;

  var TYPE_BYTES = {
    BOOL: 0.125, SINT: 1, INT: 2, DINT: 4, LINT: 8, REAL: 4, LREAL: 8,
    STRING: 88, COUNTER: 136, TIMER: 136, CONTROL: 136, MESSAGE: 424
  };
  var BIT_TYPES = { BOOL: true };

  function typeBytes(t) {
    if (!t) return 0;
    const name = String(t).toUpperCase();
    if (TYPE_BYTES[name]) return TYPE_BYTES[name];
    const m = name.match(/^AB:[^:]*:(C|I|O):\d+$/);
    if (m) return 0; // unknown module type size
    return 0;
  }

  /* Compute member sizes + byte offsets. Logix packs BOOLs into bits within a byte group;
     other members are byte aligned. Returns annotated copy of members. */
  function annotateMembers(members, byteOffset) {
    byteOffset = byteOffset || 0;
    let bitCursor = 0, bytes = byteOffset;
    const out = [];
    for (const m of members) {
      const t = m.dataType || "";
      const isBit = BIT_TYPES[t.toUpperCase()];
      const sizeBytes = typeBytes(t);
      let dim = m.dimension || 0;
      const info = { member: m, offsetBytes: bytes, offsetBits: bitCursor, sizeBytes: 0, sizeBits: 0, children: null };
      if (isBit) {
        const count = dim > 0 ? dim : 1;
        info.sizeBits = count;
        info.offsetBits = bitCursor;
        bitCursor += count;
        if (bitCursor >= 8) { bytes += Math.floor(bitCursor / 8); bitCursor = bitCursor % 8; }
        if (m.children && m.children.length) {
          // bools with nested structure (rare)
          info.children = annotateMembers(m.children, bytes);
        }
      } else {
        // byte-aligned: advance past any partial byte group
        if (bitCursor > 0) { bytes += 1; bitCursor = 0; }
        info.offsetBytes = bytes;
        info.sizeBytes = (sizeBytes || 1) * (dim > 0 ? dim : 1);
        bytes += info.sizeBytes;
        if (m.children && m.children.length) {
          info.children = annotateMembers(m.children, info.offsetBytes);
          const maxEnd = info.children.reduce(function (acc, c) { return Math.max(acc, c.offsetBytes + (c.sizeBytes || 1)); }, info.offsetBytes);
          bytes = Math.max(bytes, maxEnd);
        }
      }
      out.push(info);
    }
    return out;
  }

  function totalSize(members) {
    const ann = annotateMembers(members, 0);
    if (!ann.length) return 0;
    return Math.max.apply(null, ann.map(function (a) { return a.offsetBytes + (a.sizeBytes || 0); }));
  }

  function el(tag, cls, text, title) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (title) e.title = title;
    return e;
  }

  function renderMemberList(container, members, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const ann = annotateMembers(members, 0);
    const ul = el("ul", "udt-tree");
    ann.forEach(function (info) { ul.appendChild(renderMember(info, opts)); });
    container.appendChild(ul);
    return { totalBytes: totalSize(members) };
  }

  function renderMember(info, opts) {
    const m = info.member;
    const li = el("li", "udt-node");
    const hasKids = m.children && m.children.length;
    const toggle = el("span", hasKids ? "udt-toggle" : "udt-toggle-none", hasKids ? "\u25b8" : "\u00a0");
    const nameEl = el("span", "udt-name", m.name || "(unnamed)");
    nameEl.title = m.description || "";
    const dim = m.dimension > 0 ? "[" + m.dimension + "]" : "";
    const typeEl = el("span", "udt-type " + (m.children ? "udt-type-struct" : ""), m.dataType + dim);
    const sizeEl = el("span", "udt-size",
      info.sizeBits && (!info.sizeBytes || info.sizeBits < 8) ? info.sizeBits + " bits" : (info.sizeBytes || 0) + " B");
    const offEl = el("span", "udt-offset", "off " + info.offsetBytes + "." + info.offsetBits);
    const valEl = m.value !== null && m.value !== undefined ? el("span", "udt-value", String(m.value)) : null;
    const row = el("div", "udt-row");
    row.appendChild(toggle); row.appendChild(nameEl); row.appendChild(typeEl);
    row.appendChild(sizeEl); row.appendChild(offEl);
    if (valEl) row.appendChild(valEl);
    li.appendChild(row);
    if (hasKids) {
      const kids = el("div", "udt-kids");
      kids.style.display = "none";
      const ul = el("ul", "udt-tree");
      annotateMembers(m.children, info.offsetBytes).forEach(function (k) { ul.appendChild(renderMember(k, opts)); });
      kids.appendChild(ul);
      li.appendChild(kids);
      toggle.addEventListener("click", function () {
        const open = kids.style.display !== "none";
        kids.style.display = open ? "none" : "block";
        toggle.textContent = open ? "\u25b8" : "\u25be";
      });
    }
    return li;
  }

  /* Public: render a UDT by name. */
  function renderUdtTree(container, model, udtName, opts) {
    const dt = model.dataTypes.find(function (d) { return d.name === udtName; });
    if (!dt) { container.innerHTML = '<div class="udt-empty">Data type "' + UTIL.xmlEscape(udtName) + '" not found</div>'; return { ok: false }; }
    const head = el("div", "udt-header");
    head.appendChild(el("span", "udt-title", udtName));
    head.appendChild(el("span", "udt-subtitle", "UDT \u00b7 " + (dt.members.length) + " top-level members \u00b7 " + totalSize(dt.members) + " bytes"));
    container.innerHTML = "";
    container.appendChild(head);
    if (dt.description) {
      const d = el("div", "udt-description", dt.description);
      container.appendChild(d);
    }
    const info = renderMemberList(container, dt.members, opts);
    return { ok: true, totalBytes: info.totalBytes };
  }

  /* Public: render an arbitrary memberTree (module image / tag initial value). */
  function renderMemberTree(container, memberTree, opts) {
    if (!memberTree) { container.innerHTML = '<div class="udt-empty">No structure</div>'; return { ok: false }; }
    const kids = memberTree.children || [];
    container.innerHTML = "";
    const head = el("div", "udt-header");
    head.appendChild(el("span", "udt-title", (opts && opts.title) || memberTree.name || "Structure"));
    if (memberTree.dataType) head.appendChild(el("span", "udt-subtitle", memberTree.dataType));
    container.appendChild(head);
    if (kids.length) renderMemberList(container, kids, opts);
    else if (memberTree.elements && memberTree.elements.length) {
      const ul = el("ul", "udt-tree");
      for (const e of memberTree.elements) {
        const li = el("li", "udt-node");
        const row = el("div", "udt-row");
        row.appendChild(el("span", "udt-name", e.index));
        if (e.value !== undefined) row.appendChild(el("span", "udt-value", String(e.value)));
        li.appendChild(row);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
    return { ok: true };
  }

  return { renderUdtTree: renderUdtTree, renderMemberTree: renderMemberTree,
    annotateMembers: annotateMembers, totalSize: totalSize };
});
