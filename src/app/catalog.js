// The exercise library service: makes sure the stored catalog is the one this app ships. src/ui/main.js
// starts it after the first paint and again after an import.
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
  const listeners = new Set();

  // A listener that throws is ignored: a redraw problem must never turn into a failed sync.
  function setStatus(next) {
    if (next === status) return;
    status = next;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // ignored, see above
      }
    }
  }

  async function run() {
    try {
      if (await catalogStore.catalogIsCurrent(info)) {
        setStatus("ready");
        return { status, synced: false };
      }
      setStatus("syncing");
      const catalog = await load();
      if (catalog.CATALOG_VERSION !== info.version) {
        throw new Error(`The exercise library file is version ${catalog.CATALOG_VERSION}, expected ${info.version}.`);
      }
      if (!Array.isArray(catalog.CATALOG) || catalog.CATALOG.length !== info.count) {
        throw new Error(`The exercise library file has ${catalog.CATALOG?.length} entries, expected ${info.count}.`);
      }
      const result = await catalogStore.syncCatalog(catalog.CATALOG, info);
      setStatus("ready");
      return { status, synced: true, result };
    } catch (error) {
      setStatus("failed");
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

  // A fresh check even if one is running: an import replaces the exercises and deletes the flag, so a
  // check that started before it may already have read the old data. Never rejects.
  function recheck() {
    return (running ?? Promise.resolve()).then(() => ensureCurrent());
  }

  // listener(status) is called on every change of getStatus().
  const onChange = (listener) => {
    listeners.add(listener);
  };

  return { getStatus: () => status, ensureCurrent, recheck, onChange };
}

// Runs task after the next frame has been painted: requestAnimationFrame runs just before a paint, and a
// timer set from inside it runs after that paint. In a hidden tab frames are paused, so it waits until shown.
export function startAfterFirstPaint(task, { frame = requestAnimationFrame, later = setTimeout } = {}) {
  frame(() => later(task, 0));
}

// The backup service with an import that re-checks the library once it is done. The import's own result
// and errors are unchanged; the re-check is not awaited.
export function resyncAfterImport(backup, catalog) {
  return {
    ...backup,
    importFromText: async (...args) => {
      const counts = await backup.importFromText(...args);
      catalog.recheck();
      return counts;
    },
  };
}
