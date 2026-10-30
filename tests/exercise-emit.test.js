// The generated catalog module (src/catalog/) written by build-catalog.js --emit. The app will ship it and a
// history will point at its ids for good, so the checks that matter are: the module says what the pipeline
// decided, an id never silently disappears, nothing is written outside src/catalog/, and the committed file is
// exactly what a fresh run writes. Tests write to a temporary folder through the run() option; the real
// src/catalog is only read.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../tools/exercise-catalog/build-catalog.js";
import { buildEmission } from "../tools/exercise-catalog/lib/emit.js";
import { curate } from "../tools/exercise-catalog/lib/curate.js";
import { loadVocabulary } from "../tools/exercise-catalog/lib/vocabulary.js";
import { findPrecacheFiles } from "../tools/build-sw-manifest.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const FIXTURES = path.join(here, "fixtures", "exercise-catalog");
const REAL = path.join(ROOT, "src", "catalog");
const vocabulary = loadVocabulary();
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-110.json"), "utf8"));
const TURKISH = "Kettlebell_Turkish_Get-Up_Squat_style"; // has no placeable shoulder head, so it has no primary muscle

// Tests that need the full pinned upstream file (it is not in the repo) say how to turn them on.
const SKIP_MESSAGE = "skipped: set the environment variable EXERCISE_CATALOG_INPUT to the path of the pinned exercises.json, then run the tests again (PowerShell: $env:EXERCISE_CATALOG_INPUT = 'C:/path/to/exercises.json'; node --test; bash: EXERCISE_CATALOG_INPUT=/path/to/exercises.json node --test)";

// The two seeds the fixture run must group: one paired with a fixture entry, one set by hand.
const SEEDS = SEED_EXERCISES.filter((s) => ["seed-barbell-squat", "seed-lat-pulldown"].includes(s.id));
const PAIRS = { "seed-barbell-squat": "Barbell_Squat" };

