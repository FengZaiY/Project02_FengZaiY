import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, validateEvent } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { migratePresentation } from '../src/core/retired-presentation.mjs';
import { createErasure, filterErased } from '../src/core/erasures.mjs';
import { cleanErasedTransport, readHistoryPart } from '../src/core/erasure-sync.mjs';
import { makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { draftWorkflows } from '../src/core/draft-workflow.mjs';
import { runDeletionFiles } from '../src/core/permanent-files.mjs';
import { replacementWorkspaces, retirementReceipts } from '../src/core/retired-ai.mjs';
import { retirePresentation } from '../src/core/retired-presentation.mjs';
import { sealBinary } from '../src/core/sync-objects.mjs';
import { legacyReadingEvent, seedLegacyReading, retiredPage } from '../scripts/fixtures/retired-reading.mjs';
import { canonical, hashFile, sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/retired-reading-core'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  let store = new Store(path.join(directory, 'A'));
  t.after(() => store?.close());
  const domain = store.saveLibrary({ title: '退役隔离资料' }).data.domain;
  return { directory, domain, get store() { return store; }, reopen() { store.close(); store = null; store = new Store(path.join(directory, 'A')); },
    data: { title: '知识正文', domain, content: '<p>保留正文与人工修改</p>', format: 'html' } };
}

test('migration removes page payload from all revisions, caches and projections but keeps identity, sources and original files', async t => {
  const f = fixture(t), source = f.store.write({ type: 'draft', data: f.data });
  const file = path.join(f.directory, 'original.txt'); fs.writeFileSync(file, 'keep original bytes');
  const asset = await importAttachment(f.store, file, { domain: f.domain });
  const first = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data), assetIds: [asset.id], sourceIds: [source.id] } });
  const second = legacyReadingEvent(f.store, { id: first.entityId, parents: [first.id], data: { ...first.data, content: '第二次正文' } });
  seedLegacyReading(f.store, [first, second]);
  f.store.local('workspace', { tabs: [{ id: uuid(), recordId: first.entityId, dirty: true, draft: { ...second.data, content: '未保存输入' } }] });
  f.store.local('v3:test:plan', { metadata: { part: [first, second] }, manifest: { id: uuid() } });
  f.store.local('v3:test:progress', { state: 'paused' });
  f.store.db.exec('CREATE TABLE agent_requests(grant_id TEXT,request_id TEXT,digest TEXT,result TEXT)');
  f.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run('grant', 'request', 'digest', JSON.stringify(f.store.get(first.entityId)));
  await new LocalHierarchy(f.store).refresh({ enable: true });
  const originalHeads = f.store.headIds(first.entityId), count = f.store.allEvents().length;
  f.reopen();
  assert.deepEqual(f.store.headIds(first.entityId), originalHeads);
  assert.equal(f.store.allEvents().length, count);
  for (const event of f.store.history(first.entityId)) {
    assert.equal(event.data.presentation, undefined); validateEvent(event);
    assert.equal(event.retiredPresentation, event.id === first.id ? first.hash : second.hash);
    assert.deepEqual(event.data.assetIds, [asset.id]); assert.deepEqual(event.data.sourceIds, [source.id]);
  }
  assert.equal(f.store.local('workspace').tabs[0].draft.content, '未保存输入');
  assert.equal(f.store.local('workspace').tabs[0].dirty, true);
  assert.equal(f.store.local('workspace').tabs[0].draft.presentation, undefined);
  assert.equal(f.store.local('v3:test:plan'), null);
  assert.equal(f.store.local('v3:test:progress').state, 'cancelled');
  assert.doesNotMatch(f.store.db.prepare('SELECT result FROM agent_requests').get().result, /RETIRED_.*_SECRET/);
  await new LocalHierarchy(f.store).refresh();
  for (const relative of Object.keys(f.store.local('hierarchyFiles'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(f.store.directory, relative), 'utf8'), /RETIRED_.*_SECRET/);
  }
  assert.equal(await hashFile(f.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(migratePresentation(f.store, validateEvent), 0);
  await runDeletionFiles(f.store);
  assert.equal(fs.readFileSync(path.join(f.store.directory, 'knowledge.sqlite')).includes(Buffer.from('RETIRED_PAGE_SECRET')), false);
  const note = f.store.get(first.entityId), restored = f.store.restoreVersion(note.id, first.id, note.heads);
  assert.equal(restored.data.content, first.data.content); assert.equal(restored.data.presentation, undefined);
});

