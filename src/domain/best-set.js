// The best set of one exercise in one workout, for the History detail's collapsed summary line. Pure JavaScript: no DOM,
// no storage, no clock. Not a record (see strength.js and getRecords, which look across all workouts): only this
// workout's sets are read.
//
// The order of choice, first that applies:
//   1. "e1rm": among working sets with 1 to 12 reps and a weight above 0, the highest Epley estimate (strength.js,
//      rounded to 0.1 as there). A tie goes to the heavier set, then the earlier one.
//   2. "heaviest": if none qualifies (all over 12 reps, or bodyweight), the heaviest working set with reps; a tie goes to the
//      one with more reps, then the earlier one.
//   3. "longest": if there is no working set with reps at all, the longest timed set; a tie goes to the heavier, then the earlier.
// Warm-ups are never chosen. A set in a unit other than kg or lb is not compared by weight (it can still be the
// longest timed set). Weights are compared in `unit` ("kg" or "lb"), converted and rounded as strength.js does.
// "Earlier" is the set's place in the list given. Returns { set, basis } with the original set object, or null.

import { weightIn, estimatedOneRepMax, round1 } from "./strength.js";
import { isWarmupSet } from "./workout-plan.js";
import { isTimedSet } from "./format.js";

const UNITS = ["kg", "lb"];
const hasReps = (set) => typeof set.reps === "number" && Number.isFinite(set.reps) && set.reps > 0;

// The item that is highest by the first key, then the next, and on a full tie the earlier one.
function pick(items, ...keys) {
  let best = null;
  for (const item of items) {
    if (best === null) { best = item; continue; }
    let decided = false;
    for (const key of keys) {
      const difference = key(item) - key(best);
      if (difference !== 0) {
        if (difference > 0) best = item;
        decided = true;
        break;
      }
    }
    if (!decided && item.index < best.index) best = item;
  }
  return best;
}

export function bestSet(sets, unit) {
  const working = sets
    .map((set, index) => ({ set, index, weight: UNITS.includes(set.weightUnit) ? weightIn(set, unit) : null }))
    .filter(({ set }) => !isWarmupSet(set));

  const withReps = working.filter(({ set, weight }) => hasReps(set) && weight !== null);
  const estimated = withReps
    .map((item) => ({ ...item, e1rm: estimatedOneRepMax(item.weight, item.set.reps) }))
    .filter((item) => item.e1rm !== null)
    .map((item) => ({ ...item, e1rm: round1(item.e1rm) }));
  const byEstimate = pick(estimated, (item) => item.e1rm, (item) => item.weight);
  if (byEstimate !== null) return { set: byEstimate.set, basis: "e1rm" };

  const heaviest = pick(withReps, (item) => item.weight, (item) => item.set.reps);
  if (heaviest !== null) return { set: heaviest.set, basis: "heaviest" };

  if (working.some(({ set }) => hasReps(set))) return null; // a set with reps but no usable weight: nothing to show

  const timed = working.filter(({ set }) => isTimedSet(set) && Number.isFinite(set.durationSeconds) && set.durationSeconds > 0);
  const longest = pick(timed, (item) => item.set.durationSeconds, (item) => item.weight ?? 0);
  return longest === null ? null : { set: longest.set, basis: "longest" };
}
