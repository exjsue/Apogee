// The Log tab: the session's exercises with their set rows, the exercise picker
// and the workout actions. Only builds elements and passes input to the logger.
// Parsing, validation and every decision happen in src/app and src/domain.

import { h, button, exerciseHeading, setMark } from "./dom.js";
import { setNumbers } from "../domain/workout-plan.js";
import { ALL_MUSCLES, ALL_EQUIPMENT, NAME_MAX_LENGTH } from "../domain/model.js";
import { formatLabel, formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";
import { NAME_TAKEN } from "../domain/exercise-names.js";
import { isRunning } from "../domain/rest-timer.js";
import { exerciseBlocks, startTicker, stopTicker, perform } from "./set-rows.js";
import { elapsedElement, startElapsed, stopElapsed } from "./elapsed.js";

// How many rows the picker draws at a time. With the whole exercise library the list has hundreds of rows, and
// drawing all of them on every keystroke is slow; the screen says how many more there are.
const PICKER_PAGE = 50;

export const freshLogState = () => ({
  pickerOpen: false,
  addingCustom: false,
  query: "",
  muscle: "", // the picker's filters: a muscle id or an equipment id, "" for any
  equipment: "",
  limit: PICKER_PAGE, // rows drawn so far; "Show 50 more" raises it, any new search or filter resets it
  pickerMenuId: null, // the custom exercise whose three-dot menu is open in the picker
  editingCustom: null, // the custom exercise record being edited
  confirmRemove: null, // { exercise, usage }: the remove question, worded from the usage read when it opened
  pickerFocus: null, // a selector inside the picker's list, focused once refreshList has drawn the rows
  error: null,
  notice: null,
  restoreOffer: null, // { id, name }: the notice after a hide offers "Show it again"
  confirmDiscard: false,
  confirmFinish: false,
  confirmDeleteSetId: null,
  renamingTemplateId: null,
  confirmDeleteTemplateId: null,
  editingRestId: null,
  editingSetId: null, // the checked set whose edit form is open
  menuExerciseId: null,
  reorderExerciseId: null, // the exercise whose sets show move up / move down buttons
  editingDefaultFor: null,
  seen: null, // the rows of the last drawing, so only what changed animates
  stopTicker: null,
  stopElapsed: null, // stops the elapsed-time clock of the open workout
});

// What closing the picker resets: its menu, edit form, remove question and pending focus.
const closedPicker = () => ({ pickerOpen: false, pickerMenuId: null, editingCustom: null, confirmRemove: null, pickerFocus: null });

const countSets = (workout) => workout.entries.reduce((total, entry) => total + entry.sets.length, 0);

// A read-only list of the logged sets (the unfinished workout that must be resolved first).
function loggedList(ctx, entries) {
  return h(
    "div",
    { class: "entries" },
    entries.map((entry) => {
      const numbers = setNumbers(entry.sets);
      return h(
        "div",
        { class: "entry" },
        exerciseHeading(entry.exerciseName, entry.markCustom),
        h(
          "ol",
          { class: "sets" },
          entry.sets.map((set, index) => h(
            "li",
            { "data-set-id": set.id },
            h(
              "span",
              { class: "set-text" },
              setMark(numbers[index]),
              ` ${formatCount(set.reps, "rep")} · ${formatSetWeight(set.weightValue, set.weightUnit, ctx.unit)}`,
            ),
          )),
        ),
      );
    }),
  );
}

function discardConfirm(ctx, setCount) {
  const log = ctx.state.log;
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm discard", "data-enter": "confirm-discard" },
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
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm finish", "data-region": "confirm-finish", "data-enter": "confirm-finish" },
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
      `It has ${formatCount(workout.setCount, "set")} logged. Choose what to do with it before logging anything new.`,
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
  const card = h("section", { class: "card", "aria-label": "Current workout" });
  const started = session.status.kind !== "none";
  // The title row: with a workout open, the live elapsed time is at its right, an element of its own
  // with a reserved width, so a changing time cannot reflow the row.
  const elapsed = started ? elapsedElement(session.workout.startedAt) : null;
  card.append(h(
    "div",
    { class: "card-head" },
    h("h2", { tabindex: "-1", "data-region": "current-heading" }, "Current workout"), // focus lands here after Start
    elapsed,
  ));
  if (!started) {
    card.append(h("p", { class: "muted" }, "No workout in progress. Checking your first set starts one."));
  } else {
    // Two nowrap pieces, the second with a reserved width, so the line wraps (or not) the same way
    // for "0 sets", "1 set" and "12 sets".
    card.append(h(
      "p",
      { class: "muted started-line", "data-region": "started" },
      h("span", {}, `Started ${formatDateTime(session.workout.startedAt)}`),
      " ",
      h("span", { class: "started-count" }, `· ${formatCount(session.workingCount, "set")}`),
    ));
    card.elapsed = elapsed;
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

// ---- templates: Start, Rename and Delete. Every rule (what Start refuses, the name rule) is in the logger. ----

const selectorFor = (action, id) => `[data-action="${action}"][data-template-id="${id}"]`;

function renameForm(ctx, template, label) {
  const log = ctx.state.log;
  const name = h("input", {
    type: "text", "data-field": "template-name", "data-saved": template.name, autocomplete: "off",
    value: template.name, "aria-label": `New name for ${label}`,
  });
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "template-error" });
  const back = selectorFor("rename-template", template.id);
  return h(
    "form",
    {
      "data-enter": `rename-template:${template.id}`,
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          const saved = await ctx.services.logger.renameTemplate(template.id, name.value);
          log.renamingTemplateId = null;
          log.notice = `Renamed to "${saved.name}".`;
          ctx.state.focus = back;
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    name,
    error,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", class: "primary small", "data-action": "save-rename-template" }, "Save name"),
      button("Cancel", {
        class: "small",
        "data-action": "cancel-rename-template",
        onClick: () => {
          log.renamingTemplateId = null;
          ctx.state.focus = back;
          return ctx.rerender();
        },
      }),
    ),
  );
}

function deleteTemplateConfirm(ctx, template, isLast) {
  const log = ctx.state.log;
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete template", "data-region": "confirm-delete-template", "data-enter": `confirm-delete-template:${template.id}` },
    h("p", {}, `Delete the template "${template.name}"? Your workouts are not affected.`),
    button("Delete template", {
      class: "danger",
      "data-action": "confirm-delete-template",
      onClick: () => perform(ctx, async () => {
        await ctx.services.logger.deleteTemplate(template.id);
        Object.assign(log, { confirmDeleteTemplateId: null, notice: `Deleted the template "${template.name}".` });
        // the section is gone with the last template, so the focus goes to the Current workout heading instead
        ctx.state.focus = isLast ? '[data-region="current-heading"]' : '[data-region="templates-heading"]';
      }),
    }),
    button("Keep template", {
      "data-action": "cancel-delete-template",
      onClick: () => {
        log.confirmDeleteTemplateId = null;
        ctx.state.focus = selectorFor("delete-template", template.id);
        return ctx.rerender();
      },
    }),
  );
}

