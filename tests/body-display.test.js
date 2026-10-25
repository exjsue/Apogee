// The Body diagram's display rules: the neck folded into the traps, and the shade step of a value.
// Expected values are worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldNeckIntoTraps, intensityStep, INTENSITY_STEPS } from "../src/domain/body-display.js";

test("the neck is added to the traps and has no key of its own afterwards", () => {
  assert.deepEqual(foldNeckIntoTraps({ traps: 3, neck: 2, chest: 1 }), { traps: 5, chest: 1 });
  assert.ok(!("neck" in foldNeckIntoTraps({ traps: 3, neck: 2 })));
});

test("a neck without traps becomes the traps; no neck leaves the map as it was; nothing at all gives traps 0", () => {
  assert.deepEqual(foldNeckIntoTraps({ neck: 2.5, chest: 1 }), { chest: 1, traps: 2.5 });
  assert.deepEqual(foldNeckIntoTraps({ traps: 3, chest: 1 }), { traps: 3, chest: 1 });
  assert.deepEqual(foldNeckIntoTraps({}), { traps: 0 });
});

test("folding does not change the map it is given", () => {
  const values = Object.freeze({ traps: 3, neck: 2 });
  assert.deepEqual(foldNeckIntoTraps(values), { traps: 5 });
  assert.deepEqual({ ...values }, { traps: 3, neck: 2 });
});

test("intensityStep: 0 for nothing, then 1 to 5 rounded up, the reference itself is the top step", () => {
  assert.equal(INTENSITY_STEPS, 5);
  // reference 10: a step is 2 wide, so 0.01 to 2 is step 1, 2.01 to 4 is step 2, and so on
  const steps = (values) => values.map((value) => intensityStep(value, 10));
  assert.deepEqual(steps([0, 0.01, 2, 2.01, 4, 5, 6, 7, 8, 9, 10]), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test("intensityStep: above the reference stays at step 5; a negative value, a missing reference or a non-number gives 0", () => {
  assert.equal(intensityStep(25, 10), 5);
  assert.equal(intensityStep(-3, 10), 0);
  assert.equal(intensityStep(5, 0), 0);
  assert.equal(intensityStep(5, -1), 0);
  assert.equal(intensityStep(undefined, 10), 0);
  assert.equal(intensityStep(NaN, 10), 0);
});
