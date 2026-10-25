// Muscle load: sets per muscle in a window. Plain objects in, expected values worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMuscleLoad, DEFAULT_CREDIT } from "../src/domain/muscle-load.js";
import { ALL_MUSCLES } from "../src/domain/model.js";

const START = "2026-10-20T00:00:00.000Z";
const END = "2026-10-27T00:00:00.000Z";
const WINDOW = { start: Date.parse(START), end: Date.parse(END) };
const IN = "2026-10-22T10:00:00.000Z";

const exercise = (id, primaryMuscles, secondaryMuscles = [], extra = {}) => ({ id, primaryMuscles, secondaryMuscles, ...extra });
const BENCH = exercise("bench", ["chest"], ["front_delts", "triceps"]);
const CURL = exercise("curl", ["biceps"]);
const LOG_LIFT = exercise("log-lift", ["front_delts", "side_delts"]);
const set = (completedAt = IN, extra = {}) => ({ completedAt, isWarmup: false, ...extra });
const workout = (...entries) => ({ startedAt: IN, entries });
const entry = (exerciseId, ...sets) => ({ exerciseId, sets });
const load = (workouts, exercises, extra = {}) => computeMuscleLoad({ workouts, exercises, window: WINDOW, ...extra });
const row = (result, muscle) => result.muscles[muscle];

