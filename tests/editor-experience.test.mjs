import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schema } from '@tiptap/pm/model';
import { textMatches, diffBlocks, parseClipboardTable, quoteTsv } from '../web/editor-text.js';
import { importClipboardImage } from '../src/desktop/clipboard-import.mjs';
import { Service } from '../src/core/service.mjs';

test('document text matching crosses formatting and paragraphs without changing document positions', () => {
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} }, marks: { strong: {} } });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('原文'), schema.text('内容', [schema.mark('strong')])]),
    schema.node('paragraph', null, [schema.text('第二段原文内容')])
  ]);
  assert.deepEqual(textMatches(doc, '原文内容'), [{ from: 1, to: 5 }, { from: 10, to: 14 }]);
  assert.deepEqual(textMatches(doc, '内容\n第二段'), [{ from: 3, to: 10 }]);
  assert.deepEqual(textMatches(doc, '不存在'), []);
});
test('bounded structural diff keeps media payload and orders insertions/deletions', () => {
  const media = '<figure data-ss-block="identity"></figure>';
  const result = diffBlocks(['<p>旧</p>', media], ['<p>新</p>', media, '<p>尾</p>']);
  assert.deepEqual(result.filter(x => x.kind !== 'added').map(x => x.value), ['<p>旧</p>', media]);
  assert.deepEqual(result.filter(x => x.kind !== 'removed').map(x => x.value), ['<p>新</p>', media, '<p>尾</p>']);
  assert.equal(result.find(x => x.value === media).kind, 'same');
});
test('spreadsheet clipboard supports quoted cells, multiline text, empty trailing columns and limits', () => {
  assert.deepEqual(parseClipboardTable('A\tB\r\n"换\n行"\t"引""号"\r\n'), [['A', 'B'], ['换\n行', '引"号']]);
  assert.deepEqual(parseClipboardTable('x\t'), [['x', '']]);
  assert.equal(parseClipboardTable('x\ty\n'.repeat(201)), null);
  assert.equal(parseClipboardTable('"缺失\t引号'), null);
  assert.equal(quoteTsv('a\tb\n"c"'), '"a\tb\n""c"""');
});
test('desktop clipboard import confines temporary files and preserves the imported image', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-clipboard-'));
  const service = new Service(directory);
  try {
    const library = service.store.saveLibrary({ title: '剪贴板测试' });
    const data = new Uint8Array([137, 80, 78, 71]).buffer;
    const record = await importClipboardImage(service, { domain: library.id, mime: 'image/png', data });
    assert.equal(record.data.mime, 'image/png');
    assert.equal(fs.existsSync(service.store.assetLocation(record.id).path), true);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'clipboard-import')), []);
    await assert.rejects(importClipboardImage(service, { domain: library.id, mime: 'text/html', data }), /剪贴板/);
    await assert.rejects(importClipboardImage(service, { domain: 'missing', mime: 'image/png', data }), /知识库/);
    await assert.rejects(service.call('importClipboardImage', { domain: library.id, mime: 'image/png', data }), /Unsupported/);
  } finally { service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
