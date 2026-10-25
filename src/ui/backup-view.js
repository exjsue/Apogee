// The Backup tab: export, import and storage. Builds elements and calls the
// backup module; file parsing, validation and the replace itself happen there.

import { h, button } from "./dom.js";
import { inspectBackup } from "../backup/backup.js";
import { describePersistence } from "../app/persistence.js";
import { formatDateTime, formatCount } from "../domain/format.js";

export const freshBackupState = () => ({
  exportText: null,
  // The export waiting for the user's "I saved the file" tap: { exportedAt } or null.
  pendingExport: null,
  importText: "",
  previewText: null,
  preview: null,
  error: null,
  notice: null,
  confirmReset: false,
});

// What the import preview counts. "exercises" is the library of exercises you
// can choose from (the built-in lifts plus your own), not the exercises done in
// workouts, so the label says so. The per-workout "entries" count is left out:
// it is an internal grouping, and workouts and sets logged say what matters. Templates are replaced too
// (a file from before schema 4 has none, which the preview says in words below the table).
const SECTIONS = [
  ["exercises", "Exercise library (includes the built-in lifts)"],
  ["workouts", "Workouts"],
  ["sets", "Sets logged"],
  ["templates", "Templates"],
];

function countsTable(file, current) {
  return h(
    "table",
    { class: "counts", "data-region": "import-counts" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "In the file"), h("th", {}, "On this device now"))),
    h(
      "tbody",
      {},
      SECTIONS.map(([key, label]) => h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, String(file[key])), h("td", {}, String(current[key])))),
    ),
  );
}

