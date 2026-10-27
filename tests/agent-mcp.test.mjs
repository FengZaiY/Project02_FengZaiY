import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Service } from '../src/core/service.mjs';
import { mcpTools, mcpToolName } from '../src/core/agent-mcp.mjs';
import { uuid, sha } from '../src/core/util.mjs';
import { call as httpCall } from '../skills/fengzaiy/scripts/client.mjs';

const root = path.resolve('artifacts/mcp-tests');
fs.mkdirSync(root, { recursive: true });
async function setup(t, options = {}) {
  const service = new Service(fs.mkdtempSync(path.join(root, 'case-')));
  t.after(() => service.close());
  const library = service.store.saveLibrary({ title: 'MCP 测试' });
  const other = service.store.saveLibrary({ title: '隔离知识库' });
  const grant = service.agents.createGrant({ name: 'MCP 测试客户端', domains: [library.data.domain], ...options });
  await service.agents.configure(true);
  const url = service.agents.status().mcpUrl;
  const client = new Client({ name: 'fengzaiy-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  const call = (method, args = {}) => client.callTool({ name: mcpToolName(method), arguments: args });
  const boot = await call('bootstrap');
  const prefs = boot.structuredContent.value.preferences.version;
  const write = (method, args, requestId = uuid()) => call(method, { preferencesVersion: prefs, requestId, ...args });
  return { service, library, other, grant, url, client, call, write, prefs };
}
const noteData = (library, title = '概念') => ({ title, domain: library.data.domain, content: '完整正文', sourceIds: [], assetIds: [] });
const value = result => { assert.ok(!result.isError, result.content?.[0]?.text); return result.structuredContent.value; };
const error = result => { assert.equal(result.isError, true); return JSON.parse(result.content[0].text).error; };

test('FengZaiY discovery hides legacy names while legacy calls share authorization and idempotent receipts', async t => {
  const { service, client, library, prefs, call, grant, url } = await setup(t);
  assert.equal(client.getServerVersion().name, 'FengZaiY');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 28);
  assert.ok(tools.every(tool => tool.name.startsWith('FengZaiY_') && !/studyself/i.test(tool.name)));
  const boot = value(await call('bootstrap'));
  assert.equal(boot.product, 'FengZaiY');
  assert.equal(boot.capabilities.mcp.toolPrefix, 'FengZaiY_');
  assert.ok(!/studyself/i.test(boot.skill + boot.apiReference));
  const args = { requestId: uuid(), preferencesVersion: prefs, data: noteData(library, '旧名称兼容') };
  const old = value(await client.callTool({ name: 'studyself_draft_create', arguments: args }));
  assert.equal(value(await call('draftCreate', args)).id, old.id);
  assert.equal(service.store.list({ type: 'draft' }).length, 1);
  const fromOldEnvironment = await httpCall('record', { id: old.id }, undefined, { STUDYSELF_AGENT_URL: url, STUDYSELF_AGENT_TOKEN: grant.token });
  assert.equal(fromOldEnvironment.id, old.id);
  const invalid = await client.callTool({ name: 'studyself_draft_create', arguments: { ...args, arbitraryPath: 'forbidden' } });
  assert.equal(invalid.isError, true);
  service.agents.revoke(grant.id);
  await assert.rejects(client.callTool({ name: 'studyself_record', arguments: { id: old.id } }));
});

test('all public business MCP tools complete linked local workflows through the SDK and shipped client', async t => {
  const { service, call, write, url, grant, prefs } = await setup(t);
  const save = async (method, data, previous) => value(await write(method, { data, parents: previous?.heads || [], ...(previous ? { id: previous.id } : {}) }));
  const project = await save('projectSave', { title: '审计项目', status: 'active' });
  const task = await save('taskSave', { title: '审计任务', projectId: project.id, status: 'todo', priority: 'high' });
  const done = await save('taskSave', { ...task.data, status: 'done' }, task);
  assert.equal(done.data.status, 'done');
  assert.equal(value(await call('history', { id: done.id })).length, 2);
  assert.equal(error(await write('trash', { id: project.id, parents: project.heads })).code, 'REFERENCED');
  const account = await save('accountSave', { title: '工具账号', website: 'https://example.com', username: 'audit' });
  const subscription = await save('subscriptionSave', { title: '工具订阅', accountId: account.id, amount: 199, currency: 'CNY', cycle: 'monthly', nextDate: '2026-10-01', status: 'active' });
  const cash = await save('moneyAccountSave', { title: '现金', currency: 'CNY', kind: 'cash', opening: 10000, openingDate: '2026-01-01' });
  const bank = await save('moneyAccountSave', { title: '储蓄', currency: 'CNY', kind: 'cash', opening: 0, openingDate: '2026-01-01' });
  await save('moneyEntrySave', { title: '转账', currency: 'CNY', kind: 'transfer', amount: 500, toAmount: 500, accountId: cash.id, toAccountId: bank.id, date: '2026-10-01' });
  const expense = await save('moneyEntrySave', { title: '材料', currency: 'CNY', kind: 'expense', amount: 300, accountId: cash.id, date: '2026-10-01', category: '学习' });
  await save('moneyEntrySave', { title: '退款', currency: 'CNY', kind: 'refund', amount: 100, accountId: cash.id, refundOf: expense.id, date: '2026-10-02' });
  await save('budgetSave', { title: '学习预算', month: '2026-10', category: '学习', amount: 600, currency: 'CNY' });
  const paymentArgs = { id: subscription.id, parents: subscription.heads, accountId: cash.id, date: '2026-10-01' }, request = uuid();
  const payment = value(await write('subscriptionPay', paymentArgs, request));
  assert.equal(value(await write('subscriptionPay', paymentArgs, request)).id, payment.id);
  const report = value(await call('financeReport', { month: '2026-10' }));
  assert.equal(report.complete, true); assert.equal(report.expense, 399); assert.equal(report.netAssets, 9601); assert.equal(report.budgets[0].remaining, 400);
  const collection = await save('collectionSave', { title: '材料集合' }), bytes = Buffer.from('MCP isolated original');
  const asset = value(await write('assetWrite', { domain: '__materials__', filename: 'audit.txt', mime: 'text/plain', data: bytes.toString('base64'), sha256: sha(bytes) }));
  const updated = value(await write('materialUpdate', { id: asset.id, parents: asset.heads, changes: { title: '审计资料', collectionIds: [collection.id] } }));
  await save('taskSave', { ...done.data, assetIds: [asset.id] }, done);
  assert.equal(value(await call('assetRead', { id: asset.id })).data, bytes.toString('base64'));
  assert.deepEqual(updated.data.collectionIds, [collection.id]);
  assert.equal(error(await write('trash', { id: asset.id, parents: updated.heads })).code, 'ASSET_REFERENCED');
  const env = { FENGZAIY_AGENT_URL: url, FENGZAIY_AGENT_TOKEN: grant.token };
  const viaSkill = await httpCall('accountSave', { preferencesVersion: prefs, parents: [], data: { title: 'Skill 脚本账号' } }, uuid(), env);
  assert.equal((await httpCall('record', { id: viaSkill.id }, undefined, env)).data.title, 'Skill 脚本账号');
  assert.equal(value(await write('trash', { id: viaSkill.id, parents: viaSkill.heads })).deleted, true);
  assert.ok(value(await call('personalList', { type: 'loginAccount', trash: true })).some(r => r.id === viaSkill.id));
  const prepared = await service.passwordVault.setup({ password: 'mcp-audit-master-password' });
  service.passwordVault.confirmSetup({ token: prepared.token, confirmed: true });
  const secret = service.passwordVault.save({ accountId: account.id, value: { password: 'mcp-audit-secret-value' } });
  assert.equal(error(await call('record', { id: secret.id })).code, 'FORBIDDEN');
  assert.equal(value(await call('search', { query: 'mcp-audit-secret-value' })).total, 0);
  assert.ok(!JSON.stringify(value(await call('personalList'))).includes('mcp-audit-secret-value'));
  assert.ok(!JSON.stringify(value(await call('financeReport'))).includes(service.store.directory));
  service.agents.revoke(grant.id);
  await assert.rejects(httpCall('personalList', {}, undefined, env));
});

test('shipped Skill client reads standard text-only MCP tool results', async t => {
  const expected = { records: [{ id: uuid(), title: '文本结果' }] };
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const input = JSON.parse(request.body);
    if (input.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = input.method === 'initialize' ? { protocolVersion: '2025-11-25' }
      : input.method === 'tools/list' ? { tools: [{ name: 'FengZaiY_personal_list' }] }
        : { content: [{ type: 'text', text: JSON.stringify(expected) }] };
    return Response.json({ jsonrpc: '2.0', id: input.id, result });
  });
  assert.deepEqual(await httpCall('personalList', {}, undefined, { FENGZAIY_AGENT_URL: 'http://127.0.0.1:12345/mcp', FENGZAIY_AGENT_TOKEN: 'test' }), expected);
});

