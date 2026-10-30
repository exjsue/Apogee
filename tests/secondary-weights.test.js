// Secondary-muscle weights: the bundled weights of the default exercises, the per-muscle credit and its one rounding,
// custom exercises' stored weights (create, edit, backup) and the 0.5 that a missing weight means.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createBackup } from "../src/backup/backup.js";
import { createLogger } from "../src/app/logger.js";
import { createExercise, SECONDARY_WEIGHT_STEPS } from "../src/domain/model.js";
import { computeMuscleLoad, roundToHalf } from "../src/domain/muscle-load.js";
import { computeBodyStatus } from "../src/domain/body-status.js";
import { CATALOG } from "../src/catalog/catalog.js";
import { SECONDARY_WEIGHTS } from "../src/catalog/secondary-weights.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { OVERRIDES } from "../tools/exercise-catalog/lib/rules-weights.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const WINDOW = { start: NOW - 7 * DAY, end: NOW + 1 };
const at = (ms) => new Date(NOW - ms).toISOString();
const workout = (exerciseId, count, warmups = 0) => ({
  entries: [{ exerciseId, sets: [...Array(count).fill({ completedAt: at(DAY) }), ...Array(warmups).fill({ completedAt: at(DAY), isWarmup: true })] }],
});
const custom = (secondaryWeights) => createExercise({
  id: "my-press", name: "My press", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "front_delts"], isCustom: true, secondaryWeights,
});
const shown = (load) => computeBodyStatus({ recent: load, longer: load }).values;

test("weights: every secondary muscle of every default exercise has a weight of 0.25, 0.5, 0.75 or 1, and nothing else is weighted", () => {
  const defaults = [...CATALOG, ...SEED_EXERCISES];
  const ids = new Set(defaults.map((e) => e.id));
  for (const exercise of defaults) {
    assert.ok(!exercise.secondaryMuscles.some((m) => exercise.primaryMuscles.includes(m)), `${exercise.id} lists a muscle as primary and secondary`);
    const weights = SECONDARY_WEIGHTS[exercise.id] ?? {};
    assert.deepEqual(Object.keys(weights).sort(), [...exercise.secondaryMuscles].sort(), exercise.id);
    for (const [muscle, weight] of Object.entries(weights)) assert.ok(SECONDARY_WEIGHT_STEPS.includes(weight), `${exercise.id} ${muscle} ${weight}`);
  }
  for (const id of Object.keys(SECONDARY_WEIGHTS)) assert.ok(ids.has(id), `${id} is weighted but is not a default exercise`);
  // every hand-set override names a real exercise and one of its secondary muscles
  const byId = new Map(defaults.map((e) => [e.id, e]));
  for (const [id, muscles] of Object.entries(OVERRIDES)) {
    assert.ok(byId.has(id), `override for unknown id ${id}`);
    for (const muscle of Object.keys(muscles)) assert.ok(byId.get(id).secondaryMuscles.includes(muscle), `${id} ${muscle}`);
  }
});

test("weights: a muscle's total is rounded once, at the end, to the nearest 0.5, never per set", () => {
  assert.equal(roundToHalf(0.75), 1);
  assert.equal(roundToHalf(0.25), 0.5);
  assert.equal(roundToHalf(1.25), 1.5);
  assert.equal(roundToHalf(1.5), 1.5);
  // 3 sets at 0.25: 0.75 exact, shown as 1 (rounding each set would give 0.5 * 3 = 1.5)
  const quarter = computeMuscleLoad({ workouts: [workout("my-press", 3)], exercises: [custom({ triceps: 0.25, front_delts: 0.5 })], window: WINDOW });
  assert.equal(quarter.muscles.triceps.weighted, 0.75);
  assert.equal(shown(quarter).triceps, 1);
  // 3 sets at 0.5: 1.5
  assert.equal(shown(quarter).front_delts, 1.5);
  assert.equal(shown(quarter).chest, 3);
});

test("weights: a custom exercise without stored weights counts 0.5 per secondary, and warm-ups never count", () => {
  const load = computeMuscleLoad({ workouts: [workout("my-press", 2, 3)], exercises: [custom(undefined)], window: WINDOW });
  assert.equal(load.muscles.triceps.weighted, 1);
  assert.equal(load.muscles.front_delts.weighted, 1);
  assert.equal(load.muscles.chest.weighted, 2);
  const weighted = computeMuscleLoad({ workouts: [workout("my-press", 2, 3)], exercises: [custom({ triceps: 0.75 })], window: WINDOW });
  assert.equal(weighted.muscles.triceps.weighted, 1.5);
  assert.equal(weighted.muscles.front_delts.weighted, 1, "a muscle left out of the stored weights still counts 0.5");
});

test("weights: a default exercise takes its weights from the bundled catalog by id, even when its stored copy holds other numbers", () => {
  const stored = { ...SEED_EXERCISES.find((e) => e.id === "seed-barbell-squat"), secondaryWeights: { hamstrings: 1, adductors: 1, lower_back: 1 } };
  const load = computeMuscleLoad({ workouts: [workout(stored.id, 4)], exercises: [stored], window: WINDOW, defaultWeights: SECONDARY_WEIGHTS, detail: true });
  for (const muscle of stored.secondaryMuscles) assert.equal(load.muscles[muscle].weighted, 4 * SECONDARY_WEIGHTS[stored.id][muscle], muscle);
  assert.equal(load.muscles.hamstrings.weighted, 1);
  assert.deepEqual(load.breakdown.adductors.map((row) => row.weighted), [2]);
});

