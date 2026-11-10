/* L5X Studio — RSNetWorx for DeviceNet (.dnt) network reader.
 *
 * A .dnt file is an OLE2/CFB compound document whose streams contain the DeviceNet
 * network database: the "DNet Configuration" device table (MAC id, name, description,
 * vendor/deviceType/productCode/revision) and, when a scanner is configured, the
 * scanner stream with the full scanlist (per-node transfer type, I/O sizes and the
 * input/output assembly bit offsets). This module decodes both in the browser and in
 * Node, without dependencies, so the DeviceNet layer can be merged into the module-level
 * I/O dataflow next to the L5X/ACD project.
 *
 * Record layouts were reverse-engineered and cross-validated against the sibling
 * RSNetWorx HTML report exports (see dnt-analysis/REPORT.md). Catalog strings are not
 * stored in the file (RSNetWorx resolves them from EDS); a small identity table covers
 * vendor/deviceType/productCode tuples and unknown identities are kept, not dropped.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else { root.L5XStudio = root.L5XStudio || {}; Object.assign(root.L5XStudio, factory()); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---- minimal Buffer shim over Uint8Array (the parser code is written against Buffer) ---- */
  const Buffer = (function () {
    function make(u8) {
      const target = { _u8: u8, length: u8.length };
      return new Proxy(target, {
        get: function (t, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) return u8[key | 0];
          if (Object.prototype.hasOwnProperty.call(t, key)) return t[key];
          switch (key) {
            case "readUInt8": return function (i) { return u8[i]; };
            case "readUInt16LE": return function (i) { return u8[i] | (u8[i + 1] << 8); };
            case "readUInt32LE": return function (i) { return (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0; };
            case "readInt16LE": return function (i) { var v = u8[i] | (u8[i + 1] << 8); return v & 0x8000 ? v - 0x10000 : v; };
            case "readInt32LE": return function (i) { return (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) | 0; };
            case "subarray": return function (a, b) { return make(u8.subarray(a, b === undefined ? u8.length : b)); };
            case "slice": return function (a, b) { return make(u8.slice(a, b === undefined ? u8.length : b)); };
            case "toString": return function (enc) {
              enc = String(enc || "utf8").toLowerCase();
              if (enc === "latin1" || enc === "binary" || enc === "ascii") {
                var s = "";
                for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                return s;
              }
              if (enc === "utf16le" || enc === "ucs2") return new TextDecoder("utf-16le").decode(u8);
              if (enc === "hex") {
                var h = "";
                for (var j = 0; j < u8.length; j++) h += u8[j].toString(16).padStart(2, "0");
                return h;
              }
              return new TextDecoder(enc === "utf8" ? "utf-8" : enc).decode(u8);
            };
            case "equals": return function (other) {
              var o = other && other._u8 ? other._u8 : other;
              if (!o || o.length !== u8.length) return false;
              for (var i = 0; i < u8.length; i++) if (o[i] !== u8[i]) return false;
              return true;
            };
            case "copy": return function (targetBuf, tStart, sStart, sEnd) {
              var t = targetBuf._u8, st = sStart || 0, se = sEnd === undefined ? u8.length : sEnd;
              for (var i = st; i < se; i++) t[(tStart || 0) + (i - st)] = u8[i];
              return se - st;
            };
            default: return undefined;
          }
        }
      });
    }
    return {
      from: function (x) {
        if (x && x._u8) return x;
        if (x instanceof ArrayBuffer) return make(new Uint8Array(x));
        if (ArrayBuffer.isView(x)) return make(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
        return make(Uint8Array.from(x));
      },
      isBuffer: function (x) { return !!(x && x._u8); },
      alloc: function (n) { return make(new Uint8Array(n)); },
      concat: function (list) {
        var total = 0, i, u8, off, src;
        for (i = 0; i < list.length; i++) total += list[i].length;
        u8 = new Uint8Array(total); off = 0;
        for (i = 0; i < list.length; i++) { src = list[i]._u8; u8.set(src, off); off += src.length; }
        return make(u8);
      }
    };
  })();

  /* ============================ CFB / OLE2 container ============================ */
'use strict';
/*
 * Minimal, dependency-free OLE2 / Compound File Binary (CFB) reader.
 * Implements MS-CFB: header, DIFAT, FAT, MiniFAT, directory tree, stream reads.
 *
 * Usage:
 *   const { CompoundFile } = require('./lib/cfb');
 *   const cf = new CompoundFile(fs.readFileSync('x.dnt'));
 *   cf.entries;                 // flat directory entry list
 *   cf.tree();                  // nested {name, type, size, children[]}
 *   cf.read('StreamName');      // Buffer
 *
 * Reference: [MS-CFB] v20191110.
 */

const MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

const TYPE_NAMES = { 0: 'unknown', 1: 'storage', 2: 'stream', 5: 'root' };

function filetimeToDate(lo, hi) {
  if (lo === 0 && hi === 0) return null;
  // 100-ns intervals since 1601-01-01
  const ticks = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  if (ticks === 0n) return null;
  const ms = Number(ticks / 10000n) - 11644473600000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

class CompoundFile {
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    this.buf = buf;
    this.warnings = [];
    if (buf.length < 512) throw new Error('file too small to be a CFB');
    if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error('bad CFB signature');

    const h = this.header = {};
    h.clsid = buf.subarray(8, 24);
    h.minorVersion = buf.readUInt16LE(24);
    h.majorVersion = buf.readUInt16LE(26);
    h.byteOrder = buf.readUInt16LE(28);
    h.sectorShift = buf.readUInt16LE(30);
    h.miniSectorShift = buf.readUInt16LE(32);
    h.numDirSectors = buf.readUInt32LE(40);
    h.numFatSectors = buf.readUInt32LE(44);
    h.firstDirSector = buf.readUInt32LE(48);
    h.transactionSig = buf.readUInt32LE(52);
    h.miniStreamCutoff = buf.readUInt32LE(56);
    h.firstMiniFatSector = buf.readUInt32LE(60);
    h.numMiniFatSectors = buf.readUInt32LE(64);
    h.firstDifatSector = buf.readUInt32LE(68);
    h.numDifatSectors = buf.readUInt32LE(72);

    this.sectorSize = 1 << h.sectorShift;
    this.miniSectorSize = 1 << h.miniSectorShift;

    this._buildDifat();
    this._buildFat();
    this._buildMiniFat();
    this._readDirectory();
    this._readMiniStream();
  }

  /* ---- sector addressing -------------------------------------------------
   * Sector n starts at (n+1) * sectorSize for 512-byte sectors. For 4096-byte
   * sectors the header is padded to one full sector, so the same formula holds.
   */
  sectorOffset(sid) {
    return (sid + 1) * this.sectorSize;
  }

  readSector(sid) {
    const off = this.sectorOffset(sid);
    if (off + this.sectorSize > this.buf.length) {
      this.warnings.push(`sector ${sid} truncated at 0x${off.toString(16)}`);
      return this.buf.subarray(off);
    }
    return this.buf.subarray(off, off + this.sectorSize);
  }

  _buildDifat() {
    // 109 DIFAT entries live in the header at offset 76.
    const fatSectorIds = [];
    for (let i = 0; i < 109; i++) {
      const sid = this.buf.readUInt32LE(76 + i * 4);
      if (sid === FREESECT || sid === ENDOFCHAIN) continue;
      fatSectorIds.push(sid);
    }
    // Chained DIFAT sectors: each holds (sectorSize/4 - 1) FAT sector ids and
    // the last u32 is the next DIFAT sector.
    let next = this.header.firstDifatSector;
    const perSector = this.sectorSize / 4 - 1;
    let guard = 0;
    const seen = new Set();
    while (next !== ENDOFCHAIN && next !== FREESECT && next !== NOSTREAM) {
      if (seen.has(next) || guard++ > 65536) { this.warnings.push('DIFAT loop'); break; }
      seen.add(next);
      const s = this.readSector(next);
      for (let i = 0; i < perSector; i++) {
        const sid = s.readUInt32LE(i * 4);
        if (sid === FREESECT || sid === ENDOFCHAIN) continue;
        fatSectorIds.push(sid);
      }
      next = s.readUInt32LE(perSector * 4);
    }
    this.fatSectorIds = fatSectorIds;
  }

  _buildFat() {
    const per = this.sectorSize / 4;
    const fat = new Uint32Array(this.fatSectorIds.length * per);
    let k = 0;
    for (const sid of this.fatSectorIds) {
      const s = this.readSector(sid);
      for (let i = 0; i < per; i++) fat[k++] = s.readUInt32LE(i * 4);
    }
    this.fat = fat;
  }

  _buildMiniFat() {
    const chunks = [];
    let sid = this.header.firstMiniFatSector;
    let guard = 0;
    const seen = new Set();
    while (sid !== ENDOFCHAIN && sid !== FREESECT && sid !== NOSTREAM) {
      if (seen.has(sid) || guard++ > 65536) { this.warnings.push('MiniFAT loop'); break; }
      seen.add(sid);
      chunks.push(this.readSector(sid));
      sid = this.fat[sid];
    }
    const all = Buffer.concat(chunks);
    const n = Math.floor(all.length / 4);
    this.miniFat = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.miniFat[i] = all.readUInt32LE(i * 4);
  }

  _readDirectory() {
    const chain = this._chain(this.header.firstDirSector);
    const data = Buffer.concat(chain.map(s => this.readSector(s)));
    const entries = [];
    for (let off = 0; off + 128 <= data.length; off += 128) {
      const e = this._parseDirEntry(data, off, entries.length);
      entries.push(e);
    }
    this.entries = entries;
    if (entries.length && entries[0].type !== 5) {
      this.warnings.push('first directory entry is not the root storage');
    }
  }

  _parseDirEntry(data, off, id) {
    const raw = data.subarray(off, off + 128);
    const nameLen = raw.readUInt16LE(64);
    let name = '';
    if (nameLen >= 2 && nameLen <= 64) {
      name = raw.subarray(0, nameLen - 2).toString('utf16le');
    }
    const type = raw.readUInt8(66);
    return {
      id,
      name,
      type,
      typeName: TYPE_NAMES[type] || `type${type}`,
      color: raw.readUInt8(67),
      left: raw.readUInt32LE(68),
      right: raw.readUInt32LE(72),
      child: raw.readUInt32LE(76),
      clsid: raw.subarray(80, 96),
      stateBits: raw.readUInt32LE(96),
      creationTime: filetimeToDate(raw.readUInt32LE(100), raw.readUInt32LE(104)),
      modifiedTime: filetimeToDate(raw.readUInt32LE(108), raw.readUInt32LE(112)),
      startSector: raw.readUInt32LE(116),
      // size is u64; realistic streams are < 2^32 so high word is 0
      sizeLo: raw.readUInt32LE(120),
      sizeHi: raw.readUInt32LE(124),
      get size() { return this.sizeLo + this.sizeHi * 4294967296; },
      _raw: raw,
    };
  }

  /** Follow a FAT chain from `start`, return sector ids (capped). */
  _chain(start, table = this.fat, limit = 1 << 22) {
    const out = [];
    let sid = start;
    let guard = 0;
    const seen = new Set();
    while (sid !== ENDOFCHAIN && sid !== FREESECT && sid !== NOSTREAM && sid !== undefined) {
      if (seen.has(sid)) { this.warnings.push(`FAT loop at sector ${sid}`); break; }
      if (guard++ > limit) { this.warnings.push('FAT chain too long'); break; }
      if (sid >= table.length || table[sid] === undefined) {
        this.warnings.push(`sector ${sid} outside FAT`);
        break;
      }
      seen.add(sid);
      out.push(sid);
      sid = table[sid];
    }
    return out;
  }

  _readMiniStream() {
    const root = this.entries[0];
    this.miniStream = Buffer.alloc(0);
    if (root && root.startSector !== ENDOFCHAIN && root.startSector !== FREESECT) {
      const chain = this._chain(root.startSector);
      this.miniStream = Buffer.concat(chain.map(s => this.readSector(s)));
    }
  }

  /** Read a stream entry's full content. */
  readEntry(entry) {
    if (entry.type !== 2 && entry.type !== 5) return Buffer.alloc(0);
    const size = entry.size;
    if (entry.type === 5) return this.miniStream.subarray(0, size);
    if (size === 0) return Buffer.alloc(0);
    if (size < this.header.miniStreamCutoff) {
      // mini stream: 64-byte sectors inside the root entry's stream
      const chain = this._chain(entry.startSector, this.miniFat);
      const parts = [];
      for (const sid of chain) {
        const off = sid * this.miniSectorSize;
        parts.push(this.miniStream.subarray(off, off + this.miniSectorSize));
      }
      return Buffer.concat(parts).subarray(0, size);
    }
    const chain = this._chain(entry.startSector);
    return Buffer.concat(chain.map(s => this.readSector(s))).subarray(0, size);
  }

  read(name) {
    const e = this.entries.find(x => x.name === name && (x.type === 2 || x.type === 5));
    if (!e) return null;
    return this.readEntry(e);
  }

  /** Full path for each entry, e.g. "/Root/Storage/Stream". */
  paths() {
    const byId = new Map(this.entries.map(e => [e.id, e]));
    const parents = new Map();
    // Each storage owns a red-black tree of siblings (left/right) plus a
    // `child` pointer to the first node of its own children tree.
    const linkSiblings = (rootId, parentId, depth) => {
      if (rootId === NOSTREAM || depth > 64) return;
      const stack = [rootId];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (id === NOSTREAM || id >= this.entries.length || seen.has(id)) continue;
        seen.add(id);
        const e = byId.get(id);
        if (!e) continue;
        parents.set(id, parentId);
        stack.push(e.left, e.right);
        if (e.child !== NOSTREAM) linkSiblings(e.child, id, depth + 1);
      }
    };
    const root = this.entries[0];
    parents.set(0, NOSTREAM);
    if (root && root.child !== NOSTREAM) linkSiblings(root.child, 0, 0);
    const out = new Map();
    for (const e of this.entries) {
      const parts = [];
      let cur = e;
      let guard = 0;
      while (cur && guard++ < 64) {
        parts.unshift(cur.name);
        const pid = parents.get(cur.id);
        if (pid === NOSTREAM || pid === undefined) break;
        cur = byId.get(pid);
      }
      out.set(e.id, '/' + parts.join('/'));
    }
    return out;
  }

  /** Nested tree for display. */
  tree() {
    const byId = new Map(this.entries.map(e => [e.id, e]));
    const build = (id, depth, path) => {
      if (id === NOSTREAM || id >= this.entries.length || depth > 64) return [];
      const out = [];
      const sibs = [];
      const stack = [id];
      const seen = new Set();
      while (stack.length) {
        const sid = stack.pop();
        if (sid === NOSTREAM || sid >= this.entries.length || seen.has(sid)) continue;
        seen.add(sid);
        const e = byId.get(sid);
        if (!e) continue;
        sibs.push(e);
        stack.push(e.left, e.right);
      }
      sibs.sort((a, b) => a.id - b.id);
      for (const e of sibs) {
        const kids = e.child === NOSTREAM ? [] : build(e.child, depth + 1, path + '/' + e.name);
        out.push({
          name: e.name, type: e.typeName, size: e.size,
          clsid: e.clsid.toString('hex'),
          creationTime: e.creationTime, modifiedTime: e.modifiedTime,
          startSector: e.startSector, children: kids, entry: e,
        });
      }
      return out;
    };
    const root = this.entries[0];
    return [{
      name: root.name, type: 'root', size: root.size,
      creationTime: root.creationTime, modifiedTime: root.modifiedTime,
      children: root.child === NOSTREAM ? [] : build(root.child, 0, ''),
      entry: root,
    }];
  }
}


