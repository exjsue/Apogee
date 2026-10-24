// tools/compare-exports.js: the check that an upgrade changed no history. It reads personal data, so the tests
// cover what it must never do (print note text or names, write anything, read a file inside the repo) as well
// as what it reports. The export files here are small synthetic ones in a temporary folder outside the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareExports, formatReport, main, NEW_FIELDS, readExport } from "../tools/compare-exports.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const TOOL = path.join(ROOT, "tools", "compare-exports.js");

const SECRET_NOTE = "SECRET-NOTE-TEXT";
const SECRET_NAME = "SECRET-EXERCISE-NAME";

const exercise = (id, extra = {}) => ({
  id, name: `${SECRET_NAME} ${id}`, primaryMuscles: ["chest"], secondaryMuscles: [], equipmentTags: ["barbell"], notes: SECRET_NOTE, isCustom: false, defaultRestSeconds: null, ...extra,
});
const NEW_VALUES = { baseMovementId: null, equipment: null, variations: [], origin: "seed", upstreamId: null, catalogVersion: null, retired: false };
const setRecord = (id, extra = {}) => ({ id, entryId: "e1", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: null, ...extra });
const file = (schemaVersion, data) => ({ app: "apogee-export", exportFormat: 1, schemaVersion, exportedAt: "2026-10-23T10:00:00.000Z", data });
const baseData = () => ({
  exercises: [exercise("seed-a"), exercise("ex-b", { isCustom: true })],
  workouts: [{ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: null, notes: SECRET_NOTE }],
  entries: [{ id: "e1", workoutId: "w1", exerciseId: "seed-a", order: 0, supersetGroup: null, notes: SECRET_NOTE }],
  sets: [setRecord("s1"), setRecord("s2", { order: 1 })],
});

