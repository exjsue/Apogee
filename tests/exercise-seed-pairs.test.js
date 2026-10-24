// The confirmed pairs between the app's seed exercises and upstream catalog entries
// (tools/exercise-catalog/confirmed-seed-pairs.json). A wrong pair leaves out the wrong upstream entry
// and silently ties a seed's history to a different exercise, so the pairs are checked against the real seed ids.
//
// The full upstream file is pinned but not stored in the repo (only a 110-entry fixture is), so the check
// that every upstream id exists runs when EXERCISE_CATALOG_INPUT names the pinned file, and is reported as
// skipped otherwise. The build itself always checks it and stops if an id does not exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { SEED_EXERCISES } from "../src/domain/seed.js";
import { run } from "../tools/exercise-catalog/build-catalog.js";
import { curate } from "../tools/exercise-catalog/lib/curate.js";
import { loadVocabulary } from "../tools/exercise-catalog/lib/vocabulary.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, "..", "tools", "exercise-catalog");
const pairs = JSON.parse(fs.readFileSync(path.join(TOOL, "confirmed-seed-pairs.json"), "utf8"));
const pin = JSON.parse(fs.readFileSync(path.join(TOOL, "input-pin.json"), "utf8"));
const FIXTURES = path.join(here, "fixtures", "exercise-catalog");

// Tests that need the full pinned upstream file (it is not in the repo) say how to turn them on.
const SKIP_MESSAGE = "skipped: set the environment variable EXERCISE_CATALOG_INPUT to the path of the pinned exercises.json, then run the tests again (PowerShell: $env:EXERCISE_CATALOG_INPUT = 'C:/path/to/exercises.json'; node --test; bash: EXERCISE_CATALOG_INPUT=/path/to/exercises.json node --test)";

test("seed pairs: exactly 15 pairs, every seed id is a real seed, no upstream id is used twice, and the lat pulldown is left unpaired on purpose", () => {
  const seedIds = new Set(SEED_EXERCISES.map((s) => s.id));
  assert.equal(Object.keys(pairs).length, 15);
  for (const [seedId, upstreamId] of Object.entries(pairs)) {
    assert.ok(seedIds.has(seedId), `${seedId} is not a seed id`);
    assert.match(upstreamId, /^[A-Za-z0-9_().-]+$/, `${upstreamId} does not look like an upstream id`);
  }
  assert.equal(new Set(Object.values(pairs)).size, 15);
  assert.equal(pairs["seed-lat-pulldown"], undefined);
  assert.equal(SEED_EXERCISES.length - Object.keys(pairs).length, 1); // the lat pulldown is the only unpaired seed
});

test("seed pairs: every paired upstream id exists in the pinned upstream file, including Standing_Military_Press", (t) => {
  const input = process.env.EXERCISE_CATALOG_INPUT;
  if (!input) return t.skip(SKIP_MESSAGE);
  const bytes = fs.readFileSync(input);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), pin.sha256, "the input is not the pinned file");
  const ids = new Set(JSON.parse(bytes.toString("utf8")).map((u) => u.id));
  for (const upstreamId of Object.values(pairs)) assert.ok(ids.has(upstreamId), `${upstreamId} is not an upstream id`);
  assert.ok(ids.has("Standing_Military_Press"));
});

// ---- the --pairs option of the build ----

