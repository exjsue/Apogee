// Removing (delete or hide), editing and restoring the user's own exercises. A hidden exercise is a custom
// exercise with retired: true (schema 4, no new field). Shared by Node (memory adapter) and the browser page
// (IndexedDB adapter). No node:test import: each runner supplies
//   ctx.assert          equal, deepEqual, ok, rejects(promise, pattern)
//   ctx.createAdapter() a fresh, not yet opened adapter over an empty database
// Expected values are written out by hand; none is computed with the code under test.

import { createExercise } from "../src/domain/model.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup } from "../src/backup/backup.js";
import { createCatalogStore } from "../src/storage/catalog-store.js";
import { CATALOG } from "../src/catalog/catalog.js";
import { CATALOG_VERSION } from "../src/catalog/catalog-info.js";
import { WORKOUT_META_KEYS, CATALOG_VERSION_META_KEY } from "../src/storage/schema.js";
import { EXERCISE, makeDetails } from "./store-rules.js";
import { NOW } from "./backup-rules.js";

export const customExerciseRules = [];
const rule = (name, run) => customExerciseRules.push({ name, run });

const MINE = createExercise({
  id: "c-fly", name: "Cable Fly", primaryMuscles: ["chest"], secondaryMuscles: ["front_delts"],
  equipmentTags: ["cable"], notes: "slow", isCustom: true, defaultRestSeconds: 90,
});
const OTHER = createExercise({ id: "c-curl", name: "Rope Curl", primaryMuscles: ["biceps"], isCustom: true });

async function open(ctx, { at = "2026-10-22T12:00:00.000Z" } = {}) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.saveExercise(EXERCISE);
  await store.saveExercise(MINE);
  await store.saveExercise(OTHER);
  const logger = createLogger(store, { now: () => new Date(at) });
  return { adapter, store, logger, backup: createBackup(adapter) };
}

const rawExercise = (adapter, id) => adapter.transaction(["exercises"], "readonly", (tx) => tx.get("exercises", id));
const rawMeta = (adapter, key) => adapter.transaction(["meta"], "readonly", async (tx) => (await tx.get("meta", key))?.value);
const putMeta = (adapter, key, value) => adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key, value }));
const rawAll = (adapter) => adapter.transaction(["workouts", "entries", "sets", "templates"], "readonly", async (tx) => ({
  workouts: await tx.getAll("workouts"),
  entries: await tx.getAll("entries"),
  sets: await tx.getAll("sets"),
  templates: await tx.getAll("templates"),
}));

// A workout whose first entry is the custom exercise; finished unless `endedAt` is null.
async function workoutWith(store, id, exerciseId, { startedAt = "2026-10-22T10:00:00.000Z", endedAt = "2026-10-22T11:00:00.000Z" } = {}) {
  const d = makeDetails(id, 1, 2);
  const entries = d.entries.map((entry) => ({ ...entry, exerciseId }));
  const sets = d.sets.map((set) => ({ ...set, completedAt: startedAt }));
  await store.saveWorkoutWithDetails({ ...d.workout, startedAt, endedAt }, entries, sets);
}

// ---- schema 4 accepts a hidden custom exercise (checked first: everything else builds on it) ----

rule("custom exercises: a custom exercise with retired: true is valid and survives export and import unchanged (schema 4)", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  const hidden = { ...MINE, retired: true };
  assert.deepEqual(createExercise(hidden), hidden);
  await store.saveExercise(hidden);
  await workoutWith(store, "w1", MINE.id);
  await store.saveTemplate({ id: "t1", name: "Chest", exercises: [{ exerciseId: MINE.id, setCount: 3 }] });
  const text = await backup.exportToText({ now: NOW });
  const doc = JSON.parse(text);
  assert.equal(doc.schemaVersion, 5);
  assert.deepEqual(doc.data.exercises.find((exercise) => exercise.id === MINE.id).retired, true);
  await backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual(await rawExercise(adapter, MINE.id), hidden);
  assert.equal(await backup.exportToText({ now: NOW }), text);
});

// ---- delete: nothing refers to it ----

