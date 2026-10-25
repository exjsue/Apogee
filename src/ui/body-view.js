// The Body tab: a muscle diagram, front or back, shaded from the weighted sets of the last WINDOW_DAYS days, with
// markers for muscles not trained in NEGLECTED_WEEKS weeks and muscles above the target range. The numbers come from
// logger.getMuscleStatus (read only; nothing is stored); every threshold is in src/domain/body-status.js.
//
// The data is loaded each time the tab is drawn, but not when only the Front/Back button was pressed: that redraw
// reuses state.body.status (state.body.reuse), so a set logged a minute ago shows after leaving and re-entering.

import { h, button } from "./dom.js";
import { renderBodyDiagram, intensityLines } from "./body-diagram.js";
import { TARGET_RANGE, WINDOW_DAYS, NEGLECTED_WEEKS } from "../domain/body-status.js";

export const freshBodyState = () => ({ view: "front", status: null, reuse: false });

const VIEW_LABELS = { front: "Front", back: "Back" };

export async function renderBodyView(ctx) {
  const { state, services } = ctx;
  const body = state.body;
  const current = body.view;

  const toggle = h(
    "div",
    { class: "view-toggle", role: "group", "aria-label": "Diagram view" },
    Object.entries(VIEW_LABELS).map(([view, label]) => button(label, {
      "aria-pressed": String(view === current),
      "data-action": "body-view",
      "data-view": view,
      onClick: async () => {
        body.view = view;
        body.reuse = true; // only the view changes: the numbers are the ones already loaded
        state.focus = `[data-action="body-view"][data-view="${view}"]`; // the view is rebuilt below
        await ctx.rerender();
      },
    })),
  );

  // A failed read must not take the toggle down with it (as in Settings); and no diagram is better than one of zeros.
  let status = body.reuse ? body.status : null;
  let problem = null;
  if (status === null) {
    try {
      status = await services.logger.getMuscleStatus();
    } catch (error) {
      problem = error;
    }
  }
  body.status = status;
  body.reuse = false;

  const head = [h("h2", {}, "Body"), toggle];
  if (status === null) {
    return h(
      "section",
      { class: "view", "aria-label": "Body" },
      head,
      h("p", { class: "error", role: "alert", "data-region": "body-error" }, `The muscle diagram could not be shown: ${problem.message}`),
    );
  }

  const neglected = new Set(status.neglected);
  const above = new Set(status.above);
  const args = { values: status.values, view: current, max: TARGET_RANGE.max, neglected, above };
  const svg = renderBodyDiagram({ ...args, label: `Muscle diagram, ${current} view, last ${WINDOW_DAYS} days.` });
  return h(
    "section",
    { class: "view", "aria-label": "Body" },
    head,
    h("p", { class: "body-note", "data-region": "body-note" }, `Last ${WINDOW_DAYS} days. All completed sets count; effort is not tracked yet. Secondary muscles count half.`),
    status.hasHistory ? null : h("p", { class: "body-note", "data-region": "body-empty" }, `No sets logged in the last ${NEGLECTED_WEEKS} weeks.`),
    svg === null ? h("p", { class: "muted" }, "The diagram could not be drawn here. The list below has the same information.") : svg,
    h(
      "ul",
      { class: "visually-hidden", "aria-label": `Muscle intensity, ${current} view, last ${WINDOW_DAYS} days`, "data-region": "body-list" },
      intensityLines(args).map(({ label, word }) => h("li", {}, `${label}: ${word}`)),
    ),
  );
}
