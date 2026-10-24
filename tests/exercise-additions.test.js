// The hand-written additions file of the exercise catalog pipeline (tools/exercise-catalog/additions.txt).
// A wrong id or a silent duplicate here would put a second copy of an exercise, or a clash with history,
// into every user's built-in list, so these tests cover the checks that must stop the build.
// They use two SAMPLE additions that live only in tests/fixtures; the real additions.txt stays empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { curate } from "../tools/exercise-catalog/lib/curate.js";
import { loadVocabulary } from "../tools/exercise-catalog/lib/vocabulary.js";
import {
  buildAdditions, parseAdditions, formatProblems, nameScore, slugFor, NAME_SIMILARITY, ORIGIN_UPSTREAM, ORIGIN_APOGEE,
} from "../tools/exercise-catalog/lib/additions.js";
import { run } from "../tools/exercise-catalog/build-catalog.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "exercise-catalog");
const TOOL = path.join(here, "..", "tools", "exercise-catalog");
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-110.json"), "utf8"));
const sampleText = fs.readFileSync(path.join(FIXTURES, "additions-sample.txt"), "utf8");
const templateText = fs.readFileSync(path.join(TOOL, "additions.txt"), "utf8");
const vocabulary = loadVocabulary();
const curated = curate({ upstream: fixture, overrides: {}, vocabulary }).entries;

const check = (text, extra = {}) => buildAdditions({ text, upstream: fixture, curated, seeds: SEED_EXERCISES, vocabulary, ...extra });
const whats = (result) => result.problems.map((p) => p.what);

// One block with every required field, to be changed a line at a time.
const block = (lines) => `${lines.join("\n")}\n`;
const GOOD = ["id: apogee-test-lift", "name: Zzz Mystery Lift", "base: deadlift", "equipment: barbell", "variations: pins", "primary: lower_back"];
const withLine = (lines, key, value) => lines.map((l) => (l.startsWith(`${key}:`) ? `${key}: ${value}` : l));
const withoutLine = (lines, key) => lines.filter((l) => !l.startsWith(`${key}:`));

// ---- merging ----

test("additions: valid additions are appended with origin apogee, source builtin and the derived fields", () => {
  const result = check(sampleText);
  assert.deepEqual(result.problems, []);
  assert.equal(result.entries.length, 2);
  const pin = result.entries.find((e) => e.id === "apogee-pin-squat");
  assert.equal(pin.origin, ORIGIN_APOGEE);
  assert.equal(pin.source, "builtin");
  assert.equal(pin.baseMovementId, "squat");
  assert.deepEqual(pin.equipmentTags, ["barbell"]);
  assert.deepEqual(pin.primaryMuscles, ["glutes", "quads"]); // sorted
  assert.deepEqual(pin.secondaryMuscles, ["hamstrings", "lower_back"]);
  assert.equal(pin.category, "strength"); // the default
  assert.equal(pin.unplacedMuscles, undefined);
  const zercher = result.entries.find((e) => e.id === "apogee-zercher-deadlift");
  assert.equal(zercher.retired, true);
  assert.equal(zercher.category, "powerlifting");
  assert.equal(zercher.level, null);
});

test("additions: through the build, upstream entries say origin upstream, additions come after them, and the notice limits the Unlicense statement", () => {
  withTempFiles(({ dir, input, pin, overridesFile }) => {
    const additions = path.join(dir, "additions.txt");
    fs.writeFileSync(additions, sampleText);
    const out = path.join(dir, "out");
    run(["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", additions, "--out", out]);
    const catalog = JSON.parse(fs.readFileSync(path.join(out, "catalog.json"), "utf8"));
    assert.equal(catalog.exercises.length, 112);
    assert.ok(catalog.exercises.slice(0, 110).every((e) => e.origin === ORIGIN_UPSTREAM));
    assert.deepEqual(catalog.exercises.slice(110).map((e) => [e.id, e.origin]), [["apogee-pin-squat", ORIGIN_APOGEE], ["apogee-zercher-deadlift", ORIGIN_APOGEE]]);
    assert.ok(catalog.notice.includes(`origin "${ORIGIN_UPSTREAM}"`) && catalog.notice.includes(`origin "${ORIGIN_APOGEE}"`));
    assert.match(catalog.notice, /Unlicense.*not covered/);
    assert.match(fs.readFileSync(path.join(out, "summary.txt"), "utf8"), /Hand-written additions \(origin apogee\): 2/);
  });
});

