// Export and import of the user's own data. Pure logic: no DOM, no network.
// Works through the storage adapter interface described in src/storage/store.js.
// The store must already be open (store.open() has checked the schema version).
//
// Import is replace-everything: it never merges. A file is validated in full
// before the database is touched, then applied in ONE transaction.

import {
  SCHEMA_VERSION,
  createExercise,
  createWorkout,
  createWorkoutEntry,
  createWorkSet,
} from "../domain/model.js";

export const APP_MARKER = "gymapp-export";
export const EXPORT_FORMAT = 1;

// Size limit for an import file. UNIT: bytes of UTF-8 text, which is exactly
// what a file's size is. importFromText measures the text in bytes and
// readFileAsText (download.js) compares file.size in bytes, so both use the
// same unit and the same constant. 50 MiB.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const DATA_STORES = ["exercises", "workouts", "entries", "sets"];

// Every field a record must have in a file. Nothing is defaulted on import:
// a record with a missing or extra field is rejected.
export const RECORD_FIELDS = {
  exercises: ["id", "name", "primaryMuscles", "secondaryMuscles", "equipmentTags", "notes", "isCustom"],
  workouts: ["id", "startedAt", "endedAt", "notes"],
  entries: ["id", "workoutId", "exerciseId", "order", "supersetGroup", "notes"],
  sets: [
    "id", "entryId", "order", "reps", "weightValue", "weightUnit", "isWarmup", "restSeconds", "completedAt",
  ],
};

const RECORD_TYPES = {
  exercises: { label: "exercise", create: createExercise },
  workouts: { label: "workout", create: createWorkout },
  entries: { label: "entry", create: createWorkoutEntry },
  sets: { label: "set", create: createWorkSet },
};

const DOCUMENT_FIELDS = ["app", "exportFormat", "schemaVersion", "exportedAt", "data"];

// What Date#toISOString produces; the only timestamp form an export contains.
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message) {
  throw new Error(message);
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  return Object.is(a, b);
}

