import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { CancellationToken, CancellationError } from 'builder-util-runtime';
import { UpdateDownload } from '../src/desktop/update-download.mjs';

async function fixture(t) {
  const root = path.resolve('artifacts/update-resume'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'case-')), payload = randomBytes(512 * 1024), requests = [];
  let mode = 'range';
  const server = http.createServer((req, res) => {
    const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    requests.push(start);
    if (mode === '416' && start) { res.writeHead(416); res.end(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'file:///private' }); res.end(); return; }
    if (mode === 'network') { res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 4096)); setTimeout(() => res.destroy(), 30); return; }
    const offset = mode === 'ignore' ? 0 : start;
    const headers = { 'Content-Length': payload.length - offset };
    if (offset) headers['Content-Range'] = `bytes ${mode === 'bad-range' ? offset + 1 : offset}-${payload.length - 1}/${payload.length}`;
    res.writeHead(offset ? 206 : 200, headers);
    let sent = offset;
    const timer = setInterval(() => {
      const end = Math.min(sent + 16384, payload.length); res.write(payload.subarray(sent, end)); sent = end;
      if (sent === payload.length) { clearInterval(timer); res.end(); }
    }, 15);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/fixture.exe`, sha512 = createHash('sha512').update(payload).digest('base64');
  const key = createHash('sha256').update(sha512).digest('hex'), options = { directory: path.join(directory, 'resume'), fetch, allowLoopback: true };
  const transfer = new UpdateDownload(options), destination = path.join(directory, 'verified.fixture');
  const request = (onProgress = () => {}) => ({ sha512, cancellationToken: new CancellationToken(), onProgress });
  async function partial() {
    const input = request(progress => { if (progress.transferred >= 32768) input.cancellationToken.cancel(); });
    await assert.rejects(transfer.download(url, destination, input), CancellationError);
    const size = fs.statSync(transfer.file(key)).size;
    assert.ok(size > 0 && size < payload.length); assert.equal(fs.existsSync(destination), false);
    return size;
  }
  return { transfer, options, destination, url, payload, key, requests, request, partial, directory, mode: value => { mode = value; } };
}

test('pause closes the request and a new process resumes actual saved bytes with Range and verifies the complete file', async t => {
  const f = await fixture(t), size = await f.partial(), progress = [];
  const continued = new UpdateDownload(f.options);
  await continued.download(f.url, f.destination, f.request(value => progress.push(value)));
  assert.equal(f.requests.at(-1), size);
  assert.equal(progress[0].transferred, size);
  assert.deepEqual(fs.readFileSync(f.destination), f.payload);
  assert.equal(fs.existsSync(continued.file(f.key)), false);
});

test('ignored or rejected Range responses restart from zero without appending duplicate bytes', async t => {
  const f = await fixture(t);
  for (const mode of ['ignore', '416']) {
    f.mode('range'); await f.partial(); f.mode(mode);
    const progress = [];
    await f.transfer.download(f.url, f.destination, f.request(value => progress.push(value)));
    assert.equal(progress[0].transferred, 0); assert.deepEqual(fs.readFileSync(f.destination), f.payload);
    fs.unlinkSync(f.destination);
  }
});

test('wrong ranges and corrupt retained bytes never become an installable file; restart removes only the current partial', async t => {
  const f = await fixture(t), size = await f.partial();
  f.mode('bad-range'); await assert.rejects(f.transfer.download(f.url, f.destination, f.request()), /range/);
  assert.equal(fs.statSync(f.transfer.file(f.key)).size, size); assert.equal(fs.existsSync(f.destination), false);
  f.mode('range');
  const fd = fs.openSync(f.transfer.file(f.key), 'r+'); fs.writeSync(fd, Buffer.from([255, 0, 255]), 0, 3, 0); fs.closeSync(fd);
  await assert.rejects(f.transfer.download(f.url, f.destination, f.request()), /checksum/);
  assert.equal(fs.existsSync(f.transfer.file(f.key)), false); assert.equal(fs.existsSync(f.destination), false);
  await f.partial();
  const other = path.join(f.options.directory, 'unrelated.txt'); fs.writeFileSync(other, 'keep');
  await f.transfer.reset(); assert.equal(fs.existsSync(f.transfer.file(f.key)), false); assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
  await f.transfer.download(f.url, f.destination, f.request()); assert.equal(f.requests.at(-1), 0);
  assert.deepEqual(fs.readFileSync(f.destination), f.payload);
});

test('network failure keeps received bytes; cancellation before start and unsafe redirects cannot promote files', async t => {
  const f = await fixture(t); f.mode('network');
  await assert.rejects(f.transfer.download(f.url, f.destination, f.request()));
  assert.equal(fs.statSync(f.transfer.file(f.key)).size, 4096); assert.equal(fs.existsSync(f.destination), false);
  f.mode('range'); await f.transfer.download(f.url, f.destination, f.request()); assert.equal(f.requests.at(-1), 4096);
  fs.unlinkSync(f.destination);
  const cancelled = f.request(); cancelled.cancellationToken.cancel();
  await assert.rejects(f.transfer.download(f.url, f.destination, cancelled), CancellationError);
  f.mode('redirect'); await assert.rejects(f.transfer.download(f.url, f.destination, f.request()), /URL/);
  assert.equal(fs.existsSync(f.destination), false);
  const production = new UpdateDownload({ directory: path.join(f.directory, 'production'), fetch });
  await assert.rejects(production.download(f.url, f.destination, f.request()), /URL/);
});
