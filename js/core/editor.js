'use strict';
// All save edits. Every operation works on a parsed (lossless) save tree and records
// which paths it is allowed to touch, so the write step can prove nothing else changed.
const { Num, clone, val, diff } = require('./ljson');
const { fnv1a } = require('./hash');
const DB = require('./gamedb.json');

class EditError extends Error {}

const HEROES = DB.heroes;
const HERO_BY_HASH = new Map(HEROES.map((h) => [h.runHash, h]));
const HERO_BY_KEY = new Map(HEROES.map((h) => [h.key, h]));
const POWERS_BY_PS = new Map(DB.powers.map((p) => [p.psHash, p]));
const PS_BY_NAME = new Map(DB.powers.map((p) => [p.ps, p]));
const PERMA_BY_BUFF = new Map(DB.perma.map((p) => [p.buffHash, p]));
const ARTS_BY_HASH = new Map(DB.artifacts.map((a) => [a.symHash, a]));
const START_TOOL_BUFFS = new Set(DB.startToolBuffs.map((b) => fnv1a(b)));
const CURRENCY = new Map(DB.currencies.map((c) => [c.key, c]));
const HERO_MAT_STATS = new Set(DB.heroMats.flatMap((m) => [m.talismanStat, m.wrapsStat]));
const BUFF_NAME = new Map(Object.values(DB.knownPs).filter((k) => k.buff).map((k) => [fnv1a(k.buff), k.buff]));
const RUN_RESOURCES = { coins: 'Scrap', lucky_dice: 'Lucky Dice', revive_tokens: "Splinter's Revives" };
const MAX_VALUE = 9999999;

function knownPs(hash) {
  return DB.knownPs[String(hash)] || null;
}

// ---------- low-level helpers ----------
function S(doc) {
  if (!doc || !doc.state) throw new EditError('This does not look like a Splintered Fate save (no state).');
  return doc.state;
}
function statValue(stats, name) {
  const s = stats && stats[name];
  if (!s) return 0;
  return val(s.value);
}
/** Set a single-value stat ({value, values:[{key:0,value}]}), creating it in the game's shape if missing. */
function setStatValue(stats, name, v) {
  if (!Number.isFinite(v) || v < 0) throw new EditError(`Invalid value for ${name}: ${v}`);
  const s = stats[name];
  if (!s) {
    stats[name] = { value: Num.float(v), values: [{ key: Num.int(0), value: Num.float(v) }] };
    return;
  }
  s.value = Num.like(s.value, v);
  if (Array.isArray(s.values)) {
    const z = s.values.find((e) => val(e.key) === 0);
    if (z) z.value = Num.like(z.value, v);
    else s.values.unshift({ key: Num.int(0), value: Num.float(v) });
  } else {
    s.values = [{ key: Num.int(0), value: Num.float(v) }];
  }
}
function clampInt(v, lo, hi, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new EditError(`${what}: "${v}" is not a number.`);
  const r = Math.round(v);
  if (r < lo || r > hi) throw new EditError(`${what} must be between ${lo} and ${hi} (got ${r}).`);
  return r;
}

/** coop entries that mirror the live run (the game keeps an identical copy there). */
function mirrorIndexes(doc) {
  const st = S(doc);
  const out = [];
  (st.coop || []).forEach((c, i) => {
    if (c && val(c.valid) === 1 && c.run && st.run && diff(c.run, st.run).length === 0) out.push(i);
  });
  return out;
}

function hasRun(doc) {
  const st = S(doc);
  return !!(st.run && val(st.run.hero) !== 0 && st.level && val(st.level.run_is_resumable) === 1);
}

// ---------- read-only view ----------
function heroForRun(doc) {
  const h = val(S(doc).run && S(doc).run.hero);
  return HERO_BY_HASH.get(h) || null;
}

function powerInfo(e) {
  const ps = val(e.enhancement_symbol), buff = val(e.buff_symbol);
  const p = POWERS_BY_PS.get(ps);
  const k = knownPs(ps);
  const base = p || (k ? { ps: k.ps, buff: k.buff, kind: { 5: 'power', 6: 'mastery', 7: 'tool', 8: 'inspiration' }[k.cat] || 'other', maxLevel: k.maxLevel || 3, name: k.name, atlas: k.atlas, icon: k.icon, hero: null } : null);
  return {
    psHash: ps, buffHash: buff,
    known: !!base,
    name: base ? base.name : `Unknown power (${ps})`,
    kind: base ? base.kind : 'other',
    maxLevel: base ? Math.max(1, base.maxLevel || 1) : Math.max(1, val(e.level)),
    level: val(e.level),
    hero: base ? base.hero : null,
    atlas: base ? base.atlas : null,
    icon: base ? base.icon : null,
    startTool: START_TOOL_BUFFS.has(buff),
  };
}