function rejectUnknownFields(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${where}: unknown field "${key}"`);
  }
}

function checkSize(text, maxBytes) {
  if (typeof text !== "string") fail("The backup must be given as text");
  // A UTF-8 byte count is never smaller than the string's length, and never
  // more than three times it, so the exact count is only needed in between.
  let tooLarge = text.length > maxBytes;
  if (!tooLarge && text.length * 3 > maxBytes) {
    tooLarge = new TextEncoder().encode(text).length > maxBytes;
  }
  if (tooLarge) fail(`The file is too large to import (limit: ${maxBytes} bytes)`);
}

function describe(label, record, index) {
  return isPlainObject(record) && typeof record.id === "string" && record.id !== ""
    ? `${label} "${record.id}"`
    : `${label} at index ${index}`;
}

// Validates one section. Returns the records exactly as they will be stored.
function validateSection(section, items) {
  const { label, create } = RECORD_TYPES[section];
  const fields = RECORD_FIELDS[section];
  const seen = new Set();
  return items.map((item, index) => {
    const where = describe(label, item, index);
    if (!isPlainObject(item)) fail(`${where}: not an object`);
    rejectUnknownFields(item, fields, where);
    for (const field of fields) {
      if (!hasOwn(item, field)) fail(`${where}: required field "${field}" is missing`);
    }
    if (typeof item.id !== "string" || item.id === "") fail(`${where}: id must be a non-empty string`);
    if (seen.has(item.id)) fail(`${where}: duplicate id`);
    seen.add(item.id);

    let record;
    try {
      record = create(item);
    } catch (error) {
      fail(`${where}: ${error.message}`);
    }
    // The stored record must equal the file's record exactly. The domain
    // functions normalize (for example timestamps to UTC); anything they
    // would change is rejected rather than silently rewritten.
    for (const field of fields) {
      if (!sameValue(record[field], item[field])) fail(`${where}: ${field} is not in its canonical form`);
    }
    return record;
  });
}

// Validates a whole file without touching any database. Throws on the first problem.
function parseBackup(text, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  checkSize(text, maxBytes);

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // The engine's own message can quote part of the file, so it is not passed on.
    fail("The file is not valid JSON");
  }
  if (!isPlainObject(doc)) fail("This is not a GymApp export file");
  if (doc.app !== APP_MARKER) fail("This is not a GymApp export file");
  if (doc.exportFormat !== EXPORT_FORMAT) fail("This export file format is not supported (exportFormat)");
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
    fail("The file's schemaVersion is not valid");
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    fail(
      `This file was exported by a newer version of GymApp (schema ${doc.schemaVersion}); `
      + `this version understands schema ${SCHEMA_VERSION}. Update the app to import it.`,
    );
  }
  rejectUnknownFields(doc, DOCUMENT_FIELDS, "file");
  if (typeof doc.exportedAt !== "string" || !CANONICAL_TIMESTAMP.test(doc.exportedAt)
    || Number.isNaN(Date.parse(doc.exportedAt))) {
    fail("The file's exportedAt is not valid");
  }
  if (!isPlainObject(doc.data)) fail("The file's data section is missing");
  rejectUnknownFields(doc.data, DATA_STORES, "data");
  for (const section of DATA_STORES) {
    if (!hasOwn(doc.data, section) || !Array.isArray(doc.data[section])) {
      fail(`data.${section} must be a list`);
    }
  }

  const records = {};
  for (const section of DATA_STORES) records[section] = validateSection(section, doc.data[section]);

  const workoutIds = new Set(records.workouts.map((record) => record.id));
  const exerciseIds = new Set(records.exercises.map((record) => record.id));
  const entryIds = new Set(records.entries.map((record) => record.id));
  for (const entry of records.entries) {
    if (!workoutIds.has(entry.workoutId)) {
      fail(`entry "${entry.id}": workoutId refers to a workout that is not in the file`);
    }
    if (!exerciseIds.has(entry.exerciseId)) {
      fail(`entry "${entry.id}": exerciseId refers to an exercise that is not in the file`);
    }
  }
  for (const set of records.sets) {
    if (!entryIds.has(set.entryId)) {
      fail(`set "${set.id}": entryId refers to an entry that is not in the file`);
    }
  }

  const counts = {};
  for (const section of DATA_STORES) counts[section] = records[section].length;
  return { exportedAt: doc.exportedAt, schemaVersion: doc.schemaVersion, records, counts };
}

// Validates a file and reports what it contains, writing nothing. The import
// screen must call this and show the user what will be replaced before it
// asks for confirmation.
export function inspectBackup(text, options) {
  const { exportedAt, schemaVersion, counts } = parseBackup(text, options);
  return { exportedAt, schemaVersion, counts };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Same fields, keys in sorted order, so equal data always serializes equally.
const withSortedKeys = (record) => Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

function toIsoString(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) fail("now must be a valid date");
  return date.toISOString();
}

const pad = (n) => String(n).padStart(2, "0");

export function createBackup(adapter) {
  // Produces the export as one JSON string. Two exports of the same data are
  // identical apart from exportedAt: each type is sorted by id and every
  // record's keys are sorted. The text is also what a user can copy by hand
  // in browsers where file downloads misbehave (iOS).
  async function exportToText({ now = new Date() } = {}) {
    const exportedAt = toIsoString(now);
    const data = await adapter.transaction(DATA_STORES, "readonly", async (tx) => {
      const snapshot = {};
      for (const section of DATA_STORES) snapshot[section] = await tx.getAll(section);
      return snapshot;
    });
    const sorted = {};
    for (const section of DATA_STORES) sorted[section] = data[section].sort(byId).map(withSortedKeys);
    const text = JSON.stringify({
      app: APP_MARKER,
      exportFormat: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      data: sorted,
    });

    // lastExportAt means "when an export was generated". It does not mean a
    // backup was saved: the app cannot know whether the user kept the file,
    // or where. It is written after the snapshot, and a failure to write it
    // does not cost the user the export they asked for.
    try {
      await adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key: "lastExportAt", value: exportedAt }));
    } catch {
      // The export itself succeeded; only the bookkeeping failed.
    }
    return text;
  }

  // The same export wrapped for a download: the DOM helper in download.js
  // turns this into a file. `text` is kept for the copy-and-paste fallback.
  async function exportForDownload({ now = new Date() } = {}) {
    const exportedAt = toIsoString(now);
    const text = await exportToText({ now: exportedAt });
    const day = new Date(exportedAt);
    return {
      text,
      blob: new Blob([text], { type: "application/json" }),
      filename: `gymapp-export-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.json`,
    };
  }

  // When an export was last generated, as a UTC ISO string, or null if never.
  async function getLastExportAt() {
    const stored = await adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", "lastExportAt"));
    return stored === undefined ? null : stored.value;
  }

  // Replaces ALL existing data with the file's contents. Nothing is merged.
  // The schema version and lastExportAt in meta are left alone; neither is
  // read from the file. Resolves with the counts of imported records.
  async function importFromText(text, { confirmReplace, maxBytes } = {}) {
    if (confirmReplace !== true) {
      fail("Import replaces all existing data; confirmReplace: true is required");
    }
    const { records, counts } = parseBackup(text, { maxBytes });

    // One transaction: clear everything, then write the file's records. If
    // anything throws, the adapter rolls it all back. Only tx.* calls are
    // awaited inside (see the note in store.js); the puts are issued together
    // and awaited as a group.
    await adapter.transaction(DATA_STORES, "readwrite", async (tx) => {
      for (const section of DATA_STORES) await tx.clear(section);
      for (const section of DATA_STORES) {
        await Promise.all(records[section].map((record) => tx.put(section, record)));
      }
    });
    return counts;
  }

  return { exportToText, exportForDownload, getLastExportAt, importFromText };
}
