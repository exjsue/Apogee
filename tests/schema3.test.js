// Schema version 3: the catalog fields on exercises, the 2-to-3 upgrade step, seeds, export and import.
// These guard data that already exists on users' devices, so every expected value is written out here by hand;
// none is computed with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { upgradeData, STEPS, stepTo3 } from "../src/storage/migrations.js";
import { createBackup } from "../src/backup/backup.js";
import { createLogger } from "../src/app/logger.js";
import { createExercise, SCHEMA_VERSION } from "../src/domain/model.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { failAfter } from "./store-rules.js";

const STORES = ["exercises", "workouts", "entries", "sets", "meta"];
const NOW = "2026-10-23T10:00:00.000Z";

// seed id -> [base movement, equipment, variations, upstream id]: the 15 confirmed pairs and the hand-set lat pulldown.
const GROUPING = {
  "seed-barbell-bench-press": ["bench-press", "barbell", ["medium-grip"], "Barbell_Bench_Press_-_Medium_Grip"],
  "seed-barbell-row": ["row", "barbell", ["bent-over"], "Bent_Over_Barbell_Row"],
  "seed-barbell-squat": ["squat", "barbell", [], "Barbell_Squat"],
  "seed-conventional-deadlift": ["deadlift", "barbell", [], "Barbell_Deadlift"],
  "seed-dumbbell-curl": ["curl", "dumbbell", [], "Dumbbell_Bicep_Curl"],
  "seed-dumbbell-lateral-raise": ["lateral-raise", "dumbbell", [], "Side_Lateral_Raise"],
  "seed-hip-thrust": ["hip-thrust", "barbell", [], "Barbell_Hip_Thrust"],
  "seed-incline-dumbbell-press": ["bench-press", "dumbbell", ["incline"], "Incline_Dumbbell_Press"],
  "seed-lat-pulldown": ["pulldown", "cable", [], null],
  "seed-leg-press": ["leg-press", "machine", [], "Leg_Press"],
  "seed-overhead-press": ["overhead-press", "barbell", ["standing"], "Standing_Military_Press"],
  "seed-pull-up": ["pull-up", "bodyweight", [], "Pullups"],
  "seed-romanian-deadlift": ["deadlift", "barbell", ["romanian"], "Romanian_Deadlift"],
  "seed-seated-leg-curl": ["leg-curl", "machine", ["seated"], "Seated_Leg_Curl"],
  "seed-standing-calf-raise": ["calf-raise", "machine", ["standing"], "Standing_Calf_Raises"],
  "seed-triceps-pushdown": ["triceps-pushdown", "cable", [], "Triceps_Pushdown"],
};
const NEW_FIELDS = ["baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired"];
const legacy = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !NEW_FIELDS.includes(key)));
const v1Shape = (record) => { const { defaultRestSeconds, ...rest } = legacy(record); return rest; };

// The fresh seed-barbell-squat, as schema 3 stores it.
const SQUAT_V3 = {
  id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: ["adductors", "hamstrings", "lower_back"],
  equipmentTags: ["barbell"], notes: "", isCustom: false, defaultRestSeconds: null,
  baseMovementId: "squat", equipment: "barbell", variations: [], origin: "seed", upstreamId: "Barbell_Squat", catalogVersion: null, retired: false,
};

// ---- createExercise ----

test("schema 3 model: a record with every field set to a non-default value comes back from createExercise unchanged (no field is dropped)", () => {
  const record = {
    id: "apogee-pin-squat", name: "Pin squat", primaryMuscles: ["quads", "neck"], secondaryMuscles: ["abductors"], equipmentTags: ["trap_bar", "other"],
    notes: "own note", isCustom: false, defaultRestSeconds: 90,
    baseMovementId: "squat", equipment: "trap_bar", variations: ["box", "pins"], origin: "authored", upstreamId: "Pin_Squat", catalogVersion: 2, retired: true,
  };
  assert.deepEqual(createExercise(record), record);
  const custom = { ...record, id: "c1", isCustom: true, origin: "custom", upstreamId: null, catalogVersion: null, retired: false };
  assert.deepEqual(createExercise(custom), custom);
});

