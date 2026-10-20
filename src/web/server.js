'use strict';

// The web front end. Same orchestration the desktop build does in main.js -
// one Store, one Scanner, an auto-scan timer and a badge-expiry tick - with
// the Electron window replaced by an HTTP server and the IPC channels replaced
// by routes that return exactly the same state payload.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store, NEW_BADGE_MS } = require('../core/store.js');
const { Scanner } = require('../core/scanner.js');
const { migrateStore } = require('../core/migrate.js');
const net = require('../core/net/index.js');
const oui = require('../core/oui.js');
const ports = require('../core/ports.js');
const { createAuth } = require('./auth.js');
const { createUpdater } = require('./updater.js');
const notify = require('./notify.js');
const backup = require('../core/backup.js');
const { EventLog } = require('../core/eventlog.js');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const BUNDLED_OUI = path.join(__dirname, '..', '..', 'data', 'oui.json');

const PORT = Number(process.env.JOMNETSCAN_PORT) || 8099;
const BIND = process.env.JOMNETSCAN_BIND || '0.0.0.0';
const DATA_DIR = process.env.JOMNETSCAN_DATA
  || process.env.STATE_DIRECTORY           // set by systemd's StateDirectory=
  || path.join(__dirname, '..', '..', '.data');

const PING_SESSION_MAX = 120;
const MAX_BODY_BYTES = 64 * 1024;
// A backup is the whole device list. A few hundred devices with notes and port
// scans is well under this; the cap is only there so a mistake can't eat memory.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// State, shared by every connected browser

let lastScan = null;
let scanError = null;
let portScanning = null;
let pingSession = null;
let ouiDownloading = false;
let scanTimer = null;

const store = new Store(DATA_DIR);
const eventLog = new EventLog(DATA_DIR);
const scanner = new Scanner();
const auth = createAuth({ dataDir: DATA_DIR, log });
const updater = createUpdater({ log, dataDir: DATA_DIR });

/** Every open EventSource connection. */
const clients = new Set();

