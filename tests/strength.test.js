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
  assert.deepEqual(prHistory(sets, "kg").history, []);
  assert.deepEqual(personalRecords(sets, "kg").records, {});
});

test("empty input gives empty results; a non-array throws", () => {
  assert.deepEqual(prHistory([], "kg").history, []);
  assert.deepEqual(personalRecords([], "kg").records, {});
  assert.throws(() => personalRecords(null, "kg"), TypeError);
});

test("records carry the set id, workout id and timestamp", () => {
  const a = set({ id: "A", workoutId: "wA", completedAt: day(21) });
  const r = personalRecords([a], "kg").records.bench;
  assert.equal(r.weight.setId, "A");
  assert.equal(r.weight.workoutId, "wA");
  assert.equal(r.weight.completedAt, day(21));
  assert.equal(r.weight.value, 100);
  assert.equal(r.volume.value, 500);
});

test("a heavy low-rep set and a lighter high-rep set win different records", () => {
  const heavy = set({ id: "heavy", weightValue: 120, reps: 2, completedAt: day(20) }); // e1RM 128, volume 240
  const light = set({ id: "light", weightValue: 100, reps: 10, completedAt: day(21) }); // e1RM 133.3, volume 1000
  const r = personalRecords([heavy, light], "kg").records.bench;
  assert.equal(r.weight.setId, "heavy");
  assert.equal(r.e1rm.setId, "light");
  assert.equal(r.volume.setId, "light");
});

test("volume counts sets above 12 reps; e1RM does not", () => {
  const r = personalRecords([set({ weightValue: 50, reps: 20 })], "kg").records.bench;
  assert.equal(r.volume.value, 1000);
  assert.equal(r.e1rm, undefined);
});

test("a bodyweight set (weight 0) holds no weight, e1RM or volume record", () => {
  const r = personalRecords([set({ weightValue: 0, reps: 10 })], "kg").records.bench;
  assert.deepEqual(Object.keys(r), ["reps"]); // the reps record is new; see the tests below
});

test("ties: the earliest keeps the record, whatever the input order", () => {
  const first = set({ id: "first", completedAt: day(20) });
  const second = set({ id: "second", completedAt: day(22) });
  for (const input of [[first, second], [second, first]]) {
    const r = personalRecords(input, "kg").records.bench;
    assert.equal(r.weight.setId, "first");
    assert.equal(r.e1rm.setId, "first");
    assert.equal(r.volume.setId, "first");
  }
  assert.equal(prHistory([first, second], "kg").history.length, 3);
});

test("equal timestamps: set order decides, then id; the result is the same for any input order", () => {
  const t = day(20);
  const a = set({ id: "b", order: 1, completedAt: t, weightValue: 100 });
  const b = set({ id: "a", order: 1, completedAt: t, weightValue: 100 });
  const c = set({ id: "z", order: 0, completedAt: t, weightValue: 100 });
  const ids = (input) => prHistory(input, "kg").history.filter((e) => e.type === "weight").map((e) => e.setId);
  assert.deepEqual(ids([a, b, c]), ["z"]); // order 0 first; the others only tie it
  assert.deepEqual(ids([c, b, a]), ["z"]);
  const higher = set({ id: "h", order: 2, completedAt: t, weightValue: 110 });
  const p = prHistory([higher, a, b, c], "kg").history.map((e) => `${e.type}:${e.setId}`);
  assert.deepEqual(p, prHistory([c, a, higher, b], "kg").history.map((e) => `${e.type}:${e.setId}`));
});

test("replay: a later lighter set is not a PR; a later heavier one is", () => {
  const sets = [
    set({ id: "s1", weightValue: 100, reps: 5, completedAt: day(20) }),
    set({ id: "s2", weightValue: 90, reps: 5, completedAt: day(21) }),
    set({ id: "s3", weightValue: 105, reps: 5, completedAt: day(22) }),
  ];
  const weightPrs = prHistory(sets, "kg").history.filter((e) => e.type === "weight").map((e) => e.setId);
  assert.deepEqual(weightPrs, ["s1", "s3"]);
  assert.equal(personalRecords(sets, "kg").records.bench.weight.setId, "s3");
});

test("two exercise ids are never mixed", () => {
  const { records: r } = personalRecords([
    set({ exerciseId: "bench", weightValue: 100 }),
    set({ exerciseId: "bench-close-grip", weightValue: 80 }),
  ], "kg");
  assert.equal(r.bench.weight.value, 100);
  assert.equal(r["bench-close-grip"].weight.value, 80);
  assert.equal(prHistory([set({ exerciseId: "a" }), set({ exerciseId: "b" })], "kg").history.length, 6);
});

test("conversion: lb sets are converted to the target unit and rounded to 0.1", () => {
  const lb = set({ id: "lb", weightValue: 225, weightUnit: "lb", reps: 5 });
  const kg = personalRecords([lb], "kg").records.bench; // 225 x 0.45359237 = 102.0582..., so 102.1
  assert.equal(kg.weight.value, 102.1);
  assert.equal(kg.volume.value, 510.5); // 102.1 x 5
  assert.equal(kg.e1rm.value, 119.1); // 102.1 x (1 + 5/30) = 119.0833
  assert.equal(kg.weight.weightValue, 225); // the stored value and unit are reported untouched
  assert.equal(kg.weight.weightUnit, "lb");
  const back = personalRecords([set({ weightValue: 100, weightUnit: "kg" })], "lb").records.bench; // 220.46226
  assert.equal(back.weight.value, 220.5);
  const same = personalRecords([set({ weightValue: 102.26, weightUnit: "kg" })], "kg").records.bench;
  assert.equal(same.weight.value, 102.3); // already in the target unit: only rounded
});

