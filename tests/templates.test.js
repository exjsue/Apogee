// Schema version 4: templates. The pure rules (createTemplate, templateFromWorkout), the 3-to-4 upgrade step
// from every older version, and the shared template rules against the memory adapter. Expected values are
// written out by hand; none is computed with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createStore } from "../src/storage/store.js";
import { upgradeData, STEPS } from "../src/storage/migrations.js";
import { createTemplate, SCHEMA_VERSION, TEMPLATE_MAX_EXERCISES, TEMPLATE_MAX_SETS } from "../src/domain/model.js";
import { templateFromWorkout } from "../src/domain/template.js";
import { templateRules } from "./template-rules.js";

for (const { name, run } of templateRules) {
  test(`template rules: ${name}`, async () => {
    const adapters = [];
    const createAdapter = () => {
      const adapter = createMemoryAdapter();
      adapters.push(adapter);
      return adapter;
    };
    try {
      await run({ assert, createAdapter });
    } finally {
      for (const adapter of adapters) adapter.close();
    }
  });
}

// ---- createTemplate: the name ----

const item = (exerciseId, setCount = 3) => ({ exerciseId, setCount });

test("template name: trimmed, every run of whitespace one space; 80 characters (code points) accepted, 81 refused, never cut", () => {
  assert.equal(createTemplate({ id: "t", name: "  Push\t\n  day  ", exercises: [item("a")] }).name, "Push day");
  assert.equal(createTemplate({ id: "t", name: "n".repeat(80), exercises: [item("a")] }).name, "n".repeat(80));
  assert.equal(createTemplate({ id: "t", name: "🏋".repeat(80), exercises: [item("a")] }).name, "🏋".repeat(80)); // 160 UTF-16 units
  assert.equal(createTemplate({ id: "t", name: ` ${"n".repeat(80)}   `, exercises: [item("a")] }).name, "n".repeat(80)); // counted after normalizing
  assert.throws(() => createTemplate({ id: "t", name: "n".repeat(81), exercises: [item("a")] }), /^Error: name must be at most 80 characters$/);
  for (const bad of ["", "   ", "\n\t", undefined, null, 5, ["Push"]]) {
    assert.throws(() => createTemplate({ id: "t", name: bad, exercises: [item("a")] }), /^Error: name must be a non-empty string$/, String(bad));
  }
});

test("template: the record is exactly id, name and exercises; an id is made when none is given; limits are 50 and 50", () => {
  assert.deepEqual(createTemplate({ id: "t", name: "A", exercises: [item("a", 2)], extra: 1, createdAt: "x" }), { id: "t", name: "A", exercises: [{ exerciseId: "a", setCount: 2 }] });
  assert.equal(typeof createTemplate({ name: "A", exercises: [item("a")] }).id, "string");
  assert.deepEqual([TEMPLATE_MAX_EXERCISES, TEMPLATE_MAX_SETS], [50, 50]);
  const fifty = Array.from({ length: 50 }, (_, i) => item(`x${i}`, 50));
  assert.equal(createTemplate({ id: "t", name: "A", exercises: fifty }).exercises.length, 50);
  assert.throws(() => createTemplate({ id: "t", name: "A", exercises: [...fifty, item("y")] }), /at most 50 entries/);
  assert.throws(() => createTemplate({ id: "t", name: "A", exercises: [item("a", 51)] }), /setCount must be at most 50/);
});

// ---- templateFromWorkout ----

const set = (id, extra = {}) => ({ id, entryId: "e", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: 90, completedAt: "2026-10-01T10:00:00.000Z", ...extra });
const finished = (entries) => ({ id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "secret notes", entries });
const entry = (id, exerciseId, order, sets) => ({ id, workoutId: "w1", exerciseId, order, supersetGroup: null, notes: "entry notes", sets });

test("templateFromWorkout: exercises in entry order (not list order), one count per entry of its non-warm-up sets", () => {
  const workout = finished([
    entry("e2", "squat", 1, [set("s3"), set("s4")]),
    entry("e1", "bench", 0, [set("s0", { isWarmup: true }), set("s1"), set("s2"), set("s5")]),
  ]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "Day" }), {
    id: "t", name: "Day", exercises: [{ exerciseId: "bench", setCount: 3 }, { exerciseId: "squat", setCount: 2 }],
  });
});