const KNOWN_CATALOGS = {
  '1/12/14': '1756-DNB',
  '1/7/166': '1799-ZCIOV',
  '1/7/1062': '100-DNY42R',
  '1/126/46888': '22B-B012P0... (PowerFlex 22B)',
};

// scanlist transfer type byte -> label (inferred from HTML "Message Type")
const XFER = { 0: 'None', 1: 'Polled', 2: 'Strobe', 3: 'ChangeOfState', 4: 'COS/Cyclic', 5: 'Cyclic' };

function hex(n, width = 4) { return '0x' + n.toString(16).padStart(width, '0'); }
function catalogFor(v, t, p) { return KNOWN_CATALOGS[`${v}/${t}/${p}`] || null; }
function utf16(buf) { return buf.toString('utf16le').replace(/\0+$/, ''); }

/* ------------------------------------------------------- DNet Configuration */

/**
 * Device table record layout (validated on 3 files / 40 devices):
 *   +0x00 u8   macId
 *   +0x01 u8   recordFlags        (always 2 so far)
 *   +0x02 u8[3] reserved (0)
 *   +0x05 u32  variantKey         (1 = normal, 2 = has secondary identity block)
 *   +0x09 u16  vendorId
 *   +0x0B u16  deviceType
 *   +0x0D u16  productCode
 *   +0x0F u8   majorRevision
 *   +0x10 u8   minorRevision
 *   [+0x11 u8[8] secondary identity, only when variantKey >= 2]
 *   u32        nameLength (UTF-16 code units)
 *   wchar[]    name
 *   u32        descriptionLength (BYTES, incl. NUL) -> description UTF-16
 *   u32        reserved (0)
 */
