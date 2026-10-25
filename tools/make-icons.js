// Generates the app icons (icons/icon-180.png, -192, -512) by shrinking the master artwork,
// design/apogee-icon-master.png (a 1254 px opaque RGB PNG). Node built-ins only (zlib does the
// PNG compression and decompression).
// Usage: node tools/make-icons.js
//
// The output is deterministic, and a test checks that the committed PNGs equal what this
// script produces, so the script and the files cannot drift apart. The outputs are rebuilt from
// pixels and contain only the IHDR, IDAT and IEND chunks, so no metadata can carry over.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SIZES = [180, 192, 512];

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MASTER_PATH = path.join(ROOT, "design", "apogee-icon-master.png");

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

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Reads an 8-bit RGB, non-interlaced PNG into { width, height, pixels } (3 bytes per pixel).
// Anything else (alpha, palette, 16-bit, interlaced) is refused rather than guessed at.
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let header = null;
  const idat = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") header = data;
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  if (header === null) throw new Error("no IHDR");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header[8] !== 8 || header[9] !== 2 || header[12] !== 0) throw new Error("the master must be 8-bit RGB without interlacing");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  if (raw.length !== (stride + 1) * height) throw new Error("the PNG data has the wrong length");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const left = i >= 3 ? pixels[y * stride + i - 3] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 3 ? pixels[(y - 1) * stride + i - 3] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + left;
      else if (filter === 2) value = x + up;
      else if (filter === 3) value = x + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Error(`unknown PNG filter ${filter}`);
      pixels[y * stride + i] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

// sRGB to linear light and back, so that averaging white and black edge pixels does not thin the artwork.
const TO_LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));

// Box filter: every output pixel is the area-weighted average of the source pixels it covers.
export function resizeSquare(source, size) {
  const { width, pixels } = source;
  const scale = width / size;
  const out = Buffer.alloc(size * size * 3);
  for (let oy = 0; oy < size; oy++) {
    const y0 = oy * scale;
    const y1 = y0 + scale;
    for (let ox = 0; ox < size; ox++) {
      const x0 = ox * scale;
      const x1 = x0 + scale;
      const sum = [0, 0, 0];
      let weight = 0;
      for (let y = Math.floor(y0); y < Math.min(width, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(width, Math.ceil(x1)); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const at = (y * width + x) * 3;
          for (let c = 0; c < 3; c++) sum[c] += TO_LINEAR[pixels[at + c]] * w;
          weight += w;
        }
      }
      for (let c = 0; c < 3; c++) out[(oy * size + ox) * 3 + c] = toSrgb(sum[c] / weight);
    }
  }
  return out;
}

// An opaque 8-bit RGB PNG (no transparency, which iOS requires for touch icons).
export function renderIcon(size, master = decodePng(fs.readFileSync(MASTER_PATH))) {
  if (master.width !== master.height || master.width < 512) throw new Error("the master must be square and at least 512 px");
  const rgb = resizeSquare(master, size);
  const rowLength = size * 3 + 1;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) rgb.copy(raw, y * rowLength + 1, y * size * 3, (y + 1) * size * 3); // filter byte 0 = none
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export const iconFileName = (size) => `icon-${size}.png`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const folder = path.join(ROOT, "icons");
  fs.mkdirSync(folder, { recursive: true });
  const master = decodePng(fs.readFileSync(MASTER_PATH));
  for (const size of SIZES) {
    const file = path.join(folder, iconFileName(size));
    fs.writeFileSync(file, renderIcon(size, master));
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}
