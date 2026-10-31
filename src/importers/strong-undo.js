// Undoing a Strong import from the same CSV file (option C, John 2026-10-31). No DOM, no network, no mapping: the
// workout ids are computed again from the file, and a stored workout is deleted only when its workout record, its
// entries and its sets are exactly what the importer writes for those rows (strong.js builders), for some choice of
// names (skipped, merged) and one weight unit. Entry exercise ids are not compared with anything, only checked to be
// one per name across the file (a known gap: an entry moved to another exercise whose name is in no other workout of
// the file is not seen). Anything else is left alone and reported. Custom exercises the import made
// (strong-exercise-<hash of the name>) are deleted only when nothing else uses them and their name is unchanged.
// Templates, meta (except the plan revision) and every other record are never touched.
//
// prepareStrongUndo runs outside any transaction (it hashes); checkStrongUndo is the dry run (readonly);
// applyStrongUndo classifies again inside one readwrite transaction and refuses everything (throws, so the adapter
// rolls back) when the result is not the dry run that was shown.

import { WEIGHT_UNITS } from "../domain/model.js";
import { nameKey } from "../domain/exercise-names.js";
import { readExerciseUsage, raisePlanRevision } from "../storage/store.js";
import {
  parseStrongCsv, strongWorkoutId, strongExerciseId, strongWorkoutRecord, strongEntryRecord, strongSetRecord,
} from "./strong.js";

// The search for a choice of names that explains a workout stops after this many steps: "could not verify", kept.
export const MAX_STEPS = 100000;

const STORE_NAMES = ["workouts", "entries", "sets", "exercises", "templates", "meta"];
const SKIP = null;

// Records here are flat, so equal fields in any key order is equality.
const canonical = (record) => JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
const same = (a, b) => canonical(a) === canonical(b);

// The file -> { fatal, workouts: [{ id, dateText, nameText, hasError, workout }], names: [{ key, name, exerciseId }] }.
export async function prepareStrongUndo(text) {
  const parsed = parseStrongCsv(text);
  if (parsed.fatal) return { fatal: parsed.fatal, workouts: [], names: [] };
  const workouts = [];
  const names = new Map();
  for (const workout of parsed.workouts) {
    workouts.push({
      id: await strongWorkoutId(workout.dateText, workout.nameText),
      dateText: workout.dateText, nameText: workout.nameText, hasError: workout.hasError, workout,
    });
    for (const row of workout.rows) {
      const key = nameKey(row.exercise);
      if (!names.has(key)) names.set(key, { key, name: row.exercise, exerciseId: await strongExerciseId(key) });
    }
  }
  return { fatal: null, workouts, names: [...names.values()] };
}

class TooManySteps extends Error {}

// Is there a choice of names (each skipped as a whole, or given one entry; entries opened in order of first use)
// under which the stored sets are exactly the rows? -> Map(name key -> entry index | SKIP) or null.
function explain(rows, entries, setsOf, unit, startedIso, budget) {
  const assigned = new Map();
  const used = entries.map(() => 0);
  let opened = 0;
  const consume = (row, e, r) => {
    const j = used[e];
    if (j >= setsOf[e].length) return false;
    let expected;
    try {
      expected = strongSetRecord(row, entries[e].id, j, unit, startedIso);
    } catch {
      return false; // e.g. a weight the model refuses in this unit
    }
    if (!same(expected, setsOf[e][j])) return false;
    used[e] += 1;
    if (step(r + 1)) return true;
    used[e] -= 1;
    return false;
  };
  function step(r) {
    budget.steps += 1;
    if (budget.steps > budget.max) throw new TooManySteps();
    if (r === rows.length) return opened === entries.length && used.every((count, e) => count === setsOf[e].length);
    const row = rows[r];
    const key = nameKey(row.exercise);
    if (assigned.has(key)) {
      const e = assigned.get(key);
      return e === SKIP ? step(r + 1) : consume(row, e, r);
    }
    for (let e = 0; e < opened; e += 1) {
      assigned.set(key, e);
      if (consume(row, e, r)) return true;
    }
    if (opened < entries.length) {
      assigned.set(key, opened);
      opened += 1;
      if (consume(row, opened - 1, r)) return true;
      opened -= 1;
    }
    assigned.set(key, SKIP);
    if (step(r + 1)) return true;
    assigned.delete(key);
    return false;
  }
  return step(0) ? assigned : null;
}

