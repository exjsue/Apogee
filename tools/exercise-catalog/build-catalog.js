// Builds the exercise catalog from a pinned local copy of free-exercise-db's dist/exercises.json.
//
//   node tools/exercise-catalog/build-catalog.js --input <exercises.json> --out <folder> [--strict] [--emit src/catalog]
//       [--pin <file>] [--overrides <file>] [--additions <file>] [--pairs <file>] [--retired <file>]
// (--pin, --overrides, --additions, --pairs and --retired exist for the tests, which run on a fixture.)
//
// It makes no network call: the input is a file someone fetched earlier, and it must match
// input-pin.json byte for byte (its SHA-256), so it can never run on anything else. Every output goes
// to --out, which must be OUTSIDE the repository, with one exception: --emit writes the generated
// catalog module, and only into src/catalog/ (any other folder is refused). See README.md.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadVocabulary, missingFromModel } from "./lib/vocabulary.js";
import { curate, entriesWithoutPrimary, stringify } from "./lib/curate.js";
import { renderReviewBatches, renderAudit, renderExcluded, renderFamilies, renderOutliers, summarize, renderSummary } from "./lib/review.js";
import { candidatePairs, renderSeedPairs } from "./lib/seed-pairs.js";
import { buildAdditions, formatProblems, formatWarnings } from "./lib/additions.js";
import { buildEmission, readPreviousCatalog } from "./lib/emit.js";
import { SEED_EXERCISES } from "../../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const args = { strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") args.strict = true;
    else if (arg === "--input" || arg === "--out" || arg === "--pin" || arg === "--overrides" || arg === "--additions" || arg === "--pairs" || arg === "--emit" || arg === "--retired") {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.input) throw new Error("--input <exercises.json> is required");
  if (!args.out) throw new Error("--out <folder> is required");
  return args;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function insideRepo(folder) {
  const relative = path.relative(repoRoot, path.resolve(folder));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// options (for the tests only; the command line cannot set them):
//   emitFolder  the one folder --emit may write; the default is src/catalog in this repository
//   emitSeeds   the seed records every one of which must be grouped; the default is the app's seeds
export function run(argv, { emitFolder = path.join(repoRoot, "src", "catalog"), emitSeeds = SEED_EXERCISES } = {}) {
  const args = parseArgs(argv);
  if (insideRepo(args.out)) throw new Error(`--out must be outside the repository (got ${args.out})`);
  if (args.emit !== undefined && path.resolve(args.emit) !== path.resolve(emitFolder)) {
    throw new Error(`--emit writes only into src/catalog/ and refuses any other folder (got ${args.emit})`);
  }

  const pin = readJson(args.pin ?? path.join(here, "input-pin.json"));
  const bytes = fs.readFileSync(args.input);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pin.bytes || sha256 !== pin.sha256) {
    throw new Error(
      `the input does not match the pinned file (commit ${pin.commit}): expected ${pin.bytes} bytes with SHA-256 ${pin.sha256}, got ${bytes.length} bytes with SHA-256 ${sha256}`,
    );
  }
  const upstream = JSON.parse(bytes.toString("utf8"));
  if (upstream.length !== pin.entries) throw new Error(`the pinned file should have ${pin.entries} entries, found ${upstream.length}`);

  const vocabulary = loadVocabulary();
  const overrides = readJson(args.overrides ?? path.join(here, "overrides.json"));
  const confirmedPairs = readJson(args.pairs ?? path.join(here, "confirmed-seed-pairs.json"));
  const result = curate({ upstream, overrides, vocabulary, seeds: SEED_EXERCISES, confirmedPairs });

  // The hand-written exercises are checked on their own and appended after curation. A problem stops the
  // build before anything else is written, and is printed and saved in plain words.
  const additionsText = fs.readFileSync(args.additions ?? path.join(here, "additions.txt"), "utf8");
  const added = buildAdditions({ text: additionsText, upstream, curated: result.entries, seeds: SEED_EXERCISES, vocabulary });
  fs.mkdirSync(args.out, { recursive: true });
  const problemsFile = path.join(args.out, "additions-problems.txt");
  if (added.problems.length > 0) {
    const report = formatProblems(added.problems);
    fs.writeFileSync(problemsFile, report);
    throw new Error(`\n${report}\n(The same text is in ${problemsFile})`);
  }
  fs.rmSync(problemsFile, { force: true }); // a fixed file must not leave an old report behind
  const warningsFile = path.join(args.out, "additions-warnings.txt");
  fs.rmSync(warningsFile, { force: true });
  if (added.warnings.length > 0) {
    const report = formatWarnings(added.warnings);
    fs.writeFileSync(warningsFile, report);
    process.stderr.write(`${report}\n`);
  }
  const everyEntry = [...result.entries, ...added.entries];

  // The generated module is worked out now, so a problem (a missing primary muscle, a value outside the lists, an
  // id that vanished) stops the build before anything is written; the files are written at the very end.
  let emission = null;
  if (args.emit !== undefined) {
    const previousFile = path.join(emitFolder, "catalog.js");
    emission = buildEmission({
      entries: everyEntry,
      pairedEntries: result.pairedEntries,
      pairs: confirmedPairs,
      manual: readJson(path.join(here, "seed-grouping-manual.json")),
      seeds: emitSeeds,
      vocabulary,
      pin,
      previous: fs.existsSync(previousFile) ? readPreviousCatalog(fs.readFileSync(previousFile, "utf8")) : null,
      retired: readJson(args.retired ?? path.join(here, "retired.json")),
    });
  }

  const summary = summarize({ upstreamCount: upstream.length, result, overrideCount: Object.keys(overrides).length, strict: args.strict, additionsCount: added.entries.length });
  const files = [
    ["catalog.json", stringify({
      source: { repo: pin.repo, file: pin.file, commit: pin.commit, sha256: pin.sha256 },
      notice: "Entries with origin \"upstream\" are derived from the source above, which is released under the Unlicense. Entries with origin \"authored\" were written by hand for Apogee and are not covered by that statement.",
      modelNeeds: missingFromModel(),
      exercises: everyEntry,
    })],
    ["summary.json", stringify(summary)],
    ["summary.txt", renderSummary(summary)],
    ["seed-pairs.md", renderSeedPairs(candidatePairs(SEED_EXERCISES, result.entries))],
    ["audit-sample.md", renderAudit(result.audit)],
    ["excluded.md", renderExcluded(result.excludedDetails)],
    ["families.md", renderFamilies(everyEntry)],
    ["outliers.md", renderOutliers(everyEntry, vocabulary.baseMovements)],
    ["key-clashes.json", stringify({ keyClashes: result.keyClashes, nameClashes: result.nameClashes })],
    ...renderReviewBatches(result.review).map((b) => [b.name, b.text]),
  ];
  for (const old of fs.readdirSync(args.out)) {
    if (/^review-\d+\.md$/.test(old)) fs.rmSync(path.join(args.out, old)); // a shorter list must not leave old batches behind
  }
  for (const [name, text] of files) fs.writeFileSync(path.join(args.out, name), text);

  const noPrimary = entriesWithoutPrimary(everyEntry);
  if (args.strict && noPrimary.length > 0) {
    throw new Error(`--strict: ${noPrimary.length} entries have no primary muscle (see the review list); place them in overrides.json first`);
  }
  if (emission !== null) {
    fs.mkdirSync(emitFolder, { recursive: true });
    for (const { name, text } of emission.files) fs.writeFileSync(path.join(emitFolder, name), text);
  }
  return { summary, out: args.out, emitted: emission === null ? null : emission.summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { summary, out, emitted } = run(process.argv.slice(2));
    process.stdout.write(`${renderSummary(summary)}\nWrote the outputs to ${out}\n`);
    if (emitted !== null) process.stdout.write(`Wrote src/catalog/: ${emitted.entries} catalog entries, ${emitted.seedGrouping} seed groupings${emitted.retiredKept.length > 0 ? `, ${emitted.retiredKept.length} kept as retired` : ""}\n`);
  } catch (error) {
    process.stderr.write(`build-catalog failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
