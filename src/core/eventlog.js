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

const path = require('path');
const { readJson, writeJson } = require('./store.js');

// A month of a busy home network is a few thousand entries. The count cap is
// only there so a flapping device can't grow the file without bound.
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 20000;

// What an entry keeps of the device so a forgotten one can still be named.
// Which of these wins is the renderer's displayName(), not decided here.
const NAME_FIELDS = ['name', 'discoveredName', 'hostname', 'vendor'];

/** Minutes between automatic scans, or null when only manual scans run. */
function scanInterval(settings) {
  return settings.autoScan ? Math.max(1, Number(settings.intervalMinutes) || 5) : null;
}

class EventLog {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'events.json');
    // When the last scan landed and on what interval, in a file of its own:
    // it changes on every scan, the event list only when something happened.
    this.clockFile = path.join(baseDir, 'events-clock.json');
    const data = readJson(this.file, null);
    const clock = readJson(this.clockFile, null);
    this.events = data && Array.isArray(data.events) ? data.events : [];
    // Kept across restarts so a gap that spans one is still noticed. Before
    // the clock file existed lastScanAt lived in events.json.
    const lastScanAt = (clock && clock.lastScanAt) || (data && data.lastScanAt);
    this.lastScanAt = typeof lastScanAt === 'string' ? lastScanAt : null;
    // undefined (not null) when unknown, so an old file doesn't read as "manual".
    this.lastInterval = clock && 'intervalMinutes' in clock ? clock.intervalMinutes : undefined;
    // Never reused, even once everything it numbered has been pruned.
    const last = this.events[this.events.length - 1];
    this.seq = Math.max(Number.isInteger(data && data.seq) ? data.seq : 0, last && Number.isInteger(last.seq) ? last.seq : 0);
  }

  save() {
    // Compact on purpose: indentation would roughly double a file that is
    // rewritten on every scan that changes something.
    writeJson(this.file, { seq: this.seq, events: this.events }, { pretty: false });
  }

  saveClock() {
    writeJson(this.clockFile, { lastScanAt: this.lastScanAt, intervalMinutes: this.lastInterval });
  }

  /** Who is online right now, taken just before a scan is merged. */
  static snapshot(store) {
    return new Set(store.list().filter((d) => d.online).map((d) => d.id));
  }

  /**
   * Record what one merged scan changed. `before` is the snapshot from just
   * before the merge, `newDevices` what merge() returned, `intervalMinutes`
   * the automatic interval or null when scans are manual only.
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
  recordScan({ store, before, newDevices, at, baseline, intervalMinutes = null }) {
    const added = [];
    const freshIds = new Set(newDevices.map((d) => d.id));

    // A gap only means something while scans are automatic on both sides of
    // it: hours between manual scans are just how manual scanning goes. The
    // longer of the two intervals, so raising it doesn't flag the first slow
    // scan after.
    const previous = this.lastInterval === undefined ? intervalMinutes : this.lastInterval;
    if (this.lastScanAt && !baseline && previous != null && intervalMinutes != null) {
      const gapMs = Date.parse(at) - Date.parse(this.lastScanAt);
      const expectedMs = Math.max(previous, intervalMinutes) * 60 * 1000;
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
        const entry = { at, type, id: device.id, ip: device.ip };
        for (const field of NAME_FIELDS) if (device[field]) entry[field] = device[field];
        added.push(entry);
      }
    }

    this.lastScanAt = at;
    this.lastInterval = intervalMinutes;
    if (added.length) {
      for (const entry of added) {
        this.seq += 1;
        entry.seq = this.seq;
      }
      this.events.push(...added);
      this.prune(Date.parse(at));
      this.save();
    }
    // Every scan, so the gap check survives a restart - but only this small
    // file, not a month of events rewritten to say nothing changed.
    this.saveClock();
    return added;
  }

  prune(now = Date.now()) {
    const cutoff = now - KEEP_MS;
    let start = 0;
    while (start < this.events.length && !(Date.parse(this.events[start].at) >= cutoff)) start += 1;
    start = Math.max(start, this.events.length - KEEP_MAX);
    if (start > 0) this.events = this.events.slice(start);
  }

  /** Index of the first entry with a seq at or above `seq` (events are in seq order). */
  indexOfSeq(seq) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].seq < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Newest first, `limit` at a time. `beforeSeq` is the seq of the oldest
   * entry already shown, `afterSeq` the newest: with it, only what was added
   * since, and `truncated` says there was more than `limit` of it, so the
   * caller has a hole and should start over from this page. Paging by seq
   * rather than by time or position means entries sharing a timestamp
   * (everything from one scan) are never split, and pruning between two pages
   * can't shift what the next one returns.
   */
  page({ limit = 200, beforeSeq = null, afterSeq = null } = {}) {
    const lo = Number.isInteger(afterSeq) ? this.indexOfSeq(afterSeq + 1) : 0;
    const end = Number.isInteger(beforeSeq) ? this.indexOfSeq(beforeSeq) : this.events.length;
    const size = Math.max(1, Math.min(1000, Number(limit) || 200));
    const start = Math.max(lo, end - size);
    const events = start < end ? this.events.slice(start, end).reverse() : [];
    return {
      events,
      nextBeforeSeq: start > 0 && events.length ? events[events.length - 1].seq : null,
      truncated: start > lo,
      total: this.events.length,
      oldestAt: this.events.length ? this.events[0].at : null,
    };
  }

  /** Small enough to ride along in every state push, so an open log refreshes. */
  summary() {
    const last = this.events[this.events.length - 1];
    return { count: this.events.length, latestAt: last ? last.at : null, latestSeq: last ? last.seq : null };
  }
}

/**
 * Merge one finished scan into the store and log what it changed. Both front
 * ends call this rather than doing it themselves because the order matters:
 * the online snapshot has to be taken before the merge, or every device reads
 * as having just come online.
 */
function mergeScan({ store, eventLog, result, onLogError }) {
  const settings = store.getSettings();
  const baseline = store.isEmpty();
  const before = EventLog.snapshot(store);
  const newDevices = store.merge(result.devices, result.startedAt);
  try {
    eventLog.recordScan({
      store, before, newDevices, baseline, at: result.startedAt, intervalMinutes: scanInterval(settings),
    });
  } catch (err) {
    // The log is a record of the scan, not part of it.
    onLogError(err);
  }
  return { baseline, newDevices };
}

module.exports = { EventLog, mergeScan, KEEP_MS, KEEP_MAX };