test("templateFromWorkout: an entry with no sets, or only warm-ups, is left out; a workout left with nothing is refused", () => {
  const workout = finished([entry("e1", "a", 0, []), entry("e2", "b", 1, [set("s1", { isWarmup: true })]), entry("e3", "c", 2, [set("s2")])]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "x" }).exercises, [{ exerciseId: "c", setCount: 1 }]);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [])]), { id: "t", name: "x" }), /no working sets/);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [set("w", { isWarmup: true })])]), { id: "t", name: "x" }), /no working sets/);
  assert.throws(() => templateFromWorkout(finished([]), { id: "t", name: "x" }), /no working sets/);
});

test("templateFromWorkout: an exercise with two entries is listed once, where it first appears, with the counts added; over 50 is refused", () => {
  const workout = finished([entry("e1", "a", 0, [set("1")]), entry("e2", "b", 1, [set("2")]), entry("e3", "a", 2, [set("3"), set("4")])]);
  assert.deepEqual(templateFromWorkout(workout, { id: "t", name: "x" }).exercises, [{ exerciseId: "a", setCount: 3 }, { exerciseId: "b", setCount: 1 }]);
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => set(`${prefix}${i}`));
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, many(30, "p")), entry("e2", "a", 1, many(21, "q"))]), { id: "t", name: "x" }), /setCount must be at most 50/);
});

test("templateFromWorkout: an unfinished workout is refused, and the name rule applies", () => {
  assert.throws(() => templateFromWorkout({ ...finished([entry("e1", "a", 0, [set("1")])]), endedAt: null }, { id: "t", name: "x" }), /Only a finished workout/);
  assert.throws(() => templateFromWorkout(finished([entry("e1", "a", 0, [set("1")])]), { id: "t", name: "  " }), /name must be a non-empty string/);
  assert.throws(() => templateFromWorkout(null, { name: "x" }), /workout must be a workout/);
});

test("templateFromWorkout: keeps nothing of the workout but exercise ids and counts, and shares no object with it", () => {
  const workout = finished([entry("e1", "a", 0, [set("1"), set("2")])]);
  const template = templateFromWorkout(workout, { id: "t", name: "x" });
  const text = JSON.stringify(template);
  for (const leaked of ["w1", "e1", "secret notes", "entry notes", "100", "kg", "2026", "90"]) assert.ok(!text.includes(leaked), leaked);
  workout.entries[0].exerciseId = "changed";
  workout.entries[0].sets.pop();
  workout.entries.length = 0;
  assert.deepEqual(template, { id: "t", name: "x", exercises: [{ exerciseId: "a", setCount: 2 }] });
});

// ---- the upgrade to schema version 4, from every older version ----

