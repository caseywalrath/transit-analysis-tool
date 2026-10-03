// js/core/walk-audit.js
// Sidewalk-data audit (window.WalkAudit) + the Sidewalk coverage layer/summary.
// CONSTRAINT: the top section is plain-value math only — no turf, DOM, Map/Set
// or App state — so the golden harness loads it into a bare node:vm sandbox.
// The App-level block below uses App members only at call time.
// Detail: docs/reference/road-network.md (design: docs/sidewalk-data-plan.md)

(function () {
  "use strict";

  // footway=sidewalk (or a pedestrian-class hwy) means the segment IS separately
  // mapped sidewalk geometry, so sidewalk= doesn't apply; everything else is
  // judged by the sidewalk= tag on the road centerline.
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

  // segments: the App.getWalkNetworkSegments() shape. `crossing` is read
  // defensively: road-network.js does not currently put it on segment records,
  // so live counts come from footway=crossing only.
  // Empty input yields all zeros, never NaN.
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

  // ---- App-level block ----

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

  // Insert below drawn features (same as network-connectors.js / gtfs.js).
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

  // Rebuilds the sidewalk-coverage layer; removed entirely when no network is
  // loaded. Hidden by default — an opt-in audit overlay with its own toggle,
  // independent of walk-network-line.
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

  // ---- Coverage statistics ----

  // Below this, sidewalk-only routing would be unreliable — the flood would
  // confidently under-report reachability.
  var LOW_COVERAGE_PCT = 25;

  // { text, detail, warn } like App.getConnectorReportSummary(). null when no
  // network is loaded, so callers hide the line instead of a misleading "0%".
  function getSidewalkCoverageSummary() {
    var loaded = typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
    if (!loaded) return null;

    var segments = typeof App.getWalkNetworkSegments === "function"
      ? App.getWalkNetworkSegments() : [];
    var stats = WalkAudit.coverageStats(segments);

    var text = "Sidewalks: " + Math.round(stats.pctTagged) + "% of streets tagged · " +
      Math.round(stats.pctBoth) + "% both sides · " +
      stats.crossingCount.toLocaleString() + " crossing" + (stats.crossingCount === 1 ? "" : "s");

    var warn = stats.pctTagged < LOW_COVERAGE_PCT;
    var detail = warn
      ? "Low sidewalk-attribute coverage here — treat sidewalk-only routing (if enabled) as unreliable."
      : null;

    return { text: text, detail: detail, warn: warn };
  }

  App.getSidewalkCoverageSummary = getSidewalkCoverageSummary;

})();
