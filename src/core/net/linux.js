'use strict';

// The Linux half of the network layer.
//
// Deliberately uses iproute2 (`ip neigh`, `ip route`) rather than `arp` and
// `route`: net-tools is not installed on a default Ubuntu Server, and `ip
// neigh` reports something `arp -a` cannot - the kernel's own view of whether
// a neighbour has been confirmed recently. See `arpTable` below.

const { IPV4, run, hasCommand, normalizeMac, pool, isUsableArpRow } = require('./common.js');

/**
 * Linux `ping -W` takes seconds, not milliseconds like the Windows one.
 *
 * Whole seconds are emitted as integers so the common case ("-W 1") works on
 * any iputils ever shipped. Fractions need iputils >= 20190515, which is
 * Ubuntu 20.04 and later.
 */
function deadlineArg(timeoutMs) {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : String(Math.max(0.1, seconds));
}

/**
 * `-n` matters more than it looks: unlike Windows, Linux ping does a reverse
 * DNS lookup on the target by default. Across a 254-host sweep that is 254
 * lookups the scanner is about to do again properly in its naming phase, most
 * of them timing out against a router that has no local DNS.
 */
function pingArgs(ip, timeoutMs) {
  return ['-n', '-c', '1', '-W', deadlineArg(timeoutMs), ip];
}

/**
 * Ping every host in the subnet. As on Windows, the replies are a bonus - the
 * point is to make the kernel ARP for each address and populate the neighbour
 * table, which is the real source of truth.
 */
async function pingSweep(hosts, { concurrency = 64, timeoutMs = 500, onProgress } = {}) {
  const alive = new Set();
  let done = 0;
  await pool(hosts, concurrency, async (ip) => {
    const stdout = await run('ping', pingArgs(ip, timeoutMs), timeoutMs + 2000);
    if (/ttl[=<]/i.test(stdout)) alive.add(ip);
    done += 1;
    if (onProgress) onProgress(done, hosts.length);
  });
  return alive;
}

/**
 * A single ping, with its round-trip time.
 *
 * Linux reports fractional milliseconds - "time=0.345 ms" - where Windows
 * reports whole ones. The number is kept to one decimal place rather than
 * rounded to an integer, because on a wired LAN almost every honest reading is
 * under 1 ms and rounding would draw a flat line along the bottom of the graph
 * whatever the link was doing.
 */
async function pingOnce(ip, timeoutMs = 1000) {
  const stdout = await run('ping', pingArgs(ip, timeoutMs), timeoutMs + 2000);
  if (!/ttl[=<]/i.test(stdout)) return { ok: false, ms: null };
  const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
  if (!m) return { ok: true, ms: 0 };
  return { ok: true, ms: Math.round(Number(m[1]) * 10) / 10 };
}

// States `ip neigh` can report. REACHABLE is the only one that means "the
// kernel has confirmed this neighbour within the last few seconds"; STALE and
// the rest mean "we have an address for it, but not recent proof".
const NEIGHBOUR_STATES = new Set([
  'PERMANENT', 'NOARP', 'REACHABLE', 'STALE', 'NONE', 'INCOMPLETE', 'DELAY', 'PROBE', 'FAILED',
]);

/**
 * Parse `ip neigh` into ip -> { mac, state }.
 *
 * A line looks like:
 *   192.168.1.1 dev enp1s0 lladdr 3c:22:fb:aa:bb:cc REACHABLE
 *   192.168.1.9 dev enp1s0  FAILED
 *
 * Rows with no lladdr - FAILED and INCOMPLETE - are addresses we asked about
 * and got nothing back for. They are not devices and are dropped.
 */
async function arpTable() {
  const stdout = await run('ip', ['-4', 'neigh', 'show'], 8000);
  const table = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const ip = parts[0];
    if (!ip || !IPV4.test(ip)) continue;

    const lladdrAt = parts.indexOf('lladdr');
    if (lladdrAt === -1 || !parts[lladdrAt + 1]) continue;
    const mac = normalizeMac(parts[lladdrAt + 1]);
    if (!isUsableArpRow(ip, mac)) continue;

    // The state is the last token, but `router` and `proxy` flags can sit
    // between it and the address, so check rather than assume.
    const last = parts[parts.length - 1];
    table.set(ip, { mac, state: NEIGHBOUR_STATES.has(last) ? last : null });
  }
  return table;
}

/** Default gateways, from `ip route`. A point-to-point default has no `via`. */
async function defaultGateways() {
  const stdout = await run('ip', ['-4', 'route', 'show', 'default'], 8000);
  const gateways = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const viaAt = parts.indexOf('via');
    if (viaAt !== -1 && IPV4.test(parts[viaAt + 1] || '')) gateways.add(parts[viaAt + 1]);
  }
  return gateways;
}

// Resolved once, then reused. Checked lazily rather than at import so a module
// load never waits on a process.
let nmblookupAvailable = null;

/**
 * NetBIOS name lookup, the Samba equivalent of nbtstat. `samba-common-bin` is
 * not installed by default, so check first - otherwise a /24 sweep spawns 254
 * processes that all fail identically.
 *
 * Output is:
 *     MYPC            <00> -         B <ACTIVE>
 *     WORKGROUP       <00> - <GROUP> B <ACTIVE>
 *
 * The group row is the workgroup, not the machine, so it is skipped. nmblookup
 * does not print UNIQUE the way nbtstat does; absence of <GROUP> is the test.
 */
async function netbiosName(ip) {
  if (nmblookupAvailable === null) nmblookupAvailable = await hasCommand('nmblookup');
  if (!nmblookupAvailable) return null;

  const stdout = await run('nmblookup', ['-A', ip], 4000);
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('<00>') || line.includes('<GROUP>')) continue;
    const name = line.trim().split(/\s+/)[0];
    if (name && name !== 'Looking') return name;
  }
  return null;
}

module.exports = {
  platform: 'linux',
  pingSweep,
  pingOnce,
  arpTable,
  defaultGateways,
  netbiosName,
};
