// Logger rule tests, shared by Node (memory adapter) and the browser page
// (IndexedDB adapter). No node:test import: ctx.assert and ctx.createAdapter
// are supplied by the runner.

import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { rawCounts, failAfter } from "./store-rules.js";

export const loggerRules = [];
const rule = (name, run) => loggerRules.push({ name, run });

const START = "2026-10-22T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const BENCH = "seed-barbell-bench-press";
const SQUAT = "seed-barbell-squat";

// A store with the seed exercises and a logger whose clock the test controls.
async function setup(ctx, options = {}) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const clock = { time: Date.parse(START) };
  const make = (extra = {}) => createLogger(store, { now: () => new Date(clock.time), ...options, ...extra });
  return { adapter, store, clock, logger: make(), make };
}

const bench = (reps, weight, weightUnit = "kg") => ({ exerciseId: BENCH, reps, weight, weightUnit });

// ---- logging a set ----

rule("logger: the first set starts a workout, an entry and a set", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  assert.deepEqual(await logger.getStatus(), { kind: "none" });
  const set = await logger.logSet(bench("8", "100", "kg"));
  assert.equal(set.reps, 8);
  assert.equal(set.weightValue, 100);
  assert.equal(set.weightUnit, "kg");
  assert.equal(set.order, 0);
  assert.equal(set.completedAt, START);
  const { status, workout } = await logger.getCurrent();
  assert.equal(status.kind, "active");
  assert.equal(workout.startedAt, START);
  assert.equal(workout.endedAt, null);
  assert.equal(workout.entries.length, 1);
  assert.equal(workout.entries[0].exerciseName, "Barbell bench press");
  assert.deepEqual(workout.entries[0].sets.map((s) => s.id), [set.id]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
});

rule("logger: more sets reuse the exercise's entry; a new exercise gets a new entry", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  clock.time += 90 * 1000;
  const second = await logger.logSet(bench("6", "105"));
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  const third = await logger.logSet(bench("5", "110"));
  assert.equal(second.order, 1);
  assert.equal(third.order, 2);
  const { workout } = await logger.getCurrent();
  assert.deepEqual(workout.entries.map((e) => [e.exerciseName, e.order, e.sets.length]), [
    ["Barbell bench press", 0, 3],
    ["Barbell back squat", 1, 1],
  ]);
  assert.deepEqual(workout.entries[0].sets.map((s) => s.reps), [8, 6, 5]);
  assert.equal(workout.startedAt, START); // the workout start does not move
});

rule("logger: weight is stored exactly as entered, in the unit entered", async (ctx) => {
  const { assert } = ctx;
  const { logger, store } = await setup(ctx);
  await logger.logSet(bench("5", "62,5", "lb"));
  await logger.logSet(bench("5", "100", "kg"));
  const { workout } = await logger.getCurrent();
  const sets = workout.entries[0].sets;
  assert.deepEqual(sets.map((s) => [s.weightValue, s.weightUnit]), [[62.5, "lb"], [100, "kg"]]);
  assert.equal((await store.getSet(sets[1].id)).weightValue, 100);
});

rule("logger: blank or whitespace reps and weight are errors and never become 0", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  for (const blank of ["", " ", "   ", "\t", "\n", " "]) {
    await assert.rejects(logger.logSet(bench(blank, "100")), /reps is required/);
    await assert.rejects(logger.logSet(bench("5", blank)), /weight is required/);
  }
  await assert.rejects(logger.logSet(bench(undefined, "100")), /reps/);
  await assert.rejects(logger.logSet(bench("5", undefined)), /weight must be a number/);
  await assert.rejects(logger.logSet(bench("5", null)), /weight must be a number/);
  await assert.rejects(logger.logSet(bench(null, "100")), /reps/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
});

