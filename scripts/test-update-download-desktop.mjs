import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CancellationToken, CancellationError } from 'builder-util-runtime';
import { UpdateDownload } from '../src/desktop/update-download.mjs';
import { createUpdateFetch } from '../src/desktop/update-network.mjs';

if (!process.versions.electron) {
  const { default: executable } = await import('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true, timeout: 45000 });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} else {
  const { app, net } = await import('electron');
  const root = path.resolve('artifacts/update-download-desktop');
  fs.mkdirSync(root, { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, 'profile-'));
  app.setPath('userData', profile);
  // Electron waits for its ESM entry to finish loading before emitting ready.
  void app.whenReady().then(async () => {
    const payload = randomBytes(512 * 1024), requests = [], redirects = [], crossHeaders = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/renamed') { redirects.push(req.url); res.writeHead(301, { Location: '/release' }); res.end(); return; }
      if (req.url === '/release') { redirects.push(req.url); res.writeHead(302, { Location: `http://127.0.0.1:${cdn.address().port}/fixture` }); res.end(); return; }
      if (req.url === '/unsafe') { res.writeHead(302, { Location: 'file:///private' }); res.end(); return; }
      if (req.url === '/loop') { redirects.push(req.url); res.writeHead(302, { Location: '/loop' }); res.end(); return; }
      if (req.url === '/stall') return;
      if (req.url === '/broken') {
        res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 4096));
        setTimeout(() => res.destroy(), 30); return;
      }
      const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
      requests.push(offset);
      const headers = { 'Content-Length': payload.length - offset };
      if (offset) headers['Content-Range'] = `bytes ${offset}-${payload.length - 1}/${payload.length}`;
      res.writeHead(offset ? 206 : 200, headers);
      let sent = offset;
      const timer = setInterval(() => {
        const end = Math.min(sent + 16384, payload.length);
        res.write(payload.subarray(sent, end)); sent = end;
        if (sent === payload.length) { clearInterval(timer); res.end(); }
      }, 20);
      res.on('close', () => clearInterval(timer));
    });
    const cdn = http.createServer((req, res) => {
      crossHeaders.push({ range: req.headers.range, authorization: req.headers.authorization, cookie: req.headers.cookie });
      server.emit('request', req, res);
    });
    let code = 0;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}/fixture`;
      const sha512 = createHash('sha512').update(payload).digest('base64');
      const key = createHash('sha256').update(sha512).digest('hex');
      const destination = path.join(profile, 'verified.fixture');
      const options = { directory: path.join(profile, 'download-cache'), fetch: createUpdateFetch(net), allowLoopback: true };
      let transfer = new UpdateDownload(options);
      async function pause() {
        const cancellationToken = new CancellationToken();
        await assert.rejects(transfer.download(url, destination, { sha512, cancellationToken,
          onProgress: progress => { if (progress.transferred >= 32768) cancellationToken.cancel(); } }), CancellationError);
        assert.equal(fs.existsSync(destination), false);
        const bytes = fs.statSync(transfer.file(key)).size;
        assert.ok(bytes > 0 && bytes < payload.length);
        return bytes;
      }
      const pausedBytes = await pause();
      transfer = new UpdateDownload(options);
      await transfer.download(url, destination, { sha512, cancellationToken: new CancellationToken() });
      assert.deepEqual(fs.readFileSync(destination), payload);
      fs.unlinkSync(destination);
      await pause(); await transfer.reset();
      await transfer.download(url, destination, { sha512, cancellationToken: new CancellationToken() });
      assert.deepEqual(fs.readFileSync(destination), payload);
      assert.deepEqual(requests, [0, pausedBytes, 0, 0]);
      assert.equal(fs.existsSync(transfer.file(key)), false);
      fs.unlinkSync(destination);
      const redirectUrl = url.replace('/fixture', '/renamed');
      const requestHeaders = { authorization: 'isolated-test-credential', cookie: 'isolated-test-cookie' };
      const token = new CancellationToken();
      await assert.rejects(transfer.download(redirectUrl, destination, { sha512, headers: requestHeaders, cancellationToken: token,
        onProgress: progress => { if (progress.transferred >= 32768) token.cancel(); } }), CancellationError);
      const redirectedBytes = fs.statSync(transfer.file(key)).size;
      assert.ok(redirectedBytes > 0 && redirectedBytes < payload.length);
      transfer = new UpdateDownload(options);
      await transfer.download(redirectUrl, destination, { sha512, headers: requestHeaders, cancellationToken: new CancellationToken() });
      assert.deepEqual(fs.readFileSync(destination), payload);
      assert.deepEqual(redirects, ['/renamed', '/release', '/renamed', '/release']);
      assert.equal(crossHeaders[1].range, `bytes=${redirectedBytes}-`);
      assert.ok(crossHeaders.every(item => !item.authorization && !item.cookie));
      fs.unlinkSync(destination);
      await assert.rejects(transfer.download(url.replace('/fixture', '/unsafe'), destination, { sha512, cancellationToken: new CancellationToken() }), error => error.code === 'UPDATE_URL_INVALID');
      await assert.rejects(transfer.download(url.replace('/fixture', '/loop'), destination, { sha512, cancellationToken: new CancellationToken() }), error => error.code === 'UPDATE_REDIRECT_LIMIT');
      assert.equal(redirects.filter(item => item === '/loop').length, 10);
      const cancelled = new CancellationToken(), before = redirects.length;
      const cancelledTransfer = new UpdateDownload({ ...options, fetch: async (target, init) => {
        const result = await options.fetch(target, init); cancelled.cancel(); return result;
      } });
      await assert.rejects(cancelledTransfer.download(redirectUrl, destination, { sha512, cancellationToken: cancelled }), CancellationError);
      assert.deepEqual(redirects.slice(before), ['/renamed']);
      assert.equal(fs.existsSync(destination), false);
      const waiting = new CancellationToken();
      const pending = transfer.download(url.replace('/fixture', '/stall'), destination, { sha512, cancellationToken: waiting });
      const cancelTimer = setTimeout(() => waiting.cancel(), 40);
      try { await assert.rejects(pending, CancellationError); } finally { clearTimeout(cancelTimer); }
      await assert.rejects(transfer.download(url.replace('/fixture', '/broken'), destination, { sha512, cancellationToken: new CancellationToken() }));
      assert.equal(fs.statSync(transfer.file(key)).size, 4096);
      await transfer.download(redirectUrl, destination, { sha512, cancellationToken: new CancellationToken() });
      assert.deepEqual(fs.readFileSync(destination), payload); fs.unlinkSync(destination);
      await assert.rejects(transfer.download(redirectUrl, destination, { sha512: Buffer.alloc(64).toString('base64'), cancellationToken: new CancellationToken() }), error => error.code === 'ERR_CHECKSUM_MISMATCH');
      assert.equal(fs.existsSync(destination), false);
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, requests, pausedBytes, redirectedBytes,
        redirectCount: redirects.length, credentialsStripped: true, runtime: process.versions.electron }, null, 2));
      console.log('PASS: Electron manual redirects, cross-origin credential removal, redirected Range resume, cancellation, loop/unsafe URL rejection and SHA512 verification; no installer executed.');
    } catch (error) { console.error(error); code = 1; }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      cdn.closeAllConnections(); await new Promise(resolve => cdn.close(resolve));
      app.exit(code);
    }
  });
}
