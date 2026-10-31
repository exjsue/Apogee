// The Body panel's Top set and Stall rows (src/domain/top-set.js), and how logger.getMuscleStatus feeds them. Expected
// values are worked out by hand: Epley e1RM = weight x (1 + reps / 30), weights converted to the target unit and
// rounded to 0.1 first, the e1RM rounded to 0.1 again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMuscleLoad } from "../src/domain/muscle-load.js";
import { sessionsOf, isStalled, buildTopSets } from "../src/domain/top-set.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// One flat set record (as store.listFinishedSetRecords returns), in workout `w`.
let n = 0;
const set = (w, weightValue, reps, { unit = "kg", daysAgo = 1, isWarmup = false, exerciseId = "bench" } = {}) => {
  n += 1;
  return { id: `s${n}`, workoutId: w, exerciseId, order: n, reps, weightValue, weightUnit: unit, isWarmup, completedAt: at(daysAgo) };
};
// One set per session, oldest first: [weight, reps] pairs, sessions 10, 9, 8... days ago.
const history = (pairs, unit = "kg") => pairs.map(([weight, reps], i) => set(`w${i}`, weight, reps, { unit, daysAgo: 10 - i }));
const bestsOf = (sets, unit = "kg") => sessionsOf(sets, "bench", unit).map((s) => s.best).filter((b) => b !== null);

test("stall: exactly 4 sessions with no gain is stalled, 3 sessions never are", () => {
  assert.equal(isStalled(bestsOf(history([[100, 5], [100, 5], [100, 5], [100, 5]]))), true, "4 equal sessions: a tie is not progress");
  assert.equal(isStalled(bestsOf(history([[100, 5], [100, 5], [100, 5]]))), false, "3 sessions");
  assert.equal(isStalled(bestsOf(history([[100, 5]]))), false, "1 session");
  assert.equal(isStalled([]), false);
});

test("stall: one extra rep in any of the latest 3 clears it; only the 4th-latest is the reference", () => {
  assert.deepEqual(bestsOf(history([[100, 5], [100, 6]])), [116.7, 120]);
  assert.equal(isStalled(bestsOf(history([[100, 5], [100, 5], [100, 5], [100, 6]]))), false, "the latest session");
  assert.equal(isStalled(bestsOf(history([[100, 5], [100, 6], [100, 5], [100, 5]]))), false, "the 3rd-latest session");
  assert.equal(isStalled(bestsOf(history([[100, 6], [100, 5], [100, 5], [100, 5]]))), true, "dropping below the 4th-latest is stalled");
  assert.equal(isStalled(bestsOf(history([[200, 5], [100, 5], [100, 5], [100, 5], [100, 5]]))), true, "only the latest 4 sessions are looked at");
  assert.equal(isStalled(bestsOf(history([[100, 5], [100, 5], [100, 5], [100, 5], [100, 6]]))), false);
});

test("sessions: warm-ups and unchecked sets do not count; reps above the e1RM limit give no e1RM but can be the top set", () => {
  assert.deepEqual(sessionsOf([set("a", 100, 5, { isWarmup: true }), set("a", 60, 5, { isWarmup: true })], "bench", "kg"), [], "warm-ups only");
  assert.deepEqual(sessionsOf([{ ...set("a", 100, 5), completedAt: null }], "bench", "kg"), [], "not done");
  const [only] = sessionsOf([set("a", 60, 15), set("a", 50, 20)], "bench", "kg");
  assert.equal(only.best, null, "15 and 20 reps are above the app's e1RM limit");
  assert.equal(only.top.weightValue, 60);
  const sets = [set("a", 100, 5), set("a", 120, 1), set("a", 120, 3), set("a", 140, 1, { isWarmup: true })];
  const [one] = sessionsOf(sets, "bench", "kg");
  assert.equal(one.best, 132, "120 x 3 = 132, the warm-up is ignored");
  assert.deepEqual([one.top.weightValue, one.top.reps], [120, 3], "heaviest, then most reps");
});

test("sessions: mixed units are converted to the preferred unit and rounded to 0.1 before comparing; the top set keeps its unit as entered", () => {
  // 220 lb = 99.8 kg -> 116.4; 221 lb = 100.2 kg -> 116.9; 100 kg -> 116.7
  assert.deepEqual(bestsOf([...history([[100, 5]]), ...history([[220, 5], [220, 5], [220, 5]], "lb").map((s, i) => ({ ...s, workoutId: `l${i}`, completedAt: at(5 - i) }))]), [116.7, 116.4, 116.4, 116.4]);
  const lbs = (w) => history([[w, 5], [w, 5], [w, 5]], "lb").map((s, i) => ({ ...s, workoutId: `l${i}`, completedAt: at(5 - i) }));
  assert.equal(isStalled(bestsOf([...history([[100, 5]]), ...lbs(220)])), true);
  assert.equal(isStalled(bestsOf([...history([[100, 5]]), ...lbs(221)])), false);
  const [mixed] = sessionsOf([set("a", 100, 5), set("a", 225, 5, { unit: "lb" })], "bench", "kg");
  assert.deepEqual([mixed.top.weightValue, mixed.top.weightUnit], [225, "lb"], "225 lb (102.1 kg) is heavier than 100 kg");
  assert.deepEqual(bestsOf(history([[100, 5]]), "lb"), [257.3], "the same set in lb: 220.5 lb -> 257.3");
});

