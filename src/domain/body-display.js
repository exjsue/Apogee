// What the Body diagram shows, worked out from a value map { muscleId: number }. Display rules only: the
// per-muscle load itself is computed by src/domain/muscle-load.js and is never changed here.
// Pure JavaScript: no DOM, no storage, no clock.

export const INTENSITY_STEPS = 5;

// The diagram has no region for the neck, so its value is added to the traps, in the display only. Returns a new
// map without a neck key; the map passed in is not changed. A missing value counts as 0.
export function foldNeckIntoTraps(values) {
  const { neck = 0, ...rest } = values;
  return { ...rest, traps: (rest.traps ?? 0) + neck };
}

// Which of the INTENSITY_STEPS shades a value gets: 0 for nothing (a value of 0 or less, or no usable max), otherwise
// 1 to INTENSITY_STEPS, rounded up, so any work at all is at least step 1 and `max` itself is the top step.
// Step 4 (real data) must pass a FIXED reference as `max` (the top of the target range), not the largest value in
// the map, so that one large muscle cannot flatten the shading of all the others.
export function intensityStep(value, max) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(INTENSITY_STEPS, Math.ceil((value / max) * INTENSITY_STEPS));
}
