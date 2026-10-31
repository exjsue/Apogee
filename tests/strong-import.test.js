import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { createBackup, inspectBackup } from "../src/backup/backup.js";
import { ALL_MUSCLES } from "../src/domain/model.js";
import { nameKey } from "../src/domain/exercise-names.js";
import { isCountableSet, personalRecords, prHistory } from "../src/domain/strength.js";
import { sessionsOf } from "../src/domain/top-set.js";
import { SEED_EXERCISES, SEED_VERSION } from "../src/domain/seed.js";
import { CATALOG, CATALOG_VERSION } from "../src/catalog/catalog.js";
import { createCatalogStore } from "../src/storage/catalog-store.js";
import { STRONG_ALIASES } from "../src/importers/strong-aliases.js";
import { catalogEntryToRecord } from "../src/domain/builtin.js";
import { parseCsv, parseDuration, parseStrongCsv, buildStrongPlan, sha256Hex, STRONG_HEADER } from "../src/importers/strong.js";
import { matchStrongNames, strongNameCounts, renderReview, reorderEquipment, tableKey, MAX_SUGGESTIONS } from "../src/importers/strong-match.js";
import { STRONG_MUSCLES } from "../src/importers/strong-muscles.js";
import { applyStrongPlan, readImportContext } from "../src/importers/strong-apply.js";

const FIXTURE = readFileSync(new URL("./fixtures/strong-sample.csv", import.meta.url), "utf8");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const local = (...parts) => new Date(...parts).toISOString();

const chest = () => ({ kind: "custom", primaryMuscles: ["chest"] });
function mappingFor(parsed, pick = chest) {
  const mapping = new Map();
  for (const entry of strongNameCounts(parsed.workouts)) mapping.set(nameKey(entry.name), pick(entry));
  return mapping;
}

async function freshStore() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.open();
  return { adapter, store };
}
const exportOf = (adapter) => createBackup(adapter).exportToText({ now: NOW });

async function planFor(text, adapter, { unit = "lb", pick } = {}) {
  const parsed = parseStrongCsv(text);
  const existing = await readImportContext(adapter);
  return { parsed, plan: await buildStrongPlan({ parsed, unit, mapping: mappingFor(parsed, pick), existing }) };
}

const lines = FIXTURE.trimEnd().split("\n");
const NEXT_LINE = lines.length + 1; // the line number of a row added to the end of the fixture
const withRows = (...rows) => `${FIXTURE.trimEnd()}\n${rows.join("\n")}\n`;
const BAD_ROWS = {
  "an unknown set marker": '2025-03-01 10:00:00,"X",30m,"Squat (Barbell)",Z,100.0,5.0,0,0.0,',
  "fractional reps": '2025-03-01 10:00:00,"X",30m,"Squat (Barbell)",1,100.0,5.5,0,0.0,',
  "reps 0 with seconds 0": '2025-03-01 10:00:00,"X",30m,"Squat (Barbell)",1,100.0,0.0,0,0.0,',
  "a nonzero Distance": '2025-03-01 10:00:00,"X",30m,"Squat (Barbell)",1,100.0,5.0,100,0.0,',
  "reps and seconds both above 0": '2025-03-01 10:00:00,"X",30m,"Squat (Barbell)",1,100.0,5.0,0,30.0,',
};

// ---- parsing

test("strong: a different header refuses the whole file; an unclosed quote does too", () => {
  const swapped = FIXTURE.replace("Weight,Reps", "Reps,Weight");
  assert.match(parseStrongCsv(swapped).fatal, /header/);
  assert.match(parseStrongCsv(FIXTURE.replace(",RPE\n", ",RPE,Extra\n")).fatal, /header/);
  assert.match(parseStrongCsv(`${STRONG_HEADER.join(",")}\n2025-01-01 10:00:00,"open,1h,x,1,1,1,0,0,\n`).fatal, /never closed/);
  assert.match(parseStrongCsv("").fatal, /empty/);
  assert.equal(parseStrongCsv(swapped).workouts.length, 0);
});

