// Mounts the app into `root`. The services are passed in, so the same UI runs
// against the real database and, in the browser tests, against a test one:
//   { logger, backup, downloadBlob, readFileAsText, persistence, offline }
// `persistence` is { getStatus(), check() } (src/app/persistence.js); without it the
// Storage card shows no status and no button.
// `offline` (src/app/offline.js) is optional: without it there is no update
// banner and no Offline section.

import { h, button } from "./dom.js";
import { renderLogView, freshLogState } from "./workout-view.js";
import { renderHistoryView, freshHistoryState } from "./history-view.js";
import { freshBackupState } from "./backup-view.js";
import { renderBodyView } from "./body-view.js";
import { renderSettingsView } from "./settings-view.js";
import { isReminderDue, REMINDER_SNOOZE_DAYS } from "../domain/backup-reminder.js";

const TABS = [
  { id: "log", label: "New", render: renderLogView },
  { id: "history", label: "History", render: renderHistoryView },
  { id: "body", label: "Body", render: renderBodyView },
  { id: "settings", label: "Settings", render: renderSettingsView },
];

export async function mountApp(root, services) {
  const state = {
    tab: "log",
    unit: await services.logger.getPreferredUnit(),
    focus: null,
    log: freshLogState(),
    history: freshHistoryState(),
    backup: freshBackupState(),
  };

  // The one way to change tab (the tab buttons and the reminder's button), so that every change fades in.
  async function selectTab(id) {
    if (state.tab !== id) {
      state.log.seen = null; // a new screen: its rows do not animate one by one
      state.enter = true; // the new tab fades in, once
    }
    state.tab = id;
    tabBar.dataset.active = id; // the bar slides now, not when the render finishes
    await render();
  }

  const tabButtons = TABS.map((tab) => button(tab.label, {
    class: "tab",
    "data-action": "tab",
    "data-tab": tab.id,
    onClick: () => selectTab(tab.id),
  }));
  const tabBar = h("nav", { class: "tabs", "aria-label": "Sections", "data-active": state.tab }, tabButtons);
  const view = h("main", { id: "view", tabindex: "-1" });

  // The update banner. It appears only when a new version is waiting (or this
  // tab is running older code after another tab updated), and the only thing
  // that activates the new version is the click on its Reload button.
  const banner = h("div", { class: "banner", role: "status", hidden: true, "data-region": "update-banner" });
  function showBanner(offlineState) {
    if (offlineState.updateAvailable) {
      const problem = h("span", { class: "banner-error", role: "alert", hidden: true });
      banner.replaceChildren(
        h("span", {}, "Update available. Reloading switches to the new version; your workouts are not changed."),
        button("Reload", {
          class: "small primary",
          "data-action": "apply-update",
          onClick: async () => {
            problem.hidden = true;
            try {
              await services.offline.applyUpdate();
            } catch (error) {
              problem.textContent = error.message;
              problem.hidden = false;
            }
          },
        }),
        problem,
      );
      banner.hidden = false;
    } else if (offlineState.updatedElsewhere) {
      banner.replaceChildren(
        h("span", {}, "The app was updated in another tab. Reload this tab to use the new version."),
        button("Reload", { class: "small primary", "data-action": "reload-app", onClick: () => services.offline.reload() }),
      );
      banner.hidden = false;
    } else {
      banner.replaceChildren();
      banner.hidden = true;
    }
  }
  if (services.offline) {
    services.offline.onChange(showBanner);
    showBanner(services.offline.getState());
  }

  // The backup reminder. Shown on every tab while it is due; hidden when the
  // rule (src/domain/backup-reminder.js) says so, or after a dismissal.
  const reminder = h("div", { class: "banner", role: "status", hidden: true, "data-region": "backup-reminder" });
  async function refreshReminder() {
    const inputs = await services.backup.getReminderInputs();
    const due = isReminderDue({ now: new Date(), ...inputs });
    reminder.hidden = !due;
    if (!due) {
      reminder.replaceChildren();
      return;
    }
    const message = inputs.lastExportAt === null
      ? "You have logged workouts but never confirmed a backup. Export one and tap \"I saved the file\"."
      : "Your last confirmed backup is more than 14 days old. Export again and tap \"I saved the file\".";
    reminder.replaceChildren(
      h("span", {}, message),
      button("Go to Backup", {
        class: "small primary",
        "data-action": "reminder-backup",
        onClick: () => {
          state.focus = '[data-region="backup-heading"]'; // the Backup section is in Settings
          return selectTab("settings");
        },
      }),
      button(`Dismiss (back in ${REMINDER_SNOOZE_DAYS} days)`, {
        class: "small",
        "data-action": "reminder-dismiss",
        onClick: async () => {
          await services.backup.dismissReminder(new Date());
          await render();
        },
      }),
    );
  }

  root.replaceChildren(
    h(
      "header",
      { class: "top" },
      h("h1", {}, "Apogee"),
    ),
    banner,
    reminder,
    tabBar,
    view,
  );

  // Every render in flight, so a caller (a test, mostly) can wait until the UI
  // has finished reading from the database before the database is closed.
  const inFlight = new Set();
  function render() {
    if (waiting !== null) {
      clearInterval(waiting); // this drawing is the one a waiting background redraw was for
      waiting = null;
    }
    const running = renderNow();
    inFlight.add(running);
    running.finally(() => inFlight.delete(running)).catch(() => {});
    return running;
  }
  // A redraw nobody asked for (a timer running out, the storage answer arriving) must never
  // replace a field being typed in or discard unsaved text. While one exists it waits, and
  // draws when the person has left the field and what they typed is saved.
  function typingInView() {
    const active = document.activeElement;
    if (active !== null && view.contains(active) && active.matches("input, textarea, select")) return true;
    if (view.querySelector(".custom-form") !== null) return true; // its ticked boxes are not saved anywhere
    return [...view.querySelectorAll("input[data-saved], textarea[data-saved]")].some((el) => el.value !== el.dataset.saved);
  }
  let waiting = null;
  function renderInBackground() {
    if (!typingInView()) return render();
    if (waiting === null) {
      waiting = setInterval(() => {
        if (!view.isConnected) {
          clearInterval(waiting);
          waiting = null;
        } else if (!typingInView()) render(); // render() ends the wait
      }, 250);
    }
    return Promise.resolve();
  }
  async function idle() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  let latest = 0;
  let carriedFrom = 0; // the superseded render that handed its focus request back to state.focus, for a newer render still in flight
  async function renderNow() {
    const mine = ++latest;
    // A render owns the focus request that existed when it started. An older render still waiting on the
    // reminder must not take a request made after that (its view is about to be replaced).
    const focus = state.focus;
    state.focus = null;
    carriedFrom = 0;
    const context = {
      services,
      state,
      unit: state.unit,
      rerender: render,
      rerenderInBackground: renderInBackground,
      // The import itself already removed the planned sets and the running timer
      // (in its own transaction); this resets what the screens remember.
      resetAfterImport: () => {
        if (typeof state.log.stopTicker === "function") state.log.stopTicker();
        if (typeof state.log.stopElapsed === "function") state.log.stopElapsed();
        state.log = freshLogState();
        state.history = freshHistoryState();
      },
    };
    let content;
    try {
      content = await TABS.find((tab) => tab.id === state.tab).render(context);
    } catch (error) {
      content = h("p", { class: "error", role: "alert" }, `Something went wrong: ${error.message}`);
    }
    if (mine !== latest) { // a newer render has taken over
      if (focus !== null && state.focus === null) { // pass the request on unless a newer one was made meanwhile
        state.focus = focus;
        carriedFrom = mine;
      }
      return;
    }
    if (state.tab !== "log" && typeof state.log.stopElapsed === "function") state.log.stopElapsed(); // the clock runs only on the Log tab
    if (state.enter) {
      content.dataset.anim = "tab"; // see the motion block in app.css
      state.enter = false;
    } else {
      // A panel or form fades in only if it is new: its key (data-enter) was not on screen in the drawing
      // being replaced. A redraw with it still open leaves it unmarked, so it does not replay.
      const shown = new Set([...view.querySelectorAll("[data-enter]")].map((element) => element.dataset.enter));
      for (const element of content.querySelectorAll("[data-enter]")) {
        if (!shown.has(element.dataset.enter)) element.dataset.anim = "in";
      }
    }
    view.replaceChildren(content);
    // A failed read only hides the reminder; it never blocks the tab.
    await refreshReminder().catch(() => { reminder.hidden = true; });
    tabBar.dataset.active = state.tab; // converge on state.tab even if a tap was superseded
    tabButtons.forEach((element) => {
      const current = element.dataset.tab === state.tab;
      element.setAttribute("aria-current", current ? "page" : "false");
    });
    const wanted = focus ?? (carriedFrom !== 0 && carriedFrom < mine ? state.focus : null);
    if (wanted !== null) {
      state.focus = null;
      carriedFrom = 0;
      const target = view.querySelector(wanted);
      if (target) target.focus();
    }
  }

  await render();
  return { render, renderInBackground, state, idle };
}
