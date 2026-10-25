// The Body tab: a muscle diagram, front or back, shaded from the weighted sets of the last WINDOW_DAYS days, with
// markers for muscles not trained in NEGLECTED_WEEKS weeks and muscles above the target range. The numbers come from
// logger.getMuscleStatus (read only; nothing is stored); every threshold is in src/domain/body-status.js.
//
// The data is loaded each time the tab is drawn, but not when only the Front/Back button was pressed: that redraw
// reuses state.body.status (state.body.reuse), so a set logged a minute ago shows after leaving and re-entering.
//
// Tapping a muscle (resolved by geometry, src/ui/body-hit.js) or pressing its button in the text list opens a panel
// below the diagram with the MuscleDetail that logger.getMuscleStatus built (src/domain/muscle-detail.js); this file
// only draws the strings in it. The panel is not a modal. The selection (state.body.selected) lives in memory only:
// app.js clears it when the tab is left, and a change of view keeps it only if that muscle is on the new view.
// It closes by tapping the same muscle again, tapping elsewhere, the Close button, or Escape.

import { h, button } from "./dom.js";
import { renderBodyDiagram, intensityLines, markSelected } from "./body-diagram.js";
import { BODY_REGIONS } from "./body-regions.js";
import { resolveTap } from "./body-hit.js";
import { TARGET_RANGE, WINDOW_DAYS, NEGLECTED_WEEKS } from "../domain/body-status.js";

export const freshBodyState = () => ({ view: "front", status: null, reuse: false, selected: null, dropOutside: null });

const VIEW_LABELS = { front: "Front", back: "Back" };

// What a tap or a click counts as "inside": it does not close the panel.
const INSIDE = ".body-diagram, .muscle-panel, .body-list, .view-toggle";

