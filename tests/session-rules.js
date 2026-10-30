// Rest-timer and planned-set rule tests (the Log tab's session), shared by Node
// (memory adapter) and the browser page (IndexedDB adapter). No node:test
// import: ctx.assert and ctx.createAdapter are supplied by the runner.
//
// One database per rule: in the browser every createAdapter() opens the same
// test database, so a rule must call setup() only once.

import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup } from "../src/backup/backup.js";
import { createWorkSet, createWorkout, createWorkoutEntry } from "../src/domain/model.js";
import { formatWeight } from "../src/domain/format.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { rawCounts, failAfter, makeDetails, EXERCISE } from "./store-rules.js";
import { incomingFile } from "./backup-rules.js";

export const sessionRules = [];
const rule = (name, run) => sessionRules.push({ name, run });

const START = "2026-10-22T10:00:00.000Z";
const T0 = Date.parse(START);
const SECOND = 1000;
const BENCH = "seed-barbell-bench-press";
const SQUAT = "seed-barbell-squat";
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

const allRows = (session) => session.blocks.flatMap((block) => block.rows);
const rowOf = (session, id) => allRows(session).find((row) => row.id === id);
const parse = (text) => JSON.parse(text);

// ---- adding and checking ----

rule("session: Add set makes an unchecked row prefilled from the last one, and stores no set and no workout", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const first = await logger.addSet(BENCH);
  assert.deepEqual([first.reps, first.weight, first.unit, first.order], ["", "", "lb", 0]);
  const session = await logger.getSession();
  assert.equal(session.status.kind, "none");
  assert.deepEqual([session.blocks.length, session.blocks[0].rows[0].phase, session.blocks[0].rows[0].seconds], [1, "template", 180]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  await logger.updatePlannedSet(first.id, { reps: "8", weight: "100", unit: "kg" });
  const second = await logger.addSet(BENCH);
  assert.deepEqual([second.order, rowOf(await logger.getSession(), second.id).ghost], [1, { reps: "8", weight: "100", unit: "kg" }]);
  await assert.rejects(logger.addSet("no-such-exercise"), /no exercise/);
});

rule("session: a row can be checked only with reps and a weight typed; a refused check keeps what was typed", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await assert.rejects(logger.checkSet(row.id), /reps is required/);
  await assert.rejects(logger.checkSet(row.id, { reps: "8", weight: "   " }), /weight is required/);
  const kept = rowOf(await logger.getSession(), row.id);
  assert.deepEqual([kept.kind, kept.reps, kept.weight], ["planned", "8", "   "]); // exactly what was typed
  await assert.rejects(logger.checkSet(row.id, { reps: "0", weight: "100" }), /reps/);
  await assert.rejects(logger.checkSet(row.id, { reps: "8", weight: "-5" }), /weight can't be negative/);
  await assert.rejects(logger.checkSet(row.id, { reps: "1001", weight: "100" }), /maximum of 1000/);
  await assert.rejects(logger.checkSet("no-such-row", FIELDS), /not planned/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  const bodyweight = await logger.checkSet(row.id, { reps: "8", weight: "0", unit: "kg" }); // an explicit 0
  assert.equal(bodyweight.weightValue, 0);
});

rule("session: checking logs the set now with the 3:00 rest, starts the timer and removes the row", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  const set = await logger.checkSet(row.id, FIELDS);
  assert.deepEqual([set.id, set.completedAt, set.restSeconds, set.weightUnit], [row.id, START, 180, "kg"]);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.deepEqual(await store.getRunningTimer(), { setId: set.id, startedAt: T0, endsAt: T0 + 180 * SECOND });
  const session = await logger.getSession();
  const shown = rowOf(session, set.id);
  assert.deepEqual([shown.kind, shown.phase, shown.seconds, session.plannedCount, session.loggedCount], ["logged", "resting", 180, 0, 1]);
});

rule("session: check, uncheck and recheck: unchecking restores the row with its rest, recheck restarts the timer", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, clock, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.setRest(row.id, 90);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 30 * SECOND;
  await logger.uncheckSet(row.id);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 0, sets: 0 });
  assert.equal(await store.getRunningTimer(), null);
  const template = rowOf(await logger.getSession(), row.id);
  assert.deepEqual(
    [template.kind, template.phase, template.seconds, template.fraction, template.reps, template.weight, template.unit],
    ["planned", "template", 90, 1, "8", "100", "kg"],
  );
  clock.time = T0 + 50 * SECOND;
  await logger.checkSet(row.id);
  assert.deepEqual(await store.getRunningTimer(), { setId: row.id, startedAt: T0 + 50 * SECOND, endsAt: T0 + 140 * SECOND });
  assert.equal(rowOf(await logger.getSession(), row.id).seconds, 90);
});

rule("session: only one timer runs: a new check puts the earlier set in done, and unchecking the new one does not revive it", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  const b = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  clock.time = T0 + 30 * SECOND;
  await logger.checkSet(b.id, FIELDS);
  let session = await logger.getSession();
  assert.deepEqual([rowOf(session, a.id).phase, rowOf(session, b.id).phase], ["done", "resting"]);
  assert.equal((await store.getRunningTimer()).setId, b.id);
  await logger.uncheckSet(b.id);
  session = await logger.getSession();
  assert.deepEqual([rowOf(session, a.id).phase, rowOf(session, b.id).phase], ["done", "template"]);
  assert.equal(await store.getRunningTimer(), null);
});

// ---- time ----

