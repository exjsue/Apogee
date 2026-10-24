// The files a person reads: the review list in batches, and the summary of counts.

const BATCH_SIZE = 50;
const list = (values) => (values.length === 0 ? "-" : values.join(", "));

export function renderReviewBatches(review) {
  const batches = [];
  for (let start = 0; start < review.length; start += BATCH_SIZE) {
    const rows = review.slice(start, start + BATCH_SIZE);
    const number = String(batches.length + 1).padStart(2, "0");
    const lines = [
      `# Review batch ${number} (rows ${start + 1} to ${start + rows.length} of ${review.length}; most uncertain first)`,
      "",
      "| Upstream id | Name | Why it is here | Base movement | Equipment | Variations | Primary | Secondary | Unplaced |",
      "|---|---|---|---|---|---|---|---|---|",
    ];
    for (const { entry, reasons } of rows) {
      const unplaced = (entry.unplacedMuscles ?? []).map((u) => `${u.upstream} (${u.role})`);
      lines.push(
        `| ${entry.id} | ${entry.name} | ${reasons.join(", ")} | ${entry.baseMovementId ?? "null"} | ${entry.equipment} | ${list(entry.variations)} | ${list(entry.primaryMuscles)} | ${list(entry.secondaryMuscles)} | ${list(unplaced)} |`,
      );
    }
    batches.push({ name: `review-${number}.md`, text: `${lines.join("\n")}\n` });
  }
  return batches;
}

export function renderAudit(audit) {
  const lines = [
    `# Audit sample (${audit.length} entries a rule decided without flagging them; a fixed one in ten)`,
    "",
    "Read these against the upstream values. A clean sample is weak evidence about the rest, not proof.",
    "",
    "| Upstream id | Name | Upstream equipment | Upstream muscles (primary / secondary) | Decided by rule | Equipment | Primary | Secondary |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const { entry, decisions, upstream } of audit) {
    lines.push(
      `| ${entry.id} | ${entry.name} | ${upstream.equipment ?? "null"} | ${list(upstream.primaryMuscles)} / ${list(upstream.secondaryMuscles)} | ${decisions.join(", ")} | ${entry.equipment} | ${list(entry.primaryMuscles)} | ${list(entry.secondaryMuscles)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// Entries an override left out of the catalog, each with the reason written in overrides.json.
export function renderExcluded(details) {
  const lines = [
    `# Excluded from the catalog (${details.length} entries, by override)`,
    "",
    "| Upstream id | Name | Category | Upstream primary | Upstream secondary | Reason |",
    "|---|---|---|---|---|---|",
  ];
  for (const d of details) {
    lines.push(`| ${d.id} | ${d.name} | ${d.category ?? "-"} | ${list(d.upstreamPrimary)} | ${list(d.upstreamSecondary)} | ${d.reason} |`);
  }
  return `${lines.join("\n")}\n`;
}

const tally = (items) => {
  const out = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

export function summarize({ upstreamCount, result, overrideCount, strict }) {
  const { entries, review, audit, provenance, keyClashes, nameClashes, excludedByOverride, excludedForSeeds } = result;
  const needsHuman = review;
  const needsByCategory = tally(needsHuman.map((r) => r.entry.category ?? "(none)"));
  const totalByCategory = tally(entries.map((e) => e.category ?? "(none)"));
  const categories = Object.keys(totalByCategory).map((category) => ({
    category,
    entries: totalByCategory[category],
    needHuman: needsByCategory[category] ?? 0,
  }));
  const placedEntries = entries.filter((e) => e.baseMovementId !== null);
  return {
    upstreamEntries: upstreamCount,
    catalogEntries: entries.length,
    excludedByOverride: excludedByOverride.length,
    excludedForSeeds: excludedForSeeds.length,
    overridesApplied: overrideCount,
    equipmentDecidedBy: tally(provenance.map((p) => p.how.equipment)),
    baseMovement: {
      decidedByRule: provenance.filter((p) => p.how.baseMovement === "rule").length,
      decidedByOverride: provenance.filter((p) => p.how.baseMovement === "override").length,
      nullForReview: entries.filter((e) => e.baseMovementId === null).length,
      byMovement: tally(placedEntries.map((e) => e.baseMovementId)),
    },
    muscles: {
      entriesWithUnplacedPrimaryShoulder: entries.filter((e) => (e.unplacedMuscles ?? []).some((u) => u.role === "primary")).length,
      entriesWithUnplacedSecondaryShoulder: entries.filter((e) => (e.unplacedMuscles ?? []).some((u) => u.role === "secondary")).length,
      entriesWithNoPrimary: entries.filter((e) => e.primaryMuscles.length === 0).length,
      entriesWithTwoPrimary: entries.filter((e) => e.primaryMuscles.length > 1).length,
      entriesWithDuplicateMuscleRemoved: provenance.filter((p) => p.duplicatesRemoved > 0).length,
    },
    reviewList: {
      rows: review.length,
      batches: Math.ceil(review.length / BATCH_SIZE),
      auditSampleRows: audit.length,
      byReason: tally(review.flatMap((r) => r.reasons)),
    },
    keyClashGroups: keyClashes.length,
    nameClashGroups: nameClashes.length,
    byCategory: categories,
    strictMode: strict,
  };
}

export function renderSummary(summary) {
  const lines = [
    "Exercise catalog summary",
    "",
    `Upstream entries: ${summary.upstreamEntries}`,
    `Catalog entries: ${summary.catalogEntries} (left out: ${summary.excludedByOverride} by override, ${summary.excludedForSeeds} for confirmed seed pairs)`,
    `Overrides applied: ${summary.overridesApplied}`,
    "",
    "Equipment, decided by:",
    ...Object.entries(summary.equipmentDecidedBy).map(([k, v]) => `  ${k}: ${v}`),
    "",
    `Base movement: ${summary.baseMovement.decidedByRule} by rule, ${summary.baseMovement.decidedByOverride} by override, ${summary.baseMovement.nullForReview} null (on the review list)`,
    ...Object.entries(summary.baseMovement.byMovement).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "Muscles:",
    `  entries with an unplaced primary shoulder: ${summary.muscles.entriesWithUnplacedPrimaryShoulder}`,
    `  entries with an unplaced secondary shoulder: ${summary.muscles.entriesWithUnplacedSecondaryShoulder}`,
    `  entries with no primary muscle: ${summary.muscles.entriesWithNoPrimary} (--strict fails while this is above zero)`,
    `  entries with two primary muscles: ${summary.muscles.entriesWithTwoPrimary}`,
    `  entries where a repeated primary/secondary muscle was removed: ${summary.muscles.entriesWithDuplicateMuscleRemoved}`,
    "",
    `Review list: ${summary.reviewList.rows} rows in ${summary.reviewList.batches} batches`,
    ...Object.entries(summary.reviewList.byReason).map(([k, v]) => `  ${k}: ${v}`),
    `Key clash groups: ${summary.keyClashGroups}; near-duplicate name groups: ${summary.nameClashGroups}`,
    "",
    "By category (entries / needing a human):",
    ...summary.byCategory.map((c) => `  ${c.category}: ${c.entries} / ${c.needHuman}`),
  ];
  return `${lines.join("\n")}\n`;
}
