// Which exercises a workout used, most recently used first. Pure function, no DOM.

// entries: a workout's entries, each with its `sets` (as store.getWorkoutWithDetails returns them).
// An exercise counts as used only if an entry of it has at least one saved set; an entry with no sets does not.
// Within a workout the exercise with the latest set completion time comes first; sets with no completion time
// rank below dated ones, and ties go to the later entry. Each exercise id appears once. Ids only, never names.
export function exerciseIdsByRecency(entries) {
  const used = entries
    .filter((entry) => entry.sets.length > 0)
    .map((entry) => ({
      id: entry.exerciseId,
      order: entry.order,
      last: entry.sets.reduce((latest, set) => (set.completedAt !== null && set.completedAt > latest ? set.completedAt : latest), ""),
    }));
  used.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : b.order - a.order));
  return [...new Set(used.map((entry) => entry.id))];
}
