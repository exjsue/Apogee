// Candidate pairs between the app's seed records and the curated upstream entries. They are a
// table for a person to read; nothing here is applied. Confirmed pairs live in their own file.

const tokens = (text) =>
  new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((t) => t.replace(/s$/, "")));

// Seed names and upstream names word things differently; a few plain synonyms help the overlap.
const SYNONYMS = { db: "dumbbell", bb: "barbell", press: "press", lateral: "lateral" };

const normalize = (text) => [...tokens(text)].map((t) => SYNONYMS[t] ?? t);

function score(seed, entry) {
  const a = new Set(normalize(seed.name));
  const b = new Set(normalize(entry.name));
  const shared = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  let value = union === 0 ? 0 : shared / union;
  const reasons = [`${shared} shared words of ${union}`];
  const primary = new Set(entry.primaryMuscles);
  const muscleHit = seed.primaryMuscles.filter((m) => primary.has(m)).length;
  if (muscleHit > 0) { value += 0.15; reasons.push("a primary muscle matches"); }
  const equipmentHit = seed.equipmentTags.includes(entry.equipment);
  if (equipmentHit) { value += 0.15; reasons.push("equipment matches"); }
  return { value: Math.round(value * 1000) / 1000, reasons };
}

export function candidatePairs(seeds, entries, perSeed = 3) {
  return seeds.map((seed) => {
    const scored = entries
      .map((entry) => ({ entry, ...score(seed, entry) }))
      .filter((c) => c.value > 0.2)
      .sort((a, b) => b.value - a.value || (a.entry.id < b.entry.id ? -1 : 1))
      .slice(0, perSeed);
    return { seed, candidates: scored };
  });
}

export function renderSeedPairs(pairs) {
  const lines = [
    "# Candidate seed pairs (for review; nothing here is applied)",
    "",
    "To confirm a pair, add `\"seed-id\": \"Upstream_Id\"` to tools/exercise-catalog/confirmed-seed-pairs.json.",
    "",
    "| Seed id | Seed name | Candidate upstream id | Candidate name | Score | Why |",
    "|---|---|---|---|---|---|",
  ];
  for (const { seed, candidates } of pairs) {
    if (candidates.length === 0) lines.push(`| ${seed.id} | ${seed.name} | (none) | | | no candidate above the threshold |`);
    for (const c of candidates) {
      lines.push(`| ${seed.id} | ${seed.name} | ${c.entry.id} | ${c.entry.name} | ${c.value} | ${c.reasons.join("; ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}