rule("session: the time comes from the clock: a jump forward ends the timer, a jump back never shows more than the full rest", async (ctx) => {
  const { assert } = ctx;
  const { clock, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 60 * SECOND;
  assert.deepEqual([rowOf(await logger.getSession(), row.id).phase, rowOf(await logger.getSession(), row.id).seconds], ["resting", 120]);
  clock.time = T0 + 180 * SECOND; // exactly the end
  assert.deepEqual([rowOf(await logger.getSession(), row.id).phase, rowOf(await logger.getSession(), row.id).seconds], ["done", 0]);
  clock.time = T0 + 3600 * SECOND; // jumped an hour ahead
  assert.equal(rowOf(await logger.getSession(), row.id).phase, "done");
  clock.time = T0 - 3600 * SECOND; // jumped an hour back
  const back = rowOf(await logger.getSession(), row.id);
  assert.deepEqual([back.phase, back.seconds, back.fraction], ["resting", 180, 1]);
});

rule("session: a timer that ran out while the app was closed shows as done on return", async (ctx) => {
  const { assert } = ctx;
  const { clock, logger, make } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 10 * 60 * SECOND;
  const returned = make(); // a new logger, as after reopening the app
  const shown = rowOf(await returned.getSession(), row.id);
  assert.deepEqual([shown.kind, shown.phase, shown.seconds], ["logged", "done", 0]);
});

// ---- editing the rest ----

rule("session: editing a resting set recomputes the end from the start time", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 30 * SECOND;
  await logger.setRest(row.id, 60);
  assert.deepEqual(await store.getRunningTimer(), { setId: row.id, startedAt: T0, endsAt: T0 + 60 * SECOND });
  assert.equal(rowOf(await logger.getSession(), row.id).seconds, 30);
  assert.equal((await store.getSet(row.id)).restSeconds, 60);
  await logger.setRest(row.id, 300); // longer again
  assert.equal(rowOf(await logger.getSession(), row.id).seconds, 270);
});

rule("session: a new rest shorter than the elapsed time ends the timer at once", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 90 * SECOND;
  await logger.setRest(row.id, 60);
  assert.equal(await store.getRunningTimer(), null);
  assert.equal(rowOf(await logger.getSession(), row.id).phase, "done");
  assert.equal((await store.getSet(row.id)).restSeconds, 60);
});

rule("session: an unchecked row takes its own rest; a done set keeps the rest it was logged with", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.setRest(row.id, 90);
  assert.equal(rowOf(await logger.getSession(), row.id).seconds, 90);
  await logger.checkSet(row.id, FIELDS);
  assert.equal((await store.getSet(row.id)).restSeconds, 90);
  clock.time = T0 + 200 * SECOND; // over
  await assert.rejects(logger.setRest(row.id, 30), /keeps the rest it was logged with/);
  assert.equal((await store.getSet(row.id)).restSeconds, 90);
  for (const bad of [-1, 1.5, 3601, "60", null]) await assert.rejects(logger.setRest(row.id, bad), /rest/);
});

rule("session: a warm-up set has no timer and neither starts nor stops the running one", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  const work = await logger.addSet(BENCH);
  await logger.checkSet(work.id, FIELDS);
  const timer = await store.getRunningTimer();
  const details = await store.getWorkoutWithDetails((await logger.getStatus()).workout.id);
  const warmup = createWorkSet({
    id: "warm-1", entryId: details.entries[0].id, order: 5, reps: 5, weightValue: 40, weightUnit: "kg",
    isWarmup: true, completedAt: START,
  });
  await store.saveWorkoutWithDetails(details, details.entries.map(({ sets, ...entry }) => entry), [...details.entries[0].sets, warmup]);
  await logger.uncheckSet("warm-1");
  clock.time = T0 + 20 * SECOND;
  await logger.checkSet("warm-1");
  assert.deepEqual(await store.getRunningTimer(), timer); // untouched
  const shown = rowOf(await logger.getSession(), "warm-1");
  assert.deepEqual([shown.kind, shown.isWarmup, shown.hasTimer], ["logged", true, false]);
});

// ---- finishing, discarding and deleting clear the timer ----

rule("session: finishing needs confirmation to drop unchecked sets, then removes them and the timer together", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await assert.rejects(logger.finishWorkout(), /1 unchecked set would be removed; confirm to finish/);
  assert.equal((await logger.getStatus()).kind, "active");
  const finished = await logger.finishWorkout({ removeUnchecked: true });
  assert.ok(finished.endedAt !== null);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.equal(await store.getWorkoutPlan(), null);
  assert.equal(await store.getRunningTimer(), null);
  assert.deepEqual((await logger.getSession()).blocks, []);
});

rule("session: a workout with no checked set cannot be finished", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await assert.rejects(logger.finishWorkout({ removeUnchecked: true }), /no unfinished workout/);
  await logger.checkSet(row.id, FIELDS);
  await logger.uncheckSet(row.id); // the workout exists again, with nothing checked
  await assert.rejects(logger.finishWorkout({ removeUnchecked: true }), /no sets; discard it instead/);
});

rule("session: finishing with nothing unchecked needs no confirmation and still clears the timer", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  assert.ok((await store.getRunningTimer()) !== null);
  await logger.finishWorkout();
  assert.equal(await store.getRunningTimer(), null);
});

rule("session: discarding forgets the planned sets and the timer", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.addSet(SQUAT);
  await logger.checkSet(a.id, FIELDS);
  await logger.discardWorkout();
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  assert.equal(await store.getWorkoutPlan(), null);
  assert.equal(await store.getRunningTimer(), null);
});

rule("session: deleting the set that owns the timer clears it; deleting a planned row only removes the row", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  const b = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await logger.deleteSet(b.id); // planned
  assert.ok((await store.getRunningTimer()) !== null);
  await logger.deleteSet(a.id); // the set that owns the timer
  assert.equal(await store.getRunningTimer(), null);
  assert.deepEqual((await logger.getSession()).blocks, []); // the exercise had nothing left
  await assert.rejects(logger.deleteSet("no-such-set"), /not in the current workout/);
});

rule("session: a timer whose set or exercise disappears by any route stops existing", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await store.deleteSet(a.id); // straight through the store: no timer cleanup of its own
  assert.ok((await store.getRunningTimer()) !== null); // still stored ...
  assert.equal((await logger.getSession()).timer, null); // ... but never reported
  assert.equal(await store.getRunningTimer(), null); // and cleaned up

  const b = await logger.addSet(SQUAT);
  await logger.checkSet(b.id, FIELDS);
  await store.deleteWorkout((await logger.getStatus()).workout.id); // workout, entry and set gone
  assert.equal((await logger.getSession()).timer, null);
  assert.equal(await store.getRunningTimer(), null);
});

// ---- atomicity ----

rule("session: a failed check changes nothing: no set, no timer, the row is still planned", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, clock, logger, make } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.updatePlannedSet(row.id, FIELDS);
  // The check writes the workout, entry, set, plan and timer: five puts. The fifth fails.
  const failing = make(createStore(failAfter(adapter, { puts: 4 })));
  clock.time = T0 + SECOND;
  await assert.rejects(failing.checkSet(row.id));
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  assert.equal(await store.getRunningTimer(), null);
  assert.equal(rowOf(await logger.getSession(), row.id).kind, "planned");
});

