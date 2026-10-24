// Storing the built-in exercise catalog. Written against the adapter interface in store.js and following
// its transaction rules: inside a transaction only tx.* calls are awaited, one at a time.
// Not part of createStore yet, so the app's store.js is unchanged until the catalog is wired in.
//
// syncCatalog is ONE readwrite transaction: the catalog records and the flag in meta commit together or not
// at all. A failed, aborted or killed sync leaves the database as it was, and catalogIsCurrent stays false,
// so the next launch simply runs it again. A sync only inserts, so running it again is always safe.

import { CATALOG_VERSION_META_KEY } from "./schema.js";
import {
  prepareCatalog,
  planCatalogInsert,
  checkCatalogIntegrity,
  countCatalogRecords,
  catalogFlag,
  flagSaysCurrent,
  requireCatalogInfo,
} from "../domain/builtin.js";

// A stored flag, or null if there is none or it is not one this code wrote.
const readFlag = (stored) => (stored !== undefined && stored.value !== null && typeof stored.value === "object" ? stored.value : null);

export function createCatalogStore(adapter) {
  // info: { version, count }, the catalog's version and number of entries. Reads the flag and counts the catalog records;
  // the catalog itself is not needed.
  async function catalogIsCurrent(info) {
    requireCatalogInfo(info);
    const { flag, exercises } = await adapter.transaction(["meta", "exercises"], "readonly", async (tx) => ({
      flag: readFlag(await tx.get("meta", CATALOG_VERSION_META_KEY)),
      exercises: await tx.getAll("exercises"),
    }));
    return flagSaysCurrent(flag, countCatalogRecords(exercises), info);
  }

  // Inserts every catalog entry whose id is free and writes the flag last. Never overwrites a stored record.
  // The catalog is validated before the transaction opens (prepareCatalog); a bad catalog writes nothing.
  // A flag from a newer catalog: nothing is written (skipped "newer"). A flag from an older one: refused,
  // because changing stored catalog records is the refresh path, which is not built.
  // Resolves { added, present, conflicts, nameClashes, stored, skipped }.
  async function syncCatalog(entries, info) {
    const { version } = requireCatalogInfo(info);
    const records = prepareCatalog(entries, info);
    return adapter.transaction(["meta", "exercises"], "readwrite", async (tx) => {
      const flag = readFlag(await tx.get("meta", CATALOG_VERSION_META_KEY));
      const storedVersion = flag !== null && Number.isInteger(flag.version) ? flag.version : null;
      if (storedVersion !== null && storedVersion > version) {
        return { added: 0, present: 0, conflicts: [], nameClashes: [], stored: null, skipped: "newer" };
      }
      if (storedVersion !== null && storedVersion < version) {
        throw new Error(`The stored exercise library is version ${storedVersion}; updating it to ${version} is not supported yet.`);
      }
      const plan = planCatalogInsert(await tx.getAll("exercises"), records);
      for (const record of plan.toInsert) await tx.put("exercises", record);
      const after = await tx.getAll("exercises");
      const problems = checkCatalogIntegrity(after, records, plan.conflicts);
      if (problems.length > 0) throw new Error(`The exercise library check failed: ${problems.slice(0, 5).join("; ")}`);
      const stored = countCatalogRecords(after);
      await tx.put("meta", { key: CATALOG_VERSION_META_KEY, value: catalogFlag(version, plan.conflicts, stored) });
      return {
        added: plan.toInsert.length,
        present: plan.present.length,
        conflicts: plan.conflicts,
        nameClashes: plan.nameClashes,
        stored,
        skipped: false,
      };
    });
  }

  return { catalogIsCurrent, syncCatalog };
}
