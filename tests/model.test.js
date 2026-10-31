import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
  convertWeight,
} from "../src/domain/model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("SCHEMA_VERSION is 5 (version 3 added the catalog fields to exercises; version 4 added templates; version 5 added workout name, set rpe and setType)", () => {
  assert.equal(SCHEMA_VERSION, 5);
});

test("createExercise: defaultRestSeconds is null unless given, accepts 0 to 3600, and refuses anything else", () => {
  const base = { name: "Squat", primaryMuscles: ["quads"] };
  assert.equal(createExercise(base).defaultRestSeconds, null);
  assert.equal(createExercise({ ...base, defaultRestSeconds: null }).defaultRestSeconds, null);
  assert.equal(createExercise({ ...base, defaultRestSeconds: 0 }).defaultRestSeconds, 0);
  assert.equal(createExercise({ ...base, defaultRestSeconds: 120 }).defaultRestSeconds, 120);
  assert.equal(createExercise({ ...base, defaultRestSeconds: 3600 }).defaultRestSeconds, 3600);
  for (const bad of [-1, 1.5, 3601, "120", NaN, true]) {
    assert.throws(() => createExercise({ ...base, defaultRestSeconds: bad }), /defaultRestSeconds/, String(bad));
  }
});

test("createExercise: valid input", () => {
  const e = createExercise({
    name: "Bench Press",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps"],
    equipmentTags: ["barbell"],
    notes: "Flat bench",
  });
  assert.match(e.id, UUID);
  assert.equal(e.name, "Bench Press");
  assert.deepEqual(e.primaryMuscles, ["chest"]);
  assert.deepEqual(e.secondaryMuscles, ["triceps"]);
  assert.deepEqual(e.equipmentTags, ["barbell"]);
  assert.equal(e.notes, "Flat bench");
  assert.equal(e.isCustom, false);
});

test("createExercise: defaults and supplied id", () => {
  const e = createExercise({ id: "ex-1", name: "Squat", primaryMuscles: ["quads"], isCustom: true });
  assert.equal(e.id, "ex-1");
  assert.deepEqual(e.primaryMuscles, ["quads"]);
  assert.deepEqual(e.secondaryMuscles, []);
  assert.deepEqual(e.equipmentTags, []);
  assert.equal(e.notes, "");
  assert.equal(e.isCustom, true);
});

test("createExercise: generates a different id each time", () => {
  const input = { name: "A", primaryMuscles: ["abs"] };
  assert.notEqual(createExercise(input).id, createExercise(input).id);
});

test("createExercise: invalid input", () => {
  const base = { name: "A", primaryMuscles: ["abs"] };
  assert.throws(() => createExercise(), /input must be an object/);
  assert.throws(() => createExercise({ primaryMuscles: ["abs"] }), /name must be a non-empty string/);
  assert.throws(() => createExercise({ ...base, name: "  " }), /name/);
  assert.throws(() => createExercise({ ...base, name: 5 }), /name/);
  assert.throws(() => createExercise({ ...base, id: "" }), /id must be a non-empty string/);
  assert.throws(() => createExercise({ ...base, id: 7 }), /id/);
  assert.throws(() => createExercise({ ...base, primaryMuscles: "chest" }), /primaryMuscles/);
  assert.throws(() => createExercise({ ...base, equipmentTags: [""] }), /equipmentTags\[0\]/);
  assert.throws(() => createExercise({ ...base, notes: 1 }), /notes/);
  assert.throws(() => createExercise({ ...base, isCustom: "yes" }), /isCustom/);
});

test("createWorkout: defaults startedAt to now, as a UTC ISO string", () => {
  const w = createWorkout({ now: new Date("2026-10-22T10:00:00.000Z") });
  assert.match(w.id, UUID);
  assert.equal(w.startedAt, "2026-10-22T10:00:00.000Z");
  assert.equal(w.endedAt, null);
  assert.equal(w.notes, "");
});

