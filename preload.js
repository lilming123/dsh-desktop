const { contextBridge, ipcRenderer } = require('electron');

// Buffer events that arrive before the renderer calls onProgress()
const queue = [];
let callback = null;

ipcRenderer.on('progress', (_e, data) => {
  if (callback) callback(data);
  else queue.push(data);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Drain buffered events immediately, then wire live stream
  onProgress: (cb) => {
    callback = cb;
    queue.splice(0).forEach(cb);
  },
  retry: () => ipcRenderer.send('retry'),
});
