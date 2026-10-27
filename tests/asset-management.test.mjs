import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store } from '../src/core/store.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { uuid, hashFile } from '../src/core/util.mjs';

const root = path.resolve('artifacts/asset-management-tests');
fs.mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), service = new Service(path.join(directory, 'A'));
  t.after(() => service.close());
  const store = service.store, library = store.saveLibrary({ title: '资料库' }), other = store.saveLibrary({ title: '其他库' });
  const asset = async (name, text = name) => {
    const file = path.join(directory, name); fs.writeFileSync(file, text);
    return importAttachment(store, file, { domain: library.id, duplicateMode: 'separate' });
  };
  return { directory, service, store, library, other, asset, call: (method, input) => service.call(method, input) };
}
const entry = record => ({ id: record.id, parents: record.heads });

test('central originals retain note, shared and recycled references without relocating files on reads', async t => {
  const f = await fixture(t);
  const own = await f.asset('笔记图片.png'), shared = await f.asset('共享.txt'), free = await f.asset('独立.pdf'), trash = await f.asset('回收.txt');
  const parent = f.store.write({ type: 'note', data: { title: '概览', domain: f.library.id, assetIds: [shared.id] } });
  f.store.write({ type: 'note', data: { title: '下级', domain: f.library.id, parentNoteId: parent.id, assetIds: [own.id, shared.id] } });
  f.store.remove(trash.id, trash.heads);
  await f.service.organizeLocal();
  const snapshot = () => JSON.stringify({ events: f.store.db.prepare('SELECT * FROM events ORDER BY id').all(), files: f.store.db.prepare('SELECT * FROM assets ORDER BY id').all() });
  const before = snapshot();
  const result = await f.call('assetCatalog', { domain: f.library.id });
  assert.equal(result.storage.root, f.store.directory);
  for (const [asset, kind] of [[own, 'central'], [shared, 'central'], [free, 'central']]) {
    const row = result.rows.find(row => row.id === asset.id);
    assert.equal(row.storage.path, f.store.assetLocation(asset.id).path);
    assert.equal(row.storage.kind, kind);
    assert.equal(row.storage.state, 'available');
    assert.equal(row.storage.directory, path.dirname(row.storage.path));
    assert.equal(path.join(result.storage.root, row.storage.relativeDirectory, row.storage.filename), row.storage.path);
  }
  const owned = result.rows.find(row => row.id === own.id).storage;
  assert.ok(owned.relativeDirectory.startsWith('.fengzai-y'));
  assert.equal(result.rows.find(row => row.id === shared.id).referenceCount, 2);
  const rootDirectory = path.join(f.store.directory, '.fengzai-y', 'materials');
  assert.equal((await f.call('assetCatalog', { domain: f.library.id, directory: rootDirectory })).total, 3);
  assert.equal((await f.call('assetCatalog', { directory: owned.directory })).rows[0].id, own.id);
  assert.equal((await f.call('assetDetail', { id: trash.id })).storage.kind, 'central');
  assert.equal(snapshot(), before, 'Catalog and location reads must not reorganize files or write knowledge');
});

