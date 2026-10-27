import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call as mcpCall } from '../skills/studyself-organize/scripts/client.mjs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageLocation } from '../src/core/storage-location.mjs';
import { Service } from '../src/core/service.mjs';
import { createServer } from '../src/server.mjs';
import { uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/storage-tests');
fs.mkdirSync(root, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(root, 'case-'));
async function setup(t) {
  const base = temp(), anchor = path.join(base, 'original');
  let location = new StorageLocation(anchor), service = await location.open();
  const close = () => { service?.close(); location.close(); };
  t.after(close);
  return { base, anchor, get service() { return service; }, get location() { return location; }, close,
    async restart() { close(); location = new StorageLocation(anchor); service = await location.open(); return service; } };
}

test('migration preserves all revisions, attachments, drafts, local links and credentials; restart remembers location', async t => {
  const app = await setup(t), store = app.service.store;
  const library = store.saveLibrary({ title: '迁移测试知识库' });
  const first = store.write({ type: 'note', data: { title: '原笔记', domain: library.id, content: '第一版' } });
  store.write({ id: first.id, parents: first.heads, type: 'note', data: { ...first.data, content: '第二版' } });
  store.local('workspace', { tabs: [{ id: uuid(), recordId: first.id, scroll: 240 }], domain: library.id });
  const file = path.join(app.anchor, 'fixture.txt'); fs.writeFileSync(file, 'local attachment');
  const asset = await app.service.call('assetImport', { path: file, domain: library.id });
  store.local('localFileLinks', { local: file, external: path.join(app.base, 'outside.txt') });
  store.local('materialMigration', { rows: [{ id: asset.id, source: file, target: store.assetLocation(asset.id).path }], state: 'pending', done: [], errors: [] });
  store.setSecret('pairing', 'test-only-secret');
  const grant = app.service.agents.createGrant({ name: '测试', domains: [library.id] });
  const originalEvents = store.allEvents(), deviceId = store.deviceId;
  const target = path.join(app.base, '迁移 目标');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target });
  assert.equal(app.service.store.directory, app.anchor);
  assert.equal(fs.existsSync(target), false);
  await app.restart();
  assert.equal(app.service.store.directory, target);
  assert.equal(app.service.store.deviceId, deviceId);
  assert.deepEqual(app.service.store.allEvents(), originalEvents);
  assert.equal(app.service.store.secret('pairing'), 'test-only-secret');
  assert.equal(app.service.agents.grants()[0].id, grant.id);
  assert.equal(app.service.store.local('workspace').tabs[0].scroll, 240);
  assert.equal(fs.readFileSync(app.service.store.assetLocation(asset.id).path, 'utf8'), 'local attachment');
  assert.ok(app.service.store.assetLocation(asset.id).path.startsWith(target));
  assert.equal(app.service.store.local('localFileLinks').local, path.join(target, 'fixture.txt'));
  assert.equal(app.service.store.local('localFileLinks').external, path.join(app.base, 'outside.txt'));
  assert.equal(app.service.store.local('materialMigration').rows[0].source, path.join(target, 'fixture.txt'));
  assert.ok(app.service.store.local('materialMigration').rows[0].target.startsWith(target));
  assert.ok(fs.existsSync(path.join(app.anchor, 'knowledge.sqlite')));
  await app.restart();
  assert.equal(app.service.store.directory, target);
  assert.equal(app.service.store.history(first.id).length, 2);
});

test('old migration copy requires separate confirmation, preserves extras and never touches current workspace', async t => {
  const app = await setup(t), library = app.service.store.saveLibrary({ title: '旧副本测试' });
  const note = app.service.store.write({ type: 'note', data: { title: '笔记', domain: library.id, content: '保留在新目录' } });
  await app.service.organizeLocal();
  fs.writeFileSync(path.join(app.anchor, 'user-extra.txt'), 'not managed');
  const target = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target }); await app.restart();
  const plan = await app.service.call('storagePreviousPreview');
  await assert.rejects(app.service.call('storagePreviousClean', { token: plan.token }), /单独明确确认/);
  assert.ok(fs.existsSync(path.join(app.anchor, 'knowledge.sqlite')));
  await assert.rejects(app.service.call('storagePreviousClean', { token: 'stale', confirmed: true }), /已变化/);
  await app.service.call('storagePreviousClean', { token: plan.token, confirmed: true });
  assert.equal(fs.existsSync(path.join(app.anchor, 'knowledge.sqlite')), false);
  assert.equal(fs.readFileSync(path.join(app.anchor, 'user-extra.txt'), 'utf8'), 'not managed');
  assert.equal(app.service.store.get(note.id).data.content, '保留在新目录');
});

