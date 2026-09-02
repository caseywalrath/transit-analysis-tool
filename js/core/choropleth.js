// js/core/choropleth.js
// Shared choropleth rendering engine. First consumer is Feature Area Analysis
// (js/projects/buffer-summary.js); TPI, Ridership Forecasting, and Corridor
// Scoring migrate onto it in Phase 3 (see docs/feature-area-choropleth-plan.md).
// Depends on: App.map (map.js), maplibregl (CDN) — only inside the map-facing
// functions. The classification math (computeClassBreaks, buildStepColorExpr,
// formatBreakLabels) is pure — no DOM, no map — so it loads and runs fine in
// the golden test sandbox.
// Exports: App.choropleth.{RAMPS, computeClassBreaks, buildStepColorExpr,
//   buildInterpolateColorExpr, formatBreakLabels, render, remove, setVisible,
//   fillLegend}

(function () {
  var App = window.App = window.App || {};

  // Keyed by choropleth id, so multiple modules can each own one live
  // instance (source + layers + hover popup) without colliding.
  var _instances = {};

  var DEFAULT_NO_DATA_COLOR = "rgba(200,200,200,0.35)";

  var RAMPS = {
    blues:  { label: "Blues",             colors5: ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"] },
    heat:   { label: "Heat (Yl-Or-Rd)",   colors5: ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"] },
    greens: { label: "Greens",            colors5: ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"] },
    rdbu:   { label: "Diverging (Rd-Bu)", colors5: ["#ca0020", "#f4a582", "#f7f7f7", "#92c5de", "#0571b0"] }
  };

  // ---- Pure classification math (golden-testable) ----------------------

  // Returns `nClasses - 1` inner break values for `values` (an array of
  // finite numbers; caller pre-filters null/NaN). Class i covers
  // breaks[i-1] < v <= breaks[i] (first class is v <= breaks[0], last class
  // is v > breaks[nEffective-2]).
  //
  // Degenerate handling is part of the contract: duplicate quantile breaks
  // are deduplicated (heavily tied data yields nEffective < nClasses);
  // all-equal values yield { breaks: [], nEffective: 1 }; empty input
  // yields { breaks: [], nEffective: 0 }.
  function computeClassBreaks(values, method, nClasses) {
    nClasses = nClasses || 5;
    if (!values || !values.length) return { breaks: [], nEffective: 0 };

    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var min = sorted[0];
    var max = sorted[sorted.length - 1];
    if (min === max) return { breaks: [], nEffective: 1 };

    var raw = [];
    var i;
    if (method === "equal") {
      var step = (max - min) / nClasses;
      for (i = 1; i < nClasses; i++) raw.push(min + step * i);
    } else {
      // quantile (default): linear-interpolated rank position, same
      // convention as the common "R-7" quantile method.
      for (i = 1; i < nClasses; i++) {
        var pos = (sorted.length - 1) * (i / nClasses);
        var lo = Math.floor(pos);
        var hi = Math.ceil(pos);
        var v = (lo === hi) ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
        raw.push(v);
      }
    }

    var breaks = [];
    for (i = 0; i < raw.length; i++) {
      if (breaks.length === 0 || raw[i] > breaks[breaks.length - 1]) breaks.push(raw[i]);
    }

    return { breaks: breaks, nEffective: breaks.length + 1 };
  }

  // Builds a MapLibre paint-property expression: a step expression over
  // `breaks`/`colors` (colors.length must equal breaks.length + 1), wrapped
  // so a null/missing property value renders `noDataColor` instead of
  // silently taking the first class.
  function buildStepColorExpr(prop, breaks, colors, noDataColor) {
    noDataColor = noDataColor || DEFAULT_NO_DATA_COLOR;
    var stepExpr = ["step", ["get", prop], colors[0]];
    for (var i = 0; i < breaks.length; i++) {
      stepExpr.push(breaks[i], colors[i + 1]);
    }
    return ["case", ["==", ["typeof", ["get", prop]], "number"], stepExpr, noDataColor];
  }

  // Builds a MapLibre "interpolate" (linear gradient) expression across
  // `colors` evenly spaced from `min` to `max` — the ramp's endpoints plus
  // its 3 interior stops — wrapped with the same no-data guard as
  // buildStepColorExpr. MapLibre requires strictly ascending interpolate
  // stops, so a degenerate range (no data, or every value identical) falls
  // back to a single solid color instead of a 2-point gradient.
  function buildInterpolateColorExpr(prop, min, max, colors, noDataColor) {
    noDataColor = noDataColor || DEFAULT_NO_DATA_COLOR;
    var typeofGuard = ["==", ["typeof", ["get", prop]], "number"];
    if (min == null || max == null || !(max > min) || !colors || !colors.length) {
      var solid = colors && colors.length ? colors[Math.floor((colors.length - 1) / 2)] : noDataColor;
      return ["case", typeofGuard, solid, noDataColor];
    }
    var n = colors.length;
    var interpExpr = ["interpolate", ["linear"], ["get", prop]];
    for (var i = 0; i < n; i++) {
      interpExpr.push(min + (max - min) * (i / (n - 1)), colors[i]);
    }
    return ["case", typeofGuard, interpExpr, noDataColor];
  }

  // Human-readable range labels, one per class, lowest class first, e.g.
  // "1,204 – 2,410". `fmt` is a (number) => string callback.
  function formatBreakLabels(breaks, min, max, fmt) {
    fmt = fmt || function (n) { return String(n); };
    var edges = [min].concat(breaks, [max]);
    var labels = [];
    for (var i = 0; i < edges.length - 1; i++) {
      var lo = edges[i];
      var hi = edges[i + 1];
      labels.push(lo === hi ? fmt(lo) : (fmt(lo) + " – " + fmt(hi)));
    }
    return labels;
  }

  // Picks `n` colors out of a 5-color ramp, evenly spaced, for when a run
  // classifies into fewer than 5 effective classes (heavily tied data).
  function pickRampColors(colors5, n) {
    if (n <= 0) return [];
    if (n >= colors5.length) return colors5.slice(0, n);
    if (n === 1) return [colors5[Math.floor((colors5.length - 1) / 2)]];
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(colors5[Math.round(i * (colors5.length - 1) / (n - 1))]);
    }
    return out;
  }

  // ---- Map-facing instance API ------------------------------------------

  // opts = { id, features, valueProp, method, classes, ramp, breaks
  //   (optional manual override), beforeLayer, fillOpacity, lineColor,
  //   lineWidth, lineOpacity, hoverHTML (fn(props) => html string | falsy,
  //   or null for no hover), noDataColor }
  // Creates or updates source "<id>-choropleth" and layers
  // "<id>-choropleth-fill" / "<id>-choropleth-line". Returns
  // { breaks, colors, nEffective, min, max } for the caller's legend.
  function render(opts) {
    var map = App.map;
    if (!map || !opts || !opts.id) return null;

    var id = opts.id;
    var valueProp = opts.valueProp || "value";
    var features = opts.features || [];

    var values = [];
    for (var vi = 0; vi < features.length; vi++) {
      var v = features[vi] && features[vi].properties ? features[vi].properties[valueProp] : null;
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
    var min = values.length ? Math.min.apply(null, values) : null;
    var max = values.length ? Math.max.apply(null, values) : null;

    var rampDef = RAMPS[opts.ramp] || RAMPS.blues;
    var noDataColor = opts.noDataColor || DEFAULT_NO_DATA_COLOR;

    var breaksResult, colors, colorExpr;
    if (opts.method === "continuous") {
      // No discrete classes — a linear gradient across colors5, so there are
      // no break values to report (the legend instead shows the min/max —
      // and, for buffer-summary's row-based legend, the evenly-spaced stop
      // values matching the gradient below). `colors` mirrors whatever
      // buildInterpolateColorExpr actually painted: the full ramp for a real
      // range, or just its one solid fallback color when the range is
      // degenerate — a caller's legend must match the map, not always show
      // 5 swatches when only one color was ever drawn.
      var validRange = (min != null && max != null && max > min);
      colors = !validRange
        ? (min == null ? [] : [rampDef.colors5[Math.floor((rampDef.colors5.length - 1) / 2)]])
        : rampDef.colors5;
      colorExpr = buildInterpolateColorExpr(valueProp, min, max, rampDef.colors5, noDataColor);
      breaksResult = { breaks: [], nEffective: colors.length };
    } else {
      if (opts.breaks) {
        breaksResult = { breaks: opts.breaks.slice(), nEffective: opts.breaks.length + 1 };
      } else {
        breaksResult = computeClassBreaks(values, opts.method || "quantile", opts.classes || 5);
      }
      colors = pickRampColors(rampDef.colors5, Math.max(breaksResult.nEffective, 1));
      colorExpr = buildStepColorExpr(valueProp, breaksResult.breaks, colors, noDataColor);
    }

    var fc = { type: "FeatureCollection", features: features };

    var sourceId    = id + "-choropleth";
    var fillLayerId = id + "-choropleth-fill";
    var lineLayerId = id + "-choropleth-line";

    var fillOpacity = (opts.fillOpacity != null) ? opts.fillOpacity : 0.55;
    var lineColor   = opts.lineColor   || "#333";
    var lineWidth   = (opts.lineWidth   != null) ? opts.lineWidth   : 0.5;
    var lineOpacity = (opts.lineOpacity != null) ? opts.lineOpacity : 0.4;

    var inst = _instances[id];

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: "geojson", data: fc });

      var beforeLayer = opts.beforeLayer;
      if (beforeLayer === undefined) beforeLayer = map.getLayer("buffers-fill") ? "buffers-fill" : undefined;
      else if (beforeLayer && !map.getLayer(beforeLayer)) beforeLayer = undefined;

      map.addLayer({
        id: fillLayerId,
        type: "fill",
        source: sourceId,
        paint: { "fill-color": colorExpr, "fill-opacity": fillOpacity }
      }, beforeLayer);

      map.addLayer({
        id: lineLayerId,
        type: "line",
        source: sourceId,
        paint: { "line-color": lineColor, "line-width": lineWidth, "line-opacity": lineOpacity }
      }, beforeLayer);

      var hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      inst = {
        sourceId: sourceId, fillLayerId: fillLayerId, lineLayerId: lineLayerId,
        hoverHTML: opts.hoverHTML || null, popup: hoverPopup, onMove: null, onLeave: null
      };
      _instances[id] = inst;

      var onMove = function (e) {
        map.getCanvas().style.cursor = "pointer";
        if (!inst.hoverHTML || !e.features || !e.features.length) { hoverPopup.remove(); return; }
        var html = inst.hoverHTML(e.features[0].properties);
        if (html) hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        else hoverPopup.remove();
      };
      var onLeave = function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
        hoverPopup.remove();
      };
      map.on("mousemove", fillLayerId, onMove);
      map.on("mouseleave", fillLayerId, onLeave);
      inst.onMove = onMove;
      inst.onLeave = onLeave;
    } else {
      map.getSource(sourceId).setData(fc);
      map.setPaintProperty(fillLayerId, "fill-color", colorExpr);
      map.setPaintProperty(fillLayerId, "fill-opacity", fillOpacity);
      map.setPaintProperty(lineLayerId, "line-color", lineColor);
      map.setPaintProperty(lineLayerId, "line-width", lineWidth);
      map.setPaintProperty(lineLayerId, "line-opacity", lineOpacity);
      if (inst) inst.hoverHTML = opts.hoverHTML || null;
    }

    return { breaks: breaksResult.breaks, colors: colors, nEffective: breaksResult.nEffective, min: min, max: max };
  }

  // Removes both layers + source for `id`, and detaches its hover
  // listeners. Idempotent.
  function remove(id) {
    var map = App.map;
    var fillLayerId = id + "-choropleth-fill";
    var lineLayerId = id + "-choropleth-line";
    var sourceId    = id + "-choropleth";
    var inst = _instances[id];

    if (map) {
      if (inst) {
        if (inst.onMove)  map.off("mousemove", fillLayerId, inst.onMove);
        if (inst.onLeave) map.off("mouseleave", fillLayerId, inst.onLeave);
        if (inst.popup)   inst.popup.remove();
      }
      if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
      if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
      if (map.getSource(sourceId))   map.removeSource(sourceId);
    }
    delete _instances[id];
  }

  // Layout-visibility toggle (e.g. a "hide choropleth" checkbox). No-op if
  // the layers don't exist.
  function setVisible(id, visible) {
    var map = App.map;
    if (!map) return;
    var fillLayerId = id + "-choropleth-fill";
    var lineLayerId = id + "-choropleth-line";
    var vis = visible ? "visible" : "none";
    if (map.getLayer(fillLayerId)) map.setLayoutProperty(fillLayerId, "visibility", vis);
    if (map.getLayer(lineLayerId)) map.setLayoutProperty(lineLayerId, "visibility", vis);
  }

  // Fills the generic legend fragment (projects/choropleth-legend.html) once
  // its floating-widget body has mounted. `containerEl` is any ancestor of
  // the fragment's classed placeholders (the widget body element works).
  // opts = { title, labels, colors, note }. Rows fill top-to-bottom in the
  // same order as `labels`/`colors` (lowest class first, matching
  // formatBreakLabels); unused rows are hidden.
  function fillLegend(containerEl, opts) {
    if (!containerEl) return;
    opts = opts || {};

    var titleEl = containerEl.querySelector(".cl-legend-title");
    if (titleEl) titleEl.textContent = opts.title || "";

    var rows   = containerEl.querySelectorAll(".cl-legend-row");
    var labels = opts.labels || [];
    var colors = opts.colors || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (i < labels.length) {
        row.style.display = "";
        var swatch = row.querySelector(".cl-legend-swatch");
        var label  = row.querySelector(".cl-legend-label");
        if (swatch) swatch.style.background = colors[i] || "#ccc";
        if (label)  label.textContent = labels[i];
      } else {
        row.style.display = "none";
      }
    }

    var noteEl = containerEl.querySelector(".cl-legend-note");
    if (noteEl) noteEl.textContent = opts.note || "";
  }

  App.choropleth = {
    RAMPS: RAMPS,
    computeClassBreaks: computeClassBreaks,
    buildStepColorExpr: buildStepColorExpr,
    buildInterpolateColorExpr: buildInterpolateColorExpr,
    formatBreakLabels: formatBreakLabels,
    render: render,
    remove: remove,
    setVisible: setVisible,
    fillLegend: fillLegend
  };
})();