rule("logger: typed negative and too-large numbers say what is wrong and log nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  await assert.rejects(logger.logSet(bench("5", "-3")), /^Error: weight can't be negative$/);
  await assert.rejects(logger.logSet(bench("5", "-62,5")), /^Error: weight can't be negative$/);
  await assert.rejects(logger.logSet(bench("-3", "100")), /^Error: reps can't be negative$/);
  await assert.rejects(logger.logSet(bench("920319039", "100")), /^Error: reps is above the maximum of 1000$/);
  await assert.rejects(logger.logSet(bench("1001", "100")), /^Error: reps is above the maximum of 1000$/);
  await assert.rejects(logger.logSet(bench("5", "2500.5", "kg")), /^Error: weight is above the maximum of 2500 kg$/);
  await assert.rejects(logger.logSet(bench("5", "5512", "lb")), /^Error: weight is above the maximum of 5511\.55 lb$/);
  await assert.rejects(logger.logSet(bench("5", "99999999999", "kg")), /weight is above the maximum of 2500 kg/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  const edge = await logger.logSet(bench("1000", "2500", "kg"));
  assert.deepEqual([edge.reps, edge.weightValue], [1000, 2500]);
});

rule("logger: bodyweight is an explicit 0", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  const typed = await logger.logSet({ exerciseId: "seed-pull-up", reps: "10", weight: "0", weightUnit: "kg" });
  const numeric = await logger.logSet({ exerciseId: "seed-pull-up", reps: 10, weight: 0, weightUnit: "kg" });
  assert.equal(typed.weightValue, 0);
  assert.equal(numeric.weightValue, 0);
});

rule("logger: reps and weight text is parsed strictly", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  for (const reps of ["0", "1.5", "1,5", "-3", "5 reps", "1e1", "0x5", "abc"]) {
    await assert.rejects(logger.logSet(bench(reps, "100")), /reps/);
  }
  for (const weight of ["1,500", "1.500,5", "1e3", "0x10", "Infinity", "NaN", "-5", "+5", "6 2", ".5", "5.", "abc"]) {
    await assert.rejects(logger.logSet(bench("5", weight)), /weight/);
  }
  await assert.rejects(logger.logSet({ ...bench("5", "100"), weightUnit: "stone" }), /weightUnit/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  const set = await logger.logSet(bench(" 5 ", " 62,5 "));
  assert.deepEqual([set.reps, set.weightValue], [5, 62.5]);
});

rule("logger: an unknown exercise is rejected and nothing is saved", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  await assert.rejects(logger.logSet({ exerciseId: "no-such-exercise", reps: "5", weight: "100", weightUnit: "kg" }), /exerciseId/);
  await assert.rejects(logger.logSet({ reps: "5", weight: "100", weightUnit: "kg" }), /exerciseId/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
});

rule("logger: suggestNextSet returns the last set of that exercise in the current workout", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  assert.equal(await logger.suggestNextSet(BENCH), null);
  await logger.logSet(bench("8", "100", "kg"));
  await logger.logSet(bench("6", "62,5", "lb"));
  assert.deepEqual(await logger.suggestNextSet(BENCH), { reps: 6, weightValue: 62.5, weightUnit: "lb" });
  assert.equal(await logger.suggestNextSet(SQUAT), null);
});

// ---- finishing, discarding, deleting ----

rule("logger: finishWorkout ends the workout now, and the next set starts a new one", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock } = await setup(ctx);
  await assert.rejects(logger.finishWorkout(), /no unfinished workout/);
  await logger.logSet(bench("8", "100"));
  clock.time += 45 * 60 * 1000;
  const finished = await logger.finishWorkout();
  assert.equal(finished.startedAt, START);
  assert.equal(finished.endedAt, "2026-10-22T10:45:00.000Z");
  assert.deepEqual(await logger.getStatus(), { kind: "none" });
  clock.time += 60 * 1000;
  await logger.logSet(bench("8", "100"));
  const { workout } = await logger.getCurrent();
  assert.equal(workout.startedAt, "2026-10-22T10:46:00.000Z");
  assert.equal((await logger.getHistory()).length, 1);
});

