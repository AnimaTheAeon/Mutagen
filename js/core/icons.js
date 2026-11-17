'use strict';
// Icons come straight out of the player's own game files (BC1/BC3 atlases), so Mutagen ships no game art.
// JS decides what's needed and what's cached; the native layer decodes and writes the PNGs.
const sha1 = require('js-sha1');
const { spriteHash } = require('./hash');
const DB = require('./gamedb.json');

const PAK_FILES = { 'overhead.pak2.original-backup': 'overhead.pak2', DUPES: 'dupes.pak2', 'default.pak2.original-backup': 'default.pak2', overhead: 'overhead.pak2' };
// textures used by the Karai/Shredder mod art (present only when the mod is installed)
const EXTRA_ATLASES = { 'Boss_Karai.atlas': ['overhead', '070a475246230d1f'], 'Boss_Shredder.atlas': ['overhead', '8e812a7312530c0f'] };

function atlasLocation(atlas) {
  const a = DB.atlasMap[atlas] || EXTRA_ATLASES[atlas];
  if (!a) return null;
  return { pakName: PAK_FILES[a[0]], hash: a[1] };
}

function createIcons(io) {
  const cacheDir = () => io.join(io.env.dataDir, 'icons');
  /** keys: ["Atlas.atlas:Sprite", …] → { key: absolute PNG path } */
  async function extract(gameDir, keys, { maxSide = 256 } = {}) {
    const out = {};
    if (!gameDir) return out;
    const dir = cacheDir();
    await io.mkdir(dir);
    const cached = new Set(await io.readdir(dir));
    // cache is keyed by the pak files' size+mtime so a mod install/uninstall refreshes it
    const stamp = {};
    for (const name of new Set(Object.values(PAK_FILES))) {
      const s = await io.stat(io.join(gameDir, 'PackData', name));
      stamp[name] = s ? `${s.size}-${Math.round(s.mtimeMs)}` : 'missing';
    }
    const jobs = new Map();
    for (const key of keys) {
      const [atlas, sprite] = key.split(':');
      const loc = atlasLocation(atlas);
      if (!loc || !sprite || stamp[loc.pakName] === 'missing') continue;
      const id = sha1(`${key}|${stamp[loc.pakName]}|${maxSide}`).slice(0, 20) + '.png';
      const file = io.join(dir, id);
      if (cached.has(id)) { out[key] = file; continue; }
      const tk = loc.pakName + '|' + loc.hash;
      if (!jobs.has(tk)) jobs.set(tk, { pak: io.join(gameDir, 'PackData', loc.pakName), hash: loc.hash, items: [], keys: new Map() });
      const j = jobs.get(tk);
      j.items.push({ sprite: spriteHash(sprite), file });
      j.keys.set(file, key);
    }
    if (jobs.size) {
      const list = [...jobs.values()];
      const written = new Set(await io.icons(list.map((j) => ({ pak: j.pak, hash: j.hash, items: j.items })), maxSide));
      for (const j of list) for (const [file, key] of j.keys) if (written.has(file)) out[key] = file;
    }
    return out;
  }
  return { extract, cacheDir };
}
module.exports = { createIcons, atlasLocation };
