import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, powerMonitor, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageLocation } from '../core/storage-location.mjs';
import { check, prettyError, uuid, isId, noSymlink } from '../core/util.mjs';
import { mediaResponse } from '../core/media.mjs';

protocol.registerSchemesAsPrivileged([{ scheme: 'studyself-media', privileges: { standard: true, secure: true, stream: true } }]);

const base = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const profileArg = process.argv.find(arg => arg.startsWith('--data-dir='));
const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest) {
  app.disableHardwareAcceleration();
  // Keep smoke-test Chromium state and its single-instance lock away from the user's app.
  if (profileArg) app.setPath('userData', path.join(path.resolve(profileArg.slice('--data-dir='.length)), 'electron-profile'));
}
let service, storage, window;
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
  protocol.handle('studyself-media', async request => {
    try {
      const url = new URL(request.url);
      check(url.hostname === 'asset' && isId(url.pathname.slice(1)), 'Invalid media reference');
      return await mediaResponse(service.store, url.pathname.slice(1), request.headers.get('range'), request.method);
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
  await service.agents.resume();
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
      if (method === 'storageOpenFolder') {
        const error = await shell.openPath(service.store.directory);
        check(!error, error); value = true;
      } else if (method === 'libraryOpenFolder') {
        const { directory } = await service.call('libraryDirectory', input);
        const error = await shell.openPath(directory);
        check(!error, error); value = true;
      } else if (method === 'storageRestart') {
        check(storage.status().restartRequired, '没有待生效的存储变更');
        check(!service.transport.running, '同步仍在执行，请稍后重启');
        check(!(service.store.local('workspace')?.tabs || []).some(tab => tab.dirty), '请先保存或关闭未保存的笔记标签');
        setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
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
        const viewDirectory = path.join(directory, 'opened-files', record.id);
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
    let pending;
    try { pending = service.transport.status(); } catch { pending = null; }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: '退出 StudySelf',
      message: '退出前请确认笔记已保存。',
      detail: `${pending ? `${pending.pendingChanges} 条修改未发布，${pending.unconfirmed} 次上传未确认。${pending.job && !['complete', 'cancelled'].includes(pending.job.state) ? '\n发布任务尚未完成，进度已保留。' : ''}\n` : ''}关闭不会自动发布。百度客户端的上传状态需在其客户端确认。${service.transport.running ? '\n当前仍有同步操作，建议暂停后等待当前分块完成。' : ''}`,
      buttons: ['继续使用', '退出'], defaultId: 0, cancelId: 0
    });
    if (choice === 1) { allowClose = true; window.close(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { service?.close(); storage?.close(); });
  }).catch(error => {
    console.error('StudySelf startup failed:', error);
    app.exit(1);
  });
}
