// Data upgrades. They run INSIDE the IndexedDB upgrade transaction (see
// idb-adapter.js), the one the browser opens when the database version goes up,
// so the version bump, every change below and the stored schema version commit
// together or not at all. If a step throws, the adapter aborts that transaction:
// the database stays at the old version with the old data, untouched.
//
// `tx` is the adapter's transaction handle (get, put, delete, getAll ...). Only
// await tx.* calls in here, one at a time (see the note in store.js).
//
// Each step is for ONE version and must be safe to look at data that is already
// in the new shape. No step touches the sets, workouts or entries: history is
// never rewritten by an upgrade.

import { exerciseV3Defaults } from "../domain/model.js";
import { withSeedGrouping } from "../domain/seed.js";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Schema 2: exercises have a defaultRestSeconds (null = the app's default,
// 3:00). Records that already have the field are left exactly as they are.
const stepTo2 = {
  to: 2,
  async run(tx) {
    for (const exercise of await tx.getAll("exercises")) {
      if (!hasOwn(exercise, "defaultRestSeconds")) {
        await tx.put("exercises", { ...exercise, defaultRestSeconds: null });
      }
    }
  },
};

const V3_FIELDS = Object.keys(exerciseV3Defaults({}));

// Schema 3: exercises get baseMovementId, equipment, variations, origin, upstreamId, catalogVersion and
// retired. A missing field is added with its default (origin "custom" for the user's own exercises, "seed"
// otherwise), and a seed with no base movement yet gets its grouping (base movement, equipment, variations,
// upstreamId) from src/catalog/seed-grouping.js. A field that is already there is left as it is; the name,
// muscles, equipment tags, notes and default rest are never touched, and nothing is deleted. Only the
// exercises store is read and written. `grouping` is for tests; the app uses the generated one.
export function stepTo3(grouping) {
  return {
    to: 3,
    async run(tx) {
      for (const exercise of await tx.getAll("exercises")) {
        const completed = { ...exerciseV3Defaults(exercise), ...exercise };
        const next = withSeedGrouping(completed, grouping);
        if (next !== completed || V3_FIELDS.some((field) => !hasOwn(exercise, field))) {
          await tx.put("exercises", next);
        }
      }
    },
  };
}

// Schema 4: templates, a new object store. The adapter creates it, empty, in this same upgrade transaction
// (createSchema in idb-adapter.js creates every store in schema.js that is missing). No record is read or
// written: the step exists so the stored schema version becomes 4.
const stepTo4 = {
  to: 4,
  async run() {},
};

// Schema 5: the optional workout name and set rpe and setType. Absent means no value, so no record needs them
// and none is read or written (no default name is added): the step exists so the stored schema version becomes 5.
const stepTo5 = {
  to: 5,
  async run() {},
};

export const STEPS = [stepTo2, stepTo3(), stepTo4, stepTo5];

// Brings data saved at `oldVersion` up to the newest step. A new database
// (oldVersion 0) has nothing to upgrade: store.open() writes its schema version.
// After each step the stored schemaVersion is set to that step's version.
// Resolves with the versions that ran.
export async function upgradeData({ oldVersion, tx, steps = STEPS }) {
  const ran = [];
  if (!(oldVersion >= 1)) return ran;
  for (const step of steps) {
    if (oldVersion >= step.to) continue;
    await step.run(tx);
    await tx.put("meta", { key: "schemaVersion", value: step.to });
    ran.push(step.to);
  }
  return ran;
}
