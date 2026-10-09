import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = path.resolve('artifacts/desktop');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'profile-'));
const packaged = process.argv.includes('--packaged');
const application = await electron.launch({
  executablePath: packaged ? path.resolve('release/win-unpacked/StudySelf.exe') : electronPath,
  args: [...(packaged ? [] : [path.resolve('.')]), '--smoke-test', `--data-dir=${profile}`],
  timeout: 40000
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.desktop && !!document.querySelector('[data-nav="notes"]'));
  const data = await page.evaluate(async () => {
    const original = await window.desktop.call('save', { type: 'note', data: { title: '桌面启动验证', content: '独立 SQLite 数据库与安全 IPC 已连接。', domain: 'AI' } });
    await window.desktop.call('providerSave', { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com', apiKey: 'native-smoke-test-not-a-real-key' });
    return { note: original, state: await window.desktop.call('state') };
  });
  assert.equal(data.note.data.title, '桌面启动验证');
  assert.equal(data.state.idleBackup.supported, true);
  assert.equal(data.state.providers.find(p => p.id === 'deepseek').hasKey, true);
  assert.ok(!JSON.stringify(data.state).includes('native-smoke-test-not-a-real-key'));
  await page.reload();
  await page.locator('.record-row', { hasText: '桌面启动验证' }).click();
  await page.locator('.tiptap').waitFor();
  const captured = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString('base64');
  });
  assert.ok(captured.length > 2000, 'Native renderer returned an empty capture');
  fs.writeFileSync(path.join(root, packaged ? 'packaged-window.png' : 'development-window.png'), Buffer.from(captured, 'base64'));
  const encryption = await application.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  assert.equal(encryption, true);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, packaged ? 'packaged-report.json' : 'development-report.json'),
    JSON.stringify({ passed: true, packaged, nativeEncryption: encryption, errors }, null, 2));
  console.log(`PASS: ${packaged ? 'packaged' : 'development'} Electron launch, SQLite, secure IPC, Windows secret encryption, rich editor.`);
} finally { await application.close(); }