test('invalid old checksum aborts the entire migration; corrected input can retry without losing history', t => {
  const f = fixture(t), good = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data) } });
  const broken = legacyReadingEvent(f.store, { data: { ...f.data, title: '损坏页', presentation: retiredPage(f.data) } });
  seedLegacyReading(f.store, [good, broken]);
  f.store.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify({ ...broken, data: { ...broken.data, content: '改坏的内容' } }), broken.id);
  assert.throws(() => migratePresentation(f.store, validateEvent), /校验失败/);
  assert.equal(f.store.event(good.id).hash, good.hash); assert.ok(f.store.event(good.id).data.presentation);
  f.store.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify(broken), broken.id);
  assert.equal(migratePresentation(f.store, validateEvent), 2);
  assert.equal(migratePresentation(f.store, validateEvent), 0);
  const changed = structuredClone(f.store.event(good.id)); changed.data.content = 'tampered';
  assert.throws(() => validateEvent(changed), /校验失败/);
});

test('pending and rejected histories plus workspace drafts are cleaned and repeated/late old arrivals remain idempotent', t => {
  const f = fixture(t), first = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data) } });
  const child = legacyReadingEvent(f.store, { id: first.entityId, parents: [first.id], data: { ...first.data, content: 'later' } });
  f.store.db.prepare('INSERT INTO pending VALUES(?,?)').run(child.id, JSON.stringify(child));
  const rejected = legacyReadingEvent(f.store, { data: { ...first.data, title: '被拒记录' } });
  f.store.db.prepare('INSERT INTO rejected VALUES(?,?,?)').run(rejected.id, JSON.stringify(rejected), '测试阻塞');
  const workspace = legacyReadingEvent(f.store, { type: 'workspace', data: { title: '工作位置', domain: f.domain,
    tabs: [{ id: uuid(), recordId: first.entityId, dirty: true, draft: first.data }], selectedTab: null } });
  seedLegacyReading(f.store, [workspace]);
  f.reopen();
  assert.equal(JSON.parse(f.store.db.prepare('SELECT json FROM pending').get().json).data.presentation, undefined);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT json FROM rejected').get().json).data.presentation, undefined);
  assert.equal(f.store.event(workspace.id).data.tabs[0].draft.presentation, undefined);
  f.store.importEvents([child, first, workspace]);
  assert.equal(f.store.get(first.entityId).data.content, 'later');
  const count = f.store.allEvents().length;
  f.store.importEvents([first, child]); assert.equal(f.store.allEvents().length, count);
  const forged = structuredClone(f.store.event(first.id)); forged.data.content = '伪造已知版本';
  const { hash, ...body } = forged; forged.hash = sha(canonical(body));
  assert.throws(() => f.store.importEvents([forged]), /collision/);
});

test('confirmed proposal and draft receipts survive migration, recycle and history restoration', t => {
  const f = fixture(t), draft = legacyReadingEvent(f.store, { type: 'draft', data: { ...f.data, presentation: retiredPage(f.data) } });
  const note = legacyReadingEvent(f.store, { data: { ...draft.data, title: '整理结果', sourceIds: [draft.entityId] } });
  const proposal = legacyReadingEvent(f.store, { type: 'proposal', data: { title: '已确认', domain: f.domain,
    items: [{ id: uuid(), targetId: note.entityId, parents: [], status: 'accepted', acceptedVersionId: note.id,
      draftRefs: [{ id: draft.entityId, versionId: draft.id, complete: true }], data: note.data }] } });
  seedLegacyReading(f.store, [draft, note, proposal]); f.reopen();
  assert.equal(f.store.get(proposal.entityId).data.items[0].data.presentation, undefined);
  assert.equal(draftWorkflows(f.store).get(draft.entityId).status, 'processed');
  f.store.remove(proposal.entityId, [proposal.id]);
  assert.equal(draftWorkflows(f.store).get(draft.entityId).status, 'processed');
  const restored = f.store.restoreVersion(note.entityId, note.id, [note.id]);
  assert.equal(restored.data.content, note.data.content);
  assert.equal(draftWorkflows(f.store).get(draft.entityId).status, 'processed');
});

