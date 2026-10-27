import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call as mcpCall } from '../skills/studyself-organize/scripts/client.mjs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store } from '../src/core/store.mjs';
import { StorageLocation } from '../src/core/storage-location.mjs';
import { FolderTransport, makePairingKey } from '../src/core/transport.mjs';
import { BackupManager } from '../src/core/backup.mjs';
import { sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/library-directory-tests');
fs.mkdirSync(root, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(root, 'case-'));
function setup(t) {
  const directory = temp(), service = new Service(path.join(directory, 'root'));
  t.after(() => service.close());
  return { directory, service, store: service.store };
}

test('a new library creates an owned child directory; rename/delete/restore keep stable paths', async t => {
  const { service, store } = setup(t);
  assert.equal(store.libraries().length, 0);
  const library = await service.call('librarySave', { title: '人工智能' });
  const directory = (await service.call('libraryDirectory', { id: library.id })).directory;
  assert.equal(directory, path.join(store.directory, '人工智能'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.studyself-library.json'), 'utf8')).libraryId, library.id);
  const changed = store.saveLibrary({ id: library.id, title: 'AI研究', parents: library.heads });
  assert.equal(store.directories.ensure(changed), directory);
  const deleted = store.remove(changed.id, changed.heads);
  assert.ok(fs.existsSync(directory));
  const restored = store.restoreVersion(deleted.id, changed.heads[0], deleted.heads);
  assert.equal(store.directories.ensure(restored), directory);
  const events = store.allEvents(); service.state(); service.state();
  assert.deepEqual(store.allEvents(), events);
});

test('Windows-invalid, reserved and colliding names never claim unrelated files or folders', t => {
  const { store } = setup(t);
  const occupied = path.join(store.directory, '资料');
  fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep.txt'), 'untouched');
  const record = store.saveLibrary({ title: '资料' });
  assert.notEqual(store.directories.ensure(record), occupied);
  for (const title of ['CON', 'objects', '../outside', 'A/B', 'A:B', '.hidden', 'ＡＳＳＥＴＳ']) {
    const item = store.saveLibrary({ title });
    const directory = store.directories.ensure(item);
    assert.equal(path.dirname(directory), store.directory);
    assert.equal(/[<>:"/\\|?*]/.test(path.basename(directory)), false);
    assert.ok(fs.statSync(directory).isDirectory());
  }
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(occupied, '.studyself-library.json')), false);
  assert.notEqual(store.directories.ensure(store.libraries().find(item => item.data.title === 'A/B')),
    store.directories.ensure(store.libraries().find(item => item.data.title === 'A:B')));
});

test('directory failure rolls back library creation; stale edits cannot change paths or versions', t => {
  const { store } = setup(t), old = fs.mkdirSync;
  fs.mkdirSync = function(file, ...args) { if (file === path.join(store.directory, '失败库')) throw new Error('simulated permission denied'); return old(file, ...args); };
  try { assert.throws(() => store.saveLibrary({ title: '失败库' }), /permission denied/); }
  finally { fs.mkdirSync = old; }
  assert.equal(store.libraries().length, 0);
  assert.equal(store.allEvents().length, 0);
  const item = store.saveLibrary({ title: '保留' });
  const events = store.allEvents(), mappings = store.local('libraryDirectories');
  assert.throws(() => store.saveLibrary({ id: item.id, title: '过期写入', parents: [] }), /changed|stale|基础|parent/i);
  assert.deepEqual(store.allEvents(), events);
  assert.deepEqual(store.local('libraryDirectories'), mappings);
});

test('legacy libraries get local directories without rewriting history or exposing paths to Agents', async t => {
  const { service, store } = setup(t);
  const note = store.write({ type: 'note', data: { title: '旧笔记', domain: '旧领域' } });
  const events = store.allEvents(), state = service.state(), library = state.libraries[0];
  assert.equal(library.legacy, true);
  assert.equal(path.dirname(library.localDirectory), store.directory);
  assert.deepEqual(store.allEvents(), events);
  const grant = service.agents.createGrant({ name: 'test', domains: ['旧领域'] });
  await service.agents.configure(true);
  const payload = await mcpCall('libraries', {}, undefined, { STUDYSELF_AGENT_URL: service.agents.status().mcpUrl, STUDYSELF_AGENT_TOKEN: grant.token });
  assert.ok(payload.some(item => item.id === library.id));
  assert.ok(!JSON.stringify(payload).includes(store.directory));
  assert.ok(!JSON.stringify(payload).includes('localDirectory'));
  assert.equal(store.get(note.id).data.title, '旧笔记');
});

test('tampered maps and replaced directory markers do not redirect writes outside root', async t => {
  const { directory, service, store } = setup(t);
  const library = store.saveLibrary({ title: '原库' }), saved = store.local('libraryDirectories');
  for (const invalid of ['../outside', '', '.']) {
    store.local('libraryDirectories', { [library.id]: invalid });
    await assert.rejects(service.call('libraryDirectory', { id: library.id }), /映射无效/);
  }
  assert.ok(service.state().libraries[0].directoryError);
  assert.equal(fs.existsSync(path.join(directory, 'outside')), false);
  const alias = path.join(store.directory, 'alias');
  fs.symlinkSync(path.join(store.directory, saved[library.id]), alias, process.platform === 'win32' ? 'junction' : 'dir');
  store.local('libraryDirectories', { [library.id]: 'alias' });
  await assert.rejects(service.call('libraryDirectory', { id: library.id }), /Symbolic/);
  store.local('libraryDirectories', saved);
  const marker = path.join(store.directory, saved[library.id], '.studyself-library.json');
  fs.writeFileSync(marker, JSON.stringify({ format: 1, libraryId: uuid() }));
  await assert.rejects(service.call('libraryDirectory', { id: library.id }), /替换|标识/);
  assert.equal(service.state().libraries[0].data.title, '原库');
});

test('new local and Agent uploads use content-addressed originals with distinct cross-library identities', async t => {
  const { directory, service, store } = setup(t);
  const a = store.saveLibrary({ title: '甲库' }), b = store.saveLibrary({ title: '乙库' });
  const file = path.join(directory, 'document.txt'); fs.writeFileSync(file, 'same bytes');
  const aa = await service.call('assetImport', { path: file, domain: a.id });
  const bb = await service.call('assetImport', { path: file, domain: b.id });
  const aPath = store.assetLocation(aa.id).path, bPath = store.assetLocation(bb.id).path;
  assert.equal(aPath, bPath); assert.notEqual(aa.id, bb.id);
  assert.equal(aa.data.domain, a.id); assert.equal(bb.data.domain, b.id);
  assert.ok(aPath.startsWith(path.join(store.directory, '.fengzai-y', 'materials')));
  const grant = service.agents.createGrant({ name: 'test', domains: [a.id] });
  await service.agents.configure(true);
  const bytes = Buffer.from('agent-upload');
  const result = await mcpCall('assetWrite', { domain: a.id, filename: 'agent.txt', data: bytes.toString('base64'), sha256: sha(bytes), preferencesVersion: service.agents.preferences().version }, uuid(),
    { STUDYSELF_AGENT_URL: service.agents.status().mcpUrl, STUDYSELF_AGENT_TOKEN: grant.token });
  assert.ok(store.assetLocation(result.id).path.startsWith(path.join(store.directory, '.fengzai-y', 'materials')));
});

test('library folders and local mappings survive selecting a new root and restarting', async t => {
  const base = temp(), anchor = path.join(base, 'root'), target = path.join(base, 'target');
  let location = new StorageLocation(anchor), service = await location.open();
  t.after(() => { service.close(); location.close(); });
  const library = service.store.saveLibrary({ title: '迁移的库' });
  const file = path.join(base, 'fixture.txt'); fs.writeFileSync(file, 'keep bytes');
  const asset = await service.call('assetImport', { path: file, domain: library.id });
  const inspected = await service.call('storageInspect', { mode: 'select', directory: target });
  assert.equal(inspected.mode, 'migrate');
  await service.call('storageSchedule', inspected);
  service.close(); location.close(); location = new StorageLocation(anchor); service = await location.open();
  const moved = (await service.call('libraryDirectory', { id: library.id })).directory;
  assert.equal(moved, path.join(target, '迁移的库'));
  assert.equal(fs.readFileSync(service.store.assetLocation(asset.id).path, 'utf8'), 'keep bytes');
  assert.ok(service.store.assetLocation(asset.id).path.startsWith(path.join(target, '.fengzai-y', 'materials')));
  const subsequent = service.store.saveLibrary({ title: '迁移后新建' });
  assert.equal(path.dirname(service.store.directories.ensure(subsequent)), target);
});

test('root selection recognizes existing workspaces and refuses populated ordinary directories', async t => {
  const { directory, service } = setup(t), other = path.join(directory, 'other'), ordinary = path.join(directory, 'ordinary');
  const alternate = new Service(other); alternate.store.saveLibrary({ title: '已有库' }); alternate.close();
  assert.equal((await service.call('storageStatus')).unavailable, true);
  const location = new StorageLocation(path.join(directory, 'select-root')), current = await location.open();
  t.after(() => { current.close(); location.close(); });
  assert.equal(location.inspect({ mode: 'select', directory: other }).mode, 'open');
  fs.mkdirSync(ordinary); fs.writeFileSync(path.join(ordinary, 'keep.txt'), 'keep');
  assert.throws(() => location.inspect({ mode: 'select', directory: ordinary }), /空文件夹/);
  assert.equal(fs.readFileSync(path.join(ordinary, 'keep.txt'), 'utf8'), 'keep');
});

test('sync and backup retain library identities; restored directory names never claim existing folders', async t => {
  const base = temp(), source = new Store(path.join(base, 'source')), target = new Store(path.join(base, 'target'));
  t.after(() => { source.close(); target.close(); });
  const library = source.saveLibrary({ title: '跨机库' });
  source.write({ type: 'note', data: { title: '保留历史', domain: library.id, content: 'text' } });
  const a = new FolderTransport(source), b = new FolderTransport(target), key = makePairingKey(), folder = path.join(base, 'sync');
  a.configure(folder, key); b.configure(folder, key); await a.cycle(); await b.cycle();
  fs.mkdirSync(path.join(target.directory, '跨机库'));
  const [mapped] = target.directories.describe(target.libraries());
  assert.equal(mapped.id, library.id);
  assert.notEqual(mapped.localDirectory, path.join(target.directory, '跨机库'));
  assert.deepEqual(target.allEvents(), source.allEvents());
  const backup = await new BackupManager(source).create(path.join(base, 'backups'), true);
  const restored = new Service(path.join(base, 'restored')); t.after(() => restored.close());
  await new BackupManager(restored.store).restore(backup.directory);
  assert.equal(restored.state().libraries[0].id, library.id);
  assert.equal(path.dirname(restored.state().libraries[0].localDirectory), restored.store.directory);
  assert.ok(!fs.readFileSync(path.join(backup.directory, 'revisions.json'), 'utf8').includes('libraryDirectories'));
});
