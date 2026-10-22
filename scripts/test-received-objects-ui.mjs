import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/ui-received-objects');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'case-'));
const app = await createServer({ directory, port: 0 });
clearInterval(app.service.timer); app.service.timer = null;
await app.service.ready;
if (app.service.localTask) await app.service.localTask;
const received = path.join(app.service.store.directory, 'received-objects');
fs.mkdirSync(received, { recursive: true });
const hash = 'a'.repeat(64), partial = `${hash}.v3.partial`;
fs.writeFileSync(path.join(received, partial), 'partial');
app.service.store.local(`v3Receive:${hash}`, { hash, bytes: 7, size: 100 });
for (let i = 0; i < 26; i++) fs.writeFileSync(path.join(received, `user-extra-${String(i).padStart(2, '0')}.txt`), 'keep');
let browser;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1165, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('[data-nav="settings"]').click();
  const panel = page.locator('#received-objects');
  await panel.getByText('等待续传', { exact: true }).waitFor();
  assert.equal(await panel.locator('li').count(), 25);
  await page.locator('#agent-preferences-form textarea').fill('未保存的整理偏好');
  await panel.locator('[data-received-next]').click();
  await panel.getByText('26–27 / 27', { exact: true }).waitFor();
  assert.equal(await panel.locator('li').count(), 2);
  await panel.locator('[data-received-prev]').click();
  await panel.getByText('等待续传', { exact: true }).waitFor();
  await panel.locator('[data-received-organize]').click();
  await page.waitForFunction(() => !document.querySelector('[data-received-organize]').disabled);
  assert.equal(await page.locator('#agent-preferences-form textarea').inputValue(), '未保存的整理偏好');
  assert.equal(fs.readdirSync(received).length, 27);
  for (const width of [1165, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await panel.locator('h3').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: path.join(root, `received-${width}.png`) });
  }
  // Remove only files injected by this test, to exercise the user-visible empty state.
  for (let i = 0; i < 26; i++) fs.unlinkSync(path.join(received, `user-extra-${String(i).padStart(2, '0')}.txt`));
  fs.unlinkSync(path.join(received, partial));
  app.service.store.local(`v3Receive:${hash}`, null);
  await panel.locator('[data-received-organize]').click();
  await panel.getByText('无需保留接收目录', { exact: true }).waitFor();
  assert.equal(fs.existsSync(received), false);
  assert.equal(await page.locator('#agent-preferences-form textarea').inputValue(), '未保存的整理偏好');
  assert.deepEqual(errors, []);
  console.log('Received directory UI: pagination, progress, retention, empty cleanup, unsaved preferences and responsive screenshots passed.');
} finally { await browser?.close(); await app.close(); }
