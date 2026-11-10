/* L5X Studio - ui/iopanel.js (Lead). I/O Map panel: operand -> physical point resolution,
   module tree with I/O images, reverse lookup, bit viewers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function h(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === "onclick") e.addEventListener("click", attrs[k]);
      else if (k === "title") e.title = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function IOPanel(opts) {
    if (!(this instanceof IOPanel)) return new IOPanel(opts);
    this.app = opts.app;          // { model, inspectOperand(text, scope), openRoutineTag(tag), selectModule(name) }
    this.scope = opts.scope || null; // { program: name } when browsing from a program
    this.container = opts.container;
    this._build();
  }

  IOPanel.prototype._build = function () {
    const c = this.container;
    c.innerHTML = "";
    const top = h("div", "iop-search");
    const input = h("input", null, null, { type: "text", placeholder: "Tag or operand \u2014 e.g. Network1:I.Data[2].1, AFCS[3].RUN_INTERLOCK, Local:1:O.Data.0" });
    const go = h("button", "btn", "Resolve");
    top.appendChild(input); top.appendChild(go);
    c.appendChild(top);
    const result = h("div", "iop-result");
    c.appendChild(result);
    const split = h("div", "iop-split");
    const modTree = h("div", "iop-modules");
    const modHead = h("div", "panel-title", "Modules & I/O images");
    const treeBody = h("div", "iop-modtree-body");
    modTree.appendChild(modHead); modTree.appendChild(treeBody);
    const refs = h("div", "iop-refs");
    const refsHead = h("div", "panel-title", "Referenced by (tag web)");
    const refsBody = h("div", "iop-refs-body");
    refs.appendChild(refsHead); refs.appendChild(refsBody);
    split.appendChild(modTree); split.appendChild(refs);
    c.appendChild(split);

    const self = this;
    this.input = input; this.result = result; this.treeBody = treeBody; this.refsBody = refsBody;
    this._renderModules();
    function doResolve() {
      const t = input.value.trim();
      if (!t) return;
      self.showResolution(t);
    }
    go.addEventListener("click", doResolve);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") doResolve(); });
  };

  IOPanel.prototype.setScope = function (scope) {
    this.scope = scope;
    if (this.input) this.input.placeholder = scope && scope.program
      ? "Tag in program " + scope.program + " \u2014 e.g. AFCS[3].RUN_INTERLOCK"
      : "Tag or operand \u2014 e.g. Network1:I.Data[2].1, Local:1:O.Data.0";
  };

  IOPanel.prototype.showResolution = function (operandText) {
    const ns = root.L5XStudio;
    const r = ns.resolveOperand(this.app.model, operandText, this.scope);
    const res = this.result;
    res.innerHTML = "";
    if (!r.ok) {
      res.appendChild(h("div", "iop-error", "Cannot resolve: " + r.error));
      return;
    }
    if (r.kind === "literal") {
      res.appendChild(h("div", "iop-card"));
      res.firstChild.appendChild(h("div", "iop-card-title", operandText + " \u2014 literal"));
      res.firstChild.appendChild(h("div", "iop-card-row", "Not a tag: value " + operandText));
      return;
    }
    // chain card
    const card = h("div", "iop-card");
    card.appendChild(h("div", "iop-card-title", ns.describeOperand(operandText)));
    const chainTxt = ns.describeChain(r.chain);
    card.appendChild(h("div", "iop-card-row", chainTxt));
    if (r.type) card.appendChild(h("div", "iop-card-row", "Resolved type: " + r.type));
    if (r.note) card.appendChild(h("div", "iop-card-row", r.note));
    // initial value from the tag declaration (if any)
    const rec = r.chain.length && r.chain[r.chain.length - 1].record;
    if (rec && rec.initial) {
      let valTxt = null;
      if (rec.initial.format === "L5K") valTxt = rec.initial.text;
      else if (rec.initial.tree && rec.initial.tree.value !== null && rec.initial.tree.value !== undefined) valTxt = String(rec.initial.tree.value);
      if (valTxt !== null && valTxt !== undefined && String(valTxt).length < 120) {
        const bits = ns.valueBits(String(valTxt));
        card.appendChild(h("div", "iop-card-row",
          "Initial value: " + valTxt + (bits && bits.length ? " \u2014 bits ON: " + bits.join(", ") : "")));
      }
    }
    // physical point
    const pt = ns.resolveIoPoint(this.app.model, operandText, this.scope);
    if (pt.ok) {
      const p = pt.point;
      card.appendChild(h("div", "iop-card-sub", "Physical I/O point"));
      card.appendChild(h("div", "iop-card-row", p.moduleName + " \u00b7 " + (p.catalogNumber || "?") + " \u00b7 " + p.direction));
      card.appendChild(h("div", "iop-card-row", ns.describeModuleLocation(p.module)));
      card.appendChild(h("div", "iop-card-row", "Path: " + p.memberPath + (p.bit !== null ? " \u00b7 bit " + p.bit : "") + (p.word !== null ? " \u00b7 word " + p.word : "")));
      if (p.dataType) card.appendChild(h("div", "iop-card-row", "Data type: " + p.dataType));
      if (p.value !== null && p.value !== undefined) {
        const bits = ns.valueBits(p.value);
        card.appendChild(h("div", "iop-card-row", "Value: " + p.value + (bits && bits.length ? " \u2014 bits ON: " + bits.join(", ") : "")));
      }
      if (p.module && p.module.ioImages) {
        const hint = ns.pointCountHint(
          (p.direction === "Input" && p.module.ioImages.input ? p.module.ioImages.input.dataType : null) ||
          (p.direction === "Output" && p.module.ioImages.output ? p.module.ioImages.output.dataType : null));
        if (hint) card.appendChild(h("div", "iop-card-row", "Image point count: " + hint));
      }
      const self = this;
      const btnRow = h("div", "iop-card-row");
      const b1 = h("button", "btn btn-sm", "Show in module tree");
      b1.addEventListener("click", function () { self._revealModulePoint(p); });
      btnRow.appendChild(b1);
      const b2 = h("button", "btn btn-sm", "Find referencing tags");
      b2.addEventListener("click", function () { self._showRefs(operandText, p); });
      btnRow.appendChild(b2);
      card.appendChild(btnRow);
      this._currentPoint = p;
    } else if (pt.resolved && pt.resolved.isModuleTag) {
      card.appendChild(h("div", "iop-card-row", "Module tag, but no I/O image structure found in this L5X export"));
    } else if (r.isModuleTag) {
      card.appendChild(h("div", "iop-card-row", "Module tag"));
    }
    res.appendChild(card);
  };

  IOPanel.prototype._renderModules = function () {
    const ns = root.L5XStudio;
    const tree = ns.buildModuleTree(this.app.model);
    this.treeBody.innerHTML = "";
    const ul = h("ul", "iop-tree");
    // Local first, then others
    const locals = tree.filter(function (m) { return m.isLocal; });
    const rest = tree.filter(function (m) { return !m.isLocal; });
    const self = this;
    const all = locals.concat(rest);
    for (const m of all) {
      const li = h("li", "iop-mod");
      const head = h("div", "iop-mod-head" + (m.inhibited ? " inhibited" : ""));
      const toggle = h("span", "iop-toggle", m.ioImages ? "\u25b8" : "\u00a0");
      const name = h("span", "iop-mod-name", m.name);
      name.title = m.catalogNumber + (m.isLocal ? " (chassis)" : "");
      const cat = h("span", "iop-mod-cat", m.catalogNumber);
      head.appendChild(toggle); head.appendChild(name); head.appendChild(cat);
      li.appendChild(head);
      if (m.ioImages) {
        const body = h("div", "iop-mod-body");
        body.style.display = "none";
        for (const dir of ["Input", "Output", "Config"]) {
          const img = dir === "Input" ? m.ioImages.input : dir === "Output" ? m.ioImages.output : m.ioImages.config;
          if (!img) continue;
          const d = h("div", "iop-dir");
          const dt = h("div", "iop-dir-head");
          const dtToggle = h("span", "iop-toggle", "\u25b8");
          dt.appendChild(dtToggle);
          dt.appendChild(h("span", "iop-dir-name", m.name + ":" + dir[0] + " \u00b7 " + (img.dataType || "image")));
          d.appendChild(dt);
          const db = h("div", "iop-dir-body");
          db.style.display = "none";
          if (img.children) {
            const ul2 = h("ul", "iop-tree");
            const points = ns.listModulePoints(this.app.model, m.name, dir);
            for (const pt of points) {
              const li2 = h("li", "iop-point");
              li2.textContent = pt.name + (pt.type ? "  " + pt.type : "") + (pt.value !== null && pt.value !== undefined ? "  = " + pt.value : "");
              li2.title = "Click to find referencing tags";
              (function (ptName, dirName, modName) {
                li2.addEventListener("click", function () {
                  self._showRefs(modName + ":" + dirName[0] + "." + ptName, null);
                });
              })(pt.name, dir, m.name);
              ul2.appendChild(li2);
            }
            db.appendChild(ul2);
          }
          d.appendChild(db);
          dtToggle.addEventListener("click", function () {
            const open = db.style.display !== "none";
            db.style.display = open ? "none" : "block";
            dtToggle.textContent = open ? "\u25b8" : "\u25be";
          });
          body.appendChild(d);
        }
        li.appendChild(body);
        toggle.addEventListener("click", function () {
          const open = body.style.display !== "none";
          body.style.display = open ? "none" : "block";
          toggle.textContent = open ? "\u25b8" : "\u25be";
        });
      }
      ul.appendChild(li);
    }
    this.treeBody.appendChild(ul);
  };

  IOPanel.prototype._revealModulePoint = function (point) {
    // focus the module tree section for the resolved module
    const self = this;
    this._renderModules();
    const heads = Array.prototype.slice.call(this.treeBody.querySelectorAll(".iop-mod-name"));
    for (const he of heads) {
      if (he.textContent === point.moduleName) {
        he.closest(".iop-mod-head").scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
    }
  };

  IOPanel.prototype._showRefs = function (operandText, point) {
    const ns = root.L5XStudio;
    const body = this.refsBody;
    body.innerHTML = "";
    body.appendChild(h("div", "iop-refs-title", "Tags/routines referencing " + operandText));
    body.appendChild(h("div", "iop-refs-note", "Computed from the controller-wide dataflow graph."));
    let graph = null;
    try { graph = ns.buildTagWeb(this.app.model, {}); }
    catch (e) {
      body.appendChild(h("div", "iop-error", "Tag web build failed: " + e.message));
      return;
    }
    const p = ns.parseOperand(operandText);
    const base = p.baseTag;
    const want = operandText.replace(/\s+/g, "");
    const hits = [];
    const nodeById = {};
    for (const n of graph.nodes) nodeById[n.id] = n;
    for (const n of graph.nodes) {
      const t = (n.tag || "").replace(/\s+/g, "");
      if (n.tag && (t === want || t === base)) hits.push(n);
    }
    if (!hits.length) {
      body.appendChild(h("div", "iop-refs-note", "No direct references found in routine logic."));
      return;
    }
    const ul = h("ul", "iop-refs-list");
    for (const n of hits) {
      const li = h("li", "iop-ref-item");
      li.textContent = n.scope + " \u00b7 " + n.kind + " \u00b7 " + (n.program ? n.program + "/" : "") + (n.routine ? n.routine : "");
      ul.appendChild(li);
    }
    body.appendChild(ul);
  };

  IOPanel.prototype.inspect = function (operandText) {
    if (this.input) {
      this.input.value = operandText;
      this.showResolution(operandText);
    }
  };

  return { IOPanel: IOPanel };
});
