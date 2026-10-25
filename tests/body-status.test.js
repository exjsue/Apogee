// What the Body diagram says about each muscle (src/domain/body-status.js), from the two loads it is given.
// The loads are made with computeMuscleLoad from small hand-made workouts; expected values are worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMuscleLoad } from "../src/domain/muscle-load.js";
import { computeBodyStatus, TARGET_RANGE, WINDOW_DAYS, NEGLECTED_WEEKS } from "../src/domain/body-status.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const exercise = (id, primaryMuscles, secondaryMuscles = []) => ({ id, primaryMuscles, secondaryMuscles });
const EXERCISES = [
  exercise("curl", ["biceps"]),
  exercise("row", ["lats"], ["biceps"]),
  exercise("calf", ["calves"]),
  exercise("neck-curl", ["neck"]),
  exercise("shrug", ["traps"]),
];
// A workout with one entry per [exerciseId, [days ago of each set]].
const workout = (...entries) => ({ entries: entries.map(([exerciseId, daysAgo]) => ({ exerciseId, sets: daysAgo.map((d) => ({ completedAt: ago(d), isWarmup: false })) })) });
const sets = (count, daysAgo) => Array.from({ length: count }, () => daysAgo);

// The two loads the logger makes: the last WINDOW_DAYS days and the last NEGLECTED_WEEKS weeks, ending 1 ms after now.
function status(workouts) {
  const load = (days) => computeMuscleLoad({ workouts, exercises: EXERCISES, window: { start: NOW - days * DAY, end: NOW + 1 } });
  return computeBodyStatus({ recent: load(WINDOW_DAYS), longer: load(NEGLECTED_WEEKS * 7) });
}

test("the value is the last 7 days' weighted sets, with the neck added to the traps and no neck key anywhere", () => {
  // 3 neck sets (neck 3) and 2 shrug sets (traps 2) are 5 for the traps; 4 rows: lats 4, biceps 2 (secondary, half)
  const s = status([workout(["neck-curl", sets(3, 1)], ["shrug", sets(2, 1)], ["row", sets(4, 2)])]);
  assert.equal(s.values.traps, 5);
  assert.equal(s.values.lats, 4);
  assert.equal(s.values.biceps, 2);
  assert.equal(s.values.chest, 0);
  assert.ok(!("neck" in s.values));
  assert.ok(!s.above.includes("neck") && !s.neglected.includes("neck"));
  assert.deepEqual(s.neglected.includes("traps"), false);
  assert.equal(s.hasHistory, true);
});

test("a muscle trained 10 days ago has value 0 in the 7-day window but is not neglected", () => {
  const s = status([workout(["calf", sets(5, 10)], ["curl", sets(1, 1)])]);
  assert.equal(s.values.calves, 0);
  assert.ok(!s.neglected.includes("calves"));
  assert.ok(s.neglected.includes("lats"), "a muscle never trained is neglected");
});

test("a muscle last trained 22 days ago is neglected, and one trained 20 days ago is not", () => {
  const s = status([workout(["calf", sets(3, 22)], ["curl", sets(2, 20)], ["row", sets(1, 1)])]);
  assert.ok(s.neglected.includes("calves"));
  assert.ok(!s.neglected.includes("biceps"));
  assert.ok(!s.neglected.includes("lats"));
});

test("a set exactly 7 days before now counts (the window start is inclusive), one a moment earlier does not", () => {
  const exactly = status([workout(["curl", [7]])]);
  assert.equal(exactly.values.biceps, 1);
  const earlier = status([{ entries: [{ exerciseId: "curl", sets: [{ completedAt: new Date(NOW - 7 * DAY - 1).toISOString(), isWarmup: false }] }] }]);
  assert.equal(earlier.values.biceps, 0);
  const atNow = status([{ entries: [{ exerciseId: "curl", sets: [{ completedAt: new Date(NOW).toISOString(), isWarmup: false }] }] }]);
  assert.equal(atNow.values.biceps, 1, "a set logged at this instant counts");
});

test("a value of exactly the top of the target range is not above it; half a set more is", () => {
  const top = TARGET_RANGE.max;
  const exactly = status([workout(["curl", sets(top, 1)])]);
  assert.equal(exactly.values.biceps, top);
  assert.ok(!exactly.above.includes("biceps"));
  // top curl sets (biceps top) and one row set (biceps +0.5 as a secondary muscle)
  const more = status([workout(["curl", sets(top, 1)], ["row", sets(1, 1)])]);
  assert.equal(more.values.biceps, top + 0.5);
  assert.deepEqual(more.above, ["biceps"]);
});

test("neck-only work in the last 3 weeks means the traps are not neglected, and neck work 10 days ago does not show in the 7-day value", () => {
  const s = status([workout(["neck-curl", sets(2, 10)], ["curl", sets(1, 1)])]);
  assert.ok(!s.neglected.includes("traps"));
  assert.equal(s.values.traps, 0);
});

test("no history: nothing is neglected and hasHistory is false; all 19 ids still have a value of 0", () => {
  const s = status([]);
  assert.equal(s.hasHistory, false);
  assert.deepEqual(s.neglected, []);
  assert.deepEqual(s.above, []);
  assert.equal(Object.keys(s.values).length, 19);
  assert.ok(Object.values(s.values).every((value) => value === 0));
});

test("history older than 3 weeks is no history", () => {
  const s = status([workout(["curl", sets(4, 30)])]);
  assert.equal(s.hasHistory, false);
  assert.deepEqual(s.neglected, []);
});

test("the two loads are not changed", () => {
  const deepFreeze = (value) => {
    if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  };
  const workouts = [workout(["neck-curl", sets(2, 1)], ["curl", sets(3, 8)])];
  const load = (days) => deepFreeze(computeMuscleLoad({ workouts, exercises: EXERCISES, window: { start: NOW - days * DAY, end: NOW + 1 } }));
  const recent = load(WINDOW_DAYS);
  const longer = load(NEGLECTED_WEEKS * 7);
  const before = JSON.stringify({ recent, longer });
  const result = computeBodyStatus({ recent, longer });
  assert.equal(JSON.stringify({ recent, longer }), before);
  assert.equal(result.values.traps, 2);
});