test("weights: the Body tab reads the bundled weights for a stored seed (old installs get the new numbers with no rewrite)", async () => {
  const store = createStore(createMemoryAdapter());
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const before = await store.getExercise("seed-barbell-squat");
  const entry = { id: "e1", workoutId: "w1", exerciseId: "seed-barbell-squat", order: 0 };
  const sets = [0, 1, 2].map((order) => ({ id: `s${order}`, entryId: "e1", order, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, completedAt: at(DAY) }));
  await store.saveWorkoutWithDetails({ id: "w1", startedAt: at(DAY + 60000), endedAt: at(DAY - 60000) }, [entry], sets);
  const status = await createLogger(store, { now: () => new Date(NOW) }).getMuscleStatus();
  assert.equal(status.values.hamstrings, roundToHalf(3 * SECONDARY_WEIGHTS["seed-barbell-squat"].hamstrings));
  assert.equal(status.values.adductors, roundToHalf(3 * SECONDARY_WEIGHTS["seed-barbell-squat"].adductors));
  assert.deepEqual(await store.getExercise("seed-barbell-squat"), before, "the stored seed is not rewritten");
});

test("weights: createExercise refuses a weight that is not 0.25, 0.5, 0.75 or 1, a weight for a muscle that is not secondary, and weights on a default exercise", () => {
  for (const bad of [{ triceps: 0.3 }, { triceps: "0.5" }, { triceps: 0 }, { triceps: 1.25 }, { triceps: null }, [], "x"]) {
    assert.throws(() => custom(bad), /secondaryWeights/, JSON.stringify(bad));
  }
  assert.throws(() => custom({ chest: 0.5 }), /only name secondary muscles/);
  assert.throws(() => createExercise({ ...SEED_EXERCISES[0], secondaryWeights: { triceps: 0.5 } }), /only stored on a custom exercise/);
  assert.equal("secondaryWeights" in custom(undefined), false, "absent stays absent");
});

async function freshBackup() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  return { store, backup: createBackup(adapter), logger: createLogger(store, { now: () => new Date(NOW) }) };
}

test("weights: a backup carries a custom exercise's weights, and importing it gives the same record back", async () => {
  const first = await freshBackup();
  await first.store.saveExercise(custom({ triceps: 0.75, front_delts: 0.25 }));
  await first.store.saveExercise(createExercise({ id: "old", name: "Old", primaryMuscles: ["biceps"], secondaryMuscles: ["forearms"], isCustom: true }));
  const text = await first.backup.exportToText({ now: new Date(NOW) });
  const second = await freshBackup();
  await second.backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual((await second.store.getExercise("my-press")).secondaryWeights, { triceps: 0.75, front_delts: 0.25 });
  assert.equal("secondaryWeights" in (await second.store.getExercise("old")), false);
  assert.equal(await second.backup.exportToText({ now: new Date(NOW) }), text);
});

test("weights: an old backup without weights imports (each secondary then counts 0.5), and a bad weight in a file is refused", async () => {
  const { store, backup } = await freshBackup();
  await store.saveExercise(custom({ triceps: 0.75 }));
  const doc = JSON.parse(await backup.exportToText({ now: new Date(NOW) }));
  const withWeights = (weights) => {
    const copy = structuredClone(doc);
    if (weights === undefined) delete copy.data.exercises[0].secondaryWeights;
    else copy.data.exercises[0].secondaryWeights = weights;
    return JSON.stringify(copy);
  };
  const target = await freshBackup();
  await target.backup.importFromText(withWeights(undefined), { confirmReplace: true });
  assert.equal("secondaryWeights" in (await target.store.getExercise("my-press")), false);
  for (const bad of [{ triceps: 0.3 }, { triceps: "0.75" }, { triceps: -1 }, { chest: 0.5 }, { triceps: 0.75, madeUp: 0.5 }, [0.5], null]) {
    await assert.rejects(target.backup.importFromText(withWeights(bad), { confirmReplace: true }), /secondaryWeights/, JSON.stringify(bad));
  }
  // a refused import leaves the data as it was
  assert.equal("secondaryWeights" in (await target.store.getExercise("my-press")), false);
});

test("weights: editing a custom exercise keeps its id and its history, sets the weights, and an edit without weights removes them", async () => {
  const { store, logger } = await freshBackup();
  const made = await logger.addCustomExercise({ name: "My press", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentTags: [], secondaryWeights: { triceps: 0.25 } });
  assert.deepEqual(made.secondaryWeights, { triceps: 0.25 });
  const entry = { id: "e1", workoutId: "w1", exerciseId: made.id, order: 0 };
  const set = { id: "s1", entryId: "e1", order: 0, reps: 5, weightValue: 50, weightUnit: "kg", isWarmup: false, completedAt: at(DAY) };
  await store.saveWorkoutWithDetails({ id: "w1", startedAt: at(DAY + 60000), endedAt: at(DAY - 60000) }, [entry], [set]);
  const edited = await logger.updateCustomExercise(made.id, { name: "My press", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "front_delts"], equipmentTags: [], secondaryWeights: { triceps: 1, front_delts: 0.75 } });
  assert.equal(edited.id, made.id);
  assert.deepEqual(edited.secondaryWeights, { triceps: 1, front_delts: 0.75 });
  assert.equal((await store.getWorkoutWithDetails("w1")).entries[0].exerciseId, made.id);
  const status = await logger.getMuscleStatus();
  assert.equal(status.values.triceps, 1);
  assert.equal(status.values.front_delts, 1, "0.75 rounds to 1");
  // a name-only edit through the old call shape (no weights) drops them, so every secondary counts 0.5 again
  const plain = await logger.updateCustomExercise(made.id, { name: "Renamed", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentTags: [] });
  assert.equal(plain.id, made.id);
  assert.equal("secondaryWeights" in plain, false);
  assert.equal((await logger.getMuscleStatus()).values.triceps, 0.5);
});
