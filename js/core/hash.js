'use strict';
// Hash functions used by TMNT: Splintered Fate.

/** FNV-1a 32-bit, returned as a signed int32 (the way the save stores IDs). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h | 0;
}

/** FNV-1a 32-bit as an unsigned number. */
function fnv1aU(str) {
  return fnv1a(str) >>> 0;
}

function mix(a, b, c) {
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 13)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 8)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 13)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 12)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 16)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 5)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 3)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 10)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 15)) >>> 0;
  return [a, b, c];
}

/** Bob Jenkins lookup2 hash (unsigned). */
function lookup2(key, initval) {
  const k = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');
  const length = k.length;
  let a = 0x9e3779b9, b = 0x9e3779b9, c = initval >>> 0;
  let i = 0, len = length;
  while (len >= 12) {
    a = (a + k.readUInt32LE(i)) >>> 0;
    b = (b + k.readUInt32LE(i + 4)) >>> 0;
    c = (c + k.readUInt32LE(i + 8)) >>> 0;
    [a, b, c] = mix(a, b, c);
    i += 12; len -= 12;
  }
  c = (c + length) >>> 0;
  const t = (n) => (i + n < length ? k[i + n] : 0);
  /* eslint-disable no-fallthrough */
  switch (len) {
    case 11: c = (c + (t(10) << 24)) >>> 0;
    case 10: c = (c + (t(9) << 16)) >>> 0;
    case 9: c = (c + (t(8) << 8)) >>> 0;
    case 8: b = (b + (t(7) << 24)) >>> 0;
    case 7: b = (b + (t(6) << 16)) >>> 0;
    case 6: b = (b + (t(5) << 8)) >>> 0;
    case 5: b = (b + t(4)) >>> 0;
    case 4: a = (a + (t(3) << 24)) >>> 0;
    case 3: a = (a + (t(2) << 16)) >>> 0;
    case 2: a = (a + (t(1) << 8)) >>> 0;
    case 1: a = (a + t(0)) >>> 0;
  }
  /* eslint-enable no-fallthrough */
  [a, b, c] = mix(a, b, c);
  return c >>> 0;
}

/** Atlas sprite-name hash used by the game's texture sprite tables. */
function spriteHash(name) {
  return lookup2(Buffer.from(String(name).toLowerCase(), 'utf8'), 0x12345678);
}

module.exports = { fnv1a, fnv1aU, lookup2, spriteHash };
