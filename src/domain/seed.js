// Built-in exercises, written to the database by store.seedExercises.
// Seeded exercises are ordinary stored records (isCustom: false), so exports
// and imports include them.
//
// Ids are stable forever. To add exercises later, append them and raise
// SEED_VERSION: only ids that are missing are added, and nothing already in
// the database is ever overwritten.

export const SEED_VERSION = 1;

const lift = (id, name, primaryMuscles, secondaryMuscles, equipmentTags) => ({
  id: `seed-${id}`,
  name,
  primaryMuscles,
  secondaryMuscles,
  equipmentTags,
  notes: "",
  isCustom: false,
  defaultRestSeconds: null, // the app default (3:00) until the user sets one
});

export const SEED_EXERCISES = Object.freeze([
  lift("barbell-bench-press", "Barbell bench press", ["chest"], ["front_delts", "triceps"], ["barbell", "bench"]),
  lift("incline-dumbbell-press", "Incline dumbbell press", ["chest", "front_delts"], ["triceps"], ["dumbbell", "bench"]),
  lift("overhead-press", "Overhead press", ["front_delts"], ["side_delts", "triceps", "traps"], ["barbell"]),
  lift("barbell-squat", "Barbell back squat", ["quads", "glutes"], ["adductors", "hamstrings", "lower_back"], ["barbell"]),
  lift("conventional-deadlift", "Conventional deadlift", ["glutes", "hamstrings", "lower_back"], ["traps", "forearms", "lats", "quads"], ["barbell"]),
  lift("romanian-deadlift", "Romanian deadlift", ["hamstrings", "glutes"], ["lower_back", "forearms"], ["barbell"]),
  lift("barbell-row", "Barbell row", ["lats", "upper_back"], ["biceps", "rear_delts", "lower_back", "forearms"], ["barbell"]),
  lift("pull-up", "Pull-up", ["lats"], ["biceps", "upper_back", "forearms"], ["pull_up_bar", "bodyweight"]),
  lift("lat-pulldown", "Lat pulldown", ["lats"], ["biceps", "upper_back"], ["cable"]),
  lift("dumbbell-curl", "Dumbbell curl", ["biceps"], ["forearms"], ["dumbbell"]),
  lift("triceps-pushdown", "Triceps pushdown", ["triceps"], [], ["cable"]),
  lift("dumbbell-lateral-raise", "Dumbbell lateral raise", ["side_delts"], ["traps"], ["dumbbell"]),
  lift("leg-press", "Leg press", ["quads"], ["glutes", "adductors", "hamstrings"], ["machine"]),
  lift("seated-leg-curl", "Seated leg curl", ["hamstrings"], ["calves"], ["machine"]),
  lift("standing-calf-raise", "Standing calf raise", ["calves"], [], ["machine"]),
  lift("hip-thrust", "Barbell hip thrust", ["glutes"], ["hamstrings", "adductors"], ["barbell", "bench"]),
]);
