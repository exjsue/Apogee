// Exercise search. Pure function, no DOM.

import { formatLabel } from "./format.js";

const byName = (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Where an exercise comes from, for ordering: the user's own first, then the built-in lifts, then the catalog.
const tier = (exercise) => (exercise.isCustom ? 0 : exercise.origin === "seed" ? 1 : 2);
const byTierThenName = (a, b) => tier(a) - tier(b) || byName(a, b);

// The search the picker uses.
//   filters.muscle     a muscle id that must be one of the exercise's PRIMARY muscles (null: any)
//   filters.equipment  an equipment tag that must be among the exercise's tags (null: any)
//   filters.includeRetired  false (the default) hides retired entries (catalog ones and the user's hidden
//                          exercises); they still resolve in history
// Returns every match, best first; the screen decides how many to draw. A later search (for example natural
// language) replaces this function and must keep this signature.
//
// Every word of the query must appear in the exercise's name, muscles or equipment (case-insensitive). Name
// matches come first, then the rest; within each group the user's own exercises come first, then the built-in
// lifts, then the catalog, each alphabetical. An empty query returns everything that passes the filters, in that
// order.
export function searchExercises(exercises, query = "", { muscle = null, equipment = null, includeRetired = false } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const pool = exercises.filter((exercise) => (includeRetired || exercise.retired !== true)
    && (muscle === null || exercise.primaryMuscles.includes(muscle))
    && (equipment === null || exercise.equipmentTags.includes(equipment)));
  if (words.length === 0) return pool.sort(byTierThenName);

  const matches = [];
  for (const exercise of pool) {
    const name = exercise.name.toLowerCase();
    const other = [...exercise.primaryMuscles, ...exercise.secondaryMuscles, ...exercise.equipmentTags]
      .map((id) => formatLabel(id).toLowerCase())
      .join(" ");
    const everywhere = `${name} ${other}`;
    if (!words.every((word) => everywhere.includes(word))) continue;
    matches.push({ exercise, inName: words.every((word) => name.includes(word)) });
  }
  matches.sort((a, b) => Number(b.inName) - Number(a.inName) || byTierThenName(a.exercise, b.exercise));
  return matches.map((match) => match.exercise);
}
