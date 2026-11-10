# Conveyor Design Studio — implementation contract

## v3 additions (merges + transfer devices)

- **Merge junctions** (`design.merges[]`): a spur line (its own chain, `newChain:true`
  segments) feeds a main-line zone. `computeDesign()` resolves
  `{mergeZoneIndex1Based, spurZoneIndex1Based, gapM, priority}`; the generated L5X contains a
  per-merge arbitration routine that alternates release between the spur and the main line
  (priority `alternate|main|spur`) using the ZPA downstream-ready bits, with a throat-plate
  warning when the spur end is not at the merge point. Drawing shows a rounded Y-throat.
- **Pushers** (`type:"pusher"`): one-way divert with extend/retract solenoids, limit switches
  and a divert window — the classic pusher option.
- **Rotary tables** (`type:"rotary_table"`): **bidirectional** routers — CW/CCW rotation,
  home + 90/180/270 position interlocks, brake release; generated logic picks the shortest
  rotation direction to the next position.
- **Cross-belt pop-up transfers** (`type:"popup_transfer"`): **bidirectional** cross transfers
  — raise/lower, LEFT and RIGHT belt outputs, side-clear interlocks, per-transfer belt count
  and raise timing.
- Every transfer gets its own 1799ER I/O block (standard bit maps in
  `transferInputMap(type)` / `transferOutputMap(type)`), sequential IPs after the ZPA blocks,
  BOM line items (pneumatic pusher kit, turntable assembly/drive/position sensors, cross-belt
  modules/lift/drive/sensors), generated device logic routines, simulator command buttons and
  HMI glyphs. `totals` exposes merges/transfers/pushers/rotaryTables/popupTransfers/
  bidirectionalTransfers/deviceBlocks.

---

## v2 additions (curves, spirals, belts, tracking)

The design model (`js/conveyor/model.js`, v2) now supports:

- **Chained geometry with rounded joints.** Segments connect end-to-start; a `turnDeg` on a
  segment rotates the heading at the joint. `computeDesign()` returns `segments[].leftEdge`
  and `segments[].rightEdge` — offset polylines generated with **round joins**, so a conveyor
  that changes direction by an angle gets a rounded outer edge instead of two overlapping
  rectangles (the previous overlay bug). `joints[]` carries `{turnDeg, filletRadiusM,
  rounded, betweenSegments}`.
- **Curved segments with standardised tapered rollers.** `kind:"curve"` is a true arc
  (`radiusM`, `curveDeg`); the turning radius is set by the tapered roller, which is a
  frustum: `R = (W/2)·(D_out+D_in)/(D_out−D_in) = W·D_avg/delta`, cone half angle
  `tan(α) = delta/(2W)`. Tapers are standardised, so radii are quantised:
  `TAPER_STANDARDS` (TS-06 … TS-26 = 6…26 mm delta on PM486FS / Microroll TS rollers) and
  `standardCurveRadii(widthM)` give the standard radii for a face width. A requested radius
  is reported against the nearest standard taper (`segments[].taper`) with the deviation;
  curved zones are marked `rollerType:"tapered"` and counted in
  `totals.taperedRollerCount`. Non-standard radii and infeasible tapers are validation
  warnings/errors. Down-spirals require braking rollers (roller-configurator rule).
- **Spiral segments (up/down).** `kind:"spiral"` is an inclined helix: `radiusM`,
  `spiral:{pitchM, heightM, direction}`, swept turns = height/pitch, slope =
  `atan(pitch/(2πR))`. Limits: pitch 0.15–2 m, slope ≤ 18°, height ≤ 25 m; slopes above 10°
  recommend a belt conveyor. Spiral zones are generated from the helix length; `z` coordinates
  and `bounds.zRange` expose the rise for the 2D (height badges) and 3D (helix) views.
