// Estimated one-rep max (e1RM) and personal records. Pure JavaScript: no DOM, no storage, no network, no clock.
// Used by src/app/logger.js (getRecords); not shown in the UI yet.
//
// Input: a flat list of set records, one per stored set, with the entry's ids joined on by the caller (a stored
// set has no exerciseId or workoutId of its own; they live on its workout entry):
//   { id, workoutId, exerciseId, order, reps, weightValue, weightUnit, isWarmup, completedAt }
// These are the stored field names (src/domain/model.js). A set is checked (done) when completedAt is a date;
// an unchecked row has none.
//
// The record functions take a target unit ("kg" or "lb"). Each set's weight is converted to it (stored values are
// never changed), then rounded to 0.1 of that unit before anything is compared. Records are kept per exercise id
// only. A variant has its own exercise id, so variants never mix. A set with weight 0 (bodyweight) can only hold
// the most-reps record.

// The formula and its limits, in one place so they can be swapped later.
export const E1RM_MIN_REPS = 1;
export const E1RM_MAX_REPS = 12;
// Epley. The value for one rep is the weight itself (see estimatedOneRepMax).
export const E1RM_FORMULA = (weight, reps) => weight * (1 + reps / 30);

export const PR_TYPES = Object.freeze(["weight", "e1rm", "volume", "reps"]);

export const KG_PER_LB = 0.45359237; // exact
const UNITS = Object.freeze(["kg", "lb"]);
const round1 = (n) => Math.round(n * 10) / 10;

// The set's weight in the target unit, rounded to 0.1 (a set already in that unit is only rounded).
function weightIn(set, unit) {
  const w = set.weightValue;
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  if (set.weightUnit === unit) return round1(w);
  return round1(unit === "kg" ? w * KG_PER_LB : w / KG_PER_LB);
}

const isPositive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// number, or null outside the limits or without a usable weight
export function estimatedOneRepMax(weight, reps) {
  if (!isPositive(weight) || !Number.isInteger(reps)) return null;
  if (reps < E1RM_MIN_REPS || reps > E1RM_MAX_REPS) return null;
  return reps === 1 ? weight : E1RM_FORMULA(weight, reps);
}

function timeOf(completedAt) {
  if (typeof completedAt !== "string") return null;
  const ms = Date.parse(completedAt);
  return Number.isNaN(ms) ? null : ms;
}

// A working set that was done: not a warm-up, a completedAt that parses, and at least one rep.
export function isCountableSet(set) {
  return set != null && set.isWarmup !== true && timeOf(set.completedAt) !== null
    && typeof set.reps === "number" && Number.isFinite(set.reps) && set.reps > 0;
}

// What each record type measures for a countable set, from its rounded weight w, or null when the set cannot
// hold that record. e1RM and volume are rounded to 0.1 again before they are compared.
const MEASURES = {
  weight: (set, w) => (isPositive(w) ? w : null),
  e1rm: (set, w) => {
    const e = estimatedOneRepMax(w, set.reps);
    return e === null ? null : round1(e);
  },
  volume: (set, w) => (isPositive(w) ? round1(w * set.reps) : null),
  reps: (set) => (set.weightValue === 0 ? set.reps : null), // reps have no unit
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Time, then set order, then id (plain string comparison, not locale), so the result never depends on input order.
function replayOrder(a, b) {
  return cmp(a.at, b.at) || cmp(a.set.order ?? 0, b.set.order ?? 0) || cmp(String(a.set.id), String(b.set.id));
}

// { history, ignored }. history: the sets that each set a new record, in replay order, as [{ type, value,
// exerciseId, weightUnit, setId, workoutId, completedAt, weightValue, reps }]; value is in the target unit
// (rounded to 0.1), weightValue and weightUnit are the stored ones. A tie does not set a record, so the earliest
// keeps it. ignored: how many countable sets were skipped for a missing exerciseId or a weightUnit that is
// not "kg" or "lb".
export function prHistory(sets, unit) {
  if (!Array.isArray(sets)) throw new TypeError("sets must be an array");
  if (!UNITS.includes(unit)) throw new TypeError('unit must be "kg" or "lb"');
  let ignored = 0;
  const counted = [];
  for (const set of sets) {
    if (!isCountableSet(set)) continue;
    if (!set.exerciseId || !UNITS.includes(set.weightUnit)) { ignored += 1; continue; }
    counted.push({ set, at: timeOf(set.completedAt) });
  }
  counted.sort(replayOrder);
  const best = new Map(); // "exerciseId\0type" -> best value so far
  const history = [];
  for (const { set } of counted) {
    const w = weightIn(set, unit);
    for (const type of PR_TYPES) {
      const value = MEASURES[type](set, w);
      if (value === null) continue;
      const key = `${set.exerciseId}\0${type}`;
      if (best.has(key) && value <= best.get(key)) continue;
      best.set(key, value);
      history.push({
        type,
        value,
        exerciseId: set.exerciseId,
        weightUnit: set.weightUnit,
        setId: set.id,
        workoutId: set.workoutId,
        completedAt: set.completedAt,
        weightValue: set.weightValue,
        reps: set.reps,
      });
    }
  }
  return { history, ignored };
}

// { records, ignored }. records: { [exerciseId]: { weight, e1rm, volume, reps } }, each the record entry from
// prHistory (or absent when that exercise has none of that type). ignored is as in prHistory.
export function personalRecords(sets, unit) {
  const { history, ignored } = prHistory(sets, unit);
  const records = {};
  for (const entry of history) {
    const { type, ...rest } = entry;
    records[entry.exerciseId] ??= {};
    records[entry.exerciseId][type] = rest; // later entries are strictly better
  }
  return { records, ignored };
}
