// Export/import rule tests, shared by Node (memory adapter) and the browser
// page (IndexedDB adapter). No node:test import: each runner supplies
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
import {
  createBackup,
  inspectBackup,
  MAX_IMPORT_BYTES,
  RECORD_FIELDS,
} from "../src/backup/backup.js";
import { EXERCISE, makeDetails, rawCounts, failAfter } from "./store-rules.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";

export const NOW = "2026-10-22T12:00:00.000Z";
const DATA_STORES = ["exercises", "workouts", "entries", "sets"];
const EMPTY = { workouts: 0, entries: 0, sets: 0 };
const SECTION_LABELS = { exercises: "exercise", workouts: "workout", entries: "entry", sets: "set" };

export const backupRules = [];
const rule = (name, run) => backupRules.push({ name, run });

// ---- helpers ----

export async function openBackup(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  return { adapter, store, backup: createBackup(adapter) };
}

// Two exercises (one custom, with non-ASCII text), a workout with 2 entries and
// 6 sets, and a second workout with millisecond timestamps, a warm-up set,
// a pound weight and an end time. 2 exercises, 2 workouts, 3 entries, 8 sets.
export async function seedFull(store) {
  await store.saveExercise(EXERCISE);
  await store.saveExercise(createExercise({
    id: "ex-bench", name: "Bench press ünïcode 🏋️", primaryMuscles: ["chest"], isCustom: true, notes: "flat",
  }));
  const a = makeDetails("w1", 2, 3);
  await store.saveWorkoutWithDetails(a.workout, a.entries, a.sets);
  const b = makeDetails("w2", 1, 2);
  await store.saveWorkoutWithDetails(
    { ...b.workout, startedAt: "2026-10-21T09:30:15.789Z", endedAt: "2026-10-21T10:45:00.123Z", notes: "heavy" },
    b.entries,
    [
      {
        ...b.sets[0], isWarmup: true, restSeconds: 60, completedAt: "2026-10-21T09:35:00.456Z",
        weightValue: 62.5, weightUnit: "lb",
      },
      b.sets[1],
    ],
  );
}

// A canonical export file built by hand from canonical records.
export function fileOf(parts = {}, overrides = {}) {
  const { exercises = [], workouts = [], entries = [], sets = [] } = parts;
  return JSON.stringify({
    app: "apogee-export",
    exportFormat: 1,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: NOW,
    data: { exercises, workouts, entries, sets },
    ...overrides,
  });
}

// A small valid file that shares no ids with seedFull: 1 exercise, 1 workout, 1 entry, 2 sets.
export function incomingFile() {
  const d = makeDetails("b1", 1, 2);
  return fileOf({
    exercises: [createExercise({ id: "ex-row", name: "Row", primaryMuscles: ["lats"] })],
    workouts: [d.workout],
    entries: d.entries.map((entry) => ({ ...entry, exerciseId: "ex-row" })),
    sets: d.sets,
  });
}

const parse = (text) => JSON.parse(text);
const rawMeta = (adapter, key) => adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", key));
const mutate = (text, change) => {
  const doc = parse(text);
  change(doc);
  return JSON.stringify(doc);
};
// Adds an own property even when the key is "__proto__" (plain assignment would not).
function withOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}
const settle = (fn) => (async () => fn())();
const snapshot = (backup) => backup.exportToText({ now: NOW });
const wipe = (adapter) => adapter.transaction(DATA_STORES, "readwrite", async (tx) => {
  for (const section of DATA_STORES) await tx.clear(section);
});

// Both entry points must refuse the text with a message matching `pattern`,
// and the database must be exactly as it was.
async function expectRejected({ assert, backup }, text, pattern, options = {}) {
  const before = await snapshot(backup);
  await assert.rejects(backup.importFromText(text, { confirmReplace: true, ...options }), pattern);
  await assert.rejects(settle(() => inspectBackup(text, options)), pattern);
  assert.equal(await snapshot(backup), before);
}

async function messageOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  return null;
}

function expectNotPolluted(assert) {
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.keys(Object.prototype), []);
}

// ---- export ----

rule("export: the document has the specified shape", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  await seedFull(store);
  const doc = parse(await backup.exportToText({ now: NOW }));
  assert.deepEqual(Object.keys(doc), ["app", "exportFormat", "schemaVersion", "exportedAt", "data"]);
  assert.equal(doc.app, "apogee-export");
  assert.equal(doc.exportFormat, 1);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.exportedAt, NOW);
  assert.deepEqual(Object.keys(doc.data), DATA_STORES);
  assert.deepEqual(
    [doc.data.exercises.length, doc.data.workouts.length, doc.data.entries.length, doc.data.sets.length],
    [2, 2, 3, 8],
  );
});

