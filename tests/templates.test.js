// Templates: the pure rules (createTemplate, templateFromWorkout). Expected values are written out by hand; none
// is computed with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTemplate, TEMPLATE_MAX_EXERCISES, TEMPLATE_MAX_SETS } from "../src/domain/model.js";
import { templateFromWorkout } from "../src/domain/template.js";

// ---- createTemplate: the name ----

const item = (exerciseId, setCount = 3) => ({ exerciseId, setCount });

test("template name: trimmed, every run of whitespace one space; 80 characters (code points) accepted, 81 refused, never cut", () => {
  assert.equal(createTemplate({ id: "t", name: "  Push\t\n  day  ", exercises: [item("a")] }).name, "Push day");
  assert.equal(createTemplate({ id: "t", name: "n".repeat(80), exercises: [item("a")] }).name, "n".repeat(80));
  assert.equal(createTemplate({ id: "t", name: "🏋".repeat(80), exercises: [item("a")] }).name, "🏋".repeat(80)); // 160 UTF-16 units
  assert.equal(createTemplate({ id: "t", name: ` ${"n".repeat(80)}   `, exercises: [item("a")] }).name, "n".repeat(80)); // counted after normalizing
  assert.throws(() => createTemplate({ id: "t", name: "n".repeat(81), exercises: [item("a")] }), /^Error: name must be at most 80 characters$/);
  for (const bad of ["", "   ", "\n\t", undefined, null, 5, ["Push"]]) {
    assert.throws(() => createTemplate({ id: "t", name: bad, exercises: [item("a")] }), /^Error: name must be a non-empty string$/, String(bad));
  }
});

test("template: the record is exactly id, name and exercises; an id is made when none is given; limits are 50 and 50", () => {
  assert.deepEqual(createTemplate({ id: "t", name: "A", exercises: [item("a", 2)], extra: 1, createdAt: "x" }), { id: "t", name: "A", exercises: [{ exerciseId: "a", setCount: 2 }] });
  assert.equal(typeof createTemplate({ name: "A", exercises: [item("a")] }).id, "string");
  assert.deepEqual([TEMPLATE_MAX_EXERCISES, TEMPLATE_MAX_SETS], [50, 50]);
  const fifty = Array.from({ length: 50 }, (_, i) => item(`x${i}`, 50));
  assert.equal(createTemplate({ id: "t", name: "A", exercises: fifty }).exercises.length, 50);
  assert.throws(() => createTemplate({ id: "t", name: "A", exercises: [...fifty, item("y")] }), /at most 50 entries/);
  assert.throws(() => createTemplate({ id: "t", name: "A", exercises: [item("a", 51)] }), /setCount must be at most 50/);
});

// ---- templateFromWorkout ----

const set = (id, extra = {}) => ({ id, entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: 90, completedAt: "2026-10-01T10:00:00.000Z", ...extra });
const finished = (entries) => ({ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "secret notes", entries });
const entry = (id, exerciseId, order, sets) => ({ id, workoutId: "w1", exerciseId, order, supersetGroup: null, notes: "entry notes", sets });

test("templateFromWorkout: exercises in entry order (not list order), one count per entry of its non-warm-up sets", () => {
  const workout = finished([
    entry("e2", "squat", 1, [set("s3"), set("s4")]),
    entry("e1", "bench", 0, [set("s0", { isWarmup: true }), set("s1"), set("s2"), set("s5")]),
  ]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "Day" }), {
    id: "t", name: "Day", exercises: [{ exerciseId: "bench", setCount: 3 }, { exerciseId: "squat", setCount: 2 }],
  });
});

test("templateFromWorkout: an entry with no sets, or only warm-ups, is left out; a workout left with nothing is refused", () => {
  const workout = finished([entry("e1", "a", 0, []), entry("e2", "b", 1, [set("s1", { isWarmup: true })]), entry("e3", "c", 2, [set("s2")])]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "x" }).exercises, [{ exerciseId: "c", setCount: 1 }]);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [])]), { id: "t", name: "x" }), /no working sets/);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [set("w", { isWarmup: true })])]), { id: "t", name: "x" }), /no working sets/);
  assert.throws(() => templateFromWorkout(finished([]), { id: "t", name: "x" }), /no working sets/);
});

test("templateFromWorkout: an exercise with two entries is listed once, where it first appears, with the counts added; over 50 is refused", () => {
  const workout = finished([entry("e1", "a", 0, [set("1")]), entry("e2", "b", 1, [set("2")]), entry("e3", "a", 2, [set("3"), set("4")])]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "x" }).exercises, [{ exerciseId: "a", setCount: 3 }, { exerciseId: "b", setCount: 1 }]);
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => set(`${prefix}${i}`));
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, many(30, "p")), entry("e2", "a", 1, many(21, "q"))]), { id: "t", name: "x" }), /setCount must be at most 50/);
});

test("templateFromWorkout: an unfinished workout is refused, and the name rule applies", () => {
  assert.throws(() => templateFromWorkout({ ...finished([entry("e1", "a", 0, [set("1")])]), endedAt: null }, { id: "t", name: "x" }), /Only a finished workout/);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [set("1")])]), { id: "t", name: "  " }), /name must be a non-empty string/);
  assert.throws(() => templateFromWorkout(null, { name: "x" }), /workout must be a workout/);
});

test("templateFromWorkout: keeps nothing of the workout but exercise ids and counts, and shares no object with it", () => {
  const workout = finished([entry("e1", "a", 0, [set("1"), set("2")])]);
  const template = templateFromWorkout(workout, { id: "t", name: "x" });
  const text = JSON.stringify(template);
  for (const leaked of ["w1", "e1", "secret notes", "entry notes", "100", "kg", "2026", "90"]) assert.ok(!text.includes(leaked), leaked);
  workout.entries[0].exerciseId = "changed";
  workout.entries[0].sets.pop();
  workout.entries.length = 0;
  assert.deepEqual(template, { id: "t", name: "x", exercises: [{ exerciseId: "a", setCount: 2 }] });
});