rule("custom exercises: an exercise nothing refers to is deleted for real, and the next export no longer lists it", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, backup } = await open(ctx);
  assert.deepEqual(await logger.getExerciseUsage(MINE.id), { workouts: 0, templates: 0, planned: false, catalogConflict: false, used: false });
  assert.equal(await logger.removeCustomExercise(MINE.id), "deleted");
  assert.equal(await rawExercise(adapter, MINE.id), undefined);
  assert.deepEqual(await rawExercise(adapter, OTHER.id), OTHER);
  assert.deepEqual(await rawExercise(adapter, EXERCISE.id), EXERCISE);
  const ids = JSON.parse(await backup.exportToText({ now: NOW })).data.exercises.map((exercise) => exercise.id);
  assert.deepEqual(ids, ["c-curl", "ex-squat"]);
  await assert.rejects(logger.removeCustomExercise(MINE.id), /That exercise no longer exists/);
  assert.equal(await store.getExercise(MINE.id), null);
});

// ---- hide: one test per place that can refer to an exercise (DECISIONS.md, 2026-10-26) ----

// Hiding sets retired: true and changes nothing else, anywhere.
async function expectHidden(ctx, { adapter, logger }, before) {
  const { assert } = ctx;
  assert.equal(await logger.removeCustomExercise(MINE.id), "hidden");
  assert.deepEqual(await rawExercise(adapter, MINE.id), { ...MINE, retired: true });
  assert.deepEqual(await rawAll(adapter), before);
}

rule("custom exercises: used by an entry of a finished workout: hidden, history byte for byte unchanged, the name still resolves", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id);
  assert.deepEqual(await env.logger.getExerciseUsage(MINE.id), { workouts: 1, templates: 0, planned: false, catalogConflict: false, used: true });
  await expectHidden(ctx, env, await rawAll(env.adapter));
  const detail = await env.logger.getWorkoutDetail("w1");
  assert.deepEqual(detail.entries.map((entry) => entry.exerciseName), ["Cable Fly"]);
  assert.deepEqual((await env.logger.getHistory()).map((workout) => workout.id), ["w1"]);
});

rule("custom exercises: used by an entry of the open workout: hidden, and the Log tab still shows it", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id, { endedAt: null });
  assert.equal((await env.logger.getStatus()).kind, "active");
  await expectHidden(ctx, env, await rawAll(env.adapter));
  assert.deepEqual((await env.logger.getSession()).blocks.map((block) => block.exerciseName), ["Cable Fly"]);
});

rule("custom exercises: used by an entry of a stale (unfinished, old) workout: hidden", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id, { startedAt: "2026-10-20T10:00:00.000Z", endedAt: null });
  assert.equal((await env.logger.getStatus()).kind, "stale");
  await expectHidden(ctx, env, await rawAll(env.adapter));
});

rule("custom exercises: used only by a template: hidden, the template still starts, and export then import keeps both", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await env.store.saveTemplate({ id: "t1", name: "Chest", exercises: [{ exerciseId: MINE.id, setCount: 2 }] });
  assert.deepEqual(await env.logger.getExerciseUsage(MINE.id), { workouts: 0, templates: 1, planned: false, catalogConflict: false, used: true });
  await expectHidden(ctx, env, await rawAll(env.adapter));
  const text = await env.backup.exportToText({ now: NOW });
  await env.backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual(await rawExercise(env.adapter, MINE.id), { ...MINE, retired: true });
  assert.deepEqual(await env.store.getTemplate("t1"), { id: "t1", name: "Chest", exercises: [{ exerciseId: MINE.id, setCount: 2 }] });
  await env.logger.startFromTemplate("t1");
  const session = await env.logger.getSession();
  assert.deepEqual(session.blocks.map((block) => [block.exerciseName, block.rows.length]), [["Cable Fly", 2]]);
});

rule("custom exercises: used only by a planned (unchecked) row in meta: hidden, and the row stays", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const row = await env.logger.addSet(MINE.id);
  assert.deepEqual(await env.logger.getExerciseUsage(MINE.id), { workouts: 0, templates: 0, planned: true, catalogConflict: false, used: true });
  await expectHidden(ctx, env, await rawAll(env.adapter));
  assert.deepEqual((await rawMeta(env.adapter, WORKOUT_META_KEYS.plan)).rows.map((planned) => planned.id), [row.id]);
  assert.equal((await env.logger.getSession()).plannedCount, 1);
});

rule("custom exercises: listed only in the plan's exercises (no row): hidden", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await putMeta(env.adapter, WORKOUT_META_KEYS.plan, { exercises: [MINE.id], rows: [], rev: 3 });
  assert.equal((await env.logger.getExerciseUsage(MINE.id)).planned, true);
  await expectHidden(ctx, env, await rawAll(env.adapter));
  assert.deepEqual(await rawMeta(env.adapter, WORKOUT_META_KEYS.plan), { exercises: [MINE.id], rows: [], rev: 3 });
});

