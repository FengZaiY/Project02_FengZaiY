import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve('artifacts/personal-desktop'); fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'profile-'));
console.log(`Isolated desktop profile: ${profile}`);
let application, pid;
try {
  application = await electron.launch({ executablePath: electronPath, args: [path.resolve('.'), '--smoke-test', '--test-exit', `--data-dir=${profile}`], timeout: 40000 });
  pid = application.process().pid;
  console.log(`Isolated desktop PID: ${pid}`);
  application.process().stderr?.on('data', data => process.stderr.write(data));
  application.process().once('exit', (code, signal) => console.log(`Isolated desktop exit: ${code}, ${signal || 'no signal'}`));
  const page = await application.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-nav=tasks]').waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      globalThis.__fengzaiExport = { path: item.getSaveDialogOptions().defaultPath, state: 'saving' };
      item.setSavePath(globalThis.__fengzaiExport.path);
      item.once('done', (_done, state) => { globalThis.__fengzaiExport.state = state; });
    });
  });
  await page.locator('[data-nav=finance]').click(); await page.locator('[data-personal=export]').click();
  const exportDeadline = Date.now() + 10000; let exported;
  do {
    exported = await application.evaluate(() => globalThis.__fengzaiExport);
    if (exported?.state === 'completed') break;
    await page.waitForTimeout(100);
  } while (Date.now() < exportDeadline);
  assert.equal(exported?.state, 'completed');
  assert.equal(path.dirname(exported.path), path.join(profile, '.fengzai-y', 'exports'));
  assert.match(fs.readFileSync(exported.path, 'utf8'), /"date","title","kind"/);
  await application.evaluate(({ clipboard }) => { globalThis.__fengzaiTestClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]); });
  const account = await page.evaluate(async () => {
    const account = await window.desktop.call('personalSave', { type: 'loginAccount', data: { title: '桌面验证账号' } });
    const setup = await window.desktop.call('vaultSetup', { password: 'desktop-master-password' });
    await window.desktop.call('vaultSetupConfirm', { token: setup.token, confirmed: true });
    await window.desktop.call('vaultSave', { accountId: account.id, value: { password: 'isolated-desktop-secret' } });
    return account;
  });
  await page.locator('[data-nav=accounts]').click(); await page.locator(`[data-personal-id="${account.id}"]`).click();
  await page.locator('[data-personal=secret]').click(); await page.locator('#secret-form').waitFor();
  await page.locator('#secret-copy').click();
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'isolated-desktop-secret');
  await application.evaluate(({ clipboard }) => clipboard.writeText('later clipboard text'));
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await page.locator('#secret-form').waitFor({ state: 'detached' });
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'later clipboard text');
  assert.equal((await page.evaluate(() => window.desktop.call('vaultStatus'))).unlocked, false);
  await page.evaluate(async () => { await window.desktop.call('vaultUnlock', { password: 'desktop-master-password' }); await window.desktop.call('vaultCopy', { value: 'expiring-test-secret' }); });
  await page.waitForTimeout(31000);
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), '');
  await application.evaluate(({ clipboard }) => { if (clipboard.readText() === '') { clipboard.clear(); for (const [format, bytes] of globalThis.__fengzaiTestClipboard || []) clipboard.writeBuffer(format, bytes); } delete globalThis.__fengzaiTestClipboard; });
  await page.locator('[data-nav=tasks]').click(); await page.locator('[data-personal=new]').click();
  await page.locator('#personal-form [name=title]').fill('退出前待保存的任务');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.locator('#exit-confirm').waitFor();
  await page.waitForFunction(() => document.querySelector('#exit-confirm')?.textContent === '保存后退出');
  assert.ok((await page.locator('#exit-check-status').textContent()).includes('退出前待保存的任务'));
  const screenshot = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, 'exit-personal-draft.png'), Buffer.from(screenshot, 'base64'));
  assert.deepEqual(errors, []);
  await page.locator('#exit-confirm').click(); await application.waitForEvent('close', { timeout: 30000 }); application = null;
  const db = new DatabaseSync(path.join(profile, 'knowledge.sqlite'), { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 FROM events WHERE type='personalTask' AND json_extract(json,'$.data.title')=?").get('退出前待保存的任务'));
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM local_config WHERE key='personalDrafts'").get().value), {});
  } finally { db.close(); }
  console.log('Personal desktop passed: workspace exports, native clipboard timeout, simulated lock-screen, encrypted vault and save-before-exit.');
} finally {
  if (application) {
    await application.evaluate(({ clipboard }) => { if (['', 'isolated-desktop-secret', 'later clipboard text', 'expiring-test-secret'].includes(clipboard.readText()) && globalThis.__fengzaiTestClipboard) { clipboard.clear(); for (const [format, bytes] of globalThis.__fengzaiTestClipboard) clipboard.writeBuffer(format, bytes); } delete globalThis.__fengzaiTestClipboard; }).catch(() => {});
    try { await Promise.race([application.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 8000).unref())]); }
    catch { if (pid && application.process().exitCode === null) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } }
  }
}
