import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { canonical, sha, uuid } from '../src/core/util.mjs';
import { readFileWork, fileWorkStatus } from '../src/core/file-work.mjs';
import { deletionStatus } from '../src/core/permanent-files.mjs';

const root = path.resolve('artifacts/performance-tests'); fs.mkdirSync(root, { recursive: true });
function legacyList(store, { type, domain, query, trash = false, limit } = {}) {
  const rows = store.db.prepare(`SELECT e.json FROM heads h JOIN events e ON e.id=h.event_id ${type ? 'WHERE e.type=?' : ''} ORDER BY e.id`).all(...(type ? [type] : []));
  const grouped = new Map();
  for (const { json } of rows) { const event = JSON.parse(json); if (!grouped.has(event.entityId)) grouped.set(event.entityId, []); grouped.get(event.entityId).push(event); }
  let records = [...grouped].filter(([, heads]) => heads.every(e => e.deleted) === trash && !heads.every(e => e.purged)
    && (!domain || heads.some(e => e.data.domain === domain)) && (!query || heads.some(e => canonical(e.data).toLocaleLowerCase().includes(query.toLocaleLowerCase()))));
  records.sort((a, b) => b[1].map(e => e.createdAt).sort().at(-1).localeCompare(a[1].map(e => e.createdAt).sort().at(-1)));
  if (limit) records = records.slice(0, limit);
  return records.map(([id]) => id);
}