function withFiles(first, second, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-compare-test-"));
  try {
    const a = path.join(dir, "before.json");
    const b = path.join(dir, "after.json");
    fs.writeFileSync(a, JSON.stringify(first));
    fs.writeFileSync(b, JSON.stringify(second));
    return body({ dir, a, b });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const upgraded = () => {
  const data = baseData();
  data.exercises = data.exercises.map((e) => ({ ...e, ...NEW_VALUES, origin: e.isCustom ? "custom" : "seed" }));
  return file(3, data);
};
const run = (a, b) => {
  let out = "";
  let err = "";
  const code = main([a, b], { write: (t) => { out += t; } }, { write: (t) => { err += t; } });
  return { code, out, err };
};

test("compare-exports: two identical files are reported as identical, with the schema versions and the counts", () => {
  withFiles(file(2, baseData()), file(2, baseData()), ({ a, b }) => {
    const { code, out } = run(a, b);
    assert.equal(code, 0);
    assert.match(out, /schemaVersion: first file 2, second file 2/);
    assert.match(out, /exercises: 2 \/ 2/);
    assert.match(out, /workouts: 1 \/ 1/);
    assert.match(out, /entries: 1 \/ 1/);
    assert.match(out, /sets: 2 \/ 2/);
    for (const section of ["workouts", "entries", "sets"]) assert.match(out, new RegExp(`${section}: identical`));
    assert.match(out, /RESULT: workouts, entries and sets are identical/);
  });
});

test("compare-exports: an upgrade that only adds the seven new fields to exercises is reported as limited to them", () => {
  assert.deepEqual([...NEW_FIELDS], ["baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired"]);
  withFiles(file(2, baseData()), upgraded(), ({ a, b }) => {
    const { code, out } = run(a, b);
    assert.equal(code, 0);
    assert.match(out, /schemaVersion: first file 2, second file 3/);
    assert.match(out, /Exercises: differences are limited to the seven new fields/);
    assert.match(out, /seed-a: baseMovementId, catalogVersion, equipment, origin, retired, upstreamId, variations/);
    assert.match(out, /fields that differ: baseMovementId \(2\)/);
  });
});

test("compare-exports: a changed exercise field outside the seven, an exercise in one file only, and changed history are all reported, by id and field name", () => {
  const after = upgraded();
  after.data.exercises[0].defaultRestSeconds = 90; // outside the seven
  after.data.exercises.push(exercise("only-after", NEW_VALUES));
  after.data.sets[0].reps = 6; // history changed
  after.data.sets.push(setRecord("s3", { order: 2 }));
  after.data.entries = [];
  withFiles(file(2, baseData()), after, ({ a, b }) => {
    const { code, out } = run(a, b);
    assert.equal(code, 1);
    assert.match(out, /Exercises: NOT limited to the seven new fields; other fields that differ: defaultRestSeconds; some ids are in one file only/);
    assert.match(out, /only-after: only in the second file/);
    assert.match(out, /sets: NOT identical \(2 difference\(s\)/);
    assert.match(out, /s1: differs in reps/);
    assert.match(out, /s3: only in the second file/);
    assert.match(out, /entries: NOT identical/);
    assert.match(out, /e1: only in the first file/);
    assert.match(out, /RESULT: there are differences beyond/);
  });
});

test("compare-exports: only the first ten differences are listed, and other sections are counted", () => {
  const before = file(2, { ...baseData(), extra: [{ id: "x" }] });
  const after = file(2, { ...baseData(), extra: [{ id: "x" }, { id: "y" }] });
  after.data.sets = Array.from({ length: 15 }, (_, i) => setRecord(`n${String(i).padStart(2, "0")}`));
  withFiles(before, after, ({ a, b }) => {
    const { out } = run(a, b);
    assert.match(out, /extra: 1 \/ 2  \(different\)/);
    assert.match(out, /sets: NOT identical \(17 difference\(s\), first 10 shown\)/);
    const listed = out.split("\n").filter((l) => /^  (n\d\d|s\d): /.test(l));
    assert.equal(listed.length, 10);
  });
});

test("compare-exports: it never prints note text, names or values", () => {
  const after = upgraded();
  after.data.exercises[0].name = `${SECRET_NAME} renamed`;
  after.data.exercises[0].notes = `${SECRET_NOTE} changed`;
  after.data.workouts[0].notes = `${SECRET_NOTE} changed`;
  after.data.sets[0].weightValue = 987654;
  withFiles(file(2, baseData()), after, ({ a, b }) => {
    const { out, err } = run(a, b);
    for (const secret of [SECRET_NOTE, SECRET_NAME, "987654", "changed", "renamed"]) {
      assert.ok(!out.includes(secret), `the report contains ${secret}`);
      assert.ok(!err.includes(secret));
    }
    assert.match(out, /s1: differs in weightValue/); // the field name is there, the value is not
    assert.match(out, /w1: differs in notes/);
  });
});

test("compare-exports: it refuses a file inside the repository, however the path is written, and says why", () => {
  withFiles(file(2, baseData()), file(2, baseData()), ({ dir, a }) => {
    const inside = [TOOL, path.join(ROOT, "tools", "..", "package.json"), path.relative(process.cwd(), path.join(ROOT, "CLAUDE.md")), ROOT];
    for (const target of inside) {
      for (const args of [[target, a], [a, target]]) {
        const { code, out, err } = run(args[0], args[1]);
        assert.equal(code, 2, target);
        assert.equal(out, "");
        assert.match(err, /inside the repository folder/);
        assert.match(err, /personal workout data/);
        assert.match(err, /committed/);
      }
    }
    assert.throws(() => readExport(TOOL), /Refusing to read/);
  });
});

test("compare-exports: a missing file, a file that is not JSON or not an export, and a wrong number of arguments fail with exit status 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-compare-test-"));
  try {
    const good = path.join(dir, "good.json");
    fs.writeFileSync(good, JSON.stringify(file(2, baseData())));
    const notJson = path.join(dir, "not.json");
    fs.writeFileSync(notJson, `{ "oops": "${SECRET_NOTE}`);
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ app: "something-else", data: {} }));
    assert.match(run(good, path.join(dir, "missing.json")).err, /does not exist or is not readable/);
    const bad = run(good, notJson);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /is not valid JSON/);
    assert.ok(!bad.err.includes(SECRET_NOTE));
    assert.match(run(good, other).err, /not an Apogee export file/);
    let usage = "";
    assert.equal(main([good], { write() {} }, { write: (t) => { usage += t; } }), 2);
    assert.match(usage, /Usage: node tools\/compare-exports\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compare-exports: run as a program it prints the report and sets the exit status, and leaves both files and the folder untouched", () => {
  withFiles(file(2, baseData()), upgraded(), ({ dir, a, b }) => {
    const listing = () => fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name)).toString("base64")]);
    const before = listing();
    const ok = spawnSync(process.execPath, [TOOL, a, b], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /RESULT: workouts, entries and sets are identical/);
    assert.deepEqual(listing(), before);
    const refused = spawnSync(process.execPath, [TOOL, TOOL, b], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /inside the repository folder/);
  });
});

