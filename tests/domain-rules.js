// Domain rule tests (vocabularies, text limits, seed data), shared by Node and
// the browser page. No node:test import: ctx.assert supplies equal, deepEqual,
// ok and rejects.

import {
  MUSCLES,
  EQUIPMENT,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  createExercise,
  createWorkout,
  createWorkoutEntry,
} from "../src/domain/model.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";

export const domainRules = [];
const rule = (name, run) => domainRules.push({ name, run });

const base = { name: "Test lift", primaryMuscles: ["chest"] };

// Calls fn and returns the thrown message, or null.
function messageOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
}

rule("domain: MUSCLES is the fixed list of 18 ids", async ({ assert }) => {
  assert.deepEqual([...MUSCLES], [
    "chest", "front_delts", "side_delts", "rear_delts", "biceps", "triceps", "forearms", "traps", "lats",
    "upper_back", "lower_back", "abs", "obliques", "glutes", "quads", "hamstrings", "calves", "adductors",
  ]);
  assert.equal(new Set(MUSCLES).size, MUSCLES.length);
});

rule("domain: EQUIPMENT is the fixed list of 11 tags", async ({ assert }) => {
  assert.deepEqual([...EQUIPMENT], [
    "barbell", "dumbbell", "kettlebell", "ez_bar", "machine", "smith_machine", "cable", "resistance_band",
    "bodyweight", "bench", "pull_up_bar",
  ]);
});

rule("domain: every muscle and equipment tag is accepted", async ({ assert }) => {
  for (const muscle of MUSCLES) {
    assert.deepEqual(createExercise({ ...base, primaryMuscles: [muscle] }).primaryMuscles, [muscle]);
    const other = MUSCLES.find((candidate) => candidate !== muscle);
    assert.deepEqual(createExercise({ ...base, primaryMuscles: [other], secondaryMuscles: [muscle] }).secondaryMuscles, [muscle]);
  }
  assert.deepEqual(createExercise({ ...base, equipmentTags: [...EQUIPMENT] }).equipmentTags, [...EQUIPMENT]);
});

rule("domain: unknown muscles are rejected without repeating them", async ({ assert }) => {
  for (const bad of ["pecs", "Chest", "front delts", "", "__proto__", "constructor"]) {
    const message = messageOf(() => createExercise({ ...base, primaryMuscles: [bad] }));
    assert.ok(message !== null, `accepted ${JSON.stringify(bad)}`);
    assert.ok(/primaryMuscles\[0\]/.test(message));
    if (bad.length > 3) assert.ok(!message.includes(bad));
  }
  assert.ok(/secondaryMuscles\[1\]/.test(messageOf(() => createExercise({ ...base, secondaryMuscles: ["triceps", "pecs"] }))));
  assert.ok(/primaryMuscles/.test(messageOf(() => createExercise({ ...base, primaryMuscles: "chest" }))));
  assert.ok(/primaryMuscles\[0\]/.test(messageOf(() => createExercise({ ...base, primaryMuscles: [7] }))));
});

rule("domain: at least one primary muscle is required", async ({ assert }) => {
  assert.ok(/at least one muscle/.test(messageOf(() => createExercise({ name: "No muscles" }))));
  assert.ok(/at least one muscle/.test(messageOf(() => createExercise({ ...base, primaryMuscles: [] }))));
  // a secondary muscle alone is not enough
  assert.ok(/at least one muscle/.test(messageOf(() => createExercise({ name: "X", secondaryMuscles: ["biceps"] }))));
});

rule("domain: duplicate muscles and primary/secondary overlap are rejected", async ({ assert }) => {
  assert.ok(/duplicates/.test(messageOf(() => createExercise({ ...base, primaryMuscles: ["chest", "chest"] }))));
  assert.ok(/duplicates/.test(messageOf(() => createExercise({ ...base, secondaryMuscles: ["triceps", "triceps"] }))));
  assert.ok(/must not repeat a primary muscle/.test(messageOf(() => createExercise({ ...base, secondaryMuscles: ["chest"] }))));
  assert.ok(/duplicates/.test(messageOf(() => createExercise({ ...base, equipmentTags: ["barbell", "barbell"] }))));
});

