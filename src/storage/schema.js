// Object store and index names shared by both adapters, so they cannot drift apart.

// The name of the app's real IndexedDB database. It is defined here, once, and
// only src/ui/main.js uses it. No test may open or delete a database by this
// name: tests/guard.test.js fails if one tries. Changing this string would make
// the app open an empty database and look as if all data were lost.
export const APP_DB_NAME = "apogee";

export const STORES = {
  exercises: { keyPath: "id" },
  workouts: { keyPath: "id" },
  entries: { keyPath: "id" },
  sets: { keyPath: "id" },
  meta: { keyPath: "key" },
  templates: { keyPath: "id" }, // schema version 4
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

// The key in meta where a later catalog sync records which catalog version it applied. Meta only, never
// exported. Nothing writes it yet; an import deletes it, so the next sync runs again (and a sync must also
// check that the records are there, not trust this key alone).
export const CATALOG_VERSION_META_KEY = "catalogVersion";

// The code of the error a session write throws when the plan changed since it was
// read (see checkRevision in store.js). The logger reads again and retries.
export const SESSION_CONFLICT = "session-conflict";

// The code of the error an edit of a finished workout throws when the stored workout changed since the edit
// started (see checkUnchanged in store.js). Never retried: the user cancels and edits again.
export const WORKOUT_CHANGED = "workout-changed";
