import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { hashFile, uuid } from '../src/core/util.mjs';
import { legacyNoteId } from '../src/core/note-hierarchy.mjs';

const root = path.resolve('artifacts/hierarchy-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(dir, 'A'));
  const lib = store.saveLibrary({ title: '我的知识' }), domain = lib.data.domain;
  t.after(() => store.close());
  const folder = (title, parentId = null) => store.saveFolder({ title, domain, parentId });
  const note = (folderId, content = '完整正文') => store.write({ type: 'note', data: { title: '笔记', content, domain, ...(folderId ? { folderId } : {}) } });
  return { dir, store, lib, domain, folder, note };
}

test('folders validate scope, stale edits, duplicates, ancestry and nonempty deletion', t => {
  const f = fixture(t), a = f.folder('基础'), b = f.folder('概念', a.id), note = f.note(b.id);
  assert.deepEqual(f.store.folders(f.domain).find(item => item.id === b.id).path, ['基础', '概念']);
  assert.equal(f.store.list({ type: 'note', folderId: b.id, domain: f.domain }).length, 1);
  assert.equal(f.store.list({ type: 'note', folderId: null, domain: f.domain }).length, 0);
  assert.throws(() => f.folder('基础'), /同名/);
  assert.throws(() => f.store.saveFolder({ id: a.id, domain: f.domain, title: '循环', parentId: b.id, parents: a.heads }), /自身|下级/);
  const foreign = f.store.saveLibrary({ title: '其他库' });
  assert.throws(() => f.store.write({ type: 'note', data: { title: '越界', domain: foreign.data.domain, folderId: b.id } }), /不属于/);
  assert.throws(() => f.store.remove(a.id, a.heads), /子目录/);
  f.store.remove(note.id, note.heads);
  assert.throws(() => f.store.remove(b.id, b.heads), /回收站/);
  const renamed = f.store.saveFolder({ id: b.id, title: '定义', domain: f.domain, parentId: a.id, parents: b.heads });
  assert.throws(() => f.store.saveFolder({ id: b.id, title: '旧编辑', domain: f.domain, parents: b.heads }), /changed/);
  assert.equal(f.store.history(renamed.id).length, 2);
  assert.throws(() => f.store.remove(f.lib.id, f.lib.heads), /仍有资料/);
});

test('concurrent cyclic moves and remote folder deletion remain visible without rewriting', t => {
  const f = fixture(t), a = f.folder('A'), b = f.folder('B'), note = f.note(a.id);
  const other = new Store(path.join(f.dir, 'B')); t.after(() => other.close()); other.importEvents(f.store.allEvents());
  f.store.saveFolder({ id: a.id, title: 'A', domain: f.domain, parentId: b.id, parents: a.heads });
  other.saveFolder({ id: b.id, title: 'B', domain: f.domain, parentId: a.id, parents: b.heads });
  f.store.importEvents(other.allEvents());
  assert.ok(f.store.folders(f.domain).every(item => item.issue));
  assert.equal(f.store.list({ type: 'note', folderId: null, domain: f.domain })[0].id, note.id);
  const before = f.store.allEvents().length;
  f.store.folders(f.domain); assert.equal(f.store.allEvents().length, before);
});

test('a concurrent folder deletion does not hide incoming notes and can be recovered', t => {
  const f = fixture(t), folder = f.folder('并发目录');
  const other = new Store(path.join(f.dir, 'B')); t.after(() => other.close()); other.importEvents(f.store.allEvents());
  f.store.remove(folder.id, folder.heads);
  const note = other.write({ type: 'note', data: { title: '保留资料', domain: f.domain, folderId: folder.id } });
  f.store.importEvents(other.allEvents());
  assert.equal(f.store.list({ type: 'note', folderId: null, domain: f.domain })[0].id, note.id);
  f.store.restoreVersion(folder.id, folder.heads[0], f.store.get(folder.id).heads);
  assert.equal(f.store.list({ type: 'note', folderId: folder.id, domain: f.domain })[0].id, note.id);
});

