// Narrow bridge between the renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('host', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: s => ipcRenderer.invoke('settings:set', s),
  saveProject: (data, filePath, saveAs) => ipcRenderer.invoke('project:save', { data, filePath, saveAs }),
  openProject: () => ipcRenderer.invoke('project:open'),
  exportAudio: (bytes, name, ext) => ipcRenderer.invoke('export:save', { bytes, name, ext }),
  pickAudioFiles: () => ipcRenderer.invoke('audio:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickInstrumentFiles: () => ipcRenderer.invoke('instrument:pick'),
  allowInstrumentFile: p => ipcRenderer.invoke('instrument:allow', p),
  pathForFile: file => webUtils.getPathForFile(file),
  scanFolder: dir => ipcRenderer.invoke('folder:scan', dir),
  readFile: p => ipcRenderer.invoke('file:read', p),
  openCredits: () => ipcRenderer.invoke('shell:credits'),
  setLowLatency: on => ipcRenderer.invoke('audio:low-latency', on),
  bootLowLatency: () => ipcRenderer.invoke('audio:boot-low-latency'),
});
