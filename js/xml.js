/* L5X Studio - xml.js (Lead). Dependency-free XML layer producing plain nodes.
   Plain node: { type:"element", name, attrs:{}, children:[{type:"text"|"cdata"|"element",...}] }
   Works identically in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function parseXml(xmlText) {
    const text = String(xmlText).replace(/^\uFEFF/, "");
    const pos = { i: 0 };
    function skipWs() { while (pos.i < text.length && /\s/.test(text[pos.i])) pos.i++; }
    function parseAttrs() {
      const attrs = {};
      while (pos.i < text.length) {
        skipWs();
        const c = text[pos.i];
        if (c === undefined || c === ">" || c === "/" || c === "?") break;
        const m = /^[^\s=/>]+/.exec(text.slice(pos.i));
        if (!m) break;
        const name = m[0]; pos.i += name.length;
        skipWs();
        if (text[pos.i] !== "=") { attrs[name] = ""; continue; }
        pos.i++;
        skipWs();
        const q = text[pos.i];
        if (q === '"' || q === "'") {
          pos.i++;
          let val = "";
          while (pos.i < text.length && text[pos.i] !== q) val += text[pos.i++];
          if (pos.i < text.length) pos.i++;
          attrs[name] = val;
        } else {
          const m2 = /^[^\s>]*/.exec(text.slice(pos.i));
          attrs[name] = m2 ? m2[0] : "";
          pos.i += (m2 ? m2[0].length : 0);
        }
      }
      return attrs;
    }
    function parseNode() {
      skipWs();
      if (pos.i >= text.length) return null;
      if (text.startsWith("<!--", pos.i)) { pos.i = text.indexOf("-->", pos.i) + 3; return null; }
      if (text.startsWith("<?", pos.i)) { pos.i = text.indexOf("?>", pos.i) + 2; return null; }
      if (text.startsWith("<![CDATA[", pos.i)) {
        const e = text.indexOf("]]>", pos.i);
        if (e === -1) { const seg = text.slice(pos.i + 9); pos.i = text.length; return { type: "cdata", text: seg }; }
        const seg = text.slice(pos.i + 9, e);
        pos.i = e + 3;
        return { type: "cdata", text: seg };
      }
      if (text.startsWith("<!", pos.i)) { pos.i = text.indexOf(">", pos.i) + 1; return null; }
      if (text[pos.i] !== "<") {
        let e = text.indexOf("<", pos.i);
        if (e === -1) e = text.length;
        const seg = text.slice(pos.i, e);
        pos.i = e;
        return { type: "text", text: seg };
      }
      if (text[pos.i + 1] === "/") return null; // closing tag: parent loop consumes it
      pos.i++;
      if (text[pos.i] === "/" || text[pos.i] === "!" || text[pos.i] === "?") {
        pos.i = text.indexOf(">", pos.i) + 1;
        return null;
      }
      const m = /^[A-Za-z_][\w.:-]*/.exec(text.slice(pos.i));
      if (!m) { pos.i = text.indexOf(">", pos.i) + 1; return null; }
      const name = m[0]; pos.i += name.length;
      const attrs = parseAttrs();
      skipWs();
      const node = { type: "element", name: name, attrs: attrs, children: [] };
      if (text[pos.i] === "/") { pos.i += 2; return node; }
      if (text[pos.i] === ">") pos.i++;
      while (pos.i < text.length) {
        if (text.startsWith("</", pos.i)) { pos.i = text.indexOf(">", pos.i) + 1; break; }
        const child = parseNode();
        if (child) node.children.push(child);
        if (pos.i >= text.length) break;
      }
      return node;
    }
    const kids = [];
    while (pos.i < text.length) {
      const c = parseNode();
      if (c) kids.push(c);
      if (pos.i >= text.length) break;
    }
    return { type: "element", name: "#doc", attrs: {}, children: kids };
  }

  function textOf(node) {
    if (!node) return "";
    return (node.children || []).filter(function (c) { return c.type === "text" || c.type === "cdata"; })
      .map(function (c) { return c.text; }).join("");
  }
  function children(node, name) {
    const list = (node && node.children || []).filter(function (c) { return c.type === "element"; });
    return name ? list.filter(function (c) { return c.name === name; }) : list;
  }
  function child(node, name) {
    const list = children(node, name);
    return list.length ? list[0] : undefined;
  }
  function attr(node, name) {
    return node && node.attrs ? node.attrs[name] : undefined;
  }

  /* Convert a browser DOMParser node tree to plain nodes (same shape as parseXml output). */
  function xmlToPlain(browserNode) {
    if (browserNode.nodeType === 3 || browserNode.nodeType === 4) return null; // text/cdata handled by parent
    const out = { type: "element", name: browserNode.nodeName, attrs: {}, children: [] };
    if (browserNode.attributes) {
      for (let i = 0; i < browserNode.attributes.length; i++) {
        out.attrs[browserNode.attributes[i].name] = browserNode.attributes[i].value;
      }
    }
    for (let i = 0; i < browserNode.childNodes.length; i++) {
      const c = browserNode.childNodes[i];
      if (c.nodeType === 3) out.children.push({ type: "text", text: c.nodeValue });
      else if (c.nodeType === 4) out.children.push({ type: "cdata", text: c.nodeValue });
      else if (c.nodeType === 1) {
        const p = xmlToPlain(c);
        if (p) out.children.push(p);
      }
    }
    return out;
  }

  /* Plain serializer (fallback path for export). */
  function nodeToXmlString(node, opts) {
    opts = opts || {};
    const indent = opts.indent || "";
    let s = "";
    if (node.type === "text") return node.text;
    if (node.type === "cdata") return "<![CDATA[" + node.text + "]]>";
    if (node.type !== "element") return "";
    s += indent + "<" + node.name;
    const keys = Object.keys(node.attrs || {});
    for (let i = 0; i < keys.length; i++) {
      const v = node.attrs[keys[i]];
      s += " " + keys[i] + "=\"" + String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") + "\"";
    }
    const kids = node.children || [];
    if (kids.length === 0) { s += "/>"; return s; }
    s += ">";
    let hasElem = false;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].type === "element") { hasElem = true; break; }
    }
    for (let i = 0; i < kids.length; i++) {
      if (hasElem) s += "\n" + nodeToXmlString(kids[i], { indent: indent + "  " });
      else s += nodeToXmlString(kids[i], opts);
    }
    if (hasElem) s += "\n" + indent;
    s += "</" + node.name + ">";
    return s;
  }

  /* Parse via DOMParser when available (faster for large files); same plain output. */
  function parseXmlSmart(text) {
    if (typeof DOMParser !== "undefined") {
      try {
        const dom = new DOMParser().parseFromString(text, "application/xml");
        if (!dom.getElementsByTagName("parsererror").length && dom.documentElement) {
          return xmlToPlain(dom);
        }
      } catch (e) { /* fall through to internal parser */ }
    }
    return parseXml(text);
  }

  return { parseXml: parseXml, parseXmlSmart: parseXmlSmart, textOf: textOf,
    children: children, child: child, attr: attr, xmlToPlain: xmlToPlain,
    nodeToXmlString: nodeToXmlString };
});