test('local directory filters retain scoped totals before pagination and distinguish unbound, missing, changed and external files', async t => {
  const f = await fixture(t);
  const missing = await f.asset('缺失.txt'), unbound = await f.asset('未下载.txt'), altered = await f.asset('异常.txt'), external = await f.asset('外部.txt');
  const oldPath = f.store.assetLocation(missing.id).path;
  fs.unlinkSync(oldPath);
  f.store.db.prepare('DELETE FROM assets WHERE id=?').run(unbound.id);
  fs.writeFileSync(f.store.assetLocation(altered.id).path, 'different length');
  const outsideFile = path.join(f.directory, '外部.txt');
  f.store.bindAsset(external.id, outsideFile);
  const otherFile = path.join(f.directory, '他库.txt'); fs.writeFileSync(otherFile, 'other');
  await importAttachment(f.store, otherFile, { domain: f.other.id });
  const result = await f.call('assetCatalog', { domain: f.library.id, limit: 1 });
  assert.equal(result.total, 4); assert.equal(result.rows.length, 1);
  assert.equal(result.storage.directories.reduce((n, d) => n + d.count, 0), 4);
  assert.ok(!JSON.stringify(result.storage).includes('其他库'));
  assert.equal((await f.call('assetDetail', { id: missing.id })).storage.state, 'missing');
  assert.equal((await f.call('assetDetail', { id: missing.id })).storage.path, oldPath);
  assert.equal((await f.call('assetDetail', { id: altered.id })).storage.state, 'changed');
  const unattached = await f.call('assetCatalog', { domain: f.library.id, directory: ':unbound' });
  assert.equal(unattached.total, 1); assert.equal(unattached.rows[0].storage.path, null);
  const out = await f.call('assetCatalog', { domain: f.library.id, directory: ':external' });
  assert.equal(out.total, 1); assert.equal(out.rows[0].storage.path, outsideFile);
  assert.equal(out.rows[0].storage.kind, 'external');
  assert.equal((await f.call('assetCatalog', { domain: f.other.id, directory: ':external' })).total, 0);
  const queried = await f.call('assetCatalog', { domain: f.library.id, query: '外部' });
  assert.equal(queried.storage.directories.reduce((n, d) => n + d.count, 0), 1);
  await assert.rejects(f.call('assetCatalog', { directory: {} }), /目录筛选/);
});

test('asset metadata preserves file identity, history and stale-write protection', async t => {
  const f = await fixture(t), asset = await f.asset('原文件.txt'), binding = f.store.assetLocation(asset.id);
  const updated = await f.call('assetUpdate', { ...entry(asset), changes: { title: '学习资料', tags: ['实操', '实操'], sensitive: true } });
  assert.equal(updated.data.filename, '原文件.txt');
  assert.equal(updated.data.sha256, asset.data.sha256);
  assert.deepEqual(updated.data.tags, ['实操']);
  assert.deepEqual(f.store.assetLocation(asset.id), binding);
  assert.equal(await hashFile(binding.path), asset.data.sha256);
  const noOp = await f.call('assetUpdate', { ...entry(updated), changes: { title: '学习资料' } });
  assert.deepEqual(noOp.heads, updated.heads);
  await assert.rejects(f.call('assetUpdate', { ...entry(asset), changes: { title: '过期修改' } }), { code: 'CONFLICT' });
  await assert.rejects(f.call('assetUpdate', { ...entry(updated), changes: { filename: '篡改.txt' } }), /身份/);
  await assert.rejects(f.call('assetUpdate', { ...entry(updated), changes: { title: '' } }), /名称/);
  const restored = await f.call('restoreVersion', { ...entry(updated), revision: asset.heads[0] });
  assert.equal(restored.data.title, asset.data.title);
  assert.equal(f.store.history(asset.id).length, 3);
});

test('catalog filters names, original filenames, tags, kinds, duplicates, missing files and paging', async t => {
  const f = await fixture(t), first = await f.asset('课程.pdf', 'identical'), second = await f.asset('副本.pdf', 'identical'), image = await f.asset('图片.png');
  await f.call('assetUpdate', { ...entry(first), changes: { title: '专业教程', tags: ['入门'] } });
  fs.unlinkSync(f.store.assetLocation(image.id).path);
  assert.equal((await f.call('assetCatalog', { query: '课程', domain: f.library.id })).total, 1);
  assert.equal((await f.call('assetCatalog', { tag: '入门' })).rows[0].data.title, '专业教程');
  assert.equal((await f.call('assetCatalog', { kind: 'document', usage: 'duplicates' })).total, 2);
  assert.equal((await f.call('assetCatalog', { availability: 'missing' })).rows[0].id, image.id);
  assert.equal((await f.call('assetCatalog', { domain: f.other.id })).total, 0);
  const a = await f.call('assetCatalog', { sort: 'name', limit: 1 }), b = await f.call('assetCatalog', { sort: 'name', limit: 1, offset: 1 });
  assert.notEqual(a.rows[0].id, b.rows[0].id);
  assert.equal(a.total, 3);
  assert.equal((await f.call('assetDetail', { id: second.id })).duplicateCount, 2);
  await assert.rejects(f.call('assetCatalog', { offset: -1 }), /分页/);
});

