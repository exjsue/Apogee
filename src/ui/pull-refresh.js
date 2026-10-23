// Pull-to-refresh for the installed app: pull down at the very top of the page,
// let go past the threshold, and the app looks for a new version (the same check
// as the Update available banner uses) and offers the same guarded update.
//
// This file only reads touch events and the page and shows messages. Every rule
// (when a pull counts, what happens after the check, when to ask first) is in
// src/domain/pull-gesture.js. Rules kept here:
//   - The touch listeners are passive and never call preventDefault, so scrolling,
//     taps and typing in the inputs behave exactly as without this.
//   - It never reloads unless the check found a new version (or this tab is already
//     behind another that updated). "Up to date" is a message, not a reload.
//   - If a rest timer is running or an input holds text that is not saved yet, the
//     reload waits for a tap on "Reload now".
//   - The only update action is offline.applyUpdate(), the one the Reload button uses.

import { h, button } from "./dom.js";
import { isRunning } from "../domain/rest-timer.js";
import {
  isTextEntryElement, isBlocked, canStartPull, startPull, movePull, endPull, pullLevel,
  afterCheck, hasUnsavedInput, confirmationNeeded, confirmMessage,
} from "../domain/pull-gesture.js";

const MESSAGE_MS = 2200;

const TEXT = {
  pulling: "Pull to check for updates",
  armed: "Release to check for updates",
  checking: "Checking for updates…",
  "up-to-date": "Up to date",
  installing: "An update is downloading. The Reload button appears when it is ready.",
  unreachable: "Couldn't check for updates. Are you offline?",
  off: "Update checking is switched off on this address",
  later: "Update ready. Tap Reload when you are ready.",
};

export function installPullToRefresh({
  offline,
  logger,
  document = globalThis.document,
  host = document.body,
  getScrollTop = () => (document.scrollingElement ? document.scrollingElement.scrollTop : 0),
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
} = {}) {
  const label = h("span", { class: "pull-text" });
  const indicator = h("div", { class: "pull-indicator", role: "status", "aria-live": "polite", hidden: true, "data-level": "0" }, label);
  host.append(indicator);

  let gesture = null;
  let busy = false;
  let messageTimer = null;

  function show(text, level) {
    if (messageTimer !== null) {
      timers.clearTimeout(messageTimer);
      messageTimer = null;
    }
    label.textContent = text;
    indicator.dataset.level = String(level);
    indicator.hidden = false;
  }
  function hide() {
    indicator.hidden = true;
    indicator.dataset.level = "0";
  }
  function flash(text) {
    show(text, 4);
    messageTimer = timers.setTimeout(() => {
      messageTimer = null;
      hide();
    }, MESSAGE_MS);
  }

  // Typing, a menu or a dialog being open: no pull starts or continues.
  function blockedNow() {
    return isBlocked({
      inputFocused: isTextEntryElement(document.activeElement),
      menuOpen: document.querySelector('[role="menu"]') !== null,
      dialogOpen: document.querySelector('[role="alertdialog"], [role="dialog"]') !== null,
    });
  }

  function onStart(event) {
    gesture = null;
    if (busy) return;
    const touches = event.touches ?? [];
    if (!canStartPull({ scrollTop: getScrollTop(), touchCount: touches.length, blocked: blockedNow() })) return;
    gesture = startPull({ x: touches[0].clientX, y: touches[0].clientY });
  }

  function onMove(event) {
    if (gesture === null) return;
    const touches = event.touches ?? [];
    const first = touches[0] ?? { clientX: 0, clientY: 0 };
    const result = movePull(gesture, {
      x: first.clientX, y: first.clientY, scrollTop: getScrollTop(), touchCount: touches.length, blocked: blockedNow(),
    });
    gesture = result.gesture;
    if (result.phase === "cancelled") {
      gesture = null;
      hide();
    } else if (result.phase === "idle") {
      hide();
    } else {
      show(result.phase === "armed" ? TEXT.armed : TEXT.pulling, pullLevel(result.distance));
    }
  }

  function onEnd() {
    const finished = gesture;
    gesture = null;
    if (finished === null) return;
    hide();
    if (endPull(finished) === "refresh") run();
  }

  function onCancel() {
    gesture = null;
    hide();
  }

  // The question asked when a reload would lose or interrupt something.
  function confirmReload(message) {
    return new Promise((resolve) => {
      const box = h(
        "div",
        { class: "banner pull-confirm", role: "alertdialog", "aria-label": "Confirm reload", "data-region": "pull-confirm" },
        h("span", {}, message),
        button("Reload now", { class: "small primary", "data-action": "pull-confirm-reload", onClick: () => finish(true) }),
        button("Not now", { class: "small", "data-action": "pull-cancel-reload", onClick: () => finish(false) }),
      );
      function finish(answer) {
        box.remove();
        resolve(answer);
      }
      host.prepend(box);
    });
  }

  // What a reload would lose or interrupt, read at the moment of release.
  async function readRisk() {
    let timerRunning = false;
    try {
      const session = await logger.getSession();
      timerRunning = session.timer !== null && isRunning(session.timer, session.nowMs);
    } catch {
      timerRunning = false;
    }
    const fields = [...document.querySelectorAll("input[data-saved], textarea[data-saved]")]
      .map((element) => ({ value: element.value, saved: element.dataset.saved }));
    return { timerRunning, unsavedInput: hasUnsavedInput(fields) };
  }

  async function run() {
    busy = true;
    try {
      show(TEXT.checking, 4);
      const decision = afterCheck(await offline.checkNow());
      if (decision !== "apply" && decision !== "reload") {
        flash(TEXT[decision]);
        return;
      }
      const risk = await readRisk();
      if (confirmationNeeded(risk)) {
        hide();
        if (!(await confirmReload(confirmMessage(risk)))) {
          flash(TEXT.later);
          return;
        }
      }
      hide();
      if (decision === "apply") await offline.applyUpdate(); // reloads by itself once the new version has taken over
      else offline.reload();
    } catch (error) {
      flash(error.message);
    } finally {
      busy = false;
    }
  }

  const passive = { passive: true };
  document.addEventListener("touchstart", onStart, passive);
  document.addEventListener("touchmove", onMove, passive);
  document.addEventListener("touchend", onEnd, passive);
  document.addEventListener("touchcancel", onCancel, passive);

  return {
    uninstall() {
      document.removeEventListener("touchstart", onStart, passive);
      document.removeEventListener("touchmove", onMove, passive);
      document.removeEventListener("touchend", onEnd, passive);
      document.removeEventListener("touchcancel", onCancel, passive);
      indicator.remove();
    },
  };
}