test("a primary-only exercise: 1.0 per set to its primary muscle, nothing elsewhere", () => {
  const r = load([workout(entry("curl", set()))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.equal(Object.values(r.muscles).filter((m) => m.weighted !== 0).length, 1);
});

test("secondary muscles get 0.5 per set and count as secondary sets", () => {
  const r = load([workout(entry("bench", set()))], [BENCH]);
  assert.deepEqual(row(r, "chest"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.deepEqual(row(r, "front_delts"), { weighted: 0.5, primarySets: 0, secondarySets: 1 });
  assert.deepEqual(row(r, "triceps"), { weighted: 0.5, primarySets: 0, secondarySets: 1 });
});

test("a two-primary exercise credits both fully; primarySets counts sets, so each muscle gets 1 per set, not 2", () => {
  const r = load([workout(entry("log-lift", set(), set()))], [LOG_LIFT]);
  assert.deepEqual(row(r, "front_delts"), { weighted: 2, primarySets: 2, secondarySets: 0 });
  assert.deepEqual(row(r, "side_delts"), { weighted: 2, primarySets: 2, secondarySets: 0 });
});

test("several sets accumulate, and two exercises hitting the same muscle add", () => {
  // bench: 3 sets -> chest 3, front_delts 1.5. log-lift: 2 sets -> front_delts +2 = 3.5 (2 primary sets, 3 secondary sets).
  const r = load([workout(entry("bench", set(), set(), set()), entry("log-lift", set(), set()))], [BENCH, LOG_LIFT]);
  assert.deepEqual(row(r, "chest"), { weighted: 3, primarySets: 3, secondarySets: 0 });
  assert.deepEqual(row(r, "front_delts"), { weighted: 3.5, primarySets: 2, secondarySets: 3 });
});

test("sets add across workouts in the window", () => {
  const r = load([workout(entry("curl", set())), workout(entry("curl", set(), set()))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 3, primarySets: 3, secondarySets: 0 });
});

test("warm-up sets are excluded", () => {
  const r = load([workout(entry("curl", set(IN, { isWarmup: true }), set()))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.equal(r.skipped.badTimestamps, 0);
});

test("a set with no completedAt, or one that is not a date, is skipped and counted in badTimestamps", () => {
  const r = load([workout(entry("curl", set(null), set("not a date"), set(undefined, { completedAt: undefined }), set()))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.equal(r.skipped.badTimestamps, 3);
});

test("the window is [start, end): a set exactly at start counts, a set exactly at end does not", () => {
  const r = load([workout(entry("curl", set(START), set(END), set("2026-10-26T23:59:59.999Z"), set("2026-10-19T23:59:59.999Z")))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 2, primarySets: 2, secondarySets: 0 });
});

test("sets are placed by completedAt, not by when the workout started (a workout across the window start)", () => {
  const spanning = { startedAt: "2026-10-19T23:00:00.000Z", entries: [entry("curl", set("2026-10-19T23:30:00.000Z"), set("2026-10-20T00:30:00.000Z"))] };
  assert.deepEqual(row(load([spanning], [CURL]), "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
});

test("every one of the 20 muscle ids is in the output, with zeros when unused", () => {
  const r = load([], []);
  assert.equal(ALL_MUSCLES.length, 20);
  assert.deepEqual(Object.keys(r.muscles), [...ALL_MUSCLES]);
  for (const id of ALL_MUSCLES) assert.deepEqual(r.muscles[id], { weighted: 0, primarySets: 0, secondarySets: 0 });
  assert.deepEqual(r.skipped, { unknownExercises: { count: 0, ids: [] }, unknownMuscles: { count: 0, items: [] }, badTimestamps: 0 });
});

test("neck and abductors, which the custom form cannot offer, are credited like any other id", () => {
  const r = load([workout(entry("shrug", set()))], [exercise("shrug", ["neck"], ["abductors"])]);
  assert.deepEqual(row(r, "neck"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.deepEqual(row(r, "abductors"), { weighted: 0.5, primarySets: 0, secondarySets: 1 });
});

test("an entry whose exercise is not stored is skipped and reported once by id, never thrown", () => {
  const r = load([workout(entry("gone", set(), set()), entry("curl", set())), workout(entry("gone", set()))], [CURL]);
  assert.deepEqual(row(r, "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.deepEqual(r.skipped.unknownExercises, { count: 1, ids: ["gone"] });
});

test("an unknown exercise whose sets are all outside the window is not reported", () => {
  const r = load([workout(entry("gone", set("2026-01-01T00:00:00.000Z")))], [CURL]);
  assert.deepEqual(r.skipped.unknownExercises, { count: 0, ids: [] });
});

test("a muscle id outside the vocabulary does not crash, earns no credit, and is reported once per exercise and muscle", () => {
  const odd = exercise("odd", ["chest", "pecs"], ["latissimus"]);
  const r = load([workout(entry("odd", set(), set()))], [odd]);
  assert.deepEqual(row(r, "chest"), { weighted: 2, primarySets: 2, secondarySets: 0 });
  assert.equal(Object.keys(r.muscles).length, 20);
  assert.deepEqual(r.skipped.unknownMuscles, {
    count: 2,
    items: [{ exerciseId: "odd", muscle: "pecs" }, { exerciseId: "odd", muscle: "latissimus" }],
  });
});

test("a muscle listed as both primary and secondary is credited as primary only, once", () => {
  const both = exercise("both", ["chest"], ["chest", "triceps"]);
  const r = load([workout(entry("both", set()))], [both]);
  assert.deepEqual(row(r, "chest"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.deepEqual(row(r, "triceps"), { weighted: 0.5, primarySets: 0, secondarySets: 1 });
});

test("a retired exercise still resolves and counts", () => {
  const r = load([workout(entry("old-curl", set()))], [exercise("old-curl", ["biceps"], [], { retired: true })]);
  assert.deepEqual(row(r, "biceps"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.equal(r.skipped.unknownExercises.count, 0);
});

test("exercises are matched by id, never by name: a twin with the same name but another id is not used", () => {
  const twin = exercise("seed-bench", ["triceps"], [], { name: "Bench" });
  const real = exercise("Bench_Press", ["chest"], [], { name: "Bench" });
  const r = load([workout(entry("Bench_Press", set()))], [twin, real]);
  assert.deepEqual(row(r, "chest"), { weighted: 1, primarySets: 1, secondarySets: 0 });
  assert.equal(row(r, "triceps").weighted, 0);
});

test("a Map of exercises by id works the same as an array", () => {
  const workouts = [workout(entry("bench", set()))];
  assert.deepEqual(load(workouts, new Map([["bench", BENCH]])), load(workouts, [BENCH]));
});

test("changing the credit changes only the weighted totals, not primarySets or secondarySets", () => {
  const workouts = [workout(entry("bench", set(), set()))];
  const base = load(workouts, [BENCH]);
  const changed = load(workouts, [BENCH], { credit: { primary: 2, secondary: 0.25 } });
  assert.deepEqual(row(changed, "chest"), { weighted: 4, primarySets: 2, secondarySets: 0 });
  assert.deepEqual(row(changed, "triceps"), { weighted: 0.5, primarySets: 0, secondarySets: 2 });
  for (const id of ALL_MUSCLES) {
    assert.equal(changed.muscles[id].primarySets, base.muscles[id].primarySets);
    assert.equal(changed.muscles[id].secondarySets, base.muscles[id].secondarySets);
  }
});

test("the default credit is 1.0 and 0.5, and is frozen", () => {
  assert.deepEqual({ ...DEFAULT_CREDIT }, { primary: 1, secondary: 0.5 });
  assert.ok(Object.isFrozen(DEFAULT_CREDIT));
});

test("the function does not change its inputs", () => {
  const deepFreeze = (value) => {
    if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  };
  const workouts = deepFreeze([workout(entry("bench", set(), set(IN, { isWarmup: true })), entry("gone", set()))]);
  const exercises = deepFreeze([BENCH, exercise("odd", ["pecs", "chest"])]);
  const before = JSON.stringify({ workouts, exercises });
  const credit = deepFreeze({ primary: 1, secondary: 0.5 });
  const range = deepFreeze({ ...WINDOW });
  computeMuscleLoad({ workouts, exercises, window: range, credit }); // would throw in strict mode if it wrote to a frozen input
  assert.equal(JSON.stringify({ workouts, exercises }), before);
});

test("a bad credit or window throws; bad data does not", () => {
  const call = (extra) => () => computeMuscleLoad({ workouts: [], exercises: [], window: WINDOW, ...extra });
  assert.throws(call({ credit: { primary: -1, secondary: 0.5 } }), TypeError);
  assert.throws(call({ credit: { primary: 1, secondary: NaN } }), TypeError);
  assert.throws(call({ credit: { primary: Infinity, secondary: 0 } }), TypeError);
  assert.throws(call({ credit: { primary: 1 } }), TypeError);
  assert.throws(call({ window: { start: 10, end: 5 } }), TypeError);
  assert.throws(call({ window: { start: "2026-10-20", end: 5 } }), TypeError);
  assert.throws(call({ window: { start: 0, end: NaN } }), TypeError);
  assert.doesNotThrow(call({ window: { start: 5, end: 5 } }));
  assert.doesNotThrow(() => computeMuscleLoad({ workouts: [{ entries: [{ exerciseId: "x", sets: [null, {}] }] }, {}], exercises: [], window: WINDOW }));
});