function templateItem(ctx, template, isLast) {
  const log = ctx.state.log;
  const count = formatCount(template.exercises.length, "exercise");
  const label = `"${template.name}" (${count})`; // the name plus the count tells two templates with one name apart
  const item = h(
    "li",
    {},
    h("span", { class: "pick-name" }, template.name),
    h("span", { class: "pick-meta" }, ` · ${count}`),
  );
  if (log.renamingTemplateId === template.id) {
    item.append(renameForm(ctx, template, label));
    return item;
  }
  if (log.confirmDeleteTemplateId === template.id) {
    item.append(deleteTemplateConfirm(ctx, template, isLast));
    return item;
  }
  item.append(h(
    "div",
    { class: "actions" },
    button("Start", {
      class: "primary small",
      "data-action": "start-template",
      "data-template-id": template.id,
      "aria-label": `Start ${label}`,
      onClick: () => {
        ctx.state.focus = selectorFor("start-template", template.id); // where it stays if Start is refused
        return perform(ctx, async () => {
          await ctx.services.logger.startFromTemplate(template.id);
          log.notice = `Started from "${template.name}". Fill in or check each set as you do it.`;
          ctx.state.focus = '[data-region="current-heading"]';
        });
      },
    }),
    button("Rename", {
      class: "small",
      "data-action": "rename-template",
      "data-template-id": template.id,
      "aria-label": `Rename ${label}`,
      onClick: () => {
        Object.assign(log, { renamingTemplateId: template.id, confirmDeleteTemplateId: null });
        ctx.state.focus = '[data-field="template-name"]';
        return ctx.rerender();
      },
    }),
    button("Delete", {
      class: "danger-outline small",
      "data-action": "delete-template",
      "data-template-id": template.id,
      "aria-label": `Delete ${label}`,
      onClick: () => {
        Object.assign(log, { confirmDeleteTemplateId: template.id, renamingTemplateId: null });
        ctx.state.focus = '[data-action="cancel-delete-template"]';
        return ctx.rerender();
      },
    }),
  ));
  return item;
}

