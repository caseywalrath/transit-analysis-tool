// js/core/walk-cost.js
// Intersection crossing-penalty classification + cost math (window.WalkCost),
// the same engine-namespace convention as window.ConnectorGraph / window.TPI.
//
// CONSTRAINT: this file contains ONLY plain-value math — no turf, no DOM, no
// Map/Set, no App state. Why: the golden harness (test/run-golden.mjs) loads
// this file directly into a bare node:vm sandbox with no turf and no browser
// globals. js/core/road-network.js (which needs turf/App state) is the only
// consumer and cannot itself be golden-tested; this file exists precisely so
// the crossing-penalty math still can be.
//
// See docs/walkshed-bands-and-crossing-penalties-plan.md Phase 4 for the
// design. Node-uniform, not turn-aware — a deliberate, documented
// approximation (see the plan's §0.6); motorway/trunk classes never reach
// this file because they are already pedBlocked upstream in road-network.js.

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
  // Fewer than 3 edges means the node is a shape point on a curve (2) or a
  // dead end (1), not an intersection — no penalty applies there. This is
  // what keeps the penalty off the tens of thousands of geometry vertices
  // that aren't real intersections.
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
