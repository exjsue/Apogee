// Writes a Strong import plan (strong.js buildStrongPlan) into storage, ADDING to what is there. No DOM, no network.
// It never calls or changes the backup import (which replaces everything). One adapter transaction covers
// exercises, workouts, entries and sets: it checks that nothing it is about to write already exists and that the
// existing exercises it needs are still there, and throws instead of overwriting. Any throw rolls everything back
// (adapter contract, src/storage/store.js). Meta (the session plan, the timer, settings) is not touched.

import { createExercise, createWorkout, createWorkoutEntry, createWorkSet } from "../domain/model.js";
import { requireFreeName } from "../domain/exercise-names.js";

const STORE_NAMES = ["exercises", "workouts", "entries", "sets"];

// What buildStrongPlan needs to know about stored data: { exercises, workoutIds }. Read only.
export function readImportContext(adapter) {
  return adapter.transaction(["exercises", "workouts"], "readonly", async (tx) => ({
    exercises: await tx.getAll("exercises"),
    workoutIds: new Set((await tx.getAll("workouts")).map((workout) => workout.id)),
  }));
}

// The plan's records are built by buildStrongPlan through the model; they go through the same create functions again
// here and must come out identical, so a record that is invalid or not in the model's own form is refused. This does
// not detect a change to another valid value (a different weight): the plan is built and applied in one run, not stored.
function revalidated(records) {
  const same = (made, given, where) => {
    if (JSON.stringify(made) !== JSON.stringify(given)) throw new Error(`The plan changed after it was built (${where}); nothing is written`);
    return made;
  };
  return {
    exercises: records.exercises.map((record) => same(createExercise(record), record, "exercise")),
    workouts: records.workouts.map((record) => same(createWorkout(record), record, "workout")),
    entries: records.entries.map((record) => same(createWorkoutEntry(record), record, "entry")),
    sets: records.sets.map((record) => same(createWorkSet(record), record, "set")),
  };
}

// Resolves { exercises, workouts, entries, sets }: the counts written. Refuses a plan with errors.
export async function applyStrongPlan(adapter, plan) {
  if (plan?.ok !== true) throw new Error("The import plan has errors; nothing is written");
  const records = revalidated(plan.records);
  return adapter.transaction(STORE_NAMES, "readwrite", async (tx) => {
    const stored = await tx.getAll("exercises");
    const storedIds = new Set(stored.map((exercise) => exercise.id));
    for (const id of plan.requiredExerciseIds) {
      if (!storedIds.has(id)) throw new Error("An exercise the import maps to is no longer stored; nothing is written");
    }
    const fresh = [...stored];
    for (const exercise of records.exercises) {
      requireFreeName(fresh, exercise.name);
      fresh.push(exercise);
    }
    for (const store of STORE_NAMES) {
      const clashes = await Promise.all(records[store].map((record) => tx.get(store, record.id)));
      if (clashes.some((found) => found !== undefined)) throw new Error(`A ${store} record with the same id already exists; nothing is written`);
    }
    for (const store of STORE_NAMES) {
      await Promise.all(records[store].map((record) => tx.put(store, record)));
    }
    return Object.fromEntries(STORE_NAMES.map((store) => [store, records[store].length]));
  });
}
