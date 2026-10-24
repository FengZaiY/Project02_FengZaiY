import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { CHUNK_BYTES, sealBinary } from '../src/core/sync-objects.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { canonical, hashFile, uuid } from '../src/core/util.mjs';
import { presentationFixture } from '../scripts/fixtures/presentation.mjs';

const root = path.resolve('artifacts/current-sync-tests'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), key = makePairingKey(), stores = [];
  const open = (name, options) => {
    const store = new Store(path.join(directory, name), { deviceName: name }); stores.push(store);
    const sync = new CurrentSync(store, { reserveBytes: 0, ...options }); sync.configure(path.join(directory, `cloud-${name}`), key);
    return { store, sync };
  };
  const a = open('A'), b = open('B'), library = a.store.saveLibrary({ title: '自建知识库' }), domain = library.data.domain;
  t.after(() => stores.forEach(store => { try { store.close(); } catch {} }));
  const note = (owner, content = '第一版') => owner.store.write({ type: 'note', data: { title: '测试笔记', domain, content } });
  const deliver = (from, to, filter = () => true) => {
    const source = from.sync.channel(), target = to.sync.channel(); fs.mkdirSync(target.root, { recursive: true });
    for (const name of fs.readdirSync(source.root).filter(filter)) fs.copyFileSync(source.file(name), target.file(name));
  };
  const publish = async owner => {
    await owner.sync.plan();
    for (let i = 0; i < 20; i++) {
      const status = await owner.sync.publish();
      if (status.job.state === 'complete') return owner.sync.value('latest');
      assert.equal(status.job.state, 'paused');
    }
    throw new Error('Unexpected batch loop');
  };
  const file = async (owner, size = 100, name = 'original.bin') => {
    const filename = path.join(directory, `${owner.store.deviceId}-${name}`);
    fs.writeFileSync(filename, Buffer.alloc(size, 7));
    return importAttachment(owner.store, filename, { domain });
  };
  return { directory, a, b, key, domain, open, note, deliver, publish, file };
}

test('new computer needs only latest self-contained content; note history and recovery require no Git', async t => {
  const f = fixture(t), first = f.note(f.a), asset = await f.file(f.a);
  await f.publish(f.a);
  const updated = f.a.store.write({ id: first.id, type: 'note', parents: first.heads, data: { ...first.data, content: '第二版' } });
  const latest = await f.publish(f.a);
  const names = new Set([`current-${f.a.store.deviceId}.sscurrent`, ...latest.parts.map(item => item.name),
    ...latest.assets.flatMap(asset => asset.chunks.map(chunk => chunk.name))]);
  f.deliver(f.a, f.b, name => names.has(name));
  assert.equal((await f.b.sync.importLatest()).imported, f.a.store.allEvents().length);
  assert.equal(f.b.store.get(first.id).data.content, '第二版');
  assert.equal(f.b.store.history(first.id).length, 2);
  assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
  const restored = f.b.store.restoreVersion(first.id, first.heads[0], updated.heads);
  assert.equal(restored.data.content, '第一版'); assert.equal(f.b.store.history(first.id).length, 3);
  assert.equal(fs.existsSync(path.join(f.a.store.directory, 'version-repositories')), false);
  assert.equal(fs.existsSync(path.join(f.b.store.directory, 'version-repositories')), false);
  assert.equal(fs.readdirSync(f.a.sync.channel().root).some(name => /bundle|sqlite|backup/.test(name)), false);
  assert.equal((await f.a.sync.publish()).unchanged, true);
  assert.equal(f.a.sync.value('latest').id, latest.id);
  const confirmed = f.a.sync.confirmUpload({ id: latest.id, confirmed: true });
  assert.equal(confirmed.job.reason, '用户已确认本次上传');
  assert.equal(confirmed.config.cloudUploadVerified, false);
});

