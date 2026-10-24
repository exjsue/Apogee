// Planned ("unchecked") sets. Pure: no DOM, no storage.
//
// A planned set is a row the user has added but not checked yet. Planned rows
// are NOT sets: they live in meta (see store.js), never in the sets store, so
// history, counts, exports and imports cannot see them. Checking a row creates
// a real set with the same id; unchecking deletes that set and makes the row
// again.
//
// plan = { exercises: [exerciseId, ...], rows: [row, ...], rev }
//   exercises  the exercises of the session, in the order shown
//   rev        a revision number, raised by every write to the session (see store.js:
//              a write made from an older revision is refused)
//   row        { id, exerciseId, order, reps, weight, unit, restSeconds, isWarmup }
//              reps and weight are the TEXT typed so far (blank allowed);
//              they are parsed strictly only when the row is checked.
//
// A ghost is what an unchecked row would be checked with when a field is left
// blank: shown in the field, never stored (see ghostFor). Checking takes it.

import { WEIGHT_UNITS, convertWeight } from "./model.js";
import { DEFAULT_REST_SECONDS, setPhase, remainingSeconds, fractionRemaining } from "./rest-timer.js";

const UNKNOWN_EXERCISE = "Unknown exercise";

export const emptyPlan = () => ({ exercises: [], rows: [], rev: 0 });

// The same plan with the next revision number: what every session write stores.
export const bumpPlan = (plan) => ({ ...plan, rev: plan.rev + 1 });

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";

function cleanRow(row) {
  if (!isObject(row) || !isText(row.id) || !isText(row.exerciseId)) return null;
  if (!Number.isInteger(row.order) || row.order < 0 || !WEIGHT_UNITS.includes(row.unit)) return null;
  const rest = Number.isInteger(row.restSeconds) && row.restSeconds >= 0 ? row.restSeconds : null;
  return {
    id: row.id,
    exerciseId: row.exerciseId,
    order: row.order,
    reps: typeof row.reps === "string" ? row.reps : row.reps == null ? "" : String(row.reps),
    weight: typeof row.weight === "string" ? row.weight : row.weight == null ? "" : String(row.weight),
    unit: row.unit,
    restSeconds: rest,
    isWarmup: row.isWarmup === true,
  };
}

// The plan as read from storage. Anything malformed is dropped, never thrown on:
// a damaged plan must not keep the Log tab from opening.
export function normalizePlan(value) {
  if (!isObject(value)) return emptyPlan();
  const rows = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value.rows) ? value.rows : []) {
    const row = cleanRow(candidate);
    if (row !== null && !seen.has(row.id)) {
      seen.add(row.id);
      rows.push(row);
    }
  }
  const exercises = [];
  for (const id of [...(Array.isArray(value.exercises) ? value.exercises : []), ...rows.map((row) => row.exerciseId)]) {
    if (isText(id) && !exercises.includes(id)) exercises.push(id);
  }
  const rev = Number.isInteger(value.rev) && value.rev >= 0 ? value.rev : 0;
  return { exercises, rows, rev };
}

export function addRow(plan, row) {
  const clean = cleanRow(row);
  if (clean === null) throw new Error("not a valid planned set");
  if (plan.rows.some((existing) => existing.id === clean.id)) throw new Error("a planned set with this id already exists");
  return {
    exercises: plan.exercises.includes(clean.exerciseId) ? plan.exercises : [...plan.exercises, clean.exerciseId],
    rows: [...plan.rows, clean],
    rev: plan.rev,
  };
}

// Only the fields a user can edit while a row is unchecked.
export function updateRow(plan, id, patch) {
  if (!plan.rows.some((row) => row.id === id)) throw new Error("That set is not planned (it may already be checked)");
  const rows = plan.rows.map((row) => {
    if (row.id !== id) return row;
    const next = { ...row };
    if ("reps" in patch) next.reps = String(patch.reps ?? "");
    if ("weight" in patch) next.weight = String(patch.weight ?? "");
    if ("unit" in patch) {
      if (!WEIGHT_UNITS.includes(patch.unit)) throw new Error('unit must be "kg" or "lb"');
      next.unit = patch.unit;
    }
    if ("restSeconds" in patch) next.restSeconds = patch.restSeconds;
    return next;
  });
  return { ...plan, rows };
}

// Removes a row. The exercise stays in the plan only if it still has a planned
// row or is in `loggedExerciseIds` (it has sets in the workout).
export function removeRow(plan, id, loggedExerciseIds = []) {
  const rows = plan.rows.filter((row) => row.id !== id);
  const keep = new Set([...rows.map((row) => row.exerciseId), ...loggedExerciseIds]);
  return { exercises: plan.exercises.filter((exerciseId) => keep.has(exerciseId)), rows, rev: plan.rev };
}

// Drops planned rows (and exercises) whose exercise no longer exists, for example
// after a backup was imported that does not contain it. An exercise that has
// logged sets stays in the list. Returns the same plan object when nothing changed.
export function pruneOrphans(plan, existingExerciseIds, loggedExerciseIds = []) {
  const exists = (id) => existingExerciseIds.has(id);
  const rows = plan.rows.filter((row) => exists(row.exerciseId));
  const keep = new Set([...rows.map((row) => row.exerciseId), ...loggedExerciseIds]);
  const exercises = plan.exercises.filter((id) => exists(id) || keep.has(id));
  const unchanged = rows.length === plan.rows.length && exercises.length === plan.exercises.length;
  return unchanged ? plan : { exercises, rows, rev: plan.rev };
}

