// computeMuscleLoad with detail: true (the per-exercise breakdown and the time of the latest set). Plain objects in,
// expected values worked out by hand. The default call must stay exactly as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMuscleLoad } from "../src/domain/muscle-load.js";
import { ALL_MUSCLES } from "../src/domain/model.js";

const START = "2026-10-20T00:00:00.000Z";
const END = "2026-10-27T00:00:00.000Z";
const WINDOW = { start: Date.parse(START), end: Date.parse(END) };
const IN = "2026-10-22T10:00:00.000Z";

const exercise = (id, primaryMuscles, secondaryMuscles = []) => ({ id, primaryMuscles, secondaryMuscles });
const BENCH = exercise("bench", ["chest"], ["front_delts", "triceps"]);
const CURL = exercise("curl", ["biceps"]);
const LOG_LIFT = exercise("log-lift", ["front_delts", "side_delts"]);
const set = (completedAt = IN, extra = {}) => ({ completedAt, isWarmup: false, ...extra });
const workout = (...entries) => ({ startedAt: IN, entries });
const entry = (exerciseId, ...sets) => ({ exerciseId, sets });
const load = (workouts, exercises, extra = {}) => computeMuscleLoad({ workouts, exercises, window: WINDOW, detail: true, ...extra });

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test("without detail the result has only muscles and skipped; with it the same two plus breakdown and lastAt for all 20 muscles", () => {
  const workouts = [workout(entry("bench", set(), set(), set()))];
  const plain = computeMuscleLoad({ workouts, exercises: [BENCH], window: WINDOW });
  assert.deepEqual(Object.keys(plain), ["muscles", "skipped"]);
  const detailed = load(workouts, [BENCH]);
  assert.deepEqual(Object.keys(detailed), ["muscles", "skipped", "breakdown", "lastAt"]);
  assert.deepEqual(detailed.muscles, plain.muscles);
  assert.deepEqual(detailed.skipped, plain.skipped);
  assert.deepEqual(Object.keys(detailed.breakdown), [...ALL_MUSCLES]);
  assert.deepEqual(Object.keys(detailed.lastAt), [...ALL_MUSCLES]);
});

test("bench x 3: chest has one primary entry of 3 sets and 3.0, the front delts one secondary entry of 3 sets and 1.5, others none", () => {
  const r = load([workout(entry("bench", set(), set(), set()))], [BENCH]);
  assert.deepEqual(r.breakdown.chest, [{ exerciseId: "bench", role: "primary", sets: 3, weighted: 3 }]);
  assert.deepEqual(r.breakdown.front_delts, [{ exerciseId: "bench", role: "secondary", sets: 3, weighted: 1.5 }]);
  assert.deepEqual(r.breakdown.triceps, [{ exerciseId: "bench", role: "secondary", sets: 3, weighted: 1.5 }]);
  assert.deepEqual(r.breakdown.biceps, []);
});

test("two exercises on one muscle each get their own entry: bench x 3 (1.5) and log lift x 2 (2.0) on the front delts make 3.5", () => {
  const r = load([workout(entry("bench", set(), set(), set()), entry("log-lift", set(), set()))], [BENCH, LOG_LIFT]);
  assert.deepEqual(r.breakdown.front_delts, [
    { exerciseId: "bench", role: "secondary", sets: 3, weighted: 1.5 },
    { exerciseId: "log-lift", role: "primary", sets: 2, weighted: 2 },
  ]);
  assert.equal(r.muscles.front_delts.weighted, 3.5);
});

test("the same exercise in two workouts is one entry: curl x 1 and curl x 2 are 3 sets and 3.0", () => {
  const r = load([workout(entry("curl", set())), workout(entry("curl", set(), set()))], [CURL]);
  assert.deepEqual(r.breakdown.biceps, [{ exerciseId: "curl", role: "primary", sets: 3, weighted: 3 }]);
});

test("warm-ups, sets before the start, a set exactly at the end, and a bad date are not in the breakdown", () => {
  const r = load([workout(entry("curl", set(IN, { isWarmup: true }), set("2026-10-19T23:59:59.999Z"), set(END), set("not a date"), set()))], [CURL]);
  assert.deepEqual(r.breakdown.biceps, [{ exerciseId: "curl", role: "primary", sets: 1, weighted: 1 }]);
  assert.equal(r.lastAt.biceps, Date.parse(IN));
});

test("a muscle listed as primary and secondary has one primary entry and no secondary one", () => {
  const odd = exercise("odd", ["chest"], ["chest", "triceps"]);
  const r = load([workout(entry("odd", set(), set()))], [odd]);
  assert.deepEqual(r.breakdown.chest, [{ exerciseId: "odd", role: "primary", sets: 2, weighted: 2 }]);
  assert.deepEqual(r.breakdown.triceps, [{ exerciseId: "odd", role: "secondary", sets: 2, weighted: 1 }]);
});

test("lastAt is the latest counted set over all entries, a later warm-up and a set at the end do not move it", () => {
  const early = "2026-10-21T08:00:00.000Z";
  const late = "2026-10-23T09:30:00.000Z";
  const r = load([workout(entry("curl", set(late), set(early))), workout(entry("curl", set("2026-10-25T00:00:00.000Z", { isWarmup: true }), set(END)))], [CURL]);
  assert.equal(r.lastAt.biceps, Date.parse(late));
  assert.equal(r.lastAt.chest, null);
});

test("a secondary credit counts for lastAt, unless the secondary credit is 0", () => {
  const workouts = [workout(entry("bench", set(IN)))];
  assert.equal(load(workouts, [BENCH]).lastAt.front_delts, Date.parse(IN));
  const free = load(workouts, [BENCH], { credit: { primary: 1, secondary: 0 } });
  assert.equal(free.lastAt.front_delts, null, "no credit, so the muscle was not trained");
  assert.equal(free.lastAt.chest, Date.parse(IN));
  assert.deepEqual(free.breakdown.front_delts, [{ exerciseId: "bench", role: "secondary", sets: 1, weighted: 0 }]);
});

test("the weighted of a muscle's entries adds up to the muscle's weighted, for all 20 muscles", () => {
  const exercises = [BENCH, CURL, LOG_LIFT, exercise("shrug", ["traps"], ["neck"]), exercise("odd", ["lats"], ["lats", "neck"])];
  const r = load([workout(entry("bench", set(), set()), entry("curl", set()), entry("log-lift", set(), set(), set())), workout(entry("shrug", set()), entry("odd", set(), set()), entry("bench", set()))], exercises);
  for (const id of ALL_MUSCLES) {
    const sum = r.breakdown[id].reduce((total, row) => total + row.weighted, 0);
    assert.equal(sum, r.muscles[id].weighted, id);
    const sets = r.breakdown[id].reduce((total, row) => total + row.sets, 0);
    assert.equal(sets, r.muscles[id].primarySets + r.muscles[id].secondarySets, id);
  }
});

test("detail does not change the inputs (frozen workouts, exercises and credit)", () => {
  const workouts = deepFreeze([workout(entry("bench", set(), set()))]);
  const exercises = deepFreeze([BENCH]);
  const credit = deepFreeze({ primary: 1, secondary: 0.5 });
  assert.doesNotThrow(() => computeMuscleLoad({ workouts, exercises, window: WINDOW, credit, detail: true }));
});
