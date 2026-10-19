'use strict';

// Tells the UI whether the deployed checkout is behind its git remote, and
// passes on a request to update when someone clicks the button for it.
//
// It never applies an update itself. On the hardened deploy the service can't
// write its root-owned checkout or restart itself, and shouldn't be able to.
// What it can do is drop a request file in its own state directory; a root
// systemd path unit (deploy/jomnetscan-update.path) notices the file and runs
// the update script, which writes back a result file for this to show.
//
// The checks only ever read: `git ls-remote` queries the remote without
// writing to .git, and `git rev-parse` reads local state.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..', '..');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, which the brief asked for
const POLL_MS = 3000;
// A request nobody has picked up after this long almost certainly means the
// path unit isn't installed, and the UI should say so rather than wait forever.
const STALLED_MS = 60 * 1000;
// Past the update unit's own TimeoutStartSec (45 min): if no result has come
// back by now, none is coming, and the UI shouldn't say "Updating..." forever.
const LOST_MS = 50 * 60 * 1000;
// A manual result stays on screen this long, then it's old news.
const RESULT_SHOWN_MS = 24 * 60 * 60 * 1000;

function git(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // safe.directory: the service runs as `jomnetscan` while the checkout is
    // root-owned, which git otherwise refuses to touch as "dubious ownership".
    // Scoped to this one invocation, not written to any config.
    const full = ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR, ...args];
    execFile('git', full, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

/** The result file is written by root from git output; trust its shape, not its size. */
function readResult(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    const finishedAt = Number(raw.finishedAt);
    if (!Number.isFinite(finishedAt)) return null;
    return {
      status: str(raw.status, 20),
      message: str(raw.message, 300),
      requested: raw.requested === true,
      finishedAt,
    };
  } catch {
    return null;
  }
}

function createUpdater({ log, dataDir }) {
  const requestFile = path.join(dataDir, 'update-requested');
  const resultFile = path.join(dataDir, 'update-result.json');

  // `supported` goes false when this isn't a git checkout or git isn't on the
  // path - a release build, or `npm run serve` from a tarball. The UI then
  // shows nothing rather than a permanent error.
  let state = {
    supported: true,
    checkedAt: null,
    branch: null,
    current: null,
    latest: null,
    behind: false,
    error: null,
  };
  // The commit this process was started from. When the checkout's HEAD moves
  // past it - pulled, but the restart had to wait - a restart is still owed.
  let running = null;
  let requestedAt = null;
  let result = readResult(resultFile);
  let timer = null;
  let poller = null;
  let notify = null;

  async function check() {
    try {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
      const current = await git(['rev-parse', 'HEAD'], 10000);
      if (!running) running = current;
      const remote = await git(['ls-remote', 'origin', branch], 20000);
      const latest = (remote.split(/\s+/)[0] || '').trim();
      state = {
        supported: true,
        checkedAt: new Date().toISOString(),
        branch,
        current,
        latest: latest || null,
        behind: !!latest && !!current && latest !== current,
        error: null,
      };
      if (state.behind) {
        log(`Update available on ${branch}: ${current.slice(0, 7)} -> ${latest.slice(0, 7)}`);
      }
    } catch (err) {
      // ENOENT (no git) or a non-repo directory means the check can never
      // work here; stop trying and tell the UI to hide the row. A network
      // blip, by contrast, leaves `supported` true and just records the error.
      const permanent = err.code === 'ENOENT' || /not a git repository/i.test(err.message || '');
      state = {
        ...state,
        supported: !permanent,
        checkedAt: new Date().toISOString(),
        error: permanent ? null : (err.message || 'check failed'),
      };
      if (permanent && timer) stop();
    }
    return state;
  }

  function restartNeeded() {
    return !!running && !!state.current && state.current !== running;
  }

  function requestPhase() {
    if (!requestedAt) return null;
    // The script deletes the request file first thing, so "file gone, no
    // result yet" is how we know it's underway.
    if (!fs.existsSync(requestFile)) {
      return Date.now() - requestedAt > LOST_MS ? 'lost' : 'running';
    }
    return Date.now() - requestedAt > STALLED_MS ? 'stalled' : 'queued';
  }

  function getState() {
    const showResult = result && result.requested
      && Date.now() - result.finishedAt < RESULT_SHOWN_MS;
    return {
      ...state,
      running,
      restartNeeded: restartNeeded(),
      request: requestPhase(),
      result: showResult ? result : null,
    };
  }

  /** Why a click should be refused right now, or null if it's fine to go ahead. */
  function refusal() {
    if (!state.supported) return "Updates aren't available on this install";
    const phase = requestPhase();
    if (phase && phase !== 'lost') return 'An update is already requested';
    if (!state.behind && !restartNeeded()) return 'Already up to date';
    return null;
  }

  function request() {
    // The content is just for a human looking at the directory; the root side
    // deliberately reads nothing from it but its existence.
    fs.writeFileSync(requestFile, `${new Date().toISOString()}\n`);
    requestedAt = Date.now();
    log('Update requested from the UI');
    watch();
  }

  // While a request is open, watch for its phase changing and for the result
  // to land. Cheap - two stats every few seconds - and only while it matters.
  function watch() {
    if (poller) return;
    let lastPhase = requestPhase();
    poller = setInterval(() => {
      const fresh = readResult(resultFile);
      if (fresh && requestedAt && fresh.finishedAt >= requestedAt) {
        result = fresh;
        requestedAt = null;
        clearInterval(poller);
        poller = null;
        log(`Update finished: ${fresh.status} - ${fresh.message}`);
        // HEAD may have moved; refresh before telling the UI.
        check().then(() => notify && notify(getState()));
        return;
      }
      const phase = requestPhase();
      if (phase !== lastPhase) {
        lastPhase = phase;
        if (notify) notify(getState());
      }
    }, POLL_MS);
    poller.unref?.();
  }

  function start(onChange) {
    notify = onChange;
    // A request left from before a restart that never got picked up: carry on
    // waiting for it rather than forgetting it exists.
    try {
      requestedAt = fs.statSync(requestFile).mtimeMs;
      watch();
    } catch { /* none pending */ }
    // Pin the commit we're running before anything can move HEAD.
    git(['rev-parse', 'HEAD'], 10000).then((sha) => { if (!running) running = sha; }, () => {});
    // One check shortly after boot, then hourly. The first is delayed a little
    // so it doesn't pile onto the startup scan.
    const run = () => check().then(() => { if (notify) notify(getState()); });
    setTimeout(run, 15000).unref?.();
    timer = setInterval(run, CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (poller) clearInterval(poller);
    poller = null;
  }

  return {
    start,
    stop,
    check,
    refusal,
    request,
    getState,
  };
}

module.exports = { createUpdater };
