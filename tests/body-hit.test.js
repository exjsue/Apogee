// Which muscle a tap belongs to (src/ui/body-hit.js): every pair of overlapping hit areas, both sides of the body,
// with points worked out from the region data. The rule: the smaller hit shape wins; areas within 2 % are a tie and the
// nearer centre wins. Not a test of how it looks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_REGIONS, VIEWS } from "../src/ui/body-regions.js";
import { resolveTap, shapeContains, TIE_TOLERANCE } from "../src/ui/body-hit.js";

const tap = (view, x, y) => resolveTap(BODY_REGIONS[view].regions, [x, y]);
const mirrorX = (x) => 200 - x;

// Every overlap of two different muscles' hit areas. "smaller": the winner is the smaller hit shape, named here.
// "nearest": the two hit areas are within TIE_TOLERANCE of each other in size, so the nearer centre wins.
// Hit areas (rx * ry): chest 340, front_delts 176, side_delts 176, biceps 253, forearms 286, abs 297, obliques 275,
// quads 800, adductors 297, abductors 209 (front) and 154 (back), calves 387.5 (front) and 403 (back), traps 229.5,
// rear_delts 256, upper_back 192, lats 465, triceps 253, lower_back 198, glutes 350, hamstrings 585.
const OVERLAPS = {
  front: {
    "biceps|forearms": { rule: "smaller", winner: "biceps" },
    "biceps|side_delts": { rule: "smaller", winner: "side_delts" },
    "front_delts|side_delts": { rule: "nearest" },
    "abductors|quads": { rule: "smaller", winner: "abductors" },
    "chest|front_delts": { rule: "smaller", winner: "front_delts" },
    "adductors|quads": { rule: "smaller", winner: "adductors" },
    "abs|obliques": { rule: "smaller", winner: "obliques" },
    "abs|chest": { rule: "smaller", winner: "abs" },
  },
  back: {
    "forearms|triceps": { rule: "smaller", winner: "triceps" },
    "rear_delts|triceps": { rule: "nearest" },
    "rear_delts|traps": { rule: "smaller", winner: "traps" },
    "abductors|glutes": { rule: "smaller", winner: "abductors" },
    "glutes|hamstrings": { rule: "smaller", winner: "glutes" },
    "calves|hamstrings": { rule: "smaller", winner: "calves" },
    "lats|upper_back": { rule: "smaller", winner: "upper_back" },
    "lats|lower_back": { rule: "smaller", winner: "lower_back" },
  },
};

// A point inside both hit areas of each pair (left side of the body, found by hand from the shapes), and who must get it.
const POINTS = [
  ["front", "biceps|forearms", 48.7, 131.3, "biceps"],
  ["front", "biceps|side_delts", 53.8, 93.6, "side_delts"],
  ["front", "front_delts|side_delts", 62, 80, "front_delts"], // 4.5 from the front delt's centre, 8.5 from the side delt's
  ["front", "front_delts|side_delts", 57, 80, "side_delts"], // 9.5 from the front delt's centre, 3.5 from the side delt's
  ["front", "abductors|quads", 70.2, 211.9, "abductors"],
  ["front", "chest|front_delts", 71, 89.9, "front_delts"],
  ["front", "adductors|quads", 87.7, 237, "adductors"],
  ["front", "abs|obliques", 87.4, 144.4, "obliques"],
  ["front", "abs|chest", 92.5, 113.3, "abs"],
  ["back", "forearms|triceps", 48.7, 131.3, "triceps"],
  ["back", "rear_delts|triceps", 55, 94, "rear_delts"], // the centre of the rear delt is 12.6 away, the triceps' 19.2
  ["back", "rear_delts|triceps", 55.25, 97.5, "triceps"], // 15.95 from the rear delt's centre, 15.84 from the triceps': a tie in size, so nearer wins
  ["back", "rear_delts|traps", 71.3, 80.5, "traps"],
  ["back", "abductors|glutes", 73.4, 207.9, "abductors"],
  ["back", "glutes|hamstrings", 80.8, 231.8, "glutes"],
  ["back", "calves|hamstrings", 79.4, 305.5, "calves"],
  ["back", "lats|upper_back", 84.9, 115.9, "upper_back"],
  ["back", "lats|lower_back", 88.9, 163.8, "lower_back"],
];

test("every overlapping pair of hit areas gives its taps to the intended muscle, on the left and the mirrored right side", () => {
  for (const [view, pair, x, y, winner] of POINTS) {
    const [a, b] = pair.split("|");
    const hits = BODY_REGIONS[view].regions.filter(({ muscle }) => muscle === a || muscle === b).map(({ shapes }) => shapes[0]);
    assert.ok(hits.every((shape) => shapeContains({ ...shape, ...shape.hit }, [x, y])), `${view} ${pair}: the point is in both hit areas`);
    assert.equal(tap(view, x, y), winner, `${view} ${pair} at ${x},${y} (left)`);
    assert.equal(tap(view, mirrorX(x), y), winner, `${view} ${pair} at ${mirrorX(x)},${y} (right)`);
  }
});

