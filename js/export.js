/* L5X Studio - export.js (Lead). Re-serialize the project to L5X, preserving the original
   bytes everywhere except staged routine changes and auto-declared tags. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const UTIL = (typeof module !== "undefined" && module.exports) ? require("./util.js") : root.L5XStudio;

  function esc(s) { return UTIL.xmlAttrEscape(s); }
  function cdata(s) { return "<![CDATA[" + UTIL.cdataSafe(s) + "]]>"; }

  function buildRoutineElement(routineModel, change) {
    const newType = change.type; // "RLL" | "ST" | "FBD" | "SFC"
    let contentXml = "";
    if (newType === "RLL") {
      const rungs = (change.content && change.content.rungs) || [];
      const parts = rungs.map(function (rg, i) {
        let s = "<Rung Number=\"" + (rg.number !== undefined ? rg.number : i) + "\" Type=\"" + esc(rg.type || "N") + "\">";
        if (rg.comment) s += "<Comment>" + cdata(rg.comment) + "</Comment>";
        let txt = rg.text || "";
        if (txt && !/;\s*$/.test(txt)) txt += ";";
        s += "<Text>" + cdata(txt) + "</Text>";
        s += "</Rung>";
        return s;
      });
      contentXml = "<RLLContent>" + parts.join("\n") + "</RLLContent>";
    } else if (newType === "ST") {
      const text = (change.content && change.content.text) || "";
      const lines = UTIL.splitLines(text);
      const parts = lines.map(function (l, i) {
        return "<Line Number=\"" + i + "\">" + cdata(l) + "</Line>";
      });
      contentXml = "<STContent>" + parts.join("\n") + "</STContent>";
    } else if (newType === "FBD") {
      contentXml = (change.content && change.content.xmlText) || "<FBDContent SheetSize=\"Letter (8.5x11in)\" SheetOrientation=\"Landscape\"></FBDContent>";
      if (contentXml.indexOf("<FBDContent") !== 0) contentXml = "<FBDContent SheetSize=\"Letter (8.5x11in)\" SheetOrientation=\"Landscape\">" + contentXml + "</FBDContent>";
    } else {
      contentXml = (change.content && change.content.xmlText) || "";
    }
    let s = "<Routine Name=\"" + esc(change.routine) + "\" Type=\"" + esc(newType) + "\"";
    // carry over any extra attributes recorded at parse time (kept on the model routine)
    if (routineModel && routineModel.extraAttrs) {
      for (const k of Object.keys(routineModel.extraAttrs)) s += " " + k + "=\"" + esc(routineModel.extraAttrs[k]) + "\"";
    }
    s += ">";
    if (routineModel && routineModel.description) s += "<Description>" + cdata(routineModel.description) + "</Description>";
    s += contentXml;
    s += "</Routine>";
    return s;
  }

  function findProgramSpan(text, programName) {
    const re = new RegExp("<Program\\b[^>]*\\bName=\"" + programName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"[^>]*>");
    const m = re.exec(text);
    if (!m) return null;
    const start = m.index;
    const end = text.indexOf("</Program>", m.index);
    if (end === -1) return null;
    return { start: start, end: end + "</Program>".length, text: text.slice(start, end) };
  }

  function findRoutineSpan(programText, routineName) {
    const re = new RegExp("<Routine\\b[^>]*\\bName=\"" + routineName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"[^>]*>[\\s\\S]*?</Routine>");
    const m = re.exec(programText);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length, match: m[0] };
  }

  function findControllerTagsSpan(text) {
    // controller <Tags> sits between AddOnInstructionDefinitions/Modules and Programs
    let anchor = text.indexOf("</AddOnInstructionDefinitions>");
    if (anchor !== -1) {
      const tagsStart = text.indexOf("<Tags>", anchor);
      if (tagsStart !== -1 && text.indexOf("<Programs>", anchor) > tagsStart) {
        const tagsEnd = text.indexOf("</Tags>", tagsStart);
        if (tagsEnd !== -1) return { start: tagsStart, end: tagsEnd + "</Tags>".length, insertAt: tagsEnd };
      }
    }
    anchor = text.indexOf("</Modules>");
    if (anchor !== -1) {
      const tagsStart = text.indexOf("<Tags>", anchor);
      if (tagsStart !== -1) {
        const tagsEnd = text.indexOf("</Tags>", tagsStart);
        if (tagsEnd !== -1) return { start: tagsStart, end: tagsEnd + "</Tags>".length, insertAt: tagsEnd };
      }
    }
    return null;
  }

  function newTagXml(name, dataType, dimension) {
    dataType = dataType || "DINT";
    dimension = dimension || 0;
    const dimAttr = dimension > 0 ? " Dimensions=\"" + dimension + "\"" : " Dimension=\"" + dimension + "\"";
    return "<Tag Name=\"" + esc(name) + "\" TagType=\"Base\" DataType=\"" + esc(dataType) + "\"" + dimAttr +
      " Radix=\"Decimal\" Constant=\"false\" ExternalAccess=\"Read/Write\"><Data Format=\"L5K\"><![CDATA[0]]></Data></Tag>";
  }

  /* model: parsed model; opts: { autoDeclareTags: bool (default true), indent: bool } */
  function exportL5X(model, opts) {
    opts = opts || {};
    const autoDeclare = opts.autoDeclareTags !== false;
    const warnings = [];
    let text = model.rawText;
    const changes = Object.keys(model.changes || {}).map(function (k) { return model.changes[k]; });

    for (const ch of changes) {
      const programSpan = findProgramSpan(text, ch.program);
      if (!programSpan) {
        warnings.push("Program not found in source text: " + ch.program + " (routine " + ch.routine + " skipped)");
        continue;
      }
      const rSpan = findRoutineSpan(programSpan.text, ch.routine);
      if (!rSpan) {
        warnings.push("Routine not found in source text: " + ch.program + "/" + ch.routine + " (skipped)");
        continue;
      }
      // find the routine model for description
      const prog = model.programs.find(function (p) { return p.name === ch.program; });
      const rModel = prog ? prog.routines.find(function (r) { return r.name === ch.routine; }) : null;
      if (rModel && rModel.content && rModel.content.kind === "encrypted") {
        warnings.push("Routine " + ch.program + "/" + ch.routine + " is source-protected; change skipped");
        continue;
      }
      const replacement = buildRoutineElement(rModel, ch);
      const absStart = programSpan.start + rSpan.start;
      const absEnd = programSpan.start + rSpan.end;
      text = text.slice(0, absStart) + replacement + text.slice(absEnd);
    }

    if (autoDeclare && changes.length) {
      // collect operand refs from staged routines
      const OP = (typeof module !== "undefined" && module.exports) ? require("./operands.js") : root.L5XStudio;
      const RES = (typeof module !== "undefined" && module.exports) ? require("./resolve.js") : root.L5XStudio;
      const refs = new Set();
      const moduleNames = new Set((model.modules || []).map(function (m) { return m.name; }));
      for (const ch of changes) {
        for (const b of model.collectOperands(ch.content)) {
          if (b.indexOf(":") !== -1) continue;          // module tags
          if (OP.isLiteral(b)) continue;
          if (moduleNames.has(b)) continue;              // GSV object names etc. are not tags
          const rec = RES.findTagRecord(model, b, { program: ch.program });
          if (!rec) refs.add(b);
        }
      }
      if (refs.size) {
        const tagsSpan = findControllerTagsSpan(text);
        const tagXml = Array.from(refs).map(function (n) {
          warnings.push("Auto-declared controller-scope tag: " + n + " (DINT)");
          return newTagXml(n, "DINT", 0);
        }).join("\n");
        if (tagsSpan) {
          text = text.slice(0, tagsSpan.insertAt) + tagXml + "\n" + text.slice(tagsSpan.insertAt);
        } else {
          // create a Tags section after </Modules> or </AddOnInstructionDefinitions>
          let anchor = text.indexOf("</AddOnInstructionDefinitions>");
          if (anchor === -1) anchor = text.indexOf("</Modules>");
          if (anchor === -1) anchor = text.indexOf("</DataTypes>");
          if (anchor !== -1) {
            anchor = text.indexOf(">", anchor) + 1;
            const section = "<Tags>\n" + tagXml + "\n</Tags>";
            text = text.slice(0, anchor) + section + text.slice(anchor);
          } else {
            warnings.push("Could not locate a Tags section; auto-declared tags were NOT inserted: " + Array.from(refs).join(", "));
          }
        }
      }
    }
    return { text: text, warnings: warnings };
  }

  return { exportL5X: exportL5X, buildRoutineElement: buildRoutineElement,
    findProgramSpan: findProgramSpan, findRoutineSpan: findRoutineSpan };
});
