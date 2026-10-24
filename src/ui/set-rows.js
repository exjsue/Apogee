// The exercise blocks of the Log tab: a header row, then one row per set (set
// number, weight, reps, the check, a compact delete), the rest line under each row,
// and the ticker that keeps a running timer on screen. Only builds elements and
// passes input to the logger; every rule (what can be checked, how a timer
// behaves) lives in src/app and src/domain.

import { h, button, exerciseHeading } from "./dom.js";
import { formatSetWeightParts } from "../domain/format.js";
import {
  formatRest, parseRestEntry, previewRestEntry, restToDigits, pieGeometry, isRunning, remainingSeconds, fractionRemaining,
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

// ---- delete: a small × in the row, and the question on a line of its own ----

function deleteButton(ctx, row, exerciseName, index) {
  const log = ctx.state.log;
  return button("×", {
    class: "delete-button",
    "data-action": "delete-set",
    "aria-label": `Delete set ${index + 1} of ${exerciseName}`,
    onClick: () => {
      log.confirmDeleteSetId = row.id;
      return ctx.rerender();
    },
  });
}

function deleteConfirm(ctx, row) {
  const log = ctx.state.log;
  return h(
    "div",
    { class: "delete-confirm", role: "group", "aria-label": "Confirm delete" },
    h("span", {}, "Delete this set?"),
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

// ---- typing a rest time: digits only, like a microwave timer ----

// The field both rest editors use. It starts with the current rest as digits ("300"
// for 3:00) and shows, as you type, the time it will be read as.
function restField(fieldName, label, seconds) {
  const digits = restToDigits(seconds);
  const input = h("input", {
    type: "text", inputmode: "numeric", enterkeyhint: "done", autocomplete: "off",
    "data-field": fieldName, "aria-label": label, value: digits, "data-saved": digits,
  });
  const preview = h("span", { class: "rest-preview", "data-region": "rest-preview", "aria-live": "polite" });
  const show = () => {
    const read = previewRestEntry(input.value);
    preview.textContent = read.ok ? `= ${read.label}` : "";
  };
  input.addEventListener("input", show);
  show();
  return { input, preview };
}

function restEditor(ctx, row) {
  const log = ctx.state.log;
  const { input, preview } = restField("rest", "Rest time in digits: 300 means 3:00", row.restSeconds);
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "rest-error" });
  return h(
    "form",
    {
      class: "rest-editor",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          await ctx.services.logger.setRest(row.id, parseRestEntry(input.value));
          log.editingRestId = null;
          await ctx.rerender();
        } catch (caught) {
          error.textContent = caught.message;
          error.hidden = false;
        }
      },
    },
    input,
    preview,
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
    return h("div", { class: "rest-line editing", "data-timer-for": row.id }, restEditor(ctx, row));
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

// ---- the cells of a row ----

// An unchecked row: a weight field with its unit written after it, and a reps field.
// The unit is the one the weight will be STORED in: the row's own once it has a weight
// (a prefilled or restored weight is never silently read in another unit), and the
// app's kg/lb choice while the weight is still blank. There is no per-row choice.
function plannedCells(ctx, row, index, exerciseName) {
  const { logger } = ctx.services;
  const unit = row.weight.trim() === "" ? ctx.unit : row.unit;
  // data-saved is what the plan holds for this input; pull-to-refresh compares it with
  // what is typed to know whether a reload would lose text.
  const save = (input, fields) => {
    const sent = input.value;
    return logger.updatePlannedSet(row.id, fields(sent)).then(() => { input.dataset.saved = sent; }, () => {});
  };
  const weight = h("input", {
    type: "text", inputmode: "decimal", enterkeyhint: "next", autocomplete: "off", "data-field": "weight",
    value: row.weight, "data-saved": row.weight, "aria-label": `Weight in ${unit}, set ${index + 1} of ${exerciseName}`,
    onChange: (event) => save(event.target, (sent) => ({ weight: sent, unit })),
  });
  const reps = h("input", {
    type: "text", inputmode: "numeric", enterkeyhint: "done", autocomplete: "off", "data-field": "reps",
    value: row.reps, "data-saved": row.reps, "aria-label": `Reps, set ${index + 1} of ${exerciseName}`,
    onChange: (event) => save(event.target, (sent) => ({ reps: sent })),
  });
  return {
    weight,
    reps,
    unit,
    weightCell: h("span", { class: "cell cell-weight" }, weight, h("span", { class: "unit-suffix" }, unit)),
    repsCell: h("span", { class: "cell cell-reps" }, reps),
  };
}

// A checked row: the same cells as plain text. The weight is shown in the app's
// kg/lb choice, with the unit it was entered in on a small line of its own when that differs.
function loggedCells(ctx, row) {
  const parts = formatSetWeightParts(row.weight, row.unit, ctx.unit);
  return {
    weightCell: h(
      "span",
      { class: "cell cell-weight cell-text", "data-cell": "weight" },
      h("span", { class: "cell-value" }, parts.text),
      parts.entered === null ? null : h("span", { class: "cell-note" }, `entered ${parts.entered}`),
    ),
    repsCell: h("span", { class: "cell cell-reps cell-text", "data-cell": "reps" }, String(row.reps)),
  };
}

function setRow(ctx, row, index, exerciseName) {
  const { logger } = ctx.services;
  const logged = row.kind === "logged";
  // What changed since the last drawing, so that only that animates (see the motion block in
  // app.css). `seen` is null on the first drawing and after a tab switch: nothing animates then.
  const seen = ctx.state.log.seen;
  const was = seen === null ? undefined : seen.get(row.id);
  const added = seen !== null && was === undefined;
  const toggled = was !== undefined && was.kind !== row.kind;
  const phaseChanged = was !== undefined && was.phase !== row.phase;
  const planned = logged ? null : plannedCells(ctx, row, index, exerciseName);
  const cells = logged ? loggedCells(ctx, row) : planned;
  const toggle = button("✓", {
    class: "check-toggle",
    "data-action": "toggle-set",
    "data-set-id": row.id,
    "aria-pressed": String(logged),
    "aria-label": `${logged ? "Uncheck" : "Check"} set ${index + 1} of ${exerciseName}`,
    "data-anim": toggled ? (logged ? "check" : "uncheck") : null,
    onClick: () => perform(ctx, async () => {
      if (logged) await logger.uncheckSet(row.id);
      else await logger.checkSet(row.id, { reps: planned.reps.value, weight: planned.weight.value, unit: planned.unit });
    }),
  });
  const line = restLine(ctx, row, index, exerciseName);
  if (line !== null && phaseChanged) line.dataset.anim = "phase";
  return h(
    "li",
    {
      class: "set-row", "data-set-id": row.id, "data-phase": row.phase, "data-kind": row.kind,
      "data-warmup": row.isWarmup ? "true" : null, "data-anim": added ? "add" : null,
    },
    h(
      "div",
      { class: "set-main set-grid" },
      h("span", { class: "set-num" }, String(index + 1)),
      cells.weightCell,
      cells.repsCell,
      toggle,
      deleteButton(ctx, row, exerciseName, index),
    ),
    ctx.state.log.confirmDeleteSetId === row.id ? deleteConfirm(ctx, row) : null,
    line,
  );
}

// The column titles above an exercise's rows. They repeat what each field's own
// label says, so a screen reader skips them.
function setHead() {
  return h(
    "div",
    { class: "set-head set-grid", "aria-hidden": "true" },
    h("span", {}, "Set"),
    h("span", {}, "Weight"),
    h("span", {}, "Reps"),
    h("span", { class: "head-check" }, "Done"),
    h("span", {}),
  );
}

// The inline form behind Update Rest Timers: one default rest for the exercise.
function defaultRestEditor(ctx, block) {
  const log = ctx.state.log;
  const { input, preview } = restField(
    "default-rest", `Default rest for ${block.exerciseName} in digits: 300 means 3:00`, block.defaultRestSeconds,
  );
  const error = h("p", { class: "error", role: "alert", hidden: true, "data-region": "default-rest-error" });
  return h(
    "form",
    {
      class: "rest-editor",
      "data-region": "default-rest-editor",
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          await ctx.services.logger.updateRestTimers(block.exerciseId, parseRestEntry(input.value));
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
      + "Checked sets keep the rest they were logged with. Type the time as digits: 300 is 3:00.",
    ),
    input,
    preview,
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
    exerciseHeading(block.exerciseName, block.markCustom),
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

// One block per exercise: its header row, its rows and an Add set button (which shows no timer).
export function exerciseBlocks(ctx, blocks) {
  const element = h(
    "div",
    { class: "entries", "data-region": "exercise-blocks" },
    blocks.map((block) => h(
      "div",
      { class: "entry", "data-exercise-id": block.exerciseId },
      blockHeader(ctx, block),
      ctx.state.log.editingDefaultFor === block.exerciseId ? defaultRestEditor(ctx, block) : null,
      setHead(),
      h("ol", { class: "sets" }, block.rows.map((row, index) => setRow(ctx, row, index, block.exerciseName))),
      button("Add set", {
        class: "small",
        "data-action": "add-set",
        "data-exercise-id": block.exerciseId,
        onClick: () => perform(ctx, () => ctx.services.logger.addSet(block.exerciseId)),
      }),
    )),
  );
  // Remembered for the next drawing, which animates only what differs from this one.
  ctx.state.log.seen = new Map(blocks.flatMap((block) => block.rows.map((row) => [row.id, { kind: row.kind, phase: row.phase }])));
  return element;
}

// ---- the ticker ----

export function stopTicker(ctx) {
  if (typeof ctx.state.log.stopTicker === "function") ctx.state.log.stopTicker();
}

// A timer that ran out: the set's row becomes "done" and its rest line shows 0:00 with no pie,
// exactly what restLine draws for a done set, without touching any other element (so a field
// being typed in keeps its text, cursor and focus). Returns false when there is no such row.
// A rest line that is open for editing is left alone (its text is the user's); the next
// drawing, which the editor's Save or Cancel causes, shows the set as done.
function settleExpired(ctx, container, setId) {
  const row = [...container.querySelectorAll("li.set-row")].find((el) => el.dataset.setId === setId);
  if (row === undefined) return false;
  const line = row.querySelector(".rest-line");
  if (line === null || line.classList.contains("editing")) return line !== null;
  const icon = newIcon();
  paintIcon(icon, "done", 0);
  line.replaceChildren(h("span", { class: "rest-time", "data-region": "rest-time" }, "0:00"), icon);
  line.dataset.anim = "phase";
  row.dataset.phase = "done";
  const seen = ctx.state.log.seen;
  if (seen !== null && seen.has(setId)) seen.set(setId, { ...seen.get(setId), phase: "done" });
  return true;
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
      // Nobody tapped, so the view is not redrawn over a field being typed in: only this
      // set's rest line changes, in place. If it cannot (the row is gone), a redraw that
      // waits for typing to finish.
      if (!settleExpired(ctx, container, timer.setId)) ctx.rerenderInBackground();
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
