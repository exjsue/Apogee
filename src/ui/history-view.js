// The History tab: finished workouts, newest first, with a detail that can be deleted.

import { h, button, exerciseHeading } from "./dom.js";
import { formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";

export const freshHistoryState = () => ({ detailId: null, confirmDelete: false, notice: null, error: null });

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
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete", "data-region": "confirm-delete" },
    h(
      "p",
      {},
      `Delete this workout and its ${formatCount(workout.setCount, "set")}? This cannot be undone. `
      + "If you are not sure, export your data first on the Backup tab.",
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

async function detail(ctx, id) {
  const history = ctx.state.history;
  const workout = await ctx.services.logger.getWorkoutDetail(id);
  if (workout === null) {
    history.detailId = null;
    history.confirmDelete = false;
    return null;
  }
  const view = h(
    "section",
    { class: "view", "aria-label": "Workout detail" },
    button("Back to history", {
      class: "small",
      "data-action": "back-to-history",
      onClick: () => {
        history.detailId = null;
        history.confirmDelete = false;
        return ctx.rerender();
      },
    }),
    h("h2", {}, formatDateTime(workout.startedAt)),
    workout.endedAt ? h("p", { class: "muted" }, `Finished ${formatDateTime(workout.endedAt)}`) : null,
  );
  for (const entry of workout.entries) {
    view.append(h(
      "div",
      { class: "card entry" },
      exerciseHeading(entry.exerciseName, entry.markCustom),
      h(
        "ol",
        { class: "sets" },
        entry.sets.map((set, index) => h(
          "li",
          {},
          h(
            "span",
            { class: "set-text" },
            `${index + 1}. ${formatCount(set.reps, "rep")} · ${formatSetWeight(set.weightValue, set.weightUnit, ctx.unit)}`,
          ),
        )),
      ),
    ));
  }
  view.append(deleteSection(ctx, workout));
  return view;
}

async function list(ctx) {
  const history = ctx.state.history;
  const workouts = await ctx.services.logger.getHistory();
  const view = h("section", { class: "view", "aria-label": "History" }, h("h2", {}, "History"));
  if (workouts.length === 0) {
    view.append(h("p", { class: "muted" }, "No finished workouts yet. Finish a workout on the Log tab and it appears here."));
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
    messages.push(h("p", { class: "notice", role: "status", "data-region": "notice" }, history.notice));
    history.notice = null;
  }
  if (history.error) {
    messages.push(h("p", { class: "error", role: "alert", "data-region": "view-error" }, history.error));
    history.error = null;
  }
  view.prepend(...messages);
  return view;
}
