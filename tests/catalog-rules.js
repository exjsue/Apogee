// Catalog sync rule tests, shared by Node (memory adapter) and the browser page (IndexedDB adapter).
// No node:test import: the runner supplies ctx.assert and ctx.createAdapter (see store-rules.js).
// They use real catalog entries: a few of them as a small catalog, and once the whole catalog.

import { createStore } from "../src/storage/store.js";
import { createCatalogStore } from "../src/storage/catalog-store.js";
import { createLogger } from "../src/app/logger.js";
import { createExercise } from "../src/domain/model.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { CATALOG_VERSION_META_KEY } from "../src/storage/schema.js";
import { CATALOG } from "../src/catalog/catalog.js";
import { CATALOG_VERSION, CATALOG_COUNT } from "../src/catalog/catalog-info.js";
import { EXERCISE, makeDetails, failAfter } from "./store-rules.js";

export const catalogRules = [];
const rule = (name, run) => catalogRules.push({ name: `catalog: ${name}`, run });

const FEW = CATALOG.slice(0, 5);
const INFO = { version: CATALOG_VERSION, count: FEW.length };
const FULL = { version: CATALOG_VERSION, count: CATALOG_COUNT };

const CUSTOM = createExercise({ id: "custom-1", name: "My own press", primaryMuscles: ["chest"], isCustom: true, notes: "mine" });

// A database with the seeds, one custom exercise, EXERCISE and a finished workout that uses it.
async function setup(ctx, adapter = ctx.createAdapter()) {
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  await store.saveExercise(CUSTOM);
  await store.saveExercise(EXERCISE);
  const details = makeDetails("w1", 2, 2);
  await store.saveWorkoutWithDetails({ ...details.workout, endedAt: "2026-10-22T11:00:00.000Z" }, details.entries, details.sets);
  return { adapter, store, catalog: createCatalogStore(adapter) };
}

// Everything in the database, straight from the adapter, records sorted by id.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const dump = (adapter) => adapter.transaction(["exercises", "workouts", "entries", "sets", "meta"], "readonly", async (tx) => ({
  exercises: (await tx.getAll("exercises")).sort(byId),
  workouts: (await tx.getAll("workouts")).sort(byId),
  entries: (await tx.getAll("entries")).sort(byId),
  sets: (await tx.getAll("sets")).sort(byId),
  flag: (await tx.get("meta", CATALOG_VERSION_META_KEY))?.value ?? null,
}));
const notCatalog = (snapshot) => snapshot.exercises.filter((e) => !["upstream", "authored"].includes(e.origin));
const catalogIds = (snapshot) => snapshot.exercises.filter((e) => ["upstream", "authored"].includes(e.origin)).map((e) => e.id);
const putRaw = (adapter, store, record) => adapter.transaction([store], "readwrite", (tx) => tx.put(store, record));
const deleteRaw = (adapter, store, key) => adapter.transaction([store], "readwrite", (tx) => tx.delete(store, key));

rule("a first sync inserts every entry and writes the flag; a second adds nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  assert.equal(await catalog.catalogIsCurrent(INFO), false);
  const first = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual(first, { added: 5, present: 0, conflicts: [], nameClashes: [], stored: 5, skipped: false });
  const after = await dump(adapter);
  assert.deepEqual(catalogIds(after), FEW.map((e) => e.id).sort());
  assert.deepEqual(after.flag, { version: CATALOG_VERSION, conflicts: [], stored: 5 });
  assert.equal(await catalog.catalogIsCurrent(INFO), true);
  const second = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual([second.added, second.present, second.stored], [0, 5, 5]);
  assert.deepEqual(await dump(adapter), after);
});

rule("seeds, custom exercises and history are deep-equal before and after a sync", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const before = await dump(adapter);
  await catalog.syncCatalog(FEW, INFO);
  const after = await dump(adapter);
  assert.deepEqual(notCatalog(after), notCatalog(before));
  assert.deepEqual([after.workouts, after.entries, after.sets], [before.workouts, before.entries, before.sets]);
  assert.equal(after.exercises.length, before.exercises.length + 5);
});

for (const [label, puts] of [["the first insert", 0], ["a middle insert", 2], ["the flag (the last write)", 5]]) {
  rule(`a sync that fails at ${label} leaves nothing behind, and the next sync completes`, async (ctx) => {
    const { assert } = ctx;
    const { adapter, catalog } = await setup(ctx);
    const before = await dump(adapter);
    await assert.rejects(createCatalogStore(failAfter(adapter, { puts })).syncCatalog(FEW, INFO), /injected failure/);
    assert.deepEqual(await dump(adapter), before);
    assert.equal(await catalog.catalogIsCurrent(INFO), false);
    assert.equal((await catalog.syncCatalog(FEW, INFO)).added, 5);
    assert.equal(await catalog.catalogIsCurrent(INFO), true);
  });
}

