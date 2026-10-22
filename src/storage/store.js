// Storage rules: validation, referential integrity and transactions.
// Written against the adapter interface below. No IndexedDB code, no DOM.
//
// Adapter interface:
//   open()   -> Promise<void>   idempotent
//   close()  -> void            idempotent; open() may be called again afterwards
//   transaction(storeNames, mode, fn) -> Promise<result of fn>
//     mode is "readonly" or "readwrite". fn(tx) is async and gets a handle:
//       tx.get(store, key)                    -> record | undefined
//       tx.put(store, record)                 -> void
//       tx.delete(store, key)                 -> void
//       tx.clear(store)                       -> void   (removes every record in the store)
//       tx.getAll(store)                      -> record[]
//       tx.getAllByIndex(store, index, value) -> record[]
//     If fn throws or rejects, every write made through tx is rolled back and
//     transaction() rejects with that error.
//
// Why transactions do not close early: an IndexedDB transaction commits by
// itself as soon as it has no pending request when control returns to the
// event loop. So inside every transaction callback below, the only things
// awaited are tx.* calls, one at a time. Validation, sorting and building
// objects are plain synchronous code done before the transaction opens or
// after it closes. Nothing inside a transaction awaits a timer, fetch or any
// other promise.

import {
  SCHEMA_VERSION,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
} from "../domain/model.js";

const SCHEMA_KEY = "schemaVersion";

const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byOrder = (a, b) => a.order - b.order || compareIds(a, b);
// startedAt is always normalized to UTC ISO by the domain model, so plain
// string comparison sorts in time order.
const newestFirst = (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : compareIds(a, b));

