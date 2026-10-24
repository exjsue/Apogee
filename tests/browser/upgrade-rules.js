// Tests of the IndexedDB upgrade (schema version 1 to 2), run only against real
// IndexedDB in a browser. Each rule uses a database of its own, never the app's
// (tests/guard.test.js keeps it that way) and never the shared test database.

import { createIdbAdapter, deleteDatabase } from "../../src/storage/idb-adapter.js";
import { createStore } from "../../src/storage/store.js";
import { createBackup } from "../../src/backup/backup.js";
import {
  SCHEMA_VERSION, createWorkout, createWorkoutEntry, createWorkSet,
} from "../../src/domain/model.js";

export const upgradeRules = [];
const rule = (name, run) => upgradeRules.push({ name, run });

const STORES = ["exercises", "workouts", "entries", "sets", "meta"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

// A database name of its own, removed before and after the rule.
async function withDatabase(body) {
  counter += 1;
  const name = `apogee-upgrade-test-${Date.now()}-${counter}`;
  const adapters = [];
  const track = (adapter) => {
    adapters.push(adapter);
    return adapter;
  };
  await deleteDatabase(name);
  try {
    await body({ name, track });
  } finally {
    for (const adapter of adapters) adapter.close();
    await deleteDatabase(name).catch(() => {});
  }
}

async function waitUntil(check, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

// The version of an existing database, read without changing it.
const rawVersion = (name) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name);
  request.onsuccess = () => {
    const { version } = request.result;
    request.result.close();
    resolve(version);
  };
  request.onerror = () => reject(request.error);
});

// A connection that stays open and, like an old tab without a handler, does not
// step aside when another connection asks for an upgrade.
const holdConnection = (name) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const snapshot = (adapter) => adapter.transaction(STORES, "readonly", async (tx) => {
  const out = {};
  for (const name of STORES) {
    out[name] = (await tx.getAll(name)).sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
  }
  return out;
});

// The exercise fields each schema version stored. The fixtures below are written out as raw records, NOT built
// with createExercise, so they stay exactly what that schema stored whatever createExercise later returns.
// withoutField (further down) removes the fields a later schema added, so "nothing else changed" keeps
// comparing only the fields the old schema had.
const LATER_FIELDS = ["defaultRestSeconds", "baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired"];

// An exercise record as schema version 1 stored it (no defaultRestSeconds).
const rawV1Exercise = (fields) => ({ secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: false, ...fields });
// An exercise record as schema version 2 stored it (defaultRestSeconds, null unless set).
const rawV2Exercise = (fields) => ({ ...rawV1Exercise(fields), defaultRestSeconds: null, ...fields });

// A schema version 1 database with real-looking data: exercises without
// defaultRestSeconds (one already has a value), a finished and an unfinished
// workout, sets with and without a rest, and settings in meta.
async function makeVersion1(name, track) {
  const adapter = track(createIdbAdapter({ name, version: 1 })); // creates the stores, as version 1 did
  await adapter.open();
  const records = {
    exercises: [
      rawV1Exercise({ id: "seed-a", name: "A", primaryMuscles: ["chest"] }),
      rawV1Exercise({ id: "ex-b", name: "B", primaryMuscles: ["lats"], isCustom: true, notes: "mine" }),
      { ...rawV1Exercise({ id: "ex-c", name: "C", primaryMuscles: ["quads"] }), defaultRestSeconds: 120 },
    ],
    workouts: [
      createWorkout({ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z" }),
      createWorkout({ id: "w2", startedAt: "2026-10-20T10:00:00.000Z" }),
    ],
    entries: [
      createWorkoutEntry({ id: "e1", workoutId: "w1", exerciseId: "seed-a", order: 0 }),
      createWorkoutEntry({ id: "e2", workoutId: "w2", exerciseId: "ex-b", order: 0 }),
    ],
    sets: [
      createWorkSet({ id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 100, weightUnit: "kg", completedAt: "2026-10-01T10:05:00.000Z" }),
      createWorkSet({ id: "s2", entryId: "e1", order: 1, reps: 5, weightValue: 62.5, weightUnit: "lb", restSeconds: 60, isWarmup: true }),
      createWorkSet({ id: "s3", entryId: "e2", order: 0, reps: 10, weightValue: 0, weightUnit: "kg" }),
    ],
    meta: [
      { key: "schemaVersion", value: 1 },
      { key: "preferredUnit", value: "kg" },
      { key: "lastExportAt", value: "2026-10-02T00:00:00.000Z" },
      { key: "seedVersion", value: 1 },
    ],
  };
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    for (const [storeName, list] of Object.entries(records)) for (const record of list) await tx.put(storeName, record);
  });
  const before = await snapshot(adapter);
  adapter.close();
  return before;
}

