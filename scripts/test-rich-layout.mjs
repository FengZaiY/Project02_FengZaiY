import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { encodeBlock } from '../src/core/rich-schema.mjs';

const root = path.resolve('artifacts/rich-layout'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const fixtures = [
  { v: 1, kind: 'diagram', label: '思维导图', source: 'mindmap\n  root((学习主题))\n    基础概念\n      定义\n      示例\n    实践\n      步骤\n      问题' },
  { v: 1, kind: 'diagram', label: '流程图', source: 'flowchart LR\n  A[收集] --> B[理解] --> C[整理]\n  B --> D[实践]' },
  { v: 1, kind: 'canvas', label: '画板', shapes: [{ id: 'shape1', type: 'rect', x: 20, y: 20, width: 200, height: 100, text: '画板内容', fill: '#daf1dd' }] }
];
const content = fixtures.map(block => `<figure data-ss-block="${encodeBlock(block).replaceAll('"', '&quot;')}" data-ss-layout='{"width":70,"height":null,"align":"left"}'><figcaption>${block.label}</figcaption></figure>`).join('<p>正文说明</p>');
const library = app.service.store.saveLibrary({ title: '尺寸验证' });
const note = app.service.store.write({ type: 'note', data: { title: '插入内容调整', domain: library.data.domain, content: `<p>正文起点</p>${content}<p>正文结尾</p>`, format: 'html' } });
let browser, page;
const errors = [], measurements = [];
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator(`[data-record="${note.id}"]`).click();
  const block = label => page.locator('.tiptap .rich-block').filter({ has: page.locator('figcaption', { hasText: new RegExp(`^${label}$`) }) });
  const map = block('思维导图');
  const html = () => page.locator('.tiptap').evaluate(el => el.editor.getHTML());
  const size = locator => locator.evaluate(el => {
    const media = el.querySelector('.rich-content > svg,.rich-content > img'), box = media.getBoundingClientRect();
    const frame = el.getBoundingClientRect(), host = el.querySelector('.rich-content');
    const ratio = media.viewBox ? media.viewBox.baseVal.width / media.viewBox.baseVal.height : media.naturalWidth / media.naturalHeight;
    return { width: box.width, height: box.height, ratio, frameWidth: frame.width, frameHeight: frame.height,
      overflow: host.scrollHeight > host.clientHeight + 1 || host.scrollWidth > host.clientWidth + 1 };
  });
  const fitted = async locator => {
    const result = await size(locator);
    assert.ok(result.width > 20 && result.height > 20);
    assert.ok(Math.abs(result.width / result.height - result.ratio) < .02, 'Rendered content must retain its proportions');
    assert.ok(Math.abs(result.frameWidth - result.width) < 2 && Math.abs(result.frameHeight - result.height) < 2, 'Handles must follow visible content');
    assert.equal(result.overflow, false, 'No hidden scrollable space around the content');
    return result;
  };
  const resize = async (locator, edge, dx, dy, cancel = false) => {
    const handle = locator.locator(`[data-resize-edge="${edge}"]`);
    await handle.scrollIntoViewIfNeeded(); const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await page.waitForFunction(() => document.querySelectorAll('.tiptap .block-aspect-media').length === 3);
  for (const [index, edge] of ['e', 'w', 'n', 's', 'nw', 'ne', 'sw', 'se'].entries()) {
    const before = await fitted(map), direction = index % 2 ? 1 : -1;
    await resize(map, edge, (edge.includes('w') ? -1 : 1) * direction * 18, (edge.includes('n') ? -1 : 1) * direction * 14);
    const after = await fitted(map);
    assert.ok(Math.abs(after.width - before.width) > 3, `${edge} must resize the actual mind map`);
    measurements.push({ edge, before, after });
  }
  const beforeCancel = await html();
  await resize(map, 'se', -25, -20, true);
  assert.equal(await html(), beforeCancel);
  await page.waitForTimeout(600);
  await resize(map, 'e', -40, 0);
  const resized = await html();
  await page.locator('.tiptap').press('Control+z');
  assert.equal(await html(), beforeCancel, 'Resize must undo as one document edit');
  await page.locator('.tiptap').press('Control+Shift+z');
  assert.equal(await html(), resized);
  await map.locator('[data-resize-edge=e]').press('ArrowLeft');
  assert.ok((await fitted(map)).width < measurements.at(-1).after.width - 30);
  for (const label of ['流程图', '画板']) {
    const target = block(label), before = await fitted(target);
    await resize(target, 's', 0, -18);
    assert.ok((await fitted(target)).width < before.width - 3, `${label} must resize vertically without whitespace`);
  }
  // A press starts the existing drag gesture; cancelling it must preserve the document.
  await map.scrollIntoViewIfNeeded();
  let box = await map.boundingBox();
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .45); await page.mouse.down();
  await page.locator('.block-drag-preview').waitFor();
  const beforeDrag = await html();
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await html(), beforeDrag);
  // Drop beside the next diagram, then return through undo.
  await map.scrollIntoViewIfNeeded(); box = await map.boundingBox();
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .45); await page.mouse.down();
  await page.locator('.block-drag-preview').waitFor();
  await block('流程图').scrollIntoViewIfNeeded();
  const targetBox = await block('流程图').boundingBox();
  await page.mouse.move(targetBox.x + targetBox.width - 12, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.locator('.tiptap .block-row').waitFor();
  assert.equal(await page.locator('.tiptap .block-row .rich-block').count(), 2);
  await fitted(map);
  await page.locator('.tiptap').press('Control+z');
  assert.equal(await page.locator('.tiptap .block-row').count(), 0);
  await map.locator('.rich-content').dblclick();
  await page.locator('.mm-topic').first().waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await html(), beforeDrag, 'Opening the mindmap editor must not change its body layout');
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  const saved = await html(), savedSize = await fitted(map);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.tiptap .block-aspect-media').length === 3);
  assert.equal(await html(), saved);
  assert.ok(Math.abs((await fitted(map)).width - savedSize.width) < 2);
  assert.deepEqual(await page.locator('.tiptap .rich-block').evaluateAll(els => els.map(el => JSON.parse(el.dataset.ssBlock))), fixtures, 'Resizing must not alter source data');
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.locator('#modal .prose .block-aspect-media').first().waitFor();
  await fitted(page.locator('#modal .prose .rich-block').first());
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await map.scrollIntoViewIfNeeded(); await map.locator('.rich-content').click();
    await fitted(map);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.notEqual(await map.locator('[data-resize-edge=se]').evaluate(el => getComputedStyle(el, '::after').content), 'none');
    assert.equal(await page.locator('.tiptap > p .block-resize-edge').count(), 0);
    await page.screenshot({ path: path.join(root, `layout-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, measurements, errors }, null, 2));
  console.log('PASS: mindmap eight-edge sizing, SVG/canvas proportions, cancellation, undo, keyboard, drag, double-click, save/reopen, history and responsive screenshots.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser?.close(); await app.close(); }
