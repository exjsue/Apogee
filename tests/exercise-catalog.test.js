// The exercise catalog pipeline (tools/exercise-catalog). It turns the upstream list into builtin
// records, so a wrong result here means wrong names, muscles or equipment on every user's exercises.
// These tests check correctness against an approved table, the failures that must be loud, and that
// the tool is deterministic and offline. They use a 110-entry fixture, never the full upstream file.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { curate, entriesWithoutPrimary, stringify } from "../tools/exercise-catalog/lib/curate.js";
import { loadVocabulary } from "../tools/exercise-catalog/lib/vocabulary.js";
import { run } from "../tools/exercise-catalog/build-catalog.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const FIXTURES = path.join(here, "fixtures", "exercise-catalog");
const TOOL = path.join(ROOT, "tools", "exercise-catalog");
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-110.json"), "utf8"));
const overrides = JSON.parse(fs.readFileSync(path.join(TOOL, "overrides.json"), "utf8"));
const vocabulary = loadVocabulary();

// ---- the approved table ----

const MUSCLE_CODES = {
  ch: "chest", fd: "front_delts", bi: "biceps", tri: "triceps", fa: "forearms", tp: "traps", la: "lats", ub: "upper_back",
  lb: "lower_back", abs: "abs", gl: "glutes", qd: "quads", ham: "hamstrings", cv: "calves", add: "adductors", abd: "abductors",
};

// Rows the exact comparison skips, each with the reason. (None are missing from the table.)
const NOT_COMPARED = {
  Leverage_Deadlift: "the table gives the variation plate-loaded, which the decision on equipment (no plate-loaded or selectorized split) rules out",
};

function cleanCell(cell) {
  return cell.replace(/\s*\([^)]*\)/g, "").replace(/\*/g, "").trim();
}

function parseCodes(cell) {
  const text = cleanCell(cell);
  const muscles = [];
  let unplaced = 0;
  if (text === "-" || text === "") return { muscles, unplaced };
  for (const code of text.split(",")) {
    if (code === "fd?") unplaced += 1;
    else if (code in MUSCLE_CODES) muscles.push(MUSCLE_CODES[code]);
    else throw new Error(`unknown muscle code in the approved table: ${code}`);
  }
  return { muscles: muscles.sort(), unplaced };
}