// ---- unchecked sets are ignored by every consumer ----

rule("consumers: unchecked sets never reach history counts, the export, the import preview or the reminder", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  const a = await logger.addSet(BENCH);
  const b = await logger.addSet(BENCH);
  const c = await logger.addSet(SQUAT);
  assert.deepEqual(await backup.getReminderInputs(), { lastExportAt: null, dismissedUntil: null, workoutCount: 0 });
  await logger.checkSet(a.id, FIELDS);

  const [summary] = await store.listWorkoutSummaries();
  assert.deepEqual([summary.setCount, summary.entryCount], [1, 1]);
  assert.equal((await backup.currentCounts()).sets, 1);
  assert.equal((await backup.getReminderInputs()).workoutCount, 1);
  const text = await backup.exportToText();
  const doc = parse(text);
  assert.deepEqual([doc.data.sets.length, doc.data.entries.length, doc.data.workouts.length], [1, 1, 1]);
  for (const hidden of [b.id, c.id, "workoutPlan", "runningTimer", "plan"]) assert.equal(text.includes(hidden), false, hidden);

  await logger.finishWorkout({ removeUnchecked: true });
  const [history] = await logger.getHistory();
  assert.equal(history.setCount, 1);
  assert.equal((await logger.getWorkoutDetail(history.id)).entries.flatMap((entry) => entry.sets).length, 1);
});

rule("consumers: with only planned rows there is no workout, no set and nothing to export", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  await logger.addSet(BENCH);
  await logger.addSet(SQUAT);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  assert.equal((await backup.getReminderInputs()).workoutCount, 0);
  const doc = parse(await backup.exportToText());
  assert.deepEqual([doc.data.workouts.length, doc.data.entries.length, doc.data.sets.length], [0, 0, 0]);
});

rule("session: clearPlan forgets rows and timer, and a damaged plan in storage is ignored, not fatal", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await logger.addSet(BENCH);
  await logger.clearPlan();
  assert.equal(await store.getWorkoutPlan(), null);
  assert.equal(await store.getRunningTimer(), null);
  await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: "workoutPlan", value: "garbage" }));
  await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: "runningTimer", value: { setId: 5 } }));
  const session = await logger.getSession();
  assert.equal(session.timer, null);
  assert.equal(session.plannedCount, 0);
});

// ---- atomicity, exact restore and prefilled rows ----

rule("session: unchecking is one transaction: if it fails, the set, the entry and the timer are all still there", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  const timer = await store.getRunningTimer();
  // Uncheck deletes the set and its entry, then writes the plan (a put). The put fails.
  const failing = make(createStore(failAfter(adapter, { puts: 0 })));
  await assert.rejects(failing.uncheckSet(row.id));
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  assert.deepEqual(await store.getRunningTimer(), timer);
  assert.equal(rowOf(await logger.getSession(), row.id).kind, "logged");
});

rule("session: toggling never loses a value: reps, weight, unit and rest come back as the same numbers", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  for (const [reps, weight, unit, expectedWeight] of [[" 8 ", "62,5", "lb", "62.5"], ["12", "0", "kg", "0"], ["1000", "2500", "kg", "2500"], ["5", "62.55", "kg", "62.55"]]) {
    const row = await logger.addSet(SQUAT);
    await logger.setRest(row.id, 75);
    const first = await logger.checkSet(row.id, { reps, weight, unit });
    for (let round = 0; round < 3; round += 1) {
      await logger.uncheckSet(row.id);
      const planned = rowOf(await logger.getSession(), row.id);
      assert.deepEqual(
        [planned.kind, planned.reps, planned.weight, planned.unit, planned.restSeconds],
        ["planned", String(Number(reps)), expectedWeight, unit, 75],
      );
      await logger.checkSet(row.id); // nothing typed: the restored values are accepted
    }
    const last = await store.getSet(row.id);
    assert.deepEqual(
      [last.reps, last.weightValue, last.weightUnit, last.restSeconds],
      [first.reps, first.weightValue, first.weightUnit, 75],
    );
    await logger.deleteSet(row.id);
  }
});

rule("session: a prefilled row can be checked untouched; a blank one cannot", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const first = await logger.addSet(BENCH);
  await logger.checkSet(first.id, FIELDS);
  const second = await logger.addSet(BENCH); // prefilled from the set just logged
  assert.deepEqual(rowOf(await logger.getSession(), second.id).ghost, { reps: "8", weight: "100", unit: "kg" });
  const set = await logger.checkSet(second.id); // nothing typed
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [8, 100, "kg"]);
  // prefilled from a planned row that was typed into but never checked
  const third = await logger.addSet(BENCH);
  await logger.updatePlannedSet(third.id, { reps: "6", weight: "90" });
  const fourth = await logger.addSet(BENCH);
  const fourthGhost = rowOf(await logger.getSession(), fourth.id).ghost;
  assert.deepEqual([fourthGhost.reps, fourthGhost.weight], ["6", "90"]);
  assert.equal((await logger.checkSet(fourth.id)).weightValue, 90);
  // a different exercise has nothing to prefill from: only a truly blank field is refused
  const blank = await logger.addSet(SQUAT);
  await assert.rejects(logger.checkSet(blank.id), /reps is required/);
  await logger.updatePlannedSet(blank.id, { reps: "5" });
  await assert.rejects(logger.checkSet(blank.id), /weight is required/);
  assert.equal((await store.getSet(second.id)).reps, 8);
});

// ---- ghosts: what an unchecked row would be checked with, shown and never stored ----

const DAY = 24 * 60 * 60 * SECOND;
const daysBefore = (days) => new Date(T0 - days * DAY).toISOString();

// A finished workout in the past with sets of one exercise: [reps, weight, unit, isWarmup] each.
async function pastWorkout(store, id, startedAt, exerciseId, sets) {
  const workout = createWorkout({ id, startedAt, endedAt: startedAt });
  const entry = createWorkoutEntry({ id: `${id}-e`, workoutId: id, exerciseId, order: 0 });
  await store.saveWorkoutWithDetails(workout, [entry], sets.map(([reps, weightValue, weightUnit, isWarmup = false], order) => createWorkSet({
    id: `${id}-s${order}`, entryId: entry.id, order, reps, weightValue, weightUnit, isWarmup, completedAt: startedAt,
  })));
}

