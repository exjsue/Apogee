// The elapsed time of the open workout, shown in the Current workout card. Display only: it is
// worked out from the workout's start and the clock on every tick (never by counting ticks, so it
// is right after the app sat in the background), and it changes the text of one element and
// nothing else, so a field being typed in, the focus and an open edit form are not touched.
// Nothing here is stored or exported.

import { h } from "./dom.js";
import { formatElapsed } from "../domain/format.js";

// A plain element, not a live region: a value that changes every second would be read out every second.
export function elapsedElement(startedAt) {
  const startMs = Date.parse(startedAt);
  const element = h("span", { class: "elapsed", role: "timer", "aria-live": "off", "data-region": "elapsed" });
  element.textContent = Number.isNaN(startMs) ? "" : formatElapsed(startMs, Date.now());
  return element;
}

export function stopElapsed(ctx) {
  if (typeof ctx.state.log.stopElapsed === "function") ctx.state.log.stopElapsed();
}

// Updates `element` once a second while it is on the page, and when the page becomes visible again.
// Stopped by stopElapsed (a new drawing, leaving the tab, an import) or when the element is gone.
export function startElapsed(ctx, element, startedAt) {
  stopElapsed(ctx);
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return;
  function update() {
    if (!element.isConnected) {
      stop();
      return;
    }
    const text = formatElapsed(startMs, Date.now());
    if (element.textContent !== text) element.textContent = text;
  }
  const onVisible = () => {
    if (document.visibilityState === "visible") update();
  };
  const interval = setInterval(update, 1000);
  document.addEventListener("visibilitychange", onVisible);
  function stop() {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    if (ctx.state.log.stopElapsed === stop) ctx.state.log.stopElapsed = null;
  }
  ctx.state.log.stopElapsed = stop;
}
