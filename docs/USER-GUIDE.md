# L5X Studio — reverse-engineering guide: file types, usage and value

L5X Studio is a **self-contained reverse-engineering workbench for vendor automation
artefacts**. You point it at the files a vendor (Rockwell/Allen-Bradley by default) leaves on a
machine, and it turns them into diagrams, tag/I/O cross-references, decoded device logic and
exportable evidence — entirely offline, in a browser tab.

It was built for agency work where you receive a machine, a controller archive, a DeviceNet
network file and a printed/exported network report — but not the engineering resources, the
original programmer, or clean documentation.

---

## 1. Value proposition

| Problem on a real job | What L5X Studio gives you |
|---|---|
| Third-party machine with no documentation, no source, no drawings | Every accepted file is decoded into a browsable model: project tree, tag database, UDT layouts, module I/O images, network topology, device logic |
| "What does this network/IO actually do?" | Controller-wide and per-routine **dataflow diagrams**, **module I/O** and **inter-module flow** diagrams, **I/O lists** with buffer tags and logic references |
| Unknown remote I/O / DeviceNet devices | `.dnt` scanner and node tables (MAC, catalog, transfer type, I/O sizes, bit offsets) merged with the L5X into **scanner image word addresses** (`Local:1:I.Data[100]`) |
| Device logic is locked inside a vendor config tool | RSNetWorx HTML reports are parsed into the **decoded function-block logic** (FBD), with rendered Ladder + Structured Text renditions and local label cross-references |
| "Is this still what the drawing says?" | Official **L5X schema validation**, project **health report** (unused tags, unresolved operands, dead routines, unused I/O), and diff-friendly exports |
| Migration / porting / simulation | Routine **conversion** between Ladder, FBD and Structured Text, re-export of a valid L5X, and **C translation** of routines for simulation harnesses |
| Produce an audit / handover pack | Pan/zoom diagrams as `.svg`, Mermaid `.mmd`, Markdown module reports, JSON usage data, CSV I/O lists, node-configuration JSON, logic `.svg`/`.md` — all generated locally |
| Nothing may leave the site / no internet | The app is a single folder of files: **no server, no build step, no CDN, no uploads**. Open `index.html` from a USB stick on an air-gapped laptop |

The intended pattern is **decode → cross-reference → export evidence**:

1. Load every artefact you were given (L5X, ACD, DNT, HTML report).
2. Let the app merge them (network nodes ↔ scanner image words ↔ PLC tags ↔ device logic).
3. Read the diagrams and cross-reference tables to reconstruct behaviour.
4. Export the evidence (diagrams, reports, JSON/CSV) into the job folder.

---

## 2. Files this app accepts

Open with **Ctrl+O**, the Open button, drag-and-drop onto the window, the activity-rail buttons,
or the command palette (Ctrl+K). The Open dialog accepts all of the types below; a plain-text
`.L5X`/`.DNT`/`.HTML` is read locally in the tab.

| File | What it is | Load it for | Needs a companion? |
|---|---|---|---|
| `.L5X` | Studio 5000 / RSLogix 5000 **XML export** of a controller or program | Everything PLC-side: data types, tags, modules, routes, routines, editors, conversion, validation, I/O | No — main entry point |
| `.ACD` | Studio 5000 **project archive** (binary component databases) | Controller identity, full data-type catalogue with exact byte/bit offsets, tag database, archive contents. **Logic is not decoded** | Logic views need the `.L5X` export of the same project |
| `.DNT` | RSNetWorx **DeviceNet network** file | Scanner settings, node list, catalogs, transfer types, I/O sizes/bit offsets, EDS parameters, embedded tag/label configuration | Standalone works; merges with L5X/ACD when a project is open |
| `.HTML` / `.HTM` | RSNetWorx **"Export to HTML"** network report | Device parameter tables and the **Logic section** — the card's ladder logic in FBD rendition; renders FBD/Ladder/ST/Labels | Standalone works; matched to a loaded `.DNT` by filename for node association |

You can mix them in any order and repeat loads — attachments persist and re-merge:

