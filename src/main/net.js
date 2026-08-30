'use strict';

const os = require('os');
const dns = require('dns').promises;
const { execFile } = require('child_process');

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;
const MAC = /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i;

/** Run a command, resolving to stdout. Never rejects - a failed probe is just empty output. */
function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

function normalizeMac(mac) {
  return mac.toLowerCase().replace(/-/g, ':');
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskToPrefix(mask) {
  return mask
    .split('.')
    .map((o) => Number(o).toString(2).padStart(8, '0'))
    .join('')
    .split('1').length - 1;
}

/**
 * IPv4 interfaces worth scanning: up, not loopback, not link-local.
 * Each carries the host range implied by its netmask.
 */
function listInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      const family = typeof addr.family === 'number' ? `IPv${addr.family}` : addr.family;
      if (family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      const prefix = maskToPrefix(addr.netmask);
      const netInt = ipToInt(addr.address) & ipToInt(addr.netmask);
      const hostCount = prefix >= 31 ? 0 : 2 ** (32 - prefix) - 2;
      out.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        mac: addr.mac && addr.mac !== '00:00:00:00:00:00' ? normalizeMac(addr.mac) : null,
        cidr: `${intToIp(netInt)}/${prefix}`,
        prefix,
        hostCount,
        // Anything wider than /22 (1022 hosts) is too slow to sweep politely.
        scannable: prefix >= 22 && hostCount > 0,
      });
    }
  }
  return out;
}

/** Every usable host address in an interface's subnet, excluding network + broadcast. */
function hostsFor(iface) {
  const netInt = ipToInt(iface.address) & ipToInt(iface.netmask);
  const broadcast = netInt + 2 ** (32 - iface.prefix) - 1;
  const hosts = [];
  for (let n = netInt + 1; n < broadcast; n++) hosts.push(intToIp(n));
  return hosts;
}

/** Run `task` over `items` with a fixed number of workers in flight. */
async function pool(items, limit, task) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await task(item);
    }
  });
  await Promise.all(workers);
}

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

/** Parse the Windows ARP cache into ip -> mac, dropping multicast and broadcast rows. */
async function arpTable() {
  const stdout = await run('arp', ['-a'], 8000);
  const table = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const ipMatch = line.match(IPV4);
    const macMatch = line.match(MAC);
    if (!ipMatch || !macMatch) continue;
    const ip = ipMatch[1];
    const mac = normalizeMac(macMatch[0]);
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac.startsWith('33:33')) continue;
    if (ip.startsWith('224.') || ip.startsWith('239.') || ip.endsWith('.255')) continue;
    table.set(ip, mac);
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

/** Reverse DNS, best effort. */
async function reverseDns(ip) {
  try {
    const names = await dns.reverse(ip);
    return names && names[0] ? names[0].replace(/\.$/, '') : null;
  } catch {
    return null;
  }
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
  listInterfaces,
  hostsFor,
  pingSweep,
  arpTable,
  defaultGateways,
  reverseDns,
  netbiosName,
  normalizeMac,
  pool,
};
