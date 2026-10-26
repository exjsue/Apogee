// Strength: e1RM and personal records. Plain objects in, expected values worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedOneRepMax, isCountableSet, personalRecords, prHistory } from "../src/domain/strength.js";

let n = 0;
const set = (extra = {}) => {
  n += 1;
  return {
    id: `s${n}`, workoutId: "w1", exerciseId: "bench", order: 0, reps: 5, weightValue: 100, weightUnit: "kg",
    isWarmup: false, completedAt: "2026-10-20T10:00:00.000Z", ...extra,
  };
};
const day = (d) => `2026-10-${String(d).padStart(2, "0")}T10:00:00.000Z`;

test("e1RM: Epley known values", () => {
  assert.equal(estimatedOneRepMax(100, 5), 100 * (1 + 5 / 30));
  assert.ok(Math.abs(estimatedOneRepMax(100, 5) - 116.6667) < 1e-4);
  assert.ok(Math.abs(estimatedOneRepMax(225, 4) - 255) < 1e-9);
});

test("e1RM: one rep is exactly the weight, 12 reps counts, 13 reps is null", () => {
  assert.equal(estimatedOneRepMax(142.5, 1), 142.5);
  assert.ok(Math.abs(estimatedOneRepMax(100, 12) - 140) < 1e-9);
  assert.equal(estimatedOneRepMax(100, 13), null);
});

test("e1RM: null for reps 0, null, fractional, and for weight 0, null, negative", () => {
  for (const reps of [0, null, undefined, 2.5, -3]) assert.equal(estimatedOneRepMax(100, reps), null);
  for (const weight of [0, null, undefined, -5, NaN]) assert.equal(estimatedOneRepMax(weight, 5), null);
});

test("isCountableSet: warm-ups, unchecked sets and sets with no reps are excluded", () => {
  assert.equal(isCountableSet(set()), true);
  assert.equal(isCountableSet(set({ isWarmup: true })), false);
  assert.equal(isCountableSet(set({ completedAt: null })), false);
  assert.equal(isCountableSet(set({ completedAt: "not a date" })), false);
  assert.equal(isCountableSet(set({ reps: null })), false);
  assert.equal(isCountableSet(set({ reps: 0 })), false);
  assert.equal(isCountableSet(null), false);
});

test("excluded sets never appear in records or history", () => {
  const sets = [set({ isWarmup: true, weightValue: 200 }), set({ completedAt: null, weightValue: 300 }), set({ reps: null })];
  assert.deepEqual(prHistory(sets), []);
  assert.deepEqual(personalRecords(sets), {});
});

test("empty input gives empty results; a non-array throws", () => {
  assert.deepEqual(prHistory([]), []);
  assert.deepEqual(personalRecords([]), {});
  assert.throws(() => personalRecords(null), TypeError);
});

test("records carry the set id, workout id and timestamp", () => {
  const a = set({ id: "A", workoutId: "wA", completedAt: day(21) });
  const r = personalRecords([a]).bench.kg;
  assert.equal(r.weight.setId, "A");
  assert.equal(r.weight.workoutId, "wA");
  assert.equal(r.weight.completedAt, day(21));
  assert.equal(r.weight.value, 100);
  assert.equal(r.volume.value, 500);
});

test("a heavy low-rep set and a lighter high-rep set win different records", () => {
  const heavy = set({ id: "heavy", weightValue: 120, reps: 2, completedAt: day(20) }); // e1RM 128, volume 240
  const light = set({ id: "light", weightValue: 100, reps: 10, completedAt: day(21) }); // e1RM 133.3, volume 1000
  const r = personalRecords([heavy, light]).bench.kg;
  assert.equal(r.weight.setId, "heavy");
  assert.equal(r.e1rm.setId, "light");
  assert.equal(r.volume.setId, "light");
});

test("volume counts sets above 12 reps; e1RM does not", () => {
  const r = personalRecords([set({ weightValue: 50, reps: 20 })]).bench.kg;
  assert.equal(r.volume.value, 1000);
  assert.equal(r.e1rm, undefined);
});

test("a bodyweight set (weight 0) holds no record", () => {
  assert.deepEqual(personalRecords([set({ weightValue: 0, reps: 10 })]), {});
});

test("ties: the earliest keeps the record, whatever the input order", () => {
  const first = set({ id: "first", completedAt: day(20) });
  const second = set({ id: "second", completedAt: day(22) });
  for (const input of [[first, second], [second, first]]) {
    const r = personalRecords(input).bench.kg;
    assert.equal(r.weight.setId, "first");
    assert.equal(r.e1rm.setId, "first");
    assert.equal(r.volume.setId, "first");
  }
  assert.equal(prHistory([first, second]).length, 3);
});

test("equal timestamps: set order decides, then id; the result is the same for any input order", () => {
  const t = day(20);
  const a = set({ id: "b", order: 1, completedAt: t, weightValue: 100 });
  const b = set({ id: "a", order: 1, completedAt: t, weightValue: 100 });
  const c = set({ id: "z", order: 0, completedAt: t, weightValue: 100 });
  const ids = (input) => prHistory(input).filter((e) => e.type === "weight").map((e) => e.setId);
  assert.deepEqual(ids([a, b, c]), ["z"]); // order 0 first; the others only tie it
  assert.deepEqual(ids([c, b, a]), ["z"]);
  const higher = set({ id: "h", order: 2, completedAt: t, weightValue: 110 });
  const p = prHistory([higher, a, b, c]).map((e) => `${e.type}:${e.setId}`);
  assert.deepEqual(p, prHistory([c, a, higher, b]).map((e) => `${e.type}:${e.setId}`));
});

test("replay: a later lighter set is not a PR; a later heavier one is", () => {
  const sets = [
    set({ id: "s1", weightValue: 100, reps: 5, completedAt: day(20) }),
    set({ id: "s2", weightValue: 90, reps: 5, completedAt: day(21) }),
    set({ id: "s3", weightValue: 105, reps: 5, completedAt: day(22) }),
  ];
  const weightPrs = prHistory(sets).filter((e) => e.type === "weight").map((e) => e.setId);
  assert.deepEqual(weightPrs, ["s1", "s3"]);
  assert.equal(personalRecords(sets).bench.kg.weight.setId, "s3");
});

test("two exercise ids are never mixed", () => {
  const r = personalRecords([
    set({ exerciseId: "bench", weightValue: 100 }),
    set({ exerciseId: "bench-close-grip", weightValue: 80 }),
  ]);
  assert.equal(r.bench.kg.weight.value, 100);
  assert.equal(r["bench-close-grip"].kg.weight.value, 80);
  assert.equal(prHistory([set({ exerciseId: "a" }), set({ exerciseId: "b" })]).length, 6);
});

test("kg and lb are never compared or converted", () => {
  const r = personalRecords([
    set({ id: "kg", weightValue: 100, weightUnit: "kg", completedAt: day(20) }),
    set({ id: "lb", weightValue: 150, weightUnit: "lb", completedAt: day(21) }),
  ]).bench;
  assert.equal(r.kg.weight.setId, "kg");
  assert.equal(r.lb.weight.setId, "lb");
  assert.equal(r.lb.weight.value, 150);
});

test("input is not mutated", () => {
  const sets = [set({ completedAt: day(22), weightValue: 90 }), set({ completedAt: day(20), weightValue: 100 })];
  const copy = structuredClone(sets);
  prHistory(sets);
  personalRecords(sets);
  assert.deepEqual(sets, copy);
});
