import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.mjs';
import { createServer } from '../src/server.mjs';
import { legacyReadingEvent, retiredPage, seedLegacyReading } from './fixtures/retired-reading.mjs';

const root = path.resolve('artifacts/retired-reading-ui'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'profile-')), store = new Store(directory);
const domain = store.saveLibrary({ title: '阅读与整理' }).data.domain;
const data = { title: '移除交互阅读后的笔记', domain, content: '<h2>完整正文</h2><p>保留原有正文和修改记录。</p>', format: 'html' };
const old = legacyReadingEvent(store, { data: { ...data, presentation: retiredPage(data) } });
seedLegacyReading(store, [old]); store.close();
const app = await createServer({ directory, port: 0 });
let browser, page; const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator(`[data-record="${old.entityId}"]`).click();
  await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.tiptap').innerText(), /保留原有正文/);
  for (const name of ['交互阅读', '复制设计请求', '查看上次页面', '预览交互页面']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.equal(await page.locator('iframe.interactive-page,.presentation-mode,.presentation-host').count(), 0);
  await page.locator('.tiptap').press('Control+End');
  await page.keyboard.insertText('新增正文仍可保存');
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  assert.match(app.service.store.get(old.entityId).data.content, /新增正文仍可保存/);
  await page.locator('[data-action=history]').click();
  await page.locator('.history-browser').waitFor();
  assert.equal(await page.locator('[data-history-page],.history-page-change').count(), 0);
  await page.locator('#modal [data-modal-close]').click();
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `ordinary-editor-${width}.png`), fullPage: true });
  }
  await page.reload(); await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.tiptap').innerText(), /新增正文仍可保存/);
  for (const endpoint of ['/presentation-worker.js', '/page-formula.css']) {
    assert.equal((await page.request.get(`${app.url}${endpoint}`)).status(), 404);
  }
  for (const file of ['presentation-worker.js', 'presentation-worker.js.map', 'page-formula.css']) {
    assert.equal(fs.existsSync(path.resolve('dist', file)), false);
  }
  assert.equal(app.service.store.event(old.id).retiredPresentation, old.hash);
  assert.equal(app.service.store.event(old.id).data.presentation, undefined);
  assert.deepEqual(errors, []);
  console.log('PASS: migrated ordinary editor, no interactive controls/runtime, save/reload, history and responsive layout.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  throw error;
} finally { await browser?.close(); await app.close(); }
