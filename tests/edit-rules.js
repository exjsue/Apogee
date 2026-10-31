// Rule tests for editing a finished workout from History (logger.saveWorkoutEdit, src/domain/workout-edit.js),
// shared by Node (memory adapter) and the browser page (IndexedDB adapter). No node:test import: ctx.assert and
// ctx.createAdapter are supplied by the runner.

import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { draftFromWorkout, localDate } from "../src/domain/workout-edit.js";
import { WORKOUT_CHANGED } from "../src/storage/schema.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { rawCounts } from "./store-rules.js";

export const editRules = [];
const rule = (name, run) => editRules.push({ name, run });

const START = "2026-10-12T10:00:00.000Z";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BENCH = "seed-barbell-bench-press";
const SQUAT = "seed-barbell-squat";

// A finished workout on START with three bench sets (8 x 100, 5 x 110, 3 x 120 kg, a minute apart), and the
// clock moved on three days. Resolves the detail an edit starts from.
async function setup(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const clock = { time: Date.parse(START) };
  const logger = createLogger(store, { now: () => new Date(clock.time) });
  for (const [reps, weight] of [["8", "100"], ["5", "110"], ["3", "120"]]) {
    await logger.logSet({ exerciseId: BENCH, reps, weight, weightUnit: "kg" });
    clock.time += MINUTE;
  }
  const { id } = await logger.finishWorkout();
  clock.time += 3 * DAY;
  return { adapter, store, clock, logger, id, detail: await logger.getWorkoutDetail(id) };
}

const allSets = (detail) => detail.entries.flatMap((entry) => entry.sets);
const working = { reps: "5", weight: "60", unit: "kg", isWarmup: false };

rule("edit: a new date moves startedAt, endedAt and every set's completedAt by one offset; ids stay", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail } = await setup(ctx);
  const draft = draftFromWorkout(detail);
  draft.date = localDate(new Date(Date.parse(START) - 2 * DAY).toISOString());
  await logger.saveWorkoutEdit(detail, draft);
  const after = await logger.getWorkoutDetail(id);
  assert.equal(Date.parse(after.startedAt), Date.parse(detail.startedAt) - 2 * DAY);
  assert.equal(Date.parse(after.endedAt), Date.parse(detail.endedAt) - 2 * DAY);
  assert.deepEqual(allSets(after).map((set) => [set.id, Date.parse(set.completedAt)]), allSets(detail).map((set) => [set.id, Date.parse(set.completedAt) - 2 * DAY]));
  assert.deepEqual(after.entries.map((entry) => entry.id), detail.entries.map((entry) => entry.id));
});

rule("edit: a date in the future is refused and nothing changes", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger, id, detail } = await setup(ctx);
  const stored = await store.getWorkoutWithDetails(id);
  const draft = draftFromWorkout(detail);
  draft.date = localDate(new Date(clock.time + DAY).toISOString());
  await assert.rejects(logger.saveWorkoutEdit(detail, draft), /in the future/);
  for (const bad of ["2026-02-30", "", "12/10/2026"]) {
    draft.date = bad;
    await assert.rejects(logger.saveWorkoutEdit(detail, draft), /valid date/);
  }
  assert.deepEqual(await store.getWorkoutWithDetails(id), stored);
  // Today is allowed: the workout keeps its clock time, which is before "now" here.
  draft.date = localDate(new Date(clock.time).toISOString());
  await logger.saveWorkoutEdit(detail, draft);
  assert.equal(Date.parse((await store.getWorkout(id)).startedAt), Date.parse(detail.startedAt) + 3 * DAY);
});

