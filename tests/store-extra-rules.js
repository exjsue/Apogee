// Store rules added with the first screen: exercise listing, seeding,
// settings in meta, deleteSet, discardWorkout and workout summaries. Shared by
// Node and the browser page; no node:test import (ctx.assert and
// ctx.createAdapter are supplied by the runner).

import { createExercise, createWorkout } from "../src/domain/model.js";
import { createStore } from "../src/storage/store.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { EXERCISE, makeDetails, rawCounts, failAfter } from "./store-rules.js";

export const storeExtraRules = [];
const rule = (name, run) => storeExtraRules.push({ name, run });

async function openStore(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  return { adapter, store };
}

async function openSeeded(ctx) {
  const opened = await openStore(ctx);
  await opened.store.saveExercise(EXERCISE);
  return opened;
}

const rawMeta = (adapter, key) => adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", key));
const exerciseCount = async (adapter) =>
  (await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"))).length;
const saveDetails = (store, d) => store.saveWorkoutWithDetails(d.workout, d.entries, d.sets);

// ---- listExercises ----

rule("listExercises returns every exercise alphabetically by name", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  assert.deepEqual(await store.listExercises(), []);
  for (const name of ["Charlie", "Alpha", "Bravo"]) {
    await store.saveExercise(createExercise({ id: `ex-${name}`, name, primaryMuscles: ["abs"] }));
  }
  assert.deepEqual((await store.listExercises()).map((exercise) => exercise.name), ["Alpha", "Bravo", "Charlie"]);
});

// ---- seeding ----

rule("seed: the first run adds every seed and records the seed version", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  const result = await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  assert.deepEqual(result, { added: SEED_EXERCISES.length, skipped: false });
  assert.equal((await store.listExercises()).length, SEED_EXERCISES.length);
  assert.deepEqual(await store.getExercise("seed-barbell-bench-press"), SEED_EXERCISES[0]);
  assert.deepEqual(await rawMeta(adapter, "seedVersion"), { key: "seedVersion", value: SEED_VERSION });
});

rule("seed: running it again at the same version changes nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const before = await store.listExercises();
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, SEED_VERSION), { added: 0, skipped: true });
  assert.deepEqual(await store.listExercises(), before);
  assert.equal(await exerciseCount(adapter), SEED_EXERCISES.length);
});

rule("seed: a higher version adds only missing ids and never overwrites", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  await store.seedExercises(SEED_EXERCISES, 1);
  const edited = await store.saveExercise({ ...SEED_EXERCISES[0], notes: "my own note" });
  // one seed goes missing, as if it had never been added
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", SEED_EXERCISES[1].id));
  const newcomer = createExercise({ id: "seed-new-lift", name: "New lift", primaryMuscles: ["abs"] });
  const changedSeed = { ...SEED_EXERCISES[0], name: "Renamed in the new list", notes: "from the code" };

  const result = await store.seedExercises([changedSeed, ...SEED_EXERCISES.slice(1), newcomer], 2);
  assert.deepEqual(result, { added: 2, skipped: false }); // the missing one and the newcomer
  assert.deepEqual(await store.getExercise(SEED_EXERCISES[0].id), edited); // untouched
  assert.deepEqual(await store.getExercise(SEED_EXERCISES[1].id), SEED_EXERCISES[1]); // restored
  assert.deepEqual(await store.getExercise("seed-new-lift"), newcomer);
  assert.deepEqual(await rawMeta(adapter, "seedVersion"), { key: "seedVersion", value: 2 });
});

rule("seed: a stored version at or above the requested one skips seeding", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: "seedVersion", value: 5 }));
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, 2), { added: 0, skipped: true });
  assert.equal(await exerciseCount(adapter), 0);
});

rule("seed: an invalid version or list writes nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  await assert.rejects(store.seedExercises(SEED_EXERCISES, 0), /version/);
  await assert.rejects(store.seedExercises(SEED_EXERCISES, 1.5), /version/);
  await assert.rejects(store.seedExercises([{ ...SEED_EXERCISES[0], primaryMuscles: [] }], 1), /primaryMuscles/);
  await assert.rejects(store.seedExercises([SEED_EXERCISES[0], SEED_EXERCISES[0]], 1), /duplicate/);
  await assert.rejects(store.seedExercises("nope", 1), /seed exercises/);
  assert.equal(await exerciseCount(adapter), 0);
  assert.equal(await rawMeta(adapter, "seedVersion"), undefined);
});

