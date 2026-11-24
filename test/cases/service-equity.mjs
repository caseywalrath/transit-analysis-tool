// Golden cases for the service-equity engine (window.ServiceEquity).
// No deps — service-equity.js is App/turf/DOM-free, so it loads clean in the vm
// sandbox. Every expected value in the comments was worked out by hand.

// Stop and block fixtures sit near 39.7 N, 105 W. One degree of latitude is about
// 69.09 mi, so 0.001 degrees is about 0.069 mi: well inside a 0.25 mi radius.
const LAT = 39.7;
const LON = -105;

// GEOID layout: state(2) + county(3) + tract(6) = 11-char tract; block group = tract + 1 digit;
// block = block group + 3 digits.
const BLK_BG1 = "080310001001001";          // block group 080310001001, tract 08031000100
const BLK_BG2 = "080310001002001";          // block group 080310001002, same tract
const BLK_OTHER_TRACT = "080310002001001";  // tract 08031000200

const STOP_100 = { id: "S1", lat: LAT, lon: LON, radiusMi: 0.25, trips: 100 };

// Four geographies: G1/G2 are 80% minority with 20% low income; G3/G4 are 10% minority with 30% low income.
const FOUR_GEOS = [
  { geoid: "G1", pop: 100, minorityPop: 80, lowIncomePop: 20, trips: 10 },
  { geoid: "G2", pop: 100, minorityPop: 80, lowIncomePop: 20, trips: 10 },
  { geoid: "G3", pop: 100, minorityPop: 10, lowIncomePop: 30, trips: 50 },
  { geoid: "G4", pop: 100, minorityPop: 10, lowIncomePop: 30, trips: 50 },
];