- **Belt conveyors.** `design.conveyorType = "belt"` (or per segment): no tapered rollers;
  `defaults.belt` describes belt type/width, pulleys, drive (PowerFlex 525), speed and belt
  tracking sensors. The L5X generator emits a belt-drive control section (and can embed the
  Dvc_PF525 AOI library) instead of per-zone ZPA scan routines; the BOM covers belt, pulleys,
  drive and scanners.
- **Scan zones + barcode tray tracking.** `scanZones[]` (segmentId, offsetM, type
  barcode/camera, side) resolve to world positions and zone/sensor bits; `tracking`
  (`enabled, maxTrays, barcodeLen, trayLengthM, trayGapM, tagPrefix`) produces
  `computed.tracking.zones[]` with track slots. The generated L5X contains a `TRAY_TRACK` UDT,
  a `TRACK_TBL` array, per-scanner `<SCAN>_BARCODE` tags and tracking routines
  (TRACK_INIT / TRACK_MOVE / TRACK_SCAN / TRACK_CLEAR) wired into Main; the HMI page shows a
  live tray-tracking table and scanner markers.

Teammate workstreams T-D/T-E/T-F above were extended for these features (see the messages):
2D/3D rendering of rounded edges, tapered rollers, spirals, belts, scanners and tracking
labels; BOM for tapered rollers/belt/pulleys/scanners; L5X/HMI generation for belt drives and
barcode tracking.

---

Goal: an in-browser conveyor configurator — draw a conveyor (2D + 3D), pick components
modularly, and generate a **bill of materials**, an **L5X control program** and a
**graphics/HMI program**, all from templates of real projects (per the user's direction:
reuse the AOI library / template examples from the existing files so the work is mostly
integration).

Read first: `l5x-studio/js/conveyor/model.js`
(**the shared design model — already implemented, do not edit**), and
All new modules must be classic
scripts (UMD factory), work in browser (flat `L5XStudio` namespace) and in Node (`require`).

Reference material (read-only):
- a site ZPA conveyor project export (`L5X`): UDTs `ZPA`,
  `ZPA_CONFIG`, `CONFIG_ZPA`, `ZPA_MERGE`, `NETWORKS`, `GFX`; program `HARD_CODE_ZPA` with
  template routines `ZPA1_2ZONE_SCAN_ZONE` … `ZPA1_8ZONE_SCAN_ZONE`, `ZPA_MAIN`,
  `ZPA_MAPPING`, `ZPA_MAPPING_GET_OFFSET`, `ZPA_TIMER_CONFIG`, `ZPA_SCAN_ZONE_VARS`,
  `ZPA_SCAN_ZONE_VARS_ONE_BACK`, `ACK_JAMS_ZPA`, `CUSTOM_CODE_ZPA_BITS`, `INIT_ZPA_STATUS`,
  `ENET_ZPA_INPUTS`, `ENET_ZPA_OUTPUTS`; module template `1799ER-IQ10XOQ10/A`
  (see module `PDP`/`GROUP01`), controller `Local` module (1756-L83E).
- the in-house roller part-number generator (internal tool) — roller
  part-number configurator: `ROLLER_DB`, `SERIES_SPECS`, `DRIVER_CARDS`, `MU_TABLE`,
  `buildItohPart/buildMicrorollPart/buildInfiniDrivePart`, `validateRoller`,
  `findClosestSpeedCode`, `compatibleCardsForSeries` (attribution: Microroll/InfiniDrive/
  Itoh Denki data community tool).
- the site master parts list spreadsheet — parts
  catalog (sheet "site master parts list": NSN, P/N, OEM, CAGE, DESCRIPTION,
  TYPE, unit costs…; the site group-code sheet, 87 rows with PSN/description/BOH…).
- `repo-analysis/LogixLibraries/**` — AOI+UDT L5X exports for the AOI library (e.g.
  `src/Device/Generic/Dvc_DiscreteIn_AOI.L5X`, `Dvc_DiscreteOut_AOI.L5X`,
  `Dvc_Stacklight_AOI.L5X`, `src/Device/Rockwell/PowerFlex 525/Dvc_PF525_AOI.L5X`).