test('old copy with unsynchronized later changes cannot be removed', async t => {
  const app = await setup(t), target = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target }); await app.restart();
  const old = new Service(app.anchor);
  old.store.write({ type: 'note', data: { title: '仅在旧目录', content: '保护新修改', domain: 'temporary' } });
  await old.close();
  await assert.rejects(app.service.call('storagePreviousPreview'), /当前工作区没有的修改/);
  assert.ok(fs.existsSync(path.join(app.anchor, 'knowledge.sqlite')));
});

test('old migration copy with unsaved edits cannot be removed', async t => {
  const app = await setup(t), target = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target }); await app.restart();
  const old = new Service(app.anchor);
  old.store.local('workspace', { tabs: [{ dirty: true, draft: { content: 'keep old unsaved edit' } }] });
  await old.close();
  await assert.rejects(app.service.call('storagePreviousPreview'), /未保存编辑/);
  assert.ok(fs.existsSync(path.join(app.anchor, 'knowledge.sqlite')));
});

test('directory plans reject overlap, nonempty targets, missing workspaces, invalid paths and unsaved tabs', async t => {
  const app = await setup(t), target = path.join(app.base, 'target');
  for (const directory of [app.anchor, path.join(app.anchor, 'nested'), app.base, 'relative', '\\\\server\\share']) {
    await assert.rejects(app.service.call('storageInspect', { mode: 'migrate', directory }));
  }
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'do not replace');
  await assert.rejects(app.service.call('storageSchedule', { mode: 'migrate', directory: target }), /空文件夹/);
  await assert.rejects(app.service.call('storageInspect', { mode: 'open', directory: path.join(app.base, 'missing') }), /没有 FengZai·Y/);
  assert.equal(fs.existsSync(path.join(app.base, 'missing')), false);
  app.service.store.local('workspace', { tabs: [{ dirty: true, draft: { content: 'keep me' } }] });
  await assert.rejects(app.service.call('storageSchedule', { mode: 'migrate', directory: path.join(app.base, 'empty') }), /未保存/);
  assert.equal(app.service.store.local('workspace').tabs[0].draft.content, 'keep me');
  app.service.store.local('workspace', { tabs: [] });
  app.service.store.local('syncFolder', path.join(app.base, 'sync'));
  app.service.store.local('backups', [{ directory: path.join(app.base, 'backups', 'archive') }]);
  for (const directory of [path.join(app.base, 'sync'), path.join(app.base, 'sync', 'data'), path.join(app.base, 'backups')]) {
    await assert.rejects(app.service.call('storageInspect', { mode: 'migrate', directory }), /不能互相包含/);
  }
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'do not replace');
});

test('pending changes are cancellable and repeated scheduling never copies data', async t => {
  const app = await setup(t), directory = path.join(app.base, 'target');
  for (let i = 0; i < 2; i++) await app.service.call('storageSchedule', { mode: 'migrate', directory });
  assert.equal(fs.existsSync(directory), false);
  await app.service.call('storageCancel'); await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
  assert.equal(app.location.status().pending, null);
});

test('directory aliases and targets changed after confirmation cannot bypass storage boundaries', async t => {
  const app = await setup(t), outside = path.join(app.base, 'outside'), alias = path.join(app.base, 'alias');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(app.service.call('storageInspect', { mode: 'migrate', directory: alias }), /Symbolic/);
  assert.deepEqual(fs.readdirSync(outside), []);
  const directory = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory });
  app.service.store.local('syncFolder', directory);
  await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
  assert.match(app.location.status().error, /同步目录/);
  assert.equal(fs.existsSync(directory), false);
});

test('target changes, copy failure and incomplete snapshots leave original usable', async t => {
  const app = await setup(t), target = path.join(app.base, 'target');
  const note = app.service.store.write({ type: 'note', data: { title: '保留' } });
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target });
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'not empty');
  await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
  assert.match(app.location.status().error, /空文件夹/);
  const failed = path.join(app.base, 'failed');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: failed });
  const original = fs.promises.copyFile;
  fs.promises.copyFile = async () => { throw new Error('simulated disk full'); };
  try { await app.restart(); } finally { fs.promises.copyFile = original; }
  assert.equal(app.service.store.get(note.id).data.title, '保留');
  assert.match(app.location.status().error, /disk full/);
  assert.ok(fs.existsSync(path.join(failed, '.studyself-incomplete.json')));
  await assert.rejects(app.service.call('storageInspect', { mode: 'open', directory: failed }), /未完成迁移/);
});