function parseDeviceTable(buf) {
  const out = { version: null, declaredCount: null, devices: [], warnings: [], trailer: null };
  if (buf.length < 8) { out.warnings.push('DNet Configuration shorter than 8 bytes'); return out; }
  out.version = buf.readUInt32LE(0);
  out.declaredCount = buf.readUInt32LE(4);

  let off = 8;
  for (let i = 0; i < out.declaredCount; i++) {
    const start = off;
    if (start + 21 > buf.length) {
      out.warnings.push(`device record ${i}: truncated at ${hex(start)}`);
      break;
    }
    const macId = buf[start];
    const recordFlags = buf[start + 1];
    const variantKey = buf.readUInt32LE(start + 5);
    const vendorId = buf.readUInt16LE(start + 9);
    const deviceType = buf.readUInt16LE(start + 11);
    const productCode = buf.readUInt16LE(start + 13);
    const major = buf[start + 15];
    const minor = buf[start + 16];

    let p = start + 17;
    let secondary = null;
    if (variantKey >= 2) {
      // Observed exactly once (MAC 11, PowerFlex drive). Identity-shaped 8 bytes.
      if (p + 8 > buf.length) { out.warnings.push(`device record ${i}: missing secondary identity`); break; }
      secondary = {
        vendorId: buf.readUInt16LE(p),
        deviceType: buf.readUInt16LE(p + 2),
        productCode: buf.readUInt16LE(p + 4),
        majorRevision: buf[p + 6],
        minorRevision: buf[p + 7],
        confidence: 'low',
      };
      p += 8;
    }

    const nameLen = buf.readUInt32LE(p); p += 4;
    if (nameLen > 512 || p + nameLen * 2 + 8 > buf.length) {
      out.warnings.push(`device record ${i}: implausible name length ${nameLen} at ${hex(p)}`);
      break;
    }
    const name = utf16(buf.subarray(p, p + nameLen * 2)); p += nameLen * 2;

    const descLen = buf.readUInt32LE(p); p += 4;
    let description = '';
    if (descLen > 0) {
      if (descLen > 8192 || p + descLen > buf.length) {
        out.warnings.push(`device record ${i}: implausible description length ${descLen}`);
        p -= 4; break;
      }
      description = utf16(buf.subarray(p, p + descLen)); p += descLen;
    }
    p += 4; // reserved / next-record marker

    out.devices.push({
      index: i,
      offset: start,
      macId,
      recordFlags,
      variantKey,
      vendorId,
      deviceType,
      productCode,
      revision: `${major}.${String(minor).padStart(3, '0')}`,
      majorRevision: major,
      minorRevision: minor,
      catalog: catalogFor(vendorId, deviceType, productCode),
      name,
      description,
      secondaryIdentity: secondary,
    });
    off = p;
  }
  // Whatever follows the device table is network-level metadata; LCS carries a
  // comm-path block here, the other two only an 8-byte zero footer.
  out.trailer = {
    offset: off,
    length: buf.length - off,
    ascii: buf.subarray(off).toString('latin1').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 200),
  };
  return out;
}

