// UI smoke tests. Browser only: they mount the real UI into the page against a
// throwaway IndexedDB database and drive it with clicks and typing, the way a
// person would. They check that the screens are wired to the logic, not how
// they look. Not run by node --test.

import { createStore } from "../../src/storage/store.js";
import { createBackup } from "../../src/backup/backup.js";
import { createLogger } from "../../src/app/logger.js";
import { checkPersistence } from "../../src/app/persistence.js";
import { showDatabaseNotice } from "../../src/ui/db-notices.js";
import { installPullToRefresh } from "../../src/ui/pull-refresh.js";
import { SEED_EXERCISES, SEED_VERSION } from "../../src/domain/seed.js";
import { mountApp } from "../../src/ui/app.js";
import { createOffline, CACHE_PREFIX } from "../../src/app/offline.js";
import { createCatalogService, startAfterFirstPaint } from "../../src/app/catalog.js";
import { createCatalogStore } from "../../src/storage/catalog-store.js";
import { EXERCISE, makeDetails, rawCounts } from "../store-rules.js";
import { incomingFile } from "../backup-rules.js";

export const uiRules = [];
const rule = (name, run) => uiRules.push({ name, run });

const HOUR = 60 * 60 * 1000;
const BENCH = "seed-barbell-bench-press";

// ---- helpers ----

const $ = (root, css) => root.querySelector(css);
const action = (root, name) => $(root, `[data-action="${name}"]`);
const field = (root, name) => $(root, `[data-field="${name}"]`);
const region = (root, name) => $(root, `[data-region="${name}"]`);
const click = (element) => element.click();

function setValue(element, value) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitFor(check, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = check();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const waitForText = (root, text) => waitFor(() => root.textContent.includes(text), `the text "${text}"`);

// Mounts the app against a fresh seeded database and cleans up afterwards. `catalog` is a library service,
// or a function that makes one from the adapter.
async function withApp(ctx, body, { prepare, offline, catalog, width, fontSize } = {}) {
  const adapter = ctx.createAdapter();
  const store = createStore(adapter);
  await store.open();
  await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
  if (prepare) await prepare(store);
  const calls = { downloads: [], persist: 0 };
  const services = {
    logger: createLogger(store),
    backup: createBackup(adapter),
    downloadBlob: (blob, filename) => calls.downloads.push({ blob, filename }),
    readFileAsText: (file) => file.text(),
    persistence: {
      getStatus: () => store.getPersistStatus(),
      check: () => checkPersistence({
        request: async () => {
          calls.persist += 1;
          return { supported: true, persisted: false, error: null };
        },
        store,
      }),
    },
    ...(offline ? { offline } : {}),
    ...(catalog ? { catalog: typeof catalog === "function" ? catalog(adapter) : catalog } : {}),
  };
  // With a width, the app is mounted into an iframe of that width that loads the real stylesheet, so
  // the layout can be measured; the page's own styles are not touched.
  let frame = null;
  const root = document.createElement("div");
  if (width) {
    frame = document.createElement("iframe");
    frame.style.width = `${width}px`;
    frame.style.height = "4000px"; // tall enough that the frame has no scroll bar of its own to narrow it
    frame.style.border = "0";
    frame.srcdoc = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="../../src/ui/app.css"><body>';
    document.body.append(frame);
    await waitFor(() => frame.contentDocument.body && frame.contentDocument.styleSheets.length > 0 && frame.contentDocument.styleSheets[0].cssRules.length > 0, "the stylesheet in the frame");
    if (fontSize) frame.contentDocument.documentElement.style.fontSize = fontSize;
    root.id = "app"; // the page's own wrapper, which sets the side gutters
    frame.contentDocument.body.append(root);
  } else {
    document.body.append(root); // forms only submit when they are in the document
  }
  let app = null;
  try {
    app = await mountApp(root, services);
    await body({ root, store, adapter, services, calls, app, frame });
  } finally {
    root.remove(); // also stops any ticker, which only runs while its view is on the page
    if (frame !== null) frame.remove();
    if (app !== null) await app.idle(); // let a render that is still reading finish before the database is closed
  }
}

// The unchecked rows on screen, and the last one (the one to fill in).
const plannedRows = (root) => [...root.querySelectorAll('li.set-row[data-kind="planned"]')];
const loggedRows = (root) => [...root.querySelectorAll('li.set-row[data-kind="logged"]')];
const lastPlanned = (root) => plannedRows(root).at(-1);
const errorText = (root) => (region(root, "view-error") ? region(root, "view-error").textContent : "");

// Choosing an exercise puts it in the session with one unchecked row.
async function pickExercise(root, query, id) {
  click(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
  setValue(await waitFor(() => field(root, "search"), "the search box"), query);
  click(await waitFor(() => $(root, `[data-action="pick-exercise"][data-exercise-id="${id}"]`), "the exercise in the list"));
  await waitFor(() => lastPlanned(root), "the first unchecked row");
}

// The kg/lb toggle lives in the Settings tab. A row has no unit menu of its own: a blank row
// is entered in the unit chosen there. So entering a set in a unit means choosing that unit
// first, then coming back to the Log tab.
async function chooseUnit(root, unit) {
  await goToTab(root, "settings");
  const toggle = $(root, `[data-action="set-unit"][data-unit="${unit}"]`);
  if (toggle.getAttribute("aria-pressed") !== "true") {
    click(toggle);
    await waitFor(() => $(root, `[data-action="set-unit"][data-unit="${unit}"]`).getAttribute("aria-pressed") === "true", `the ${unit} choice`);
  }
}

async function useUnit(root, unit) {
  await chooseUnit(root, unit);
  await goToTab(root, "log");
}

// Types into the last unchecked row and taps its check.
async function submitSet(root, reps, weight, unit = "kg") {
  await useUnit(root, unit);
  const row = lastPlanned(root);
  setValue(row.querySelector('[data-field="reps"]'), reps);
  setValue(row.querySelector('[data-field="weight"]'), weight);
  click(row.querySelector('[data-action="toggle-set"]'));
}

// Logs one set: adds a row if none is waiting, fills it and checks it.
async function logOneSet(root, reps, weight, unit) {
  const before = loggedRows(root).length;
  if (!lastPlanned(root)) {
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    await waitFor(() => lastPlanned(root), "a new unchecked row");
  }
  await submitSet(root, reps, weight, unit);
  await waitFor(() => loggedRows(root).length === before + 1, "the set to be logged");
}

// The aria-label of the section each tab draws (History may show a workout's detail instead of the list).
// aria-current alone is not enough: an older render still in flight sets it from state.tab while it draws
// the previous tab's content, so the content itself must be waited for.
const TAB_CONTENT = { log: ["New"], history: ["History", "Workout detail"], backup: ["Backup"], settings: ["Settings"] };
const goToTab = async (root, tab) => {
  click($(root, `[data-action="tab"][data-tab="${tab}"]`));
  await waitFor(() => $(root, `[data-action="tab"][data-tab="${tab}"]`).getAttribute("aria-current") === "page", `the ${tab} tab`);
  await waitFor(() => TAB_CONTENT[tab].includes($(root, "#view > section.view")?.getAttribute("aria-label")), `the ${tab} tab's content`);
};

// ---- tests ----

rule("ui: the app mounts with the log screen and four tabs; the unit toggle is only in Settings", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    ctx.assert.ok(root.textContent.includes("Apogee"));
    ctx.assert.ok(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
    ctx.assert.deepEqual([...root.querySelectorAll('[data-action="tab"]')].map((b) => b.dataset.tab), ["log", "history", "backup", "settings"]);
    ctx.assert.equal(root.querySelectorAll('[data-action="set-unit"]').length, 0); // not in the header, not on Log
    ctx.assert.ok(root.textContent.includes("No workout in progress"));
    await goToTab(root, "settings");
    ctx.assert.equal(root.querySelectorAll('[data-action="set-unit"]').length, 2);
    const pressed = [...root.querySelectorAll('[data-action="set-unit"]')].filter((b) => b.getAttribute("aria-pressed") === "true");
    ctx.assert.deepEqual(pressed.map((b) => b.dataset.unit), ["lb"]); // the default
  });
});

rule("ui: choosing an exercise adds an unchecked row; checking it logs the set in the current workout", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    ctx.assert.ok(root.textContent.includes("Barbell bench press"));
    // nothing is logged until a row is checked
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
    ctx.assert.ok(root.textContent.includes("No workout in progress"));
    await logOneSet(root, "8", "100", "kg");
    await waitForText(root, "Started");
    const logged = () => $(root, 'li[data-kind="logged"]');
    ctx.assert.equal(logged().querySelector('[data-cell="reps"]').textContent, "8");
    ctx.assert.equal(logged().querySelector('[data-cell="weight"] .cell-note'), null); // entered in kg, shown in kg
    // stored in kg; with the display switched to lb it shows the converted weight and what was entered
    await chooseUnit(root, "lb");
    await goToTab(root, "log");
    await waitFor(() => logged().querySelector('[data-cell="weight"] .cell-value').textContent === "220.5 lb", "the weight in lb");
    ctx.assert.equal(logged().querySelector('[data-cell="weight"] .cell-note').textContent, "entered 100 kg");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
    // Add set gives a new blank unchecked row whose ghost (placeholder) is the last set, shown in the selected unit
    click(action(root, "add-set"));
    const next = await waitFor(() => lastPlanned(root), "the new row");
    ctx.assert.equal(next.querySelector('[data-field="reps"]').placeholder, "8");
    ctx.assert.equal(next.querySelector('[data-field="weight"]').placeholder, "220.5"); // the 100 kg ghost, shown in the selected lb
    ctx.assert.equal(next.querySelector(".unit-suffix").textContent, "lb");
  });
});

rule("ui: a blank weight or blank reps shows an error, keeps the row unchecked and logs nothing", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await submitSet(root, "8", "   ");
    await waitFor(() => /weight is required/.test(errorText(root)), "the weight error");
    await submitSet(root, "", "100");
    await waitFor(() => /reps is required/.test(errorText(root)), "the reps error");
    await submitSet(root, "8", "1,500");
    await waitFor(() => /weight must be a number/.test(errorText(root)), "the weight format error");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
    ctx.assert.equal(plannedRows(root).length, 1);
    await submitSet(root, "8", "0"); // an explicit zero is bodyweight
    await waitForText(root, "Bodyweight");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  });
});

rule("ui: negative and too-large numbers say what is wrong", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await submitSet(root, "8", "-3");
    await waitFor(() => errorText(root) === "weight can't be negative", "the negative weight message");
    await submitSet(root, "-3", "100");
    await waitFor(() => errorText(root) === "reps can't be negative", "the negative reps message");
    await submitSet(root, "920319039", "100");
    await waitFor(() => errorText(root) === "reps is above the maximum of 1000", "the reps maximum message");
    await submitSet(root, "8", "2500.5", "kg");
    await waitFor(() => errorText(root) === "weight is above the maximum of 2500 kg", "the kg maximum message");
    // A row that already holds a weight keeps the unit it was typed in, so the pound limit is
    // checked on a blank row (another exercise) with the lb choice made first.
    await pickExercise(root, "squat", "seed-barbell-squat");
    await submitSet(root, "8", "5512", "lb");
    await waitFor(() => errorText(root) === "weight is above the maximum of 5511.55 lb", "the lb maximum message");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  });
});

rule("ui: the kg/lb toggle changes what is displayed and is remembered, never what is stored", async (ctx) => {
  await withApp(ctx, async ({ root, store, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "5", "100", "kg");
    const weightCell = () => root.querySelector('li[data-kind="logged"] [data-cell="weight"]');
    await waitFor(() => weightCell().querySelector(".cell-value").textContent === "100 kg" && !weightCell().querySelector(".cell-note"), "weights shown in kg");
    ctx.assert.equal(await store.getPreferredUnit(), "kg");
    await chooseUnit(root, "lb");
    await goToTab(root, "log");
    await waitFor(() => weightCell().querySelector(".cell-value").textContent === "220.5 lb", "weights shown in lb");
    ctx.assert.equal(weightCell().querySelector(".cell-note").textContent, "entered 100 kg");
    ctx.assert.equal(await store.getPreferredUnit(), "lb");
    const sets = await adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets"));
    ctx.assert.deepEqual(sets.map((s) => [s.weightValue, s.weightUnit]), [[100, "kg"]]);
  });
});

rule("ui: changing the unit in Settings while a workout is open updates the weights shown on Log and keeps the workout", async (ctx) => {
  await withApp(ctx, async ({ root, store, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "5", "100", "kg");
    click(await waitFor(() => action(root, "add-set"), "the Add set button")); // an unchecked row stays open, entered in kg
    const open = await waitFor(() => lastPlanned(root), "the unchecked row");
    ctx.assert.equal(open.querySelector(".unit-suffix").textContent, "kg");
    const weightCell = () => root.querySelector('li[data-kind="logged"] [data-cell="weight"]');
    ctx.assert.equal(weightCell().querySelector(".cell-value").textContent, "100 kg");
    const before = await rawCounts(adapter);
    await chooseUnit(root, "lb");
    ctx.assert.equal(await store.getPreferredUnit(), "lb");
    await goToTab(root, "log");
    // the open workout is still there, its logged weight is shown converted with what was entered, and nothing was stored differently
    await waitFor(() => weightCell().querySelector(".cell-value").textContent === "220.5 lb", "the logged weight in lb");
    ctx.assert.equal(weightCell().querySelector(".cell-note").textContent, "entered 100 kg");
    ctx.assert.equal(plannedRows(root).length, 1);
    ctx.assert.equal(plannedRows(root)[0].querySelector('[data-field="weight"]').placeholder, "220.5"); // the 100 kg ghost, shown in the selected lb
    ctx.assert.equal(plannedRows(root)[0].querySelector(".unit-suffix").textContent, "lb");
    ctx.assert.deepEqual(await rawCounts(adapter), before);
    const sets = await adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets"));
    ctx.assert.deepEqual(sets.map((s) => [s.weightValue, s.weightUnit]), [[100, "kg"]]);
    // and back: kg again
    await chooseUnit(root, "kg");
    await goToTab(root, "log");
    await waitFor(() => weightCell().querySelector(".cell-value").textContent === "100 kg" && !weightCell().querySelector(".cell-note"), "the logged weight in kg again");
  });
});

