/* DEMO (Lead): "Add one more pusher (GROUP21) to SAMPLE_RLL.L5X" — worked example.
   Uses ONLY the same public modules and code paths the L5X Studio UI runs, so every
   step here maps 1:1 to a click in the app. The one step the app does not own
   (adding the physical I/O module to the I/O tree) is done as a labeled raw-XML edit,
   which is exactly what Studio 5000's I/O configuration writes into the L5X.

   Run: node demo/add-pusher-21.js
   Output: demo/SAMPLE-project-modified.L5X  (validate externally, e.g. with the .NET XML parser)
*/
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));
const irApi = JS("ir.js");
const modelApi = JS("l5x-model.js");
const ioMapApi = JS("io-map.js");
const exportApi = JS("export.js");

const SRC = process.env.L5X_STUDIO_SAMPLE_RLL || "C:/path/to/controller.L5X";
const OUT = path.join(__dirname, "SAMPLE-project-modified.L5X");
let raw = fs.readFileSync(SRC, "utf8");

/* ------------------------------------------------------------------ *
 * STEP 1 (Studio 5000 / hand-edit): add the physical I/O module GROUP21.
 * The app reads Modules but has no module editor, so this is the step
 * done in Logix Designer's I/O tree — or, as shown here, by cloning the
 * GR20 module element and changing its Name + IP address. Because L5X
 * Studio's export preserves every untouched byte, a hand-edit like this
 * survives export untouched.
 * ------------------------------------------------------------------ */
const gr20Start = raw.indexOf('<Module Name="GR20"');
const gr20End = raw.indexOf("</Module>", gr20Start) + "</Module>".length;
const gr20Xml = raw.slice(gr20Start, gr20End);
const gr21Xml = gr20Xml
  .replace('Name="GR20"', 'Name="GROUP21"')
  .replace("192.168.1.70", "192.168.1.71");
raw = raw.slice(0, gr20End) + "\n" + gr21Xml + raw.slice(gr20End);
console.log("step 1 ok: GROUP21 module definition inserted (clone of GR20, new IP 192.168.1.71)");

/* ------------------------------------------------------------------ *
 * STEP 2 (L5X Studio): open the project, go to IO_MASTER_MAPPER.
 * ------------------------------------------------------------------ */
const model = modelApi.parseL5X(raw);
model.fileName = "SAMPLE_RLL.L5X";
const PROG = "IO_MASTER_MAPPER";

/* ------------------------------------------------------------------ *
 * STEP 3: in the Routine tab -> Editor, append the output-mapping rung.
 * In the UI this is: select ENET_PUSHER_OUTPUTS, click the "+" at the
 * bottom of the editor, and type the new rung (or clone rung 20 and
 * change GR20 -> GROUP21).
 * ------------------------------------------------------------------ */
{
  const ir = modelApi.getRoutineIR(model, PROG, "ENET_PUSHER_OUTPUTS");
  const newRung = irApi.makeRung(
    irApi.makeParallel([
      irApi.makeSeries([
        irApi.makeInstr("ADD", "PUSHER_IO_TMP", "1", "PUSHER_IO_TMP"),
        irApi.makeInstr("MOV", "ENET_OUTPUTS[PUSHER_IO_TMP]", "GROUP21:O.Data")
      ])
    ]),
    { number: ir.rungs.length, comment: "GROUP21 pusher output word (added with L5X Studio)" }
  );
  ir.rungs.push(newRung);
  const content = modelApi.irToContent(model, PROG, "ENET_PUSHER_OUTPUTS", ir);
  model.setRoutineContent(PROG, "ENET_PUSHER_OUTPUTS", "RLL", content);
  console.log("step 3 ok: rung appended to ENET_PUSHER_OUTPUTS ->",
    JSON.stringify(content.rungs[content.rungs.length - 1].text));
}

/* ------------------------------------------------------------------ *
 * STEP 4: same for the input mapping (MOV word in + GSV fault code).
 * ------------------------------------------------------------------ */
{
  const ir = modelApi.getRoutineIR(model, PROG, "ENET_PUSHER_INPUTS");
  const newRung = irApi.makeRung(
    irApi.makeParallel([
      irApi.makeSeries([
        irApi.makeInstr("ADD", "PUSHER_IO_TMP", "1", "PUSHER_IO_TMP"),
        irApi.makeInstr("ADD", "DIS_CURR_NODE", "1", "DIS_CURR_NODE"),
        irApi.makeInstr("MOV", "GROUP21:I.Data", "ENET_INPUTS[PUSHER_IO_TMP]"),
        irApi.makeInstr("GSV", "Module", "GROUP21", "FaultCode", "ENET_DEVICE_STATUS[DIS_CURR_NODE]")
      ])
    ]),
    { number: ir.rungs.length, comment: "GROUP21 pusher input word + fault code (added with L5X Studio)" }
  );
  ir.rungs.push(newRung);
  const content = modelApi.irToContent(model, PROG, "ENET_PUSHER_INPUTS", ir);
  model.setRoutineContent(PROG, "ENET_PUSHER_INPUTS", "RLL", content);
  console.log("step 4 ok: rung appended to ENET_PUSHER_INPUTS ->",
    JSON.stringify(content.rungs[content.rungs.length - 1].text));
}

/* ------------------------------------------------------------------ *
 * STEP 5: Export L5X (UI: header button "Export L5X").
 * ------------------------------------------------------------------ */
const res = exportApi.exportL5X(model, {});
fs.mkdirSync(__dirname, { recursive: true });
fs.writeFileSync(OUT, res.text, "utf8");
console.log("step 5 ok: exported", OUT, "(" + (res.text.length / 1048576).toFixed(2) + " MB)");
console.log("          export warnings:", res.warnings.length ? res.warnings : "none");

/* ------------------------------------------------------------------ *
 * STEP 6: Verify in the app's own I/O Map — resolve the new tags to
 * physical points. (In the UI: I/O Map tab, type GROUP21:O.Data.)
 * ------------------------------------------------------------------ */
const m2 = modelApi.parseL5X(res.text);
for (const operand of ["GROUP21:O.Data", "GROUP21:I.Data", "ENET_OUTPUTS[PUSHER_IO_TMP]"]) {
  const pt = ioMapApi.resolveIoPoint(m2, operand, { program: PROG });
  if (pt.ok) {
    const p = pt.point;
    console.log("verify: " + operand + " ->", p.moduleName, "|", p.catalogNumber, "|",
      p.direction, "|", p.memberPath, "|", p.rack + "/" + p.slotOrPort);
  } else {
    console.log("verify: " + operand + " -> (not an I/O point: " + pt.error + ")");
  }
}
// also confirm the new rungs are in the exported file
const rOut = modelApi.findRoutine(m2, PROG, "ENET_PUSHER_OUTPUTS");
const rIn = modelApi.findRoutine(m2, PROG, "ENET_PUSHER_INPUTS");
console.log("verify: ENET_PUSHER_OUTPUTS now has", rOut.content.rungs.length, "rungs (was 21)");
console.log("verify: ENET_PUSHER_INPUTS now has", rIn.content.rungs.length, "rungs (was 21)");
console.log("verify: last output rung ->", rOut.content.rungs[rOut.content.rungs.length - 1].text);
console.log("verify: last input rung  ->", rIn.content.rungs[rIn.content.rungs.length - 1].text);
