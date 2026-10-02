// Golden cases for the pure sidewalk-data audit engine (window.WalkAudit).
// No deps — walk-audit.js's top section is turf/DOM/Map/App free by design
// (see the header comment in js/core/walk-audit.js), so it loads clean in the
// vm sandbox, same as walk-cost.mjs.

export default {
  scripts: ["js/core/walk-audit.js"],
  cases: [
    // ---- classifySidewalk -------------------------------------------------
    { id: "classify-footway-tag", call: "WalkAudit.classifySidewalk", args: [{ footway: "sidewalk", hwy: "residential", sidewalk: "" }] },
    { id: "classify-footway-hwy-class", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "footway", sidewalk: "" }] },
    { id: "classify-path-hwy-class", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "path", sidewalk: "" }] },
    { id: "classify-both", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "both" }] },
    { id: "classify-yes-as-both", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "yes" }] },
    { id: "classify-left-one-side", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "left" }] },
    { id: "classify-right-one-side", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "right" }] },
    { id: "classify-no-as-none", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "no" }] },
    { id: "classify-none-as-none", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "none" }] },
    { id: "classify-separate-as-none", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "separate" }] },
    { id: "classify-junk-value-unknown", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential", sidewalk: "some_junk" }] },
    { id: "classify-absent-tag-unknown", call: "WalkAudit.classifySidewalk", args: [{ footway: "", hwy: "residential" }] },
    { id: "classify-empty-object-unknown", call: "WalkAudit.classifySidewalk", args: [{}] },

    // ---- coverageStats ------------------------------------------------------
    // Hand-built network: two "both"-tagged road segments (~0.1 km each,
    // roughly 1 km per degree of lat at these coordinates), one "none"
    // segment, one "unknown" (absent tag) segment, one footway segment (not
    // counted in roadKm), and one crossing segment.
    {
      id: "coverage-stats-mixed",
      call: "WalkAudit.coverageStats",
      args: [[
        { coords: [[-104.8, 38.8], [-104.8, 38.801]], footway: "", hwy: "residential", sidewalk: "both" },
        { coords: [[-104.8, 38.801], [-104.8, 38.802]], footway: "", hwy: "residential", sidewalk: "both" },
        { coords: [[-104.8, 38.802], [-104.8, 38.803]], footway: "", hwy: "primary", sidewalk: "no" },
        { coords: [[-104.8, 38.803], [-104.8, 38.804]], footway: "", hwy: "residential" },
        { coords: [[-104.81, 38.8], [-104.81, 38.801]], footway: "sidewalk", hwy: "footway", sidewalk: "" },
        { coords: [[-104.82, 38.8], [-104.82, 38.8001]], footway: "crossing", hwy: "footway", sidewalk: "" }
      ]]
    },
    { id: "coverage-stats-empty", call: "WalkAudit.coverageStats", args: [[]] },
    { id: "coverage-stats-null-input", call: "WalkAudit.coverageStats", args: [null] },
  ],
};
