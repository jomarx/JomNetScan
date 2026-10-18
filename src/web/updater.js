'use strict';

// Tells the UI whether the deployed checkout is behind its git remote. It only
// ever reads: `git ls-remote` queries the remote without writing to .git, and
// `git rev-parse` reads local state, so this works even under the hardened
// deploy where the service user cannot write to the root-owned checkout.
//
// It does NOT apply the update. On that deploy the service has no business
// rewriting its own code or restarting itself; the privileged systemd timer in
// deploy/ does the applying. This half is just the readout, so "is there an
// update?" is answerable from the UI you already have open instead of the
// journal.

const { execFile } = require('child_process');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..', '..');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, which the brief asked for

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

function createUpdater({ log }) {
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
  let timer = null;

  async function check() {
    try {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
      const current = await git(['rev-parse', 'HEAD'], 10000);
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

  function start(onChange) {
    // One check shortly after boot, then hourly. The first is delayed a little
    // so it doesn't pile onto the startup scan.
    const run = () => check().then(() => { if (onChange) onChange(state); });
    setTimeout(run, 15000).unref?.();
    timer = setInterval(run, CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    check,
    getState: () => state,
  };
}

module.exports = { createUpdater };
