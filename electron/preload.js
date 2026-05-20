const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('__EHOSER_DESKTOP__', true);
contextBridge.exposeInMainWorld('__EHOSER_API_ORIGIN__', 'https://ehoser.de');
contextBridge.exposeInMainWorld('__EHOSER_APP_VERSION__', version);

contextBridge.exposeInMainWorld('ehoserDesktopUpdates', {
  check: () => ipcRenderer.invoke('updates:check'),
  download: (url) => ipcRenderer.invoke('updates:download', { url }),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updates:progress', listener);
    return () => ipcRenderer.removeListener('updates:progress', listener);
  }
});

contextBridge.exposeInMainWorld('ehoserDesktopAuth', {
  get: () => ipcRenderer.invoke('auth:get'),
  set: (token) => ipcRenderer.invoke('auth:set', { token }),
  clear: () => ipcRenderer.invoke('auth:clear')
});
