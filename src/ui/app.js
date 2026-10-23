// Mounts the app into `root`. The services are passed in, so the same UI runs
// against the real database and, in the browser tests, against a test one:
//   { logger, backup, downloadBlob, readFileAsText, requestPersistentStorage, offline }
// `offline` (src/app/offline.js) is optional: without it there is no update
// banner and no Offline section.

import { h, button } from "./dom.js";
import { renderLogView, freshLogState } from "./workout-view.js";
import { renderHistoryView, freshHistoryState } from "./history-view.js";
import { renderBackupView, freshBackupState } from "./backup-view.js";
import { WEIGHT_UNITS } from "../domain/model.js";

const TABS = [
  { id: "log", label: "Log", render: renderLogView },
  { id: "history", label: "History", render: renderHistoryView },
  { id: "backup", label: "Backup", render: renderBackupView },
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

  const unitButtons = WEIGHT_UNITS.map((unit) => button(unit, {
    class: "unit-button",
    "data-action": "set-unit",
    "data-unit": unit,
    onClick: async () => {
      state.unit = await services.logger.setPreferredUnit(unit);
      state.log.formUnit = null;
      await render();
    },
  }));
  const tabButtons = TABS.map((tab) => button(tab.label, {
    class: "tab",
    "data-action": "tab",
    "data-tab": tab.id,
    onClick: async () => {
      state.tab = tab.id;
      await render();
    },
  }));
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

  root.replaceChildren(
    h(
      "header",
      { class: "top" },
      h("h1", {}, "GymApp"),
      h("div", { class: "units", role: "group", "aria-label": "Display unit" }, unitButtons),
    ),
    banner,
    h("nav", { class: "tabs", "aria-label": "Sections" }, tabButtons),
    view,
  );

  let latest = 0;
  async function render() {
    const mine = ++latest;
    const context = {
      services,
      state,
      unit: state.unit,
      rerender: render,
      resetAfterImport: () => {
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
    if (mine !== latest) return; // a newer render has taken over
    view.replaceChildren(content);
    tabButtons.forEach((element) => {
      const current = element.dataset.tab === state.tab;
      element.setAttribute("aria-current", current ? "page" : "false");
    });
    unitButtons.forEach((element) => element.setAttribute("aria-pressed", String(element.dataset.unit === state.unit)));
    if (state.focus !== null) {
      const target = view.querySelector(state.focus);
      state.focus = null;
      if (target) target.focus();
    }
  }

  await render();
  return { render, state };
}
