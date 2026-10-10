import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { GitSync } from '../src/core/git-sync.mjs';
import { GitVersions, SHARED } from '../src/core/git-versions.mjs';
import { importAttachment, makePairingKey } from '../src/core/transport.mjs';
import { CHUNK_BYTES } from '../src/core/sync-objects.mjs';
import { hashFile } from '../src/core/util.mjs';
import { BackupManager } from '../src/core/backup.mjs';

const root = path.resolve('artifacts/git-sync-tests'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), key = makePairingKey(), stores = [];
  const open = name => {
    const store = new Store(path.join(directory, name), { deviceName: name }); stores.push(store);
    const sync = new GitSync(store); sync.configure(path.join(directory, `cloud-${name}`), key);
    return { store, sync };
  };
  const a = open('A'), b = open('B');
  t.after(() => stores.forEach(store => { try { store.close(); } catch {} }));
  const deliver = (from, to, filter = () => true) => {
    const source = from.sync.channel(), target = to.sync.channel(); fs.mkdirSync(target.root, { recursive: true });
    for (const name of fs.readdirSync(source.root).filter(filter)) fs.copyFileSync(source.file(name), target.file(name));
  };
  const library = a.store.saveLibrary({ title: '自建知识库', description: '' });
  const scope = library.data.domain;
  const note = (owner, content = '第一版') => owner.store.write({ type: 'note', data: { title: '测试笔记', domain: scope, content } });
  const commit = owner => owner.sync.commit({ scope });
  const publish = owner => owner.sync.publish({ scope });
  return { directory, a, b, open, deliver, scope, note, commit, publish };
}

test('real Git commits publish only committed state; scan never imports', async t => {
  const f = fixture(t), record = f.note(f.a);
  const first = await f.commit(f.a);
  assert.match(first.commit, /^[0-9a-f]{40}$/);
  assert.equal((await f.commit(f.a)).unchanged, true);
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: '未提交修改' } });
  const release = await f.publish(f.a); f.deliver(f.a, f.b);
  assert.equal(f.b.sync.scan().entries.length, 1); assert.equal(f.b.store.get(record.id), null);
  await f.b.sync.importRelease({ id: release.id });
  assert.equal(f.b.store.get(record.id).data.content, '第一版');
  const count = f.b.store.allEvents().length;
  assert.equal((await f.b.sync.importRelease({ id: release.id })).unchanged, true);
  assert.equal(f.b.store.allEvents().length, count);
  assert.equal(f.a.sync.config().enabled, false);
  assert.equal(fs.readdirSync(f.a.sync.channel().root).some(name => name.includes('sqlite')), false);
  const blob = fs.readFileSync(f.a.sync.channel().file(release.bundle.name));
  assert.equal(blob.includes(Buffer.from('第一版')), false);
});

test('incremental bundle needs its base; a new device can replay retained releases', async t => {
  const f = fixture(t), record = f.note(f.a); await f.commit(f.a); const first = await f.publish(f.a);
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: '第二版' } });
  await f.commit(f.a); const second = await f.publish(f.a); f.deliver(f.a, f.b);
  await assert.rejects(f.b.sync.importRelease({ id: second.id }), /prerequisite|缺少|error/i);
  assert.equal(f.b.store.get(record.id), null);
  await f.b.sync.importRelease({ id: first.id }); await f.b.sync.importRelease({ id: second.id });
  assert.equal(f.b.store.get(record.id).data.content, '第二版');
  const c = f.open('C'); f.deliver(f.a, c);
  await c.sync.importRelease({ id: first.id }); await c.sync.importRelease({ id: second.id });
  assert.equal(c.store.get(record.id).data.content, '第二版');
});

test('uncommitted changes block pull; committed concurrency retains both note heads', async t => {
  const f = fixture(t), record = f.note(f.a); await f.commit(f.a); const first = await f.publish(f.a);
  f.deliver(f.a, f.b); await f.b.sync.importRelease({ id: first.id });
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: 'A 的修改' } });
  f.b.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: 'B 的修改' } });
  await f.commit(f.a); const second = await f.publish(f.a); f.deliver(f.a, f.b);
  await assert.rejects(f.b.sync.importRelease({ id: second.id }), /先保存本地版本/);
  const own = await f.commit(f.b); await f.b.sync.importRelease({ id: second.id });
  assert.equal(f.b.store.get(record.id).conflict, true);
  const parents = f.b.sync.versions.git(f.scope, ['show', '-s', '--format=%P', f.b.sync.versions.pointer(f.scope).commit]);
  assert.ok(parents.includes(own.commit)); assert.ok(parents.includes(second.commit));
});

