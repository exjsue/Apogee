// Generates the app icons: a solid dark-green square with an off-white letter G,
// as PNG files. Node built-ins only (zlib does the PNG compression).
// Usage: node tools/make-icons.js     (rewrites icons/icon-180.png, -192, -512)
//
// The output is deterministic, and a test checks that the committed PNGs equal
// what this script produces, so the script and the files cannot drift apart.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

// The colors of the app (src/ui/app.css, light theme): the accent and the page background.
export const BACKGROUND = [0x1f, 0x5f, 0x4a];
export const FOREGROUND = [0xf7, 0xf6, 0xf2];
export const SIZES = [180, 192, 512];

// The G, in units of the icon's width: a ring around the centre with a gap at
// the upper right, and a bar from the centre out to the ring on the right.
// The whole letter stays inside a circle of radius 0.30, so it also survives
// the cropping that "maskable" icons get.
const OUTER = 0.30;
const INNER = 0.19;
const GAP_FROM_DEGREES = 8;
const GAP_TO_DEGREES = 52;
const BAR_HALF_HEIGHT = 0.05;

export function isInsideG(u, v) {
  const dx = u - 0.5;
  const dy = 0.5 - v; // y points up here
  const radius = Math.hypot(dx, dy);
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const inRing = radius >= INNER && radius <= OUTER && !(degrees > GAP_FROM_DEGREES && degrees < GAP_TO_DEGREES);
  const inBar = dx >= 0 && dx <= OUTER && Math.abs(dy) <= BAR_HALF_HEIGHT;
  return inRing || inBar;
}

// Fraction of the pixel covered by the G, from a 4 x 4 grid of samples (smooth edges).
function coverage(x, y, size) {
  const samples = 4;
  let inside = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      if (isInsideG((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size)) inside += 1;
    }
  }
  return inside / (samples * samples);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// An opaque 8-bit RGB PNG (no transparency, which iOS requires for touch icons).
export function renderIcon(size) {
  const rowLength = size * 3 + 1;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLength] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const alpha = coverage(x, y, size);
      for (let channel = 0; channel < 3; channel++) {
        raw[y * rowLength + 1 + x * 3 + channel] = Math.round(BACKGROUND[channel] * (1 - alpha) + FOREGROUND[channel] * alpha);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const iconFileName = (size) => `icon-${size}.png`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "icons");
  fs.mkdirSync(folder, { recursive: true });
  for (const size of SIZES) {
    const file = path.join(folder, iconFileName(size));
    fs.writeFileSync(file, renderIcon(size));
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}
