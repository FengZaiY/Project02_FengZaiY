import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Service } from '../src/core/service.mjs';
import { previewEmptyDirectories, cleanEmptyDirectories } from '../src/core/empty-library-directories.mjs';

async function fixture(t) {
  const service = new Service(fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-remnants-')));
  await service.ready; t.after(() => service.close());
  const store = service.store;
  const orphan = title => {
    const id = randomUUID();
    const directory = store.directories.ensure({ id, type: 'library', data: { domain: id, title } });
    return { id, directory };
  };
  const clean = () => cleanEmptyDirectories(store, { token: previewEmptyDirectories(store).token, confirmed: true });
  return { service, store, orphan, clean };
}

test('legacy-only cleanup exposes hidden history without deleting ordinary trash or accepting a widened scope', async t => {
  const { service, store } = await fixture(t);
  const add = domain => {
    const note = store.write({ type: 'note', data: { title: 'test', domain, content: 'retained until confirmation' } });
    return store.remove(note.id, note.heads);
  };
  const legacy = add('old-scope'), ordinary = add('new-scope');
  store.transaction(() => store.purgeRaw(legacy.id, legacy.heads));
  assert.deepEqual(service.state().deletion.legacyCleared, { count: 1, revisions: 3 });
  const plan = await service.call('trashPreview', { legacyOnly: true });
  assert.deepEqual(plan.eligible.map(item => item.id), [legacy.id]);
  await assert.rejects(service.call('trashEmpty', { ...plan, confirmed: false }), /明确确认/);
  await assert.rejects(service.call('trashEmpty', { ...plan, legacyOnly: false, confirmed: true }), { code: 'CONFLICT' });
  await service.call('trashEmpty', { ...plan, confirmed: true });
  assert.equal(store.allEvents().some(event => event.entityId === legacy.id), false);
  assert.ok(store.get(ordinary.id));
  assert.equal(service.state().deletion.legacyCleared.count, 0);
});

test('empty directory cleanup preserves active libraries and removes only verified orphan markers', async t => {
  const { store, orphan, clean } = await fixture(t);
  const live = store.saveLibrary({ title: 'active empty library' });
  const active = store.directories.ensure(live), abandoned = orphan('abandoned');
  const plan = previewEmptyDirectories(store);
  assert.deepEqual(plan.eligible.map(item => item.id), [abandoned.id]);
  assert.ok(plan.blocked.some(item => item.id === live.id));
  assert.throws(() => cleanEmptyDirectories(store, { token: plan.token }), /明确确认/);
  assert.equal(clean().removed, 1);
  assert.ok(fs.existsSync(active)); assert.equal(fs.existsSync(abandoned.directory), false);
  assert.equal(store.local('libraryDirectories')[abandoned.id], undefined);
  assert.equal(clean().removed, 0);
});

test('new files and changed markers invalidate confirmation; unknown directories remain untouched', async t => {
  const { store, orphan } = await fixture(t), target = orphan('extra');
  const plan = previewEmptyDirectories(store), extra = path.join(target.directory, 'personal.txt');
  fs.writeFileSync(extra, 'keep');
  assert.throws(() => cleanEmptyDirectories(store, { token: plan.token, confirmed: true }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
  const other = orphan('marker');
  fs.writeFileSync(path.join(other.directory, '.fengzaiy-library.json'), '{}');
  assert.ok(previewEmptyDirectories(store).blocked.some(item => item.id === other.id && /归属/.test(item.reason)));
  const unknown = path.join(store.directory, 'untracked'); fs.mkdirSync(unknown);
  assert.equal(previewEmptyDirectories(store).eligible.length, 0);
  assert.ok(fs.existsSync(unknown));
});

test('permanently erased library identifiers in change batches do not pin an empty folder', async t => {
  const { service, store, clean } = await fixture(t);
  const library = store.change('create library', 'user', () => store.saveLibrary({ title: '已清空的测试' }));
  const directory = store.directories.ensure(library);
  store.remove(library.id, library.heads);
  const trash = await service.call('trashPreview');
  await service.call('trashEmpty', { token: trash.token, confirmed: true });
  assert.ok(store.erasures().some(item => item.entityId === library.id));
  assert.equal(store.get(library.id), null);
  const history = store.allEvents();
  assert.ok(history.some(event => event.type === 'changeBatch' && event.data.entries.some(entry => entry.id === library.id)));
  const preview = previewEmptyDirectories(store);
  assert.equal(preview.directory, store.directory);
  assert.equal(preview.eligible.find(item => item.id === library.id)?.path, directory);
  assert.equal(clean().removed, 1);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(store.allEvents(), history);
});

test('batch identifiers without permanent erasure still protect empty directories', async t => {
  const { store, orphan } = await fixture(t), target = orphan('unverified history');
  store.write({ type: 'changeBatch', data: { title: 'batch', actor: 'user', entries: [{ id: target.id, before: [], after: [randomUUID()] }] } });
  assert.ok(previewEmptyDirectories(store).blocked.some(item => item.id === target.id && /历史/.test(item.reason)));
});

test('history, workspace tabs, file bindings and pending sync each protect orphan directories', async t => {
  const { store, orphan } = await fixture(t);
  const history = orphan('history'), tab = orphan('tab'), bound = orphan('binding'), pending = orphan('pending');
  const note = store.write({ type: 'note', data: { title: 'old', domain: history.id, content: 'old' } });
  store.remove(note.id, note.heads);
  store.local('workspace', { tabs: [{ domain: tab.id, dirty: true }] });
  store.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run(randomUUID(), path.join(bound.directory, 'missing-original'));
  store.db.prepare('INSERT INTO pending VALUES(?,?)').run(randomUUID(), JSON.stringify({ data: { domain: pending.id } }));
  assert.equal(previewEmptyDirectories(store).eligible.length, 0);
  assert.equal(previewEmptyDirectories(store).blocked.length, 4);
});

test('directory removal failure preserves a newly arrived file and restores the ownership marker for retry', async t => {
  const { store, orphan, clean } = await fixture(t), target = orphan('failure');
  const original = fs.rmdirSync;
  fs.rmdirSync = directory => {
    if (directory === target.directory) { fs.writeFileSync(path.join(directory, 'new.txt'), 'keep'); throw new Error('interrupted removal'); }
    return original(directory);
  };
  try { assert.equal(clean().pending, 1); } finally { fs.rmdirSync = original; }
  assert.ok(store.directories.owns(target.directory, target.id));
  assert.equal(fs.readFileSync(path.join(target.directory, 'new.txt'), 'utf8'), 'keep');
  assert.equal(store.local('emptyDirectoryCleanup').results[0].state, 'blocked');
  assert.equal(previewEmptyDirectories(store).eligible.length, 0);
});

test('missing orphan directories can drop stale mappings and active operations prevent cleanup', async t => {
  const { service, store, orphan, clean } = await fixture(t), target = orphan('missing');
  fs.unlinkSync(path.join(target.directory, '.fengzaiy-library.json')); fs.rmdirSync(target.directory);
  service.transport.running = true;
  await assert.rejects(service.call('emptyDirectoriesPreview'), { code: 'BUSY' });
  service.transport.running = false;
  assert.equal(clean().removed, 1);
  assert.equal(Object.hasOwn(store.local('libraryDirectories'), target.id), false);
});

test('a new note invalidates an empty-directory preview and directory junctions are never followed', async t => {
  const { store, orphan } = await fixture(t), target = orphan('new note');
  const preview = previewEmptyDirectories(store);
  store.write({ type: 'note', data: { title: 'new', domain: target.id, content: 'keep' } });
  assert.throws(() => cleanEmptyDirectories(store, { token: preview.token, confirmed: true }), { code: 'CONFLICT' });
  const linked = orphan('junction'), external = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-external-'));
  fs.writeFileSync(path.join(external, 'source.txt'), 'keep external');
  fs.unlinkSync(path.join(linked.directory, '.fengzaiy-library.json')); fs.rmdirSync(linked.directory);
  fs.symlinkSync(external, linked.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(previewEmptyDirectories(store).blocked.some(item => item.id === linked.id));
  assert.equal(fs.readFileSync(path.join(external, 'source.txt'), 'utf8'), 'keep external');
});
