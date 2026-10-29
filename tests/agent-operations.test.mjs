import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { AgentOperations } from '../src/core/agent-operations.mjs';
import { call } from '../skills/fengzaiy/scripts/client.mjs';
import { uuid } from '../src/core/util.mjs';
import { skillExportFiles } from '../web/skill-export.js';

const root = path.resolve('artifacts/agent-operation-tests');
fs.mkdirSync(root, { recursive: true });
async function setup(t) {
  const service = new Service(fs.mkdtempSync(path.join(root, 'case-')));
  t.after(() => service.close());
  const grant = service.agents.createGrant({ name: '扩展能力测试' });
  await service.agents.configure(true);
  const env = { FENGZAIY_AGENT_URL: service.agents.status().mcpUrl, FENGZAIY_AGENT_TOKEN: grant.token };
  const rpc = (method, args = {}, id) => call(method, args, id, env);
  const request = (operation, input = {}, requestId = uuid()) => rpc('operation', {
    operation, input, preferencesVersion: service.agents.preferences().version
  }, requestId);
  const decide = async (request, approved = true) => {
    const detail = await service.call('agentOperationDetail', { id: request.id });
    return service.call('agentOperationDecide', { id: request.id, token: detail.token, approved });
  };
  return { service, grant, rpc, request, decide };
}