test('pointer contention preserves the previous publication, frozen edits and retry progress across restart', async t => {
  const f = fixture(t), note = f.note(f.a); await f.publish(f.a);
  const latest = f.a.sync.value('latest'), pointer = f.a.sync.channel().file(`current-${f.a.store.deviceId}.sscurrent`);
  const before = fs.readFileSync(pointer);
  const saved = f.a.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: 'frozen publication' } });
  const rename = fs.renameSync; t.after(() => { fs.renameSync = rename; });
  fs.renameSync = (from, to) => { if (to === pointer) throw Object.assign(new Error('test contention'), { code: 'EPERM' }); return rename(from, to); };
  const pending = f.a.sync.publish();
  while (f.a.sync.progress()?.phase !== 'manifest') await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.a.sync.status().job.reason, /等待重试/);
  assert.equal(f.a.sync.status().busy, true);
  await assert.rejects(f.a.sync.publish(), { code: 'BUSY' });
  f.a.store.write({ id: note.id, type: 'note', parents: saved.heads, data: { ...saved.data, content: 'edited during retry' } });
  f.a.sync.pause(); assert.equal((await pending).job.state, 'paused');
  assert.deepEqual(fs.readFileSync(pointer), before); assert.equal(f.a.sync.value('latest').id, latest.id);
  assert.ok(f.a.store.unexported().some(event => event.id === saved.heads[0]));
  f.a.store.close();
  const reopened = new Store(path.join(f.directory, 'A')); t.after(() => reopened.close());
  const resumed = new CurrentSync(reopened, { reserveBytes: 0 });
  await assert.rejects(resumed.publish(), { code: 'SYNC_FILE_BUSY' });
  assert.equal(resumed.status().job.state, 'blocked'); assert.match(resumed.status().job.reason, /继续发布/);
  assert.deepEqual(fs.readFileSync(pointer), before); assert.equal(resumed.value('latest').id, latest.id);
  fs.renameSync = rename;
  assert.equal((await resumed.publish()).job.state, 'complete');
  f.deliver({ sync: resumed }, f.b); await f.b.sync.importLatest();
  assert.equal(f.b.store.get(note.id).data.content, 'frozen publication');
  assert.equal(reopened.get(note.id).data.content, 'edited during retry');
  assert.equal(resumed.status().pendingChanges, 1); assert.equal(resumed.status().config.cloudUploadVerified, false);
  assert.equal((await f.b.sync.importLatest()).imported, 0);
});

test('saved local edits merge with downloaded edits; unsaved tabs block; repeated pull is idempotent', async t => {
  const f = fixture(t), note = f.note(f.a);
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  f.a.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: 'A' } });
  f.b.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: 'B' } });
  await f.publish(f.a); f.deliver(f.a, f.b);
  f.b.store.local('workspace', { tabs: [{ dirty: true }] });
  await assert.rejects(f.b.sync.importLatest(), /未保存/);
  f.b.store.local('workspace', { tabs: [] }); await f.b.sync.importLatest();
  assert.equal(f.b.store.get(note.id).conflict, true);
  assert.deepEqual(new Set(f.b.store.get(note.id).versions.map(event => event.data.content)), new Set(['A', 'B']));
  const count = f.b.store.allEvents().length;
  assert.equal((await f.b.sync.importLatest()).imported, 0); assert.equal(f.b.store.allEvents().length, count);
});

test('current sync preserves row layout, bounded dimensions and nested original-file references', async t => {
  const f = fixture(t), asset = await f.file(f.a, 100, 'layout.png');
  const payload = JSON.stringify({ v: 1, kind: 'image', label: '图片', assetId: asset.id }).replaceAll('"', '&quot;');
  const content = `<div data-ss-row="true"><figure data-ss-block="${payload}" data-ss-layout="{&quot;width&quot;:45,&quot;height&quot;:180,&quot;align&quot;:&quot;left&quot;}"><figcaption>图片</figcaption></figure><section data-ss-container="true"><p><a href="studyself://asset/${asset.id}">原文件</a></p></section></div>`;
  const note = f.a.store.write({ type: 'note', data: { title: '排版笔记', domain: f.domain, content, format: 'html' } });
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  assert.equal(f.b.store.get(note.id).data.content, content);
  assert.deepEqual(f.b.store.get(note.id).data.assetIds, [asset.id]);
  assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
  const history = f.b.store.history(note.id).length;
  await f.b.sync.importLatest();
  assert.equal(f.b.store.history(note.id).length, history);
});

