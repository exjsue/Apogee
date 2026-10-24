// The exercise library wired into the app (commit 6): the shared wiring rules against the memory adapter, and
// the parts of src/app/catalog.js and src/ui/main.js that decide WHEN the library runs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogWiringRules } from "./catalog-wiring-rules.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { createCatalogService, startAfterFirstPaint, resyncAfterImport } from "../src/app/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const { name, run } of catalogWiringRules) {
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

// A catalog store that is never current and whose sync waits for release().
function gatedStore() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = { check: 0, sync: 0 };
  return {
    calls,
    release: () => release(),
    catalogIsCurrent: async () => { calls.check += 1; return calls.sync > 0; },
    syncCatalog: async () => { calls.sync += 1; await gate; return { added: 0 }; },
  };
}
const load = async () => ({ CATALOG_VERSION: 1, CATALOG: [] });
const INFO = { version: 1, count: 0 };

test("startAfterFirstPaint: the task runs only from a timer set inside the frame callback, never before", () => {
  const order = [];
  let frameCallback = null;
  let timerCallback = null;
  startAfterFirstPaint(() => order.push("task"), {
    frame: (fn) => { order.push("frame requested"); frameCallback = fn; },
    later: (fn, ms) => { order.push(`timer ${ms}`); timerCallback = fn; },
  });
  assert.deepEqual(order, ["frame requested"]);
  frameCallback(); // the browser is about to paint
  assert.deepEqual(order, ["frame requested", "timer 0"]);
  timerCallback(); // after that paint
  assert.deepEqual(order, ["frame requested", "timer 0", "task"]);
});

test("main.js: the library starts after the first render (await mountApp) and is never awaited", () => {
  // A check of the source's structure, not of timing: the timing is checked in the browser page.
  const source = fs.readFileSync(path.join(ROOT, "src", "ui", "main.js"), "utf8");
  const mounted = source.indexOf("await mountApp(");
  const started = source.indexOf("startAfterFirstPaint(() => catalog.ensureCurrent());");
  assert.ok(mounted > 0 && started > mounted, "startAfterFirstPaint must come after await mountApp(");
  assert.ok(source.indexOf("catalog.onChange(() => app.renderInBackground());") > mounted);
  assert.doesNotMatch(source, /await\s+catalog\./);
  assert.doesNotMatch(source, /\.ensureCurrent\(\)\s*\.then/);
  assert.equal(source.match(/ensureCurrent\(/g).length, 1);
});

test("catalog service: onChange hears every change once, and a listener that throws changes nothing", async () => {
  const store = gatedStore();
  const service = createCatalogService({ catalogStore: store, load, info: INFO });
  const heard = [];
  service.onChange(() => { throw new Error("redraw failed"); });
  service.onChange((status) => heard.push(status));
  const running = service.ensureCurrent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(heard, ["syncing"]);
  store.release();
  assert.equal((await running).status, "ready");
  assert.deepEqual(heard, ["syncing", "ready"]);
  await service.ensureCurrent(); // ready again: no change, nothing heard
  assert.deepEqual(heard, ["syncing", "ready"]);
});

test("catalog service: recheck while a check is running waits for it and then checks again (ensureCurrent alone would share the stale run)", async () => {
  const store = gatedStore();
  const service = createCatalogService({ catalogStore: store, load, info: INFO });
  const first = service.ensureCurrent();
  assert.equal(service.ensureCurrent(), first);
  const again = service.recheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.calls.check, 1);
  store.release();
  await first;
  await again;
  assert.equal(store.calls.check, 2);
  // With nothing running, recheck is one check.
  await service.recheck();
  assert.equal(store.calls.check, 3);
});

test("resyncAfterImport: passes the import's result and its errors through, and re-checks only after a completed import", async () => {
  let rechecks = 0;
  const catalog = { recheck: () => { rechecks += 1; return Promise.resolve(); } };
  const ok = resyncAfterImport({ importFromText: async (text, options) => ({ text, options }), exportToText: () => "x" }, catalog);
  assert.deepEqual(await ok.importFromText("file", { confirmReplace: true }), { text: "file", options: { confirmReplace: true } });
  assert.equal(ok.exportToText(), "x"); // every other method is the original
  assert.equal(rechecks, 1);
  const refused = resyncAfterImport({ importFromText: async () => { throw new Error("not a backup"); } }, catalog);
  await assert.rejects(refused.importFromText("junk"), /not a backup/);
  assert.equal(rechecks, 1);
});
