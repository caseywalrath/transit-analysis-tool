// Golden cases for the pure box-select hit-test helpers (js/core/box-select.js —
// docs/archive/box-select-plan.md Phase 1): App.boxSelectGeom. Screen-pixel coords,
// plain arrays only — no DOM, map or turf.

const R = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
const SQUARE = [[0, 0], [30, 0], [30, 30], [0, 30]];          // contains R entirely
const HOLE = [[5, 5], [25, 5], [25, 25], [5, 25]];            // hole contains R entirely
const PARTIAL = [[15, 15], [40, 15], [40, 40], [15, 40]];     // overlaps R's corner

export default {
  scripts: ["js/core/box-select.js"],
  cases: [
    { id: "normRect/ordered", call: "App.boxSelectGeom.normRect", args: [1, 2, 5, 9] },
    { id: "normRect/reversed-corners", call: "App.boxSelectGeom.normRect", args: [5, 9, 1, 2] },
    { id: "normRect/mixed-corners", call: "App.boxSelectGeom.normRect", args: [5, 2, 1, 9] },

    { id: "pointInRect/inside", call: "App.boxSelectGeom.pointInRect", args: [[15, 15], R] },
    { id: "pointInRect/outside", call: "App.boxSelectGeom.pointInRect", args: [[25, 15], R] },
    { id: "pointInRect/on-edge", call: "App.boxSelectGeom.pointInRect", args: [[10, 15], R] },
    { id: "pointInRect/on-corner", call: "App.boxSelectGeom.pointInRect", args: [[20, 20], R] },
    { id: "pointInRect/degenerate-rect-on-point", call: "App.boxSelectGeom.pointInRect", args: [[5, 5], { minX: 5, minY: 5, maxX: 5, maxY: 5 }] },

    { id: "segment/crosses-through", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[0, 15], [30, 15], R] },
    { id: "segment/misses-above", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[0, 5], [30, 5], R] },
    { id: "segment/diagonal-misses-corner", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[0, 15], [15, 0], R] },
    { id: "segment/touches-corner", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[0, 30], [30, 0], R] },
    { id: "segment/degenerate-inside", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[15, 15], [15, 15], R] },
    { id: "segment/degenerate-outside", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[50, 50], [50, 50], R] },
    { id: "segment/short-ends-before-box", call: "App.boxSelectGeom.segmentIntersectsRect", args: [[0, 15], [9, 15], R] },

    { id: "pointInRing/inside", call: "App.boxSelectGeom.pointInRing", args: [[15, 15], SQUARE] },
    { id: "pointInRing/outside", call: "App.boxSelectGeom.pointInRing", args: [[40, 15], SQUARE] },
    { id: "pointInRing/closed-ring-inside", call: "App.boxSelectGeom.pointInRing", args: [[15, 15], SQUARE.concat([SQUARE[0]])] },
    { id: "pointInRing/closed-ring-outside", call: "App.boxSelectGeom.pointInRing", args: [[40, 15], SQUARE.concat([SQUARE[0]])] },

    { id: "bboxOf/basic", call: "App.boxSelectGeom.bboxOf", args: [[[3, 7], [-2, 4], [9, 0]]] },
    { id: "bboxOf/empty", call: "App.boxSelectGeom.bboxOf", args: [[]] },
    { id: "bboxIntersects/overlap", call: "App.boxSelectGeom.bboxIntersectsRect", args: [{ minX: 0, minY: 0, maxX: 12, maxY: 12 }, R] },
    { id: "bboxIntersects/touching-edge", call: "App.boxSelectGeom.bboxIntersectsRect", args: [{ minX: 20, minY: 0, maxX: 30, maxY: 12 }, R] },
    { id: "bboxIntersects/apart", call: "App.boxSelectGeom.bboxIntersectsRect", args: [{ minX: 21, minY: 0, maxX: 30, maxY: 12 }, R] },
    { id: "bboxIntersects/null", call: "App.boxSelectGeom.bboxIntersectsRect", args: [null, R] },

    // ---- lines ----
    { id: "line/crossing-no-vertex-inside-touch", call: "App.boxSelectGeom.lineHits", args: [[[0, 15], [30, 15]], R, "touch"] },
    { id: "line/crossing-no-vertex-inside-within", call: "App.boxSelectGeom.lineHits", args: [[[0, 15], [30, 15]], R, "within"] },
    { id: "line/entirely-inside-touch", call: "App.boxSelectGeom.lineHits", args: [[[12, 12], [18, 18]], R, "touch"] },
    { id: "line/entirely-inside-within", call: "App.boxSelectGeom.lineHits", args: [[[12, 12], [18, 18]], R, "within"] },
    { id: "line/outside-but-bbox-overlaps-touch", call: "App.boxSelectGeom.lineHits", args: [[[0, 15], [15, 0]], R, "touch"] },
    { id: "line/outside-but-bbox-overlaps-within", call: "App.boxSelectGeom.lineHits", args: [[[0, 15], [15, 0]], R, "within"] },
    { id: "line/one-vertex-inside-touch", call: "App.boxSelectGeom.lineHits", args: [[[15, 15], [50, 50]], R, "touch"] },
    { id: "line/one-vertex-inside-within", call: "App.boxSelectGeom.lineHits", args: [[[15, 15], [50, 50]], R, "within"] },
    { id: "line/empty-touch", call: "App.boxSelectGeom.lineHits", args: [[], R, "touch"] },
    { id: "line/empty-within", call: "App.boxSelectGeom.lineHits", args: [[], R, "within"] },
    { id: "line/single-point-inside", call: "App.boxSelectGeom.lineHits", args: [[[15, 15]], R, "touch"] },
    { id: "line/single-point-outside", call: "App.boxSelectGeom.lineHits", args: [[[50, 50]], R, "touch"] },

    // ---- polygons ----
    { id: "poly/contains-whole-box-touch", call: "App.boxSelectGeom.polygonHits", args: [[SQUARE], R, "touch"] },
    { id: "poly/contains-whole-box-within", call: "App.boxSelectGeom.polygonHits", args: [[SQUARE], R, "within"] },
    { id: "poly/hole-contains-whole-box-touch", call: "App.boxSelectGeom.polygonHits", args: [[SQUARE, HOLE], R, "touch"] },
    { id: "poly/partial-overlap-touch", call: "App.boxSelectGeom.polygonHits", args: [[PARTIAL], R, "touch"] },
    { id: "poly/partial-overlap-within", call: "App.boxSelectGeom.polygonHits", args: [[PARTIAL], R, "within"] },
    { id: "poly/inside-box-within", call: "App.boxSelectGeom.polygonHits", args: [[[[12, 12], [18, 12], [18, 18], [12, 18]]], R, "within"] },
    { id: "poly/inside-box-touch", call: "App.boxSelectGeom.polygonHits", args: [[[[12, 12], [18, 12], [18, 18], [12, 18]]], R, "touch"] },
    { id: "poly/far-away-touch", call: "App.boxSelectGeom.polygonHits", args: [[[[100, 100], [110, 100], [110, 110]]], R, "touch"] },
    { id: "poly/degenerate-box-inside-touch", call: "App.boxSelectGeom.polygonHits", args: [[SQUARE], { minX: 15, minY: 15, maxX: 15, maxY: 15 }, "touch"] },
    { id: "poly/degenerate-box-outside-touch", call: "App.boxSelectGeom.polygonHits", args: [[SQUARE], { minX: 50, minY: 50, maxX: 50, maxY: 50 }, "touch"] },
    { id: "poly/unclosed-ring-closing-edge-misses-box", call: "App.boxSelectGeom.polygonHits", args: [[[[0, 0], [40, 0], [40, 14]]], R, "touch"] },
    { id: "poly/unclosed-ring-closing-edge-hits-box", call: "App.boxSelectGeom.polygonHits", args: [[[[40, 40], [40, 0], [0, 0]]], R, "touch"] },
  ]
};