test('v3 latest content retains nested folders, note placement and conflicts on a new computer', async t => {
  const f = fixture(t), parent = f.folder('入门'), child = f.folder('章节', parent.id), note = f.note(child.id);
  const other = new Store(path.join(f.dir, 'B')); t.after(() => other.close());
  const key = makePairingKey(), a = new CurrentSync(f.store), b = new CurrentSync(other);
  a.configure(path.join(f.dir, 'cloud'), key); b.configure(path.join(f.dir, 'cloud'), key);
  await a.publish(); await b.importLatest();
  assert.equal(other.get(note.id).data.folderId, child.id);
  assert.deepEqual(other.folders(f.domain).find(item => item.id === child.id).path, ['入门', '章节']);
  const oldHeads = f.store.get(child.id).heads;
  f.store.saveFolder({ id: child.id, title: '甲', domain: f.domain, parentId: parent.id, parents: oldHeads });
  other.saveFolder({ id: child.id, title: '乙', domain: f.domain, parentId: parent.id, parents: oldHeads });
  await a.publish(); await b.importLatest();
  assert.equal(other.get(child.id).conflict, true);
  assert.ok(other.folders(f.domain).find(item => item.id === child.id).issue);
  assert.equal(other.get(note.id).data.content, '完整正文');
});

test('local hierarchy projects full rich data and relocates managed originals without deleting source or extras', async t => {
  const f = fixture(t), folder = f.folder('课程'), child = f.folder('第一章', folder.id);
  const payload = JSON.stringify({ v: 1, kind: 'formula', label: '公式', source: 'E=mc^2' }).replaceAll('"', '&quot;');
  const note = f.note(child.id, `<figure data-ss-block="${payload}"><figcaption>源文本</figcaption></figure>`);
  const source = path.join(f.dir, 'lesson.mp4'); fs.writeFileSync(source, Buffer.alloc(1000, 7));
  const asset = await importAttachment(f.store, source, { domain: f.domain, folderId: child.id });
  const oldFile = f.store.assetLocation(asset.id).path;
  f.store.migrateNoteHierarchy();
  const layout = new LocalHierarchy(f.store);
  const result = await layout.refresh({ enable: true });
  assert.deepEqual(result.errors, []);
  const moved = f.store.assetLocation(asset.id).path;
  assert.match(moved, /课程.*第一章/); assert.match(moved, /\.mp4$/);
  assert.equal(await hashFile(moved), asset.data.sha256);
  assert.ok(fs.existsSync(source)); assert.equal(fs.existsSync(oldFile), false);
  const projection = Object.keys(f.store.local('hierarchyFiles')).find(file => file.endsWith(`${note.id}.json`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.directory, projection))).data.content, note.data.content);
  const extra = path.join(path.dirname(moved), 'user-extra.txt'); fs.writeFileSync(extra, '保留');
  f.store.moveNote({ id: note.id, parentNoteId: null, parents: f.store.get(note.id).heads });
  const converted = f.store.get(legacyNoteId(child.id));
  f.store.write({ id: converted.id, type: 'note', parents: converted.heads, data: { ...converted.data, title: '改名', parentNoteId: null } });
  assert.deepEqual((await layout.refresh()).errors, []);
  assert.ok(fs.existsSync(extra)); assert.equal(fs.existsSync(path.join(f.store.directory, projection)), false);
  assert.equal(fs.existsSync(moved), false);
  assert.match(f.store.assetLocation(asset.id).path, /改名/);
  assert.equal(f.store.history(note.id).length, 3);
});

