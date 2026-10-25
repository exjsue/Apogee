# TODO

## Owner actions
- [ ] Make the repo public and turn on GitHub Pages (Settings, Pages, deploy from branch `main`, folder `/ (root)`). Only the owner does this; the site would be https://exjsue.github.io/Apogee/
- [ ] Do not host any other site on the exjsue.github.io account until the app has a custom domain (see DECISIONS.md: every Pages site on the account shares one origin and can read the app's IndexedDB)
- [ ] The whole repo root is published on GitHub Pages (design/, tools/, tests/ and the .md files are all reachable by URL), so nothing private ever goes in this repo: no exports or backups, no personal files, no unstripped images with metadata.
- [ ] Restart the dev server if it was started before the first screen was added (an older `node tools/serve.js` keeps port 8080 and serves the old files)
- [ ] Data logged at http://127.0.0.1:8080/ stays on that origin: move it to the live site with Export, then Import

## After the first deploy
- [ ] Open the live site and the test page (/tests/browser/index.html) and confirm the app loads at the /Apogee/ subpath and the browser tests pass (every path is relative, but this is untested on Pages)
- [ ] Check what Pages actually sends: the JavaScript content type, cache lifetime (modules could be cached for minutes after a deploy), and that nothing is requested from another origin
- [ ] Confirm the page's CSP (meta tag only on Pages) blocks nothing the app needs
- [ ] Offline on the live site: open it once, check Backup, Offline says Ready, then switch the network off and reload
- [ ] What Pages sends for sw.js, sw-manifest.js and manifest.webmanifest: JavaScript content type for the worker, a manifest content type the browser accepts, and cache lifetimes (the worker is registered with updateViaCache none, so its own files should not be held back)
- [ ] Publish a second version and watch the update flow on the live site: the Update available banner appears, nothing changes until Reload is clicked, data survives

## Verify on iPhone (nothing is tested there yet)
- [ ] Test on iPhone Safari and Firefox Focus at the live site (Pages is HTTPS, so this replaces the old plan to find hosting)
- [ ] Re-test persist() after installing to the Safari home screen
- [ ] Verify file download and the file picker on iPhone Safari and Firefox Focus (the plain-text export is the fallback)
- [ ] Check the layout, touch targets and dark mode on a real phone (only checked in desktop Chrome at 390 px wide)
- [ ] Verify crypto.randomUUID() works on both iOS browsers (needs a secure context, which Pages provides)
- [ ] Verify the Content-Security-Policy blocks nothing the app needs on iOS (blob download, file picker, the manifest and the worker)
- [ ] **Verify offline behavior and the update flow on iPhone Safari, installed (added to the Home Screen):** load once online, turn on airplane mode, open the installed app and check the workouts are there; then publish a new version and check the Update available banner, that nothing changes until Reload, and that the data survives
- [ ] Check whether the installed app really has storage separate from Safari's tabs (workouts logged in one must be exported and imported into the other if so), and whether the 7-day clearing of site data applies to it
- [ ] Check offline and updates in desktop Firefox and in Firefox Focus (the end-to-end check so far ran in headless Chrome only)
- [ ] Check that the icon, name and standalone window look right on the iPhone Home Screen (apple-touch-icon is 180 px; the G icon was only viewed as an image)

## Done
- [x] Data model, storage layer, export/import, minimal logging screen (in that order)
- [x] Export screen warns that the file is unencrypted and the app cannot control where it is saved
- [x] Import screen calls inspectBackup, shows the counts that will be replaced, and offers an export first
- [x] Repo prepared for GitHub Pages at a subpath: test.html removed, .gitignore and .nojekyll added, database name required and guarded by a test
- [x] Offline use: web app manifest and icons, a service worker with a generated precache list and version, a user-controlled update flow, an Offline section with a confirmed reset, and a guard test for sw.js (end-to-end checked in headless Chrome)
- [x] Recovery procedure for a broken worker is written down in OFFLINE.md, with the warning that clearing site data also deletes the workouts

## Next
- [ ] Backup into Settings: step 1a is built (the Backup section is drawn inside Settings, the Backup tab still exists). Still to do: 1b (remove the Backup tab, send the reminder's Go to Backup button to Settings, update the tests and OFFLINE.md) and step 2 (a Body placeholder tab between History and Settings). Check 1a on the phone first.
- [ ] Edit a logged set, and edit a finished workout (deleting one is done: History detail has Delete workout, with a confirmation)
- [ ] Check on a real phone that the Delete workout button in History detail is hard to tap by mistake (it sits at the bottom, away from Back, and asks first; there is no undo)
- [ ] Edit or delete a custom exercise (blocked until we decide what happens to sets that use it)
- [ ] The stale-build message ("Apogee could not open its database: ... Update the app.", src/ui/main.js and src/storage/idb-adapter.js) does not say how to update. It should say: close the app fully (on an iPhone, swipe the Home Screen app away in the app switcher) and open it again while online; it can take two launches, because the first may only download the new version and the next one runs it.
- [ ] Show the app version more widely if it helps support (today the first 8 characters of the cache version are in Backup, Offline only)
- [ ] Custom domain for the app: removes the shared-origin risk and allows real response headers (frame-ancestors, nosniff) if the host supports them
- [ ] Decide whether preferredUnit, seedVersion and the unfinished-workout choice should be part of exports (they live in meta and are not exported; a restored backup starts on lb)
- [ ] Decide how a seeded exercise removed by an import comes back (it does not: seeding runs once per SEED_VERSION)
- [ ] Notes in the UI (exercise, workout and entry notes exist in the model; they are single-line and limited to 500 characters)
- [ ] Profile model (age bracket, height, body weight)
- [ ] Consider optional passphrase encryption for exports (requires owner approval)
- [ ] Rest timer extras, feature-detected: Wake Lock while a timer runs, a sound at the end only after a tap unlocked audio (see the notes in DECISIONS.md); vibration is documented as unsupported on iOS Safari
- [ ] A way to mark a set as warm-up on the Log tab (isWarmup exists in the data; warm-up sets already get no timer)
- [ ] Planned (unchecked) sets live in meta, so they are not in a backup and are lost if site data is cleared; decide whether that is acceptable
- [ ] **Verify on iPhone (first launch after the update):** the database upgrades in place with your existing workouts (export first and confirm it, because a failed upgrade is undone but an export is your safety net), then History and the Backup tab show the same data, and Update Rest Timers in an exercise's three-dot menu changes only its unchecked sets
- [ ] A tab does not redraw by itself when another tab changes the workout (it shows the old state until its next action or tab change); consider a storage event or BroadcastChannel to refresh open tabs, without any network use
- [ ] The History delete and the old logSet path do not use the session revision (see DECISIONS.md on two tabs); route them through it if they ever run while a session is open in another tab
- [ ] **Verify on iPhone (pull-to-refresh):** see the checklist in the report of this change: does iOS fire touchmove while the page rubber-bands at the top, is there any native pull-to-refresh in the installed app, does overscroll-behavior-y: contain on html change anything, and do the guards (typing, menu, timer, unsaved text) hold on a real phone
- [ ] Pull-to-refresh in a Safari tab (not the installed app) may also trigger Safari's own reload; that bypasses the unsaved-text question (the timer and logged sets survive). Decide whether that matters
- [ ] **Verify on iPhone (rest timer):** the check and the three row states, the countdown and the pie in the Home Screen app, leaving the app and coming back after the rest ended, locking the phone mid-rest, editing a time by tapping it, Add set showing no timer, finishing with unchecked sets, and the grey done state in daylight
- [ ] Animation tuning: make the check circle animation slightly longer (now 160 ms; keep it under about 250 ms, opacity and transform only, reduced motion still none) and give its pop more size (now scale 0.94 to 1.05 to 1; try about 1.15). Look at it on the iPhone first

## UI / UX and Logging (added 2026-10-23)
- [x] Workout templates, data layer (done 2026-10-24, schema 4, not yet deployed): a template is its own record (name, ordered exercises with set counts) in a templates store; templateFromWorkout makes one from a finished workout (working sets only); export, import and the upgrade from every older schema are tested. No UI yet.
- [ ] **Task 2: templates UI** (needs a plan with diffs and approval, like the data layer):
  - [x] (commit 1, awaiting approval) Save as template on a finished workout in History (asks for a name; refused with the model's message when empty or over 80 characters; duplicate names are allowed).
  - [x] (commit 1, awaiting approval) A templates section in the tab, with Start, Rename and Delete; the tab was already renamed from "Log" to "New".
  - [x] (commit 1, awaiting approval; refused while anything is planned or running) Start a workout from a template: its exercises go into plan.exercises in template order, each with setCount blank unchecked rows (orders 0..setCount-1, reps and weight blank so the ghosts fill them, rest null, isWarmup false). Decide what happens when a plan or workout is already open.
  - [x] (commit 2, awaiting approval) The import preview gets a templates row: importing any file replaces the templates, and a file older than schema 4 leaves none.
  - src/domain/template.js enters the precache list once the UI imports it (rebuild sw-manifest.js).
  - [ ] Focus gap: when a workout is stale, the "Current workout" heading is not drawn, so focus after deleting the last template has no target and falls to the body (keyboard/VoiceOver gap, to fix later).
- [ ] Workout naming: allow naming a workout both during the session and after it is finished.
- [ ] Reorder sets within an exercise mid-workout. Set labels renumber. Logged data stays intact.
  - Risk: unchecked "planned" rows live in meta and checked sets are real records. Reordering must handle both without losing or duplicating either.
- [ ] Reorder exercises within the current workout (e.g., move deadlifts to the top if forgotten). Order does not matter for history; only that the sets are logged.
  - Risk: may need a stored order field and a schema or migration decision. Evaluate before building.
- [ ] Expand the default exercise library to be comprehensive and expandable, with user-created custom exercises stored separately.
  - Data model: base movement + structured attributes (equipment: barbell/smith/machine/dumbbell/etc.; variation: e.g., Romanian, stiff-leg, platform, grip). Each combination is its own trackable exercise with a stable id, so PRs and history never mix variants.
  - Sourcing: first step is a sources-and-licenses evaluation only, with no downloads. Candidates: free-exercise-db (UNVERIFIED: license and entry count) and wger (UNVERIFIED: believed share-alike). Generate variations on top of the base list.
  - Vendor static JSON in the repo. No runtime network calls. Controlled muscle and equipment vocabulary. No images yet.
  - Every exercise needs muscle targeting and equipment tags.
  - Wording note: do not promise "every exercise"; aim for comprehensive plus custom exercises.
  - When vendoring, include the upstream Unlicense text and the source repo commit hash in a data notice file, saying the Unlicense covers only entries with origin "upstream" (hand-written origin "authored" entries are not covered). Origin values: seed (the app's own seeds), upstream (from the source project), authored (written by hand in additions.txt; ids start with apogee-), custom (made by the user). The id prefix apogee- is unchanged.
  - Wiring the catalog into the app requires model.js (createExercise currently drops baseMovementId, equipment, variations, upstreamId), import validation, and the export format to be updated together. Needs approval. Also: add neck and abductors to the app muscle vocabulary.
  - Revisit the excluded entries (rotator cuff, circles, throws, get-ups, conflicting-evidence cases) when deciding a general shoulders value. Rotator cuff prehab is commonly logged, so excluding it means users will create custom exercises; pair those with builtins later. Smith/Dumbbell_Incline_Shoulder_Raise may be serratus or chest movements, so the upstream shoulders label may be wrong.
  - Review the null base-movement list (59 entries, the review files marked null-base-movement) and the multi-family review list (72 entries, "Other families that also matched"); add families in small passes, one rule and its tests at a time.
  - Audit families.md and outliers.md before wiring the catalog into the app.
  - Decide whether Reverse Triceps Bench Press keeps reverse-grip (its name has no grip word; it is the one approved row that does) and whether the plain reverse curls (Reverse Barbell Curl, Reverse Cable Curl, Reverse Plate Curls, Standing Dumbbell Reverse Curl) should get reverse-grip back by a named override.
  - Wiring the catalog into the app goes in small steps. src/catalog/ is generated and committed. Commit 6 (2026-10-24, not yet deployed) wires the library service into src/ui/main.js: insert-only sync after the first paint and after an import.
  - Before relying on the library sync: check on iPhone Safari and Firefox Focus that the first launch stores it (picker shows 846 with no custom exercises), how long logging waits behind the sync transaction there (desktop headless Chrome: about 170 ms), and that the dynamic import of src/catalog/catalog.js works under the page's Content-Security-Policy and offline.
  - Check the offline install with the larger precache list (39 files, about 501 KB) in a browser whose CacheStorage works: on 2026-10-24 headless Chrome 156 refused caches.open in fresh profiles (also on the previous commit), so the install was not checked and the browser page's real-reset UI test fails there.
  - Schema v3 is built (2026-10-23, not yet deployed): the seven exercise fields, the upgrade step 2 to 3 (seeds grouped, customs origin custom, history untouched), seeds as complete v3 records, and the export and import field lists (v1 and v2 files still import). Deploy only after the pre-deploy checklist (exports first, record counts noted, tools/compare-exports.js on the before and after exports).
  - syncCatalog (insert builtin records, verify records present): built and wired (commit 6). Retiring removed ids belongs to the refresh path below.
  - The catalog refresh path (new catalog version, rewrite of catalog-owned fields only, retired ids) needs its own explicit approval, after syncCatalog.
    - It must never delete a catalog exercise, or change its id, while a template refers to it (schema 4). Templates hold exercise ids only: a missing id would leave the template pointing at nothing, and an export containing it would fail to import (the importer rejects a template whose exercise is not in the file). That task must include a test for this.
  - Seeds: done in schema v3. The 15 paired seeds keep their name and muscles and gained grouping fields from src/catalog/seed-grouping.js; seed-lat-pulldown is set by hand (pulldown, cable). Seeds have catalogVersion null: a later refresh must never treat null as older for a seed and never rewrite a seed's name or muscles.
  - UI: allow neck and the new equipment in the custom form and picker.
  - OFFLINE.md note: what a v2 build shows on a v3 database. Done 2026-10-23 (OFFLINE.md, "An older version meets newer data").
  - Retired entries are hidden from the picker and search and still resolve in history; ids are never deleted (tools/exercise-catalog/retired.json lists the retired ones).
  - Beta testers: ask them to export before the schema upgrade (no forced prompt).
  - Export stays self-contained and includes the builtin records (about 290 KB more per export): measure a real export on an iPhone after the schema step.
- [ ] More animations across the app.
- [ ] Make existing animations smoother and more noticeable (currently 120-160 ms and very subtle). Must still turn off under Reduce Motion. NOTE: John's iPhone has Reduce Motion off, so animations show when testing. Phase 1 (done) covers the tab fade, panels, forms, notices, banners and button press at 200 ms (--motion). Phase 2: A (the set delete button's press dip), B and B2 (the set check's press dip, pop and disc at 200 ms), B3 (the boxes fade in on uncheck) and D1 (the new-row slide at 200 ms) are done. D2 (an exit animation for a deleted set) is dropped: the redraw destroys the old row, so it would be a ghost copy overlapping the row that moved up, which reads as a glitch. C (splash lines) is not started and optional.
- [x] Test "styles: the check control is a 44 px target…" read the check disc's opacity while the disc-in animation was running, so it failed with prefers-reduced-motion: no-preference (it passed here only because this desktop's Chrome reports Reduce Motion ON). Fixed (Phase 2 step B1, 2026-10-25): the test now waits for the check's animations to finish before reading the opacity; the assertion itself is unchanged.
- [x] Phase 2 step B3 (built 2026-10-25, waiting for the phone check): the weight and reps boxes fade in (opacity 0.3 to 1) when a set is unchecked. The check direction (a ghost box fading out behind the new text) is deliberately not built: it would be a fake fade-out with a hand-measured edge that could flicker. Remaining Phase 2: C (splash lines), optional; D1 done, D2 dropped (see the summary line above).
- [ ] Known flaky browser test: "the real reset removes only this app's caches…" fails intermittently with CacheStorage.open: Unexpected internal error in headless Chrome 156 (not caused by app code; waived in DECISIONS.md 2026-10-24).
- [ ] Move UI tabs to the bottom. Respect iOS safe-area insets (home indicator) in the Home Screen app.
- [ ] Make the set UI slightly smaller / more compact.
- [x] Show total workout time during a workout (done 2026-10-24 as a live elapsed time in the Current workout card; not yet tested on an iPhone).
- [x] Autofill from the previous set (done 2026-10-24; not yet tested on an iPhone): if the next set is empty and the set directly above it has a weight entered, show a ghost of the above set's weight and reps in the next set. Pressing check fills the next set with those exact values.
  - Ghost values are display-only and are not stored until check is pressed.
  - If the set above has weight but no reps: the ghost shows the weight only and the reps stay blank to be typed; no warning appears. Checking with blank reps is refused for now. Once checking such a set is allowed (deferred, see "Sets with no reps" below), it is excluded from volume and estimated-1RM calculations until reps are entered.
- [x] Previous-workout ghost (done 2026-10-24, warm-ups excluded; not yet tested on an iPhone): if an exercise was done in an earlier workout, the first empty set of that exercise shows a ghost of the heaviest set from the most recent session (e.g., last time 225 lb x 4 deadlift, so the ghost shows 225 x 4). Pressing check fills in those values.
  - Later empty sets ghost the set directly above them in the current workout (see autofill item).
  - Revisit when warmup sets, dropsets, and supersets are added, since "heaviest set" may need to exclude warmups.
- [x] Completed (greyed-out) sets stay editable (done 2026-10-24 for the current workout, through logger.editSet; not yet tested on an iPhone). Editing does not restart the rest timer, does not change the completion timestamp, and does not uncheck the set (unchecking currently deletes the set, so edit handlers must not go through the uncheck path).
- [ ] Calculation rule: sets with no reps entered are excluded from volume and estimated-1RM calculations.
- [ ] Sets with no reps (deferred, stored-data step, needs explicit approval with diffs per the 2026-10-23 decision): allow checking a set with weight and no reps (reps null), update requireReps, createWorkSet, import validation and the export format, decide on a schema version, then add volume and estimated-1RM with the exclusion of such sets. Until then checkSet and editSet refuse blank reps.
- [ ] Editing sets of finished workouts (from History). editSet only edits the current workout.
- [ ] Focus the weight field when the set edit form opens (currently a second tap is needed on a phone). Try after a week of real use.

## Deferred
- [ ] Optional app fix, aria-current (added 2026-10-24): in renderNow (src/ui/app.js) only set aria-current for the tab whose content was drawn, by capturing state.tab at the start of renderNow. Today an older render in flight can mark the new tab current while the previous tab's content is on screen (briefly; it corrects itself on the next draw). The tests now wait for the content instead (DECISIONS.md, 2026-10-24). Revisit at the VoiceOver pass.
- [ ] Focus hand-back (src/ui/app.js renderNow), added 2026-10-24: untested case where the newer render has already finished when the older one hands the request back; the request is left in state.focus for a later render. Possible fix: track whether a newer render is still in flight and drop the request if not; needs a test.
- [ ] Focus hand-back (src/ui/app.js renderNow), added 2026-10-24: a new Move click made after a hand-back but before the newer render finishes could be taken by that render against the old DOM (inference, untested).
- [ ] **Schema 5: workout name** (deferred 2026-10-24, not started; schema 4 went to templates). A workout has no name field and `notes` must not be reused (it would change that field's meaning). The task: add a `name` field to workouts (single line, whitespace collapsed, empty = no name, at most 80 characters, longer refused), a schema 5 migration that gives every stored workout the default, `createWorkout`, the export field list and import of older files (src/backup/backup.js, RECORD_FIELDS), naming during and after a workout, and tests (migration, export/import round trip, an old file imports, limits). Run it on Opus; present the plan with diffs first; the owner approves each commit (approved commit N); verify with a friend's fresh export and the five counts that tools/compare-exports.js prints for each section (exercises, workouts, entries, sets, templates), before and after.
- [ ] Importers (Strong, Liftoff); each needs a mapping onto the fixed muscle and equipment lists
- [ ] Muscle diagram, strength ranking, streaks
- [ ] iPhone native app / Android
- [ ] Opt-in AI feature (do not build until owner approves)
- [ ] Search ranking: name matches should rank above equipment/notes matches (e.g. 'bench' returns Barbell hip thrust). Deferred by John 2026-10-24.
- [ ] Make the logger.js "not finished; use Discard on the New tab" error message tab-agnostic (domain logic should not name a UI tab). Deferred 2026-10-24.
