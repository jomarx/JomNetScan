'use strict';

// The parts of the network layer that don't care what OS they're on: address
// arithmetic, interface enumeration, the worker pool, and reverse DNS.
//
// Everything that shells out to a platform command lives in windows.js or
// linux.js. Both of those require this file; index.js picks one and merges.

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

/**
 * Is this command on PATH? Used to decide whether an optional helper is worth
 * calling at all - spawning a missing binary once per host in a /24 sweep is
 * 254 pointless process launches and 254 identical ENOENTs.
 */
function hasCommand(name) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [name], { timeout: 3000, windowsHide: true }, (err) => resolve(!err));
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
 * Adapters that belong to a container runtime or a hypervisor rather than to a
 * network you'd want to scan. The /22 width test below already rejects most of
 * them - Docker hands out /16s - but they'd still clutter the interface
 * dropdown with a dozen entries on a server that runs containers.
 */
const VIRTUAL_INTERFACE = /^(docker\d|br-|veth|virbr|vmnet|vboxnet|vEthernet)/i;

/**
 * IPv4 interfaces worth scanning: up, not loopback, not link-local, not virtual.
 * Each carries the host range implied by its netmask.
 */
function listInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
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
 * Shared by both ARP parsers. A row is only interesting if it has an address
 * and a unicast hardware address behind it.
 *
 * The multicast test is on the IP, not a trailing `.255`: on a /23 or /22,
 * which this app scans, x.x.0.255 is an ordinary host. Callers already
 * restrict results to real host addresses in their own subnet.
 */
function isUsableArpRow(ip, mac) {
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac.startsWith('33:33')) return false;
  if (ip.startsWith('224.') || ip.startsWith('239.')) return false;
  return true;
}

module.exports = {
  IPV4,
  MAC,
  run,
  hasCommand,
  normalizeMac,
  ipToInt,
  intToIp,
  maskToPrefix,
  listInterfaces,
  hostsFor,
  pool,
  reverseDns,
  isUsableArpRow,
};
