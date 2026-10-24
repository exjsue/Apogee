// Reordering rules: moving a set within its exercise and an exercise within the workout, and the order of
// entries that checking the first set of an exercise assigns. Shared by Node (memory adapter) and the browser
// page (IndexedDB adapter). No node:test import: ctx.assert and ctx.createAdapter are supplied by the runner.
//
// One database per rule: in the browser every createAdapter() opens the same test database, so a rule must
// call setup() only once.

import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup } from "../src/backup/backup.js";
import { createWorkSet, createWorkout, createWorkoutEntry } from "../src/domain/model.js";
import { bumpPlan, normalizePlan } from "../src/domain/workout-plan.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { failAfter } from "./store-rules.js";

export const reorderRules = [];
const rule = (name, run) => reorderRules.push({ name, run });

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const BENCH = "seed-barbell-bench-press";
const SQUAT = "seed-barbell-squat";
const DEAD = "seed-conventional-deadlift";
const FIELDS = { reps: "8", weight: "100", unit: "kg" };

async function setup(ctx) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  const clock = { time: T0 };
  const make = (forStore = store) => createLogger(forStore, { now: () => new Date(clock.time) });
  return { adapter, store, clock, logger: make(), make };
}

// Everything the moves may touch, as stored.
const snapshot = (adapter) => adapter.transaction(["workouts", "entries", "sets", "meta"], "readonly", async (tx) => ({
  workouts: (await tx.getAll("workouts")).sort((a, b) => (a.id < b.id ? -1 : 1)),
  entries: (await tx.getAll("entries")).sort((a, b) => (a.id < b.id ? -1 : 1)),
  sets: (await tx.getAll("sets")).sort((a, b) => (a.id < b.id ? -1 : 1)),
  meta: (await tx.getAll("meta")).sort((a, b) => (a.key < b.key ? -1 : 1)),
}));

const without = (records, field) => records.map(({ [field]: dropped, ...rest }) => rest);
const rowIds = (session, exerciseId) => session.blocks.find((block) => block.exerciseId === exerciseId).rows.map((row) => row.id);
const exerciseIds = (session) => session.blocks.map((block) => block.exerciseId);

async function addRows(logger, exerciseId, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push((await logger.addSet(exerciseId)).id);
  return ids;
}

async function finishedOrder(store, logger) {
  const [workout] = await store.listWorkouts();
  return (await logger.getWorkoutDetail(workout.id)).entries.map((entry) => entry.exerciseId);
}

// ---- first-check entry order ----

rule("reorder: checking the first set of an exercise gives entries the order the exercises are SHOWN in, so history matches the screen", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const [bench] = await addRows(logger, BENCH, 1);
  const [squat] = await addRows(logger, SQUAT, 1);
  await logger.checkSet(squat, FIELDS); // squat is checked first, but bench is shown first
  await logger.checkSet(bench, FIELDS);
  assert.deepEqual(exerciseIds(await logger.getSession()), [BENCH, SQUAT]);
  await logger.finishWorkout();
  assert.deepEqual(await finishedOrder(store, logger), [BENCH, SQUAT]);
});

rule("reorder: an exercise moved before its first check keeps its place after Finish", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const [bench] = await addRows(logger, BENCH, 1);
  const [squat] = await addRows(logger, SQUAT, 1);
  await logger.moveExercise(SQUAT, "up", BENCH);
  assert.deepEqual(exerciseIds(await logger.getSession()), [SQUAT, BENCH]);
  await logger.checkSet(bench, FIELDS); // bench is checked first
  await logger.checkSet(squat, FIELDS);
  assert.deepEqual(exerciseIds(await logger.getSession()), [SQUAT, BENCH]);
  await logger.finishWorkout();
  assert.deepEqual(await finishedOrder(store, logger), [SQUAT, BENCH]);
});

