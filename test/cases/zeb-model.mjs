// Golden cases for the Route Electrification Feasibility pure engine
// (window.ZEB). No deps — zeb-model.js is turf/DOM/Map-free by design (see
// the header comment in js/core/zeb-model.js), so it loads clean in the vm
// sandbox.
//
// The block-chaining and socProfile cases are hand-computed in the commit
// that seeds this file (same "verify before seeding" convention as
// test/cases/travelshed.mjs) — see the commit message for the worked
// arithmetic.

var TIERS = [
  { tier: 1, label: "Ready today", maxRatio: 0.75, color: "#1a9850",
    reason: "Worst block uses at most 75% of the battery after the 20% safety buffer." },
  { tier: 2, label: "Feasible with margin", maxRatio: 0.90, color: "#91cf60",
    reason: "Worst block fits within the buffered battery with 10-25% margin." },
  { tier: 3, label: "Marginal", maxRatio: 1.00, color: "#fee08b",
    reason: "Worst block only just meets the 20% buffer; small changes tip it over." },
  { tier: 4, label: "Needs midday charging", maxRatio: 1.60, color: "#fc8d59",
    reason: "Depot-only charging fails; a single opportunity charge would close the gap.",
    rechargeReason: "Block energy fits, but it cannot be recharged at the depot charger in the overnight window." },
  { tier: 5, label: "Not feasible depot-only", maxRatio: Infinity, color: "#d73027",
    reason: "Required capacity exceeds 160% of the available battery." }
];

