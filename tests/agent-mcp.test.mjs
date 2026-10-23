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
import { call as httpCall } from '../skills/studyself-organize/scripts/client.mjs';

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
  const client = new Client({ name: 'studyself-test', version: '1.0.0' });
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

test('MCP SDK handshake, scoped discovery, bootstrap and collection-to-reviewed-proposal', async t => {
  const { service, library, client, call, write, grant } = await setup(t);
  assert.equal(client.getServerVersion().name, 'studyself');
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
    { STUDYSELF_AGENT_URL: service.agents.status().url, STUDYSELF_AGENT_TOKEN: grant.token });
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
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'studyself_note_update'));
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
    name: 'studyself_draft_create', arguments: { requestId: uuid(), preferencesVersion: prefs, data: noteData(library) }
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
