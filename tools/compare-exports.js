// Compares two Apogee export files, for checking an upgrade: nothing in the history may change.
//
//   node tools/compare-exports.js <before.json> <after.json> [--allow-added-builtins]
//
// With --allow-added-builtins (for checking the exercise library being added): exercises only the second file has
// are allowed if they are built-in records (isCustom false, origin upstream or authored); they are counted, not
// listed. It is stricter in one way: every exercise both files have must be identical, with no field differing
// (the default allows the seven schema 3 fields to differ). Workouts, entries and sets must be identical either way.
//
// Read-only: it writes nothing and makes no network call. It refuses to read a file that is inside this
// repository folder, because an export holds personal workout data and must never be somewhere it could be
// committed. It prints only ids, counts and field names, never note text, names or values.
//
// Exit status: 0 = workouts, entries and sets are identical and exercises differ at most in the seven
// schema 3 fields; 1 = some other difference; 2 = it could not run (usage, unreadable or not an export,
// or a file inside the repository).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

export const NEW_FIELDS = Object.freeze(["baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired"]);
const HISTORY = ["workouts", "entries", "sets"];
const SHOWN_DIFFERENCES = 10;
const SHOWN_EXERCISE_LINES = 40;
const APP_MARKER = "apogee-export";
const ALLOW_FLAG = "--allow-added-builtins";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// The same text for equal values, whatever the order of the keys.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Throws if the file is inside the repository (looking through links and ".." parts).
export function refuseInsideRepo(file, root = repoRoot) {
  const inside = (target, base) => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const refuse = () => new Error(
    `Refusing to read ${file}: it is inside the repository folder. An export file holds personal workout data, `
    + "and it must never sit where it could be committed by mistake. Copy it outside the repository "
    + "(for example to your Downloads folder) and run this again.",
  );
  if (inside(path.resolve(file), path.resolve(root))) throw refuse(); // as written, whether or not the file exists
  let real;
  try {
    real = fs.realpathSync(path.resolve(file));
  } catch {
    throw new Error(`cannot read ${file}: it does not exist or is not readable`);
  }
  if (inside(real, fs.realpathSync(root))) throw refuse(); // and through links
}

