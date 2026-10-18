'use strict';

// The Windows half of the network layer: ping, arp, route and nbtstat with
// Windows argument syntax and Windows output to parse.

const { IPV4, MAC, run, normalizeMac, pool, isUsableArpRow } = require('./common.js');

/**
 * Ping every host in the subnet. We don't trust the exit code (Windows ping
 * exits 0 on "destination host unreachable"); the point is to populate the
 * ARP cache, which is the real source of truth. A parsed reply is a bonus.
 */
async function pingSweep(hosts, { concurrency = 64, timeoutMs = 500, onProgress } = {}) {
  const alive = new Set();
  let done = 0;
  await pool(hosts, concurrency, async (ip) => {
    const stdout = await run('ping', ['-n', '1', '-w', String(timeoutMs), ip], timeoutMs + 2000);
    if (/ttl[=<]/i.test(stdout)) alive.add(ip);
    done += 1;
    if (onProgress) onProgress(done, hosts.length);
  });
  return alive;
}

/**
 * A single ping, with its round-trip time. `ms` is null when nothing came back.
 * Windows prints "time=2ms" or "time<1ms"; the second means sub-millisecond,
 * so it is reported as 0 rather than 1.
 */
async function pingOnce(ip, timeoutMs = 1000) {
  const stdout = await run('ping', ['-n', '1', '-w', String(timeoutMs), ip], timeoutMs + 2000);
  if (!/ttl[=<]/i.test(stdout)) return { ok: false, ms: null };
  const m = /time([=<])\s*(\d+)\s*ms/i.exec(stdout);
  if (!m) return { ok: true, ms: 0 };
  return { ok: true, ms: m[1] === '<' ? 0 : Number(m[2]) };
}

/**
 * Parse the Windows ARP cache into ip -> { mac, state }.
 *
 * `state` is always null here. Windows `arp -a` reports a type (dynamic or
 * static) but not whether the entry has been confirmed recently, which is the
 * thing we actually want to know. Linux does report it, so the field exists on
 * both and the caller falls back to the ping result when it is null.
 */
async function arpTable() {
  const stdout = await run('arp', ['-a'], 8000);
  const table = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const ipMatch = line.match(IPV4);
    const macMatch = line.match(MAC);
    if (!ipMatch || !macMatch) continue;
    const ip = ipMatch[1];
    const mac = normalizeMac(macMatch[0]);
    if (!isUsableArpRow(ip, mac)) continue;
    table.set(ip, { mac, state: null });
  }
  return table;
}

/** Default gateway for an interface, read from the IPv4 routing table. */
async function defaultGateways() {
  const stdout = await run('route', ['print', '-4'], 8000);
  const gateways = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === '0.0.0.0' && parts[1] === '0.0.0.0' && IPV4.test(parts[2] || '')) {
      gateways.add(parts[2]);
    }
  }
  return gateways;
}

/**
 * NetBIOS name lookup. Catches Windows boxes and printers that have no
 * reverse DNS entry - common on a home router with no local DNS.
 */
async function netbiosName(ip) {
  const stdout = await run('nbtstat', ['-A', ip], 4000);
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S.*?)\s+<00>\s+UNIQUE/i);
    if (m && m[1] && m[1].trim() !== '') return m[1].trim();
  }
  return null;
}

module.exports = {
  platform: 'windows',
  pingSweep,
  pingOnce,
  arpTable,
  defaultGateways,
  netbiosName,
};