rule("reorder: an exercise with an entry that is not in the plan is shown first, in its entry order, then the plan's exercises; entries are numbered like that", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  await logger.logSet({ exerciseId: BENCH, reps: "5", weight: "100", weightUnit: "kg" }); // logSet never uses the plan
  await logger.logSet({ exerciseId: SQUAT, reps: "5", weight: "140", weightUnit: "kg" });
  const [dead] = await addRows(logger, DEAD, 1);
  assert.deepEqual(exerciseIds(await logger.getSession()), [BENCH, SQUAT, DEAD]);
  await logger.checkSet(dead, FIELDS);
  assert.deepEqual(exerciseIds(await logger.getSession()), [BENCH, SQUAT, DEAD]);
  const { entries } = await snapshot(adapter);
  const orderOf = (exerciseId) => entries.find((entry) => entry.exerciseId === exerciseId).order;
  assert.deepEqual([orderOf(BENCH), orderOf(SQUAT), orderOf(DEAD)], [0, 1, 2]);
});

rule("reorder: renumbering changes only `order`, only in the current workout; a finished workout is not touched", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const past = createWorkout({ id: "past", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z" });
  const pastEntries = [
    createWorkoutEntry({ id: "past-e0", workoutId: "past", exerciseId: SQUAT, order: 0, supersetGroup: "A", notes: "first" }),
    createWorkoutEntry({ id: "past-e1", workoutId: "past", exerciseId: BENCH, order: 1, notes: "second" }),
  ];
  const pastSets = pastEntries.map((entry, i) => createWorkSet({
    id: `past-s${i}`, entryId: entry.id, order: 0, reps: 5, weightValue: 50, weightUnit: "kg", completedAt: past.startedAt,
  }));
  await store.saveWorkoutWithDetails(past, pastEntries, pastSets);
  const finishedBefore = (await snapshot(adapter)).entries.filter((entry) => entry.workoutId === "past");

  const [bench] = await addRows(logger, BENCH, 1);
  await logger.checkSet(bench, FIELDS);
  const current = (await snapshot(adapter)).entries.find((entry) => entry.workoutId !== "past");
  await store.saveEntry({ ...current, supersetGroup: "B", notes: "keep me" });
  const before = (await snapshot(adapter)).entries.find((entry) => entry.id === current.id);
  const [squat] = await addRows(logger, SQUAT, 1);
  await logger.moveExercise(SQUAT, "up", BENCH);
  await logger.checkSet(squat, FIELDS); // the new entry goes first, so bench's order changes

  const after = (await snapshot(adapter)).entries;
  const benchAfter = after.find((entry) => entry.id === current.id);
  assert.deepEqual([before.order, benchAfter.order], [0, 1]);
  assert.deepEqual(without([benchAfter], "order"), without([before], "order")); // every other field kept
  assert.equal(benchAfter.supersetGroup, "B");
  assert.deepEqual(after.filter((entry) => entry.workoutId === "past"), finishedBefore);
  await logger.finishWorkout();
  assert.deepEqual(await finishedOrder(store, logger), [SQUAT, BENCH]);
});

// ---- moving sets ----

// A bench exercise with two checked sets (the second owns the running timer), one unchecked row with its own
// rest, and a checked warm-up logged at the end; the shown order is s0, s1, row, warm.
async function benchWithMixedRows(ctx) {
  const env = await setup(ctx);
  const { store, logger, clock } = env;
  const [s0, s1, row] = await addRows(logger, BENCH, 3);
  await logger.checkSet(s0, FIELDS);
  clock.time += 1000;
  await logger.checkSet(s1, { reps: "6", weight: "105", unit: "kg" });
  await logger.setRest(row, 90);
  const details = await store.getWorkoutWithDetails((await store.listWorkouts())[0].id);
  const entry = details.entries[0];
  const warm = createWorkSet({
    id: "warm", entryId: entry.id, order: 7, reps: 5, weightValue: 40, weightUnit: "kg", isWarmup: true, restSeconds: 45, completedAt: "2026-10-22T10:00:00.500Z",
  });
  const { entries, ...workout } = details;
  await store.saveWorkoutWithDetails(workout, entries.map(({ sets, ...rest }) => rest), [...entry.sets, warm]);
  return { ...env, s0, s1, row, warm: warm.id };
}

rule("reorder: moving a set changes only its `order`, and the set it trades with; ids, completedAt, rest, warm-up flags, the timer and the other rows are unchanged", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, s0, s1, row, warm } = await benchWithMixedRows(ctx);
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [s0, s1, row, warm]);
  const before = await snapshot(adapter);
  const timerBefore = await store.getRunningTimer();
  assert.ok(timerBefore !== null && timerBefore.setId === s1);

  await logger.moveSet(warm, "up", row); // a checked set trades with an unchecked row (mixed)
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [s0, s1, warm, row]);
  await logger.moveSet(s0, "down", s1); // two checked sets
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [s1, s0, warm, row]);
  await logger.moveSet(row, "up", warm); // back
  await logger.moveSet(row, "up", s0); // the unchecked row trades with a checked set again
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [s1, row, s0, warm]);

  const after = await snapshot(adapter);
  assert.deepEqual(after.sets.map((set) => set.id), before.sets.map((set) => set.id)); // same id set, none created or deleted
  assert.deepEqual(without(after.sets, "order"), without(before.sets, "order")); // completedAt, rest, isWarmup, weights: all equal
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.workouts, before.workouts);
  assert.deepEqual(await store.getRunningTimer(), timerBefore);
  const planBefore = before.meta.find((record) => record.key === "workoutPlan").value;
  const planAfter = after.meta.find((record) => record.key === "workoutPlan").value;
  assert.deepEqual(without(planAfter.rows, "order"), without(planBefore.rows, "order")); // the row's rest (90) and values kept
  assert.equal(planAfter.rows[0].restSeconds, 90);
  assert.ok(planAfter.rev > planBefore.rev);
  assert.deepEqual(after.meta.filter((record) => record.key !== "workoutPlan"), before.meta.filter((record) => record.key !== "workoutPlan"));
});