rule("edit: weight, reps, unit and warm-up change in place; the unit is never converted; live-logging validation applies", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail, adapter } = await setup(ctx);
  const before = await rawCounts(adapter);
  const draft = draftFromWorkout(detail);
  Object.assign(draft.entries[0].sets[1], { reps: "6", weight: "242,5", unit: "lb" });
  for (const [reps, weight, pattern] of [["", "1", /set 2: reps is required/], ["0", "1", /reps must be at least 1/], ["2.5", "1", /reps must be a whole number/], ["1", "-1", /weight can't be negative/], ["1", "", /weight is required/], ["1", "9999", /weight is above the maximum/]]) {
    const bad = draftFromWorkout(detail);
    Object.assign(bad.entries[0].sets[1], { reps, weight });
    await assert.rejects(logger.saveWorkoutEdit(detail, bad), pattern);
  }
  const unknownUnit = draftFromWorkout(detail);
  unknownUnit.entries[0].sets[0].unit = "st";
  await assert.rejects(logger.saveWorkoutEdit(detail, unknownUnit), /weightUnit must be "kg" or "lb"/);
  await logger.saveWorkoutEdit(detail, draft);
  const set = (await logger.getWorkoutDetail(id)).entries[0].sets[1];
  assert.deepEqual([set.id, set.reps, set.weightValue, set.weightUnit, set.order, set.completedAt], [detail.entries[0].sets[1].id, 6, 242.5, "lb", 1, detail.entries[0].sets[1].completedAt]);
  assert.deepEqual(await rawCounts(adapter), before);
});

rule("edit: new sets and a new exercise are completed after every existing set, inside the window, and ordered last", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail } = await setup(ctx);
  const draft = draftFromWorkout(detail);
  draft.entries[0].sets.push({ id: null, ...working });
  draft.entries.push({ id: null, exerciseId: SQUAT, exerciseName: "Squat", markCustom: false, sets: [{ id: null, ...working }, { id: null, ...working, reps: "3" }] });
  await logger.saveWorkoutEdit(detail, draft);
  const after = await logger.getWorkoutDetail(id);
  assert.deepEqual(after.entries.map((entry) => [entry.exerciseId, entry.order]), [[BENCH, 0], [SQUAT, 1]]);
  assert.deepEqual(after.entries[0].sets.map((set) => set.order), [0, 1, 2, 3]);
  assert.deepEqual(after.entries[1].sets.map((set) => [set.order, set.reps]), [[0, 5], [1, 3]]);
  const lastOld = Math.max(...allSets(detail).map((set) => Date.parse(set.completedAt)));
  const added = [after.entries[0].sets[3], ...after.entries[1].sets].map((set) => Date.parse(set.completedAt));
  assert.ok(added.every((at) => at > lastOld), "after every existing set");
  assert.ok(added[0] < added[1] && added[1] < added[2], "in the order they were added");
  assert.ok(added.every((at) => at >= Date.parse(after.startedAt) && at <= Date.parse(after.endedAt)), "inside the workout's window");
  assert.deepEqual((await logger.getHistory()).map((workout) => [workout.entryCount, workout.setCount]), [[2, 6]]);
});

rule("edit: deleting sets keeps the others' ids; an exercise left with none loses its entry; zero sets is refused", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail, adapter } = await setup(ctx);
  const withSquat = draftFromWorkout(detail);
  withSquat.entries.push({ id: null, exerciseId: SQUAT, exerciseName: "Squat", markCustom: false, sets: [{ id: null, ...working }] });
  await logger.saveWorkoutEdit(detail, withSquat);
  const two = await logger.getWorkoutDetail(id);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 4 });

  const empty = draftFromWorkout(two);
  for (const entry of empty.entries) entry.sets = [];
  await assert.rejects(logger.saveWorkoutEdit(two, empty), /at least one set\. To remove it, use Delete workout/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 4 });

  const draft = draftFromWorkout(two);
  draft.entries[0].sets.splice(1, 1); // the 5 x 110
  draft.entries[1].sets = [];
  await logger.saveWorkoutEdit(two, draft);
  const after = await logger.getWorkoutDetail(id);
  assert.deepEqual(after.entries.map((entry) => entry.exerciseId), [BENCH]);
  assert.deepEqual(after.entries[0].sets.map((set) => set.id), [two.entries[0].sets[0].id, two.entries[0].sets[2].id]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
});

rule("edit: a workout still in progress is refused, by the logger and by the store", async (ctx) => {
  const { assert } = ctx;
  const { store, logger, adapter } = await setup(ctx);
  await logger.logSet({ exerciseId: BENCH, reps: "5", weight: "50", weightUnit: "kg" });
  const current = (await logger.getCurrent()).workout;
  await assert.rejects(logger.saveWorkoutEdit(current, draftFromWorkout(current)), /still in progress/);
  // The store refuses too, whatever the caller claims about the workout.
  const { entries: withSets, ...workout } = await store.getWorkoutWithDetails(current.id);
  const entries = withSets.map(({ sets, ...entry }) => entry);
  const sets = withSets.flatMap((entry) => entry.sets);
  await assert.rejects(store.saveWorkoutWithDetails({ ...workout, endedAt: workout.startedAt }, entries, sets, { expectFinished: { workout, entries, sets } }), /still in progress/);
  assert.equal((await store.getWorkout(current.id)).endedAt, null);
  assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 4 });
});

