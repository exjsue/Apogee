// Minimal element builder for the UI. Text is always added as a text node, so
// user-supplied strings (exercise names, notes) can never become markup.
// Inline styles are refused: the page's policy forbids them, so use a class.

const PROPERTIES = new Set(["value", "checked", "disabled", "hidden", "selected"]);

function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// h("button", { class: "primary", onClick: handler }, "Save")
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "style") throw new Error("Inline styles are not allowed; use a CSS class");
    if (name === "class") element.className = value;
    else if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (PROPERTIES.has(name)) element[name] = value;
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  appendChildren(element, children);
  return element;
}

// A button that does not submit forms.
export function button(label, props = {}) {
  return h("button", { type: "button", ...props }, label);
}

// An exercise's name as a heading, with a small "Custom" marker when markCustom is set (the logger sets it
// only when a custom exercise shares its name with another stored exercise).
export function exerciseHeading(name, markCustom) {
  return h("h3", {}, name, markCustom ? [" ", h("span", { class: "name-mark" }, "Custom")] : null);
}

// The "3." or "W." that starts a set's line in a list: the set's number among the working sets, or a light-blue W
// for a warm-up (read aloud as "Warm-up set"). `number` is null for a warm-up (see setNumbers).
export function setMark(number) {
  if (number !== null) return `${number}.`;
  return [
    h("span", { class: "warmup-mark", "data-region": "warmup", "aria-hidden": "true" }, "W"),
    h("span", { class: "visually-hidden" }, "Warm-up set"),
    ".",
  ];
}
