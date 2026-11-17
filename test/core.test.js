'use strict';
// Core tests against the real native layer. Run: node --test test/core.test.js  (uses COPIES of real saves in MUTAGEN_FIXTURES)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const FIX = process.env.MUTAGEN_FIXTURES || '/home/claude/fixtures';
const GAME = process.env.MUTAGEN_TEST_GAME; // optional: folder with TMNTSF.exe + PackData\overhead.pak2 (a COPY)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutagen-test-'));
process.env.MUTAGEN_SAVE_DIR = path.join(tmp, 'saves');
process.env.MUTAGEN_DATA_DIR = path.join(tmp, 'data');
process.env.MUTAGEN_FAKE_RUNNING = '0';
const sf = require('../js/core/savefile'), lj = require('../js/core/ljson'), ed = require('../js/core/editor');
const { makeIo } = require('../js/core/io'), { createSaves } = require('../js/core/saves'), { cliTransport } = require('../js/transport-cli');
const GFM = require('../js/core/gamefiles');
// The real native layer (Rust CLI), wrapped so tests can simulate the game running / disk failures.
const transport = cliTransport();
let io, saves, gf; const fault = { running: false, rename: null };
test.before(async () => {
  const env = await transport('env', {});
  io = makeIo(transport, env);
  const realRename = io.rename;
  io.gameRunning = async () => fault.running;
  io.rename = async (a, b) => { if (fault.rename) { const r = await fault.rename(a, b); if (r === 'done') return; } return realRename(a, b); };
  saves = createSaves(io); gf = GFM.createGameFiles(io);
});
test.after(() => transport.close());
const SAVE = path.join(process.env.MUTAGEN_SAVE_DIR, 'saveSlot.GameState0.cloud.json');
function reset() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(process.env.MUTAGEN_SAVE_DIR, { recursive: true });
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(process.env.MUTAGEN_SAVE_DIR, f));
}
const orig = () => sf.decode(fs.readFileSync(path.join(FIX, 'saveSlot.GameState0.cloud.json')));

test('container + JSON round-trip is byte-exact for every fixture', () => {
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.cloud.json'))) {
    const d = sf.decode(fs.readFileSync(path.join(FIX, f)));
    assert.strictEqual(lj.stringify(d.doc), d.text, f);
  }
});

test('damaged saves are refused with a clear message', () => {
  const good = fs.readFileSync(path.join(FIX, 'saveSlot.GameState0.cloud.json'));
  const flip = Buffer.from(good); flip[200] ^= 0xff;
  assert.throws(() => sf.decode(flip), sf.SaveFormatError);
  const md5 = Buffer.from(good); md5[10] = md5[10] === 0x41 ? 0x42 : 0x41;
  assert.throws(() => sf.decode(md5), /Checksum|malformed/);
  assert.throws(() => sf.decode(good.subarray(0, 100)), sf.SaveFormatError);
  assert.throws(() => sf.decode(Buffer.from('hello world, not a save file at all')), sf.SaveFormatError);
});

