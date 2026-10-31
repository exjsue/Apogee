// The "Import from Strong" section of the Settings tab. It ADDS workouts from a Strong CSV export and is kept apart
// from the Backup import, which replaces everything. This version stops at the dry run: nothing is written.
// Parsing, matching and the plan live in src/importers; this file builds elements and keeps the user's choices in
// ctx.state.strong, so a redraw never loses one. Nothing is chosen for the user: every name starts on "Create
// custom" (a name a stored exercise already has starts with no choice), and there is no accept-all.

import { h, button } from "./dom.js";
import { WEIGHT_UNITS } from "../domain/model.js";
import { nameKey } from "../domain/exercise-names.js";
import { formatLabel, formatCount } from "../domain/format.js";
import { parseStrongCsv, buildStrongPlan } from "../importers/strong.js";
import { matchStrongNames, strongNameCounts } from "../importers/strong-match.js";
import { primaryMusclePicker } from "./workout-view.js";

const HEADING = '[data-region="strong-heading"]';
const CUSTOM = "custom";
const SKIP = "skip";
const EXISTING = "existing:";

const fresh = () => ({ fileName: null, parsed: null, rows: [], unit: null, editing: null, draft: [], plan: null, error: null });

const muscleText = (ids) => (ids.length === 0 ? "none" : ids.map(formatLabel).join(", "));
const needs = (count, what, verb) => `${formatCount(count, what)} ${count === 1 ? `${verb}s` : verb}`;

// One row per Strong name. `options` are the stored exercises the user may pick instead of a custom one.
function toRow(match) {
  const ruleA = match.status === "auto" && match.rule === "a";
  return {
    key: nameKey(match.name),
    name: match.name,
    sets: match.sets,
    workouts: match.workouts,
    status: match.status,
    rule: match.rule,
    ruleA,
    options: match.status === "auto" ? [match.target] : match.suggestions.map((s) => s.exercise),
    alias: match.suggestions[0]?.alias === true,
    // Muscles offered for a custom exercise: the matcher's, or for a match the matched exercise's.
    suggested: match.status === "auto" ? [...match.target.primaryMuscles] : [...match.muscles.ids],
    choice: ruleA ? null : CUSTOM,
    muscles: [],
  };
}

function mappingOf(rows) {
  return new Map(rows.map((row) => [row.key, row.choice === CUSTOM
    ? { kind: "custom", primaryMuscles: row.muscles }
    : row.choice === SKIP ? { kind: "skip" } : { kind: "existing", exerciseId: row.choice.slice(EXISTING.length) }]));
}

function describeMatch(row) {
  const top = row.options[0];
  if (top === undefined) return "No similar stored exercise.";
  const what = `"${top.name}" (${muscleText(top.primaryMuscles)})`;
  if (row.ruleA) return `Same name as the stored exercise ${what}.`;
  if (row.status === "auto") return `Same as the stored exercise ${what}, with the equipment written first.`;
  return row.alias ? `Most likely ${what}, a known Strong name.` : `Closest stored exercise: ${what}.`;
}