rule("logger: a workout with no sets cannot be finished, only discarded", async (ctx) => {
  const { assert } = ctx;
  const { logger, adapter } = await setup(ctx);
  const set = await logger.logSet(bench("8", "100"));
  await logger.deleteSet(set.id); // leaves an empty workout
  assert.equal((await logger.getStatus()).kind, "active");
  await assert.rejects(logger.finishWorkout(), /no sets/);
  assert.equal(await logger.discardWorkout(), true);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
});

rule("logger: deleteSet removes a set of the current workout, and the last set of an entry removes the entry", async (ctx) => {
  const { assert } = ctx;
  const { logger, adapter } = await setup(ctx);
  const a = await logger.logSet(bench("8", "100"));
  const b = await logger.logSet(bench("6", "105"));
  const c = await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  await logger.deleteSet(a.id);
  assert.deepEqual((await logger.getCurrent()).workout.entries.map((e) => e.sets.length), [1, 1]);
  await logger.deleteSet(c.id);
  assert.deepEqual((await logger.getCurrent()).workout.entries.map((e) => e.exerciseName), ["Barbell bench press"]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  // a new set after deleting continues numbering after the highest order
  const d = await logger.logSet(bench("4", "110"));
  assert.equal(d.order, b.order + 1);
  await assert.rejects(logger.deleteSet("no-such-set"), /not in the current workout/);
});

rule("logger: deleteSet refuses a set from a finished workout", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, adapter } = await setup(ctx);
  const old = await logger.logSet(bench("8", "100"));
  await logger.finishWorkout();
  clock.time += 60 * 1000;
  await logger.logSet(bench("5", "100"));
  await assert.rejects(logger.deleteSet(old.id), /not in the current workout/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 2 });
});

rule("logger: discardWorkout removes the current workout, its entries and sets, and nothing else", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, adapter } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  await logger.finishWorkout();
  clock.time += 60 * 1000;
  await logger.logSet(bench("5", "100"));
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  assert.equal(await logger.discardWorkout(), true);
  assert.deepEqual(await logger.getStatus(), { kind: "none" });
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 }); // the finished one is kept
  await assert.rejects(logger.discardWorkout(), /no unfinished workout/);
});

// ---- stale workouts ----

rule("logger stale: an unfinished workout older than 12 hours is never continued silently", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, adapter } = await setup(ctx);
  const first = await logger.logSet(bench("8", "100"));
  clock.time += 13 * HOUR;
  const status = await logger.getStatus();
  assert.equal(status.kind, "stale");
  assert.equal(status.workout.startedAt, START);
  const current = await logger.getCurrent();
  assert.equal(current.status.kind, "stale");
  assert.equal(current.workout.entries[0].sets.length, 1);
  await assert.rejects(logger.logSet(bench("8", "100")), /Finish, continue or discard/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.equal(await logger.suggestNextSet(BENCH), null);
  assert.equal((await logger.getCurrent()).workout.entries[0].sets[0].id, first.id);
});

rule("logger stale: the threshold is more than 12 hours, and it is a parameter", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, make } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  clock.time += 12 * HOUR;
  assert.equal((await logger.getStatus()).kind, "active"); // exactly 12 hours is not "more than"
  clock.time += 1;
  assert.equal((await logger.getStatus()).kind, "stale");
  assert.equal((await make({ staleAfterHours: 24 }).getStatus()).kind, "active");
  assert.equal((await make({ staleAfterHours: 0.5 }).getStatus()).kind, "stale");
  for (const bad of [0, -1, "12", Infinity, NaN, null]) {
    let message = null;
    try {
      make({ staleAfterHours: bad });
    } catch (error) {
      message = error.message;
    }
    assert.ok(message !== null && /staleAfterHours/.test(message), `accepted ${String(bad)}`);
  }
});

rule("logger stale: Continue resumes it, and the choice is remembered", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, make } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  clock.time += 20 * HOUR;
  assert.equal((await logger.getStatus()).kind, "stale");
  assert.equal((await logger.continueWorkout()).kind, "active");
  const set = await logger.logSet(bench("6", "100"));
  assert.equal(set.order, 1);
  // a brand-new logger over the same database also sees it as continued
  assert.equal((await make().getStatus()).kind, "active");
  await assert.rejects(logger.continueWorkout(), /no unfinished workout to continue/);
});

