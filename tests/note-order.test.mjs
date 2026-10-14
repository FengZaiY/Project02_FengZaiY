import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, cleanData } from '../src/core/store.mjs';
import { CurrentSync } from '../src/core/current-sync.mjs';
import { LocalHierarchy } from '../src/core/local-hierarchy.mjs';
import { AgentAccess } from '../src/core/agent-access.mjs';
import { makePairingKey, importAttachment } from '../src/core/transport.mjs';
import { orderBetween, compareNoteOrder } from '../src/core/note-order.mjs';
import { uuid, hashFile } from '../src/core/util.mjs';

const root = path.resolve('artifacts/note-order-tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), store = new Store(path.join(directory, 'A'));
  t.after(() => store.close());
  const domain = store.saveLibrary({ title: '排序验证' }).id;
  const note = (title, parentNoteId = null, extra = {}) => store.write({ type: 'note',
    data: { title, domain, parentNoteId, content: `${title}原文`, ...extra } });
  return { store, directory, domain, note };
}
function request(store, id, targetId, side = 'before') {
  const source = store.get(id), target = store.get(targetId), parentNoteId = target.data.parentNoteId || null;
  return { id, parents: source.heads, parentNoteId, notePlacement: { targetId, side,
    context: store.noteTree(source.data.domain).filter(node => node.id !== id && node.parentNoteId === parentNoteId)
      .map(node => ({ id: node.id, heads: node.heads })).sort((a, b) => a.id.localeCompare(b.id)) } };
}
const names = (store, domain, parent = null) => store.noteTree(domain).filter(node => node.parentNoteId === parent).map(node => node.data.title);

test('sibling placement persists, moves whole subtrees and changes only necessary history', t => {
  const f = fixture(t), a = f.note('A'), b = f.note('B'), c = f.note('C'), child = f.note('子', c.id);
  const originalEvents = f.store.allEvents();
  assert.deepEqual(names(f.store, f.domain), ['A', 'B', 'C']);
  f.store.moveNote(request(f.store, c.id, a.id));
  assert.deepEqual(names(f.store, f.domain), ['C', 'A', 'B']);
  assert.deepEqual(f.store.noteTree(f.domain).map(node => node.data.title), ['C', '子', 'A', 'B']);
  assert.equal(f.store.history(child.id).length, 1);
  assert.equal(f.store.get(c.id).data.content, 'C原文');
  const count = f.store.allEvents().length, aHeads = f.store.get(a.id).heads;
  f.store.moveNote(request(f.store, c.id, b.id, 'after'));
  assert.deepEqual(names(f.store, f.domain), ['A', 'B', 'C']);
  assert.equal(f.store.allEvents().length, count + 1);
  assert.deepEqual(f.store.get(a.id).heads, aHeads);
  f.store.moveNote(request(f.store, c.id, b.id, 'after'));
  assert.equal(f.store.allEvents().length, count + 1, 'No-op creates no revision');
  const grandchild = f.note('孙', child.id);
  f.store.moveNote(request(f.store, child.id, a.id, 'after'));
  assert.deepEqual(names(f.store, f.domain), ['A', '子', 'B', 'C']);
  assert.equal(f.store.get(grandchild.id).data.parentNoteId, child.id);
  for (const event of originalEvents) assert.deepEqual(f.store.event(event.id), event, 'Old event bytes unchanged');
  const reopened = new Store(path.join(f.directory, 'A')); t.after(() => reopened.close());
  assert.deepEqual(names(reopened, f.domain), names(f.store, f.domain));
  const history = f.store.history(c.id), current = f.store.get(c.id);
  f.store.restoreVersion(c.id, history.at(-1).id, current.heads);
  assert.equal(f.store.history(c.id).length, history.length + 1);
});

test('stale source, stale destination, cross-library, cycles and injected write failures are atomic', t => {
  const f = fixture(t), a = f.note('A'), b = f.note('B'), c = f.note('C'), child = f.note('子', c.id);
  const stale = request(f.store, c.id, a.id);
  f.store.write({ id: b.id, parents: b.heads, data: { ...b.data, content: '新正文' } });
  const baseline = f.store.allEvents();
  assert.throws(() => f.store.moveNote(stale), /已变化/);
  assert.deepEqual(f.store.allEvents(), baseline);
  const sourceStale = request(f.store, c.id, a.id);
  f.store.write({ id: c.id, parents: c.heads, data: { ...c.data, content: '源已编辑' } });
  assert.throws(() => f.store.moveNote(sourceStale), /changed/);
  assert.throws(() => f.store.moveNote(request(f.store, c.id, child.id)), /自身|下级/);
  const other = f.note('越界', null, { domain: f.store.saveLibrary({ title: '外库' }).id });
  assert.throws(() => f.store.moveNote(request(f.store, c.id, other.id)), /已变化/);
  const beforeFailure = f.store.allEvents(), raw = f.store.writeRaw;
  f.store.writeRaw = function(input) { if (input.id === c.id) throw new Error('disk full'); return raw.call(this, input); };
  try { assert.throws(() => f.store.moveNote(request(f.store, c.id, a.id)), /disk full/); }
  finally { f.store.writeRaw = raw; }
  assert.deepEqual(f.store.allEvents(), beforeFailure);
});

