/* L5X Studio - T2 tests: I/O list export + L5K value decoding.
   Covers js/io-list.js, js/l5k-data.js and js/ui/iolist-panel.js against the three
   real projects (SAMPLE_RLL/SAMPLE_PROCESS/SAMPLE_ST). Run with the bundled Node:
     node test/t4-iolist.test.js
   Prints a summary and exits non-zero on failure. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const JS = p => require(path.join(__dirname, "..", "js", p));

const modelApi = JS("l5x-model.js");
const ioList = JS("io-list.js");
const l5k = JS("l5k-data.js");
const panelApi = JS("ui/iolist-panel.js");

const FILES = {
  SAMPLE_RLL: "C:/samples/controller.L5X",
  SAMPLE_PROCESS: "C:/samples/sample-file",
  SAMPLE_ST: "C:/samples/structured-text.L5X"
};
if (!fs.existsSync(FILES.SAMPLE_RLL)) { console.log("skip: site sample not available"); process.exit(0); }

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    pass++;
    console.log("ok   " + name + (Date.now() - t0 > 250 ? " (" + (Date.now() - t0) + " ms)" : ""));
  } catch (e) {
    fail++;
    failures.push(name + ": " + (e && e.message ? e.message : e));
    console.log("FAIL " + name);
    const detail = e && e.stack ? String(e.stack).split("\n").slice(1, 4).join("\n     ") : "";
    console.log("     " + (e && e.message ? e.message : e));
    if (detail) console.log("     " + detail);
  }
}
function tlog(msg) { console.log("     " + msg); }

/* ------------------------------------------------------------------ fixtures */

const models = {};
for (const key of Object.keys(FILES)) {
  assert.ok(fs.existsSync(FILES[key]), "missing real project fixture: " + FILES[key]);
  const model = modelApi.parseL5X(fs.readFileSync(FILES[key], "utf8"));
  model.fileName = path.basename(FILES[key]);
  models[key] = model;
}
const SAMPLE_RLL = models.SAMPLE_RLL, SAMPLE_PROCESS = models.SAMPLE_PROCESS, SAMPLE_ST = models.SAMPLE_ST;

const ioCache = {};
function ioRows(key, opts) {
  if (!ioCache[key]) ioCache[key] = ioList.buildIoListRows(models[key], opts || {});
  return ioCache[key];
}
const SAMPLE_RLL_ROWS = ioRows("SAMPLE_RLL");
const SAMPLE_ST_ROWS = ioRows("SAMPLE_ST");
const SAMPLE_PROCESS_ROWS = ioRows("SAMPLE_PROCESS");

/* ------------------------------------------------------------- CSV utilities */

/* RFC 4180 reader — enough to prove our writer quotes/escapes correctly. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === "\"") { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 2; else i++;
      row.push(field); rows.push(row);
      row = []; field = "";
      continue;
    }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findRow(rows, address) {
  return rows.find(r => r.address.toUpperCase() === address.toUpperCase());
}

const DEFAULT_COLS = ioList.defaultIoListColumns();
const LABELS = DEFAULT_COLS.map(c => c.label);

/* ============================================================ I/O list: SAMPLE_RLL */

t("SAMPLE_RLL: builds more than 50 rows", () => {
  assert.ok(SAMPLE_RLL_ROWS.length > 50, "rows: " + SAMPLE_RLL_ROWS.length);
  tlog(SAMPLE_RLL_ROWS.length + " rows, " + SAMPLE_RLL_ROWS.filter(r => r.used).length + " used, " +
    SAMPLE_RLL_ROWS.filter(r => r.bufferTag).length + " with buffer tags");
});

t("SAMPLE_RLL: row shape matches the contract", () => {
  const row = findRow(SAMPLE_RLL_ROWS, "GROUP01:I.Data");
  assert.ok(row, "GROUP01:I.Data row exists");
  for (const key of ["moduleName", "catalogNumber", "rack", "slotOrAddress", "direction",
    "address", "pointPath", "dataType", "description", "value", "used", "references",
    "bufferTag", "bufferDescription", "unit", "high", "low", "moduleKind", "inhibited"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), "row has field " + key);
  }
  assert.equal(typeof row.used, "boolean");
  assert.equal(typeof row.moduleKind, "string");
  assert.equal(typeof row.inhibited, "boolean");
  assert.ok(Array.isArray(row.references));
  assert.ok(["Input", "Output", "Config"].indexOf(row.direction) !== -1);
  for (const r of SAMPLE_RLL_ROWS) {
    assert.equal(typeof r.moduleName, "string");
    assert.equal(typeof r.address, "string");
    assert.ok(["Input", "Output", "Config"].indexOf(r.direction) !== -1);
    assert.equal(typeof r.used, "boolean");
    assert.ok(Array.isArray(r.references));
  }
});

