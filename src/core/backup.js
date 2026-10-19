'use strict';

// Export and import of the device list: names, notes, first/last seen, port
// scans - everything a scan history is made of. Shared by both front ends, so
// a backup from the desktop app imports into the server and the other way.
//
// Settings are deliberately left out. On the web build they hold the Telegram
// token and webhook URL, and a backup file is exactly the kind of thing that
// gets copied around, attached and forgotten in a Downloads folder.

const FORMAT = 'jomnetscan-backup';
const VERSION = 1;

// The id is a MAC, or `ip:<address>` for a device that never showed one. It
// becomes a property name on the store's device map, so anything else - above
// all `__proto__` - is refused rather than trusted.
const ID_RE = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$|^ip:\d{1,3}(?:\.\d{1,3}){3}$/;
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_DEVICES = 10000;

function buildBackup(store, now = new Date()) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    devices: store.list(),
  };
}

function backupFileName(now = new Date()) {
  return `jomnetscan-backup-${now.toISOString().slice(0, 10)}.json`;
}

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** One imported record, reduced to known fields of the right types. */
function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : null;
  if (!id || !ID_RE.test(id)) return null;
  const ip = typeof raw.ip === 'string' && IP_RE.test(raw.ip) ? raw.ip : (id.startsWith('ip:') ? id.slice(3) : null);
  if (!ip) return null;

  let ports;
  if (raw.ports && typeof raw.ports === 'object' && time(raw.ports.scannedAt)) {
    ports = {
      scannedAt: raw.ports.scannedAt,
      open: Array.isArray(raw.ports.open)
        ? raw.ports.open.filter((p) => p && Number.isInteger(p.port) && p.port > 0 && p.port < 65536)
          .slice(0, 1000)
          .map((p) => ({ port: p.port, service: text(p.service, 100) || '' }))
        : [],
      ...(text(raw.ports.error, 300) ? { error: text(raw.ports.error, 300) } : {}),
    };
  }

  return {
    id,
    mac: id.startsWith('ip:') ? null : id,
    ip,
    name: text(raw.name, 200),
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 10000) : '',
    hostname: text(raw.hostname, 255),
    discoveredName: text(raw.discoveredName, 255),
    vendor: text(raw.vendor, 255),
    isGateway: raw.isGateway === true,
    randomizedMac: raw.randomizedMac === true,
    firstSeen: time(raw.firstSeen),
    lastSeen: time(raw.lastSeen),
    ports,
  };
}

/**
 * Accepts our own export, or a bare devices.json (the map keyed by id that
 * both builds keep on disk), so an existing install can be moved without
 * having exported first. Throws a message fit to show the user.
 */
function parseBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('That file is not a JomNetScan backup.');
  let records;
  if (data.format === FORMAT) {
    if (Number(data.version) > VERSION) {
      throw new Error('That backup is from a newer JomNetScan. Update this one first.');
    }
    records = Array.isArray(data.devices) ? data.devices : null;
  } else if (!Array.isArray(data) && !('format' in data)) {
    records = Object.values(data);
  }
  if (!records) throw new Error('That file is not a JomNetScan backup.');
  if (records.length > MAX_DEVICES) throw new Error(`That backup has more than ${MAX_DEVICES} devices.`);

  const devices = [];
  let skipped = 0;
  for (const raw of records) {
    const record = cleanRecord(raw);
    if (record) devices.push(record);
    else skipped += 1;
  }
  if (!devices.length) throw new Error('No devices in that file could be read.');
  return { devices, skipped };
}

const earlier = (a, b) => (!a ? b : !b ? a : (Date.parse(a) <= Date.parse(b) ? a : b));
const later = (a, b) => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

/**
 * Merge a parsed backup into the store and save once.
 *
 * Devices the store doesn't know are added - offline, and not badged New:
 * they're history, not arrivals, and the next scan marks the live ones online.
 * For devices it does know, the backup's name and notes win where the backup
 * has them (that's what importing names is for) and a blank in the backup
 * never erases one here. Seen times widen to cover both, and the more recent
 * port scan is kept. Live fields - IP, online, the confirmation state - stay
 * as this install last saw them.
 */
function importBackup(store, parsed, now = new Date()) {
  const summary = { added: 0, updated: 0, unchanged: 0, skipped: parsed.skipped };
  const stamp = now.toISOString();

  for (const incoming of parsed.devices) {
    const existing = store.devices[incoming.id];
    if (!existing) {
      store.devices[incoming.id] = {
        id: incoming.id,
        mac: incoming.mac,
        ip: incoming.ip,
        name: incoming.name,
        hostname: incoming.hostname,
        discoveredName: incoming.discoveredName,
        vendor: incoming.vendor,
        isGateway: incoming.isGateway,
        randomizedMac: incoming.randomizedMac,
        confirmed: false,
        confirmedVia: null,
        isSelf: false,
        notes: incoming.notes,
        firstSeen: incoming.firstSeen || incoming.lastSeen || stamp,
        lastSeen: incoming.lastSeen || incoming.firstSeen || stamp,
        online: false,
        acknowledged: true,
        ...(incoming.ports ? { ports: incoming.ports } : {}),
      };
      summary.added += 1;
      continue;
    }

    const before = JSON.stringify(existing);
    if (incoming.name) {
      existing.name = incoming.name;
      existing.acknowledged = true;
    }
    if (incoming.notes) existing.notes = incoming.notes;
    existing.hostname = existing.hostname || incoming.hostname;
    existing.discoveredName = existing.discoveredName || incoming.discoveredName;
    existing.vendor = existing.vendor || incoming.vendor;
    existing.firstSeen = earlier(existing.firstSeen, incoming.firstSeen);
    existing.lastSeen = later(existing.lastSeen, incoming.lastSeen);
    if (incoming.ports && (!existing.ports
      || Date.parse(incoming.ports.scannedAt) > Date.parse(existing.ports.scannedAt))) {
      existing.ports = incoming.ports;
    }
    if (JSON.stringify(existing) === before) summary.unchanged += 1;
    else summary.updated += 1;
  }

  if (summary.added || summary.updated) store.saveDevices();
  return summary;
}

module.exports = { buildBackup, backupFileName, parseBackup, importBackup, FORMAT };
