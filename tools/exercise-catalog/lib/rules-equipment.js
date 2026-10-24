// Equipment: ONE load-bearing value per exercise. Each result says which rule decided it, and
// whether a person should look at it. Rules run in this order; the first that applies wins.

const UPSTREAM = {
  barbell: "barbell",
  dumbbell: "dumbbell",
  kettlebells: "kettlebell",
  cable: "cable",
  bands: "resistance_band",
  "body only": "bodyweight",
  "e-z curl bar": "ez_bar",
  "medicine ball": "medicine_ball",
  "exercise ball": "exercise_ball",
  "foam roll": "foam_roll",
  machine: "machine",
};

export const UPSTREAM_EQUIPMENT = Object.freeze(Object.keys(UPSTREAM));

// Used for upstream "other" and missing equipment: the name tells what the implement is.
// Whole words only ("ring" must not match "hamstring"), and the specific implements come first so
// "wrist roller" and "ab roller" are not read as a foam roller.
const BY_NAME = [
  [
    "other",
    "name-implement",
    /\b(?:parallel bars?|wrist roller|ab roller|ab wheel|atlas|stones?|logs?|yoke|farmer\w*|tires?|sleds?|prowler|cars?|axle|rickshaw|sandbags?|keg|battle ropes?|chains?|trx|suspen\w*|rings?|landmine|boxes|box|benches|bench|chairs?|steps?|balance|plates?|ropes?|sledge\w*|hammer|stairmaster|treadmill|bik(?:e|ing)|bicycl\w*|cycl\w*|skat\w*|elliptical|rower|rowing)\b/,
  ],
  ["pull_up_bar", "name-pull-up-bar", /pull[- ]?ups?|chin-?up|chin up|\bchins?\b|hanging|muscle.up|inverted row|rope climb/],
  // "IT band" is anatomy, not a resistance band.
  ["resistance_band", "name-band", /(?<!\bit )\bbands?\b/],
  ["medicine_ball", "name-ball", /medicine|wall ball/],
  ["exercise_ball", "name-ball", /\bball\b|bosu|stability/],
  ["foam_roll", "name-foam", /foam|roller|\bsmr\b|lacrosse/],
  ["cable", "name-cable", /cable|pulley|rope /],
  ["kettlebell", "name-kettlebell", /kettlebell/],
  ["dumbbell", "name-dumbbell", /dumbbell/],
  ["barbell", "name-barbell", /barbell|\bbar\b/],
];

const NO_EQUIPMENT_CATEGORIES = ["stretching", "cardio", "plyometrics"];

export function classifyEquipment(entry) {
  const name = entry.name.toLowerCase();
  if (/smith/.test(name)) return { equipment: "smith_machine", by: "rule:smith", uncertain: false };
  if (/trap bar|hex bar/.test(name)) return { equipment: "trap_bar", by: "rule:trap-bar", uncertain: false };
  if (entry.equipment !== null && entry.equipment in UPSTREAM) {
    return { equipment: UPSTREAM[entry.equipment], by: "upstream", uncertain: false };
  }
  if (entry.equipment !== null && entry.equipment !== "other") {
    throw new Error(`${entry.id}: upstream equipment "${entry.equipment}" is not one this tool knows`);
  }
  for (const [equipment, rule, pattern] of BY_NAME) {
    if (pattern.test(name)) return { equipment, by: `rule:${rule}`, uncertain: false };
  }
  if (NO_EQUIPMENT_CATEGORIES.includes(entry.category)) return { equipment: "bodyweight", by: "rule:category", uncertain: false };
  if (entry.equipment === null) return { equipment: "bodyweight", by: "assumed:no-equipment-listed", uncertain: true };
  return { equipment: "other", by: "fallback:other", uncertain: true };
}

// equipmentTags: the equipment itself plus setup tags the app's vocabulary has. A bench press
// with a free or guided load needs a bench; a machine press does not.
const BENCH_EQUIPMENT = ["barbell", "dumbbell", "smith_machine", "ez_bar", "kettlebell"];

export function equipmentTagsFor(equipment, baseMovementId) {
  const tags = new Set([equipment]);
  if (baseMovementId === "bench-press" && BENCH_EQUIPMENT.includes(equipment)) tags.add("bench");
  return [...tags].sort();
}