rule("export: two exports of the same data are identical apart from exportedAt, sorted by id", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  await seedFull(store);
  const first = await backup.exportToText({ now: "2026-01-01T00:00:00Z" });
  const second = await backup.exportToText({ now: "2027-01-01T00:00:00Z" });
  assert.ok(first !== second);
  const stripped = (text) => {
    const doc = parse(text);
    delete doc.exportedAt;
    return JSON.stringify(doc);
  };
  assert.equal(stripped(first), stripped(second));
  assert.equal(await backup.exportToText({ now: NOW }), await backup.exportToText({ now: NOW }));
  const doc = parse(first);
  for (const section of DATA_STORES) {
    const ids = doc.data[section].map((record) => record.id);
    assert.deepEqual(ids, [...ids].sort());
    for (const record of doc.data[section]) {
      assert.deepEqual(Object.keys(record), Object.keys(record).sort());
    }
  }
});

rule("export: an empty database exports a valid, importable file", async (ctx) => {
  const { assert } = ctx;
  const { backup } = await openBackup(ctx);
  const text = await backup.exportToText({ now: NOW });
  assert.deepEqual(inspectBackup(text).counts, { exercises: 0, workouts: 0, entries: 0, sets: 0 });
  assert.deepEqual(await backup.importFromText(text, { confirmReplace: true }), { exercises: 0, workouts: 0, entries: 0, sets: 0 });
});

rule("export: generating an export writes nothing: it is not a backup until confirmed", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  assert.equal(await backup.getLastExportAt(), null);
  await backup.exportToText({ now: "2026-05-05T05:05:05.005Z" });
  assert.equal(await backup.getLastExportAt(), null);
  assert.deepEqual(await backup.getExportTimes(), { lastExportAt: null, lastExportAttemptAt: null });
  assert.equal(await rawMeta(adapter, "lastExportAt"), undefined);
});

rule("export: starting a download records an attempt, not a confirmed export", async (ctx) => {
  const { assert } = ctx;
  const { backup } = await openBackup(ctx);
  const { exportedAt } = await backup.exportForDownload({ now: NOW });
  assert.equal(exportedAt, NOW);
  await backup.recordExportAttempt(exportedAt);
  assert.deepEqual(await backup.getExportTimes(), { lastExportAt: null, lastExportAttemptAt: NOW });
  assert.equal(await backup.getLastExportAt(), null);
});

rule("export: only confirmExport sets lastExportAt, to the export's own time", async (ctx) => {
  const { assert } = ctx;
  const { backup } = await openBackup(ctx);
  await backup.confirmExport("2026-05-05T05:05:05.005Z");
  assert.equal(await backup.getLastExportAt(), "2026-05-05T05:05:05.005Z");
  assert.deepEqual(await backup.getExportTimes(), {
    lastExportAt: "2026-05-05T05:05:05.005Z",
    lastExportAttemptAt: null,
  });
});

rule("export: the text path records an attempt, and only its confirmation counts", async (ctx) => {
  const { assert } = ctx;
  const { backup } = await openBackup(ctx);
  const { text, exportedAt } = await backup.exportSnapshot({ now: NOW });
  assert.equal(parse(text).exportedAt, NOW);
  assert.equal(exportedAt, NOW);
  await backup.recordExportAttempt(exportedAt);
  assert.equal(await backup.getLastExportAt(), null);
  await backup.confirmExport(exportedAt);
  assert.equal(await backup.getLastExportAt(), NOW);
});

rule("export: a failed attempt or confirmation write rejects; it never reports a backup it did not record", async (ctx) => {
  const { assert } = ctx;
  const { adapter } = await openBackup(ctx);
  const broken = createBackup(failAfter(adapter, { puts: 0 }));
  await assert.rejects(broken.confirmExport(NOW));
  await assert.rejects(broken.recordExportAttempt(NOW));
  assert.equal(await createBackup(adapter).getLastExportAt(), null);
});

const putMeta = (adapter, key, value) => adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key, value }));
const metaValue = async (adapter, key) => (await rawMeta(adapter, key))?.value;

rule("migration: an old lastExportAt becomes an attempt, the old key is deleted and the version is set", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await putMeta(adapter, "lastExportAt", "2026-10-20T10:00:00.000Z");
  assert.deepEqual(await backup.migrateExportConfirmation(), { migrated: true, movedAttemptAt: "2026-10-20T10:00:00.000Z" });
  assert.equal(await rawMeta(adapter, "lastExportAt"), undefined);
  assert.equal(await metaValue(adapter, "lastExportAttemptAt"), "2026-10-20T10:00:00.000Z");
  assert.equal(await metaValue(adapter, "exportConfirmationVersion"), 1);
  assert.deepEqual(await backup.getExportTimes(), { lastExportAt: null, lastExportAttemptAt: "2026-10-20T10:00:00.000Z" });
});

