import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Service } from '../src/core/service.mjs';
import { Store } from '../src/core/store.mjs';
import { FolderTransport, makePairingKey } from '../src/core/transport.mjs';
import { BackupManager } from '../src/core/backup.mjs';
import { uuid, sha } from '../src/core/util.mjs';
import { call as client } from '../skills/fengzaiy/scripts/client.mjs';
import { skillZip, skillExportFiles } from '../web/skill-export.js';
import JSZip from 'jszip';

const root = path.resolve('artifacts/agent-tests');
fs.mkdirSync(root, { recursive: true });
async function setup(t, permissions = {}) {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const service = new Service(path.join(directory, 'data'));
  t.after(() => { service.close(); });
  const a = service.store.saveLibrary({ title: '研究' }), b = service.store.saveLibrary({ title: '独立资料' });
  const grant = service.agents.createGrant({ name: '测试 Agent', domains: [a.data.domain], ...permissions });
  await service.agents.configure(true);
  const env = { FENGZAIY_AGENT_URL: service.agents.status().url, FENGZAIY_AGENT_TOKEN: grant.token };
  const rpc = (method, input = {}, requestId) => client(method, input, requestId, env);
  const version = service.agents.preferences().version;
  const write = (method, input, requestId = uuid()) => rpc(method, { ...input, preferencesVersion: version }, requestId);
  return { directory, service, store: service.store, a, b, grant, env, rpc, write, version };
}
const data = (library, content = '正文') => ({ title: '测试知识', domain: library.data.domain, content, sourceIds: [], assetIds: [] });
async function approve(service, request) {
  const detail = await service.call('agentOperationDetail', { id: request.id });
  return service.call('agentOperationDecide', { id: request.id, token: detail.token, approved: true });
}

test('Agent endpoint defaults off; credentials cover all libraries, remain hashed and can be deleted', async t => {
  const { service, rpc, env, grant, a } = await setup(t);
  const status = service.agents.status();
  assert.ok(!JSON.stringify(status).includes(grant.token));
  assert.equal(service.store.local('agentGrants')[0].hash, sha(grant.token));
  assert.equal((await rpc('libraries')).length, 2);
  assert.ok((await rpc('libraries')).some(item => item.id === a.id));
  const later = service.store.saveLibrary({ title: '后续新建' });
  assert.ok((await rpc('libraries')).some(item => item.id === later.id));
  assert.equal((await rpc('bootstrap')).access.scope, 'all');
  await assert.rejects(client('bootstrap', {}, undefined, { ...env, FENGZAIY_AGENT_TOKEN: '0'.repeat(64) }), /UNAUTHORIZED/);
  service.agents.revoke(grant.id);
  assert.equal(service.agents.grants().length, 0);
  assert.equal(service.agents.status().audit.length, 0);
  await assert.rejects(rpc('bootstrap'), /UNAUTHORIZED/);
  await service.agents.configure(false);
  assert.equal(service.agents.status().enabled, false);
  const fresh = new Service(path.join(service.store.directory, 'fresh'));
  assert.equal(fresh.agents.status().enabled, false); fresh.close();
});

test('Agent server rejects browser origins, bad hosts, arbitrary RPC and system control', async t => {
  const { env, rpc } = await setup(t);
  const url = `${env.FENGZAIY_AGENT_URL}/mcp`;
  for (const headers of [{ Origin: 'https://example.com' }, { Host: 'evil.example' }]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${env.FENGZAIY_AGENT_TOKEN}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end(JSON.stringify({ method: 'bootstrap' }));
    });
    assert.equal(status, 403);
  }
  for (const method of ['approve', 'agentGrant', 'agentPreferencesSave', 'assetImport', 'syncConfigure', 'backupRestore', 'ask', 'providerSave', 'toString',
    'versionCommit', 'versionRestore', 'syncStatus', 'syncPlan', 'syncPublish', 'syncImport', 'syncPause', 'syncCancel',
    'updateStatus', 'updateCheck', 'updateDownload', 'updateInstall', 'updateConfigure', 'exitStatus', 'exitCancel', 'exitFinish',
    'skillInstallList', 'skillInstallCheck', 'skillInstallPreview', 'skillInstallConfirm', 'skillInstallConfigure', 'skillInstallUnlink',
    'syncConfirmBatch', 'syncConfirmUpload', 'deviceSetPrimary', 'deviceManage', 'syncClientValidate', 'assetEvict', 'pairingKey',
    'assetCatalog', 'assetDetail', 'assetUpdate', 'assetBatch', 'assetDuplicates', 'assetMergePreview', 'assetMerge', 'trashPreview', 'trashEmpty',
    'deletionStatus', 'deletionRetry', 'storagePreviousPreview', 'storagePreviousClean', 'emptyDirectoriesPreview', 'emptyDirectoriesClean']) {
    await assert.rejects(rpc(method), /FORBIDDEN/);
  }
});