test('exact fractions survive dense insertion and same-rank collisions are normalized', t => {
  let right = '1/1';
  for (let i = 0; i < 180; i++) {
    const next = orderBetween('0/1', right);
    assert.ok(compareNoteOrder({ id: '', data: { noteOrder: next } }, { id: '', data: { noteOrder: right } }) < 0);
    right = next;
  }
  for (const value of ['NaN', '1/0', '-0/1', '01/2', {}, '1/' + '9'.repeat(2048)]) {
    assert.throws(() => cleanData('note', { title: '不合法', noteOrder: value }), /顺序/);
  }
  const f = fixture(t), a = f.note('A', null, { noteOrder: '1/1' }), b = f.note('B', null, { noteOrder: '2/2' }), c = f.note('C');
  const siblings = f.store.noteTree(f.domain);
  f.store.moveNote(request(f.store, c.id, siblings[0].id, 'after'));
  assert.deepEqual(f.store.noteTree(f.domain).map(node => node.id), [siblings[0].id, c.id, siblings[1].id]);
  assert.equal(f.store.get(a.id).conflict, false); assert.equal(f.store.get(b.id).conflict, false);
});

test('v3 transfers order, idempotently imports and retains concurrent ordering branches', async t => {
  const f = fixture(t), a = f.note('A'), b = f.note('B'), c = f.note('C');
  f.store.moveNote(request(f.store, c.id, a.id));
  const other = new Store(path.join(f.directory, 'B')); t.after(() => other.close());
  const sa = new CurrentSync(f.store), sb = new CurrentSync(other), cloud = path.join(f.directory, 'cloud'), key = makePairingKey();
  sa.configure(cloud, key); sb.configure(cloud, key);
  await sa.publish(); await sb.importLatest();
  assert.deepEqual(names(other, f.domain), ['C', 'A', 'B']);
  const count = other.allEvents().length; await sb.importLatest(); assert.equal(other.allEvents().length, count);
  f.store.moveNote(request(f.store, c.id, a.id, 'after'));
  other.moveNote(request(other, c.id, b.id, 'after'));
  await sa.publish(); await sb.importLatest();
  assert.equal(other.get(c.id).conflict, true);
  assert.equal(other.get(c.id).versions.length, 2);
  assert.ok(other.noteTree(f.domain).find(node => node.id === c.id).issue);
  assert.equal(other.get(c.id).versions.every(version => version.data.content === 'C原文'), true);
});

test('order alone does not move original files; sibling reparenting updates local hierarchy', async t => {
  const f = fixture(t), parent = f.note('P'), a = f.note('A'), b = f.note('B', parent.id);
  const file = path.join(f.directory, 'original.txt'); fs.writeFileSync(file, '唯一原件');
  const asset = await importAttachment(f.store, file, { domain: f.domain });
  f.store.write({ id: a.id, parents: a.heads, data: { ...a.data, assetIds: [asset.id] } });
  const local = new LocalHierarchy(f.store); await local.refresh();
  const old = f.store.assetLocation(asset.id).path;
  f.store.moveNote(request(f.store, a.id, parent.id, 'after')); await local.refresh();
  assert.equal(f.store.assetLocation(asset.id).path, old);
  f.store.moveNote(request(f.store, a.id, b.id, 'before')); await local.refresh();
  const moved = f.store.assetLocation(asset.id).path;
  assert.notEqual(moved, old); assert.ok(moved.includes(parent.id));
  assert.equal(await hashFile(moved), asset.data.sha256);
  assert.ok(fs.existsSync(file));
});

test('Agent text updates and proposals preserve order without gaining sorting authority', t => {
  const f = fixture(t), a = f.note('A'), b = f.note('B');
  f.store.moveNote(request(f.store, b.id, a.id));
  const access = new AgentAccess(f.store), issued = access.createGrant({ name: '助手', domains: [f.domain], edit: true });
  const grant = access.grants().find(item => item.id === issued.id);
  const call = (method, input) => access.dispatch(grant, { method, requestId: uuid(), input: { ...input, preferencesVersion: access.preferences().version } });
  const source = f.store.get(b.id), data = { ...source.data, content: 'AI补充' }; delete data.noteOrder;
  call('noteUpdate', { id: b.id, parents: source.heads, data });
  const updated = f.store.get(b.id);
  assert.equal(updated.data.noteOrder, source.data.noteOrder);
  assert.throws(() => call('noteUpdate', { id: b.id, parents: updated.heads, data: { ...updated.data, noteOrder: '20/1' } }), /排序/);
  const proposal = call('propose', { domain: f.domain, items: [{ targetId: b.id, parents: updated.heads, data }] });
  assert.equal(proposal.data.items[0].data.noteOrder, source.data.noteOrder);
  assert.throws(() => call('noteMove', request(f.store, b.id, a.id, 'after')), /未授权/);
});
