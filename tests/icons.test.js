import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { renderIcon, crc32, iconFileName, SIZES, BACKGROUND, FOREGROUND } from "../tools/make-icons.js";

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
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
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

test("icons: a solid color square with an A: background in the corners, letter in the middle", () => {
  for (const size of SIZES) {
    const png = decode(fs.readFileSync(iconPath(size)));
    const at = (u, v) => png.pixel(Math.floor(u * size), Math.floor(v * size));
    for (const [u, v] of [[0.01, 0.01], [0.99, 0.01], [0.01, 0.99], [0.99, 0.99], [0.5, 0.05]]) {
      assert.deepEqual(at(u, v), BACKGROUND, `${size}px background at ${u},${v}`);
    }
    assert.deepEqual(at(0.5, 0.265), FOREGROUND, "the top of the A");
    assert.deepEqual(at(0.419, 0.5), FOREGROUND, "the left leg");
    assert.deepEqual(at(0.581, 0.5), FOREGROUND, "the right leg");
    assert.deepEqual(at(0.35, 0.7), FOREGROUND, "the left foot");
    assert.deepEqual(at(0.65, 0.7), FOREGROUND, "the right foot");
    assert.deepEqual(at(0.5, 0.56), FOREGROUND, "the crossbar");
    // the openings that make it an A and not a solid triangle
    assert.deepEqual(at(0.5, 0.45), BACKGROUND, "the hole above the crossbar");
    assert.deepEqual(at(0.5, 0.65), BACKGROUND, "the gap between the legs below the crossbar");
    assert.deepEqual(at(0.3, 0.5), BACKGROUND, "outside the left leg");
    assert.deepEqual(at(0.5, 0.2), BACKGROUND, "above the top of the A");
  }
});

test("icons: the letter stays well inside the square, so maskable cropping would not cut it", () => {
  const size = 192;
  const png = decode(fs.readFileSync(iconPath(size)));
  let farthest = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = png.pixel(x, y);
      const isBackground = r === BACKGROUND[0] && g === BACKGROUND[1] && b === BACKGROUND[2];
      if (!isBackground) farthest = Math.max(farthest, Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5));
    }
  }
  assert.ok(farthest <= 0.31, `letter reaches ${farthest.toFixed(3)} of the width from the centre`);
  assert.ok(farthest >= 0.28, "the letter should be large enough to read");
});

test("icons: the CRC implementation agrees with the standard check value and with zlib", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  if (typeof zlib.crc32 === "function") assert.equal(crc32(Buffer.from("Apogee")), zlib.crc32(Buffer.from("Apogee")));
});