const rawMeta = (adapter) => adapter.transaction(["meta"], "readonly", (tx) => tx.getAll("meta"));

rule("ghost: Add set writes a blank row; no ghost value reaches meta, the sets store or the export", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  const first = await logger.addSet(BENCH);
  await logger.checkSet(first.id, { reps: "7", weight: "123.5", unit: "kg" });
  const row = await logger.addSet(BENCH);
  assert.deepEqual([row.reps, row.weight], ["", ""]);
  assert.deepEqual(rowOf(await logger.getSession(), row.id).ghost, { reps: "7", weight: "123.5", unit: "kg" });
  const planned = (await store.getWorkoutPlan()).rows.find((candidate) => candidate.id === row.id);
  assert.deepEqual([planned.reps, planned.weight], ["", ""]);
  const meta = JSON.stringify(await rawMeta(adapter));
  assert.equal(meta.includes("123.5"), false); // the checked set's weight lives only in the sets store
  await logger.getSession(); // working the ghost out again writes nothing
  assert.equal(JSON.stringify(await rawMeta(adapter)), meta);
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  const text = await backup.exportToText();
  assert.deepEqual(parse(text).data.sets.map((set) => set.id), [first.id]);
  assert.equal(text.includes(row.id), false);
});

rule("ghost: checking an untouched row stores the ghost exactly, in the ghost's own unit", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const first = await logger.addSet(BENCH);
  await logger.checkSet(first.id, { reps: "5", weight: "62,5", unit: "kg" });
  const row = await logger.addSet(BENCH);
  const shownGhost = rowOf(await logger.getSession(), row.id).ghost;
  // the screen sends blank fields and the app's unit (lb here); the ghost's kg wins for a weight taken from it
  const set = await logger.checkSet(row.id, { reps: "", weight: "", unit: "lb" }, { shownGhost });
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [5, 62.5, "kg"]);
  const stored = await store.getSet(row.id);
  assert.deepEqual([stored.reps, stored.weightValue, stored.weightUnit], [5, 62.5, "kg"]);
});

rule("ghost: a typed field wins over its ghost field by field; a weight-only row above leaves reps blank and the check is refused", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const first = await logger.addSet(BENCH);
  await logger.checkSet(first.id, FIELDS); // 8 x 100 kg
  const typedReps = await logger.addSet(BENCH);
  const a = await logger.checkSet(typedReps.id, { reps: "6", weight: "", unit: "kg" });
  assert.deepEqual([a.reps, a.weightValue, a.weightUnit], [6, 100, "kg"]);
  const typedWeight = await logger.addSet(BENCH);
  const b = await logger.checkSet(typedWeight.id, { reps: "", weight: "90", unit: "lb" });
  assert.deepEqual([b.reps, b.weightValue, b.weightUnit], [6, 90, "lb"]); // typed weight in the app's unit; reps from the row above
  // the row above has a weight and no reps: the ghost has the weight only
  const above = await logger.addSet(SQUAT);
  await logger.updatePlannedSet(above.id, { weight: "140", unit: "kg" });
  const below = await logger.addSet(SQUAT);
  assert.deepEqual(rowOf(await logger.getSession(), below.id).ghost, { reps: "", weight: "140", unit: "kg" });
  const before = await rawCounts(adapter);
  await assert.rejects(logger.checkSet(below.id), /reps is required/);
  assert.equal(await store.getSet(below.id), null);
  assert.deepEqual(await rawCounts(adapter), before);
});

rule("ghost: the first row takes the heaviest non-warm-up set of the last session (ties: more reps, then earlier)", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  await pastWorkout(store, "older", daysBefore(3), BENCH, [[1, 200, "kg"]]); // heavier, but not the last session
  // 160 kg is a warm-up; 220.5 lb (100.02 kg) beats 100 kg; at 220.5 lb, 6 reps beat 3
  await pastWorkout(store, "last", daysBefore(2), BENCH, [[10, 160, "kg", true], [5, 100, "kg"], [3, 220.5, "lb"], [6, 220.5, "lb"]]);
  await pastWorkout(store, "warm-ups-only", daysBefore(1), BENCH, [[10, 60, "kg", true]]); // newer, but nothing to copy
  const row = await logger.addSet(BENCH);
  assert.deepEqual(rowOf(await logger.getSession(), row.id).ghost, { reps: "6", weight: "220.5", unit: "lb" });
  const set = await logger.checkSet(row.id, { reps: "4", weight: "", unit: "kg" });
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [4, 220.5, "lb"]);
  // later rows copy the row above in this workout, not the last session
  const next = await logger.addSet(BENCH);
  assert.deepEqual(rowOf(await logger.getSession(), next.id).ghost, { reps: "4", weight: "220.5", unit: "lb" });
});

rule("ghost: the current workout is not the last session; a session beyond the newest 30 workouts, or no history, gives no ghost", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const first = await logger.addSet(SQUAT);
  const second = await logger.addSet(SQUAT);
  assert.equal(rowOf(await logger.getSession(), first.id).ghost, null); // no history at all
  await pastWorkout(store, "bench-long-ago", daysBefore(40), BENCH, [[5, 100, "kg"]]);
  for (let i = 1; i <= 30; i += 1) await pastWorkout(store, `squat-${i}`, daysBefore(i), SQUAT, [[5, 100 + i, "kg"]]);
  // the current workout gets a heavier squat (the second row), while the first row stays unchecked
  await logger.checkSet(second.id, { reps: "3", weight: "150", unit: "kg" });
  // the first row's last session is squat-1 (101 kg), not the current workout's 150 kg
  assert.deepEqual(rowOf(await logger.getSession(), first.id).ghost, { reps: "5", weight: "101", unit: "kg" });
  // bench was last done 31 workouts ago (beyond the newest 30): no ghost
  const bench = await logger.addSet(BENCH);
  assert.equal(rowOf(await logger.getSession(), bench.id).ghost, null);
});

