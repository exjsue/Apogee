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
  WEIGHT_UNITS,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
  createTemplate,
} from "../domain/model.js";
import { WORKOUT_META_KEYS, SESSION_CONFLICT, CATALOG_VERSION_META_KEY } from "./schema.js";
import { normalizePlan, emptyPlan } from "../domain/workout-plan.js";
import { requireFreeName } from "../domain/exercise-names.js";

const SCHEMA_KEY = "schemaVersion";
// Settings kept in meta. Meta is not part of exports or imports.
const PREFERRED_UNIT_KEY = "preferredUnit";
const DEFAULT_PREFERRED_UNIT = "lb";
const CONTINUED_WORKOUT_KEY = "continuedWorkoutId";
const SEED_VERSION_KEY = "seedVersion";
const PERSIST_STATUS_KEY = "persistStatus";
// The unchecked sets of the session and the one running rest timer live in meta
// (keys in schema.js), so they are never exported (see src/domain/workout-plan.js).

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

// Runs inside a transaction: removes a workout with all its entries and sets.
async function removeWorkoutTree(tx, workoutId) {
  for (const entry of await tx.getAllByIndex("entries", "workoutId", workoutId)) {
    for (const set of await tx.getAllByIndex("sets", "entryId", entry.id)) {
      await tx.delete("sets", set.id);
    }
    await tx.delete("entries", entry.id);
  }
  await tx.delete("workouts", workoutId);
}

// Runs inside a transaction, before anything is written: refuses the write if the
// plan was changed since the caller read it (another tab, usually). The plan
// carries a revision number, 0 when there is no plan; every session write stores
// the next one. The error has code SESSION_CONFLICT; the logger reads again and
// retries. This is a compare-and-set: a stale copy can never overwrite newer data.
async function checkRevision(tx, expectRev) {
  if (expectRev === undefined) return;
  const stored = await tx.get("meta", WORKOUT_META_KEYS.plan);
  const rev = stored !== undefined && stored.value !== null && Number.isInteger(stored.value.rev) ? stored.value.rev : 0;
  if (rev !== expectRev) {
    const error = new Error("The workout was changed in another tab. Try again.");
    error.code = SESSION_CONFLICT;
    throw error;
  }
}

// Runs inside a transaction: writes the plan and/or the running timer. Each
// value is a record to store, null to delete it, or undefined to leave it alone.
async function applyWorkoutMeta(tx, meta = {}) {
  for (const [name, value] of Object.entries(meta)) {
    const key = WORKOUT_META_KEYS[name];
    if (key === undefined) throw new Error(`unknown workout setting "${name}"`);
    if (value === undefined) continue;
    if (value === null) await tx.delete("meta", key);
    else await tx.put("meta", { key, value });
  }
}

// Runs inside a transaction: every place that can refer to an exercise by id (the list is in DECISIONS.md,
// 2026-10-26): entries of any workout (finished, open or stale), templates, the session's plan in meta (its
// exercises and its rows; normalizePlan lists every row's exercise in exercises) and the conflicts of the catalog
// flag in meta. The running timer refers to a set, whose entry is counted here. Reads only.
async function readExerciseUsage(tx, id) {
  const workoutIds = new Set((await tx.getAll("entries")).filter((entry) => entry.exerciseId === id).map((entry) => entry.workoutId));
  const templates = (await tx.getAll("templates")).filter((template) => template.exercises.some((item) => item.exerciseId === id)).length;
  const planned = normalizePlan((await tx.get("meta", WORKOUT_META_KEYS.plan))?.value).exercises.includes(id);
  const flag = (await tx.get("meta", CATALOG_VERSION_META_KEY))?.value;
  const catalogConflict = flag !== null && typeof flag === "object" && Array.isArray(flag.conflicts) && flag.conflicts.includes(id);
  const used = workoutIds.size > 0 || templates > 0 || planned || catalogConflict;
  return { workouts: workoutIds.size, templates, planned, catalogConflict, used };
}