t("SAMPLE_RLL: GROUP01 input/output addresses and PDP rows", () => {
  assert.ok(SAMPLE_RLL_ROWS.some(r => /^GROUP01:I\.Data/.test(r.address)), "GROUP01:I.Data present");
  assert.ok(SAMPLE_RLL_ROWS.some(r => /^GROUP01:O\.Data/.test(r.address)), "GROUP01:O.Data present");
  assert.ok(SAMPLE_RLL_ROWS.some(r => /^GROUP01:I\./.test(r.address)), "GROUP01 inputs present");
  const pdp = SAMPLE_RLL_ROWS.filter(r => r.moduleName === "PDP");
  assert.ok(pdp.length > 0, "PDP rows exist");
  assert.ok(pdp.some(r => r.address === "PDP:I.Data"), "PDP:I.Data row");
  assert.match(pdp[0].catalogNumber, /1799ER/);
});

t("SAMPLE_RLL: network modules use name tags, chassis modules slot tags", () => {
  const gr = findRow(SAMPLE_RLL_ROWS, "GROUP01:I.Data");
  assert.equal(gr.moduleKind, "Network");
  assert.equal(gr.localAddress, "");
  assert.equal(gr.rack, "Local chassis");
  const net = SAMPLE_RLL_ROWS.filter(r => r.moduleName === "Network1" && r.direction === "Input");
  assert.ok(net.length > 0, "Network1 input rows");
  assert.ok(net[0].address.indexOf("Local:1:I") === 0, "slot-addressed: " + net[0].address);
  assert.equal(net[0].moduleKind, "Chassis");
  assert.ok(net[0].localAddress.indexOf("Local:1:I") === 0, "localAddress slot form");
  assert.equal(net[0].slotOrAddress, "1");
  // Ethernet modules carry the IP in slotOrAddress
  assert.equal(gr.slotOrAddress, "192.168.1.51");
});

t("SAMPLE_RLL: references + used flag from logic", () => {
  const row = findRow(SAMPLE_RLL_ROWS, "GROUP01:I.Data");
  assert.equal(row.used, true, "GROUP01:I.Data is used");
  assert.ok(row.references.length >= 1, "has references");
  const ref = row.references[0];
  assert.equal(typeof ref.program, "string");
  assert.equal(typeof ref.routine, "string");
  assert.equal(typeof ref.scope, "string");
  assert.ok(/ENET_PUSHER_INPUTS/.test(ref.routine), "reference routine: " + ref.routine);
  const out = findRow(SAMPLE_RLL_ROWS, "GROUP01:O.Data");
  assert.equal(out.used, true, "GROUP01:O.Data is used");
  assert.ok(out.references.some(r => /ENET_PUSHER_OUTPUTS/.test(r.routine)), "output routine ref");
  const pdp = findRow(SAMPLE_RLL_ROWS, "PDP:I.Data");
  assert.equal(pdp.used, true, "PDP:I.Data used");
  const unused = SAMPLE_RLL_ROWS.filter(r => !r.used);
  assert.ok(unused.length > 0, "some module points are unused");
});

t("SAMPLE_RLL: tnunnink-style buffer detection (ENET_* / GR buffers)", () => {
  const withBuffer = SAMPLE_RLL_ROWS.filter(r => r.bufferTag);
  assert.ok(withBuffer.length > 0, "buffer tags found");
  const grIn = findRow(SAMPLE_RLL_ROWS, "GROUP01:I.Data");
  assert.equal(grIn.bufferTag, "ENET_INPUTS", "GROUP01 input buffer");
  const grOut = findRow(SAMPLE_RLL_ROWS, "GROUP01:O.Data");
  assert.equal(grOut.bufferTag, "ENET_OUTPUTS", "GROUP01 output buffer");
  assert.ok(grIn.references.length >= 1);
  // other GR modules found through the same pattern
  const grBuffers = SAMPLE_RLL_ROWS.filter(r => /^GR\d\d:/.test(r.address) && r.bufferTag);
  assert.ok(grBuffers.length >= 2, "multiple GR points with buffers: " + grBuffers.length);
  tlog("example: " + grIn.address + " -> buffer " + grIn.bufferTag + " (" + grIn.bufferSource + ")");
});

