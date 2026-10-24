// The curation itself: upstream entries + overrides -> catalog entries + the facts a reviewer needs.
// A pure function: no file, no clock, no network. The same input gives the same output.

import crypto from "node:crypto";
import { classifyEquipment, equipmentTagsFor } from "./rules-equipment.js";
import { mapMuscles } from "./rules-muscles.js";
import { classifyBase, variationsFor } from "./rules-movement.js";

const OVERRIDE_KEYS = ["name", "baseMovementId", "equipment", "equipmentTags", "variations", "primaryMuscles", "secondaryMuscles", "exclude", "note"];

// How much a reason moves an entry up the review list (most uncertain first).
export const REASON_WEIGHTS = Object.freeze({
  "empty-primary": 5,
  "undecided-shoulder-head": 3,
  "equipment-uncertain": 3,
  "key-clash": 3,
  "duplicate-suspect": 3,
  "multiple-families": 2,
  "null-base-movement": 1,
});

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const uniqueSorted = (list) => [...new Set(list)].sort();

function fail(message) {
  throw new Error(message);
}

function validateUpstream(upstream) {
  if (!Array.isArray(upstream)) fail("the upstream input must be a list of exercises");
  const seen = new Set();
  for (const entry of upstream) {
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id === "") fail("an upstream entry has no id");
    if (seen.has(entry.id)) fail(`two entries have the same upstream id: ${entry.id}`);
    seen.add(entry.id);
    if (typeof entry.name !== "string" || entry.name.trim() === "") fail(`${entry.id}: no name`);
    if (!Array.isArray(entry.primaryMuscles) || !Array.isArray(entry.secondaryMuscles)) fail(`${entry.id}: muscles must be lists`);
  }
  return seen;
}

function inList(value, allowed) {
  return allowed.includes(value);
}

function validateOverrides(overrides, ids, vocabulary) {
  if (!isObject(overrides)) fail("the overrides file must be an object keyed by upstream id");
  for (const [id, override] of Object.entries(overrides)) {
    if (!ids.has(id)) fail(`override "${id}" does not match any upstream id`);
    if (!isObject(override)) fail(`override "${id}" must be an object`);
    for (const key of Object.keys(override)) if (!OVERRIDE_KEYS.includes(key)) fail(`override "${id}" has an unknown key "${key}"`);
    if (typeof override.note !== "string" || override.note.trim() === "") fail(`override "${id}" needs a note saying why`);
    const listOf = (key, allowed, what) => {
      if (override[key] === undefined) return;
      if (!Array.isArray(override[key])) fail(`override "${id}": ${key} must be a list`);
      for (const value of override[key]) if (!inList(value, allowed)) fail(`override "${id}": "${value}" is not a known ${what}`);
      if (new Set(override[key]).size !== override[key].length) fail(`override "${id}": ${key} has a duplicate`);
    };
    listOf("primaryMuscles", vocabulary.muscles, "muscle");
    listOf("secondaryMuscles", vocabulary.muscles, "muscle");
    listOf("variations", vocabulary.variations, "variation");
    listOf("equipmentTags", vocabulary.equipment, "equipment tag");
    if (override.equipment !== undefined && !inList(override.equipment, vocabulary.equipment)) {
      fail(`override "${id}": "${override.equipment}" is not a known equipment`);
    }
    if (override.baseMovementId !== undefined && override.baseMovementId !== null && !inList(override.baseMovementId, vocabulary.baseMovements)) {
      fail(`override "${id}": "${override.baseMovementId}" is not a known base movement`);
    }
    if (override.name !== undefined && (typeof override.name !== "string" || override.name.trim() === "" || [...override.name].length > vocabulary.nameMaxLength)) {
      fail(`override "${id}": name must be 1 to ${vocabulary.nameMaxLength} characters`);
    }
    if (override.exclude !== undefined && typeof override.exclude !== "boolean") fail(`override "${id}": exclude must be true or false`);
  }
}

function validateConfirmedPairs(pairs, ids, seedIds) {
  if (!isObject(pairs)) fail("the confirmed seed pairs file must be an object of seed id -> upstream id");
  const usedUpstream = new Set();
  for (const [seedId, upstreamId] of Object.entries(pairs)) {
    if (!seedIds.has(seedId)) fail(`confirmed pair: "${seedId}" is not a seed record`);
    if (!ids.has(upstreamId)) fail(`confirmed pair: "${upstreamId}" does not match any upstream id`);
    if (usedUpstream.has(upstreamId)) fail(`confirmed pair: "${upstreamId}" is paired with two seeds`);
    usedUpstream.add(upstreamId);
  }
}