test('binary files require complete authenticated chunks and can be rehydrated', async t => {
  const f = fixture(t), file = path.join(f.directory, 'original.bin');
  fs.writeFileSync(file, Buffer.alloc(CHUNK_BYTES + 500, 7));
  const asset = await importAttachment(f.a.store, file, { domain: f.scope });
  await f.commit(f.a); const release = await f.publish(f.a);
  const chunk = release.assets[0].chunks[1].name;
  f.deliver(f.a, f.b, name => name !== chunk);
  assert.equal(f.b.sync.scan().entries[0].missing.length, 1);
  await assert.rejects(f.b.sync.importRelease({ id: release.id })); assert.equal(f.b.store.get(asset.id), null);
  f.deliver(f.a, f.b);
  const packet = f.b.sync.channel().file(chunk), bytes = fs.readFileSync(packet); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(packet, bytes);
  await assert.rejects(f.b.sync.importRelease({ id: release.id })); assert.equal(f.b.store.get(asset.id), null);
  f.deliver(f.a, f.b); await f.b.sync.importRelease({ id: release.id });
  const local = f.b.store.assetLocation(asset.id).path; assert.equal(await hashFile(local), asset.data.sha256);
  fs.unlinkSync(local); await f.b.sync.hydrate({ id: asset.id }); assert.equal(await hashFile(local), asset.data.sha256);
});

test('Git journal recovers a crash after ref update without losing SQLite data', async t => {
  const f = fixture(t); f.note(f.a);
  const original = f.a.store.transaction.bind(f.a.store);
  f.a.store.transaction = () => { throw new Error('simulated crash'); };
  await assert.rejects(f.commit(f.a), /simulated crash/);
  const journal = f.a.store.local('v2Journal'); assert.ok(journal.commit);
  f.a.store.transaction = original;
  const recovered = new GitVersions(f.a.store);
  assert.equal(recovered.error, null); assert.equal(recovered.pointer(f.scope).commit, journal.commit);
  assert.equal(f.a.store.local('v2Journal'), null);
});

test('restore creates a new commit and preserves later history', async t => {
  const f = fixture(t), record = f.note(f.a), first = await f.commit(f.a);
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: '第二版' } });
  const second = await f.commit(f.a);
  const restored = await f.a.sync.restore({ scope: f.scope, commit: first.commit, confirmed: true });
  assert.notEqual(restored.commit, first.commit); assert.notEqual(restored.commit, second.commit);
  assert.equal(f.a.store.get(record.id).data.content, '第一版'); assert.equal(f.a.store.history(record.id).length, 3);
});

async function primaryPair(f) {
  await f.a.sync.setPrimary({ deviceId: f.a.store.deviceId, parents: [], confirmed: true });
  await f.a.sync.commit({ scope: SHARED }); await f.b.sync.commit({ scope: SHARED });
  const release = await f.a.sync.publish({ scope: SHARED }); f.deliver(f.a, f.b);
  await f.b.sync.importRelease({ id: release.id });
}
test('secondary eviction needs no client questionnaire but preserves confirmation, clean state and receipt guards', async t => {
  const f = fixture(t); await primaryPair(f);
  const file = path.join(f.directory, 'test.txt'); fs.writeFileSync(file, 'source');
  const asset = await importAttachment(f.a.store, file, { domain: f.scope });
  await f.commit(f.a); const release = await f.publish(f.a); f.deliver(f.a, f.b);
  await f.b.sync.importRelease({ id: release.id });
  assert.equal(f.b.store.local('v2ClientValidation'), null);
  await assert.rejects(f.b.sync.evict({ id: asset.id }), /明确确认/);
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /校验回执/);
  await f.a.sync.verifyPrimary(); f.deliver(f.a, f.b); f.b.sync.scan();
  const local = f.b.store.assetLocation(asset.id);
  f.b.store.local('workspace', { tabs: [{ dirty: true }] });
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /未保存/);
  f.b.store.local('workspace', { tabs: [] });
  f.note(f.b, '尚未提交');
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /先保存本地版本|先提交/);
  await f.commit(f.b);
  f.b.store.bindAsset(asset.id, local.path, true);
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /保留/);
  f.b.store.bindAsset(asset.id, local.path, false);
  f.b.store.activeAssetReads = new Map([[asset.id, 1]]);
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /正在使用/);
  f.b.store.activeAssetReads.clear();
  f.b.store.local('localFileLinks', { test: local.path });
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /本机文件链接/);
  f.b.store.local('localFileLinks', {});
  assert.equal((await f.b.sync.evict({ id: asset.id, confirmed: true })).released, true);
  assert.equal(fs.existsSync(local.path), false);
  assert.equal(fs.existsSync(f.b.sync.channel().file(release.assets[0].chunks[0].name)), true);
  await f.b.sync.hydrate({ id: asset.id }); assert.equal(fs.existsSync(local.path), true);
  await assert.rejects(f.a.sync.evict({ id: asset.id, confirmed: true }), /主力机/);
  assert.equal(f.b.store.local('v2ClientValidation'), null);
});