test('random edit sequences only ever change what they touch (500 rounds)', () => {
  const base = orig().doc;
  const v = ed.view(base, { modHeroes: { Karai: true, Shredder: true } });
  const heroes = v.heroes.map((h) => h.key);
  const powers = ed.DB.powers;
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 500; round++) {
    const ops = [];
    let doc = base;
    for (let k = 0; k < 1 + rnd(6); k++) {
      const vv = ed.view(doc, { modHeroes: { Karai: true, Shredder: true } });
      const pick = rnd(10); let op;
      if (pick === 0) op = { op: 'currency', key: ['dragon', 'dreamer', 'pauldrons', 'blades', 'hearts', 'medallions'][rnd(6)], value: rnd(100000) };
      else if (pick === 1) op = { op: 'heroMat', stat: ed.DB.heroMats[rnd(8)][rnd(2) ? 'talismanStat' : 'wrapsStat'], value: rnd(500) };
      else if (pick === 2) op = { op: 'runResource', key: ['coins', 'lucky_dice', 'revive_tokens'][rnd(3)], value: rnd(9999) };
      else if (pick === 3) { const u = ed.DB.perma[rnd(ed.DB.perma.length)]; op = { op: 'upgrade', buff: u.buff, level: rnd(u.levels.length + 1) }; }
      else if (pick === 4) { const a = ed.DB.artifacts[rnd(ed.DB.artifacts.length)]; op = { op: 'artifact', sym: a.sym, level: 1 + rnd(a.maxLevel) }; }
      else if (pick === 5) { const owned = vv.artifacts.filter((a) => a.owned); op = { op: 'equipArtifact', sym: owned[rnd(owned.length)].sym }; }
      else if (pick === 6) op = { op: 'swapHero', hero: heroes[rnd(heroes.length)], tool: !!rnd(2), heroPowers: !!rnd(2), keepUnmatched: !!rnd(2) };
      else if (pick === 7 && vv.run.powers.length) { const p = vv.run.powers[rnd(vv.run.powers.length)]; op = { op: 'powerLevel', index: p.index, level: 1 + rnd(p.maxLevel) }; }
      else if (pick === 8 && vv.run.powers.length > 1) op = { op: 'powerRemove', index: rnd(vv.run.powers.length) };
      else { const p = powers[rnd(powers.length)]; if (vv.run.powers.some((x) => x.name === p.name)) continue; op = { op: 'powerAdd', ps: p.ps, level: 1 }; }
      try { doc = ed.applyOps(doc, [op]).doc; ops.push(op); } catch (e) { assert.ok(e instanceof ed.EditError, 'only EditErrors expected: ' + e.message); }
    }
    const r = ed.applyOps(base, ops);
    const changed = lj.diff(base, r.doc);
    assert.deepStrictEqual(ed.outsideAllowed(changed, r.touched), [], JSON.stringify(ops));
    // re-encode/decode identical and mirror stays in sync
    const back = sf.decode(sf.encode(r.doc)).doc;
    assert.strictEqual(lj.diff(r.doc, back).length, 0);
    assert.deepStrictEqual(lj.diff(back.state.run, back.state.coop[9].run), []);
    // every power in the run is a known game power, with a valid level and no duplicates
    const fv = ed.view(back, { modHeroes: { Karai: true, Shredder: true } });
    assert.ok(fv.run.powers.every((p) => p.known && p.level >= 1 && p.level <= p.maxLevel), 'powers valid');
    assert.strictEqual(new Set(back.state.run.enhancements.map((e) => lj.val(e.buff_symbol))).size, back.state.run.enhancements.length);
    const inv = back.state.lifetime.artifact_inventory; assert.strictEqual(inv.artifact_symbols.length, inv.artifact_levels.length);
    assert.strictEqual(new Set(inv.artifact_symbols.map(lj.val)).size, inv.artifact_symbols.length, 'no duplicate artifacts');
    const ups = back.state.lifetime.upgrades; assert.strictEqual(new Set(ups.map((u) => lj.val(u.buff_symbol))).size, ups.length, 'no duplicate upgrades');
  }
});

test('swap math: health scales by base HP, all 10 heroes map tool + inspirations', () => {
  const base = orig().doc;
  for (const h of ed.DB.heroes) {
    const p = ed.planSwap(base, { hero: h.key });
    assert.strictEqual(p.newMax, Math.round(360 * h.baseHp / 120));
    const r = ed.applyOps(base, [{ op: 'swapHero', hero: h.key }]).doc;
    const names = ed.view(r).run.powers.map((x) => x.name);
    assert.ok(names.includes(h.startTool.name), h.key + ' tool ' + names);
    const ib = h.insp.map((i) => ed.DB.powers.find((x) => x.ps === i.ps).name);
    for (const n of ib) assert.ok(names.includes(n), h.key + ' insp ' + n);
    assert.strictEqual(names.length, 4);
  }
});

test('masteries map between heroes, and are removed (or kept on request) for Karai/Shredder', () => {
  const base = orig().doc;
  const withM = ed.applyOps(base, [{ op: 'swapHero', hero: 'Raphael' }, { op: 'powerAdd', ps: '*PowerSelect_Mastery_Raphael_003*' }, { op: 'powerAdd', ps: '*PowerSelect_Mastery_Common_002_Raphael*' }]).doc;
  const toDon = ed.view(ed.applyOps(withM, [{ op: 'swapHero', hero: 'Donatello' }]).doc).run.powers.map((p) => p.name);
  assert.ok(toDon.includes('Donatello Mastery 3') && toDon.includes('Common Mastery 2'), toDon.join());
  const toKarai = ed.view(ed.applyOps(withM, [{ op: 'swapHero', hero: 'Karai' }]).doc).run.powers.map((p) => p.name);
  assert.ok(!toKarai.some((n) => n.startsWith('Raphael Mastery')), toKarai.join());
  const keep = ed.view(ed.applyOps(withM, [{ op: 'swapHero', hero: 'Karai', keepUnmatched: true }]).doc).run.powers.map((p) => p.name);
  assert.ok(keep.includes('Raphael Mastery 3'));
});

