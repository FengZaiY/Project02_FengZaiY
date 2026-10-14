import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { encodeBlock } from '../src/core/rich-schema.mjs';

const root = path.resolve('artifacts/block-line-drag'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '行间拖动验证' });
const payload = { v: 1, kind: 'diagram', label: '思维导图', source: 'mindmap\n  root((学习主题))\n    基础\n    实践' };
const figure = `<figure data-ss-block="${encodeBlock(payload).replaceAll('"', '&quot;')}" data-ss-layout='{"width":65,"height":null,"align":"left"}'><figcaption>思维导图</figcaption></figure>`;
const lines = '<p><strong>第一行保留加粗</strong><br>第二行普通文字<br><a href="https://example.com">第三行保留链接</a><br>第四行原文</p>';
const fixtures = [
  { name: '段内换行向下', content: `${figure}${lines}`, needle: '第三行', before: '第一行保留加粗第二行普通文字', after: '第三行保留链接第四行原文' },
  { name: '行尾下方', content: `${figure}${lines}`, needle: '第二行', afterLine: true, before: '第一行保留加粗第二行普通文字', after: '第三行保留链接第四行原文' },
  { name: '段内换行向上', content: `${lines}${figure}`, needle: '第二行', before: '第一行保留加粗', after: '第二行普通文字第三行保留链接第四行原文' },
  { name: '列表内', content: `${figure}<ul><li>${lines}</li></ul>`, needle: '第三行', parent: 'LI' },
  { name: '引用内', content: `${figure}<blockquote>${lines}</blockquote>`, needle: '第三行', parent: 'BLOCKQUOTE' },
  { name: '表格内', content: `${figure}<table><tbody><tr><td>${lines}</td><td><p>其他单元格</p></td></tr></tbody></table>`, needle: '第三行', parent: 'TD' },
  { name: '自动折行', content: `${figure}<p>${'自动折行的正文应完整保留，导图插入时不丢失任何一个字符。'.repeat(12)}</p>`, soft: true }
];
const records = fixtures.map(f => app.service.store.write({ type: 'note', data: { title: f.name, domain: library.data.domain, format: 'html', content: `<p>开头</p>${f.content}<p>结尾</p>` } }));
let browser, page; const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message)); await page.goto(app.url);
  const html = () => page.locator('.tiptap').evaluate(el => el.editor.getHTML());
  const text = () => page.locator('.tiptap').evaluate(el => el.editor.state.doc.textContent);
  const source = page.locator('.tiptap .rich-block');
  const start = async () => {
    await source.scrollIntoViewIfNeeded(); const box = await source.boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .5); await page.mouse.down();
    await page.locator('.block-drag-preview').waitFor();
  };
  const point = async fixture => {
    const paragraph = page.locator('.tiptap p').filter({ hasText: fixture.soft ? '自动折行' : fixture.needle }).first();
    await paragraph.scrollIntoViewIfNeeded();
    return paragraph.evaluate((el, f) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (walker.nextNode()) {
        if (f.soft || walker.currentNode.textContent.startsWith(f.needle)) { node = walker.currentNode; break; }
      }
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()], rect = rects[f.soft ? 2 : 0];
      if (!rect) throw new Error('Missing visible target line');
      let offset = 0;
      if (f.soft) {
        for (; offset < node.length; offset++) {
          range.setStart(node, offset); range.setEnd(node, offset + 1);
          if (range.getBoundingClientRect().top >= rect.top - 1) break;
        }
      }
      return { x: rect.left + 20, y: f.afterLine ? rect.bottom - 2 : rect.top + 2, offset };
    }, fixture);
  };
  for (const [index, fixture] of fixtures.entries()) {
    await page.locator(`[data-record="${records[index].id}"]`).click();
    await source.locator('svg.mindmap-preview').waitFor();
    const original = await html(), originalText = await text();
    await start();
    const target = await point(fixture);
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.locator('.block-drop-marker:not([hidden])').waitFor();
    if (index === 0) await page.screenshot({ path: path.join(root, 'line-target.png') });
    await page.mouse.up();
    const result = await source.evaluate(el => ({ parent: el.parentElement.tagName,
      before: el.previousElementSibling?.textContent, after: el.nextElementSibling?.textContent,
      beforeBreak: el.previousElementSibling?.lastChild?.nodeName,
      afterBreak: el.nextElementSibling?.firstChild?.nodeName, payload: JSON.parse(el.dataset.ssBlock) }));
    assert.equal(await text(), originalText, fixture.name + ': text lost');
    assert.deepEqual(result.payload, payload);
    if (fixture.parent) assert.equal(result.parent, fixture.parent, fixture.name);
    if (fixture.before) { assert.equal(result.before, fixture.before); assert.equal(result.after, fixture.after); }
    if (fixture.soft) assert.equal(result.before.length, target.offset, 'Drop must split at the visible wrapped line boundary');
    assert.notEqual(await html(), original);
    if (!fixture.soft) {
      assert.equal(await page.locator('.tiptap strong', { hasText: '第一行' }).count(), 1);
      assert.equal(await page.locator('.tiptap a[href="https://example.com"]').count(), 1);
      assert.notEqual(result.beforeBreak, 'BR'); assert.notEqual(result.afterBreak, 'BR');
    }
    const moved = await html();
    await page.locator('.tiptap').press('Control+z'); assert.equal(await html(), original, fixture.name + ': undo');
    await page.locator('.tiptap').press('Control+Shift+z'); assert.equal(await html(), moved);
    // Moving an already nested media block again must also work.
    if (fixture.parent) {
      await start();
      const last = await page.locator('.tiptap > p').filter({ hasText: '结尾' }).boundingBox();
      await page.mouse.move(last.x + 30, last.y + last.height - 2, { steps: 10 }); await page.mouse.up();
      assert.equal(await source.evaluate(el => el.parentElement.classList.contains('tiptap')), true);
      assert.equal(await text(), originalText);
    }
    await page.locator('[data-action=save]').click();
    await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
    const saved = await html(); await page.reload(); await source.locator('svg.mindmap-preview').waitFor();
    assert.equal(await html(), saved);
  }
  // Cancel a line-level drop without touching the paragraph.
  await page.locator(`[data-record="${records[0].id}"]`).click(); await source.locator('svg.mindmap-preview').waitFor();
  const beforeCancel = await html(); await start(); const target = await point({ needle: '第三行' });
  await page.mouse.move(target.x, target.y); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await html(), beforeCancel);
  assert.equal(await source.evaluate(el => getComputedStyle(el).outlineStyle), 'none', 'Cancelling a drag must not leave a framed editing area');
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 }); await source.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `result-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: hard-break and soft-wrap line drops, forward/backward moves, nested list/quote/table, text/marks preservation, undo/redo, cancel, repeat drag and save/reload.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser?.close(); await app.close(); }
