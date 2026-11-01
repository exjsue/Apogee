// The best set of an exercise in one workout (src/domain/best-set.js). Expected values are written out by hand;
// none is computed with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bestSet } from "../src/domain/best-set.js";

const set = (id, reps, weightValue, extra = {}) => ({ id, reps, weightValue, weightUnit: "kg", isWarmup: false, ...extra });
const ids = (result) => (result === null ? null : [result.set.id, result.basis]);

test("best set: the highest estimated one-rep max wins, not the heaviest or the most reps", () => {
  // 5 x 100 -> 116.7, 8 x 80 -> 101.3, 1 x 110 -> 110, 12 x 60 -> 84
  assert.deepEqual(ids(bestSet([set("a", 8, 80), set("b", 5, 100), set("c", 1, 110), set("d", 12, 60)], "kg")), ["b", "e1rm"]);
});

test("best set: a warm-up is never chosen, even when it would win", () => {
  assert.deepEqual(ids(bestSet([set("w", 1, 200, { isWarmup: true }), set("a", 5, 100)], "kg")), ["a", "e1rm"]);
  assert.equal(bestSet([set("w", 5, 100, { isWarmup: true })], "kg"), null);
});

test("best set: sets over 12 reps are not estimated; they are used only when nothing else qualifies, by weight then reps", () => {
  assert.deepEqual(ids(bestSet([set("a", 15, 100), set("b", 5, 60)], "kg")), ["b", "e1rm"]); // b: 70
  assert.deepEqual(ids(bestSet([set("a", 15, 50), set("b", 20, 40)], "kg")), ["a", "heaviest"]);
  assert.deepEqual(ids(bestSet([set("a", 15, 50), set("b", 20, 50)], "kg")), ["b", "heaviest"]); // same weight: more reps
});

test("best set: bodyweight sets have no estimate; the one with the most reps is shown", () => {
  assert.deepEqual(ids(bestSet([set("a", 10, 0), set("b", 14, 0), set("c", 12, 0)], "kg")), ["b", "heaviest"]);
  assert.deepEqual(ids(bestSet([set("a", 10, 0), set("b", 5, 20)], "kg")), ["b", "e1rm"]);
});

test("best set: a tie in the estimate goes to the heavier set, then to the earlier one", () => {
  // 12 x 50 -> 70 and 1 x 70 -> 70
  assert.deepEqual(ids(bestSet([set("a", 12, 50), set("b", 1, 70)], "kg")), ["b", "e1rm"]);
  assert.deepEqual(ids(bestSet([set("b", 1, 70), set("a", 12, 50)], "kg")), ["b", "e1rm"]);
  assert.deepEqual(ids(bestSet([set("x", 5, 100), set("y", 5, 100)], "kg")), ["x", "e1rm"]);
  assert.deepEqual(ids(bestSet([set("y", 5, 100), set("x", 5, 100)], "kg")), ["y", "e1rm"]);
});

test("best set: with only timed sets, the longest working one is shown; a tie goes to the heavier, then the earlier", () => {
  const timed = (id, durationSeconds, weightValue = 0, extra = {}) => ({ id, durationSeconds, weightValue, weightUnit: "kg", isWarmup: false, ...extra });
  assert.deepEqual(ids(bestSet([timed("a", 45), timed("b", 75), timed("w", 200, 0, { isWarmup: true })], "kg")), ["b", "longest"]);
  assert.deepEqual(ids(bestSet([timed("a", 60, 10), timed("b", 60, 20), timed("c", 60, 20)], "kg")), ["b", "longest"]);
  // a set with reps beats any timed set
  assert.deepEqual(ids(bestSet([timed("t", 300), set("r", 3, 50)], "kg")), ["r", "e1rm"]);
});

test("best set: nothing usable gives null", () => {
  assert.equal(bestSet([], "kg"), null);
  assert.equal(bestSet([{ id: "n", weightValue: 20, weightUnit: "kg" }], "kg"), null); // no reps, no duration
  assert.equal(bestSet([set("s", 5, 100, { weightUnit: "st" })], "kg"), null); // a unit the maths does not know
});

test("best set: weights are compared in the chosen unit, and the original set is returned unchanged", () => {
  const kg = set("kg", 5, 100); // 220.5 lb -> 257.3
  const lb = set("lb", 5, 200, { weightUnit: "lb" }); // 233.3
  assert.deepEqual(ids(bestSet([lb, kg], "lb")), ["kg", "e1rm"]);
  assert.deepEqual(ids(bestSet([lb, kg], "kg")), ["kg", "e1rm"]); // 200 lb = 90.7 kg -> 105.8
  const heavyLb = set("heavy", 5, 225, { weightUnit: "lb" }); // 102.1 kg -> 119.1
  assert.deepEqual(ids(bestSet([kg, heavyLb], "kg")), ["heavy", "e1rm"]);
  assert.equal(bestSet([kg, heavyLb], "lb").set, heavyLb);
  assert.equal(heavyLb.weightValue, 225);
});
