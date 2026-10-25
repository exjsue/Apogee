import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { renderIcon, crc32, iconFileName, SIZES, MASTER_PATH } from "../tools/make-icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconPath = (size) => path.join(ROOT, "icons", iconFileName(size));

// Reads a PNG made by the generator: checks every chunk's CRC and returns the pixels.
function decode(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(crc32(buffer.subarray(offset + 4, offset + 8 + length)), crc, `CRC of ${type}`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"], "no ancillary chunk (no metadata, no C2PA, no EXIF)");
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = zlib.inflateSync(chunks[1].data);
  const rowLength = width * 3 + 1;
  assert.equal(raw.length, rowLength * height);
  const pixel = (x, y) => {
    assert.equal(raw[y * rowLength], 0, "filter type none");
    const at = y * rowLength + 1 + x * 3;
    return [raw[at], raw[at + 1], raw[at + 2]];
  };
  return { width, height, bitDepth: header[8], colorType: header[9], pixel };
}

test("icons: the sizes are 180 (apple touch icon), 192 and 512 (manifest)", () => {
  assert.deepEqual(SIZES, [180, 192, 512]);
  for (const size of SIZES) assert.ok(fs.existsSync(iconPath(size)), iconFileName(size));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "icons")).sort(), SIZES.map(iconFileName).sort());
});

test("icons: the committed PNGs are exactly what tools/make-icons.js produces", () => {
  for (const size of SIZES) {
    assert.ok(fs.readFileSync(iconPath(size)).equals(renderIcon(size)), `${iconFileName(size)} differs from the generator's output; run node tools/make-icons.js`);
  }
});

test("icons: each is a valid, opaque 8-bit RGB PNG of the right size", () => {
  for (const size of SIZES) {
    const png = decode(fs.readFileSync(iconPath(size)));
    assert.equal(png.width, size);
    assert.equal(png.height, size);
    assert.equal(png.bitDepth, 8);
    assert.equal(png.colorType, 2, "RGB with no alpha channel, so iOS gets an opaque square");
  }
});

test("icons: the master artwork is a square of at least 512 px with no metadata chunks", () => {
  const master = fs.readFileSync(MASTER_PATH);
  const png = decode(master); // also checks that only IHDR, IDAT and IEND are present
  assert.equal(png.width, png.height);
  assert.ok(png.width >= 512, `master is ${png.width} px`);
  assert.equal(png.colorType, 2);
});

test("icons: each is the artwork: black corners, white strokes in the middle, and not a blank square", () => {
  for (const size of SIZES) {
    const png = decode(fs.readFileSync(iconPath(size)));
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.deepEqual(png.pixel(x, y), [0, 0, 0], `${size}px corner ${x},${y}`);
    let white = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (png.pixel(x, y)[0] > 240) white += 1;
    assert.ok(white > size * size * 0.03 && white < size * size * 0.3, `${size}px: ${white} white pixels`);
  }
});

test("icons: the artwork stays inside the middle of the square, so a rounded or cropped icon would not cut it", () => {
  const png = decode(fs.readFileSync(iconPath(512)));
  let farthest = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (png.pixel(x, y)[0] > 40) farthest = Math.max(farthest, Math.hypot((x + 0.5) / 512 - 0.5, (y + 0.5) / 512 - 0.5));
  assert.ok(farthest <= 0.4, `artwork reaches ${farthest.toFixed(3)} of the width from the centre (a maskable safe zone has radius 0.4)`);
});

test("icons: the CRC implementation agrees with the standard check value and with zlib", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  if (typeof zlib.crc32 === "function") assert.equal(crc32(Buffer.from("Apogee")), zlib.crc32(Buffer.from("Apogee")));
});
