'use strict';
// Tests that need no personal files (run in CI on Windows). The full suite with real save copies is core.test.js.
const test = require('node:test');
const assert = require('node:assert');
const sf = require('../js/core/savefile'), lj = require('../js/core/ljson'), hash = require('../js/core/hash'), ed = require('../js/core/editor');

test('ljson keeps number/string text exactly', () => {
  const t = '{"a":1.0,"b":-0.0,"c":1e5,"d":"x\\u00e9\\n","e":[1,2.50,{"f":null,"g":true}],"h":12345678901234567890}';
  assert.strictEqual(lj.stringify(lj.parse(t)), t);
});

test('save container round-trips and rejects damage', () => {
  const doc = lj.parse('{"handle":"Tester","state":{"lifetime":{"x":1.0}},"rev":"abc"}');
  const bytes = sf.encode(doc, { version: 1235, trailingNul: true });
  const d = sf.decode(bytes);
  assert.strictEqual(d.version, 1235); assert.ok(d.trailingNul);
  assert.strictEqual(lj.stringify(d.doc), lj.stringify(doc));
  assert.strictEqual(d.md5, sf.md5Hex(d.raw));
  const bad = Buffer.from(bytes); bad[bad.length - 3] ^= 0xff;
  assert.throws(() => sf.decode(bad), sf.SaveFormatError);
  assert.throws(() => sf.decode(bytes.subarray(0, 30)), sf.SaveFormatError);
});

test('hashes match the game', () => {
  assert.strictEqual(hash.fnv1aU(''), 0x811c9dc5);
  assert.strictEqual(sf.md5Hex(Buffer.from('abc')), '900150983CD24FB0D6963F7D28E17F72');
  assert.strictEqual(sf.sha1Hex(Buffer.from('abc')), 'A9993E364706816ABA3E25717850C26C9CD0D89D');
  // every hero in the database resolves its run hash from its actor symbol
  for (const h of ed.DB.heroes) assert.strictEqual(typeof h.runHash, 'number');
});

test('editor database is complete', () => {
  assert.strictEqual(ed.DB.heroes.length, 10);
  assert.ok(ed.DB.powers.length > 300 && ed.DB.artifacts.length === 40 && ed.DB.perma.length === 58);
});
