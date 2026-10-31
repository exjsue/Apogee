// Strong CSV importer, pure part: parsing, row checks, grouping into workouts, and the plan (the records to add and the
// dry-run report). No DOM, no storage, no network. The write is in strong-apply.js; matching names to exercises is in
// strong-match.js. Nothing here reads a file: the caller passes the text.
//
// Decisions (John, 2026-10-31): the Date column is the workout START, read as device-local time and stored as UTC;
// endedAt = startedAt + Duration. The weight unit is chosen by the caller and never guessed. Every set gets
// completedAt = startedAt, and `order` 0..n-1 inside its entry in file-row order: nothing is ever ordered by
// timestamp. An exercise that comes back later in a workout joins its first entry. No supersets. Rows are never
// deduplicated (three identical failure sets in a row are three sets). Ids are deterministic so a second import of
// the same file adds nothing.

import {
  WEIGHT_UNITS, RPE_MIN, RPE_MAX, SET_TYPES, MAX_DURATION_SECONDS,
  createExercise, createWorkout, createWorkoutEntry, createWorkSet,
} from "../domain/model.js";
import { nameKey, requireFreeName } from "../domain/exercise-names.js";

export const STRONG_HEADER = Object.freeze([
  "Date", "Workout Name", "Duration", "Exercise Name", "Set Order", "Weight", "Reps", "Distance", "Seconds", "RPE",
]);

// Collapses whitespace runs and trims, the way the model stores a name.
export const normalizeName = (text) => text.replace(/\s+/g, " ").trim();

// Records of fields from RFC 4180 text: a leading BOM is dropped, LF or CRLF end a record, quoted fields may hold
// commas, line breaks and "" for a quote. `line` is the physical line a record starts on. Blank records at the end
// are dropped. { records } or { records, error } when a quote is never closed.
export function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const records = [];
  let fields = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => { fields.push(field); records.push({ line: start, fields }); fields = []; field = ""; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (c === "\n") line += 1;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      field += c;
    }
  }
  if (quoted) return { records, error: `line ${start}: a quoted field is never closed` };
  if (field !== "" || fields.length > 0) endRecord();
  while (records.length > 0 && records.at(-1).fields.length === 1 && records.at(-1).fields[0] === "") records.pop();
  return { records };
}