rule("logger stale: Finish ends it at its last activity, not now", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, store } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  clock.time += 20 * 60 * 1000;
  const last = await logger.logSet(bench("6", "100"));
  clock.time += 30 * HOUR;
  assert.equal((await logger.getStatus()).kind, "stale");
  const finished = await logger.finishWorkout();
  assert.equal(finished.endedAt, last.completedAt);
  assert.equal(finished.endedAt, "2026-10-22T10:20:00.000Z");
  assert.deepEqual(await logger.getStatus(), { kind: "none" });
  assert.equal(await store.getContinuedWorkoutId(), null);
  const set = await logger.logSet(bench("5", "100")); // now a new workout starts
  assert.equal((await logger.getCurrent()).workout.startedAt, set.completedAt);
});

rule("logger stale: Discard removes it and everything in it", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock, adapter } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  clock.time += 15 * HOUR;
  assert.equal((await logger.getStatus()).kind, "stale");
  assert.equal(await logger.discardWorkout(), true);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  assert.deepEqual(await logger.getStatus(), { kind: "none" });
});

rule("logger stale: the newest unfinished workout decides, and an older one surfaces after it", async (ctx) => {
  const { assert } = ctx;
  const { logger, store } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  const current = (await logger.getStatus()).workout;
  // an older unfinished workout, as an import could bring
  await store.saveWorkout({ id: "very-old", startedAt: "2026-01-01T10:00:00.000Z" });
  const status = await logger.getStatus();
  assert.equal(status.kind, "active");
  assert.equal(status.workout.id, current.id);
  await logger.finishWorkout();
  const next = await logger.getStatus();
  assert.equal(next.kind, "stale");
  assert.equal(next.workout.id, "very-old");
  await assert.rejects(logger.logSet(bench("8", "100")), /Finish, continue or discard/);
});

// ---- exercises, search, history ----

rule("logger: addCustomExercise saves a custom exercise with a normalized name", async (ctx) => {
  const { assert } = ctx;
  const { logger, store } = await setup(ctx);
  const saved = await logger.addCustomExercise({
    name: "  My   cable\tfly ", primaryMuscles: ["chest"], secondaryMuscles: ["front_delts"], equipmentTags: ["cable"],
  });
  assert.equal(saved.name, "My cable fly");
  assert.equal(saved.isCustom, true);
  assert.deepEqual(await store.getExercise(saved.id), saved);
  assert.equal((await logger.findExercises("cable fly")).map((e) => e.id)[0], saved.id);
});

