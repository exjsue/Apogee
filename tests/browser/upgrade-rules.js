// Tests of the IndexedDB upgrade (schema version 1 to 2), run only against real
// IndexedDB in a browser. Each rule uses a database of its own, never the app's
// (tests/guard.test.js keeps it that way) and never the shared test database.

import { createIdbAdapter, deleteDatabase } from "../../src/storage/idb-adapter.js";
import { createStore } from "../../src/storage/store.js";
import { createBackup } from "../../src/backup/backup.js";
import { upgradeData } from "../../src/storage/migrations.js";
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

// ---- schema version 3 ----

// The seven fields schema version 3 adds, as a seed or custom record gets them when it is not grouped.
const V3_EMPTY = { baseMovementId: null, equipment: null, variations: [], upstreamId: null, catalogVersion: null, retired: false };

// A version 2 database (makeVersion2) plus a real paired seed, as version 2 stored it, with a set logged on it.
async function makeVersion2WithSeed(name, track) {
  await makeVersion2(name, track);
  const adapter = track(createIdbAdapter({ name, version: 2 }));
  await adapter.open();
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    await tx.put("exercises", rawV2Exercise({
      id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: ["adductors", "hamstrings", "lower_back"],
      equipmentTags: ["barbell"], notes: "my note", defaultRestSeconds: 150,
    }));
    await tx.put("entries", createWorkoutEntry({ id: "e2", workoutId: "w1", exerciseId: "seed-barbell-squat", order: 1 }));
    await tx.put("sets", createWorkSet({ id: "s2", entryId: "e2", order: 0, reps: 5, weightValue: 140, weightUnit: "kg", completedAt: "2026-10-01T10:20:00.000Z" }));
  });
  const before = await snapshot(adapter);
  adapter.close();
  return before;
}

rule("upgrade 2 to 3: a populated version 2 database becomes version 3; seeds are grouped, customs get origin custom, history is unchanged", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion2WithSeed(name, track);
    assert.equal(await rawVersion(name), 2);
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    const after = await snapshot(adapter);
    const byId = Object.fromEntries(after.exercises.map((e) => [e.id, e]));
    assert.deepEqual(byId["seed-barbell-squat"], {
      id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: ["adductors", "hamstrings", "lower_back"],
      equipmentTags: ["barbell"], notes: "my note", isCustom: false, defaultRestSeconds: 150,
      baseMovementId: "squat", equipment: "barbell", variations: [], origin: "seed", upstreamId: "Barbell_Squat", catalogVersion: null, retired: false,
    });
    assert.deepEqual(byId["ex-1"], { ...before.exercises.find((e) => e.id === "ex-1"), ...V3_EMPTY, origin: "custom" });
    assert.deepEqual(byId["seed-a"], { ...before.exercises.find((e) => e.id === "seed-a"), ...V3_EMPTY, origin: "seed" }); // not a real seed: no grouping
    assert.deepEqual(after.exercises.map(withoutField), before.exercises.map(withoutField)); // no older field changed
    assert.equal(JSON.stringify(after.workouts), JSON.stringify(before.workouts));
    assert.equal(JSON.stringify(after.entries), JSON.stringify(before.entries));
    assert.equal(JSON.stringify(after.sets), JSON.stringify(before.sets));
    const meta = Object.fromEntries(after.meta.map((m) => [m.key, m.value]));
    assert.deepEqual([meta.schemaVersion, meta.preferredUnit], [SCHEMA_VERSION, "kg"]);
    const doc = JSON.parse(await createBackup(adapter).exportToText());
    assert.equal(doc.schemaVersion, SCHEMA_VERSION);
    assert.equal(doc.data.sets.length, 2);
    // opening again changes nothing
    adapter.close();
    const again = track(createIdbAdapter({ name }));
    await createStore(again).open();
    assert.deepEqual(await snapshot(again), after);
  });
});

rule("upgrade 2 to 3: if the upgrade fails the whole transaction is undone: still version 2, every record as it was, and the real upgrade works afterwards", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion2WithSeed(name, track);
    const upgrade = async ({ tx }) => {
      await tx.put("exercises", { id: "seed-barbell-squat", name: "broken" });
      await tx.put("meta", { key: "schemaVersion", value: 3 });
      throw new Error("boom after writes");
    };
    const failing = track(createIdbAdapter({ name, upgrade }));
    await assert.rejects(failing.open(), /storage upgrade failed and was undone/);
    failing.close();
    assert.equal(await rawVersion(name), 2);
    const reader = track(createIdbAdapter({ name, version: 2 }));
    await reader.open();
    assert.deepEqual(await snapshot(reader), before);
    reader.close();
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    assert.equal((await snapshot(adapter)).exercises.find((e) => e.id === "seed-barbell-squat").upstreamId, "Barbell_Squat");
  });
});

