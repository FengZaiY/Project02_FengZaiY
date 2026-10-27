import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const output = path.resolve('artifacts/audit-fixes-desktop'); fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-repair-desktop-'));
const profile = path.join(root, 'profile');
const application = await electron.launch({ executablePath: electronPath,
  args: [path.resolve('.'), '--smoke-test', '--test-exit', `--data-dir=${profile}`], timeout: 40000 });
let page;
const screenshot = async name => {
  const image = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(output, name), Buffer.from(image, 'base64'));
};
try {
  page = await application.firstWindow(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('[data-nav=settings]');
  await page.evaluate(() => window.desktop.onExitRequest(request => { window.auditExit = request; }));
  const copy = async (button, target, expected) => {
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await page.locator(button).click();
    await page.locator('#toast', { hasText: '已复制' }).waitFor();
    assert.ok((await application.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n') === expected, 'Clipboard matches the requested value');
    await page.evaluate(() => {
      window.auditClipboard = { write: navigator.clipboard.writeText, command: document.execCommand };
      navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
      document.execCommand = () => false;
    });
    try {
      await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
      await page.locator(button).click(); await page.locator('#toast', { hasText: 'Ctrl+C' }).waitFor();
      const selected = await page.locator(target).evaluate(element => 'value' in element
        ? element.value.slice(element.selectionStart, element.selectionEnd) : window.getSelection().getRangeAt(0).toString());
      assert.ok(selected === expected, 'Manual selection contains the complete requested value');
    } finally {
      await page.evaluate(() => { navigator.clipboard.writeText = window.auditClipboard.write; document.execCommand = window.auditClipboard.command; delete window.auditClipboard; });
    }
  };
  await page.locator('[data-nav=settings]').click();
  await copy('[data-action=storage-copy]', '#storage-current', profile);
  await page.locator('[data-action=skill-manage]').click(); await page.locator('[data-skill-tab=files]').click();
  await copy('#skill-file-copy', '#skill-file-body', await page.locator('#skill-file-body').textContent());
  await screenshot('skill-copy-manual.png');
  await page.locator('[data-nav=agents]').click();
  await page.locator('#agent-grant-form input[name=name]').fill('Isolated clipboard regression');
  await page.locator('#agent-grant-form button[type=submit]').click();
  await page.locator('#agent-token').waitFor();
  await copy('#agent-token-copy', '#agent-token', await page.locator('#agent-token').inputValue());
  assert.equal(await page.locator('#agent-token').getAttribute('type'), 'text');
  assert.equal(await page.locator('#agent-token-visible').isChecked(), true);
  await page.locator('#modal [data-modal-close]').click();
  await page.locator('#agent-token').waitFor({ state: 'detached' });

  const library = await page.evaluate(() => window.desktop.call('librarySave', { title: 'Restart protection' }));
  await page.evaluate(directory => window.desktop.call('storageSchedule', { mode: 'migrate', directory }), path.join(root, 'target'));
  await page.locator('[data-nav=settings]').click();
  await page.locator('[data-skill-tab=preferences]').click();
  await page.locator('#agent-preferences-form textarea').fill('Unsaved preference');
  await page.locator('[data-action=storage-restart]').click();
  await page.locator('#exit-check-status', { hasText: '整理偏好尚未保存' }).waitFor();
  assert.equal(await page.locator('#exit-confirm').isDisabled(), true);
  await screenshot('restart-preference-protected.png');
  await page.locator('#exit-continue').click();
  await page.locator('#agent-preferences-form button[type=submit]').click();
  await page.locator('#skill-edit-status', { hasText: '已保存' }).waitFor();
  await page.evaluate(() => window.desktop.call('localHierarchyRefresh'));
  await application.evaluate(() => {
    const fs = process.getBuiltinModule('fs');
    globalThis.auditCopy = fs.promises.copyFile;
    fs.promises.copyFile = async (...args) => {
      if (args[0] === globalThis.auditFile) {
        globalThis.auditEntered = true;
        await new Promise(resolve => { globalThis.auditRelease = resolve; });
      }
      return globalThis.auditCopy(...args);
    };
  });
  const pauseImport = async index => {
    const file = path.join(root, `import-${index}.txt`); fs.writeFileSync(file, `import ${index}`);
    await application.evaluate((_electron, filename) => { globalThis.auditFile = filename; globalThis.auditEntered = false; }, file);
    await page.evaluate(({ file, domain }) => { window.auditImport = window.desktop.call('assetImport', { path: file, domain }); }, { file, domain: library.data.domain });
    for (let i = 0; i < 100 && !await application.evaluate(() => globalThis.auditEntered); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await application.evaluate(() => globalThis.auditEntered), true);
  };
  const releaseImport = async () => {
    await application.evaluate(() => globalThis.auditRelease());
    await page.evaluate(() => window.auditImport);
    await page.evaluate(() => window.desktop.call('localHierarchyRefresh'));
  };
  await pauseImport(1);
  const busy = await page.evaluate(() => window.desktop.callResult('storageRestart'));
  assert.equal(busy.error.code, 'BUSY'); assert.match(busy.error.message, /导入/);
  assert.equal(await page.locator('dialog[open] #exit-confirm').count(), 0);
  await releaseImport();
  await page.locator('[data-action=storage-restart]').click();
  await page.locator('#exit-confirm', { hasText: '重启' }).waitFor();
  await pauseImport(2);
  const late = await page.evaluate(() => window.desktop.callResult('exitFinish', { id: window.auditExit.id, rendererReady: true }));
  assert.equal(late.error.code, 'BUSY'); assert.match(late.error.message, /导入/);
  await releaseImport();
  await page.locator('#exit-continue').click();
  assert.equal(await page.locator('dialog[open]').count(), 0);

  const marker = path.join(root, 'relaunch.json');
  await application.evaluate(({ app, BrowserWindow }, { marker, profile }) => {
    const window = BrowserWindow.getAllWindows()[0];
    globalThis.auditClose = window.close.bind(window);
    window.close = () => { globalThis.auditCloseRequested = true; };
    app.relaunch = () => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
      fs.writeFileSync(marker, JSON.stringify({ workspaceLocked: fs.existsSync(path.join(profile, '.fengzaiy-lock.json')), locationLocked: fs.existsSync(`${profile}.storage.json.lock`) }));
    };
  }, { marker, profile });
  await page.locator('[data-action=storage-restart]').click();
  await page.waitForFunction(() => document.querySelector('#exit-confirm')?.textContent === '重启' && !document.querySelector('#exit-confirm').disabled);
  await screenshot('restart-ready.png');
  const finished = await page.evaluate(() => window.desktop.callResult('exitFinish', { id: window.auditExit.id, rendererReady: true }));
  assert.deepEqual(finished, { value: true });
  for (let i = 0; i < 100 && !await application.evaluate(() => globalThis.auditCloseRequested); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await application.evaluate(() => globalThis.auditCloseRequested), true);
  const exited = once(application.process(), 'exit');
  await application.evaluate(() => globalThis.auditClose()); await exited;
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { workspaceLocked: false, locationLocked: false });
  const db = new DatabaseSync(path.join(profile, 'knowledge.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 2); }
  finally { db.close(); }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, isolatedProfile: true,
    checks: ['credential/Skill/path clipboard and manual fallback', 'unsaved preferences', 'in-flight import', 'late import', 'cancel', 'close before relaunch', 'persisted originals'], errors }, null, 2));
  console.log('PASS: clipboard fallback, storage restart handshake, active/late import protection and close-before-relaunch.');
} catch (error) { await screenshot('failure.png').catch(() => {}); throw error; }
finally {
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.auditRelease?.();
    if (globalThis.auditCopy) process.getBuiltinModule('fs').promises.copyFile = globalThis.auditCopy;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  }).catch(() => {});
  await application.close().catch(() => {});
}