/* ------------------------------------------------------------ scanner stream
 *
 * LCS-style scanner streams are MFC CArchive object graphs:
 *   [16-byte class id] "C1756DnbData" 02 01
 *                      "CScannerData" <u16s: EPR, interscanDelay, pollRatio, retries>
 *                      "CChannelData" ...
 *                      N x (0a "CSlaveData" + 113-byte payload)
 * Each CSlaveData payload (field offsets verified against the HTML scanlist):
 *   +0x00 u8  schema (7)          +0x01 u8  active
 *   +0x05 u8  transfer type        +0x06 u8  mapped
 *   +0x08 u16 deviceType           +0x0a u16 productCode
 *   +0x11 u8  input bytes          +0x12 u8  output bytes
 *   +0x13 u8  input bytes (copy)   +0x14 u8  output bytes (copy)
 *   +0x24 u16 input bit length     +0x26 u32 input bit offset
 *   +0x48 u16 output bit length    +0x4a u32 output bit offset
 */

function parseScannerStream(buf) {
  const out = {
    present: true, moduleConfig: null, scanlist: [], slaveRecordSize: null,
    warnings: [], tailBytes: null,
  };
  const txt = buf.toString('latin1');
  if (txt.indexOf('CScannerData') < 0) { out.present = false; return out; }

  // Scanner module timing follows the "CChannelData" tag: [len]["CChannelData"]
  // then u16 schema (5) + u16 0, then EPR, interscan delay, poll ratio, retries.
  // Verified against the HTML "Module Configuration" table (75/10/1/1 for LCS).
  const ci = txt.indexOf('CChannelData');
  if (ci > 0) {
    const q = ci + 'CChannelData'.length + 2;
    if (q + 8 <= buf.length) {
      const cand = {
        expectedPacketRateMs: buf.readUInt16LE(q),
        interscanDelayMs: buf.readUInt16LE(q + 2),
        pollRatio: buf.readUInt16LE(q + 4),
        transmitRetries: buf.readUInt16LE(q + 6),
      };
      const sane = cand.interscanDelayMs <= 1000 && cand.pollRatio <= 100 &&
        cand.transmitRetries <= 10 && cand.expectedPacketRateMs >= 1 &&
        cand.expectedPacketRateMs <= 65535;
      if (sane) {
        out.moduleConfig = { ...cand, confidence: 'high (matches HTML "Module Configuration")' };
      } else {
        out.moduleConfig = { ...cand, confidence: 'low (implausible values; layout may differ)' };
        out.warnings.push('scanner module config values look implausible');
      }
    }
  }

  // Slave objects: 11-byte tag (0x0a "CSlaveData") + fixed payload.
  const tags = [];
  let p = -1;
  while ((p = txt.indexOf('CSlaveData', p + 1)) >= 0) tags.push(p - 1);
  if (tags.length > 1) out.slaveRecordSize = tags[1] - tags[0];

  for (let i = 0; i < tags.length; i++) {
    const start = tags[i];
    const end = i + 1 < tags.length ? tags[i + 1] : Math.min(buf.length, start + (out.slaveRecordSize || 124));
    const rec = buf.subarray(start + 11, end);
    if (rec.length < 0x4c) { out.warnings.push(`slave record ${i}: short payload (${rec.length})`); continue; }
    const xferByte = rec[5];
    // Records are emitted in ascending MAC order: record i == node i. The
    // trailing byte at +0x6f is a 1-based index, not the MAC id (verified by
    // product codes against the device table and the HTML scanlist).
    out.scanlist.push({
      macId: i,
      recordIndex: rec[0x6f] !== undefined ? rec[0x6f] : null,
      active: rec[1] === 1,
      transferTypeByte: xferByte,
      transferType: XFER[xferByte] || `unknown(${xferByte})`,
      mapped: rec[6] === 1,
      deviceType: rec.readUInt16LE(8),
      productCode: rec.readUInt16LE(10),
      inputBytes: rec[0x11],
      outputBytes: rec[0x12],
      inputBitLength: rec.readUInt16LE(0x24),
      inputBitOffset: rec.readUInt16LE(0x26),
      outputBitLength: rec.readUInt16LE(0x48),
      outputBitOffset: rec.readUInt16LE(0x4a),
      confidence: 'high for sizes/offsets (matches HTML scanlist + input/output memory tables)',
    });
  }
  // Consistency check: the trailing 1-based index should track record order.
  const badIdx = out.scanlist.filter(s => s.recordIndex !== null && s.recordIndex !== s.macId + 1);
  if (badIdx.length) {
    out.warnings.push(`scanlist: ${badIdx.length} record(s) whose trailing index disagrees with MAC order`);
  }
  return out;
}

