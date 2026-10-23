// The Log tab: the session's exercises with their set rows, the exercise picker
// and the workout actions. Only builds elements and passes input to the logger.
// Parsing, validation and every decision happen in src/app and src/domain.

import { h, button } from "./dom.js";
import { MUSCLES, EQUIPMENT, NAME_MAX_LENGTH } from "../domain/model.js";
import { formatLabel, formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";
import { isRunning } from "../domain/rest-timer.js";
import { exerciseBlocks, startTicker, stopTicker, perform } from "./set-rows.js";

export const freshLogState = () => ({
  pickerOpen: false,
  addingCustom: false,
  query: "",
  error: null,
  notice: null,
  confirmDiscard: false,
  confirmFinish: false,
  confirmDeleteSetId: null,
  editingRestId: null,
  menuExerciseId: null,
  editingDefaultFor: null,
  seen: null, // the rows of the last drawing, so only what changed animates
  stopTicker: null,
});

const countSets = (workout) => workout.entries.reduce((total, entry) => total + entry.sets.length, 0);

// A read-only list of the logged sets (the unfinished workout that must be resolved first).
function loggedList(ctx, entries) {
  return h(
    "div",
    { class: "entries" },
    entries.map((entry) => h(
      "div",
      { class: "entry" },
      h("h3", {}, entry.exerciseName),
      h(
        "ol",
        { class: "sets" },
        entry.sets.map((set, index) => h(
          "li",
          { "data-set-id": set.id },
          h(
            "span",
            { class: "set-text" },
            `${index + 1}. ${formatCount(set.reps, "rep")} · ${formatSetWeight(set.weightValue, set.weightUnit, ctx.unit)}`,
          ),
        )),
      ),
    )),
  );
}

function discardConfirm(ctx, setCount) {
  const log = ctx.state.log;
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm discard" },
    h("p", {}, `Discard this workout and its ${formatCount(setCount, "set")}? This cannot be undone.`),
    button("Discard workout", {
      class: "danger",
      "data-action": "confirm-discard",
      onClick: () => perform(ctx, async () => {
        await ctx.services.logger.discardWorkout();
        Object.assign(log, { confirmDiscard: false, notice: "Workout discarded." });
      }),
    }),
    button("Keep workout", {
      "data-action": "keep-workout",
      onClick: () => {
        log.confirmDiscard = false;
        return ctx.rerender();
      },
    }),
  );
}

function finishConfirm(ctx, plannedCount) {
  const log = ctx.state.log;
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm finish", "data-region": "confirm-finish" },
    h("p", {}, `Finish this workout? ${formatCount(plannedCount, "unchecked set")} will be removed. Only checked sets are kept.`),
    button("Finish and remove them", {
      class: "primary",
      "data-action": "confirm-finish",
      onClick: () => perform(ctx, async () => {
        await ctx.services.logger.finishWorkout({ removeUnchecked: true });
        Object.assign(log, { confirmFinish: false, notice: "Workout finished. It is in History." });
      }),
    }),
    button("Keep going", {
      "data-action": "cancel-finish",
      onClick: () => {
        log.confirmFinish = false;
        return ctx.rerender();
      },
    }),
  );
}

function staleCard(ctx, session) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const workout = session.workout;
  const setCount = countSets(workout);
  const card = h(
    "section",
    { class: "card warning", "data-region": "stale-workout", "aria-label": "Unfinished workout" },
    h("h2", {}, `Unfinished workout from ${formatDateTime(workout.startedAt)}`),
    h(
      "p",
      {},
      `It has ${formatCount(setCount, "set")} logged. Choose what to do with it before logging anything new.`,
    ),
    loggedList(ctx, workout.entries),
  );
  if (log.confirmDiscard) {
    card.append(discardConfirm(ctx, setCount));
    return card;
  }
  card.append(h(
    "div",
    { class: "actions" },
    button("Continue", {
      class: "primary",
      "data-action": "continue-stale",
      onClick: () => perform(ctx, () => logger.continueWorkout()),
    }),
    button("Finish", {
      "data-action": "finish-stale",
      disabled: setCount === 0,
      onClick: () => perform(ctx, async () => {
        await logger.finishWorkout({ removeUnchecked: true }); // a stale workout's unchecked sets are not kept
        log.notice = "Workout finished. It is in History.";
      }),
    }),
    button("Discard", {
      class: "danger-outline",
      "data-action": "discard-stale",
      onClick: () => {
        log.confirmDiscard = true;
        return ctx.rerender();
      },
    }),
  ));
  return card;
}

function currentCard(ctx, session) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const card = h("section", { class: "card", "aria-label": "Current workout" }, h("h2", {}, "Current workout"));
  const started = session.status.kind !== "none";
  if (!started) {
    card.append(h("p", { class: "muted" }, "No workout in progress. Checking your first set starts one."));
  } else {
    card.append(h(
      "p",
      { class: "muted" },
      `Started ${formatDateTime(session.workout.startedAt)} · ${formatCount(session.loggedCount, "set")}`,
    ));
    if (session.loggedCount === 0 && session.plannedCount === 0) card.append(h("p", { class: "muted" }, "No sets yet."));
  }
  card.append(exerciseBlocks(ctx, session.blocks));
  if (!started) return card;

  if (log.confirmDiscard) {
    card.append(discardConfirm(ctx, session.loggedCount));
    return card;
  }
  if (log.confirmFinish && session.plannedCount > 0) {
    card.append(finishConfirm(ctx, session.plannedCount));
    return card;
  }
  card.append(h(
    "div",
    { class: "actions" },
    button("Finish workout", {
      class: "primary",
      "data-action": "finish",
      disabled: session.loggedCount === 0,
      onClick: () => {
        if (session.plannedCount > 0) {
          log.confirmFinish = true;
          return ctx.rerender();
        }
        return perform(ctx, async () => {
          await logger.finishWorkout();
          log.notice = "Workout finished. It is in History.";
        });
      },
    }),
    button("Discard workout", {
      class: "danger-outline",
      "data-action": "discard",
      onClick: () => {
        log.confirmDiscard = true;
        return ctx.rerender();
      },
    }),
  ));
  return card;
}

