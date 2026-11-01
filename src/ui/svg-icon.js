// Line icons drawn for this app. All path data lives in SHAPES; nothing is fetched and nothing is hardcoded per screen.
// An icon is decoration: aria-hidden, not focusable, no text, colour from the surrounding text (currentColor).

// The SVG namespace, read from what the HTML parser gives an <svg> element, so no URL string sits in the source
// (the guard test refuses every http(s) URL under src/).
let svgNamespace = null;
const namespace = () => svgNamespace ??= new DOMParser().parseFromString("<svg></svg>", "text/html").body.firstChild.namespaceURI;

// One path per shape, on a 24 x 24 grid.
const SHAPES = {
  dumbbell: "M6 7v10M3.5 9.5v5M18 7v10M20.5 9.5v5M6 12h12",
  barbell: "M7 6v12M4 9v6M17 6v12M20 9v6M2 12h2M20 12h2M7 12h10",
  cable: "M9 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 11v6M9 17h6v3H9z",
  machine: "M4 21h16M6 21V4h3v17M9 8h8M17 8v6M14 14h6",
  kettlebell: "M9 9V7a3 3 0 0 1 6 0v2M12 9a6 6 0 0 0-5 9.5 1 1 0 0 0 .8.5h8.4a1 1 0 0 0 .8-.5A6 6 0 0 0 12 9z",
  bodyweight: "M9.5 5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12 9v6M7 11l5-2 5 2M9 21l3-6 3 6",
  resistance_band: "M3 12a9 5 0 1 0 18 0a9 5 0 1 0-18 0M3 9v6M21 9v6",
  foam_roll: "M5 8h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM7 8a2 4 0 0 0 0 8",
  medicine_ball: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  exercise_ball: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M5 8c4 2 10 2 14 0M5 16c4-2 10-2 14 0",
  trap_bar: "M8 5h8l4 7-4 7H8l-4-7zM2 12h2M20 12h2",
  other: "M5 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M17 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
  fallback: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0",
};

// Names that reuse another shape.
const ALIASES = { ez_bar: "barbell", smith_machine: "machine", pull_up_bar: "bodyweight" };

export const ICON_NAMES = [...Object.keys(SHAPES), ...Object.keys(ALIASES)];

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The path data for a name; an unknown name gets the fallback's.
export function iconShape(name) {
  const resolved = has(ALIASES, name) ? ALIASES[name] : name;
  return has(SHAPES, resolved) ? SHAPES[resolved] : SHAPES.fallback;
}

// The icon name for a catalog equipment value; null or an unknown value gets "fallback".
export function equipmentIcon(equipmentValue) {
  return ICON_NAMES.includes(equipmentValue) ? equipmentValue : "fallback";
}

// opts.size: width and height in px (default 24). opts.class: extra class names.
export function svgIcon(name, opts = {}) {
  const svg = document.createElementNS(namespace(), "svg");
  const size = String(opts.size ?? 24);
  const attributes = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: opts.class ? `icon ${opts.class}` : "icon",
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  const path = document.createElementNS(namespace(), "path");
  path.setAttribute("d", iconShape(name));
  svg.append(path);
  return svg;
}