// Only drawn when there is at least one template.
function templatesSection(ctx, templates) {
  return h(
    "section",
    { class: "card", "aria-label": "Templates", "data-region": "templates" },
    h("h2", { tabindex: "-1", "data-region": "templates-heading" }, "Templates"),
    h("ul", { class: "history-list" }, templates.map((template) => templateItem(ctx, template, templates.length === 1))),
  );
}

// A group of checkboxes, `checked` ticked to begin with; selected() returns the ticked values.
function checkboxGroup(legend, values, group, checked = []) {
  const inputs = values.map((value) => h("input", { type: "checkbox", value, "data-group": group, checked: checked.includes(value) }));
  const element = h(
    "fieldset",
    { class: "checks" },
    h("legend", {}, legend),
    values.map((value, index) => h("label", { class: "check" }, inputs[index], formatLabel(value))),
  );
  return { element, selected: () => inputs.filter((input) => input.checked).map((input) => input.value) };
}

// The ids the form offers, plus any the record already has that it does not offer (an id a later model adds and
// an older form does not list, say), so a save never drops one.
const offered = (base, has) => [...base, ...has.filter((id) => !base.includes(id))];

// The selector of a picker row's three-dot button.
const menuButtonFor = (id) => `[data-action="pick-menu"][data-exercise-id="${id}"]`;