rule("upgrade 1 to 3: a version 1 database goes through step 2 and step 3 in the one upgrade", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion1(name, track);
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    const after = await snapshot(adapter);
    assert.deepEqual(after.exercises.map((e) => [e.id, e.defaultRestSeconds, e.origin, e.baseMovementId]), [["ex-b", null, "custom", null], ["ex-c", 120, "seed", null], ["seed-a", null, "seed", null]]);
    assert.deepEqual(after.exercises.map(withoutField), before.exercises.map(withoutField));
    assert.equal(JSON.stringify(after.sets), JSON.stringify(before.sets));
    assert.equal(after.meta.find((m) => m.key === "schemaVersion").value, SCHEMA_VERSION);
  });
});

rule("upgrade: a version 3 database opened by a version 2 build is refused with a clear message and left alone", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    await makeVersion2WithSeed(name, track);
    const current = track(createIdbAdapter({ name }));
    await createStore(current).open(); // now the app's version (4)
    const before = await snapshot(current);
    current.close();
    const oldBuild = track(createIdbAdapter({ name, version: 2 })); // what a version 2 build asks for
    await assert.rejects(oldBuild.open(), /saved by a newer version of Apogee than this code \(schema 2\)/);
    assert.equal(await rawVersion(name), SCHEMA_VERSION);
    const again = track(createIdbAdapter({ name }));
    await again.open();
    assert.deepEqual(await snapshot(again), before);
  });
});

// ---- schema version 4: templates ----

// A database exactly as an older build created it: the five stores of schema versions 1 to 3 and their two
// indexes, and NO templates store. Made with indexedDB directly, not with createIdbAdapter, because the adapter
// creates every store schema.js lists (templates included) whatever version it is asked for.
const makeRawOld = (name, version, records) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const store of ["exercises", "workouts", "entries", "sets"]) db.createObjectStore(store, { keyPath: "id" });
    db.createObjectStore("meta", { keyPath: "key" });
    request.transaction.objectStore("entries").createIndex("workoutId", "workoutId");
    request.transaction.objectStore("sets").createIndex("entryId", "entryId");
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(STORES, "readwrite");
    for (const [store, list] of Object.entries(records)) for (const record of list) tx.objectStore(store).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  };
});

const storeNamesOf = (name) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name);
  request.onsuccess = () => {
    const names = [...request.result.objectStoreNames].sort();
    request.result.close();
    resolve(names);
  };
  request.onerror = () => reject(request.error);
});

// The exercise as each older schema stored it, and the same history for every version.
const V3_CUSTOM = {
  id: "ex-1", name: "Mine", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: [], notes: "n", isCustom: true, defaultRestSeconds: null,
  baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false,
};
const customAt = (version) => (version >= 3 ? V3_CUSTOM : version === 2 ? { ...withoutField(V3_CUSTOM), defaultRestSeconds: null } : withoutField(V3_CUSTOM));
const OLD_HISTORY = {
  workouts: [createWorkout({ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "done" })],
  entries: [createWorkoutEntry({ id: "e1", workoutId: "w1", exerciseId: "ex-1", order: 0 })],
  sets: [
    createWorkSet({ id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 62.5, weightUnit: "lb", isWarmup: true, completedAt: "2026-10-01T10:05:00.000Z" }),
    createWorkSet({ id: "s2", entryId: "e1", order: 1, reps: 5, weightValue: 100, weightUnit: "kg", restSeconds: 90 }),
  ],
};

for (const version of [1, 2, 3]) {
  rule(`upgrade ${version} to 4: a database with no templates store gets an empty one, schema version 4, and history byte for byte unchanged`, async (ctx) => {
    const { assert } = ctx;
    await withDatabase(async ({ name, track }) => {
      await makeRawOld(name, version, {
        exercises: [customAt(version)], ...OLD_HISTORY,
        meta: [{ key: "schemaVersion", value: version }, { key: "preferredUnit", value: "kg" }],
      });
      assert.deepEqual(await storeNamesOf(name), ["entries", "exercises", "meta", "sets", "workouts"]);
      const adapter = track(createIdbAdapter({ name }));
      const store = createStore(adapter);
      await store.open();
      assert.equal(await rawVersion(name), 5);
      assert.deepEqual(await storeNamesOf(name), ["entries", "exercises", "meta", "sets", "templates", "workouts"]);
      const after = await snapshot(adapter);
      assert.equal(JSON.stringify(after.workouts), JSON.stringify(OLD_HISTORY.workouts));
      assert.equal(JSON.stringify(after.entries), JSON.stringify(OLD_HISTORY.entries));
      assert.equal(JSON.stringify(after.sets), JSON.stringify(OLD_HISTORY.sets));
      assert.deepEqual(after.exercises, [V3_CUSTOM]);
      assert.deepEqual(after.meta.map((m) => [m.key, m.value]), [["preferredUnit", "kg"], ["schemaVersion", 5]]);
      assert.deepEqual(await store.listTemplates(), []);
      await store.saveTemplate({ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 1 }] });
      assert.equal((await store.listTemplates()).length, 1);
    });
  });
}

