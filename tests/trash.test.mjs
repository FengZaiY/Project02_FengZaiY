import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store, validateEvent } from '../src/core/store.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { emptyTrash, previewTrash } from '../src/core/trash.mjs';
import { canonical, sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/trash-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), service = new Service(path.join(directory, 'A'));
  t.after(() => service.close());
  const library = service.store.saveLibrary({ title: '个人资料' }), other = service.store.saveLibrary({ title: '其他资料' });
  const store = service.store, domain = library.id;
  const note = (title, scope = domain) => store.write({ type: 'note', data: { title, domain: scope, content: '正文' } });
  const trash = record => store.remove(record.id, record.heads);
  const clear = (scope = domain) => emptyTrash(store, { domain: scope, token: previewTrash(store, { domain: scope }).token, confirmed: true });
  return { directory, service, store, domain, other: other.id, note, trash, clear };
}

test('empty trash respects library scope, closes tabs and removes payload history', async t => {
  const f = fixture(t), note = f.trash(f.note('清空')), keep = f.note('正常笔记'), other = f.trash(f.note('另一库', f.other));
  f.store.local('workspace', { tabs: [{ id: 'gone', recordId: note.id }, { id: 'keep', recordId: keep.id }], selectedTab: 'gone' });
  const before = f.store.allEvents();
  const preview = await f.service.call('trashPreview', { domain: f.domain });
  assert.equal(preview.total, 1);
  await assert.rejects(f.service.call('trashEmpty', { domain: f.domain, token: preview.token }), /明确确认/);
  const result = await f.service.call('trashEmpty', { domain: f.domain, token: preview.token, confirmed: true });
  assert.equal(result.count, 1);
  assert.equal(f.store.get(note.id), null);
  assert.deepEqual(f.store.history(note.id), []);
  assert.ok(f.store.get(other.id)?.deleted);
  assert.ok(f.store.get(keep.id));
  assert.deepEqual(f.store.local('workspace').tabs.map(tab => tab.id), ['keep']);
  assert.equal(f.store.local('workspace').selectedTab, null);
  assert.equal(f.store.summary().trash, 1);
  for (const event of before) assert.deepEqual(f.store.event(event.id), event.entityId === note.id ? undefined : event);
  assert.equal(f.store.erasures().length, 1);
  assert.throws(() => f.store.restoreVersion(note.id, note.heads[0], f.store.headIds(note.id)), /清空/);
  assert.throws(() => f.store.write({ id: note.id, parents: [], data: note.data }), /清空/);
  assert.equal(f.clear().count, 0);
  await assert.rejects(f.service.call('trashEmpty', { domain: f.domain, token: preview.token, confirmed: true }), { code: 'CONFLICT' });
});

test('references, proposals, hierarchy, dirty tabs and protected dependency chains are kept', t => {
  const f = fixture(t), target = f.trash(f.note('被引用'));
  const owner = f.store.write({ type: 'note', data: { title: '引用者', domain: f.domain, content: `[引用](studyself://note/${target.id})` } });
  const dependency = f.trash(f.note('二级依赖'));
  f.store.write({ id: target.id, parents: target.heads, type: 'note', deleted: true, data: { ...target.data, sourceIds: [dependency.id] } });
  const dirty = f.trash(f.note('未保存'));
  f.store.local('workspace', { tabs: [{ recordId: dirty.id, dirty: true, draft: dirty.data }] });
  const plan = previewTrash(f.store, { domain: f.domain });
  assert.equal(plan.eligible.length, 0);
  assert.equal(plan.blocked.length, 3);
  assert.match(plan.blocked.find(item => item.id === dependency.id).reason, /引用/);
  f.trash(owner);
  f.store.local('workspace', { tabs: [] });
  assert.equal(f.clear().count, 4);
  assert.equal(f.store.list({ trash: true }).length, 0);
});

test('stale confirmation rejects new references, new trash and restores; batch errors rollback everything', t => {
  const f = fixture(t), a = f.trash(f.note('A')), b = f.trash(f.note('B'));
  const preview = previewTrash(f.store, { domain: f.domain });
  const owner = f.store.write({ type: 'annotation', data: { title: '备注', noteId: a.id, domain: f.domain, content: '仍有关联' } });
  assert.throws(() => emptyTrash(f.store, { domain: f.domain, token: preview.token, confirmed: true }), { code: 'CONFLICT' });
  f.trash(owner);
  const before = f.store.allEvents(), sequence = f.store.getMeta('sequence'), original = f.store.eraseRaw.bind(f.store);
  f.store.eraseRaw = (...args) => { original(...args); throw new Error('模拟写入失败'); };
  assert.throws(() => f.clear(), /模拟写入失败/);
  assert.deepEqual(f.store.allEvents(), before);
  assert.equal(f.store.getMeta('sequence'), sequence);
  f.store.eraseRaw = original;
  const stale = previewTrash(f.store, { domain: f.domain });
  f.store.restoreVersion(b.id, b.heads[0], b.heads);
  assert.throws(() => emptyTrash(f.store, { domain: f.domain, token: stale.token, confirmed: true }), { code: 'CONFLICT' });
});