test('revocation deletes only that grant and its audit/receipts and rolls back failures', async t => {
  const { service, store, a, grant, write, rpc } = await setup(t);
  const draft = await write('draftCreate', { data: data(a) });
  const another = service.agents.createGrant({ name: '保留的授权' });
  const saved = store.local.bind(store);
  const mocked = t.mock.method(store, 'local', (...args) => {
    if (args[0] === 'agentAudit' && args.length === 2) throw new Error('injected write failure');
    return saved(...args);
  });
  assert.throws(() => service.agents.revoke(grant.id), /injected/);
  assert.ok(service.agents.grants().some(item => item.id === grant.id));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM agent_requests WHERE grant_id=?').get(grant.id).n, 1);
  mocked.mock.restore();
  service.agents.revoke(grant.id); service.agents.revoke(grant.id);
  assert.deepEqual(service.agents.grants().map(item => item.id), [another.id]);
  assert.ok(service.agents.status().audit.every(item => item.grantId !== grant.id));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM agent_requests WHERE grant_id=?').get(grant.id).n, 0);
  assert.equal(store.get(draft.id).data.content, draft.data.content);
  await assert.rejects(rpc('bootstrap'), /UNAUTHORIZED/);
});

test('startup removes old revoked grants and upgrades surviving credentials without extending expiry', async t => {
  const { service, store, grant, directory } = await setup(t);
  const active = { ...service.agents.grants()[0], domains: ['old-library'], scope: undefined, permissions: ['read'], sensitive: false };
  const revoked = { ...active, id: uuid(), hash: sha('revoked-token'), revoked: true };
  store.local('agentGrants', [active, revoked]);
  store.local('agentAudit', [{ grantId: active.id, name: active.name }, { grantId: revoked.id, name: '旧撤销项' }]);
  store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run(revoked.id, 'old-request', 'digest', '{}');
  await service.close(); service.close = () => {};
  const reopened = new Service(path.join(directory, 'data')); t.after(() => reopened.close());
  const remaining = reopened.agents.grants();
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, grant.id);
  assert.equal(remaining[0].hash, active.hash); assert.equal(remaining[0].expiresAt, active.expiresAt);
  assert.equal(remaining[0].scope, 'all'); assert.equal(remaining[0].sensitive, true);
  assert.deepEqual(remaining[0].permissions, ['read', 'collect', 'propose', 'edit', 'trash']);
  assert.equal(reopened.store.db.prepare('SELECT COUNT(*) n FROM agent_requests').get().n, 0);
  assert.deepEqual(reopened.agents.status().audit.map(item => item.grantId), [active.id]);
});

test('a fresh workspace can grant MCP access before its first library is created', t => {
  const service = new Service(fs.mkdtempSync(path.join(root, 'empty-'))); t.after(() => service.close());
  const grant = service.agents.createGrant({ name: '首次连接' });
  assert.equal(grant.scope, 'all'); assert.deepEqual(service.store.libraries(), []);
});

