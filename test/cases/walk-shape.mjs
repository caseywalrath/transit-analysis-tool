// Golden cases for WalkShape.selfIntersects (js/core/walk-shape.js): the
// grid-bucketed replacement for turf.kinks used to validate smoothed outlines.
// Only this function is pure (no turf); refine/contour need turf and are
// covered by test/browser/walkshed-shape.test.mjs and walkshed-contour.test.mjs.

const poly = (rings) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } });
const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

export default {
  scripts: ["js/core/walk-shape.js"],
  cases: [
    { id: "selfIntersects/square-false", call: "WalkShape.selfIntersects", args: [poly([square])] },
    { id: "selfIntersects/bowtie-true", call: "WalkShape.selfIntersects",
      args: [poly([[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]])] },
    { id: "selfIntersects/square-with-inner-hole-false", call: "WalkShape.selfIntersects",
      args: [poly([square, [[0.25, 0.25], [0.25, 0.75], [0.75, 0.75], [0.75, 0.25], [0.25, 0.25]]])] },
    { id: "selfIntersects/hole-crossing-shell-true", call: "WalkShape.selfIntersects",
      args: [poly([square, [[0.5, 0.5], [0.5, 1.5], [0.8, 1.5], [0.8, 0.5], [0.5, 0.5]]])] },
    { id: "selfIntersects/ring-touching-itself-true", call: "WalkShape.selfIntersects",
      args: [poly([[[0, 0], [2, 0], [2, 2], [1, 0], [0, 2], [0, 0]]])] },
    { id: "selfIntersects/many-vertex-circle-false", call: "WalkShape.selfIntersects",
      args: [poly([Array.from({ length: 401 }, (_, i) => { const a = (i % 400) / 400 * 2 * Math.PI; return [Math.cos(a), Math.sin(a)]; })])] },
    { id: "selfIntersects/null-geometry-false", call: "WalkShape.selfIntersects", args: [{ type: "Feature", properties: {}, geometry: null }] },
  ],
};
