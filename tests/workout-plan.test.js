import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyPlan, normalizePlan, addRow, updateRow, removeRow, bumpPlan, pruneOrphans, nextOrder, buildExerciseBlocks,
} from "../src/domain/workout-plan.js";
import { startTimer } from "../src/domain/rest-timer.js";

const row = (id, exerciseId, order = 0, extra = {}) => ({
  id, exerciseId, order, reps: "8", weight: "100", unit: "kg", restSeconds: null, isWarmup: false, ...extra,
});
const names = new Map([["bench", "Bench press"], ["squat", "Squat"]]);

test("plan: starts empty, and a damaged plan from storage becomes an empty one without throwing", () => {
  assert.deepEqual(emptyPlan(), { exercises: [], rows: [], rev: 0 });
  for (const bad of [null, undefined, "x", 5, [], { rows: "no" }, { exercises: 7, rows: [null, 3, {}] }]) {
    assert.deepEqual(normalizePlan(bad), { exercises: [], rows: [], rev: 0 }, JSON.stringify(bad));
  }
});

test("plan: normalizePlan keeps good rows, drops bad and duplicate ones, and coerces text", () => {
  const plan = normalizePlan({
    exercises: ["squat", 5, "squat"],
    rows: [
      row("a", "bench"),
      { ...row("b", "squat"), reps: 8, weight: null, restSeconds: -5 },
      row("a", "bench", 3), // duplicate id
      { ...row("c", "bench"), unit: "stone" },
      { ...row("d", "bench"), order: -1 },
    ],
  });
  assert.deepEqual(plan.rows.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(plan.rows[1], { id: "b", exerciseId: "squat", order: 0, reps: "8", weight: "", unit: "kg", restSeconds: null, isWarmup: false });
  assert.deepEqual(plan.exercises, ["squat", "bench"]);
});

test("plan: addRow, updateRow and removeRow return new plans and never change the old one", () => {
  const empty = emptyPlan();
  const one = addRow(empty, row("a", "bench"));
  assert.deepEqual(empty, { exercises: [], rows: [], rev: 0 });
  assert.deepEqual(one.exercises, ["bench"]);
  assert.throws(() => addRow(one, row("a", "bench")), /already exists/);
  assert.throws(() => addRow(one, { id: "x" }), /valid planned set/);
  const edited = updateRow(one, "a", { reps: 10, weight: "62,5", unit: "lb", restSeconds: 90 });
  assert.deepEqual([edited.rows[0].reps, edited.rows[0].weight, edited.rows[0].unit, edited.rows[0].restSeconds], ["10", "62,5", "lb", 90]);
  assert.equal(one.rows[0].reps, "8");
  assert.throws(() => updateRow(one, "nope", { reps: "1" }), /not planned/);
  assert.throws(() => updateRow(one, "a", { unit: "stone" }), /kg/);
  assert.deepEqual(removeRow(one, "a"), { exercises: [], rows: [], rev: 0 });
  assert.deepEqual(removeRow(one, "a", ["bench"]).exercises, ["bench"]); // it still has logged sets
});

test("plan: nextOrder goes after every planned row and logged set of that exercise", () => {
  let plan = emptyPlan();
  assert.equal(nextOrder(plan, "bench", []), 0);
  plan = addRow(addRow(plan, row("a", "bench", 0)), row("b", "squat", 7));
  assert.equal(nextOrder(plan, "bench", []), 1);
  assert.equal(nextOrder(plan, "bench", [{ order: 4 }]), 5);
  assert.equal(nextOrder(plan, "squat", []), 8);
});

test("blocks: rows of an exercise are in order, logged and planned together, with phases and timer lines", () => {
  const entries = [{ id: "e1", exerciseId: "bench", order: 0 }];
  const sets = [
    { id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: 180 },
    { id: "s2", entryId: "e1", order: 1, reps: 8, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null },
    { id: "w1", entryId: "e1", order: 2, reps: 5, weightValue: 40, weightUnit: "kg", isWarmup: true, restSeconds: null },
  ];
  const plan = addRow(emptyPlan(), row("p1", "bench", 3, { restSeconds: 90 }));
  const timer = startTimer({ setId: "s2", nowMs: 0, restSeconds: 100 });
  const [block] = buildExerciseBlocks({ entries, sets, plan, names, timer, nowMs: 25_000 });
  assert.deepEqual([block.exerciseName, block.entryId], ["Bench press", "e1"]);
  assert.deepEqual(block.rows.map((r) => [r.id, r.kind, r.phase, r.hasTimer, r.seconds]), [
    ["s1", "logged", "done", true, 0],
    ["s2", "logged", "resting", true, 75],
    ["w1", "logged", "done", false, 0],
    ["p1", "planned", "template", true, 90],
  ]);
  assert.equal(block.rows[1].fraction, 0.75);
  assert.equal(block.rows[3].fraction, 1);
});

test("blocks: planned-only exercises show, in plan order; unknown exercises are named so", () => {
  let plan = addRow(emptyPlan(), row("a", "squat"));
  plan = addRow(plan, row("b", "bench"));
  plan = addRow(plan, row("c", "mystery"));
  const blocks = buildExerciseBlocks({ entries: [], sets: [], plan, names, timer: null, nowMs: 0 });
  assert.deepEqual(blocks.map((b) => b.exerciseName), ["Squat", "Bench press", "Unknown exercise"]);
  assert.deepEqual(blocks.map((b) => b.entryId), [null, null, null]);
});

test("blocks: a logged exercise that is not in the plan comes first; the plan decides the rest", () => {
  const entries = [{ id: "e1", exerciseId: "bench", order: 0 }];
  const sets = [{ id: "s1", entryId: "e1", order: 0, reps: 5, weightValue: 50, weightUnit: "lb", isWarmup: false, restSeconds: null }];
  const plan = addRow(emptyPlan(), row("a", "squat"));
  const blocks = buildExerciseBlocks({ entries, sets, plan, names, timer: null, nowMs: 0 });
  assert.deepEqual(blocks.map((b) => b.exerciseId), ["bench", "squat"]);
});

test("plan: the revision survives every change, is raised only by bumpPlan, and a bad one reads as 0", () => {
  let plan = normalizePlan({ exercises: [], rows: [], rev: 7 });
  assert.equal(plan.rev, 7);
  plan = addRow(plan, row("a", "bench"));
  plan = updateRow(plan, "a", { reps: "9" });
  assert.equal(plan.rev, 7);
  assert.equal(removeRow(plan, "a").rev, 7);
  assert.equal(bumpPlan(plan).rev, 8);
  assert.equal(plan.rev, 7); // the old plan is unchanged
  for (const bad of [-1, 1.5, "3", null, undefined, NaN]) assert.equal(normalizePlan({ rows: [], rev: bad }).rev, 0);
});

test("plan: pruneOrphans drops rows and exercises that no longer exist, keeps logged ones, and returns the same plan when nothing changed", () => {
  let plan = addRow(addRow(addRow(emptyPlan(), row("a", "bench")), row("b", "ghost")), row("c", "ghost", 1));
  const kept = pruneOrphans(plan, new Set(["bench", "squat"]));
  assert.deepEqual(kept.rows.map((r) => r.id), ["a"]);
  assert.deepEqual(kept.exercises, ["bench"]);
  assert.equal(kept.rev, plan.rev);
  // an exercise with logged sets stays in the list even if it was removed from the library
  assert.deepEqual(pruneOrphans(plan, new Set(["bench"]), ["ghost"]).exercises, ["bench", "ghost"]);
  const clean = addRow(emptyPlan(), row("a", "bench"));
  assert.equal(pruneOrphans(clean, new Set(["bench"])), clean);
});

test("setNumbers: warm-ups take no number; a set with no flag is a working set", async () => {
  const { setNumbers, workingSetCount, ghostFor } = await import("../src/domain/workout-plan.js");
  const sets = [{ isWarmup: true }, {}, { isWarmup: false }, { isWarmup: true }, { isWarmup: undefined }];
  assert.deepEqual(setNumbers(sets), [null, 1, 2, null, 3]);
  assert.equal(workingSetCount(sets), 3);
  // a working row copies the nearest working row above, never a warm-up
  const rows = [
    { kind: "logged", reps: 5, weight: 100, unit: "kg", isWarmup: false },
    { kind: "logged", reps: 5, weight: 40, unit: "kg", isWarmup: true },
    { kind: "planned", reps: "", weight: "", unit: "kg", isWarmup: false },
  ];
  assert.deepEqual(ghostFor(rows, 2, null), { reps: "5", weight: "100", unit: "kg" });
});
