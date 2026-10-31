// Primary muscles for Strong exercise names that have no matching or similar stored exercise. Used only as a
// SUGGESTION: the review shows each use as "suggested: ...", and nothing is applied unless the user accepts it.
// Keys are lower-case with the "(Equipment)" ending removed (tableKey in strong-match.js). Ids are the app's
// muscle ids (the full muscle list in src/domain/model.js; a test checks every one).
// Written from general knowledge of the exercises, not from a source: unverified. A name that could mean different
// lifts (a throw, a TRX move, a one-arm press) is left out on purpose, so the user picks by hand.
export const STRONG_MUSCLES = Object.freeze({
  "hip abductor": ["abductors"],
  "hip adductor": ["adductors"],
  "landmine press on knee": ["front_delts"],
  "l-sit": ["abs"],
  "farmer carries": ["forearms", "traps"],
  "palloff press": ["obliques"],
  "cable woodchoppers": ["obliques"],
  "reverse fly": ["rear_delts"],
  "triceps pushdown": ["triceps"],
  "iso-lateral chest press": ["chest"],
  "kelso shrug": ["upper_back"],
  "larsen press": ["chest"],
  "nordic curls": ["hamstrings"],
  "iso-lateral horizontal bench press": ["chest"],
  "shoulder press": ["front_delts"],
  "skullcrusher": ["triceps"],
});