rule("migration: an older existing attempt is replaced by the old value", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await putMeta(adapter, "lastExportAt", "2026-10-20T10:00:00.000Z");
  await putMeta(adapter, "lastExportAttemptAt", "2026-10-01T10:00:00.000Z");
  await backup.migrateExportConfirmation();
  assert.equal(await metaValue(adapter, "lastExportAttemptAt"), "2026-10-20T10:00:00.000Z");
  assert.equal(await rawMeta(adapter, "lastExportAt"), undefined);
});

rule("migration: a newer existing attempt is kept, and the old key is still deleted", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await putMeta(adapter, "lastExportAt", "2026-10-01T10:00:00.000Z");
  await putMeta(adapter, "lastExportAttemptAt", "2026-10-20T10:00:00.000Z");
  assert.deepEqual(await backup.migrateExportConfirmation(), { migrated: true, movedAttemptAt: null });
  assert.equal(await metaValue(adapter, "lastExportAttemptAt"), "2026-10-20T10:00:00.000Z");
  assert.equal(await rawMeta(adapter, "lastExportAt"), undefined);
  assert.equal(await metaValue(adapter, "exportConfirmationVersion"), 1);
});

rule("migration: already-migrated data is untouched, including a lastExportAt from the new flow", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await backup.migrateExportConfirmation();
  await backup.recordExportAttempt("2026-10-22T09:00:00.000Z");
  await backup.confirmExport("2026-10-22T09:00:00.000Z");
  assert.deepEqual(await backup.migrateExportConfirmation(), { migrated: false, movedAttemptAt: null });
  assert.deepEqual(await backup.getExportTimes(), {
    lastExportAt: "2026-10-22T09:00:00.000Z",
    lastExportAttemptAt: "2026-10-22T09:00:00.000Z",
  });
  assert.equal(await metaValue(adapter, "exportConfirmationVersion"), 1);
});

rule("migration: a fresh install with no values only sets the version, and running again changes nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  assert.deepEqual(await backup.migrateExportConfirmation(), { migrated: true, movedAttemptAt: null });
  assert.equal(await metaValue(adapter, "exportConfirmationVersion"), 1);
  assert.deepEqual(await backup.getExportTimes(), { lastExportAt: null, lastExportAttemptAt: null });
  assert.deepEqual(await backup.migrateExportConfirmation(), { migrated: false, movedAttemptAt: null });
  assert.deepEqual(await backup.getExportTimes(), { lastExportAt: null, lastExportAttemptAt: null });
});

rule("migration: a failed write rolls everything back, so the old value is not lost", async (ctx) => {
  const { assert } = ctx;
  const { adapter } = await openBackup(ctx);
  await putMeta(adapter, "lastExportAt", "2026-10-20T10:00:00.000Z");
  const broken = createBackup(failAfter(adapter, { puts: 1 }));
  await assert.rejects(broken.migrateExportConfirmation());
  assert.equal(await metaValue(adapter, "lastExportAt"), "2026-10-20T10:00:00.000Z");
  assert.equal(await rawMeta(adapter, "exportConfirmationVersion"), undefined);
  assert.equal(await rawMeta(adapter, "lastExportAttemptAt"), undefined);
});

rule("reminder inputs: counts workouts and reads the confirmed export and the dismissal", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  assert.deepEqual(await backup.getReminderInputs(), { lastExportAt: null, dismissedUntil: null, workoutCount: 0 });
  await seedFull(store);
  await backup.confirmExport(NOW);
  await backup.dismissReminder(new Date("2026-10-22T12:00:00.000Z"));
  assert.deepEqual(await backup.getReminderInputs(), {
    lastExportAt: NOW,
    dismissedUntil: "2026-10-29T12:00:00.000Z",
    workoutCount: (await store.listWorkouts()).length,
  });
});

rule("export: exportForDownload gives a blob, a dated filename and the same text", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  await seedFull(store);
  const { text, blob, filename } = await backup.exportForDownload({ now: NOW });
  assert.equal(await blob.text(), text);
  assert.equal(blob.type, "application/json");
  assert.ok(/^apogee-export-\d{4}-\d{2}-\d{2}\.json$/.test(filename));
  assert.equal(parse(text).exportedAt, NOW);
});

rule("export: seeded exercises are ordinary records, exported and restored by import", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const text = await backup.exportToText({ now: NOW });
  const exercises = parse(text).data.exercises;
  assert.equal(exercises.length, SEED_EXERCISES.length);
  assert.ok(exercises.every((exercise) => exercise.id.startsWith("seed-") && exercise.isCustom === false));
  await wipe(adapter);
  await backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual(await store.getExercise("seed-barbell-bench-press"), SEED_EXERCISES[0]);
  assert.equal(await snapshot(backup), text);
});

