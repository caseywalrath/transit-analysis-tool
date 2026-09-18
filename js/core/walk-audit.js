// js/core/walk-audit.js
// Sidewalk-data audit engine (window.WalkAudit), the same engine-namespace
// convention as window.WalkCost / window.ConnectorGraph / window.Travelshed.
// See docs/sidewalk-data-plan.md for the full design and phased build order.
//
// CONSTRAINT: the top section contains ONLY plain-value math — no turf, no
// DOM, no Map/Set, no App state — so the golden harness (test/run-golden.mjs)
// loads it directly into a bare node:vm sandbox. The App-level block below it
// reads window.App only inside function bodies, never at load time, following
// the same rule js/core/walk-cost.js / js/core/layer-palettes.js already
// follow.
//
// Phase 1 (js/core/road-network.js) already captured sidewalk/footway/wayId
// onto _segmentIndex. This file starts at Phase 2: turning those tags into a
// visible coverage layer.

(function () {
  "use strict";

  // seg.footway === "sidewalk" (or a pedestrian-class hwy) means this segment
  // IS mapped sidewalk/footway geometry — a different way than the road
  // centerline it may run alongside — so the sidewalk= attribute doesn't
  // apply to it at all. Everything else is judged by the sidewalk= tag on the
  // centerline itself.
  var FOOTWAY_HWY = {
    footway: true, path: true, steps: true, pedestrian: true, cycleway: true
  };

  // seg: plain object with optional .footway, .hwy, .sidewalk strings.
  // Returns one of "footway" | "both" | "one-side" | "none" | "unknown".
  function classifySidewalk(seg) {
    seg = seg || {};
    var footway = seg.footway || "";
    var hwy = seg.hwy || "";
    if (footway === "sidewalk" || FOOTWAY_HWY[hwy]) return "footway";

    var sw = (seg.sidewalk || "").toLowerCase();
    if (sw === "both" || sw === "yes") return "both";
    if (sw === "left" || sw === "right") return "one-side";
    if (sw === "no" || sw === "none" || sw === "separate") return "none";
    return "unknown";
  }

  // Equirectangular approximation, matching the projection road-network.js
  // uses for snapping — deliberately turf-free so this stays golden-testable.
  var KM_PER_DEG_LAT = 110.574;
  function segmentLengthKm(coords) {
    if (!coords || coords.length < 2) return 0;
    var a = coords[0], b = coords[1];
    var midLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180;
    var kmPerDegLng = 111.320 * Math.cos(midLatRad);
    var dLat = (b[1] - a[1]) * KM_PER_DEG_LAT;
    var dLng = (b[0] - a[0]) * kmPerDegLng;
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  // segments: array of { coords, footway, hwy, sidewalk, crossing } — the
  // shape App.getWalkNetworkSegments() returns (plus a "crossing" field,
  // carried straight from Overpass, that road-network.js does not currently
  // put on segment records — coverageStats() reads it defensively so a
  // future caller can add it without this function changing).
  // Returns a plain object; empty input yields all zeros, never NaN.
  function coverageStats(segments) {
    segments = segments || [];
    var roadKm = 0, footwayKm = 0, crossingCount = 0;
    var byClass = { both: 0, oneSide: 0, none: 0, unknown: 0 };

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var lenKm = segmentLengthKm(seg.coords);
      var cls = classifySidewalk(seg);

      if (cls === "footway") {
        footwayKm += lenKm;
      } else {
        roadKm += lenKm;
        if (cls === "both") byClass.both += lenKm;
        else if (cls === "one-side") byClass.oneSide += lenKm;
        else if (cls === "none") byClass.none += lenKm;
        else byClass.unknown += lenKm;
      }

      if ((seg.footway || "") === "crossing" || (seg.crossing || "")) crossingCount++;
    }

    var taggedKm = byClass.both + byClass.oneSide + byClass.none;
    var pctTagged = roadKm > 0 ? (taggedKm / roadKm) * 100 : 0;
    var pctBoth = roadKm > 0 ? (byClass.both / roadKm) * 100 : 0;

    return {
      roadKm: roadKm,
      footwayKm: footwayKm,
      crossingCount: crossingCount,
      byClass: byClass,
      pctTagged: pctTagged,
      pctBoth: pctBoth
    };
  }

  window.WalkAudit = {
    classifySidewalk: classifySidewalk,
    coverageStats: coverageStats
  };

  // ---- App-level block (docs/sidewalk-data-plan.md Phase 2) ----
  // Reads window.App only inside function bodies, never at load time, so this
  // file still loads cleanly in the golden-test sandbox (no App/turf/Map
  // globals there).

  var App = window.App;

  var SW_SRC = "sidewalk-coverage";
  var SW_LAYER = "sidewalk-coverage-line";

  var COVERAGE_COLORS = {
    both: "#16a34a",
    "one-side": "#f59e0b",
    none: "#dc2626",
    footway: "#2563eb",
    unknown: "#94a3b8"
  };

  // Same "insert below drawn features" convention as network-connectors.js's
  // firstUserLayer() / gtfs.js's firstUserLayer().
  function firstUserLayer() {
    var map = App.map;
    var candidates = ["points-layer", "lines-layer", "routes-layer", "polygons-fill"];
    for (var i = 0; i < candidates.length; i++) {
      if (map.getLayer(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  function segmentsToCoverageGeoJSON(segments) {
    var features = new Array(segments.length);
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      features[i] = {
        type: "Feature",
        properties: { cov: WalkAudit.classifySidewalk(seg) },
        geometry: { type: "LineString", coordinates: seg.coords }
      };
    }
    return { type: "FeatureCollection", features: features };
  }

  // Rebuilds the sidewalk-coverage reference layer from current network
  // state. Removes the source/layer entirely when no network is loaded, same
  // convention as network-connectors.js's refreshWalkNetworkLayer(). Default
  // visibility is hidden — this is an audit overlay the user opts into, not
  // the walk network itself (docs/sidewalk-data-plan.md §2: different
  // semantics, independent toggle from walk-network-line).
  function refreshSidewalkCoverageLayer() {
    var map = App && App.map;
    if (!map) return;

    var loaded = typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
    if (!loaded) {
      if (map.getLayer(SW_LAYER)) map.removeLayer(SW_LAYER);
      if (map.getSource(SW_SRC)) map.removeSource(SW_SRC);
      return;
    }

    var segments = typeof App.getWalkNetworkSegments === "function"
      ? App.getWalkNetworkSegments() : [];
    var fc = segmentsToCoverageGeoJSON(segments);

    if (!map.getSource(SW_SRC)) {
      map.addSource(SW_SRC, { type: "geojson", data: fc });
      map.addLayer({
        id: SW_LAYER,
        type: "line",
        source: SW_SRC,
        layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
        paint: {
          "line-color": ["match", ["get", "cov"],
            "both", COVERAGE_COLORS.both,
            "one-side", COVERAGE_COLORS["one-side"],
            "none", COVERAGE_COLORS.none,
            "footway", COVERAGE_COLORS.footway,
            COVERAGE_COLORS.unknown],
          "line-width": ["match", ["get", "cov"], "footway", 2.5, 1.5],
          "line-opacity": 0.75
        }
      }, firstUserLayer());
    } else {
      map.getSource(SW_SRC).setData(fc);
    }
  }

  App.refreshSidewalkCoverageLayer = refreshSidewalkCoverageLayer;

})();
