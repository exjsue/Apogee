// Runs the shared rule tests (storage, backup, domain, logger) against the IndexedDB
// adapter, plus the browser-only tests and the UI smoke tests, and shows pass/fail
// per test. Makes no network requests; everything loaded is local.

import { storeRules, failAfter, makeDetails, rawCounts, EXERCISE } from "../store-rules.js";
import { backupRules, openBackup, seedFull, incomingFile, NOW } from "../backup-rules.js";
import { domainRules } from "../domain-rules.js";
import { storeExtraRules } from "../store-extra-rules.js";
import { loggerRules } from "../logger-rules.js";
import { sessionRules } from "../session-rules.js";
import { reorderRules } from "../reorder-rules.js";
import { templateRules } from "../template-rules.js";
import { editRules } from "../edit-rules.js";
import { customExerciseRules } from "../custom-exercise-rules.js";
import { upgradeRules } from "./upgrade-rules.js";
import { uiRules, layoutMeasures } from "./ui-smoke.js";
import { catalogRules } from "../catalog-rules.js";
import { catalogWiringRules } from "../catalog-wiring-rules.js";
import { createLogger } from "../../src/app/logger.js";
import { prepareCatalog } from "../../src/domain/builtin.js";
import { createBackup } from "../../src/backup/backup.js";
import { createStore } from "../../src/storage/store.js";
import { createCatalogStore } from "../../src/storage/catalog-store.js";
import { createIdbAdapter, deleteDatabase, requestPersistentStorage } from "../../src/storage/idb-adapter.js";
import { SEED_EXERCISES, SEED_VERSION } from "../../src/domain/seed.js";
import { CATALOG } from "../../src/catalog/catalog.js";
import { CATALOG_VERSION, CATALOG_COUNT } from "../../src/catalog/catalog-info.js";

const DB_NAME = "apogee-storage-test";

// Rules marked ownDatabase (the catalog rules) each get a throwaway database of their own, deleted before and
// after the rule. This page is served from the same origin as the app, so a name is only accepted if it has
// this prefix: it can never be the app's real database.
const THROWAWAY_PREFIX = "apogee-catalog-test-";
let throwawayCount = 0;
function throwawayName() {
  throwawayCount += 1;
  const name = `${THROWAWAY_PREFIX}${Date.now()}-${throwawayCount}`;
  if (!name.startsWith(THROWAWAY_PREFIX) || name.length <= THROWAWAY_PREFIX.length) throw new Error(`refusing database name "${name}"`);
  return name;
}

// Measurements a rule wants in the plain-text report (not pass/fail).
const notes = [];

// ---- assertion helper, same shape as node:assert/strict for the methods the rules use ----

const show = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

const assert = {
  equal(actual, expected) {
    if (!Object.is(actual, expected)) throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
  },
  deepEqual(actual, expected) {
    if (!deepEqual(actual, expected)) throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
  },
  ok(value) {
    if (!value) throw new Error(`expected a truthy value, got ${show(value)}`);
  },
  async rejects(promise, pattern) {
    let rejected = false;
    let error;
    try {
      await promise;
    } catch (caught) {
      rejected = true;
      error = caught;
    }
    if (!rejected) throw new Error("expected the promise to reject");
    if (pattern && !pattern.test(String(error))) {
      throw new Error(`rejected with "${error}", which does not match ${pattern}`);
    }
  },
};

// ---- tests that only make sense against real IndexedDB ----

const browserOnlyRules = [
  {
    name: "a failed save is gone for good: a brand-new connection sees zero records",
    async run(ctx) {
      const adapter = ctx.createAdapter();
      const store = createStore(adapter);
      await store.open();
      await store.saveExercise(EXERCISE);
      const d = makeDetails("w1", 2, 3);
      const failing = createStore(failAfter(adapter, { puts: 4 }));
      await assert.rejects(
        failing.saveWorkoutWithDetails(d.workout, d.entries, d.sets),
        /injected failure/,
      );
      adapter.close();

      const fresh = ctx.createAdapter(); // a new adapter object, so a new IndexedDB connection
      await createStore(fresh).open();
      assert.deepEqual(await rawCounts(fresh), { workouts: 0, entries: 0, sets: 0 });
    },
  },
  {
    name: "a failed import is gone for good: a brand-new connection sees the previous data, unchanged",
    async run(ctx) {
      const { adapter, store, backup } = await openBackup(ctx);
      await seedFull(store);
      const before = await backup.exportToText({ now: NOW });
      const failing = createBackup(failAfter(adapter, { puts: 3 }));
      await assert.rejects(failing.importFromText(incomingFile(), { confirmReplace: true }), /injected failure/);
      adapter.close();

      const fresh = ctx.createAdapter(); // a new adapter object, so a new IndexedDB connection
      await createStore(fresh).open();
      assert.equal(await createBackup(fresh).exportToText({ now: NOW }), before);
    },
  },
];