rule("upgrade: a version 4 database opened by a version 3 build is refused with a clear message, and its templates are left alone", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    await makeRawOld(name, 3, { exercises: [V3_CUSTOM], meta: [{ key: "schemaVersion", value: 3 }] });
    const current = track(createIdbAdapter({ name }));
    const store = createStore(current);
    await store.open();
    await store.saveTemplate({ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 2 }] });
    current.close();
    const oldBuild = track(createIdbAdapter({ name, version: 3 })); // what a version 3 build asks for
    await assert.rejects(oldBuild.open(), /saved by a newer version of Apogee than this code \(schema 3\)/);
    assert.equal(await rawVersion(name), 5);
    const again = track(createIdbAdapter({ name }));
    await again.open();
    assert.deepEqual(await again.transaction(["templates"], "readonly", (tx) => tx.getAll("templates")), [{ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 2 }] }]);
  });
});

// ---- schema version 5: optional workout name, set rpe and setType ----

const V5_STORES = [...STORES, "templates"];
const fullSnapshot = (adapter) => adapter.transaction(V5_STORES, "readonly", async (tx) => {
  const out = {};
  for (const storeName of V5_STORES) {
    out[storeName] = (await tx.getAll(storeName)).sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
  }
  return out;
});

// A real version 4 database: written with version 4 explicitly (the adapter creates every store, templates
// included), with the history, a template and session meta as raw records.
async function makeVersion4(name, track) {
  const adapter = track(createIdbAdapter({ name, version: 4 }));
  await adapter.open();
  const records = {
    exercises: [{ ...V3_CUSTOM, secondaryMuscles: ["triceps"], secondaryWeights: { triceps: 0.75 } }],
    ...OLD_HISTORY,
    templates: [{ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 2 }] }],
    meta: [{ key: "schemaVersion", value: 4 }, { key: "preferredUnit", value: "lb" }, { key: "workoutPlan", value: { exercises: ["ex-1"], rows: [], rev: 3 } }],
  };
  await adapter.transaction(V5_STORES, "readwrite", async (tx) => {
    for (const [storeName, list] of Object.entries(records)) for (const record of list) await tx.put(storeName, record);
  });
  const before = await fullSnapshot(adapter);
  adapter.close();
  return before;
}

const DATA_V5 = ["exercises", "workouts", "entries", "sets", "templates"];

rule("upgrade 4 to 5: a real version 4 database opened by this code becomes version 5 with every record byte for byte unchanged and no default name", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion4(name, track);
    assert.equal(await rawVersion(name), 4);
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), 5);
    const after = await fullSnapshot(adapter);
    for (const storeName of DATA_V5) assert.equal(JSON.stringify(after[storeName]), JSON.stringify(before[storeName]));
    assert.equal(after.workouts.some((workout) => "name" in workout), false);
    assert.deepEqual(after.meta.map((m) => [m.key, m.value]), [["preferredUnit", "lb"], ["schemaVersion", 5], ["workoutPlan", { exercises: ["ex-1"], rows: [], rev: 3 }]]);
    // opening again changes nothing
    adapter.close();
    const again = track(createIdbAdapter({ name }));
    await createStore(again).open();
    assert.deepEqual(await fullSnapshot(again), after);
  });
});

rule("upgrade 4 to 5: if the upgrade throws after step 5 ran, the database is still version 4 with every record as it was, and the real upgrade works afterwards", async (ctx) => {
  const { assert } = ctx;
  await withDatabase(async ({ name, track }) => {
    const before = await makeVersion4(name, track);
    const upgrade = async (args) => {
      await upgradeData(args); // step 5 writes schemaVersion 5 ...
      throw new Error("boom after step 5"); // ... and then the upgrade fails
    };
    const failing = track(createIdbAdapter({ name, upgrade }));
    await assert.rejects(failing.open(), /storage upgrade failed and was undone/);
    failing.close();
    assert.equal(await rawVersion(name), 4);
    const reader = track(createIdbAdapter({ name, version: 4 }));
    await reader.open();
    assert.deepEqual(await fullSnapshot(reader), before);
    reader.close();
    const adapter = track(createIdbAdapter({ name }));
    await createStore(adapter).open();
    assert.equal(await rawVersion(name), 5);
    assert.equal((await fullSnapshot(adapter)).meta.find((m) => m.key === "schemaVersion").value, 5);
  });
});