test('routine Skill checks do not expire proposal approvals or their resubmissions', async t => {
  const { service, rpc, request, decide } = await setup(t);
  const directory = fs.mkdtempSync(path.join(root, 'installation-'));
  const installed = path.join(directory, 'fengzaiy');
  for (const [name, content] of Object.entries(skillExportFiles(service.agents.skillPackage()))) {
    const file = path.join(installed, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const manager = service.skillInstallations;
  const linked = manager.confirm({ token: manager.preview({ directory: installed }).token, confirmed: true });
  const library = service.store.saveLibrary({ title: '隔离方案' });
  const plan = await rpc('propose', { title: '等待本机确认', domain: library.data.domain,
    preferencesVersion: service.agents.preferences().version,
    items: [{ data: { title: '待入库笔记', domain: library.data.domain, content: '测试正文' } }] }, uuid());
  const input = { id: plan.id, parents: plan.heads, itemIds: [plan.data.items[0].id] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestId = uuid(), pending = await request('approve', input, requestId);
    const before = await service.call('agentOperationDetail', { id: pending.id });
    const checkedAt = manager.list()[0].checkedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    manager.nextCheck = 0; manager.tick();
    assert.notEqual(manager.list()[0].checkedAt, checkedAt);
    const after = await service.call('agentOperationDetail', { id: pending.id });
    assert.equal(after.stale, false, '检查时间变化不能使请求过期');
    assert.equal(after.token, before.token);
    await decide(pending, attempt === 1);
    assert.equal((await rpc('operationResult', { id: pending.id })).state, attempt === 1 ? 'completed' : 'rejected');
    assert.equal((await request('approve', input, requestId)).state, attempt === 1 ? 'completed' : 'rejected');
  }
  assert.equal(service.store.list({ type: 'note' }).length, 1);
  const pending = await request('librarySave', { title: '真实配置变化' });
  manager.configure({ id: linked.id, mode: 'auto', confirmed: true });
  await assert.rejects(decide(pending), { code: 'CONFLICT' });
  const fresh = await request('librarySave', { title: '重新核对后' });
  manager.check();
  await decide(fresh);
});

test('fixed MCP catalog executes only after local approval and returns credential-owned results', async t => {
  const { service, rpc, request, decide } = await setup(t);
  const catalog = await rpc('operationCatalog');
  assert.ok(catalog.operations.length > 90);
  assert.ok(catalog.operations.some(item => item.method === 'vaultRead' && item.mode === 'secret'));
  assert.ok(catalog.operations.some(item => item.method === 'agentGrant' && item.mode === 'confirm'));
  const id = uuid(), pending = await request('librarySave', { title: '本机确认知识库' }, id);
  assert.equal(pending.state, 'pending'); assert.equal(service.store.libraries().length, 0);
  assert.equal((await request('librarySave', { title: '本机确认知识库' }, id)).id, pending.id);
  await assert.rejects(request('librarySave', { title: '替换参数' }, id), /CONFLICT/);
  const other = service.agents.createGrant({ name: '其他 Agent' });
  await assert.rejects(call('operationResult', { id: pending.id }, undefined, {
    FENGZAIY_AGENT_URL: service.agents.status().mcpUrl, FENGZAIY_AGENT_TOKEN: other.token
  }), /FORBIDDEN/);
  await assert.rejects(decide(pending), /变化/);
  const fresh = await request('librarySave', { title: '本机确认知识库' });
  await decide(fresh);
  const result = await rpc('operationResult', { id: fresh.id });
  assert.equal(result.state, 'completed'); assert.equal(result.value.data.title, '本机确认知识库');
  assert.equal(service.store.libraries().length, 1);
  await assert.rejects(decide(fresh), /不会重复执行/);
  assert.equal((await request('noteTree')).state, 'completed');
  for (const operation of ['agentOperationDecide', 'agentOperationFinishLocal', 'workspaceSave', 'vaultSetup', 'shell', 'toString']) await assert.rejects(request(operation));
  await assert.rejects(request('save', { type: 'note', data: {}, deleted: true }), /未知参数/);
  await assert.rejects(request('save', { type: 'proposal', data: { items: [{ status: 'accepted' }] } }), /FORBIDDEN/);
  await assert.rejects(request('vaultUnlock', { password: 'forbidden-master' }));
});

test('password operations require local unlock and never persist plaintext or replay after lock', async t => {
  const { service, rpc, request, decide } = await setup(t);
  const account = service.personal.save({ type: 'loginAccount', parents: [], data: { title: '本机账号' } });
  await assert.rejects(request('vaultRead', { accountId: account.id }), /VAULT_LOCKED/);
  const local = await request('vaultUnlock');
  assert.equal((await decide(local)).state, 'local_action_required');
  assert.equal(service.passwordVault.status().unlocked, false);
  const prepared = await service.passwordVault.setup({ password: 'test-master-password-12345' });
  service.passwordVault.confirmSetup({ token: prepared.token, confirmed: true });
  const secret = 'test-sensitive-value-never-store-plaintext';
  const pending = await request('vaultSave', { accountId: account.id, parents: [], value: { password: secret } });
  assert.ok(!JSON.stringify(await service.call('agentOperationDetail', { id: pending.id })).includes(secret));
  await decide(pending);
  const reqId = uuid();
  assert.equal((await request('vaultRead', { accountId: account.id }, reqId)).value.value.password, secret);
  service.passwordVault.lock();
  await assert.rejects(request('vaultRead', { accountId: account.id }, reqId), /VAULT_LOCKED/);
  await assert.rejects(request('vaultSave', { accountId: account.id, value: { password: secret } }), /VAULT_LOCKED/);
  assert.ok(!JSON.stringify(service.store.db.prepare('SELECT * FROM local_config').all()).includes(secret));
  assert.ok(!JSON.stringify(service.store.db.prepare('SELECT * FROM agent_requests').all()).includes(secret));
  assert.ok(!JSON.stringify(service.store.allEvents()).includes(secret));
  assert.ok(!JSON.stringify(await rpc('bootstrap')).includes(secret));
});

test('confirmation enforces stale heads, unsaved edits, expiry, rejection and revocation', async t => {
  const { service, grant, request, decide } = await setup(t);
  const stale = await request('librarySave', { title: '过期' });
  service.store.saveLibrary({ title: '资料变化' });
  await assert.rejects(decide(stale), /变化/);
  const pending = await request('librarySave', { title: '未保存' });
  service.store.local('workspace', { tabs: [{ dirty: true }] });
  await assert.rejects(decide(pending), { code: 'UNSAVED' });
  service.store.local('workspace', { tabs: [] });
  assert.equal((await decide(pending, false)).state, 'rejected');
  const expired = await request('librarySave', { title: '已过期' });
  const entries = service.agentOperations.entries();
  entries.find(item => item.id === expired.id).expiresAt = '2000-01-01T00:00:00.000Z'; service.agentOperations.save(entries);
  assert.equal(service.agentOperations.list().find(item => item.id === expired.id).state, 'expired');
  assert.equal(service.agentOperations.entries().find(item => item.id === expired.id).payload, undefined);
  await assert.rejects(decide(expired), /已处理/);
  await request('librarySave', { title: '撤销后不执行' });
  service.agents.revoke(grant.id);
  assert.equal(service.agentOperations.list().length, 0);
  assert.equal(service.agents.status().audit.length, 0);
});

test('interrupted requests never retry and failed validation leaves no partial records', async t => {
  const { service, request, decide, rpc } = await setup(t);
  const bad = await request('librarySave', { title: '' });
  await assert.rejects(decide(bad));
  assert.equal(service.store.libraries().length, 0);
  assert.equal((await rpc('operationResult', { id: bad.id })).state, 'failed');
  const pending = await request('librarySave', { title: '中断' });
  const entries = service.agentOperations.entries(); entries.find(item => item.id === pending.id).state = 'executing'; service.agentOperations.save(entries);
  const reopened = new AgentOperations(service);
  assert.equal(reopened.list().find(item => item.id === pending.id).state, 'interrupted');
  assert.equal(service.store.libraries().length, 0);
});

test('grants and permanent deletion need local approval; new credentials are delivered once', async t => {
  const { service, request, rpc, decide } = await setup(t);
  const granting = await request('agentGrant', { name: '经确认新增授权', days: 1 });
  assert.equal(service.agents.grants().length, 1);
  await decide(granting);
  const result = await rpc('operationResult', { id: granting.id });
  assert.ok(result.value.token); assert.equal(service.agents.grants().length, 2);
  assert.equal((await rpc('operationResult', { id: granting.id })).value, undefined);
  const library = service.store.saveLibrary({ title: '隔离回收测试' });
  const draft = service.store.write({ type: 'draft', data: { title: '回收对象', domain: library.data.domain, content: '仅供测试' } });
  const trash = await request('delete', { id: draft.id, parents: draft.heads });
  assert.equal(service.store.get(draft.id).deleted, false);
  await decide(trash);
  const preview = (await request('trashPreview', { domain: library.data.domain })).value;
  const purge = await request('trashEmpty', { domain: library.data.domain, token: preview.token, confirmed: true });
  const detail = await service.call('agentOperationDetail', { id: purge.id });
  assert.equal(detail.preview.eligible.length, 1);
  await decide(purge);
  assert.equal(service.store.get(draft.id), null);
  assert.equal((await rpc('operationResult', { id: trash.id })).value, undefined);
});

test('retained request tombstones prevent replay after detailed queue results expire', async t => {
  const { service, request, decide } = await setup(t);
  const id = uuid(), input = { title: '只执行一次' };
  const pending = await request('librarySave', input, id);
  await decide(pending);
  const entries = service.agentOperations.entries(); entries.find(entry => entry.id === pending.id).at = '2000-01-01T00:00:00.000Z';
  service.agentOperations.save(entries);
  await request('librarySave', { title: '触发历史收尾' });
  assert.ok(!service.agentOperations.entries().some(entry => entry.id === pending.id));
  assert.equal((await request('librarySave', input, id)).state, 'completed');
  assert.equal(service.store.libraries().length, 1);
});

test('revocation and startup discard expired orphan requests without recreating receipts', async t => {
  const { service, grant, request } = await setup(t);
  const pending = await request('librarySave', { title: '撤销后清理' });
  const entries = service.agentOperations.entries();
  entries.find(entry => entry.id === pending.id).expiresAt = '2000-01-01T00:00:00.000Z';
  service.agentOperations.save(entries);
  const other = service.agents.createGrant({ name: '仍有效的授权' });
  service.agents.revoke(grant.id);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM agent_requests WHERE grant_id=?').get(grant.id).n, 0);
  assert.equal(service.agentOperations.list().length, 0);
  assert.ok(service.agents.grants().some(item => item.id === other.id));
  // Simulate a queue written by an older process before startup grant cleanup.
  service.store.local('agentOperationQueue', entries);
  const reopened = new AgentOperations(service);
  assert.equal(reopened.list().length, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM agent_requests WHERE grant_id=?').get(grant.id).n, 0);
  reopened.save(entries);
  assert.equal(reopened.list().length, 0);
});

test('queue retention preserves pending requests while pruning completed details', async t => {
  const { service, request, decide } = await setup(t);
  const pending = await request('librarySave', { title: '保留待确认请求' });
  const [entry] = service.agentOperations.entries();
  const completed = Array.from({ length: 500 }, () => ({ ...entry, id: uuid(), requestId: uuid(), state: 'completed', payload: undefined }));
  service.agentOperations.save([entry, ...completed]);
  await request('librarySave', { title: '新增请求' });
  const retained = service.agentOperations.entries();
  assert.equal(retained.length, 500);
  assert.equal(retained.filter(item => item.state === 'pending').length, 2);
  assert.ok(retained.some(item => item.id === pending.id));
  await decide(pending);
  assert.equal(service.store.libraries().length, 1);
});
