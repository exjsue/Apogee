// Storage rule tests, shared by Node (memory adapter) and the browser page
// (IndexedDB adapter). This file does not import node:test. Each runner supplies:
//   ctx.assert          equal, deepEqual, ok, rejects(promise, pattern)
//   ctx.createAdapter() a fresh, not yet opened adapter over an empty database

import {
  SCHEMA_VERSION,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
} from "../src/domain/model.js";
import { createStore } from "../src/storage/store.js";

export const EXERCISE = createExercise({
  id: "ex-squat",
  name: "Squat",
  primaryMuscles: ["quads"],
  secondaryMuscles: ["glutes"],
  equipmentTags: ["barbell"],
  notes: "high bar",
});

const workout = (id, startedAt = "2026-10-22T10:00:00.000Z") => createWorkout({ id, startedAt });
const entry = (id, workoutId, order, exerciseId = EXERCISE.id) =>
  createWorkoutEntry({ id, workoutId, exerciseId, order });
const set = (id, entryId, order, reps = 5) =>
  createWorkSet({ id, entryId, order, reps, weightValue: 100, weightUnit: "kg" });

// A workout with `entryCount` entries of `setsPerEntry` sets each, already in order.
export function makeDetails(workoutId, entryCount = 2, setsPerEntry = 2) {
  const entries = [];
  const sets = [];
  for (let e = 0; e < entryCount; e++) {
    const en = entry(`${workoutId}-e${e}`, workoutId, e);
    entries.push(en);
    for (let s = 0; s < setsPerEntry; s++) sets.push(set(`${en.id}-s${s}`, en.id, s, 5 + s));
  }
  return { workout: workout(workoutId), entries, sets };
}

// What getWorkoutWithDetails should return for details that are already in order.
const nested = ({ workout: w, entries, sets }) => ({
  ...w,
  entries: entries.map((en) => ({ ...en, sets: sets.filter((s) => s.entryId === en.id) })),
});

const saveDetails = (store, d) => store.saveWorkoutWithDetails(d.workout, d.entries, d.sets);

// Counts straight from the adapter, bypassing the store, to look for stray records.
export const rawCounts = (adapter) =>
  adapter.transaction(["workouts", "entries", "sets"], "readonly", async (tx) => ({
    workouts: (await tx.getAll("workouts")).length,
    entries: (await tx.getAll("entries")).length,
    sets: (await tx.getAll("sets")).length,
  }));

const EMPTY = { workouts: 0, entries: 0, sets: 0 };

// Wraps an adapter so that put, delete and/or clear fails after the given
// number of successful calls. The wrapped adapter's own rollback must then undo the rest.
export function failAfter(adapter, { puts = Infinity, deletes = Infinity, clears = Infinity } = {}) {
  let putCount = 0;
  let deleteCount = 0;
  let clearCount = 0;
  return {
    open: () => adapter.open(),
    close: () => adapter.close(),
    transaction: (storeNames, mode, fn) => adapter.transaction(storeNames, mode, (tx) => fn({
      get: (...args) => tx.get(...args),
      getAll: (...args) => tx.getAll(...args),
      getAllByIndex: (...args) => tx.getAllByIndex(...args),
      put: (...args) => (putCount++ >= puts ? Promise.reject(new Error("injected failure")) : tx.put(...args)),
      delete: (...args) => (deleteCount++ >= deletes ? Promise.reject(new Error("injected failure")) : tx.delete(...args)),
      clear: (...args) => (clearCount++ >= clears ? Promise.reject(new Error("injected failure")) : tx.clear(...args)),
    })),
  };
}

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

export const storeRules = [];
const rule = (name, run) => storeRules.push({ name, run });

// ---- schema version ----

rule("a new database records the schema version", async ({ assert, createAdapter }) => {
  const adapter = createAdapter();
  await createStore(adapter).open();
  const stored = await adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", "schemaVersion"));
  assert.deepEqual(stored, { key: "schemaVersion", value: SCHEMA_VERSION });
});

