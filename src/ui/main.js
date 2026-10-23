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
import { SEED_EXERCISES, SEED_VERSION } from "../domain/seed.js";

const root = document.getElementById("app");

async function start() {
  try {
    const adapter = createIdbAdapter({ name: APP_DB_NAME });
    const store = createStore(adapter);
    await store.open();
    await store.seedExercises(SEED_EXERCISES, SEED_VERSION);
    await mountApp(root, {
      logger: createLogger(store),
      backup: createBackup(adapter),
      downloadBlob,
      readFileAsText,
      requestPersistentStorage,
    });
  } catch (error) {
    root.replaceChildren(
      h("h1", {}, "GymApp"),
      h("p", { class: "error", role: "alert" }, `GymApp could not open its database: ${error.message}`),
    );
  }
}

start();
