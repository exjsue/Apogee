// The exercise library service: makes sure the stored catalog is the one this app ships. Not used by the
// app yet (src/ui/main.js does not import it).
//
// The 246 KB catalog module is loaded only when the stored catalog is not current. catalog-info.js is small
// and says which version and how many entries to expect; the loaded module must say the same, or nothing is
// written. That catches a catalog.js from another build (a stale cache, say) next to this code.
//
// getStatus() is what the exercise picker shows (src/ui/workout-view.js): "syncing" while the library is
// loaded and stored, "failed" if that went wrong, otherwise nothing ("idle" before the first check, "ready").

import { CATALOG_VERSION, CATALOG_COUNT } from "../catalog/catalog-info.js";

export function createCatalogService({
  catalogStore,
  load = () => import("../catalog/catalog.js"),
  info = { version: CATALOG_VERSION, count: CATALOG_COUNT },
} = {}) {
  let status = "idle";
  let running = null;

  async function run() {
    try {
      if (await catalogStore.catalogIsCurrent(info)) {
        status = "ready";
        return { status, synced: false };
      }
      status = "syncing";
      const catalog = await load();
      if (catalog.CATALOG_VERSION !== info.version) {
        throw new Error(`The exercise library file is version ${catalog.CATALOG_VERSION}, expected ${info.version}.`);
      }
      if (!Array.isArray(catalog.CATALOG) || catalog.CATALOG.length !== info.count) {
        throw new Error(`The exercise library file has ${catalog.CATALOG?.length} entries, expected ${info.count}.`);
      }
      const result = await catalogStore.syncCatalog(catalog.CATALOG, info);
      status = "ready";
      return { status, synced: true, result };
    } catch (error) {
      status = "failed";
      return { status, synced: false, error };
    }
  }

  // Checks and, if needed, syncs. Never rejects: the outcome is in the result and in getStatus().
  // Calls made while one is running share it.
  function ensureCurrent() {
    if (running === null) {
      running = run().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return { getStatus: () => status, ensureCurrent };
}
