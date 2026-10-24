// Base-movement families, found from the exercise names. They run AFTER the specific squat, deadlift and
// bench rules in rules-movement.js, so an entry that already has a base never changes. The first family
// whose rule matches wins, so specific families come before general ones (clean and jerk before clean,
// straight-arm pulldown before pulldown). An entry no family matches stays null: nothing is forced.
//
// A rule gets { name, category, primary }: the upstream name, the upstream category, and the final primary
// muscles (after overrides). Words are matched as words: "chin" must not match "machine", "row" must not
// match "narrow" or "throw", "sled" must not match "sledgehammer" (see the tests).
//
// Not here on purpose (owner decision 2026-10-23): strongman events (stones, keg, log, sandbag, tire, circus
// bell, wheel, power stairs) have no family. They stay null.

const has = (e, re) => re.test(e.name.toLowerCase());
const prim = (e, ...muscles) => muscles.some((m) => e.primary.includes(m));
const cat = (e, ...categories) => categories.includes(e.category);

// Names the owner decided to leave without a base, even though a family rule would take them.
export const STAYS_NULL = Object.freeze([/^one handed hang$/, /^crossover reverse lunge$/]);

// [family id, rule]. Order is priority.
export const FAMILIES = [
  // one decision per category
  ["foam-roll", (e) => has(e, /\bsmr\b|-smr$/)],
  ["cardio", (e) => cat(e, "cardio") && !has(e, /prowler/)],
  ["stretch", (e) => cat(e, "stretching") && !has(e, /^frog hops|stomach vacuum|^superman|scissor kick|inchworm/)],

  // plyometrics
  ["throw", (e) => has(e, /throw|slam|chest pass|chest push|heavy bag thrust/)],
  ["jump", (e) => cat(e, "plyometrics") && has(e, /jump|hop|bound|leap|skip/) && !has(e, /push-up/)],
  ["agility-drill", (e) => cat(e, "plyometrics") && has(e, /shuffle|carioca|butt kick|mountain climber|sprint|drill|start technique|push-off|claw/)],

  // Olympic and kettlebell lifts
  ["clean-and-jerk", (e) => has(e, /clean and jerk/)],
  ["clean-and-press", (e) => has(e, /clean and press/)],
  ["snatch-pull", (e) => has(e, /snatch pull|snatch shrug/)],
  ["snatch-balance", (e) => has(e, /snatch balance/)],
  ["snatch", (e) => has(e, /snatch/)],
  ["clean-pull", (e) => has(e, /clean pull|clean shrug/)],
  ["clean", (e) => has(e, /\bclean\b/)],
  ["jerk", (e) => has(e, /\bjerk\b/)], // widens the existing base
  ["push-press", (e) => has(e, /push press/)],
  ["kettlebell-swing", (e) => has(e, /kettlebell swing|vertical swing/)],

  // strongman (only the two with three or more entries)
  ["carry", (e) => has(e, /farmer|rickshaw carry|yoke walk/)],
  ["sled-push-drag", (e) => has(e, /sled push|sled drag|backward drag|forward drag|bear crawl sled|prowler/)],

  ["deadlift", (e) => has(e, /wide stance stiff legs/)], // widens the existing base: a stiff-leg deadlift

  // pulling
  ["pull-up", (e) => has(e, /pull[- ]?ups?\b|pullups|chin-?ups?\b|\bchins?\b|muscle up/) && !has(e, /chin to chest|gorilla chin|to chin/)],
  ["straight-arm-pulldown", (e) => has(e, /straight-arm pulldown|cable incline pushdown/)],
  ["pulldown", (e) => has(e, /pulldown/) && !has(e, /triceps|pushdown/)],
  ["pullover", (e) => has(e, /pullover/) && !has(e, /front raise and pullover/)],
  ["upright-row", (e) => has(e, /upright(?:\s+[\w-]+)*\s+row/)],
  ["rear-delt-fly", (e) => has(e, /reverse fl|rear lateral|rear delt|face pull|pull apart|back flyes|reverse machine|sled reverse/) && !has(e, /reverse grip|\brows?\b/)],
  ["row", (e) => has(e, /\brows?\b/) && !has(e, /upright|stationary/)],
  ["shrug", (e) => has(e, /shrug/)],

  // shoulders
  ["lateral-raise", (e) => cat(e, "strength", "strongman") && !has(e, /alternating deltoid raise|side laterals to front raise/)
    && (has(e, /lateral raise|side lateral|side laterals|bent over low-pulley side lateral/) || (prim(e, "side_delts") && has(e, /raise|partials|crucifix/)))],
  ["front-raise", (e) => cat(e, "strength") && has(e, /front.*raise|straight raises|single dumbbell raise/) && !has(e, /pullover|side laterals to front raise/)],
  ["overhead-press", (e) => cat(e, "strength") && prim(e, "front_delts") && has(e, /press|handstand push|thruster/)],

  // chest and triceps
  ["push-up", (e) => has(e, /push-?ups?|pushups/)],
  ["dip", (e) => has(e, /\bdips?\b/)],
  ["fly", (e) => has(e, /\bfl(?:y|ye|yes)\b|cable crossover|cross over|butterfly|around the worlds|cable iron cross/)],
  ["bench-press", (e) => (has(e, /press/) && (prim(e, "chest") || has(e, /floor press|board press|pin press|chain press|close-grip.*press|ez-bar press/))
    && !has(e, /overhead|shoulder|military|pallof|leg press|calf|svend|body tricep|tate|jm press|triceps press|to chin/)) || has(e, /incline dumbbell bench/) || has(e, /neck press/)], // widens the existing base
  ["triceps-pushdown", (e) => has(e, /triceps? pushdown/)],
  ["triceps-extension", (e) => cat(e, "strength", "powerlifting") && prim(e, "triceps") && !has(e, /push-up|dip|pushdown|halo/)],

  // arms
  ["wrist-curl", (e) => has(e, /wrist curl|finger curl/)],
  ["forearm-rotation", (e) => has(e, /pronation|supination|wrist rotation/)],
  ["leg-curl", (e) => has(e, /leg curl|hamstring curl|ball leg curl/)],
  ["curl", (e) => has(e, /\bcurls?\b/)],

  // legs and hips
  ["leg-press", (e) => has(e, /leg press/) && !has(e, /calf/)],
  ["leg-extension", (e) => has(e, /leg extension/)],
  ["calf-raise", (e) => has(e, /calf (raise|press)|calf raises|donkey calf|rocking standing calf|seated calf raise/)],
  ["lunge", (e) => has(e, /lunge/) && !has(e, /lunge pass through|lunge sprint/)],
  ["step-up", (e) => has(e, /step.?ups?/)],
  ["hip-thrust", (e) => has(e, /hip thrust|glute bridge|hip bridge|butt lift|hip lift/)],
  ["glute-ham-raise", (e) => has(e, /glute[- ]ham raise/)],
  ["back-extension", (e) => has(e, /hyperextension/)],
  ["hip-abduction-adduction", (e) => has(e, /thigh abductor|thigh adductor|hip adduction|walk/) && !has(e, /walking/)],
  ["kickback", (e) => has(e, /glute kickback|legged cable kickback/)],

  // core
  ["crunch", (e) => has(e, /crunch/) && !has(e, /gorilla chin/)],
  ["sit-up", (e) => has(e, /sit-?ups?/)],
  ["leg-raise", (e) => cat(e, "strength") && has(e, /leg raise|hip raise|knee raise|leg pull-in|hanging pike|toe touchers|leg lift|leg tucks|scissor|flutter/)],
  ["rollout", (e) => has(e, /ab roller|rollout|fallout/)],
  ["plank", (e) => has(e, /^plank$|side bridge|dead bug|spider crawl/)],
  ["twist", (e) => cat(e, "strength", "plyometrics") && has(e, /twist|wood chop|landmine 180/) && !has(e, /external rotation/)],
  ["side-bend", (e) => has(e, /side bend|side jackknife/)],
  ["windmill", (e) => cat(e, "strength") && has(e, /windmill/)],
  ["pallof-press", (e) => has(e, /pallof/)],

  // neck
  ["neck-exercise", (e) => prim(e, "neck") && cat(e, "strength")],
];

export const FAMILY_IDS = Object.freeze(FAMILIES.map(([id]) => id));

// Every family whose rule matches, in priority order (the first is the one used). Empty when the owner
// decided the name stays null.
export function familyMatches(entry) {
  if (STAYS_NULL.some((re) => re.test(entry.name.toLowerCase()))) return [];
  return FAMILIES.filter(([, rule]) => rule(entry)).map(([id]) => id);
}

export function familyFor(entry) {
  return familyMatches(entry)[0] ?? null;
}
