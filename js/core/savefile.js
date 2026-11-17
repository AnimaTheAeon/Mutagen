'use strict';
// The *.cloud.json container used by TMNT: Splintered Fate:
//   u32 version | u32 hashLen | md5 hex (uppercase) + NUL | u32 rawSize | u32 zSize | zlib(JSON + NUL)
// Pure JS (pako + js-md5) so it runs the same in the app window and in Node tests.
const pako = require('pako');
const md5 = require('js-md5');
const sha1 = require('js-sha1');
const ljson = require('./ljson');

class SaveFormatError extends Error {}

function md5Hex(buf) { return md5(buf).toUpperCase(); }
function sha1Hex(buf) { return sha1(buf).toUpperCase(); }

/** Decode container bytes. Throws SaveFormatError when anything doesn't check out. */
function decode(buf) {
  if (!buf || buf.length < 24) throw new SaveFormatError('File is too small to be a save.');
  buf = Buffer.from(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.length);
  const version = buf.readUInt32LE(0);
  const hashLen = buf.readUInt32LE(4);
  if (hashLen !== 33) throw new SaveFormatError(`Unexpected header (hash length ${hashLen}).`);
  const md5s = buf.toString('latin1', 8, 8 + 32);
  if (!/^[0-9A-F]{32}$/.test(md5s) || buf[8 + 32] !== 0) throw new SaveFormatError('Header checksum is malformed.');
  const p = 8 + hashLen;
  const rawSize = buf.readUInt32LE(p);
  const zSize = buf.readUInt32LE(p + 4);
  if (p + 8 + zSize !== buf.length) throw new SaveFormatError(`Size mismatch: header says ${zSize} compressed bytes, file has ${buf.length - p - 8}.`);
  let raw;
  try { raw = Buffer.from(pako.inflate(buf.subarray(p + 8))); } catch (e) { throw new SaveFormatError('Compressed data is damaged: ' + (e.message || e)); }
  if (raw.length !== rawSize) throw new SaveFormatError(`Uncompressed size ${raw.length} does not match header ${rawSize}.`);
  const actual = md5Hex(raw);
  if (actual !== md5s) throw new SaveFormatError(`Checksum mismatch (file says ${md5s}, data is ${actual}).`);
  let textEnd = raw.length;
  const trailingNul = raw[raw.length - 1] === 0;
  if (trailingNul) textEnd--;
  const text = raw.toString('utf8', 0, textEnd);
  let doc;
  try { doc = ljson.parse(text); } catch (e) { throw new SaveFormatError('Save text is not valid JSON: ' + e.message); }
  return { version, md5: md5s, raw, text, trailingNul, doc };
}

/** Encode a parsed document back into container bytes. */
function encode(doc, { version = 1235, trailingNul = true } = {}) {
  const text = ljson.stringify(doc);
  const raw = Buffer.concat([Buffer.from(text, 'utf8'), trailingNul ? Buffer.from([0]) : Buffer.alloc(0)]);
  const z = Buffer.from(pako.deflate(raw, { level: 9 }));
  const md5b = Buffer.from(md5Hex(raw) + '\0', 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(version, 0);
  head.writeUInt32LE(md5b.length, 4);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(raw.length, 0);
  sizes.writeUInt32LE(z.length, 4);
  return Buffer.concat([head, md5b, sizes, z]);
}

module.exports = { decode, encode, md5Hex, sha1Hex, SaveFormatError };