export default {
  scripts: ["js/core/service-equity.js"],
  cases: [
    // ---- lowIncomeSpec -------------------------------------------------------
    // EXPECTED: id "poverty100", label "Below the poverty level", vars ["B17001_002E"] (no argument falls back to poverty100).
    { id: "li-undefined", call: "ServiceEquity.lowIncomeSpec", args: [undefined] },
    // EXPECTED: same as undefined: id "poverty100", vars ["B17001_002E"].
    { id: "li-poverty100", call: "ServiceEquity.lowIncomeSpec", args: ["poverty100"] },
    // EXPECTED: id "poverty200", label "Below 200% of the poverty level", six vars C17002_002E through C17002_007E.
    { id: "li-poverty200", call: "ServiceEquity.lowIncomeSpec", args: ["poverty200"] },
    // EXPECTED: unrecognized value falls back to id "poverty100", vars ["B17001_002E"].
    { id: "li-bogus", call: "ServiceEquity.lowIncomeSpec", args: ["bogus"] },

    // ---- distanceMi ----------------------------------------------------------
    // EXPECTED: 0 (both deltas are zero, so the haversine term is zero).
    { id: "dist-same-point", call: "ServiceEquity.distanceMi", args: [39.7, -105, 39.7, -105] },
    // EXPECTED: 3958.7613 x 0.1 x pi/180 = 6.9093 (a pure north-south move is R x delta-lat in radians).
    { id: "dist-0.1deg-lat", call: "ServiceEquity.distanceMi", args: [39.7, -105, 39.8, -105] },
    // EXPECTED: 3958.7613 x pi/180 = 69.0934 (one degree of longitude on the equator).
    { id: "dist-1deg-lon-equator", call: "ServiceEquity.distanceMi", args: [0, 0, 0, 1] },

    // ---- allocateStopTrips ---------------------------------------------------
    // Two blocks inside the radius, in different block groups of one tract. W = 30 + 70 = 100.
    // EXPECTED: tripsByGeo {"080310001001": 30, "080310001002": 70}, unallocated [], unallocatedTrips 0, allocatedStops 1.
    { id: "alloc-two-block-groups", call: "ServiceEquity.allocateStopTrips", args: [
      [STOP_100],
      [
        { geoid: BLK_BG1, lat: LAT + 0.001, lon: LON, pop: 30 },
        { geoid: BLK_BG2, lat: LAT, lon: LON + 0.001, pop: 70 },
      ],
    ] },

    // Block A (pop 50) is inside. Block B is inside but has pop 0. Block C (pop 80) is 0.0037 degrees north,
    // about 0.2556 mi, just past the 0.25 mi radius.
    // EXPECTED: tripsByGeo {"080310001001": 100} (W = 50, so 100 x 50 / 50), unallocated [], allocatedStops 1.
    { id: "alloc-outside-and-zero-pop", call: "ServiceEquity.allocateStopTrips", args: [
      [STOP_100],
      [
        { geoid: BLK_BG1, lat: LAT + 0.001, lon: LON, pop: 50 },
        { geoid: BLK_BG2, lat: LAT, lon: LON + 0.001, pop: 0 },
        { geoid: BLK_OTHER_TRACT, lat: LAT + 0.0037, lon: LON, pop: 80 },
      ],
    ] },

    // The only block is about 0.1 degrees (about 6.9 mi) north, so the stop has no populated block to draw on.
    // EXPECTED: tripsByGeo {}, unallocated ["S-EMPTY"], unallocatedTrips 40, allocatedStops 0.
    { id: "alloc-no-populated-block", call: "ServiceEquity.allocateStopTrips", args: [
      [{ id: "S-EMPTY", lat: LAT, lon: LON, radiusMi: 0.25, trips: 40 }],
      [{ geoid: BLK_BG1, lat: LAT + 0.1, lon: LON, pop: 50 }],
    ] },

    // parentLength 11: both block groups fall in tract "08031000100", so they share one key.
    // EXPECTED: tripsByGeo {"08031000100": 100} (30 + 70), unallocated [], allocatedStops 1.
    { id: "alloc-parent-tract", call: "ServiceEquity.allocateStopTrips", args: [
      [STOP_100],
      [
        { geoid: BLK_BG1, lat: LAT + 0.001, lon: LON, pop: 30 },
        { geoid: BLK_BG2, lat: LAT, lon: LON + 0.001, pop: 70 },
      ],
      { parentLength: 11 },
    ] },

    // Both stops reach block A (pop 100, the only block), so each sends its full trips to it.
    // EXPECTED: tripsByGeo {"080310001001": 160} (100 + 60), unallocated [], allocatedStops 2.
    { id: "alloc-overlap-adds-up", call: "ServiceEquity.allocateStopTrips", args: [
      [
        { id: "S1", lat: LAT, lon: LON, radiusMi: 0.25, trips: 100 },
        { id: "S2", lat: LAT + 0.001, lon: LON, radiusMi: 0.25, trips: 60 },
      ],
      [{ geoid: BLK_BG1, lat: LAT + 0.0005, lon: LON, pop: 100 }],
    ] },

    // Three bad stops (trips 0, radius 0, NaN latitude) are ignored: they are not allocated and not unallocated.
    // EXPECTED: tripsByGeo {"080310001001": 100}, unallocated [], unallocatedTrips 0, allocatedStops 1.
    { id: "alloc-bad-stops-ignored", call: "ServiceEquity.allocateStopTrips", args: [
      [
        { id: "S-OK", lat: LAT, lon: LON, radiusMi: 0.25, trips: 100 },
        { id: "S-TRIPS0", lat: LAT, lon: LON, radiusMi: 0.25, trips: 0 },
        { id: "S-RADIUS0", lat: LAT, lon: LON, radiusMi: 0, trips: 50 },
        { id: "S-NAN", lat: NaN, lon: LON, radiusMi: 0.25, trips: 70 },
      ],
      [{ geoid: BLK_BG1, lat: LAT + 0.001, lon: LON, pop: 50 }],
    ] },

    // The null-GEOID block (pop 50) cannot receive trips, so it is left out of W; the BG1 block then carries all 100.
    // EXPECTED: tripsByGeo {"080310001001": 100}, unallocated [], allocatedStops 1.
    { id: "alloc-null-geoid-excluded", call: "ServiceEquity.allocateStopTrips", args: [
      [STOP_100],
      [
        { geoid: null, lat: LAT + 0.001, lon: LON, pop: 50 },
        { geoid: BLK_BG1, lat: LAT, lon: LON + 0.001, pop: 50 },
      ],
    ] },

    // EXPECTED: tripsByGeo {}, unallocated [], unallocatedTrips 0, allocatedStops 0.
    { id: "alloc-null-inputs", call: "ServiceEquity.allocateStopTrips", args: [null, null] },

    // ---- evaluate ------------------------------------------------------------
    // Minority: avg 180/400 = 0.45. G1/G2 (0.8) are protected, perCapita 20/200 = 0.1. G3/G4 (0.1) are other, perCapita 100/200 = 0.5.
    // Ratio 0.1/0.5 = 0.2, so disparity. Low income: avg 100/400 = 0.25; G3/G4 (0.3) protected, perCapita 0.5; G1/G2 other, 0.1; ratio 5.
    // EXPECTED: minority band "disparity" (ratio 0.2), lowIncome band "no-disparity" (ratio 5), totals {pop 400, trips 120, perCapita 0.3}.
    { id: "ev-four-geos-disparity", call: "ServiceEquity.evaluate", args: [FOUR_GEOS] },

    // Both geographies sit exactly at the average share (minority 0.5, low income 0.2). Strictly-greater means none is protected.
    // EXPECTED: both bands "insufficient" with ratio null; protected {geoCount 0, pop 0, trips 0, perCapita 0}; other {geoCount 2, pop 200, trips 40, perCapita 0.2}.
    { id: "ev-all-equal-insufficient", call: "ServiceEquity.evaluate", args: [[
      { geoid: "A", pop: 100, minorityPop: 50, lowIncomePop: 20, trips: 10 },
      { geoid: "B", pop: 100, minorityPop: 50, lowIncomePop: 20, trips: 30 },
    ]] },

    // EXPECTED: totals {pop 0, trips 0, perCapita 0}; both bands "insufficient" with ratio null; geos []; fourFifths 0.8.
    { id: "ev-empty-rows", call: "ServiceEquity.evaluate", args: [[]] },

    // EXPECTED: same as the empty-rows case (a non-array input is treated as no rows).
    { id: "ev-null-rows", call: "ServiceEquity.evaluate", args: [null] },

    // Z has pop 0, so it sits in neither group, but its 5 trips still count in totals.trips.
    // Minority avg 90/200 = 0.45: A protected (perCapita 0.1), B other (0.5), ratio 0.2, disparity. Low income avg 50/200 = 0.25: B protected (0.5), A other (0.1), ratio 5.
    // EXPECTED: totals {pop 200, trips 65, perCapita 0.325}; geo Z {pop 0, trips 5, perCapita 0, both shares 0, both flags false}; A isMinority true; B isLowIncome true.
    { id: "ev-pop0-row-in-neither-group", call: "ServiceEquity.evaluate", args: [[
      { geoid: "Z", pop: 0, minorityPop: 0, lowIncomePop: 0, trips: 5 },
      { geoid: "A", pop: 100, minorityPop: 80, lowIncomePop: 20, trips: 10 },
      { geoid: "B", pop: 100, minorityPop: 10, lowIncomePop: 30, trips: 50 },
    ]] },

    // NaN population becomes 0 and the negative and text values become 0, so Y's shares are 0 and nothing is protected.
    // EXPECTED: totals {pop 100, trips 15, perCapita 0.15}; both bands "insufficient"; geo X {pop 0, trips 5, perCapita 0, flags false}; Y {pop 100, trips 10, perCapita 0.1, shares 0, flags false}.
    { id: "ev-bad-values-as-zero", call: "ServiceEquity.evaluate", args: [[
      { geoid: "X", pop: NaN, minorityPop: 1, lowIncomePop: 1, trips: 5 },
      { geoid: "Y", pop: 100, minorityPop: -20, lowIncomePop: "abc", trips: 10 },
    ]] },

    // Minority avg 160/400 = 0.5: A (0.8) protected, perCapita 80/200 = 0.4; B (0.2) other, perCapita 100/200 = 0.5.
    // Ratio 0.4/0.5 = 0.8 exactly, which is not below 0.8, so no-disparity. Low income has no minority-style spread (all 0), so insufficient.
    // EXPECTED: minority ratio 0.8, band "no-disparity"; lowIncome band "insufficient".
    { id: "ev-ratio-exactly-threshold", call: "ServiceEquity.evaluate", args: [[
      { geoid: "A", pop: 200, minorityPop: 160, lowIncomePop: 0, trips: 80 },
      { geoid: "B", pop: 200, minorityPop: 40, lowIncomePop: 0, trips: 100 },
    ]] },

    // Same two geographies with A trips 85: minority ratio 0.425 / 0.5 = 0.85. Above 0.8, so no-disparity at the default threshold.
    // EXPECTED: minority ratio 0.85, band "no-disparity", fourFifths 0.8.
    { id: "ev-default-threshold-0.85", call: "ServiceEquity.evaluate", args: [[
      { geoid: "A", pop: 200, minorityPop: 160, lowIncomePop: 0, trips: 85 },
      { geoid: "B", pop: 200, minorityPop: 40, lowIncomePop: 0, trips: 100 },
    ]] },

    // The same 0.85 ratio is below a 0.9 threshold, so the band changes to disparity.
    // EXPECTED: minority ratio 0.85, band "disparity", fourFifths 0.9.
    { id: "ev-fourFifths-0.9-changes-band", call: "ServiceEquity.evaluate", args: [[
      { geoid: "A", pop: 200, minorityPop: 160, lowIncomePop: 0, trips: 85 },
      { geoid: "B", pop: 200, minorityPop: 40, lowIncomePop: 0, trips: 100 },
    ], { fourFifths: 0.9 }] },
  ],
};