// The exercise without the fields a later schema added (see LATER_FIELDS).
const withoutField = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !LATER_FIELDS.includes(key)));

// A schema version 2 database: exercises as version 2 stored them, one finished workout with sets, and settings
// in meta, written with version 2 explicitly so it stays a version 2 database whatever SCHEMA_VERSION becomes.
async function makeVersion2(name, track) {
  const adapter = track(createIdbAdapter({ name, version: 2 }));
  await adapter.open();
  const records = {
    exercises: [
      rawV2Exercise({ id: "seed-a", name: "A", primaryMuscles: ["chest"] }),
      rawV2Exercise({ id: "ex-1", name: "Squat", primaryMuscles: ["quads"], isCustom: true, defaultRestSeconds: 90 }),
    ],
    workouts: [createWorkout({ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z" })],
    entries: [createWorkoutEntry({ id: "e1", workoutId: "w1", exerciseId: "ex-1", order: 0 })],
    sets: [createWorkSet({ id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 100, weightUnit: "kg", completedAt: "2026-10-01T10:05:00.000Z" })],
    meta: [{ key: "schemaVersion", value: 2 }, { key: "preferredUnit", value: "kg" }],
  };
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    for (const [storeName, list] of Object.entries(records)) for (const record of list) await tx.put(storeName, record);
  });
  const before = await snapshot(adapter);
  adapter.close();
  return before;
}

rule("upgrade: a populated version 1 database becomes version 2 with every record kept, in the upgrade transaction", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion1(name, track);
    assert.equal(await rawVersion(name), 1);

    const adapter = track(createIdbAdapter({ name })); // the app's version: SCHEMA_VERSION
    const store = createStore(adapter);
    await store.open(); // opens (and upgrades) the database; refuses nothing
    assert.equal(await rawVersion(name), SCHEMA_VERSION);

    const after = await snapshot(adapter);
    assert.deepEqual(after.exercises.map((e) => [e.id, e.defaultRestSeconds]), [["ex-b", null], ["ex-c", 120], ["seed-a", null]]);
    assert.deepEqual(after.exercises.map(withoutField), before.exercises.map(withoutField)); // nothing else changed
    assert.deepEqual(after.workouts, before.workouts);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.sets, before.sets); // history is byte for byte what it was
    const meta = Object.fromEntries(after.meta.map((m) => [m.key, m.value]));
    assert.deepEqual(
      [meta.schemaVersion, meta.preferredUnit, meta.lastExportAt, meta.seedVersion],
      [SCHEMA_VERSION, "kg", "2026-10-02T00:00:00.000Z", 1],
    );

    // the export is the code's schema version and every exercise has the field
    const doc = JSON.parse(await createBackup(adapter).exportToText());
    assert.equal(doc.schemaVersion, SCHEMA_VERSION);
    assert.ok(doc.data.exercises.every((record) => "defaultRestSeconds" in record));
    assert.equal(doc.data.sets.length, 3);

    // opening again changes nothing (the upgrade runs once)
    adapter.close();
    const again = track(createIdbAdapter({ name }));
    await createStore(again).open();
    assert.deepEqual(await snapshot(again), after);
  });
});

