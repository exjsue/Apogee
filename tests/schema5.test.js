// Schema version 5: the optional workout name and set rpe and setType. The model limits, the 4-to-5 upgrade step
// (memory adapter), and export and import of version 4 and version 5 files. Expected values are written out by
// hand; none is computed with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { upgradeData, STEPS } from "../src/storage/migrations.js";
import { createBackup } from "../src/backup/backup.js";
import { createWorkout, createWorkSet } from "../src/domain/model.js";

const NOW = "2026-10-31T12:00:00.000Z";
const ALL = ["exercises", "workouts", "entries", "sets", "templates", "meta"];
const DATA = ["exercises", "workouts", "entries", "sets", "templates"];
const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

// ---- the model ----

const WORKOUT = { id: "w", startedAt: "2026-10-01T10:00:00.000Z" };
const SET = { id: "s", entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg" };

test("schema 5 model: a workout without a name has no name field; a name is stored with whitespace collapsed", () => {
  assert.equal(has(createWorkout(WORKOUT), "name"), false);
  assert.equal(createWorkout({ ...WORKOUT, name: "Explosiveness ☝🏽" }).name, "Explosiveness ☝🏽");
  assert.equal(createWorkout({ ...WORKOUT, name: "  Leg\n\tday  " }).name, "Leg day");
  for (const bad of ["", "   ", "\n", null, 5]) {
    assert.throws(() => createWorkout({ ...WORKOUT, name: bad }), /name must be a non-empty string/, JSON.stringify(bad));
  }
});

test("schema 5 model: a workout name counts code points, not UTF-16 units: 80 are accepted, 81 refused, emoji included", () => {
  const emoji80 = "☝🏽".repeat(40); // 80 code points, 160 UTF-16 units
  assert.equal([...emoji80].length, 80);
  assert.equal(createWorkout({ ...WORKOUT, name: emoji80 }).name, emoji80);
  assert.throws(() => createWorkout({ ...WORKOUT, name: `${emoji80}a` }), /name must be at most 80 characters/);
  assert.equal(createWorkout({ ...WORKOUT, name: "a".repeat(80) }).name, "a".repeat(80));
  assert.throws(() => createWorkout({ ...WORKOUT, name: "a".repeat(81) }), /name must be at most 80 characters/);
  // Whitespace collapsed first: 80 letters with runs of spaces around them still fit.
  assert.equal(createWorkout({ ...WORKOUT, name: `   ${"a".repeat(80)}   ` }).name, "a".repeat(80));
});

test("schema 5 model: rpe is optional, 1 to 10 in steps of 0.5, and allowed on a warm-up", () => {
  assert.equal(has(createWorkSet(SET), "rpe"), false);
  for (const good of [1, 1.5, 7.5, 10]) assert.equal(createWorkSet({ ...SET, rpe: good }).rpe, good);
  assert.equal(createWorkSet({ ...SET, isWarmup: true, rpe: 6 }).rpe, 6);
  assert.throws(() => createWorkSet({ ...SET, rpe: 0.5 }), /rpe must be from 1 to 10/);
  assert.throws(() => createWorkSet({ ...SET, rpe: 0 }), /rpe must be from 1 to 10/);
  assert.throws(() => createWorkSet({ ...SET, rpe: 10.5 }), /rpe must be from 1 to 10/);
  assert.throws(() => createWorkSet({ ...SET, rpe: 0.75 }), /rpe must be from 1 to 10/);
  assert.throws(() => createWorkSet({ ...SET, rpe: 7.25 }), /rpe must be in steps of 0\.5/);
  for (const bad of ["8", null, Number.NaN, Infinity]) {
    assert.throws(() => createWorkSet({ ...SET, rpe: bad }), /rpe must be a number/, String(bad));
  }
});

test("schema 5 model: setType is optional and only failure or drop", () => {
  assert.equal(has(createWorkSet(SET), "setType"), false);
  assert.equal(createWorkSet({ ...SET, setType: "failure" }).setType, "failure");
  assert.equal(createWorkSet({ ...SET, setType: "drop" }).setType, "drop");
  for (const bad of ["warmup", "Failure", "", null, 1]) {
    assert.throws(() => createWorkSet({ ...SET, setType: bad }), /setType must be a known set type/, String(bad));
  }
});

// ---- the upgrade ----

// A schema version 4 database as it is stored: every record type, every optional value used, and session meta.
const V4_RECORDS = {
  exercises: [{
    id: "ex-1", name: "Mine", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentTags: ["barbell"], notes: "n",
    isCustom: true, defaultRestSeconds: 90, baseMovementId: null, equipment: null, variations: [], origin: "custom",
    upstreamId: null, catalogVersion: null, retired: false, secondaryWeights: { triceps: 0.75 },
  }],
  workouts: [
    { id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "done" },
    { id: "w2", startedAt: "2026-10-20T10:00:00.000Z", endedAt: null, notes: "" },
  ],
  entries: [
    { id: "e1", workoutId: "w1", exerciseId: "ex-1", order: 0, supersetGroup: "g1", notes: "grip" },
    { id: "e2", workoutId: "w2", exerciseId: "ex-1", order: 0, supersetGroup: null, notes: "" },
  ],
  sets: [
    { id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 62.5, weightUnit: "lb", isWarmup: true, restSeconds: 60, completedAt: "2026-10-01T10:05:00.000Z" },
    { id: "s2", entryId: "e1", order: 1, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: "2026-10-01T10:10:00.000Z" },
    { id: "s3", entryId: "e2", order: 0, reps: 12, weightValue: 0, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: null },
  ],
  templates: [{ id: "t1", name: "Chest", exercises: [{ exerciseId: "ex-1", setCount: 3 }] }],
  meta: [
    { key: "schemaVersion", value: 4 },
    { key: "preferredUnit", value: "lb" },
    { key: "workoutPlan", value: { exercises: ["ex-1"], rows: [], rev: 2 } },
  ],
};

async function populatedV4() {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await adapter.transaction(ALL, "readwrite", async (tx) => {
    for (const [name, list] of Object.entries(V4_RECORDS)) for (const record of list) await tx.put(name, record);
  });
  return adapter;
}
const dump = (adapter) => adapter.transaction(ALL, "readonly", async (tx) => {
  const out = {};
  for (const name of ALL) out[name] = (await tx.getAll(name)).sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
  return out;
});
const upgrade = (adapter, oldVersion) => adapter.transaction(ALL, "readwrite", (tx) => upgradeData({ oldVersion, tx }));

test("schema 5 upgrade: from version 4 only step 5 runs; every record is byte for byte unchanged and only the stored version becomes 5", async () => {
  const adapter = await populatedV4();
  const before = await dump(adapter);
  assert.deepEqual(await upgrade(adapter, 4), [5]);
  const after = await dump(adapter);
  for (const name of DATA) assert.equal(JSON.stringify(after[name]), JSON.stringify(before[name]), name);
  assert.equal(after.workouts.some((workout) => has(workout, "name")), false); // no default name
  assert.deepEqual(after.meta, [
    { key: "preferredUnit", value: "lb" },
    { key: "schemaVersion", value: 5 },
    { key: "workoutPlan", value: { exercises: ["ex-1"], rows: [], rev: 2 } },
  ]);
});

test("schema 5 upgrade: safe to run twice: run again from 4 it changes nothing, and from 5 no step runs", async () => {
  const adapter = await populatedV4();
  await upgrade(adapter, 4);
  const settled = await dump(adapter);
  assert.deepEqual(await upgrade(adapter, 4), [5]);
  assert.deepEqual(await dump(adapter), settled);
  assert.deepEqual(await upgrade(adapter, 5), []);
  assert.deepEqual(await dump(adapter), settled);
});

test("schema 5 upgrade: the 4-to-5 step reads and writes nothing at all", async () => {
  const calls = [];
  const spy = new Proxy({}, { get: (_target, method) => async (...args) => { calls.push([method, ...args.slice(0, 1)]); } });
  await STEPS.find((step) => step.to === 5).run(spy);
  assert.deepEqual(calls, []);
});

// ---- export and import ----

async function openBackup() {
  const adapter = createMemoryAdapter();
  await createStore(adapter).open();
  return { adapter, backup: createBackup(adapter) };
}
const fileAt = (schemaVersion, data) => JSON.stringify({ app: "apogee-export", exportFormat: 1, schemaVersion, exportedAt: NOW, data });
const V4_DATA = Object.fromEntries(DATA.map((name) => [name, V4_RECORDS[name]]));
const rawData = (adapter) => dump(adapter).then((all) => Object.fromEntries(DATA.map((name) => [name, all[name]])));

test("schema 5 import: a version 4 file imports unchanged, and exports again as version 5 with the same records", async () => {
  const { adapter, backup } = await openBackup();
  await backup.importFromText(fileAt(4, V4_DATA), { confirmReplace: true });
  assert.deepEqual(await rawData(adapter), V4_DATA);
  const doc = JSON.parse(await backup.exportToText({ now: new Date(NOW) }));
  assert.equal(doc.schemaVersion, 5);
  assert.deepEqual(doc.data, V4_DATA);
});

// [section, index, field, value]: each schema 5 field on a record of a file that says it is an older version.
const NEW_FIELDS = [["workouts", 0, "name", "Push"], ["sets", 1, "rpe", 8], ["sets", 1, "setType", "failure"]];

for (const version of [3, 4]) {
  for (const [section, index, field, value] of NEW_FIELDS) {
    test(`schema 5 import: a version ${version} file with ${section} ${field} is refused and nothing is replaced`, async () => {
      const { adapter, backup } = await openBackup();
      await backup.importFromText(fileAt(4, V4_DATA), { confirmReplace: true });
      const before = await rawData(adapter);
      const data = structuredClone(V4_DATA);
      if (version < 4) { // a version 3 file had neither templates nor secondaryWeights
        delete data.templates;
        delete data.exercises[0].secondaryWeights;
      }
      data[section][index][field] = value;
      await assert.rejects(backup.importFromText(fileAt(version, data), { confirmReplace: true }), new RegExp(`unknown field "${field}"`));
      assert.deepEqual(await rawData(adapter), before);
    });
  }
}

// A version 5 file using all three fields, in every allowed form.
const V5_DATA = structuredClone(V4_DATA);
V5_DATA.workouts[0].name = "Explosiveness ☝🏽";
Object.assign(V5_DATA.sets[0], { rpe: 6, setType: "drop" }); // a warm-up
Object.assign(V5_DATA.sets[1], { rpe: 9.5, setType: "failure" });

test("schema 5 round trip: name, rpe and setType survive export, import and export unchanged", async () => {
  const { adapter, backup } = await openBackup();
  await backup.importFromText(fileAt(5, V5_DATA), { confirmReplace: true });
  assert.deepEqual(await rawData(adapter), V5_DATA);
  const first = await backup.exportToText({ now: new Date(NOW) });
  assert.deepEqual(JSON.parse(first).data, V5_DATA);
  const other = await openBackup();
  await other.backup.importFromText(first, { confirmReplace: true });
  assert.equal(await other.backup.exportToText({ now: new Date(NOW) }), first);
});

test("schema 5 import: a version 5 file with a field out of its limits is refused, naming the record", async () => {
  const cases = [
    [(d) => { d.workouts[0].name = "a".repeat(81); }, /workout "w1": name must be at most 80 characters/],
    [(d) => { d.workouts[0].name = " Push "; }, /workout "w1": name is not in its canonical form/],
    [(d) => { d.sets[1].rpe = 10.5; }, /set "s2": rpe must be from 1 to 10/],
    [(d) => { d.sets[1].rpe = 0.75; }, /set "s2": rpe must be from 1 to 10/],
    [(d) => { d.sets[1].setType = "warmup"; }, /set "s2": setType must be a known set type/],
  ];
  for (const [change, message] of cases) {
    const { adapter, backup } = await openBackup();
    const data = structuredClone(V5_DATA);
    change(data);
    await assert.rejects(backup.importFromText(fileAt(5, data), { confirmReplace: true }), message);
    assert.deepEqual(await rawData(adapter), { exercises: [], workouts: [], entries: [], sets: [], templates: [] });
  }
});
