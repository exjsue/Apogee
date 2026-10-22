// Domain data model, schema version 1.
// Pure JavaScript: no DOM, no storage, no network.

export const SCHEMA_VERSION = 1;

export const WEIGHT_UNITS = ["kg", "lb"];

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

function optionalString(value, field) {
  if (value === undefined) return "";
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
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
    id, name, primaryMuscles, secondaryMuscles, equipmentTags, notes, isCustom = false,
  } = requireInput(input);
  return {
    id: resolveId(id),
    name: requireNonEmptyString(name, "name"),
    primaryMuscles: requireStringArray(primaryMuscles, "primaryMuscles"),
    secondaryMuscles: requireStringArray(secondaryMuscles, "secondaryMuscles"),
    equipmentTags: requireStringArray(equipmentTags, "equipmentTags"),
    notes: optionalString(notes, "notes"),
    isCustom: requireBoolean(isCustom, "isCustom"),
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
    notes: optionalString(notes, "notes"),
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
    notes: optionalString(notes, "notes"),
  };
}

// Weight is stored exactly as entered: value plus unit, never converted.
export function createWorkSet(input) {
  const {
    id, entryId, order, reps, weightValue, weightUnit,
    isWarmup = false, restSeconds, completedAt,
  } = requireInput(input);
  if (typeof weightValue !== "number" || !Number.isFinite(weightValue) || weightValue < 0) {
    fail("weightValue must be a finite number >= 0");
  }
  const rest = restSeconds === undefined || restSeconds === null
    ? null
    : requireInteger(restSeconds, "restSeconds", 0);
  return {
    id: resolveId(id),
    entryId: requireNonEmptyString(entryId, "entryId"),
    order: requireInteger(order, "order", 0),
    reps: requireInteger(reps, "reps", 1),
    weightValue,
    weightUnit: requireWeightUnit(weightUnit, "weightUnit"),
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