rule("an id held by a custom exercise is a conflict: the custom is untouched, and the flag counts it so it is not retried", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, catalog } = await setup(ctx);
  const mine = await store.saveExercise({ id: FEW[0].id, name: "Mine, same id", primaryMuscles: ["quads"], isCustom: true });
  const result = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual(result.conflicts, [{ id: FEW[0].id, reason: "custom" }]);
  assert.deepEqual([result.added, result.stored], [4, 4]);
  assert.deepEqual(await store.getExercise(FEW[0].id), mine);
  assert.deepEqual((await dump(adapter)).flag, { version: CATALOG_VERSION, conflicts: [FEW[0].id], stored: 4 });
  assert.equal(await catalog.catalogIsCurrent(INFO), true);
  assert.equal((await catalog.syncCatalog(FEW, INFO)).added, 0);
});

rule("a catalog name equal to a custom name (ignoring case and spacing) is inserted and reported; the custom-name check agrees", async (ctx) => {
  const { assert } = ctx;
  const { store, catalog } = await setup(ctx);
  const target = FEW[1];
  const mine = await store.saveExercise({ id: "custom-clash", name: `  ${target.name.toUpperCase().replace(" ", "   ")} `, primaryMuscles: ["abs"], isCustom: true });
  const result = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual(result.nameClashes, [{ id: target.id, existingId: "custom-clash" }]);
  assert.equal(result.added, 5);
  assert.deepEqual(await store.getExercise("custom-clash"), mine);
  assert.equal((await store.getExercise(target.id)).name, target.name);
  // the logger's uniqueness check treats the two names as the same name too
  await assert.rejects(createLogger(store).addCustomExercise({ name: target.name, primaryMuscles: ["abs"] }), /already exists/);
});

rule("a catalog record already stored with different fields counts as present and is not overwritten", async (ctx) => {
  const { assert } = ctx;
  const { store, catalog } = await setup(ctx);
  await catalog.syncCatalog(FEW, INFO);
  const edited = await store.saveExercise({ ...(await store.getExercise(FEW[2].id)), defaultRestSeconds: 90, notes: "my cue" });
  const result = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual([result.added, result.present], [0, 5]);
  assert.deepEqual(await store.getExercise(FEW[2].id), edited);
});

rule("extra catalog records from a later catalog do not make every launch sync again", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, catalog } = await setup(ctx);
  const later = (id) => createExercise({ id, name: `Later ${id}`, primaryMuscles: ["chest"], origin: "upstream", upstreamId: id, catalogVersion: CATALOG_VERSION + 1 });
  // already there before the first sync (an import of a backup from a newer app deletes the flag, then this)
  await store.saveExercise(later("Later_A"));
  assert.equal((await catalog.syncCatalog(FEW, INFO)).stored, 6);
  for (let launch = 0; launch < 3; launch++) assert.equal(await catalog.catalogIsCurrent(INFO), true);
  // one added after a sync: one more sync, then current on every launch
  await store.saveExercise(later("Later_B"));
  assert.equal(await catalog.catalogIsCurrent(INFO), false);
  const again = await catalog.syncCatalog(FEW, INFO);
  assert.deepEqual([again.added, again.stored], [0, 7]);
  for (let launch = 0; launch < 3; launch++) assert.equal(await catalog.catalogIsCurrent(INFO), true);
  assert.equal(catalogIds(await dump(adapter)).length, 7);
});

rule("a deleted catalog record sends it back to sync, which restores only that record", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  await catalog.syncCatalog(FEW, INFO);
  const full = await dump(adapter);
  await deleteRaw(adapter, "exercises", FEW[3].id);
  assert.equal(await catalog.catalogIsCurrent(INFO), false);
  assert.equal((await catalog.syncCatalog(FEW, INFO)).added, 1);
  assert.equal(await catalog.catalogIsCurrent(INFO), true);
  assert.deepEqual(await dump(adapter), full);
});

rule("records present but no flag (as after an import): the sync adds nothing and writes the flag", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  await catalog.syncCatalog(FEW, INFO);
  await deleteRaw(adapter, "meta", CATALOG_VERSION_META_KEY);
  assert.equal(await catalog.catalogIsCurrent(INFO), false);
  assert.equal((await catalog.syncCatalog(FEW, INFO)).added, 0);
  assert.equal(await catalog.catalogIsCurrent(INFO), true);
});

