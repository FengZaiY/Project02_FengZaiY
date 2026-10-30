import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Service } from '../src/core/service.mjs';
import { mcpToolName } from '../src/core/agent-mcp.mjs';
import { uuid, sha } from '../src/core/util.mjs';
import { skillExportFiles } from '../web/skill-export.js';

const value = result => { assert.ok(!result.isError, result.content?.[0]?.text); return result.structuredContent.value; };
const errorCode = result => { assert.equal(result.isError, true); return JSON.parse(result.content[0].text).error.code; };

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-routing-'));
  const service = new Service(path.join(directory, 'workspace'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await service.close();
  });
  const library = service.store.saveLibrary({ title: '路由隔离测试' });
  const grant = service.agents.createGrant({ name: '路由回归客户端' });
  await service.agents.configure(true);
  const connect = async () => {
    const client = new Client({ name: `routing-${clients.length}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.agents.status().mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } }
    }));
    const call = (method, args = {}) => client.callTool({ name: mcpToolName(method), arguments: args });
    const boot = value(await call('bootstrap'));
    const write = (method, args, requestId = uuid()) => call(method, {
      preferencesVersion: boot.preferences.version, requestId, ...args
    });
    return { client, call, write, boot };
  };
  // Local approval is simulated only inside this disposable service, never against user data.
  const approve = async pending => {
    const detail = await service.call('agentOperationDetail', { id: pending.id });
    await service.call('agentOperationDecide', { id: pending.id, token: detail.token, approved: true });
  };
  return { service, directory, library, connect, approve };
}

test('fresh MCP sessions discover routing and complete import then attachment readback without losing note fields', async t => {
  const { service, directory, library, connect, approve } = await setup(t);
  const first = await connect();
  const tools = (await first.client.listTools()).tools;
  assert.equal(tools.length, 36);
  assert.ok(tools.every(tool => tool.name.startsWith('FengZaiY_')));
  assert.ok(!tools.some(tool => tool.name === 'list_artifacts'));
  assert.match(first.client.getInstructions(), /list_artifacts/);
  assert.match(tools.find(tool => tool.name === mcpToolName('operation')).description, /assetImport/);
  assert.match(first.boot.skill, /首次发现错工具或无关结果/);
  assert.match(skillExportFiles(service.agents.skillPackage())['SKILL.md'], /FengZaiY 工具路由与进度核验/);

  const file = path.join(directory, 'routing-original.txt');
  const bytes = Buffer.from('isolated attachment original');
  fs.writeFileSync(file, bytes);
  const requestId = uuid(), input = { path: file, domain: '__materials__', duplicateMode: 'reuse' };
  const pending = value(await first.write('operation', { operation: 'assetImport', input }, requestId));
  assert.equal(pending.state, 'pending');
  assert.equal(value(await first.call('operationResult', { id: pending.id })).state, 'pending');
  assert.equal(service.store.list({ type: 'asset' }).length, 0);
  await approve(pending);

  const second = await connect();
  const completed = value(await second.call('operationResult', { id: pending.id }));
  assert.equal(completed.state, 'completed');
  const asset = value(await second.call('record', { id: completed.value.id }));
  assert.equal(asset.data.sha256, sha(bytes));
  assert.equal(value(await second.call('search', { type: 'asset', domain: library.data.domain, query: 'routing-original' })).total, 0);
  assert.equal(value(await second.call('search', { type: 'asset', domain: '__materials__', query: 'routing-original' })).total, 1);
  assert.equal(value(await second.write('operation', { operation: 'assetImport', input }, requestId)).id, pending.id);
  assert.equal(service.store.list({ type: 'asset' }).length, 1);

  const existingBytes = Buffer.from('other isolated attachment');
  const existing = value(await second.write('assetWrite', { domain: '__materials__', filename: 'existing.txt',
    data: existingBytes.toString('base64'), sha256: sha(existingBytes) }));
  const source = service.store.write({ type: 'source', data: { title: '来源', domain: library.data.domain, content: '原始来源' } });
  const parent = service.store.write({ type: 'note', data: { title: '上级', domain: library.data.domain, content: '上级正文' } });
  const note = service.store.write({ type: 'note', data: { title: '待关联笔记', domain: library.data.domain,
    content: '<p>保留正文与<strong>强调</strong></p>', sourceIds: [source.id], assetIds: [existing.id],
    sensitive: true, parentNoteId: parent.id } });
  const third = await connect();
  const read = value(await third.call('record', { id: note.id }));
  const data = { ...read.data, assetIds: [...new Set([...read.data.assetIds, asset.id])] };
  const updateId = uuid();
  const updated = value(await third.write('noteUpdate', { id: read.id, parents: read.heads, data }, updateId));
  const verified = value(await third.call('record', { id: read.id }));
  assert.deepEqual(verified.data, data);
  assert.deepEqual(verified.data.assetIds, [existing.id, asset.id]);
  assert.deepEqual(value(await third.write('noteUpdate', { id: read.id, parents: read.heads, data }, updateId)).heads, updated.heads);
  assert.equal(errorCode(await third.write('noteUpdate', { id: read.id, parents: read.heads,
    data: { ...data, content: '过期覆盖' } })), 'CONFLICT');
  assert.deepEqual(value(await third.call('record', { id: read.id })).data, data);
});

test('confirmed routing preferences reach new connections and exported skill while stale writes are rejected', async t => {
  const { service, library, connect, approve } = await setup(t);
  const old = await connect();
  const content = '首次发现无关工具结果即停止重复；导入和关联须业务回读。';
  const pending = value(await old.write('operation', { operation: 'agentPreferencesSave',
    input: { content, parents: old.boot.preferences.heads } }));
  assert.equal(pending.state, 'pending');
  assert.notEqual(value(await old.call('bootstrap')).preferences.content, content);
  await approve(pending);
  const fresh = await connect();
  assert.equal(fresh.boot.preferences.content, content);
  assert.notEqual(fresh.boot.preferences.version, old.boot.preferences.version);
  const exported = skillExportFiles(service.agents.skillPackage());
  assert.ok(exported['references/preferences.md'].includes(content));
  assert.ok(exported['references/preferences.md'].includes(fresh.boot.preferences.version));
  const data = { title: '隔离草稿', domain: library.data.domain, content: '测试正文' };
  assert.equal(errorCode(await old.write('draftCreate', { data })), 'PREFERENCES_CHANGED');
  assert.equal(service.store.list({ type: 'draft' }).length, 0);
  const draft = value(await fresh.write('draftCreate', { data }));
  assert.equal(value(await fresh.call('record', { id: draft.id })).data.content, data.content);
});

test('proposal submission survives a lost response and fresh connection without duplicating or applying notes', async t => {
  const { service, library, connect } = await setup(t);
  const source = service.store.write({ type: 'source', data: { title: '原始出处', domain: library.data.domain, content: '隔离来源' } });
  const parent = service.store.write({ type: 'note', data: { title: '上级笔记', domain: library.data.domain, content: '上级正文' } });
  const original = service.store.write({ type: 'note', data: {
    title: '待补充笔记', domain: library.data.domain, parentNoteId: parent.id, format: 'html',
    content: '<p>原文与<strong>人工修改</strong></p>', sourceIds: [source.id], assetIds: [], sensitive: true
  } });
  const first = await connect();
  const read = value(await first.call('record', { id: original.id }));
  assert.equal(value(await first.call('search', { type: 'proposal', domain: library.data.domain })).total, 0);
  assert.deepEqual(service.store.get(original.id).heads, original.heads);

  const requestId = uuid(), input = { title: '补充既有内容', domain: library.data.domain,
    items: [{ targetId: read.id, parents: read.heads,
      data: { ...read.data, content: read.data.content + '<h2>补充</h2><p>待确认的新内容</p>' } }] };
  // The write reaches the server, but the next session has no proposal ID from its response.
  await first.write('propose', input, requestId);
  await first.client.close();
  const second = await connect();
  const replay = value(await second.call('propose', {
    ...input, requestId, preferencesVersion: first.boot.preferences.version
  }));
  assert.equal(replay.type, 'proposal');
  const verified = value(await second.call('record', { id: replay.id }));
  assert.equal(verified.data.items.length, 1);
  const item = verified.data.items[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.targetId, original.id);
  assert.deepEqual(item.parents, original.heads);
  assert.deepEqual(item.data, input.items[0].data);
  assert.deepEqual(value(await second.call('record', { id: original.id })).data, read.data);
  const proposals = value(await second.call('search', { type: 'proposal', domain: library.data.domain }));
  assert.equal(proposals.total, 1);
  assert.equal(proposals.records[0].id, replay.id);
  assert.equal(errorCode(await second.write('propose', { ...input, title: '同请求换正文' }, requestId)), 'CONFLICT');

  const edited = service.store.write({ id: original.id, type: 'note', parents: original.heads,
    data: { ...read.data, content: '<p>用户后来修改</p>' } });
  assert.equal(errorCode(await second.write('propose', input)), 'CONFLICT');
  assert.deepEqual(value(await second.call('record', { id: original.id })).heads, edited.heads);
  assert.equal(value(await second.call('search', { type: 'proposal', domain: library.data.domain })).total, 1);
});
