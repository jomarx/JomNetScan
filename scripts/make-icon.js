#!/usr/bin/env node
'use strict';

// Draws the app icon - a radar sweep, matching the ring in the app's header -
// and writes build/icon.ico plus src/assets/tray.png.
//
// Generated rather than committed as an opaque blob so the shape and colours
// can be adjusted by editing numbers here. No image libraries: PNG is a header,
// a deflate stream and a CRC, and ICO is a table of PNGs.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ACCENT = [0x5a, 0xa9, 0xff]; // --accent from the UI
const PLATE = [0x15, 0x18, 0x20]; // near-black disc the rings sit on
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4; // rendered at 4x and averaged down, for clean edges

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode straight RGBA bytes as a PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Coverage of one supersampled point, as a set of shapes painted back to front.
 * Returns [r, g, b, a] with a in 0..1.
 */
function sample(nx, ny, simple) {
  // nx, ny are -1..1 with the origin at the centre.
  const dist = Math.hypot(nx, ny);
  const angle = Math.atan2(ny, nx); // -PI..PI

  let out = [0, 0, 0, 0];
  const paint = (rgb, alpha) => {
    if (alpha <= 0) return;
    const a = out[3] + alpha * (1 - out[3]);
    for (let i = 0; i < 3; i++) {
      out[i] = (rgb[i] * alpha + out[i] * out[3] * (1 - alpha)) / (a || 1);
    }
    out[3] = a;
  };

  // Background disc.
  if (dist <= 0.98) paint(PLATE, 1);

  const ring = (radius, halfWidth) => Math.abs(dist - radius) <= halfWidth;

  // The gap that turns a target into a radar sweep, in the lower-right quadrant.
  const inGap = angle > 0.02 && angle < 1.45;

  if (simple) {
    // Below ~20px there aren't enough pixels for two rings; one fat ring and a
    // big dot stays legible where the full design turns to mush.
    if (ring(0.66, 0.13) && !inGap) paint(ACCENT, 1);
    if (dist <= 0.26) paint(ACCENT, 1);
    return out;
  }

  if (ring(0.76, 0.058) && !inGap) paint(ACCENT, 1);
  if (ring(0.48, 0.058)) paint(ACCENT, 1);
  if (dist <= 0.155) paint(ACCENT, 1);

  return out;
}

function renderRgba(size) {
  const simple = size <= 20;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          const s = sample(px * 2 - 1, py * 2 - 1, simple);
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE;
      const i = (y * size + x) * 4;
      // Un-premultiply so the stored colour is right where alpha is partial.
      rgba[i] = a > 0 ? Math.round(r / a) : 0;
      rgba[i + 1] = a > 0 ? Math.round(g / a) : 0;
      rgba[i + 2] = a > 0 ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round((a / n) * 255);
    }
  }
  return rgba;
}

/** Wrap PNGs in an ICO directory. Windows accepts PNG-compressed entries. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const root = path.join(__dirname, '..');
const images = SIZES.map((size) => ({ size, png: encodePng(size, size, renderRgba(size)) }));

const icoPath = path.join(root, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(icoPath), { recursive: true });
fs.writeFileSync(icoPath, buildIco(images));
console.log(`icon.ico  ${SIZES.join(', ')} px  ${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB`);

// The tray wants a single small bitmap, not an icon set.
const trayPath = path.join(root, 'src', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(trayPath), { recursive: true });
fs.writeFileSync(trayPath, images.find((i) => i.size === 32).png);
console.log(`tray.png  32 px  ${(fs.statSync(trayPath).size / 1024).toFixed(1)} KB`);

// The window icon for dev runs, where there is no exe to carry the icon.
const winIconPath = path.join(root, 'src', 'assets', 'icon.png');
fs.writeFileSync(winIconPath, images.find((i) => i.size === 256).png);
console.log(`icon.png  256 px  ${(fs.statSync(winIconPath).size / 1024).toFixed(1)} KB  (src/assets)`);

// A large flat PNG is handy for the README and any future store listing.
const appPngPath = path.join(root, 'build', 'icon.png');
fs.writeFileSync(appPngPath, images.find((i) => i.size === 256).png);
console.log(`icon.png  256 px  ${(fs.statSync(appPngPath).size / 1024).toFixed(1)} KB`);
