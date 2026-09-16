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

  // Single global snap tolerance shared by Walkshed and Transit Travelshed —
  // never per-module state (see docs/network-connectors-plan.md §2). Persisted
  // as an additive field in the core session-cache state (cache.js), same
  // pattern as featureSortMode — defaults gracefully when absent.
  App.networkSettings = App.networkSettings || { snapToleranceFt: 50 };

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
  function refreshWalkNetworkLayer() {
    var map = App.map;
    if (!map) return;

    var loaded = typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
    if (!loaded) {
      if (map.getLayer(WN_LAYER)) map.removeLayer(WN_LAYER);
      if (map.getSource(WN_SRC)) map.removeSource(WN_SRC);
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
  }

  App.refreshWalkNetworkLayer = refreshWalkNetworkLayer;
  App.refreshNetworkConnectors = refreshNetworkConnectors;
  App.getConnectorReport = getConnectorReport;

})();