// A fixed one in ten of the entries a name, category, shoulder or oblique rule decided: the decisions that
// are not on the review list because the rule was confident. Chosen by a hash of the id, so it never changes.
function auditPick(id) {
  return crypto.createHash("sha256").update(id).digest()[0] % 10 === 0;
}

const normalizedName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");

function curateOne(entry, override, vocabulary) {
  const eq = classifyEquipment(entry);
  const primary = mapMuscles(entry, entry.primaryMuscles);
  const secondary = mapMuscles(entry, entry.secondaryMuscles);

  const decisions = [...primary.notes, ...secondary.notes];
  if (!/^(upstream|override)/.test(eq.by)) decisions.push(`equipment:${eq.by}`);
  const how = { equipment: eq.by, baseMovement: "none", muscles: "rule", variations: "rule" };
  let equipment = eq.equipment;
  let equipmentUncertain = eq.uncertain;
  let baseMovementId = null; // decided below, once the primary muscles are final
  let primaryMuscles = primary.placed;
  let secondaryMuscles = secondary.placed.filter((m) => !primary.placed.includes(m));
  const duplicatesRemoved = secondary.placed.length - secondaryMuscles.length;
  let unplaced = [
    ...Array.from({ length: primary.unplaced }, () => ({ upstream: "shoulders", role: "primary" })),
    ...Array.from({ length: secondary.unplaced }, () => ({ upstream: "shoulders", role: "secondary" })),
  ];
  let variations = null; // worked out after the base movement and equipment are final
  let name = entry.name;
  let equipmentTags = null;
  let exclude = false;

  if (override !== undefined) {
    if (override.name !== undefined) name = override.name;
    if (override.baseMovementId !== undefined) { baseMovementId = override.baseMovementId; how.baseMovement = "override"; }
    if (override.equipment !== undefined) { equipment = override.equipment; equipmentUncertain = false; how.equipment = "override"; }
    if (override.equipmentTags !== undefined) equipmentTags = uniqueSorted(override.equipmentTags);
    if (override.variations !== undefined) { variations = uniqueSorted(override.variations); how.variations = "override"; }
    if (override.primaryMuscles !== undefined) {
      primaryMuscles = uniqueSorted(override.primaryMuscles);
      unplaced = unplaced.filter((u) => u.role !== "primary");
      how.muscles = "override";
      // A muscle placed as primary by hand leaves the rule's secondary list (an explicit
      // secondaryMuscles override below is taken as written, and may not repeat a primary).
      if (override.secondaryMuscles === undefined) secondaryMuscles = secondaryMuscles.filter((m) => !primaryMuscles.includes(m));
    }
    if (override.secondaryMuscles !== undefined) {
      secondaryMuscles = uniqueSorted(override.secondaryMuscles);
      unplaced = unplaced.filter((u) => u.role !== "secondary");
      how.muscles = "override";
    }
    if (override.exclude === true) exclude = true;
    if (secondaryMuscles.some((m) => primaryMuscles.includes(m))) fail(`override "${entry.id}": a secondary muscle repeats a primary one`);
  }
  // The base movement comes from the rules unless an override set it. The family rules read the final
  // primary muscles, so an entry whose shoulder head was placed by hand is judged on that placement.
  let byFamily = false;
  let alternatives = [];
  if (override === undefined || override.baseMovementId === undefined) {
    const found = classifyBase({ name: entry.name, category: entry.category ?? null, primary: primaryMuscles });
    baseMovementId = found.id;
    byFamily = found.byFamily;
    alternatives = found.alternatives;
    how.baseMovement = found.id === null ? "none" : "rule";
  }
  if (variations === null) {
    variations = baseMovementId === null ? [] : variationsFor(entry.name, equipment, byFamily ? { id: baseMovementId, primary: primaryMuscles } : null);
  }
  if (equipmentTags === null) equipmentTags = equipmentTagsFor(equipment, baseMovementId);

  return {
    exclude,
    exclusionNote: exclude ? override.note : null,
    uncertainEquipment: equipmentUncertain,
    alternatives, // other families that also matched, when a family decided the base
    duplicatesRemoved,
    how,
    decisions,
    entry: {
      id: entry.id,
      name,
      baseMovementId,
      equipment,
      equipmentTags,
      variations,
      primaryMuscles,
      secondaryMuscles,
      ...(unplaced.length > 0 ? { unplacedMuscles: unplaced } : {}),
      category: entry.category ?? null,
      level: entry.level ?? null,
      mechanic: entry.mechanic ?? null,
      force: entry.force ?? null,
      source: "builtin",
      origin: "upstream",
    },
  };
}