test('cleared records cannot be read through Agent search, direct reads, history or request replay', async t => {
  const { service, rpc, write, a } = await setup(t, { edit: true, trash: true });
  const requestId = uuid();
  const input = { data: { ...data(a), title: '待清空的收集内容' } };
  const note = await write('draftCreate', input, requestId);
  await approve(service, await write('trash', { id: note.id, parents: note.heads }));
  const preview = await service.call('trashPreview', { domain: a.id });
  assert.equal(preview.eligible.length, 1);
  await service.call('trashEmpty', { domain: a.id, token: preview.token, confirmed: true });
  assert.equal((await rpc('search', { trash: true })).total, 0);
  await assert.rejects(rpc('record', { id: note.id }), /FORBIDDEN/);
  await assert.rejects(rpc('history', { id: note.id }), /FORBIDDEN/);
  await assert.rejects(write('draftCreate', input, requestId), /FORBIDDEN/);
});

test('busy port is reported without changing addresses and persisted enable can be cancelled', async t => {
  const { service } = await setup(t);
  const stopped = new Promise(resolve => service.agents.server.once('close', resolve));
  service.agents.stop(); await stopped;
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(service.store.local('agentPort'), '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  await service.agents.resume();
  assert.equal(service.agents.status().enabled, false);
  assert.equal(service.agents.status().requestedEnabled, true);
  assert.match(service.agents.status().error, /EADDRINUSE/);
  assert.equal(service.agents.status().url, null);
  await service.agents.configure(false);
  assert.equal(service.agents.status().requestedEnabled, false);
  assert.equal(service.agents.status().error, null);
});

test('all-library credentials read sensitive references and every historical branch', async t => {
  const { store, a, b, rpc } = await setup(t);
  const privateNote = store.write({ type: 'source', data: { ...data(a), sensitive: true } });
  const other = store.write({ type: 'note', data: data(b) });
  const indirect = store.write({ type: 'note', data: { ...data(a), sourceIds: [privateNote.id] } });
  const crossing = store.write({ type: 'note', data: data(a) });
  store.write({ id: crossing.id, type: 'note', parents: crossing.heads, data: data(a, '本库新版本') });
  store.write({ id: crossing.id, type: 'note', parents: crossing.heads, allowBranch: true, data: data(b) });
  assert.equal(store.get(crossing.id).conflict, true);
  for (const record of [privateNote, other, indirect, crossing]) assert.equal((await rpc('record', { id: record.id })).id, record.id);
  const oldPrivate = store.write({ type: 'note', data: { ...data(a), sensitive: true } });
  store.write({ id: oldPrivate.id, type: 'note', parents: oldPrivate.heads, data: data(a) });
  assert.equal((await rpc('history', { id: oldPrivate.id })).length, 2);
  assert.equal((await rpc('search')).records.filter(record => record.type !== 'library').length, 5);
  await assert.rejects(rpc('record', { id: uuid() }), /FORBIDDEN/);
});

test('writes are atomic, idempotent and require current preferences; request ID collisions fail', async t => {
  const { store, a, rpc, write, version, service } = await setup(t);
  const request = uuid(), input = { data: data(a) };
  const first = await write('draftCreate', input, request);
  const second = await write('draftCreate', input, request);
  assert.deepEqual(first, second);
  assert.equal(store.list({ type: 'draft' }).length, 1);
  await assert.rejects(write('draftCreate', { data: data(a, '不同') }, request), /CONFLICT/);
  await assert.rejects(rpc('draftCreate', { ...input, preferencesVersion: 'outdated' }, uuid()), /PREFERENCES_CHANGED/);
  const updated = service.agents.savePreferences({ content: '案例必须保留日期', parents: [] });
  assert.notEqual(updated.version, version);
  await assert.rejects(write('draftCreate', input), /PREFERENCES_CHANGED/);
  const boot = await rpc('bootstrap');
  assert.match(boot.preferences.content, /日期/);
  assert.match(boot.skill, /proposalRevise/);
  assert.match(boot.apiReference, /requestId/);
  await rpc('draftCreate', { ...input, preferencesVersion: updated.version }, uuid());
});

test('all credentials can edit and recycle while stale edits never overwrite', async t => {
  const { store, a, write, service } = await setup(t);
  const note = store.write({ type: 'note', data: data(a) });
  const exec = write;
  const edited = await exec('noteUpdate', { id: note.id, parents: note.heads, data: data(a, '已确认的修改') });
  await assert.rejects(exec('noteUpdate', { id: note.id, parents: note.heads, data: data(a, '过期') }), /CONFLICT/);
  await approve(service, await exec('trash', { id: note.id, parents: edited.heads }));
  assert.equal(store.get(note.id).deleted, true);
  assert.equal(store.history(note.id).length, 3);
});

test('proposals support source preservation, partial approval, local revision and no auto-approval', async t => {
  const { store, a, b, service, write, rpc } = await setup(t);
  const source = await write('sourceCreate', { data: { ...data(a, '原始资料'), url: 'https://example.invalid/lesson' } });
  const body = { ...data(a, '提炼结果'), sourceIds: [source.id] };
  const crossLibrary = await write('propose', { title: '跨库建议', domain: a.id, items: [{ data: data(b) }] });
  assert.equal(crossLibrary.data.items[0].data.domain, b.id);
  const plan = await write('propose', { title: '课程整理', domain: a.id, items: [{ data: body }, { data: { ...body, title: '待优化部分' } }] });
  assert.equal(store.list({ type: 'note' }).length, 0);
  const accepted = await service.call('approve', { id: plan.id, parents: plan.heads, itemIds: [plan.data.items[0].id] });
  const revised = await write('proposalRevise', { id: plan.id, parents: accepted.heads, items: [{ id: accepted.data.items[1].id, data: { ...body, content: '只重做这一项' } }] });
  assert.equal(revised.data.items[0].status, 'accepted');
  assert.deepEqual(revised.data.items[0], accepted.data.items[0]);
  assert.equal(store.list({ type: 'note' }).length, 1);
  await assert.rejects(write('proposalRevise', { id: plan.id, parents: revised.heads, items: [{ id: revised.data.items[0].id, data: body }] }), /已确认/);
  assert.equal((await rpc('search', { type: 'proposal', query: '只重做' })).total, 1);
});

test('attachments enforce hashes, reject arbitrary paths and remain scoped', async t => {
  const { write, rpc, a, store, service } = await setup(t);
  const bytes = Buffer.from('学习资料'), body = { domain: a.id, filename: 'lesson.txt', mime: 'text/plain', data: bytes.toString('base64'), sha256: sha(bytes) };
  await assert.rejects(write('assetWrite', { ...body, sha256: '0'.repeat(64) }), /哈希/);
  await assert.rejects(write('assetWrite', { ...body, filename: '../secret.txt' }), /filename/);
  const asset = await write('assetWrite', body);
  const value = await rpc('assetRead', { id: asset.id });
  assert.equal(value.data, body.data); assert.equal(value.path, undefined);
  assert.equal((await service.call('assetDetail', { id: asset.id })).storage.path, store.assetLocation(asset.id).path);
  const portable = await rpc('record', { id: asset.id });
  assert.equal(portable.storage, undefined);
  assert.ok(!JSON.stringify(portable).includes(store.directory.replaceAll('\\', '\\\\')));
  fs.writeFileSync(store.assetLocation(asset.id).path, 'corrupt');
  await assert.rejects(rpc('assetRead', { id: asset.id }), /完整性/);
  fs.unlinkSync(store.assetLocation(asset.id).path);
  await assert.rejects(rpc('assetRead', { id: asset.id }), /ASSET_UNAVAILABLE/);
});

test('merge proposals retain prior provenance and sensitive flags; stale targets cannot be approved', async t => {
  const { store, a, write, service } = await setup(t, { sensitive: true });
  const source = store.write({ type: 'source', data: data(a, '第一份来源') });
  const note = store.write({ type: 'note', data: { ...data(a), sensitive: true, sourceIds: [source.id] } });
  const plan = await write('propose', { domain: a.id, items: [{ targetId: note.id, parents: note.heads, data: data(a, '完整合并后的正文') }] });
  assert.deepEqual(plan.data.items[0].data.sourceIds, [source.id]);
  assert.equal(plan.data.items[0].data.sensitive, true);
  store.write({ id: note.id, parents: note.heads, type: 'note', data: { ...note.data, content: '用户的新修改' } });
  await assert.rejects(service.call('approve', { id: plan.id, parents: plan.heads, itemIds: [plan.data.items[0].id] }), /changed/);
  assert.equal(store.get(plan.id).data.items[0].status, 'pending');
  assert.equal(store.get(note.id).data.content, '用户的新修改');
});

test('retired data cannot be imported, read or recreated and model calls remain unavailable', async t => {
  const { service, store, a, rpc, directory } = await setup(t);
  const old = new Store(path.join(directory, 'old-fixture')); t.after(() => old.close());
  const chat = old.write({ type: 'conversation', data: { ...data(a), messages: [{ role: 'assistant', content: '旧回答' }] } });
  const model = old.write({ type: 'model', data: { title: '旧模型', providerId: 'custom', modelName: 'legacy' } });
  store.importEvents(old.allEvents());
  await assert.rejects(rpc('record', { id: chat.id }), /不存在|不可访问/);
  for (const method of ['models', 'ask', 'providerSave', 'modelPrice', 'discussionPlan', 'discussionStart']) await assert.rejects(service.call(method), /Unsupported/);
  await assert.rejects(service.call('save', { type: 'model', data: model.data }), /移除/);
  assert.equal(store.get(model.id), null);
  assert.throws(() => store.write({ type: 'model', data: model.data }), /已删除/);
  assert.equal(service.models, undefined);
});

test('preferences sync and restore but credentials and request receipts stay device-local', async t => {
  const { service, store, directory, grant } = await setup(t);
  const prefs = service.agents.savePreferences({ content: '按条件并列观点', parents: [] });
  const other = new Store(path.join(directory, 'other')); t.after(() => other.close());
  const key = makePairingKey(), ta = new FolderTransport(store), tb = new FolderTransport(other);
  ta.configure(path.join(directory, 'cloud-a'), key); tb.configure(path.join(directory, 'cloud-b'), key);
  await ta.cycle();
  for (const file of fs.readdirSync(ta.root())) fs.copyFileSync(path.join(ta.root(), file), path.join(tb.root(), file));
  await tb.cycle();
  assert.equal(other.get(prefs.id).data.content, prefs.content);
  assert.equal(other.local('agentGrants'), null);
  const backup = await new BackupManager(store).create(path.join(directory, 'backups'));
  const recovered = new Store(path.join(directory, 'recovered')); t.after(() => recovered.close());
  await new BackupManager(recovered).restore(backup.directory);
  assert.equal(recovered.get(prefs.id).data.content, prefs.content);
  assert.ok(!JSON.stringify(recovered.allEvents()).includes(grant.token));
});

test('preference conflicts pause Agent writes and can be explicitly merged', async t => {
  const { service, store, a, rpc, write } = await setup(t);
  const first = service.agents.savePreferences({ content: '版本 A', parents: [] });
  service.agents.savePreferences({ content: '版本 B', parents: first.heads });
  store.write({ id: first.id, type: 'agentPreferences', parents: first.heads, allowBranch: true,
    data: { title: '偏好', domain: '__settings__', content: '并发版本 C' } });
  const boot = await rpc('bootstrap'); assert.equal(boot.preferences.conflict, true);
  await assert.rejects(write('draftCreate', { data: data(a) }), /PREFERENCES_CHANGED/);
  service.agents.savePreferences({ content: '人工合并 B 与 C', parents: boot.preferences.heads });
  assert.equal((await rpc('bootstrap')).preferences.conflict, false);
});

test('receipts survive restart and revocation/expiry is checked before replay', async t => {
  const { service, a, write, grant, env, version } = await setup(t);
  const requestId = uuid(), input = { data: data(a), preferencesVersion: version };
  const record = await write('draftCreate', { data: data(a) }, requestId);
  const directory = service.store.directory, stopped = new Promise(resolve => service.agents.server.once('close', resolve));
  service.close(); await stopped;
  const next = new Service(directory); t.after(() => next.close());
  // setup cleanup must not close a second time.
  service.close = () => {};
  await next.agents.resume();
  const newEnv = { ...env, FENGZAIY_AGENT_URL: next.agents.status().url };
  assert.equal((await client('draftCreate', input, requestId, newEnv)).id, record.id);
  next.store.local('agentGrants', next.agents.grants().map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00.000Z' })));
  await assert.rejects(client('draftCreate', input, requestId, newEnv), /UNAUTHORIZED/);
  assert.ok(grant.id);
});

test('workspace publication strips retired chat payloads and portable skill ZIP is well formed', async t => {
  const { service } = await setup(t);
  const tab = { id: uuid(), recordId: uuid(), title: '笔记', domain: 'scope', scroll: 10, prompt: 'private', modelId: 'old', conversationId: 'old', attachments: ['private'], jobId: 'old' };
  const record = await service.call('workspacePublish', { tabs: [tab], selectedTab: tab.id });
  assert.deepEqual(Object.keys(record.data.tabs[0]).sort(), ['domain', 'id', 'recordId', 'scroll', 'title']);
  const files = service.agents.skillFiles();
  const zip = Buffer.from(await skillZip(files).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 4);
  fs.writeFileSync(path.join(root, 'FengZaiY.zip'), zip);
});

test('built-in skill export versions match bootstrap and preserve an exact portable snapshot', async t => {
  const { service, store, rpc } = await setup(t);
  const initial = await service.call('agentSkill');
  assert.equal(initial.lastGenerated, null);
  assert.equal(initial.skillVersion, (await rpc('bootstrap')).skillVersion);
  const prefs = service.agents.savePreferences({ content: '保留出处 <script>不可执行</script>', parents: [] });
  const next = await service.call('agentSkill');
  assert.equal(next.skillVersion, initial.skillVersion);
  assert.notEqual(next.exportVersion, initial.exportVersion);
  const historyCount = store.history(prefs.id).length;
  const generated = await service.call('agentSkillExport');
  assert.equal(store.history(prefs.id).length, historyCount, 'export is not a knowledge revision');
  assert.equal(generated.lastGenerated.version, generated.exportVersion);
  const files = skillExportFiles(generated), zip = await JSZip.loadAsync(await skillZip(files).arrayBuffer());
  for (const [name, text] of Object.entries(files)) assert.equal(await zip.file(`fengzaiy/${name}`).async('string'), text);
  assert.match(files['references/preferences.md'], /保留出处 <script>/);
  assert.equal(JSON.parse(files['manifest.json']).preferencesVersion, prefs.version);
  const serialized = JSON.stringify(files);
  assert.equal(serialized.includes(service.store.directory), false);
  assert.equal(serialized.includes(service.agents.grants()[0].hash), false);
  for (const method of ['agentSkill', 'agentSkillExport', 'agentPreferencesSave']) await assert.rejects(rpc(method), /FORBIDDEN/);
  const updated = service.agents.savePreferences({ content: '新补充', parents: prefs.heads });
  assert.notEqual((await service.call('agentSkill')).exportVersion, generated.lastGenerated.version);
  assert.deepEqual((await service.call('agentSkill')).lastGenerated, generated.lastGenerated);
  assert.equal(updated.content, '新补充');
});

test('skill preference history restoration appends a revision and stale/conflicting exports stay protected', async t => {
  const { service, store } = await setup(t);
  const first = service.agents.savePreferences({ content: '原始偏好', parents: [] });
  const second = service.agents.savePreferences({ content: '新的偏好', parents: first.heads });
  const historical = store.history(first.id).find(event => event.id === first.heads[0]);
  const restored = service.agents.savePreferences({ content: historical.data.content, parents: second.heads });
  assert.equal(restored.content, '原始偏好');
  assert.equal(store.history(first.id).length, 3);
  assert.deepEqual(store.event(historical.id), historical);
  assert.throws(() => service.agents.savePreferences({ content: '过期覆盖', parents: first.heads }), { code: 'CONFLICT' });
  const generated = await service.call('agentSkillExport');
  store.write({ id: first.id, type: 'agentPreferences', parents: second.heads, allowBranch: true,
    data: { title: '整理偏好', domain: '__settings__', content: '另一电脑' } });
  await assert.rejects(service.call('agentSkillExport'), { code: 'CONFLICT' });
  assert.deepEqual((await service.call('agentSkill')).lastGenerated, generated.lastGenerated);
});