function view(doc, { modHeroes = { Karai: false, Shredder: false } } = {}) {
  const st = S(doc);
  const L = st.lifetime || {};
  const stats = L.stats || {};
  const currencies = DB.currencies.map((c) => {
    const earned = statValue(stats, c.stat);
    const spent = c.spent ? statValue(stats, c.spent) : 0;
    return { key: c.key, name: c.name, icon: c.icon, kind: c.kind, balance: earned - spent, earned, spent };
  });
  const heroMats = DB.heroMats.map((m) => ({ hero: m.hero, short: m.short, talismans: statValue(stats, m.talismanStat), wraps: statValue(stats, m.wrapsStat), talismanStat: m.talismanStat, wrapsStat: m.wrapsStat }));
  const upgrades = DB.perma.map((p) => {
    const e = (L.upgrades || []).find((u) => val(u.buff_symbol) === p.buffHash);
    const level = e ? val(e.level) : 0;
    const next = level < p.levels.length ? p.levels[level] : null;
    return { buff: p.buff, name: p.name, tab: p.tab, atlas: p.atlas, icon: p.icon, level, max: p.levels.length, value: p.value, fmt: p.fmt, unused: p.unused,
      next: next ? { cost: next[0], req: next[1] === 25 ? null : { currency: DB.reqCurrencyNames[next[1]], amount: next[2] } } : null };
  });
  const inv = L.artifact_inventory || { artifact_symbols: [], artifact_levels: [] };
  const equippedHash = L.artifact ? val(L.artifact.artifact_symbol) : 0;
  const artifacts = DB.artifacts.map((a) => {
    const i = (inv.artifact_symbols || []).findIndex((s) => val(s) === a.symHash);
    return { sym: a.sym, name: a.name, icon: a.icon, max: a.maxLevel, base: a.base, per: a.per, fmt: a.fmt, unused: a.unused,
      owned: i >= 0, level: i >= 0 ? val(inv.artifact_levels[i]) : 0, equipped: a.symHash === equippedHash };
  });
  const run = st.run || {};
  const runHero = heroForRun(doc);
  const runStats = run.stats || {};
  const owned = new Set(HEROES.filter((h) => !h.mod).filter((h) => h.dlc === 0 || ((val(st.level && st.level.host_dlc_bits) >> h.dlc) & 1)).map((h) => h.key));
  if (modHeroes.Karai) owned.add('Karai');
  if (modHeroes.Shredder) owned.add('Shredder');
  if (runHero && hasRun(doc)) owned.add(runHero.key); // the hero already in the run is always shown
  return {
    player: { handle: val(doc.handle), id: val(doc.player_id) },
    profile: {
      runs: statValue(stats, 'runs_started'),
      wins: statValue(stats, 'victories'),
      timePlayed: statValue(stats, 'time_in_game'),
      bestTime: statValue(stats, 'best_time'),
      bestStreak: statValue(stats, 'best_streak'),
    },
    currencies, heroMats, upgrades, artifacts,
    equipped: equippedHash ? (ARTS_BY_HASH.get(equippedHash) || { name: 'Unknown artifact' }).name : null,
    run: hasRun(doc) ? {
      hero: runHero ? runHero.key : null,
      heroHash: val(run.hero),
      health: val(run.player_health), maxHealth: val(run.player_max_health),
      level: val(st.level.level_name), chapter: val(st.level.current_chapter),
      roomIndex: val(st.level.current_room_sequence_index), rooms: (st.level.room_sequence_elements || []).length,
      resources: Object.keys(RUN_RESOURCES).map((k) => ({ key: k, name: RUN_RESOURCES[k], value: statValue(runStats, k) })),
      powers: (run.enhancements || []).map((e, index) => Object.assign({ index }, powerInfo(e))),
      mirrors: mirrorIndexes(doc).length,
    } : null,
    heroes: HEROES.map((h) => ({ key: h.key, name: h.name, short: h.short, baseHp: h.baseHp, color: h.color, avatar: h.avatar, portrait: h.portrait, mod: h.mod, available: owned.has(h.key), tool: h.startTool.name })),
  };
}