test('interactive pages and their original resources survive encrypted sync, repeat import and concurrent page changes', async t => {
  const f = fixture(t), asset = await f.file(f.a, 100, 'page.png');
  const source = f.a.store.write({ type: 'draft', data: { title: '设计依据', domain: f.domain, content: '资料' } });
  const data = { title: '交互笔记', domain: f.domain, content: '<p>正文</p>', format: 'html' };
  const presentation = presentationFixture(data, { assetIds: [asset.id], html: `<img data-asset-id="${asset.id}">` });
  presentation.basis.sources = [{ id: source.id, versionId: source.heads[0] }];
  const note = f.a.store.write({ type: 'note', data: { ...data, presentation } });
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  assert.deepEqual(f.b.store.get(note.id).data.presentation, presentation);
  assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal((await f.b.sync.importLatest()).imported, 0);
  f.a.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...data, presentation: null } });
  f.b.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...data, presentation: { ...presentation, css: 'p{color:green}' } } });
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  const conflict = f.b.store.get(note.id);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.versions.filter(version => version.data.presentation === null).length, 1);
  assert.throws(() => f.b.store.write({ id: note.id, type: 'note', parents: conflict.heads, data }), /页面/);
  const resolved = f.b.store.write({ id: note.id, type: 'note', parents: conflict.heads, data: { ...data, presentation: null } });
  assert.equal(resolved.data.presentation, null);
  assert.deepEqual(f.b.store.event(note.heads[0]).data.presentation, presentation);
});

test('space estimate, bounded batches and restart continue a frozen publication', async t => {
  const f = fixture(t); const note = f.note(f.a); await f.file(f.a, CHUNK_BYTES * 2 + 100);
  const plan = await f.a.sync.plan({ batchBytes: CHUNK_BYTES + 36 });
  assert.ok(plan.job.estimatedAdditionalBytes > CHUNK_BYTES * 2);
  assert.ok(plan.job.estimatedBatches >= 3);
  const first = await f.a.sync.publish();
  assert.equal(first.job.state, 'paused');
  assert.equal(fs.existsSync(f.a.sync.channel().file(`current-${f.a.store.deviceId}.sscurrent`)), false);
  f.a.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '预估之后的修改' } });
  const id = first.job.id;
  f.a.sync = new CurrentSync(f.a.store, { reserveBytes: 0 });
  await f.publish(f.a);
  assert.equal(f.a.sync.value('latest').id, id);
  assert.ok(f.a.sync.status().pendingChanges > 0);
  f.deliver(f.a, f.b); await f.b.sync.importLatest();
  assert.equal(f.b.store.get(note.id).data.content, '第一版');
});

test('insufficient disk pauses before exposure and resumes after free space changes', async t => {
  const f = fixture(t); await f.file(f.a, CHUNK_BYTES + 100);
  let free = 100;
  f.a.sync.space = () => ({ freeBytes: free });
  const planned = await f.a.sync.plan();
  assert.equal(planned.job.estimatedBatches, null);
  assert.equal((await f.a.sync.publish()).job.state, 'blocked');
  assert.equal(f.a.sync.channel().names('.sscurrent').length, 0);
  free = 100 * 1024 ** 2;
  assert.equal((await f.a.sync.publish()).job.state, 'complete');
});

