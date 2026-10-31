// Template rule tests (schema version 4): the store, independence from history, export and import. Shared by
// Node (memory adapter) and the browser page (IndexedDB adapter). No node:test import: each runner supplies
//   ctx.assert          equal, deepEqual, ok, rejects(promise, pattern)
//   ctx.createAdapter() a fresh, not yet opened adapter over an empty database
// Expected values are written out by hand; none is computed with the code under test.

import { SCHEMA_VERSION, createExercise } from "../src/domain/model.js";
import { templateFromWorkout, planFromTemplate } from "../src/domain/template.js";
import { emptyPlan } from "../src/domain/workout-plan.js";
import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup, inspectBackup } from "../src/backup/backup.js";
import { EXERCISE, makeDetails, rawCounts } from "./store-rules.js";
import { seedFull, fileOf, NOW } from "./backup-rules.js";

export const templateRules = [];
const rule = (name, run) => templateRules.push({ name, run });

const STORES = ["exercises", "workouts", "entries", "sets", "templates"];
const BENCH = createExercise({ id: "ex-bench", name: "Bench", primaryMuscles: ["chest"] });
const PUSH = { id: "t-push", name: "Push day", exercises: [{ exerciseId: "ex-bench", setCount: 3 }, { exerciseId: "ex-squat", setCount: 2 }] };
const LEGS = { id: "t-legs", name: "Legs", exercises: [{ exerciseId: "ex-squat", setCount: 5 }] };

async function open(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  return { adapter, store, backup: createBackup(adapter) };
}

const rawTemplates = (adapter) => adapter.transaction(["templates"], "readonly", (tx) => tx.getAll("templates"))
  .then((list) => list.sort((a, b) => (a.id < b.id ? -1 : 1)));
const wipe = (adapter) => adapter.transaction(STORES, "readwrite", async (tx) => {
  for (const name of STORES) await tx.clear(name);
});

// A finished workout: bench (a warm-up and 3 working sets), then squat (2 sets).
async function finishedWorkout(store) {
  await store.saveExercise(EXERCISE);
  await store.saveExercise(BENCH);
  const d = makeDetails("w1", 2, 3);
  const entries = [{ ...d.entries[0], exerciseId: "ex-bench" }, d.entries[1]];
  const sets = [
    ...d.sets.filter((set) => set.entryId === entries[0].id),
    { ...d.sets[0], id: "w1-warm", order: 9, isWarmup: true },
    ...d.sets.filter((set) => set.entryId === entries[1].id).slice(0, 2),
  ];
  await store.saveWorkoutWithDetails({ ...d.workout, endedAt: "2026-10-22T11:00:00.000Z" }, entries, sets);
  return store.getWorkoutWithDetails("w1");
}

// ---- store ----

rule("templates: saveTemplate stores exactly id, name and the exercise list; listTemplates sorts by name; deleteTemplate removes one", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await store.saveExercise(BENCH);
  assert.deepEqual(await store.saveTemplate({ ...PUSH, name: "  Push \n day " }), PUSH);
  await store.saveTemplate(LEGS);
  assert.deepEqual(await rawTemplates(adapter), [LEGS, PUSH]);
  assert.deepEqual((await store.listTemplates()).map((t) => t.name), ["Legs", "Push day"]);
  assert.deepEqual(await store.getTemplate("t-push"), PUSH);
  assert.equal(await store.deleteTemplate("t-push"), true);
  assert.equal(await store.deleteTemplate("t-push"), false);
  assert.deepEqual(await rawTemplates(adapter), [LEGS]);
});

rule("templates: a template naming an exercise that does not exist, or an invalid one, is refused and nothing is written", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await assert.rejects(store.saveTemplate(PUSH), /exercises\[0\]\.exerciseId: no exercise with id "ex-bench"/);
  await assert.rejects(store.saveTemplate({ ...LEGS, name: "   " }), /name must be a non-empty string/);
  await assert.rejects(store.saveTemplate({ ...LEGS, name: "x".repeat(81) }), /name must be at most 80 characters/);
  assert.deepEqual(await rawTemplates(adapter), []);
});

