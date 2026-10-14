import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/document-flow');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '文档编辑验证' });
const layout = '{&quot;width&quot;:40,&quot;height&quot;:500,&quot;align&quot;:&quot;right&quot;}';
const box = content => `<section data-ss-container="true" data-ss-layout="${layout}">${content}</section>`;
const formula = JSON.stringify({ v: 1, kind: 'formula', source: 'x^2+y^2', label: '保留的公式' }).replaceAll('"', '&quot;');
const legacy = `<h2>连续文档</h2><div data-ss-row="true">${box('<p>第一段正文</p>')}${box('<p>第二段正文</p>')}${box('<p></p>')}</div>`
  + box(box('<p><strong>保留加粗</strong>与<a href="https://example.com/">参考链接</a></p>'))
  + box('<aside data-callout="note"><p>重点内容</p></aside>')
  + box('<table><tbody><tr><th><p>项目</p></th><th><p>说明</p></th></tr><tr><td><p>表格内容</p></td><td><p>自然增高</p></td></tr></tbody></table>')
  + `<div data-ss-row="true">${box('<p>混合排列的正文</p>')}<figure data-ss-block="${formula}"></figure></div><p>文档结尾</p>`;
const note = app.service.store.write({ type: 'note', data: { domain: library.id, title: '旧笔记连续编辑', format: 'html', content: legacy } });
let browser, page;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap .katex').waitFor();
  assert.equal(await page.locator('.tiptap .layout-block,.tiptap [data-ss-container],.tiptap .block-row').count(), 0);
  assert.deepEqual(await page.locator('.tiptap > p').allTextContents(), ['第一段正文', '第二段正文', '', '保留加粗与参考链接', '混合排列的正文', '文档结尾']);
  assert.equal(await page.locator('.tiptap > table,.tiptap > .tableWrapper table').count(), 1);
  assert.equal(await page.locator('.tiptap > aside').innerText(), '重点内容');
  assert.equal(await page.locator('.tiptap strong').innerText(), '保留加粗');
  assert.equal(await page.locator('.tiptap a').getAttribute('href'), 'https://example.com/');
  await page.waitForTimeout(1800);
  assert.equal(app.service.store.history(note.id).length, 1, 'Reading a legacy document must not save a conversion');
  assert.equal(app.service.store.get(note.id).data.content, legacy);
  await page.evaluate(() => { window.flowEditor = document.querySelector('.tiptap').editor; });

  // Enter and Backspace traverse former box boundaries, and undo restores the split.
  const first = page.locator('.tiptap > p').first();
  const settleSelection = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const key = async value => { await page.keyboard.press(value); await settleSelection(); };
  await first.click({ position: { x: 20, y: 12 } }); await settleSelection();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.state.selection.$from.parent.textContent), '第一段正文');
  await key('End');
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.state.selection.$from.parentOffset), 5);
  await key('Enter'); await page.keyboard.insertText('新段落');
  assert.equal(await page.locator('.tiptap > p').nth(1).innerText(), '新段落');
  // Let the typing undo group close before testing a separate join operation.
  await page.waitForTimeout(550);
  await key('Home'); await key('Backspace');
  assert.equal(await first.innerText(), '第一段正文新段落');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await settleSelection();
  assert.equal(await page.locator('.tiptap > p').nth(1).innerText(), '新段落');
  const second = page.locator('.tiptap > p').filter({ hasText: /^第二段正文$/ });
  await second.click({ position: { x: 20, y: 12 } }); await settleSelection(); await key('Home'); await key('Backspace');
  assert.equal(await page.locator('.tiptap > p').nth(1).innerText(), '新段落第二段正文');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await settleSelection();
  assert.equal(await second.count(), 1);
  await second.click({ position: { x: 20, y: 12 } }); await settleSelection(); await key('Home');
  await key('Shift+ArrowUp'); await key('Shift+Home');
  const selection = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor, { from, to } = editor.state.selection;
    return { from, to, text: editor.state.doc.textBetween(from, to, '\n') };
  });
  assert.ok(selection.to > selection.from && selection.text.includes('新段落'), 'Selection must cross former boxes');
  await key('ArrowRight');

  // Pasting historical HTML uses the same conversion as initial loading.
  await page.locator('.tiptap > p').last().click({ position: { x: 20, y: 12 } }); await settleSelection(); await key('End');
  await page.locator('.tiptap').evaluate((el, html) => {
    const transfer = new DataTransfer(); transfer.setData('text/html', html);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, `<div data-ss-row="true">${box('<p>粘贴的第一段</p>')}${box('<p>粘贴的第二段</p>')}</div>`);
  assert.match(await page.locator('.tiptap').innerText(), /粘贴的第一段/);
  assert.equal(await page.locator('.tiptap .layout-block,.tiptap [data-ss-container]').count(), 0);
  await page.locator('.tiptap > p').last().click({ position: { x: 20, y: 12 } }); await settleSelection(); await key('End'); await key('Enter');
  await page.keyboard.insertText('自然换行与高度扩展。'.repeat(130));
  const paragraph = page.locator('.tiptap > p').last();
  assert.ok(await paragraph.evaluate(el => el.clientHeight > 400));
  assert.equal(await paragraph.evaluate(el => getComputedStyle(el).overflowY), 'visible');
  assert.equal(await paragraph.locator('button').count(), 0);
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  assert.equal(await page.evaluate(() => window.flowEditor === document.querySelector('.tiptap').editor), true);
  const saved = app.service.store.get(note.id);
  assert.doesNotMatch(saved.data.content, /data-ss-container/);
  assert.match(saved.data.content, /表格内容/);
  assert.match(saved.data.content, /data-ss-block/);
  assert.ok(app.service.store.history(note.id).some(event => event.data.content === legacy), 'Original serialized layout remains in history');
  await page.reload(); await page.locator('.tiptap .katex').waitFor();
  assert.equal(await page.locator('.tiptap .layout-block').count(), 0);
  assert.match(await page.locator('.tiptap').innerText(), /粘贴的第二段/);
  for (const [width, height] of [[1480, 940], [1220, 892], [931, 672], [600, 900]]) {
    await page.setViewportSize({ width, height });
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: path.join(root, `document-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    assert.ok(await page.locator('.editor-scroll').evaluate(el => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 3));
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.locator('#modal .history-browser').waitFor();
  assert.equal(await page.locator('#modal .layout-block,#modal [data-ss-container]').count(), 0);
  assert.ok(await page.locator('#modal .prose table').count() >= 2);
  assert.ok(await page.locator('#modal .katex').count() >= 2);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, legacyPreserved: true, errors }, null, 2));
  console.log('PASS: continuous text, legacy unwrapping, native editing/selection/undo, paste, history, rich content and responsive scrolling.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app.close();
}