test('publication pause is cooperative and regenerates missing unconfirmed objects', async t => {
  const f = fixture(t); await f.file(f.a, CHUNK_BYTES + 100); await f.a.sync.plan();
  const channel = f.a.sync.channel(), write = channel.write.bind(channel);
  f.a.sync.channel = () => channel;
  let removed;
  channel.write = (name, data, aad) => {
    const result = write(name, data, aad);
    if (!removed) { removed = name; f.a.sync.pause(); }
    return result;
  };
  assert.equal((await f.a.sync.publish()).job.state, 'paused');
  fs.unlinkSync(channel.file(removed));
  channel.write = write;
  assert.equal((await f.a.sync.publish()).job.state, 'complete');
  assert.equal(fs.existsSync(channel.file(removed)), true);
  assert.equal(f.a.sync.config().cloudUploadVerified, false);
});

test('missing unconfirmed chunks are repaired on changed and unchanged publication', async t => {
  for (const edited of [false, true]) {
    const f = fixture(t), note = f.note(f.a), asset = await f.file(f.a), latest = await f.publish(f.a);
    const chunk = latest.assets[0].chunks[0], file = f.a.sync.channel().file(chunk.name);
    fs.unlinkSync(file);
    if (edited) f.a.store.write({ id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: 'changed' } });
    const planned = await f.a.sync.plan();
    assert.equal(planned.unchanged, undefined); assert.ok(planned.job.estimatedAdditionalBytes > chunk.size);
    await f.publish(f.a); assert.ok(fs.existsSync(file));
    f.deliver(f.a, f.b); await f.b.sync.importLatest();
    assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
  }
});

test('unconfirmed missing objects with missing originals block rather than publish an incomplete pointer', async t => {
  const f = fixture(t), asset = await f.file(f.a), first = await f.publish(f.a);
  fs.unlinkSync(f.a.sync.channel().file(first.assets[0].chunks[0].name));
  fs.unlinkSync(f.a.store.assetLocation(asset.id).path);
  await assert.rejects(f.a.sync.publish(), /原件/);
  assert.equal(f.a.sync.progress().state, 'blocked'); assert.equal(f.a.sync.value('latest').id, first.id);
});

test('confirmed cloud-only chunks remain reusable across later publications and cancelled batches', async t => {
  const f = fixture(t), note = f.note(f.a); await f.file(f.a);
  const first = await f.publish(f.a), file = f.a.sync.channel().file(first.assets[0].chunks[0].name);
  f.a.sync.confirmUpload({ id: first.id, confirmed: true }); fs.unlinkSync(file);
  for (const content of ['second', 'third']) {
    const current = f.a.store.get(note.id);
    f.a.store.write({ id: note.id, type: 'note', parents: current.heads, data: { ...current.data, content } });
    assert.equal((await f.a.sync.publish()).job.state, 'complete'); assert.equal(fs.existsSync(file), false);
  }
  const g = fixture(t); await g.file(g.a); await g.a.sync.plan(); await g.a.sync.publish();
  const confirmedFile = g.a.sync.channel().file(g.a.sync.value('latest').assets[0].chunks[0].name);
  g.a.sync.confirmBatch({ confirmed: true }); g.a.sync.cancel(); fs.unlinkSync(confirmedFile);
  g.note(g.a, 'after cancelled plan'); await g.publish(g.a);
  assert.equal(fs.existsSync(confirmedFile), false);
});

test('a resumed legacy plan cannot trust reusable flags or our own reimported pointer', async t => {
  const f = fixture(t); await f.file(f.a); const first = await f.publish(f.a);
  await f.a.sync.importLatest();
  fs.unlinkSync(f.a.sync.channel().file(first.assets[0].chunks[0].name));
  const plan = f.a.sync.value('plan'); plan.objects.forEach(object => { object.reusable = true; });
  f.a.sync.value('plan', plan); f.a.sync.saveProgress({ ...f.a.sync.progress(), state: 'paused' });
  f.a.sync = new CurrentSync(f.a.store, { reserveBytes: 0 });
  assert.equal((await f.a.sync.publish()).job.state, 'complete');
  assert.ok(fs.existsSync(f.a.sync.channel().file(first.assets[0].chunks[0].name)));
});