// IndexedDB transaction rules the memory adapter cannot show: it never commits early, and it runs
// transactions one at a time through its own queue instead of the browser's scheduler.
const FULL = { version: CATALOG_VERSION, count: CATALOG_COUNT };
const catalogCount = (adapter) => adapter.transaction(["exercises"], "readonly", async (tx) => (
  (await tx.getAll("exercises")).filter((e) => e.origin === "upstream" || e.origin === "authored").length
));
async function seeded(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  return adapter;
}

const catalogBrowserRules = [
  {
    name: "catalog (IndexedDB): the whole catalog commits in one transaction; a brand-new connection sees every record and a current flag",
    async run(ctx) {
      const adapter = await seeded(ctx);
      let started = performance.now();
      const result = await createCatalogStore(adapter).syncCatalog(CATALOG, FULL);
      const syncMs = performance.now() - started;
      assert.equal(result.added, CATALOG_COUNT);
      adapter.close();

      const fresh = ctx.createAdapter(); // a new adapter object, so a new IndexedDB connection
      await createStore(fresh).open();
      started = performance.now();
      assert.equal(await createCatalogStore(fresh).catalogIsCurrent(FULL), true);
      const checkMs = performance.now() - started;
      assert.equal(await catalogCount(fresh), CATALOG_COUNT);
      notes.push(`Catalog sync of ${CATALOG_COUNT} entries (one transaction, ${SEED_EXERCISES.length} seeds stored): ${syncMs.toFixed(1)} ms`);
      notes.push(`catalogIsCurrent over ${CATALOG_COUNT + SEED_EXERCISES.length} exercises, new connection: ${checkMs.toFixed(1)} ms`);
    },
  },
  {
    name: "catalog (IndexedDB): a sync that fails halfway is gone for good: a brand-new connection sees no catalog record and no flag",
    async run(ctx) {
      const adapter = await seeded(ctx);
      await assert.rejects(createCatalogStore(failAfter(adapter, { puts: 400 })).syncCatalog(CATALOG, FULL), /injected failure/);
      adapter.close();

      const fresh = ctx.createAdapter();
      await createStore(fresh).open();
      assert.equal(await catalogCount(fresh), 0);
      const catalog = createCatalogStore(fresh);
      assert.equal(await catalog.catalogIsCurrent(FULL), false);
      assert.equal((await catalog.syncCatalog(CATALOG, FULL)).added, CATALOG_COUNT);
      assert.equal(await catalog.catalogIsCurrent(FULL), true);
    },
  },
  {
    name: "catalog (IndexedDB): two connections (two tabs) sync at once: every entry stored once, the second adds nothing",
    async run(ctx) {
      const one = await seeded(ctx);
      const two = ctx.createAdapter();
      await createStore(two).open();
      const results = await Promise.all([createCatalogStore(one).syncCatalog(CATALOG, FULL), createCatalogStore(two).syncCatalog(CATALOG, FULL)]);
      assert.deepEqual(results.map((r) => r.added).sort((a, b) => a - b), [0, CATALOG_COUNT]);
      assert.equal(await catalogCount(one), CATALOG_COUNT);
    },
  },
  {
    name: "catalog (IndexedDB): an addSet and a findExercises made while the sync transaction is open wait for its commit, then complete correctly",
    async run(ctx) {
      const adapter = await seeded(ctx);
      const logger = createLogger(createStore(adapter));
      // Long tasks (50 ms or more) on the main thread during the sync, where the browser reports them.
      const longTasks = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration)));
        observer.observe({ type: "longtask" });
      } catch {
        observer = null;
      }
      const finished = [];
      const called = performance.now();
      // syncCatalog validates the whole catalog (phase 3) and opens its readwrite transaction before it returns,
      // so both logger calls below create their transactions after it, while it is open.
      const sync = createCatalogStore(adapter).syncCatalog(CATALOG, FULL).then((result) => {
        finished.push("sync");
        return { result, at: performance.now() };
      });
      const issued = performance.now();
      const add = logger.addSet("seed-barbell-bench-press").then(() => {
        finished.push("addSet");
        return performance.now();
      });
      const find = logger.findExercises("").then((list) => {
        finished.push("findExercises");
        return { list, at: performance.now() };
      });
      const [synced, addAt, found] = await Promise.all([sync, add, find]);
      if (observer !== null) observer.disconnect();
      assert.equal(finished[0], "sync"); // both waited for the commit
      assert.equal(synced.result.added, CATALOG_COUNT);
      assert.equal(found.list.length, SEED_EXERCISES.length + CATALOG_COUNT); // it read the committed library
      const session = await logger.getSession();
      assert.deepEqual(session.blocks.map((b) => b.exerciseId), ["seed-barbell-bench-press"]);
      assert.equal(session.blocks[0].rows.length, 1);
      notes.push(`Sync call held the main thread (phase 3: validating ${CATALOG_COUNT} entries, then opening the transaction): ${(issued - called).toFixed(1)} ms`);
      notes.push(`Sync transaction open until commit: ${(synced.at - issued).toFixed(1)} ms`);
      notes.push(`addSet issued while the sync transaction was open: done after ${(addAt - issued).toFixed(1)} ms`);
      notes.push(`findExercises issued while the sync transaction was open: done after ${(found.at - issued).toFixed(1)} ms, ${found.list.length} exercises`);
      notes.push(observer === null ? "Long tasks: not reported by this browser" : `Long tasks during the sync: ${longTasks.length}, longest ${Math.max(0, ...longTasks).toFixed(0)} ms`);
    },
  },
  ...[
    ["a history that uses 5 distinct exercises, so the walk hits the 30-workout cap (worst case)", 5, 5],
    ["a history that cycles through all 16 seeds, so the walk stops after a few workouts (typical)", 16, 8],
  ].map(([label, pool, expected]) => ({
    name: `recent exercises (IndexedDB): ${label}; 2,000 workouts and 20,000 sets, throwaway database`,
    async run(ctx) {
      const adapter = await seeded(ctx);
      const exerciseIds = SEED_EXERCISES.slice(0, pool).map((exercise) => exercise.id);
      const WORKOUTS = 2000;
      const dayMs = 24 * 60 * 60 * 1000;
      const first = Date.parse("2020-01-01T10:00:00.000Z");
      for (let from = 0; from < WORKOUTS; from += 200) {
        await adapter.transaction(["workouts", "entries", "sets"], "readwrite", async (tx) => {
          for (let w = from; w < from + 200; w += 1) {
            const startedAt = new Date(first + w * dayMs).toISOString();
            await tx.put("workouts", { id: `w${w}`, startedAt, endedAt: startedAt, notes: null });
            for (let e = 0; e < 2; e += 1) {
              const entryId = `w${w}-e${e}`;
              await tx.put("entries", { id: entryId, workoutId: `w${w}`, exerciseId: exerciseIds[(w * 2 + e) % pool], order: e, supersetGroup: null, notes: null });
              for (let s = 0; s < 5; s += 1) {
                await tx.put("sets", { id: `${entryId}-s${s}`, entryId, order: s, reps: 5, weightValue: 60, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: startedAt });
              }
            }
          }
        });
      }
      const logger = createLogger(createStore(adapter));
      const times = [];
      let recent = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        recent = await logger.findRecentExercises();
        times.push(performance.now() - started);
      }
      assert.equal(recent.length, expected);
      assert.equal(new Set(recent.map((exercise) => exercise.id)).size, expected);
      assert.equal(recent[0].id, exerciseIds[(1999 * 2 + 1) % pool]); // the newest workout's later entry, set last
      notes.push(`findRecentExercises, ${WORKOUTS} workouts / ${WORKOUTS * 10} sets, ${pool} distinct exercises (found ${recent.length}), five runs: ${times.map((t) => t.toFixed(0)).join(", ")} ms`);
    },
  })),
  {
    name: "catalog (IndexedDB): phase 3 alone, prepareCatalog over the whole catalog, five runs",
    async run() {
      const times = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        assert.equal(prepareCatalog(CATALOG, FULL).length, CATALOG_COUNT);
        times.push(performance.now() - started);
      }
      notes.push(`prepareCatalog (${CATALOG_COUNT} entries, main thread), five runs: ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
    },
  },
];

// ---- runner ----

const resultsList = document.getElementById("results");
const summary = document.getElementById("summary");
const report = document.getElementById("report");
const rerun = document.getElementById("rerun");

function addRow(name) {
  const item = document.createElement("li");
  item.className = "running";
  item.textContent = name;
  resultsList.append(item);
  return item;
}

function markFailed(item, error) {
  item.className = "fail";
  const detail = document.createElement("span");
  detail.className = "error";
  detail.textContent = error && error.message ? error.message : String(error);
  item.append(detail);
}

async function runOne(rule) {
  const name = rule.ownDatabase ? throwawayName() : DB_NAME;
  await deleteDatabase(name); // each test starts from an empty database
  const adapters = [];
  const ctx = {
    assert,
    createAdapter() {
      const adapter = createIdbAdapter({ name });
      adapters.push(adapter);
      return adapter;
    },
  };
  try {
    await rule.run(ctx);
  } finally {
    for (const adapter of adapters) adapter.close();
    if (rule.ownDatabase) await deleteDatabase(name).catch(() => {});
  }
}

async function runAll() {
  rerun.disabled = true;
  resultsList.textContent = "";
  report.textContent = "";
  summary.className = "";
  summary.textContent = "Running…";
  document.title = "Running… Apogee storage tests";

  if (!globalThis.indexedDB) {
    summary.className = "fail";
    summary.textContent = "IndexedDB is not available in this browser.";
    rerun.disabled = false;
    return;
  }

  const rules = [
    ...storeRules, ...backupRules, ...templateRules, ...editRules, ...customExerciseRules, ...domainRules, ...storeExtraRules, ...loggerRules, ...sessionRules, ...reorderRules, ...browserOnlyRules, ...upgradeRules, ...uiRules,
    ...[...catalogRules, ...catalogWiringRules, ...catalogBrowserRules].map((rule) => ({ ...rule, ownDatabase: true })),
  ];
  notes.length = 0;
  const lines = [];
  let failed = 0;
  for (const rule of rules) {
    const item = addRow(rule.name);
    try {
      await runOne(rule);
      item.className = "pass";
      lines.push(`PASS ${rule.name}`);
    } catch (error) {
      failed += 1;
      markFailed(item, error);
      lines.push(`FAIL ${rule.name}: ${error && error.message ? error.message : error}`);
    }
  }
  try {
    await deleteDatabase(DB_NAME);
  } catch {
    // leftover test database; harmless
  }

  notes.push(...layoutMeasures.map((line) => `Edit form layout, ${line}`));
  const passed = rules.length - failed;
  const verdict = failed === 0 ? "ALL PASSED" : `${failed} FAILED`;
  summary.className = failed === 0 ? "pass" : "fail";
  summary.textContent = `${verdict}: ${passed} of ${rules.length} tests passed`;
  document.title = `${verdict} (${passed}/${rules.length}) Apogee storage tests`;
  report.textContent = [`${verdict}: ${passed} of ${rules.length}`, `User agent: ${navigator.userAgent}`, "", ...lines, "", ...notes.map((note) => `NOTE ${note}`)].join("\n");
  rerun.disabled = false;
}

rerun.addEventListener("click", runAll);

document.getElementById("persist").addEventListener("click", async () => {
  const output = document.getElementById("persist-result");
  output.textContent = "Asking…";
  const result = await requestPersistentStorage();
  output.textContent = `supported: ${result.supported}, persisted: ${result.persisted}`
    + (result.error ? `, error: ${result.error}` : "");
});

runAll();
