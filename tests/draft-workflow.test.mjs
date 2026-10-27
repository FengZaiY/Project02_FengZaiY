import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call as mcpCall } from '../skills/fengzaiy/scripts/client.mjs';
import path from 'node:path';
import { Store, validateEvent } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { archiveDraft, draftWorkflows, cleanupProposal } from '../src/core/draft-workflow.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { previewTrash, emptyTrash, prepareRemoteErasure } from '../src/core/trash.mjs';
import { createErasure } from '../src/core/erasures.mjs';
import { hashFile, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/draft-workflow-tests'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(directory, 'A'));
  t.after(() => store.close());
  const domain = store.saveLibrary({ title: '研究资料' }).data.domain;
  const draft = store.write({ type: 'draft', data: { title: '课程摘录', domain, format: 'html', content: '<p><strong>保留原文</strong></p><table><tr><td>条件</td></tr></table>', tags: ['案例'] } });
  const access = new AgentAccess(store), issued = access.createGrant({ name: '助手', domains: [domain], edit: true });
  const grant = access.grants().find(item => item.id === issued.id);
  const call = (method, input, requestId = uuid()) => access.dispatch(grant, { method, requestId, input: { preferencesVersion: access.preferences().version, ...input } });
  const propose = (source = draft) => call('propose', { domain, items: ['概念', '案例'].map(title => ({
    draftRefs: [{ id: source.id, versionId: source.heads[0], complete: true }], data: { title, domain, content: `${title}正文` }
  })) });
  const status = () => draftWorkflows(store).get(draft.id).status;
  t.after(() => access.close());
  return { directory, store, domain, draft, access, call, propose, status, issued };
}

test('direct archive keeps rich body, attachments, sources, history, hierarchy; retry is idempotent', async t => {
  const f = fixture(t), source = f.store.write({ type: 'source', data: { title: '官网', domain: f.domain, url: 'https://example.invalid/course' } });
  const file = path.join(f.directory, 'file.txt'); fs.writeFileSync(file, '原文件');
  const asset = await importAttachment(f.store, file, { domain: f.domain });
  const draft = f.store.write({ id: f.draft.id, type: 'draft', parents: f.draft.heads, data: { ...f.draft.data, sourceIds: [source.id], assetIds: [asset.id], sensitive: true } });
  const targetDomain = f.store.saveLibrary({ title: '归档库' }).data.domain;
  const parent = f.store.write({ data: { title: '专题', domain: targetDomain } });
  const input = { id: draft.id, parents: draft.heads, domain: targetDomain, parentNoteId: parent.id };
  const note = archiveDraft(f.store, input), count = f.store.allEvents().length;
  assert.equal(note.data.content, draft.data.content);
  assert.equal(note.data.format, 'html'); assert.equal(note.data.sensitive, true);
  assert.deepEqual(note.data.assetIds, [asset.id]); assert.deepEqual(note.data.sourceIds, [source.id, draft.id]);
  assert.deepEqual(note.data.tags, draft.data.tags); assert.equal(note.data.parentNoteId, parent.id);
  assert.equal(f.store.history(draft.id).length, 2); assert.equal(f.status(), 'processed');
  assert.equal(archiveDraft(f.store, input).id, note.id); assert.equal(f.store.allEvents().length, count);
  await new LocalHierarchy(f.store).refresh();
  assert.equal(await hashFile(f.store.assetLocation(asset.id).path), asset.data.sha256);
  for (const event of f.store.allEvents()) validateEvent(event);
});

