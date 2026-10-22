// The Log tab: current workout, exercise picker and the set form.
// Only builds elements and passes input to the logger. Parsing, validation
// and every decision happen in src/app and src/domain.

import { h, button } from "./dom.js";
import { MUSCLES, EQUIPMENT, WEIGHT_UNITS, NAME_MAX_LENGTH } from "../domain/model.js";
import { formatLabel, formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";

export const freshLogState = () => ({
  exerciseId: null,
  pickerOpen: false,
  addingCustom: false,
  query: "",
  formUnit: null,
  error: null,
  notice: null,
  confirmDiscard: false,
  confirmDeleteSetId: null,
});

// Runs an action; a failure becomes the message shown at the top of the view.
async function perform(ctx, action) {
  try {
    await action();
    ctx.state.log.error = null;
  } catch (error) {
    ctx.state.log.error = error.message;
  }
  await ctx.rerender();
}

const countSets = (workout) => workout.entries.reduce((total, entry) => total + entry.sets.length, 0);

function setLine(set, index, unit) {
  return `${index + 1}. ${formatCount(set.reps, "rep")} · ${formatSetWeight(set.weightValue, set.weightUnit, unit)}`;
}

function deleteControl(ctx, set, exerciseName, index) {
  const log = ctx.state.log;
  if (log.confirmDeleteSetId === set.id) {
    return h(
      "span",
      { class: "inline-confirm" },
      "Delete this set?",
      button("Delete", {
        class: "danger small",
        "data-action": "confirm-delete-set",
        onClick: () => perform(ctx, async () => {
          log.confirmDeleteSetId = null;
          await ctx.services.logger.deleteSet(set.id);
        }),
      }),
      button("Keep", {
        class: "small",
        "data-action": "keep-set",
        onClick: () => {
          log.confirmDeleteSetId = null;
          return ctx.rerender();
        },
      }),
    );
  }
  return button("Delete", {
    class: "small",
    "data-action": "delete-set",
    "aria-label": `Delete set ${index + 1} of ${exerciseName}`,
    onClick: () => {
      log.confirmDeleteSetId = set.id;
      return ctx.rerender();
    },
  });
}

function entriesList(ctx, entries, editable) {
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
          h("span", { class: "set-text" }, setLine(set, index, ctx.unit)),
          editable ? deleteControl(ctx, set, entry.exerciseName, index) : null,
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
        Object.assign(log, { confirmDiscard: false, exerciseId: null, notice: "Workout discarded." });
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

function staleCard(ctx, current) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const workout = current.workout;
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
    entriesList(ctx, workout.entries, false),
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
        await logger.finishWorkout();
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

function currentCard(ctx, current) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const card = h("section", { class: "card", "aria-label": "Current workout" }, h("h2", {}, "Current workout"));
  if (current.status.kind === "none") {
    card.append(h("p", { class: "muted" }, "No workout in progress. Logging your first set starts one."));
    return card;
  }
  const workout = current.workout;
  const setCount = countSets(workout);
  card.append(h("p", { class: "muted" }, `Started ${formatDateTime(workout.startedAt)} · ${formatCount(setCount, "set")}`));
  if (setCount === 0) card.append(h("p", { class: "muted" }, "No sets yet."));
  card.append(entriesList(ctx, workout.entries, true));
  if (log.confirmDiscard) {
    card.append(discardConfirm(ctx, setCount));
    return card;
  }
  card.append(h(
    "div",
    { class: "actions" },
    button("Finish workout", {
      class: "primary",
      "data-action": "finish",
      disabled: setCount === 0,
      onClick: () => perform(ctx, async () => {
        await logger.finishWorkout();
        Object.assign(log, { exerciseId: null, notice: "Workout finished. It is in History." });
      }),
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
    type: "text", "data-field": "custom-name", maxlength: NAME_MAX_LENGTH, autocomplete: "off",
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
          Object.assign(log, {
            exerciseId: saved.id, pickerOpen: false, addingCustom: false, formUnit: null,
            notice: `Added "${saved.name}".`, error: null,
          });
          ctx.state.focus = '[data-field="reps"]';
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
            onClick: () => {
              Object.assign(log, { exerciseId: exercise.id, pickerOpen: false, formUnit: null, query: "", error: null });
              ctx.state.focus = '[data-field="reps"]';
              return ctx.rerender();
            },
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
      log.exerciseId
        ? button("Cancel", {
          "data-action": "cancel-picker",
          onClick: () => {
            log.pickerOpen = false;
            return ctx.rerender();
          },
        })
        : null,
    ));
  }
  return panel;
}

async function setForm(ctx, exercise) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const suggestion = await logger.suggestNextSet(exercise.id);
  const formUnit = log.formUnit ?? (suggestion ? suggestion.weightUnit : ctx.unit);

  const reps = h("input", {
    type: "text", inputmode: "numeric", autocomplete: "off", "data-field": "reps",
    value: suggestion ? String(suggestion.reps) : "",
  });
  const weight = h("input", {
    type: "text", inputmode: "decimal", autocomplete: "off", "data-field": "weight",
    "aria-describedby": "weight-help", value: suggestion ? String(suggestion.weightValue) : "",
  });
  const unit = h(
    "select",
    { "data-field": "unit", "aria-label": "Weight unit" },
    WEIGHT_UNITS.map((value) => h("option", { value, selected: value === formUnit }, value)),
  );
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "set-error" });
  const submit = h("button", { type: "submit", class: "primary", "data-action": "log-set" }, "Log set");

  return h(
    "form",
    {
      class: "card set-form",
      "aria-label": "Log a set",
      onSubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          await logger.logSet({
            exerciseId: exercise.id, reps: reps.value, weight: weight.value, weightUnit: unit.value,
          });
          Object.assign(log, { formUnit: unit.value, error: null, notice: "Set logged." });
          ctx.state.focus = '[data-field="reps"]';
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h("h2", {}, exercise.name),
    button("Change exercise", {
      class: "small",
      "data-action": "change-exercise",
      onClick: () => {
        log.pickerOpen = true;
        return ctx.rerender();
      },
    }),
    h("label", { class: "field" }, h("span", {}, "Reps"), reps),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field" }, h("span", {}, "Weight"), weight),
      h("label", { class: "field narrow" }, h("span", {}, "Unit"), unit),
    ),
    h("p", { class: "muted", id: "weight-help" }, "Enter 0 for bodyweight. Leave nothing blank."),
    error,
    submit,
  );
}

