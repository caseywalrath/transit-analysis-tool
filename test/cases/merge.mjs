// Golden cases for the pure Feature Merge helpers (js/core/merge.js —
// docs/feature-merge-plan.md Phases 2-3): App.mergeGeom (chainLines, findBranch,
// lengthMi, routeChain), App.mergeAttrs (hasValue, fieldHasValue,
// mergeAttributes, reversalWarnings) and, from Phase 4a (Unmerge),
// App.mergeHistory (fingerprintFeature, stopChanges, restoreStopRefs,
// validateHistory, stripHistory).
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
      args: [[{ name: "P1", lengthMi: 0 }, { name: "P2", lengthMi: 0 }], 0, { kind: "polygon" }] },

    // ---- routeChain (Phase 3: waypoint concatenation + connector assembly) ----
    // R1 ends where R2 starts (coincident join); R2's first waypoint is a hair off R1's last.
    { id: "routeChain/coincident-join-drops-duplicate-waypoint",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.795, 38.801], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.79, 38.80], [-104.785, 38.799], [-104.78, 38.80]], waypoints: [[-104.79, 38.80], [-104.78, 38.80]] }]] },
    { id: "routeChain/coincident-geometry-near-but-distinct-waypoints",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79001, 38.80]] },
              { coords: [[-104.79, 38.80], [-104.78, 38.80]], waypoints: [[-104.789, 38.80], [-104.78, 38.80]] }]] },
    { id: "routeChain/gap-straight-fallback-keeps-both-ends",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.75, 38.80], [-104.74, 38.80]], waypoints: [[-104.75, 38.80], [-104.74, 38.80]] }]] },
    { id: "routeChain/gap-routed-connector-inserted",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.75, 38.80], [-104.74, 38.80]], waypoints: [[-104.75, 38.80], [-104.74, 38.80]] }],
             { "0": [[-104.79, 38.80], [-104.77, 38.805], [-104.75, 38.80]] }] },
    { id: "routeChain/routed-connector-endpoints-slightly-off",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.75, 38.80], [-104.74, 38.80]], waypoints: [[-104.75, 38.80], [-104.74, 38.80]] }],
             { "0": [[-104.78999, 38.80001], [-104.77, 38.805], [-104.75001, 38.79999]] }] },
    { id: "routeChain/out-of-order-one-reversed-waypoints-flip",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.78, 38.80], [-104.79, 38.80]], waypoints: [[-104.78, 38.80], [-104.785, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] }]] },
    { id: "routeChain/three-routes-mixed-gap-and-touch",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: [[-104.80, 38.80], [-104.79, 38.80]], waypoints: [[-104.80, 38.80], [-104.79, 38.80]] },
              { coords: [[-104.79, 38.80], [-104.78, 38.80]], waypoints: [[-104.79, 38.80], [-104.78, 38.80]] },
              { coords: [[-104.76, 38.80], [-104.75, 38.80]], waypoints: [[-104.76, 38.80], [-104.75, 38.80]] }],
             { "1": [[-104.78, 38.80], [-104.77, 38.801], [-104.76, 38.80]] }] },
    { id: "routeChain/no-connector-geoms-equals-chainLines-coords",
      call: "App.mergeGeom.routeChain",
      args: [[{ coords: A, waypoints: [A[0], A[1]] }, { coords: B, waypoints: [B[0], B[2]] }]] },

    // ---- reversalWarnings (Phase 3) ----
    { id: "reversal/directional-reversed-warns",
      call: "App.mergeAttrs.reversalWarnings",
      args: [[{ name: "NB Line", direction: "NB" }, { name: "Plain", direction: "" }],
             { order: [1, 0], reversed: [false, true] }] },
    { id: "reversal/non-directional-reversed-silent",
      call: "App.mergeAttrs.reversalWarnings",
      args: [[{ name: "Both", direction: "Both" }, { name: "Loop", direction: "Loop" }, { name: "None" }],
             { order: [0, 1, 2], reversed: [true, true, true] }] },
    { id: "reversal/directional-not-reversed-silent",
      call: "App.mergeAttrs.reversalWarnings",
      args: [[{ name: "CW", direction: "CW" }], { order: [0], reversed: [false] }] },
    { id: "reversal/several-names-in-chain-order",
      call: "App.mergeAttrs.reversalWarnings",
      args: [[{ name: "A", direction: "Inbound" }, { name: "B", direction: "EB" }, { name: "C", direction: " CCW " }],
             { order: [2, 0, 1], reversed: [true, true, false] }] },

    // ---- mergeAttributes: points ("combine stops") ----
    { id: "attrs/point-associatedRoutes-union-dedup",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "S1", attributes: { stopId: "100", associatedRoutes: [{ featureType: "route", featureId: 1, name: "R1" }, { featureType: "line", featureId: 1, name: "L1" }] }, lengthMi: 0 },
        { name: "S2", attributes: { associatedRoutes: [{ featureType: "route", featureId: 1, name: "R1 (old name)" }, { featureType: "route", featureId: 2, name: "R2" }] }, lengthMi: 0 },
        { name: "S3", attributes: { associatedRoutes: [] }, lengthMi: 0 }
      ], 0, { kind: "point" }] },
    { id: "attrs/point-primary-blank-routes-take-union-of-others",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "S1", attributes: {}, lengthMi: 0 },
        { name: "S2", attributes: { associatedRoutes: [{ featureType: "route", featureId: 2, name: "R2" }] }, lengthMi: 0 },
        { name: "S3", attributes: { associatedRoutes: [{ featureType: "route", featureId: 3, name: "R3" }, { featureType: "route", featureId: 2, name: "R2" }] }, lengthMi: 0 }
      ], 0, { kind: "point" }] },
    { id: "attrs/point-conflicting-stopIds-warn",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "S1", attributes: { stopId: "100", group: "North" }, lengthMi: 0 },
        { name: "S2", attributes: { stopId: "200", group: "South" }, lengthMi: 0 }
      ], 0, { kind: "point" }] },
    { id: "attrs/point-serviceAreaType-primary-walkshed-kept",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "S1", attributes: { serviceAreaType: "walkshed" }, lengthMi: 0 },
        { name: "S2", attributes: { serviceAreaType: "" }, lengthMi: 0 }
      ], 0, { kind: "point" }] },
    { id: "attrs/point-serviceAreaType-blank-primary-not-filled",
      call: "App.mergeAttrs.mergeAttributes",
      args: [[
        { name: "S1", attributes: {}, lengthMi: 0 },
        { name: "S2", attributes: { serviceAreaType: "walkshed" }, lengthMi: 0 }
      ], 0, { kind: "point" }] }
    ,
    // ---- Phase 4a: merge history (Unmerge) ----
    // fingerprintFeature: key order never matters; name/geometry/attributes do; history + visibility don't.
    { id: "hist/fingerprint-basic", call: "App.mergeHistory.fingerprintFeature",
      args: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
               properties: { name: "L", color: "", waypoints: 2, attributes: { mode: "Bus", avgSpeed: 14 }, hidden: true, _mergedFrom: { x: 1 } } }] },
    { id: "hist/fingerprint-same-as-reordered", call: "App.mergeHistory.fingerprintFeature",
      args: [{ type: "Feature", geometry: { coordinates: [[0, 0], [1, 1]], type: "LineString" },
               properties: { attributes: { avgSpeed: 14, mode: "Bus" }, waypoints: 2, color: "", name: "L" } }] },
    { id: "hist/fingerprint-renamed", call: "App.mergeHistory.fingerprintFeature",
      args: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
               properties: { name: "L2", color: "", waypoints: 2, attributes: { mode: "Bus", avgSpeed: 14 } } }] },
    { id: "hist/fingerprint-no-properties", call: "App.mergeHistory.fingerprintFeature", args: [{}] },
    { id: "hist/stable-stringify-sorted-keys", call: "App.mergeHistory.stableStringify", args: [{ b: 1, a: [{ d: 2, c: undefined }], e: null }] },

    // stopChanges: only points whose link list actually changed.
    { id: "hist/stopChanges-repoint-and-dedupe", call: "App.mergeHistory.stopChanges",
      args: [
        { 1: [{ featureType: "route", featureId: 2, name: "B" }], 2: [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 2, name: "B" }], 3: [{ featureType: "route", featureId: 9, name: "Z" }] },
        { 1: [{ featureType: "route", featureId: 1, name: "A" }], 2: [{ featureType: "route", featureId: 1, name: "A" }], 3: [{ featureType: "route", featureId: 9, name: "Z" }] }
      ] },
    { id: "hist/stopChanges-name-refresh-only", call: "App.mergeHistory.stopChanges",
      args: [{ 5: [{ featureType: "route", featureId: 1, name: "Old" }] }, { 5: [{ featureType: "route", featureId: 1, name: "New" }] }] },
    { id: "hist/stopChanges-none", call: "App.mergeHistory.stopChanges", args: [{ 1: [{ featureType: "line", featureId: 1, name: "L" }] }, { 1: [{ featureType: "line", featureId: 1, name: "L" }] }] },

    // restoreStopRefs: exact when untouched, best effort when the stop was edited.
    { id: "hist/restore-exact-when-untouched", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [{ featureType: "route", featureId: 1, name: "A renamed since" }], "route:1", {}] },
    { id: "hist/restore-exact-keeps-original-order-and-names", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 2, name: "B" }, { featureType: "route", featureId: 1, name: "A" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [{ featureType: "route", featureId: 1, name: "A" }], "route:1", { "route:1": "IGNORED on exact restore" }] },
    { id: "hist/restore-best-effort-re-adds-removed-refs", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 7, name: "Added since" }], "route:1", {}] },
    { id: "hist/restore-best-effort-drops-survivor-ref-not-linked-before", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 7, name: "Added since" }], "route:1", {}] },
    { id: "hist/restore-best-effort-keeps-survivor-ref-linked-before-with-fresh-name", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "Merged" }] },
        [{ featureType: "route", featureId: 1, name: "Merged" }, { featureType: "route", featureId: 7, name: "X" }], "route:1", { "route:1": "A" }] },
    { id: "hist/restore-best-effort-user-removed-survivor-link-stays-removed", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 1, name: "A" }, { featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [], "route:1", {}] },
    { id: "hist/restore-best-effort-dedupes", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] },
        [{ featureType: "route", featureId: 2, name: "B" }, { featureType: "route", featureId: 2, name: "B" }], "route:1", {}] },
    { id: "hist/restore-line-survivor-same-id-different-type", call: "App.mergeHistory.restoreStopRefs",
      args: [
        { before: [{ featureType: "route", featureId: 1, name: "R" }, { featureType: "line", featureId: 1, name: "L" }], after: [{ featureType: "line", featureId: 1, name: "R" }] },
        [{ featureType: "line", featureId: 1, name: "R" }], "line:1", { "line:1": "L" }] },
    { id: "hist/restore-missing-current", call: "App.mergeHistory.restoreStopRefs",
      args: [{ before: [{ featureType: "route", featureId: 2, name: "B" }], after: [{ featureType: "route", featureId: 1, name: "A" }] }, null, "route:1", {}] },

    // validateHistory
    { id: "hist/validate-ok", call: "App.mergeHistory.validateHistory",
      args: [{ version: 1, survivorRef: { type: "line", id: 1 }, originals: [
        { type: "line", feature: { geometry: {}, properties: { lineIdx: 1 } } }, { type: "line", feature: { geometry: {}, properties: { lineIdx: 2 } } }] },
        { type: "line", id: 1 }, { line: "lineIdx", route: "routeIdx" }] },
    { id: "hist/validate-wrong-feature", call: "App.mergeHistory.validateHistory",
      args: [{ version: 1, survivorRef: { type: "line", id: 9 }, originals: [
        { type: "line", feature: { geometry: {}, properties: { lineIdx: 1 } } }, { type: "line", feature: { geometry: {}, properties: { lineIdx: 2 } } }] },
        { type: "line", id: 1 }, { line: "lineIdx", route: "routeIdx" }] },
    { id: "hist/validate-survivor-missing-from-originals", call: "App.mergeHistory.validateHistory",
      args: [{ version: 1, survivorRef: { type: "line", id: 1 }, originals: [
        { type: "route", feature: { geometry: {}, properties: { routeIdx: 1 } } }, { type: "route", feature: { geometry: {}, properties: { routeIdx: 2 } } }] },
        { type: "line", id: 1 }, { line: "lineIdx", route: "routeIdx" }] },
    { id: "hist/validate-future-version", call: "App.mergeHistory.validateHistory",
      args: [{ version: 2, survivorRef: { type: "line", id: 1 }, originals: [] }, { type: "line", id: 1 }, { line: "lineIdx" }] },
    { id: "hist/validate-none", call: "App.mergeHistory.validateHistory", args: [null, { type: "line", id: 1 }, { line: "lineIdx" }] },

    // stripHistory: copy without _mergedFrom, input untouched, same object when nothing to strip.
    { id: "hist/strip-removes-history", call: "App.mergeHistory.stripHistory",
      args: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { name: "P", _mergedFrom: { originals: [1, 2, 3] }, attributes: { a: 1 } } }] },
    { id: "hist/strip-nothing-to-strip", call: "App.mergeHistory.stripHistory",
      args: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { name: "P" } }] }
  ]
};
