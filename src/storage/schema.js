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

// Keys in meta for the session of the Log tab: the unchecked sets and the one
// running rest timer. Defined here so the store and the importer agree. Meta is
// never exported.
export const WORKOUT_META_KEYS = { plan: "workoutPlan", timer: "runningTimer" };

// The code of the error a session write throws when the plan changed since it was
// read (see checkRevision in store.js). The logger reads again and retries.
export const SESSION_CONFLICT = "session-conflict";
