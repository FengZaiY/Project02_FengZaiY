const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  onVaultLocked: callback => {
    const listener = () => callback(); ipcRenderer.on('fengzaiy:vault-locked', listener);
    return () => ipcRenderer.removeListener('fengzaiy:vault-locked', listener);
  },
  callResult: (method, input = {}) => ipcRenderer.invoke('fengzaiy:call', { method, input }),
  onExitRequest: callback => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('fengzaiy:exit-request', listener);
    return () => ipcRenderer.removeListener('fengzaiy:exit-request', listener);
  },
  onUpdateStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('fengzaiy:update-status', listener);
    return () => ipcRenderer.removeListener('fengzaiy:update-status', listener);
  },
  importFile: async (file, domain) => {
    const path = webUtils.getPathForFile(file);
    if (!path && (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 32 * 1024 * 1024)) throw new Error('剪贴板只支持不超过 32 MiB 的图片，其他资料请从本机文件导入');
    const response = await ipcRenderer.invoke('fengzaiy:call', path
      ? { method: 'assetImport', input: { path, domain } }
      : { method: 'importClipboardImage', input: { mime: file.type, data: await file.arrayBuffer(), domain } });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  },
  call: async (method, input = {}) => {
    const response = await ipcRenderer.invoke('fengzaiy:call', { method, input });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  }
});