rule("a database with a newer schema version is rejected and left unchanged", async ({ assert, createAdapter }) => {
  const adapter = createAdapter();
  await adapter.open();
  await adapter.transaction(["meta"], "readwrite", (tx) =>
    tx.put("meta", { key: "schemaVersion", value: SCHEMA_VERSION + 1 }));
  await assert.rejects(createStore(adapter).open(), /newer version/);
  // open() closed the adapter on failure; reopen it and look at the stored version
  await adapter.open();
  const stored = await adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", "schemaVersion"));
  assert.equal(stored.value, SCHEMA_VERSION + 1);
});

// ---- round trips ----

rule("exercise: round trip", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  assert.equal(await store.getExercise(EXERCISE.id), null);
  const saved = await store.saveExercise({ ...EXERCISE, isCustom: true });
  assert.equal(saved.isCustom, true);
  assert.deepEqual(await store.getExercise(EXERCISE.id), saved);
});

rule("workout: round trip", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  assert.equal(await store.getWorkout("w1"), null);
  const saved = await store.saveWorkout({
    id: "w1", startedAt: "2026-10-22T12:00:00+02:00", endedAt: "2026-10-22T11:00:00Z", notes: "leg day",
  });
  assert.equal(saved.startedAt, "2026-10-22T10:00:00.000Z");
  assert.deepEqual(await store.getWorkout("w1"), saved);
});

rule("entry: round trip", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  await store.saveWorkout(workout("w1"));
  assert.equal(await store.getEntry("e1"), null);
  const saved = await store.saveEntry({ id: "e1", workoutId: "w1", exerciseId: EXERCISE.id, order: 0, supersetGroup: "A", notes: "x" });
  assert.deepEqual(await store.getEntry("e1"), saved);
});

rule("set: round trip", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  await store.saveWorkout(workout("w1"));
  await store.saveEntry(entry("e1", "w1", 0));
  assert.equal(await store.getSet("s1"), null);
  const saved = await store.saveSet({
    id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 62.5, weightUnit: "lb",
    isWarmup: true, restSeconds: 90, completedAt: "2026-10-22T10:05:00Z",
  });
  assert.equal(saved.weightValue, 62.5);
  assert.equal(saved.weightUnit, "lb");
  assert.deepEqual(await store.getSet("s1"), saved);
});

rule("records come back as copies, not shared references", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  const first = await store.getExercise(EXERCISE.id);
  first.name = "Changed";
  first.primaryMuscles.push("calves");
  assert.deepEqual(await store.getExercise(EXERCISE.id), EXERCISE);
});

rule("data survives closing and reopening the database", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  await saveDetails(store, d);
  adapter.close();
  await adapter.open();
  assert.deepEqual(await store.getWorkoutWithDetails("w1"), nested(d));
  assert.deepEqual(await store.getExercise(EXERCISE.id), EXERCISE);
});

// ---- validation ----

rule("invalid records are rejected with the field named, and nothing is saved", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await store.saveWorkout(workout("w1"));
  await store.saveEntry(entry("e1", "w1", 0));
  await assert.rejects(store.saveExercise({ ...EXERCISE, id: "bad", name: "" }), /name/);
  await assert.rejects(store.saveWorkout({ id: "bad", startedAt: "yesterday" }), /startedAt/);
  await assert.rejects(store.saveEntry({ id: "bad", workoutId: "w1", exerciseId: EXERCISE.id, order: -1 }), /order/);
  const setInput = { id: "bad", entryId: "e1", order: 0, reps: 5, weightValue: 100, weightUnit: "kg" };
  await assert.rejects(store.saveSet({ ...setInput, reps: 0 }), /reps/);
  await assert.rejects(store.saveSet({ ...setInput, weightUnit: "LB" }), /weightUnit/);
  await assert.rejects(store.saveSet({ ...setInput, weightValue: -1 }), /weightValue/);
  assert.equal(await store.getExercise("bad"), null);
  assert.equal(await store.getWorkout("bad"), null);
  assert.equal((await rawCounts(adapter)).sets, 0);
  assert.equal((await rawCounts(adapter)).entries, 1);
});

