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

## Hand-written additions (additions.txt)

Default exercises you add yourself live in tools/exercise-catalog/additions.txt, one block per exercise, with every
field explained in the file. They are checked on their own, then appended after the upstream entries have been
curated: they never pass through the upstream rules or overrides.json, and an upstream update cannot touch them.

- Ids start with apogee- and are permanent: write one once, by hand, and never change or reuse it. To stop
  offering an exercise, write retired: yes; never delete a block.
- The build stops, before writing anything else, and lists every problem together in plain words (block, line,
  what is allowed, the exact line to paste). The same text is saved as additions-problems.txt in the output folder.
  It stops on: a duplicate id; an id that is not apogee- plus lower-case letters, digits and hyphens; an upstream id
  starting with apogee-; a missing id, name, base, equipment or primary; a value outside the controlled lists (with the
  closest match); a base movement not in vocab.json (add it there first); a secondary muscle that repeats a primary;
  the same base, equipment and variations as an existing entry; and a name very close to an existing one.
- A missing id is never invented: the message shows the id to paste.
- Names are compared with the upstream names, the seed names and earlier additions. When one is close (word overlap
  of 0.60, or a shorter name of two or more words fully inside a longer one; both are in NAME_SIMILARITY in
  lib/additions.js) the build asks Did you mean ...? and continues only if the block lists those ids in similar-ok.
- Derived for you: equipmentTags, sorted lists, source builtin, origin authored. Upstream entries get origin upstream.
  An empty unplacedMuscles list is left out, as it is for upstream entries.

## Licensing

The Unlicense statement of the upstream project covers only the entries with origin "upstream". Entries with origin
"authored" were written by hand for Apogee and are not covered by it. catalog.json says so in its notice field; the
data notice file planned for the day the catalog is vendored (see TODO.md) must say the same.

## Base-movement families

`lib/rules-movement.js` decides the squat, deadlift and bench families first; what it leaves null goes to
`lib/rules-families.js` (57 more families, and bench-press, jerk and deadlift widened). The first family whose rule
matches wins, so specific families come before general ones. A name rule never fires inside another word ("chin" in
machine, "row" in narrow, "sled" in sledgehammer). An entry two or more families match goes on the review list, with
the other families in the column "Other families that also matched". An entry no family fits stays null; so do
strongman events and the names in `STAYS_NULL` (owner decisions). Variation tags that tell family entries apart
(`lying`, `standing`, `target-<muscle>` for stretch and foam-roll, the cardio kind for cardio) are added to family
entries only. `vocab.json` lists `keyClashWarningFamilies`: for those families a shared key is not a reason to review,
and in additions.txt it is a warning (additions-warnings.txt) and not an error.

## The generated module for the app (src/catalog/)

`--emit src/catalog` writes the one folder inside the repo that the pipeline may write (every other output goes to
`--out`, outside the repo; any other `--emit` folder is refused). It writes three files:

- `catalog.js`: `CATALOG_VERSION`, `MUSCLE_IDS`, `EQUIPMENT_IDS` and `CATALOG`, one line per entry with only the fields
  the app will store (id, name, muscles, equipment tags, equipment, base movement, variations, origin, catalogVersion,
  retired). Sorted by id, sorted keys, LF, no timestamps.
- `seed-grouping.js`: `SEED_GROUPING`, the grouping fields (base movement, equipment, variations) of each of the 16 seeds:
  from the paired upstream entry (which is left out of `CATALOG`), or set by hand in `seed-grouping-manual.json`.
- `NOTICE.md`: the Unlicense text, the upstream commit, and what the statement covers.

The files are committed on purpose. The app does not import them yet. Regenerate with the pinned input and commit the
result; a test (needs `EXERCISE_CATALOG_INPUT`) fails if the committed files differ from a fresh run.

Ids are permanent. If `src/catalog/catalog.js` already exists, an id that was in it and is not in the new output
(dropped, left out by an override, or newly paired with a seed) stops the emit. List it in `retired.json` (id -> reason)
to keep it, with its previous record, marked `retired: true`. The emit also stops if an entry has no primary muscle or a
value is outside the lists.
