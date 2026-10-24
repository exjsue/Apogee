// Base-movement families of the exercise catalog pipeline (tools/exercise-catalog/lib/rules-families.js).
// A wrong family silently groups unlike exercises, and a keyword that fires inside another word ("chin" in
// "machine", "row" in "narrow") puts an exercise in the wrong history group, so the tests use real upstream
// names, including the ones a plain keyword gets wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { curate } from "../tools/exercise-catalog/lib/curate.js";
import { loadVocabulary } from "../tools/exercise-catalog/lib/vocabulary.js";
import { FAMILY_IDS, familyFor, familyMatches, STAYS_NULL } from "../tools/exercise-catalog/lib/rules-families.js";
import { classifyBase, baseMovementFor } from "../tools/exercise-catalog/lib/rules-movement.js";
import { buildAdditions } from "../tools/exercise-catalog/lib/additions.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "exercise-catalog");
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-110.json"), "utf8"));
const vocabulary = loadVocabulary();

const family = (name, category = "strength", primary = []) => familyFor({ name, category, primary });

// ---- each rule on real entries ----

// [family, category, primary muscles the rule may read, real names]
const RULES = [
  ["foam-roll", "stretching", [], ["Hamstring-SMR", "Neck-SMR", "Foot-SMR"]],
  ["cardio", "cardio", [], ["Bicycling", "Elliptical Trainer", "Rowing, Stationary"]],
  ["stretch", "stretching", [], ["90/90 Hamstring", "Child's Pose", "Calf Stretch Hands Against Wall"]],
  ["throw", "plyometrics", [], ["Medicine Ball Chest Pass", "Overhead Slam", "Chest Push (single response)"]],
  ["jump", "plyometrics", [], ["Box Jump (Multiple Response)", "Hurdle Hops", "Standing Long Jump"]],
  ["agility-drill", "plyometrics", [], ["Mountain Climbers", "Carioca Quick Step", "Single Leg Butt Kick"]],
  ["clean-and-jerk", "olympic weightlifting", [], ["Clean and Jerk", "One-Arm Kettlebell Clean and Jerk"]],
  ["clean-and-press", "strength", [], ["Clean and Press"]],
  ["snatch-pull", "olympic weightlifting", [], ["Snatch Pull", "Snatch Shrug"]],
  ["snatch-balance", "olympic weightlifting", [], ["Snatch Balance", "Heaving Snatch Balance"]],
  ["snatch", "olympic weightlifting", [], ["Hang Snatch", "Power Snatch", "One-Arm Kettlebell Snatch"]],
  ["clean-pull", "olympic weightlifting", [], ["Clean Pull", "Clean Shrug"]],
  ["clean", "olympic weightlifting", [], ["Hang Clean", "Dumbbell Clean", "Clean from Blocks"]],
  ["jerk", "olympic weightlifting", [], ["Split Jerk", "Power Jerk", "Two-Arm Kettlebell Jerk"]],
  ["push-press", "olympic weightlifting", [], ["Push Press", "Push Press - Behind the Neck"]],
  ["kettlebell-swing", "strength", [], ["One-Arm Kettlebell Swings", "Vertical Swing"]],
  ["carry", "strongman", [], ["Farmer's Walk", "Rickshaw Carry", "Yoke Walk"]],
  ["sled-push-drag", "strongman", [], ["Sled Push", "Backward Drag", "Prowler Sprint"]],
  ["deadlift", "powerlifting", [], ["Wide Stance Stiff Legs"]],
  ["pull-up", "strength", [], ["Chin-Up", "Muscle Up", "V-Bar Pullup", "Weighted Pull Ups"]],
  ["straight-arm-pulldown", "strength", [], ["Straight-Arm Pulldown", "Cable Incline Pushdown"]],
  ["pulldown", "strength", [], ["Wide-Grip Lat Pulldown", "V-Bar Pulldown", "Underhand Cable Pulldowns"]],
  ["pullover", "strength", [], ["Bent-Arm Barbell Pullover", "Straight-Arm Dumbbell Pullover"]],
  ["upright-row", "strength", [], ["Upright Barbell Row", "Smith Machine Upright Row"]],
  ["rear-delt-fly", "strength", [], ["Face Pull", "Reverse Flyes", "Band Pull Apart", "Cable Rear Delt Fly"]],
  ["row", "strength", [], ["Bent Over Barbell Row", "Seated Cable Rows", "Inverted Row", "Barbell Rear Delt Row"]],
  ["shrug", "strength", [], ["Barbell Shrug", "Dumbbell Shrug", "Cable Shrugs"]],
  ["lateral-raise", "strength", ["side_delts"], ["Side Lateral Raise", "Cable Seated Lateral Raise", "Crucifix"]],
  ["front-raise", "strength", ["front_delts"], ["Front Plate Raise", "Front Two-Dumbbell Raise", "Single Dumbbell Raise"]],
  ["overhead-press", "strength", ["front_delts"], ["Barbell Shoulder Press", "Arnold Dumbbell Press", "Handstand Push-Ups"]],
  ["push-up", "strength", [], ["Decline Push-Up", "Pushups", "Incline Push-Up Wide"]],
  ["dip", "strength", [], ["Bench Dips", "Parallel Bar Dip", "Ring Dips"]],
  ["fly", "strength", [], ["Dumbbell Flyes", "Cable Crossover", "Butterfly"]],
  ["bench-press", "strength", ["chest"], ["Incline Dumbbell Press", "Cable Chest Press", "Leverage Chest Press"]],
  ["triceps-pushdown", "strength", [], ["Triceps Pushdown", "Triceps Pushdown - Rope Attachment"]],
  ["triceps-extension", "strength", ["triceps"], ["EZ-Bar Skullcrusher", "Lying Dumbbell Tricep Extension", "JM Press"]],
  ["wrist-curl", "strength", [], ["Cable Wrist Curl", "Finger Curls", "Seated Dumbbell Palms-Up Wrist Curl"]],
  ["forearm-rotation", "strength", [], ["Dumbbell Lying Pronation", "Wrist Rotations with Straight Bar"]],
  ["leg-curl", "strength", [], ["Lying Leg Curls", "Seated Band Hamstring Curl"]],
  ["curl", "strength", [], ["Barbell Curl", "Cable Preacher Curl", "Alternate Hammer Curl"]],
  ["leg-press", "strength", [], ["Leg Press", "Smith Machine Leg Press"]],
  ["leg-extension", "strength", [], ["Leg Extensions", "Single-Leg Leg Extension"]],
  ["calf-raise", "strength", [], ["Donkey Calf Raises", "Calf Press", "Barbell Seated Calf Raise"]],
  ["lunge", "strength", [], ["Dumbbell Lunges", "Barbell Walking Lunge", "Elevated Back Lunge"]],
  ["step-up", "strength", [], ["Barbell Step Ups", "Dumbbell Step Ups"]],
  ["hip-thrust", "strength", [], ["Barbell Hip Thrust", "Barbell Glute Bridge", "Butt Lift (Bridge)"]],
  ["glute-ham-raise", "strength", [], ["Glute Ham Raise", "Natural Glute Ham Raise"]],
  ["back-extension", "strength", [], ["Hyperextensions (Back Extensions)", "Reverse Hyperextension"]],
  ["hip-abduction-adduction", "strength", [], ["Thigh Abductor", "Cable Hip Adduction", "Monster Walk"]],
  ["kickback", "strength", [], ["Glute Kickback", "One-Legged Cable Kickback"]],
  ["crunch", "strength", [], ["Cable Crunch", "Oblique Crunches", "Reverse Crunch"]],
  ["sit-up", "strength", [], ["Sit-Up", "Jackknife Sit-Up", "Weighted Sit-Ups - With Bands"]],
  ["leg-raise", "strength", [], ["Hanging Leg Raise", "Flutter Kicks", "Bent-Knee Hip Raise"]],
  ["rollout", "strength", [], ["Ab Roller", "Barbell Ab Rollout", "Suspended Fallout"]],
  ["plank", "strength", [], ["Plank", "Dead Bug", "Side Bridge"]],
  ["twist", "strength", [], ["Russian Twist", "Standing Cable Wood Chop", "Landmine 180's"]],
  ["side-bend", "strength", [], ["Barbell Side Bend", "Dumbbell Side Bend"]],
  ["windmill", "strength", [], ["Kettlebell Windmill", "Double Kettlebell Windmill"]],
  ["pallof-press", "strength", [], ["Pallof Press", "Pallof Press With Rotation"]],
  ["neck-exercise", "strength", ["neck"], ["Isometric Neck Exercise - Sides", "Seated Head Harness Neck Resistance"]],
];

