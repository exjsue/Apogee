// Object store and index names shared by both adapters, so they cannot drift apart.

// The name of the app's real IndexedDB database. It is defined here, once, and
// only src/ui/main.js uses it. No test may open or delete a database by this
// name: tests/guard.test.js fails if one tries. Changing this string would make
// the app open an empty database and look as if all data were lost.
export const APP_DB_NAME = "gymapp";

export const STORES = {
  exercises: { keyPath: "id" },
  workouts: { keyPath: "id" },
  entries: { keyPath: "id" },
  sets: { keyPath: "id" },
  meta: { keyPath: "key" },
};

// Index name equals the indexed field name.
export const INDEXES = {
  entries: ["workoutId"],
  sets: ["entryId"],
};
