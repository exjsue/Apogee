// Undo of a Strong import (src/importers/strong-undo.js) against the memory adapter. The import is done with the real
// buildStrongPlan and applyStrongPlan, so these tests also catch the importer and the undo drifting apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createBackup } from "../src/backup/backup.js";
import { nameKey } from "../src/domain/exercise-names.js";
import { normalizePlan } from "../src/domain/workout-plan.js";
import { parseStrongCsv, buildStrongPlan, strongWorkoutId, strongExerciseId } from "../src/importers/strong.js";
import { strongNameCounts } from "../src/importers/strong-match.js";
import { applyStrongPlan, readImportContext } from "../src/importers/strong-apply.js";
import { prepareStrongUndo, checkStrongUndo, applyStrongUndo } from "../src/importers/strong-undo.js";

const FIXTURE = readFileSync(new URL("./fixtures/strong-sample.csv", import.meta.url), "utf8");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const chest = () => ({ kind: "custom", primaryMuscles: ["chest"] });
const SHORT = ["2025-01-14 07:00:00", "Short"]; // one name (Kneeling Cable Twist), three sets
const EVENING = ["2025-01-12 18:30:00", "Evening ☝\u{1F3FD}"];
const MORNING = ["2025-01-10 08:00:00", "Morning Lift, Heavy"];
const LAST = ["2025-02-01 09:15:00", "Short"];

const exportOf = (adapter) => createBackup(adapter).exportToText({ now: NOW });

async function storeWithExisting() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.saveExercise({ name: "My Own Lift", primaryMuscles: ["biceps"], secondaryMuscles: [], equipmentTags: [], isCustom: true });
  const exercise = (await store.listExercises())[0];
  await store.saveWorkoutWithDetails(
    { id: "w-mine", startedAt: "2024-12-01T10:00:00.000Z", endedAt: "2024-12-01T11:00:00.000Z", name: "Mine" },
    [{ id: "e-mine", workoutId: "w-mine", exerciseId: exercise.id, order: 0 }],
    [{ id: "s-mine", entryId: "e-mine", order: 0, reps: 5, weightValue: 50, weightUnit: "kg", completedAt: "2024-12-01T10:30:00.000Z" }],
  );
  return { adapter, store, exercise };
}

// Imports `text` with `pick(name) -> choice` (default: every name a custom exercise).
async function importFile(adapter, { text = FIXTURE, unit = "lb", pick = chest } = {}) {
  const parsed = parseStrongCsv(text);
  const mapping = new Map(strongNameCounts(parsed.workouts).map((n) => [nameKey(n.name), pick(n.name)]));
  const plan = await buildStrongPlan({ parsed, unit, mapping, existing: await readImportContext(adapter) });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  await applyStrongPlan(adapter, plan);
  return plan;
}

async function undo(adapter, text = FIXTURE, options) {
  const prepared = await prepareStrongUndo(text);
  const report = await checkStrongUndo(adapter, prepared, options);
  return { prepared, report, apply: () => applyStrongUndo(adapter, prepared, report, options) };
}

const idOf = (pair) => strongWorkoutId(...pair);
const ids = (list) => list.map((x) => x.id).sort();
const write = (adapter, store, record) => adapter.transaction([store], "readwrite", (tx) => tx.put(store, record));
const read = (adapter, store, id) => adapter.transaction([store], "readonly", (tx) => tx.get(store, id));

test("strong undo: import then undo gives back the export byte for byte (merged names, a name used twice, a plan revision)", async () => {
  const { adapter, store, exercise } = await storeWithExisting();
  const before = await exportOf(adapter);
  const merged = new Set(["Squat (Barbell)", "Bench Press (Barbell)", "Plank"]); // three names, one exercise
  const plan = await importFile(adapter, { pick: (name) => (merged.has(name) ? { kind: "existing", exerciseId: exercise.id } : chest()) });
  assert.ok(plan.report.merges.length > 0);
  const rev = normalizePlan(await store.getWorkoutPlan()).rev;
  const { report, apply } = await undo(adapter);
  assert.equal(report.workouts.toDelete.length, 4);
  assert.deepEqual(report.totals, { workouts: 4, entries: plan.report.entries, sets: plan.report.sets, exercises: plan.report.customExercises });
  assert.deepEqual([report.workouts.edited, report.workouts.notFound, report.exercises.inUse], [[], [], []]);
  await apply();
  assert.equal(await exportOf(adapter), before);
  assert.equal(normalizePlan(await store.getWorkoutPlan()).rev, rev + 1); // customs were deleted: session writes read again
});