// A temporary folder with the 110-entry fixture, its pin, and files for overrides, pairs and retired ids.
async function withFixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-emit-test-"));
  try {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, bytes);
    const pin = path.join(dir, "pin.json");
    fs.writeFileSync(pin, JSON.stringify({
      repo: "fixture", file: "sample-110.json", commit: "abc123", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: 110,
    }));
    const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
    const emitFolder = path.join(dir, "emitted");
    let counter = 0;
    // overrides: ids to leave out; retired: the retired.json content
    const emit = ({ exclude = [TURKISH], retired = {}, pairs = PAIRS } = {}) => {
      counter += 1;
      const overrides = Object.fromEntries(exclude.map((id) => [id, { exclude: true, note: "left out for the test" }]));
      return run([
        "--input", input, "--pin", pin, "--overrides", write(`overrides-${counter}.json`, overrides), "--pairs", write(`pairs-${counter}.json`, pairs),
        "--retired", write(`retired-${counter}.json`, retired), "--out", path.join(dir, `out-${counter}`), "--emit", emitFolder,
      ], { emitFolder, emitSeeds: SEEDS });
    };
    return await body({ dir, emitFolder, emit, outOf: (n) => path.join(dir, `out-${n}`) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Imports a generated file as a real ES module (a copy named .mjs, because a temporary folder has no package.json).
async function load(dir, file) {
  const copy = path.join(dir, `${crypto.randomUUID()}-${file.replace(/\.js$/, "")}.mjs`);
  fs.copyFileSync(path.join(dir, "emitted", file), copy);
  return import(pathToFileURL(copy).href);
}

const text = (folder, name) => fs.readFileSync(path.join(folder, name), "utf8");

// ---- what is written ----

test("emit: catalog.js is a module whose entries match catalog.json field for field, sorted by id, within the vocabularies", async () => {
  await withFixture(async ({ dir, emitFolder, emit, outOf }) => {
    emit();
    const module = await load(dir, "catalog.js");
    assert.equal(module.CATALOG_VERSION, 1);
    const catalog = JSON.parse(text(outOf(1), "catalog.json")).exercises.filter((e) => e.id !== "Barbell_Squat"); // the paired entry is left out
    assert.equal(module.CATALOG.length, catalog.length);
    for (const [i, e] of catalog.entries()) {
      assert.deepEqual(Object.keys(module.CATALOG[i]).sort(), ["baseMovementId", "catalogVersion", "equipment", "equipmentTags", "id", "name", "origin", "primaryMuscles", "retired", "secondaryMuscles", "variations"]);
      for (const key of ["id", "name", "primaryMuscles", "secondaryMuscles", "equipmentTags", "equipment", "baseMovementId", "variations", "origin"]) {
        assert.deepEqual(module.CATALOG[i][key], e[key], `${e.id}.${key}`);
      }
      assert.equal(module.CATALOG[i].catalogVersion, 1);
      assert.equal(module.CATALOG[i].retired, false);
    }
    const ids = module.CATALOG.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, [...ids].sort());
    for (const e of module.CATALOG) {
      assert.ok(e.primaryMuscles.length > 0, e.id);
      for (const m of [...e.primaryMuscles, ...e.secondaryMuscles]) assert.ok(vocabulary.muscles.includes(m), `${e.id}: ${m}`);
      for (const t of [e.equipment, ...e.equipmentTags]) assert.ok(vocabulary.equipment.includes(t), `${e.id}: ${t}`);
      assert.ok(e.baseMovementId === null || vocabulary.baseMovements.includes(e.baseMovementId), e.id);
      for (const v of e.variations) assert.ok(vocabulary.variations.includes(v), `${e.id}: ${v}`);
    }
    // the exported vocabularies are exactly the values used
    assert.deepEqual(module.MUSCLE_IDS, [...new Set(module.CATALOG.flatMap((e) => [...e.primaryMuscles, ...e.secondaryMuscles]))].sort());
    assert.deepEqual(module.EQUIPMENT_IDS, [...new Set(module.CATALOG.flatMap((e) => [e.equipment, ...e.equipmentTags]))].sort());
    assert.ok(fs.existsSync(path.join(emitFolder, "NOTICE.md")));
    // catalog-info.js: the version and the number of entries, nothing else
    const info = text(emitFolder, "catalog-info.js");
    assert.ok(info.includes(`export const CATALOG_VERSION = ${module.CATALOG_VERSION};`));
    assert.ok(info.includes(`export const CATALOG_COUNT = ${module.CATALOG.length};`));
    assert.ok(!/https?:\/\//.test(info));
    assert.deepEqual(fs.readdirSync(emitFolder).sort(), ["NOTICE.md", "catalog-info.js", "catalog.js", "secondary-weights.js", "seed-grouping.js"]);
  });
});

test("emit: seed-grouping.js has the grouping fields only, from the paired entry or set by hand, and the paired entry is not in the catalog", async () => {
  await withFixture(async ({ dir, emit }) => {
    emit();
    const { SEED_GROUPING } = await load(dir, "seed-grouping.js");
    const { CATALOG } = await load(dir, "catalog.js");
    assert.deepEqual(SEED_GROUPING.map((g) => g.seedId), ["seed-barbell-squat", "seed-lat-pulldown"]);
    for (const g of SEED_GROUPING) assert.deepEqual(Object.keys(g).sort(), ["baseMovementId", "equipment", "seedId", "upstreamId", "variations"]); // no name, no muscles
    const squat = curate({ upstream: fixture, overrides: {}, vocabulary }).entries.find((e) => e.id === "Barbell_Squat");
    assert.deepEqual(SEED_GROUPING[0], { baseMovementId: squat.baseMovementId, equipment: squat.equipment, seedId: "seed-barbell-squat", upstreamId: "Barbell_Squat", variations: squat.variations });
    assert.deepEqual(SEED_GROUPING[1], { baseMovementId: "pulldown", equipment: "cable", seedId: "seed-lat-pulldown", upstreamId: null, variations: [] });
    assert.ok(!CATALOG.some((e) => e.id === "Barbell_Squat"));
  });
});

test("emit: the generated files hold no web address, and the notice names the commit, the Unlicense and what it covers", async () => {
  await withFixture(({ emitFolder, emit }) => {
    emit();
    const folders = [emitFolder, ...(fs.existsSync(REAL) ? [REAL] : [])];
    for (const folder of folders) {
      for (const name of fs.readdirSync(folder)) {
        assert.doesNotMatch(text(folder, name), /https?:\/\/|www\.|\bftp:\/\//i, `${path.basename(folder)}/${name} has a web address`);
      }
    }
    const notice = text(emitFolder, "NOTICE.md");
    assert.match(notice, /abc123/);
    assert.match(notice, /Unlicense/);
    assert.match(notice, /only the entries with origin upstream/);
    assert.match(notice, /public domain/);
    assert.match(text(emitFolder, "catalog.js"), /Catalog version 1\. Entries: \d+\./);
  });
});

test("emit: --emit refuses any folder other than src/catalog, inside or outside the repo, and writes nothing", async () => {
  await withFixture(({ dir }) => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, bytes);
    for (const target of [path.join(dir, "elsewhere"), path.join(ROOT, "src", "domain"), path.join(ROOT, "src"), path.join(ROOT, "src", "catalog", "..", "ui")]) {
      assert.throws(() => run(["--input", input, "--out", path.join(dir, "out"), "--emit", target]), /refuses any other folder/, target);
      assert.ok(!fs.existsSync(path.join(dir, "elsewhere")));
    }
    assert.ok(!fs.existsSync(path.join(dir, "out")), "refused before any output was written");
  });
});

// ---- repeatable ----

test("emit: a second run, over the first run's files or into a fresh folder, writes the same bytes", async () => {
  await withFixture(({ emitFolder, emit }) => {
    emit();
    const first = Object.fromEntries(fs.readdirSync(emitFolder).map((name) => [name, fs.readFileSync(path.join(emitFolder, name))]));
    emit(); // reads the first run's catalog.js as the previous one
    for (const [name, bytes] of Object.entries(first)) assert.ok(bytes.equals(fs.readFileSync(path.join(emitFolder, name))), `${name} changed on the second run`);
    fs.rmSync(emitFolder, { recursive: true });
    emit(); // no previous file
    for (const [name, bytes] of Object.entries(first)) assert.ok(bytes.equals(fs.readFileSync(path.join(emitFolder, name))), `${name} differs in a fresh folder`);
    for (const name of Object.keys(first)) assert.ok(!/\r|\u0000/.test(first[name].toString("utf8")), `${name} has a carriage return`);
  });
});

// ---- ids never disappear ----

test("emit: an id that was in the previous catalog.js and is gone stops the emit, a listed one is kept as retired, and a new id passes", async () => {
  await withFixture(async ({ dir, emitFolder, emit }) => {
    const GONE = "Chair_Squat";
    // run 1 leaves the id out; run 2 brings it back: a new id passes
    emit({ exclude: [TURKISH, GONE] });
    assert.ok(!text(emitFolder, "catalog.js").includes(`"id":"${GONE}"`));
    emit({ exclude: [TURKISH] });
    assert.ok(text(emitFolder, "catalog.js").includes(`"id":"${GONE}"`));
    const before = text(emitFolder, "catalog.js");

    // run 3 would drop it: refused, with the id named, and the files are untouched
    assert.throws(() => emit({ exclude: [TURKISH, GONE] }), (error) => /ids are permanent/i.test(error.message) && error.message.includes(GONE) && error.message.includes("retired.json"));
    assert.equal(text(emitFolder, "catalog.js"), before);

    // run 4 lists it: kept, with its previous record, marked retired
    emit({ exclude: [TURKISH, GONE], retired: { [GONE]: "left out for the test" } });
    const { CATALOG } = await load(dir, "catalog.js");
    const kept = CATALOG.find((e) => e.id === GONE);
    const previous = JSON.parse(before.slice(before.indexOf("\n  {\"") + 1).split("\n").find((l) => l.includes(`"id":"${GONE}"`)).trim().replace(/,$/, ""));
    assert.equal(kept.retired, true);
    assert.deepEqual({ ...kept, retired: false }, previous);
    assert.equal(CATALOG.filter((e) => e.retired).length, 1);

  });
});

test("emit: retired.json may not name an id that never existed or give no reason", async () => {
  await withFixture(({ emit }) => {
    assert.throws(() => emit({ retired: { Never_Existed: "reason" } }), /not an id in the previous or the new catalog/);
    assert.throws(() => emit({ retired: { Chair_Squat: " " } }), /needs a reason/);
  });
});

// ---- what stops the emit ----

test("emit: an entry with no primary muscle stops it before anything is written, and so does a value outside the lists", async () => {
  await withFixture(({ dir, emitFolder, emit }) => {
    assert.throws(() => emit({ exclude: [] }), /no primary muscle/);
    assert.ok(!fs.existsSync(emitFolder), "nothing was written");
  });
  const base = { id: "X", name: "X", primaryMuscles: ["chest"], secondaryMuscles: [], equipment: "barbell", equipmentTags: ["barbell"], baseMovementId: null, variations: [], origin: "upstream" };
  const call = (entry) => buildEmission({ entries: [entry], pairedEntries: [], pairs: {}, manual: {}, seeds: [], vocabulary, pin: { repo: "r", file: "f", commit: "c" } });
  assert.doesNotThrow(() => call(base));
  assert.throws(() => call({ ...base, equipment: "spaceship", equipmentTags: ["spaceship"] }), /not in the equipment list/);
  assert.throws(() => call({ ...base, primaryMuscles: ["elbow"] }), /not in the muscle list/);
  assert.throws(() => call({ ...base, variations: ["spinning"] }), /not in vocab.json/);
  assert.throws(() => call({ ...base, origin: "elsewhere" }), /origin/);
  assert.throws(() => buildEmission({ entries: [base, base], pairedEntries: [], pairs: {}, manual: {}, seeds: [], vocabulary, pin: { repo: "r", file: "f", commit: "c" } }), /appears twice/);
  // a seed that is neither paired nor set by hand stops it
  assert.throws(() => buildEmission({ entries: [base], pairedEntries: [], pairs: {}, manual: {}, seeds: SEEDS, vocabulary, pin: { repo: "r", file: "f", commit: "c" } }), /neither paired nor set by hand/);
});

// ---- the app loads it only through the library service ----

// seed-grouping.js is used by the seed code; catalog.js and catalog-info.js only by the library service, which
// src/ui/main.js imports (commit 6).
const MAY_IMPORT_SEED_GROUPING = ["src/domain/seed.js", "src/storage/migrations.js"]; // migrations.js comes with schema version 3
// The one file allowed to refer to catalog.js and catalog-info.js (an exact path, not a pattern).
const CATALOG_SERVICE = "src/app/catalog.js";
// The one file allowed to import the service, and the exact import statement it uses.
const CATALOG_SERVICE_IMPORT = 'import { createCatalogService, startAfterFirstPaint, resyncAfterImport } from "../app/catalog.js";';

test("emit: only the library service imports catalog.js and catalog-info.js, only main.js imports the service (exact path), only the seed code imports seed-grouping.js, and the service worker precaches all three", () => {
  const referring = (pattern) => {
    const found = [];
    const walk = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) { if (full !== REAL) walk(full); } else if (/\.(js|html)$/.test(entry.name) && pattern.test(fs.readFileSync(full, "utf8"))) found.push(path.relative(ROOT, full).replaceAll("\\", "/"));
      }
    };
    walk(path.join(ROOT, "src"));
    for (const file of ["index.html", "sw.js"]) if (pattern.test(fs.readFileSync(path.join(ROOT, file), "utf8"))) found.push(file);
    return found.sort();
  };
  // catalog.js and catalog-info.js: referred to by exactly one file, the library service. Any other file under
  // src/ that refers to them fails here.
  assert.deepEqual(referring(/catalog\/catalog(\.js)?["']/), [CATALOG_SERVICE]);
  assert.deepEqual(referring(/catalog-info/), [CATALOG_SERVICE]);
  // Commit 6 flipped this on purpose (it used to assert the service was NOT reachable from main.js): main.js
  // imports the service with exactly this statement, and no other file imports it.
  assert.deepEqual(referring(/app\/catalog(\.js)?["']/), ["src/ui/main.js"]);
  const mainLines = fs.readFileSync(path.join(ROOT, "src", "ui", "main.js"), "utf8").split(/\r?\n/);
  assert.deepEqual(mainLines.filter((line) => /["'][^"']*app\/catalog(\.js)?["']/.test(line)), [CATALOG_SERVICE_IMPORT]);
  assert.ok(findPrecacheFiles().includes(CATALOG_SERVICE), `${CATALOG_SERVICE} is not reachable from main.js`);
  const groupingUsers = referring(/seed-grouping/);
  assert.ok(groupingUsers.length > 0 && groupingUsers.every((file) => MAY_IMPORT_SEED_GROUPING.includes(file)), `seed-grouping.js is used by: ${groupingUsers.join(", ")}`);
  assert.deepEqual(findPrecacheFiles().filter((f) => f.includes("catalog")), [
    "src/app/catalog.js", "src/catalog/catalog-info.js", "src/catalog/catalog.js", "src/catalog/secondary-weights.js", "src/catalog/seed-grouping.js", "src/storage/catalog-store.js",
  ]);
  const manifest = fs.readFileSync(path.join(ROOT, "sw-manifest.js"), "utf8");
  for (const file of ["seed-grouping.js", "catalog.js", "catalog-info.js"]) assert.ok(manifest.includes(`"./src/catalog/${file}"`), file);
  assert.ok(manifest.includes('"./src/app/catalog.js"'));
});

// ---- the committed module is what a fresh run writes ----

test("emit: on the pinned input, a fresh run writes exactly the committed src/catalog files", (t) => {
  const input = process.env.EXERCISE_CATALOG_INPUT;
  if (!input) return t.skip(SKIP_MESSAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-emit-real-"));
  try {
    const emitFolder = path.join(dir, "emitted");
    run(["--input", input, "--out", path.join(dir, "out"), "--emit", emitFolder, "--strict"], { emitFolder });
    assert.deepEqual(fs.readdirSync(emitFolder).sort(), fs.readdirSync(REAL).sort());
    for (const name of fs.readdirSync(REAL)) {
      assert.ok(fs.readFileSync(path.join(REAL, name)).equals(fs.readFileSync(path.join(emitFolder, name))), `${name} is not what a fresh run writes; run the build with --emit and commit the result`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("emit: an upstream entry that a seed now owns counts as dropped, so it needs a retired.json entry", () => {
  const entry = (id) => ({ id, name: id, primaryMuscles: ["chest"], secondaryMuscles: [], equipment: "barbell", equipmentTags: ["barbell"], baseMovementId: "bench-press", variations: [], origin: "upstream" });
  const previous = [{ ...entry("Kept"), catalogVersion: 1, retired: false }, { ...entry("Now_Paired"), catalogVersion: 1, retired: false }];
  const call = (retired) => buildEmission({
    entries: [entry("Kept")], pairedEntries: [entry("Now_Paired")], pairs: { "seed-barbell-squat": "Now_Paired" }, manual: {}, seeds: SEEDS.filter((s) => s.id === "seed-barbell-squat"),
    vocabulary, pin: { repo: "r", file: "f", commit: "c" }, previous, retired,
  });
  assert.throws(() => call({}), /Now_Paired/);
  const emitted = call({ Now_Paired: "a seed owns it now" });
  assert.deepEqual(emitted.summary.retiredKept, ["Now_Paired"]);
  assert.match(emitted.files[0].text, /"id":"Now_Paired".*"retired":true/);
});

test("emit: a hand-written addition is emitted with origin authored, keeps its apogee- id, and its retired flag, with no quoted app database name in the files", async () => {
  await withFixture(async ({ dir, emitFolder }) => {
    const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const pin = JSON.parse(fs.readFileSync(path.join(dir, "pin.json"), "utf8"));
    assert.equal(pin.bytes, bytes.length);
    run([
      "--input", path.join(dir, "input.json"), "--pin", path.join(dir, "pin.json"), "--overrides", write("o.json", { [TURKISH]: { exclude: true, note: "left out for the test" } }),
      "--pairs", write("p.json", PAIRS), "--retired", write("r.json", {}), "--additions", path.join(FIXTURES, "additions-sample.txt"),
      "--out", path.join(dir, "out"), "--emit", emitFolder,
    ], { emitFolder, emitSeeds: SEEDS });
    const { CATALOG } = await load(dir, "catalog.js");
    const mine = CATALOG.filter((e) => e.id.startsWith("apogee-"));
    assert.deepEqual(mine.map((e) => [e.id, e.origin, e.retired]), [["apogee-pin-squat", "authored", false], ["apogee-zercher-deadlift", "authored", true]]);
    assert.ok(CATALOG.filter((e) => !e.id.startsWith("apogee-")).every((e) => e.origin === "upstream"));
    for (const name of fs.readdirSync(emitFolder)) assert.doesNotMatch(text(emitFolder, name), /["']apogee["']/, `${name} has the quoted app database name`);
  });
});
