import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, validateEvent } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { migrateRetiredAI } from '../src/core/retired-ai.mjs';
import { RETIRED_AI_TYPES } from '../src/core/catalog.mjs';
import { uuid } from '../src/core/util.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studyself-retired-ai-'));
function seed(directory) {
  const store = new Store(directory), library = store.saveLibrary({ title: '保留的知识库' });
  const common = { title: 'retired-ai-sentinel-847232', domain: library.id };
  const chat = store.write({ type: 'conversation', data: { ...common, messages: [{ role: 'assistant', content: common.title }] } });
  const model = store.write({ type: 'model', data: { ...common, providerId: 'custom', modelName: 'old-model' } });
  store.write({ type: 'provider', data: { ...common, providerId: 'custom', protocol: 'openai' } });
  store.write({ type: 'task', data: { ...common, modelId: model.id, ownerDevice: store.deviceId, status: 'running', content: common.title } });
  store.write({ type: 'usage', data: { ...common, modelId: model.id, callId: 'old-call', inputTokens: 2, outputTokens: 3, billedCost: 0.1, currency: 'CNY' } });
  const note = store.write({ type: 'note', data: { title: '模型学习笔记（应保留）', domain: library.id, content: '保留正式知识', sourceIds: [chat.id] } });
  store.local('provider:custom', { endpoint: 'https://invalid.example' });
  store.local('probe:custom', { models: ['old-model'] }); store.local('attempt:old-call', { answer: common.title });
  store.setSecret('api:custom', 'test-only-old-api-key'); store.setSecret('pairing', '6'.repeat(64));
  store.local('agentGrants', [{ id: uuid(), name: 'keep', hash: 'local-test', domains: [library.id] }]);
  store.local('workspace', { tabs: [{ id: 'chat', recordId: chat.id, conversationId: chat.id, prompt: common.title },
    { id: 'note', recordId: note.id, dirty: true, draft: { content: '未保存的笔记' }, modelId: model.id, prompt: common.title }], selectedTab: 'note' });
  store.write({ type: 'workspace', data: { title: '旧聊天工作区', tabs: [{ id: 'chat', recordId: chat.id, conversationId: chat.id, prompt: common.title },
    { id: 'note', recordId: note.id, draft: { content: 'archived note draft must survive' }, prompt: common.title }], domain: library.id } });
  return { store, library, note, chat, model, sentinel: common.title };
}

test('startup physically removes retired histories and credentials while keeping notes, files and Agent settings', async t => {
  const directory = temp(), f = seed(directory);
  const noteEvents = f.store.history(f.note.id), grants = f.store.local('agentGrants');
  fs.writeFileSync(path.join(directory, 'user-original.txt'), 'keep original');
  await new LocalHierarchy(f.store).refresh({ enable: true });
  const oldFiles = Object.keys(f.store.local('hierarchyFiles') || {}).filter(name => name.includes(f.chat.id));
  f.store.close();
  const app = new Service(directory); t.after(() => app.close()); await app.ready;
  assert.equal(app.store.allEvents().some(event => RETIRED_AI_TYPES.includes(event.type)), false);
  assert.deepEqual(app.store.history(f.note.id), noteEvents);
  assert.equal(app.store.get(f.chat.id), null); assert.deepEqual(app.store.history(f.chat.id), []);
  assert.equal(app.store.secret('api:custom'), null); assert.equal(app.store.secret('pairing'), '6'.repeat(64));
  assert.deepEqual(app.store.local('agentGrants'), grants.map(grant => ({ ...grant, domains: [], scope: 'all',
    permissions: ['read', 'collect', 'propose', 'edit', 'trash'], sensitive: true })));
  assert.equal(app.store.local('workspace').tabs.length, 1);
  assert.equal(app.store.local('workspace').tabs[0].draft.content, '未保存的笔记');
  assert.equal(app.store.local('workspace').tabs[0].prompt, undefined);
  assert.equal(app.store.list({ type: 'workspace' })[0].data.tabs[0].draft.content, 'archived note draft must survive');
  assert.equal(fs.readFileSync(path.join(directory, 'user-original.txt'), 'utf8'), 'keep original');
  assert.equal(oldFiles.some(name => fs.existsSync(path.join(directory, name))), false);
  assert.equal(fs.readFileSync(path.join(directory, 'knowledge.sqlite')).includes(Buffer.from(f.sentinel)), false);
  const events = app.store.allEvents(), receipts = app.store.erasures();
  await app.close();
  const again = new Service(directory); t.after(() => again.close()); await again.ready;
  assert.deepEqual(again.store.allEvents(), events); assert.deepEqual(again.store.erasures(), receipts);
});

test('old sync and later concurrent AI messages never restore retired data, but normal history remains', async t => {
  const root = temp(), f = seed(path.join(root, 'old'));
  t.after(() => f.store.close()); f.store.local('workspace', null);
  const oldSync = new CurrentSync(f.store); oldSync.configure(path.join(root, 'sync'), '6'.repeat(64));
  await oldSync.publish();
  const app = new Service(path.join(root, 'new')); t.after(() => app.close()); await app.ready;
  app.transport.configure(path.join(root, 'sync'), '6'.repeat(64));
  await app.transport.importLatest();
  const receipts = app.store.erasures(); await app.transport.importLatest();
  assert.deepEqual(app.store.erasures(), receipts);
  assert.equal(app.store.get(f.chat.id), null);
  assert.equal(app.store.get(f.note.id).data.content, '保留正式知识');
  f.store.write({ id: f.chat.id, type: 'conversation', parents: f.chat.heads,
    data: { ...f.chat.data, messages: [{ role: 'assistant', content: 'later retired answer' }] } });
  await oldSync.publish(); await app.transport.importLatest();
  assert.equal(app.store.get(f.chat.id), null);
  assert.equal(app.store.allEvents().some(event => RETIRED_AI_TYPES.includes(event.type)), false);
  await app.transport.publish();
  const third = new Service(path.join(root, 'third')); t.after(() => third.close()); await third.ready;
  third.transport.configure(path.join(root, 'sync'), '6'.repeat(64)); await third.transport.importLatest();
  assert.equal(third.store.get(f.note.id).data.content, '保留正式知识');
  assert.equal(third.store.get(f.chat.id), null);
});

test('migration rollback preserves data and credentials; malformed retired import cannot gain deletion authority', t => {
  const f = seed(temp()); t.after(() => f.store.close()); f.store.retiredAI = true;
  const original = f.store.eraseRaw.bind(f.store);
  f.store.eraseRaw = () => { throw Error('injected transaction failure'); };
  assert.throws(() => migrateRetiredAI(f.store, validateEvent), /injected/);
  assert.ok(f.store.get(f.chat.id)); assert.equal(f.store.secret('api:custom'), 'test-only-old-api-key');
  f.store.eraseRaw = original;
  const bad = { ...f.store.event(f.chat.heads[0]), hash: '0'.repeat(64) };
  assert.throws(() => f.store.importEvents([bad]), /hash|checksum|Hash|校验/i);
  assert.equal(f.store.erasures().length, 0);
});
