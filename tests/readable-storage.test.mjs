import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { importAttachment } from '../src/core/transport.mjs';
import { proposedMaterials } from '../src/core/material-organization.mjs';
import { readableAssetPath } from '../src/core/readable-storage.mjs';
import { sha, hashFile } from '../src/core/util.mjs';
import { databasePath, deviceKeyPath, layoutState } from '../src/core/workspace-layout.mjs';
import { StorageLocation } from '../src/core/storage-location.mjs';
import { previewTrash } from '../src/core/trash.mjs';
import { readableMarkdown } from '../src/core/readable-markdown.mjs';

const root = path.resolve('artifacts/readable-tests'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), service = new Service(path.join(directory, 'workspace'));
  t.after(() => service.close()); return { directory, service, store: service.store };
}
test('approved material plan preserves identity, moves once and projects readable note references', async t => {
  const { directory, service, store } = fixture(t);
  const file = path.join(directory, 'original.txt'); fs.writeFileSync(file, 'original bytes');
  const asset = await importAttachment(store, file, { domain: '__materials__' });
  assert.match(store.assetLocation(asset.id).path, /资料.*待整理.*未分类资料.*original.txt/);
  const before = store.assetLocation(asset.id).path;
  const materialItems = proposedMaterials(store, [
    { type: 'materialCategory', key: 'category', data: { title: '装修' } },
    { type: 'materialTopic', key: 'topic', categoryKey: 'category', data: { title: '合同模板' } },
    { type: 'asset', targetId: asset.id, parents: asset.heads, topicKey: 'topic', data: { managedFilename: '合同说明.txt' } }
  ]);
  const event = store.write({ type: 'proposal', data: { title: '统一整理', domain: '__materials__', items: [], materialItems } });
  let proposal = store.get(event.id);
  assert.throws(() => store.approve(proposal.id, [materialItems[2].id], proposal.heads), /分类或主题/);
  assert.equal(store.get(asset.id).data.materialTopicId, undefined);
  const preview = await service.call('materialProposalPreview', { id: proposal.id });
  assert.match(preview[2].target, /资料.*装修.*合同模板.*合同说明.txt/);
  proposal = store.approve(proposal.id, materialItems.map(i => i.id), proposal.heads);
  assert.equal(store.get(asset.id).data.sha256, sha('original bytes'));
  await service.organizeLocal();
  const target = store.assetLocation(asset.id).path;
  assert.notEqual(before, target); assert.equal(await hashFile(target), sha('original bytes'));
  assert.ok(fs.existsSync(before)); assert.ok(fs.existsSync(file));
  assert.ok(proposal.data.materialItems.every(i => i.status === 'accepted'));
  const library = await service.call('librarySave', { title: '装修知识库', description: '' });
  const note = store.write({ type: 'note', data: { title: '合同审核', domain: library.data.domain, format: 'html', content: '<h2>条款</h2><p>核对<strong>价格</strong></p>', assetIds: [asset.id] } });
  const report = await service.organizeLocal(); assert.deepEqual(report.errors, []);
  const notes = store.local('readableDirectories');
  const body = path.join(store.directory, notes[`note:${note.id}`], '正文.md');
  assert.match(fs.readFileSync(body, 'utf8'), /## 条款[\s\S]*\*\*价格\*\*/);
  assert.match(fs.readFileSync(path.join(path.dirname(body), '资料引用.md'), 'utf8'), /original.txt/);
  assert.equal(store.assetLocation(asset.id).path, target);
});
test('foreign names and corrupted sources never overwrite user files; preview is read only', async t => {
  const { directory, service, store } = fixture(t);
  const file = path.join(directory, 'same.txt'); fs.writeFileSync(file, 'a');
  const first = await importAttachment(store, file, { domain: '__materials__' });
  const old = store.assetLocation(first.id).path;
  fs.writeFileSync(file, 'b'); const second = await importAttachment(store, file, { domain: '__materials__' });
  assert.notEqual(store.assetLocation(second.id).path, old); assert.equal(fs.readFileSync(old, 'utf8'), 'a');
  const prior = JSON.stringify(store.local('readableAssets')); service.materialCenter.preview(); assert.equal(JSON.stringify(store.local('readableAssets')), prior);
  fs.writeFileSync(old, 'external changes');
  const updated = store.write({ id: first.id, type: 'asset', parents: first.heads, data: { ...first.data, managedFilename: 'new.txt' } });
  const preview = service.materialCenter.preview(); const result = await service.materialCenter.migrate({ token: preview.token, confirmed: true });
  assert.equal(result.state, 'pending'); assert.ok(result.errors.length); assert.equal(store.assetLocation(updated.id).path, old);
});
test('internal database migration closes SQLite and retains history, local encryption and restart identity', async t => {
  const { service, store } = fixture(t); await service.ready;
  const root = store.directory, id = store.deviceId;
  const record = store.write({ type: 'draft', data: { title: '历史', domain: '测试', content: '正文' } });
  const encrypted = store.vault.seal('local credential');
  const preview = await service.call('storageInternalPreview');
  await service.call('storageInternalSchedule', { token: preview.token, confirmed: true });
  assert.equal(layoutState(root).state, 'pending'); assert.ok(fs.statSync(databasePath(root)).isFile());
  await service.close();
  const reopened = new Service(root); t.after(() => reopened.close()); await reopened.ready;
  assert.equal(layoutState(root).state, 'complete'); assert.equal(reopened.store.deviceId, id);
  assert.ok(reopened.store.get(record.id)); assert.equal(reopened.store.vault.open(encrypted), 'local credential');
  assert.ok(fs.existsSync(deviceKeyPath(root))); assert.ok(fs.statSync(path.join(root, 'knowledge.sqlite')).isDirectory());
});
test('MCP large upload resumes after restart, verifies full content and rejects revoked grants', async t => {
  const { service, store } = fixture(t); await service.ready;
  const issued = service.agents.createGrant({ name: 'upload-test' });
  let access = service.agents, grant = access.grants().find(g => g.id === issued.id);
  const content = Buffer.alloc(17 * 1024 * 1024, 97), chunkSize = 4 * 1024 * 1024;
  let prefs = access.preferences().version;
  const session = await access.invoke(grant, { method: 'assetUploadStart', requestId: 'start-upload-001', input: { domain: '__materials__', filename: '大文件.txt', size: content.length, sha256: sha(content), preferencesVersion: prefs } });
  const first = content.subarray(0, chunkSize);
  await access.invoke(grant, { method: 'assetUploadChunk', requestId: 'upload-chunk-0', input: { id: session.id, offset: 0, data: first.toString('base64'), sha256: sha(first), preferencesVersion: prefs } });
  const root = store.directory; await service.close();
  const next = new Service(root); t.after(() => next.close()); await next.ready;
  access = next.agents; grant = access.grants().find(g => g.id === issued.id); prefs = access.preferences().version;
  const status = await access.invoke(grant, { method: 'assetUploadStatus', input: { id: session.id } }); assert.equal(status.received, chunkSize);
  for (let offset = chunkSize; offset < content.length; offset += chunkSize) {
    const bytes = content.subarray(offset, offset + chunkSize);
    await access.invoke(grant, { method: 'assetUploadChunk', requestId: `upload-chunk-${offset}`, input: { id: session.id, offset, data: bytes.toString('base64'), sha256: sha(bytes), preferencesVersion: prefs } });
  }
  const done = await access.invoke(grant, { method: 'assetUploadFinish', requestId: 'finish-upload-001', input: { id: session.id, preferencesVersion: prefs } });
  assert.equal(done.state, 'complete'); assert.equal(await hashFile(next.store.assetLocation(done.assetId).path), sha(content));
  access.revoke(issued.id);
  await assert.rejects(access.invoke(grant, { method: 'assetUploadStatus', input: { id: session.id } }), /授权/);
});

test('startup resumes a database move interrupted before its credential move', async t => {
  const { service, store } = fixture(t); await service.ready;
  const directory = store.directory, id = store.deviceId;
  const preview = await service.call('storageInternalPreview');
  await service.call('storageInternalSchedule', { token: preview.token, confirmed: true });
  await service.close();
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (path.basename(from) === 'device-vault.key') throw new Error('simulated interruption'); return rename(from, to); };
    assert.throws(() => new Service(directory), /simulated interruption/);
  } finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(directory, '.fengzai-y/database/knowledge.sqlite')));
  const location = new StorageLocation(directory);
  const reopened = await location.open(); t.after(async () => { await reopened.close(); location.close(); });
  assert.equal(reopened.store.deviceId, id); assert.equal(layoutState(directory).state, 'complete');
});