// "1h 31m", "57m" or "2h" (an "s" part is accepted too) -> seconds. Any other form -> null (an error, never 0).
export function parseDuration(text) {
  const match = /^(?:(\d+)h)?(?:\s*(\d+)m)?(?:\s*(\d+)s)?$/.exec(text.trim());
  if (match === null || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

const NUMBER = /^\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const HOUR_MS = 3600000;

// "2025-05-06 17:26:07" as the device's local time. { date, warning } or { error }. A time that does not exist
// (the hour a clock skips) is moved by the JS Date rules and warned about; an hour that happens twice is warned too.
function localTime(text) {
  const match = DATE.exec(text);
  if (match === null) return { error: "Date must look like 2025-05-06 17:26:07" };
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    return { error: "Date is not a real calendar date and time" };
  }
  const same = (date) => date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === h && date.getMinutes() === mi && date.getSeconds() === s;
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (!same(date)) return { date, warning: "this local time does not exist on this device (a clock change); it was moved" };
  if (same(new Date(date.getTime() - HOUR_MS)) || same(new Date(date.getTime() + HOUR_MS))) {
    return { date, warning: "this local time happens twice on this device (a clock change); the first was used" };
  }
  return { date };
}

// One data record -> { row } or { errors: [message] }. Everything wrong with the row is reported, not just the first.
function parseRow({ line, fields }) {
  if (fields.length !== STRONG_HEADER.length) {
    return { errors: [`the row has ${fields.length} columns, expected ${STRONG_HEADER.length}`] };
  }
  const [dateText, nameText, durationText, exerciseText, marker, weightText, repsText, distanceText, secondsText, rpeText] = fields.map((f) => f.trim());
  const errors = [];
  const time = localTime(dateText);
  if (time.error) errors.push(time.error);
  const durationSeconds = parseDuration(durationText);
  if (durationSeconds === null) errors.push(`Duration "${durationText}" is not Xh Ym, Ym or Xh`);
  const exercise = normalizeName(exerciseText);
  if (exercise === "") errors.push("Exercise Name is empty");
  if (!/^\d+$/.test(marker) && !["W", "F", "D"].includes(marker)) errors.push(`Set Order "${marker}" is not a number, W, F or D`);
  const number = (text, label) => {
    if (!NUMBER.test(text)) { errors.push(`${label} "${text}" is not a number`); return null; }
    return Number(text);
  };
  const weight = number(weightText, "Weight");
  const reps = number(repsText, "Reps");
  const distance = number(distanceText, "Distance");
  const seconds = number(secondsText, "Seconds");
  if (reps !== null && !Number.isInteger(reps)) errors.push("Reps is not a whole number");
  if (seconds !== null && !Number.isInteger(seconds)) errors.push("Seconds is not a whole number");
  if (seconds !== null && seconds > MAX_DURATION_SECONDS) errors.push(`Seconds is above ${MAX_DURATION_SECONDS}`);
  if (distance !== null && distance !== 0) errors.push("Distance is not 0 (Apogee stores no distance)");
  if (reps !== null && seconds !== null) {
    if (reps === 0 && seconds === 0) errors.push("Reps and Seconds are both 0");
    if (reps > 0 && seconds > 0) errors.push("Reps and Seconds are both above 0 (not a plain set or a timed set)");
  }
  let rpe = null;
  if (rpeText !== "") {
    rpe = number(rpeText, "RPE");
    if (rpe !== null && (rpe < RPE_MIN || rpe > RPE_MAX || !Number.isInteger(rpe * 2))) {
      errors.push(`RPE ${rpeText} is not from ${RPE_MIN} to ${RPE_MAX} in steps of 0.5`);
      rpe = null;
    }
  }
  if (errors.length > 0) return { errors };
  return {
    row: {
      line, dateText, nameText: fields[1], durationSeconds, exercise, marker, weight, reps, seconds, rpe,
      startedAt: time.date, warning: time.warning,
    },
  };
}

// The whole file -> { fatal, errors, warnings, workouts }.
//   fatal      a message when the file is refused as a whole (different header, unclosed quote, no header), else null
//   errors     [{ line, message }], collected, never thrown one by one; any error blocks the write
//   workouts   [{ key, dateText, nameText, durationSeconds, startedAt, hasError, rows }] in order of first appearance;
//              a workout is the rows that share Date and Workout Name
export function parseStrongCsv(text) {
  const empty = { fatal: null, errors: [], warnings: [], workouts: [] };
  const { records, error } = parseCsv(text);
  if (error) return { ...empty, fatal: error };
  if (records.length === 0) return { ...empty, fatal: "The file is empty" };
  const header = records[0].fields;
  if (header.length !== STRONG_HEADER.length || header.some((name, i) => name !== STRONG_HEADER[i])) {
    return { ...empty, fatal: `The header is not the 10 Strong columns (${STRONG_HEADER.join(", ")})` };
  }
  const { errors, warnings } = empty;
  const byKey = new Map();
  const workoutOf = (record, row) => {
    const dateText = record.fields[0]?.trim() ?? "";
    const nameText = record.fields[1] ?? "";
    const key = `${dateText}|${nameText}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, dateText, nameText, durationSeconds: row?.durationSeconds ?? null, startedAt: row?.startedAt ?? null, hasError: false, rows: [],
      });
    }
    return byKey.get(key);
  };
  for (const record of records.slice(1)) {
    const result = parseRow(record);
    if (result.errors) {
      for (const message of result.errors) errors.push({ line: record.line, message });
      workoutOf(record, null).hasError = true;
      continue;
    }
    const { row } = result;
    const workout = workoutOf(record, row);
    if (workout.startedAt === null) { workout.startedAt = row.startedAt; workout.durationSeconds = row.durationSeconds; }
    if (row.durationSeconds !== workout.durationSeconds) {
      errors.push({ line: row.line, message: "this workout's rows do not all have the same Duration" });
      workout.hasError = true;
      continue;
    }
    if (row.warning && workout.rows.length === 0) warnings.push({ line: row.line, message: row.warning });
    workout.rows.push(row);
  }
  return { fatal: null, errors, warnings, workouts: [...byKey.values()] };
}

// SHA-256 as hex. There is no fallback: where crypto.subtle is missing (a page that is not HTTPS or localhost, where
// the app cannot make its record ids either) the import is refused rather than given ids that would not repeat.
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("crypto.subtle is not available here (it needs HTTPS or localhost); the import cannot make stable ids");
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const strongWorkoutId = (dateText, nameText) => sha256Hex(`strong|${dateText}|${nameText}`);
const strongExerciseId = async (key) => `strong-exercise-${await sha256Hex(`strong-exercise|${key}`)}`;

// `mapping` is a Map from nameKey(normalized Strong name) to one of
//   { kind: "existing", exerciseId }
//   { kind: "custom", primaryMuscles, secondaryMuscles?, equipmentTags? }   a new custom exercise with the Strong name
//   { kind: "skip" }                                                        its sets are left out (and reported)
// `existing` is { exercises: [stored exercises], workoutIds: Set | array }. Every name used by a workout that would be
// written must have a mapping.
//
// Returns { ok, unit, errors, warnings, report, records, requiredExerciseIds }. records
// { exercises, workouts, entries, sets } are built through the model's create functions; they are what strong-apply
// writes, and report counts exactly those. ok is false when there is any error: nothing may be written then.
export async function buildStrongPlan({ parsed, unit, mapping, existing }) {
  if (!WEIGHT_UNITS.includes(unit)) {
    throw new Error('A weight unit ("lb" or "kg") must be chosen: the file has none and none is assumed');
  }
  const errors = parsed.errors.map((e) => ({ ...e }));
  const records = { exercises: [], workouts: [], entries: [], sets: [] };
  const report = {
    unit,
    workouts: { total: parsed.workouts.length, new: 0, alreadyImported: 0, withErrors: 0, emptyAfterSkips: 0 },
    entries: 0, sets: 0, warmups: 0, failure: 0, drop: 0, rpeKept: 0, timed: 0,
    bodyweight: 0, // weight 0 and not a timed set
    customExercises: 0, merges: [], firstStart: null, lastStart: null,
    dropped: { skippedSets: 0, skippedExercises: 0, fieldsNotStored: ["Distance (the file must have 0 everywhere)", "Set Order label (row order is used)"] },
  };
  if (parsed.fatal) {
    errors.push({ line: 1, message: parsed.fatal });
    return { ok: false, unit, errors, warnings: [], report, records, requiredExerciseIds: [] };
  }
  const existingIds = new Set((existing?.workoutIds ?? []));
  const exercises = existing?.exercises ?? [];
  const storedById = new Map(exercises.map((e) => [e.id, e]));
  const required = new Set();
  const newCustoms = new Map(); // nameKey -> record
  const failedNames = new Set();
  const nameLine = new Map();
  for (const w of parsed.workouts) for (const r of w.rows) if (!nameLine.has(nameKey(r.exercise))) nameLine.set(nameKey(r.exercise), r.line);

  // Resolves a name to { exerciseId } | { skip: true } | null (after pushing an error once).
  const resolutions = new Map();
  async function resolve(row) {
    const key = nameKey(row.exercise);
    if (resolutions.has(key)) return resolutions.get(key);
    const fail = (message) => { if (!failedNames.has(key)) { failedNames.add(key); errors.push({ line: nameLine.get(key), message }); } resolutions.set(key, null); return null; };
    const choice = mapping?.get(key);
    if (choice === undefined) return fail(`no choice was made for the exercise "${row.exercise}"`);
    let resolved;
    if (choice.kind === "skip") resolved = { skip: true };
    else if (choice.kind === "existing") {
      if (!storedById.has(choice.exerciseId)) return fail(`the exercise chosen for "${row.exercise}" does not exist`);
      required.add(choice.exerciseId);
      resolved = { exerciseId: choice.exerciseId };
    } else if (choice.kind === "custom") {
      const id = await strongExerciseId(key);
      if (storedById.has(id)) {
        required.add(id);
        resolved = { exerciseId: id };
      } else {
        try {
          requireFreeName([...exercises, ...newCustoms.values()], row.exercise);
          const record = createExercise({
            id, name: row.exercise, primaryMuscles: choice.primaryMuscles, secondaryMuscles: choice.secondaryMuscles ?? [],
            equipmentTags: choice.equipmentTags ?? [], isCustom: true,
          });
          newCustoms.set(key, record);
          resolved = { exerciseId: id };
        } catch (e) {
          return fail(`the custom exercise "${row.exercise}" is not valid: ${e.message}`);
        }
      }
    } else {
      return fail(`the choice for "${row.exercise}" is not existing, custom or skip`);
    }
    resolutions.set(key, resolved);
    return resolved;
  }

  const usedExerciseKeys = new Set();
  const starts = [];
  for (const workout of parsed.workouts) {
    const id = await strongWorkoutId(workout.dateText, workout.nameText);
    if (existingIds.has(id)) { report.workouts.alreadyImported += 1; continue; }
    if (workout.hasError) { report.workouts.withErrors += 1; continue; }
    const before = errors.length;
    const startedIso = workout.startedAt.toISOString();
    const entries = []; // { record, exerciseId }
    const sets = [];
    const merges = [];
    const entryOf = new Map(); // exerciseId -> { record, blocks, reasons, lastNumber }
    let previous = null; // exerciseId of the previous kept row
    let skipped = 0;
    for (const row of workout.rows) {
      const resolved = await resolve(row);
      if (resolved === null) continue;
      if (resolved.skip) { skipped += 1; continue; }
      usedExerciseKeys.add(nameKey(row.exercise));
      let entry = entryOf.get(resolved.exerciseId);
      const number = /^\d+$/.test(row.marker) ? Number(row.marker) : null;
      if (entry === undefined) {
        const position = entries.length;
        try {
          entry = {
            record: createWorkoutEntry({ id: `${id}-e${position}`, workoutId: id, exerciseId: resolved.exerciseId, order: position, supersetGroup: null }),
            blocks: 1, reasons: [], lastNumber: null, name: row.exercise, sets: 0,
          };
        } catch (e) { errors.push({ line: row.line, message: e.message }); continue; }
        entryOf.set(resolved.exerciseId, entry);
        entries.push(entry);
      } else if (previous !== resolved.exerciseId) {
        entry.blocks += 1;
        entry.reasons.push("comes back later");
        entry.lastNumber = null;
      } else if (number !== null && entry.lastNumber !== null && number <= entry.lastNumber) {
        entry.blocks += 1;
        entry.reasons.push("numbering restarts");
        entry.lastNumber = null;
      }
      if (number !== null) entry.lastNumber = number;
      previous = resolved.exerciseId;
      try {
        sets.push(createWorkSet({
          id: `${entry.record.id}-s${entry.sets}`, entryId: entry.record.id, order: entry.sets,
          ...(row.seconds > 0 ? { durationSeconds: row.seconds } : { reps: row.reps }),
          weightValue: row.weight, weightUnit: unit, isWarmup: row.marker === "W", completedAt: startedIso,
          ...(row.rpe === null ? {} : { rpe: row.rpe }),
          ...(row.marker === "F" ? { setType: SET_TYPES[0] } : row.marker === "D" ? { setType: SET_TYPES[1] } : {}),
        }));
        entry.sets += 1;
      } catch (e) { errors.push({ line: row.line, message: e.message }); }
    }
    let workoutRecord = null;
    try {
      const name = normalizeName(workout.nameText);
      workoutRecord = createWorkout({
        id, startedAt: workout.startedAt, endedAt: new Date(workout.startedAt.getTime() + workout.durationSeconds * 1000),
        ...(name === "" ? {} : { name }),
      });
    } catch (e) { errors.push({ line: workout.rows[0].line, message: e.message }); }
    if (errors.length > before || workoutRecord === null) { report.workouts.withErrors += 1; continue; }
    report.dropped.skippedSets += skipped;
    if (sets.length === 0) { report.workouts.emptyAfterSkips += 1; continue; }
    report.workouts.new += 1;
    records.workouts.push(workoutRecord);
    for (const entry of entries) {
      records.entries.push(entry.record);
      if (entry.blocks > 1) merges.push({ date: workout.dateText, exercise: entry.name, blocks: entry.blocks, reasons: [...new Set(entry.reasons)] });
    }
    records.sets.push(...sets);
    report.merges.push(...merges);
    starts.push({ date: workout.startedAt, text: workout.dateText });
  }
  for (const set of records.sets) {
    if (set.isWarmup) report.warmups += 1;
    if (set.setType === "failure") report.failure += 1;
    if (set.setType === "drop") report.drop += 1;
    if (set.rpe !== undefined) report.rpeKept += 1;
    if (set.durationSeconds !== undefined) report.timed += 1;
    else if (set.weightValue === 0) report.bodyweight += 1;
  }
  records.exercises.push(...[...newCustoms.entries()].filter(([key]) => usedExerciseKeys.has(key)).map(([, record]) => record));
  report.customExercises = records.exercises.length;
  report.entries = records.entries.length;
  report.sets = records.sets.length;
  const skippedKeys = [...resolutions.entries()].filter(([, r]) => r?.skip === true).length;
  report.dropped.skippedExercises = skippedKeys;
  if (starts.length > 0) {
    starts.sort((a, b) => a.date - b.date);
    const show = ({ date, text }) => ({ file: text, utc: date.toISOString(), utcOffsetMinutes: -date.getTimezoneOffset() });
    report.firstStart = show(starts[0]);
    report.lastStart = show(starts.at(-1));
  }
  return {
    ok: errors.length === 0, unit, errors, warnings: parsed.warnings, report, records, requiredExerciseIds: [...required],
  };
}