test('legacy client questionnaire data is retained without granting release authority', async t => {
  const f = fixture(t); await primaryPair(f);
  const legacy = { channel: 'retired-channel', cloudRetained: true, source: 'user-confirmed', at: '2026-10-09T00:00:00.000Z' };
  f.b.store.local('v2ClientValidation', legacy);
  const file = path.join(f.directory, 'legacy.txt'); fs.writeFileSync(file, 'original');
  const asset = await importAttachment(f.a.store, file, { domain: f.scope });
  await f.commit(f.a); const release = await f.publish(f.a); f.deliver(f.a, f.b);
  await f.b.sync.importRelease({ id: release.id });
  await assert.rejects(f.b.sync.evict({ id: asset.id, confirmed: true }), /校验回执/);
  await f.a.sync.verifyPrimary(); f.deliver(f.a, f.b); f.b.sync.scan();
  assert.equal((await f.b.sync.evict({ id: asset.id, confirmed: true })).released, true);
  assert.deepEqual(f.b.store.local('v2ClientValidation'), legacy);
  assert.equal('clientValidation' in f.b.sync.config(), false);
  assert.equal('verificationRequired' in f.b.sync.devices(), false);
  assert.equal('validation' in f.b.sync.devices(), false);
});

test('concurrent primary choices are retained as a conflict', async t => {
  const f = fixture(t);
  for (const owner of [f.a, f.b]) {
    await owner.sync.setPrimary({ deviceId: owner.store.deviceId, parents: [], confirmed: true });
    await owner.sync.commit({ scope: SHARED });
  }
  const release = await f.a.sync.publish({ scope: SHARED }); f.deliver(f.a, f.b);
  await f.b.sync.importRelease({ id: release.id });
  assert.equal(f.b.sync.devices().conflict, true); assert.equal(f.b.sync.devices().primary, null);
});

test('wrong key and changed manifest cannot import; cloud confirmations are explicitly unverified', async t => {
  const f = fixture(t); f.note(f.a); await f.commit(f.a); const release = await f.publish(f.a); f.deliver(f.a, f.b);
  const confirmed = f.a.sync.confirmUpload({ id: release.id, confirmed: true });
  assert.equal(confirmed.cloudUploadVerified, false);
  const source = f.b.sync.channel(); source.key = Buffer.alloc(32, 9);
  assert.throws(() => source.json(`release-${release.id}.ssmanifest`, `v2:release:${release.id}`));
  await f.b.sync.importRelease({ id: release.id });
  const file = f.b.sync.channel().file(`release-${release.id}.ssmanifest`), contents = fs.readFileSync(file);
  contents[50] ^= 1; fs.writeFileSync(file, contents);
  assert.equal(f.b.sync.scan().errors.length, 1);
});

test('interrupted import recovers its receipt and bindings without a duplicate merge', async t => {
  const f = fixture(t), record = f.note(f.a); await f.commit(f.a);
  const release = await f.publish(f.a); f.deliver(f.a, f.b);
  const transaction = f.b.store.transaction.bind(f.b.store);
  f.b.store.transaction = () => { throw new Error('simulated disk failure'); };
  await assert.rejects(f.b.sync.importRelease({ id: release.id }), /simulated disk/);
  f.b.store.transaction = transaction;
  assert.throws(() => f.note(f.b), /恢复/);
  const commit = f.b.store.local('v2Journal').commit;
  f.b.store.transaction = transaction;
  assert.equal((await f.b.sync.importRelease({ id: release.id })).unchanged, true);
  assert.equal(f.b.sync.versions.pointer(f.scope).commit, commit);
  assert.equal(f.b.store.get(record.id).data.content, '第一版');
});

test('interrupted publication reuses immutable bundle and never exports later edits', async t => {
  const f = fixture(t); f.note(f.a); await f.commit(f.a);
  const channel = f.a.sync.channel(), writeJson = channel.writeJson.bind(channel);
  f.a.sync.channel = () => channel;
  channel.writeJson = () => { throw new Error('simulated ENOSPC'); };
  await assert.rejects(f.publish(f.a), /ENOSPC/);
  const bundle = channel.names('.ssobj')[0], before = fs.readFileSync(channel.file(bundle));
  f.note(f.a, '未提交内容'); channel.writeJson = writeJson;
  const release = await f.publish(f.a);
  assert.deepEqual(fs.readFileSync(channel.file(bundle)), before);
  f.deliver(f.a, f.b); await f.b.sync.importRelease({ id: release.id });
  assert.equal(f.b.store.list({ type: 'note' }).length, 1);
});

