// Golden cases for the pure Feature Split helpers (js/core/split.js —
// docs/feature-split-plan.md Phase 1): App.splitGeom (cutAt, locate,
// snapToVertex, partitionWaypoints, splitRunTime, assignStops, isLoop,
// uniqueName, lengthMi). Plain arrays only — no turf, DOM or map. The split
// operation and dialog are covered by test/feature-split-smoke.mjs.

// An L-shaped line along latitude 38.8 then north.
const L = [[-104.80, 38.80], [-104.79, 38.80], [-104.78, 38.80], [-104.78, 38.81]];
// A route that goes east then comes back west 0.001 deg north (passes the same spot twice).
const BACK = [[-104.80, 38.800], [-104.78, 38.800], [-104.78, 38.801], [-104.80, 38.801]];

export default {
  scripts: ["js/core/split.js"],
  cases: [
    // ---- cutAt ----
    { id: "cut/mid-segment", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 1, t: 0.5 }]] },
    { id: "cut/at-vertex-adds-no-vertex", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 2, t: 0 }]] },
    { id: "cut/t-one-same-as-next-vertex", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 1, t: 1 }]] },
    { id: "cut/two-cuts-unsorted", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 2, t: 0.25 }, { segIndex: 0, t: 0.5 }]] },
    { id: "cut/two-cuts-same-segment", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 0, t: 0.75 }, { segIndex: 0, t: 0.25 }]] },
    { id: "cut/ends-ignored", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 0, t: 0 }, { segIndex: 2, t: 1 }]] },
    { id: "cut/duplicate-cut-ignored", call: "App.splitGeom.cutAt", args: [L, [{ segIndex: 1, t: 0.5 }, { segIndex: 1, t: 0.5 }]] },
    { id: "cut/no-cuts", call: "App.splitGeom.cutAt", args: [L, []] },
    { id: "cut/degenerate-line", call: "App.splitGeom.cutAt", args: [[[-104.8, 38.8]], [{ segIndex: 0, t: 0.5 }]] },

    // ---- locate ----
    { id: "locate/near-middle", call: "App.splitGeom.locate", args: [L, [-104.785, 38.8003]] },
    { id: "locate/past-the-end-clamps", call: "App.splitGeom.locate", args: [L, [-104.77, 38.82]] },
    { id: "locate/object-lnglat", call: "App.splitGeom.locate", args: [L, { lng: -104.795, lat: 38.7999 }] },
    { id: "locate/vertex-normalized-to-next-seg", call: "App.splitGeom.locate", args: [L, [-104.79, 38.7995]] },
    { id: "locate/overlap-nearest", call: "App.splitGeom.locate", args: [BACK, [-104.79, 38.80052]] },
    { id: "locate/overlap-hint-picks-outbound-leg", call: "App.splitGeom.locate", args: [BACK, [-104.79, 38.80052], 0] },
    { id: "locate/empty", call: "App.splitGeom.locate", args: [[], [-104.79, 38.8]] },

    // ---- snapToVertex ----
    { id: "snap/within", call: "App.splitGeom.snapToVertex", args: [L, { segIndex: 1, t: 0.98, point: [-104.7802, 38.8] }, 100] },
    { id: "snap/outside", call: "App.splitGeom.snapToVertex", args: [L, { segIndex: 1, t: 0.5, point: [-104.785, 38.8] }, 50] },
    { id: "snap/near-start-of-segment", call: "App.splitGeom.snapToVertex", args: [L, { segIndex: 1, t: 0.01, point: [-104.7899, 38.8] }, 50] },

    // ---- partitionWaypoints ----
    { id: "wp/mid-segment", call: "App.splitGeom.partitionWaypoints", args: [L, [L[0], L[2], L[3]], [{ segIndex: 1, t: 0.5 }]] },
    { id: "wp/cut-on-waypoint", call: "App.splitGeom.partitionWaypoints", args: [L, [L[0], L[2], L[3]], [{ segIndex: 2, t: 0 }]] },
    { id: "wp/two-cuts", call: "App.splitGeom.partitionWaypoints", args: [L, [L[0], L[3]], [{ segIndex: 0, t: 0.5 }, { segIndex: 2, t: 0.5 }]] },
    { id: "wp/self-overlap-in-order", call: "App.splitGeom.partitionWaypoints",
      args: [BACK, [BACK[0], [-104.79, 38.8], [-104.79, 38.801], BACK[3]], [{ segIndex: 1, t: 0.5 }]] },

    // ---- splitRunTime ----
    { id: "rt/proportional", call: "App.splitGeom.splitRunTime", args: [30, [1, 2]] },
    { id: "rt/rounding-sums-exactly", call: "App.splitGeom.splitRunTime", args: [10, [1, 1, 1]] },
    { id: "rt/string", call: "App.splitGeom.splitRunTime", args: ["12.5", [3, 1]] },
    { id: "rt/missing", call: "App.splitGeom.splitRunTime", args: [null, [1, 2]] },
    { id: "rt/zero", call: "App.splitGeom.splitRunTime", args: [0, [1, 2]] },

    // ---- assignStops ----
    { id: "stops/nearest-and-cut", call: "App.splitGeom.assignStops",
      args: [[{ id: 1, at: [-104.799, 38.8001] }, { id: 2, at: [-104.7801, 38.805] }, { id: 3, at: [-104.78, 38.80005] }],
             [[L[0], L[1], L[2]], [L[2], L[3]]], 50] },
    { id: "stops/default-tolerance", call: "App.splitGeom.assignStops",
      args: [[{ id: 7, at: [-104.7849, 38.8] }], [[L[0], L[1], [-104.785, 38.8]], [[-104.785, 38.8], L[2], L[3]]]] },
    { id: "stops/none", call: "App.splitGeom.assignStops", args: [[], [L]] },

    // ---- isLoop / uniqueName / lengthMi ----
    { id: "loop/open", call: "App.splitGeom.isLoop", args: [L] },
    { id: "loop/closed", call: "App.splitGeom.isLoop", args: [[[-104.8, 38.8], [-104.79, 38.8], [-104.79, 38.81], [-104.80005, 38.8]]] },
    { id: "loop/custom-ft", call: "App.splitGeom.isLoop", args: [[[-104.8, 38.8], [-104.79, 38.8], [-104.79, 38.81], [-104.8001, 38.8]], 10] },
    { id: "name/first-free", call: "App.splitGeom.uniqueName", args: ["Route 4", ["Route 4", "Route 4 (2)"]] },
    { id: "name/start-at", call: "App.splitGeom.uniqueName", args: ["Red", ["Red"], 3] },
    { id: "name/blank-base", call: "App.splitGeom.uniqueName", args: ["  ", []] },
    { id: "length/L", call: "App.splitGeom.lengthMi", args: [L] }
  ]
};
