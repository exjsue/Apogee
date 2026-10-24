# Exercise catalog pipeline

Turns a pinned copy of free-exercise-db (yuhonas/free-exercise-db, `dist/exercises.json`) into curated
builtin exercise records: rules plus a manual override file, reviewed as a diff. It does not touch the
app: nothing here is loaded by `index.html`, so the service worker never caches it, and the app does not
read its output yet.

## Run

1. Fetch the input once, to a folder OUTSIDE the repository, at the commit named in `input-pin.json`
   (`https://raw.githubusercontent.com/yuhonas/free-exercise-db/<commit>/dist/exercises.json`). The tool
   itself makes no network call.
2. `node tools/exercise-catalog/build-catalog.js --input <that file> --out <a folder outside the repo>`
   - Refuses any input whose size or SHA-256 differs from `input-pin.json`, and any `--out` inside the repo.
   - `--strict` also fails while any entry has no primary muscle (shoulders the rules could not place).
   - `--pin <file>` uses another pin file; only the tests do that, with a fixture.

## Outputs (all in `--out`)

- `catalog.json`: the curated list (no instructions, no images), with the source commit and `modelNeeds`.
- `review-01.md` ...: entries sorted most uncertain first, about 50 per file, each with the reason it is there.
- `audit-sample.md`: a fixed one in ten of the entries a name, category, shoulder or oblique rule decided
  without flagging them. Read it against the upstream values.
- `summary.txt` / `summary.json`: counts. `key-clashes.json`. `seed-pairs.md`: candidates, applied only
  when confirmed in `confirmed-seed-pairs.json` (seed id -> upstream id).

## Files you edit

- `overrides.json`: keyed by upstream id; every override needs a `note`. Allowed keys: `name`,
  `baseMovementId`, `equipment`, `equipmentTags`, `variations`, `primaryMuscles`, `secondaryMuscles`,
  `exclude`. An unknown id, key or out-of-vocabulary value stops the build.
- `vocab.json`: the controlled base movements and variation tags.
- `confirmed-seed-pairs.json`: the seed pairs a person has approved.

## What the app's model.js still needs (not changed here)

Muscles `neck`, `abductors`; equipment `trap_bar`, `medicine_ball`, `exercise_ball`, `foam_roll`, `other`.
`createExercise` also drops `baseMovementId`, `equipment`, `variations` and `upstreamId`.
