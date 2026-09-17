// js/core/network-connectors.js
// Network Connectors: lets user-drawn Line features join the offline walk
// network so Walkshed / Transit Travelshed can model planned or hypothetical
// pedestrian connections. See docs/network-connectors-plan.md for the full
// design and phased build order.
//
// Phase 1: a discreet, hideable reference layer showing the walkable network
// (App.getWalkNetworkSegments(), road-network.js) so a user can see where to
// draw a connector.
//
// Phase 4 (this file, current cut): the App-level orchestration layer. Owns
// the global App.networkSettings (snap tolerance, shared by Walkshed and
// Transit Travelshed — see the plan's §2 "Known conflict"), collects
// networkRole:"connector" Lines from App.lines, and drives
// App.setNetworkConnectors() (road-network.js) with a cheap signature guard
// so it is safe to call from App.notifyProject(), vertex-drag-end, and
// attribute onChange handlers without debouncing.
//
// Depends on: App.map, App.lines, App.getWalkNetworkSegments/roadNetworkLoaded/
// setNetworkConnectors (road-network.js).
// Exports: App.refreshWalkNetworkLayer, App.refreshNetworkConnectors,
//          App.getConnectorReport

(function () {
  "use strict";
  var App = window.App;

  var WN_SRC = "walk-network";
  var WN_LAYER = "walk-network-line";
  var NJ_SRC = "network-joins";
  var NJ_LAYER = "network-joins-point";

  // Single global snap tolerance shared by Walkshed and Transit Travelshed —
  // never per-module state (see docs/network-connectors-plan.md §2). Persisted
  // as an additive field in the core session-cache state (cache.js), same
  // pattern as featureSortMode — defaults gracefully when absent.
  //
  // crossingMajorSec/crossingMinorSec (docs/walkshed-bands-and-crossing-
  // penalties-plan.md Phase 5): the same kind of global, shared setting,
  // default 0 = off (opt-in only, no behavior change until the user raises
  // one). `|| {}` above short-circuits on an already-created object, so
  // backfill the two new keys defensively when they're absent (e.g. a page
  // that only ever set snapToleranceFt before this phase shipped).
  App.networkSettings = App.networkSettings || { snapToleranceFt: 50, crossingMajorSec: 0, crossingMinorSec: 0 };
  if (App.networkSettings.crossingMajorSec == null) App.networkSettings.crossingMajorSec = 0;
  if (App.networkSettings.crossingMinorSec == null) App.networkSettings.crossingMinorSec = 0;

  var FT_TO_KM = 0.0003048;

  var _lastSignature = null;
  var _lastReport = null;

  // Scans App.lines for networkRole:"connector" Lines, skipping hidden
  // features. road-network.js never reads App.lines directly — this is the
  // one place that translation happens.
  function collectConnectorLines() {
    var lines = App.lines || [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i];
      if (!f || !f.properties || f.properties.hidden) continue;
      var attrs = f.properties.attributes;
      if (!attrs || attrs.networkRole !== "connector") continue;
      var coords = f.geometry && f.geometry.coordinates;
      if (!coords || coords.length < 2) continue;
      out.push({ id: "line:" + i, coords: coords });
    }
    return out;
  }

  // Cheap no-op guard: computes a signature from the collected connector
  // geometries + tolerance and skips the rebuild entirely when unchanged.
  // This is what makes it safe to call from App.notifyProject(), vertex-
  // drag-end, and every attribute onChange without debouncing (plan §3).
  function refreshNetworkConnectors() {
    var connectors = collectConnectorLines();
    var toleranceFt = (App.networkSettings && App.networkSettings.snapToleranceFt) || 50;
    var signature = JSON.stringify(connectors) + "|" + toleranceFt;

    if (signature === _lastSignature) return _lastReport;
    _lastSignature = signature;

    if (typeof App.setNetworkConnectors === "function") {
      _lastReport = App.setNetworkConnectors(connectors, { snapToleranceKm: toleranceFt * FT_TO_KM }) || null;
    }
    refreshWalkNetworkLayer();
    return _lastReport;
  }

  function getConnectorReport() {
    return _lastReport;
  }

  // Resolves a report's connectorId ("line:"+idx, see collectConnectorLines())
  // back to that Line's display name, for the connection-report footer
  // (Phase 6). Falls back to a generic label if the Line no longer exists.
  function getConnectorLineName(connectorId) {
    var m = /^line:(\d+)$/.exec(connectorId || "");
    if (!m) return connectorId || "Connector";
    var idx = parseInt(m[1], 10);
    var f = App.lines && App.lines[idx];
    return (f && f.properties && f.properties.name) || "Line " + (idx + 1);
  }

  var FT_PER_KM = 3280.84;

  // Builds a summary of the current connector report for the Walkshed /
  // Transit Travelshed results footers (Phase 6), or null when there are no
  // connectors to report on. { text, detail, warn } — warn is true when at
  // least one connector end is unconnected, so callers can style it like the
  // rest of their footer's warning treatment; detail names the worst-off
  // orphan (nearest street distance in feet) when warn is true, else null.
  function getConnectorReportSummary() {
    var report = _lastReport;
    if (!report || report.reason) return null;
    var connectorCount = collectConnectorLines().length;
    if (!connectorCount) return null;

    var joinCount = (report.joins || []).length;
    var orphans = report.orphans || [];
    var text = connectorCount + " walk connector" + (connectorCount === 1 ? "" : "s") +
      " · " + joinCount + " join" + (joinCount === 1 ? "" : "s");
    if (orphans.length) {
      text += " · " + orphans.length + " end" + (orphans.length === 1 ? "" : "s") + " not connected";
    }

    var detail = null;
    if (orphans.length) {
      var worst = orphans[0];
      for (var i = 1; i < orphans.length; i++) {
        if (orphans[i].nearestKm == null) continue;
        if (worst.nearestKm == null || orphans[i].nearestKm < worst.nearestKm) worst = orphans[i];
      }
      var name = getConnectorLineName(worst.connectorId);
      detail = worst.nearestKm != null
        ? "“" + name + "” — nearest street is " + Math.round(worst.nearestKm * FT_PER_KM) + " ft away"
        : "“" + name + "” has no nearby street to join";
    }

    return { text: text, detail: detail, warn: orphans.length > 0 };
  }

  // Same "insert below drawn features" convention as gtfs.js's firstUserLayer().
  function firstUserLayer() {
    var map = App.map;
    var candidates = ["points-layer", "lines-layer", "routes-layer", "polygons-fill"];
    for (var i = 0; i < candidates.length; i++) {
      if (map.getLayer(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  function segmentsToGeoJSON(segments) {
    var features = new Array(segments.length);
    for (var i = 0; i < segments.length; i++) {
      features[i] = {
        type: "Feature",
        properties: { kind: segments[i].kind },
        geometry: { type: "LineString", coordinates: segments[i].coords }
      };
    }
    return { type: "FeatureCollection", features: features };
  }

  // Rebuilds the walk-network reference layer from current network state.
  // Removes the source/layer entirely when no network is loaded, so the
  // Layers panel row disappears rather than showing an empty toggle.
  // Also the single choke point that keeps the join/orphan marker layer
  // (Phase 6) in sync: it's called from road-network.js's updateUI() on
  // every download/import/clear AND from refreshNetworkConnectors() after
  // every overlay rebuild, so re-syncing _lastReport from the raw overlay
  // report here covers a base-network reload too (which re-runs
  // applyConnectorOverlay via rebuildNetwork() without going through
  // App.setNetworkConnectors(), so refreshNetworkConnectors()'s own cache
  // update alone would miss it).
  function refreshWalkNetworkLayer() {
    var map = App.map;
    if (!map) return;

    if (typeof App.getLastConnectorOverlayReport === "function") {
      var raw = App.getLastConnectorOverlayReport();
      if (raw) _lastReport = raw;
    }

    var loaded = typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
    if (!loaded) {
      if (map.getLayer(WN_LAYER)) map.removeLayer(WN_LAYER);
      if (map.getSource(WN_SRC)) map.removeSource(WN_SRC);
      if (map.getLayer(NJ_LAYER)) map.removeLayer(NJ_LAYER);
      if (map.getSource(NJ_SRC)) map.removeSource(NJ_SRC);
      return;
    }

    var segments = typeof App.getWalkNetworkSegments === "function"
      ? App.getWalkNetworkSegments() : [];
    var fc = segmentsToGeoJSON(segments);

    if (!map.getSource(WN_SRC)) {
      map.addSource(WN_SRC, { type: "geojson", data: fc });
      map.addLayer({
        id: WN_LAYER,
        type: "line",
        source: WN_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#94a3b8",
          "line-width": 1,
          "line-opacity": 0.45
        }
      }, firstUserLayer());
    } else {
      map.getSource(WN_SRC).setData(fc);
    }

    refreshJoinMarkers();
  }

  // Builds the join/orphan marker layer (Phase 6) from the cached report's
  // joins ("crossing"|"weld") and orphans, so a dangling connector end is
  // findable at a glance. One data-driven layer, not three, matching the
  // plan's stated requirement. Inserted just below the same beforeLayer as
  // the walk-network line, so it stacks above it but still under drawn
  // features.
  function joinsToGeoJSON(report) {
    var features = [];
    if (!report || report.reason) return { type: "FeatureCollection", features: features };
    (report.joins || []).forEach(function (j) {
      features.push({
        type: "Feature",
        properties: { kind: j.kind },
        geometry: { type: "Point", coordinates: j.point }
      });
    });
    (report.orphans || []).forEach(function (o) {
      features.push({
        type: "Feature",
        properties: { kind: "orphan" },
        geometry: { type: "Point", coordinates: o.point }
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  function refreshJoinMarkers() {
    var map = App.map;
    if (!map) return;
    var fc = joinsToGeoJSON(_lastReport);

    if (!map.getSource(NJ_SRC)) {
      map.addSource(NJ_SRC, { type: "geojson", data: fc });
      map.addLayer({
        id: NJ_LAYER,
        type: "circle",
        source: NJ_SRC,
        paint: {
          // crossing/weld: small filled muted dot. orphan: larger hollow
          // circle in a warning color, so an unconnected end reads at a glance.
          "circle-radius": ["match", ["get", "kind"], "orphan", 5, 3],
          "circle-color": ["match", ["get", "kind"], "orphan", "rgba(180,83,9,0.08)", "#64748b"],
          "circle-stroke-width": ["match", ["get", "kind"], "orphan", 2, 0],
          "circle-stroke-color": "#b45309",
          "circle-opacity": 0.85
        }
      }, firstUserLayer());
    } else {
      map.getSource(NJ_SRC).setData(fc);
    }
  }

  App.refreshWalkNetworkLayer = refreshWalkNetworkLayer;
  App.refreshNetworkConnectors = refreshNetworkConnectors;
  App.getConnectorReport = getConnectorReport;
  App.getConnectorReportSummary = getConnectorReportSummary;

})();
