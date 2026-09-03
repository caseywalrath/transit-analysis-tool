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

  function diHoverHTML(props) {
    if (!props) return "";
    var criteriaLabel = props.criteria === "both" ? "minority + income" : (props.criteria || "");
    var povertyPct = Math.round((props.povertyShare || 0) * 100);
    var minorityPct = Math.round((props.minorityShare || 0) * 100);
    return "<strong>DI community (" + criteriaLabel + ")</strong> · " +
      povertyPct + "% below poverty · " + minorityPct + "% minority";
  }

  function onDiEnter() {
    if (!App.drawMode) App.map.getCanvas().style.cursor = "pointer";
  }
  function onDiMove(e) {
    if (!e.features || !e.features.length) return;
    if (!_hoverPopup) {
      _hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
    }
    var html = diHoverHTML(e.features[0].properties);
    if (!html) return;
    _hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(App.map);
  }
  function onDiLeave() {
    App.map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
    if (_hoverPopup) _hoverPopup.remove();
  }

  function wireDiHover() {
    var map = App.map;
    map.on("mouseenter", "zeb-di-fill", onDiEnter);
    map.on("mousemove", "zeb-di-fill", onDiMove);
    map.on("mouseleave", "zeb-di-fill", onDiLeave);
  }
  function unwireDiHover() {
    var map = App.map;
    if (!map) return;
    map.off("mouseenter", "zeb-di-fill", onDiEnter);
    map.off("mousemove", "zeb-di-fill", onDiMove);
    map.off("mouseleave", "zeb-di-fill", onDiLeave);
    if (_hoverPopup) _hoverPopup.remove();
  }

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
    wireDiHover();
  }

  // Study area: a 1-mile-buffered bbox around each agency's GTFS shapes,
  // unioned across agencies. Agencies with no shapes in the loaded feed (or
  // no feed loaded at all) simply contribute nothing — the union degrades to
  // whatever agencies actually have shape geometry, down to empty.
  function diStudyAreaUnion() {
    var data = window.ZebDemoData;
    if (!data || !data.agencies || !window.turf) return null;
    var shapesFC = App.getGTFSShapesFC ? App.getGTFSShapesFC() : null;
    var polys = [];
    Object.keys(data.agencies).forEach(function (aid) {
      var feats = shapesFC ? shapesFC.features.filter(function (f) {
        return f.properties && f.properties.agency_id === aid;
      }) : [];
      if (!feats.length) return;
      var bbox = turf.bbox({ type: "FeatureCollection", features: feats });
      polys.push(turf.buffer(turf.bboxPolygon(bbox), 1, { units: "miles" }));
    });
    if (!polys.length) return null;
    return (typeof App.foldAnalysisUnion === "function") ? App.foldAnalysisUnion(polys) : polys[0];
  }

  // Live ACS computation of DI (Disproportionately Impacted) block groups
  // within the study area — reuses the same fetchTigerwebGeos/fetchACSValues
  // primitives title-vi-engine.js's TitleVI.fetchDemographics uses, but flags
  // each block group individually rather than aggregating one share across
  // the whole union (this overlay renders per-geography, not a single stat).
  async function computeDI() {
    var data = window.ZebDemoData;
    var diCfg = (data && data.di) || {};
    var minorityMin = diCfg.minorityShareMin != null ? diCfg.minorityShareMin : 0.40;
    var povertyMin = diCfg.povertyShareMin != null ? diCfg.povertyShareMin : 0.25;
    var year = diCfg.acsYear || "2023";
    var empty = { type: "FeatureCollection", features: [] };

    var studyArea = diStudyAreaUnion();
    if (!studyArea) return empty;

    var geos = await App.fetchTigerwebGeos("bg", studyArea);
    if (!geos || !geos.length) return empty;

    var geoids = geos.map(function (g) {
      return g.properties.GEOID || g.properties.GEOID20 || g.properties.GEOID10 || "";
    }).filter(Boolean);

    var totalPop = await App.fetchACSValues("bg", year, "B03002_001E", geoids);
    var nhWhitePop = await App.fetchACSValues("bg", year, "B03002_003E", geoids);
    var povDenom = await App.fetchACSValues("bg", year, "B17001_001E", geoids);
    var povBelow = await App.fetchACSValues("bg", year, "B17001_002E", geoids);

    var features = [];
    geos.forEach(function (geo) {
      var gid = geo.properties.GEOID || geo.properties.GEOID20 || geo.properties.GEOID10 || "";
      if (!gid) return;

      var total = totalPop.get(gid), nhWhite = nhWhitePop.get(gid);
      var minorityShare = null;
      if (Number.isFinite(total) && total > 0 && Number.isFinite(nhWhite)) {
        minorityShare = Math.max(0, 1 - nhWhite / total);
      }

      var povTotal = povDenom.get(gid), povCount = povBelow.get(gid);
      var povertyShare = null;
      if (Number.isFinite(povTotal) && povTotal > 0 && Number.isFinite(povCount)) {
        povertyShare = povCount / povTotal;
      }

      var flagMinority = minorityShare !== null && minorityShare >= minorityMin;
      var flagIncome = povertyShare !== null && povertyShare >= povertyMin;
      if (!flagMinority && !flagIncome) return;

      features.push({
        type: "Feature",
        geometry: geo.geometry,
        properties: {
          GEOID: gid,
          minorityShare: minorityShare || 0,
          povertyShare: povertyShare || 0,
          criteria: flagMinority && flagIncome ? "both" : (flagMinority ? "minority" : "income")
        }
      });
    });

    return { type: "FeatureCollection", features: features };
  }

  App.zebComputeDI = computeDI;

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
      if (typeof App.setStatus === "function") App.setStatus("DI communities: Census data unavailable.");
    });
  }

  // ---- Shared add/remove/visibility ----

  function removeLayers(id) {
    var map = App.map;
    if (!map) return;
    var cfg = OVERLAYS[id];
    if (id === "winter") unwireWinterHover();
    if (id === "di") unwireDiHover();
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

    // Keep zeb-feasibility.js's own overlay checkboxes in sync when toggled
    // from here (the Add Data dropdown buttons) rather than from the
    // checkbox itself, so an already-open popup doesn't go stale.
    if (typeof App.zebSyncOverlayCheckboxes === "function") App.zebSyncOverlayCheckboxes();
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