The design model (`js/conveyor/model.js`) already provides:
`createDefaultDesign()`, `computeDesign(design) -> {segments[], zones[], groups[], blocks[],
totals, bounds, warnings}`, `validateDesign()`, `segmentPolyline()`, `polylineLength()`,
`pointAtDistance()`, `addSegment/updateSegment/removeSegment`, `designToJson/designFromJson`,
`sanitizeName`.
**ZPA group semantics (verified against the site ZPA project):** one `NETS[1].ZPA[g]` UDT instance is a
*zone group* of up to 8 zones; one 1799ER block's 16-bit word serves that whole group
(input bits 0..7 = the 8 zone sensors, remaining bits = handshakes; output bits 0..7 = run
commands). Segments longer than 8 zones are split into consecutive groups automatically;
each group gets one block (`ZPA01..`, sequential IPs) and one scan routine instantiated from
the matching `ZPA1_<n>ZONE_SCAN_ZONE` template (1-zone groups pad to the 2-zone template).
`computed.groups[]` exposes `{index1Based, segmentName, zoneCount, zoneIndexes1Based,
blockName, ip, templateZones}`; zones carry `groupIndex1Based`, `zoneInGroup1Based`,
`sensorBit`/`motorBit`. the site project's `ZPA_MAPPING` loops groups via `NUM_OF_ZPA_NODES`, and
`ZPA_MAIN` JSRs one scan routine per group — generated projects follow the same pattern,
with a generated init routine setting `NETS[1].NUM_OF_ZPA_NODES`, `CONFIG_ZPA.NUM_OF_ZONES`,
`ENET_OFFSET`, `FIRST_ADDR`, and `SENSOR_IO` so the logic runs without HMI configuration.

Node test runner:
`"C:/samples/sample-file" test/<file>.js`

---

## T-D "conveyor-2d3d" — drawing editor + 3D renderer

Own files: `js/conveyor/designer2d.js`, `js/conveyor/render3d.js`,
`test/t6-conveyor-view.test.js`.

### `js/conveyor/designer2d.js`
- `ConveyorDesigner2D({ container, design, onChange(design), onSelect(sel) })` class:
  - renders into a `<canvas>` appended to `container`; uses `computeDesign(design)`.
  - Draw: grid, each segment as a rectangle strip along its polyline (width from design),
    zone divider lines, zone index labels, sensor markers (small circle at zone start),
    motor marker (square at zone centre), segment name label, selection highlight
    (colour per segment), bounds-fit zoom.
  - Interactions: click = select segment (and zone under cursor; `onSelect({kind:
    "segment"|"zone", segmentId, zoneIndex})`); drag segment = move (updates x/y via
    `model.updateSegment`, calls `onChange(newDesign)`); wheel = zoom; middle/space-drag or
    background-drag = pan; Del/Backspace = delete selected segment (call
    `model.removeSegment` + onChange). Cursor position readout optional.
  - Methods: `setDesign(design)`, `redraw()`, `zoomToFit()`, `getView()` (scale/offset),
    `destroy()`.
- Pure exports for Node tests (no DOM): `worldToScreen(view, pt)`, `screenToWorld(view, pt)`,
  `hitTestSegment(computed, worldPt)`, `hitTestZone(computed, worldPt)`,
  `renderScene(ctx, computed, opts)` — ctx is any object with canvas-2D methods
  (fillRect/beginPath/moveTo/lineTo/stroke/fill/arc/save/restore/translate/rotate/
  setTransform/clearRect/fillText/fillStyle/strokeStyle/lineWidth/font/textAlign etc.).

### `js/conveyor/render3d.js`
- WebGL 3D view: `Conveyor3D({ container, design })` class with `render()`,
  `setDesign(design)`, `dispose()`, orbit camera (drag = rotate, wheel = zoom, right-drag =
  pan). Draw: conveyor frame (two side rails as boxes), roller cylinders across the width at
  `rollerPitchM` spacing, legs every 1.5 m, zone sensors (small boxes), motor marker, plus
  coloured zone floor panels. Lighting: simple directional + ambient in the shader.
  Keep geometry generation pure: `buildConveyorGeometry(computed, opts) -> {positions,
  normals, indices, colors}` (collected per part) and matrix helpers
  `mat4Identity/mat4Multiply/mat4Translate/mat4RotateX/mat4RotateY/mat4Scale/
  mat4Perspective/mat4LookAt` exported; WebGL contexts must be feature-detected so
  `require()` in Node is safe (constructor guarded, methods no-op without WebGL).
