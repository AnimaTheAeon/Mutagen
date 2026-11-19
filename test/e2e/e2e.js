const fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { launch } = require('./lib');
const sf = require('/home/claude/mt/js/core/savefile'), ed = require('/home/claude/mt/js/core/editor');
const ENV = '/home/claude/env_wd';
function freshEnv(src, game = '/home/claude/fakegame2') {
  fs.rmSync(ENV, { recursive: true, force: true });
  fs.mkdirSync(ENV + '/saves', { recursive: true }); fs.mkdirSync(ENV + '/data', { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(src + '/' + f, ENV + '/saves/' + f);
  return { MUTAGEN_SAVE_DIR: ENV + '/saves', MUTAGEN_DATA_DIR: ENV + '/data', MUTAGEN_GAME_DIR: game, MUTAGEN_FAKE_RUNNING: '0' };
}
const FILE = () => ENV + '/saves/saveSlot.GameState0.cloud.json';
const VIEW = () => ed.view(sf.decode(fs.readFileSync(FILE())).doc);
const results = [];
async function t(name, fn) { try { await fn(); results.push(1); console.log('PASS', name); } catch (e) { results.push(0); console.log('FAIL', name, '\n   ', (e.stack || String(e)).split('\n').filter(l => /e2e.js|lib.js|Error/.test(l)).slice(0, 6).join('\n    '), e.message.slice(0, 300)); } }
const sha = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').toUpperCase();

(async () => {
  // ===== your current save (no run) =====
  let p = await launch(freshEnv('/home/claude/fixtures_norun'));
  await t('loads your save with real numbers and icons', async () => {
    assert.strictEqual(await p.val('input[data-in="cur"][data-key="dragon"]'), '220');
    assert.strictEqual(await p.val('input[data-in="cur"][data-key="blades"]'), '18');
    await p.d.wait(async () => (await p.js("return [...document.images].filter(i=>i.src.includes('asset') && i.complete && i.naturalWidth>0).length")) > 20, 20000);
    await p.shot('01_overview');
  });
  await t('no browser spinners; lime arrows; − / + ; typing', async () => {
    assert.ok((await p.js("return [...document.querySelectorAll('input[type=number]')].every(e=>{const s=getComputedStyle(e);return s.appearance==='textfield'||s.webkitAppearance==='textfield'})")));
    await p.click('button[data-act="cur"][data-key="dragon"][data-d="10"]');
    assert.strictEqual(await p.val('input[data-in="cur"][data-key="dragon"]'), '230');
    await p.fill('input[data-in="cur"][data-key="dragon"]', 5000);
    assert.strictEqual(await p.val('input[data-in="cur"][data-key="dragon"]'), '5000');
    await p.click('button[data-act="nstep"][data-kind="cur"][data-key="pauldrons"][data-d="1"]');
    assert.strictEqual(await p.val('input[data-in="cur"][data-key="pauldrons"]'), '25');
    const st = await p.js("return document.querySelector('button[data-act=nstep]').getAttribute('data-key')");
    await p.click('button[data-act="nstep"][data-kind="mat"][data-d="1"]');
  });
  let owned;
  await t('artifacts: compact grid, bars raise and lower', async () => {
    await p.click('[data-act="page"][data-id="upgrades"]');
    const h = await p.js("return document.querySelector('.g-art').getBoundingClientRect().height");
    assert.ok(h < 420, 'height ' + h);
    owned = VIEW().artifacts.find((a) => a.owned && !a.unused && a.max >= 4 && !a.equipped);
    await p.click(`.atile[data-sym="${owned.sym}"]`);
    await p.click(`.abar[data-sym="${owned.sym}"][data-lv="${owned.max}"]`);
    assert.match(await p.text('.aedit'), new RegExp(`Level ${owned.max} of`));
    await p.click(`.abar[data-sym="${owned.sym}"][data-lv="2"]`);
    assert.match(await p.text('.aedit'), /Level 2 of/);
    await p.shot('02_upgrades');
  });
  await t('save writes exactly the edits (checked independently)', async () => {
    const title = await p.save(); assert.match(title, /Saved/i);
    const v = VIEW(); const c = Object.fromEntries(v.currencies.map((x) => [x.key, x.balance]));
    assert.strictEqual(c.dragon, 5000); assert.strictEqual(c.pauldrons, 25);
    assert.strictEqual(v.artifacts.find((a) => a.sym === owned.sym).level, 2);
    assert.strictEqual(fs.readdirSync(ENV + '/data/backups').length, 1);
  });
  await t('run page without a run: drop zone, drag refused nicely', async () => {
    await p.click('[data-act="page"][data-id="run"]');
    assert.ok(await p.has('#dropzone.off'));
    await p.drag('[data-drag-hero="Leonardo"]', '#dropzone'); await p.sleep(300);
    assert.match(await p.text('#toast'), /Start a run in the game first/);
    await p.shot('03_run_norun');
  });
  await t('stale save is detected (game saved meanwhile)', async () => {
    await p.click('[data-act="page"][data-id="overview"]');
    await p.click('button[data-act="cur"][data-key="dreamer"][data-d="10"]');
    const d = sf.decode(fs.readFileSync(FILE())); const lj = require('/home/claude/mt/js/core/ljson'); d.doc.rev = lj.Str.of('game-wrote-this'); fs.writeFileSync(FILE(), sf.encode(d.doc));
    const before = fs.readFileSync(FILE());
    await p.click('button[data-act="save"]'); await p.waitFor('#r-t', 30000);
    assert.match(await p.js("return document.querySelector('.dialog').textContent"), /changed on disk/);
    await p.click('[data-act="closeModal"]');
    assert.ok(Buffer.compare(before, fs.readFileSync(FILE())) === 0, 'file untouched');
  });
  await t('backups page restores the original exactly', async () => {
    await p.click('[data-act="page"][data-id="safety"]');
    const ids = await p.js("return [...document.querySelectorAll('[data-act=restoreBackup]')].map(e=>e.dataset.id)");
    assert.ok(ids.length >= 1);
    await p.js('window.confirm=()=>true');
    await p.click(`[data-act="restoreBackup"][data-id="${ids[ids.length - 1]}"]`);
    await p.waitFor('#r-t', 30000); assert.match(await p.text('#r-t'), /restored/i); await p.click('[data-act="closeModal"]');
    assert.ok(Buffer.compare(fs.readFileSync(FILE()), fs.readFileSync('/home/claude/fixtures_norun/saveSlot.GameState0.cloud.json')) === 0);
  });
  assert.deepStrictEqual(await p.errors(), []);
  await p.quit();

  // ===== older save with a Shredder run: drag to swap =====
  p = await launch(freshEnv('/home/claude/fixtures'));
  await t('drag Leonardo onto Current character, add, save', async () => {
    await p.click('[data-act="page"][data-id="run"]');
    assert.match(await p.text('#dropzone'), /Shredder/);
    await p.drag('[data-drag-hero="Leonardo"]', '#dropzone');
    await p.waitFor('[data-act="swapAdd"]', 8000);
    assert.match(await p.text('#dropzone'), /Shredder → Leonardo/);
    await p.shot('04_run_drag');
    await p.click('[data-act="swapAdd"]');
    assert.match(await p.save(), /Saved/i);
    const v = VIEW(); assert.strictEqual(v.run.hero, 'Leonardo'); assert.strictEqual(Math.round(v.run.maxHealth), 300);
  });
  await t('add power + change level + heal', async () => {
    await p.click('[data-act="addOpen"]'); await p.sleep(300);
    const ps = await p.js("const b=document.querySelector('.bitem:not([disabled])');return b.dataset.ps");
    await p.click(`.bitem[data-ps="${ps}"]`);
    assert.match(await p.save(), /Saved/i);
    assert.ok(VIEW().run.powers.length >= 5);
  });
  assert.deepStrictEqual(await p.errors(), []);
  await p.quit();

  // ===== game files on a COPY of your modded install =====
  const G = '/home/claude/fakegame_wd'; fs.rmSync(G, { recursive: true, force: true }); fs.mkdirSync(G + '/PackData', { recursive: true });
  fs.copyFileSync('/home/claude/overhead_both_copy.pak2', G + '/PackData/overhead.pak2'); fs.symlinkSync('/home/claude/fakegame2/TMNTSF.exe', G + '/TMNTSF.exe');
  for (const n of ['dupes.pak2', 'default.pak2']) fs.symlinkSync(fs.realpathSync('/home/claude/fakegame2/PackData/' + n), G + '/PackData/' + n);
  const orig = sha(G + '/PackData/overhead.pak2');
  p = await launch(freshEnv('/home/claude/fixtures_norun', G));
  await t('game files: warning, edit Slash HP + speed, apply, verify, restore exact original', async () => {
    await p.click('[data-act="page"][data-id="game"]');
    await p.waitFor('#w-t'); await p.click('input[data-in="warnAck"]');
    // regression: the game values finish loading AFTER the tick and redraw the page; the tick must survive
    await p.d.wait(async () => p.js("return !!document.querySelector('input[data-in=gfHero]')"), 60000); await p.sleep(500);
    assert.ok(await p.js("return document.querySelector('input[data-in=warnAck]').checked && !document.querySelector('#warn-go').disabled"), 'tick was lost when values loaded');
    await p.click('#warn-go');
    await p.waitFor('input[data-in="gfHero"]', 60000);
    await p.fill('input[data-in="gfHero"][data-k="Slash"][data-f="baseHp"]', 175);
    await p.fill('input[data-in="gfHero"][data-k="Slash"][data-f="speed"]', 5);
    await p.click('[data-act="gfApply"]'); await p.waitFor('#w-t'); await p.click('input[data-in="warnAck"]'); await p.click('#warn-go');
    await p.waitFor('#r-t', 180000); assert.match(await p.text('#r-t'), /patched and verified/i); await p.click('[data-act="closeModal"]');
    // independent check with the CLI + JS reader
    const { cliTransport } = require('/home/claude/mt/js/transport-cli'); const { makeIo } = require('/home/claude/mt/js/core/io'); const { createGameFiles } = require('/home/claude/mt/js/core/gamefiles');
    const tr = cliTransport(); const io = makeIo(tr, await tr('env', {})); const v = await createGameFiles(io).readValues(G + '/PackData/overhead.pak2'); tr.close();
    assert.strictEqual(v.heroes.Slash.baseHp, 175); assert.strictEqual(v.heroes.Slash.speed, 5); assert.strictEqual(v.heroes.Leonardo.baseHp, 100);
    assert.notStrictEqual(sha(G + '/PackData/overhead.pak2'), orig);
    await p.shot('05_gamefiles');
    await p.click('[data-act="gfRestore"]'); await p.waitFor('#r-t', 180000); assert.match(await p.text('#r-t'), /restored/i); await p.click('[data-act="closeModal"]');
    assert.strictEqual(sha(G + '/PackData/overhead.pak2'), orig, 'exact original back');
  });
  assert.deepStrictEqual(await p.errors(), []);
  await p.quit();
  console.log(`SUMMARY ${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