rule("seed: a failure part-way leaves no seeds and no version", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  const failing = createStore(failAfter(adapter, { puts: 3 }));
  await assert.rejects(failing.seedExercises(SEED_EXERCISES, 1), /injected failure/);
  assert.equal(await exerciseCount(adapter), 0);
  assert.equal(await rawMeta(adapter, "seedVersion"), undefined);
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, 1), { added: SEED_EXERCISES.length, skipped: false });
});

// ---- settings in meta ----

rule("preferred unit defaults to lb, can be set to kg, and survives reopening", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  assert.equal(await store.getPreferredUnit(), "lb");
  assert.equal(await store.setPreferredUnit("kg"), "kg");
  assert.equal(await store.getPreferredUnit(), "kg");
  adapter.close();
  await adapter.open();
  assert.equal(await store.getPreferredUnit(), "kg");
  await store.setPreferredUnit("lb");
  assert.equal(await store.getPreferredUnit(), "lb");
});

rule("persistence status: none until stored, then the latest one replaces the last", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openStore(ctx);
  assert.equal(await store.getPersistStatus(), null);
  await store.setPersistStatus({ supported: true, persisted: false, error: null, checkedAt: "2026-10-23T08:00:00.000Z" });
  await store.setPersistStatus({ supported: true, persisted: true, error: null, checkedAt: "2026-10-24T08:00:00.000Z" });
  adapter.close();
  await adapter.open();
  assert.deepEqual(await store.getPersistStatus(), {
    supported: true, persisted: true, error: null, checkedAt: "2026-10-24T08:00:00.000Z",
  });
});

rule("persistence status: refuses malformed values and keeps the stored one", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  const good = { supported: true, persisted: false, error: null, checkedAt: "2026-10-23T08:00:00.000Z" };
  await store.setPersistStatus(good);
  await assert.rejects(store.setPersistStatus({ ...good, persisted: "yes" }), /booleans/);
  await assert.rejects(store.setPersistStatus({ ...good, supported: undefined }), /booleans/);
  await assert.rejects(store.setPersistStatus({ ...good, checkedAt: "soon" }), /valid date/);
  assert.deepEqual(await store.getPersistStatus(), good);
});

rule("preferred unit rejects anything but kg and lb", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  for (const bad of ["KG", "lbs", "", undefined, null, 5]) {
    await assert.rejects(store.setPreferredUnit(bad), /unit must be/);
  }
  assert.equal(await store.getPreferredUnit(), "lb");
});

rule("the continued workout id can be set and cleared", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  assert.equal(await store.getContinuedWorkoutId(), null);
  await store.setContinuedWorkoutId("w1");
  assert.equal(await store.getContinuedWorkoutId(), "w1");
  await store.setContinuedWorkoutId(null);
  assert.equal(await store.getContinuedWorkoutId(), null);
  await assert.rejects(store.setContinuedWorkoutId(""), /id/);
});

// ---- deleteSet ----

rule("deleteSet removes one set and keeps the rest of the entry", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1", 2, 3);
  await saveDetails(store, d);
  assert.equal(await store.deleteSet("w1-e0-s1"), true);
  assert.equal(await store.getSet("w1-e0-s1"), null);
  const detail = await store.getWorkoutWithDetails("w1");
  assert.deepEqual(detail.entries[0].sets.map((set) => set.id), ["w1-e0-s0", "w1-e0-s2"]);
  assert.equal(detail.entries.length, 2);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 5 });
});

rule("deleteSet on the last set of an entry removes the entry too, leaving no orphan", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1", 2, 1);
  await saveDetails(store, d);
  assert.equal(await store.deleteSet("w1-e0-s0"), true);
  assert.equal(await store.getEntry("w1-e0"), null);
  assert.deepEqual((await store.getWorkoutWithDetails("w1")).entries.map((entry) => entry.id), ["w1-e1"]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  // deleting the very last set leaves a workout with no entries, and nothing stray
  assert.equal(await store.deleteSet("w1-e1-s0"), true);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 0, sets: 0 });
});