/** Cross-check scanlist identities against the device table. */
function reconcileScanlist(scanner, devices) {
  for (const s of scanner.scanlist) {
    const d = devices.find(x => x.macId === s.macId);
    if (!d) { s.deviceTableMatch = false; continue; }
    s.deviceTableMatch = d.deviceType === s.deviceType && d.productCode === s.productCode;
    s.deviceName = d.name;
    s.catalog = d.catalog;
    // Node 0 is the scanner slot in the scanlist image and is all-zero by design.
    if (!s.deviceTableMatch && !(s.macId === 0)) {
      scanner.warnings.push(`scanlist node ${s.macId}: identity ${s.deviceType}/${s.productCode} ` +
        `!= device table ${d.deviceType}/${d.productCode}`);
    }
  }
}
function parseEdsAppletConfig(buf) {
  const out = { present: true, identity: null, parameterCount: null, parameters: [], assemblies: [], warnings: [], confidence: 'medium' };
  if (buf.length < 0x12) { out.present = false; return out; }
  out.identity = {
    vendorId: buf.readUInt16LE(8),
    deviceType: buf.readUInt16LE(10),
    productCode: buf.readUInt16LE(12),
    revision: `${buf[14]}.${String(buf[15]).padStart(3, '0')}`,
  };
  out.identity.catalog = catalogFor(out.identity.vendorId, out.identity.deviceType, out.identity.productCode);
  const count = buf.readUInt16LE(16);
  out.parameterCount = count;
  let p = 18;
  for (let i = 0; i < count; i++) {
    if (p >= buf.length) { out.warnings.push(`parameter ${i + 1}: truncated`); break; }
    const n1 = buf[p]; p += 1;
    if (n1 < 1 || n1 > 64 || p + n1 > buf.length) { out.warnings.push(`parameter ${i + 1}: bad name length`); break; }
    const name = buf.subarray(p, p + n1).toString('latin1'); p += n1;
    if (p + 6 > buf.length) { out.warnings.push(`parameter ${i + 1}: truncated g1`); break; }
    const g1 = [buf.readUInt16LE(p), buf.readUInt16LE(p + 2), buf.readUInt16LE(p + 4)]; p += 6;
    if (p >= buf.length) break;
    const n2 = buf[p]; p += 1;
    if (n2 < 1 || n2 > 64 || p + n2 > buf.length) { out.warnings.push(`parameter ${i + 1}: bad 2nd name`); break; }
    const name2 = buf.subarray(p, p + n2).toString('latin1'); p += n2;
    if (p + 12 > buf.length) { out.warnings.push(`parameter ${i + 1}: truncated values`); break; }
    const g2 = [buf.readUInt16LE(p), buf.readUInt16LE(p + 2), buf.readUInt16LE(p + 4)];
    const g3 = [buf.readUInt16LE(p + 6), buf.readUInt16LE(p + 8), buf.readUInt16LE(p + 10)];
    p += 12;
    out.parameters.push({
      index: i + 1, name, name2,
      paramInstance: g1[2],
      edsObjectRef: g2[1],
      valueType: g3[0],
      value: g3[1],
      raw: { g1, g2, g3 },
    });
  }
  // Remaining bytes: assembly references such as 08 "Assem169".
  let guard = 0;
  while (p + 1 < buf.length && guard++ < 64) {
    const n = buf[p];
    if (n > 0 && n < 64 && p + 1 + n <= buf.length && /^[\x20-\x7e]+$/.test(buf.subarray(p + 1, p + 1 + n).toString('latin1'))) {
      out.assemblies.push(buf.subarray(p + 1, p + 1 + n).toString('latin1'));
      p += 1 + n;
    } else break;
  }
  out.unparsedTailBytes = buf.length - p;
  return out;
}

