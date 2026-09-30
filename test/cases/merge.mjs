// Golden cases for the pure Feature Merge helpers (js/core/merge.js —
// docs/feature-merge-plan.md Phase 2): App.mergeGeom (chainLines, findBranch,
// lengthMi) and App.mergeAttrs (hasValue, fieldHasValue, mergeAttributes).
// Everything here is plain arrays/objects — no turf, DOM or map. The merge
// operation, dialog and polygon union are covered by test/feature-merge-smoke.mjs.

// Lines along latitude 38.8, roughly 0.35 mi per 0.0065 deg of longitude.
const A = [[-104.80, 38.80], [-104.79, 38.80]];              // west piece
const B = [[-104.79, 38.80], [-104.78, 38.80], [-104.78, 38.81]]; // touches A's end
const C = [[-104.78, 38.82], [-104.78, 38.81]];              // stored "backwards": it meets B at its END
const GAP = [[-104.75, 38.80], [-104.74, 38.80]];            // a separate piece ~2 mi east of B

const bands = (n) => ({ weekday: Array.from({ length: n }, (_, i) => ({ from: "06:00", to: "09:00", frequency: 15 + i })), saturday: [], sunday: [], sundayMirrorsSaturday: false });

export default {
  scripts: ["js/core/merge.js"],
  cases: [
    // ---- chainLines ----
    { id: "chain/single-line", call: "App.mergeGeom.chainLines", args: [[A]] },
    { id: "chain/in-order-touching", call: "App.mergeGeom.chainLines", args: [[A, B]] },
    { id: "chain/out-of-order-one-reversed", call: "App.mergeGeom.chainLines", args: [[C, A, B]] },
    { id: "chain/selection-reversed", call: "App.mergeGeom.chainLines", args: [[B, A]] },
    { id: "chain/gap-keeps-both-ends", call: "App.mergeGeom.chainLines", args: [[A, GAP]] },
    { id: "chain/empty", call: "App.mergeGeom.chainLines", args: [[]] },
    { id: "chain/custom-coincident-threshold", call: "App.mergeGeom.chainLines", args: [[A, [[-104.78999, 38.80], [-104.78, 38.80]]], { coincidentMi: 0 }] },

    // ---- findBranch ----
    { id: "branch/none-end-to-end", call: "App.mergeGeom.findBranch", args: [[A, B], 0.0095] },
    { id: "branch/T-junction",
      call: "App.mergeGeom.findBranch",
      args: [[[[-104.80, 38.80], [-104.78, 38.80]], [[-104.79, 38.80], [-104.79, 38.81]]], 0.0095] },
    { id: "branch/Y-at-interior-vertex",
      call: "App.mergeGeom.findBranch",
      args: [[[[-104.80, 38.80], [-104.79, 38.80], [-104.78, 38.80]], [[-104.79, 38.80], [-104.785, 38.81]]], 0.0095] },
    { id: "branch/crossing-without-endpoints-is-ok",
      call: "App.mergeGeom.findBranch",
      args: [[[[-104.80, 38.80], [-104.78, 38.80]], [[-104.79, 38.79], [-104.79, 38.81]]], 0.0095] },
    { id: "branch/endpoint-just-outside-tolerance",
      call: "App.mergeGeom.findBranch",
      args: [[[[-104.80, 38.80], [-104.78, 38.80]], [[-104.79, 38.8003], [-104.79, 38.81]]], 0.0095] },

    // ---- lengthMi ----
    { id: "length/one-degree-lat", call: "App.mergeGeom.lengthMi", args: [[[-104.8, 38], [-104.8, 39]]] },
    { id: "length/empty", call: "App.mergeGeom.lengthMi", args: [[]] },

    // ---- has-value semantics ----
    { id: "hasValue/blank-string", call: "App.mergeAttrs.hasValue", args: ["   "] },
    { id: "hasValue/text", call: "App.mergeAttrs.hasValue", args: ["Bus"] },
    { id: "hasValue/zero", call: "App.mergeAttrs.hasValue", args: [0] },
    { id: "hasValue/nan", call: "App.mergeAttrs.hasValue", args: [NaN] },
    { id: "hasValue/empty-array", call: "App.mergeAttrs.hasValue", args: [[]] },
    { id: "hasValue/array", call: "App.mergeAttrs.hasValue", args: [[{ featureType: "line", featureId: 1 }]] },
    { id: "hasValue/bands-empty", call: "App.mergeAttrs.hasValue", args: [bands(0)] },
    { id: "hasValue/bands-one", call: "App.mergeAttrs.hasValue", args: [bands(1)] },
    { id: "fieldHasValue/copy-text-untrimmed", call: "App.mergeAttrs.fieldHasValue", args: ["text", "  "] },
    { id: "fieldHasValue/copy-number-null", call: "App.mergeAttrs.fieldHasValue", args: ["number", null] },
    { id: "fieldHasValue/copy-bands-sunday-mirror", call: "App.mergeAttrs.fieldHasValue",
      args: ["bands", { weekday: [], saturday: [{ from: "08:00", to: "12:00", frequency: 30 }], sunday: [], sundayMirrorsSaturday: true }] },

    // ---- mergeAttributes ----
    { id: "attrs/primary-wins-fill-blanks",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { mode: "", direction: "NB", group: "G1" }, lengthMi: 1 },
        { name: "L2", attributes: { mode: "BRT", direction: "NB", group: "G2" }, lengthMi: 1 },
        { name: "L3", attributes: { mode: "Bus", stopId: "42" }, lengthMi: 1 }
      ], 0, { kind: "line" }] },
    { id: "attrs/pick-other-primary",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { mode: "Bus", group: "G1" }, lengthMi: 1 },
        { name: "L2", attributes: { mode: "BRT", group: "G2" }, lengthMi: 1 }
      ], 1, { kind: "line" }] },
    { id: "attrs/notes-distinct-joined",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "P1", attributes: { notes: "north half" }, lengthMi: 0 },
        { name: "P2", attributes: { notes: "south half" }, lengthMi: 0 },
        { name: "P3", attributes: { notes: " north half " }, lengthMi: 0 }
      ], 0, { kind: "polygon" }] },
    { id: "attrs/runtime-summed-when-all-have",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { runTime: 20 }, lengthMi: 2 },
        { name: "L2", attributes: { runTime: "15.5" }, lengthMi: 3 }
      ], 0, { kind: "line" }] },
    { id: "attrs/runtime-missing-warns",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { runTime: 20 }, lengthMi: 2 },
        { name: "L2", attributes: {}, lengthMi: 3 }
      ], 0, { kind: "line" }] },
    { id: "attrs/avgspeed-length-weighted",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { avgSpeed: 10 }, lengthMi: 1 },
        { name: "L2", attributes: { avgSpeed: 20 }, lengthMi: 3 }
      ], 0, { kind: "line" }] },
    { id: "attrs/avgspeed-equal-unchanged",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { avgSpeed: 14 }, lengthMi: 1 },
        { name: "L2", attributes: { avgSpeed: "14" }, lengthMi: 3 }
      ], 0, { kind: "line" }] },
    { id: "attrs/same-service-and-different-direction-warn",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "NB", attributes: { serviceId: "Blue", direction: "NB" }, lengthMi: 1 },
        { name: "SB", attributes: { serviceId: "Blue", direction: "SB" }, lengthMi: 1 },
        { name: "Other", attributes: { serviceId: "Red" }, lengthMi: 1 }
      ], 0, { kind: "line" }] },
    { id: "attrs/bands-primary-blank-takes-first-donor",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "L1", attributes: { service: bands(0) }, lengthMi: 1 },
        { name: "L2", attributes: { service: bands(2) }, lengthMi: 1 },
        { name: "L3", attributes: { service: bands(1) }, lengthMi: 1 }
      ], 0, { kind: "line" }] },
    { id: "attrs/no-attributes-anywhere",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[{ name: "P1", lengthMi: 0 }, { name: "P2", lengthMi: 0 }], 0, { kind: "polygon" }] }
  ]
};