rule("deleteSet on an unknown id deletes nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, makeDetails("w1", 1, 2));
  assert.equal(await store.deleteSet("no-such-set"), false);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  await assert.rejects(store.deleteSet(""), /id/);
});

rule("a failed deleteSet is rolled back: the set and its entry stay", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, makeDetails("w1", 1, 1));
  const failing = createStore(failAfter(adapter, { deletes: 1 })); // the set goes, the entry delete fails
  await assert.rejects(failing.deleteSet("w1-e0-s0"), /injected failure/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
});

// ---- discardWorkout ----

rule("discardWorkout removes an unfinished workout with its entries and sets", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, makeDetails("keep", 1, 1)); // helper workouts are unfinished too
  await saveDetails(store, makeDetails("gone", 2, 3));
  assert.equal(await store.discardWorkout("gone"), true);
  assert.equal(await store.getWorkoutWithDetails("gone"), null);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.equal(await store.getExercise(EXERCISE.id) !== null, true);
  assert.equal(await store.discardWorkout("gone"), false);
});

rule("discardWorkout refuses a finished workout and leaves it untouched", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1", 1, 2);
  await store.saveWorkoutWithDetails(
    createWorkout({ ...d.workout, endedAt: "2026-10-22T11:00:00.000Z" }),
    d.entries,
    d.sets,
  );
  await assert.rejects(store.discardWorkout("w1"), /finished workout cannot be discarded/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  assert.equal(await store.deleteWorkout("w1"), true); // the deliberate path still works
});

rule("a failed discardWorkout is rolled back", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, makeDetails("w1", 2, 2));
  for (const succeed of [0, 3, 6]) {
    const failing = createStore(failAfter(adapter, { deletes: succeed }));
    await assert.rejects(failing.discardWorkout("w1"), /injected failure/);
    assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 4 });
  }
});

// ---- summaries ----

rule("listWorkoutSummaries returns entry and set counts, newest first", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  assert.deepEqual(await store.listWorkoutSummaries(), []);
  const older = makeDetails("older", 2, 3);
  const newer = makeDetails("newer", 1, 2);
  await store.saveWorkoutWithDetails({ ...older.workout, startedAt: "2026-01-01T10:00:00.000Z" }, older.entries, older.sets);
  await store.saveWorkoutWithDetails({ ...newer.workout, startedAt: "2026-06-01T10:00:00.000Z" }, newer.entries, newer.sets);
  await store.saveWorkout({ id: "empty", startedAt: "2026-03-01T10:00:00.000Z" });
  const summaries = await store.listWorkoutSummaries();
  assert.deepEqual(summaries.map((s) => [s.id, s.entryCount, s.setCount]), [
    ["newer", 1, 2],
    ["empty", 0, 0],
    ["older", 2, 6],
  ]);
  assert.equal(summaries[0].startedAt, "2026-06-01T10:00:00.000Z");
});

// ---- finished set records (the input of src/domain/strength.js) ----

const ENDED = "2026-10-22T11:00:00.000Z";
const finishedDetails = (id, entryCount, setsPerEntry) => {
  const d = makeDetails(id, entryCount, setsPerEntry);
  return { ...d, workout: { ...d.workout, endedAt: ENDED } };
};
// What listFinishedSetRecords should return for one stored set.
const recordOf = (set, workoutId, exerciseId) => ({
  id: set.id, workoutId, exerciseId, order: set.order, reps: set.reps, weightValue: set.weightValue,
  weightUnit: set.weightUnit, isWarmup: set.isWarmup, completedAt: set.completedAt,
});
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const rawEverything = (adapter) =>
  adapter.transaction(["workouts", "entries", "sets", "exercises", "templates", "meta"], "readonly", async (tx) => ({
    workouts: await tx.getAll("workouts"),
    entries: await tx.getAll("entries"),
    sets: await tx.getAll("sets"),
    exercises: await tx.getAll("exercises"),
    templates: await tx.getAll("templates"),
    meta: await tx.getAll("meta"),
  }));