test("strong undo: several skipped names, and a workout whose names were all skipped (never written: not found)", async () => {
  const skipped = new Set(["Curl (Dumbbell)", "Lat Pulldown (Cable)", 'Cable Row "Close", Wide (Cable)']);
  const evening = new Set(["Pull Up", "Plank", "Curl (Dumbbell)", "Leg Press (Machine)"]);
  for (const skip of [skipped, new Set([...skipped, ...evening])]) {
    const { adapter } = await storeWithExisting();
    const before = await exportOf(adapter);
    await importFile(adapter, { pick: (name) => (skip.has(name) ? { kind: "skip" } : chest()) });
    const { report, apply } = await undo(adapter);
    const allEvening = skip.has("Pull Up");
    assert.equal(report.workouts.toDelete.length, allEvening ? 3 : 4);
    assert.deepEqual(ids(report.workouts.notFound), allEvening ? [await idOf(EVENING)] : []);
    assert.deepEqual(report.workouts.edited, []);
    await apply();
    assert.equal(await exportOf(adapter), before);
  }
});

test("strong undo: each workout to delete says how many of its names have no stored sets, and that count is in the signature", async () => {
  const { adapter } = await storeWithExisting();
  const skip = new Set(["Curl (Dumbbell)", "Lat Pulldown (Cable)"]);
  await importFile(adapter, { pick: (name) => (skip.has(name) ? { kind: "skip" } : chest()) });
  const morning = await idOf(MORNING);
  const counts = async () => Object.fromEntries((await undo(adapter)).report.workouts.toDelete.map((w) => [w.id, w.skippedNames]));
  assert.deepEqual(await counts(), { [morning]: 1, [await idOf(EVENING)]: 1, [await idOf(SHORT)]: 0, [await idOf(LAST)]: 1 });
  // The gap in TODO.md: the last exercise of a workout deleted in History looks like one more skipped name.
  const { apply } = await undo(adapter);
  const entries = await adapter.transaction(["entries"], "readonly", (tx) => tx.getAllByIndex("entries", "workoutId", morning));
  const last = entries.sort((a, b) => b.order - a.order)[0];
  await adapter.transaction(["entries", "sets"], "readwrite", async (tx) => {
    for (const set of await tx.getAllByIndex("sets", "entryId", last.id)) await tx.delete("sets", set.id);
    await tx.delete("entries", last.id);
  });
  assert.equal((await counts())[morning], 2);
  const changed = await exportOf(adapter);
  await assert.rejects(apply(), /changed since the check/); // the count is part of what was shown
  assert.equal(await exportOf(adapter), changed);
});

