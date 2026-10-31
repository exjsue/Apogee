// The History tab: finished workouts, newest first, with a detail that can be deleted.

import { h, button, exerciseHeading, setMark } from "./dom.js";
import { formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";
import { isWarmupSet, setNumbers } from "../domain/workout-plan.js";
import { draftFromWorkout, localDate } from "../domain/workout-edit.js";
import { WEIGHT_UNITS } from "../domain/model.js";

// editing: null, or { original, draft, error } while a finished workout is edited (Cancel sets it back to null).
export const freshHistoryState = () => ({ detailId: null, confirmDelete: false, savingTemplate: false, editing: null, notice: null, error: null });

const EXERCISE_RESULTS = 8; // how many matches the Add exercise search shows

// Edit mode for a finished workout: the draft lives in history.editing and nothing is stored until Save, which
// the logger checks and writes in one transaction (saveWorkoutEdit). Typing updates the draft without a redraw;
// adding or deleting redraws from it.
function editView(ctx) {
  const history = ctx.state.history;
  const editing = history.editing;
  const { draft } = editing;
  const redraw = () => ctx.rerender();
  const blankSet = (unit) => ({ id: null, reps: "", weight: "", unit, isWarmup: false });
  const view = h(
    "section",
    { class: "view", "aria-label": "Workout detail" },
    h("h2", {}, "Edit workout"),
    h("label", { class: "field" }, h("span", {}, "Date"), h("input", {
      type: "date", "data-field": "past-date", value: draft.date, max: localDate(new Date().toISOString()),
      onInput: (event) => { draft.date = event.target.value; },
    })),
  );
  draft.entries.forEach((entry, entryIndex) => {
    const numbers = setNumbers(entry.sets);
    view.append(h(
      "div",
      { class: "card entry", "data-exercise-id": entry.exerciseId, "data-entry-index": entryIndex },
      exerciseHeading(entry.exerciseName, entry.markCustom),
      entry.sets.length === 0 ? h("p", { class: "muted" }, "No sets: this exercise is removed on Save.") : null,
      h("ol", { class: "sets" }, entry.sets.map((set, setIndex) => h(
        "li",
        { class: "past-set", "data-warmup": set.isWarmup ? "true" : null },
        h("span", { class: "set-text" }, setMark(numbers[setIndex])),
        h("input", {
          type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": "Reps", placeholder: "reps", "data-field": "past-reps", value: set.reps,
          onInput: (event) => { set.reps = event.target.value; },
        }),
        h("input", {
          type: "text", inputmode: "decimal", autocomplete: "off", "aria-label": "Weight", placeholder: "weight", "data-field": "past-weight", value: set.weight,
          onInput: (event) => { set.weight = event.target.value; },
        }),
        h(
          "select",
          { "aria-label": "Unit", "data-field": "past-unit", onChange: (event) => { set.unit = event.target.value; } },
          WEIGHT_UNITS.map((unit) => h("option", { value: unit, selected: unit === set.unit }, unit)),
        ),
        h("label", { class: "check" }, h("input", {
          type: "checkbox", "data-field": "past-warmup", checked: set.isWarmup,
          onChange: (event) => { set.isWarmup = event.target.checked; return redraw(); }, // renumbers the sets
        }), "Warm-up"),
        button("Delete", {
          class: "small danger-outline",
          "data-action": "past-delete-set",
          "aria-label": `Delete ${numbers[setIndex] === null ? "warm-up set" : `set ${numbers[setIndex]}`} of ${entry.exerciseName}`,
          onClick: () => { entry.sets.splice(setIndex, 1); return redraw(); },
        }),
      ))),
      button("Add set", {
        class: "small",
        "data-action": "past-add-set",
        onClick: () => {
          entry.sets.push(blankSet(entry.sets.at(-1)?.unit ?? ctx.unit));
          ctx.state.focus = `[data-entry-index="${entryIndex}"] li:last-child [data-field="past-reps"]`;
          return redraw();
        },
      }),
    ));
  });

  // Add exercise: a search box whose matches are redrawn in place, so typing keeps focus. Picking an exercise
  // already in the workout adds a set to it instead of a second card.
  const results = h("ul", { class: "pick-list", "data-region": "past-exercise-results" });
  const search = h("input", {
    type: "search", autocomplete: "off", "aria-label": "Find an exercise to add", placeholder: "Find an exercise to add", "data-field": "past-exercise-search",
    onInput: async () => {
      const query = search.value;
      const found = query.trim() === "" ? [] : (await ctx.services.logger.findExercises(query)).slice(0, EXERCISE_RESULTS);
      if (search.value !== query) return; // a newer search is on its way
      results.replaceChildren(...found.map((exercise) => h("li", {}, button(h("span", { class: "pick-name" }, exercise.name), {
        class: "pick",
        "data-action": "past-add-exercise",
        "data-exercise-id": exercise.id,
        onClick: () => {
          const existing = draft.entries.find((entry) => entry.exerciseId === exercise.id);
          if (existing) existing.sets.push(blankSet(existing.sets.at(-1)?.unit ?? ctx.unit));
          else draft.entries.push({ id: null, exerciseId: exercise.id, exerciseName: exercise.name, markCustom: false, sets: [blankSet(ctx.unit)] });
          return redraw();
        },
      }))));
    },
  });
  view.append(h("div", { class: "card" }, h("h3", {}, "Add exercise"), search, results));

  if (editing.error) view.append(h("p", { class: "error", role: "alert", "data-region": "past-edit-error" }, editing.error));
  view.append(h(
    "div",
    { class: "actions" },
    button("Save", {
      class: "primary",
      "data-action": "save-past-edit",
      onClick: async () => {
        try {
          await ctx.services.logger.saveWorkoutEdit(editing.original, draft);
          history.editing = null;
          history.notice = "Workout saved.";
          ctx.state.focus = '[data-action="edit-workout"]';
        } catch (error) {
          editing.error = error.message; // the draft is kept, so the value can be fixed
        }
        return redraw();
      },
    }),
    button("Cancel", {
      "data-action": "cancel-past-edit",
      onClick: () => {
        history.editing = null;
        ctx.state.focus = '[data-action="edit-workout"]';
        return redraw();
      },
    }),
  ));
  return view;
}

// "Save as template" on a finished workout: a button, then a form asking for the name. The name rule and the
// "nothing countable" refusal live in the logger; their message is shown here and the typed name is kept.
function templateSection(ctx, workout) {
  const history = ctx.state.history;
  const saveButton = '[data-action="save-template"]';
  if (!history.savingTemplate) {
    return button("Save as template", {
      "data-action": "save-template",
      onClick: () => {
        history.savingTemplate = true;
        ctx.state.focus = '[data-field="template-name"]';
        return ctx.rerender();
      },
    });
  }
  const name = h("input", { type: "text", "data-field": "template-name", "data-saved": "", autocomplete: "off" });
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "template-error" });
  return h(
    "form",
    {
      class: "card",
      "aria-label": "Save as template",
      "data-enter": "save-template",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          const saved = await ctx.services.logger.saveWorkoutAsTemplate(workout.id, name.value);
          history.savingTemplate = false;
          history.notice = `Saved template "${saved.name}" with ${formatCount(saved.exercises.length, "exercise")}. It is on the New tab.`;
          ctx.state.focus = saveButton;
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    h("h3", {}, "Save as template"),
    h("p", { class: "muted" }, "A template keeps only the exercises, in order, and how many working sets each had."),
    h("label", { class: "field" }, h("span", {}, "Template name"), name),
    error,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", class: "primary", "data-action": "confirm-save-template" }, "Save template"),
      button("Cancel", {
        "data-action": "cancel-save-template",
        onClick: () => {
          history.savingTemplate = false;
          ctx.state.focus = saveButton;
          return ctx.rerender();
        },
      }),
    ),
  );
}

