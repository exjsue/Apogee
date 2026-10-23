import test from "node:test";
import assert from "node:assert/strict";
import {
  PULL_START_SLOP_PX, PULL_THRESHOLD_PX, PULL_MAX_PX, isTextEntryElement, isBlocked, canStartPull, startPull, movePull,
  endPull, pullLevel, afterCheck, hasUnsavedInput, confirmationNeeded, confirmMessage,
} from "../src/domain/pull-gesture.js";

// A finger that goes down `dy` pixels from (100, 200) with the page at the top.
const MOVE = { scrollTop: 0, touchCount: 1, blocked: false };
const pull = (dy, extra = {}) => movePull(startPull({ x: 100, y: 200 }), { x: 100, y: 200 + dy, ...MOVE, ...extra });
// enough dy for the pull (after resistance) to reach the threshold
const PAST = PULL_START_SLOP_PX + PULL_THRESHOLD_PX * 2 + 4;

test("a pull can start only at the very top, with one finger, when nothing is open or being typed in", () => {
  assert.equal(canStartPull({ scrollTop: 0, touchCount: 1, blocked: false }), true);
  assert.equal(canStartPull({ scrollTop: -12, touchCount: 1, blocked: false }), true); // the elastic overscroll at the top
  assert.equal(canStartPull({ scrollTop: 1, touchCount: 1, blocked: false }), false);
  assert.equal(canStartPull({ scrollTop: 0, touchCount: 2, blocked: false }), false);
  assert.equal(canStartPull({ scrollTop: 0, touchCount: 0, blocked: false }), false);
  assert.equal(canStartPull({ scrollTop: 0, touchCount: 1, blocked: true }), false);
  assert.equal(isBlocked({ inputFocused: true }), true);
  assert.equal(isBlocked({ menuOpen: true }), true);
  assert.equal(isBlocked({ dialogOpen: true }), true);
  assert.equal(isBlocked({}), false);
  for (const typing of [{ tagName: "INPUT", type: "text" }, { tagName: "input" }, { tagName: "INPUT", type: "search" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    assert.equal(isTextEntryElement(typing), true, JSON.stringify(typing));
  }
  for (const other of [{ tagName: "BUTTON" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "A" }, null, undefined]) {
    assert.equal(isTextEntryElement(other), false, JSON.stringify(other));
  }
});

test("anything that is not a clean downward pull cancels it for good, so a later long move cannot refresh", () => {
  const cancellations = [
    ["the page was scrolled away from the top", { scrollTop: 1 }, 200],
    ["a second finger came down", { touchCount: 2 }, 200],
    ["a menu or dialog opened, or typing began", { blocked: true }, 200],
    ["the finger went up (an ordinary scroll)", {}, -(PULL_START_SLOP_PX + 1)],
    ["the finger went mostly sideways", { x: 300 }, 100],
  ];
  for (const [why, extra, dy] of cancellations) {
    const first = pull(dy, extra);
    assert.equal(first.phase, "cancelled", why);
    assert.equal(endPull(first.gesture), "cancel", why);
    const later = movePull(first.gesture, { x: 100, y: 200 + PAST, ...MOVE }); // would be past the threshold
    assert.equal(later.phase, "cancelled", why);
    assert.equal(endPull(later.gesture), "cancel", why);
  }
});

test("letting go refreshes only past the threshold, never for a tap or a slip, and pulling back under cancels", () => {
  assert.equal(pull(0).phase, "idle");
  assert.equal(pull(PULL_START_SLOP_PX).phase, "idle"); // a slip of the finger
  assert.equal(endPull(pull(PULL_START_SLOP_PX).gesture), "cancel");
  const short = pull(PULL_START_SLOP_PX + PULL_THRESHOLD_PX); // 70 px of finger = 35 px of pull
  assert.equal(short.phase, "pulling");
  assert.equal(endPull(short.gesture), "cancel");
  const far = pull(PAST);
  assert.equal(far.phase, "armed");
  assert.equal(endPull(far.gesture), "refresh");
  // armed, then back under the threshold before letting go
  const back = movePull(far.gesture, { x: 100, y: 200 + PULL_START_SLOP_PX + 20, ...MOVE });
  assert.equal(back.phase, "pulling");
  assert.equal(endPull(back.gesture), "cancel");
  assert.equal(endPull(null), "cancel");
  assert.ok(pull(5000).distance <= PULL_MAX_PX);
});

test("the indicator step is 0 when not pulling, never goes down as the pull grows, and stays within 1 to 4 (the CSS has those steps)", () => {
  assert.deepEqual([0, -5, NaN].map(pullLevel), [0, 0, 0]);
  let previous = 0;
  for (let distance = 1; distance <= PULL_MAX_PX; distance += 1) {
    const level = pullLevel(distance);
    assert.ok(level >= 1 && level <= 4 && level >= previous, `distance ${distance}`);
    previous = level;
  }
  assert.equal(pullLevel(PULL_THRESHOLD_PX), 4); // fully shown by the time the pull is armed
});

test("only a waiting new version, or a tab left behind, can lead to a reload: 'up to date' and every failure never do", () => {
  assert.equal(afterCheck({ status: "update" }), "apply");
  assert.equal(afterCheck({ status: "elsewhere" }), "reload");
  assert.equal(afterCheck({ status: "current" }), "up-to-date");
  assert.equal(afterCheck({ status: "installing" }), "installing");
  assert.equal(afterCheck({ status: "off" }), "off");
  for (const unknown of [undefined, null, {}, { status: "" }, { status: "UPDATE" }, { status: "reload" }, "update", 7, { status: { x: 1 } }]) {
    const decision = afterCheck(unknown);
    assert.equal(decision, "unreachable", JSON.stringify(unknown));
    assert.ok(decision !== "apply" && decision !== "reload");
  }
});

test("the reload asks first when a timer is running or text is unsaved, and the question says only what is true", () => {
  assert.equal(confirmationNeeded({ timerRunning: false, unsavedInput: false }), false);
  assert.equal(confirmationNeeded({}), false);
  assert.equal(confirmationNeeded({ timerRunning: true, unsavedInput: false }), true);
  assert.equal(confirmationNeeded({ timerRunning: false, unsavedInput: true }), true);
  const timerOnly = confirmMessage({ timerRunning: true, unsavedInput: false });
  assert.match(timerOnly, /rest timer is running.*keeps running through the reload/);
  assert.doesNotMatch(timerOnly, /lost/);
  const textOnly = confirmMessage({ timerRunning: false, unsavedInput: true });
  assert.match(textOnly, /not saved yet will be lost/);
  assert.doesNotMatch(textOnly, /timer/);
  const both = confirmMessage({ timerRunning: true, unsavedInput: true });
  assert.match(both, /will be lost/);
  assert.match(both, /keeps running/);
});

test("text counts as unsaved when an input shows something other than what was last saved", () => {
  assert.equal(hasUnsavedInput([]), false);
  assert.equal(hasUnsavedInput([{ value: "8", saved: "8" }, { value: "", saved: "" }]), false);
  assert.equal(hasUnsavedInput([{ value: "8", saved: "8" }, { value: "62", saved: "6" }]), true);
  assert.equal(hasUnsavedInput([{ value: "", saved: "5" }]), true); // cleared but not yet saved
});
