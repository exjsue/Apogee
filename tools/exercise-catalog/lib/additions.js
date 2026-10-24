// Exercises written by hand in additions.txt. They are checked on their own, then appended after the
// upstream entries have been curated: they never pass through the upstream rules or overrides.json,
// and an upstream update cannot touch them (their ids all start with apogee-, which no upstream id may).
//
// Every problem found is reported together, in plain words, with the block, the line, what is allowed and
// the exact line to paste. Nothing here writes to additions.txt.

import { equipmentTagsFor } from "./rules-equipment.js";

// How close two names must be before the build asks "did you mean ...?". Tunable.
export const NAME_SIMILARITY = Object.freeze({
  overlap: 0.6, // shared words divided by all different words
  containedMinWords: 2, // or: a name of at least this many words whose every word is inside the other name
});

// The two values of the `origin` field of a catalog entry. Tests import these instead of spelling them out.
export const ORIGIN_UPSTREAM = "upstream";
export const ORIGIN_AUTHORED = "authored";

export const ADDITION_ID_PATTERN = /^apogee-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ADDITION_ID_MAX_LENGTH = 60;

export const CATEGORIES = Object.freeze(["strength", "stretching", "plyometrics", "strongman", "powerlifting", "cardio", "olympic weightlifting"]);
export const LEVELS = Object.freeze(["beginner", "intermediate", "expert"]);
export const MECHANICS = Object.freeze(["compound", "isolation"]);
export const FORCES = Object.freeze(["push", "pull", "static"]);

const FIELDS = ["id", "name", "base", "equipment", "variations", "primary", "secondary", "category", "level", "mechanic", "force", "similar-ok", "retired"];
const REQUIRED = ["id", "name", "base", "equipment", "primary"];

export function slugFor(name) {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `apogee-${slug}`;
}

// ---- reading the file ----

export function parseAdditions(text) {
  const blocks = [];
  const problems = [];
  let current = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (/^-{3,}$/.test(line)) {
      current = null;
      return;
    }
    const match = /^([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      problems.push({
        where: current === null ? "between blocks" : label(current),
        line: lineNumber,
        what: `this line is not in the form "field: value": ${line}`,
        allowed: `fields: ${FIELDS.join(", ")}`,
        fix: "write it as  field: value  on one line, or start the line with # to make it a comment",
      });
      return;
    }
    if (current === null) {
      current = { number: blocks.length + 1, startLine: lineNumber, fields: new Map() };
      blocks.push(current);
    }
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    if (!FIELDS.includes(key)) {
      problems.push({
        where: label(current),
        line: lineNumber,
        what: `"${match[1].trim()}" is not a field I know`,
        allowed: FIELDS.join(", "),
        closest: closest(key, FIELDS),
        fix: "check the spelling, or delete the line",
      });
      return;
    }
    if (current.fields.has(key)) {
      problems.push({ where: label(current), line: lineNumber, what: `the field "${key}" appears twice in this block`, fix: "keep only one line for it" });
      return;
    }
    current.fields.set(key, { value: match[2].trim(), line: lineNumber });
  });
  return { blocks, problems };
}

function label(block) {
  const name = block.fields.get("name");
  return name !== undefined && name.value !== "" ? `block ${block.number} ("${name.value}")` : `block ${block.number}`;
}

// ---- helpers ----

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function closest(value, allowed) {
  const lower = value.toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const d = distance(lower, candidate.toLowerCase());
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

const words = (text) => new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, "")));
const list = (value) => value.split(",").map((s) => s.trim()).filter((s) => s !== "");

export function nameScore(a, b) {
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const overlap = union === 0 ? 0 : shared / union;
  const [shorter, longer] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  const contained = shorter.size >= NAME_SIMILARITY.containedMinWords && [...shorter].every((w) => longer.has(w));
  return { overlap, contained, close: overlap >= NAME_SIMILARITY.overlap || contained };
}