test("schema 3 model: an exercise saved before schema 3 gets the seven fields with their defaults, and origin follows isCustom", () => {
  assert.deepEqual(createExercise({ id: "a", name: "A", primaryMuscles: ["chest"] }), {
    id: "a", name: "A", primaryMuscles: ["chest"], secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: false, defaultRestSeconds: null,
    baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false,
  });
  assert.equal(createExercise({ id: "b", name: "B", primaryMuscles: ["chest"], isCustom: true }).origin, "custom");
  // null is accepted where the default is null
  const nulls = createExercise({ id: "a", name: "A", primaryMuscles: ["chest"], baseMovementId: null, equipment: null, upstreamId: null, catalogVersion: null });
  assert.deepEqual([nulls.baseMovementId, nulls.equipment, nulls.upstreamId, nulls.catalogVersion], [null, null, null, null]);
});

test("schema 3 model: each new field is validated, and the messages never repeat the offending value", () => {
  const base = { id: "a", name: "A", primaryMuscles: ["chest"] };
  const cases = [
    [{ origin: "elsewhere" }, /origin must be one of seed, upstream, authored, custom/],
    [{ origin: "custom" }, /origin must be "custom" exactly when isCustom is true/],
    [{ isCustom: true, origin: "seed" }, /origin must be "custom" exactly when isCustom is true/],
    [{ origin: null }, /origin must be one of/],
    [{ baseMovementId: "Bench-Press" }, /baseMovementId must be lower-case words joined by single hyphens/],
    [{ baseMovementId: "bench--press" }, /baseMovementId must be lower-case/],
    [{ baseMovementId: "bench_press" }, /baseMovementId must be lower-case/],
    [{ baseMovementId: "a".repeat(41) }, /at most 40 characters/],
    [{ baseMovementId: 7 }, /baseMovementId must be lower-case/],
    [{ variations: ["pins", "box"] }, /variations must be sorted/],
    [{ variations: ["box", "box"] }, /variations must not contain duplicates/],
    [{ variations: ["Box"] }, /variations\[0\] must be lower-case/],
    [{ variations: Array.from({ length: 13 }, (_, i) => `v-${String(i).padStart(2, "0")}`) }, /variations must have at most 12 entries/],
    [{ variations: "box" }, /variations must be an array of strings/],
    [{ equipment: "spaceship" }, /equipment must be a known equipment/],
    [{ equipmentTags: ["spaceship"] }, /equipmentTags\[0\] must be a known equipment tag/],
    [{ catalogVersion: 0 }, /catalogVersion must be an integer >= 1/],
    [{ catalogVersion: 1.5 }, /catalogVersion must be an integer >= 1/],
    [{ catalogVersion: "1" }, /catalogVersion must be an integer >= 1/],
    [{ retired: "yes" }, /retired must be true or false/],
    [{ retired: null }, /retired must be true or false/],
    [{ upstreamId: "" }, /upstreamId must be a non-empty string/],
    [{ primaryMuscles: ["elbow"] }, /primaryMuscles\[0\] must be a known muscle/],
  ];
  for (const [extra, message] of cases) {
    assert.throws(() => createExercise({ ...base, ...extra }), message, JSON.stringify(extra));
  }
  assert.doesNotThrow(() => createExercise({ ...base, variations: Array.from({ length: 12 }, (_, i) => `v-${String(i).padStart(2, "0")}`) }));
  for (const [extra, secret] of [[{ baseMovementId: "SECRET-1" }, "SECRET"], [{ variations: ["SECRET"] }, "SECRET"], [{ equipment: "SECRET" }, "SECRET"], [{ origin: "SECRET" }, "SECRET"]]) {
    assert.throws(() => createExercise({ ...base, ...extra }), (error) => !error.message.includes(secret));
  }
});

test("schema 3 model: neck and abductors are accepted as primary and secondary muscles, the extra equipment ids as tags, and unknown properties are ignored", () => {
  const record = createExercise({ id: "a", name: "A", primaryMuscles: ["neck"], secondaryMuscles: ["abductors"], equipmentTags: ["medicine_ball", "exercise_ball", "foam_roll"], madeUp: true, category: "strength" });
  assert.deepEqual([record.primaryMuscles, record.secondaryMuscles, record.equipmentTags], [["neck"], ["abductors"], ["medicine_ball", "exercise_ball", "foam_roll"]]);
  assert.equal("madeUp" in record, false);
  assert.equal("category" in record, false);
  const input = ["box", "pins"];
  const copy = createExercise({ id: "a", name: "A", primaryMuscles: ["chest"], variations: input });
  input.push("zz");
  assert.deepEqual(copy.variations, ["box", "pins"]); // a copy, not the caller's list
});