const OLD_STORES = ["exercises", "workouts", "entries", "sets", "meta"];
const ALL = [...OLD_STORES, "templates"];
const V3_EXERCISE = {
  id: "ex-1", name: "Mine", primaryMuscles: ["abs"], secondaryMuscles: [], equipmentTags: [], notes: "n", isCustom: true, defaultRestSeconds: null,
  baseMovementId: null, equipment: null, variations: [], origin: "custom", upstreamId: null, catalogVersion: null, retired: false,
};
const HISTORY = {
  workouts: [
    { id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", notes: "done" },
    { id: "w2", startedAt: "2026-10-20T10:00:00.000Z", endedAt: null, notes: "" },
  ],
  entries: [
    { id: "e1", workoutId: "w1", exerciseId: "ex-1", order: 0, supersetGroup: null, notes: "" },
    { id: "e2", workoutId: "w2", exerciseId: "ex-1", order: 0, supersetGroup: null, notes: "x" },
  ],
  sets: [
    { id: "s1", entryId: "e1", order: 0, reps: 8, weightValue: 62.5, weightUnit: "lb", isWarmup: true, restSeconds: 60, completedAt: "2026-10-01T10:05:00.000Z" },
    { id: "s2", entryId: "e1", order: 1, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: null },
    { id: "s3", entryId: "e2", order: 0, reps: 10, weightValue: 0, weightUnit: "kg", isWarmup: false, restSeconds: 90, completedAt: "2026-10-20T10:01:00.000Z" },
  ],
};
// The exercise as each older schema stored it.
const exerciseAt = (version) => {
  if (version >= 3) return V3_EXERCISE;
  const { baseMovementId, equipment, variations, origin, upstreamId, catalogVersion, retired, ...v2 } = V3_EXERCISE;
  if (version === 2) return v2;
  const { defaultRestSeconds, ...v1 } = v2;
  return v1;
};

async function populatedAt(version) {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await adapter.transaction(OLD_STORES, "readwrite", async (tx) => {
    await tx.put("exercises", exerciseAt(version));
    for (const [name, list] of Object.entries(HISTORY)) for (const record of list) await tx.put(name, record);
    await tx.put("meta", { key: "schemaVersion", value: version });
    await tx.put("meta", { key: "preferredUnit", value: "kg" });
    await tx.put("meta", { key: "workoutPlan", value: { exercises: ["ex-1"], rows: [], rev: 4 } });
  });
  return adapter;
}
const dump = (adapter) => adapter.transaction(ALL, "readonly", async (tx) => {
  const out = {};
  for (const name of ALL) out[name] = (await tx.getAll(name)).sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
  return out;
});
const upgrade = (adapter, oldVersion) => adapter.transaction(ALL, "readwrite", (tx) => upgradeData({ oldVersion, tx }));

for (const [version, ran] of [[1, [2, 3, 4, 5]], [2, [3, 4, 5]], [3, [4, 5]]]) {
  test(`schema 4 upgrade: from version ${version}, the steps ${ran.join(", ")} run, the schema version becomes 5, there are no templates, and workouts, entries and sets are byte for byte what they were`, async () => {
    const adapter = await populatedAt(version);
    const before = await dump(adapter);
    assert.deepEqual(await upgrade(adapter, version), ran);
    const after = await dump(adapter);
    for (const name of ["workouts", "entries", "sets"]) assert.equal(JSON.stringify(after[name]), JSON.stringify(before[name]), name);
    assert.equal(JSON.stringify(after.workouts), JSON.stringify(HISTORY.workouts));
    assert.equal(JSON.stringify(after.sets), JSON.stringify(HISTORY.sets));
    assert.deepEqual(after.exercises, [V3_EXERCISE]); // every older exercise ends as schema 3 stores it
    assert.deepEqual(after.templates, []);
    assert.deepEqual(after.meta, [
      { key: "preferredUnit", value: "kg" },
      { key: "schemaVersion", value: 5 },
      { key: "workoutPlan", value: { exercises: ["ex-1"], rows: [], rev: 4 } },
    ]);
    assert.deepEqual(await upgrade(adapter, 5), []); // already version 5: no step runs
    assert.deepEqual(await dump(adapter), after);
  });
}

test("schema 4 upgrade: the 3-to-4 step reads and writes nothing but the schema version, and a new database has nothing to upgrade", async () => {
  assert.equal(SCHEMA_VERSION, 5);
  assert.deepEqual(STEPS.map((step) => step.to), [2, 3, 4, 5]);
  const calls = [];
  const spy = new Proxy({}, { get: (_target, method) => async (...args) => { calls.push([method, ...args.slice(0, 1)]); } });
  await STEPS.find((step) => step.to === 4).run(spy);
  assert.deepEqual(calls, []);
  const fresh = createMemoryAdapter();
  await fresh.open();
  assert.deepEqual(await upgrade(fresh, 0), []);
});

test("schema 4: a store opened on a database that has no templates yet lists none and can save one", async () => {
  const adapter = await populatedAt(3);
  await upgrade(adapter, 3);
  const store = createStore(adapter);
  await store.open();
  assert.deepEqual(await store.listTemplates(), []);
  await store.saveTemplate({ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 2 }] });
  assert.deepEqual(await store.listTemplates(), [{ id: "t", name: "Mine", exercises: [{ exerciseId: "ex-1", setCount: 2 }] }]);
});
