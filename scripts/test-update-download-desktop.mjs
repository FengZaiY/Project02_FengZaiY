import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CancellationToken, CancellationError } from 'builder-util-runtime';
import { UpdateDownload } from '../src/desktop/update-download.mjs';

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
    const payload = randomBytes(512 * 1024), requests = [];
    const server = http.createServer((req, res) => {
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
    let code = 0;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}/fixture`;
      const sha512 = createHash('sha512').update(payload).digest('base64');
      const key = createHash('sha256').update(sha512).digest('hex');
      const destination = path.join(profile, 'verified.fixture');
      const options = { directory: path.join(profile, 'download-cache'), fetch: (url, init) => net.fetch(url, init), allowLoopback: true };
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
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, requests, pausedBytes, runtime: process.versions.electron }, null, 2));
      console.log('PASS: Electron net.fetch cancellation, persisted Range resume, restart from zero and SHA512 verification; no installer executed.');
    } catch (error) { console.error(error); code = 1; }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      app.exit(code);
    }
  });
}
