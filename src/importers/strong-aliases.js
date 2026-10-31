// Strong names that the word match misses, each with the stored exercise it most likely is. Used only as a
// SUGGESTION: strong-match.js puts the target first among the candidates when it is stored and not retired, and
// nothing is accepted unless the user picks it. Keys are the full Strong name in nameKey form (lower-case).
// Targets are ids in the seeds or the catalog of CATALOG_VERSION 1; a test checks each one.
// Chosen from the catalog names and muscles, not from Strong's own definitions: unverified.
export const STRONG_ALIASES = Object.freeze({
  "hip abductor (machine)": "Thigh_Abductor",
  "hip adductor (machine)": "Thigh_Adductor",
  "farmer carries": "Farmers_Walk",
  "palloff press": "Pallof_Press",
  "cable woodchoppers": "Standing_Cable_Wood_Chop",
  "reverse fly (dumbbell)": "Reverse_Flyes",
  "triceps pushdown (cable - straight bar)": "seed-triceps-pushdown",
});
