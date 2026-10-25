// The Body diagram: an SVG drawn from the region data (body-regions.js) and a value map { muscleId: number }.
// It knows nothing about workouts or exercises. The value map must already have the neck folded into the traps
// (foldNeckIntoTraps); the diagram has no neck region.
//
// Shading is by CSS class: each muscle group gets "level-0" to "level-5" (intensityStep), and app.css gives each
// level its fill. No inline styles, no numbers and no labels on the diagram.
//
// The SVG is cloned from the template in index.html, as the rest icon is: creating SVG elements from script
// needs the SVG namespace URL, and the page scan allows no URLs, so the namespace is read from the cloned element.

import { BODY_REGIONS, VIEW_BOX } from "./body-regions.js";
import { intensityStep } from "../domain/body-display.js";
import { formatLabel } from "../domain/format.js";

// The value that gets the darkest shade, when the caller gives none. Step 4 passes a fixed reference (the top of the
// target range), never the map's own maximum.
export const DEFAULT_REFERENCE = 10;

export const INTENSITY_WORDS = Object.freeze(["none", "very low", "low", "medium", "high", "very high"]);

const hasTemplate = () => document.getElementById("body-diagram-template") !== null;

function halfPath({ cx, cy, rx, ry, face }) {
  return `M ${cx} ${cy - ry} A ${rx} ${ry} 0 0 ${face === "right" ? 1 : 0} ${cx} ${cy + ry} Z`;
}

function makeShape(ns, shape, className) {
  const element = document.createElementNS(ns, shape.type === "ellipse" ? "ellipse" : "path");
  if (shape.type === "path") {
    element.setAttribute("d", shape.d);
  } else if (shape.type === "half") {
    element.setAttribute("d", halfPath(shape));
  } else {
    for (const name of ["cx", "cy", "rx", "ry"]) element.setAttribute(name, String(shape[name]));
  }
  if (shape.rot) element.setAttribute("transform", `rotate(${shape.rot} ${shape.cx} ${shape.cy})`);
  element.setAttribute("class", className);
  return element;
}

// What each muscle on `view` is shown as, for the diagram's shading and for its text list.
export function intensityLines({ values, view, max = DEFAULT_REFERENCE }) {
  return BODY_REGIONS[view].regions.map(({ muscle }) => {
    const step = intensityStep(values[muscle] ?? 0, max);
    return { muscle, label: formatLabel(muscle), step, word: INTENSITY_WORDS[step] };
  });
}

// Returns the svg, or null if the page has no template for it (the caller then shows the text list alone).
export function renderBodyDiagram({ values, view, max = DEFAULT_REFERENCE, label }) {
  if (!hasTemplate() || BODY_REGIONS[view] === undefined) return null;
  const svg = document.getElementById("body-diagram-template").content.firstElementChild.cloneNode(true);
  const ns = svg.namespaceURI;
  svg.setAttribute("viewBox", `0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("data-view", view);

  const silhouette = document.createElementNS(ns, "g");
  silhouette.setAttribute("class", "silhouette");
  for (const shape of BODY_REGIONS[view].silhouette) silhouette.append(makeShape(ns, shape, "outline"));
  svg.append(silhouette);

  const steps = new Map(intensityLines({ values, view, max }).map(({ muscle, step }) => [muscle, step]));
  for (const { muscle, shapes } of BODY_REGIONS[view].regions) {
    const group = document.createElementNS(ns, "g");
    group.setAttribute("class", `muscle level-${steps.get(muscle)}`);
    group.setAttribute("data-muscle", muscle);
    for (const shape of shapes) group.append(makeShape(ns, shape, "shape"));
    for (const shape of shapes) group.append(makeShape(ns, { ...shape, ...shape.hit }, "hit")); // after the shapes, so it is on top
    svg.append(group);
  }
  return svg;
}
