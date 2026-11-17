'use strict';
/* global mutagen */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n).toLocaleString('en-US');
  const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return h ? `${h}h ${m}m` : `${m}:${String(sec).padStart(2, '0')}`; };

  const ICON = {
    overview: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9 10h4.5a1.5 1.5 0 010 3H10a1.5 1.5 0 000 3H15"/>',
    run: '<path d="M5 19L19 5M14 5h5v5M5 5l5 5M14 14l5 5"/>',
    upgrades: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    game: '<path d="M4 7h10M4 17h6M18 7h2M14 17h6"/><circle cx="16" cy="7" r="2"/><circle cx="12" cy="17" r="2"/>',
    safety: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    check: '<path d="M5 12l5 5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    warn: '<path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    cloud: '<path d="M7 18a4 4 0 010-8 6 6 0 0111.3 2A3.5 3.5 0 0118 18z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  };
  const svg = (name, size = 18, color = 'currentColor', w = 2) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

  const S = {
    init: null, catalog: null, icons: {}, page: 'overview', slot: null, loaded: null, base: null, view: null,
    ops: [], running: false, busy: false,
    swap: { hero: null, tool: true, heroPowers: true, keepUnmatched: false, plan: null },
    upTab: 'Combat', showUnused: false, artSel: null, drag: null,
    add: { open: false, q: '', kind: 'power' },
    gf: { warned: false, values: null, edits: { heroes: {}, buffs: {} }, sel: null, q: '', log: [] },
    backups: [], lastLog: null,
  };

  // ---------- helpers ----------
  // number box with app-styled up/down arrows (replaces the browser's white spinner)
  function spin(inputHtml, kind, key, name) {
    return `<div class="spin">${inputHtml}<div class="spin-btns"><button type="button" tabindex="-1" aria-label="Increase ${esc(name)}" data-act="nstep" data-kind="${kind}" data-key="${esc(key)}" data-d="1">${svg('up', 14, 'currentColor', 2.5)}</button><button type="button" tabindex="-1" aria-label="Decrease ${esc(name)}" data-act="nstep" data-kind="${kind}" data-key="${esc(key)}" data-d="-1">${svg('down', 14, 'currentColor', 2.5)}</button></div></div>`;
  }
  function icon(key, size, label, cls = '') {
    const url = key && S.icons[key];
    if (url) return `<img class="ico ${cls}" src="${esc(url)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
    const t = String(label || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="ph ${cls}" style="width:${size}px;height:${size}px;font-size:${Math.max(11, size / 3.2)}px" aria-hidden="true">${esc(t)}</span>`;
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
  const heroCat = (key) => S.catalog && S.catalog.heroes.find((h) => h.key === key);

  // ---------- ops ----------
  const opId = (op) => {
    switch (op.op) {
      case 'currency': return 'c:' + op.key;
      case 'heroMat': return 'm:' + op.stat;
      case 'runResource': return 'r:' + op.key;
      case 'runHealth': return 'hp';
      case 'upgrade': return 'u:' + op.buff;
      case 'artifact': return 'a:' + op.sym;
      case 'equipArtifact': return 'eq';
      default: return null;
    }
  };
  async function pushOp(op, { isOriginal = false } = {}) {
    const id = opId(op);
    let ops = S.ops.slice();
    if (id) ops = ops.filter((o) => opId(o) !== id);
    if (!isOriginal) ops.push(op);
    await setOps(ops);
  }
  async function setOps(ops) {
    const r = await mutagen.preview(S.slot, ops);
    if (r.error) { toast(r.error); render(); return false; }
    S.ops = ops; S.view = r.view;
    if (S.swap.hero) await refreshPlan();
    render();
    return true;
  }
  function describeOp(op) {
    const v = S.base;
    switch (op.op) {
      case 'currency': { const c = v.currencies.find((x) => x.key === op.key); return `${c ? c.name : op.key} → ${fmtN(op.value)}`; }
      case 'heroMat': return `${op.stat.replace(/_/g, ' ')} → ${fmtN(op.value)}`;
      case 'runResource': return `Run ${({ coins: 'Scrap', lucky_dice: 'Lucky Dice', revive_tokens: 'Revives' })[op.key]} → ${fmtN(op.value)}`;
      case 'runHealth': return 'Heal to full';
      case 'upgrade': { const u = v.upgrades.find((x) => x.buff === op.buff); return `${u ? u.name : 'Upgrade'} → level ${op.level}`; }
      case 'artifact': { const a = v.artifacts.find((x) => x.sym === op.sym); return `${a ? a.name : 'Artifact'} → level ${op.level}${a && !a.owned ? ' (unlock)' : ''}`; }
      case 'equipArtifact': { const a = v.artifacts.find((x) => x.sym === op.sym); return `Equip ${a ? a.name : 'artifact'}`; }
      case 'powerLevel': return `Power level change`;
      case 'powerRemove': return `Remove a power`;
      case 'powerAdd': { const p = S.catalog.powers.find((x) => x.ps === op.ps); return `Add ${p ? p.name : 'power'}`; }
      case 'swapHero': { const h = heroCat(op.hero); return `Swap hero to ${h ? h.name : op.hero}`; }
      default: return op.op;
    }
  }

  // ---------- nav ----------
  const PAGES = [
    ['overview', 'Overview & currencies', 'overview'],
    ['run', 'Current run', 'run'],
    ['upgrades', 'Upgrades & artifacts', 'upgrades'],
    ['game', 'Game files', 'game'],
    ['safety', 'Backups & safety', 'safety'],
  ];
  function renderNav() {
    $('#nav').innerHTML = PAGES.map(([id, label, ic]) => `<button class="nav-btn" data-act="page" data-id="${id}" ${S.page === id ? 'aria-current="page"' : ''}>${svg(ic)}${esc(label)}${id === 'game' ? '<span class="tag">Advanced</span>' : ''}</button>`).join('');
    const n = S.ops.length;
    $('#sidecard').innerHTML = `<div class="sidecard"><b>Pending changes</b><span>${n ? `${n} change${n > 1 ? 's' : ''} not saved yet` : 'Nothing to save'}</span>
      ${n ? `<button class="linkbtn" data-act="pending">Review changes</button>` : ''}<span style="margin-top:6px">Backups: ${S.backups.length} kept</span><button class="linkbtn" data-act="openBackups">Open backups folder</button></div>`;
  }

  // ---------- header ----------
  function header(title, sub, { saveBar = true } = {}) {
    const n = S.ops.length;
    return `<header class="top"><div class="title"><h1>${esc(title)}</h1><span class="sub">${sub}</span></div>
      ${S.running ? `<span class="pill bad"><span class="dot"></span>Game is running — close it to save</span>` : `<span class="pill ok"><span class="dot"></span>Game closed — safe to edit</span>`}
      ${S.init && S.init.cloud ? `<span class="pill info">${svg('cloud', 14)}Steam Cloud on</span>` : ''}
      ${saveBar ? `<button class="btn" data-act="discard" ${n ? '' : 'disabled'}>Discard</button>
      <button class="btn primary" data-act="save" ${n && !S.running && !S.busy ? '' : 'disabled'}>Save changes <span class="badge">${n}</span></button>` : ''}</header>`;
  }

  // ---------- overview ----------
  function pageOverview() {
    const v = S.view, b = S.base;
    const run = v.run;
    const runHero = run && heroCat(run.hero);
    const curCards = v.currencies.filter((c) => c.kind === 'spend').map((c) => {
      const o = b.currencies.find((x) => x.key === c.key);
      const ed = o.balance !== c.balance;
      return `<div class="cur ${ed ? 'edited' : ''}">
        <div class="row">${icon('Icons.atlas:' + c.icon, 56, c.name)}<div style="display:flex;flex-direction:column;gap:2px;flex:1 1 auto"><b style="font-size:16px">${esc(c.name)}</b><span class="sub" style="font-size:12px">earned ${fmtN(c.earned)} · spent ${fmtN(c.spent)}</span></div>${ed ? '<span class="edited-tag">edited</span>' : ''}</div>
        <div class="row" style="flex-wrap:nowrap"><button class="step" aria-label="Decrease ${esc(c.name)}" data-act="cur" data-key="${c.key}" data-d="-10">−</button>
        <label style="flex:1 1 auto"><span class="sr">${esc(c.name)} balance</span><input class="num-input ${ed ? 'edited' : ''}" type="number" min="0" max="9999999" value="${c.balance}" data-in="cur" data-key="${c.key}"></label>
        <button class="step" aria-label="Increase ${esc(c.name)}" data-act="cur" data-key="${c.key}" data-d="10">+</button></div>
        <div class="row"><button class="chip" data-act="cur" data-key="${c.key}" data-d="1000">+1,000</button><button class="chip" data-act="cur" data-key="${c.key}" data-d="10000">+10,000</button>
        <button class="chip" style="margin-left:auto;color:var(--muted)" data-act="curReset" data-key="${c.key}" ${ed ? '' : 'disabled'}>Revert</button></div></div>`;
    }).join('');
    const mats = v.currencies.filter((c) => c.kind === 'mat').map((c) => {
      const o = b.currencies.find((x) => x.key === c.key); const ed = o.balance !== c.balance;
      return `<div class="mat ${ed ? 'edited' : ''}">${icon('Icons.atlas:' + c.icon, 44, c.name)}<div style="display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0"><span style="font-size:13px;color:var(--soft)">${esc(c.name)}</span>
        <label><span class="sr">${esc(c.name)}</span>${spin(`<input class="num-input sm ${ed ? 'edited' : ''}" style="text-align:left;padding:0 34px 0 10px" type="number" min="0" value="${c.balance}" data-in="cur" data-key="${c.key}">`, 'cur', c.key, c.name)}</label></div></div>`;
    }).join('');
    const hm = (field, label, iconField) => `<div class="card" style="flex:1 1 440px;display:flex;flex-direction:column;gap:12px;padding:16px 18px">
      <div class="row">${icon('Icons.atlas:' + (iconField === 'talismanIcon' ? 'TalismanLeo' : 'AstralWrapsLeo'), 32, label)}<b>${label}</b><span class="sub" style="font-size:12px">per hero</span></div>
      <div class="heromat">${v.heroMats.map((m) => { const o = b.heroMats.find((x) => x.hero === m.hero); const ed = o[field] !== m[field]; const hc = heroCat(m.hero);
        return `<div class="hm">${icon(hc ? hc.portrait : null, 28, m.short)}<span style="font-size:13px;color:var(--soft);flex:1 1 auto">${esc(m.short)}</span><label><span class="sr">${esc(m.short)} ${label}</span>${spin(`<input type="number" min="0" class="${ed ? 'edited' : ''}" value="${m[field]}" data-in="mat" data-stat="${field === 'talismans' ? m.talismanStat : m.wrapsStat}">`, 'mat', field === 'talismans' ? m.talismanStat : m.wrapsStat, `${m.short} ${label}`)}</label></div>`; }).join('')}</div></div>`;
    return `${header('Overview', `${esc(S.loaded.file)} · slot ${S.slot + 1}`)}
      <section class="row" style="align-items:stretch;gap:16px">
        <div class="card row" style="flex:2 1 420px;gap:18px">${run ? icon(runHero ? runHero.portrait : null, 72, runHero ? runHero.name : '?') : ''}
          <div style="display:flex;flex-direction:column;gap:4px;flex:1 1 auto"><span class="sub" style="text-transform:uppercase;letter-spacing:1px;font-weight:600;font-size:12px">${run ? 'Run in progress' : 'No run in progress'}</span>
          ${run ? `<span style="font-family:var(--head);font-size:21px;font-weight:700">${esc(runHero ? runHero.name : 'Unknown hero')} · ${esc(prettyLevel(run.level))} · Chapter ${run.chapter}</span>
          <span class="sub">${Math.round(run.health)} / ${Math.round(run.maxHealth)} HP · ${run.resources.map((r) => `${fmtN(r.value)} ${esc(r.name)}`).join(' · ')} · ${run.powers.length} powers</span>` : '<span class="sub">Start a run in the game to edit run details.</span>'}</div>
          ${run ? '<button class="btn" data-act="page" data-id="run">Edit run</button>' : ''}</div>
        <div class="card" style="flex:1 1 300px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
          ${[['Player', esc(v.player.handle)], ['Runs / wins', `${fmtN(v.profile.runs)} / ${fmtN(v.profile.wins)}`], ['Time played', fmtTime(v.profile.timePlayed)], ['Best time', fmtTime(v.profile.bestTime)], ['Best streak', fmtN(v.profile.bestStreak)], ['Artifact', esc(v.equipped || 'None')]].map(([k, x]) => `<div style="display:flex;flex-direction:column;gap:4px;min-width:0"><span class="sub" style="font-size:12px">${k}</span><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x}</b></div>`).join('')}
        </div></section>
      <section class="sect"><div class="sect-head"><h2>Currencies</h2><span class="sub">Balance = earned − spent. Editing keeps your spent history. Scrap and Lucky Dice belong to a run — see Current run.</span></div>
        <div class="grid g-cur">${curCards}</div></section>
      <section class="sect"><div class="sect-head"><h2>Upgrade materials</h2><span class="sub">Never spent — they unlock upgrade levels once you have enough.</span></div>
        <div class="grid g-mat">${mats}</div>
        <div class="row" style="align-items:stretch;gap:16px">${hm('talismans', 'Talismans', 'talismanIcon')}${hm('wraps', 'Astral Wraps', 'wrapsIcon')}</div></section>`;
  }
  const prettyLevel = (n) => String(n || '').replace(/^GAME_MODE_/, '').toLowerCase().replace(/(^|_)(\w)/g, (_m, a, c) => (a ? ' ' : '') + c.toUpperCase());

  // ---------- run ----------
  async function refreshPlan() {
    if (!S.swap.hero || !S.view.run || S.swap.hero === S.view.run.hero) { S.swap.plan = null; return; }
    const r = await mutagen.planSwap(S.slot, S.ops, { hero: S.swap.hero, tool: S.swap.tool, heroPowers: S.swap.heroPowers, keepUnmatched: S.swap.keepUnmatched });
    S.swap.plan = r.error ? null : r;
  }
  function heroRoster(run) {
    return S.view.heroes.map((h) => {
      const c = heroCat(h.key);
      const sel = run && (S.swap.hero ? S.swap.hero === h.key : h.key === run.hero);
      return `<button class="hero" data-act="swapPick" data-hero="${h.key}" ${h.available ? `draggable="true" data-drag-hero="${h.key}"` : 'disabled'} aria-pressed="${!!sel}" aria-label="${esc(h.name)}${h.available ? '' : ' (not available)'}" style="background:${esc(h.color)}">
        ${S.icons[c.avatar] ? `<img src="${esc(S.icons[c.avatar])}" alt="" draggable="false">` : `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 34px var(--head);color:rgba(255,255,255,.35)">${esc(h.short.slice(0, 2))}</span>`}
        ${run && h.key === run.hero ? '<span class="t-in">IN RUN</span>' : ''}${h.mod ? '<span class="t-mod">MOD</span>' : ''}
        <span class="cap"><b>${esc(h.name)}</b><span>${h.baseHp} HP · ${esc(h.tool)}</span></span></button>`;
    }).join('');
  }
  function dropZone(run) {
    const pic = (hk, cls = '') => { const c = heroCat(hk); const u = c && S.icons[c.avatar];
      return `<div class="dz-pic ${cls}" style="background:${esc((S.view.heroes.find((h) => h.key === hk) || {}).color || '#232A34')}">${u ? `<img src="${esc(u)}" alt="" draggable="false">` : `<span>${esc(c ? c.name.slice(0, 2) : '?')}</span>`}</div>`; };
    if (!run) return `<div class="dropzone off" id="dropzone" aria-label="Current character (no run in progress)">
      <span class="dz-label">Current character</span><div class="dz-pic empty">${svg('user', 30, '#5C6573')}</div>
      <b>No run in progress</b><span class="sub" style="font-size:12px;text-align:center">Start a run in the game, quit to the menu, then drag a hero here.</span></div>`;
    const cur = heroCat(run.hero), to = S.swap.hero && heroCat(S.swap.hero);
    return `<div class="dropzone" id="dropzone" aria-label="Current character: ${esc(cur ? cur.name : '?')}. Drop a hero here to swap.">
      <span class="dz-label">Current character</span>
      ${to ? `<div class="row" style="gap:8px;flex-wrap:nowrap;justify-content:center">${pic(run.hero, 'small faded')}${svg('arrow', 20, '#9BE15D')}${pic(S.swap.hero)}</div><b>${esc(cur.name)} → ${esc(to.name)}</b>`
        : `${pic(run.hero)}<b>${esc(cur ? cur.name : 'Unknown hero')}</b>`}
      <span class="sub dz-hint" style="font-size:12px;text-align:center">${to ? 'Review the changes below.' : 'Drag a hero here (or click one) to swap.'}</span></div>`;
  }
  function pageRun() {
    const run = S.view.run;
    if (!run) return `${header('Current run', 'No run in progress')}
      <section class="card sect"><div class="sect-head"><h2>Swap hero</h2><span class="sub">Needs a run in progress.</span></div>
        <div class="swaprow">${dropZone(null)}<div class="grid g-hero">${heroRoster(null)}</div></div></section>`;
    const cur = heroCat(run.hero);
    const heroes = heroRoster(run);
    const p = S.swap.plan;
    const diff = p ? `<div class="row" style="align-items:stretch;gap:16px">
      <div class="card" style="flex:3 1 520px;background:var(--well);border-color:#2B4A2E;display:flex;flex-direction:column;gap:10px">
        <b style="font-size:15px">Swap ${esc(p.fromName)} → ${esc(p.toName)}: what changes</b>
        <div class="diff"><span class="sub">Hero</span><span class="from">${esc(p.fromName)}</span>${svg('arrow', 18, '#9BE15D')}<span class="to">${esc(p.toName)}</span></div>
        <div class="diff"><span class="sub">Max health</span><span class="from">${Math.round(p.oldMax)}</span>${svg('arrow', 18, '#9BE15D')}<span class="to">${Math.round(p.newMax)} (health ${Math.round(p.oldHp)} → ${Math.round(p.newHp)})</span></div>
        ${p.changes.filter((c) => c.action !== 'keep').map((c) => `<div class="diff"><span class="sub">${esc((c.why || 'power').replace(/^./, (x) => x.toUpperCase()))}</span><span class="from">${esc(c.from)}</span>${svg('arrow', 18, '#9BE15D')}${c.action === 'remove' ? '<span class="rm">Removed</span>' : `<span class="to">${esc(c.to)}</span>`}</div>`).join('')}
        ${p.changes.every((c) => c.action === 'keep') ? '<span class="sub">All your powers stay as they are.</span>' : ''}
        ${p.healthNote ? `<span class="sub">${esc(p.healthNote)}</span>` : ''}
        <div class="row"><button class="btn primary" data-act="swapAdd">Add swap to changes</button><button class="btn ghost" data-act="swapCancel">Cancel</button></div></div>
      <div class="card" style="flex:1 1 260px;background:var(--well);display:flex;flex-direction:column;gap:4px"><b style="font-size:15px;margin-bottom:4px">Options</b>
        <label class="check"><input type="checkbox" data-in="swapOpt" data-k="tool" ${S.swap.tool ? 'checked' : ''}>Swap the starting tool</label>
        <label class="check"><input type="checkbox" data-in="swapOpt" data-k="heroPowers" ${S.swap.heroPowers ? 'checked' : ''}>Swap Inspirations &amp; Masteries</label>
        <label class="check"><input type="checkbox" data-in="swapOpt" data-k="keepUnmatched" ${S.swap.keepUnmatched ? 'checked' : ''}>Keep Masteries the new hero can't use</label>
        <span class="sub" style="font-size:12px">Hero-only Masteries usually don't work on another hero, so they're removed unless you tick this.</span></div></div>` : '';
    const powers = run.powers.map((pw) => {
      const lv = []; for (let i = 1; i <= pw.maxLevel; i++) lv.push(`<button class="lv" data-act="pLevel" data-i="${pw.index}" data-lv="${i}" aria-pressed="${pw.level === i}">L${i}</button>`);
      const key = pw.atlas && pw.icon ? `${pw.atlas}:${pw.icon}` : null;
      const kind = { tool: pw.startTool ? 'Tool · starting tool' : 'Tool', power: 'Power', mastery: 'Mastery · hero-only', inspiration: 'Inspiration · hero-only' }[pw.kind] || 'Power';
      return `<div class="prow">${icon(key, 52, pw.name)}<div class="nm"><b>${esc(pw.name)}</b><span>${kind}${pw.known ? '' : ' · not recognised'}</span></div>
        ${pw.kind === 'inspiration' || pw.kind === 'mastery' || pw.startTool ? '<span class="tagb">follows hero</span>' : ''}
        <div role="group" aria-label="${esc(pw.name)} level" class="row" style="gap:6px">${lv.join('')}</div>
        <button class="del" aria-label="Remove ${esc(pw.name)}" data-act="pRemove" data-i="${pw.index}">${svg('trash', 16)}</button></div>`;
    }).join('');
    const res = run.resources.map((r) => {
      const o = S.base.run && S.base.run.resources.find((x) => x.key === r.key); const ed = o && o.value !== r.value;
      const ic = { coins: 'CURRENCY_SCRAP_MED', lucky_dice: 'LuckyDice', revive_tokens: 'SplintersRevive' }[r.key];
      return `<div class="row" style="background:var(--panel2);border-radius:12px;padding:10px 12px;flex-wrap:nowrap">${icon('Icons.atlas:' + ic, 40, r.name)}<span style="flex:1 1 auto;color:var(--soft2)">${esc(r.name)}</span>
        <label style="width:110px"><span class="sr">${esc(r.name)}</span>${spin(`<input class="num-input sm ${ed ? 'edited' : ''}" style="padding:0 30px 0 6px" type="number" min="0" value="${r.value}" data-in="res" data-key="${r.key}">`, 'res', r.key, r.name)}</label></div>`;
    }).join('');
    const hpPct = Math.max(0, Math.min(100, (run.health / run.maxHealth) * 100));
    return `${header('Current run', `${esc(cur ? cur.name : 'Unknown hero')} · ${esc(prettyLevel(run.level))} · chapter ${run.chapter} · room ${run.roomIndex} of ${run.rooms}`)}
      <section class="card sect"><div class="sect-head"><h2>Swap hero</h2><span class="sub">Drag a hero onto Current character (or click one). Powers, Scrap and room stay; hero-only items switch over.</span></div>
        <div class="swaprow">${dropZone(run)}<div class="grid g-hero">${heroes}</div></div>${diff}</section>
      <div class="row" style="align-items:flex-start;gap:20px">
        <section class="card sect" style="flex:3 1 560px"><div class="row"><h2>Powers this run</h2><span class="sub">${run.powers.length} owned</span>
          <button class="btn small" style="margin-left:auto" data-act="addOpen">${svg('plus', 16)}Add power</button></div>${powers || '<div class="sub">No powers yet.</div>'}</section>
        <section class="card sect" style="flex:1 1 300px"><h2>Run resources</h2>
          <div style="display:flex;flex-direction:column;gap:8px"><div class="row" style="justify-content:space-between;font-size:13px"><span style="color:var(--soft)">Health</span><b>${Math.round(run.health)} / ${Math.round(run.maxHealth)}</b></div>
          <div style="height:10px;background:var(--well);border-radius:999px;overflow:hidden"><div style="width:${hpPct}%;height:100%;background:#7BD34A"></div></div>
          <button class="chip" style="align-self:flex-start" data-act="heal" ${run.health >= run.maxHealth ? 'disabled' : ''}>Heal to full</button></div>${res}
          <p class="sub" style="margin:0;font-size:12px">These reset when the run ends.</p></section></div>`;
  }

  // ---------- add power modal ----------
  function addPowerModal() {
    const run = S.view.run;
    const heroKey = run.hero;
    const have = new Set(run.powers.map((p) => p.name));
    const cur = heroCat(run.hero);
    const q = S.add.q.trim().toLowerCase();
    const list = S.catalog.powers.filter((p) => {
      if (S.add.kind === 'tool' ? p.kind !== 'tool' : S.add.kind === 'hero' ? !(p.kind === 'mastery' || p.kind === 'inspiration') : p.kind !== 'power') return false;
      if (p.hero && heroKey && p.hero !== heroKey && !(cur && cur.key === 'Karai' && p.hero === 'Alopex' && p.kind === 'inspiration') && !(cur && cur.key === 'Shredder' && p.hero === 'Leonardo' && p.kind === 'inspiration')) return false;
      return !q || p.name.toLowerCase().includes(q) || String(p.family || '').toLowerCase().includes(q);
    }).slice(0, 120);
    return `<div class="overlay" data-act="closeModalBg"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="add-t">
      <div class="dhead"><h2 id="add-t" style="flex:1 1 auto">Add a power</h2><button class="step sm" aria-label="Close" data-act="addClose">${svg('x', 16)}</button></div>
      <div class="dbody"><div class="tabs" role="tablist">${[['power', 'Powers'], ['tool', 'Tools'], ['hero', `${esc(cur ? cur.name : 'Hero')} only`]].map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.add.kind === k}" data-act="addKind" data-k="${k}">${l}</button>`).join('')}</div>
        <label><span class="sr">Search powers</span><input class="search" type="search" placeholder="Search by name or element…" value="${esc(S.add.q)}" data-in="addQ" autofocus></label>
        <div class="blist" style="max-height:46vh">${list.map((p) => `<button class="bitem" data-act="addPick" data-ps="${esc(p.ps)}" ${have.has(p.name) ? 'disabled' : ''}>${icon(p.icon, 36, p.name)}<span style="display:flex;flex-direction:column"><span>${esc(p.name)}</span><small>${esc(p.family || p.kind)}${p.kind === 'tool' ? ' · replaces your current tool' : ''}${have.has(p.name) ? ' · already owned' : ''}</small></span></button>`).join('') || '<span class="sub">Nothing matches.</span>'}</div></div></section></div>`;
  }

  // ---------- upgrades ----------
  function pageUpgrades() {
    const v = S.view, b = S.base;
    const tabs = ['Combat', 'Turtles', 'Fortune', 'Inspirations'];
    const rows = v.upgrades.filter((u) => u.tab === S.upTab && (S.showUnused || !u.unused)).map((u) => {
      const o = b.upgrades.find((x) => x.buff === u.buff);
      const pips = []; for (let i = 0; i < u.max; i++) pips.push(`<span class="${i < u.level ? (i >= o.level ? 'new' : 'on') : ''}"></span>`);
      const eff = u.fmt === 2 ? `+${Math.round(u.value * 1000) / 10}% per level` : `+${u.value} per level`;
      const next = u.level >= u.max ? 'Maxed' : u.next ? `Next: ${fmtN(u.next.cost)}${u.next.req ? ` · needs ${u.next.req.amount} ${esc(u.next.req.currency)}` : ''}` : '';
      return `<div class="urow up">${icon(`${u.atlas}:${u.icon}`, 44, u.name)}<div style="display:flex;flex-direction:column;gap:3px;flex:1 1 220px;min-width:0"><b style="font-size:15px">${esc(u.name)}${u.unused ? ' <span class="tagb" style="color:var(--amber);border-color:#5A4520;background:#221A0E">unused by game</span>' : ''}</b><span class="sub" style="font-size:12px">${eff}</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:0 1 260px;min-width:200px"><div class="pips">${pips.join('')}</div><span class="sub" style="font-size:12px">${next}</span></div>
        <div class="row" style="gap:6px;flex-wrap:nowrap"><button class="step sm" aria-label="Lower ${esc(u.name)}" data-act="up" data-buff="${esc(u.buff)}" data-d="-1" ${u.level <= 0 ? 'disabled' : ''}>−</button>
        <span style="min-width:64px;text-align:center;font:700 15px var(--head)">${u.level} / ${u.max}</span>
        <button class="step sm" aria-label="Raise ${esc(u.name)}" data-act="up" data-buff="${esc(u.buff)}" data-d="1" ${u.level >= u.max ? 'disabled' : ''}>+</button></div></div>`;
    }).join('');
    const shown = v.artifacts.filter((a) => S.showUnused || !a.unused);
    if (!S.artSel || !shown.find((a) => a.sym === S.artSel)) S.artSel = (shown.find((a) => a.equipped) || shown[0] || {}).sym || null;
    const arts = shown.map((a) => {
      const o = b.artifacts.find((x) => x.sym === a.sym); const ed = o.level !== a.level || o.owned !== a.owned;
      const mini = []; for (let i = 0; i < a.max; i++) mini.push(`<span class="${a.owned && i < a.level ? 'on' : ''}"></span>`);
      return `<button class="atile ${a.owned ? '' : 'locked'} ${ed ? 'edited' : ''}" data-act="artSel" data-sym="${esc(a.sym)}" aria-pressed="${S.artSel === a.sym}" title="${esc(a.name)}" aria-label="${esc(a.name)}, ${a.owned ? `level ${a.level} of ${a.max}` : 'locked'}">
        ${icon('Artifacts.atlas:' + a.icon, 34, a.name)}${a.equipped ? '<span class="aeq" aria-hidden="true"></span>' : ''}<span class="pips">${mini.join('')}</span></button>`;
    }).join('');
    const sel = shown.find((a) => a.sym === S.artSel);
    let artEd = '';
    if (sel) {
      const o = b.artifacts.find((x) => x.sym === sel.sym); const ed = o.level !== sel.level || o.owned !== sel.owned;
      const bars = []; for (let i = 1; i <= sel.max; i++) bars.push(`<button class="abar ${sel.owned && i <= sel.level ? 'on' : ''} ${sel.owned && i <= sel.level && (!o.owned || i > o.level) ? 'new' : ''}" data-act="artLv" data-sym="${esc(sel.sym)}" data-lv="${i}" aria-label="Set ${esc(sel.name)} to level ${i}" aria-pressed="${sel.owned && sel.level === i}">${i}</button>`);
      artEd = `<div class="aedit ${ed ? 'edited' : ''}">
        <div class="row" style="flex-wrap:nowrap;gap:12px">${icon('Artifacts.atlas:' + sel.icon, 56, sel.name, sel.owned ? '' : 'gray')}
          <div style="display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:0"><b style="font-size:15px">${esc(sel.name)}</b>
          <span class="sub" style="font-size:12px">${sel.owned ? `Level ${sel.level} of ${sel.max}` : 'Locked — click a bar to unlock it at that level'}${sel.equipped ? ' · <span style="color:#A8E07A">Equipped</span>' : ''}</span>
          ${sel.unused ? '<span class="sub" style="font-size:11px;color:var(--amber)">Unused by the game — may not work</span>' : ''}</div>
          ${ed ? `<button class="chip" data-act="artRevert" data-sym="${esc(sel.sym)}">Revert</button>` : ''}
          ${sel.owned && !sel.equipped ? `<button class="chip" data-act="equip" data-sym="${esc(sel.sym)}">Equip</button>` : ''}</div>
        <div class="abars" role="group" aria-label="${esc(sel.name)} level">${bars.join('')}</div></div>`;
    }
    const usedArts = v.artifacts.filter((a) => !a.unused);
    return `${header('Upgrades & artifacts', `${v.upgrades.filter((u) => u.level > 0).length} of ${v.upgrades.filter((u) => !u.unused).length} shop upgrades bought · applies to every hero`)}
      <div class="row"><div class="tabs" role="tablist">${tabs.map((t) => `<button class="tab" role="tab" aria-selected="${S.upTab === t}" data-act="upTab" data-t="${t}">${t}</button>`).join('')}</div>
        <span class="grow"></span><label class="check"><input type="checkbox" data-in="showUnused" ${S.showUnused ? 'checked' : ''}>Show content the game doesn't use</label>
        <button class="btn small" data-act="upMax">Max this tab</button></div>
      <div class="row" style="align-items:flex-start;gap:20px">
        <section class="card" style="flex:3 1 560px;padding:6px">${rows || '<div class="empty">Nothing here.</div>'}</section>
        <section class="card sect" style="flex:2 1 380px"><div class="sect-head"><h2>Artifacts</h2><span class="sub">${usedArts.filter((a) => a.owned).length} of ${usedArts.length} found · pick an artifact, then click a bar to set its level</span></div>
          ${artEd}<div class="g-art">${arts}</div>
          <button class="btn small" data-act="artAll">Unlock all &amp; max levels</button></section></div>`;
  }

  // ---------- game files ----------
  function gfDesired() {
    const g = S.gf, cur = g.values.current;
    const heroes = JSON.parse(JSON.stringify(cur.heroes));
    for (const [k, v] of Object.entries(g.edits.heroes)) Object.assign(heroes[k], v);
    const buffs = {};
    for (const [n, v] of Object.entries(g.edits.buffs)) buffs[n] = v;
    return { heroes, buffs };
  }
  function gfPending() {
    // full set of differences from the unpatched base (so re-applying keeps earlier patches)
    const g = S.gf, base = g.values.base, cur = g.values.current, d = gfDesired();
    const out = { heroes: {}, buffs: {} };
    for (const [k, v] of Object.entries(d.heroes)) for (const f of ['baseHp', 'speed', 'scale', 'dash']) {
      if (v[f] != null && base.heroes[k] && v[f] !== base.heroes[k][f]) (out.heroes[k] = out.heroes[k] || {})[f] = v[f];
    }
    const names = new Set([...Object.keys(cur.buffs).filter((n) => JSON.stringify(cur.buffs[n]) !== JSON.stringify(base.buffs[n])), ...Object.keys(d.buffs)]);
    for (const n of names) {
      const v = d.buffs[n] || cur.buffs[n];
      if (JSON.stringify(v) !== JSON.stringify(base.buffs[n])) out.buffs[n] = v;
    }
    return out;
  }
  function gfChangedCount() {
    const g = S.gf; if (!g.values) return 0;
    let n = 0;
    for (const [k, v] of Object.entries(g.edits.heroes)) for (const f of Object.keys(v)) if (v[f] !== g.values.current.heroes[k][f]) n++;
    for (const [nm, v] of Object.entries(g.edits.buffs)) { const c = g.values.current.buffs[nm]; v.floats.forEach((x, i) => { if (x !== c.floats[i]) n++; }); v.ints.forEach((x, i) => { if (x !== c.ints[i]) n++; }); }
    return n;
  }
  function pageGame() {
    const gi = S.init.game;
    if (!gi.gameDir) return `${header('Game files', 'Game folder not found', { saveBar: false })}<div class="card empty">Mutagen couldn't find TMNT: Splintered Fate.<div style="margin-top:14px"><button class="btn" data-act="gameChoose">${svg('folder')}Find the game folder</button></div></div>`;
    const info = gi.info;
    const st = !info ? 'Could not read game files' : info.status === 'patched' ? `Mutagen patch active on ${esc(info.base.label)}` : info.status === 'clean' ? esc(info.base.label) : 'Unrecognised version — editing disabled';
    const locked = !info || info.status === 'unknown';
    const g = S.gf;
    let body = '';
    if (locked) {
      body = `<div class="card">Your <span class="mono">overhead.pak2</span> doesn't match any version Mutagen knows (Steam original, or the Karai/Shredder mod builds). That usually means the game updated. To keep the game safe, game-file editing is turned off. Save editing still works.
        ${info && info.staleState ? `<div style="margin-top:12px" class="row"><span class="sub">Mutagen has an old patch record from before the files changed.</span><button class="btn small" data-act="gfForget">Forget old patch</button></div>` : ''}</div>`;
    } else if (!g.values) {
      body = '<div class="card empty">Reading game files…</div>';
    } else {
      const d = gfDesired();
      const heroesRows = S.catalog.heroes.filter((h) => d.heroes[h.key]).map((h) => {
        const v = d.heroes[h.key], c = g.values.current.heroes[h.key], b = g.values.base.heroes[h.key];
        const cell = (f, step) => `<label><span class="sr">${esc(h.name)} ${f}</span><input class="cell ${v[f] !== c[f] ? 'edited' : ''}" type="number" step="${step}" value="${v[f] == null ? '' : v[f]}" data-in="gfHero" data-k="${h.key}" data-f="${f}" ${v[f] == null ? 'disabled' : ''}></label>`;
        const changed = ['baseHp', 'speed', 'scale', 'dash'].some((f) => v[f] !== b[f]);
        return `<span class="row" style="flex-wrap:nowrap;font-weight:600;gap:10px">${icon(h.avatar, 36, h.name)}${esc(h.name)}${h.mod ? ' <span class="tagb" style="color:var(--amber);border-color:#5A4520;background:#221A0E">mod</span>' : ''}</span>
          ${cell('baseHp', 1)}${cell('speed', 0.05)}${cell('scale', 0.01)}${cell('dash', 0.05)}
          <button class="chip" data-act="gfHeroReset" data-k="${h.key}" ${changed ? '' : 'disabled'}>Reset</button>`;
      }).join('');
      const q = g.q.trim().toLowerCase();
      const blist = S.catalog.buffs.filter((b) => g.values.current.buffs[b.id] && (!q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q))).slice(0, 150);
      const sel = g.sel && g.values.current.buffs[g.sel] ? g.sel : null;
      let editor = '<div class="empty">Pick a power on the left to see its numbers.</div>';
      if (sel) {
        const bc = S.catalog.buffs.find((x) => x.id === sel);
        const v = d.buffs[sel] || g.values.current.buffs[sel], c = g.values.current.buffs[sel], b = g.values.base.buffs[sel];
        const rows = [];
        for (let r = 0; r < 5; r++) {
          const idx = [0, 1, 2, 3].map((i) => r * 4 + i);
          if (idx.every((i) => c.floats[i] === -1)) continue;
          rows.push(`<span class="sub">Value ${'ABCDE'[r]}</span>${idx.map((i) => `<label><span class="sr">Value ${'ABCDE'[r]} column ${i % 4}</span><input class="cell ${v.floats[i] !== c.floats[i] ? 'edited' : ''}" type="number" step="any" value="${c.floats[i] === -1 ? '' : v.floats[i]}" placeholder="—" data-in="gfBuff" data-n="${esc(sel)}" data-t="f" data-i="${i}" ${c.floats[i] === -1 ? 'disabled' : ''}></label>`).join('')}`);
        }
        for (let r = 0; r < 2; r++) {
          const idx = [0, 1, 2, 3].map((i) => r * 4 + i);
          if (idx.every((i) => c.ints[i] === -1)) continue;
          rows.push(`<span class="sub">Count ${r + 1}</span>${idx.map((i) => `<label><span class="sr">Count ${r + 1} column ${i % 4}</span><input class="cell ${v.ints[i] !== c.ints[i] ? 'edited' : ''}" type="number" step="1" value="${c.ints[i] === -1 ? '' : v.ints[i]}" placeholder="—" data-in="gfBuff" data-n="${esc(sel)}" data-t="i" data-i="${i}" ${c.ints[i] === -1 ? 'disabled' : ''}></label>`).join('')}`);
        }
        const changedFromBase = JSON.stringify(v) !== JSON.stringify(b);
        editor = `<div class="row" style="flex-wrap:nowrap">${icon(bc.icon, 48, bc.name)}<div style="display:flex;flex-direction:column;gap:2px;flex:1 1 auto"><b style="font:700 17px var(--head)">${esc(bc.name)}</b><span class="sub mono">${esc(sel)}</span></div><button class="chip" data-act="gfBuffReset" data-n="${esc(sel)}" ${changedFromBase ? '' : 'disabled'}>Reset</button></div>
          ${rows.length ? `<div class="tbl" style="grid-template-columns:110px repeat(4,minmax(0,1fr))"><span class="th">Value</span><span class="th">Base</span><span class="th">Level 1</span><span class="th">Level 2</span><span class="th">Level 3</span>${rows.join('')}</div>` : '<span class="sub">This power has no adjustable numbers.</span>'}
          <p class="sub" style="margin:0;font-size:12px">Columns follow the power's level (Inspirations use their shop upgrade level, starting at Base). Dashes are slots the game doesn't use. The game doesn't name these values, so test changes in a run.</p>`;
      }
      body = `<section class="card sect"><div class="sect-head"><h2>Hero base stats</h2><span class="sub">Base HP is multiplied by your Health upgrades in game.</span></div>
          <div style="overflow-x:auto"><div class="tbl hero5" style="min-width:760px"><span class="th">Hero</span><span class="th">Base HP</span><span class="th">Move speed</span><span class="th">Body size</span><span class="th">Dash cooldown (s)</span><span></span>${heroesRows}</div></div></section>
        <section class="card row" style="align-items:flex-start;gap:20px">
          <div style="flex:1 1 280px;display:flex;flex-direction:column;gap:10px"><h2>Power values</h2>
            <label><span class="sr">Search powers</span><input class="search" type="search" placeholder="Search ${Object.keys(g.values.current.buffs).length} powers…" value="${esc(g.q)}" data-in="gfQ"></label>
            <div class="blist">${blist.map((b) => `<button class="bitem" data-act="gfSel" data-n="${esc(b.id)}" aria-pressed="${b.id === sel}">${icon(b.icon, 34, b.name)}<span style="display:flex;flex-direction:column"><span>${esc(b.name)}</span><small>${esc(b.family || b.kind)}${g.edits.buffs[b.id] ? ' · edited' : ''}</small></span></button>`).join('')}</div></div>
          <div style="flex:3 1 520px;display:flex;flex-direction:column;gap:12px;background:var(--well);border:1px solid var(--line);border-radius:16px;padding:18px">${editor}</div></section>`;
    }
    const n = gfChangedCount();
    const patched = info && info.status === 'patched';
    return `<header class="top"><div class="title"><h1>Game files</h1><span class="sub">Hero stats and power numbers live in <span class="mono">PackData\\overhead.pak2</span>, not your save. Current: ${st}</span></div>
        ${S.running ? '<span class="pill bad"><span class="dot"></span>Game is running</span>' : ''}
        <button class="btn" data-act="gfRestore" ${patched && !S.running ? '' : 'disabled'}>Restore original files</button>
        <button class="btn warn" data-act="gfApply" ${(n || (patched && false)) && !locked && !S.running && !S.busy ? '' : 'disabled'}>Apply patch${n ? ` (${n})` : ''}</button></header>
      <div class="warnbar" role="note">${svg('warn', 22, '#F5B04A')}<div><b>Changes here edit the game, not the save.</b> They're applied as a reversible patch with a verified backup. If you use the Karai/Shredder installer, click "Restore original files" here first — that installer only recognises its own files.</div></div>
      ${body}`;
  }
  function gameWarnModal(kind) {
    const apply = kind === 'apply';
    return `<div class="overlay"><section class="dialog warn" role="alertdialog" aria-modal="true" aria-labelledby="w-t" aria-describedby="w-b">
      <div class="dhead"><div class="dicon">${svg('warn', 28, '#1A1206', 2.2)}</div><div style="display:flex;flex-direction:column;gap:4px"><h2 id="w-t">${apply ? 'Patch the game files?' : "You're about to edit the game itself"}</h2><span style="font-size:13px;color:#E9D3AE">This is not your save. These changes modify TMNT: Splintered Fate's installed files.</span></div></div>
      <div class="dbody" id="w-b"><span>Editing hero stats or power values rewrites <b style="color:#fff">PackData\\overhead.pak2</b> in your game folder. Bad values can cause:</span>
        <span class="bul">crashes on launch or mid-run</span><span class="bul">broken or unbeatable fights, and characters that move or scale strangely</span>
        <span class="bul">problems in co-op if other players don't have the same files</span><span class="bul">conflicts with other mods (your Karai + Shredder mod is detected and kept)</span>
        <div class="protect"><b style="color:var(--text)">How you're protected</b><span>A full backup is made and checked (SHA1) first. If anything fails, the original goes back automatically.</span><span>"Restore original files" undoes everything. Steam "Verify integrity" also resets these files, along with your other mods.</span></div>
        ${apply ? `<div class="protect"><b style="color:var(--text)">This patch</b>${gfSummary()}</div>` : ''}
        <label class="check" style="color:var(--text);font-weight:600;min-height:44px"><input type="checkbox" data-in="warnAck" style="accent-color:#F5B04A">I understand this changes the game's files and could make the game unstable.</label></div>
      <div class="dfoot"><button class="btn" data-act="warnBack">${apply ? 'Cancel' : 'Back to save editing'}</button><button class="btn warn" data-act="${apply ? 'gfApplyGo' : 'warnGo'}" id="warn-go" disabled>${apply ? 'Back up &amp; apply patch' : 'I understand, continue'}</button></div></section></div>`;
  }
  function gfSummary() {
    const p = gfPending(); const lines = [];
    for (const [k, v] of Object.entries(p.heroes)) { const h = heroCat(k); lines.push(`${esc(h ? h.name : k)}: ${Object.entries(v).map(([f, x]) => `${({ baseHp: 'HP', speed: 'speed', scale: 'size', dash: 'dash' })[f]} ${x}`).join(', ')}`); }
    for (const n of Object.keys(p.buffs)) { const b = S.catalog.buffs.find((x) => x.id === n); lines.push(`${esc(b ? b.name : n)}: values changed`); }
    return lines.length ? lines.map((l) => `<span>${l}</span>`).join('') : '<span>No differences from the original — this will restore it.</span>';
  }

  // ---------- safety ----------
  function pageSafety() {
    const list = S.backups.map((b) => `<div class="urow"><div style="display:flex;flex-direction:column;gap:3px;flex:1 1 auto"><b>${esc(new Date(b.created).toLocaleString())}</b><span class="sub" style="font-size:12px">Slot ${b.slot + 1} · ${esc(b.reason)} · ${b.files.map((f) => `${esc(f.name)} <span class="mono">${esc(f.sha1.slice(0, 10))}</span>`).join(' · ')}</span></div>
      <button class="btn small" data-act="restoreBackup" data-id="${esc(b.id)}" ${S.running ? 'disabled' : ''}>Restore</button></div>`).join('');
    return `${header('Backups & safety', 'Every save is backed up and checked before anything is written.', { saveBar: false })}
      <section class="card sect"><h2>What Mutagen checks every time you save</h2><div class="steps">${[
        'The game is closed (it rewrites the save every few seconds).',
        "The save's built-in checksum (MD5) is valid before editing.",
        'The file hasn\'t changed since you opened it (SHA1) — so newer progress is never overwritten.',
        'Only the fields you edited changed — everything else is compared field by field.',
        'The new save re-reads with a valid checksum before it touches disk.',
        'A backup is made and its SHA1 verified.',
        'The new file is written to a temporary copy, read back, then swapped in and checked again (SHA1).',
        'If anything fails, the backup goes back automatically.',
      ].map((s) => `<div>${svg('check', 16, '#9BE15D', 2.4)}<span>${s}</span></div>`).join('')}</div></section>
      ${S.lastLog ? `<section class="card sect"><h2>Last save</h2><div class="steps">${S.lastLog.map((s) => `<div>${svg('check', 16, '#9BE15D', 2.4)}<span>${esc(s)}</span></div>`).join('')}</div></section>` : ''}
      <section class="card sect" style="padding:8px"><div class="row" style="padding:10px 14px"><h2>Save backups</h2><span class="sub">The latest 25 are kept in ${esc(S.init.dataDir)}\\backups</span><button class="btn small" style="margin-left:auto" data-act="openBackups">${svg('folder', 16)}Open folder</button></div>
        ${list || '<div class="empty">No backups yet — one is made automatically the first time you save.</div>'}</section>`;
  }

  // ---------- modals ----------
  let modal = null; // {type, ...}
  function renderModal() {
    const root = $('#modal-root');
    if (!modal) { root.innerHTML = ''; return; }
    if (modal.type === 'add') root.innerHTML = addPowerModal();
    else if (modal.type === 'gameWarn') root.innerHTML = gameWarnModal('enter');
    else if (modal.type === 'gameApply') root.innerHTML = gameWarnModal('apply');
    else if (modal.type === 'result') {
      root.innerHTML = `<div class="overlay"><section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="r-t"><div class="dhead"><div class="dicon ${modal.ok ? 'ok' : 'bad'}">${svg(modal.ok ? 'check' : 'x', 26, '#0E1013', 2.6)}</div><h2 id="r-t">${esc(modal.title)}</h2></div>
        <div class="dbody">${modal.message ? `<span>${esc(modal.message)}</span>` : ''}<div class="steps">${(modal.log || []).map((s) => `<div>${svg('check', 16, '#9BE15D', 2.4)}<span>${esc(s)}</span></div>`).join('')}</div></div>
        <div class="dfoot"><button class="btn primary" data-act="closeModal">OK</button></div></section></div>`;
    } else if (modal.type === 'pending') {
      root.innerHTML = `<div class="overlay" data-act="closeModalBg"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="p-t"><div class="dhead"><h2 id="p-t" style="flex:1 1 auto">Pending changes</h2><button class="step sm" aria-label="Close" data-act="closeModal">${svg('x', 16)}</button></div>
        <div class="dbody">${S.ops.map((o, i) => `<div class="row" style="flex-wrap:nowrap"><span style="flex:1 1 auto">${i + 1}. ${esc(describeOp(o))}</span></div>`).join('')}</div>
        <div class="dfoot"><button class="btn" data-act="undoLast">Undo last</button><button class="btn" data-act="discard">Discard all</button><button class="btn primary" data-act="save" ${S.running ? 'disabled' : ''}>Save changes</button></div></section></div>`;
    } else if (modal.type === 'busy') {
      root.innerHTML = `<div class="overlay"><section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="b-t"><div class="dhead"><h2 id="b-t">${esc(modal.title)}</h2></div><div class="dbody"><div class="steps">${(S.gf.log || []).map((s) => `<div>${svg('check', 16, '#9BE15D', 2.4)}<span>${esc(s)}</span></div>`).join('')}</div><span class="sub">Working… this can take up to a minute for game files.</span></div></section></div>`;
    }
    const f = root.querySelector('[autofocus]') || root.querySelector('.dialog button, .dialog input');
    if (f && !root.contains(document.activeElement)) f.focus();
  }

  // ---------- render ----------
  function render() {
    renderNav();
    const m = $('#main');
    if (!S.view && !(S.page === 'safety' && S.init)) { m.innerHTML = S.fatal ? `<div class="card empty">${S.fatal}${S.backups.length ? '<div style="margin-top:14px"><button class="btn" data-act="page" data-id="safety">Restore a Mutagen backup</button></div>' : ''}</div>` : '<div class="empty">Loading…</div>'; renderModal(); return; }
    const scroll = m.scrollTop;
    const active = document.activeElement && document.activeElement.dataset ? { in: document.activeElement.dataset.in, key: document.activeElement.dataset.key || document.activeElement.dataset.stat || document.activeElement.dataset.f || document.activeElement.dataset.i } : null;
    m.innerHTML = { overview: pageOverview, run: pageRun, upgrades: pageUpgrades, game: pageGame, safety: pageSafety }[S.page]();
    m.scrollTop = scroll;
    if (active && active.in) {
      const el = [...m.querySelectorAll(`[data-in="${active.in}"]`)].find((e) => (e.dataset.key || e.dataset.stat || e.dataset.f || e.dataset.i) === active.key);
      if (el) el.focus();
    }
    renderModal();
  }

  // ---------- actions ----------
  async function loadSlot(slot) {
    const r = await mutagen.load(slot);
    if (r.error) { S.fatal = `Couldn't open this save: ${esc(r.error)}`; S.view = null; render(); return; }
    S.slot = slot; S.loaded = { sha1: r.sha1, file: `saveSlot.GameState${slot}.cloud.json` }; S.base = r.view; S.view = r.view; S.ops = [];
    S.swap = { hero: null, tool: true, heroPowers: true, keepUnmatched: false, plan: null };
    render();
  }
  async function doSave() {
    if (!S.ops.length || S.busy) return;
    S.busy = true; modal = { type: 'busy', title: 'Saving…' }; S.gf.log = []; render();
    const r = await mutagen.write(S.slot, S.ops);
    S.busy = false;
    if (r.error) {
      modal = { type: 'result', ok: false, title: r.code === 'GAME_RUNNING' ? 'Close the game first' : r.code === 'STALE' ? 'The save changed' : 'Nothing was saved', message: r.error, log: r.log };
      if (r.code === 'STALE') await loadSlot(S.slot);
    } else {
      S.lastLog = r.log; S.base = r.view; S.view = r.view; S.ops = []; S.loaded.sha1 = r.sha1;
      S.swap = { hero: null, tool: true, heroPowers: true, keepUnmatched: false, plan: null };
      S.backups = await mutagen.backups();
      modal = { type: 'result', ok: true, title: 'Saved and verified', message: `${r.changed} edit${r.changed === 1 ? '' : 's'} saved. Backup: ${r.backup}`, log: r.log };
    }
    render();
  }
  async function enterGame() {
    S.page = 'game';
    if (!S.gf.warned) modal = { type: 'gameWarn' };
    render();
    await loadGameValues();
  }
  async function loadGameValues() {
    if (!S.init.game.gameDir || !S.init.game.info || S.init.game.info.status === 'unknown') return;
    const r = await mutagen.gameValues();
    if (r.error) { toast(r.error); return; }
    S.gf.values = r; S.gf.edits = { heroes: {}, buffs: {} };
    if (!S.gf.sel) S.gf.sel = 'Buff_Flame_001_FuriousAttacks';
    render();
  }
  async function gfApplyGo() {
    S.busy = true; S.gf.log = []; modal = { type: 'busy', title: 'Patching game files…' }; render();
    const r = await mutagen.gameApply(gfPending());
    S.busy = false;
    if (r.error) modal = { type: 'result', ok: false, title: 'Game files were not changed', message: r.error, log: r.log };
    else modal = { type: 'result', ok: true, title: r.restored ? 'Original files restored' : 'Game files patched and verified', log: r.log };
    S.init.game = await mutagen.gameRefresh();
    S.gf.values = null; await loadGameValues(); render();
  }
  async function gfRestore() {
    S.busy = true; S.gf.log = []; modal = { type: 'busy', title: 'Restoring original files…' }; render();
    const r = await mutagen.gameRestore();
    S.busy = false;
    modal = r.error ? { type: 'result', ok: false, title: 'Restore did not run', message: r.error, log: r.log } : { type: 'result', ok: true, title: 'Original files restored and verified', log: r.log };
    S.init.game = await mutagen.gameRefresh();
    S.gf.values = null; await loadGameValues(); render();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const a = t.dataset.act, d = t.dataset;
    if (a === 'closeModalBg' && ev.target !== t) return;
    switch (a) {
      case 'page': if (d.id === 'game' && !S.view) { toast('Open a save first.'); break; } if (d.id === 'game') return enterGame(); S.page = d.id; if (d.id === 'safety') S.backups = await mutagen.backups(); render(); $('#main').focus(); break;
      case 'discard': modal = null; await setOps([]); S.swap.plan = null; S.swap.hero = null; render(); break;
      case 'undoLast': await setOps(S.ops.slice(0, -1)); if (!S.ops.length) modal = null; render(); break;
      case 'save': modal = null; await doSave(); break;
      case 'pending': modal = { type: 'pending' }; render(); break;
      case 'closeModal': case 'closeModalBg': modal = null; render(); break;
      case 'openBackups': mutagen.openBackups(); break;
      case 'cur': { const c = S.view.currencies.find((x) => x.key === d.key); const o = S.base.currencies.find((x) => x.key === d.key); const v = Math.max(0, Math.min(9999999, c.balance + Number(d.d))); await pushOp({ op: 'currency', key: d.key, value: v }, { isOriginal: v === o.balance }); break; }
      case 'nstep': {
        const dd = Number(d.d);
        if (d.kind === 'cur') { const c = S.view.currencies.find((x) => x.key === d.key); const o = S.base.currencies.find((x) => x.key === d.key); const v = Math.max(0, Math.min(9999999, c.balance + dd)); await pushOp({ op: 'currency', key: d.key, value: v }, { isOriginal: v === o.balance }); }
        else if (d.kind === 'mat') { const field = d.key.endsWith('_talismans') ? 'talismans' : 'wraps'; const sf = field === 'talismans' ? 'talismanStat' : 'wrapsStat'; const m = S.view.heroMats.find((x) => x[sf] === d.key); const o = S.base.heroMats.find((x) => x[sf] === d.key); const v = Math.max(0, Math.min(9999999, m[field] + dd)); await pushOp({ op: 'heroMat', stat: d.key, value: v }, { isOriginal: v === o[field] }); }
        else if (d.kind === 'res') { const r = S.view.run.resources.find((x) => x.key === d.key); const o = S.base.run.resources.find((x) => x.key === d.key); const v = Math.max(0, Math.min(99999, r.value + dd)); await pushOp({ op: 'runResource', key: d.key, value: v }, { isOriginal: v === o.value }); }
        break; }
      case 'curReset': await pushOp({ op: 'currency', key: d.key, value: 0 }, { isOriginal: true }); break;
      case 'swapPick': if (!S.view.run) { toast('Start a run in the game first — swapping needs a run in progress.'); break; } S.swap.hero = d.hero === S.view.run.hero ? null : d.hero; await refreshPlan(); render(); break;
      case 'swapCancel': S.swap.hero = null; S.swap.plan = null; render(); break;
      case 'swapAdd': { const op = { op: 'swapHero', hero: S.swap.hero, tool: S.swap.tool, heroPowers: S.swap.heroPowers, keepUnmatched: S.swap.keepUnmatched }; S.swap.hero = null; S.swap.plan = null; await pushOp(op); toast('Swap added — click Save changes to write it.'); break; }
      case 'pLevel': await pushOp({ op: 'powerLevel', index: Number(d.i), level: Number(d.lv) }); break;
      case 'pRemove': await pushOp({ op: 'powerRemove', index: Number(d.i) }); break;
      case 'heal': await pushOp({ op: 'runHealth', value: 'full' }); break;
      case 'addOpen': modal = { type: 'add' }; S.add.q = ''; render(); break;
      case 'addClose': modal = null; render(); break;
      case 'addKind': S.add.kind = d.k; render(); break;
      case 'addPick': modal = null; await pushOp({ op: 'powerAdd', ps: d.ps, level: 1 }); break;
      case 'upTab': S.upTab = d.t; render(); break;
      case 'up': { const u = S.view.upgrades.find((x) => x.buff === d.buff); const o = S.base.upgrades.find((x) => x.buff === d.buff); const lv = Math.max(0, Math.min(u.max, u.level + Number(d.d))); await pushOp({ op: 'upgrade', buff: d.buff, level: lv }, { isOriginal: lv === o.level }); break; }
      case 'upMax': { let ops = S.ops.slice(); for (const u of S.view.upgrades.filter((x) => x.tab === S.upTab && (S.showUnused || !x.unused) && x.level < x.max)) { ops = ops.filter((o) => opId(o) !== 'u:' + u.buff); ops.push({ op: 'upgrade', buff: u.buff, level: u.max }); } await setOps(ops); break; }
      case 'artSel': S.artSel = d.sym; render(); break;
      case 'artLv': { const x = S.view.artifacts.find((y) => y.sym === d.sym); const o = S.base.artifacts.find((y) => y.sym === d.sym); const lv = Number(d.lv);
        if (x.owned && x.level === lv) break;
        await pushOp({ op: 'artifact', sym: d.sym, level: lv }, { isOriginal: o.owned && lv === o.level }); break; }
      case 'artRevert': await setOps(S.ops.filter((op) => opId(op) !== 'a:' + d.sym)); break;
      case 'equip': await pushOp({ op: 'equipArtifact', sym: d.sym }); break;
      case 'artAll': { let ops = S.ops.slice(); for (const x of S.view.artifacts.filter((y) => (S.showUnused || !y.unused) && (!y.owned || y.level < y.max))) { ops = ops.filter((o) => opId(o) !== 'a:' + x.sym); ops.push({ op: 'artifact', sym: x.sym, level: x.max }); } await setOps(ops); break; }
      case 'warnBack': if (modal && modal.type === 'gameWarn') { modal = null; S.page = 'overview'; } else modal = null; render(); break;
      case 'warnGo': S.gf.warned = true; modal = null; render(); break;
      case 'gfApply': modal = { type: 'gameApply' }; render(); break;
      case 'gfApplyGo': modal = null; await gfApplyGo(); break;
      case 'gfRestore': await gfRestore(); break;
      case 'gfForget': S.init.game = await mutagen.gameForget(); render(); break;
      case 'gameChoose': { const r = await mutagen.gameChoose(); if (r.error) toast(r.error); else if (!r.cancelled) { S.init.game = r; await loadGameValues(); } render(); break; }
      case 'gfSel': S.gf.sel = d.n; render(); break;
      case 'gfHeroReset': { delete S.gf.edits.heroes[d.k]; const b = S.gf.values.base.heroes[d.k], c = S.gf.values.current.heroes[d.k]; if (JSON.stringify(b) !== JSON.stringify(c)) S.gf.edits.heroes[d.k] = Object.assign({}, b); render(); break; }
      case 'gfBuffReset': { const b = S.gf.values.base.buffs[d.n], c = S.gf.values.current.buffs[d.n]; if (JSON.stringify(b) !== JSON.stringify(c)) S.gf.edits.buffs[d.n] = JSON.parse(JSON.stringify(b)); else delete S.gf.edits.buffs[d.n]; render(); break; }
      case 'restoreBackup': { if (!confirm('Restore this backup? Your current save will be backed up first.')) break; const r = await mutagen.restoreBackup(d.id); modal = r.error ? { type: 'result', ok: false, title: 'Restore did not run', message: r.error, log: r.log } : { type: 'result', ok: true, title: 'Backup restored and verified', log: r.log }; S.backups = await mutagen.backups(); const bk = S.backups.find((x) => x.id === d.id) || {}; if (!r.error) { S.fatal = null; await loadSlot(S.slot != null ? S.slot : (bk.slot || 0)); } render(); break; }
      default: break;
    }
  });

  document.addEventListener('change', async (ev) => {
    const t = ev.target; const d = t.dataset; if (!d || !d.in) return;
    const num = Number(t.value);
    switch (d.in) {
      case 'cur': { if (t.value === '' || !Number.isFinite(num) || num < 0) { toast('Enter a whole number 0 or more.'); render(); return; } const o = S.base.currencies.find((x) => x.key === d.key); const v = Math.min(9999999, Math.round(num)); await pushOp({ op: 'currency', key: d.key, value: v }, { isOriginal: v === o.balance }); break; }
      case 'mat': { if (t.value === '' || !Number.isFinite(num) || num < 0) { toast('Enter a whole number 0 or more.'); render(); return; } const field = d.stat.endsWith('_talismans') ? 'talismans' : 'wraps'; const o = S.base.heroMats.find((x) => x[field === 'talismans' ? 'talismanStat' : 'wrapsStat'] === d.stat); const v = Math.min(9999999, Math.round(num)); await pushOp({ op: 'heroMat', stat: d.stat, value: v }, { isOriginal: v === o[field] }); break; }
      case 'res': { if (t.value === '' || !Number.isFinite(num) || num < 0) { toast('Enter a whole number 0 or more.'); render(); return; } const o = S.base.run.resources.find((x) => x.key === d.key); const v = Math.min(99999, Math.round(num)); await pushOp({ op: 'runResource', key: d.key, value: v }, { isOriginal: v === o.value }); break; }
      case 'swapOpt': S.swap[d.k] = t.checked; await refreshPlan(); render(); break;
      case 'showUnused': S.showUnused = t.checked; render(); break;
      case 'warnAck': { const b = $('#warn-go'); if (b) b.disabled = !t.checked; break; }
      case 'gfHero': {
        if (t.value === '' || !Number.isFinite(num)) { toast('Enter a number.'); render(); return; }
        const lim = S.gf.values.limits[d.f]; if (num < lim[0] || num > lim[1]) { toast(`Must be between ${lim[0]} and ${lim[1]}.`); render(); return; }
        S.gf.edits.heroes[d.k] = Object.assign(S.gf.edits.heroes[d.k] || {}, { [d.f]: num }); render(); break;
      }
      case 'gfBuff': {
        if (t.value === '' || !Number.isFinite(num) || (d.t === 'i' && !Number.isInteger(num))) { toast(d.t === 'i' ? 'Enter a whole number.' : 'Enter a number.'); render(); return; }
        const cur = S.gf.edits.buffs[d.n] || JSON.parse(JSON.stringify(S.gf.values.current.buffs[d.n]));
        (d.t === 'f' ? cur.floats : cur.ints)[Number(d.i)] = num;
        S.gf.edits.buffs[d.n] = cur; render(); break;
      }
      default: break;
    }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target; const d = t.dataset; if (!d || !d.in) return;
    if (d.in === 'addQ') { S.add.q = t.value; const pos = t.selectionStart; renderModal(); const el = $('[data-in="addQ"]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
    if (d.in === 'gfQ') { S.gf.q = t.value; const pos = t.selectionStart; render(); const el = $('[data-in="gfQ"]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
  });
  // ---------- drag a portrait onto "Current character" ----------
  document.addEventListener('dragstart', (ev) => {
    const h = ev.target.closest && ev.target.closest('[data-drag-hero]');
    if (!h) return;
    S.drag = h.dataset.dragHero; h.classList.add('dragging');
    ev.dataTransfer.setData('text/plain', S.drag); ev.dataTransfer.effectAllowed = 'move';
    const dz = $('#dropzone'); if (dz) dz.classList.add('ready');
  });
  document.addEventListener('dragend', () => {
    S.drag = null; document.querySelectorAll('.dragging').forEach((e) => e.classList.remove('dragging'));
    const dz = $('#dropzone'); if (dz) dz.classList.remove('ready', 'over');
  });
  document.addEventListener('dragover', (ev) => {
    const dz = ev.target.closest && ev.target.closest('#dropzone');
    if (!dz || !S.drag) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; dz.classList.add('over');
  });
  document.addEventListener('dragleave', (ev) => {
    const dz = ev.target.closest && ev.target.closest('#dropzone');
    if (dz && !dz.contains(ev.relatedTarget)) dz.classList.remove('over');
  });
  document.addEventListener('drop', async (ev) => {
    ev.preventDefault(); // never let a dropped file navigate the window
    const dz = ev.target.closest && ev.target.closest('#dropzone');
    const hero = S.drag || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
    S.drag = null;
    if (!dz || !hero || !S.view) return;
    dz.classList.remove('over', 'ready');
    if (!S.view.run) { toast('Start a run in the game first — swapping needs a run in progress.'); return; }
    const h = S.view.heroes.find((x) => x.key === hero); if (!h || !h.available) return;
    S.swap.hero = hero === S.view.run.hero ? null : hero; await refreshPlan(); render();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal && ['add', 'pending', 'result'].includes(modal.type)) { modal = null; render(); }
    if (ev.key === 'Enter' && ev.target.matches('input[type=number]')) ev.target.blur();
  });

  // ---------- boot ----------
  async function pollRunning() {
    const r = await mutagen.gameRunning();
    const was = S.running; S.running = r === true;
    if (was !== S.running && S.view) render();
  }
  async function boot() {
    render();
    mutagen.on('icons:ready', (m) => { S.icons = m || {}; render(); });
    mutagen.on('game:progress', (s) => { S.gf.log.push(s); if (modal && modal.type === 'busy') renderModal(); });
    S.init = await mutagen.init();
    if (S.init.error) { S.fatal = esc(S.init.error); render(); return; }
    S.catalog = await mutagen.catalog();
    const ic = await mutagen.icons(); if (ic.ready) S.icons = ic.icons;
    S.backups = await mutagen.backups();
    if (!S.backups.error) { /* ok */ } else S.backups = [];
    await pollRunning(); setInterval(pollRunning, 3000);
    if (!S.init.saveDirExists || !S.init.slots.length) {
      S.fatal = `No Splintered Fate saves found in <span class="mono">${esc(S.init.saveDir)}</span>. Launch the game once so it creates a save, then reopen Mutagen.`;
      render(); return;
    }
    const good = S.init.slots.filter((s) => s.ok);
    if (!good.length) { S.fatal = `Your save in <span class="mono">${esc(S.init.saveDir)}</span> couldn't be read: ${esc(S.init.slots[0].error)}<br><br>Mutagen won't touch it. The game also keeps its own previous copy (<span class="mono">.bak.cloud.json</span>) next to it.`; render(); return; }
    const pick = good.find((s) => s.slot === S.init.active) || good[0];
    await loadSlot(pick.slot);
  }
  if (window.mutagen) boot(); else window.addEventListener('mutagen-ready', boot, { once: true });
})();