test('old and new erasure receipts use the same historical identity after retirement', t => {
  const f = fixture(t), old = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data) } });
  seedLegacyReading(f.store, [old]);
  const receipt = createErasure(f.store, old.entityId);
  migratePresentation(f.store, validateEvent);
  const cleaned = f.store.event(old.id), next = createErasure(f.store, old.entityId);
  assert.deepEqual(receipt.versions, next.versions);
  assert.deepEqual(filterErased([old, cleaned], [receipt, next]), []);
  f.store.transaction(() => f.store.eraseRaw([receipt]));
  assert.equal(f.store.get(old.entityId), null);
  assert.equal(f.store.importEvents([old]).count, 0);
});

test('encrypted old history objects are replaced only after sanitized objects exist and new devices can import', async t => {
  const f = fixture(t), cloud = path.join(f.directory, 'cloud'), key = makePairingKey();
  const a = new CurrentSync(f.store); a.configure(cloud, key);
  const old = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data) } });
  f.store.importEvents([old]);
  await a.publish();
  const channel = a.channel(), bytes = Buffer.from(canonical([old])), hash = sha(bytes);
  const part = { name: `history-${hash}.ssobj`, hash, size: bytes.length, count: 1 };
  channel.write(part.name, bytes, `v3:history:${hash}`);
  const report = cleanErasedTransport(a);
  assert.equal(report.errors.length, 0); assert.equal(fs.existsSync(channel.file(part.name)), false);
  const kept = readHistoryPart(channel, part);
  assert.equal(kept[0].id, old.id); assert.equal(kept[0].data.presentation, undefined); validateEvent(kept[0]);
  assert.deepEqual(readHistoryPart(channel, part), kept);
  const b = new Store(path.join(f.directory, 'B')); t.after(() => b.close());
  const sync = new CurrentSync(b); sync.configure(cloud, key);
  await sync.importLatest(); assert.equal(b.get(old.entityId).data.content, f.data.content);
  assert.equal(b.get(old.entityId).data.presentation, undefined);
  assert.equal(a.value('latest').format, 6);
  const count = b.allEvents().length; await sync.importLatest(); assert.equal(b.allEvents().length, count);
});

test('Agent no longer advertises or accepts page designs but retains text workflows', async t => {
  const f = fixture(t), access = new AgentAccess(f.store); t.after(() => access.close());
  const issued = access.createGrant({ name: '退役测试' }), grant = access.grants().find(item => item.id === issued.id);
  const call = (method, input) => access.dispatch(grant, { method, requestId: uuid(), input: { preferencesVersion: access.preferences().version, ...input } });
  assert.equal(call('bootstrap', {}).capabilities.presentation, undefined);
  assert.throws(() => call('draftCreate', { data: { ...f.data, presentation: retiredPage(f.data) } }), /交互阅读已移除/);
  assert.throws(() => call('propose', { domain: f.domain, items: [{ data: { ...f.data, presentation: retiredPage(f.data) } }] }), /交互阅读已移除/);
  const note = f.store.write({ data: f.data });
  assert.throws(() => call('noteUpdate', { id: note.id, parents: note.heads, data: { ...note.data, presentation: null } }), /交互阅读已移除/);
  assert.equal(call('noteUpdate', { id: note.id, parents: note.heads, data: { ...note.data, content: '正文修改' } }).data.content, '正文修改');
});

