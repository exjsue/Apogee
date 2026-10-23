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

## Verify on iPhone (nothing is tested there yet)
- [ ] Test on iPhone Safari and Firefox Focus at the live site (Pages is HTTPS, so this replaces the old plan to find hosting)
- [ ] Re-test persist() after installing to the Safari home screen
- [ ] Verify file download and the file picker on iPhone Safari and Firefox Focus (the plain-text export is the fallback)
- [ ] Check the layout, touch targets and dark mode on a real phone (only checked in desktop Chrome at 390 px wide)
- [ ] Verify crypto.randomUUID() works on both iOS browsers (needs a secure context, which Pages provides)
- [ ] Verify the Content-Security-Policy blocks nothing the app needs on iOS (blob download, file picker)

## Done
- [x] Data model, storage layer, export/import, minimal logging screen (in that order)
- [x] Export screen warns that the file is unencrypted and the app cannot control where it is saved
- [x] Import screen calls inspectBackup, shows the counts that will be replaced, and offers an export first
- [x] Repo prepared for GitHub Pages at a subpath: test.html removed, .gitignore and .nojekyll added, database name required and guarded by a test

## Next
- [ ] Edit a logged set, and edit a finished workout (deleting one is done: History detail has Delete workout, with a confirmation)
- [ ] Check on a real phone that the Delete workout button in History detail is hard to tap by mistake (it sits at the bottom, away from Back, and asks first; there is no undo)
- [ ] Edit or delete a custom exercise (blocked until we decide what happens to sets that use it)
- [ ] Offline use: service worker and web app manifest (the CSP will need `manifest-src 'self'`; a service worker is already allowed by `script-src 'self'`; both must use relative paths because of the subpath)
- [ ] Custom domain for the app: removes the shared-origin risk and allows real response headers (frame-ancestors, nosniff) if the host supports them
- [ ] Decide whether preferredUnit, seedVersion and the unfinished-workout choice should be part of exports (they live in meta and are not exported; a restored backup starts on lb)
- [ ] Decide how a seeded exercise removed by an import comes back (it does not: seeding runs once per SEED_VERSION)
- [ ] Notes in the UI (exercise, workout and entry notes exist in the model; they are single-line and limited to 500 characters)
- [ ] Profile model (age bracket, height, body weight)
- [ ] Consider optional passphrase encryption for exports (requires owner approval)

## Deferred
- [ ] Importers (Strong, Liftoff); each needs a mapping onto the fixed muscle and equipment lists
- [ ] Muscle diagram, strength ranking, streaks
- [ ] iPhone native app / Android
- [ ] Opt-in AI feature (do not build until owner approves)
