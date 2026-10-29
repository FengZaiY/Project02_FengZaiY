import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { UpdateManager } from '../src/desktop/updates.mjs';

const root = path.resolve('artifacts/ui-updates'); fs.mkdirSync(root, { recursive: true });
const app = await createServer({ directory: fs.mkdtempSync(path.join(root, 'profile-')), port: 0 });
let browser, page, finishDownload, failDownload, installs = 0, rejectSaves = false, downloads = 0, resets = 0;
const errors = [];
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1304, height: 892 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('[data-nav=settings]').click();
  await page.locator('#upgrade-settings', { hasText: '浏览器开发预览' }).waitFor();
  assert.match(await page.locator('#upgrade-settings').innerText(), /github.com\/FengZaiY\/Project02_FengZaiY\/releases/);
  assert.equal(await page.locator('[data-update=check]').isDisabled(), true);
  for (const method of ['updateStatus', 'updateCheck', 'updateDownload', 'updatePause', 'updateResume', 'updateRestartDownload', 'updateInstall', 'updateConfigure']) {
    const result = await page.evaluate(async ({ method, token }) => (await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FengZaiY-Token': token }, body: JSON.stringify({ method }) })).json(), { method, token: app.token });
    assert.ok(result.error, 'preview must not expose installer RPC');
  }
  await page.screenshot({ path: path.join(root, 'browser-preview.png') });

  const engine = new EventEmitter();
  engine.checkForUpdates = async () => {
    engine.emit('checking-for-update'); engine.emit('update-available');
    return { updateInfo: { version: '0.2.0', releaseNotes: '更新笔记编辑体验\n<script>window.updateScriptExecuted=true</script>\n' + '更新说明 '.repeat(25) } };
  };
  engine.downloadUpdate = token => new Promise((resolve, reject) => {
    downloads++; failDownload = () => reject(new Error('isolated network failure'));
    token.onCancel(() => reject(new Error('isolated cancellation')));
    finishDownload = () => { engine.emit('update-downloaded', { version: '0.2.0' }); resolve([]); };
    engine.emit('download-progress', { percent: 42, transferred: 42000, total: 100000 });
  });
  engine.resetDownload = async () => { resets++; };
  const manager = new UpdateManager({ version: '0.1.1', packaged: true, platform: 'win32',
    source: { provider: 'generic', url: 'https://updates.example.test/fengzaiy/' }, createUpdater: () => engine,
    notify: value => { void page.evaluate(status => window.updateTestReceive?.(status), value).catch(() => {}); } });
  await page.exposeFunction('testDesktopCall', async (method, input) => {
    if (method === 'save' && rejectSaves) throw new Error('隔离测试：保存失败');
    if (method === 'updateStatus') return manager.status();
    if (method === 'updateCheck') return manager.check();
    if (method === 'updateDownload') return manager.download();
    if (method === 'updatePause') return manager.pause();
    if (method === 'updateResume') return manager.download();
    if (method === 'updateRestartDownload') return manager.restartDownload();
    if (method === 'updateConfigure') return manager.configure(input);
    if (method === 'updateInstall') { assert.equal(input.rendererReady, true); installs++; return manager.status(); }
    return app.service.call(method, input);
  });
  await page.addInitScript(() => {
    window.desktop = { call: (...args) => window.testDesktopCall(...args), onUpdateStatus: callback => { window.updateTestReceive = callback; return () => {}; } };
  });
  await page.reload(); await page.locator('[data-nav=settings]').click();
  await page.locator('[data-update=check]').click();
  await page.locator('[data-update=download]').waitFor();
  assert.equal(await page.locator('#upgrade-settings script').count(), 0);
  assert.equal(await page.evaluate(() => window.updateScriptExecuted), undefined);
  await page.locator('#update-auto-check').uncheck();
  assert.equal(manager.status().autoCheck, false);
  await page.locator('#agent-preferences-form textarea').fill('不能被更新操作丢弃的偏好');
  await page.locator('[data-update=download]').click();
  await page.locator('progress[value="42"]').waitFor();
  assert.equal(await page.locator('[data-update=check]').isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'downloading.png') });
  await page.locator('[data-update=pause]').click();
  await page.locator('#upgrade-settings', { hasText: '下载已暂停' }).waitFor();
  assert.equal(manager.status().progress.percent, 42);
  assert.equal(await page.locator('[data-update=install]').count(), 0);
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('#upgrade-settings').evaluate(element => element.scrollIntoView({ block: 'start' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const box = await page.locator('[data-update=restart]').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.screenshot({ path: path.join(root, `paused-${width}.png`) });
  }
  await page.setViewportSize({ width: 1304, height: 892 });
  await page.locator('[data-update=resume]').click();
  await page.locator('[data-update=pause]').waitFor(); assert.equal(downloads, 2);
  failDownload();
  await page.locator('#upgrade-settings [role=alert]').waitFor();
  await page.locator('[data-update=resume]').click();
  await page.locator('[data-update=pause]').waitFor(); assert.equal(downloads, 3);
  await page.locator('[data-update=restart]').click();
  await page.locator('[data-update=pause]').waitFor(); assert.equal(downloads, 4); assert.equal(resets, 1);
  await page.locator('[data-nav=agents]').click();
  finishDownload();
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-update=install]').waitFor();
  assert.equal(await page.locator('#agent-preferences-form textarea').inputValue(), '不能被更新操作丢弃的偏好');
  await page.locator('[data-update=install]').click();
  await page.locator('#toast', { hasText: '请先保存笔记和整理偏好' }).waitFor();
  assert.equal(installs, 0);
  await page.locator('#agent-preferences-form [type=submit]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  await page.locator('[data-update=later]').click(); assert.equal(installs, 0);
  await page.locator('[data-nav=agents]').click();
  assert.equal(await page.locator('[data-nav=settings].has-update').count(), 1);
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-update=install]').click();
  await page.waitForFunction(() => !document.querySelector('#app').inert);
  assert.equal(installs, 1);
  const library = await app.service.call('librarySave', { title: '更新验证' });
  const note = await app.service.call('save', { type: 'note', data: { title: '未保存保护', content: '原正文', domain: library.data.domain } });
  await page.locator('[data-nav=notes]').click();
  await page.locator(`[data-record="${note.id}"]`).click();
  rejectSaves = true;
  await page.locator('.tiptap').click(); await page.keyboard.press('End'); await page.keyboard.type('不能丢失');
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-update=install]').click();
  await page.locator('#toast', { hasText: '请先保存笔记和整理偏好' }).waitFor();
  assert.equal(installs, 1);
  assert.equal(app.service.store.get(note.id).data.content, '原正文');
  rejectSaves = false;
  await page.locator('[data-nav=notes]').click();
  await page.locator(`[data-record="${note.id}"]`).click();
  assert.match(await page.locator('.tiptap').innerText(), /不能丢失/);
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=save]')?.dataset.status === 'saved');
  assert.match(app.service.store.get(note.id).data.content, /不能丢失/);
  await page.locator('[data-nav=settings]').click();
  for (const width of [1304, 1001, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('#upgrade-settings').evaluate(element => element.scrollIntoView({ block: 'start' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const box = await page.locator('[data-update=install]').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.screenshot({ path: path.join(root, `downloaded-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: pause/resume/restart/failure recovery, preview restrictions, progress across navigation, unsaved preferences, explicit install and responsive layouts. No real installer executed.');
} finally { await browser?.close(); await app.close(); }
