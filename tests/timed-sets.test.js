// Schema 5, timed sets: a set with durationSeconds may leave out reps. The model limits, export and import, and
// every calculation and helper that reads reps. Expected values are written out by hand; none is computed with
// the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createBackup } from "../src/backup/backup.js";
import { createWorkSet } from "../src/domain/model.js";
import { personalRecords, prHistory } from "../src/domain/strength.js";
import { sessionsOf } from "../src/domain/top-set.js";
import { heaviestSet, ghostFor, buildExerciseBlocks } from "../src/domain/workout-plan.js";
import { templateFromWorkout } from "../src/domain/template.js";
import { draftFromWorkout, applyWorkoutEdit, localDate } from "../src/domain/workout-edit.js";
import { formatSetDuration, formatSetLine } from "../src/domain/format.js";

const NOW = "2026-10-31T12:00:00.000Z";
const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const SET = { id: "s", entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg" };
const { reps: _reps, ...NO_REPS } = SET;

// ---- the model ----

test("timed sets model: durationSeconds is optional, a whole number from 1 to 86400", () => {
  assert.equal(has(createWorkSet(SET), "durationSeconds"), false);
  for (const good of [1, 45, 86400]) assert.equal(createWorkSet({ ...SET, durationSeconds: good }).durationSeconds, good);
  for (const bad of [0, -5, 1.5, "30", null]) {
    assert.throws(() => createWorkSet({ ...SET, durationSeconds: bad }), /durationSeconds must be an integer >= 1/, String(bad));
  }
  assert.throws(() => createWorkSet({ ...SET, durationSeconds: 86401 }), /durationSeconds must be at most 86400/);
});

test("timed sets model: reps may be absent only with a duration; null, 0, negative and fractional reps are still refused", () => {
  const timed = createWorkSet({ ...NO_REPS, durationSeconds: 45 });
  assert.equal(has(timed, "reps"), false);
  assert.equal(timed.durationSeconds, 45);
  assert.deepEqual(createWorkSet({ ...SET, durationSeconds: 45 }).reps, 5); // both is allowed
  assert.throws(() => createWorkSet(NO_REPS), /reps must be a whole number/); // the existing message
  for (const [reps, message] of [[null, /reps must be a whole number/], [0, /reps must be at least 1/], [-1, /reps can't be negative/], [2.5, /reps must be a whole number/]]) {
    assert.throws(() => createWorkSet({ ...SET, reps, durationSeconds: 45 }), message, String(reps));
  }
});

// ---- export and import ----

const EXERCISE = {
  id: "ex-1", name: "Plank", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: true,
  defaultRestSeconds: null, baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null,
  catalogVersion: null, retired: false,
};
const DATA = {
  exercises: [EXERCISE],
  workouts: [{ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "" }],
  entries: [{ id: "e1", workoutId: "w1", exerciseId: "ex-1", order: 0, supersetGroup: null, notes: "" }],
  sets: [
    { id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 20, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: "2026-10-01T10:05:00.000Z" },
    { id: "s2", entryId: "e1", order: 1, weightValue: 0, weightUnit: "kg", isWarmup: false, restSeconds: 60, completedAt: "2026-10-01T10:10:00.000Z", durationSeconds: 45, rpe: 8 },
    { id: "s3", entryId: "e1", order: 2, reps: 10, weightValue: 0, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: "2026-10-01T10:15:00.000Z", durationSeconds: 30 },
  ],
  templates: [],
};
const fileAt = (schemaVersion, data) => JSON.stringify({ app: "apogee-export", exportFormat: 1, schemaVersion, exportedAt: NOW, data });
async function openBackup() {
  const adapter = createMemoryAdapter();
  await createStore(adapter).open();
  return { adapter, backup: createBackup(adapter) };
}
const rawSets = (adapter) => adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets"))
  .then((list) => list.sort((a, b) => (a.id < b.id ? -1 : 1)));

test("timed sets round trip: a timed set without reps and a set with reps and a duration survive export, import and export unchanged", async () => {
  const { adapter, backup } = await openBackup();
  await backup.importFromText(fileAt(5, DATA), { confirmReplace: true });
  assert.deepEqual(await rawSets(adapter), DATA.sets);
  assert.equal(has((await rawSets(adapter))[1], "reps"), false);
  const first = await backup.exportToText({ now: new Date(NOW) });
  assert.deepEqual(JSON.parse(first).data.sets, DATA.sets);
  const other = await openBackup();
  await other.backup.importFromText(first, { confirmReplace: true });
  assert.equal(await other.backup.exportToText({ now: new Date(NOW) }), first);
});

test("timed sets import: refused, and nothing replaced, for a schema 4 file with durationSeconds or without reps, and for a schema 5 set with neither reps nor a duration, or null reps", async () => {
  const { reps: _r, ...noReps } = DATA.sets[0];
  const cases = [
    [4, (d) => { d.sets[0].durationSeconds = 30; }, /set "s1": unknown field "durationSeconds"/],
    [4, (d) => { d.sets[0] = noReps; }, /set "s1": required field "reps" is missing/],
    [5, (d) => { d.sets[0] = noReps; }, /set "s1": required field "reps" is missing/],
    [5, (d) => { d.sets[1].reps = null; }, /set "s2": reps must be a whole number/],
    [5, (d) => { d.sets[1].durationSeconds = 0; }, /set "s2": durationSeconds must be an integer >= 1/],
  ];
  for (const [version, change, message] of cases) {
    const { adapter, backup } = await openBackup();
    await backup.importFromText(fileAt(5, { ...DATA, sets: [DATA.sets[0]] }), { confirmReplace: true });
    const before = await rawSets(adapter);
    const data = structuredClone(DATA);
    data.sets = data.sets.filter((set) => version === 5 || !has(set, "durationSeconds"));
    change(data);
    await assert.rejects(backup.importFromText(fileAt(version, data), { confirmReplace: true }), message);
    assert.deepEqual(await rawSets(adapter), before);
  }
});

// ---- calculations: a timed set changes nothing ----

// Flat set records as store.listFinishedSetRecords gives them: bench in three workouts, each a normal working set,
// plus a heavier timed set without reps in every workout.
const flat = (id, workoutId, day, fields) => ({
  id, workoutId, exerciseId: "bench", order: 0, weightUnit: "kg", isWarmup: false, completedAt: `2026-10-0${day}T10:00:00.000Z`, ...fields,
});
const NORMAL = [
  flat("n1", "w1", 1, { reps: 5, weightValue: 100 }),
  flat("n2", "w2", 2, { reps: 5, weightValue: 105 }),
  flat("n3", "w3", 3, { reps: 3, weightValue: 110 }),
  flat("bw", "w3", 3, { reps: 12, weightValue: 0, order: 1 }), // bodyweight: holds the most-reps record
];
const TIMED = [
  flat("t1", "w1", 1, { weightValue: 200, durationSeconds: 45, order: 2 }),
  flat("t2", "w3", 3, { weightValue: 0, durationSeconds: 600, order: 3 }),
  flat("t3", "w4", 4, { weightValue: 300, durationSeconds: 60 }), // a workout with only a timed set
];

test("timed sets: personal records, PR history, volume and e1RM are the same with the timed sets as without them, and never NaN or 0", () => {
  const without = personalRecords(NORMAL, "kg");
  const withTimed = personalRecords([...NORMAL, ...TIMED], "kg");
  assert.deepEqual(withTimed, without);
  assert.deepEqual(prHistory([...TIMED, ...NORMAL], "kg"), prHistory(NORMAL, "kg"));
  const { bench } = withTimed.records;
  assert.deepEqual([bench.weight.value, bench.e1rm.value, bench.volume.value, bench.reps.value], [110, 122.5, 525, 12]);
  assert.deepEqual(personalRecords(TIMED, "kg"), { records: {}, ignored: 0 });
});

test("timed sets: the Body top set, its best e1RM per session (sparkline) and the stall test are the same with the timed sets as without them", () => {
  const without = sessionsOf(NORMAL, "bench", "kg");
  assert.deepEqual(sessionsOf([...NORMAL, ...TIMED], "bench", "kg"), without);
  assert.deepEqual(without.map((session) => [session.workoutId, session.best, session.top.id]), [["w1", 116.7], ["w2", 122.5], ["w3", 121]].map(([w, best], i) => [w, best, ["n1", "n2", "n3"][i]]));
  assert.deepEqual(sessionsOf(TIMED, "bench", "kg"), []);
});

// ---- ghosts, the logged row, templates ----

test("timed sets: heaviestSet (last session's suggestion) skips a set without reps, even a heavier one; only timed sets give none", () => {
  const sets = [
    { id: "a", order: 0, reps: 8, weightValue: 100, weightUnit: "kg", isWarmup: false },
    { id: "b", order: 1, weightValue: 140, weightUnit: "kg", isWarmup: false, durationSeconds: 60 },
  ];
  assert.deepEqual(heaviestSet(sets), { reps: "8", weight: "100", unit: "kg" });
  assert.equal(heaviestSet([sets[1]]), null);
});

test("timed sets: a row below a checked timed set copies its weight only, never a rep count; the logged row carries the duration", () => {
  const timed = { id: "t", entryId: "e", order: 0, weightValue: 10, weightUnit: "kg", isWarmup: false, restSeconds: 60, completedAt: NOW, durationSeconds: 75 };
  const blocks = buildExerciseBlocks({
    entries: [{ id: "e", workoutId: "w", exerciseId: "x", order: 0 }],
    sets: [timed],
    plan: { exercises: ["x"], rows: [{ id: "r", exerciseId: "x", order: 1, reps: "", weight: "", unit: "kg", restSeconds: null, isWarmup: false }], rev: 0 },
    names: new Map([["x", "Plank"]]),
    timer: null,
    nowMs: Date.parse(NOW),
  });
  const [logged, planned] = blocks[0].rows;
  assert.equal(logged.durationSeconds, 75);
  assert.equal(has(logged, "reps") ? logged.reps : undefined, undefined);
  assert.deepEqual(planned.ghost, { reps: "", weight: "10", unit: "kg" });
  // ghostFor directly: the same rule
  assert.deepEqual(ghostFor([{ kind: "logged", reps: undefined, weight: 0, unit: "kg", isWarmup: false }, { reps: "", weight: "", unit: "kg" }], 1), { reps: "", weight: "0", unit: "kg" });
});

test("timed sets: a template counts a timed working set like any other set (nothing of the set is copied)", () => {
  const workout = {
    endedAt: NOW,
    entries: [{ exerciseId: "plank", order: 0, sets: [{ isWarmup: false, durationSeconds: 45, weightValue: 0 }, { isWarmup: true, durationSeconds: 20, weightValue: 0 }] }],
  };
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "Core" }).exercises, [{ exerciseId: "plank", setCount: 1 }]);
});

