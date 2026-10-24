// Workout logging rules, between the UI and the store. No DOM.
// Everything that decides, validates or calculates for the logging screens
// lives here or in the domain and storage modules, never in src/ui.

import { createWorkout, createWorkoutEntry, createWorkSet, createExercise } from "../domain/model.js";
import { parseDecimal, parseWholeNumber } from "../domain/format.js";
import { searchExercises } from "../domain/search.js";
import {
  DEFAULT_REST_SECONDS, startTimer, rescheduleTimer, isRunning, requireRest,
} from "../domain/rest-timer.js";
import {
  normalizePlan, addRow, updateRow, removeRow, bumpPlan, pruneOrphans, nextOrder as nextRowOrder, buildExerciseBlocks,
} from "../domain/workout-plan.js";
import { SESSION_CONFLICT } from "../storage/schema.js";

export const DEFAULT_STALE_AFTER_HOURS = 12;
const UNKNOWN_EXERCISE = "Unknown exercise";
const HOUR_MS = 60 * 60 * 1000;

const nextOrder = (records) => (records.length === 0 ? 0 : Math.max(...records.map((record) => record.order)) + 1);

function splitDetails(details) {
  const { entries: withSets, ...workout } = details;
  const entries = withSets.map(({ sets, ...entry }) => entry);
  const sets = withSets.flatMap((entry) => entry.sets);
  return { workout, entries, sets };
}

