// Which exercises the Log tab and the history detail mark "Custom" next to the name. Pure: no DOM, no storage.
//
// A custom exercise and a catalog exercise can share a name: the catalog sync stores an entry even when a
// custom already has its name (DECISIONS.md, 2026-10-24). The picker always marks customs. The Log headings
// and the history detail mark a custom only when its name is ambiguous, so the usual screen stays as it was.

// A copy of nameKey in src/domain/builtin.js. It is copied, not imported, so that builtin.js (catalog code)
// stays out of the app's import graph. tests/exercise-names.test.js fails if the two give different keys.
export const nameKey = (name) => name.toLowerCase();

// The code of the error a taken name throws (requireFreeName). When the name is one of the user's hidden exercises
// (custom, retired: true), the error also carries hiddenExerciseId, so the screen can offer to show that one again.
export const NAME_TAKEN = "name-taken";

// Throws unless `name` (already through createExercise) is free: no stored exercise other than `exceptId` has it,
// compared by nameKey. Retired and hidden exercises count: they are still stored and shown in history.
export function requireFreeName(exercises, name, exceptId = null) {
  const clashes = exercises.filter((exercise) => exercise.id !== exceptId && nameKey(exercise.name) === nameKey(name));
  if (clashes.length === 0) return;
  const error = new Error("name: an exercise with this name already exists");
  error.code = NAME_TAKEN;
  const hidden = clashes.find((exercise) => exercise.isCustom === true && exercise.retired === true);
  if (hidden !== undefined) error.hiddenExerciseId = hidden.id;
  throw error;
}

// The ids of the custom exercises whose name, compared by nameKey, is also the name of another stored
// exercise. Retired exercises count: they are still stored and still shown in history.
export function ambiguousCustomIds(exercises) {
  const counts = new Map();
  for (const exercise of exercises) {
    const key = nameKey(exercise.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(exercises
    .filter((exercise) => exercise.isCustom && counts.get(nameKey(exercise.name)) > 1)
    .map((exercise) => exercise.id));
}