test("the two shoulder ovals are a tie in size, so the nearer centre wins, and an exact tie goes to the same muscle every time", () => {
  const [front, side] = ["front_delts", "side_delts"].map((id) => BODY_REGIONS.front.regions.find(({ muscle }) => muscle === id).shapes[0]);
  assert.deepEqual(front.hit, side.hit, "same hit size");
  assert.equal(tap("front", 66.5, 80), "front_delts", "the front delt's own centre");
  assert.equal(tap("front", 53.5, 80), "side_delts", "the side delt's own centre");
  assert.equal(tap("front", 60, 80), "front_delts", "exactly halfway: the id that sorts first");
  assert.equal(tap("front", mirrorX(60), 80), "front_delts");
  assert.equal(tap("front", 60, 80), tap("front", 60, 80));
});

test("every overlap of two different muscles' hit areas is in the table, and each point in one goes by its rule", () => {
  const GRID = 0.5;
  for (const view of VIEWS) {
    const hits = BODY_REGIONS[view].regions.flatMap(({ muscle, shapes }) => shapes.map((shape) => ({ muscle, hit: { ...shape, ...shape.hit } })));
    const seen = new Set();
    for (let x = 0; x <= 200; x += GRID) {
      for (let y = 0; y <= 400; y += GRID) {
        const inside = hits.filter(({ hit }) => shapeContains(hit, [x, y]));
        const muscles = [...new Set(inside.map(({ muscle }) => muscle))].sort();
        if (muscles.length < 2) continue;
        assert.equal(muscles.length, 2, `${view} ${x},${y}: three muscles overlap, which the table does not cover`);
        const key = muscles.join("|");
        seen.add(key);
        const entry = OVERLAPS[view][key];
        assert.ok(entry, `${view}: the overlap ${key} is not in the table`);
        const got = tap(view, x, y);
        if (entry.rule === "smaller") {
          assert.equal(got, entry.winner, `${view} ${key} at ${x},${y}`);
        } else {
          const nearest = muscles.map((muscle) => ({ muscle, d: Math.min(...inside.filter((h) => h.muscle === muscle).map(({ hit }) => Math.hypot(x - hit.cx, y - hit.cy))) }));
          nearest.sort((p, q) => p.d - q.d || (p.muscle < q.muscle ? -1 : 1));
          assert.equal(got, nearest[0].muscle, `${view} ${key} at ${x},${y}`);
        }
      }
    }
    assert.deepEqual([...seen].sort(), Object.keys(OVERLAPS[view]).sort(), `${view}: the table lists an overlap that does not exist`);
  }
});

test("the size tie is within 2 % and only the two shoulder ovals and the rear delt and triceps fall in it", () => {
  assert.equal(TIE_TOLERANCE, 0.02);
  const area = (view, muscle) => {
    const { hit } = BODY_REGIONS[view].regions.find((region) => region.muscle === muscle).shapes[0];
    return hit.rx * hit.ry;
  };
  for (const [view, table] of Object.entries(OVERLAPS)) {
    for (const [key, { rule }] of Object.entries(table)) {
      const [a, b] = key.split("|").map((muscle) => area(view, muscle));
      assert.equal(Math.max(a, b) <= Math.min(a, b) * (1 + TIE_TOLERANCE), rule === "nearest", `${view} ${key}: areas ${a} and ${b}`);
    }
  }
});

test("a tap in no hit area, outside the diagram, or on the head or pelvis gives nothing; a tap inside one muscle gives it", () => {
  for (const view of VIEWS) {
    assert.equal(tap(view, 1, 1), null);
    assert.equal(tap(view, -50, 500), null);
    assert.equal(tap(view, 100, 48), null, `${view}: the head is not a muscle`);
  }
  assert.equal(tap("front", 100, 184), null, "the pelvis is not a muscle");
  assert.equal(tap("front", 78, 252), "quads");
  assert.equal(tap("front", 122, 252), "quads");
  assert.equal(tap("back", 78, 335), "calves");
});

test("the resolver does not depend on the order of the regions or change its input", () => {
  const regions = BODY_REGIONS.front.regions;
  const reversed = [...regions].reverse();
  const before = JSON.stringify(regions);
  for (const [x, y] of [[60, 80], [62, 80], [87.4, 144.4], [70.2, 211.9], [92.5, 113.3], [48.7, 131.3]]) {
    assert.equal(resolveTap(reversed, [x, y]), resolveTap(regions, [x, y]), `${x},${y}`);
  }
  assert.equal(JSON.stringify(regions), before);
});