test('archive rejects stale, dirty, invalid parent and deleted source without partial writes', t => {
  const f = fixture(t), input = { id: f.draft.id, parents: f.draft.heads, domain: f.domain };
  const count = f.store.allEvents().length;
  assert.throws(() => archiveDraft(f.store, { ...input, parentNoteId: uuid() }));
  assert.equal(f.store.allEvents().length, count);
  f.store.local('workspace', { tabs: [{ recordId: f.draft.id, dirty: true }] });
  assert.throws(() => archiveDraft(f.store, input), /未保存/);
  f.store.local('workspace', { tabs: [] });
  const draft = f.store.write({ id: f.draft.id, type: 'draft', parents: f.draft.heads, data: { ...f.draft.data, content: '新内容' } });
  assert.throws(() => archiveDraft(f.store, input), /修改/);
  f.store.remove(draft.id, draft.heads);
  assert.throws(() => archiveDraft(f.store, { ...input, parents: f.store.headIds(draft.id) }), /草稿/);
  assert.equal(f.store.list({ type: 'note' }).length, 0);
});

test('review transitions pending / partial / processed, preserves source and reopens changed drafts', t => {
  const f = fixture(t), proposal = f.propose();
  assert.equal(f.status(), 'pending');
  const first = f.store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads);
  assert.equal(f.status(), 'partial');
  assert.deepEqual(f.store.get(f.draft.id).heads, f.draft.heads);
  const receipt = first.data.items[0];
  assert.equal(f.store.event(receipt.acceptedVersionId).entityId, receipt.targetId);
  assert.ok(f.store.get(receipt.targetId).data.sourceIds.includes(f.draft.id));
  const revised = f.call('proposalRevise', { id: first.id, parents: first.heads, items: [{ id: first.data.items[1].id, data: { ...first.data.items[1].data, content: '局部重做' } }] });
  assert.deepEqual(revised.data.items[1].draftRefs, proposal.data.items[1].draftRefs);
  const done = f.store.approve(first.id, [first.data.items[1].id], revised.heads);
  assert.equal(f.status(), 'processed');
  const count = f.store.allEvents().length;
  f.store.approve(done.id, done.data.items.map(item => item.id), done.heads);
  assert.equal(f.store.allEvents().length, count);
  f.store.write({ id: f.draft.id, type: 'draft', parents: f.draft.heads, data: { ...f.draft.data, content: '补充知识' } });
  assert.equal(f.status(), 'pending');
  assert.equal(draftWorkflows(f.store).get(f.draft.id).results.length, 2);
  assert.ok(draftWorkflows(f.store).get(f.draft.id).results.every(item => !item.current));
});

