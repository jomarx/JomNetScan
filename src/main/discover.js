'use strict';

// Ask the network what things call themselves, rather than guessing from the MAC.
//
// Two protocols cover most of a home LAN:
//   mDNS/Bonjour - Apple gear, Chromecasts, printers, NAS boxes, Home Assistant
//   SSDP/UPnP    - smart TVs, routers, media servers, some IoT plugs
//
// Both are best-effort. Anything that stays quiet keeps its blank name.

const dgram = require('dgram');
const http = require('http');
const multicastDns = require('multicast-dns');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

// Service types worth asking about by name. The wildcard enumeration below
// finds others, but an explicit query gets answers from devices that ignore it.
const SERVICE_TYPES = [
  '_services._dns-sd._udp.local',
  '_googlecast._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_homekit._tcp.local',
  '_hap._tcp.local',
  '_ipp._tcp.local',
  '_printer._tcp.local',
  '_pdl-datastream._tcp.local',
  '_workstation._tcp.local',
  '_smb._tcp.local',
  '_afpovertcp._tcp.local',
  '_http._tcp.local',
  '_spotify-connect._tcp.local',
  '_androidtvremote2._tcp.local',
  '_miio._udp.local',
  '_esphomelib._tcp.local',
];

/**
 * mDNS instance labels arrive DNS-escaped: spaces as \032, dots as \. and so on.
 * Turn them back into something a person would recognise.
 */
function unescapeLabel(label) {
  return label
    .replace(/\\(\d{3})/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\\(.)/g, '$1')
    .trim();
}

/** Strip the service suffix, leaving the human part: "Kitchen Hub._googlecast._tcp.local" -> "Kitchen Hub". */
function instanceLabel(name) {
  const cut = name.indexOf('._');
  return unescapeLabel(cut === -1 ? name : name.slice(0, cut));
}

/**
 * "Google-Home-Mini-d342580c2f1317daa934ddbb1f730f6c" is a device id wearing a
 * model number. Drop the hex tail and let the words breathe.
 */
function tidyLabel(label) {
  const stripped = label.replace(/[-_]?[0-9a-f]{12,}$/i, '').replace(/[-_]+$/, '');
  const base = stripped.length >= 2 ? stripped : label;
  return /\s/.test(base) ? base : base.replace(/[-_]+/g, ' ');
}

/** TXT records arrive as an array of Buffers holding "key=value" pairs. */
function parseTxt(data) {
  const out = {};
  for (const entry of data || []) {
    const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq).toLowerCase()] = text.slice(eq + 1);
  }
  return out;
}

/**
 * Some services advertise an instance that is really an identifier:
 * "nearby presence nsd e2c3cf16 3a26 4c08 a847". Adopting one of those as a
 * device name is worse than leaving the field blank.
 */
function looksLikeIdentifier(label) {
  if (!label) return true;
  const tokens = label.split(/[\s._-]+/).filter(Boolean);
  // Model numbers like "AC750" are accidentally all-hex, so one or two of these
  // prove nothing. Three or more means we are looking at an id.
  const hexTokens = tokens.filter((t) => /^[0-9a-f]{4,}$/i.test(t));
  if (hexTokens.length >= 3) return true;
  // A punctuated UUID. The separators have to be there: an unbroken hex run is
  // just a serial number glued to a model name, and tidyLabel strips those.
  if (/[0-9a-f]{8}[\s._-]([0-9a-f]{4}[\s._-]){3}[0-9a-f]{8,}/i.test(label)) return true;
  return false;
}

function isUsefulName(name) {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 63) return false;
  // A bare hex blob or an IP restated as a name tells the user nothing.
  if (/^[0-9a-f]{12,}$/i.test(trimmed.replace(/[-:]/g, ''))) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return false;
  return true;
}

/**
 * Listen for mDNS announcements and actively enumerate services.
 * Returns ip -> { name, source } for whatever answered.
 */
function mdnsScan({ interfaceAddress, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let mdns;
    try {
      mdns = multicastDns({ interface: interfaceAddress, loopback: false, reuseAddr: true });
    } catch {
      resolve(new Map());
      return;
    }

    const aRecords = new Map(); // lowercase hostname -> ip
    const srvTargets = new Map(); // instance name -> target hostname
    const instances = new Set(); // service instance names
    const hostnames = new Set(); // plain .local hostnames
    const txtRecords = new Map(); // instance name -> parsed TXT pairs

    const collect = (packet) => {
      const records = [...(packet.answers || []), ...(packet.additionals || [])];
      for (const record of records) {
        if (!record || !record.name) continue;
        if (record.type === 'A' && typeof record.data === 'string') {
          aRecords.set(record.name.toLowerCase(), record.data);
          hostnames.add(record.name);
        } else if (record.type === 'SRV' && record.data && record.data.target) {
          srvTargets.set(record.name, record.data.target);
          instances.add(record.name);
        } else if (record.type === 'TXT') {
          txtRecords.set(record.name, parseTxt(record.data));
          instances.add(record.name);
        } else if (record.type === 'PTR' && typeof record.data === 'string') {
          // A PTR under a concrete service type points at an instance.
          if (record.name !== '_services._dns-sd._udp.local') instances.add(record.data);
        }
      }
    };

    mdns.on('response', collect);
    mdns.on('error', () => {});

    for (const type of SERVICE_TYPES) {
      try {
        mdns.query([{ name: type, type: 'PTR' }]);
      } catch {
        // A query that can't go out on this interface isn't fatal.
      }
    }

    setTimeout(() => {
      try { mdns.destroy(); } catch { /* already gone */ }

      const byIp = new Map();
      const claim = (ip, name, source) => {
        if (!ip || !isUsefulName(name)) return;
        const current = byIp.get(ip);
        // A service instance name ("Kitchen Speaker") beats a hostname ("esp-1a2b").
        if (!current || (current.source === 'mdns-host' && source === 'mdns-service')) {
          byIp.set(ip, { name, source });
        }
      };

      for (const instance of instances) {
        const target = srvTargets.get(instance);
        const ip = target ? aRecords.get(target.toLowerCase()) : null;
        // Chromecast and friends put the name the owner actually chose in TXT "fn".
        const txt = txtRecords.get(instance) || {};
        const friendly = txt.fn || txt.n || txt.name;
        const raw = instanceLabel(instance);
        const fallback = looksLikeIdentifier(raw) ? null : tidyLabel(raw);
        claim(ip, isUsefulName(friendly) ? friendly.trim() : fallback, 'mdns-service');
      }
      for (const host of hostnames) {
        const label = unescapeLabel(host.replace(/\.local\.?$/i, ''));
        if (looksLikeIdentifier(label)) continue;
        claim(aRecords.get(host.toLowerCase()), tidyLabel(label), 'mdns-host');
      }

      resolve(byIp);
    }, timeoutMs);
  });
}

