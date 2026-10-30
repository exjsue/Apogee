// What the Body diagram says about each muscle, worked out from two per-muscle loads (src/domain/muscle-load.js): the
// last WINDOW_DAYS days, and the last NEGLECTED_WEEKS weeks. All the thresholds live here; the diagram only draws
// what it is given. Pure JavaScript: no DOM, no storage, no clock. The two loads are read, never changed.

import { foldNeckIntoTraps } from "./body-display.js";
import { roundToHalf } from "./muscle-load.js";

export const WINDOW_DAYS = 7;
export const NEGLECTED_WEEKS = 3;

// The weighted sets per muscle per WINDOW_DAYS days that the diagram treats as a good range, and the top of it is
// what the darkest shade stands for. A CONTESTED DEFAULT, not a rule: the evidence is mixed (a 2026 meta-regression
// supports fractional counting and diminishing returns; other studies put the optimum for trained lifters nearer
// 9 to 15, and gains are reported to continue above 20). Changed here, in one place. max sets the darkest shade and the
// above-target marker; min only separates "below" from "within" in the detail panel (src/domain/muscle-detail.js).
export const TARGET_RANGE = Object.freeze({ min: 10, max: 20 });

const weightedOf = (load) => Object.fromEntries(Object.entries(load.muscles).map(([id, row]) => [id, row.weighted]));
// Each shown total rounded once, after the neck is folded in (roundToHalf).
const rounded = (values) => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, roundToHalf(value)]));
const countedSets = (load) => Object.values(load.muscles).reduce((sum, row) => sum + row.primarySets + row.secondarySets, 0);

// recent: the load over the last WINDOW_DAYS days; longer: the load over the last NEGLECTED_WEEKS weeks.
// Returns:
//   values      { muscleId: weighted sets in the recent window, rounded to the nearest 0.5 }, the neck folded into the
//               traps (no neck key)
//   above       ids whose value is strictly more than TARGET_RANGE.max (exactly the max is not above)
//   neglected   ids with no weighted sets at all in the longer window, the neck folded into the traps first, so
//               neck work counts as traps work; empty when there is no history
//   hasHistory  whether the longer window counted any set. With none, every muscle would be flagged, which is
//               noise, so nothing is marked neglected.
export function computeBodyStatus({ recent, longer }) {
  const values = rounded(foldNeckIntoTraps(weightedOf(recent)));
  const longerValues = foldNeckIntoTraps(weightedOf(longer));
  const ids = Object.keys(values);
  const hasHistory = countedSets(longer) > 0;
  return {
    values,
    above: ids.filter((id) => values[id] > TARGET_RANGE.max),
    neglected: hasHistory ? ids.filter((id) => !(longerValues[id] > 0)) : [],
    hasHistory,
  };
}