rule("ghost: shown in the selected unit when the stored ghost is in the other unit; an untouched check stores the original number and unit", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  const first = await logger.addSet(BENCH);
  await logger.checkSet(first.id, FIELDS); // 8 x 100 kg
  await logger.setPreferredUnit("lb");
  const row = await logger.addSet(BENCH);
  const ghost = rowOf(await logger.getSession(), row.id).ghost;
  assert.deepEqual(ghost, { reps: "8", weight: "100", unit: "kg" }); // the ghost keeps its number and unit
  assert.equal(formatWeight(Number(ghost.weight), ghost.unit, "lb"), "220.5"); // what the field shows (set-rows.js uses formatWeight)
  const set = await logger.checkSet(row.id, { reps: "", weight: "", unit: "lb" }, { shownGhost: ghost });
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [8, 100, "kg"]); // never 220.5 lb: no drift
  // a weight typed over the ghost is stored in the selected unit
  const typed = await logger.addSet(BENCH);
  const typedGhost = rowOf(await logger.getSession(), typed.id).ghost;
  const t = await logger.checkSet(typed.id, { reps: "", weight: "225", unit: "lb" }, { shownGhost: typedGhost });
  assert.deepEqual([t.reps, t.weightValue, t.weightUnit], [8, 225, "lb"]);
});

rule("ghost: changing the row above between display and check refuses the check and stores nothing", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger, make } = await setup(ctx);
  const above = await logger.addSet(BENCH);
  await logger.updatePlannedSet(above.id, FIELDS);
  const row = await logger.addSet(BENCH);
  const shownGhost = rowOf(await logger.getSession(), row.id).ghost; // 8 x 100 kg
  const otherTab = make();
  await otherTab.updatePlannedSet(above.id, { weight: "110" });
  await assert.rejects(
    logger.checkSet(row.id, { reps: "", weight: "", unit: "kg" }, { shownGhost }),
    /^Error: The suggestion changed\. Check again\.$/,
  );
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  const redrawn = rowOf(await logger.getSession(), row.id);
  assert.deepEqual([redrawn.kind, redrawn.ghost], ["planned", { reps: "8", weight: "110", unit: "kg" }]);
  // a field the person typed is not compared: a changed weight ghost does not matter once the weight is typed
  await otherTab.updatePlannedSet(above.id, { weight: "120" });
  const set = await logger.checkSet(row.id, { reps: "", weight: "105", unit: "kg" }, { shownGhost: redrawn.ghost });
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [8, 105, "kg"]);
});

// ---- editing a checked set ----

rule("edit: editing a completed set keeps the running timer, completedAt, id, order, rest and checked state", async (ctx) => {
  const { assert } = ctx;
  const { store, logger, clock } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.setRest(row.id, 120);
  const set = await logger.checkSet(row.id, FIELDS);
  const planned = await logger.addSet(BENCH);
  const timerBefore = await store.getRunningTimer();
  const rowsBefore = (await store.getWorkoutPlan()).rows;
  clock.time += 30 * SECOND;
  const edited = await logger.editSet(set.id, { reps: "10", weight: "102.5" });
  assert.deepEqual(edited, { ...set, reps: 10, weightValue: 102.5 });
  assert.deepEqual(await store.getSet(set.id), { ...set, reps: 10, weightValue: 102.5 }); // same id, order, rest, warm-up flag, completedAt
  assert.deepEqual(await store.getRunningTimer(), timerBefore);
  assert.deepEqual((await store.getWorkoutPlan()).rows, rowsBefore); // no row came back: still checked
  const session = await logger.getSession();
  const shown = rowOf(session, set.id);
  assert.deepEqual([shown.kind, shown.phase, shown.seconds], ["logged", "resting", 90]);
  assert.deepEqual(rowOf(session, planned.id).ghost, { reps: "10", weight: "102.5", unit: "kg" }); // the row below copies the edit
  await logger.editSet(set.id, { weight: "100", unit: "lb" }); // the unit it was entered in is kept
  assert.equal((await store.getSet(set.id)).weightUnit, "kg");
  assert.equal((await store.getSet(set.id)).completedAt, set.completedAt);
});

rule("edit: the edit path makes zero deletes and never calls deleteSet", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make } = await setup(ctx);
  const a = await logger.checkSet((await logger.addSet(BENCH)).id, FIELDS);
  await logger.checkSet((await logger.addSet(BENCH)).id, FIELDS);
  const c = await logger.checkSet((await logger.addSet(SQUAT)).id, FIELDS);
  await logger.addSet(SQUAT); // an unchecked row too
  const before = await rawCounts(adapter);
  // any delete inside a transaction fails it, and the store's deleteSet throws
  const noDeletes = createStore(failAfter(adapter, { deletes: 0, clears: 0 }));
  const guarded = make({ ...noDeletes, deleteSet: () => { throw new Error("deleteSet must not be called"); } });
  await guarded.editSet(a.id, { reps: "9" });
  await guarded.editSet(c.id, { weight: "150" });
  assert.deepEqual(await rawCounts(adapter), before);
  assert.deepEqual([(await store.getSet(a.id)).reps, (await store.getSet(c.id)).weightValue], [9, 150]);
  // the guard is real: unchecking does go through deleteSet
  await assert.rejects(guarded.uncheckSet(a.id), /deleteSet must not be called/);
});

rule("edit: blank, zero, negative or non-whole reps and a bad weight are refused, and the set is unchanged", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const set = await logger.checkSet((await logger.addSet(BENCH)).id, FIELDS);
  const planBefore = await store.getWorkoutPlan();
  for (const [fields, message] of [
    [{ reps: "" }, /reps is required/],
    [{ reps: "   " }, /reps is required/],
    [{ reps: "0" }, /reps must be at least 1/],
    [{ reps: "-3" }, /reps can't be negative/],
    [{ reps: "7.5" }, /reps must be a whole number/],
    [{ reps: "1001" }, /maximum of 1000/],
    [{ weight: "" }, /weight is required/], // exactly as checkSet treats a blank weight
    [{ weight: "-5" }, /weight can't be negative/],
    [{ weight: "abc" }, /weight must be a number/],
    [{ weight: "2600" }, /weight is above the maximum/],
    [{ reps: "9", weight: "" }, /weight is required/], // one bad field refuses the whole edit
  ]) {
    await assert.rejects(logger.editSet(set.id, fields), message);
    assert.deepEqual(await store.getSet(set.id), set);
  }
  assert.deepEqual(await store.getWorkoutPlan(), planBefore);
});

rule("upgrade: planned rows from the old version that already hold pre-filled values still load, show as typed, check as before, and ghost the row below", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  // what the previous version stored: Add set copied the last row's text into the new row
  const oldRow = { id: "old-row", exerciseId: BENCH, order: 0, reps: "8", weight: "100", unit: "kg", restSeconds: null, isWarmup: false };
  await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: "workoutPlan", value: { exercises: [BENCH], rows: [oldRow], rev: 3 } }));
  const shown = rowOf(await logger.getSession(), "old-row");
  assert.deepEqual([shown.kind, shown.reps, shown.weight, shown.unit, shown.ghost], ["planned", "8", "100", "kg", null]);
  const below = await logger.addSet(BENCH);
  assert.deepEqual(rowOf(await logger.getSession(), below.id).ghost, { reps: "8", weight: "100", unit: "kg" });
  const set = await logger.checkSet("old-row"); // untouched, as before
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [8, 100, "kg"]);
  const next = await logger.checkSet(below.id);
  assert.deepEqual([next.reps, next.weightValue, next.weightUnit], [8, 100, "kg"]);
});

