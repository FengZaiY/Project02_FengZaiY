import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/asset-previews');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'profile-'));
const app = await createServer({ directory, port: 0 });
let browser;
try {
  clearInterval(app.service.timer);
  const library = app.service.store.saveLibrary({ title: '预览测试资料' });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  const errors = [], requested = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/media/')) requested.push(new URL(request.url()).pathname.slice(7)); });
  await page.goto(app.url);
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e5eff6'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#527eab'; ctx.fillRect(28, 26, 95, 125); ctx.fillStyle = '#dfa453'; ctx.fillRect(148, 80, 140, 71);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const videoData = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; document.body.append(canvas);
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), parts = [];
    recorder.ondataavailable = event => parts.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = '#437d78'; ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#edcd76'; ctx.fillRect(20 + i * 15, 40, 85, 100);
      track.requestFrame(); await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); canvas.remove();
    return Array.from(new Uint8Array(await new Blob(parts).arrayBuffer()));
  });
  const create = async (name, bytes) => {
    const file = path.join(directory, name); fs.writeFileSync(file, bytes);
    return app.service.call('assetImport', { path: file, domain: library.id, duplicateMode: 'separate' });
  };
  const picture = await create('课程框架图.png', Buffer.from(imageData, 'base64'));
  const video = await create('课程演示.webm', Buffer.from(videoData));
  const doc = await create('阅读资料.docx', 'format-cover-only');
  const missing = await create('尚未下载.png', Buffer.from(imageData, 'base64'));
  // Unbind this ID without deleting a content-deduplicated file shared with picture.
  app.service.store.db.prepare('DELETE FROM assets WHERE id=?').run(missing.id);
  const broken = await create('损坏图片.png', 'not-a-picture');
  const longTag = '这是一个需要完整换行展示的很长的资料标签用于验证不同窗口下不会被下拉箭头遮挡';
  await app.service.call('assetUpdate', { id: picture.id, parents: picture.heads, changes: { tags: [longTag] } });
  await page.locator('[data-nav="assets"]').click();
  const thumbnail = asset => page.locator(`[data-material-row="${asset.id}"] .material-thumbnail`);
  for (const asset of [picture, video]) {
    await thumbnail(asset).scrollIntoViewIfNeeded();
    await page.waitForFunction(id => document.querySelector(`[data-material-row="${id}"] .material-thumbnail`)?.dataset.thumbnailState === 'ready', asset.id);
  }
  assert.equal(await thumbnail(picture).locator('img').evaluate(el => el.naturalWidth), 320);
  assert.equal(await thumbnail(video).locator('video').evaluate(el => el.videoWidth), 320);
  assert.equal(await thumbnail(video).locator('video').evaluate(el => el.paused && el.muted && !el.controls), true);
  const pixels = await thumbnail(video).locator('video').evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const ctx = canvas.getContext('2d'); ctx.drawImage(el, 0, 0, 32, 18);
    const bytes = ctx.getImageData(0, 0, 32, 18).data;
    return { colored: bytes.some((value, i) => i % 4 !== 3 && value > 60), varied: new Set(bytes).size > 5 };
  });
  assert.ok(pixels.colored && pixels.varied, 'Video thumbnail must contain an actual decoded frame');
  assert.equal(await thumbnail(doc).locator('img,video').count(), 0);
  assert.match(await thumbnail(doc).innerText(), /DOCX/);
  assert.match(await thumbnail(missing).innerText(), /待下载/);
  assert.ok(!requested.includes(missing.id), 'Missing originals must not trigger thumbnail reads');
  await thumbnail(broken).scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`[data-material-row="${id}"] .material-thumbnail`)?.dataset.thumbnailState === 'unavailable', broken.id);
  assert.match(await thumbnail(broken).innerText(), /无法预览/);
  await thumbnail(video).click(); await page.locator('#modal .asset-video').waitFor();
  await page.locator('#modal .asset-video').evaluate(el => el.play());
  await page.waitForFunction(() => document.querySelector('#modal .asset-video')?.currentTime > 0);
  await page.evaluate(() => { window.modalVideo = document.querySelector('#modal .asset-video'); });
  await page.locator('[data-modal-close]').click();
  await page.waitForFunction(() => window.modalVideo.paused && !window.modalVideo.hasAttribute('src'));
  await thumbnail(picture).click();
  await page.waitForFunction(() => document.querySelector('#modal img')?.naturalWidth === 320);
  await page.locator('[data-modal-close]').click();

  for (const width of [1480, 1220, 1165, 980, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('.material-toolbar').scrollIntoViewIfNeeded();
    const layout = await page.locator('[data-material-filter]').evaluateAll(controls => controls.map(el => {
      const style = getComputedStyle(el), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      ctx.font = `${style.fontSize} ${style.fontFamily}`;
      return { height: el.clientHeight, needed: ctx.measureText(el.selectedOptions[0].textContent).width,
        room: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    }));
    assert.ok(layout.every(item => item.height >= 38 && item.room >= item.needed), `Filter text clipped at ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(root, `previews-${width}.png`), fullPage: true });
    await page.getByRole('combobox', { name: '资料标签', exact: true }).selectOption(longTag);
    const fullLabel = page.locator('[data-material-filter=tag] + .material-filter-value');
    await fullLabel.waitFor({ state: 'visible' });
    assert.equal(await fullLabel.innerText(), longTag);
    assert.ok(await fullLabel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(root, `long-tag-${width}.png`), fullPage: true });
    await page.locator('[data-action="material-clear"]').click();
    await thumbnail(doc).waitFor();
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.locator('.material-pagination').scrollIntoViewIfNeeded();
  const bottom = await page.locator('.material-pagination').boundingBox();
  assert.ok(bottom.y + bottom.height <= 892, 'Paging remains reachable');
  await page.evaluate(() => { window.thumbnailMedia = [...document.querySelectorAll('.material-thumbnail img,.material-thumbnail video')]; });
  await page.locator('[data-nav="notes"]').click();
  await page.waitForFunction(() => window.thumbnailMedia.every(el => !el.hasAttribute('src')));
  const initialMediaCount = requested.length;
  const local = app.service.store.assetLocation(picture.id);
  app.service.store.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const extra = app.service.store.writeRaw({ type: 'asset', data: { ...picture.data, title: `滚动图片 ${i}` } });
      app.service.store.bindAsset(extra.entityId, local.path);
    }
  });
  await page.locator('[data-nav="assets"]').click();
  await page.locator('[data-thumbnail-state=ready]').first().waitFor();
  assert.ok(requested.length - initialMediaCount < 12, 'Offscreen images should not all be loaded');
  await page.locator('.material-thumbnail').last().scrollIntoViewIfNeeded();
  await page.locator('[data-nav="notes"]').click();
  assert.deepEqual(errors, []);
  console.log('PASS: actual image/video frames, nonplaying thumbnails, authenticated previews, fallback/missing files, video modal cleanup, filter text/long tags and responsive screenshots.');
} finally {
  await browser?.close(); await app.close();
}
