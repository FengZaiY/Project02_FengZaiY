import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { makePairingKey } from '../src/core/transport.mjs';
import { sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/sync-disconnect');
fs.mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const services = [];
  const open = name => { const service = new Service(path.join(directory, name)); services.push(service); return service; };
  const a = open('A'), b = open('B'), folder = path.join(directory, 'cloud'), key = makePairingKey();
  await a.call('syncConfigure', { folder, key });
  await b.call('syncConfigure', { folder, key });
  t.after(async () => { for (const service of services) await service.close(); });
  return { a, b, folder, key, directory, open };
}
const tree = directory => fs.readdirSync(directory, { recursive: true }).sort().flatMap(name => {
  const file = path.join(directory, name); return fs.statSync(file).isFile() ? [[name, sha(fs.readFileSync(file))]] : [];
});

test('disconnect preserves knowledge, originals, dirty tabs, remote files and roles; reconnect merges offline edits', async t => {
  const f = await fixture(t), { a, b, folder, key } = f;
  const library = await a.call('librarySave', { title: '隔离资料' });
  const note = await a.call('save', { type: 'note', data: { title: '保留笔记', domain: library.data.domain, content: '原正文' } });
  const file = path.join(f.directory, 'original.txt'); fs.writeFileSync(file, 'original content');
  const asset = await a.call('assetImport', { path: file, domain: library.data.domain });
  await a.call('deviceSetPrimary', { deviceId: a.store.deviceId, parents: [], confirmed: true });
  await a.call('syncPublish'); await b.call('syncImport'); await b.call('syncPublish');
  const history = b.store.allEvents(), control = b.transport.control(), files = tree(folder);
  const localPath = b.store.assetLocation(asset.id).path;
  const draft = { tabs: [{ id: 'dirty-tab', dirty: true, draft: { content: '尚未保存' } }] };
  b.store.local('workspace', draft);
  const preview = await b.call('syncDisconnectPreview');
  assert.equal(preview.primary, false);
  const request = { confirmed: true, token: preview.token };
  assert.equal((await b.call('syncDisconnect', request)).configured, false);
  assert.equal((await b.call('syncDisconnect', request)).configured, false, 'retry is harmless');
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM local_config WHERE key IN ('secret:pairing','syncFolder')").get().n, 0);
  assert.deepEqual(b.store.allEvents(), history);
  assert.deepEqual(b.transport.control(), control);
  assert.deepEqual(b.store.local('workspace'), draft);
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'original content');
  assert.deepEqual(tree(folder), files);
  assert.equal(a.transport.config().configured, true);
  await assert.rejects(b.call('syncScan'), /配置/);
  await assert.rejects(b.call('syncImport'), /未保存/);
  b.store.local('workspace', { tabs: [] });
  await assert.rejects(b.call('syncImport'), /配置/);
  await assert.rejects(b.call('syncPublish'), /配置/);
  const offline = await b.call('save', { id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '离线修改' } });
  await b.close();
  const reopened = f.open('B');
  assert.equal(reopened.transport.config().configured, false);
  assert.equal(reopened.store.get(note.id).data.content, offline.data.content);
  await reopened.call('syncConfigure', { folder, key });
  assert.deepEqual(reopened.transport.control(), control);
  await reopened.call('syncPublish'); await a.call('syncImport');
  assert.equal(a.store.get(note.id).data.content, '离线修改');
  assert.equal(a.store.list({ type: 'note' }).length, 1);
});

