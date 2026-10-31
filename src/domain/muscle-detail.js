// What the Body tab's detail panel says about one muscle, worked out from three loads of src/domain/muscle-load.js: the
// last WINDOW_DAYS days, the WINDOW_DAYS days before them, and the last NEGLECTED_WEEKS weeks. The counting rule is
// not repeated here: this only reads the loads (the recent and the longer one made with detail: true) and adds up
// what they hold. Every sentence the panel shows is made here, so the UI only draws strings. Pure JavaScript: no DOM,
// no storage, no clock (now comes in as a parameter). The loads are read, never changed.
//
// The neck is shown together with the traps, as on the diagram (foldNeckIntoTraps). An exercise that credits both the
// traps and the neck is ONE entry: its sets are counted once, its weighted credits are added, and its role is
// "primary" if it is primary for either of them, otherwise "secondary".

import { foldNeckIntoTraps } from "./body-display.js";
import { formatLabel, formatCount } from "./format.js";
import { TARGET_RANGE, WINDOW_DAYS, NEGLECTED_WEEKS } from "./body-status.js";
import { roundToHalf } from "./muscle-load.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CONTRIBUTORS = 5;

// Pairs for the balance row. No validated ideal ratio exists, so the panel shows totals and a ratio and no verdict.
export const BALANCE_PAIRS = Object.freeze([
  { first: { name: "Push", muscles: ["chest", "front_delts", "side_delts", "triceps"] }, second: { name: "Pull", muscles: ["upper_back", "lats", "rear_delts", "biceps"] } },
  { first: { name: "Quads", muscles: ["quads"] }, second: { name: "Hamstrings", muscles: ["hamstrings"] } },
  { first: { name: "Abs", muscles: ["abs"] }, second: { name: "Lower back", muscles: ["lower_back"] } },
]);

const fmt = (n) => String(Math.round(n * 100) / 100);
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "0");
// A muscle's total over a window, the neck folded into the traps, then rounded once to the nearest 0.5. The
// contributor rows keep their exact weighted credit, so they may add up to a little more or less than the total.
const totalsOf = (load) => {
  const folded = foldNeckIntoTraps(Object.fromEntries(Object.entries(load.muscles).map(([id, row]) => [id, row.weighted])));
  return Object.fromEntries(Object.entries(folded).map(([id, value]) => [id, roundToHalf(value)]));
};

// Elapsed time, not calendar days, so a time zone or a clock change cannot move the answer.
function lastTrainedText(lastAt, now) {
  if (lastAt === null) return `more than ${NEGLECTED_WEEKS} weeks ago or never`;
  const elapsed = now - lastAt;
  if (elapsed < DAY_MS) return "less than 24 hours ago";
  if (elapsed < 2 * DAY_MS) return "1 day ago";
  return `${Math.floor(elapsed / DAY_MS)} days ago`;
}

// One entry per exercise (see the top of the file); rows may list the same exercise for two muscles.
export function mergeByExercise(rows) {
  const merged = new Map();
  for (const row of rows) {
    const found = merged.get(row.exerciseId);
    if (found === undefined) {
      merged.set(row.exerciseId, { ...row });
    } else {
      found.sets = Math.max(found.sets, row.sets);
      found.weighted += row.weighted;
      if (row.role === "primary") found.role = "primary";
    }
  }
  return [...merged.values()];
}

function topOf(rows, role, names) {
  return rows
    .filter((row) => row.role === role)
    .map(({ exerciseId, sets, weighted }) => {
      const name = names.get(exerciseId) ?? exerciseId;
      return { exerciseId, name, sets, weighted, text: `${name}: ${formatCount(sets, "set")}, ${fmt(weighted)} weighted` };
    })
    .sort((a, b) => b.weighted - a.weighted || a.name.localeCompare(b.name) || (a.exerciseId < b.exerciseId ? -1 : 1))
    .slice(0, TOP_CONTRIBUTORS);
}