rule("the record field lists match what the domain model produces", async ({ assert }) => {
  const samples = {
    exercises: createExercise({ id: "x", name: "n", primaryMuscles: ["abs"] }),
    workouts: createWorkout({ id: "x", startedAt: NOW }),
    entries: createWorkoutEntry({ id: "x", workoutId: "w", exerciseId: "e", order: 0 }),
    sets: createWorkSet({ id: "x", entryId: "e", order: 0, reps: 1, weightValue: 0, weightUnit: "kg" }),
  };
  for (const section of DATA_STORES) {
    assert.deepEqual(Object.keys(samples[section]).sort(), [...RECORD_FIELDS[section]].sort());
  }
});

// ---- import: success ----

rule("round trip: export, wipe, import, export again gives the same file", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  const first = await backup.exportToText({ now: NOW });
  await wipe(adapter);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
  const counts = await backup.importFromText(first, { confirmReplace: true });
  assert.deepEqual(counts, { exercises: 2, workouts: 2, entries: 3, sets: 8 });
  assert.equal(await backup.exportToText({ now: NOW }), first);
});

rule("import: ids and timestamps survive a round trip unchanged", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  const first = await backup.exportToText({ now: NOW });
  await wipe(adapter);
  await backup.importFromText(first, { confirmReplace: true });
  const doc = parse(first);
  assert.deepEqual(await store.getExercise("ex-squat"), doc.data.exercises.find((r) => r.id === "ex-squat"));
  for (const record of doc.data.exercises) assert.deepEqual(await store.getExercise(record.id), record);
  for (const record of doc.data.workouts) assert.deepEqual(await store.getWorkout(record.id), record);
  for (const record of doc.data.entries) assert.deepEqual(await store.getEntry(record.id), record);
  for (const record of doc.data.sets) assert.deepEqual(await store.getSet(record.id), record);
  const w2 = await store.getWorkout("w2");
  assert.equal(w2.startedAt, "2026-10-21T09:30:15.789Z");
  assert.equal(w2.endedAt, "2026-10-21T10:45:00.123Z");
  assert.equal((await store.getSet("w2-e0-s0")).completedAt, "2026-10-21T09:35:00.456Z");
});

rule("currentCounts reports how many records of each type are stored", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  assert.deepEqual(await backup.currentCounts(), { exercises: 0, workouts: 0, entries: 0, sets: 0 });
  await seedFull(store);
  assert.deepEqual(await backup.currentCounts(), { exercises: 2, workouts: 2, entries: 3, sets: 8 });
});

rule("import: replaces a non-empty database, nothing is merged", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  await seedFull(store);
  const incoming = incomingFile();
  const counts = await backup.importFromText(incoming, { confirmReplace: true });
  assert.deepEqual(counts, { exercises: 1, workouts: 1, entries: 1, sets: 2 });
  assert.deepEqual(parse(await snapshot(backup)).data, parse(incoming).data);
  assert.equal(await store.getWorkout("w1"), null);
  assert.equal(await store.getExercise(EXERCISE.id), null);
});

rule("import: empty data sections are valid and replace everything with nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  const empty = fileOf();
  assert.deepEqual(inspectBackup(empty).counts, { exercises: 0, workouts: 0, entries: 0, sets: 0 });
  await backup.importFromText(empty, { confirmReplace: true });
  assert.deepEqual(await rawCounts(adapter), EMPTY);
  assert.deepEqual(await store.listWorkouts(), []);
});

rule("import: inspectBackup reports what a file holds without reading any database", async ({ assert }) => {
  const summary = inspectBackup(incomingFile());
  assert.deepEqual(summary, {
    exportedAt: NOW, schemaVersion: SCHEMA_VERSION, counts: { exercises: 1, workouts: 1, entries: 1, sets: 2 },
  });
});

rule("import: leaves the schema version and lastExportAt in meta alone", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await backup.confirmExport("2026-05-05T05:05:05.005Z");
  await backup.importFromText(incomingFile(), { confirmReplace: true });
  assert.equal(await backup.getLastExportAt(), "2026-05-05T05:05:05.005Z");
  const stored = await adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", "schemaVersion"));
  assert.deepEqual(stored, { key: "schemaVersion", value: SCHEMA_VERSION });
});

rule("import: a workout with 50 sets round-trips", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await store.saveExercise(EXERCISE);
  const d = makeDetails("big", 5, 10);
  await store.saveWorkoutWithDetails(d.workout, d.entries, d.sets);
  const first = await backup.exportToText({ now: NOW });
  assert.equal(parse(first).data.sets.length, 50);
  await wipe(adapter);
  await backup.importFromText(first, { confirmReplace: true });
  assert.equal(await backup.exportToText({ now: NOW }), first);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 5, sets: 50 });
});