test("strong undo: an edited workout is kept and listed; the others are deleted", async () => {
  const shortId = await idOf(SHORT);
  const entryId = `${shortId}-e0`;
  const edits = {
    "a changed rep": async (a) => write(a, "sets", { ...(await read(a, "sets", `${entryId}-s1`)), reps: 11 }),
    "an added set": async (a) => write(a, "sets", { ...(await read(a, "sets", `${entryId}-s2`)), id: "added", order: 3 }),
    "the last set deleted": (a) => a.transaction(["sets"], "readwrite", (tx) => tx.delete("sets", `${entryId}-s2`)),
    "a renamed workout": async (a) => write(a, "workouts", { ...(await read(a, "workouts", shortId)), name: "Mine now" }),
    "an entry note": async (a) => write(a, "entries", { ...(await read(a, "entries", entryId)), notes: "felt good" }),
    "a set's rest": async (a) => write(a, "sets", { ...(await read(a, "sets", `${entryId}-s0`)), restSeconds: 90 }),
  };
  for (const [what, edit] of Object.entries(edits)) {
    const { adapter } = await storeWithExisting();
    await importFile(adapter);
    await edit(adapter);
    const { report, apply } = await undo(adapter);
    assert.deepEqual(ids(report.workouts.edited), [shortId], what);
    assert.equal(report.workouts.toDelete.length, 3, what);
    const twist = await strongExerciseId(nameKey("Kneeling Cable Twist"));
    assert.deepEqual(ids(report.exercises.inUse), [twist], what); // still used by the kept workout
    await apply();
    const exported = JSON.parse(await exportOf(adapter));
    assert.deepEqual(exported.data.workouts.map((w) => w.id).sort(), [shortId, "w-mine"].sort(), what);
    assert.ok(exported.data.exercises.some((e) => e.id === twist), what);
  }
});

test("strong undo: a custom exercise in use (a template, another workout) or renamed is kept and listed", async () => {
  const { adapter, store } = await storeWithExisting();
  await importFile(adapter);
  const bench = await strongExerciseId(nameKey("Bench Press (Barbell)"));
  const curl = await strongExerciseId(nameKey("Curl (Dumbbell)"));
  const squat = await strongExerciseId(nameKey("Squat (Barbell)"));
  await store.saveTemplate({ name: "Push", exercises: [{ exerciseId: bench, setCount: 3 }] });
  await store.saveWorkoutWithDetails(
    { id: "w-later", startedAt: "2025-03-01T10:00:00.000Z", endedAt: "2025-03-01T11:00:00.000Z" },
    [{ id: "e-later", workoutId: "w-later", exerciseId: curl, order: 0 }],
    [{ id: "s-later", entryId: "e-later", order: 0, reps: 8, weightValue: 30, weightUnit: "lb", completedAt: "2025-03-01T10:30:00.000Z" }],
  );
  await store.updateCustomExercise(squat, { name: "My Squat", primaryMuscles: ["quads"] });
  const { report, apply } = await undo(adapter);
  assert.equal(report.workouts.toDelete.length, 4);
  assert.deepEqual(ids(report.exercises.inUse), [bench, curl].sort());
  assert.deepEqual(report.exercises.inUse.find((e) => e.id === bench).usage.templates, 1);
  assert.deepEqual(report.exercises.inUse.find((e) => e.id === curl).usage.workouts, 1);
  assert.deepEqual(report.exercises.renamed.map((e) => [e.id, e.name]), [[squat, "My Squat"]]);
  await apply();
  for (const id of [bench, curl, squat]) assert.ok(await read(adapter, "exercises", id), id);
  assert.ok(await read(adapter, "workouts", "w-later"));
  assert.equal((await store.listTemplates()).length, 1);
});

test("strong undo: a second run deletes nothing", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter);
  await (await undo(adapter)).apply();
  const after = await exportOf(adapter);
  const { report, apply } = await undo(adapter);
  assert.deepEqual([report.workouts.toDelete, report.exercises.toDelete, report.workouts.notFound.length], [[], [], 4]);
  await apply();
  assert.equal(await exportOf(adapter), after);
});

test("strong undo: a failure part-way leaves the export byte for byte unchanged", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter);
  const before = await exportOf(adapter);
  const prepared = await prepareStrongUndo(FIXTURE);
  const report = await checkStrongUndo(adapter, prepared);
  let deletes = 0;
  const failing = {
    ...adapter,
    transaction: (names, mode, fn) => adapter.transaction(names, mode, (tx) => fn({
      ...tx,
      delete: async (store, key) => { deletes += 1; if (deletes === 20) throw new Error("injected failure"); return tx.delete(store, key); },
    })),
  };
  await assert.rejects(applyStrongUndo(failing, prepared, report), /injected failure/);
  assert.equal(deletes, 20);
  assert.equal(await exportOf(adapter), before);
});