rule("edit: a planned row, an unknown id, a stale workout, a finished workout and a stale-tab write are refused or redone, never overwriting", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, clock, make } = await setup(ctx);
  const set = await logger.checkSet((await logger.addSet(BENCH)).id, FIELDS);
  const planned = await logger.addSet(BENCH);
  await assert.rejects(logger.editSet(planned.id, { reps: "5" }), /not in the current workout/);
  await assert.rejects(logger.editSet("no-such-set", { reps: "5" }), /not in the current workout/);
  // another tab checks a row between this tab's read and its write: the edit is redone on fresh data
  const otherTab = make();
  let fired = false;
  const interleaved = {
    ...store,
    getRunningTimer: async () => {
      if (!fired) {
        fired = true;
        await otherTab.checkSet(planned.id, { reps: "3", weight: "80", unit: "kg" });
      }
      return store.getRunningTimer();
    },
  };
  await make(interleaved).editSet(set.id, { reps: "12" });
  assert.equal(fired, true);
  assert.deepEqual([(await store.getSet(set.id)).reps, (await store.getSet(planned.id)).weightValue], [12, 80]); // both kept
  assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  // a stale workout must be resolved first
  clock.time += 13 * 60 * 60 * SECOND;
  await assert.rejects(logger.editSet(set.id, { reps: "6" }), /Finish, continue or discard/);
  assert.equal((await store.getSet(set.id)).reps, 12);
  // a finished workout is not the current one
  await logger.finishWorkout();
  await assert.rejects(logger.editSet(set.id, { reps: "6" }), /not in the current workout/);
  assert.equal((await store.getSet(set.id)).reps, 12);
});

// ---- import and the session ----

rule("import: the planned sets and the running timer go with the data they pointed at, in the same transaction", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await logger.addSet(SQUAT); // planned, and SQUAT is not in the file
  assert.ok((await store.getWorkoutPlan()) !== null && (await store.getRunningTimer()) !== null);
  await backup.importFromText(incomingFile(), { confirmReplace: true });
  assert.equal(await store.getWorkoutPlan(), null);
  assert.equal(await store.getRunningTimer(), null);
  const session = await logger.getSession(); // no errors, nothing left over
  assert.deepEqual([session.plannedCount, session.timer], [0, null]);
  assert.deepEqual(session.blocks.map((block) => block.exerciseId), ["ex-row"]);
});

rule("import: a refused file leaves the planned sets and the running timer alone", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await logger.addSet(BENCH);
  const before = [await store.getWorkoutPlan(), await store.getRunningTimer()];
  await assert.rejects(backup.importFromText("not json", { confirmReplace: true }), /not valid JSON/);
  assert.deepEqual([await store.getWorkoutPlan(), await store.getRunningTimer()], before);
});

rule("session: planned rows whose exercise no longer exists are dropped without errors", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  const ghost = { id: "g1", exerciseId: "ghost", order: 0, reps: "5", weight: "50", unit: "kg", restSeconds: null, isWarmup: false };
  await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", {
    key: "workoutPlan", value: { exercises: ["ghost"], rows: [ghost], rev: 3 },
  }));
  const session = await logger.getSession(); // does not throw
  assert.deepEqual([session.blocks.length, session.plannedCount], [0, 0]);
  const cleaned = await store.getWorkoutPlan(); // and the plan in storage is tidied
  assert.deepEqual([cleaned.rows.length, cleaned.exercises.length, cleaned.rev], [0, 0, 4]);
  await assert.rejects(logger.checkSet("g1", FIELDS), /not planned/);
  const row = await logger.addSet(BENCH); // the session works as normal afterwards
  assert.equal(rowOf(await logger.getSession(), row.id).kind, "planned");
});

// ---- two tabs ----

rule("session: the store refuses a write made from a stale revision, before changing anything", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  await logger.addSet(BENCH); // revision 1
  const stale = { exercises: [], rows: [], rev: 1 };
  await assert.rejects(store.setWorkoutMeta({ plan: stale }, { expectRev: 0 }), /changed in another tab/);
  const kept = await store.getWorkoutPlan();
  assert.deepEqual([kept.rev, kept.rows.length], [1, 1]);
  await store.setWorkoutMeta({ plan: { ...kept, rev: 2 } }, { expectRev: 1 }); // the current revision is accepted
  assert.equal((await store.getWorkoutPlan()).rev, 2);
});

rule("session: two tabs adding at once: the stale write is refused and redone on fresh data, so both rows survive", async (ctx) => {
  const { assert } = ctx;
  const { store, logger, make } = await setup(ctx);
  const otherTab = make();
  let fired = false;
  // Tab A reads the plan, then (between its read and its write) the other tab adds a row.
  const interleaved = {
    ...store,
    getRunningTimer: async () => {
      if (!fired) {
        fired = true;
        await otherTab.addSet(SQUAT);
      }
      return store.getRunningTimer();
    },
  };
  const row = await make(interleaved).addSet(BENCH);
  assert.equal(fired, true);
  const session = await logger.getSession();
  assert.deepEqual(allRows(session).map((r) => r.exerciseId).sort(), [BENCH, SQUAT].sort());
  assert.equal(rowOf(session, row.id).exerciseId, BENCH);
  assert.equal((await store.getWorkoutPlan()).rev, 2); // two writes, none lost
});

