'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets this narrow, explicit surface and nothing else -
// no Node, no require, no direct ipcRenderer.
contextBridge.exposeInMainWorld('jomnet', {
  getState: () => ipcRenderer.invoke('state:get'),
  scan: () => ipcRenderer.invoke('scan:run'),
  rename: (id, name) => ipcRenderer.invoke('device:rename', { id, name }),
  setNotes: (id, notes) => ipcRenderer.invoke('device:notes', { id, notes }),
  save: (id, name, notes) => ipcRenderer.invoke('device:save', { id, name, notes }),
  acknowledge: (ids) => ipcRenderer.invoke('device:acknowledge', { ids }),
  adoptAnnounced: (ids) => ipcRenderer.invoke('device:adoptAnnounced', { ids }),
  forget: (id) => ipcRenderer.invoke('device:forget', { id }),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  downloadOui: () => ipcRenderer.invoke('oui:download'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),

  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
});
