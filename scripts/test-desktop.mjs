import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { call as mcpCall } from '../skills/fengzaiy/scripts/client.mjs';
import assert from 'node:assert/strict';
import { docxFixture } from './fixtures/docx.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skillExportFiles } from '../web/skill-export.js';

const root = path.resolve('artifacts/desktop');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'profile-'));
const packaged = process.argv.includes('--packaged');
const productName = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).build.productName;
const migratedProfile = fs.mkdtempSync(path.join(root, 'migrated-'));
let migrationNoteId, migrationPairingKey;
const application = await electron.launch({
  executablePath: packaged ? path.resolve('release/win-unpacked', `${productName}.exe`) : electronPath,
  args: [...(packaged ? [] : [path.resolve('.')]), '--smoke-test', `--data-dir=${profile}`],
  timeout: 40000
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on('requestfailed', request => { if (request.url().startsWith('fengzaiy-media:')) console.error('Native media request failed:', request.failure()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.desktop && !!document.querySelector('[data-nav="notes"]'));
  assert.match(await page.evaluate(() => navigator.userAgent), /FengZaiY\//);
  assert.doesNotMatch(await page.evaluate(() => navigator.userAgent), /[^\x20-\x7e]/);
  if (!packaged) {
    const update = await page.evaluate(() => window.desktop.call('updateStatus'));
    assert.equal(update.phase, 'development');
    await assert.rejects(page.evaluate(() => window.desktop.call('updateCheck')), /Windows/);
    await assert.rejects(page.evaluate(() => window.desktop.call('updateInstall', { rendererReady: true })), /下载/);
    await page.evaluate(() => window.desktop.call('updateConfigure', { autoCheck: false }));
    assert.equal((await page.evaluate(() => window.desktop.call('updateStatus'))).autoCheck, false);
    await page.locator('[data-nav=settings]').click();
    await page.locator('#upgrade-settings', { hasText: '桌面开发模式' }).waitFor();
    assert.equal(await page.locator('[data-update=check]').isDisabled(), true);
    await page.locator('[data-action=skill-manage]').click();
    await page.locator('[data-skill-tab=installs]').click();
    await page.locator('[data-install-add]').waitFor();
    const skill = await page.evaluate(() => window.desktop.call('agentSkill'));
    const installed = path.join(fs.mkdtempSync(path.join(root, 'skill-')), 'FengZaiY');
    for (const [name, content] of Object.entries(skillExportFiles(skill))) {
      fs.mkdirSync(path.dirname(path.join(installed, name)), { recursive: true }); fs.writeFileSync(path.join(installed, name), content);
    }
    fs.unlinkSync(path.join(installed, 'manifest.json'));
    const linked = await page.evaluate(async directory => {
      const preview = await window.desktop.call('skillInstallPreview', { directory });
      return window.desktop.call('skillInstallConfirm', { token: preview.token, confirmed: true });
    }, installed);
    await page.evaluate(async id => {
      const preview = await window.desktop.call('skillInstallPreview', { id, action: 'update' });
      return window.desktop.call('skillInstallConfirm', { token: preview.token, confirmed: true });
    }, linked.id);
    assert.ok(fs.existsSync(path.join(installed, 'manifest.json')));
    await page.evaluate(id => window.desktop.call('skillInstallUnlink', { id, confirmed: true }), linked.id);
    assert.ok(fs.existsSync(path.join(installed, 'SKILL.md')));
    await page.locator('[data-nav=notes]').click();
  }
  const data = await page.evaluate(async () => {
    const original = await window.desktop.call('save', { type: 'note', data: { title: '桌面启动验证', content: '独立 SQLite 数据库与安全 IPC 已连接。', domain: 'AI' } });
    await window.desktop.call('agentConfigure', { enabled: true });
    const grant = await window.desktop.call('agentGrant', { name: '桌面测试 Agent', domains: ['AI'] });
    return { note: original, state: await window.desktop.call('state'), access: await window.desktop.call('agentStatus'), token: grant.token };
  });
  assert.equal(data.note.data.title, '桌面启动验证');
  if (!packaged) {
    const integrity = await page.evaluate(async () => {
      await window.desktop.call('workspacePublish', { tabs: [], selectedTab: undefined });
      return window.desktop.call('syncIntegrity');
    });
    assert.equal(integrity.invalid, 0);
    assert.equal(integrity.compatible, 0);
  }
  assert.equal('idleBackup' in data.state, false);
  assert.equal('backups' in data.state, false);
  assert.equal(await page.locator('[data-nav="backup"]').count(), 0);
  await assert.rejects(page.evaluate(() => window.desktop.call('backupCreate')), /Unsupported/);
  assert.equal(data.access.enabled, true);
  assert.ok(!JSON.stringify(data.access).includes(data.token));
  const record = await mcpCall('record', { id: data.note.id }, undefined, { FENGZAIY_AGENT_URL: data.access.mcpUrl, FENGZAIY_AGENT_TOKEN: data.token });
  assert.equal(record.data.title, '桌面启动验证');
  if (!packaged) {
    const mcp = new Client({ name: 'fengzaiy-desktop-test', version: '1.0.0' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(data.access.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${data.token}` } } }));
      assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'FengZaiY_propose'));
      const result = await mcp.callTool({ name: 'FengZaiY_record', arguments: { id: data.note.id } });
      assert.equal(result.structuredContent.value.data.title, '桌面启动验证');
    } finally { await mcp.close(); }
    await page.locator('[data-nav="agents"]').click();
    await page.locator('#agent-mcp-copy-url').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制');
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), data.access.mcpUrl);
    for (const client of ['codex', 'http']) {
      await page.locator('#agent-mcp-client').selectOption(client);
      await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
      await page.locator('#agent-mcp-copy-config').click();
      await page.waitForFunction(() => document.querySelector('#toast').textContent === '已复制');
      assert.equal((await application.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n'), await page.locator('#agent-mcp-config').inputValue());
    }
    await page.locator('[data-nav="notes"]').click();
  }
  await page.reload();
  await page.locator('[data-record]', { hasText: '桌面启动验证' }).click();
  await page.locator('.tiptap').waitFor();
  const imagePath = path.join(profile, 'native-image.png');
  const imageData = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3a8197'; ctx.fillRect(0, 0, 240, 140); ctx.fillStyle = '#f4da78'; ctx.fillRect(30, 30, 180, 80); return canvas.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(imagePath, Buffer.from(imageData, 'base64'));
  const asset = await page.evaluate(file => window.desktop.call('assetImport', { path: file, domain: 'AI' }), imagePath);
  if (!packaged) {
    assert.equal(await page.getByRole('button', { name: '交互阅读', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '复制设计请求', exact: true }).count(), 0);
    assert.equal(await page.locator('iframe.interactive-page').count(), 0);
    await page.locator('.tiptap').waitFor({ state: 'visible' });
    await assert.rejects(page.evaluate(() => window.desktop.call('save', {
      type: 'note', data: { title: '已移除', domain: 'AI', presentation: null }
    })), /交互阅读已移除/);
  }
  await page.evaluate(async ({ asset, note }) => {
    const block = { v: 1, kind: 'image', label: '原生媒体', assetId: asset.id };
    const formula = { v: 1, kind: 'formula', label: '公式', source: 'E=mc^2' };
    const html = [block, formula].map(value => `<figure data-ss-block="${JSON.stringify(value).replaceAll('"', '&quot;')}"><figcaption>${value.label}</figcaption></figure>`).join('');
    await window.desktop.call('save', { id: note.id, type: 'note', parents: note.heads, data: { ...note.data, format: 'html', content: html } });
  }, { asset, note: data.note });
  await page.reload(); await page.locator('.tiptap .katex').waitFor();
  await page.waitForFunction(() => document.querySelector('.tiptap img')?.naturalWidth === 240).catch(async error => {
    console.error('Native image diagnostic:', await page.evaluate(async id => {
      const img = document.querySelector('.tiptap img');
      const detail = await window.desktop.call('assetDetail', { id });
      let preview;
      try { const data = await window.desktop.call('assetContent', { id }); preview = { mime: data.mime, bytes: data.data?.length }; } catch (e) { preview = e.message; }
      return { src: img?.src, width: img?.naturalWidth, detail, preview };
    }, asset.id));
    console.error('Native media response:', await application.evaluate(async ({ net }, id) => { const response = await net.fetch(`fengzaiy-media://asset/${id}`); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }, asset.id));
    throw error;
  });
  await page.locator('#file-input').setInputFiles(imagePath);
  await page.locator('.tiptap').evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector('#file-input').files[0]);
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.x + 15, clientY: rect.y + 10 }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.tiptap img').length === 2);
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  const dropped = await page.evaluate(id => window.desktop.call('record', { id }), data.note.id);
  assert.equal((dropped.data.content.match(/data-ss-block=/g) || []).length, 3);
  assert.equal(dropped.data.content.includes(profile), false, 'Dropped file path leaked into note');
  const firstMedia = page.locator('.tiptap .rich-block').first();
  const northEdge = firstMedia.locator('[data-resize-edge=n]');
  await northEdge.scrollIntoViewIfNeeded(); const edgeBox = await northEdge.boundingBox();
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2); await page.mouse.down();
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2 + 80, { steps: 6 }); await page.mouse.up();
  await firstMedia.scrollIntoViewIfNeeded(); const mediaBox = await firstMedia.boundingBox();
  await page.mouse.move(mediaBox.x + 60, mediaBox.y + 60); await page.mouse.down();
  await page.locator('.block-drag-preview').waitFor();
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.block-drag-preview').count(), 0);
  await page.waitForFunction(() => document.querySelector('[data-action=save]').dataset.status === 'saved');
  assert.match((await page.evaluate(id => window.desktop.call('record', { id }), data.note.id)).data.content, /data-ss-layout/);
  await assert.rejects(page.evaluate(() => window.desktop.importFile(new File(['x'], 'synthetic.txt'), 'AI')), /剪贴板/);
  const pasted = await page.evaluate(async encoded => {
    const image = new File([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], 'clipboard.png', { type: 'image/png' });
    return window.desktop.importFile(image, 'AI');
  }, imageData);
  assert.equal(pasted.data.mime, 'image/png');
  assert.equal(pasted.data.sha256, asset.data.sha256);
  await application.evaluate(({ dialog, shell }, file) => {
    globalThis.fengzaiyTestDialogs = { choose: dialog.showOpenDialog, message: dialog.showMessageBox, open: shell.openPath };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    dialog.showMessageBox = async () => ({ response: 1 });
    shell.openPath = async value => { globalThis.fengzaiyTestOpened = value; return ''; };
  }, imagePath);
  const localLink = await page.evaluate(() => window.desktop.call('bindLocalFile'));
  assert.equal(localLink.name, 'native-image.png'); assert.ok(!JSON.stringify(localLink).includes(profile));
  await page.evaluate(id => window.desktop.call('openLocalFile', { id }), localLink.id);
  assert.equal(await application.evaluate(() => globalThis.fengzaiyTestOpened), imagePath);
  const libraryDirectory = await page.evaluate(async () => {
    const library = (await window.desktop.call('state')).libraries[0];
    await window.desktop.call('libraryOpenFolder', { id: library.id });
    return library.localDirectory;
  });
  assert.equal(path.dirname(libraryDirectory), profile);
  assert.equal(await application.evaluate(() => globalThis.fengzaiyTestOpened), libraryDirectory);
  await application.evaluate(({ dialog }) => { globalThis.fengzaiyTestOpened = null; dialog.showMessageBox = async () => ({ response: 0 }); });
  assert.equal(await page.evaluate(id => window.desktop.call('openLocalFile', { id }), localLink.id), false);
  assert.equal(await application.evaluate(() => globalThis.fengzaiyTestOpened), null);
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(profile, 'not-allowed.exe'));
  await assert.rejects(page.evaluate(() => window.desktop.call('bindLocalFile')), /只允许本机/);
  await assert.rejects(page.evaluate(() => window.desktop.call('openLocalFile', { id: '11111111-1111-1111-1111-111111111111' })), /尚未绑定/);
  await application.evaluate(({ dialog, shell }) => { const old = globalThis.fengzaiyTestDialogs; dialog.showOpenDialog = old.choose; dialog.showMessageBox = old.message; shell.openPath = old.open; });
  await page.locator('[data-nav="assets"]').click();
  const nativeThumbnail = page.locator(`[data-material-row="${asset.id}"] .material-thumbnail`);
  await nativeThumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`[data-material-row="${id}"] .material-thumbnail`)?.dataset.thumbnailState === 'ready', asset.id);
  assert.equal(await nativeThumbnail.locator('img').evaluate(el => el.naturalWidth), 240);
  assert.ok((await nativeThumbnail.locator('img').getAttribute('src')).startsWith('fengzaiy-media://asset/'));
  await page.screenshot({ path: path.join(root, 'asset-thumbnails-native.png') });
  const wordPath = path.join(profile, 'desktop-preview.docx');
  fs.writeFileSync(wordPath, await docxFixture({ image: Buffer.from(imageData, 'base64') }));
  const wordNote = await page.evaluate(async file => {
    const asset = await window.desktop.call('assetImport', { path: file, domain: 'AI' });
    return window.desktop.call('save', { type: 'note', data: { title: '桌面 Word 预览', domain: 'AI', format: 'html',
      content: `<p><a href="fengzaiy://asset/${asset.id}">Word 原资料</a></p>`, assetIds: [asset.id] } });
  }, wordPath);
  await page.locator('[data-nav="notes"]').click();
  await page.locator(`[data-record="${wordNote.id}"]`).click();
  if (await page.locator('[data-action=toggle-source]').getAttribute('aria-expanded') === 'true')
    await page.locator('[data-action=toggle-source]').click();
  await page.locator('.tiptap a').click();
  await page.frameLocator('#modal iframe.docx-preview').getByRole('heading', { name: '学习资料阅读预览' }).waitFor();
  assert.equal(await page.frameLocator('#modal iframe.docx-preview').locator('table td').count(), 4);
  assert.equal(await page.locator('#modal iframe.docx-preview').getAttribute('sandbox'), '');
  await page.screenshot({ path: path.join(root, 'docx-preview-native.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('[data-nav="notes"]').click();
  await page.locator(`[data-record="${data.note.id}"]`).click();
  await page.locator('.tiptap').waitFor();
  const captured = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString('base64');
  });
  assert.ok(captured.length > 2000, 'Native renderer returned an empty capture');
  fs.writeFileSync(path.join(root, packaged ? 'packaged-window.png' : 'development-window.png'), Buffer.from(captured, 'base64'));
  const encryption = await application.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  assert.equal(encryption, true);
  const userData = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(userData), path.join(profile, 'electron-profile'));
  assert.deepEqual(errors, []);
  migrationNoteId = data.note.id;
  migrationPairingKey = (await page.evaluate(() => window.desktop.call('pairingKey'))).key;
  await page.evaluate(({ folder, key }) => window.desktop.call('syncConfigure', { folder, key }), { folder: `${profile}-sync`, key: migrationPairingKey });
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#storage-current').inputValue(), profile);
  await application.evaluate(({ dialog }) => {
    globalThis.storageOriginalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.locator('[data-mode="select"]').click();
  assert.equal(await page.locator('#modal').isVisible(), false);
  await application.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, migratedProfile);
  await page.locator('[data-mode="select"]').click();
  await page.waitForFunction(expected => document.querySelector('#storage-target')?.value === expected, migratedProfile);
  await page.locator('#storage-form button[type="submit"]').click();
  await page.locator('[data-confirm]').click();
  await page.locator('#storage-pending').waitFor();
  assert.equal(await page.locator('[data-action="storage-restart"]').isVisible(), true);
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.storageOriginalDialog; });
  fs.writeFileSync(path.join(root, packaged ? 'packaged-report.json' : 'development-report.json'),
    JSON.stringify({ passed: true, packaged, isolatedProfile: true, nativeEncryption: encryption, errors }, null, 2));
  console.log(`PASS: ${packaged ? 'packaged' : 'development'} Electron launch, SQLite, secure IPC, Windows encryption, rich editor, native media and confirmed local-file binding.`);
} finally { await application.close(); }

