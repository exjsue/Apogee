// Exercise search. Pure function, no DOM.

import { formatLabel } from "./format.js";

const byName = (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every word of the query must appear in the exercise's name, muscles or
// equipment (case-insensitive). Name matches come first, then the rest, each
// group alphabetical. An empty query returns everything, alphabetically.
export function searchExercises(exercises, query = "") {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...exercises].sort(byName);

  const matches = [];
  for (const exercise of exercises) {
    const name = exercise.name.toLowerCase();
    const other = [...exercise.primaryMuscles, ...exercise.secondaryMuscles, ...exercise.equipmentTags]
      .map((id) => formatLabel(id).toLowerCase())
      .join(" ");
    const everywhere = `${name} ${other}`;
    if (!words.every((word) => everywhere.includes(word))) continue;
    matches.push({ exercise, inName: words.every((word) => name.includes(word)) });
  }
  matches.sort((a, b) => Number(b.inName) - Number(a.inName) || byName(a.exercise, b.exercise));
  return matches.map((match) => match.exercise);
}