// Runs inside a transaction: the stored custom exercise with this id, or an error.
async function requireCustom(tx, id) {
  const exercise = await tx.get("exercises", id);
  if (exercise === undefined) throw new Error("That exercise no longer exists");
  if (exercise.isCustom !== true) throw new Error("Only your own exercises can be changed here");
  return exercise;
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
            `This data was saved by a newer version of Apogee (schema ${stored.value}); `
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

  // `meta` ({ plan, timer }) and `expectRev` are for the session: they are written
  // and checked in the same transaction (see checkRevision and applyWorkoutMeta).
  async function saveExercise(input, { meta, expectRev } = {}) {
    const exercise = createExercise(input);
    await adapter.transaction(["exercises", "meta"], "readwrite", async (tx) => {
      await checkRevision(tx, expectRev);
      await tx.put("exercises", exercise);
      await applyWorkoutMeta(tx, meta);
    });
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
  // `meta` ({ plan, timer }) is written, and `expectRev` checked, in the same
  // transaction (see applyWorkoutMeta and checkRevision).
  async function saveWorkoutWithDetails(workoutInput, entryInputs = [], setInputs = [], { meta, expectRev } = {}) {
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

    await adapter.transaction(["workouts", "exercises", "entries", "sets", "meta"], "readwrite", async (tx) => {
      await checkRevision(tx, expectRev);
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
      await applyWorkoutMeta(tx, meta);
    });
    return { workout, entries, sets };
  }

  // Newest first by startedAt.
  async function listWorkouts() {
    const workouts = await adapter.transaction(["workouts"], "readonly", (tx) => tx.getAll("workouts"));
    return workouts.sort(newestFirst);
  }

  // The workout with `entries` (by order), each with its `sets` (by order).
  async function getWorkoutWithDetails(id) {
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
  async function deleteWorkout(id) {
    requireId(id);
    return adapter.transaction(["workouts", "entries", "sets"], "readwrite", async (tx) => {
      const existed = (await tx.get("workouts", id)) !== undefined;
      await removeWorkoutTree(tx, id);
      return existed;
    });
  }

  // Throws away an UNFINISHED workout with all its entries and sets, in ONE
  // transaction. A finished workout is refused (use deleteWorkout for that),
  // so this cannot remove history by accident. Resolves true if it existed.
  async function discardWorkout(id, { meta, expectRev } = {}) {
    requireId(id);
    return adapter.transaction(["workouts", "entries", "sets", "meta"], "readwrite", async (tx) => {
      await checkRevision(tx, expectRev);
      const workout = await tx.get("workouts", id);
      if (workout === undefined) return false;
      if (workout.endedAt !== null) {
        throw new Error("endedAt: a finished workout cannot be discarded; delete it instead");
      }
      await removeWorkoutTree(tx, id);
      await applyWorkoutMeta(tx, meta);
      return true;
    });
  }

  // Deletes one set in ONE transaction. If it was the last set of its entry,
  // the entry is removed too, so no empty entry is left behind.
  // Resolves true if the set existed.
  async function deleteSet(id, { meta, expectRev } = {}) {
    requireId(id);
    return adapter.transaction(["entries", "sets", "meta"], "readwrite", async (tx) => {
      await checkRevision(tx, expectRev);
      const set = await tx.get("sets", id);
      if (set === undefined) return false;
      await tx.delete("sets", id);
      if ((await tx.getAllByIndex("sets", "entryId", set.entryId)).length === 0) {
        await tx.delete("entries", set.entryId);
      }
      await applyWorkoutMeta(tx, meta);
      return true;
    });
  }

  // Every workout, newest first, with how many entries and sets it has,
  // read in one transaction.
  async function listWorkoutSummaries() {
    const { workouts, entries, sets } = await adapter.transaction(
      ["workouts", "entries", "sets"],
      "readonly",
      async (tx) => ({
        workouts: await tx.getAll("workouts"),
        entries: await tx.getAll("entries"),
        sets: await tx.getAll("sets"),
      }),
    );
    const workoutOfEntry = new Map(entries.map((entry) => [entry.id, entry.workoutId]));
    const entryCounts = new Map();
    const setCounts = new Map(); // working sets only: a warm-up is never counted
    const loggedCounts = new Map(); // every set
    for (const entry of entries) entryCounts.set(entry.workoutId, (entryCounts.get(entry.workoutId) ?? 0) + 1);
    for (const set of sets) {
      const workoutId = workoutOfEntry.get(set.entryId);
      loggedCounts.set(workoutId, (loggedCounts.get(workoutId) ?? 0) + 1);
      if (set.isWarmup !== true) setCounts.set(workoutId, (setCounts.get(workoutId) ?? 0) + 1);
    }
    return workouts.sort(newestFirst).map((workout) => ({
      ...workout,
      entryCount: entryCounts.get(workout.id) ?? 0,
      setCount: setCounts.get(workout.id) ?? 0,
      loggedSetCount: loggedCounts.get(workout.id) ?? 0,
    }));
  }

  // Every set of every FINISHED workout (endedAt set), flat, with workoutId and exerciseId joined on from its
  // entry, read in one transaction (the input of src/domain/strength.js). A set whose entry or workout is missing is
  // skipped. Read only: each record is a new object, never a stored one.
  async function listFinishedSetRecords() {
    const { workouts, entries, sets } = await adapter.transaction(
      ["workouts", "entries", "sets"],
      "readonly",
      async (tx) => ({
        workouts: await tx.getAll("workouts"),
        entries: await tx.getAll("entries"),
        sets: await tx.getAll("sets"),
      }),
    );
    const finished = new Set(workouts
      .filter((workout) => workout.endedAt !== null && workout.endedAt !== undefined)
      .map((workout) => workout.id));
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const records = [];
    for (const set of sets) {
      const entry = entryById.get(set.entryId);
      if (entry === undefined || !finished.has(entry.workoutId)) continue;
      const { id, order, reps, weightValue, weightUnit, isWarmup, completedAt } = set;
      records.push({ id, workoutId: entry.workoutId, exerciseId: entry.exerciseId, order, reps, weightValue, weightUnit, isWarmup, completedAt });
    }
    return records;
  }

  // All exercises, alphabetical by name.
  async function listExercises() {
    const exercises = await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"));
    return exercises.sort((a, b) => a.name.localeCompare(b.name) || compareIds(a, b));
  }

  // Adds built-in exercises. Runs only when the stored seedVersion is lower
  // than `version`; then adds the ids that are missing and NEVER overwrites a
  // record that exists. All in one transaction. Resolves { added, skipped }.
  async function seedExercises(exercises, version) {
    if (!Number.isInteger(version) || version < 1) throw new Error("version must be an integer >= 1");
    const seeds = validateAll(exercises, createExercise, "seed exercises");
    requireUniqueIds(seeds, "seed exercises");
    return adapter.transaction(["meta", "exercises"], "readwrite", async (tx) => {
      const stored = await tx.get("meta", SEED_VERSION_KEY);
      if (stored !== undefined && Number.isInteger(stored.value) && stored.value >= version) {
        return { added: 0, skipped: true };
      }
      let added = 0;
      for (const seed of seeds) {
        if ((await tx.get("exercises", seed.id)) === undefined) {
          await tx.put("exercises", seed);
          added += 1;
        }
      }
      await tx.put("meta", { key: SEED_VERSION_KEY, value: version });
      return { added, skipped: false };
    });
  }

  // Saves a template whole (saving one again with the same id replaces it). Every exercise it lists must
  // exist, checked in the same transaction. Templates are not history: nothing else is read or written.
  async function saveTemplate(input) {
    const template = createTemplate(input);
    await adapter.transaction(["exercises", "templates"], "readwrite", async (tx) => {
      for (const [i, { exerciseId }] of template.exercises.entries()) {
        await requireExists(tx, "exercises", exerciseId, `exercises[${i}].exerciseId`, "exercise");
      }
      await tx.put("templates", template);
    });
    return template;
  }

  // All templates, alphabetical by name.
  async function listTemplates() {
    const templates = await adapter.transaction(["templates"], "readonly", (tx) => tx.getAll("templates"));
    return templates.sort((a, b) => a.name.localeCompare(b.name) || compareIds(a, b));
  }

  // Deletes one template. Workouts and exercises are never touched. Resolves true if it existed.
  async function deleteTemplate(id) {
    requireId(id);
    return adapter.transaction(["templates"], "readwrite", async (tx) => {
      const existed = (await tx.get("templates", id)) !== undefined;
      await tx.delete("templates", id);
      return existed;
    });
  }

  // Where one exercise is referred to: { workouts, templates, planned, catalogConflict, used } (see
  // readExerciseUsage). For the wording of the remove question; removeCustomExercise decides again when it writes.
  async function getExerciseUsage(id) {
    requireId(id);
    return adapter.transaction(["entries", "templates", "meta"], "readonly", (tx) => readExerciseUsage(tx, id));
  }

  // Removes one of the user's own exercises: deleted when nothing refers to it, otherwise hidden (retired: true,
  // every other field kept), decided and written in ONE transaction, so nothing can start using it in between.
  // A delete also raises the plan's revision (an empty plan when there is none), so a session write prepared
  // before it is refused (checkRevision) and reads again. Resolves "deleted" or "hidden".
  async function removeCustomExercise(id) {
    requireId(id);
    return adapter.transaction(["exercises", "entries", "templates", "meta"], "readwrite", async (tx) => {
      const exercise = await requireCustom(tx, id);
      if ((await readExerciseUsage(tx, id)).used) {
        if (exercise.retired !== true) await tx.put("exercises", { ...exercise, retired: true });
        return "hidden";
      }
      const stored = (await tx.get("meta", WORKOUT_META_KEYS.plan))?.value;
      const plan = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored : emptyPlan();
      await tx.delete("exercises", id);
      await tx.put("meta", { key: WORKOUT_META_KEYS.plan, value: { ...plan, rev: normalizePlan(stored).rev + 1 } });
      return "deleted";
    });
  }

  // Replaces the name, primary and secondary muscles, equipment tags and secondary weights of one of the user's own
  // exercises (an absent list becomes empty; absent weights are removed, so every secondary counts 0.5); every other
  // field stays, the id included, so the exercise's history stays attached. Read, checked and written in ONE transaction, so
  // an exercise removed or hidden meanwhile is refused, never brought back. The name must not be another stored
  // exercise's (requireFreeName). Resolves the saved record.
  async function updateCustomExercise(id, { name, primaryMuscles, secondaryMuscles, equipmentTags, secondaryWeights } = {}) {
    requireId(id);
    return adapter.transaction(["exercises"], "readwrite", async (tx) => {
      const stored = await requireCustom(tx, id);
      if (stored.retired === true) throw new Error("This exercise is hidden. Show it again before editing it.");
      const next = createExercise({ ...stored, name, primaryMuscles, secondaryMuscles, equipmentTags, secondaryWeights });
      requireFreeName(await tx.getAll("exercises"), next.name, id);
      await tx.put("exercises", next);
      return next;
    });
  }

  // Shows a hidden custom exercise again: only retired changes, to false. Resolves the saved record.
  async function restoreCustomExercise(id) {
    requireId(id);
    return adapter.transaction(["exercises"], "readwrite", async (tx) => {
      const exercise = await requireCustom(tx, id);
      if (exercise.retired !== true) return exercise;
      const next = { ...exercise, retired: false };
      await tx.put("exercises", next);
      return next;
    });
  }

  const readSetting = (key) => adapter.transaction(["meta"], "readonly", async (tx) => (await tx.get("meta", key))?.value);

  // "kg" or "lb". Defaults to "lb" until the user chooses.
  async function getPreferredUnit() {
    const stored = await readSetting(PREFERRED_UNIT_KEY);
    return WEIGHT_UNITS.includes(stored) ? stored : DEFAULT_PREFERRED_UNIT;
  }

  async function setPreferredUnit(unit) {
    if (!WEIGHT_UNITS.includes(unit)) throw new Error('unit must be "kg" or "lb"');
    await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: PREFERRED_UNIT_KEY, value: unit }));
    return unit;
  }

  // The unfinished workout the user chose to Continue, or null.
  async function getContinuedWorkoutId() {
    const stored = await readSetting(CONTINUED_WORKOUT_KEY);
    return typeof stored === "string" && stored !== "" ? stored : null;
  }

  async function setContinuedWorkoutId(id) {
    await adapter.transaction(["meta"], "readwrite", (tx) => (id === null
      ? tx.delete("meta", CONTINUED_WORKOUT_KEY)
      : tx.put("meta", { key: CONTINUED_WORKOUT_KEY, value: requireId(id) })));
    return id;
  }

  // The session's planned sets and the one running rest timer, or null. Raw
  // values: src/domain/workout-plan.js and rest-timer.js decide what they mean.
  const getWorkoutPlan = async () => (await readSetting(WORKOUT_META_KEYS.plan)) ?? null;
  const getRunningTimer = async () => (await readSetting(WORKOUT_META_KEYS.timer)) ?? null;

  // Writes the plan and/or the timer ({ plan, timer }; null deletes, undefined
  // skips). With expectRev, only if the plan has not changed since it was read.
  async function setWorkoutMeta(meta, { expectRev } = {}) {
    await adapter.transaction(["meta"], "readwrite", async (tx) => {
      await checkRevision(tx, expectRev);
      await applyWorkoutMeta(tx, meta);
    });
  }

  // The latest answer from the browser about keeping this app's data, or null
  // if no check has been stored yet. Written on every launch (src/app/persistence.js).
  async function getPersistStatus() {
    return (await readSetting(PERSIST_STATUS_KEY)) ?? null;
  }

  async function setPersistStatus(status) {
    if (typeof status.supported !== "boolean" || typeof status.persisted !== "boolean") {
      throw new Error("supported and persisted must be booleans");
    }
    if (typeof status.checkedAt !== "string" || Number.isNaN(Date.parse(status.checkedAt))) {
      throw new Error("checkedAt must be a valid date");
    }
    const value = {
      supported: status.supported,
      persisted: status.persisted,
      error: typeof status.error === "string" ? status.error : null,
      checkedAt: status.checkedAt,
    };
    await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: PERSIST_STATUS_KEY, value }));
    return value;
  }

  return {
    open,
    close,
    getPersistStatus,
    setPersistStatus,
    getWorkoutPlan,
    getRunningTimer,
    setWorkoutMeta,
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
    listWorkoutSummaries,
    listFinishedSetRecords,
    getWorkoutWithDetails,
    deleteWorkout,
    discardWorkout,
    deleteSet,
    listExercises,
    seedExercises,
    getExerciseUsage,
    removeCustomExercise,
    updateCustomExercise,
    restoreCustomExercise,
    saveTemplate,
    getTemplate: (id) => getOne("templates", id),
    listTemplates,
    deleteTemplate,
    getPreferredUnit,
    setPreferredUnit,
    getContinuedWorkoutId,
    setContinuedWorkoutId,
  };
}
