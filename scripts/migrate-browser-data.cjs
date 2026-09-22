/**
 * One-off migration helper (read-only on the source): extracts Seren's
 * `seren_*` localStorage entries — plus legacy `lumi_*` entries from the
 * original app — from Chrome-family profiles AND from the Seren desktop
 * app's own storage, then writes them as `seren_*` keys to a JSON file.
 *
 * Chrome/Electron store localStorage in LevelDB, and this extractor parses
 * both file formats properly instead of guessing from raw bytes:
 *
 *   .log  (WAL/memtable) — 32 KB block framing (7-byte headers, FIRST/MIDDLE/
 *         LAST fragments reassembled), then WriteBatch records: sequence,
 *         count, then [type][varint klen][key][varint vlen][value] entries.
 *         Large values (chat/report/lesson history JSON) routinely span
 *         multiple blocks, so naive byte scanning silently misses them.
 *
 *   .ldb  (sstable) — footer → index block → data blocks. Data blocks may be
 *         snappy-compressed (raw block format) and entries are prefix-
 *         compressed against the previous key; both are handled here.
 *
 * Record layout inside both formats:
 *   internal key = <origin>\0\x01 <storage-key> + 8-byte (sequence<<8|type)
 *   value        = 1 byte (0x01 = latin1/utf8, 0x00 = UTF-16LE) + text
 *
 * Newest record per key wins by sequence number. Legacy `lumi_*` keys are
 * renamed to their `seren_*` counterparts in the output.
 *
 * Usage: node scripts/migrate-browser-data.cjs [--out <file>]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SEARCH_ROOTS = [
  path.join(os.homedir(), '.config/google-chrome'),
  path.join(os.homedir(), '.config/chromium'),
  path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser'),
  path.join(os.homedir(), '.config/microsoft-edge'),
  // The desktop app itself — recover data written under an old http origin.
  // Electron keeps storage directly in the app-data folder (no profile dir).
  path.join(os.homedir(), '.config/Seren'),
  process.env.APPDATA ? path.join(process.env.APPDATA, 'Seren') : null,
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Seren')
    : null,
].filter(Boolean);

const LOG_BLOCK_SIZE = 32768;
const LDB_MAGIC = 0xdb4775248b80fb57n;

/** Reads a LEB128 varint, returns [value, nextPos] or null. */
function parseVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let index = pos;
  for (;;) {
    if (index >= buf.length) return null;
    const byte = buf[index];
    index += 1;
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, index];
    shift += 7;
    if (shift > 35) return null;
  }
}

/**
 * Raw snappy block-format decompression (Chromium compresses .ldb data blocks
 * with it). Returns a Buffer or null on malformed input.
 */
function snappyDecompress(src) {
  let pos = 0;
  let uncompressed = 0;
  let shift = 0;
  while (pos < src.length) {
    const byte = src[pos++];
    uncompressed += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (uncompressed <= 0 || uncompressed > 64 * 1024 * 1024) return null;
  const out = Buffer.alloc(uncompressed);
  let opos = 0;
  while (pos < src.length && opos < uncompressed) {
    const tag = src[pos++];
    if ((tag & 3) === 0) {
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const extra = len - 60;
        len = 0;
        for (let i = 0; i < extra; i++) len += src[pos + i] * Math.pow(2, 8 * i);
        len += 1;
        pos += extra;
      }
      if (pos + len > src.length || opos + len > uncompressed) return null;
      src.copy(out, opos, pos, pos + len);
      pos += len;
      opos += len;
    } else {
      let matchLen;
      let offset;
      if ((tag & 3) === 1) {
        matchLen = ((tag >> 2) & 0x7) + 4;
        offset = ((tag >> 5) << 8) | src[pos++];
      } else if ((tag & 3) === 2) {
        matchLen = (tag >> 2) + 1;
        offset = src.readUInt16LE(pos);
        pos += 2;
      } else {
        matchLen = (tag >> 2) + 1;
        offset = src.readUInt32LE(pos);
        pos += 4;
      }
      if (offset === 0 || offset > opos || opos + matchLen > uncompressed) return null;
      for (let i = 0; i < matchLen; i++) {
        out[opos] = out[opos - offset];
        opos += 1;
      }
    }
  }
  return opos === uncompressed ? out : null;
}

/**
 * Decodes a localStorage value: 1 encoding-flag byte (0x01 = one-byte
 * latin1/utf8 text, 0x00 = two-byte UTF-16LE) followed by the raw text.
 * JSON object/array values must parse; scalars must be printable.
 */