rule("domain: unknown equipment tags are rejected without repeating them", async ({ assert }) => {
  const message = messageOf(() => createExercise({ ...base, equipmentTags: ["barbell", "sledgehammer"] }));
  assert.ok(/equipmentTags\[1\] must be a known equipment tag/.test(message));
  assert.ok(!message.includes("sledgehammer"));
});

rule("domain: exercise names are trimmed and whitespace is collapsed", async ({ assert }) => {
  assert.equal(createExercise({ ...base, name: "  Bench   press \t\n press " }).name, "Bench press press");
  assert.equal(createExercise({ ...base, name: " Row " }).name, "Row");
  assert.ok(/name must be a non-empty string/.test(messageOf(() => createExercise({ ...base, name: " \t\n " }))));
  assert.ok(/name must be a non-empty string/.test(messageOf(() => createExercise({ ...base, name: undefined }))));
});

rule("domain: exercise names are limited to 80 characters, counted after normalization", async ({ assert }) => {
  assert.equal(NAME_MAX_LENGTH, 80);
  assert.equal(createExercise({ ...base, name: "a".repeat(80) }).name.length, 80);
  assert.ok(/name must be at most 80 characters/.test(messageOf(() => createExercise({ ...base, name: "a".repeat(81) }))));
  // padding and repeated spaces do not count
  assert.equal(createExercise({ ...base, name: `  ${"a".repeat(80)}  ` }).name.length, 80);
  // characters, not UTF-16 units: an emoji is one character
  assert.equal([...createExercise({ ...base, name: "\u{1F3CB}".repeat(80) }).name].length, 80);
  assert.ok(/at most 80/.test(messageOf(() => createExercise({ ...base, name: "\u{1F3CB}".repeat(81) }))));
});

rule("domain: notes are normalized and limited to 500 characters on exercises, workouts and entries", async ({ assert }) => {
  assert.equal(NOTES_MAX_LENGTH, 500);
  assert.equal(createExercise({ ...base, notes: "  high \n\n bar  " }).notes, "high bar");
  assert.equal(createExercise({ ...base, notes: "   " }).notes, "");
  assert.equal(createWorkout({ notes: "  felt  good " }).notes, "felt good");
  assert.equal(createWorkoutEntry({ workoutId: "w", exerciseId: "e", order: 0, notes: " a\tb " }).notes, "a b");
  const long = "n".repeat(501);
  assert.equal(createExercise({ ...base, notes: "n".repeat(500) }).notes.length, 500);
  assert.ok(/notes must be at most 500 characters/.test(messageOf(() => createExercise({ ...base, notes: long }))));
  assert.ok(/notes must be at most 500 characters/.test(messageOf(() => createWorkout({ notes: long }))));
  assert.ok(/notes must be at most 500 characters/.test(
    messageOf(() => createWorkoutEntry({ workoutId: "w", exerciseId: "e", order: 0, notes: long })),
  ));
});

rule("seed: about 15 lifts with stable seed- ids, all valid and already canonical", async ({ assert }) => {
  assert.equal(SEED_VERSION, 1);
  assert.ok(SEED_EXERCISES.length >= 15 && SEED_EXERCISES.length <= 20);
  const ids = new Set();
  const names = new Set();
  for (const seed of SEED_EXERCISES) {
    assert.ok(/^seed-[a-z0-9]+(-[a-z0-9]+)*$/.test(seed.id), seed.id);
    assert.equal(seed.isCustom, false);
    assert.ok(seed.primaryMuscles.length >= 1);
    assert.deepEqual(createExercise(seed), seed); // valid, and storing it changes nothing
    ids.add(seed.id);
    names.add(seed.name.toLowerCase());
  }
  assert.equal(ids.size, SEED_EXERCISES.length);
  assert.equal(names.size, SEED_EXERCISES.length);
  assert.ok(ids.has("seed-barbell-bench-press"));
});
