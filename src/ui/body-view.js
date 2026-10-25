// The Body tab: a placeholder for now. It reads no data.

import { h } from "./dom.js";

export async function renderBodyView() {
  return h(
    "section",
    { class: "view", "aria-label": "Body" },
    h("h2", {}, "Body"),
    h("p", { class: "muted" }, "Your muscle diagram will appear here."),
  );
}
