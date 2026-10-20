'use strict';

// The network log: what came online, what went offline and what showed up for
// the first time, one entry per change, written as each scan lands.
//
// It is built from scan results, so its resolution is the scan interval. A
// device that drops off for two minutes between five-minute scans never
// appears here, and "left at 14:05" means "missing from the 14:05 scan", not
// the moment it went. When the app wasn't scanning at all - the laptop was
// asleep, the server was restarting - the log says so with a gap entry rather
// than pinning everything that changed meanwhile on the first scan back.

const fs = require('fs');
const path = require('path');

// A month of a busy home network is a few thousand entries. The count cap is
// only there so a flapping device can't grow the file without bound.
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 20000;

function label(device) {
  return device.name || device.discoveredName || device.hostname || device.vendor || device.ip;
}

class EventLog {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'events.json');
    let data = null;
    try {
      if (fs.existsSync(this.file)) data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      data = null;
    }
    this.events = data && Array.isArray(data.events) ? data.events : [];
    // When the last scan landed, kept across restarts so a gap that spans one
    // is still noticed.
    this.lastScanAt = data && typeof data.lastScanAt === 'string' ? data.lastScanAt : null;
    // Never reused, even once everything it numbered has been pruned.
    const last = this.events[this.events.length - 1];
    this.seq = Math.max(Number.isInteger(data && data.seq) ? data.seq : 0, last && Number.isInteger(last.seq) ? last.seq : 0);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Compact on purpose: this file is rewritten on every scan that changes
    // something, and indentation would roughly double it.
    fs.writeFileSync(tmp, JSON.stringify({ lastScanAt: this.lastScanAt, seq: this.seq, events: this.events }));
    fs.renameSync(tmp, this.file);
  }

  /** Who is online right now, taken just before a scan is merged. */
  static snapshot(store) {
    return new Set(store.list().filter((d) => d.online).map((d) => d.id));
  }

  /**
   * Record what one merged scan changed. `before` is the snapshot from just
   * before the merge, `newDevices` what merge() returned.
   *
   *   baseline   the first scan of an empty list: one entry, not thirty
   *              arrivals, for the same reason it raises no alert
   *   gap        no scan for well over the interval before this one, so the
   *              entries after it happened somewhere inside that window
   *   new        never seen before
   *   joined     known, offline at the last scan, online at this one
   *   left       online at the last scan, missing from this one
   *
   * Returns the entries added.
   */
  recordScan({ store, before, newDevices, at, baseline, intervalMinutes }) {
    const added = [];
    const freshIds = new Set(newDevices.map((d) => d.id));

    if (this.lastScanAt && !baseline) {
      const gapMs = Date.parse(at) - Date.parse(this.lastScanAt);
      const expectedMs = Math.max(1, Number(intervalMinutes) || 5) * 60 * 1000;
      // Twice the interval plus a minute for the scan itself: one late or
      // slow scan isn't a gap, a missed one is.
      if (gapMs > expectedMs * 2 + 60 * 1000) {
        added.push({ at, type: 'gap', from: this.lastScanAt });
      }
    }

    if (baseline) {
      added.push({ at, type: 'baseline', count: newDevices.length });
    } else {
      for (const device of store.list()) {
        let type = null;
        if (freshIds.has(device.id)) type = 'new';
        else if (device.online && !before.has(device.id)) type = 'joined';
        else if (!device.online && before.has(device.id)) type = 'left';
        if (!type) continue;
        added.push({ at, type, id: device.id, ip: device.ip, label: label(device) });
      }
    }

    this.lastScanAt = at;
    if (added.length) {
      for (const entry of added) {
        this.seq += 1;
        entry.seq = this.seq;
      }
      this.events.push(...added);
      this.prune(Date.parse(at));
    }
    // Saved even with nothing added, so lastScanAt survives a restart.
    this.save();
    return added;
  }

  prune(now = Date.now()) {
    const cutoff = now - KEEP_MS;
    let start = 0;
    while (start < this.events.length && !(Date.parse(this.events[start].at) >= cutoff)) start += 1;
    start = Math.max(start, this.events.length - KEEP_MAX);
    if (start > 0) this.events = this.events.slice(start);
  }

  /**
   * Newest first, `limit` at a time. `beforeSeq` is the seq of the oldest
   * entry already shown. Paging by seq rather than by time or position means
   * entries sharing a timestamp (everything from one scan) are never split,
   * and pruning between two pages can't shift what the next one returns.
   */
  page({ limit = 200, beforeSeq = null } = {}) {
    let end = this.events.length;
    if (Number.isInteger(beforeSeq)) {
      end = 0;
      while (end < this.events.length && this.events[end].seq < beforeSeq) end += 1;
    }
    const size = Math.max(1, Math.min(1000, Number(limit) || 200));
    const start = Math.max(0, end - size);
    const events = this.events.slice(start, end).reverse();
    return {
      events,
      nextBeforeSeq: start > 0 ? events[events.length - 1].seq : null,
      total: this.events.length,
      oldestAt: this.events.length ? this.events[0].at : null,
    };
  }

  /** Small enough to ride along in every state push, so an open log refreshes. */
  summary() {
    const last = this.events[this.events.length - 1];
    return { count: this.events.length, latestAt: last ? last.at : null };
  }
}

module.exports = { EventLog, KEEP_MS, KEEP_MAX };