rule("reorder: a move between a checked set and an unchecked row trades their two order values: both change or neither", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make, warm, row } = await benchWithMixedRows(ctx);
  const before = await snapshot(adapter);
  const planBefore = before.meta.find((record) => record.key === "workoutPlan").value;
  const warmBefore = before.sets.find((set) => set.id === warm).order;
  const rowBefore = planBefore.rows.find((candidate) => candidate.id === row).order;

  // a failure in the middle of the one transaction leaves everything as it was
  const failing = make(createStore(failAfter(adapter, { puts: 3 })));
  await assert.rejects(failing.moveSet(warm, "up", row), /injected failure/);
  assert.deepEqual(await snapshot(adapter), before);

  await logger.moveSet(warm, "up", row);
  const after = await snapshot(adapter);
  const planAfter = after.meta.find((record) => record.key === "workoutPlan").value;
  assert.deepEqual(
    [after.sets.find((set) => set.id === warm).order, planAfter.rows.find((candidate) => candidate.id === row).order],
    [rowBefore, warmBefore],
  );
  assert.ok((await store.getWorkoutPlan()).rev > planBefore.rev);
});

// ---- moving exercises ----

rule("reorder: moving an exercise rewrites the order of entries only, and it survives Finish, export and import", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const [b0, b1] = await addRows(logger, BENCH, 2);
  const [q0] = await addRows(logger, SQUAT, 1);
  const [d0] = await addRows(logger, DEAD, 1);
  for (const id of [b0, b1, q0, d0]) await logger.checkSet(id, FIELDS);
  await logger.moveSet(b1, "up", b0);
  await logger.moveExercise(DEAD, "up", SQUAT);
  await logger.moveExercise(DEAD, "up", BENCH);
  assert.deepEqual(exerciseIds(await logger.getSession()), [DEAD, BENCH, SQUAT]);

  const before = await snapshot(adapter);
  await logger.moveExercise(BENCH, "down", SQUAT);
  const after = await snapshot(adapter);
  assert.deepEqual(without(after.entries, "order"), without(before.entries, "order"));
  assert.deepEqual(after.sets, before.sets);
  assert.deepEqual(after.entries.map((entry) => entry.id), before.entries.map((entry) => entry.id));

  await logger.finishWorkout();
  const expectedExercises = [DEAD, SQUAT, BENCH];
  const setSequence = async () => {
    const [workout] = await store.listWorkouts();
    const detail = await store.getWorkoutWithDetails(workout.id);
    return [detail.entries.map((entry) => entry.exerciseId), detail.entries[detail.entries.length - 1].sets.map((set) => set.id)];
  };
  assert.deepEqual(await setSequence(), [expectedExercises, [b1, b0]]);

  const backup = createBackup(adapter);
  const text = await backup.exportToText();
  await backup.importFromText(text, { confirmReplace: true });
  assert.deepEqual(await setSequence(), [expectedExercises, [b1, b0]]);
});

