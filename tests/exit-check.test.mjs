import test from 'node:test';
import assert from 'node:assert/strict';
import { ExitCheck, exitActivity } from '../src/desktop/exit-check.mjs';

test('exit requires a current acknowledged renderer request and fresh clean state', () => {
  let state = { dirty: false, busy: '' }, closed = 0; const requests = [];
  const check = new ExitCheck({ send: request => requests.push(request), inspect: () => state, finish: () => closed++, unavailable() {} });
  try {
    check.begin(); check.begin(); assert.equal(requests.length, 1);
    const id = requests[0].id;
    assert.throws(() => check.accept({ id, rendererReady: true }), /退出检查/);
    check.status(id);
    assert.throws(() => check.accept({ id: 'wrong', rendererReady: true }), /退出检查/);
    state = { dirty: true, busy: '' };
    assert.throws(() => check.accept({ id, rendererReady: true }), /未保存/);
    state = { dirty: false, busy: '导入中' };
    assert.throws(() => check.accept({ id, rendererReady: true }), /导入中/);
    assert.equal(closed, 0);
    check.cancel(id); check.begin(); assert.notEqual(requests[1].id, id);
    assert.throws(() => check.status(id), /失效/);
    state = { dirty: false, busy: '' };
    const next = requests[1].id; check.status(next); check.accept({ id: next, rendererReady: true });
    assert.equal(closed, 1);
    assert.throws(() => check.accept({ id: next, rendererReady: true }), /退出检查/);
  } finally { check.dispose(); }
});

test('an unresponsive renderer times out without exiting; acknowledgement stops the timeout', async () => {
  let request, warnings = 0, closed = 0;
  const check = new ExitCheck({ send: value => { request = value; }, inspect: () => ({}), finish: () => closed++, unavailable: () => warnings++, timeout: 10 });
  try {
    check.begin(); const first = request.id;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(warnings, 1); assert.equal(closed, 0);
    assert.throws(() => check.status(first), /失效/);
    check.begin(); check.status(request.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(warnings, 1); assert.equal(closed, 0);
  } finally { check.dispose(); }
});

test('background writes block exit while idle saved work does not require publishing', () => {
  const service = { transport: { running: false }, imports: new Set(), store: {}, agents: {} };
  assert.equal(exitActivity(service, 1), '');
  service.transport.running = true; assert.match(exitActivity(service), /同步/); service.transport.running = false;
  service.localTask = {}; assert.match(exitActivity(service), /整理/); service.localTask = null;
  service.imports.add({}); assert.match(exitActivity(service), /导入/); service.imports.clear();
  service.store.activeAssetReads = new Map([['asset', 1]]); assert.match(exitActivity(service), /读取/); service.store.activeAssetReads.clear();
  assert.match(exitActivity(service, 2), /操作/);
});

test('storage restart requires the same handshake, final activity check and completed shutdown', async () => {
  let request, resolveClose, started = 0, busy = '';
  const check = new ExitCheck({ send: value => { request = value; }, inspect: () => ({ dirty: false, busy }), unavailable() {},
    finish: intent => { assert.equal(intent, 'storage-restart'); started++; return new Promise(resolve => { resolveClose = resolve; }); } });
  try {
    check.begin('storage-restart'); assert.equal(request.intent, 'storage-restart');
    assert.throws(() => check.accept({ id: request.id, rendererReady: true }), /退出检查/);
    check.status(request.id); busy = '导入中';
    assert.throws(() => check.accept({ id: request.id, rendererReady: true }), /导入中/); assert.equal(started, 0);
    busy = ''; const closing = check.accept({ id: request.id, rendererReady: true });
    assert.equal(started, 1); assert.equal(check.request.finishing, true);
    assert.throws(() => check.accept({ id: request.id, rendererReady: true }), /正在完成/);
    resolveClose(); assert.equal(await closing, true); assert.equal(check.request, null);
  } finally { check.dispose(); }
});

test('a destroyed renderer cannot turn a failed status request into an exit', () => {
  let warned = false;
  const check = new ExitCheck({ send: () => { throw new Error('destroyed'); }, inspect: () => ({}),
    finish: () => assert.fail('must stay open'), unavailable: () => { warned = true; } });
  check.begin(); assert.equal(warned, true); assert.equal(check.request, null); check.dispose();
});
