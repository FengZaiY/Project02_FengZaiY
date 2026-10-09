import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.mjs';
import { FolderTransport, makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { BackupManager } from '../src/core/backup.mjs';
import { ModelManager } from '../src/core/models.mjs';
import { Service } from '../src/core/service.mjs';
import { uuid, sha, canonical } from '../src/core/util.mjs';

const root = path.resolve(fileURLToPath(new URL('../artifacts/tests/', import.meta.url)));
fs.mkdirSync(root, { recursive: true });
function setup(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), root);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const open = name => { const store = new Store(path.join(directory, name), { deviceName: name }); stores.push(store); return store; };
  const a = open('A'), b = open('B'), key = makePairingKey();
  const ta = new FolderTransport(a), tb = new FolderTransport(b);
  ta.configure(path.join(directory, 'cloud-A'), key);
  tb.configure(path.join(directory, 'cloud-B'), key);
  const deliver = (from, to) => {
    for (const name of fs.readdirSync(from.root())) {
      if (name.endsWith('.ssync')) fs.copyFileSync(path.join(from.root(), name), path.join(to.root(), name));
    }
  };
  const sync = async () => { await ta.cycle(); deliver(ta, tb); await tb.cycle(); deliver(tb, ta); await ta.cycle(); };
  return { directory, a, b, ta, tb, key, deliver, sync, open };
}
function note(store, content = 'original', extra = {}) {
  return store.write({ type: 'note', data: { title: 'A note', domain: 'AI', content, ...extra } });
}
function edit(store, record, content) {
  return store.write({ id: record.id, type: record.type, parents: record.heads, data: { ...record.data, content } });
}

