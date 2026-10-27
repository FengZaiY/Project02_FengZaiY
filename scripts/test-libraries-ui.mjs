import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/ui-libraries');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1165, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('#domain-filter').waitFor();
  assert.equal(await page.locator('#domain-filter option').count(), 1);
  assert.equal(app.service.store.libraries().length, 0);
  assert.equal(await page.locator('#ai-panel,[data-action="toggle-ai"],[data-nav="models"]').count(), 0);
  await page.screenshot({ path: path.join(root, 'empty-1165.png'), fullPage: true });
  const create = async title => {
    await page.locator('.breadcrumb [data-action="library-new"]').click();
    assert.equal(await page.locator('#library-folder').count(), 0);
    await page.locator('#library-form input[name=title]').fill(title);
    await page.locator('#library-form button[type=submit]').click();
    await page.waitForFunction(expected => document.querySelector('.list-heading strong')?.textContent === expected, title);
    const record = app.service.state().libraries.find(item => item.data.title === title);
    assert.equal(path.dirname(record.localDirectory), app.service.store.directory);
    assert.ok(fs.statSync(record.localDirectory).isDirectory());
    return record;
  };
  const first = await create('我的研究笔记'), second = await create('工作资料');
  await page.locator('.topbar [data-action="new"]').click();
  await page.locator('#note-title').fill('第一篇笔记');
  await page.locator('.tiptap').fill('自行搭建的知识结构');
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const note = app.service.store.list({ type: 'note' })[0];
  await page.locator('#domain-filter').selectOption(first.id);
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '我的研究笔记');
  assert.equal(await page.locator('.record-row').count(), 0);
  assert.equal(await page.locator('[data-action="tree-open"]').count(), 0);
  await page.locator('[data-nav="libraries"]').click();
  await page.locator(`[data-library="${second.id}"] [data-action="library-edit"]`).click();
  await page.locator('#library-form input[name=title]').fill('项目手册');
  await page.locator('#library-form button[type=submit]').click();
  await page.locator('.library-table strong', { hasText: '项目手册' }).waitFor();
  assert.equal(app.service.store.get(note.id).data.domain, second.id);
  assert.equal(app.service.state().libraries.find(item => item.id === second.id).localDirectory, second.localDirectory);
  assert.equal(await page.locator('.library-directory').count(), 0);
  assert.equal(await page.locator(`[data-library="${second.id}"] [data-action="library-delete"]`).isDisabled(), true);
  await page.locator(`[data-library="${second.id}"] [data-action="library-open"]`).click();
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '项目手册');
  assert.equal(await page.locator('[data-action="tree-open"]').count(), 1);
  await page.locator('[data-action="note-view"][data-mode="list"]').click();
  assert.equal(await page.locator('.knowledge-browser').count(), 0);
  assert.equal(await page.locator('.record-row').count(), 1);
  await page.locator('#domain-filter').selectOption(first.id);
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '我的研究笔记');
  assert.equal(await page.locator('.record-row').count(), 0);
  await page.locator('#domain-filter').selectOption(second.id);
  await page.locator('[data-action="note-view"][data-mode="tree"]').click();
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.work-tab.selected').innerText(), /项目手册/);
  await page.locator('[data-action="toggle-source"]').click();
  await page.locator('#source-pane').waitFor({ state: 'visible' });
  await page.locator('#source-preview', { hasText: '尚未关联原附件' }).waitFor();
  assert.equal(await page.locator('[data-action="toggle-source"]').getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: path.join(root, 'selected-library-1165.png'), fullPage: true });
  await page.locator('[data-action="source-close"]').click();
  await page.locator('#source-pane').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-action="toggle-source"]').getAttribute('title'), '展开原附件');

  const imagePath = path.join(root, 'source-sample.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2sAAAAASUVORK5CYII=', 'base64'));
  const asset = await app.service.call('assetImport', { path: imagePath, domain: second.id });
  const sources = Array.from({ length: 18 }, (_, i) => app.service.store.write({ type: 'source',
    data: { title: `学习出处 ${i + 1}`, domain: second.id, content: '独立测试资料' } }));
  const latest = app.service.store.get(note.id);
  app.service.store.write({ id: note.id, type: 'note', parents: latest.heads, data: { ...latest.data,
    assetIds: [asset.id], sourceIds: sources.map(item => item.id),
    content: Array.from({ length: 45 }, (_, i) => `<p>第 ${i + 1} 段学习笔记</p>`).join(''), format: 'html' } });
  await page.locator('[data-action="refresh-view"]').click();
  await page.locator('.tiptap p', { hasText: '第 45 段学习笔记' }).waitFor();
  await page.locator('.tiptap').press('Control+End');
  await page.keyboard.insertText(' 未保存的对照阅读编辑');
  await page.evaluate(() => {
    window.sourceTestEditor = document.querySelector('.tiptap');
    document.querySelector('.editor-scroll').scrollTop = 300;
  });
  const closedWidth = (await page.locator('.editor-panel').boundingBox()).width;
  const sourceToggle = page.locator('[data-action="toggle-source"]');
  await sourceToggle.click();
  await page.locator('.source-item').first().waitFor();
  assert.equal(await page.evaluate(() => window.sourceTestEditor === document.querySelector('.tiptap')), true);
  assert.match(await page.locator('.tiptap').innerText(), /未保存的对照阅读编辑/);
  assert.equal(await page.locator('.editor-scroll').evaluate(el => el.scrollTop), 300);
  assert.ok((await page.locator('.editor-panel').boundingBox()).width < closedWidth);
  await page.locator(`[data-preview-asset="${asset.id}"]`).click();
  await page.locator('#source-preview img').waitFor();
  const imageUrl = await page.locator('#source-preview img').getAttribute('src');
  await page.locator('.source-pane-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const sourceScroll = await page.locator('.source-pane-scroll').evaluate(el => el.scrollTop);
  assert.ok(sourceScroll > 0);
  assert.equal(await page.locator('[data-action="source-close"]').isVisible(), true);
  await page.locator('[data-action="source-close"]').click();
  assert.equal(await sourceToggle.evaluate(el => el === document.activeElement), true);
  await sourceToggle.press('Enter');
  assert.equal(await page.locator('#source-preview img').getAttribute('src'), imageUrl);
  assert.equal(await page.locator('.source-pane-scroll').evaluate(el => el.scrollTop), sourceScroll);
  await sourceToggle.click();
  await page.locator('.tiptap').press('Control+z');
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /未保存的对照阅读编辑/);
  await page.locator('.tiptap').press('Control+Shift+z');
  assert.match(await page.locator('.tiptap').innerText(), /未保存的对照阅读编辑/);
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  await sourceToggle.click();
  await page.waitForFunction(() => document.querySelector('[data-action="toggle-source"]')?.getAttribute('aria-expanded') === 'true');
  await page.reload();
  await page.locator('#source-pane').waitFor({ state: 'visible' });
  await page.locator('.source-item').first().waitFor();
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.source-pane-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const closeBox = await page.locator('[data-action="source-close"]').boundingBox();
    const footerBox = await page.locator('.statusbar').boundingBox();
    assert.ok(closeBox.y > 0 && closeBox.y + closeBox.height < footerBox.y);
    await page.screenshot({ path: path.join(root, `sources-open-${width}.png`), fullPage: true });
    await page.locator('[data-action="source-close"]').click();
    await page.locator('#source-pane').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(root, `sources-closed-${width}.png`), fullPage: true });
    await sourceToggle.click();
  }
  await page.setViewportSize({ width: 1165, height: 892 });
  await page.locator('[data-action="source-close"]').click();
  await page.locator('[data-action="refresh-view"]').click();
  await page.locator('#source-pane:not([data-ready])').waitFor({ state: 'attached' });
  let failAssets = true;
  await page.route('**/api', async route => {
    if (route.request().postDataJSON()?.method === 'assets' && failAssets) {
      failAssets = false;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: { message: '原附件临时读取失败' } }) });
    } else await route.continue();
  });
  await sourceToggle.click();
  await page.locator('[data-action="source-retry"]').waitFor();
  await page.locator('[data-action="source-close"]').click();
  await sourceToggle.click();
  await page.locator('.source-item').first().waitFor();
  await page.unroute('**/api');
  // A delayed load belonging to the previous note must not populate a new library.
  await page.locator('[data-action="source-close"]').click();
  await page.locator('[data-action="refresh-view"]').click();
  await page.locator('#source-pane:not([data-ready])').waitFor({ state: 'attached' });
  let releaseAssets, sawAssets;
  const gate = new Promise(resolve => { releaseAssets = resolve; });
  const arrived = new Promise(resolve => { sawAssets = resolve; });
  await page.route('**/api', async route => {
    if (route.request().postDataJSON()?.method === 'assets') { sawAssets(); await gate; }
    await route.continue();
  });
  await sourceToggle.click(); await arrived;
  await page.locator('[data-action="source-close"]').click();
  await page.locator('#domain-filter').selectOption(first.id);
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '我的研究笔记');
  const completed = page.waitForResponse(response => response.request().postData()?.includes('"method":"assets"'));
  releaseAssets(); await completed;
  await page.unroute('**/api');
  assert.equal(await page.locator('#source-pane').count(), 0);
  const empty = await create('临时空库');
  await page.locator('[data-nav="libraries"]').click();
  await page.locator(`[data-library="${empty.id}"] [data-action="library-delete"]`).click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator(`[data-library="${empty.id}"] [data-action="library-restore"]`).waitFor();
  assert.ok(fs.existsSync(empty.localDirectory));
  assert.equal(await page.locator(`#domain-filter option[value="${empty.id}"]`).count(), 0);
  await page.locator(`[data-library="${empty.id}"] [data-action="library-restore"]`).click();
  await page.locator(`[data-library="${empty.id}"] [data-action="library-open"]`).waitFor();
  for (const [width, height] of [[1480, 940], [1165, 892], [600, 900]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(root, `libraries-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: ['empty start', 'create', 'rename', 'scope isolation', 'delete and restore', 'source panel', 'no built-in AI'] }, null, 2));
  console.log('PASS: libraries, scope, source panel controls/persistence, live editor/undo/scroll preservation, preview retention and reachable close button.');
} finally { await browser?.close(); await app.close(); }