rule("logger: addCustomExercise rejects duplicate names (ignoring case), bad muscles and a missing primary muscle", async (ctx) => {
  const { assert } = ctx;
  const { logger, adapter } = await setup(ctx);
  const before = (await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"))).length;
  await assert.rejects(logger.addCustomExercise({ name: "BARBELL BENCH PRESS", primaryMuscles: ["chest"] }), /already exists/);
  await logger.addCustomExercise({ name: "Zercher squat", primaryMuscles: ["quads"] });
  await assert.rejects(logger.addCustomExercise({ name: " zercher   SQUAT ", primaryMuscles: ["quads"] }), /already exists/);
  await assert.rejects(logger.addCustomExercise({ name: "Fly", primaryMuscles: ["pecs"] }), /primaryMuscles\[0\]/);
  await assert.rejects(logger.addCustomExercise({ name: "Fly", primaryMuscles: [] }), /at least one muscle/);
  await assert.rejects(logger.addCustomExercise({ name: "Fly", primaryMuscles: ["chest"], equipmentTags: ["rocket"] }), /equipmentTags\[0\]/);
  await assert.rejects(logger.addCustomExercise({ name: "x".repeat(81), primaryMuscles: ["chest"] }), /at most 80/);
  assert.equal((await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"))).length, before + 1);
});

rule("logger: findExercises searches names, muscles and equipment", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  assert.equal((await logger.findExercises("")).length, SEED_EXERCISES.length);
  assert.equal((await logger.findExercises("bench"))[0].id, BENCH);
  const calves = (await logger.findExercises("calves")).map((e) => e.id);
  assert.ok(calves.includes("seed-standing-calf-raise") && calves.includes("seed-seated-leg-curl"));
  assert.deepEqual(await logger.findExercises("zzzz"), []);
});

rule("logger: history lists finished workouts newest first with counts, and details have names", async (ctx) => {
  const { assert } = ctx;
  const { logger, clock } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  await logger.logSet(bench("6", "100"));
  await logger.finishWorkout();
  clock.time += 24 * HOUR;
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  assert.deepEqual((await logger.getHistory()).map((w) => [w.entryCount, w.setCount]), [[1, 2]]); // the current one is not history
  const second = await logger.finishWorkout();
  const history = await logger.getHistory();
  assert.deepEqual(history.map((w) => [w.startedAt, w.entryCount, w.setCount]), [
    [second.startedAt, 1, 1],
    [START, 1, 2],
  ]);
  const detail = await logger.getWorkoutDetail(history[1].id);
  assert.equal(detail.entries[0].exerciseName, "Barbell bench press");
  assert.equal(detail.entries[0].sets.length, 2);
  assert.equal(await logger.getWorkoutDetail("no-such-workout"), null);
});

// ---- deleting a finished workout ----

// Logs and finishes a workout: 2 entries (bench x2 sets, squat x1 set) = 3 sets.
async function finishedWorkout(env) {
  const { logger, clock } = env;
  clock.time += 24 * HOUR;
  await logger.logSet(bench("8", "100"));
  await logger.logSet(bench("6", "100"));
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  clock.time += 45 * 60 * 1000;
  const finished = await logger.finishWorkout();
  clock.time += 60 * 1000;
  return finished;
}

rule("logger: deleteFinishedWorkout removes the workout, its entries and sets, and leaves the others untouched", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  const { adapter, store, logger } = env;
  const doomed = await finishedWorkout(env);
  const kept = await finishedWorkout(env);
  assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 4, sets: 6 });
  const keptBefore = await logger.getWorkoutDetail(kept.id);
  const exercisesBefore = (await store.listExercises()).length;

  assert.equal(await logger.deleteFinishedWorkout(doomed.id), true);

  assert.equal(await logger.getWorkoutDetail(doomed.id), null);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 3 }); // no orphans
  assert.deepEqual(await logger.getWorkoutDetail(kept.id), keptBefore);
  assert.deepEqual((await logger.getHistory()).map((w) => w.id), [kept.id]);
  assert.equal((await store.listExercises()).length, exercisesBefore); // exercises are never deleted
});

rule("logger: deleting the only finished workout leaves an empty history", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  const only = await finishedWorkout(env);
  await env.logger.deleteFinishedWorkout(only.id);
  assert.deepEqual(await env.logger.getHistory(), []);
  assert.deepEqual(await rawCounts(env.adapter), { workouts: 0, entries: 0, sets: 0 });
  await assert.rejects(env.logger.deleteFinishedWorkout(only.id), /no workout with that id/); // not twice
});

rule("logger: deleteFinishedWorkout refuses an unfinished workout, which is what Discard is for", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger, clock } = await setup(ctx);
  await logger.logSet(bench("8", "100"));
  const current = (await logger.getStatus()).workout;
  await assert.rejects(logger.deleteFinishedWorkout(current.id), /not finished; use Discard/);
  clock.time += 20 * HOUR; // an old unfinished workout is still unfinished
  assert.equal((await logger.getStatus()).kind, "stale");
  await assert.rejects(logger.deleteFinishedWorkout(current.id), /not finished; use Discard/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.equal(await logger.discardWorkout(), true); // the intended path still works
});