test("families: each rule puts real entries in its family", () => {
  const wrong = [];
  for (const [id, category, primary, names] of RULES) {
    for (const name of names) {
      const got = classifyBase({ name, category, primary }).id;
      if (got !== id) wrong.push(`${name}: ${got}, expected ${id}`);
    }
  }
  assert.deepEqual(wrong, []);
  // Every family has a rule row above, and every family id is a base movement in vocab.json.
  assert.deepEqual([...new Set(RULES.map((r) => r[0]))].sort(), [...FAMILY_IDS].sort());
  for (const id of FAMILY_IDS) assert.ok(vocabulary.baseMovements.includes(id), `${id} is missing from vocab.json`);
});

// ---- keywords that are wrong on their own ----

// [name, category, primary, family it must NOT be mistaken for the keyword's family, expected]
const MISFIRES = [
  // "up": step-ups, bottoms-up and pull-ups are not sit-ups
  ["Barbell Step Ups", "strength", [], "step-up"],
  ["Bottoms-Up Clean From The Hang Position", "olympic weightlifting", [], "clean"],
  ["Band Assisted Pull-Up", "strength", [], "pull-up"],
  ["Bottoms Up", "strength", ["abs"], null],
  // "side": a side bridge or a press to the side is not a side bend
  ["Side Bridge", "strength", [], "plank"],
  ["One-Arm Kettlebell Military Press To The Side", "strength", ["front_delts"], "overhead-press"],
  ["Bosu Ball Cable Crunch With Side Bends", "strength", [], "crunch"],
  ["Push Up to Side Plank", "strength", ["chest"], null],
  // "raise"
  ["Calf Raises - With Bands", "strength", [], "calf-raise"],
  ["Dumbbell Lying Rear Lateral Raise", "strength", ["rear_delts"], "rear-delt-fly"],
  ["Bent-Knee Hip Raise", "strength", [], "leg-raise"],
  ["Alternating Deltoid Raise", "strength", ["front_delts"], null],
  ["Side Laterals to Front Raise", "strength", ["side_delts"], null],
  // "chin": inside "machine", and the end of a press
  ["Ab Crunch Machine", "strength", [], "crunch"],
  ["Dip Machine", "strength", [], "dip"],
  ["Calf-Machine Shoulder Shrug", "strength", [], "shrug"],
  ["Lying Close-Grip Barbell Triceps Press To Chin", "strength", ["triceps"], "triceps-extension"],
  ["Chin To Chest Stretch", "stretching", [], "stretch"],
  ["Gorilla Chin/Crunch", "strength", ["abs"], null],
  ["Mixed Grip Chin", "strength", [], "pull-up"],
  // "curl"
  ["Lying Leg Curls", "strength", [], "leg-curl"],
  ["Cable Wrist Curl", "strength", [], "wrist-curl"],
  ["Lower Back Curl", "stretching", [], "stretch"],
  // "press"
  ["Calf Press", "strength", [], "calf-raise"],
  ["Narrow Stance Leg Press", "strength", [], "leg-press"],
  ["Clean and Press", "strength", [], "clean-and-press"],
  ["Double Kettlebell Push Press", "strength", ["front_delts"], "push-press"],
  ["Body Tricep Press", "strength", ["triceps"], "triceps-extension"],
  ["Svend Press", "strength", ["chest"], null],
  // "push"
  ["Cable Incline Pushdown", "strength", ["lats"], "straight-arm-pulldown"],
  ["Chest Push (single response)", "plyometrics", [], "throw"],
  ["Incline Push-Up", "strength", [], "push-up"],
  ["Drop Push", "plyometrics", ["chest"], null],
  // "neck"
  ["Standing Barbell Press Behind Neck", "strength", ["front_delts"], "overhead-press"],
  ["Wide-Grip Pulldown Behind The Neck", "strength", [], "pulldown"],
  ["Neck-SMR", "stretching", [], "foam-roll"],
  ["Side Neck Stretch", "stretching", [], "stretch"],
  ["Neck Press", "strength", ["chest"], "bench-press"],
  ["Lying Face Down Plate Neck Resistance", "strength", ["neck"], "neck-exercise"],
  // "extension"
  ["Leg Extensions", "strength", [], "leg-extension"],
  ["Hyperextensions (Back Extensions)", "strength", [], "back-extension"],
  ["Hip Extension with Bands", "strength", ["glutes"], null],
  ["Kettlebell Halo with Overhead Extension", "strength", ["triceps"], null],
  // "lateral": plyometric lateral jumps are not lateral raises
  ["Lateral Bound", "plyometrics", [], "jump"],
  ["Lateral Box Jump", "plyometrics", [], "jump"],
  // "row": inside "narrow", "prowler", "throw", "rowing"
  ["Narrow Stance Leg Press", "strength", [], "leg-press"],
  ["Prowler Sprint", "cardio", [], "sled-push-drag"],
  ["Supine Chest Throw", "plyometrics", [], "throw"],
  ["Rowing, Stationary", "cardio", [], "cardio"],
  ["Upright Barbell Row", "strength", [], "upright-row"],
  // "walk"
  ["Barbell Walking Lunge", "strength", [], "lunge"],
  ["Walking, Treadmill", "cardio", [], "cardio"],
  ["Monster Walk", "strength", [], "hip-abduction-adduction"],
  ["Farmer's Walk", "strongman", [], "carry"],
  // "sled": inside "sledgehammer", and sled variants of other lifts
  ["Sled Row", "strength", [], "row"],
  ["Sled Reverse Flye", "strength", ["rear_delts"], "rear-delt-fly"],
  ["Sled Overhead Triceps Extension", "strength", ["triceps"], "triceps-extension"],
  ["Sledgehammer Swings", "plyometrics", ["abs"], null],
  // "clean"
  ["Clean Shrug", "olympic weightlifting", [], "clean-pull"],
  ["Clean and Jerk", "olympic weightlifting", [], "clean-and-jerk"],
  ["Snatch Shrug", "olympic weightlifting", [], "snatch-pull"],
];