- Test: matrix math identities/inverses (multiply + lookAt sanity), geometry builder counts
  (rolls per segment ≈ ceil(length/rollerPitch)+1, 2 rails per segment, legs ≥ 2), 2D
  hit-testing with synthetic design, `renderScene` against a recording stub ctx (asserts
  fillText/stroke called and no throw), designer/3D constructors Node-safe.

---

## T-E "conveyor-parts" — component selection, part numbers, BOM

Own files: `tools/build-parts-catalog.py` (or .js), `js/data/parts-catalog.js` (generated),
`js/conveyor/parts.js`, `test/t7-conveyor-parts.test.js`.

### Roller/driver data + part numbers (`js/conveyor/parts.js`)
Port the data and algorithms from the in-house roller part-number configurator (keep the exact
part-number formats and the compatibility rules):
- Data: `ROLLER_DB` (array of {psn,pn,desc,boh,status,speed,len,grooved,braking,tapered,
  idealFrame,repl,brand…}), `SERIES_SPECS`, `DRIVER_CARDS`, `MU_TABLE`, `BRANDS`.
- Functions: `parseSeries(pn)`, `getRollerByPn(pn)`, `rollerBrand(pn)`,
  `compatibleCardsForSeries(series, isBrake)`, `isBrakeRoller(r)`,
  `findClosestSpeedCode(model, targetFpm)`, `buildItohPart(inp, derived, vfpm)`,
  `buildMicrorollPart(...)`, `buildInfiniDrivePart(inp)`, `validateRoller(roller, inp, derived)`,
  `calcDerived(inp)` (roller body, friction, tangential force, torque), `lroller(inp)`.
- Convenience: `recommendRoller(spec)` where spec = {widthM, zoneLengthM, targetFpm,
  application, env, driveStyle, packageMaterial, weightPerFtLbs, curveDeg}; returns
  {roller, partNumber, brand, driverCard, speedCode, warnings[]}. Map metric design inputs
  (m) to the tool's imperial fields (inches/fpm) and document the mapping.

### Parts catalog (`tools/build-parts-catalog.*` + `js/data/parts-catalog.js`)
- Build script reads the spreadsheet (Python: `python`
  with openpyxl; write `tools/build-parts-catalog.py`) and emits a classic script
  `js/data/parts-catalog.js` assigning `root.L5XStudio.PARTS_CATALOG = {parts:[{pn,nsn,oem,
  cage,description,type,unitCostLocal,unitCostOnline}], siteParts:[{psn,description,boh,
  commCode,replacementPsn}], generatedAt}` (browser) / `module.exports` (Node).
- `js/conveyor/parts.js` also exports `lookupPart(pn)`, `searchParts(query)`,
  `describePart(pn)`, `catalogStats()` operating on `L5XStudio.PARTS_CATALOG` (lazy access).

### Component selection + BOM
- `selectComponents(design, computed, opts) -> { zones:[{zoneIndex, segmentName,
  zoneName, rollerSeries, rollerPn, rollerDesc, motorized: true, driverCard, driverDesc,
  sensorPn, sensorDesc, blockName, blockCatalog, cable, warnings[]}], segmentRollers:
  [{segmentName, idleRollerPn, idleCount, motorizedCount}], warnings: [] }`
  Rules: one motorized roller per zone (+ driver card matched to motor wattage/series);
  idle rollers = ceil(zoneLength/rollerPitch)+1 per zone (one of them motorized); sensors per
  zone; I/O block per zone from `computed.blocks`; cables per zone. Roller choice uses
  `recommendRoller` with series/application defaults; errors when no compatible card found.