// ---- the 2-to-3 upgrade step ----

// A schema version 2 database: the 16 seeds as version 2 stored them (one edited by the user), two custom
// exercises, a short history, and settings in meta.
async function populatedV2() {
  const adapter = createMemoryAdapter();
  await adapter.open();
  const seeds = SEED_EXERCISES.map(legacy).map((s) => (s.id === "seed-barbell-squat" ? { ...s, notes: "my own note", defaultRestSeconds: 150 } : s));
  const customs = [
    { id: "c-1", name: "Band pull apart", primaryMuscles: ["rear_delts"], secondaryMuscles: [], equipmentTags: ["resistance_band"], notes: "warm-up", isCustom: true, defaultRestSeconds: 60 },
    { id: "c-2", name: "Sled push", primaryMuscles: ["quads"], secondaryMuscles: ["glutes"], equipmentTags: [], notes: "", isCustom: true, defaultRestSeconds: null },
  ];
  const history = {
    workouts: [{ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "heavy day" }],
    entries: [{ id: "e1", workoutId: "w1", exerciseId: "seed-barbell-squat", order: 0, supersetGroup: null, notes: "" }, { id: "e2", workoutId: "w1", exerciseId: "c-1", order: 1, supersetGroup: null, notes: "" }],
    sets: [
      { id: "s1", entryId: "e1", order: 0, reps: 5, weightValue: 140, weightUnit: "kg", isWarmup: false, restSeconds: 180, completedAt: "2026-10-01T10:10:00.000Z" },
      { id: "s2", entryId: "e2", order: 0, reps: 15, weightValue: 0, weightUnit: "lb", isWarmup: true, restSeconds: null, completedAt: null },
    ],
  };
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    for (const record of [...seeds, ...customs]) await tx.put("exercises", record);
    for (const [store, list] of Object.entries(history)) for (const record of list) await tx.put(store, record);
    await tx.put("meta", { key: "schemaVersion", value: 2 });
    await tx.put("meta", { key: "preferredUnit", value: "kg" });
    await tx.put("meta", { key: "seedVersion", value: 1 });
  });
  return { adapter, seeds, customs };
}

const snapshot = (adapter) => adapter.transaction(STORES, "readonly", async (tx) => {
  const out = {};
  for (const name of STORES) out[name] = (await tx.getAll(name)).sort((x, y) => String(x.id ?? x.key).localeCompare(String(y.id ?? y.key)));
  return out;
});
// The schema 3 tests run steps 2 and 3 only, as they did before step 4 existed (tests/templates.test.js covers 4).
const STEPS_TO_3 = STEPS.filter((s) => s.to <= 3);
const run = (adapter, oldVersion, extra = {}) => adapter.transaction(STORES, "readwrite", (tx) => upgradeData({ oldVersion, tx, steps: STEPS_TO_3, ...extra }));

test("schema 3 upgrade: from version 2, each of the 16 seeds gets exactly its grouping, customs get origin custom, and nothing else on any record changes", async () => {
  const { adapter, seeds, customs } = await populatedV2();
  assert.deepEqual(await run(adapter, 2), [3]);
  const after = await snapshot(adapter);
  const byId = new Map(after.exercises.map((e) => [e.id, e]));
  assert.equal(after.exercises.length, 18);
  for (const seed of seeds) {
    const [baseMovementId, equipment, variations, upstreamId] = GROUPING[seed.id];
    assert.deepEqual(byId.get(seed.id), { ...seed, baseMovementId, equipment, variations, origin: "seed", upstreamId, catalogVersion: null, retired: false }, seed.id);
  }
  // the user's own edits on a seed are kept
  assert.deepEqual([byId.get("seed-barbell-squat").notes, byId.get("seed-barbell-squat").defaultRestSeconds], ["my own note", 150]);
  assert.deepEqual(byId.get("seed-lat-pulldown"), {
    id: "seed-lat-pulldown", name: "Lat pulldown", primaryMuscles: ["lats"], secondaryMuscles: ["biceps", "upper_back"], equipmentTags: ["cable"], notes: "", isCustom: false, defaultRestSeconds: null,
    baseMovementId: "pulldown", equipment: "cable", variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false,
  });
  for (const custom of customs) {
    assert.deepEqual(byId.get(custom.id), { ...custom, baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false }, custom.id);
  }
  assert.deepEqual(after.meta.find((m) => m.key === "schemaVersion"), { key: "schemaVersion", value: 3 });
});