// Adding a custom exercise, or with `existing` (a stored custom record) editing one: then it is prefilled, no set
// is added, and a notice says the change reaches past workouts. A name that is one of the user's hidden exercises
// (code NAME_TAKEN with hiddenExerciseId) offers "Show it again" instead of the plain refusal.
function customForm(ctx, existing = null) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const editing = existing !== null;
  const name = h("input", {
    type: "text", "data-field": "custom-name", "data-saved": "", maxlength: NAME_MAX_LENGTH, autocomplete: "off",
    value: editing ? existing.name : undefined,
  });
  const has = (field) => (editing ? existing[field] : []);
  // Every id the model accepts (ALL_MUSCLES, ALL_EQUIPMENT), neck and abductors included.
  const muscles = offered(ALL_MUSCLES, [...has("primaryMuscles"), ...has("secondaryMuscles")]);
  const primary = checkboxGroup("Primary muscles (at least one)", muscles, "primary", has("primaryMuscles"));
  const secondary = checkboxGroup("Secondary muscles", muscles, "secondary", has("secondaryMuscles"));
  const equipment = checkboxGroup("Equipment", offered(ALL_EQUIPMENT, has("equipmentTags")), "equipment", has("equipmentTags"));
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "custom-error" });
  const close = () => Object.assign(log, { addingCustom: false, editingCustom: null });

  // The hidden exercise comes back; when adding, it also joins the session the way Save does.
  const showAgain = (hidden) => button("Show it again", {
    class: "small",
    "data-action": "restore-hidden-name",
    onClick: () => perform(ctx, async () => {
      await logger.restoreCustomExercise(hidden.id);
      close();
      if (editing) {
        log.notice = `"${hidden.name}" is back in the exercise list.`;
        ctx.state.focus = '[data-field="search"]';
      } else {
        await logger.addSet(hidden.id);
        Object.assign(log, { pickerOpen: false, notice: `"${hidden.name}" is back in the exercise list and added.` });
      }
    }),
  });

  async function refuse(caught) {
    const hidden = caught.code === NAME_TAKEN && caught.hiddenExerciseId
      ? (await logger.listHiddenCustomExercises().catch(() => [])).find((exercise) => exercise.id === caught.hiddenExerciseId)
      : undefined;
    if (hidden === undefined) error.replaceChildren(caught.message);
    else error.replaceChildren(`You have a hidden exercise named "${hidden.name}". `, showAgain(hidden));
    error.hidden = false;
  }

  const fields = () => ({
    name: name.value,
    primaryMuscles: primary.selected(),
    secondaryMuscles: secondary.selected(),
    equipmentTags: equipment.selected(),
  });
  const form = h(
    "form",
    {
      class: "custom-form",
      "data-enter": editing ? `edit-custom:${existing.id}` : undefined,
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          if (editing) {
            const saved = await logger.updateCustomExercise(existing.id, fields());
            close();
            Object.assign(log, { notice: `Saved "${saved.name}".`, error: null, pickerFocus: menuButtonFor(saved.id) });
          } else {
            const saved = await logger.addCustomExercise(fields());
            await logger.addSet(saved.id);
            Object.assign(log, { pickerOpen: false, addingCustom: false, notice: `Added "${saved.name}".`, error: null });
          }
          await ctx.rerender();
        } catch (caught) {
          await refuse(caught);
        }
      },
    },
    h("h3", {}, editing ? "Edit exercise" : "Add custom exercise"),
    editing
      ? h(
        "p",
        { class: "muted", "data-region": "edit-custom-notice" },
        "Changes apply everywhere this exercise appears, including past workouts: a new name shows in History, "
        + "and changed muscles change how past sets count on the Body tab.",
      )
      : null,
    h("label", { class: "field" }, h("span", {}, "Name"), name),
    primary.element,
    secondary.element,
    equipment.element,
    error,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", class: "primary", "data-action": editing ? "save-edit-custom" : "save-custom" }, editing ? "Save changes" : "Save exercise"),
      button("Cancel", {
        "data-action": editing ? "cancel-edit-custom" : "cancel-custom",
        onClick: () => {
          if (editing) log.pickerFocus = menuButtonFor(existing.id);
          close();
          return ctx.rerender();
        },
      }),
    ),
  );
  return form;
}