rule("templates: a template made from a finished workout stays exactly the same when that workout is edited or deleted", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await open(ctx);
  const workout = await finishedWorkout(store);
  const made = templateFromWorkout(workout, { id: "t1", name: "From w1" });
  assert.deepEqual(made, { id: "t1", name: "From w1", exercises: [{ exerciseId: "ex-bench", setCount: 3 }, { exerciseId: "ex-squat", setCount: 2 }] });
  await store.saveTemplate(made);
  const before = await rawTemplates(adapter);
  // edit the source: drop a set and change another, then delete it
  const { entries, ...rest } = await store.getWorkoutWithDetails("w1");
  const sets = entries.flatMap((entry) => entry.sets).slice(1).map((set) => ({ ...set, reps: 1 }));
  await store.saveWorkoutWithDetails(rest, entries.map(({ sets: _s, ...entry }) => entry), sets);
  assert.deepEqual(await rawTemplates(adapter), before);
  assert.equal(await store.deleteWorkout("w1"), true);
  assert.deepEqual(await rawTemplates(adapter), before);
  assert.deepEqual(await store.getTemplate("t1"), made);
});

rule("templates: two templates may have the same name; they are told apart by id, and both survive export and import", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await store.saveTemplate(LEGS);
  await store.saveTemplate({ ...LEGS, id: "t-legs-2", exercises: [{ exerciseId: "ex-squat", setCount: 1 }] });
  assert.deepEqual((await store.listTemplates()).map((t) => [t.id, t.name]), [["t-legs", "Legs"], ["t-legs-2", "Legs"]]);
  const text = await backup.exportToText({ now: NOW });
  await wipe(adapter);
  assert.equal((await backup.importFromText(text, { confirmReplace: true })).templates, 2);
  assert.equal(await backup.exportToText({ now: NOW }), text);
});

// ---- export and import ----

rule("templates: backup round trip: templates are exported sorted by id with sorted keys, imported, and export again byte for byte", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  await seedFull(store);
  await store.saveTemplate(PUSH);
  await store.saveTemplate(LEGS);
  const first = await backup.exportToText({ now: NOW });
  const doc = JSON.parse(first);
  assert.equal(doc.schemaVersion, 5);
  assert.deepEqual(Object.keys(doc.data), ["exercises", "workouts", "entries", "sets", "templates"]);
  assert.deepEqual(doc.data.templates, [
    { exercises: [{ exerciseId: "ex-squat", setCount: 5 }], id: "t-legs", name: "Legs" },
    { exercises: [{ exerciseId: "ex-bench", setCount: 3 }, { exerciseId: "ex-squat", setCount: 2 }], id: "t-push", name: "Push day" },
  ]);
  await wipe(adapter);
  const counts = await backup.importFromText(first, { confirmReplace: true });
  assert.deepEqual(counts, { exercises: 2, workouts: 2, entries: 3, sets: 8, templates: 2 });
  assert.deepEqual(await rawTemplates(adapter), [LEGS, PUSH]);
  assert.equal(await backup.exportToText({ now: NOW }), first);
});

rule("templates: an old backup (schema 1, 2 or 3) has no templates section, imports, and replaces the templates with none", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  const v3 = JSON.parse(await (async () => {
    await seedFull(store);
    return backup.exportToText({ now: NOW });
  })());
  v3.schemaVersion = 3;
  delete v3.data.templates;
  await store.saveTemplate(LEGS);
  assert.deepEqual(inspectBackup(JSON.stringify(v3)).counts, { exercises: 2, workouts: 2, entries: 3, sets: 8, templates: 0 });
  assert.deepEqual(await backup.importFromText(JSON.stringify(v3), { confirmReplace: true }), { exercises: 2, workouts: 2, entries: 3, sets: 8, templates: 0 });
  assert.deepEqual(await rawTemplates(adapter), []);
  // a version 1 and a version 2 file with no templates section import too
  const v1 = fileOf({ exercises: [] }, { schemaVersion: 1 });
  const v2 = fileOf({ exercises: [] }, { schemaVersion: 2 });
  assert.equal((await backup.importFromText(v1, { confirmReplace: true })).templates, 0);
  assert.equal((await backup.importFromText(v2, { confirmReplace: true })).templates, 0);
});