test("families: keywords that are right only some of the time (up, side, raise, chin, curl, press, push, neck, extension, lateral, row, walk, sled, clean) do not misfire", () => {
  const wrong = [];
  for (const [name, category, primary, expected] of MISFIRES) {
    const got = classifyBase({ name, category, primary }).id;
    if (got !== expected) wrong.push(`${name}: ${got}, expected ${expected}`);
  }
  assert.deepEqual(wrong, []);
});

// ---- decisions by the owner: these stay null ----

test("families: strongman events and the two stretching-category entries the owner chose to leave out stay null", () => {
  for (const name of ["Atlas Stone Trainer", "Atlas Stones", "Circus Bell", "Conan's Wheel", "Keg Load", "Log Lift", "Sandbag Load", "Tire Flip", "Power Stairs"]) {
    assert.equal(classifyBase({ name, category: "strongman", primary: [] }).id, null, name);
  }
  assert.ok(!FAMILY_IDS.includes("strongman-event"));
  assert.equal(STAYS_NULL.length, 2);
  for (const name of ["One Handed Hang", "Crossover Reverse Lunge"]) {
    assert.equal(classifyBase({ name, category: "stretching", primary: ["lats"] }).id, null, name);
    assert.deepEqual(familyMatches({ name, category: "stretching", primary: [] }), []);
  }
});

