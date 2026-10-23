import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { legacyNoteId } from '../src/core/note-hierarchy.mjs';
import { uuid, hashFile } from '../src/core/util.mjs';

const root = path.resolve('artifacts/note-hierarchy-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(directory, 'A'));
  t.after(() => store.close());
  const library = store.saveLibrary({ title: '研究资料' }), domain = library.data.domain;
  const note = (title, parentNoteId = null, extra = {}) => store.write({ type: 'note',
    data: { title, domain, parentNoteId, content: `${title}的正文`, ...extra } });
  const access = new AgentAccess(store), issued = access.createGrant({ name: '整理助手', domains: [domain], edit: true, trash: true });
  const grant = access.grants().find(item => item.id === issued.id);
  const call = (method, input, requestId = uuid()) => access.dispatch(grant, { method, input: { preferencesVersion: access.preferences().version, ...input }, requestId });
  return { directory, store, library, domain, note, access, call };
}

test('note parents preserve content, validate depth, scope, cycles, deletion, stale edits and restoration', t => {
  const f = fixture(t), parent = f.note('概览'), child = f.note('原理', parent.id);
  assert.equal(path.dirname(f.store.directories.ensure(f.library)), f.store.directory);
  assert.deepEqual(f.store.noteTree(f.domain).find(item => item.id === child.id).path, ['概览', '原理']);
  assert.throws(() => f.store.moveNote({ id: parent.id, parentNoteId: child.id, parents: parent.heads }), /自身|下级/);
  assert.throws(() => f.store.remove(parent.id, parent.heads), /下级笔记/);
  const foreign = f.store.saveLibrary({ title: '其他库' });
  assert.throws(() => f.note('越界', parent.id, { domain: foreign.data.domain }), /不属于/);
  let deep = child;
  for (let i = 2; i < 16; i++) deep = f.note(`层级${i}`, deep.id);
  assert.throws(() => f.note('太深', deep.id), /16 层/);
  const moved = f.store.moveNote({ id: child.id, parentNoteId: null, parents: child.heads });
  assert.equal(moved.data.content, child.data.content);
  assert.throws(() => f.store.moveNote({ id: child.id, parents: child.heads }), /changed/);
  f.store.restoreVersion(child.id, child.heads[0], moved.heads);
  assert.equal(f.store.get(child.id).data.parentNoteId, parent.id);
});

test('agents propose dependent new notes and existing merges; partial confirmation is atomic and idempotent', t => {
  const f = fixture(t), original = f.note('已有知识'), requestId = uuid();
  const input = { domain: f.domain, content: '先建立概览，再纳入既有知识', items: [
    { key: 'child', parentKey: 'overview', reason: '已有知识是该主题的具体原理', targetId: original.id, parents: original.heads, data: { ...original.data, content: '保留原知识并补充' } },
    { key: 'overview', reason: '用概览连接分散知识', data: { title: '主题概览', domain: f.domain, content: '整体框架' } }
  ] };
  const proposal = f.call('propose', input, requestId), [child, parent] = proposal.data.items;
  assert.equal(f.call('propose', input, requestId).id, proposal.id);
  assert.equal(child.data.parentNoteId, parent.targetId);
  assert.equal(f.store.get(parent.targetId), null);
  assert.throws(() => f.call('proposalRevise', { id: proposal.id, parents: proposal.heads,
    items: [{ id: child.id, data: { ...child.data, sourceIds: [parent.targetId] } }] }), /不存在|不可访问/);
  assert.throws(() => f.store.approve(proposal.id, [child.id], proposal.heads), /同时选择/);
  assert.equal(f.store.get(original.id).data.content, original.data.content);
  let approved = f.store.approve(proposal.id, [parent.id], proposal.heads);
  assert.equal(approved.data.items[0].status, 'pending');
  approved = f.call('proposalRevise', { id: proposal.id, parents: approved.heads,
    items: [{ id: child.id, data: { ...child.data, content: '局部优化的内容' } }] });
  const done = f.store.approve(proposal.id, [child.id], approved.heads);
  assert.equal(f.store.get(original.id).data.parentNoteId, parent.targetId);
  assert.equal(f.store.history(original.id).length, 2);
  assert.equal(f.call('record', { id: done.id }).data.items[0].status, 'accepted');
  assert.throws(() => f.call('proposalRevise', { id: done.id, parents: done.heads, items: [{ id: child.id, data: child.data }] }), /已确认/);
  const unordered = f.call('propose', { domain: f.domain, items: [
    { key: 'sub', parentKey: 'top', data: { title: '先列子项', domain: f.domain } },
    { key: 'top', data: { title: '后列父项', domain: f.domain } }
  ] });
  f.store.approve(unordered.id, unordered.data.items.map(item => item.id), unordered.heads);
  assert.ok(f.store.get(unordered.data.items[0].targetId).data.parentNoteId);
});

