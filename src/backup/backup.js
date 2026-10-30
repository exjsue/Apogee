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
  createTemplate,
  exerciseV3Defaults,
} from "../domain/model.js";
import { withSeedGrouping } from "../domain/seed.js";
import { snoozeUntil } from "../domain/backup-reminder.js";
import { WORKOUT_META_KEYS, CATALOG_VERSION_META_KEY } from "../storage/schema.js";

// Keys in meta. Meta is not part of exports, so none of these travel in a backup.
const LAST_EXPORT_KEY = "lastExportAt";
const EXPORT_ATTEMPT_KEY = "lastExportAttemptAt";
const REMINDER_DISMISSED_KEY = "reminderDismissedUntil";
const EXPORT_CONFIRMATION_VERSION_KEY = "exportConfirmationVersion";
export const EXPORT_CONFIRMATION_VERSION = 1;

export const APP_MARKER = "apogee-export";
export const EXPORT_FORMAT = 1;

// Size limit for an import file. UNIT: bytes of UTF-8 text, which is exactly
// what a file's size is. importFromText measures the text in bytes and
// readFileAsText (download.js) compares file.size in bytes, so both use the
// same unit and the same constant. 50 MiB.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const DATA_STORES = ["exercises", "workouts", "entries", "sets", "templates"];
// The sections of a file saved before schema version 4, which had no templates.
const DATA_STORES_V3 = DATA_STORES.filter((section) => section !== "templates");

// Every field a record must have in a file. Nothing is defaulted on import:
// a record with a missing or extra field is rejected.
export const RECORD_FIELDS = {
  exercises: [
    "id", "name", "primaryMuscles", "secondaryMuscles", "equipmentTags", "notes", "isCustom", "defaultRestSeconds",
    "baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired",
  ],
  workouts: ["id", "startedAt", "endedAt", "notes"],
  entries: ["id", "workoutId", "exerciseId", "order", "supersetGroup", "notes"],
  sets: [
    "id", "entryId", "order", "reps", "weightValue", "weightUnit", "isWarmup", "restSeconds", "completedAt",
  ],
  // exercises is a list of { exerciseId, setCount }, each with exactly those two fields (see sameValue).
  templates: ["id", "name", "exercises"],
};

// Fields a record may have and may leave out (schema version 4 files only). An exercise saved before secondary
// weights existed, or never edited since, has no secondaryWeights; every secondary muscle then counts 0.5. When
// present it is checked like any other field.
export const OPTIONAL_RECORD_FIELDS = { exercises: ["secondaryWeights"] };

// The fields schema version 3 added to exercises.
const V3_EXERCISE_FIELDS = ["baseMovementId", "equipment", "variations", "origin", "upstreamId", "catalogVersion", "retired"];

// What a schema version 2 file contains: the same, but exercises had none of the schema 3 fields. A version 2
// file is accepted as it is (the fields get their defaults, and seeds their grouping); it must not contain them.
export const RECORD_FIELDS_V2 = {
  ...RECORD_FIELDS,
  exercises: RECORD_FIELDS.exercises.filter((field) => !V3_EXERCISE_FIELDS.includes(field)),
};

// What a schema version 1 file contains: as version 2, but exercises had no
// defaultRestSeconds. A version 1 file is accepted as it is (the field then
// becomes null); it must not contain the new field.
export const RECORD_FIELDS_V1 = {
  ...RECORD_FIELDS_V2,
  exercises: RECORD_FIELDS_V2.exercises.filter((field) => field !== "defaultRestSeconds"),
};

const RECORD_TYPES = {
  exercises: { label: "exercise", create: createExercise },
  workouts: { label: "workout", create: createWorkout },
  entries: { label: "entry", create: createWorkoutEntry },
  sets: { label: "set", create: createWorkSet },
  templates: { label: "template", create: createTemplate },
};

const DOCUMENT_FIELDS = ["app", "exportFormat", "schemaVersion", "exportedAt", "data"];