const restarted = await electron.launch({ executablePath: packaged ? path.resolve('release/win-unpacked', `${productName}.exe`) : electronPath,
  args: [...(packaged ? [] : [path.resolve('.')]), '--smoke-test', `--data-dir=${profile}`], timeout: 40000 });
try {
  const page = await restarted.firstWindow();
  await page.waitForFunction(() => !!document.querySelector('[data-nav="settings"]'));
  const state = await page.evaluate(() => window.desktop.call('state'));
  if (!packaged) assert.equal((await page.evaluate(() => window.desktop.call('updateStatus'))).autoCheck, false);
  assert.equal(state.localDataDirectory, migratedProfile);
  assert.equal((await page.evaluate(id => window.desktop.call('record', { id }), migrationNoteId)).data.title, '桌面启动验证');
  assert.equal((await page.evaluate(() => window.desktop.call('pairingKey'))).key, migrationPairingKey);
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#storage-current').inputValue(), migratedProfile);
  const image = await restarted.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage({}, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, 'storage-migrated-window.png'), Buffer.from(image, 'base64'));
  fs.writeFileSync(path.join(root, 'storage-report.json'), JSON.stringify({ passed: true, nativePicker: true, restartMigration: true, encryptedCredentialPreserved: true }, null, 2));
  console.log('PASS: native storage picker, cancelled selection, restart migration, original retention and encrypted credentials.');
} finally { await restarted.close(); }