export function curate({ upstream, overrides = {}, vocabulary, seeds = [], confirmedPairs = {} }) {
  const ids = validateUpstream(upstream);
  validateOverrides(overrides, ids, vocabulary);
  validateConfirmedPairs(confirmedPairs, ids, new Set(seeds.map((s) => s.id)));

  const sorted = [...upstream].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seedOwned = new Map(Object.entries(confirmedPairs).map(([seedId, upstreamId]) => [upstreamId, seedId]));
  const curated = sorted.map((e) => ({ source: e, ...curateOne(e, overrides[e.id], vocabulary) }));

  const excludedByOverride = curated.filter((c) => c.exclude).map((c) => c.entry.id);
  const excludedDetails = curated.filter((c) => c.exclude).map((c) => ({
    id: c.entry.id,
    name: c.entry.name,
    category: c.entry.category,
    upstreamPrimary: c.source.primaryMuscles,
    upstreamSecondary: c.source.secondaryMuscles,
    reason: c.exclusionNote,
  }));
  const pairedEntries = curated.filter((c) => seedOwned.has(c.entry.id)).map((c) => c.entry);
  const excludedForSeeds = curated.filter((c) => seedOwned.has(c.entry.id)).map((c) => ({ upstreamId: c.entry.id, seedId: seedOwned.get(c.entry.id) }));
  const kept = curated.filter((c) => !c.exclude && !seedOwned.has(c.entry.id));

  const byKey = new Map();
  for (const c of kept) {
    if (c.entry.baseMovementId === null) continue;
    const key = [c.entry.baseMovementId, c.entry.equipment, c.entry.variations.join("+")].join("|");
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c.entry.id);
  }
  // For the families that are not progressions (stretches, jumps, ...) a shared key is expected, so it is
  // listed but is not a reason to review the entries (vocab.json: keyClashWarningFamilies).
  const warningFamilies = new Set(vocabulary.keyClashWarningFamilies ?? []);
  const keyClashes = [...byKey].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, ids: list, warningOnly: warningFamilies.has(key.split("|")[0]) }));
  const clashing = new Set(keyClashes.filter((c) => !c.warningOnly).flatMap((c) => c.ids));

  const byName = new Map();
  for (const c of kept) {
    const key = normalizedName(c.entry.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c.entry.id);
  }
  const nameClashes = [...byName.values()].filter((list) => list.length > 1);
  const suspects = new Set(nameClashes.flat());

  const review = [];
  for (const c of kept) {
    const reasons = [];
    if (c.entry.primaryMuscles.length === 0) reasons.push("empty-primary");
    if ((c.entry.unplacedMuscles ?? []).length > 0) reasons.push("undecided-shoulder-head");
    if (c.uncertainEquipment) reasons.push("equipment-uncertain");
    if (clashing.has(c.entry.id)) reasons.push("key-clash");
    if (suspects.has(c.entry.id)) reasons.push("duplicate-suspect");
    if (c.alternatives.length > 0) reasons.push("multiple-families");
    if (c.entry.baseMovementId === null) reasons.push("null-base-movement");
    if (reasons.length > 0) {
      review.push({ entry: c.entry, reasons, alternatives: c.alternatives, score: reasons.reduce((n, r) => n + REASON_WEIGHTS[r], 0), how: c.how });
    }
  }
  const audit = kept
    .filter((c) => c.decisions.length > 0 && auditPick(c.entry.id))
    .map((c) => ({ entry: c.entry, decisions: uniqueSorted(c.decisions), upstream: c.source }));
  review.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));

  return {
    entries: kept.map((c) => c.entry),
    review,
    audit,
    keyClashes,
    nameClashes,
    excludedByOverride,
    excludedDetails,
    excludedForSeeds,
    pairedEntries, // the upstream entries left out because a seed stands for them (their grouping fields go to the seeds)
    provenance: kept.map((c) => ({ id: c.entry.id, how: c.how, duplicatesRemoved: c.duplicatesRemoved, category: c.source.category ?? null })),
  };
}

export function entriesWithoutPrimary(entries) {
  return entries.filter((e) => e.primaryMuscles.length === 0).map((e) => e.id);
}

// One stable text form, so two runs are byte-identical.
export const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;
