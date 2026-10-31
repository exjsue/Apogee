// Domain data model, schema version 5 (version 2 added defaultRestSeconds to exercises; version 3 added
// baseMovementId, equipment, variations, origin, upstreamId, catalogVersion and retired; version 4 added
// templates, a record type of their own; version 5 added the optional workout name and set rpe and setType).
// Pure JavaScript: no DOM, no storage, no network.

export const SCHEMA_VERSION = 5;

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

// Ids the exercise catalog uses that the custom-exercise form does not offer. They are not part of MUSCLES or
// EQUIPMENT (the form lists those two), so the form stays as it is. A stored exercise is validated against
// ALL_MUSCLES and ALL_EQUIPMENT (schema version 3).
export const EXTRA_MUSCLES = Object.freeze(["neck", "abductors"]);
export const EXTRA_EQUIPMENT = Object.freeze(["trap_bar", "medicine_ball", "exercise_ball", "foam_roll", "other"]);
export const ALL_MUSCLES = Object.freeze([...MUSCLES, ...EXTRA_MUSCLES]);
export const ALL_EQUIPMENT = Object.freeze([...EQUIPMENT, ...EXTRA_EQUIPMENT]);

// Where an exercise comes from: a built-in seed, the source project's catalog, an entry written by hand for
// Apogee, or one the user made.
export const ORIGINS = Object.freeze(["seed", "upstream", "authored", "custom"]);

// The fields schema version 3 adds to an exercise, with the value a record saved before it has. The one
// definition used by createExercise (for an absent field), by the 2-to-3 upgrade step and by import of an
// older file.
export function exerciseV3Defaults(record) {
  return {
    baseMovementId: null,
    equipment: null,
    variations: [],
    origin: record.isCustom === true ? "custom" : "seed",
    upstreamId: null,
    catalogVersion: null,
    retired: false,
  };
}

// The weights a custom exercise's secondary muscle may have: how much of a working set it is credited with. Stored
// as the optional secondaryWeights { muscle: weight }; a secondary muscle without one counts 0.5 (DEFAULT_CREDIT in
// muscle-load.js). Optional, so records saved before it need no migration. Default exercises never store it: theirs
// are read from src/catalog/secondary-weights.js.
export const SECONDARY_WEIGHT_STEPS = Object.freeze([0.25, 0.5, 0.75, 1]);

// Maximum lengths, in characters (Unicode code points) after normalization.
export const NAME_MAX_LENGTH = 80;
export const NOTES_MAX_LENGTH = 500;

// A base movement id or a variation tag: lower-case letters and digits in words joined by single hyphens
// ("bench-press", "close-grip"). Checked by form only, never against a list, so a family or tag added to the
// catalog later never makes an existing backup invalid.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const KEBAB_MAX_LENGTH = 40;
export const VARIATIONS_MAX = 12;

// Limits for a template: how many exercises it lists, and how many sets one exercise may plan. Checked only,
// never stored. Lowering one later would make a stored template or a backup invalid.
export const TEMPLATE_MAX_EXERCISES = 50;
export const TEMPLATE_MAX_SETS = 50;

// Limits for a set. Easy to change: they are only checked, never stored.
// A set has 1 to MAX_REPS reps. A weight is 0 (bodyweight) up to
// MAX_WEIGHT_KG, whichever unit it was entered in.
export const MAX_REPS = 1000;
export const MAX_WEIGHT_KG = 2500;

// The longest rest, in seconds: 60:00. Used for an exercise's default rest and by
// the rest timer.
export const MAX_REST_SECONDS = 3600;

// A set's optional RPE (schema 5): 1 to 10 in steps of 0.5. The model accepts the whole scale so an imported
// value is never refused; a picker may offer less.
export const RPE_MIN = 1;
export const RPE_MAX = 10;

// A set's optional kind beyond warm-up (schema 5). Absent means a normal set.
export const SET_TYPES = Object.freeze(["failure", "drop"]);

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