test("strong: the sample parses with no errors; quotes, commas, emoji and a trailing space are read correctly", () => {
  const parsed = parseStrongCsv(FIXTURE);
  assert.equal(parsed.fatal, null);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.workouts.map((w) => w.rows.length), [10, 9, 3, 9]);
  const [a, b, c] = parsed.workouts;
  assert.equal(a.nameText, "Morning Lift, Heavy");
  assert.ok(a.rows.some((row) => row.exercise === 'Cable Row "Close", Wide (Cable)'));
  assert.equal(b.nameText, "Evening ☝\u{1F3FD}");
  assert.equal(c.rows[0].exercise, "Kneeling Cable Twist"); // the trailing space is gone
  assert.deepEqual(parsed.workouts.map((w) => w.durationSeconds), [5460, 3420, 7200, 2700]);
  assert.equal(a.startedAt.toISOString(), local(2025, 0, 10, 8, 0, 0)); // device-local time
});

test("strong: a BOM and CRLF line ends give exactly the same rows", () => {
  const plain = JSON.stringify(parseStrongCsv(FIXTURE));
  assert.equal(JSON.stringify(parseStrongCsv(`﻿${FIXTURE}`)), plain);
  assert.equal(JSON.stringify(parseStrongCsv(FIXTURE.replaceAll("\n", "\r\n"))), plain);
  assert.equal(JSON.stringify(parseStrongCsv(FIXTURE.trimEnd())), plain); // no final line end
  const { records } = parseCsv('a,"b\r\nc",d\n"x""y",,z\n');
  assert.deepEqual(records.map((r) => r.fields), [["a", "b\r\nc", "d"], ['x"y', "", "z"]]);
  assert.deepEqual(records.map((r) => r.line), [1, 3]);
});

test("strong: durations 1h 31m, 57m and 2h; any other form is an error, never 0", () => {
  assert.equal(parseDuration("1h 31m"), 5460);
  assert.equal(parseDuration("57m"), 3420);
  assert.equal(parseDuration("2h"), 7200);
  for (const bad of ["", "90", "1 hour", "1h 31", "m", "1h 31m x"]) assert.equal(parseDuration(bad), null, bad);
  const parsed = parseStrongCsv(withRows('2025-03-01 10:00:00,"X",90,"Squat (Barbell)",1,100.0,5.0,0,0.0,'));
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].line, NEXT_LINE);
});

for (const [what, row] of Object.entries(BAD_ROWS)) {
  test(`strong: ${what} blocks the write and names the line`, async () => {
    const { adapter } = await freshStore();
    const { parsed, plan } = await planFor(withRows(row), adapter);
    assert.deepEqual(parsed.errors.map((e) => e.line), [NEXT_LINE]);
    assert.equal(plan.ok, false);
    assert.equal(plan.report.workouts.withErrors, 1);
    await assert.rejects(applyStrongPlan(adapter, plan), /errors/);
  });
}

test("strong: every bad row is reported together, not one at a time", async () => {
  const { adapter } = await freshStore();
  const { plan } = await planFor(withRows(...Object.values(BAD_ROWS)), adapter);
  assert.deepEqual(plan.errors.map((e) => e.line), Object.keys(BAD_ROWS).map((_, i) => NEXT_LINE + i));
  assert.equal(plan.ok, false);
});

// ---- the plan

test("strong: no unit, no plan (nothing is assumed)", async () => {
  const parsed = parseStrongCsv(FIXTURE);
  const base = { parsed, mapping: mappingFor(parsed), existing: { exercises: [], workoutIds: [] } };
  await assert.rejects(buildStrongPlan(base), /unit/);
  await assert.rejects(buildStrongPlan({ ...base, unit: "stone" }), /unit/);
  await assert.rejects(buildStrongPlan({ ...base, unit: undefined }), /unit/);
});