test('personal MCP tools atomically write nonsecret records, replay and reject vault fields', async t => {
  const { service, call, write } = await setup(t), projectId = uuid();
  const items = [{ type: 'personalProject', id: projectId, parents: [], data: { title: 'MCP 项目', status: 'active' } },
    { type: 'personalTask', parents: [], data: { title: 'MCP 任务', projectId, status: 'todo', priority: 'normal' } }];
  const requestId = uuid(), batch = value(await write('personalBatch', { items }, requestId));
  assert.equal(value(await write('personalBatch', { items }, requestId)).records[1].id, batch.records[1].id);
  assert.equal(value(await call('personalList', { type: 'personalTask' })).length, 1);
  assert.equal((await write('accountSave', { parents: [], data: { title: '秘密不得提交', password: 'forbidden' } })).isError, true);
  assert.equal(service.store.list({ type: 'loginAccount' }).length, 0);
  assert.equal((await call('personalList', { type: 'vaultSecret' })).isError, true);
  assert.equal((await call('vaultUnlock', { password: 'forbidden' })).isError, true);
  const before = service.store.allEvents().length;
  assert.equal((await write('personalBatch', { items: [{ type: 'loginAccount', parents: [], data: { title: '应回滚' } }, { type: 'personalTask', parents: [], data: { title: '缺少状态' } }] })).isError, true);
  assert.equal(service.store.allEvents().length, before);
});