function deleteSection(ctx, workout) {
  const history = ctx.state.history;
  if (!history.confirmDelete) {
    return h(
      "div",
      { class: "actions" },
      button("Delete workout", {
        class: "danger-outline",
        "data-action": "delete-workout",
        onClick: () => {
          history.confirmDelete = true;
          return ctx.rerender();
        },
      }),
    );
  }
  return h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete", "data-region": "confirm-delete", "data-enter": "confirm-delete" },
    h(
      "p",
      {},
      `Delete this workout and its ${formatCount(workout.loggedSetCount, "set")}? This cannot be undone. `
      + "If you are not sure, export your data first (Settings, Backup).",
    ),
    button("Delete workout", {
      class: "danger",
      "data-action": "confirm-delete-workout",
      onClick: async () => {
        try {
          await ctx.services.logger.deleteFinishedWorkout(workout.id);
          history.detailId = null;
          history.notice = "Workout deleted.";
        } catch (error) {
          history.error = error.message;
        }
        history.confirmDelete = false;
        await ctx.rerender();
      },
    }),
    button("Cancel", {
      "data-action": "cancel-delete-workout",
      onClick: () => {
        history.confirmDelete = false;
        return ctx.rerender();
      },
    }),
  );
}

// A stored set with a unit the app does not know shows as stored ("100 st") instead of breaking the whole detail.
function weightText(set, unit) {
  try { return formatSetWeight(set.weightValue, set.weightUnit, unit); } catch { return `${set.weightValue} ${set.weightUnit}`; }
}

