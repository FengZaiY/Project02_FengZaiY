import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chooseWindowsDirectory, createDirectoryPicker } from '../src/preview/directory-picker.mjs';
import { createServer } from '../src/server.mjs';

test('Windows picker uses a fixed hidden STA process and structured unicode results', async () => {
  const directory = 'G:\\学习 空间\\资料';
  const result = await chooseWindowsDirectory({ platform: 'win32', run: async (file, args, options) => {
    assert.ok(file.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
    assert.ok(args.includes('-STA'));
    assert.equal(args.includes('-ExecutionPolicy'), false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 600000);
    assert.equal(options.maxBuffer, 65536);
    assert.ok(Buffer.from(args.at(-1), 'base64').toString('utf16le').includes('FolderBrowserDialog'));
    return { stdout: JSON.stringify(directory) };
  } });
  assert.equal(result, directory);
  assert.equal(await chooseWindowsDirectory({ platform: 'win32', run: async () => ({ stdout: 'null\r\n' }) }), null);
  for (const stdout of ['not JSON', '"relative"', '{}', '42']) {
    await assert.rejects(chooseWindowsDirectory({ platform: 'win32', run: async () => ({ stdout }) }), { code: 'PICKER_FAILED' });
  }
  await assert.rejects(chooseWindowsDirectory({ platform: 'linux' }), { code: 'PICKER_UNSUPPORTED' });
  await assert.rejects(chooseWindowsDirectory({ platform: 'win32', run: async () => { throw new Error('failure'); } }), { code: 'PICKER_FAILED' });
});

test('picker rejects overlap, releases after cancel/failure and aborts on shutdown', async () => {
  let release;
  const picker = createDirectoryPicker(({ signal }) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'PICKER_CANCELLED' })), { once: true });
  }));
  const first = picker.choose();
  await assert.rejects(picker.choose(), { code: 'PICKER_BUSY' });
  release(null); assert.equal(await first, null);
  const controller = new AbortController(), second = picker.choose(controller.signal);
  const rejected = assert.rejects(second, { code: 'PICKER_CANCELLED' });
  controller.abort(); await rejected;
  const third = picker.choose(), stopped = assert.rejects(third, { code: 'PICKER_CANCELLED' });
  picker.close(); await stopped;
  await assert.rejects(picker.choose(), { code: 'PICKER_CLOSED' });
  let fail = true;
  const retry = createDirectoryPicker(async () => { if (fail) throw new Error('failed'); return null; });
  await assert.rejects(retry.choose(AbortSignal.abort()), { code: 'PICKER_CANCELLED' });
  await assert.rejects(retry.choose(), /failed/);
  fail = false; assert.equal(await retry.choose(), null); retry.close();
});

test('preview picker requires trusted UI authorization and never changes storage', async t => {
  const root = path.resolve('artifacts/picker-tests'); fs.mkdirSync(root, { recursive: true });
  let calls = 0, failure = false;
  const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'case-')), port: 0,
    chooseDirectory: async () => { calls++; if (failure) throw new Error('picker failed'); return null; } });
  t.after(() => app.close());
  const invoke = (headers = {}, method = 'POST') => fetch(`${app.url}/api`, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ method: 'chooseDirectory', input: { command: 'ignored' } }) } : {}) });
  assert.equal((await invoke()).status, 403);
  assert.equal((await invoke({ 'X-StudySelf-Token': 'wrong' })).status, 403);
  const authorized = { 'X-StudySelf-Token': app.token };
  assert.equal((await invoke(authorized, 'GET')).status, 403);
  assert.equal((await invoke({ ...authorized, Origin: 'https://example.com' })).status, 400);
  const invalidHost = await new Promise((resolve, reject) => {
    const request = http.request(`${app.url}/api`, { method: 'POST', headers: { ...authorized, Host: 'example.com' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(JSON.stringify({ method: 'chooseDirectory' }));
  });
  assert.equal(invalidHost, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await invoke(authorized)).json(), { value: null });
  assert.equal(calls, 1);
  failure = true; assert.equal((await invoke(authorized)).status, 400);
  failure = false; assert.deepEqual(await (await invoke(authorized)).json(), { value: null });
  assert.equal(app.service.storage.status().pending, null);
  await assert.rejects(app.service.call('chooseDirectory'), /Unknown|Unsupported|未知/);
});

test('preview closes native picker on client disconnect and server shutdown', async t => {
  const root = path.resolve('artifacts/picker-tests'); fs.mkdirSync(root, { recursive: true });
  let started, stopped;
  const begin = () => new Promise(resolve => { started = resolve; });
  const end = () => new Promise(resolve => { stopped = resolve; });
  const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'case-')), port: 0,
    chooseDirectory: ({ signal }) => new Promise((resolve, reject) => {
      started(); signal.addEventListener('abort', () => { stopped(); reject(new Error('cancelled')); }, { once: true });
    }) });
  let closed = false; t.after(async () => { if (!closed) await app.close(); });
  const invoke = signal => fetch(`${app.url}/api`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-StudySelf-Token': app.token }, body: JSON.stringify({ method: 'chooseDirectory' }) });
  const controller = new AbortController(), begun = begin(), ended = end();
  const first = invoke(controller.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  await begun;
  assert.equal((await (await invoke()).json()).error.code, 'PICKER_BUSY');
  controller.abort(); await rejected; await ended;
  const begunAgain = begin(), endedAgain = end(), second = invoke();
  await begunAgain;
  const closing = app.close(); closed = true;
  await endedAgain; assert.equal((await second).status, 400); await closing;
});