test("schema 3 upgrade: workouts, entries, sets and the other settings are byte for byte what they were", async () => {
  const { adapter } = await populatedV2();
  const before = await snapshot(adapter);
  await run(adapter, 2);
  const after = await snapshot(adapter);
  assert.equal(JSON.stringify(after.workouts), JSON.stringify(before.workouts));
  assert.equal(JSON.stringify(after.entries), JSON.stringify(before.entries));
  assert.equal(JSON.stringify(after.sets), JSON.stringify(before.sets));
  assert.deepEqual(after.meta.filter((m) => m.key !== "schemaVersion"), before.meta.filter((m) => m.key !== "schemaVersion"));
  // and every exercise keeps every field it had
  for (const old of before.exercises) assert.deepEqual(legacy(after.exercises.find((e) => e.id === old.id)), old, old.id);
});

test("schema 3 upgrade: a seed that already has a base movement is not regrouped, and running the step again changes nothing", async () => {
  const { adapter } = await populatedV2();
  const regrouped = { ...legacy(SEED_EXERCISES.find((s) => s.id === "seed-leg-press")), baseMovementId: "hack-squat", equipment: "smith_machine", variations: ["narrow-stance"], origin: "seed", upstreamId: "Something_Else", catalogVersion: null, retired: false };
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.put("exercises", regrouped));
  await run(adapter, 2);
  const settled = await snapshot(adapter);
  assert.deepEqual(settled.exercises.find((e) => e.id === "seed-leg-press"), regrouped);
  assert.deepEqual(await run(adapter, 3), []); // already version 3: no step runs
  assert.deepEqual(await run(adapter, 2), [3]); // even if run again on version 3 data
  assert.deepEqual(await snapshot(adapter), settled);
});

test("schema 3 upgrade: a failure part-way undoes all of it, and a retry then works", async () => {
  const { adapter } = await populatedV2();
  const before = await snapshot(adapter);
  const failing = failAfter(adapter, { puts: 3 }); // three exercises are written, the fourth put fails
  await assert.rejects(failing.transaction(STORES, "readwrite", (tx) => upgradeData({ oldVersion: 2, tx })), /injected failure/);
  assert.deepEqual(await snapshot(adapter), before);
  assert.deepEqual(await run(adapter, 2), [3]);
  assert.equal((await snapshot(adapter)).exercises.every((e) => e.origin === (e.isCustom ? "custom" : "seed")), true);
});

test("schema 3 upgrade: from version 1, step 2 and step 3 run in one go, giving defaultRestSeconds and the schema 3 fields", async () => {
  const adapter = createMemoryAdapter();
  await adapter.open();
  const v1Seed = v1Shape(SQUAT_V3);
  const v1Custom = { id: "c-1", name: "Mine", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: true };
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    await tx.put("exercises", v1Seed);
    await tx.put("exercises", v1Custom);
    await tx.put("meta", { key: "schemaVersion", value: 1 });
  });
  assert.deepEqual(await run(adapter, 1), [2, 3]);
  const after = await snapshot(adapter);
  assert.deepEqual(after.exercises, [
    { ...v1Custom, defaultRestSeconds: null, baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false },
    SQUAT_V3,
  ]);
  assert.equal(after.meta.find((m) => m.key === "schemaVersion").value, 3);
  assert.deepEqual(STEPS.map((s) => s.to), [2, 3, 4, 5]);
});

test("schema 3 upgrade: the step uses the grouping it is given, and only seeds (not customs) are grouped", async () => {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await adapter.transaction(["exercises"], "readwrite", async (tx) => {
    await tx.put("exercises", { ...v1Shape(SQUAT_V3), defaultRestSeconds: null });
    await tx.put("exercises", { ...v1Shape(SQUAT_V3), id: "seed-x", isCustom: true, defaultRestSeconds: null });
  });
  const grouping = new Map([
    ["seed-barbell-squat", { seedId: "seed-barbell-squat", upstreamId: "U", baseMovementId: "b", equipment: "cable", variations: ["v"] }],
    ["seed-x", { seedId: "seed-x", upstreamId: "X", baseMovementId: "x", equipment: "cable", variations: [] }],
  ]);
  await adapter.transaction(STORES, "readwrite", (tx) => upgradeData({ oldVersion: 2, tx, steps: [stepTo3(grouping)] }));
  const [squat, x] = (await snapshot(adapter)).exercises;
  assert.deepEqual([squat.baseMovementId, squat.equipment, squat.variations, squat.upstreamId], ["b", "cable", ["v"], "U"]);
  assert.deepEqual([x.baseMovementId, x.origin, x.upstreamId], [null, "custom", null]);
});