// One workout -> { status: "match", unit, names: Map(key -> exerciseId | SKIP), entries, sets } | { status: "edited",
// reason } | { status: "unverified" }. Synchronous: the reads are done by the caller.
function matchWorkout(item, stored, entries, setsByEntry, maxSteps) {
  let expected;
  try {
    expected = strongWorkoutRecord(item.id, item.workout);
  } catch {
    return { status: "edited", reason: "the workout does not match the file" };
  }
  if (!same(expected, stored)) return { status: "edited", reason: "its date, length, name or notes differ from the file" };
  const ordered = [...entries].sort((a, b) => a.order - b.order);
  const entryOk = ordered.every((entry, position) => {
    try {
      return same(entry, strongEntryRecord(item.id, position, entry.exerciseId));
    } catch {
      return false;
    }
  });
  if (!entryOk || new Set(ordered.map((entry) => entry.exerciseId)).size !== ordered.length) {
    return { status: "edited", reason: "an exercise was added, removed or changed" };
  }
  const setsOf = ordered.map((entry) => [...setsByEntry.get(entry.id)].sort((a, b) => a.order - b.order));
  const startedIso = expected.startedAt;
  const budget = { steps: 0, max: maxSteps };
  try {
    for (const unit of WEIGHT_UNITS) {
      const assigned = explain(item.workout.rows, ordered, setsOf, unit, startedIso, budget);
      if (assigned !== null) {
        const names = new Map([...assigned].map(([key, e]) => [key, e === SKIP ? SKIP : ordered[e].exerciseId]));
        return { status: "match", unit, names, entries: ordered.length, sets: setsOf.reduce((sum, list) => sum + list.length, 0) };
      }
    }
  } catch (error) {
    if (error instanceof TooManySteps) return { status: "unverified" };
    throw error;
  }
  return { status: "edited", reason: "its sets differ from the file" };
}