function buildState() {
  return {
    devices: store.list(),
    // The browser must never be handed the real Telegram token or ntfy URL -
    // this payload goes to every connected tab on every change.
    settings: notify.redactSettings(store.getSettings()),
    interfaces: net.listInterfaces(),
    scanning: scanner.running,
    lastScan,
    scanError,
    oui: oui.stats(),
    newBadgeMs: NEW_BADGE_MS,
    portScanning,
    pinging: pingSession ? pingSession.id : null,
    update: updater.getState(),
    log: eventLog.summary(),
  };
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    // A browser that went away mid-write shouldn't take the server with it.
    // `writableEnded` catches the common case; the try/catch is for the race
    // where it goes away between the check and the write.
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function pushState() {
  syncBusyFlag();
  broadcast('state', buildState());
}

// ---------------------------------------------------------------------------
// The busy flag
//
// The auto-update timer runs as root and restarts this service, which would
// abandon whatever is in flight. It can't ask the API (that needs the
// password), so this file is how it knows to wait: present while a scan, port
// scan, ping graph or vendor download is running, gone when nothing is. It
// lives in the state directory so only root and this service can see it.

const BUSY_FILE = path.join(DATA_DIR, 'busy');
let busyWritten = null;

function busyReasons() {
  const reasons = [];
  if (scanner.running) reasons.push('scan');
  if (portScanning) reasons.push('port scan');
  if (pingSession) reasons.push('ping');
  if (ouiDownloading) reasons.push('vendor download');
  return reasons.join(', ');
}

function syncBusyFlag() {
  const reasons = busyReasons();
  if (reasons === busyWritten) return;
  try {
    if (reasons) fs.writeFileSync(BUSY_FILE, `${reasons}
`);
    else fs.rmSync(BUSY_FILE, { force: true });
    busyWritten = reasons;
  } catch (err) {
    // Not fatal: the worst case is an update restarting mid-scan, which is
    // what happened before this flag existed.
    log(`Couldn't update the busy flag: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scanning

/**
 * Thrown by an action that was asked for something already in flight. The
 * dispatcher turns it into a 409 carrying the current state, because a
 * cheerful 200 with an empty device list reads as a broken scan rather than
 * as a no-op - which is exactly how it was first misread.
 */
class Conflict extends Error {}

async function runScan(trigger) {
  if (scanner.running) return;
  scanError = null;
  pushState();
  try {
    // scan() flips `running` synchronously, so the flag goes up before the
    // first ping rather than at the next state push.
    const scanning = scanner.scan(store.getSettings());
    syncBusyFlag();
    const result = await scanning;
    const baseline = store.isEmpty();
    const before = EventLog.snapshot(store);
    const newDevices = store.merge(result.devices, result.startedAt);
    try {
      eventLog.recordScan({
        store, before, newDevices, baseline, at: result.startedAt,
        intervalMinutes: store.getSettings().intervalMinutes,
      });
    } catch (err) {
      // The log is a record of the scan, not part of it.
      log(`Couldn't write the network log: ${err.message}`);
    }
    store.expireNewFlags();
    lastScan = {
      at: result.finishedAt,
      trigger,
      count: result.devices.length,
      newCount: newDevices.length,
    };
    if (baseline) {
      log(`Scan (${trigger}): ${newDevices.length} devices, recorded as the baseline (no alert)`);
    } else if (newDevices.length) {
      log(`Scan (${trigger}): ${result.devices.length} devices, ${newDevices.length} new`);
      // Deliberately not awaited: a slow Telegram shouldn't hold the scan open.
      notify.notifyNewDevices(store.getSettings(), newDevices, log)
        .catch((err) => log(`Alert dispatch failed: ${err.message}`));
    }
  } catch (err) {
    scanError = err.message;
    log(`Scan failed: ${err.message}`);
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

function stopPing() {
  if (pingSession) pingSession.cancelled = true;
  pingSession = null;
  // The session's own cleanup skips the state push once it's been replaced,
  // so drop the flag here or it would stay up until something else changed.
  syncBusyFlag();
}

function startPing(id) {
  const device = store.get(id);
  if (!device) return;
  if (pingSession) pingSession.cancelled = true;

  const session = { id, cancelled: false };
  pingSession = session;
  pushState();

  (async () => {
    try {
      for (let seq = 1; seq <= PING_SESSION_MAX && !session.cancelled; seq += 1) {
        // Pace off the whole probe, not the reported round trip: a timeout
        // costs its full deadline and reports nothing, so pacing off `ms` makes
        // lost samples take twice as long as answered ones and the graph's
        // even-width columns cover uneven amounts of time.
        const startedAt = Date.now();
        const result = await net.pingOnce(device.ip);
        if (session.cancelled) break;
        broadcast('ping', { id, seq, ok: result.ok, ms: result.ms });
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - startedAt))));
      }
    } finally {
      // Clearing this only on the happy path is what let one stuck probe wedge
      // the app for the life of the process. Always settle.
      if (pingSession === session) {
        pingSession = null;
        pushState();
      }
    }
  })();
}

