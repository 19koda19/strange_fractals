const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noemaDesktop', {
  platform: process.platform,
  onCommand(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('noema:command', listener);
    return () => ipcRenderer.removeListener('noema:command', listener);
  },
});
