// The History tab: finished workouts, newest first, with a read-only detail.

import { h, button } from "./dom.js";
import { formatSetWeight, formatDateTime, formatCount } from "../domain/format.js";

export const freshHistoryState = () => ({ detailId: null });

async function detail(ctx, id) {
  const workout = await ctx.services.logger.getWorkoutDetail(id);
  if (workout === null) {
    ctx.state.history.detailId = null;
    return null;
  }
  const view = h(
    "section",
    { class: "view", "aria-label": "Workout detail" },
    button("Back to history", {
      class: "small",
      "data-action": "back-to-history",
      onClick: () => {
        ctx.state.history.detailId = null;
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
      h("h3", {}, entry.exerciseName),
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
  return view;
}

export async function renderHistoryView(ctx) {
  const history = ctx.state.history;
  if (history.detailId) {
    const view = await detail(ctx, history.detailId);
    if (view !== null) return view;
  }
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
            return ctx.rerender();
          },
        },
      ),
    )),
  ));
  return view;
}
