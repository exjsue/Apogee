import test from "node:test";
import assert from "node:assert/strict";
import { catalogRules } from "./catalog-rules.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { isCatalogRecord, countCatalogRecords, flagSaysCurrent, checkCatalogIntegrity } from "../src/domain/builtin.js";
import { createCatalogService } from "../src/app/catalog.js";
import { SEED_EXERCISES } from "../src/domain/seed.js";
import { CATALOG } from "../src/catalog/catalog.js";
import { CATALOG_VERSION, CATALOG_COUNT } from "../src/catalog/catalog-info.js";

// The shared rules, against the memory adapter.
for (const { name, run } of catalogRules) {
  test(name, async () => {
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

// ---- src/domain/builtin.js ----

test("builtin: seeds (catalogVersion null) and customs are never catalog records, whatever their version says", () => {
  assert.ok(SEED_EXERCISES.every((seed) => seed.catalogVersion === null && !isCatalogRecord(seed)));
  assert.equal(countCatalogRecords(SEED_EXERCISES), 0);
  // a seed that somehow carries a catalog version is still not a catalog record
  assert.equal(isCatalogRecord({ ...SEED_EXERCISES[0], catalogVersion: 1 }), false);
  assert.equal(isCatalogRecord({ isCustom: true, origin: "custom", catalogVersion: 1 }), false);
  assert.equal(isCatalogRecord({ isCustom: false, origin: "upstream", catalogVersion: null }), true);
});

test("builtin: flagSaysCurrent needs the version, the same stored count, and the catalog covered", () => {
  const info = { version: 1, count: 10 };
  assert.equal(flagSaysCurrent({ version: 1, conflicts: [], stored: 10 }, 10, info), true);
  assert.equal(flagSaysCurrent({ version: 1, conflicts: ["x"], stored: 9 }, 9, info), true);
  assert.equal(flagSaysCurrent({ version: 1, conflicts: [], stored: 12 }, 12, info), true); // extras from a later catalog
  assert.equal(flagSaysCurrent({ version: 1, conflicts: [], stored: 10 }, 9, info), false); // one deleted
  assert.equal(flagSaysCurrent({ version: 1, conflicts: [], stored: 10 }, 11, info), false); // one added since
  assert.equal(flagSaysCurrent({ version: 1, conflicts: [], stored: 9 }, 9, info), false); // not covered
  assert.equal(flagSaysCurrent({ version: 2, conflicts: [], stored: 10 }, 10, info), false);
  for (const flag of [null, undefined, 1, "1", { version: 1, stored: 10 }, { version: 1, conflicts: [], stored: "10" }]) {
    assert.equal(flagSaysCurrent(flag, 10, info), false, JSON.stringify(flag));
  }
});

test("builtin: the integrity check finds a missing record and an id held by the wrong record", () => {
  const catalogRecord = (id) => ({ id, isCustom: false, origin: "upstream" });
  const records = [catalogRecord("a"), catalogRecord("b"), catalogRecord("c")];
  const custom = { id: "c", isCustom: true, origin: "custom" };
  assert.deepEqual(checkCatalogIntegrity([catalogRecord("a"), catalogRecord("b"), custom], records, [{ id: "c" }]), []);
  assert.equal(checkCatalogIntegrity([catalogRecord("a"), custom], records, [{ id: "c" }]).length, 1); // b missing
  assert.equal(checkCatalogIntegrity([catalogRecord("a"), catalogRecord("b"), custom], records, []).length, 1); // c not a conflict
  assert.equal(checkCatalogIntegrity(records, records, [{ id: "c" }]).length, 1); // conflict now a catalog record
});

// ---- src/app/catalog.js ----

const INFO = { version: CATALOG_VERSION, count: CATALOG_COUNT };

function fakeStore({ current = false, sync = async () => ({ added: 1 }) } = {}) {
  const calls = { sync: 0, args: null };
  return {
    calls,
    catalogIsCurrent: async () => current,
    syncCatalog: async (...args) => {
      calls.sync += 1;
      calls.args = args;
      return sync(...args);
    },
  };
}

test("catalog service: a current library is not loaded and not synced", async () => {
  let loads = 0;
  const store = fakeStore({ current: true });
  const service = createCatalogService({ catalogStore: store, load: async () => { loads += 1; return {}; } });
  assert.equal(service.getStatus(), "idle");
  assert.deepEqual(await service.ensureCurrent(), { status: "ready", synced: false });
  assert.deepEqual([loads, store.calls.sync, service.getStatus()], [0, 0, "ready"]);
});

test("catalog service: loads the real module, checks it and syncs it with the info from catalog-info.js", async () => {
  const store = fakeStore();
  const service = createCatalogService({ catalogStore: store });
  const outcome = await service.ensureCurrent();
  assert.equal(outcome.status, "ready");
  assert.equal(store.calls.args[0], CATALOG);
  assert.deepEqual(store.calls.args[1], INFO);
});

test("catalog service: a module with another version or count, or one that fails to load, writes nothing and reports failed", async () => {
  const cases = [
    async () => ({ CATALOG_VERSION: CATALOG_VERSION + 1, CATALOG }),
    async () => ({ CATALOG_VERSION, CATALOG: CATALOG.slice(1) }),
    async () => ({ CATALOG_VERSION }),
    async () => { throw new Error("offline"); },
  ];
  for (const load of cases) {
    const store = fakeStore();
    const service = createCatalogService({ catalogStore: store, load });
    const outcome = await service.ensureCurrent();
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.error instanceof Error);
    assert.equal(store.calls.sync, 0);
    assert.equal(service.getStatus(), "failed");
  }
});

test("catalog service: a failed sync reports failed; a later call tries again", async () => {
  let fail = true;
  const store = fakeStore({ sync: async () => { if (fail) throw new Error("aborted"); return { added: 830 }; } });
  const service = createCatalogService({ catalogStore: store });
  assert.equal((await service.ensureCurrent()).status, "failed");
  fail = false;
  assert.equal((await service.ensureCurrent()).status, "ready");
  assert.equal(store.calls.sync, 2);
});

test("catalog service: says syncing while it loads, and calls made meanwhile share the one run", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = fakeStore();
  const service = createCatalogService({ catalogStore: store, load: async () => { await gate; return { CATALOG_VERSION, CATALOG }; } });
  const first = service.ensureCurrent();
  const second = service.ensureCurrent();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.getStatus(), "syncing");
  release();
  await first;
  assert.deepEqual([service.getStatus(), store.calls.sync], ["ready", 1]);
});
