// Starts the real app: opens the database, adds the built-in exercises and
// mounts the UI. Everything here is local; nothing is requested over a network.

import { h } from "./dom.js";
import { mountApp } from "./app.js";
import { showDatabaseNotice } from "./db-notices.js";
import { installPullToRefresh } from "./pull-refresh.js";
import { createIdbAdapter, requestPersistentStorage } from "../storage/idb-adapter.js";
import { APP_DB_NAME } from "../storage/schema.js";
import { createStore } from "../storage/store.js";
import { createCatalogStore } from "../storage/catalog-store.js";
import { createBackup } from "../backup/backup.js";
import { downloadBlob, readFileAsText } from "../backup/download.js";
import { createLogger } from "../app/logger.js";
import { createOffline } from "../app/offline.js";
import { checkPersistence } from "../app/persistence.js";
import { createCatalogService, startAfterFirstPaint, resyncAfterImport } from "../app/catalog.js";
import { SEED_EXERCISES, SEED_VERSION } from "../domain/seed.js";
import { readImportContext } from "../importers/strong-apply.js";

const root = document.getElementById("app");

async function start() {
  try {
    const adapter = createIdbAdapter({
      name: APP_DB_NAME,
      // Both are visible messages: an update of the storage waiting for another tab to
      // close, and this page being left behind after another tab updated it.
      onBlocked: () => showDatabaseNotice(root, "blocked"),
      onVersionChange: () => showDatabaseNotice(root, "versionchange"),
    });
    const store = createStore(adapter);
    await store.open();
    await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
    // The offline copy needs no database, so a problem with the service worker
    // can never keep the app itself from opening.
    const offline = createOffline();
    const persistence = {
      getStatus: () => store.getPersistStatus(),
      check: () => checkPersistence({ request: requestPersistentStorage, store }),
    };
    const backup = createBackup(adapter);
    // The exercise library. Checked and, on the first launch, stored only after the first paint; never awaited
    // here, and it never rejects (src/app/catalog.js).
    const catalog = createCatalogService({ catalogStore: createCatalogStore(adapter) });
    // Runs before the UI reads any export time. A failure only means it is tried
    // again next launch; it never keeps the app from opening.
    await backup.migrateExportConfirmation().catch(() => {});
    const logger = createLogger(store);
    const app = await mountApp(root, {
      logger,
      backup: resyncAfterImport(backup, catalog), // an import deletes the library flag, so it is checked again
      downloadBlob,
      readFileAsText,
      persistence,
      offline,
      catalog,
      strongImport: { readContext: () => readImportContext(adapter) }, // read only; the Strong import writes nothing yet
    });
    catalog.onChange(() => app.renderInBackground()); // the picker's note and list follow the library
    startAfterFirstPaint(() => catalog.ensureCurrent());
    offline.start().catch(() => {}); // registers the worker (see shouldRegister) and watches for updates
    installPullToRefresh({ offline, logger }); // pull down at the top of the page to check for an update
    // Asked on every launch and not awaited: a browser prompt must never hold up
    // the app. When the answer is stored, the open tab is redrawn to show it.
    persistence.check().then(() => app.renderInBackground(), () => {});
  } catch (error) {
    root.replaceChildren(
      h("h1", {}, "Apogee"),
      h("p", { class: "error", role: "alert" }, `Apogee could not open its database: ${error.message}`),
    );
  }
}

start();