const keyOf = (base, equipment, variations) => [base, equipment, variations.join("+")].join("|");

// ---- checking the blocks ----

// existing: every upstream and seed exercise, as { id, name }. curated: the catalog entries so far (for the group key).
export function buildAdditions({ text, upstream, curated, seeds, vocabulary }) {
  const { blocks, problems } = parseAdditions(text);
  const out = [];
  const warnings = [];
  const warningFamilies = new Set(vocabulary.keyClashWarningFamilies ?? []);
  const add = (problem) => problems.push(problem);

  for (const u of upstream) {
    if (u.id.toLowerCase().startsWith("apogee-")) {
      add({
        where: "the upstream data",
        line: null,
        what: `the upstream id "${u.id}" starts with apogee-, which is reserved for your own exercises`,
        fix: "the upstream file cannot be used as it is; tell the person who maintains the pipeline",
      });
    }
  }

  const upstreamIds = new Map(upstream.map((u) => [u.id.toLowerCase(), u.id]));
  const seedIds = new Map(seeds.map((s) => [s.id.toLowerCase(), s.id]));
  const everyone = [...upstream.map((u) => ({ id: u.id, name: u.name })), ...seeds.map((s) => ({ id: s.id, name: s.name }))];
  const idsSeen = new Map(); // lower-case id -> block label
  const keys = new Map(curated.filter((e) => e.baseMovementId !== null).map((e) => [keyOf(e.baseMovementId, e.equipment, e.variations), { id: e.id, name: e.name }]));
  const earlier = []; // additions accepted so far, for the name check

  for (const block of blocks) {
    const here = label(block);
    const get = (key) => block.fields.get(key);
    const value = (key) => (get(key) === undefined ? "" : get(key).value);
    const lineOf = (key) => (get(key) === undefined ? block.startLine : get(key).line);
    const before = problems.length;

    for (const key of REQUIRED) {
      if (key === "id") continue;
      if (get(key) === undefined || get(key).value === "") {
        add({ where: here, line: block.startLine, what: `the required field "${key}" is missing`, fix: `add a line such as  ${key}: ...` });
      }
    }

    // id
    const id = value("id");
    if (id === "") {
      const suggestion = value("name") === "" ? "apogee-<the-name-in-lower-case-with-hyphens>" : slugFor(value("name"));
      add({
        where: here,
        line: block.startLine,
        what: "the field \"id\" is missing. Every exercise needs an id, written once by hand",
        fix: `add this line to the block:  id: ${suggestion}   (once saved and used, an id is never changed)`,
      });
    } else {
      if (!ADDITION_ID_PATTERN.test(id) || id.length > ADDITION_ID_MAX_LENGTH) {
        add({
          where: here,
          line: lineOf("id"),
          what: `the id "${id}" is not allowed`,
          allowed: `starts with apogee-, then lower-case letters, digits and single hyphens, at most ${ADDITION_ID_MAX_LENGTH} characters`,
          fix: value("name") === "" ? "use an id of that form" : `change the line to  id: ${slugFor(value("name"))}`,
        });
      }
      const lower = id.toLowerCase();
      if (idsSeen.has(lower)) {
        add({ where: here, line: lineOf("id"), what: `the id "${id}" is already used by ${idsSeen.get(lower)}`, fix: "every exercise needs its own id" });
      } else {
        idsSeen.set(lower, here);
      }
      if (upstreamIds.has(lower)) add({ where: here, line: lineOf("id"), what: `the id "${id}" is already an upstream exercise id (${upstreamIds.get(lower)})`, fix: "choose another id" });
      if (seedIds.has(lower)) add({ where: here, line: lineOf("id"), what: `the id "${id}" is already a built-in seed exercise id`, fix: "choose another id" });
    }

    // name
    const name = value("name");
    if (name !== "" && [...name].length > vocabulary.nameMaxLength) {
      add({ where: here, line: lineOf("name"), what: `the name is longer than ${vocabulary.nameMaxLength} characters`, fix: "shorten it" });
    }

    // controlled values
    const oneOf = (key, allowed, what) => {
      const v = value(key);
      if (v === "" || allowed.includes(v)) return;
      const near = closest(v, allowed);
      add({
        where: here,
        line: lineOf(key),
        what: `the ${what} "${v}" is not allowed`,
        allowed: allowed.join(", "),
        closest: near,
        fix: near === null ? `use one of the allowed values on the line  ${key}: ...` : `change the line to  ${key}: ${near}`,
      });
    };
    const manyOf = (key, allowed, what) => {
      const items = list(value(key));
      for (const item of items) {
        if (allowed.includes(item)) continue;
        const near = closest(item, allowed);
        add({
          where: here,
          line: lineOf(key),
          what: `the ${what} "${item}" is not allowed`,
          allowed: allowed.join(", "),
          closest: near,
          fix: near === null ? `use only allowed values on the line  ${key}: ...` : `change "${item}" to "${near}" on the line  ${key}: ...`,
        });
      }
      return items;
    };

    const controlledStart = problems.length;
    const base = value("base");
    if (base !== "" && !vocabulary.baseMovements.includes(base)) {
      const near = closest(base, vocabulary.baseMovements);
      add({
        where: here,
        line: lineOf("base"),
        what: `the base movement "${base}" is not in vocab.json`,
        allowed: vocabulary.baseMovements.join(", "),
        closest: near,
        fix: near === null
          ? `if it really is a new base movement, add "${base}" to the baseMovements list in tools/exercise-catalog/vocab.json first, then run the build again`
          : `change the line to  base: ${near}   (or, for a genuinely new base movement, add "${base}" to the baseMovements list in tools/exercise-catalog/vocab.json first)`,
      });
    }
    oneOf("equipment", vocabulary.equipment, "equipment");
    const variations = manyOf("variations", vocabulary.variations, "variation");
    const controlledEnd = problems.length; // base, equipment and variations are sound if nothing was added since controlledStart
    const primary = manyOf("primary", vocabulary.muscles, "muscle");
    const secondary = manyOf("secondary", vocabulary.muscles, "muscle");
    oneOf("category", CATEGORIES, "category");
    oneOf("level", LEVELS, "level");
    oneOf("mechanic", MECHANICS, "mechanic");
    oneOf("force", FORCES, "force");
    const retired = value("retired").toLowerCase();
    if (retired !== "" && retired !== "yes" && retired !== "no") {
      add({ where: here, line: lineOf("retired"), what: `"${value("retired")}" is not allowed for retired`, allowed: "yes, no", fix: "write  retired: yes  or leave the line out" });
    }
    if (secondary.some((m) => primary.includes(m))) {
      const repeated = secondary.filter((m) => primary.includes(m));
      add({ where: here, line: lineOf("secondary"), what: `the secondary muscle ${repeated.join(", ")} is also a primary muscle`, fix: "remove it from one of the two lines" });
    }

    // The group key needs a sound base, equipment and variations; the name check needs only a name.
    // Both run even when other lines of the block are wrong, so everything is reported at once.
    if (controlledEnd === controlledStart && base !== "" && value("equipment") !== "") {
      const key = keyOf(base, value("equipment"), [...new Set(variations)].sort());
      if (keys.has(key)) {
        const other = keys.get(key);
        const what = `base, equipment and variations are exactly the same as "${other.name}" (id ${other.id})`;
        if (warningFamilies.has(base)) {
          // Stretches, jumps and the like are not progressions: sharing a key is expected, so it is only reported.
          warnings.push({ where: here, line: lineOf("base"), what, fix: `nothing is required; "${base}" is a family where a shared key is expected (vocab.json: keyClashWarningFamilies)` });
        } else {
          add({ where: here, line: lineOf("base"), what, fix: "give this exercise a variation or another equipment that tells them apart, or do not add it" });
        }
      }
    }
    if (name !== "") {
      const acknowledged = new Set(list(value("similar-ok")));
      for (const ack of acknowledged) {
        if (!everyone.some((e) => e.id === ack) && !earlier.some((e) => e.id === ack)) {
          add({ where: here, line: lineOf("similar-ok"), what: `similar-ok names "${ack}", which is not an existing exercise id`, fix: "copy an id exactly from the message that asked you" });
        }
      }
      const close = [...everyone, ...earlier]
        .map((e) => ({ ...e, ...nameScore(name, e.name) }))
        .filter((e) => e.close)
        .sort((a, b) => b.overlap - a.overlap || (a.id < b.id ? -1 : 1));
      const unacknowledged = close.filter((e) => !acknowledged.has(e.id));
      if (unacknowledged.length > 0) {
        const shown = unacknowledged.slice(0, 5);
        const best = shown[0];
        const more = unacknowledged.length - shown.length;
        add({
          where: here,
          line: lineOf("name"),
          what: `Did you mean "${best.name}" (id ${best.id})? The name is very close to ${unacknowledged.length === 1 ? "an exercise that already exists" : `${unacknowledged.length} exercises that already exist`}${shown.length > 1 ? `: ${shown.map((e) => `"${e.name}" (id ${e.id})`).join("; ")}` : ""}${more > 0 ? `; and ${more} more` : ""}`,
          fix: `if this really is a different exercise, add this line to the block:  similar-ok: ${[...acknowledged, ...shown.map((e) => e.id)].join(", ")}   (otherwise do not add it)`,
        });
      }
    }

    if (problems.length === before) {
      const finalVariations = [...new Set(variations)].sort();
      out.push({
        id,
        name,
        baseMovementId: base,
        equipment: value("equipment"),
        equipmentTags: equipmentTagsFor(value("equipment"), base),
        variations: finalVariations,
        primaryMuscles: [...new Set(primary)].sort(),
        secondaryMuscles: [...new Set(secondary)].sort(),
        category: value("category") === "" ? "strength" : value("category"),
        level: value("level") === "" ? null : value("level"),
        mechanic: value("mechanic") === "" ? null : value("mechanic"),
        force: value("force") === "" ? null : value("force"),
        source: "builtin",
        origin: ORIGIN_AUTHORED,
        ...(retired === "yes" ? { retired: true } : {}),
      });
      keys.set(keyOf(base, value("equipment"), finalVariations), { id, name });
      earlier.push({ id, name });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries: problems.length === 0 ? out : [], problems, warnings };
}

// Warnings do not stop the build; they are printed and saved so they are seen.
export function formatWarnings(warnings) {
  const lines = [`The additions file has ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}. The build went ahead; nothing needs to change.`, ""];
  warnings.forEach((w, index) => {
    lines.push(`Warning ${index + 1} of ${warnings.length}`, `  Where: ${w.where}, line ${w.line}`, `  What: ${w.what}`, `  ${w.fix}`, "");
  });
  return lines.join("\n");
}

// Plain text for a person, not a program.
export function formatProblems(problems) {
  const lines = [`The additions file has ${problems.length} ${problems.length === 1 ? "problem" : "problems"}. Nothing was built. Fix them in tools/exercise-catalog/additions.txt and run the build again.`, ""];
  problems.forEach((p, index) => {
    lines.push(`Problem ${index + 1} of ${problems.length}`);
    lines.push(`  Where: ${p.where}${p.line === null || p.line === undefined ? "" : `, line ${p.line}`}`);
    lines.push(`  What is wrong: ${p.what}`);
    if (p.allowed) lines.push(`  Allowed: ${p.allowed}`);
    if (p.closest) lines.push(`  Closest match: ${p.closest}`);
    if (p.fix) lines.push(`  What to do: ${p.fix}`);
    lines.push("");
  });
  return `${lines.join("\n")}`;
}