test('failed replacement publication retains the original; retry and malformed replacement checks remain safe', t => {
  const f = fixture(t), sync = new CurrentSync(f.store);
  sync.configure(path.join(f.directory, 'cloud'), makePairingKey());
  const old = legacyReadingEvent(f.store, { data: { ...f.data, presentation: retiredPage(f.data) } });
  f.store.importEvents([old]);
  const channel = sync.channel(), bytes = Buffer.from(canonical([old])), hash = sha(bytes);
  const part = { name: `history-${hash}.ssobj`, hash, size: bytes.length, count: 1 };
  channel.write(part.name, bytes, `v3:history:${hash}`);
  const replacement = channel.file(`replace-${hash}.ssreplacement`), rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === replacement) throw Object.assign(new Error('isolated replacement is busy'), { code: 'EPERM' });
    return rename(from, to);
  });
  assert.equal(cleanErasedTransport(sync).state, 'blocked');
  assert.equal(fs.existsSync(channel.file(part.name)), true);
  assert.equal(fs.existsSync(replacement), false);
  assert.deepEqual(channel.read(part.name, `v3:history:${hash}`), bytes);
  mock.mock.restore();
  assert.equal(cleanErasedTransport(sync).state, 'done');
  assert.equal(fs.existsSync(channel.file(part.name)), false);
  assert.equal(readHistoryPart(channel, part)[0].data.content, old.data.content);
  const good = fs.readFileSync(replacement);
  for (const bad of [null, { ...part, size: -1 }, part]) {
    fs.writeFileSync(replacement, sealBinary(Buffer.from(canonical({ format: 2, retirement: 'presentation',
      source: part.name, receipts: [], part: bad })), channel.key, `v4:replace:${hash}`));
    assert.throws(() => readHistoryPart(channel, part), /凭据|索引/);
  }
  fs.writeFileSync(replacement, good);
  assert.equal(readHistoryPart(channel, part)[0].data.content, old.data.content);
});

test('combined old AI workspace and reading cleanup preserves dirty body and has deterministic replacements', t => {
  const f = fixture(t); f.store.retiredAI = true;
  const tabId = uuid(), noteId = uuid(), conversationId = uuid();
  const old = legacyReadingEvent(f.store, { type: 'workspace', data: { title: '旧工作区', domain: f.domain,
    tabs: [{ id: tabId, recordId: noteId, dirty: true, draft: { ...f.data, presentation: retiredPage(f.data) } },
      { id: uuid(), recordId: conversationId, conversationId, type: 'conversation' }], selectedTab: tabId } });
  const receipts = retirementReceipts(f.store, [old]);
  assert.deepEqual(replacementWorkspaces([old], receipts), replacementWorkspaces([retirePresentation(old)], receipts));
  f.store.importEvents([old]);
  const kept = f.store.list({ type: 'workspace' });
  assert.equal(kept.length, 1); assert.equal(kept[0].data.tabs.length, 1);
  assert.equal(kept[0].data.tabs[0].dirty, true);
  assert.equal(kept[0].data.tabs[0].draft.content, f.data.content);
  assert.equal(kept[0].data.tabs[0].draft.presentation, undefined);
  f.store.importEvents([old]); assert.equal(f.store.list({ type: 'workspace' }).length, 1);
});

test('service startup cleans legacy data and completes database compaction without deleting notes', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), store = new Store(directory);
  const domain = store.saveLibrary({ title: '启动迁移' }).data.domain;
  const data = { title: '正文', domain, content: '保留' };
  const old = legacyReadingEvent(store, { data: { ...data, presentation: retiredPage(data) } });
  seedLegacyReading(store, [old]); store.close();
  const service = new Service(directory); t.after(() => service.close()); await service.ready;
  assert.equal((await service.call('record', { id: old.entityId })).data.presentation, undefined);
  assert.equal(service.store.local('presentationRetirement').pending, false);
  assert.equal(service.store.local('permanentDeletionDatabase').state, 'done');
});