rule("ui: finishing the workout puts it in History, where its sets can be opened", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(await waitFor(() => action(root, "finish") && !action(root, "finish").disabled && action(root, "finish"), "the Finish button"));
    await waitForText(root, "Workout finished");
    await waitForText(root, "No workout in progress");
    await goToTab(root, "history");
    const row = await waitFor(() => $(root, '[data-action="open-workout"]'), "a workout in History");
    ctx.assert.ok(row.textContent.includes("1 exercise · 1 set"));
    click(row);
    await waitForText(root, "Barbell bench press");
    ctx.assert.ok(root.textContent.includes("8 reps"));
    click(await waitFor(() => action(root, "back-to-history"), "the back button"));
    await waitFor(() => region(root, "history-list"), "the history list");
  });
});

// Two finished workouts, one set each: bench 8 x 100 kg, then bench 5 x 120 kg.
async function twoFinishedWorkouts(store) {
  let time = Date.now() - 48 * HOUR;
  const logger = createLogger(store, { now: () => new Date(time) });
  for (const [reps, weight] of [["8", "100"], ["5", "120"]]) {
    await logger.logSet({ exerciseId: BENCH, reps, weight, weightUnit: "kg" });
    time += 30 * 60 * 1000;
    await logger.finishWorkout();
    time += 24 * HOUR;
  }
}

rule("ui: deleting a finished workout asks first, cancel keeps it, confirm removes it", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    const rows = () => root.querySelectorAll('[data-action="open-workout"]');
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 2 });
    await goToTab(root, "history");
    await waitFor(() => rows().length === 2, "two workouts in History");

    click(rows()[0]); // the newest
    click(await waitFor(() => action(root, "delete-workout"), "the Delete workout button"));
    const confirm = await waitFor(() => region(root, "confirm-delete"), "the confirmation");
    ctx.assert.ok(confirm.textContent.includes("Delete this workout and its 1 set?"));
    ctx.assert.ok(/cannot be undone/.test(confirm.textContent));
    ctx.assert.ok(/export your data first/.test(confirm.textContent));
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 2 }); // nothing yet

    // Cancel changes nothing
    click(action(root, "cancel-delete-workout"));
    await waitFor(() => !region(root, "confirm-delete") && action(root, "delete-workout"), "the confirmation to close");
    ctx.assert.ok(action(root, "back-to-history")); // still looking at the workout
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 2 });

    // Confirm removes it and returns to the refreshed list
    click(action(root, "delete-workout"));
    click(await waitFor(() => action(root, "confirm-delete-workout"), "the confirm button"));
    await waitFor(() => region(root, "history-list") && rows().length === 1, "the list with one workout left");
    ctx.assert.equal(region(root, "notice").textContent, "Workout deleted.");
    ctx.assert.equal(action(root, "back-to-history"), null);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });

    // Deleting the last one shows the empty state
    click(rows()[0]);
    click(await waitFor(() => action(root, "delete-workout"), "the Delete workout button"));
    click(await waitFor(() => action(root, "confirm-delete-workout"), "the confirm button"));
    await waitForText(root, "No finished workouts yet");
    ctx.assert.equal(region(root, "history-list"), null);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  }, { prepare: twoFinishedWorkouts });
});

rule("ui: leaving a workout detail closes its delete confirmation", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await goToTab(root, "history");
    click(await waitFor(() => $(root, '[data-action="open-workout"]'), "a workout in History"));
    click(await waitFor(() => action(root, "delete-workout"), "the Delete workout button"));
    await waitFor(() => region(root, "confirm-delete"), "the confirmation");
    click(action(root, "back-to-history"));
    await waitFor(() => region(root, "history-list"), "the list");
    click($(root, '[data-action="open-workout"]'));
    await waitFor(() => action(root, "delete-workout"), "the plain Delete workout button again");
    ctx.assert.equal(region(root, "confirm-delete"), null); // asks again from scratch
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 2, entries: 2, sets: 2 });
  }, { prepare: twoFinishedWorkouts });
});

rule("ui: Save as template asks for a name, shows the refusal and keeps the field, then stores the template and returns focus to the button", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    await goToTab(root, "history");
    click(await waitFor(() => $(root, '[data-action="open-workout"]'), "a workout in History"));
    click(await waitFor(() => action(root, "save-template"), "the Save as template button"));
    const name = await waitFor(() => field(root, "template-name"), "the name field");
    await waitFor(() => document.activeElement === field(root, "template-name"), "focus in the name field");

    click(action(root, "confirm-save-template")); // no name
    await waitFor(() => region(root, "template-error") && !region(root, "template-error").hidden
      && region(root, "template-error").textContent.includes("name must be a non-empty string"), "the name error");
    ctx.assert.deepEqual(await store.listTemplates(), []);

    setValue(name, "  Bench   day ");
    click(action(root, "confirm-save-template"));
    await waitForText(root, 'Saved template "Bench day" with 1 exercise.');
    await waitFor(() => document.activeElement === action(root, "save-template"), "focus back on Save as template");
    const saved = await store.listTemplates();
    ctx.assert.deepEqual(saved.map((template) => [template.name, template.exercises]), [["Bench day", [{ exerciseId: BENCH, setCount: 1 }]]]);
  }, { prepare: twoFinishedWorkouts });
});

const startButton = (root, id) => $(root, `[data-action="start-template"][data-template-id="${id}"]`);
const templateButton = (root, name, id) => $(root, `[data-action="${name}"][data-template-id="${id}"]`);

rule("ui: templates on the New tab: list with exercise counts, Start (refused while rows are planned or a workout runs), rename, delete with confirm", async (ctx) => {
  const prepare = async (store) => {
    await store.saveTemplate({ id: "t-a", name: "Push", exercises: [{ exerciseId: BENCH, setCount: 3 }, { exerciseId: "seed-barbell-squat", setCount: 2 }] });
    await store.saveTemplate({ id: "t-b", name: "Push", exercises: [{ exerciseId: BENCH, setCount: 1 }] }); // same name, told apart by the count
  };
  await withApp(ctx, async ({ root, store, adapter }) => {
    await waitFor(() => region(root, "templates"), "the templates section");
    ctx.assert.deepEqual(
      [...root.querySelectorAll('[data-region="templates"] li')].map((li) => li.querySelector(".pick-name").textContent + li.querySelector(".pick-meta").textContent),
      ["Push · 2 exercises", "Push · 1 exercise"],
    );
    ctx.assert.equal(startButton(root, "t-a").getAttribute("aria-label"), 'Start "Push" (2 exercises)');

    // Start: the exercises and blank unchecked rows appear, focus goes to the workout
    click(startButton(root, "t-a"));
    await waitFor(() => plannedRows(root).length === 5, "five unchecked rows");
    await waitForText(root, 'Started from "Push".');
    await waitFor(() => document.activeElement === region(root, "current-heading"), "focus on Current workout");
    ctx.assert.equal(loggedRows(root).length, 0);

    // rows planned, no workout yet: refused with nothing added; focus stays on the Start button
    click(startButton(root, "t-b"));
    await waitFor(() => errorText(root).includes("Sets are already planned"), "the refusal");
    ctx.assert.ok(errorText(root).includes("Finish workout"));
    ctx.assert.equal(plannedRows(root).length, 5);
    await waitFor(() => document.activeElement === startButton(root, "t-b"), "focus on Start");

    // a running workout: refused too
    const first = plannedRows(root)[0];
    setValue(first.querySelector('[data-field="reps"]'), "5");
    setValue(first.querySelector('[data-field="weight"]'), "100");
    click(first.querySelector('[data-action="toggle-set"]'));
    await waitFor(() => loggedRows(root).length === 1, "a logged set");
    click(startButton(root, "t-b"));
    await waitFor(() => errorText(root).includes("A workout is already running"), "the refusal");
    ctx.assert.equal(plannedRows(root).length, 4);

    // rename: an empty name is refused and the field stays; a good one is saved
    click(templateButton(root, "rename-template", "t-b"));
    const input = await waitFor(() => field(root, "template-name"), "the rename field");
    await waitFor(() => document.activeElement === field(root, "template-name"), "focus in the rename field");
    ctx.assert.equal(input.value, "Push");
    setValue(input, "");
    click(action(root, "save-rename-template"));
    await waitFor(() => region(root, "template-error") && !region(root, "template-error").hidden, "the rename error");
    ctx.assert.equal((await store.getTemplate("t-b")).name, "Push");
    setValue(input, "Pull");
    click(action(root, "save-rename-template"));
    await waitForText(root, 'Renamed to "Pull".');
    await waitFor(() => document.activeElement === templateButton(root, "rename-template", "t-b"), "focus back on Rename");
    ctx.assert.equal((await store.getTemplate("t-b")).name, "Pull");

    // delete: Keep changes nothing; Delete removes only the template
    const before = await rawCounts(adapter);
    click(templateButton(root, "delete-template", "t-b"));
    await waitFor(() => region(root, "confirm-delete-template"), "the confirmation");
    ctx.assert.equal((await store.listTemplates()).length, 2);
    click(action(root, "cancel-delete-template"));
    await waitFor(() => !region(root, "confirm-delete-template") && document.activeElement === templateButton(root, "delete-template", "t-b"), "the confirmation to close");
    click(templateButton(root, "delete-template", "t-b"));
    click(await waitFor(() => action(root, "confirm-delete-template"), "the confirm button"));
    await waitForText(root, 'Deleted the template "Pull".');
    await waitFor(() => document.activeElement === region(root, "templates-heading"), "focus on the Templates heading");
    ctx.assert.deepEqual((await store.listTemplates()).map((template) => template.id), ["t-a"]);

    // the last one: the section goes, focus moves to the Current workout heading
    click(templateButton(root, "delete-template", "t-a"));
    click(await waitFor(() => action(root, "confirm-delete-template"), "the confirm button"));
    await waitFor(() => region(root, "templates") === null && document.activeElement === region(root, "current-heading"), "the section gone, focus on Current workout");
    ctx.assert.deepEqual(await store.listTemplates(), []);
    ctx.assert.deepEqual(await rawCounts(adapter), before);
  }, { prepare });
});

rule("ui: adding a custom exercise needs a primary muscle, then selects the new exercise", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    click(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
    click(await waitFor(() => action(root, "add-custom"), "the Add custom exercise button"));
    setValue(await waitFor(() => field(root, "custom-name"), "the name field"), "  My   cable fly ");
    click(action(root, "save-custom"));
    await waitFor(() => region(root, "custom-error") && !region(root, "custom-error").hidden, "the muscle error");
    ctx.assert.ok(/at least one muscle/.test(region(root, "custom-error").textContent));
    root.querySelector('input[data-group="primary"][value="chest"]').checked = true;
    root.querySelector('input[data-group="secondary"][value="front_delts"]').checked = true;
    root.querySelector('input[data-group="equipment"][value="cable"]').checked = true;
    click(action(root, "save-custom"));
    await waitFor(() => lastPlanned(root), "the first row for the new exercise");
    ctx.assert.ok(root.textContent.includes("My cable fly"));
    const saved = (await store.listExercises()).find((exercise) => exercise.name === "My cable fly");
    ctx.assert.ok(saved && saved.isCustom === true);
    ctx.assert.deepEqual(saved.primaryMuscles, ["chest"]);
  });
});

rule("ui: deleting a set and discarding the workout both ask first", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    await logOneSet(root, "6", "100", "kg");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });

    click(await waitFor(() => action(root, "delete-set"), "a Delete button"));
    await waitForText(root, "Delete this set?");
    click(action(root, "keep-set"));
    await waitFor(() => !root.textContent.includes("Delete this set?"), "the confirmation to close");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });

    click(action(root, "delete-set"));
    await waitForText(root, "Delete this set?");
    click(action(root, "confirm-delete-set"));
    await waitFor(() => root.querySelectorAll("li[data-set-id]").length === 1, "one set left");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });

    click(action(root, "discard"));
    await waitForText(root, "Discard this workout and its 1 set?");
    click(action(root, "keep-workout"));
    await waitFor(() => action(root, "discard"), "the discard button again");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });

    click(action(root, "discard"));
    click(await waitFor(() => action(root, "confirm-discard"), "the confirm button"));
    await waitForText(root, "Workout discarded.");
    await waitForText(root, "No workout in progress");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  });
});

async function staleSetup(store) {
  await store.saveExercise(EXERCISE);
  const d = makeDetails("old", 1, 2);
  await store.saveWorkoutWithDetails(
    { ...d.workout, startedAt: new Date(Date.now() - 14 * HOUR).toISOString() },
    d.entries,
    d.sets,
  );
}

