// The Body tab: a muscle diagram, front or back, shaded from a value map { muscleId: number }.
// FOR NOW THE VALUES ARE EXAMPLE DATA (EXAMPLE_VALUES below), shown as such on screen. They are not read from
// workouts and nothing is stored. Step 4 replaces them with the real per-muscle load (src/domain/muscle-load.js).

import { h, button } from "./dom.js";
import { foldNeckIntoTraps } from "../domain/body-display.js";
import { renderBodyDiagram, intensityLines } from "./body-diagram.js";

export const freshBodyState = () => ({ view: "front" });

// Made-up numbers on a 0 to 10 scale (the diagram's default reference), covering all 20 muscle ids and all six shades.
const EXAMPLE_VALUES = Object.freeze({
  chest: 8, front_delts: 6, side_delts: 3, rear_delts: 2, biceps: 5, triceps: 7, forearms: 1,
  traps: 4, neck: 2, lats: 9, upper_back: 5, lower_back: 3, abs: 4, obliques: 1,
  glutes: 10, quads: 9, hamstrings: 2, adductors: 0, abductors: 1, calves: 6,
});

const VIEW_LABELS = { front: "Front", back: "Back" };

export async function renderBodyView(ctx) {
  const { state } = ctx;
  const current = state.body.view;
  const values = foldNeckIntoTraps(EXAMPLE_VALUES);

  const toggle = h(
    "div",
    { class: "view-toggle", role: "group", "aria-label": "Diagram view" },
    Object.entries(VIEW_LABELS).map(([view, label]) => button(label, {
      "aria-pressed": String(view === current),
      "data-action": "body-view",
      "data-view": view,
      onClick: async () => {
        state.body.view = view;
        state.focus = `[data-action="body-view"][data-view="${view}"]`; // the view is rebuilt below
        await ctx.rerender();
      },
    })),
  );

  const svg = renderBodyDiagram({ values, view: current, label: `Muscle diagram, ${current} view. Example data.` });
  const lines = intensityLines({ values, view: current });
  return h(
    "section",
    { class: "view", "aria-label": "Body" },
    h("h2", {}, "Body"),
    h("p", { class: "example-label", "data-region": "example-data" }, h("strong", {}, "Example data"), ". These numbers are made up; they are not your workouts."),
    toggle,
    svg === null ? h("p", { class: "muted" }, "The diagram could not be drawn here. The list below has the same information.") : svg,
    h(
      "ul",
      { class: "visually-hidden", "aria-label": `Muscle intensity, ${current} view, example data`, "data-region": "body-list" },
      lines.map(({ label, word }) => h("li", {}, `${label}: ${word}`)),
    ),
  );
}