test("additions: a file with only the commented template adds nothing and leaves every output file identical to an empty file", () => {
  assert.deepEqual(parseAdditions(templateText), { blocks: [], problems: [] });
  assert.deepEqual(check(templateText), { entries: [], problems: [], warnings: [] });
  withTempFiles(({ dir, input, pin, overridesFile }) => {
    const empty = path.join(dir, "empty.txt");
    fs.writeFileSync(empty, "");
    const template = path.join(dir, "template.txt");
    fs.writeFileSync(template, templateText);
    run(["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", empty, "--out", path.join(dir, "a")]);
    run(["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", template, "--out", path.join(dir, "b")]);
    const names = fs.readdirSync(path.join(dir, "a")).sort();
    assert.deepEqual(names, fs.readdirSync(path.join(dir, "b")).sort());
    for (const name of names) assert.ok(fs.readFileSync(path.join(dir, "a", name)).equals(fs.readFileSync(path.join(dir, "b", name))), `${name} differs`);
  });
});

// ---- what must stop the build ----

test("additions: ids must be unique, start with apogee-, use only allowed characters, and never clash with upstream or seed ids", () => {
  const dup = check(`${sampleText}\n---\n${block(withLine(GOOD, "id", "apogee-pin-squat"))}`);
  assert.ok(whats(dup).some((w) => /already used by block 1/.test(w)));
  for (const bad of ["pin-squat", "apogee-Pin_Squat", "apogee-", "apogee--x", `apogee-${"a".repeat(80)}`]) {
    assert.ok(whats(check(block(withLine(GOOD, "id", bad)))).some((w) => /is not allowed/.test(w)), `${bad} should be refused`);
  }
  // An upstream id that starts with apogee- stops the build even with an empty file, and an addition may not reuse it.
  const hostile = [...fixture, { ...fixture[0], id: "apogee-pin-squat", name: "Something Else" }];
  assert.ok(whats(check("", { upstream: hostile })).some((w) => /starts with apogee-.*reserved/.test(w)));
  assert.ok(whats(check(sampleText, { upstream: hostile })).some((w) => /already an upstream exercise id/.test(w)));
  const seeded = check(block(withLine(GOOD, "id", "apogee-x")), { seeds: [{ id: "APOGEE-X", name: "Seed", primaryMuscles: [], equipmentTags: [] }] });
  assert.ok(whats(seeded).some((w) => /already a built-in seed exercise id/.test(w)));
});

test("additions: a missing required field, a value outside the vocabularies, an unknown base movement and a repeated muscle each stop the build, with the allowed values and the closest match", () => {
  for (const key of ["name", "base", "equipment", "primary"]) {
    const result = check(block(withoutLine(GOOD, key)));
    assert.ok(whats(result).some((w) => new RegExp(`required field "${key}" is missing`).test(w)), `${key} should be required`);
  }
  const equipment = check(block(withLine(GOOD, "equipment", "barbel"))).problems[0];
  assert.match(equipment.what, /equipment "barbel" is not allowed/);
  assert.match(equipment.allowed, /barbell/);
  assert.equal(equipment.closest, "barbell");
  assert.match(equipment.fix, /equipment: barbell/);
  assert.ok(whats(check(block(withLine(GOOD, "primary", "lower_back, quadz")))).some((w) => /muscle "quadz"/.test(w)));
  assert.ok(whats(check(block(withLine(GOOD, "variations", "pinz")))).some((w) => /variation "pinz"/.test(w)));
  assert.ok(whats(check(block([...GOOD, "category: yoga"]))).some((w) => /category "yoga"/.test(w)));
  const base = check(block(withLine(GOOD, "base", "juggling"))).problems[0];
  assert.match(base.what, /base movement "juggling" is not in vocab.json/);
  assert.match(base.fix, /add "juggling" to the baseMovements list in tools\/exercise-catalog\/vocab.json first/);
  assert.equal(check(block(withLine(GOOD, "base", "deadlifts"))).problems[0].closest, "deadlift");
  assert.ok(whats(check(block([...GOOD, "secondary: lower_back, glutes"]))).some((w) => /secondary muscle lower_back is also a primary muscle/.test(w)));
});

test("additions: the same base, equipment and variations as an existing entry stops the build and names that entry", () => {
  const lines = withLine(withLine(withLine(GOOD, "base", "squat"), "variations", "front"), "id", "apogee-front-thing");
  const result = check(block(withLine(lines, "variations", "front")));
  assert.ok(whats(result).some((w) => /exactly the same as "Front Barbell Squat" \(id Front_Barbell_Squat\)/.test(w)));
  // two additions with the same key
  const twice = check(`${sampleText}\n---\n${block(withLine(withLine(GOOD, "base", "squat"), "variations", "pins"))}`);
  assert.ok(whats(twice).some((w) => /exactly the same as "Pin Squat" \(id apogee-pin-squat\)/.test(w)));
});