// ---- the approved squat, deadlift and bench rules are never overruled ----

test("families: an entry the squat, deadlift and bench rules decide never changes, and the 110 sample entries are all decided by them", () => {
  const curated = curate({ upstream: fixture, overrides: {}, vocabulary }).entries;
  const changed = [];
  for (const e of curated) {
    const found = classifyBase({ name: e.name, category: e.category, primary: e.primaryMuscles });
    if (found.byFamily || found.id !== baseMovementFor(e.name)) changed.push(e.id);
  }
  assert.deepEqual(changed, []);
  assert.ok(curated.every((e) => e.baseMovementId !== null));
  // Widened bases: names the old rules left null join them, nothing else moves.
  assert.equal(classifyBase({ name: "Incline Dumbbell Press", category: "strength", primary: ["chest"] }).id, "bench-press");
  assert.equal(classifyBase({ name: "Split Jerk", category: "olympic weightlifting", primary: [] }).id, "jerk");
  assert.equal(classifyBase({ name: "Wide Stance Stiff Legs", category: "powerlifting", primary: [] }).id, "deadlift");
  assert.equal(classifyBase({ name: "Barbell Bench Press - Medium Grip", category: "strength", primary: ["chest"] }).byFamily, false);
});

// ---- through curate: variations, review list, key clashes ----

