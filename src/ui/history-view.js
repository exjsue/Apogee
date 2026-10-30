// The History tab: finished workouts, newest first, with a detail that can be deleted.

import { h, button, exerciseHeading, setMark } from "./dom.js";
import { formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";
import { isWarmupSet, setNumbers } from "../domain/workout-plan.js";

export const freshHistoryState = () => ({ detailId: null, confirmDelete: false, savingTemplate: false, notice: null, error: null });

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
    return null;
  }
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
          return ctx.rerender();
        },
      }),
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
      { class: "card entry" },
      exerciseHeading(entry.exerciseName, entry.markCustom),
      parts.length ? h("p", { class: "muted", "data-region": "records" }, `Records: ${parts.join(" · ")}`) : null,
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
            ? h("span", { class: "pr-label", "data-region": "pr" }, h("span", { "aria-hidden": "true" }, "PR"), h("span", { class: "visually-hidden" }, "personal record"))
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
