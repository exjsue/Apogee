// The Body diagram's regions, as data: for each view a faint silhouette and the muscle regions drawn over it.
// Nothing here touches the DOM, so tests can read it as it is. Drawn by src/ui/body-diagram.js.
//
// Coordinates are in a 200 x 400 box with the body's centre line at x = 100. A region is
//   { muscle: id from the muscle vocabulary, shapes: [shape, shape] }
// and has two shapes, the same muscle on the left and on the right of the body (the second is the mirror of the
// first, made by pair() below). A shape is one of
//   { type: "ellipse", cx, cy, rx, ry, rot, hit: { rx, ry } }
//   { type: "half", cx, cy, rx, ry, rot, face: "left" | "right", hit: { rx, ry } }
//     the half of the ellipse on that side of its vertical axis (before rot); used to split the shoulder circle
// rot is in degrees, clockwise, about (cx, cy). hit is the size of the larger transparent shape that is drawn
// over the visible one, with the same centre, rotation and face, so that a small muscle is easy to tap.
// The neck has no region: its value is added to the traps by foldNeckIntoTraps (src/domain/body-display.js).

export const VIEW_BOX = Object.freeze({ width: 200, height: 400 });
export const CENTER_X = 100;
export const VIEWS = Object.freeze(["front", "back"]);

const flip = (face) => (face === "left" ? "right" : "left");
const mirror = (shape) => ({
  ...shape,
  cx: 2 * CENTER_X - shape.cx,
  rot: shape.rot === 0 ? 0 : -shape.rot,
  ...(shape.face === undefined ? {} : { face: flip(shape.face) }),
});
const withHit = (shape, pad, min) => ({ ...shape, hit: { rx: Math.max(shape.rx + pad, min), ry: Math.max(shape.ry + pad, min) } });
const ellipse = (cx, cy, rx, ry, rot = 0) => ({ type: "ellipse", cx, cy, rx, ry, rot });
const half = (cx, cy, r, face) => ({ type: "half", cx, cy, rx: r, ry: r, rot: 0, face });

// The shape given (the left of the body) and its mirror. A half gets a smaller margin: its hit area is a half too.
const pair = (shape) => {
  const hit = withHit(shape, shape.type === "half" ? 4 : 5, shape.type === "half" ? 12 : 11);
  return [hit, mirror(hit)];
};
const region = (muscle, shape) => ({ muscle, shapes: pair(shape) });

// The silhouette is only a faint outline behind the muscles: it has no hit areas and is not a region.
const body = (torso) => [
  ellipse(100, 28, 14, 18),
  ellipse(100, 52, 7, 9),
  { type: "path", d: torso },
  ...[ellipse(52, 108, 10, 22, 6), ellipse(44, 155, 8, 25, 8), ellipse(40, 188, 6, 9, 8), ellipse(81, 255, 17, 55, -2), ellipse(80, 340, 11, 38), ellipse(78, 388, 10, 6)]
    .flatMap((shape) => [shape, mirror(shape)]),
];
const TORSO = "M66 72 Q100 62 134 72 L128 130 Q126 165 124 200 L76 200 Q74 165 72 130 Z";

// The shoulder circle on the front view is split in half: the inner half (towards the body) is the front delt, the
// outer half the side delt. Left shoulder: its inner half faces right.
const SHOULDER = { cx: 62, cy: 78, r: 12 };

export const BODY_REGIONS = Object.freeze({
  front: {
    silhouette: body(TORSO),
    regions: [
      region("chest", ellipse(83, 96, 16, 12, 10)),
      region("front_delts", half(SHOULDER.cx, SHOULDER.cy, SHOULDER.r, "right")),
      region("side_delts", half(SHOULDER.cx, SHOULDER.cy, SHOULDER.r, "left")),
      region("biceps", ellipse(52, 108, 7, 17, 6)),
      region("forearms", ellipse(45, 153, 6.5, 21, 8)),
      region("abs", ellipse(93, 130, 7, 24)),
      region("obliques", ellipse(77, 138, 6, 18)),
      region("quads", ellipse(81, 252, 12, 42)),
      region("adductors", ellipse(95, 225, 4, 24)),
      region("abductors", ellipse(65, 208, 5, 15)),
      region("calves", ellipse(80, 338, 8, 26)),
    ],
  },
  back: {
    silhouette: body(TORSO),
    regions: [
      region("traps", ellipse(86, 78, 13, 9, -15)),
      region("rear_delts", ellipse(62, 80, 11, 11)),
      region("upper_back", ellipse(89, 105, 11, 13)),
      region("lats", ellipse(80, 135, 11, 24, -12)),
      region("triceps", ellipse(52, 108, 7, 17, 6)),
      region("forearms", ellipse(45, 153, 6.5, 21, 8)),
      region("lower_back", ellipse(92, 172, 8, 13)),
      region("glutes", ellipse(87, 215, 12, 15)),
      region("hamstrings", ellipse(82, 262, 13, 36)),
      region("abductors", ellipse(69, 203, 6, 9)),
      region("calves", ellipse(80, 340, 9, 26)),
    ],
  },
});
