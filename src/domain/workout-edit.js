// Editing a FINISHED workout from History: the draft the screen edits, and the records it saves. Pure: no DOM,
// no storage. The rules (DECISIONS.md, 2026-10-30): a date edit moves the whole workout by one offset (startedAt,
// endedAt and every set's completedAt) and may not put it in the future; reps, weight and unit are read as
// strictly as live logging reads them; a new set is completed after every existing set; ids never change; an
// exercise left with no sets loses its entry, and a workout left with no sets is refused.

import { createWorkout, createWorkoutEntry, createWorkSet } from "./model.js";
import { parseDecimal, parseWholeNumber } from "./format.js";
import { setNumbers } from "./workout-plan.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (number) => String(number).padStart(2, "0");
const nextOrder = (records) => (records.length === 0 ? 0 : Math.max(...records.map((record) => record.order)) + 1);

// The local calendar date of a timestamp, as an <input type="date"> value ("2026-10-30").
export function localDate(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// What the edit screen starts from: the date, and each entry's sets as typed text. `detail` is the logger's
// getWorkoutDetail (entries with exerciseName and sets).
export function draftFromWorkout(detail) {
  return {
    date: localDate(detail.startedAt),
    entries: detail.entries.map((entry) => ({
      id: entry.id,
      exerciseId: entry.exerciseId,
      exerciseName: entry.exerciseName,
      markCustom: entry.markCustom,
      sets: entry.sets.map((set) => ({
        id: set.id, reps: set.reps === undefined ? "" : String(set.reps), weight: String(set.weightValue), unit: set.weightUnit, isWarmup: set.isWarmup === true,
      })),
    })),
  };
}

// Milliseconds that move `startedAt` to the same local clock time on `date`.
function dateOffset(startedAt, date) {
  const match = typeof date === "string" ? DATE.exec(date) : null;
  const moved = new Date(startedAt);
  if (match !== null) moved.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (match === null || localDate(moved.toISOString()) !== date) throw new Error("Enter a valid date");
  return moved.getTime() - Date.parse(startedAt);
}

const shift = (iso, offset) => (iso === null ? null : new Date(Date.parse(iso) + offset).toISOString());

// The records to save for an edit: { workout, entries, sets }, the workout's complete contents (see
// store.saveWorkoutWithDetails). `original` is the stored workout as { workout, entries, sets }; `draft` has the
// shape of draftFromWorkout, where an entry or set without an id is new. Throws, naming the exercise and set,
// on the first value refused; nothing is half-applied, since nothing is written here.
export function applyWorkoutEdit(original, draft, { now }) {
  const before = original.workout;
  if (before.endedAt === null || before.endedAt === undefined) throw new Error("This workout is still in progress. Finish it before editing it here.");
  const offset = dateOffset(before.startedAt, draft.date);
  let endedAt = shift(before.endedAt, offset);
  const entryById = new Map(original.entries.map((entry) => [entry.id, entry]));
  const setById = new Map(original.sets.map((set) => [set.id, set]));
  const kept = original.sets.map((set) => shift(set.completedAt, offset)).filter((at) => at !== null);
  let latest = Date.parse(kept.reduce((max, at) => (at > max ? at : max), shift(before.startedAt, offset)));

  const entries = [];
  const sets = [];
  let newOrder = nextOrder(original.entries);
  for (const draftEntry of draft.entries) {
    let entry = entryById.get(draftEntry.id);
    if (draftEntry.id !== undefined && draftEntry.id !== null && entry === undefined) throw new Error("That exercise is not in this workout");
    if (entry === undefined) entry = createWorkoutEntry({ workoutId: before.id, exerciseId: draftEntry.exerciseId, order: newOrder++ });
    const own = [];
    const numbers = setNumbers(draftEntry.sets);
    draftEntry.sets.forEach((draftSet, index) => {
      const label = `${draftEntry.exerciseName}, ${numbers[index] === null ? "warm-up set" : `set ${numbers[index]}`}`;
      const stored = setById.get(draftSet.id);
      if (draftSet.id !== undefined && draftSet.id !== null && (stored === undefined || stored.entryId !== entry.id)) {
        throw new Error(`${label}: that set is not in this exercise`);
      }
      try {
        // A stored set with a duration has no reps when its reps are left blank (a timed set); any other set needs them.
        const noReps = stored?.durationSeconds !== undefined && String(draftSet.reps ?? "").trim() === "";
        const fields = {
          reps: noReps ? undefined : parseWholeNumber(draftSet.reps, "reps"),
          weightValue: parseDecimal(draftSet.weight, "weight"),
          weightUnit: draftSet.unit,
          isWarmup: draftSet.isWarmup === true,
        };
        if (stored !== undefined) {
          own.push(createWorkSet({ ...stored, ...fields, completedAt: shift(stored.completedAt, offset) }));
        } else {
          // One millisecond after the latest set, so it sorts after every existing set; the end moves with it if needed.
          latest += 1;
          const completedAt = new Date(latest).toISOString();
          if (completedAt > endedAt) endedAt = completedAt;
          own.push(createWorkSet({ entryId: entry.id, order: nextOrder([...original.sets.filter((set) => set.entryId === entry.id), ...own]), ...fields, completedAt }));
        }
      } catch (error) {
        throw new Error(`${label}: ${error.message}`);
      }
    });
    if (own.length === 0) continue; // an exercise with no sets left loses its entry
    entries.push(entry);
    sets.push(...own);
  }
  if (sets.length === 0) throw new Error("A workout needs at least one set. To remove it, use Delete workout instead.");
  if (Date.parse(endedAt) > now.getTime()) throw new Error("That date is in the future. Choose today or an earlier day.");
  const workout = createWorkout({ ...before, startedAt: shift(before.startedAt, offset), endedAt });
  return { workout, entries, sets };
}
