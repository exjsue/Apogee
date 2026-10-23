// UI smoke tests. Browser only: they mount the real UI into the page against a
// throwaway IndexedDB database and drive it with clicks and typing, the way a
// person would. They check that the screens are wired to the logic, not how
// they look. Not run by node --test.

import { createStore } from "../../src/storage/store.js";
import { createBackup } from "../../src/backup/backup.js";
import { createLogger } from "../../src/app/logger.js";
import { checkPersistence } from "../../src/app/persistence.js";
import { showDatabaseNotice } from "../../src/ui/db-notices.js";
import { SEED_EXERCISES, SEED_VERSION } from "../../src/domain/seed.js";
import { mountApp } from "../../src/ui/app.js";
import { createOffline, CACHE_PREFIX } from "../../src/app/offline.js";
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

// Mounts the app against a fresh seeded database and cleans up afterwards.
async function withApp(ctx, body, { prepare, offline } = {}) {
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
  };
  const root = document.createElement("div");
  document.body.append(root); // forms only submit when they are in the document
  let app = null;
  try {
    app = await mountApp(root, services);
    await body({ root, store, adapter, services, calls, app });
  } finally {
    root.remove(); // also stops any ticker, which only runs while its view is on the page
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

// Types into the last unchecked row and taps its check.
async function submitSet(root, reps, weight, unit = "kg") {
  const row = lastPlanned(root);
  setValue(row.querySelector('[data-field="reps"]'), reps);
  setValue(row.querySelector('[data-field="weight"]'), weight);
  row.querySelector('[data-field="unit"]').value = unit;
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

const goToTab = async (root, tab) => {
  click($(root, `[data-action="tab"][data-tab="${tab}"]`));
  await waitFor(() => $(root, `[data-action="tab"][data-tab="${tab}"]`).getAttribute("aria-current") === "page", `the ${tab} tab`);
};

// ---- tests ----

rule("ui: the app mounts with the log screen, tabs and unit toggle", async (ctx) => {
  await withApp(ctx, async ({ root }) => {
    ctx.assert.ok(root.textContent.includes("GymApp"));
    ctx.assert.ok(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
    ctx.assert.equal(root.querySelectorAll('[data-action="tab"]').length, 3);
    const pressed = [...root.querySelectorAll('[data-action="set-unit"]')].filter((b) => b.getAttribute("aria-pressed") === "true");
    ctx.assert.deepEqual(pressed.map((b) => b.dataset.unit), ["lb"]); // the default
    ctx.assert.ok(root.textContent.includes("No workout in progress"));
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
    ctx.assert.ok(root.textContent.includes("8 reps"));
    // stored in kg, displayed in the default unit (lb) with the original shown
    ctx.assert.ok(root.textContent.includes("220.5 lb (entered 100 kg)"));
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
    // Add set gives a new unchecked row, prefilled from the last set
    click(action(root, "add-set"));
    const next = await waitFor(() => lastPlanned(root), "the new row");
    ctx.assert.equal(next.querySelector('[data-field="reps"]').value, "8");
    ctx.assert.equal(next.querySelector('[data-field="weight"]').value, "100");
    ctx.assert.equal(next.querySelector('[data-field="unit"]').value, "kg");
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
    await submitSet(root, "8", "5512", "lb");
    await waitFor(() => errorText(root) === "weight is above the maximum of 5511.55 lb", "the lb maximum message");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
  });
});

rule("ui: the kg/lb toggle changes what is displayed and is remembered, never what is stored", async (ctx) => {
  await withApp(ctx, async ({ root, store, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await logOneSet(root, "5", "100", "kg");
    click(root.querySelector('[data-action="set-unit"][data-unit="kg"]'));
    await waitFor(() => root.textContent.includes("5 reps · 100 kg") && !root.textContent.includes("entered"), "weights shown in kg");
    ctx.assert.equal(await store.getPreferredUnit(), "kg");
    const sets = await adapter.transaction(["sets"], "readonly", (tx) => tx.getAll("sets"));
    ctx.assert.deepEqual(sets.map((s) => [s.weightValue, s.weightUnit]), [[100, "kg"]]);
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
    ctx.assert.ok(/^gymapp-export-\d{4}-\d{2}-\d{2}\.json$/.test(calls.downloads[0].filename));
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
    ctx.assert.equal(doc.app, "gymapp-export");
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
    setValue(await waitFor(() => field(root, "rest"), "the rest editor"), "90");
    click(action(root, "save-rest"));
    await waitFor(() => /look like 3:00/.test(region(root, "rest-error").textContent) && !region(root, "rest-error").hidden, "the format message");
    setValue(field(root, "rest"), "0:02");
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
    ctx.assert.equal(input.value, "3:00");
    setValue(input, "90"); // a bare number is refused
    click(action(root, "save-default-rest"));
    await waitFor(() => !region(root, "default-rest-error").hidden && /look like 3:00/.test(region(root, "default-rest-error").textContent), "the format message");
    setValue(field(root, "default-rest"), "1:30");
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
    ctx.assert.equal((await waitFor(() => field(root, "default-rest"), "the editor")).value, "1:30");
    click(action(root, "cancel-default-rest"));
    await waitFor(() => !field(root, "default-rest"), "the editor to close");
  });
});

rule("ui: the database notices say what is going on, and the reload button is only on the one that needs it", async (ctx) => {
  const root = document.createElement("div");
  let reloads = 0;
  const blocked = showDatabaseNotice(root, "blocked", { reload: () => { reloads += 1; } });
  ctx.assert.ok(/waiting for another GymApp tab/.test(blocked.textContent));
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
  const prefix = "gymapp-test-precache-";
  const decoys = ["other-site-cache", "gymapp-test-precache", "my-gymapp-test-precache-1", `${CACHE_PREFIX}decoy-with-the-real-prefix`];
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
