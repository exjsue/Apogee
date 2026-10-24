// The Settings tab. For now it holds the kg/lb display unit, which is a stored
// preference (meta key preferredUnit, via the logger); choosing one changes only
// how weights are shown, never what is stored.

import { h, button } from "./dom.js";
import { WEIGHT_UNITS } from "../domain/model.js";

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
  );
}
