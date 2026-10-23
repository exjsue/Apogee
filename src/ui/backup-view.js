// The Backup tab: export, import and storage. Builds elements and calls the
// backup module; file parsing, validation and the replace itself happen there.

import { h, button } from "./dom.js";
import { inspectBackup } from "../backup/backup.js";
import { formatDateTime, formatCount } from "../domain/format.js";

export const freshBackupState = () => ({
  exportText: null,
  importText: "",
  previewText: null,
  preview: null,
  error: null,
  notice: null,
  persistResult: null,
});

// What the import preview counts. "exercises" is the library of exercises you
// can choose from (the built-in lifts plus your own), not the exercises done in
// workouts, so the label says so. The per-workout "entries" count is left out:
// it is an internal grouping, and workouts and sets logged say what matters.
const SECTIONS = [
  ["exercises", "Exercise library (includes the built-in lifts)"],
  ["workouts", "Workouts"],
  ["sets", "Sets logged"],
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
  const { backup, downloadBlob, readFileAsText, requestPersistentStorage } = ctx.services;
  const view = h("section", { class: "view", "aria-label": "Backup" });

  if (b.notice) {
    view.append(h("p", { class: "notice", role: "status", "data-region": "notice" }, b.notice));
    b.notice = null;
  }
  if (b.error) {
    view.append(h("p", { class: "error", role: "alert", "data-region": "view-error" }, b.error));
    b.error = null;
  }

  async function downloadExport() {
    try {
      const { blob, filename } = await backup.exportForDownload();
      downloadBlob(blob, filename);
      b.notice = `Export file generated: ${filename}. Check where your browser saved it.`;
    } catch (error) {
      b.error = error.message;
    }
    await ctx.rerender();
  }

  // ---- export ----
  const lastExportAt = await backup.getLastExportAt();
  const exportCard = h(
    "section",
    { class: "card", "aria-label": "Export" },
    h("h2", {}, "Export"),
    h(
      "p",
      { class: "warning-text", "data-region": "export-warning" },
      "The export file is not encrypted. Anyone who gets the file can read all of your workout data. "
      + "GymApp cannot control where your browser or phone saves the file, or who can open it. Keep it somewhere private.",
    ),
    h(
      "p",
      { class: "muted", "data-region": "last-export" },
      lastExportAt === null
        ? "You have not generated an export yet."
        : `Last export generated: ${formatDateTime(lastExportAt)}. GymApp cannot tell whether you saved the file.`,
    ),
    h(
      "div",
      { class: "actions" },
      button("Download export file", { class: "primary", "data-action": "download-export", onClick: downloadExport }),
      button("Show export as text", {
        "data-action": "show-export-text",
        onClick: async () => {
          try {
            b.exportText = await backup.exportToText();
          } catch (error) {
            b.error = error.message;
          }
          await ctx.rerender();
        },
      }),
    ),
  );
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
    rows: 5, "data-field": "import-text", spellcheck: "false", "aria-label": "Export text to import",
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
          b.notice = `Imported ${formatCount(counts.workouts, "workout")} and ${formatCount(counts.sets, "logged set")}, with an exercise library of ${counts.exercises}. Everything else was replaced.`;
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
  const persistLine = h("p", { class: "muted", role: "status", "data-region": "persist-result" }, b.persistResult ?? "");
  view.append(h(
    "section",
    { class: "card", "aria-label": "Storage" },
    h("h2", {}, "Storage"),
    h(
      "p",
      {},
      "Your data is stored only in this browser. Browsers may delete it when space runs low or after a period of not using the site. "
      + "You can ask the browser to keep it, but it may refuse, so export regularly.",
    ),
    button("Ask the browser to keep my data", {
      "data-action": "persist",
      onClick: async () => {
        const result = await requestPersistentStorage();
        if (!result.supported) b.persistResult = "This browser does not support asking. Export regularly.";
        else if (result.error) b.persistResult = `The browser reported an error: ${result.error}`;
        else if (result.persisted) b.persistResult = "The browser agreed to keep your data. Exporting is still a good idea.";
        else b.persistResult = "The browser did not promise to keep your data. Export regularly.";
        persistLine.textContent = b.persistResult;
      },
    }),
    persistLine,
  ));
  return view;
}
