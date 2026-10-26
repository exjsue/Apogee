// The helpers added ahead of schema version 3 (commit 2 of the plan): extra vocabularies, the defaults for an
// older exercise record, and the grouping a seed gets. Nothing in the app calls them yet.
//
// Every expected value below is written out by hand. None is computed by the helper under test, so a helper
// that is wrong cannot make its own test pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MUSCLES, EQUIPMENT, SCHEMA_VERSION, EXTRA_MUSCLES, EXTRA_EQUIPMENT, ALL_MUSCLES, ALL_EQUIPMENT, ORIGINS, exerciseV3Defaults,
} from "../src/domain/model.js";
import { SEED_EXERCISES, withSeedGrouping } from "../src/domain/seed.js";
import { SEED_GROUPING } from "../src/catalog/seed-grouping.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

// ---- vocabularies ----

test("schema 3 helpers: the existing lists are unchanged and the extra ones have exactly the expected contents", () => {
  assert.equal(SCHEMA_VERSION, 4); // schema 4 (templates) left these lists alone
  assert.deepEqual([...MUSCLES], [
    "chest", "front_delts", "side_delts", "rear_delts", "biceps", "triceps", "forearms", "traps", "lats", "upper_back",
    "lower_back", "abs", "obliques", "glutes", "quads", "hamstrings", "calves", "adductors",
  ]);
  assert.deepEqual([...EQUIPMENT], ["barbell", "dumbbell", "kettlebell", "ez_bar", "machine", "smith_machine", "cable", "resistance_band", "bodyweight", "bench", "pull_up_bar"]);
  assert.deepEqual([...EXTRA_MUSCLES], ["neck", "abductors"]);
  assert.deepEqual([...EXTRA_EQUIPMENT], ["trap_bar", "medicine_ball", "exercise_ball", "foam_roll", "other"]);
  assert.deepEqual([...ORIGINS], ["seed", "upstream", "authored", "custom"]);
});

test("schema 3 helpers: ALL_MUSCLES has 20 ids and ALL_EQUIPMENT 16, in order, without repeats, and every list is frozen", () => {
  assert.equal(ALL_MUSCLES.length, 20);
  assert.equal(ALL_EQUIPMENT.length, 16);
  assert.deepEqual([...ALL_MUSCLES], [
    "chest", "front_delts", "side_delts", "rear_delts", "biceps", "triceps", "forearms", "traps", "lats", "upper_back",
    "lower_back", "abs", "obliques", "glutes", "quads", "hamstrings", "calves", "adductors", "neck", "abductors",
  ]);
  assert.deepEqual([...ALL_EQUIPMENT], [
    "barbell", "dumbbell", "kettlebell", "ez_bar", "machine", "smith_machine", "cable", "resistance_band", "bodyweight", "bench", "pull_up_bar",
    "trap_bar", "medicine_ball", "exercise_ball", "foam_roll", "other",
  ]);
  assert.equal(new Set(ALL_MUSCLES).size, 20);
  assert.equal(new Set(ALL_EQUIPMENT).size, 16);
  for (const list of [EXTRA_MUSCLES, EXTRA_EQUIPMENT, ALL_MUSCLES, ALL_EQUIPMENT, ORIGINS]) assert.ok(Object.isFrozen(list));
});

// ---- the defaults for an older record ----

test("schema 3 helpers: exerciseV3Defaults gives a custom exercise origin custom and any other origin seed, and the seven fields their empty values", () => {
  assert.deepEqual(exerciseV3Defaults({ isCustom: true }), {
    baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false,
  });
  assert.deepEqual(exerciseV3Defaults({ isCustom: false }), {
    baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false,
  });
  assert.equal(exerciseV3Defaults({}).origin, "seed"); // isCustom missing (a very old record)
  assert.equal(exerciseV3Defaults({ isCustom: "yes" }).origin, "seed"); // only true means custom
  // a new list every time, so one record's variations are never shared with another
  const a = exerciseV3Defaults({ isCustom: false });
  const b = exerciseV3Defaults({ isCustom: false });
  a.variations.push("x");
  assert.deepEqual(b.variations, []);
});

// ---- grouping a seed ----

// A stored seed as schema version 3 will hold it before it is grouped, written out in full.
const squatSeed = () => ({
  id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: ["adductors", "hamstrings", "lower_back"],
  equipmentTags: ["barbell"], notes: "my own note", isCustom: false, defaultRestSeconds: 120,
  baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false,
});

