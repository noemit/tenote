'use strict';

// Generates tray template icons (16px + 32px @2x) and the 1024px app icon
// (assets/icon.png, used by electron-builder) — no deps, pure PNG encoder.
// Usage: node scripts/gen-icons.js   (writes to assets/)

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// fn(x, y) returns [r, g, b, a] with channels 0-255.
function encodePng(size, fn) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn(x + 0.5, y + 0.5);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
      raw[o + 3] = Math.max(0, Math.min(255, Math.round(a)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rect centered at (cx, cy); negative = inside.
function roundedRectSdf(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Soft coverage from an sdf (~1px antialiased edge).
const cov = (d) => Math.min(1, Math.max(0, 0.7 - d));

// A rounded "note card" with three punched text lines, black + alpha (template).
function trayIcon(size) {
  const c = size / 2;
  const lines = [-0.16 * size, 0.02 * size, 0.20 * size];
  const lineH = Math.max(1, size * 0.07);
  const lineHalfW = size * 0.26;
  return (x, y) => {
    let a = cov(roundedRectSdf(x, y, c, c, size * 0.42, size * 0.40, size * 0.22));
    if (a > 0) {
      for (const ly of lines) {
        if (Math.abs(x - c) < lineHalfW && Math.abs(y - (c + ly)) < lineH / 2) { a = 0; break; }
      }
    }
    return [0, 0, 0, a * 255];
  };
}

// macOS app icon: latte rounded square with a caramel note card (theme colors).
function appIcon(size) {
  const c = size / 2;
  const cream = [243, 234, 219];   // #f3eadb — Latte background
  const caramel = [169, 118, 47];  // #a9762f — Latte accent
  const lines = [-0.088 * size, 0.011 * size, 0.11 * size];
  const lineH = size * 0.038;
  const lineHalfW = size * 0.143;
  return (x, y) => {
    const bgA = cov(roundedRectSdf(x, y, c, c, size * 0.5, size * 0.5, size * 0.225));
    if (bgA <= 0) return [0, 0, 0, 0];
    let cardA = cov(roundedRectSdf(x, y, c, c, size * 0.24, size * 0.23, size * 0.05));
    if (cardA > 0) {
      for (const ly of lines) {
        if (Math.abs(x - c) < lineHalfW && Math.abs(y - (c + ly)) < lineH / 2) { cardA = 0; break; }
      }
    }
    const mix = (from, to, t) => Math.round(from + (to - from) * t);
    return cardA > 0
      ? [mix(cream[0], caramel[0], cardA), mix(cream[1], caramel[1], cardA), mix(cream[2], caramel[2], cardA), bgA * 255]
      : [cream[0], cream[1], cream[2], bgA * 255];
  };
}

function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trayTemplate.png'), encodePng(16, trayIcon(16)));
  fs.writeFileSync(path.join(dir, 'trayTemplate@2x.png'), encodePng(32, trayIcon(32)));
  fs.writeFileSync(path.join(dir, 'icon.png'), encodePng(1024, appIcon(1024)));
}

if (require.main === module) {
  generate(path.join(__dirname, '..', 'assets'));
  console.log('wrote assets/trayTemplate.png, assets/trayTemplate@2x.png, assets/icon.png');
}

module.exports = generate;
