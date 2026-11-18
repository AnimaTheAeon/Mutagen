const fs = require('fs');
const { launch } = require('./lib');
const OUT = '/home/claude/nexus/shots'; fs.mkdirSync(OUT, { recursive: true });
const ENV = '/home/claude/env_shots';
function freshEnv(src, game) {
  fs.rmSync(ENV, { recursive: true, force: true });
  fs.mkdirSync(ENV + '/saves', { recursive: true }); fs.mkdirSync(ENV + '/data', { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(src + '/' + f, ENV + '/saves/' + f);
  return { MUTAGEN_SAVE_DIR: ENV + '/saves', MUTAGEN_DATA_DIR: ENV + '/data', MUTAGEN_GAME_DIR: game, MUTAGEN_FAKE_RUNNING: '0' };
}
// blur the player's name everywhere; show Windows paths instead of the Linux test paths
const PREP = `
  const NAME = 'Anima The Aeon';
  const winPath = (s) => s.replace(/\\/home\\/claude\\/env_shots\\/saves/g, 'C:\\\\Users\\\\You\\\\AppData\\\\Roaming\\\\TMNTSF').replace(/\\/home\\/claude\\/env_shots\\/data/g, 'C:\\\\Users\\\\You\\\\AppData\\\\Local\\\\Mutagen').replace(/(Mutagen)\\/(backups|gamefiles)/g, '$1\\\\$2');
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
  while (w.nextNode()) { const n = w.currentNode; if (n.nodeValue.includes('/home/claude')) n.nodeValue = winPath(n.nodeValue); if (n.nodeValue.includes(NAME)) hits.push(n.parentElement); }
  for (const el of hits) { el.style.filter = 'blur(9px)'; el.style.userSelect = 'none'; }
  document.querySelectorAll('[title]').forEach((e) => { if (e.title.includes(NAME)) e.title = ''; });
  return hits.length;`;
async function shot(p, name) {
  await p.sleep(400);
  const n = await p.js(PREP);
  const left = await p.js("return document.body.innerText.includes('Anima The Aeon') && [...document.querySelectorAll('*')].filter(e=>e.childNodes.length&&[...e.childNodes].some(c=>c.nodeType===3&&c.nodeValue.includes('Anima The Aeon'))&&getComputedStyle(e).filter==='none').length");
  if (left) throw new Error('unblurred name left in ' + name);
  await p.js('document.activeElement && document.activeElement.blur(); window.getSelection().removeAllRanges(); document.querySelectorAll("*").forEach((e) => { if (e.scrollTop > 0 && !e.closest(".dialog, .modal, .sheet")) e.scrollTop = 0; }); window.scrollTo(0, 0);');
  await p.sleep(250);
  fs.writeFileSync(`${OUT}/${name}.png`, await p.d.takeScreenshot(), 'base64');
  console.log('shot', name, 'blurred', n);
}
const waitIcons = (p) => p.d.wait(async () => (await p.js("return [...document.images].filter(i=>i.src.includes('asset') && i.complete && i.naturalWidth>0).length")) > 20, 30000);

(async () => {
  const G = '/home/claude/fakegame_wd';
  // --- older save that has a run (Shredder) ---
  let p = await launch(freshEnv('/home/claude/fixtures', G));
  await p.sleep(3000); await waitIcons(p);
  await shot(p, '01_overview');
  await p.click('[data-act="page"][data-id="run"]'); await p.sleep(800);
  await shot(p, '02_run');
  await p.drag('[data-drag-hero="Raphael"]', '#dropzone'); await p.waitFor('[data-act="swapAdd"]', 8000); await p.sleep(600);
  await shot(p, '03_swap_plan');
  await p.click('[data-act="swapAdd"]');
  await p.click('[data-act="addOpen"]'); await p.sleep(800);
  await shot(p, '04_add_power');
  await p.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await p.sleep(400);
  await p.click('[data-act="page"][data-id="upgrades"]'); await p.sleep(500);
  const sym = await p.js("const t=[...document.querySelectorAll('.atile')].find(e=>/level [3-9] of/.test(e.getAttribute('aria-label'))); return t && t.dataset.sym");
  if (sym) { await p.click(`.atile[data-sym="${sym}"]`); }
  await p.sleep(400);
  await shot(p, '05_upgrades');
  await p.click('[data-act="page"][data-id="overview"]');
  await p.click('button[data-act="cur"][data-key="dragon"][data-d="1000"]');
  await p.click('button[data-act="save"]'); await p.waitFor('#r-t', 30000); await p.sleep(500);
  await shot(p, '06_saved');
  await p.click('[data-act="closeModal"]');
  await p.click('[data-act="page"][data-id="safety"]'); await p.sleep(600);
  await shot(p, '07_safety');
  await p.click('[data-act="page"][data-id="game"]'); await p.waitFor('#w-t'); await p.sleep(400);
  await shot(p, '08_gamefiles_warning');
  await p.click('input[data-in="warnAck"]'); await p.click('#warn-go');
  await p.waitFor('input[data-in="gfHero"]', 60000); await p.sleep(1500);
  await p.fill('input[data-in="gfHero"][data-k="Slash"][data-f="baseHp"]', 150);
  await p.sleep(500);
  await shot(p, '09_gamefiles');
  await p.quit();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