test('projection failure preserves originals and notes, retry resumes after copy and binding failure', async t => {
  const f = fixture(t), folder = f.folder('目标');
  const source = path.join(f.dir, 'file.txt'); fs.writeFileSync(source, 'original');
  const asset = await importAttachment(f.store, source, { domain: f.domain, folderId: folder.id });
  const original = f.store.assetLocation(asset.id).path, layout = new LocalHierarchy(f.store);
  const bind = f.store.bindAsset.bind(f.store);
  f.store.bindAsset = () => { throw new Error('simulated binding failure'); };
  assert.match((await layout.refresh()).errors[0].message, /binding failure/);
  assert.ok(fs.existsSync(original)); assert.equal(f.store.assetLocation(asset.id).path, original);
  f.store.bindAsset = bind;
  assert.deepEqual((await new LocalHierarchy(f.store).refresh()).errors, []);
  assert.equal(await hashFile(f.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(fs.existsSync(original), false);
});

test('projection never overwrites user-edited generated content; missing originals stay explicit', async t => {
  const f = fixture(t), note = f.note();
  const source = path.join(f.dir, 'file.txt'); fs.writeFileSync(source, 'original');
  const asset = await importAttachment(f.store, source, { domain: f.domain });
  fs.unlinkSync(f.store.assetLocation(asset.id).path);
  const layout = new LocalHierarchy(f.store), first = await layout.refresh();
  assert.equal(first.missing, 1);
  const file = Object.keys(f.store.local('hierarchyFiles')).find(file => file.endsWith(`${note.id}.md`));
  fs.writeFileSync(path.join(f.store.directory, file), '用户自己修改');
  f.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '系统新修改' } });
  assert.ok((await layout.refresh()).errors.length);
  assert.equal(fs.readFileSync(path.join(f.store.directory, file), 'utf8'), '用户自己修改');
  assert.equal(f.store.get(note.id).data.content, '系统新修改');
});

test('copy failures and tampered cleanup mappings cannot delete originals or files outside the workspace', async t => {
  const f = fixture(t), source = path.join(f.dir, 'input.txt');
  fs.writeFileSync(source, 'protected');
  const asset = await importAttachment(f.store, source, { domain: f.domain }), original = f.store.assetLocation(asset.id).path;
  const copy = fs.promises.copyFile;
  try {
    fs.promises.copyFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    assert.match((await new LocalHierarchy(f.store).refresh()).errors[0].message, /disk full/);
  } finally { fs.promises.copyFile = copy; }
  assert.ok(fs.existsSync(original)); assert.equal(f.store.assetLocation(asset.id).path, original);
  f.store.local('hierarchyFiles', { '../input.txt': 'invalid' });
  assert.ok((await new LocalHierarchy(f.store).refresh()).errors.length);
  assert.equal(fs.readFileSync(source, 'utf8'), 'protected');
});

test('Agent reads authorized folders, proposes placement, rejects cross-scope and direct moves', t => {
  const f = fixture(t), folder = f.folder('目录'), note = f.note();
  const access = new AgentAccess(f.store), issued = access.createGrant({ name: 'test', domains: [f.domain], edit: true });
  const grant = access.grants().find(item => item.id === issued.id), version = access.preferences().version;
  const dispatch = (method, input) => access.dispatch(grant, { method, input, requestId: uuid() });
  assert.equal(dispatch('search', { type: 'folder' }).records[0].id, folder.id);
  for (const method of ['folderSave', 'recordMove', 'localHierarchyRefresh']) assert.throws(() => dispatch(method, {}), /未授权/);
  assert.throws(() => dispatch('noteUpdate', { id: note.id, parents: note.heads, preferencesVersion: version,
    data: { ...note.data, folderId: folder.id } }), /目录归属/);
  const proposal = dispatch('propose', { domain: f.domain, preferencesVersion: version, items: [{
    targetId: note.id, parents: note.heads, data: { ...note.data, folderId: folder.id }
  }] });
  f.store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads);
  assert.equal(f.store.get(note.id).data.folderId, folder.id);
  f.store.moveRecord({ id: note.id, folderId: null, parents: f.store.get(note.id).heads });
  assert.equal(f.store.remove(folder.id, folder.heads).deleted, true);
  const other = f.store.saveLibrary({ title: '私有' });
  const privateFolder = f.store.saveFolder({ title: '私有目录', domain: other.data.domain });
  assert.throws(() => dispatch('draftCreate', { preferencesVersion: version, data: { title: '越界', domain: f.domain, folderId: privateFolder.id } }), /知识库|同库/);
});

test('local hierarchy is automatic and retired services remain unavailable', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), service = new Service(directory);
  t.after(() => service.close());
  assert.equal((await service.call('localHierarchyStatus')).enabled, true);
  assert.deepEqual(await service.call('folders'), []);
  await assert.rejects(service.call('backupCreate'), /Unsupported/);
});