// "3 workouts, 1 template and the current session": what a custom exercise is used by (see getExerciseUsage).
function describeUsage(usage) {
  const parts = [
    usage.workouts > 0 ? formatCount(usage.workouts, "workout") : null,
    usage.templates > 0 ? formatCount(usage.templates, "template") : null,
    usage.planned ? "the current session" : null,
    usage.catalogConflict ? "the exercise library's records" : null,
  ].filter(Boolean);
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// The remove question under a custom row. It says before the tap whether the exercise will be deleted (nothing
// uses it) or hidden. removeCustomExercise decides again when it writes; if that differs, the notice says so.
function removeConfirm(ctx, exercise, usage) {
  const log = ctx.state.log;
  const { logger } = ctx.services;
  const willHide = usage.used;
  const question = willHide
    ? `Hide "${exercise.name}"? It is used in ${describeUsage(usage)}, so it is not deleted. `
      + "It leaves the exercise list and search, and stays in your history, templates and backups."
    : `Delete "${exercise.name}"? It isn't used in any workout, template or the current session, so it is removed for good.`;
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": willHide ? "Confirm hide exercise" : "Confirm delete exercise", "data-region": "confirm-remove-custom", "data-enter": `confirm-remove-custom:${exercise.id}` },
    h("p", {}, question),
    button(willHide ? "Hide exercise" : "Delete exercise", {
      class: "danger",
      "data-action": "confirm-remove-custom",
      onClick: () => perform(ctx, async () => {
        log.confirmRemove = null;
        const outcome = await logger.removeCustomExercise(exercise.id);
        ctx.state.focus = '[data-field="search"]';
        if (outcome === "hidden") {
          log.restoreOffer = { id: exercise.id, name: exercise.name };
          log.notice = willHide
            ? `Hid "${exercise.name}".`
            : `Hidden instead of deleted: "${exercise.name}" is now used in ${describeUsage(await logger.getExerciseUsage(exercise.id))}.`;
        } else {
          log.notice = willHide
            ? `Deleted instead of hidden: nothing uses "${exercise.name}" any more, so it was removed for good.`
            : `Deleted "${exercise.name}".`;
        }
      }),
    }),
    button("Keep exercise", {
      "data-action": "cancel-remove-custom",
      onClick: () => {
        Object.assign(log, { confirmRemove: null, pickerFocus: menuButtonFor(exercise.id) });
        return ctx.rerender();
      },
    }),
  );
}

// The three-dot menu of a custom row: Edit exercise and Remove exercise. Escape closes it.
function customMenu(ctx, exercise) {
  const log = ctx.state.log;
  const closeMenu = () => {
    Object.assign(log, { pickerMenuId: null, pickerFocus: menuButtonFor(exercise.id) });
    return ctx.rerender();
  };
  return h(
    "div",
    {
      class: "menu",
      role: "menu",
      "data-enter": `pick-menu:${exercise.id}`,
      onKeydown: (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeMenu();
      },
    },
    button("Edit exercise", {
      class: "menu-item",
      role: "menuitem",
      "data-action": "edit-custom",
      "data-exercise-id": exercise.id,
      "aria-label": `Edit ${exercise.name}`,
      onClick: () => {
        Object.assign(log, { pickerMenuId: null, confirmRemove: null, addingCustom: false, editingCustom: exercise });
        ctx.state.focus = '[data-field="custom-name"]';
        return ctx.rerender();
      },
    }),
    button("Remove exercise", {
      class: "menu-item",
      role: "menuitem",
      "data-action": "remove-custom",
      "data-exercise-id": exercise.id,
      "aria-label": `Remove ${exercise.name}`,
      onClick: () => perform(ctx, async () => {
        const usage = await ctx.services.logger.getExerciseUsage(exercise.id);
        Object.assign(log, { pickerMenuId: null, confirmRemove: { exercise, usage }, pickerFocus: '[data-action="cancel-remove-custom"]' });
      }),
    }),
  );
}

