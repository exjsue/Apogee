// Domain rule tests (vocabularies, text limits, seed data), shared by Node and
// the browser page. No node:test import: ctx.assert supplies equal, deepEqual,
// ok and rejects.

import {
  MUSCLES,
  EQUIPMENT,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  MAX_REPS,
  MAX_WEIGHT_KG,
  isAboveWeightLimit,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
  convertWeight,
} from "../src/domain/model.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { heaviestSet, ghostFor, sameGhost } from "../src/domain/workout-plan.js";

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

const aSet = { entryId: "e1", order: 0, reps: 5, weightValue: 100, weightUnit: "kg" };

rule("limits: MAX_REPS and MAX_WEIGHT_KG are named constants", async ({ assert }) => {
  assert.equal(MAX_REPS, 1000);
  assert.equal(MAX_WEIGHT_KG, 2500);
});

rule("limits: reps 1000 is accepted and 1001 is rejected, naming the maximum", async ({ assert }) => {
  assert.equal(createWorkSet({ ...aSet, reps: 1 }).reps, 1);
  assert.equal(createWorkSet({ ...aSet, reps: MAX_REPS }).reps, 1000);
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: MAX_REPS + 1 })), "reps is above the maximum of 1000");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: 920319039 })), "reps is above the maximum of 1000");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: Infinity })), "reps is above the maximum of 1000");
});

rule("limits: each bad reps value gets its own message", async ({ assert }) => {
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: 0 })), "reps must be at least 1");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: -3 })), "reps can't be negative");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: 2.5 })), "reps must be a whole number");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: "5" })), "reps must be a whole number");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: NaN })), "reps must be a whole number");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, reps: undefined })), "reps must be a whole number");
});

rule("limits: a weight exactly at the limit is accepted and just above it is rejected, in kg", async ({ assert }) => {
  assert.equal(createWorkSet({ ...aSet, weightValue: 0 }).weightValue, 0);
  assert.equal(createWorkSet({ ...aSet, weightValue: MAX_WEIGHT_KG }).weightValue, 2500);
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: 2500.0001 })), "weight is above the maximum of 2500 kg");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: 2501 })), "weight is above the maximum of 2500 kg");
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: Infinity })), "weight is above the maximum of 2500 kg");
});

rule("limits: a weight exactly at the limit is accepted and just above it is rejected, in lb", async ({ assert }) => {
  const limitLb = convertWeight(MAX_WEIGHT_KG, "kg", "lb"); // 5511.5565...
  const atLimit = createWorkSet({ ...aSet, weightValue: limitLb, weightUnit: "lb" });
  assert.equal(atLimit.weightValue, limitLb); // stored exactly as entered
  assert.equal(atLimit.weightUnit, "lb");
  const above = "weight is above the maximum of 5511.55 lb";
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: limitLb + 0.0001, weightUnit: "lb" })), above);
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: 5512, weightUnit: "lb" })), above);
  // what a person can type, to 4 decimals
  assert.equal(createWorkSet({ ...aSet, weightValue: 5511.5565, weightUnit: "lb" }).weightValue, 5511.5565);
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: 5511.5566, weightUnit: "lb" })), above);
  // the number named in the message is itself acceptable
  assert.equal(createWorkSet({ ...aSet, weightValue: 5511.55, weightUnit: "lb" }).weightValue, 5511.55);
});

rule("limits: a weight on the limit in lb is not rejected by rounding noise, for any limit", async ({ assert }) => {
  // These limits are ones where converting to lb and back lands just above the limit.
  for (const maxKg of [31, 59, 62, 118, 124]) {
    const limitLb = convertWeight(maxKg, "kg", "lb");
    assert.ok(limitLb * 0.45359237 > maxKg, `${maxKg} kg shows no rounding noise, so it proves nothing`);
    assert.equal(isAboveWeightLimit(limitLb, "lb", maxKg), false);
    assert.equal(isAboveWeightLimit(maxKg, "kg", maxKg), false);
    assert.equal(isAboveWeightLimit(limitLb + 0.001, "lb", maxKg), true);
    assert.equal(isAboveWeightLimit(maxKg + 0.001, "kg", maxKg), true);
  }
  // with the real limit
  assert.equal(isAboveWeightLimit(MAX_WEIGHT_KG, "kg"), false);
  assert.equal(isAboveWeightLimit(MAX_WEIGHT_KG + 0.0001, "kg"), true);
});

rule("limits: a negative weight says it can't be negative, not 'must be a number'", async ({ assert }) => {
  for (const unit of ["kg", "lb"]) {
    for (const value of [-3, -0.0001, -Infinity]) {
      const message = messageOf(() => createWorkSet({ ...aSet, weightValue: value, weightUnit: unit }));
      assert.equal(message, "weight can't be negative");
    }
  }
  assert.equal(messageOf(() => createWorkSet({ ...aSet, weightValue: "x" })), "weight must be a number");
});

