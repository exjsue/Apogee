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

test("front view: each shoulder is two distinct ellipses, the inner one the front delt and the outer one the side delt, with a gap", () => {
  const shapesOf = (muscle) => BODY_REGIONS.front.regions.find((region) => region.muscle === muscle).shapes;
  for (const [index, side] of ["left", "right"].entries()) {
    const front = shapesOf("front_delts")[index];
    const outer = shapesOf("side_delts")[index];
    assert.equal(front.type, "ellipse", `${side} shoulder: front delt`);
    assert.equal(outer.type, "ellipse", `${side} shoulder: side delt`);
    // the front delt is nearer the centre line than the side delt, on the same side of it
    assert.ok(Math.abs(front.cx - CENTER_X) < Math.abs(outer.cx - CENTER_X), `${side} shoulder: front delt is the inner one`);
    assert.ok((front.cx - CENTER_X) * (outer.cx - CENTER_X) > 0, `${side} shoulder: both on the same side`);
    assert.ok(!overlapsOnGrid(front, outer), `${side} shoulder: the two ovals overlap`);
    assert.ok(gapBetween(front, outer) >= 1, `${side} shoulder: gap between the ovals`);
  }
  assert.ok(!BODY_REGIONS.back.regions.some((region) => region.muscle === "side_delts"), "no side delts on the back");
});

const extent = (shape) => {
  const r = Math.max(shape.rx, shape.ry);
  return { x0: shape.cx - r, x1: shape.cx + r, y0: shape.cy - r, y1: shape.cy + r };
};
const GRID = 0.25;
function overlapsOnGrid(a, b) {
  const [ea, eb] = [extent(a), extent(b)];
  for (let x = Math.max(ea.x0, eb.x0); x <= Math.min(ea.x1, eb.x1); x += GRID) {
    for (let y = Math.max(ea.y0, eb.y0); y <= Math.min(ea.y1, eb.y1); y += GRID) {
      if (contains(a, [x, y]) && contains(b, [x, y])) return true;
    }
  }
  return false;
}
// The edge of a shape as points, to measure the gap between two shapes that do not overlap.
function edge(shape) {
  const points = [];
  for (let i = 0; i < 360; i++) {
    const t = (i * Math.PI) / 180;
    points.push(rotate([shape.cx + shape.rx * Math.cos(t), shape.cy + shape.ry * Math.sin(t)], [shape.cx, shape.cy], shape.rot));
  }
  return points;
}
function gapBetween(a, b) {
  const [pa, pb] = [edge(a), edge(b)];
  let smallest = Infinity;
  for (const p of pa) for (const q of pb) smallest = Math.min(smallest, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return smallest;
}

test("no visible shapes of different muscles overlap", () => {
  for (const view of VIEWS) {
    const all = BODY_REGIONS[view].regions.flatMap(({ muscle, shapes }) => shapes.map((shape) => ({ muscle, shape })));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i].muscle === all[j].muscle) continue;
        const pair = [all[i].muscle, all[j].muscle].sort().join("|");
        assert.ok(!overlapsOnGrid(all[i].shape, all[j].shape), `${view}: ${pair} overlap`);
      }
    }
  }
});

test("back view: the traps stay at least 1.5 units from the rear delts, and at least 2 from the centre line", () => {
  const shapesOf = (muscle) => BODY_REGIONS.back.regions.find((region) => region.muscle === muscle).shapes;
  for (const index of [0, 1]) {
    assert.ok(gapBetween(shapesOf("traps")[index], shapesOf("rear_delts")[index]) >= 1.5, "traps vs rear delts");
    assert.ok(edge(shapesOf("traps")[index]).every(([x]) => Math.abs(x - CENTER_X) >= 2), "traps vs centre line");
  }
});

test("each view has exactly one head, the front has one pelvis and the back none, and neither is a region", () => {
  for (const view of VIEWS) {
    const { head, regions } = BODY_REGIONS[view];
    assert.equal(head.type, "ellipse", `${view}: head`);
    assert.equal(head.cx, CENTER_X, `${view}: head is centred`);
    assert.ok(!("hit" in head), `${view}: the head has no hit shape`);
    assert.ok(regions.every((region) => !["head", "pelvis"].includes(region.muscle)), `${view}: head or pelvis listed as a muscle`);
  }
  assert.equal(BODY_REGIONS.front.pelvis.type, "ellipse");
  assert.equal(BODY_REGIONS.front.pelvis.cx, CENTER_X);
  assert.ok(!("hit" in BODY_REGIONS.front.pelvis), "the pelvis has no hit shape");
  assert.equal(BODY_REGIONS.back.pelvis, undefined, "no pelvis on the back");
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

test("the hit area of each shoulder oval contains its own shape's centre (how far the two overlap is for step 5, not asserted)", () => {
  const shapesOf = (muscle) => BODY_REGIONS.front.regions.find((region) => region.muscle === muscle).shapes;
  for (const index of [0, 1]) {
    for (const muscle of ["front_delts", "side_delts"]) {
      const shape = shapesOf(muscle)[index];
      assert.ok(contains(hitOf(shape), [shape.cx, shape.cy]), `${muscle}: the hit area contains its own shape's centre`);
    }
  }
});
