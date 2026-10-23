// Rest-timer and planned-set rule tests (the Log tab's session), shared by Node
// (memory adapter) and the browser page (IndexedDB adapter). No node:test
// import: ctx.assert and ctx.createAdapter are supplied by the runner.
//
// One database per rule: in the browser every createAdapter() opens the same
// test database, so a rule must call setup() only once.

import { createStore } from "../src/storage/store.js";
import { createLogger } from "../src/app/logger.js";
import { createBackup } from "../src/backup/backup.js";
import { createWorkSet } from "../src/domain/model.js";
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
  assert.deepEqual([second.reps, second.weight, second.unit, second.order], ["8", "100", "kg", 1]);
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
  assert.deepEqual([second.reps, second.weight, second.unit], ["8", "100", "kg"]);
  const set = await logger.checkSet(second.id); // nothing typed
  assert.deepEqual([set.reps, set.weightValue, set.weightUnit], [8, 100, "kg"]);
  // prefilled from a planned row that was typed into but never checked
  const third = await logger.addSet(BENCH);
  await logger.updatePlannedSet(third.id, { reps: "6", weight: "90" });
  const fourth = await logger.addSet(BENCH);
  assert.deepEqual([fourth.reps, fourth.weight], ["6", "90"]);
  assert.equal((await logger.checkSet(fourth.id)).weightValue, 90);
  // a different exercise has nothing to prefill from: only a truly blank field is refused
  const blank = await logger.addSet(SQUAT);
  await assert.rejects(logger.checkSet(blank.id), /reps is required/);
  await logger.updatePlannedSet(blank.id, { reps: "5" });
  await assert.rejects(logger.checkSet(blank.id), /weight is required/);
  assert.equal((await store.getSet(second.id)).reps, 8);
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