// ---- seeds ----

test("schema 3 seeds: a fresh store gets the 16 seeds as complete schema 3 records, grouped, with SEED_VERSION still 1", async () => {
  assert.equal(SEED_VERSION, 1);
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, SEED_VERSION), { added: 16, skipped: false });
  const stored = await store.listExercises();
  assert.equal(stored.length, 16);
  for (const record of stored) {
    assert.equal(Object.keys(record).length, 15, record.id);
    const [baseMovementId, equipment, variations, upstreamId] = GROUPING[record.id];
    assert.deepEqual([record.baseMovementId, record.equipment, record.variations, record.upstreamId, record.origin, record.catalogVersion, record.retired], [baseMovementId, equipment, variations, upstreamId, "seed", null, false], record.id);
  }
  assert.deepEqual(await store.getExercise("seed-barbell-squat"), SQUAT_V3);
});

// ---- export and import ----

const exportFile = (schemaVersion, exercises, history = { workouts: [], entries: [], sets: [] }) => JSON.stringify({
  app: "apogee-export", exportFormat: 1, schemaVersion, exportedAt: NOW, data: { exercises, ...history },
});

async function openBackupStore() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  return { adapter, store, backup: createBackup(adapter) };
}
const meta = (adapter, key) => adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", key));

test("schema 3 import: a version 2 file imports with the defaults, its seeds grouped and its customs origin custom", async () => {
  const { store, backup } = await openBackupStore();
  const seed = { ...legacy(SQUAT_V3), notes: "kept", defaultRestSeconds: 90 };
  const custom = { id: "c-1", name: "Mine", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: true, defaultRestSeconds: null };
  await backup.importFromText(exportFile(2, [seed, custom]), { confirmReplace: true });
  assert.deepEqual(await store.getExercise("seed-barbell-squat"), { ...SQUAT_V3, notes: "kept", defaultRestSeconds: 90 });
  assert.deepEqual(await store.getExercise("c-1"), { ...custom, baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false });
});

test("schema 3 import: a version 1 file still imports, and its seed is grouped too", async () => {
  const { store, backup } = await openBackupStore();
  await backup.importFromText(exportFile(1, [v1Shape(SQUAT_V3)]), { confirmReplace: true });
  assert.deepEqual(await store.getExercise("seed-barbell-squat"), SQUAT_V3);
});

test("schema 3 export: a file written by this app (now version 4) imports and exports again byte for byte", async () => {
  const { adapter, store, backup } = await openBackupStore();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  await store.saveExercise({ id: "c-1", name: "Mine", primaryMuscles: ["neck"], isCustom: true, defaultRestSeconds: 30 });
  await store.saveWorkoutWithDetails(
    { id: "w1", startedAt: NOW, endedAt: NOW, notes: "n" },
    [{ id: "e1", workoutId: "w1", exerciseId: "c-1", order: 0 }],
    [{ id: "s1", entryId: "e1", order: 0, reps: 3, weightValue: 20, weightUnit: "kg" }],
  );
  const first = await backup.exportToText({ now: NOW });
  const doc = JSON.parse(first);
  assert.equal(doc.schemaVersion, 5);
  assert.deepEqual(Object.keys(doc.data.exercises[0]), [
    "baseMovementId", "catalogVersion", "defaultRestSeconds", "equipment", "equipmentTags", "id", "isCustom", "name", "notes", "origin",
    "primaryMuscles", "retired", "secondaryMuscles", "upstreamId", "variations",
  ]);
  await adapter.transaction(STORES, "readwrite", async (tx) => { for (const s of ["exercises", "workouts", "entries", "sets"]) await tx.clear(s); });
  await backup.importFromText(first, { confirmReplace: true });
  assert.equal(await backup.exportToText({ now: NOW }), first);
});