rule("listFinishedSetRecords returns only the sets of finished workouts; an unfinished workout's sets are left out", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  assert.deepEqual(await store.listFinishedSetRecords(), []);
  const done = finishedDetails("done", 1, 2);
  await saveDetails(store, done);
  await saveDetails(store, makeDetails("open", 1, 3));
  const records = (await store.listFinishedSetRecords()).sort(byId);
  assert.deepEqual(records.map((r) => r.id), ["done-e0-s0", "done-e0-s1"]);
  assert.deepEqual(records, done.sets.map((s) => recordOf(s, "done", EXERCISE.id)));
});

rule("listFinishedSetRecords joins workoutId and exerciseId from each set's entry, across workouts and exercises", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  await store.saveExercise(createExercise({ id: "ex-bench", name: "Bench", primaryMuscles: ["chest"] }));
  const one = finishedDetails("w1", 2, 2);
  one.entries[1] = { ...one.entries[1], exerciseId: "ex-bench" };
  const two = finishedDetails("w2", 1, 1);
  two.entries[0] = { ...two.entries[0], exerciseId: "ex-bench" };
  await saveDetails(store, one);
  await saveDetails(store, two);
  const records = (await store.listFinishedSetRecords()).sort(byId);
  assert.deepEqual(records.map((r) => [r.id, r.workoutId, r.exerciseId]), [
    ["w1-e0-s0", "w1", EXERCISE.id],
    ["w1-e0-s1", "w1", EXERCISE.id],
    ["w1-e1-s0", "w1", "ex-bench"],
    ["w1-e1-s1", "w1", "ex-bench"],
    ["w2-e0-s0", "w2", "ex-bench"],
  ]);
  assert.deepEqual(records[2], recordOf(one.sets[2], "w1", "ex-bench"));
});

rule("listFinishedSetRecords still returns a set whose exercise is a hidden (retired) custom exercise", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  await store.saveExercise(createExercise({ id: "c-mine", name: "My Fly", primaryMuscles: ["chest"], isCustom: true, retired: true }));
  const d = finishedDetails("w", 1, 1);
  d.entries[0] = { ...d.entries[0], exerciseId: "c-mine" };
  await saveDetails(store, d);
  assert.deepEqual(await store.listFinishedSetRecords(), [recordOf(d.sets[0], "w", "c-mine")]);
});

rule("listFinishedSetRecords skips a set whose entry is missing and a set whose entry's workout is missing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = finishedDetails("w", 1, 1);
  await saveDetails(store, d);
  const loose = { order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: ENDED };
  await adapter.transaction(["entries", "sets"], "readwrite", async (tx) => {
    await tx.put("sets", { ...loose, id: "no-entry-set", entryId: "no-such-entry" });
    await tx.put("entries", { id: "orphan-entry", workoutId: "no-such-workout", exerciseId: EXERCISE.id, order: 0 });
    await tx.put("sets", { ...loose, id: "no-workout-set", entryId: "orphan-entry" });
  });
  assert.deepEqual(await store.listFinishedSetRecords(), [recordOf(d.sets[0], "w", EXERCISE.id)]);
});

rule("listFinishedSetRecords gives the same result when called again", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  await saveDetails(store, finishedDetails("a", 2, 2));
  await saveDetails(store, finishedDetails("b", 1, 3));
  const first = await store.listFinishedSetRecords();
  assert.equal(first.length, 7);
  assert.deepEqual(await store.listFinishedSetRecords(), first);
});

rule("listFinishedSetRecords writes nothing: every store is identical before and after", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, finishedDetails("done", 2, 2));
  await saveDetails(store, makeDetails("open", 1, 1));
  await store.setPreferredUnit("kg");
  const before = await rawEverything(adapter);
  const records = await store.listFinishedSetRecords();
  records[0].weightValue = 999; // changing a returned record must not reach the store
  assert.deepEqual(await rawEverything(adapter), before);
});