- **L5X + DNT**: network nodes are placed under their scanner bridge, scanner image words per
  node are computed, network transport is coloured in the Module I/O and inter-module diagrams.
- **ACD + DNT**: network analysis works while the ACD supplies the controller/tag metadata.
- **DNT + HTML**: the HTML logic is attached to the matching nodes; the node Logic tab opens.
- **L5X + DNT + HTML**: the full picture — logic annotated with the configured local labels,
  cross-referenced to scanner image bits and tags.
- **HTML alone**: a logic-only network browser is created from the report (useful when you only
  have the vendor's printed report).

### 2.1 `.L5X` — Rockwell XML export

How to obtain it (when you have the vendor's project copies but not the tool):
Studio 5000 Logix Designer → **File → Save As…** and choose **L5X** (or *Export → Project*);
RSLogix 5000 → **File → Save As → L5X**. Ask for the **controller export** rather than a single
program when you need modules/I/O too.

What opening it unlocks:

- **Project diagram** — controller-wide tag web (reads/writes, MOV/COP/arithmetic edges).
- **Routine view** — per-routine instruction dataflow diagram (drag to pan, wheel to zoom), a
  **graphical Ladder/FBD/ST editor** and the raw text.
- **Data types (UDT shape)** — nested members, arrays, byte/bit offsets, descriptions,
  initial values.
- **I/O map** — resolve any operand to a physical point: tag → alias → UDT member → module image
  → bit/word, with rack/slot/IP, direction and live value.
- **Module I/O** — hardware (backplane) vs network I/O, image sizes, which bits are *used*,
  *word-mapped* or *spare*, buffer tags, per-module/inter-module diagrams, terminal schematics,
  bit maps, Markdown/JSON exports.
- **I/O list** — commissioning/FAT-style list with module, catalog, point, logic references,
  buffer tags, analog ranges; CSV/Markdown export.
- **Validation** — official v32–v38 schema check with XPaths.
- **Health** — unused tags, unresolved operands, dead/empty routines, unused I/O, AOI usage.
- **Add-On Instructions** — parameters, local tags, routines, revisions, help text.
- **Convert** — Ladder ↔ FBD ↔ ST with a warning list; **Apply** stages the change and the
  routine opens in the matching editor. IF/ELSIF/ELSE conditions convert to rungs; arithmetic
  conditions use auto-declared helper tags (`L5X_TMP_n`); `FOR` becomes FOR/NXT; `WHILE/REPEAT`
  become LBL/JMP loops.
- **Export** — write a valid L5X containing only your changes (everything else byte-preserved),
  validated before download; also **C translation** export for simulation.

Tips: the tag inspector accepts dotted, arrayed and bit operands (`ENET_INPUTS[12].3`,
`Local:2:I.Data[100].7`); the command palette (Ctrl+K) jumps to any routine/data type/module.

### 2.2 `.ACD` — Studio 5000 project archive

`.ACD` files are Rockwell archive containers (record table + gzip streams). L5X Studio opens them
directly and shows:

- controller identity (name, processor type, revision),
- **all data types with exact Rockwell byte/bit offsets** (the layout the controller actually
  uses — invaluable when you must reconstruct memory maps),
- controller and program tag databases (names, types, dimensions, initial values),
- the embedded archive file list (with sizes).

**Honest limitation:** the program logic lives in Rockwell's binary component databases
(`Comps.Dat`, `Nameless.Dat`, …); those files do not contain an embedded L5X/XML export, so
L5X Studio cannot reconstruct routines from an ACD. The ACD view says so and links to the
workflow: get the matching **L5X export** from the vendor/backup, then open it — DNT/HTML
attachments carry over. Use the ACD for inventory and the L5X for logic.

### 2.3 `.DNT` — RSNetWorx DeviceNet network

DeviceNet network files are OLE2/CFB compound documents. The parser was reverse-engineered against
real DeviceNet network files and RSNetWorx reports; see [DEVICENET.md](DEVICENET.md) for the format notes.

Opening a `.DNT` gives the **DeviceNet workspace**:

- **Scanner facts** — network name, scanner present, EPR/interscan delay/poll ratio/retries,
  mapped vs declared node count.
- **Node table** — MAC ID, name, catalog, transfer type (polled/COS/cyclic), input/output bytes,
  scan-list bit offsets, and the L5X scanner image words when a project is merged.
- **Node tabs** (click a node): **Parameters** (EDS applet configuration; inferred meanings for
  the 1799-ZCIOV), **Zone mapping** (configured zone-data tag database with tag ids, an aligned
  8×8 dot grid and a per-bit cross-reference: zone connection, scanner image bit, used-by),
  **Point labels**, **Raw config** (all printable strings from the plugin storage), **Logic**
  (when the HTML report is attached), and a JSON download.
- **Network diagram** — Mermaid flow of scanner → nodes with transfer type colours, pan/zoom.
- **Sidebar integration** — networks and nodes appear in the project tree like routines; click a
  node to open its own tab; the palette lists every node.

With an **L5X/ACD open**, the same nodes merge into:

- **Module I/O** — nodes become remote I/O under the bridge, with per-word usage and status.
- **Inter-module flow** — controller → bridge → DeviceNet nodes, coloured by bus protocol.
- **Bit map / usage** — which scanner image bits are used by the PLC logic.

### 2.4 `.HTML`/`.HTM` — RSNetWorx "Export to HTML" report

RSNetWorx can print a network report to HTML (**File → Print/Export → HTML**, or *Report*).
That report contains the device pages, parameter tables and — for configurable devices like the
1799-ZCIOV zone cards — a **Logic** section: the card's ladder logic ported to a function-block
(FBD) rendition.

L5X Studio parses the report and:

- **matches it to a loaded `.DNT`** by the report's original filename (`H:\ZONE_TEMPLATE.dnt` ↔
  `ZONE_TEMPLATE.dnt`), or creates a logic-only network when no `.DNT` is loaded;
- adds a **Logic** tab to every node with the decoded blocks: configured tags, descriptions,
  timers (preset/timebase), latches/counters, complemented (NOT) inputs and unbound-I/O slots;
- renders it as a **layered FBD drawing** (pan/zoom), and converts it to **Ladder** (read-only
  graphical ladder, rung comments), **Structured Text**, **Labels** (cross-reference) and
  **JSON** — each downloadable;
- cross-references the card's **local-logic configuration** from the `.DNT` plugin storage:
  block tag names via the `CFbIDofTag` map (`Latch_1` → FB 1), descriptions
  ("Zone 1 Jam Latch", "Zone 1 Jam Timer") and I/O aliases with address semantics
  (`ZONE 1 PE` → `DIP.8` device input, `Out-of-Service from GFX` → `CNB.10` consumed network bit,
  `%Tray Present…` → `PNB.1` produced network bit, `Run Zone 1 Motor` → `DOP.8` output).

Development samples used while building this app (ZONE_TEMPLATE and zone card reports) are
**not redistributed** with the public repository; export your own report from RSNetWorx and open it.
The same applies to site `.L5X`/`.DNT` exports — see the repository `.gitignore` and README
"Test samples" section for the environment variables used by the test suites.

Known contents: `ZONE_TEMPLATE.html` (12 devices, 9 with logic, 712 blocks) and
`zone-card code.html` (4 zone-card variants, 174 blocks) are included as samples under
`demo/devicenet-html/`.

---

## 3. Workflows you can run today

### A. Reverse-engineer an unfamiliar DeviceNet cell (L5X + DNT + HTML)

1. Open the **L5X** export. Check **Validation** (is the file itself sane?) and **Health**.
2. Open the **`.DNT`** — read the scanner facts and node table. Note catalogs/transfer types.
3. Open the **`.HTML`** report — the node list gains `FBD n` badges; the Logic tabs open.
4. In **Module I/O**, pick the scanner bridge, switch to **Inter-module flow**: you now see
   controller → bridge → every device, with protocol colours.
5. Click a device node in the sidebar tree → inspect **Parameters**, **Zone mapping**,
   **Point labels**, **Raw config**, **Logic**.
6. In **Logic → Labels**, read the configured tag/I-O aliases; follow them in **Ladder**/FBD.
7. In **Zone mapping**, use the per-bit cross-reference: configured tag id → zone connection →
   scanner image bit (`Local:1:I.Data[100].0`) → routines referencing that word.
8. Export the evidence: module report Markdown, I/O list CSV, diagrams `.svg`/`.mmd`, node JSON,
   logic `.svg`/`.md`/`.st`.

### B. Third-party machine where you only have the ACD

1. Open the **`.ACD`**: controller identity, data types with exact offsets, tag database,
   archive inventory — reconstruct the memory/tag map (UDT viewer works on ACD types).
2. Attach the **`.DNT`/`.HTML`** if the network files survived — network behaviour and device
   logic can be recovered even without the PLC logic.
3. If logic is required, request the **L5X export** (same revision). Load it; attachments persist
   and the module/I/O/cross-reference views light up.

### C. Recover a zone card's logic from printed/exported artifacts only

Open the **`.HTML`** alone: a logic-only network is created (device list from the report).
Use **Logic → FBD/Ladder/ST** to read behaviour and **Download** each rendition. Add the `.DNT`
later to gain configured labels and the zone mapping cross-reference.

### D. Audit I/O usage, spare capacity and documentation debt

Open the **L5X** → **Module I/O** (bit statuses: used / word-mapped / spare) → **I/O list**
(filters, buffer tags, analog ranges) → export CSV/Markdown. Run **Health** for unused tags,
unresolved operands and dead routines. **Validation** gives an objective file-quality statement.

### E. Migration, simulation or re-use of logic

**Convert** a routine (Ladder ↔ FBD ↔ ST) and read the warning list before applying; converted
routines open in the matching editor. **Export L5X** re-emits a schema-valid project with only
your changes. Use the **C translation** export to build a simulation or port the logic.

### F. Build the handover/audit pack

Validation result, health report, I/O list, module report, network diagrams, node configuration
JSON and decoded logic renditions — all exportable, all generated offline.

### G. Generate a new conveyor section (bonus workflow)

The **Conveyor studio** builds a conveyor (roller/ZPA or belt, curves/spirals, merges,
pushers/rotary tables/cross-belt transfers, scan zones) from the real SAMPLE_RLL templates and emits
a BOM (CSV/Markdown), a schema-validated **L5X** program (program or controller export) and a
self-contained **HTML5 HMI** with tracking table + simulator. See [CONVEYOR.md](CONVEYOR.md).

---

## 4. Where things are in the UI

- **Activity rail (left)** — groups: Workspace (project diagram, I/O map, I/O list, Module I/O,
  DeviceNet, data types, ACD, AOI), Analyze (validation, health), Build (convert, conveyor).
- **Sidebar tree** — controller, tasks/programs/routines, data types, modules, AOIs, plus
  **DeviceNet networks → nodes** once a `.DNT` is loaded. Click any leaf to open it in a tab.
- **Tabs** — every view and every routine/node opens in its own closeable tab; **Home** is the
  dashboard with feature cards; tabs can be reopened from the rail, dashboard or palette after
  closing.
- **Command palette (Ctrl+K)** — jump to any view, routine, data type, module or DeviceNet node.
- **Status bar** — load/parse/validation status and errors.
- **Viewport controls** — drag to pan, wheel to zoom, **Fit/100 %** on diagrams; editors have
  scrollbars and zoom controls.

## 5. Outputs

| Output | Where | Format |
|---|---|---|
| Project/network diagrams | Module I/O, project diagram, DeviceNet | `.mmd`, `.svg` |
| Module usage report | Module I/O | Markdown, JSON |
| I/O list | I/O list | CSV, Markdown |
| Health report | Health | Markdown |
| Validation | Validation | errors/warnings list (XPaths) |
| Converted project | Convert → Export | `.L5X` (schema-validated) |
| C translation | Export C | `plcmodel.h` / `plcmodel.c` |
| Device node configuration | DeviceNet node | JSON |
| Decoded device logic | Node → Logic | FBD `.svg`, Ladder `.lad.txt`, ST `.st.txt`, Labels `.json`, raw JSON |
| Conveyor package | Conveyor studio | BOM CSV/MD, `.L5X`, HTML HMI, tag CSV |

## 6. Known limitations (read before an audit)

- **ACD logic is not decodable** by this tool: only metadata (identity, data types, tags,
  archive inventory). Always request the L5X export for logic.
- **HTML logic is RSNetWorx's FBD rendition** of the card's logic — Allen-Bradley converts
  ladder to function blocks for that report, so block structure/parameters are faithful but the
  original ladder drawing is not recovered. Unbound inputs are the card's local/network I/O;
  their exact external wiring is not printed by the export.
- **Label cross-references are inferred** where the vendor files do not state them explicitly
  (the UI marks these as inferred): byte→zone-connection split, and the association of
  descriptions/aliases with blocks.
- **DNT parsing is reverse-engineered**: no per-node RPI (only scanner EPR), scan lists are not
  present for some templates, and unknown future format revisions may add fields.
- **Conversions approximate** some constructs and say so in the warning list; helper tags
  (`L5X_TMP_n`) are auto-declared on export and reported.
- **Schema validation** covers structure/enumerations, not semantic correctness of your logic.
- The app is a **browser application**: very large projects are bounded by the browser's memory;
  keep exports/targets reasonable.

## 7. Legal/ethical note

Reverse-engineering vendor products and machine programs is legitimate for interoperability,
maintenance, migration and audit work, but it is your responsibility to have authorisation for
the systems you open and to respect the vendor's licence terms. This app only reads the files you
give it, locally; it does not bypass any licence or protection mechanism.

## 9. Acknowledgements

This tool was built by analysing the following community projects (no third-party code is
vendored; everything here is original JavaScript) — see
[README Credits](../README.md#credits--analysed-projects) for the full attribution table:

| Project | Licence | Used as a reference for |
|---|---|---|
| [benmusson/l5x-schema](https://github.com/benmusson/l5x-schema) | MIT | Official L5X XSD schemas v32–v38 → validation rules |
| [tnunnink/ioList](https://github.com/tnunnink/ioList) | MS-PL-style | I/O-list generation model, buffer-tag detection |
| [jvalenzuela/l5x](https://github.com/jvalenzuela/l5x) | GPL-3.0 (semantics only) | L5K value decoding semantics |
| [hutcheb/acd](https://github.com/hutcheb/acd) | MIT | ACD archive layout and metadata reading |
| [alairjunior/l5x2c](https://github.com/alairjunior/l5x2c) | MIT | Ladder→C model, `plcmodel` runtime semantics |
| [cmseaton42/Allen-Bradley-Toolkit](https://github.com/cmseaton42/Allen-Bradley-Toolkit) | see upstream | L5X element-creation templates/defaults |
| [JeremyMedders/LogixLibraries](https://github.com/JeremyMedders/LogixLibraries) | MIT | AOI/UDT-heavy L5X corpus for parser validation |

Other sources: **Rockwell 1756-RM014** (L5X/instruction semantics; the extracted text used during
development is not redistributed), **RSNetWorx for DeviceNet** (`.dnt` and HTML report formats were
reverse-engineered independently from real files; no vendor code/tools included), **Studio 5000
ACD** archives, the in-house **in-house roller part-number configurator** and **plant master
parts list** (conveyor component/cost data), and the **site controller project samples**
ZPA templates used as demo corpus. Please keep these acknowledgements with any reuse of the code.

## 8. How confidence was established

Parsers were developed against real artefacts (controller L5X exports, an ACD archive, DeviceNet networks and RONET/zone-card
DNT files and their RSNetWorx HTML reports) and locked down with **19 test suites / 433
checks**, including: format parsing, cross-references, schema-valid export of changed routines,
all four accepted file types, UI smoke tests and real headless-Chrome probes. See
[README §Development](../README.md#development) and the test files under `test/`.
