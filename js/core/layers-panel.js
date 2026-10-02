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
// Analysis/reference layer color styling (docs/layer-color-customization-plan.md
// Phase 6) additionally depends on window.LayerPalette, App.resolveLayerColors,
// App.setLayerStyle, App.clearLayerStyle, App.layerStyles, App.mapPalette,
// App.repaintStyledLayers (js/core/layer-palettes.js) — all optional, guarded
// with typeof checks so a missing script tag just omits the style drawers.
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
      { id: "walk-network-excluded-line", op: "line-opacity" },
      { id: "network-joins-point", op: "circle-opacity" }],
      clear: callIf("clearRoadNetwork") },
    { id: "sidewalk-coverage-line", label: "Sidewalk coverage",  layers: [{ id: "sidewalk-coverage-line", op: "line-opacity" }],
      clear: callIf("clearRoadNetwork") },
    { id: "gtfs-shapes-layer",    label: "GTFS routes",          layers: [{ id: "gtfs-shapes-layer", op: "line-opacity" }],
      clear: callIf("clearGTFS"), styleKey: "gtfs-shapes" },
    { id: "gtfs-stops-layer",     label: "GTFS stops",           layers: [{ id: "gtfs-stops-layer", op: "circle-opacity" }],
      clear: callIf("clearGTFS"), styleKey: "gtfs-stops" },
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
    { id: "tpi-choropleth-fill", label: "Transit Propensity", moduleId: "transit-propensity", styleKey: "tpi",
      layers: [{ id: "tpi-choropleth-fill", op: "fill-opacity" }, { id: "tpi-choropleth-line", op: "line-opacity" }] },
    { id: "corridor-scoring-routes-layer", label: "Corridor Scoring", moduleId: "corridor-scoring", styleKey: "corridor-scoring",
      layers: [{ id: "corridor-scoring-routes-layer", op: "line-opacity" }] },
    { id: "rf-choropleth-fill", label: "Ridership Forecast", moduleId: "ridership-forecasting", styleKey: "rf",
      layers: [{ id: "rf-choropleth-fill", op: "fill-opacity" }, { id: "rf-choropleth-line", op: "line-opacity" }, { id: "rf-corridor-cdi-layer", op: "line-opacity" }] },
    { id: "ts-travelshed-fill", label: "Transit Travelshed", moduleId: "transit-travelshed", styleKey: "transit-travelshed",
      layers: [{ id: "ts-travelshed-fill", op: "fill-opacity" }, { id: "ts-travelshed-line", op: "line-opacity" }] },
    // Added after an audit found five map-rendering surfaces were never
    // registered here, so their output was invisible to this panel — no
    // show/hide, no opacity, no reorder. Entries only render when the layer is
    // actually on the map (see entryPresent), so listing them all is safe.
    { id: "transit-coverage-coverage-layer", label: "Transit Coverage", moduleId: "transit-coverage", styleKey: "transit-coverage",
      layers: [{ id: "transit-coverage-coverage-layer", op: "fill-opacity" },
               { id: "transit-coverage-threshold-layer", op: "fill-opacity" },
               { id: "transit-coverage-area-layer", op: "line-opacity" }] },
    { id: "walkshed-fill", label: "Walkshed", moduleId: "walkshed", styleKey: "walkshed",
      layers: [{ id: "walkshed-fill", op: "fill-opacity" },
               { id: "walkshed-line", op: "line-opacity" }] },
    { id: "walkshed-seg", label: "Walkshed — reachable streets", moduleId: "walkshed", styleKey: "walkshed-seg",
      layers: [{ id: "walkshed-seg", op: "line-opacity" }] },
    { id: "tvi-impacted-fill", label: "Title VI service change", moduleId: "title-vi", styleKey: "title-vi",
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
      var lw = Math.max(1, (fs[type + "LineWidth"] || 1) * 3);
      var lOp = (fs[type + "Opacity"] != null ? fs[type + "Opacity"] : 100) / 100;
      if (!(App.sectionColors && App.sectionColors[type])) {
        // Automatic: each feature keeps its own palette color, so the preview
        // is a line of consecutive segments in the rainbow palette. (Segments,
        // not an SVG gradient: a gradient on a perfectly horizontal line has
        // a zero-height bounding box and paints nothing.)
        var cols = App.FEATURE_COLORS.slice(0, 6);
        var segW = 34 / cols.length;
        cols.forEach(function (col, i) {
          var seg = document.createElementNS(SVG_NS, "line");
          seg.setAttribute("x1", (3 + i * segW).toFixed(2)); seg.setAttribute("y1", "8");
          seg.setAttribute("x2", (3 + (i + 1) * segW).toFixed(2)); seg.setAttribute("y2", "8");
          seg.setAttribute("stroke", col); seg.setAttribute("stroke-width", lw); seg.setAttribute("stroke-opacity", lOp);
          seg.setAttribute("stroke-linecap", "butt");
          seg.setAttribute("class", "lp-preview-seg");
          svg.appendChild(seg);
        });
      } else {
        var l = document.createElementNS(SVG_NS, "line");
        l.setAttribute("x1", "3"); l.setAttribute("y1", "8"); l.setAttribute("x2", "37"); l.setAttribute("y2", "8");
        l.setAttribute("stroke", lColor); l.setAttribute("stroke-width", lw); l.setAttribute("stroke-opacity", lOp);
        l.setAttribute("stroke-linecap", "round");
        svg.appendChild(l);
      }
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

  // ---- Per-feature override drawer (buildFeatureRow) ----
  // The rows (opacity / width / offset) are built by
  // App.buildFeatureOverrideRows (js/core/feature-appearance.js) — the same
  // builder the Appearance popover uses, so the cascade logic lives once.
  // Per-feature buffer radius is NOT here: it is study-area geometry, edited
  // from the Attributes popup / Attribute Summary (App.buildBufferRadiusControl).
  function buildFeatureOverrideDrawer(it) {
    var body = document.createElement("div");
    body.className = "lp-style-drawer lp-style-drawer-feature";
    if (!FEATURE_OVERRIDE_SPECS[it.type] || typeof App.buildFeatureOverrideRows !== "function") return body;
    App.buildFeatureOverrideRows(it.type, it.feature, {}).forEach(function (r) {
      body.appendChild(r);
    });
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

  // ---- Analysis/reference layer style drawer (Palette/Reverse/Color, per
  // styleKey — docs/layer-color-customization-plan.md Phase 6). Mirrors
  // buildTypeStyleRow's shape but writes through App.setLayerStyle /
  // App.clearLayerStyle instead of App.sectionColors / App.featureSettings,
  // since these are analysis-rendered layers, not drawn features (see the
  // App.registerLayerRepainter registry in layer-palettes.js — this drawer
  // never touches map.setPaintProperty itself). ----
  var _expandedLayerStyle = {};

  // One "<label>  [swatch] [×]" row — shared by the solid drawer, the
  // categorical drawer's per-class rows, and the custom gradient's two
  // endpoint picks. `onClear` null means the row shows no × (nothing to
  // clear), matching how the solid drawer already behaves at defaults.
  function buildSwatchRow(label, color, onPick, onClear) {
    var row = document.createElement("div");
    row.className = "lp-style-row";

    var lab = document.createElement("span");
    lab.className = "lp-style-label";
    lab.textContent = label;
    row.appendChild(lab);

    var wrap = document.createElement("div");
    wrap.className = "lp-style-control";
    row.appendChild(wrap);

    var sw = document.createElement("button");
    sw.type = "button";
    sw.className = "lp-swatch";
    sw.style.background = color;
    sw.title = "Change color";
    sw.setAttribute("aria-label", "Change " + label + " color");
    sw.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openColorPicker(sw, color, onPick);
    });
    wrap.appendChild(sw);

    if (onClear) {
      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "lp-style-clear";
      clearBtn.textContent = "×";
      clearBtn.title = "Clear override (use default)";
      clearBtn.setAttribute("aria-label", "Clear " + label + " color override");
      clearBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        onClear();
      });
      wrap.appendChild(clearBtn);
    }

    return row;
  }

  function buildLayerStyleDrawer(styleKey, spec, rerender) {
    var body = document.createElement("div");
    body.className = "lp-style-drawer";

    var ov = (App.layerStyles && App.layerStyles[styleKey]) || {};

    if (spec.kind === "ramp") {
      var pRow = document.createElement("div");
      pRow.className = "lp-style-row";
      var pLab = document.createElement("span");
      pLab.className = "lp-style-label";
      pLab.textContent = "Palette";
      pRow.appendChild(pLab);
      var pWrap = document.createElement("div");
      pWrap.className = "lp-style-control";
      pRow.appendChild(pWrap);

      var sel = document.createElement("select");
      sel.className = "lp-basemap-select";
      var defOpt = document.createElement("option");
      defOpt.value = "";
      defOpt.textContent = "Default";
      sel.appendChild(defOpt);
      window.LayerPalette.list(spec.allow).forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.label;
        sel.appendChild(o);
      });
      // Custom is offered on every ramp layer regardless of spec.allow: it is
      // two deliberate picks, not a preset that could be chosen by accident,
      // and it is exactly what a colorblind user wants on the one layer whose
      // presets are most restricted. It is per-layer only — the global
      // palette row never lists it (see CUSTOM_ID in layer-palettes.js).
      var customOpt = document.createElement("option");
      customOpt.value = window.LayerPalette.CUSTOM_ID;
      customOpt.textContent = "Custom";
      sel.appendChild(customOpt);

      var isCustom = ov.palette === window.LayerPalette.CUSTOM_ID;
      sel.value = ov.palette || "";
      sel.addEventListener("click", function (e) { e.stopPropagation(); });
      sel.addEventListener("change", function () {
        var patch = { palette: sel.value || null };
        if (sel.value === window.LayerPalette.CUSTOM_ID && !ov.from && !ov.to) {
          // Seed the two endpoints from what this layer is painting right
          // now (resolved BEFORE the state change), so switching to Custom
          // is a visual no-op and the swatches open where the map already is.
          var cur = App.resolveLayerColors(styleKey) || spec.defaultColors;
          patch.from = cur[0];
          patch.to = cur[cur.length - 1];
        }
        App.setLayerStyle(styleKey, patch);
        rerender();
      });
      pWrap.appendChild(sel);
      body.appendChild(pRow);

      if (isCustom) {
        // Two endpoint picks in place of the Reverse row — reversing a 2-stop
        // gradient is just swapping these two, so a Reverse control here
        // would be a redundant fourth row (the plan's §3 caps a drawer at
        // three). The resolver paints From -> To literally for the same
        // reason, so these swatches always read the way the map does.
        var gRow = document.createElement("div");
        gRow.className = "lp-style-row";
        var gLab = document.createElement("span");
        gLab.className = "lp-style-label";
        gLab.textContent = "Colors";
        gRow.appendChild(gLab);
        var gWrap = document.createElement("div");
        gWrap.className = "lp-style-control";
        gRow.appendChild(gWrap);

        [["from", ov.from, "start"], ["to", ov.to, "end"]].forEach(function (stop) {
          var sw = document.createElement("button");
          sw.type = "button";
          sw.className = "lp-swatch";
          sw.style.background = stop[1] || "#888888";
          sw.title = (stop[0] === "from") ? "Gradient start" : "Gradient end";
          sw.setAttribute("aria-label", "Change gradient " + stop[2] + " color for " + spec.label);
          sw.addEventListener("click", function (e) {
            e.stopPropagation();
            App.openColorPicker(sw, stop[1] || "#888888", function (nc) {
              var patch = {};
              patch[stop[0]] = nc;
              App.setLayerStyle(styleKey, patch);
              rerender();
            });
          });
          gWrap.appendChild(sw);
        });
        body.appendChild(gRow);
      } else {
        var rRow = document.createElement("div");
        rRow.className = "lp-style-row";
        var rLab = document.createElement("span");
        rLab.className = "lp-style-label";
        rLab.textContent = "Reverse";
        rRow.appendChild(rLab);
        var rWrap = document.createElement("div");
        rWrap.className = "lp-style-control";
        rRow.appendChild(rWrap);

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!((ov.reverse != null) ? ov.reverse : spec.reverseDefault);
        cb.disabled = !ov.palette;
        cb.addEventListener("click", function (e) { e.stopPropagation(); });
        cb.addEventListener("change", function () {
          App.setLayerStyle(styleKey, { reverse: cb.checked });
          rerender();
        });
        rWrap.appendChild(cb);
        body.appendChild(rRow);
      }

      // Overlap flattening — a display option, orthogonal to color, so it
      // renders in both the Custom-gradient and preset-palette branches
      // above (spec.flattenOption opts a ramp layer in; only "walkshed" does
      // today — see js/projects/walkshed.js's renderWalkshedLayers for what
      // this actually changes on the map).
      if (spec.flattenOption) {
        var fRow = document.createElement("div");
        fRow.className = "lp-style-row";
        var fLab = document.createElement("span");
        fLab.className = "lp-style-label";
        fLab.textContent = "Flatten overlaps";
        fRow.appendChild(fLab);
        var fWrap = document.createElement("div");
        fWrap.className = "lp-style-control";
        fRow.appendChild(fWrap);

        var fcb = document.createElement("input");
        fcb.type = "checkbox";
        fcb.checked = !!ov.flatten;
        fcb.title = "Show only the shortest band in overlapping areas; longer bands keep an outline.";
        fcb.setAttribute("aria-label", "Flatten overlapping " + spec.label + " bands");
        fcb.addEventListener("click", function (e) { e.stopPropagation(); });
        fcb.addEventListener("change", function () {
          App.setLayerStyle(styleKey, { flatten: fcb.checked || null });
          rerender();
        });
        fWrap.appendChild(fcb);
        body.appendChild(fRow);
      }

      if (ov.palette || ov.reverse != null || ov.flatten) {
        var resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "lp-style-reset";
        resetBtn.textContent = "Reset";
        resetBtn.title = "Reset to default";
        resetBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          App.clearLayerStyle(styleKey);
          rerender();
        });
        body.appendChild(resetBtn);
      }
    } else if (spec.kind === "solid") {
      var colors = (App.resolveLayerColors && App.resolveLayerColors(styleKey)) || spec.defaultColors;
      body.appendChild(buildSwatchRow(
        "Color",
        colors[0],
        function (nc) { App.setLayerStyle(styleKey, { color: nc }); rerender(); },
        ov.color ? function () { App.clearLayerStyle(styleKey); rerender(); } : null
      ));
    } else if (spec.kind === "categorical") {
      // One swatch per semantic class. No palette select (these aren't a
      // ramp) and no Reset row — each row's × already is one, the same
      // argument the solid drawer makes.
      var catColors = (App.resolveLayerColors && App.resolveLayerColors(styleKey)) || spec.defaultColors;
      var ovColors = ov.colors || [];
      (spec.classes || []).forEach(function (cls, i) {
        body.appendChild(buildSwatchRow(
          cls.label,
          catColors[i],
          function (nc) { App.setLayerClassColor(styleKey, i, nc); rerender(); },
          ovColors[i] ? function () { App.setLayerClassColor(styleKey, i, null); rerender(); } : null
        ));
      });
    }

    return body;
  }

  // ---- Generic row builder (reference / analysis) ----
  function buildLayerRow(entry, bandKey, order, getPresent) {
    var spec = (entry.styleKey && typeof window.LayerPalette !== "undefined" &&
                typeof window.LayerPalette.specFor === "function")
      ? window.LayerPalette.specFor(entry.styleKey) : null;

    var wrap = document.createElement("div");
    wrap.className = "lp-style-group";

    var row = document.createElement("div");
    row.className = "lp-row lp-row-draggable";

    var drawer = null;
    if (spec) {
      var open = !!_expandedLayerStyle[entry.styleKey];
      var caret = document.createElement("button");
      caret.type = "button";
      caret.className = "lp-caret";
      caret.innerHTML = "&#9662;";
      caret.classList.toggle("open", open);
      caret.setAttribute("aria-label", "Toggle style for " + entry.label);
      caret.setAttribute("aria-expanded", open ? "true" : "false");
      caret.addEventListener("click", function (e) {
        e.stopPropagation();
        var isOpen = drawer.style.display !== "none";
        drawer.style.display = isOpen ? "none" : "";
        caret.classList.toggle("open", !isOpen);
        caret.setAttribute("aria-expanded", isOpen ? "false" : "true");
        if (isOpen) delete _expandedLayerStyle[entry.styleKey];
        else _expandedLayerStyle[entry.styleKey] = true;
      });
      row.appendChild(caret);
    }

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
      // A styled layer's owning module may want to react to a visibility
      // toggle (e.g. Walkshed hides its "Reachable streets" legend row when
      // the walkshed-seg layer is hidden) — its repainter is a no-op paint
      // re-apply plus a state refresh, so it's safe to call unconditionally.
      if (entry.styleKey && typeof App.repaintStyledLayers === "function") {
        App.repaintStyledLayers(entry.styleKey);
      }
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
    wrap.appendChild(row);

    if (spec) {
      drawer = buildLayerStyleDrawer(entry.styleKey, spec, render);
      drawer.style.display = open ? "" : "none";
      wrap.appendChild(drawer);
    }

    return wrap;
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
    typeIcon.title = "Appearance";
    typeIcon.setAttribute("aria-label", typeIcon.title);
    typeIcon.style.color = App.resolveFeatureColor(it.type, it.feature);
    typeIcon.addEventListener("click", function (e) {
      e.stopPropagation();
      App.openAppearancePopup(typeIcon, it.type, it.index, {
        onChange: function () { typeIcon.style.color = App.resolveFeatureColor(it.type, it.feature); }
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

    var firstColor = App.resolveFeatureColor(items[0].type, items[0].feature);
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

  // ---- GTFS route browser (under the "GTFS routes" reference row) ----
  // Reads the Phase 1 API in js/projects/gtfs.js (App.gtfsRouteIndex & co).
  // UI state lives here so it survives render() rebuilds; filter typing and
  // expand/collapse only touch the browser's own list, never the whole panel.
  var GTFS_ROW_ID = "gtfs-shapes-layer";
  var GTFS_MAX_ROUTES = 200;
  var _gtfsUI = { open: false, filter: "", expanded: {}, pinned: null, indexRef: null };

  function gtfsIndex() {
    return (typeof App.gtfsRouteIndex === "function") ? App.gtfsRouteIndex() : null;
  }
  function gtfsSyncFeed() {
    var idx = gtfsIndex();
    if (idx !== _gtfsUI.indexRef) {
      _gtfsUI.indexRef = idx;
      _gtfsUI.expanded = {};
      _gtfsUI.pinned = null;
      _gtfsUI.filter = "";
    }
    return idx;
  }
  function gtfsRouteName(r) { return r.short || r.long || r.route_id || ""; }
  function gtfsPinKey(t) { return t ? (t.shapeId != null ? "s:" + t.shapeId : "r:" + t.routeId) : null; }
  function gtfsRestoreHighlight() {
    if (typeof App.gtfsHighlight === "function") App.gtfsHighlight(_gtfsUI.pinned);
  }
  // Public: re-apply the Layers panel's pinned GTFS highlight (or clear it).
  // Used by the map right-click menu to undo its hover preview.
  App.gtfsRestoreHighlight = gtfsRestoreHighlight;
  function gtfsCopyAndSelect(opts) {
    var created = (typeof App.gtfsCopy === "function" && App.gtfsCopy(opts)) || [];
    if (created.length && typeof App.selectFeature === "function") App.selectFeature("line", created[0]);
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    refreshLayersPanel();
  }
  function gtfsRouteMenu(r) {
    return [
      { label: "Copy as line", action: function () { gtfsCopyAndSelect({ routeId: r.routeKey, mode: "representative" }); } },
      { label: "Copy each shape as a line", action: function () { gtfsCopyAndSelect({ routeId: r.routeKey, mode: "each" }); } },
      { label: "Copy all as grouped Service", action: function () { gtfsCopyAndSelect({ routeId: r.routeKey, mode: "service" }); } },
      { label: "Show only this", action: function () { App.gtfsShowOnly([r.routeKey]); } },
      { label: "Zoom to", action: function () { App.gtfsZoomTo({ routeId: r.routeKey }); } }
    ];
  }
  function gtfsShapeMenu(r, s) {
    return [
      { label: "Copy as line", action: function () { gtfsCopyAndSelect({ routeId: r.routeKey, mode: "shape", shapeId: s.shape_id }); } },
      { label: "Show only this route", action: function () { App.gtfsShowOnly([r.routeKey]); } },
      { label: "Zoom to", action: function () { App.gtfsZoomTo({ shapeId: s.shape_id }); } }
    ];
  }

  // Shared row behavior: hover/focus highlight, click pins, double-click zooms,
  // right-click / ContextMenu key / Shift+F10 opens the menu.
  function gtfsWireRow(row, target, menuFn, onEnter) {
    row.tabIndex = 0;
    function hl() { if (typeof App.gtfsHighlight === "function") App.gtfsHighlight(target); }
    row.addEventListener("mouseenter", hl);
    row.addEventListener("focus", hl);
    row.addEventListener("mouseleave", gtfsRestoreHighlight);
    row.addEventListener("blur", gtfsRestoreHighlight);
    row.addEventListener("click", function () {
      _gtfsUI.pinned = (gtfsPinKey(_gtfsUI.pinned) === gtfsPinKey(target)) ? null : target;
      gtfsRestoreHighlight();
      row.classList.toggle("lp-gtfs-pinned", !!_gtfsUI.pinned && gtfsPinKey(_gtfsUI.pinned) === gtfsPinKey(target));
      gtfsMarkPinned();
    });
    row.addEventListener("dblclick", function () {
      _gtfsUI.pinned = target;
      gtfsRestoreHighlight();
      gtfsMarkPinned();
      if (typeof App.gtfsZoomTo === "function") App.gtfsZoomTo(target);
    });
    function openMenuAt(x, y) { if (typeof App.showContextMenu === "function") App.showContextMenu(x, y, menuFn()); }
    row.addEventListener("contextmenu", function (e) {
      e.preventDefault(); e.stopPropagation();
      openMenuAt(e.clientX, e.clientY);
    });
    row.addEventListener("keydown", function (e) {
      if (e.target !== row) return;
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        var b = row.getBoundingClientRect();
        openMenuAt(b.left + 24, b.bottom);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (onEnter) onEnter(); else row.click();
      }
    });
    row.dataset.pin = gtfsPinKey(target);
    if (_gtfsUI.pinned && gtfsPinKey(_gtfsUI.pinned) === row.dataset.pin) row.classList.add("lp-gtfs-pinned");
  }
  function gtfsMarkPinned() {
    var pk = gtfsPinKey(_gtfsUI.pinned);
    document.querySelectorAll("#fp-tab-layers .lp-gtfs-browser [data-pin]").forEach(function (el) {
      el.classList.toggle("lp-gtfs-pinned", !!pk && el.dataset.pin === pk);
    });
  }

  function gtfsChip(cls, svg, title, label, handler) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls + " lp-gtfs-btn";
    b.innerHTML = svg;
    b.title = title;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", function (e) { e.stopPropagation(); handler(e); });
    return b;
  }

  function buildGtfsShapeRow(r, s, hs) {
    var routeHidden = !!hs.routes[r.routeKey];
    var hidden = routeHidden || !!hs.shapes[s.shape_id];
    var row = document.createElement("div");
    row.className = "lp-row lp-gtfs-shape" + (hidden ? " lp-row-hidden" : "");
    var subParts = [s.lengthMi.toFixed(1) + " mi", s.tripCount + (s.tripCount === 1 ? " trip" : " trips")];
    if (s.headsigns && s.headsigns[0]) subParts.push(s.headsigns[0]);
    var text = document.createElement("div");
    text.className = "lp-gtfs-text";
    var title = document.createElement("div");
    title.className = "lp-row-label lp-gtfs-title";
    title.textContent = s.shape_id;
    var sub = document.createElement("div");
    sub.className = "lp-gtfs-sub";
    sub.textContent = subParts.join(" \u00b7 ");
    text.appendChild(title);
    text.appendChild(sub);
    text.title = s.shape_id + " \u00b7 " + subParts.join(" \u00b7 ") +
      (s.headsigns && s.headsigns.length > 1 ? " (+" + (s.headsigns.length - 1) + " more headsigns)" : "");
    row.appendChild(text);
    var eyeTitle = routeHidden ? "Route hidden — show route" : (hidden ? "Show shape" : "Hide shape");
    row.appendChild(gtfsChip("lp-gtfs-eye" + (hidden ? " lp-eye-off" : ""), hidden ? EYE_OFF_SVG : EYE_SVG, eyeTitle,
      (hidden ? "Show shape " : "Hide shape ") + s.shape_id, function () {
        if (routeHidden) App.gtfsSetRouteHidden(r.routeKey, false);
        else App.gtfsSetShapeHidden(s.shape_id, !hs.shapes[s.shape_id]);
      }));
    var menu = gtfsChip("lp-row-menu", MENU_SVG, "More", "More actions for shape " + s.shape_id, function (e) {
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, gtfsShapeMenu(r, s));
    });
    row.appendChild(menu);
    gtfsWireRow(row, { shapeId: s.shape_id }, function () { return gtfsShapeMenu(r, s); });
    return row;
  }

  function buildGtfsRouteBlock(r, hs) {
    var block = document.createElement("div");
    block.className = "lp-gtfs-route-block";
    var hidden = !!hs.routes[r.routeKey];
    var name = gtfsRouteName(r);
    var open = !!_gtfsUI.expanded[r.routeKey];

    var row = document.createElement("div");
    row.className = "lp-row lp-row-sub lp-gtfs-route" + (hidden ? " lp-row-hidden" : "");

    var caret = document.createElement("button");
    caret.type = "button";
    caret.className = "lp-caret" + (open ? " open" : "");
    caret.innerHTML = "&#9662;";
    caret.tabIndex = -1;
    caret.setAttribute("aria-label", "Toggle shapes for " + name);
    caret.setAttribute("aria-expanded", open ? "true" : "false");
    row.appendChild(caret);

    var dot = document.createElement("span");
    dot.className = "lp-gtfs-dot";
    if (r.color) dot.style.background = r.color;
    row.appendChild(dot);

    var n = r.shapes.length;
    var countText = "(" + n + (n === 1 ? " shape)" : " shapes)");
    var text = document.createElement("div");
    text.className = "lp-gtfs-text";
    var title = document.createElement("div");
    title.className = "lp-row-label lp-gtfs-title";
    title.textContent = name;
    var sub = document.createElement("div");
    sub.className = "lp-gtfs-sub";
    var count = document.createElement("span");
    count.className = "lp-gtfs-count";
    count.textContent = countText;
    sub.appendChild(count);
    if (r.short && r.long) sub.appendChild(document.createTextNode(" " + r.long));
    text.appendChild(title);
    text.appendChild(sub);
    text.title = (r.short && r.long ? r.short + " \u2013 " + r.long : name) + " " + countText;
    row.appendChild(text);

    row.appendChild(gtfsChip("lp-gtfs-eye" + (hidden ? " lp-eye-off" : ""), hidden ? EYE_OFF_SVG : EYE_SVG,
      hidden ? "Show route" : "Hide route", (hidden ? "Show route " : "Hide route ") + name, function () {
        App.gtfsSetRouteHidden(r.routeKey, !hs.routes[r.routeKey]);
      }));
    row.appendChild(gtfsChip("lp-row-menu", MENU_SVG, "More", "More actions for route " + name, function (e) {
      if (typeof App.showContextMenu === "function") App.showContextMenu(e.clientX, e.clientY, gtfsRouteMenu(r));
    }));

    var body = null;
    function setOpen(o) {
      if (o) _gtfsUI.expanded[r.routeKey] = true; else delete _gtfsUI.expanded[r.routeKey];
      caret.classList.toggle("open", o);
      caret.setAttribute("aria-expanded", o ? "true" : "false");
      if (o && !body) {          // lazy: shape rows are built on first expand
        body = document.createElement("div");
        body.className = "lp-gtfs-shapes";
        r.shapes.forEach(function (s) { body.appendChild(buildGtfsShapeRow(r, s, hs)); });
        block.appendChild(body);
      }
      if (body) body.style.display = o ? "" : "none";
    }
    function toggle() { setOpen(!_gtfsUI.expanded[r.routeKey]); }
    caret.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    gtfsWireRow(row, { routeId: r.routeKey }, function () { return gtfsRouteMenu(r); }, toggle);

    block.appendChild(row);
    if (open) setOpen(true);
    return block;
  }

  function gtfsFilteredRoutes() {
    var idx = gtfsIndex() || [];
    return (App.gtfsBrowse && App.gtfsBrowse.filterRoutes) ? App.gtfsBrowse.filterRoutes(idx, _gtfsUI.filter) : idx;
  }

  function renderGtfsList(listEl, onchange) {
    listEl.innerHTML = "";
    var hsRaw = (typeof App.gtfsHiddenState === "function") ? App.gtfsHiddenState() : { routes: [], shapes: [] };
    var hs = { routes: {}, shapes: {} };
    hsRaw.routes.forEach(function (k) { hs.routes[k] = true; });
    hsRaw.shapes.forEach(function (k) { hs.shapes[k] = true; });
    var matches = gtfsFilteredRoutes();
    matches.slice(0, GTFS_MAX_ROUTES).forEach(function (r) { listEl.appendChild(buildGtfsRouteBlock(r, hs)); });
    if (!matches.length) {
      var none = document.createElement("div");
      none.className = "lp-empty";
      none.textContent = "No routes match.";
      listEl.appendChild(none);
    } else if (matches.length > GTFS_MAX_ROUTES) {
      var more = document.createElement("div");
      more.className = "lp-empty lp-gtfs-more";
      more.textContent = "Showing " + GTFS_MAX_ROUTES + " of " + matches.length + " — refine the filter";
      listEl.appendChild(more);
    }
    if (onchange) onchange(matches);
  }

  function buildGtfsBrowser() {
    var wrap = document.createElement("div");
    wrap.className = "lp-gtfs-browser";

    var filter = document.createElement("input");
    filter.type = "search";
    filter.className = "fp-attr-input lp-gtfs-filter";
    filter.placeholder = "Filter routes or shapes…";
    filter.setAttribute("aria-label", "Filter GTFS routes and shapes");
    filter.value = _gtfsUI.filter;
    wrap.appendChild(filter);

    var actions = document.createElement("div");
    actions.className = "lp-gtfs-actions";
    function actBtn(text, title, fn) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rf-btn-sm";
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", fn);
      actions.appendChild(b);
      return b;
    }
    actBtn("Show all", "Show every GTFS route", function () { App.gtfsShowAll(); });
    actBtn("Hide all", "Hide every GTFS route", function () { App.gtfsShowOnly([]); });
    var onlyBtn = actBtn("Show only filtered", "Show only the routes matching the filter", function () {
      App.gtfsShowOnly(gtfsFilteredRoutes().map(function (r) { return r.routeKey; }));
    });
    wrap.appendChild(actions);

    var list = document.createElement("div");
    list.className = "lp-gtfs-list";
    wrap.appendChild(list);

    function sync(matches) { onlyBtn.disabled = !_gtfsUI.filter.trim() || !matches.length; }
    renderGtfsList(list, sync);
    filter.addEventListener("input", function () {
      _gtfsUI.filter = filter.value;
      renderGtfsList(list, sync);   // list only — the input keeps focus + caret
    });
    return wrap;
  }

  // Adds the expand caret to the "GTFS routes" layer row and returns the
  // browser element to place beneath it (null when collapsed).
  function decorateGtfsRow(row, entry) {
    var open = _gtfsUI.open;
    // The row may also carry a style-drawer caret (styled reference layers),
    // so the browser toggle is a list icon, not a second caret.
    var caret = document.createElement("button");
    caret.type = "button";
    caret.className = "lp-gtfs-browse-btn" + (open ? " open" : "");
    caret.innerHTML = "&#9776;";
    caret.setAttribute("aria-label", "Toggle route browser");
    caret.setAttribute("aria-expanded", open ? "true" : "false");
    caret.title = "Browse routes";
    caret.addEventListener("click", function (e) {
      e.stopPropagation();
      _gtfsUI.open = !_gtfsUI.open;
      render();
    });
    // buildLayerRow returns a wrapper; the controls live on its inner .lp-row.
    var inner = row.classList.contains("lp-row") ? row : (row.querySelector(".lp-row") || row);
    inner.insertBefore(caret, inner.querySelector(".lp-grip"));
    return open ? buildGtfsBrowser() : null;
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
        App.setTypeColor(t.type, null);
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
            App.setTypeColor(t.type, nc);
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
            App.setTypeColor(t.type, null);
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

  // ---- Global palette row (top of Analysis band — docs/layer-color-
  // customization-plan.md Phase 6 §6.3). One shared palette choice that
  // reaches every layer whose styleKey accepts that palette's family; a
  // layer with its own per-layer override (buildLayerStyleDrawer above)
  // keeps that override regardless of this selection. ----
  function buildGlobalPaletteRow() {
    var row = document.createElement("div");
    row.className = "lp-style-row";
    row.title = "Applies to layers that accept this palette type";

    var lab = document.createElement("span");
    lab.className = "lp-style-label";
    lab.textContent = "Palette";
    row.appendChild(lab);

    var wrap = document.createElement("div");
    wrap.className = "lp-style-control";
    row.appendChild(wrap);

    var sel = document.createElement("select");
    sel.className = "lp-basemap-select";
    var defOpt = document.createElement("option");
    defOpt.value = "";
    defOpt.textContent = "Default";
    sel.appendChild(defOpt);
    window.LayerPalette.list(null).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    });
    sel.value = App.mapPalette || "";
    sel.addEventListener("click", function (e) { e.stopPropagation(); });
    sel.addEventListener("change", function () {
      App.mapPalette = sel.value || null;
      if (App.cache && typeof App.cache.save === "function") App.cache.save();
      if (typeof App.repaintStyledLayers === "function") App.repaintStyledLayers();
      render();
    });
    wrap.appendChild(sel);

    return row;
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
    // Keep scroll position and an in-progress filter edit across the rebuild.
    var scroller = host.closest ? host.closest(".fp-content") : null;
    var scrollTop = scroller ? scroller.scrollTop : 0;
    var ae = document.activeElement;
    var refocus = ae && ae.classList && ae.classList.contains("lp-gtfs-filter")
      ? { s: ae.selectionStart, e: ae.selectionEnd } : null;
    var gtfsFeed = gtfsSyncFeed();
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
      if (typeof window.LayerPalette !== "undefined" && typeof App.resolveLayerColors === "function") {
        aBand.appendChild(buildGlobalPaletteRow());
      }
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
        var lrow = buildLayerRow(e, "reference", _refOrder, getRef);
        rBand.appendChild(lrow);
        if (e.id === GTFS_ROW_ID && gtfsFeed && gtfsFeed.length) {
          var browser = decorateGtfsRow(lrow, e);
          if (browser) rBand.appendChild(browser);
        }
      });
      host.appendChild(rBand);
    }

    // Basemap
    host.appendChild(buildBasemapBand());

    if (scroller) scroller.scrollTop = scrollTop;
    if (refocus) {
      var f = host.querySelector(".lp-gtfs-filter");
      if (f) { f.focus(); try { f.setSelectionRange(refocus.s, refocus.e); } catch (err) {} }
    }
    if (gtfsFeed) gtfsRestoreHighlight();
  }

  function refreshLayersPanel() {
    var host = document.getElementById("fp-tab-layers");
    // Only rebuild when the Layers tab is actually visible (cheap no-op otherwise).
    if (!host || host.style.display === "none") return;
    render();
  }

  App.refreshLayersPanel = refreshLayersPanel;
})();