rule("templates: each schema is strict about the section: an old file must not have templates, a version 4 file must", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await store.saveTemplate(LEGS);
  const withSection = fileOf({}, { schemaVersion: 3, data: { exercises: [], workouts: [], entries: [], sets: [], templates: [] } });
  await assert.rejects(backup.importFromText(withSection, { confirmReplace: true }), /data: unknown field "templates"/);
  const without = fileOf({}, { data: { exercises: [], workouts: [], entries: [], sets: [] } });
  await assert.rejects(backup.importFromText(without, { confirmReplace: true }), /data\.templates must be a list/);
  assert.deepEqual(await rawTemplates(adapter), [LEGS]); // nothing was replaced
  assert.equal(SCHEMA_VERSION, 5);
});

// What each hostile template does: [description, change to the good template, message the import must give].
const HOSTILE = [
  ["name is a number", (t) => { t.name = 5; }, /template "t-1": name must be a non-empty string/],
  ["name is null", (t) => { t.name = null; }, /name must be a non-empty string/],
  ["name is empty", (t) => { t.name = ""; }, /name must be a non-empty string/],
  ["name is only whitespace", (t) => { t.name = " \t\n "; }, /name must be a non-empty string/],
  ["name is 81 characters", (t) => { t.name = "n".repeat(81); }, /name must be at most 80 characters/],
  ["name is 81 emoji (code points, not UTF-16 units)", (t) => { t.name = "🏋".repeat(81); }, /name must be at most 80 characters/],
  ["name is a 100,000-character string", (t) => { t.name = "n".repeat(100000); }, /name must be at most 80 characters/],
  ["name is not in canonical form", (t) => { t.name = " Hidden  name "; }, /name is not in its canonical form/],
  ["exercises is a string", (t) => { t.exercises = "ex-squat"; }, /exercises must be an array/],
  ["exercises is an object", (t) => { t.exercises = { 0: { exerciseId: "ex-squat", setCount: 1 } }; }, /exercises must be an array/],
  ["exercises is empty", (t) => { t.exercises = []; }, /exercises must contain at least one exercise/],
  ["exercises has 51 items", (t) => { t.exercises = Array.from({ length: 51 }, (_, i) => ({ exerciseId: `x${i}`, setCount: 1 })); }, /exercises must have at most 50 entries/],
  ["an item is null", (t) => { t.exercises = [null]; }, /exercises\[0\] must be an object/],
  ["an item is an array", (t) => { t.exercises = [["ex-squat", 1]]; }, /exercises\[0\] must be an object/],
  ["exerciseId is a number", (t) => { t.exercises[0].exerciseId = 7; }, /exercises\[0\]\.exerciseId must be a non-empty string/],
  ["exerciseId is empty", (t) => { t.exercises[0].exerciseId = ""; }, /exercises\[0\]\.exerciseId must be a non-empty string/],
  ["setCount is a string", (t) => { t.exercises[0].setCount = "3"; }, /setCount must be an integer >= 1/],
  ["setCount is a fraction", (t) => { t.exercises[0].setCount = 1.5; }, /setCount must be an integer >= 1/],
  ["setCount is 0", (t) => { t.exercises[0].setCount = 0; }, /setCount must be an integer >= 1/],
  ["setCount is negative", (t) => { t.exercises[0].setCount = -1; }, /setCount must be an integer >= 1/],
  ["setCount is true", (t) => { t.exercises[0].setCount = true; }, /setCount must be an integer >= 1/],
  ["setCount is 51", (t) => { t.exercises[0].setCount = 51; }, /setCount must be at most 50/],
  ["setCount is huge", (t) => { t.exercises[0].setCount = 1e308; }, /setCount must be at most 50/],
  ["an exercise is listed twice", (t) => { t.exercises = [{ exerciseId: "ex-squat", setCount: 1 }, { exerciseId: "ex-squat", setCount: 2 }]; }, /exercises must not repeat an exercise/],
  ["an exercise not in the file", (t) => { t.exercises[0].exerciseId = "ex-gone"; }, /template "t-1": exerciseId refers to an exercise that is not in the file/],
  ["an extra field on the template", (t) => { t.sourceWorkoutId = "w1"; }, /template "t-1": unknown field "sourceWorkoutId"/],
  ["a missing field on the template", (t) => { delete t.exercises; }, /template "t-1": required field "exercises" is missing/],
  ["an extra field on an item", (t) => { t.exercises[0].weight = 100; }, /template "t-1": exercises is not in its canonical form/],
  ["a missing field on an item", (t) => { delete t.exercises[0].setCount; }, /setCount must be an integer >= 1/],
  ["a __proto__ key on an item", (t) => { Object.defineProperty(t.exercises[0], "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true }); }, /exercises is not in its canonical form/],
  ["a __proto__ key on the template", (t) => { Object.defineProperty(t, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true }); }, /unknown field "__proto__"/],
  ["the template is a string", (_t, file) => { file.data.templates = ["t-1"]; }, /template at index 0: not an object/],
  ["two templates share an id", (t, file) => { file.data.templates.push({ ...t, name: "Other" }); }, /template "t-1": duplicate id/],
  ["templates is not a list", (_t, file) => { file.data.templates = {}; }, /data\.templates must be a list/],
];

rule("templates: hostile or malformed templates in a file are refused, naming the template and field but never the value, and nothing is written", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, backup } = await open(ctx);
  await seedFull(store);
  await store.saveTemplate(LEGS);
  const before = await backup.exportToText({ now: NOW });
  const good = () => {
    const doc = JSON.parse(fileOf({ exercises: [EXERCISE] }));
    doc.data.templates = [{ exercises: [{ exerciseId: "ex-squat", setCount: 3 }], id: "t-1", name: "Good" }];
    return doc;
  };
  assert.deepEqual(inspectBackup(JSON.stringify(good())).counts.templates, 1); // the good file is valid
  for (const [what, change, pattern] of HOSTILE) {
    const doc = good();
    change(doc.data.templates[0], doc);
    const text = JSON.stringify(doc);
    let message = null;
    try {
      await backup.importFromText(text, { confirmReplace: true });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message !== null, `${what}: was accepted`);
    assert.ok(pattern.test(message), `${what}: got "${message}"`);
    assert.ok(!message.includes("Hidden") && !message.includes("nnnnn") && !message.includes("🏋"), `${what}: the message repeats the value`);
    assert.equal(await backup.exportToText({ now: NOW }), before, `${what}: data changed`);
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(await rawTemplates(adapter), [LEGS]);
});

// ---- the UI's operations, through the logger ----

rule("templates: planFromTemplate adds the exercises in the template's order, each with setCount blank unchecked rows", async (ctx) => {
  const { assert } = ctx;
  let n = 0;
  const plan = planFromTemplate(emptyPlan(), PUSH, { unit: "lb", newId: () => `r${++n}` });
  const blank = (id, exerciseId, order) => ({ id, exerciseId, order, reps: "", weight: "", unit: "lb", restSeconds: null, isWarmup: false });
  assert.deepEqual(plan.exercises, ["ex-bench", "ex-squat"]);
  assert.deepEqual(plan.rows, [
    blank("r1", "ex-bench", 0), blank("r2", "ex-bench", 1), blank("r3", "ex-bench", 2),
    blank("r4", "ex-squat", 0), blank("r5", "ex-squat", 1),
  ]);
});

rule("templates: startFromTemplate plans blank rows; refused, nothing written, while rows are planned or a workout is running", async (ctx) => {
  const { assert } = ctx;
  const { store } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await store.saveExercise(BENCH);
  await store.saveTemplate(PUSH);
  await store.setPreferredUnit("kg");
  const logger = createLogger(store);

  await assert.rejects(logger.startFromTemplate("t-nothing"), /no longer exists/);
  assert.equal((await logger.startFromTemplate("t-push")).id, "t-push");
  let session = await logger.getSession();
  assert.equal(session.status.kind, "none");
  assert.equal(session.loggedCount, 0);
  assert.deepEqual(session.blocks.map((block) => [block.exerciseId, block.rows.map((row) => row.order)]), [["ex-bench", [0, 1, 2]], ["ex-squat", [0, 1]]]);
  assert.ok(session.blocks.every((block) => block.rows.every((row) => (
    row.kind === "planned" && row.reps === "" && row.weight === "" && row.unit === "kg" && row.isWarmup === false))));

  // rows already planned and no workout yet: refused, the plan is unchanged
  await assert.rejects(logger.startFromTemplate("t-push"), /Sets are already planned.*Finish workout/);
  assert.equal((await logger.getSession()).plannedCount, 5);

  // a running workout: refused, the plan is unchanged
  await logger.checkSet(session.blocks[0].rows[0].id, { reps: "5", weight: "100" });
  await assert.rejects(logger.startFromTemplate("t-push"), /A workout is already running.*Finish workout.*Discard workout/);
  session = await logger.getSession();
  assert.equal(session.plannedCount, 4);
  assert.equal(session.loggedCount, 1);
});

rule("templates: startFromTemplate is refused beside an unfinished old workout, and when a listed exercise is gone", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await open(ctx);
  await store.saveExercise(EXERCISE);
  await store.saveExercise(BENCH);
  await store.saveTemplate(PUSH);
  const logger = createLogger(store);

  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", "ex-bench"));
  await assert.rejects(logger.startFromTemplate("t-push"), /"Push day" lists an exercise that is no longer in the library/);
  assert.equal((await logger.getSession()).plannedCount, 0);

  const old = createLogger(store, { now: () => new Date("2026-01-01T10:00:00.000Z") });
  await old.logSet({ exerciseId: "ex-squat", reps: "5", weight: "100", weightUnit: "kg" });
  await assert.rejects(logger.startFromTemplate("t-push"), /unfinished workout is waiting.*"Finish" or "Discard"/);
  assert.equal((await logger.getSession()).plannedCount, 0);
});

