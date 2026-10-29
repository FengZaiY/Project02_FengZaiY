import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/note-tab-navigation');
fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const store = app.service.store;
const library = store.saveLibrary({ title: '标签切换验证' });
const make = (title, type = 'note') => store.write({ type, data: { title, domain: library.id, format: 'html',
  content: Array.from({ length: 70 }, (_, index) => `<p>${title} · 正文第 ${index + 1} 段</p>`).join('') } });
const [a, b, c, d] = ['A 笔记', 'B 笔记', 'C 笔记', 'D 笔记'].map(title => make(title));
const [draftA, draftB] = ['A 草稿', 'B 草稿'].map(title => make(title, 'draft'));
const releases = [];
let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1304, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const row = record => page.locator(`.record-list [data-record="${record.id}"]`);
  const titleIs = record => page.waitForFunction(title => document.querySelector('#note-title')?.value === title, record.data.title);
  const open = async (record, options = {}) => { await row(record).click(options); await titleIs(record); };
  const count = async n => assert.equal(await page.locator('.work-tab').count(), n);
  const input = text => page.locator('.tiptap').evaluate((element, value) => element.editor.commands.insertContent(value), text);
  const saved = () => page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); releases.push(release); return { promise, release }; };
  await page.goto(app.url);
  await open(a); await count(1);
  await page.locator('.editor-scroll').evaluate(element => { element.scrollTop = 650; });
  await open(b); await count(1);
  await open(c); await count(1);
  await open(a); await count(1);
  assert.ok(await page.locator('.editor-scroll').evaluate(element => element.scrollTop) >= 640);
  await open(b); await page.reload(); await titleIs(b); await count(1);
  await open(a);
  assert.ok(await page.locator('.editor-scroll').evaluate(element => element.scrollTop) >= 640);
  console.log('PASS: ordinary tree clicks replace one tab; reading positions and selected page survive reload');

  await open(b, { modifiers: ['Control'] }); await count(2);
  await page.locator('.tiptap').evaluate(element => { window.sameTabEditor = element.editor; });
  await open(b, { modifiers: ['Control'] }); await count(2);
  assert.equal(await page.locator('.tiptap').evaluate(element => element.editor === window.sameTabEditor), true);
  await open(a); await count(2);
  await row(c).click({ button: 'right' });
  await page.locator('[data-open-new-tab]').click(); await titleIs(c); await count(3);
  await open(d, { button: 'middle' }); await count(4);
  const tabA = store.local('workspace').tabs.find(tab => tab.recordId === a.id);
  await page.locator(`[data-tab="${tabA.id}"]`).click(); await titleIs(a); await count(4);
  // Close the other explicitly opened tabs so replacement tests start with one page.
  for (const tab of store.local('workspace').tabs.filter(tab => tab.recordId !== a.id)) {
    await page.locator(`[data-close-tab="${tab.id}"]`).click();
    await page.locator(`[data-tab="${tab.id}"]`).waitFor({ state: 'detached' });
  }
  await count(1);
  await page.locator('[data-action="note-view"][data-mode="list"]').click();
  await open(b); await count(1); await open(a); await count(1);
  await input('切换前编辑'); await open(b); await count(1);
  assert.match(store.get(a.id).data.content, /切换前编辑/);
  console.log('PASS: explicit new tabs, duplicate prevention, tab activation, list replacement and automatic save');

  // Keep the first write pending, type more, then release: both revisions must reach disk.
  await open(a);
  const saveHold = gate(), saveStarted = gate(); let held = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === a.id && !held) {
      held = true; saveStarted.release(); await saveHold.promise;
    }
    await route.continue();
  });
  await input('请求前输入'); await row(b).click(); await saveStarted.promise;
  await input('请求期间输入'); saveHold.release();
  await titleIs(b); await count(1);
  assert.match(store.get(a.id).data.content, /请求前输入/);
  assert.match(store.get(a.id).data.content, /请求期间输入/);
  await page.unrouteAll({ behavior: 'wait' });

  // A failed save leaves the same editor (including undo) and durable local draft.
  await open(a);
  await page.route('**/api', route => {
    const body = route.request().postDataJSON();
    if (body.method === 'save' && body.input.id === a.id) return route.fulfill({ status: 500, json: { error: { message: '测试保存失败', code: 'TEST_FAILURE' } } });
    return route.continue();
  });
  await page.locator('.tiptap').evaluate(element => { window.retainedEditor = element.editor; });
  await input('失败后仍保留'); await row(b).click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'error');
  await titleIs(a); await count(1);
  assert.equal(await page.locator('.tiptap').evaluate(element => element.editor === window.retainedEditor), true);
  assert.match(await page.locator('.tiptap').innerText(), /失败后仍保留/);
  assert.match(store.local('workspace').tabs.find(tab => tab.recordId === a.id).draft.content, /失败后仍保留/);
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('测试保存失败'));
  await page.unrouteAll({ behavior: 'wait' });
  await page.locator('[data-action=save]').click(); await saved(); await open(b);
  assert.match(store.get(a.id).data.content, /失败后仍保留/);
  console.log('PASS: input during save is drained; failed navigation retains editor and draft, retry works');

  // An external change must block navigation without silently creating a branch.
  await open(a); await input('冲突编辑保留');
  const remote = store.get(a.id);
  store.write({ id: a.id, type: 'note', parents: remote.heads, data: { ...remote.data, content: '<p>外部修改</p>' } });
  await row(b).click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'conflict');
  await titleIs(a); await count(1);
  assert.equal(store.get(a.id).heads.length, 1);
  assert.match(await page.locator('.tiptap').innerText(), /冲突编辑保留/);
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  // Explicit new tab can keep the conflicted draft alongside the next page.
  await open(b, { modifiers: ['Control'] }); await count(2);
  const conflictTab = store.local('workspace').tabs.find(tab => tab.recordId === a.id);
  assert.equal(conflictTab.dirty, true);
  assert.match(conflictTab.draft.content, /冲突编辑保留/);

  // Fetch errors leave the foreground editor intact.
  await page.route('**/api', route => {
    const body = route.request().postDataJSON();
    if (body.method === 'record' && body.input.id === c.id) return route.fulfill({ json: { value: null } });
    return route.continue();
  });
  await row(c).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('不存在或尚未到达'));
  await titleIs(b); assert.equal(await page.locator('.tiptap').count(), 1);
  await page.unrouteAll({ behavior: 'wait' });

  const readHold = gate(), readStarted = gate(); let readHeld = false;
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'record' && body.input.id === c.id && !readHeld) {
      readHeld = true; readStarted.release(); await readHold.promise;
    }
    await route.continue();
  });
  await row(c).click(); await readStarted.promise; await row(d).click(); readHold.release();
  await titleIs(d); await count(2); await page.unrouteAll({ behavior: 'wait' });
  console.log('PASS: real version conflict stays protected; missing target and rapid clicks preserve correct selection');

  await page.locator('.tab-add').click();
  await page.waitForFunction(() => document.querySelector('#note-title')?.value === '未命名笔记'); await count(3);
  await page.locator('[data-nav=drafts]').click();
  await open(draftA); const draftCount = await page.locator('.work-tab').count();
  await input('草稿切换输入'); await open(draftB); await count(draftCount);
  assert.match(store.get(draftA.id).data.content, /草稿切换输入/);
  await row(draftA).focus(); await page.keyboard.press('Control+Enter');
  await titleIs(draftA); await count(draftCount + 1);
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'));
  for (const width of [1304, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const element = document.querySelector('.work-tab.selected');
      const box = element.getBoundingClientRect(), container = element.parentElement.getBoundingClientRect();
      return box.left >= container.left - 1 && box.right <= container.right + 1;
    });
    await page.reload(); await titleIs(draftA);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForFunction(() => {
      const element = document.querySelector('.work-tab.selected'); if (!element) return false;
      const box = element.getBoundingClientRect(), container = element.parentElement.getBoundingClientRect();
      return box.left >= container.left - 1 && box.right <= container.right + 1;
    });
    await page.screenshot({ path: path.join(root, `tabs-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: new-note button adds a tab, drafts use same navigation, keyboard activation, desktop/narrow layouts');
} finally {
  for (const release of releases) release();
  await browser?.close(); await app.close();
}
