'use strict';

// One shared password, one signed cookie. No session store: the signature is
// the session, so a restart doesn't log everyone out as long as the secret
// survives - which is why it's persisted rather than regenerated.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'jomnetscan';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// Ten tries, then a minute off. Enough to stop a script, few enough that
// fat-fingering the password twice doesn't lock you out of your own network.
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 60 * 1000;

/**
 * The cookie-signing secret. Persisted so that restarting the service doesn't
 * invalidate every session; 0600 because anyone who can read it can mint one.
 */
function loadSecret(dataDir) {
  if (process.env.JOMNETSCAN_SECRET) return process.env.JOMNETSCAN_SECRET;
  const file = path.join(dataDir, 'secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

/**
 * The password. Generating a random one when none is configured means the
 * server is never accidentally open to the whole LAN - the failure mode is
 * "you can't log in and the log tells you why", not "anyone can".
 */
function loadPassword(log) {
  if (process.env.JOMNETSCAN_PASSWORD) return process.env.JOMNETSCAN_PASSWORD;
  const generated = crypto.randomBytes(9).toString('base64url');
  log(`No JOMNETSCAN_PASSWORD set. Generated one for this run only: ${generated}`);
  log('Set JOMNETSCAN_PASSWORD in the environment to keep a password across restarts.');
  return generated;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Constant-time compare that doesn't leak length through an early return. */
function sameString(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do the work, so a wrong-length guess isn't measurably faster.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function createAuth({ dataDir, log }) {
  const secret = loadSecret(dataDir);
  const password = loadPassword(log);
  const attempts = new Map();

  const sign = (value) => crypto.createHmac('sha256', secret).update(String(value)).digest('hex');

  function issue() {
    const expires = Date.now() + SESSION_MS;
    return `${expires}.${sign(expires)}`;
  }

  function valid(token) {
    const dot = (token || '').indexOf('.');
    if (dot === -1) return false;
    const expires = token.slice(0, dot);
    if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
    return sameString(token.slice(dot + 1), sign(expires));
  }

  function isLoopback(address) {
    return /^(127\.|::1$|::ffff:127\.)/.test(address);
  }

  /**
   * Who to count a failed login against.
   *
   * Behind a reverse proxy the socket address is the proxy's, so the real
   * client is in X-Forwarded-For. But that header is written by whoever sent
   * the request: this server binds 0.0.0.0, so anyone on the LAN or tailnet
   * can set it, and a fresh made-up value on each attempt hands every guess
   * its own bucket. That is not a weakened rate limit, it is no rate limit -
   * on the one control standing between the device list and anyone who can
   * reach the port.
   *
   * So the header counts only when the connection itself came from loopback,
   * which is where a local proxy connects from (Tailscale serve, Caddy,
   * nginx). A client cannot forge the address it connected from.
   *
   * Of the hops, take the LAST: that is the one the proxy appended itself.
   * Anything before it was supplied by the client and is exactly as
   * trustworthy as the raw header was. This assumes a single proxy, which is
   * the topology deploy/README.md describes; chain two and the lockout
   * becomes per-proxy rather than per-client, which fails safe.
   *
   * A proxy running on another host is not covered - it would connect from a
   * real address, so its clients would share one bucket and could lock each
   * other out. Run the proxy on the same box, as the deploy notes do.
   */
  function clientIp(req) {
    const socketIp = req.socket.remoteAddress || 'unknown';
    if (!isLoopback(socketIp)) return socketIp;

    const forwarded = req.headers['x-forwarded-for'];
    if (!forwarded) return socketIp;
    const hops = String(forwarded).split(',');
    return hops[hops.length - 1].trim() || socketIp;
  }

  function lockedOut(ip) {
    const record = attempts.get(ip);
    return !!record && record.count >= MAX_ATTEMPTS && Date.now() < record.until;
  }

  // Records for addresses that have served their lockout are dead weight, and
  // without this the map only ever grows - one entry per address that ever
  // guessed wrong. Harmless for a household, but it is the kind of thing that
  // should not depend on who is allowed to reach the port.
  function pruneAttempts(now) {
    if (attempts.size < 1000) return;
    for (const [key, record] of attempts) {
      if (now >= record.until) attempts.delete(key);
    }
  }

  function recordFailure(ip) {
    const now = Date.now();
    pruneAttempts(now);
    const record = attempts.get(ip) || { count: 0, until: 0 };
    // A fresh window once the previous lockout has expired, so the counter
    // doesn't stay permanently maxed out after one bad afternoon.
    if (record.count >= MAX_ATTEMPTS && now >= record.until) record.count = 0;
    record.count += 1;
    record.until = now + LOCKOUT_MS;
    attempts.set(ip, record);
  }

  return {
    isAuthenticated(req) {
      return valid(parseCookies(req.headers.cookie)[COOKIE]);
    },

    /** Returns a Set-Cookie value on success, null on a bad password or a lockout. */
    attemptLogin(req, submitted) {
      const ip = clientIp(req);
      if (lockedOut(ip)) return null;
      if (!sameString(submitted || '', password)) {
        recordFailure(ip);
        return null;
      }
      attempts.delete(ip);
      // No Secure flag: this is plain HTTP on a LAN by design. Behind a TLS
      // proxy the browser keeps sending it anyway.
      return `${COOKIE}=${issue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
    },

    isLockedOut(req) {
      return lockedOut(clientIp(req));
    },

    clearCookie() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
  };
}

module.exports = { createAuth };
