import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { makePairingKey } from '../src/core/transport.mjs';

const root = path.resolve('artifacts/sync-publication-ui'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'case-'));
const app = await createServer({ directory: path.join(directory, 'workspace'), port: 0 });
const rename = fs.renameSync, errors = []; let browser, page;
try {
  const library = await app.service.call('librarySave', { title: '清单占用测试' });
  const note = await app.service.call('save', { type: 'note', data: { title: '发布测试', domain: library.data.domain, content: '旧内容' } });
  app.service.transport.configure(path.join(directory, 'cloud'), makePairingKey());
  await app.service.call('syncPublish');
  const pointer = app.service.transport.channel().file(`current-${app.service.store.deviceId}.sscurrent`);
  const before = fs.readFileSync(pointer);
  await app.service.call('save', { id: note.id, type: 'note', parents: note.heads, data: { ...note.data, content: '待发布的新内容' } });
  fs.renameSync = (from, to) => { if (to === pointer) throw Object.assign(new Error('isolated contention'), { code: 'EPERM' }); return rename(from, to); };
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1165, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.getByRole('button', { name: '多电脑同步', exact: true }).click();
  await page.locator('[data-action=sync-publish]').click();
  await page.locator('#sync-task').getByText(/正在等待重试/).waitFor();
  assert.equal(await page.locator('[data-action=sync-publish]').isDisabled(), true);
  assert.equal(await page.locator('[data-action=sync-pause]').isEnabled(), true);
  await page.screenshot({ path: path.join(root, 'waiting.png'), fullPage: true });
  await page.locator('[data-action=sync-pause]').click();
  await page.locator('#sync-task').getByText(/已暂停，最新清单尚未更新/).waitFor();
  assert.deepEqual(fs.readFileSync(pointer), before);
  await page.locator('[data-action=sync-publish]').click();
  await page.locator('#sync-task').getByText(/自动重试后仍未成功/).waitFor({ timeout: 20000 });
  assert.equal(app.service.transport.status().job.state, 'blocked');
  assert.deepEqual(fs.readFileSync(pointer), before);
  for (const width of [1165, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('[data-action=sync-publish]').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `blocked-${width}.png`), fullPage: true });
  }
  fs.renameSync = rename;
  await page.locator('[data-action=sync-publish]').click();
  await page.locator('#sync-task').getByText('最新内容已生成，等待客户端上传', { exact: true }).waitFor();
  assert.equal(app.service.transport.status().job.state, 'complete');
  assert.equal(app.service.transport.status().pendingChanges, 0);
  assert.equal(app.service.transport.status().config.cloudUploadVerified, false);
  await page.screenshot({ path: path.join(root, 'resumed.png'), fullPage: true });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors }, null, 2));
  console.log('PASS: contention progress, responsive pause, bounded failure, previous pointer preserved, resume and desktop/narrow layout.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  fs.renameSync = rename;
  app.service.transport.pause();
  while (app.service.transport.running) await new Promise(resolve => setTimeout(resolve, 50));
  await browser?.close(); await app.close();
}