// ---- History edit (pure part; the stored round trip is in edit-rules.js) ----

test("timed sets edit draft: a timed set shows blank reps; saved blank it keeps no reps and its duration, rpe and setType; a normal or new set with blank reps is refused", () => {
  const original = {
    workout: { id: "w", startedAt: "2026-10-12T10:00:00.000Z", endedAt: "2026-10-12T10:30:00.000Z", notes: "" },
    entries: [{ id: "e", workoutId: "w", exerciseId: "x", order: 0, supersetGroup: null, notes: "" }],
    sets: [
      { id: "s1", entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: "2026-10-12T10:10:00.000Z" },
      { id: "s2", entryId: "e", order: 1, weightValue: 0, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: "2026-10-12T10:20:00.000Z", durationSeconds: 45, rpe: 9, setType: "failure" },
    ],
  };
  const detail = { ...original.workout, entries: [{ ...original.entries[0], exerciseName: "X", sets: original.sets }] };
  const draft = draftFromWorkout(detail);
  assert.deepEqual(draft.entries[0].sets.map((set) => set.reps), ["5", ""]);
  assert.equal(draft.date, localDate(original.workout.startedAt));
  const now = new Date("2026-10-20T00:00:00.000Z");
  draft.entries[0].sets[1].weight = "5";
  const { sets } = applyWorkoutEdit(original, draft, { now });
  assert.deepEqual(sets[1], { ...original.sets[1], weightValue: 5 });
  assert.deepEqual(sets[0], original.sets[0]);
  const blankNormal = structuredClone(draft);
  blankNormal.entries[0].sets[0].reps = "";
  assert.throws(() => applyWorkoutEdit(original, blankNormal, { now }), /set 1: reps is required/);
  const blankNew = structuredClone(draft);
  blankNew.entries[0].sets.push({ id: null, reps: "", weight: "0", unit: "kg", isWarmup: false });
  assert.throws(() => applyWorkoutEdit(original, blankNew, { now }), /set 3: reps is required/);
});

// ---- display ----

test("timed sets display: under a minute in seconds, then m:ss and h:mm:ss; a timed set at weight 0 shows no weight", () => {
  assert.deepEqual([1, 45, 59, 60, 75, 600, 3600, 86400].map(formatSetDuration), ["1 s", "45 s", "59 s", "1:00", "1:15", "10:00", "1:00:00", "24:00:00"]);
  assert.equal(formatSetLine({ weightValue: 0, durationSeconds: 45 }, "0 kg"), "45 s");
  assert.equal(formatSetLine({ weightValue: 10, durationSeconds: 75 }, "10 kg"), "1:15 · 10 kg");
  assert.equal(formatSetLine({ reps: 8, weightValue: 0, durationSeconds: 75 }, "0 kg"), "8 reps · 0 kg"); // reps win when present
  assert.equal(formatSetLine({ reps: 1, weightValue: 100 }, "100 kg"), "1 rep · 100 kg");
});
