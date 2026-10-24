// The generated catalog (src/catalog) as the app will store it. These tests exist because schema version 3 once
// refused 15 real catalog entries (a tag with an underscore) and no test had run the real catalog through the
// app's own validation. The mapping from an entry to a stored record is written out here by hand, so it does not
// depend on any helper in the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, CATALOG_VERSION as CATALOG_JS_VERSION } from "../src/catalog/catalog.js";
import { CATALOG_VERSION, CATALOG_COUNT } from "../src/catalog/catalog-info.js";
import { SEED_GROUPING } from "../src/catalog/seed-grouping.js";
import { createExercise } from "../src/domain/model.js";

// A catalog entry as a stored built-in record.
const asStored = (e) => ({
  id: e.id,
  name: e.name,
  primaryMuscles: e.primaryMuscles,
  secondaryMuscles: e.secondaryMuscles,
  equipmentTags: e.equipmentTags,
  notes: "",
  isCustom: false,
  defaultRestSeconds: null,
  baseMovementId: e.baseMovementId,
  equipment: e.equipment,
  variations: e.variations,
  origin: e.origin,
  upstreamId: e.origin === "upstream" ? e.id : null,
  catalogVersion: e.catalogVersion,
  retired: e.retired,
});

// The 15 upstream entries that seeds stand for (confirmed-seed-pairs.json), written out by hand.
const SEED_UPSTREAM_IDS = [
  "Barbell_Bench_Press_-_Medium_Grip", "Bent_Over_Barbell_Row", "Barbell_Squat", "Barbell_Deadlift", "Dumbbell_Bicep_Curl",
  "Side_Lateral_Raise", "Barbell_Hip_Thrust", "Incline_Dumbbell_Press", "Leg_Press", "Standing_Military_Press",
  "Pullups", "Romanian_Deadlift", "Seated_Leg_Curl", "Standing_Calf_Raises", "Triceps_Pushdown",
];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test("catalog: all 830 entries are accepted by createExercise as stored built-in records, and nothing is dropped", () => {
  assert.equal(CATALOG.length, 830);
  const refused = [];
  for (const entry of CATALOG) {
    const record = asStored(entry);
    try {
      assert.deepEqual(createExercise(record), record);
    } catch (error) {
      refused.push(`${entry.id}: ${error.message}`);
    }
  }
  assert.deepEqual(refused, []);
});

test("catalog-info.js says version 1 and 830 entries, and matches catalog.js", () => {
  assert.equal(CATALOG_VERSION, 1);
  assert.equal(CATALOG_COUNT, 830);
  assert.equal(CATALOG_JS_VERSION, CATALOG_VERSION);
  assert.equal(CATALOG.length, CATALOG_COUNT);
  assert.ok(CATALOG.every((e) => e.catalogVersion === CATALOG_VERSION));
});

test("catalog: ids are unique and none starts with seed-", () => {
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, 830);
  assert.deepEqual(CATALOG.filter((e) => e.id.startsWith("seed-")).map((e) => e.id), []);
});

test("catalog: no id is the upstream entry a seed stands for (those 15 are left out of the catalog)", () => {
  assert.equal(SEED_UPSTREAM_IDS.length, 15);
  assert.deepEqual(SEED_GROUPING.map((g) => g.upstreamId).filter((id) => id !== null).sort(), [...SEED_UPSTREAM_IDS].sort());
  const ids = new Set(CATALOG.map((e) => e.id));
  assert.deepEqual(SEED_UPSTREAM_IDS.filter((id) => ids.has(id)), []);
});

test("catalog: no two names are equal ignoring case, and none is longer than 80 characters", () => {
  const seen = new Map();
  const repeated = [];
  for (const e of CATALOG) {
    const key = e.name.toLowerCase();
    if (seen.has(key)) repeated.push(`${seen.get(key)} / ${e.id}`);
    seen.set(key, e.id);
  }
  assert.deepEqual(repeated, []);
  assert.deepEqual(CATALOG.filter((e) => [...e.name].length > 80).map((e) => e.id), []);
});

test("catalog: every variation tag and base movement id is lower-case words joined by single hyphens, at most 40 characters, variations sorted without repeats", () => {
  const bad = [];
  for (const e of CATALOG) {
    for (const tag of [...e.variations, ...(e.baseMovementId === null ? [] : [e.baseMovementId])]) {
      if (!KEBAB.test(tag) || tag.length > 40) bad.push(`${e.id}: ${tag}`);
    }
    if (JSON.stringify(e.variations) !== JSON.stringify([...new Set(e.variations)].sort())) bad.push(`${e.id}: variations not sorted or repeated`);
    if (e.variations.length > 12) bad.push(`${e.id}: more than 12 variations`);
  }
  assert.deepEqual(bad, []);
});

test("catalog: the stretch and foam-roll tags that used to contain an underscore are hyphenated, and 15 entries carry them", () => {
  const targets = CATALOG.flatMap((e) => e.variations.filter((v) => /^target-.*-(delts|back)$/.test(v)).map((v) => [e.id, v]));
  assert.equal(targets.length, 15);
  assert.deepEqual([...new Set(targets.map(([, v]) => v))].sort(), ["target-front-delts", "target-lower-back", "target-rear-delts", "target-upper-back"]);
  assert.equal(CATALOG.filter((e) => e.variations.some((v) => v.includes("_"))).length, 0);
});

test("catalog: three entries, compared as full stored records", () => {
  const byId = (id) => asStored(CATALOG.find((e) => e.id === id));
  assert.deepEqual(byId("3_4_Sit-Up"), {
    id: "3_4_Sit-Up", name: "3/4 Sit-Up", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: ["bodyweight"], notes: "", isCustom: false,
    defaultRestSeconds: null, baseMovementId: "sit-up", equipment: "bodyweight", variations: [], origin: "upstream", upstreamId: "3_4_Sit-Up",
    catalogVersion: 1, retired: false,
  });
  assert.deepEqual(byId("Cat_Stretch"), {
    id: "Cat_Stretch", name: "Cat Stretch", primaryMuscles: ["lower_back"], secondaryMuscles: ["traps", "upper_back"], equipmentTags: ["bodyweight"],
    notes: "", isCustom: false, defaultRestSeconds: null, baseMovementId: "stretch", equipment: "bodyweight", variations: ["target-lower-back"],
    origin: "upstream", upstreamId: "Cat_Stretch", catalogVersion: 1, retired: false,
  });
  assert.deepEqual(byId("Seated_Front_Deltoid"), {
    id: "Seated_Front_Deltoid", name: "Seated Front Deltoid", primaryMuscles: ["front_delts"], secondaryMuscles: ["chest"], equipmentTags: ["bodyweight"],
    notes: "", isCustom: false, defaultRestSeconds: null, baseMovementId: "stretch", equipment: "bodyweight", variations: ["front", "seated", "target-front-delts"],
    origin: "upstream", upstreamId: "Seated_Front_Deltoid", catalogVersion: 1, retired: false,
  });
});
