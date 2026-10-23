// Domain data model, schema version 2 (version 2 added defaultRestSeconds to exercises).
// Pure JavaScript: no DOM, no storage, no network.

export const SCHEMA_VERSION = 2;

export const WEIGHT_UNITS = ["kg", "lb"];

// Fixed vocabularies for exercises. Part of schema version 1: adding an id
// later is safe, removing or renaming one needs a data migration.
export const MUSCLES = Object.freeze([
  "chest", "front_delts", "side_delts", "rear_delts", "biceps", "triceps",
  "forearms", "traps", "lats", "upper_back", "lower_back", "abs", "obliques",
  "glutes", "quads", "hamstrings", "calves", "adductors",
]);

export const EQUIPMENT = Object.freeze([
  "barbell", "dumbbell", "kettlebell", "ez_bar", "machine", "smith_machine",
  "cable", "resistance_band", "bodyweight", "bench", "pull_up_bar",
]);

// Maximum lengths, in characters (Unicode code points) after normalization.
export const NAME_MAX_LENGTH = 80;
export const NOTES_MAX_LENGTH = 500;

// Limits for a set. Easy to change: they are only checked, never stored.
// A set has 1 to MAX_REPS reps. A weight is 0 (bodyweight) up to
// MAX_WEIGHT_KG, whichever unit it was entered in.
export const MAX_REPS = 1000;
export const MAX_WEIGHT_KG = 2500;

// The longest rest, in seconds: 60:00. Used for an exercise's default rest and by
// the rest timer.
export const MAX_REST_SECONDS = 3600;