t("SAMPLE_RLL: module ConfigTag engineering members appear as Config rows", () => {
  const grCfg = SAMPLE_RLL_ROWS.filter(r => r.moduleName === "GROUP01" && r.direction === "Config");
  assert.ok(grCfg.length > 0, "GROUP01 config rows");
  assert.ok(grCfg.some(r => /^GROUP01:C\.Filter/.test(r.address)), "config member address: " + grCfg[0].address);
  // generic ETHERNET-MODULE padding config arrays are suppressed
  assert.ok(!SAMPLE_RLL_ROWS.some(r => /^MTRAC_PIECE1:C\.Data\[\d+\]$/.test(r.address)), "no generic config padding rows");
  // unit/high/low fields exist on every row (populated only when the module config declares them)
  for (const row of SAMPLE_RLL_ROWS.slice(0, 200)) {
    assert.equal(typeof row.unit, "string");
    assert.equal(typeof row.high, "string");
    assert.equal(typeof row.low, "string");
  }
});

t("unit/high/low: analog ConfigTag members map onto input points", () => {
  const member = (name, dataType, value) => ({ name: name, dataType: dataType, dimension: 0, radix: null,
    hidden: false, externalAccess: null, description: null, children: null, value: value, elements: null });
  const synthetic = {
    fileName: "SYNTH.L5X",
    controller: { name: "SYNTH", softwareRevision: "32.03" },
    dataTypes: [], tags: { controller: [], programs: {} }, programs: [], tasks: [],
    addOnInstructions: [], raw: {}, changes: {}, warnings: [],
    modules: [
      {
        name: "AI1", catalogNumber: "1799-IE8/A", parentModule: "Local", parentModPortId: "2",
        inhibited: false, majorFault: false, ports: [{ id: "2", address: "192.168.1.9", type: "Ethernet", upstream: true }],
        communications: { connections: [] },
        ioImages: {
          input: { name: "", dataType: "AB:1799_IE8:I:0", dimension: 0, children: [
            member("Ch0Data", "INT", "0"), member("Ch1Data", "INT", "0")
          ], value: null, elements: null },
          output: null,
          config: { name: "", dataType: "AB:1799_IE8:C:0", dimension: 0, children: [
            member("Ch0HighEngineering", "REAL", "100.0"),
            member("Ch0LowEngineering", "REAL", "0.0"),
            member("Ch0Unit", "STRING", "'PSI'"),
            member("Ch1HighEngineering", "REAL", "50.0"),
            member("Ch1LowEngineering", "REAL", "-10.0"),
            member("Ch1Unit", "STRING", "'DEG'")
          ], value: null, elements: null }
        }
      },
      { name: "Local", catalogNumber: "1756-L83E", parentModule: "Local", parentModPortId: "1",
        inhibited: false, ports: [], communications: null, ioImages: { input: null, output: null, config: null } }
    ]
  };
  const rows = ioList.buildIoListRows(synthetic, {});
  const ch0 = rows.find(r => r.moduleName === "AI1" && r.address === "AI1:I.Ch0Data");
  const ch1 = rows.find(r => r.moduleName === "AI1" && r.address === "AI1:I.Ch1Data");
  assert.ok(ch0, "synthetic input row");
  assert.ok(ch1, "synthetic second input row");
  assert.equal(ch0.high, "100.0");
  assert.equal(ch0.low, "0.0");
  assert.equal(ch0.unit, "'PSI'");
  assert.equal(ch1.high, "50.0");
  assert.equal(ch1.low, "-10.0");
  assert.equal(ch1.unit, "'DEG'");
});

/* ======================================================= I/O list: SAMPLE_ST / SAMPLE_PROCESS */

t("SAMPLE_ST: rows, Network1 references, remote-chassis addressing", () => {
  assert.ok(SAMPLE_ST_ROWS.length > 50, "SAMPLE_ST rows: " + SAMPLE_ST_ROWS.length);
  const net = findRow(SAMPLE_ST_ROWS, "Network1:I.Data[0]");
  assert.ok(net, "Network1:I.Data[0] row");
  assert.equal(net.used, true, "referenced by MainProgram/MappedIO");
  assert.ok(net.references.some(r => r.program === "MainProgram"), "reference program");
  // 1794-AENT remote chassis: adapter:slot form
  const enc = SAMPLE_ST_ROWS.filter(r => r.moduleName === "Encoder1");
  assert.ok(enc.length > 0, "Encoder1 rows");
  assert.ok(enc[0].address.indexOf("Belt1:0:") === 0, "Belt1:0 address: " + enc[0].address);
  assert.equal(enc[0].moduleKind, "Chassis");
  tlog(SAMPLE_ST_ROWS.length + " rows, " + SAMPLE_ST_ROWS.filter(r => r.used).length + " used, " +
    SAMPLE_ST_ROWS.filter(r => r.bufferTag).length + " with buffers");
});

