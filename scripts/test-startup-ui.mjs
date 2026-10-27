import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/startup-ui'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
const library = app.service.store.saveLibrary({ title: '启动恢复验证' });
const note = app.service.store.write({ data: { title: '原笔记', domain: library.data.domain, content: '已保存正文' } });
const workspace = { tabs: [{ id: 'startup-tab', recordId: note.id, recordType: 'note', title: note.data.title, domain: note.data.domain,
  dirty: true, baseHeads: note.heads, draft: { ...note.data, content: '启动前的未保存正文' } }], selectedTab: 'startup-tab' };
app.service.store.local('workspace', workspace);
const originalEvents = app.service.store.allEvents();
let browser, mode = 'legacy'; const calls = [], errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  await page.addInitScript(() => localStorage.setItem('fengzai-last-view', 'tasks'));
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api', async route => {
    const { method } = route.request().postDataJSON(); calls.push(method);
    if (mode === 'network') return route.abort('connectionfailed');
    if (mode === 'runtime' && method === 'personalDraft') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ERROR', message: 'Unsupported operation <img src=x onerror=alert(1)>' } }) });
    if (mode === 'legacy' && method === 'state') {
      const response = await route.fetch(), result = await response.json();
      delete result.value.uiProtocol; result.value.version = '0.1.10';
      return route.fulfill({ response, json: result });
    }
    return route.continue();
  });
  await page.goto(app.url);
  await page.getByRole('heading', { name: '需要重新启动应用' }).waitFor();
  assert.deepEqual(calls, ['state'], 'incompatible startup must not call new APIs or write workspace state');
  assert.equal(await page.locator('[data-nav]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(root, 'old-backend-narrow.png'), fullPage: true });
  for (const failure of ['network', 'runtime']) {
    mode = failure; await page.locator('#startup-reload').click();
    await page.getByRole('heading', { name: '工作区暂时无法打开' }).waitFor();
    if (failure === 'runtime') {
      assert.match(await page.locator('#startup-error-detail').textContent(), /<img/);
      assert.equal(await page.locator('.startup-panel img').count(), 0);
    }
    assert.deepEqual(app.service.store.local('workspace'), workspace);
    assert.deepEqual(app.service.store.allEvents(), originalEvents);
  }
  mode = 'healthy'; await page.locator('#startup-reload').click();
  await page.locator('[data-nav=tasks].active').waitFor(); await page.locator('.personal-page').waitFor();
  await page.waitForFunction(() => !document.querySelector('#app').classList.contains('starting'));
  assert.equal(await page.locator('.startup-panel').count(), 0);
  assert.deepEqual(app.service.store.local('workspace'), workspace);
  assert.deepEqual(app.service.store.allEvents(), originalEvents);
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.screenshot({ path: path.join(root, 'recovered.png'), fullPage: true });
  console.log('PASS: old backend detection, network/runtime error recovery, safe error text, retry, unchanged notes/drafts and narrow layout.');
} finally { await browser?.close(); await app.close(); }
