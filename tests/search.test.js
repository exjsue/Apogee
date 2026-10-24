import test from "node:test";
import assert from "node:assert/strict";
import { searchExercises } from "../src/domain/search.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const ids = (list) => list.map((exercise) => exercise.id);

test("searchExercises: an empty or blank query returns everything, alphabetically", () => {
  for (const query of [undefined, "", "   "]) {
    const result = searchExercises(SEED_EXERCISES, query);
    assert.equal(result.length, SEED_EXERCISES.length);
    assert.deepEqual(result.map((e) => e.name), [...result.map((e) => e.name)].sort((a, b) => a.localeCompare(b)));
  }
});

test("searchExercises: matches the name, ignoring case", () => {
  assert.equal(searchExercises(SEED_EXERCISES, "BENCH")[0].id, "seed-barbell-bench-press");
  assert.deepEqual(ids(searchExercises(SEED_EXERCISES, "pull-up")), ["seed-pull-up"]);
});

test("searchExercises: every word must match, in any order", () => {
  assert.deepEqual(ids(searchExercises(SEED_EXERCISES, "press incline")), ["seed-incline-dumbbell-press"]);
  assert.deepEqual(searchExercises(SEED_EXERCISES, "bench zebra"), []);
});

test("searchExercises: also matches muscles and equipment, with name matches first", () => {
  const calves = ids(searchExercises(SEED_EXERCISES, "calves"));
  assert.ok(calves.includes("seed-standing-calf-raise")); // primary muscle
  assert.ok(calves.includes("seed-seated-leg-curl")); // secondary muscle
  const front = ids(searchExercises(SEED_EXERCISES, "front delts"));
  assert.ok(front.includes("seed-overhead-press"));
  const cable = ids(searchExercises(SEED_EXERCISES, "cable"));
  assert.ok(cable.includes("seed-lat-pulldown") && cable.includes("seed-triceps-pushdown"));
  // "bar" is in many names and in the "barbell" and "pull up bar" tags of others:
  // exercises with it in the name come first, the rest after
  const bar = searchExercises(SEED_EXERCISES, "bar");
  const inName = bar.map((e) => e.name.toLowerCase().includes("bar"));
  assert.ok(inName.includes(true) && inName.includes(false));
  assert.equal(inName.indexOf(false), inName.lastIndexOf(true) + 1);
  assert.ok(bar.some((e) => e.id === "seed-pull-up" && !e.name.toLowerCase().includes("bar")));
});

test("searchExercises: does not change its input", () => {
  const list = [...SEED_EXERCISES].reverse();
  const copy = [...list];
  searchExercises(list, "bench");
  assert.deepEqual(list, copy);
});

// ---- filters, ordering and retired entries (the picker's search) ----

// One of each kind, written out by hand. "Zebra" is in every name so the query matches all of them.
const rec = (id, name, extra) => ({
  id, name, primaryMuscles: ["biceps"], secondaryMuscles: [], equipmentTags: ["dumbbell"], notes: "", isCustom: false, defaultRestSeconds: null,
  baseMovementId: null, equipment: null, variations: [], origin: "upstream", upstreamId: null, catalogVersion: 1, retired: false, ...extra,
});
const CUSTOM = rec("c-1", "Zebra curl", { isCustom: true, origin: "custom", catalogVersion: null });
const SEED = rec("seed-z", "Zebra press", { origin: "seed", catalogVersion: null, primaryMuscles: ["chest"], equipmentTags: ["barbell", "bench"] });
const CATALOG_A = rec("Zebra_Row", "Zebra row", { primaryMuscles: ["lats"], secondaryMuscles: ["biceps"], equipmentTags: ["cable"] });
const CATALOG_B = rec("Aardvark_Fly", "Aardvark fly", { primaryMuscles: ["chest"], equipmentTags: ["dumbbell", "bench"] });
const RETIRED = rec("Old_Zebra", "Old zebra", { retired: true, primaryMuscles: ["chest"] });
const ALL = [CATALOG_A, RETIRED, SEED, CATALOG_B, CUSTOM];

