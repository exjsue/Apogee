// Notices about the database itself, shown above everything else on the page.
// They are not part of a tab, because they happen while the app is starting or
// after the connection to the database was closed.
//
//   blocked        another Apogee tab or window still has the database open, so the
//                  update of its storage cannot start yet. The page carries on by
//                  itself as soon as the other one closes.
//   versionchange  another tab updated the database. This page closed its connection
//                  so that update could go on; it must be reloaded to carry on.

import { h, button } from "./dom.js";

export const DATABASE_MESSAGES = {
  blocked:
    "Apogee is waiting for another Apogee tab or window to close so it can update its storage. "
    + "Close the other ones; this page carries on by itself.",
  versionchange:
    "Apogee was updated in another tab. Reload this page to keep using it. Your workouts are not affected.",
};

// Puts the notice at the top of `root`, replacing an earlier one. `reload` is a
// parameter only so a test can look at the button without leaving the page.
export function showDatabaseNotice(root, kind, { reload = () => globalThis.location.reload() } = {}) {
  if (!(kind in DATABASE_MESSAGES)) throw new Error(`unknown notice: ${kind}`);
  const earlier = root.querySelector('[data-region="database-notice"]');
  if (earlier !== null) earlier.remove();
  const notice = h(
    "div",
    { class: "banner", role: "status", "data-region": "database-notice", "data-kind": kind },
    h("span", {}, DATABASE_MESSAGES[kind]),
    kind === "versionchange" ? button("Reload", { class: "small primary", "data-action": "reload-database", onClick: reload }) : null,
  );
  root.prepend(notice);
  return notice;
}