function requireId(id, field = "id") {
  if (typeof id !== "string" || id === "") throw new Error(`${field} must be a non-empty string`);
  return id;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

// Validates each item with a domain create function; errors name the item.
function validateAll(items, create, field) {
  return requireArray(items, field).map((item, i) => {
    try {
      return create(item);
    } catch (error) {
      throw new Error(`${field}[${i}]: ${error.message}`);
    }
  });
}

function requireUniqueIds(records, field) {
  const seen = new Set();
  for (const { id } of records) {
    if (seen.has(id)) throw new Error(`${field}: duplicate id "${id}"`);
    seen.add(id);
  }
}

// Runs inside a transaction: the referenced record must already exist.
async function requireExists(tx, storeName, id, field, label) {
  if ((await tx.get(storeName, id)) === undefined) {
    throw new Error(`${field}: no ${label} with id "${id}"`);
  }
}

export function createStore(adapter) {
  // Opens the adapter and checks the stored schema version. Data written by a
  // newer version of the app is never opened, and never modified.
  async function open() {
    await adapter.open();
    try {
      await adapter.transaction(["meta"], "readwrite", async (tx) => {
        const stored = await tx.get("meta", SCHEMA_KEY);
        if (stored === undefined) {
          await tx.put("meta", { key: SCHEMA_KEY, value: SCHEMA_VERSION });
        } else if (!Number.isInteger(stored.value) || stored.value < 1) {
          throw new Error(`Stored schema version is not valid: ${JSON.stringify(stored.value)}`);
        } else if (stored.value > SCHEMA_VERSION) {
          throw new Error(
            `This data was saved by a newer version of GymApp (schema ${stored.value}); `
            + `this version understands schema ${SCHEMA_VERSION}. The data was not changed. Update the app.`,
          );
        }
      });
    } catch (error) {
      adapter.close();
      throw error;
    }
  }

  function close() {
    adapter.close();
  }

  const getOne = (storeName, id) => {
    requireId(id);
    return adapter.transaction([storeName], "readonly", async (tx) => (await tx.get(storeName, id)) ?? null);
  };

  async function saveExercise(input) {
    const exercise = createExercise(input);
    await adapter.transaction(["exercises"], "readwrite", (tx) => tx.put("exercises", exercise));
    return exercise;
  }

  async function saveWorkout(input) {
    const workout = createWorkout(input);
    await adapter.transaction(["workouts"], "readwrite", (tx) => tx.put("workouts", workout));
    return workout;
  }

  async function saveEntry(input) {
    const entry = createWorkoutEntry(input);
    await adapter.transaction(["workouts", "exercises", "entries"], "readwrite", async (tx) => {
      await requireExists(tx, "workouts", entry.workoutId, "workoutId", "workout");
      await requireExists(tx, "exercises", entry.exerciseId, "exerciseId", "exercise");
      await tx.put("entries", entry);
    });
    return entry;
  }

  // Saving a set again with the same id overwrites it.
  async function saveSet(input) {
    const set = createWorkSet(input);
    await adapter.transaction(["entries", "sets"], "readwrite", async (tx) => {
      await requireExists(tx, "entries", set.entryId, "entryId", "entry");
      await tx.put("sets", set);
    });
    return set;
  }

  // Saves a workout with all its entries and sets in ONE transaction: all of
  // it is saved or none of it. The lists are the workout's complete contents:
  // entries and sets already stored for this workout but missing from the
  // lists are deleted in the same transaction.
  async function saveWorkoutWithDetails(workoutInput, entryInputs = [], setInputs = []) {
    const workout = createWorkout(workoutInput);
    const entries = validateAll(entryInputs, createWorkoutEntry, "entries");
    const sets = validateAll(setInputs, createWorkSet, "sets");
    requireUniqueIds(entries, "entries");
    requireUniqueIds(sets, "sets");
    entries.forEach((entry, i) => {
      if (entry.workoutId !== workout.id) {
        throw new Error(`entries[${i}].workoutId must equal the workout's id "${workout.id}"`);
      }
    });
    const entryIds = new Set(entries.map((entry) => entry.id));
    sets.forEach((set, i) => {
      if (!entryIds.has(set.entryId)) {
        throw new Error(`sets[${i}].entryId does not match any entry being saved`);
      }
    });
    const setIds = new Set(sets.map((set) => set.id));

    await adapter.transaction(["workouts", "exercises", "entries", "sets"], "readwrite", async (tx) => {
      const checkedExercises = new Set();
      for (const [i, entry] of entries.entries()) {
        if (checkedExercises.has(entry.exerciseId)) continue;
        await requireExists(tx, "exercises", entry.exerciseId, `entries[${i}].exerciseId`, "exercise");
        checkedExercises.add(entry.exerciseId);
      }
      for (const stored of await tx.getAllByIndex("entries", "workoutId", workout.id)) {
        for (const storedSet of await tx.getAllByIndex("sets", "entryId", stored.id)) {
          if (!setIds.has(storedSet.id)) await tx.delete("sets", storedSet.id);
        }
        if (!entryIds.has(stored.id)) await tx.delete("entries", stored.id);
      }
      await tx.put("workouts", workout);
      for (const entry of entries) await tx.put("entries", entry);
      for (const set of sets) await tx.put("sets", set);
    });
    return { workout, entries, sets };
  }

  // Newest first by startedAt.
  async function listWorkouts() {
    const workouts = await adapter.transaction(["workouts"], "readonly", (tx) => tx.getAll("workouts"));
    return workouts.sort(newestFirst);
  }

  // The workout with `entries` (by order), each with its `sets` (by order).
  function getWorkoutWithDetails(id) {
    requireId(id);
    return adapter.transaction(["workouts", "entries", "sets"], "readonly", async (tx) => {
      const workout = await tx.get("workouts", id);
      if (workout === undefined) return null;
      const entries = (await tx.getAllByIndex("entries", "workoutId", id)).sort(byOrder);
      for (const entry of entries) {
        entry.sets = (await tx.getAllByIndex("sets", "entryId", entry.id)).sort(byOrder);
      }
      return { ...workout, entries };
    });
  }

  // Deletes the workout and all its entries and sets in ONE transaction.
  // Resolves true if the workout existed. Exercises are never touched.
  function deleteWorkout(id) {
    requireId(id);
    return adapter.transaction(["workouts", "entries", "sets"], "readwrite", async (tx) => {
      const existed = (await tx.get("workouts", id)) !== undefined;
      for (const entry of await tx.getAllByIndex("entries", "workoutId", id)) {
        for (const set of await tx.getAllByIndex("sets", "entryId", entry.id)) {
          await tx.delete("sets", set.id);
        }
        await tx.delete("entries", entry.id);
      }
      await tx.delete("workouts", id);
      return existed;
    });
  }

  return {
    open,
    close,
    saveExercise,
    getExercise: (id) => getOne("exercises", id),
    saveWorkout,
    getWorkout: (id) => getOne("workouts", id),
    saveEntry,
    getEntry: (id) => getOne("entries", id),
    saveSet,
    getSet: (id) => getOne("sets", id),
    saveWorkoutWithDetails,
    listWorkouts,
    getWorkoutWithDetails,
    deleteWorkout,
  };
}
