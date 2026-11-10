# L5X Studio

[![tests](https://github.com/JRS222/l5x-studio/actions/workflows/test.yml/badge.svg)](https://github.com/JRS222/l5x-studio/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-contained, offline **reverse-engineering workbench for vendor automation artefacts**.
It accepts Rockwell **L5X** exports, **ACD** project archives, RSNetWorx **DeviceNet (.dnt)**
network files and RSNetWorx **HTML reports**, and decodes them into dataflow diagrams,
tag/I/O cross-references, decoded device logic (FBD/Ladder/ST), BOM/parts data and
schema-validated exports.

Open `index.html` in any modern browser (double-click it) — **no server, no build step, no
internet access required**. Everything runs locally in the browser, so it is safe on an
air-gapped audit laptop.

**Why it exists:** for agency/field work where a machine arrives with a controller archive, a
DeviceNet network file and a printed/exported network report — but no documentation, no source
and no original programmer. The workflow is *decode → cross-reference → export evidence*.
The full value proposition, per-file usage guide, worked workflows and known limits are in
**[docs/USER-GUIDE.md](docs/USER-GUIDE.md)**. Source: <https://github.com/JRS222/l5x-studio>.

## Features

1. **Automatic dataflow diagrams**
   - *Controller-wide tag web*: every tag read/write across all programs and routines,
     with data edges for MOV/COP/arithmetic and other value-movement instructions.
   - *Per-routine dataflow*: instruction-level graph of any ladder, structured-text or
     function-block routine. Click any tag node to resolve it to its physical I/O point.
2. **UDT "shape" viewer**
   - Nested member tree for every user-defined data type: type, array dimensions, radix,
     byte/bit offsets, description, initial values. The same viewer renders module I/O
     image structures and tag initial values.
3. **Tag → physical I/O point mapping (any scope)**
   - Type any operand (e.g. `Network1:I.Data[2].1`, `AFCS[3].RUN_INTERLOCK`,
     `Local:1:O.Data.0`) and see the full resolution chain: program tag → controller tag →
     aliases → UDT members → module image member → bit/word, with the module name,
     catalog number, slot/port and rack location, direction (Input/Output/Config),
     current value, and which bits are ON.
   - Browse the module tree with every module's input/output/config images, and find which
     tags reference a given point through the controller-wide dataflow graph.
4. **Visual editors**
   - Ladder editor (SVG rungs, branches, coils; click to edit operands, insert/delete
     instructions and branch legs), function-block editor (blocks, pins and wires), and a
     structured-text editor with live syntax diagnostics.
5. **Routine conversion + L5X re-export**
   - Convert any routine between **Ladder ↔ Function Block ↔ Structured Text** with a
     warning list for approximated constructs. The app then re-outputs a valid L5X file in
     which only the changed routines (and any auto-declared new tags) differ from the
     original — everything else is preserved byte-for-byte.
6. **Official L5X schema validation** (from [benmusson/l5x-schema](https://github.com/benmusson/l5x-schema))
   - The seven Rockwell L5X XSDs (v32–v38) are compiled into validation rules that ship with
     the app. Every loaded project and every staged export is checked for required
     attributes, attribute enumerations, element order/occurrence and routine-type/content
     consistency, with errors/warnings and XPaths in the **Validation** tab.
7. **I/O list export** (from [tnunnink/ioList](https://github.com/tnunnink/ioList))
   - Generates the commissioning/FAT I/O list from the module I/O images: module, catalog,
     slot/address, direction, point, data type, logic references, **buffer tags** (the
     intermediate tag the module word is copied to/from, e.g. `ENET_INPUTS[...]`), analog
     high/low from config tags, used/unused filters, column picker, CSV and Markdown export.
7b. **Module-level I/O dataflow**
    - Per-module view of **hardware I/O** (chassis/backplane modules, slot-based) versus
      **network I/O** (EtherNet/IP devices, IP + RPI): connection facts and image sizes, which
      image points and individual input/output **bits are used** — "used" (referenced in logic),
      "word-mapped" (image word copied into `ENET_INPUTS`/`ENET_OUTPUTS` and consumed
      downstream) or "spare" — plus the buffer tags and routines that touch them.
    - Rendered as a **Mermaid flowchart** (module ⇄ bits ⇄ tags ⇄ routines) by a built-in
      offline Mermaid renderer, exportable as `.mmd`/`.svg` for any Mermaid viewer; also a
      **terminal-level schematic SVG** (used channels wired, spares grey — the offline
      substitute for Rockwell CAD models), bit-map tables, a project module-network overview,
      and downloadable Markdown report + JSON usage data. Works on real controller projects and generated
      conveyor projects alike.
    - **Inter-module flow**: controller → chassis/fieldbus bridges (`1756-DNB`, Ethernet bridges) →
      remote I/O, labelled with the bus protocol, IP/slot and connection facts, with a
      communication summary table (bridges, devices, image points, scan-list state).
    - **Diagram navigation**: the rendered Mermaid SVGs are pan/zoomable in the viewport
      (drag to pan, wheel to zoom, Fit/100% buttons) and exportable as `.mmd`/`.svg`.
    - **DeviceNet `.dnt` import** (reverse-engineered RSNetWorx network files — see
      [docs/DEVICENET.md](docs/DEVICENET.md)): `.dnt` files open like any other project file
      (Open \u2192 .dnt, the **DeviceNet workspace**, Ctrl+K or the dashboard). Standalone they
      show the scanner configuration, node table, EDS parameters and a network diagram; with an
      L5X/ACD project open the nodes merge under the matching scanner with MAC, catalog,
      transfer type, I/O sizes and the **L5X scanner image words** (`Local:1:I.Data[n]`)
      derived from the scan-list bit offsets.
    - **Network transport semantics**: `I.Data`/`O.Data` image words are labelled with how they
      travel (EtherNet/IP / DeviceNet / ControlNet / DH+ / backplane) and get **per-network
      colours** in the diagrams (EtherNet/IP green, DeviceNet orange, ControlNet blue, DH+ red);
      1799-ZCIOV zone cards are marked as devices that run **local logic** on network input
      words (the sensor-over-network \u2192 local-logic pattern).
8. **Project health report**
   - Unused tags, unresolved operands (referenced but not declared), uncalled/empty routines,
     unreferenced I/O points, and Add-On Instruction usage — with a markdown report export.
9. **C translation export** (from [alairjunior/l5x2c](https://github.com/alairjunior/l5x2c))
   - Translates a routine or the whole project to C (`plcmodel.h` + `plcmodel.c`): ladder
     stack-machine semantics, Rockwell timer/counter emulation, generated C structs for
     UDTs, tag declarations, and JSR execution order — for verification, simulation harnesses
     and cross-platform porting. Unsupported instructions are flagged, never dropped.
10. **ACD metadata browser** (from [hutcheb/acd](https://github.com/hutcheb/acd))
    - Opens `.ACD` project archives directly in the browser (record table + gzip inflate):
      controller identity, all data types with **exact Rockwell byte/bit offsets**, the
      controller and program tag databases, and the embedded archive file list. Logic lives
      in Rockwell's binary databases and is not decoded — export L5X for logic features.
11. **Add-On Instruction browser** (corpus validated against
    [JeremyMedders/LogixLibraries](https://github.com/JeremyMedders/LogixLibraries))
    - Parameters (tag type, data type, usage), local tags, routines (with ST/LAD content
      preview), revision/vendor/scan flags, custom properties and help text.
12. **L5K value decoding** (from [jvalenzuela/l5x](https://github.com/jvalenzuela/l5x))
    - Decodes `L5KData` tag initial values (arrays, nested values, based literals `16#`/`2#`/
      `8#`, strings, BOOL bit patterns) for display in the tag inspector and UDT viewer.
13. **Conveyor Design Studio** (template-driven generation)
    - Draw a conveyor in a **2D canvas editor** and inspect it in a **3D WebGL view**. Segments
      chain end-to-start, so angled joints get a **rounded edge** (no overlapping strips);
      curve segments use **standardised tapered rollers** (frustum geometry derives the
      turning radius from the roller taper — R = W·D_avg/Δ, quantised by the standard taper
      set), and **up/down spiral** segments are inclined helices with pitch/slope/height
      limits. **Belt conveyor** designs are supported alongside roller/ZPA conveyors.
      **Merge junctions** join a spur line into a main line with alternating/priority release
      arbitration (rounded Y-throat drawing + merge logic), and **transfer devices** include
      **pushers** (one-way divert), **rotary tables** and **cross-belt pop-up transfers**
      (both **bidirectional**) with their own I/O blocks, bilaterally driven belts/rotation,
      interlocks, BOM kits and generated control routines.
      Component selection uses the roller/driver-card database ported from the in-house
      roller part-number configurator (motorized/tapered/braking rollers, driver card
      compatibility, torque validation) plus the plant master parts list for costs.
    - **Scan zones + barcode tray tracking**: place barcode/camera scan zones along the
      conveyor; the generated control program includes a tray-tracking UDT/table and
      scan/move/clear routines, and the HMI shows a live tracking table.
    - Generates in one click: a **bill of materials** (rollers incl. tapered/braking rollers,
      driver cards, belt/pulleys/drives, sensors, I/O blocks, scanners, cabling, power,
      mechanical) with CSV/Markdown export; an **L5X control program** built by instantiating
      the real ZPA templates (`ZPA1_2..8ZONE_SCAN_ZONE`, `ZPA_MAIN`, `ZPA_MAPPING`,
      `ZPA_TIMER_CONFIG`, `ENET_ZPA_INPUTS/OUTPUTS`, …), UDTs and 1799ER module definitions
      (or a belt-drive section with the PowerFlex 525 AOI) — in *program-export* or
      *controller-export* mode, validated against the official L5X schema; and a
      **graphics/HMI program**: a self-contained HTML5 HMI page with the conveyor, spiral
      heights, scanner markers, tracking table and simulator, plus a tag-list CSV and a
      screen spec for PlantPAx/FTView.
    - The **Validation** tab, **Convert** tab previews and the routine **Text** view make every
      translated routine inspectable, and converted routines open directly in the matching
      editor or text view.

## What files can I open?

| File | What it unlocks | Details |
|---|---|---|
| **`.L5X`** (Studio 5000 / RSLogix export) | the full PLC picture: data types/UDT shapes, tag databases, modules, routines, dataflow diagrams, I/O map/list, module I/O + inter-module flow, AOI browser, validation, health, routine conversion, C translation, L5X re-export | [guide](docs/USER-GUIDE.md#21-l5x--rockwell-xml-export) |
| **`.ACD`** (Studio 5000 archive) | metadata-only browser: controller identity, every data type with exact byte/bit offsets, controller/program tag databases, archive contents. Logic is **not** decoded (binary component DBs) | [guide](docs/USER-GUIDE.md#22-acd--studio-5000-project-archive) |
| **`.DNT`** (RSNetWorx DeviceNet network) | scanner settings (EPR/interscan/poll ratio/retries), node table (MAC, catalog, transfer, I/O bytes, bit offsets), EDS parameters, embedded tag/label configuration, network diagram, node configuration tabs; merges into the L5X module/inter-module views with scanner image words (`Local:1:I.Data[100]`) | [guide](docs/USER-GUIDE.md#23-dnt--rsnetworx-devicenet-network) · [format notes](docs/DEVICENET.md) |
| **`.HTML` / `.HTM`** (RSNetWorx "Export to HTML") | device parameter tables and the **Logic** section — the card's ladder logic in RSNetWorx's FBD rendition; per-node Logic tab with FBD drawing, read-only graphical Ladder, Structured Text, label cross-reference and JSON, downloadable | [guide](docs/USER-GUIDE.md#24-htmlhtm--rsnetworx-export-to-html-report) |

Files can be mixed in any order — **L5X + DNT + HTML** is the full workflow (network nodes ↔
scanner image words ↔ PLC tags ↔ device logic); **ACD + DNT/HTML** works when the logic export is
not available; a **HTML report alone** becomes a logic-only network browser.
Open with **Ctrl+O**, drag-and-drop, the activity rail, or the command palette (Ctrl+K).

## Usage

### User interface (redesigned shell)

The feature set outgrew the old single-row header (newer views were pushed off-screen), so the
app now uses a proper shell:

- **Top bar** — project identity, the **command palette** button (`Ctrl+K`), Open and Export.
  File actions no longer compete with views for space.
- **Activity rail** (left) — grouped workspace navigation: **Project** (Explorer, Diagram, Home),
  **Inspect** (I/O map, I/O list, **Module I/O**, UDTs, ACD, AOIs), **Analyze** (Validate,
  Health), **Build** (Conveyor studio, Convert, Export C). The active workspace is highlighted;
  unavailable items are dimmed until a project (or ACD) is open.
- **Home dashboard** — grouped, clickable feature cards (Inspect & understand / Edit & convert /
  Analyze & ship / Generate & build), so every feature is discoverable from the start screen.
- **Command palette** (`Ctrl+K`) — searches every workspace, every routine (`Program / Routine`),
  every module (`Module I/O — GROUP01 (1799ER…)`) and every data type; arrow keys + Enter to run.
  This also provides direct deep-links into Module I/O for a specific module.
- **Decoded DeviceNet node logic (FBD)**: RSNetWorx ports the card's ladder logic to a
  function-block rendition in its **Export to HTML** report. Open that `.html` (File → Open,
  the DeviceNet panel button, drag-drop or command palette): the report is matched to the
  loaded `.dnt` by file name (or browsed standalone when no `.dnt` is open), and every node
  gets a **Logic** tab with the decoded FBD network — blocks, timers (preset/timebase),
  latches, counters, complemented (dashed) inputs, pan/zoom and a language switcher
  (**FBD / Ladder / Structured Text / Labels / JSON**, each downloadable). The **Ladder**
  rendition is rendered as a real ladder diagram (read-only, with rung comments) using the same
  ladder renderer as the routine editor — not a text listing; the text stays available as a
  downloadable detail. The FBD is
  **cross-referenced with the card's local-logic configuration**: configured tag names
  (`Latch_1`, `Timer_5`) and descriptions ("Zone 1 Jam Latch", "Zone 1 Jam Timer") are read
  from the `.dnt` plugin storage (`CFbIDofTag` map + label strings), unbound inputs show the
  inferred I/O labels, and the **Labels** view lists the recovered I/O aliases
  ("ZONE 1 PE" → DIP.8 device input, "Out-of-Service from GFX" → CNB.10 consumed network bit,
  "%Tray Present…" → PNB.1 produced network bit, "Run Zone 1 Motor" → DOP.8 output).
  ZONE_TEMPLATE: 712 blocks across 9 device cards (23 tagged blocks on the zone card);
  zone card report: 174 blocks across four zone-card variants.
- **DeviceNet node configuration ("code") view**: a `.dnt` network appears in the project sidebar
  under **DeviceNet networks** together with every remote node (also in the command palette).
  Clicking a node opens its own tab — like a routine in project navigation — with **Parameters**
  (EDS applet configuration, inferred meanings for the 1799-ZCIOV zone card), **Zone mapping**
  (the card's decoded Zone Data byte/bit map + local-logic labels), **Point labels** (network /
  local inputs and outputs), **Raw config** (all printable strings recovered from the plugin
  storage stream) and a node JSON download.
- **IF in ST is a rung**: the ST\u2192LAD converter maps `IF/ELSIF/ELSE` to rung condition networks
  and branches; arithmetic inside a condition (`IF X = Y - 1`) is computed through **auto-declared
  helper tags** (`L5X_TMP_n`, DINT, safe on export) and integer \u00b11 comparisons are simplified
  (`A > B - 1` \u2192 `A >= B`), so conditions are no longer rejected. `FOR` becomes FOR/NXT and
  `WHILE/REPEAT` become LBL/JMP loops.
- **Every diagram/editor is navigateable**: the routine dataflow diagram supports drag-to-pan and
  wheel zoom (with an on-canvas hint); the ladder and FBD editors have \u2212 / + / Fit / 100%
  zoom controls and scroll in both axes; the module list and all tab-body layouts scroll instead
  of clipping; the DeviceNet network diagram is drag/wheel pan-zoomable and its node table has
  real aligned `<tr>/<td>` rows.
- **Tabs identify their contents and can be closed.** Routine and data-type views open one tab
  per item, labelled with the item name (full `Program / Routine` context in the tooltip), and
  every tab has a close button; converted routines and feature views no longer collide in a
  single generic tab.
- **Bottom status bar** — loaded project facts (programs/routines/modules) and status messages.
- **Responsive rail** — labels collapse to icons on narrow windows; the project tree can be
  toggled with the ☰ button.

headless Chrome with a controller project loaded).

### Quick start

1. Open `index.html` in a browser.
2. Click **Open L5X…** (or drop a `.L5X` / `.ACD` file anywhere on the page).
3. Left tree: Data Types, Tags (controller and per-program), Modules, Programs → Routines,
   Add-On Instructions.
4. **Project diagram** tab shows the controller-wide dataflow.
5. Click a routine → **Routine** tab with the dataflow diagram and the editor sub-tab.
6. **Convert** tab: convert the current routine to ladder, FBD or structured text; review
   warnings; apply.
7. **Export L5X**: downloads `<project>-modified.L5X` containing only your staged changes.
   New tags referenced by your edits are auto-declared (DINT, controller scope) with a
   warning.
8. **I/O list**, **Health** and **Validate** buttons in the header; **Export C** in the header
   (whole project) and in the routine toolbar (single routine).

## Limitations / notes

- The L5X import/export schema followed is the Rockwell 1756-RM014 reference (chapter 9
  RLL, chapter 10 FBD, chapter 11 ST). FBD XML follows the manual's element ordering and
  wiring rules; re-import with Logix Designer v21+ is expected (FBD generated content is
  the least-tested path — verify after import).
- Conversion is lossless for the common instruction set; less common or timing-sensitive
  constructs (ONS/OSR/OSF semantics, JMP/LBL patterns, some process instructions) are
  converted with explicit warnings and are never silently dropped.
- Module I/O images are taken from the module connection InputTag/OutputTag/ConfigTag
  structures in the L5X. For scanner modules (DeviceNet/EtherNet/IP bridges) the L5X only
  contains the raw image, so points map to image word/bit; the terminal-level mapping of
  the end device lives in the scanner configuration, which is not part of L5X exports.
- SFC routines are shown as-is but not editable or convertible.
- ACD support is metadata-only: the archive's `QuickInfo.XML` and `TagInfo.XML` are parsed;
  logic, I/O configuration and initial values live in proprietary binary databases and are
  not decoded. Export an L5X from Studio 5000 for the full feature set.
- The C export is a translation aid (verification/porting), not a cycle-accurate simulator;
  scanner/communications instructions (MSG, GSV/SSV object values, produce/consume) are
  represented but not modeled.
- DeviceNet `.dnt` parsing is **reverse-engineered** (format notes in
  [docs/DEVICENET.md](docs/DEVICENET.md)): per-node RPI is not stored (scanner EPR only), some
  templates have no scan list, and unknown future format revisions may add fields.
- RSNetWorx HTML logic is the tool's **FBD rendition** of the card's ladder logic, not the
  original ladder drawing; inputs without a bound block are the card's local/network I/O.
  Local-label associations (tag names, descriptions, I/O aliases, byte→zone-connection split)
  are recovered from the configuration and marked as inferred in the UI.
- The zone-mapping dots mean "the bit has a configured zone-data tag"; the cross-reference table
  shows the carrying zone connection and (where inside the DeviceNet assembly) the PLC scanner
  image bit. See the [user guide](docs/USER-GUIDE.md#zone-mapping-what-the-dots-mean-and-what-each-bit-maps-to).

## Credits / analysed projects

L5X Studio's functionality was **adapted after analysis** of the projects below. No third-party
code is vendored: every module in `js/` is original JavaScript written for this app, and the
reference clones used during analysis live outside this repository (not redistributed).

| Project | Reference used for | Licence |
|---|---|---|
| [benmusson/l5x-schema](https://github.com/benmusson/l5x-schema) | Official Rockwell L5X XSD schemas v32–v38 → the compiled validation rules shipped in `js/data/schema-v*.js` | MIT |
| [tnunnink/ioList](https://github.com/tnunnink/ioList) | I/O-list generation model: device tags from module images, reference lookup, unused filter, buffer-tag detection, configurable columns | MS-PL-style (see upstream) |
| [jvalenzuela/l5x](https://github.com/jvalenzuela/l5x) | L5K data-value decoding semantics (arrays, nested values, radix literals, strings, BOOL patterns) — semantics re-implemented | GPL-3.0 (semantics only; no code copied) |
| [hutcheb/acd](https://github.com/hutcheb/acd) | ACD archive format (record table + gzip payloads) and tag/data-type metadata reading | MIT |
| [alairjunior/l5x2c](https://github.com/alairjunior/l5x2c) | Ladder→C stack-machine translation model, `plcmodel` runtime template and Rockwell timer/counter semantics | MIT |
| [cmseaton42/Allen-Bradley-Toolkit](https://github.com/cmseaton42/Allen-Bradley-Toolkit) | L5X element-creation templates and attribute defaults (tags, controller, routines) | See upstream |
| [JeremyMedders/LogixLibraries](https://github.com/JeremyMedders/LogixLibraries) | AOI/UDT-heavy L5X corpus used to validate the parser, AOI browser and schema validator | MIT |

### Vendor formats and other sources

These were used for **interoperability and format research**, not as code references:

| Source | Used for |
|---|---|
| Rockwell Automation **1756-RM014** (Logix 5000 instruction reference) | L5X element ordering, RLL/FBD/ST neutral-text semantics, instruction/timer/counter behaviour. The extracted text file used during development is **not redistributed**; refer to Rockwell's published document. |
| Rockwell **RSNetWorx for DeviceNet** `.dnt` files and **"Export to HTML"** reports | The DeviceNet parser, plugin-storage label/tag-map decoding and the logic cross-reference were developed by **independent reverse engineering** against real files (ZONE_TEMPLATE, zone card, TRAY templates) and their HTML reports. No vendor code or tooling is included. |
| Rockwell **Studio 5000 `.ACD` archives** | Container/stream layout reverse-engineered with the help of hutcheb/acd's published findings; logic databases are not decoded |
| **in-house roller part-number configurator** (internal tool) | Roller/driver-card database (motorized/tapered/braking rollers, driver-card compatibility, torque validation rules) ported into `js/data/parts-catalog.js` |
| **Plant master parts list** (in-house spreadsheet) | Costing/BOM catalogue data |
| **Site controller projects and ZPA templates** | Demo corpus and conveyor-program generation templates (not redistributed; see the test-sample section) |

If you reuse this project, keep these acknowledgements with it. If you are the maintainer of one
of the referenced projects and would like a different attribution or link, open an issue.

## Development

### Test samples (not redistributed)

The repository does **not** include site-derived samples (controller exports, RSNetWorx
`.dnt`/`.html` files, the Rockwell 1756-RM014 text extract) — see the licence/attribution notes.
Suites that need them **skip gracefully**; everything else runs on generated fixtures.

To run the full suite against your own copies, put them anywhere and point the environment
variables at them (or place them in an ignored `samples/` directory):

| Variable | Points at |
|---|---|
| `L5X_STUDIO_SAMPLE_RLL` | a controller export (`L5X`) with the expected programs/modules |
| `L5X_STUDIO_SAMPLE_ST` | a controller export containing native structured-text routines |
| `L5X_STUDIO_DNT_DIR` | directory with `ZONE_TEMPLATE.dnt`, `TRAY-CONVEYOR-TEMPLATE.dnt`, `zone-card code.dnt` |
| `L5X_STUDIO_DNET_HTML` | directory with the matching RSNetWorx HTML reports |

Example (Windows): `set L5X_STUDIO_SAMPLE_RLL=D:\audit\controller.L5X` then run the suites.
Generate the demo artefacts with `node demo/build-module-demo.js` and
`node demo/build-conveyor-demo.js` (they need the same site samples for the module demo).

- All logic modules are UMD (browser global `L5XStudio` + CommonJS for Node tests).
- Node test suites: `test/lead-core.test.js` (18), `test/acd-aoi.test.js` (9),
  `test/t1-lang.test.js` (32), `test/t2-editors.test.js` (24), `test/t3-schema.test.js` (42),
  `test/t4-iolist.test.js` (27), `test/t5-codegen-health.test.js` (20),
  `test/t6-conveyor-view.test.js` (49), `test/t7-conveyor-parts.test.js` (71),
  `test/t8-conveyor-gen.test.js` (43), `test/integration.js` (21), `test/integration2.js` (15),
  `test/integration3.js` (16, conveyor end-to-end), `test/module-usage.test.js` (13, module
  I/O dataflow + Mermaid), `test/convert-if.test.js` (7, ST→LAD IF conditions + helper tags),
  `test/dnet.test.js` (11, DeviceNet .dnt import + node configuration labels),
  `test/dnet-html.test.js` (9, RSNetWorx HTML logic rendition: blocks, bindings, FBD SVG, local-logic cross reference, ST/ladder conversions),
  `test/ui-smoke.js` (headless DOM-stub smoke test),
  `test/export-qa.js` (writes converted exports to `test/out/` for external
  validation) — 433 checks in total.
  Run with the bundled Node, e.g.
  `"C:/samples/sample-file" test/integration.js`
- **ACD archives**: metadata features work directly (controller identity, data types with exact
  offsets, tag database, archive browser) and DeviceNet `.dnt` networks attach there too; logic
  views (routines/conversion/health/I/O usage) require the matching L5X export, because the
  logic lives in the ACD\u2019s binary component databases (no embedded L5X export exists in
  these files). Open L5X\u2026 with the export to unlock them — DNT attachments persist.
- `demo/build-conveyor-demo.js` regenerates the complete conveyor demo package under
  `demo/conveyor/` (design JSON, BOM CSV/MD, program + controller L5X, HMI HTML, tag list,
  graphics spec). `demo/add-pusher-21.js` is the worked example for adding a pusher to a real
  project.
- `docs/CONTRACT.md` is the core module API contract; `docs/IMPROVEMENTS.md` covers the
  community-repo improvement round; `docs/CONVEYOR.md` covers the conveyor studio
  (model, 2D/3D, parts, template extraction, L5X/HMI generation); `docs/1756-rm014.txt` and
  `docs/neutral-text-ladder.md` are extracted reference material from the Rockwell
  Import/Export manual.
- `tools/build-xsd-rules.js` regenerates `js/data/schema-v*.js` from
  `repo-analysis/l5x-schema/schemas/*.xsd`; `tools/build-parts-catalog.py` regenerates
  `js/data/parts-catalog.js` from the plant master parts list;
  `tools/extract-conveyor-templates.js` regenerates `js/data/conveyor-templates.js` from the
  controller projects and the LogixLibraries AOI corpus.
