// The generated catalog modules for the app (src/catalog/). The pipeline writes this folder and no other path
// inside the repo. The app imports catalog.js (the library service, src/app/catalog.js), catalog-info.js,
// seed-grouping.js (src/domain/seed.js) and secondary-weights.js (src/app/logger.js, at view time). Everything here is a pure function of its input: sorted by
// id, sorted keys, LF line endings, no timestamps, so a second run gives the same bytes.
//
// Ids are permanent. When a previous catalog.js exists, an id that was in it must still be in the new output;
// one that is not (dropped, excluded or newly paired with a seed) stops the emit unless retired.json lists it,
// and then it is kept, with its previous record, marked retired.

import { checkWeightRules, secondaryWeightsFor } from "./rules-weights.js";

export const CATALOG_VERSION = 1;

export const ORIGINS = Object.freeze(["upstream", "authored"]);

// The licence text of free-exercise-db as read at the pinned commit, without its last line. That line only
// gives the licence's web address, and nothing shipped under src/ may contain one (tests/guard.test.js).
const UNLICENSE = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.`;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedUnique = (values) => [...new Set(values)].sort();
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// One line of JSON with the keys in sorted order (arrays keep their order, which is already sorted by the pipeline).
function line(record) {
  return JSON.stringify(Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])));
}

// What the app will carry for one entry; nothing else leaves the pipeline.
function recordOf(entry, catalogVersion) {
  return {
    id: entry.id,
    name: entry.name,
    primaryMuscles: entry.primaryMuscles,
    secondaryMuscles: entry.secondaryMuscles,
    equipmentTags: entry.equipmentTags,
    equipment: entry.equipment,
    baseMovementId: entry.baseMovementId,
    variations: entry.variations,
    origin: entry.origin,
    catalogVersion,
    retired: entry.retired === true,
  };
}

// The records of an earlier catalog.js, read back from its text. Throws if the text is not what this tool writes.
export function readPreviousCatalog(text) {
  const start = text.indexOf("export const CATALOG = [");
  const end = text.lastIndexOf("\n];");
  if (start === -1 || end === -1 || end < start) throw new Error("the previous catalog.js is not in the form this tool writes; it was not read, and nothing was changed");
  const records = JSON.parse(text.slice(text.indexOf("[", start), end + 2));
  if (!Array.isArray(records) || records.some((r) => !isObject(r) || typeof r.id !== "string")) {
    throw new Error("the previous catalog.js has an entry without an id; it was not read, and nothing was changed");
  }
  return records;
}

function check(problems, entries, vocabulary) {
  const seen = new Set();
  for (const e of entries) {
    const where = `${e.id} ("${e.name}")`;
    if (seen.has(e.id)) problems.push(`${where}: the id appears twice`);
    seen.add(e.id);
    if (e.primaryMuscles.length === 0) problems.push(`${where}: no primary muscle`);
    for (const m of [...e.primaryMuscles, ...e.secondaryMuscles]) if (!vocabulary.muscles.includes(m)) problems.push(`${where}: muscle "${m}" is not in the muscle list`);
    for (const t of [e.equipment, ...e.equipmentTags]) if (!vocabulary.equipment.includes(t)) problems.push(`${where}: equipment "${t}" is not in the equipment list`);
    if (e.baseMovementId !== null && !vocabulary.baseMovements.includes(e.baseMovementId)) problems.push(`${where}: base movement "${e.baseMovementId}" is not in vocab.json`);
    for (const v of e.variations) if (!vocabulary.variations.includes(v)) problems.push(`${where}: variation "${v}" is not in vocab.json`);
    if (!ORIGINS.includes(e.origin)) problems.push(`${where}: origin "${e.origin}" is not one of ${ORIGINS.join(", ")}`);
  }
}

// entries: every catalog entry (upstream and hand-written). pairedEntries: the upstream entries left out because a seed owns them.
// pairs: seed id -> upstream id. manual: seed id -> { baseMovementId, equipment, variations, note } for seeds with no upstream pair.
// seeds: the seed records that must each be covered once. previous: records of the earlier catalog.js, or null. retired: id -> reason.
export function buildEmission({ entries, pairedEntries, pairs, manual, seeds, vocabulary, pin, previous = null, retired = {}, catalogVersion = CATALOG_VERSION }) {
  const problems = [];
  check(problems, entries, vocabulary);

  // ---- ids never disappear ----
  const records = entries.map((e) => recordOf(e, catalogVersion));
  const keptRetired = [];
  if (previous !== null) {
    const now = new Set(records.map((r) => r.id));
    const before = new Map(previous.map((r) => [r.id, r]));
    const missing = [];
    for (const [id, record] of before) {
      if (now.has(id)) continue;
      if (Object.prototype.hasOwnProperty.call(retired, id)) {
        records.push({ ...record, retired: true });
        keptRetired.push(id);
      } else {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      problems.push(
        `${missing.length} id(s) in the previous catalog.js are not in the new output (dropped, left out by an override, or paired with a seed): ${missing.sort().join(", ")}. `
        + "Ids are permanent. If one is meant to go, list it in tools/exercise-catalog/retired.json with a reason; it is then kept and marked retired.",
      );
    }
  }
  const known = new Set([...records.map((r) => r.id), ...(previous ?? []).map((r) => r.id)]);
  for (const [id, reason] of Object.entries(retired)) {
    if (typeof reason !== "string" || reason.trim() === "") problems.push(`retired.json: "${id}" needs a reason`);
    if (!known.has(id)) problems.push(`retired.json: "${id}" is not an id in the previous or the new catalog`);
  }
  records.sort(byId);

  // ---- grouping fields for the seeds ----
  const grouping = [];
  const seedIds = new Set(seeds.map((s) => s.id));
  const paired = new Map(pairedEntries.map((e) => [e.id, e]));
  for (const [seedId, upstreamId] of Object.entries(pairs)) {
    const entry = paired.get(upstreamId);
    if (entry === undefined) { problems.push(`seed grouping: ${seedId} is paired with "${upstreamId}", which is not a left-out upstream entry`); continue; }
    if (entry.baseMovementId === null) problems.push(`seed grouping: ${seedId} is paired with "${upstreamId}", which has no base movement`);
    grouping.push({ seedId, upstreamId, baseMovementId: entry.baseMovementId, equipment: entry.equipment, variations: entry.variations });
  }
  for (const [seedId, value] of Object.entries(manual)) {
    if (!seedIds.has(seedId)) { problems.push(`seed grouping: "${seedId}" in seed-grouping-manual.json is not a seed record`); continue; }
    if (Object.prototype.hasOwnProperty.call(pairs, seedId)) { problems.push(`seed grouping: ${seedId} is both paired and set by hand`); continue; }
    const where = `seed grouping: ${seedId}`;
    if (!vocabulary.baseMovements.includes(value.baseMovementId)) problems.push(`${where}: base movement "${value.baseMovementId}" is not in vocab.json`);
    if (!vocabulary.equipment.includes(value.equipment)) problems.push(`${where}: equipment "${value.equipment}" is not in the equipment list`);
    for (const v of value.variations) if (!vocabulary.variations.includes(v)) problems.push(`${where}: variation "${v}" is not in vocab.json`);
    grouping.push({ seedId, upstreamId: null, baseMovementId: value.baseMovementId, equipment: value.equipment, variations: sortedUnique(value.variations) });
  }
  const covered = new Set(grouping.map((g) => g.seedId));
  for (const id of seedIds) if (!covered.has(id)) problems.push(`seed grouping: ${id} is neither paired nor set by hand`);
  grouping.sort((a, b) => (a.seedId < b.seedId ? -1 : a.seedId > b.seedId ? 1 : 0));

  // ---- secondary-muscle weights, for catalog entries and seeds ----
  problems.push(...checkWeightRules([...records, ...seeds]));
  const weighted = [...records, ...seeds].filter((e) => e.secondaryMuscles.length > 0).sort(byId);

  if (problems.length > 0) {
    throw new Error(`the catalog module was not written; ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }

  // ---- the files ----
  const muscleIds = sortedUnique(records.flatMap((r) => [...r.primaryMuscles, ...r.secondaryMuscles]));
  const equipmentIds = sortedUnique(records.flatMap((r) => [r.equipment, ...r.equipmentTags]));
  const header = [
    "// GENERATED by tools/exercise-catalog/build-catalog.js --emit. Do not edit by hand.",
    "// Changing this file by hand is undone by the next run, and a test compares it with a fresh run.",
    `// Catalog version ${catalogVersion}. Entries: ${records.length}.`,
    `// Derived from the free-exercise-db project (${pin.repo}), file ${pin.file}, commit ${pin.commit},`,
    "// released under the Unlicense, plus entries written for Apogee (origin authored). See NOTICE.md.",
    "// Only the fields the app stores are here; no instructions, no images.",
  ];
  const catalogJs = [
    ...header,
    "",
    `export const CATALOG_VERSION = ${catalogVersion};`,
    `export const MUSCLE_IDS = ${JSON.stringify(muscleIds)};`,
    `export const EQUIPMENT_IDS = ${JSON.stringify(equipmentIds)};`,
    "",
    "export const CATALOG = [",
    records.map((r) => `  ${line(r)}`).join(",\n"),
    "];",
    "",
  ].join("\n");

  const groupingJs = [
    "// GENERATED by tools/exercise-catalog/build-catalog.js --emit. Do not edit by hand.",
    `// Catalog version ${catalogVersion}. How each built-in seed exercise is grouped: its base movement, equipment and variations.`,
    "// A seed keeps its own name and muscles; only these grouping fields are added. upstreamId is the catalog entry the seed",
    "// stands for (that entry is left out of catalog.js), or null for a seed set by hand.",
    "",
    "export const SEED_GROUPING = [",
    grouping.map((g) => `  ${line(g)}`).join(",\n"),
    "];",
    "",
  ].join("\n");

  const infoJs = [
    "// GENERATED by tools/exercise-catalog/build-catalog.js --emit. Do not edit by hand.",
    "// What the app needs to know about the catalog without loading it: its version and how many entries it has.",
    "// CATALOG_COUNT includes entries marked retired, because they stay stored.",
    "",
    `export const CATALOG_VERSION = ${catalogVersion};`,
    `export const CATALOG_COUNT = ${records.length};`,
    "",
  ].join("\n");

  const weightsJs = [
    "// GENERATED by tools/exercise-catalog/build-catalog.js --emit. Do not edit by hand.",
    `// Catalog version ${catalogVersion}. How much of a working set each secondary muscle of a default exercise (catalog entry or`,
    "// seed) is credited with: 0.25, 0.5, 0.75 or 1. Estimates, set by tools/exercise-catalog/lib/rules-weights.js. Read by id at",
    "// view time, so the stored copies of these exercises are never rewritten. Exercises with no secondary muscle are left out.",
    "",
    "export const SECONDARY_WEIGHTS = {",
    weighted.map((e) => `  ${JSON.stringify(e.id)}: ${line(secondaryWeightsFor(e))}`).join(",\n"),
    "};",
    "",
  ].join("\n");

  const notice = [
    "# Notice for the exercise catalog",
    "",
    "`catalog.js` lists exercises. Entries with origin upstream are derived from the exercise data of the free-exercise-db",
    `project (${pin.repo}), file ${pin.file} at commit ${pin.commit}: names, muscles and equipment tags only; the`,
    "instructions and images are not included. That project says it derives from wrkout/exercises.json, also under the",
    "Unlicense. Where the names, tags and text originally came from was not independently verified.",
    "",
    "The Unlicense statement below covers only the entries with origin upstream. Entries with origin authored were",
    "written by hand for Apogee and are not covered by it.",
    "",
    "The licence text of free-exercise-db, as read at that commit (its last line, which only gives the licence's web address,",
    "is left out because nothing shipped in src/ may contain a web address):",
    "",
    "---",
    "",
    UNLICENSE,
    "",
    "---",
    "",
  ].join("\n");

  return {
    files: [
      { name: "catalog.js", text: catalogJs },
      { name: "seed-grouping.js", text: groupingJs },
      { name: "catalog-info.js", text: infoJs },
      { name: "NOTICE.md", text: notice },
      { name: "secondary-weights.js", text: weightsJs },
    ],
    summary: { entries: records.length, seedGrouping: grouping.length, retiredKept: keptRetired.sort() },
  };
}