t("SAMPLE_PROCESS: rows, slot-form chassis tags, alias-derived usage", () => {
  assert.ok(SAMPLE_PROCESS_ROWS.length > 0, "SAMPLE_PROCESS rows: " + SAMPLE_PROCESS_ROWS.length);
  const dnb = SAMPLE_PROCESS_ROWS.filter(r => r.moduleName === "DNB" && r.direction === "Input");
  assert.ok(dnb.length > 0, "DNB input rows");
  assert.ok(/^Local:1:I\./.test(dnb[0].address), "DNB slot-form address: " + dnb[0].address);
  assert.equal(dnb[0].moduleKind, "Chassis");
  const aliasRows = SAMPLE_PROCESS_ROWS.filter(r => (r.references || []).some(ref => ref.via));
  assert.ok(aliasRows.length > 0, "alias-derived references exist");
  assert.ok(aliasRows.some(r => r.used), "alias references mark points used");
  const one = aliasRows[0];
  const ref = one.references.find(r => r.via);
  assert.ok(/INPUT_|OUTPUT_/.test(ref.via), "alias name captured: " + ref.via);
  tlog(SAMPLE_PROCESS_ROWS.length + " rows, " + aliasRows.length + " rows with alias references");
});

t("rows are stable/deterministic", () => {
  const again = ioList.buildIoListRows(SAMPLE_PROCESS, {});
  assert.equal(again.length, SAMPLE_PROCESS_ROWS.length);
  assert.equal(again.filter(r => r.used).length, SAMPLE_PROCESS_ROWS.filter(r => r.used).length);
});

/* ============================================================ CSV/Markdown/UI */

t("CSV: header contains the default columns and parses back", () => {
  assert.ok(DEFAULT_COLS.length >= 17, "default column count");
  const csv = ioList.toCsv(SAMPLE_RLL_ROWS, DEFAULT_COLS);
  const parsed = parseCsv(csv);
  assert.equal(parsed[0].length, DEFAULT_COLS.length, "header column count");
  assert.deepEqual(parsed[0], LABELS);
  assert.ok(LABELS.indexOf("Module") !== -1);
  assert.ok(LABELS.indexOf("Address") !== -1);
  assert.ok(LABELS.indexOf("Buffer tag") !== -1);
  assert.ok(parsed[0].indexOf("Local address") !== -1);
  assert.equal(parsed.length, SAMPLE_RLL_ROWS.length + 1, "one record per row");
  const dataRow = parsed[1];
  assert.equal(dataRow.length, DEFAULT_COLS.length, "data column count");
});

t("CSV: RFC4180 quoting handles commas, quotes and newlines", () => {
  const synth = [{
    moduleName: "M1", catalogNumber: "CAT", address: "A,\"B\"", direction: "Input",
    pointPath: "P", description: "He said \"hi\", ok\nsecond line", dataType: "DINT",
    used: true, references: [{ program: "P1", routine: "R1", scope: "controller" }],
    bufferTag: "BUF", bufferDescription: "a,b", unit: "", high: "", low: "",
    localAddress: "", rack: "Rack", slotOrAddress: "1"
  }];
  const csv = ioList.toCsv(synth, DEFAULT_COLS);
  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 2);
  const header = parsed[0];
  const cells = parsed[1];
  const idx = key => header.indexOf(DEFAULT_COLS.find(c => c.key === key).label);
  assert.equal(cells[idx("moduleName")], "M1");
  assert.equal(cells[idx("address")], "A,\"B\"");
  assert.equal(cells[idx("description")], "He said \"hi\", ok\nsecond line");
  assert.equal(cells[idx("used")], "yes");
  assert.equal(cells[idx("references")], "P1/R1");
  assert.ok(csv.indexOf("\"\"\"") !== -1 || csv.indexOf("\"\"") !== -1, "quotes doubled");
});

t("CSV: disabled columns are omitted", () => {
  const cols = ioList.defaultIoListColumns();
  cols.find(c => c.key === "catalogNumber").enabled = false;
  const csv = ioList.toCsv(SAMPLE_RLL_ROWS.slice(0, 2), cols);
  const header = parseCsv(csv)[0];
  assert.equal(header.length, cols.length - 1);
  assert.equal(header.indexOf("Catalog"), -1);
  assert.ok(header.indexOf("Module") !== -1);
});

