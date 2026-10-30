// logger.getMuscleStatus().details: the three windows as the logger cuts them (the last 7 days, the 7 days before, the
// last 3 weeks) read from a real store with a fixed clock. The panel's wording is tested in muscle-detail.test.js.

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

let counter = 0;
async function save(store, exerciseId, setAgo) {
  counter += 1;
  const id = `d${counter}`;
  const entry = { id: `${id}-e`, workoutId: id, exerciseId, order: 0 };
  const sets = [{ id: `${id}-s0`, entryId: entry.id, order: 0, reps: 5, weightValue: 50, weightUnit: "kg", isWarmup: false, completedAt: ago(setAgo) }];
  await store.saveWorkoutWithDetails({ id, startedAt: ago(setAgo + 60000), endedAt: ago(setAgo) }, [entry], sets);
}

async function bicepsAfter(setAgo) {
  const { store, logger } = await setup();
  await save(store, "seed-dumbbell-curl", setAgo);
  return (await logger.getMuscleStatus()).details.biceps;
}

test("details: 19 muscles, no neck, built from the same read as the values, with the stored exercise names", async () => {
  const { store, logger } = await setup();
  await save(store, "seed-dumbbell-curl", DAY);
  const status = await logger.getMuscleStatus();
  assert.equal(Object.keys(status.details).length, 19);
  assert.ok(!("neck" in status.details));
  for (const id of Object.keys(status.values)) assert.equal(status.details[id].weighted, status.values[id], id);
  assert.deepEqual(status.details.biceps.contributors.primary.map((row) => [row.name, row.sets, row.weighted]), [["Dumbbell curl", 1, 1]]);
  assert.deepEqual(status.details.forearms.contributors.secondary.map((row) => [row.name, row.sets, row.weighted]), [["Dumbbell curl", 1, 0.25]]); // forearms 0.25 a set
  assert.deepEqual(Object.keys(status).sort(), ["above", "details", "hasHistory", "neglected", "values"]);
});

test("details: the windows meet without a gap or an overlap at exactly 7 days, and the previous one ends at 14 days", async () => {
  const trend = async (setAgo) => (await bicepsAfter(setAgo)).trend;
  const [now7, past7, edge14, past14] = [await trend(7 * DAY), await trend(7 * DAY + 1), await trend(14 * DAY), await trend(14 * DAY + 1)];
  assert.deepEqual([now7.current, now7.previous], [1, 0], "exactly 7 days ago is in the last 7 days");
  assert.deepEqual([past7.current, past7.previous], [0, 1], "1 ms older is in the 7 days before");
  assert.deepEqual([edge14.current, edge14.previous], [0, 1], "exactly 14 days ago is in the 7 days before");
  assert.equal(past14, null, "1 ms older is in neither window");
});

test("details: a set made at this very moment counts, and the longer window holds the last 3 weeks and no more", async () => {
  const now = await bicepsAfter(0);
  assert.equal(now.lastTrainedText, "less than 24 hours ago");
  assert.equal(now.weighted, 1);
  const ten = await bicepsAfter(10 * DAY);
  assert.equal(ten.lastTrainedText, "10 days ago");
  assert.equal(ten.hasSets, false);
  assert.equal((await bicepsAfter(20 * DAY)).lastTrainedText, "20 days ago");
  assert.equal((await bicepsAfter(22 * DAY)).lastTrainedText, "more than 3 weeks ago or never");
});