test('assembly resumes across reopen without downloading already verified prefix chunks', async t => {
  const f = fixture(t), asset = await f.file(f.a, CHUNK_BYTES + 100), latest = await f.publish(f.a);
  const second = latest.assets[0].chunks[1].name; f.deliver(f.a, f.b, name => name !== second);
  await assert.rejects(f.b.sync.importLatest());
  assert.equal(f.b.store.get(asset.id), null);
  assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`).bytes, CHUNK_BYTES);
  const channel = f.b.sync.channel();
  fs.unlinkSync(channel.file(latest.assets[0].chunks[0].name));
  f.deliver(f.a, f.b, name => name === second);
  const directory = f.b.store.directory; f.b.store.close();
  const store = new Store(directory); t.after(() => store.close());
  const sync = new CurrentSync(store, { reserveBytes: 0 });
  await sync.importLatest();
  assert.equal(await hashFile(store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(store.local(`v3Receive:${asset.data.sha256}`), null);
});

test('damaged assembled prefix is not trusted; missing and corrupt chunks never expose a record', async t => {
  const f = fixture(t), asset = await f.file(f.a, CHUNK_BYTES + 100), latest = await f.publish(f.a);
  const chunk = latest.assets[0].chunks[1]; f.deliver(f.a, f.b, name => name !== chunk.name);
  await assert.rejects(f.b.sync.importLatest());
  const partial = path.join(f.b.store.directory, 'received-objects', `${asset.data.sha256}.v3.partial`);
  const fd = fs.openSync(partial, 'r+'); fs.writeSync(fd, Buffer.from('bad'), 0, 3, 0); fs.closeSync(fd);
  fs.unlinkSync(f.b.sync.channel().file(latest.assets[0].chunks[0].name));
  f.deliver(f.a, f.b, name => name === chunk.name);
  await assert.rejects(f.b.sync.importLatest()); assert.equal(f.b.store.get(asset.id), null);
  assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`).bytes, 0);
  f.deliver(f.a, f.b); await f.b.sync.importLatest();
  assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
});