t("Markdown: table header, separator and escaped cells", () => {
  const md = ioList.toMarkdown(SAMPLE_RLL_ROWS.slice(0, 5), DEFAULT_COLS);
  const lines = md.split("\n");
  assert.equal(lines.length, 7, "header + separator + 5 rows");
  assert.ok(lines[0].indexOf("| Module |") === 0);
  assert.ok(/^\| --- \|/.test(lines[1]), "separator row");
  assert.ok(lines[0].indexOf("Buffer tag") !== -1);
  const synth = [{ moduleName: "M", address: "A|B", direction: "Input", pointPath: "P",
    description: "line1\nline2", used: false, references: [] }];
  const single = ioList.toMarkdown(synth, DEFAULT_COLS);
  assert.ok(single.indexOf("A\\|B") !== -1, "pipe escaped");
  assert.ok(single.indexOf("line1<br>line2") !== -1, "newline converted");
});

/* ------------------------------------------------------------------ filters */

t("filters: unusedOnly / usedOnly / direction / module / search", () => {
  const all = SAMPLE_RLL_ROWS;
  const unused = ioList.applyFilters(all, { unusedOnly: true });
  assert.ok(unused.length < all.length, "unusedOnly reduces rows");
  assert.ok(unused.every(r => !r.used));
  assert.equal(unused.length, all.filter(r => !r.used).length);
  const used = ioList.applyFilters(all, { usedOnly: true });
  assert.ok(used.every(r => r.used));
  assert.equal(used.length, all.filter(r => r.used).length);
  const inputs = ioList.applyFilters(all, { direction: "Input" });
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every(r => r.direction === "Input"));
  assert.equal(inputs.length, all.filter(r => r.direction === "Input").length);
  const pdp = ioList.applyFilters(all, { module: "PDP" });
  assert.ok(pdp.length > 0);
  assert.ok(pdp.every(r => r.moduleName === "PDP"));
  const search = ioList.applyFilters(all, { search: "GROUP01:I.Data" });
  assert.ok(search.length > 0);
  assert.ok(search.every(r => (r.address + " " + r.description).toUpperCase().indexOf("GROUP01:I.DATA") !== -1));
  const combined = ioList.applyFilters(all, { module: "GR", unusedOnly: true, direction: "Input" });
  assert.ok(combined.every(r => !r.used && r.direction === "Input" && /GR/.test(r.moduleName)));
  assert.equal(ioList.applyFilters(all, null).length, all.length);
  assert.equal(ioList.applyFilters(null, { unusedOnly: true }).length, 0);
});

/* ==================================================================== L5K */

t("L5K: scalar and array literal forms", () => {
  const model = SAMPLE_RLL;
  const arr = l5k.parseL5kValue("[1,2,3]", "DINT", model);
  assert.equal(arr.kind, "array");
  assert.equal(arr.type, "DINT");
  assert.deepEqual(arr.value, [1, 2, 3]);
  assert.equal(arr.elements.length, 3);
  assert.equal(arr.raw, "[1,2,3]");

  const nested = l5k.parseL5kValue("[[1,2],[3,4]]", "INT", model);
  assert.equal(nested.kind, "array");
  assert.deepEqual(nested.value, [[1, 2], [3, 4]]);

  assert.equal(l5k.parseL5kValue("2#1010", "DINT", model).kind, "scalar");
  assert.equal(l5k.parseL5kValue("2#1010", "DINT", model).value, 10);
  assert.equal(l5k.parseL5kValue("16#FF", "DINT", model).value, 255);
  assert.equal(l5k.parseL5kValue("8#77", "DINT", model).value, 63);
  assert.equal(l5k.parseL5kValue("-1", "DINT", model).value, -1);
  assert.equal(l5k.parseL5kValue("-1.5", "REAL", model).value, -1.5);
  assert.equal(l5k.parseL5kValue("1.4e+001", "REAL", model).value, 14);
  assert.equal(l5k.parseL5kValue("TRUE", "BOOL", model).value, 1);
  assert.equal(l5k.parseL5kValue("FALSE", "BOOL", model).kind, "scalar");

  const str = l5k.parseL5kValue("'AB'", "STRING", model);
  assert.equal(str.kind, "string");
  assert.equal(str.value, "AB");

  // BOOL word bit pattern: scalar boolean value but bit pattern captured
  const boolWord = l5k.parseL5kValue("2#1010", "BOOL", model);
  assert.ok(boolWord.kind === "scalar" || boolWord.kind === "raw");
  assert.equal(boolWord.value, 1);
  assert.deepEqual(boolWord.bits, [0, 1, 0, 1]);
});

