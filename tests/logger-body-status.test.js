// logger.getMuscleStatus: which workouts it loads and how it reads the clock. Plain store, memory adapter, fixed clock.
// Expected values are worked out by hand from the seed exercises (src/domain/seed.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

async function setup() {
  const store = createStore(createMemoryAdapter());
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  return { store, logger: createLogger(store, { now: () => new Date(NOW) }) };
}

// One workout with one entry; `setTimes` are ms before NOW. endedAt is null for an unfinished workout.
let counter = 0;
async function save(store, { startedAgo, endedAgo, exerciseId, setTimes, isWarmup = false }) {
  counter += 1;
  const id = `w${counter}`;
  const entry = { id: `${id}-e`, workoutId: id, exerciseId, order: 0 };
  const sets = setTimes.map((ms, order) => ({ id: `${id}-s${order}`, entryId: entry.id, order, reps: 5, weightValue: 50, weightUnit: "kg", isWarmup, completedAt: ago(ms) }));
  await store.saveWorkoutWithDetails({ id, startedAt: ago(startedAgo), endedAt: endedAgo === null ? null : ago(endedAgo) }, [entry], sets);
}

test("getMuscleStatus: sets of the last 7 days are weighted, a workout that ended before 3 weeks ago is not loaded, and an unfinished old workout is", async () => {
  const { store, logger } = await setup();
  const HOUR = DAY / 24;
  // leg press, 3 sets, 5 days ago: quads 3, glutes and adductors 1.5 each (0.5 a set), hamstrings 0.75 shown as 1 (0.25 a set)
  await save(store, { startedAgo: 5 * DAY, endedAgo: 5 * DAY - HOUR, exerciseId: "seed-leg-press", setTimes: [5 * DAY - 10 * 60000, 5 * DAY - 20 * 60000, 5 * DAY - 30 * 60000] });
  // bench, 40 days ago and finished then: outside the 3 weeks, so chest has no sets in the window
  await save(store, { startedAgo: 40 * DAY, endedAgo: 40 * DAY - HOUR, exerciseId: "seed-barbell-bench-press", setTimes: [40 * DAY - 10 * 60000] });
  // a curl workout that started 30 days ago and is still unfinished (continued): one set an hour ago counts, one 9 days ago is in the 3 weeks only
  await save(store, { startedAgo: 30 * DAY, endedAgo: null, exerciseId: "seed-dumbbell-curl", setTimes: [HOUR, 9 * DAY] });
  const status = await logger.getMuscleStatus();
  assert.equal(status.values.quads, 3);
  assert.equal(status.values.glutes, 1.5);
  assert.equal(status.values.adductors, 1.5);
  assert.equal(status.values.hamstrings, 1);
  assert.equal(status.values.biceps, 1);
  assert.equal(status.values.forearms, 0.5);
  assert.equal(status.values.chest, 0);
  assert.equal(status.hasHistory, true);
  assert.ok(status.neglected.includes("chest"), "chest was last trained 40 days ago");
  assert.ok(!status.neglected.includes("quads") && !status.neglected.includes("biceps"));
  assert.deepEqual(status.above, []);
  assert.ok(!("neck" in status.values));
});

test("getMuscleStatus: a finished workout whose last set is inside the window is loaded even if it started long before", async () => {
  const { store, logger } = await setup();
  await save(store, { startedAgo: 25 * DAY, endedAgo: 2 * DAY, exerciseId: "seed-barbell-squat", setTimes: [2 * DAY + 60000] });
  const status = await logger.getMuscleStatus();
  assert.equal(status.values.quads, 1);
  assert.equal(status.values.glutes, 1);
  assert.ok(!status.neglected.includes("quads"));
});

test("getMuscleStatus: warm-up sets do not count, and an empty database has no history and no neglected muscles", async () => {
  const { store, logger } = await setup();
  const empty = await logger.getMuscleStatus();
  assert.equal(empty.hasHistory, false);
  assert.deepEqual(empty.neglected, []);
  await save(store, { startedAgo: DAY, endedAgo: DAY - 1000, exerciseId: "seed-dumbbell-curl", setTimes: [DAY - 60000], isWarmup: true });
  const warmupOnly = await logger.getMuscleStatus();
  assert.equal(warmupOnly.hasHistory, false);
  assert.equal(warmupOnly.values.biceps, 0);
});

test("getMuscleStatus: it reads the clock it was given, so a later clock moves the window", async () => {
  const { store } = await setup();
  await save(store, { startedAgo: 5 * DAY, endedAgo: 5 * DAY - 1000, exerciseId: "seed-dumbbell-curl", setTimes: [5 * DAY - 60000] });
  const later = createLogger(store, { now: () => new Date(NOW + 3 * DAY) }); // the set is now 8 days old
  const status = await later.getMuscleStatus();
  assert.equal(status.values.biceps, 0);
  assert.ok(!status.neglected.includes("biceps"));
});
