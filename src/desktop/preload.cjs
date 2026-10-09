const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  call: async (method, input = {}) => {
    const response = await ipcRenderer.invoke('studyself:call', { method, input });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value;
  }
});