test('asynchronous two-folder delivery, stable IDs and acknowledgements', async t => {
  const { a, b, ta, tb, deliver } = setup(t);
  const record = note(a);
  assert.equal(a.get(record.id).status, 'local');
  await ta.cycle();
  assert.equal(a.get(record.id).status, 'waiting');
  assert.equal(b.get(record.id), null);
  deliver(ta, tb);
  await tb.cycle();
  assert.equal(b.get(record.id).data.content, 'original');
  deliver(tb, ta);
  await ta.cycle();
  assert.equal(a.get(record.id).status, 'received');
  edit(b, b.get(record.id), 'from B');
  await tb.cycle(); deliver(tb, ta); await ta.cycle();
  assert.equal(a.get(record.id).data.content, 'from B');
});
test('concurrent edits preserve both heads and explicit resolution creates history', async t => {
  const { a, b, sync } = setup(t);
  const base = note(a); await sync();
  edit(a, a.get(base.id), 'home');
  edit(b, b.get(base.id), 'office');
  await sync();
  const conflict = a.get(base.id);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(new Set(conflict.versions.map(v => v.data.content)), new Set(['home', 'office']));
  edit(a, conflict, 'merged by user'); await sync();
  assert.equal(b.get(base.id).conflict, false);
  assert.equal(b.get(base.id).data.content, 'merged by user');
  assert.equal(a.history(base.id).length, 4);
});
test('stale editor cannot overwrite a synchronized revision', t => {
  const { a } = setup(t);
  const base = note(a); edit(a, base, 'new');
  assert.throws(() => edit(a, base, 'stale'), { code: 'CONFLICT' });
  assert.equal(a.get(base.id).data.content, 'new');
});
test('replay is idempotent and transfer is encrypted', async t => {
  const { a, b, ta, sync } = setup(t);
  const marker = 'PRIVATE-LEARNING-12345';
  note(a, marker);
  await sync(); await sync(); await sync();
  assert.equal(b.allEvents().length, 1);
  for (const file of fs.readdirSync(ta.root())) {
    assert.ok(!fs.readFileSync(path.join(ta.root(), file), 'utf8').includes(marker));
  }
});
test('child arriving before its parents stays invisible until dependencies arrive', t => {
  const { a, b } = setup(t);
  const base = note(a); const child = edit(a, base, 'child');
  const parentEvent = a.event(base.heads[0]), childEvent = a.event(child.heads[0]);
  assert.equal(b.importEvents([childEvent]).pending, 1);
  assert.equal(b.get(base.id), null);
  b.importEvents([parentEvent]);
  assert.equal(b.get(base.id).data.content, 'child');
  assert.equal(b.summary().pendingParents, 0);
});
test('truncated or tampered packets are rejected; a completed retry is accepted', async t => {
  const { a, b, ta, tb, deliver } = setup(t);
  const record = note(a);
  await ta.cycle(); deliver(ta, tb);
  const filename = fs.readdirSync(tb.root()).find(name => name.startsWith('events-'));
  const file = path.join(tb.root(), filename), original = fs.readFileSync(file);
  fs.writeFileSync(file, original.subarray(0, 70));
  const report = await tb.cycle();
  assert.equal(report.errors.length, 1); assert.equal(b.get(record.id), null);
  fs.writeFileSync(path.join(tb.root(), 'in-progress.partial'), original.subarray(0, 10));
  fs.writeFileSync(file, original);
  await tb.cycle(); assert.ok(b.get(record.id));
});
test('revision ID collision and bad checksum do not modify history', t => {
  const { a, b } = setup(t);
  const record = note(a), event = a.event(record.heads[0]);
  b.importEvents([event]);
  const changed = structuredClone(event); changed.data.content = 'tampered';
  assert.throws(() => b.importEvents([changed]), /checksum/);
  const { hash, ...content } = changed; changed.hash = sha(canonical(content));
  assert.throws(() => b.importEvents([changed]), /collision/);
  assert.equal(b.allEvents().length, 1);
});
test('delete versus edit is a visible conflict, and restoration propagates', async t => {
  const { a, b, sync } = setup(t);
  const base = note(a); await sync();
  a.remove(base.id, a.get(base.id).heads);
  edit(b, b.get(base.id), 'keep this edit'); await sync();
  const conflict = a.get(base.id);
  assert.equal(conflict.conflict, true); assert.equal(conflict.deleted, false);
  a.restoreVersion(base.id, base.heads[0], conflict.heads); await sync();
  assert.equal(b.get(base.id).data.content, 'original');
  const restored = a.get(base.id); a.remove(base.id, restored.heads); await sync();
  assert.equal(b.list({ trash: true }).length, 1);
  a.restoreVersion(base.id, base.heads[0], a.get(base.id).heads); await sync();
  assert.equal(b.list({ trash: true }).length, 0);
});
test('missing local files never create deletion revisions', async t => {
  const { a, b, sync } = setup(t);
  const record = note(a); await sync();
  await sync(); assert.ok(b.get(record.id)); assert.equal(b.get(record.id).deleted, false);
});
test('small attachments transfer by content identity, not source paths', async t => {
  const { directory, a, b, sync } = setup(t);
  const input = path.join(directory, 'source.txt'); fs.writeFileSync(input, 'asset body');
  const asset = await importAttachment(a, input);
  const record = note(a, 'see attachment', { assetIds: [asset.id] });
  await sync();
  assert.ok(b.get(record.id));
  const local = b.assetLocation(asset.id);
  assert.equal(fs.readFileSync(local.path, 'utf8'), 'asset body');
  assert.notEqual(local.path, a.assetLocation(asset.id).path);
});
test('large attachment metadata remains readable and manual association verifies its hash', async t => {
  const { directory, a, b, sync } = setup(t);
  const input = path.join(directory, 'video.mp4');
  fs.writeFileSync(input, Buffer.alloc(17 * 1024 * 1024, 2));
  const asset = await importAttachment(a, input);
  const record = note(a, 'video notes', { assetIds: [asset.id] }); await sync();
  assert.equal(b.get(record.id).data.content, 'video notes');
  assert.equal(b.assetLocation(asset.id), undefined);
  const wrong = path.join(directory, 'wrong.mp4'); fs.writeFileSync(wrong, 'bad');
  await assert.rejects(importAttachment(b, wrong, { expectedId: asset.id }), /does not match/);
  await importAttachment(b, input, { expectedId: asset.id, pinned: true });
  assert.equal(b.assetLocation(asset.id).pinned, 1);
});
test('partial proposal approval retains pending items and supports later acceptance', t => {
  const { a } = setup(t);
  const items = ['First', 'Second'].map(title => ({ id: uuid(), targetId: uuid(), parents: [], data: { title, domain: 'AI', tags: [], content: title }, status: 'pending' }));
  const proposal = a.write({ type: 'proposal', data: { title: 'Batch', domain: 'AI', items } });
  const first = a.approve(proposal.id, [items[0].id], proposal.heads);
  assert.equal(a.list({ type: 'note' }).length, 1);
  assert.deepEqual(first.data.items.map(i => i.status), ['accepted', 'pending']);
  a.approve(proposal.id, [items[1].id], first.heads);
  assert.equal(a.list({ type: 'note' }).length, 2);
});
test('approval against a stale target rolls back the entire selected operation', t => {
  const { a } = setup(t);
  const base = note(a), target = uuid();
  const proposal = a.write({ type: 'proposal', data: { title: 'Batch', items: [
    { id: uuid(), targetId: target, parents: [], data: { title: 'New', content: 'new' } },
    { id: uuid(), targetId: base.id, parents: base.heads, data: { ...base.data, content: 'replace' } }
  ] } });
  edit(a, base, 'changed after proposal');
  assert.throws(() => a.approve(proposal.id, proposal.data.items.map(i => i.id), proposal.heads), { code: 'CONFLICT' });
  assert.equal(a.get(target), null);
  assert.ok(a.get(proposal.id).data.items.every(i => i.status === 'pending'));
});
test('independent backups preserve history and attachments but exclude local secrets', async t => {
  const { directory, a, b } = setup(t);
  a.setSecret('api:test', 'DO-NOT-EXPORT-SECRET');
  const input = path.join(directory, 'pic.png'); fs.writeFileSync(input, 'image bytes');
  await importAttachment(a, input);
  const record = note(a); edit(a, record, 'second');
  const backup = new BackupManager(a);
  const result = await backup.create(path.join(directory, 'backups'));
  assert.equal(result.cloudVerified, false); assert.equal(result.localComplete, true);
  assert.ok(!fs.readFileSync(path.join(result.directory, 'revisions.json'), 'utf8').includes('DO-NOT-EXPORT'));
  const restored = await new BackupManager(b).restore(result.directory);
  assert.equal(restored.imported, 3); assert.equal(b.history(record.id).length, 2);
  assert.equal(b.secret('api:test'), null);
  assert.notEqual(a.deviceId, b.deviceId);
});
test('corrupt backups fail before changing destination history', async t => {
  const { directory, a, b } = setup(t);
  note(a);
  const result = await new BackupManager(a).create(path.join(directory, 'backups'));
  fs.appendFileSync(path.join(result.directory, 'revisions.json'), 'truncated');
  await assert.rejects(new BackupManager(b).restore(result.directory), /checksum/);
  assert.equal(b.allEvents().length, 0);
});
test('deferred large-file backup can be completed explicitly', async t => {
  const { directory, a } = setup(t);
  const input = path.join(directory, 'big.bin'); fs.writeFileSync(input, Buffer.alloc(17 * 1024 * 1024));
  await importAttachment(a, input);
  const manager = new BackupManager(a);
  const result = await manager.create(path.join(directory, 'backups'));
  assert.equal(result.pending.length, 1); assert.equal(result.localComplete, false);
  const complete = await manager.continue(result.directory);
  assert.equal(complete.localComplete, true); assert.equal(complete.cloudVerified, false);
});
test('cost aggregation deduplicates request IDs and keeps currencies separate', t => {
  const { a } = setup(t);
  const data = { title: 'Usage', callId: 'request-A', inputTokens: 10, outputTokens: 20, estimatedCost: 0.1, billedCost: null, currency: 'CNY' };
  a.write({ type: 'usage', data }); a.write({ type: 'usage', data });
  a.write({ type: 'usage', data: { ...data, callId: 'request-B', currency: 'USD' } });
  const usage = a.usage();
  assert.equal(usage.totals.CNY.requests, 1); assert.equal(usage.totals.USD.requests, 1);
  assert.equal(usage.realtime, false); assert.equal(usage.duplicates.length, 1);
});
test('model catalogs synchronize, but keys and installed-model state do not', async t => {
  const { a, b, sync } = setup(t);
  const manager = new ModelManager(a);
  manager.configure({ id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com', apiKey: 'private-key' });
  const model = a.write({ type: 'model', data: { title: 'My model', providerId: 'deepseek', modelName: 'chosen-model' } });
  await sync();
  assert.equal(manager.availability(model.id).available, true);
  assert.equal(new ModelManager(b).availability(model.id).available, false);
  assert.equal(b.secret('api:deepseek'), null);
});
test('sensitive sources and domain scope block cloud prompts before any request', t => {
  const { a } = setup(t);
  const manager = new ModelManager(a, () => { throw new Error('Network should not be used'); });
  manager.configure({ id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com', apiKey: 'secret' });
  const model = a.write({ type: 'model', data: { title: 'Cloud', providerId: 'deepseek', modelName: 'm' } });
  const source = a.write({ type: 'source', data: { title: 'Private source', domain: 'AI', sensitive: true } });
  const record = note(a, 'text', { sourceIds: [source.id] });
  assert.throws(() => manager.estimate({ modelId: model.id, noteId: record.id, domain: 'AI', prompt: 'Explain' }), { code: 'SENSITIVE' });
  assert.throws(() => manager.estimate({ modelId: model.id, noteId: record.id, domain: 'English', prompt: 'Explain' }), /domain/);
});
test('paid calls require preview, preserve actual usage separately, and never repeat request IDs', async t => {
  const { a } = setup(t); let calls = 0;
  const manager = new ModelManager(a, async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
  });
  manager.configure({ id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com', apiKey: 'secret' });
  const model = a.write({ type: 'model', data: { title: 'Cloud', providerId: 'deepseek', modelName: 'm', inputRate: 1, outputRate: 2, currency: 'CNY' } });
  const input = { modelId: model.id, domain: 'AI', prompt: 'Explain', callId: uuid() };
  await assert.rejects(manager.ask(input), { code: 'CONFIRM_COST' });
  const result = await manager.ask({ ...input, estimateShown: true });
  assert.equal(result.answer, 'Answer'); assert.equal(result.billedCost, null);
  assert.equal(a.usage().totals.CNY.inputTokens, 12);
  await assert.rejects(manager.ask({ ...input, estimateShown: true }), { code: 'DUPLICATE_CALL' });
  assert.equal(calls, 1);
});
test('importing tasks does not call models or resume a different device worker', async t => {
  const { a, b, sync } = setup(t);
  const task = a.write({ type: 'task', data: { title: 'Home task', ownerDevice: a.deviceId, modelId: uuid(), status: 'running' } });
  await sync();
  assert.equal(b.get(task.id).data.ownerDevice, a.deviceId);
  assert.notEqual(b.get(task.id).data.ownerDevice, b.deviceId);
});
test('adopting another workspace appends tabs without replacing current selection', async t => {
  const { directory } = setup(t);
  const service = new Service(path.join(directory, 'service'));
  const currentId = uuid(), otherId = uuid();
  await service.call('workspaceSave', { tabs: [{ id: currentId }], selectedTab: currentId });
  const published = service.store.write({ type: 'workspace', data: { title: 'Other', tabs: [{ id: otherId }], selectedTab: otherId, originDevice: uuid() } });
  const result = await service.call('workspaceAdopt', { id: published.id });
  assert.equal(result.selectedTab, currentId); assert.equal(result.tabs.length, 2);
  service.close();
});

test('explicit stale branch save retains the newer edit instead of overwriting it', t => {
  const { a } = setup(t);
  const base = note(a); edit(a, base, 'arrived remotely');
  const branch = a.write({ id: base.id, type: 'note', data: { ...base.data, content: 'unsaved local edit' }, parents: base.heads, allowBranch: true });
  assert.equal(branch.conflict, true);
  assert.deepEqual(new Set(branch.versions.map(e => e.data.content)), new Set(['arrived remotely', 'unsaved local edit']));
});
test('custom provider metadata synchronizes without local endpoint or secret', async t => {
  const { a, b, sync } = setup(t);
  const manager = new ModelManager(a);
  manager.configure({ id: 'private_gateway', name: 'My gateway', protocol: 'openai', endpoint: 'https://gateway.example.test/v1', apiKey: 'do-not-share' });
  const model = a.write({ type: 'model', data: { title: 'Private model', providerId: 'private_gateway', modelName: 'model' } });
  await sync();
  const remote = new ModelManager(b);
  const provider = remote.providers().find(p => p.id === 'private_gateway');
  assert.equal(provider.name, 'My gateway');
  assert.equal(provider.endpoint, '');
  assert.equal(provider.hasKey, false);
  assert.equal(remote.availability(model.id).available, false);
  assert.ok(!JSON.stringify(b.allEvents()).includes('gateway.example.test'));
});
test('backup restore is local, not a fabricated remote receipt', async t => {
  const { directory, a, b, tb } = setup(t);
  const record = note(a);
  const backup = await new BackupManager(a).create(path.join(directory, 'backups'));
  await new BackupManager(b).restore(backup.directory);
  assert.equal(b.get(record.id).status, 'local');
  await tb.cycle();
  assert.equal(b.get(record.id).status, 'waiting');
});
test('pending children are never acknowledged before their parents arrive', async t => {
  const { a, b, ta, tb, deliver } = setup(t);
  const base = note(a), child = edit(a, base, 'child');
  ta.writePacket('events', { events: [a.event(child.heads[0])] });
  deliver(ta, tb); await tb.cycle();
  assert.equal(b.summary().pendingParents, 1);
  assert.equal(fs.readdirSync(tb.root()).filter(name => name.startsWith('receipt-')).length, 0);
});
test('a formerly pending malformed child does not block unrelated valid revisions', t => {
  const { a, b } = setup(t);
  const parent = note(a), parentEvent = a.event(parent.heads[0]);
  const other = note(a, 'other entity'), malformed = structuredClone(a.event(other.heads[0]));
  malformed.id = uuid(); malformed.parents = [parentEvent.id];
  const { hash, ...content } = malformed; malformed.hash = sha(canonical(content));
  b.importEvents([malformed]);
  const result = b.importEvents([parentEvent]);
  assert.equal(result.rejected.length, 1);
  assert.equal(b.get(parent.id).data.content, 'original');
  assert.equal(b.summary().pendingParents, 0);
});
test('failed model requests are never automatically retried and unknown costs stay unknown', async t => {
  const { a } = setup(t); let calls = 0;
  const manager = new ModelManager(a, async () => { calls++; throw new Error('Connection interrupted'); });
  manager.configure({ id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com', apiKey: 'secret' });
  const model = a.write({ type: 'model', data: { title: 'Cloud', providerId: 'deepseek', modelName: 'm' } });
  const input = { modelId: model.id, domain: 'AI', prompt: 'hello', callId: uuid(), estimateShown: true };
  await assert.rejects(manager.ask(input), { code: 'CONFIRM_COST' });
  await assert.rejects(manager.ask({ ...input, confirmed: true }), /interrupted/);
  await assert.rejects(manager.ask({ ...input, confirmed: true }), { code: 'DUPLICATE_CALL' });
  assert.equal(calls, 1);
  assert.equal(a.list({ type: 'task' })[0].data.status, 'failed_cost_unknown');
});
test('restart labels only this device interrupted tasks and does not execute them', t => {
  const { directory } = setup(t);
  const profile = path.join(directory, 'restart');
  const first = new Service(profile);
  const own = first.store.write({ type: 'task', data: { title: 'local', ownerDevice: first.store.deviceId, status: 'running' } });
  const foreign = first.store.write({ type: 'task', data: { title: 'other', ownerDevice: uuid(), status: 'running' } });
  first.close();
  const restarted = new Service(profile, { fetcher: () => { throw new Error('Unexpected network'); } });
  assert.equal(restarted.store.get(own.id).data.status, 'interrupted_cost_unknown');
  assert.equal(restarted.store.get(foreign.id).data.status, 'running');
  assert.equal(restarted.state().usage.unsettledTasks, 1);
  restarted.close();
});
test('restoring an older backup never rolls back a newer local head', async t => {
  const { directory, a, b } = setup(t);
  const base = note(a);
  const backup = await new BackupManager(a).create(path.join(directory, 'backups'));
  b.importEvents(a.allEvents());
  edit(b, b.get(base.id), 'newer local work');
  await new BackupManager(b).restore(backup.directory);
  assert.equal(b.get(base.id).data.content, 'newer local work');
  assert.equal(b.get(base.id).conflict, false);
});
test('Ollama cloud entries are not considered private local inference', async t => {
  const { a } = setup(t);
  const manager = new ModelManager(a, async url => new Response(JSON.stringify(url.endsWith('/tags')
    ? { models: [{ name: 'example:cloud', size: 0, remote_host: 'https://example.test', details: {} }] }
    : { models: [] })));
  const model = a.write({ type: 'model', data: { title: 'Cloud through Ollama', providerId: 'ollama', modelName: 'example:cloud' } });
  await manager.test('ollama');
  const privateNote = note(a, 'private', { sensitive: true });
  assert.equal(manager.availability(model.id).local, false);
  assert.throws(() => manager.estimate({ modelId: model.id, domain: 'AI', prompt: 'explain', noteId: privateNote.id }), { code: 'SENSITIVE' });
});
test('content-deduplicated backup restores every stable attachment ID', async t => {
  const { directory, a, b } = setup(t);
  const file = path.join(directory, 'same.txt'); fs.writeFileSync(file, 'identical content');
  const first = await importAttachment(a, file), second = await importAttachment(a, file);
  assert.notEqual(first.id, second.id);
  const result = await new BackupManager(a).create(path.join(directory, 'backups'));
  assert.equal(result.assets.length, 1);
  await new BackupManager(b).restore(result.directory);
  assert.ok(b.assetLocation(first.id)); assert.ok(b.assetLocation(second.id));
});
test('backup cannot silently omit missing attachment declarations', async t => {
  const { directory, a, b } = setup(t);
  const file = path.join(directory, 'source.txt'); fs.writeFileSync(file, 'content');
  await importAttachment(a, file);
  const result = await new BackupManager(a).create(path.join(directory, 'backups'));
  const manifestPath = path.join(result.directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.assets = [];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(new BackupManager(b).restore(result.directory), /omitted/);
  assert.equal(b.allEvents().length, 0);
});
