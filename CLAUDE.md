# Project: GymApp (privacy-first workout tracker, web app)

## Status
node --test passes. The browser test page (tests/browser/index.html, including UI smoke tests) passes in headless Chrome; the owner's earlier storage and export/import runs passed in desktop Firefox and Chrome. Nothing is tested on iPhone yet: layout, download, file picker and the Content-Security-Policy there are unverified. Offline use: a service worker (sw.js) precaches the app and serves it cache-first; a new version waits until the user clicks Reload on the Update available banner; the Backup tab has an Offline section with a confirmed Reset offline copy. This is verified end to end in headless Chrome (install, offline reload with data intact, the update flow, an install that fails as a whole, reset) but not in Firefox or Safari, and not installed on an iPhone. The repo is prepared for GitHub Pages at the subpath https://exjsue.github.io/GymAppppp/ (public repo, .nojekyll, every path in the page relative) but is not published or tested there yet; the owner makes the repo public and turns Pages on. The app's real database name is defined once in src/storage/schema.js, createIdbAdapter requires a name, and tests/guard.test.js fails if a test uses the app's database or its name.

## Privacy rules (non-negotiable unless the owner changes them)
- All user data stays on the user's device. Store it in the browser's IndexedDB, never on a server.
- No analytics, tracking, crash-reporting, or advertising SDKs. No third-party scripts, fonts, or CDN assets that send data to another host.
- No account system. No sync in v1 unless end-to-end encrypted and the owner approves the design.
- Age is stored only as an age bracket, never a birthdate. Height and weight are optional, stored locally, and never transmitted.
- Strength ranking is optional, computed on-device, and never compared with other users.
- Any AI feature is opt-in per request, sends the minimum necessary text, and shows the user exactly what will be sent first. Do not build it until the owner says so.
- Flag any dependency or library that makes a network call. Ask before adding one.

## Technical direction
- Stack: plain HTML, CSS, and JavaScript. No frameworks and no build tools yet. Adding either needs owner approval.
- Storage: IndexedDB, with all data on-device. Request persistent storage with `navigator.storage.persist()`.
- Offline-capable. No network calls at runtime except same-origin requests by the service worker, to cache the app's own files and check for updates. No third-party hosts, ever.
- Export and import of user data is required in v1, not optional.
- Domain logic lives in JavaScript modules with no DOM access.
- Keep the data layer (domain model, storage, importers, search) separate from the UI, so it can be reused later.
- Importers are isolated modules, each with sample-file tests.

## Test targets
- Primary test browsers: iPhone Safari and Firefox Focus for iOS.
- Verify that data persists across app restarts in both browsers before relying on it.

## Testing rules (standing)
- Keep tests focused on data safety: export/import, migrations, schema upgrades, timer logic, and anything that could silently lose or corrupt data.
- No tests for visual layout or trivial getters. Add only tests that would catch a real regression.
- Run the existing suite once at the end of a task, not after every small edit.
- Finish each task's report with one line saying how many tests were added and why.
- Never delete existing tests. If a deliberate change makes one wrong, say so and get the owner's agreement first; keep the old assertion's intent covered by the new test.

## How we work
- Before writing code, state the plan and the main risk. Wait for approval on anything that changes privacy rules or architecture.
- Build in small verifiable steps: data model, logging, exercise library, import, search, UI polish.
- Commit to git after each working step.
- Keep DECISIONS.md (dated decisions with reasons) and TODO.md (deferred items, including Android and the AI feature) up to date.
- When a bug is reported, ask for the exact error or reproduction steps before proposing a fix.

## Commands
- Run: node tools/serve.js, then open http://127.0.0.1:8080/ (fixed port; the server stops if it is taken, because browser storage is per origin including the port)
- Offline copy on this computer: the service worker registers by itself on every address except 127.0.0.1, localhost and [::1], where it needs ?sw=1 on the address (http://127.0.0.1:8080/?sw=1). Without it, an installed copy would keep showing old files after every edit. Once registered it stays until you use Backup, Offline, Reset offline copy.
- After changing ANY file the app loads (anything under src/, index.html, the manifest, the icons) or sw.js: node tools/build-sw-manifest.js. It rewrites sw-manifest.js (the precache list and the version, found from the real import graph). node --test fails while sw-manifest.js is stale. To redraw the icons: node tools/make-icons.js.
- Recovery from a broken worker, how updates work, and what clearing site data does (it also deletes your workouts): OFFLINE.md.
- Test: node --test
- Browser tests (IndexedDB adapter, storage, backup, logger and UI smoke tests): with the server running, open http://127.0.0.1:8080/tests/browser/index.html
- Live site (once the owner turns Pages on): https://exjsue.github.io/GymAppppp/ and, for the browser tests, https://exjsue.github.io/GymAppppp/tests/browser/index.html. It is served at a subpath, so every URL and import path must stay relative. Data on the live site is separate from data on 127.0.0.1:8080 (different origin); move it with Export and Import.
