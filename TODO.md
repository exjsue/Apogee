# TODO

## Owner actions
- [ ] Make the repo public and turn on GitHub Pages (Settings, Pages, deploy from branch `main`, folder `/ (root)`). Only the owner does this; the site would be https://exjsue.github.io/GymAppppp/
- [ ] Do not host any other site on the exjsue.github.io account until the app has a custom domain (see DECISIONS.md: every Pages site on the account shares one origin and can read the app's IndexedDB)
- [ ] Restart the dev server if it was started before the first screen was added (an older `node tools/serve.js` keeps port 8080 and serves the old files)
- [ ] Data logged at http://127.0.0.1:8080/ stays on that origin: move it to the live site with Export, then Import

## After the first deploy
- [ ] Open the live site and the test page (/tests/browser/index.html) and confirm the app loads at the /GymAppppp/ subpath and the browser tests pass (every path is relative, but this is untested on Pages)
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
- [ ] **Verify on iPhone (rest timer):** the check and the three row states, the countdown and the pie in the Home Screen app, leaving the app and coming back after the rest ended, locking the phone mid-rest, editing a time by tapping it, Add set showing no timer, finishing with unchecked sets, and the grey done state in daylight

## Deferred
- [ ] Importers (Strong, Liftoff); each needs a mapping onto the fixed muscle and equipment lists
- [ ] Muscle diagram, strength ranking, streaks
- [ ] iPhone native app / Android
- [ ] Opt-in AI feature (do not build until owner approves)
