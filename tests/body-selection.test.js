// The selected muscle's inner line (src/ui/body-diagram.js): which shapes it has, as data. Not a test of how it looks;
// the colours are checked in the browser suite, where the stylesheet is loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionLines, SELECT_INSET } from "../src/ui/body-diagram.js";
import { BODY_REGIONS, VIEWS } from "../src/ui/body-regions.js";

test("a selected muscle gets one inner line per shape, inside it with the same centre and rotation; other muscles and null get none", () => {
  for (const view of VIEWS) {
    for (const { muscle, shapes } of BODY_REGIONS[view].regions) {
      const lines = selectionLines(view, muscle);
      assert.equal(lines.length, shapes.length, `${view} ${muscle}`);
      lines.forEach((line, i) => {
        const shape = shapes[i];
        assert.deepEqual([line.cx, line.cy, line.rot, line.type], [shape.cx, shape.cy, shape.rot, shape.type], `${view} ${muscle}: same centre and rotation`);
        assert.ok(line.rx > 0 && line.ry > 0 && line.rx <= shape.rx && line.ry <= shape.ry, `${view} ${muscle}: inside the shape`);
      });
    }
    assert.deepEqual(selectionLines(view, null), []);
    assert.deepEqual(selectionLines(view, "neck"), [], "the neck has no region");
  }
  assert.deepEqual(selectionLines("back", "side_delts"), [], "not a muscle of the back view: none");
  assert.deepEqual(selectionLines("back", "chest"), []);
  assert.deepEqual(selectionLines("front", "traps"), []);
});

test("the inner line is SELECT_INSET inside the edge, and never smaller than a thin line, even in the smallest shape", () => {
  const quads = selectionLines("front", "quads")[0];
  assert.deepEqual([quads.rx, quads.ry], [11 - SELECT_INSET, 45 - SELECT_INSET]);
  for (const view of VIEWS) {
    for (const { muscle } of BODY_REGIONS[view].regions) {
      for (const line of selectionLines(view, muscle)) assert.ok(line.rx >= 0.8 && line.ry >= 0.8, `${view} ${muscle}`);
    }
  }
  const adductors = selectionLines("front", "adductors")[0];
  assert.equal(adductors.rx, 0.8, "adductors are 3.5 wide: the line is clamped");
});

test("selectionLines does not change the region data", () => {
  const before = JSON.stringify(BODY_REGIONS);
  selectionLines("front", "quads");
  assert.equal(JSON.stringify(BODY_REGIONS), before);
});