rule("session: a tab checking a row the other tab just deleted gets an error, and nothing is logged", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.updatePlannedSet(row.id, FIELDS);
  const otherTab = make();
  let fired = false;
  const interleaved = {
    ...store,
    getRunningTimer: async () => {
      if (!fired) {
        fired = true;
        await otherTab.deleteSet(row.id);
      }
      return store.getRunningTimer();
    },
  };
  await assert.rejects(make(interleaved).checkSet(row.id), /not planned/);
  assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  assert.equal(await store.getRunningTimer(), null);
});

rule("session: a timer written by the other tab is not wiped by this tab's tidy-up from a stale read", async (ctx) => {
  const { assert } = ctx;
  const { store, logger, make } = await setup(ctx);
  // A leftover timer for a set that does not exist: reading the session tidies it up ...
  await store.setWorkoutMeta({ timer: { setId: "gone", startedAt: T0, endsAt: T0 + 180 * SECOND } });
  const otherTab = make();
  const row = await otherTab.addSet(BENCH);
  let fired = false;
  // ... but the other tab checks a real set after this tab read the leftover timer
  // and before this tab writes its tidy-up.
  const interleaved = {
    ...store,
    getRunningTimer: async () => {
      const leftover = await store.getRunningTimer();
      if (!fired) {
        fired = true;
        await otherTab.checkSet(row.id, FIELDS);
      }
      return leftover;
    },
  };
  await make(interleaved).getSession();
  assert.equal(fired, true);
  assert.equal((await store.getRunningTimer()).setId, row.id); // the real timer survived
});

// ---- a lost plan ----

rule("session: if the plan is lost the logged sets stay, and if everything is lost there is no phantom workout", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS);
  await logger.addSet(BENCH); // planned: not in any backup
  // What a restore from a backup leaves: the logged sets, without the plan or the timer.
  await logger.clearPlan();
  let session = await logger.getSession();
  assert.deepEqual([session.status.kind, session.loggedCount, session.plannedCount, session.timer], ["active", 1, 0, null]);
  assert.deepEqual(allRows(session).map((row) => row.kind), ["logged"]);
  // Site data cleared: every store is empty.
  await adapter.transaction(["exercises", "workouts", "entries", "sets", "meta"], "readwrite", async (tx) => {
    for (const name of ["exercises", "workouts", "entries", "sets", "meta"]) await tx.clear(name);
  });
  session = await logger.getSession();
  assert.deepEqual([session.status.kind, session.workout, session.blocks.length, session.loggedCount, session.plannedCount], ["none", null, 0, 0, 0]);
});

// ---- per-exercise default rest (schema version 2) ----

rule("rest defaults: Update Rest Timers sets the exercise default and changes only that exercise's UNCHECKED sets", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  await logger.checkSet(a.id, FIELDS); // logged with 3:00, and its timer is running
  const timer = await store.getRunningTimer();
  const b = await logger.addSet(BENCH);
  await logger.setRest(b.id, 60); // unchecked, with a rest of its own
  const c = await logger.addSet(BENCH); // unchecked, follows the default
  const d = await logger.addSet(SQUAT); // another exercise

  assert.deepEqual(await logger.updateRestTimers(BENCH, 120), { defaultRestSeconds: 120, updatedSets: 2 });
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, 120);
  assert.equal((await store.getExercise(SQUAT)).defaultRestSeconds, null);
  const session = await logger.getSession();
  assert.deepEqual([b.id, c.id, d.id].map((id) => rowOf(session, id).seconds), [120, 120, 180]);
  assert.equal((await store.getSet(a.id)).restSeconds, 180); // the completed set keeps the rest it was logged with
  assert.deepEqual(await store.getRunningTimer(), timer); // the running timer is not touched
  assert.equal(rowOf(session, a.id).phase, "resting");

  const set = await logger.checkSet(c.id, FIELDS); // from now on sets are logged with the new rest
  assert.equal(set.restSeconds, 120);
  const e = await logger.addSet(BENCH); // a new row follows the default instead of copying it
  assert.deepEqual([e.restSeconds, rowOf(await logger.getSession(), e.id).seconds], [null, 120]);
  await logger.updateRestTimers(BENCH, 45); // a later change leaves both completed sets alone
  assert.deepEqual([(await store.getSet(a.id)).restSeconds, (await store.getSet(c.id)).restSeconds], [180, 120]);
});

rule("rest defaults: bad values, an unknown exercise and a stale workout are refused", async (ctx) => {
  const { assert } = ctx;
  const { store, clock, logger } = await setup(ctx);
  for (const bad of [-1, 1.5, 3601, "60", null, undefined]) await assert.rejects(logger.updateRestTimers(BENCH, bad), /rest/);
  await assert.rejects(logger.updateRestTimers("no-such-exercise", 60), /no exercise/);
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, null);
  const row = await logger.addSet(BENCH);
  await logger.checkSet(row.id, FIELDS);
  clock.time = T0 + 13 * 60 * 60 * SECOND; // the unfinished workout is now stale
  await assert.rejects(logger.updateRestTimers(BENCH, 60), /Finish, continue or discard/);
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, null);
});

rule("rest defaults: a failed Update Rest Timers changes nothing, neither the exercise nor the rows", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger, make } = await setup(ctx);
  const row = await logger.addSet(BENCH);
  await logger.setRest(row.id, 75);
  // The exercise is written first, then the plan: the second put fails.
  const failing = make(createStore(failAfter(adapter, { puts: 1 })));
  await assert.rejects(failing.updateRestTimers(BENCH, 120));
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, null);
  assert.equal(rowOf(await logger.getSession(), row.id).seconds, 75);
});

rule("rest defaults: a stored set with no rest shows the exercise default, then 3:00, and is not rewritten", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  // A set as saved before rests were stored: restSeconds null (makeDetails makes such sets).
  const legacy = makeDetails("legacy", 1, 2);
  await store.saveExercise(EXERCISE);
  await store.saveWorkoutWithDetails(legacy.workout, legacy.entries, legacy.sets);
  const [first, second] = legacy.sets;
  assert.equal(rowOf(await logger.getSession(), first.id).restSeconds, 180); // no default yet: 3:00
  await logger.updateRestTimers(EXERCISE.id, 100);
  assert.equal(rowOf(await logger.getSession(), first.id).restSeconds, 100); // the exercise default
  assert.deepEqual([(await store.getSet(first.id)).restSeconds, (await store.getSet(second.id)).restSeconds], [null, null]);
  // Unchecking one gives a row that still follows the default; checking it logs the resolved rest.
  const row = await logger.uncheckSet(first.id);
  assert.equal(row.restSeconds, null);
  assert.equal(rowOf(await logger.getSession(), first.id).seconds, 100);
  assert.equal((await logger.checkSet(first.id)).restSeconds, 100);
  assert.equal((await store.getSet(second.id)).restSeconds, null); // the other old set was never touched
});