function parseApprovedTable() {
  const rows = new Map();
  let base = null;
  for (const line of fs.readFileSync(path.join(FIXTURES, "approved-table.md"), "utf8").split("\n")) {
    const heading = /^## base=(.+)$/.exec(line);
    if (heading) base = heading[1];
    else if (/^## /.test(line)) base = null;
    if (!line.startsWith("|") || /^\|\s*(id|---)/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const withBase = base === null;
    const [id, rowBase, equipment, variations, primary, secondary] = withBase ? cells : [cells[0], base, ...cells.slice(1)];
    const tags = cleanCell(variations);
    rows.set(id, {
      base: cleanCell(rowBase),
      equipment: cleanCell(equipment),
      variations: tags === "-" || tags === "" ? [] : tags.split(",").sort(),
      primary: parseCodes(primary),
      secondary: parseCodes(secondary),
    });
  }
  return rows;
}

const approved = parseApprovedTable();
const curated = curate({ upstream: fixture, overrides, vocabulary });
const byId = new Map(curated.entries.map((e) => [e.id, e]));

const upstreamEntry = (extra) => ({
  id: "X", name: "Test", force: null, level: "beginner", mechanic: null, equipment: "barbell", primaryMuscles: ["chest"], secondaryMuscles: [], category: "strength", ...extra,
});

const plainCurate = (entries, extra = {}) => curate({ upstream: entries, vocabulary, ...extra });

// ---- correctness ----

test("catalog: the 110 sample entries come out exactly as the approved table says", () => {
  assert.equal(fixture.length, 110);
  assert.equal(approved.size, 110, "the approved table should have 110 rows");
  assert.deepEqual([...approved.keys()].sort(), fixture.map((e) => e.id).sort(), "the table and the fixture list the same entries");
  const differences = [];
  for (const [id, want] of approved) {
    if (id in NOT_COMPARED) continue;
    const got = byId.get(id);
    const check = (what, a, b) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${id}: ${what} is ${JSON.stringify(a)}, the table says ${JSON.stringify(b)}`);
    };
    check("base movement", got.baseMovementId, want.base);
    check("equipment", got.equipment, want.equipment);
    check("variations", got.variations, want.variations);
    check("primary muscles", got.primaryMuscles, want.primary.muscles);
    check("secondary muscles", got.secondaryMuscles, want.secondary.muscles);
    const unplaced = (got.unplacedMuscles ?? []).length;
    check("unplaced shoulders", unplaced, want.primary.unplaced + want.secondary.unplaced);
  }
  assert.deepEqual(differences, []);
});

test("catalog: every entry keeps its upstream id and name, uses only the controlled vocabularies and carries no text or images", () => {
  const problems = [];
  for (const e of curated.entries) {
    const source = fixture.find((u) => u.id === e.id);
    if (source === undefined) problems.push(`${e.id}: not an upstream id`);
    else if (e.name !== source.name) problems.push(`${e.id}: name changed without an override`);
    if (!vocabulary.equipment.includes(e.equipment)) problems.push(`${e.id}: equipment ${e.equipment}`);
    if (!e.equipmentTags.includes(e.equipment) || e.equipmentTags.some((t) => !vocabulary.equipment.includes(t))) problems.push(`${e.id}: equipment tags`);
    for (const m of [...e.primaryMuscles, ...e.secondaryMuscles]) if (!vocabulary.muscles.includes(m)) problems.push(`${e.id}: muscle ${m}`);
    if (e.secondaryMuscles.some((m) => e.primaryMuscles.includes(m))) problems.push(`${e.id}: a muscle is both primary and secondary`);
    if (e.baseMovementId !== null && !vocabulary.baseMovements.includes(e.baseMovementId)) problems.push(`${e.id}: base movement`);
    if (e.baseMovementId === null && e.variations.length > 0) problems.push(`${e.id}: variations without a base movement`);
    if (JSON.stringify(e.variations) !== JSON.stringify([...e.variations].sort()) || e.variations.some((v) => !vocabulary.variations.includes(v))) problems.push(`${e.id}: variations`);
    if (e.source !== "builtin") problems.push(`${e.id}: source`);
    if ("instructions" in e || "images" in e) problems.push(`${e.id}: instructions or images`);
  }
  assert.equal(new Set(curated.entries.map((e) => e.id)).size, curated.entries.length);
  assert.deepEqual(problems, []);
});

test("catalog: a name that merely contains squat, deadlift or press is not forced into that movement", () => {
  const result = plainCurate([
    upstreamEntry({ id: "Incline_Dumbbell_Press", name: "Incline Dumbbell Press", equipment: "dumbbell" }),
    upstreamEntry({ id: "Barbell_Step_Ups", name: "Barbell Step Ups", primaryMuscles: ["quadriceps"] }),
    upstreamEntry({ id: "Split_Jerk", name: "Split Jerk", primaryMuscles: ["shoulders"] }),
    upstreamEntry({ id: "Squat_Jerk_X", name: "Squat Jerk", primaryMuscles: ["quadriceps"] }),
    upstreamEntry({ id: "Good_Morning_X", name: "Good Morning", primaryMuscles: ["hamstrings"] }),
    upstreamEntry({ id: "TGU_Lunge", name: "Kettlebell Turkish Get-Up (Lunge style)", equipment: "kettlebells", primaryMuscles: ["shoulders"] }),
  ]);
  const base = Object.fromEntries(result.entries.map((e) => [e.id, e.baseMovementId]));
  assert.deepEqual(base, {
    Barbell_Step_Ups: null, Good_Morning_X: "good-morning", Incline_Dumbbell_Press: null, Split_Jerk: null, Squat_Jerk_X: "jerk", TGU_Lunge: "turkish-get-up",
  });
  for (const id of ["Incline_Dumbbell_Press", "Barbell_Step_Ups", "Split_Jerk"]) {
    assert.ok(result.review.find((r) => r.entry.id === id).reasons.includes("null-base-movement"), `${id} should be on the review list`);
  }
});

test("catalog: a shoulder is placed in a head only when the name says which, otherwise left unplaced and never guessed", () => {
  const result = plainCurate([
    upstreamEntry({ id: "Side_Raise", name: "Dumbbell Side Lateral Raise", equipment: "dumbbell", primaryMuscles: ["shoulders"] }),
    upstreamEntry({ id: "Rear_Fly", name: "Reverse Fly", equipment: "dumbbell", primaryMuscles: ["shoulders"] }),
    upstreamEntry({ id: "Circles", name: "Arm Circles", equipment: null, primaryMuscles: ["shoulders"], secondaryMuscles: ["chest"], category: "stretching" }),
    upstreamEntry({ id: "Twist", name: "Russian Twist", equipment: "body only", primaryMuscles: ["abdominals"] }),
    upstreamEntry({ id: "Crunch", name: "Crunch", equipment: "body only", primaryMuscles: ["abdominals"] }),
  ]);
  const e = Object.fromEntries(result.entries.map((x) => [x.id, x]));
  assert.deepEqual(e.Side_Raise.primaryMuscles, ["side_delts"]);
  assert.deepEqual(e.Rear_Fly.primaryMuscles, ["rear_delts"]);
  assert.deepEqual(e.Circles.primaryMuscles, []);
  assert.deepEqual(e.Circles.unplacedMuscles, [{ upstream: "shoulders", role: "primary" }]);
  assert.deepEqual(e.Twist.primaryMuscles, ["obliques"]);
  assert.deepEqual(e.Crunch.primaryMuscles, ["abs"]);
  assert.deepEqual(entriesWithoutPrimary(result.entries), ["Circles"]);
  assert.ok(result.review.find((r) => r.entry.id === "Circles").reasons.includes("empty-primary"));
});

// ---- failures that must be loud ----

test("catalog: an override whose id is not upstream fails", () => {
  assert.throws(
    () => plainCurate([upstreamEntry({ id: "A", name: "A" })], { overrides: { Missing_Id: { equipment: "barbell", note: "x" } } }),
    /override "Missing_Id" does not match any upstream id/,
  );
});

test("catalog: an override with a value outside the vocabularies, an unknown key or no note fails", () => {
  const attempt = (override) => () => plainCurate([upstreamEntry({ id: "A", name: "A" })], { overrides: { A: override } });
  assert.throws(attempt({ equipment: "skateboard", note: "x" }), /not a known equipment/);
  assert.throws(attempt({ primaryMuscles: ["pecs"], note: "x" }), /not a known muscle/);
  assert.throws(attempt({ baseMovementId: "yoga", note: "x" }), /not a known base movement/);
  assert.throws(attempt({ variations: ["wobbly"], note: "x" }), /not a known variation/);
  assert.throws(attempt({ equipmentTags: ["rack"], note: "x" }), /not a known equipment tag/);
  assert.throws(attempt({ colour: "red", note: "x" }), /unknown key/);
  assert.throws(attempt({ equipment: "barbell" }), /needs a note/);
  assert.throws(attempt({ primaryMuscles: ["chest"], secondaryMuscles: ["chest"], note: "x" }), /repeats a primary/);
});

test("catalog: two entries with the same upstream id fail", () => {
  assert.throws(() => plainCurate([upstreamEntry({ id: "Same", name: "One" }), upstreamEntry({ id: "Same", name: "Two" })]), /same upstream id: Same/);
});

test("catalog: a valid override changes only what it names and placing a shoulder clears it from the unplaced list", () => {
  const entries = [upstreamEntry({ id: "Circles", name: "Arm Circles", equipment: null, primaryMuscles: ["shoulders"], category: "stretching" })];
  const before = plainCurate(entries).entries[0];
  const after = plainCurate(entries, { overrides: { Circles: { primaryMuscles: ["side_delts"], note: "placed by hand" } } }).entries[0];
  assert.deepEqual(before.primaryMuscles, []);
  assert.deepEqual(after.primaryMuscles, ["side_delts"]);
  assert.equal(after.unplacedMuscles, undefined);
  assert.equal(after.equipment, before.equipment);
  assert.equal(after.name, before.name);
});

test("catalog: confirmed seed pairs are checked, and a confirmed upstream entry is left out of the catalog", () => {
  const entries = [upstreamEntry({ id: "A", name: "Bench" }), upstreamEntry({ id: "B", name: "Other" })];
  const seedId = SEED_EXERCISES[0].id;
  assert.throws(() => plainCurate(entries, { seeds: SEED_EXERCISES, confirmedPairs: { "seed-nope": "A" } }), /not a seed record/);
  assert.throws(() => plainCurate(entries, { seeds: SEED_EXERCISES, confirmedPairs: { [seedId]: "Nope" } }), /does not match any upstream id/);
  assert.throws(() => plainCurate(entries, { seeds: SEED_EXERCISES, confirmedPairs: { [seedId]: "A", [SEED_EXERCISES[1].id]: "A" } }), /paired with two seeds/);
  const result = plainCurate(entries, { seeds: SEED_EXERCISES, confirmedPairs: { [seedId]: "A" } });
  assert.deepEqual(result.entries.map((e) => e.id), ["B"]);
  assert.deepEqual(result.excludedForSeeds, [{ upstreamId: "A", seedId }]);
});

// ---- the command line tool: pin, location, strictness, determinism, no network ----

function withTempFiles(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-catalog-test-"));
  try {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, bytes);
    const pin = path.join(dir, "pin.json");
    fs.writeFileSync(pin, JSON.stringify({
      repo: "fixture", file: "sample-110.json", commit: "none", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: 110,
    }));
    return body({ dir, input, pin });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("catalog tool: it refuses an input that is not the pinned file and an output folder inside the repository", () => {
  withTempFiles(({ dir, input, pin }) => {
    assert.throws(() => run(["--input", input, "--out", path.join(dir, "out")]), /does not match the pinned file/);
    assert.throws(() => run(["--input", input, "--pin", pin, "--out", path.join(ROOT, "catalog-out")]), /outside the repository/);
    const changed = path.join(dir, "changed.json");
    fs.writeFileSync(changed, `${fs.readFileSync(input, "utf8")} `);
    assert.throws(() => run(["--input", changed, "--pin", pin, "--out", path.join(dir, "out")]), /does not match the pinned file/);
  });
});

test("catalog tool: --strict fails while an entry has no primary muscle, and the outputs are still written for review", () => {
  withTempFiles(({ dir, input, pin }) => {
    const out = path.join(dir, "out");
    assert.throws(() => run(["--input", input, "--pin", pin, "--out", out, "--strict"]), /--strict: \d+ entries have no primary muscle/);
    assert.ok(fs.existsSync(path.join(out, "catalog.json")));
    assert.doesNotThrow(() => run(["--input", input, "--pin", pin, "--out", path.join(dir, "out2")]));
  });
});

test("catalog tool: the same input gives byte-identical output, in process and on disk", () => {
  assert.equal(stringify(curate({ upstream: fixture, overrides, vocabulary })), stringify(curate({ upstream: [...fixture].reverse(), overrides, vocabulary })));
  withTempFiles(({ dir, input, pin }) => {
    run(["--input", input, "--pin", pin, "--out", path.join(dir, "a")]);
    run(["--input", input, "--pin", pin, "--out", path.join(dir, "b")]);
    const names = fs.readdirSync(path.join(dir, "a")).sort();
    assert.deepEqual(names, fs.readdirSync(path.join(dir, "b")).sort());
    assert.ok(names.includes("catalog.json") && names.includes("summary.txt") && names.some((n) => n.startsWith("review-")));
    for (const name of names) {
      assert.ok(fs.readFileSync(path.join(dir, "a", name)).equals(fs.readFileSync(path.join(dir, "b", name))), `${name} differs between runs`);
    }
  });
});

test("catalog tool: it makes no network call (no network modules in its source, and a run with the network blocked succeeds)", () => {
  const sources = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) sources.push(full);
    }
  };
  walk(TOOL);
  assert.ok(sources.length >= 8);
  const forbidden = [/node:https?\b/, /node:net\b/, /node:tls\b/, /node:dns\b/, /node:dgram\b/, /node:child_process/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /https?:\/\//];
  const found = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) found.push(`${path.relative(ROOT, file)}: ${pattern}`);
  }
  assert.deepEqual(found, []);

  withTempFiles(({ dir, input, pin }) => {
    const result = spawnSync(
      process.execPath,
      ["--import", pathToImport(path.join(FIXTURES, "no-network.mjs")), path.join(TOOL, "build-catalog.js"), "--input", input, "--pin", pin, "--out", path.join(dir, "out")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!/NETWORK ATTEMPT/.test(result.stderr));
    // The blocker itself works: a deliberate fetch under it is stopped.
    const probe = spawnSync(process.execPath, ["--import", pathToImport(path.join(FIXTURES, "no-network.mjs")), "-e", "fetch('x')"], { encoding: "utf8" });
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /NETWORK ATTEMPT/);
  });
});

function pathToImport(file) {
  return new URL(`file:///${file.replaceAll("\\", "/")}`).href;
}
