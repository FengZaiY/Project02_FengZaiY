import { desktopProfilePath, legacyNames } from '../core/legacy-names.mjs';
import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, powerMonitor, protocol, clipboard, net } from 'electron';
import fs from 'node:fs';
import { workspaceInternalPath } from '../core/workspace-layout.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageLocation } from '../core/storage-location.mjs';
import { check, prettyError, uuid, isId, noSymlink, atomicWrite } from '../core/util.mjs';
import updaterPackage from 'electron-updater';
import { UpdateManager, assertUpdateIdle } from './updates.mjs';
import { attachUpdateDownload } from './update-download.mjs';
import { mediaResponse } from '../core/media.mjs';
import { importClipboardImage } from './clipboard-import.mjs';
import { ExitCheck, exitActivity } from './exit-check.mjs';
import { SecretClipboard } from './secret-clipboard.mjs';
import { userExportPath } from '../core/material-center.mjs';

protocol.registerSchemesAsPrivileged([{ scheme: 'fengzaiy-media', privileges: { standard: true, secure: true, stream: true } }]);

const base = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const profileArg = process.argv.find(arg => arg.startsWith('--data-dir='));
const smokeTest = process.argv.includes('--smoke-test');
// The installed product name changes, but existing workspace/profile identity stays stable.
app.setPath('userData', desktopProfilePath(app.getPath('appData')));
app.setName('FengZaiY');
if (smokeTest) {
  app.disableHardwareAcceleration();
  // Keep smoke-test Chromium state and its single-instance lock away from the user's app.
  if (profileArg) app.setPath('userData', path.join(path.resolve(profileArg.slice('--data-dir='.length)), 'electron-profile'));
}
let service, storage, window, updates;
const secretClipboard = new SecretClipboard(clipboard);
let activeCalls = 0, installingUpdate = false, allowClose = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
  const vault = {
    seal: value => { check(safeStorage.isEncryptionAvailable(), 'Windows credential encryption is unavailable'); return safeStorage.encryptString(value).toString('base64'); },
    open: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  };
  const anchor = profileArg ? path.resolve(profileArg.slice('--data-dir='.length)) : path.join(app.getPath('userData'), 'workspace');
  storage = new StorageLocation(anchor, { environment: 'desktop' });
  service = await storage.open({ vault, idleCheck: () => powerMonitor.getSystemIdleTime() });
  const directory = service.store.directory;
  protocol.handle('fengzaiy-media', async request => {
    try {
      check(!allowClose, '正在退出，请稍候');
      const url = new URL(request.url);
      check(url.hostname === 'asset' && isId(url.pathname.slice(1)), 'Invalid media reference');
      return await mediaResponse(service.store, url.pathname.slice(1), request.headers.get('range'), request.method);
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
  await service.agents.resume();
  const entry = path.join(base, 'dist', 'index.html');
  // Keep the product identifier ASCII for Chromium custom-protocol media requests.
  window = new BrowserWindow({ width: 1480, height: 940, minWidth: 800, minHeight: 660, backgroundColor: '#f7f8fa', show: !smokeTest,
    title: 'FengZaiY · 个人管理系统', autoHideMenuBar: true,
    webPreferences: { preload: path.join(base, 'src', 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, offscreen: smokeTest, backgroundThrottling: !smokeTest } });
  Menu.setApplicationMenu(null);
  service.passwordVault.onLock = () => { secretClipboard.clear(); if (!window.isDestroyed()) window.webContents.send('fengzaiy:vault-locked'); };
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => service.passwordVault.lock());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== new URL(`file:///${entry.replace(/\\/g, '/')}`).href) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.on('will-download', (event, item, contents) => {
    if (contents !== window.webContents || !item.getURL().startsWith('blob:')) { event.preventDefault(); return; }
    try { item.setSaveDialogOptions({ defaultPath: userExportPath(service.store, item.getFilename()), title: '导出文件' }); }
    catch (error) {
      event.preventDefault();
      void dialog.showMessageBox(window, { type: 'error', title: '无法导出文件', message: prettyError(error) });
    }
  });
  const updateSettingsFile = path.join(app.getPath('userData'), 'update-settings.json');
  let updateSettings = {};
  try { updateSettings = JSON.parse(fs.readFileSync(updateSettingsFile, 'utf8')); } catch {}
  const metadata = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  updates = new UpdateManager({ version: app.getVersion(), packaged: app.isPackaged, source: metadata.fengzaiyUpdateSource ?? metadata[legacyNames.updateSource],
    autoCheck: updateSettings.autoCheck !== false,
    saveAutoCheck: autoCheck => atomicWrite(updateSettingsFile, JSON.stringify({ autoCheck })),
    createUpdater: source => attachUpdateDownload(new updaterPackage.NsisUpdater(source), {
      directory: path.join(app.getPath('userData'), 'update-downloads'), fetch: (url, options) => net.fetch(url, options)
    }),
    notify: status => {
      if (installingUpdate && status.phase === 'error') {
        installingUpdate = false; allowClose = false;
        service.startTimer(); void service.agents.resume();
      }
      if (!window.isDestroyed()) window.webContents.send('fengzaiy:update-status', status);
    } });
  const exitCheck = new ExitCheck({
    send: request => window.webContents.send('fengzaiy:exit-request', request),
    unavailable: () => { if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'warning', title: '暂时无法退出',
      message: '尚未取得笔记保存状态，窗口已保留。', detail: '请等待页面恢复后再次关闭，避免丢失未保存的编辑。', buttons: ['继续使用'] }); },
    inspect: () => {
      let sync = null, syncError = '';
      try { const status = service.transport.status(); sync = { pendingChanges: status.pendingChanges, unconfirmed: status.unconfirmed,
        unfinished: !!status.job && !['complete', 'cancelled'].includes(status.job.state) }; }
      catch (error) { syncError = error.message; }
      return { sync, syncError, busy: exitActivity(service, activeCalls), dirty: (service.store.local('workspace')?.tabs || []).some(tab => tab.dirty)
        || Object.values(service.store.local('personalDrafts') || {}).some(Boolean) };
    },
    finish: async intent => {
      if (intent === 'storage-restart') check(storage.status().restartRequired, '存储变更已取消，请返回设置检查');
      allowClose = true;
      clearInterval(service.timer); service.timer = null; service.agents.stop();
      await service.close();
      storage.close();
      if (intent === 'storage-restart') app.relaunch();
      setTimeout(() => window.close(), 0);
    }
  });
  window.webContents.on('did-start-loading', () => exitCheck.dispose());
  window.on('closed', () => exitCheck.dispose());
  ipcMain.handle('fengzaiy:call', async (event, { method, input = {} }) => {
    let counted = false;
    try {
      check(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame, 'Untrusted request');
      check(!installingUpdate || method === 'updateStatus', '正在退出并安装更新，请稍候');
      check(!allowClose || installingUpdate, '正在退出，请稍候');
      activeCalls++; counted = true;
      let value;
      if (method === 'vaultCopy') {
        service.passwordVault.requireUnlocked(); check(typeof input.value === 'string' && input.value.length <= 12000, '密码内容无效');
        secretClipboard.copy(input.value); value = { copied: true, clearAfterSeconds: 30 };
      }
      else if (method === 'exitStatus') value = exitCheck.status(input.id);
      else if (method === 'exitCancel') value = exitCheck.cancel(input.id);
      else if (method === 'exitFinish') value = await exitCheck.accept(input);
      else if (method === 'updateStatus') value = updates.status();
      else if (method === 'updateConfigure') value = updates.configure(input);
      else if (method === 'updateCheck') value = await updates.check();
      else if (method === 'updateDownload') value = await updates.download();
      else if (method === 'updatePause') value = await updates.pause();
      else if (method === 'updateResume') value = await updates.download();
      else if (method === 'updateRestartDownload') value = await updates.restartDownload();
      else if (method === 'updateInstall') {
        updates.requireDownloaded();
        check(input.rendererReady === true, '请在系统设置中确认并关闭未保存内容后更新');
        assertUpdateIdle(service, storage, activeCalls, !!profileArg);
        const answer = dialog.showMessageBoxSync(window, { type: 'question', title: '重启并更新',
          message: `安装 FengZaiY ${updates.status().latestVersion}？`,
          detail: '应用将退出并打开安装程序。未发布的修改保留在本机，不会自动同步。',
          buttons: ['稍后更新', '重启并更新'], defaultId: 0, cancelId: 0 });
        if (answer !== 1) value = updates.status();
        else {
          assertUpdateIdle(service, storage, activeCalls, !!profileArg);
          installingUpdate = true; allowClose = true;
          clearInterval(service.timer); service.timer = null;
          service.agents.stop();
          value = updates.install();
        }
      } else if (method === 'importClipboardImage') {
        value = await importClipboardImage(service, input);
      } else if (method === 'storageOpenFolder') {
        const error = await shell.openPath(service.store.directory);
        check(!error, error); value = true;
      } else if (method === 'libraryOpenFolder') {
        const { directory } = await service.call('libraryDirectory', input);
        const error = await shell.openPath(directory);
        check(!error, error); value = true;
      } else if (method === 'storageRestart') {
        check(storage.status().restartRequired, '没有待生效的存储变更');
        const busy = exitActivity(service, activeCalls);
        check(!busy, busy, 'BUSY');
        exitCheck.begin('storage-restart');
        value = true;
      } else if (method === 'bindLocalFile') {
        check(!input.id || isId(input.id), 'Invalid local file reference');
        const result = await dialog.showOpenDialog(window, { properties: ['openFile'] });
        if (result.canceled) value = null;
        else {
          const file = result.filePaths[0];
          check(!file.startsWith('\\\\') && /\.(pdf|txt|md|png|jpg|jpeg|webp|gif|mp4|webm|mov|mp3|wav|docx|xlsx|pptx|csv)$/i.test(file), '只允许本机文档或媒体文件');
          noSymlink(file);
          const id = input.id || uuid(), bindings = service.store.local('localFileLinks') || {};
          bindings[id] = file; service.store.local('localFileLinks', bindings);
          value = { id, name: path.basename(file) };
        }
      } else if (method === 'openLocalFile') {
        check(isId(input.id), 'Invalid local file reference');
        const file = service.store.local('localFileLinks')?.[input.id];
        check(file && fs.existsSync(file), '此电脑尚未绑定该本地文件，请重新关联', 'LOCAL_FILE_UNBOUND');
        noSymlink(file);
        check(fs.statSync(file).isFile() && !file.startsWith('\\\\') && /\.(pdf|txt|md|png|jpg|jpeg|webp|gif|mp4|webm|mov|mp3|wav|docx|xlsx|pptx|csv)$/i.test(file), '只允许本机文档或媒体文件');
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '打开本地文件', message: '使用本机应用打开此文件？', detail: file, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
        if (answer.response === 1) { const error = await shell.openPath(file); check(!error, error); }
        value = answer.response === 1;
      } else if (method === 'chooseDirectory' || method === 'chooseFile') {
        const result = await dialog.showOpenDialog(window, { properties: [method === 'chooseDirectory' ? 'openDirectory' : 'openFile'] });
        value = result.canceled ? null : result.filePaths[0];
      } else if (method === 'openAsset') {
        const record = service.store.get(input.id), local = service.store.assetLocation(input.id);
        check(record?.type === 'asset' && local, 'Attachment is not available');
        check(/\.(pdf|txt|md|png|jpg|jpeg|webp|mp4|mov|mp3|wav|docx|xlsx|pptx)$/i.test(record.data.filename), 'This file type is not opened automatically');
        const viewDirectory = workspaceInternalPath(directory, 'opened-files', record.id);
        fs.mkdirSync(viewDirectory, { recursive: true });
        const viewFile = path.join(viewDirectory, record.data.filename);
        service.store.activeAssetReads ||= new Map();
        const reads = service.store.activeAssetReads;
        reads.set(record.id, (reads.get(record.id) || 0) + 1);
        try { await fs.promises.copyFile(local.path, viewFile); }
        finally { reads.set(record.id, Math.max(0, (reads.get(record.id) || 1) - 1)); }
        const error = await shell.openPath(viewFile);
        check(!error, error); value = true;
      } else if (method === 'openExternal') {
        const url = new URL(input.url);
        check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'Unsupported external link');
        await shell.openExternal(url.href); value = true;
      } else if (method === 'printPdf') {
        const result = await dialog.showSaveDialog(window, { defaultPath: userExportPath(service.store, 'FengZaiY.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!result.canceled) {
          const buffer = await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
          const { writeFile } = await import('node:fs/promises');
          await writeFile(result.filePath, buffer);
        }
        value = !result.canceled;
      } else if (method === 'version') value = { version: app.getVersion(), updates: 'online-release' };
      else value = await service.call(method, input);
      return { value };
    } catch (error) { return { error: prettyError(error) }; }
    finally { if (counted) activeCalls--; }
  });
  await window.loadFile(entry);
  service.startTimer();
  if (updates.updater && updates.status().autoCheck && !smokeTest) {
    const timer = setTimeout(() => { if (updates.status().autoCheck) void updates.check().catch(() => {}); }, 5000);
    timer.unref();
    app.once('before-quit', () => clearTimeout(timer));
  }
  window.on('close', event => {
    if (allowClose || smokeTest && !process.argv.includes('--test-exit')) return;
    event.preventDefault();
    exitCheck.begin();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { service?.close(); storage?.close(); });
  }).catch(error => {
    console.error('FengZaiY startup failed:', error);
    app.exit(1);
  });
}
