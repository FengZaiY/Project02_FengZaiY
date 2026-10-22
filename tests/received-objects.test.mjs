import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { pruneReceivedDirectory, receivedObjectsStatus } from '../src/core/received-objects.mjs';
import { runDeletionFiles } from '../src/core/permanent-files.mjs';
import { receiveResumable } from '../src/core/resumable-files.mjs';
import { DirectoryChannel, assetAAD, chunkName } from '../src/core/sync-objects.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { sha, uuid } from '../src/core/util.mjs';

const root = path.resolve('artifacts/received-objects-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(base, 'workspace'));
  t.after(() => { if (store.db.isOpen) store.close(); });
  const directory = path.join(store.directory, 'received-objects');
  fs.mkdirSync(directory);
  return { base, store, directory };
}

test('empty directory removal is repeatable, never recursive and protects registrations', t => {
  const { store, directory } = fixture(t);
  assert.equal(receivedObjectsStatus(store).total, 0);
  store.local('v3Receive:test', { bytes: 0 });
  assert.equal(pruneReceivedDirectory(store).state, 'protected');
  store.local('v3Receive:test', null);
  store.local('localFileLinks', { test: path.join(directory, 'missing') });
  assert.equal(pruneReceivedDirectory(store).state, 'protected');
  store.local('localFileLinks', {});
  const id = uuid(); store.bindAsset(id, path.join(directory, 'missing'));
  assert.equal(pruneReceivedDirectory(store).state, 'protected');
  store.db.prepare('DELETE FROM assets WHERE id=?').run(id);
  fs.mkdirSync(path.join(directory, 'extra'));
  assert.equal(pruneReceivedDirectory(store).state, 'retained');
  fs.rmdirSync(path.join(directory, 'extra'));
  assert.equal(pruneReceivedDirectory(store).state, 'removed');
  assert.equal(pruneReceivedDirectory(store).state, 'absent');
  assert.equal(receivedObjectsStatus(store).exists, false);
});

test('inspection distinguishes references and resume files without altering data, with pagination', t => {
  const { store, directory } = fixture(t);
  const hashes = ['1', '2', '3', '4', '5'].map(char => char.repeat(64));
  for (const name of [...hashes, `${hashes[0]}.v3.partial`, 'unknown']) fs.writeFileSync(path.join(directory, name), 'keep');
  const reading = uuid(), organizing = uuid();
  store.bindAsset(reading, path.join(directory, hashes[1]));
  store.bindAsset(organizing, path.join(directory, hashes[2]));
  store.activeAssetReads = new Map([[reading, 1]]);
  store.local('localFileLinks', { example: path.join(directory, hashes[0]) });
  store.local(`v3Receive:${hashes[0]}`, { hash: hashes[0], bytes: 4, size: 10 });
  store.local('hierarchyCleanup', [{ relative: path.join('received-objects', hashes[3]), hash: hashes[3] }]);
  store.local('permanentDeletionFiles', [{ relative: path.join('received-objects', hashes[4]), state: 'blocked' }]);
  const status = receivedObjectsStatus(store, { limit: 2 });
  assert.equal(status.total, 7); assert.equal(status.items.length, 2); assert.equal(status.bytes, 28);
  assert.deepEqual(status.counts, { linked: 1, resume: 1, reading: 1, organize: 1, cleanup: 1, deletion: 1, review: 1 });
  assert.equal(receivedObjectsStatus(store, { offset: 6 }).items[0].name, 'unknown');
  assert.equal(pruneReceivedDirectory(store).state, 'retained');
  assert.equal(fs.readFileSync(path.join(directory, 'unknown'), 'utf8'), 'keep');
  assert.throws(() => receivedObjectsStatus(store, { limit: 101 }), /分页/);
});

