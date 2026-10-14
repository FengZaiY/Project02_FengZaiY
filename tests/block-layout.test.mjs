import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { moveBlock, moveBlockAt } from '../web/block-layout.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 2 } } },
    blockquote: { group: 'block', content: 'block+' },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: 'tableCell+' },
    tableCell: { content: 'block+', isolating: true },
    blockRow: { group: 'block', content: 'richBlock+' },
    richBlock: { group: 'block', atom: true, attrs: { payload: { default: '' }, layout: { default: null } } },
    hardBreak: { group: 'inline', inline: true },
    text: { group: 'inline' }
  },
  marks: { bold: {}, link: { attrs: { href: {} } } }
});
const text = (value, marks) => schema.text(value, marks);
const paragraph = (...children) => schema.node('paragraph', null, children);
const media = (payload = 'map') => schema.node('richBlock', { payload, layout: { width: 60, height: 150, align: 'left' } });
const br = () => schema.node('hardBreak');
const find = (doc, predicate) => { let result; doc.descendants((node, pos) => { if (result === undefined && predicate(node)) result = pos; }); assert.notEqual(result, undefined); return result; };
const editor = children => {
  const instance = { schema, state: EditorState.create({ schema, doc: schema.node('doc', null, children), plugins: [history()] }) };
  instance.view = { dispatch: tr => { instance.state = instance.state.apply(tr); instance.state.doc.check(); } };
  return instance;
};

test('moving media between hard-break lines preserves marks, payload and one-step undo', () => {
  const a = text('第一行', [schema.mark('bold')]), b = text('第二行', [schema.mark('link', { href: 'https://example.com' })]), map = media();
  const e = editor([map, paragraph(a, br(), b)]), original = e.state.doc;
  assert.equal(moveBlockAt(e, 0, find(original, node => node.type.name === 'hardBreak')), true);
  assert.deepEqual(e.state.doc.toJSON(), schema.node('doc', null, [paragraph(a), map, paragraph(b)]).toJSON());
  assert.equal(undo(e.state, e.view.dispatch), true); assert.ok(e.state.doc.eq(original));
  assert.equal(redo(e.state, e.view.dispatch), true);
  assert.equal(e.state.doc.child(1).attrs.payload, 'map');
});
test('moving backward from below the paragraph maps the split and preserves extra blank lines', () => {
  const map = media(), e = editor([paragraph(text('前'), br(), br(), text('后')), map]);
  const at = find(e.state.doc, n => n.type.name === 'hardBreak');
  moveBlockAt(e, find(e.state.doc, n => n === map), at + 1);
  assert.deepEqual(e.state.doc.toJSON(), schema.node('doc', null, [paragraph(text('前'), br()), map, paragraph(text('后'))]).toJSON());
});
test('soft wrapped text can split without losing or adding characters', () => {
  const map = media(), e = editor([map, paragraph(text('ABCDEFGHIJ', [schema.mark('bold')]))]);
  moveBlockAt(e, 0, find(e.state.doc, n => n.isText) + 4);
  assert.equal(e.state.doc.textContent, 'ABCDEFGHIJ');
  assert.equal(e.state.doc.child(0).textContent, 'ABCD');
  assert.equal(e.state.doc.child(2).textContent, 'EFGHIJ');
  assert.equal(e.state.doc.child(2).firstChild.marks[0].type.name, 'bold');
});
test('moving media out of a row keeps its sibling and can rejoin it', () => {
  const map = media(), image = media('image'), e = editor([schema.node('blockRow', null, [map, image]), paragraph(text('上'), br(), text('下'))]);
  moveBlockAt(e, find(e.state.doc, n => n === map), find(e.state.doc, n => n.type.name === 'hardBreak'));
  assert.equal(e.state.doc.firstChild, image);
  moveBlock(e, find(e.state.doc, n => n === map), find(e.state.doc, n => n === image), 'right');
  assert.equal(e.state.doc.firstChild.type.name, 'blockRow');
  assert.equal(e.state.doc.firstChild.child(1).attrs.payload, 'map');
});
for (const wrapper of ['blockquote', 'listItem', 'tableCell']) {
  test(`nested ${wrapper} accepts media between lines and can move it out again`, () => {
    const map = media(), p = paragraph(text('上'), br(), text('下'));
    const wrap = child => wrapper === 'blockquote' ? schema.node(wrapper, null, [child])
      : wrapper === 'listItem' ? schema.node('bulletList', null, [schema.node(wrapper, null, [child])])
        : schema.node('table', null, [schema.node('tableRow', null, [schema.node(wrapper, null, [child])])]);
    const e = editor([map, wrap(p), paragraph(text('末尾'))]);
    moveBlockAt(e, 0, find(e.state.doc, n => n.type.name === 'hardBreak'));
    let at = find(e.state.doc, n => n === map);
    assert.equal(e.state.doc.resolve(at).parent.type.name, wrapper);
    const last = find(e.state.doc, n => n.textContent === '末尾' && n.isTextblock);
    moveBlock(e, at, last, 'after');
    assert.equal(e.state.doc.lastChild, map);
    assert.equal(e.state.doc.textContent, '上下末尾');
  });
}
test('nested media rows can be reordered without dropping either source', () => {
  const a = media('a'), b = media('b'), e = editor([schema.node('blockquote', null, [schema.node('blockRow', null, [a, b])])]);
  moveBlock(e, find(e.state.doc, n => n === a), find(e.state.doc, n => n === b), 'right');
  assert.equal(e.state.doc.firstChild.firstChild.firstChild, b);
  assert.equal(e.state.doc.firstChild.firstChild.lastChild, a);
});
test('dropping on the source or at its existing boundary does not write a change', () => {
  const map = media(), e = editor([map, paragraph(text('正文'))]), doc = e.state.doc;
  assert.equal(moveBlockAt(e, 0, 0), false);
  assert.equal(moveBlockAt(e, 0, 1), false);
  assert.equal(moveBlock(e, 0, 1, 'before'), false);
  assert.ok(e.state.doc.eq(doc));
});
