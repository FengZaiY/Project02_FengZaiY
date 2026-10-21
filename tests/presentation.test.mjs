import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store } from '../src/core/store.mjs';
import { uuid, sha } from '../src/core/util.mjs';
import { validatePresentation, validatePageCss, validatePageHtml } from '../src/core/presentation-schema.mjs';
import { presentationHash } from '../src/core/presentation.mjs';
import { richReferences } from '../src/core/rich-content.mjs';
import { references, previewTrash } from '../src/core/trash.mjs';
import { presentationFixture } from '../scripts/fixtures/presentation.mjs';

function setup(t) {
  const root = path.resolve('artifacts/presentation-core'); fs.mkdirSync(root, { recursive: true });
  const service = new Service(fs.mkdtempSync(path.join(root, 'case-'))); t.after(() => service.close());
  const store = service.store, library = store.saveLibrary({ title: '交互验证' }), other = store.saveLibrary({ title: '独立范围' });
  const grant = service.agents.createGrant({ name: '验证 Agent', domains: [library.data.domain], edit: true });
  const access = service.agents.grants().find(g => g.id === grant.id);
  const rpc = (method, input, requestId = uuid()) => service.agents.dispatch(access, { method, input: { preferencesVersion: service.agents.preferences().version, ...input }, requestId });
  const data = { title: '交互笔记', domain: library.data.domain, content: '<p>正文</p>', format: 'html', sourceIds: [], assetIds: [] };
  return { service, store, library, other, rpc, data };
}

test('page contract rejects executable markup, network CSS, undeclared refs and oversized versions', t => {
  const { store, data } = setup(t), page = presentationFixture(data);
  assert.equal(validatePresentation(page), page);
  for (const html of ['<script>1</script>', '<iframe></iframe>', '<img src="https://bad.test/x">', '<button onclick="1">x</button>', '<input type="file">', '<a href="https://bad.test">x</a>', `<img data-asset-id="${uuid()}">`]) assert.throws(() => validatePageHtml(html, page));
  for (const css of ['@import "https://bad.test/x";', 'p{background:url(https://bad.test/x)}', 'p{background:u\\72l(https://bad.test/x)}', '@font-face{font-family:a;src:url(x)}', 'p{color:expression(1)}']) assert.throws(() => validatePageCss(css));
  assert.throws(() => validatePresentation({ ...page, unknown: true }));
  assert.throws(() => store.write({ type: 'note', data: { ...data, content: 'x'.repeat(1024 * 1024), presentation: page } }));
});

test('old clients preserve page; body changes invalidate it; explicit remove and history restore are versioned', t => {
  const { store, data } = setup(t);
  const plain = store.write({ type: 'note', data });
  const withPage = store.write({ id: plain.id, parents: plain.heads, type: 'note', data: { ...data, presentation: presentationFixture(data) } });
  const edited = store.write({ id: plain.id, parents: withPage.heads, type: 'note', data: { ...data, content: '<p>人工修改</p>' } });
  assert.deepEqual(edited.data.presentation, withPage.data.presentation);
  assert.notEqual(presentationHash(edited.data), edited.data.presentation.basis.contentHash);
  const restored = store.restoreVersion(plain.id, plain.heads[0], edited.heads);
  assert.equal(restored.data.presentation, null);
  assert.equal(store.event(withPage.heads[0]).data.presentation.v, 1);
});

test('agent page proposals are atomic, idempotent, partially accepted and revisable; direct replacement denied', t => {
  const { store, rpc, data } = setup(t);
  const note = store.write({ type: 'note', data });
  const page = presentationFixture(data), key = uuid();
  const input = { title: '交互方案', domain: data.domain, items: [{ targetId: note.id, parents: note.heads, data: { ...data, presentation: page } }, { data: { ...data, title: '下一篇' } }] };
  const proposal = rpc('propose', input, key);
  assert.equal(rpc('propose', input, key).id, proposal.id);
  assert.equal(store.get(note.id).data.presentation, undefined);
  const accepted = store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads);
  assert.deepEqual(store.get(note.id).data.presentation, page);
  assert.equal(accepted.data.items[1].status, 'pending');
  assert.throws(() => rpc('proposalRevise', { id: proposal.id, parents: accepted.heads, items: [{ id: accepted.data.items[0].id, data }] }));
  const current = store.get(note.id);
  assert.throws(() => rpc('noteUpdate', { id: note.id, parents: current.heads, data: { ...data, presentation: null } }), /用户确认/);
  const edited = rpc('noteUpdate', { id: note.id, parents: current.heads, data: { ...data, content: '<p>新正文</p>' } });
  assert.deepEqual(edited.data.presentation, page);
});

test('changed source and dirty targets block confirmation without partial writes', t => {
  const { store, rpc, data } = setup(t), draft = store.write({ type: 'draft', data });
  const page = presentationFixture(data, { basis: { contentHash: presentationHash(data), sources: [{ id: draft.id, versionId: draft.heads[0] }] } });
  const proposal = rpc('propose', { title: '提案', domain: data.domain, items: [{ data }, { data: { ...data, presentation: page } }] });
  store.write({ id: draft.id, type: 'draft', parents: draft.heads, data: { ...data, content: '新的来源' } });
  assert.throws(() => store.approve(proposal.id, proposal.data.items.map(i => i.id), proposal.heads), /依据已变化/);
  assert.equal(store.get(proposal.data.items[0].targetId), null);
  assert.equal(store.get(proposal.id).data.items[0].status, 'pending');
});