export default {
  scripts: ["js/core/zeb-model.js"],
  cases: [
    // --- parseGtfsTime: "HH:MM:SS" -> minutes-from-midnight (null on bad) ---
    { id: "parse-time-basic", call: "ZEB.parseGtfsTime", args: ["06:05:00"] }, // 365
    { id: "parse-time-past-midnight", call: "ZEB.parseGtfsTime", args: ["25:30:00"] }, // 1530
    { id: "parse-time-blank", call: "ZEB.parseGtfsTime", args: [""] },
    { id: "parse-time-garbage", call: "ZEB.parseGtfsTime", args: ["garbage"] },

    // --- pickRepresentativeService ------------------------------------------
    // Weekday service wins over a larger Saturday-only service, even though
    // the Saturday service carries more total trips (5 vs 2).
    {
      id: "service-weekday-wins",
      call: "ZEB.pickRepresentativeService",
      args: [
        [
          { service_id: "WD", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0" },
          { service_id: "SAT", monday: "0", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "1", sunday: "0" }
        ],
        [],
        [
          { serviceId: "WD" }, { serviceId: "WD" },
          { serviceId: "SAT" }, { serviceId: "SAT" }, { serviceId: "SAT" }, { serviceId: "SAT" }, { serviceId: "SAT" }
        ]
      ]
    },
    // No weekday candidate at all (Saturday + Sunday only) -> most-trips fallback.
    {
      id: "service-fallback-most-trips",
      call: "ZEB.pickRepresentativeService",
      args: [
        [
          { service_id: "SAT", monday: "0", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "1", sunday: "0" },
          { service_id: "SUN", monday: "0", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "0", sunday: "1" }
        ],
        [],
        [{ serviceId: "SAT" }, { serviceId: "SAT" }, { serviceId: "SAT" }, { serviceId: "SUN" }]
      ]
    },
    { id: "service-empty", call: "ZEB.pickRepresentativeService", args: [[], [], []] },

    // --- buildBlocks ----------------------------------------------------------
    // (a) block_id path: two blocks, sorted by startMin.
    {
      id: "blocks-by-block-id",
      call: "ZEB.buildBlocks",
      args: [
        [
          { tripId: "T1", routeId: "R1", serviceId: "S1", blockId: "B1", shapeId: "SH1",
            startMin: 360, endMin: 400, firstStopId: "s1", lastStopId: "s2",
            firstStop: [-105, 40], lastStop: [-105.1, 40.1], miles: 5 },
          { tripId: "T2", routeId: "R1", serviceId: "S1", blockId: "B1", shapeId: "SH1",
            startMin: 410, endMin: 450, firstStopId: "s2", lastStopId: "s1",
            firstStop: [-105.1, 40.1], lastStop: [-105, 40], miles: 5 },
          { tripId: "T3", routeId: "R2", serviceId: "S1", blockId: "B2", shapeId: "SH2",
            startMin: 300, endMin: 340, firstStopId: "s3", lastStopId: "s4",
            firstStop: [-105.2, 40.2], lastStop: [-105.3, 40.3], miles: 4 }
        ],
        { maxLayoverMin: 30, terminalToleranceMi: 0.3 }
      ]
    },
    // (b) chained path: three trips share a terminal and chain; a fourth is
    // excluded by a 46-min gap (> the 30-min maxLayoverMin).
    {
      id: "blocks-chained-layover-excludes",
      call: "ZEB.buildBlocks",
      args: [
        [
          { tripId: "chainT1", routeId: "R1", serviceId: "S1", blockId: "", shapeId: "SH1",
            startMin: 360, endMin: 400, firstStopId: "sA", lastStopId: "sB",
            firstStop: [-105, 40], lastStop: [-105.05, 40.05], miles: 5 },
          { tripId: "chainT2", routeId: "R1", serviceId: "S1", blockId: "", shapeId: "SH1",
            startMin: 410, endMin: 450, firstStopId: "sB", lastStopId: "sA",
            firstStop: [-105.05, 40.05], lastStop: [-105, 40], miles: 5 },
          { tripId: "chainT3", routeId: "R1", serviceId: "S1", blockId: "", shapeId: "SH1",
            startMin: 460, endMin: 500, firstStopId: "sA", lastStopId: "sB",
            firstStop: [-105, 40], lastStop: [-105.05, 40.05], miles: 5 },
          { tripId: "chainT4", routeId: "R1", serviceId: "S1", blockId: "", shapeId: "SH1",
            startMin: 546, endMin: 580, firstStopId: "sB", lastStopId: "sA",
            firstStop: [-105.05, 40.05], lastStop: [-105, 40], miles: 5 }
        ],
        { maxLayoverMin: 30, terminalToleranceMi: 0.3 }
      ]
    },
    // (c) chained path: layover time is fine but the second trip's first stop
    // is nowhere near the first trip's last stop -> starts a new block.
    {
      id: "blocks-chained-terminal-mismatch",
      call: "ZEB.buildBlocks",
      args: [
        [
          { tripId: "termT1", routeId: "R1", serviceId: "S1", blockId: "", shapeId: "SH1",
            startMin: 360, endMin: 400, firstStopId: "sA", lastStopId: "sB",
            firstStop: [-105, 40], lastStop: [-105.05, 40.05], miles: 5 },
          { tripId: "termT2", routeId: "R2", serviceId: "S1", blockId: "", shapeId: "SH2",
            startMin: 410, endMin: 450, firstStopId: "sC", lastStopId: "sD",
            firstStop: [-106, 41], lastStop: [-106.05, 41.05], miles: 5 }
        ],
        { maxLayoverMin: 30, terminalToleranceMi: 0.3 }
      ]
    },
    // (d) empty input.
    { id: "blocks-empty", call: "ZEB.buildBlocks", args: [[], { maxLayoverMin: 30, terminalToleranceMi: 0.3 }] },

    // --- deadheadMiles ----------------------------------------------------
    {
      id: "deadhead-circuity-1",
      call: "ZEB.deadheadMiles",
      args: [[-105.0, 40.0], { firstStop: [-105.1, 40.0], lastStop: [-105.0, 40.1] }, 1.0]
    },
    {
      id: "deadhead-circuity-1.3",
      call: "ZEB.deadheadMiles",
      args: [[-105.0, 40.0], { firstStop: [-105.1, 40.0], lastStop: [-105.0, 40.1] }, 1.3]
    },

    // --- energyForBlock -----------------------------------------------------
    // (a) 40-ft BEB, flat/summer, moderate block -> comfortably tier 1.
    {
      id: "energy-40ft-plains-summer-tier1",
      call: "ZEB.energyForBlock",
      args: [
        { revenueMiles: 60, spanHours: 12 },
        {
          vehicle: { id: "bus40", label: "40-ft BEB", batteryKWh: 440, baseKWhPerMi: 2.10 },
          gradeFactor: 1.00, seasonFactor: 1.05, socBuffer: 0.20,
          chargerKW: 150, chargerEff: 0.90,
          deadheadMiles: { out: 3, back: 3, total: 6 }
        }
      ]
    },
    // (b) cutaway BEB, mountain/winter, long block -> tier 5 territory (ratio ~2).
    {
      id: "energy-cutaway-mountain-winter-tier5",
      call: "ZEB.energyForBlock",
      args: [
        { revenueMiles: 100, spanHours: 10 },
        {
          vehicle: { id: "cutaway", label: "Cutaway BEB", batteryKWh: 150, baseKWhPerMi: 1.15 },
          gradeFactor: 1.30, seasonFactor: 1.45, socBuffer: 0.20,
          chargerKW: 150, chargerEff: 0.90,
          deadheadMiles: { out: 5, back: 5, total: 10 }
        }
      ]
    },
    // (c) energy fits the buffered battery (ratio ~0.95) but a slow 50 kW
    // charger cannot recharge it within a short 4-hour overnight window
    // (20-hour span). Reused by the tierFor recharge-downgrade case below.
    {
      id: "energy-fits-recharge-does-not",
      call: "ZEB.energyForBlock",
      args: [
        { revenueMiles: 150, spanHours: 20 },
        {
          vehicle: { id: "bus40", label: "40-ft BEB", batteryKWh: 440, baseKWhPerMi: 2.10 },
          gradeFactor: 1.00, seasonFactor: 1.00, socBuffer: 0.20,
          chargerKW: 50, chargerEff: 0.90,
          deadheadMiles: { out: 5, back: 5, total: 10 }
        }
      ]
    },

    // --- tierFor: boundary values + recharge downgrade -----------------------
    { id: "tier-boundary-0.75", call: "ZEB.tierFor", args: [0.75, true, TIERS] }, // tier 1
    { id: "tier-boundary-0.9", call: "ZEB.tierFor", args: [0.9, true, TIERS] }, // tier 2
    { id: "tier-boundary-1.0", call: "ZEB.tierFor", args: [1.0, true, TIERS] }, // tier 3
    { id: "tier-boundary-1.6", call: "ZEB.tierFor", args: [1.6, true, TIERS] }, // tier 4
    { id: "tier-boundary-1.61", call: "ZEB.tierFor", args: [1.61, true, TIERS] }, // tier 5
    // Same ratio as energy-fits-recharge-does-not (0.9545...) would be tier 3
    // on ratio alone, but rechargeFits:false downgrades it to tier 4.
    { id: "tier-recharge-downgrade", call: "ZEB.tierFor", args: [0.9545454545454546, false, TIERS] },
    // Tier 5 never downgrades further even when recharge also fails.
    { id: "tier-5-recharge-fail-stays-5", call: "ZEB.tierFor", args: [2.5, false, TIERS] },

    // --- scoreFor -------------------------------------------------------------
    { id: "score-0.5", call: "ZEB.scoreFor", args: [0.5] }, // 100
    { id: "score-1.0", call: "ZEB.scoreFor", args: [1.0] }, // 50
    { id: "score-1.5", call: "ZEB.scoreFor", args: [1.5] }, // 0
    { id: "score-2.0", call: "ZEB.scoreFor", args: [2.0] }, // clamped 0
    { id: "score-negative", call: "ZEB.scoreFor", args: [-1] }, // clamped 100

    // --- summarizeRoute ---------------------------------------------------
    {
      id: "route-summary-worst-governs",
      call: "ZEB.summarizeRoute",
      args: [
        "R1",
        [
          {
            block: { blockId: "B1", revenueMiles: 20 },
            energy: { ratio: 0.5, blockKWh: 100, requiredKWh: 125 },
            tier: { tier: 1, label: "Ready today", reason: "Worst block uses at most 75% of the battery after the 20% safety buffer." }
          },
          {
            block: { blockId: "B2", revenueMiles: 40 },
            energy: { ratio: 1.2, blockKWh: 300, requiredKWh: 375 },
            tier: { tier: 4, label: "Needs midday charging", reason: "recharge issue" }
          }
        ]
      ]
    },
    { id: "route-summary-empty", call: "ZEB.summarizeRoute", args: ["R2", []] },

    // --- socProfile ---------------------------------------------------------
    // Two-trip block, hand-verified: shareOf(miles) = miles/44 * 88/440 =
    // miles * 0.2/44. Trip 1 (20mi) drop = pendingShare(deadhead-out 2mi =
    // 0.0090909...) + 0.0909091 = exactly 0.1 -> soc 0.9. Trip 2 (20mi) drop
    // = 0.0909091 -> soc 0.8090909. Final drop = deadhead-back (2mi) =
    // 0.0090909 -> soc 0.8 exactly, matching 1 - blockKWh/batteryKWh =
    // 1 - 88/440 = 0.8. 4 points total (start + 2 trips + end).
    {
      id: "soc-profile-two-trip-block",
      call: "ZEB.socProfile",
      args: [
        {
          startMin: 360, endMin: 450,
          trips: [
            { tripId: "t1", routeId: "R1", startMin: 360, endMin: 400, miles: 20 },
            { tripId: "t2", routeId: "R1", startMin: 410, endMin: 450, miles: 20 }
          ]
        },
        { totalMiles: 44, blockKWh: 88, deadheadMiles: { out: 2, back: 2, total: 4 } },
        { vehicle: { batteryKWh: 440 } }
      ]
    }
  ]
};
