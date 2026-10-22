import test from "node:test";
import assert from "node:assert/strict";
import { searchExercises } from "../src/domain/search.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const ids = (list) => list.map((exercise) => exercise.id);

test("searchExercises: an empty or blank query returns everything, alphabetically", () => {
  for (const query of [undefined, "", "   "]) {
    const result = searchExercises(SEED_EXERCISES, query);
    assert.equal(result.length, SEED_EXERCISES.length);
    assert.deepEqual(result.map((e) => e.name), [...result.map((e) => e.name)].sort((a, b) => a.localeCompare(b)));
  }
});

test("searchExercises: matches the name, ignoring case", () => {
  assert.equal(searchExercises(SEED_EXERCISES, "BENCH")[0].id, "seed-barbell-bench-press");
  assert.deepEqual(ids(searchExercises(SEED_EXERCISES, "pull-up")), ["seed-pull-up"]);
});

test("searchExercises: every word must match, in any order", () => {
  assert.deepEqual(ids(searchExercises(SEED_EXERCISES, "press incline")), ["seed-incline-dumbbell-press"]);
  assert.deepEqual(searchExercises(SEED_EXERCISES, "bench zebra"), []);
});

test("searchExercises: also matches muscles and equipment, with name matches first", () => {
  const calves = ids(searchExercises(SEED_EXERCISES, "calves"));
  assert.ok(calves.includes("seed-standing-calf-raise")); // primary muscle
  assert.ok(calves.includes("seed-seated-leg-curl")); // secondary muscle
  const front = ids(searchExercises(SEED_EXERCISES, "front delts"));
  assert.ok(front.includes("seed-overhead-press"));
  const cable = ids(searchExercises(SEED_EXERCISES, "cable"));
  assert.ok(cable.includes("seed-lat-pulldown") && cable.includes("seed-triceps-pushdown"));
  // "bar" is in many names and in the "barbell" and "pull up bar" tags of others:
  // exercises with it in the name come first, the rest after
  const bar = searchExercises(SEED_EXERCISES, "bar");
  const inName = bar.map((e) => e.name.toLowerCase().includes("bar"));
  assert.ok(inName.includes(true) && inName.includes(false));
  assert.equal(inName.indexOf(false), inName.lastIndexOf(true) + 1);
  assert.ok(bar.some((e) => e.id === "seed-pull-up" && !e.name.toLowerCase().includes("bar")));
});

test("searchExercises: does not change its input", () => {
  const list = [...SEED_EXERCISES].reverse();
  const copy = [...list];
  searchExercises(list, "bench");
  assert.deepEqual(list, copy);
});
