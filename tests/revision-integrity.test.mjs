import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, cleanData, validateEvent } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { makePairingKey } from '../src/core/transport.mjs';
import { canonical, sha, uuid } from '../src/core/util.mjs';
import { persistentRevisionData, revisionChecksum } from '../src/core/revision-integrity.mjs';
import { sealBinary } from '../src/core/sync-objects.mjs';

const root = path.resolve('artifacts/revision-integrity-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(root, 'case-')), stores = [], key = makePairingKey();
  const open = name => {
    const store = new Store(path.join(base, name)); stores.push(store);
    const sync = new CurrentSync(store, { reserveBytes: 0 }); sync.configure(path.join(base, 'cloud'), key);
    return { store, sync };
  };
  t.after(() => stores.forEach(store => { if (store.db.isOpen) store.close(); }));
  return { base, open };
}
function oldEvent(store, type, data, extra = {}) {
  const content = { schema: 1, id: uuid(), entityId: uuid(), deviceId: store.deviceId,
    sequence: 1, type, createdAt: new Date().toISOString(), parents: [], deleted: false, data: cleanData(type, data), ...extra };
  const event = { ...content, hash: sha(canonical(content)) };
  return { original: event, persisted: JSON.parse(JSON.stringify(event)) };
}
const publish = async sync => { await sync.plan(); while ((await sync.publish()).job.state !== 'complete') {} };

test('new writes normalize optional fields and remain exact after database roundtrip and restart', t => {
  const f = fixture(t), a = f.open('A');
  const library = a.store.saveLibrary({ title: '新数据' });
  const record = a.store.write({ type: 'note', data: { title: '测试', domain: library.data.domain, content: undefined, format: undefined, assetIds: undefined } });
  const event = a.store.event(record.heads[0]);
  assert.equal(Object.hasOwn(event.data, 'content'), false);
  assert.equal(revisionChecksum(event).kind, 'exact');
  const workspace = a.store.write({ type: 'workspace', data: { title: '布局', selectedTab: undefined,
    tabs: [{ id: uuid(), scroll: undefined, data: { nested: undefined, values: [undefined, , 3] } }] } });
  assert.deepEqual(a.store.get(workspace.id).data.tabs[0].data, { values: [null, null, 3] });
  a.store.close();
  const reopened = f.open('A');
  assert.equal(reopened.store.revisionIntegrity().invalid, 0);
  assert.equal(reopened.store.revisionIntegrity().compatible, 0);
  assert.deepEqual(reopened.store.event(event.id), event);
});

test('non-JSON input is rejected atomically, without invoking getters or losing saved history', t => {
  const { open } = fixture(t), { store } = open('A'), library = store.saveLibrary({ title: '校验' });
  const before = canonical(store.allEvents());
  const cycle = {}; cycle.self = cycle;
  let getterCalls = 0;
  const dynamic = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  for (const value of [cycle, new Date(), Infinity, 1n, () => {}, dynamic]) {
    assert.throws(() => store.write({ type: 'workspace', data: { title: '非法', tabs: [{ value }] } }));
  }
  assert.equal(getterCalls, 0); assert.equal(canonical(store.allEvents()), before);
  assert.throws(() => persistentRevisionData({ value: Symbol('x') }));
});

test('legacy omissions are proven against original hash without rewriting identity, content or history', t => {
  const { open } = fixture(t), { store } = open('A');
  const { original, persisted } = oldEvent(store, 'note', { title: '旧笔记', content: '正文', format: undefined, sourceIds: undefined });
  const { hash, ...body } = persisted;
  assert.notEqual(sha(canonical(body)), hash);
  const before = JSON.stringify(persisted);
  validateEvent(persisted);
  assert.equal(revisionChecksum(persisted).kind, 'legacy-undefined');
  assert.deepEqual(revisionChecksum(persisted).fields.sort(), ['data.format', 'data.sourceIds']);
  store.insert(persisted, false);
  assert.equal(JSON.stringify(store.event(persisted.id)), before);
  assert.equal(store.event(persisted.id).hash, original.hash);
  assert.equal(store.revisionIntegrity().compatible, 1);
  const edit = store.write({ id: persisted.entityId, parents: [persisted.id], type: 'note', data: { ...persisted.data, content: '后续修改' } });
  assert.equal(revisionChecksum(store.event(edit.heads[0])).kind, 'exact');
  assert.equal(store.history(persisted.entityId).length, 2);
});

test('workspace tabs and proposal bodies retain verifiable legacy omitted fields', t => {
  const { open } = fixture(t), { store } = open('A');
  const events = [oldEvent(store, 'workspace', { title: '布局', selectedTab: undefined,
    tabs: [{ id: uuid(), title: '笔记', domain: '领域', recordId: uuid(), scroll: undefined }] }).persisted,
  oldEvent(store, 'proposal', { title: '方案', items: [{ id: uuid(), targetId: uuid(), parents: [], status: 'pending',
    data: { title: '候选', content: '正文', format: undefined } }] }).persisted];
  for (const event of events) {
    validateEvent(event); assert.equal(revisionChecksum(event).kind, 'legacy-undefined');
    assert.equal(JSON.stringify(event), JSON.stringify(JSON.parse(JSON.stringify(event))));
  }
});