// ---- referential checks ----

rule("saveEntry rejects a workout that does not exist", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await assert.rejects(store.saveEntry(entry("e1", "no-such-workout", 0)), /workoutId/);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
});

rule("saveEntry rejects an exercise that does not exist", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await store.saveWorkout(workout("w1"));
  await assert.rejects(store.saveEntry(entry("e1", "w1", 0, "no-such-exercise")), /exerciseId/);
  assert.equal((await rawCounts(adapter)).entries, 0);
});

rule("saveSet rejects an entry that does not exist", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await assert.rejects(store.saveSet(set("s1", "no-such-entry", 0)), /entryId/);
  assert.equal((await rawCounts(adapter)).sets, 0);
});

rule("saveWorkoutWithDetails rejects an exercise that does not exist, saving nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  d.entries[1] = entry("w1-e1", "w1", 1, "no-such-exercise");
  await assert.rejects(saveDetails(store, d), /entries\[1\]\.exerciseId/);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
});

rule("saveWorkoutWithDetails rejects an entry that belongs to another workout", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  d.entries[0] = entry("w1-e0", "other-workout", 0);
  await assert.rejects(saveDetails(store, d), /entries\[0\]\.workoutId/);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
});

rule("saveWorkoutWithDetails rejects a set whose entry is not being saved", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  d.sets[0] = set("w1-e0-s0", "no-such-entry", 0);
  await assert.rejects(saveDetails(store, d), /sets\[0\]\.entryId/);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
});

rule("saveWorkoutWithDetails rejects duplicate ids and invalid records, saving nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  await assert.rejects(store.saveWorkoutWithDetails(d.workout, [d.entries[0], d.entries[0]], []), /duplicate/);
  await assert.rejects(
    store.saveWorkoutWithDetails(d.workout, d.entries, [{ ...d.sets[0], reps: 0 }]),
    /sets\[0\]: reps/,
  );
  assert.deepEqual(await rawCounts(adapter), EMPTY);
});

// ---- queries and ordering ----

rule("listWorkouts returns the newest first by startedAt", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openStore(ctx);
  assert.deepEqual(await store.listWorkouts(), []);
  await store.saveWorkout(workout("w-old", "2026-01-01T09:00:00Z"));
  await store.saveWorkout(workout("w-new", "2026-10-22T09:00:00Z"));
  await store.saveWorkout(workout("w-mid", "2026-06-01T09:00:00Z"));
  // 23:00 UTC on Nov 30, written with an offset: only newest if normalized to UTC first
  await store.saveWorkout(workout("w-offset", "2026-12-01T01:00:00+02:00"));
  const list = await store.listWorkouts();
  assert.deepEqual(list.map((w) => w.id), ["w-offset", "w-new", "w-mid", "w-old"]);
});

rule("getWorkoutWithDetails returns entries and sets in order", async (ctx) => {
  const { assert } = ctx;
  const { store } = await openSeeded(ctx);
  assert.equal(await store.getWorkoutWithDetails("w1"), null);
  const entries = [entry("a", "w1", 2), entry("b", "w1", 0), entry("c", "w1", 1)];
  const sets = [
    set("b-2", "b", 2), set("a-0", "a", 0), set("b-0", "b", 0), set("b-1", "b", 1), set("c-0", "c", 0),
  ];
  await store.saveWorkoutWithDetails(workout("w1"), entries, sets);
  await saveDetails(store, makeDetails("w2")); // must not leak into w1
  const result = await store.getWorkoutWithDetails("w1");
  assert.deepEqual(result.entries.map((e) => e.id), ["b", "c", "a"]);
  assert.deepEqual(result.entries[0].sets.map((s) => s.id), ["b-0", "b-1", "b-2"]);
  assert.deepEqual(result.entries[1].sets.map((s) => s.id), ["c-0"]);
  assert.deepEqual(result.entries[2].sets.map((s) => s.id), ["a-0"]);
  assert.equal(result.id, "w1");
});