test('full-access proposals retain same-library parents, cycle and stale-target validation', t => {
  const f = fixture(t), parent = f.note('父'), child = f.note('子');
  assert.throws(() => f.call('noteUpdate', { id: child.id, parents: child.heads, data: { ...child.data, parentNoteId: parent.id } }), /知识体系/);
  assert.throws(() => f.call('propose', { domain: f.domain, items: [
    { key: 'a', parentKey: 'b', data: { title: 'A', domain: f.domain } },
    { key: 'b', parentKey: 'a', data: { title: 'B', domain: f.domain } }
  ] }), /循环/);
  const privateLibrary = f.store.saveLibrary({ title: '私有库' });
  const privateNote = f.note('私有', null, { domain: privateLibrary.data.domain });
  assert.throws(() => f.call('propose', { domain: f.domain, items: [{ data: { title: '越界', domain: f.domain, parentNoteId: privateNote.id } }] }), /知识库|同库/);
  const secret = f.note('敏感', null, { sensitive: true }), leaf = f.note('非敏感标题', secret.id);
  assert.equal(f.call('record', { id: leaf.id }).id, leaf.id);
  assert.equal(f.call('propose', { domain: f.domain, items: [
    { key: 'secret', data: { title: '新敏感', domain: f.domain, sensitive: true } },
    { parentKey: 'secret', data: { title: '子', domain: f.domain } }
  ] }).data.items.length, 2);
  const proposal = f.call('propose', { domain: f.domain, items: [{ targetId: child.id, parents: child.heads, data: { ...child.data, parentNoteId: parent.id } }] });
  f.store.write({ id: child.id, type: 'note', parents: child.heads, data: { ...child.data, content: '用户新修改' } });
  assert.throws(() => f.store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads), /changed/);
  assert.equal(f.store.get(child.id).data.content, '用户新修改');
});

test('legacy folders deterministically become outline notes without changing originals or creating duplicate branches', t => {
  const f = fixture(t), parent = f.store.saveFolder({ title: '旧课程', description: '概览正文', domain: f.domain });
  const child = f.store.saveFolder({ title: '旧章节', domain: f.domain, parentId: parent.id });
  const oldNote = f.store.write({ type: 'note', data: { title: '原笔记', domain: f.domain, content: '原文', folderId: child.id } });
  const pending = f.store.write({ type: 'proposal', data: { title: '旧待确认方案', domain: f.domain,
    items: [{ id: uuid(), targetId: uuid(), parents: [], status: 'pending', data: { title: '旧方案新笔记', domain: f.domain, folderId: child.id } }] } });
  const originalEvents = f.store.allEvents();
  const b = new Store(path.join(f.directory, 'B')); t.after(() => b.close()); b.importEvents(originalEvents);
  assert.ok(f.store.migrateNoteHierarchy() > 0); b.migrateNoteHierarchy();
  assert.equal(f.store.migrateNoteHierarchy(), 0);
  const merged = f.store.importEvents(b.allEvents());
  assert.deepEqual(merged.rejected, []);
  assert.equal(f.store.get(legacyNoteId(parent.id)).data.content, '概览正文');
  assert.equal(f.store.get(oldNote.id).data.parentNoteId, legacyNoteId(child.id));
  assert.equal(f.store.get(oldNote.id).conflict, false);
  assert.equal(f.store.get(pending.id).data.items[0].data.parentNoteId, legacyNoteId(child.id));
  assert.equal(f.store.get(pending.id).conflict, false);
  for (const event of originalEvents) assert.deepEqual(f.store.event(event.id), event);
  f.store.moveNote({ id: oldNote.id, parents: f.store.get(oldNote.id).heads });
  f.store.migrateNoteHierarchy();
  assert.equal(f.store.get(oldNote.id).data.parentNoteId, null);
});

