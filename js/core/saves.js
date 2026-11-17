'use strict';
// Loading, saving, backing up and restoring save slots — with every safety check.
const sf = require('./savefile');
const ed = require('./editor');
const lj = require('./ljson');
const { stamp, randHex, uuid, PERM } = require('./util');

const SLOT_RE = /^saveSlot\.GameState(\d+)\.cloud\.json$/;
const KEEP_BACKUPS = 25;

function createSaves(io) {
  const saveDir = () => io.env.saveDir;
  const slotFile = (n) => io.join(saveDir(), `saveSlot.GameState${n}.cloud.json`);
  const slotBak = (n) => io.join(saveDir(), `saveSlot.GameState${n}.bak.cloud.json`);
  const backupsRoot = () => io.join(io.env.dataDir, 'backups');
  const sha1 = (b) => sf.sha1Hex(b);
  const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

  async function activeSlot() {
    const ini = await io.readJson(io.join(saveDir(), 'User.ini.json'), null);
    if (!ini) return null;
    for (const [k, v] of Object.entries(ini)) {
      if (k.startsWith('player:') && v && typeof v.active_slot === 'number' && v.platform_id) return v.active_slot;
    }
    return null;
  }

  async function listSlots() {
    const dir = saveDir();
    const st = await io.stat(dir);
    if (!st || !st.isDir) return { dir, exists: false, slots: [], active: null };
    const slots = [];
    for (const f of await io.readdir(dir)) {
      const m = SLOT_RE.exec(f);
      if (!m) continue;
      const p = io.join(dir, f);
      const s = await io.stat(p);
      let ok = true, err = null, handle = null;
      try { const d = sf.decode(await io.read(p)); handle = lj.val(d.doc.handle); } catch (e) { ok = false; err = e.message; }
      slots.push({ slot: Number(m[1]), file: p, size: s.size, mtime: s.mtimeMs, ok, error: err, handle });
    }
    slots.sort((a, b) => a.slot - b.slot);
    return { dir, exists: true, slots, active: await activeSlot() };
  }

  async function load(slot) {
    const file = slotFile(slot);
    const buf = await io.read(file);
    const d = sf.decode(buf); // checks the game's own MD5 and sizes
    const st = await io.stat(file);
    return { slot, file, sha1: sha1(buf), mtime: st ? st.mtimeMs : 0, decoded: d };
  }

  // ----- backups -----
  async function makeBackup(slot, reason) {
    const id = `${stamp()}-slot${slot}-${randHex(2)}`;
    const dir = io.join(backupsRoot(), id);
    await io.mkdir(dir);
    const files = [];
    for (const src of [slotFile(slot), slotBak(slot)]) {
      if (!(await io.exists(src))) continue;
      const buf = await io.read(src);
      const dst = io.join(dir, io.basename(src));
      await io.write(dst, buf);
      const back = await io.read(dst);
      if (sha1(back) !== sha1(buf)) throw new Error('Backup copy did not match the original — nothing was changed.');
      files.push({ name: io.basename(src), sha1: sha1(buf), size: buf.length });
    }
    await io.writeJson(io.join(dir, 'manifest.json'), { id, slot, reason, created: new Date().toISOString(), files });
    await pruneBackups();
    return { id, dir, files };
  }

  async function listBackups() {
    const root = backupsRoot();
    const out = [];
    for (const id of await io.readdir(root)) {
      const m = await io.readJson(io.join(root, id, 'manifest.json'), null);
      if (m) out.push(m);
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  async function pruneBackups() {
    const all = await listBackups();
    for (const b of all.slice(KEEP_BACKUPS)) { try { await io.remove(io.join(backupsRoot(), b.id)); } catch { /* ignore */ } }
  }

  async function verifyBackup(b) {
    for (const f of b.files) {
      const p = io.join(backupsRoot(), b.id, f.name);
      if (!(await io.exists(p))) throw new Error(`Backup file ${f.name} is missing.`);
      const buf = await io.read(p);
      if (sha1(buf) !== f.sha1) throw new Error(`Backup file ${f.name} is damaged (checksum mismatch).`);
      if (/\.cloud\.json$/.test(f.name)) sf.decode(buf);
    }
  }

  /** Atomically replace target with bytes and prove it landed intact. */
  async function writeVerified(target, bytes) {
    const tmp = target + '.mutagen-tmp';
    await io.write(tmp, bytes); // native side fsyncs
    const back = await io.read(tmp);
    if (!same(back, bytes)) { await io.remove(tmp); throw new Error('Temporary file did not read back correctly.'); }
    await io.rename(tmp, target);
    const final = await io.read(target);
    if (!same(final, bytes)) throw new Error('Saved file did not read back correctly.');
  }

  async function restoreBackup(id, { force = false } = {}) {
    const log = [];
    if (!force && await io.gameRunning()) throw Object.assign(new Error('Close the game first — it would overwrite the restored save.'), { code: 'GAME_RUNNING' });
    const b = (await listBackups()).find((x) => x.id === id);
    if (!b) throw new Error('Backup not found.');
    await verifyBackup(b); log.push('Backup files verified (SHA1 + save checksum).');
    const pre = await makeBackup(b.slot, `before restoring ${id}`); log.push(`Current files backed up as ${pre.id}.`);
    for (const f of b.files) {
      const bytes = await io.read(io.join(backupsRoot(), b.id, f.name));
      await writeVerified(io.join(saveDir(), f.name), bytes);
      log.push(`Restored ${f.name} (SHA1 ${f.sha1.slice(0, 8)}… verified).`);
    }
    return { ok: true, log };
  }

  /**
   * Apply ops to a slot with the full safety sequence.
   * expect: { sha1 } from when the user loaded the file (detects the game writing in between).
   */
  async function save(slot, ops, expect) {
    const log = [];
    const step = (s) => log.push(s);
    if (!ops || !ops.length) throw new Error('Nothing to save.');
    if (await io.gameRunning()) throw Object.assign(new Error('TMNT: Splintered Fate is running. Close it first — it rewrites the save every few seconds and would undo your changes.'), { code: 'GAME_RUNNING', log });
    step('Game is closed.');

    const file = slotFile(slot);
    const cur = await load(slot);
    step(`Save opened and its built-in checksum verified (MD5 ${cur.decoded.md5.slice(0, 8)}…).`);
    if (expect && expect.sha1 && expect.sha1 !== cur.sha1) {
      throw Object.assign(new Error('The save changed on disk since you opened it (the game probably saved). Reload to see the latest, then make your edits again.'), { code: 'STALE', log });
    }
    step(`File unchanged since it was loaded (SHA1 ${cur.sha1.slice(0, 8)}…).`);

    const { doc, touched } = ed.applyOps(cur.decoded.doc, ops);
    doc.rev = lj.Str.of(uuid());
    const changed = lj.diff(cur.decoded.doc, doc);
    const bad = ed.outsideAllowed(changed, [...touched, '.rev']);
    if (bad.length) throw Object.assign(new Error('Safety check failed: an edit touched something it should not have (' + bad.slice(0, 3).join(', ') + '). Nothing was written.'), { log });
    step(`Change check passed: only what you edited changed (${ops.length} edit${ops.length === 1 ? '' : 's'}, ${changed.length - 1} value${changed.length === 2 ? '' : 's'} incl. the co-op copy of the run).`);

    const bytes = sf.encode(doc, { version: cur.decoded.version, trailingNul: cur.decoded.trailingNul });
    const check = sf.decode(bytes);
    if (lj.diff(doc, check.doc).length) throw Object.assign(new Error('Safety check failed: the new save did not read back identically. Nothing was written.'), { log });
    step(`New save built and re-read: checksum OK (MD5 ${check.md5.slice(0, 8)}…).`);

    const backup = await makeBackup(slot, 'before save');
    step(`Backup made and verified: ${backup.id}.`);

    try {
      await writeVerified(file, bytes);
      const after = await load(slot);
      if (after.sha1 !== sha1(bytes)) throw new Error('Written file SHA1 does not match.');
      const bad2 = ed.outsideAllowed(lj.diff(cur.decoded.doc, after.decoded.doc), [...touched, '.rev']);
      if (bad2.length) throw new Error('Written file has unexpected changes.');
      step(`Written and verified on disk (SHA1 ${after.sha1.slice(0, 8)}…).`);
      return { ok: true, log, sha1: after.sha1, backup: backup.id, changed: ops.length };
    } catch (e) {
      try {
        await writeVerified(file, await io.read(io.join(backupsRoot(), backup.id, io.basename(file))));
        step('Problem while writing — your original save was restored from the backup.');
      } catch (e2) {
        step('Could not restore automatically: ' + e2.message + ` — your backup is in ${backup.dir}`);
      }
      const perm = e && PERM.has(e.code);
      throw Object.assign(new Error(perm ? 'Windows blocked writing the save (it may be open in another program, or Steam is syncing it). Wait a moment and try again. Your original save is unchanged.' : 'Saving failed: ' + e.message), { log });
    }
  }

  return { listSlots, load, save, makeBackup, listBackups, restoreBackup, backupsRoot, slotFile };
}
module.exports = { createSaves };
