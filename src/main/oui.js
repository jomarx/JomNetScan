'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUI_URL = 'https://standards-oui.ieee.org/oui.txt';

let table = null;
let loadedFrom = null;

/** Parse the IEEE registry's "AABBCC     (base 16)\t\tVENDOR" lines. */
function parseOuiText(text) {
  const map = {};
  const re = /^\s*([0-9A-F]{6})\s+\(base 16\)\s*(.*)$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const vendor = m[2].trim();
    if (vendor) map[m[1].toUpperCase()] = vendor;
  }
  return map;
}

function load(paths) {
  for (const p of paths) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && Object.keys(parsed).length) {
        table = parsed;
        loadedFrom = p;
        return true;
      }
    } catch {
      // Corrupt or half-written file - fall through to the next candidate.
    }
  }
  table = table || {};
  return false;
}

/**
 * The second-least-significant bit of the first octet marks a
 * locally administered address. Phones use these for MAC randomization,
 * which is why the same handset can look like a brand new device.
 */
function isRandomized(mac) {
  if (!mac) return false;
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0b10) !== 0;
}

function lookup(mac) {
  if (!mac) return null;

  if (!table) return null;
  const prefix = mac.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  return table[prefix] || null;
}

function stats() {
  return { entries: table ? Object.keys(table).length : 0, loadedFrom };
}

function download(destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(OUI_URL, { timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`IEEE registry returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const map = parseOuiText(Buffer.concat(chunks).toString('utf8'));
          const count = Object.keys(map).length;
          if (count < 1000) throw new Error('Downloaded registry looked truncated');
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const tmp = `${destPath}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(map));
          fs.renameSync(tmp, destPath);
          table = map;
          loadedFrom = destPath;
          resolve({ entries: count, path: destPath });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out reaching the IEEE registry')));
    req.on('error', reject);
  });
}

module.exports = { load, lookup, download, stats, isRandomized, parseOuiText, OUI_URL };
