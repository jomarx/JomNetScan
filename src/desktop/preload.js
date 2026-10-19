'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets this narrow, explicit surface and nothing else -
// no Node, no require, no direct ipcRenderer.
contextBridge.exposeInMainWorld('jomnet', {
  // Tells the shared UI which front end it is running under, and tells
  // jomnet-http.js that window.jomnet is already taken.
  platform: 'desktop',

  getState: () => ipcRenderer.invoke('state:get'),
  scan: () => ipcRenderer.invoke('scan:run'),
  rename: (id, name) => ipcRenderer.invoke('device:rename', { id, name }),
  setNotes: (id, notes) => ipcRenderer.invoke('device:notes', { id, notes }),
  save: (id, name, notes) => ipcRenderer.invoke('device:save', { id, name, notes }),
  acknowledge: (ids) => ipcRenderer.invoke('device:acknowledge', { ids }),
  adoptAnnounced: (ids) => ipcRenderer.invoke('device:adoptAnnounced', { ids }),
  forget: (id) => ipcRenderer.invoke('device:forget', { id }),
  scanPorts: (id) => ipcRenderer.invoke('ports:scan', { id }),
  startPing: (id) => ipcRenderer.invoke('ping:start', { id }),
  stopPing: () => ipcRenderer.invoke('ping:stop'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  downloadOui: () => ipcRenderer.invoke('oui:download'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
  onPortProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ports:progress', handler);
    return () => ipcRenderer.removeListener('ports:progress', handler);
  },
  onPingSample: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ping:sample', handler);
    return () => ipcRenderer.removeListener('ping:sample', handler);
  },
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
});