function requireKebab(value, field) {
  if (typeof value !== "string" || value.length > KEBAB_MAX_LENGTH || !KEBAB.test(value)) {
    fail(`${field} must be lower-case words joined by single hyphens, at most ${KEBAB_MAX_LENGTH} characters`);
  }
  return value;
}

// A list of kebab-case tags: sorted, without duplicates, at most VARIATIONS_MAX. Messages never repeat a value.
function requireKebabList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  if (value.length > VARIATIONS_MAX) fail(`${field} must have at most ${VARIATIONS_MAX} entries`);
  value.forEach((item, i) => requireKebab(item, `${field}[${i}]`));
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === value[i - 1]) fail(`${field} must not contain duplicates`);
    if (value[i] < value[i - 1]) fail(`${field} must be sorted`);
  }
  return [...value];
}

function requireOneOf(value, field, allowed, what) {
  if (!allowed.includes(value)) fail(`${field} must be a known ${what}`);
  return value;
}

// secondaryWeights (see SECONDARY_WEIGHT_STEPS): only on a custom exercise, each key one of its secondary muscles.
// Returns a copy with the keys in secondary-muscle order.
function requireSecondaryWeights(value, secondary, isCustom) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("secondaryWeights must be an object");
  if (!isCustom) fail("secondaryWeights is only stored on a custom exercise");
  for (const [muscle, weight] of Object.entries(value)) {
    if (!secondary.includes(muscle)) fail("secondaryWeights must only name secondary muscles");
    if (!SECONDARY_WEIGHT_STEPS.includes(weight)) fail(`secondaryWeights values must be one of ${SECONDARY_WEIGHT_STEPS.join(", ")}`);
  }
  return Object.fromEntries(secondary.filter((muscle) => Object.hasOwn(value, muscle)).map((muscle) => [muscle, value[muscle]]));
}