// Runs inside a transaction; reads only. The full classification and a signature of it.
async function classify(tx, prepared, maxSteps) {
  const report = {
    workouts: { total: prepared.workouts.length, toDelete: [], edited: [], notFound: [], notChecked: [], unverified: [] },
    exercises: { toDelete: [], inUse: [], renamed: [], notCustom: [] },
    totals: { workouts: 0, entries: 0, sets: 0, exercises: 0 },
  };
  const label = (item) => ({ id: item.id, date: item.dateText, name: item.nameText });
  const matches = [];
  for (const item of prepared.workouts) {
    if (item.hasError) { report.workouts.notChecked.push(label(item)); continue; }
    const stored = await tx.get("workouts", item.id);
    if (stored === undefined) { report.workouts.notFound.push(label(item)); continue; }
    const entries = await tx.getAllByIndex("entries", "workoutId", item.id);
    const setsByEntry = new Map();
    for (const entry of entries) setsByEntry.set(entry.id, await tx.getAllByIndex("sets", "entryId", entry.id));
    const result = matchWorkout(item, stored, entries, setsByEntry, maxSteps);
    if (result.status === "match") matches.push({ item, result, entries, setsByEntry });
    else if (result.status === "unverified") report.workouts.unverified.push(label(item));
    else report.workouts.edited.push({ ...label(item), reason: result.reason });
  }
  // One assignment per name across the file: a name skipped in one workout and used in another, or used for two
  // different exercises, means one of them was changed. Every matched workout that uses such a name is kept.
  const seen = new Map();
  for (const { result } of matches) {
    for (const [key, value] of result.names) seen.set(key, [...(seen.get(key) ?? []), value]);
  }
  const mixed = new Set([...seen].filter(([, values]) => new Set(values).size > 1).map(([key]) => key));
  const deleting = [];
  for (const match of matches) {
    const bad = [...match.result.names.keys()].find((key) => mixed.has(key));
    if (bad !== undefined) {
      const name = match.item.workout.rows.find((row) => nameKey(row.exercise) === bad).exercise;
      report.workouts.edited.push({ ...label(match.item), reason: `"${name}" is not the same exercise in every workout of the file` });
      continue;
    }
    deleting.push(match);
    // Names of this workout with no stored sets. A skip at import, or an exercise deleted in History (TODO.md): shown.
    const skippedNames = [...match.result.names.values()].filter((value) => value === SKIP).length;
    report.workouts.toDelete.push({
      ...label(match.item), unit: match.result.unit, entries: match.result.entries, sets: match.result.sets, skippedNames,
    });
    report.totals.workouts += 1;
    report.totals.entries += match.result.entries;
    report.totals.sets += match.result.sets;
  }
  const ignored = new Set(deleting.map((match) => match.item.id));
  for (const { key, name, exerciseId } of prepared.names) {
    const exercise = await tx.get("exercises", exerciseId);
    if (exercise === undefined) continue;
    const entry = { id: exerciseId, name: exercise.name };
    if (exercise.isCustom !== true) { report.exercises.notCustom.push(entry); continue; }
    if (nameKey(exercise.name) !== key) { report.exercises.renamed.push({ ...entry, fileName: name }); continue; }
    const usage = await readExerciseUsage(tx, exerciseId, ignored);
    if (usage.used) { report.exercises.inUse.push({ ...entry, usage }); continue; }
    report.exercises.toDelete.push(entry);
    report.totals.exercises += 1;
  }
  const ids = (list) => list.map((x) => x.id).sort();
  report.signature = JSON.stringify([
    report.workouts.toDelete.map((w) => [w.id, w.skippedNames]).sort(), ids(report.workouts.edited), ids(report.workouts.notFound), ids(report.workouts.notChecked),
    ids(report.workouts.unverified), ids(report.exercises.toDelete), ids(report.exercises.inUse), ids(report.exercises.renamed),
    ids(report.exercises.notCustom),
  ]);
  return { report, deleting };
}

// The dry run: what applyStrongUndo would delete and keep, and why. Writes nothing.
export async function checkStrongUndo(adapter, prepared, { maxSteps = MAX_STEPS } = {}) {
  if (prepared.fatal) throw new Error(`The file cannot be read: ${prepared.fatal}`);
  return adapter.transaction(STORE_NAMES, "readonly", async (tx) => (await classify(tx, prepared, maxSteps)).report);
}

// Deletes what the dry run `shown` (checkStrongUndo's report) listed, in ONE transaction, after classifying again.
// A different result refuses everything. Resolves the report.
export async function applyStrongUndo(adapter, prepared, shown, { maxSteps = MAX_STEPS } = {}) {
  if (prepared.fatal) throw new Error(`The file cannot be read: ${prepared.fatal}`);
  return adapter.transaction(STORE_NAMES, "readwrite", async (tx) => {
    const { report, deleting } = await classify(tx, prepared, maxSteps);
    if (report.signature !== shown?.signature) throw new Error("The data changed since the check; nothing was deleted. Check again.");
    for (const { item, entries, setsByEntry } of deleting) {
      for (const entry of entries) {
        for (const set of setsByEntry.get(entry.id)) await tx.delete("sets", set.id);
        await tx.delete("entries", entry.id);
      }
      await tx.delete("workouts", item.id);
    }
    for (const { id } of report.exercises.toDelete) await tx.delete("exercises", id);
    if (report.exercises.toDelete.length > 0) await raisePlanRevision(tx);
    return report;
  });
}
