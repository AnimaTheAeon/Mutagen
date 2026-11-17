'use strict';
// Advanced: edit hero base stats and power values inside PackData\overhead.pak2.
// Always rebuilt from a verified backup of the unpatched file, so it can be undone exactly.
const cff = require('./cff');
const DB = require('./gamedb.json');
const { PERM } = require('./util');

// Known overhead.pak2 versions (SHA1) — Steam original and the Karai/Shredder mod builds.
const KNOWN_OVERHEAD = {
  AD67E867B815A7D262EB7BD58B9B205ADA6C7EC7: { kind: 'original', label: 'Original (Steam)', karai: false, shredder: false },
  '357213F9D34C3AD1FC39403E98D96AEAC65AAE77': { kind: 'karai', label: 'Karai mod', karai: true, shredder: false },
  '234F44EC85099C6434ED5C58ACC28683345A042E': { kind: 'shredder', label: 'Shredder mod', karai: false, shredder: true },
  '668968C34823723CA3AA9053C7B55DEFE463A036': { kind: 'both', label: 'Karai + Shredder mod', karai: true, shredder: true },
};
const KNOWN_EXE = {
  DF59708EC2F3B0A469CF7C8C0D2934510D42FE96: 'original', '6D55D5E09E7CDA4E4B1154C3D65E6F0499CBB49C': 'karai',
  '93EEA03FBD722384A754CDA5B996E8E0178A3FA3': 'shredder', '614F75438D9B5A8C04FCB752753DF555C2597821': 'both',
};

const HERO_LIMITS = { baseHp: [1, 100000], speed: [0.5, 30], scale: [0.3, 3], dash: [0, 30] };
const BUFF_LIMITS = [-100000, 1000000];

class GameFilesError extends Error {}

// ----- reading values -----
function f32(buf, off) { return buf.readFloatLE(off); }
function round(v) { return Math.round(v * 10000) / 10000; }

function locateHero(rec, h) {
  const s = cff.symbol(rec, h.actor);
  if (!s) return null;
  const o = s.off;
  let dashOff = null;
  const list = rec.ptrs.get(o + 0x138);
  if (list != null) {
    for (let i = 0; i < 200; i++) {
      const slot = rec.ptrs.get(list + i * 8);
      if (slot == null) break;
      if (cff.cstr(rec, rec.ptrs.get(slot + 8)) === 'dash') { dashOff = slot + 0x50; break; }
    }
  }
  return { baseHp: o + 0x140, speed: o + 0x108, scale: o + 0x54, dash: dashOff };
}

function locateBuff(rec, name) {
  const s = cff.symbol(rec, `*${name}*`);
  return s ? s.off : null;
}