test('metadata paging preserves full-branch search, scopes, deletion, stable ties and rollback', t => {
  const store = new Store(fs.mkdtempSync(path.join(root, 'queries-'))); t.after(() => store.close());
  const records = [];
  for (let i = 0; i < 60; i++) records.push(store.write({ type: i % 4 ? 'note' : 'draft', data: { title: `条目${i}`, domain: i % 2 ? 'A' : 'B', content: `MiXeD 汉字 ${i} "引用"` } }));
  const item = records[3];
  store.writeRaw({ id: item.id, type: item.type, parents: item.heads, data: { ...item.data, content: '另一分支 搜索专用' } });
  store.writeRaw({ id: item.id, type: item.type, parents: item.heads, allowBranch: true, deleted: true, data: { ...item.data, domain: 'B' } });
  store.writeRaw({ id: records[2].id, type: 'note', parents: records[2].heads, deleted: true, data: records[2].data });
  const events = store.allEvents();
  for (const type of [undefined, 'note', 'draft']) for (const domain of [undefined, 'A', 'B']) for (const query of [undefined, 'MIXED', '汉字', '搜索专用', '"引用"']) for (const trash of [false, true]) {
    const input = { type, domain, query, trash, limit: 7 };
    assert.deepEqual(store.list(input).map(r => r.id), legacyList(store, input), JSON.stringify(input));
  }
  assert.deepEqual(store.allEvents(), events);
  const libraries = store.libraries();
  assert.throws(() => store.transaction(() => { store.writeRaw({ type: 'note', data: { title: 'rolled back', domain: 'C' } }); assert.ok(store.libraries().some(l => l.data.domain === 'C')); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(store.libraries(), libraries);
  assert.equal(store.list({ domain: 'C' }).length, 0);
  const sample = store.libraries(); sample[0].data.title = 'mutable caller'; assert.deepEqual(store.libraries(), libraries);
});

test('lightweight navigation equals full notes across branches, broken parents, receipts and rollback', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'navigation-'));
  const service = new Service(directory); await service.ready; t.after(() => service.close());
  const store = service.store;
  const note = (title, extra = {}) => store.write({ type: 'note', data: { title, domain: 'A', content: '大段正文'.repeat(12000), ...extra } });
  const parent = note('中文上级'), child = note('下级', { parentNoteId: parent.id, noteOrder: '1/3' });
  const explicitNull = note('同名', { parentNoteId: null, noteOrder: null }), other = note('同名', { domain: 'B' });
  const deleted = note('普通回收'), cleared = note('旧清空'), conflict = note('并发');
  store.remove(deleted.id, deleted.heads); const removed = store.remove(cleared.id, cleared.heads);
  store.transaction(() => store.purgeRaw(cleared.id, removed.heads));
  const append = (record, data, deleted = false) => {
    const { hash, ...original } = store.event(record.heads[0]);
    const event = { ...original, id: uuid(), parents: record.heads, data: { ...original.data, ...data }, deleted };
    store.importEvents([{ ...event, hash: sha(canonical(event)) }]);
  };
  append(conflict, { title: '并发 A' }); append(conflict, { domain: 'B', title: '并发 B' }, true);
  const orphan = note('缺失上级'), cycleA = note('循环甲'), cycleB = note('循环乙');
  append(orphan, { parentNoteId: uuid() }); append(cycleA, { parentNoteId: cycleB.id }); append(cycleB, { parentNoteId: cycleA.id });
  const expected = domain => store.noteTree(domain).map(({ data, versions, ...node }) => ({ ...node,
    data: { title: data.title, domain: data.domain, parentNoteId: data.parentNoteId, noteOrder: data.noteOrder } }));
  const compare = () => {
    for (const domain of [undefined, 'A', 'B', 'missing']) assert.deepEqual(store.noteNavigation(domain), expected(domain));
  };
  compare();
  assert.ok(store.noteNavigation('A').find(node => node.id === orphan.id).issue);
  assert.equal(store.noteNavigation('A').find(node => node.id === child.id).parentNoteId, parent.id);
  for (const domain of [undefined, 'A', 'B']) assert.deepEqual(await service.call('noteTree', { domain }), expected(domain));
  const returned = await service.call('noteTree', {}); returned[0].data.title = 'caller change';
  assert.deepEqual(await service.call('noteTree', {}), expected());
  const allHeads = store.noteNavigation().flatMap(node => node.heads);
  store.markExported(allHeads); compare();
  assert.deepEqual(await service.call('noteTree', {}), expected());
  store.receipt(allHeads, store.deviceId, new Date().toISOString()); compare();
  store.receipt(allHeads, uuid(), new Date().toISOString()); compare();
  assert.deepEqual(await service.call('noteTree', {}), expected());
  const before = await service.call('noteTree', {});
  assert.throws(() => store.transaction(() => {
    store.writeRaw({ id: explicitNull.id, type: 'note', parents: explicitNull.heads, data: { ...explicitNull.data, title: '临时改名', noteOrder: '-1/3' } });
    compare(); throw new Error('rollback navigation');
  }), /rollback navigation/);
  assert.deepEqual(await service.call('noteTree', {}), before);
  store.write({ id: other.id, type: 'note', parents: other.heads, data: { ...other.data, title: '保存后的名称' } });
  assert.deepEqual(await service.call('noteTree', {}), expected());
  const reopened = new Store(directory); t.after(() => reopened.close());
  assert.deepEqual(reopened.noteNavigation(), expected());
});

