// Bundle the backend (core + Buffer/pako/md5/sha1) into one file for the window.
require('esbuild').build({
  entryPoints: [__dirname + '/entry-tauri.js'], bundle: true, minify: true, format: 'iife', target: ['chrome110', 'safari16'],
  outfile: __dirname + '/../ui/backend.js', inject: [__dirname + '/buffer-shim.js'], define: { global: 'globalThis' }, legalComments: 'none',
}).then(() => console.log('bundled')).catch((e) => { console.error(e); process.exit(1); });
