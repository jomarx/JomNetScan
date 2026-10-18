'use strict';

// A TCP connect scan of the ports a home network actually runs something on.
//
// This is deliberately opt-in, one device at a time: a full 65535-port sweep of
// every device on every scan would be slow, noisy, and would look like exactly
// the thing an intrusion detector is built to complain about. The curated list
// below answers the question people actually have - "what is this box doing on
// my network" - in a second or two.

const net = require('net');

const COMMON_PORTS = [
  { port: 21, service: 'FTP' },
  { port: 22, service: 'SSH' },
  { port: 23, service: 'Telnet' },
  { port: 25, service: 'SMTP' },
  { port: 53, service: 'DNS' },
  { port: 80, service: 'HTTP' },
  { port: 110, service: 'POP3' },
  { port: 139, service: 'NetBIOS' },
  { port: 143, service: 'IMAP' },
  { port: 443, service: 'HTTPS' },
  { port: 445, service: 'SMB (file sharing)' },
  { port: 515, service: 'Printer (LPD)' },
  { port: 548, service: 'AFP (Apple file sharing)' },
  { port: 554, service: 'RTSP (camera stream)' },
  { port: 631, service: 'IPP (printing)' },
  { port: 993, service: 'IMAPS' },
  { port: 995, service: 'POP3S' },
  { port: 1883, service: 'MQTT' },
  { port: 2049, service: 'NFS' },
  { port: 3306, service: 'MySQL' },
  { port: 3389, service: 'Remote Desktop' },
  { port: 5000, service: 'UPnP / web app' },
  { port: 5432, service: 'PostgreSQL' },
  { port: 5555, service: 'Android debug bridge' },
  { port: 5900, service: 'VNC' },
  { port: 6379, service: 'Redis' },
  { port: 7000, service: 'AirPlay' },
  { port: 8000, service: 'HTTP (alt)' },
  { port: 8008, service: 'Chromecast' },
  { port: 8009, service: 'Chromecast control' },
  { port: 8080, service: 'HTTP (alt)' },
  { port: 8123, service: 'Home Assistant' },
  { port: 8443, service: 'HTTPS (alt)' },
  { port: 8883, service: 'MQTT over TLS' },
  { port: 9100, service: 'Printer (raw)' },
  { port: 32400, service: 'Plex' },
  { port: 62078, service: 'iPhone sync' },
];

/**
 * One TCP connect attempt. Resolves true only on a completed handshake.
 *
 * Like every other probe in this app, it must always settle - the caller waits
 * on a pool of these, so one socket that never resolves would hang the scan.
 */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/**
 * Scan `host` for the common ports. Returns the open ones in port order,
 * reporting progress as it goes.
 */
async function scanPorts(host, { timeoutMs = 1200, concurrency = 24, onProgress } = {}) {
  const queue = COMMON_PORTS.slice();
  const open = [];
  let done = 0;
  const total = queue.length;

  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      if (await probe(host, entry.port, timeoutMs)) open.push(entry);
      done += 1;
      if (onProgress) onProgress(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker),
  );

  open.sort((a, b) => a.port - b.port);
  return open;
}

module.exports = { scanPorts, probe, COMMON_PORTS };
