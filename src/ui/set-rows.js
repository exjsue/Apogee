// The exercise blocks of the Log tab: set rows with a check, the rest line under
// each row, and the ticker that keeps a running timer on screen. Only builds
// elements and passes input to the logger; every rule (what can be checked, how
// a timer behaves) lives in src/app and src/domain.

import { h, button } from "./dom.js";
import { WEIGHT_UNITS } from "../domain/model.js";
import { formatCount, formatSetWeight } from "../domain/format.js";
import {
  formatRest, parseRest, pieGeometry, isRunning, remainingSeconds, fractionRemaining,
} from "../domain/rest-timer.js";

// Runs an action; a failure becomes the message shown at the top of the view.
export async function perform(ctx, action) {
  try {
    await action();
    ctx.state.log.error = null;
  } catch (error) {
    ctx.state.log.error = error.message;
  }
  await ctx.rerender();
}

function rowLine(row, index, unit) {
  return `${index + 1}. ${formatCount(row.reps, "rep")} · ${formatSetWeight(row.weight, row.unit, unit)}`;
}

function deleteControl(ctx, row, exerciseName, index) {
  const log = ctx.state.log;
  if (log.confirmDeleteSetId === row.id) {
    return h(
      "span",
      { class: "inline-confirm" },
      "Delete this set?",
      button("Delete", {
        class: "danger small",
        "data-action": "confirm-delete-set",
        onClick: () => perform(ctx, async () => {
          log.confirmDeleteSetId = null;
          await ctx.services.logger.deleteSet(row.id);
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
      log.confirmDeleteSetId = row.id;
      return ctx.rerender();
    },
  });
}

// ---- the rest icon: a ring and a pie, cloned from the template in index.html ----
// (The icon is markup in the page, not built here: creating SVG elements from
// script needs the SVG namespace URL, and the page scan allows no URLs.)

function newIcon() {
  const template = document.getElementById("rest-icon-template");
  const source = template === null ? null : template.content.firstElementChild;
  return source === null ? h("span", { class: "rest-icon" }) : source.cloneNode(true);
}

// "template": a full pie. "resting": the pie as far as it has depleted (clockwise).
// "done": nothing, the outline is gone too (a CSS rule hides the ring).
function paintIcon(icon, phase, fraction) {
  if (icon === null) return;
  icon.dataset.phase = phase;
  const pie = icon.querySelector(".rest-pie");
  if (pie !== null) pie.setAttribute("d", phase === "done" ? "" : pieGeometry(fraction).d);
}

function restEditor(ctx, row) {
  const log = ctx.state.log;
  const input = h("input", {
    type: "text", inputmode: "numeric", autocomplete: "off", "data-field": "rest",
    "aria-label": "Rest time (minutes:seconds)", value: formatRest(row.restSeconds), "data-saved": formatRest(row.restSeconds),
  });
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "rest-error" });
  return h(
    "form",
    {
      class: "rest-editor",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          await ctx.services.logger.setRest(row.id, parseRest(input.value));
          log.editingRestId = null;
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    input,
    h("button", { type: "submit", class: "small primary", "data-action": "save-rest" }, "Save"),
    button("Cancel", {
      class: "small",
      "data-action": "cancel-rest",
      onClick: () => {
        log.editingRestId = null;
        return ctx.rerender();
      },
    }),
    error,
  );
}

// The small line under a row: the rest time (m:ss) and the icon. Warm-up rows
// have none, and neither does the Add set button.
function restLine(ctx, row, index, exerciseName) {
  if (!row.hasTimer) return null;
  const icon = newIcon();
  paintIcon(icon, row.phase, row.fraction);
  let time;
  if (ctx.state.log.editingRestId === row.id && row.phase !== "done") {
    return h("div", { class: "rest-line", "data-timer-for": row.id }, restEditor(ctx, row));
  }
  if (row.phase === "done") {
    time = h("span", { class: "rest-time", "data-region": "rest-time" }, "0:00");
  } else {
    time = button(formatRest(row.seconds), {
      class: "rest-time",
      "data-action": "edit-rest",
      "aria-label": `Rest time for set ${index + 1} of ${exerciseName}: ${formatRest(row.seconds)}. Tap to change.`,
      onClick: () => {
        ctx.state.log.editingRestId = row.id;
        return ctx.rerender();
      },
    });
  }
  return h("div", { class: "rest-line", "data-timer-for": row.id }, time, icon);
}

function plannedFields(ctx, row, index, exerciseName) {
  const { logger } = ctx.services;
  // data-saved is what the plan holds for this input; pull-to-refresh compares it with
  // what is typed to know whether a reload would lose text.
  const save = (input, field) => {
    const sent = input.value;
    return logger.updatePlannedSet(row.id, { [field]: sent }).then(() => { input.dataset.saved = sent; }, () => {});
  };
  const reps = h("input", {
    type: "text", inputmode: "numeric", autocomplete: "off", "data-field": "reps", value: row.reps, "data-saved": row.reps,
    "aria-label": `Reps, set ${index + 1} of ${exerciseName}`, onChange: (event) => save(event.target, "reps"),
  });
  const weight = h("input", {
    type: "text", inputmode: "decimal", autocomplete: "off", "data-field": "weight", value: row.weight, "data-saved": row.weight,
    "aria-label": `Weight, set ${index + 1} of ${exerciseName}`, onChange: (event) => save(event.target, "weight"),
  });
  const unit = h(
    "select",
    {
      "data-field": "unit", "aria-label": `Weight unit, set ${index + 1} of ${exerciseName}`,
      onChange: (event) => save(event.target, "unit"),
    },
    WEIGHT_UNITS.map((value) => h("option", { value, selected: value === row.unit }, value)),
  );
  return { reps, weight, unit, element: h("span", { class: "set-fields" }, reps, " reps ", weight, unit) };
}

function setRow(ctx, row, index, exerciseName) {
  const { logger } = ctx.services;
  const logged = row.kind === "logged";
  let fields = null;
  let content;
  if (logged) {
    content = h("span", { class: "set-text" }, rowLine(row, index, ctx.unit));
  } else {
    fields = plannedFields(ctx, row, index, exerciseName);
    content = h("span", { class: "set-planned" }, h("span", { class: "set-index" }, `${index + 1}.`), fields.element);
  }
  const toggle = button("✓", {
    class: "check-toggle",
    "data-action": "toggle-set",
    "data-set-id": row.id,
    "aria-pressed": String(logged),
    "aria-label": `${logged ? "Uncheck" : "Check"} set ${index + 1} of ${exerciseName}`,
    onClick: () => perform(ctx, async () => {
      if (logged) await logger.uncheckSet(row.id);
      else await logger.checkSet(row.id, { reps: fields.reps.value, weight: fields.weight.value, unit: fields.unit.value });
    }),
  });
  return h(
    "li",
    { class: "set-row", "data-set-id": row.id, "data-phase": row.phase, "data-kind": row.kind, "data-warmup": row.isWarmup ? "true" : null },
    h("div", { class: "set-main" }, content, toggle, deleteControl(ctx, row, exerciseName, index)),
    restLine(ctx, row, index, exerciseName),
  );
}

// The inline form behind Update Rest Timers: one default rest for the exercise.
function defaultRestEditor(ctx, block) {
  const log = ctx.state.log;
  const input = h("input", {
    type: "text", inputmode: "numeric", autocomplete: "off", "data-field": "default-rest",
    "aria-label": `Default rest for ${block.exerciseName} (minutes:seconds)`, value: formatRest(block.defaultRestSeconds),
    "data-saved": formatRest(block.defaultRestSeconds),
  });
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "default-rest-error" });
  return h(
    "form",
    {
      class: "rest-editor",
      "data-region": "default-rest-editor",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          await ctx.services.logger.updateRestTimers(block.exerciseId, parseRest(input.value));
          log.editingDefaultFor = null;
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    h(
      "p",
      { class: "muted" },
      `Default rest for ${block.exerciseName}. It also applies to this exercise's unchecked sets in this workout. `
      + "Checked sets keep the rest they were logged with.",
    ),
    input,
    h("button", { type: "submit", class: "small primary", "data-action": "save-default-rest" }, "Save"),
    button("Cancel", {
      class: "small",
      "data-action": "cancel-default-rest",
      onClick: () => {
        log.editingDefaultFor = null;
        return ctx.rerender();
      },
    }),
    error,
  );
}

// The exercise's name and its three-dot menu.
function blockHeader(ctx, block) {
  const log = ctx.state.log;
  const open = log.menuExerciseId === block.exerciseId;
  const header = h(
    "div",
    { class: "entry-head" },
    h("h3", {}, block.exerciseName),
    button("⋮", {
      class: "menu-button",
      "data-action": "exercise-menu",
      "data-exercise-id": block.exerciseId,
      "aria-label": `Options for ${block.exerciseName}`,
      "aria-haspopup": "menu",
      "aria-expanded": String(open),
      onClick: () => {
        log.menuExerciseId = open ? null : block.exerciseId;
        return ctx.rerender();
      },
    }),
  );
  if (open) {
    header.append(h(
      "div",
      { class: "menu", role: "menu" },
      button("Update Rest Timers", {
        class: "small",
        role: "menuitem",
        "data-action": "update-rest-timers",
        "data-exercise-id": block.exerciseId,
        onClick: () => {
          log.menuExerciseId = null;
          log.editingDefaultFor = block.exerciseId;
          return ctx.rerender();
        },
      }),
    ));
  }
  return header;
}

// One block per exercise: its rows and an Add set button (which shows no timer).
export function exerciseBlocks(ctx, blocks) {
  return h(
    "div",
    { class: "entries", "data-region": "exercise-blocks" },
    blocks.map((block) => h(
      "div",
      { class: "entry", "data-exercise-id": block.exerciseId },
      blockHeader(ctx, block),
      ctx.state.log.editingDefaultFor === block.exerciseId ? defaultRestEditor(ctx, block) : null,
      h("ol", { class: "sets" }, block.rows.map((row, index) => setRow(ctx, row, index, block.exerciseName))),
      button("Add set", {
        class: "small",
        "data-action": "add-set",
        "data-exercise-id": block.exerciseId,
        onClick: () => perform(ctx, () => ctx.services.logger.addSet(block.exerciseId)),
      }),
    )),
  );
}

// ---- the ticker ----

export function stopTicker(ctx) {
  if (typeof ctx.state.log.stopTicker === "function") ctx.state.log.stopTicker();
}

// Keeps the running timer's line current. Each tick reads the clock and computes
// the remaining time from the timer's absolute end; it also runs when the page
// becomes visible again, so a timer that ran out in the background shows as
// done at once. When the time is up the view is redrawn (the row becomes done).
export function startTicker(ctx, container, timer) {
  stopTicker(ctx);
  if (timer === null) return;
  const line = () => [...container.querySelectorAll("[data-timer-for]")].find((el) => el.dataset.timerFor === timer.setId);

  function update() {
    if (!container.isConnected) {
      stop();
      return;
    }
    const at = Date.now();
    if (!isRunning(timer, at)) {
      stop();
      ctx.rerender();
      return;
    }
    const element = line();
    if (element === undefined) return;
    const time = element.querySelector("button.rest-time");
    if (time !== null) time.textContent = formatRest(remainingSeconds(timer, at));
    paintIcon(element.querySelector(".rest-icon"), "resting", fractionRemaining(timer, at));
  }
  const onVisible = () => {
    if (document.visibilityState === "visible") update();
  };
  const interval = setInterval(update, 250);
  document.addEventListener("visibilitychange", onVisible);
  function stop() {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    if (ctx.state.log.stopTicker === stop) ctx.state.log.stopTicker = null;
  }
  ctx.state.log.stopTicker = stop;
}
