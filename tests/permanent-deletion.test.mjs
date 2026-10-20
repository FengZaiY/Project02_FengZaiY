import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { previewTrash, emptyTrash } from '../src/core/trash.mjs';
import { runDeletionFiles, scheduleDeletion } from '../src/core/permanent-files.mjs';
import { filterErased } from '../src/core/erasures.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyself-erasure-'));
  const a = new Service(path.join(root, 'A')), b = new Service(path.join(root, 'B'));
  t.after(async () => { await a.close(); await b.close(); });
  const library = a.store.saveLibrary({ title: '隔离测试' });
  const note = (content, assets = []) => a.store.write({ type: 'note', data: { title: '测试正文', content, domain: library.id, assetIds: assets } });
  const remove = record => a.store.remove(record.id, record.heads);
  const clear = async () => a.call('trashEmpty', { domain: library.id, token: previewTrash(a.store, { domain: library.id }).token, confirmed: true });
  const pair = () => { const folder = path.join(root, 'sync'); a.transport.configure(folder, '3'.repeat(64)); b.transport.configure(folder, '3'.repeat(64)); };
  return { root, a, b, library, note, remove, clear, pair };
}

test('permanent removal deletes payload, database bytes and projections; journal resumes after restart', async t => {
  const f = setup(t), secret = 'erase-this-unique-sentinel-9481255', note = f.note(secret);
  await f.a.organizeLocal(); f.remove(note); await f.a.organizeLocal();
  const files = previewTrash(f.a.store).files.map(item => path.join(f.a.store.directory, item.relative));
  assert.equal(files.length, 2);
  const plan = previewTrash(f.a.store);
  emptyTrash(f.a.store, { token: plan.token, confirmed: true });
  assert.equal(files.every(file => fs.existsSync(file)), true);
  const dir = f.a.store.directory; await f.a.close();
  const reopened = new Service(dir); t.after(() => reopened.close());
  await reopened.call('deletionRetry');
  assert.equal(files.some(file => fs.existsSync(file)), false);
  assert.equal(reopened.store.allEvents().some(event => event.entityId === note.id), false);
  assert.equal(JSON.stringify(reopened.store.erasures()).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(dir, 'knowledge.sqlite')).includes(Buffer.from(secret)), false);
  assert.equal((await reopened.organizeLocal()).errors.length, 0);
  assert.equal((await reopened.call('deletionRetry')).pending, 0);
});

test('empty or repeated deletion preserves unrelated publication; affected frozen payload is cancelled', async t => {
  const f = setup(t); f.pair();
  const note = f.note('remove this frozen payload');
  await f.a.transport.plan();
  scheduleDeletion(f.a.store, [], []);
  assert.ok(f.a.transport.value('plan'));
  f.remove(note); await f.clear();
  assert.equal(f.a.transport.value('plan'), null);
  await f.a.transport.plan();
  const plan = f.a.transport.value('plan'), progress = f.a.transport.progress();
  scheduleDeletion(f.a.store, [note.id], []);
  assert.deepEqual(f.a.transport.value('plan'), plan);
  assert.deepEqual(f.a.transport.progress(), progress);
});

test('implicit unique attachments are physically deleted while shared history and import source survive', async t => {
  const f = setup(t), source = path.join(f.root, 'source.txt'); fs.writeFileSync(source, 'file-bytes-unique');
  const asset = await f.a.call('assetImport', { path: source, domain: f.library.id });
  const doomed = f.note('delete', [asset.id]);
  const owner = f.note('keep reference', [asset.id]);
  f.a.store.write({ id: owner.id, parents: owner.heads, type: 'note', data: { ...owner.data, assetIds: [] } });
  f.remove(doomed);
  let preview = previewTrash(f.a.store);
  assert.ok(preview.blocked.some(item => item.id === asset.id));
  const local = f.a.store.assetLocation(asset.id).path;
  await f.clear();
  assert.equal(fs.existsSync(local), true);
  f.remove(f.a.store.get(owner.id));
  preview = previewTrash(f.a.store);
  assert.ok(preview.eligible.some(item => item.id === asset.id && item.implicitAsset));
  await f.clear();
  assert.equal(fs.existsSync(local), false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'file-bytes-unique');
});

test('modified projections are retained with retryable errors; untracked extra files are untouched', async t => {
  const f = setup(t), note = f.note('original'); f.remove(note); await f.a.organizeLocal();
  const plan = previewTrash(f.a.store), file = plan.files.find(item => item.relative.endsWith('.md'));
  const absolute = path.join(f.a.store.directory, file.relative), original = fs.readFileSync(absolute);
  fs.writeFileSync(absolute, 'user modification');
  const extra = path.join(path.dirname(absolute), 'extra.txt'); fs.writeFileSync(extra, 'keep');
  const result = await f.clear();
  assert.equal(result.cleanup.pending, 1);
  assert.match(result.cleanup.files.find(item => item.state === 'blocked').reason, /外部修改/);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
  fs.writeFileSync(absolute, original);
  assert.equal((await f.a.call('deletionRetry')).pending, 0);
});