test("compare-exports: its source writes nothing and uses no network module", () => {
  const source = fs.readFileSync(TOOL, "utf8");
  const forbidden = [
    /\bwriteFile(Sync)?\b/, /\bappendFile(Sync)?\b/, /\bmkdir(Sync)?\b/, /\bunlink(Sync)?\b/, /\brm(Sync)?\b/, /\brename(Sync)?\b/, /\bcopyFile(Sync)?\b/, /\btruncate(Sync)?\b/, /\bcreateWriteStream\b/,
    /node:https?\b/, /node:net\b/, /node:tls\b/, /node:dns\b/, /node:dgram\b/, /node:child_process/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /https?:\/\//,
  ];
  const found = forbidden.filter((pattern) => pattern.test(source)).map(String);
  assert.deepEqual(found, []);
  // the report text is built from ids, counts and field names only
  const result = compareExports(file(2, baseData()), upgraded());
  assert.ok(!formatReport(result).includes(SECRET_NOTE));
});

test("compare-exports: a path inside the repository is refused even when nothing exists there, and a link out of a safe folder into the repo is refused too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apogee-compare-test-"));
  try {
    const missing = path.join(ROOT, "no-such-folder", "backup.json");
    const { code, err } = run(missing, missing);
    assert.equal(code, 2);
    assert.match(err, /inside the repository folder/);
    const link = path.join(dir, "link.json");
    try {
      fs.symlinkSync(TOOL, link);
    } catch {
      return; // creating a link needs a privilege on some systems; the check above still ran
    }
    assert.match(run(link, link).err, /inside the repository folder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- --allow-added-builtins ----

const FLAG = "--allow-added-builtins";
const runWith = (a, b, ...flags) => {
  let out = "";
  let err = "";
  const code = main([a, b, ...flags], { write: (t) => { out += t; } }, { write: (t) => { err += t; } });
  return { code, out, err };
};
// a schema 3 file: the exercises carry the seven fields, so two such files can be identical
const v3Data = () => upgraded().data;
const builtin = (id, origin) => exercise(id, { ...NEW_VALUES, origin, upstreamId: origin === "upstream" ? id : null, catalogVersion: 1 });
const FIVE = [builtin("lib-1", "upstream"), builtin("lib-2", "upstream"), builtin("lib-3", "upstream"), builtin("apogee-lib-4", "authored"), builtin("apogee-lib-5", "authored")];

test("compare-exports --allow-added-builtins: five added built-in records are counted, not listed, and everything else identical gives exit 0", () => {
  const after = v3Data();
  after.exercises.push(...FIVE);
  withFiles(file(3, v3Data()), file(3, after), ({ a, b }) => {
    const { code, out, err } = runWith(a, b, FLAG);
    assert.equal(code, 0, err + out);
    assert.match(out, /exercises: 0 only in the first file, 5 added built-in records, 0 other ids only in the second, 0 in both with differences/);
    assert.match(out, /^5 added built-in records$/m);
    assert.match(out, /Exercises: the only difference is 5 added built-in records; every other exercise is identical\./);
    assert.match(out, /RESULT: workouts, entries and sets are identical, and the only change to exercises is added built-in records\./);
    assert.match(out, /exercises: 2 \/ 7/);
    for (const hidden of ["lib-1", "lib-5", SECRET_NAME, SECRET_NOTE]) assert.ok(!out.includes(hidden), hidden); // counted, never listed
    assert.equal(runWith(a, b, FLAG).out, out); // the flag may also come first
    assert.equal(main([FLAG, a, b], { write() {} }, { write() {} }), 0);
  });
});

test("compare-exports --allow-added-builtins: an added custom exercise or an added seed is NOT allowed, and is named by id", () => {
  for (const extra of [exercise("ex-new", { ...NEW_VALUES, origin: "custom", isCustom: true }), exercise("seed-new", { ...NEW_VALUES, origin: "seed" })]) {
    const after = v3Data();
    after.exercises.push(...FIVE, extra);
    withFiles(file(3, v3Data()), file(3, after), ({ a, b }) => {
      const { code, out } = runWith(a, b, FLAG);
      assert.equal(code, 1);
      assert.match(out, /5 added built-in records, 1 other ids only in the second/);
      assert.match(out, new RegExp(`${extra.id}: only in the second file, and not a built-in record`));
      assert.match(out, /Exercises: NOT only added built-in records/);
      assert.match(out, /RESULT: there are differences beyond added built-in records/);
    });
  }
});

test("compare-exports --allow-added-builtins: a changed field on an exercise both files have fails, even one of the seven new fields", () => {
  const changedNote = v3Data();
  changedNote.exercises[0].notes = "another note";
  changedNote.exercises.push(...FIVE);
  withFiles(file(3, v3Data()), file(3, changedNote), ({ a, b }) => {
    const { code, out } = runWith(a, b, FLAG);
    assert.equal(code, 1);
    assert.match(out, /seed-a: notes/);
    assert.match(out, /fields that differ: notes \(1\)/);
    assert.ok(!out.includes("another note"));
  });
  // a version 2 file against a version 3 file differs in the seven fields: allowed by default, not with this flag
  withFiles(file(2, baseData()), upgraded(), ({ a, b }) => {
    assert.equal(runWith(a, b).code, 0);
    const { code, out } = runWith(a, b, FLAG);
    assert.equal(code, 1);
    assert.match(out, /fields that differ: baseMovementId \(2\), catalogVersion \(2\)/);
  });
});

test("compare-exports --allow-added-builtins: changed history or a removed exercise still fails", () => {
  const history = v3Data();
  history.sets[0].reps = 99;
  history.exercises.push(...FIVE);
  withFiles(file(3, v3Data()), file(3, history), ({ a, b }) => {
    const { code, out } = runWith(a, b, FLAG);
    assert.equal(code, 1);
    assert.match(out, /sets: NOT identical/);
    assert.match(out, /s1: differs in reps/);
  });
  const removed = v3Data();
  removed.exercises.pop();
  withFiles(file(3, v3Data()), file(3, removed), ({ a, b }) => {
    const { code, out } = runWith(a, b, FLAG);
    assert.equal(code, 1);
    assert.match(out, /ex-b: only in the first file/);
  });
});

test("compare-exports: without the flag, added built-in records are reported exactly as before", () => {
  const after = v3Data();
  after.exercises.push(...FIVE);
  withFiles(file(3, v3Data()), file(3, after), ({ a, b }) => {
    const { code, out } = run(a, b);
    assert.equal(code, 1);
    assert.match(out, /exercises: 0 only in the first file, 5 only in the second, 0 in both with differences/);
    assert.match(out, /lib-1: only in the second file/);
    assert.match(out, /Exercises: NOT limited to the seven new fields; some ids are in one file only\./);
    assert.ok(!/added built-in records/.test(out));
  });
});

test("compare-exports: an unknown option, or the flag twice, or the wrong number of files, is a usage error with exit status 2", () => {
  withFiles(file(2, baseData()), file(2, baseData()), ({ a, b }) => {
    for (const args of [[a, b, "--allow-everything"], [a, b, FLAG, FLAG], [a, FLAG], [a, b, b]]) {
      let usage = "";
      assert.equal(main(args, { write() {} }, { write: (t) => { usage += t; } }), 2, args.join(" "));
      assert.match(usage, /Usage: node tools\/compare-exports\.js <before\.json> <after\.json> \[--allow-added-builtins\]/);
    }
  });
});

test("compare-exports: run as a program, the flag works and the repository check still applies", () => {
  const after = v3Data();
  after.exercises.push(...FIVE);
  withFiles(file(3, v3Data()), file(3, after), ({ a, b }) => {
    const ok = spawnSync(process.execPath, [TOOL, a, b, FLAG], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^5 added built-in records$/m);
    const refused = spawnSync(process.execPath, [TOOL, TOOL, b, FLAG], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /inside the repository folder/);
  });
});

test("compare-exports: a templates section (schema 4) is counted like any other section, and does not change the history verdict", () => {
  const before = file(3, baseData());
  const after = file(4, { ...baseData(), templates: [{ id: "t1", name: SECRET_NAME, exercises: [{ exerciseId: "seed-a", setCount: 3 }] }] });
  const result = compareExports(before, after);
  assert.deepEqual(result.counts.templates, { before: 0, after: 1 });
  assert.equal(result.ok, true);
  const report = formatReport(result);
  assert.match(report, /^  templates: 0 \/ 1  \(different\)$/m);
  assert.ok(!report.includes(SECRET_NAME));
});
