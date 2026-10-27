import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/attachment-drag');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page;
const errors = [];
try {
  clearInterval(app.service.timer);
  const store = app.service.store;
  const library = store.saveLibrary({ title: '附件拖拽验证' });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  const media = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    canvas.style.cssText = 'position:fixed;top:0;right:0;z-index:9999';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#327c82'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#ffde80'; ctx.fillRect(60, 40, 200, 100);
    const image = Array.from(Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0)));
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0], chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const ended = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#b85271' : '#3c8e85'; ctx.fillRect(0, 0, 320, 180);
      track.requestFrame(); await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await ended;
    stream.getTracks().forEach(track => track.stop()); canvas.remove();
    return { image, video: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
  });
  const create = async (name, bytes) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.from(bytes));
    return app.service.call('assetImport', { path: file, domain: library.id });
  };
  const text = await create('课程讲义.txt', Buffer.from('原附件中的讲义内容'));
  const image = await create('课程图片.png', media.image);
  const video = await create('课程短片.webm', media.video);
  const ids = [text.id, image.id, video.id];
  const originalAssets = ids.map(id => ({ id, heads: store.get(id).heads, hash: store.get(id).data.sha256 }));
  const note = store.write({ type: 'note', data: { title: '附件拖入正文', domain: library.id, assetIds: ids,
    format: 'html', content: '<p>第一段文字保持不变</p><p>第二段用于插入附件</p><p>最后一段继续编辑</p>' } });
  const other = store.write({ type: 'note', data: { title: '另一篇笔记', domain: library.id, format: 'html', content: '<p>这篇正文保持不变</p>' } });
  const empty = store.write({ type: 'note', data: { title: '空白笔记', domain: library.id, format: 'html', content: '', assetIds: [image.id] } });
  await page.reload();
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.getByRole('button', { name: '原附件', exact: true }).click();
  const source = id => page.locator(`[data-preview-asset="${id}"]`);
  const body = page.locator('.tiptap');
  const saved = () => page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  const html = () => body.evaluate(el => el.editor.getHTML());
  const sameEditor = async () => assert.equal(await page.evaluate(() => window.dragEditor === document.querySelector('.tiptap')), true);
  await source(text.id).waitFor();
  await page.evaluate(() => { window.dragEditor = document.querySelector('.tiptap'); });
  const beginDrag = async (id, target = body.locator('p', { hasText: '第二段用于插入附件' })) => {
    await source(id).scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const s = await source(id).boundingBox(), t = await target.boundingBox();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 12, s.y + s.height / 2, { steps: 3 });
    await page.mouse.move(t.x + 2, t.y + Math.min(12, t.height / 2), { steps: 12 });
    await page.mouse.move(t.x + 3, t.y + Math.min(12, t.height / 2));
    await page.locator('.attachment-drop-marker').waitFor();
  };
  const drag = async (id, target) => { await beginDrag(id, target); await page.mouse.up(); };
  const link = body.locator(`a[href="fengzaiy://asset/${text.id}"]`);
  await source(text.id).click();
  await page.locator('#source-preview .text-preview').waitFor();
  assert.match(await page.locator('#source-preview').innerText(), /原附件中的讲义内容/);
  await source(video.id).click();
  await page.locator('#source-preview video').evaluate(async el => {
    window.closedPreviewVideo = el; el.muted = true; await el.play();
  });
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.equal(await page.evaluate(() => window.closedPreviewVideo.paused
    && !window.closedPreviewVideo.hasAttribute('src') && !window.closedPreviewVideo.isConnected), true);
  await source(image.id).click();
  await page.locator('#source-preview img').evaluate(el => el.decode());
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.equal(await page.locator('#source-preview').isVisible(), false);
  await sameEditor();
  await source(text.id).click(); await page.locator('#source-preview .text-preview').waitFor();
  const original = await html();
  await body.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 8 }));
  await beginDrag(text.id);
  await page.screenshot({ path: path.join(root, 'drop-position.png') });
  await page.mouse.up();
  await link.waitFor();
  assert.match(await body.innerText(), /第一段文字保持不变/);
  assert.match(await body.innerText(), /第一段文字保持不变[\s\S]*课程讲义.txt[\s\S]*第二段用于插入附件/);
  await sameEditor();
  await body.press('Control+z');
  assert.equal(await html(), original, 'Undo must restore the original body including selected text');
  await body.press('Control+Shift+z'); await link.waitFor(); await saved();
  await link.click();
  await page.locator('#source-preview .text-preview').waitFor();
  await sameEditor();

  const beforeCancel = await html();
  await beginDrag(text.id);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.attachment-drop-marker').count(), 0);
  assert.equal(await html(), beforeCancel);
  await body.evaluate(el => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-fengzaiy-attachment', 'forged');
    transfer.setData('text/html', '<p>伪造拖拽内容</p>');
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.x + 5, clientY: rect.y + 5 }));
  });
  assert.equal(await html(), beforeCancel, 'External forged attachment payload must not insert anything');
  await drag(text.id);
  await page.waitForFunction(id => document.querySelectorAll(`.tiptap a[href="fengzaiy://asset/${id}"]`).length === 2, text.id);
  await drag(image.id);
  await page.waitForFunction(() => document.querySelector('.tiptap img')?.naturalWidth === 320);
  await drag(video.id);
  await page.waitForFunction(() => document.querySelector('.tiptap video')?.readyState >= 1);
  await body.locator('video').evaluate(async el => { await el.play(); el.pause(); });
  await saved();
  assert.equal(store.list({ type: 'asset' }).length, 3, 'Dragging/repeating a reference must not reimport assets');
  assert.deepEqual(ids.map(id => ({ id, heads: store.get(id).heads, hash: store.get(id).data.sha256 })), originalAssets);
  for (const id of ids) assert.equal(createHash('sha256').update(fs.readFileSync(store.assetLocation(id).path)).digest('hex'), store.get(id).data.sha256);
  assert.deepEqual(new Set(store.get(note.id).data.assetIds), new Set(ids));
  assert.ok(!store.get(note.id).data.content.includes(root), 'Body must not contain local paths');
  const rich = await html();
  await page.reload(); await body.waitFor(); await source(text.id).waitFor();
  assert.equal(await html(), rich, 'Autosaved dragged content must survive reload');
  await page.evaluate(() => { window.dragEditor = document.querySelector('.tiptap'); });
  await beginDrag(text.id, body.locator('p', { hasText: '第一段文字保持不变' }));
  const area = await page.locator('.editor-scroll').boundingBox();
  const scrollBefore = await page.locator('.editor-scroll').evaluate(el => el.scrollTop);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height - 12, { steps: 5 });
  await page.waitForFunction(before => document.querySelector('.editor-scroll').scrollTop > before + 20, scrollBefore);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await html(), rich, 'Scrolling a drag then cancelling must not modify the note');
  assert.equal(await page.locator('.attachment-drop-marker').count(), 0);

  // Metadata checks are asynchronous; keep the original drop anchor mapped through new input.
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.method === 'record' && request.input.id === text.id) { reached(); await gate; }
    await route.continue();
  });
  await drag(text.id); await started;
  await body.press('Control+Home'); await page.keyboard.insertText('校验期间的新输入');
  release();
  await page.waitForFunction(id => document.querySelectorAll(`.tiptap a[href="fengzaiy://asset/${id}"]`).length === 3, text.id);
  await saved(); await page.unroute('**/api'); await sameEditor();
  assert.match(store.get(note.id).data.content, /校验期间的新输入/);
  assert.match(await body.innerText(), /校验期间的新输入第一段文字保持不变[\s\S]*课程讲义.txt[\s\S]*第二段用于插入附件/);

  // Shared materials may be cross-library; unavailable/conflicted records must not be inserted.
  for (const invalid of [{ deleted: true }, { conflict: true }]) {
    const before = await html();
    await page.locator('#toast').evaluate(el => { el.textContent = ''; });
    await page.route('**/api', async route => {
      const request = route.request().postDataJSON();
      if (request.method === 'record' && request.input.id === text.id) await route.fulfill({ json: { value: { ...text, ...invalid } } });
      else await route.continue();
    });
    await drag(text.id);
    await page.locator('#toast', { hasText: /附件或笔记已发生变化|此附件已不属于当前笔记/ }).waitFor();
    assert.equal(await html(), before);
    await page.unroute('**/api');
  }
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.method === 'record' && request.input.id === text.id) await route.fulfill({ json: { error: { message: '测试附件读取失败' } } });
    else await route.continue();
  });
  const beforeFailure = await html();
  await drag(text.id); await page.locator('#toast', { hasText: '测试附件读取失败' }).waitFor();
  assert.equal(await html(), beforeFailure); await page.unroute('**/api');
  await page.locator('#toast.show').waitFor({ state: 'hidden' });

  for (const width of [1220, 931, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await body.locator('img').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(root, `dragged-content-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  let finish, notified;
  const pending = new Promise(resolve => { finish = resolve; });
  const notifiedPromise = new Promise(resolve => { notified = resolve; });
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.method === 'record' && request.input.id === text.id) { notified(); await pending; }
    await route.continue();
  });
  await drag(text.id); await notifiedPromise;
  await page.locator(`[data-record="${other.id}"]`).click();
  await body.getByText('这篇正文保持不变').waitFor();
  const completed = page.waitForResponse(response => {
    const request = response.request().postDataJSON();
    return request?.method === 'record' && request?.input.id === text.id;
  });
  finish(); await completed; await page.unroute('**/api');
  await page.locator(`[data-record="${note.id}"]`).click(); await source(text.id).waitFor();
  assert.equal(await html(), beforeFailure, 'Delayed drop must not change either note after switching tabs');
  assert.deepEqual(store.get(other.id).heads, other.heads);
  assert.equal(await page.locator('.attachment-drop-marker').count(), 0);
  await page.locator(`[data-record="${empty.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '空白笔记');
  await source(image.id).waitFor();
  await drag(image.id, body);
  await page.waitForFunction(() => document.querySelector('.tiptap img')?.naturalWidth === 320);
  await saved();
  assert.equal(store.list({ type: 'asset' }).length, 3);
  assert.match(store.get(empty.id).data.content, /data-ss-block/);
  await body.press('Control+z');
  assert.equal(await body.locator('img').count(), 0);
  await saved();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: [
    'native mouse drag and visible drop location', 'preview click', 'selection preserved', 'link/image/video',
    'undo redo', 'cancel and spoof rejection', 'repeat without reimport', 'stable asset identity',
    'autosave reload', 'in-flight text and mapped anchor', 'invalid and failed metadata', 'tab switch',
    'edge auto-scroll and cancellation', 'empty note insertion', 'responsive screenshots'
  ] }, null, 2));
  console.log('PASS: attachment mouse drag, image/video/link, positions, undo, autosave, identity, stale metadata and tab protection.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser?.close();
  await app.close();
}
