import { build } from 'esbuild';
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, outfile: 'dist/app.js', platform: 'browser',
  format: 'esm', target: 'chrome136', minify: true, sourcemap: true,
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]' });
fs.copyFileSync('web/index.html', 'dist/index.html');
fs.copyFileSync('web/style.css', 'dist/style.css');
console.log('Built desktop and browser interface.');