// Exact definition of the avoirdupois pound.
const KG_PER_LB = 0.45359237;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new Error(message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

// Every run of whitespace (including line breaks) becomes one space, and the
// ends are trimmed, so stored text is always single-line and canonical.
function normalizeText(value, field, maxLength) {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const text = value.replace(/\s+/g, " ").trim();
  if ([...text].length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return text;
}

function requireName(value, field) {
  if (typeof value !== "string") fail(`${field} must be a non-empty string`);
  const text = normalizeText(value, field, NAME_MAX_LENGTH);
  if (text === "") fail(`${field} must be a non-empty string`);
  return text;
}

function optionalNotes(value, field) {
  if (value === undefined) return "";
  return normalizeText(value, field, NOTES_MAX_LENGTH);
}

// A list of ids from a fixed vocabulary, without duplicates. Messages never
// repeat the offending value.
function requireVocabulary(value, field, allowed, what) {
  const items = requireStringArray(value, field);
  const seen = new Set();
  for (const [i, item] of items.entries()) {
    if (!allowed.includes(item)) fail(`${field}[${i}] must be a known ${what}`);
    if (seen.has(item)) fail(`${field} must not contain duplicates`);
    seen.add(item);
  }
  return items;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") fail(`${field} must be true or false`);
  return value;
}

function requireInteger(value, field, min) {
  if (!Number.isInteger(value) || value < min) {
    fail(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function requireStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  return value.map((item, i) => requireNonEmptyString(item, `${field}[${i}]`));
}

function requireWeightUnit(value, field) {
  if (!WEIGHT_UNITS.includes(value)) fail(`${field} must be "kg" or "lb"`);
  return value;
}

// Accepts an ISO 8601 string or a Date and returns a UTC ISO string.
function toUtcIso(value, field) {
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string" && ISO_8601.test(value)) {
    date = new Date(value);
  } else {
    fail(`${field} must be an ISO 8601 timestamp`);
  }
  if (Number.isNaN(date.getTime())) fail(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function optionalTimestamp(value, field) {
  return value === undefined || value === null ? null : toUtcIso(value, field);
}

function resolveId(id) {
  if (id === undefined) return crypto.randomUUID();
  return requireNonEmptyString(id, "id");
}

function requireInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object");
  }
  return input;
}

export function createExercise(input) {
  const {
    id, name, primaryMuscles, secondaryMuscles, equipmentTags, notes, isCustom = false, defaultRestSeconds,
  } = requireInput(input);
  // null (or missing, as in data saved before schema version 2) means the app's
  // default rest, 3:00. A number is this exercise's own default, in seconds.
  const defaultRest = defaultRestSeconds === undefined || defaultRestSeconds === null
    ? null
    : requireInteger(defaultRestSeconds, "defaultRestSeconds", 0);
  if (defaultRest !== null && defaultRest > MAX_REST_SECONDS) fail(`defaultRestSeconds must be at most ${MAX_REST_SECONDS}`);
  const primary = requireVocabulary(primaryMuscles, "primaryMuscles", MUSCLES, "muscle");
  const secondary = requireVocabulary(secondaryMuscles, "secondaryMuscles", MUSCLES, "muscle");
  if (primary.length === 0) fail("primaryMuscles must contain at least one muscle");
  if (secondary.some((muscle) => primary.includes(muscle))) {
    fail("secondaryMuscles must not repeat a primary muscle");
  }
  return {
    id: resolveId(id),
    name: requireName(name, "name"),
    primaryMuscles: primary,
    secondaryMuscles: secondary,
    equipmentTags: requireVocabulary(equipmentTags, "equipmentTags", EQUIPMENT, "equipment tag"),
    notes: optionalNotes(notes, "notes"),
    isCustom: requireBoolean(isCustom, "isCustom"),
    defaultRestSeconds: defaultRest,
  };
}

// `now` is the default for startedAt, so tests can be deterministic.
export function createWorkout(input = {}) {
  const { id, now = new Date(), startedAt, endedAt, notes } = requireInput(input);
  const started = toUtcIso(startedAt === undefined ? now : startedAt, "startedAt");
  const ended = optionalTimestamp(endedAt, "endedAt");
  if (ended !== null && new Date(ended) < new Date(started)) {
    fail("endedAt must not be earlier than startedAt");
  }
  return {
    id: resolveId(id),
    startedAt: started,
    endedAt: ended,
    notes: optionalNotes(notes, "notes"),
  };
}

export function createWorkoutEntry(input) {
  const {
    id, workoutId, exerciseId, order, supersetGroup = null, notes,
  } = requireInput(input);
  if (supersetGroup !== null) requireNonEmptyString(supersetGroup, "supersetGroup");
  return {
    id: resolveId(id),
    workoutId: requireNonEmptyString(workoutId, "workoutId"),
    exerciseId: requireNonEmptyString(exerciseId, "exerciseId"),
    order: requireInteger(order, "order", 0),
    supersetGroup,
    notes: optionalNotes(notes, "notes"),
  };
}

// Reps: a whole number from 1 to MAX_REPS. Each message says which rule broke.
function requireReps(value) {
  if (typeof value !== "number" || Number.isNaN(value)) fail("reps must be a whole number");
  if (value > MAX_REPS) fail(`reps is above the maximum of ${MAX_REPS}`);
  if (value < 0) fail("reps can't be negative");
  if (!Number.isInteger(value)) fail("reps must be a whole number");
  if (value < 1) fail("reps must be at least 1");
  return value;
}

// The kg/lb round trip is not exact in floating point: for about 3% of
// possible limits (31 kg, 59 kg, 62 kg, ...) converting the limit to pounds and
// back lands a hair above it. This tolerance stops a weight sitting exactly on
// the limit in pounds from being rejected by that noise, whatever MAX_WEIGHT_KG
// is changed to.
const WEIGHT_LIMIT_TOLERANCE_KG = 1e-9;

// Is the weight above the limit? `maxKg` is a parameter only so the tolerance
// can be tested against limits that show the rounding noise.
export function isAboveWeightLimit(value, unit, maxKg = MAX_WEIGHT_KG) {
  const kg = unit === "lb" ? value * KG_PER_LB : value;
  return kg > maxKg + WEIGHT_LIMIT_TOLERANCE_KG;
}

// The limit in the unit the weight was entered in, rounded DOWN to 2 decimals
// so the number shown is itself acceptable.
function describeWeightLimit(unit) {
  const limit = unit === "kg" ? MAX_WEIGHT_KG : MAX_WEIGHT_KG / KG_PER_LB;
  return `${Math.floor(limit * 100) / 100} ${unit}`;
}

// Weight: 0 (bodyweight) up to MAX_WEIGHT_KG once converted to kg. The stored
// value stays exactly as entered; the conversion is only used to check the limit.
function requireWeight(value, unit) {
  if (typeof value !== "number" || Number.isNaN(value)) fail("weight must be a number");
  if (value < 0) fail("weight can't be negative");
  if (isAboveWeightLimit(value, unit)) {
    fail(`weight is above the maximum of ${describeWeightLimit(unit)}`);
  }
  return value;
}

// Weight is stored exactly as entered: value plus unit, never converted.
export function createWorkSet(input) {
  const {
    id, entryId, order, reps, weightValue, weightUnit,
    isWarmup = false, restSeconds, completedAt,
  } = requireInput(input);
  const unit = requireWeightUnit(weightUnit, "weightUnit");
  const weight = requireWeight(weightValue, unit);
  const rest = restSeconds === undefined || restSeconds === null
    ? null
    : requireInteger(restSeconds, "restSeconds", 0);
  return {
    id: resolveId(id),
    entryId: requireNonEmptyString(entryId, "entryId"),
    order: requireInteger(order, "order", 0),
    reps: requireReps(reps),
    weightValue: weight,
    weightUnit: unit,
    isWarmup: requireBoolean(isWarmup, "isWarmup"),
    restSeconds: rest,
    completedAt: optionalTimestamp(completedAt, "completedAt"),
  };
}

// For display and calculation only. Does not round; never use the result
// as the stored value.
export function convertWeight(value, fromUnit, toUnit) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("value must be a finite number");
  }
  requireWeightUnit(fromUnit, "fromUnit");
  requireWeightUnit(toUnit, "toUnit");
  if (fromUnit === toUnit) return value;
  return fromUnit === "lb" ? value * KG_PER_LB : value / KG_PER_LB;
}