rule("ui: an unfinished workout over 12 hours old is offered Continue, Finish or Discard, never continued silently", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    const card = await waitFor(() => region(root, "stale-workout"), "the unfinished workout notice");
    ctx.assert.ok(card.textContent.includes("Unfinished workout from"));
    ctx.assert.ok(action(root, "continue-stale") && action(root, "finish-stale") && action(root, "discard-stale"));
    ctx.assert.equal(action(root, "choose-exercise"), null); // logging is blocked until it is resolved
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
    click(action(root, "continue-stale"));
    await waitFor(() => action(root, "choose-exercise"), "logging to be allowed");
    ctx.assert.equal(region(root, "stale-workout"), null);
  }, { prepare: staleSetup });
});

rule("ui: Discard on an old unfinished workout asks first and removes it; Finish ends it", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    click(await waitFor(() => action(root, "discard-stale"), "the Discard button"));
    await waitForText(root, "Discard this workout and its 2 sets?");
    click(action(root, "keep-workout"));
    await waitFor(() => action(root, "discard-stale"), "the choices again");
    click(action(root, "discard-stale"));
    click(await waitFor(() => action(root, "confirm-discard"), "the confirm button"));
    await waitForText(root, "Workout discarded.");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  }, { prepare: staleSetup });

  await withApp(ctx, async ({ root, store }) => {
    click(await waitFor(() => action(root, "finish-stale"), "the Finish button"));
    await waitForText(root, "Workout finished.");
    const [workout] = await store.listWorkouts();
    ctx.assert.ok(workout.endedAt !== null);
  }, { prepare: staleSetup });
});

rule("ui: export warns that the file is unencrypted, downloads, and shows copyable text", async (ctx) => {
  await withApp(ctx, async ({ root, calls }) => {
    await goToTab(root, "backup");
    const warning = await waitFor(() => region(root, "export-warning"), "the export warning");
    ctx.assert.ok(/not encrypted/.test(warning.textContent));
    ctx.assert.ok(/cannot control where/.test(warning.textContent));
    ctx.assert.ok(/No export has been confirmed/.test(region(root, "last-export").textContent));

    click(action(root, "download-export"));
    await waitFor(() => calls.downloads.length === 1, "the download to start");
    ctx.assert.ok(/^apogee-export-\d{4}-\d{2}-\d{2}\.json$/.test(calls.downloads[0].filename));
    ctx.assert.equal(calls.downloads[0].blob.type, "application/json");
    await waitFor(() => /started .* not confirmed/.test(region(root, "last-export").textContent), "the export attempt");
    ctx.assert.ok(/No export has been confirmed/.test(region(root, "last-export").textContent));
    ctx.assert.equal(region(root, "export-confirm") !== null, true);
    click(action(root, "confirm-export-saved"));
    await waitFor(() => /Last export confirmed as saved/.test(region(root, "last-export").textContent), "the confirmed export");
    ctx.assert.equal(region(root, "export-confirm"), null);

    click(action(root, "show-export-text"));
    const box = await waitFor(() => field(root, "export-text"), "the export text box");
    const doc = JSON.parse(box.value);
    ctx.assert.equal(doc.app, "apogee-export");
    ctx.assert.equal(doc.data.exercises.length, SEED_EXERCISES.length);
    ctx.assert.ok(action(root, "select-export-text") && action(root, "copy-export-text"));
  });
});

rule("ui: a set goes template, resting, done; tapping its time edits only that rest; unchecking resets it", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await pickExercise(root, "bench", BENCH);
    const row = () => root.querySelector("li.set-row");
    const time = () => row().querySelector(".rest-time").textContent;
    // template: the planned rest (3:00) and a full icon
    ctx.assert.deepEqual([row().dataset.phase, time(), row().querySelector(".rest-icon").dataset.phase], ["template", "3:00", "template"]);
    ctx.assert.ok(row().querySelector(".rest-pie").getAttribute("d").length > 0);

    // tapping the time edits this set's rest; a bad value says what is expected
    click(row().querySelector('[data-action="edit-rest"]'));
    setValue(await waitFor(() => field(root, "rest"), "the rest editor"), "abc");
    click(action(root, "save-rest"));
    await waitFor(() => /Enter the rest time, e.g. 300 for 3:00/.test(region(root, "rest-error").textContent) && !region(root, "rest-error").hidden, "the format message");
    ctx.assert.equal(field(root, "rest").value, "abc"); // what was typed stays
    setValue(field(root, "rest"), "2"); // digits only: 2 is 0:02
    click(action(root, "save-rest"));
    await waitFor(() => row().querySelector("button.rest-time") && time() === "0:02", "the new rest");

    await submitSet(root, "8", "100", "kg");
    await waitFor(() => row().dataset.phase === "resting", "the timer to start");
    ctx.assert.equal(row().querySelector('[data-action="toggle-set"]').getAttribute("aria-pressed"), "true");
    ctx.assert.equal(row().querySelector(".rest-icon").dataset.phase, "resting");

    // done: the row is greyed, the time reads 0:00, and the pie is gone
    await waitFor(() => row().dataset.phase === "done", "the timer to run out", 6000);
    ctx.assert.deepEqual([time(), row().querySelector(".rest-icon").dataset.phase, row().querySelector(".rest-pie").getAttribute("d")], ["0:00", "done", ""]);
    ctx.assert.equal(row().querySelector('[data-action="edit-rest"]'), null); // a done set keeps its rest

    // unchecking returns it to the template state with its own rest
    click(row().querySelector('[data-action="toggle-set"]'));
    await waitFor(() => row().dataset.phase === "template", "the template state");
    ctx.assert.equal(time(), "0:02");
  });
});

rule("ui: the running timer counts down, and checking another set puts the earlier one in done", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    const first = () => loggedRows(root)[0];
    await waitFor(() => first().dataset.phase === "resting", "the first timer");
    await waitFor(() => first().querySelector(".rest-time").textContent === "2:59", "the countdown to tick", 4000);
    await logOneSet(root, "8", "100", "kg");
    await waitFor(() => first().dataset.phase === "done", "the first set to be done");
    ctx.assert.equal(loggedRows(root)[1].dataset.phase, "resting");
    click(loggedRows(root)[1].querySelector('[data-action="toggle-set"]')); // uncheck the new one
    await waitFor(() => plannedRows(root).length === 1, "the row to be planned again");
    ctx.assert.equal(first().dataset.phase, "done"); // not revived
    ctx.assert.equal(first().querySelector(".rest-time").textContent, "0:00");
  });
});

rule("ui: a timer running out while you type changes only its own rest line, never the field you are typing in", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await pickExercise(root, "bench", BENCH);
    click(root.querySelector("li.set-row").querySelector('[data-action="edit-rest"]'));
    setValue(await waitFor(() => field(root, "rest"), "the rest editor"), "2"); // 0:02
    click(action(root, "save-rest"));
    await waitFor(() => root.querySelector("li.set-row button.rest-time")?.textContent === "0:02", "the new rest");
    await logOneSet(root, "8", "100", "kg");
    const first = () => loggedRows(root)[0];
    await waitFor(() => first().dataset.phase === "resting", "the timer to start");
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    const reps = (await waitFor(() => lastPlanned(root), "the new row")).querySelector('[data-field="reps"]');
    reps.focus();
    setValue(reps, "12");
    reps.setSelectionRange(1, 1); // the cursor sits between the digits
    await waitFor(() => first().dataset.phase === "done", "the timer to run out", 6000);
    ctx.assert.equal(first().querySelector(".rest-time").textContent, "0:00");
    ctx.assert.equal(lastPlanned(root).querySelector('[data-field="reps"]'), reps); // the same element, not a copy
    ctx.assert.deepEqual([reps.value, document.activeElement === reps, reps.selectionStart], ["12", true, 1]);
  });
});

rule("ui: a redraw nobody asked for waits while text is unsaved, then draws and keeps the text", async (ctx) => {
  await withApp(ctx, async ({ root, app }) => {
    await pickExercise(root, "bench", BENCH);
    const reps = lastPlanned(root).querySelector('[data-field="reps"]');
    setValue(reps, "12"); // typed, not yet saved (the field is not focused)
    await app.renderInBackground();
    await new Promise((resolve) => setTimeout(resolve, 400));
    ctx.assert.equal(lastPlanned(root).querySelector('[data-field="reps"]'), reps); // not replaced
    reps.dispatchEvent(new Event("change", { bubbles: true })); // leaving the field saves it
    const drawn = await waitFor(() => {
      const now = lastPlanned(root).querySelector('[data-field="reps"]');
      return now !== reps ? now : null;
    }, "the waiting redraw");
    ctx.assert.equal(drawn.value, "12"); // saved, so the redraw shows it
  });
});

rule("ui: Add set shows no timer; finishing with unchecked sets asks first, then keeps only the checked ones", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(action(root, "add-set"));
    await waitFor(() => lastPlanned(root), "the new row");
    ctx.assert.equal(action(root, "add-set").closest("[data-timer-for]"), null);
    click(action(root, "finish"));
    const confirm = await waitFor(() => region(root, "confirm-finish"), "the confirmation");
    ctx.assert.ok(/1 unchecked set will be removed/.test(confirm.textContent));
    click(action(root, "cancel-finish"));
    await waitFor(() => action(root, "finish"), "the workout actions again");
    ctx.assert.equal(plannedRows(root).length, 1);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
    click(action(root, "finish"));
    click(await waitFor(() => action(root, "confirm-finish"), "the confirm button"));
    await waitForText(root, "Workout finished.");
    ctx.assert.equal(plannedRows(root).length, 0);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  });
});

rule("ui: Add set then tap the check with nothing typed logs the prefilled values", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    const row = await waitFor(() => lastPlanned(root), "the new row");
    click(row.querySelector('[data-action="toggle-set"]')); // nothing typed
    await waitFor(() => loggedRows(root).length === 2, "the second set to be logged");
    ctx.assert.equal(errorText(root), "");
    const [workout] = await store.listWorkouts();
    const { entries } = await store.getWorkoutWithDetails(workout.id);
    ctx.assert.deepEqual(entries[0].sets.map((s) => [s.reps, s.weightValue, s.weightUnit]), [[8, 100, "kg"], [8, 100, "kg"]]);
    // a row for an exercise with nothing to copy from is still refused when blank
    click(action(root, "choose-exercise"));
    setValue(await waitFor(() => field(root, "search"), "the search box"), "squat");
    click(await waitFor(() => $(root, `[data-action="pick-exercise"][data-exercise-id="seed-barbell-squat"]`), "the squat"));
    await waitFor(() => lastPlanned(root) && lastPlanned(root).closest("[data-exercise-id]").dataset.exerciseId === "seed-barbell-squat", "the squat row");
    click(lastPlanned(root).querySelector('[data-action="toggle-set"]'));
    await waitFor(() => /reps is required/.test(errorText(root)), "the blank refused");
  });
});

rule("ui: a ghost is a placeholder in the selected unit, never a value; an untouched check stores the original number and unit, a typed weight the selected unit", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    await useUnit(root, "lb");
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    const row = await waitFor(() => lastPlanned(root), "the new row");
    const weight = row.querySelector('[data-field="weight"]');
    const reps = row.querySelector('[data-field="reps"]');
    ctx.assert.deepEqual(
      [weight.value, weight.placeholder, weight.dataset.saved, reps.value, reps.placeholder, reps.dataset.saved],
      ["", "220.5", "", "", "8", ""],
    );
    ctx.assert.ok(weight.getAttribute("aria-label").endsWith(", suggested 220.5 lb, not logged yet"), weight.getAttribute("aria-label"));
    ctx.assert.ok(reps.getAttribute("aria-label").endsWith(", suggested 8 reps, not logged yet"), reps.getAttribute("aria-label"));
    ctx.assert.equal(row.querySelector(".unit-suffix").textContent, "lb");
    click(row.querySelector('[data-action="toggle-set"]')); // nothing typed
    await waitFor(() => loggedRows(root).length === 2, "the second set to be logged");
    ctx.assert.equal(errorText(root), "");
    const second = loggedRows(root)[1];
    ctx.assert.equal(second.querySelector('[data-cell="weight"] .cell-value').textContent, "220.5 lb");
    ctx.assert.equal(second.querySelector('[data-cell="weight"] .cell-note').textContent, "entered 100 kg");
    // a weight typed over the ghost is stored in the selected unit
    click(action(root, "add-set"));
    const third = await waitFor(() => lastPlanned(root), "the third row");
    setValue(third.querySelector('[data-field="weight"]'), "225");
    click(third.querySelector('[data-action="toggle-set"]'));
    await waitFor(() => loggedRows(root).length === 3, "the third set to be logged");
    const [workout] = await store.listWorkouts();
    const { entries } = await store.getWorkoutWithDetails(workout.id);
    ctx.assert.deepEqual(entries[0].sets.map((s) => [s.reps, s.weightValue, s.weightUnit]), [[8, 100, "kg"], [8, 100, "kg"], [8, 225, "lb"]]);
  });
});