export async function renderBackupView(ctx) {
  const b = ctx.state.backup;
  const { backup, downloadBlob, readFileAsText, persistence } = ctx.services;
  const view = h("section", { class: "view", "aria-label": "Backup" });

  if (b.notice) {
    view.append(h("p", { class: "notice", role: "status", "data-region": "notice", "data-enter": `notice:${b.notice}` }, b.notice));
    b.notice = null;
  }
  if (b.error) {
    view.append(h("p", { class: "error", role: "alert", "data-region": "view-error", "data-enter": `view-error:${b.error}` }, b.error));
    b.error = null;
  }

  // Starting a download records an attempt only. The export counts as a backup
  // when the user taps "I saved the file" (confirmExport).
  async function downloadExport() {
    try {
      const { blob, filename, exportedAt } = await backup.exportForDownload();
      downloadBlob(blob, filename);
      b.pendingExport = { exportedAt };
      b.notice = `Export file started: ${filename}. Check where your browser saved it, then tap "I saved the file".`;
      await backup.recordExportAttempt(exportedAt);
    } catch (error) {
      b.error = error.message;
    }
    await ctx.rerender();
  }

  // ---- export ----
  const { lastExportAt, lastExportAttemptAt } = await backup.getExportTimes();
  const lastLine = lastExportAt === null
    ? "No export has been confirmed as saved yet."
    : `Last export confirmed as saved: ${formatDateTime(lastExportAt)}.`;
  const attemptLine = lastExportAttemptAt !== null && lastExportAttemptAt !== lastExportAt
    ? ` An export was started ${formatDateTime(lastExportAttemptAt)} but not confirmed.`
    : "";
  const exportCard = h(
    "section",
    { class: "card", "aria-label": "Export" },
    h("h2", {}, "Export"),
    h(
      "p",
      { class: "warning-text", "data-region": "export-warning" },
      "The export file is not encrypted. Anyone who gets the file can read all of your workout data. "
      + "Apogee cannot control where your browser or phone saves the file, or who can open it. Keep it somewhere private.",
    ),
    h(
      "p",
      { class: "muted", "data-region": "last-export" },
      `${lastLine}${attemptLine} Apogee cannot see whether the file was saved; it counts an export only when you confirm.`,
    ),
    h(
      "div",
      { class: "actions" },
      button("Download export file", { class: "primary", "data-action": "download-export", onClick: downloadExport }),
      button("Show export as text", {
        "data-action": "show-export-text",
        onClick: async () => {
          try {
            const { text, exportedAt } = await backup.exportSnapshot();
            b.exportText = text;
            b.pendingExport = { exportedAt };
            await backup.recordExportAttempt(exportedAt);
          } catch (error) {
            b.error = error.message;
          }
          await ctx.rerender();
        },
      }),
    ),
  );
  if (b.pendingExport !== null) {
    exportCard.append(h(
      "div",
      { class: "confirm-saved", "data-region": "export-confirm" },
      h("p", {}, "Once you have saved the file (or kept the copied text), tap this:"),
      button("I saved the file", {
        class: "primary wide",
        "data-action": "confirm-export-saved",
        onClick: async () => {
          try {
            await backup.confirmExport(b.pendingExport.exportedAt);
            b.pendingExport = null;
            b.notice = "Recorded: your last export is confirmed as saved.";
          } catch (error) {
            b.error = error.message;
          }
          await ctx.rerender();
        },
      }),
    ));
  }
  if (b.exportText !== null) {
    const box = h("textarea", {
      readonly: true, rows: 8, "data-field": "export-text", "aria-label": "Export text", spellcheck: "false",
    });
    box.value = b.exportText;
    exportCard.append(
      h("p", { class: "muted" }, "If downloads do not work on your device, copy this text and save it in a file or a private note."),
      box,
      h(
        "div",
        { class: "actions" },
        button("Select all", { class: "small", "data-action": "select-export-text", onClick: () => { box.focus(); box.select(); } }),
        button("Copy", {
          class: "small",
          "data-action": "copy-export-text",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(box.value);
              b.notice = "Export text copied.";
            } catch {
              box.focus();
              box.select();
              b.notice = "Copying was blocked. The text is selected; copy it by hand.";
            }
            await ctx.rerender();
          },
        }),
      ),
    );
  }
  view.append(exportCard);

  // ---- import ----
  const previewRegion = h("div", { "data-region": "import-preview" });
  const textarea = h("textarea", {
    rows: 5, "data-field": "import-text", "data-saved": "", spellcheck: "false", "aria-label": "Export text to import",
  });
  textarea.value = b.importText;
  textarea.addEventListener("input", () => {
    b.importText = textarea.value;
    b.previewText = null;
    b.preview = null;
    previewRegion.replaceChildren(); // an edited text has not been checked
  });

  async function check(text) {
    try {
      const summary = inspectBackup(text);
      const current = await backup.currentCounts();
      b.previewText = text;
      b.preview = { summary, current };
      b.error = null;
    } catch (error) {
      b.previewText = null;
      b.preview = null;
      b.error = error.message;
    }
    await ctx.rerender();
  }

  const fileInput = h("input", {
    type: "file", accept: ".json,application/json,text/plain", "data-field": "import-file",
    onChange: async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        b.importText = await readFileAsText(file);
      } catch (error) {
        b.error = error.message;
        await ctx.rerender();
        return;
      }
      await check(b.importText);
    },
  });

  if (b.preview !== null) {
    const { summary, current } = b.preview;
    const confirmBox = h("input", { type: "checkbox", "data-field": "confirm-replace" });
    const confirmButton = button("Replace everything", {
      class: "danger", "data-action": "confirm-import", disabled: true,
      onClick: async () => {
        confirmButton.disabled = true;
        try {
          const counts = await backup.importFromText(b.previewText, { confirmReplace: true });
          b.notice = `Imported ${formatCount(counts.workouts, "workout")} and ${formatCount(counts.sets, "logged set")}. Everything else was replaced.`;
          b.importText = "";
          b.previewText = null;
          b.preview = null;
          ctx.resetAfterImport();
        } catch (error) {
          b.error = error.message;
        }
        await ctx.rerender();
      },
    });
    confirmBox.addEventListener("change", () => {
      confirmButton.disabled = !confirmBox.checked;
    });
    previewRegion.append(
      h("h3", {}, "This file will replace your data"),
      h("p", { class: "muted" }, `Exported ${formatDateTime(summary.exportedAt)}. Nothing is merged: everything on this device is replaced by the file.`),
      countsTable(summary.counts, current),
      summary.schemaVersion < 4
        ? h(
          "p",
          { class: "warning-text", "data-region": "import-no-templates" },
          "This file is from an older version of Apogee and has no templates. "
          + (current.templates > 0
            ? `Importing it removes your ${formatCount(current.templates, "saved template")}.`
            : "You have none saved either."),
        )
        : null,
      h(
        "p",
        { class: "warning-text" },
        "Your current data will be lost unless you have exported it. Export it first if you are not sure.",
      ),
      button("Export current data first", { "data-action": "export-first", onClick: downloadExport }),
      h("label", { class: "check" }, confirmBox, "I understand this replaces everything on this device."),
      confirmButton,
    );
  }

  view.append(h(
    "section",
    { class: "card", "aria-label": "Import" },
    h("h2", {}, "Import"),
    h("p", {}, "Importing replaces everything on this device with the contents of an export file. Nothing is merged."),
    h("label", { class: "field" }, h("span", {}, "Choose an export file"), fileInput),
    h("label", { class: "field" }, h("span", {}, "Or paste the export text"), textarea),
    button("Check file", {
      "data-action": "check-import",
      onClick: () => check(textarea.value),
    }),
    previewRegion,
  ));

  // ---- storage ----
  // The status comes from the last check stored on this device (run on every launch).
  const status = persistence ? await persistence.getStatus() : null;
  const described = describePersistence(status);
  const storageCard = h(
    "section",
    { class: "card", "aria-label": "Storage" },
    h("h2", {}, "Storage"),
    h("p", { role: "status", "data-region": "persist-status" }, h("strong", {}, described.label)),
    described.detail ? h("p", { class: "muted", "data-region": "persist-detail" }, described.detail) : null,
    h(
      "p",
      {},
      "Your data is stored only in this browser. Browsers may delete it when space runs low or after a period of not using the site. "
      + "Export regularly, whatever this status says.",
    ),
  );
  if (persistence) {
    storageCard.append(button("Ask the browser again", {
      "data-action": "persist",
      onClick: async () => {
        try {
          await persistence.check();
        } catch (error) {
          b.error = error.message;
        }
        await ctx.rerender();
      },
    }));
  }
  view.append(storageCard);

  // ---- offline ----
  if (ctx.services.offline) view.append(await offlineCard(ctx));
  return view;
}

