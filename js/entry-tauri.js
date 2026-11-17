// Webview entry: wires the backend to Tauri's native layer and exposes window.mutagen.
const { makeIo } = require('./core/io');
const { createBackend } = require('./core/backend');

const T = window.__TAURI_INTERNALS__;
async function transport(cmd, args) {
  let res;
  try { res = await T.invoke('io', { cmd, args }); } catch (e) {
    let info = e; if (typeof e === 'string') { try { info = JSON.parse(e); } catch { info = { message: e }; } }
    throw Object.assign(new Error(info.message || String(info)), { code: info.code || null });
  }
  const bytes = Buffer.from(new Uint8Array(res));
  if (cmd === 'read' || cmd === 'pakRead') return bytes;
  return JSON.parse(bytes.toString('utf8'));
}
(async () => {
  const env = await transport('env', {});
  const io = makeIo(transport, env);
  const host = {
    version: env.version || '1.1.0',
    fileUrl: (p) => T.convertFileSrc(p),
    openPath: (p) => T.invoke('open_path', { path: p }),
    chooseFolder: () => T.invoke('choose_folder'),
  };
  window.mutagen = createBackend(io, host);
  window.dispatchEvent(new Event('mutagen-ready'));
})();
