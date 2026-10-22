// Object store and index names shared by both adapters, so they cannot drift apart.

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