test('clear more than a page, delete managed original and preserve external import source', async t => {
  const f = fixture(t);
  for (let i = 0; i < 155; i++) f.trash(f.note(`第 ${i} 项`));
  const file = path.join(f.directory, '原资料.txt'); fs.writeFileSync(file, '应保留的原件');
  const asset = await f.service.call('assetImport', { path: file, domain: f.domain });
  const location = f.store.assetLocation(asset.id).path;
  f.trash(asset);
  const preview = await f.service.call('trashPreview', { domain: f.domain });
  assert.equal((await f.service.call('trashEmpty', { domain: f.domain, token: preview.token, confirmed: true })).count, 156);
  assert.equal(fs.readFileSync(file, 'utf8'), '应保留的原件');
  assert.equal(fs.existsSync(location), false);
  assert.equal(f.store.summary().trash, 0);
  await assert.rejects(f.service.call('assetContent', { id: asset.id }), /not available/);
});

test('out-of-order and repeated import plus restart cannot resurrect cleared content; concurrent edits survive', t => {
  const f = fixture(t), note = f.trash(f.note('同步删除'));
  const old = f.store.allEvents(), bPath = path.join(f.directory, 'B');
  let b = new Store(bPath); t.after(() => b.close());
  b.importEvents(old);
  f.store.transaction(() => f.store.purgeRaw(note.id, note.heads));
  const marker = f.store.allEvents().at(-1);
  const c = new Store(path.join(f.directory, 'C')); t.after(() => c.close());
  assert.equal(c.importEvents([marker]).pending, 1);
  c.importEvents([...old].reverse());
  assert.equal(c.get(note.id), null);
  c.importEvents(old);
  assert.equal(c.get(note.id), null);
  b.importEvents(f.store.allEvents()); b.close(); b = new Store(bPath);
  assert.equal(b.get(note.id), null);
  assert.equal(b.summary().trash, 0);
  const concurrent = { ...old.find(event => event.id === note.heads[0]), id: uuid(), deviceId: b.deviceId,
    deleted: false, parents: note.heads, data: { ...note.data, content: '另一台电脑恢复并修改' } };
  delete concurrent.hash; concurrent.hash = sha(canonical(concurrent));
  f.store.importEvents([concurrent]);
  assert.equal(f.store.get(note.id).conflict, true);
  assert.equal(f.store.get(note.id).data.content, '另一台电脑恢复并修改');
  assert.equal(f.store.get(note.id).versions.some(event => event.purged), true);
});

test('v3 latest-content sync carries final deletion and remains idempotent for a new device', async t => {
  const f = fixture(t), note = f.trash(f.note('云端同步')), key = '2'.repeat(64);
  const a = f.service.transport, bStore = new Store(path.join(f.directory, 'B')); t.after(() => bStore.close());
  const b = new CurrentSync(bStore, { reserveBytes: 0 }), folder = path.join(f.directory, 'channel');
  a.configure(folder, key); b.configure(folder, key);
  await a.publish(); await b.importLatest();
  assert.equal(bStore.get(note.id).deleted, true);
  f.clear(); await a.publish(); await b.importLatest();
  assert.equal(bStore.get(note.id), null);
  assert.equal((await b.importLatest()).imported, 0);
  const cStore = new Store(path.join(f.directory, 'C')); t.after(() => cStore.close());
  const c = new CurrentSync(cStore, { reserveBytes: 0 }); c.configure(folder, key);
  await c.importLatest();
  assert.equal(cStore.get(note.id), null);
  assert.equal(cStore.erasures().some(receipt => receipt.entityId === note.id), true);
  assert.equal(cStore.allEvents().some(event => event.entityId === note.id), false);
});

test('final deletion marker validates its shape and parent deletion without accepting data changes', t => {
  const f = fixture(t), live = f.note('正文'), deleted = f.trash(live);
  f.store.transaction(() => f.store.purgeRaw(deleted.id, deleted.heads));
  const marker = f.store.allEvents().at(-1);
  assert.equal(validateEvent(marker), marker);
  const resign = value => { const { hash, ...rest } = value; return { ...rest, hash: sha(canonical(rest)) }; };
  assert.throws(() => validateEvent(resign({ ...marker, deleted: false })), /final deletion/);
  assert.throws(() => f.store.insert(resign({ ...marker, id: uuid(), parents: live.heads }), true), /Only deleted/);
  assert.throws(() => f.store.insert(resign({ ...marker, id: uuid(), data: { ...deleted.data, content: '篡改' } }), true), /integrity/);
  const restore = { ...marker, id: uuid(), parents: [marker.id], deleted: false }; delete restore.purged;
  assert.throws(() => f.store.insert(resign(restore), true), /cannot be restored/);
});
