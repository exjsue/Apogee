// Starts the real app: opens the database, adds the built-in exercises and
// mounts the UI. Everything here is local; nothing is requested over a network.

import { h } from "./dom.js";
import { mountApp } from "./app.js";
import { createIdbAdapter, requestPersistentStorage } from "../storage/idb-adapter.js";
import { APP_DB_NAME } from "../storage/schema.js";
import { createStore } from "../storage/store.js";
import { createBackup } from "../backup/backup.js";
import { downloadBlob, readFileAsText } from "../backup/download.js";
import { createLogger } from "../app/logger.js";
import { createOffline } from "../app/offline.js";
import { checkPersistence } from "../app/persistence.js";
import { SEED_EXERCISES, SEED_VERSION } from "../domain/seed.js";

const root = document.getElementById("app");

async function start() {
  try {
    const adapter = createIdbAdapter({ name: APP_DB_NAME });
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
    // Runs before the UI reads any export time. A failure only means it is tried
    // again next launch; it never keeps the app from opening.
    await backup.migrateExportConfirmation().catch(() => {});
    const app = await mountApp(root, {
      logger: createLogger(store),
      backup,
      downloadBlob,
      readFileAsText,
      persistence,
      offline,
    });
    offline.start().catch(() => {}); // registers the worker (see shouldRegister) and watches for updates
    // Asked on every launch and not awaited: a browser prompt must never hold up
    // the app. When the answer is stored, the open tab is redrawn to show it.
    persistence.check().then(() => app.render(), () => {});
  } catch (error) {
    root.replaceChildren(
      h("h1", {}, "GymApp"),
      h("p", { class: "error", role: "alert" }, `GymApp could not open its database: ${error.message}`),
    );
  }
}

start();