rule("templates: saveWorkoutAsTemplate, renameTemplate and deleteTemplate; refusals write nothing and delete never touches workouts", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store } = await open(ctx);
  await finishedWorkout(store);
  const logger = createLogger(store);

  const saved = await logger.saveWorkoutAsTemplate("w1", "  My \n push ");
  assert.equal(saved.name, "My push");
  assert.deepEqual(saved.exercises, [{ exerciseId: "ex-bench", setCount: 3 }, { exerciseId: "ex-squat", setCount: 2 }]);
  const twin = await logger.saveWorkoutAsTemplate("w1", "My push"); // duplicate names are allowed
  assert.ok(twin.id !== saved.id);
  assert.equal((await logger.listTemplates()).length, 2);

  const warmups = makeDetails("w2", 1, 1);
  await store.saveWorkoutWithDetails({ ...warmups.workout, endedAt: "2026-10-22T11:00:00.000Z" }, warmups.entries, warmups.sets.map((set) => ({ ...set, isWarmup: true })));
  const open3 = makeDetails("w3", 1, 1);
  await store.saveWorkoutWithDetails(open3.workout, open3.entries, open3.sets);
  await assert.rejects(logger.saveWorkoutAsTemplate("w1", "   "), /name must be a non-empty string/);
  await assert.rejects(logger.saveWorkoutAsTemplate("w1", "x".repeat(81)), /name must be at most 80 characters/);
  await assert.rejects(logger.saveWorkoutAsTemplate("w2", "Warm"), /no working sets/);
  await assert.rejects(logger.saveWorkoutAsTemplate("w3", "Open"), /Only a finished workout/);
  await assert.rejects(logger.saveWorkoutAsTemplate("w-none", "Nope"), /no workout/);
  assert.equal((await logger.listTemplates()).length, 2);

  const renamed = await logger.renameTemplate(saved.id, " Pull  day ");
  assert.deepEqual(renamed, { id: saved.id, name: "Pull day", exercises: saved.exercises });
  await assert.rejects(logger.renameTemplate(saved.id, ""), /name must be a non-empty string/);
  await assert.rejects(logger.renameTemplate("t-none", "X"), /no longer exists/);
  assert.equal((await store.getTemplate(saved.id)).name, "Pull day");

  const before = await rawCounts(adapter);
  assert.equal(await logger.deleteTemplate(saved.id), true);
  assert.deepEqual((await logger.listTemplates()).map((template) => template.id), [twin.id]);
  assert.deepEqual(await rawCounts(adapter), before);
});
