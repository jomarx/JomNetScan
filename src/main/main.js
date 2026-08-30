'use strict';

const path = require('path');
const {
  app, BrowserWindow, ipcMain, Notification, Tray, Menu, shell, nativeImage,
} = require('electron');

const { Store } = require('./store.js');
const { Scanner } = require('./scanner.js');
const net = require('./net.js');
const oui = require('./oui.js');
const discover = require('./discover.js');

let mainWindow = null;
let tray = null;
let store = null;
let scanner = null;
let scanTimer = null;
let lastScan = null;
let scanError = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function ouiUserPath() {
  return path.join(app.getPath('userData'), 'oui.json');
}

function buildState() {
  return {
    devices: store.list(),
    settings: store.getSettings(),
    interfaces: net.listInterfaces(),
    scanning: scanner.running,
    lastScan,
    scanError,
    oui: oui.stats(),
  };
}

function pushState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', buildState());
  }
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const devices = store.list();
  const online = devices.filter((d) => d.online).length;
  const unseen = devices.filter((d) => !d.acknowledged).length;
  tray.setToolTip(`JomNetScan - ${online} online${unseen ? `, ${unseen} unnamed` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${online} device${online === 1 ? '' : 's'} online`, enabled: false },
    { type: 'separator' },
    { label: 'Open JomNetScan', click: showWindow },
    { label: 'Scan now', enabled: !scanner.running, click: () => runScan('manual') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

/** A tray icon drawn at runtime, so the repo needs no binary assets. */
function trayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const on = dist < 3 || (dist > 5 && dist < 6.4);
      // BGRA
      buf[i] = on ? 220 : 0;
      buf[i + 1] = on ? 190 : 0;
      buf[i + 2] = on ? 90 : 0;
      buf[i + 3] = on ? 255 : 0;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

async function runScan(trigger) {
  if (scanner.running) return;
  scanError = null;
  pushState();
  try {
    const result = await scanner.scan(store.getSettings());
    const newDevices = store.merge(result.devices, result.startedAt);
    lastScan = {
      at: result.finishedAt,
      trigger,
      count: result.devices.length,
      newCount: newDevices.length,
    };

    if (newDevices.length && store.getSettings().notifyOnNew && Notification.isSupported()) {
      const names = newDevices
        .map((d) => d.hostname || d.vendor || d.ip)
        .slice(0, 3)
        .join(', ');
      new Notification({
        title: newDevices.length === 1 ? 'New device on your network' : `${newDevices.length} new devices`,
        body: `${names}${newDevices.length > 3 ? ', ...' : ''} - open JomNetScan to name it.`,
      }).on('click', showWindow).show();
    }
  } catch (err) {
    scanError = err.message;
  } finally {
    pushState();
  }
}

function rescheduleAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  const { autoScan, intervalMinutes } = store.getSettings();
  if (!autoScan) return;
  const ms = Math.max(1, Number(intervalMinutes) || 5) * 60 * 1000;
  scanTimer = setInterval(() => runScan('auto'), ms);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#12141a',
    title: 'JomNetScan',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!quitting && store.getSettings().minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Nothing in this app should open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  scanner = new Scanner();
  oui.load([ouiUserPath(), path.join(__dirname, '..', '..', 'data', 'oui.json')]);

  // Earlier builds stored service identifiers as announced names, and a merge
  // keeps the last one it saw. Drop anything the current filter would reject.
  let dropped = 0;
  for (const device of store.list()) {
    if (device.discoveredName && discover.looksLikeIdentifier(device.discoveredName)) {
      device.discoveredName = null;
      dropped += 1;
    }
  }
  if (dropped) store.saveDevices();

  scanner.on('progress', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan:progress', payload);
    }
  });

  createWindow();
  tray = new Tray(trayIcon());
  tray.on('double-click', showWindow);
  updateTray();

  rescheduleAutoScan();
  runScan('startup');
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* tray keeps the app alive on Windows */ });

ipcMain.handle('state:get', () => buildState());

ipcMain.handle('scan:run', async () => {
  await runScan('manual');
  return buildState();
});

ipcMain.handle('device:rename', (_e, { id, name }) => {
  store.rename(id, name);
  pushState();
  return buildState();
});

ipcMain.handle('device:notes', (_e, { id, notes }) => {
  store.setNotes(id, notes);
  pushState();
  return buildState();
});

ipcMain.handle('device:acknowledge', (_e, { ids }) => {
  store.acknowledge(ids || []);
  pushState();
  return buildState();
});

ipcMain.handle('device:adoptAnnounced', (_e, { ids }) => {
  store.adoptAnnounced(ids || null);
  pushState();
  return buildState();
});

ipcMain.handle('device:forget', (_e, { id }) => {
  store.forget(id);
  pushState();
  return buildState();
});

ipcMain.handle('settings:update', (_e, patch) => {
  store.updateSettings(patch || {});
  rescheduleAutoScan();
  pushState();
  return buildState();
});

ipcMain.handle('oui:download', async () => {
  try {
    const result = await oui.download(ouiUserPath());
    // Backfill vendors for devices we already know about.
    for (const device of store.list()) {
      const vendor = oui.lookup(device.mac);
      if (vendor) device.vendor = vendor;
    }
    store.saveDevices();
    pushState();
    return { ok: true, entries: result.entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:openDataFolder', () => {
  shell.openPath(app.getPath('userData'));
});