function decodeLsValue(buf) {
  if (!buf || buf.length < 1) return null;
  const flag = buf[0];
  let text;
  if (flag === 0x01) text = buf.toString('utf8', 1);
  else if (flag === 0x00) text = buf.toString('utf16le', 1);
  else return null;
  if (text.length === 0) return null;
  if (text[0] === '{' || text[0] === '[') {
    try {
      JSON.parse(text);
      return text;
    } catch {
      return null;
    }
  }
  return (/^[\x20-\x7e\u00a0-\uffff]*$/.test(text) ? text : null);
}

// found: canonical `seren_*` key -> { value, seq, priority, source }
const found = new Map();

function recordKey(storageKey, value, seq, source) {
  if (!value) return;
  const isLegacy = storageKey.startsWith('lumi_');
  if (!isLegacy && !storageKey.startsWith('seren_')) return;
  const canonicalKey = isLegacy ? `seren_${storageKey.slice('lumi_'.length)}` : storageKey;
  const previous = found.get(canonicalKey);
  if (
    !previous ||
    (!isLegacy && previous.legacy) ||
    (isLegacy === previous.legacy && seq > previous.seq)
  ) {
    found.set(canonicalKey, { value, seq, source, legacy: isLegacy });
  }
}

/** Splits a user key (<origin>\0\x01<storage-key>) and stores Seren values. */
function handleUserKey(userKey, valueBuf, source, seq) {
  const sep = userKey.indexOf(0x00);
  if (sep === -1 || userKey[sep + 1] !== 0x01) return;
  const storageKey = userKey.toString('latin1', sep + 2);
  if (!storageKey.startsWith('seren_') && !storageKey.startsWith('lumi_')) return;
  recordKey(storageKey, decodeLsValue(valueBuf), seq, source);
}

/**
 * .ldb records carry the 8-byte internal-key trailer (sequence<<8|type) after
 * the user key — strip it. Log records carry PLAIN user keys (call
 * handleUserKey directly for those).
 */
function handleInternalKey(internalKey, valueBuf, source, seq) {
  if (internalKey.length < 9) return;
  handleUserKey(internalKey.subarray(0, internalKey.length - 8), valueBuf, source, seq);
}

// ---------------------------------------------------------------------------
// .log (WAL) — 32 KB block framing, then WriteBatch payloads
// ---------------------------------------------------------------------------
function* logPayloads(buf) {
  let pos = 0;
  let pending = null;
  while (pos + 7 <= buf.length) {
    const spaceLeft = LOG_BLOCK_SIZE - (pos % LOG_BLOCK_SIZE);
    if (spaceLeft < 7) {
      pos += spaceLeft; // block trailer — skip to the next block
      continue;
    }
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const payload = buf.subarray(pos + 7, pos + 7 + length);
    pos += 7 + length;
    if (type === 1) { // FULL
      pending = null;
      yield payload;
    } else if (type === 2) { // FIRST
      pending = Buffer.concat([pending || Buffer.alloc(0), payload]);
    } else if (type === 3) { // MIDDLE
      if (pending) pending = Buffer.concat([pending, payload]);
    } else if (type === 4) { // LAST
      if (pending) yield Buffer.concat([pending, payload]);
      pending = null;
    } else {
      pending = null; // padding / zero / unknown
    }
  }
}

function parseWriteBatch(payload, source) {
  if (payload.length < 12) return;
  const batchSeq = Number(payload.readBigUInt64LE(0));
  const count = payload.readUInt32LE(8);
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    if (pos >= payload.length) return;
    const op = payload[pos];
    pos += 1;
    if (op !== 0 && op !== 1) return; // unknown op — stream is desynced
    const keyLen = parseVarint(payload, pos);
    if (!keyLen) return;
    pos = keyLen[1];
    const key = payload.subarray(pos, pos + keyLen[0]);
    pos += keyLen[0];
    if (op === 1) {
      // PUT — key AND value
      const valLen = parseVarint(payload, pos);
      if (!valLen) return;
      pos = valLen[1];
      const value = payload.subarray(pos, pos + valLen[0]);
      pos += valLen[0];
      handleUserKey(key, value, source, batchSeq + i);
    }
    // DELETE — key only, no value field
  }
}

// ---------------------------------------------------------------------------
// .ldb (sstable) — footer → index block → data blocks
// ---------------------------------------------------------------------------
/** Reads one block body at (offset, size); the compression byte follows it. */
function readBlock(buf, offset, size) {
  if (offset < 0 || size < 0 || offset + size + 5 > buf.length) return null;
  const compression = buf[offset + size];
  const raw = buf.subarray(offset, offset + size);
  if (compression === 0) return raw;
  if (compression === 1) return snappyDecompress(raw); // snappy
  return null; // zstd or unknown — not expected for localStorage tables
}