/* ------------------------------------------------------------------- top level */

function formatGuid(b) {
  if (!b || b.length < 16) return null;
  const d1 = b.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = b.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = b.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = b.subarray(8, 10).toString('hex');
  const d5 = b.subarray(10, 16).toString('hex');
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`.toUpperCase();
}

/* ------------------------------------------------------------------------ CLI */

  /* Decode the "CFbIDofTag" table inside the EDS Applet Plugin Storage stream: RSNetWorx writes
     one entry per *named* logic block, mapping the user tag name to its function-block sequence id
     (e.g. Latch_1 -> 1, Timer_5 -> 19). This is the bridge between the configured tag names and
     the numbered function blocks in the HTML logic export. */
  function extractTagMap(buf) {
    const out = [];
    if (!buf || typeof buf.length !== "number") return out;
    try {
      const marker = "CFbIDofTag";
      let i = -1;
      outer:
      for (let off = 0; off <= buf.length - marker.length; off++) {
        let ok = true;
        for (let k = 0; k < marker.length; k++) if (buf[off + k] !== marker.charCodeAt(k)) { ok = false; break; }
        if (ok) { i = off; break outer; }
      }
      if (i < 0) return out;
      let pos = i + marker.length;
      while (pos < buf.length && out.length < 128) {
        const len = buf[pos]; pos += 1;
        if (len < 2 || len > 40 || pos + len + 6 > buf.length) break;
        let name = "";
        for (let k = 0; k < len; k++) name += String.fromCharCode(buf[pos + k]);
        if (!/^[\x20-\x7e]+$/.test(name)) break;
        pos += len;
        const seq = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
        pos += 4;
        const code = buf[pos] | (buf[pos + 1] << 8);
        pos += 2;
        if (!isFinite(seq) || seq <= 0 || seq > 2000) break;
        out.push({ name: name, seq: seq, code: code });
      }
    } catch (e) { /* keep whatever was parsed */ }
    return out;
  }

  /* Decode the configured zone-data tag database: each "Zone Data (Byte n,Bit m)" label record is
     followed by its tag id (sequential values 33..96 on the 1799-ZCIOV). This is what the zone
     mapping dots represent: the bit has a configured tag in the card's tag database. */
  function extractZoneTags(buf) {
    const out = [];
    if (!buf || typeof buf.length !== "number") return out;
    try {
      const marker = "Zone Data (Byte ";
      let pos = 0;
      while (pos < buf.length && out.length < 256) {
        let i = -1;
        outer:
        for (let off = pos; off <= buf.length - marker.length; off++) {
          let ok = true;
          for (let k = 0; k < marker.length; k++) if (buf[off + k] !== marker.charCodeAt(k)) { ok = false; break; }
          if (ok) { i = off; break outer; }
        }
        if (i < 0) break;
        let label = "";
        for (let k = 0; k < 24 && i + k < buf.length; k++) label += String.fromCharCode(buf[i + k]);
        const m = /^Zone Data \(Byte (\d),Bit (\d)\)$/.exec(label);
        if (m) {
          const idOff = i + label.length + 4;
          let tagId = null;
          if (idOff + 4 <= buf.length) {
            tagId = buf[idOff] | (buf[idOff + 1] << 8) | (buf[idOff + 2] << 16) | (buf[idOff + 3] << 24);
          }
          out.push({ byte: parseInt(m[1], 10), bit: parseInt(m[2], 10), label: label, tagId: tagId });
        }
        pos = i + marker.length;
      }
    } catch (e) { /* keep whatever was parsed */ }
    return out;
  }

  /* Extract printable labels from a proprietary stream (ASCII runs + UTF-16LE runs).
     The EDS Applet Plugin Storage stream is binary-framed but text-rich: it carries the
     device's point/zone mapping labels (e.g. "Zone Data (Byte 0,Bit 0)", "Network Input 7",
     "4 Zone") which is the closest representation of the card's local configuration. */
  function extractStrings(buf, limit) {
    limit = limit || 400;
    if (!buf || typeof buf.length !== "number") return [];
    const out = [];
    const seen = {};
    function add(s) {
      s = String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
      if (s.length < 3) return;
      if (!/[A-Za-z]{2}/.test(s)) return;
      if (seen[s]) return;
      seen[s] = true;
      out.push(s);
    }
    let cur = "";
    for (let i = 0; i < buf.length && out.length < limit; i++) {
      const ch = buf[i];
      if (ch >= 32 && ch < 127) cur += String.fromCharCode(ch);
      else { if (cur.length >= 4) add(cur); cur = ""; }
    }
    if (cur.length >= 4) add(cur);
    cur = "";
    for (let i = 0; i + 1 < buf.length && out.length < limit; i += 2) {
      const lo = buf[i], hi = buf[i + 1];
      if (hi === 0 && lo >= 32 && lo < 127) cur += String.fromCharCode(lo);
      else { if (cur.length >= 4) add(cur); cur = ""; }
    }
    if (cur.length >= 4) add(cur);
    return out;
  }

  /* Classify the point labels of a node configuration into zone mapping / I/O / network rows. */
  function classifyNodeLabels(strings) {
    const labels = { zoneData: [], inputs: [], outputs: [], networkInputs: [], networkOutputs: [], other: [] };
    let zoneCount = null;
    for (const s of (strings || [])) {
      const mZone = /^Zone Data \(Byte (\d+)\s*,\s*Bit (\d+)\)$/.exec(s);
      if (mZone) { labels.zoneData.push({ byte: +mZone[1], bit: +mZone[2], label: s }); continue; }
      if (/^\d+ Zone$/.test(s)) { zoneCount = parseInt(s, 10); continue; }
      if (/^Network Input \d+$/.test(s)) { labels.networkInputs.push({ index: +s.replace(/^\D+/, ""), label: s }); continue; }
      if (/^Network Output \d+$/.test(s)) { labels.networkOutputs.push({ index: +s.replace(/^\D+/, ""), label: s }); continue; }
      if (/^Input \d+$/.test(s)) { labels.inputs.push({ index: +s.replace(/^\D+/, ""), label: s }); continue; }
      if (/^Output \d+$/.test(s)) { labels.outputs.push({ index: +s.replace(/^\D+/, ""), label: s }); continue; }
      labels.other.push(s);
    }
    labels.zoneCount = zoneCount;
    return labels;
  }
  /* ============================ public API ============================ */

  function toBytes(input) {
    if (!input) return null;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input.length === "number") {
      try { return Uint8Array.from(input); } catch (e) { return null; }
    }
    return null;
  }

  /* Parse a .dnt document (ArrayBuffer / Uint8Array / Buffer) into a plain object:
     { fileName, network:{name, declaredDeviceCount, deviceCount}, devices:[...], scanner, warnings }. */
  function parseDnt(input, opts) {
    opts = opts || {};
    const u8 = toBytes(input);
    if (!u8 || !u8.length) throw new Error("parseDnt: expected the bytes of a .dnt file");
    let cf;
    try { cf = new CompoundFile(Buffer.from(u8)); }
    catch (err) { throw new Error("parseDnt: not a readable OLE2/CFB container (" + err.message + ")"); }
    const entries = cf.entries || [];
    const paths = cf.paths ? cf.paths() : new Map();
    const result = {
      fileName: opts.fileName || null,
      size: u8.length,
      network: { name: (opts.fileName || "").replace(/\.dnt$/i, "") || "DeviceNet network", declaredDeviceCount: null, deviceCount: 0 },
      devices: [],
      streams: [],
      warnings: [],
      scanner: null
    };
    const root = entries[0];
    result.rootClsid = root && root.clsid && root.clsid.toString ? root.clsid.toString("hex") : null;
    result.isDnt = /^13511ac6445cd1118922a224f60d2d07$/i.test(result.rootClsid || "");
    if (!result.isDnt) result.warnings.push("root storage CLSID is not the RSNetWorx DeviceNet document CLSID — parsing anyway");
    for (const e of entries) {
      if (!e || e.type === 0) continue;
      const p = paths.get ? paths.get(e.id) : null;
      let data = null;
      if (e.type === 2) { try { data = cf.readEntry(e); } catch (err) { result.warnings.push("read " + p + ": " + err.message); } }
      result.streams.push({ name: e.name, path: p, type: e.typeName, size: e.size });
      if (data) { e._data = data; e._path = p; }
    }
    const dnet = entries.find(function (e) { return e.type === 2 && e.name === "DNet Configuration"; });
    if (!dnet || !dnet._data) {
      result.warnings.push("no \"DNet Configuration\" stream — this does not look like a DeviceNet network file");
      return result;
    }
    const table = parseDeviceTable(dnet._data);
    result.devices = table.devices;
    result.network.declaredDeviceCount = table.declaredCount;
    result.network.tableVersion = table.version;
    result.warnings.push.apply(result.warnings, table.warnings || []);
    // per-node EDS applet configuration (parameter values, e.g. zone MAC IDs / EPRs)
    for (const e of entries) {
      if (e.type !== 2 || !e._path || !e._data) continue;
      const m = /^\/Root Entry\/([0-9A-Fa-f]{2})\/(.+)$/.exec(e._path);
      if (!m) continue;
      const mac = parseInt(m[1], 10);
      const dev = result.devices.find(function (d) { return d.macId === mac; });
      if (!dev) continue;
      dev.storage = dev.storage || {};
      if (m[2] === "EDS Applet Device Configuration") {
        try { dev.storage.appletConfig = parseEdsAppletConfig(e._data); }
        catch (err) { result.warnings.push("applet config MAC " + mac + ": " + err.message); }
      } else if (m[2] === "EDS Applet Plugin Storage") {
        dev.storage.pluginStorageBytes = e.size;
        try { dev.storage.pluginStrings = extractStrings(e._data); } catch (err) { dev.storage.pluginStrings = []; }
        try { dev.storage.pluginTagMap = extractTagMap(e._data); } catch (err) { dev.storage.pluginTagMap = []; }
        try { dev.storage.zoneTags = extractZoneTags(e._data); } catch (err) { dev.storage.zoneTags = []; }
      }
    }
    // scanner stream: a root-level stream containing the CScannerData/CSlaveData graph
    for (const e of entries) {
      if (e.type !== 2 || !e._data || e.name === "DNet Configuration") continue;
      if (/^\/Root Entry\/[0-9A-Fa-f]{2}\//.test(e._path || "")) continue;
      let txt = "";
      try { txt = e._data.toString("latin1"); } catch (err) { continue; }
      if (txt.indexOf("CScannerData") < 0) continue;
      try {
        const scanner = parseScannerStream(e._data);
        if (scanner && scanner.present) {
          scanner.stream = e._path || e.name;
          reconcileScanlist(scanner, result.devices);
          result.scanner = scanner;
        }
      } catch (err) { result.warnings.push("scanner stream: " + err.message); }
      break;
    }
    // app-facing node list: one entry per mapped DeviceNet node (index 0 is the scanner slot)
    const nodes = [];
    const scanlist = result.scanner ? (result.scanner.scanlist || []) : [];
    if (scanlist.length) {
      for (const s of scanlist) {
        if (!s || s.macId === 0) continue;
        const dev = result.devices.find(function (d) { return d.macId === s.macId; });
        const catalog = s.catalog || (dev && dev.catalog) || null;
        const name = (dev && dev.name) || s.deviceName || ("Node " + s.macId);
        if (s.active === false) continue;
        nodes.push({
          macId: s.macId,
          name: name,
          description: (dev && dev.description) || "",
          catalogNumber: catalog,
          catalog: catalog,
          vendorId: dev ? dev.vendorId : null,
          deviceType: s.deviceType,
          productCode: s.productCode,
          revision: dev ? dev.revision : null,
          transferType: s.transferType,
          active: s.active,
          inputBytes: s.inputBytes || 0,
          outputBytes: s.outputBytes || 0,
          inputBitLength: s.inputBitLength || 0,
          inputBitOffset: s.inputBitOffset || 0,
          outputBitLength: s.outputBitLength || 0,
          outputBitOffset: s.outputBitOffset || 0,
          polled: /poll/i.test(s.transferType || ""),
          cos: /cos|cyclic/i.test(s.transferType || ""),
          applet: (dev && dev.storage && dev.storage.appletConfig) || null,
          pluginStorageBytes: (dev && dev.storage && dev.storage.pluginStorageBytes) || 0,
          pluginTagMap: (dev && dev.storage && dev.storage.pluginTagMap) || [],
          zoneTags: (dev && dev.storage && dev.storage.zoneTags) || [],
          pluginStrings: (dev && dev.storage && dev.storage.pluginStrings) || [],
          labels: classifyNodeLabels((dev && dev.storage && dev.storage.pluginStrings) || [])
        });
      }
    } else {
      for (const d of result.devices) {
        if (!d || d.macId === 0 || /DNB/i.test(d.catalog || "")) continue;
        nodes.push(Object.assign({}, d, {
          catalogNumber: d.catalog || null,
          pluginTagMap: (d.storage && d.storage.pluginTagMap) || [],
          zoneTags: (d.storage && d.storage.zoneTags) || [],
          pluginStrings: (d.storage && d.storage.pluginStrings) || [],
          labels: classifyNodeLabels((d.storage && d.storage.pluginStrings) || [])
        }));
      }
    }
    result.devices = nodes;
    result.network.deviceCount = nodes.length;
    const cfg = result.scanner && result.scanner.moduleConfig;
    result.scannerInfo = result.scanner ? {
      config: cfg || null,
      eprMs: cfg ? cfg.expectedPacketRateMs : null,
      interscanDelayMs: cfg ? cfg.interscanDelayMs : null,
      pollRatio: cfg ? cfg.pollRatio : null,
      transmitRetries: cfg ? cfg.transmitRetries : null,
      scanlistStream: result.scanner.stream || null
    } : null;
    if (!nodes.length) result.warnings.push("no mapped DeviceNet nodes found in the file");
    result.warnings.push.apply(result.warnings, cf.warnings || []);
    return result;
  }

  function isDnt(input) {
    const u8 = toBytes(input);
    if (!u8 || u8.length < 512) return false;
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) return false;
    return true;
  }

  return {
    parseDnt: parseDnt,
    isDnt: isDnt,
    parseDeviceTable: parseDeviceTable,
    extractStrings: extractStrings,
    extractTagMap: extractTagMap,
    extractZoneTags: extractZoneTags,
    classifyNodeLabels: classifyNodeLabels,
    parseScannerStream: parseScannerStream,
    parseEdsAppletConfig: parseEdsAppletConfig,
    reconcileScanlist: reconcileScanlist,
    KNOWN_CATALOGS: KNOWN_CATALOGS,
    CompoundFile: CompoundFile
  };
});