test("searchExercises: an empty query lists the user's own exercises first, then the built-in lifts, then the catalog, each alphabetical, and hides retired ones", () => {
  assert.deepEqual(ids(searchExercises(ALL, "")), ["c-1", "seed-z", "Aardvark_Fly", "Zebra_Row"]);
  assert.deepEqual(ids(searchExercises(ALL)), ["c-1", "seed-z", "Aardvark_Fly", "Zebra_Row"]);
});

test("searchExercises: a catalog entry that sorts first alphabetically still comes after a custom exercise and a seed", () => {
  assert.deepEqual(ids(searchExercises([CATALOG_B, CUSTOM, SEED], "")), ["c-1", "seed-z", "Aardvark_Fly"]);
  assert.deepEqual(ids(searchExercises(ALL, "zebra")), ["c-1", "seed-z", "Zebra_Row"]);
});

test("searchExercises: name matches come before tier: a catalog entry named for the muscle beats a custom exercise that only works it", () => {
  const namedChest = rec("Chest_Fly", "Chest fly", { primaryMuscles: ["chest"] });
  const onlyWorksChest = rec("c-2", "Cable cross", { isCustom: true, origin: "custom", catalogVersion: null, primaryMuscles: ["chest"] });
  assert.deepEqual(ids(searchExercises([onlyWorksChest, namedChest], "chest")), ["Chest_Fly", "c-2"]);
});

test("searchExercises: the muscle filter looks at PRIMARY muscles only", () => {
  assert.deepEqual(ids(searchExercises(ALL, "", { muscle: "chest" })), ["seed-z", "Aardvark_Fly"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { muscle: "lats" })), ["Zebra_Row"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { muscle: "biceps" })), ["c-1"]); // Zebra row works biceps only as a secondary muscle
  assert.deepEqual(searchExercises(ALL, "", { muscle: "neck" }), []);
});

test("searchExercises: the equipment filter looks at the equipment tags", () => {
  assert.deepEqual(ids(searchExercises(ALL, "", { equipment: "bench" })), ["seed-z", "Aardvark_Fly"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { equipment: "cable" })), ["Zebra_Row"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { equipment: "dumbbell" })), ["c-1", "Aardvark_Fly"]);
  assert.deepEqual(searchExercises(ALL, "", { equipment: "foam_roll" }), []);
});

test("searchExercises: the query and both filters all have to match", () => {
  assert.deepEqual(ids(searchExercises(ALL, "fly", { muscle: "chest", equipment: "bench" })), ["Aardvark_Fly"]);
  assert.deepEqual(searchExercises(ALL, "fly", { muscle: "lats" }), []);
  assert.deepEqual(ids(searchExercises(ALL, "zebra", { equipment: "bench" })), ["seed-z"]);
});

test("searchExercises: retired entries are hidden by default and shown with includeRetired", () => {
  assert.ok(!ids(searchExercises(ALL, "old")).includes("Old_Zebra"));
  assert.deepEqual(ids(searchExercises(ALL, "old")), []);
  assert.deepEqual(ids(searchExercises(ALL, "old", { includeRetired: true })), ["Old_Zebra"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { includeRetired: true })), ["c-1", "seed-z", "Aardvark_Fly", "Old_Zebra", "Zebra_Row"]);
  assert.deepEqual(ids(searchExercises(ALL, "", { muscle: "chest" })).includes("Old_Zebra"), false);
});

test("searchExercises: it still works with no filters argument, an empty one, or explicit nulls, and does not change its input", () => {
  const expected = ["c-1", "seed-z", "Aardvark_Fly", "Zebra_Row"];
  assert.deepEqual(ids(searchExercises(ALL, "")), expected);
  assert.deepEqual(ids(searchExercises(ALL, "", {})), expected);
  assert.deepEqual(ids(searchExercises(ALL, "", undefined)), expected);
  assert.deepEqual(ids(searchExercises(ALL, "", { muscle: null, equipment: null, includeRetired: false })), expected);
  const copy = [...ALL];
  searchExercises(ALL, "", { muscle: "chest" });
  assert.deepEqual(ALL, copy);
  assert.deepEqual(ids(ALL), ["Zebra_Row", "Old_Zebra", "seed-z", "Aardvark_Fly", "c-1"]);
});
