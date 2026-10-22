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