test("strong: the plan maps times, markers, RPE, timed sets, bodyweight and order as decided", async () => {
  const { adapter } = await freshStore();
  const { plan } = await planFor(FIXTURE, adapter, { unit: "kg" });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const { workouts, entries, sets } = plan.records;
  const [a, b, c] = workouts;
  assert.equal(a.startedAt, local(2025, 0, 10, 8, 0, 0));
  assert.equal(a.endedAt, new Date(new Date(2025, 0, 10, 8, 0, 0).getTime() + 5460000).toISOString());
  assert.equal(a.name, "Morning Lift, Heavy");
  assert.equal(b.name, "Evening ☝\u{1F3FD}");
  assert.equal(c.name, "Short");
  assert.equal(workouts[3].name, "Short");
  assert.notEqual(c.id, workouts[3].id);
  assert.ok(sets.every((set) => set.weightUnit === "kg"));
  assert.ok(entries.every((entry) => entry.supersetGroup === null));
  // completedAt is the workout start for every set
  const startOf = new Map(entries.map((entry) => [entry.id, workouts.find((w) => w.id === entry.workoutId).startedAt]));
  assert.ok(sets.every((set) => set.completedAt === startOf.get(set.entryId)));
  // order 0..n-1 inside each entry, in file order
  for (const entry of entries) {
    assert.deepEqual(sets.filter((s) => s.entryId === entry.id).map((s) => s.order), [...Array(sets.filter((s) => s.entryId === entry.id).length).keys()]);
  }
  for (const w of workouts) {
    assert.deepEqual(entries.filter((e) => e.workoutId === w.id).map((e) => e.order), [...entries.filter((e) => e.workoutId === w.id).keys()]);
  }
  const setsOf = (workout, position) => sets.filter((s) => s.entryId === `${workout.id}-e${position}`);
  const squat = setsOf(a, 0);
  assert.deepEqual(squat.map((s) => [s.isWarmup, s.rpe, s.reps, s.weightValue]), [[true, undefined, 5, 45], [false, undefined, 5, 135], [false, 8, 5, 135]]);
  const bench = setsOf(a, 1);
  assert.deepEqual(bench.map((s) => s.setType), [undefined, "failure", "failure", "failure"]);
  assert.equal(bench.filter((s) => s.reps === 1 && s.weightValue === 185).length, 3); // the identical pairs are not merged
  assert.deepEqual(setsOf(a, 2).map((s) => s.setType), [undefined, "drop"]);
  const pullUp = setsOf(b, 0);
  assert.deepEqual(pullUp.map((s) => s.weightValue), [0, 0]);
  const plank = setsOf(b, 1);
  assert.deepEqual(plank.map((s) => [s.reps, s.durationSeconds, s.weightValue]), [[undefined, 60, 0], [undefined, 45, 0]]);
  assert.ok(plank.every((s) => !Object.hasOwn(s, "reps")));
  const twist = setsOf(c, 0);
  assert.deepEqual(twist.map((s) => [s.isWarmup, s.rpe, s.weightValue]), [[true, 6, 10], [false, 7.5, 22.5], [false, undefined, 22.5]]);
});

test("strong: dry-run counts, merges, times and dropped fields", async () => {
  const { adapter } = await freshStore();
  const { plan } = await planFor(FIXTURE, adapter);
  const { report } = plan;
  assert.deepEqual(report.workouts, { total: 4, new: 4, alreadyImported: 0, withErrors: 0, emptyAfterSkips: 0 });
  assert.equal(report.entries, 12);
  assert.equal(report.sets, 31);
  assert.deepEqual([report.warmups, report.failure, report.drop, report.rpeKept, report.timed, report.bodyweight], [2, 3, 1, 3, 2, 2]);
  assert.equal(report.customExercises, 9);
  assert.deepEqual(report.merges.map((m) => [m.date, m.exercise, m.blocks, m.reasons]), [
    ["2025-01-12 18:30:00", "Plank", 2, ["comes back later"]],
    ["2025-01-12 18:30:00", "Leg Press (Machine)", 2, ["numbering restarts"]],
  ]);
  assert.equal(report.firstStart.file, "2025-01-10 08:00:00");
  assert.equal(report.firstStart.utc, local(2025, 0, 10, 8, 0, 0));
  assert.equal(report.lastStart.file, "2025-02-01 09:15:00");
  assert.equal(typeof report.lastStart.utcOffsetMinutes, "number");
  assert.equal(report.dropped.skippedSets, 0);
  assert.match(report.dropped.fieldsNotStored.join(" "), /Distance/);
  // the returned exercise has one entry, with its sets in file order
  const b = plan.records.workouts[1];
  assert.equal(plan.records.entries.filter((e) => e.workoutId === b.id).length, 4);
});

