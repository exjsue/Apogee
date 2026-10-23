// Workout logging rules, between the UI and the store. No DOM.
// Everything that decides, validates or calculates for the logging screens
// lives here or in the domain and storage modules, never in src/ui.

import { createWorkout, createWorkoutEntry, createWorkSet, createExercise } from "../domain/model.js";
import { parseDecimal, parseWholeNumber } from "../domain/format.js";
import { searchExercises } from "../domain/search.js";

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
  async function finishWorkout() {
    const status = await getStatus();
    if (status.kind === "none") throw new Error("There is no unfinished workout to finish");
    const { workout, sets } = splitDetails(await store.getWorkoutWithDetails(status.workout.id));
    if (sets.length === 0) throw new Error("This workout has no sets; discard it instead");
    const lastActivity = sets.reduce(
      (latest, set) => (set.completedAt !== null && set.completedAt > latest ? set.completedAt : latest),
      workout.startedAt,
    );
    const current = nowIso();
    const endedAt = status.kind === "stale" ? lastActivity : (current > workout.startedAt ? current : workout.startedAt);
    const finished = await store.saveWorkout({ ...workout, endedAt });
    await store.setContinuedWorkoutId(null);
    return finished;
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
    const status = await getStatus();
    if (status.kind === "none") throw new Error("There is no unfinished workout to discard");
    await store.discardWorkout(status.workout.id);
    await store.setContinuedWorkoutId(null);
    return true;
  }

  // Deletes a set of the current workout. A set from any other workout is refused.
  async function deleteSet(setId) {
    const status = await getStatus();
    if (status.kind === "none") throw new Error("That set is not in the current workout");
    const { sets } = splitDetails(await store.getWorkoutWithDetails(status.workout.id));
    if (!sets.some((set) => set.id === setId)) throw new Error("That set is not in the current workout");
    return store.deleteSet(setId);
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

  async function findExercises(query) {
    return searchExercises(await store.listExercises(), query);
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