test("schema 3 helpers: withSeedGrouping gives the paired seed-barbell-squat its four grouping fields and keeps everything else", () => {
  const record = squatSeed();
  const grouped = withSeedGrouping(record);
  assert.deepEqual(grouped, {
    id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: ["adductors", "hamstrings", "lower_back"],
    equipmentTags: ["barbell"], notes: "my own note", isCustom: false, defaultRestSeconds: 120,
    baseMovementId: "squat", equipment: "barbell", variations: [], origin: "seed", upstreamId: "Barbell_Squat", catalogVersion: null, retired: false,
  });
  assert.notEqual(grouped, record); // a new object
  assert.deepEqual(record, squatSeed()); // the input is not changed
  grouped.variations.push("x"); // the variations are a copy, not the shared list
  assert.deepEqual(withSeedGrouping(squatSeed()).variations, []);
});

test("schema 3 helpers: withSeedGrouping gives seed-lat-pulldown pulldown, cable, no variations and no upstream id", () => {
  const lat = {
    id: "seed-lat-pulldown", name: "Lat pulldown", primaryMuscles: ["lats"], secondaryMuscles: ["biceps", "upper_back"], equipmentTags: ["cable"],
    notes: "", isCustom: false, defaultRestSeconds: null, baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false,
  };
  assert.deepEqual(withSeedGrouping(lat), { ...lat, baseMovementId: "pulldown", equipment: "cable", variations: [], upstreamId: null });
});

test("schema 3 helpers: withSeedGrouping returns the very same object for a seed already grouped, a custom exercise with a seed-like id, an unknown id, and a record whose isCustom is not false", () => {
  const grouped = { ...squatSeed(), baseMovementId: "front-squat-family", equipment: "dumbbell", variations: ["front"], upstreamId: "Something_Else" };
  assert.equal(withSeedGrouping(grouped), grouped);
  const custom = { ...squatSeed(), isCustom: true, origin: "custom" };
  assert.equal(withSeedGrouping(custom), custom);
  const unknown = { ...squatSeed(), id: "seed-not-a-seed" };
  assert.equal(withSeedGrouping(unknown), unknown);
  const noFlag = squatSeed();
  delete noFlag.isCustom;
  assert.equal(withSeedGrouping(noFlag), noFlag);
  const notFalse = { ...squatSeed(), isCustom: "no" };
  assert.equal(withSeedGrouping(notFalse), notFalse);
});

test("schema 3 helpers: withSeedGrouping treats a record that has no grouping fields at all (an older record) as not grouped yet, and uses a grouping it is given", () => {
  const old = { id: "seed-barbell-squat", name: "Barbell back squat", primaryMuscles: ["quads"], secondaryMuscles: [], equipmentTags: ["barbell"], notes: "", isCustom: false };
  assert.deepEqual(withSeedGrouping(old), { ...old, baseMovementId: "squat", equipment: "barbell", variations: [], upstreamId: "Barbell_Squat" });
  const given = new Map([["seed-barbell-squat", { seedId: "seed-barbell-squat", upstreamId: "U_1", baseMovementId: "b-1", equipment: "cable", variations: ["v-1"] }]]);
  assert.deepEqual(withSeedGrouping(squatSeed(), given), { ...squatSeed(), baseMovementId: "b-1", equipment: "cable", variations: ["v-1"], upstreamId: "U_1" });
  assert.equal(withSeedGrouping({ ...squatSeed(), id: "seed-other" }, given).baseMovementId, null);
});

// ---- the 16 seeds ----

// seed id -> [base movement, equipment, variations, upstream id], written out from the 15 confirmed pairs
// (tools/exercise-catalog/confirmed-seed-pairs.json) and the hand-set lat pulldown. If a regeneration changes
// any grouping, this table fails and the change has to be looked at and agreed.
const EXPECTED_GROUPING = {
  "seed-barbell-bench-press": ["bench-press", "barbell", ["medium-grip"], "Barbell_Bench_Press_-_Medium_Grip"],
  "seed-barbell-row": ["row", "barbell", ["bent-over"], "Bent_Over_Barbell_Row"],
  "seed-barbell-squat": ["squat", "barbell", [], "Barbell_Squat"],
  "seed-conventional-deadlift": ["deadlift", "barbell", [], "Barbell_Deadlift"],
  "seed-dumbbell-curl": ["curl", "dumbbell", [], "Dumbbell_Bicep_Curl"],
  "seed-dumbbell-lateral-raise": ["lateral-raise", "dumbbell", [], "Side_Lateral_Raise"],
  "seed-hip-thrust": ["hip-thrust", "barbell", [], "Barbell_Hip_Thrust"],
  "seed-incline-dumbbell-press": ["bench-press", "dumbbell", ["incline"], "Incline_Dumbbell_Press"],
  "seed-lat-pulldown": ["pulldown", "cable", [], null],
  "seed-leg-press": ["leg-press", "machine", [], "Leg_Press"],
  "seed-overhead-press": ["overhead-press", "barbell", ["standing"], "Standing_Military_Press"],
  "seed-pull-up": ["pull-up", "bodyweight", [], "Pullups"],
  "seed-romanian-deadlift": ["deadlift", "barbell", ["romanian"], "Romanian_Deadlift"],
  "seed-seated-leg-curl": ["leg-curl", "machine", ["seated"], "Seated_Leg_Curl"],
  "seed-standing-calf-raise": ["calf-raise", "machine", ["standing"], "Standing_Calf_Raises"],
  "seed-triceps-pushdown": ["triceps-pushdown", "cable", [], "Triceps_Pushdown"],
};

