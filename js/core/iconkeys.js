'use strict';
// Every icon key the UI can ask for, in "Atlas.atlas:Sprite" form.
const DB = require('./gamedb.json');
function heroAvatar(h) { return h.mod ? `Boss_${h.key}.atlas:${h.avatar}` : `Multiplayer.atlas:${h.avatar}`; }
function heroPortrait(h) { return h.mod ? `Boss_${h.key}.atlas:${h.portrait}` : `HudImages.atlas:${h.portrait}`; }
function powerIcon(p) { return p && p.atlas && p.icon ? `${p.atlas}:${p.icon}` : null; }
function all() {
  const s = new Set();
  for (const h of DB.heroes) { s.add(heroAvatar(h)); s.add(heroPortrait(h)); }
  for (const c of DB.currencies) s.add(`Icons.atlas:${c.icon}`);
  for (const m of DB.heroMats) { s.add(`Icons.atlas:${m.talismanIcon}`); s.add(`Icons.atlas:${m.wrapsIcon}`); }
  ['CURRENCY_SCRAP_MED', 'LuckyDice', 'SplintersRevive'].forEach((n) => s.add(`Icons.atlas:${n}`));
  for (const p of DB.powers) { const k = powerIcon(p); if (k) s.add(k); }
  for (const p of Object.values(DB.knownPs)) { const k = powerIcon(p); if (k) s.add(k); }
  for (const p of DB.perma) s.add(`${p.atlas}:${p.icon}`);
  for (const a of DB.artifacts) s.add(`Artifacts.atlas:${a.icon}`);
  return [...s];
}
module.exports = { all, heroAvatar, heroPortrait, powerIcon };
