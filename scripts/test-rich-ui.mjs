import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/rich-ui'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page;
const errors = [];
try {
  const library = app.service.store.saveLibrary({ title: '富内容验证' });
  const note = app.service.store.write({ type: 'note', data: { title: '富内容笔记', domain: library.data.domain, content: '<p>六级标题</p><p>任务内容</p><p>重点记录</p><p>正文</p>', format: 'html' } });
  const importedDiagram = JSON.stringify({ v: 1, kind: 'diagram', label: '导入箭头', source: 'flowchart TD\n A[原始文本]-->B[保留箭头]' }).replaceAll('"', '&quot;');
  const target = app.service.store.write({ type: 'note', data: { title: '内部链接目标', domain: library.data.domain, format: 'html',
    content: `<p>target</p><figure data-ss-block="${importedDiagram}"><figcaption>导入箭头</figcaption></figure><img src="https://example.invalid/blocked.png" onerror="window.richXss=true"><script>window.richXss=true</script><a href="javascript:alert(1)">不安全链接</a><button data-action="agent-export">伪装按钮</button><p id="note-title" data-record="${note.id}">伪装界面属性</p>` } });
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  page.on('pageerror', error => errors.push(error.message));
  const externalRequests = []; page.on('request', request => { if (request.url().startsWith('https://example.invalid')) externalRequests.push(request.url()); });
  await page.goto(app.url); await page.locator(`[data-record="${note.id}"]`).click(); await page.locator('.tiptap').waitFor();
  await page.locator('.tiptap p').first().click(); await page.locator('#heading-level').selectOption('6'); assert.equal(await page.locator('.tiptap h6').innerText(), '六级标题');
  await page.locator('.tiptap p', { hasText: '任务内容' }).click(); await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await page.locator('li[data-type="taskItem"] input').check();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.tiptap p', { hasText: '重点记录' }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await page.locator('#insert-content').selectOption('callout');
  await page.locator('.tiptap aside[data-callout]').waitFor();
  assert.equal(await page.locator('.tiptap > .layout-block > .layout-content > aside[data-callout]').count(), 1, 'Callout must move and resize with its outer layout container');
  const end = async () => { await page.locator('.tiptap > p').last().click(); await page.keyboard.press('End'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); };
  await end(); await page.locator('#insert-content').selectOption('table'); await page.locator('.tiptap td').last().click(); await page.locator('#table-action').selectOption('addRowAfter'); assert.equal(await page.locator('.tiptap tr').count(), 4);
  await end(); await page.locator('#insert-content').selectOption('formula');
  await page.locator('#rich-form textarea').fill('\\frac{a^2+b^2}{c} = \\sqrt{x}'); await page.getByRole('button', { name: '保存内容块', exact: true }).click();
  await page.locator('.tiptap .katex').waitFor();
  const diagramValues = await page.locator('#insert-content option[value^="diagram:"]').evaluateAll(options => options.map(option => option.value));
  for (const value of diagramValues) {
    await end(); await page.locator('#insert-content').selectOption(value);
    await page.locator('#rich-preview svg').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#rich-preview[data-error]').count(), 0, `Diagram failed: ${value}`);
    assert.ok(await page.locator('#rich-preview svg text').count() > 0, `Diagram labels missing: ${value}`);
    await page.locator('#rich-preview').screenshot({ path: path.join(root, `${value.replace(':', '-')}.png`) });
    await page.getByRole('button', { name: '保存内容块', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#modal').open);
  }
  await end(); await page.locator('#insert-content').selectOption('sticker'); await page.locator('#rich-form textarea').fill('核对出处，再确认入库'); await page.getByRole('radio', { name: '粉色' }).check(); await page.getByRole('button', { name: '保存内容块', exact: true }).click();
  await end(); await page.locator('#insert-content').selectOption('canvas');
  await page.getByRole('button', { name: '添加矩形', exact: true }).click(); await page.locator('#shape-text').fill('核心知识'); await page.locator('#shape-text').blur();
  const board = await page.locator('#canvas-stage').boundingBox(); await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2); await page.mouse.down(); await page.mouse.move(board.x + board.width / 2 + 60, board.y + board.height / 2 + 30, { steps: 8 }); await page.mouse.up();
  await page.getByRole('button', { name: '添加箭头', exact: true }).click(); await page.getByRole('button', { name: '画板撤销', exact: true }).click(); await page.getByRole('button', { name: '画板重做', exact: true }).click();
  await page.getByRole('button', { name: '放大画板', exact: true }).click(); assert.equal(await page.locator('#canvas-zoom').innerText(), '120%');
  const pixels = await page.locator('#canvas-stage canvas').first().evaluate(canvas => { const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let painted = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) painted++; return painted; }); assert.ok(pixels > 1000, 'Canvas is blank');
  await page.screenshot({ path: path.join(root, 'canvas-desktop.png') });
  await page.setViewportSize({ width: 600, height: 900 }); await page.screenshot({ path: path.join(root, 'canvas-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '保存画板', exact: true }).click(); await page.setViewportSize({ width: 1480, height: 940 });
  const imageBytes = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3a8197'; ctx.fillRect(0, 0, 240, 140); ctx.fillStyle = '#f4da78'; ctx.fillRect(30, 30, 180, 80); return canvas.toDataURL('image/png').split(',')[1]; });
  const imagePath = path.join(root, 'test-image.png'); fs.writeFileSync(imagePath, Buffer.from(imageBytes, 'base64'));
  const image = await app.service.call('assetImport', { path: imagePath, domain: library.data.domain });
  await end(); await page.locator('#insert-content').selectOption('image'); await page.locator('#media-form select').selectOption(image.id); await page.getByRole('button', { name: '插入', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.tiptap img')].some(img => img.src.includes('/media/') && img.naturalWidth === 240));
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; canvas.style.cssText = 'position:fixed;top:0;right:0;z-index:9999'; document.body.append(canvas);
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0], parts = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); recorder.ondataavailable = e => parts.push(e.data);
    const stopped = new Promise(resolve => recorder.onstop = resolve); recorder.start();
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#4d9c8a' : '#c85d7f'; ctx.fillRect(0, 0, 160, 90); track.requestFrame(); await new Promise(resolve => setTimeout(resolve, 120)); }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); canvas.remove(); return Array.from(new Uint8Array(await new Blob(parts).arrayBuffer()));
  });
  assert.ok(videoBytes.length > 200, 'Generated video fixture contains no encoded frames');
  const videoPath = path.join(root, 'test-video.webm'); fs.writeFileSync(videoPath, Buffer.from(videoBytes)); const video = await app.service.call('assetImport', { path: videoPath, domain: library.data.domain });
  await end(); await page.locator('#insert-content').selectOption('video'); await page.locator('#media-form select').selectOption(video.id); await page.getByRole('button', { name: '插入', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.tiptap video')?.readyState >= 1);
  await page.locator('.tiptap video').evaluate(video => video.play()); await page.waitForFunction(() => document.querySelector('.tiptap video')?.currentTime > 0); await page.locator('.tiptap video').evaluate(video => video.pause());
  await end(); await page.getByRole('button', { name: '插入或修改链接', exact: true }).click(); await page.locator('#note-link-form [name=kind]').selectOption('note'); await page.locator('#note-link-form [name=target]').selectOption(target.id); await page.locator('#note-link-form [name=label]').fill('查看另一篇笔记'); await page.getByRole('button', { name: '保存链接', exact: true }).click();
  const beforeSave = await page.locator('.tiptap').evaluate(el => el.editor.getHTML()); assert.equal((beforeSave.match(/data-ss-block=/g) || []).length, diagramValues.length + 5, 'Rendering must not replace serialized rich blocks');
  await page.locator('[data-action=save]').click(); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const saved = app.service.store.get(note.id); assert.ok(saved.data.assetIds.includes(image.id) && saved.data.assetIds.includes(video.id)); assert.match(saved.data.content, /data-checked="true"/); assert.match(saved.data.content, /<h6>/); assert.match(saved.data.content, /data-callout/);
  await page.reload(); await page.locator('.tiptap .katex').waitFor(); assert.equal(await page.locator('.tiptap .rich-block').count(), diagramValues.length + 5);
  await page.locator('.tiptap a', { hasText: '查看另一篇笔记' }).click(); await page.waitForFunction(() => document.querySelector('#note-title')?.value === '内部链接目标');
  await page.locator('.tiptap .rich-content svg').waitFor(); assert.equal(await page.locator('.tiptap .rich-block').count(), 1, 'Raw arrow JSON must survive sanitization');
  assert.equal(await page.locator('.tiptap img').count(), 0); assert.equal(await page.locator('.tiptap a[href^="javascript:"]').count(), 0); assert.equal(await page.evaluate(() => window.richXss === true), false); assert.deepEqual(externalRequests, []);
  await page.getByRole('button', { name: '历史版本', exact: true }).click(); assert.equal(await page.locator('#modal .prose [data-action], #modal .prose [data-record], #modal .prose #note-title').count(), 0); await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.work-tab', { hasText: '富内容笔记' }).click(); await page.locator('.tiptap .rich-block').first().hover(); await page.locator('.tiptap .rich-block').first().getByRole('button', { name: '编辑内容块', exact: true }).click(); await page.locator('#rich-form textarea').fill('x = 42'); await page.getByRole('button', { name: '保存内容块', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await page.locator('.tiptap .rich-block').first().hover(); await page.locator('.tiptap .rich-block').first().getByRole('button', { name: '编辑内容块', exact: true }).click(); assert.match(await page.locator('#rich-form textarea').inputValue(), /frac/); await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('[data-action=save]').click(); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const downloadPromise = page.waitForEvent('download'); await page.locator('[data-action=export]').click(); const download = await downloadPromise; const exportPath = path.join(root, 'rich-export.md'); await download.saveAs(exportPath); assert.match(fs.readFileSync(exportPath, 'utf8'), /data-ss-block/); assert.match(fs.readFileSync(exportPath, 'utf8'), /studyself:\/\/note/);
  for (const [width, height, name] of [[1480, 940, 'desktop'], [1165, 892, 'user-window'], [600, 900, 'narrow']]) {
    await page.setViewportSize({ width, height }); await page.locator('.editor-scroll').evaluate(el => el.scrollTop = 0); await page.screenshot({ path: path.join(root, `${name}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow`);
    await page.locator('.editor-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    const bottom = await page.locator('.editor-scroll').evaluate(el => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 3); assert.equal(bottom, true);
    const status = await page.locator('.statusbar').boundingBox(); assert.ok(status.y + status.height <= height + 1, `${name} footer inaccessible`);
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, diagrams: diagramValues, canvasPixels: pixels, errors }, null, 2));
  console.log('PASS: headings, tasks, callouts, formulas, all diagram templates, editable canvas, media playback, internal links, persistence, undo, export and responsive scrolling.');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); console.error('UI errors:', errors); console.error((await page.locator('.tiptap').evaluate(el => el.editor.getHTML()).catch(() => 'No editor')).slice(0, 12000)); }
  throw error;
} finally { await browser?.close(); await app.close(); }