rule("ui: a check whose ghost changed in another tab is refused, nothing is logged, and the row shows the new ghost", async (ctx) => {
  await withApp(ctx, async ({ root, store, adapter }) => {
    await useUnit(root, "kg");
    await pickExercise(root, "bench", BENCH);
    const aboveId = lastPlanned(root).dataset.setId;
    const otherTab = createLogger(store);
    await otherTab.updatePlannedSet(aboveId, { reps: "8", weight: "100", unit: "kg" });
    click(action(root, "add-set")); // the redraw shows the row above as typed and the new row's ghost
    const row = await waitFor(() => (plannedRows(root).length === 2 ? lastPlanned(root) : null), "the second row");
    ctx.assert.equal(row.querySelector('[data-field="weight"]').placeholder, "100");
    await otherTab.updatePlannedSet(aboveId, { weight: "110" }); // no redraw here
    click(row.querySelector('[data-action="toggle-set"]'));
    await waitFor(() => errorText(root) === "The suggestion changed. Check again.", "the refusal");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
    await waitFor(() => lastPlanned(root).querySelector('[data-field="weight"]').placeholder === "110", "the new ghost");
  });
});

rule("ui: a checked set's edit form changes it in place; its rest keeps running, unsaved text is protected, and blank reps are refused", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    const [workout] = await store.listWorkouts();
    const before = (await store.getWorkoutWithDetails(workout.id)).entries[0].sets[0];
    const timer = await store.getRunningTimer();
    click(loggedRows(root)[0].querySelector('[data-cell="reps"] [data-action="edit-set"]'));
    const form = await waitFor(() => region(root, "set-editor"), "the edit form");
    const weight = form.querySelector('[data-field="edit-weight"]');
    const reps = form.querySelector('[data-field="edit-reps"]');
    ctx.assert.deepEqual([weight.value, reps.value, form.querySelector(".unit-suffix").textContent], ["100", "8", "kg"]);
    setValue(reps, "");
    ctx.assert.equal(reps.dataset.saved, "8"); // what is typed differs from what is saved: a reload would ask first
    click(form.querySelector('[data-action="save-set-edit"]'));
    await waitFor(() => /reps is required/.test(region(root, "edit-set-error").textContent), "the reps error");
    ctx.assert.deepEqual(await store.getSet(before.id), before);
    setValue(reps, "10");
    setValue(weight, "102.5");
    click(form.querySelector('[data-action="save-set-edit"]'));
    await waitFor(() => !region(root, "set-editor") && loggedRows(root)[0].querySelector('[data-cell="reps"]').textContent === "10", "the edited reps");
    ctx.assert.deepEqual(await store.getSet(before.id), { ...before, reps: 10, weightValue: 102.5 });
    ctx.assert.deepEqual(await store.getRunningTimer(), timer);
    const row = loggedRows(root)[0];
    ctx.assert.deepEqual([row.dataset.kind, row.dataset.phase], ["logged", "resting"]);
    ctx.assert.ok(row.querySelector("[data-timer-for] button.rest-time"), "the rest time is still counting");
  });
});

rule("ui: if all data is cleared while the app is open there is no phantom workout", async (ctx) => {
  await withApp(ctx, async ({ root, adapter, app }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    await waitFor(() => lastPlanned(root), "an unchecked row");
    await adapter.transaction(["exercises", "workouts", "entries", "sets", "meta"], "readwrite", async (tx) => {
      for (const name of ["exercises", "workouts", "entries", "sets", "meta"]) await tx.clear(name);
    });
    await app.render();
    ctx.assert.ok(root.textContent.includes("No workout in progress"));
    ctx.assert.equal(root.querySelectorAll("li.set-row").length, 0);
    ctx.assert.equal(action(root, "finish"), null);
  });
});

rule("ui: the three-dot menu has Update Rest Timers: it sets the exercise default and its unchecked sets, never a checked one", async (ctx) => {
  await withApp(ctx, async ({ root, store }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg"); // checked, logged with 3:00
    click(await waitFor(() => action(root, "add-set"), "the Add set button"));
    await waitFor(() => lastPlanned(root), "an unchecked row");

    click(action(root, "exercise-menu"));
    await waitFor(() => action(root, "exercise-menu").getAttribute("aria-expanded") === "true", "the menu to open");
    click(await waitFor(() => action(root, "update-rest-timers"), "the menu item"));
    const input = await waitFor(() => field(root, "default-rest"), "the editor");
    ctx.assert.equal(input.value, "300"); // digits, like a microwave timer: 300 is 3:00
    setValue(input, "abc"); // not a time
    click(action(root, "save-default-rest"));
    await waitFor(() => !region(root, "default-rest-error").hidden && /Enter the rest time, e.g. 300 for 3:00/.test(region(root, "default-rest-error").textContent), "the format message");
    setValue(field(root, "default-rest"), "1:30"); // a typed colon still works
    click(action(root, "save-default-rest"));
    await waitFor(() => !field(root, "default-rest"), "the editor to close");

    ctx.assert.equal(lastPlanned(root).querySelector(".rest-time").textContent, "1:30"); // the unchecked set
    ctx.assert.equal((await store.getExercise(BENCH)).defaultRestSeconds, 90);
    const [workout] = await store.listWorkouts();
    const { entries } = await store.getWorkoutWithDetails(workout.id);
    ctx.assert.equal(entries[0].sets[0].restSeconds, 180); // the checked set keeps its logged rest
    // the editor starts from the current default next time
    click(action(root, "exercise-menu"));
    click(await waitFor(() => action(root, "update-rest-timers"), "the menu item"));
    ctx.assert.equal((await waitFor(() => field(root, "default-rest"), "the editor")).value, "130");
    click(action(root, "cancel-default-rest"));
    await waitFor(() => !field(root, "default-rest"), "the editor to close");
  });
});

rule("ui: the database notices say what is going on, and the reload button is only on the one that needs it", async (ctx) => {
  const root = document.createElement("div");
  let reloads = 0;
  const blocked = showDatabaseNotice(root, "blocked", { reload: () => { reloads += 1; } });
  ctx.assert.ok(/waiting for another Apogee tab/.test(blocked.textContent));
  ctx.assert.equal(blocked.querySelector("button"), null);
  const changed = showDatabaseNotice(root, "versionchange", { reload: () => { reloads += 1; } });
  ctx.assert.equal(root.querySelectorAll('[data-region="database-notice"]').length, 1); // replaced, not stacked
  ctx.assert.ok(/updated in another tab/.test(changed.textContent));
  changed.querySelector('[data-action="reload-database"]').click();
  ctx.assert.equal(reloads, 1);
  let message = "";
  try {
    showDatabaseNotice(root, "nonsense");
  } catch (error) {
    message = error.message;
  }
  ctx.assert.ok(/unknown notice/.test(message));
});

rule("ui: pull-to-refresh never reloads without an update, asks first when a timer runs or text is unsaved, and stays out of typing", async (ctx) => {
  await withApp(ctx, async ({ root, services }) => {
    const calls = { checks: 0, applied: 0, reloaded: 0 };
    let result = { status: "current" };
    const offline = {
      checkNow: async () => { calls.checks += 1; return result; },
      applyUpdate: async () => { calls.applied += 1; },
      reload: () => { calls.reloaded += 1; },
    };
    const pull = installPullToRefresh({ offline, logger: services.logger, host: root, getScrollTop: () => 0 });
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const touch = (type, y) => {
      const event = new Event(type, { bubbles: true });
      event.touches = type === "touchend" ? [] : [{ clientX: 50, clientY: y }];
      document.dispatchEvent(event);
    };
    const pullDown = () => {
      touch("touchstart", 100);
      touch("touchmove", 160);
      touch("touchmove", 320);
      touch("touchend", 320);
    };
    const label = () => root.querySelector(".pull-text").textContent;
    const question = () => root.querySelector('[data-region="pull-confirm"]');
    try {
      // nothing newer: a message, and no reload
      pullDown();
      await waitFor(() => label() === "Up to date", "the Up to date message");
      ctx.assert.deepEqual([calls.applied, calls.reloaded], [0, 0]);

      // a short pull does not even check
      const checksBefore = calls.checks;
      touch("touchstart", 100);
      touch("touchmove", 140);
      touch("touchend", 140);
      await pause(60);
      ctx.assert.equal(calls.checks, checksBefore);

      // an update and nothing at risk: applied without asking
      result = { status: "update" };
      pullDown();
      await waitFor(() => calls.applied === 1, "the update to be applied");
      ctx.assert.equal(question(), null);

      // a running timer: it asks, says the timer keeps running, and "Not now" changes nothing
      await pickExercise(root, "bench", BENCH);
      await logOneSet(root, "8", "100", "kg");
      pullDown();
      const first = await waitFor(question, "the question");
      ctx.assert.ok(/keeps running through the reload/.test(first.textContent));
      ctx.assert.ok(!/lost/.test(first.textContent));
      ctx.assert.equal(calls.applied, 1);
      click(root.querySelector('[data-action="pull-cancel-reload"]'));
      await waitFor(() => !question(), "the question to close");
      ctx.assert.equal(calls.applied, 1);
      ctx.assert.equal(loggedRows(root).length, 1);

      // ... and "Reload now" goes through the update
      pullDown();
      await waitFor(question, "the question again");
      click(root.querySelector('[data-action="pull-confirm-reload"]'));
      await waitFor(() => calls.applied === 2, "the update to be applied after the answer");

      // text typed and not saved yet: the question warns that it would be lost, and the text stays
      click(await waitFor(() => action(root, "add-set"), "the Add set button"));
      const reps = (await waitFor(() => lastPlanned(root), "a new row")).querySelector('[data-field="reps"]');
      setValue(reps, "12"); // typed, not yet saved to the plan
      pullDown();
      const second = await waitFor(question, "the question about the text");
      ctx.assert.ok(/will be lost/.test(second.textContent));
      click(root.querySelector('[data-action="pull-cancel-reload"]'));
      await waitFor(() => !question(), "the question to close");
      ctx.assert.equal(reps.value, "12");
      ctx.assert.equal(calls.applied, 2);

      // while an input is focused a pull does nothing at all
      reps.focus();
      const checksWhileTyping = calls.checks;
      pullDown();
      await pause(60);
      ctx.assert.equal(calls.checks, checksWhileTyping);
      reps.blur();
    } finally {
      pull.uninstall();
    }
  });
});

rule("ui: the backup reminder shows with a logged workout and no confirmed export, and dismiss hides it", async (ctx) => {
  const prepare = (store) => store.saveWorkout({ id: "w-remind", startedAt: "2026-10-20T10:00:00.000Z" });
  await withApp(ctx, async ({ root }) => {
    const reminder = await waitFor(() => region(root, "backup-reminder"), "the reminder");
    ctx.assert.equal(reminder.hidden, false);
    click(action(root, "reminder-dismiss"));
    await waitFor(() => region(root, "backup-reminder").hidden === true, "the reminder to hide");
  }, { prepare });
});

rule("ui: import shows the file's counts next to the current ones and needs explicit confirmation", async (ctx) => {
  await withApp(ctx, async ({ root, store, adapter }) => {
    await goToTab(root, "backup");
    const paste = await waitFor(() => field(root, "import-text"), "the paste box");

    setValue(paste, "this is not an export");
    click(action(root, "check-import"));
    await waitFor(() => /not valid JSON/.test(region(root, "view-error").textContent), "the JSON error");
    ctx.assert.equal(region(root, "import-counts"), null);

    setValue(await waitFor(() => field(root, "import-text"), "the paste box"), incomingFile());
    click(action(root, "check-import"));
    const table = await waitFor(() => region(root, "import-counts"), "the counts table");
    ctx.assert.ok(table.textContent.includes("In the file") && table.textContent.includes("On this device now"));
    // each row is a label with the file's count and the current count; the library is not "exercises done"
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent));
    ctx.assert.deepEqual(rows, [
      ["Exercise library (includes the built-in lifts)", "1", String(SEED_EXERCISES.length)],
      ["Workouts", "1", "0"],
      ["Sets logged", "2", "0"],
      ["Templates", "0", "0"],
    ]);
    ctx.assert.ok(!/Exercises in workouts/.test(table.textContent));
    ctx.assert.ok(action(root, "export-first"));
    const confirmButton = action(root, "confirm-import");
    ctx.assert.equal(confirmButton.disabled, true);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
    ctx.assert.equal((await store.listExercises()).length, SEED_EXERCISES.length); // nothing replaced yet

    const tick = field(root, "confirm-replace");
    tick.checked = true;
    tick.dispatchEvent(new Event("change", { bubbles: true }));
    ctx.assert.equal(confirmButton.disabled, false);
    click(confirmButton);
    await waitForText(root, "Imported 1 workout and 2 logged sets. Everything else was replaced.");
    ctx.assert.deepEqual((await store.listExercises()).map((exercise) => exercise.id), ["ex-row"]);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  });
});