test('bad inputs are rejected without changing anything', () => {
  const base = orig().doc;
  const bad = [
    { op: 'currency', key: 'dragon', value: -1 }, { op: 'currency', key: 'dragon', value: 1e12 }, { op: 'currency', key: 'nope', value: 5 },
    { op: 'currency', key: 'dragon', value: 'abc' }, { op: 'upgrade', buff: 'Buff_PermaUpgrade_Combat_001_Health', level: 26 },
    { op: 'artifact', sym: '*PermaUpgrade_Artifact_001_ManholeCover*', level: 7 }, { op: 'artifact', sym: '*nope*', level: 1 },
    { op: 'equipArtifact', sym: '*PermaUpgrade_Artifact_015_NoisyPedal*' }, { op: 'swapHero', hero: 'Splinter' },
    { op: 'powerLevel', index: 99, level: 1 }, { op: 'powerLevel', index: 1, level: 4 }, { op: 'powerAdd', ps: '*PowerSelect_Buff_Flame_001_FuriousAttacks*' },
    { op: 'heroMat', stat: 'dark_coins', value: 5 }, { op: 'runResource', key: 'hero', value: 1 }, { op: 'bogus' },
  ];
  for (const op of bad) assert.throws(() => ed.applyOps(base, [op]), ed.EditError, JSON.stringify(op));
});

test('save(): full sequence, backups, stale detection, game running, rollback on write failure', async () => {
  reset();
  const L = await saves.load(0);
  const r = await saves.save(0, [{ op: 'currency', key: 'dragon', value: 777 }], { sha1: L.sha1 });
  assert.ok(r.ok && r.log.length >= 7);
  assert.strictEqual(ed.view((await saves.load(0)).decoded.doc).currencies[0].balance, 777);
  assert.strictEqual((await saves.listBackups()).length, 1);
  // stale
  await assert.rejects(saves.save(0, [{ op: 'currency', key: 'dragon', value: 1 }], { sha1: L.sha1 }), /changed on disk/);
  // running
  fault.running = true;
  await assert.rejects(saves.save(0, [{ op: 'currency', key: 'dragon', value: 1 }], {}), /running/);
  fault.running = false;
  // simulated failure during the final swap -> original restored
  const before = fs.readFileSync(SAVE);
  let n = 0;
  fault.rename = async (a, b) => { if (String(a).endsWith('.mutagen-tmp') && n++ === 0) { fs.writeFileSync(b, 'garbage'); throw new Error('simulated disk failure'); } };
  try { await assert.rejects(saves.save(0, [{ op: 'currency', key: 'dragon', value: 5 }], {}), /Saving failed/); } finally { fault.rename = null; }
  assert.ok(Buffer.compare(before, fs.readFileSync(SAVE)) === 0, 'original restored after failed write');
  // restore an older backup brings the exact original bytes back
  const oldest = (await saves.listBackups()).slice(-1)[0];
  await saves.restoreBackup(oldest.id);
  assert.ok(Buffer.compare(fs.readFileSync(SAVE), fs.readFileSync(path.join(FIX, 'saveSlot.GameState0.cloud.json'))) === 0);
  // damaged backup refused
  const b = (await saves.listBackups())[0];
  fs.writeFileSync(path.join(saves.backupsRoot(), b.id, b.files[0].name), 'broken');
  await assert.rejects(saves.restoreBackup(b.id), /damaged|missing/);
});

test('listSlots: missing folder and unreadable slot are reported, not crashed on', async () => {
  fs.rmSync(process.env.MUTAGEN_SAVE_DIR, { recursive: true, force: true });
  assert.strictEqual((await saves.listSlots()).exists, false);
  reset();
  fs.writeFileSync(path.join(process.env.MUTAGEN_SAVE_DIR, 'saveSlot.GameState1.cloud.json'), 'nope');
  const s = await saves.listSlots();
  assert.strictEqual(s.active, 0);
  assert.deepStrictEqual(s.slots.map((x) => [x.slot, x.ok]), [[0, true], [1, false]]);
});

