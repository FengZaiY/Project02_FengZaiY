import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const root = path.resolve('artifacts/storage-maintenance-ui');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'workspace-'));
const app = await createServer({ directory, port: 0 });
let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const page = await browser.newPage({ viewport: { width: 1304, height: 892 } });
  const errors = [], calls = [], overrides = new Map();
  page.on('pageerror', error => errors.push(error.message));
  // Read-only response fixtures exercise abnormal and completed states without deleting data.
  overrides.set('storageInternalPreview', { value: { state: 'complete' } });
  overrides.set('materialMigrationPreview', { value: { rows: [], progress: null } });
  overrides.set('receivedObjectsStatus', { value: { directory: path.join(directory, 'received-objects'), exists: false, total: 0, bytes: 0, counts: {}, items: [], limit: 25 } });
  overrides.set('deletionStatus', { value: { pending: 0, files: [], releasedBytes: 1024, database: { state: 'done' }, transport: { state: 'done' } } });
  await page.route('**/api', async route => {
    const { method } = route.request().postDataJSON(); calls.push(method);
    if (overrides.has(method)) return route.fulfill({ json: overrides.get(method) });
    await route.continue();
  });
  await page.goto(app.url);
  await page.locator('[data-nav=assets]').click();
  await page.locator('.material-organization').waitFor();
  assert.ok(await page.locator('.material-organization').isVisible());
  assert.equal(await page.locator('#material-collections').getAttribute('open'), null);
  assert.equal(await page.locator('[data-action=material-migrate]').count(), 0);
  assert.equal(await page.locator('[data-action=material-cleanup]').count(), 0);
  await page.locator('#material-collections summary').click();
  await page.getByRole('button', { name: '管理用途集合', exact: true }).click();
  await page.getByRole('heading', { name: '用途集合', exact: true }).waitFor();
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-maintenance-status]', { hasText: '无需处理' }).waitFor();
  assert.equal(await page.locator('[data-action=storage-change]').count(), 1);
  assert.equal(await page.locator('.storage-advanced').getAttribute('open'), null);
  assert.equal(calls.includes('materialCleanupPreview'), false);
  const scan = async () => {
    await page.locator('[data-storage-scan]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-results]')?.textContent.includes('扫描完成')
      && !document.querySelector('[data-storage-results]').hasAttribute('aria-busy'));
  };
  const eventsBefore = app.service.store.allEvents().length;
  await scan();
  assert.equal(app.service.store.allEvents().length, eventsBefore);
  assert.equal(calls.some(method => ['materialCleanup', 'emptyDirectoriesClean', 'deletionRetry', 'storageInternalSchedule', 'materialMigrate', 'localHierarchyRefresh'].includes(method)), false);
  assert.equal(await page.locator('[data-action=deletion-retry]').count(), 0);
  assert.equal(await page.locator('[data-received-organize]').count(), 0);
  assert.match(await page.locator('[data-storage-results]').innerText(), /可释放空间.*旧副本.*废弃空目录.*异常与待处理/s);
  for (const width of [1304, 850, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('#storage-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `settings-${width}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  overrides.set('materialCleanupPreview', { error: { message: '测试：文件暂被占用', code: 'BUSY' } });
  overrides.set('deletionStatus', { value: { pending: 1, files: [{ relative: '资料/待处理.txt', state: 'pending', reason: '<不执行>' }], database: { state: 'pending' } } });
  await page.locator('[data-storage-scan]').click();
  await page.locator('[data-storage-results]', { hasText: '部分扫描未完成' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-storage-results]').hasAttribute('aria-busy'));
  assert.ok(await page.locator('[data-action=deletion-retry]').isVisible());
  assert.match(await page.locator('[data-storage-results]').innerText(), /资料旧副本空间未核验/);
  assert.match(await page.locator('[data-storage-results]').innerText(), /<不执行>/);
  assert.equal(await page.locator('[data-storage-results] 不执行').count(), 0);
  await page.screenshot({ path: path.join(root, 'partial-scan.png'), fullPage: true });
  overrides.delete('materialCleanupPreview');
  overrides.set('deletionStatus', { value: { pending: 0, files: [], database: { state: 'done' } } });
  await scan();
  assert.equal(await page.locator('[data-action=deletion-retry]').count(), 0);
  overrides.set('storageInternalPreview', { value: { state: 'legacy' } });
  overrides.set('materialMigrationPreview', { value: { rows: [{ issue: '原件待下载' }], progress: { state: 'pending' } } });
  await page.locator('[data-nav=assets]').click();
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-maintenance-status]', { hasText: '2 项待处理' }).waitFor();
  assert.equal(await page.locator('.storage-advanced').getAttribute('open'), null);
  await page.locator('.storage-advanced summary').click();
  assert.ok(await page.locator('[data-action=storage-internal]').isVisible());
  assert.ok(await page.locator('[data-action=material-migrate]').isVisible());
  assert.deepEqual(errors, []);
  console.log('PASS: storage scanning, partial failures, completed/pending controls, optional collections and responsive layout.');
} finally { await browser?.close(); await app.close(); }