// A group of checkboxes; selected() returns the ticked values.
function checkboxGroup(legend, values, group) {
  const inputs = values.map((value) => h("input", { type: "checkbox", value, "data-group": group }));
  const element = h(
    "fieldset",
    { class: "checks" },
    h("legend", {}, legend),
    values.map((value, index) => h("label", { class: "check" }, inputs[index], formatLabel(value))),
  );
  return { element, selected: () => inputs.filter((input) => input.checked).map((input) => input.value) };
}

function customForm(ctx) {
  const log = ctx.state.log;
  const name = h("input", {
    type: "text", "data-field": "custom-name", "data-saved": "", maxlength: NAME_MAX_LENGTH, autocomplete: "off",
  });
  const primary = checkboxGroup("Primary muscles (at least one)", MUSCLES, "primary");
  const secondary = checkboxGroup("Secondary muscles", MUSCLES, "secondary");
  const equipment = checkboxGroup("Equipment", EQUIPMENT, "equipment");
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "custom-error" });
  const form = h(
    "form",
    {
      class: "custom-form",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          const saved = await ctx.services.logger.addCustomExercise({
            name: name.value,
            primaryMuscles: primary.selected(),
            secondaryMuscles: secondary.selected(),
            equipmentTags: equipment.selected(),
          });
          await ctx.services.logger.addSet(saved.id);
          Object.assign(log, { pickerOpen: false, addingCustom: false, notice: `Added "${saved.name}".`, error: null });
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    h("h3", {}, "Add custom exercise"),
    h("label", { class: "field" }, h("span", {}, "Name"), name),
    primary.element,
    secondary.element,
    equipment.element,
    error,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", class: "primary", "data-action": "save-custom" }, "Save exercise"),
      button("Cancel", {
        "data-action": "cancel-custom",
        onClick: () => {
          log.addingCustom = false;
          return ctx.rerender();
        },
      }),
    ),
  );
  return form;
}

function picker(ctx) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const search = h("input", {
    type: "search",
    "data-field": "search",
    "aria-label": "Search exercises",
    placeholder: "Search by name, muscle or equipment",
    autocomplete: "off",
    value: log.query,
  });
  const list = h("ul", { class: "pick-list", "data-region": "exercise-list" });

  let latest = 0;
  async function refreshList() {
    const mine = ++latest;
    const results = await logger.findExercises(search.value);
    if (mine !== latest) return; // a newer search is already on its way
    log.query = search.value;
    list.replaceChildren(...(results.length === 0
      ? [h("li", { class: "muted" }, "No exercises match.")]
      : results.map((exercise) => h(
        "li",
        {},
        button(
          [
            h("span", { class: "pick-name" }, exercise.name),
            h(
              "span",
              { class: "pick-meta" },
              [...exercise.primaryMuscles.map(formatLabel), exercise.isCustom ? "Custom" : null].filter(Boolean).join(" · "),
            ),
          ],
          {
            class: "pick",
            "data-action": "pick-exercise",
            "data-exercise-id": exercise.id,
            onClick: () => perform(ctx, async () => {
              await logger.addSet(exercise.id); // the exercise joins the session with one unchecked row
              Object.assign(log, { pickerOpen: false, query: "" });
            }),
          },
        ),
      ))));
  }
  search.addEventListener("input", refreshList);
  refreshList();

  const panel = h(
    "section",
    { class: "card", "aria-label": "Choose exercise" },
    h("h2", {}, "Choose exercise"),
    search,
    list,
  );
  if (log.addingCustom) {
    panel.append(customForm(ctx));
  } else {
    panel.append(h(
      "div",
      { class: "actions" },
      button("Add custom exercise", {
        "data-action": "add-custom",
        onClick: () => {
          log.addingCustom = true;
          return ctx.rerender();
        },
      }),
      button("Cancel", {
        "data-action": "cancel-picker",
        onClick: () => {
          log.pickerOpen = false;
          return ctx.rerender();
        },
      }),
    ));
  }
  return panel;
}

function addExerciseArea(ctx, session) {
  const log = ctx.state.log;
  if (log.pickerOpen) return picker(ctx);
  return button(session.blocks.length === 0 ? "Choose exercise" : "Add exercise", {
    class: "primary wide",
    "data-action": "choose-exercise",
    onClick: () => {
      log.pickerOpen = true;
      return ctx.rerender();
    },
  });
}

export async function renderLogView(ctx) {
  const log = ctx.state.log;
  stopTicker(ctx);
  const session = await ctx.services.logger.getSession();
  const view = h("section", { class: "view", "aria-label": "Log" });

  if (log.notice) {
    view.append(h("p", { class: "notice", role: "status", "data-region": "notice" }, log.notice));
    log.notice = null;
  }
  if (log.error) {
    view.append(h("p", { class: "error", role: "alert", "data-region": "view-error" }, log.error));
    log.error = null;
  }

  if (session.status.kind === "stale") {
    view.append(staleCard(ctx, session));
    return view;
  }
  view.append(currentCard(ctx, session));
  view.append(addExerciseArea(ctx, session));
  // Only a timer that is still running gets a ticker; an expired one is already done.
  if (session.timer !== null && isRunning(session.timer, session.nowMs)) startTicker(ctx, view, session.timer);
  return view;
}