// ---- import: confirmation ----

rule("import: refuses unless confirmReplace is exactly true", async (ctx) => {
  const { assert } = ctx;
  const { backup, store } = await openBackup(ctx);
  await seedFull(store);
  const before = await snapshot(backup);
  const incoming = incomingFile();
  await assert.rejects(backup.importFromText(incoming), /confirmReplace/);
  await assert.rejects(backup.importFromText(incoming, {}), /confirmReplace/);
  await assert.rejects(backup.importFromText(incoming, { confirmReplace: false }), /confirmReplace/);
  await assert.rejects(backup.importFromText(incoming, { confirmReplace: "yes" }), /confirmReplace/);
  await assert.rejects(backup.importFromText(incoming, { confirmReplace: 1 }), /confirmReplace/);
  await assert.rejects(backup.importFromText("not even a file"), /confirmReplace/);
  assert.equal(await snapshot(backup), before);
});

// ---- import: rejected files (the database must be untouched each time) ----

rule("import: rejects text that is not valid JSON, without quoting it", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  await expectRejected(env, "", /not valid JSON/);
  await expectRejected(env, "{", /not valid JSON/);
  await expectRejected(env, '{"private-note": SECRET-TOKEN-1', /not valid JSON/);
  const message = await messageOf(env.backup.importFromText('{"private-note": SECRET-TOKEN-1', { confirmReplace: true }));
  assert.ok(!message.includes("SECRET-TOKEN-1"));
  for (const text of ["[]", "null", "42", '"text"']) await expectRejected(env, text, /not an Apogee export/);
});

rule("import: rejects a wrong app marker or export format", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(env, mutate(good, (d) => { d.app = "strong-export"; }), /not an Apogee export/);
  await expectRejected(env, mutate(good, (d) => { delete d.app; }), /not an Apogee export/);
  await expectRejected(env, mutate(good, (d) => { d.exportFormat = 2; }), /exportFormat/);
  await expectRejected(env, mutate(good, (d) => { d.exportFormat = "1"; }), /exportFormat/);
});

rule("import: rejects a newer schemaVersion with a clear error, and an invalid one", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(env, mutate(good, (d) => { d.schemaVersion = SCHEMA_VERSION + 1; }), /newer version/);
  for (const bad of [0, -1, 1.5, "1", null]) {
    await expectRejected(env, mutate(good, (d) => { d.schemaVersion = bad; }), /schemaVersion/);
  }
  await expectRejected(env, mutate(good, (d) => { delete d.schemaVersion; }), /schemaVersion/);
});

rule("import: rejects a damaged document: exportedAt, data sections, unknown top-level fields", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(env, mutate(good, (d) => { delete d.exportedAt; }), /exportedAt/);
  await expectRejected(env, mutate(good, (d) => { d.exportedAt = "2026-10-22T12:00:00+02:00"; }), /exportedAt/);
  await expectRejected(env, mutate(good, (d) => { delete d.data; }), /data section/);
  await expectRejected(env, mutate(good, (d) => { d.data = []; }), /data section/);
  for (const section of DATA_STORES) {
    await expectRejected(env, mutate(good, (d) => { delete d.data[section]; }), new RegExp(`data\\.${section} must be a list`));
    await expectRejected(env, mutate(good, (d) => { d.data[section] = {}; }), new RegExp(`data\\.${section} must be a list`));
  }
  await expectRejected(env, mutate(good, (d) => { d.extra = 1; }), /file: unknown field "extra"/);
  await expectRejected(env, mutate(good, (d) => { d.data.extra = []; }), /data: unknown field "extra"/);
});

rule("import: rejects a record with a required field missing, naming the type, id and field", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  // the case from the spec: no startedAt must not be filled in with "now"
  await expectRejected(
    env,
    mutate(good, (d) => { delete d.data.workouts[0].startedAt; }),
    /workout "b1": required field "startedAt" is missing/,
  );
  for (const section of DATA_STORES) {
    const label = SECTION_LABELS[section];
    for (const field of RECORD_FIELDS[section]) {
      const text = mutate(good, (d) => { delete d.data[section][0][field]; });
      const id = parse(good).data[section][0].id;
      const where = field === "id" ? `${label} at index 0` : `${label} "${id}"`;
      await expectRejected(env, text, new RegExp(`${where}: required field "${field}" is missing`));
    }
  }
});

rule("import: rejects unknown extra fields, naming the field but not its value", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  for (const section of DATA_STORES) {
    const id = parse(good).data[section][0].id;
    const text = mutate(good, (d) => { d.data[section][0].colour = "SECRET-VALUE-2"; });
    await expectRejected(env, text, new RegExp(`${SECTION_LABELS[section]} "${id}": unknown field "colour"`));
    const message = await messageOf(env.backup.importFromText(text, { confirmReplace: true }));
    assert.ok(!message.includes("SECRET-VALUE-2"));
  }
});

