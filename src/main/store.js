'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  autoScan: true,
  intervalMinutes: 5,
  notifyOnNew: true,
  useNetbios: true,
  discoverNames: true,
  pingTimeoutMs: 500,
  concurrency: 128,
  interfaceName: null, // null = scan every scannable interface
  minimizeToTray: true,
};

/** Read JSON, returning `fallback` for anything unreadable or corrupt. */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename so a crash mid-write can't shred the device list. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.devicesFile = path.join(baseDir, 'devices.json');
    this.settingsFile = path.join(baseDir, 'settings.json');
    this.devices = readJson(this.devicesFile, {});
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
  }

  saveDevices() {
    writeJson(this.devicesFile, this.devices);
  }

  saveSettings() {
    writeJson(this.settingsFile, this.settings);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.saveSettings();
    return this.getSettings();
  }

  list() {
    return Object.values(this.devices);
  }

  get(id) {
    return this.devices[id] || null;
  }

  /**
   * Fold one scan's findings into the stored list.
   * Returns the devices seen here for the first time, so the caller can alert.
   */
  merge(found, scanStartedAt) {
    const seen = new Set();
    const newDevices = [];

    for (const device of found) {
      const id = device.mac || `ip:${device.ip}`;
      seen.add(id);
      const existing = this.devices[id];

      if (!existing) {
        const record = {
          id,
          mac: device.mac || null,
          ip: device.ip,
          name: null,
          hostname: device.hostname || null,
          discoveredName: device.discoveredName || null,
          vendor: device.vendor || null,
          isGateway: !!device.isGateway,
          randomizedMac: !!device.randomizedMac,
          isSelf: !!device.isSelf,
          notes: '',
          firstSeen: scanStartedAt,
          lastSeen: scanStartedAt,
          online: true,
          acknowledged: false,
        };
        this.devices[id] = record;
        newDevices.push(record);
        continue;
      }

      existing.ip = device.ip;
      // Keep a name we already resolved if this pass came back empty.
      existing.hostname = device.hostname || existing.hostname;
      existing.discoveredName = device.discoveredName || existing.discoveredName;
      // Vendor comes from the MAC alone; keep the old value only when this pass
      // had no OUI database loaded. A randomized MAC never has one.
      existing.vendor = device.randomizedMac ? null : (device.vendor || existing.vendor);
      existing.isGateway = !!device.isGateway;
      existing.randomizedMac = !!device.randomizedMac;
      existing.isSelf = !!device.isSelf;
      existing.lastSeen = scanStartedAt;
      existing.online = true;
    }

    for (const [id, device] of Object.entries(this.devices)) {
      if (!seen.has(id)) device.online = false;
    }

    this.saveDevices();
    return newDevices;
  }

  rename(id, name) {
    const device = this.devices[id];
    if (!device) return null;
    const trimmed = (name || '').trim();
    device.name = trimmed || null;
    // Naming a device is the act of acknowledging it.
    if (trimmed) device.acknowledged = true;
    this.saveDevices();
    return device;
  }

  setNotes(id, notes) {
    const device = this.devices[id];
    if (!device) return null;
    device.notes = notes || '';
    this.saveDevices();
    return device;
  }

  acknowledge(ids) {
    for (const id of ids) {
      if (this.devices[id]) this.devices[id].acknowledged = true;
    }
    this.saveDevices();
  }

  forget(id) {
    const existed = !!this.devices[id];
    delete this.devices[id];
    this.saveDevices();
    return existed;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
