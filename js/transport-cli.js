'use strict';
// Node test transport: talks to the Rust test CLI (same dispatcher the app uses).
const { spawn } = require('child_process');
const path = require('path');
function cliTransport(bin = process.env.MUTAGEN_IO_CLI || path.join(__dirname, '..', 'target', 'release', 'mutagen-io-cli')) {
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const waiting = new Map(); let id = 0; let buf = '';
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const r = JSON.parse(line); const w = waiting.get(r.id); waiting.delete(r.id);
      if (!w) continue;
      if (r.err) w.reject(Object.assign(new Error(r.err.message), { code: r.err.code }));
      else if (r.bytes != null) w.resolve(Buffer.from(r.bytes, 'base64'));
      else w.resolve(r.ok);
    }
  });
  const t = (cmd, args) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); p.stdin.write(JSON.stringify({ id: n, cmd, args }) + '\n'); });
  t.close = () => p.stdin.end();
  return t;
}
module.exports = { cliTransport };
