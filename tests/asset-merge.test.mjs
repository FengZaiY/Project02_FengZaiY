import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store } from '../src/core/store.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { replaceAssetReferences } from '../src/core/asset-merge.mjs';
import { uuid, hashFile } from '../src/core/util.mjs';

const root = path.resolve('artifacts/asset-merge-tests');
fs.mkdirSync(root, { recursive: true });
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const service = new Service(path.join(directory, 'workspace')), store = service.store;
  t.after(() => service.close());
  const library = store.saveLibrary({ title: '资料库' }), other = store.saveLibrary({ title: '另一库' });
  const file = path.join(directory, '原文件.txt');
  fs.writeFileSync(file, 'identical imported content');
  const call = (method, input) => service.call(method, input);
  const create = (options = {}) => call('assetImport', { path: file, domain: library.id, ...options });
  const a = await create(), b = await create({ duplicateMode: 'separate' });
  const selection = { ids: [a.id, b.id], targetId: a.id };
  const preview = () => call('assetMergePreview', selection);
  const merge = async value => call('assetMerge', { ...selection, token: (value || await preview()).token, confirmed: true });
  return { directory, service, store, library, other, file, call, create, a, b, selection, preview, merge };
}

test('same-library imports reuse original identity and organized path, restore missing originals and serialize concurrent imports', async t => {
  const f = await setup(t);
  const renamed = path.join(f.directory, '不同名称.txt'); fs.copyFileSync(f.file, renamed);
  const duplicate = await f.call('assetImport', { path: renamed, domain: f.library.id });
  assert.equal(duplicate.reused, true);
  const canonical = duplicate.id;
  await f.call('assetUpdate', { id: canonical, parents: duplicate.heads, changes: { title: '保留名称', tags: ['保留标签'], sensitive: true } });
  const metadata = f.store.get(canonical);
  await f.call('assetPin', { id: canonical, pinned: true });
  await f.service.organizeLocal();
  const location = f.store.assetLocation(canonical).path;
  assert.equal((await f.create()).id, canonical);
  assert.equal(f.store.assetLocation(canonical).path, location);
  assert.deepEqual(f.store.get(canonical).heads, metadata.heads);
  assert.equal(f.store.assetLocation(canonical).pinned, 1);
  fs.unlinkSync(location);
  assert.equal((await f.create()).id, canonical);
  assert.equal(await hashFile(f.store.assetLocation(canonical).path), metadata.data.sha256);
  const another = await f.create({ domain: f.other.id });
  assert.notEqual(another.id, canonical);
  assert.equal((await f.call('assetCatalog', { domain: f.other.id })).rows[0].duplicateCount, 1);
  const newFile = path.join(f.directory, 'concurrent.txt'); fs.writeFileSync(newFile, 'concurrent new bytes');
  const results = await Promise.all(Array.from({ length: 5 }, () => f.call('assetImport', { path: newFile, domain: f.library.id })));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  assert.equal(results.filter(item => !item.reused).length, 1);
});

test('recycled and conflicted records are not reused, explicit binding keeps identity and corrupted managed content is not overwritten', async t => {
  const f = await setup(t);
  await f.call('assetBatch', { action: 'trash', items: [f.a, f.b].map(a => ({ id: a.id, parents: a.heads })) });
  const newRecord = await f.create();
  assert.ok(!f.selection.ids.includes(newRecord.id));
  f.store.write({ id: newRecord.id, type: 'asset', parents: newRecord.heads, data: { ...newRecord.data, title: '分支一' } });
  f.store.write({ id: newRecord.id, type: 'asset', parents: newRecord.heads, data: { ...newRecord.data, title: '分支二' }, allowBranch: true });
  const usable = await f.create();
  assert.notEqual(usable.id, newRecord.id);
  assert.equal((await f.create({ expectedId: f.a.id })).id, f.a.id);
  assert.equal(f.store.get(f.a.id).deleted, true, 'Binding does not silently restore recycled records');
  const location = f.store.assetLocation(usable.id).path;
  fs.writeFileSync(location, 'corrupted');
  await assert.rejects(f.create(), /校验失败/);
  assert.equal(fs.readFileSync(location, 'utf8'), 'corrupted');
});

