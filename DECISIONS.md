# Decisions

| Date | Decision | Reason |
|------|----------|--------|
| 2026-10-22 | Web app only for now, plain HTML/CSS/JavaScript, no frameworks. | Owner is a beginner and wants the simplest path to a working app; iOS native deferred. |
| 2026-10-22 | All data stored on-device in IndexedDB. No server, no accounts, no analytics. | Privacy-first product goal. |
| 2026-10-22 | Browser storage is not the sole copy of user data; export/import is required in v1. | persist() returned false in iPhone Safari and Firefox Focus during a one-off test, so data can be evicted. |
| 2026-10-22 | Primary test browsers: iPhone Safari and Firefox Focus. | Owner uses Firefox Focus daily; Safari is the iPhone default and uses the same WebKit engine as every iOS browser, so it is the baseline. |
| 2026-10-22 | Weights stored as entered (value plus unit), converted only for display and calculation. | Converting kg to lb and back with floating-point math drifts, and rounding on save would permanently change what the user typed. |
| 2026-10-22 | ES modules need HTTP(S) serving, not file://. | Browsers block module loading from local files. |
| 2026-10-22 | crypto.randomUUID() needs a secure context and must be verified on iPhone Safari and Firefox Focus. | It is unavailable on plain HTTP pages. |
| 2026-10-22 | Storage is split into rules (src/storage/store.js) and adapters (memory, IndexedDB) behind a small interface. | The rules can be tested in Node with no dependencies; only the thin IndexedDB adapter needs a browser to test. |
| 2026-10-22 | Saving a workout with its entries and sets, and deleting a workout, are each a single transaction. | All of it saves or none of it does, so a crash or error cannot leave orphaned entries or sets. |
| 2026-10-22 | No fake-IndexedDB library; the IndexedDB adapter is tested in a real browser page (tests/browser/index.html). | Keeps the dependency list empty, and a fake would not prove the real browsers behave. |
| 2026-10-22 | Saves check that referenced records exist (entry needs workout and exercise, set needs entry), inside the same transaction as the write. | Prevents dangling references; checking and writing in one transaction avoids a race between them. |
| 2026-10-22 | saveWorkoutWithDetails treats the lists as the workout's complete contents and deletes its stored entries and sets that are not in them. | Otherwise editing a workout and removing an exercise would leave the removed entry behind. |
| 2026-10-22 | Import is replace-everything and needs explicit confirmation (confirmReplace: true). No merge. | Merge semantics (duplicates, conflicts, deletions) are harder to reason about, and restoring a backup should be predictable. |
| 2026-10-22 | Import validates the whole file before any write, then applies it in one transaction. | A bad or damaged file cannot corrupt or half-replace existing data. |
| 2026-10-22 | Export has a plain-text form (exportToText) as a fallback for iOS download problems. Unverified on WebKit. | File downloads can misbehave on iOS; the text can be copied and saved by hand. Download and file picker still need testing on iPhone Safari and Firefox Focus. |
| 2026-10-22 | Import is strict: every field must be present, unknown fields are rejected, and each stored record must equal its file record exactly (non-canonical timestamps are rejected, nothing is defaulted). | An import must never invent or silently change values; a hand-edited or foreign file fails loudly instead. |
| 2026-10-22 | Import size limit is 50 MiB, counted in UTF-8 bytes, and is a parameter. | A 20-year heavy history is about 35-40 MB; the limit stops a wrong huge file from freezing the tab. Memory use on iPhone is unmeasured. |
