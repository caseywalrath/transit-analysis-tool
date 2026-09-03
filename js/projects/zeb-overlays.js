// js/projects/zeb-overlays.js
// Route Electrification Feasibility demo — three reference overlays: Winter
// Range Impact, Utility Service Territories, and DI Communities. Winter and
// Utility render static illustrative geometry from data/zeb/zeb-overlay-data.js;
// DI renders whatever App.zebComputeDI() (Step 7) returns, live. Pattern:
// js/core/map.js's toggleMuniBoundaries for add/remove, gtfs.js for "a module
// wires its own Add Data dropdown buttons" (these buttons live in index.html,
// not in a lazily-loaded popup, so wiring happens once at load time below).
// Depends on: maplibregl (CDN), App namespace, data/zeb/zeb-overlay-data.js,
// data/zeb/zeb-demo-data.js.
(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state ----
  var _active = { winter: false, utility: false, di: false };
  var _hoverPopup = null;

  var OVERLAYS = {
    winter: {
      source: "zeb-winter",
      fillLayer: "zeb-winter-fill",
      lineLayer: "zeb-winter-line",
      btnId: "zeb-winter-btn",
      legendId: "zeb-winter-legend",
      legendHtml: "projects/zeb-winter-legend.html",
      legendTitle: "Winter Range Impact"
    },
    utility: {
      source: "zeb-utility",
      fillLayer: "zeb-utility-fill",
      lineLayer: "zeb-utility-line",
      labelLayer: "zeb-utility-label",
      btnId: "zeb-utility-btn",
      legendId: "zeb-utility-legend",
      legendHtml: "projects/zeb-utility-legend.html",
      legendTitle: "Utility Service Territories"
    },
    di: {
      source: "zeb-di",
      fillLayer: "zeb-di-fill",
      lineLayer: "zeb-di-line",
      btnId: "zeb-di-btn",
      legendId: "zeb-di-legend",
      legendHtml: "projects/zeb-di-legend.html",
      legendTitle: "Disproportionately Impacted Communities"
    }
  };

  // ---- Layer ordering (drawn features + GTFS always stay on top) ----

  function firstUserLayer() {
    var map = App.map;
    var candidates = ["points-layer", "lines-layer", "routes-layer", "polygons-fill"];
    for (var i = 0; i < candidates.length; i++) {
      if (map.getLayer(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  function beforeLayer() {
    var map = App.map;
    if (map.getLayer("gtfs-shapes-layer")) return "gtfs-shapes-layer";
    return firstUserLayer();
  }

  // ---- Winter range impact ----

  function winterHoverHTML(props) {
    var zone = props && props.zone;
    var data = window.ZebDemoData;
    var cz = data && data.climateZones && data.climateZones[zone];
    if (!cz) return "";
    var pct = Math.round((1 - 1 / cz.factors.winter) * 100);
    return "<strong>Winter range impact — " + (props.label || cz.label) + "</strong><br>" +
      "≈" + pct + "% less range (Jan mean low " + cz.janMeanLowF + " °F)";
  }

  function onWinterEnter() {
    if (!App.drawMode) App.map.getCanvas().style.cursor = "pointer";
  }
  function onWinterMove(e) {
    if (!e.features || !e.features.length) return;
    if (!_hoverPopup) {
      _hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
    }
    var html = winterHoverHTML(e.features[0].properties);
    if (!html) return;
    _hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(App.map);
  }
  function onWinterLeave() {
    App.map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
    if (_hoverPopup) _hoverPopup.remove();
  }

  function wireWinterHover() {
    var map = App.map;
    map.on("mouseenter", "zeb-winter-fill", onWinterEnter);
    map.on("mousemove", "zeb-winter-fill", onWinterMove);
    map.on("mouseleave", "zeb-winter-fill", onWinterLeave);
  }
  function unwireWinterHover() {
    var map = App.map;
    if (!map) return;
    map.off("mouseenter", "zeb-winter-fill", onWinterEnter);
    map.off("mousemove", "zeb-winter-fill", onWinterMove);
    map.off("mouseleave", "zeb-winter-fill", onWinterLeave);
    if (_hoverPopup) _hoverPopup.remove();
  }

  function addWinterLayers() {
    var map = App.map;
    if (map.getSource("zeb-winter")) return;
    map.addSource("zeb-winter", { type: "geojson", data: window.ZebOverlayData.climateZones });
    var before = beforeLayer();
    map.addLayer({
      id: "zeb-winter-fill",
      type: "fill",
      source: "zeb-winter",
      paint: {
        "fill-color": ["match", ["get", "zone"], "mountain", "#2b6cb0", "plains", "#63b3ed", "#63b3ed"],
        "fill-opacity": ["match", ["get", "zone"], "mountain", 0.20, "plains", 0.14, 0.14]
      }
    }, before);
    map.addLayer({
      id: "zeb-winter-line",
      type: "line",
      source: "zeb-winter",
      paint: {
        "line-color": "#2b6cb0",
        "line-width": 1,
        "line-dasharray": [3, 2]
      }
    }, before);
    wireWinterHover();
  }

  // ---- Utility service territories ----

  function addUtilityLayers() {
    var map = App.map;
    if (map.getSource("zeb-utility")) return;
    map.addSource("zeb-utility", { type: "geojson", data: window.ZebOverlayData.utilities });
    var before = beforeLayer();
    map.addLayer({
      id: "zeb-utility-fill",
      type: "fill",
      source: "zeb-utility",
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.10 }
    }, before);
    map.addLayer({
      id: "zeb-utility-line",
      type: "line",
      source: "zeb-utility",
      paint: { "line-color": ["get", "color"], "line-width": 1.5 }
    }, before);
    map.addLayer({
      id: "zeb-utility-label",
      type: "symbol",
      source: "zeb-utility",
      layout: {
        "text-field": ["get", "utility"],
        "text-size": 12,
        "text-anchor": "center"
      },
      paint: {
        "text-color": "#2d3748",
        "text-halo-color": "rgba(255,255,255,0.85)",
        "text-halo-width": 1.2
      }
    }, before);
  }

  // ---- DI communities (geometry supplied live by App.zebComputeDI, Step 7) ----

  function addDiLayers() {
    var map = App.map;
    if (map.getSource("zeb-di")) return;
    map.addSource("zeb-di", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    var before = beforeLayer();
    map.addLayer({
      id: "zeb-di-fill",
      type: "fill",
      source: "zeb-di",
      paint: { "fill-color": "#6b46c1", "fill-opacity": 0.35 }
    }, before);
    map.addLayer({
      id: "zeb-di-line",
      type: "line",
      source: "zeb-di",
      paint: { "line-color": "#6b46c1", "line-width": 0.8, "line-opacity": 0.6 }
    }, before);
  }

  function refreshDiData() {
    if (typeof App.zebComputeDI !== "function") return; // Step 7 not yet wired
    var map = App.map;
    if (typeof App.setStatus === "function") App.setStatus("Computing DI communities…");
    Promise.resolve(App.zebComputeDI()).then(function (fc) {
      if (!_active.di) return; // toggled off while the fetch was in flight
      var src = map.getSource("zeb-di");
      if (src) src.setData(fc && fc.type ? fc : { type: "FeatureCollection", features: [] });
      if (typeof App.setStatus === "function") App.setStatus("DI communities computed.");
    }).catch(function () {
      if (typeof App.setStatus === "function") App.setStatus("DI communities computation failed.");
    });
  }

  // ---- Shared add/remove/visibility ----

  function removeLayers(id) {
    var map = App.map;
    if (!map) return;
    var cfg = OVERLAYS[id];
    if (id === "winter") unwireWinterHover();
    [cfg.labelLayer, cfg.lineLayer, cfg.fillLayer].forEach(function (layerId) {
      if (layerId && map.getLayer(layerId)) map.removeLayer(layerId);
    });
    if (map.getSource(cfg.source)) map.removeSource(cfg.source);
  }

  function addLayersFor(id) {
    if (id === "winter") addWinterLayers();
    else if (id === "utility") addUtilityLayers();
    else if (id === "di") addDiLayers();
  }

  function showLegend(id) {
    var cfg = OVERLAYS[id];
    if (!App.popup || typeof App.popup.showFloatingWidget !== "function") return;
    App.popup.showFloatingWidget(cfg.legendId, cfg.legendHtml, {
      position: "bottom-right", width: 200, title: cfg.legendTitle
    });
  }

  function hideLegend(id) {
    var cfg = OVERLAYS[id];
    if (App.popup && typeof App.popup.hideFloatingWidget === "function") {
      App.popup.hideFloatingWidget(cfg.legendId);
    }
  }

  function toggle(id, show) {
    var cfg = OVERLAYS[id];
    if (!cfg || !App.map) return;
    show = !!show;
    _active[id] = show;

    var btn = document.getElementById(cfg.btnId);
    if (btn) btn.classList.toggle("add-data-active", show);

    if (show) {
      addLayersFor(id);
      if (id === "di") refreshDiData();
      showLegend(id);
    } else {
      removeLayers(id);
      hideLegend(id);
    }
  }

  function isActive(id) {
    return !!_active[id];
  }

  function setVisible(id, visible) {
    var cfg = OVERLAYS[id];
    var map = App.map;
    if (!cfg || !map) return;
    [cfg.fillLayer, cfg.lineLayer, cfg.labelLayer].forEach(function (layerId) {
      if (layerId && map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    });
  }

  function clearAll() {
    Object.keys(OVERLAYS).forEach(function (id) {
      if (_active[id]) toggle(id, false);
    });
  }

  App.zebOverlays = {
    toggle: toggle,
    isActive: isActive,
    setVisible: setVisible,
    clearAll: clearAll
  };

  // ---- Wire Add Data dropdown buttons (present in index.html at load time) ----

  var _dropdown = document.getElementById("add-data-dropdown");

  Object.keys(OVERLAYS).forEach(function (id) {
    var cfg = OVERLAYS[id];
    var btn = document.getElementById(cfg.btnId);
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (_dropdown) _dropdown.style.display = "none";
      toggle(id, !_active[id]);
    });
  });
})();