- `buildBom(design, computed, selections, opts) -> { rows:[{category:"Rollers"|"Driver
  cards"|"Sensors"|"I/O"|"Cabling"|"Power"|"Mechanical", pn, description, qty, unitCost,
  extended, source:"roller-db"|"parts-catalog"|"estimate"}], totals:{byCategory, grandTotal,
  currency:"USD"}, warnings:[] }` — group identical P/Ns; unit costs from catalog
  (`lookupPart`) when found, else estimated defaults with `source:"estimate"`.
- `bomToCsv(rows) -> string` (RFC4180) and `bomToMarkdown(rows, totals)`.
- Test: part-number builders produce the documented formats (`PM486FE-…`, `MR-…`,
  `RC A DU42 …`) for sample specs; validateRoller rejects mismatched frame/taper/brake;
  recommendRoller returns a card; BOM for a 2-segment/6-zone design has expected counts
  (6 motorized rollers, 6 cards, 6 sensors, 6 blocks, idle roller qty > 0) and totals add up;
  catalog script loads with >600 parts; CSV round-trip.

---

## T-F "conveyor-gen" — template extraction, L5X generator, HMI generator

Own files: `tools/extract-conveyor-templates.js`, `js/data/conveyor-templates.js` (generated),
`js/conveyor/l5xgen.js`, `js/conveyor/hmi.js`, `test/t8-conveyor-gen.test.js`.

### Template extractor (dev-time, Node)
`tools/extract-conveyor-templates.js <the ZPA project.L5X> <outFile>` parses the ZPA project with
`l5x-studio/js/l5x-model.js` + `js/xml.js` and writes `js/data/conveyor-templates.js`
(classic script + module.exports) containing:
- `udts`: XML strings for `ZPA`, `ZPA_CONFIG`, `CONFIG_ZPA`, `ZPA_MERGE`, `NETWORKS`, `GFX`
  (verbatim `<DataType …>…</DataType>` XML from the ZPA project) — keep attributes/order untouched.
- `routines`: map name -> {type:"RLL", description, rungs:[{number,type,comment,text}]} for
  the ZPA template routines listed above (all 7 zone-count variants + support routines).
- `moduleTemplate`: one 1799ER module XML string (`PDP` clone basis, Name/IP replaced by the
  generator; keep CatalogNumber/EKey/Ports/Communications/ConfigTag/InputTag/OutputTag).
- `localModule`: the controller `Local` module XML string from the ZPA project (basis for controller
  export; generator replaces Name/ProcessorType/revision).
- `tagTemplates`: XML strings for controller tags used by the templates: `CONFIG_ZPA`,
  `ENET_INPUTS`, `ENET_OUTPUTS`, `ENET_DEVICE_STATUS`, `ZPA_MERGE`, `GFX` and scalar temps
  (`ZPA_IO_TMP`, `MAP_OFFSET_INT`, `ZPA_NDX`, `STOP_JOG_ONE_SHOT`, …) — from the ZPA project
  `<Controller><Tags>`; generator adjusts Dimensions/values as needed.
- `aoiLibrary`: for each selected LogixLibraries AOI file (DiscreteIn, DiscreteOut,
  Stacklight, PF525): {name, description, xmlAoi (the `<AddOnInstructionDefinition>` XML),
  xmlDataTypes (dependent `<DataType>` XML strings), parameters:[{name,tagType,dataType,
  usage,description}], files:[source paths]} — computed from the export's
  `<Controller Use="Context">` children. Include a `notes` field with limitations.
- Also embed `sourceInfo` (file paths, extraction date, ZPA project software revision).
- The generated data file will be large; keep it deterministic (sorted keys).

