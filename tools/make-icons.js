// Generates the app icons: a solid dark-green square with an off-white letter A,
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

// The A, in units of the icon's width, measured from the centre (y points up): two
// strokes with rounded ends that meet at the top and spread to the feet, and a
// crossbar between them. The whole letter stays inside a circle of radius 0.30
// around the centre, so it also survives the cropping that "maskable" icons get.
const APEX_Y = 0.235; // centre of the rounded top
const FOOT_X = 0.15;
const FOOT_Y = -0.2;
const HALF_WIDTH = 0.045; // half the stroke width
const BAR_Y = -0.06;
const BAR_HALF_HEIGHT = 0.035;

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// How far from the middle a leg is at height y.
const legX = (y) => (FOOT_X * (APEX_Y - y)) / (APEX_Y - FOOT_Y);

export function isInsideA(u, v) {
  const x = u - 0.5;
  const y = 0.5 - v;
  const leg = (sign) => distanceToSegment(x, y, 0, APEX_Y, sign * FOOT_X, FOOT_Y) <= HALF_WIDTH;
  const bar = Math.abs(y - BAR_Y) <= BAR_HALF_HEIGHT && Math.abs(x) <= legX(BAR_Y);
  return leg(-1) || leg(1) || bar;
}

// Fraction of the pixel covered by the A, from a 4 x 4 grid of samples (smooth edges).
function coverage(x, y, size) {
  const samples = 4;
  let inside = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      if (isInsideA((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size)) inside += 1;
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
