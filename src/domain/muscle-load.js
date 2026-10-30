// Training load per muscle: how many logged sets worked each muscle in a time window. The ONE place this is
// computed; the Body diagram and any UI only display the result. Pure JavaScript: no DOM, no storage, no clock
// (the window comes in as a parameter), and the inputs are only read, never changed.
//
// What counts: a set with isWarmup !== true and a completedAt that parses as a date, with the time in the
// window [start, end): start inclusive, end exclusive, so two windows that meet never count a set twice.
// A set is placed by its own completedAt, not by when its workout started, so a workout that spans midnight
// is split by when each set was done.
//
// Credit: every counted set gives each primary muscle of its exercise the primary credit and each secondary
// muscle its own weight (secondaryWeightOf). A muscle listed as both primary and secondary is credited as primary
// only, once. An exercise is found by its id (exerciseId on the entry), never by name. weighted is the exact sum;
// a view rounds a muscle's total once, at the end (roundToHalf), never per set.
//
// History is joined to muscles here, at read time, from the exercise as it is stored now. Nothing about
// muscles is copied onto entries or sets.

import { ALL_MUSCLES, SECONDARY_WEIGHT_STEPS } from "./model.js";

// The default credit. Contested numbers, so they are a parameter of computeMuscleLoad, changed in one place.
// secondary is the weight of a secondary muscle that has no weight of its own.
export const DEFAULT_CREDIT = Object.freeze({ primary: 1.0, secondary: 0.5 });

// A per-muscle total rounded to the nearest 0.5. Applied once to a total, never to a single set.
export const roundToHalf = (value) => Math.round(value * 2) / 2;

// The weight of one secondary muscle. A default exercise (isCustom false) takes it from the bundled catalog weights
// (defaultWeights, by id), never from its stored copy, so new numbers reach old installs without a rewrite. A custom
// exercise takes it from its own secondaryWeights. A missing or unusable weight is the fallback (credit.secondary).
export function secondaryWeightOf(exercise, muscle, defaultWeights, fallback) {
  const own = exercise.isCustom === true ? exercise.secondaryWeights : defaultWeights?.[exercise.id];
  const weight = own !== null && typeof own === "object" && Object.hasOwn(own, muscle) ? own[muscle] : undefined;
  return SECONDARY_WEIGHT_STEPS.includes(weight) ? weight : fallback;
}

function requireCredit(credit) {
  for (const key of ["primary", "secondary"]) {
    const value = credit?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`credit.${key} must be a finite number of at least 0`);
    }
  }
}

function requireWindow(range) {
  const { start, end } = range ?? {};
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    throw new TypeError("window.start and window.end must be finite numbers (ms)");
  }
  if (start > end) throw new TypeError("window.start must not be after window.end");
}

// ms since the epoch for a stored completedAt, or null if it is missing or not a date.
function timeOf(completedAt) {
  if (typeof completedAt !== "string") return null;
  const ms = Date.parse(completedAt);
  return Number.isNaN(ms) ? null : ms;
}

