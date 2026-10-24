// The "Custom" marker on the Log tab and in the history detail: src/domain/exercise-names.js and the
// markCustom flag the logger adds to entries and blocks.

import test from "node:test";
import assert from "node:assert/strict";
import { nameKey, ambiguousCustomIds } from "../src/domain/exercise-names.js";
import { nameKey as builtinNameKey } from "../src/domain/builtin.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { CATALOG } from "../src/catalog/catalog.js";

const NOW = "2026-10-24T10:00:00.000Z";

test("exercise names: the copied nameKey is the same function as nameKey in builtin.js", () => {
  assert.equal(nameKey.toString(), builtinNameKey.toString(), "the copy in exercise-names.js has drifted from builtin.js");
  const names = [
    ...SEED_EXERCISES.map((exercise) => exercise.name),
    ...CATALOG.map((entry) => entry.name),
    "BENCH press", "Straße", "İnce curl", "ΣΊΣΥΦΟΣ", "",
  ];
  for (const name of names) assert.equal(nameKey(name), builtinNameKey(name), name);
});

test("exercise names: only a custom whose name another stored exercise shares, ignoring case, is marked", () => {
  const exercises = [
    { id: "c-press", name: "My Press", isCustom: true },
    { id: "cat-press", name: "my press", isCustom: false }, // the catalog twin is never marked
    { id: "c-alone", name: "Lonely Curl", isCustom: true }, // a custom with a unique name is not marked
    { id: "c-retired", name: "Old Row", isCustom: true },
    { id: "cat-retired", name: "OLD ROW", isCustom: false, retired: true }, // a retired twin still counts
    { id: "seed-a", name: "Same Seed", isCustom: false },
    { id: "cat-a", name: "Same Seed", isCustom: false }, // two non-customs: the picker marks neither, so nor does this
  ];
  assert.deepEqual([...ambiguousCustomIds(exercises)].sort(), ["c-press", "c-retired"]);
  assert.deepEqual([...ambiguousCustomIds([])], []);
  // Two customs with one name (only possible through an old backup) are both marked.
  assert.deepEqual([...ambiguousCustomIds([
    { id: "x1", name: "Twin", isCustom: true }, { id: "x2", name: "twin", isCustom: true },
  ])].sort(), ["x1", "x2"]);
});

// A store where the custom "My Press" shares its name with a catalog record, the custom "Old Row" with a
// retired catalog record, and "Lonely Curl" with nothing. The catalog records are saved directly, as the
// catalog sync does; addCustomExercise refuses a taken name, so the customs come first.
async function setup() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const logger = createLogger(store, { now: () => new Date(NOW) });
  const custom = async (name) => (await logger.addCustomExercise({ name, primaryMuscles: ["chest"] })).id;
  const ids = { press: await custom("My Press"), row: await custom("Old Row"), curl: await custom("Lonely Curl") };
  await store.saveExercise({ id: "Cat_Press", name: "my press", primaryMuscles: ["chest"], origin: "upstream", catalogVersion: 1 });
  await store.saveExercise({ id: "Cat_Row", name: "OLD ROW", primaryMuscles: ["lats"], origin: "upstream", catalogVersion: 1, retired: true });
  return { adapter, store, logger, ids };
}

test("exercise names: the Log blocks and the current workout mark the custom twin by id, never the catalog twin", async () => {
  const { logger, ids } = await setup();
  for (const id of [ids.press, "Cat_Press", ids.curl]) await logger.addSet(id);
  const marks = (items) => items.map((item) => [item.exerciseId, item.exerciseName, item.markCustom]);
  assert.deepEqual(marks((await logger.getSession()).blocks), [
    [ids.press, "My Press", true],
    ["Cat_Press", "my press", false],
    [ids.curl, "Lonely Curl", false],
  ]);
  // Logging a set starts the workout, whose entries carry the same flag.
  await logger.logSet({ exerciseId: ids.press, reps: "5", weight: "50", weightUnit: "kg" });
  await logger.logSet({ exerciseId: "Cat_Press", reps: "5", weight: "60", weightUnit: "kg" });
  assert.deepEqual(marks((await logger.getCurrent()).workout.entries), [
    [ids.press, "My Press", true],
    ["Cat_Press", "my press", false],
  ]);
});

test("exercise names: the history detail marks a custom with a retired twin, and an entry whose exercise is missing resolves unmarked", async () => {
  const { adapter, store, logger, ids } = await setup();
  const gone = (await logger.addCustomExercise({ name: "Gone Lift", primaryMuscles: ["chest"] })).id;
  const set = (id, entryId) => ({ id, entryId, order: 0, reps: 5, weightValue: 10, weightUnit: "kg", completedAt: NOW });
  await store.saveWorkoutWithDetails(
    { id: "w1", startedAt: NOW, endedAt: NOW },
    [
      { id: "e1", workoutId: "w1", exerciseId: ids.row, order: 0 },
      { id: "e2", workoutId: "w1", exerciseId: "Cat_Row", order: 1 },
      { id: "e3", workoutId: "w1", exerciseId: gone, order: 2 },
    ],
    [set("s1", "e1"), set("s2", "e2"), set("s3", "e3")],
  );
  // The store refuses an entry for an unknown exercise, so the record is removed underneath it.
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", gone));
  const detail = await logger.getWorkoutDetail("w1");
  assert.deepEqual(detail.entries.map((entry) => [entry.exerciseId, entry.exerciseName, entry.markCustom]), [
    [ids.row, "Old Row", true],
    ["Cat_Row", "OLD ROW", false],
    [gone, "Unknown exercise", false],
  ]);
});