test("strong: ids are deterministic from the Date and Workout Name", async () => {
  const { adapter } = await freshStore();
  const { plan } = await planFor(FIXTURE, adapter);
  const expected = createHash("sha256").update("strong|2025-01-10 08:00:00|Morning Lift, Heavy").digest("hex");
  assert.equal(plan.records.workouts[0].id, expected);
  assert.equal(plan.records.entries[0].id, `${expected}-e0`);
  assert.equal(plan.records.sets[0].id, `${expected}-e0-s0`);
  assert.equal(await sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
  const again = (await planFor(FIXTURE, adapter)).plan;
  assert.deepEqual(again.records, plan.records);
});

test("strong: without crypto.subtle the plan is refused, never given other ids", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const { adapter } = await freshStore();
  const parsed = parseStrongCsv(FIXTURE);
  const existing = await readImportContext(adapter);
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    await assert.rejects(buildStrongPlan({ parsed, unit: "lb", mapping: mappingFor(parsed), existing }), /crypto\.subtle/);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original); else delete globalThis.crypto;
  }
});

test("strong: a name with no choice, a missing target and a skip are handled and reported", async () => {
  const { adapter } = await freshStore();
  const parsed = parseStrongCsv(FIXTURE);
  const existing = await readImportContext(adapter);
  const none = await buildStrongPlan({ parsed, unit: "lb", mapping: new Map(), existing });
  assert.equal(none.ok, false);
  assert.ok(none.errors.length >= 9 && none.errors.every((e) => /no choice/.test(e.message)));
  const missing = await buildStrongPlan({
    parsed, unit: "lb", existing, mapping: mappingFor(parsed, () => ({ kind: "existing", exerciseId: "nope" })),
  });
  assert.equal(missing.ok, false);
  const skipped = await buildStrongPlan({
    parsed, unit: "lb", existing, mapping: mappingFor(parsed, (n) => (n.name === "Plank" ? { kind: "skip" } : chest())),
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.report.sets, 29);
  assert.equal(skipped.report.dropped.skippedSets, 2);
  assert.equal(skipped.report.dropped.skippedExercises, 1);
  assert.equal(skipped.report.timed, 0);
});

// ---- writing

async function storeWithExisting() {
  const { adapter, store } = await freshStore();
  await store.saveExercise({ name: "My Own Lift", primaryMuscles: ["biceps"], secondaryMuscles: [], equipmentTags: [], isCustom: true });
  const exercise = (await store.listExercises())[0];
  await store.saveWorkoutWithDetails(
    { id: "w-mine", startedAt: "2024-12-01T10:00:00.000Z", endedAt: "2024-12-01T11:00:00.000Z", name: "Mine" },
    [{ id: "e-mine", workoutId: "w-mine", exerciseId: exercise.id, order: 0 }],
    [{ id: "s-mine", entryId: "e-mine", order: 0, reps: 5, weightValue: 50, weightUnit: "kg", completedAt: "2024-12-01T10:30:00.000Z" }],
  );
  return { adapter, store, exercise };
}

test("strong apply: adds without touching what is stored; dry-run counts equal what was written", async () => {
  const { adapter, store, exercise } = await storeWithExisting();
  const before = JSON.parse(await exportOf(adapter));
  const { plan } = await planFor(FIXTURE, adapter, {
    pick: (n) => (n.name === "Plank" ? { kind: "existing", exerciseId: exercise.id } : chest()),
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const written = await applyStrongPlan(adapter, plan);
  const after = JSON.parse(await exportOf(adapter));
  for (const section of ["exercises", "workouts", "entries", "sets"]) {
    for (const record of before.data[section]) assert.deepEqual(after.data[section].find((r) => r.id === record.id), record, section);
  }
  assert.deepEqual(written, { exercises: 8, workouts: 4, entries: 12, sets: 31 });
  assert.equal(after.data.workouts.length - before.data.workouts.length, plan.report.workouts.new);
  assert.equal(after.data.entries.length - before.data.entries.length, plan.report.entries);
  assert.equal(after.data.sets.length - before.data.sets.length, plan.report.sets);
  assert.equal(plan.report.customExercises, 8); // Plank maps to the stored exercise, so only the other 8 are new
  assert.equal(after.data.exercises.length - before.data.exercises.length, 8);
  assert.equal((await store.listWorkouts()).length, 5);
  // the file the app would export from this data is accepted by its own import check
  assert.equal(inspectBackup(JSON.stringify(after)).counts.sets, 32);
});

test("strong apply: importing the same file again adds nothing", async () => {
  const { adapter } = await freshStore();
  const first = (await planFor(FIXTURE, adapter)).plan;
  await applyStrongPlan(adapter, first);
  const exported = await exportOf(adapter);
  const { plan: second } = await planFor(FIXTURE, adapter);
  assert.equal(second.ok, true);
  assert.deepEqual(second.report.workouts, { total: 4, new: 0, alreadyImported: 4, withErrors: 0, emptyAfterSkips: 0 });
  assert.deepEqual(second.records, { exercises: [], workouts: [], entries: [], sets: [] });
  assert.deepEqual(await applyStrongPlan(adapter, second), { exercises: 0, workouts: 0, entries: 0, sets: 0 });
  assert.equal(await exportOf(adapter), exported);
});

test("strong apply: an edited imported workout is skipped on re-import, never overwritten", async () => {
  const { adapter, store } = await freshStore();
  await applyStrongPlan(adapter, (await planFor(FIXTURE, adapter)).plan);
  const [first] = (await store.listWorkouts()).slice(-1);
  await adapter.transaction(["workouts"], "readwrite", (tx) => tx.put("workouts", { ...first, name: "Renamed by me" }));
  const exported = await exportOf(adapter);
  await applyStrongPlan(adapter, (await planFor(FIXTURE, adapter)).plan);
  assert.equal(await exportOf(adapter), exported);
});

test("strong apply: a failure part-way leaves the export byte-for-byte unchanged", async () => {
  const { adapter } = await storeWithExisting();
  const before = await exportOf(adapter);
  const { plan } = await planFor(FIXTURE, adapter);
  let puts = 0;
  const failing = {
    ...adapter,
    transaction: (names, mode, fn) => adapter.transaction(names, mode, (tx) => fn({
      ...tx,
      put: async (store, record) => { puts += 1; if (puts === 40) throw new Error("injected failure"); return tx.put(store, record); },
    })),
  };
  await assert.rejects(applyStrongPlan(failing, plan), /injected failure/);
  assert.ok(puts >= 40);
  assert.equal(await exportOf(adapter), before);
});

test("strong apply: an id that already exists is never overwritten", async () => {
  const { adapter } = await storeWithExisting();
  const { plan } = await planFor(FIXTURE, adapter);
  const clash = plan.records.sets[5];
  await adapter.transaction(["sets"], "readwrite", (tx) => tx.put("sets", { ...plan.records.sets[0], id: clash.id, entryId: "e-mine" }));
  const before = await exportOf(adapter);
  await assert.rejects(applyStrongPlan(adapter, plan), /same id already exists/);
  assert.equal(await exportOf(adapter), before);
});

test("strong apply: an exercise the plan needs that has gone is refused; a changed plan is refused", async () => {
  const { adapter, exercise } = await storeWithExisting();
  const { plan } = await planFor(FIXTURE, adapter, { pick: () => ({ kind: "existing", exerciseId: exercise.id }) });
  assert.equal(plan.ok, true);
  const before = await exportOf(adapter);
  const tampered = structuredClone(plan);
  tampered.records.sets[0].extra = true; // not a field of a set: the model would drop it, so the record is not canonical
  await assert.rejects(applyStrongPlan(adapter, tampered), /changed after it was built/);
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.delete("exercises", exercise.id));
  const gone = await exportOf(adapter);
  await assert.rejects(applyStrongPlan(adapter, plan), /no longer stored/);
  assert.equal(await exportOf(adapter), gone);
  assert.notEqual(gone, before);
});

test("strong apply: a custom exercise whose name is taken is refused", async () => {
  const { adapter } = await storeWithExisting();
  const { plan } = await planFor(FIXTURE, adapter);
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.put("exercises", { ...plan.records.exercises[0], id: "other-id" }));
  const before = await exportOf(adapter);
  await assert.rejects(applyStrongPlan(adapter, plan), /name/);
  assert.equal(await exportOf(adapter), before);
});

test("strong apply: records and PR / top-set results do not depend on stored order or timestamps", async () => {
  const { adapter, store } = await freshStore();
  await applyStrongPlan(adapter, (await planFor(FIXTURE, adapter)).plan);
  const sets = await store.listFinishedSetRecords();
  assert.equal(sets.length, 31);
  const orders = [sets, [...sets].reverse(), [...sets.slice(7), ...sets.slice(0, 7)], [...sets].sort((a, b) => (a.id < b.id ? 1 : -1))];
  const exerciseIds = [...new Set(sets.map((s) => s.exerciseId))];
  const results = orders.map((list) => JSON.stringify({
    prs: personalRecords(list, "lb"),
    history: prHistory(list, "lb").history,
    // Of two sets with the same weight and reps, sessionsOf names whichever it meets first (existing behaviour, not
    // changed here), so only the values of the top set are compared, not which identical set carries them.
    sessions: exerciseIds.map((id) => sessionsOf(list, id, "lb").map((s) => ({ ...s, top: { weightValue: s.top.weightValue, reps: s.top.reps } }))),
  }));
  assert.ok(results.every((r) => r === results[0]));
  assert.ok(JSON.parse(results[0]).history.length > 0);
  // every working set with reps is countable (so PRs see it); a warm-up and a timed set are not, by the app's own rule
  for (const set of sets) {
    const countable = set.isWarmup !== true && set.reps !== undefined;
    assert.equal(isCountableSet(set), countable);
  }
  assert.equal(sets.filter(isCountableSet).length, 31 - 2 - 2);
});

test("strong apply: the written data survives an export and the app's own import check", async () => {
  const { adapter } = await freshStore();
  await applyStrongPlan(adapter, (await planFor(FIXTURE, adapter)).plan);
  const info = inspectBackup(await exportOf(adapter));
  assert.deepEqual([info.counts.workouts, info.counts.entries, info.counts.sets, info.counts.exercises], [4, 12, 31, 9]);
});

// ---- matching and the review

const ex = (id, name, primaryMuscles, extra = {}) => ({ id, name, primaryMuscles, secondaryMuscles: [], equipmentTags: [], retired: false, ...extra });
const names = (...list) => list.map((name) => ({ name, sets: 3, workouts: 2 }));

test("strong match: rule a, rule b, and no match is never auto-accepted", () => {
  const stored = [
    ex("1", "Pull Up", ["lats"]), ex("2", "Barbell Back Squat", ["quads"]), ex("3", "Wide-Grip Lat Pulldown", ["lats"]),
    ex("4", "Barbell Bench Press", ["chest"], { retired: true }),
  ];
  const [a, b, c, retired] = matchStrongNames(names("pull up", "Back Squat (Barbell)", "Lat Pulldown - Wide Grip (Cable)", "Bench Press (Barbell)"), stored);
  assert.deepEqual([a.status, a.rule, a.target.id], ["auto", "a", "1"]);
  assert.equal(reorderEquipment("Back Squat (Barbell)"), "Barbell Back Squat");
  assert.deepEqual([b.status, b.rule, b.target.id], ["auto", "b", "2"]);
  assert.equal(c.status, "suggested"); // similar, so suggested but never taken
  assert.equal(c.target, null);
  assert.equal(c.suggestions[0].exercise.id, "3");
  assert.deepEqual(c.muscles, { source: "candidate", ids: ["lats"] });
  assert.equal(retired.status, "none"); // a retired exercise is neither matched nor suggested
  assert.deepEqual(retired.suggestions, []);
});

test("strong match: two stored exercises with the same name are not auto-matched; at most 3 suggestions", () => {
  const stored = [ex("1", "Curl", ["biceps"]), ex("2", "curl", ["biceps"], { isCustom: true })];
  const [dup] = matchStrongNames(names("Curl"), stored);
  assert.equal(dup.status, "suggested");
  const many = Array.from({ length: 6 }, (_, i) => ex(`m${i}`, `Cable Row Variant ${i}`, ["lats"]));
  const [r] = matchStrongNames(names("Cable Row Variant"), many);
  assert.equal(r.suggestions.length, MAX_SUGGESTIONS);
});

test("strong match: muscles come from the best candidate, else the table, else none", () => {
  const stored = [ex("1", "Skullcrusher Variation", ["triceps"])];
  const [candidate, table, nothing] = matchStrongNames(names("Skullcrusher Variation (EZ Bar)", "Hip Abductor (Machine)", "Zzz Unknown Thing"), stored);
  assert.equal(candidate.muscles.source, "candidate");
  assert.deepEqual(table.muscles, { source: "table", ids: ["abductors"] });
  assert.deepEqual(nothing.muscles, { source: null, ids: [] });
  assert.equal(nothing.status, "none");
});

test("strong muscle table: every id is a real muscle, every key is in its stored form", () => {
  for (const [key, ids] of Object.entries(STRONG_MUSCLES)) {
    assert.equal(key, tableKey(key), key);
    assert.ok(ids.length > 0);
    for (const id of ids) assert.ok(ALL_MUSCLES.includes(id), `${key}: ${id}`);
  }
});

// ---- aliases

const ALIAS_NAMES = [
  "Hip Abductor (Machine)", "Hip Adductor (Machine)", "Farmer Carries", "Palloff Press", "Cable Woodchoppers",
  "Reverse Fly (Dumbbell)", "Triceps Pushdown (Cable - Straight Bar)",
];
const BUILT_IN = [...SEED_EXERCISES, ...CATALOG.map(catalogEntryToRecord)];

test("strong aliases: exactly the 7 known misses, each pointing at a seed or catalog exercise that is not retired", () => {
  assert.equal(CATALOG_VERSION, 1, "the catalog changed: check every alias target again, then update this pin");
  assert.deepEqual(Object.keys(STRONG_ALIASES).sort(), ALIAS_NAMES.map(nameKey).sort());
  const byId = new Map(BUILT_IN.map((exercise) => [exercise.id, exercise]));
  for (const [key, id] of Object.entries(STRONG_ALIASES)) {
    assert.ok(byId.has(id), `${key}: ${id} is not a seed or catalog id`);
    assert.notEqual(byId.get(id).retired, true, `${key}: ${id} is retired`);
  }
});

test("strong aliases: shown first and only suggested, muscles from the target's record; ignored when the target is not stored or retired", () => {
  const results = matchStrongNames(names(...ALIAS_NAMES), BUILT_IN);
  for (const r of results) {
    const target = BUILT_IN.find((exercise) => exercise.id === STRONG_ALIASES[nameKey(r.name)]);
    assert.equal(r.status, "suggested", r.name);
    assert.equal(r.target, null, r.name);
    assert.deepEqual([r.suggestions[0].exercise.id, r.suggestions[0].alias], [target.id, true], r.name);
    assert.ok(r.suggestions.length <= MAX_SUGGESTIONS && r.suggestions.filter((s) => s.exercise.id === target.id).length === 1, r.name);
    assert.deepEqual(r.muscles, { source: "candidate", ids: target.primaryMuscles }, r.name);
  }
  const palloff = results.find((r) => r.name === "Palloff Press");
  assert.deepEqual(palloff.muscles.ids, ["abs"]); // the catalog record's muscles, not the importer's table (obliques)
  assert.match(renderReview(results), /1\) "Pallof Press" \[abs\] alias/);
  const withoutTarget = BUILT_IN.filter((exercise) => exercise.id !== "Pallof_Press");
  const retiredTarget = BUILT_IN.map((exercise) => (exercise.id === "Pallof_Press" ? { ...exercise, retired: true } : exercise));
  for (const stored of [withoutTarget, retiredTarget]) {
    const [r] = matchStrongNames(names("Palloff Press"), stored);
    assert.ok(r.suggestions.every((s) => s.alias !== true && s.exercise.id !== "Pallof_Press"));
  }
});