test('successful organization moves verified originals then removes the empty receive directory', async t => {
  const { store, directory } = fixture(t), bytes = Buffer.from('original'), hash = sha(bytes);
  const library = store.saveLibrary({ title: '接收测试' });
  const record = store.write({ type: 'asset', data: { title: '原件', domain: library.data.domain,
    filename: 'sample.txt', size: bytes.length, sha256: hash, mime: 'text/plain', priority: 'normal' } });
  const old = path.join(directory, hash); fs.writeFileSync(old, bytes); store.bindAsset(record.id, old);
  const hierarchy = new LocalHierarchy(store);
  store.local('localFileLinks', { keep: old });
  const first = await hierarchy.refresh();
  assert.equal(first.errors.length, 0);
  assert.ok(fs.existsSync(old));
  assert.equal(receivedObjectsStatus(store).items[0].state, 'linked');
  store.local('localFileLinks', {});
  const result = await hierarchy.refresh();
  assert.equal(result.errors.length, 0); assert.equal(result.receivedDirectory.state, 'removed');
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readFileSync(store.assetLocation(record.id).path), bytes);
});

test('modified cleanup candidates remain intact, empty-directory failure is reported and retryable', async t => {
  const { store, directory } = fixture(t), file = path.join(directory, 'a'.repeat(64));
  fs.writeFileSync(file, 'user changed');
  store.local('hierarchyCleanup', [{ relative: path.relative(store.directory, file), hash: 'a'.repeat(64) }]);
  const hierarchy = new LocalHierarchy(store);
  await hierarchy.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), 'user changed');
  assert.equal(store.local('hierarchyCleanup').length, 1);
  // Failure injection applies only to this isolated empty directory.
  fs.unlinkSync(file);
  const original = fs.rmdirSync;
  const mock = t.mock.method(fs, 'rmdirSync', target => {
    if (target === directory) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return original(target);
  });
  assert.equal(pruneReceivedDirectory(store).state, 'blocked');
  mock.mock.restore();
  assert.equal(pruneReceivedDirectory(store).state, 'removed');
});

test('symlink receive directory is not traversed or removed', t => {
  const { store, directory, base } = fixture(t), outside = path.join(base, 'outside');
  fs.rmdirSync(directory); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pruneReceivedDirectory(store).state, 'blocked');
  assert.ok(receivedObjectsStatus(store).error);
  assert.deepEqual(receivedObjectsStatus(store).items, []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('interrupted receive survives directory maintenance and store reopen, then resumes', async t => {
  const { store, directory, base } = fixture(t), data = Buffer.from('receive across restart'), hash = sha(data);
  const asset = { hash, size: data.length, ids: [uuid()], chunks: [{ name: chunkName(hash, 0), hash, size: data.length }] };
  const channel = new DirectoryChannel(path.join(base, 'channel'), Buffer.alloc(32, 5));
  channel.write(asset.chunks[0].name, data, assetAAD(asset, 0));
  await assert.rejects(receiveResumable(channel, store, asset, { reserveBytes: 0, afterChunk: () => { throw new Error('interrupt'); } }), /interrupt/);
  assert.equal(receivedObjectsStatus(store).items[0].state, 'resume');
  await new LocalHierarchy(store).refresh();
  assert.ok(fs.existsSync(path.join(directory, `${hash}.v3.partial`)));
  store.close();
  const reopened = new Store(store.directory);
  try {
    const result = await receiveResumable(channel, reopened, asset, { reserveBytes: 0, afterChunk: () => { throw new Error('must not redownload'); } });
    assert.deepEqual(fs.readFileSync(result), data);
    assert.equal(receivedObjectsStatus(reopened).items[0].state, 'review');
    assert.equal(pruneReceivedDirectory(reopened).state, 'retained');
  } finally { reopened.close(); }
});

test('permanent deletion finishing removes only empty receive directories', async t => {
  const { store, directory } = fixture(t);
  await runDeletionFiles(store);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(store.local('receivedDirectoryCleanup').state, 'removed');
});

test('status is trusted UI only and is blocked during destructive work', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'service-')), service = new Service(directory);
  t.after(() => service.close());
  assert.equal((await service.call('receivedObjectsStatus')).exists, false);
  const library = service.store.saveLibrary({ title: '授权测试' }), access = new AgentAccess(service.store);
  const issued = access.createGrant({ name: '外部测试', domains: [library.data.domain] });
  const grant = access.grants().find(item => item.id === issued.id);
  assert.throws(() => access.dispatch(grant, { method: 'receivedObjectsStatus', input: {}, requestId: uuid() }));
  service.store.permanentDeleting = true;
  await assert.rejects(service.call('receivedObjectsStatus'), /永久删除/);
  service.store.permanentDeleting = false;
});