export function readExport(file, root = repoRoot) {
  refuseInsideRepo(file, root);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`); // the parser's own message can quote the file
  }
  if (!isObject(doc) || doc.app !== APP_MARKER || !isObject(doc.data)) throw new Error(`${file} is not an Apogee export file`);
  return doc;
}

const recordsOf = (doc, section) => (Array.isArray(doc.data[section]) ? doc.data[section] : []);

function byId(records) {
  const map = new Map();
  let withoutId = 0;
  for (const record of records) {
    if (isObject(record) && typeof record.id === "string") map.set(record.id, record);
    else withoutId += 1;
  }
  return { map, withoutId };
}

// The names of the fields on which two records differ (present in one only, or with different values).
const differingFields = (a, b) => Object.keys({ ...a, ...b }).filter((key) => canonical(a[key]) !== canonical(b[key])).sort();

// A built-in record of the exercise library (not a seed, not the user's own).
const isBuiltinRecord = (record) => isObject(record) && record.isCustom === false && (record.origin === "upstream" || record.origin === "authored");

export function compareExports(before, after, { allowAddedBuiltins = false } = {}) {
  const sections = [...new Set([...Object.keys(before.data), ...Object.keys(after.data)])].sort();
  const counts = Object.fromEntries(sections.map((s) => [s, { before: recordsOf(before, s).length, after: recordsOf(after, s).length }]));

  const history = {};
  for (const section of HISTORY) {
    const a = byId(recordsOf(before, section));
    const b = byId(recordsOf(after, section));
    const lines = [];
    for (const id of [...a.map.keys()].sort()) if (!b.map.has(id)) lines.push(`${id}: only in the first file`);
    for (const id of [...b.map.keys()].sort()) if (!a.map.has(id)) lines.push(`${id}: only in the second file`);
    for (const id of [...a.map.keys()].sort()) if (b.map.has(id)) {
      const fields = differingFields(a.map.get(id), b.map.get(id));
      if (fields.length > 0) lines.push(`${id}: differs in ${fields.join(", ")}`);
    }
    if (a.withoutId + b.withoutId > 0) lines.push(`${a.withoutId + b.withoutId} record(s) without an id`);
    history[section] = { identical: lines.length === 0, differences: lines };
  }

  const ex = { before: byId(recordsOf(before, "exercises")), after: byId(recordsOf(after, "exercises")) };
  const onlyBefore = [...ex.before.map.keys()].filter((id) => !ex.after.map.has(id)).sort();
  const onlyAfter = [...ex.after.map.keys()].filter((id) => !ex.before.map.has(id)).sort();
  const changed = [];
  const fieldTotals = {};
  for (const id of [...ex.before.map.keys()].sort()) {
    if (!ex.after.map.has(id)) continue;
    const fields = differingFields(ex.before.map.get(id), ex.after.map.get(id));
    if (fields.length === 0) continue;
    changed.push({ id, fields });
    for (const f of fields) fieldTotals[f] = (fieldTotals[f] ?? 0) + 1;
  }
  const otherFields = Object.keys(fieldTotals).filter((f) => !NEW_FIELDS.includes(f)).sort();
  const noStrayIds = ex.before.withoutId + ex.after.withoutId === 0;
  const limitedToNewFields = onlyBefore.length === 0 && onlyAfter.length === 0 && otherFields.length === 0 && noStrayIds;

  // With allowAddedBuiltins the check is stricter about the exercises both files have (no field may differ at all)
  // and allows one thing more: exercises only the second file has, if they are built-in records.
  const added = allowAddedBuiltins ? onlyAfter.filter((id) => isBuiltinRecord(ex.after.map.get(id))) : [];
  const unexplainedAfter = allowAddedBuiltins ? onlyAfter.filter((id) => !added.includes(id)) : onlyAfter;
  const onlyAddedBuiltins = onlyBefore.length === 0 && unexplainedAfter.length === 0 && changed.length === 0 && noStrayIds;

  const historyIdentical = HISTORY.every((s) => history[s].identical);
  return {
    schemaVersion: { before: before.schemaVersion, after: after.schemaVersion },
    counts, history,
    exercises: { onlyBefore, onlyAfter, changed, fieldTotals, otherFields, limitedToNewFields, allowAddedBuiltins, added, unexplainedAfter, onlyAddedBuiltins },
    ok: historyIdentical && (allowAddedBuiltins ? onlyAddedBuiltins : limitedToNewFields),
  };
}

// The report for --allow-added-builtins: the added built-in records are only counted, never listed.
function formatWithAddedBuiltins(result, lines) {
  const e = result.exercises;
  lines.push(
    "",
    `exercises: ${e.onlyBefore.length} only in the first file, ${e.added.length} added built-in records, ${e.unexplainedAfter.length} other ids only in the second, ${e.changed.length} in both with differences`,
  );
  for (const id of e.onlyBefore.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: only in the first file`);
  for (const id of e.unexplainedAfter.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: only in the second file, and not a built-in record`);
  for (const { id, fields } of e.changed.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: ${fields.join(", ")}`);
  const hidden = Math.max(0, e.onlyBefore.length - SHOWN_EXERCISE_LINES) + Math.max(0, e.unexplainedAfter.length - SHOWN_EXERCISE_LINES) + Math.max(0, e.changed.length - SHOWN_EXERCISE_LINES);
  if (hidden > 0) lines.push(`  ... and ${hidden} more`);
  if (Object.keys(e.fieldTotals).length > 0) lines.push(`  fields that differ: ${Object.entries(e.fieldTotals).sort().map(([f, n]) => `${f} (${n})`).join(", ")}`);
  lines.push(
    `${e.added.length} added built-in records`,
    e.onlyAddedBuiltins
      ? `Exercises: the only difference is ${e.added.length} added built-in records; every other exercise is identical.`
      : "Exercises: NOT only added built-in records (with this flag no field of an existing exercise may differ).",
    "",
    result.ok
      ? "RESULT: workouts, entries and sets are identical, and the only change to exercises is added built-in records."
      : "RESULT: there are differences beyond added built-in records. Look at the lines above.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatReport(result) {
  const lines = [
    `schemaVersion: first file ${result.schemaVersion.before}, second file ${result.schemaVersion.after}`,
    "",
    "Records per section (first file / second file):",
    ...Object.entries(result.counts).map(([s, c]) => `  ${s}: ${c.before} / ${c.after}${c.before === c.after ? "" : "  (different)"}`),
    "",
  ];
  for (const section of HISTORY) {
    const h = result.history[section];
    lines.push(`${section}: ${h.identical ? "identical" : `NOT identical (${h.differences.length} difference(s), first ${Math.min(SHOWN_DIFFERENCES, h.differences.length)} shown)`}`);
    for (const d of h.differences.slice(0, SHOWN_DIFFERENCES)) lines.push(`  ${d}`);
  }
  const e = result.exercises;
  if (e.allowAddedBuiltins) return formatWithAddedBuiltins(result, lines);
  lines.push("", `exercises: ${e.onlyBefore.length} only in the first file, ${e.onlyAfter.length} only in the second, ${e.changed.length} in both with differences`);
  for (const id of e.onlyBefore.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: only in the first file`);
  for (const id of e.onlyAfter.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: only in the second file`);
  for (const { id, fields } of e.changed.slice(0, SHOWN_EXERCISE_LINES)) lines.push(`  ${id}: ${fields.join(", ")}`);
  const hidden = Math.max(0, e.onlyBefore.length - SHOWN_EXERCISE_LINES) + Math.max(0, e.onlyAfter.length - SHOWN_EXERCISE_LINES) + Math.max(0, e.changed.length - SHOWN_EXERCISE_LINES);
  if (hidden > 0) lines.push(`  ... and ${hidden} more`);
  if (Object.keys(e.fieldTotals).length > 0) lines.push(`  fields that differ: ${Object.entries(e.fieldTotals).sort().map(([f, n]) => `${f} (${n})`).join(", ")}`);
  lines.push(
    e.limitedToNewFields
      ? `Exercises: differences are limited to the seven new fields (${NEW_FIELDS.join(", ")}).`
      : `Exercises: NOT limited to the seven new fields${e.otherFields.length > 0 ? `; other fields that differ: ${e.otherFields.join(", ")}` : ""}${e.onlyBefore.length + e.onlyAfter.length > 0 ? "; some ids are in one file only" : ""}.`,
    "",
    result.ok
      ? "RESULT: workouts, entries and sets are identical, and exercises differ at most in the seven new fields."
      : "RESULT: there are differences beyond what an upgrade should change. Look at the lines above.",
  );
  return `${lines.join("\n")}\n`;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const files = argv.filter((arg) => !arg.startsWith("--"));
  if (files.length !== 2 || flags.some((flag) => flag !== ALLOW_FLAG) || flags.length > 1) {
    err.write(`Usage: node tools/compare-exports.js <before.json> <after.json> [${ALLOW_FLAG}]\n`);
    return 2;
  }
  try {
    const result = compareExports(readExport(files[0]), readExport(files[1]), { allowAddedBuiltins: flags.length === 1 });
    out.write(formatReport(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    err.write(`${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
