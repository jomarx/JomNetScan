'use strict';

const fs = require('fs');
const path = require('path');

// How long a device stays flagged New after it is first seen. The badge counts
// up towards this, then clears itself - an alert nobody can dismiss stops being
// an alert. Naming a device still clears it immediately.
const NEW_BADGE_MS = 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  autoScan: true,
  intervalMinutes: 5,
  notifyOnNew: true,
  useNetbios: true,
  discoverNames: true,
  // Measured on a /24: 128 workers at a 500ms deadline detected 3 replies out
  // of 35 devices, because that many concurrent ping.exe processes starve each
  // other past the deadline. 64 at 1000ms detects 33 - and finishes sooner.
  pingTimeoutMs: 1000,
  concurrency: 64,
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
          respondedToPing: !!device.respondedToPing,
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
      existing.respondedToPing = !!device.respondedToPing;
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

  /**
   * Set a name and its notes together. Doing these as two round trips let the
   * state push from the first one re-render the panel and blank the name field
   * before the second one read it, which silently discarded the name.
   */
  update(id, { name, notes }) {
    const device = this.devices[id];
    if (!device) return null;
    if (notes !== undefined) device.notes = notes || '';
    if (name !== undefined) {
      const trimmed = (name || '').trim();
      device.name = trimmed || null;
      if (trimmed) device.acknowledged = true;
    }
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

  /**
   * Take the names devices announced for themselves, for every device the user
   * hasn't already named. Returns the ones that changed.
   */
  adoptAnnounced(ids = null) {
    const wanted = ids ? new Set(ids) : null;
    const targets = this.list().filter((d) => (
      d.discoveredName && !d.name && (!wanted || wanted.has(d.id))
    ));
    // Same effect as calling rename() per device, but one write instead of N -
    // rename() saves every time, and this runs over the whole list at once.
    for (const device of targets) {
      device.name = device.discoveredName;
      device.acknowledged = true;
    }
    if (targets.length) this.saveDevices();
    return targets;
  }

  /**
   * Retire the New flag on anything first seen longer than NEW_BADGE_MS ago.
   * Returns how many changed, so the caller can skip a pointless state push.
   */
  expireNewFlags(now = Date.now()) {
    let changed = 0;
    for (const device of Object.values(this.devices)) {
      if (device.acknowledged) continue;
      const firstSeen = Date.parse(device.firstSeen);
      // An unparseable timestamp is treated as old, so a bad record can't leave
      // a badge stuck on screen forever.
      if (!Number.isFinite(firstSeen) || now - firstSeen >= NEW_BADGE_MS) {
        device.acknowledged = true;
        changed += 1;
      }
    }
    if (changed) this.saveDevices();
    return changed;
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

module.exports = { Store, DEFAULT_SETTINGS, NEW_BADGE_MS };