rule("edit: a save is refused with WORKOUT_CHANGED when the stored workout changed since the edit opened", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail } = await setup(ctx);
  const first = draftFromWorkout(detail);
  first.entries[0].sets[0].reps = "9";
  await logger.saveWorkoutEdit(detail, first); // another tab saves first
  const stale = draftFromWorkout(detail);
  stale.entries[0].sets[2].reps = "1";
  const error = await logger.saveWorkoutEdit(detail, stale).then(() => null, (caught) => caught);
  assert.equal(error?.code, WORKOUT_CHANGED);
  assert.ok(/changed somewhere else/.test(error.message));
  assert.deepEqual((await logger.getWorkoutDetail(id)).entries[0].sets.map((set) => set.reps), [9, 5, 3]);
  // An unchanged workout saves from a fresh read.
  const fresh = await logger.getWorkoutDetail(id);
  await logger.saveWorkoutEdit(fresh, draftFromWorkout(fresh));
  await logger.deleteFinishedWorkout(id);
  await assert.rejects(logger.saveWorkoutEdit(fresh, draftFromWorkout(fresh)), /no longer exists/);
});

rule("edit: a set marked as a warm-up leaves set counts, records and the Body tab; unmarking brings it back", async (ctx) => {
  const { assert } = ctx;
  const { logger, id, detail } = await setup(ctx);
  await logger.setPreferredUnit("kg");
  const records = async () => (await logger.getRecords()).records[BENCH].weight.value;
  const chest = async () => (await logger.getMuscleStatus()).values.chest;
  assert.equal(await records(), 120);
  const chestBefore = await chest();
  const draft = draftFromWorkout(detail);
  draft.entries[0].sets[2].isWarmup = true; // the 3 x 120
  await logger.saveWorkoutEdit(detail, draft);
  assert.deepEqual((await logger.getHistory()).map((workout) => workout.setCount), [2]);
  assert.equal(await records(), 110);
  assert.equal(await chest(), chestBefore - 1);
  const marked = await logger.getWorkoutDetail(id);
  const back = draftFromWorkout(marked);
  back.entries[0].sets[2].isWarmup = false;
  await logger.saveWorkoutEdit(marked, back);
  assert.equal(await records(), 120);
  assert.equal(await chest(), chestBefore);
});

rule("edit: a schema 5 workout keeps its name and every set's rpe and setType; every field the edit does not set is identical", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, id } = await setup(ctx);
  // Give the stored records the schema 5 fields, as an import would.
  const { entries: withSets, ...workout } = await store.getWorkoutWithDetails(id);
  const extras = [{ rpe: 7.5, setType: "failure" }, { rpe: 10 }, { setType: "drop" }];
  await adapter.transaction(["workouts", "sets"], "readwrite", async (tx) => {
    await tx.put("workouts", { ...workout, name: "Push ☝🏽" });
    for (const [i, set] of withSets[0].sets.entries()) await tx.put("sets", { ...set, ...extras[i] });
  });
  const before = await store.getWorkoutWithDetails(id);
  assert.equal(before.name, "Push ☝🏽");
  const detail = await logger.getWorkoutDetail(id);
  const draft = draftFromWorkout(detail);
  draft.entries[0].sets[0].reps = "9"; // the only change: the 8 x 100, which has rpe and setType
  await logger.saveWorkoutEdit(detail, draft);
  const after = await store.getWorkoutWithDetails(id);
  const [first, ...rest] = before.entries[0].sets;
  assert.deepEqual(after, { ...before, entries: [{ ...before.entries[0], sets: [{ ...first, reps: 9 }, ...rest] }] });
  assert.deepEqual(after.entries[0].sets.map((set) => [set.rpe, set.setType]), [[7.5, "failure"], [10, undefined], [undefined, "drop"]]);
});