function balanceFor(muscle, values) {
  const pair = BALANCE_PAIRS.find(({ first, second }) => first.muscles.includes(muscle) || second.muscles.includes(muscle));
  if (pair === undefined) return null;
  const total = (side) => side.muscles.reduce((sum, id) => sum + (values[id] ?? 0), 0);
  const [a, b] = [total(pair.first), total(pair.second)];
  const ratio = a > 0 && b > 0 ? Math.round((a / b) * 100) / 100 : null;
  return {
    first: { name: pair.first.name, total: a },
    second: { name: pair.second.name, total: b },
    ratio,
    text: `${pair.first.name} ${fmt(a)} vs ${pair.second.name} ${fmt(b)} weighted sets${ratio === null ? "" : `, ratio ${fmt(ratio)} : 1`}`,
  };
}

// recent, longer: loads made with detail: true; previous: any load. exercises: records or a Map by id (for the names).
// Returns { muscleId: MuscleDetail } for every muscle the diagram draws (the neck is inside "traps"):
//   muscle, label
//   weighted, hasSets      weighted sets in the recent window; hasSets is false for 0 (the panel then says there are none)
//   position               "below" | "within" | "above" the default target, or null when there are no sets
//   targetText, positionText, weightedText
//   daysSince, lastTrainedText   whole elapsed days since the latest counted set in the longer window (null when none)
//   trend                  null when both windows are empty, else { current, previous, delta, text }
//   contributors           { primary, secondary }, each up to 5 of { exerciseId, name, sets, weighted, text }, biggest first
//   balance                null for muscles in no pair, else { first, second, ratio, text }
export function buildMuscleDetails({ recent, previous, longer, exercises, now }) {
  if (recent?.breakdown === undefined || longer?.lastAt === undefined) throw new TypeError("recent and longer must be loads made with detail: true");
  const names = new Map((exercises instanceof Map ? [...exercises.values()] : exercises ?? []).map((exercise) => [exercise.id, exercise.name]));
  const values = totalsOf(recent);
  const before = totalsOf(previous);
  const details = {};
  for (const muscle of Object.keys(values)) {
    const folded = muscle === "traps";
    const rows = mergeByExercise(folded ? [...recent.breakdown.traps, ...recent.breakdown.neck] : recent.breakdown[muscle]);
    const times = (folded ? [longer.lastAt.traps, longer.lastAt.neck] : [longer.lastAt[muscle]]).filter((at) => at !== null);
    const lastAt = times.length === 0 ? null : Math.max(...times);
    const weighted = values[muscle];
    const hasSets = weighted > 0;
    const position = !hasSets ? null : weighted < TARGET_RANGE.min ? "below" : weighted > TARGET_RANGE.max ? "above" : "within";
    const delta = Math.round((weighted - before[muscle]) * 100) / 100;
    details[muscle] = {
      muscle,
      label: folded ? "Traps and neck" : formatLabel(muscle),
      weighted,
      hasSets,
      position,
      weightedText: hasSets ? `${fmt(weighted)} weighted sets in the last ${WINDOW_DAYS} days` : `No sets in the last ${WINDOW_DAYS} days`,
      targetText: `Default target: ${TARGET_RANGE.min} to ${TARGET_RANGE.max} weighted sets in ${WINDOW_DAYS} days`,
      positionText: position === null ? null : `${position === "below" ? "Below" : position === "above" ? "Above" : "Within"} the default target`,
      daysSince: lastAt === null ? null : Math.max(0, Math.floor((now - lastAt) / DAY_MS)),
      lastTrainedText: lastTrainedText(lastAt, now),
      trend: weighted === 0 && before[muscle] === 0 ? null : {
        current: weighted,
        previous: before[muscle],
        delta,
        text: `${fmt(weighted)} vs ${fmt(before[muscle])} (${signed(delta)}) sets, last ${WINDOW_DAYS} days vs the ${WINDOW_DAYS} days before`,
      },
      contributors: { primary: topOf(rows, "primary", names), secondary: topOf(rows, "secondary", names) },
      balance: balanceFor(muscle, values),
    };
  }
  return details;
}
