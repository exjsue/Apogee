// UI smoke tests. Browser only: they mount the real UI into the page against a
// throwaway IndexedDB database and drive it with clicks and typing, the way a
// person would. They check that the screens are wired to the logic, not how
// they look. Not run by node --test.

import { createStore } from "../../src/storage/store.js";
import { createBackup } from "../../src/backup/backup.js";
import { createLogger } from "../../src/app/logger.js";
import { SEED_EXERCISES, SEED_VERSION } from "../../src/domain/seed.js";
import { mountApp } from "../../src/ui/app.js";
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
async function withApp(ctx, body, { prepare } = {}) {
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
    requestPersistentStorage: async () => {
      calls.persist += 1;
      return { supported: true, persisted: false, error: null };
    },
  };
  const root = document.createElement("div");
  document.body.append(root); // forms only submit when they are in the document
  try {
    const app = await mountApp(root, services);
    await body({ root, store, adapter, services, calls, app });
  } finally {
    root.remove();
  }
}

async function pickExercise(root, query, id) {
  click(await waitFor(() => action(root, "choose-exercise"), "the Choose exercise button"));
  setValue(await waitFor(() => field(root, "search"), "the search box"), query);
  click(await waitFor(() => $(root, `[data-action="pick-exercise"][data-exercise-id="${id}"]`), "the exercise in the list"));
  await waitFor(() => field(root, "reps"), "the set form");
}

async function submitSet(root, reps, weight, unit = "kg") {
  setValue(field(root, "reps"), reps);
  setValue(field(root, "weight"), weight);
  field(root, "unit").value = unit;
  click(action(root, "log-set"));
}

async function logOneSet(root, reps, weight, unit) {
  // the previous set's message is still on screen; remove it so we wait for a new one
  const old = region(root, "notice");
  if (old) old.remove();
  await submitSet(root, reps, weight, unit);
  await waitFor(() => region(root, "notice") && region(root, "notice").textContent === "Set logged.", "the Set logged message");
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

rule("ui: choosing an exercise from search and logging a set shows it in the current workout", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    ctx.assert.ok(root.textContent.includes("Barbell bench press"));
    await logOneSet(root, "8", "100", "kg");
    await waitForText(root, "Current workout");
    ctx.assert.ok(root.textContent.includes("8 reps"));
    // stored in kg, displayed in the default unit (lb) with the original shown
    ctx.assert.ok(root.textContent.includes("220.5 lb (entered 100 kg)"));
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
    // the form is ready for the next set, prefilled from the last one
    ctx.assert.equal(field(root, "reps").value, "8");
    ctx.assert.equal(field(root, "weight").value, "100");
    ctx.assert.equal(field(root, "unit").value, "kg");
  });
});

rule("ui: a blank weight or blank reps shows an error and logs nothing", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    await submitSet(root, "8", "   ");
    const error = await waitFor(() => region(root, "set-error") && !region(root, "set-error").hidden && region(root, "set-error"), "the weight error");
    ctx.assert.ok(/weight is required/.test(error.textContent));
    await submitSet(root, "", "100");
    await waitFor(() => /reps is required/.test(region(root, "set-error").textContent), "the reps error");
    await submitSet(root, "8", "1,500");
    await waitFor(() => /weight must be a number/.test(region(root, "set-error").textContent), "the weight format error");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 0, entries: 0, sets: 0 });
    await submitSet(root, "8", "0"); // an explicit zero is bodyweight
    await waitForText(root, "Bodyweight");
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 1 });
  });
});

rule("ui: negative and too-large numbers say what is wrong", async (ctx) => {
  await withApp(ctx, async ({ root, adapter }) => {
    await pickExercise(root, "bench", BENCH);
    const errorText = () => region(root, "set-error").textContent;
    await submitSet(root, "8", "-3");
    await waitFor(() => errorText() === "weight can't be negative", "the negative weight message");
    await submitSet(root, "-3", "100");
    await waitFor(() => errorText() === "reps can't be negative", "the negative reps message");
    await submitSet(root, "920319039", "100");
    await waitFor(() => errorText() === "reps is above the maximum of 1000", "the reps maximum message");
    await submitSet(root, "8", "2500.5", "kg");
    await waitFor(() => errorText() === "weight is above the maximum of 2500 kg", "the kg maximum message");
    await submitSet(root, "8", "5512", "lb");
    await waitFor(() => errorText() === "weight is above the maximum of 5511.55 lb", "the lb maximum message");
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
    await waitFor(() => field(root, "reps"), "the set form for the new exercise");
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
    ctx.assert.ok(/not generated an export yet/.test(region(root, "last-export").textContent));

    click(action(root, "download-export"));
    await waitFor(() => calls.downloads.length === 1, "the download to start");
    ctx.assert.ok(/^gymapp-export-\d{4}-\d{2}-\d{2}\.json$/.test(calls.downloads[0].filename));
    ctx.assert.equal(calls.downloads[0].blob.type, "application/json");
    await waitFor(() => /Last export generated/.test(region(root, "last-export").textContent), "the last export time");

    click(action(root, "show-export-text"));
    const box = await waitFor(() => field(root, "export-text"), "the export text box");
    const doc = JSON.parse(box.value);
    ctx.assert.equal(doc.app, "gymapp-export");
    ctx.assert.equal(doc.data.exercises.length, SEED_EXERCISES.length);
    ctx.assert.ok(action(root, "select-export-text") && action(root, "copy-export-text"));
  });
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
    await waitForText(root, "Imported 1 workout");
    ctx.assert.deepEqual((await store.listExercises()).map((exercise) => exercise.id), ["ex-row"]);
    ctx.assert.deepEqual(await rawCounts(adapter), { workouts: 1, entries: 1, sets: 2 });
  });
});

rule("ui: asking for persistent storage reports the browser's answer", async (ctx) => {
  await withApp(ctx, async ({ root, calls }) => {
    await goToTab(root, "backup");
    click(await waitFor(() => action(root, "persist"), "the storage button"));
    await waitFor(() => /did not promise/.test(region(root, "persist-result").textContent), "the answer");
    ctx.assert.equal(calls.persist, 1);
  });
});

rule("page: every resource this page loaded came from this origin", async ({ assert }) => {
  const foreign = performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("data:") && new URL(name).origin !== location.origin);
  assert.deepEqual(foreign, []);
});
