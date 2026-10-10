const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  importFile: async (file, domain) => {
    const path = webUtils.getPathForFile(file);
    if (!path) throw new Error('无法读取拖入文件的位置，请从本机文件管理器选择文件');
    const response = await ipcRenderer.invoke('studyself:call', { method: 'assetImport', input: { path, domain } });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  },
  call: async (method, input = {}) => {
    const response = await ipcRenderer.invoke('studyself:call', { method, input });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  }
});
