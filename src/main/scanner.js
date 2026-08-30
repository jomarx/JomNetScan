'use strict';

const { EventEmitter } = require('events');
const net = require('./net.js');
const oui = require('./oui.js');
const discover = require('./discover.js');

class Scanner extends EventEmitter {
  constructor() {
    super();
    this.running = false;
  }

  /** Interfaces this scan would cover, honouring the interfaceName setting. */
  targets(settings) {
    const all = net.listInterfaces();
    const scannable = all.filter((i) => i.scannable);
    if (!settings.interfaceName) return scannable;
    return scannable.filter((i) => i.name === settings.interfaceName);
  }

  async scan(settings) {
    if (this.running) throw new Error('A scan is already running');
    this.running = true;
    const startedAt = new Date().toISOString();

    try {
      const ifaces = this.targets(settings);
      if (!ifaces.length) {
        throw new Error('No scannable IPv4 network found. Are you connected to Wi-Fi or Ethernet?');
      }

      const selfMacs = new Set(ifaces.map((i) => i.mac).filter(Boolean));
      const selfIps = new Set(ifaces.map((i) => i.address));

      // Devices that announce themselves do so on their own schedule, so start
      // listening now and collect the results at the end of the scan.
      const discovery = settings.discoverNames === false
        ? Promise.resolve(new Map())
        : discover
          .discoverNames({ interfaceAddress: ifaces[0].address, timeoutMs: 12000 })
          .catch(() => new Map());

      // 1. Sweep every host so the ARP cache is fresh.
      const hosts = ifaces.flatMap((i) => net.hostsFor(i));
      const hostSet = new Set(hosts);
      this.emit('progress', { phase: 'ping', done: 0, total: hosts.length });
      await net.pingSweep(hosts, {
        concurrency: settings.concurrency,
        timeoutMs: settings.pingTimeoutMs,
        onProgress: (done, total) => this.emit('progress', { phase: 'ping', done, total }),
      });

      // 2. Read who actually answered.
      this.emit('progress', { phase: 'arp', done: 0, total: 1 });
      const [arp, gateways] = await Promise.all([net.arpTable(), net.defaultGateways()]);

      const found = new Map();
      for (const [ip, mac] of arp) {
        if (!hostSet.has(ip) && !selfIps.has(ip)) continue;
        found.set(ip, { ip, mac });
      }
      // This machine never appears in its own ARP table.
      for (const iface of ifaces) {
        if (!found.has(iface.address)) found.set(iface.address, { ip: iface.address, mac: iface.mac });
      }

      const devices = [...found.values()].map((d) => ({
        ...d,
        isGateway: gateways.has(d.ip),
        isSelf: selfIps.has(d.ip) || (d.mac ? selfMacs.has(d.mac) : false),
        vendor: oui.lookup(d.mac),
        randomizedMac: oui.isRandomized(d.mac),
      }));

      // 3. Put names to them.
      this.emit('progress', { phase: 'names', done: 0, total: devices.length });
      let named = 0;
      await net.pool(devices, 16, async (device) => {
        device.hostname = await net.reverseDns(device.ip);
        if (!device.hostname && settings.useNetbios) {
          device.hostname = await net.netbiosName(device.ip);
        }
        named += 1;
        this.emit('progress', { phase: 'names', done: named, total: devices.length });
      });

      // 4. Fold in whatever the devices volunteered about themselves.
      this.emit('progress', { phase: 'discover', done: 0, total: 1 });
      const announced = await discovery;
      for (const device of devices) {
        const match = announced.get(device.ip);
        device.discoveredName = match ? match.name : null;
        device.discoveredVia = match ? match.source : null;
      }
      this.emit('progress', { phase: 'discover', done: 1, total: 1 });

      devices.sort((a, b) => {
        const [x, y] = [a.ip.split('.').map(Number), b.ip.split('.').map(Number)];
        for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
        return 0;
      });

      return { devices, startedAt, finishedAt: new Date().toISOString(), interfaces: ifaces };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Scanner };
