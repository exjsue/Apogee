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

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const STEPS = [
  {
    // Schema 2: exercises have a defaultRestSeconds (null = the app's default,
    // 3:00). Records that already have the field are left exactly as they are.
    to: 2,
    async run(tx) {
      for (const exercise of await tx.getAll("exercises")) {
        if (!hasOwn(exercise, "defaultRestSeconds")) {
          await tx.put("exercises", { ...exercise, defaultRestSeconds: null });
        }
      }
    },
  },
];

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
