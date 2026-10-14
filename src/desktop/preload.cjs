const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  importFile: async (file, domain) => {
    const path = webUtils.getPathForFile(file);
    if (!path && (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 32 * 1024 * 1024)) throw new Error('剪贴板只支持不超过 32 MiB 的图片，其他资料请从本机文件导入');
    const response = await ipcRenderer.invoke('studyself:call', path
      ? { method: 'assetImport', input: { path, domain } }
      : { method: 'importClipboardImage', input: { mime: file.type, data: await file.arrayBuffer(), domain } });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  },
  call: async (method, input = {}) => {
    const response = await ipcRenderer.invoke('studyself:call', { method, input });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  }
});