rule("a flag from a newer catalog: skipped, nothing written; from an older one: refused, nothing written", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const newer = { key: CATALOG_VERSION_META_KEY, value: { version: CATALOG_VERSION + 1, conflicts: [], stored: 0 } };
  await putRaw(adapter, "meta", newer);
  const before = await dump(adapter);
  assert.equal((await catalog.syncCatalog(FEW, INFO)).skipped, "newer");
  assert.deepEqual(await dump(adapter), before);

  await putRaw(adapter, "meta", { key: CATALOG_VERSION_META_KEY, value: { version: CATALOG_VERSION, conflicts: [], stored: 0 } });
  const v2 = FEW.map((e) => ({ ...e, catalogVersion: CATALOG_VERSION + 1 }));
  const older = await dump(adapter);
  await assert.rejects(catalog.syncCatalog(v2, { version: CATALOG_VERSION + 1, count: v2.length }), /not supported yet/);
  assert.deepEqual(await dump(adapter), older);
});

rule("a bad catalog is refused before anything is written", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const before = await dump(adapter);
  const bad = [
    [FEW.slice(1), /entries, expected 5/],
    [FEW.map((e, i) => (i === 2 ? { ...e, catalogVersion: CATALOG_VERSION + 1 } : e)), /catalogVersion must be/],
    [FEW.map((e, i) => (i === 2 ? { ...e, primaryMuscles: [] } : e)), /catalog\[2\]: primaryMuscles/],
    [FEW.map((e, i) => (i === 4 ? FEW[0] : e)), /duplicate id/],
    [FEW.map((e, i) => (i === 1 ? { ...e, origin: "seed" } : e)), /origin must be upstream or authored/],
    [FEW.map((e, i) => (i === 1 ? { ...e, origin: "custom" } : e)), /catalog\[1\]: origin/],
    [FEW.map((e, i) => (i === 3 ? null : e)), /catalog\[3\]/],
  ];
  for (const [entries, pattern] of bad) await assert.rejects(catalog.syncCatalog(entries, INFO), pattern);
  assert.deepEqual(await dump(adapter), before);
});

rule("a catalog containing a seed id throws, and every seed and custom exercise is deep-equal before and after", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const before = await dump(adapter);
  for (const id of ["seed-barbell-squat", "seed-not-a-seed-yet"]) {
    const hostile = FEW.map((e, i) => (i === 0 ? { ...e, id } : e));
    await assert.rejects(catalog.syncCatalog(hostile, INFO), /is a seed id/);
  }
  const after = await dump(adapter);
  assert.deepEqual(after, before);
  assert.equal(notCatalog(after).filter((e) => e.id.startsWith("seed-")).length, SEED_EXERCISES.length);
});

rule("seeds (catalogVersion null) are never counted as catalog records", async (ctx) => {
  const { assert } = ctx;
  const { catalog } = await setup(ctx);
  // 16 seeds and 2 customs stored, no catalog: a catalog of zero entries is current only once synced
  assert.equal(await catalog.catalogIsCurrent({ version: CATALOG_VERSION, count: 0 }), false);
  assert.equal((await catalog.syncCatalog([], { version: CATALOG_VERSION, count: 0 })).stored, 0);
  assert.equal(await catalog.catalogIsCurrent({ version: CATALOG_VERSION, count: 0 }), true);
});

rule("two syncs started at once: all entries once, and the second adds nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const results = await Promise.all([catalog.syncCatalog(FEW, INFO), createCatalogStore(adapter).syncCatalog(FEW, INFO)]);
  assert.deepEqual(results.map((r) => r.added).sort(), [0, 5]);
  assert.equal(catalogIds(await dump(adapter)).length, 5);
});

rule("the whole catalog: every entry stored, seeds and customs untouched, current afterwards", async (ctx) => {
  const { assert } = ctx;
  const { adapter, catalog } = await setup(ctx);
  const before = await dump(adapter);
  const result = await catalog.syncCatalog(CATALOG, FULL);
  assert.deepEqual([result.added, result.stored, result.conflicts.length, result.nameClashes.length], [CATALOG_COUNT, CATALOG_COUNT, 0, 0]);
  const after = await dump(adapter);
  assert.deepEqual(notCatalog(after), notCatalog(before));
  assert.equal(after.exercises.length, before.exercises.length + CATALOG_COUNT);
  assert.equal(await catalog.catalogIsCurrent(FULL), true);
});
