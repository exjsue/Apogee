// Secondary-muscle weights: how much of a working set each secondary muscle of a default exercise is credited with
// (the primary muscles get 1). The app reads them by exercise id at view time (src/catalog/secondary-weights.js), so a
// change here reaches existing installs without touching their stored data.
//
// These are ESTIMATES, medium-to-low confidence. No dataset gives per-exercise fractional credit; the anchors are the
// 0.5 "fractional" counting of indirect sets (Pelland et al., Sports Medicine 2025), MRI training studies for a few
// lifts (squat: Kubo 2019, Plotkin 2023; bench press and triceps: Brandao 2020; rows and biceps: 2019 single-joint vs
// multi-joint) and EMG for the rest. See DECISIONS.md.
//
// The rule: a secondary muscle gets its family's weight (FAMILY_WEIGHTS, by base movement), else DEFAULT_WEIGHT; an entry
// in OVERRIDES replaces both. A major synergist of a compound lift 0.5 to 0.75, a minor synergist or stabiliser 0.25,
// never 1 unless the muscle does the same work as the primary.

export const ALLOWED_WEIGHTS = Object.freeze([0.25, 0.5, 0.75, 1]);
export const DEFAULT_WEIGHT = 0.25;

// base movement -> { secondary muscle -> weight }. A muscle not listed gets DEFAULT_WEIGHT.
export const FAMILY_WEIGHTS = Object.freeze({
  "bench-press": { front_delts: 0.5, triceps: 0.5, chest: 0.75 }, // chest is secondary only on close-grip and floor presses
  "push-up": { triceps: 0.5, chest: 0.75 },
  dip: { chest: 0.75, triceps: 0.75 },
  "overhead-press": { triceps: 0.5, quads: 0.5 }, // quads: thrusters
  "push-press": { triceps: 0.5, quads: 0.5 },
  jerk: { triceps: 0.5, quads: 0.5, front_delts: 0.5 },
  pullover: { lats: 0.5, chest: 0.5 },
  squat: { glutes: 0.75, adductors: 0.5 }, // Kubo 2019: no hamstring growth from squats
  "hack-squat": { glutes: 0.5 },
  "leg-press": { glutes: 0.5, adductors: 0.5 },
  lunge: { glutes: 0.75, adductors: 0.5 },
  "split-squat": { glutes: 0.75, adductors: 0.5 },
  "step-up": { glutes: 0.75, quads: 0.75 },
  "pistol-squat": { glutes: 0.5 },
  "jump-squat": { glutes: 0.5 },
  deadlift: { glutes: 0.75, hamstrings: 0.5, quads: 0.5, lower_back: 0.5, adductors: 0.5 },
  "good-morning": { glutes: 0.5, lower_back: 0.5, hamstrings: 0.5 },
  "back-extension": { glutes: 0.5, hamstrings: 0.5 },
  "glute-ham-raise": { glutes: 0.5 },
  "kettlebell-swing": { glutes: 0.75 },
  "hip-thrust": {}, // hamstrings stay at 0.25: Plotkin 2023 saw little hamstring growth
  kickback: { hamstrings: 0.5 },
  "hip-abduction-adduction": { glutes: 0.5 },
  clean: { glutes: 0.5, quads: 0.5, hamstrings: 0.5, traps: 0.5 },
  "clean-pull": { traps: 0.5 },
  "snatch-pull": { traps: 0.5 },
  snatch: { glutes: 0.5, quads: 0.5, hamstrings: 0.5, traps: 0.5 },
  "clean-and-jerk": { glutes: 0.5, quads: 0.5, triceps: 0.5 },
  "clean-and-press": { triceps: 0.5, quads: 0.5, glutes: 0.5 },
  row: { biceps: 0.5, lats: 0.5, upper_back: 0.5 },
  "pull-up": { biceps: 0.5, upper_back: 0.5, lats: 0.75 },
  pulldown: { biceps: 0.5, upper_back: 0.5 },
  "rear-delt-fly": { upper_back: 0.5 },
  "upright-row": { side_delts: 0.5, traps: 0.5 },
  rollout: { lats: 0.5 },
  "sled-push-drag": { glutes: 0.5 },
});

