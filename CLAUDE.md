# Project: GymApp (privacy-first workout tracker, web app)

## Status
Pre-build. No app code exists yet. First milestone: a blank page that loads in a browser with no network calls.

## Privacy rules (non-negotiable unless the owner changes them)
- All user data stays on the user's device. Store it in the browser (IndexedDB or localStorage), never on a server.
- No analytics, tracking, crash-reporting, or advertising SDKs. No third-party scripts, fonts, or CDN assets that send data to another host.
- No account system. No sync in v1 unless end-to-end encrypted and the owner approves the design.
- Age is stored only as an age bracket, never a birthdate. Height and weight are optional, stored locally, and never transmitted.
- Strength ranking is optional, computed on-device, and never compared with other users.
- Any AI feature is opt-in per request, sends the minimum necessary text, and shows the user exactly what will be sent first. Do not build it until the owner says so.
- Flag any dependency or library that makes a network call. Ask before adding one.

## Technical direction
- Plain HTML, CSS, and JavaScript for now. No framework unless the owner approves.
- Keep the data layer (domain model, storage, importers, search) separate from the UI, so it can be reused later.
- Importers are isolated modules, each with sample-file tests.

## How we work
- Before writing code, state the plan and the main risk. Wait for approval on anything that changes privacy rules or architecture.
- Build in small verifiable steps: data model, logging, exercise library, import, search, UI polish.
- Commit to git after each working step.
- Keep DECISIONS.md (dated decisions with reasons) and TODO.md (deferred items, including Android and the AI feature) up to date.
- When a bug is reported, ask for the exact error or reproduction steps before proposing a fix.

## Commands
- Run: (to be added when the app exists)
- Test: (to be added when tests exist)