// ---- refusals ----

rule("reorder: a move whose neighbour is not the one the screen showed is refused with nothing stored (sets and exercises)", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const [a, b, c] = await addRows(logger, BENCH, 3);
  await logger.checkSet(a, FIELDS);
  await addRows(logger, SQUAT, 1);
  const before = await snapshot(adapter);
  await assert.rejects(logger.moveSet(b, "up", c), /order changed/);
  await assert.rejects(logger.moveSet(b, "down", a), /order changed/);
  await assert.rejects(logger.moveSet(b, "up", "no-such-id"), /order changed/);
  await assert.rejects(logger.moveExercise(SQUAT, "up", "no-such-exercise"), /order changed/);
  await assert.rejects(logger.moveExercise(BENCH, "down", BENCH), /order changed/);
  await assert.rejects(logger.moveSet(a, "up", b), /cannot move further/);
  await assert.rejects(logger.moveExercise(BENCH, "up", SQUAT), /cannot move further/);
  await assert.rejects(logger.moveSet("no-such-set", "up", a), /not in the current workout/);
  await assert.rejects(logger.moveExercise(DEAD, "up", BENCH), /not in the current workout/);
  await assert.rejects(logger.moveSet(b, "sideways", a), /direction/);
  assert.deepEqual(await snapshot(adapter), before);
});

// A store whose writes first let another tab write (raising the plan's revision), `times` times.
function interrupted(store, interlope, times) {
  let left = times;
  const before = async () => {
    if (left > 0) {
      left -= 1;
      await interlope();
    }
  };
  return {
    ...store,
    setWorkoutMeta: async (...args) => { await before(); return store.setWorkoutMeta(...args); },
    saveWorkoutWithDetails: async (...args) => { await before(); return store.saveWorkoutWithDetails(...args); },
  };
}

rule("reorder: a stale tab's move is refused with nothing stored; after a change in between it re-reads and checks the neighbour again", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make } = await setup(ctx);
  const [a, b, c] = await addRows(logger, BENCH, 3);
  await logger.checkSet(a, FIELDS);
  const bumpOnly = async () => store.setWorkoutMeta({ plan: bumpPlan(normalizePlan(await store.getWorkoutPlan())) });

  // another tab writes before every attempt: the stale revision is refused each time, and nothing changes
  const before = await snapshot(adapter);
  const stuck = make(interrupted(store, bumpOnly, 99));
  await assert.rejects(stuck.moveSet(c, "up", b), /changed in another tab/);
  const after = await snapshot(adapter);
  assert.deepEqual(after.sets, before.sets);
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(without(normalizePlan(after.meta.find((record) => record.key === "workoutPlan").value).rows, "order"), without(normalizePlan(before.meta.find((record) => record.key === "workoutPlan").value).rows, "order"));
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [a, b, c]);

  // one interruption that changes nothing that matters: the retry moves the same pair
  await make(interrupted(store, bumpOnly, 1)).moveSet(c, "up", b);
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [a, c, b]);

  // an interruption that moves the neighbour away: the retry sees a different neighbour and refuses
  const other = make();
  const moveNeighbour = () => other.moveSet(c, "down", b); // [a, b, c] shown again: c and b trade back
  await assert.rejects(make(interrupted(store, moveNeighbour, 1)).moveSet(b, "up", c), /order changed|cannot move further/);
  assert.deepEqual(rowIds(await logger.getSession(), BENCH), [a, b, c]); // only the other tab's move happened
});