rule("ui: import preview has a Templates row, and a file from before schema 4 warns that it removes the saved templates", async (ctx) => {
  const beforeSchema4 = () => {
    const doc = JSON.parse(incomingFile());
    doc.schemaVersion = 3;
    delete doc.data.templates; // a schema 3 file has no templates section
    return JSON.stringify(doc);
  };
  const prepare = async (store) => {
    await store.saveTemplate({ id: "t-a", name: "Push", exercises: [{ exerciseId: BENCH, setCount: 3 }] });
    await store.saveTemplate({ id: "t-b", name: "Pull", exercises: [{ exerciseId: BENCH, setCount: 1 }] });
  };
  await withApp(ctx, async ({ root, store }) => {
    await goToTab(root, "backup");
    const check = async (text) => {
      setValue(await waitFor(() => field(root, "import-text"), "the paste box"), text); // editing clears the old preview
      click(action(root, "check-import"));
      const table = await waitFor(() => region(root, "import-counts"), "the counts table");
      return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent)).at(-1);
    };
    const warning = () => (region(root, "import-no-templates") ? region(root, "import-no-templates").textContent : null);
    const OLD = "This file is from an older version of Apogee and has no templates. ";

    ctx.assert.deepEqual(await check(beforeSchema4()), ["Templates", "0", "2"]);
    ctx.assert.equal(warning(), `${OLD}Importing it removes your 2 saved templates.`);
    ctx.assert.equal((await store.listTemplates()).length, 2); // a preview replaces nothing

    ctx.assert.deepEqual(await check(incomingFile()), ["Templates", "0", "2"]); // schema 4: no warning
    ctx.assert.equal(warning(), null);

    await store.deleteTemplate("t-b");
    await check(beforeSchema4());
    ctx.assert.equal(warning(), `${OLD}Importing it removes your 1 saved template.`);

    await store.deleteTemplate("t-a");
    ctx.assert.deepEqual(await check(beforeSchema4()), ["Templates", "0", "0"]);
    ctx.assert.equal(warning(), `${OLD}You have none saved either.`);
  }, { prepare });
});

// ---- offline: the update banner and the Offline section ----

// Stands in for src/app/offline.js so each state can be shown on demand and every call counted.
function stubOffline(status = {}) {
  const listeners = new Set();
  const state = { updateAvailable: false, updatedElsewhere: false, error: null };
  const calls = { apply: 0, reload: 0, reset: 0, applyError: null };
  return {
    calls,
    state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state }),
    emit: (change) => {
      Object.assign(state, change);
      for (const listener of listeners) listener({ ...state });
    },
    getStatus: async () => ({
      ...state, supported: true, enabled: true, registered: true, ready: true,
      version: "0123456789abcdef0123456789abcdef", versionShort: "01234567", ...status,
    }),
    applyUpdate: async () => {
      calls.apply += 1;
      if (calls.applyError) throw new Error(calls.applyError);
    },
    resetOfflineCopy: async () => {
      calls.reset += 1;
      return { unregistered: true, cachesDeleted: 1 };
    },
    reload: () => {
      calls.reload += 1;
    },
  };
}

rule("ui: with no offline service there is no update banner and no Offline section", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await goToTab(root, "backup");
    await waitFor(() => action(root, "persist"), "the Backup tab");
    ctx.assert.equal(region(root, "update-banner").hidden, true);
    ctx.assert.equal(region(root, "offline-status"), null);
    ctx.assert.equal(action(root, "reset-offline"), null);
  });
});

rule("ui: the Update available banner is hidden until a version is waiting, and only its Reload button applies it", async (ctx) => {
  const offline = stubOffline();
  await withApp(ctx, async ({ root }) => {
    const banner = region(root, "update-banner");
    ctx.assert.equal(banner.hidden, true);
    offline.emit({ updateAvailable: true });
    ctx.assert.equal(banner.hidden, false);
    ctx.assert.ok(banner.textContent.includes("Update available"));
    ctx.assert.ok(/not changed/.test(banner.textContent), "says the workouts are not changed");
    ctx.assert.equal(offline.calls.apply, 0, "showing the banner applies nothing");
    // the user keeps working: still nothing is applied
    await goToTab(root, "history");
    await goToTab(root, "log");
    ctx.assert.equal(offline.calls.apply, 0);
    click(action(root, "apply-update"));
    await waitFor(() => offline.calls.apply === 1, "the click to apply the update");
    ctx.assert.equal(offline.calls.reload, 0, "reloading is the offline service's job, after the switch");
    offline.emit({ updateAvailable: false });
    ctx.assert.equal(banner.hidden, true);
  }, { offline });
});

rule("ui: if the update cannot start, the banner says so and stays", async (ctx) => {
  const offline = stubOffline();
  offline.calls.applyError = "The update did not start. Reload the page and try again.";
  await withApp(ctx, async ({ root }) => {
    offline.emit({ updateAvailable: true });
    click(action(root, "apply-update"));
    await waitFor(() => /did not start/.test(region(root, "update-banner").textContent), "the problem to be shown");
    ctx.assert.equal(region(root, "update-banner").hidden, false);
  }, { offline });
});

rule("ui: when another tab updated the app, this tab says so and its Reload only reloads this tab", async (ctx) => {
  const offline = stubOffline();
  await withApp(ctx, async ({ root }) => {
    offline.emit({ updatedElsewhere: true });
    ctx.assert.ok(region(root, "update-banner").textContent.includes("updated in another tab"));
    ctx.assert.equal(action(root, "apply-update"), null);
    click(action(root, "reload-app"));
    ctx.assert.equal(offline.calls.reload, 1);
    ctx.assert.equal(offline.calls.apply, 0);
  }, { offline });
});

rule("ui: the Offline section shows whether the app is ready and the first 8 characters of the cache version", async (ctx) => {
  const statusOf = async (offline) => {
    let shown;
    await withApp(ctx, async ({ root }) => {
      await goToTab(root, "backup");
      await waitFor(() => region(root, "offline-status"), "the Offline section");
      shown = { status: region(root, "offline-status").textContent, version: region(root, "offline-version").textContent };
    }, { offline });
    return shown;
  };
  const ready = await statusOf(stubOffline());
  ctx.assert.ok(/Ready/.test(ready.status));
  ctx.assert.equal(ready.version, "Offline copy version: 01234567");
  const notReady = await statusOf(stubOffline({ ready: false, version: null, versionShort: null }));
  ctx.assert.ok(/Not ready/.test(notReady.status));
  ctx.assert.equal(notReady.version, "Offline copy version: none");
  const off = await statusOf(stubOffline({ ready: false, enabled: false, registered: false, version: null, versionShort: null }));
  ctx.assert.ok(/Switched off on this address.*\?sw=1/.test(off.status));
  const unsupported = await statusOf(stubOffline({ supported: false, ready: false, registered: false, version: null, versionShort: null }));
  ctx.assert.ok(/not available/.test(unsupported.status));
});

rule("ui: Reset offline copy asks first, Cancel changes nothing, and the workout data is untouched afterwards", async (ctx) => {
  const offline = stubOffline();
  await withApp(ctx, async ({ root, adapter }) => {
    const before = await rawCounts(adapter);
    ctx.assert.deepEqual(before, { workouts: 2, entries: 2, sets: 2 });
    await goToTab(root, "backup");
    click(await waitFor(() => action(root, "reset-offline"), "the Reset offline copy button"));
    const confirm = await waitFor(() => region(root, "confirm-reset-offline"), "the confirmation");
    ctx.assert.ok(/Your workouts and settings are not affected/.test(confirm.textContent));
    ctx.assert.equal(offline.calls.reset, 0, "asking resets nothing");
    click(action(root, "cancel-reset-offline"));
    await waitFor(() => !region(root, "confirm-reset-offline") && action(root, "reset-offline"), "the confirmation to close");
    ctx.assert.equal(offline.calls.reset, 0);

    click(action(root, "reset-offline"));
    click(await waitFor(() => action(root, "confirm-reset-offline"), "the confirm button"));
    await waitForText(root, "Offline copy removed");
    ctx.assert.equal(offline.calls.reset, 1);
    ctx.assert.deepEqual(await rawCounts(adapter), before, "workouts, entries and sets are exactly as they were");
  }, { offline, prepare: twoFinishedWorkouts });
});

// This test runs the REAL reset against the browser's real caches and registrations.
// This page shares its origin with the installed app, so the test must be built
// not to touch the app's own offline copy: it uses its own cache prefix (so the
// app's real caches are outside what it deletes) and an address of its own (so
// the app's real worker registration is outside what it unregisters). It also
// checks that the app's registration and caches are still there afterwards.
rule("ui: the real reset removes only this app's caches and leaves the database, other caches and the real offline copy alone", async (ctx) => {
  const prefix = "apogee-test-precache-";
  const decoys = ["other-site-cache", "apogee-test-precache", "my-apogee-test-precache-1", `${CACHE_PREFIX}decoy-with-the-real-prefix`];
  const ours = [`${prefix}old`, `${prefix}new`];
  const testScope = new URL("./offline-test-scope/", location.href); // an address no real registration has
  const offline = createOffline({
    cachePrefix: prefix,
    location: { hostname: testScope.hostname, search: "", href: testScope.href, reload: () => {} },
  });
  const realRegistrationBefore = (await navigator.serviceWorker?.getRegistration())?.scope ?? null;
  const realCachesBefore = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && !decoys.includes(name));
  try {
    // an interrupted earlier run could have left these behind; start from none
    for (const name of [...decoys, ...ours]) await caches.delete(name);
    for (const name of [...decoys, ...ours]) await (await caches.open(name)).put(`${testScope.href}x-${name}`, new Response("x"));
    await withApp(ctx, async ({ root, store, adapter }) => {
      const before = await rawCounts(adapter);
      const exercisesBefore = (await store.listExercises()).length;
      await goToTab(root, "backup");
      click(await waitFor(() => action(root, "reset-offline"), "the Reset offline copy button"));
      click(await waitFor(() => action(root, "confirm-reset-offline"), "the confirm button"));
      await waitForText(root, "Offline copy removed");
      const names = await caches.keys();
      for (const name of ours) ctx.assert.ok(!names.includes(name), `${name} should be gone`);
      for (const name of decoys) ctx.assert.ok(names.includes(name), `${name} must survive`);
      ctx.assert.deepEqual(await rawCounts(adapter), before);
      ctx.assert.equal((await store.listExercises()).length, exercisesBefore);
    }, { offline, prepare: twoFinishedWorkouts });
    // the app's own offline copy, if this browser has one, is exactly as it was
    ctx.assert.equal((await navigator.serviceWorker?.getRegistration())?.scope ?? null, realRegistrationBefore);
    const realCachesAfter = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && !decoys.includes(name));
    ctx.assert.deepEqual(realCachesAfter, realCachesBefore);
  } finally {
    for (const name of [...decoys, ...ours]) await caches.delete(name);
  }
});

rule("ui: asking for persistent storage reports the browser's answer", async (ctx) => {
  await withApp(ctx, async ({ root, calls }) => {
    await goToTab(root, "backup");
    click(await waitFor(() => action(root, "persist"), "the storage button"));
    await waitFor(() => /Not guaranteed/.test(region(root, "persist-status").textContent), "the answer");
    ctx.assert.equal(calls.persist, 1);
  });
});

rule("page: every resource this page loaded came from this origin", async ({ assert }) => {
  const foreign = performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("data:") && new URL(name).origin !== location.origin);
  assert.deepEqual(foreign, []);
});

// ---- the exercise picker: filters, the 50-row cap and the library note ----

const pickRows = (root) => [...root.querySelectorAll('[data-action="pick-exercise"]')];
const pickIds = (root) => pickRows(root).map((row) => row.dataset.exerciseId);
const openPicker = async (root) => {
  click(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
  await waitFor(() => field(root, "search") && pickRows(root).length > 0, "the exercise list");
};
const chooseOption = (select, value) => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};
const moreText = (root) => (region(root, "pick-more") ? region(root, "pick-more").textContent : null);

// 120 exercises like the catalog's: built-in records, not seeds and not the user's own.
async function addSynthetic(store) {
  for (let i = 0; i < 120; i += 1) {
    await store.saveExercise({
      id: `Synthetic_${i}`,
      name: `Synthetic ${String(i).padStart(3, "0")}`,
      primaryMuscles: [i % 2 === 0 ? "neck" : "chest"],
      equipmentTags: [i % 3 === 0 ? "foam_roll" : "dumbbell"],
      equipment: i % 3 === 0 ? "foam_roll" : "dumbbell",
      origin: "upstream",
      catalogVersion: 1,
    });
  }
}

rule("ui: with the 16 seeds nothing is capped, the selects list every muscle and equipment id, and both filter the list", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.equal(pickRows(root).length, 16);
    ctx.assert.equal(region(root, "pick-more"), null);
    const muscle = field(root, "filter-muscle");
    const equipment = field(root, "filter-equipment");
    ctx.assert.equal(muscle.options.length, 21); // Any + the 18 muscles + neck and abductors
    ctx.assert.equal(equipment.options.length, 17); // Any + the 11 tags + the 5 added
    const texts = (select) => [...select.options].map((option) => option.textContent);
    ctx.assert.deepEqual(texts(muscle).slice(0, 3), ["Any", "Chest", "Front delts"]);
    ctx.assert.ok(texts(muscle).includes("Neck") && texts(muscle).includes("Abductors"));
    ctx.assert.ok(texts(equipment).includes("Trap bar") && texts(equipment).includes("Foam roll") && texts(equipment).includes("Exercise ball"));
    chooseOption(muscle, "chest");
    await waitFor(() => pickRows(root).length === 2, "the chest exercises");
    ctx.assert.deepEqual(pickIds(root), ["seed-barbell-bench-press", "seed-incline-dumbbell-press"]);
    chooseOption(equipment, "dumbbell");
    await waitFor(() => pickRows(root).length === 1, "the chest exercise with dumbbells");
    ctx.assert.deepEqual(pickIds(root), ["seed-incline-dumbbell-press"]);
    chooseOption(muscle, "");
    chooseOption(equipment, "");
    await waitFor(() => pickRows(root).length === 16, "the whole list again");
  });
});

