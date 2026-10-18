'use strict';

// The web build's half of the UI contract.
//
// Under Electron the preload script has already defined window.jomnet by the
// time this runs, so this whole file is a no-op there. That is what lets one
// index.html serve both front ends with no build step: the UI never learns
// which one it is talking to.

if (!window.jomnet) {
  const EVENT_SOURCE_PATH = '/api/events';

  /**
   * One EventSource for the page, fanned out to however many subscribers the
   * UI registers. The browser reconnects on its own, and the server replies to
   * a fresh connection with a full state frame, so a dropped Wi-Fi link heals
   * without anything here having to notice.
   */
  const listeners = { state: new Set(), progress: new Set(), ports: new Set(), ping: new Set() };
  let stream = null;

  function ensureStream() {
    if (stream) return;
    stream = new EventSource(EVENT_SOURCE_PATH);
    for (const name of Object.keys(listeners)) {
      stream.addEventListener(name, (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        for (const fn of listeners[name]) fn(payload);
      });
    }
    // EventSource retries by itself; the only thing worth doing here is not
    // leaving a dead object behind if the page is being torn down.
    window.addEventListener('pagehide', () => { if (stream) stream.close(); }, { once: true });
  }

  function subscribe(name, fn) {
    ensureStream();
    listeners[name].add(fn);
    return () => listeners[name].delete(fn);
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // The session expired or was never there. Reload rather than let the UI
    // sit showing stale devices it can no longer refresh.
    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('Not signed in');
    }
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  }

  window.jomnet = {
    platform: 'web',

    getState: () => request('/api/state'),
    scan: () => request('/api/scan', {}),
    rename: (id, name) => request('/api/device/rename', { id, name }),
    setNotes: (id, notes) => request('/api/device/notes', { id, notes }),
    save: (id, name, notes) => request('/api/device/save', { id, name, notes }),
    acknowledge: (ids) => request('/api/device/acknowledge', { ids }),
    adoptAnnounced: (ids) => request('/api/adopt', { ids }),
    forget: (id) => request('/api/device/forget', { id }),
    scanPorts: (id) => request('/api/ports/scan', { id }),
    startPing: (id) => request('/api/ping/start', { id }),
    stopPing: () => request('/api/ping/stop', {}),
    updateSettings: (patch) => request('/api/settings', patch),
    downloadOui: () => request('/api/oui/download', {}),
    testAlerts: () => request('/api/alerts/test', {}),

    // Meaningless on a server - the data lives on the server's disk, not
    // yours. The UI hides the button, but the method stays so nothing has to
    // check which front end it is running under before calling it.
    openDataFolder: () => Promise.resolve(),

    onState: (cb) => subscribe('state', cb),
    onProgress: (cb) => subscribe('progress', cb),
    onPortProgress: (cb) => subscribe('ports', cb),
    onPingSample: (cb) => subscribe('ping', cb),
  };
}
