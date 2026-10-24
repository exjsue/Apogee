// The built-in exercise catalog as stored records: which stored exercises belong to the catalog, how a
// catalog entry becomes a stored record, and what a sync inserts. Pure functions, no storage and no DOM;
// src/storage/catalog-store.js runs them around and inside its one transaction.
//
// A sync only inserts. A stored record is never overwritten, whoever owns it: seeds, the user's own
// exercises and catalog records that are already there all stay exactly as they are.

import { createExercise } from "./model.js";

const CATALOG_ORIGINS = Object.freeze(["upstream", "authored"]);
const SEED_ID_PREFIX = "seed-";

// A record the catalog owns. Decided by isCustom and origin only, NEVER by catalogVersion: a seed has
// catalogVersion null, and in JavaScript null < 1 is true, so any version comparison would pick up seeds.
export const isCatalogRecord = (record) => record.isCustom === false && CATALOG_ORIGINS.includes(record.origin);

// How many stored records belong to the catalog, including retired ones and any from a later catalog.
export const countCatalogRecords = (exercises) => exercises.filter(isCatalogRecord).length;

// The key two names are compared by. The same comparison as the custom-name check in src/app/logger.js
// (addCustomExercise): both names have been through createExercise, which collapses whitespace and trims
// (normalizeText in model.js), and are then compared ignoring case.
export const nameKey = (name) => name.toLowerCase();

// A catalog entry (src/catalog/catalog.js) as a stored built-in record, before validation.
export function catalogEntryToRecord(entry) {
  return {
    id: entry.id,
    name: entry.name,
    primaryMuscles: entry.primaryMuscles,
    secondaryMuscles: entry.secondaryMuscles,
    equipmentTags: entry.equipmentTags,
    notes: "",
    isCustom: false,
    defaultRestSeconds: null,
    baseMovementId: entry.baseMovementId,
    equipment: entry.equipment,
    variations: entry.variations,
    origin: entry.origin,
    upstreamId: entry.origin === "upstream" ? entry.id : null,
    catalogVersion: entry.catalogVersion,
    retired: entry.retired,
  };
}

export function requireCatalogInfo({ version, count } = {}) {
  if (!Number.isInteger(version) || version < 1) throw new Error("catalog version must be an integer >= 1");
  if (!Number.isInteger(count) || count < 0) throw new Error("catalog count must be an integer >= 0");
  return { version, count };
}

// Validates the whole catalog before any transaction opens. Throws, naming the entry, if the catalog does
// not have exactly `count` entries, if an entry is refused by createExercise, is not a catalog record, has
// another catalogVersion, repeats an id, or uses a seed id. Returns the records to store.
export function prepareCatalog(entries, info) {
  const { version, count } = requireCatalogInfo(info);
  if (!Array.isArray(entries)) throw new Error("catalog must be an array");
  if (entries.length !== count) throw new Error(`catalog has ${entries.length} entries, expected ${count}`);
  const ids = new Set();
  return entries.map((entry, i) => {
    let record;
    try {
      record = createExercise(catalogEntryToRecord(entry ?? {}));
    } catch (error) {
      throw new Error(`catalog[${i}]: ${error.message}`);
    }
    if (record.id.startsWith(SEED_ID_PREFIX)) throw new Error(`catalog[${i}]: "${record.id}" is a seed id`);
    if (!isCatalogRecord(record)) throw new Error(`catalog[${i}]: origin must be ${CATALOG_ORIGINS.join(" or ")}`);
    if (record.catalogVersion !== version) throw new Error(`catalog[${i}]: catalogVersion must be ${version}`);
    if (ids.has(record.id)) throw new Error(`catalog[${i}]: duplicate id "${record.id}"`);
    ids.add(record.id);
    return record;
  });
}

// What a sync does with each catalog record, given everything stored now:
//   toInsert     records whose id is free
//   present      ids already held by a catalog record (left as they are, even if their fields differ)
//   conflicts    { id, reason } for ids held by a record that is not a catalog record: "custom" for the
//                user's own exercise, "other" for anything else. That record is left as it is and the
//                catalog entry is not stored.
//   nameClashes  { id, existingId } for an inserted record whose name equals (nameKey) the name of a stored
//                record that is not a catalog record. Both are kept (see DECISIONS.md).
export function planCatalogInsert(existing, records) {
  const byId = new Map(existing.map((record) => [record.id, record]));
  const otherNames = new Map();
  for (const record of existing) {
    if (!isCatalogRecord(record) && !otherNames.has(nameKey(record.name))) otherNames.set(nameKey(record.name), record.id);
  }
  const plan = { toInsert: [], present: [], conflicts: [], nameClashes: [] };
  for (const record of records) {
    const stored = byId.get(record.id);
    if (stored === undefined) {
      plan.toInsert.push(record);
      const existingId = otherNames.get(nameKey(record.name));
      if (existingId !== undefined) plan.nameClashes.push({ id: record.id, existingId });
    } else if (isCatalogRecord(stored)) {
      plan.present.push(record.id);
    } else {
      plan.conflicts.push({ id: record.id, reason: stored.isCustom === true ? "custom" : "other" });
    }
  }
  return plan;
}

// Read back after the inserts, in the same transaction: every catalog id must now be held by a catalog
// record, except the conflicts, which must still be held by the record that is not one. Returns the problems.
export function checkCatalogIntegrity(storedAfter, records, conflicts) {
  const byId = new Map(storedAfter.map((record) => [record.id, record]));
  const conflictIds = new Set(conflicts.map((conflict) => conflict.id));
  const problems = [];
  for (const { id } of records) {
    const stored = byId.get(id);
    if (stored === undefined) problems.push(`"${id}" is missing`);
    else if (conflictIds.has(id) === isCatalogRecord(stored)) problems.push(`"${id}" is held by the wrong record`);
  }
  return problems;
}

// The value a sync writes to meta, last: the catalog version, the ids it could not store, and how many
// catalog records it saw stored.
export const catalogFlag = (version, conflicts, stored) => ({ version, conflicts: conflicts.map((conflict) => conflict.id), stored });

// Is the stored catalog the one described by `info`, without loading the catalog? Only if the flag is for
// this version, the number of catalog records stored now is the number the sync saw (a deleted one, or one
// added since, sends it back to sync), and those plus the conflicts cover the catalog.
export function flagSaysCurrent(flag, catalogRecordCount, info) {
  const { version, count } = requireCatalogInfo(info);
  if (flag === null || typeof flag !== "object") return false;
  if (flag.version !== version || !Array.isArray(flag.conflicts) || !Number.isInteger(flag.stored)) return false;
  return catalogRecordCount === flag.stored && flag.stored + flag.conflicts.length >= count;
}