rule("ui: a row shows the primary muscles, then the equipment, then Custom, and the user's own exercises come first", async (ctx) => {
  await withApp(ctx, async ({ root, services }) => {
    await services.logger.addCustomExercise({ name: "Cable fly", primaryMuscles: ["chest"], equipmentTags: ["cable"] });
    await openPicker(root);
    const meta = (id) => $(root, `[data-exercise-id="${id}"] .pick-meta`).textContent;
    ctx.assert.equal(meta("seed-barbell-bench-press"), "Chest · Barbell");
    ctx.assert.equal(meta("seed-pull-up"), "Lats · Bodyweight");
    const custom = pickRows(root).find((row) => row.querySelector(".pick-name").textContent === "Cable fly");
    ctx.assert.equal(custom.querySelector(".pick-meta").textContent, "Chest · Custom"); // a custom exercise has no equipment field
    ctx.assert.equal(pickRows(root)[0], custom);
  });
});

rule("ui: with 136 exercises the list shows 50, says so, and Show 50 more adds 50 at a time", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.equal(pickRows(root).length, 50);
    ctx.assert.equal(moreText(root), "Showing 50 of 136. Search or filter to narrow it down.Show 50 more");
    ctx.assert.equal(pickIds(root).slice(0, 16).every((id) => id.startsWith("seed-")), true); // the 16 seeds come first
    ctx.assert.equal(pickIds(root)[16], "Synthetic_0");
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 100, "100 rows");
    ctx.assert.equal(moreText(root), "Showing 100 of 136. Search or filter to narrow it down.Show 50 more");
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 136, "all 136 rows");
    ctx.assert.equal(region(root, "pick-more"), null);
  }, { prepare: addSynthetic });
});

rule("ui: a filter or a new search narrows the list and starts again from 50 rows", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 100, "100 rows");
    chooseOption(field(root, "filter-muscle"), "neck");
    await waitFor(() => moreText(root) !== null && moreText(root).startsWith("Showing 50 of 60."), "50 of the 60 neck exercises");
    ctx.assert.equal(pickRows(root).length, 50);
    ctx.assert.ok(pickIds(root).every((id) => id.startsWith("Synthetic_") && Number(id.slice(10)) % 2 === 0));
    chooseOption(field(root, "filter-equipment"), "foam_roll");
    await waitFor(() => pickRows(root).length === 20, "the 20 neck exercises with a foam roll");
    ctx.assert.equal(region(root, "pick-more"), null);
    ctx.assert.equal($(root, '[data-exercise-id="Synthetic_0"] .pick-meta').textContent, "Neck · Foam roll");
    chooseOption(field(root, "filter-muscle"), "");
    chooseOption(field(root, "filter-equipment"), "");
    await waitFor(() => moreText(root) !== null && moreText(root).startsWith("Showing 50 of 136."), "the whole list, first page");
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 100, "100 rows again");
    setValue(field(root, "search"), "synthetic 07");
    await waitFor(() => pickRows(root).length === 12, "the twelve names containing 07"); // 007, 070 to 079, 107
    ctx.assert.equal(region(root, "pick-more"), null);
    setValue(field(root, "search"), "synthetic");
    await waitFor(() => moreText(root) !== null && moreText(root).startsWith("Showing 50 of 120."), "50 of 120 again");
    ctx.assert.equal(pickRows(root).length, 50);
  }, { prepare: addSynthetic });
});

// ---- the picker's Recent group ----

const groupTexts = (root) => [...root.querySelectorAll('[data-region="pick-group"]')].map((el) => el.textContent);

// Three finished workouts: squat (oldest), then pull-up and bench together, then deadlift (newest).
async function addHistory(store) {
  const make = async (id, startedAt, uses) => {
    const entries = uses.map(([exerciseId], order) => ({ id: `${id}-e${order}`, workoutId: id, exerciseId, order }));
    const sets = uses.map(([, completedAt], order) => ({
      id: `${id}-s${order}`, entryId: `${id}-e${order}`, order: 0, reps: 5, weightValue: 50, weightUnit: "kg", completedAt,
    }));
    await store.saveWorkoutWithDetails({ id, startedAt, endedAt: startedAt }, entries, sets);
  };
  await make("h1", "2026-09-01T10:00:00.000Z", [["seed-barbell-squat", "2026-09-01T10:00:00.000Z"]]);
  await make("h2", "2026-09-02T10:00:00.000Z", [["seed-pull-up", "2026-09-02T10:10:00.000Z"], [BENCH, "2026-09-02T10:20:00.000Z"]]);
  await make("h3", "2026-09-03T10:00:00.000Z", [["seed-conventional-deadlift", "2026-09-03T10:00:00.000Z"]]);
}

rule("ui: with history the picker shows a Recent group first, most recent first, and does not repeat those exercises below", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.deepEqual(groupTexts(root), ["Recent", "All exercises"]);
    const ids = pickIds(root);
    ctx.assert.deepEqual(ids.slice(0, 4), ["seed-conventional-deadlift", BENCH, "seed-pull-up", "seed-barbell-squat"]);
    ctx.assert.equal(ids.length, 16); // each of the 16 once
    ctx.assert.equal(new Set(ids).size, 16);
    ctx.assert.equal($(root, `[data-exercise-id="${BENCH}"] .pick-meta`).textContent, "Chest · Barbell"); // the same row as in the list
    const labels = [...root.querySelectorAll('.pick-list > li')].map((li) => li.dataset.region || (li.querySelector("button") ? "row" : "other"));
    ctx.assert.deepEqual(labels.slice(0, 6), ["pick-group", "row", "row", "row", "row", "pick-group"]);
  }, { prepare: addHistory });
});

rule("ui: a search or either filter hides the Recent group, and clearing them brings it back; a blank search does not hide it", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.equal(groupTexts(root).length, 2);
    setValue(field(root, "search"), "   ");
    await waitFor(() => field(root, "search").value === "   ", "the blank search");
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctx.assert.equal(groupTexts(root).length, 2);
    setValue(field(root, "search"), "squat");
    await waitFor(() => groupTexts(root).length === 0, "no group while searching");
    ctx.assert.equal(pickIds(root)[0], "seed-barbell-squat");
    setValue(field(root, "search"), "");
    await waitFor(() => groupTexts(root).length === 2, "the group back");
    chooseOption(field(root, "filter-muscle"), "chest");
    await waitFor(() => groupTexts(root).length === 0, "no group with the muscle filter");
    ctx.assert.deepEqual(pickIds(root), ["seed-barbell-bench-press", "seed-incline-dumbbell-press"]); // exactly the filter's own results
    chooseOption(field(root, "filter-muscle"), "");
    await waitFor(() => groupTexts(root).length === 2, "the group back");
    chooseOption(field(root, "filter-equipment"), "barbell");
    await waitFor(() => groupTexts(root).length === 0, "no group with the equipment filter");
    chooseOption(field(root, "filter-equipment"), "");
    await waitFor(() => groupTexts(root).length === 2, "the group back again");
  }, { prepare: addHistory });
});

rule("ui: Recent rows are extra to the 50-row page: 4 recent plus 50 more, the label counts both, and Show 50 more continues the rest", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.equal(pickRows(root).length, 54);
    ctx.assert.equal(moreText(root), "Showing 54 of 136. Search or filter to narrow it down.Show 50 more");
    ctx.assert.equal(new Set(pickIds(root)).size, 54);
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 104, "104 rows");
    click(action(root, "pick-more"));
    await waitFor(() => pickRows(root).length === 136, "all 136 rows");
    ctx.assert.equal(new Set(pickIds(root)).size, 136); // nothing twice
    ctx.assert.equal(region(root, "pick-more"), null);
  }, { prepare: async (store) => { await addSynthetic(store); await addHistory(store); } });
});

rule("ui: without any history there is no Recent group and the list is as before", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.deepEqual(groupTexts(root), []);
    ctx.assert.equal(pickRows(root).length, 16);
  });
});

rule("ui: choosing an exercise still adds it and closes the picker, and the next time the picker opens it is clean", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    chooseOption(field(root, "filter-muscle"), "neck");
    await waitFor(() => moreText(root) !== null && moreText(root).startsWith("Showing 50 of 60."), "the neck exercises");
    setValue(field(root, "search"), "synthetic 004");
    await waitFor(() => pickIds(root).join() === "Synthetic_4", "the one match");
    click($(root, '[data-action="pick-exercise"][data-exercise-id="Synthetic_4"]'));
    await waitFor(() => lastPlanned(root), "the new unchecked row");
    ctx.assert.equal(field(root, "search"), null); // the picker closed
    ctx.assert.ok(root.textContent.includes("Synthetic 004"));
    await openPicker(root);
    ctx.assert.equal(field(root, "search").value, "");
    ctx.assert.equal(field(root, "filter-muscle").value, "");
    ctx.assert.equal(field(root, "filter-equipment").value, "");
    ctx.assert.equal(pickRows(root).length, 50);
    ctx.assert.equal(moreText(root), "Showing 50 of 136. Search or filter to narrow it down.Show 50 more");
  }, { prepare: addSynthetic });
});

rule("ui: the typed query and the filters survive a redraw nobody asked for, which waits while the search box is in use", async (ctx) => {
  await withApp(ctx, async ({ root, app }) => {
    await openPicker(root);
    const search = field(root, "search");
    search.focus();
    setValue(search, "synthetic");
    chooseOption(field(root, "filter-muscle"), "chest");
    await waitFor(() => pickRows(root).length === 50 && moreText(root).startsWith("Showing 50 of 60."), "the typed search and the filter");
    search.focus();
    await app.renderInBackground();
    await new Promise((resolve) => setTimeout(resolve, 400));
    ctx.assert.equal(field(root, "search"), search); // not replaced while it is in use
    ctx.assert.equal(search.value, "synthetic");
    search.blur();
    const drawn = await waitFor(() => (field(root, "search") !== search ? field(root, "search") : null), "the waiting redraw");
    ctx.assert.equal(drawn.value, "synthetic"); // the query is remembered
    ctx.assert.equal(field(root, "filter-muscle").value, "chest"); // and so is the filter
    await waitFor(() => pickRows(root).length === 50 && moreText(root).startsWith("Showing 50 of 60."), "the same results again");
  }, { prepare: addSynthetic });
});

rule("ui: the library note shows only if the app has a catalog service, and only while it loads or after it failed", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    ctx.assert.equal(region(root, "catalog-status"), null); // no service: nothing is shown
  });
  const failed = "The full exercise library could not be loaded. Apogee will try again the next time it opens.";
  for (const [status, expected] of [["ready", null], ["idle", null], ["syncing", "Loading the exercise library…"], ["failed", failed]]) {
    await withApp(ctx, async ({ root }) => {
      await openPicker(root);
      const note = region(root, "catalog-status");
      ctx.assert.equal(note === null ? null : note.textContent, expected, status);
    }, { catalog: { getStatus: () => status } });
  }
});

rule("ui: the custom exercise form is unchanged: it still offers the 18 muscles and 11 equipment tags only", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    await openPicker(root);
    click(action(root, "add-custom"));
    await waitFor(() => $(root, ".custom-form"), "the custom form");
    ctx.assert.equal(root.querySelectorAll('.custom-form input[data-group="primary"]').length, 18);
    ctx.assert.equal(root.querySelectorAll('.custom-form input[data-group="secondary"]').length, 18);
    ctx.assert.equal(root.querySelectorAll('.custom-form input[data-group="equipment"]').length, 11);
    ctx.assert.equal(root.querySelector('.custom-form input[value="neck"]'), null);
    ctx.assert.equal(root.querySelector('.custom-form input[value="foam_roll"]'), null);
  });
});

// The library wired as src/ui/main.js wires it: mounted first, then onChange redraws and startAfterFirstPaint.
rule("ui: the library starts only after the first frame; while it loads the app is usable and the note shows; when stored the picker lists 846", async (ctx) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = { checkAt: null, mountedAt: null, frameAt: null };
  const make = (adapter) => {
    const catalogStore = createCatalogStore(adapter);
    return createCatalogService({
      catalogStore: {
        catalogIsCurrent: (info) => {
          if (seen.checkAt === null) seen.checkAt = performance.now();
          return catalogStore.catalogIsCurrent(info);
        },
        syncCatalog: (entries, info) => catalogStore.syncCatalog(entries, info),
      },
      load: async () => {
        await gate;
        return import("../../src/catalog/catalog.js");
      },
    });
  };
  await withApp(ctx, async ({ root, services, app }) => {
    seen.mountedAt = performance.now();
    ctx.assert.ok(region(root, "catalog-status") === null && action(root, "choose-exercise") !== null); // the Log tab is drawn
    services.catalog.onChange(() => app.renderInBackground());
    requestAnimationFrame(() => { seen.frameAt = performance.now(); }); // queued before the library's own frame
    startAfterFirstPaint(() => services.catalog.ensureCurrent());
    ctx.assert.equal(seen.checkAt, null); // not started in the same task as the mount
    await waitFor(() => seen.checkAt !== null, "the library check");
    ctx.assert.ok(seen.frameAt !== null && seen.checkAt >= seen.frameAt); // only after a frame
    await waitFor(() => services.catalog.getStatus() === "syncing", "the syncing status");
    await openPicker(root);
    ctx.assert.equal(region(root, "catalog-status").textContent, "Loading the exercise library…");
    ctx.assert.equal(pickRows(root).length, 16); // the seeds, while the library loads
    click(pickRows(root).find((b) => b.dataset.exerciseId === BENCH)); // logging still works meanwhile
    await waitFor(() => plannedRows(root).length === 1, "the bench row");
    release();
    await waitFor(() => services.catalog.getStatus() === "ready", "the library");
    await openPicker(root);
    await waitFor(() => moreText(root) !== null && moreText(root).startsWith("Showing 50 of 846."), "846 in the picker");
    ctx.assert.equal(region(root, "catalog-status"), null); // nothing shown when ready
  }, { catalog: make });
  ctx.assert.ok(seen.checkAt > seen.mountedAt);
});

