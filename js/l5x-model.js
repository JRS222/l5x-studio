/* L5X Studio - l5x-model.js (Lead). Parse an L5X file into the project model.
   See docs/CONTRACT.md section 10 for the model shape. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const XML = (typeof module !== "undefined" && module.exports) ? require("./xml.js") : root.L5XStudio;
  const UTIL = (typeof module !== "undefined" && module.exports) ? require("./util.js") : root.L5XStudio;

  /* ---------- member trees (shared by UDTs, tags, module I/O images) ---------- */
  function parseMember(node) {
    const m = {
      name: XML.attr(node, "Name") || "",
      dataType: XML.attr(node, "DataType") || "",
      dimension: parseInt(XML.attr(node, "Dimension") || "0", 10) || 0,
      radix: XML.attr(node, "Radix") || null,
      hidden: XML.attr(node, "Hidden") === "true",
      externalAccess: XML.attr(node, "ExternalAccess") || null,
      description: XML.textOf(XML.child(node, "Description")) || null,
      children: null, value: null, elements: null
    };
    const members = XML.children(XML.child(node, "Members"), "Member");
    if (members.length) {
      m.children = members.map(parseMember);
    }
    // nested arrays (Member of array type has Dimensions + Elements)
    const dims = XML.child(node, "Dimensions");
    if (dims) {
      const arr = XML.children(dims, "Array");
      if (arr.length) {
        m.dimension = parseInt(XML.attr(arr[0], "Dimensions") || "0", 10) || 0;
      }
    }
    // initial values (Decorated format only; L5K stays raw on the parent)
    const data = XML.child(node, "Data");
    if (data && XML.attr(data, "Format") === "Decorated") {
      const tree = parseDecoratedTree(data);
      if (tree) { m.value = null; m.children = tree.children || m.children; }
    }
    const elements = XML.children(node, "Elements");
    return m;
  }

  /* Parse a <Data Format="Decorated"> subtree: Structure/StructureMember/DataValueMember/
     ArrayMember/Array/Element -> memberTree (same shape as parseMember output). */
  function parseDecoratedTree(dataNode) {
    if (!dataNode) return null;
    const struct = XML.child(dataNode, "Structure");
    const arr = XML.child(dataNode, "Array");
    if (struct) {
      const out = {
        name: "", dataType: XML.attr(struct, "DataType") || "",
        dimension: 0, radix: XML.attr(struct, "Radix") || null, hidden: false,
        externalAccess: null, description: null, children: [], value: null, elements: null
      };
      for (const c of XML.children(struct)) {
        if (c.name === "StructureMember") {
          const sm = {
            name: XML.attr(c, "Name") || "", dataType: XML.attr(c, "DataType") || "",
            dimension: 0, radix: XML.attr(c, "Radix") || null, hidden: false,
            externalAccess: null, description: null, children: [], value: null, elements: null
          };
          const nestedStruct = XML.child(c, "Structure");
          const nestedArr = XML.child(c, "ArrayMember") || XML.child(c, "Array");
          if (nestedStruct) {
            const t = parseDecoratedTree(c);
            if (t) { sm.children = t.children; sm.dataType = t.dataType || sm.dataType; }
          } else if (nestedArr) {
            sm.dimension = parseInt(XML.attr(nestedArr, "Dimensions") || "0", 10) || 0;
            const elems = XML.children(nestedArr, "Element");
            if (elems.length) {
              sm.elements = elems.map(function (e) {
                return { index: XML.attr(e, "Index") || "", value: XML.attr(e, "Value") || "" };
              });
            }
            const innerStruct = XML.child(nestedArr, "Structure");
            if (innerStruct) {
              const t = parseDecoratedTree(nestedArr);
              if (t) { sm.children = t.children; sm.dataType = t.dataType || sm.dataType; }
            }
          }
          out.children.push(sm);
        } else if (c.name === "DataValueMember") {
          out.children.push({
            name: XML.attr(c, "Name") || "", dataType: XML.attr(c, "DataType") || "",
            dimension: 0, radix: XML.attr(c, "Radix") || null, hidden: false,
            externalAccess: null, description: null, children: null,
            value: XML.attr(c, "Value") || "", elements: null
          });
        } else if (c.name === "ArrayMember") {
          const am = {
            name: XML.attr(c, "Name") || "", dataType: XML.attr(c, "DataType") || "",
            dimension: parseInt(XML.attr(c, "Dimensions") || "0", 10) || 0,
            radix: XML.attr(c, "Radix") || null, hidden: false,
            externalAccess: null, description: null, children: null,
            value: null, elements: null
          };
          const elems = XML.children(c, "Element");
          if (elems.length) {
            am.elements = elems.map(function (e) {
              return { index: XML.attr(e, "Index") || "", value: XML.attr(e, "Value") || "" };
            });
          }
          const innerStruct = XML.child(c, "Structure");
          if (innerStruct) {
            const t = parseDecoratedTree(c);
            if (t) { am.children = t.children; am.dataType = t.dataType || am.dataType; }
          }
          out.children.push(am);
        }
      }
      return out;
    }
    if (arr) {
      const out = {
        name: "", dataType: XML.attr(arr, "DataType") || "",
        dimension: parseInt(XML.attr(arr, "Dimensions") || "0", 10) || 0,
        radix: XML.attr(arr, "Radix") || null, hidden: false, externalAccess: null,
        description: null, children: null, value: null,
        elements: XML.children(arr, "Element").map(function (e) {
          return { index: XML.attr(e, "Index") || "", value: XML.attr(e, "Value") || "" };
        })
      };
      return out;
    }
    return null;
  }

  /* ---------- routine content ---------- */
  var INSTR_LINE = /[A-Za-z_][A-Za-z0-9_]*\(/;

  function parseRllContent(node) {
    const rungNodes = XML.children(node, "Rung");
    if (rungNodes.length) {
      const rungs = rungNodes.map(function (rg) {
        return {
          number: parseInt(XML.attr(rg, "Number") || "0", 10) || 0,
          type: XML.attr(rg, "Type") || "N",
          comment: XML.textOf(XML.child(rg, "Comment")) || null,
          text: XML.textOf(XML.child(rg, "Text")) || ""
        };
      });
      return { kind: "rll", rungs: rungs };
    }
    // plain-text fallback: rungs split by newlines; lines with an instruction
    // pattern are logic; other non-empty lines are comments attached to the next rung.
    const raw = XML.textOf(node);
    const lines = UTIL.splitLines(raw);
    const rungs = [];
    let comment = [];
    let cur = [];
    function flush() {
      if (cur.length) {
        const text = cur.join("");
        rungs.push({
          number: rungs.length, type: "N",
          comment: comment.length ? comment.join("\n") : null,
          text: text.replace(/;\s*$/, "")
        });
      } else if (comment.length) {
        rungs.push({ number: rungs.length, type: "N", comment: comment.join("\n"), text: "" });
      }
      comment = []; cur = [];
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) { flush(); continue; }
      if (INSTR_LINE.test(line)) {
        if (comment.length && !cur.length) { /* attach below */ }
        cur.push(line);
      } else {
        if (cur.length) flush();
        comment.push(line);
      }
    }
    flush();
    return { kind: "rll", rungs: rungs };
  }

  function parseStContent(node) {
    const lineNodes = XML.children(node, "Line");
    let text;
    if (lineNodes.length) text = lineNodes.map(function (l) { return XML.textOf(l); }).join("\n");
    else text = XML.textOf(node);
    return { kind: "st", text: text };
  }

  /* Parse one <Routine ...> element into the routine shape (shared by programs and AOIs). */
  function parseRoutineElement(r) {
    const rname = XML.attr(r, "Name") || "";
    const rtype = XML.attr(r, "Type") || "RLL";
    const desc = XML.textOf(XML.child(r, "Description")) || null;
    let content;
    if (rtype === "RLL") {
      const c = XML.child(r, "RLLContent");
      content = c ? parseRllContent(c) : { kind: "rll", rungs: [] };
    } else if (rtype === "ST") {
      const c = XML.child(r, "STContent");
      content = c ? parseStContent(c) : { kind: "st", text: "" };
    } else if (rtype === "FBD") {
      const c = XML.child(r, "FBDContent");
      content = { kind: "fbd", xmlText: c ? XML.nodeToXmlString(c) : "" };
    } else if (rtype === "SFC") {
      const c = XML.child(r, "SFCContent");
      content = { kind: "sfc", xmlText: c ? XML.nodeToXmlString(c) : "" };
    } else {
      const c = XML.child(r, "EncryptedContent") || XML.child(r, rtype + "Content");
      content = { kind: "raw", xmlText: c ? XML.nodeToXmlString(c) : "" };
    }
    const extraAttrs = {};
    for (const k of Object.keys(r.attrs || {})) {
      if (k !== "Name" && k !== "Type") extraAttrs[k] = r.attrs[k];
    }
    return {
      name: rname, type: rtype, description: desc, content: content,
      pendingType: null, extraAttrs: extraAttrs
    };
  }

  /* ---------- main parse ---------- */
  function parseL5X(text) {
    const xml = XML.parseXmlSmart(text);
    const root = XML.child(xml, "RSLogix5000Content") || XML.child(xml, "Controller") || xml;
    const ctrl = XML.child(root, "Controller") || root;
    const model = {
      fileName: null, rawText: text, xml: xml,
      controller: {
        name: XML.attr(ctrl, "Name") || "",
        processorType: XML.attr(ctrl, "ProcessorType") || "",
        majorRev: XML.attr(ctrl, "MajorRev") || "",
        minorRev: XML.attr(ctrl, "MinorRev") || "",
        softwareRevision: XML.attr(root, "SoftwareRevision") || "",
        exportDate: XML.attr(root, "ExportDate") || ""
      },
      dataTypes: [],
      tags: { controller: [], programs: {} },
      modules: [],
      programs: [],
      tasks: [],
      addOnInstructions: [],
      raw: { rootNode: root, controllerNode: ctrl },
      changes: {},        // "program\x00routine" -> { type, content } (pending edits)
      warnings: []
    };

    // Data types
    const dts = XML.child(ctrl, "DataTypes");
    if (dts) {
      for (const dt of XML.children(dts, "DataType")) {
        const membersNode = XML.child(dt, "Members");
        model.dataTypes.push({
          name: XML.attr(dt, "Name") || "",
          family: XML.attr(dt, "Family") || "",
          class: XML.attr(dt, "Class") || "User",
          description: XML.textOf(XML.child(dt, "Description")) || null,
          members: membersNode ? XML.children(membersNode, "Member").map(parseMember) : []
        });
      }
    }

    // Modules
    const mods = XML.child(ctrl, "Modules");
    if (mods) {
      for (const m of XML.children(mods, "Module")) {
        const ports = [];
        const portsNode = XML.child(m, "Ports");
        if (portsNode) {
          for (const p of XML.children(portsNode, "Port")) {
            const bus = XML.child(p, "Bus");
            ports.push({
              id: XML.attr(p, "Id"), address: XML.attr(p, "Address"),
              type: XML.attr(p, "Type"), upstream: XML.attr(p, "Upstream") === "true",
              hasBus: !!bus,
              bus: bus ? { size: XML.attr(bus, "Size") || null } : null
            });
          }
        }
        const commsNode = XML.child(m, "Communications");
        let communications = null;
        const ioImages = { input: null, output: null, config: null };
        if (commsNode) {
          communications = {
            method: XML.attr(commsNode, "CommMethod"),
            primCxnInputSize: XML.attr(commsNode, "PrimCxnInputSize"),
            primCxnOutputSize: XML.attr(commsNode, "PrimCxnOutputSize"),
            secCxnInputSize: XML.attr(commsNode, "SecCxnInputSize"),
            connections: []
          };
          const cfg = XML.child(commsNode, "ConfigTag");
          if (cfg) {
            const data = XML.child(cfg, "Data");
            ioImages.config = data && XML.attr(data, "Format") === "Decorated" ? parseDecoratedTree(data) : null;
          }
          const conns = XML.child(commsNode, "Connections");
          if (conns) {
            for (const c of XML.children(conns, "Connection")) {
              const conn = { name: XML.attr(c, "Name"), rpi: XML.attr(c, "RPI"),
                type: XML.attr(c, "Type"), input: null, output: null };
              const it = XML.child(c, "InputTag"), ot = XML.child(c, "OutputTag");
              if (it) {
                const data = XML.child(it, "Data");
                if (data && XML.attr(data, "Format") === "Decorated") conn.input = parseDecoratedTree(data);
                else if (data) conn.input = { name: "", dataType: "", dimension: 0, radix: null, hidden: false, externalAccess: null, description: null, children: null, value: XML.textOf(data), elements: null };
              }
              if (ot) {
                const data = XML.child(ot, "Data");
                if (data && XML.attr(data, "Format") === "Decorated") conn.output = parseDecoratedTree(data);
                else if (data) conn.output = { name: "", dataType: "", dimension: 0, radix: null, hidden: false, externalAccess: null, description: null, children: null, value: XML.textOf(data), elements: null };
              }
              communications.connections.push(conn);
              if (conn.input && !ioImages.input) ioImages.input = conn.input;
              if (conn.output && !ioImages.output) ioImages.output = conn.output;
            }
          }
        }
        model.modules.push({
          name: XML.attr(m, "Name") || "",
          catalogNumber: XML.attr(m, "CatalogNumber") || "",
          vendor: XML.attr(m, "Vendor"), productType: XML.attr(m, "ProductType"),
          productCode: XML.attr(m, "ProductCode"), major: XML.attr(m, "Major"),
          minor: XML.attr(m, "Minor"),
          parentModule: XML.attr(m, "ParentModule") || "",
          parentModPortId: XML.attr(m, "ParentModPortId") || "",
          inhibited: XML.attr(m, "Inhibited") === "true",
          majorFault: XML.attr(m, "MajorFault") === "true",
          keying: XML.child(m, "EKey") ? (XML.attr(XML.child(m, "EKey"), "State") || "") : "",
          ports: ports, communications: communications, ioImages: ioImages
        });
      }
    }

    // Tags
    function parseTag(t, program) {
      const rec = {
        name: XML.attr(t, "Name") || "",
        tagType: XML.attr(t, "TagType") || "Base",
        dataType: XML.attr(t, "DataType") || "",
        dimension: parseInt(XML.attr(t, "Dimensions") || "0", 10) || 0,
        radix: XML.attr(t, "Radix") || null,
        constant: XML.attr(t, "Constant") === "true",
        externalAccess: XML.attr(t, "ExternalAccess") || null,
        description: XML.textOf(XML.child(t, "Description")) || null,
        aliasFor: XML.attr(t, "AliasFor") || null,
        program: program || null, initial: null
      };
      const data = XML.child(t, "Data") || XML.child(t, "DefaultData");
      if (data) {
        const fmt = XML.attr(data, "Format");
        if (fmt === "Decorated") rec.initial = { format: "Decorated", tree: parseDecoratedTree(data) };
        else rec.initial = { format: fmt || "L5K", text: XML.textOf(data) };
      }
      return rec;
    }
    const ctags = XML.child(ctrl, "Tags");
    if (ctags) for (const t of XML.children(ctags, "Tag")) model.tags.controller.push(parseTag(t));

    // Programs
    const progs = XML.child(ctrl, "Programs");
    if (progs) {
      for (const p of XML.children(progs, "Program")) {
        const pname = XML.attr(p, "Name") || "";
        const ptags = [];
        const tagsNode = XML.child(p, "Tags");
        if (tagsNode) for (const t of XML.children(tagsNode, "Tag")) ptags.push(parseTag(t, pname));
        model.tags.programs[pname] = ptags;
        const routines = [];
        const routs = XML.child(p, "Routines");
        if (routs) {
          for (const r of XML.children(routs, "Routine")) routines.push(parseRoutineElement(r));
        }
        model.programs.push({
          name: pname,
          mainRoutineName: XML.attr(p, "MainRoutineName") || null,
          disabled: XML.attr(p, "Disabled") === "true",
          useAsFolder: XML.attr(p, "UseAsFolder") === "true",
          description: XML.textOf(XML.child(p, "Description")) || null,
          routines: routines
        });
      }
    }

    // Tasks
    const tasks = XML.child(ctrl, "Tasks");
    if (tasks) {
      for (const t of XML.children(tasks, "Task")) {
        const task = {
          name: XML.attr(t, "Name") || "", type: XML.attr(t, "Type") || "",
          priority: XML.attr(t, "Priority"), rate: XML.attr(t, "Rate"),
          watchdog: XML.attr(t, "Watchdog"), programs: []
        };
        const sp = XML.child(t, "ScheduledPrograms");
        if (sp) for (const s of XML.children(sp, "ScheduledProgram")) {
          const n = XML.attr(s, "Name"); if (n) task.programs.push(n);
        }
        model.tasks.push(task);
      }
    }

    // Add-On Instructions (full definitions: parameters, local tags, routines)
    const aois = XML.child(ctrl, "AddOnInstructionDefinitions");
    if (aois) {
      for (const a of XML.children(aois, "AddOnInstructionDefinition")) {
        const params = [];
        const ps = XML.child(a, "Parameters");
        if (ps) for (const pr of XML.children(ps, "Parameter")) {
          params.push({
            name: XML.attr(pr, "Name") || "",
            tagType: XML.attr(pr, "TagType") || "Input",
            dataType: XML.attr(pr, "DataType") || "",
            dimension: XML.attr(pr, "Dimension") || "0",
            usage: XML.attr(pr, "Usage") || "",
            radix: XML.attr(pr, "Radix") || null,
            constant: XML.attr(pr, "Constant") === "true",
            required: XML.attr(pr, "Required") === "true",
            visible: XML.attr(pr, "Visible") !== "false",
            description: XML.textOf(XML.child(pr, "Description")) || null
          });
        }
        const localTags = [];
        const lt = XML.child(a, "LocalTags");
        if (lt) {
          for (const t of XML.children(lt, "LocalTag").concat(XML.children(lt, "Tag"))) {
            localTags.push(parseTag(t, "aoi:" + (XML.attr(a, "Name") || "")));
          }
        }
        const routines = [];
        const ar = XML.child(a, "Routines");
        if (ar) for (const r of XML.children(ar, "Routine")) routines.push(parseRoutineElement(r));
        // custom properties + additional help text (documentation carried in AOIs)
        const customProperties = [];
        const cp = XML.child(a, "CustomProperties");
        if (cp) for (const p of XML.children(cp, "CustomProperty")) {
          customProperties.push({ name: XML.attr(p, "Name") || "", value: XML.attr(p, "Value") || "" });
        }
        const helpText = XML.textOf(XML.child(a, "AdditionalHelpText")) || null;
        model.addOnInstructions.push({
          name: XML.attr(a, "Name") || "",
          description: XML.textOf(XML.child(a, "Description")) || null,
          revision: XML.attr(a, "Revision") || null,
          revisionExtension: XML.attr(a, "RevisionExtension") || null,
          revisionNote: XML.attr(a, "RevisionNote") || null,
          class: XML.attr(a, "Class") || "Standard",
          vendor: XML.attr(a, "Vendor") || null,
          executePrescan: XML.attr(a, "ExecutePrescan") === "1",
          executePostscan: XML.attr(a, "ExecutePostscan") === "1",
          executeEnableInFalse: XML.attr(a, "ExecuteEnableInFalse") === "1",
          createdDate: XML.attr(a, "CreatedDate") || null,
          createdBy: XML.attr(a, "CreatedBy") || null,
          editedDate: XML.attr(a, "EditedDate") || null,
          editedBy: XML.attr(a, "EditedBy") || null,
          parameters: params,
          localTags: localTags,
          routines: routines,
          customProperties: customProperties,
          helpText: helpText
        });
      }
    }

    // convenience methods bound to this model (UI-facing API)
    model.findRoutine = function (p, r) { return findRoutine(model, p, r); };
    model.findProgram = function (p) { return findProgram(model, p); };
    model.findDataType = function (n) { return findDataType(model, n); };
    model.findModule = function (n) { return findModule(model, n); };
    model.findAoi = function (n) { return model.addOnInstructions.find(function (a) { return a.name === n; }) || null; };
    model.getRoutineIR = function (p, r) { return getRoutineIR(model, p, r); };
    model.irToContent = function (p, r, ir) { return irToContent(model, p, r, ir); };
    model.setRoutineContent = function (p, r, t, c) { return setRoutineContent(model, p, r, t, c); };
    model.discardChanges = function () { return discardChanges(model); };
    model.dirtyRoutines = function () { return dirtyRoutines(model); };
    model.collectOperands = function (c) { return collectOperands(c); };
    return model;
  }

  /* ---------- model helpers ---------- */
  function findRoutine(model, programName, routineName) {
    const p = model.programs.find(function (x) { return x.name === programName; });
    if (!p) return null;
    return p.routines.find(function (r) { return r.name === routineName; }) || null;
  }
  function findProgram(model, programName) {
    return model.programs.find(function (x) { return x.name === programName; }) || null;
  }
  function findDataType(model, name) {
    return model.dataTypes.find(function (d) { return d.name === name; }) || null;
  }
  function findModule(model, name) {
    return model.modules.find(function (m) { return m.name === name; }) || null;
  }

  /* Stage a content change for one routine (used by editors and converters). */
  function setRoutineContent(model, programName, routineName, newType, content) {
    const key = programName + "\x00" + routineName;
    const r = findRoutine(model, programName, routineName);
    if (!r) throw new Error("routine not found: " + programName + "/" + routineName);
    r.content = content;
    r.pendingType = newType;
    model.changes[key] = { program: programName, routine: routineName, type: newType, content: content };
  }
  function discardChanges(model) {
    // not reversible to original bytes from model alone; callers reload instead
    model.changes = {};
    for (const p of model.programs) for (const r of p.routines) r.pendingType = null;
  }
  function dirtyRoutines(model) {
    return Object.keys(model.changes).map(function (k) {
      const c = model.changes[k];
      return c.program + " / " + c.routine + " -> " + c.type;
    });
  }

  /* Parse routine content into an IR using the language modules (lazy require). */
  function getRoutineIR(model, programName, routineName) {
    const r = findRoutine(model, programName, routineName);
    if (!r) throw new Error("routine not found: " + programName + "/" + routineName);
    const kind = r.pendingType || r.type;
    const content = r.content;
    const dep = function (name) {
      if (typeof module !== "undefined" && module.exports) return require("./" + name + ".js");
      return root.L5XStudio;
    };
    if (kind === "RLL") {
      const rp = dep("rll-parse");
      return {
        kind: "lad",
        rungs: (content.rungs || []).map(function (rg) {
          let rootBranch;
          try { rootBranch = rp.parseRllRung(rg.text || ""); }
          catch (e) { rootBranch = { kind: "series", items: [] }; }
          return { id: null, number: rg.number, type: rg.type || "N", comment: rg.comment, root: rootBranch, text: rg.text };
        })
      };
    }
    if (kind === "ST") {
      const sp = dep("st-parse");
      return sp.parseSt(content.text || "");
    }
    if (kind === "FBD") {
      const fp = dep("fbd-parse");
      try { return fp.parseFbdXml(content.xmlText || ""); }
      catch (e) { return { kind: "fbd", sheets: [] }; }
    }
    return null;
  }

  /* Serialize a staged IR back to routine content (for export). */
  function irToContent(model, programName, routineName, ir) {
    const r = findRoutine(model, programName, routineName);
    const kind = (ir && ir.kind) || (r && (r.pendingType || r.type));
    const dep = function (name) {
      if (typeof module !== "undefined" && module.exports) return require("./" + name + ".js");
      return root.L5XStudio;
    };
    if (kind === "lad") {
      const rs = dep("rll-serialize");
      return {
        kind: "rll",
        rungs: ir.rungs.map(function (rg, i) {
          return {
            number: rg.number !== undefined ? rg.number : i,
            type: rg.type || "N",
            comment: rg.comment || null,
            text: rs.serializeRllRung(rg.root)
          };
        })
      };
    }
    if (kind === "st") {
      const ss = dep("st-serialize");
      return { kind: "st", text: ss.serializeSt(ir) };
    }
    if (kind === "fbd") {
      const fs = dep("fbd-serialize");
      return { kind: "fbd", xmlText: fs.serializeFbdXml(ir) };
    }
    return null;
  }

  /* Arg indexes that are NOT tags (routine names, labels, GSV class/attribute names). */
  var NON_TAG_ARGS = {
    JSR: [0], SBR: [0], RET: [0], JMP: [0], LBL: [0], FOR: [0],
    GSV: [0, 2], SSV: [0, 2]
  };

  /* Collect every operand reference in a staged routine content (for auto-tagging). */
  function collectOperands(content) {
    const refs = new Set();
    const op = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
    function add(arg) {
      if (!arg || typeof arg !== "string") return;
      const p = op.parseOperand(arg);
      if (p.isLiteral || p.isPlaceholder || !p.baseTag) return;
      refs.add(p.baseTag);
    }
    if (content.kind === "rll") {
      for (const rg of content.rungs || []) {
        const txt = rg.text || "";
        const re = /([A-Za-z_][A-Za-z0-9_]*)\(/g;
        let mm;
        while ((mm = re.exec(txt))) {
          const opName = mm[1];
          // find matching close paren
          let depth = 1, j = re.lastIndex;
          let argsTxt = "";
          while (j < txt.length && depth > 0) {
            if (txt[j] === "(") depth++;
            else if (txt[j] === ")") { depth--; if (depth === 0) break; }
            argsTxt += txt[j]; j++;
          }
          const skip = NON_TAG_ARGS[opName] || [];
          const args = argsTxt.split(",");
          for (let ai = 0; ai < args.length; ai++) {
            if (skip.indexOf(ai) !== -1) continue;
            const t = args[ai].trim();
            if (t && t !== "?") add(t.replace(/^"(.*)"$/, "$1"));
          }
        }
      }
    } else if (content.kind === "st") {
      // reuse st parser: walk statements for refs
      const sp = (typeof module !== "undefined" && module.exports) ? require("./st-parse.js") : root.L5XStudio;
      let ir = null;
      try { ir = sp.parseSt(content.text || ""); } catch (e) { /* fall through to regex */ }
      if (ir) {
        const skipFor = function (fn) { return NON_TAG_ARGS[fn] || []; };
        const walkCallArgs = function (fn, args) {
          const skip = skipFor(fn);
          (args || []).forEach(function (a, i) {
            if (a && a.kind === "namedArg") { walkExpr(a.value); return; }
            if (skip.indexOf(i) === -1) walkExpr(a);
          });
        };
        const walkExpr = function (e) {
          if (!e || typeof e !== "object") return;
          if (e.kind === "ref") refs.add(op.parseOperand(e.path).baseTag || e.path);
          else if (e.kind === "call") walkCallArgs(e.fn, e.args);
          else if (e.kind === "unary") walkExpr(e.operand);
          else if (e.kind === "binary") { walkExpr(e.left); walkExpr(e.right); }
          else if (e.kind === "paren") walkExpr(e.inner);
          else if (e.kind === "namedArg") walkExpr(e.value);
        };
        const walkStmt = function (s) {
          if (!s || typeof s !== "object") return;
          if (s.kind === "assign") { add(s.target); walkExpr(s.value); }
          else if (s.kind === "call") { walkCallArgs(s.fn, s.args); }
          else if (s.kind === "if") s.branches.forEach(function (b) { if (b.cond) walkExpr(b.cond); (b.statements || []).forEach(walkStmt); });
          else if (s.kind === "for") { add(s.index); walkExpr(s.from); walkExpr(s.to); if (s.by) walkExpr(s.by); (s.statements || []).forEach(walkStmt); }
          else if (s.kind === "while" || s.kind === "repeat") { walkExpr(s.cond); (s.statements || []).forEach(walkStmt); }
          else if (s.kind === "case") { walkExpr(s.expr); s.cases.forEach(function (c) { c.labels.forEach(walkExpr); (c.statements || []).forEach(walkStmt); }); (s.elseStatements || []).forEach(walkStmt); }
        };
        ir.statements.forEach(walkStmt);
      }
      // fallback regex for unparsable text: identifiers
      if (!ir) {
        const re2 = /[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])*/g;
        let m2;
        while ((m2 = re2.exec(content.text || ""))) {
          if (!/^(IF|THEN|ELSIF|ELSE|END_IF|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|CASE|OF|END_CASE|AND|OR|XOR|NOT|MOD|EXIT|RETURN|TRUE|FALSE)$/.test(m2[0]))
            add(m2[0]);
        }
      }
    }
    return Array.from(refs);
  }

  return { parseL5X: parseL5X, findRoutine: findRoutine, findProgram: findProgram,
    findDataType: findDataType, findModule: findModule, getRoutineIR: getRoutineIR,
    irToContent: irToContent, setRoutineContent: setRoutineContent,
    discardChanges: discardChanges, dirtyRoutines: dirtyRoutines,
    collectOperands: collectOperands, parseMember: parseMember, parseDecoratedTree: parseDecoratedTree };
});