// buildTopSets with a month load made by the diagram's own function and weights.
const ex = (id, name, primaryMuscles, secondaryMuscles = [], secondaryWeights) => ({ id, name, primaryMuscles, secondaryMuscles, isCustom: true, secondaryWeights });
const BENCH = ex("bench", "Bench press", ["chest"], ["triceps"], { triceps: 0.75 });
const PUSHDOWN = ex("pushdown", "Pushdown", ["triceps"]);
const SHRUG = ex("shrug", "Shrug", ["traps"]);
const NECK = ex("neckx", "Neck curl", ["neck"]);
const EXERCISES = [BENCH, PUSHDOWN, SHRUG, NECK];
const asWorkouts = (sets) => [{ entries: sets.map((s) => ({ exerciseId: s.exerciseId, sets: [s] })) }];
const topSets = (sets, unit = "kg") => buildTopSets({
  month: computeMuscleLoad({ workouts: asWorkouts(sets), exercises: EXERCISES, window: { start: NOW - 28 * DAY, end: NOW + 1 }, detail: true }),
  sets,
  exercises: EXERCISES,
  unit,
});

test("top set: the exercise with the most weighted sets in 28 days, secondary weights included; older sessions still draw the sparkline", () => {
  // triceps: bench 3 sets x 0.75 = 2.25 beats pushdown 2 sets x 1
  const sets = [
    set("old", 90, 5, { daysAgo: 60 }),
    set("a", 100, 5, { daysAgo: 2 }), set("a", 100, 5, { daysAgo: 2 }), set("a", 105, 3, { daysAgo: 2 }),
    set("b", 40, 10, { daysAgo: 1, exerciseId: "pushdown" }), set("b", 40, 10, { daysAgo: 1, exerciseId: "pushdown" }),
  ];
  const t = topSets(sets).triceps;
  assert.equal(t.name, "Bench press");
  assert.equal(t.text, "Top set: Bench press, 3 reps · 105 kg");
  assert.deepEqual(t.spark, [105, 116.7], "the 60-day-old session is outside the 28 days but is one of the last 6");
  assert.equal(t.stallText, null);
  assert.equal(topSets(sets).chest.name, "Bench press");
});

test("top set: empty states, one session hides the sparkline, the stall sentence, and the neck counts as traps", () => {
  const sets = [set("a", 100, 5, { daysAgo: 30 })];
  assert.deepEqual(topSets(sets).chest, { exerciseId: null, name: null, text: "Top set: no sets in the last 28 days", spark: null, sparkText: null, stallText: null });
  assert.equal(topSets([set("a", 100, 5, { isWarmup: true })]).chest.exerciseId, null, "warm-ups only");
  const one = topSets([set("a", 100, 5)]).chest;
  assert.equal(one.spark, null, "one session: no sparkline");
  assert.equal(one.sparkText, null);
  const stalled = topSets(history([[100, 5], [100, 5], [100, 5], [100, 5]])).chest;
  assert.equal(stalled.stallText, "Stalled: Bench press has not progressed in 4 sessions.");
  assert.equal(stalled.sparkText, "Best estimated 1RM, last 4 sessions: 116.7, 116.7, 116.7, 116.7 kg");
  const traps = topSets([set("n", 20, 12, { exerciseId: "neckx" }), set("n", 20, 12, { exerciseId: "neckx" }), set("s", 100, 8, { exerciseId: "shrug" })]);
  assert.equal(traps.traps.name, "Neck curl", "2 neck sets beat 1 trap set, as on the diagram");
  assert.ok(!("neck" in traps));
  assert.throws(() => buildTopSets({ month: { muscles: {} }, sets: [], exercises: [] }), TypeError);
});

test("logger: each detail's topSet comes from the 28-day window (a workout 25 days ago is loaded) and the finished sets of any age", async () => {
  const store = createStore(createMemoryAdapter());
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const save = async (id, daysAgo, weightValue) => {
    const entry = { id: `${id}-e`, workoutId: id, exerciseId: "seed-barbell-bench-press", order: 0 };
    const sets = [{ id: `${id}-s`, entryId: entry.id, order: 0, reps: 5, weightValue, weightUnit: "kg", isWarmup: false, completedAt: at(daysAgo) }];
    await store.saveWorkoutWithDetails({ id, startedAt: at(daysAgo + 0.01), endedAt: at(daysAgo - 0.01) }, [entry], sets);
  };
  await save("w1", 90, 90);
  await save("w2", 25, 100);
  const status = await createLogger(store, { now: () => new Date(NOW) }).getMuscleStatus();
  assert.equal(status.values.chest, 0, "the weekly total is unchanged: nothing in the last 7 days");
  assert.equal(status.details.chest.topSet.name, "Barbell bench press");
  assert.equal(status.details.chest.topSet.text, "Top set: Barbell bench press, 5 reps · 100 kg");
  assert.deepEqual(status.details.chest.topSet.spark, [231.5, 257.3], "in the preferred unit, lb by default: 198.4 lb x 5, 220.5 lb x 5");
  assert.ok(Object.values(status.details).every((detail) => detail.topSet !== undefined), "every displayed muscle has one");
  await store.setPreferredUnit("kg");
  assert.deepEqual((await createLogger(store, { now: () => new Date(NOW) }).getMuscleStatus()).details.chest.topSet.spark, [105, 116.7]);
});