test("additions: a missing id prints a suggested id to paste, and the file is not touched", () => {
  const result = check(block([...withoutLine(GOOD, "id"), "level: beginner"].map((l) => (l.startsWith("name:") ? "name: Paused Hip Thrust Machine" : l))));
  const problem = result.problems.find((p) => /"id" is missing/.test(p.what));
  assert.match(problem.fix, /id: apogee-paused-hip-thrust-machine/);
  assert.equal(slugFor("Paused Hip Thrust Machine"), "apogee-paused-hip-thrust-machine");
  assert.equal(slugFor("  Café — Curl!  "), "apogee-cafe-curl");
});

// ---- the near-name check ----

test("additions: a name close to an existing one asks 'Did you mean', and similar-ok silences only the ids it lists", () => {
  const lines = (extra = []) => [...withLine(withLine(GOOD, "name", "Barbell Squat"), "variations", "speed"), ...extra];
  const first = check(block(lines()));
  assert.ok(whats(first).some((w) => /Did you mean "Barbell Squat" \(id Barbell_Squat\)\?/.test(w)));
  const flagged = [...fixture.map((e) => ({ id: e.id, name: e.name })), ...SEED_EXERCISES.map((s) => ({ id: s.id, name: s.name }))]
    .filter((e) => nameScore("Barbell Squat", e.name).close)
    .map((e) => e.id);
  assert.ok(flagged.length >= 3, "the test needs several close names");

  // Acknowledging one id is not enough while another close name remains, and the message moves on to the next one.
  const one = check(block(lines(["similar-ok: Barbell_Squat"])));
  assert.ok(whats(one).some((w) => /Did you mean/.test(w) && !/"Barbell Squat" \(id Barbell_Squat\)\?/.test(w)));
  // An unrelated id silences nothing.
  assert.ok(whats(check(block(lines(["similar-ok: Hack_Squat"])))).some((w) => /Did you mean "Barbell Squat"/.test(w)));
  // An id that does not exist is refused.
  assert.ok(whats(check(block(lines(["similar-ok: Not_An_Exercise"])))).some((w) => /not an existing exercise id/.test(w)));
  // Listing every close id passes.
  const all = check(block(lines([`similar-ok: ${flagged.join(", ")}`])));
  assert.deepEqual(all.problems, []);
  // The line the message offers to paste is itself enough to pass.
  const offered = first.problems.find((p) => /Did you mean/.test(p.what)).fix;
  const pasted = /similar-ok: ([^ ]+(?:, [^ ]+)*)/.exec(offered)[1];
  assert.deepEqual(check(block(lines([`similar-ok: ${pasted}, ${flagged.join(", ")}`]))).problems, []);

  // Another addition counts too, but only the later block is asked.
  const second = block([...withLine(withLine(GOOD, "id", "apogee-pin-squat-two"), "name", "Pin Squat"), "variations: pins, speed"].filter((l, i, a) => a.indexOf(l) === i && !l.startsWith("variations: pins") || l === "variations: pins, speed"));
  assert.ok(whats(check(`${sampleText}\n---\n${second}`)).some((w) => /Did you mean "Pin Squat" \(id apogee-pin-squat\)\?/.test(w)));
});

test("additions: the name closeness thresholds sit in one constant and behave as designed", () => {
  assert.deepEqual({ ...NAME_SIMILARITY }, { overlap: 0.6, containedMinWords: 2 });
  assert.equal(nameScore("a b c d", "a b c e").overlap, 0.6);
  assert.equal(nameScore("a b c d", "a b c e").close, true); // exactly at the overlap threshold
  assert.equal(nameScore("a b c d", "a b e f").close, false);
  assert.equal(nameScore("Hip Thrust", "Barbell Hip Thrust").contained, true); // a shorter name of two words inside a longer one
  assert.equal(nameScore("Curl", "Barbell Curl").close, false); // one word contained is not enough
  assert.equal(nameScore("Pin Squat", "Barbell Squat").close, false);
});

// ---- reporting ----