test("schema 3 import: the catalog version key in meta is deleted with the plan and timer, and the schema version is kept", async () => {
  const { adapter, backup } = await openBackupStore();
  await adapter.transaction(["meta"], "readwrite", async (tx) => {
    await tx.put("meta", { key: "catalogVersion", value: 7 });
    await tx.put("meta", { key: "preferredUnit", value: "kg" });
  });
  await backup.importFromText(exportFile(2, [{ ...legacy(SQUAT_V3) }]), { confirmReplace: true });
  assert.equal(await meta(adapter, "catalogVersion"), undefined);
  assert.deepEqual(await meta(adapter, "schemaVersion"), { key: "schemaVersion", value: SCHEMA_VERSION });
  assert.deepEqual(await meta(adapter, "preferredUnit"), { key: "preferredUnit", value: "kg" });
});

test("schema 3 import: a version 3 file whose origin does not match isCustom, or whose variations are unsorted, is refused and nothing is written", async () => {
  const { store, backup } = await openBackupStore();
  for (const bad of [{ ...SQUAT_V3, origin: "custom" }, { ...SQUAT_V3, variations: ["pins", "box"] }]) {
    await assert.rejects(backup.importFromText(exportFile(3, [bad]), { confirmReplace: true }), /seed-barbell-squat/);
  }
  assert.deepEqual(await store.listExercises(), []);
});

// ---- the rest-time edit ----

test("schema 3 logger: Update Rest Timers on a grouped seed changes only defaultRestSeconds and keeps all seven new fields", async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const logger = createLogger(store, { now: () => new Date(NOW) });
  await logger.addSet("seed-barbell-squat");
  assert.deepEqual(await logger.updateRestTimers("seed-barbell-squat", 120), { defaultRestSeconds: 120, updatedSets: 1 });
  assert.deepEqual(await store.getExercise("seed-barbell-squat"), { ...SQUAT_V3, defaultRestSeconds: 120 });
});

// ---- the picker's search, through the logger ----

test("schema 3 logger: findExercises passes the filters on and hides a retired entry, which still resolves in history; a new custom name may not equal any stored name, a retired catalog entry's included", async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  await store.saveExercise({ id: "Old_One", name: "Old one", primaryMuscles: ["abs"], equipmentTags: ["bodyweight"], origin: "upstream", catalogVersion: 1, retired: true });
  await store.saveExercise({ id: "Crunch_X", name: "Crunch X", primaryMuscles: ["abs"], equipmentTags: ["bodyweight"], origin: "upstream", catalogVersion: 1 });
  const logger = createLogger(store, { now: () => new Date(NOW) });

  assert.deepEqual((await logger.findExercises("old")).map((e) => e.id), []);
  assert.deepEqual((await logger.findExercises("old", { includeRetired: true })).map((e) => e.id), ["Old_One"]);
  assert.deepEqual((await logger.findExercises("", { muscle: "abs" })).map((e) => e.id), ["Crunch_X"]);
  assert.deepEqual((await logger.findExercises("", { equipment: "bodyweight" })).map((e) => e.id), ["seed-pull-up", "Crunch_X"]); // the pull-up seed is tagged bodyweight too, and comes first
  assert.equal((await logger.findExercises("")).length, 17); // 16 seeds + Crunch_X, Old_One hidden
  assert.equal((await logger.findExercises("bench", undefined))[0].id, "seed-barbell-bench-press");

  // history still resolves a retired entry
  await store.saveWorkoutWithDetails({ id: "w1", startedAt: NOW, endedAt: NOW }, [{ id: "e1", workoutId: "w1", exerciseId: "Old_One", order: 0 }], [{ id: "s1", entryId: "e1", order: 0, reps: 5, weightValue: 10, weightUnit: "kg", completedAt: NOW }]);
  assert.equal((await store.getExercise("Old_One")).name, "Old one");
  assert.equal((await logger.getHistory()).length, 1);
  assert.equal((await logger.getWorkoutDetail("w1")).entries[0].exerciseName, "Old one");

  // a new custom exercise cannot take any stored name, ignoring case, catalog and retired entries included
  for (const taken of ["crunch x", "OLD ONE", "Barbell Bench Press"]) {
    await assert.rejects(logger.addCustomExercise({ name: taken, primaryMuscles: ["abs"] }), /an exercise with this name already exists/, taken);
  }
  assert.equal((await logger.addCustomExercise({ name: "Crunch Y", primaryMuscles: ["abs"] })).origin, "custom");
});