const upstream = (id, name, extra = {}) => ({
  id, name, force: null, level: "beginner", mechanic: null, equipment: "body only", primaryMuscles: ["quadriceps"], secondaryMuscles: [], category: "strength", ...extra,
});
const entryOf = (result, id) => result.entries.find((e) => e.id === id);

test("families: the extra variation tags and the target and modality tags apply to family entries only", () => {
  const result = curate({
    upstream: [
      upstream("Quad", "Quad Stretch", { category: "stretching", primaryMuscles: ["quadriceps"] }),
      upstream("Bike", "Bicycling, Stationary", { category: "cardio", equipment: "other", primaryMuscles: ["quadriceps"] }),
      upstream("Tri", "Standing Dumbbell Triceps Extension", { equipment: "dumbbell", primaryMuscles: ["triceps"] }),
      upstream("Squat", "Standing Barbell Squat", { equipment: "barbell" }),
    ],
    vocabulary,
  });
  assert.deepEqual(entryOf(result, "Quad").variations, ["target-quads"]);
  assert.ok(entryOf(result, "Bike").variations.includes("cycling"));
  assert.deepEqual(entryOf(result, "Tri").variations, ["standing"]);
  assert.deepEqual(entryOf(result, "Squat").variations, []); // an old-rule entry keeps the tags it was approved with
  for (const e of result.entries) for (const v of e.variations) assert.ok(vocabulary.variations.includes(v), v);
});

test("families: an entry two families match is on the review list with its alternatives, and an entry with one match is not", () => {
  const result = curate({
    upstream: [
      upstream("Fly", "Cable Rear Delt Fly", { equipment: "cable", primaryMuscles: ["shoulders"] }),
      upstream("Board", "Board Press", { equipment: "barbell", primaryMuscles: ["triceps"] }),
      upstream("Curl", "Lying Leg Curls", { equipment: "machine", primaryMuscles: ["hamstrings"] }),
      upstream("Plain", "Barbell Curl", { equipment: "barbell", primaryMuscles: ["biceps"] }),
    ],
    vocabulary,
  });
  const row = (id) => result.review.find((r) => r.entry.id === id);
  assert.equal(entryOf(result, "Fly").baseMovementId, "rear-delt-fly");
  assert.deepEqual(row("Fly").alternatives, ["fly"]);
  assert.ok(row("Fly").reasons.includes("multiple-families"));
  assert.equal(entryOf(result, "Board").baseMovementId, "bench-press");
  assert.deepEqual(row("Board").alternatives, ["triceps-extension"]);
  assert.equal(entryOf(result, "Curl").baseMovementId, "leg-curl");
  assert.deepEqual(row("Curl").alternatives, ["curl"]);
  assert.equal(row("Plain"), undefined);
});

