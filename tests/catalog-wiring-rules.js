// The exercise library as src/ui/main.js wires it: the real service (src/app/catalog.js) on the real catalog
// store, next to the real logger and backup on the same adapter. Shared by Node (memory adapter) and the
// browser page (IndexedDB adapter, a throwaway database per rule).
// No node:test import: the runner supplies ctx.assert and ctx.createAdapter (see store-rules.js).

import { createStore } from "../src/storage/store.js";
import { createCatalogStore } from "../src/storage/catalog-store.js";
import { createCatalogService, resyncAfterImport } from "../src/app/catalog.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup } from "../src/backup/backup.js";
import { createExercise } from "../src/domain/model.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { CATALOG_VERSION_META_KEY } from "../src/storage/schema.js";
import { CATALOG } from "../src/catalog/catalog.js";
import { CATALOG_VERSION, CATALOG_COUNT } from "../src/catalog/catalog-info.js";
import { failAfter } from "./store-rules.js";

export const catalogWiringRules = [];
const rule = (name, run) => catalogWiringRules.push({ name: `catalog wiring: ${name}`, run });

const FULL = { version: CATALOG_VERSION, count: CATALOG_COUNT };
const NOW = "2026-10-24T12:00:00.000Z";
const BENCH = "seed-barbell-bench-press";
const CUSTOM = createExercise({ id: "custom-1", name: "My own press", primaryMuscles: ["chest"], isCustom: true, notes: "mine" });
// What the picker lists with no search and no filter once the library is stored: the 16 seeds, the 830 catalog
// entries (none retired) and the one custom exercise these rules add.
const PICKER_COUNT = SEED_EXERCISES.length + CATALOG.filter((e) => !e.retired).length + 1;

const isCatalog = (e) => e.isCustom === false && (e.origin === "upstream" || e.origin === "authored");
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const snapshot = (adapter) => adapter.transaction(["exercises", "meta"], "readonly", async (tx) => {
  const exercises = (await tx.getAll("exercises")).sort(byId);
  return {
    others: exercises.filter((e) => !isCatalog(e)),
    catalog: exercises.filter(isCatalog).length,
    flag: (await tx.get("meta", CATALOG_VERSION_META_KEY))?.value ?? null,
  };
});

// A launch of the app on `adapter`: the store opened and seeded, as main.js does before the library.
async function launch(adapter, { load } = {}) {
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const statuses = [];
  const syncs = []; // what each syncCatalog call resolved
  let loads = 0;
  const catalogStore = createCatalogStore(adapter);
  const catalog = createCatalogService({
    catalogStore: {
      catalogIsCurrent: (info) => catalogStore.catalogIsCurrent(info),
      syncCatalog: async (entries, info) => {
        const result = await catalogStore.syncCatalog(entries, info);
        syncs.push(result);
        return result;
      },
    },
    load: async () => {
      loads += 1;
      return load ? load() : import("../src/catalog/catalog.js");
    },
  });
  catalog.onChange((status) => statuses.push(status));
  return { store, logger: createLogger(store), backup: createBackup(adapter), catalog, statuses, syncs, loads: () => loads };
}

async function until(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

rule("first launch: the library is stored, the status goes syncing then ready, the picker lists 847, seeds and the custom are unchanged", async (ctx) => {
  const { assert } = ctx;
  const adapter = ctx.createAdapter();
  const app = await launch(adapter);
  await app.store.saveExercise(CUSTOM);
  const before = await snapshot(adapter);
  assert.equal(before.catalog, 0);
  const outcome = await app.catalog.ensureCurrent();
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.synced, true);
  assert.equal(outcome.result.added, CATALOG_COUNT);
  assert.deepEqual(app.statuses, ["syncing", "ready"]);
  const after = await snapshot(adapter);
  assert.equal(after.catalog, CATALOG_COUNT);
  assert.deepEqual(after.others, before.others); // seeds and the custom, field for field
  assert.deepEqual(after.flag, { version: CATALOG_VERSION, conflicts: [], stored: CATALOG_COUNT });
  assert.equal((await app.logger.findExercises("")).length, PICKER_COUNT);
});

rule("second launch: the quick check says current, the library module is not loaded and nothing is written", async (ctx) => {
  const { assert } = ctx;
  const adapter = ctx.createAdapter();
  await (await launch(adapter)).catalog.ensureCurrent();
  const before = await snapshot(adapter);
  const second = await launch(adapter);
  assert.deepEqual(await second.catalog.ensureCurrent(), { status: "ready", synced: false });
  assert.equal(second.loads(), 0);
  assert.deepEqual(second.statuses, ["ready"]);
  assert.deepEqual(await snapshot(adapter), before);
});

for (const [label, exportAfterSync] of [["a file from before the library", false], ["a file that already holds the library", true]]) {
  rule(`import of ${label}: the import deletes the flag, the re-check runs by itself and stores or confirms the library`, async (ctx) => {
    const { assert } = ctx;
    const adapter = ctx.createAdapter();
    const app = await launch(adapter);
    await app.store.saveExercise(CUSTOM);
    const early = exportAfterSync ? null : await app.backup.exportToText({ now: NOW });
    await app.catalog.ensureCurrent();
    const file = exportAfterSync ? await app.backup.exportToText({ now: NOW }) : early;
    const backup = resyncAfterImport(app.backup, app.catalog);
    const counts = await backup.importFromText(file, { confirmReplace: true });
    assert.equal(typeof counts.workouts, "number"); // the import's own result is passed through
    await until(() => app.syncs.length === 2 && app.catalog.getStatus() === "ready", "the re-check after the import");
    assert.equal(app.syncs[1].added, exportAfterSync ? 0 : CATALOG_COUNT);
    assert.deepEqual(app.statuses, ["syncing", "ready", "syncing", "ready"]);
    const after = await snapshot(adapter);
    assert.equal(after.catalog, CATALOG_COUNT);
    assert.deepEqual(after.others.map((e) => e.id), [CUSTOM.id, ...SEED_EXERCISES.map((e) => e.id)].sort());
    assert.equal(await createCatalogStore(adapter).catalogIsCurrent(FULL), true);
  });
}

rule("a library that fails to load or to store: ensureCurrent resolves failed, nothing is stored, and logging and the picker still work", async (ctx) => {
  const { assert } = ctx;
  const adapter = ctx.createAdapter();
  const app = await launch(adapter, { load: async () => { throw new Error("offline"); } });
  const outcome = await app.catalog.ensureCurrent();
  assert.equal(outcome.status, "failed");
  assert.equal(app.catalog.getStatus(), "failed");
  await app.logger.addSet(BENCH);
  const session = await app.logger.getSession();
  assert.deepEqual(session.blocks.map((b) => b.exerciseId), [BENCH]);
  assert.equal((await app.logger.findExercises("")).length, SEED_EXERCISES.length);
  assert.equal((await snapshot(adapter)).catalog, 0);

  // A sync whose transaction fails halfway: rolled back, the app goes on, and the next launch stores it.
  const failing = createCatalogService({ catalogStore: createCatalogStore(failAfter(adapter, { puts: 400 })) });
  assert.equal((await failing.ensureCurrent()).status, "failed");
  assert.equal((await snapshot(adapter)).catalog, 0);
  await app.logger.addSet(BENCH);
  assert.equal((await (await launch(adapter)).catalog.ensureCurrent()).result.added, CATALOG_COUNT);
});