test("createWorkout: works with no arguments", () => {
  const w = createWorkout();
  assert.match(w.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("createWorkout: normalizes offsets to UTC", () => {
  const w = createWorkout({ startedAt: "2026-10-22T12:00:00+02:00" });
  assert.equal(w.startedAt, "2026-10-22T10:00:00.000Z");
});

test("createWorkout: endedAt equal to or after startedAt is accepted", () => {
  const same = createWorkout({
    startedAt: "2026-10-22T10:00:00Z",
    endedAt: "2026-10-22T10:00:00Z",
  });
  assert.equal(same.endedAt, "2026-10-22T10:00:00.000Z");
  const later = createWorkout({
    startedAt: "2026-10-22T10:00:00Z",
    endedAt: "2026-10-22T11:00:00Z",
    notes: "Push day",
  });
  assert.equal(later.endedAt, "2026-10-22T11:00:00.000Z");
  assert.equal(later.notes, "Push day");
});

test("createWorkout: invalid input", () => {
  assert.throws(
    () => createWorkout({ startedAt: "2026-10-22T10:00:00Z", endedAt: "2026-10-22T09:59:59Z" }),
    /endedAt must not be earlier than startedAt/,
  );
  assert.throws(() => createWorkout({ startedAt: "yesterday" }), /startedAt/);
  assert.throws(() => createWorkout({ startedAt: "2026-10-22" }), /startedAt/);
  assert.throws(() => createWorkout({ startedAt: "2026-13-45T10:00:00Z" }), /startedAt/);
  assert.throws(() => createWorkout({ startedAt: 123 }), /startedAt/);
  assert.throws(() => createWorkout({ endedAt: "nope" }), /endedAt/);
  assert.throws(() => createWorkout({ id: "" }), /id/);
  assert.throws(() => createWorkout({ notes: 4 }), /notes/);
  assert.throws(() => createWorkout(null), /input must be an object/);
});

test("createWorkoutEntry: valid input", () => {
  const e = createWorkoutEntry({ workoutId: "w1", exerciseId: "ex1", order: 0 });
  assert.match(e.id, UUID);
  assert.equal(e.workoutId, "w1");
  assert.equal(e.exerciseId, "ex1");
  assert.equal(e.order, 0);
  assert.equal(e.supersetGroup, null);
  assert.equal(e.notes, "");
  const s = createWorkoutEntry({
    id: "e1", workoutId: "w1", exerciseId: "ex1", order: 2, supersetGroup: "A", notes: "slow",
  });
  assert.equal(s.id, "e1");
  assert.equal(s.supersetGroup, "A");
});

test("createWorkoutEntry: invalid input", () => {
  const ok = { workoutId: "w1", exerciseId: "ex1", order: 0 };
  assert.throws(() => createWorkoutEntry({ ...ok, workoutId: "" }), /workoutId/);
  assert.throws(() => createWorkoutEntry({ ...ok, exerciseId: undefined }), /exerciseId/);
  assert.throws(() => createWorkoutEntry({ ...ok, order: -1 }), /order/);
  assert.throws(() => createWorkoutEntry({ ...ok, order: 1.5 }), /order/);
  assert.throws(() => createWorkoutEntry({ ...ok, order: "1" }), /order/);
  assert.throws(() => createWorkoutEntry({ ...ok, supersetGroup: "" }), /supersetGroup/);
  assert.throws(() => createWorkoutEntry({ ...ok, supersetGroup: 1 }), /supersetGroup/);
  assert.throws(() => createWorkoutEntry({ ...ok, notes: false }), /notes/);
});

const validSet = { entryId: "e1", order: 0, reps: 5, weightValue: 135, weightUnit: "lb" };

test("createWorkSet: valid input, weight stored exactly as entered", () => {
  const s = createWorkSet(validSet);
  assert.match(s.id, UUID);
  assert.equal(s.entryId, "e1");
  assert.equal(s.order, 0);
  assert.equal(s.reps, 5);
  assert.equal(s.weightValue, 135);
  assert.equal(s.weightUnit, "lb");
  assert.equal(s.isWarmup, false);
  assert.equal(s.restSeconds, null);
  assert.equal(s.completedAt, null);
});

test("createWorkSet: optional fields", () => {
  const s = createWorkSet({
    ...validSet,
    weightValue: 62.5,
    weightUnit: "kg",
    isWarmup: true,
    restSeconds: 90,
    completedAt: "2026-10-22T10:05:00Z",
  });
  assert.equal(s.weightValue, 62.5);
  assert.equal(s.weightUnit, "kg");
  assert.equal(s.isWarmup, true);
  assert.equal(s.restSeconds, 90);
  assert.equal(s.completedAt, "2026-10-22T10:05:00.000Z");
});

test("createWorkSet: 0 means bodyweight, and restSeconds 0 is allowed", () => {
  const s = createWorkSet({ ...validSet, weightValue: 0, restSeconds: 0 });
  assert.equal(s.weightValue, 0);
  assert.equal(s.restSeconds, 0);
});

test("createWorkSet: invalid reps, each with its own message", () => {
  assert.throws(() => createWorkSet({ ...validSet, reps: 0 }), /^Error: reps must be at least 1$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: -3 }), /^Error: reps can't be negative$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: 1.5 }), /^Error: reps must be a whole number$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: 2.5 }), /^Error: reps must be a whole number$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: "5" }), /^Error: reps must be a whole number$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: NaN }), /^Error: reps must be a whole number$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: undefined }), /^Error: reps must be a whole number$/);
  assert.throws(() => createWorkSet({ ...validSet, reps: -Infinity }), /^Error: reps can't be negative$/);
});

test("createWorkSet: invalid weight, each with its own message", () => {
  assert.throws(() => createWorkSet({ ...validSet, weightValue: -1 }), /^Error: weight can't be negative$/);
  assert.throws(() => createWorkSet({ ...validSet, weightValue: -Infinity }), /^Error: weight can't be negative$/);
  assert.throws(() => createWorkSet({ ...validSet, weightValue: NaN }), /^Error: weight must be a number$/);
  assert.throws(() => createWorkSet({ ...validSet, weightValue: "135" }), /^Error: weight must be a number$/);
  assert.throws(() => createWorkSet({ ...validSet, weightValue: undefined }), /^Error: weight must be a number$/);
  assert.throws(() => createWorkSet({ ...validSet, weightValue: Infinity, weightUnit: "kg" }), /^Error: weight is above the maximum of 2500 kg$/);
});

test("createWorkSet: invalid weightUnit", () => {
  assert.throws(() => createWorkSet({ ...validSet, weightUnit: "kgs" }), /weightUnit must be "kg" or "lb"/);
  assert.throws(() => createWorkSet({ ...validSet, weightUnit: "KG" }), /weightUnit/);
  assert.throws(() => createWorkSet({ ...validSet, weightUnit: "LB" }), /weightUnit/);
  assert.throws(() => createWorkSet({ ...validSet, weightUnit: "lbs" }), /weightUnit/);
  assert.throws(() => createWorkSet({ ...validSet, weightUnit: undefined }), /weightUnit/);
});

test("createWorkSet: invalid restSeconds", () => {
  assert.throws(() => createWorkSet({ ...validSet, restSeconds: -1 }), /restSeconds must be an integer >= 0/);
  assert.throws(() => createWorkSet({ ...validSet, restSeconds: 1.5 }), /restSeconds/);
  assert.throws(() => createWorkSet({ ...validSet, restSeconds: "60" }), /restSeconds/);
  assert.throws(() => createWorkSet({ ...validSet, restSeconds: NaN }), /restSeconds/);
});

test("createWorkSet: other invalid input", () => {
  assert.throws(() => createWorkSet({ ...validSet, entryId: "" }), /entryId/);
  assert.throws(() => createWorkSet({ ...validSet, order: -1 }), /order/);
  assert.throws(() => createWorkSet({ ...validSet, isWarmup: 1 }), /isWarmup/);
  assert.throws(() => createWorkSet({ ...validSet, completedAt: "later" }), /completedAt/);
  assert.throws(() => createWorkSet({ ...validSet, id: "" }), /id/);
  assert.throws(() => createWorkSet(), /input must be an object/);
});

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("convertWeight: known values", () => {
  close(convertWeight(1, "lb", "kg"), 0.45359237, 1e-12);
  close(convertWeight(1, "kg", "lb"), 1 / 0.45359237, 1e-9);
  close(convertWeight(100, "kg", "lb"), 220.46226218, 1e-6);
  close(convertWeight(135, "lb", "kg"), 61.2349, 1e-4);
});

test("convertWeight: same unit returns the value unchanged", () => {
  assert.equal(convertWeight(135, "lb", "lb"), 135);
  assert.equal(convertWeight(62.5, "kg", "kg"), 62.5);
});

test("convertWeight: zero stays zero", () => {
  assert.equal(convertWeight(0, "kg", "lb"), 0);
  assert.equal(convertWeight(0, "lb", "kg"), 0);
});

test("convertWeight: round trips", () => {
  for (const value of [0, 2.5, 45, 100, 135, 225, 315.5, 1000]) {
    close(convertWeight(convertWeight(value, "lb", "kg"), "kg", "lb"), value);
    close(convertWeight(convertWeight(value, "kg", "lb"), "lb", "kg"), value);
  }
});

test("convertWeight: does not round", () => {
  assert.notEqual(convertWeight(135, "lb", "kg"), 61.23);
  assert.notEqual(convertWeight(100, "kg", "lb"), 220.46);
});

test("convertWeight: invalid input", () => {
  assert.throws(() => convertWeight(NaN, "kg", "lb"), /value/);
  assert.throws(() => convertWeight(Infinity, "kg", "lb"), /value/);
  assert.throws(() => convertWeight("10", "kg", "lb"), /value/);
  assert.throws(() => convertWeight(10, "stone", "lb"), /fromUnit/);
  assert.throws(() => convertWeight(10, "kg", "oz"), /toUnit/);
});