test('MCP SDK handshake, scoped discovery, bootstrap and collection-to-reviewed-proposal', async t => {
  const { service, library, client, call, write, grant } = await setup(t);
  assert.equal(client.getServerVersion().name, 'FengZaiY');
  assert.match(client.getInstructions(), /bootstrap/);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(item => item.name).sort(), mcpTools.filter(item => grant.permissions.includes(item[1])).map(item => mcpToolName(item[0])).sort());
  assert.ok(tools.every(item => item.inputSchema.type === 'object' && item.annotations.openWorldHint === false));
  assert.ok(value(await call('libraries')).some(item => item.id === library.id));
  assert.equal(tools.length, mcpTools.length);
  assert.equal(value(await call('bootstrap')).capabilities.mcp.transport, 'streamable-http');
  const draft = value(await write('draftCreate', { data: noteData(library) }));
  const proposal = value(await write('propose', { title: '构建知识体系', domain: library.data.domain,
    items: [{ key: 'root', data: noteData(library, '概览'), draftRefs: [{ id: draft.id, versionId: draft.heads[0], complete: true }] },
      { key: 'child', parentKey: 'root', data: noteData(library, '下级概念') }] }));
  assert.equal(proposal.data.items.length, 2);
  assert.equal(service.store.list({ type: 'note' }).length, 0);
  assert.equal(value(await call('search', { type: 'draft', query: '概念' })).total, 1);
  assert.equal(value(await call('record', { id: draft.id })).data.content, '完整正文');
  assert.equal(value(await call('history', { id: draft.id })).length, 1);
  assert.ok(service.agents.status().audit.some(item => item.method === 'propose' && item.result === 'OK'));
  assert.ok(!JSON.stringify(service.agents.status()).includes(grant.token));
});

test('MCP writes preserve idempotency, preference and base-version checks', async t => {
  const { service, library, write, call, prefs, grant } = await setup(t);
  const requestId = uuid(), data = noteData(library);
  const draft = value(await write('draftCreate', { data }, requestId));
  assert.equal(value(await write('draftCreate', { data }, requestId)).id, draft.id);
  const replay = await httpCall('draftCreate', { data, preferencesVersion: prefs }, requestId,
    { FENGZAIY_AGENT_URL: service.agents.status().url, FENGZAIY_AGENT_TOKEN: grant.token });
  assert.equal(replay.id, draft.id);
  assert.equal(error(await write('draftCreate', { data: { ...data, title: '不同内容' } }, requestId)).code, 'CONFLICT');
  const changed = value(await write('draftUpdate', { id: draft.id, parents: draft.heads, data: { ...data, content: '新正文' } }));
  assert.equal(error(await write('draftUpdate', { id: draft.id, parents: draft.heads, data })).code, 'CONFLICT');
  assert.equal(value(await call('record', { id: draft.id })).heads[0], changed.heads[0]);
  service.agents.savePreferences({ content: '更新偏好', parents: [] });
  assert.equal(error(await write('draftCreate', { data })).code, 'PREFERENCES_CHANGED');
  assert.equal(service.store.list({ type: 'draft' }).length, 1);
  const missingId = await call('draftCreate', { data });
  assert.equal(missingId.isError, true);
});

