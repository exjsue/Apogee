// Editing a finished workout from History: the shared edit rules against the memory adapter, and the pure draft
// rules of src/domain/workout-edit.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { applyWorkoutEdit } from "../src/domain/workout-edit.js";
import { editRules } from "./edit-rules.js";

for (const { name, run } of editRules) {
  test(`edit rules: ${name}`, async () => {
    const adapters = [];
    const createAdapter = () => {
      const adapter = createMemoryAdapter();
      adapters.push(adapter);
      return adapter;
    };
    try {
      await run({ assert, createAdapter });
    } finally {
      for (const adapter of adapters) adapter.close();
    }
  });
}

test("edit draft: a new set after a set that ended the workout moves endedAt with it, one millisecond later", () => {
  const original = {
    workout: { id: "w", startedAt: "2026-10-12T10:00:00.000Z", endedAt: "2026-10-12T10:30:00.000Z", notes: "" },
    entries: [{ id: "e", workoutId: "w", exerciseId: "x", order: 0, supersetGroup: null, notes: "" }],
    sets: [{ id: "s", entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: 180, completedAt: "2026-10-12T10:30:00.000Z" }],
  };
  const date = (() => { const d = new Date(original.workout.startedAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const draft = {
    date,
    entries: [{ id: "e", exerciseId: "x", exerciseName: "X", sets: [
      { id: "s", reps: "5", weight: "100", unit: "kg", isWarmup: false },
      { id: null, reps: "4", weight: "100", unit: "kg", isWarmup: false },
    ] }],
  };
  const { workout, sets } = applyWorkoutEdit(original, draft, { now: new Date("2026-10-20T00:00:00.000Z") });
  assert.equal(sets[1].completedAt, "2026-10-12T10:30:00.001Z");
  assert.equal(workout.endedAt, "2026-10-12T10:30:00.001Z");
  assert.equal(sets[1].restSeconds, null);
  assert.deepEqual(sets[0], original.sets[0]); // an untouched set is written back exactly as stored
  // A set id from another entry is refused, not moved.
  const moved = { ...draft, entries: [{ ...draft.entries[0], id: null, exerciseId: "y" }] };
  assert.throws(() => applyWorkoutEdit(original, moved, { now: new Date("2026-10-20T00:00:00.000Z") }), /that set is not in this exercise/);
});
