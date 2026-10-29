import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';
import { Service } from '../src/core/service.mjs';
import { canonical, sha } from '../src/core/util.mjs';
import { readFileWork, fileWorkStatus } from '../src/core/file-work.mjs';

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
