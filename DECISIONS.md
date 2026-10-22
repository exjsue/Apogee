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
