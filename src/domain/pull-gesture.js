// Pull-to-refresh rules. Pure: no DOM, no clock, no network. src/ui/pull-refresh.js
// reads the touch events and the page and passes plain numbers and flags in here;
// every decision about WHEN a pull counts, and what may happen after it, is made
// in this file so it can be tested without a browser.
//
// A pull counts only if it starts with the page scrolled to the very top, goes
// mostly straight down, stays at the top, uses one finger, and is released past
// the threshold. Anything else is an ordinary touch and is left alone.

export const PULL_START_SLOP_PX = 8; // moves smaller than this are taps and slips, never a pull
export const PULL_THRESHOLD_PX = 70; // the pull, after resistance, at which letting go refreshes
export const PULL_MAX_PX = 120;
export const PULL_RESISTANCE = 0.5; // the finger moves two pixels for one pixel of pull
export const PULL_LEVELS = 4; // steps of the indicator (the screen shows them with CSS classes)

// Input types that are not text entry: focusing one of them does not stop a pull.
const NOT_TEXT_ENTRY = new Set(["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"]);

// Is this element somewhere the user types or picks a value? ({ tagName, type, isContentEditable }).
export function isTextEntryElement(element) {
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = String(element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NOT_TEXT_ENTRY.has(String(element.type ?? "text").toLowerCase());
}

// A pull is not even considered while the user is typing or a menu or dialog is open.
export function isBlocked({ inputFocused = false, menuOpen = false, dialogOpen = false } = {}) {
  return inputFocused || menuOpen || dialogOpen;
}

// May a touch that just started begin a pull? `scrollTop` can be 0 or negative (the
// elastic overscroll at the top); anything below the top never starts one.
export function canStartPull({ scrollTop, touchCount, blocked }) {
  return scrollTop <= 0 && touchCount === 1 && blocked !== true;
}

export const startPull = ({ x, y }) => ({ startX: x, startY: y, armed: false, cancelled: false });

const cancel = (gesture) => ({ gesture: { ...gesture, armed: false, cancelled: true }, phase: "cancelled", distance: 0 });

// One touchmove. Returns the next gesture, the phase ("idle" not pulling yet,
// "pulling", "armed" past the threshold, or "cancelled") and the pull distance.
// A cancelled gesture stays cancelled for the rest of the touch.
export function movePull(gesture, { x, y, scrollTop, touchCount, blocked }) {
  if (gesture.cancelled) return { gesture, phase: "cancelled", distance: 0 };
  if (scrollTop > 0 || touchCount !== 1 || blocked === true) return cancel(gesture);
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  if (dy < -PULL_START_SLOP_PX) return cancel(gesture); // upward: an ordinary scroll
  if (Math.abs(dx) > PULL_START_SLOP_PX && Math.abs(dx) > dy) return cancel(gesture); // mostly sideways
  if (dy <= PULL_START_SLOP_PX) return { gesture: { ...gesture, armed: false }, phase: "idle", distance: 0 };
  const distance = Math.min(PULL_MAX_PX, (dy - PULL_START_SLOP_PX) * PULL_RESISTANCE);
  const armed = distance >= PULL_THRESHOLD_PX;
  return { gesture: { ...gesture, armed }, phase: armed ? "armed" : "pulling", distance };
}

// The finger came up. "refresh" only if the gesture was never cancelled and is
// past the threshold right now (pulling back under it before letting go cancels).
export function endPull(gesture) {
  return gesture && gesture.cancelled !== true && gesture.armed === true ? "refresh" : "cancel";
}

// 0 (nothing to show) to PULL_LEVELS (at or past the threshold), for the indicator.
export function pullLevel(distance) {
  if (!(distance > 0)) return 0;
  return Math.min(PULL_LEVELS, Math.ceil(distance / (PULL_THRESHOLD_PX / PULL_LEVELS)));
}

// What to do with the answer of offline.checkNow(). Reloading is the exception:
// only a new version waiting ("update") or this tab being behind ("elsewhere")
// leads to it, and anything unknown never does.
export function afterCheck(result) {
  switch (result && result.status) {
    case "update": return "apply";
    case "elsewhere": return "reload";
    case "current": return "up-to-date";
    case "installing": return "installing";
    case "off": return "off";
    default: return "unreachable";
  }
}

// An input is unsaved when what it shows differs from what was last saved
// ({ value, saved } for each input that has a saved copy).
export function hasUnsavedInput(fields) {
  return fields.some((field) => field.value !== field.saved);
}

// Reloading needs the user's say-so when something would be lost or interrupted.
export const confirmationNeeded = ({ timerRunning, unsavedInput }) => timerRunning === true || unsavedInput === true;

// The question asked before the reload. It says the timer survives only when a
// timer is running (it is stored with its end time, so it does), and warns about
// lost text only when there is some.
export function confirmMessage({ timerRunning, unsavedInput }) {
  const lines = ["Reload to use the new version?"];
  if (unsavedInput === true) lines.push("Text you typed that is not saved yet will be lost.");
  if (timerRunning === true) lines.push("A rest timer is running. It keeps running through the reload.");
  return lines.join(" ");
}
