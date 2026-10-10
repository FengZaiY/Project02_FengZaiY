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
    assert.equal(await page.locator('#library-folder').inputValue(), app.service.store.directory);
    await page.locator('#library-form input[name=title]').fill(title);
    await page.locator('#library-form button[type=submit]').click();
    await page.waitForFunction(expected => document.querySelector('.list-heading strong')?.textContent === expected, title);
    const record = app.service.state().libraries.find(item => item.data.title === title);
    assert.equal(path.dirname(record.localDirectory), app.service.store.directory);
    assert.ok(fs.statSync(record.localDirectory).isDirectory());
    return record;
  };
  const first = await create('我的研究笔记'), second = await create('工作资料');
  await page.locator('.sidebar [data-action="new"]').click();
  await page.locator('#note-title').fill('第一篇笔记');
  await page.locator('.tiptap').fill('自行搭建的知识结构');
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已本地保存');
  const note = app.service.store.list({ type: 'note' })[0];
  await page.locator('#domain-filter').selectOption(first.id);
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '我的研究笔记');
  assert.equal(await page.locator('.record-row').count(), 0);
  await page.locator('[data-nav="libraries"]').click();
  await page.locator(`[data-library="${second.id}"] [data-action="library-edit"]`).click();
  await page.locator('#library-form input[name=title]').fill('项目手册');
  await page.locator('#library-form button[type=submit]').click();
  await page.locator('.library-table strong', { hasText: '项目手册' }).waitFor();
  assert.equal(app.service.store.get(note.id).data.domain, second.id);
  assert.equal(app.service.state().libraries.find(item => item.id === second.id).localDirectory, second.localDirectory);
  assert.match(await page.locator(`[data-library="${second.id}"] .library-directory`).innerText(), /工作资料/);
  assert.equal(await page.locator(`[data-library="${second.id}"] [data-action="library-delete"]`).isDisabled(), true);
  await page.locator(`[data-library="${second.id}"] [data-action="library-open"]`).click();
  await page.waitForFunction(() => document.querySelector('.list-heading strong')?.textContent === '项目手册');
  await page.locator(`[data-record="${note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  assert.match(await page.locator('.work-tab.selected').innerText(), /项目手册/);
  await page.locator('[data-action="toggle-source"]').click();
  await page.locator('#source-pane').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(root, 'selected-library-1165.png'), fullPage: true });
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
  console.log('PASS: user-owned libraries, stable rename, empty deletion/restore, scope and no built-in AI.');
} finally { await browser?.close(); await app.close(); }
