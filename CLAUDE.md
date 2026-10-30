# Project: Apogee (privacy-first workout tracker, web app)

## Status
The app is a PWA served from GitHub Pages and used as a Home Screen app. Current test counts, verification status and open items live in DECISIONS.md and TODO.md, not here. The app's real database name is defined once in src/storage/schema.js, createIdbAdapter requires a name, and tests/guard.test.js fails if a test uses the app's database or its name.

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
- Finish each report with the number of tests added and why, and a "what the tests did not cover" list.
- Never delete an existing test, and stop and ask the owner before changing any existing test assertion. If a deliberate change makes one wrong, say so and get the owner's agreement first; keep the old assertion's intent covered by the new test.

## How we work
- Before writing code, state the plan and the main risk. Wait for approval on anything that changes privacy rules or architecture.
- Build in small verifiable steps: data model, logging, exercise library, import, search, UI polish.
- Git: see the Git policy section.
- Keep DECISIONS.md (dated decisions with reasons) and TODO.md (deferred items, including Android and the AI feature) up to date.
- When a bug is reported, ask for the exact error or reproduction steps before proposing a fix.

## Verification checklist (every task)
- Full Node suite: node --test
- Browser suite in a throwaway Chrome profile with a throwaway database name (the browser test page shares an origin with the live app).
- Never run the browser page on the owner's phone.
- Control-character scan over tools/, tests/, src/, DECISIONS.md and TODO.md (regex \b can become a literal backspace).
- Stop any server started for browser tests (ports 8098 and 8099) afterward.
- Never run taskkill /IM chrome.exe or any kill by image name: it closes the owner's own Chrome. Stop only the throwaway profile's own Chrome, by the process ID started for it or by matching that profile's folder in the command line, and say which was used. Do not touch the owner's Chrome.

## Working rules
- Use the Edit tool, never sed -i.
- Line endings: git stores every file as LF (check with git ls-files --eol); CRLF in a working copy comes from core.autocrlf and is harmless. Do not convert endings or rewrite whole files; use the Edit tool so only the intended lines change.
- For any change to shared app code, show the verbatim git diff before asking for approval.
- Add a DECISIONS.md row for every architectural or privacy decision.
- Never switch models mid-session.
- Run no plugin skill or command unless the owner asks.
- Never touch .gitignore or graphify-out/.

## Git policy (owner review required)
- Reviewed and approved by the owner in chat on 2026-10-24.
- After approval, auto-commit and push are allowed only for steps with no stored-data change (no schema change, nothing that alters what is written to IndexedDB or to backups).
- If unsure whether a step touches stored data, treat it as a stored-data step and do not commit.
- Add files by name only. Never git add . and never touch graphify-out/.
- Abort without pushing if git status is unexpected, any Node test fails, the browser suite fails, or any control-character hit appears.
- No force push, no history rewriting, no tags or releases (the owner tags releases).
- Report the commit hash and file list each time.
- Commit messages are plain: no Co-Authored-By line and no tool or AI attribution.
- Stored-data steps (schema changes, sets with no reps, workout naming) are never auto-committed: plan with diffs first, wait for the owner's "approved commit N", and the owner pushes manually.
- These rules are instructions, not enforced limits.
- If .git/index.lock blocks git: check Get-Process git, then Remove-Item .git\index.lock.

## Commands
- Run: node tools/serve.js, then open http://127.0.0.1:8080/ (fixed port; the server stops if it is taken, because browser storage is per origin including the port)
- Offline copy on this computer: the service worker registers by itself on every address except 127.0.0.1, localhost and [::1], where it needs ?sw=1 on the address (http://127.0.0.1:8080/?sw=1). Without it, an installed copy would keep showing old files after every edit. Once registered it stays until you use Backup, Offline, Reset offline copy.
- After changing ANY file the app loads (anything under src/, index.html, the manifest, the icons) or sw.js: node tools/build-sw-manifest.js. It rewrites sw-manifest.js (the precache list and the version, found from the real import graph). node --test fails while sw-manifest.js is stale. To redraw the icons: node tools/make-icons.js.
- Recovery from a broken worker, how updates work, and what clearing site data does (it also deletes your workouts): OFFLINE.md.
- Test: node --test
- Browser tests (IndexedDB adapter, storage, backup, logger and UI smoke tests): with the server running, open http://127.0.0.1:8080/tests/browser/index.html
- Live site: https://exjsue.github.io/Apogee/ and, for the browser tests, https://exjsue.github.io/Apogee/tests/browser/index.html. It is served at a subpath, so every URL and import path must stay relative. Data on the live site is separate from data on 127.0.0.1:8080 (different origin); move it with Export and Import.

## Browser test method
How the browser suite is run without touching the owner's Chrome or phone (used since Stage 2; the driver script is not in the repo):
1. Start the server on a spare port, not 8080: `node tools/serve.js 8098`, as its own process, and keep its PID (Start-Process -PassThru).
2. A driver script (Node 22+, no packages) starts a new headless Chrome with a fresh profile folder from `fs.mkdtempSync` in the temp directory: `chrome.exe --user-data-dir=<that folder> --headless=new --remote-debugging-port=0 --no-first-run --no-default-browser-check --disable-extensions --window-size=800,900 about:blank`, keeping Chrome's own PID.
3. It reads `DevToolsActivePort` from the profile folder, opens a WebSocket to the browser endpoint (Node's built-in `WebSocket`), makes a target with `Target.createTarget`, attaches with `Target.attachToTarget` (`flatten: true`), and sets the motion mode with `Emulation.setEmulatedMedia` and `features: [{ name: "prefers-reduced-motion", value: "no-preference" or "reduce" }]` before `Page.navigate` to `http://127.0.0.1:8098/tests/browser/index.html`.
4. It polls with `Runtime.evaluate` (once a second, up to 8 minutes) until `#rerun` is enabled and `#summary` is not "Running…", then reads `#summary` and `#report` (the PASS/FAIL lines) and `matchMedia("(prefers-reduced-motion: reduce)").matches` to confirm the mode took effect.
5. It sends `Browser.close`, then kills only its own Chrome by that PID and deletes its profile folder. The fresh profile gives an empty origin, so no database from an earlier run exists; the suite itself uses only throwaway database names.
6. Run it in both modes (`no-preference`, `reduce`), at least twice each for a change that touches motion. Afterwards stop the server by its PID. Never `taskkill /IM chrome.exe` or any kill by image name.

## Gotchas
- Update on the phone by fully closing and reopening the Home Screen app, possibly twice.
- Exports and backups never go in the repo.
