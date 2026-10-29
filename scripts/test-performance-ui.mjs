import { chromium, _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const native = process.argv.includes('--desktop'), root = path.resolve('artifacts/performance-ui');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, native ? 'desktop-' : 'browser-'));
let app, browser, application;
try {
  let page;
  if (native) {
    application = await electron.launch({ executablePath: electronPath, args: [path.resolve('.'), '--smoke-test', `--data-dir=${directory}`], timeout: 45000 });
    page = await application.firstWindow();
  } else {
    app = await createServer({ directory, port: 0 });
    try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
    page = await browser.newPage(); await page.goto(app.url);
  }
  await page.setViewportSize({ width: 1304, height: 900 });
  await page.locator('[data-nav=notes]').waitFor();
  const calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api') && request.postData()) calls.push(JSON.parse(request.postData()).method); });
  const rpc = (method, input = {}) => page.evaluate(async ({ method, input }) => {
    if (window.desktop) return window.desktop.call(method, input);
    const result = await (await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fengzaiy-token': document.querySelector('meta[name=local-token]').content }, body: JSON.stringify({ method, input }) })).json();
    if (result.error) throw new Error(result.error.message); return result.value;
  }, { method, input });
  const library = await rpc('librarySave', { title: '性能验证' });
  const note = await rpc('save', { type: 'note', data: { title: '测试编辑器保留', domain: library.id, format: 'html', content: '<p>Original body.</p>' } });
  await page.locator('[data-action=refresh-view]').click();
  await page.locator(`.record-list [data-record="${note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  await page.locator('.tiptap').evaluate(element => { window.performanceEditor = element.editor; element.editor.commands.insertContent('Undo must survive refresh.'); });
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  await page.locator('[data-action=refresh-view]').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.tiptap').evaluate(element => element.editor === window.performanceEditor), true);
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /Undo must survive/);
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  calls.length = 0;
  await page.locator('[data-nav=settings]').click(); await page.locator('.settings-view').waitFor();
  assert.ok(!calls.includes('noteTree') && !calls.includes('records'), 'Settings must not load note trees/lists');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ca3340'; ctx.fillRect(0, 0, 1600, 900); ctx.fillStyle = '#3fbd86'; ctx.fillRect(300, 200, 700, 400);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const file = path.join(directory, 'preview-fixture.png'); fs.writeFileSync(file, Buffer.from(image, 'base64'));
  const asset = await rpc('assetImport', { path: file, domain: library.id });
  const thumbnail = page.locator(`.material-thumbnail[data-asset="${asset.id}"]`);
  await page.locator('[data-nav=assets]').click(); await thumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`.material-thumbnail[data-asset="${id}"]`)?.dataset.thumbnailState === 'ready', asset.id);
  await page.waitForTimeout(300);
  await page.locator('[data-nav=notes]').click(); await page.locator('[data-nav=assets]').click(); await thumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`.material-thumbnail[data-asset="${id}"] img`)?.src.startsWith('blob:'), asset.id);
  await page.waitForFunction(id => document.querySelector(`.material-thumbnail[data-asset="${id}"]`)?.dataset.thumbnailState === 'ready', asset.id);
  assert.ok(await thumbnail.locator('img').evaluate(img => img.naturalWidth <= 320 && img.naturalWidth > 0));
  await page.screenshot({ path: path.join(root, `${native ? 'desktop' : 'browser'}-cached.png`) });
  const detail = await rpc('assetDetail', { id: asset.id });
  fs.writeFileSync(detail.storage.path, Buffer.alloc(Buffer.from(image, 'base64').length, 7));
  await page.locator('[data-nav=notes]').click(); await page.locator('[data-nav=assets]').click(); await thumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`.material-thumbnail[data-asset="${id}"]`)?.dataset.thumbnailState === 'unavailable', asset.id);
  assert.equal(await thumbnail.locator('img').getAttribute('src'), null);
  assert.deepEqual(errors, []);
  console.log(`PASS (${native ? 'desktop' : 'browser'}): editor/undo reuse, page-scoped reads, real thumbnail cache and changed-file invalidation.`);
} finally { await browser?.close(); await application?.close(); await app?.close(); }