// "UTC-5:00" from minutes east of UTC.
function offsetText(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

function reportView(plan) {
  const r = plan.report;
  const w = r.workouts;
  const when = (start) => `${start.file} (read as this device's time, ${offsetText(start.utcOffsetMinutes)})`;
  const list = (items, props = {}) => (items.length === 0 ? null : h("ul", props, items.map((item) => h("li", {}, item))));
  return h(
    "div",
    { class: "strong-report", tabindex: "-1", "data-region": "strong-report", "data-enter": "strong-report" },
    h("h3", {}, "Dry run"),
    plan.ok
      ? h("p", { class: "notice", role: "status", "data-region": "strong-report-status" }, "No errors. Nothing has been written.")
      : h("p", { class: "error", role: "alert", "data-region": "strong-report-status" }, `${formatCount(plan.errors.length, "error")}: nothing can be imported until they are fixed. Nothing has been written.`),
    list(plan.errors.map((e) => `Line ${e.line}: ${e.message}`), { class: "error", "data-region": "strong-errors" }),
    list(plan.warnings.map((e) => `Line ${e.line}: ${e.message}`), { class: "warning-text", "data-region": "strong-warnings" }),
    list([
      `Workouts in the file: ${w.total}. New: ${w.new}. Already imported: ${w.alreadyImported}. With errors: ${w.withErrors}. Empty after skips: ${w.emptyAfterSkips}.`,
      `Would add ${formatCount(w.new, "workout")}, ${formatCount(r.entries, "exercise entry", "exercise entries")} and ${formatCount(r.sets, "set")}, weights in ${r.unit}.`,
      `Of those sets: ${r.warmups} warm-up, ${r.failure} failure, ${r.drop} drop, ${r.timed} timed, ${r.bodyweight} bodyweight; ${r.rpeKept} with RPE.`,
      `New custom exercises: ${r.customExercises}.`,
      `Skipped: ${formatCount(r.dropped.skippedSets, "set")} of ${formatCount(r.dropped.skippedExercises, "name")}.`,
      r.firstStart === null ? null : `First workout: ${when(r.firstStart)}. Last: ${when(r.lastStart)}.`,
      r.merges.length === 0 ? null : `Joined into one entry (an exercise that appears more than once in a workout): ${r.merges.map((m) => `${m.date}, ${m.exercise}`).join("; ")}.`,
      `Not stored: ${r.dropped.fieldsNotStored.join("; ")}.`,
    ].filter((line) => line !== null), { "data-region": "strong-counts" }),
    h("p", { class: "muted" }, "Adding the workouts is not available yet."),
  );
}

export function renderStrongImport(ctx) {
  const { services } = ctx;
  if (!services.strongImport) return null;
  const s = (ctx.state.strong ??= fresh());

  const section = (...children) => h(
    "section",
    { class: "card strong-import", "aria-label": "Import from Strong", "data-region": "strong-import" },
    h("h2", { tabindex: "-1", "data-region": "strong-heading" }, "Import from Strong"),
    h("p", {}, "Adds the workouts in a Strong export (a CSV file) to this device. It never replaces or changes anything already stored. The file is read on this device only."),
    ...children,
  );

  // The names are matched against the whole exercise library, so it must be stored first.
  const library = services.catalog ? services.catalog.getStatus() : "ready";
  if (library === "failed") {
    return section(h("p", { class: "error", role: "alert", "data-region": "strong-library" }, "The exercise library could not be loaded, so names cannot be matched. Apogee will try again the next time it opens."));
  }
  if (library !== "ready") {
    return section(h("p", { class: "muted", role: "status", "data-region": "strong-library" }, "Loading the exercise library… The import is ready when it finishes."));
  }

  const act = (run, focus = HEADING) => async () => {
    try {
      await run();
      s.error = null;
    } catch (error) {
      s.error = error.message;
    }
    ctx.state.focus = focus;
    await ctx.rerender();
  };
  // Any change of a choice makes the last dry run out of date.
  const change = (run, focus) => act(async () => { run(); s.plan = null; }, focus);

  const fileInput = h("input", {
    type: "file",
    accept: ".csv,text/csv,text/plain",
    "data-field": "strong-file",
    onChange: (event) => {
      const chosen = event.target.files?.[0];
      if (!chosen) return undefined;
      return act(async () => {
        Object.assign(s, fresh(), { fileName: chosen.name });
        const parsed = parseStrongCsv(await services.readFileAsText(chosen));
        if (parsed.fatal) throw new Error(`The file cannot be imported: ${parsed.fatal}`);
        const { exercises } = await services.strongImport.readContext();
        s.rows = matchStrongNames(strongNameCounts(parsed.workouts), exercises).map(toRow);
        s.parsed = parsed;
      }, '[data-field="strong-file"]')();
    },
  });

  const children = [
    h("label", { class: "field" }, h("span", {}, "Choose a Strong export file"), fileInput),
    s.fileName === null ? null : h("p", { class: "muted", "data-region": "strong-file-name" }, `File: ${s.fileName}`),
    s.error === null ? null : h("p", { class: "error", role: "alert", "data-region": "strong-error" }, s.error),
  ];
  if (s.parsed === null) return section(...children);

  const unitButtons = WEIGHT_UNITS.map((unit) => button(unit, {
    class: "unit-button",
    "aria-pressed": String(s.unit === unit),
    "data-action": "strong-unit",
    "data-unit": unit,
    onClick: change(() => { s.unit = unit; }, `[data-action="strong-unit"][data-unit="${unit}"]`),
  }));

  const rowView = (row, i) => {
    const choiceSelector = (value) => `[data-action="strong-choice"][data-row="${i}"][value="${CSS.escape(value)}"]`;
    const radio = (value, label, disabled = false) => h(
      "label",
      { class: "check" },
      h("input", {
        type: "radio", name: `strong-choice-${i}`, value, checked: row.choice === value, disabled,
        "data-action": "strong-choice", "data-row": String(i),
        onChange: change(() => { row.choice = value; }, choiceSelector(value)),
      }),
      label,
    );
    const item = h(
      "li",
      { "data-row": String(i), "data-name": row.name },
      h("p", { class: "strong-name" }, h("strong", {}, row.name), ` · ${formatCount(row.sets, "set")} in ${formatCount(row.workouts, "workout")}`),
      h("p", { class: "muted", "data-region": "strong-match" }, describeMatch(row)),
      row.ruleA
        ? h("p", { class: "muted", "data-region": "strong-rule-a" }, "A custom exercise cannot be made: a stored exercise already has this name. Use it or skip this name.")
        : null,
      h(
        "fieldset",
        { class: "strong-choices" },
        h("legend", { class: "visually-hidden" }, `What to do with ${row.name}`),
        radio(CUSTOM, "Create a custom exercise with this name", row.ruleA),
        row.options.map((exercise) => radio(`${EXISTING}${exercise.id}`, `Use "${exercise.name}" (${muscleText(exercise.primaryMuscles)})`)),
        radio(SKIP, "Skip (its sets are left out)"),
      ),
    );
    if (row.choice !== CUSTOM) return item;
    const same = row.muscles.length === row.suggested.length && row.muscles.every((id) => row.suggested.includes(id));
    item.append(h(
      "div",
      { class: "actions strong-muscles" },
      h("span", { "data-region": "strong-muscles" }, row.muscles.length === 0 ? "Muscles: none chosen yet" : `Muscles: ${muscleText(row.muscles)}`),
      row.suggested.length === 0 || same ? null : button(`Use suggested muscles (${muscleText(row.suggested)})`, {
        class: "small",
        "data-action": "strong-use-suggested",
        "data-row": String(i),
        onClick: change(() => { row.muscles = [...row.suggested]; }, `[data-action="strong-choose-muscles"][data-row="${i}"]`),
      }),
      button("Choose muscles", {
        class: "small",
        "data-action": "strong-choose-muscles",
        "data-row": String(i),
        onClick: act(async () => { Object.assign(s, { editing: i, draft: [...row.muscles] }); }, `[data-region="strong-picker"] input`),
      }),
    ));
    if (s.editing === i) {
      // The ticks are copied into state as they change, so a redraw in the background keeps them.
      const picker = primaryMusclePicker("strong-primary", s.draft);
      picker.element.addEventListener("change", () => { s.draft = picker.selected(); });
      const back = `[data-action="strong-choose-muscles"][data-row="${i}"]`;
      item.append(h(
        "div",
        { "data-region": "strong-picker", "data-enter": `strong-picker:${i}` },
        picker.element,
        h(
          "div",
          { class: "actions" },
          button("Done", {
            class: "primary small",
            "data-action": "strong-muscles-done",
            onClick: change(() => {
              row.muscles = [...s.draft];
              Object.assign(s, { editing: null, draft: [] });
            }, back),
          }),
          button("Cancel", { class: "small", "data-action": "strong-muscles-cancel", onClick: act(async () => { Object.assign(s, { editing: null, draft: [] }); }, back) }),
        ),
      ));
    }
    return item;
  };

  // The one helper: names still on "Create custom" with no muscles get their suggested ones. Never picks an exercise.
  const fillable = s.rows.filter((row) => row.choice === CUSTOM && row.muscles.length === 0 && row.suggested.length > 0);
  const unchosen = s.rows.filter((row) => row.choice === null).length;
  const bare = s.rows.filter((row) => row.choice === CUSTOM && row.muscles.length === 0).length;
  const blockers = [
    s.unit === null ? "Choose lb or kg." : null,
    unchosen === 0 ? null : `${needs(unchosen, "name", "need")} a choice.`,
    bare === 0 ? null : `${needs(bare, "custom exercise", "need")} muscles.`,
  ].filter((text) => text !== null);

  children.push(
    h(
      "div",
      { class: "strong-unit" },
      h("h3", {}, "Weight unit of the file"),
      h("p", { class: "muted" }, "Strong's file does not say which unit its weights are in. Choose the one your Strong app used."),
      h("div", { class: "units", role: "group", "aria-label": "Weight unit of the file" }, unitButtons),
    ),
    h("h3", {}, `Exercise names (${s.rows.length})`),
    h("p", { class: "muted" }, "Each name becomes a custom exercise unless you pick a stored one or skip it. Suggestions are never taken unless you pick them."),
    h("div", { class: "actions" }, button("Make all remaining custom exercises with their suggested muscles", {
      class: "small",
      "data-action": "strong-fill-muscles",
      disabled: fillable.length === 0,
      onClick: change(() => { for (const row of fillable) row.muscles = [...row.suggested]; }, '[data-action="strong-fill-muscles"]'),
    })),
    h("ul", { class: "strong-names", "data-region": "strong-names" }, s.rows.map(rowView)),
    blockers.length === 0 ? null : h("p", { class: "muted", "data-region": "strong-blockers" }, blockers.join(" ")),
    h("div", { class: "actions" }, button("Dry run: show what would be added", {
      class: "primary",
      "data-action": "strong-dry-run",
      disabled: blockers.length > 0,
      onClick: act(async () => {
        const existing = await services.strongImport.readContext();
        s.plan = await buildStrongPlan({ parsed: s.parsed, unit: s.unit, mapping: mappingOf(s.rows), existing });
      }, '[data-region="strong-report"]'),
    })),
    s.plan === null ? null : reportView(s.plan),
  );
  return section(...children);
}