test('cross-library history includes ancestors but restoration cannot reclaim moved notes', async t => {
  const f = fixture(t), record = f.note(f.a), first = await f.commit(f.a);
  const other = f.a.store.saveLibrary({ title: '另一知识库' }).data.domain;
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, domain: other } });
  await f.a.sync.commit({ scope: other });
  const release = await f.a.sync.publish({ scope: other }); f.deliver(f.a, f.b);
  await f.b.sync.importRelease({ id: release.id });
  assert.equal(f.b.store.get(record.id).data.domain, other);
  assert.equal(f.b.store.history(record.id).length, 2);
  assert.equal(f.a.sync.versions.scopes().find(item => item.scope === f.scope).dirty, true);
  await f.commit(f.a);
  const departure = await f.publish(f.a), c = f.open('C'); f.deliver(f.a, c);
  await c.sync.importRelease({ id: departure.id });
  assert.equal(c.store.list({ type: 'note', domain: f.scope }).length, 0);
  assert.equal(c.store.get(record.id).data.domain, other);
  await assert.rejects(f.a.sync.restore({ scope: f.scope, commit: first.commit, confirmed: true }), /跨库/);
  assert.equal(f.a.store.get(record.id).data.domain, other);
});

test('independent backup retains Git histories and refuses a damaged bundle before merge', async t => {
  const f = fixture(t), record = f.note(f.a), first = await f.commit(f.a);
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: '修改' } });
  const second = await f.commit(f.a);
  const backup = await new BackupManager(f.a.store).create(path.join(f.directory, 'backups'), true);
  await assert.rejects(new BackupManager(f.a.store).create(f.a.sync.config().folder, true), /明文/);
  assert.equal(backup.gitVersions.length, 1);
  const restored = await new BackupManager(f.b.store).restore(backup.directory);
  assert.equal(restored.gitHistories, 1);
  assert.equal(f.b.sync.versions.pointer(f.scope), null);
  assert.ok(f.b.sync.versions.history(f.scope).some(item => item.commit === first.commit));
  const newCommit = await f.commit(f.b);
  assert.ok(f.b.sync.versions.git(f.scope, ['show', '-s', '--format=%P', newCommit.commit]).includes(second.commit));
  const bundle = path.join(backup.directory, backup.gitVersions[0].path);
  fs.appendFileSync(bundle, 'corrupt');
  const c = f.open('C'), before = c.store.allEvents().length;
  await assert.rejects(new BackupManager(c.store).restore(backup.directory), /Git backup checksum/);
  assert.equal(c.store.allEvents().length, before);
});

test('index-only import is explicit, preserves unavailable files and hydrates later', async t => {
  const f = fixture(t); await primaryPair(f);
  const file = path.join(f.directory, 'index-only.txt'); fs.writeFileSync(file, 'index-only original');
  const asset = await importAttachment(f.a.store, file, { domain: f.scope });
  await f.commit(f.a); const release = await f.publish(f.a);
  f.deliver(f.a, f.b, name => !name.startsWith('asset-'));
  await assert.rejects(f.b.sync.importRelease({ id: release.id }));
  await f.b.sync.importRelease({ id: release.id, metadataOnly: true });
  assert.equal(f.b.store.assetLocation(asset.id), undefined);
  assert.equal((await f.b.sync.currentFiles()).missing.length, 1);
  await assert.rejects(f.b.sync.setPrimary({ deviceId: f.b.store.deviceId, parents: f.b.sync.devices().heads.map(item => item.id), confirmed: true, recovery: true }), /未齐全/);
  f.deliver(f.a, f.b); await f.b.sync.hydrate({ id: asset.id });
  assert.equal((await f.b.sync.currentFiles()).missing.length, 0);
});

test('unsaved tabs block version commit and scope restore recovers after Git failure', async t => {
  const f = fixture(t), record = f.note(f.a);
  f.a.store.local('workspace', { tabs: [{ dirty: true }] });
  await assert.rejects(f.commit(f.a), /未保存/);
  f.a.store.local('workspace', { tabs: [] });
  const first = await f.commit(f.a);
  f.a.store.write({ id: record.id, type: 'note', parents: record.heads, data: { ...record.data, content: 'second' } });
  await f.commit(f.a);
  const git = f.a.sync.versions.git.bind(f.a.sync.versions);
  f.a.sync.versions.git = (scope, args, ...rest) => { if (args[0] === 'hash-object') throw new Error('simulated ENOSPC'); return git(scope, args, ...rest); };
  await assert.rejects(f.a.sync.restore({ scope: f.scope, commit: first.commit, confirmed: true }), /ENOSPC/);
  assert.ok(f.a.store.local('v2Journal'));
  assert.equal(f.a.store.get(record.id).data.content, '第一版');
  f.a.sync.versions.git = git;
  const recovered = new GitVersions(f.a.store);
  assert.equal(recovered.error, null);
  assert.equal(f.a.store.local('v2Journal'), null);
  assert.notEqual(recovered.pointer(f.scope).commit, first.commit);
});
