'use strict';

// Housekeeping that runs once at startup, on whatever devices.json already
// exists. Shared, because a record written by the desktop app is read by the
// server and vice versa - they point at different data directories today, but
// the formats have to stay the same either way.

const discover = require('./discover.js');

/**
 * Bring stored device records up to date with the current code.
 * Returns a short summary for logging; the caller decides whether to print it.
 */
function migrateStore(store) {
  let droppedNames = 0;
  let droppedLegacy = 0;

  for (const device of store.list()) {
    // Earlier builds stored service identifiers as announced names, and a merge
    // keeps the last one it saw. Drop anything the current filter would reject.
    if (device.discoveredName && discover.looksLikeIdentifier(device.discoveredName)) {
      device.discoveredName = null;
      droppedNames += 1;
    }
    // `respondedToPing` became `confirmed` + `confirmedVia` when the Linux
    // backend arrived, because on Linux presence is read from the kernel's
    // neighbour table and no ping is involved. Nothing reads the old key, but
    // a merge only ever sets fields, so it would sit in the file forever.
    if ('respondedToPing' in device) {
      delete device.respondedToPing;
      droppedLegacy += 1;
    }
  }

  if (droppedNames || droppedLegacy) store.saveDevices();
  return { droppedNames, droppedLegacy };
}

module.exports = { migrateStore };
