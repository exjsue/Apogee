import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const manifest = JSON.parse(read("manifest.webmanifest"));
const html = read("index.html");
const css = read("src", "ui", "app.css");

// The value of a CSS variable, from the :root block (the app is dark only, so there is one).
function themeColor(name) {
  const found = new RegExp(`:root\\s*\\{[^}]*--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(found, `--${name} in :root`);
  return found[1].toLowerCase();
}

// width and height of a PNG, from its header
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

const isRelative = (url) => !url.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(url);

test("manifest: name, standalone display, and a start URL and scope that are relative to the subpath", () => {
  assert.equal(manifest.name, "Apogee");
  assert.equal(manifest.short_name, "Apogee");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(typeof manifest.description, "string");
});

test("manifest: the colors are the app's own: the page background from app.css (the app is dark only, so it is both)", () => {
  assert.equal(manifest.background_color, themeColor("bg"));
  assert.equal(manifest.theme_color, themeColor("bg"));
});

test("manifest: every URL in it is relative (nothing starts with / or names a host)", () => {
  const urls = [manifest.start_url, manifest.scope, ...manifest.icons.map((icon) => icon.src)];
  for (const url of urls) assert.ok(isRelative(url), `not relative: ${url}`);
  assert.ok(!/https?:\/\//.test(JSON.stringify(manifest)), "no http(s) URLs");
});

test("manifest: the icons exist, are PNG, and their declared sizes match the files", () => {
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes).sort(), ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    const file = path.join(ROOT, icon.src);
    assert.ok(fs.existsSync(file), icon.src);
    assert.equal(icon.type, "image/png");
    assert.equal(pngSize(file), icon.sizes, icon.src);
  }
});

test("index.html: links the manifest and a 180 px apple-touch-icon, both relative", () => {
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  const touch = /<link rel="apple-touch-icon" href="(\.\/[^"]+)">/.exec(html);
  assert.ok(touch, "apple-touch-icon link");
  assert.equal(pngSize(path.join(ROOT, touch[1])), "180x180");
});

test("index.html: theme-color matches the app's CSS page background", () => {
  const found = /<meta name="theme-color" content="(#[0-9a-f]{6})">/.exec(html);
  assert.ok(found, "the theme-color meta");
  assert.equal(found[1], themeColor("bg"));
});

test("the server sends the manifest as application/manifest+json and the icons as image/png", () => {
  const source = read("tools", "serve.js");
  assert.match(source, /"\.webmanifest": "application\/manifest\+json"/);
  assert.match(source, /"\.png": "image\/png"/);
  assert.match(source, /ROOT_FILES = \[[^\]]*"manifest\.webmanifest"/);
  assert.match(source, /SERVED_FOLDERS = \[[^\]]*"icons"/);
});