// ---------- operations ----------
// Each returns { touched: [path prefixes] }.

function opCurrency(doc, { key, value }) {
  const c = CURRENCY.get(key);
  if (!c) throw new EditError('Unknown currency ' + key);
  const v = clampInt(value, 0, MAX_VALUE, c.name);
  const stats = S(doc).lifetime.stats;
  const spent = c.spent ? statValue(stats, c.spent) : 0;
  setStatValue(stats, c.stat, spent + v); // balance = earned - spent; spent history is kept
  return { touched: [`.state.lifetime.stats.${c.stat}`] };
}

function opHeroMat(doc, { stat, value }) {
  if (!HERO_MAT_STATS.has(stat)) throw new EditError('Unknown material ' + stat);
  const v = clampInt(value, 0, MAX_VALUE, stat);
  setStatValue(S(doc).lifetime.stats, stat, v);
  return { touched: [`.state.lifetime.stats.${stat}`] };
}

function withRun(doc, fn) {
  if (!hasRun(doc)) throw new EditError('There is no run in progress in this save.');
  const st = S(doc);
  const mirrors = mirrorIndexes(doc);
  const touched = fn(st.run, '.state.run');
  for (const i of mirrors) touched.push(...fn(st.coop[i].run, `.state.coop[${i}].run`));
  return { touched };
}

function opRunResource(doc, { key, value }) {
  if (!RUN_RESOURCES[key]) throw new EditError('Unknown run resource ' + key);
  const v = clampInt(value, 0, 99999, RUN_RESOURCES[key]);
  return withRun(doc, (run, p) => { setStatValue(run.stats, key, v); return [`${p}.stats.${key}`]; });
}

function opRunHealth(doc, { value }) {
  return withRun(doc, (run, p) => {
    const max = val(run.player_max_health);
    const v = value === 'full' ? max : clampInt(value, 1, Math.floor(max), 'Health');
    run.player_health = Num.like(run.player_health, v);
    return [`${p}.player_health`];
  });
}

function opUpgrade(doc, { buff, level }) {
  const p = DB.perma.find((x) => x.buff === buff);
  if (!p) throw new EditError('Unknown upgrade ' + buff);
  const lv = clampInt(level, 0, p.levels.length, p.name);
  const L = S(doc).lifetime;
  if (!Array.isArray(L.upgrades)) throw new EditError('Save has no upgrades list.');
  const i = L.upgrades.findIndex((u) => val(u.buff_symbol) === p.buffHash);
  if (lv === 0) { if (i >= 0) L.upgrades.splice(i, 1); }
  else if (i >= 0) L.upgrades[i].level = Num.like(L.upgrades[i].level, lv);
  else L.upgrades.push({ version: Num.int(1), buff_symbol: Num.int(p.buffHash), level: Num.int(lv) });
  return { touched: ['.state.lifetime.upgrades'] };
}

function opArtifact(doc, { sym, level }) {
  const a = DB.artifacts.find((x) => x.sym === sym);
  if (!a) throw new EditError('Unknown artifact ' + sym);
  const lv = clampInt(level, 1, a.maxLevel, a.name);
  const L = S(doc).lifetime;
  const inv = L.artifact_inventory;
  if (!inv || !Array.isArray(inv.artifact_symbols) || !Array.isArray(inv.artifact_levels) || inv.artifact_symbols.length !== inv.artifact_levels.length) {
    throw new EditError('The artifact list in this save has an unexpected shape.');
  }
  const touched = ['.state.lifetime.artifact_inventory'];
  const i = inv.artifact_symbols.findIndex((s) => val(s) === a.symHash);
  if (i >= 0) inv.artifact_levels[i] = Num.like(inv.artifact_levels[i], lv);
  else {
    inv.artifact_symbols.push(Num.int(a.symHash));
    inv.artifact_levels.push(Num.int(lv));
    // mark it as seen so the game doesn't treat it as a brand-new discovery
    const seen = L.stats && L.stats.stat_artifact_seen;
    if (seen && Array.isArray(seen.values) && !seen.values.some((e) => val(e.key) === a.symHash)) {
      seen.values.push({ key: Num.int(a.symHash), value: Num.float(1) });
      touched.push('.state.lifetime.stats.stat_artifact_seen');
    }
  }
  if (L.artifact && val(L.artifact.artifact_symbol) === a.symHash) {
    L.artifact.level = Num.like(L.artifact.level, lv);
    touched.push('.state.lifetime.artifact');
  }
  return { touched };
}

