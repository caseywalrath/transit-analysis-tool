// Golden cases for the Network Connectors pure planarization engine
// (window.ConnectorGraph). No deps — connector-graph.js is turf/DOM/Map/App
// free by design (see the header comment in js/core/connector-graph.js), so
// it loads clean in the vm sandbox, same as travelshed.mjs.
//
// Geometry note: all coordinates sit near lng -105, lat 39 (this app's usual
// Colorado test fixtures). Degree-to-meter conversions used when reasoning
// about the scenarios below: 1 deg lat ~= 110,574 m; 1 deg lng at lat 39
// ~= 86,516 m. 10 m ~= 9.04e-5 deg lat. 50 ft = 15.24 m = 0.01524 km;
// 20 ft = 6.096 m = 0.006096 km.
//
// Each planarizeConnectors scenario below is one of the 9 minimum cases
// listed in docs/network-connectors-plan.md Phase 3, worked out by hand
// (see the inline comments) before being recorded with --update.

export default {
  scripts: ["js/core/connector-graph.js"],
  cases: [
    // ---- segmentIntersection: primitive checks ----------------------------
    {
      id: "seg-intersection-basic-crossing",
      call: "ConnectorGraph.segmentIntersection",
      // s1: vertical line lng=-105.000, lat 38.999->39.001.
      // c1: horizontal line lat=39.000, lng -105.001->-104.999.
      // Both bisect the other -> crossing at (-105.000, 39.000), t=0.5 each.
      args: [[-105.001, 39.000], [-104.999, 39.000], [-105.000, 38.999], [-105.000, 39.001]],
    },
    {
      id: "seg-intersection-parallel-null",
      call: "ConnectorGraph.segmentIntersection",
      // Two collinear vertical segments on the same line -> zero cross product -> null.
      args: [[-105.040, 39.0395], [-105.040, 39.0415], [-105.040, 39.040], [-105.040, 39.042]],
    },
    {
      id: "seg-intersection-out-of-range-null",
      call: "ConnectorGraph.segmentIntersection",
      // Would cross if extended infinitely, but the crossing point falls
      // beyond both segments' own finite extents -> null.
      args: [[-105.001, 39.000], [-105.0005, 39.000], [-105.000, 38.999], [-105.000, 38.9995]],
    },

    // ---- pointToSegmentKm: primitive checks --------------------------------
    {
      id: "point-to-seg-perpendicular",
      call: "ConnectorGraph.pointToSegmentKm",
      // p sits ~10 m due south of the midpoint of a short east-west segment.
      args: [[-105.009, 39.010 - 0.0000904], [-105.010, 39.010], [-105.008, 39.010]],
    },
    {
      id: "point-to-seg-degenerate-ab-equal",
      call: "ConnectorGraph.pointToSegmentKm",
      // a === b (zero-length segment) -> the dx===0&&dy===0 branch, t=0.
      args: [[-105.000, 39.000], [-105.005, 39.005], [-105.005, 39.005]],
    },

    // ---- splitChain: primitive checks --------------------------------------
    {
      id: "split-chain-single-split",
      call: "ConnectorGraph.splitChain",
      args: [
        [[-105.000, 39.000], [-105.000, 39.002]],
        [{ segIndex: 0, t: 0.5, point: [-105.000, 39.001] }],
      ],
    },
    {
      id: "split-chain-two-splits-same-segment-unsorted-input",
      call: "ConnectorGraph.splitChain",
      // Splits given out of t-order — splitChain must sort them itself.
      args: [
        [[-105.000, 39.000], [-105.000, 39.004]],
        [
          { segIndex: 0, t: 0.75, point: [-105.000, 39.003] },
          { segIndex: 0, t: 0.25, point: [-105.000, 39.001] },
        ],
      ],
    },
    {
      id: "split-chain-split-at-existing-vertex-drops-zero-length",
      call: "ConnectorGraph.splitChain",
      // Split point coincides with coords[1] itself -> the trailing zero-length
      // edge must be dropped, not emitted.
      args: [
        [[-105.000, 39.000], [-105.000, 39.002], [-105.000, 39.004]],
        [{ segIndex: 0, t: 1.0, point: [-105.000, 39.002] }],
      ],
    },

    // ---- planarizeConnectors: the 9 minimum scenarios ----------------------

    // 1. Mid-block crossing: 1 connector segment crosses 1 base segment once.
    // Hand-check: intersection at (-105.000, 39.000), t=0.5 on both lines (see
    // seg-intersection-basic-crossing above) -> 1 crossing join; base segment
    // "s1" replaced by 2 "split" edges; the connector itself becomes 2
    // "connector" edges (cut at the same point) -> 4 addEdges total, 1
    // removeSegIds entry. weldVertices is off so both connector endpoints
    // (which are NOT the crossing point) end up unweleded -> 2 orphans.
    {
      id: "planarize-mid-block-crossing",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c1", coords: [[-105.001, 39.000], [-104.999, 39.000]] }],
        [{ segId: "s1", coords: [[-105.000, 38.999], [-105.000, 39.001]], pedBlocked: false }],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 2. Double crossing: a 3-point zigzag connector crosses the same base
    // segment twice (t=0.375 and t=0.625 along "s1", hand-verified in the
    // plan's worked example — see the commit description). Expect 2 crossing
    // joins, "s1" split into 3 pieces (2 splits), and the connector's own
    // 2-segment chain each carrying 1 split -> 4 connector edges. 7 addEdges
    // total, 1 removeSegIds entry.
    {
      id: "planarize-double-crossing",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c2", coords: [[-105.002, 38.999], [-104.998, 39.000], [-105.002, 39.001]] }],
        [{ segId: "s1", coords: [[-105.000, 38.998], [-105.000, 39.002]], pedBlocked: false }],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 3. Weld within tolerance: connector endpoint ~10 m from a street,
    // tolerance 50 ft (15.24 m) -> welded (1 weld join, the base segment
    // "s2" split at the projected point since it isn't at an existing vertex,
    // plus a short link edge from the endpoint to the weld point). The
    // connector's far endpoint has no nearby candidate -> orphan.
    {
      id: "planarize-weld-within-tolerance",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c3", coords: [[-105.009, 39.010 - 0.0000904], [-105.009, 39.005]] }],
        [{ segId: "s2", coords: [[-105.010, 39.010], [-105.008, 39.010]], pedBlocked: false }],
        { snapToleranceKm: 0.01524, weldVertices: true, splitCrossings: false },
      ],
    },

    // 4. Same geometry, tighter tolerance (20 ft = 6.096 m): the ~10 m gap now
    // exceeds it -> not welded, endpoint reported as an orphan with its
    // actual nearest distance (~0.01 km) instead.
    {
      id: "planarize-weld-rejected-outside-tolerance",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c3", coords: [[-105.009, 39.010 - 0.0000904], [-105.009, 39.005]] }],
        [{ segId: "s2", coords: [[-105.010, 39.010], [-105.008, 39.010]], pedBlocked: false }],
        { snapToleranceKm: 0.006096, weldVertices: true, splitCrossings: false },
      ],
    },

    // 5. pedBlocked exclusion: the same mid-block crossing geometry as case 1,
    // but the base segment is flagged pedBlocked (a freeway) -> the crossing
    // must be skipped entirely (0 joins, 0 addEdges beyond the connector's
    // own untouched edge, 0 removeSegIds) — the bridge/freeway mitigation
    // from docs/network-connectors-plan.md §1.
    {
      id: "planarize-pedblocked-exclusion",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c1", coords: [[-105.001, 39.000], [-104.999, 39.000]] }],
        [{ segId: "s1", coords: [[-105.000, 38.999], [-105.000, 39.001]], pedBlocked: true }],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 5b. userExcluded carve-out, crossing pass (docs/sidewalk-data-plan.md
    // Phase 4 step 7): same geometry as case 5, but the base segment is
    // pedBlocked AND userExcluded — the crossing must join exactly as it
    // does in unblocked case 1 (a user exclusion is not the same as a class
    // block, for welding). This is the inverse of case 5, which must stay
    // byte-identical (userExcluded absent/false there).
    {
      id: "planarize-crossing-userexcluded-joins",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c1", coords: [[-105.001, 39.000], [-104.999, 39.000]] }],
        [{ segId: "s1", coords: [[-105.000, 38.999], [-105.000, 39.001]], pedBlocked: true, userExcluded: true }],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 5c. userExcluded carve-out, weld pass: same geometry as case 3, but the
    // base segment is pedBlocked AND userExcluded -> must still weld (1 weld
    // join, 1 split of "s2", 1 link edge), same shape as case 3's unblocked
    // result.
    {
      id: "planarize-weld-userexcluded-joins",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c3", coords: [[-105.009, 39.010 - 0.0000904], [-105.009, 39.005]] }],
        [{ segId: "s2", coords: [[-105.010, 39.010], [-105.008, 39.010]], pedBlocked: true, userExcluded: true }],
        { snapToleranceKm: 0.01524, weldVertices: true, splitCrossings: false },
      ],
    },

    // 5d. Class-pedBlocked weld still refused: same geometry as 5c, but
    // pedBlocked without userExcluded (a real motorway/trunk) -> the weld
    // must be refused (0 joins, endpoint reported as an orphan) exactly like
    // the existing class-blocked crossing case (5). Locks in the other half
    // of the carve-out — motorways never become weldable.
    {
      id: "planarize-weld-pedblocked-still-rejected",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c3", coords: [[-105.009, 39.010 - 0.0000904], [-105.009, 39.005]] }],
        [{ segId: "s2", coords: [[-105.010, 39.010], [-105.008, 39.010]], pedBlocked: true, userExcluded: false }],
        { snapToleranceKm: 0.01524, weldVertices: true, splitCrossings: false },
      ],
    },

    // 6. Connector-connector crossing: no base candidates at all. Connector
    // "A" (horizontal) is processed first and its edges enter the pool;
    // connector "B" (vertical) crosses it -> 1 crossing join reported under
    // B (the connector being processed) against segId "A". Both connectors
    // end up split into 2 pieces each -> 4 addEdges, all kind "connector",
    // 0 removeSegIds (nothing came from the base graph).
    {
      id: "planarize-connector-connector-crossing",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [
          { id: "A", coords: [[-105.020, 39.020], [-105.016, 39.020]] },
          { id: "B", coords: [[-105.018, 39.018], [-105.018, 39.022]] },
        ],
        [],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 7. Exact node reuse: a connector endpoint lands exactly on an existing
    // base-segment vertex (coordinates equal to within the node-key quantum).
    // Expect a "weld" join at that point, but NO split of the base segment
    // and NO extra link edge (the connector's own edge already carries that
    // exact coordinate, so the shared nodeKey does the joining downstream in
    // road-network.js) -> only 1 addEdges entry (the connector's own edge),
    // 0 removeSegIds. The far endpoint has nothing nearby -> 1 orphan.
    {
      id: "planarize-exact-node-reuse",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c4", coords: [[-105.028, 39.032], [-105.026, 39.034]] }],
        [{ segId: "s3", coords: [[-105.030, 39.030], [-105.028, 39.032]], pedBlocked: false }],
        { snapToleranceKm: 0.05, weldVertices: true, splitCrossings: false },
      ],
    },

    // 8. Collinear overlap: a connector drawn along (overlapping, not
    // crossing) an existing street -> segmentIntersection returns null for
    // every pairing (parallel/collinear), so 0 crossing joins and the base
    // segment is left untouched. weldVertices is off, so both connector
    // endpoints are reported as orphans (this is the documented "harmless
    // parallel edge" case from docs/network-connectors-plan.md §2 — the
    // travel time is identical either way, so no join is needed).
    {
      id: "planarize-collinear-overlap-no-join",
      call: "ConnectorGraph.planarizeConnectors",
      args: [
        [{ id: "c5", coords: [[-105.040, 39.0395], [-105.040, 39.0415]] }],
        [{ segId: "s4", coords: [[-105.040, 39.040], [-105.040, 39.042]], pedBlocked: false }],
        { snapToleranceKm: 0, weldVertices: false, splitCrossings: true },
      ],
    },

    // 9. Empty input: no connectors, no candidates -> empty result, no throw.
    {
      id: "planarize-empty-input",
      call: "ConnectorGraph.planarizeConnectors",
      args: [[], [], { snapToleranceKm: 0.01524, weldVertices: true, splitCrossings: true }],
    },
  ],
};
