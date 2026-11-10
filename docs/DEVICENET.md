# DeviceNet `.dnt` import — format notes and app integration

`js/dnet.js` reads RSNetWorx for DeviceNet network configuration files (`.dnt`) directly in the
browser or Node, so a Logix project can be shown **together with the remote DeviceNet I/O** that
lives behind a `1756-DNB` scanner (something an L5X/ACD cannot describe on its own).

## What the file is

- Standard **OLE2 / CFB compound document** (512-byte sectors); root-storage CLSID
  `{C61A5113-5C44-11D1-8922-A224F60D2D07}` identifies an RSNetWorx DeviceNet document.
- No compression, no XML. Two data sources matter:
  - **`DNet Configuration`** root stream — device table:
    `u32 version, u32 count`, then per device: `u8 MAC, u8 flags, u8[3], u32 variantKey,
    u16 vendorId, u16 deviceType, u16 productCode, u8 major, u8 minor, u32 nameLength,
    UTF-16 name, u32 descriptionLength, UTF-16 description, u32 0`.
  - **Scanner stream** (an MFC CArchive graph containing `CScannerData`/`CSlaveData`) —
    scanner timing plus one fixed 124-byte record per node in ascending MAC order:
    active flag, transfer type (1 Polled, 4 COS/Cyclic), device type/product code,
    input/output bytes, **input bit length + bit offset**, **output bit length + bit offset**.
- Per-node storages (named by decimal MAC) hold `EDS Applet Device Configuration` parameter
  values (e.g. zone MAC IDs, zone produced EPR) and plugin storage point labels.
- The **catalog string is not stored** — RSNetWorx resolves it from EDS. `js/dnet.js` carries a
  small identity table (covers all identities seen so far: `1/12/14` → 1756-DNB,
  `1/7/166` → 1799-ZCIOV, `1/7/1062` → 100-DNY42R, `1/126/46888` → PowerFlex 22B) and keeps
  unknown identities rather than dropping them.
- Network name is not stored either; the file name is used. No per-node RPI is stored (the file
  has the scanner EPR only — the PLC↔scanner RPI comes from the L5X).

Layouts were validated against the RSNetWorx HTML report exports that sit next to these files
(8 zone cards, scan-list sizes/offsets and memory map matched exactly).

## Decoded node logic (FBD) from the RSNetWorx HTML export

RSNetWorx's *Export to HTML* report contains a **Logic** section per configurable device: the
card's ladder logic ported to a function-block rendition (`Seq No | Attributes | Bound to`).
`js/dnet-html.js` parses it and the node view renders it:

- blocks: `SR LATCH`, `RS LATCH`, `AND`, `OR`, `ON/OFF DELAY TIMER`, `PULSE TIMER`, `UP COUNTER`
  with parameters (Preset, Timebase) and bindings (`Input: Function Block 16 (ON DELAY TIMER)`,
  `Input 2: (complement) Function Block 1 (SR LATCH)`);
- layout: dependency layers become columns; bound inputs draw as edges (dashed = complemented);
  inputs without a bound block are the card's local/network I/O;
- tab controls: pan/zoom, a function-block table and `.svg`/`.md` downloads;
- association: the report is matched to the loaded `.dnt` by file name (`H:\\ZONE_TEMPLATE.dnt`),
  otherwise it is browsed standalone as a logic-only network.

**Local-logic cross reference.** The `.dnt` plugin storage also carries the card's configured
logic labels. `js/dnet.js` decodes the `CFbIDofTag` table (tag name → function-block sequence,
e.g. `Latch_1` → FB 1, `Timer_5` → FB 19) and `js/dnet-html.js` recovers the descriptive
labels and I/O aliases from the surrounding strings: `ZONE 1 PE` → `DIP.8` (device input),
`Out-of-Service from GFX` → `CNB.10` (consumed network bit), `%Tray Present to Downstream` →
`PNB.1` (produced network bit), `Run Zone 1 Motor` → `DOP.8` (device output). The FBD blocks and
their unbound inputs are annotated with those labels; the **Labels** view lists the recovered
aliases and tagged blocks (a cross-reference is inferred, and marked as such).

**Language renditions.** The Logic tab converts the decoded device logic between design
languages: **FBD** (layered drawing), **Ladder** — rendered as a real ladder diagram (rung rails,
series contacts, parallel branches, coils, rung comments) in a read-only instance of the same
`LadderEditor` used by the routine view; the text form remains available under *Ladder text
(downloadable)*. It is built from the decoded blocks as ladder IR (`XIC/XIO/OTE/OTL/OTU` for
boolean/latch blocks, `TON/TOF/TP/CTU` for timers/counters). **Structured Text** is
`:= SR_LATCH(...)`, `TON(...)`, boolean `AND/OR/NOT` expressions with `IO<seq>_<n>` placeholders
for unbound inputs; **Labels** shows the cross-reference tables and **JSON** the raw decoded
blocks. Each rendition downloads from the view.

Known content: `ZONE_TEMPLATE.html` — 12 devices, 9 with logic, 712 blocks (zone card 64, CT cards
81 each); `zone-card code.html` — 4 zone-card variants, 174 blocks. The bound-to column only
lists function-block links, so unbound inputs are shown as local/network I/O rather than guessed.

### Zone mapping: what the dots mean and what each bit maps to

The **Zone mapping** tab shows the card's configured zone-data tag database (`Zone Data (Byte n,Bit m)`).
A dot means **the bit has a configured tag** in the card's tag database (not that it is wired to a
signal by itself). The decoded tag id comes from the plugin-storage record (`extractZoneTags`;
ids 33..96 on the 1799-ZCIOV). Below the aligned grid, the cross-reference table shows for every bit:

- **zone connection** — which configured zone connection carries the byte (`#n MAC .. · EPR .. · offset n`,
  from the EDS/HTML parameters; the byte→connection split is inferred from the connection offsets);
- **DeviceNet input assembly bit** — when the byte falls inside the card's consumed I/O assembly, the
  scanner image bit derived from the DNT scan-list offset (e.g. `Local:1:I.Data[100].0`), plus which
  routines reference that word (from the L5X merge);
- **outside I/O assembly** for zone-data bytes that the DeviceNet assembly does not carry (they travel
  on the zone connections only). The card consumes 7 bytes (56 bits) while the zone-data tag database
  covers 8 bytes, so byte 7 is shown as zone-connection-only.

The grid uses fixed column widths so the dots line up with the Bit 0..7 headers.

## Node configuration ("code") view

Every remote node can be inspected like a routine:

- the network and its nodes appear in the **project sidebar** under *DeviceNet networks* (and in the
  command palette as *MAC n — name*);
- clicking a node opens a tab with its configuration: **Parameters** (EDS applet settings, with
  inferred meanings for the 1799-ZCIOV zone card: zone produced EPR, zone connection MAC IDs),
  **Zone mapping** (the decoded `Zone Data (Byte n,Bit m)` grid from the plugin-storage stream plus
  the card's local-logic labels), **Point labels** (network inputs/outputs, local inputs/outputs)
  and **Raw config** (all printable strings recovered from the stream). The node JSON can be
  downloaded for offline comparison.

## What the app does with it

- **Open a .dnt like any project file**: the Open dialog accepts `.dnt`, there is a **DeviceNet**
  workspace in the activity rail / command palette / dashboard, and the panel offers
  *Open DeviceNet (.dnt)…* too. Standalone, the workspace shows the scanner configuration
  (EPR/interscan/poll ratio/retries), the node table (MAC / name / catalog / transfer / I/O
  sizes / scan-list bit offsets), per-node **EDS parameters**, and a network Mermaid diagram
  with **per-transfer-type and per-bus colours**, pan/zoomable (drag to pan, wheel to zoom,
  Fit/100%). The node table uses proper table rows so headers and columns stay aligned.
- **Network transport semantics**: image words (`I.Data` / `O.Data`) are labelled with how they
  travel and coloured per network type (EtherNet/IP green, DeviceNet orange, ControlNet blue,
  DH+ red, backplane grey). **1799-ZCIOV zone cards are marked as local-logic devices**: network
  input words carry the sensor/command bits over DeviceNet and the card executes its own zone
  logic from them (the sensor-over-network \u2192 local-logic pattern).
- With an L5X (or ACD) open, the same nodes merge into the Module I/O and Inter-module flow
  views with their scanner image words (`Local:1:I.Data[n]`) and usage flags; attachments
  persist when you switch projects.

1. **Module I/O → Attach DeviceNet (.dnt)…** parses the file, then merges every mapped node under
   the matching `1756-DNB` bridge (auto-selected when there is one scanner; a bridge selector
   appears when the project has several).
2. Each node becomes a module in the analysis (`kind: "devicenet"`) with MAC, name, catalog,
   transfer type, I/O sizes and the **L5X scanner image words** derived from the scan-list bit
   offsets, e.g. `MAC 2 ZPA-1 4-ZONE` → `Local:1:I.Data[100] … Local:1:I.Data[101]`,
   `Local:1:O.Data[100]`; usage/references of those words come from the project's own I/O points.
3. The **Inter-module flow** view shows the whole chain: controller → chassis bridges (DNB) →
   DeviceNet nodes, plus a DeviceNet table (MAC/name/catalog/transfer/I/O bytes/L5X words) and the
   scanner configuration; the per-node **Bit map** tab lists the L5X words and whether logic uses
   them. Scanner EPR/interscan/poll-ratio are shown next to the L5X RPI.
4. Without a DeviceNet file the same views show the scanner segment as "scan list not in L5X —
   attach .dnt", which is exactly the gap the file fills.

## Demonstrated on

- `ZONE_TEMPLATE.dnt` — 12-table / 11 mapped nodes: 1756-DNB scanner, 100-DNY42R power
  distribution, ZPA-1 4-zone, 8 × 1799-ZCIOV zone cards (CT-1,2 … CT-15,16), PowerFlex 22B VFD.
  Scanner EPR 75 ms / interscan 10 ms / poll ratio 1 / retries 1; scan list uses 407 B of the
  500 B input connection.
- `TRAY-CONVEYOR-TEMPLATE.dnt` — 24-device template library (no scanner): 1..8-zone conveyors,
  diverters, merges, lift gates, spirals, cross transfers.
- `zone-card code.dnt` — 4 zone-card configuration templates (scan zone / normal zone counts).

## Limits / honest notes

- Catalog suggestions depend on the small identity table; a full EDS database would be needed for
  arbitrary vendors.
- No per-node RPI in the format; EPR is a scanner-level value.
- Node storage/plugin-storage framing is not fully decoded (point labels are text-rich but not
  structurally mapped yet).
- Attach is optional enrichment: the L5X/ACD view remains fully functional without a `.dnt`, and
  an ACD project's logic still requires an L5X export for module-level analysis.

## Sources and credits

The `.dnt` container and stream formats were **independently reverse-engineered** from real
RSNetWorx files (ZONE_TEMPLATE, zone card, TRAY templates and their HTML reports); no Rockwell code,
tools or documentation extracts are redistributed. The OLE2/CFB compound-file reading approach
follows the published findings of [hutcheb/acd](https://github.com/hutcheb/acd) (MIT). RSNetWorx
and DeviceNet are trademarks of Rockwell Automation; this project is not affiliated with or
endorsed by Rockwell Automation. See the main [README credits](../README.md#credits--analysed-projects).
