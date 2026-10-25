// The Settings tab: the kg/lb display unit, which is a stored preference (meta key
// preferredUnit, via the logger; choosing one changes only how weights are shown,
// never what is stored), then the Backup section (backup-view.js).

import { h, button } from "./dom.js";
import { WEIGHT_UNITS } from "../domain/model.js";
import { renderBackupView } from "./backup-view.js";

export async function renderSettingsView(ctx) {
  const { state, services } = ctx;
  const unitButtons = WEIGHT_UNITS.map((unit) => button(unit, {
    class: "unit-button",
    "aria-pressed": String(unit === ctx.unit),
    "data-action": "set-unit",
    "data-unit": unit,
    onClick: async () => {
      state.unit = await services.logger.setPreferredUnit(unit);
      state.log.formUnit = null;
      state.focus = `[data-action="set-unit"][data-unit="${unit}"]`; // the view is rebuilt below
      await ctx.rerender();
    },
  }));
  // A failure in the Backup section must not take the unit toggle down with it.
  let backupSection;
  try {
    backupSection = await renderBackupView(ctx);
  } catch (error) {
    backupSection = h("p", { class: "error", role: "alert" }, `The Backup section could not be shown: ${error.message}`);
  }
  return h(
    "section",
    { class: "view", "aria-label": "Settings" },
    h(
      "div",
      { class: "card", "aria-label": "Weight unit" },
      h("h2", {}, "Weight unit"),
      h("p", { class: "muted" }, "Sets how weights are shown. Weights are stored as you entered them and never change."),
      h("div", { class: "units", role: "group", "aria-label": "Display unit" }, unitButtons),
    ),
    h("h2", { tabindex: "-1", "data-region": "backup-heading", class: "section-divider" }, "Backup"),
    backupSection,
  );
}