// exercise id -> { secondary muscle -> weight }, applied after the family rule. Each muscle must be a secondary of that
// exercise (the build stops otherwise). Seeds are listed by their seed- id.
export const OVERRIDES = Object.freeze({
  // seeds
  "seed-overhead-press": { side_delts: 0.5 },
  "seed-barbell-row": { rear_delts: 0.5 },
  // bench dips: the shoulders stay extended and the chest does little
  Bench_Dips: { chest: 0.25 },
  Weighted_Bench_Dip: { chest: 0.25 },
  Dip_Machine: { chest: 0.5 },
  // hammer and reverse curls: the brachioradialis (forearms) is a major mover
  Alternate_Hammer_Curl: { forearms: 0.5 },
  Cross_Body_Hammer_Curl: { forearms: 0.5 },
  Preacher_Hammer_Dumbbell_Curl: { forearms: 0.5 },
  Reverse_Barbell_Curl: { forearms: 0.5 },
  Reverse_Barbell_Preacher_Curls: { forearms: 0.5 },
  Reverse_Cable_Curl: { forearms: 0.5 },
  Reverse_Plate_Curls: { forearms: 0.5 },
  // pull-ups that are mostly a scapular movement
  "Scapular_Pull-Up": { lats: 0.25 },
  // a rear-delt row is still a row for the mid back
  Barbell_Rear_Delt_Row: { lats: 0.25 },
  // close-grip push-ups and presses work the chest less than a full bench
  "Close-Grip_Push-Up_off_of_a_Dumbbell": { chest: 0.5 },
  "Push-Ups_-_Close_Triceps_Position": { chest: 0.5 },
  "Incline_Push-Up_Close-Grip": { chest: 0.5 },
  // the bodyweight squat is too light to credit the glutes like a loaded squat
  Bodyweight_Squat: { glutes: 0.5 },
  Chair_Squat: { glutes: 0.5 },
  // trap-bar deadlift: more knee bend, the quads work like a squat's
  Trap_Bar_Deadlift: { glutes: 0.5 },
});

// The weights of one exercise: { muscle: weight } for every secondary muscle, in the order of secondaryMuscles.
export function secondaryWeightsFor({ id, baseMovementId, secondaryMuscles }) {
  const family = FAMILY_WEIGHTS[baseMovementId] ?? {};
  const override = OVERRIDES[id] ?? {};
  return Object.fromEntries(secondaryMuscles.map((m) => [m, override[m] ?? family[m] ?? DEFAULT_WEIGHT]));
}

// Problems with OVERRIDES against the exercises they name: a muscle that is not a secondary, a weight outside
// ALLOWED_WEIGHTS. Also checks the family table's weights. An id that is not among `exercises` is skipped, because the
// build tests run on a small fixture; tests/secondary-weights.test.js checks every id against the real catalog.
export function checkWeightRules(exercises) {
  const problems = [];
  const byId = new Map(exercises.map((e) => [e.id, e]));
  for (const [id, muscles] of Object.entries(OVERRIDES)) {
    const exercise = byId.get(id);
    if (exercise === undefined) continue;
    for (const [m, w] of Object.entries(muscles)) {
      if (!exercise.secondaryMuscles.includes(m)) problems.push(`secondary weights: ${id} has no secondary muscle "${m}"`);
      if (!ALLOWED_WEIGHTS.includes(w)) problems.push(`secondary weights: ${id} ${m} has weight ${w}, not one of ${ALLOWED_WEIGHTS.join(", ")}`);
    }
  }
  for (const [family, muscles] of Object.entries(FAMILY_WEIGHTS)) {
    for (const [m, w] of Object.entries(muscles)) if (!ALLOWED_WEIGHTS.includes(w)) problems.push(`secondary weights: family ${family} ${m} has weight ${w}`);
  }
  return problems;
}
