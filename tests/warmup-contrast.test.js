// The warm-up W is light blue; its text must stay readable in both colour schemes. Reads the real tokens from
// src/ui/app.css (one value in :root, one in the dark-mode block) and checks WCAG contrast of text on its background.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/ui/app.css", import.meta.url), "utf8");
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const token = (block, name) => {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(match, `--${name} is defined`);
  return match[1];
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const [scheme, block] of [["light", light], ["dark", dark]]) {
  test(`warm-up W: text on its light-blue background has contrast of at least 4.5 in ${scheme} mode`, () => {
    const ratio = contrast(token(block, "warmup-text"), token(block, "warmup-bg"));
    assert.ok(ratio >= 4.5, `contrast ${ratio.toFixed(2)}`);
  });
}

test("warm-up W: the two modes use different values", () => {
  assert.notEqual(token(light, "warmup-bg"), token(dark, "warmup-bg"));
});
