import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../core/service.mjs';
import { check, prettyError } from '../core/util.mjs';

const base = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const profileArg = process.argv.find(arg => arg.startsWith('--data-dir='));
const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest) app.disableHardwareAcceleration();
let service, window;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
  const vault = {
    seal: value => { check(safeStorage.isEncryptionAvailable(), 'Windows credential encryption is unavailable'); return safeStorage.encryptString(value).toString('base64'); },
    open: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  };
  const directory = profileArg ? path.resolve(profileArg.slice('--data-dir='.length)) : path.join(app.getPath('userData'), 'workspace');
  service = new Service(directory, { vault, idleCheck: () => powerMonitor.getSystemIdleTime() });
  const entry = path.join(base, 'dist', 'index.html');
  window = new BrowserWindow({ width: 1480, height: 940, minWidth: 1000, minHeight: 660, backgroundColor: '#f7f8fa', show: !smokeTest,
    title: 'StudySelf · 个人知识库', autoHideMenuBar: true,
    webPreferences: { preload: path.join(base, 'src', 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, offscreen: smokeTest, backgroundThrottling: !smokeTest } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== new URL(`file:///${entry.replace(/\\/g, '/')}`).href) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('studyself:call', async (event, { method, input = {} }) => {
    try {
      check(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame, 'Untrusted request');
      let value;
      if (method === 'chooseDirectory' || method === 'chooseFile') {
        const result = await dialog.showOpenDialog(window, { properties: [method === 'chooseDirectory' ? 'openDirectory' : 'openFile'] });
        value = result.canceled ? null : result.filePaths[0];
      } else if (method === 'openAsset') {
        const record = service.store.get(input.id), local = service.store.assetLocation(input.id);
        check(record?.type === 'asset' && local, 'Attachment is not available');
        check(/\.(pdf|txt|md|png|jpg|jpeg|webp|mp4|mov|mp3|wav|docx|xlsx|pptx)$/i.test(record.data.filename), 'This file type is not opened automatically');
        const viewDirectory = path.join(directory, 'opened-files', record.id);
        fs.mkdirSync(viewDirectory, { recursive: true });
        const viewFile = path.join(viewDirectory, record.data.filename);
        await fs.promises.copyFile(local.path, viewFile);
        const error = await shell.openPath(viewFile);
        check(!error, error); value = true;
      } else if (method === 'openExternal') {
        const url = new URL(input.url);
        check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'Unsupported external link');
        await shell.openExternal(url.href); value = true;
      } else if (method === 'printPdf') {
        const result = await dialog.showSaveDialog(window, { defaultPath: 'StudySelf.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!result.canceled) {
          const buffer = await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
          const { writeFile } = await import('node:fs/promises');
          await writeFile(result.filePath, buffer);
        }
        value = !result.canceled;
      } else if (method === 'version') value = { version: app.getVersion(), updates: 'manual-installer' };
      else value = await service.call(method, input);
      return { value };
    } catch (error) { return { error: prettyError(error) }; }
  });
  await window.loadFile(entry);
  service.startTimer();
  let allowClose = false;
  window.on('close', event => {
    if (allowClose || smokeTest) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: '退出 StudySelf',
      message: '退出前请确认笔记已保存。',
      detail: '关闭后，本机同步和备份任务会停止。百度网盘客户端的上传状态需在其客户端确认。',
      buttons: ['继续使用', '退出'], defaultId: 0, cancelId: 0
    });
    if (choice === 1) { allowClose = true; window.close(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => service?.close());
  }).catch(error => {
    console.error('StudySelf startup failed:', error);
    app.exit(1);
  });
}
