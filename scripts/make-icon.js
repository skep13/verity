#!/usr/bin/env node
'use strict';
/**
 * Generate the app icon procedurally — the same amber orb the app itself draws.
 *
 * Written as a tiny PNG encoder rather than pulling in an image library, so the
 * project keeps its "two dev dependencies, no native modules" property. Node's
 * zlib does the compression; the rest is a CRC table and a header.
 *
 *   node scripts/make-icon.js   ->  assets/icon.icns
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'assets');

/* ---- minimal PNG encoder ---- */

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- the picture ---- */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded box, negative inside. */
function roundedBox(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - halfW + radius;
  const qy = Math.abs(py) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const c = SIZE / 2;
  // macOS icons sit inside a margin rather than filling the canvas.
  const half = SIZE * 0.402;
  const radius = SIZE * 0.2237;
  const orbR = SIZE * 0.176;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x - c + 0.5;
      const py = y - c + 0.5;

      const plate = smoothstep(1.2, -1.2, roundedBox(px, py, half, half, radius));
      if (plate <= 0.001) continue;

      // Backing plate: cool near-black, lifted very slightly toward the top.
      const vertical = clamp01((py + half) / (half * 2));
      let r = mix(21, 9, vertical);
      let g = mix(23, 10, vertical);
      let b = mix(28, 13, vertical);

      const dist = Math.hypot(px, py);

      // Warm atmosphere. Kept tight and dim — a wide halo turns the whole plate
      // muddy brown and the orb stops reading as a light source.
      const halo = Math.exp(-Math.pow(dist / (orbR * 1.35), 2)) * 0.38;
      r += 233 * halo * 0.34;
      g += 150 * halo * 0.24;
      b += 70 * halo * 0.11;

      // The orb, lit from the upper left like the one in the app.
      const edge = smoothstep(orbR + 1.4, orbR - 1.4, dist);
      if (edge > 0) {
        const lx = px + orbR * 0.36;
        const ly = py + orbR * 0.4;
        const lit = clamp01(1 - Math.hypot(lx, ly) / (orbR * 1.7));
        const shade = Math.pow(lit, 1.9);
        const orbR_ = mix(148, 255, shade);
        const orbG_ = mix(84, 240, shade);
        const orbB_ = mix(24, 198, shade);
        r = mix(r, orbR_, edge);
        g = mix(g, orbG_, edge);
        b = mix(b, orbB_, edge);
      }

      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(clamp01(r / 255) * 255);
      rgba[i + 1] = Math.round(clamp01(g / 255) * 255);
      rgba[i + 2] = Math.round(clamp01(b / 255) * 255);
      rgba[i + 3] = Math.round(plate * 255);
    }
  }
  return rgba;
}

fs.mkdirSync(OUT, { recursive: true });
const png = path.join(OUT, 'icon.png');
fs.writeFileSync(png, encodePng(render(), SIZE, SIZE));
console.log(`wrote ${png}`);

// Build the .icns via the system tools, which want a populated .iconset folder.
const iconset = path.join(OUT, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);

for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
}

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${path.join(OUT, 'icon.icns')}`);
