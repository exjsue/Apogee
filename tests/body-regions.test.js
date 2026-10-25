// The Body diagram's region data (src/ui/body-regions.js), checked as data: the muscles on each view, the pairing
// of left and right, the split shoulder and the hit areas. Not a test of how it looks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_REGIONS, CENTER_X, VIEWS } from "../src/ui/body-regions.js";
import { ALL_MUSCLES } from "../src/domain/model.js";

const FRONT = ["abductors", "abs", "adductors", "biceps", "calves", "chest", "forearms", "front_delts", "obliques", "quads", "side_delts"];
const BACK = ["abductors", "calves", "forearms", "glutes", "hamstrings", "lats", "lower_back", "rear_delts", "traps", "triceps", "upper_back"];
const EXPECTED = { front: FRONT, back: BACK };

// The larger transparent shape drawn over a visible one, as body-diagram.js makes it.
const hitOf = (shape) => ({ ...shape, ...shape.hit });
const rotate = ([x, y], [cx, cy], degrees) => {
  const a = (degrees * Math.PI) / 180;
  const [dx, dy] = [x - cx, y - cy];
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
};
// Does the shape (an ellipse, or one half of one) contain the point?
function contains(shape, point) {
  const [x, y] = rotate(point, [shape.cx, shape.cy], -shape.rot);
  const [dx, dy] = [x - shape.cx, y - shape.cy];
  if (shape.type === "half" && (shape.face === "right" ? dx < 0 : dx > 0)) return false;
  return (dx / shape.rx) ** 2 + (dy / shape.ry) ** 2 <= 1;
}
// The centre of mass of a half ellipse: 4 rx / (3 pi) from its flat edge, towards the curved side.
function centroid(shape) {
  const offset = (4 * shape.rx) / (3 * Math.PI) * (shape.face === "right" ? 1 : -1);
  return rotate([shape.cx + offset, shape.cy], [shape.cx, shape.cy], shape.rot);
}

test("each view has exactly the muscles it should, each once, all in the muscle vocabulary, and no neck", () => {
  assert.deepEqual([...VIEWS], ["front", "back"]);
  for (const view of VIEWS) {
    const ids = BODY_REGIONS[view].regions.map((region) => region.muscle);
    assert.deepEqual([...ids].sort(), EXPECTED[view], view);
    assert.equal(new Set(ids).size, ids.length, `${view}: a muscle is listed twice`);
    assert.ok(ids.every((id) => ALL_MUSCLES.includes(id)), view);
    assert.ok(!ids.includes("neck"), view);
  }
});

test("every region is two shapes, the left one mirrored on the right of the centre line", () => {
  for (const view of VIEWS) {
    for (const { muscle, shapes } of BODY_REGIONS[view].regions) {
      const where = `${view} ${muscle}`;
      assert.equal(shapes.length, 2, where);
      const [left, right] = shapes;
      assert.ok(left.cx < CENTER_X && right.cx > CENTER_X, `${where}: not on opposite sides`);
      assert.equal(CENTER_X - left.cx, right.cx - CENTER_X, where);
      for (const key of ["type", "cy", "rx", "ry"]) assert.equal(left[key], right[key], `${where}: ${key}`);
      assert.equal(left.rot, right.rot === 0 ? 0 : -right.rot, `${where}: rotation`);
      assert.deepEqual(left.hit, right.hit, where);
      if (left.type === "half") assert.notEqual(left.face, right.face, `${where}: faces`);
      for (const shape of shapes) {
        for (const key of ["cx", "cy", "rx", "ry", "rot"]) assert.ok(Number.isFinite(shape[key]), `${where}: ${key}`);
        assert.ok(shape.rx > 0 && shape.ry > 0, where);
      }
    }
  }
});

test("front view: each shoulder is split in two halves of one circle, the inner half the front delt, the outer the side delt", () => {
  const shapesOf = (muscle) => BODY_REGIONS.front.regions.find((region) => region.muscle === muscle).shapes;
  for (const [index, side] of ["left", "right"].entries()) {
    const front = shapesOf("front_delts")[index];
    const outer = shapesOf("side_delts")[index];
    assert.equal(front.type, "half");
    assert.equal(outer.type, "half");
    for (const key of ["cx", "cy", "rx", "ry", "rot"]) assert.equal(front[key], outer[key], `${side} shoulder: ${key}`);
    // on the left of the body the inner half is the one facing right (towards the centre line)
    assert.equal(front.face, side === "left" ? "right" : "left", `${side} shoulder: front delt is the inner half`);
    assert.equal(outer.face, side === "left" ? "left" : "right", `${side} shoulder: side delt is the outer half`);
  }
  assert.ok(!BODY_REGIONS.back.regions.some((region) => region.muscle === "side_delts"), "no side delts on the back");
});

test("every hit shape is at least as large as the shape it covers, with the same centre, rotation and face", () => {
  for (const view of VIEWS) {
    for (const { muscle, shapes } of BODY_REGIONS[view].regions) {
      for (const shape of shapes) {
        assert.ok(shape.hit.rx >= shape.rx && shape.hit.ry >= shape.ry, `${view} ${muscle}`);
        const hit = hitOf(shape);
        assert.deepEqual([hit.cx, hit.cy, hit.rot, hit.face, hit.type], [shape.cx, shape.cy, shape.rot, shape.face, shape.type]);
      }
    }
  }
});

test("a shoulder half's hit area does not reach the centre of the other half, so a tap on either half is unambiguous", () => {
  const shapesOf = (muscle) => BODY_REGIONS.front.regions.find((region) => region.muscle === muscle).shapes;
  for (const index of [0, 1]) {
    const front = shapesOf("front_delts")[index];
    const outer = shapesOf("side_delts")[index];
    assert.ok(contains(hitOf(front), centroid(front)), "a hit area contains its own half's centre");
    assert.ok(contains(hitOf(outer), centroid(outer)), "a hit area contains its own half's centre");
    assert.ok(!contains(hitOf(front), centroid(outer)), "front delt hit reaches the side delt");
    assert.ok(!contains(hitOf(outer), centroid(front)), "side delt hit reaches the front delt");
  }
});