test('reference protection covers inline links, recycled records, proposals and local drafts', async t => {
  const f = await fixture(t), asset = await f.asset('原文.txt');
  let note = f.store.write({ type: 'note', data: { title: '引用正文', domain: f.library.id, content: `[原文](studyself://asset/${asset.id})` } });
  assert.equal((await f.call('assetDetail', { id: asset.id })).references[0].id, note.id);
  await assert.rejects(f.call('assetBatch', { items: [entry(asset)], action: 'trash' }), { code: 'ASSET_REFERENCED' });
  await assert.rejects(f.call('assetUpdate', { ...entry(asset), changes: { domain: f.other.id } }), { code: 'ASSET_REFERENCED' });
  await assert.rejects(f.call('delete', entry(asset)), { code: 'ASSET_REFERENCED' });
  note = f.store.remove(note.id, note.heads);
  assert.equal((await f.call('assetDetail', { id: asset.id })).references[0].deleted, true);
  await assert.rejects(f.call('delete', entry(asset)), { code: 'ASSET_REFERENCED' });
  const free = await f.asset('独立.txt');
  f.store.local('workspace', { tabs: [{ id: uuid(), recordId: note.id, dirty: true, draft: { title: '未保存', domain: f.library.id, content: `[未保存引用](studyself://asset/${free.id})` } }] });
  assert.equal((await f.call('assetDetail', { id: free.id })).references[0].pending, true);
  await assert.rejects(f.call('delete', entry(free)), { code: 'ASSET_REFERENCED' });
  f.store.local('workspace', { tabs: [] });
  assert.equal((await f.call('assetDetail', { id: free.id })).references.length, 0);
  f.store.write({ type: 'proposal', data: { title: '待确认方案', domain: f.library.id, items: [{ id: uuid(), targetId: uuid(), parents: [], data: { title: '候选笔记', domain: f.library.id, assetIds: [free.id] } }] } });
  await assert.rejects(f.call('delete', entry(free)), { code: 'ASSET_REFERENCED' });
});

test('batch writes are atomic for referenced, stale and invalid items; recycle keeps originals', async t => {
  const f = await fixture(t), a = await f.asset('甲.txt'), b = await f.asset('乙.txt');
  f.store.write({ type: 'note', data: { title: '引用乙', domain: f.library.id, assetIds: [b.id] } });
  await assert.rejects(f.call('assetBatch', { action: 'trash', items: [entry(a), entry(b)] }), /引用/);
  assert.deepEqual(f.store.get(a.id).heads, a.heads, 'A failure must roll back earlier batch items');
  await f.call('assetBatch', { action: 'addTags', items: [entry(a), entry(b)], tags: ['主题'] });
  const latestA = f.store.get(a.id), latestB = f.store.get(b.id);
  await assert.rejects(f.call('assetBatch', { action: 'removeTags', items: [entry(latestA), entry(b)], tags: ['主题'] }), { code: 'CONFLICT' });
  assert.deepEqual(f.store.get(a.id).heads, latestA.heads);
  await assert.rejects(f.call('assetBatch', { action: 'addTags', items: [entry(latestA)], tags: ['x'.repeat(101)] }), /标签/);
  await f.call('assetBatch', { action: 'move', items: [entry(latestA)], domain: f.other.id });
  const moved = f.store.get(a.id);
  assert.equal(moved.data.domain, f.other.id);
  await f.call('assetBatch', { action: 'trash', items: [entry(moved)] });
  const recycled = f.store.get(a.id);
  assert.equal(recycled.deleted, true);
  assert.ok(fs.existsSync(f.store.assetLocation(a.id).path));
  assert.equal((await f.call('assetCatalog', { trash: true })).total, 1);
  await f.call('assetBatch', { action: 'restore', items: [entry(recycled)] });
  assert.equal(f.store.get(a.id).deleted, false);
  assert.equal(f.store.get(a.id).data.domain, f.other.id);
  assert.deepEqual(f.store.get(b.id).heads, latestB.heads);
});