rule("custom exercises: named in the catalog flag's conflicts in meta: hidden, and the flag is unchanged", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const flag = { version: 1, conflicts: [MINE.id], stored: 0 };
  await putMeta(env.adapter, CATALOG_VERSION_META_KEY, flag);
  assert.equal((await env.logger.getExerciseUsage(MINE.id)).catalogConflict, true);
  await expectHidden(ctx, env, await rawAll(env.adapter));
  assert.deepEqual(await rawMeta(env.adapter, CATALOG_VERSION_META_KEY), flag);
});

// ---- the session and a delete ----

rule("custom exercises: a delete raises the plan's revision, so a session write prepared before it is refused and addSet then reports the exercise gone", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await env.logger.addSet(OTHER.id);
  const before = await rawMeta(env.adapter, WORKOUT_META_KEYS.plan);
  assert.equal(await env.logger.removeCustomExercise(MINE.id), "deleted");
  assert.deepEqual(await rawMeta(env.adapter, WORKOUT_META_KEYS.plan), { ...before, rev: before.rev + 1 });
  // what a concurrent addSet would write, based on the plan it read before the delete
  const stale = { exercises: [...before.exercises, MINE.id], rows: [...before.rows, { ...before.rows[0], id: "r-x", exerciseId: MINE.id }], rev: before.rev + 1 };
  await assert.rejects(env.store.setWorkoutMeta({ plan: stale }, { expectRev: before.rev }), /changed in another tab/);
  await assert.rejects(env.logger.addSet(MINE.id), /no exercise with id "c-fly"/);
  assert.deepEqual((await rawMeta(env.adapter, WORKOUT_META_KEYS.plan)).rows.map((row) => row.exerciseId), [OTHER.id]);
});

rule("custom exercises: with no plan stored, a delete writes an empty plan with revision 1, which counts as nothing planned or running", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await env.store.saveTemplate({ id: "t1", name: "Curls", exercises: [{ exerciseId: OTHER.id, setCount: 1 }] });
  assert.equal(await rawMeta(env.adapter, WORKOUT_META_KEYS.plan), undefined);
  assert.equal(await env.logger.removeCustomExercise(MINE.id), "deleted");
  assert.deepEqual(await rawMeta(env.adapter, WORKOUT_META_KEYS.plan), { exercises: [], rows: [], rev: 1 });
  const session = await env.logger.getSession();
  assert.deepEqual([session.status.kind, session.blocks, session.plannedCount, session.loggedCount, session.timer], ["none", [], 0, 0, null]);
  await env.logger.startFromTemplate("t1");
  const started = await env.logger.getSession();
  assert.deepEqual(started.blocks.map((block) => [block.exerciseName, block.rows.length]), [["Rope Curl", 1]]);
});

// ---- only the user's own exercises ----

rule("custom exercises: a built-in or catalog exercise, a missing id or a bad id is refused by remove, edit and restore, and nothing is written", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const catalogRecord = createExercise({ id: "Cat_1", name: "Catalog Row", primaryMuscles: ["lats"], origin: "upstream", upstreamId: "Cat_1", catalogVersion: 1, retired: true });
  await env.store.saveExercise(catalogRecord);
  const fields = { name: "New", primaryMuscles: ["abs"] };
  for (const id of [EXERCISE.id, catalogRecord.id]) {
    await assert.rejects(env.logger.removeCustomExercise(id), /Only your own exercises can be changed here/);
    await assert.rejects(env.logger.updateCustomExercise(id, fields), /Only your own exercises can be changed here/);
    await assert.rejects(env.logger.restoreCustomExercise(id), /Only your own exercises can be changed here/);
  }
  for (const call of [(id) => env.logger.removeCustomExercise(id), (id) => env.logger.updateCustomExercise(id, fields), (id) => env.logger.restoreCustomExercise(id)]) {
    await assert.rejects(call("missing"), /That exercise no longer exists/);
    await assert.rejects(call(""), /id must be a non-empty string/);
  }
  assert.deepEqual(await rawExercise(env.adapter, EXERCISE.id), EXERCISE);
  assert.deepEqual(await rawExercise(env.adapter, catalogRecord.id), catalogRecord);
  assert.equal(await rawMeta(env.adapter, WORKOUT_META_KEYS.plan), undefined);
});

// ---- a hidden exercise in the picker, search and history ----

