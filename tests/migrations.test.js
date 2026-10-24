import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { upgradeData, STEPS } from "../src/storage/migrations.js";
import { failAfter } from "./store-rules.js";

// The step-2 tests run step 2 alone, as they did before step 3 existed.
const STEPS_TO_2 = STEPS.filter((s) => s.to === 2);
// The chaining test adds its own step 4 to steps 2 and 3, as it did before the real step 4 existed.
const STEPS_TO_3 = STEPS.filter((s) => s.to <= 3);

// An exercise as saved by schema version 1: no defaultRestSeconds.
const v1 = (id, extra = {}) => ({
  id, name: id, primaryMuscles: ["chest"], secondaryMuscles: [], equipmentTags: [], notes: "", isCustom: false, ...extra,
});
const SET = { id: "s1", entryId: "e1", order: 0, reps: 5, weightValue: 100, weightUnit: "kg", isWarmup: false, restSeconds: null, completedAt: null };
const STORES = ["exercises", "workouts", "entries", "sets", "meta"];

async function populated() {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await adapter.transaction(STORES, "readwrite", async (tx) => {
    await tx.put("exercises", v1("a"));
    await tx.put("exercises", v1("b", { isCustom: true, notes: "mine" }));
    await tx.put("exercises", v1("c", { defaultRestSeconds: 120 })); // already has a value: must stay
    await tx.put("workouts", { id: "w1", startedAt: "2026-10-01T10:00:00.000Z", endedAt: null, notes: "" });
    await tx.put("entries", { id: "e1", workoutId: "w1", exerciseId: "a", order: 0, supersetGroup: null, notes: "" });
    await tx.put("sets", SET);
    await tx.put("meta", { key: "schemaVersion", value: 1 });
    await tx.put("meta", { key: "preferredUnit", value: "kg" });
  });
  return adapter;
}

const snapshot = (adapter) => adapter.transaction(STORES, "readonly", async (tx) => {
  const out = {};
  for (const name of STORES) out[name] = (await tx.getAll(name)).sort((x, y) => String(x.id ?? x.key).localeCompare(String(y.id ?? y.key)));
  return out;
});
const run = (adapter, oldVersion, extra = {}) =>
  adapter.transaction(STORES, "readwrite", (tx) => upgradeData({ oldVersion, tx, ...extra }));

test("migration 1 to 2: every exercise without defaultRestSeconds gets null, and the stored schema version becomes 2", async () => {
  const adapter = await populated();
  assert.deepEqual(await run(adapter, 1, { steps: STEPS_TO_2 }), [2]);
  const after = await snapshot(adapter);
  assert.deepEqual(after.exercises.map((e) => [e.id, e.defaultRestSeconds]), [["a", null], ["b", null], ["c", 120]]);
  assert.deepEqual(after.meta.find((m) => m.key === "schemaVersion"), { key: "schemaVersion", value: 2 });
});

test("migration 1 to 2: nothing else changes: other fields, history and the other settings stay exactly as they were", async () => {
  const adapter = await populated();
  const before = await snapshot(adapter);
  await run(adapter, 1, { steps: STEPS_TO_2 });
  const after = await snapshot(adapter);
  assert.deepEqual(after.workouts, before.workouts);
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.sets, before.sets);
  assert.deepEqual(after.meta.filter((m) => m.key !== "schemaVersion"), before.meta.filter((m) => m.key !== "schemaVersion"));
  for (const exercise of after.exercises) {
    const { defaultRestSeconds, ...rest } = exercise;
    const { defaultRestSeconds: _old, ...original } = before.exercises.find((e) => e.id === exercise.id);
    assert.deepEqual(rest, original);
  }
});

test("migration 1 to 2: a value set after the upgrade is never overwritten, and running again changes nothing (idempotent)", async () => {
  const adapter = await populated();
  await run(adapter, 1, { steps: STEPS_TO_2 });
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.put("exercises", v1("a", { defaultRestSeconds: 90 })));
  const settled = await snapshot(adapter);
  assert.deepEqual(await run(adapter, 2, { steps: STEPS_TO_2 }), []); // already version 2: no step runs
  assert.deepEqual(await snapshot(adapter), settled);
  assert.deepEqual(await run(adapter, 1, { steps: STEPS_TO_2 }), [2]); // even if it were run again on version 1 data
  assert.deepEqual((await snapshot(adapter)).exercises.map((e) => [e.id, e.defaultRestSeconds]), [["a", 90], ["b", null], ["c", 120]]);
});

test("migration: a new database (version 0) has nothing to upgrade and writes nothing", async () => {
  const adapter = createMemoryAdapter();
  await adapter.open();
  assert.deepEqual(await run(adapter, 0), []);
  const after = await snapshot(adapter);
  assert.deepEqual(Object.values(after).map((records) => records.length), [0, 0, 0, 0, 0]);
});

test("migration: a failure part-way undoes all of it: no exercise changed and the version is not written", async () => {
  const adapter = await populated();
  const before = await snapshot(adapter);
  const failing = failAfter(adapter, { puts: 1 }); // the first exercise is written, the second put fails
  await assert.rejects(
    failing.transaction(STORES, "readwrite", (tx) => upgradeData({ oldVersion: 1, tx, steps: STEPS_TO_2 })),
    /injected failure/,
  );
  assert.deepEqual(await snapshot(adapter), before);
  assert.deepEqual(await run(adapter, 1, { steps: STEPS_TO_2 }), [2]); // and the upgrade still works afterwards
});

test("migration: steps run in order, each one writes its own version, and later versions chain", async () => {
  const adapter = await populated();
  const order = [];
  const steps = [
    ...STEPS_TO_3,
    { to: 4, run: async (tx) => { order.push("4"); await tx.put("meta", { key: "four", value: true }); } },
  ];
  assert.deepEqual(await run(adapter, 1, { steps }), [2, 3, 4]);
  assert.deepEqual(order, ["4"]);
  const after = await snapshot(adapter);
  assert.equal(after.meta.find((m) => m.key === "schemaVersion").value, 4);
  assert.deepEqual(await run(adapter, 3, { steps }), [4]); // from version 3 only the new step runs
});