// Brings the panel into view only if it is not fully visible, smoothly unless the person asked for less motion.
function revealPanel(panel) {
  const win = panel.ownerDocument.defaultView;
  const box = panel.getBoundingClientRect();
  if (box.top >= 0 && box.bottom <= win.innerHeight) return;
  const reduced = typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

function contributorGroup(title, rows) {
  if (rows.length === 0) return null;
  return h("div", { class: "contributors" }, h("h4", {}, title), h("ul", {}, rows.map((row) => h("li", {}, row.text))));
}

function panelFor(detail, onClose) {
  return h(
    "section",
    { class: "muscle-panel", id: "muscle-panel", "data-region": "muscle-panel", "data-muscle": detail.muscle, "aria-labelledby": "muscle-panel-heading" },
    h(
      "div",
      { class: "panel-head" },
      h("h3", { id: "muscle-panel-heading", tabindex: "-1", "data-region": "muscle-panel-heading" }, detail.label),
      button("Close", { class: "small", "data-action": "muscle-close", onClick: onClose }),
    ),
    h("p", { "data-region": "muscle-weighted" }, detail.weightedText),
    detail.positionText === null ? null : h("p", { "data-region": "muscle-position" }, detail.positionText),
    h("p", { class: "muted", "data-region": "muscle-target" }, detail.targetText),
    h("p", { "data-region": "muscle-last" }, `Last trained: ${detail.lastTrainedText}`),
    detail.trend === null ? null : h("p", { "data-region": "muscle-trend" }, `Trend: ${detail.trend.text}`),
    contributorGroup("Primary credit", detail.contributors.primary),
    contributorGroup("Secondary credit", detail.contributors.secondary),
    detail.balance === null ? null : h("p", { "data-region": "muscle-balance" }, `Balance: ${detail.balance.text}`),
  );
}

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

  const details = status.details ?? {};
  if (body.selected !== null && !BODY_REGIONS[current].regions.some(({ muscle }) => muscle === body.selected)) body.selected = null;
  if (body.selected !== null && details[body.selected] === undefined) body.selected = null;

  const neglected = new Set(status.neglected);
  const above = new Set(status.above);
  const args = { values: status.values, view: current, max: TARGET_RANGE.max, neglected, above };
  const svg = renderBodyDiagram({ ...args, selected: body.selected, label: `Muscle diagram, ${current} view, last ${WINDOW_DAYS} days.` });
  const slot = h("div", { class: "muscle-slot", "data-region": "muscle-slot" });
  let viaList = false; // the panel was opened from the text list (keyboard, VoiceOver): focus goes into it and back

  // The open panel closes when the person taps or clicks anywhere else, or presses Escape. The listeners are on the
  // page's document, only while a panel is open, and they remove themselves once this section has left the page.
  function stopOutside() {
    if (body.dropOutside !== null) body.dropOutside();
    body.dropOutside = null;
  }
  function watchOutside() {
    stopOutside();
    const doc = section.isConnected ? section.ownerDocument : document;
    const onClick = (event) => {
      if (!section.isConnected) stopOutside();
      else if (!event.target.closest?.(INSIDE)) select(null);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (section.isConnected) close();
      else stopOutside();
    };
    doc.addEventListener("click", onClick);
    doc.addEventListener("keydown", onKey);
    body.dropOutside = () => {
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKey);
    };
  }

  function select(muscle) {
    const id = muscle !== null && details[muscle] !== undefined ? muscle : null;
    body.selected = id;
    if (svg !== null) markSelected(svg, current, id);
    for (const item of list.querySelectorAll("button[data-muscle]")) item.setAttribute("aria-expanded", String(item.dataset.muscle === id));
    if (id === null) {
      slot.replaceChildren();
      stopOutside();
      return;
    }
    const panel = panelFor(details[id], close);
    slot.replaceChildren(panel);
    watchOutside();
    if (viaList) panel.querySelector("h3").focus({ preventScroll: true });
    revealPanel(panel);
  }

  function close() {
    const was = body.selected;
    const returnFocus = viaList;
    select(null);
    viaList = false;
    if (returnFocus && was !== null) list.querySelector(`button[data-muscle="${was}"]`)?.focus();
  }

  // The list is out of sight until a button in it has focus (app.css), so a keyboard user can see where they are.
  const list = h(
    "ul",
    { class: "visually-hidden body-list", "aria-label": `Muscle intensity, ${current} view, last ${WINDOW_DAYS} days`, "data-region": "body-list" },
    intensityLines(args).map(({ muscle, label, word }) => h("li", {}, button(`${label}: ${word}`, {
      class: "list-open",
      "data-action": "muscle-open",
      "data-muscle": muscle,
      "aria-expanded": String(muscle === body.selected),
      "aria-controls": "muscle-panel",
      onClick: () => {
        viaList = true;
        select(muscle === body.selected ? null : muscle);
        if (body.selected === null) viaList = false;
      },
    }))),
  );

  // A tap is turned into the diagram's own coordinates with the SVG's transform, then resolved by geometry.
  svg?.addEventListener("click", (event) => {
    const matrix = svg.getScreenCTM();
    if (matrix === null) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const muscle = resolveTap(BODY_REGIONS[current].regions, [point.x, point.y]);
    viaList = false;
    select(muscle === null || muscle === body.selected ? null : muscle);
  });

  const section = h(
    "section",
    { class: "view", "aria-label": "Body" },
    head,
    h("p", { class: "body-note", "data-region": "body-note" }, `Last ${WINDOW_DAYS} days. All completed sets count; effort is not tracked yet. Secondary muscles count half.`),
    status.hasHistory ? null : h("p", { class: "body-note", "data-region": "body-empty" }, `No sets logged in the last ${NEGLECTED_WEEKS} weeks.`),
    svg === null ? h("p", { class: "muted" }, "The diagram could not be drawn here. The list below has the same information.") : svg,
    slot,
    list,
  );
  if (body.selected !== null) {
    slot.append(panelFor(details[body.selected], close));
    watchOutside();
  } else {
    stopOutside();
  }
  return section;
}
