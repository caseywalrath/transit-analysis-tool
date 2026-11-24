// Golden cases for the census-geography apportionment engine (window.Apportion).
// No deps — apportion.js is App/turf/DOM-free, so it loads clean in the vm
// sandbox. Every expected value in the comments was worked out by hand.

// GEOID layout: state(2) + county(3) + tract(6) = 11-char tract; block group = tract + 1 digit;
// block = block group + 3 digits.
const TRACT = "08031000100";     // 11 chars: state 08, county 031, tract 000100
const BG_A = "080310001001";     // 12 chars, in TRACT
const BG_B = "080310001002";     // 12 chars, in TRACT
const TRACT_2 = "08031000200";   // 11 chars, different tract
const BG_WY = "560210001001";    // 12 chars: state 56, county 021 (Wyoming)

const BASIC_BLOCKS = [
  { geoid: "080310001001001", pop: 400, hu: 0 },
  { geoid: "080310001001002", pop: 500, hu: 0 },
  { geoid: "080310001001003", pop: 300, hu: 0 },
];

export default {
  scripts: ["js/core/apportion.js"],
  cases: [
    // ---- blockWeightedFractions --------------------------------------------
    // 400 inside / (400 + 500 + 300) = 400 / 1200 = 1/3, basis "pop".
    { id: "bp-basic", call: "Apportion.blockWeightedFractions", args: [[BG_A], BASIC_BLOCKS, ["080310001001001"], null] },

    // Inside blocks both have pop 0; the outside block has 300. popAll = 300, popIn = 0 → 0, basis "pop".
    { id: "bp-all-park-inside", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 0, hu: 0 },
        { geoid: "080310001001002", pop: 0, hu: 0 },
        { geoid: "080310001001003", pop: 300, hu: 0 },
      ],
      ["080310001001001", "080310001001002"],
      null,
    ] },

    // popAll = 0, so housing units decide: 10 inside / (10 + 30) = 0.25, basis "hu".
    { id: "bp-zero-pop-uses-hu", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 0, hu: 10 },
        { geoid: "080310001001002", pop: 0, hu: 30 },
      ],
      ["080310001001001"],
      null,
    ] },

    // pop and hu are both 0, so the land-area fraction 0.3 is used, basis "area".
    { id: "bp-zero-all-uses-area", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 0, hu: 0 },
        { geoid: "080310001001002", pop: 0, hu: 0 },
      ],
      ["080310001001001"],
      { [BG_A]: 0.3 },
    ] },

    // No block starts with "080310009999" and there is no area fallback → 0, basis "none".
    { id: "bp-no-blocks-no-area", call: "Apportion.blockWeightedFractions", args: [["080310009999"], BASIC_BLOCKS, ["080310001001001"], null] },

    // Blocks 001 (400, inside) and 002 (500, outside) in BG_A, plus BG_B block 001 (100, inside).
    // Tract popAll = 400 + 500 + 100 = 1000; popIn = 400 + 100 = 500 → 0.5, basis "pop".
    // The block in tract 08031000200 (999, inside) is outside this tract and is ignored.
    { id: "bp-tract-prefix", call: "Apportion.blockWeightedFractions", args: [
      [TRACT],
      [
        { geoid: "080310001001001", pop: 400, hu: 0 },
        { geoid: "080310001001002", pop: 500, hu: 0 },
        { geoid: "080310001002001", pop: 100, hu: 0 },
        { geoid: "080310002001001", pop: 999, hu: 0 },
      ],
      ["080310001001001", "080310001002001", "080310002001001"],
      null,
    ] },

    // BG_A: 400 inside / (400 + 600) = 0.4, basis "pop" (BG_B's inside block 100 is excluded).
    // TRACT_2: 300 inside / (200 + 300) = 0.6, basis "pop" (BG_A's blocks are excluded).
    { id: "bp-mixed-lengths", call: "Apportion.blockWeightedFractions", args: [
      [BG_A, TRACT_2],
      [
        { geoid: "080310001001001", pop: 400, hu: 0 },
        { geoid: "080310001001002", pop: 600, hu: 0 },
        { geoid: "080310001002001", pop: 100, hu: 0 },
        { geoid: "080310002001001", pop: 200, hu: 0 },
        { geoid: "080310002001002", pop: 300, hu: 0 },
      ],
      ["080310001001001", "080310001002001", "080310002001002"],
      null,
    ] },

    // Block 001 pop 400 inside; 002 pop -5 inside; 003 pop NaN outside; 004 pop 600 outside.
    // -5 and NaN count as 0: popAll = 400 + 600 = 1000, popIn = 400 → 0.4, basis "pop".
    { id: "bp-negative-nan", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 400, hu: 0 },
        { geoid: "080310001001002", pop: -5, hu: 0 },
        { geoid: "080310001001003", pop: NaN, hu: 0 },
        { geoid: "080310001001004", pop: 600, hu: 0 },
      ],
      ["080310001001001", "080310001001002"],
      null,
    ] },

    // The first 001 entry (pop 400, inside) is kept; the second (pop 9999) is ignored.
    // 400 / (400 + 600) = 0.4, basis "pop".
    { id: "bp-duplicate-block", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 400, hu: 0 },
        { geoid: "080310001001001", pop: 9999, hu: 0 },
        { geoid: "080310001001002", pop: 600, hu: 0 },
      ],
      ["080310001001001"],
      null,
    ] },

    // All four arguments null → empty results, no throw.
    { id: "bp-null-inputs", call: "Apportion.blockWeightedFractions", args: [null, null, null, null] },

    // Both blocks inside: 400 + 600 = 1000 / 1000 = 1, basis "pop".
    { id: "bp-all-inside", call: "Apportion.blockWeightedFractions", args: [
      [BG_A],
      [
        { geoid: "080310001001001", pop: 400, hu: 0 },
        { geoid: "080310001001002", pop: 600, hu: 0 },
      ],
      ["080310001001001", "080310001001002"],
      null,
    ] },

    // Colorado BG_A: 200 inside / (200 + 200) = 0.5, basis "pop".
    // Wyoming BG_WY: 100 inside / (900 + 100) = 0.1, basis "pop". Each is computed independently.
    { id: "bp-cross-county", call: "Apportion.blockWeightedFractions", args: [
      [BG_A, BG_WY],
      [
        { geoid: "080310001001001", pop: 200, hu: 0 },
        { geoid: "080310001001002", pop: 200, hu: 0 },
        { geoid: "560210001001001", pop: 900, hu: 0 },
        { geoid: "560210001001002", pop: 100, hu: 0 },
      ],
      ["080310001001001", "560210001001002"],
      null,
    ] },

    // Extra: an area fraction above 1 is clamped to 1, basis "area" (no blocks at all).
    { id: "bp-area-clamp-high", call: "Apportion.blockWeightedFractions", args: [[BG_A], [], [], { [BG_A]: 1.7 }] },

    // Extra: an area fraction below 0 is clamped to 0, basis "area".
    { id: "bp-area-clamp-low", call: "Apportion.blockWeightedFractions", args: [[BG_A], [], [], { [BG_A]: -0.2 }] },

    // Extra: null and number geoids are skipped; only BG_A (1/3, basis "pop") appears in the output.
    { id: "bp-non-string-geoid-skipped", call: "Apportion.blockWeightedFractions", args: [[null, 42, BG_A], BASIC_BLOCKS, ["080310001001001"], null] },

    // Extra: a geoid requested twice appears once in the output, still 1/3 "pop".
    { id: "bp-duplicate-geoid", call: "Apportion.blockWeightedFractions", args: [[BG_A, BG_A], BASIC_BLOCKS, ["080310001001001"], null] },

    // ---- methodLabel -----------------------------------------------------------
    // "2020 census-block population"
    { id: "method-label-blockpop", call: "Apportion.methodLabel", args: ["blockPop"] },
    // "land area"
    { id: "method-label-area", call: "Apportion.methodLabel", args: ["area"] },
    // "whole geographies (no apportionment)"
    { id: "method-label-whole", call: "Apportion.methodLabel", args: ["whole"] },
    // Unknown method → "land area"
    { id: "method-label-unknown", call: "Apportion.methodLabel", args: ["bogus"] },
  ],
};
