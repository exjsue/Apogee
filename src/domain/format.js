// Parsing of typed input and formatting for display. Pure functions, no DOM.
// Parsing is strict: blank input is an error and never becomes 0, and error
// messages never repeat what was typed.

import { convertWeight } from "./model.js";

function fail(message) {
  throw new Error(message);
}

function requireEntered(text, field) {
  if (typeof text !== "string") fail(`${field} must be entered as text`);
  const trimmed = text.trim();
  if (trimmed === "") fail(`${field} is required`);
  return trimmed;
}

// "10" -> 10. Digits only: no sign, decimal point, comma or exponent. A
// minus sign gets its own message. Any number of digits is read; whether the
// number is acceptable (1 to MAX_REPS) is the domain's call, so 920319039
// reaches it and is refused there with the maximum named.
export function parseWholeNumber(text, field = "value") {
  const entered = requireEntered(text, field);
  if (/^-\d+$/.test(entered)) fail(`${field} can't be negative`);
  if (!/^\d+$/.test(entered)) fail(`${field} must be a whole number`);
  const value = Number(entered);
  if (!Number.isSafeInteger(value)) fail(`${field} is too large`);
  return value;
}

// "62.5" -> 62.5 and "62,5" -> 62.5. A comma counts as a decimal mark only
// when one or two digits follow it and there is no other separator, so
// "1,500" and "1.500,5" are rejected rather than guessed at. No exponent,
// hex, Infinity or NaN, and no "+". A minus sign gets its own message. Zero
// must be typed ("0"), never inferred. How large a weight may be is the
// domain's call (MAX_WEIGHT_KG), so a long number is read here and refused there.
export function parseDecimal(text, field = "value") {
  const entered = requireEntered(text, field);
  if (/^-\d+([.,]\d+)?$/.test(entered)) fail(`${field} can't be negative`);
  let normalized;
  if (/^\d+(\.\d+)?$/.test(entered)) {
    if (/\.\d{5,}$/.test(entered)) fail(`${field} can have at most 4 decimal places`);
    normalized = entered;
  } else if (/^\d+,\d{1,2}$/.test(entered)) {
    normalized = entered.replace(",", ".");
  } else {
    fail(`${field} must be a number such as 62.5 or 62,5`);
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) fail(`${field} is too large`);
  return value;
}

// "front_delts" -> "Front delts"
export function formatLabel(id) {
  const spaced = String(id).replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// formatCount(1, "set") -> "1 set", formatCount(2, "set") -> "2 sets"
export function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// The number as stored when the units match; otherwise converted and rounded
// to one decimal place. Rounding is for display only and is never stored.
export function formatWeight(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return String(value);
  return String(Math.round(convertWeight(value, fromUnit, toUnit) * 10) / 10);
}

// "100 kg" in the unit it was entered in; "220.5 lb (entered 100 kg)" when
// shown in the other unit. A weight of 0 is bodyweight.
export function formatSetWeight(value, storedUnit, displayUnit) {
  const { text, entered } = formatSetWeightParts(value, storedUnit, displayUnit);
  return entered === null ? text : `${text} (entered ${entered})`;
}

// The same, in two parts, so a narrow screen can put the note on its own line:
// { text: "220.5 lb", entered: "100 kg" }, entered is null when the units match.
export function formatSetWeightParts(value, storedUnit, displayUnit) {
  if (value === 0) return { text: "Bodyweight", entered: null };
  return {
    text: `${formatWeight(value, storedUnit, displayUnit)} ${displayUnit}`,
    entered: storedUnit === displayUnit ? null : `${value} ${storedUnit}`,
  };
}

// A stored UTC timestamp as local date and time. `locale` and `timeZone`
// default to the browser's and exist so tests are deterministic.
export function formatDateTime(isoTimestamp, { locale, timeZone } = {}) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) fail("not a valid timestamp");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

// A timed set's duration: "45 s" under a minute, else m:ss ("1:15") or h:mm:ss.
export const formatSetDuration = (seconds) => (seconds < 60 ? `${seconds} s` : formatElapsed(0, seconds * 1000));

// A timed set (a duration and no reps).
export const isTimedSet = (set) => set.reps === undefined && set.durationSeconds !== undefined;

// What a set did, for a line of text: "8 reps", or a timed set's time. A timed set with weight 0 shows no weight;
// `weightText` is the set's weight as the screen writes it.
export const formatSetLine = (set, weightText) => (isTimedSet(set)
  ? (set.weightValue === 0 ? formatSetDuration(set.durationSeconds) : `${formatSetDuration(set.durationSeconds)} · ${weightText}`)
  : `${formatCount(set.reps, "rep")} · ${weightText}`);

// Time since a start, as m:ss, or h:mm:ss from one hour on (hours are not capped, there is no day format).
// A start after "now" (the clock was set back) reads 0:00. Both arguments are milliseconds.
export function formatElapsed(startMs, nowMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) fail("not a valid time");
  const total = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