test('conflicting asset metadata requires explicit history choice and retains both versions', async t => {
  const f = await fixture(t), a = await f.asset('并发.txt');
  const first = f.store.write({ ...entry(a), type: 'asset', data: { ...a.data, title: '甲电脑标题' } });
  f.store.write({ ...entry(a), type: 'asset', data: { ...a.data, title: '乙电脑标题' }, allowBranch: true });
  const conflicting = f.store.get(a.id);
  assert.equal((await f.call('assetCatalog', { usage: 'conflicts' })).total, 1);
  await assert.rejects(f.call('assetUpdate', { ...entry(conflicting), changes: { title: '静默覆盖' } }), { code: 'CONFLICT' });
  await f.call('restoreVersion', { ...entry(conflicting), revision: first.heads[0] });
  assert.equal(f.store.get(a.id).conflict, false);
  assert.equal(f.store.history(a.id).length, 4);
});

test('references on any concurrent branch block recycling, including rich media and source URLs', async t => {
  const f = await fixture(t), a = await f.asset('分支图片.png'), b = await f.asset('来源文件.txt');
  const block = JSON.stringify({ v: 1, kind: 'image', assetId: a.id, label: '原图' }).replaceAll('"', '&quot;');
  const first = f.store.write({ type: 'note', data: { title: '并发正文', domain: f.library.id, content: '' } });
  f.store.write({ ...entry(first), type: 'note', data: { ...first.data, content: '' } });
  f.store.write({ ...entry(first), type: 'note', allowBranch: true, data: { ...first.data, format: 'html', content: `<figure data-ss-block="${block}"></figure>` } });
  const detail = await f.call('assetDetail', { id: a.id });
  assert.equal(detail.references[0].conflict, true);
  await assert.rejects(f.call('assetBatch', { items: [entry(a)], action: 'trash' }), { code: 'ASSET_REFERENCED' });
  f.store.write({ type: 'source', data: { title: '内部来源', domain: f.library.id, url: `studyself://asset/${b.id}` } });
  await assert.rejects(f.call('assetBatch', { items: [entry(b)], action: 'move', domain: f.other.id }), { code: 'ASSET_REFERENCED' });
  const free = await f.asset('无引用.txt');
  f.store.local('workspace', { tabs: [{ recordId: uuid(), dirty: true, draft: { title: '损坏的未保存块', domain: f.library.id, format: 'html', content: '<figure data-ss-block="broken"></figure>' } }] });
  assert.equal((await f.call('assetDetail', { id: free.id })).referencesUnknown, true);
  await assert.rejects(f.call('delete', entry(free)), { code: 'ASSET_REFERENCE_UNKNOWN' });
});

test('asset metadata and recycle/restore synchronize without changing file identity', async t => {
  const f = await fixture(t), a = await f.asset('同步资料.txt'), peer = new Store(path.join(f.directory, 'B'));
  t.after(() => peer.close());
  const sender = f.service.transport, receiver = new CurrentSync(peer), folder = path.join(f.directory, 'transfer'), key = makePairingKey();
  sender.configure(folder, key); receiver.configure(folder, key);
  await f.call('assetUpdate', { ...entry(a), changes: { title: '可同步名称', tags: ['共享'] } });
  await sender.plan({ reserveBytes: 0 }); await sender.publish();
  await receiver.importLatest();
  assert.equal(peer.get(a.id).data.title, '可同步名称');
  assert.equal(await hashFile(peer.assetLocation(a.id).path), a.data.sha256);
  await f.call('assetBatch', { action: 'trash', items: [entry(f.store.get(a.id))] });
  await sender.plan({ reserveBytes: 0 }); await sender.publish(); await receiver.importLatest();
  assert.equal(peer.get(a.id).deleted, true);
  await f.call('assetBatch', { action: 'restore', items: [entry(f.store.get(a.id))] });
  await sender.plan({ reserveBytes: 0 }); await sender.publish(); await receiver.importLatest();
  assert.equal(peer.get(a.id).deleted, false);
  assert.deepEqual(peer.get(a.id).data.tags, ['共享']);
});