test('body-only proposal preserves a stale page; local redo and explicit removal require review', t => {
  const { store, rpc, data } = setup(t);
  const page = presentationFixture(data);
  const note = store.write({ type: 'note', data: { ...data, presentation: page } });
  const changed = { ...data, content: '<p>人工补充</p>' };
  const proposal = rpc('propose', { title: '补正文', domain: data.domain, items: [{ targetId: note.id, parents: note.heads, data: changed }] });
  assert.deepEqual(proposal.data.items[0].data.presentation, page);
  store.local('workspace', { tabs: [{ id: note.id, recordId: note.id, dirty: true }] });
  assert.throws(() => store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads), /未保存/);
  store.local('workspace', { tabs: [] });
  store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads);
  const current = store.get(note.id);
  assert.deepEqual(current.data.presentation, page);
  const redo = rpc('propose', { title: '重新设计', domain: data.domain, items: [{ targetId: note.id, parents: current.heads, data: { ...changed, presentation: presentationFixture(changed) } }] });
  const revised = rpc('proposalRevise', { id: redo.id, parents: redo.heads, items: [{ id: redo.data.items[0].id, data: { ...changed, presentation: null } }] });
  assert.deepEqual(store.get(note.id).data.presentation, page);
  store.approve(revised.id, [revised.data.items[0].id], revised.heads);
  assert.equal(store.get(note.id).data.presentation, null);
});

test('page refs participate in agent scope, historical sensitivity, deletion and missing-asset protection', t => {
  const { store, rpc, data, other } = setup(t);
  const foreign = store.write({ type: 'note', data: { ...data, domain: other.data.domain } });
  assert.throws(() => rpc('propose', { title: '越权', domain: data.domain, items: [{ data: { ...data, presentation: presentationFixture(data, { noteIds: [foreign.id] }) } }] }), /未授权/);
  const asset = store.write({ type: 'asset', data: { title: '图片', domain: data.domain, filename: 'a.png', mime: 'image/png', size: 3, sha256: sha('abc'), priority: 'normal' } });
  const page = presentationFixture(data, { assetIds: [asset.id], html: `<img data-asset-id="${asset.id}">` });
  assert.ok(richReferences({ presentation: page }).assets.includes(asset.id));
  assert.ok(references({ presentation: page }).has(asset.id));
  const proposal = rpc('propose', { title: '缺件', domain: data.domain, items: [{ data: { ...data, presentation: page } }] });
  assert.throws(() => store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads), /尚未下载/);
  const secret = store.write({ type: 'source', data: { ...data, sensitive: true } });
  store.write({ id: secret.id, type: 'source', parents: secret.heads, data });
  const historical = { ...page, assetIds: [], html: '', basis: { contentHash: presentationHash(data), sources: [{ id: secret.id, versionId: secret.heads[0] }] } };
  store.write({ type: 'note', data: { ...data, presentation: historical } });
  const record = store.list({ type: 'note' }).find(item => item.data.presentation);
  assert.throws(() => rpc('record', { id: record.id }), /敏感/);
});

test('two independent stores retain pages through repeated import and preserve concurrent edits', t => {
  const { store, data } = setup(t), remote = new Store(path.join(store.directory, 'remote')); t.after(() => remote.close());
  const note = store.write({ type: 'note', data: { ...data, presentation: presentationFixture(data) } });
  remote.importEvents(store.allEvents()); remote.importEvents(store.allEvents());
  assert.deepEqual(remote.get(note.id).data.presentation, note.data.presentation);
  const left = store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...data, content: 'left' } });
  const right = remote.write({ id: note.id, type: 'note', parents: note.heads, data: { ...data, content: 'right' } });
  store.importEvents(remote.allEvents());
  assert.equal(store.get(note.id).conflict, true);
  assert.deepEqual(new Set(store.get(note.id).heads), new Set([...left.heads, ...right.heads]));
});

test('historical page references protect deletion and complete local JSON retains executable source', async t => {
  const { service, store, data } = setup(t);
  const source = store.write({ type: 'draft', data: { ...data, title: '历史设计依据' } });
  const page = presentationFixture(data);
  page.basis.sources = [{ id: source.id, versionId: source.heads[0] }];
  const note = store.write({ type: 'note', data: { ...data, presentation: page } });
  await service.organizeLocal();
  const files = Object.keys(store.local('hierarchyFiles'));
  const json = files.find(file => file.endsWith(`${note.id}.json`));
  const md = files.find(file => file.endsWith(`${note.id}.md`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.directory, json), 'utf8')).data.presentation, page);
  assert.match(fs.readFileSync(path.join(store.directory, md), 'utf8'), /不包含可运行交互/);
  store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...data, presentation: null } });
  store.remove(source.id, source.heads);
  assert.ok(previewTrash(store).blocked.some(item => item.id === source.id));
});

test('page confirmation detects altered attachment bytes even when size is unchanged', t => {
  const { store, rpc, data } = setup(t);
  const asset = store.write({ type: 'asset', data: { title: '原件', domain: data.domain, filename: 'a.png', mime: 'image/png', size: 3, sha256: sha('abc'), priority: 'normal' } });
  const file = path.join(store.directory, 'fixture.png'); fs.writeFileSync(file, 'abc'); store.bindAsset(asset.id, file);
  const page = presentationFixture(data, { assetIds: [asset.id] });
  const proposal = rpc('propose', { title: '原件检查', domain: data.domain, items: [{ data: { ...data, presentation: page } }] });
  fs.writeFileSync(file, 'xyz');
  assert.throws(() => store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads), /校验失败/);
  assert.equal(store.get(proposal.id).data.items[0].status, 'pending');
});
