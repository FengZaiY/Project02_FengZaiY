import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { textCodePaste } from '../web/code-paste.js';

const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textOf).join('');
const codes = html => {
  const result = [];
  const visit = node => { if (node.tagName === 'code') result.push(textOf(node)); else (node.childNodes || []).forEach(visit); };
  visit(parseFragment(html)); return result;
};

test('plain directory trees preserve indentation, tabs and surrounding text', () => {
  const tree = '工作区/\n├─ 资料/\n│\t└─ 说明.txt\n└─ 笔记/';
  const html = textCodePaste('前面的说明\n' + tree + '\n后面的说明');
  assert.deepEqual(codes(html), [tree]);
  assert.ok(html.startsWith('<p>前面的说明</p>'));
  assert.ok(html.endsWith('<p>后面的说明</p>'));
  const ascii = 'C:\\work\r\n|-- a.txt\r\n`-- b.txt';
  assert.deepEqual(codes(textCodePaste(ascii)), [ascii.replaceAll('\r\n', '\n')]);
});

test('Markdown fences use the existing parser for languages, multiple blocks and literal markup', () => {
  const html = textCodePaste('# 说明\n\n```python\n  print("ok")\n```\n\n~~~text\n<script>not executable</script>\n~~~');
  assert.deepEqual(codes(html), ['  print("ok")\n', '<script>not executable</script>\n']);
  assert.match(html, /language-python/);
  assert.ok(!html.includes('<script>'));
});

test('ordinary text, lists, spreadsheets and isolated symbols are not guessed as code', () => {
  for (const text of ['普通正文\n另一段', '姓名\t分数\n甲\t80', '- 第一项\n- 第二项', '单独提到 ├─ 和 └─', '├─ 只有一个分支', '    普通缩进\n    第二行', 'const x = 1;']) {
    assert.equal(textCodePaste(text), null, text);
  }
});

test('tree labels are escaped and separate trees do not absorb intervening paragraphs', () => {
  const one = 'one/\n├─ <img src=x>\n└─ &file';
  const two = 'two/\n├─ a\n└─ b';
  const html = textCodePaste(one + '\n说明\n' + two);
  assert.deepEqual(codes(html), [one, two]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<p>说明</p>'));
});
