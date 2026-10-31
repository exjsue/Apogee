// The Settings tab: the kg/lb display unit, which is a stored preference (meta key
// preferredUnit, via the logger; choosing one changes only how weights are shown,
// never what is stored), the user's hidden exercises, the Strong import (strong-view.js), then the Backup section
// (backup-view.js).

import { h, button } from "./dom.js";
import { WEIGHT_UNITS } from "../domain/model.js";
import { renderBackupView } from "./backup-view.js";
import { renderStrongImport } from "./strong-view.js";

const HEADING = '[data-region="hidden-exercises-heading"]';

// Hidden exercises: each can be shown again, and one that nothing uses any more can be deleted for good, after a
// question. removeCustomExercise decides again when it writes, and the notice reports what it did.
async function hiddenExercisesSection(ctx) {
  const { logger } = ctx.services;
  const view = (ctx.state.hiddenExercises ??= { confirmDeleteId: null, notice: null, error: null });
  const hidden = await logger.listHiddenCustomExercises();
  const usages = await Promise.all(hidden.map((exercise) => logger.getExerciseUsage(exercise.id)));

  // Runs an action, then shows its notice (or its error) and puts focus on `focus`.
  const act = (run, focus = HEADING) => async () => {
    try {
      view.notice = await run();
      view.error = null;
    } catch (error) {
      Object.assign(view, { notice: null, error: error.message });
    }
    view.confirmDeleteId = null;
    ctx.state.focus = focus;
    await ctx.rerender();
  };

  const item = (exercise, usage) => {
    const forId = (name) => `[data-action="${name}"][data-exercise-id="${exercise.id}"]`;
    const row = h("li", { "data-exercise-id": exercise.id }, h("span", { class: "pick-name" }, exercise.name));
    if (view.confirmDeleteId === exercise.id) {
      row.append(h(
        "div",
        { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete exercise for good", "data-region": "confirm-delete-hidden", "data-enter": `confirm-delete-hidden:${exercise.id}` },
        h("p", {}, `Delete "${exercise.name}" for good? Nothing uses it any more. This cannot be undone.`),
        button("Delete for good", {
          class: "danger",
          "data-action": "confirm-delete-hidden",
          onClick: act(async () => ((await logger.removeCustomExercise(exercise.id)) === "deleted"
            ? `Deleted "${exercise.name}" for good.`
            : `"${exercise.name}" was not deleted: it is in use again, so it stays hidden.`)),
        }),
        button("Keep exercise", {
          "data-action": "cancel-delete-hidden",
          onClick: () => {
            view.confirmDeleteId = null;
            ctx.state.focus = forId("delete-hidden");
            return ctx.rerender();
          },
        }),
      ));
      return row;
    }
    row.append(h(
      "div",
      { class: "actions" },
      button("Show again", {
        class: "small",
        "data-action": "show-hidden",
        "data-exercise-id": exercise.id,
        "aria-label": `Show ${exercise.name} again`,
        onClick: act(async () => {
          await logger.restoreCustomExercise(exercise.id);
          return `"${exercise.name}" is back in the exercise list.`;
        }),
      }),
      usage.used
        ? null
        : button("Delete for good", {
          class: "danger-outline small",
          "data-action": "delete-hidden",
          "data-exercise-id": exercise.id,
          "aria-label": `Delete ${exercise.name} for good`,
          onClick: () => {
            view.confirmDeleteId = exercise.id;
            ctx.state.focus = '[data-action="cancel-delete-hidden"]';
            return ctx.rerender();
          },
        }),
    ));
    return row;
  };

  const notice = view.notice === null ? null : h("p", { class: "notice", role: "status", "data-region": "hidden-notice", "data-enter": `hidden-notice:${view.notice}` }, view.notice);
  const error = view.error === null ? null : h("p", { class: "error", role: "alert", "data-region": "hidden-error" }, view.error);
  Object.assign(view, { notice: null, error: null });
  return h(
    "section",
    { class: "card", "aria-label": "Hidden exercises", "data-region": "hidden-exercises" },
    h("h2", { tabindex: "-1", "data-region": "hidden-exercises-heading" }, "Hidden exercises"),
    notice,
    error,
    hidden.length === 0
      ? h("p", { class: "muted", "data-region": "no-hidden" }, "No hidden exercises.")
      : [
        h("p", { class: "muted" }, "They stay in your history, templates and backups. Show one again to pick it for new workouts."),
        h("ul", { class: "history-list" }, hidden.map((exercise, i) => item(exercise, usages[i]))),
      ],
  );
}

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
  // Nor may a failure in the hidden list.
  let hiddenSection;
  try {
    hiddenSection = await hiddenExercisesSection(ctx);
  } catch (error) {
    hiddenSection = h("p", { class: "error", role: "alert" }, `The hidden exercises could not be shown: ${error.message}`);
  }
  // Nor may a failure in the Strong import (an add-only import, kept apart from Backup's replace-everything one).
  let strongSection;
  try {
    strongSection = renderStrongImport(ctx);
  } catch (error) {
    strongSection = h("p", { class: "error", role: "alert" }, `The Strong import could not be shown: ${error.message}`);
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
    hiddenSection,
    strongSection,
    h("h2", { tabindex: "-1", "data-region": "backup-heading", class: "section-divider" }, "Backup"),
    backupSection,
  );
}
