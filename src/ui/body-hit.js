// Which muscle a tap on the Body diagram belongs to, decided by geometry and not by which element is on top in the
// page. Pure JavaScript: no DOM. The tap comes in as a point in the diagram's own coordinates (the 200 x 400 box of
// src/ui/body-regions.js); body-view.js converts a screen tap with the SVG's own transform.
//
// The rule (the owner's decision): among the hit shapes that contain the point, the SMALLER one wins, so a small muscle
// can be tapped inside the larger hit area of its neighbour. Shapes whose areas are equal, or within TIE_TOLERANCE of
// the smallest one (relative), are a tie, and then the shape whose centre is nearest the tap wins; if that is equal
// too, the muscle id that sorts first wins, so the answer never depends on the order of the data.

export const TIE_TOLERANCE = 0.02;

// Does the shape (an ellipse, or one half of one) contain the point?
export function shapeContains(shape, [x, y]) {
  const turn = (-shape.rot * Math.PI) / 180;
  const [dx0, dy0] = [x - shape.cx, y - shape.cy];
  const dx = dx0 * Math.cos(turn) - dy0 * Math.sin(turn);
  const dy = dx0 * Math.sin(turn) + dy0 * Math.cos(turn);
  if (shape.type === "half" && (shape.face === "right" ? dx < 0 : dx > 0)) return false;
  return (dx / shape.rx) ** 2 + (dy / shape.ry) ** 2 <= 1;
}

const areaOf = (shape) => Math.PI * shape.rx * shape.ry * (shape.type === "half" ? 0.5 : 1);

// regions: BODY_REGIONS[view].regions. Returns a muscle id, or null when the point is in no hit shape.
export function resolveTap(regions, point, tolerance = TIE_TOLERANCE) {
  const hits = [];
  for (const { muscle, shapes } of regions) {
    for (const shape of shapes) {
      const hit = { ...shape, ...shape.hit }; // the larger transparent shape, as body-diagram.js draws it
      if (shapeContains(hit, point)) hits.push({ muscle, area: areaOf(hit), distance: Math.hypot(point[0] - hit.cx, point[1] - hit.cy) });
    }
  }
  if (hits.length === 0) return null;
  const smallest = Math.min(...hits.map((hit) => hit.area));
  const tied = hits.filter((hit) => hit.area <= smallest * (1 + tolerance));
  tied.sort((a, b) => a.distance - b.distance || (a.muscle < b.muscle ? -1 : a.muscle > b.muscle ? 1 : 0));
  return tied[0].muscle;
}