test("100 kg and 220.5 lb are a tie in kg; the earliest keeps the record", () => {
  const kg = set({ id: "kg", weightValue: 100, weightUnit: "kg", completedAt: day(20) });
  const lb = set({ id: "lb", weightValue: 220.5, weightUnit: "lb", completedAt: day(21) }); // 100.0 after rounding
  for (const input of [[kg, lb], [lb, kg]]) {
    const r = personalRecords(input, "kg").records.bench;
    assert.equal(r.weight.setId, "kg");
    assert.equal(r.volume.setId, "kg");
  }
  const earlierLb = { ...lb, completedAt: day(19) };
  assert.equal(personalRecords([kg, earlierLb], "kg").records.bench.weight.setId, "lb");
});

test("rounding happens before comparing: a difference under 0.05 is a tie", () => {
  const a = set({ id: "a", weightValue: 100.04, completedAt: day(20) });
  const b = set({ id: "b", weightValue: 100.06, completedAt: day(21) }); // 100.1: a real improvement
  const r = personalRecords([a, b], "kg").records.bench;
  assert.equal(r.weight.setId, "b");
  const c = set({ id: "c", weightValue: 99.96, completedAt: day(22) }); // 100.0, ties a
  assert.equal(personalRecords([a, c], "kg").records.bench.weight.setId, "a");
});

test("the reps record: most reps in one set, weight-0 sets only, earliest keeps a tie", () => {
  const sets = [
    set({ id: "r1", weightValue: 0, reps: 10, completedAt: day(20) }),
    set({ id: "r2", weightValue: 0, reps: 15, completedAt: day(21) }),
    set({ id: "r3", weightValue: 0, reps: 15, completedAt: day(22) }),
    set({ id: "heavy", weightValue: 20, reps: 30, completedAt: day(23) }), // weight above 0: no reps record
  ];
  const r = personalRecords(sets, "kg").records.bench;
  assert.equal(r.reps.setId, "r2");
  assert.equal(r.reps.value, 15);
  assert.equal(personalRecords(sets, "lb").records.bench.reps.value, 15); // reps have no unit
  assert.deepEqual(prHistory(sets, "kg").history.filter((e) => e.type === "reps").map((e) => e.setId), ["r1", "r2"]);
  assert.equal(personalRecords([sets[3]], "kg").records.bench.reps, undefined);
});

test("bodyweight sets: no weight, e1RM or volume; unit does not matter; warm-ups still excluded", () => {
  const sets = [
    set({ id: "bw", weightValue: 0, weightUnit: "lb", reps: 12 }),
    set({ id: "warm", weightValue: 0, reps: 30, isWarmup: true }),
  ];
  const { records, ignored } = personalRecords(sets, "kg");
  assert.deepEqual(Object.keys(records.bench), ["reps"]);
  assert.equal(records.bench.reps.setId, "bw");
  assert.equal(ignored, 0);
});

test("ignored sets: a missing exerciseId or a unit that is not kg or lb, counted", () => {
  const good = set({ id: "good" });
  const sets = [
    good,
    set({ exerciseId: null }),
    set({ exerciseId: undefined }),
    set({ exerciseId: "" }),
    set({ weightUnit: "stone" }),
    set({ weightUnit: undefined }),
    set({ weightUnit: "KG" }),
    set({ weightUnit: "bogus", isWarmup: true }), // not countable anyway: not counted as ignored
  ];
  const { records, ignored } = personalRecords(sets, "kg");
  assert.equal(ignored, 6);
  assert.deepEqual(Object.keys(records), ["bench"]);
  assert.equal(records.bench.weight.setId, "good");
  const h = prHistory(sets, "lb");
  assert.equal(h.ignored, 6);
  assert.ok(h.history.every((e) => e.setId === "good"));
  assert.equal(personalRecords([good], "kg").ignored, 0);
});

test("a target unit that is not kg or lb throws", () => {
  assert.throws(() => personalRecords([set()], "stone"), TypeError);
  assert.throws(() => prHistory([set()]), TypeError);
});

test("input is not mutated", () => {
  const sets = [set({ completedAt: day(22), weightValue: 90 }), set({ completedAt: day(20), weightValue: 100, weightUnit: "lb" })];
  const copy = structuredClone(sets);
  prHistory(sets, "kg");
  personalRecords(sets, "lb");
  assert.deepEqual(sets, copy);
});

test("timing: 25,000 sets finish in under 2000 ms", () => {
  const sets = [];
  for (let i = 0; i < 25000; i += 1) {
    sets.push(set({
      id: `t${i}`, exerciseId: `ex${i % 40}`, weightValue: 20 + (i * 7919) % 2000 / 10, reps: 1 + (i % 15),
      weightUnit: i % 3 === 0 ? "lb" : "kg", order: i % 5, completedAt: new Date(Date.UTC(2025, 0, 1) + i * 3600e3).toISOString(),
    }));
  }
  const t0 = performance.now();
  const { records } = personalRecords(sets, "kg");
  const ms = performance.now() - t0;
  console.log(`strength timing: 25000 sets in ${ms.toFixed(1)} ms`);
  assert.equal(Object.keys(records).length, 40);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