test('MCP allows all library and sensitive records but refuses system tools; revocation is immediate', async t => {
  const { service, library, other, client, call, write, grant } = await setup(t);
  const outside = service.store.write({ type: 'note', data: noteData(other) });
  const sensitive = service.store.write({ type: 'note', data: { ...noteData(library), sensitive: true } });
  for (const id of [outside.id, sensitive.id]) assert.equal(value(await call('record', { id })).id, id);
  assert.equal(value(await write('sourceCreate', { data: noteData(other) })).data.domain, other.data.domain);
  for (const method of ['approve', 'trashEmpty', 'agentGrant', 'agentPreferencesSave', 'storageSelect']) {
    assert.equal((await client.callTool({ name: mcpToolName(method), arguments: {} })).isError, true);
  }
  service.agents.revoke(grant.id);
  await assert.rejects(call('bootstrap'), /401|授权/);
  await assert.rejects(client.listTools(), /401|授权/);
});

test('MCP extra permissions and binary attachments still use existing protections', async t => {
  const { service, library, client, call, write } = await setup(t, { edit: true, trash: true });
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'FengZaiY_note_update'));
  const bytes = Buffer.from('原始资料'), hash = sha(bytes);
  const asset = value(await write('assetWrite', { filename: 'source.txt', mime: 'text/plain', domain: library.data.domain, sha256: hash, data: bytes.toString('base64') }));
  const read = value(await call('assetRead', { id: asset.id }));
  assert.equal(read.data, bytes.toString('base64'));
  assert.ok(!Object.hasOwn(read, 'path'));
  const event = service.store.write({ type: 'note', data: noteData(library) });
  const note = service.store.get(event.id);
  value(await write('noteUpdate', { id: note.id, parents: note.heads, data: { ...note.data, content: '显式编辑' } }));
  const latest = service.store.get(note.id);
  assert.equal(value(await write('trash', { id: latest.id, parents: latest.heads })).deleted, true);
});

function raw(url, token, { method = 'POST', headers = {}, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('MCP validates Host, Origin, credentials, HTTP methods, JSON and protocol headers', async t => {
  const { service, url, grant } = await setup(t);
  assert.equal((await raw(new URL('/v1/rpc', url), grant.token)).status, 404);
  assert.equal((await raw(url, '0'.repeat(64))).status, 401);
  assert.equal((await raw(url, grant.token, { headers: { Origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await raw(url, grant.token, { headers: { Host: 'evil.invalid' } })).status, 403);
  assert.equal((await raw(url, grant.token, { method: 'GET', body: '' })).status, 405);
  assert.equal((await raw(url, grant.token, { method: 'DELETE', body: '' })).status, 405);
  assert.equal(JSON.parse((await raw(url, grant.token, { body: '{broken' })).text).error.code, -32700);
  assert.equal((await raw(url, grant.token, { headers: { 'MCP-Protocol-Version': '1900-01-01' } })).status, 400);
  const batch = await raw(url, grant.token, { body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]) });
  assert.equal(batch.status, 400);
  const large = await raw(url, grant.token, { body: JSON.stringify({ unused: 'x'.repeat(23 * 1024 * 1024) }) });
  assert.equal(large.status, 400);
  assert.ok(!large.text.includes(service.store.directory));
  service.store.local('agentGrants', service.agents.grants().map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00.000Z' })));
  assert.equal((await raw(url, grant.token)).status, 401);
  await service.agents.configure(false);
  assert.equal(service.agents.status().mcpUrl, null);
});

test('revocation while a request body is arriving rejects it before executing the MCP tool', async t => {
  const { service, url, grant, library, prefs } = await setup(t);
  let observed;
  const arriving = new Promise(resolve => { observed = resolve; });
  service.agents.server.once('request', observed);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'late', method: 'tools/call', params: {
    name: 'FengZaiY_draft_create', arguments: { requestId: uuid(), preferencesVersion: prefs, data: noteData(library) }
  } });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject); request.write(body.slice(0, 30));
  });
  await arriving;
  service.agents.revoke(grant.id);
  request.end(body.slice(30));
  assert.equal(await response, 401);
  assert.equal(service.store.list({ type: 'draft' }).length, 0);
  assert.equal(service.agents.grants().length, 0);
  assert.equal(service.agents.status().audit.length, 0);
});
