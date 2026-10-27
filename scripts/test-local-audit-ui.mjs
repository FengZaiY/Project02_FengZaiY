import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/local-audit/ui'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'case-')), port: 0 });
let browser, release;
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  await page.goto(app.url);
  await page.locator('[data-nav=tasks]').click(); await page.locator('[data-personal=new]').click();
  await page.locator('#personal-form [name=title]').fill('连续保存的唯一任务');
  await page.evaluate(() => { window.auditOldForm = document.querySelector('#personal-form'); });
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let writes = 0;
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().method === 'personalSave') { writes++; if (writes === 1) { reached(); await gate; } }
    await route.continue();
  });
  await page.locator('#personal-form button[type=submit]').click(); await started;
  await page.locator('#personal-form [name=content]').fill('保存请求期间补充的内容');
  await page.keyboard.press('Control+s');
  release();
  await page.waitForFunction(() => document.querySelector('#personal-save-state')?.textContent === '已保存');
  const tasks = app.service.personal.list({ type: 'personalTask' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].data.content, '保存请求期间补充的内容');
  assert.equal(writes, 2, 'Second save commits newer input to the same entity');
  await page.locator('[data-nav=finance]').click(); await page.locator('#finance-overview').waitFor();
  await page.evaluate(() => { window.auditOldForm.dispatchEvent(new Event('input', { bubbles: true })); window.auditOldForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await page.locator('[data-nav=tasks]').click();
  await page.locator('#personal-form').waitFor();
  assert.equal(await page.locator('#personal-form [name=content]').inputValue(), '保存请求期间补充的内容');
  await page.screenshot({ path: path.join(root, 'task-save-desktop.png') });
  await page.setViewportSize({ width: 600, height: 820 });
  await page.locator('#personal-form button[type=submit]').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const box = await page.locator('#personal-form button[type=submit]').boundingBox(); assert.ok(box.y + box.height <= 821);
  await page.screenshot({ path: path.join(root, 'task-save-narrow.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: serialized create/save, input during save, stale form events, navigation and reachable narrow-window controls.');
} finally { release?.(); await browser?.close(); await app.close(); }
