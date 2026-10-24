// Templates made from a finished workout. Pure: no DOM, no storage.
//
// A template copies only which exercises were done, in order, and how many working sets each had (see
// createTemplate in model.js). Starting a workout from one (later work) would put its exercises into
// plan.exercises in this order and give each setCount blank unchecked rows (orders 0..setCount-1, reps and
// weight blank so the ghosts fill them in, the default rest, isWarmup false): see src/domain/workout-plan.js.

import { createTemplate } from "./model.js";

const byOrder = (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// `workout` is a finished workout as getWorkoutWithDetails returns it (entries, each with its sets). Exercises
// keep the order of their entries; an entry counts its sets that are not warm-ups; an entry with none is left
// out; an exercise with two entries is listed once, where it first appears, with the counts added up. A
// workout with nothing left is refused. Nothing of the workout is kept but exercise ids and counts.
export function templateFromWorkout(workout, { id, name } = {}) {
  if (workout === null || typeof workout !== "object" || !Array.isArray(workout.entries)) {
    throw new Error("workout must be a workout with its entries");
  }
  if (typeof workout.endedAt !== "string") throw new Error("Only a finished workout can be saved as a template");
  const counts = new Map();
  for (const entry of [...workout.entries].sort(byOrder)) {
    const working = (Array.isArray(entry.sets) ? entry.sets : []).filter((set) => set.isWarmup !== true).length;
    if (working > 0) counts.set(entry.exerciseId, (counts.get(entry.exerciseId) ?? 0) + working);
  }
  if (counts.size === 0) throw new Error("This workout has no working sets to save as a template");
  return createTemplate({ id, name, exercises: [...counts].map(([exerciseId, setCount]) => ({ exerciseId, setCount })) });
}
