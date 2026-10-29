import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/proposal-status-ui'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'case-')), port: 0 });
let browser;
try {
  const store = app.service.store, domain = store.saveLibrary({ title: '整理方案验证' }).id;
  const make = (title, count = 1) => app.service.call('propose', { title, domain, items: Array.from({ length: count }, (_, i) => ({ title: `${title}-${i}`, content: 'isolated proposal content' })) });
  const accepted = await make('已经确认的方案');
  await app.service.call('approve', { id: accepted.id, parents: accepted.heads, itemIds: accepted.data.items.map(item => item.id) });
  const pending = await make('需要继续处理的方案', 2);
  store.markExported(store.allEvents().map(event => event.id));
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const page = await browser.newPage({ viewport: { width: 1304, height: 892 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('[data-nav=proposals]').click();
  const row = record => page.locator(`.record-row[data-record="${record.id}"]`);
  await row(pending).waitFor();
  assert.equal(await page.locator('#proposal-filter').inputValue(), 'active');
  assert.equal(await row(accepted).count(), 0);
  assert.match(await row(pending).innerText(), /待确认.*0 \/ 2 项已确认.*同步：已生成交接文件/s);
  await row(pending).click();
  await page.locator('[data-proposal-item]').first().check();
  await page.locator('[data-action=approve]').click();
  await row(pending).locator('[data-confirmation=partial]').waitFor();
  assert.match(await row(pending).innerText(), /1 \/ 2 项已确认/);
  await page.locator('[data-proposal-item]:not(:disabled)').check();
  await page.locator('[data-action=approve]').click();
  await page.locator('.proposal-complete-actions').waitFor();
  await row(pending).waitFor({ state: 'detached' });
  assert.match(await page.locator('.list-empty').innerText(), /没有待处理方案/);
  assert.equal(store.get(pending.id).deleted, false);
  const events = store.allEvents();
  await page.locator('#proposal-filter').selectOption('accepted');
  await row(accepted).waitFor(); await row(pending).waitFor();
  assert.match(await row(pending).innerText(), /已确认.*2 \/ 2/s);
  await page.locator('#search').fill('已经确认');
  await row(pending).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#proposal-filter').inputValue(), 'accepted');
  await page.locator('#search').fill('');
  await row(pending).waitFor();
  for (const width of [1304, 600]) {
    await page.setViewportSize({ width, height: 892 });
    if (width === 600) await page.locator('[data-action="knowledge-browse"]').click();
    assert.equal(await page.locator('#proposal-filter').isVisible(), true);
    await page.screenshot({ path: path.join(root, `confirmed-${width}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.locator('#proposal-filter').selectOption('all'); await row(accepted).waitFor();
  assert.deepEqual(store.allEvents(), events);
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.reload();
  await page.locator('#proposal-filter').waitFor();
  assert.equal(await page.locator('#proposal-filter').inputValue(), 'active');
  await page.locator('.list-empty', { hasText: '没有待处理方案' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: pending/partial/confirmed lists, separate sync labels, confirmation transition, search, reload and responsive UI.');
} finally { await browser?.close(); await app.close(); }
