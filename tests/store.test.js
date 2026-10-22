import test from "node:test";
import assert from "node:assert/strict";
import { storeRules } from "./store-rules.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { requestPersistentStorage } from "../src/storage/idb-adapter.js";

// The shared rules, against the memory adapter.
for (const { name, run } of storeRules) {
  test(`store rules: ${name}`, async () => {
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

async function openMemory() {
  const adapter = createMemoryAdapter();
  await adapter.open();
  return adapter;
}

test("memory adapter: records are copied on put and on get", async () => {
  const adapter = await openMemory();
  const record = { id: "a", tags: ["x"] };
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.put("exercises", record));
  record.tags.push("changed after put");
  const read = await adapter.transaction(["exercises"], "readonly", (tx) => tx.get("exercises", "a"));
  assert.deepEqual(read.tags, ["x"]);
  read.tags.push("changed after get");
  const again = await adapter.transaction(["exercises"], "readonly", (tx) => tx.get("exercises", "a"));
  assert.deepEqual(again.tags, ["x"]);
});

test("memory adapter: a throwing callback rolls back its writes", async () => {
  const adapter = await openMemory();
  await assert.rejects(
    adapter.transaction(["exercises"], "readwrite", async (tx) => {
      await tx.put("exercises", { id: "a" });
      throw new Error("boom");
    }),
    /boom/,
  );
  const all = await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"));
  assert.deepEqual(all, []);
});

test("memory adapter: read-only transactions reject writes", async () => {
  const adapter = await openMemory();
  await assert.rejects(
    adapter.transaction(["exercises"], "readonly", (tx) => tx.put("exercises", { id: "a" })),
    /read-only/,
  );
});

test("memory adapter: a handle cannot be used after its transaction ends", async () => {
  const adapter = await openMemory();
  let leaked;
  await adapter.transaction(["exercises"], "readonly", async (tx) => {
    leaked = tx;
  });
  await assert.rejects(leaked.get("exercises", "a"), /finished/);
});

test("memory adapter: unknown stores, stores outside the transaction and unknown indexes are rejected", async () => {
  const adapter = await openMemory();
  await assert.rejects(adapter.transaction(["nope"], "readonly", async () => {}), /unknown store/);
  await assert.rejects(
    adapter.transaction(["exercises"], "readonly", (tx) => tx.get("workouts", "a")),
    /not part of this transaction/,
  );
  await assert.rejects(
    adapter.transaction(["entries"], "readonly", (tx) => tx.getAllByIndex("entries", "exerciseId", "x")),
    /no index/,
  );
});

test("memory adapter: refuses work while closed", async () => {
  const adapter = await openMemory();
  adapter.close();
  await assert.rejects(adapter.transaction(["exercises"], "readonly", async () => {}), /not open/);
});

test("requestPersistentStorage: reports the browser's answer without assuming success", async () => {
  assert.deepEqual(await requestPersistentStorage({ persist: async () => true }), { supported: true, persisted: true, error: null });
  assert.deepEqual(await requestPersistentStorage({ persist: async () => false }), { supported: true, persisted: false, error: null });
  assert.deepEqual(await requestPersistentStorage(undefined), { supported: false, persisted: false, error: null });
  assert.deepEqual(await requestPersistentStorage({}), { supported: false, persisted: false, error: null });
  assert.deepEqual(
    await requestPersistentStorage({ persist: async () => { throw new Error("denied"); } }),
    { supported: true, persisted: false, error: "denied" },
  );
});