function opEquipArtifact(doc, { sym }) {
  const a = DB.artifacts.find((x) => x.sym === sym);
  if (!a) throw new EditError('Unknown artifact ' + sym);
  const L = S(doc).lifetime;
  const inv = L.artifact_inventory;
  const i = inv.artifact_symbols.findIndex((s) => val(s) === a.symHash);
  if (i < 0) throw new EditError(`${a.name} isn't unlocked yet.`);
  if (!L.artifact) throw new EditError('Save has no equipped-artifact slot.');
  L.artifact.artifact_symbol = Num.int(a.symHash);
  L.artifact.level = Num.like(L.artifact.level, val(inv.artifact_levels[i]));
  L.artifact.aux = Num.like(L.artifact.aux, 0);
  return { touched: ['.state.lifetime.artifact'] };
}

function opPowerLevel(doc, { index, level }) {
  return withRun(doc, (run, p) => {
    const e = run.enhancements[index];
    if (!e) throw new EditError('That power is no longer in the run.');
    const info = powerInfo(e);
    const lv = clampInt(level, 1, info.maxLevel, info.name);
    e.level = Num.like(e.level, lv);
    return [`${p}.enhancements`];
  });
}

function opPowerRemove(doc, { index }) {
  return withRun(doc, (run, p) => {
    if (!run.enhancements[index]) throw new EditError('That power is no longer in the run.');
    run.enhancements.splice(index, 1);
    return [`${p}.enhancements`];
  });
}

function newEnhancement(p, level) {
  return { version: Num.int(1), buff_symbol: Num.int(p.buffHash), enhancement_symbol: Num.int(p.psHash), level: Num.int(level), aux: Num.int(0), roomDuration: Num.int(0) };
}

function opPowerAdd(doc, { ps, level }) {
  const p = PS_BY_NAME.get(ps);
  if (!p) throw new EditError('Unknown power ' + ps);
  const lv = clampInt(level == null ? 1 : level, 1, Math.max(1, p.maxLevel), p.name);
  return withRun(doc, (run, path) => {
    if (run.enhancements.some((e) => val(e.buff_symbol) === p.buffHash)) throw new EditError(`${p.name} is already in this run.`);
    if (p.kind === 'tool') {
      // a run holds one tool: replace the current one
      const ti = run.enhancements.findIndex((e) => powerInfo(e).kind === 'tool');
      if (ti >= 0) run.enhancements[ti] = newEnhancement(p, lv);
      else run.enhancements.push(newEnhancement(p, lv));
    } else {
      run.enhancements.push(newEnhancement(p, lv));
    }
    return [`${path}.enhancements`];
  });
}

/** Map one hero-bound enhancement to the target hero. Returns {action:'keep'|'replace'|'remove', to}. */
function mapHeroBound(e, from, to, opts) {
  const info = powerInfo(e);
  const buffName = BUFF_NAME.get(val(e.buff_symbol)) || '';
  if (info.kind === 'tool' && info.startTool) {
    if (!opts.tool) return { action: 'keep' };
    const target = PS_BY_NAME.get(to.startTool.ps);
    if (val(e.buff_symbol) === target.buffHash) return { action: 'keep' };
    return { action: 'replace', to: target, why: 'starting tool' };
  }
  if (!opts.hero) return { action: 'keep' };
  const insp = /^Buff_BroPower_([A-Za-z]+)_00(\d)$/.exec(buffName);
  if (insp) {
    const n = Number(insp[2]);
    const t = to.insp[n - 1];
    if (!t) return { action: 'remove', why: 'no matching Inspiration' };
    const target = PS_BY_NAME.get(t.ps);
    if (val(e.buff_symbol) === target.buffHash) return { action: 'keep' };
    return { action: 'replace', to: target, why: 'Inspiration' };
  }
  const mast = /^Buff_(Mastery_Coop|Mastery|Affinity)_([A-Za-z]+)_(\d+)$/.exec(buffName);
  if (mast && HERO_BY_KEY.has(mast[2])) {
    if (mast[2] === to.masteryHero) return { action: 'keep' };
    if (!to.masteryHero) return { action: opts.keepUnmatched ? 'keep' : 'remove', why: `${to.name} has no Masteries of their own` };
    const tName = `Buff_${mast[1]}_${to.masteryHero}_${mast[3]}`;
    const target = DB.powers.find((x) => x.buff === tName);
    if (!target) return { action: opts.keepUnmatched ? 'keep' : 'remove', why: `${to.name} has no matching Mastery` };
    return { action: 'replace', to: target, why: 'Mastery' };
  }
  const common = /^\*PowerSelect_Mastery_Common_(\d+)_([A-Za-z]+)\*$/.exec((knownPs(val(e.enhancement_symbol)) || {}).ps || '');
  if (common && to.masteryHero && common[2] !== to.masteryHero) {
    const target = PS_BY_NAME.get(`*PowerSelect_Mastery_Common_${common[1]}_${to.masteryHero}*`);
    if (target) return { action: 'replace', to: target, why: 'Common Mastery' };
  }
  return { action: 'keep' };
}

