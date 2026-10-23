import test from "node:test";
import assert from "node:assert/strict";
import { checkPersistence, describePersistence } from "../src/app/persistence.js";
import { requestPersistentStorage } from "../src/storage/idb-adapter.js";

const NOW = new Date("2026-10-23T08:00:00.000Z");

// A fake store that keeps the last status it was given.
function fakeStore() {
  const calls = [];
  return {
    calls,
    stored: null,
    setPersistStatus: async (status) => {
      calls.push(status);
      return status;
    },
  };
}

test("launch check: stores the browser's answer and the time it was checked", async () => {
  const store = fakeStore();
  const status = await checkPersistence({
    request: async () => ({ supported: true, persisted: true, error: null }),
    store,
    now: () => NOW,
  });
  assert.deepEqual(status, { supported: true, persisted: true, error: null, checkedAt: "2026-10-23T08:00:00.000Z" });
  assert.deepEqual(store.calls, [status]);
});

test("launch check: a browser without persist() is recorded as unsupported, not as protected", async () => {
  const store = fakeStore();
  const status = await checkPersistence({
    request: () => requestPersistentStorage(undefined),
    store,
    now: () => NOW,
  });
  assert.equal(status.supported, false);
  assert.equal(status.persisted, false);
  assert.equal(describePersistence(status).label, "Not guaranteed, back up regularly");
});

test("launch check: an error from persist() is recorded with its message", async () => {
  const store = fakeStore();
  const status = await checkPersistence({
    request: () => requestPersistentStorage({ persist: async () => { throw new Error("denied"); } }),
    store,
    now: () => NOW,
  });
  assert.equal(status.persisted, false);
  assert.equal(status.error, "denied");
  assert.match(describePersistence(status).detail, /denied/);
});

test("launch check: every call is a fresh request; a later answer replaces the earlier one", async () => {
  const store = fakeStore();
  let answer = false;
  const request = async () => ({ supported: true, persisted: answer, error: null });
  await checkPersistence({ request, store, now: () => NOW });
  answer = true;
  const second = await checkPersistence({ request, store, now: () => NOW });
  assert.equal(store.calls.length, 2);
  assert.equal(second.persisted, true);
});

test("describe: no stored check yet says so, and claims nothing", () => {
  assert.deepEqual(describePersistence(null), { label: "Checking storage…", detail: "" });
});

test("describe: protected only when the browser agreed", () => {
  const described = describePersistence({ supported: true, persisted: true, error: null, checkedAt: "x" });
  assert.equal(described.label, "Storage protected");
});

test("describe: refusal and an unsupported browser both say the data is not guaranteed", () => {
  const refused = describePersistence({ supported: true, persisted: false, error: null, checkedAt: "x" });
  assert.equal(refused.label, "Not guaranteed, back up regularly");
  assert.match(refused.detail, /did not promise/);
  const unsupported = describePersistence({ supported: false, persisted: false, error: null, checkedAt: "x" });
  assert.equal(unsupported.label, "Not guaranteed, back up regularly");
});