async function detail(ctx, id) {
  const history = ctx.state.history;
  const workout = await ctx.services.logger.getWorkoutDetail(id);
  if (workout === null) {
    history.detailId = null;
    history.confirmDelete = false;
    history.savingTemplate = false;
    history.editing = null;
    return null;
  }
  if (history.editing !== null && history.editing.original.id === id) return editView(ctx);
  // A workout still in progress has no Edit button: it is changed on the New tab.
  const edit = workout.endedAt && !history.savingTemplate ? button("Edit", {
    "data-action": "edit-workout",
    onClick: () => {
      history.editing = { original: workout, draft: draftFromWorkout(workout), error: null };
      history.confirmDelete = false;
      ctx.state.focus = '[data-field="past-date"]';
      return ctx.rerender();
    },
  }) : null;
  // Records are read once per detail open. A failure only drops the Records lines and PR labels.
  let rec = null;
  try { rec = await ctx.services.logger.getRecords(); } catch { rec = null; }
  // "PR" means the set was a record when done; volume never marks.
  const prSets = new Set((rec?.history ?? []).filter((e) => e.type !== "volume").map((e) => e.setId));
  // Top row: Back, and Save as template when finished. While the form is open it is drawn under this row instead.
  const template = workout.endedAt ? templateSection(ctx, workout) : null;
  const view = h(
    "section",
    { class: "view", "aria-label": "Workout detail" },
    h(
      "div",
      { class: "actions" },
      button("Back to history", {
        class: "small",
        "data-action": "back-to-history",
        onClick: () => {
          history.detailId = null;
          history.confirmDelete = false;
          history.savingTemplate = false;
          history.editing = null;
          return ctx.rerender();
        },
      }),
      edit,
      history.savingTemplate ? null : template,
    ),
    history.savingTemplate ? template : null,
    h("h2", {}, formatDateTime(workout.startedAt)),
    workout.endedAt ? h("p", { class: "muted" }, `Finished ${formatDateTime(workout.endedAt)}`) : null,
  );
  for (const entry of workout.entries) {
    const numbers = setNumbers(entry.sets);
    const mine = rec?.records[entry.exerciseId] ?? {};
    const parts = [["weight", "Heaviest"], ["e1rm", "Est. 1RM"], ["reps", "Most reps"]]
      .filter(([type]) => mine[type])
      .map(([type, label]) => (type === "reps" ? `${label} ${mine.reps.value}` : `${label} ${mine[type].value} ${rec.unit}`));
    view.append(h(
      "div",
      { class: "card entry", "data-enter": `detail:${workout.id}:${entry.exerciseId}` },
      exerciseHeading(entry.exerciseName, entry.markCustom),
      parts.length ? h("p", { class: "muted", "data-region": "records", "data-enter": `records:${workout.id}:${entry.exerciseId}` },`Records: ${parts.join(" · ")}`) : null,
      h(
        "ol",
        { class: "sets" },
        entry.sets.map((set, index) => h(
          "li",
          { "data-warmup": isWarmupSet(set) ? "true" : null },
          h(
            "span",
            { class: "set-text" },
            setMark(numbers[index]),
            ` ${formatCount(set.reps, "rep")} · ${weightText(set, ctx.unit)}`,
          ),
          !isWarmupSet(set) && prSets.has(set.id)
            ? h("span", { class: "pr-label", "data-region": "pr", "data-enter": `pr:${set.id}` }, h("span", { "aria-hidden": "true" }, "PR"), h("span", { class: "visually-hidden" }, "personal record"))
            : null,
        )),
      ),
    ));
  }
  if (rec?.ignored > 0) {
    view.append(h("p", { class: "muted", "data-region": "records-ignored" }, `${formatCount(rec.ignored, "set")} ${rec.ignored === 1 ? "was" : "were"} left out of records: missing exercise or unit`));
  }
  view.append(deleteSection(ctx, workout));
  return view;
}

async function list(ctx) {
  const history = ctx.state.history;
  const workouts = await ctx.services.logger.getHistory();
  const view = h("section", { class: "view", "aria-label": "History" }, h("h2", {}, "History"));
  if (workouts.length === 0) {
    view.append(h("p", { class: "muted" }, "No finished workouts yet. Finish a workout on the New tab and it appears here."));
    return view;
  }
  view.append(h(
    "ul",
    { class: "history-list", "data-region": "history-list" },
    workouts.map((workout) => h(
      "li",
      {},
      button(
        [
          h("span", { class: "pick-name" }, formatDateTime(workout.startedAt)),
          h(
            "span",
            { class: "pick-meta" },
            `${formatCount(workout.entryCount, "exercise")} · ${formatCount(workout.setCount, "set")}`,
          ),
        ],
        {
          class: "pick",
          "data-action": "open-workout",
          "data-workout-id": workout.id,
          onClick: () => {
            history.detailId = workout.id;
            history.confirmDelete = false;
            history.savingTemplate = false;
            history.editing = null;
            return ctx.rerender();
          },
        },
      ),
    )),
  ));
  return view;
}

export async function renderHistoryView(ctx) {
  const history = ctx.state.history;
  let view = null;
  if (history.detailId) view = await detail(ctx, history.detailId);
  if (view === null) view = await list(ctx);

  // messages from the last action, shown once at the top
  const messages = [];
  if (history.notice) {
    messages.push(h("p", { class: "notice", role: "status", "data-region": "notice", "data-enter": `notice:${history.notice}` }, history.notice));
    history.notice = null;
  }
  if (history.error) {
    messages.push(h("p", { class: "error", role: "alert", "data-region": "view-error", "data-enter": `view-error:${history.error}` }, history.error));
    history.error = null;
  }
  view.prepend(...messages);
  return view;
}