rule("import: rejects a bad record, naming the type, id and field", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(env, mutate(good, (d) => { d.data.exercises[0].name = ""; }), /exercise "ex-row": name/);
  await expectRejected(env, mutate(good, (d) => { d.data.workouts[0].startedAt = "yesterday"; }), /workout "b1": startedAt/);
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.workouts[0].endedAt = "2000-01-01T00:00:00.000Z"; }),
    /workout "b1": endedAt/,
  );
  await expectRejected(env, mutate(good, (d) => { d.data.entries[0].order = -1; }), /entry "b1-e0": order/);
  await expectRejected(env, mutate(good, (d) => { d.data.sets[0].reps = 0; }), /set "b1-e0-s0": reps/);
  await expectRejected(env, mutate(good, (d) => { d.data.sets[0].weightUnit = "LB"; }), /set "b1-e0-s0": weightUnit/);
  await expectRejected(env, mutate(good, (d) => { d.data.sets[0].weightValue = -5; }), /set "b1-e0-s0": weight can't be negative/);
  await expectRejected(env, mutate(good, (d) => { d.data.exercises[0].id = ""; }), /exercise at index 0: id/);
  await expectRejected(env, mutate(good, (d) => { d.data.exercises[0] = "text"; }), /exercise at index 0: not an object/);
});

rule("import: rejects a set with absurd reps or weight, naming the limit and keeping the data", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].reps = 920319039; }),
    /set "b1-e0-s0": reps is above the maximum of 1000/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].reps = 1001; }),
    /set "b1-e0-s0": reps is above the maximum of 1000/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].weightValue = 2500.5; d.data.sets[0].weightUnit = "kg"; }),
    /set "b1-e0-s0": weight is above the maximum of 2500 kg/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].weightValue = 5512; d.data.sets[0].weightUnit = "lb"; }),
    /set "b1-e0-s0": weight is above the maximum of 5511.55 lb/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].weightValue = -3; }),
    /set "b1-e0-s0": weight can't be negative/,
  );
  // exactly on the limits is fine
  const onLimits = mutate(good, (d) => {
    d.data.sets[0].reps = 1000;
    d.data.sets[0].weightValue = 2500;
    d.data.sets[0].weightUnit = "kg";
  });
  assert.deepEqual(inspectBackup(onLimits).counts, { exercises: 1, workouts: 1, entries: 1, sets: 2 });
  await env.backup.importFromText(onLimits, { confirmReplace: true });
  assert.equal((await env.store.getSet("b1-e0-s0")).reps, 1000);
});

rule("import: rejects values the importer would otherwise rewrite (never invents or changes values)", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.workouts[0].startedAt = "2026-10-22T12:00:00+02:00"; }),
    /workout "b1": startedAt is not in its canonical form/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[0].completedAt = "2026-10-22T10:05:00Z"; }),
    /set "b1-e0-s0": completedAt is not in its canonical form/,
  );
});

rule("import: rejects duplicate ids within a type", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  for (const section of DATA_STORES) {
    const id = parse(good).data[section][0].id;
    await expectRejected(
      env,
      mutate(good, (d) => { d.data[section].push({ ...d.data[section][0] }); }),
      new RegExp(`${SECTION_LABELS[section]} "${id}": duplicate id`),
    );
  }
});

rule("import: rejects an orphan entry and an orphan set", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.entries[0].workoutId = "no-such-workout"; }),
    /entry "b1-e0": workoutId refers to a workout that is not in the file/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.entries[0].exerciseId = "no-such-exercise"; }),
    /entry "b1-e0": exerciseId refers to an exercise that is not in the file/,
  );
  await expectRejected(
    env,
    mutate(good, (d) => { d.data.sets[1].entryId = "no-such-entry"; }),
    /set "b1-e0-s1": entryId refers to an entry that is not in the file/,
  );
});

rule("import: error messages never contain the user's data", async (ctx) => {
  const { assert } = ctx;
  const { backup } = await openBackup(ctx);
  const good = incomingFile();
  const attempts = [
    mutate(good, (d) => {
      d.data.exercises[0].notes = "SECRET-NOTES-3";
      d.data.exercises[0].name = "SECRET-NAME-3";
      d.data.sets[0].reps = 0;
    }),
    mutate(good, (d) => { d.data.exercises[0].name = 12345; d.data.exercises[0].notes = "SECRET-NOTES-3"; }),
    mutate(good, (d) => { d.data.workouts[0].notes = "SECRET-NOTES-3"; d.data.workouts[0].startedAt = "SECRET-NAME-3"; }),
    mutate(good, (d) => { d.data.exercises[0].notes = "SECRET-NOTES-3"; d.data.exercises[0].SECRET_FIELD_VALUE = "SECRET-NAME-3"; }),
  ];
  for (const text of attempts) {
    const message = await messageOf(backup.importFromText(text, { confirmReplace: true }));
    assert.ok(message !== null);
    assert.ok(!message.includes("SECRET-NOTES-3"), message);
    assert.ok(!message.includes("SECRET-NAME-3"), message);
  }
});

