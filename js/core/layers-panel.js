// js/core/layers-panel.js
// "Layers" tab on the right feature panel. A unified manager for everything on
// the map: drawn features (nested by user group), per-type style drawers for
// each drawn geometry type (color, opacity, weight — the type-default half of
// the appearance cascade) with per-feature override drawers nested under the
// feature rows (the override half), reference/imported layers (GTFS, OSM,
// muni boundaries), analysis choropleths (TPI, Corridor Scoring, Ridership),
// and the basemap. Visibility + opacity + basemap, constrained drag-reorder
// within the Reference/Analysis bands, and a per-row ⋯ menu (zoom to, open
// module, remove, rename group).
// Depends on: App.map, App.collectDrawnFeatures, App.UNIVERSAL_GROUP_KEY,
//             App.rerenderForType, App.openColorPicker, App._openFpSlider,
//             App.buildScrubber, App.applyFeatureOpacity, App.applyLineWidth,
//             App.applyBufferLineWidth, App._polyOpacityValues,
//             App.BUFFER_RADIUS_STEPS, App.sectionColors, App.featureSettings,
//             App.getTypeDefaultColor, App.getBasemaps, App.switchBasemap,
//             App.cache, App.refreshFeaturePanel.
(function () {
  var App = window.App = window.App || {};

  var EYE_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 13 1 13a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>' +
    '<line x1="1" y1="1" x2="23" y2="23"/></svg>';
  var OPACITY_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>';

  var TYPE_LABELS_LOCAL = {
    point: "Point", line: "Line",
    route: "Route", polygon: "Polygon", label: "Label"
  };

  // ---- Reference + analysis layer manifest ----
  // Each entry: { id (presence/detect key), label, layers:[{id, op}] }.
  function callIf(fn) { return function () { if (typeof App[fn] === "function") App[fn].apply(App, arguments); }; }

  var REFERENCE = [
    { id: "muni-boundaries-line", label: "Municipal boundaries", layers: [{ id: "muni-boundaries-line", op: "line-opacity" }],
      clear: function () { if (typeof App.toggleMuniBoundaries === "function") App.toggleMuniBoundaries(false); } },
    { id: "road-dl-area-line",    label: "Road download area",   layers: [{ id: "road-dl-area-line", op: "line-opacity" }],
      clear: callIf("clearRoadDownloadArea") },
    { id: "walk-network-line",    label: "Walk network",         layers: [{ id: "walk-network-line", op: "line-opacity" },
      { id: "network-joins-point", op: "circle-opacity" }],
      clear: callIf("clearRoadNetwork") },
    { id: "gtfs-shapes-layer",    label: "GTFS routes",          layers: [{ id: "gtfs-shapes-layer", op: "line-opacity" }],
      clear: callIf("clearGTFS") },
    { id: "gtfs-stops-layer",     label: "GTFS stops",           layers: [{ id: "gtfs-stops-layer", op: "circle-opacity" }],
      clear: callIf("clearGTFS") },
    { id: "osm-points-layer",     label: "OSM points",           layers: [{ id: "osm-points-layer", op: "circle-opacity" }],
      clear: function () { if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("bus_stops"); } },
    { id: "osm-lines-layer",      label: "OSM lines",            layers: [{ id: "osm-lines-layer", op: "line-opacity" }],
      clear: function () { if (typeof App.osmToggleCategory === "function") App.osmToggleCategory("transit_routes"); } },
    { id: "osm-poi-layer",        label: "OSM points of interest", layers: [{ id: "osm-poi-layer", op: "circle-opacity" }],
      clear: callIf("clearOsmPois") }
  ];
  var ANALYSIS = [
    { id: "bas-choropleth-fill", label: "Feature Area Analysis", moduleId: "buffer-summary",
      layers: [{ id: "bas-choropleth-fill", op: "fill-opacity" }, { id: "bas-choropleth-line", op: "line-opacity" }] },
    { id: "tpi-choropleth-fill", label: "Transit Propensity", moduleId: "transit-propensity",
      layers: [{ id: "tpi-choropleth-fill", op: "fill-opacity" }, { id: "tpi-choropleth-line", op: "line-opacity" }] },
    { id: "corridor-scoring-routes-layer", label: "Corridor Scoring", moduleId: "corridor-scoring",
      layers: [{ id: "corridor-scoring-routes-layer", op: "line-opacity" }] },
    { id: "rf-choropleth-fill", label: "Ridership Forecast", moduleId: "ridership-forecasting",
      layers: [{ id: "rf-choropleth-fill", op: "fill-opacity" }, { id: "rf-choropleth-line", op: "line-opacity" }, { id: "rf-corridor-cdi-layer", op: "line-opacity" }] },
    { id: "ts-travelshed-fill", label: "Transit Travelshed", moduleId: "transit-travelshed",
      layers: [{ id: "ts-travelshed-fill", op: "fill-opacity" }, { id: "ts-travelshed-line", op: "line-opacity" }] },
    // Added after an audit found five map-rendering surfaces were never
    // registered here, so their output was invisible to this panel — no
    // show/hide, no opacity, no reorder. Entries only render when the layer is
    // actually on the map (see entryPresent), so listing them all is safe.
    { id: "transit-coverage-coverage-layer", label: "Transit Coverage", moduleId: "transit-coverage",
      layers: [{ id: "transit-coverage-coverage-layer", op: "fill-opacity" },
               { id: "transit-coverage-threshold-layer", op: "fill-opacity" },
               { id: "transit-coverage-area-layer", op: "line-opacity" }] },
    { id: "walkshed-fill", label: "Walkshed", moduleId: "walkshed",
      layers: [{ id: "walkshed-fill", op: "fill-opacity" },
               { id: "walkshed-line", op: "line-opacity" }] },
    { id: "walkshed-seg", label: "Walkshed — reachable streets", moduleId: "walkshed",
      layers: [{ id: "walkshed-seg", op: "line-opacity" }] },
    { id: "tvi-impacted-fill", label: "Title VI service change", moduleId: "title-vi",
      layers: [{ id: "tvi-impacted-fill", op: "fill-opacity" },
               { id: "tvi-impacted-outline", op: "line-opacity" },
               { id: "tvi-gain-fill", op: "fill-opacity" },
               { id: "tvi-gain-outline", op: "line-opacity" }] },
    { id: "lbar-sites-layer", label: "FTA land-use sites", moduleId: "fta-small-starts",
      layers: [{ id: "lbar-sites-layer", op: "circle-opacity" }] },
    // Not a module of its own — census.js renders this for whichever analysis
    // last fetched geographies, so it gets no moduleId.
    { id: "census-geos-fill", label: "Census geographies",
      layers: [{ id: "census-geos-fill", op: "fill-opacity" },
               { id: "census-geos-line", op: "line-opacity" }] }
  ];

  // Per-session band ordering (panel order = map order, top of list = top of map).
  var _refOrder = REFERENCE.map(function (e) { return e.id; });
  var _analysisOrder = ANALYSIS.map(function (e) { return e.id; });

  function orderedPresent(entries, order) {
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });
    return order.map(function (id) { return byId[id]; })
                .filter(function (e) { return e && entryPresent(e); });
  }

  // Per-type style drawer contents. Each control is { label, kind, key, min,
  // max, step, unit, def } — kind is "color" (no key/min/max/step/unit/def)
  // or "number" (mounts App.buildScrubber, writes App.featureSettings[key]).
  var DRAWN_TYPES = [
    { type: "point", label: "Points", controls: [
        { label: "Color", kind: "color" },
        { label: "Size",  kind: "number", key: "pointLineWidth",   min: 0, max: 5,   step: 0.1, unit: "×", def: 1 },
        { label: "Width", kind: "number", key: "pointStrokeWidth", min: 0, max: 5,   step: 0.1, unit: "×", def: 1 },
        { label: "Opacity",       kind: "number", key: "pointOpacity",     min: 0, max: 100, step: 5,   unit: "%",      def: 100 }
      ] },
    { type: "line", label: "Lines", controls: [
        { label: "Color", kind: "color" },
        { label: "Weight",  kind: "number", key: "lineLineWidth", min: 0, max: 5,   step: 0.1, unit: "×", def: 1 },
        { label: "Opacity", kind: "number", key: "lineOpacity",   min: 0, max: 100, step: 5,   unit: "%",      def: 100 }
      ] },
    { type: "route", label: "Routes", controls: [
        { label: "Color", kind: "color" },
        { label: "Weight",  kind: "number", key: "routeLineWidth", min: 0, max: 5,   step: 0.1, unit: "×", def: 1 },
        { label: "Opacity", kind: "number", key: "routeOpacity",   min: 0, max: 100, step: 5,   unit: "%",      def: 100 }
      ] },
    { type: "polygon", label: "Polygons", controls: [
        { label: "Color", kind: "color" },
        { label: "Fill",    kind: "number", key: "polygonFillOpacity", min: 0, max: 100, step: 5,   unit: "%",      def: 15 },
        { label: "Outline", kind: "number", key: "polygonLineOpacity", min: 0, max: 100, step: 5,   unit: "%",      def: 80 },
        { label: "Width",   kind: "number", key: "polygonLineWidth",   min: 0, max: 5,   step: 0.1, unit: "×", def: 1 }
      ] },
    { type: "buffer", label: "Buffers", controls: [
        { label: "Fill",    kind: "number", key: "bufferFillOpacity", min: 0, max: 100, step: 5,   unit: "%",      def: 8 },
        { label: "Outline", kind: "number", key: "bufferLineOpacity", min: 0, max: 100, step: 5,   unit: "%",      def: 40 },
        { label: "Width",   kind: "number", key: "bufferLineWidth",   min: 0, max: 5,   step: 0.1, unit: "×", def: 1 }
      ] }
  ];

  // Per-feature override drawer contents (buildFeatureRow). Only point/line/
  // route/polygon carry per-feature overrides; labels/textboxes are DOM
  // markers with none. Unlike the type drawer above, the point per-feature
  // override is a single `_lineWidth` property shared by dot size and
  // outline width (see App.applyLineWidth's point branch) — so there is one
  // Size control here, not two.
  var FEATURE_OVERRIDE_SPECS = {
    point:   { widthLabel: "Size",           hasBuffer: true,  hasOffset: false },
    line:    { widthLabel: "Weight",         hasBuffer: true,  hasOffset: true  },
    route:   { widthLabel: "Weight",         hasBuffer: true,  hasOffset: true  },
    polygon: { widthLabel: "Width",           hasBuffer: false, hasOffset: false }
  };

  function typeHasFeatures(type) {
    if (type === "buffer") {
      return !!((App.points && App.points.length) || (App.lines && App.lines.length) || (App.routes && App.routes.length));
    }
    var arr = App[type === "point" ? "points" : type + "s"];
    return !!(arr && arr.length);
  }

  function applyTypeStyle(type) {
    if (typeof App.applyFeatureOpacity === "function") App.applyFeatureOpacity(type);
    if (type === "buffer") {
      if (typeof App.applyBufferLineWidth === "function") App.applyBufferLineWidth();
    } else if (typeof App.applyLineWidth === "function") {
      App.applyLineWidth(type);
    }
  }

  // Inverse of App._polyOpacityValues' fill component → returns S (0-100).
  // Duplicated from feature-attributes.js's private helper of the same
  // shape (small pure function, not worth a cross-file export).
  function _invertPolyFill(fill) {
    if (fill <= 0.15) return Math.round(fill * 50 / 0.15);
    return Math.round(50 + (fill - 0.15) * 50 / 0.85);
  }

  // ---- Style preview swatch (small inline SVG, approximate — an indicator,
  // not a simulation) ----
  var SVG_NS = "http://www.w3.org/2000/svg";

  function updateStylePreview(svg, type) {
    var fs = App.featureSettings || {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (type === "point") {
      var pColor = App.getTypeDefaultColor ? App.getTypeDefaultColor("point") : "#2b6cb0";
      var r = Math.max(2, Math.min(7, 2 + (fs.pointLineWidth || 1) * 2));
      var psw = Math.max(0.5, (fs.pointStrokeWidth != null ? fs.pointStrokeWidth : 1) * 1.5);
      var pOp = (fs.pointOpacity != null ? fs.pointOpacity : 100) / 100;
      var c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", "20"); c.setAttribute("cy", "8"); c.setAttribute("r", r);
      c.setAttribute("fill", pColor); c.setAttribute("fill-opacity", pOp);
      c.setAttribute("stroke", "#ffffff"); c.setAttribute("stroke-width", psw);
      svg.appendChild(c);
    } else if (type === "line" || type === "route") {
      var lColor = App.getTypeDefaultColor ? App.getTypeDefaultColor(type) : "#e53e3e";
      var w = Math.max(1, (fs[type + "LineWidth"] || 1) * 3);
      var lOp = (fs[type + "Opacity"] != null ? fs[type + "Opacity"] : 100) / 100;
      var l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", "3"); l.setAttribute("y1", "8"); l.setAttribute("x2", "37"); l.setAttribute("y2", "8");
      l.setAttribute("stroke", lColor); l.setAttribute("stroke-width", w); l.setAttribute("stroke-opacity", lOp);
      l.setAttribute("stroke-linecap", "round");
      svg.appendChild(l);
    } else if (type === "polygon") {
      var gColor = App.getTypeDefaultColor ? App.getTypeDefaultColor("polygon") : "#b0c4de";
      var gFill = (fs.polygonFillOpacity != null ? fs.polygonFillOpacity : 15) / 100;
      var gLine = (fs.polygonLineOpacity != null ? fs.polygonLineOpacity : 80) / 100;
      var gw = Math.max(1, (fs.polygonLineWidth || 1) * 2);
      var rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", "6"); rect.setAttribute("y", "2"); rect.setAttribute("width", "28"); rect.setAttribute("height", "12");
      rect.setAttribute("fill", gColor); rect.setAttribute("fill-opacity", gFill);
      rect.setAttribute("stroke", gColor); rect.setAttribute("stroke-opacity", gLine); rect.setAttribute("stroke-width", gw);
      svg.appendChild(rect);
    } else if (type === "buffer") {
      var bFill = (fs.bufferFillOpacity != null ? fs.bufferFillOpacity : 8) / 100;
      var bLine = (fs.bufferLineOpacity != null ? fs.bufferLineOpacity : 40) / 100;
      var bw = Math.max(1, (fs.bufferLineWidth || 1) * 2);
      var rect2 = document.createElementNS(SVG_NS, "rect");
      rect2.setAttribute("x", "6"); rect2.setAttribute("y", "2"); rect2.setAttribute("width", "28"); rect2.setAttribute("height", "12");
      rect2.setAttribute("fill", "#718096"); rect2.setAttribute("fill-opacity", bFill);
      rect2.setAttribute("stroke", "#718096"); rect2.setAttribute("stroke-opacity", bLine); rect2.setAttribute("stroke-width", bw);
      svg.appendChild(rect2);
    }
  }

  function buildStylePreview(type) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "40");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 40 16");
    svg.setAttribute("class", "lp-style-preview");
    updateStylePreview(svg, type);
    return svg;
  }

  // ---- Generic override-row builder (used by both the type style drawer's
  // number controls, indirectly via App.buildScrubber, and the per-feature
  // override drawer below, which additionally shows inherited state) ----
  function buildOverrideRow(label, scrubCfg, api) {
    var row = document.createElement("div");
    row.className = "lp-style-row";

    var lab = document.createElement("span");
    lab.className = "lp-style-label";
    lab.textContent = label;
    row.appendChild(lab);

    var controlWrap = document.createElement("div");
    controlWrap.className = "lp-style-control";
    row.appendChild(controlWrap);

    var scrubber = App.buildScrubber({
      min: scrubCfg.min, max: scrubCfg.max, step: scrubCfg.step,
      values: scrubCfg.values, unit: scrubCfg.unit,
      value: api.getValue(),
      onChange: function (v) {
        api.setValue(v);
        setOverridden(true);
      }
    });
    controlWrap.appendChild(scrubber);

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "lp-style-clear";
    clearBtn.title = "Clear override (use default)";
    clearBtn.textContent = "×";
    clearBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      api.clearValue();
      scrubber.refresh(api.getValue());
      setOverridden(false);
    });
    controlWrap.appendChild(clearBtn);

    function setOverridden(has) {
      row.classList.toggle("lp-inherited", !has);
      clearBtn.style.display = has ? "" : "none";
    }
    setOverridden(api.hasOverride());

    return row;
  }

  // ---- Per-feature override drawer (buildFeatureRow) ----
  // No polygon entry in OPACITY_KEYS: the polygon opacity override is handled
  // separately below (a single input drives the fill/border pair via
  // App._polyOpacityValues), so this map is only consulted for the other
  // three types, whose opacity default is still one plain featureSettings field.
  var OPACITY_KEYS = { point: "pointOpacity", line: "lineOpacity", route: "routeOpacity" };
  var WIDTH_KEYS    = { point: "pointLineWidth", line: "lineLineWidth", route: "routeLineWidth", polygon: "polygonLineWidth" };
  var BUFFER_KEYS   = { point: "bufferRadius", line: "lineBufferRadius", route: "routeBufferRadius" };
  var REBUILD_FNS   = {
    point: function (v) { if (typeof App.rebuildBuffers      === "function") App.rebuildBuffers(v); },
    line:  function (v) { if (typeof App.rebuildLineBuffers  === "function") App.rebuildLineBuffers(v); },
    route: function (v) { if (typeof App.rebuildRouteBuffers === "function") App.rebuildRouteBuffers(v); }
  };
  var RENDER_FNS = { point: "renderPointLayers", line: "renderLineLayers", route: "renderRouteLayers", polygon: "renderPolygonLayers" };

  function _pushFeatureLayer(ft) {
    var fn = RENDER_FNS[ft];
    if (fn && typeof App[fn] === "function") App[fn]();
  }
  function _saveCache() {
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function buildFeatureOverrideDrawer(it) {
    var body = document.createElement("div");
    body.className = "lp-style-drawer lp-style-drawer-feature";

    var feat = it.feature, ft = it.type;
    var spec = FEATURE_OVERRIDE_SPECS[ft];
    if (!spec) return body;

    // Opacity
    body.appendChild(buildOverrideRow("Opacity", { min: 0, max: 100, step: 1, unit: "%" }, {
      hasOverride: function () {
        return ft === "polygon" ? feat.properties._fillOpacity != null : feat.properties._opacity != null;
      },
      getValue: function () {
        if (ft === "polygon") {
          if (feat.properties._fillOpacity != null) return _invertPolyFill(feat.properties._fillOpacity);
          var defFill = (App.featureSettings && App.featureSettings.polygonFillOpacity != null) ? App.featureSettings.polygonFillOpacity : 15;
          return _invertPolyFill(defFill / 100);
        }
        if (feat.properties._opacity != null) return feat.properties._opacity * 100;
        return (App.featureSettings && App.featureSettings[OPACITY_KEYS[ft]] != null) ? App.featureSettings[OPACITY_KEYS[ft]] : 100;
      },
      setValue: function (v) {
        if (ft === "polygon") {
          var pc = App._polyOpacityValues(v);
          feat.properties._fillOpacity   = pc.fill;
          feat.properties._borderOpacity = pc.border;
        } else {
          feat.properties._opacity = v / 100;
        }
        _pushFeatureLayer(ft);
        _saveCache();
      },
      clearValue: function () {
        delete feat.properties._opacity;
        delete feat.properties._fillOpacity;
        delete feat.properties._borderOpacity;
        _pushFeatureLayer(ft);
        _saveCache();
      }
    }));

    // Width (single control — see FEATURE_OVERRIDE_SPECS comment above)
    body.appendChild(buildOverrideRow(spec.widthLabel, { min: 0, max: 5, step: 0.1, unit: "×" }, {
      hasOverride: function () { return feat.properties._lineWidth != null; },
      getValue: function () {
        if (feat.properties._lineWidth != null) return feat.properties._lineWidth;
        return (App.featureSettings && App.featureSettings[WIDTH_KEYS[ft]] != null) ? App.featureSettings[WIDTH_KEYS[ft]] : 1;
      },
      setValue: function (v) { feat.properties._lineWidth = v; _pushFeatureLayer(ft); _saveCache(); },
      clearValue: function () { delete feat.properties._lineWidth; _pushFeatureLayer(ft); _saveCache(); }
    }));

    // Offset (lines and routes only)
    if (spec.hasOffset) {
      var OFFSET_STEPS = [-6, -3, 0, 3, 6];
      body.appendChild(buildOverrideRow("Offset", { values: OFFSET_STEPS, unit: "px" }, {
        hasOverride: function () { return !!feat.properties._offsetManual; },
        getValue: function () { return (feat.properties._offset != null) ? feat.properties._offset : 0; },
        setValue: function (v) {
          feat.properties._offset = v;
          feat.properties._offsetManual = true;
          _pushFeatureLayer(ft);
          _saveCache();
        },
        clearValue: function () {
          delete feat.properties._offset;
          delete feat.properties._offsetManual;
          _pushFeatureLayer(ft);
          var oCb = document.getElementById("offsetOverlap");
          if (oCb && oCb.checked && typeof App.computeOverlapOffsets === "function") App.computeOverlapOffsets();
          _saveCache();
        }
      }));
    }

    // Buffer radius (points, lines, routes — not polygons). Geometry rather
    // than appearance, but a per-feature override with no other home; last
    // in the drawer.
    if (spec.hasBuffer) {
      body.appendChild(buildOverrideRow("Buffer", { values: App.BUFFER_RADIUS_STEPS || [0, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], unit: "mi" }, {
        hasOverride: function () { return feat.properties._bufferRadius != null; },
        getValue: function () {
          if (feat.properties._bufferRadius != null) return feat.properties._bufferRadius;
          return (App.featureSettings && App.featureSettings[BUFFER_KEYS[ft]]) || 0;
        },
        setValue: function (v) {
          feat.properties._bufferRadius = v;
          var rb = REBUILD_FNS[ft];
          if (rb) rb((App.featureSettings && App.featureSettings[BUFFER_KEYS[ft]]) || 0);
          _saveCache();
        },
        clearValue: function () {
          delete feat.properties._bufferRadius;
          var rb = REBUILD_FNS[ft];
          if (rb) rb((App.featureSettings && App.featureSettings[BUFFER_KEYS[ft]]) || 0);
          _saveCache();
        }
      }));
    }

    return body;
  }

  // ---- Map helpers ----
  function entryPresent(entry) {
    var map = App.map;
    return !!map && entry.layers.some(function (L) { return map.getLayer(L.id); });
  }
  function entryVisible(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var L = entry.layers[i];
      if (map.getLayer(L.id)) return map.getLayoutProperty(L.id, "visibility") !== "none";
    }
    return false;
  }
  function setEntryVisible(entry, vis) {
    var map = App.map;
    entry.layers.forEach(function (L) {
      if (map.getLayer(L.id)) map.setLayoutProperty(L.id, "visibility", vis ? "visible" : "none");
    });
  }
  function entryOpacity(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var L = entry.layers[i];
      if (map.getLayer(L.id)) {
        var v = map.getPaintProperty(L.id, L.op);
        return (typeof v === "number") ? v : 1;
      }
    }
    return 1;
  }
  function setEntryOpacity(entry, frac) {
    var map = App.map;
    entry.layers.forEach(function (L) {
      if (map.getLayer(L.id)) map.setPaintProperty(L.id, L.op, frac);
    });
  }

  var MENU_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
    '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
  var GRIP_SVG =
    '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">' +
    '<circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="7" r="1.1"/>' +
    '<circle cx="7" cy="7" r="1.1"/><circle cx="3" cy="11" r="1.1"/><circle cx="7" cy="11" r="1.1"/></svg>';

  // Fit the map to a layer entry by reading its GeoJSON source data.
  function zoomToEntry(entry) {
    var map = App.map;
    for (var i = 0; i < entry.layers.length; i++) {
      var sl = map.getLayer(entry.layers[i].id);
      if (!sl) continue;
      var src = map.getSource(sl.source);
      var data = src && src._data;
      if (!data) continue;
      try {
        var bb = turf.bbox(data);
        if (bb && bb.every(function (n) { return isFinite(n); })) {
          if (bb[0] === bb[2] && bb[1] === bb[3]) {
            map.easeTo({ center: [bb[0], bb[1]], zoom: Math.max(map.getZoom(), 14), duration: 600 });
          } else {
            map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 40, duration: 600 });
          }
          return;
        }
      } catch (e) { /* fall through */ }
    }
    if (typeof App.setStatus === "function") App.setStatus("Could not determine layer extent.");
  }

  function zoomToFeatures(items) {
    if (!items.length || typeof turf === "undefined") return;
    var fc = { type: "FeatureCollection", features: items.map(function (it) { return it.feature; }) };
    try {
      var bb = turf.bbox(fc);
      App.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 600 });
    } catch (e) { /* ignore */ }
  }

  // Reorder a band's map layers to match panel order (top of list = top of map),
  // staying clamped within the band — the layer above the band keeps its place.
  function applyBandOrder(presentEntries) {
    var map = App.map;
    if (!presentEntries.length) return;
    var allIds = [];
    presentEntries.forEach(function (e) {
      e.layers.forEach(function (L) { if (map.getLayer(L.id)) allIds.push(L.id); });
    });
    var styleIds = map.getStyle().layers.map(function (l) { return l.id; });
    var maxIdx = -1;
    allIds.forEach(function (id) { var i = styleIds.indexOf(id); if (i > maxIdx) maxIdx = i; });
    var anchor = styleIds[maxIdx + 1]; // layer above the band (or undefined = top)
    var beforeId = anchor;
    presentEntries.forEach(function (entry) {
      entry.layers.forEach(function (L) {
        if (map.getLayer(L.id)) map.moveLayer(L.id, beforeId);
      });
      var bottom = entry.layers[0] && entry.layers[0].id;
      if (bottom && map.getLayer(bottom)) beforeId = bottom;
    });
  }

  // ---- Drag-to-reorder (within a single band) ----
  var _drag = null; // { band, id }

  function attachDrag(row, bandKey, entryId, order, getPresent) {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", function (e) {
      _drag = { band: bandKey, id: entryId };
      row.classList.add("lp-dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("lp-dragging");
      _drag = null;
    });
    row.addEventListener("dragover", function (e) {
      if (!_drag || _drag.band !== bandKey || _drag.id === entryId) return;
      e.preventDefault();
      row.classList.add("lp-drop-target");
    });
    row.addEventListener("dragleave", function () { row.classList.remove("lp-drop-target"); });
    row.addEventListener("drop", function (e) {
      row.classList.remove("lp-drop-target");
      if (!_drag || _drag.band !== bandKey || _drag.id === entryId) return;
      e.preventDefault();
      var from = order.indexOf(_drag.id);
      var to = order.indexOf(entryId);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, _drag.id);
      applyBandOrder(getPresent());
      render();
    });
  }

  // ---- Generic row builder (reference / analysis) ----
  function buildLayerRow(entry, bandKey, order, getPresent) {
    var row = document.createElement("div");
    row.className = "lp-row lp-row-draggable";

    var grip = document.createElement("span");
    grip.className = "lp-grip";
    grip.innerHTML = GRIP_SVG;
    grip.title = "Drag to reorder";
    row.appendChild(grip);

    var vis = entryVisible(entry);
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-layer-eye ui-hover-chip" + (vis ? "" : " lp-eye-off");
    eye.innerHTML = vis ? EYE_SVG : EYE_OFF_SVG;
    eye.title = vis ? "Hide layer" : "Show layer";
    eye.setAttribute("aria-label", (vis ? "Hide " : "Show ") + entry.label);
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setEntryVisible(entry, !entryVisible(entry));
      // Keep the Add Data dropdown eye icons in sync (single source of truth);
      // updateAddDataClearIcons() also re-renders this panel.
      if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
      else render();
    });

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = entry.label;
    row.appendChild(name);

    // Chips appended after the name, farthest offset first (eye 48 -> op 24 -> menu 0),
    // matching the Features tab's documented DOM-order convention.
    row.appendChild(eye);

    var op = document.createElement("button");
    op.type = "button";
    op.className = "lp-row-op ui-hover-chip";
    op.innerHTML = OPACITY_SVG;
    op.title = "Opacity";
    op.setAttribute("aria-label", "Change opacity for " + entry.label);
    op.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App._openFpSlider !== "function") return;
      App._openFpSlider(op, {
        value: Math.round(entryOpacity(entry) * 100),
        min: 0, max: 100, step: 5, unit: "%",
        onChange: function (v) { setEntryOpacity(entry, v / 100); }
      });
    });
    row.appendChild(op);

    var menu = document.createElement("button");
    menu.type = "button";
    menu.className = "lp-row-menu ui-hover-chip";
    menu.innerHTML = MENU_SVG;
    menu.title = "More";
    menu.setAttribute("aria-label", "More actions for " + entry.label);
    function layerMenuOptions() {
      var opts = [{ label: "Zoom to layer", action: function () { zoomToEntry(entry); } }];
      if (entry.moduleId) {
        opts.push({ label: "Open module", action: function () {
          if (typeof App.openModulePopup === "function") App.openModulePopup(entry.moduleId);
        } });
      }
      if (typeof entry.clear === "function") {
        opts.push({ label: "Remove layer", action: function () {
          entry.clear();
          if (typeof App.updateAddDataClearIcons === "function") App.updateAddDataClearIcons();
          render();
        } });
      }
      return opts;
    }

    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App.showContextMenu === "function") {
        App.showContextMenu(e.clientX, e.clientY, layerMenuOptions());
      }
    });
    row.appendChild(menu);

    row.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof App.showContextMenu === "function") {
        App.showContextMenu(e.clientX, e.clientY, layerMenuOptions());
      }
    });

    attachDrag(row, bandKey, entry.id, order, getPresent);
    return row;
  }

  // ---- Drawn features (nested by user group) ----
  function collectGroups() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var key = App.UNIVERSAL_GROUP_KEY || "group";
    var groups = {}, ungrouped = [];
    all.forEach(function (it) {
      var a = it.feature.properties.attributes;
      var g = a && a[key];
      if (g) { (groups[g] = groups[g] || []).push(it); }
      else { ungrouped.push(it); }
    });
    return { groups: groups, ungrouped: ungrouped };
  }

  function setItemsHidden(items, hide) {
    var types = {};
    items.forEach(function (it) {
      if (hide) it.feature.properties.hidden = true;
      else delete it.feature.properties.hidden;
      types[it.type] = true;
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
  }

  // Solo: show only the given items, hide every other drawn feature.
  function soloItems(items) {
    var keep = {};
    items.forEach(function (it) { keep[it.type + ":" + it.index] = true; });
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var types = {};
    all.forEach(function (it) {
      if (keep[it.type + ":" + it.index]) delete it.feature.properties.hidden;
      else it.feature.properties.hidden = true;
      types[it.type] = true;
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  function showAllDrawn() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    var types = {};
    all.forEach(function (it) {
      if (it.feature.properties.hidden) { delete it.feature.properties.hidden; types[it.type] = true; }
    });
    Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  function anyDrawnHidden() {
    var all = (typeof App.collectDrawnFeatures === "function") ? App.collectDrawnFeatures() : [];
    return all.some(function (it) { return !!it.feature.properties.hidden; });
  }

  var _expandedFeatureStyle = {};

  function buildFeatureRow(it) {
    var wrapper = document.createElement("div");
    wrapper.className = "lp-feature";

    var isSelected = typeof App.isFeatureSelected === "function" && App.isFeatureSelected(it.type, it.index);
    var row = document.createElement("div");
    row.className = "lp-row lp-row-sub" +
      (it.feature.properties.hidden ? " lp-row-hidden" : "") +
      (isSelected ? " lp-row-selected" : "");

    var featKey = it.type + ":" + it.index;
    var featLabel = it.feature.properties.name || (it.type + " " + (it.index + 1));
    var hasOverrides = !!FEATURE_OVERRIDE_SPECS[it.type];
    var open = hasOverrides && !!_expandedFeatureStyle[featKey];

    if (hasOverrides) {
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "lp-caret";
      toggle.innerHTML = "&#9662;";
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-label", "Toggle style overrides for " + featLabel);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        var isOpen = drawer.style.display !== "none";
        drawer.style.display = isOpen ? "none" : "";
        toggle.classList.toggle("open", !isOpen);
        toggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
        if (isOpen) delete _expandedFeatureStyle[featKey];
        else _expandedFeatureStyle[featKey] = true;
      });
      row.appendChild(toggle);
    }

    var hidden = !!it.feature.properties.hidden;
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-row-eye ui-hover-chip" + (hidden ? " lp-eye-off" : "");
    eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_SVG;
    eye.title = hidden ? "Show" : "Hide";
    eye.setAttribute("aria-label", (hidden ? "Show " : "Hide ") + featLabel);
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setItemsHidden([it], !it.feature.properties.hidden);
      render();
    });

    // Type icon — same type-shaped, color-tinted glyph the Features tab uses,
    // so a row shows both "what type" and "what color" in one 24px control.
    var typeIcon = document.createElement("button");
    typeIcon.type = "button";
    typeIcon.className = "fp-type-icon";
    typeIcon.innerHTML = (App.TYPE_ICON_SVGS || {})[it.type] || "";
    typeIcon.title = "Change " + (TYPE_LABELS_LOCAL[it.type] || it.type) + " color";
    typeIcon.setAttribute("aria-label", typeIcon.title);
    typeIcon.style.color = App.resolveFeatureColor(it.type, it.feature);
    typeIcon.addEventListener("click", function (e) {
      e.stopPropagation();
      var curColor = typeIcon.style.color;
      App.openColorPicker(typeIcon, curColor, function (nc) {
        it.feature.properties.color = nc;
        App.rerenderForType(it.type);
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        render();
      });
    });
    row.appendChild(typeIcon);

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = featLabel;
    row.appendChild(name);

    row.appendChild(eye);

    row.addEventListener("mouseenter", function () {
      if (typeof App.setHoveredFeature === "function") App.setHoveredFeature(it.type, it.index);
    });
    row.addEventListener("mouseleave", function () {
      if (typeof App.clearHover === "function") App.clearHover();
    });
    row.addEventListener("click", function () {
      if (typeof App.selectFeature === "function") App.selectFeature(it.type, it.index);
      render();
    });

    row.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var opts = [
        { label: "Zoom to feature", action: function () { zoomToFeatures([it]); } },
        { label: it.feature.properties.hidden ? "Show" : "Hide", action: function () {
          setItemsHidden([it], !it.feature.properties.hidden);
          render();
        } }
      ];
      if (it.feature.properties.color) {
        opts.push({ label: "Clear color override", action: function () {
          it.feature.properties.color = "";
          App.rerenderForType(it.type);
          if (App.cache && typeof App.cache.save === "function") App.cache.save();
          if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
          render();
        } });
      }
      opts.push({ label: "Edit attributes…", action: function () {
        if (typeof App.openAttrPopup === "function") App.openAttrPopup(it.type, it.index, it.feature);
      } });
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, opts);
    });

    wrapper.appendChild(row);

    var drawer;
    if (hasOverrides) {
      drawer = buildFeatureOverrideDrawer(it);
      drawer.style.display = open ? "" : "none";
      wrapper.appendChild(drawer);
    }

    return wrapper;
  }

  var _expandedGroups = {};

  function buildGroupBlock(groupName, items) {
    var block = document.createElement("div");
    block.className = "lp-group";

    var header = document.createElement("div");
    header.className = "lp-row lp-group-header";

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "lp-caret";
    var open = !!_expandedGroups[groupName];
    toggle.innerHTML = "&#9662;";
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-label", "Toggle group " + groupName);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    header.appendChild(toggle);

    var allHidden = items.every(function (it) { return !!it.feature.properties.hidden; });
    header.classList.toggle("lp-row-hidden", allHidden);
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lp-group-eye ui-hover-chip" + (allHidden ? " lp-eye-off" : "");
    eye.innerHTML = allHidden ? EYE_OFF_SVG : EYE_SVG;
    eye.title = allHidden ? "Show all" : "Hide all";
    eye.setAttribute("aria-label", (allHidden ? "Show" : "Hide") + " group " + groupName);
    eye.addEventListener("click", function (e) {
      e.stopPropagation();
      setItemsHidden(items, !allHidden);
      render();
    });

    var firstColor = items[0].feature.properties.color || App.getTypeDefaultColor(items[0].type);
    header.style.borderLeftColor = firstColor;
    function changeGroupColor(anchorEl) {
      App.openColorPicker(anchorEl, firstColor, function (nc) {
        var types = {};
        items.forEach(function (it) { it.feature.properties.color = nc; types[it.type] = true; });
        header.style.borderLeftColor = nc;
        Object.keys(types).forEach(function (t) { App.rerenderForType(t); });
        if (App.cache && typeof App.cache.save === "function") App.cache.save();
        if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
        render();
      });
    }

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = groupName + " (" + items.length + ")";
    header.appendChild(name);

    function startGroupRename() {
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "fp-group-name-edit";
      inp.value = groupName;
      name.style.display = "none";
      header.insertBefore(inp, name.nextSibling);
      inp.focus();
      inp.select();
      function save() {
        var newName = inp.value.trim();
        inp.remove();
        name.style.display = "";
        if (newName && newName !== groupName) renameGroup(groupName, items, newName);
      }
      inp.addEventListener("click", function (e) { e.stopPropagation(); });
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") inp.blur();
        if (ev.key === "Escape") { inp.value = groupName; inp.blur(); }
      });
    }

    // Chips appended after the name, farthest offset first (eye 24 -> menu 0),
    // matching the Features tab's documented DOM-order convention.
    header.appendChild(eye);

    var isUngrouped = (groupName === "Ungrouped");
    var menu = document.createElement("button");
    menu.type = "button";
    menu.className = "lp-row-menu ui-hover-chip";
    menu.innerHTML = MENU_SVG;
    menu.title = "More";
    menu.setAttribute("aria-label", "More actions for group " + groupName);

    function groupMenuOptions() {
      var opts = [
        { label: "Zoom to group", action: function () { zoomToFeatures(items); } },
        { label: "Solo (hide other features)", action: function () { soloItems(items); } },
        { label: "Change group color", action: function () { changeGroupColor(menu); } }
      ];
      if (anyDrawnHidden()) {
        opts.push({ label: "Show all features", action: function () { showAllDrawn(); } });
      }
      if (!isUngrouped) {
        opts.push({ label: "Rename group", action: function () { startGroupRename(); } });
      }
      return opts;
    }

    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, groupMenuOptions());
    });
    header.appendChild(menu);

    header.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, groupMenuOptions());
    });

    var body = document.createElement("div");
    body.className = "lp-group-body";
    body.style.display = open ? "" : "none";
    items.forEach(function (it) { body.appendChild(buildFeatureRow(it)); });

    function toggleOpen(e) {
      if (e.target !== toggle && !toggle.contains(e.target) &&
          e.target !== name) return;
      e.stopPropagation();
      var isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "";
      toggle.classList.toggle("open", !isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
      if (isOpen) delete _expandedGroups[groupName];
      else _expandedGroups[groupName] = true;
    }
    header.addEventListener("click", toggleOpen);

    block.appendChild(header);
    block.appendChild(body);
    return block;
  }

  function renameGroup(oldName, items, newName) {
    var nn = (newName || "").trim();
    if (!nn || nn === oldName) return;
    var key = App.UNIVERSAL_GROUP_KEY || "group";
    items.forEach(function (it) {
      if (!it.feature.properties.attributes) it.feature.properties.attributes = {};
      it.feature.properties.attributes[key] = nn;
    });
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    render();
  }

  // ---- Band scaffolding ----
  function buildBand(title) {
    var band = document.createElement("div");
    band.className = "lp-band";
    var h = document.createElement("div");
    h.className = "lp-band-title";
    h.textContent = title;
    band.appendChild(h);
    return band;
  }

  var _expandedTypeStyle = {};

  function resetTypeStyle(t) {
    t.controls.forEach(function (ctl) {
      if (ctl.kind === "color") {
        if (App.sectionColors) App.sectionColors[t.type] = null;
        App.rerenderForType(t.type);
      } else {
        App.featureSettings[ctl.key] = ctl.def;
      }
    });
    applyTypeStyle(t.type);
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  function buildTypeStyleRow(t) {
    var wrap = document.createElement("div");
    wrap.className = "lp-style-group";

    var header = document.createElement("div");
    header.className = "lp-row lp-row-sub lp-style-header";

    var open = !!_expandedTypeStyle[t.type];
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "lp-caret";
    toggle.innerHTML = "&#9662;";
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-label", "Toggle " + t.label + " style");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    header.appendChild(toggle);

    var preview = buildStylePreview(t.type);
    header.appendChild(preview);

    var name = document.createElement("span");
    name.className = "lp-row-label";
    name.textContent = t.label;
    header.appendChild(name);

    header.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "";
      toggle.classList.toggle("open", !isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
      if (isOpen) delete _expandedTypeStyle[t.type];
      else _expandedTypeStyle[t.type] = true;
    });

    var body = document.createElement("div");
    body.className = "lp-style-drawer";
    body.style.display = open ? "" : "none";

    function refreshPreview() { updateStylePreview(preview, t.type); }

    t.controls.forEach(function (ctl) {
      var row = document.createElement("div");
      row.className = "lp-style-row";

      var lab = document.createElement("span");
      lab.className = "lp-style-label";
      lab.textContent = ctl.label;
      row.appendChild(lab);

      var controlWrap = document.createElement("div");
      controlWrap.className = "lp-style-control";
      row.appendChild(controlWrap);

      if (ctl.kind === "color") {
        var flatColor = App.sectionColors && App.sectionColors[t.type];
        var sw = document.createElement("button");
        sw.type = "button";
        sw.className = "lp-swatch";
        sw.setAttribute("aria-label", "Change default color for " + t.label);
        if (flatColor) {
          sw.style.background = flatColor;
          sw.title = "Change default color";
        } else if (t.type === "line" || t.type === "route") {
          // Automatic: no single default to show, so the swatch reads as
          // "these vary" via a gradient sampled from the rainbow palette.
          sw.style.background = "linear-gradient(135deg, " + App.FEATURE_COLORS.slice(0, 6).join(", ") + ")";
          sw.title = "Automatic — each feature keeps its own color. Click to set one fixed color for all.";
        } else {
          sw.style.background = App.getTypeDefaultColor(t.type);
          sw.title = "Change default color";
        }
        sw.addEventListener("click", function (e) {
          e.stopPropagation();
          App.openColorPicker(sw, App.getTypeDefaultColor(t.type), function (nc) {
            if (!App.sectionColors) App.sectionColors = {};
            App.sectionColors[t.type] = nc;
            App.rerenderForType(t.type);
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
            render();
          });
        });
        controlWrap.appendChild(sw);

        if (flatColor) {
          var clearColorBtn = document.createElement("button");
          clearColorBtn.type = "button";
          clearColorBtn.className = "lp-style-clear";
          clearColorBtn.textContent = "×";
          clearColorBtn.title = "Reset to Automatic";
          clearColorBtn.setAttribute("aria-label", "Reset " + t.label + " color to Automatic");
          clearColorBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (App.sectionColors) App.sectionColors[t.type] = null;
            App.rerenderForType(t.type);
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
            render();
          });
          controlWrap.appendChild(clearColorBtn);
        }
      } else {
        var scrubber = App.buildScrubber({
          min: ctl.min, max: ctl.max, step: ctl.step, unit: ctl.unit,
          value: App.featureSettings[ctl.key],
          onChange: function (v) {
            App.featureSettings[ctl.key] = v;
            applyTypeStyle(t.type);
            refreshPreview();
            if (App.cache && typeof App.cache.save === "function") App.cache.save();
          }
        });
        controlWrap.appendChild(scrubber);
      }
      body.appendChild(row);
    });

    var resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "lp-style-reset";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Reset to defaults";
    resetBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      resetTypeStyle(t);
      render();
    });
    body.appendChild(resetBtn);

    wrap.appendChild(header);
    wrap.appendChild(body);
    return wrap;
  }

  // ---- Basemap row ----
  function buildBasemapBand() {
    var band = buildBand("Basemap");
    if (typeof App.getBasemaps !== "function") return band;
    var row = document.createElement("div");
    row.className = "lp-row";
    var sel = document.createElement("select");
    sel.className = "lp-basemap-select";
    var cur = (typeof App.getCurrentBasemapId === "function") ? App.getCurrentBasemapId() : null;
    App.getBasemaps().forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.id; o.textContent = b.name;
      if (b.id === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      if (typeof App.switchBasemap === "function") App.switchBasemap(sel.value);
    });
    row.appendChild(sel);
    band.appendChild(row);
    return band;
  }

  // ---- Render ----
  function render() {
    var host = document.getElementById("fp-tab-layers");
    if (!host) return;
    host.innerHTML = "";

    // Drawn
    var drawnBand = buildBand("Drawn");
    var gc = collectGroups();
    var groupNames = Object.keys(gc.groups).sort();
    var anyDrawn = groupNames.length || gc.ungrouped.length;
    if (anyDrawn) {
      groupNames.forEach(function (gn) {
        drawnBand.appendChild(buildGroupBlock(gn, gc.groups[gn]));
      });
      if (gc.ungrouped.length) {
        drawnBand.appendChild(buildGroupBlock("Ungrouped", gc.ungrouped));
      }
      // Style defaults: one drawer per geometry type that currently has
      // features (drawn features of a type share one map layer per type, so
      // this is where the type-default half of the appearance cascade lives).
      var stylableTypes = DRAWN_TYPES.filter(function (t) { return typeHasFeatures(t.type); });
      if (stylableTypes.length) {
        var styleHeading = document.createElement("div");
        styleHeading.className = "lp-subheading";
        styleHeading.textContent = "Style defaults";
        drawnBand.appendChild(styleHeading);
        stylableTypes.forEach(function (t) {
          drawnBand.appendChild(buildTypeStyleRow(t));
        });
      }
    } else {
      var empty = document.createElement("div");
      empty.className = "lp-empty";
      empty.textContent = "No drawn features yet.";
      drawnBand.appendChild(empty);
    }
    host.appendChild(drawnBand);

    // Analysis overlays (only those currently on the map)
    var getAnalysis = function () { return orderedPresent(ANALYSIS, _analysisOrder); };
    var analysisPresent = getAnalysis();
    if (analysisPresent.length) {
      var aBand = buildBand("Analysis overlays");
      analysisPresent.forEach(function (e) {
        aBand.appendChild(buildLayerRow(e, "analysis", _analysisOrder, getAnalysis));
      });
      host.appendChild(aBand);
    }

    // Reference / imported (only those currently on the map)
    var getRef = function () { return orderedPresent(REFERENCE, _refOrder); };
    var refPresent = getRef();
    if (refPresent.length) {
      var rBand = buildBand("Reference / Imported");
      refPresent.forEach(function (e) {
        rBand.appendChild(buildLayerRow(e, "reference", _refOrder, getRef));
      });
      host.appendChild(rBand);
    }

    // Basemap
    host.appendChild(buildBasemapBand());
  }

  function refreshLayersPanel() {
    var host = document.getElementById("fp-tab-layers");
    // Only rebuild when the Layers tab is actually visible (cheap no-op otherwise).
    if (!host || host.style.display === "none") return;
    render();
  }

  App.refreshLayersPanel = refreshLayersPanel;
})();
