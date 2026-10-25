// The Body diagram: an SVG drawn from the region data (body-regions.js) and a value map { muscleId: number }.
// It knows nothing about workouts or exercises. The value map must already have the neck folded into the traps
// (foldNeckIntoTraps); the diagram has no neck region.
//
// Shading is by CSS class: each muscle group gets "level-0" to "level-5" (intensityStep), and app.css gives each
// level its fill. No inline styles, no numbers and no labels on the diagram.
//
// Two markers, both decided by the caller (src/domain/body-status.js); the diagram only draws them:
//   neglected  the group gets the class "neglected", and app.css draws a dashed outline on its shapes
//   above      the group gets the class "above" and one "above-ring" per visible shape: an unfilled solid ring RING_OFFSET
//              outside it (a half ring for a half). A ring is used, not an outline, because an above-target muscle is
//              always the darkest shade, and an outline in the same colour as that fill would hardly show. A ring is
//              not a ".shape" and sits below the hit shapes, so it never takes a tap.
//
// The SVG is cloned from the template in index.html, as the rest icon is: creating SVG elements from script
// needs the SVG namespace URL, and the page scan allows no URLs, so the namespace is read from the cloned element.

import { BODY_REGIONS, VIEW_BOX } from "./body-regions.js";
import { intensityStep } from "../domain/body-display.js";
import { formatLabel } from "../domain/format.js";
import { NEGLECTED_WEEKS } from "../domain/body-status.js";

export const INTENSITY_WORDS = Object.freeze(["none", "very low", "low", "medium", "high", "very high"]);

// How far outside its muscle an above-target ring is drawn, in the diagram's units (the box is 200 wide).
export const RING_OFFSET = 3;

const hasTemplate = () => document.getElementById("body-diagram-template") !== null;

function halfPath({ cx, cy, rx, ry, face }, closed = true) {
  return `M ${cx} ${cy - ry} A ${rx} ${ry} 0 0 ${face === "right" ? 1 : 0} ${cx} ${cy + ry}${closed ? " Z" : ""}`;
}

// A ring around a shape: the same centre and rotation, RING_OFFSET larger. A half ring is only the arc, not the flat edge.
const ringOf = (shape) => ({ ...shape, rx: shape.rx + RING_OFFSET, ry: shape.ry + RING_OFFSET, ring: true });

function makeShape(ns, shape, className) {
  const element = document.createElementNS(ns, shape.type === "ellipse" ? "ellipse" : "path");
  if (shape.type === "path") {
    element.setAttribute("d", shape.d);
  } else if (shape.type === "half") {
    element.setAttribute("d", halfPath(shape, shape.ring !== true));
  } else {
    for (const name of ["cx", "cy", "rx", "ry"]) element.setAttribute(name, String(shape[name]));
  }
  if (shape.rot) element.setAttribute("transform", `rotate(${shape.rot} ${shape.cx} ${shape.cy})`);
  element.setAttribute("class", className);
  return element;
}

// What each muscle on `view` is shown as, for the diagram's shading and for its text list. `max` is the value that gets
// the darkest shade: a fixed reference from the caller, never the largest value in the map. `neglected` and `above`
// are Sets of muscle ids. The word is the shade, then ", above target" and ", not trained in N weeks" where they
// apply, so the markers are never colour alone.
export function intensityLines({ values, view, max, neglected = new Set(), above = new Set() }) {
  return BODY_REGIONS[view].regions.map(({ muscle }) => {
    const step = intensityStep(values[muscle] ?? 0, max);
    const word = `${INTENSITY_WORDS[step]}${above.has(muscle) ? ", above target" : ""}${neglected.has(muscle) ? `, not trained in ${NEGLECTED_WEEKS} weeks` : ""}`;
    return { muscle, label: formatLabel(muscle), step, word };
  });
}

// Returns the svg, or null if the page has no template for it (the caller then shows the text list alone).
export function renderBodyDiagram({ values, view, max, label, neglected = new Set(), above = new Set() }) {
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
    group.setAttribute("class", `muscle level-${steps.get(muscle)}${neglected.has(muscle) ? " neglected" : ""}${above.has(muscle) ? " above" : ""}`);
    group.setAttribute("data-muscle", muscle);
    for (const shape of shapes) group.append(makeShape(ns, shape, "shape"));
    if (above.has(muscle)) for (const shape of shapes) group.append(makeShape(ns, ringOf(shape), "above-ring"));
    for (const shape of shapes) group.append(makeShape(ns, { ...shape, ...shape.hit }, "hit")); // last, so it is on top
    svg.append(group);
  }
  return svg;
}
