// The picker's Recent group: derived from saved sets only. Expected values are written out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { exerciseIdsByRecency } from "../src/domain/recent-exercises.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";

const NOW = "2026-10-24T12:00:00.000Z";
const day = (n) => `2026-09-${String(n).padStart(2, "0")}T10:00:00.000Z`;
const BENCH = "seed-barbell-bench-press";
const SQUAT = "seed-barbell-squat";
const DEADLIFT = "seed-conventional-deadlift";

async function setup() {
  const store = createStore(createMemoryAdapter());
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  return { store, logger: createLogger(store, { now: () => new Date(NOW) }) };
}

// One finished workout started on `startedAt`; uses = [[exerciseId, completedAt | null, setCount], ...] in entry order.
let counter = 0;
async function saveWorkout(store, startedAt, uses) {
  counter += 1;
  const id = `w${counter}`;
  const entries = uses.map(([exerciseId], order) => ({ id: `${id}-e${order}`, workoutId: id, exerciseId, order }));
  const sets = uses.flatMap(([, completedAt, count], order) => Array.from({ length: count ?? 1 }, (_, i) => ({
    id: `${id}-e${order}-s${i}`, entryId: `${id}-e${order}`, order: i, reps: 5, weightValue: 50, weightUnit: "kg", completedAt,
  })));
  await store.saveWorkoutWithDetails({ id, startedAt, endedAt: startedAt }, entries, sets);
}

const catalogEntry = (n, extra = {}) => ({
  id: `Cat_${n}`, name: `Catalog ${n}`, primaryMuscles: ["chest"], equipmentTags: ["dumbbell"], origin: "upstream", catalogVersion: 1, ...extra,
});
const ids = (list) => list.map((exercise) => exercise.id);

test("recent: newest workout first, and within a workout the exercise with the latest set first", async () => {
  const { store, logger } = await setup();
  await saveWorkout(store, day(1), [[SQUAT, day(1)]]);
  await saveWorkout(store, day(3), [[BENCH, "2026-09-03T10:05:00.000Z"], [DEADLIFT, "2026-09-03T10:40:00.000Z"]]);
  await saveWorkout(store, day(2), [["seed-pull-up", day(2)]]);
  assert.deepEqual(ids(await logger.findRecentExercises()), [DEADLIFT, BENCH, "seed-pull-up", SQUAT]);
});

test("recent: sets with no completion time rank below dated ones, later entries first; a repeated exercise appears once", () => {
  const entry = (exerciseId, order, completedAts) => ({ exerciseId, order, sets: completedAts.map((completedAt) => ({ completedAt })) });
  assert.deepEqual(
    exerciseIdsByRecency([entry("a", 0, [null]), entry("b", 1, [null]), entry("c", 2, ["2026-09-01T10:00:00.000Z"]), entry("a", 3, [null])]),
    ["c", "a", "b"],
  );
  // an entry's latest set decides, not its first
  assert.deepEqual(exerciseIdsByRecency([entry("x", 0, ["2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z"]), entry("y", 1, ["2026-09-01T10:30:00.000Z"])]), ["x", "y"]);
});

test("recent: at most 8 distinct exercises, and a repeated exercise counts once", async () => {
  const { store, logger } = await setup();
  for (let i = 0; i < 10; i += 1) await store.saveExercise(catalogEntry(i));
  // Cat_0 is the oldest; Cat_9 the newest. Bench is used on three different days.
  await saveWorkout(store, day(1), [["Cat_0", day(1)]]);
  await saveWorkout(store, day(2), [[BENCH, day(2)]]);
  await saveWorkout(store, day(3), [["Cat_1", day(3)]]);
  for (let i = 2; i < 10; i += 1) await saveWorkout(store, day(i + 2), [[`Cat_${i}`, day(i + 2)]]);
  await saveWorkout(store, day(20), [[BENCH, day(20)]]);
  const recent = ids(await logger.findRecentExercises());
  assert.deepEqual(recent, [BENCH, "Cat_9", "Cat_8", "Cat_7", "Cat_6", "Cat_5", "Cat_4", "Cat_3"]);
  assert.deepEqual(ids(await logger.findRecentExercises(2)), [BENCH, "Cat_9"]);
  await assert.rejects(logger.findRecentExercises(0), /limit/);
});

test("recent: retired exercises and ids that no longer exist are skipped and do not use up a place", async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  await store.saveExercise(catalogEntry(1, { retired: true }));
  await store.saveExercise(catalogEntry(2));
  await saveWorkout(store, day(1), [[SQUAT, day(1)]]);
  await saveWorkout(store, day(2), [["Cat_1", day(2)], ["Cat_2", day(2)]]);
  await saveWorkout(store, day(3), [[BENCH, day(3)]]);
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", BENCH)); // its workout stays
  const logger = createLogger(store, { now: () => new Date(NOW) });
  assert.deepEqual(ids(await logger.findRecentExercises()), ["Cat_2", SQUAT]); // not Cat_1 (retired), not BENCH (missing)
  assert.deepEqual(ids(await logger.findRecentExercises(1)), ["Cat_2"]); // the skipped ones took no place
});

test("recent: only saved sets count: unchecked rows, entries without sets and an empty history give nothing", async () => {
  const { store, logger } = await setup();
  assert.deepEqual(await logger.findRecentExercises(), []);
  await logger.addSet(BENCH); // an unchecked row lives in meta
  assert.deepEqual(await logger.findRecentExercises(), []);
  await store.saveWorkoutWithDetails({ id: "empty", startedAt: day(5), endedAt: day(5) }, [{ id: "empty-e", workoutId: "empty", exerciseId: SQUAT, order: 0 }], []); // an entry with no sets
  assert.deepEqual(await logger.findRecentExercises(), []);
  // checking the row makes a real set, and then it counts
  const row = (await logger.getSession()).blocks[0].rows[0];
  await logger.checkSet(row.id, { reps: "5", weight: "100" });
  assert.deepEqual(ids(await logger.findRecentExercises()), [BENCH]);
  // unchecking removes the set again
  await logger.uncheckSet(row.id);
  assert.deepEqual(await logger.findRecentExercises(), []);
});

test("recent: reads only; nothing in the database changes", async () => {
  const { store, logger } = await setup();
  await saveWorkout(store, day(1), [[SQUAT, day(1)]]);
  const snapshot = async () => JSON.stringify(await store.listExercises()) + JSON.stringify(await store.listWorkoutSummaries());
  const before = await snapshot();
  await logger.findRecentExercises();
  assert.equal(await snapshot(), before);
});

test("recent: only the newest 30 workouts are looked through, so an exercise last used longer ago is not recent", async () => {
  const { store, logger } = await setup();
  await saveWorkout(store, "2026-01-01T10:00:00.000Z", [[SQUAT, "2026-01-01T10:00:00.000Z"]]); // the 31st newest
  for (let i = 0; i < 30; i += 1) {
    const at = new Date(Date.parse("2026-02-01T10:00:00.000Z") + i * 24 * 60 * 60 * 1000).toISOString();
    await saveWorkout(store, at, [[BENCH, at]]);
  }
  assert.deepEqual(ids(await logger.findRecentExercises()), [BENCH]); // squat is outside the newest 30
  assert.deepEqual(ids(await logger.findRecentExercises(8, 31)), [BENCH, SQUAT]);
  await assert.rejects(logger.findRecentExercises(8, 0), /maxWorkouts/);
});