test('confirmed proposal cleanup retains notes, sources, attachments and draft evidence through restore', async t => {
  const f = fixture(t);
  const file = path.join(f.directory, 'evidence.txt'); fs.writeFileSync(file, '原件保留');
  const asset = await importAttachment(f.store, file, { domain: f.domain });
  const proposal = f.call('propose', { domain: f.domain, items: [{
    draftRefs: [{ id: f.draft.id, versionId: f.draft.heads[0], complete: true }],
    data: { title: '整理结果', domain: f.domain, content: '结果正文', assetIds: [asset.id] }
  }] });
  const done = f.store.approve(proposal.id, proposal.data.items.map(item => item.id), proposal.heads);
  const target = f.store.get(done.data.items[0].targetId), before = f.store.allEvents().length;
  const cleaned = cleanupProposal(f.store, { id: done.id, parents: done.heads });
  assert.equal(cleaned.deleted, true); assert.equal(f.store.list({ type: 'proposal' }).length, 0);
  assert.equal(f.store.allEvents().length, before + 1); assert.equal(f.status(), 'processed');
  assert.deepEqual(f.store.get(target.id).heads, target.heads);
  assert.ok(target.data.sourceIds.includes(f.draft.id)); assert.deepEqual(target.data.assetIds, [asset.id]);
  assert.equal(await hashFile(f.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.deepEqual(cleanupProposal(f.store, { id: done.id, parents: done.heads }).heads, cleaned.heads);
  assert.equal(f.store.allEvents().length, before + 1);
  const preview = previewTrash(f.store);
  assert.match(preview.blocked.find(item => item.id === done.id).reason, /整理确认记录/);
  emptyTrash(f.store, { token: preview.token, confirmed: true });
  assert.equal(f.status(), 'processed'); assert.ok(f.store.get(asset.id));
  const restored = f.store.restoreVersion(done.id, cleaned.heads[0], cleaned.heads);
  assert.equal(restored.deleted, false); assert.equal(f.status(), 'processed');
  assert.throws(() => cleanupProposal(f.store, { id: done.id, parents: done.heads }), /已变化/);
  cleanupProposal(f.store, { id: done.id, parents: restored.heads });
  assert.equal(f.status(), 'processed');
});

test('cleanup rejects incomplete, empty, dirty, stale and concurrent proposals without writes', t => {
  const f = fixture(t), p = f.propose();
  assert.throws(() => cleanupProposal(f.store, { id: f.draft.id, parents: f.draft.heads }), /整理方案/);
  assert.throws(() => cleanupProposal(f.store, { id: p.id, parents: p.heads }), /待确认/);
  const partial = f.store.approve(p.id, [p.data.items[0].id], p.heads);
  assert.throws(() => cleanupProposal(f.store, { id: p.id, parents: partial.heads }), /待确认/);
  const done = f.store.approve(p.id, p.data.items.map(item => item.id), partial.heads);
  let count = f.store.allEvents().length;
  assert.throws(() => cleanupProposal(f.store, { id: p.id, parents: partial.heads }), /已变化/);
  f.store.local('workspace', { tabs: [{ recordId: p.id, dirty: true }] });
  assert.throws(() => cleanupProposal(f.store, { id: p.id, parents: done.heads }), /未保存/);
  f.store.local('workspace', { tabs: [] }); assert.equal(f.store.allEvents().length, count);
  f.store.write({ id: p.id, type: 'proposal', parents: p.heads, data: p.data, allowBranch: true });
  count = f.store.allEvents().length;
  assert.throws(() => cleanupProposal(f.store, { id: p.id, parents: f.store.headIds(p.id) }), /无冲突/);
  assert.equal(f.store.allEvents().length, count);
  const empty = f.store.write({ type: 'proposal', data: { title: '空方案', domain: f.domain, items: [] } });
  assert.throws(() => cleanupProposal(f.store, { id: empty.id, parents: empty.heads }), /待确认/);
});

test('proposal evidence protects remote erasure but permits clearing the entire referenced group', t => {
  const f = fixture(t), p = f.propose();
  const done = f.store.approve(p.id, p.data.items.map(item => item.id), p.heads);
  cleanupProposal(f.store, { id: done.id, parents: done.heads });
  const receipt = createErasure(f.store, p.id);
  assert.throws(() => prepareRemoteErasure(f.store, [receipt]), /草稿处理记录/);
  for (const item of done.data.items) { const note = f.store.get(item.targetId); f.store.remove(note.id, note.heads); }
  f.store.remove(f.draft.id, f.draft.heads);
  const preview = previewTrash(f.store);
  assert.equal(preview.blocked.length, 0);
  const receipts = preview.eligible.map(item => createErasure(f.store, item.id));
  assert.doesNotThrow(() => prepareRemoteErasure(f.store, receipts));
  emptyTrash(f.store, { token: preview.token, confirmed: true });
  assert.equal(f.store.get(p.id), null); assert.equal(f.store.get(f.draft.id), null);
});

test('confirmed proposals without draft dependencies can be permanently cleared without deleting notes', t => {
  const f = fixture(t);
  const p = f.call('propose', { domain: f.domain, items: [{ data: { title: '独立整理', domain: f.domain } }] });
  const done = f.store.approve(p.id, p.data.items.map(item => item.id), p.heads);
  cleanupProposal(f.store, { id: done.id, parents: done.heads });
  const preview = previewTrash(f.store); assert.ok(preview.eligible.some(item => item.id === p.id));
  emptyTrash(f.store, { token: preview.token, confirmed: true });
  assert.equal(f.store.get(p.id), null); assert.ok(f.store.get(done.data.items[0].targetId));
});

test('approval rejects changed source, dirty target, partial failure and concurrent proposal', t => {
  const f = fixture(t), proposal = f.propose();
  f.store.local('workspace', { tabs: [{ recordId: proposal.data.items[1].targetId, dirty: true }] });
  const count = f.store.allEvents().length;
  assert.throws(() => f.store.approve(proposal.id, proposal.data.items.map(item => item.id), proposal.heads), /未保存/);
  assert.equal(f.store.allEvents().length, count); assert.equal(f.status(), 'pending');
  f.store.local('workspace', { tabs: [] });
  f.store.write({ id: f.draft.id, type: 'draft', parents: f.draft.heads, data: { ...f.draft.data, content: '来源改变' } });
  assert.throws(() => f.store.approve(proposal.id, [proposal.data.items[0].id], proposal.heads), /来源草稿已修改/);
  assert.equal(f.store.list({ type: 'note' }).length, 0);
});

test('partial extraction stays partial until a full reviewed plan covers the current source', t => {
  const f = fixture(t);
  const p = f.call('propose', { domain: f.domain, items: [{ draftRefs: [{ id: f.draft.id, versionId: f.draft.heads[0] }], data: { title: '仅第一部分', domain: f.domain, content: '局部结果' } }] });
  f.store.approve(p.id, [p.data.items[0].id], p.heads); assert.equal(f.status(), 'partial');
  const full = f.propose(); f.store.approve(full.id, full.data.items.map(item => item.id), full.heads); assert.equal(f.status(), 'processed');
});

test('deleted/conflicting results do not count as complete and draft references protect trash', t => {
  const f = fixture(t), note = archiveDraft(f.store, { id: f.draft.id, parents: f.draft.heads, domain: f.domain });
  f.store.remove(note.id, note.heads); assert.equal(f.status(), 'pending');
  const restored = f.store.restoreVersion(note.id, note.heads[0], f.store.headIds(note.id));
  assert.equal(f.status(), 'processed');
  f.store.write({ id: note.id, parents: note.heads, allowBranch: true, data: { ...note.data, content: '并发' } });
  assert.equal(f.status(), 'pending');
  assert.ok(restored);
  f.store.remove(f.draft.id, f.draft.heads);
  assert.ok(previewTrash(f.store).blocked.some(item => item.id === f.draft.id));
});

test('full-access Agent reads all sources but cannot approve/archive, forge origin or drop pending links', t => {
  const f = fixture(t), p = f.propose(), partial = f.store.approve(p.id, [p.data.items[0].id], p.heads);
  assert.throws(() => f.call('draftArchive', { id: f.draft.id }), /未授权/);
  assert.throws(() => f.call('approve', { id: p.id }), /未授权/);
  assert.throws(() => f.call('proposalCleanup', { id: p.id }), /未授权/);
  assert.throws(() => f.call('proposalRevise', { id: p.id, parents: partial.heads,
    items: [{ id: p.data.items[1].id, data: p.data.items[1].data, draftRefs: [] }] }), /不能移除/);
  assert.throws(() => f.call('propose', { domain: f.domain, items: [{ data: { title: '伪造', domain: f.domain, draftOrigin: { id: f.draft.id, versionId: f.draft.heads[0] } } }] }), /归档来源/);
  const other = f.store.saveLibrary({ title: '未授权库' });
  const hidden = f.store.write({ type: 'draft', data: { title: '隐私', domain: other.data.domain } });
  assert.ok(f.call('propose', { domain: f.domain, items: [{ draftRefs: [{ id: hidden.id, versionId: hidden.heads[0] }], data: { title: '跨库引用', domain: f.domain } }] }).id);
  const secret = f.store.write({ type: 'draft', data: { title: '敏感', domain: f.domain, sensitive: true } });
  assert.ok(f.propose(secret).data.items.every(item => item.data.sensitive));
  const publicDraft = f.store.write({ id: secret.id, type: 'draft', parents: secret.heads, data: { ...secret.data, sensitive: false } });
  const note = archiveDraft(f.store, { id: publicDraft.id, parents: publicDraft.heads, domain: f.domain });
  assert.ok(f.call('record', { id: note.id }));
  const forgedHistorical = f.store.write({ data: { title: '旧敏感来源', domain: f.domain, draftOrigin: { id: secret.id, versionId: secret.heads[0] } } });
  assert.equal(f.call('record', { id: forgedHistorical.id }).id, forgedHistorical.id);
});

test('v3 sync retains receipts and source histories; duplicate import and concurrent archive preserve evidence', async t => {
  const f = fixture(t), other = new Store(path.join(f.directory, 'B')); t.after(() => other.close());
  const key = makePairingKey(), cloud = path.join(f.directory, 'cloud');
  const a = new CurrentSync(f.store), b = new CurrentSync(other); a.configure(cloud, key); b.configure(cloud, key);
  await a.publish(); await b.importLatest();
  const note = archiveDraft(f.store, { id: f.draft.id, parents: f.draft.heads, domain: f.domain });
  const local = archiveDraft(other, { id: f.draft.id, parents: f.draft.heads, domain: f.domain });
  assert.equal(note.id, local.id);
  await a.publish(); await b.importLatest();
  assert.equal(other.get(note.id).conflict, true); assert.equal(draftWorkflows(other).get(f.draft.id).status, 'pending');
  const count = other.allEvents().length; await b.importLatest(); assert.equal(other.allEvents().length, count);
  const p = f.propose(); f.store.approve(p.id, p.data.items.map(item => item.id), p.heads);
  await a.publish(); await b.importLatest();
  assert.equal(draftWorkflows(other).get(f.draft.id).status, 'processed');
  assert.equal(other.history(f.draft.id).length, 1);
  const done = f.store.get(p.id);
  cleanupProposal(f.store, { id: p.id, parents: done.heads });
  await a.publish(); await b.importLatest();
  assert.equal(other.get(p.id).deleted, true);
  assert.equal(draftWorkflows(other).get(f.draft.id).status, 'processed');
  const cleanedCount = other.allEvents().length;
  await b.importLatest(); assert.equal(other.allEvents().length, cleanedCount);
});

test('draft filtering precedes pagination and search can include processed drafts', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), service = new Service(directory); t.after(() => service.close());
  const domain = service.store.saveLibrary({ title: '筛选库' }).data.domain;
  for (let i = 0; i < 4; i++) {
    const draft = await service.call('save', { type: 'draft', data: { title: `筛选${i}`, domain } });
    if (i < 3) await service.call('draftArchive', { id: draft.id, parents: draft.heads, domain });
  }
  const rows = await service.call('records', { type: 'draft', domain, processing: 'active', limit: 1 });
  assert.equal(rows.length, 1); assert.equal(rows[0].data.title, '筛选3');
  assert.equal((await service.call('records', { type: 'draft', domain, processing: 'processed' })).length, 3);
  assert.equal((await service.call('records', { type: 'draft', query: '筛选', processing: 'all' })).length, 4);
});

test('MCP Agent may submit versioned proposals but cannot invoke trusted archive methods', async t => {
  const f = fixture(t); await f.access.configure(true);
  const request = (method, input) => mcpCall(method, { preferencesVersion: f.access.preferences().version, ...input }, uuid(),
    { FENGZAIY_AGENT_URL: f.access.status().mcpUrl, FENGZAIY_AGENT_TOKEN: f.issued.token });
  const created = await request('propose', { domain: f.domain, items: [{ draftRefs: [{ id: f.draft.id, versionId: f.draft.heads[0], complete: true }],
    data: { title: 'MCP 草稿整理', domain: f.domain, content: '整理结果' } }] });
  assert.equal(created.data.items[0].draftRefs[0].complete, true);
  for (const method of ['draftArchive', 'draftWorkflow', 'approve', 'proposalCleanup']) await assert.rejects(request(method, { id: f.draft.id }), /FORBIDDEN/);
  assert.equal(f.status(), 'pending');
});