rule("logger: deleteFinishedWorkout rejects an unknown id and an invalid id, deleting nothing", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  await finishedWorkout(env);
  const { adapter, logger } = env;
  await assert.rejects(logger.deleteFinishedWorkout("no-such-workout"), /There is no workout with that id/);
  for (const bad of ["", undefined, null, 7]) {
    await assert.rejects(logger.deleteFinishedWorkout(bad), /id must be a non-empty string/);
  }
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 3 });
});

rule("logger: a failed deleteFinishedWorkout rolls back and leaves the workout complete", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  const { adapter, logger } = env;
  const finished = await finishedWorkout(env);
  const before = await logger.getWorkoutDetail(finished.id);
  // 3 sets + 2 entries + 1 workout = 6 deletes: fail on the first, in the middle, and on the last
  for (const succeed of [0, 2, 5]) {
    const failing = createLogger(createStore(failAfter(adapter, { deletes: succeed })), { now: () => new Date(env.clock.time) });
    await assert.rejects(failing.deleteFinishedWorkout(finished.id), /injected failure/);
    assert.deepEqual(await logger.getWorkoutDetail(finished.id), before);
    assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 2, sets: 3 });
  }
  assert.equal(await logger.deleteFinishedWorkout(finished.id), true); // works once the fault is gone
});

rule("logger: deleting a finished workout does not touch the current workout", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  const { adapter, logger } = env;
  const finished = await finishedWorkout(env);
  await logger.logSet(bench("5", "100")); // starts a new, unfinished workout
  const current = (await logger.getCurrent()).workout;
  await logger.deleteFinishedWorkout(finished.id);
  const after = await logger.getCurrent();
  assert.equal(after.status.kind, "active");
  assert.deepEqual(after.workout, current);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
});

rule("logger: workout details report how many sets they hold", async (ctx) => {
  const { assert } = ctx;
  const env = await setup(ctx);
  const finished = await finishedWorkout(env);
  const detail = await env.logger.getWorkoutDetail(finished.id);
  assert.equal(detail.setCount, 3);
  assert.deepEqual(detail.entries.map((entry) => entry.sets.length), [2, 1]);
});

rule("logger: preferred unit passes through to the store", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  assert.equal(await logger.getPreferredUnit(), "lb");
  await logger.setPreferredUnit("kg");
  assert.equal(await logger.getPreferredUnit(), "kg");
  await assert.rejects(logger.setPreferredUnit("stone"), /unit must be/);
});

// ---- records (src/domain/strength.js) ----

const rawSets = (adapter) => adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets"));

rule("logger: getRecords uses the preferred unit; changing it changes the converted values, never the stored ones", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  await logger.logSet(bench("5", "100", "kg"));
  await logger.finishWorkout();
  const stored = await rawSets(adapter);
  const inLb = await logger.getRecords();
  assert.equal(inLb.unit, "lb");
  assert.equal(inLb.records[BENCH].weight.value, 220.5);
  assert.equal(inLb.ignored, 0);
  await logger.setPreferredUnit("kg");
  const inKg = await logger.getRecords();
  assert.equal(inKg.unit, "kg");
  assert.equal(inKg.records[BENCH].weight.value, 100);
  assert.equal(inKg.records[BENCH].e1rm.value, 116.7);
  assert.deepEqual(inKg.history.map((entry) => entry.type), ["weight", "e1rm", "volume"]);
  assert.deepEqual(await rawSets(adapter), stored);
  assert.equal(stored[0].weightValue, 100);
  assert.equal(stored[0].weightUnit, "kg");
});

rule("logger: getRecords passes the ignored count through", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const logged = await logger.logSet(bench("5", "100", "kg"));
  await logger.finishWorkout();
  // A set in a unit the record maths does not know, written past the store's validation.
  await adapter.transaction(["sets"], "readwrite", (tx) => tx.put("sets", { ...logged, id: "odd-unit", order: 1, weightUnit: "st" }));
  const result = await logger.getRecords();
  assert.equal(result.ignored, 1);
  assert.equal(result.records[BENCH].weight.value, 220.5);
});
