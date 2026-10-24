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
      "| Upstream id | Name | Why it is here | Base movement | Other families that also matched | Equipment | Variations | Primary | Secondary | Unplaced |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const { entry, reasons, alternatives = [] } of rows) {
      const unplaced = (entry.unplacedMuscles ?? []).map((u) => `${u.upstream} (${u.role})`);
      lines.push(
        `| ${entry.id} | ${entry.name} | ${reasons.join(", ")} | ${entry.baseMovementId ?? "null"} | ${list(alternatives)} | ${entry.equipment} | ${list(entry.variations)} | ${list(entry.primaryMuscles)} | ${list(entry.secondaryMuscles)} | ${list(unplaced)} |`,
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

export function summarize({ upstreamCount, result, overrideCount, strict, additionsCount = 0 }) {
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
    ...(additionsCount > 0 ? { additionsEntries: additionsCount } : {}), // hand-written, origin apogee; shown only when there are some
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
    keyClashWarningOnlyGroups: keyClashes.filter((c) => c.warningOnly).length,
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
    ...(summary.additionsEntries > 0 ? [`Hand-written additions (origin apogee): ${summary.additionsEntries}, on top of the catalog entries above`] : []),
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
    `Key clash groups: ${summary.keyClashGroups} (${summary.keyClashWarningOnlyGroups} of them in families where a shared key is expected and not reviewed); near-duplicate name groups: ${summary.nameClashGroups}`,
    "",
    "By category (entries / needing a human):",
    ...summary.byCategory.map((c) => `  ${c.category}: ${c.entries} / ${c.needHuman}`),
  ];
  return `${lines.join("\n")}\n`;
}

// ---- family audit: two files for reading by eye; they never change a base or any other output ----

const SHARE = (n, total) => `${Math.round((n / total) * 100)}%`;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);
const primaryOf = (e) => (e.primaryMuscles.length === 0 ? "none" : e.primaryMuscles.join("+"));

// Most common value of a list; ties go to the alphabetically first value, so the output never changes.
function commonest(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [value, count] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return { value, count, counts };
}

function groupByBase(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.baseMovementId === null) continue;
    if (!groups.has(e.baseMovementId)) groups.set(e.baseMovementId, []);
    groups.get(e.baseMovementId).push(e);
  }
  return [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function renderFamilies(entries) {
  const groups = groupByBase(entries);
  const lines = [`# Families (${groups.length} base movements in use, ${groups.reduce((n, [, m]) => n + m.length, 0)} entries with a base)`, "", "For skimming: each section is one base movement, with every member. Nothing here is a verdict.", ""];
  for (const [base, members] of groups) {
    const eq = commonest(members.map((m) => m.equipment));
    const mu = commonest(members.map(primaryOf));
    lines.push(
      `## ${base} (${members.length})`,
      "",
      `Most common equipment: ${eq.value} (${SHARE(eq.count, members.length)}). Most common primary muscle: ${mu.value} (${SHARE(mu.count, members.length)}).`,
      "",
    );
    for (const m of [...members].sort(byName)) lines.push(`- ${m.name} | ${m.equipment} | ${primaryOf(m)} | ${list(m.variations)}`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

const NEARLY_CAUGHT_CAP = 60;
const OUTLIER_MIN_MEMBERS = 5;
const RARE_EQUIPMENT_SHARE = 0.1;

// The words of a base movement id as they would appear in a name: "pull-up" -> pull[- ]up, plural allowed.
const keywordPattern = (base) => new RegExp(String.raw`\b${base.split("-").join("[- ]?")}s?\b`, "i");

export function renderOutliers(entries, definedBases) {
  const groups = groupByBase(entries);
  const lines = [
    "# Outliers",
    "",
    "A lead list, not a verdict: an entry here differs from its family's usual pattern, and may be right. Look at the strongest first.",
    `Families with ${OUTLIER_MIN_MEMBERS} or more members only. An entry is listed when its primary muscle differs from the family's most common one, or when its equipment differs and is rare (under ${RARE_EQUIPMENT_SHARE * 100}% of the family).`,
    "",
    "## Entries that deviate",
    "",
    "| Strength | Base movement | Entry | Family usually has | This entry has |",
    "|---|---|---|---|---|",
  ];
  const rows = [];
  for (const [base, members] of groups) {
    if (members.length < OUTLIER_MIN_MEMBERS) continue;
    const eq = commonest(members.map((m) => m.equipment));
    const mu = commonest(members.map(primaryOf));
    for (const m of members) {
      const muShare = (mu.counts.get(primaryOf(m)) ?? 0) / members.length;
      const eqShare = (eq.counts.get(m.equipment) ?? 0) / members.length;
      const primaryDiffers = primaryOf(m) !== mu.value;
      const equipmentDiffers = m.equipment !== eq.value && eqShare < RARE_EQUIPMENT_SHARE;
      if (!primaryDiffers && !equipmentDiffers) continue;
      const strength = (primaryDiffers ? 1 - muShare : 0) + (equipmentDiffers ? 1 - eqShare : 0);
      const has = [primaryDiffers ? `primary ${primaryOf(m)} (${SHARE(muShare, 1)})` : null, equipmentDiffers ? `equipment ${m.equipment} (${SHARE(eqShare, 1)})` : null].filter(Boolean).join("; ");
      rows.push({ strength, base, m, usually: `primary ${mu.value} (${SHARE(mu.count, members.length)}); equipment ${eq.value} (${SHARE(eq.count, members.length)})`, has });
    }
  }
  rows.sort((a, b) => b.strength - a.strength || (a.base < b.base ? -1 : a.base > b.base ? 1 : byName(a.m, b.m)));
  for (const r of rows) lines.push(`| ${r.strength.toFixed(2)} | ${r.base} | ${r.m.name} | ${r.usually} | ${r.has} |`);

  const used = new Set(groups.map(([base]) => base));
  const unused = definedBases.filter((b) => !used.has(b));
  lines.push("", `## Base movements defined in vocab.json that no entry uses (${unused.length})`, "", unused.length === 0 ? "None." : unused.map((b) => `- ${b}`).join("\n"));

  const nearly = [];
  for (const base of [...definedBases].sort()) {
    const pattern = keywordPattern(base);
    for (const e of entries) {
      if (e.baseMovementId !== base && pattern.test(e.name)) nearly.push({ base, e });
    }
  }
  nearly.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : byName(a.e, b.e)));
  lines.push(
    "",
    `## Nearly caught: the name contains a family's words but the entry is not in that family (${nearly.length} found, first ${Math.min(NEARLY_CAUGHT_CAP, nearly.length)} shown)`,
    "",
    "| Family keyword | Entry | Its base movement |",
    "|---|---|---|",
    ...nearly.slice(0, NEARLY_CAUGHT_CAP).map(({ base, e }) => `| ${base} | ${e.name} | ${e.baseMovementId ?? "null"} |`),
  );
  return `${lines.join("\n")}\n`;
}