async function scanDevicePorts(id) {
  const device = store.get(id);
  if (!device) throw new Conflict('No such device');
  if (portScanning) throw new Conflict('A port scan is already running');
  portScanning = id;
  pushState();
  try {
    const open = await ports.scanPorts(device.ip, {
      onProgress: (done, total) => broadcast('ports', { id, done, total }),
    });
    store.setPorts(id, { scannedAt: new Date().toISOString(), open });
  } catch (err) {
    store.setPorts(id, { scannedAt: new Date().toISOString(), open: [], error: err.message });
  } finally {
    portScanning = null;
    pushState();
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve({}); return; }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Serve a file from the renderer directory. The resolved path is checked
 * against that directory rather than the request being sanitised, because the
 * only check that is actually reliable is "where did this land".
 */
function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(RENDERER_DIR, relative);
  if (resolved !== RENDERER_DIR && !resolved.startsWith(RENDERER_DIR + path.sep)) {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendJson(res, { error: 'Not found' }, 404);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function loginPage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JomNetScan</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#12141a;
         color:#e6e8ef; font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  form { width:min(92vw, 20rem); padding:1.75rem; background:#1a1d26; border:1px solid #2a2e3b; border-radius:10px; }
  h1 { margin:0 0 .25rem; font-size:1.15rem; }
  p { margin:0 0 1.25rem; color:#8d93a6; font-size:.875rem; }
  label { display:block; margin-bottom:.4rem; font-size:.8rem; color:#8d93a6; }
  input { width:100%; box-sizing:border-box; padding:.6rem .7rem; margin-bottom:1rem; border-radius:6px;
          border:1px solid #2a2e3b; background:#12141a; color:inherit; font:inherit; }
  input:focus { outline:2px solid #4f7cff; outline-offset:1px; }
  button { width:100%; padding:.6rem; border:0; border-radius:6px; background:#4f7cff; color:#fff;
           font:inherit; font-weight:600; cursor:pointer; }
  .error { color:#ff8080; font-size:.825rem; margin:-.5rem 0 1rem; }
</style></head>
<body>
  <form method="post" action="/login">
    <h1>JomNetScan</h1>
    <p>This network monitor is password protected.</p>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    ${message ? `<div class="error">${message}</div>` : ''}
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}

function sendHtml(res, html, status = 200) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Routes

/** POST handlers. Each returns the new state, mirroring the desktop IPC calls. */
const ACTIONS = {
  '/api/scan': async () => {
    if (scanner.running) throw new Conflict('A scan is already running');
    await runScan('manual');
  },
  '/api/device/rename': (body) => { store.rename(body.id, body.name); },
  '/api/device/save': (body) => { store.update(body.id, { name: body.name, notes: body.notes }); },
  '/api/device/notes': (body) => { store.setNotes(body.id, body.notes); },
  '/api/device/acknowledge': (body) => { store.acknowledge(body.ids || []); },
  '/api/device/forget': (body) => { store.forget(body.id); },
  '/api/adopt': (body) => { store.adoptAnnounced(body.ids || null); },
  '/api/ports/scan': async (body) => { await scanDevicePorts(body.id); },
  '/api/ping/start': (body) => { startPing(body.id); },
  '/api/ping/stop': () => { stopPing(); },
  '/api/update/apply': () => {
    // Only drops a request file; the root path unit does the work. See
    // updater.js and deploy/jomnetscan-update.path.
    const reason = updater.refusal();
    if (reason) throw new Conflict(reason);
    updater.request();
  },
  '/api/settings': (body) => {
    // An untouched secret field comes back as its mask; writing that through
    // would silently destroy the token it was standing in for.
    store.updateSettings(notify.stripMaskedSecrets(body || {}));
    rescheduleAutoScan();
  },
};

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);

  // Proxies and dozing laptops drop a connection that says nothing for long
  // enough; a comment every 30s is the cheapest thing that keeps it open.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clients.delete(res);
    // Nobody is watching the graph any more. The desktop build stops pinging
    // when its window closes; this is the same idea, one step later.
    if (!clients.size && pingSession) {
      log('Last browser disconnected, stopping the ping session');
      stopPing();
    }
  };

  // It has to be `res` here, not `req`. A GET has no request body, so the
  // request stream is finished the moment the headers are parsed and its
  // 'close' never tells us anything about the browser going away. Writing to
  // the dead socket afterwards doesn't throw either - it emits an error - so
  // without this a closed tab left the server pinging into nothing.
  res.on('close', close);
  res.on('error', close);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  // --- unauthenticated ---
  if (route === '/login') {
    if (req.method === 'GET') {
      sendHtml(res, loginPage(null));
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const submitted = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('password');
      const cookie = auth.attemptLogin(req, submitted);
      if (!cookie) {
        const message = auth.isLockedOut(req)
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That password did not work.';
        sendHtml(res, loginPage(message), 401);
        return;
      }
      res.writeHead(303, { Location: '/', 'Set-Cookie': cookie });
      res.end();
      return;
    }
  }

  if (!auth.isAuthenticated(req)) {
    if (route.startsWith('/api/')) {
      sendJson(res, { error: 'Not signed in' }, 401);
      return;
    }
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  // --- authenticated ---
  if (route === '/logout') {
    res.writeHead(303, { Location: '/login', 'Set-Cookie': auth.clearCookie() });
    res.end();
    return;
  }

  if (route === '/api/events' && req.method === 'GET') {
    openEventStream(req, res);
    return;
  }

  if (route === '/api/state' && req.method === 'GET') {
    sendJson(res, buildState());
    return;
  }

  if (route === '/api/log' && req.method === 'GET') {
    const beforeSeq = Number.parseInt(url.searchParams.get('before'), 10);
    sendJson(res, eventLog.page({
      limit: Number(url.searchParams.get('limit')) || 200,
      beforeSeq: Number.isInteger(beforeSeq) ? beforeSeq : null,
    }));
    return;
  }

  if (route === '/api/oui/download' && req.method === 'POST') {
    ouiDownloading = true;
    syncBusyFlag();
    try {
      const result = await oui.download(path.join(DATA_DIR, 'oui.json'));
      for (const device of store.list()) {
        const vendor = oui.lookup(device.mac);
        if (vendor) device.vendor = vendor;
      }
      store.saveDevices();
      pushState();
      sendJson(res, { ok: true, entries: result.entries });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message });
    } finally {
      ouiDownloading = false;
      syncBusyFlag();
    }
    return;
  }

  if (route === '/api/export' && req.method === 'GET') {
    // The one place the real token and webhook URL ever reach a browser, and
    // only when the export checkbox asked for them - so it goes in the journal.
    const includeSecrets = url.searchParams.get('secrets') === '1';
    const data = backup.buildBackup(store, { platform: 'web', includeSecrets });
    if (data.secretsIncluded) log('Exported a backup including the Telegram token / webhook URL');
    const body = Buffer.from(JSON.stringify(data, null, 2));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${backup.backupFileName()}"`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (route === '/api/import' && req.method === 'POST') {
    // Settings only on an explicit ?settings=1, so a request that doesn't say
    // never changes them.
    const restoreSettings = url.searchParams.get('settings') === '1';
    let summary;
    let settings = null;
    try {
      const parsed = backup.parseBackup(await readBody(req, MAX_IMPORT_BYTES));
      summary = backup.importBackup(store, parsed);
      if (restoreSettings) {
        settings = backup.applySettings(store, parsed, { platform: 'web', interfaces: net.listInterfaces() });
      }
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
      return;
    }
    log(`Imported a backup: ${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped`
      + (settings ? `; settings changed: ${settings.changed.join(', ') || 'none'}` : '')
      + (restoreSettings && !settings ? '; the file had no settings' : ''));
    if (settings && settings.changed.length) rescheduleAutoScan();
    pushState();
    // Not `settings`: that key is the app's settings in the state payload.
    sendJson(res, { ...buildState(), imported: summary, settingsRestore: settings });
    return;
  }

  if (route === '/api/alerts/test' && req.method === 'POST') {
    sendJson(res, await notify.sendTest(store.getSettings()));
    return;
  }

  const action = ACTIONS[route];
  if (action && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
      return;
    }
    try {
      await action(body);
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
      sendJson(res, { ...buildState(), skipped: err.message }, 409);
      return;
    }
    pushState();
    sendJson(res, buildState());
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, route);
    return;
  }

  sendJson(res, { error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// Startup

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log(`Data directory: ${DATA_DIR}`);
  // A flag left behind by a crash mid-scan. Nothing is running yet, so this
  // removes it (busyWritten starts null, which never equals "").
  syncBusyFlag();

  oui.load([path.join(DATA_DIR, 'oui.json'), BUNDLED_OUI]);
  const stats = oui.stats();
  log(stats && stats.entries
    ? `Vendor database: ${stats.entries} prefixes`
    : 'No vendor database yet - download it from Settings for manufacturer names');

  migrateStore(store);

  scanner.on('progress', (payload) => broadcast('progress', payload));

  store.expireNewFlags();
  setInterval(() => { if (store.expireNewFlags()) pushState(); }, 60 * 1000);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`Unhandled error on ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, { error: 'Something went wrong' }, 500);
      else res.end();
    });
  });

  server.listen(PORT, BIND, () => {
    log(`JomNetScan listening on http://${BIND}:${PORT} (${net.platform} backend)`);
    rescheduleAutoScan();
    runScan('startup');
    // Hourly "are we behind the remote?" check, plus the progress of an update
    // someone asked for. A push on every change so an open tab learns without
    // waiting for the next scan.
    updater.start(() => pushState());
  });

  server.on('error', (err) => {
    log(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Set JOMNETSCAN_PORT to something else.`
      : `Server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (signal) => {
    log(`${signal} received, shutting down`);
    stopPing();
    updater.stop();
    // Don't leave a flag claiming a scan this process will never finish.
    try { fs.rmSync(BUSY_FILE, { force: true }); } catch { /* best effort */ }
    if (scanTimer) clearInterval(scanTimer);
    for (const client of clients) client.end();
    server.close(() => process.exit(0));
    // Don't hang forever on a connection that won't close.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