rule("limits: the limit messages never repeat the entered value", async ({ assert }) => {
  const messages = [
    messageOf(() => createWorkSet({ ...aSet, reps: 920319039 })),
    messageOf(() => createWorkSet({ ...aSet, weightValue: 987654.321 })),
    messageOf(() => createWorkSet({ ...aSet, weightValue: -987654.321 })),
  ];
  for (const message of messages) assert.ok(!/987654|920319039/.test(message), message);
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

// ---- ghosts (src/domain/workout-plan.js) ----

// A stored set for heaviestSet, and Log-tab rows for ghostFor.
const setOf = (order, reps, weightValue, weightUnit = "kg", isWarmup = false) => ({ order, reps, weightValue, weightUnit, isWarmup });
const loggedRowOf = (reps, weight, unit = "kg") => ({ kind: "logged", reps, weight, unit });
const plannedRowOf = (reps = "", weight = "", unit = "lb") => ({ kind: "planned", reps, weight, unit });

rule("ghost: heaviestSet compares weight in kg, then more reps, then the earlier set; warm-ups never count", async ({ assert }) => {
  assert.deepEqual(heaviestSet([setOf(0, 5, 100), setOf(1, 3, 220.5, "lb")]), { reps: "3", weight: "220.5", unit: "lb" }); // 100.02 kg
  assert.deepEqual(heaviestSet([setOf(0, 5, 220, "lb"), setOf(1, 3, 100)]), { reps: "3", weight: "100", unit: "kg" }); // 99.79 kg loses
  assert.deepEqual(heaviestSet([setOf(0, 5, 100), setOf(1, 8, 100), setOf(2, 6, 100)]), { reps: "8", weight: "100", unit: "kg" });
  assert.deepEqual(heaviestSet([setOf(2, 5, 100), setOf(0, 5, 100), setOf(1, 4, 100)]).reps, "5");
  assert.deepEqual(heaviestSet([setOf(0, 10, 140, "kg", true), setOf(1, 5, 100)]), { reps: "5", weight: "100", unit: "kg" });
  assert.deepEqual(heaviestSet([setOf(0, 2, 62.5), setOf(1, 2, 62.5, "kg", true)]), { reps: "2", weight: "62.5", unit: "kg" });
});

rule("ghost: heaviestSet with all-zero weights takes the most reps (then the earlier set), and no usable set gives null", async ({ assert }) => {
  assert.deepEqual(heaviestSet([setOf(0, 8, 0), setOf(1, 12, 0, "lb"), setOf(2, 10, 0)]), { reps: "12", weight: "0", unit: "lb" });
  // 0 kg and 0 lb are equal: with equal reps the earlier set decides, which here shows as its unit
  assert.deepEqual(heaviestSet([setOf(1, 8, 0, "lb"), setOf(0, 8, 0, "kg")]), { reps: "8", weight: "0", unit: "kg" });
  assert.equal(heaviestSet([]), null);
  assert.equal(heaviestSet([setOf(0, 10, 60, "kg", true)]), null); // missing history and warm-ups only are the same: nothing to copy
});

rule("ghost: ghostFor copies the row above field by field (typed, then its ghost, then blank), and the first row copies the last session", async ({ assert }) => {
  const last = { reps: "5", weight: "100", unit: "kg" };
  const rows = [plannedRowOf(), plannedRowOf("6", ""), plannedRowOf("", "90", "lb"), plannedRowOf()];
  assert.deepEqual(ghostFor(rows, 0, last), last);
  assert.deepEqual(ghostFor(rows, 1, last), { reps: "", weight: "100", unit: "kg" }); // reps typed: only the weight is a ghost
  assert.deepEqual(ghostFor(rows, 2, last), { reps: "6", weight: "", unit: "kg" }); // reps typed above; weight typed here
  assert.deepEqual(ghostFor(rows, 3, last), { reps: "6", weight: "90", unit: "lb" }); // typed text above wins over its ghost
  assert.equal(ghostFor(rows, 0, null), null); // no history
  assert.deepEqual(ghostFor(rows, 1, null), null); // nothing above to copy for the weight, and reps are typed
  assert.deepEqual(ghostFor([loggedRowOf(8, 62.5), plannedRowOf(" ", " ")], 1), { reps: "8", weight: "62.5", unit: "kg" }); // spaces are blank
  assert.deepEqual(ghostFor([plannedRowOf(" 7 ", "80", "kg"), plannedRowOf()], 1), { reps: "7", weight: "80", unit: "kg" });
});

rule("ghost: ghostFor gives no ghost to logged or fully typed rows, and a weight-only row above gives a weight-only ghost", async ({ assert }) => {
  assert.equal(ghostFor([loggedRowOf(8, 100)], 0, { reps: "5", weight: "100", unit: "kg" }), null);
  assert.equal(ghostFor([loggedRowOf(8, 100), plannedRowOf("6", "90")], 1), null);
  assert.deepEqual(ghostFor([plannedRowOf("", "140", "kg"), plannedRowOf()], 1), { reps: "", weight: "140", unit: "kg" });
  assert.equal(ghostFor([plannedRowOf(), plannedRowOf()], 1), null); // a blank row above with no ghost gives nothing
  assert.equal(ghostFor([], 0), null);
  assert.equal(sameGhost(null, null), true);
  assert.equal(sameGhost({ reps: "8", weight: "100", unit: "kg" }, { reps: "8", weight: "100", unit: "lb" }), false);
});