async function logArea(ctx) {
  const log = ctx.state.log;
  if (log.pickerOpen || !log.exerciseId) {
    if (!log.pickerOpen && !log.exerciseId) {
      return button("Choose exercise", {
        class: "primary wide",
        "data-action": "choose-exercise",
        onClick: () => {
          log.pickerOpen = true;
          return ctx.rerender();
        },
      });
    }
    return picker(ctx);
  }
  const exercise = (await ctx.services.logger.findExercises("")).find((candidate) => candidate.id === log.exerciseId);
  if (exercise === undefined) {
    log.exerciseId = null;
    return logArea(ctx);
  }
  return setForm(ctx, exercise);
}

export async function renderLogView(ctx) {
  const log = ctx.state.log;
  const current = await ctx.services.logger.getCurrent();
  const view = h("section", { class: "view", "aria-label": "Log" });

  if (log.notice) {
    view.append(h("p", { class: "notice", role: "status", "data-region": "notice" }, log.notice));
    log.notice = null;
  }
  if (log.error) {
    view.append(h("p", { class: "error", role: "alert", "data-region": "view-error" }, log.error));
    log.error = null;
  }

  if (current.status.kind === "stale") {
    view.append(staleCard(ctx, current));
    return view;
  }
  view.append(currentCard(ctx, current));
  view.append(await logArea(ctx));
  return view;
}