t("L5K: strings with $ escapes and STRING structures", () => {
  const model = SAMPLE_ST;
  const nul = l5k.parseL5kValue("'AB$00CD'", "STRING", model);
  assert.equal(nul.kind, "string");
  assert.equal(nul.value, "AB"); // $00 terminates the STRING value
  const esc = l5k.parseL5kValue("'A$27B'", "STRING", model);
  assert.equal(esc.value, "A'B");
  const quoted = l5k.parseL5kValue("'it$'s'", "STRING", model);
  assert.equal(quoted.value, "it's");
  const pair = l5k.parseL5kValue("[3,'80%$00$00']", "STRING", model);
  assert.equal(pair.kind, "string");
  assert.equal(pair.value, "80%");
  assert.equal(pair.length, 3);
  const strArr = l5k.parseL5kValue("[[2,'ab'],[1,'c']]", "STRING", model);
  assert.equal(strArr.kind, "array");
  assert.deepEqual(strArr.value, ["ab", "c"]);
});

t("L5K: malformed input never throws (raw + warning)", () => {
  const cases = ["[1,2", "[[1,2]", "@@@", "'unterminated", "[1,,2]", "16#", "", null, undefined];
  for (const text of cases) {
    let parsed;
    assert.doesNotThrow(() => { parsed = l5k.parseL5kValue(text, "DINT", null); });
    assert.ok(parsed && typeof parsed === "object");
    assert.ok(["raw", "scalar", "array", "struct", "string"].indexOf(parsed.kind) !== -1, "kind for " + JSON.stringify(text));
  }
  const bad = l5k.parseL5kValue("[1,2", "DINT", null);
  assert.equal(bad.kind, "raw");
  assert.ok(bad.warning, "warning present");
  assert.equal(bad.raw, "[1,2");
});

t("L5K: structure decoding maps UDT members (real SAMPLE_RLL tags)", () => {
  const t1 = SAMPLE_RLL.tags.controller.find(t => t.name === "CONFIG_IOSEOR");
  const v1 = l5k.tagInitialValue(SAMPLE_RLL, t1);
  assert.equal(v1.format, "L5K");
  assert.equal(v1.parsed.kind, "struct");
  assert.equal(v1.parsed.type, "CONFIG_IOSEOR");
  assert.equal(v1.parsed.value.SIDEINDUCTION1_IND_NUM, 1);
  assert.equal(v1.parsed.value.SIDEINDUCTION1_LBA_COUNT, 3);
  assert.equal(v1.parsed.elements.length, 18);

  const t2 = SAMPLE_RLL.tags.controller.find(t => t.name === "CONFIG_GR");
  const v2 = l5k.tagInitialValue(SAMPLE_RLL, t2).parsed;
  assert.equal(v2.kind, "struct");
  assert.ok(Array.isArray(v2.value.CENTERING_OFFSET), "CENTERING_OFFSET array");
  assert.equal(v2.value.CENTERING_OFFSET.length, 100);
  assert.equal(v2.value.CENTERING_OFFSET[1], 8);
  assert.ok(Array.isArray(v2.value.HAS_POWER_ROLL), "BOOL array member");
  assert.equal(v2.value.HAS_POWER_ROLL.length, 128);
  assert.equal(v2.value.DEAD_SENSOR_COUNT, 8);
});

t("L5K: real BOOL arrays and STRING tags (SAMPLE_ST)", () => {
  const boolTag = SAMPLE_ST.tags.controller.find(t => t.name === "ConveyorStart");
  assert.equal(boolTag.dataType, "BOOL");
  assert.equal(boolTag.dimension, 32);
  const bool = l5k.tagInitialValue(SAMPLE_ST, boolTag).parsed;
  assert.equal(bool.kind, "array");
  assert.equal(bool.value.length, 32);
  assert.ok(bool.value.every(v => v === 0 || v === 1), "bit values are 0/1");

  const bitsTag = SAMPLE_ST.tags.controller.find(t => t.name === "DivertDownLogONS");
  const bits = l5k.tagInitialValue(SAMPLE_ST, bitsTag).parsed;
  assert.equal(bits.kind, "array");
  assert.equal(bits.value.length, 64);
  assert.ok(bits.value.slice(0, 8).every(v => v === 1 || v === 0));
  assert.equal(bits.value[1], 1);

  const strTag = SAMPLE_ST.tags.controller.find(t => t.name === "EightyPercent");
  const str = l5k.tagInitialValue(SAMPLE_ST, strTag).parsed;
  assert.equal(str.kind, "string");
  assert.equal(str.value, "80%");

  const arrStrTag = SAMPLE_ST.tags.controller.find(t => t.name === "GridLockString");
  const arrStr = l5k.tagInitialValue(SAMPLE_ST, arrStrTag).parsed;
  assert.equal(arrStr.kind, "array");
  assert.ok(arrStr.value.length >= 2);
  assert.ok(arrStr.value.every(v => typeof v === "string"));
});

