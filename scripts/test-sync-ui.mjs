import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { makePairingKey } from '../src/core/transport.mjs';

const root = path.resolve('artifacts/ui-sync');
fs.mkdirSync(root, { recursive: true });
const base = fs.mkdtempSync(path.join(root, 'case-'));
const local = await createServer({ directory: path.join(base, 'local'), port: 0 });
const remote = await createServer({ directory: path.join(base, 'remote'), port: 0 });
const cloud = path.join(base, 'cloud'), key = makePairingKey(), errors = [];
let browser, page, releaseScan;
try {
  const library = await local.service.call('librarySave', { title: '界面隔离资料' });
  const note = await local.service.call('save', { type: 'note', data: { title: '本机笔记', domain: library.data.domain, content: '原始正文' } });
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  page = await browser.newPage({ viewport: { width: 1464, height: 906 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(local.url);
  await page.getByRole('button', { name: '多电脑同步', exact: true }).click();
  assert.equal(await page.locator('#sync-settings').getAttribute('open'), '');
  assert.equal(await page.locator('[data-action=sync-publish]').isDisabled(), true);
  assert.equal(await page.locator('[data-action=sync-import]').isDisabled(), true);
  assert.equal(await page.locator('#main [data-action=sync-scan]').count(), 1);
  await page.locator('#sync-folder').fill(cloud);
  await page.locator('#sync-key').fill(key);
  await page.locator('#sync-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#sync-config-state')?.textContent === '已配对');
  assert.equal(await page.locator('#sync-settings').getAttribute('open'), null);
  await page.locator('#sync-settings > summary').click();
  await page.locator('#sync-folder').fill(path.join(base, 'unsaved-directory'));
  await page.locator('#sync-key').fill('unsaved-pairing-input');
  await page.locator('[data-action=sync-scan]').click();
  await page.locator('#sync-receive').getByText('尚未发现其他电脑的更新', { exact: true }).waitFor();
  assert.equal(await page.locator('#sync-folder').inputValue(), path.join(base, 'unsaved-directory'));
  assert.equal(await page.locator('#sync-key').inputValue(), 'unsaved-pairing-input');
  assert.equal(local.service.transport.config().folder, cloud);
  await page.locator('#sync-settings > summary').click();
  await page.locator('[data-sync-detail=options] > summary').click();
  await page.locator('#sync-batch-size').selectOption('16');
  await page.locator('[data-action=sync-plan]').click();
  await page.locator('#sync-task').getByText('已准备，等待生成', { exact: true }).waitFor();
  const job = local.service.transport.status().job;
  assert.equal(job.batchBytes, 16 * 1024 ** 2);
  assert.equal(await page.locator('#sync-batch-size').isDisabled(), true);
  await page.locator('[data-action=sync-publish]').click();
  await page.locator('#sync-task').getByText('等待确认百度上传', { exact: true }).waitFor();
  assert.equal(local.service.transport.status().latest.id, job.id);
  assert.equal(local.service.transport.status().config.cloudUploadVerified, false);
  assert.equal(await page.locator('#sync-task progress').count(), 0, 'completed tasks do not leave a permanent full progress bar');
  await page.locator('[data-action=sync-upload-confirm]').click();
  await page.locator('#modal [data-modal-close]').click();
  assert.equal(local.service.transport.status().latest.userConfirmedAt, undefined);
  await page.locator('[data-action=sync-upload-confirm]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator('#sync-task').getByText('本次上传已确认', { exact: true }).waitFor();
  assert.equal(local.service.transport.config().cloudUploadVerified, false);
  assert.equal(await page.locator('#sync-key').inputValue(), 'unsaved-pairing-input');
  await page.locator('[data-sync-detail=options] > summary').click();

  remote.service.store.setMeta('deviceName', '另一台电脑 · 独立测试');
  remote.service.transport.configure(cloud, key);
  await remote.service.call('syncImport');
  await remote.service.transport.setPrimary({ deviceId: remote.service.store.deviceId, parents: [], confirmed: true });
  const remoteNote = await remote.service.call('save', { type: 'note', data: { title: '另一台电脑的笔记', domain: library.data.domain, content: '待接收正文' } });
  const assetPath = path.join(base, 'sample.txt'); fs.writeFileSync(assetPath, 'isolated original');
  await remote.service.call('assetImport', { path: assetPath, domain: library.data.domain });
  await remote.service.call('syncPublish');
  const manifest = remote.service.transport.value('latest');
  const objectPath = remote.service.transport.channel().file(manifest.assets[0].chunks[0].name);
  const savedObject = fs.readFileSync(objectPath); fs.unlinkSync(objectPath);
  await page.locator('[data-action=sync-scan]').click();
  await page.locator('#sync-receive').getByText('下载文件需要检查', { exact: true }).waitFor();
  await page.locator('#sync-receive-mode').selectOption('index');
  await page.locator('[data-action=sync-import]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator('#sync-receive .sync-result').getByText(/原件保持待下载/).waitFor();
  assert.equal(local.service.store.get(remoteNote.id).data.content, '待接收正文');
  assert.equal(await page.locator('#sync-receive .sync-device-row').first().getByText('记录已合并', { exact: true }).count(), 1);
  assert.match(await page.locator('#sync-file-completeness').textContent(), /缺失或待接收/);
  fs.writeFileSync(objectPath, savedObject);
  await page.locator('#sync-receive-mode').selectOption('full');
  await page.locator('[data-action=sync-import]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator('#sync-receive .sync-result').getByText(/本次原件校验完成/).waitFor();
  assert.match(await page.locator('#sync-file-completeness').textContent(), /1 \/ 1 已就绪/);
  assert.doesNotMatch(await page.locator('#sync-receive').innerText(), /已接收.*待校验/);

  await local.service.call('save', { id: remoteNote.id, type: 'note', parents: remoteNote.heads, data: { ...remoteNote.data, content: '本机并发修改' } });
  await remote.service.call('save', { id: remoteNote.id, type: 'note', parents: remoteNote.heads, data: { ...remoteNote.data, content: '远端并发修改' } });
  await remote.service.call('syncPublish');
  await page.locator('[data-action=sync-import]').click();
  await page.locator('#modal [data-confirm]').click();
  await page.locator('#sync-receive .sync-conflict').waitFor();
  assert.equal(local.service.store.get(remoteNote.id).versions.length, 2);
  await page.locator('[data-action=sync-conflicts]').click();
  await page.locator(`[data-record="${remoteNote.id}"]`).first().waitFor();
  await page.getByRole('button', { name: '多电脑同步', exact: true }).click();
  await page.locator('[data-sync-detail=task]').evaluate(element => { element.open = false; });

  for (const width of [1464, 1220, 931, 600]) {
    await page.setViewportSize({ width, height: 906 });
    await page.locator('#main').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width >= 1220) {
      const send = await page.locator('#sync-send-title').boundingBox(), receive = await page.locator('#sync-receive-title').boundingBox();
      assert.ok(Math.abs(send.y - receive.y) < 2);
      assert.ok((await page.locator('[data-action=sync-import]').boundingBox()).y < 600);
    }
    await page.screenshot({ path: path.join(root, `overview-${width}.png`), fullPage: true });
    await page.locator('#sync-diagnostics').evaluate(element => { element.open = true; });
    await page.locator('#main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottom = await page.locator('[data-action=sync-integrity]').boundingBox();
    const footer = await page.locator('.statusbar').boundingBox();
    assert.ok(bottom.y >= 0 && bottom.y + bottom.height <= footer.y + 1);
    await page.screenshot({ path: path.join(root, `details-${width}.png`), fullPage: true });
    await page.locator('#sync-diagnostics').evaluate(element => { element.open = false; });
  }

  // Disconnect only this client; cancellation and stale confirmation retain the binding.
  await page.locator('#sync-settings').evaluate(element => { element.open = true; });
  await page.locator('#sync-folder').fill(path.join(base, 'unsaved-disconnect-folder'));
  await page.locator('[data-action=sync-disconnect]').click();
  await page.locator('#modal [data-confirm]').waitFor();
  assert.match(await page.locator('#modal').innerText(), /百度客户端/);
  await page.locator('#modal [data-modal-close]').click();
  assert.equal(local.service.transport.config().configured, true);
  assert.equal(await page.locator('#sync-folder').inputValue(), path.join(base, 'unsaved-disconnect-folder'));
  await page.locator('[data-action=sync-disconnect]').click();
  await page.locator('#modal [data-confirm]').waitFor();
  await local.service.call('syncConfigure', { folder: cloud, key });
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('重新确认解除绑定'));
  assert.equal(local.service.transport.config().configured, true);
  await local.service.call('syncPlan');
  await page.locator('[data-action=sync-disconnect]').click();
  await page.locator('#modal [data-confirm]').waitFor();
  assert.match(await page.locator('#modal').innerText(), /发布任务将一并取消/);
  for (const width of [1220, 600]) {
    await page.setViewportSize({ width, height: 892 });
    await page.locator('#modal [data-confirm]').scrollIntoViewIfNeeded();
    const confirm = await page.locator('#modal [data-confirm]').boundingBox();
    assert.ok(confirm.y >= 0 && confirm.y + confirm.height <= 892);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, `disconnect-${width}.png`), fullPage: true });
  }
  const eventsBeforeDisconnect = local.service.store.allEvents();
  await page.locator('#modal [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#sync-config-state')?.textContent === '未配置');
  await page.waitForFunction(() => !document.querySelector('#sync-form button[type=submit]')?.disabled);
  assert.equal(await page.locator('#sync-folder').inputValue(), '');
  assert.equal(await page.locator('#sync-key').inputValue(), '');
  assert.equal(await page.locator('[data-action=sync-disconnect]').count(), 0);
  assert.equal(await page.locator('[data-action=sync-publish]').isDisabled(), true);
  assert.equal(await page.locator('[data-action=sync-import]').isDisabled(), true);
  assert.equal(await page.locator('#sync-settings').getAttribute('open'), '');
  assert.equal(await page.locator('#sync-receive .sync-device-row').count(), 0);
  assert.deepEqual(local.service.store.allEvents(), eventsBeforeDisconnect);
  assert.equal(remote.service.transport.config().configured, true);
  await page.reload();
  await page.getByRole('button', { name: '多电脑同步', exact: true }).click();
  await page.locator('#sync-folder').fill(cloud);
  await page.locator('#sync-key').fill(key);
  await page.locator('#sync-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#sync-config-state')?.textContent === '已配对');
  assert.equal(local.service.transport.progress().state, 'cancelled');

  // A late response must update only sync state, never rebuild an editor on another page.
  const originalScan = local.service.transport.scan.bind(local.service.transport);
  let scans = 0;
  local.service.transport.scan = async () => { scans++; await new Promise(resolve => { releaseScan = resolve; }); return originalScan(); };
  await page.locator('[data-action=sync-scan]').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('#sync-receive')?.textContent.includes('正在检查同步目录'));
  assert.equal(await page.locator('[data-action=sync-disconnect]').isDisabled(), true);
  await page.locator('[data-nav=notes]').click();
  await page.locator(`[data-record="${note.id}"]`).first().click();
  await page.locator('.tiptap').waitFor();
  await page.locator('.tiptap').fill('切页后保留的输入');
  await page.locator('.tiptap').evaluate(element => { window.syncTestEditor = element; });
  releaseScan();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('最新内容清单'));
  assert.equal(scans, 1);
  assert.equal(await page.locator('.tiptap').evaluate(element => window.syncTestEditor === element), true);
  assert.equal(await page.locator('.tiptap').innerText(), '切页后保留的输入');
  local.service.transport.scan = originalScan;
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, errors, checks: ['setup', 'preserve configuration input', 'batch selection and freeze', 'upload cancel and explicit confirmation', 'index-only then complete receive', 'record versus original status', 'disconnect cancel/stale/confirm/reload/reconnect', 'duplicate actions', 'late completion preserves editor', 'responsive layout and bottom access'] }, null, 2));
  console.log('PASS: synchronization workflow, preserved input, confirmation, index/full reception, duplicate and late actions, responsive layout.');
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  releaseScan?.();
  await browser?.close(); await local.close(); await remote.close();
}