test("families: a shared key is listed for every family but is a reason to review only outside the warning-only families in vocab.json", () => {
  assert.deepEqual([...vocabulary.keyClashWarningFamilies].sort(), ["agility-drill", "cardio", "foam-roll", "jump", "stretch", "throw"]);
  const result = curate({
    upstream: [
      upstream("StretchA", "Quad Stretch", { category: "stretching" }),
      upstream("StretchB", "On-Your-Back Quad Stretch", { category: "stretching" }),
      upstream("CurlA", "Barbell Curl", { equipment: "barbell", primaryMuscles: ["biceps"] }),
      upstream("CurlB", "Barbell Curls Lying Against An Incline Bench", { equipment: "barbell", primaryMuscles: ["biceps"] }),
    ],
    vocabulary,
  });
  const clash = (family) => result.keyClashes.find((c) => c.key.startsWith(`${family}|`));
  assert.equal(clash("stretch").warningOnly, true);
  assert.equal(clash("curl")?.warningOnly ?? false, false);
  const reasons = (id) => result.review.find((r) => r.entry.id === id)?.reasons ?? [];
  assert.ok(!reasons("StretchA").includes("key-clash"));
  // CurlA and CurlB differ by "lying", so they do not clash; force a clash with identical tags.
  const twin = curate({ upstream: [upstream("T1", "Barbell Curl", { equipment: "barbell", primaryMuscles: ["biceps"] }), upstream("T2", "Barbell Curls", { equipment: "barbell", primaryMuscles: ["biceps"] })], vocabulary });
  assert.equal(twin.keyClashes.length, 1);
  assert.equal(twin.keyClashes[0].warningOnly, false);
  assert.ok(twin.review.find((r) => r.entry.id === "T1").reasons.includes("key-clash"));
});

test("families: the output is the same on every run and every base and tag it writes is in vocab.json", () => {
  const entries = RULES.flatMap(([, category, primary, names]) => names.map((name, i) => upstream(`${name}-${i}`, name, { category, primaryMuscles: primary.length > 0 ? ["chest"] : ["quadriceps"] })));
  const a = curate({ upstream: entries, vocabulary });
  const b = curate({ upstream: [...entries].reverse(), vocabulary });
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.review, b.review);
  for (const e of a.entries) {
    assert.ok(e.baseMovementId === null || vocabulary.baseMovements.includes(e.baseMovementId), e.id);
    for (const v of e.variations) assert.ok(vocabulary.variations.includes(v), `${e.id}: ${v}`);
  }
});

// ---- the additions check: a shared key is a warning only in the warning-only families ----

const GOOD = (base, variations, equipment = "bodyweight") => [
  "id: apogee-test-move", "name: Zzz Mystery Move", `base: ${base}`, `equipment: ${equipment}`, `variations: ${variations}`, "primary: quads",
].join("\n");
const existing = (base, equipment, variations) => [{ id: "E1", name: "Existing Thing", baseMovementId: base, equipment, variations }];
const addCheck = (text, curated, extra = {}) => buildAdditions({ text, upstream: fixture, curated, seeds: SEED_EXERCISES, vocabulary, ...extra });

test("additions: the same key as an existing entry is a warning in a warning-only family and still adds the entry", () => {
  const result = addCheck(GOOD("stretch", "target-quads"), existing("stretch", "bodyweight", ["target-quads"]));
  assert.deepEqual(result.problems, []);
  assert.equal(result.entries.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].what, /exactly the same as "Existing Thing" \(id E1\)/);
  // the same for every family in the list
  for (const base of vocabulary.keyClashWarningFamilies) {
    const r = addCheck(GOOD(base, ""), existing(base, "bodyweight", []));
    assert.deepEqual(r.problems, [], base);
    assert.equal(r.warnings.length, 1, base);
  }
});

test("additions: the same key as an existing entry still stops the build in every other family, and the list is data in vocab.json", () => {
  const result = addCheck(GOOD("curl", "", "dumbbell"), existing("curl", "dumbbell", []));
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].what, /exactly the same as "Existing Thing" \(id E1\)/);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.warnings, []);
  // the family list is read from the vocabulary, not fixed in code: empty it and the stretch case fails
  const strict = addCheck(GOOD("stretch", "target-quads"), existing("stretch", "bodyweight", ["target-quads"]), { vocabulary: { ...vocabulary, keyClashWarningFamilies: [] } });
  assert.equal(strict.problems.length, 1);
  const data = JSON.parse(fs.readFileSync(path.join(here, "..", "tools", "exercise-catalog", "vocab.json"), "utf8"));
  assert.deepEqual(data.keyClashWarningFamilies, vocabulary.keyClashWarningFamilies);
});

// ---- the family audit files ----