// The next order number for an exercise: after every logged set and planned row.
export function nextOrder(plan, exerciseId, loggedSets) {
  const orders = [
    ...plan.rows.filter((row) => row.exerciseId === exerciseId).map((row) => row.order),
    ...loggedSets.map((set) => set.order),
  ];
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

// A set's rest is its own, else the exercise's default, else 3:00. A stored set with
// no rest (saved before this existed) is only DISPLAYED with the fallback; it is
// never rewritten.
function loggedRow(set, fallback) {
  return {
    kind: "logged",
    id: set.id,
    order: set.order,
    reps: set.reps,
    weight: set.weightValue,
    unit: set.weightUnit,
    isWarmup: set.isWarmup,
    restSeconds: set.restSeconds ?? fallback,
  };
}

// The heaviest set of a list (one exercise in one workout), as ghost text { reps, weight, unit },
// or null if it has none. Warm-ups never count. Weights are compared in kg, so 100 kg beats
// 220 lb; equal weights go to more reps, then to the earlier set (lower order). The weight
// stays in the number and unit it was entered in: it is never converted here.
export function heaviestSet(sets) {
  let best = null;
  let bestKg = 0;
  for (const set of sets) {
    if (set.isWarmup) continue;
    const kg = convertWeight(set.weightValue, set.weightUnit, "kg");
    const better = best === null || kg > bestKg
      || (kg === bestKg && (set.reps > best.reps || (set.reps === best.reps && set.order < best.order)));
    if (better) {
      best = set;
      bestKg = kg;
    }
  }
  return best === null ? null : { reps: String(best.reps), weight: String(best.weightValue), unit: best.weightUnit };
}

const isBlank = (text) => text.trim() === "";

// What a row stands for, as text: a logged set's numbers; for an unchecked row, what
// is typed in each field, else that field's ghost, else blank.
function filledIn(row, ghost) {
  if (row.kind === "logged") return { reps: String(row.reps), weight: String(row.weight), unit: row.unit };
  return {
    reps: isBlank(row.reps) ? (ghost === null ? "" : ghost.reps) : row.reps.trim(),
    weight: isBlank(row.weight) ? (ghost === null ? "" : ghost.weight) : row.weight.trim(),
    unit: isBlank(row.weight) && ghost !== null ? ghost.unit : row.unit,
  };
}

// The ghost of rows[index] (one exercise's rows, in order): { reps, weight, unit } or null.
// Only an unchecked row has one, and only in a field left blank. It copies the row
// directly above (field by field: what is typed there, else that row's own ghost); the
// first row copies lastBest, the heaviest set of the exercise's last session (or null).
// A row above with a weight but no reps gives a ghost with the weight only.
// unit is the unit the ghost's weight was entered in; showing it in another unit is the
// screen's business, and checking stores this number in this unit.
export function ghostFor(rows, index, lastBest = null) {
  const row = rows[index];
  if (row === undefined || row.kind === "logged") return null;
  const source = index === 0 ? lastBest : filledIn(rows[index - 1], ghostFor(rows, index - 1, lastBest));
  if (source === null) return null;
  const reps = isBlank(row.reps) ? source.reps : "";
  const weight = isBlank(row.weight) ? source.weight : "";
  return reps === "" && weight === "" ? null : { reps, weight, unit: source.unit };
}

// Is the ghost the same one? Compares the stored form (number text and unit), never what is shown.
export const sameGhost = (a, b) => (a === null || b === null
  ? a === b
  : a.reps === b.reps && a.weight === b.weight && a.unit === b.unit);

function plannedRow(row, fallback) {
  return { kind: "planned", ...row, restSeconds: row.restSeconds ?? fallback };
}

// What the Log tab shows: one block per exercise, each with its rows in order
// and, for every row that has a timer line, its phase, the seconds to show and
// the fraction of the pie. Warm-up rows have no timer line (hasTimer false).
//   defaults  exerciseId -> that exercise's defaultRestSeconds (null or missing = 3:00)
//   lastBest  exerciseId -> the heaviest set of its last session (heaviestSet), for the first row's ghost
// Every row has a ghost (see ghostFor): null for logged rows.
export function buildExerciseBlocks({ entries, sets, plan, names, timer, nowMs, defaults = new Map(), lastBest = new Map() }) {
  const entryOf = new Map(entries.map((entry) => [entry.exerciseId, entry]));
  const loggedFirst = [...entries].sort((a, b) => a.order - b.order).map((entry) => entry.exerciseId);
  const ids = [...loggedFirst.filter((id) => !plan.exercises.includes(id)), ...plan.exercises];

  return ids.map((exerciseId) => {
    const entry = entryOf.get(exerciseId) ?? null;
    const fallback = defaults.get(exerciseId) ?? DEFAULT_REST_SECONDS;
    const logged = entry === null ? [] : sets.filter((set) => set.entryId === entry.id).map((set) => loggedRow(set, fallback));
    const planned = plan.rows.filter((row) => row.exerciseId === exerciseId).map((row) => plannedRow(row, fallback));
    const ordered = [...logged, ...planned]
      .sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === "logged" ? -1 : 1));
    const rows = ordered
      .map((row, index) => {
        const phase = setPhase({ logged: row.kind === "logged", setId: row.id, timer, nowMs });
        const hasTimer = !row.isWarmup;
        let seconds = 0;
        let fraction = 0;
        if (phase === "template") {
          seconds = row.restSeconds;
          fraction = 1;
        } else if (phase === "resting") {
          seconds = remainingSeconds(timer, nowMs);
          fraction = fractionRemaining(timer, nowMs);
        }
        const ghost = ghostFor(ordered, index, lastBest.get(exerciseId) ?? null);
        return { ...row, phase, hasTimer, seconds, fraction, ghost };
      });
    return {
      exerciseId,
      exerciseName: names.get(exerciseId) ?? UNKNOWN_EXERCISE,
      entryId: entry === null ? null : entry.id,
      defaultRestSeconds: fallback,
      rows,
    };
  });
}