rule("rest defaults: seeding adds missing exercises with the default null and can never overwrite a default", async (ctx) => {
  const { assert } = ctx;
  const { adapter, store, logger } = await setup(ctx);
  await logger.updateRestTimers(BENCH, 120);
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", SQUAT)); // so a new seed has something to add
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, SEED_VERSION + 1), { added: 1, skipped: false });
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, 120);
  assert.equal((await store.getExercise(SQUAT)).defaultRestSeconds, null);
  assert.deepEqual(await store.seedExercises(SEED_EXERCISES, SEED_VERSION + 1), { added: 0, skipped: true });
  assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, 120);
});

// ---- warm-up sets ----

rule("warm-up: the number button flips only the flag; numbering skips warm-ups; a timer already running is untouched", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  const rows = [await logger.addSet(BENCH), await logger.addSet(BENCH), await logger.addSet(BENCH)];
  await assert.rejects(logger.setWarmup(rows[0].id, "yes"), /true or false/);
  await assert.rejects(logger.setWarmup("no-such-set", true), /not in the current workout/);
  await logger.setWarmup(rows[0].id, true); // a planned row
  const numbers = async () => allRows(await logger.getSession()).map((row) => row.number);
  assert.deepEqual(await numbers(), [null, 1, 2]);
  await logger.checkSet(rows[0].id, FIELDS); // checking a warm-up starts no timer
  assert.equal(await store.getRunningTimer(), null);
  await logger.checkSet(rows[1].id, FIELDS);
  const timer = await store.getRunningTimer();
  assert.equal(timer.setId, rows[1].id);

  // a checked working set becomes a warm-up while its timer runs: the flag changes, nothing else does
  const before = await store.getSet(rows[1].id);
  await logger.setWarmup(rows[1].id, true);
  assert.deepEqual(await store.getSet(rows[1].id), { ...before, isWarmup: true });
  assert.deepEqual(await store.getRunningTimer(), timer);
  const session = await logger.getSession();
  assert.deepEqual(session.timer, timer);
  assert.deepEqual([rowOf(session, rows[1].id).number, rowOf(session, rows[1].id).hasTimer, rowOf(session, rows[1].id).phase], [null, true, "resting"]);
  assert.deepEqual(await numbers(), [null, null, 1]);
  await logger.setWarmup(rows[1].id, false);
  assert.deepEqual(await store.getSet(rows[1].id), before);
  assert.deepEqual(await numbers(), [null, 1, 2]);
  assert.deepEqual(await store.getRunningTimer(), timer);
});

rule("warm-up: set counts leave warm-ups out (Log tab, History list and detail), the delete question counts every set", async (ctx) => {
  const { assert } = ctx;
  const { logger } = await setup(ctx);
  const a = await logger.addSet(BENCH);
  const b = await logger.addSet(BENCH);
  await logger.setWarmup(a.id, true);
  await logger.checkSet(a.id, FIELDS);
  await logger.checkSet(b.id, FIELDS);
  const session = await logger.getSession();
  assert.deepEqual([session.loggedCount, session.workingCount], [2, 1]);
  assert.deepEqual([session.workout.setCount, session.workout.loggedSetCount], [1, 2]);
  await logger.finishWorkout();
  const [summary] = await logger.getHistory();
  assert.deepEqual([summary.setCount, summary.loggedSetCount], [1, 2]);
  const detail = await logger.getWorkoutDetail(summary.id);
  assert.deepEqual([detail.setCount, detail.loggedSetCount], [1, 2]);
});

rule("warm-up: a warm-up is left out of records, PR history, the ignored count and the body totals; a set with no flag is a working set", async (ctx) => {
  const { assert } = ctx;
  const { store, logger } = await setup(ctx);
  await store.setPreferredUnit("kg");
  await pastWorkout(store, "w1", daysBefore(1), BENCH, [[5, 100, "kg"], [5, 90, "kg"], [1, 300, "kg", true], [30, 0, "kg", true]]);
  const { records, history, ignored } = await logger.getRecords();
  assert.equal(records[BENCH].weight.value, 100);
  assert.equal(records[BENCH].reps, undefined); // the 30-rep bodyweight warm-up does not hold the most-reps record
  assert.ok(history.every((entry) => entry.setId !== "w1-s2" && entry.setId !== "w1-s3"));
  assert.equal(ignored, 0);
  const withWarmups = (await logger.getMuscleStatus()).values;
  await pastWorkout(store, "w2", daysBefore(1), SQUAT, [[5, 100, "kg"]]);
  assert.equal((await logger.getMuscleStatus()).values.chest, withWarmups.chest); // other exercise: chest unchanged
  assert.equal(withWarmups.chest, 2); // two working sets, not four
  // old data: a stored set record with no isWarmup counts as a working set where it is read
  const legacy = await store.getSet("w1-s0");
  delete legacy.isWarmup;
  const { records: legacyRecords } = (await import("../src/domain/strength.js")).personalRecords(
    [{ ...legacy, workoutId: "w1", exerciseId: BENCH }], "kg",
  );
  assert.equal(legacyRecords[BENCH].weight.value, 100);
});

rule("warm-up: the flag is exported and comes back on import", async (ctx) => {
  const { assert } = ctx;
  const { adapter, logger } = await setup(ctx);
  const backup = createBackup(adapter);
  const row = await logger.addSet(BENCH);
  await logger.setWarmup(row.id, true);
  await logger.checkSet(row.id, FIELDS);
  const text = await backup.exportToText();
  assert.deepEqual(parse(text).data.sets.map((set) => set.isWarmup), [true]);
  await backup.importFromText(text, { confirmReplace: true });
  assert.equal((await adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets")))[0].isWarmup, true);
  // import is strict by design: a set record without the flag is refused, not guessed
  const stripped = parse(text);
  delete stripped.data.sets[0].isWarmup;
  await assert.rejects(backup.importFromText(JSON.stringify(stripped), { confirmReplace: true }), /isWarmup/);
});
