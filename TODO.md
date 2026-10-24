# TODO

## Owner actions
- [ ] Make the repo public and turn on GitHub Pages (Settings, Pages, deploy from branch `main`, folder `/ (root)`). Only the owner does this; the site would be https://exjsue.github.io/Apogee/
- [ ] Do not host any other site on the exjsue.github.io account until the app has a custom domain (see DECISIONS.md: every Pages site on the account shares one origin and can read the app's IndexedDB)
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
- [ ] Edit a logged set, and edit a finished workout (deleting one is done: History detail has Delete workout, with a confirmation)
- [ ] Check on a real phone that the Delete workout button in History detail is hard to tap by mistake (it sits at the bottom, away from Back, and asks first; there is no undo)
- [ ] Edit or delete a custom exercise (blocked until we decide what happens to sets that use it)
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
- [ ] Workout templates from history: save a past workout as a reusable routine. Optional, never automatic. Stores planned exercises and set counts only, not logged weights or reps.
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
  - When vendoring, include the upstream Unlicense text and the source repo commit hash in a data notice file.
  - Wiring the catalog into the app requires model.js (createExercise currently drops baseMovementId, equipment, variations, upstreamId), import validation, and the export format to be updated together. Needs approval. Also: add neck and abductors to the app muscle vocabulary.
  - Revisit the excluded entries (rotator cuff, circles, throws, get-ups, conflicting-evidence cases) when deciding a general shoulders value. Rotator cuff prehab is commonly logged, so excluding it means users will create custom exercises; pair those with builtins later. Smith/Dumbbell_Incline_Shoulder_Raise may be serratus or chest movements, so the upstream shoulders label may be wrong.
- [ ] More animations across the app.
- [ ] Make existing animations smoother and more noticeable (currently 120-160 ms and very subtle). Must still turn off under Reduce Motion. NOTE: John's iPhone has Reduce Motion on, so he must turn it off to see animations when testing.
- [ ] Move UI tabs to the bottom. Respect iOS safe-area insets (home indicator) in the Home Screen app.
- [ ] Make the set UI slightly smaller / more compact.
- [ ] Show total workout time at the very top during a workout.
- [ ] Autofill from the previous set: if the next set is empty and the set directly above it has a weight entered, show a ghost of the above set's weight and reps in the next set. Pressing check fills the next set with those exact values.
  - Ghost values are display-only and are not stored until check is pressed.
  - If the set above has weight but no reps: reps stay blank, nothing is shown to the user and no warning appears. Once checked, the set is excluded from volume and estimated-1RM calculations until reps are entered.
- [ ] Previous-workout ghost: if an exercise was done in an earlier workout, the first empty set of that exercise shows a ghost of the heaviest set from the most recent session (e.g., last time 225 lb x 4 deadlift, so the ghost shows 225 x 4). Pressing check fills in those values.
  - Later empty sets ghost the set directly above them in the current workout (see autofill item).
  - Revisit when warmup sets, dropsets, and supersets are added, since "heaviest set" may need to exclude warmups.
- [ ] Completed (greyed-out) sets stay editable. Editing does not restart the rest timer, does not change the completion timestamp, and does not uncheck the set (unchecking currently deletes the set, so edit handlers must not go through the uncheck path).
- [ ] Calculation rule: sets with no reps entered are excluded from volume and estimated-1RM calculations.

## Deferred
- [ ] Importers (Strong, Liftoff); each needs a mapping onto the fixed muscle and equipment lists
- [ ] Muscle diagram, strength ranking, streaks
- [ ] iPhone native app / Android
- [ ] Opt-in AI feature (do not build until owner approves)
