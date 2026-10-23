// Rest timer rules. Pure: no DOM, no storage and no clock of its own. Every
// function that depends on the time takes it as `nowMs` (milliseconds), so a
// test can control it and the app can read it from the clock on every tick.
//
// A timer is { setId, startedAt, endsAt }, both times absolute. The remaining
// time is always computed as endsAt - now; nothing is ever counted down.

import { MAX_REST_SECONDS } from "./model.js";

export { MAX_REST_SECONDS };
export const DEFAULT_REST_SECONDS = 180;

function fail(message) {
  throw new Error(message);
}

export function requireRest(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) fail("rest must be a whole number of seconds, 0 or more");
  if (seconds > MAX_REST_SECONDS) fail("rest can't be longer than 60:00");
  return seconds;
}

// 0 -> "0:00", 185 -> "3:05", 3600 -> "60:00".
export function formatRest(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// "3:00" -> 180. Strict: minutes, a colon, two digits of seconds (00-59).
// A bare number is refused because "90" could mean seconds or minutes.
export function parseRest(text) {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(typeof text === "string" ? text.trim() : "");
  if (match === null) fail("rest must look like 3:00 (minutes:seconds)");
  return requireRest(Number(match[1]) * 60 + Number(match[2]));
}

export function startTimer({ setId, nowMs, restSeconds }) {
  if (typeof setId !== "string" || setId === "") fail("setId must be a non-empty string");
  if (!Number.isFinite(nowMs)) fail("nowMs must be a number");
  return { setId, startedAt: nowMs, endsAt: nowMs + requireRest(restSeconds) * 1000 };
}

// Milliseconds left, between 0 and the full rest. The clamp matters when the
// clock jumps: backwards it never shows more than the full rest, forwards it
// ends the timer.
export function remainingMs(timer, nowMs) {
  const total = timer.endsAt - timer.startedAt;
  return Math.min(total, Math.max(0, timer.endsAt - nowMs));
}

// Whole seconds to show: rounded up, so 0:00 appears only once the timer is over.
export const remainingSeconds = (timer, nowMs) => Math.ceil(remainingMs(timer, nowMs) / 1000);

export const isRunning = (timer, nowMs) => timer !== null && remainingMs(timer, nowMs) > 0;

// 1 at the start, 0 at the end.
export function fractionRemaining(timer, nowMs) {
  const total = timer.endsAt - timer.startedAt;
  return total <= 0 ? 0 : remainingMs(timer, nowMs) / total;
}

// The rest of a running set was edited: the end is recomputed from the START
// time. Returns the new timer, or null when the new rest is not longer than the
// time already elapsed (the timer ends at once).
export function rescheduleTimer(timer, restSeconds, nowMs) {
  const next = { ...timer, endsAt: timer.startedAt + requireRest(restSeconds) * 1000 };
  return next.endsAt <= nowMs ? null : next;
}

// "template": not checked yet. "resting": checked, and this set owns the one
// running timer. "done": checked, and not the running timer (its timer ended,
// was replaced by a newer check, or expired while the app was closed).
export function setPhase({ logged, setId, timer, nowMs }) {
  if (!logged) return "template";
  return timer !== null && timer.setId === setId && isRunning(timer, nowMs) ? "resting" : "done";
}

const round = (value) => Math.round(value * 1000) / 1000;

function circlePath(cx, cy, r) {
  return `M ${cx} ${round(cy - r)} A ${r} ${r} 0 1 1 ${cx} ${round(cy + r)} A ${r} ${r} 0 1 1 ${cx} ${round(cy - r)} Z`;
}

// The white pie of the rest icon. `fraction` is the part still remaining.
// The pie depletes clockwise from 12 o'clock: the removed part is the arc from
// the top clockwise, and the remaining wedge runs from there back to the top.
// Returns { kind: "empty" | "wedge" | "full", d } with an SVG path in a
// coordinate system where the circle has centre (cx, cy) and radius r.
export function pieGeometry(fraction, { cx = 12, cy = 12, r = 10 } = {}) {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  if (f <= 0) return { kind: "empty", d: "" };
  if (f >= 1) return { kind: "full", d: circlePath(cx, cy, r) };
  const angle = 2 * Math.PI * (1 - f); // clockwise from 12 o'clock to where the wedge starts
  const startX = round(cx + r * Math.sin(angle));
  const startY = round(cy - r * Math.cos(angle));
  const largeArc = f > 0.5 ? 1 : 0;
  return { kind: "wedge", d: `M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${cx} ${round(cy - r)} Z` };
}

// ---- typing a rest time on a phone ----
//
// An iPhone's numeric keypad has no ":" key, so a rest time is typed as digits, like
// a microwave timer: the last two digits are seconds and the digits before them are
// minutes. "300" is 3:00, "130" is 1:30, "45" is 0:45, "5" is 0:05, "1000" is 10:00.
// Seconds above 59 roll into minutes ("90" is 1:30). A typed colon ("3:00") still
// works for hardware keyboards. The longest rest is still 60:00, and 0 is allowed.

export const REST_ENTRY_HELP = "Enter the rest time, e.g. 300 for 3:00";
const MAX_ENTRY_DIGITS = 6;

// Seconds from what was typed. Throws an Error with a plain message that the
// screen shows as it is: REST_ENTRY_HELP for anything that is not a time, or the
// "can't be longer than 60:00" message for a time over the maximum.
export function parseRestEntry(text) {
  const value = typeof text === "string" ? text.trim() : "";
  const colon = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (colon !== null) return requireRest(Number(colon[1]) * 60 + Number(colon[2]));
  if (!/^\d+$/.test(value)) fail(REST_ENTRY_HELP);
  if (value.length > MAX_ENTRY_DIGITS) fail("rest can't be longer than 60:00");
  const minutes = Number(value.slice(0, -2) || 0);
  const seconds = Number(value.slice(-2));
  return requireRest(minutes * 60 + seconds);
}

// What to show next to the field while typing: the time as it will be read, or the
// reason it cannot be. Blank shows nothing yet.
export function previewRestEntry(text) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, label: "", message: "" };
  try {
    const seconds = parseRestEntry(text);
    return { ok: true, seconds, label: formatRest(seconds), message: "" };
  } catch (error) {
    return { ok: false, label: "", message: error.message };
  }
}

// A rest in seconds as the digits that read back to it: 180 is "300", 75 is "115",
// 3600 is "6000". It is what an editor starts with, so saving without changing
// anything can never change a rest.
export function restToDigits(seconds) {
  requireRest(seconds);
  return String(Math.floor(seconds / 60) * 100 + (seconds % 60));
}
