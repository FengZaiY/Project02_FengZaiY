import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/note-delete-navigation');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '删除导航验证' });
const make = title => app.service.store.write({ type: 'note', data: { title, domain: library.id, format: 'html', content: `<p>${title}正文</p>` } });
const first = make('保留笔记'), second = make('待删除笔记');
let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  const open = async (record, newTab = false) => {
    await page.locator(`[data-record="${record.id}"]`).click({ modifiers: newTab ? ['Control'] : [] });
    await page.waitForFunction(title => document.querySelector('#note-title')?.value === title, record.data.title);
  };
  const askDelete = async () => {
    await page.locator('[data-action="delete"]').click();
    await page.locator('#modal [data-confirm]').waitFor();
  };
  await open(first); await open(second, true);
  const deletedTab = app.service.store.local('workspace').tabs.find(tab => tab.recordId === second.id).id;
  await askDelete();
  await page.locator('#modal [data-modal-close]').click();
  assert.equal(app.service.store.get(second.id).deleted, false);
  assert.equal(await page.locator('#note-title').inputValue(), second.data.title);

  // A concurrent revision rejects deletion and leaves the selected tab intact.
  await askDelete();
  app.service.store.write({ id: second.id, type: 'note', parents: second.heads,
    data: { ...second.data, content: '<p>另一处已保存的修改</p>' } });
  const failed = page.waitForResponse(response => response.url().endsWith('/api') && response.request().postDataJSON()?.method === 'delete');
  await page.locator('#modal [data-confirm]').click();
  assert.equal((await failed).status(), 409);
  assert.equal(app.service.store.get(second.id).deleted, false);
  assert.equal(await page.locator(`[data-tab="${deletedTab}"]`).count(), 1);
  assert.equal(await page.locator('#note-title').inputValue(), second.data.title);
  await page.locator('[data-action="refresh-view"]').click();
  await page.locator('.tiptap').getByText('另一处已保存的修改').waitFor();

  await askDelete(); await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(title => document.querySelector('#note-title')?.value === title, first.data.title);
  assert.equal(await page.locator(`[data-tab="${deletedTab}"]`).count(), 0);
  assert.equal(app.service.store.get(second.id).deleted, true);
  assert.ok(!app.service.store.local('workspace').tabs.some(tab => tab.recordId === second.id));
  await page.reload();
  await page.waitForFunction(title => document.querySelector('#note-title')?.value === title, first.data.title);

  await askDelete(); await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('#note-title') && !document.querySelector('.work-tab'));
  assert.equal(app.service.store.local('workspace').selectedTab, null);
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-nav="notes"]').click();
  assert.equal(await page.locator('#note-title').count(), 0);
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `empty-${width}.png`) });
  }
  await page.setViewportSize({ width: 1220, height: 892 });
  await page.locator('[data-nav="trash"]').click();
  await page.locator(`[data-record="${second.id}"]`).click();
  await page.getByText('此内容已进入回收站。', { exact: false }).waitFor();
  await page.locator('[data-action="restore"]').click();
  await page.locator('.tiptap').waitFor();
  assert.equal(app.service.store.get(second.id).deleted, false);
  assert.match(app.service.store.get(second.id).data.content, /另一处已保存的修改/);

  const third = make('继续编辑');
  await page.locator('[data-nav="notes"]').click();
  await open(third); await open(second, true);
  let release, processed;
  const hold = new Promise(resolve => { release = resolve; });
  const deleted = new Promise(resolve => { processed = resolve; });
  await page.route('**/api', async route => {
    if (route.request().postDataJSON()?.method !== 'delete') return route.continue();
    const response = await route.fetch(); processed(); await hold; await route.fulfill({ response });
  });
  await askDelete(); await page.locator('#modal [data-confirm]').click(); await deleted;
  const thirdTab = app.service.store.local('workspace').tabs.find(tab => tab.recordId === third.id).id;
  await page.locator(`[data-tab="${thirdTab}"]`).click();
  await page.waitForFunction(title => document.querySelector('#note-title')?.value === title, third.data.title);
  await page.locator('.tiptap').evaluate(element => {
    window.retainedDeleteEditor = element.editor;
    element.editor.commands.insertContent('删除期间输入');
  });
  release();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '已移入回收站');
  assert.equal(await page.locator('#note-title').inputValue(), third.data.title);
  assert.equal(await page.locator('.tiptap').evaluate(element => element.editor === window.retainedDeleteEditor), true);
  assert.match(await page.locator('.tiptap').innerText(), /删除期间输入/);
  await page.locator('.tiptap').evaluate(element => element.editor.commands.undo());
  assert.doesNotMatch(await page.locator('.tiptap').innerText(), /删除期间输入/);
  await page.locator('[data-action="save"]').click();
  await page.unrouteAll({ behavior: 'wait' });
  assert.deepEqual(errors, []);
  console.log('PASS: cancel/conflict retain selection, successful deletion closes tab, fallback persists, last tab clears, trash restore, delayed response preserves new selection/editor/undo; 1220/600 layouts.');
} finally { await browser?.close(); await app.close(); }