### L5X generator `js/conveyor/l5xgen.js`
API: `generateConveyorL5x(design, computed, opts) -> { ok, l5x, warnings, stats, files }`
where `files` maps suggested filenames to text (e.g. `{ "<name>.L5X": l5x }`); `opts.mode =
"program" | "controller"` (default "program"), `opts.aois = ["Dvc_DiscreteIn", …]` (optional
AOI embedding), `opts.baseTemplateVersion` etc.
- **program mode**: `<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="32.03"
  TargetType="Program" TargetName="<design name>" ContainsContext="true">` >
  `<Controller Use="Context" Name="<controller name>">` > `<DataTypes>` (cloned UDTs with
  `NETWORKS`/`ZPA` etc. adjusted only if needed — keep as in the ZPA project) + optional embedded AOI
  datatypes + `<Tags>` (context tags from `tagTemplates`, dimensions adjusted to zone count:
  ENET_INPUTS/OUTPUTS [zones*2], ENET_DEVICE_STATUS [zones], and CONFIG_ZPA initial data set
  for NUM_OF_ZONES/ENET_OFFSET/FIRST_ADDR via L5K CDATA) + `<Programs><Program Name="<name>"
  MainRoutineName="Main">` with `<Tags>` (program-scope tags needed by templates:
  ZPA_NDX/MAP_OFFSET_INT/ZPA_IO_TMP/STOP_JOG_ONE_SHOT etc. as required) and `<Routines>`:
  `Main` (generated: one `JSR(<groupScan>,0)` per GROUP + the `SUB`/`FOR(ZPA_MAPPING,
  ZPA_NDX,1,NETS[1].NUM_OF_ZPA_NODES,1)` rungs), one `ZPA_G<group>_<n>ZONE_SCAN` routine per
  GROUP instantiated from the matching `ZPA1_<n>ZONE_SCAN_ZONE` template (n = group
  templateZones; substitution is ONLY `ZPA[1]` -> `ZPA[<group.index1Based>]` — the within-group
  timer array indexes `[1..n]` are already correct), plus cloned support routines
  `ZPA_MAPPING`, `ZPA_MAPPING_GET_OFFSET`, `ZPA_TIMER_CONFIG` (once),
  `ZPA_SCAN_ZONE_VARS`, `ZPA_SCAN_ZONE_VARS_ONE_BACK`, `ACK_JAMS_ZPA`, `CUSTOM_CODE_ZPA_BITS`,
  `INIT_ZPA_STATUS` (once), a generated `INIT_CONFIG` routine (sets NETS[1].NUM_OF_ZPA_NODES,
  CONFIG_ZPA.NUM_OF_ZONES/ENET_OFFSET/FIRST_ADDR/SENSOR_IO from the design at first scan), and
  generated `IO_ENET_INPUTS` / `IO_ENET_OUTPUTS` mapping routines (ONE rung per GROUP block
  built by cloning the ZPA template pattern with module name `ZPAxx` and `ENET_INPUTS[ZPA_IO_TMP]`
  increments; include GSV module fault rungs). ENET_INPUTS/OUTPUTS dimensions = groups*2,
  ENET_DEVICE_STATUS = groups.
  Keep the routine metadata (comments) from templates.
- **controller mode**: full standalone export: `Controller` element (attrs from
  `localModule`/design.controller; Name/ProcessorType/MajorRev/MinorRev replaced) with
  `<DataTypes>`, `<Modules>` (Local module clone + one `<Module Name="ZPA01">` clone per zone
  from moduleTemplate with port Address = zone IP; ParentModule = network name or "Local"
  per module template ParentModule semantics), `<Tags>`, `<Programs>`, `<Tasks><Task
  Name="MainTask" Type="CONTINUOUS" Priority="10" Watchdog="500"><ScheduledPrograms>` with
  both programs (`<name>` and `IO_MASTER_MAPPER`-style mapping program).
- Names: `segment.name` sanitized; routine names `ZPA_<SEG>_<n>ZONE_SCAN` unique.
- Validate with the schema validator when available: after building, parse with
  `L5XStudio.parseL5X` (require `../l5x-model.js`) and run `L5XStudio.validateModel` (require
  `../schema-validate.js`) — if `errors.length` > 0 include them in `warnings` prefixed
  `SCHEMA:` (do not throw) but the test requires 0 errors for the demo design.