test('merge rewrites current rich links, media and source fields atomically while preserving metadata, layout and historical originals', async t => {
  const f = await setup(t);
  const asset = f.b.id;
  const block = JSON.stringify({ v: 1, kind: 'image', label: '保持标题', assetId: asset }).replaceAll('"', '&quot;');
  const content = `<p data-user="keep">正文 <a href="studyself://asset/${asset}">原文</a></p><figure data-ss-block="${block}" data-ss-layout='{"width":60,"height":null,"align":"left"}'></figure><pre>studyself://asset/${asset}</pre>`;
  const note = f.store.write({ type: 'note', data: { title: '引用笔记', domain: f.library.id, format: 'html', content, assetIds: [f.a.id, asset] } });
  const source = f.store.write({ type: 'source', data: { title: '来源', domain: f.library.id, url: `studyself://asset/${asset}` } });
  const proposal = f.store.write({ type: 'proposal', data: { title: '待确认方案', domain: f.library.id, items: [{ id: uuid(), targetId: uuid(), parents: [], data: { title: '待确认', domain: f.library.id, assetIds: [asset] } }] } });
  await f.call('assetUpdate', { id: asset, parents: f.b.heads, changes: { tags: ['标签乙'], sensitive: true } });
  const plan = await f.preview();
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.changes.length, 3);
  assert.equal(plan.sensitive, true);
  const result = await f.merge(plan);
  assert.equal(result.retired[0], asset);
  assert.deepEqual(f.store.get(note.id).data.assetIds, [f.a.id]);
  const after = f.store.get(note.id).data.content;
  assert.ok(after.includes(`href="studyself://asset/${f.a.id}"`));
  assert.ok(after.includes(`assetId&quot;:&quot;${f.a.id}`));
  assert.ok(after.includes(`data-ss-layout='{"width":60,"height":null,"align":"left"}'`));
  assert.ok(after.includes(`<pre>studyself://asset/${asset}</pre>`));
  assert.equal(f.store.history(note.id).find(v => v.id === note.heads[0]).data.content, content);
  assert.equal(f.store.get(source.id).data.url, `studyself://asset/${f.a.id}`);
  assert.deepEqual(f.store.get(proposal.id).data.items[0].data.assetIds, [f.a.id]);
  assert.equal(f.store.get(asset).deleted, true);
  assert.ok(fs.existsSync(f.store.assetLocation(asset).path));
  assert.deepEqual(f.store.get(f.a.id).data.tags, ['标签乙']);
  assert.equal(f.store.get(f.a.id).data.sensitive, true);
  await assert.rejects(f.merge(plan), /回收|变化/);
  assert.equal(f.store.history(note.id).length, 2);
  await f.call('assetBatch', { action: 'restore', items: [{ id: asset, parents: f.store.get(asset).heads }] });
  assert.equal(f.store.get(asset).deleted, false);
  assert.equal(await hashFile(f.store.assetLocation(asset).path), f.b.data.sha256);
});

test('merge updates Markdown links without changing code, refuses unsupported link definitions and preserves unknown blocks', () => {
  const from = uuid(), to = uuid(), replacements = new Map([[from, to]]);
  const markdown = `正文 [原件](studyself://asset/${from})\n\n\`studyself://asset/${from}\`\n\n\`\`\`text\n[示例](studyself://asset/${from})\n\`\`\`\n`;
  const changed = replaceAssetReferences({ content: markdown }, replacements).content;
  assert.equal(changed, markdown.replace(`正文 [原件](studyself://asset/${from})`, `正文 [原件](studyself://asset/${to})`));
  assert.throws(() => replaceAssetReferences({ content: `[原件][ref]\n\n[ref]: studyself://asset/${from}` }, replacements), /引用式/);
  assert.throws(() => replaceAssetReferences({ format: 'html', content: '<figure data-ss-block=\'{"v":99,"kind":"future"}\'></figure>' }, replacements), /类型/);
});

