import test from 'node:test';
import assert from 'node:assert/strict';
import { isMindmap, mindmapFromParsed, serializeMindmap, flattenMindmap, moveMindmap, layoutMindmap } from '../web/mindmap-model.js';

const parsed = (descr, children = []) => ({ descr, children });
const fixture = () => mindmapFromParsed('mindmap\n  root((中心))\n    a[概念]\n      b[定义]\n    c[实践]',
  parsed('中心', [parsed('概念', [parsed('定义')]), parsed('实践')]));

test('mindmap preserves original topic declarations and comments; view state is a Mermaid comment', () => {
  const model = fixture();
  model.root.children[0].collapsed = true; model.layout = 'right'; model.palette = 'quiet';
  const source = serializeMindmap(model);
  assert.match(source, /root\(\(中心\)\)/); assert.match(source, /b\[定义\]/);
  assert.match(source, /"collapsed":\["m1"\]/);
  const reread = mindmapFromParsed(source, parsed('中心', [parsed('概念', [parsed('定义')]), parsed('实践')]));
  assert.equal(reread.layout, 'right'); assert.equal(reread.palette, 'quiet'); assert.equal(reread.root.children[0].collapsed, true);
  assert.ok(isMindmap('%% retained comment\nmindmap\n root')); assert.equal(isMindmap('flowchart LR\nA-->B'), false);
});

test('mindmap moves preserve full subtrees and reject cycles and root moves', () => {
  const model = fixture();
  moveMindmap(model, 'm1', 'm3');
  assert.equal(model.root.children.length, 1);
  assert.equal(model.root.children[0].children[0].children[0].text, '定义');
  const snapshot = JSON.stringify(model);
  assert.throws(() => moveMindmap(model, 'm3', 'm2'), /下级/);
  assert.throws(() => moveMindmap(model, 'm0', 'm1'), /中心/);
  assert.equal(JSON.stringify(model), snapshot);
});

test('mindmap refuses lossy advanced conversions and bounds generated content', () => {
  assert.throws(() => mindmapFromParsed('mindmap\n root\n ::icon(fa fa-book)', parsed('root')), /特殊/);
  assert.throws(() => mindmapFromParsed('mindmap\n root\n unseen', parsed('root')), /多行/);
  assert.throws(() => mindmapFromParsed('mindmap\n root["`**text**`"]', parsed('text')), /特殊/);
  const model = fixture(); model.root.raw = null; model.root.text = 'A["B"] <标签> & 😀\n第二行';
  assert.match(serializeMindmap(model), /#91;/); assert.doesNotMatch(serializeMindmap(model), /<标签>/);
  model.root.text = ''; assert.throws(() => serializeMindmap(model), /主题文字/);
});

test('mindmap layout respects collapse, multiline dimensions and two-sided bounds', () => {
  const model = fixture(); model.root.children[0].text = '非常长的概念定义'.repeat(12);
  const layout = layoutMindmap(model);
  assert.equal(layout.nodes.length, 4); assert.equal(layout.edges.length, 3);
  assert.ok(layout.nodes.some(node => node.x < 0)); assert.ok(layout.nodes.some(node => node.x > 0));
  for (const node of layout.nodes) {
    assert.ok(node.x - node.width / 2 >= layout.left);
    assert.ok(node.y + node.height / 2 <= layout.top + layout.height);
    assert.ok(node.height >= node.lines.length * 22);
  }
  model.root.children[0].collapsed = true;
  assert.equal(layoutMindmap(model).nodes.length, 3);
  assert.equal(flattenMindmap(model.root).length, 4);
  model.layout = 'right'; assert.ok(layoutMindmap(model).nodes.every(node => node.x >= 0));
});

test('mindmap size and depth failures leave an attempted move intact', () => {
  const model = fixture();
  let parent = model.root;
  for (let depth = 1; depth <= 40; depth++) {
    const child = { id: `deep${depth}`, text: '层级', raw: null, collapsed: false, children: [] };
    parent.children.push(child); parent = child;
  }
  const snapshot = JSON.stringify(model);
  assert.throws(() => moveMindmap(model, 'm1', 'deep40'), /40/);
  assert.equal(JSON.stringify(model), snapshot);
  parent.children.push({ id: 'overflow', text: '层级', children: [] });
  assert.throws(() => flattenMindmap(model.root), /40/);
  const wide = fixture();
  wide.root.children = Array.from({ length: 500 }, (_, index) => ({ id: `n${index}`, text: '主题', children: [] }));
  assert.throws(() => serializeMindmap(wide), /500/);
  assert.throws(() => mindmapFromParsed('mindmap\nroot', parsed('字'.repeat(1001))), /1000/);
});