test('approved relocation cleanup and permanent deletion cover registered old originals without touching import source', async t => {
  const { directory, service, store } = fixture(t); await service.ready;
  const source = path.join(directory, '原件.txt'); fs.writeFileSync(source, 'preserve imported source');
  let asset = await importAttachment(store, source, { domain: '__materials__' });
  const old = store.assetLocation(asset.id).path;
  asset = store.write({ id: asset.id, type: 'asset', parents: asset.heads, data: { ...asset.data, managedFilename: '整理后的原件.txt' } });
  await service.organizeLocal(); const current = store.assetLocation(asset.id).path;
  const cleanup = await service.call('materialCleanupPreview');
  assert.ok(cleanup.rows.some(row => row.source === old && !row.issue));
  store.remove(asset.id, asset.heads);
  const plan = previewTrash(store);
  assert.ok(plan.files.some(file => path.join(store.directory, file.relative) === old));
  await service.call('trashEmpty', { token: plan.token, confirmed: true });
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(current), false); assert.ok(fs.existsSync(source));
});

test('new computer receives format 9 classifications and readable originals without any local paths in events', async t => {
  const { directory, service: a, store } = fixture(t); await a.ready;
  const b = new Service(path.join(directory, 'B'), { initializeInternal: true }); await b.ready; t.after(() => b.close());
  const file = path.join(directory, '例子.txt'); fs.writeFileSync(file, 'sync file');
  const asset = await importAttachment(store, file, { domain: '__materials__' });
  const proposal = await a.call('materialPropose', { materialItems: [
    { type: 'materialCategory', key: 'category', data: { title: '合同' } },
    { type: 'materialTopic', key: 'topic', categoryKey: 'category', data: { title: '签订资料' } },
    { type: 'asset', targetId: asset.id, parents: asset.heads, topicKey: 'topic', data: { managedFilename: '签订说明.txt' } }
  ] });
  store.approve(proposal.id, proposal.data.materialItems.map(item => item.id), proposal.heads); await a.organizeLocal();
  const cloud = path.join(directory, 'cloud'); a.transport.configure(cloud, '7'.repeat(64)); b.transport.configure(cloud, '7'.repeat(64));
  await a.transport.plan(); await a.transport.publish(); assert.equal(a.transport.value('latest').format, 9);
  await b.transport.importLatest(); assert.equal(b.store.list({ type: 'materialTopic' }).length, 1);
  assert.match(b.store.assetLocation(asset.id).path, /资料.*合同.*签订资料.*签订说明.txt/);
  assert.equal(await hashFile(b.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(JSON.stringify(store.allEvents()).includes(directory.replaceAll('\\', '\\\\')), false);
  await b.transport.importLatest(); assert.equal(b.store.history(asset.id).length, store.history(asset.id).length);
});

test('readable Markdown retains formula, diagram source, stickers and relative media links', () => {
  const blocks = [{ kind: 'formula', source: 'a^2+b^2=c^2' }, { kind: 'diagram', source: 'graph LR\nA-->B', label: '流程' },
    { kind: 'sticker', text: '重点' }, { kind: 'image', assetId: 'image-id', label: '封面' }];
  const content = blocks.map(block => `<div data-ss-block='${JSON.stringify(block)}'></div>`).join('');
  const markdown = readableMarkdown({ content, format: 'html' }, () => '../../资料/封面.jpg');
  assert.match(markdown, /\$\$\na\^2\+b\^2=c\^2/); assert.match(markdown, /```mermaid\ngraph LR/);
  assert.match(markdown, /> 重点/); assert.match(markdown, /!\[封面\]\(<\.\.\/\.\.\/资料\/封面.jpg>\)/);
});