test('preview detects unsaved, cross-library and conflicting references and stale versions', async t => {
  const f = await setup(t);
  const note = f.store.write({ type: 'note', data: { title: '引用笔记', domain: f.library.id, assetIds: [f.b.id] } });
  const plan = await f.preview();
  f.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '新增输入' } });
  await assert.rejects(f.merge(plan), { code: 'CONFLICT' });
  f.store.local('workspace', { tabs: [{ recordId: note.id, dirty: true, draft: { ...note.data } }] });
  assert.match((await f.preview()).blocked.join(), /未保存/);
  await assert.rejects(f.merge(), /未保存/);
  f.store.local('workspace', { tabs: [] });
  const extra = f.store.write({ type: 'source', data: { title: '跨库引用', domain: f.other.id, assetIds: [f.b.id] } });
  assert.match((await f.preview()).blocked.join(), /跨库/);
  f.store.write({ id: extra.id, type: extra.type, parents: extra.heads, data: { ...extra.data, assetIds: [] } });
  const latest = f.store.get(note.id);
  f.store.write({ id: note.id, type: 'note', parents: note.heads, data: note.data, allowBranch: true });
  assert.match((await f.preview()).blocked.join(), /冲突/);
  assert.ok(latest);
  await assert.rejects(f.call('assetMerge', { ...f.selection, token: plan.token }), /确认/);
});

test('merge failure rolls back metadata, all earlier reference writes and recycling; missing or corrupt target is blocked', async t => {
  const f = await setup(t);
  const notes = ['甲', '乙'].map(title => f.store.write({ type: 'note', data: { title, domain: f.library.id, assetIds: [f.b.id] } }));
  const plan = await f.preview();
  const write = f.store.writeRaw.bind(f.store);
  let n = 0;
  f.store.writeRaw = input => { if (++n === 2) throw new Error('模拟写入失败'); return write(input); };
  await assert.rejects(f.merge(plan), /模拟写入失败/);
  f.store.writeRaw = write;
  for (const note of notes) assert.deepEqual(f.store.get(note.id).heads, note.heads);
  assert.equal(f.store.get(f.b.id).deleted, false);
  const location = f.store.assetLocation(f.a.id).path;
  fs.writeFileSync(location, Buffer.alloc(f.a.data.size, 0));
  await assert.rejects(f.merge(), /校验失败/);
  fs.unlinkSync(location);
  assert.match((await f.preview()).blocked.join(), /缺失/);
});

test('merge synchronizes new versions, keeps older history and concurrent peer edits instead of overwriting them', async t => {
  const f = await setup(t), peer = new Store(path.join(f.directory, 'peer'));
  t.after(() => peer.close());
  const note = f.store.write({ type: 'note', data: { title: '同步笔记', domain: f.library.id, assetIds: [f.b.id] } });
  const receiver = new CurrentSync(peer), key = makePairingKey(), folder = path.join(f.directory, 'sync');
  f.service.transport.configure(folder, key); receiver.configure(folder, key);
  const publish = async () => { await f.service.transport.plan({ reserveBytes: 0 }); await f.service.transport.publish(); await receiver.importLatest(); };
  await publish();
  peer.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '另一电脑的新输入' } });
  await f.merge(); await publish(); await receiver.importLatest();
  assert.equal(peer.get(note.id).conflict, true);
  assert.ok(peer.get(note.id).versions.some(v => v.data.content === '另一电脑的新输入'));
  assert.ok(peer.get(note.id).versions.some(v => v.data.assetIds.includes(f.a.id)));
  assert.equal(peer.get(f.b.id).deleted, true);
  assert.equal(await hashFile(peer.assetLocation(f.b.id).path), f.b.data.sha256);
});