- `warnings` must list every template/zone assumption and unsupported item.
- Stats: `{routines, zones, blocks, tags, udts, sizeBytes}`.

### HMI generator `js/conveyor/hmi.js`
- `generateHmiHtml(design, computed, opts) -> string` — a **self-contained** HTML5 HMI page
  (inline CSS+JS, no external URLs): dark industrial theme; a `<canvas>` rendering the
  conveyor top view from the computed geometry (segments as strips, zones coloured by state:
  stopped/running/full/jam), zone labels (`SEG1_Z1`), sensor dots, motor squares; a simulator
  loop (zones start running when "Run" is pressed and downstream is free; toggling a sensor
  with the mouse marks a zone full; jam after 8 s if blocked); buttons Run/Stop/Reset/Sim;
  a tag-mapping panel listing each zone's input address (`ZPAxx:I.Data.0`) and output
  (`ZPAxx:O.Data.0`) and the PLC tag path `NETS[1].ZPA[z]`; header with design/controller
  names and counts. Also `generateTagListCsv(design, computed) -> string` with columns
  Tag, DataType, Description, Address, Direction, Zone for SCADA/graphics import.
- `generateGraphicsSpec(design, computed) -> string` — markdown: screen layout rectangles
  per zone (x,y,w,h from computed geometry normalized 0..1), colours, tag bindings — a spec
  a PlantPAx/FTView developer can implement quickly.
- Test: HTML contains `<canvas`, expected zone count colour legend, no `http` external refs,
  valid tag list rows; spec has one line per zone.

---

## Integration (Lead)

Lead owns `js/conveyor/model.js`, `js/ui/conveyor-panel.js`, app wiring (index.html,
js/ui/app.js, css), `test/integration3.js`, docs. The Conveyor tab will have: design canvas
(2D), 3D toggle, properties panel, component/BOM tab, logic preview tab (generated L5X), HMI
preview/download, save/load design JSON, demo design loader.

Run order suggestion: implement pure modules + tests first, wire UI last.
Constraints: do not edit Lead files or each other's files; every module Node+browser safe;
no external network/CDN dependencies; keep data files deterministic.

## Module I/O dataflow (applies to conveyor exports too)

The **Module I/O** tab (`js/module-usage.js`, `js/mermaid-render.js`, `js/ui/module-panel.js`)
analyses any project (controller export or generated conveyor export) and shows, per module:

- kind — controller / hardware chassis module (backplane slot) / EtherNet-IP network device /
  DeviceNet sub-device — with IP, RPI, connection name, image bytes and discrete capacity
  derived from the catalog number (e.g. `1799ER-IQ10XOQ10/A` → 10 in / 10 out);
- which image points are referenced (read/write counts, routines) and which input/output bits
  are **used** (referenced bit-wise), **word-mapped** (image word copied into ENET_INPUTS/
  ENET_OUTPUTS and consumed downstream — exact bit ownership is runtime) or **spare**;
- the buffer tags/routines in the dataflow (`MOV(GROUP01:I.Data, ENET_INPUTS[...])` etc.).

It renders as a **Mermaid flowchart** (rendered offline by the built-in renderer, and
downloadable as `.mmd`/`.svg` for mermaid.live), a **terminal-level schematic SVG**, bit-map
tables, a project module-network overview, and a Markdown report + JSON usage export. Rockwell
CAD models cannot be embedded offline, so the schematic is the substitute connection view.
Demo artifacts: `demo/module-diagrams/`.

## Sources and credits

The roller/driver-card database and torque-validation rules were ported from the in-house
**in-house roller part-number configurator**; costing data comes from the site **master parts
parts list** spreadsheet. Neither source file is redistributed with this project — only derived
JavaScript tables (`js/data/parts-catalog.js`) and code written for L5X Studio. Conveyor program
generation instantiates the ZPA template routines from the site project samples. See the
main [README credits](../README.md#credits--analysed-projects).