test('tampering, unsupported omissions and reused IDs never bypass validation or cache', t => {
  const { open } = fixture(t), { store } = open('A');
  const event = oldEvent(store, 'note', { title: '旧版', content: '原文', format: undefined }).persisted;
  validateEvent(event);
  for (const changed of [{ ...event, data: { ...event.data, content: '篡改' } }, { ...event, deviceId: uuid() },
    { ...event, parents: [uuid()] }, { ...event, hash: 'a'.repeat(64) }]) {
    assert.throws(() => validateEvent(changed), error => error.code === 'CHECKSUM_MISMATCH' && error.message.includes(event.id));
    assert.throws(() => store.insert(changed, true), /checksum/);
  }
  const unsupported = oldEvent(store, 'workspace', { title: '未知扩展', tabs: [{ arbitraryMissing: undefined }] }).persisted;
  assert.throws(() => validateEvent(unsupported), /checksum/);
  assert.equal(store.allEvents().length, 0);
});

test('legacy records publish and merge both ways, remain idempotent and preserve concurrent heads', async t => {
  const f = fixture(t), a = f.open('A'), b = f.open('B');
  const library = a.store.saveLibrary({ title: '同步' });
  const event = oldEvent(a.store, 'note', { title: '旧笔记', domain: library.data.domain, content: '原文', format: undefined }).persisted;
  a.store.insert(event, false);
  await publish(a.sync);
  assert.deepEqual(b.sync.scan().errors, []);
  await b.sync.importLatest();
  assert.deepEqual(b.store.event(event.id), event);
  assert.equal((await b.sync.importLatest()).imported, 0);
  for (const [owner, content] of [[a, 'A 修改'], [b, 'B 修改']]) owner.store.write({ id: event.entityId,
    type: 'note', parents: [event.id], data: { ...event.data, content } });
  await publish(b.sync); await publish(a.sync);
  await a.sync.importLatest(); await b.sync.importLatest();
  for (const owner of [a, b]) {
    assert.equal(owner.store.get(event.entityId).conflict, true);
    assert.equal(owner.store.get(event.entityId).heads.length, 2);
    assert.deepEqual(owner.store.event(event.id), event);
    assert.equal(owner.store.revisionIntegrity().compatible, 1);
  }
});

test('corrupt local history blocks publication and diagnostics never change it', async t => {
  const { open } = fixture(t), { store, sync } = open('A');
  const record = store.write({ type: 'note', data: { title: '坏记录', content: '正文' } });
  const event = store.event(record.heads[0]); event.data.content = '损坏';
  store.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify(event), event.id);
  const before = canonical(store.allEvents());
  const report = store.revisionIntegrity();
  assert.equal(report.invalid, 1); assert.equal(report.issues[0].id, event.id);
  await assert.rejects(sync.plan(), /checksum/);
  assert.equal(canonical(store.allEvents()), before);
  assert.equal(sync.value('plan'), null);
});

test('scan distinguishes missing files from checksum failure; failed import is atomic', async t => {
  const { open } = fixture(t), a = open('A'), b = open('B');
  a.store.write({ type: 'note', data: { title: '正常记录', content: '正文' } });
  await publish(a.sync);
  const channel = a.sync.channel(), manifest = structuredClone(a.sync.value('latest'));
  const part = manifest.parts[0], validBytes = channel.read(part.name, `v3:history:${part.hash}`);
  fs.renameSync(channel.file(part.name), channel.file(`held-${part.hash}.ssobj`));
  assert.equal(b.sync.scan().entries[0].missing.length, 1);
  fs.renameSync(channel.file(`held-${part.hash}.ssobj`), channel.file(part.name));
  const events = JSON.parse(validBytes.toString()); events[0].data.title = '损坏';
  const bytes = Buffer.from(canonical(events)), hash = sha(bytes);
  const badPart = { name: `history-${hash}.ssobj`, hash, size: bytes.length, count: events.length };
  channel.write(badPart.name, bytes, `v3:history:${hash}`);
  manifest.parts = [badPart];
  manifest.digest = sha(canonical({ parts: manifest.parts, control: manifest.control, assets: manifest.assets,
    ...(manifest.format >= 4 ? { erasures: manifest.erasures } : {}) }));
  const deviceId = manifest.deviceId;
  fs.writeFileSync(channel.file(`current-${deviceId}.sscurrent`), sealBinary(Buffer.from(canonical(manifest)), channel.key, `v3:current:${deviceId}`));
  const scan = b.sync.scan();
  assert.equal(scan.entries[0].missing.length, 0);
  assert.equal(scan.entries[0].invalid.length, 1);
  assert.match(scan.errors[0].message, /checksum/);
  await assert.rejects(b.sync.importLatest(), /checksum/);
  assert.equal(b.store.allEvents().length, 0);
});

test('diagnostic method remains trusted UI only', async t => {
  const { base } = fixture(t), service = new Service(path.join(base, 'service'));
  t.after(() => service.close());
  assert.equal((await service.call('syncIntegrity')).invalid, 0);
  const workspace = await service.call('workspacePublish', { tabs: [] });
  assert.equal(revisionChecksum(service.store.event(workspace.heads[0])).kind, 'exact');
  const library = service.store.saveLibrary({ title: '权限' }), access = new AgentAccess(service.store);
  const issued = access.createGrant({ name: '外部测试', domains: [library.data.domain] });
  const grant = access.grants().find(item => item.id === issued.id);
  assert.throws(() => access.dispatch(grant, { method: 'syncIntegrity', input: {}, requestId: uuid() }));
});