test("additions: every problem is reported together, in plain words, with block, line and the line to paste, and the build writes additions-problems.txt and stops", () => {
  const broken = [
    "id: apogee-one", "name: Zzz One", "base: deadlift", "equipment: barbel", "primary: lower_back",
    "---",
    "id: bad id", "name: Zzz Two", "base: curl", "equipment: barbell", "primary: quadz",
    "---",
    "id: apogee-three", "name: Zzz Three", "colour: red",
  ].join("\n");
  const result = check(broken);
  assert.ok(result.problems.length >= 6);
  const text = formatProblems(result.problems);
  assert.match(text, /Problem 1 of \d+/);
  assert.match(text, /Where: block 1 \("Zzz One"\), line 4/);
  assert.match(text, /Where: block 2 \("Zzz Two"\), line 7/);
  assert.match(text, /Allowed: .*barbell/);
  assert.match(text, /What to do: change the line to  equipment: barbell/);
  assert.ok(!/\n\s+at \S+ \(|Error:/.test(text), "no stack traces");

  withTempFiles(({ dir, input, pin, overridesFile }) => {
    const additions = path.join(dir, "additions.txt");
    fs.writeFileSync(additions, broken);
    const out = path.join(dir, "out");
    assert.throws(
      () => run(["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", additions, "--out", out]),
      /The additions file has \d+ problems\. Nothing was built/,
    );
    assert.ok(fs.existsSync(path.join(out, "additions-problems.txt")));
    assert.ok(!fs.existsSync(path.join(out, "catalog.json")), "nothing else is written");
    // Fixing the file removes the old report.
    fs.writeFileSync(additions, sampleText);
    run(["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", additions, "--out", out]);
    assert.ok(!fs.existsSync(path.join(out, "additions-problems.txt")));
    assert.ok(fs.existsSync(path.join(out, "catalog.json")));
  });
});

test("additions: unknown fields, a repeated field and a line that is not field: value are named with their line, comments and separators are ignored", () => {
  const parsed = parseAdditions(["# note", "", "id: apogee-a", "name: A", "name: B", "colour: red", "just words", "---", "---", "# more", "id: apogee-b"].join("\n"));
  assert.equal(parsed.blocks.length, 2);
  assert.deepEqual(parsed.problems.map((p) => [p.line, p.where]), [[5, 'block 1 ("A")'], [6, 'block 1 ("A")'], [7, 'block 1 ("A")']]);
  assert.match(parsed.problems[0].what, /"name" appears twice/);
  assert.match(parsed.problems[1].what, /"colour" is not a field/);
  assert.match(parsed.problems[2].what, /not in the form "field: value"/);
});

// ---- the build as a whole ----

test("additions: output with additions is byte-identical between runs, and --strict still passes", () => {
  withTempFiles(({ dir, input, pin, overridesFile }) => {
    const additions = path.join(dir, "additions.txt");
    fs.writeFileSync(additions, sampleText);
    // The fixture's squat-style Turkish get-up has no placeable shoulder head; leave it out so --strict can pass.
    const overrides = { ...JSON.parse(fs.readFileSync(overridesFile, "utf8")), "Kettlebell_Turkish_Get-Up_Squat_style": { exclude: true, note: "left out for the test" } };
    fs.writeFileSync(overridesFile, JSON.stringify(overrides));
    const args = (name) => ["--input", input, "--pin", pin, "--overrides", overridesFile, "--additions", additions, "--out", path.join(dir, name), "--strict"];
    assert.doesNotThrow(() => run(args("a")));
    assert.doesNotThrow(() => run(args("b")));
    for (const name of fs.readdirSync(path.join(dir, "a"))) {
      assert.ok(fs.readFileSync(path.join(dir, "a", name)).equals(fs.readFileSync(path.join(dir, "b", name))), `${name} differs between runs`);
    }
  });
});

function withTempFiles(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-additions-test-"));
  try {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-110.json"));
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, bytes);
    const pin = path.join(dir, "pin.json");
    fs.writeFileSync(pin, JSON.stringify({
      repo: "fixture", file: "sample-110.json", commit: "none", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), entries: 110,
    }));
    // The same four overrides the approved table is built with.
    const all = JSON.parse(fs.readFileSync(path.join(TOOL, "overrides.json"), "utf8"));
    const ids = ["Bench_Press_-_With_Bands", "Chair_Squat", "Split_Squats", "Squats_-_With_Bands"];
    const overridesFile = path.join(dir, "overrides.json");
    fs.writeFileSync(overridesFile, JSON.stringify(Object.fromEntries(ids.map((id) => [id, all[id]]))));
    return body({ dir, input, pin, overridesFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