// A copy of the 110-entry fixture and its pin in a temporary folder, with no overrides.
function withFixtureRun(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-pairs-test-"));
  try {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, bytes);
    const pinFile = path.join(dir, "pin.json");
    fs.writeFileSync(pinFile, JSON.stringify({
      repo: "fixture", file: "sample-110.json", commit: "none", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: 110,
    }));
    const overridesFile = path.join(dir, "overrides.json");
    fs.writeFileSync(overridesFile, "{}");
    const argsFor = (pairsFile, out) => ["--input", input, "--pin", pinFile, "--overrides", overridesFile, "--pairs", pairsFile, "--out", path.join(dir, out)];
    return body({ dir, bytes, argsFor });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("--pairs: a pairs file that names an upstream id the input does not have stops the build", () => {
  withFixtureRun(({ dir, argsFor }) => {
    const bad = path.join(dir, "bad-pairs.json");
    fs.writeFileSync(bad, JSON.stringify({ "seed-barbell-squat": "Not_In_The_Fixture" }));
    assert.throws(() => run(argsFor(bad, "out")), /does not match any upstream id/);
    // and one that names a real upstream id but not a seed record
    const notSeed = path.join(dir, "not-seed-pairs.json");
    fs.writeFileSync(notSeed, JSON.stringify({ "seed-nothing": "Barbell_Squat" }));
    assert.throws(() => run(argsFor(notSeed, "out2")), /not a seed record/);
  });
});

test("--pairs: an empty pairs file leaves nothing out and gives the same bytes as the build did before any pair existed", () => {
  withFixtureRun(({ dir, argsFor }) => {
    const compact = path.join(dir, "empty-a.json");
    const spaced = path.join(dir, "empty-b.json");
    fs.writeFileSync(compact, "{}");
    fs.writeFileSync(spaced, "{\n}\n");
    run(argsFor(compact, "a"));
    run(argsFor(spaced, "b"));
    const names = fs.readdirSync(path.join(dir, "a")).sort();
    assert.deepEqual(names, fs.readdirSync(path.join(dir, "b")).sort());
    for (const name of names) assert.ok(fs.readFileSync(path.join(dir, "a", name)).equals(fs.readFileSync(path.join(dir, "b", name))), `${name} differs`);
    // nothing is left out for pairs, and the entries are exactly what curating the input with no pairs gives
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "a", "catalog.json"), "utf8"));
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-110.json"), "utf8"));
    const direct = curate({ upstream: fixture, overrides: {}, vocabulary: loadVocabulary() }).entries;
    assert.deepEqual(catalog.exercises, direct);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "a", "summary.json"), "utf8")).excludedForSeeds, 0);
  });
});

test("--pairs: a pair that names a fixture entry leaves out exactly that entry", () => {
  withFixtureRun(({ dir, argsFor }) => {
    const one = path.join(dir, "one-pair.json");
    fs.writeFileSync(one, JSON.stringify({ "seed-barbell-squat": "Barbell_Squat" }));
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(empty, "{}");
    run(argsFor(one, "with"));
    run(argsFor(empty, "without"));
    const ids = (folder) => JSON.parse(fs.readFileSync(path.join(dir, folder, "catalog.json"), "utf8")).exercises.map((e) => e.id);
    assert.deepEqual(ids("without").filter((id) => !ids("with").includes(id)), ["Barbell_Squat"]);
    assert.equal(ids("with").length, ids("without").length - 1);
  });
});

test("the default pairs file: on the pinned input, a build without --pairs leaves out exactly the 15 paired entries", (t) => {
  const input = process.env.EXERCISE_CATALOG_INPUT;
  if (!input) return t.skip(SKIP_MESSAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-pairs-real-"));
  try {
    const none = path.join(dir, "none.json");
    fs.writeFileSync(none, "{}");
    run(["--input", input, "--pairs", none, "--out", path.join(dir, "unpaired")]);
    run(["--input", input, "--out", path.join(dir, "paired")]);
    const ids = (folder) => JSON.parse(fs.readFileSync(path.join(dir, folder, "catalog.json"), "utf8")).exercises.map((e) => e.id);
    const withPairs = new Set(ids("paired"));
    const left = ids("unpaired").filter((id) => !withPairs.has(id));
    assert.deepEqual([...left].sort(), Object.values(pairs).sort());
    assert.equal(ids("unpaired").length - ids("paired").length, 15);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "paired", "summary.json"), "utf8")).excludedForSeeds, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