test('v3 transfer carries hierarchy and pending dependencies; concurrent moves stay visible', async t => {
  const f = fixture(t), a = f.note('A'), b = f.note('B');
  const proposal = f.call('propose', { domain: f.domain, items: [
    { key: 'parent', data: { title: '待确认概览', domain: f.domain } },
    { parentKey: 'parent', data: { title: '待确认概念', domain: f.domain } }
  ] });
  const other = new Store(path.join(f.directory, 'B')); t.after(() => other.close());
  const sa = new CurrentSync(f.store), sb = new CurrentSync(other), key = makePairingKey(), cloud = path.join(f.directory, 'cloud');
  sa.configure(cloud, key); sb.configure(cloud, key);
  await sa.publish(); await sb.importLatest();
  assert.deepEqual(other.get(proposal.id).data.items, proposal.data.items);
  f.store.moveNote({ id: a.id, parentNoteId: b.id, parents: a.heads });
  other.moveNote({ id: b.id, parentNoteId: a.id, parents: b.heads });
  await sa.publish(); await sb.importLatest();
  assert.ok(other.noteTree(f.domain).every(node => node.issue));
  assert.equal(other.get(a.id).data.content, a.data.content);
  assert.equal(other.get(b.id).data.content, b.data.content);
});

test('background files use library root and note ancestry; shared originals are not duplicated per note', async t => {
  const f = fixture(t), parent = f.note('主题'), child = f.note('概念', parent.id);
  const source = path.join(f.directory, '资料.txt'); fs.writeFileSync(source, '完整资料');
  const asset = await importAttachment(f.store, source, { domain: f.domain });
  f.store.write({ id: child.id, type: 'note', parents: child.heads, data: { ...child.data, assetIds: [asset.id] } });
  const local = new LocalHierarchy(f.store);
  assert.deepEqual((await local.refresh()).errors, []);
  const file = f.store.assetLocation(asset.id).path;
  assert.ok(file.startsWith(f.store.directories.ensure(f.library)));
  assert.match(file, /主题.*概念/);
  assert.doesNotMatch(file, /分类内容/);
  assert.equal(await hashFile(file), asset.data.sha256);
  const sibling = f.note('另一个概念', parent.id, { assetIds: [asset.id] });
  assert.deepEqual((await local.refresh()).errors, []);
  assert.match(f.store.assetLocation(asset.id).path, /共享资料/);
  assert.ok(fs.existsSync(source)); assert.equal(fs.existsSync(file), false);
  assert.equal(f.store.get(sibling.id).data.assetIds[0], asset.id);
});

test('service maintains local note files automatically and exposes compact UI tree', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), service = new Service(directory);
  t.after(() => service.close());
  const library = await service.call('librarySave', { title: '自动整理' });
  assert.ok(fs.existsSync(service.store.directories.ensure(library)));
  const note = await service.call('save', { type: 'note', data: { title: '知识点', domain: library.data.domain, content: '原文' } });
  await service.organizeLocal({ verify: false });
  assert.equal((await service.call('localHierarchyStatus')).enabled, true);
  assert.ok(Object.keys(service.store.local('hierarchyFiles')).some(file => file.endsWith(`${note.id}.md`)));
  const tree = await service.call('noteTree');
  assert.equal(tree[0].id, note.id);
  assert.equal(tree[0].data.content, undefined);
  await assert.rejects(service.call('approve', {}));
});
