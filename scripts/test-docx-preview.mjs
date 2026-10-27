import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { docxFixture } from './fixtures/docx.mjs';

const root = path.resolve('artifacts/docx-preview'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page; const errors = [], external = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1001, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(app.url)) external.push(request.url()); });
  await page.addInitScript(() => {
    const Original = Worker;
    window.previewWorkers = 0;
    window.Worker = class extends Original {
      constructor(...args) { super(...args); window.previewWorkers++; }
      terminate() { if (!this.finished) { window.previewWorkers--; this.finished = true; } super.terminate(); }
    };
  });
  await page.goto(app.url);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e2f0ec'; ctx.fillRect(0, 0, 240, 120);
    ctx.fillStyle = '#3b8577'; ctx.fillRect(20, 30, 90, 60); ctx.fillStyle = '#d7ac48'; ctx.fillRect(130, 30, 90, 60);
    return canvas.toDataURL().split(',')[1];
  });
  const library = app.service.store.saveLibrary({ title: '文档预览验证' });
  const create = async (name, contents) => {
    const file = path.join(root, name); fs.writeFileSync(file, contents);
    return app.service.call('assetImport', { path: file, domain: library.id });
  };
  const docx = await create('课程需求表.docx', await docxFixture({ image: Buffer.from(image, 'base64') }));
  assert.equal(docx.data.mime, 'application/octet-stream', 'Existing generic MIME must preview by filename');
  const broken = await create('损坏的文件.docx', Buffer.from('not a zip'));
  const large = await create('解压限制.docx', await docxFixture({ oversized: true }));
  const text = await create('补充资料.txt', Buffer.from('新的资料内容'));
  const extra = [];
  for (let i = 0; i < 7; i++) extra.push(await create(`附加资料${i}.txt`, Buffer.from(`资料${i}`)));
  const note = app.service.store.write({ type: 'note', data: { title: 'Word 附件预览', domain: library.id,
    assetIds: [docx.id, broken.id, large.id, text.id, ...extra.map(a => a.id)], format: 'html',
    content: `<p>阅读原文时继续记笔记。</p><p><a href="fengzaiy://asset/${docx.id}">正文中的 Word 引用</a></p>` } });
  const other = app.service.store.write({ type: 'note', data: { title: '另一篇笔记', domain: library.id, content: '这里不能出现旧预览' } });
  const revisions = app.service.store.history(note.id).length, hash = docx.data.sha256;
  await page.reload(); await page.locator(`[data-record="${note.id}"]`).click();
  await page.getByRole('button', { name: '原附件', exact: true }).click();
  await page.evaluate(() => { window.originalEditor = document.querySelector('.tiptap').editor; });
  const click = id => page.locator(`[data-preview-asset="${id}"]`).click();
  const frame = () => page.frameLocator('#source-preview iframe.docx-preview');
  await click(docx.id);
  await frame().getByRole('heading', { name: '学习资料阅读预览' }).waitFor();
  assert.equal(await frame().locator('table td').count(), 4);
  assert.equal(await frame().locator('strong').innerText(), '重点内容');
  assert.equal(await frame().locator('li').innerText(), '第一项学习要点');
  await frame().locator('img').evaluate(image => image.decode());
  assert.equal(await frame().locator('img').evaluate(el => el.naturalWidth), 240);
  assert.equal(await frame().locator('a[href]').count(), 0, 'No active external or javascript links');
  assert.equal(await page.locator('.docx-preview').getAttribute('sandbox'), '');
  assert.equal(await page.locator('#source-preview').evaluate(el => {
    const box = el.getBoundingClientRect(), pane = el.parentElement.getBoundingClientRect();
    return box.top >= pane.top - 2 && box.top < pane.bottom - 50;
  }), true, 'Preview must be revealed after a long attachment list');
  assert.equal(await page.evaluate(() => window.previewWorkers), 0);
  assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('.tiptap').editor), true);
  await page.screenshot({ path: path.join(root, 'side-1001.png') });
  await page.getByRole('button', { name: '放大预览', exact: true }).click();
  await page.frameLocator('#modal iframe').getByRole('heading', { name: '学习资料阅读预览' }).waitFor();
  for (const width of [1220, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `expanded-${width}.png`) });
  }
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await frame().locator('table').waitFor();
  assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('.tiptap').editor), true);
  assert.equal(app.service.store.history(note.id).length, revisions, 'Preview must not save a new note revision');
  assert.equal(app.service.store.get(docx.id).data.sha256, hash);
  await page.setViewportSize({ width: 1001, height: 892 });
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.equal(await page.locator('.source-pane-scroll').evaluate(el => el.scrollTop), 0);
  assert.equal(await page.locator('#source-preview').isVisible(), false);
  assert.equal(await page.locator('#source-preview iframe').count(), 0);
  await click(docx.id); await frame().locator('table').waitFor();
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await click(broken.id); await page.locator('.asset-preview-error', { hasText: '文档无法解析' }).waitFor();
  assert.equal(await page.locator('#source-preview iframe').count(), 0);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('.asset-preview-error').waitFor();
  await click(large.id); await page.locator('.asset-preview-error', { hasText: '解压后过大' }).waitFor();
  assert.equal(await page.evaluate(() => window.previewWorkers), 0);
  // A late response must not overwrite another attachment or reopen a closed dialog.
  let release, entered;
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.method === 'assetContent' && request.input.id === docx.id) {
      entered(); await gate;
    }
    await route.continue();
  });
  await click(docx.id); await started; await click(text.id);
  await page.locator('#source-preview .text-preview', { hasText: '新的资料内容' }).waitFor();
  release(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('#source-preview iframe').count(), 0);
  // Closing while the file is still arriving must not resurrect the preview.
  let releaseSource, enteredSource;
  const sourceGate = new Promise(resolve => releaseSource = resolve), sourceStarted = new Promise(resolve => enteredSource = resolve);
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.method === 'assetContent' && request.input.id === docx.id) { enteredSource(); await sourceGate; }
    await route.continue();
  });
  await click(docx.id); await sourceStarted;
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  releaseSource(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('#source-preview').isVisible(), false);
  assert.equal(await page.locator('#source-preview').getAttribute('data-asset'), null);
  assert.equal(await page.evaluate(() => window.previewWorkers), 0);
  await click(docx.id); await frame().locator('table').waitFor();
  await page.getByRole('button', { name: '原附件', exact: true }).click();
  await page.locator('.tiptap a').click();
  await page.frameLocator('#modal iframe').locator('table').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  let releaseClose, enteredClose;
  const closeGate = new Promise(resolve => releaseClose = resolve), closeStarted = new Promise(resolve => enteredClose = resolve);
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'assetContent') { enteredClose(); await closeGate; }
    await route.continue();
  });
  await page.locator('.tiptap a').click(); await closeStarted;
  await page.getByRole('button', { name: '关闭', exact: true }).click(); releaseClose();
  await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('#modal').isVisible(), false);
  assert.equal(await page.evaluate(() => window.previewWorkers), 0);
  // Normal editing and undo retain the same editor through preview operations.
  await page.locator('.tiptap').press('Control+End'); await page.keyboard.insertText(' 临时编辑');
  await page.locator('.tiptap a').click(); await page.frameLocator('#modal iframe').locator('table').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /临时编辑/);
  await page.locator(`[data-record="${other.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '另一篇笔记');
  assert.equal(await page.locator('.docx-preview').count(), 0);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, external }, null, 2));
  console.log('PASS: local DOCX text/table/image/list preview, generic MIME, sandbox, no external requests, size/corruption errors, reveal/expand, stale responses, cancel, undo, unchanged originals and responsive screenshots.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser?.close(); await app.close(); }
