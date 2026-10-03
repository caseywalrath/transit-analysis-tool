// Golden cases for the Transit Travelshed pure engine (window.Travelshed).
// No deps — travelshed.js is turf/DOM/Map-free by design (see the header
// comment in js/core/travelshed.js), so it loads clean in the vm sandbox.
//
// The two computeArrivalTimes toy networks are hand-computed in the commit
// that seeded them (docs/archive/transit-travelshed-plan.md Phase 3 instructs this —
// "hand-compute the two toys before seeding so the golden file is verified,
// not just recorded"). See PR/commit description for the worked arithmetic.

export default {
  scripts: ["js/core/travelshed.js"],
  cases: [
    // --- parseHHMMtoMin: "H:MM" -> minutes-from-midnight (null on bad) ------
    { id: "parse-hhmm-basic", call: "Travelshed.parseHHMMtoMin", args: ["07:30"] },
    { id: "parse-hhmm-single-digit-hour", call: "Travelshed.parseHHMMtoMin", args: ["7:05"] },
    { id: "parse-hhmm-midnight-end", call: "Travelshed.parseHHMMtoMin", args: ["24:00"] },
    { id: "parse-hhmm-garbage", call: "Travelshed.parseHHMMtoMin", args: ["nope"] },
    { id: "parse-hhmm-not-a-string", call: "Travelshed.parseHHMMtoMin", args: [730] },

    // --- selectActiveBand: wrap-aware, skips no-frequency bands ------------
    {
      id: "band-midday",
      call: "Travelshed.selectActiveBand",
      args: [[{ from: "06:00", to: "09:00", frequency: 15 }, { from: "09:00", to: "15:00", frequency: 30 }], 600],
    },
    {
      id: "band-midnight-wrap",
      call: "Travelshed.selectActiveBand",
      args: [[{ from: "22:00", to: "01:00", frequency: 60 }], 30], // 00:30 matches via +1440
    },
    {
      id: "band-skip-no-freq",
      call: "Travelshed.selectActiveBand",
      args: [[{ from: "06:00", to: "09:00", frequency: null }], 420],
    },
    {
      id: "band-no-match",
      call: "Travelshed.selectActiveBand",
      args: [[{ from: "06:00", to: "09:00", frequency: 15 }], 1000],
    },
    {
      id: "band-not-array",
      call: "Travelshed.selectActiveBand",
      args: [null, 420],
    },

    // --- initialWait / transferWait -----------------------------------------
    { id: "wait-initial-capped", call: "Travelshed.initialWait", args: [30, 10, 1] }, // min(15,10)+1 = 11
    { id: "wait-initial-short", call: "Travelshed.initialWait", args: [12, 10, 1] }, // min(6,10)+1 = 7
    { id: "wait-transfer-uncapped", call: "Travelshed.transferWait", args: [30, 1] }, // 15+1 = 16

    // --- rideMinAtDistance: runTime wins over avgSpeed ----------------------
    { id: "ride-runtime-priority", call: "Travelshed.rideMinAtDistance", args: [2, 4, 20, 14] }, // (2/4)*20 = 10
    { id: "ride-avgspeed", call: "Travelshed.rideMinAtDistance", args: [2, 4, 0, 14] }, // (2/14)*60
    { id: "ride-zero-length-fallback", call: "Travelshed.rideMinAtDistance", args: [2, 0, 20, 14] }, // guarded -> 0

    // --- sampleStopPositions: endpoints always included ---------------------
    { id: "sample-stops", call: "Travelshed.sampleStopPositions", args: [1.1, 0.25] },
    { id: "sample-stops-exact-multiple", call: "Travelshed.sampleStopPositions", args: [1.0, 0.25] },
    { id: "sample-stops-degenerate", call: "Travelshed.sampleStopPositions", args: [0.2, 0.25] },

    // --- propagateRide: both / forward / loop wrap ---------------------------
    {
      id: "propagate-both",
      call: "Travelshed.propagateRide",
      args: [[{ rideMin: 0 }, { rideMin: 5 }, { rideMin: 12 }], 1, 10, { mode: "both", loop: null }],
    },
    {
      id: "propagate-forward-downstream-only",
      call: "Travelshed.propagateRide",
      args: [[{ rideMin: 0 }, { rideMin: 5 }, { rideMin: 12 }], 0, 10, { mode: "forward", loop: null }],
    },
    {
      id: "propagate-loop-wrap",
      call: "Travelshed.propagateRide",
      args: [[{ rideMin: 0 }, { rideMin: 5 }, { rideMin: 12 }], 1, 10, { mode: "forward", loop: { cycleMin: 15 } }],
    },

    // --- bandNodeSets: cumulative thresholds over one flood result ----------
    {
      id: "band-node-sets",
      call: "Travelshed.bandNodeSets",
      args: [{ a: 5, b: 14, c: 29, d: 44 }, [15, 30, 45]],
    },

    // --- computeArrivalTimes: hand-checkable toy networks --------------------
    // Toy 1: 1 route ("route-1", forward, headway 10), 2 stops (A start, B 5
    // min downstream). Origin reaches stop A's access node (n1) only.
    // Hand-computed: A boards at 7.8, alights B at 12.8; egress reaches n4 at
    // 13.16 and n5 at 17.6. No transfer possible (route-1 is the only route).
    {
      id: "arrival-times-tiny",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 30,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        originCost: { n1: 0.1 },
        routes: [{
          routeId: "route-1",
          mode: "forward",
          loop: null,
          headwayMin: 10,
          stops: [
            { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0.05 }, { nodeKey: "n1b", extraKm: 0.05 }] },
            { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n3", extraKm: 0.02 }, { nodeKey: "n3b", extraKm: 0.02 }] },
          ],
        }],
        stopCosts: {
          A: { n1: 0 },
          B: { n4: 0.03, n5: 0.4 },
        },
      }],
    },
    // Toy 2: 2 crossing routes. route-1 (forward, headway 10) boards at A from
    // the origin and alights at B; route-2 (forward, headway 20) is NOT
    // reachable from the origin directly (stop C's access node n3 isn't in
    // originCost) but IS reachable by walking from route-1's B egress flood
    // (stopCosts.B includes n3) — a single transfer. Node n5 (reached only via
    // route-2's D egress) is therefore reachable ONLY via that one transfer.
    {
      id: "arrival-times-transfer",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 40,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        originCost: { n1: 0 },
        routes: [
          {
            routeId: "route-1",
            mode: "forward",
            loop: null,
            headwayMin: 10,
            stops: [
              { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
              { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n2", extraKm: 0 }] },
            ],
          },
          {
            routeId: "route-2",
            mode: "forward",
            loop: null,
            headwayMin: 20,
            stops: [
              { stopKey: "C", rideMin: 0, access: [{ nodeKey: "n3", extraKm: 0 }] },
              { stopKey: "D", rideMin: 8, access: [{ nodeKey: "n4", extraKm: 0 }] },
            ],
          },
        ],
        stopCosts: {
          A: { n1: 0 },
          B: { n2: 0, n3: 0.1 },
          C: { n3: 0 },
          D: { n5: 0.05 },
        },
      }],
    },

    // --- computeArrivalTimes: v2 walk-leg caps (docs/archive/transit-travelshed-v2-walk-caps-plan.md §2.2) ---
    //
    // Access cap: 2 independent routes, one boarded from a near origin node
    // (n1, 0.6 min walk) and one from a far origin node (n2, 6 min walk).
    // Uncapped, both board (route-near at 6.6, route-far at 12) and each
    // propagates one stop downstream. With accessMaxMin: 3, the far route's
    // walk (6 min) exceeds the cap so it never boards at all — route-near is
    // unaffected (0.6 min walk stays under the cap).
    {
      id: "arrival-times-access-cap-uncapped",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 30,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        originCost: { n1: 0.05, n2: 0.5 },
        routes: [
          {
            routeId: "route-near", mode: "forward", loop: null, headwayMin: 10,
            stops: [
              { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
              { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n1b", extraKm: 0 }] },
            ],
          },
          {
            routeId: "route-far", mode: "forward", loop: null, headwayMin: 10,
            stops: [
              { stopKey: "C", rideMin: 0, access: [{ nodeKey: "n2", extraKm: 0 }] },
              { stopKey: "D", rideMin: 5, access: [{ nodeKey: "n2b", extraKm: 0 }] },
            ],
          },
        ],
        stopCosts: {},
      }],
    },
    {
      id: "arrival-times-access-cap-tight",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 30,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        accessMaxMin: 3, // n2's 6-min walk exceeds this; n1's 0.6-min walk doesn't
        originCost: { n1: 0.05, n2: 0.5 },
        routes: [
          {
            routeId: "route-near", mode: "forward", loop: null, headwayMin: 10,
            stops: [
              { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
              { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n1b", extraKm: 0 }] },
            ],
          },
          {
            routeId: "route-far", mode: "forward", loop: null, headwayMin: 10,
            stops: [
              { stopKey: "C", rideMin: 0, access: [{ nodeKey: "n2", extraKm: 0 }] },
              { stopKey: "D", rideMin: 5, access: [{ nodeKey: "n2b", extraKm: 0 }] },
            ],
          },
        ],
        stopCosts: {},
      }],
    },

    // Egress cap: 1 route, board at A (0 min walk), alight at B (arriveMin
    // 11). B's own flood has a near node (m1, 0.12 min walk) and a far node
    // (m2, 3.6 min walk). Uncapped, both merge into nodeTimes. With
    // egressMaxMin: 1, only m1 merges — fewer nodes reached, same alighting.
    {
      id: "arrival-times-egress-cap-uncapped",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 30,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        originCost: { n1: 0 },
        routes: [{
          routeId: "route-1", mode: "forward", loop: null, headwayMin: 10,
          stops: [
            { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
            { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n2", extraKm: 0 }] },
          ],
        }],
        stopCosts: { B: { m1: 0.01, m2: 0.3 } },
      }],
    },
    {
      id: "arrival-times-egress-cap-tight",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 30,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        egressMaxMin: 1, // m1's 0.12-min walk survives; m2's 3.6-min walk doesn't
        originCost: { n1: 0 },
        routes: [{
          routeId: "route-1", mode: "forward", loop: null, headwayMin: 10,
          stops: [
            { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
            { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n2", extraKm: 0 }] },
          ],
        }],
        stopCosts: { B: { m1: 0.01, m2: 0.3 } },
      }],
    },

    // Transfer cap: same 2-crossing-route network as "arrival-times-transfer"
    // (its uncapped twin) — route-2's transfer boarding at C requires a
    // 1.2-min walk from route-1's B egress flood. With transferMaxMin: 1 that
    // walk is blocked, so route-2 never boards and D (reachable only via that
    // transfer) drops out of both nodeTimes and alightings.
    {
      id: "arrival-times-transfer-cap-tight",
      call: "Travelshed.computeArrivalTimes",
      args: [{
        budgetMin: 40,
        walkSpeedKmh: 5,
        maxInitialWaitMin: 5,
        boardingPenaltyMin: 1,
        transferCap: 1,
        transferMaxMin: 1, // blocks the 1.2-min B->n3 transfer walk
        originCost: { n1: 0 },
        routes: [
          {
            routeId: "route-1",
            mode: "forward",
            loop: null,
            headwayMin: 10,
            stops: [
              { stopKey: "A", rideMin: 0, access: [{ nodeKey: "n1", extraKm: 0 }] },
              { stopKey: "B", rideMin: 5, access: [{ nodeKey: "n2", extraKm: 0 }] },
            ],
          },
          {
            routeId: "route-2",
            mode: "forward",
            loop: null,
            headwayMin: 20,
            stops: [
              { stopKey: "C", rideMin: 0, access: [{ nodeKey: "n3", extraKm: 0 }] },
              { stopKey: "D", rideMin: 8, access: [{ nodeKey: "n4", extraKm: 0 }] },
            ],
          },
        ],
        stopCosts: {
          A: { n1: 0 },
          B: { n2: 0, n3: 0.1 },
          C: { n3: 0 },
          D: { n5: 0.05 },
        },
      }],
    },
  ],
};