function createGameFiles(io) {
  const overheadPath = (gameDir) => io.join(gameDir, 'PackData', 'overhead.pak2');
  const stateDir = () => io.join(io.env.dataDir, 'gamefiles');
  const statePath = () => io.join(stateDir(), 'state.json');
  const backupPath = () => io.join(stateDir(), 'overhead.pak2.base');
  const readState = () => io.readJson(statePath(), null);

  async function identify(gameDir, { shaCache } = {}) {
    const ov = overheadPath(gameDir);
    const st = await io.stat(ov);
    if (!st) throw new GameFilesError('overhead.pak2 is missing from the game folder.');
    const key = `${st.size}:${st.mtimeMs}`;
    let sha = shaCache && shaCache[key];
    if (!sha) { sha = await io.sha1File(ov); if (shaCache) shaCache[key] = sha; }
    let exeSha = null;
    try { exeSha = await io.sha1File(io.join(gameDir, 'TMNTSF.exe')); } catch { /* ignore */ }
    const state = await readState();
    let status, base;
    if (KNOWN_OVERHEAD[sha]) { status = 'clean'; base = KNOWN_OVERHEAD[sha]; }
    else if (state && state.patchedSha === sha) { status = 'patched'; base = KNOWN_OVERHEAD[state.baseSha] || { kind: 'unknown', label: 'Unknown' }; }
    else { status = 'unknown'; base = { kind: 'unknown', label: 'Unrecognised version' }; }
    const staleState = !!(state && state.patchedSha !== sha);
    return { overheadSha: sha, exeSha, exeKind: KNOWN_EXE[exeSha] || 'unknown', status, base, staleState, state };
  }

  /** Read current values for all heroes (present in this build) and all buffs. */
  async function readValues(file) {
    const dir = await io.pakDir(file);
    const recs = new Map();
    const rec = async (hash) => {
      if (!recs.has(hash)) {
        const e = dir.entries.get(hash);
        recs.set(hash, e ? cff.parse(await io.pakRead(file, hash)) : null);
      }
      return recs.get(hash);
    };
    const heroes = {};
    for (const h of DB.heroes) {
      const r = await rec(h.record);
      const loc = r && locateHero(r, h);
      if (!loc) continue;
      heroes[h.key] = { baseHp: round(f32(r.inst, loc.baseHp)), speed: round(f32(r.inst, loc.speed)), scale: round(f32(r.inst, loc.scale)), dash: loc.dash != null ? round(f32(r.inst, loc.dash)) : null };
    }
    const buffs = {};
    for (const [name, b] of Object.entries(DB.buffRecords)) {
      const r = await rec(b.entry);
      const off = r && locateBuff(r, name);
      if (off == null) continue;
      const floats = [], ints = [];
      for (let i = 0; i < 20; i++) floats.push(round(f32(r.inst, off + i * 4)));
      for (let i = 0; i < 8; i++) ints.push(r.inst.readInt32LE(off + 0x50 + i * 4));
      buffs[name] = { floats, ints };
    }
    return { heroes, buffs };
  }

  // ----- validating edits -----
  function validateEdits(edits, current) {
    const clean = { heroes: {}, buffs: {} };
    for (const [key, vals] of Object.entries((edits && edits.heroes) || {})) {
      if (!current.heroes[key]) throw new GameFilesError(`${key} isn't in your current game files.`);
      for (const [field, v] of Object.entries(vals)) {
        const lim = HERO_LIMITS[field];
        if (!lim) throw new GameFilesError(`Unknown hero field ${field}`);
        if (field === 'dash' && current.heroes[key].dash == null) throw new GameFilesError(`${key} has no dash cooldown value.`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lim[0] || v > lim[1]) throw new GameFilesError(`${key} ${field} must be between ${lim[0]} and ${lim[1]}.`);
        (clean.heroes[key] = clean.heroes[key] || {})[field] = v;
      }
    }
    for (const [name, vals] of Object.entries((edits && edits.buffs) || {})) {
      const cur = current.buffs[name];
      if (!cur) throw new GameFilesError(`Power data ${name} isn't in your game files.`);
      const out = { floats: cur.floats.slice(), ints: cur.ints.slice() };
      (vals.floats || []).forEach((v, i) => {
        if (v == null) return;
        if (cur.floats[i] === -1 && v !== -1) throw new GameFilesError(`${name}: slot ${i} is unused by the game and can't be set.`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < BUFF_LIMITS[0] || v > BUFF_LIMITS[1]) throw new GameFilesError(`${name}: value ${v} is out of range.`);
        out.floats[i] = v;
      });
      (vals.ints || []).forEach((v, i) => {
        if (v == null) return;
        if (cur.ints[i] === -1 && v !== -1) throw new GameFilesError(`${name}: slot ${i} is unused by the game and can't be set.`);
        if (!Number.isInteger(v) || v < BUFF_LIMITS[0] || v > BUFF_LIMITS[1]) throw new GameFilesError(`${name}: value ${v} must be a whole number in range.`);
        out.ints[i] = v;
      });
      clean.buffs[name] = out;
    }
    return clean;
  }

  /** Build replacement record bytes for the edits, starting from the base archive. Returns Map(hash->bytes). */
  async function buildReplacements(baseFile, edits) {
    const dir = await io.pakDir(baseFile);
    const work = new Map(); // hash -> {rec, writes:[{off,len}]}
    const get = async (hash) => {
      if (!work.has(hash)) {
        const e = dir.entries.get(hash);
        if (!e) throw new GameFilesError(`Data record ${hash} is missing from the game files.`);
        work.set(hash, { rec: cff.parse(await io.pakRead(baseFile, hash)), writes: [] });
      }
      return work.get(hash);
    };
    for (const [key, vals] of Object.entries(edits.heroes)) {
      const h = DB.heroes.find((x) => x.key === key);
      const w = await get(h.record);
      const loc = locateHero(w.rec, h);
      if (!loc) throw new GameFilesError(`${h.name} isn't in these game files.`);
      for (const [field, v] of Object.entries(vals)) {
        if (loc[field] == null) throw new GameFilesError(`${h.name} has no ${field} value.`);
        w.rec.inst.writeFloatLE(v, loc[field]);
        w.writes.push({ off: loc[field], len: 4 });
      }
    }
    for (const [name, vals] of Object.entries(edits.buffs)) {
      const b = DB.buffRecords[name];
      const w = await get(b.entry);
      const off = locateBuff(w.rec, name);
      if (off == null) throw new GameFilesError(`Power data ${name} not found.`);
      vals.floats.forEach((v, i) => { const o = off + i * 4; if (Math.fround(v) !== w.rec.inst.readFloatLE(o)) { w.rec.inst.writeFloatLE(v, o); w.writes.push({ off: o, len: 4 }); } });
      vals.ints.forEach((v, i) => { const o = off + 0x50 + i * 4; if (v !== w.rec.inst.readInt32LE(o)) { w.rec.inst.writeInt32LE(v, o); w.writes.push({ off: o, len: 4 }); } });
    }
    const out = new Map();
    for (const [hash, w] of work) {
      if (!w.writes.length) continue;
      const bytes = cff.build(w.rec);
      // prove: re-parse, and the decrypted data differs from the original only at the written spots
      const orig = cff.parse(await io.pakRead(baseFile, hash));
      const again = cff.parse(bytes);
      for (let i = 0; i < orig.inst.length; i++) {
        if (orig.inst[i] !== again.inst[i] && !w.writes.some((x) => i >= x.off && i < x.off + x.len)) {
          throw new GameFilesError(`Safety check failed in record ${hash} at byte ${i}. Nothing was changed.`);
        }
      }
      if (Buffer.compare(bytes.subarray(0, w.rec.instOff), orig.raw.subarray(0, w.rec.instOff)) !== 0) throw new GameFilesError('Safety check failed (record header changed).');
      out.set(hash, bytes);
    }
    return out;
  }

  function sameNumber(a, b) { return Math.abs(Math.fround(a) - Math.fround(b)) <= 1e-6 * Math.max(1, Math.abs(a)); }

  function editsAreEmpty(edits, baseValues) {
    for (const [k, v] of Object.entries(edits.heroes)) for (const [f, x] of Object.entries(v)) if (!sameNumber(x, baseValues.heroes[k][f])) return false;
    for (const [n, v] of Object.entries(edits.buffs)) {
      const b = baseValues.buffs[n];
      if (v.floats.some((x, i) => !sameNumber(x, b.floats[i])) || v.ints.some((x, i) => x !== b.ints[i])) return false;
    }
    return true;
  }

  async function copyVerified(src, dst, expectSha) {
    await io.copy(src, dst);
    const sha = await io.sha1File(dst);
    if (expectSha && sha !== expectSha) { await io.remove(dst); throw new GameFilesError(`Copy of ${io.basename(src)} did not verify (SHA1 mismatch).`); }
    return sha;
  }

  /**
   * Apply edits. edits = { heroes: { Key: { baseHp, speed, scale, dash } }, buffs: { BuffName: { floats:[20], ints:[8] } } }
   * (values are full desired values relative to the *base* file; anything equal to base is a no-op).
   */
  async function apply(gameDir, rawEdits, progress = () => {}) {
    const log = [];
    const step = (s) => { log.push(s); progress(s); };
    if (await io.gameRunning()) throw Object.assign(new GameFilesError('Close TMNT: Splintered Fate first.'), { log });
    step('Game is closed.');
    const ov = overheadPath(gameDir);
    const id = await identify(gameDir);
    step(`Checked game files: ${id.status === 'patched' ? 'Mutagen patch on ' + id.base.label : id.base.label} (SHA1 ${id.overheadSha.slice(0, 8)}…).`);
    let baseFile, baseSha;
    if (id.status === 'patched') {
      baseFile = backupPath(); baseSha = id.state.baseSha;
      if (!(await io.exists(baseFile))) throw Object.assign(new GameFilesError('Mutagen\'s backup of your original file is missing, so it can\'t safely re-patch. Use Steam "Verify integrity" (then reinstall the Karai/Shredder mod if you use it).'), { log });
      const s = await io.sha1File(baseFile);
      if (s !== baseSha) throw Object.assign(new GameFilesError('Mutagen\'s backup file is damaged (SHA1 mismatch). Nothing was changed.'), { log });
      step('Backup of the unpatched file verified.');
    } else if (id.status === 'clean') {
      baseFile = ov; baseSha = id.overheadSha;
    } else {
      throw Object.assign(new GameFilesError('Your overhead.pak2 is a version Mutagen doesn\'t recognise (maybe a game update or another mod). To keep the game safe, game-file editing is disabled. Save editing still works.'), { log });
    }

    const baseValues = await readValues(baseFile);
    const edits = validateEdits(rawEdits, baseValues);
    if (editsAreEmpty(edits, baseValues)) {
      step('No differences from the unpatched file — restoring it instead.');
      const r = await restore(gameDir, progress);
      return { ok: true, log: log.concat(r.log), restored: true };
    }
    const replacements = await buildReplacements(baseFile, edits);
    step(`Prepared ${replacements.size} changed data record(s); each re-read and checked.`);

    // space checks
    const size = (await io.stat(baseFile)).size;
    if (await io.free(io.dirname(ov)) < size + (64 << 20)) throw Object.assign(new GameFilesError('Not enough free space on the game drive (needs about ' + Math.ceil(size / 1e6) + ' MB).'), { log });
    await io.mkdir(stateDir());

    if (id.status === 'clean') {
      if (await io.free(stateDir()) < size + (64 << 20)) throw Object.assign(new GameFilesError('Not enough free space for the backup (needs about ' + Math.ceil(size / 1e6) + ' MB on your C: drive).'), { log });
      await copyVerified(ov, backupPath(), baseSha);
      step(`Backup of your current file made and verified (SHA1 ${baseSha.slice(0, 8)}…).`);
    }

    const tmp = ov + '.mutagen-tmp';
    await copyVerified(baseFile, tmp, baseSha);
    let patchedSha;
    try {
      const report = await io.pakPatch(tmp, replacements);
      step(`Patched a working copy (${report.map((r) => r.mode).join(', ')}).`);
      // verify the working copy: untouched entries identical, edited ones read back with the new values
      const a = await io.pakDir(baseFile), b = await io.pakDir(tmp);
      if (a.count !== b.count) throw new GameFilesError('Entry count changed.');
      for (const [hash, e] of a.entries) {
        const f = b.entries.get(hash);
        if (!f) throw new GameFilesError('An entry went missing.');
        if (!replacements.has(hash) && (e.off !== f.off || e.csize !== f.csize || e.usize !== f.usize || e.flags !== f.flags)) {
          // an earlier entry can only move if it was appended, which never happens to untouched entries
          throw new GameFilesError(`Untouched entry ${hash} changed.`);
        }
      }
      const check = await readValues(tmp);
      for (const [k, v] of Object.entries(edits.heroes)) for (const [fld, x] of Object.entries(v)) {
        if (!sameNumber(check.heroes[k][fld], x)) throw new GameFilesError(`${k} ${fld} did not read back correctly.`);
      }
      for (const [n, v] of Object.entries(edits.buffs)) {
        if (v.floats.some((x, i) => !sameNumber(check.buffs[n].floats[i], x)) || v.ints.some((x, i) => check.buffs[n].ints[i] !== x)) throw new GameFilesError(`${n} did not read back correctly.`);
      }
      for (const hash of replacements.keys()) await io.pakRead(tmp, hash); // decompresses cleanly
      patchedSha = await io.sha1File(tmp);
      step(`Working copy verified: every edited value reads back, nothing else moved (SHA1 ${patchedSha.slice(0, 8)}…).`);
      await io.rename(tmp, ov);
      const finalSha = await io.sha1File(ov);
      if (finalSha !== patchedSha) throw new GameFilesError('Installed file did not match the verified copy.');
      step('Installed and verified in the game folder.');
    } catch (e) {
      try { await io.remove(tmp); } catch { /* ignore */ }
      // if the live file is no longer the base, put the base back
      try {
        const nowSha = await io.sha1File(ov);
        if (nowSha !== baseSha && nowSha !== (id.state && id.state.patchedSha)) {
          await copyVerified(backupPath(), tmp, baseSha); await io.rename(tmp, ov);
          step('Problem found — your original file was put back.');
        }
      } catch { step('Could not automatically put the original back — use "Restore original files".'); }
      const perm = e && PERM.has(e.code);
      const msg = perm ? 'Windows blocked writing to the game folder. Make sure the game and Steam\'s "verify" aren\'t running, then try again — if it still fails, right-click Mutagen and choose "Run as administrator".' : e.message;
      throw Object.assign(e instanceof GameFilesError ? e : new GameFilesError(msg), { log });
    }
    await io.writeJson(statePath(), { baseSha, baseKind: (KNOWN_OVERHEAD[baseSha] || {}).kind || 'unknown', patchedSha, edits, applied: new Date().toISOString(), version: 1 });
    return { ok: true, log, patchedSha };
  }

  async function restore(gameDir, progress = () => {}) {
    const log = [];
    const step = (s) => { log.push(s); progress(s); };
    if (await io.gameRunning()) throw Object.assign(new GameFilesError('Close TMNT: Splintered Fate first.'), { log });
    const state = await readState();
    const ov = overheadPath(gameDir);
    if (!state) { step('Nothing to restore — Mutagen has not changed your game files.'); return { ok: true, log }; }
    const now = await io.sha1File(ov);
    if (now === state.baseSha) {
      step('Your game file is already the unpatched version.');
    } else if (now !== state.patchedSha) {
      throw Object.assign(new GameFilesError('Your game files were changed by something else after Mutagen patched them (a Steam update/verify or a mod installer). Mutagen won\'t overwrite them. Use "Forget old patch" instead.'), { log, code: 'STALE' });
    } else {
      if (!(await io.exists(backupPath()))) throw Object.assign(new GameFilesError('Mutagen\'s backup is missing. Use Steam "Verify integrity of game files" to get the original back.'), { log });
      const tmp = ov + '.mutagen-tmp';
      await copyVerified(backupPath(), tmp, state.baseSha);
      step('Backup verified (SHA1 ' + state.baseSha.slice(0, 8) + '…).');
      await io.rename(tmp, ov);
      if (await io.sha1File(ov) !== state.baseSha) throw Object.assign(new GameFilesError('Restored file did not verify.'), { log });
      step('Original file put back and verified.');
    }
    await io.remove(backupPath());
    await io.remove(statePath());
    step('Mutagen\'s game-file backup cleaned up.');
    return { ok: true, log };
  }

  /** Forget a stale state (game files changed by Steam or a mod installer after Mutagen patched them). */
  async function forgetState() {
    await io.remove(backupPath());
    await io.remove(statePath());
  }


  return { identify, readValues, apply, restore, forgetState, overheadPath };
}

module.exports = { createGameFiles, KNOWN_OVERHEAD, KNOWN_EXE, GameFilesError, HERO_LIMITS };
