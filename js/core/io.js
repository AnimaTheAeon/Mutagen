'use strict';
// Thin async wrapper over the native layer (Rust). `transport(cmd, args)` returns parsed JSON or a Buffer.
// The same commands are served by the Tauri app and by the test CLI.
function makeIo(transport, env) {
  const call = (cmd, args = {}) => transport(cmd, args);
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const sep = env.sep || '/';
  const io = {
    env,
    join: (...parts) => parts.filter((p) => p !== '' && p != null).map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep),
    basename: (p) => String(p).split(/[\\/]/).pop(),
    dirname: (p) => { const s = String(p); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i <= 0 ? s : s.slice(0, i); },
    read: (path) => call('read', { path }),
    readText: (path) => call('readText', { path }),
    write: (path, bytes) => call('write', { path, b64: b64(bytes) }),
    writeText: (path, text) => call('write', { path, text }),
    rename: (from, to) => call('rename', { from, to }),
    remove: (path) => call('remove', { path }),
    mkdir: (path) => call('mkdir', { path }),
    stat: (path) => call('stat', { path }),
    exists: async (path) => (await call('stat', { path })) != null,
    readdir: (path) => call('readdir', { path }),
    copy: (from, to) => call('copy', { from, to }),
    sha1File: (path) => call('sha1', { path }),
    free: async (path) => { const v = await call('free', { path }); return v == null ? Infinity : v; },
    isGameDir: (path) => call('isGameDir', { path }),
    findGameDir: (remembered) => call('findGameDir', { remembered: remembered || null }),
    gameRunning: () => call('gameRunning'),
    pakDir: async (path) => {
      const d = await call('pakDir', { path });
      const entries = new Map();
      d.entries.forEach(([hash, off, csize, aligned, usize, flags], index) => entries.set(hash, { index, hash, off, csize, aligned, usize, flags }));
      return { count: d.count, dirOff: d.dirOff, size: d.size, entries };
    },
    pakRead: (path, hash) => call('pakRead', { path, hash }),
    pakPatch: (path, replacements) => call('pakPatch', { path, items: [...replacements].map(([hash, bytes]) => ({ hash, b64: b64(bytes) })) }),
    icons: (jobs, maxSide) => call('icons', { jobs, maxSide }),
    async readJson(path, fallback) { try { const t = await io.readText(path); return t == null ? fallback : JSON.parse(t); } catch { return fallback; } },
    async writeJson(path, obj) { await io.mkdir(io.dirname(path)); const tmp = path + '.tmp'; await io.writeText(tmp, JSON.stringify(obj, null, 2)); await io.rename(tmp, path); },
  };
  return io;
}
module.exports = { makeIo };
