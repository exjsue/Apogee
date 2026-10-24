// Base movement and variations. A name that merely contains "squat" or "deadlift" is not enough:
// the specific movements come first (good mornings, jerks, Turkish get-ups, hack, split, pistol,
// sissy and jump squats), then the general ones. No rule matches -> null, never a forced match.
// What the first rules leave null goes on to the families in rules-families.js.

import { familyMatches } from "./rules-families.js";

const BASE_RULES = [
  ["good-morning", /good morning/],
  ["turkish-get-up", /turkish get-up/],
  ["jerk-dip", /jerk dip/],
  ["jerk", /squat jerk/],
  ["hack-squat", /hack squat/],
  ["split-squat", /split squat|bulgarian/],
  ["pistol-squat", /pistol/],
  ["sissy-squat", /sissy/],
  ["jump-squat", /jump squat/],
  ["deadlift", /dead ?lift|rack pull/],
  ["bench-press", /bench press/],
  ["squat", /squat/],
];

export function baseMovementFor(name) {
  const n = name.toLowerCase();
  const hit = BASE_RULES.find(([, pattern]) => pattern.test(n));
  return hit === undefined ? null : hit[0];
}

// The squat, deadlift and bench rules above come first and are never overruled; only an entry they leave
// null goes on to the families. `byFamily` says which step decided, because the extra variation tags below
// apply only to family entries (the approved squat, deadlift and bench rows keep the tags they were approved with).
// `alternatives` lists the other families that also matched, for the review list.
export function classifyBase({ name, category, primary }) {
  const specific = baseMovementFor(name);
  if (specific !== null) return { id: specific, byFamily: false, alternatives: [] };
  const matches = familyMatches({ name, category, primary });
  return { id: matches[0] ?? null, byFamily: matches.length > 0, alternatives: matches.slice(1) };
}

// Each tag has one pattern. "bands" is a tag only when another implement carries the load.
const VARIATION_RULES = [
  ["axle", /axle/],
  ["box", /\bbox\b/],
  ["car", /car deadlift/],
  ["chains", /chains/],
  ["clean-grip", /clean grip/],
  ["clean-style", /clean deadlift/],
  ["close-grip", /close[- ]grip/],
  ["decline", /decline/],
  ["deficit", /deficit/],
  ["frankenstein", /frankenstein/],
  ["front", /\bfront\b/],
  ["full", /full squat/],
  ["goblet", /goblet/],
  ["guillotine", /guillotine/],
  ["hanging-bar", /hanging bar/],
  ["incline", /incline/],
  ["jefferson", /jefferson/],
  ["kneeling", /kneeling/],
  ["medium-grip", /medium grip/],
  ["narrow-stance", /narrow stance/],
  ["neutral-grip", /neutral grip|hammer grip/],
  ["olympic", /olympic/],
  ["one-arm", /one-arm|one arm/],
  ["overhead", /overhead/],
  ["pins", /off pins|\bpin\b/],
  ["plate-movers", /plate movers/],
  ["plie", /plie/],
  ["powerlifting-style", /powerlifting/],
  ["pull-through", /pull through/],
  ["rack", /rack pull/],
  ["reverse-bands", /reverse band/],
  ["reverse-grip", /reverse(?! band)/],
  ["rickshaw", /rickshaw/],
  ["romanian", /romanian/],
  ["seated", /seated/],
  ["single-leg", /one-?leg|single-leg|one leg|1 leg/],
  ["snatch-style", /snatch deadlift/],
  ["speed", /speed/],
  ["stiff-leg", /stiff[ -]leg/],
  ["sumo", /sumo/],
  ["suspended", /suspended/],
  ["to-bench", /to a bench/],
  ["weighted", /weighted/],
  ["wide-grip", /wide[- ]grip/],
  ["wide-stance", /wide stance/],
  ["zercher", /zercher/],
];

// Tags for the families only: how the exercise is done, so two entries of one family tell apart.
const FAMILY_VARIATION_RULES = [
  ["alternating", /alternat/],
  ["assisted", /assisted/],
  ["behind-back", /behind the back/],
  ["behind-neck", /behind (the )?neck/],
  ["bent-over", /bent[- ]over/],
  ["blocks", /blocks/],
  ["concentration", /concentration/],
  ["cross-body", /cross-?body/],
  ["double", /\bdouble\b/],
  ["elevated", /elevated/],
  ["hammer", /hammer/],
  ["hang", /\bhang\b/],
  ["isometric", /isometric/],
  ["kickback", /kickback/],
  ["lying", /\blying\b|\bsupine\b/],
  ["machine", /machine|leverage/],
  ["narrow-grip", /narrow[- ]grip/],
  ["palms-down", /palms?-down|pronated/],
  ["palms-up", /palms?-up|supinated|underhand/],
  ["power", /\bpower\b/],
  ["preacher", /preacher/],
  ["rope", /\brope\b/],
  ["split", /\bsplit\b/],
  ["standing", /\bstanding\b/],
  ["towel", /towel/],
  ["two-arm", /two-arm|two-dumbbell/],
  ["v-bar", /v-bar/],
  ["walking", /walking/],
];

// What kind of cardio it is.
const CARDIO_MODALITY_RULES = [
  ["cycling", /bicycl|bike/],
  ["elliptical", /elliptical/],
  ["jump-rope", /rope jumping/],
  ["rowing", /rowing/],
  ["running", /running|jogging|sprint/],
  ["skating", /skating/],
  ["stairs", /stair|step mill/],
  ["walking", /walking/],
];

// `family` is passed only when the base came from a family rule: { id, primary }.
export function variationsFor(name, equipment, family = null) {
  const n = name.toLowerCase();
  const tags = VARIATION_RULES.filter(([, pattern]) => pattern.test(n)).map(([tag]) => tag);
  if (/\bbands?\b/.test(n) && !/reverse band/.test(n) && equipment !== "resistance_band") tags.push("bands");
  if (family !== null) {
    // A grip tag needs the word "grip" in the name: "reverse" alone says nothing about the hands (Reverse Crunch,
    // Reverse Hyperextension). The squat, deadlift and bench rules keep their approved tags, including the bare
    // "reverse" of Reverse Triceps Bench Press.
    for (let i = tags.length - 1; i >= 0; i -= 1) if (tags[i].endsWith("-grip") && !/grip/.test(n)) tags.splice(i, 1);
    tags.push(...FAMILY_VARIATION_RULES.filter(([, pattern]) => pattern.test(n)).map(([tag]) => tag));
    // Stretches and foam rolling are told apart by the muscle they work; cardio by its kind.
    if (family.id === "stretch" || family.id === "foam-roll") tags.push(...family.primary.map((m) => `target-${m.replaceAll("_", "-")}`));
    if (family.id === "cardio") tags.push(...CARDIO_MODALITY_RULES.filter(([, pattern]) => pattern.test(n)).map(([tag]) => tag));
  }
  return [...new Set(tags)].sort();
}
