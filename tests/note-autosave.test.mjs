import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoteAutosave } from '../web/note-autosave.js';

const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(write) {
  const notes = new Map(), states = [];
  const saver = createNoteAutosave({ delay: 100000, capture: key => notes.get(key)?.dirty ? structuredClone(notes.get(key).input) : null,
    write, apply: (key, saved, unchanged) => { const note = notes.get(key); note.dirty = !unchanged; note.input.parents = saved.heads; },
    status: (key, state) => states.push([key, state]) });
  const edit = (key, content) => {
    const old = notes.get(key);
    notes.set(key, { dirty: true, input: { id: key, data: { content }, parents: old?.input.parents || ['base'] } });
    saver.changed(key);
  };
  return { saver, notes, states, edit };
}
test('autosave serializes manual save and preserves edits made during the request', async t => {
  const first = pending(), calls = [];
  const app = setup(async input => { calls.push(input); return calls.length === 1 ? first.promise : { heads: ['two'] }; });
  t.after(() => app.saver.forget('note'));
  app.edit('note', 'first'); const saving = app.saver.flush('note');
  app.edit('note', 'second'); const manual = app.saver.flush('note', true);
  assert.equal(calls.length, 1); first.resolve({ heads: ['one'] });
  await saving; await manual;
  assert.equal(calls.length, 2); assert.equal(calls[1].data.content, 'second'); assert.deepEqual(calls[1].parents, ['one']);
  assert.equal(app.notes.get('note').dirty, false);
  await app.saver.flush('note', true); assert.equal(calls.length, 2);
});
test('autosave keeps note identity, pauses conflicts, and only retries explicitly', async t => {
  let fail = true; const calls = [];
  const app = setup(async (input, manual) => {
    calls.push({ input, manual });
    if (input.id === 'a' && fail) throw Object.assign(new Error('new version'), { code: 'CONFLICT' });
    return { heads: [input.id + '-saved'] };
  });
  t.after(async () => { await app.saver.forget('a'); await app.saver.forget('b'); });
  app.edit('a', 'unsaved'); await assert.rejects(app.saver.flush('a'), { code: 'CONFLICT' });
  app.edit('a', 'still editing'); await app.saver.flush('a');
  assert.equal(calls.length, 1); assert.equal(app.saver.state('a'), 'conflict');
  app.edit('b', 'other note'); await app.saver.flush('b');
  assert.equal(app.notes.get('a').dirty, true); assert.equal(app.notes.get('b').dirty, false);
  fail = false; await app.saver.flush('a', true);
  assert.equal(calls.at(-1).input.data.content, 'still editing'); assert.equal(calls.at(-1).manual, true);
});
test('failed writes retain the draft and can be manually retried without automatic branch saves', async t => {
  let fail = true;
  const app = setup(async () => { if (fail) throw new Error('offline'); return { heads: ['saved'] }; });
  t.after(() => app.saver.forget('note'));
  app.edit('note', 'keep'); await assert.rejects(app.saver.flush('note'), /offline/);
  assert.equal(app.saver.state('note'), 'error'); assert.equal(app.notes.get('note').dirty, true);
  fail = false; await app.saver.flush('note', true); assert.equal(app.notes.get('note').dirty, false);
});

test('exit retries failed saves without enabling manual conflict branches', async t => {
  let fail = true; const flags = [];
  const app = setup(async (_input, manual) => {
    flags.push(manual);
    if (fail) throw Object.assign(new Error('conflict'), { code: 'CONFLICT' });
    return { heads: ['saved'] };
  });
  t.after(() => app.saver.forget('note'));
  app.edit('note', 'keep'); await assert.rejects(app.saver.flush('note'), /conflict/);
  await assert.rejects(app.saver.flush('note', false, true), /conflict/);
  assert.equal(app.notes.get('note').dirty, true); assert.deepEqual(flags, [false, false]);
  fail = false; await app.saver.flush('note', false, true);
  assert.equal(app.notes.get('note').dirty, false); assert.equal(flags.at(-1), false);
});
