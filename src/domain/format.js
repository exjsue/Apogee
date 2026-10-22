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

// "10" -> 10. Digits only: no sign, decimal point, comma or exponent.
// Whether the number is acceptable (for example reps >= 1) is the domain's call.
export function parseWholeNumber(text, field = "value") {
  const entered = requireEntered(text, field);
  if (!/^\d{1,9}$/.test(entered)) fail(`${field} must be a whole number`);
  return Number(entered);
}

// "62.5" -> 62.5 and "62,5" -> 62.5. A comma counts as a decimal mark only
// when one or two digits follow it and there is no other separator, so
// "1,500" and "1.500,5" are rejected rather than guessed at. No sign,
// exponent, hex, Infinity or NaN. Zero must be typed ("0"), never inferred.
export function parseDecimal(text, field = "value") {
  const entered = requireEntered(text, field);
  let normalized;
  if (/^\d{1,7}(\.\d{1,4})?$/.test(entered)) normalized = entered;
  else if (/^\d{1,7},\d{1,2}$/.test(entered)) normalized = entered.replace(",", ".");
  else fail(`${field} must be a number such as 62.5 or 62,5`);
  const value = Number(normalized);
  if (!Number.isFinite(value)) fail(`${field} must be a number such as 62.5 or 62,5`);
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
  if (value === 0) return "Bodyweight";
  const shown = `${formatWeight(value, storedUnit, displayUnit)} ${displayUnit}`;
  return storedUnit === displayUnit ? shown : `${shown} (entered ${value} ${storedUnit})`;
}

// A stored UTC timestamp as local date and time. `locale` and `timeZone`
// default to the browser's and exist so tests are deterministic.
export function formatDateTime(isoTimestamp, { locale, timeZone } = {}) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) fail("not a valid timestamp");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}
