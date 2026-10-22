import test from "node:test";
import assert from "node:assert/strict";
import { backupRules } from "./backup-rules.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { downloadBlob, readFileAsText } from "../src/backup/download.js";
import { MAX_IMPORT_BYTES } from "../src/backup/backup.js";

// The shared rules, against the memory adapter.
for (const { name, run } of backupRules) {
  test(`backup rules: ${name}`, async () => {
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

test("memory adapter: clear empties a store, and is rolled back with its transaction", async () => {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await adapter.transaction(["exercises"], "readwrite", async (tx) => {
    await tx.put("exercises", { id: "a" });
    await tx.put("exercises", { id: "b" });
  });
  await assert.rejects(
    adapter.transaction(["exercises"], "readwrite", async (tx) => {
      await tx.clear("exercises");
      throw new Error("boom");
    }),
    /boom/,
  );
  const kept = await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"));
  assert.equal(kept.length, 2);
  await adapter.transaction(["exercises"], "readwrite", (tx) => tx.clear("exercises"));
  const left = await adapter.transaction(["exercises"], "readonly", (tx) => tx.getAll("exercises"));
  assert.deepEqual(left, []);
});

test("memory adapter: clear is rejected in a read-only transaction", async () => {
  const adapter = createMemoryAdapter();
  await adapter.open();
  await assert.rejects(adapter.transaction(["exercises"], "readonly", (tx) => tx.clear("exercises")), /read-only/);
});

test("downloadBlob: makes an object URL and a temporary link, clicks it, and releases the URL", async () => {
  const calls = [];
  const link = { click: () => calls.push("click"), remove: () => calls.push("remove") };
  const document = {
    createElement: (tag) => {
      calls.push(`create ${tag}`);
      return link;
    },
    body: { append: (element) => calls.push(element === link ? "append link" : "append other") },
  };
  const URL = {
    createObjectURL: () => {
      calls.push("createObjectURL");
      return "blob:fake";
    },
    revokeObjectURL: (url) => calls.push(`revoke ${url}`),
  };
  downloadBlob(new Blob(["x"]), "backup.json", { document, URL, revokeAfterMs: 0 });
  assert.equal(link.href, "blob:fake");
  assert.equal(link.download, "backup.json");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["createObjectURL", "create a", "append link", "click", "remove", "revoke blob:fake"]);
});

test("readFileAsText: refuses a file over the limit in bytes without reading it", async () => {
  let read = false;
  const file = { size: 11, text: async () => { read = true; return "x"; } };
  await assert.rejects(readFileAsText(file, 10), /too large/);
  assert.equal(read, false);
  await assert.rejects(readFileAsText({ size: MAX_IMPORT_BYTES + 1, text: async () => "x" }), /too large/);
});

test("readFileAsText: reads a file at or under the limit", async () => {
  assert.equal(await readFileAsText({ size: 10, text: async () => "contents" }, 10), "contents");
  assert.equal(await readFileAsText({ size: MAX_IMPORT_BYTES, text: async () => "ok" }), "ok");
});