// `now` is a function returning a Date, so tests can control the clock.
// An unfinished workout that started more than `staleAfterHours` ago is
// "stale": it is never continued silently.
export function createLogger(store, { now = () => new Date(), staleAfterHours = DEFAULT_STALE_AFTER_HOURS } = {}) {
  if (typeof staleAfterHours !== "number" || !(staleAfterHours > 0) || !Number.isFinite(staleAfterHours)) {
    throw new Error("staleAfterHours must be a positive number");
  }
  const nowDate = () => new Date(now());
  const nowIso = () => nowDate().toISOString();

  // { kind: "none" } | { kind: "active", workout } | { kind: "stale", workout }.
  // The workout is the newest one with no endedAt. It is stale when it started
  // more than staleAfterHours ago, unless the user already chose Continue.
  async function getStatus() {
    const workout = (await store.listWorkouts()).find((candidate) => candidate.endedAt === null);
    if (workout === undefined) return { kind: "none" };
    const continued = (await store.getContinuedWorkoutId()) === workout.id;
    const ageMs = nowDate().getTime() - Date.parse(workout.startedAt);
    const stale = !continued && ageMs > staleAfterHours * HOUR_MS;
    return { kind: stale ? "stale" : "active", workout };
  }

  async function detailWithNames(workoutId) {
    const details = await store.getWorkoutWithDetails(workoutId);
    if (details === null) return null;
    const names = new Map((await store.listExercises()).map((exercise) => [exercise.id, exercise.name]));
    return {
      ...details,
      setCount: details.entries.reduce((total, entry) => total + entry.sets.length, 0),
      entries: details.entries.map((entry) => ({ ...entry, exerciseName: names.get(entry.exerciseId) ?? UNKNOWN_EXERCISE })),
    };
  }

  // The status plus the workout's entries and sets (with exercise names).
  async function getCurrent() {
    const status = await getStatus();
    if (status.kind === "none") return { status };
    return { status, workout: await detailWithNames(status.workout.id) };
  }

  const nowMs = () => nowDate().getTime();
  const formatPlanned = (count) => `${count} unchecked ${count === 1 ? "set" : "sets"}`;

  // Two tabs can run these operations at the same moment. Every operation reads
  // the session, works out the change, and writes it with the plan revision it
  // read: the store refuses the write (code SESSION_CONFLICT) if another tab wrote
  // in between, before anything is changed. The operation then simply reads again
  // and redoes its work on the newer data, so a stale copy never overwrites.
  const MAX_CONFLICT_RETRIES = 5;
  async function retryOnConflict(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error.code !== SESSION_CONFLICT || attempt >= MAX_CONFLICT_RETRIES) throw error;
      }
    }
  }

  // The options of a session write: the next plan (or null to remove it), the
  // timer change, and the revision the work was based on.
  const commit = (session, plan, timer) => ({
    meta: { plan: plan === null ? null : bumpPlan(plan), timer },
    expectRev: session.plan.rev,
  });

  // The running timer, only if the set it belongs to is still in the workout.
  // A timer whose set was deleted, by any route, simply stops existing.
  function validTimer(value, sets) {
    if (value === null || typeof value !== "object") return null;
    const { setId, startedAt, endsAt } = value;
    if (typeof setId !== "string" || !Number.isFinite(startedAt) || !Number.isFinite(endsAt) || endsAt < startedAt) return null;
    const set = sets.find((candidate) => candidate.id === setId);
    return set === undefined || set.isWarmup ? null : { setId, startedAt, endsAt };
  }

  // Everything the session functions need, read once. Planned rows whose exercise
  // no longer exists (after an import, say) are dropped here, never reported.
  async function readSession() {
    const status = await getStatus();
    const details = status.kind === "none"
      ? { workout: null, entries: [], sets: [] }
      : splitDetails(await store.getWorkoutWithDetails(status.workout.id));
    const exercises = await store.listExercises();
    const stored = normalizePlan(await store.getWorkoutPlan());
    const plan = pruneOrphans(stored, new Set(exercises.map((exercise) => exercise.id)), details.entries.map((entry) => entry.exerciseId));
    const storedTimer = await store.getRunningTimer();
    const timer = validTimer(storedTimer, details.sets);
    return {
      status, ...details, exercises, plan, timer,
      planWasPruned: plan !== stored,
      timerWasInvalid: storedTimer !== null && timer === null,
    };
  }

  function requireNotStale(status) {
    if (status.kind === "stale") throw new Error("Finish, continue or discard the unfinished workout first");
  }

  // What the Log tab shows: the exercises of the session with their rows (logged
  // sets and planned rows) and the running timer. The time is read from the
  // clock here and again on every tick; nothing is counted down.
  async function getSession() {
    const session = await readSession();
    if (session.timerWasInvalid || session.planWasPruned) {
      // Tidy up what was dropped. A conflict just means another tab did it first.
      await store.setWorkoutMeta(
        { plan: bumpPlan(session.plan), timer: session.timerWasInvalid ? null : undefined },
        { expectRev: session.plan.rev },
      ).catch(() => {});
    }
    const names = new Map(session.exercises.map((exercise) => [exercise.id, exercise.name]));
    const at = nowMs();
    return {
      status: session.status,
      workout: session.status.kind === "none" ? null : await detailWithNames(session.status.workout.id),
      blocks: buildExerciseBlocks({
        entries: session.entries, sets: session.sets, plan: session.plan, names, timer: session.timer, nowMs: at,
        defaults: new Map(session.exercises.map((exercise) => [exercise.id, exercise.defaultRestSeconds])),
      }),
      timer: session.timer,
      nowMs: at,
      plannedCount: session.plan.rows.length,
      loggedCount: session.sets.length,
    };
  }

  // Adds an unchecked row for an exercise (adding the exercise to the session if
  // needed), prefilled from the last row of that exercise. Nothing is stored in
  // the sets store, and no workout is started: that happens when a row is checked.
  async function addSet(exerciseId) {
    if (typeof exerciseId !== "string" || exerciseId === "") throw new Error("exerciseId must be a non-empty string");
    return retryOnConflict(async () => {
      const session = await readSession();
      if (!session.exercises.some((exercise) => exercise.id === exerciseId)) {
        throw new Error(`exerciseId: no exercise with id "${exerciseId}"`);
      }
      requireNotStale(session.status);
      const entry = session.entries.find((candidate) => candidate.exerciseId === exerciseId);
      const logged = entry === undefined ? [] : session.sets.filter((set) => set.entryId === entry.id);
      const last = [
        ...logged.map((set) => ({ order: set.order, reps: String(set.reps), weight: String(set.weightValue), unit: set.weightUnit })),
        ...session.plan.rows
          .filter((row) => row.exerciseId === exerciseId)
          .map((row) => ({ order: row.order, reps: row.reps, weight: row.weight, unit: row.unit })),
      ].sort((a, b) => b.order - a.order)[0];
      const row = {
        id: crypto.randomUUID(),
        exerciseId,
        order: nextRowOrder(session.plan, exerciseId, logged),
        reps: last === undefined ? "" : last.reps,
        weight: last === undefined ? "" : last.weight,
        unit: last === undefined ? await store.getPreferredUnit() : last.unit,
        restSeconds: null, // null = the default rest; a value is this set's own
        isWarmup: false,
      };
      const { meta, expectRev } = commit(session, addRow(session.plan, row));
      await store.setWorkoutMeta(meta, { expectRev });
      return row;
    });
  }

  // Saves what was typed into an unchecked row. Not validated here: blank is
  // allowed until the row is checked.
  async function updatePlannedSet(rowId, fields) {
    return retryOnConflict(async () => {
      const session = await readSession();
      const plan = updateRow(session.plan, rowId, {
        ...("reps" in fields ? { reps: fields.reps } : {}),
        ...("weight" in fields ? { weight: fields.weight } : {}),
        ...("unit" in fields ? { unit: fields.unit } : {}),
      });
      const { meta, expectRev } = commit(session, plan);
      await store.setWorkoutMeta(meta, { expectRev });
      return plan.rows.find((row) => row.id === rowId);
    });
  }

  // Checks a planned row: it becomes a real set, logged now, and its rest timer
  // starts (a warm-up set neither starts nor stops a timer). The rule for when a
  // row can be checked: reps must be a whole number from 1 to MAX_REPS and weight
  // a number from 0 to MAX_WEIGHT_KG, both present in the row (typed, or filled in
  // from the previous set by Add set: an untouched prefilled row can be checked;
  // blank is refused and bodyweight is an explicit 0), in kg or lb. Anything else
  // leaves the row unchecked. The set, the removal of the row and the timer are
  // written in ONE transaction.
  async function checkSet(rowId, fields = {}) {
    if (Object.keys(fields).length > 0) {
      await updatePlannedSet(rowId, fields); // keep what was typed even if the check is refused
    }
    return retryOnConflict(async () => {
      const session = await readSession();
      requireNotStale(session.status);
      const row = session.plan.rows.find((candidate) => candidate.id === rowId);
      if (row === undefined) throw new Error("That set is not planned (it may already be checked)");

      const repsValue = parseWholeNumber(row.reps, "reps");
      const weightValue = parseDecimal(row.weight, "weight");
      const at = nowMs();
      const timestamp = new Date(at).toISOString();

      let { workout, entries } = session;
      if (workout === null) workout = createWorkout({ now: timestamp });
      let entry = entries.find((candidate) => candidate.exerciseId === row.exerciseId);
      if (entry === undefined) {
        entry = createWorkoutEntry({ workoutId: workout.id, exerciseId: row.exerciseId, order: nextOrder(entries) });
        entries = [...entries, entry];
      }
      // The rest: this set's own, else the exercise's default, else 3:00. It is written
      // into the set, which keeps the rest it was logged with whatever happens to the default.
      const exercise = session.exercises.find((candidate) => candidate.id === row.exerciseId);
      const restSeconds = row.restSeconds ?? exercise.defaultRestSeconds ?? DEFAULT_REST_SECONDS;
      const set = createWorkSet({
        id: row.id,
        entryId: entry.id,
        order: row.order,
        reps: repsValue,
        weightValue,
        weightUnit: row.unit,
        isWarmup: row.isWarmup,
        restSeconds,
        completedAt: timestamp,
      });
      const logged = entries.map((candidate) => candidate.exerciseId);
      const timer = row.isWarmup ? undefined : startTimer({ setId: set.id, nowMs: at, restSeconds });
      await store.saveWorkoutWithDetails(workout, entries, [...session.sets, set], commit(session, removeRow(session.plan, row.id, logged), timer));
      return set;
    });
  }

  // Unchecks a logged set of the current workout: the set is deleted and the row
  // is planned again with the same values and rest (reps and weight come back as
  // the same numbers; the text is written in the plain form, so "62,5" returns
  // as 62.5). If it owned the running timer the timer stops, and no other set
  // takes it over. One transaction.
  async function uncheckSet(setId) {
    return retryOnConflict(async () => {
      const session = await readSession();
      const set = session.sets.find((candidate) => candidate.id === setId);
      if (session.status.kind === "none" || set === undefined) throw new Error("That set is not in the current workout");
      requireNotStale(session.status);
      const entry = session.entries.find((candidate) => candidate.id === set.entryId);
      const plan = addRow(session.plan, {
        id: set.id,
        exerciseId: entry.exerciseId,
        order: set.order,
        reps: String(set.reps),
        weight: String(set.weightValue),
        unit: set.weightUnit,
        restSeconds: set.restSeconds,
        isWarmup: set.isWarmup,
      });
      await store.deleteSet(setId, commit(session, plan, session.timer !== null && session.timer.setId === setId ? null : undefined));
      return plan.rows.find((row) => row.id === setId);
    });
  }

  // Sets the rest of ONE set. An unchecked row just takes it. A set that is
  // resting has its end recomputed from its start time, and ends at once if the
  // new rest is not longer than the time already elapsed. A done set keeps the
  // rest it was logged with.
  async function setRest(setId, seconds) {
    const rest = requireRest(seconds);
    return retryOnConflict(async () => {
      const session = await readSession();
      if (session.plan.rows.some((row) => row.id === setId)) {
        const { meta, expectRev } = commit(session, updateRow(session.plan, setId, { restSeconds: rest }));
        await store.setWorkoutMeta(meta, { expectRev });
        return rest;
      }
      const set = session.sets.find((candidate) => candidate.id === setId);
      if (session.status.kind === "none" || set === undefined) throw new Error("That set is not in the current workout");
      const at = nowMs();
      if (session.timer === null || session.timer.setId !== setId || !isRunning(session.timer, at)) {
        throw new Error("A completed set keeps the rest it was logged with. Uncheck it to change it.");
      }
      const sets = session.sets.map((candidate) => (candidate.id === setId ? { ...set, restSeconds: rest } : candidate));
      // a null timer (the new rest is not longer than the elapsed time) ends it
      await store.saveWorkoutWithDetails(session.workout, session.entries, sets, commit(session, session.plan, rescheduleTimer(session.timer, rest, at)));
      return rest;
    });
  }

  // Update Rest Timers: sets the exercise's default rest and gives every UNCHECKED
  // set of that exercise in this workout that rest, in one transaction. Checked sets
  // keep the rest they were logged with, and a running timer is not touched.
  async function updateRestTimers(exerciseId, seconds) {
    const rest = requireRest(seconds);
    return retryOnConflict(async () => {
      const session = await readSession();
      requireNotStale(session.status);
      const exercise = session.exercises.find((candidate) => candidate.id === exerciseId);
      if (exercise === undefined) throw new Error(`exerciseId: no exercise with id "${exerciseId}"`);
      let updated = 0;
      const rows = session.plan.rows.map((row) => {
        if (row.exerciseId !== exerciseId) return row;
        updated += 1;
        return { ...row, restSeconds: rest };
      });
      await store.saveExercise({ ...exercise, defaultRestSeconds: rest }, commit(session, { ...session.plan, rows }));
      return { defaultRestSeconds: rest, updatedSets: updated };
    });
  }

  // Forgets every planned set and the running timer.
  async function clearPlan() {
    await store.setWorkoutMeta({ plan: null, timer: null });
  }

  // Adds a set to the current workout, starting a workout if there is none.
  // reps and weight may be typed text or numbers; text is parsed strictly, so
  // blank input is an error and never becomes 0. Bodyweight is an explicit 0.
  // The workout, entry and set are saved in ONE transaction.
  async function logSet({ exerciseId, reps, weight, weightUnit }) {
    const repsValue = typeof reps === "string" ? parseWholeNumber(reps, "reps") : reps;
    const weightValue = typeof weight === "string" ? parseDecimal(weight, "weight") : weight;

    const status = await getStatus();
    if (status.kind === "stale") {
      throw new Error("Finish, continue or discard the unfinished workout first");
    }
    const timestamp = nowIso();

    let workout;
    let entries = [];
    let sets = [];
    if (status.kind === "active") {
      ({ workout, entries, sets } = splitDetails(await store.getWorkoutWithDetails(status.workout.id)));
    } else {
      workout = createWorkout({ now: timestamp });
    }

    let entry = entries.find((candidate) => candidate.exerciseId === exerciseId);
    if (entry === undefined) {
      entry = createWorkoutEntry({ workoutId: workout.id, exerciseId, order: nextOrder(entries) });
      entries = [...entries, entry];
    }
    const set = createWorkSet({
      entryId: entry.id,
      order: nextOrder(sets.filter((candidate) => candidate.entryId === entry.id)),
      reps: repsValue,
      weightValue,
      weightUnit,
      completedAt: timestamp,
    });
    await store.saveWorkoutWithDetails(workout, entries, [...sets, set]);
    return set;
  }

  // Ends the current workout. A workout with no sets is refused (discard it).
  // A stale workout ends at its last activity, not "now", so a forgotten
  // workout does not show a duration of days. Otherwise it ends now.
  // Unchecked (planned) sets are not part of the workout: if there are any, the
  // caller must pass removeUnchecked: true after the user confirmed, and they are
  // removed together with the running timer in the same transaction.
  async function finishWorkout({ removeUnchecked = false } = {}) {
    const saved = await retryOnConflict(async () => {
      const session = await readSession();
      const { status, workout, entries, sets, plan } = session;
      if (status.kind === "none") throw new Error("There is no unfinished workout to finish");
      if (sets.length === 0) throw new Error("This workout has no sets; discard it instead");
      if (plan.rows.length > 0 && removeUnchecked !== true) {
        throw new Error(`${formatPlanned(plan.rows.length)} would be removed; confirm to finish`);
      }
      const lastActivity = sets.reduce(
        (latest, set) => (set.completedAt !== null && set.completedAt > latest ? set.completedAt : latest),
        workout.startedAt,
      );
      const current = nowIso();
      const endedAt = status.kind === "stale" ? lastActivity : (current > workout.startedAt ? current : workout.startedAt);
      return store.saveWorkoutWithDetails({ ...workout, endedAt }, entries, sets, {
        meta: { plan: null, timer: null },
        expectRev: plan.rev,
      });
    });
    await store.setContinuedWorkoutId(null);
    return saved.workout;
  }

  // The user chose to keep logging into a stale workout.
  async function continueWorkout() {
    const status = await getStatus();
    if (status.kind !== "stale") throw new Error("There is no unfinished workout to continue");
    await store.setContinuedWorkoutId(status.workout.id);
    return getStatus();
  }

  // Throws away the unfinished workout and everything logged in it.
  async function discardWorkout() {
    await retryOnConflict(async () => {
      const session = await readSession();
      if (session.status.kind === "none") throw new Error("There is no unfinished workout to discard");
      await store.discardWorkout(session.status.workout.id, {
        meta: { plan: null, timer: null },
        expectRev: session.plan.rev,
      });
    });
    await store.setContinuedWorkoutId(null);
    return true;
  }

  // Deletes a planned set, or a set of the current workout (and with it the
  // running timer, if that set owns it). A set from any other workout is refused.
  async function deleteSet(setId) {
    return retryOnConflict(async () => {
      const session = await readSession();
      if (session.plan.rows.some((row) => row.id === setId)) {
        const logged = session.entries.map((entry) => entry.exerciseId);
        const { meta, expectRev } = commit(session, removeRow(session.plan, setId, logged));
        await store.setWorkoutMeta(meta, { expectRev });
        return true;
      }
      const set = session.sets.find((candidate) => candidate.id === setId);
      if (session.status.kind === "none" || set === undefined) throw new Error("That set is not in the current workout");
      const ownCount = session.sets.filter((candidate) => candidate.entryId === set.entryId).length;
      const loggedAfter = session.entries
        .filter((entry) => entry.id !== set.entryId || ownCount > 1)
        .map((entry) => entry.exerciseId);
      return store.deleteSet(setId, commit(
        session,
        removeRow(session.plan, setId, loggedAfter), // drops an exercise that has nothing left
        session.timer !== null && session.timer.setId === setId ? null : undefined,
      ));
    });
  }

  // Reps, weight and unit of the last set logged for this exercise in the
  // current workout, or null.
  async function suggestNextSet(exerciseId) {
    const status = await getStatus();
    if (status.kind !== "active") return null;
    const { entries, sets } = splitDetails(await store.getWorkoutWithDetails(status.workout.id));
    const entry = entries.find((candidate) => candidate.exerciseId === exerciseId);
    if (entry === undefined) return null;
    const own = sets.filter((set) => set.entryId === entry.id);
    if (own.length === 0) return null;
    const last = own.reduce((best, set) => (set.order > best.order ? set : best));
    return { reps: last.reps, weightValue: last.weightValue, weightUnit: last.weightUnit };
  }

  // Creates a custom exercise. Names must be unique, ignoring case.
  async function addCustomExercise({ name, primaryMuscles, secondaryMuscles, equipmentTags, notes }) {
    const exercise = createExercise({ name, primaryMuscles, secondaryMuscles, equipmentTags, notes, isCustom: true });
    const taken = (await store.listExercises()).some(
      (existing) => existing.name.toLowerCase() === exercise.name.toLowerCase(),
    );
    if (taken) throw new Error("name: an exercise with this name already exists");
    return store.saveExercise(exercise);
  }

  // filters: { muscle, equipment } (ids, or null for any). Retired exercises are not offered; they still resolve in history.
  async function findExercises(query, filters) {
    return searchExercises(await store.listExercises(), query, filters);
  }

  // Finished workouts, newest first, with entry and set counts.
  async function getHistory() {
    return (await store.listWorkoutSummaries()).filter((workout) => workout.endedAt !== null);
  }

  // Deletes a FINISHED workout with its entries and sets, in one transaction.
  // An unfinished workout is refused (that is what Discard is for), and so is
  // an unknown id. Checking and deleting are two transactions, which is safe
  // because a finished workout never becomes unfinished again.
  async function deleteFinishedWorkout(id) {
    const workout = await store.getWorkout(id); // an empty or non-string id is refused here
    if (workout === null) throw new Error("There is no workout with that id");
    if (workout.endedAt === null) {
      throw new Error("This workout is not finished; use Discard on the Log tab instead");
    }
    return store.deleteWorkout(id);
  }

  return {
    getStatus,
    getCurrent,
    getSession,
    addSet,
    updatePlannedSet,
    checkSet,
    uncheckSet,
    setRest,
    updateRestTimers,
    clearPlan,
    logSet,
    finishWorkout,
    continueWorkout,
    discardWorkout,
    deleteSet,
    suggestNextSet,
    addCustomExercise,
    findExercises,
    getHistory,
    deleteFinishedWorkout,
    getWorkoutDetail: detailWithNames,
    getPreferredUnit: () => store.getPreferredUnit(),
    setPreferredUnit: (unit) => store.setPreferredUnit(unit),
  };
}
