// IndexedDB adapter. Browsers only. Implements the interface described in
// store.js, and makes no network requests.
//
// transaction() calls the callback synchronously, inside the same task that
// created the IndexedDB transaction, and every handle method issues its
// request synchronously when called. The callback only awaits those requests
// (see the note in store.js), so the transaction always has a pending request
// and never auto-commits early. If the callback throws, the transaction is
// aborted and everything it wrote is rolled back.

import { SCHEMA_VERSION } from "../domain/model.js";
import { STORES, INDEXES } from "./schema.js";

function createSchema(database) {
  // Version 1 has no migrations. Later versions add upgrade steps here.
  for (const [name, { keyPath }] of Object.entries(STORES)) {
    if (database.objectStoreNames.contains(name)) continue;
    const objectStore = database.createObjectStore(name, { keyPath });
    for (const index of INDEXES[name] ?? []) objectStore.createIndex(index, index);
  }
}

const request = (idbRequest) => new Promise((resolve, reject) => {
  idbRequest.onsuccess = () => resolve(idbRequest.result);
  idbRequest.onerror = () => reject(idbRequest.error);
});

// Runs `start` now; a synchronous throw (such as a store outside the
// transaction) becomes a rejection instead.
function call(start) {
  try {
    return request(start());
  } catch (error) {
    return Promise.reject(error);
  }
}

function makeHandle(tx) {
  return {
    get: (store, key) => call(() => tx.objectStore(store).get(key)),
    put: (store, record) => call(() => tx.objectStore(store).put(record)).then(() => undefined),
    delete: (store, key) => call(() => tx.objectStore(store).delete(key)).then(() => undefined),
    clear: (store) => call(() => tx.objectStore(store).clear()).then(() => undefined),
    getAll: (store) => call(() => tx.objectStore(store).getAll()),
    getAllByIndex: (store, index, value) => call(() => tx.objectStore(store).index(index).getAll(value)),
  };
}

// The database name is required and has no default. A default would let a test
// that forgot to name its database open, and possibly delete, the app's real one.
// The app passes the name defined in schema.js; tests pass a name of their own.
export function createIdbAdapter({ name, version = SCHEMA_VERSION, indexedDB = globalThis.indexedDB } = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("createIdbAdapter needs an explicit database name (the app passes its real one from schema.js; tests must pass a separate name)");
  }
  let db = null;
  let opening = null;

  function open() {
    if (db) return Promise.resolve();
    if (opening) return opening;
    if (!indexedDB) return Promise.reject(new Error("IndexedDB is not available in this browser"));
    opening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      let idbRequest;
      try {
        idbRequest = indexedDB.open(name, version);
      } catch (error) {
        fail(error);
        return;
      }
      idbRequest.onupgradeneeded = () => createSchema(idbRequest.result);
      idbRequest.onblocked = () => fail(new Error(
        `Opening database "${name}" is blocked by another open connection to it. Close other GymApp tabs.`,
      ));
      idbRequest.onerror = () => {
        const error = idbRequest.error;
        fail(error && error.name === "VersionError"
          ? new Error(
            `Database "${name}" was saved by a newer version of GymApp than this code (schema ${version}). `
            + "The data was not changed. Update the app.",
          )
          : error);
      };
      idbRequest.onsuccess = () => {
        const opened = idbRequest.result;
        if (settled) {
          opened.close(); // we already reported failure; do not leak the connection
          return;
        }
        // Let another tab upgrade or delete the database instead of blocking it.
        opened.onversionchange = () => {
          opened.close();
          if (db === opened) db = null;
        };
        db = opened;
        settled = true;
        resolve();
      };
    }).finally(() => {
      opening = null;
    });
    return opening;
  }

  function close() {
    if (db) {
      db.close();
      db = null;
    }
  }

  function transaction(storeNames, mode, fn) {
    if (!db) return Promise.reject(new Error("database is not open"));
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let result;
      let failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("transaction aborted"));

      let outcome;
      try {
        outcome = Promise.resolve(fn(makeHandle(tx)));
      } catch (error) {
        outcome = Promise.reject(error);
      }
      outcome.then(
        (value) => {
          result = value; // the transaction commits by itself; oncomplete resolves
        },
        (error) => {
          failure = error;
          try {
            tx.abort();
          } catch {
            // already finished or aborted
          }
        },
      );
    });
  }

  return { open, close, transaction };
}

// Deletes a whole database. Rejects instead of hanging if a connection of
// ours is still open and blocks the delete.
export function deleteDatabase(name, indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const idbRequest = indexedDB.deleteDatabase(name);
    idbRequest.onsuccess = () => resolve();
    idbRequest.onerror = () => reject(idbRequest.error);
    idbRequest.onblocked = () => reject(new Error(
      `Deleting database "${name}" is blocked by a connection that is still open`,
    ));
  });
}

// Asks the browser to keep this site's data. Kept separate on purpose and
// never assumed to succeed: it reports what happened and the caller decides.
// Resolves { supported, persisted, error }.
export async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  if (!storage || typeof storage.persist !== "function") {
    return { supported: false, persisted: false, error: null };
  }
  try {
    const persisted = await storage.persist();
    return { supported: true, persisted: persisted === true, error: null };
  } catch (error) {
    return { supported: true, persisted: false, error: error.message };
  }
}
