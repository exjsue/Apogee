// Estimated one-rep max (e1RM) and personal records. Pure JavaScript: no DOM, no storage, no network, no clock.
// Not used by the app yet (nothing imports this file).
//
// Input: a flat list of set records, one per stored set, with the entry's ids joined on by the caller (a stored
// set has no exerciseId or workoutId of its own; they live on its workout entry):
//   { id, workoutId, exerciseId, order, reps, weightValue, weightUnit, isWarmup, completedAt }
// These are the stored field names (src/domain/model.js). Weights are compared exactly as stored and never
// converted. A set is checked (done) when completedAt is a date; an unchecked row has none.
//
// Records are kept per exercise id AND per weight unit, so a kg set never meets an lb set: the data can hold
// both units, and converting would be a guess. A variant has its own exercise id, so variants never mix.

// The formula and its limits, in one place so they can be swapped later.
export const E1RM_MIN_REPS = 1;
export const E1RM_MAX_REPS = 12;
// Epley. The value for one rep is the weight itself (see estimatedOneRepMax).
export const E1RM_FORMULA = (weight, reps) => weight * (1 + reps / 30);

export const PR_TYPES = Object.freeze(["weight", "e1rm", "volume"]);

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

// What each record type measures for a countable set, or null when the set cannot hold that record.
const MEASURES = {
  weight: (set) => (isPositive(set.weightValue) ? set.weightValue : null),
  e1rm: (set) => estimatedOneRepMax(set.weightValue, set.reps),
  volume: (set) => (isPositive(set.weightValue) ? set.weightValue * set.reps : null),
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Time, then set order, then id (plain string comparison, not locale), so the result never depends on input order.
function replayOrder(a, b) {
  return cmp(a.at, b.at) || cmp(a.set.order ?? 0, b.set.order ?? 0) || cmp(String(a.set.id), String(b.set.id));
}

// The sets that each set a new record, in replay order: [{ type, value, exerciseId, weightUnit, setId,
// workoutId, completedAt, weightValue, reps }]. A tie does not set a record, so the earliest keeps it.
export function prHistory(sets) {
  if (!Array.isArray(sets)) throw new TypeError("sets must be an array");
  const counted = sets.filter(isCountableSet).map((set) => ({ set, at: timeOf(set.completedAt) }));
  counted.sort(replayOrder);
  const best = new Map(); // "exerciseId\0unit\0type" -> best value so far
  const history = [];
  for (const { set } of counted) {
    for (const type of PR_TYPES) {
      const value = MEASURES[type](set);
      if (value === null) continue;
      const key = `${set.exerciseId}\0${set.weightUnit}\0${type}`;
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
  return history;
}

// { [exerciseId]: { [weightUnit]: { weight, e1rm, volume } } }, each the record entry from prHistory (or absent
// when that exercise and unit has none of that type).
export function personalRecords(sets) {
  const records = {};
  for (const entry of prHistory(sets)) {
    const { type, ...rest } = entry;
    records[entry.exerciseId] ??= {};
    records[entry.exerciseId][entry.weightUnit] ??= {};
    records[entry.exerciseId][entry.weightUnit][type] = rest; // later entries are strictly better
  }
  return records;
}