// The Offline section: whether the app can start without a network, which
// version of it is stored, and a way to remove the stored copy. The reset only
// removes the app's files and worker; it never touches workouts or settings.
async function offlineCard(ctx) {
  const b = ctx.state.backup;
  const { offline } = ctx.services;
  const status = await offline.getStatus();

  let summary;
  if (!status.supported) summary = "Offline use is not available in this browser or mode.";
  else if (status.ready) summary = "Ready: the app can start without a network.";
  else if (!status.enabled && !status.registered) summary = "Switched off on this address. Add ?sw=1 to the address to turn it on.";
  else summary = "Not ready yet. Keep the app open while online for a moment, then look again.";

  const card = h(
    "section",
    { class: "card", "aria-label": "Offline" },
    h("h2", {}, "Offline"),
    h("p", { "data-region": "offline-status" }, summary),
    h(
      "p",
      { class: "muted", "data-region": "offline-version" },
      `Offline copy version: ${status.versionShort ?? "none"}`,
    ),
  );
  if (status.updateAvailable) {
    card.append(h("p", { "data-region": "offline-update" }, "An update is waiting. Use the Reload button at the top of the page to switch to it."));
  }
  if (status.error) card.append(h("p", { class: "error", role: "alert" }, status.error));

  if (!b.confirmReset) {
    card.append(h(
      "div",
      { class: "actions" },
      button("Reset offline copy", {
        "data-action": "reset-offline",
        onClick: () => {
          b.confirmReset = true;
          return ctx.rerender();
        },
      }),
    ));
    return card;
  }
  card.append(h(
    "div",
    { class: "confirm", role: "alertdialog", "aria-label": "Confirm reset", "data-region": "confirm-reset-offline", "data-enter": "confirm-reset-offline" },
    h(
      "p",
      {},
      "Remove the offline copy of the app from this device? Your workouts and settings are not affected. "
      + "To use the app offline again you will need to open it once while online.",
    ),
    button("Reset offline copy", {
      class: "danger",
      "data-action": "confirm-reset-offline",
      onClick: async () => {
        try {
          const result = await offline.resetOfflineCopy();
          b.notice = result.unregistered || result.cachesDeleted > 0
            ? "Offline copy removed. Reload the app while online to install it again."
            : "There was no offline copy to remove.";
        } catch (error) {
          b.error = error.message;
        }
        b.confirmReset = false;
        await ctx.rerender();
      },
    }),
    button("Cancel", {
      "data-action": "cancel-reset-offline",
      onClick: () => {
        b.confirmReset = false;
        return ctx.rerender();
      },
    }),
  ));
  return card;
}
