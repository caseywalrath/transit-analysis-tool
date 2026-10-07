// js/core/network-connectors.js
// Network Connectors: lets user-drawn Lines (networkRole "connector") join the
// offline walk network. Owns the global App.networkSettings, the "Walk network"
// reference layer (incl. opt-in click-to-exclude streets) and join/orphan markers.
// The only App.lines -> plain-geometry translation for road-network.js.
// Depends on: App.map, App.lines, road-network.js (getWalkNetworkSegments,
//   roadNetworkLoaded, setNetworkConnectors, getLastConnectorOverlayReport, setExcludedWays).
// Exports: App.networkSettings, App.refreshWalkNetworkLayer, App.refreshNetworkConnectors,
//          App.getConnectorReport, App.getConnectorReportSummary,
//          App.setWayExclusionMode, App.isWayExclusionMode
// Detail: docs/reference/road-network.md

(function () {
  "use strict";
  var App = window.App;

  var WN_SRC = "walk-network";
  var WN_LAYER = "walk-network-line";
  var WN_EXCLUDED_LAYER = "walk-network-excluded-line";
  var NJ_SRC = "network-joins";
  var NJ_LAYER = "network-joins-point";

  // Global settings shared by Walkshed and Transit Travelshed — never per-module.
  // Persisted as additive session-cache fields (cache.js). Crossing penalties
  // default 0 = off. Missing keys are backfilled because an existing object
  // short-circuits the `||` default. excludedWayIds is written ONLY via
  // App.setExcludedWays(); never push into it directly.
  App.networkSettings = App.networkSettings || { snapToleranceFt: 50, crossingMajorSec: 0, crossingMinorSec: 0, excludedWayIds: [] };
  if (App.networkSettings.crossingMajorSec == null) App.networkSettings.crossingMajorSec = 0;
  if (App.networkSettings.crossingMinorSec == null) App.networkSettings.crossingMinorSec = 0;
  if (App.networkSettings.excludedWayIds == null) App.networkSettings.excludedWayIds = [];

  var FT_TO_KM = 0.0003048;

  var _lastSignature = null;
  var _lastReport = null;

  // networkRole:"connector" Lines, skipping hidden features.
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

  // Signature guard (geometry + tolerance) skips the rebuild when unchanged —
  // what makes it safe to call from App.notifyProject(), vertex drag-end and
  // attribute onChange without debouncing.
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

  // connectorId ("line:"+idx) -> that Line's display name, for the report footer.
  function getConnectorLineName(connectorId) {
    var m = /^line:(\d+)$/.exec(connectorId || "");
    if (!m) return connectorId || "Connector";
    var idx = parseInt(m[1], 10);
    var f = App.lines && App.lines[idx];
    return (f && f.properties && f.properties.name) || "Line " + (idx + 1);
  }

  var FT_PER_KM = 3280.84;

  // { text, detail, warn } for the Walkshed / Transit Travelshed footers, or
  // null when there are no connectors. warn = some connector end is
  // unconnected; detail then names the closest-to-joining orphan (ft), else null.
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
      var seg = segments[i];
      features[i] = {
        type: "Feature",
        // wayId drives hover/click exclusion (null on legacy imports — the
        // handlers guard on it); excluded drives the red/dashed layer.
        properties: { kind: seg.kind, excluded: !!seg.excluded, wayId: seg.wayId != null ? seg.wayId : null, name: seg.name || "" },
        geometry: { type: "LineString", coordinates: seg.coords }
      };
    }
    return { type: "FeatureCollection", features: features };
  }

  // Rebuilds the walk-network layers; removes them entirely when no network is
  // loaded (so the Layers row disappears). Also the choke point for join
  // markers: _lastReport is re-synced from the raw overlay report here because
  // a base-network reload re-runs the overlay without setNetworkConnectors(),
  // and the markers would otherwise go stale.
  function refreshWalkNetworkLayer() {
    var map = App.map;
    if (!map) return;

    if (typeof App.getLastConnectorOverlayReport === "function") {
      var raw = App.getLastConnectorOverlayReport();
      if (raw) _lastReport = raw;
    }

    var loaded = typeof App.roadNetworkLoaded === "function" && App.roadNetworkLoaded();
    if (!loaded) {
      if (map.getLayer(WN_HOVER_LAYER)) map.removeLayer(WN_HOVER_LAYER);
      if (map.getLayer(WN_EXCLUDED_LAYER)) map.removeLayer(WN_EXCLUDED_LAYER);
      if (map.getLayer(WN_LAYER)) map.removeLayer(WN_LAYER);
      if (map.getSource(WN_SRC)) map.removeSource(WN_SRC);
      if (map.getLayer(NJ_LAYER)) map.removeLayer(NJ_LAYER);
      if (map.getSource(NJ_SRC)) map.removeSource(NJ_SRC);
      _wnFC = null;
      _hoverWayId = null;
      if (_wnHoverPopup) _wnHoverPopup.remove();
      setWayExclusionMode(false);
      return;
    }

    var segments = typeof App.getWalkNetworkSegments === "function"
      ? App.getWalkNetworkSegments() : [];
    var fc = segmentsToGeoJSON(segments);
    _wnFC = fc; // kept for the hover/click handlers' wayId -> {name, length} lookups

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

      // Excluded segments render on a SEPARATE filtered layer: never put a
      // data expression in line-dasharray — MapLibre silently refuses the
      // whole layer (this once took down the walk network). Excluded streets
      // must stay visible/clickable, or an exclusion could not be undone.
      map.addLayer({
        id: WN_EXCLUDED_LAYER,
        type: "line",
        source: WN_SRC,
        filter: ["==", ["get", "excluded"], true],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#dc2626",
          "line-width": 2,
          "line-opacity": 0.85,
          "line-dasharray": [2, 1.5]
        }
      }, firstUserLayer());

      // Whole-way hover highlight: a way spans many segment features, so this
      // filters on wayId rather than using feature-state. The sentinel filter
      // value matches nothing.
      map.addLayer({
        id: WN_HOVER_LAYER,
        type: "line",
        source: WN_SRC,
        filter: ["==", ["get", "wayId"], "__wn_none__"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#fbbf24",
          "line-width": 5,
          "line-opacity": 0.9
        }
      }, firstUserLayer());

      wireWalkNetworkInteraction(map);
    } else {
      map.getSource(WN_SRC).setData(fc);
    }

    refreshJoinMarkers();
  }

  // ---- Hover/click interaction on walk-network-line ----
  // Wired exactly once, when WN_LAYER is first created: layer listeners persist
  // across setData(), so re-wiring would stack duplicate handlers.

  var WN_HOVER_LAYER = "walk-network-hover-line";
  var _wnFC = null;        // last built FeatureCollection — wayId -> {name, length} lookups
  var _hoverWayId = null;
  var _wnHoverPopup = null;
  var _wnWired = false;
  // Street exclusion is opt-in: the walk-network hover/click handlers do nothing
  // unless this is on (and no draw tool is active). It used to be live whenever
  // a network was loaded, so every click on a street — placing a point, selecting
  // a feature — also toggled that street's exclusion. Closure-private on purpose;
  // not persisted, so a reload never starts with exclusion armed.
  var _exclusionMode = false;

  function exclusionActive() { return _exclusionMode && !App.drawMode; }

  function clearWayHover() {
    _hoverWayId = null;
    var map = App.map;
    if (map && map.getLayer(WN_HOVER_LAYER)) map.setFilter(WN_HOVER_LAYER, ["==", ["get", "wayId"], "__wn_none__"]);
    if (_wnHoverPopup) _wnHoverPopup.remove();
  }

  // Turning it off also clears any hover highlight/popup left on screen. Fires
  // "wayexclusionmodechange" so UI (the Walkshed button) can follow without
  // polling; a no-op call (same value) fires nothing.
  function setWayExclusionMode(on) {
    on = !!on;
    if (on === _exclusionMode) return;
    _exclusionMode = on;
    if (!on) clearWayHover();
    if (App.map && !App.drawMode) App.map.getCanvas().style.cursor = "grab";
    document.dispatchEvent(new CustomEvent("wayexclusionmodechange", { detail: { on: on } }));
  }

  function wnEscapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function wayFeatures(wayId) {
    if (!_wnFC || wayId == null) return [];
    return _wnFC.features.filter(function (f) { return f.properties.wayId === wayId; });
  }

  function wayLengthFt(wayId) {
    var feats = wayFeatures(wayId);
    var km = 0;
    feats.forEach(function (f) {
      if (typeof turf !== "undefined" && turf.length) km += turf.length(f, { units: "kilometers" });
    });
    return km * FT_PER_KM;
  }

  function isWayExcluded(wayId) {
    var ids = (App.networkSettings && App.networkSettings.excludedWayIds) || [];
    return ids.indexOf(wayId) !== -1;
  }

  function toggleExcludedWay(wayId) {
    var ids = (App.networkSettings && App.networkSettings.excludedWayIds) || [];
    var idx = ids.indexOf(wayId);
    var next = ids.slice();
    if (idx === -1) next.push(wayId); else next.splice(idx, 1);
    if (typeof App.setExcludedWays === "function") App.setExcludedWays(next);
  }

  function ensureWnHoverPopup() {
    if (!_wnHoverPopup) {
      _wnHoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
    }
    return _wnHoverPopup;
  }

  function wireWalkNetworkInteraction(map) {
    // Layer listeners outlive removeLayer(), so a clear + re-download would
    // otherwise stack a second copy and the doubled click would toggle a street
    // twice (a net no-op).
    if (_wnWired) return;
    _wnWired = true;

    map.on("mousemove", WN_LAYER, function (e) {
      if (!exclusionActive()) return;
      if (!e.features || !e.features.length) return;
      var wayId = e.features[0].properties.wayId;

      // Legacy imports have no wayId: no highlight/tooltip for a street that
      // can't be excluded anyway.
      if (wayId == null) {
        if (!App.drawMode) map.getCanvas().style.cursor = "grab";
        if (map.getLayer(WN_HOVER_LAYER)) map.setFilter(WN_HOVER_LAYER, ["==", ["get", "wayId"], "__wn_none__"]);
        if (_wnHoverPopup) _wnHoverPopup.remove();
        _hoverWayId = null;
        return;
      }

      if (!App.drawMode) map.getCanvas().style.cursor = "pointer";
      if (wayId !== _hoverWayId) {
        _hoverWayId = wayId;
        map.setFilter(WN_HOVER_LAYER, ["==", ["get", "wayId"], wayId]);
      }

      var feats = wayFeatures(wayId);
      var name = (feats[0] && feats[0].properties.name) || "Unnamed street";
      var excluded = isWayExcluded(wayId);
      var lengthFt = wayLengthFt(wayId);

      ensureWnHoverPopup()
        .setLngLat(e.lngLat)
        .setHTML(
          '<div class="tiny"><strong>' + wnEscapeHtml(name) + '</strong><br>' +
          Math.round(lengthFt).toLocaleString() + ' ft · ' +
          (excluded ? '<span style="color:#dc2626;">Excluded</span>' : 'Walkable') +
          '<br><span style="opacity:.7;">Click to ' + (excluded ? "restore" : "exclude") + '</span></div>'
        )
        .addTo(map);
    });

    map.on("mouseleave", WN_LAYER, function () {
      if (!exclusionActive()) return;
      map.getCanvas().style.cursor = "grab";
      clearWayHover();
    });

    map.on("click", WN_LAYER, function (e) {
      if (!exclusionActive()) return;
      if (!e.features || !e.features.length) return;
      var wayId = e.features[0].properties.wayId;
      if (wayId == null) {
        App.setStatus("This street can't be excluded — it was imported before way ids were captured.");
        return;
      }
      toggleExcludedWay(wayId);
    });
  }

  // Join ("crossing"|"weld") and orphan markers as one data-driven layer.
  // Inserted below drawn features but above the walk-network lines.
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
  App.setWayExclusionMode = setWayExclusionMode;
  App.isWayExclusionMode = function () { return _exclusionMode; };

})();