rule("import: __proto__ and constructor keys are rejected and nothing is polluted", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  const good = incomingFile();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const payload = { polluted: "yes", prototype: { polluted: "yes" } };
    await expectRejected(env, mutate(good, (d) => withOwn(d, key, payload)), new RegExp(`file: unknown field "${key}"`));
    await expectRejected(env, mutate(good, (d) => withOwn(d.data, key, payload)), new RegExp(`data: unknown field "${key}"`));
    for (const section of DATA_STORES) {
      await expectRejected(
        env,
        mutate(good, (d) => withOwn(d.data[section][0], key, payload)),
        new RegExp(`${SECTION_LABELS[section]} "[^"]+": unknown field "${key}"`),
      );
    }
  }
  expectNotPolluted(assert);
});

rule("import: ids named like Object.prototype members are ordinary ids and survive a round trip", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  const file = fileOf({
    exercises: [createExercise({ id: "__proto__", name: "Odd ids", primaryMuscles: ["abs"] })],
    workouts: [createWorkout({ id: "constructor", startedAt: NOW })],
    entries: [createWorkoutEntry({ id: "toString", workoutId: "constructor", exerciseId: "__proto__", order: 0 })],
    sets: [createWorkSet({ id: "hasOwnProperty", entryId: "toString", order: 0, reps: 1, weightValue: 0, weightUnit: "kg" })],
  });
  assert.deepEqual(await backup.importFromText(file, { confirmReplace: true }), { exercises: 1, workouts: 1, entries: 1, sets: 1 });
  const exported = await snapshot(backup);
  assert.deepEqual(parse(exported).data, parse(file).data);
  await wipe(adapter);
  assert.deepEqual(await rawCounts(adapter), EMPTY);
  await backup.importFromText(exported, { confirmReplace: true });
  assert.equal(await snapshot(backup), exported);
  expectNotPolluted(assert);
});

rule("import: enforces the size limit in bytes, a parameter with a 50 MiB default", async (ctx) => {
  const { assert } = ctx;
  const env = { assert, ...(await openBackup(ctx)) };
  await seedFull(env.store);
  assert.equal(MAX_IMPORT_BYTES, 50 * 1024 * 1024);
  const small = incomingFile();
  await expectRejected(env, small, /too large/, { maxBytes: 100 });
  // "é" is one character but two bytes in UTF-8, so the limit is counted in bytes
  const wide = fileOf({
    exercises: [createExercise({ id: "ex-wide", name: "Wide", primaryMuscles: ["abs"], notes: "é".repeat(200) })],
  });
  const characters = wide.length;
  const bytes = new TextEncoder().encode(wide).length;
  assert.equal(bytes, characters + 200);
  await expectRejected(env, wide, /too large/, { maxBytes: characters + 100 });
  await expectRejected(env, wide, /too large/, { maxBytes: bytes - 1 });
  assert.deepEqual(inspectBackup(wide, { maxBytes: bytes }).counts, { exercises: 1, workouts: 0, entries: 0, sets: 0 });
  await env.backup.importFromText(wide, { confirmReplace: true, maxBytes: bytes });
  assert.deepEqual(await rawCounts(env.adapter), EMPTY);
});

// ---- import: atomicity ----

rule("a failing import leaves the previous data fully intact, including after reopening", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  const before = await snapshot(backup);
  const incoming = incomingFile(); // 1 + 1 + 1 + 2 = 5 puts
  const faults = [{ clears: 1 }, { clears: 3 }, { puts: 0 }, { puts: 1 }, { puts: 2 }, { puts: 3 }, { puts: 4 }];
  for (const fault of faults) {
    const failing = createBackup(failAfter(adapter, fault));
    await assert.rejects(failing.importFromText(incoming, { confirmReplace: true }), /injected failure/);
    assert.equal(await snapshot(backup), before);
  }
  adapter.close();
  await adapter.open();
  assert.equal(await snapshot(backup), before);
  await backup.importFromText(incoming, { confirmReplace: true }); // works once the fault is gone
  assert.deepEqual(parse(await snapshot(backup)).data, parse(incoming).data);
});

// ---- schema version 2: defaultRestSeconds on exercises ----

