import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/editor-interactions'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '编辑交互' });
const note = app.service.store.write({ type: 'note', data: { title: '自动保存验证', domain: library.id, content: '<p>正文起点</p>', format: 'html' } });
const other = app.service.store.write({ type: 'note', data: { title: '另一篇', domain: library.id, content: '<p>保留原文</p>', format: 'html' } });
const wait = async predicate => {
  const until = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for stored content'); await new Promise(resolve => setTimeout(resolve, 80)); }
};
let browser, page; const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  await page.evaluate(() => { window.testEditor = document.querySelector('.tiptap').editor; });
  await page.locator('#note-title').fill('自动保存后的标题');
  await wait(() => app.service.store.get(note.id).data.title === '自动保存后的标题');
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  assert.equal(await page.evaluate(() => window.testEditor === document.querySelector('.tiptap').editor), true);
  const versionCount = app.service.store.history(note.id).length;
  await page.locator('[data-action=save]').click();
  assert.equal(app.service.store.history(note.id).length, versionCount, 'Unchanged manual save created a duplicate revision');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 120;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3998a6'; ctx.fillRect(0, 0, 200, 120); ctx.fillStyle = '#ffdc6c'; ctx.fillRect(30, 20, 100, 70);
    return Array.from(Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0)));
  });
  const video = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    canvas.style.cssText = 'position:fixed;top:0;right:0;z-index:9999'; document.body.append(canvas);
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0], chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const end = new Promise(resolve => recorder.onstop = resolve); recorder.start();
    for (let i = 0; i < 8; i++) {
      canvas.getContext('2d').fillStyle = i % 2 ? '#d77385' : '#39848d'; canvas.getContext('2d').fillRect(0, 0, 160, 90);
      track.requestFrame(); await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await end; stream.getTracks().forEach(track => track.stop()); canvas.remove();
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  assert.ok(video.length > 200, 'Video fixture must contain encoded frames');
  const drop = async files => {
    await page.locator('.tiptap').evaluate((element, files) => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.x + 15, clientY: box.y + 15 }));
    }, files);
  };
  const hold = async block => {
    await block.scrollIntoViewIfNeeded();
    const box = await block.boundingBox(), area = await page.locator('.editor-scroll').boundingBox();
    const x = box.x + box.width * .4, y = Math.max(area.y + 15, Math.min(area.y + area.height - 20, box.y + box.height * .45));
    await page.mouse.move(x, y); await page.mouse.down();
    await page.waitForSelector('.block-drag-preview', { timeout: 3000 });
  };
  const drag = async (block, target, side, screenshot = false) => {
    await hold(block); await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const x = side === 'left' ? box.x + 8 : side === 'right' ? box.x + box.width - 8 : box.x + box.width / 2;
    const y = side === 'before' ? box.y + 2 : side === 'after' ? box.y + box.height - 2 : box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 6 });
    await page.locator('.block-drop-marker:not([hidden])').waitFor();
    if (screenshot) await page.screenshot({ path: path.join(root, 'long-press-drag.png') });
    await page.mouse.up();
    assert.equal(await page.locator('.block-drag-preview').count(), 0);
  };
  const resize = async (block, edge, dx, dy, cancel = false) => {
    const handle = block.locator(`[data-resize-edge="${edge}"]`);
    await handle.scrollIntoViewIfNeeded(); const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drop([{ name: '第一张.png', type: 'image/png', bytes: image }, { name: '第二张.png', type: 'image/png', bytes: image },
    { name: '原资料.txt', type: 'text/plain', bytes: [...Buffer.from('source document')] }, { name: '短片.webm', type: 'video/webm', bytes: video }]);
  await wait(() => app.service.store.get(note.id).data.assetIds?.length === 3);
  await page.waitForFunction(() => document.querySelector('.tiptap video')?.readyState >= 1);
  assert.equal(await page.locator('.tiptap img').count(), 2);
  assert.equal(await page.locator('.tiptap a[href^="studyself://asset"]').innerText(), '原资料.txt');
  await page.route('**/upload?*', async route => {
    if (decodeURIComponent(route.request().headers()['x-filename']) === '失败.txt') await route.fulfill({ status: 400, json: { error: { message: '测试导入失败' } } });
    else await route.continue();
  });
  await drop([{ name: '失败.txt', type: 'text/plain', bytes: [1] }, { name: '保留.txt', type: 'text/plain', bytes: [2] }]);
  await wait(() => app.service.store.get(note.id).data.assetIds?.length === 4);
  assert.equal(await page.locator('.tiptap a', { hasText: '失败.txt' }).count(), 0);
  assert.equal(await page.locator('.tiptap a', { hasText: '保留.txt' }).count(), 1);
  await page.unroute('**/upload?*');
  const videoElement = page.locator('.tiptap video'), videoBlock = page.locator('.tiptap .rich-block').filter({ has: page.locator('video') });
  const videoSize = await videoBlock.boundingBox();
  await resize(videoBlock, 's', 0, 220 - videoSize.height);
  await videoElement.evaluate(el => { el.loop = true; window.testPlayCount = 0; el.addEventListener('play', () => window.testPlayCount++); });
  await videoElement.scrollIntoViewIfNeeded();
  const videoBounds = await videoElement.boundingBox();
  await videoElement.click({ position: { x: 24, y: videoBounds.height - 48 } });
  await page.waitForFunction(() => window.testPlayCount > 0);
  await videoElement.evaluate(el => el.pause());
  const videoBox = await videoElement.boundingBox();
  await page.mouse.move(videoBox.x + 24, videoBox.y + videoBox.height - 48); await page.mouse.down();
  await page.waitForTimeout(1100); assert.equal(await page.locator('.block-drag-preview').count(), 0, 'Video controls must not start a block drag');
  await page.mouse.up(); await videoElement.evaluate(el => el.pause());
  const imageBlock = page.locator('.tiptap .rich-block').first();
  assert.equal(await page.getByRole('button', { name: '横向排列', exact: true }).count(), 0);
  assert.equal(await page.locator('.block-controls,.block-footer').count(), 0);
  const initialBox = await imageBlock.boundingBox();
  await resize(imageBlock, 'se', -160, 300 - initialBox.height);
  const resizedEdges = [];
  for (const edge of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) {
    const before = await imageBlock.evaluate(el => ({ w: el.style.getPropertyValue('--block-width'), h: el.style.getPropertyValue('--block-height') }));
    await resize(imageBlock, edge, edge.includes('w') ? 18 : edge.includes('e') ? -18 : 0, edge.includes('n') ? 7 : edge.includes('s') ? -7 : 0);
    const after = await imageBlock.evaluate(el => ({ w: el.style.getPropertyValue('--block-width'), h: el.style.getPropertyValue('--block-height') }));
    if (/[ew]/.test(edge)) assert.notEqual(after.w, before.w, `${edge} did not resize width`);
    if (/[ns]/.test(edge)) assert.notEqual(after.h, before.h, `${edge} did not resize height`);
    resizedEdges.push(edge);
  }
  const secondImage = page.locator('.tiptap .rich-block').nth(1), secondSize = await secondImage.boundingBox();
  await resize(secondImage, 's', 0, 260 - secondSize.height);
  const contentBeforeCancel = await page.locator('.tiptap').evaluate(el => el.editor.getHTML());
  await resize(imageBlock, 'e', -30, 0, true);
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.getHTML()), contentBeforeCancel);
  await imageBlock.scrollIntoViewIfNeeded();
  // Keep the pre-hold movement in the browser event loop: protocol round trips can
  // consume the 150 ms margin and accidentally turn this cancellation test into a hold.
  await imageBlock.evaluate(async element => {
    const box = element.getBoundingClientRect(), pointerId = 91;
    const event = (type, dx = 0) => new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId, button: 0, clientX: box.x + 40 + dx, clientY: box.y + 35 });
    element.dispatchEvent(event('pointerdown'));
    await new Promise(resolve => setTimeout(resolve, 350));
    if (document.querySelector('.block-drag-preview')) throw new Error('Short press started a drag before 500 ms');
    document.dispatchEvent(event('pointermove', 15));
    await new Promise(resolve => setTimeout(resolve, 800));
    if (document.querySelector('.block-drag-preview')) throw new Error('Movement before the hold failed to cancel');
    document.dispatchEvent(event('pointerup', 15));
  });
  await hold(imageBlock); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.block-drag-preview').count(), 0);
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.getHTML()), contentBeforeCancel);
  await hold(imageBlock);
  const scrollArea = await page.locator('.editor-scroll').boundingBox();
  const scrollBefore = await page.locator('.editor-scroll').evaluate(el => el.scrollTop);
  await page.mouse.move(scrollArea.x + scrollArea.width / 2, scrollArea.y + scrollArea.height - 12);
  await page.waitForFunction(value => document.querySelector('.editor-scroll').scrollTop > value + 15, scrollBefore);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.tiptap').evaluate(el => el.editor.getHTML()), contentBeforeCancel);
  await drag(secondImage, imageBlock, 'right', true);
  await page.locator('.tiptap .block-row').waitFor();
  assert.equal(await page.locator('.tiptap .block-row>.rich-block').count(), 2);
  const first = page.locator('.tiptap .block-row>.rich-block').first(), second = page.locator('.tiptap .block-row>.rich-block').nth(1);
  let firstBox = await first.boundingBox(), secondBox = await second.boundingBox();
  assert.ok(secondBox.x > firstBox.x && Math.abs(secondBox.y - firstBox.y) < 2);
  await drag(first, second, 'after');
  assert.equal(await page.locator('.tiptap .block-row').count(), 0);
  const layout = await imageBlock.evaluate(el => el.style.getPropertyValue('--block-width'));
  assert.ok(parseFloat(layout) <= 100 && parseFloat(layout) >= 15);
  await drag(page.locator('.tiptap .rich-block').nth(1), imageBlock, 'right');
  await page.locator('.tiptap .block-row').waitFor();
  // Holding the content itself changes order inside the row.
  const rowBlocks = page.locator('.tiptap .block-row>.rich-block');
  const beforeOrder = await rowBlocks.evaluateAll(nodes => nodes.map(n => JSON.parse(n.dataset.ssBlock).label));
  await drag(rowBlocks.first(), rowBlocks.nth(1), 'right');
  const afterOrder = await rowBlocks.evaluateAll(nodes => nodes.map(n => JSON.parse(n.dataset.ssBlock).label));
  assert.deepEqual(afterOrder, [...beforeOrder].reverse(), 'Mouse drag did not reorder blocks');
  await page.locator('[data-action=save]').click();
  await wait(() => app.service.store.get(note.id).data.content.includes('data-ss-row'));
  assert.match(app.service.store.get(note.id).data.content, /data-ss-layout/);
  await page.reload(); await page.locator('.tiptap .block-row').waitFor();
  assert.deepEqual(await page.locator('.tiptap .block-row>.rich-block').evaluateAll(nodes => nodes.map(n => JSON.parse(n.dataset.ssBlock).label)), afterOrder);
  assert.equal(await page.locator('.tiptap .rich-block').count(), 3);
  assert.equal(app.service.store.get(note.id).data.assetIds.length, 4);
  for (const [width, height] of [[1480, 940], [931, 672], [600, 900]]) {
    await page.setViewportSize({ width, height }); await page.locator('.editor-scroll').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: path.join(root, `layout-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const overlaps = await page.locator('.tiptap .block-row').evaluate(row => {
      const [a, b] = [...row.children].map(el => el.getBoundingClientRect());
      return a.right > b.left + 1 && a.bottom > b.top + 1;
    });
    assert.equal(overlaps, false);
    assert.equal(await page.locator('.tiptap .rich-block').first().evaluate(el => {
      const box = el.getBoundingClientRect(), caption = el.querySelector('figcaption').getBoundingClientRect();
      return getComputedStyle(el).borderTopWidth === '0px' && caption.top >= box.top && caption.bottom <= box.bottom && caption.right <= box.right;
    }), true, 'Content must be unframed with an internal caption');
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    assert.equal(await page.locator('.editor-scroll').evaluate(el => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 3), true);
  }
  await page.setViewportSize({ width: 1480, height: 940 });
  // File links are normal paragraphs, with no resize box or long-press gesture.
  assert.equal(await page.locator('.tiptap .layout-block').count(), 0);
  const editableParagraph = page.locator('.tiptap > p').filter({ hasText: '保留.txt' });
  await editableParagraph.scrollIntoViewIfNeeded();
  const editableBox = await editableParagraph.boundingBox();
  await editableParagraph.click({ position: { x: editableBox.width - 15, y: editableBox.height / 2 } });
  await page.keyboard.press('End'); await page.keyboard.insertText(' 补充说明');
  assert.match(await editableParagraph.innerText(), /补充说明/);
  const holdBox = await editableParagraph.boundingBox();
  await page.mouse.move(holdBox.x + holdBox.width - 10, holdBox.y + holdBox.height / 2); await page.mouse.down();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.block-drag-preview').count(), 0);
  await page.mouse.up();
  assert.equal(await editableParagraph.locator('button').count(), 0);
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const historyLink = page.locator('#modal .prose a').filter({ hasText: '保留.txt' }).first();
  assert.equal(await historyLink.getAttribute('href'), await editableParagraph.locator('a').getAttribute('href'));
  assert.equal(await page.locator('#modal .layout-block').count(), 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  // Switching tabs must save the original note, not the newly selected one.
  await page.locator('#note-title').fill('切换后仍保存到原笔记');
  await page.locator(`[data-record="${other.id}"]`).click();
  await wait(() => app.service.store.get(note.id).data.title === '切换后仍保存到原笔记');
  assert.equal(app.service.store.get(other.id).data.title, '另一篇');
  await page.locator('.work-tab', { hasText: '切换后仍保存到原笔记' }).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '切换后仍保存到原笔记');
  // Delay a response while typing again; both versions must retain the right base.
  let release, intercepted, delayed = false;
  const entered = new Promise(resolve => intercepted = resolve), gate = new Promise(resolve => release = resolve);
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === note.id && !delayed) {
      delayed = true; const response = await route.fetch(); intercepted(); await gate; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('#note-title').fill('第一轮保存');
  await Promise.race([entered, page.waitForTimeout(15000).then(() => { throw new Error('Delayed save was not requested'); })]);
  await page.locator('#note-title').fill('保存期间的新输入');
  release();
  await wait(() => app.service.store.get(note.id).data.title === '保存期间的新输入');
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  assert.equal(await page.locator('#note-title').inputValue(), '保存期间的新输入');
  await page.unroute('**/api');
  // A failed request pauses; an explicit retry succeeds without replacing the editor.
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'save') await route.fulfill({ json: { error: { code: 'TEST_FAILURE', message: '测试写入失败' } } });
    else await route.continue();
  });
  await page.locator('#note-title').fill('失败后重试');
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'error');
  assert.equal(await page.locator('#note-title').inputValue(), '失败后重试');
  await page.unroute('**/api'); await page.locator('[data-action=save]').click();
  await wait(() => app.service.store.get(note.id).data.title === '失败后重试');
  await page.locator('#note-title').fill('保留冲突草稿');
  const latest = app.service.store.get(note.id);
  app.service.store.write({ id: note.id, type: 'note', parents: latest.heads, data: { ...latest.data, title: '外部更新' } });
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'conflict');
  assert.equal(app.service.store.get(note.id).data.title, '外部更新');
  assert.equal(await page.locator('#note-title').inputValue(), '保留冲突草稿');
  assert.equal(await page.locator('#modal').isVisible(), false, 'Autosave must not open a branch confirmation');
  await page.locator('[data-action=save]').click(); await page.locator('[data-cancel]').click();
  assert.equal(app.service.store.get(note.id).conflict, false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, imported: 5, layout, beforeOrder, afterOrder, resizedEdges, longPress: true, cancellation: true, errors }, null, 2));
  console.log('PASS: local files, borderless content, half-second hold/reorder, eight resize edges, cancellation, saved layout/history, autosave and conflict pause.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error('Page errors:', errors); throw error;
} finally { await browser?.close(); await app.close(); }