function planSwap(doc, { hero, tool = true, heroPowers = true, keepUnmatched = false }) {
  if (!hasRun(doc)) throw new EditError('There is no run in progress to swap.');
  const to = HERO_BY_KEY.get(hero);
  if (!to) throw new EditError('Unknown hero ' + hero);
  const run = S(doc).run;
  const from = heroForRun(doc);
  const opts = { tool, hero: heroPowers, keepUnmatched };
  const changes = (run.enhancements || []).map((e, index) => {
    const m = mapHeroBound(e, from, to, opts);
    return { index, from: powerInfo(e).name, action: m.action, to: m.to ? m.to.name : null, why: m.why || null, mapped: m };
  });
  const oldMax = val(run.player_max_health), oldHp = val(run.player_health);
  let newMax = oldMax, newHp = oldHp, healthNote = null;
  if (from && from.baseHp > 0) {
    newMax = Math.round((oldMax * to.baseHp) / from.baseHp);
    newHp = Math.max(1, Math.round((oldHp / oldMax) * newMax));
  } else healthNote = 'Current hero is unknown, so health was left as is.';
  return { from: from ? from.key : null, to: to.key, toName: to.name, fromName: from ? from.name : 'Unknown hero', changes, oldMax, newMax, oldHp, newHp, healthNote };
}

function opSwapHero(doc, args) {
  const plan = planSwap(doc, args);
  const to = HERO_BY_KEY.get(args.hero);
  return withRun(doc, (run, p) => {
    run.hero = Num.int(to.runHash);
    run.player_max_health = Num.like(run.player_max_health, plan.newMax);
    run.player_health = Num.like(run.player_health, plan.newHp);
    const out = [];
    plan.changes.forEach((c) => {
      const e = run.enhancements[c.index];
      if (c.action === 'replace') out.push(Object.assign(clone(e), { buff_symbol: Num.int(c.mapped.to.buffHash), enhancement_symbol: Num.int(c.mapped.to.psHash) }));
      else if (c.action === 'keep') out.push(e);
    });
    // never end up with duplicates of the same buff
    const seen = new Set();
    run.enhancements = out.filter((e) => { const b = val(e.buff_symbol); if (seen.has(b)) return false; seen.add(b); return true; });
    return [`${p}.hero`, `${p}.player_max_health`, `${p}.player_health`, `${p}.enhancements`];
  });
}

const OPS = {
  currency: opCurrency,
  heroMat: opHeroMat,
  runResource: opRunResource,
  runHealth: opRunHealth,
  upgrade: opUpgrade,
  artifact: opArtifact,
  equipArtifact: opEquipArtifact,
  powerLevel: opPowerLevel,
  powerRemove: opPowerRemove,
  powerAdd: opPowerAdd,
  swapHero: opSwapHero,
};

/** Apply a list of ops to a copy of doc. Returns { doc, touched }. Throws EditError on bad input. */
function applyOps(doc, ops) {
  const out = clone(doc);
  const touched = new Set();
  for (const op of ops || []) {
    const fn = OPS[op && op.op];
    if (!fn) throw new EditError('Unknown edit: ' + (op && op.op));
    for (const t of fn(out, op).touched) touched.add(t);
  }
  return { doc: out, touched: [...touched] };
}

/** Every path in `changed` must sit under one of `allowed`. Returns the offending paths. */
function outsideAllowed(changed, allowed) {
  return changed.filter((c) => !allowed.some((a) => c === a || c.startsWith(a + '.') || c.startsWith(a + '[')));
}

module.exports = { applyOps, view, planSwap, outsideAllowed, mirrorIndexes, hasRun, EditError, DB, OPS };
