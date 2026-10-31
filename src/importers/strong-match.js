// Matching Strong exercise names to stored exercises, and the plain-text review of the matches. Pure: no DOM,
// storage or network. Nothing here chooses for the user: a match by rule a or b is a proposal the review shows, and a
// suggestion (a candidate or muscles) is never applied silently.

import { nameKey } from "../domain/exercise-names.js";
import { normalizeName } from "./strong.js";
import { STRONG_MUSCLES } from "./strong-muscles.js";
import { STRONG_ALIASES } from "./strong-aliases.js";

export const MAX_SUGGESTIONS = 3;
// A candidate needs at least this share of the words of both names in common (shared words / all words).
export const MIN_SCORE = 0.5;

const IGNORED = new Set(["a", "an", "the", "on", "with", "and"]);

// Lower-case words; a trailing "s" is dropped (only to compare, never stored) so "Pushups" meets "Push-up".
function words(name) {
  return new Set(name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((word) => word !== "" && !IGNORED.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)));
}

// "Squat (Barbell)" -> "Barbell Squat". Null when the name has no "(Equipment)" ending.
export function reorderEquipment(name) {
  const match = /^(.*?)\s*\(([^()]+)\)$/.exec(name);
  return match === null || match[1].trim() === "" ? null : normalizeName(`${match[2]} ${match[1]}`);
}

// The key of the muscle table: lower-case, equipment ending removed.
export const tableKey = (name) => normalizeName(name.replace(/\s*\([^()]*\)$/, "")).toLowerCase();

// names: [{ name, sets, workouts }] (name already normalized). exercises: the stored exercises. Retired exercises
// are never matched or suggested.
// -> [{ name, sets, workouts, status, rule, target, suggestions, muscles }]
//   status      "auto" (one stored exercise has the same nameKey, rule a, or the same after reordering the equipment
//               ending, rule b), "suggested" (candidates by shared words), "none"
//   target      the stored exercise for "auto"
//   suggestions up to MAX_SUGGESTIONS [{ exercise, score }], best first. A name in STRONG_ALIASES whose target is
//               stored and not retired gets that target first as { exercise, score: null, alias: true }, still only
//               suggested.
//   muscles     { source: "candidate" | "table" | null, ids }: the muscles to suggest if the name becomes a custom
//               exercise. From the first suggestion (the alias target when there is one), else from the table,
//               else none.
export function matchStrongNames(names, exercises) {
  const pool = exercises.filter((exercise) => exercise.retired !== true);
  const poolById = new Map(pool.map((exercise) => [exercise.id, exercise]));
  const byKey = new Map();
  for (const exercise of pool) {
    const key = nameKey(exercise.name);
    byKey.set(key, [...(byKey.get(key) ?? []), exercise]);
  }
  const poolWords = pool.map((exercise) => ({ exercise, words: words(exercise.name) }));
  return names.map(({ name, sets, workouts }) => {
    const result = { name, sets, workouts, status: "none", rule: null, target: null, suggestions: [], muscles: { source: null, ids: [] } };
    for (const [rule, candidate] of [["a", name], ["b", reorderEquipment(name)]]) {
      if (candidate === null) continue;
      const found = byKey.get(nameKey(candidate)) ?? [];
      if (found.length === 1) return { ...result, status: "auto", rule, target: found[0] };
    }
    const mine = words(name);
    const scored = poolWords
      .map(({ exercise, words: theirs }) => {
        const shared = [...mine].filter((word) => theirs.has(word)).length;
        return { exercise, score: shared / (mine.size + theirs.size - shared) };
      })
      .filter((candidate) => candidate.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name) || (a.exercise.id < b.exercise.id ? -1 : 1));
    const aliasKey = nameKey(name);
    const alias = Object.hasOwn(STRONG_ALIASES, aliasKey) ? poolById.get(STRONG_ALIASES[aliasKey]) : undefined;
    result.suggestions = (alias === undefined
      ? scored
      : [{ exercise: alias, score: null, alias: true }, ...scored.filter((candidate) => candidate.exercise.id !== alias.id)]
    ).slice(0, MAX_SUGGESTIONS);
    if (result.suggestions.length > 0) {
      result.status = "suggested";
      result.muscles = { source: "candidate", ids: [...result.suggestions[0].exercise.primaryMuscles] };
    } else if (Object.hasOwn(STRONG_MUSCLES, tableKey(name))) {
      result.muscles = { source: "table", ids: [...STRONG_MUSCLES[tableKey(name)]] };
    }
    return result;
  });
}

// The name list for matchStrongNames, from parseStrongCsv's workouts: one per name (by nameKey), first spelling kept,
// with how many sets and how many workouts use it.
export function strongNameCounts(workouts) {
  const counts = new Map();
  for (const workout of workouts) {
    for (const key of new Set(workout.rows.map((row) => nameKey(row.exercise)))) {
      const entry = counts.get(key) ?? { name: workout.rows.find((row) => nameKey(row.exercise) === key).exercise, sets: 0, workouts: 0 };
      entry.workouts += 1;
      counts.set(key, entry);
    }
    for (const row of workout.rows) counts.get(nameKey(row.exercise)).sets += 1;
  }
  return [...counts.values()];
}

const list = (ids) => (ids.length === 0 ? "none" : ids.join(", "));

// The review as plain text, one line per Strong name. It only describes: nothing in it is applied.
export function renderReview(results) {
  const tally = { auto: 0, candidate: 0, table: 0, none: 0 };
  const lines = results.map((r) => {
    const head = `${r.name} | ${r.sets} sets in ${r.workouts} workouts | `;
    if (r.status === "auto") {
      tally.auto += 1;
      return `${head}MATCHED (rule ${r.rule}) -> "${r.target.name}" [${list(r.target.primaryMuscles)}]`;
    }
    if (r.status === "suggested") {
      tally.candidate += 1;
      const shown = r.suggestions.map((s, i) => `${i + 1}) "${s.exercise.name}" [${list(s.exercise.primaryMuscles)}] ${s.alias ? "alias" : s.score.toFixed(2)}`);
      return `${head}SUGGESTED: ${shown.join("; ")} | muscles if made a custom exercise: suggested: ${list(r.muscles.ids)} (from candidate 1)`;
    }
    if (r.muscles.source === "table") {
      tally.table += 1;
      return `${head}NO CANDIDATE | muscles if made a custom exercise: suggested: ${list(r.muscles.ids)} (from the importer's table)`;
    }
    tally.none += 1;
    return `${head}NO CANDIDATE | no suggestion: pick muscles by hand`;
  });
  return [
    "Strong import review. Nothing below has been applied; every line is a proposal.",
    `${results.length} names: ${tally.auto} matched, ${tally.candidate} with candidates, ${tally.table} with table muscles only, ${tally.none} with no suggestion.`,
    "",
    ...lines,
    "",
  ].join("\n");
}