test('mixed encrypted histories are replaced and new devices ignore erased originals without downloading them', async t => {
  const f = setup(t); f.pair();
  const source = path.join(f.root, 'video.mp4'); fs.writeFileSync(source, Buffer.alloc(10000, 77));
  const asset = await f.a.call('assetImport', { path: source, domain: f.library.id });
  const gone = f.note('private discarded text', [asset.id]), kept = f.note('retained text');
  await f.a.transport.publish(); await f.b.transport.importLatest(); await f.b.transport.publish();
  f.remove(gone); await f.clear();
  const report = f.a.store.local('permanentDeletionTransport');
  assert.deepEqual(report.errors, []);
  assert.equal(f.a.transport.channel().names('.ssobj').some(name => name.startsWith(`asset-${asset.data.sha256}-`)), false);
  await f.a.transport.publish();
  const original = f.b.store.assetLocation(asset.id).path;
  await f.b.transport.importLatest();
  assert.equal(f.b.store.get(gone.id), null);
  assert.equal(f.b.store.get(kept.id).data.content, 'retained text');
  assert.equal(fs.existsSync(original), false);
  const c = new Service(path.join(f.root, 'C')); t.after(() => c.close());
  c.transport.configure(path.join(f.root, 'sync'), '3'.repeat(64));
  await c.transport.importLatest(); await c.transport.importLatest();
  assert.equal(c.store.get(gone.id), null);
  assert.equal(c.store.get(kept.id).data.content, 'retained text');
  assert.equal(c.transport.scan().entries.every(entry => entry.missing.length === 0), true);
});

test('unknown concurrent edit blocks deletion import without losing the local branch', async t => {
  const f = setup(t); f.pair(); const note = f.note('base');
  await f.a.transport.publish(); await f.b.transport.importLatest();
  const local = f.b.store.get(note.id);
  f.b.store.write({ id: note.id, type: 'note', parents: local.heads, data: { ...local.data, content: 'new concurrent text' } });
  f.remove(note); await f.clear(); await f.a.transport.publish();
  await assert.rejects(f.b.transport.importLatest(), { code: 'ERASURE_CONFLICT' });
  assert.equal(f.b.store.get(note.id).data.content, 'new concurrent text');
  assert.equal(f.b.store.erasures().length, 0);
});

test('old cleared legacy scope no longer causes maintenance failure and requires explicit permanent cleanup', async t => {
  const f = setup(t), legacy = f.a.store.write({ type: 'note', data: { title: 'legacy', domain: 'AI', content: 'old-body' } });
  const deleted = f.a.store.remove(legacy.id, legacy.heads); await f.a.organizeLocal();
  f.a.store.transaction(() => f.a.store.purgeRaw(deleted.id, deleted.heads));
  assert.equal((await f.a.organizeLocal()).errors.length, 0);
  const plan = previewTrash(f.a.store, { domain: 'AI' });
  assert.ok(plan.eligible.some(item => item.id === legacy.id && item.legacyCleared));
  emptyTrash(f.a.store, { domain: 'AI', token: plan.token, confirmed: true });
  await runDeletionFiles(f.a.store);
  assert.equal(f.a.store.allEvents().some(event => event.entityId === legacy.id), false);
});

test('known old payload cannot reappear through the legacy import path', async t => {
  const f = setup(t), note = f.note('old'); f.remove(note);
  const old = f.a.store.allEvents(); await f.clear();
  f.a.store.importEvents(old.reverse());
  assert.equal(f.a.store.get(note.id), null);
  assert.equal(filterErased(old, f.a.store.erasures()).some(event => event.entityId === note.id), false);
  assert.throws(() => f.a.store.write({ id: note.id, data: note.data }), /清空/);
});

test('an active original read or a new reference invalidates the deletion preview', async t => {
  const f = setup(t), source = path.join(f.root, 'source.txt'); fs.writeFileSync(source, 'original');
  const asset = await f.a.call('assetImport', { path: source, domain: f.library.id });
  const note = f.note('delete', [asset.id]); f.remove(note);
  const preview = previewTrash(f.a.store);
  f.a.store.activeAssetReads = new Map([[asset.id, 1]]);
  await assert.rejects(f.a.call('trashEmpty', { token: preview.token, confirmed: true }), { code: 'CONFLICT' });
  assert.ok(f.a.store.get(note.id));
  f.a.store.activeAssetReads.clear();
  f.note('new ref', [asset.id]);
  await assert.rejects(f.a.call('trashEmpty', { token: preview.token, confirmed: true }), { code: 'CONFLICT' });
});

test('database compaction failure is reported and retries without recreating removed history', async t => {
  const f = setup(t), note = f.note('delete'); f.remove(note);
  const exec = f.a.store.db.exec.bind(f.a.store.db);
  f.a.store.db.exec = sql => { if (sql === 'VACUUM') throw new Error('disk full simulation'); return exec(sql); };
  const result = await f.clear();
  assert.equal(result.cleanup.database.state, 'blocked');
  assert.equal(f.a.store.get(note.id), null);
  f.a.store.db.exec = exec;
  assert.equal((await f.a.call('deletionRetry')).database.state, 'done');
});

test('transport replacement failure preserves the old part and supports retry', async t => {
  const f = setup(t); f.pair(); const note = f.note('delete'), keep = f.note('keep');
  await f.a.transport.publish();
  const channel = f.a.transport.channel(), part = f.a.transport.value('latest').parts[0];
  f.remove(note);
  const directory = channel.file(`replace-${part.hash}.ssreplacement`); fs.mkdirSync(directory);
  const result = await f.clear();
  assert.equal(result.cleanup.transport.state, 'blocked');
  assert.equal(fs.existsSync(channel.file(part.name)), true);
  fs.rmdirSync(directory);
  await f.a.call('deletionRetry');
  assert.equal(fs.existsSync(channel.file(part.name)), false);
  await f.b.transport.importLatest();
  assert.equal(f.b.store.get(note.id), null);
  assert.equal(f.b.store.get(keep.id).data.content, 'keep');
});