t("L5K: undecoded binary <Data> byte payloads (real SAMPLE_PROCESS tags)", () => {
  const dintTag = SAMPLE_PROCESS.tags.controller.find(t => t.name === "AFCS_LOG_CURRENT_DAY");
  const dint = l5k.tagInitialValue(SAMPLE_PROCESS, dintTag).parsed;
  assert.equal(dint.kind, "scalar");
  assert.equal(dint.value, 5);
  assert.equal(dint.encoding, "raw-bytes");

  const realTag = SAMPLE_PROCESS.tags.controller.find(t => t.name === "AFCS_DIFFERENTIAL");
  const real = l5k.tagInitialValue(SAMPLE_PROCESS, realTag).parsed;
  assert.equal(real.value, 0);

  const strTag = SAMPLE_PROCESS.tags.controller.find(t => t.name === "STATUS_DNET_NODE_STATUS_KEY");
  const str = l5k.tagInitialValue(SAMPLE_PROCESS, strTag).parsed;
  assert.equal(str.kind, "string");
  assert.equal(str.value, "Normal");

  const boolTag = SAMPLE_PROCESS.tags.controller.find(t => t.name === "CC_SERIES_START_REQ");
  assert.equal(boolTag.dataType, "BOOL");
  const bool = l5k.tagInitialValue(SAMPLE_PROCESS, boolTag).parsed;
  assert.equal(bool.kind, "array");
  assert.equal(bool.value.length, 32);
  assert.equal(bool.value[0], 1);

  // every initial is truthy for the first slice of controller tags (Lead integration check)
  let decoded = 0;
  for (const tag of SAMPLE_PROCESS.tags.controller.slice(0, 40)) {
    const v = l5k.tagInitialValue(SAMPLE_PROCESS, tag);
    assert.ok(v, "initial value object for " + tag.name);
    decoded++;
  }
  assert.ok(decoded > 0);
});

t("L5K: decorated values and tagInitialValue convenience", () => {
  const decorated = {
    initial: {
      format: "Decorated",
      tree: {
        name: "", dataType: "MY_UDT", dimension: 0, radix: null, hidden: false,
        externalAccess: null, description: null, value: null, elements: null,
        children: [
          { name: "COUNT", dataType: "DINT", value: "7", children: null, elements: null },
          { name: "FLAG", dataType: "BOOL", value: "1", children: null, elements: null },
          { name: "BITS", dataType: "BOOL", dimension: 4, value: null, children: null,
            elements: [{ index: "[0]", value: "1" }, { index: "[1]", value: "0" },
              { index: "[2]", value: "1" }, { index: "[3]", value: "0" }] }
        ]
      }
    }
  };
  const val = l5k.tagInitialValue({ dataTypes: [{ name: "MY_UDT", members: [] }] }, decorated);
  assert.equal(val.format, "Decorated");
  assert.equal(val.parsed.kind, "struct");
  assert.equal(val.parsed.value.COUNT, 7);
  assert.equal(val.parsed.value.FLAG, 1);
  assert.deepEqual(val.parsed.value.BITS, [1, 0, 1, 0]);

  const l5kRec = { dataType: "DINT", initial: { format: "L5K", text: "42" } };
  const val2 = l5k.tagInitialValue(null, l5kRec);
  assert.equal(val2.format, "L5K");
  assert.equal(val2.parsed.value, 42);

  assert.equal(l5k.tagInitialValue(null, null), null);
  assert.equal(l5k.tagInitialValue(null, { name: "X", dataType: "DINT" }), null);
});

