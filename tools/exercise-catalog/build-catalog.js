// Builds the exercise catalog from a pinned local copy of free-exercise-db's dist/exercises.json.
//
//   node tools/exercise-catalog/build-catalog.js --input <exercises.json> --out <folder> [--strict] [--pin <file>]
//
// It makes no network call: the input is a file someone fetched earlier, and it must match
// input-pin.json byte for byte (its SHA-256), so it can never run on anything else. Every output goes
// to --out, which must be OUTSIDE the repository. See README.md.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadVocabulary, missingFromModel } from "./lib/vocabulary.js";
import { curate, entriesWithoutPrimary, stringify } from "./lib/curate.js";
import { renderReviewBatches, renderAudit, summarize, renderSummary } from "./lib/review.js";
import { candidatePairs, renderSeedPairs } from "./lib/seed-pairs.js";
import { SEED_EXERCISES } from "../../src/domain/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const args = { strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") args.strict = true;
    else if (arg === "--input" || arg === "--out" || arg === "--pin") {
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

export function run(argv) {
  const args = parseArgs(argv);
  if (insideRepo(args.out)) throw new Error(`--out must be outside the repository (got ${args.out})`);

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
  const overrides = readJson(path.join(here, "overrides.json"));
  const confirmedPairs = readJson(path.join(here, "confirmed-seed-pairs.json"));
  const result = curate({ upstream, overrides, vocabulary, seeds: SEED_EXERCISES, confirmedPairs });

  const summary = summarize({ upstreamCount: upstream.length, result, overrideCount: Object.keys(overrides).length, strict: args.strict });
  const files = [
    ["catalog.json", stringify({
      source: { repo: pin.repo, file: pin.file, commit: pin.commit, sha256: pin.sha256 },
      modelNeeds: missingFromModel(),
      exercises: result.entries,
    })],
    ["summary.json", stringify(summary)],
    ["summary.txt", renderSummary(summary)],
    ["seed-pairs.md", renderSeedPairs(candidatePairs(SEED_EXERCISES, result.entries))],
    ["audit-sample.md", renderAudit(result.audit)],
    ["key-clashes.json", stringify({ keyClashes: result.keyClashes, nameClashes: result.nameClashes })],
    ...renderReviewBatches(result.review).map((b) => [b.name, b.text]),
  ];
  fs.mkdirSync(args.out, { recursive: true });
  for (const old of fs.readdirSync(args.out)) {
    if (/^review-\d+\.md$/.test(old)) fs.rmSync(path.join(args.out, old)); // a shorter list must not leave old batches behind
  }
  for (const [name, text] of files) fs.writeFileSync(path.join(args.out, name), text);

  const noPrimary = entriesWithoutPrimary(result.entries);
  if (args.strict && noPrimary.length > 0) {
    throw new Error(`--strict: ${noPrimary.length} entries have no primary muscle (see the review list); place them in overrides.json first`);
  }
  return { summary, out: args.out };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { summary, out } = run(process.argv.slice(2));
    process.stdout.write(`${renderSummary(summary)}\nWrote the outputs to ${out}\n`);
  } catch (error) {
    process.stderr.write(`build-catalog failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
