// In-memory adapter for Node tests. Implements the interface described in
// store.js. Each transaction works on a staged copy of the stores it names:
// the copy replaces the real data only if the callback succeeds, so a throw
// is a true rollback. Records are copied with structuredClone on the way in
// and out, so no reference to stored data is ever shared with the caller.

import { STORES, INDEXES } from "./schema.js";

export function createMemoryAdapter() {
  const committed = new Map(Object.keys(STORES).map((name) => [name, new Map()]));
  let isOpen = false;
  // Transactions run one at a time, like overlapping readwrite transactions in IndexedDB.
  let queue = Promise.resolve();

  function open() {
    isOpen = true;
    return Promise.resolve();
  }

  function close() {
    isOpen = false;
  }

  function transaction(storeNames, mode, fn) {
    if (!isOpen) return Promise.reject(new Error("memory adapter is not open"));
    if (mode !== "readonly" && mode !== "readwrite") {
      return Promise.reject(new Error(`unknown transaction mode: ${mode}`));
    }
    for (const name of storeNames) {
      if (!STORES[name]) return Promise.reject(new Error(`unknown store: ${name}`));
    }

    const run = async () => {
      const staged = new Map(storeNames.map((name) => [name, new Map(committed.get(name))]));
      let active = true;

      const table = (name) => {
        if (!active) throw new Error("transaction is finished");
        const records = staged.get(name);
        if (!records) throw new Error(`store "${name}" is not part of this transaction`);
        return records;
      };
      const writable = (name) => {
        if (mode !== "readwrite") throw new Error("transaction is read-only");
        return table(name);
      };

      const tx = {
        get: async (name, key) => {
          const record = table(name).get(key);
          return record === undefined ? undefined : structuredClone(record);
        },
        put: async (name, record) => {
          const records = writable(name);
          const copy = structuredClone(record);
          const key = copy[STORES[name].keyPath];
          if (typeof key !== "string" && typeof key !== "number") {
            throw new Error(`record for "${name}" has no valid ${STORES[name].keyPath}`);
          }
          records.set(key, copy);
        },
        delete: async (name, key) => {
          writable(name).delete(key);
        },
        getAll: async (name) => [...table(name).values()].map((record) => structuredClone(record)),
        getAllByIndex: async (name, index, value) => {
          const records = table(name);
          if (!(INDEXES[name] ?? []).includes(index)) throw new Error(`store "${name}" has no index "${index}"`);
          return [...records.values()].filter((record) => record[index] === value).map((record) => structuredClone(record));
        },
      };

      try {
        const result = await fn(tx);
        if (mode === "readwrite") {
          for (const [name, records] of staged) committed.set(name, records);
        }
        return result;
      } finally {
        active = false;
      }
    };

    const result = queue.then(run);
    queue = result.then(() => {}, () => {});
    return result;
  }

  return { open, close, transaction };
}