rule("custom exercises: a hidden exercise is in no search, filter or Recent group, but stays in history and in the hidden list", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id);
  await env.logger.removeCustomExercise(MINE.id);
  const ids = (list) => list.map((exercise) => exercise.id);
  assert.deepEqual(ids(await env.logger.findExercises("")), ["c-curl", "ex-squat"]);
  assert.deepEqual(ids(await env.logger.findExercises("cable fly")), []);
  assert.deepEqual(ids(await env.logger.findExercises("", { muscle: "chest" })), []);
  assert.deepEqual(ids(await env.logger.findExercises("", { equipment: "cable" })), []);
  assert.deepEqual(ids(await env.logger.findRecentExercises()), []);
  assert.deepEqual((await env.logger.getWorkoutDetail("w1")).entries.map((entry) => entry.exerciseName), ["Cable Fly"]);
  assert.deepEqual(ids(await env.logger.listHiddenCustomExercises()), ["c-fly"]);
});

// ---- edit ----

rule("custom exercises: edit changes only the name, muscles and equipment tags; every other field and all history stay", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id);
  await env.store.saveTemplate({ id: "t1", name: "Chest", exercises: [{ exerciseId: MINE.id, setCount: 2 }] });
  const before = await rawAll(env.adapter);
  const saved = await env.logger.updateCustomExercise(MINE.id, {
    name: "  Low  Cable Fly ", primaryMuscles: ["chest", "neck"], secondaryMuscles: ["abductors"], equipmentTags: ["cable", "bench"],
  });
  const expected = { ...MINE, name: "Low Cable Fly", primaryMuscles: ["chest", "neck"], secondaryMuscles: ["abductors"], equipmentTags: ["cable", "bench"] };
  assert.deepEqual(saved, expected);
  assert.deepEqual(await rawExercise(env.adapter, MINE.id), expected);
  assert.deepEqual(await rawAll(env.adapter), before);
  assert.deepEqual(await rawExercise(env.adapter, OTHER.id), OTHER);
  assert.deepEqual((await env.logger.getWorkoutDetail("w1")).entries.map((entry) => entry.exerciseName), ["Low Cable Fly"]);
  // an invalid edit writes nothing
  await assert.rejects(env.logger.updateCustomExercise(MINE.id, { name: "X", primaryMuscles: [] }), /primaryMuscles must contain at least one muscle/);
  assert.deepEqual(await rawExercise(env.adapter, MINE.id), expected);
});

rule("custom exercises: names: another exercise's name is refused (code name-taken), its own name in other case is allowed, a hidden one's name carries hiddenExerciseId", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const muscles = { primaryMuscles: ["chest"] };
  // [message, code, hiddenExerciseId] of the error a call rejects with (the browser harness's rejects takes a pattern only)
  const taken = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return [error.message, error.code, error.hiddenExerciseId];
    }
    return "resolved";
  };
  const TAKEN = "name: an exercise with this name already exists";
  assert.deepEqual(await taken(env.logger.updateCustomExercise(MINE.id, { ...muscles, name: "rope CURL" })), [TAKEN, "name-taken", undefined]);
  assert.deepEqual(await taken(env.logger.updateCustomExercise(MINE.id, { ...muscles, name: "SQUAT" })), [TAKEN, "name-taken", undefined]);
  assert.equal((await env.logger.updateCustomExercise(MINE.id, { ...muscles, name: "CABLE fly" })).name, "CABLE fly");
  await workoutWith(env.store, "w1", OTHER.id);
  assert.equal(await env.logger.removeCustomExercise(OTHER.id), "hidden");
  assert.deepEqual(await taken(env.logger.updateCustomExercise(MINE.id, { ...muscles, name: "Rope Curl" })), [TAKEN, "name-taken", OTHER.id]);
  assert.deepEqual(await taken(env.logger.addCustomExercise({ ...muscles, name: " rope   curl" })), [TAKEN, "name-taken", OTHER.id]);
  assert.deepEqual(await taken(env.logger.addCustomExercise({ ...muscles, name: "Squat" })), [TAKEN, "name-taken", undefined]);
  assert.deepEqual((await env.store.listExercises()).map((exercise) => exercise.name), ["CABLE fly", "Rope Curl", "Squat"]);
});

rule("custom exercises: an exercise deleted or hidden meanwhile cannot be edited, and an edit never brings it back", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const fields = { name: "Again", primaryMuscles: ["chest"] };
  await env.logger.removeCustomExercise(MINE.id);
  await assert.rejects(env.logger.updateCustomExercise(MINE.id, fields), /That exercise no longer exists/);
  assert.equal(await rawExercise(env.adapter, MINE.id), undefined);
  await workoutWith(env.store, "w1", OTHER.id);
  await env.logger.removeCustomExercise(OTHER.id);
  await assert.rejects(env.logger.updateCustomExercise(OTHER.id, fields), /This exercise is hidden/);
  assert.deepEqual(await rawExercise(env.adapter, OTHER.id), { ...OTHER, retired: true });
});