// workouts:  [{ entries: [{ exerciseId, sets: [{ completedAt, isWarmup }] }] }]  (what store.getWorkoutWithDetails returns)
// exercises: the stored exercises, an array of records or a Map by id
// window:    { start, end } in ms; start inclusive, end exclusive
// credit:    { primary, secondary }
// defaultWeights: { exerciseId: { muscle: weight } } for default exercises (src/catalog/secondary-weights.js)
//
// Returns { muscles, skipped }:
//   muscles  one { weighted, primarySets, secondarySets } for EVERY id in ALL_MUSCLES, zeros included.
//            weighted is the sum of credits. primarySets and secondarySets count SETS, not credits: a set of
//            an exercise with two primary muscles adds 1 to primarySets of each of the two muscles.
//   skipped  unknownExercises { count, ids }: distinct entry exerciseIds that are not stored, whose entry
//            had at least one set that would have counted
//            unknownMuscles { count, items }: distinct { exerciseId, muscle } where the stored exercise lists
//            a muscle that is not in ALL_MUSCLES (it earns no credit)
//            badTimestamps: number of non-warm-up sets with a missing or unparseable completedAt
// Bad data is skipped and reported, never thrown. Only a bad credit or window (a programmer error) throws.
//
// detail (default false): when true the result also has two more keys, worked out in the same loop by the same
// rule, so the detail panel never needs a second counting function. Without it the result is exactly as above.
//   breakdown  { muscleId: [{ exerciseId, role: "primary" | "secondary", sets, weighted }] } for EVERY id in
//              ALL_MUSCLES (an empty list when nothing counted), one entry per exercise and role; the weighted
//              of a muscle's entries adds up to that muscle's weighted
//   lastAt     { muscleId: ms of the latest counted set that gave the muscle a credit above 0, or null }
export function computeMuscleLoad({ workouts, exercises, window: range, credit = DEFAULT_CREDIT, defaultWeights = {}, detail = false }) {
  requireCredit(credit);
  requireWindow(range);
  if (!Array.isArray(workouts)) throw new TypeError("workouts must be an array");
  const byId = exercises instanceof Map ? exercises : new Map((exercises ?? []).map((exercise) => [exercise.id, exercise]));

  const muscles = Object.fromEntries(ALL_MUSCLES.map((id) => [id, { weighted: 0, primarySets: 0, secondarySets: 0 }]));
  const breakdown = detail ? Object.fromEntries(ALL_MUSCLES.map((id) => [id, []])) : null;
  const lastAt = detail ? Object.fromEntries(ALL_MUSCLES.map((id) => [id, null])) : null;
  const unknownExerciseIds = new Set();
  const unknownMuscles = new Map(); // "exerciseId\0muscle" -> { exerciseId, muscle }
  let badTimestamps = 0;

  for (const workout of workouts) {
    for (const entry of workout?.entries ?? []) {
      let counted = 0;
      let latest = -Infinity; // the time of the latest counted set of this entry (only used for lastAt)
      for (const set of entry?.sets ?? []) {
        if (set?.isWarmup === true) continue;
        const at = timeOf(set?.completedAt);
        if (at === null) {
          badTimestamps += 1;
        } else if (at >= range.start && at < range.end) {
          counted += 1;
          if (at > latest) latest = at;
        }
      }
      if (counted === 0) continue;

      const exercise = byId.get(entry.exerciseId);
      if (exercise === undefined) {
        unknownExerciseIds.add(entry.exerciseId);
        continue;
      }
      const primary = new Set();
      const secondary = new Set();
      for (const [list, into] of [[exercise.primaryMuscles, primary], [exercise.secondaryMuscles, secondary]]) {
        for (const muscle of list ?? []) {
          if (Object.hasOwn(muscles, muscle)) into.add(muscle);
          else unknownMuscles.set(`${exercise.id}\0${muscle}`, { exerciseId: exercise.id, muscle });
        }
      }
      const note = (muscle, role, perSet) => {
        if (!detail) return;
        const gain = counted * perSet;
        const found = breakdown[muscle].find((row) => row.exerciseId === exercise.id && row.role === role);
        if (found) {
          found.sets += counted;
          found.weighted += gain;
        } else {
          breakdown[muscle].push({ exerciseId: exercise.id, role, sets: counted, weighted: gain });
        }
        if (perSet > 0 && (lastAt[muscle] === null || latest > lastAt[muscle])) lastAt[muscle] = latest;
      };
      for (const muscle of primary) {
        muscles[muscle].weighted += counted * credit.primary;
        muscles[muscle].primarySets += counted;
        note(muscle, "primary", credit.primary);
      }
      for (const muscle of secondary) {
        if (primary.has(muscle)) continue;
        const weight = secondaryWeightOf(exercise, muscle, defaultWeights, credit.secondary);
        muscles[muscle].weighted += counted * weight;
        muscles[muscle].secondarySets += counted;
        note(muscle, "secondary", weight);
      }
    }
  }

  return {
    muscles,
    skipped: {
      unknownExercises: { count: unknownExerciseIds.size, ids: [...unknownExerciseIds] },
      unknownMuscles: { count: unknownMuscles.size, items: [...unknownMuscles.values()] },
      badTimestamps,
    },
    ...(detail ? { breakdown, lastAt } : {}),
  };
}
