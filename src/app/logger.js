// Workout logging rules, between the UI and the store. No DOM.
// Everything that decides, validates or calculates for the logging screens
// lives here or in the domain and storage modules, never in src/ui.

import { createWorkout, createWorkoutEntry, createWorkSet, createExercise } from "../domain/model.js";
import { parseDecimal, parseWholeNumber } from "../domain/format.js";
import { searchExercises } from "../domain/search.js";
import { ambiguousCustomIds, requireFreeName } from "../domain/exercise-names.js";
import { exerciseIdsByRecency } from "../domain/recent-exercises.js";
import {
  DEFAULT_REST_SECONDS, startTimer, rescheduleTimer, isRunning, requireRest,
} from "../domain/rest-timer.js";
import {
  normalizePlan, addRow, updateRow, removeRow, bumpPlan, pruneOrphans, nextOrder as nextRowOrder, buildExerciseBlocks,
  heaviestSet, sameGhost, displayedExerciseIds, orderEntriesLike, swapped, reorderedRowOrders, applyRowOrders,
} from "../domain/workout-plan.js";
import { templateFromWorkout, planFromTemplate } from "../domain/template.js";
import { computeMuscleLoad } from "../domain/muscle-load.js";
import { buildMuscleDetails } from "../domain/muscle-detail.js";
import { computeBodyStatus, WINDOW_DAYS, NEGLECTED_WEEKS } from "../domain/body-status.js";
import { SESSION_CONFLICT } from "../storage/schema.js";