function parseUpnpName(body) {
  const friendly = /<friendlyName>([^<]+)<\/friendlyName>/i.exec(body);
  const model = /<modelName>([^<]+)<\/modelName>/i.exec(body);
  return (friendly && friendly[1].trim()) || (model && model[1].trim()) || null;
}

/**
 * Fetch a UPnP device description and pull the name the vendor put in it.
 *
 * This promise must always settle. Callers await it inside a Promise.all that
 * gates the whole scan, so one unresponsive device would otherwise hang
 * scanning for the lifetime of the process. `req.destroy()` emits no 'error'
 * of its own, so neither 'end' nor 'error' is guaranteed to fire once we tear
 * the request down - hence the hard deadline below, which is the only path
 * that cannot be skipped.
 */
function fetchUpnpName(location, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let body = '';
    const deadline = setTimeout(() => done(parseUpnpName(body)), timeoutMs * 2);

    function done(value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (req && !req.destroyed) req.destroy();
      resolve(value);
    }

    try {
      req = http.get(location, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); done(null); return; }
        res.setEncoding('utf8');
        // A truncated or aborted response still settles, with whatever we read.
        res.on('error', () => done(parseUpnpName(body)));
        res.on('aborted', () => done(parseUpnpName(body)));
        res.on('close', () => done(parseUpnpName(body)));
        res.on('data', (chunk) => {
          body += chunk;
          // Descriptions are small, and the name sits near the top, so what we
          // already have is worth parsing rather than discarding.
          if (body.length > 64 * 1024) done(parseUpnpName(body));
        });
        res.on('end', () => done(parseUpnpName(body)));
      });
    } catch {
      done(null);
      return;
    }
    req.on('timeout', () => done(parseUpnpName(body)));
    req.on('error', () => done(null));
  });
}

/** M-SEARCH the LAN, then read each responder's description for its friendly name. */
function ssdpScan({ interfaceAddress, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const locations = new Map(); // ip -> description URL
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve(new Map());
      return;
    }

    socket.on('error', () => { try { socket.close(); } catch { /* closed */ } resolve(new Map()); });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const match = /^location:\s*(\S+)\s*$/im.exec(text);
      if (match && !locations.has(rinfo.address)) locations.set(rinfo.address, match[1]);
    });

    socket.bind(0, interfaceAddress || undefined, () => {
      const search = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n'
        + `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n`
        + 'MAN: "ssdp:discover"\r\n'
        + 'MX: 2\r\n'
        + 'ST: ssdp:all\r\n\r\n',
      );
      // Sent twice - UDP discovery packets get dropped and nobody retries them.
      try {
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
        for (const delay of [900, 2600]) {
          setTimeout(() => { try { socket.send(search, SSDP_PORT, SSDP_ADDRESS); } catch { /* closing */ } }, delay);
        }
      } catch {
        // Interface may not allow multicast; fall through to the timeout.
      }

      setTimeout(async () => {
        try { socket.close(); } catch { /* already closed */ }
        const byIp = new Map();
        await Promise.all([...locations].map(async ([ip, location]) => {
          const name = await fetchUpnpName(location);
          if (isUsefulName(name)) byIp.set(ip, { name, source: 'ssdp' });
        }));
        resolve(byIp);
      }, timeoutMs);
    });
  });
}

/** Run both discoveries together; mDNS names win where the two disagree. */
async function discoverNames({ interfaceAddress, timeoutMs = 6000 } = {}) {
  const [fromMdns, fromSsdp] = await Promise.all([
    mdnsScan({ interfaceAddress, timeoutMs }),
    ssdpScan({ interfaceAddress, timeoutMs: Math.min(timeoutMs, 9000) }),
  ]);
  const merged = new Map(fromSsdp);
  for (const [ip, value] of fromMdns) merged.set(ip, value);
  return merged;
}

module.exports = {
  discoverNames, mdnsScan, ssdpScan, isUsefulName, looksLikeIdentifier,
  instanceLabel, tidyLabel, unescapeLabel,
};