rule("custom exercises: the Body tab follows a muscle edit, past sets included", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id); // 2 sets, 2 hours before the logger's clock
  const before = (await env.logger.getMuscleStatus()).values;
  assert.deepEqual([before.chest, before.lats], [2, 0]);
  await env.logger.updateCustomExercise(MINE.id, { name: MINE.name, primaryMuscles: ["lats"] });
  const after = (await env.logger.getMuscleStatus()).values;
  assert.deepEqual([after.chest, after.lats], [0, 2]);
});

// ---- the catalog sync ----

rule("custom exercises: a catalog sync after a delete and a hide brings nothing back and leaves the hidden exercise exactly as it was", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", OTHER.id);
  assert.equal(await env.logger.removeCustomExercise(MINE.id), "deleted");
  assert.equal(await env.logger.removeCustomExercise(OTHER.id), "hidden");
  const few = CATALOG.slice(0, 5);
  const result = await createCatalogStore(env.adapter).syncCatalog(few, { version: CATALOG_VERSION, count: few.length });
  assert.deepEqual([result.added, result.conflicts], [5, []]);
  assert.equal(await rawExercise(env.adapter, MINE.id), undefined);
  assert.deepEqual(await rawExercise(env.adapter, OTHER.id), { ...OTHER, retired: true });
  assert.deepEqual((await env.logger.listHiddenCustomExercises()).map((exercise) => exercise.id), [OTHER.id]);
});

// ---- restore ----

rule("custom exercises: restore changes only retired, is harmless on a shown exercise, and leaves every other record alone", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  await workoutWith(env.store, "w1", MINE.id);
  await env.logger.removeCustomExercise(MINE.id);
  const others = [await rawExercise(env.adapter, OTHER.id), await rawExercise(env.adapter, EXERCISE.id)];
  const history = await rawAll(env.adapter);
  assert.deepEqual(await env.logger.restoreCustomExercise(MINE.id), MINE);
  assert.deepEqual(await rawExercise(env.adapter, MINE.id), MINE);
  assert.deepEqual(await env.logger.restoreCustomExercise(MINE.id), MINE);
  assert.deepEqual([await rawExercise(env.adapter, OTHER.id), await rawExercise(env.adapter, EXERCISE.id)], others);
  assert.deepEqual(await rawAll(env.adapter), history);
  assert.deepEqual((await env.logger.findExercises("cable fly")).map((exercise) => exercise.id), ["c-fly"]);
  assert.deepEqual(await env.logger.listHiddenCustomExercises(), []);
});

// ---- neck and abductors (offered by the form since 2026-10-26) ----

rule("custom exercises: one with neck and abductors saves, round-trips through export and import unchanged, and the Body tab counts it (neck as traps)", async (ctx) => {
  const { assert } = ctx;
  const env = await open(ctx);
  const harness = await env.logger.addCustomExercise({ name: "Neck Harness", primaryMuscles: ["neck"], secondaryMuscles: ["abductors"] });
  assert.deepEqual([harness.primaryMuscles, harness.secondaryMuscles], [["neck"], ["abductors"]]);
  const text = await env.backup.exportToText({ now: NOW });
  await env.backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual(await rawExercise(env.adapter, harness.id), harness);
  assert.equal(await env.backup.exportToText({ now: NOW }), text);
  const before = (await env.logger.getMuscleStatus()).values;
  assert.deepEqual([before.traps, before.abductors], [0, 0]);
  await workoutWith(env.store, "w1", harness.id); // 2 sets
  const after = (await env.logger.getMuscleStatus()).values;
  assert.deepEqual([after.traps, after.abductors, "neck" in after], [2, 1, false]);
  // an edit from chest to neck and abductors moves past sets the same way
  await workoutWith(env.store, "w2", MINE.id, { startedAt: "2026-10-22T09:00:00.000Z" });
  assert.equal((await env.logger.getMuscleStatus()).values.chest, 2);
  await env.logger.updateCustomExercise(MINE.id, { name: MINE.name, primaryMuscles: ["neck"], secondaryMuscles: ["abductors"] });
  const edited = (await env.logger.getMuscleStatus()).values;
  assert.deepEqual([edited.chest, edited.traps, edited.abductors], [0, 4, 2]);
});
