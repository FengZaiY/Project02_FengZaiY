import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { importAttachment } from '../src/core/transport.mjs';

const root = path.resolve('artifacts/readable-ui'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'case-'));
const app = await createServer({ directory: path.join(directory, 'workspace'), port: 0 });
let browser;
try {
  const source = path.join(directory, '合同.txt'); fs.writeFileSync(source, 'isolated UI fixture');
  const asset = await importAttachment(app.service.store, source, { domain: '__materials__' });
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const page = await browser.newPage({ viewport: { width: 1220, height: 892 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('[data-nav=assets]').click();
  await page.locator('[data-action=material-category-new]').click();
  await page.locator('#material-structure-form [name=title]').fill('装修');
  await page.locator('#material-structure-form button[type=submit]').click();
  await page.locator('[data-action=material-topic-new]').click();
  await page.locator('#material-structure-form [name=title]').fill('合同模板');
  await page.locator('#material-structure-form button[type=submit]').click();
  await page.locator(`[data-material-check="${asset.id}"]`).check();
  await page.locator('[data-action=material-organize]').click();
  const topic = app.service.store.list({ type: 'materialTopic' })[0];
  await page.locator('#modal [name=materialTopicId]').selectOption(topic.id);
  await page.locator('#modal [name=managedFilename]').fill('01_合同说明.txt');
  await page.locator('#modal button[type=submit]').click();
  await page.locator('.material-proposal-items [data-proposal-item]').check();
  assert.match(await page.locator('.material-proposal-items').textContent(), /合同模板/);
  await page.screenshot({ path: path.join(root, 'proposal.png'), fullPage: true });
  await page.locator('[data-action=approve]').click();
  await page.waitForFunction(() => document.querySelector('.proposal-complete-actions'));
  if (app.service.localTask) await app.service.localTask;
  await app.service.organizeLocal();
  assert.match(app.service.store.assetLocation(asset.id).path, /装修.*合同模板.*01_合同说明.txt/);
  await page.locator('[data-nav=assets]').click();
  await page.locator(`[data-action=material-topic-select][data-topic="${topic.id}"]`).click();
  await page.locator(`[data-material-row="${asset.id}"]`).waitFor();
  for (const width of [1220, 850, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.screenshot({ path: path.join(root, `materials-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []); console.log('PASS: category/topic creation, reviewed placement, readable paths and responsive UI');
} finally { await browser?.close(); await app.close(); }
