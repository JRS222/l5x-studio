/* Lead tests: ACD archive reader + ACD metadata model + AOI definitions. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const JS = p => require(path.join(__dirname, "..", "js", p));
const acdApi = JS("acd.js");
const modelApi = JS("l5x-model.js");

const ACD_REAL = process.env.L5X_STUDIO_ACD || null;
const ACD_CORPUS = path.join(__dirname, "..", "..", "repo-analysis", "acd", "resources", "ACDTestsWithAOI.ACD");
const L5X_REAL = "C:/samples/controller.L5X";
const AOI_L5X = path.join(__dirname, "..", "..", "repo-analysis", "LogixLibraries", "src", "Device", "Rockwell", "PowerFlex 525", "Dvc_PF525_AOI.L5X");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 5).join("\n     ")); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 5).join("\n     ")); }
}

function readBuf(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

(async () => {
  const hasReal = fs.existsSync(ACD_REAL);
  if (hasReal) {
    const res = await acdApi.readAcd(readBuf(ACD_REAL));
    await ta("ACD: archive parses", () => {
      assert.ok(res.files.length >= 20, "archive file count: " + res.files.length);
      for (const f of res.files) assert.ok(f.name && f.size >= 0, "record fields");
    });
    await ta("ACD: controller identity", () => {
      assert.ok(res.controller, "controller");
      assert.equal(res.controller.name, "LCS_HARD_PLC");
      assert.match(res.controller.swVersion, /v32/);
      assert.ok(res.controller.deviceIdentity, "device identity");
    });
    await ta("ACD: data type database", () => {
      assert.ok(res.dataTypes.length > 200, "types: " + res.dataTypes.length);
      const user = res.dataTypes.filter(d => d.class === "User");
      assert.ok(user.length >= 30, "user types: " + user.length);
      const one = res.dataTypes.find(d => d.members.length > 3);
      assert.ok(one, "types have members");
      assert.ok(one.members[0].offset !== null || one.members[0].bit !== null, "members carry offsets");
    });
    await ta("ACD: tag database", () => {
      assert.ok(res.tags.length > 500, "tags: " + res.tags.length);
      assert.equal(res.programs.length, 17);
      assert.ok(res.tags.some(t => t.scope === "controller"));
      assert.ok(res.tags.some(t => /^program:/.test(t.scope)));
    });
    await ta("ACD: tags match L5X project", () => {
      const model = modelApi.parseL5X(fs.readFileSync(L5X_REAL, "utf8"));
      const acdTags = new Set(res.tags.filter(t => t.scope === "controller").map(t => t.name));
      for (const lgxTag of model.tags.controller) {
        assert.ok(acdTags.has(lgxTag.name), "controller tag missing from ACD: " + lgxTag.name);
      }
      const acdUserTypes = new Set(res.dataTypes.filter(d => d.class === "User").map(d => d.name));
      for (const dt of model.dataTypes) assert.ok(acdUserTypes.has(dt.name), "UDT missing from ACD: " + dt.name);
      const acdPrograms = new Set(res.programs.map(p => p.name));
      for (const p of model.programs) assert.ok(acdPrograms.has(p.name), "program missing from ACD: " + p.name);
    });
  } else {
    console.log("skip ACD real-project tests (file not found: " + ACD_REAL + ")");
  }

  await ta("ACD: reader accepts the hutcheb test archive", async () => {
    if (!fs.existsSync(ACD_CORPUS)) { console.log("     (corpus missing, skipped)"); return; }
    const res = await acdApi.readAcd(readBuf(ACD_CORPUS));
    assert.ok(res.files.length === 25, "files: " + res.files.length);
    assert.equal(res.controller.name, "ACDTests");
    assert.ok(res.dataTypes.length >= 200);
  });

  await ta("ACD: metadata model builds", () => {
    const fake = {
      dataTypes: [{ name: "MY_UDT", size: 8, class: "User", members: [
        { name: "A", dataType: "BOOL", offset: 0, bit: 0, dimensions: [], children: null },
        { name: "B", dataType: "DINT", offset: 4, bit: null, dimensions: [4], children: null }
      ] }]
    };
    const tree = acdApi.dataTypeToMemberTree(fake.dataTypes[0]);
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[1].dimension, 4);
    assert.equal(tree.children[0].acdOffset, 0);
    assert.equal(tree.children[0].acdBit, 0);
  });

  // AOI definitions from the LogixLibraries corpus
  await ta("AOI: LogixLibraries AOI file parses", () => {
    if (!fs.existsSync(AOI_L5X)) { console.log("     (corpus missing, skipped)"); return; }
    const model = modelApi.parseL5X(fs.readFileSync(AOI_L5X, "utf8"));
    assert.ok(model.addOnInstructions.length >= 1, "AOI definitions found: " + model.addOnInstructions.length);
    const aoi = model.addOnInstructions[0];
    assert.ok(aoi.name, "AOI name");
    assert.ok(aoi.parameters.length > 0, "parameters: " + aoi.parameters.length);
    assert.ok(aoi.localTags.length > 0, "local tags: " + aoi.localTags.length);
    assert.ok(aoi.routines.length > 0, "routines: " + aoi.routines.length);
    assert.ok(aoi.parameters[0].tagType, "parameter tag type");
    assert.ok(typeof model.findAoi === "function" && model.findAoi(aoi.name), "findAoi");
    // routine content parsed like program routines
    const r = aoi.routines[0];
    assert.ok(["rll", "st", "fbd", "sfc", "raw"].indexOf(r.content.kind) !== -1, "routine content kind");
  });

  await ta("AOI: project without AOIs reports none (sample project)", () => {
  if (!fs.existsSync(L5X_REAL)) { console.log("skip: site L5X sample not available"); return; }
    const model = modelApi.parseL5X(fs.readFileSync(L5X_REAL, "utf8"));
    assert.equal(model.addOnInstructions.length, 0);
  });

  console.log("\nacd-aoi: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