test("strong aliases: a name that also matches a stored exercise by rule a is auto-matched to it; the alias is not used", () => {
  const mine = ex("mine", "Palloff Press", ["obliques"], { isCustom: true });
  const [r] = matchStrongNames(names("Palloff Press"), [...BUILT_IN, mine]);
  assert.deepEqual([r.status, r.rule, r.target.id], ["auto", "a", "mine"]);
  assert.deepEqual(r.suggestions, []);
});

test("strong apply: a seed or a catalog exercise can be the target; both records are left exactly as stored", async () => {
  const { adapter, store } = await freshStore();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  await createCatalogStore(adapter).syncCatalog(CATALOG, { version: CATALOG_VERSION, count: CATALOG.length });
  const targets = { "Curl (Dumbbell)": "seed-triceps-pushdown", Plank: "Pallof_Press" };
  const before = await Promise.all(Object.values(targets).map((id) => store.getExercise(id)));
  assert.ok(before.every((exercise) => exercise !== undefined && exercise !== null));
  const { plan } = await planFor(FIXTURE, adapter, {
    pick: (n) => (Object.hasOwn(targets, n.name) ? { kind: "existing", exerciseId: targets[n.name] } : chest()),
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.requiredExerciseIds.sort(), Object.values(targets).sort());
  await applyStrongPlan(adapter, plan);
  const entries = await adapter.transaction(["entries"], "readonly", (tx) => tx.getAll("entries"));
  for (const id of Object.values(targets)) assert.ok(entries.some((entry) => entry.exerciseId === id), id);
  assert.deepEqual(await Promise.all(Object.values(targets).map((id) => store.getExercise(id))), before);
});

test("strong review: one line per name, says nothing is applied, and shows each kind of proposal", () => {
  const stored = [ex("1", "Pull Up", ["lats"]), ex("3", "Wide-Grip Lat Pulldown", ["lats"])];
  const results = matchStrongNames(names("Pull Up", "Lat Pulldown - Wide Grip (Cable)", "Hip Abductor (Machine)", "Zzz Unknown Thing"), stored);
  const text = renderReview(results);
  const body = text.split("\n").filter((line) => line.includes(" | "));
  assert.equal(body.length, 4);
  assert.match(text, /Nothing below has been applied/);
  assert.match(body[0], /MATCHED \(rule a\)/);
  assert.match(body[1], /SUGGESTED: 1\) "Wide-Grip Lat Pulldown"/);
  assert.match(body[2], /suggested: abductors \(from the importer's table\)/);
  assert.match(body[3], /no suggestion/);
  assert.match(text, /4 names: 1 matched, 1 with candidates, 1 with table muscles only, 1 with no suggestion/);
});

// ---- the real file (only when a path is given; counts only, nothing is printed about rows, names or weights)

test("strong: the real export, when APOGEE_STRONG_FILE is set", { skip: !process.env.APOGEE_STRONG_FILE }, async () => {
  const text = readFileSync(process.env.APOGEE_STRONG_FILE, "utf8");
  const parsed = parseStrongCsv(text);
  assert.equal(parsed.fatal, null);
  assert.equal(parsed.errors.length, 0);
  const rows = parsed.workouts.flatMap((w) => w.rows);
  const stored = [...SEED_EXERCISES, ...CATALOG.map(catalogEntryToRecord)];
  const results = matchStrongNames(strongNameCounts(parsed.workouts), stored);
  const count = (pick) => results.filter(pick).length;
  const numbers = {
    names: results.length,
    autoMatched: count((r) => r.status === "auto"),
    candidateSuggested: count((r) => r.status === "suggested"),
    tableSuggested: count((r) => r.status === "none" && r.muscles.source === "table"),
    noSuggestion: count((r) => r.status === "none" && r.muscles.source === null),
  };
  assert.equal(numbers.autoMatched + numbers.candidateSuggested + numbers.tableSuggested + numbers.noSuggestion, numbers.names);
  const { adapter, store } = await freshStore();
  await store.seedExercises(stored.map((e) => e), 1);
  const existing = await readImportContext(adapter);
  const mapping = new Map();
  for (const r of results) mapping.set(nameKey(r.name), r.status === "auto" ? { kind: "existing", exerciseId: r.target.id } : chest());
  const plan = await buildStrongPlan({ parsed, unit: "lb", mapping, existing });
  assert.equal(plan.ok, true, `${plan.errors.length} errors`);
  assert.equal(plan.report.sets, rows.length); // no row is dropped or merged away
  assert.equal(plan.report.workouts.new, parsed.workouts.length);
  const marker = (m) => rows.filter((r) => r.marker === m).length;
  assert.deepEqual([plan.report.warmups, plan.report.failure, plan.report.drop], [marker("W"), marker("F"), marker("D")]);
  assert.equal(plan.report.timed, rows.filter((r) => r.seconds > 0).length);
  const written = await applyStrongPlan(adapter, plan);
  assert.equal(written.sets, rows.length);
  console.log(`strong real file (counts only): ${JSON.stringify({ ...numbers, workouts: plan.report.workouts, entries: plan.report.entries, sets: plan.report.sets, merges: plan.report.merges.length })}`);
});
