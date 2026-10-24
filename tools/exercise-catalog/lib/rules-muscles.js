// Muscles: upstream values become the catalog vocabulary. A shoulder is placed in a head only
// when the name says which; otherwise it is left UNPLACED, never guessed.

const DIRECT = {
  quadriceps: "quads",
  "middle back": "upper_back",
  "lower back": "lower_back",
  hamstrings: "hamstrings",
  adductors: "adductors",
  abductors: "abductors",
  biceps: "biceps",
  chest: "chest",
  calves: "calves",
  glutes: "glutes",
  lats: "lats",
  triceps: "triceps",
  traps: "traps",
  forearms: "forearms",
  neck: "neck",
};

export const UPSTREAM_MUSCLES = Object.freeze([...Object.keys(DIRECT), "shoulders", "abdominals"]);

// First match wins, so the more specific heads come first.
export function shoulderHead(name) {
  const n = name.toLowerCase();
  if (/rear|reverse fly|reverse flye|face pull|bent.?over (dumbbell )?(raise|lateral)|rear delt|reverse machine fly/.test(n)) return "rear_delts";
  if (/lateral|side raise|side lateral|upright row/.test(n)) return "side_delts";
  // A bare "raise", "push" or "overhead" does not say which head, so it is left unplaced rather than guessed.
  if (/press|front.*raise|\bclean\b|snatch|jerk|arnold|thruster|handstand push|overhead.*squat|squat.*overhead/.test(n)) return "front_delts";
  return null;
}

export function absOrObliques(name) {
  return /twist|oblique|side bend|wood ?chop|side plank|windmill|russian|rotation|bicycle|lateral flexion|side jackknife/.test(name.toLowerCase())
    ? "obliques"
    : "abs";
}

// Returns { placed: [...sorted unique catalog muscles], unplaced: number of shoulders left undecided,
// notes: which name rules decided something (for the audit sample) }.
export function mapMuscles(entry, upstreamList) {
  const placed = new Set();
  const notes = [];
  let unplaced = 0;
  for (const muscle of upstreamList) {
    if (muscle === "shoulders") {
      const head = shoulderHead(entry.name);
      if (head === null) unplaced += 1;
      else {
        placed.add(head);
        notes.push(`shoulder:${head}`);
      }
    } else if (muscle === "abdominals") {
      const part = absOrObliques(entry.name);
      placed.add(part);
      if (part === "obliques") notes.push("oblique");
    } else if (muscle in DIRECT) {
      placed.add(DIRECT[muscle]);
    } else {
      throw new Error(`${entry.id}: upstream muscle "${muscle}" is not one this tool knows`);
    }
  }
  return { placed: [...placed].sort(), unplaced, notes };
}