rule("upgrade: if the upgrade fails the whole transaction is undone: still version 1, every record as it was", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion1(name, track);
    const failures = [
      // writes, then fails
      async ({ tx }) => {
        await tx.put("exercises", { id: "seed-a", name: "broken" });
        await tx.put("meta", { key: "schemaVersion", value: SCHEMA_VERSION });
        throw new Error("boom after writes");
      },
      // fails before it does anything
      () => {
        throw new Error("boom at once");
      },
    ];
    for (const upgrade of failures) {
      const adapter = track(createIdbAdapter({ name, upgrade }));
      await assert.rejects(adapter.open(), /storage upgrade failed and was undone/);
      adapter.close();
      assert.equal(await rawVersion(name), 1);
      const reader = track(createIdbAdapter({ name, version: 1 }));
      await reader.open();
      assert.deepEqual(await snapshot(reader), before);
      reader.close();
    }
    // and the real upgrade still works afterwards
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    assert.equal((await snapshot(adapter)).exercises.every((e) => "defaultRestSeconds" in e), true);
  });
});

rule("upgrade: while another connection blocks it, onBlocked is called, the open keeps waiting, and it finishes when the other closes", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    await makeVersion1(name, track);
    const holder = await holdConnection(name); // an open tab that does not step aside
    let blocked = 0;
    let finished = false;
    const adapter = track(createIdbAdapter({ name, onBlocked: () => { blocked += 1; } }));
    const opening = adapter.open().then(() => { finished = true; });
    await waitUntil(() => blocked > 0, "onBlocked to be called");
    await sleep(150);
    assert.equal(finished, false); // still waiting, not failed
    holder.close();
    await opening;
    assert.equal(finished, true);
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    assert.equal((await snapshot(adapter)).exercises.every((e) => "defaultRestSeconds" in e), true);
  });
});

rule("upgrade: without onBlocked a blocked open fails with a clear message, and the pending upgrade then completes intact", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion1(name, track);
    const holder = await holdConnection(name);
    const adapter = track(createIdbAdapter({ name }));
    await assert.rejects(adapter.open(), /blocked by another open connection/);
    // (Nothing else can open this database while the upgrade request is waiting, so the
    // data can only be looked at once the block is gone.)
    holder.close();
    await waitUntil(async () => (await rawVersion(name)) === SCHEMA_VERSION, "the pending upgrade to finish");
    const after = track(createIdbAdapter({ name }));
    await after.open();
    const state = await snapshot(after);
    assert.deepEqual(state.sets, before.sets);
    assert.deepEqual(state.workouts, before.workouts);
    assert.equal(state.exercises.every((e) => "defaultRestSeconds" in e), true);
  });
});

rule("versionchange: when another tab upgrades the database this connection closes itself and tells the page", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    let notified = 0;
    const adapter = track(createIdbAdapter({ name, onVersionChange: () => { notified += 1; } }));
    await adapter.open();
    const other = await new Promise((resolve, reject) => { // "another tab" asking for a newer version
      const request = indexedDB.open(name, SCHEMA_VERSION + 1);
      request.onupgradeneeded = () => {};
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    other.close();
    assert.equal(notified, 1);
    await assert.rejects(adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", "x")), /not open/);
  });
});

rule("upgrade: a version 2 database opened by a version 1 build is refused with a clear message and left alone", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion2(name, track);
    // What an older build does: it asks for version 1.
    const oldBuild = track(createIdbAdapter({ name, version: 1 }));
    await assert.rejects(oldBuild.open(), /saved by a newer version of Apogee/);
    assert.equal(await rawVersion(name), 2); // the fixture's own version, not the code's
    const again = track(createIdbAdapter({ name, version: 2 })); // reads it as version 2, without upgrading
    await again.open();
    assert.deepEqual(await snapshot(again), before);
  });
});