/** Parses prefix-compressed entries of a data block and stores Seren values. */
function scanDataBlock(data, source) {
  if (data.length < 4) return;
  const numRestarts = data.readUInt32LE(data.length - 4);
  const end = data.length - 4 - numRestarts * 4;
  if (end < 0) return;
  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < end) {
    const shared = parseVarint(data, pos);
    if (!shared) break;
    pos = shared[1];
    const nonShared = parseVarint(data, pos);
    if (!nonShared) break;
    pos = nonShared[1];
    const valLen = parseVarint(data, pos);
    if (!valLen) break;
    pos = valLen[1];
    const key = Buffer.concat([prevKey.subarray(0, shared[0]), data.subarray(pos, pos + nonShared[0])]);
    const valueStart = pos + nonShared[0];
    const value = data.subarray(valueStart, valueStart + valLen[0]);
    pos = valueStart + valLen[0];
    prevKey = key;
    if (key.length < 9) continue;
    const seq = Number(key.readBigUInt64LE(key.length - 8) >> 8n);
    handleInternalKey(key, value, source, seq);
  }
}

function parseLdb(buf, source) {
  if (buf.length < 52) return;
  if (buf.readBigUInt64LE(buf.length - 8) !== LDB_MAGIC) return;
  let pos = buf.length - 48;
  const metaOff = parseVarint(buf, pos);
  if (!metaOff) return;
  pos = metaOff[1];
  const metaSize = parseVarint(buf, pos);
  if (!metaSize) return;
  pos = metaSize[1];
  const indexOff = parseVarint(buf, pos);
  if (!indexOff) return;
  pos = indexOff[1];
  const indexSize = parseVarint(buf, pos);
  if (!indexSize) return;
  const indexBlock = readBlock(buf, indexOff[0], indexSize[0]);
  if (!indexBlock || indexBlock.length < 4) return;
  const numRestarts = indexBlock.readUInt32LE(indexBlock.length - 4);
  const entriesEnd = indexBlock.length - 4 - numRestarts * 4;
  let epos = 0;
  while (epos < entriesEnd) {
    const shared = parseVarint(indexBlock, epos);
    if (!shared) break;
    epos = shared[1];
    const nonShared = parseVarint(indexBlock, epos);
    if (!nonShared) break;
    epos = nonShared[1];
    const valLen = parseVarint(indexBlock, epos);
    if (!valLen) break;
    epos = valLen[1];
    // The entry value is the data block's BlockHandle (offset + size varints).
    const blockOff = parseVarint(indexBlock, epos + nonShared[0]);
    if (!blockOff) break;
    const blockSize = parseVarint(indexBlock, blockOff[1]);
    if (!blockSize) break;
    const data = readBlock(buf, blockOff[0], blockSize[0]);
    if (data) scanDataBlock(data, source);
    epos += nonShared[0] + valLen[0];
  }
}

// ---------------------------------------------------------------------------
// Walk every known browser profile + the Seren desktop app's own storage
// ---------------------------------------------------------------------------
function* levelDbDirs() {
  for (const root of SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;
    // Electron layout: <app-data>/Local Storage/leveldb (no profile dir).
    const direct = path.join(root, 'Local Storage', 'leveldb');
    if (fs.existsSync(direct)) {
      yield { source: path.basename(root), dir: direct };
      continue;
    }
    // Chrome layout: <root>/<profile>/Local Storage/leveldb
    for (const profile of fs.readdirSync(root, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const dir = path.join(root, profile.name, 'Local Storage', 'leveldb');
      if (fs.existsSync(dir)) {
        yield { source: `${path.basename(root)}/${profile.name}`, dir };
      }
    }
  }
}

for (const { source, dir } of levelDbDirs()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    if (!file.endsWith('.ldb') && !file.endsWith('.log')) continue;
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, file));
    } catch {
      continue;
    }
    try {
      if (file.endsWith('.log')) {
        for (const payload of logPayloads(buf)) parseWriteBatch(payload, source);
      } else {
        parseLdb(buf, source);
      }
    } catch {
      // unreadable file — keep going, other files may still carry the data
    }
  }
}

if (found.size === 0) {
  console.log('No Seren localStorage entries found.');
  process.exit(0);
}

const legacyCount = [...found.values()].filter((info) => info.legacy).length;
const out = {};
for (const [key, info] of found) {
  out[key] = info.value;
  const tag = info.legacy ? '  (recovered from legacy storage)' : '';
  console.log(`\n=== ${key}${tag}  [${info.source}]`);
  console.log(info.value.length > 300 ? `${info.value.slice(0, 300)}… (${info.value.length} chars)` : info.value);
}
if (legacyCount) console.log(`\n${legacyCount} legacy record(s) converted to Seren keys.`);

const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/seren-browser-data.json';
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\n${found.size} key(s) written to ${outFile}`);