test("schema 3 helpers: the generated SEED_GROUPING is exactly the hand-written table of the 16 seeds", () => {
  assert.equal(Object.keys(EXPECTED_GROUPING).length, 16);
  assert.equal(SEED_GROUPING.length, 16);
  assert.deepEqual(SEED_GROUPING.map((g) => g.seedId), Object.keys(EXPECTED_GROUPING)); // same seeds, same (sorted) order
  for (const g of SEED_GROUPING) {
    const [base, equipment, variations, upstreamId] = EXPECTED_GROUPING[g.seedId];
    assert.deepEqual(g, { baseMovementId: base, equipment, seedId: g.seedId, upstreamId, variations }, g.seedId);
  }
  // every real seed is in the table, and nothing else is
  assert.deepEqual(SEED_EXERCISES.map((s) => s.id).sort(), Object.keys(EXPECTED_GROUPING));
});

test("schema 3 helpers: grouping every real seed with withSeedGrouping changes only the four grouping fields", () => {
  for (const seed of SEED_EXERCISES) {
    const stored = { ...seed, baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false };
    const [base, equipment, variations, upstreamId] = EXPECTED_GROUPING[seed.id];
    assert.deepEqual(withSeedGrouping(stored), { ...seed, baseMovementId: base, equipment, variations, origin: "seed", upstreamId, catalogVersion: null, retired: false }, seed.id);
  }
});

// ---- who uses them ----

test("schema 3 helpers: only the model, the seeds, the upgrade step, the backup code and the exercise picker use them; nothing else in the UI, the logger or elsewhere", () => {
  const names = /\b(withSeedGrouping|exerciseV3Defaults|ALL_MUSCLES|ALL_EQUIPMENT|EXTRA_MUSCLES|EXTRA_EQUIPMENT|ORIGINS)\b/;
  const users = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name) && names.test(fs.readFileSync(full, "utf8"))) users.push(path.relative(ROOT, full).replaceAll("\\", "/"));
    }
  };
  walk(path.join(ROOT, "src"));
  for (const file of ["index.html", "sw.js"]) if (names.test(fs.readFileSync(path.join(ROOT, file), "utf8"))) users.push(file);
  // muscle-load.js (Body feature) takes the 20-id vocabulary from ALL_MUSCLES instead of redefining it; it is pure domain code
  assert.deepEqual(users.sort(), ["src/backup/backup.js", "src/domain/model.js", "src/domain/muscle-load.js", "src/domain/seed.js", "src/storage/migrations.js", "src/ui/workout-view.js"]);
  // the picker uses the two full lists for its selects and its custom form (both muscle groups and the equipment, since 2026-10-26) and nothing else from here
  const picker = fs.readFileSync(path.join(ROOT, "src", "ui", "workout-view.js"), "utf8");
  const used = [...picker.matchAll(new RegExp(names.source, "g"))].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ["ALL_EQUIPMENT", "ALL_MUSCLES"]);
  assert.match(picker, /const muscles = offered\(ALL_MUSCLES, [^\n]*\);\r?\n\s*const primary = checkboxGroup\("Primary muscles \(at least one\)", muscles, "primary", [^\n]*\);\r?\n\s*const secondary = checkboxGroup\("Secondary muscles", muscles, "secondary", /);
  assert.match(picker, /const equipment = checkboxGroup\("Equipment", offered\(ALL_EQUIPMENT, has\("equipmentTags"\)\), "equipment", /);
});

test("schema 3 helpers: createExercise returns exactly the fifteen schema 3 fields, accepts neck, and ignores a field it does not know", async () => {
  const { createExercise } = await import("../src/domain/model.js");
  const record = createExercise({ id: "x", name: "X", primaryMuscles: ["chest"], baseMovementId: "squat", origin: "seed", madeUp: 1 });
  assert.deepEqual(Object.keys(record).sort(), [
    "baseMovementId", "catalogVersion", "defaultRestSeconds", "equipment", "equipmentTags", "id", "isCustom", "name", "notes", "origin",
    "primaryMuscles", "retired", "secondaryMuscles", "upstreamId", "variations",
  ]);
  assert.deepEqual(createExercise({ id: "x", name: "X", primaryMuscles: ["neck"] }).primaryMuscles, ["neck"]);
});