test('game files: unknown version is refused; stale state handled', { skip: !GAME }, async () => {
  const ov = gf.overheadPath(GAME);
  const shaBefore = crypto.createHash('sha1').update(fs.readFileSync(ov)).digest('hex').toUpperCase();
  assert.ok(GFM.KNOWN_OVERHEAD[shaBefore], 'test copy must start as a known version');
  // full cycle: hero + power edit, read back, re-patch on top, restore = exact original
  const v0 = await gf.readValues(ov);
  const bn = 'Buff_PermaUpgrade_Combat_001_Health' in v0.buffs ? 'Buff_PermaUpgrade_Combat_001_Health' : Object.keys(v0.buffs)[0];
  const fi = v0.buffs[bn].floats.findIndex((x) => x !== -1);
  const fl = v0.buffs[bn].floats.slice(); fl[fi] = 0.5;
  await gf.apply(GAME, { heroes: { Slash: { baseHp: 175, speed: 5 } }, buffs: { [bn]: { floats: fl, ints: v0.buffs[bn].ints } } });
  let v1 = await gf.readValues(ov);
  assert.strictEqual(v1.heroes.Slash.baseHp, 175); assert.strictEqual(v1.heroes.Slash.speed, 5); assert.strictEqual(v1.buffs[bn].floats[fi], 0.5);
  assert.strictEqual((await gf.identify(GAME)).status, 'patched');
  await gf.apply(GAME, { heroes: { Slash: { baseHp: 175, speed: 5 }, Leonardo: { baseHp: 111 } }, buffs: {} });
  v1 = await gf.readValues(ov);
  assert.strictEqual(v1.heroes.Leonardo.baseHp, 111); assert.strictEqual(v1.buffs[bn].floats[fi], v0.buffs[bn].floats[fi], 'built from the clean base each time');
  await gf.restore(GAME);
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(ov)).digest('hex').toUpperCase(), shaBefore, 'restore = exact original');
  assert.strictEqual((await gf.identify(GAME)).status, 'clean');
  // patch, then simulate Steam replacing the file -> restore refuses, forget works
  const vals = await gf.readValues(ov);
  await gf.apply(GAME, { heroes: { Leonardo: { baseHp: 101 } }, buffs: {} });
  const patched = fs.readFileSync(ov);
  const fake = Buffer.from(patched); fake[fake.length - 40] ^= 1; fs.writeFileSync(ov, fake); // "something else changed it"
  let id = await gf.identify(GAME);
  assert.strictEqual(id.status, 'unknown'); assert.ok(id.staleState);
  await assert.rejects(gf.apply(GAME, { heroes: { Leonardo: { baseHp: 102 } }, buffs: {} }), /doesn't recognise/);
  await assert.rejects(gf.restore(GAME), /changed by something else/);
  await gf.forgetState();
  fs.writeFileSync(ov, patched); // put the patched one back, then re-run restore path manually from our own backup? state is gone -> nothing to restore
  id = await gf.identify(GAME); assert.strictEqual(id.status, 'unknown');
  // clean up: rebuild the original by applying the patch inverse
  fs.copyFileSync(process.env.MUTAGEN_TEST_GAME_ORIG, ov);
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(ov)).digest('hex').toUpperCase(), shaBefore);
  assert.ok(vals.heroes.Leonardo.baseHp === 100);
  // failure during install -> original kept
  fault.rename = async (a) => { if (String(a).endsWith('.mutagen-tmp')) throw new Error('simulated failure'); };
  try { await assert.rejects(gf.apply(GAME, { heroes: { Leonardo: { baseHp: 150 } }, buffs: {} }), /simulated/); } finally { fault.rename = null; }
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(ov)).digest('hex').toUpperCase(), shaBefore, 'original intact after failed install');
  assert.ok(!fs.existsSync(ov + '.mutagen-tmp'));
  // invalid values rejected before anything happens
  await assert.rejects(gf.apply(GAME, { heroes: { Leonardo: { baseHp: -5 } }, buffs: {} }), /between/);
  await assert.rejects(gf.apply(GAME, { heroes: {}, buffs: { Buff_Flame_001_FuriousAttacks: { floats: [5], ints: [] } } }), /unused/);
});
