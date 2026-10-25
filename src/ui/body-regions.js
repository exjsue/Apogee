// The Body diagram's regions, as data: for each view a head and the muscle regions. There is no body outline.
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

// The head (both views) and the pelvis (front view only) are one ellipse each, drawn for orientation only, below the
// muscles: they have no hit area and are not regions. The pelvis fills the gap between the abs and the thighs.
const HEAD = ellipse(100, 48, 13, 16);
const PELVIS = ellipse(100, 184, 19, 26);

// The shoulder circle on the front view is split in half: the inner half (towards the body) is the front delt, the
// outer half the side delt. Left shoulder: its inner half faces right.
const SHOULDER = { cx: 60, cy: 80, r: 12 };

// Ellipses only: the V of the torso comes from the tilt of the chest, obliques and lats, the hanging arms from the tilt
// of the upper arm and forearm, the tapered legs from a slight inward tilt.
export const BODY_REGIONS = Object.freeze({
  front: {
    head: HEAD,
    pelvis: PELVIS,
    regions: [
      region("chest", ellipse(84, 99, 15, 12, 10)),
      region("front_delts", half(SHOULDER.cx, SHOULDER.cy, SHOULDER.r, "right")),
      region("side_delts", half(SHOULDER.cx, SHOULDER.cy, SHOULDER.r, "left")),
      region("biceps", ellipse(52, 113, 6.5, 17, 8)),
      region("forearms", ellipse(43, 153, 6, 21, 14)),
      region("abs", ellipse(94, 138, 5.5, 22)),
      region("obliques", ellipse(82, 145, 5.5, 20, -8)),
      region("quads", ellipse(78, 252, 11, 45, -3)),
      region("adductors", ellipse(93, 230, 3.5, 22, 3)),
      region("abductors", ellipse(65, 203, 5, 14, 6)),
      region("calves", ellipse(78, 336, 7.5, 26, -2)),
    ],
  },
  back: {
    head: HEAD,
    regions: [
      region("traps", ellipse(84, 78, 12, 8.5, -18)),
      region("rear_delts", ellipse(59, 82, 11, 11)),
      region("upper_back", ellipse(92, 106, 7, 11)),
      region("lats", ellipse(80, 138, 10, 26, -12)),
      region("triceps", ellipse(52, 113, 6.5, 17, 8)),
      region("forearms", ellipse(43, 153, 6, 21, 14)),
      region("lower_back", ellipse(93, 177, 6, 13)),
      region("glutes", ellipse(87, 215, 12.5, 15)),
      region("hamstrings", ellipse(80, 268, 10, 34, -3)),
      region("abductors", ellipse(66, 203, 5, 9)),
      region("calves", ellipse(78, 335, 8, 26, -2)),
    ],
  },
});