test('receive pause and disk exhaustion preserve durable assembly progress', async t => {
  const f = fixture(t), asset = await f.file(f.a, CHUNK_BYTES + 100);
  await f.publish(f.a); f.deliver(f.a, f.b);
  const channel = f.b.sync.channel(), read = channel.read.bind(channel);
  f.b.sync.channel = () => channel;
  channel.read = (name, ...args) => {
    const data = read(name, ...args);
    if (name.startsWith('asset-') && name.endsWith('-0.ssobj')) f.b.sync.pause();
    return data;
  };
  await assert.rejects(f.b.sync.importLatest(), /暂停/);
  assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`).bytes, CHUNK_BYTES);
  assert.equal(f.b.store.get(asset.id), null);
  channel.read = read; f.b.sync.space = () => ({ freeBytes: 0 });
  await assert.rejects(f.b.sync.importLatest(), /空间不足/);
  assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`).bytes, CHUNK_BYTES);
  f.b.sync.space = () => ({ freeBytes: 100 * 1024 ** 2 });
  await f.b.sync.importLatest(); assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`), null);
});

test('failure after file promotion recovers its checkpoint and binds only after retry', async t => {
  const f = fixture(t), asset = await f.file(f.a);
  await f.publish(f.a); f.deliver(f.a, f.b);
  const local = f.b.store.local.bind(f.b.store);
  f.b.store.local = function(key, ...args) {
    if (key === `v3Receive:${asset.data.sha256}` && args.length && args[0] === null) throw new Error('checkpoint interrupted');
    return local(key, ...args);
  };
  await assert.rejects(f.b.sync.importLatest(), /checkpoint interrupted/);
  assert.equal(f.b.store.get(asset.id), null);
  assert.ok(fs.existsSync(path.join(f.b.store.directory, 'received-objects', asset.data.sha256)));
  f.b.store.local = local;
  await f.b.sync.importLatest();
  assert.equal(f.b.store.local(`v3Receive:${asset.data.sha256}`), null);
  assert.ok(f.b.store.assetLocation(asset.id));
});

test('index-only join needs no shared commit; all latest device snapshots merge together', async t => {
  const f = fixture(t);
  await f.a.sync.setPrimary({ deviceId: f.a.store.deviceId, parents: [], confirmed: true });
  const asset = await f.file(f.a), aNote = f.note(f.a), latest = await f.publish(f.a);
  f.deliver(f.a, f.b, name => !name.startsWith('asset-'));
  await f.b.sync.importLatest({ metadataOnly: true });
  assert.equal(f.b.store.assetLocation(asset.id), undefined);
  const bNote = f.note(f.b, 'B 新增');
  await f.publish(f.b);
  const c = f.open('C'); f.deliver(f.a, c); f.deliver(f.b, c);
  await c.sync.importLatest();
  assert.ok(c.store.get(aNote.id)); assert.ok(c.store.get(bNote.id));
  assert.equal(await hashFile(c.store.assetLocation(asset.id).path), asset.data.sha256);
  assert.equal(c.sync.devices().primary, f.a.store.deviceId);
  assert.equal(latest.format, 3);
});

test('wrong key, changed pointer and missing metadata leave database unchanged', async t => {
  const f = fixture(t), note = f.note(f.a), latest = await f.publish(f.a);
  f.deliver(f.a, f.b);
  const originalKey = f.b.store.secret('pairing');
  const channel = f.b.sync.channel(); channel.key = Buffer.alloc(32, 3);
  const originalChannel = f.b.sync.channel.bind(f.b.sync); f.b.sync.channel = () => channel;
  await assert.rejects(f.b.sync.importLatest()); assert.equal(f.b.store.get(note.id), null);
  f.b.sync.channel = originalChannel;
  assert.equal(f.b.store.secret('pairing'), originalKey);
  fs.unlinkSync(f.b.sync.channel().file(latest.parts[0].name));
  await assert.rejects(f.b.sync.importLatest()); assert.equal(f.b.store.get(note.id), null);
  f.deliver(f.a, f.b); await f.b.sync.importLatest();
  const changed = { ...latest, deviceName: '篡改同一发布' };
  fs.writeFileSync(f.b.sync.channel().file(`current-${latest.deviceId}.sscurrent`),
    sealBinary(Buffer.from(canonical(changed)), f.b.sync.channel().key, `v3:current:${latest.deviceId}`));
  await assert.rejects(f.b.sync.importLatest(), /发生变化/);
});

test('failed database import is atomic and retries without duplicate history', async t => {
  const f = fixture(t), note = f.note(f.a); await f.publish(f.a); f.deliver(f.a, f.b);
  const insert = f.b.store.insert.bind(f.b.store);
  let calls = 0; f.b.store.insert = (...args) => { if (++calls === 2) throw new Error('simulated database failure'); return insert(...args); };
  await assert.rejects(f.b.sync.importLatest(), /database failure/);
  assert.equal(f.b.store.allEvents().length, 0); assert.equal(f.b.sync.value('seen'), null);
  f.b.store.insert = insert;
  await f.b.sync.importLatest(); assert.equal(f.b.store.get(note.id).data.content, '第一版');
  const count = f.b.store.allEvents().length; await f.b.sync.importLatest(); assert.equal(f.b.store.allEvents().length, count);
});

test('legacy unfinished knowledge import is recovered without running Git or deleting old data', t => {
  const f = fixture(t), note = f.note(f.a), events = f.a.store.allEvents();
  f.b.store.local('v2Journal', { apply: true, snapshot: { events }, context: {} });
  f.b.store.local('backups', [{ directory: 'retained-old-backup' }]);
  const marker = path.join(f.b.store.directory, 'version-repositories'); fs.mkdirSync(marker);
  fs.writeFileSync(path.join(marker, 'old-marker'), 'retained');
  new CurrentSync(f.b.store);
  assert.equal(f.b.store.get(note.id).data.content, '第一版');
  assert.equal(f.b.store.local('v2Journal'), null);
  assert.ok(f.b.store.local('retiredV2Journal'));
  assert.equal(f.b.store.local('backups')[0].directory, 'retained-old-backup');
  assert.equal(fs.readFileSync(path.join(marker, 'old-marker'), 'utf8'), 'retained');
});

test('Service retires Git and independent backup RPC while retaining individual history restore', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), service = new Service(directory);
  t.after(() => service.close());
  for (const method of ['versionCommit', 'versionHistory', 'versionRestore', 'versionStatus', 'backupCreate',
    'backupContinue', 'backupVerify', 'backupRestore', 'backupIdleEnable']) await assert.rejects(service.call(method), /Unsupported/);
  const first = await service.call('save', { type: 'note', data: { title: '修改记录', content: 'A' } });
  const next = await service.call('save', { id: first.id, type: 'note', parents: first.heads, data: { ...first.data, content: 'B' } });
  await service.call('restoreVersion', { id: first.id, revision: first.heads[0], parents: next.heads });
  assert.equal((await service.call('history', { id: first.id })).length, 3);
  assert.equal((await service.call('record', { id: first.id })).data.content, 'A');
  assert.equal('backups' in service.state(), false);
  assert.equal(fs.existsSync(path.join(directory, 'version-repositories')), false);
});

test('secondary eviction still requires current primary receipt, no unsent edits and no pin', async t => {
  const f = fixture(t);
  await f.a.sync.setPrimary({ deviceId: f.a.store.deviceId, parents: [], confirmed: true });
  const asset = await f.file(f.a); await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /校验回执/);
  await f.a.sync.verifyPrimary(); f.deliver(f.a, f.b); f.b.sync.scan();
  const local = f.b.store.assetLocation(asset.id);
  f.b.store.bindAsset(asset.id, local.path, true);
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /保留/);
  f.b.store.bindAsset(asset.id, local.path, false);
  f.note(f.b); await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /尚未发布/);
  await f.publish(f.b);
  assert.equal((await f.b.sync.evict({ id: asset.id, confirmed: true })).released, true);
  await f.b.sync.hydrate({ id: asset.id }); assert.equal(fs.existsSync(local.path), true);
  await assert.rejects(f.a.sync.evict({ id: asset.id, confirmed: true }), /主力机/);
});

test('concurrent primary changes preserve conflict and block release', async t => {
  const f = fixture(t);
  for (const owner of [f.a, f.b]) { await owner.sync.setPrimary({ deviceId: owner.store.deviceId, parents: [], confirmed: true }); await f.publish(owner); }
  f.deliver(f.a, f.b); await f.b.sync.importLatest();
  assert.equal(f.b.sync.devices().conflict, true);
  await assert.rejects(f.b.sync.evict({ id: uuid(), confirmed: true }), /唯一主力机/);
});

test('automatically organized originals still require receipts and can be released and restored', async t => {
  const f = fixture(t);
  await f.a.sync.setPrimary({ deviceId: f.a.store.deviceId, parents: [], confirmed: true });
  const asset = await f.file(f.a);
  await f.publish(f.a); f.deliver(f.a, f.b); await f.b.sync.importLatest();
  const hierarchy = new LocalHierarchy(f.b.store);
  assert.deepEqual((await hierarchy.refresh()).errors, []);
  const organized = f.b.store.assetLocation(asset.id).path;
  assert.match(organized, /资料/);
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /校验回执/);
  await f.a.sync.verifyPrimary(); f.deliver(f.a, f.b); f.b.sync.scan();
  assert.equal((await f.b.sync.evict({ id: asset.id, confirmed: true })).released, true);
  assert.equal(fs.existsSync(organized), false);
  assert.equal(f.b.store.local('hierarchyDirty'), true);
  assert.equal((await hierarchy.refresh()).missing, 1);
  await f.b.sync.hydrate({ id: asset.id });
  assert.deepEqual((await hierarchy.refresh()).errors, []);
  assert.equal(await hashFile(f.b.store.assetLocation(asset.id).path), asset.data.sha256);
});