test('disconnect requires confirmation, rejects stale configuration and busy operations, cancels frozen jobs atomically', async t => {
  const { a, folder, key } = await fixture(t);
  await a.call('syncPlan');
  const oldPlan = a.transport.value('plan').manifest.id;
  const preview = await a.call('syncDisconnectPreview');
  assert.equal(preview.cancelTask, true);
  await assert.rejects(a.call('syncDisconnect', { token: preview.token }), /确认/);
  a.transport.running = true;
  await assert.rejects(a.call('syncDisconnect', { token: preview.token, confirmed: true }), { code: 'BUSY' });
  a.transport.running = false;
  await a.call('syncPause');
  await assert.rejects(a.call('syncDisconnect', { token: preview.token, confirmed: true }), { code: 'CONFLICT' });
  const paused = await a.call('syncDisconnectPreview');
  a.store.db.exec("CREATE TRIGGER fail_disconnect BEFORE DELETE ON local_config WHEN OLD.key='syncFolder' BEGIN SELECT RAISE(ABORT, 'injected disconnect failure'); END");
  await assert.rejects(a.call('syncDisconnect', { token: paused.token, confirmed: true }), /injected/);
  assert.equal(a.store.secret('pairing'), key);
  assert.equal(a.transport.progress().state, 'paused');
  a.store.db.exec('DROP TRIGGER fail_disconnect');
  await a.call('syncDisconnect', { token: paused.token, confirmed: true });
  await a.call('syncConfigure', { folder, key });
  assert.equal(a.transport.progress().state, 'cancelled');
  await assert.rejects(a.call('syncDisconnect', { token: paused.token, confirmed: true }), { code: 'CONFLICT' });
  const beforeConfigure = await a.call('syncDisconnectPreview');
  await a.call('syncConfigure', { folder, key });
  await assert.rejects(a.call('syncDisconnect', { token: beforeConfigure.token, confirmed: true }), { code: 'CONFLICT' });
  await a.call('syncPlan');
  assert.notEqual(a.transport.value('plan').manifest.id, oldPlan);
});

test('disconnect remains local for primary and suspended devices and is unavailable to external agents', async t => {
  const { a, b, folder, key } = await fixture(t);
  await a.call('syncPublish'); await b.call('syncImport'); await b.call('syncPublish'); await a.call('syncImport');
  await a.call('deviceSetPrimary', { deviceId: a.store.deviceId, parents: [], confirmed: true });
  const primary = await a.call('syncDisconnectPreview');
  assert.equal(primary.primary, true);
  await a.call('syncDisconnect', { confirmed: true, token: primary.token });
  assert.equal(a.transport.devices().primary, a.store.deviceId, 'disconnect does not invent a shared role transition');
  await a.call('syncConfigure', { folder, key });
  await a.call('deviceManage', { deviceId: b.store.deviceId, action: 'suspend', revision: a.transport.devices().revision, requestId: uuid(), confirmed: true });
  await a.call('syncPublish'); await b.call('syncImport');
  assert.equal(b.transport.devices().devices.find(item => item.local).suspended, true);
  await b.call('syncDisconnect', { confirmed: true, token: (await b.call('syncDisconnectPreview')).token });
  await b.call('syncConfigure', { folder, key });
  await assert.rejects(b.call('syncPublish'), { code: 'FORBIDDEN' });
  const grant = b.agents.createGrant({ name: 'isolated test' });
  for (const method of ['syncDisconnect', 'syncDisconnectPreview']) {
    assert.throws(() => b.agents.dispatch(grant, { method }), { code: 'FORBIDDEN' });
  }
});

test('disconnect preserves receive checkpoints and refuses while imports or directory maintenance are active', async t => {
  const { b } = await fixture(t);
  const checkpoint = { hash: 'a'.repeat(64), bytes: 10, size: 20, path: 'isolated-partial' };
  b.store.local('v3Receive:isolated', checkpoint);
  b.imports.add(Promise.resolve());
  await assert.rejects(b.call('syncDisconnectPreview'), { code: 'BUSY' });
  b.imports.clear(); b.localTask = Promise.resolve();
  await assert.rejects(b.call('syncDisconnectPreview'), { code: 'BUSY' });
  b.localTask = null;
  const preview = await b.call('syncDisconnectPreview');
  await b.call('syncDisconnect', { confirmed: true, token: preview.token });
  assert.deepEqual(b.store.local('v3Receive:isolated'), checkpoint);
});
