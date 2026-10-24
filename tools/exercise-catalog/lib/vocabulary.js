// The controlled vocabularies of the catalog. Muscles and equipment start from the app's own lists
// (src/domain/model.js) and use its exact names. The additions below exist ONLY in this tool's
// output: model.js must be changed by a later, approved step before the app can store them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUSCLES, EQUIPMENT, NAME_MAX_LENGTH } from "../../../src/domain/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ADDED_MUSCLES = Object.freeze(["neck", "abductors"]);
export const ADDED_EQUIPMENT = Object.freeze(["trap_bar", "medicine_ball", "exercise_ball", "foam_roll", "other"]);

export function loadVocabulary(file = path.join(here, "..", "vocab.json")) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    muscles: [...MUSCLES, ...ADDED_MUSCLES.filter((m) => !MUSCLES.includes(m))],
    equipment: [...EQUIPMENT, ...ADDED_EQUIPMENT.filter((e) => !EQUIPMENT.includes(e))],
    baseMovements: data.baseMovements,
    variations: data.variations,
    nameMaxLength: NAME_MAX_LENGTH,
  };
}

// For the final report: what model.js lacks.
export function missingFromModel() {
  return {
    muscles: ADDED_MUSCLES.filter((m) => !MUSCLES.includes(m)),
    equipment: ADDED_EQUIPMENT.filter((e) => !EQUIPMENT.includes(e)),
  };
}