rule("ui: a library that cannot load shows the plain note, and the app goes on with the seeds", async (ctx) => {
  const make = (adapter) => createCatalogService({ catalogStore: createCatalogStore(adapter), load: async () => { throw new Error("offline"); } });
  await withApp(ctx, async ({ root, services, app }) => {
    services.catalog.onChange(() => app.renderInBackground());
    const outcome = await services.catalog.ensureCurrent();
    ctx.assert.equal(outcome.status, "failed");
    await openPicker(root);
    await waitFor(() => region(root, "catalog-status"), "the note");
    ctx.assert.equal(region(root, "catalog-status").textContent, "The full exercise library could not be loaded. Apogee will try again the next time it opens.");
    ctx.assert.equal(pickRows(root).length, 16);
    click(pickRows(root).find((b) => b.dataset.exerciseId === BENCH));
    await waitFor(() => plannedRows(root).length === 1, "the bench row");
  }, { catalog: make });
});

// ---- the elapsed time of the open workout ----

const elapsedOf = (root) => region(root, "elapsed");

rule("elapsed: a tick updates only the timer element's text; the card is not redrawn and a field's value and focus survive", async (ctx) => {
  await withApp(ctx, async ({ root, app }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(action(root, "add-set"));
    await waitFor(() => plannedRows(root).length === 1, "a new row");
    const timer = elapsedOf(root);
    ctx.assert.equal(timer.getAttribute("role"), "timer");
    ctx.assert.equal(timer.getAttribute("aria-live"), "off");
    ctx.assert.equal(timer.closest("[aria-live]:not([aria-live=off])"), null, "not inside a live region");
    ctx.assert.ok(/^\d+:\d\d$/.test(timer.textContent), timer.textContent);
    ctx.assert.ok(region(root, "started").textContent.trim().endsWith(" · 1 set"));
    ctx.assert.ok(!region(root, "started").contains(timer)); // the time is in the title row, not in the sentence
    ctx.assert.ok(timer.closest(".card-head").querySelector("h2"), "the time shares the title row");
    const reps = lastPlanned(root).querySelector('[data-field="reps"]');
    reps.focus();
    setValue(reps, "12");
    reps.setSelectionRange(1, 1);
    const row = lastPlanned(root);
    const before = timer.textContent;
    await waitFor(() => timer.textContent !== before, "the timer to tick", 3500);
    ctx.assert.equal(elapsedOf(root), timer); // the same element
    ctx.assert.equal(lastPlanned(root), row); // the list was not redrawn
    ctx.assert.equal(document.activeElement, reps);
    ctx.assert.deepEqual([reps.value, reps.selectionStart], ["12", 1]);
    ctx.assert.equal(app.state.log.seen.size, 2);
  });
});

rule("elapsed: the interval is cleared on finish, discard and leaving the Log tab (no leaked timer)", async (ctx) => {
  const live = new Set();
  const realSet = window.setInterval;
  const realClear = window.clearInterval;
  window.setInterval = (fn, delay, ...rest) => {
    const id = realSet(fn, delay, ...rest);
    if (delay === 1000) live.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    live.delete(id);
    return realClear(id);
  };
  try {
    await withApp(ctx, async ({ root, app }) => {
      await pickExercise(root, "bench", BENCH);
      ctx.assert.equal(live.size, 0); // no workout open yet
      await logOneSet(root, "8", "100", "kg");
      await waitFor(() => elapsedOf(root), "the timer");
      ctx.assert.equal(live.size, 1);
      ctx.assert.equal(typeof app.state.log.stopElapsed, "function");
      await goToTab(root, "history"); // leaving the tab
      await waitFor(() => live.size === 0, "the interval to be cleared after leaving the tab");
      ctx.assert.equal(app.state.log.stopElapsed, null);
      await goToTab(root, "log");
      await waitFor(() => elapsedOf(root) && live.size === 1, "the interval to start again");
      click(action(root, "finish")); // all sets are checked: finishes without a question
      await waitFor(() => !elapsedOf(root) && live.size === 0, "the interval to be cleared after finishing");
      ctx.assert.equal(app.state.log.stopElapsed, null);
      await pickExercise(root, "bench", BENCH);
      await logOneSet(root, "5", "50", "kg");
      await waitFor(() => elapsedOf(root) && live.size === 1, "a new workout's interval");
      click(action(root, "discard"));
      click(await waitFor(() => action(root, "confirm-discard"), "the discard question"));
      await waitFor(() => !elapsedOf(root) && live.size === 0, "the interval to be cleared after discarding");
      ctx.assert.equal(app.state.log.stopElapsed, null);
    });
    ctx.assert.equal(live.size, 0);
  } finally {
    window.setInterval = realSet;
    window.clearInterval = realClear;
  }
});

// ---- layout, measured in an iframe of the given width with the real stylesheet ----

export const layoutMeasures = [];

async function openEditForm(root) {
  await pickExercise(root, "bench", BENCH);
  await logOneSet(root, "8", "100", "kg");
  click(loggedRows(root)[0].querySelector('[data-cell="reps"] [data-action="edit-set"]'));
  return waitFor(() => region(root, "set-editor"), "the edit form");
}

for (const [width, fontSize] of [[320, null], [375, null], [320, "24px"]]) {
  rule(`styles: at ${width} px${fontSize ? " with larger text" : ""} the edit form's fields share a line, Save and Cancel share the next, equal and 44 px high, and nothing overflows`, async (ctx) => {
    await withApp(ctx, async ({ root, frame }) => {
      const form = await openEditForm(root);
      const win = frame.contentWindow;
      const box = (el) => el.getBoundingClientRect();
      const [weight, reps] = ["edit-weight", "edit-reps"].map((name) => box(form.querySelector(`[data-field="${name}"]`)));
      const save = box(form.querySelector('[data-action="save-set-edit"]'));
      const cancel = box(form.querySelector('[data-action="cancel-set-edit"]'));
      const rowAbove = box(loggedRows(root)[0].querySelector(".set-main"));
      const formBox = box(form);
      layoutMeasures.push(`${width}px${fontSize ? " " + fontSize : ""}: form ${Math.round(formBox.width)} scrollW ${form.scrollWidth}/${form.clientWidth}, Save ${Math.round(save.width)} x ${Math.round(save.height)}, Cancel ${Math.round(cancel.width)} @${Math.round(cancel.top - save.top)}, gap above ${Math.round(formBox.top - rowAbove.bottom)}, field tops ${Math.round(weight.top)}/${Math.round(reps.top)}, doc ${frame.contentDocument.documentElement.scrollWidth}/${win.innerWidth}`);
      if (!fontSize) ctx.assert.ok(Math.abs(weight.top - reps.top) < 1, `fields on one line (${weight.top} / ${reps.top})`);
      ctx.assert.ok(Math.abs(save.top - cancel.top) < 1, "Save and Cancel on one line");
      ctx.assert.ok(Math.abs(save.width - cancel.width) < 1.5, `equal widths ${save.width} / ${cancel.width}`);
      ctx.assert.ok(save.height >= 44 && cancel.height >= 44, `tap targets ${save.height} / ${cancel.height}`);
      ctx.assert.ok(save.top >= Math.max(weight.bottom, reps.bottom), "Save is below the fields");
      ctx.assert.ok(formBox.top - rowAbove.bottom >= 8, `gap above the form ${formBox.top - rowAbove.bottom}`);
      ctx.assert.ok(form.scrollWidth <= form.clientWidth, "the form does not overflow");
      ctx.assert.ok(formBox.left >= 0 && formBox.right <= win.innerWidth, "the form is inside the window");
      ctx.assert.ok(frame.contentDocument.documentElement.scrollWidth <= win.innerWidth, "no horizontal scroll");
    }, { width, fontSize });
  });
}

const ELAPSED_VALUES = ["0:09", "0:10", "9:59", "10:00", "59:59", "1:00:00", "1:00:01"];

for (const [width, fontSize] of [[320, null], [375, null], [320, "24px"]]) {
  rule(`elapsed: at ${width} px${fontSize ? " with larger text" : ""} the title row and the card keep their height and the time its right edge across 0:09 to 1:00:01, with 0, 1 and 12 sets`, async (ctx) => {
    await withApp(ctx, async ({ root, frame }) => {
      await pickExercise(root, "bench", BENCH);
      const rows = [];
      const measure = (label) => {
        const timer = elapsedOf(root);
        const head = timer.closest(".card-head");
        const card = head.parentElement;
        const seen = [];
        for (const value of ELAPSED_VALUES) {
          timer.textContent = value; // what a tick does: one element's text
          seen.push([Math.round(head.getBoundingClientRect().height * 100), Math.round(card.getBoundingClientRect().height * 100), Math.round(timer.getBoundingClientRect().right * 100), Math.round(timer.getBoundingClientRect().width * 100)]);
        }
        const [first] = seen;
        seen.forEach((entry, i) => ctx.assert.deepEqual(entry, first, `${label}: ${ELAPSED_VALUES[i]} changed the row, the card or the time's edge`));
        rows.push(`${label}: title row ${first[0] / 100}, card ${first[1] / 100}, time right edge ${first[2] / 100}, time width ${first[3] / 100}, sentence ${Math.round(region(root, "started").getBoundingClientRect().height)}`);
        return first;
      };
      await logOneSet(root, "8", "100", "kg");
      const one = measure("1 set");
      click($(root, '[data-action="toggle-set"][aria-pressed="true"]')); // unchecked again: a running workout with 0 sets
      await waitFor(() => /· 0 sets$/.test(region(root, "started").textContent.trim()), "0 sets");
      const zero = measure("0 sets");
      await logOneSet(root, "8", "100", "kg");
      for (let i = 0; i < 11; i += 1) await logOneSet(root, "8", "100", "kg");
      await waitFor(() => /· 12 sets$/.test(region(root, "started").textContent.trim()), "12 sets");
      const twelve = measure("12 sets");
      // the sentence's height must not depend on the count (the card above it may differ only by the rows below)
      const sentence = () => Math.round(region(root, "started").getBoundingClientRect().height);
      ctx.assert.equal(sentence(), Number(rows[0].split("sentence ")[1]));
      ctx.assert.equal(zero[2], one[2]);
      ctx.assert.equal(one[2], twelve[2]);
      ctx.assert.equal(zero[0], twelve[0]);
      layoutMeasures.push(`Elapsed, ${width}px${fontSize ? " " + fontSize : ""}: ${rows.join(" | ")}`);
      ctx.assert.ok(frame.contentDocument.documentElement.scrollWidth <= frame.contentWindow.innerWidth, "no horizontal scroll");
    }, { width, fontSize });
  });
}