test('legacy-cleared status counts all history and stays current through rollback, conflicts and physical removal', t => {
  const store = new Store(fs.mkdtempSync(path.join(root, 'legacy-status-'))); t.after(() => store.close());
  const note = title => store.write({ type: 'note', data: { title, domain: 'A', content: '历史正文'.repeat(1000) } });
  const a = note('已清空'), b = note('回滚'), active = note('仍存续');
  const removedA = store.remove(a.id, a.heads), removedB = store.remove(b.id, b.heads);
  const compare = () => {
    const history = store.allEvents(), ids = new Set(history.map(event => event.entityId));
    const cleared = [...ids].filter(id => { const heads = store.headIds(id).map(head => store.event(head)); return heads.length && heads.every(head => head.purged); });
    assert.deepEqual(deletionStatus(store).legacyCleared, { count: cleared.length,
      revisions: history.filter(event => cleared.includes(event.entityId)).length });
  };
  compare(); store.transaction(() => store.purgeRaw(a.id, removedA.heads)); compare();
  assert.equal(deletionStatus(store).legacyCleared.count, 1);
  assert.throws(() => store.transaction(() => { store.purgeRaw(b.id, removedB.heads); compare(); throw new Error('rollback status'); }), /rollback status/);
  compare(); assert.equal(deletionStatus(store).legacyCleared.count, 1);
  const { hash, ...original } = store.event(removedA.heads[0]);
  const concurrent = { ...original, id: uuid(), parents: removedA.heads, deleted: false, data: { ...original.data, content: '远端新分支' } };
  store.importEvents([{ ...concurrent, hash: sha(canonical(concurrent)) }]); compare();
  assert.equal(deletionStatus(store).legacyCleared.count, 0);
  store.transaction(() => store.purgeRaw(b.id, removedB.heads)); compare();
  store.transaction(() => {
    store.db.prepare('DELETE FROM heads WHERE entity_id=?').run(b.id);
    store.db.prepare('DELETE FROM events WHERE entity_id=?').run(b.id);
    compare();
  });
  assert.equal(deletionStatus(store).legacyCleared.count, 0);
  assert.equal(store.get(active.id).data.title, '仍存续');
});

test('incremental projections only rewrite changed notes and propagate parent renames; explicit checks protect edits', async t => {
  const service = new Service(fs.mkdtempSync(path.join(root, 'projection-'))); await service.ready; t.after(() => service.close());
  const store = service.store, domain = store.saveLibrary({ title: '增量目录' }).id;
  const make = (title, parentNoteId = null) => store.write({ type: 'note', data: { title, domain, parentNoteId, content: '<p>original</p>', format: 'html' } });
  let parent = make('上级'), child = make('下级', parent.id), other = make('独立');
  let report = await service.organizeLocal({ verify: false }); assert.equal(report.updated, 3);
  report = await service.organizeLocal({ verify: false }); assert.equal(report.updated, 0); assert.equal(report.reused, 3);
  const state = store.local('hierarchyProjectionState'), otherFile = state[other.id].files.find(f => f.endsWith('正文.md'));
  const stamp = fs.statSync(path.join(store.directory, otherFile)).mtimeMs;
  parent = store.write({ id: parent.id, type: 'note', parents: parent.heads, data: { ...parent.data, content: '<p>changed</p>' } });
  report = await service.organizeLocal({ verify: false }); assert.equal(report.updated, 1); assert.equal(report.reused, 2);
  parent = store.write({ id: parent.id, type: 'note', parents: parent.heads, data: { ...parent.data, title: '新的上级' } });
  report = await service.organizeLocal({ verify: false }); assert.equal(report.updated, 2); assert.equal(report.reused, 1);
  assert.ok(store.local('hierarchyProjectionState')[child.id].files.some(file => file.includes('新的上级')));
  assert.equal(fs.statSync(path.join(store.directory, otherFile)).mtimeMs, stamp);
  fs.writeFileSync(path.join(store.directory, otherFile), 'external edit');
  report = await service.organizeLocal({ verify: true }); assert.ok(report.errors.some(error => error.id === other.id));
  assert.equal(fs.readFileSync(path.join(store.directory, otherFile), 'utf8'), 'external edit');
});

test('file workers hash bounded buffers off the event loop and keep ownership of the same descriptor', async () => {
  const file = path.join(fs.mkdtempSync(path.join(root, 'worker-')), 'content.bin'), bytes = Buffer.alloc(16 * 1024 * 1024, 7);
  fs.writeFileSync(file, bytes); const handle = await fs.promises.open(file, 'r');
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try {
    const result = await readFileWork(handle, bytes.length, { content: true });
    assert.equal(result.hash, sha(bytes)); assert.deepEqual(Buffer.from(result.data), bytes);
    assert.ok(ticks > 0); assert.ok(fileWorkStatus().threadId > 0);
    assert.equal((await handle.stat()).size, bytes.length);
    await assert.rejects(readFileWork(handle, bytes.length + 1), /不完整/);
  } finally { clearInterval(timer); await handle.close(); }
});
