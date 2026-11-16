const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('dshdash', {
  close: () => ipcRenderer.send('dshdash-close'),
  hide: () => ipcRenderer.send('dshdash-hide'),
})
