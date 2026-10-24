// Base movement and variations. A name that merely contains "squat" or "deadlift" is not enough:
// the specific movements come first (good mornings, jerks, Turkish get-ups, hack, split, pistol,
// sissy and jump squats), then the general ones. No rule matches -> null, never a forced match.

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

export function variationsFor(name, equipment) {
  const n = name.toLowerCase();
  const tags = VARIATION_RULES.filter(([, pattern]) => pattern.test(n)).map(([tag]) => tag);
  if (/\bbands?\b/.test(n) && !/reverse band/.test(n) && equipment !== "resistance_band") tags.push("bands");
  return [...new Set(tags)].sort();
}
