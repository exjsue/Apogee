// The Body panel's Top set and Stall rows. Pure JavaScript: no DOM, no storage, no clock.
//
// The exercise is the one with the most weighted sets for the muscle over the month load, a computeMuscleLoad result
// made with detail: true (the same function and weights as the diagram; nothing is counted again here). The neck is
// folded into the traps as on the diagram (mergeByExercise). Ties go to the name, then the id.
//
// A session is one finished workout with at least one countable set of that exercise (isCountableSet: not a warm-up,
// done, at least one rep), placed by its latest set. Its best e1RM is the app's own rule (estimatedOneRepMax, Epley,
// 1 to E1RM_MAX_REPS reps) on each set's weight converted to the preferred unit and rounded to 0.1 (weightIn), then
// rounded to 0.1 again. Sessions with no e1RM (bodyweight only, or every set above the rep limit) are left out of
// the sparkline and the stall test, but their heaviest set can still be the top set.
//
// Stalled: at least STALL_SESSIONS sessions with an e1RM, and none of the latest STALL_SESSIONS - 1 is above the one
// before them. A tie is not progress.

import { mergeByExercise } from "./muscle-detail.js";
import { formatCount, formatSetWeight } from "./format.js";
import { estimatedOneRepMax, isCountableSet, weightIn } from "./strength.js";

export const TOP_SET_DAYS = 28;
export const SPARK_SESSIONS = 6;
export const STALL_SESSIONS = 4;

const round1 = (n) => Math.round(n * 10) / 10;

// sets: flat set records (store.listFinishedSetRecords). Returns the exercise's sessions, oldest first:
//   [{ workoutId, at, best (number or null), top: the heaviest set (then the most reps) }]
export function sessionsOf(sets, exerciseId, unit) {
  const byWorkout = new Map();
  for (const set of sets) {
    if (set.exerciseId !== exerciseId || !isCountableSet(set) || !["kg", "lb"].includes(set.weightUnit)) continue;
    const w = weightIn(set, unit);
    if (w === null) continue;
    const at = Date.parse(set.completedAt);
    const e1rm = estimatedOneRepMax(w, set.reps);
    const found = byWorkout.get(set.workoutId) ?? { workoutId: set.workoutId, at, best: null, top: null, topW: -Infinity };
    found.at = Math.max(found.at, at);
    if (e1rm !== null) found.best = Math.max(found.best ?? -Infinity, round1(e1rm));
    if (w > found.topW || (w === found.topW && set.reps > found.top.reps)) Object.assign(found, { top: set, topW: w });
    byWorkout.set(set.workoutId, found);
  }
  return [...byWorkout.values()]
    .sort((a, b) => a.at - b.at || (a.workoutId < b.workoutId ? -1 : 1))
    .map(({ workoutId, at, best, top }) => ({ workoutId, at, best, top }));
}

// bests: best e1RM per session, oldest first, sessions without one already left out.
export function isStalled(bests) {
  if (bests.length < STALL_SESSIONS) return false;
  const [before, ...latest] = bests.slice(-STALL_SESSIONS);
  return latest.every((best) => best <= before);
}

// The exercise id with the most weighted sets for one displayed muscle in a detail load, or null when none.
function topExerciseOf(month, muscle, names) {
  const rows = mergeByExercise(muscle === "traps" ? [...month.breakdown.traps, ...month.breakdown.neck] : month.breakdown[muscle]);
  const name = (row) => names.get(row.exerciseId) ?? row.exerciseId;
  rows.sort((a, b) => b.weighted - a.weighted || name(a).localeCompare(name(b)) || (a.exerciseId < b.exerciseId ? -1 : 1));
  return rows.length > 0 && rows[0].weighted > 0 ? rows[0].exerciseId : null;
}

// month: a computeMuscleLoad result over the last TOP_SET_DAYS days, made with detail: true. sets: flat set records.
// Returns { muscleId: TopSet } for every displayed muscle (the neck inside "traps"):
//   exerciseId, name    null when the muscle has no weighted sets in the month
//   text                the row's sentence
//   spark               best e1RM of up to SPARK_SESSIONS latest sessions, oldest first, or null with fewer than 2
//   sparkText           the same numbers in words (for the sparkline's label), or null
//   stallText           the stall sentence, or null when not stalled
export function buildTopSets({ month, sets, exercises, unit }) {
  if (month?.breakdown === undefined) throw new TypeError("month must be a load made with detail: true");
  const names = new Map((exercises instanceof Map ? [...exercises.values()] : exercises ?? []).map((exercise) => [exercise.id, exercise.name]));
  const result = {};
  for (const muscle of Object.keys(month.muscles).filter((id) => id !== "neck")) {
    const exerciseId = topExerciseOf(month, muscle, names);
    if (exerciseId === null) {
      result[muscle] = { exerciseId: null, name: null, text: `Top set: no sets in the last ${TOP_SET_DAYS} days`, spark: null, sparkText: null, stallText: null };
      continue;
    }
    const name = names.get(exerciseId) ?? exerciseId;
    const sessions = sessionsOf(sets, exerciseId, unit);
    const last = sessions.at(-1);
    const bests = sessions.map((session) => session.best).filter((best) => best !== null);
    const spark = bests.length >= 2 ? bests.slice(-SPARK_SESSIONS) : null;
    result[muscle] = {
      exerciseId,
      name,
      text: last === undefined
        ? `Top set: ${name}, no finished workout yet`
        : `Top set: ${name}, ${formatCount(last.top.reps, "rep")} · ${formatSetWeight(last.top.weightValue, last.top.weightUnit, last.top.weightUnit)}`,
      spark,
      sparkText: spark === null ? null : `Best estimated 1RM, last ${spark.length} sessions: ${spark.join(", ")} ${unit}`,
      stallText: isStalled(bests) ? `Stalled: ${name} has not progressed in ${STALL_SESSIONS} sessions.` : null,
    };
  }
  return result;
}
