import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mediaResponse } from './core/media.mjs';
import { StorageLocation } from './core/storage-location.mjs';
import { createDirectoryPicker } from './preview/directory-picker.mjs';
import { check, prettyError, uuid } from './core/util.mjs';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export async function createServer({ directory = path.join(project, '.local', 'preview'), port = 4317, chooseDirectory } = {}) {
  const storage = new StorageLocation(directory);
  const service = await storage.open();
  directory = service.store.directory;
  const token = randomBytes(32).toString('hex');
  const assets = path.join(project, 'dist');
  const picker = createDirectoryPicker(chooseDirectory);
  const server = http.createServer(async (req, res) => {
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      check(req.headers.host === expected || req.headers.host === `localhost:${server.address().port}`, 'Invalid local host');
      if (req.headers.origin) check([`http://${expected}`, `http://localhost:${server.address().port}`].includes(req.headers.origin), 'Cross-origin requests are not accepted');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      const url = new URL(req.url, `http://${expected}`);
      if (url.pathname.startsWith('/media/')) {
        check(url.searchParams.get('token') === token, 'Local request authorization failed', 'UNAUTHORIZED');
        const response = await mediaResponse(service.store, url.pathname.slice(7), req.headers.range, req.method);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) { const stream = Readable.fromWeb(response.body); res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); }
        else res.end();
        return;
      }
      if (url.pathname === '/api' || url.pathname === '/upload') {
        check(req.method === 'POST' && req.headers['x-studyself-token'] === token, 'Local request authorization failed', 'UNAUTHORIZED');
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          check(size <= (url.pathname === '/upload' ? 128 * 1024 * 1024 : 4 * 1024 * 1024), 'Request is too large');
          chunks.push(chunk);
        }
        let value;
        if (url.pathname === '/upload') {
          const name = decodeURIComponent(String(req.headers['x-filename'] || 'attachment.bin'));
          check(name === path.basename(name) && !/[\\/\0]/.test(name), 'Invalid upload filename');
          const temp = path.join(directory, 'incoming', uuid(), name);
          fs.mkdirSync(path.dirname(temp), { recursive: true });
          try {
            fs.writeFileSync(temp, Buffer.concat(chunks));
            value = await service.call('assetImport', { path: temp, expectedId: url.searchParams.get('expectedId') || undefined,
              duplicateMode: url.searchParams.get('duplicateMode') || 'reuse',
              domain: url.searchParams.get('domain') || '通用', folderId: url.searchParams.get('folderId') || undefined });
          } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
            fs.rmdirSync(path.dirname(temp));
          }
        } else {
          const { method, input } = JSON.parse(Buffer.concat(chunks).toString());
          if (method === 'chooseDirectory') {
            const controller = new AbortController(), cancel = () => controller.abort();
            res.once('close', cancel);
            try { value = await picker.choose(controller.signal); }
            finally { res.removeListener('close', cancel); }
          } else value = await service.call(method, input);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ value }));
        return;
      }
      check(req.method === 'GET', 'Unsupported request method');
      const staticNames = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/app.js', 'app.js'], ['/app.js.map', 'app.js.map'],
        ['/docx-worker.js', 'docx-worker.js'], ['/style.css', 'style.css']]);
      const generated = /^\/(?:app\.css|fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(url.pathname) ? url.pathname.slice(1) : undefined;
      const name = staticNames.get(url.pathname) || generated;
      if (!name) { res.writeHead(404); res.end('Not found'); return; }
      let data = fs.readFileSync(path.join(assets, name));
      if (name === 'index.html') data = Buffer.from(data.toString().replace('__LOCAL_TOKEN__', token));
      const mime = name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : name.endsWith('.ttf') ? 'font/ttf' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/json';
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(data);
    } catch (error) {
      if (res.destroyed) return;
      res.writeHead(error.code === 'UNAUTHORIZED' ? 403 : error.code === 'CONFLICT' ? 409 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: prettyError(error) }));
    }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { service.close(); storage.close(); throw error; }
  service.startTimer();
  await service.agents.resume();
  return { server, service, token, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { picker.close(); await new Promise(resolve => server.close(resolve)); await service.close(); storage.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createServer({ port: Number(process.env.PORT || 4317), directory: process.env.STUDYSELF_DATA || undefined });
  console.log(`FengZai·Y preview: ${app.url}`);
  console.log(`Local data: ${app.service.store.directory}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