rule("a workout with 50 sets saves and reads back completely", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("big", 5, 10);
  assert.equal(d.sets.length, 50);
  await saveDetails(store, d);
  assert.deepEqual(await store.getWorkoutWithDetails("big"), nested(d));
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 5, sets: 50 });
});

// ---- overwrite, replace, delete ----

rule("saving a set again overwrites it by id", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1");
  await saveDetails(store, d);
  const updated = await store.saveSet({ ...d.sets[0], reps: 12, weightValue: 62.5, weightUnit: "lb" });
  assert.deepEqual(await store.getSet(d.sets[0].id), updated);
  assert.equal((await store.getSet(d.sets[0].id)).reps, 12);
  assert.equal((await rawCounts(adapter)).sets, d.sets.length);
});

rule("saveWorkoutWithDetails replaces the workout's earlier entries and sets", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  await saveDetails(store, makeDetails("other")); // must be untouched
  await saveDetails(store, makeDetails("w1", 2, 3));
  const second = makeDetails("w1", 1, 2); // only the first entry and two of its sets
  await saveDetails(store, second);
  assert.deepEqual(await store.getWorkoutWithDetails("w1"), nested(second));
  assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2 + 1, sets: 4 + 2 });
});

rule("deleteWorkout leaves no orphan entries or sets", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const keep = makeDetails("keep", 1, 2);
  await saveDetails(store, makeDetails("gone", 2, 3));
  await saveDetails(store, keep);
  assert.equal(await store.deleteWorkout("gone"), true);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  assert.equal(await store.getWorkoutWithDetails("gone"), null);
  assert.deepEqual(await store.getWorkoutWithDetails("keep"), nested(keep));
  assert.deepEqual(await store.getExercise(EXERCISE.id), EXERCISE);
  assert.equal(await store.deleteWorkout("gone"), false);
});

// ---- rollback ----

rule("a failed save leaves nothing partially saved, even after reopening", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1", 2, 2);
  const totalPuts = 1 + d.entries.length + d.sets.length;
  for (let succeed = 0; succeed < totalPuts; succeed++) {
    const failing = createStore(failAfter(adapter, { puts: succeed }));
    await assert.rejects(saveDetails(failing, d), /injected failure/);
    assert.deepEqual(await rawCounts(adapter), EMPTY);
  }
  adapter.close();
  await adapter.open();
  assert.deepEqual(await rawCounts(adapter), EMPTY);
  assert.deepEqual(await store.listWorkouts(), []);
  await saveDetails(store, d); // the same save works once the fault is gone
  assert.deepEqual(await store.getWorkoutWithDetails("w1"), nested(d));
});

rule("a failed replace leaves the earlier version fully intact", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const before = makeDetails("w1", 2, 3);
  await saveDetails(store, before);
  const after = makeDetails("w1", 1, 1); // would delete most of `before` first
  const failing = createStore(failAfter(adapter, { puts: 1 }));
  await assert.rejects(saveDetails(failing, after), /injected failure/);
  assert.deepEqual(await store.getWorkoutWithDetails("w1"), nested(before));
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 6 });
});

rule("a failed deleteWorkout deletes nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await openSeeded(ctx);
  const d = makeDetails("w1", 2, 2); // 4 sets + 2 entries + 1 workout = 7 deletes
  await saveDetails(store, d);
  for (const succeed of [0, 2, 6]) {
    const failing = createStore(failAfter(adapter, { deletes: succeed }));
    await assert.rejects(failing.deleteWorkout("w1"), /injected failure/);
    assert.deepEqual(await store.getWorkoutWithDetails("w1"), nested(d));
  }
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 4 });
});