test("strong undo: data changed after the check refuses everything", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter);
  const { apply } = await undo(adapter);
  const shortId = await idOf(SHORT);
  await write(adapter, "sets", { ...(await read(adapter, "sets", `${shortId}-e0-s0`)), reps: 14 });
  const edited = await exportOf(adapter);
  await assert.rejects(apply(), /changed since the check; nothing was deleted/);
  assert.equal(await exportOf(adapter), edited);
});

test("strong undo: workouts not in storage are not found, rows with errors are not checked, a non-Strong file is refused", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter);
  const other = `${FIXTURE.split(/\r?\n/)[0]}\n2025-05-05 10:00:00,"Other",30m,"Squat (Barbell)",1,100.0,5.0,0,0.0,\n2025-05-06 10:00:00,"Bad",30m,"Squat (Barbell)",Z,100.0,5.0,0,0.0,\n`;
  const { report } = await undo(adapter, other);
  assert.deepEqual(report.workouts.notFound.map((w) => w.name), ["Other"]);
  assert.deepEqual(report.workouts.notChecked.map((w) => w.name), ["Bad"]);
  assert.deepEqual(report.workouts.toDelete, []);
  await assert.rejects(checkStrongUndo(adapter, await prepareStrongUndo("not,a,strong,file\n")), /cannot be read/);
});

test("strong undo: the unit is found per workout; one set in the other unit makes the workout edited", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter, { unit: "kg" });
  const shortId = await idOf(SHORT);
  await write(adapter, "sets", { ...(await read(adapter, "sets", `${shortId}-e0-s1`)), weightUnit: "lb" });
  const { report } = await undo(adapter);
  assert.deepEqual(report.workouts.toDelete.map((w) => w.unit), ["kg", "kg", "kg"]);
  assert.deepEqual(ids(report.workouts.edited), [shortId]);
});

test("strong undo: an entry moved to another exercise is seen only when its name is in another workout of the file (the known gap)", async () => {
  const { adapter, exercise } = await storeWithExisting();
  await importFile(adapter);
  const morning = await idOf(MORNING);
  const last = await idOf(LAST);
  const entries = await adapter.transaction(["entries"], "readonly", (tx) => tx.getAllByIndex("entries", "workoutId", morning));
  const lat = await strongExerciseId(nameKey("Lat Pulldown (Cable)"));
  const squat = await strongExerciseId(nameKey("Squat (Barbell)"));
  // The gap: "Lat Pulldown (Cable)" is only in this workout, so moving its entry to My Own Lift is not seen.
  const latEntry = entries.find((e) => e.exerciseId === lat);
  await write(adapter, "entries", { ...latEntry, exerciseId: exercise.id });
  let { report } = await undo(adapter);
  assert.ok(ids(report.workouts.toDelete).includes(morning), "documented gap: the moved entry's workout is still deleted");
  // The partial check: "Squat (Barbell)" is also in the last workout, so moving it here is seen; both are kept.
  await write(adapter, "entries", { ...latEntry, exerciseId: lat });
  await write(adapter, "entries", { ...entries.find((e) => e.exerciseId === squat), exerciseId: exercise.id });
  ({ report } = await undo(adapter));
  assert.deepEqual(ids(report.workouts.edited), [morning, last].sort());
  assert.ok(report.workouts.edited.every((w) => /"Squat \(Barbell\)" is not the same exercise/.test(w.reason)));
});

test("strong undo: a search over its step limit is 'could not verify', and nothing is deleted", async () => {
  const { adapter } = await storeWithExisting();
  await importFile(adapter);
  const before = await exportOf(adapter);
  const { report, apply } = await undo(adapter, FIXTURE, { maxSteps: 1 });
  assert.equal(report.workouts.unverified.length, 4);
  assert.deepEqual([report.workouts.toDelete, report.exercises.toDelete.length], [[], 0]); // every custom is still in use
  await apply();
  assert.equal(await exportOf(adapter), before);
});