// What Date#toISOString produces; the only timestamp form an export contains.
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message) {
  throw new Error(message);
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Plain objects (the items of a template) are equal when they have exactly the same own keys with equal values,
// so an extra or a missing key in an item of the file is caught here.
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => hasOwn(b, key) && sameValue(a[key], b[key]));
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
function validateSection(section, items, fieldsOf, optionalOf) {
  const { label, create } = RECORD_TYPES[section];
  const fields = fieldsOf[section];
  const optional = optionalOf[section] ?? [];
  const seen = new Set();
  return items.map((item, index) => {
    const where = describe(label, item, index);
    if (!isPlainObject(item)) fail(`${where}: not an object`);
    rejectUnknownFields(item, [...fields, ...optional], where);
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
    for (const field of [...fields, ...optional.filter((name) => hasOwn(item, name))]) {
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
  if (!isPlainObject(doc)) fail("This is not an Apogee export file");
  if (doc.app !== APP_MARKER) fail("This is not an Apogee export file");
  if (doc.exportFormat !== EXPORT_FORMAT) fail("This export file format is not supported (exportFormat)");
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
    fail("The file's schemaVersion is not valid");
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    fail(
      `This file was exported by a newer version of Apogee (schema ${doc.schemaVersion}); `
      + `this version understands schema ${SCHEMA_VERSION}. Update the app to import it.`,
    );
  }
  rejectUnknownFields(doc, DOCUMENT_FIELDS, "file");
  if (typeof doc.exportedAt !== "string" || !CANONICAL_TIMESTAMP.test(doc.exportedAt)
    || Number.isNaN(Date.parse(doc.exportedAt))) {
    fail("The file's exportedAt is not valid");
  }
  if (!isPlainObject(doc.data)) fail("The file's data section is missing");
  // A file from before schema version 4 has no templates section, and must not have one; it imports with none.
  const sections = doc.schemaVersion >= 4 ? DATA_STORES : DATA_STORES_V3;
  rejectUnknownFields(doc.data, sections, "data");
  for (const section of sections) {
    if (!hasOwn(doc.data, section) || !Array.isArray(doc.data[section])) {
      fail(`data.${section} must be a list`);
    }
  }

  const records = { templates: [] };
  // The file is checked against the field list of the schema it says it is.
  const fieldsOf = doc.schemaVersion >= 3 ? RECORD_FIELDS : doc.schemaVersion === 2 ? RECORD_FIELDS_V2 : RECORD_FIELDS_V1;
  const optionalOf = doc.schemaVersion >= 4 ? OPTIONAL_RECORD_FIELDS : {};
  for (const section of sections) records[section] = validateSection(section, doc.data[section], fieldsOf, optionalOf);
  // An older file has none of the schema 3 fields: createExercise gave them their defaults, and its seeds get
  // their grouping here, by the same function the upgrade step uses.
  if (doc.schemaVersion < 3) records.exercises = records.exercises.map((record) => withSeedGrouping(record));

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
  for (const template of records.templates) {
    if (template.exercises.some(({ exerciseId }) => !exerciseIds.has(exerciseId))) {
      fail(`template "${template.id}": exerciseId refers to an exercise that is not in the file`);
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
  // Produces the export and its exportedAt time. Writes nothing: an export is
  // not a backup until the user confirms they saved it (confirmExport).
  async function exportSnapshot({ now = new Date() } = {}) {
    const exportedAt = toIsoString(now);
    const data = await adapter.transaction(DATA_STORES, "readonly", async (tx) => {
      const snapshot = {};
      for (const section of DATA_STORES) snapshot[section] = await tx.getAll(section);
      return snapshot;
    });
    const sorted = {};
    // An exercise saved before schema version 2 has no defaultRestSeconds, and one saved before version 3 none of
    // its fields (the upgrade adds them, so this is only a safety net); the file always has them.
    const complete = (section, record) => (section === "exercises" ? { defaultRestSeconds: null, ...exerciseV3Defaults(record), ...record } : record);
    for (const section of DATA_STORES) {
      sorted[section] = data[section].sort(byId).map((record) => withSortedKeys(complete(section, record)));
    }
    const text = JSON.stringify({
      app: APP_MARKER,
      exportFormat: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      data: sorted,
    });
    return { text, exportedAt };
  }

  async function exportToText(options) {
    return (await exportSnapshot(options)).text;
  }

  // The same export wrapped for a download: the DOM helper in download.js
  // turns this into a file. `text` is kept for the copy-and-paste fallback.
  async function exportForDownload({ now = new Date() } = {}) {
    const { text, exportedAt } = await exportSnapshot({ now });
    const day = new Date(exportedAt);
    return {
      text,
      exportedAt,
      blob: new Blob([text], { type: "application/json" }),
      filename: `apogee-export-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.json`,
    };
  }

  // Called when a download or a copy of an export starts. Records only the
  // attempt (lastExportAttemptAt). Not a backup.
  function recordExportAttempt(exportedAt) {
    return writeMeta(EXPORT_ATTEMPT_KEY, toIsoString(exportedAt));
  }

  // Called only when the user taps "I saved the file". Records the export's own
  // time as the last confirmed export (lastExportAt).
  function confirmExport(exportedAt) {
    return writeMeta(LAST_EXPORT_KEY, toIsoString(exportedAt));
  }

  // The last confirmed export and the last attempt, as UTC ISO strings or null.
  async function getExportTimes() {
    return {
      lastExportAt: await readMeta(LAST_EXPORT_KEY),
      lastExportAttemptAt: await readMeta(EXPORT_ATTEMPT_KEY),
    };
  }

  // The last CONFIRMED export, as a UTC ISO string, or null if never.
  function getLastExportAt() {
    return readMeta(LAST_EXPORT_KEY);
  }

  // One-time migration for data saved before exports needed a confirmation. Those
  // builds wrote lastExportAt when an export was generated, which is an attempt,
  // not a confirmed backup. If meta has no exportConfirmationVersion, the old
  // value moves to lastExportAttemptAt (only if that is empty or older), the old
  // key is deleted and the version is set. Once the version exists this does
  // nothing, so a lastExportAt written by the new flow is never touched. All in
  // one transaction. Resolves { migrated, movedAttemptAt }.
  async function migrateExportConfirmation() {
    return adapter.transaction(["meta"], "readwrite", async (tx) => {
      if ((await tx.get("meta", EXPORT_CONFIRMATION_VERSION_KEY)) !== undefined) {
        return { migrated: false, movedAttemptAt: null };
      }
      let movedAttemptAt = null;
      const legacy = await tx.get("meta", LAST_EXPORT_KEY);
      if (legacy !== undefined) {
        const attempt = await tx.get("meta", EXPORT_ATTEMPT_KEY);
        const attemptAt = attempt === undefined ? null : attempt.value;
        const legacyValid = typeof legacy.value === "string" && !Number.isNaN(Date.parse(legacy.value));
        const attemptValid = typeof attemptAt === "string" && !Number.isNaN(Date.parse(attemptAt));
        if (legacyValid && (!attemptValid || Date.parse(attemptAt) < Date.parse(legacy.value))) {
          await tx.put("meta", { key: EXPORT_ATTEMPT_KEY, value: legacy.value });
          movedAttemptAt = legacy.value;
        }
        await tx.delete("meta", LAST_EXPORT_KEY);
      }
      await tx.put("meta", { key: EXPORT_CONFIRMATION_VERSION_KEY, value: EXPORT_CONFIRMATION_VERSION });
      return { migrated: true, movedAttemptAt };
    });
  }

  // What the backup reminder needs, read in one transaction.
  async function getReminderInputs() {
    return adapter.transaction(["meta", "workouts"], "readonly", async (tx) => {
      const lastExport = await tx.get("meta", LAST_EXPORT_KEY);
      const dismissed = await tx.get("meta", REMINDER_DISMISSED_KEY);
      const workouts = await tx.getAll("workouts");
      return {
        lastExportAt: lastExport === undefined ? null : lastExport.value,
        dismissedUntil: dismissed === undefined ? null : dismissed.value,
        workoutCount: workouts.length,
      };
    });
  }

  // Hides the reminder for 7 days from `now`.
  function dismissReminder(now = new Date()) {
    return writeMeta(REMINDER_DISMISSED_KEY, snoozeUntil(now));
  }

  async function readMeta(key) {
    const stored = await adapter.transaction(["meta"], "readonly", (tx) => tx.get("meta", key));
    return stored === undefined ? null : stored.value;
  }

  function writeMeta(key, value) {
    return adapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", { key, value }));
  }

  // How many records of each type are stored now, so an import screen can
  // show what is about to be replaced.
  function currentCounts() {
    return adapter.transaction(DATA_STORES, "readonly", async (tx) => {
      const counts = {};
      for (const section of DATA_STORES) counts[section] = (await tx.getAll(section)).length;
      return counts;
    });
  }

  // Replaces ALL existing data with the file's contents, templates included. Nothing is merged: a file from
  // before schema version 4 (no templates section) leaves no templates.
  // The schema version and lastExportAt in meta are left alone; neither is
  // read from the file. The session's planned sets and running timer are removed.
  // Resolves with the counts of imported records.
  async function importFromText(text, { confirmReplace, maxBytes } = {}) {
    if (confirmReplace !== true) {
      fail("Import replaces all existing data; confirmReplace: true is required");
    }
    const { records, counts } = parseBackup(text, { maxBytes });

    // One transaction: clear everything, then write the file's records. If
    // anything throws, the adapter rolls it all back. Only tx.* calls are
    // awaited inside (see the note in store.js); the puts are issued together
    // and awaited as a group.
    await adapter.transaction([...DATA_STORES, "meta"], "readwrite", async (tx) => {
      for (const section of DATA_STORES) await tx.clear(section);
      for (const section of DATA_STORES) {
        await Promise.all(records[section].map((record) => tx.put(section, record)));
      }
      // The unchecked sets and the running timer refer to the data that was just
      // replaced (exercise ids, set ids), so they go in the same transaction.
      await tx.delete("meta", WORKOUT_META_KEYS.plan);
      await tx.delete("meta", WORKOUT_META_KEYS.timer);
      // Whatever catalog state there was belongs to the replaced data, so a later sync must run again.
      await tx.delete("meta", CATALOG_VERSION_META_KEY);
    });
    return counts;
  }

  return {
    exportSnapshot,
    exportToText,
    exportForDownload,
    recordExportAttempt,
    confirmExport,
    getExportTimes,
    getLastExportAt,
    getReminderInputs,
    migrateExportConfirmation,
    dismissReminder,
    currentCounts,
    importFromText,
  };
}