// An exercise record as a schema version 1 file has it: without defaultRestSeconds.
const v1Exercise = (input) => {
  const { defaultRestSeconds, ...record } = createExercise(input);
  return record;
};
const v1File = (extra = {}) => {
  const d = makeDetails("old1", 1, 2);
  return fileOf({
    exercises: [v1Exercise({ id: "ex-old", name: "Old row", primaryMuscles: ["lats"] }), v1Exercise({ id: "ex-old2", name: "Old curl", primaryMuscles: ["biceps"], isCustom: true })],
    workouts: [d.workout],
    entries: d.entries.map((entry) => ({ ...entry, exerciseId: "ex-old" })),
    sets: d.sets,
  }, { schemaVersion: 1, ...extra });
};

rule("import: an old schema version 1 file (exercises without defaultRestSeconds) imports into the new build, the field becoming null", async (ctx) => {
  const { assert } = ctx;
  const { store, backup } = await openBackup(ctx);
  const counts = await backup.importFromText(v1File(), { confirmReplace: true });
  assert.deepEqual(counts, { exercises: 2, workouts: 1, entries: 1, sets: 2 });
  const exercises = await store.listExercises();
  assert.deepEqual(exercises.map((e) => [e.id, e.defaultRestSeconds]), [["ex-old2", null], ["ex-old", null]]); // listed by name
  assert.equal((await store.getSet("old1-e0-s0")).restSeconds, null); // history is not rewritten
});

rule("import: old file in, new file out: the export is schema version 2 and imports again unchanged", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  await backup.importFromText(v1File(), { confirmReplace: true });
  const exported = await backup.exportToText({ now: NOW });
  const doc = parse(exported);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.exportFormat, 1);
  assert.ok(doc.data.exercises.every((record) => record.defaultRestSeconds === null));
  await wipe(adapter);
  await backup.importFromText(exported, { confirmReplace: true });
  assert.equal(await backup.exportToText({ now: NOW }), exported);
});

rule("import: a new file round-trips with its exercise defaults", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  await store.saveExercise({ ...(await store.getExercise("ex-bench")), defaultRestSeconds: 90 });
  const exported = await backup.exportToText({ now: NOW });
  assert.equal(parse(exported).data.exercises.find((e) => e.id === "ex-bench").defaultRestSeconds, 90);
  await wipe(adapter);
  await backup.importFromText(exported, { confirmReplace: true });
  assert.equal((await store.getExercise("ex-bench")).defaultRestSeconds, 90);
  assert.equal(await backup.exportToText({ now: NOW }), exported);
});

rule("import: each schema is strict about its own fields: v1 must not have defaultRestSeconds, v2 must", async (ctx) => {
  const { assert } = ctx;
  const { adapter, backup } = await openBackup(ctx);
  const withField = mutate(v1File(), (doc) => { doc.data.exercises[0].defaultRestSeconds = null; });
  await assert.rejects(backup.importFromText(withField, { confirmReplace: true }), /unknown field "defaultRestSeconds"/);
  const without = mutate(incomingFile(), (doc) => { delete doc.data.exercises[0].defaultRestSeconds; });
  await assert.rejects(backup.importFromText(without, { confirmReplace: true }), /required field "defaultRestSeconds" is missing/);
  for (const bad of [-1, 1.5, 3601, "90", true]) {
    const file = mutate(incomingFile(), (doc) => { doc.data.exercises[0].defaultRestSeconds = bad; });
    await assert.rejects(backup.importFromText(file, { confirmReplace: true }), /defaultRestSeconds/, String(bad));
  }
  assert.deepEqual(await rawCounts(adapter), EMPTY); // nothing was written
});

rule("import: a file from a newer schema is refused before anything is written", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  const before = await backup.exportToText({ now: NOW });
  const future = mutate(incomingFile(), (doc) => { doc.schemaVersion = SCHEMA_VERSION + 1; });
  await assert.rejects(backup.importFromText(future, { confirmReplace: true }), /newer version of Apogee.*Update the app/);
  assert.equal(await backup.exportToText({ now: NOW }), before);
  assert.equal((await rawMeta(adapter, "schemaVersion")).value, SCHEMA_VERSION);
});

rule("export: writes the code's SCHEMA_VERSION whatever the stored value says, and gives every exercise the field", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await openBackup(ctx);
  await seedFull(store);
  // Data as an old build left it: a stored schema version of 1 and an exercise without the field.
  await adapter.transaction(["meta", "exercises"], "readwrite", async (tx) => {
    await tx.put("meta", { key: "schemaVersion", value: 1 });
    await tx.put("exercises", v1Exercise({ id: "ex-legacy", name: "Legacy", primaryMuscles: ["calves"] }));
  });
  const doc = parse(await backup.exportToText({ now: NOW }));
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.data.exercises.find((e) => e.id === "ex-legacy").defaultRestSeconds, null);
  assert.ok(doc.data.exercises.every((record) => "defaultRestSeconds" in record));
});
