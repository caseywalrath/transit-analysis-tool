// js/core/walk-cost.js
// Intersection crossing-penalty classification + cost math (window.WalkCost).
// CONSTRAINT: plain-value math only — no turf, DOM, Map/Set or App state — so
// the golden harness can load it into a bare node:vm sandbox (road-network.js,
// the only consumer, cannot be golden-tested).
// Node-uniform, not turn-aware (deliberate approximation); motorway/trunk never
// reach it (already pedBlocked). Detail: docs/reference/road-network.md

(function () {
  "use strict";

  // primary/secondary (+ their _link ramp forms) count as "major". Everything
  // else — including tertiary, which is usually a collector and often
  // unsignalized — counts as "minor". This is a deliberate choice, not an
  // oversight; keep tertiary out of MAJOR_HWY.
  var MAJOR_HWY = {
    primary: true, primary_link: true,
    secondary: true, secondary_link: true
  };

  // hwy -> "major" | "minor". Unknown/absent classes (connector edges have no
  // OSM class) default to "minor".
  function roadTier(hwy) {
    return MAJOR_HWY[hwy || ""] ? "major" : "minor";
  }

  // hwyList: the highway classes of every edge meeting at one node.
  // Fewer than 3 edges = shape point (2) or dead end (1), not an intersection —
  // this keeps the penalty off the many geometry vertices.
  function nodeTier(hwyList) {
    if (!hwyList || hwyList.length < 3) return null;
    for (var i = 0; i < hwyList.length; i++) {
      if (roadTier(hwyList[i]) === "major") return "major";
    }
    return "minor";
  }

  // tier: "major" | "minor" | null. settings: { majorSec, minorSec, speedKmh }.
  // A fixed S-second delay consumes speedKmh * S / 3600 km, so the penalty
  // stays a constant number of SECONDS regardless of walk speed.
  function penaltyKm(tier, settings) {
    if (!tier) return 0;
    settings = settings || {};
    var speedKmh = settings.speedKmh || 0;
    var sec = tier === "major" ? settings.majorSec : settings.minorSec;
    if (!sec || !speedKmh) return 0;
    return speedKmh * sec / 3600;
  }

  window.WalkCost = {
    roadTier: roadTier,
    nodeTier: nodeTier,
    penaltyKm: penaltyKm
  };

})();