test("families: the build writes families.md and outliers.md, the same on every run, with every entry that has a base listed exactly once", async () => {
  const fs2 = await import("node:fs");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const { run } = await import("../tools/exercise-catalog/build-catalog.js");
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), "apogee-audit-test-"));
  try {
    const bytes = fs2.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs2.writeFileSync(input, bytes);
    const pin = path.join(dir, "pin.json");
    fs2.writeFileSync(pin, JSON.stringify({ repo: "fixture", file: "sample-110.json", commit: "none", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: 110 }));
    const all = JSON.parse(fs2.readFileSync(path.join(here, "..", "tools", "exercise-catalog", "overrides.json"), "utf8"));
    const overridesFile = path.join(dir, "overrides.json");
    fs2.writeFileSync(overridesFile, JSON.stringify(Object.fromEntries(["Bench_Press_-_With_Bands", "Chair_Squat", "Split_Squats", "Squats_-_With_Bands"].map((id) => [id, all[id]]))));
    fs2.writeFileSync(path.join(dir, "pairs.json"), "{}"); // no seed pairs: the real ones name upstream entries the 110-entry fixture does not have
    const args = (name) => ["--input", input, "--pin", pin, "--overrides", overridesFile, "--pairs", path.join(dir, "pairs.json"), "--out", path.join(dir, name)];
    run(args("a"));
    run(args("b"));
    for (const file of ["families.md", "outliers.md"]) {
      assert.ok(fs2.readFileSync(path.join(dir, "a", file)).equals(fs2.readFileSync(path.join(dir, "b", file))), `${file} differs between runs`);
    }
    const catalog = JSON.parse(fs2.readFileSync(path.join(dir, "a", "catalog.json"), "utf8")).exercises.filter((e) => e.baseMovementId !== null);
    const listed = fs2.readFileSync(path.join(dir, "a", "families.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(" | ")[0]);
    assert.deepEqual([...listed].sort(), catalog.map((e) => e.name).sort());
    assert.match(fs2.readFileSync(path.join(dir, "a", "outliers.md"), "utf8"), /not a verdict/);
    assert.match(fs2.readFileSync(path.join(dir, "a", "outliers.md"), "utf8"), /defined in vocab.json that no entry uses/);
    // "Clean Deadlift" contains the family word "clean" but is a deadlift: the nearly-caught list must find it.
    assert.match(fs2.readFileSync(path.join(dir, "a", "outliers.md"), "utf8"), /\| clean \| Clean Deadlift \| deadlift \|/);
  } finally {
    fs2.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- grip tags and the equipment overrides ----

test("families: a grip tag needs the word grip in the name (Narrow Stance Leg Press and Reverse Hyperextension get none), and Close-Grip, Wide-Grip and Reverse Grip names still do", () => {
  const result = curate({
    upstream: [
      upstream("Press", "Narrow Stance Leg Press", { equipment: "machine" }),
      upstream("Hyper", "Reverse Hyperextension", { equipment: "machine", primaryMuscles: ["hamstrings"] }),
      upstream("Crunch", "Reverse Crunch", { primaryMuscles: ["abdominals"] }),
      upstream("Close", "Close-Grip Front Lat Pulldown", { equipment: "cable", primaryMuscles: ["lats"] }),
      upstream("Wide", "Wide-Grip Lat Pulldown", { equipment: "cable", primaryMuscles: ["lats"] }),
      upstream("Rev", "Reverse Grip Bent-Over Rows", { equipment: "barbell", primaryMuscles: ["middle back"] }),
      upstream("Narrow", "Narrow Grip Seated Row", { equipment: "cable", primaryMuscles: ["middle back"] }),
      // an approved bench-rule entry keeps the tag it was approved with, whatever its name says
      upstream("RevBench", "Reverse Triceps Bench Press", { equipment: "barbell", primaryMuscles: ["triceps"] }),
    ],
    vocabulary,
  });
  const tags = (id) => entryOf(result, id).variations;
  assert.deepEqual(tags("Press"), ["narrow-stance"]);
  assert.deepEqual(tags("Hyper"), []);
  assert.deepEqual(tags("Crunch"), []);
  assert.deepEqual(tags("Close"), ["close-grip", "front"]);
  assert.deepEqual(tags("Wide"), ["wide-grip"]);
  assert.ok(tags("Rev").includes("reverse-grip"));
  assert.ok(tags("Narrow").includes("narrow-grip"));
  assert.ok(tags("RevBench").includes("reverse-grip"));
  // no family entry anywhere gets a grip tag without the word grip in its name
  for (const e of result.entries) {
    if (e.id !== "RevBench" && e.variations.some((v) => v.endsWith("-grip"))) assert.match(e.name.toLowerCase(), /grip/, e.name);
  }
});

test("catalog: the equipment overrides for chain press, dips, box jumps, drills and parallel-bar raises are in overrides.json, each with a note", () => {
  const all = JSON.parse(fs.readFileSync(path.join(here, "..", "tools", "exercise-catalog", "overrides.json"), "utf8"));
  const want = {
    Chain_Press: "barbell",
    "Dips_-_Chest_Version": "bodyweight", Parallel_Bar_Dip: "bodyweight", Ring_Dips: "bodyweight", Weighted_Bench_Dip: "bodyweight",
    Box_Jump_Multiple_Response: "bodyweight", Box_Skip: "bodyweight", Front_Box_Jump: "bodyweight", Lateral_Box_Jump: "bodyweight",
    Bench_Sprint: "bodyweight", Carioca_Quick_Step: "bodyweight", Side_to_Side_Box_Shuffle: "bodyweight",
    Knee_Hip_Raise_On_Parallel_Bars: "bodyweight",
  };
  for (const [id, equipment] of Object.entries(want)) {
    assert.deepEqual(Object.keys(all[id] ?? {}).sort(), ["equipment", "note"], id);
    assert.equal(all[id].equipment, equipment, id);
    assert.ok(all[id].note.length > 20, id);
  }
  // equipment only: the tags follow from it, so a barbell loaded with chains is a barbell and bench
  const stub = curate({ upstream: [upstream("Chain_Press", "Chain Press", { equipment: "other", primaryMuscles: ["chest"] })], overrides: { Chain_Press: all.Chain_Press }, vocabulary });
  assert.equal(stub.entries[0].equipment, "barbell");
  assert.equal(stub.entries[0].baseMovementId, "bench-press");
});

test("catalog: the five reverse curls keep reverse-grip by override, with their other tags, while reverse crunch, reverse hyperextension and reverse flyes do not have it", () => {
  const all = JSON.parse(fs.readFileSync(path.join(here, "..", "tools", "exercise-catalog", "overrides.json"), "utf8"));
  const curls = [
    ["Reverse_Barbell_Curl", "Reverse Barbell Curl", "barbell", ["reverse-grip"]],
    ["Reverse_Barbell_Preacher_Curls", "Reverse Barbell Preacher Curls", "e-z curl bar", ["preacher", "reverse-grip"]],
    ["Reverse_Cable_Curl", "Reverse Cable Curl", "cable", ["reverse-grip"]],
    ["Reverse_Plate_Curls", "Reverse Plate Curls", "other", ["reverse-grip"]],
    ["Standing_Dumbbell_Reverse_Curl", "Standing Dumbbell Reverse Curl", "dumbbell", ["reverse-grip", "standing"]],
  ];
  for (const [id, , , tags] of curls) {
    assert.deepEqual(Object.keys(all[id] ?? {}).sort(), ["note", "variations"], id);
    assert.deepEqual(all[id].variations, tags, id);
  }
  const others = [
    upstream("Reverse_Crunch", "Reverse Crunch", { primaryMuscles: ["abdominals"] }),
    upstream("Reverse_Hyperextension", "Reverse Hyperextension", { equipment: "machine", primaryMuscles: ["hamstrings"] }),
    upstream("Reverse_Flyes", "Reverse Flyes", { equipment: "dumbbell", primaryMuscles: ["shoulders"] }),
  ];
  const stubs = curls.map(([id, name, equipment]) => upstream(id, name, { equipment, primaryMuscles: ["biceps"] }));
  const overrides = Object.fromEntries(curls.map(([id]) => [id, all[id]]));
  const result = curate({ upstream: [...stubs, ...others], overrides, vocabulary });
  for (const [id, , , tags] of curls) {
    assert.equal(entryOf(result, id).baseMovementId, "curl", id);
    assert.deepEqual(entryOf(result, id).variations, tags, id);
  }
  for (const e of others) assert.ok(!entryOf(result, e.id).variations.includes("reverse-grip"), e.id);
});