export const DEFAULT_STALE_AFTER_HOURS = 12;
export const RECENT_LIMIT = 8; // how many exercises the picker's Recent group shows
export const RECENT_WORKOUTS = 30; // how many of the newest workouts it looks through (each is one read; 2,000 took 2 to 3.5 s)
const UNKNOWN_EXERCISE = "Unknown exercise";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
    const exercises = await store.listExercises();
    const names = new Map(exercises.map((exercise) => [exercise.id, exercise.name]));
    const marked = ambiguousCustomIds(exercises);
    return {
      ...details,
      setCount: details.entries.reduce((total, entry) => total + entry.sets.length, 0),
      entries: details.entries.map((entry) => ({
        ...entry,
        exerciseName: names.get(entry.exerciseId) ?? UNKNOWN_EXERCISE,
        markCustom: marked.has(entry.exerciseId), // false for an id that is not stored
      })),
    };
  }

  // The status plus the workout's entries and sets (with exercise names, and markCustom: true when the entry's
  // exercise is a custom that shares its name with another stored exercise; see src/domain/exercise-names.js).
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

  // The exercises whose first row is unchecked: only such a row takes its ghost from
  // the last session, so only these need history read.
  function firstRowUnchecked(session) {
    const entryOf = new Map(session.entries.map((entry) => [entry.exerciseId, entry.id]));
    const ids = [];
    for (const exerciseId of new Set(session.plan.rows.map((row) => row.exerciseId))) {
      const firstPlanned = Math.min(...session.plan.rows.filter((row) => row.exerciseId === exerciseId).map((row) => row.order));
      const loggedOrders = session.sets.filter((set) => set.entryId === entryOf.get(exerciseId)).map((set) => set.order);
      if (loggedOrders.length === 0 || firstPlanned < Math.min(...loggedOrders)) ids.push(exerciseId);
    }
    return ids;
  }

  // exerciseId -> the heaviest set of that exercise's last session (see heaviestSet), for
  // the given exercises. The last session is the newest workout, other than the current
  // one, with a set of that exercise that is not a warm-up. Like findRecentExercises it
  // looks through at most RECENT_WORKOUTS workouts, newest first, one read each, and
  // stops as soon as every exercise has one. Reads only; nothing is written.
  async function lastSessionBest(exerciseIds, currentWorkoutId) {
    const found = new Map();
    const wanted = new Set(exerciseIds);
    if (wanted.size === 0) return found;
    const workouts = (await store.listWorkouts()).filter((workout) => workout.id !== currentWorkoutId).slice(0, RECENT_WORKOUTS);
    for (const workout of workouts) {
      const details = await store.getWorkoutWithDetails(workout.id);
      if (details === null) continue;
      const setsOf = new Map();
      for (const entry of details.entries) {
        if (!wanted.has(entry.exerciseId) || found.has(entry.exerciseId)) continue;
        setsOf.set(entry.exerciseId, [...(setsOf.get(entry.exerciseId) ?? []), ...entry.sets]);
      }
      for (const [exerciseId, sets] of setsOf) {
        const best = heaviestSet(sets);
        if (best !== null) found.set(exerciseId, best); // only warm-ups: look further back
      }
      if (found.size === wanted.size) break;
    }
    return found;
  }

  // The blocks of the Log tab for a session, ghosts included. `onlyExerciseId` limits the
  // history read to one exercise (checkSet needs no other).
  async function blocksOf(session, at, onlyExerciseId = null) {
    const needed = firstRowUnchecked(session).filter((id) => onlyExerciseId === null || id === onlyExerciseId);
    const lastBest = await lastSessionBest(needed, session.workout === null ? null : session.workout.id);
    return buildExerciseBlocks({
      entries: session.entries, sets: session.sets, plan: session.plan, names: new Map(session.exercises.map((exercise) => [exercise.id, exercise.name])),
      timer: session.timer, nowMs: at, lastBest,
      defaults: new Map(session.exercises.map((exercise) => [exercise.id, exercise.defaultRestSeconds])),
    });
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
    const marked = ambiguousCustomIds(session.exercises);
    const at = nowMs();
    return {
      status: session.status,
      workout: session.status.kind === "none" ? null : await detailWithNames(session.status.workout.id),
      blocks: (await blocksOf(session, at)).map((block) => ({ ...block, markCustom: marked.has(block.exerciseId) })),
      timer: session.timer,
      nowMs: at,
      plannedCount: session.plan.rows.length,
      loggedCount: session.sets.length,
    };
  }

  // Adds an unchecked row for an exercise (adding the exercise to the session if
  // needed). The row is stored blank: what it would copy (the row above, or the last
  // session) is its ghost, worked out every time it is shown and never stored (see
  // ghostFor in src/domain/workout-plan.js). Nothing is stored in the sets store,
  // and no workout is started: that happens when a row is checked.
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
      const row = {
        id: crypto.randomUUID(),
        exerciseId,
        order: nextRowOrder(session.plan, exerciseId, logged),
        reps: "",
        weight: "",
        unit: await store.getPreferredUnit(), // a blank weight takes the app's kg/lb when typed
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
  // a number from 0 to MAX_WEIGHT_KG, both present (typed, or else taken from the
  // row's ghost: an untouched row with a ghost can be checked; blank with no ghost is
  // refused and bodyweight is an explicit 0), in kg or lb. A weight taken from the
  // ghost is stored in the number and unit it was entered in, never converted.
  // Anything else leaves the row unchecked. The set, the removal of the row and the
  // timer are written in ONE transaction.
  // `shownGhost` is the ghost the screen showed (omit it when nothing was shown, as in
  // tests): if the ghost worked out now differs in a field it would fill in (another
  // tab changed the row above, say), the check is refused and nothing is stored.
  async function checkSet(rowId, fields = {}, { shownGhost } = {}) {
    if (Object.keys(fields).length > 0) {
      await updatePlannedSet(rowId, fields); // keep what was typed even if the check is refused
    }
    return retryOnConflict(async () => {
      const session = await readSession();
      requireNotStale(session.status);
      const row = session.plan.rows.find((candidate) => candidate.id === rowId);
      if (row === undefined) throw new Error("That set is not planned (it may already be checked)");

      const at = nowMs();
      const ghost = (await blocksOf(session, at, row.exerciseId))
        .flatMap((block) => block.rows).find((candidate) => candidate.id === rowId).ghost;
      const repsFromGhost = row.reps.trim() === "" && ghost !== null && ghost.reps !== "";
      const weightFromGhost = row.weight.trim() === "" && ghost !== null && ghost.weight !== "";
      if (shownGhost !== undefined) {
        // Only the fields the ghost fills in are compared, in their stored form.
        const used = (candidate) => {
          if (candidate === null) return null;
          const reps = row.reps.trim() === "" ? candidate.reps : "";
          const weight = row.weight.trim() === "" ? candidate.weight : "";
          return reps === "" && weight === "" ? null : { reps, weight, unit: weight === "" ? "" : candidate.unit };
        };
        if (!sameGhost(used(shownGhost), used(ghost))) throw new Error("The suggestion changed. Check again.");
      }
      const repsValue = parseWholeNumber(repsFromGhost ? ghost.reps : row.reps, "reps");
      const weightValue = parseDecimal(weightFromGhost ? ghost.weight : row.weight, "weight");
      const weightUnit = weightFromGhost ? ghost.unit : row.unit;
      const timestamp = new Date(at).toISOString();

      let { workout, entries } = session;
      if (workout === null) workout = createWorkout({ now: timestamp });
      let entry = entries.find((candidate) => candidate.exerciseId === row.exerciseId);
      if (entry === undefined) {
        entry = createWorkoutEntry({ workoutId: workout.id, exerciseId: row.exerciseId, order: nextOrder(entries) });
        // The entries of this workout take the order the exercises are SHOWN in (displayedExerciseIds), so the
        // order survives Finish, when the plan is gone: an exercise with an entry that is not in
        // plan.exercises is shown first, in its entry order, then plan.exercises in its order. Only `order`
        // changes, and only for this workout's entries (a finished workout is never read here).
        entries = orderEntriesLike([...entries, entry], displayedExerciseIds([...entries, entry], session.plan));
        entry = entries.find((candidate) => candidate.exerciseId === row.exerciseId);
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
        weightUnit,
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

  // Changes the reps and/or weight of a CHECKED set of the current workout, in place: the
  // same id, order, rest, warm-up flag and completedAt; the set stays checked and the
  // running timer is not touched. The values are read as strictly as checkSet reads them
  // (blank reps or weight is refused: "reps is required", "weight is required"; 0 reps,
  // negatives, fractions of a rep and anything over the limits are refused by createWorkSet),
  // so an edit can never make a set with no reps. A refused edit changes nothing. The
  // weight keeps the unit it was entered in (fields.unit is ignored). It never goes
  // through uncheckSet or deleteSet: the whole workout is written back with the same
  // entries and sets, so saveWorkoutWithDetails deletes nothing.
  async function editSet(setId, fields = {}) {
    return retryOnConflict(async () => {
      const session = await readSession();
      const set = session.sets.find((candidate) => candidate.id === setId);
      if (session.status.kind === "none" || set === undefined) throw new Error("That set is not in the current workout");
      requireNotStale(session.status);
      const edited = createWorkSet({
        ...set,
        reps: "reps" in fields ? parseWholeNumber(fields.reps, "reps") : set.reps,
        weightValue: "weight" in fields ? parseDecimal(fields.weight, "weight") : set.weightValue,
      });
      const sets = session.sets.map((candidate) => (candidate.id === setId ? edited : candidate));
      await store.saveWorkoutWithDetails(session.workout, session.entries, sets, commit(session, session.plan)); // timer undefined: untouched
      return edited;
    });
  }

  const ORDER_CHANGED = "The order changed. Check again.";
  const requireDirection = (direction) => {
    if (direction !== "up" && direction !== "down") throw new Error('direction must be "up" or "down"');
    return direction === "up" ? -1 : 1;
  };

  // The blocks as shown, without ghosts (only the order matters, so no history is read).
  const orderBlocks = (session) => buildExerciseBlocks({
    entries: session.entries, sets: session.sets, plan: session.plan, names: new Map(session.exercises.map((exercise) => [exercise.id, exercise.name])),
    timer: session.timer, nowMs: nowMs(),
  });

  // Moves a set (checked or unchecked) one place up or down among its exercise's rows, as shown: it
  // trades `order` with the neighbouring row, whether that is checked or not. `neighborId` is the id of the
  // row the screen showed there; if it is not the neighbour now (another tab reordered) the move is refused
  // with nothing stored. Only `order` changes: ids, completedAt, rest, warm-up flags, the timer and every
  // other field stay as they are. One write: checked sets and the plan commit together (saveWorkoutWithDetails
  // writes sets and meta in one transaction), or, if only unchecked rows move, the plan alone.
  async function moveSet(setId, direction, neighborId) {
    const step = requireDirection(direction);
    return retryOnConflict(async () => {
      const session = await readSession();
      requireNotStale(session.status);
      const rows = orderBlocks(session).map((block) => block.rows).find((candidate) => candidate.some((row) => row.id === setId));
      if (rows === undefined) throw new Error("That set is not in the current workout");
      const from = rows.findIndex((row) => row.id === setId);
      const to = from + step;
      if (to < 0 || to >= rows.length) throw new Error("That set cannot move further");
      if (rows[to].id !== neighborId) throw new Error(ORDER_CHANGED);
      const orders = reorderedRowOrders(rows, from, to);
      const plan = applyRowOrders(session.plan, orders);
      const sets = session.sets.map((set) => (orders.has(set.id) ? { ...set, order: orders.get(set.id) } : set));
      const loggedChanged = session.sets.some((set, index) => set.order !== sets[index].order);
      const { meta, expectRev } = commit(session, plan);
      if (loggedChanged) await store.saveWorkoutWithDetails(session.workout, session.entries, sets, { meta, expectRev });
      else await store.setWorkoutMeta(meta, { expectRev });
      return orders;
    });
  }

  // Moves an exercise one place up or down among the exercises as shown. The whole shown order is written
  // to plan.exercises, and the entries of this workout take that order (orderEntriesLike), so it survives
  // Finish. `neighborExerciseId` is checked like moveSet's neighborId. Only `order` of entries and the plan's
  // list change; no entry or set is created, deleted or otherwise edited.
  async function moveExercise(exerciseId, direction, neighborExerciseId) {
    const step = requireDirection(direction);
    return retryOnConflict(async () => {
      const session = await readSession();
      requireNotStale(session.status);
      const ids = displayedExerciseIds(session.entries, session.plan);
      const from = ids.indexOf(exerciseId);
      if (from === -1) throw new Error("That exercise is not in the current workout");
      const to = from + step;
      if (to < 0 || to >= ids.length) throw new Error("That exercise cannot move further");
      if (ids[to] !== neighborExerciseId) throw new Error(ORDER_CHANGED);
      const next = swapped(ids, from, to);
      const entries = orderEntriesLike(session.entries, next);
      const entriesChanged = session.entries.some((entry, index) => entry.order !== entries[index].order);
      const { meta, expectRev } = commit(session, { ...session.plan, exercises: next });
      if (entriesChanged) await store.saveWorkoutWithDetails(session.workout, entries, session.sets, { meta, expectRev });
      else await store.setWorkoutMeta(meta, { expectRev });
      return next;
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

  // Creates a custom exercise. Names must be unique, ignoring case; a taken name throws with code NAME_TAKEN, and
  // hiddenExerciseId when it is one of the user's hidden exercises (requireFreeName).
  async function addCustomExercise({ name, primaryMuscles, secondaryMuscles, equipmentTags, notes }) {
    const exercise = createExercise({ name, primaryMuscles, secondaryMuscles, equipmentTags, notes, isCustom: true });
    requireFreeName(await store.listExercises(), exercise.name);
    return store.saveExercise(exercise);
  }

  // The user's own exercises that are hidden, alphabetical by name (for the Settings list).
  async function listHiddenCustomExercises() {
    return (await store.listExercises()).filter((exercise) => exercise.isCustom === true && exercise.retired === true);
  }

  // filters: { muscle, equipment } (ids, or null for any). Retired exercises are not offered; they still resolve in history.
  async function findExercises(query, filters) {
    return searchExercises(await store.listExercises(), query, filters);
  }

  // The exercises used most recently, most recent first, at most `limit` (default RECENT_LIMIT), derived from
  // saved sets only (planned rows live in meta and are never read here). Matched by exercise id. Retired
  // exercises and ids that no longer exist are skipped and do not use up a place. It reads workouts newest
  // first, one at a time, and stops as soon as it has enough. It also looks through at most `maxWorkouts`
  // (default RECENT_WORKOUTS) workouts, so a history that uses few distinct exercises cannot make it read
  // everything: an exercise last used longer ago than that is not "recent".
  async function findRecentExercises(limit = RECENT_LIMIT, maxWorkouts = RECENT_WORKOUTS) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a whole number of at least 1");
    if (!Number.isInteger(maxWorkouts) || maxWorkouts < 1) throw new Error("maxWorkouts must be a whole number of at least 1");
    const usable = new Map((await store.listExercises()).filter((exercise) => exercise.retired !== true).map((exercise) => [exercise.id, exercise]));
    const found = [];
    const seen = new Set();
    for (const workout of (await store.listWorkouts()).slice(0, maxWorkouts)) {
      if (found.length >= limit) break;
      const details = await store.getWorkoutWithDetails(workout.id);
      if (details === null) continue;
      for (const id of exerciseIdsByRecency(details.entries)) {
        if (found.length >= limit) break;
        if (seen.has(id)) continue;
        seen.add(id);
        if (usable.has(id)) found.push(usable.get(id));
      }
    }
    return found;
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
      throw new Error("This workout is not finished; use Discard on the New tab instead");
    }
    return store.deleteWorkout(id);
  }

  // Saves a FINISHED workout as a template (exercises in order, working sets counted; see templateFromWorkout).
  // A workout with nothing countable, an unfinished one, or a bad name is refused and nothing is written.
  // Duplicate names are allowed.
  async function saveWorkoutAsTemplate(workoutId, name) {
    const workout = await store.getWorkoutWithDetails(workoutId);
    if (workout === null) throw new Error("There is no workout with that id");
    return store.saveTemplate(templateFromWorkout(workout, { name }));
  }

  // Same id and exercises, new name (checked by the template name rule).
  async function renameTemplate(id, name) {
    const template = await store.getTemplate(id);
    if (template === null) throw new Error("That template no longer exists");
    return store.saveTemplate({ ...template, name });
  }

  // Puts a template's exercises into the session as blank unchecked rows (planFromTemplate). Refused, with
  // nothing written, while anything is running or planned: a workout (active or stale), or unchecked rows.
  async function startFromTemplate(templateId) {
    const template = await store.getTemplate(templateId);
    if (template === null) throw new Error("That template no longer exists");
    return retryOnConflict(async () => {
      const session = await readSession();
      if (session.status.kind === "stale") {
        throw new Error('An unfinished workout is waiting on the New tab. Use "Finish" or "Discard" on it before starting from a template.');
      }
      if (session.status.kind === "active") {
        throw new Error('A workout is already running. Use "Finish workout" or "Discard workout" on the New tab before starting from a template.');
      }
      if (session.plan.rows.length > 0 || session.plan.exercises.length > 0) {
        throw new Error(
          'Sets are already planned on the New tab. Remove them with the "Delete set" (×) buttons, or check one and then use '
          + '"Finish workout" or "Discard workout", before starting from a template.',
        );
      }
      const known = new Set(session.exercises.map((exercise) => exercise.id));
      if (template.exercises.some(({ exerciseId }) => !known.has(exerciseId))) {
        throw new Error(`The template "${template.name}" lists an exercise that is no longer in the library`);
      }
      const plan = planFromTemplate(session.plan, template, {
        unit: await store.getPreferredUnit(),
        newId: () => crypto.randomUUID(),
      });
      const { meta, expectRev } = commit(session, plan);
      await store.setWorkoutMeta(meta, { expectRev });
      return template;
    });
  }

  // What the Body tab shows (src/domain/body-status.js): the weighted sets per muscle over the last WINDOW_DAYS days,
  // and which muscles had none over the last NEGLECTED_WEEKS weeks. Read only. Sets are placed by their own
  // completedAt, so a workout is loaded when it can hold a set in the longer window: it has no endedAt (still
  // unfinished, of any age, as a stale workout can be continued), or it ended inside the window, or its endedAt is
  // unreadable. A finish sets endedAt at or after every set in the workout. The window ends 1 ms after now, so a set
  // logged this instant counts. Several reads, not one transaction: a set logged between them may show in one
  // window and not the other, which a redraw puts right. It also returns `details`, a MuscleDetail per displayed
  // muscle for the tap-to-inspect panel (src/domain/muscle-detail.js), made from the same reads.
  async function getMuscleStatus() {
    const nowAt = nowDate().getTime();
    const end = nowAt + 1;
    const longerStart = nowAt - NEGLECTED_WEEKS * 7 * DAY_MS;
    const details = [];
    for (const workout of await store.listWorkouts()) {
      const endedMs = workout.endedAt === null || workout.endedAt === undefined ? null : Date.parse(workout.endedAt);
      if (endedMs !== null && endedMs < longerStart) continue; // a NaN (unreadable) endedAt fails this test, so it is loaded
      const found = await store.getWorkoutWithDetails(workout.id);
      if (found !== null) details.push(found);
    }
    const exercises = await store.listExercises();
    const load = (start, stop, detail = false) => computeMuscleLoad({ workouts: details, exercises, window: { start, end: stop }, detail });
    const recentStart = nowAt - WINDOW_DAYS * DAY_MS;
    const recent = load(recentStart, end, true);
    const longer = load(longerStart, end, true);
    // The window before the recent one, [now - 14 days, now - 7 days): it ends where the recent one starts, so no set counts twice.
    const previous = load(nowAt - 2 * WINDOW_DAYS * DAY_MS, recentStart);
    // The detail panel's numbers come from the same reads: no read per tap.
    return { ...computeBodyStatus({ recent, longer }), details: buildMuscleDetails({ recent, previous, longer, exercises, now: nowAt }) };
  }

  return {
    getStatus,
    getCurrent,
    getSession,
    addSet,
    updatePlannedSet,
    checkSet,
    uncheckSet,
    editSet,
    moveSet,
    moveExercise,
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
    // The user's own exercises (see store.js): remove deletes an unused one and hides a used one.
    getExerciseUsage: (id) => store.getExerciseUsage(id),
    removeCustomExercise: (id) => store.removeCustomExercise(id),
    updateCustomExercise: (id, fields) => store.updateCustomExercise(id, fields),
    restoreCustomExercise: (id) => store.restoreCustomExercise(id),
    listHiddenCustomExercises,
    findExercises,
    findRecentExercises,
    getHistory,
    getMuscleStatus,
    deleteFinishedWorkout,
    getWorkoutDetail: detailWithNames,
    saveWorkoutAsTemplate,
    listTemplates: () => store.listTemplates(),
    renameTemplate,
    deleteTemplate: (id) => store.deleteTemplate(id),
    startFromTemplate,
    getPreferredUnit: () => store.getPreferredUnit(),
    setPreferredUnit: (unit) => store.setPreferredUnit(unit),
  };
}