// A drop-down filter for the picker: "Any" or one of the ids, shown with formatLabel. value() is the chosen id or null.
function filterSelect(label, field, ids, selected, onChange) {
  const select = h(
    "select",
    { "data-field": field, onChange },
    h("option", { value: "" }, "Any"),
    ids.map((id) => h("option", { value: id, selected: id === selected }, formatLabel(id))),
  );
  return { element: h("label", { class: "field" }, h("span", {}, label), select), value: () => select.value || null };
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
  // Anything that changes the results starts again from the first page.
  const narrow = () => {
    log.limit = PICKER_PAGE;
    return refreshList();
  };
  const muscle = filterSelect("Muscle", "filter-muscle", ALL_MUSCLES, log.muscle, narrow);
  const equipment = filterSelect("Equipment", "filter-equipment", ALL_EQUIPMENT, log.equipment, narrow);
  const list = h("ul", { class: "pick-list", "data-region": "exercise-list", "data-no-pull": "" });

  // A custom row also gets the three-dot menu (the Log tab's pattern, see blockHeader in set-rows.js) and, when
  // asked, the remove question under it. Built-in and catalog rows have no menu.
  const row = (exercise) => {
    if (!exercise.isCustom) return h("li", {}, pickButton(exercise));
    const open = log.pickerMenuId === exercise.id;
    const item = h("li", {}, h(
      "div",
      { class: "pick-row" },
      pickButton(exercise),
      button("⋮", {
        class: "menu-button",
        "data-action": "pick-menu",
        "data-exercise-id": exercise.id,
        "aria-label": `Options for ${exercise.name}`,
        "aria-haspopup": "menu",
        "aria-expanded": String(open),
        onClick: () => {
          Object.assign(log, { pickerMenuId: open ? null : exercise.id, confirmRemove: null });
          if (!open) log.pickerFocus = `[data-action="edit-custom"][data-exercise-id="${exercise.id}"]`;
          return ctx.rerender();
        },
      }),
    ));
    if (open) item.append(customMenu(ctx, exercise));
    if (log.confirmRemove?.exercise.id === exercise.id) item.append(removeConfirm(ctx, exercise, log.confirmRemove.usage));
    return item;
  };

  const pickButton = (exercise) => button(
    [
      h("span", { class: "pick-name" }, exercise.name),
      h(
        "span",
        { class: "pick-meta" },
        [
          ...exercise.primaryMuscles.map(formatLabel),
          exercise.equipment ? formatLabel(exercise.equipment) : null,
          exercise.isCustom ? "Custom" : null,
        ].filter(Boolean).join(" · "),
      ),
    ],
    {
      class: "pick",
      "data-action": "pick-exercise",
      "data-exercise-id": exercise.id,
      onClick: () => perform(ctx, async () => {
        await logger.addSet(exercise.id); // the exercise joins the session with one unchecked row
        Object.assign(log, { ...closedPicker(), query: "", muscle: "", equipment: "", limit: PICKER_PAGE });
      }),
    },
  );

  // "Showing 50 of 775" with a button for the next page, when there are more results than rows drawn.
  const moreRow = (shown, total) => h(
    "li",
    { class: "pick-more", "data-region": "pick-more" },
    h("span", { class: "muted" }, `Showing ${shown} of ${total}. Search or filter to narrow it down.`),
    button(`Show ${PICKER_PAGE} more`, {
      class: "small",
      "data-action": "pick-more",
      onClick: () => {
        log.limit += PICKER_PAGE;
        return refreshList();
      },
    }),
  );

  const groupHeading = (text) => h("li", { class: "pick-group", "data-region": "pick-group" }, text);

  // The exercises used most recently, read once per opening of the picker. If the read fails there is no Recent group.
  let recentRead = null;
  const readRecent = () => (recentRead ??= logger.findRecentExercises().catch(() => []));

  let latest = 0;
  async function refreshList() {
    const mine = ++latest;
    const filters = { muscle: muscle.value(), equipment: equipment.value() };
    const plain = search.value.trim() === "" && !filters.muscle && !filters.equipment; // Recent only for the unfiltered list
    const [results, recent] = await Promise.all([logger.findExercises(search.value, filters), plain ? readRecent() : []]);
    if (mine !== latest) return; // a newer search is already on its way
    Object.assign(log, { query: search.value, muscle: filters.muscle ?? "", equipment: filters.equipment ?? "" });
    // Recent is its own group above the list, not part of the 50-row page; its exercises are not repeated below.
    const recentIds = new Set(recent.map((exercise) => exercise.id));
    const rest = recent.length === 0 ? results : results.filter((exercise) => !recentIds.has(exercise.id));
    const shown = rest.slice(0, log.limit);
    list.replaceChildren(...(results.length === 0
      ? [h("li", { class: "muted" }, "No exercises match.")]
      : [
        ...(recent.length === 0 ? [] : [groupHeading("Recent"), ...recent.map(row), ...(rest.length === 0 ? [] : [groupHeading("All exercises")])]),
        ...shown.map(row),
        ...(rest.length > shown.length ? [moreRow(recent.length + shown.length, results.length)] : []),
      ]));
    // Focus asked for inside the list (ctx.rerender cannot: the rows did not exist yet). A row that is no longer
    // drawn (an edited name that no longer matches the search, say) sends it to the search field.
    if (log.pickerFocus !== null) {
      const target = list.querySelector(log.pickerFocus) ?? search;
      log.pickerFocus = null;
      if (list.isConnected) target.focus();
      else requestAnimationFrame(() => target.focus());
    }
  }
  search.addEventListener("input", narrow);
  refreshList();

  // Only if the app has a library service (src/ui/main.js passes one): a note while the library loads or if it could not load.
  const libraryStatus = ctx.services.catalog ? ctx.services.catalog.getStatus() : "ready";
  const libraryNote = libraryStatus === "failed"
    ? h("p", { class: "muted", "data-region": "catalog-status" }, "The full exercise library could not be loaded. Apogee will try again the next time it opens.")
    : libraryStatus === "syncing"
      ? h("p", { class: "muted", "data-region": "catalog-status" }, "Loading the exercise library…")
      : null;

  const panel = h(
    "section",
    { class: "card", "aria-label": "Choose exercise" },
    h("h2", {}, "Choose exercise"),
    search,
    h("div", { class: "pick-filters" }, muscle.element, equipment.element),
    libraryNote,
    list,
  );
  if (log.editingCustom !== null) {
    panel.append(customForm(ctx, log.editingCustom));
  } else if (log.addingCustom) {
    panel.append(customForm(ctx));
  } else {
    panel.append(h(
      "div",
      { class: "actions" },
      button("Add custom exercise", {
        "data-action": "add-custom",
        onClick: () => {
          Object.assign(log, { addingCustom: true, pickerMenuId: null, confirmRemove: null });
          return ctx.rerender();
        },
      }),
      button("Cancel", {
        "data-action": "cancel-picker",
        onClick: () => {
          Object.assign(log, closedPicker());
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
  stopElapsed(ctx);
  const session = await ctx.services.logger.getSession();
  const templates = await ctx.services.logger.listTemplates();
  const view = h("section", { class: "view", "aria-label": "New" });

  if (log.notice) {
    const offer = log.restoreOffer; // after a hide: the exercise can come straight back
    view.append(h(
      "p",
      { class: "notice", role: "status", "data-region": "notice", "data-enter": `notice:${log.notice}` },
      log.notice,
      offer === null ? null : [" ", button("Show it again", {
        class: "small",
        "data-action": "restore-hidden",
        "data-exercise-id": offer.id,
        onClick: () => perform(ctx, async () => {
          await ctx.services.logger.restoreCustomExercise(offer.id);
          log.notice = `"${offer.name}" is back in the exercise list.`;
          ctx.state.focus = log.pickerOpen ? '[data-field="search"]' : '[data-action="choose-exercise"]';
        }),
      })],
    ));
    log.notice = null;
  }
  log.restoreOffer = null;
  if (log.error) {
    view.append(h("p", { class: "error", role: "alert", "data-region": "view-error", "data-enter": `view-error:${log.error}` }, log.error));
    log.error = null;
  }

  if (templates.length > 0) view.append(templatesSection(ctx, templates));
  if (session.status.kind === "stale") {
    view.append(staleCard(ctx, session));
    return view;
  }
  const card = currentCard(ctx, session);
  view.append(card);
  view.append(addExerciseArea(ctx, session));
  if (card.elapsed) startElapsed(ctx, card.elapsed, session.workout.startedAt);
  // Only a timer that is still running gets a ticker; an expired one is already done.
  if (session.timer !== null && isRunning(session.timer, session.nowMs)) startTicker(ctx, view, session.timer);
  return view;
}
