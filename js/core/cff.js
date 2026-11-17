'use strict';
// CFF0 game-data records (optionally wrapped in a 32-byte RSC0 header).
// Chunks: DEF0 (byte[1] = key index), INST (encrypted struct data), PTCH (pointer fixups), SYMB (symbols).
const { lookup2 } = require('./hash');

const KEYS = [0x6e0da13b, 0x50daa98f, 0x2d5ffa4f, 0x56c6c3eb, 0xcad31ddd, 0x04f7be6a, 0xd5c4e961, 0x7fe2ef92,
  0xccbb8a6d, 0x19b6875b, 0x433b604c, 0xba7b1ee4, 0x9dea872e, 0xa8c2e10a, 0xed30a2ff, 0x16a8f9a4];

const rol1 = (x) => ((x << 1) | (x >>> 31)) >>> 0;

function keyHash(keyIdx, n) {
  const k = Buffer.alloc(4); k.writeUInt32LE(KEYS[keyIdx]);
  return lookup2(k, n);
}

function decrypt(inst, keyIdx) {
  const n = inst.length, h = keyHash(keyIdx, n);
  const out = Buffer.from(inst);
  let prev = n >>> 0;
  for (let i = 0; i + 4 <= n; i += 4) {
    const c = inst.readUInt32LE(i);
    out.writeUInt32LE((rol1(prev) ^ c ^ h) >>> 0, i);
    prev = c;
  }
  return out;
}

function encrypt(plain, keyIdx) {
  const n = plain.length, h = keyHash(keyIdx, n);
  const out = Buffer.from(plain);
  let prev = n >>> 0;
  for (let i = 0; i + 4 <= n; i += 4) {
    const c = (rol1(prev) ^ plain.readUInt32LE(i) ^ h) >>> 0;
    out.writeUInt32LE(c, i);
    prev = c;
  }
  return out;
}

function isRecord(buf) {
  if (buf.length < 0x48) return false;
  const o = buf.toString('latin1', 0, 4) === 'RSC0' ? 32 : 0;
  return buf.toString('latin1', o, o + 4) === 'CFF0' && buf.toString('latin1', o + 0x40, o + 0x44) === 'DEF0';
}

/** Parse a record. Keeps raw bytes so build() can reproduce it exactly with only INST re-encrypted. */
function parse(buf) {
  const wrapLen = buf.toString('latin1', 0, 4) === 'RSC0' ? 32 : 0;
  const base = wrapLen;
  if (buf.toString('latin1', base, base + 4) !== 'CFF0') throw new Error('Not a CFF0 record');
  let p = base + 0x40;
  let keyIdx = null, instOff = null, instLen = null;
  const syms = [], ptrs = new Map();
  while (p + 8 <= buf.length) {
    const tag = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (len < 8) break;
    const body = buf.subarray(p + 8, p + len);
    if (tag === 'DEF0') keyIdx = body[1];
    else if (tag === 'INST') { instOff = p + 8; instLen = len - 8; }
    else if (tag === 'PTCH') {
      const cnt = body.readUInt32LE(0);
      for (let i = 0; i < cnt; i++) ptrs.set(body.readUInt32LE(8 + i * 8), body.readUInt32LE(12 + i * 8));
    } else if (tag === 'SYMB') {
      const off = body.readUInt32LE(0), type = body.readUInt32LE(4);
      const end = body.indexOf(0, 8);
      syms.push({ off, type, name: body.toString('latin1', 8, end) });
    }
    p += len;
  }
  if (keyIdx === null || instOff === null) throw new Error('Record is missing DEF0/INST');
  const inst = decrypt(buf.subarray(instOff, instOff + instLen), keyIdx);
  return { raw: buf, keyIdx, instOff, instLen, inst, syms, ptrs };
}

/** Rebuild record bytes from rec.inst (must keep its length). */
function build(rec) {
  if (rec.inst.length !== rec.instLen) throw new Error('INST size changed');
  const out = Buffer.from(rec.raw);
  encrypt(rec.inst, rec.keyIdx).copy(out, rec.instOff);
  return out;
}

function symbol(rec, name) {
  return rec.syms.find((s) => s.name === name) || null;
}

function cstr(rec, off) {
  if (off == null) return null;
  const e = rec.inst.indexOf(0, off);
  return rec.inst.toString('latin1', off, e < 0 ? rec.inst.length : e);
}

module.exports = { parse, build, decrypt, encrypt, isRecord, symbol, cstr, KEYS };
