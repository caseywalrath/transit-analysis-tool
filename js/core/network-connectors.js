// js/core/network-connectors.js
// Network Connectors: lets user-drawn Line features join the offline walk
// network so Walkshed / Transit Travelshed can model planned or hypothetical
// pedestrian connections. See docs/network-connectors-plan.md for the full
// design and phased build order.
//
// Phase 1 (this file, initial cut): a discreet, hideable reference layer
// showing the walkable network (App.getWalkNetworkSegments(), road-network.js)
// so a user can see where to draw a connector. No connector graph logic yet —
// that arrives in later phases (connector-graph.js, the networkRole attribute,
// welding/splitting integration).
//
// Depends on: App.map, App.getWalkNetworkSegments (road-network.js).
// Exports: App.refreshWalkNetworkLayer

(function () {
  "use strict";
  var App = window.App;

  var WN_SRC = "walk-network";
  var WN_LAYER = "walk-network-line";

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

})();