// origin is "custom" exactly when the user made the exercise.
function requireOrigin(value, isCustom) {
  if (!ORIGINS.includes(value)) fail(`origin must be one of ${ORIGINS.join(", ")}`);
  if ((value === "custom") !== isCustom) fail('origin must be "custom" exactly when isCustom is true');
  return value;
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

// Properties it does not know are ignored here; an import rejects them (src/backup/backup.js).
export function createExercise(input) {
  const {
    id, name, primaryMuscles, secondaryMuscles, equipmentTags, notes, isCustom = false, defaultRestSeconds,
    baseMovementId, equipment, variations, origin, upstreamId, catalogVersion, retired, secondaryWeights,
  } = requireInput(input);
  // null (or missing, as in data saved before schema version 2) means the app's
  // default rest, 3:00. A number is this exercise's own default, in seconds.
  const defaultRest = defaultRestSeconds === undefined || defaultRestSeconds === null
    ? null
    : requireInteger(defaultRestSeconds, "defaultRestSeconds", 0);
  if (defaultRest !== null && defaultRest > MAX_REST_SECONDS) fail(`defaultRestSeconds must be at most ${MAX_REST_SECONDS}`);
  const primary = requireVocabulary(primaryMuscles, "primaryMuscles", ALL_MUSCLES, "muscle");
  const secondary = requireVocabulary(secondaryMuscles, "secondaryMuscles", ALL_MUSCLES, "muscle");
  if (primary.length === 0) fail("primaryMuscles must contain at least one muscle");
  if (secondary.some((muscle) => primary.includes(muscle))) {
    fail("secondaryMuscles must not repeat a primary muscle");
  }
  const record = {
    id: resolveId(id),
    name: requireName(name, "name"),
    primaryMuscles: primary,
    secondaryMuscles: secondary,
    equipmentTags: requireVocabulary(equipmentTags, "equipmentTags", ALL_EQUIPMENT, "equipment tag"),
    notes: optionalNotes(notes, "notes"),
    isCustom: requireBoolean(isCustom, "isCustom"),
    defaultRestSeconds: defaultRest,
  };
  // The schema 3 fields: an absent one gets its default (exerciseV3Defaults); null is allowed where the
  // default is null.
  return {
    ...record,
    baseMovementId: baseMovementId === undefined || baseMovementId === null ? null : requireKebab(baseMovementId, "baseMovementId"),
    equipment: equipment === undefined || equipment === null ? null : requireOneOf(equipment, "equipment", ALL_EQUIPMENT, "equipment"),
    variations: requireKebabList(variations, "variations"),
    origin: requireOrigin(origin === undefined ? exerciseV3Defaults(record).origin : origin, record.isCustom),
    upstreamId: upstreamId === undefined || upstreamId === null ? null : requireNonEmptyString(upstreamId, "upstreamId"),
    catalogVersion: catalogVersion === undefined || catalogVersion === null ? null : requireInteger(catalogVersion, "catalogVersion", 1),
    retired: retired === undefined ? false : requireBoolean(retired, "retired"),
    // Absent stays absent, so a record saved before weights existed keeps its exact shape.
    ...(secondaryWeights === undefined ? {} : { secondaryWeights: requireSecondaryWeights(secondaryWeights, secondary, record.isCustom) }),
  };
}

// `now` is the default for startedAt, so tests can be deterministic.
// name (schema 5) is optional: absent means no name, and absent stays absent so a record saved before it keeps
// its exact shape. When given it follows the exercise name rule (1 to NAME_MAX_LENGTH code points).
export function createWorkout(input = {}) {
  const { id, now = new Date(), startedAt, endedAt, notes, name } = requireInput(input);
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
    ...(name === undefined ? {} : { name: requireName(name, "name") }),
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

// RPE: a number from RPE_MIN to RPE_MAX in steps of 0.5.
function requireRpe(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("rpe must be a number");
  if (value < RPE_MIN || value > RPE_MAX) fail(`rpe must be from ${RPE_MIN} to ${RPE_MAX}`);
  if (!Number.isInteger(value * 2)) fail("rpe must be in steps of 0.5");
  return value;
}

// Weight is stored exactly as entered: value plus unit, never converted.
// rpe and setType (schema 5) are optional: absent means none, and absent stays absent.
export function createWorkSet(input) {
  const {
    id, entryId, order, reps, weightValue, weightUnit,
    isWarmup = false, restSeconds, completedAt, rpe, setType,
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
    ...(rpe === undefined ? {} : { rpe: requireRpe(rpe) }),
    ...(setType === undefined ? {} : { setType: requireOneOf(setType, "setType", SET_TYPES, "set type") }),
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

// A template: a name and an ordered list of exercises, each with how many sets to plan (stored from schema 4).
// Nothing else: no weights, reps, notes or times, and no link to the workout it was made from, so deleting or
// editing that workout can never change it. The name follows the exercise name rule (whitespace collapsed,
// 1 to NAME_MAX_LENGTH characters; longer is refused, never cut). An exercise appears at most once.
// Properties it does not know are ignored here; an import rejects them (src/backup/backup.js).
export function createTemplate(input) {
  const { id, name, exercises } = requireInput(input);
  if (!Array.isArray(exercises)) fail("exercises must be an array");
  if (exercises.length === 0) fail("exercises must contain at least one exercise");
  if (exercises.length > TEMPLATE_MAX_EXERCISES) fail(`exercises must have at most ${TEMPLATE_MAX_EXERCISES} entries`);
  const seen = new Set();
  const items = exercises.map((item, i) => {
    const where = `exercises[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${where} must be an object`);
    const exerciseId = requireNonEmptyString(item.exerciseId, `${where}.exerciseId`);
    if (seen.has(exerciseId)) fail("exercises must not repeat an exercise");
    seen.add(exerciseId);
    const setCount = requireInteger(item.setCount, `${where}.setCount`, 1);
    if (setCount > TEMPLATE_MAX_SETS) fail(`${where}.setCount must be at most ${TEMPLATE_MAX_SETS}`);
    return { exerciseId, setCount };
  });
  return { id: resolveId(id), name: requireName(name, "name"), exercises: items };
}
