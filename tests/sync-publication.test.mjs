import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeSyncPointer } from '../src/core/sync-publication.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-pointer-'));
  const file = path.join(root, 'current-test.sscurrent');
  fs.writeFileSync(file, 'previous');
  const rename = fs.renameSync, unlink = fs.unlinkSync, open = fs.openSync;
  t.after(() => { fs.renameSync = rename; fs.unlinkSync = unlink; fs.openSync = open; });
  return { root, file, rename, unlink, open };
}
const locked = code => Object.assign(new Error('injected file contention'), { code });

test('pointer retries transient replacement errors while leaving the previous pointer readable', async t => {
  const f = fixture(t); let calls = 0; const retries = [];
  fs.renameSync = (from, to) => {
    assert.equal(fs.readFileSync(to, 'utf8'), 'previous');
    assert.equal(fs.readFileSync(from, 'utf8'), 'next');
    if (calls++ < 3) throw locked(['EPERM', 'EACCES', 'EBUSY'][calls - 1]);
    return f.rename(from, to);
  };
  await writeSyncPointer(f.file, 'next', { delays: [1, 1, 1], onRetry: value => retries.push(value) });
  assert.equal(calls, 4); assert.deepEqual(retries.map(item => item.attempt), [1, 2, 3]);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'next');
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file)]);
});

test('persistent contention is bounded and cleanup failure preserves the actionable original error', async t => {
  const f = fixture(t); let calls = 0;
  fs.renameSync = () => { calls++; throw locked('EPERM'); };
  fs.unlinkSync = () => { throw locked('EACCES'); };
  await assert.rejects(writeSyncPointer(f.file, 'next', { delays: [1, 1] }), error => {
    assert.equal(error.code, 'SYNC_FILE_BUSY'); assert.equal(error.cause.code, 'EPERM');
    assert.match(error.message, /继续发布/); assert.match(error.message, /临时交接文件暂无法清理/); return true;
  });
  assert.equal(calls, 3); assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
  assert.equal(fs.readdirSync(f.root).filter(file => file.endsWith('.partial')).length, 1);
});

test('pause interrupts backoff without replacing the old pointer; retry can finish later', async t => {
  const f = fixture(t); let paused = false, calls = 0;
  fs.renameSync = () => { calls++; throw locked('EBUSY'); };
  await assert.rejects(writeSyncPointer(f.file, 'next', { delays: [1000], shouldPause: () => paused,
    onRetry: () => { setTimeout(() => { paused = true; }, 10); } }), { code: 'PAUSED' });
  assert.equal(calls, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file)]);
  fs.renameSync = f.rename;
  await writeSyncPointer(f.file, 'next'); assert.equal(fs.readFileSync(f.file, 'utf8'), 'next');
});

test('unrelated I/O failures are not retried or classified as contention', async t => {
  const f = fixture(t); let calls = 0;
  fs.renameSync = () => { calls++; throw locked('ENOSPC'); };
  await assert.rejects(writeSyncPointer(f.file, 'next', { onRetry: () => assert.fail('Must not retry disk errors') }), { code: 'ENOSPC' });
  assert.equal(calls, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file)]);
});

test('temporary-file creation denial preserves the old pointer and identifies the write stage', async t => {
  const f = fixture(t);
  fs.openSync = (file, ...args) => { if (String(file).endsWith('.partial')) throw locked('EACCES'); return f.open(file, ...args); };
  await assert.rejects(writeSyncPointer(f.file, 'next'), error => error.code === 'SYNC_FILE_BUSY' && /临时文件/.test(error.message));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.file)]);
});

test('Windows handle without delete sharing causes a real retry and succeeds after release', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = fixture(t), literal = f.file.replaceAll("'", "''");
  const script = `$f = [IO.File]::Open('${literal}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
  const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ended = once(child, 'exit'); let retries = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Lock holder did not start')), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', data => { if (data.toString().includes('LOCKED')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Lock holder exited early: ${code}`)); });
  });
  await writeSyncPointer(f.file, 'next', { onRetry: () => { if (++retries === 1) child.stdin.end('\n'); } });
  assert.ok(retries >= 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'next');
  assert.equal((await ended)[0], 0);
});
