// Golden cases for the pure intersection crossing-penalty engine
// (window.WalkCost). No deps — walk-cost.js is turf/DOM/Map/App free by
// design (see the header comment in js/core/walk-cost.js), so it loads clean
// in the vm sandbox, same as connector-graph.mjs.

export default {
  scripts: ["js/core/walk-cost.js"],
  cases: [
    // ---- roadTier -----------------------------------------------------
    { id: "road-tier-primary-major", call: "WalkCost.roadTier", args: ["primary"] },
    { id: "road-tier-secondary-link-major", call: "WalkCost.roadTier", args: ["secondary_link"] },
    { id: "road-tier-tertiary-minor", call: "WalkCost.roadTier", args: ["tertiary"] },
    { id: "road-tier-residential-minor", call: "WalkCost.roadTier", args: ["residential"] },
    { id: "road-tier-empty-string-minor", call: "WalkCost.roadTier", args: [""] },
    { id: "road-tier-unknown-minor", call: "WalkCost.roadTier", args: ["some_unknown_class"] },

    // ---- nodeTier -------------------------------------------------------
    { id: "node-tier-4way-with-primary-major", call: "WalkCost.nodeTier", args: [["residential", "residential", "primary", "residential"]] },
    { id: "node-tier-4way-all-residential-minor", call: "WalkCost.nodeTier", args: [["residential", "residential", "residential", "residential"]] },
    { id: "node-tier-2edge-null", call: "WalkCost.nodeTier", args: [["residential", "residential"]] },
    { id: "node-tier-1edge-null", call: "WalkCost.nodeTier", args: [["residential"]] },
    { id: "node-tier-empty-null", call: "WalkCost.nodeTier", args: [[]] },

    // ---- penaltyKm --------------------------------------------------------
    // 20 s at 5 km/h: 5 * 20 / 3600 km.
    { id: "penalty-km-major-20s-5kmh", call: "WalkCost.penaltyKm", args: ["major", { majorSec: 20, minorSec: 5, speedKmh: 5 }] },
    // 5 s at 5 km/h: 5 * 5 / 3600 km.
    { id: "penalty-km-minor-5s-5kmh", call: "WalkCost.penaltyKm", args: ["minor", { majorSec: 20, minorSec: 5, speedKmh: 5 }] },
    { id: "penalty-km-null-tier-zero", call: "WalkCost.penaltyKm", args: [null, { majorSec: 20, minorSec: 5, speedKmh: 5 }] },
    { id: "penalty-km-major-zero-sec-zero", call: "WalkCost.penaltyKm", args: ["major", { majorSec: 0, minorSec: 5, speedKmh: 5 }] },
    // Speed sensitivity: halving speedKmh must halve the returned km, proving
    // the same wall-clock delay is preserved regardless of walk speed.
    { id: "penalty-km-major-20s-5kmh-speed-pair-a", call: "WalkCost.penaltyKm", args: ["major", { majorSec: 20, minorSec: 5, speedKmh: 5 }] },
    { id: "penalty-km-major-20s-2p5kmh-speed-pair-b", call: "WalkCost.penaltyKm", args: ["major", { majorSec: 20, minorSec: 5, speedKmh: 2.5 }] },
  ],
};