for (const [width, fontSize] of [[320, null], [375, null], [320, "24px"]]) {
  rule(`styles: at ${width} px${fontSize ? " with larger text" : ""} the edit form's fields sit in the rows' Weight and Reps columns and the form does not overflow`, async (ctx) => {
    await withApp(ctx, async ({ root, frame }) => {
      await pickExercise(root, "bench", BENCH);
      await logOneSet(root, "8", "100", "kg");
      click(action(root, "add-set")); // an unchecked row: its cells are the reference columns
      await waitFor(() => lastPlanned(root), "an unchecked row");
      click(loggedRows(root)[0].querySelector('[data-cell="reps"] [data-action="edit-set"]'));
      const form = await waitFor(() => region(root, "set-editor"), "the edit form");
      const planned = lastPlanned(root); // after the form opened: the view was drawn again
      const box = (el) => el.getBoundingClientRect();
      const close = (a, b, what) => { if (!(Math.abs(a - b) < 0.6)) throw new Error(`${what}: ${a} vs ${b}`); };
      const weightCell = box(planned.querySelector(".cell-weight"));
      const repsCell = box(planned.querySelector(".cell-reps"));
      const editWeightCell = box(form.querySelector(".cell-weight"));
      const editRepsCell = box(form.querySelector(".cell-reps"));
      close(editWeightCell.left, weightCell.left, "weight column x");
      close(editWeightCell.width, weightCell.width, "weight column width");
      close(editRepsCell.left, repsCell.left, "reps column x");
      close(editRepsCell.width, repsCell.width, "reps column width");
      // the same field styling as the rows' inputs
      const win = frame.contentWindow;
      const rowInput = win.getComputedStyle(planned.querySelector('[data-field="weight"]'));
      const formInput = win.getComputedStyle(form.querySelector('[data-field="edit-weight"]'));
      for (const property of ["backgroundColor", "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "fontSize", "paddingLeft", "paddingRight", "minHeight"]) {
        ctx.assert.equal(formInput[property], rowInput[property], property);
      }
      const save = box(form.querySelector('[data-action="save-set-edit"]'));
      const cancel = box(form.querySelector('[data-action="cancel-set-edit"]'));
      ctx.assert.ok(Math.abs(save.top - cancel.top) < 1, "Save and Cancel on one line");
      if (form.scrollWidth > form.clientWidth) throw new Error(`form overflows ${form.scrollWidth}/${form.clientWidth}`);
      if (frame.contentDocument.documentElement.scrollWidth > win.innerWidth) throw new Error(`page scrolls sideways ${frame.contentDocument.documentElement.scrollWidth}/${win.innerWidth}`);
      layoutMeasures.push(`Edit form columns, ${width}px${fontSize ? " " + fontSize : ""}: weight x ${weightCell.left.toFixed(1)}/${editWeightCell.left.toFixed(1)} w ${weightCell.width.toFixed(1)}/${editWeightCell.width.toFixed(1)}, reps x ${repsCell.left.toFixed(1)}/${editRepsCell.left.toFixed(1)} w ${repsCell.width.toFixed(1)}/${editRepsCell.width.toFixed(1)} (row/form)`);
    }, { width, fontSize });
  });
}

rule("styles: the check control is a 44 px target with a ring when unchecked and a filled disc with a tick when checked", async (ctx) => {
  await withApp(ctx, async ({ root, frame }) => {
    await pickExercise(root, "bench", BENCH);
    const win = frame.contentWindow;
    const toggle = () => $(root, '[data-action="toggle-set"]');
    const unchecked = toggle();
    const target = unchecked.getBoundingClientRect();
    ctx.assert.ok(target.width >= 44 && target.height >= 44, `target ${target.width}x${target.height}`);
    ctx.assert.equal(win.getComputedStyle(unchecked, "::before").borderTopWidth, "2px");
    ctx.assert.equal(win.getComputedStyle(unchecked, "::after").opacity, "0"); // no disc, no tick
    ctx.assert.equal(win.getComputedStyle(unchecked).color, "rgba(0, 0, 0, 0)");
    await logOneSet(root, "8", "100", "kg");
    const checked = toggle();
    ctx.assert.equal(win.getComputedStyle(checked, "::after").opacity, "1"); // a disc (a different shape, not only a colour)
    ctx.assert.ok(win.getComputedStyle(checked).color !== "rgba(0, 0, 0, 0)"); // the tick shows
    ctx.assert.ok(parseFloat(win.getComputedStyle(checked, "::after").width) < 44);
    ctx.assert.equal(win.getComputedStyle(checked, "::before").borderTopColor, "rgba(0, 0, 0, 0)"); // the ring is gone
  }, { width: 375 });
});

rule("ui: an exercise and its sets can be moved with buttons that are 44 px high, labelled, and fit a 320 px screen", async (ctx) => {
  const SQUAT = "seed-barbell-squat";
  await withApp(ctx, async ({ root, adapter, frame }) => {
    const { assert } = ctx;
    const doc = frame.contentDocument;
    const blockIds = () => [...root.querySelectorAll(".entry[data-exercise-id]")].map((block) => block.dataset.exerciseId);
    const block = (id) => $(root, `.entry[data-exercise-id="${id}"]`);
    await pickExercise(root, "bench", BENCH);
    await pickExercise(root, "squat", SQUAT);
    await waitFor(() => blockIds().length === 2, "both exercises");
    assert.deepEqual(blockIds(), [BENCH, SQUAT]);

    // the exercise menu: Move up / Move down, 44 px high, inside the screen
    click($(block(SQUAT), '[data-action="exercise-menu"]'));
    const up = await waitFor(() => $(block(SQUAT), '[data-action="move-exercise-up"]'), "the Move up item");
    const down = $(block(SQUAT), '[data-action="move-exercise-down"]');
    assert.equal(up.getAttribute("aria-label"), "Move Barbell back squat up");
    assert.equal(down.getAttribute("aria-label"), "Move Barbell back squat down");
    assert.deepEqual([up.disabled, down.disabled], [false, true]); // last of two
    for (const item of [up, down, $(block(SQUAT), '[data-action="reorder-sets"]')]) {
      const rect = item.getBoundingClientRect();
      assert.ok(rect.height >= 44, `${item.dataset.action} is ${rect.height} px high`);
      assert.ok(rect.left >= 0 && rect.right <= 320, `${item.dataset.action} fits 320 px`);
    }
    click(up);
    await waitFor(() => blockIds()[0] === SQUAT, "squat to move up");
    assert.deepEqual(blockIds(), [SQUAT, BENCH]);
    // Move up is now disabled, so focus went to Move down
    await waitFor(() => doc.activeElement && doc.activeElement.dataset.action === "move-exercise-down", "focus on Move down");
    assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 }); // nothing stored but the plan

    // the sets of bench: two rows, then Reorder sets shows a Move line under each
    click(action(block(BENCH), "add-set"));
    await waitFor(() => block(BENCH).querySelectorAll("li.set-row").length === 2, "two bench rows");
    const rowIds = () => [...block(BENCH).querySelectorAll("li.set-row")].map((row) => row.dataset.setId);
    const [first, second] = rowIds();
    click($(block(BENCH), '[data-action="exercise-menu"]'));
    click(await waitFor(() => $(block(BENCH), '[data-action="reorder-sets"]'), "Reorder sets"));
    const moveDown = await waitFor(() => $(block(BENCH), `[data-action="move-set-down"][data-set-id="${first}"]`), "Move down for the first row");
    assert.equal(moveDown.getAttribute("aria-label"), "Move set 1 of Barbell bench press down");
    assert.equal($(block(BENCH), `[data-action="move-set-up"][data-set-id="${first}"]`).disabled, true);
    for (const item of block(BENCH).querySelectorAll(".move-line button")) {
      const rect = item.getBoundingClientRect();
      assert.ok(rect.height >= 44 && rect.width >= 44, `${item.dataset.action} is ${rect.width} x ${rect.height}`);
      assert.ok(rect.left >= 0 && rect.right <= 320);
    }
    click(moveDown);
    await waitFor(() => rowIds()[0] === second, "the first row to move down");
    assert.deepEqual(rowIds(), [second, first]);
    click(action(block(BENCH), "done-reordering"));
    await waitFor(() => $(block(BENCH), ".move-line") === null, "the move lines to go");
  }, { width: 320 });
});

// ---- focus after a move, with renders held open so the order of events does not depend on timing ----

// Makes the first call of object[method] wait until release() is called; later calls pass straight through.
// `answer`, when given, is returned instead of calling the real method (no database read after the release).
function holdFirstCall(object, method, answer) {
  const original = object[method].bind(object);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const hold = { release, held: false };
  object[method] = async (...args) => {
    if (hold.held) return answer === undefined ? original(...args) : answer;
    hold.held = true;
    await gate;
    return answer === undefined ? original(...args) : answer;
  };
  return hold;
}

const SQUAT_BLOCK = "seed-barbell-squat";
const squatControl = (root, action) => $(root, `.entry[data-exercise-id="${SQUAT_BLOCK}"] [data-action="${action}"]`);

async function twoExercises(root, app) {
  await pickExercise(root, "bench", BENCH);
  await pickExercise(root, "squat", SQUAT_BLOCK);
  await waitFor(() => squatControl(root, "exercise-menu"), "the squat block");
  await app.idle();
}

const focusedAction = () => document.activeElement && document.activeElement.dataset.action;

rule("ui: a Move click made while the menu's render is still reading the reminder keeps its focus request (focus goes to Move down)", async (ctx) => {
  await withApp(ctx, async ({ root, services, app }) => {
    await twoExercises(root, app);
    const inputs = await services.backup.getReminderInputs();
    const menuRender = holdFirstCall(services.backup, "getReminderInputs", inputs);
    try {
      click(squatControl(root, "exercise-menu")); // that render draws the menu, then waits for the reminder
      const moveUp = await waitFor(() => squatControl(root, "move-exercise-up"), "the Move up item");
      ctx.assert.ok(menuRender.held); // the menu's render is still waiting
      click(moveUp); // sets the focus request; the move is being written to the database
      menuRender.release(); // the held render finishes before that write does
      await waitFor(() => $(root, ".entry[data-exercise-id]").dataset.exerciseId === SQUAT_BLOCK, "squat to move up");
      await app.idle();
      ctx.assert.equal(focusedAction(), "move-exercise-down"); // Move up is now disabled
    } finally {
      menuRender.release(); // a failed wait must not leave a render hanging
    }
  });
});

rule("ui: a focus request is passed on from a render that a newer render replaced", async (ctx) => {
  await withApp(ctx, async ({ root, services, app }) => {
    await twoExercises(root, app);
    click(squatControl(root, "exercise-menu"));
    const up = await waitFor(() => squatControl(root, "move-exercise-up"), "the Move up item");
    await app.idle();
    const readingSession = holdFirstCall(services.logger, "getSession"); // render A, started by the move, waits here
    const readingReminder = holdFirstCall(services.backup, "getReminderInputs"); // render B waits here, after drawing
    try {
      click(up); // sets the focus request
      await waitFor(() => readingSession.held, "render A to wait");
      ctx.assert.equal(app.state.focus, null); // A took the request when it started
      const renderB = app.render(); // B starts with no request of its own
      await waitFor(() => readingReminder.held, "render B to draw and wait for the reminder");
      readingSession.release(); // A finishes, finds B has taken over, hands the request on
      await waitFor(() => app.state.focus !== null, "render A to hand the request on");
      readingReminder.release();
      await renderB;
      await app.idle();
      ctx.assert.equal(focusedAction(), "move-exercise-down");
      ctx.assert.equal(app.state.focus, null);
    } finally {
      readingSession.release(); // a failed wait must not leave a render hanging
      readingReminder.release();
    }
  });
});

// ---- motion: a panel fades in when it opens, and a redraw with it still open does not replay the fade ----

rule("motion: opening a confirm starts its fade, and a redraw with the confirm still open starts none", async (ctx) => {
  await withApp(ctx, async ({ root, app }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(action(root, "add-set"));
    await waitFor(() => lastPlanned(root), "the new row");
    click(action(root, "finish")); // an unchecked set is left, so it asks first
    const opened = await waitFor(() => region(root, "confirm-finish"), "the confirmation");
    // Positive control: with the real stylesheet loaded, the new panel has a running fade. If the CSS stops
    // matching, this fails instead of the next check passing for nothing. A browser set to reduce motion
    // (this desktop's Chrome is) shows no motion at all, so there the control is the opposite: still none.
    // In every mode (the mark is set by the code whatever the motion setting): the new panel is marked, a redrawn one is not.
    ctx.assert.equal(opened.dataset.anim, "in", "the opened confirm should be marked data-anim=in");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ctx.assert.deepEqual(opened.getAnimations().map((a) => a.animationName), reduced ? [] : ["fade-in"], "the opened confirm should fade in (and not at all under reduced motion)");
    await app.render(); // a redraw nobody asked for, with the confirm still open
    const redrawn = region(root, "confirm-finish");
    ctx.assert.ok(redrawn !== opened && !opened.isConnected, "the redraw built a new element");
    ctx.assert.equal(redrawn.dataset.anim, undefined, "a redrawn confirm must not be marked");
    ctx.assert.equal(redrawn.getAnimations().length, 0, "a redraw must not replay the fade");
  }, { width: 320 });
});

// The :active state cannot be simulated from a page, so the dip itself (scale 0.9) and the reduced-motion colour cue are not tested here.
rule("motion: the set delete button transitions its transform when motion is allowed", async (ctx) => {
  await withApp(ctx, async ({ root, frame }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "8", "100", "kg");
    click(action(root, "add-set"));
    const row = await waitFor(() => lastPlanned(root), "the new row");
    const del = row.querySelector('[data-action="delete-set"]');
    ctx.assert.ok(del !== null && del.classList.contains("delete-button"));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      ctx.assert.ok(frame.contentWindow.getComputedStyle(del).transitionProperty.split(",").map((p) => p.trim()).includes("transform"), "the delete button should transition transform");
    }
  }, { width: 320 });
});

// ---- the tab bar's sliding indicator (the nav's ::after, placed by data-active) ----

rule("tabs: after each switch the indicator sits under the active tab (left edge and width), passes taps through, and tapping the active tab changes nothing", async (ctx) => {
  await withApp(ctx, async ({ root, frame }) => {
    const win = frame.contentWindow;
    const nav = $(root, "nav.tabs");
    const settled = () => Promise.allSettled(nav.getAnimations({ subtree: true }).map((a) => a.finished)); // the slide is over
    const check = async (tab) => {
      await settled();
      ctx.assert.equal(nav.dataset.active, tab, `data-active after going to ${tab}`);
      const bar = win.getComputedStyle(nav, "::after");
      const barLeft = nav.getBoundingClientRect().left + new win.DOMMatrix(bar.transform).m41;
      const target = $(root, `[data-action="tab"][data-tab="${tab}"]`).getBoundingClientRect();
      ctx.assert.ok(Math.abs(barLeft - target.left) <= 1, `${tab}: bar left ${barLeft} vs tab left ${target.left}`);
      ctx.assert.ok(Math.abs(parseFloat(bar.width) - target.width) <= 1, `${tab}: bar width ${bar.width} vs tab width ${target.width}`);
    };
    ctx.assert.equal(win.getComputedStyle(nav, "::after").pointerEvents, "none", "the bar must not swallow taps");
    await check("log");
    for (const tab of ["history", "backup", "settings", "log"]) {
      await goToTab(root, tab);
      await check(tab);
    }
    await goToTab(root, "backup");
    await check("backup");
    click($(root, '[data-action="tab"][data-tab="backup"]')); // already active
    await goToTab(root, "backup");
    await check("backup");
  }, { width: 320 });
});