t("L5K: formatL5kValue round-trips through the parser", () => {
  const cases = [
    ["[1,2,3]", "DINT"], ["2#1010", "DINT"], ["-3.5", "REAL"], ["16#FF", "DINT"],
    ["TRUE", "BOOL"], ["'AB'", "STRING"], ["[[0,1],[2,3]]", "INT"],
    ["[2#0,2#1,2#0]", "BOOL"]
  ];
  for (const [text, dt] of cases) {
    const p1 = l5k.parseL5kValue(text, dt, null);
    const formatted = l5k.formatL5kValue(p1, dt);
    assert.equal(typeof formatted, "string");
    assert.ok(formatted.length > 0, "formatted " + text);
    const p2 = l5k.parseL5kValue(formatted, dt, null);
    assert.deepEqual(p2.value, p1.value, "round trip " + text + " -> " + formatted);
  }
  // formatting a plain decoded value
  assert.equal(l5k.formatL5kValue(5, "DINT"), "5");
  assert.equal(l5k.formatL5kValue([1, 2], "DINT"), "[1,2]");
  assert.ok(/^'.*'$/.test(l5k.formatL5kValue("it's", "STRING")), "string quoted+escaped");
  // raw passthrough
  const raw = l5k.parseL5kValue("[1,2", "DINT", null);
  assert.equal(l5k.formatL5kValue(raw, "DINT"), "[1,2");
});

t("L5K: describeL5kValue is human readable and compressed", () => {
  assert.equal(l5k.describeL5kValue(l5k.parseL5kValue("2#1010", "DINT", null)), "10");
  const arr = l5k.parseL5kValue("[" + new Array(50).fill("0").join(",") + "]", "DINT", null);
  const desc = l5k.describeL5kValue(arr);
  assert.ok(desc.length > 0);
  assert.ok(desc.indexOf("50") !== -1 || desc.indexOf("\u00d7") !== -1, "run-length compressed: " + desc);
  const str = l5k.describeL5kValue(l5k.parseL5kValue("'hello'", "STRING", null));
  assert.ok(/hello/.test(str));
  const struct = l5k.describeL5kValue(l5k.tagInitialValue(SAMPLE_RLL,
    SAMPLE_RLL.tags.controller.find(t => t.name === "CONFIG_IOSEOR")).parsed);
  assert.ok(/SIDEINDUCTION1_IND_NUM/.test(struct));
  assert.equal(l5k.describeL5kValue(null), "");
});

/* ==================================================================== panel */

t("panel: module is Node-require safe and exposes the class", () => {
  assert.equal(typeof panelApi.IoListPanel, "function");
  const proto = panelApi.IoListPanel.prototype;
  for (const fn of ["refresh", "reload", "exportCsv", "exportMarkdown", "getRows", "getAllRows"]) {
    assert.equal(typeof proto[fn], "function", "method " + fn);
  }
  // requiring the panel must not need a DOM
  assert.ok(true);
});

t("io-list: performance sanity", () => {
  const t0 = Date.now();
  const rows = ioList.buildIoListRows(SAMPLE_RLL, {});
  const ms = Date.now() - t0;
  assert.ok(rows.length > 50);
  assert.ok(ms < 8000, "SAMPLE_RLL I/O list build took " + ms + " ms");
  tlog("SAMPLE_RLL full build " + ms + " ms");
});

/* ================================================================== summary */

console.log("\n===== T2 I/O list + L5K summary =====");
for (const key of ["SAMPLE_RLL", "SAMPLE_PROCESS", "SAMPLE_ST"]) {
  const rows = key === "SAMPLE_RLL" ? SAMPLE_RLL_ROWS : key === "SAMPLE_PROCESS" ? SAMPLE_PROCESS_ROWS : SAMPLE_ST_ROWS;
  const s = ioList.summarizeRows(rows);
  const modules = new Set(rows.map(r => r.moduleName));
  const buffers = new Set(rows.filter(r => r.bufferTag).map(r => r.bufferTag));
  console.log(key.padEnd(7) + rows.length + " rows (" + s.used + " used, " + s.unused + " unused, " +
    s.withBuffer + " buffered), " + modules.size + " module(s), dirs " +
    JSON.stringify(s.directions) + ", buffers: " + (Array.from(buffers).slice(0, 6).join(", ") || "-"));
}
console.log("L5K coverage: arrays/nested, based ints, reals, booleans, strings, STRING structures,");
console.log("              UDT member mapping, undecoded binary <Data>, decorated trees, malformed -> raw");
console.log("CSV sample:");
const csvSample = ioList.toCsv(SAMPLE_RLL_ROWS.slice(0, 3), DEFAULT_COLS).split("\r\n");
csvSample.forEach(line => console.log("  " + line));
console.log("\nt4-iolist: " + pass + " passed, " + fail + " failed");
if (fail) {
  console.log("failures:");
  failures.forEach(f => console.log("  - " + f));
  process.exit(1);
}