test('existing workspace open is explicit, isolated, persistent and refuses concurrent ownership', async t => {
  const app = await setup(t), target = path.join(app.base, 'other');
  const other = new Service(target);
  const note = other.store.write({ type: 'note', data: { title: '另一工作区' } });
  await assert.rejects(app.service.call('storageInspect', { mode: 'open', directory: target }), /正在被另一个实例/);
  assert.throws(() => new Service(app.anchor), /正在被另一个实例/);
  other.close();
  assert.equal((await app.service.call('storageInspect', { mode: 'open', directory: target })).counts.library, 1);
  await app.service.call('storageSchedule', { mode: 'open', directory: target });
  const busy = new Service(target);
  await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
  assert.match(app.location.status().error, /正在被另一个实例/);
  busy.close();
  await app.service.call('storageSchedule', { mode: 'open', directory: target });
  await app.restart();
  assert.equal(app.service.store.get(note.id).data.title, '另一工作区');
  assert.equal(app.service.store.directory, target);
});

test('missing selected database is an error, never a silently initialized blank workspace', async t => {
  const app = await setup(t), target = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory: target });
  await app.restart(); app.close();
  fs.renameSync(path.join(target, 'knowledge.sqlite'), path.join(target, 'held.sqlite'));
  await assert.rejects(new StorageLocation(app.anchor).open(), /没有 FengZai·Y/);
  assert.equal(fs.existsSync(path.join(target, 'knowledge.sqlite')), false);
});

test('first launch rejects incomplete, corrupt and differently encrypted existing workspaces', async t => {
  const app = await setup(t), other = path.join(app.base, 'other');
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, '.studyself-incomplete.json'), '{}');
  await assert.rejects(new StorageLocation(other).open(), /未完成迁移/);
  assert.equal(fs.existsSync(path.join(other, 'knowledge.sqlite')), false);
  const corrupt = path.join(app.base, 'corrupt'); fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, 'device-vault.key'), 'fixture');
  fs.writeFileSync(path.join(corrupt, 'knowledge.sqlite'), 'not a database');
  await assert.rejects(new StorageLocation(corrupt).open());
  assert.equal(fs.readFileSync(path.join(corrupt, 'knowledge.sqlite'), 'utf8'), 'not a database');
  app.close();
  await assert.rejects(new StorageLocation(app.anchor, { environment: 'desktop' }).open(), /加密环境不同/);
});

test('configuration write failure never switches away from the original workspace', async t => {
  const app = await setup(t), directory = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory });
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === `${app.anchor}.storage.json` && JSON.parse(fs.readFileSync(from, 'utf8')).directory === directory) throw new Error('simulated settings disk full');
    return original(from, to);
  };
  try { await app.restart(); } finally { fs.renameSync = original; }
  assert.equal(app.service.store.directory, app.anchor);
  assert.match(app.location.status().error, /settings disk full/);
  await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
});

test('persistent settings write failure still opens the intact source and reports the error', async t => {
  const app = await setup(t), directory = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory });
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === `${app.anchor}.storage.json`) throw new Error('simulated read-only settings');
    return original(from, to);
  };
  try { await app.restart(); } finally { fs.renameSync = original; }
  assert.equal(app.service.store.directory, app.anchor);
  assert.match(app.location.status().error, /无法保存启动配置/);
  await app.service.call('storageCancel');
  await app.restart();
  assert.equal(app.service.store.directory, app.anchor);
});

test('migration snapshot includes WAL commits and preserves the original database', async t => {
  const app = await setup(t), dbFile = path.join(app.anchor, 'knowledge.sqlite');
  const reader = new DatabaseSync(dbFile, { readOnly: true });
  reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM events').get();
  const note = app.service.store.write({ type: 'note', data: { title: 'WAL 中的新版本' } });
  const directory = path.join(app.base, 'target');
  await app.service.call('storageSchedule', { mode: 'migrate', directory });
  try { await app.restart(); } finally { reader.close(); }
  assert.equal(app.service.store.get(note.id).data.title, 'WAL 中的新版本');
});

test('local HTTP exposes storage controls only to authorized UI, not external Agent RPC', async t => {
  const anchor = path.join(temp(), 'data'), app = await createServer({ directory: anchor, port: 0 });
  t.after(() => app.close());
  const body = JSON.stringify({ method: 'storageStatus' });
  const denied = await fetch(`${app.url}/api`, { method: 'POST', body });
  assert.equal(denied.status, 403);
  const response = await fetch(`${app.url}/api`, { method: 'POST', headers: { 'X-StudySelf-Token': app.token }, body });
  assert.equal((await response.json()).value.directory, anchor);
  const library = app.service.store.saveLibrary({ title: '接口权限测试' });
  const grant = app.service.agents.createGrant({ name: '测试', domains: [library.id] });
  await app.service.agents.configure(true);
  const external = await fetch(`${app.service.agents.status().url}/v1/rpc`, { method: 'POST',
    headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body });
  assert.notEqual(external.status, 200);
  assert.ok(!(await external.text()).includes(anchor));
  await assert.rejects(mcpCall('storageStatus', {}, undefined,
    { STUDYSELF_AGENT_URL: app.service.agents.status().mcpUrl, STUDYSELF_AGENT_TOKEN: grant.token }), /FORBIDDEN/);
});
