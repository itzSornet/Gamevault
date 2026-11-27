// The hidden recorder page's only link to main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cap', {
  onStart: (cb) => ipcRenderer.on('cap:start', (_, o) => cb(o)),
  onStop: (cb) => ipcRenderer.on('cap:stop', () => cb()),
  started: () => ipcRenderer.send('cap:started'),
  chunk: (bytes) => ipcRenderer.send('cap:chunk', bytes),
  done: (result) => ipcRenderer.send('cap:done', result),
});
