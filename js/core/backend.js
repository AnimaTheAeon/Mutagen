'use strict';
// Implements the `mutagen` API the UI uses (formerly Electron's main process). Runs in the app window
// on top of the native io layer; also runs in Node for tests.
const ed = require('./editor');
const iconKeys = require('./iconkeys');
const { createSaves } = require('./saves');
const { createGameFiles, HERO_LIMITS } = require('./gamefiles');
const { createIcons } = require('./icons');

function createBackend(io, host) {
  // host: { version, fileUrl(path), openPath(path), chooseFolder() }
  const saves = createSaves(io);
  const gf = createGameFiles(io);
  const icons = createIcons(io);
  const listeners = { 'icons:ready': [], 'game:progress': [] };
  const emit = (ch, data) => (listeners[ch] || []).forEach((fn) => { try { fn(data); } catch { /* ignore */ } });

  const settingsPath = () => io.join(io.env.dataDir, 'settings.json');
  const settings = () => io.readJson(settingsPath(), {});
  const saveSettings = async (s) => io.writeJson(settingsPath(), Object.assign(await settings(), s));

  const loaded = new Map(); // slot -> { sha1, mtime, decoded }
  let gameDir = null, gameInfo = null, iconMap = {}, iconsReady = false, iconRun = 0;
  const shaCache = {};

  const modHeroes = () => (gameInfo ? { Karai: !!gameInfo.base.karai, Shredder: !!gameInfo.base.shredder } : { Karai: false, Shredder: false });
  const publicInfo = (i) => ({ status: i.status, base: i.base, overheadSha: i.overheadSha, exeKind: i.exeKind, staleState: i.staleState, patchedAt: i.state && i.status === 'patched' ? i.state.applied : null });

  async function refreshGame() {
    gameDir = await io.findGameDir((await settings()).gameDir);
    if (gameDir) {
      await saveSettings({ gameDir });
      try { gameInfo = await gf.identify(gameDir, { shaCache }); } catch { gameInfo = null; }
    } else gameInfo = null;
    return { gameDir, info: gameInfo ? publicInfo(gameInfo) : null };
  }

  function startIcons() {
    const run = ++iconRun;
    iconsReady = false;
    if (!gameDir) { iconsReady = true; emit('icons:ready', {}); return; }
    icons.extract(gameDir, iconKeys.all(), { maxSide: 256 })
      .then((m) => { if (run !== iconRun) return; iconMap = {}; for (const [k, f] of Object.entries(m)) iconMap[k] = host.fileUrl(f); })
      .catch(() => {})
      .finally(() => { if (run !== iconRun) return; iconsReady = true; emit('icons:ready', iconMap); });
  }

  function viewFor(slot, ops) {
    const L = loaded.get(slot);
    if (!L) throw new Error('Save not loaded.');
    const { doc } = ed.applyOps(L.decoded.doc, ops || []);
    return ed.view(doc, { modHeroes: modHeroes() });
  }

  const api = {
    async init() {
      const g = await refreshGame();
      startIcons();
      const s = await saves.listSlots();
      const cloud = await io.exists(io.join(io.env.saveDir, 'steam_autocloud.vdf'));
      return { version: host.version, saveDir: s.dir, saveDirExists: s.exists, slots: s.slots, active: s.active, cloud, game: g, dataDir: io.env.dataDir };
    },
    gameRunning: () => io.gameRunning(),
    icons: async () => ({ ready: iconsReady, icons: iconMap }),
    async catalog() {
      const DB = ed.DB;
      const buffName = (name) => {
        const p = DB.powers.find((x) => x.buff === name || x.buff === 'BuffMarker_' + name);
        if (p) return { name: p.name, kind: p.kind, icon: iconKeys.powerIcon(p), family: p.family };
        const k = Object.values(DB.knownPs).find((x) => x.buff === name || x.buff === 'BuffMarker_' + name);
        if (k) return { name: k.name, kind: 'other', icon: iconKeys.powerIcon(k), family: null };
        return { name: name.split('_').pop().replace(/([a-z])([A-Z])/g, '$1 $2'), kind: 'other', icon: null, family: null };
      };
      return {
        powers: DB.powers.map((p) => ({ ps: p.ps, name: p.name, kind: p.kind, family: p.family, hero: p.hero, maxLevel: p.maxLevel, icon: iconKeys.powerIcon(p) })),
        buffs: Object.keys(DB.buffRecords).map((n) => Object.assign({ id: n }, buffName(n))),
        heroes: DB.heroes.map((h) => ({ key: h.key, name: h.name, mod: h.mod, avatar: iconKeys.heroAvatar(h), portrait: iconKeys.heroPortrait(h), color: h.color })),
      };
    },
    async load(slot) {
      const L = await saves.load(slot);
      loaded.set(slot, L);
      return { slot, sha1: L.sha1, md5: L.decoded.md5, mtime: L.mtime, view: ed.view(L.decoded.doc, { modHeroes: modHeroes() }) };
    },
    preview: async (slot, ops) => ({ view: viewFor(slot, ops) }),
    async planSwap(slot, ops, args) {
      const L = loaded.get(slot);
      if (!L) throw new Error('Save not loaded.');
      const { doc } = ed.applyOps(L.decoded.doc, ops || []);
      return ed.planSwap(doc, args);
    },
    async write(slot, ops) {
      const L = loaded.get(slot);
      if (!L) throw new Error('Save not loaded.');
      const r = await saves.save(slot, ops, { sha1: L.sha1 });
      const fresh = await saves.load(slot);
      loaded.set(slot, fresh);
      return Object.assign(r, { sha1: fresh.sha1, view: ed.view(fresh.decoded.doc, { modHeroes: modHeroes() }) });
    },
    backups: () => saves.listBackups(),
    restoreBackup: (id) => saves.restoreBackup(id),
    async openBackups() { await io.mkdir(saves.backupsRoot()); await host.openPath(saves.backupsRoot()); return true; },
    async openSaves() { await host.openPath(io.env.saveDir); return true; },
    gameRefresh: () => refreshGame(),
    async gameChoose() {
      const p = await host.chooseFolder();
      if (!p) return { cancelled: true };
      if (!(await io.isGameDir(p))) throw new Error('That folder doesn\'t contain TMNTSF.exe and PackData\\overhead.pak2.');
      await saveSettings({ gameDir: p });
      const g = await refreshGame();
      startIcons();
      return g;
    },
    async gameValues() {
      if (!gameDir) throw new Error('Game folder not found.');
      const current = await gf.readValues(gf.overheadPath(gameDir));
      let base = current;
      if (gameInfo && gameInfo.status === 'patched' && gameInfo.state) {
        const bp = io.join(io.env.dataDir, 'gamefiles', 'overhead.pak2.base');
        if (await io.exists(bp)) base = await gf.readValues(bp);
      }
      return { current, base, limits: HERO_LIMITS };
    },
    async gameApply(edits) {
      if (!gameDir) throw new Error('Game folder not found.');
      const r = await gf.apply(gameDir, edits, (s) => emit('game:progress', s));
      await refreshGame();
      return r;
    },
    async gameRestore() {
      if (!gameDir) throw new Error('Game folder not found.');
      const r = await gf.restore(gameDir, (s) => emit('game:progress', s));
      await refreshGame();
      return r;
    },
    async gameForget() { await gf.forgetState(); return refreshGame(); },
  };

  // Every call returns either its result or { error, code, log } — exactly what the UI expects.
  const out = {};
  for (const [k, fn] of Object.entries(api)) {
    out[k] = async (...args) => { try { return await fn(...args); } catch (e) { return { error: (e && e.message) || String(e), code: (e && e.code) || null, log: (e && e.log) || [] }; } };
  }
  out.on = (ch, fn) => { if (listeners[ch]) listeners[ch].push(fn); };
  out._internal = { saves, gf, icons, io };
  return out;
}
module.exports = { createBackend };
