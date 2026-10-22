// Runs the shared storage rule tests against the IndexedDB adapter and shows
// pass/fail per test. Makes no network requests; everything loaded is local.

import { storeRules, failAfter, makeDetails, rawCounts, EXERCISE } from "../store-rules.js";
import { createStore } from "../../src/storage/store.js";
import { createIdbAdapter, deleteDatabase, requestPersistentStorage } from "../../src/storage/idb-adapter.js";

const DB_NAME = "gymapp-storage-test";

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
  await deleteDatabase(DB_NAME); // each test starts from an empty database
  const adapters = [];
  const ctx = {
    assert,
    createAdapter() {
      const adapter = createIdbAdapter({ name: DB_NAME });
      adapters.push(adapter);
      return adapter;
    },
  };
  try {
    await rule.run(ctx);
  } finally {
    for (const adapter of adapters) adapter.close();
  }
}

async function runAll() {
  rerun.disabled = true;
  resultsList.textContent = "";
  report.textContent = "";
  summary.className = "";
  summary.textContent = "Running…";
  document.title = "Running… GymApp storage tests";

  if (!globalThis.indexedDB) {
    summary.className = "fail";
    summary.textContent = "IndexedDB is not available in this browser.";
    rerun.disabled = false;
    return;
  }

  const rules = [...storeRules, ...browserOnlyRules];
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

  const passed = rules.length - failed;
  const verdict = failed === 0 ? "ALL PASSED" : `${failed} FAILED`;
  summary.className = failed === 0 ? "pass" : "fail";
  summary.textContent = `${verdict}: ${passed} of ${rules.length} tests passed`;
  document.title = `${verdict} (${passed}/${rules.length}) GymApp storage tests`;
  report.textContent = [`${verdict}: ${passed} of ${rules.length}`, `User agent: ${navigator.userAgent}`, "", ...lines].join("\n");
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
