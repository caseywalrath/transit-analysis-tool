// js/projects/walkshed.js
// Walkshed: registers as an analysis module, opens in a 2-column popup, and
// computes true network walking isochrones from placed Points using the offline
// road-network engine (App.computeWalkshed in road-network.js). No live external
// service — the road network must be loaded/imported first (Add Data → Area Roads).
//
// v1: compute + render (walkshed fill/line + green reachable-segments proof) + area
//     readout + GeoJSON export.
// v2: a Point flagged with attributes.serviceAreaType === "walkshed" has its cached
//     walkshed polygon substituted for the circular buffer inside points.js
//     rebuildBuffers(), so every downstream demographic consumer (Buffer-Area
//     Summary, Census, LODES, TPI, Title VI, FTA, corridor pickers) uses the
//     walkshed as the study area with no changes to those modules.
//
// Public API (on App): getPointWalkshed(pointIdx), ensurePointWalksheds().

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Defaults + module-local state (persists across popup open/close) ----

  var DEFAULT_SETTINGS = { budgets: [15, 30, null], walkSpeedMph: 3.1, maxEdge: 0.3 };
  var MAX_MINUTES = 60;
  var KM_PER_MILE = 1.609344; // engine graph weights are in km; UI/attributes are in mph
  var FT_PER_KM = 3280.84; // Phase 7 (docs/network-connectors-plan.md): hull-detail maxEdge is
                            // displayed in feet but stored/persisted in km, same UI-boundary pattern
                            // as walkSpeedMph above and the connector snap-tolerance input.

  var _settings      = Object.assign({}, DEFAULT_SETTINGS);
  var _walkshedCache = new Map();  // pointIdx -> entry (see computeForPoint)
  var _lastEntries   = [];         // entries (+failures) from the last Compute run, for display
  var _stale         = false;
  var _running       = false;
  var _initialized   = false;

  // ---- Map layer ids ----

  var WS_FILL_SRC  = "walkshed-src";
  var WS_FILL_LAYER = "walkshed-fill";
  // The line layer gets its OWN source (WS_LINE_SRC) rather than sharing
  // WS_FILL_SRC, because "flatten overlaps" (see buildFlattenedFillFeatures
  // below) only reshapes what the FILL paints — the outline always draws
  // every point's own band boundaries in full, flattened or not, so an
  // overlap stays visible even when the fill hides it. When flattening is
  // off the two sources hold identical features; the duplication is the
  // price of not special-casing layer creation on the toggle.
  var WS_LINE_SRC  = "walkshed-line-src";
  var WS_LINE_LAYER = "walkshed-line";
  var WS_SEG_SRC   = "walkshed-seg-src";
  var WS_SEG_LAYER = "walkshed-seg";

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "walkshed";
  }

  // ---- Small helpers ----

  function _dateStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function _triggerDownload(content, mimeType, filename) {
    var blob = new Blob([content], { type: mimeType });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function findPointByIdx(pointIdx) {
    var pts = App.points || [];
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].properties && pts[i].properties.pointIdx === pointIdx) return pts[i];
    }
    return null;
  }

  // Valid budgets only, ascending, deduped, each capped at MAX_MINUTES. Never
  // returns an empty array — falls back to the smallest default budget when
  // every input is blank/invalid.
  function activeBudgets() {
    var out = [];
    (_settings.budgets || []).forEach(function (m) {
      var v = +m;
      if (v > 0) out.push(Math.min(v, MAX_MINUTES));
    });
    out = out.filter(function (v, i) { return out.indexOf(v) === i; });
    out.sort(function (a, b) { return a - b; });
    if (!out.length) out = [DEFAULT_SETTINGS.budgets[0]];
    return out;
  }

  // Per-point walk parameters. Global module settings apply to every point; a
  // point may optionally carry attributes.walkMinutes / walkSpeedMph overrides
  // (data model supports it; the current UI only sets the type, not overrides).
  // A point with a walkMinutes override uses that single value as its only
  // budget — otherwise it uses the module's full activeBudgets() list.
  // `speed` is in mph — converted to km/h at the point of use (computeForPoint).
  function pointSettingsFor(pf) {
    var attrs = (pf.properties && pf.properties.attributes) || {};
    var budgets = (attrs.walkMinutes != null && +attrs.walkMinutes > 0)
      ? [Math.min(+attrs.walkMinutes, MAX_MINUTES)]
      : activeBudgets();
    var speed = (attrs.walkSpeedMph != null && +attrs.walkSpeedMph > 0) ? +attrs.walkSpeedMph : _settings.walkSpeedMph;
    return { budgets: budgets, speed: speed, maxEdge: _settings.maxEdge };
  }

  // Cache key — a walkshed is a pure function of the origin coords, the walk
  // parameters, and the loaded network (roadNetworkEpoch bumps on (re)load/clear).
  // Every budget must be included, not just one, or changing budget 2/3 won't
  // invalidate the cache. The two crossing-penalty seconds must be included too
  // (docs/walkshed-bands-and-crossing-penalties-plan.md Phase 5) — they change
  // the result but don't bump the network epoch, so without this the cache
  // would serve stale polygons after a penalty change.
  function settingsKeyFor(pf) {
    var c = pf.geometry.coordinates;
    var s = pointSettingsFor(pf);
    var epoch = (typeof App.roadNetworkEpoch === "function") ? App.roadNetworkEpoch() : 0;
    var crossMajor = (App.networkSettings && App.networkSettings.crossingMajorSec) || 0;
    var crossMinor = (App.networkSettings && App.networkSettings.crossingMinorSec) || 0;
    return [c[0].toFixed(6), c[1].toFixed(6), s.budgets.join(","), s.speed, s.maxEdge, epoch, crossMajor, crossMinor].join("|");
  }

  // Builds { major, minor } crossing-penalty km values from the global
  // App.networkSettings seconds plus this point's own walk speed (km/h) — see
  // js/core/walk-cost.js. Guarded so a missing walk-cost.js script tag
  // degrades to no penalty rather than throwing.
  function crossingPenaltyKmFor(speedKmh) {
    if (typeof window.WalkCost === "undefined") return null;
    var opts = {
      majorSec: (App.networkSettings && App.networkSettings.crossingMajorSec) || 0,
      minorSec: (App.networkSettings && App.networkSettings.crossingMinorSec) || 0,
      speedKmh: speedKmh
    };
    return { major: window.WalkCost.penaltyKm("major", opts), minor: window.WalkCost.penaltyKm("minor", opts) };
  }

  // ---- Core compute (shared by the Compute button and ensurePointWalksheds) ----

  // Compute + cache a walkshed for one point. Returns the cache entry, or a
  // { failed:true, reason } sentinel. Reuses a valid cached entry when present.
  // Floods once at the largest budget and thresholds it into one polygon per
  // budget (App.computeWalkshed's options.budgetsKm). entry.polygon/area/
  // reachableCount alias the SMALLEST band, since that is the study area
  // getPointWalkshed() returns — the other bands are display-only.
  function computeForPoint(pf) {
    var pIdx = pf.properties.pointIdx;
    var key = settingsKeyFor(pf);
    var existing = _walkshedCache.get(pIdx);
    if (existing && existing.settingsKey === key && existing.polygon) return existing;

    var s = pointSettingsFor(pf); // s.budgets is ascending (activeBudgets() / single override)
    var speedKmh = s.speed * KM_PER_MILE; // s.speed is mph; engine works in km
    var budgetsKm = s.budgets.map(function (m) { return speedKmh * (m / 60); });
    var maxBudgetKm = budgetsKm[budgetsKm.length - 1];
    var res = App.computeWalkshed
      ? App.computeWalkshed(pf.geometry.coordinates, maxBudgetKm,
          { maxEdge: s.maxEdge, budgetsKm: budgetsKm, crossingPenaltyKm: crossingPenaltyKmFor(speedKmh) })
      : null;

    if (!res) {
      _walkshedCache.delete(pIdx);
      return {
        failed: true,
        pointIdx: pIdx,
        name: pf.properties.name,
        reason: "origin off-network (> 500 m from a road)"
      };
    }

    // options.budgetsKm always has >=1 entries (activeBudgets() never returns
    // empty), so App.computeWalkshed always returns `polygons` — the fallback
    // here only guards a caller running against a pre-Phase-2 engine.
    var bandPolys = res.polygons || [{ budgetKm: maxBudgetKm, polygon: res.polygon, nodeCount: res.reachableCount }];
    var bands = [];
    for (var i = 0; i < s.budgets.length; i++) {
      var bp = bandPolys[i];
      bands.push({
        minutes:   s.budgets[i],
        polygon:   bp ? bp.polygon : null,
        area:      (bp && bp.polygon) ? turf.area(bp.polygon) : 0, // m²
        nodeCount: bp ? bp.nodeCount : 0
      });
    }

    if (!bands[0].polygon) {
      _walkshedCache.delete(pIdx);
      return {
        failed: true,
        pointIdx: pIdx,
        name: pf.properties.name,
        reason: "no reachable area (sparse/disconnected network)"
      };
    }

    bands[0].polygon.properties = bands[0].polygon.properties || {};
    bands[0].polygon.properties.pointIdx = pIdx;

    var entry = {
      polygon:           bands[0].polygon,
      reachableSegments: res.reachableSegments,
      reachableCount:    bands[0].nodeCount,
      area:              bands[0].area,   // m²
      bands:             bands,           // ascending, one entry per active budget
      computeMs:         res.computeMs,
      minutes:           bands[0].minutes,
      name:              pf.properties.name,
      pointIdx:          pIdx,
      coord:             pf.geometry.coordinates.slice(),
      settingsKey:       key
    };
    _walkshedCache.set(pIdx, entry);
    return entry;
  }

  // ---- Public API for the v2 study-area integration (points.js) ----

  // Returns a validated cached walkshed polygon Feature for a point, or null when
  // absent/stale (caller — rebuildBuffers — then falls back to the circular buffer).
  function getPointWalkshed(pointIdx) {
    var entry = _walkshedCache.get(pointIdx);
    if (!entry || !entry.polygon) return null;
    var pf = findPointByIdx(pointIdx);
    if (!pf) return null;
    if (entry.settingsKey !== settingsKeyFor(pf)) return null; // moved / settings / network changed
    return entry.polygon;
  }

  // Compute any walkshed-flagged points that are missing or stale in the cache.
  // Synchronous (used by rebuildBuffers-triggered flows). Returns a summary.
  function ensurePointWalksheds() {
    var out = { computed: 0, cached: 0, failed: 0, warnings: [] };
    if (!App.roadNetworkLoaded || !App.roadNetworkLoaded()) return out;
    var pts = App.points || [];
    for (var i = 0; i < pts.length; i++) {
      var pf = pts[i];
      if (!pf.properties || pf.properties.hidden) continue;
      var attrs = pf.properties.attributes || {};
      if (attrs.serviceAreaType !== "walkshed") continue;
      var key = settingsKeyFor(pf);
      var existing = _walkshedCache.get(pf.properties.pointIdx);
      if (existing && existing.settingsKey === key && existing.polygon) { out.cached++; continue; }
      var r = computeForPoint(pf);
      if (r.failed) { out.failed++; out.warnings.push(r); } else { out.computed++; }
    }
    return out;
  }

  // ---- Target set (which points to compute) ----

  function getTargetPoints() {
    var el = document.getElementById("wsPointList");
    var pts = App.points || [];
    if (!el) return pts.filter(function (p) { return !p.properties.hidden; });
    var boxes = el.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return pts.filter(function (p) { return !p.properties.hidden; });
    var wanted = {};
    var any = false;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) { wanted[parseInt(boxes[i].getAttribute("data-idx"), 10)] = true; any = true; }
    }
    if (!any) return [];
    return pts.filter(function (p) { return !p.properties.hidden && wanted[p.properties.pointIdx]; });
  }

  function buildPointChecklist() {
    var el = document.getElementById("wsPointList");
    if (!el) return;
    var prevState = {};
    var prev = el.querySelectorAll("input[type=checkbox]");
    for (var pi = 0; pi < prev.length; pi++) {
      prevState[prev[pi].getAttribute("data-idx")] = prev[pi].checked;
    }
    el.innerHTML = "";
    var pts = (App.points || []).filter(function (p) { return !p.properties.hidden; });
    if (!pts.length) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No points placed.</div>';
      return;
    }
    pts.forEach(function (p) {
      var idx = p.properties.pointIdx;
      var checked = (idx in prevState) ? prevState[idx] : true;
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-idx", idx);
      cb.checked = checked;
      var lbl = document.createElement("label");
      lbl.className = "tiny";
      lbl.style.cursor = "pointer";
      lbl.textContent = p.properties.name || ("Point " + idx);
      lbl.addEventListener("click", function () { cb.checked = !cb.checked; });
      row.appendChild(cb);
      row.appendChild(lbl);
      el.appendChild(row);
    });
  }

  // ---- Map rendering ----

  // Band fill/line color, smallest band (index 0) darkest so it reads as "most
  // walkable" — same ["match", ["get", "bandIdx"], ...] pattern network-joins-point
  // uses in js/core/network-connectors.js. Resolved through the layer color
  // cascade (docs/layer-color-customization-plan.md); guarded so a missing
  // layer-palettes.js script tag degrades to the original hardcoded colors
  // rather than throwing, same defensive pattern used elsewhere in this file
  // for window.WalkCost.
  var WS_SEG_DEFAULT_COLOR = "#16a34a";
  function bandColorExpr() {
    if (typeof window.LayerPalette === "undefined") {
      return ["match", ["get", "bandIdx"], 0, "#1e40af", 1, "#3b82f6", "#93c5fd"];
    }
    var colors = App.resolveLayerColors("walkshed") || ["#1e40af", "#3b82f6", "#93c5fd"];
    return window.LayerPalette.matchExpr("bandIdx", colors);
  }
  function segColor() {
    if (typeof App.resolveLayerColors !== "function") return WS_SEG_DEFAULT_COLOR;
    var colors = App.resolveLayerColors("walkshed-seg");
    return (colors && colors[0]) || WS_SEG_DEFAULT_COLOR;
  }

  // Re-applies paint properties from the current cascade without re-running
  // the analysis, so a palette change is instant. No-op when the layers
  // aren't currently on the map.
  function repaintWalkshedLayers() {
    var map = App.map;
    if (!map || !map.getLayer(WS_FILL_LAYER)) return;
    var expr = bandColorExpr();
    map.setPaintProperty(WS_FILL_LAYER, "fill-color", expr);
    map.setPaintProperty(WS_LINE_LAYER, "line-color", expr);
    if (map.getLayer(WS_SEG_LAYER)) {
      map.setPaintProperty(WS_SEG_LAYER, "line-color", segColor());
    }
  }
  if (typeof App.registerLayerRepainter === "function") {
    var refreshWalkshedPaintAndLegend = function () {
      // A palette/reverse toggle only needs paint; "Flatten overlaps"
      // changes which polygons are painted (see buildFlattenedFillFeatures),
      // so re-render from the last computed entries when there are any —
      // still no flood recompute, just re-unioning already-computed band
      // polygons, so this stays cheap despite not being paint-only anymore.
      if (_lastEntries.length) renderWalkshedLayers(_lastEntries);
      else repaintWalkshedLayers();
      fillWalkshedLegend(activeBudgets());
    };
    // Registered under both styleKeys — walkshed-fill and walkshed-seg are
    // separate Layers-panel rows (docs/walkshed-bands-and-crossing-penalties-plan.md
    // Phase 1) so either one's visibility toggle can refresh the legend's
    // "Reachable streets" row (see fillWalkshedLegend below).
    App.registerLayerRepainter("walkshed", refreshWalkshedPaintAndLegend);
    App.registerLayerRepainter("walkshed-seg", refreshWalkshedPaintAndLegend);
  }

  // Smallest band (bandIdx 0) first, matching
  // App.resolveLayerColors("walkshed")'s array order — no reversal needed,
  // unlike TPI/Corridor Scoring's high-first legends. Hides rows beyond the
  // active budget count (a point may use 1-3 budgets).
  function fillWalkshedLegend(budgets) {
    var colors = (App.resolveLayerColors && App.resolveLayerColors("walkshed")) ||
      ["#1e40af", "#3b82f6", "#93c5fd"];
    for (var i = 0; i < 3; i++) {
      var row = document.getElementById("wsLegendRow" + i);
      var label = document.getElementById("wsLegendLabel" + i);
      var sw = document.getElementById("wsLegendSw" + i);
      if (sw) sw.style.background = colors[i] || colors[colors.length - 1];
      if (!row) continue;
      if (i < budgets.length) {
        row.style.display = "";
        if (label) label.textContent = "≤ " + budgets[i] + " min";
      } else {
        row.style.display = "none";
      }
    }
    var segSw = document.getElementById("wsLegendSwSeg");
    if (segSw) segSw.style.background = segColor();
    var segRow = document.getElementById("wsLegendRowSeg");
    if (segRow) {
      var map = App.map;
      var segLayerVisible = !map || !map.getLayer(WS_SEG_LAYER) ||
        map.getLayoutProperty(WS_SEG_LAYER, "visibility") !== "none";
      segRow.style.display = segLayerVisible ? "" : "none";
    }
  }

  // Shows (or re-shows) the ws-legend widget and fills its band rows once
  // the widget's DOM has actually mounted — showFloatingWidget is async on
  // first creation but synchronous when the widget already exists, so this
  // handles both without forcing every caller to await.
  function showWalkshedLegend() {
    if (!App.popup || !App.popup.showFloatingWidget) return;
    var budgets = activeBudgets();
    var p = App.popup.showFloatingWidget("ws-legend", "projects/walkshed-legend.html",
      { position: "bottom-left", width: 190, title: "Walkshed" });
    if (p && typeof p.then === "function") p.then(function () { fillWalkshedLegend(budgets); });
    else fillWalkshedLegend(budgets);
  }

  // Reads the display-only "Flatten overlaps" toggle from the Layers panel's
  // walkshed-fill style drawer (docs/layer-color-customization-plan.md's
  // App.layerStyles cascade — this rides the same persisted override object
  // as palette/reverse, no new persistence needed). Purely a rendering
  // choice: bands[] itself, and every study-area/export consumer that reads
  // it, is never touched by this flag.
  function flattenEnabled() {
    var ov = (App.layerStyles && App.layerStyles["walkshed"]) || {};
    return !!ov.flatten;
  }

  // "Flatten overlaps" fill geometry: system-wide "shortest walkshed wins",
  // not just within one point's own bands. Groups every successfully-computed
  // point's band polygons by MINUTES value (not per-point bandIdx — two points
  // can use different budgets via attributes.walkMinutes overrides), unions
  // each tier across every point that has one, then subtracts the running
  // union of every smaller tier so a 15-min area from Point A masks any
  // 30/45-min area from Point B wherever they overlap. bandIdx on the
  // returned features is the tier's rank (0 = smallest minutes value, same
  // meaning bandColorExpr() already gives bandIdx), not any one point's own
  // band index. Only reshapes the FILL — renderWalkshedLayers always draws
  // the un-flattened per-point outlines separately, so an overlap an area
  // hides is still visible as a preserved band boundary.
  function buildFlattenedFillFeatures(entries) {
    var byMinutes = {}; // minutes -> polygon[]
    entries.forEach(function (e) {
      if (!e || e.failed) return;
      var bands = e.bands || [{ minutes: e.minutes, polygon: e.polygon }];
      bands.forEach(function (band) {
        if (!band.polygon) return;
        (byMinutes[band.minutes] = byMinutes[band.minutes] || []).push(band.polygon);
      });
    });
    var tiers = Object.keys(byMinutes).map(Number).sort(function (a, b) { return a - b; });
    var features = [];
    var smallerUnion = null; // union of every tier already processed (<= current)
    tiers.forEach(function (minutes, tierIdx) {
      var tierUnion = App.foldAnalysisUnion(byMinutes[minutes]);
      if (!tierUnion) return;
      var ringPoly = tierUnion;
      if (smallerUnion) {
        try {
          var diffed = turf.difference(ringPoly, smallerUnion);
          if (diffed) ringPoly = diffed;
        } catch (err) { /* fall back to the un-differenced tier union for this tier */ }
      }
      features.push({
        type: "Feature",
        properties: { minutes: minutes, bandIdx: tierIdx },
        geometry: ringPoly.geometry
      });
      smallerUnion = smallerUnion ? App.foldAnalysisUnion([smallerUnion, tierUnion]) : tierUnion;
    });
    return features;
  }

  function renderWalkshedLayers(entries) {
    var map = App.map;
    if (!map) return;
    var outlineFeatures = [], segFeatures = [];
    entries.forEach(function (e) {
      if (!e || e.failed) return;
      var bands = e.bands || [{ minutes: e.minutes, polygon: e.polygon }];
      // Ring-difference for rendering only (bands[] itself, which
      // getPointWalkshed()/exportGeoJSON() read, stays un-differenced — see
      // docs/layer-color-customization-plan.md Phase 1). Largest-first so the
      // innermost band stays solid; a turf.difference failure or null result
      // falls back to the un-differenced polygon for that band rather than
      // dropping it. Same approach as transit-travelshed.js's ring builder.
      // This per-point set always feeds the OUTLINE layer (below), flattened
      // fill or not — see buildFlattenedFillFeatures's comment.
      for (var bi = bands.length - 1; bi >= 0; bi--) {
        var band = bands[bi];
        if (!band.polygon) continue;
        var ringPoly = band.polygon;
        if (bi > 0 && bands[bi - 1].polygon) {
          try {
            var diffed = turf.difference(ringPoly, bands[bi - 1].polygon);
            if (diffed) ringPoly = diffed;
          } catch (err) { /* fall back to the un-differenced polygon for this band */ }
        }
        outlineFeatures.push({
          type: "Feature",
          properties: { pointIdx: e.pointIdx, name: e.name, minutes: band.minutes, bandIdx: bi },
          geometry: ringPoly.geometry
        });
      }
      if (e.reachableSegments && e.reachableSegments.features) {
        segFeatures = segFeatures.concat(e.reachableSegments.features);
      }
    });

    var fillFeatures = flattenEnabled() ? buildFlattenedFillFeatures(entries) : outlineFeatures;
    var fillFc = { type: "FeatureCollection", features: fillFeatures };
    var lineFc = { type: "FeatureCollection", features: outlineFeatures };
    var segFc  = { type: "FeatureCollection", features: segFeatures };

    if (!map.getSource(WS_FILL_SRC)) {
      map.addSource(WS_FILL_SRC, { type: "geojson", data: fillFc });
      map.addLayer({
        id: WS_FILL_LAYER, type: "fill", source: WS_FILL_SRC,
        paint: { "fill-color": bandColorExpr(), "fill-opacity": 0.30 }
      });
    } else {
      map.getSource(WS_FILL_SRC).setData(fillFc);
    }

    if (!map.getSource(WS_LINE_SRC)) {
      map.addSource(WS_LINE_SRC, { type: "geojson", data: lineFc });
      map.addLayer({
        id: WS_LINE_LAYER, type: "line", source: WS_LINE_SRC,
        layout: { "line-join": "round" },
        paint: { "line-color": bandColorExpr(), "line-width": 2, "line-opacity": 0.9 }
      });
    } else {
      map.getSource(WS_LINE_SRC).setData(lineFc);
    }

    // Pick up a palette/reverse/flatten change made while results were
    // already on screen — harmless to also run right after the addLayer
    // branch above, since the colors it applies already match what was just
    // set at creation.
    repaintWalkshedLayers();

    if (!map.getSource(WS_SEG_SRC)) {
      map.addSource(WS_SEG_SRC, { type: "geojson", data: segFc });
      map.addLayer({
        id: WS_SEG_LAYER, type: "line", source: WS_SEG_SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": segColor(), "line-width": 1.5, "line-opacity": 0.85 }
      });
    } else {
      map.getSource(WS_SEG_SRC).setData(segFc);
    }
  }

  function clearWalkshedLayers() {
    var map = App.map;
    if (!map) return;
    [WS_SEG_LAYER, WS_LINE_LAYER, WS_FILL_LAYER].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    [WS_SEG_SRC, WS_FILL_SRC, WS_LINE_SRC].forEach(function (id) { if (map.getSource(id)) map.removeSource(id); });
  }

  // ---- Status / stale / empty (standardized helper) ----

  function setStatus(msg, kind) {
    App.renderModuleState({
      statusEl: "wsStatus",
      emptyEl: "wsEmptyState",   // ensure the onboarding box is hidden once we show a status
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  function emptyHint() {
    if (!(App.points || []).length) {
      return { need: "Place a point to calculate a walkshed.", action: "Use the Point tool, then click Calculate." };
    }
    if (!App.roadNetworkLoaded || !App.roadNetworkLoaded()) {
      return { need: "Choose points and click Calculate.",
               action: "No street network is loaded yet — Calculate will offer to download one for just the area these points need." };
    }
    return { need: "Choose points and click Calculate.", action: "A walkshed is the true street-network area reachable on foot within your time budget." };
  }

  function showEmpty() {
    App.renderModuleState({ statusEl: "wsStatus", emptyEl: "wsEmptyState", empty: true, hint: emptyHint() });
  }

  // ---- Collapsible inputs (shared helper) ----
  // One line describing what the last run actually used, so the collapsed
  // header still answers "what am I looking at".
  function inputsSummary() {
    var n = _lastEntries.length;
    return activeBudgets().join(" / ") + " min · " + _settings.walkSpeedMph + " mph · " +
           n + " point" + (n === 1 ? "" : "s");
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".ws-body .rf-settings-col"),
      collapsed: collapsed,
      summary: _lastEntries.length ? inputsSummary() : "",
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastEntries.length ? "results" : "setup", true);
      }
    });
  }

  function showStale() {
    _stale = true;
    App.renderModuleState({ statusEl: "wsStatus", emptyEl: "wsEmptyState", stale: true, onRerun: runWalkshed });
  }

  function markStale() {
    if (!_lastEntries.length) return;
    _stale = true;
    if (isPopupVisible()) { setExportEnabled(false); showStale(); }
  }

  // ---- Results table ----

  function renderResults() {
    var host = document.getElementById("wsResultsTable");
    if (!host) return;
    var M2_TO_MI2 = 3.861021585e-7;
    var M2_TO_KM2 = 1e-6;
    var rows = "";
    _lastEntries.forEach(function (e) {
      if (e.failed) {
        rows += '<tr class="ws-row-fail"><td>' + escapeHtml(e.name || ("Point " + e.pointIdx)) +
          '</td><td colspan="4" class="ws-warn">skipped — ' + escapeHtml(e.reason) + '</td></tr>';
        return;
      }
      var bands = e.bands || [{ minutes: e.minutes, area: e.area, nodeCount: e.reachableCount, polygon: e.polygon }];
      bands.forEach(function (band, bi) {
        var areaCell = band.polygon
          ? (band.area * M2_TO_MI2).toFixed(3) + " mi&sup2;<span class='ws-sub'> / " + (band.area * M2_TO_KM2).toFixed(3) + " km&sup2;</span>"
          : "&mdash;";
        rows += "<tr>" +
          "<td>" + (bi === 0 ? escapeHtml(e.name || ("Point " + e.pointIdx)) : "") + "</td>" +
          "<td>" + band.minutes + " min</td>" +
          "<td>" + areaCell + "</td>" +
          "<td>" + band.nodeCount + "</td>" +
          "<td>" + (bi === 0 ? e.computeMs + " ms" : "") + "</td>" +
          "</tr>";
      });
    });
    host.innerHTML =
      '<table class="ws-table"><thead><tr>' +
      "<th>Point</th><th>Band</th><th>Walkshed area</th><th>Nodes</th><th>Time</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    renderConnectionReport();
    renderCoverageReport();
  }

  // Connection-report footer line (docs/network-connectors-plan.md Phase 6):
  // only rendered when at least one walk connector exists. Styled with the
  // module's existing warning color (#b45309) when a connector end isn't
  // joined to the network.
  function renderConnectionReport() {
    var el = document.getElementById("wsConnReport");
    if (!el) return;
    var summary = typeof App.getConnectorReportSummary === "function"
      ? App.getConnectorReportSummary() : null;
    if (!summary) { el.style.display = "none"; return; }
    el.style.display = "";
    el.style.color = summary.warn ? "#b45309" : "";
    el.innerHTML = escapeHtml(summary.text) +
      (summary.detail ? "<br>" + escapeHtml(summary.detail) : "");
  }

  // Sidewalk coverage footer line (docs/sidewalk-data-plan.md Phase 3):
  // only rendered when a network is loaded — absent, not "0%", when there
  // isn't one. Same warning-color convention as renderConnectionReport().
  function renderCoverageReport() {
    var el = document.getElementById("wsCoverageReport");
    if (!el) return;
    var summary = typeof App.getSidewalkCoverageSummary === "function"
      ? App.getSidewalkCoverageSummary() : null;
    if (!summary) { el.style.display = "none"; return; }
    el.style.display = "";
    el.style.color = summary.warn ? "#b45309" : "";
    el.innerHTML = escapeHtml(summary.text) +
      (summary.detail ? "<br>" + escapeHtml(summary.detail) : "");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- Prompt-to-download street network ----
  // Ported from the Transit Travelshed module (js/projects/transit-travelshed.js),
  // which already does this: rather than refusing to run when the loaded network
  // doesn't reach, offer a download scoped to exactly the area this analysis
  // needs. Walkshed's version is simpler — no routes, no shed mode, just a walk
  // circle per selected point.

  var _pendingDownloadExtent = null; // Feature<Polygon> | null, consumed by #wsDownloadBtn

  // Rectangle covering everything the flood could touch: a circle of the full
  // walk budget around each selected point. Coarse but safe — it only ever asks
  // for MORE coverage than strictly needed, never less.
  function computeRequiredExtent(targets) {
    if (!targets.length) return null;
    var budgets = activeBudgets();
    var maxMinutes = budgets[budgets.length - 1]; // size the circle from the LARGEST budget
    var budgetKm = _settings.walkSpeedMph * KM_PER_MILE * (maxMinutes / 60);
    var pieces = [];
    targets.forEach(function (pf) {
      var c = pf.geometry && pf.geometry.coordinates;
      if (!c) return;
      pieces.push(turf.circle(c, budgetKm, { units: "kilometers", steps: 16 }));
    });
    if (!pieces.length) return null;
    var union = App.foldAnalysisUnion ? App.foldAnalysisUnion(pieces) : pieces[0];
    return union ? turf.bboxPolygon(turf.bbox(union)) : null;
  }

  function setCoverageWarn(msg) {
    var el = document.getElementById("wsCoverageWarn");
    if (!el) return;
    if (msg) { el.textContent = msg; el.style.display = ""; }
    else { el.style.display = "none"; }
  }

  function showDownloadBtn(show) {
    var btn = document.getElementById("wsDownloadBtn");
    if (btn) btn.style.display = show ? "" : "none";
  }

  // Returns true when the analysis may proceed. Otherwise it has already put the
  // reason on screen and (where a download would help) armed the download button.
  function checkNetworkCoverage(targets) {
    _pendingDownloadExtent = computeRequiredExtent(targets);

    if (!App.roadNetworkLoaded || !App.roadNetworkLoaded()) {
      setCoverageWarn("No street network loaded.");
      showDownloadBtn(!!_pendingDownloadExtent);
      return false;
    }
    var downloaded = App.getRoadDownloadExtent ? App.getRoadDownloadExtent() : null;
    if (downloaded === null) {
      // File-imported network — extent unknown. Soft warning; proceed anyway.
      setCoverageWarn("Imported network — can't verify it covers these points; walksheds near the edge may be clipped.");
      showDownloadBtn(false);
      return true;
    }
    if (_pendingDownloadExtent && !turf.booleanContains(downloaded, _pendingDownloadExtent)) {
      setCoverageWarn("Loaded streets don't cover this walk budget.");
      showDownloadBtn(true);
      return false;
    }
    setCoverageWarn(null);
    showDownloadBtn(false);
    return true;
  }

  // Downloads roads for the last computed required extent, then re-runs on
  // success. The walkshed cache keys include the network epoch, which
  // fetchRoadNetworkForExtent bumps, so cached polygons invalidate themselves.
  async function downloadNetworkForPendingExtent() {
    if (!_pendingDownloadExtent || !App.fetchRoadNetworkForExtent) return;
    var btn = document.getElementById("wsDownloadBtn");
    if (btn) btn.disabled = true;
    setStatus("Downloading streets\u2026", "running");
    try {
      var ok = await App.fetchRoadNetworkForExtent(_pendingDownloadExtent);
      if (ok) { updateComputeAvailability(); runWalkshed(); }
      else setStatus("Street download failed or was cancelled.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- Run (compute for target set) ----

  function runWalkshed() {
    if (_running) return;

    readSettingsFromInputs();
    var targets = getTargetPoints();
    if (!targets.length) { setStatus("Select at least one point.", "error"); return; }

    // Missing or insufficient street coverage is an offer to download, not a
    // dead end — checkNetworkCoverage has already explained and armed the button.
    if (!checkNetworkCoverage(targets)) {
      setStatus("Street network doesn't cover these points — download to continue.", "error");
      return;
    }

    _running = true;
    setStatus("Calculating walksheds…", "running");

    // Yield once so the "Calculating…" pill paints before the (blocking) flood.
    setTimeout(function () {
      try {
        var entries = [];
        targets.forEach(function (pf) { entries.push(computeForPoint(pf)); });
        _lastEntries = entries;
        _stale = false;

        var ok = entries.filter(function (e) { return !e.failed; }).length;
        var bad = entries.length - ok;

        var resultsEl = document.getElementById("wsResults");
        if (resultsEl) resultsEl.style.display = ok ? "" : "none";

        renderWalkshedLayers(entries);
        if (isPopupVisible()) {
          renderResults();
          setExportEnabled(ok > 0);
        }

        if (ok) showWalkshedLegend();

        if (!ok) {
          setStatus("No walksheds produced — " + bad + " point(s) skipped.", "error");
        } else if (bad) {
          setStatus("Calculated " + ok + " walkshed(s); " + bad + " skipped.", "done");
        } else {
          setStatus("Calculated " + ok + " walkshed(s).", "done");
        }

        // Collapse the inputs only on a run that produced something — a failed
        // run should leave them open, where the user needs them.
        if (isPopupVisible()) {
          renderInputs(ok > 0);
          if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode(ok > 0 ? "results" : "setup");
        }
      } finally {
        _running = false;
      }
    }, 20);
  }

  // Flag the successfully-computed target points as walkshed study areas and
  // fold them into the buffer union pipeline (the v2 payoff, one click).
  function useAsStudyAreas() {
    var applied = 0;
    _lastEntries.forEach(function (e) {
      if (e.failed) return;
      var pf = findPointByIdx(e.pointIdx);
      if (!pf) return;
      pf.properties.attributes = pf.properties.attributes || {};
      pf.properties.attributes.serviceAreaType = "walkshed";
      applied++;
    });
    if (!applied) { setStatus("Calculate walksheds first.", "error"); return; }
    if (typeof App.refreshBuffers === "function") App.refreshBuffers();
    if (App.cache && App.cache.save) App.cache.save();
    if (typeof App.refreshFeaturePanel === "function") App.refreshFeaturePanel();
    // Broadcast so downstream study-area consumers (Buffer-Area Summary, TPI, …) go
    // stale against the new walkshed geometry.
    if (typeof App.notifyProject === "function") App.notifyProject();
    // Our own walksheds did not change — re-assert good state after the broadcast
    // (notifyProject's update() pass would otherwise false-positive us into "stale").
    _stale = false;
    setExportEnabled(true);
    setStatus(applied + " point(s) now use their walkshed as the study area.", "done");
  }

  // ---- Export ----

  function exportGeoJSON() {
    var features = [];
    _lastEntries.forEach(function (e) {
      if (e.failed) return;
      var bands = e.bands || [{ minutes: e.minutes, area: e.area, nodeCount: e.reachableCount, polygon: e.polygon }];
      bands.forEach(function (band, bi) {
        if (!band.polygon) return;
        features.push({
          type: "Feature",
          properties: { pointIdx: e.pointIdx, name: e.name, minutes: band.minutes, bandIdx: bi, areaM2: band.area, reachableNodes: band.nodeCount },
          geometry: band.polygon.geometry
        });
      });
    });
    if (!features.length) { setStatus("Nothing to export.", "error"); return; }
    var fc = {
      type: "FeatureCollection",
      metadata: { generator: "micro-analysis-tool walkshed", generated: new Date().toISOString(), walkSpeedMph: _settings.walkSpeedMph, maxEdgeKm: _settings.maxEdge },
      features: features
    };
    _triggerDownload(JSON.stringify(fc, null, 2), "application/geo+json", "walkshed-" + _dateStamp() + ".geojson");
  }

  function setExportEnabled(on) {
    var b = document.getElementById("wsExportGeoJSON");
    if (b) b.disabled = !on;
    var u = document.getElementById("wsUseStudyArea");
    if (u) u.disabled = !on;
  }

  // ---- Settings <-> inputs ----

  function readSettingsFromInputs() {
    var m1 = document.getElementById("wsMinutes");
    var m2 = document.getElementById("wsMinutes2");
    var m3 = document.getElementById("wsMinutes3");
    var s = document.getElementById("wsSpeed");
    var e = document.getElementById("wsMaxEdge");
    var budgets = [];
    [m1, m2, m3].forEach(function (el) {
      if (el && +el.value > 0) budgets.push(Math.min(+el.value, MAX_MINUTES));
    });
    if (budgets.length) {
      budgets.sort(function (a, b) { return a - b; });
      _settings.budgets = budgets;
    }
    if (s && +s.value > 0) _settings.walkSpeedMph = +s.value;
    if (e && +e.value > 0) _settings.maxEdge = +e.value / FT_PER_KM; // ft input -> km stored
    if (App.cache && App.cache.save) App.cache.save();
    updateStudyAreaButtonLabel();
  }

  function syncInputsFromSettings() {
    var m1 = document.getElementById("wsMinutes");
    var m2 = document.getElementById("wsMinutes2");
    var m3 = document.getElementById("wsMinutes3");
    var s = document.getElementById("wsSpeed");
    var e = document.getElementById("wsMaxEdge");
    var b = _settings.budgets || [];
    if (m1) m1.value = (b[0] != null) ? b[0] : "";
    if (m2) m2.value = (b[1] != null) ? b[1] : "";
    if (m3) m3.value = (b[2] != null) ? b[2] : "";
    if (s) s.value = _settings.walkSpeedMph;
    if (e) e.value = Math.round(_settings.maxEdge * FT_PER_KM); // km stored -> ft displayed
    // Snap tolerance reads the GLOBAL App.networkSettings, not _settings — it's
    // shared with Transit Travelshed (docs/network-connectors-plan.md §2), so
    // this module never stores its own copy of the value.
    var tol = document.getElementById("wsSnapTol");
    if (tol && App.networkSettings) tol.value = App.networkSettings.snapToleranceFt;
    // Crossing-penalty seconds are GLOBAL state too, same sharing rationale
    // (docs/walkshed-bands-and-crossing-penalties-plan.md Phase 5).
    var cMajor = document.getElementById("wsCrossMajor");
    var cMinor = document.getElementById("wsCrossMinor");
    if (App.networkSettings) {
      if (cMajor) cMajor.value = App.networkSettings.crossingMajorSec;
      if (cMinor) cMinor.value = App.networkSettings.crossingMinorSec;
    }
    syncExcludedWaysLine();
    updateStudyAreaButtonLabel();
  }

  // "Excluded streets: N — clear all" (docs/sidewalk-data-plan.md Phase 4
  // step 9) — discoverability + bulk-undo for exclusions made by clicking
  // the walk-network layer directly, which this popup has no other view into.
  function syncExcludedWaysLine() {
    var countEl = document.getElementById("wsExcludedWaysCount");
    var clearBtn = document.getElementById("wsClearExcludedWays");
    if (!countEl) return;
    var ids = (App.networkSettings && App.networkSettings.excludedWayIds) || [];
    countEl.textContent = ids.length;
    if (clearBtn) clearBtn.style.display = ids.length ? "" : "none";
  }

  function clearExcludedWays() {
    if (typeof App.setExcludedWays === "function") App.setExcludedWays([]);
    syncExcludedWaysLine();
    if (_lastEntries.length) markStale();
  }

  // The study-area button's label always names the SMALLEST active budget,
  // since that is the one band getPointWalkshed() actually returns — changing
  // it changes the study area for every downstream module (Buffer-Area
  // Summary, TPI, Census, LODES, Transit Coverage, Title VI, ...).
  function updateStudyAreaButtonLabel() {
    var btn = document.getElementById("wsUseStudyArea");
    if (!btn) return;
    var smallest = activeBudgets()[0];
    btn.textContent = "Use " + smallest + "-min walkshed as study areas";
    btn.title = "Set these points' Service Area to the " + smallest + "-min Walkshed so demographic modules " +
      "use it instead of a circle. Changing the smallest time budget changes the study area used by every " +
      "downstream module.";
  }

  // Snap tolerance is global state, not a module setting — write straight to
  // App.networkSettings and re-run the connector overlay, per §2 "Known conflict".
  function onSnapTolChange() {
    var el = document.getElementById("wsSnapTol");
    if (!el || !(+el.value > 0)) return;
    if (App.networkSettings) App.networkSettings.snapToleranceFt = +el.value;
    if (App.cache && App.cache.save) App.cache.save();
    if (typeof App.refreshNetworkConnectors === "function") App.refreshNetworkConnectors();
    if (_lastEntries.length) markStale();
  }

  // Crossing-penalty seconds are global state too, same sharing rationale as
  // snap tolerance (docs/walkshed-bands-and-crossing-penalties-plan.md Phase 5)
  // — write straight to App.networkSettings. No connector overlay to re-run;
  // no network geometry changed, only the flood's cost function.
  function onCrossingChange() {
    var majorEl = document.getElementById("wsCrossMajor");
    var minorEl = document.getElementById("wsCrossMinor");
    if (App.networkSettings) {
      if (majorEl && +majorEl.value >= 0) App.networkSettings.crossingMajorSec = +majorEl.value;
      if (minorEl && +minorEl.value >= 0) App.networkSettings.crossingMinorSec = +minorEl.value;
    }
    if (App.cache && App.cache.save) App.cache.save();
    if (_lastEntries.length) markStale();
  }

  // ---- Lifecycle ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    syncInputsFromSettings();

    var computeBtn = document.getElementById("wsComputeBtn");
    if (computeBtn) computeBtn.addEventListener("click", runWalkshed);

    var dlBtn = document.getElementById("wsDownloadBtn");
    if (dlBtn) dlBtn.addEventListener("click", downloadNetworkForPendingExtent);

    var gj = document.getElementById("wsExportGeoJSON");
    if (gj) gj.addEventListener("click", exportGeoJSON);

    var use = document.getElementById("wsUseStudyArea");
    if (use) use.addEventListener("click", useAsStudyAreas);

    ["wsMinutes", "wsMinutes2", "wsMinutes3", "wsSpeed", "wsMaxEdge"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () { readSettingsFromInputs(); if (_lastEntries.length) markStale(); });
    });

    var snapEl = document.getElementById("wsSnapTol");
    if (snapEl) snapEl.addEventListener("change", onSnapTolChange);

    ["wsCrossMajor", "wsCrossMinor"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", onCrossingChange);
    });

    var clearExcludedBtn = document.getElementById("wsClearExcludedWays");
    if (clearExcludedBtn) clearExcludedBtn.addEventListener("click", clearExcludedWays);
  }

  function onOpen(core) {
    syncInputsFromSettings();
    buildPointChecklist();
    updateComputeAvailability();
    // Reopening keeps whatever collapse state the last run left; a module that
    // has never run shows the header expanded.
    renderInputs(_lastEntries.length ? undefined : false);
    if (_lastEntries.length) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      var resultsEl = document.getElementById("wsResults");
      if (resultsEl) resultsEl.style.display = "";
      renderResults();
      setExportEnabled(_lastEntries.some(function (e) { return !e.failed; }) && !_stale);
      if (_stale) showStale(); else setStatus("", "");
    } else {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      setExportEnabled(false);
      showEmpty();
    }
  }

  function onClose(core) { /* state persists in closure */ }

  // Calculate stays enabled with no network loaded — pressing it is how the user
  // gets offered the scoped download.
  function updateComputeAvailability() {
    var btn = document.getElementById("wsComputeBtn");
    if (btn) btn.disabled = false;
    var loaded = App.roadNetworkLoaded && App.roadNetworkLoaded();
    if (loaded) { setCoverageWarn(null); showDownloadBtn(false); }
  }

  function clearAll() {
    clearWalkshedLayers();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("ws-legend");
    _walkshedCache.clear();
    _lastEntries = [];
    _stale = false;
    if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      renderInputs(false);
      var resultsEl = document.getElementById("wsResults");
      if (resultsEl) resultsEl.style.display = "none";
      setExportEnabled(false);
      showEmpty();
    }
  }

  async function update(core) {
    // Points removed entirely → drop rendered walksheds.
    if (_lastEntries.length && (App.points || []).length === 0) {
      clearWalkshedLayers();
      if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("ws-legend");
      _lastEntries = [];
    }
    if (!isPopupVisible()) return;
    buildPointChecklist();
    updateComputeAvailability();
    if (_lastEntries.length) markStale();
  }

  // ---- Session persistence ----
  // Settings always persist (light + full). The computed polygons/reachable-streets
  // are a snapshot of a Compute run against whatever road network was loaded at the
  // time — not re-derivable without that network — so they're included ONLY in full
  // mode (file Save/Load State), same rule Corridor Scoring's lastSummary follows,
  // and left out of the light/localStorage autosave to avoid growing on every
  // settings tweak. A light-mode restore (page reload) still requires Calculate,
  // same as before this was added.

  function collect(mode) {
    var data = {
      version: 3,
      budgets: (_settings.budgets || []).filter(function (b) { return b != null; }),
      walkSpeedMph: _settings.walkSpeedMph,
      maxEdge: _settings.maxEdge
    };
    if (mode === "full" && _lastEntries.length) {
      data.lastEntries = _lastEntries.map(function (e) {
        return e.failed
          ? { failed: true, pointIdx: e.pointIdx, name: e.name, reason: e.reason }
          : {
              pointIdx: e.pointIdx,
              name: e.name,
              coord: e.coord,
              settingsKey: e.settingsKey,
              computeMs: e.computeMs,
              bands: e.bands,                       // [{minutes, polygon, area, nodeCount}, ...]
              reachableSegments: e.reachableSegments // FeatureCollection, for the green proof layer
            };
      });
    }
    return data;
  }

  function apply(data) {
    if (!data) return;
    if (Array.isArray(data.budgets) && data.budgets.length) {
      // v3: an explicit budget list.
      var budgets = data.budgets
        .filter(function (b) { return +b > 0; })
        .map(function (b) { return Math.min(+b, MAX_MINUTES); });
      if (budgets.length) {
        budgets.sort(function (a, b) { return a - b; });
        _settings.budgets = budgets;
      }
    } else if (+data.minutes > 0) {
      // v1/v2: a single minutes value — becomes the sole (smallest) budget.
      _settings.budgets = [Math.min(+data.minutes, MAX_MINUTES)];
    }
    if (+data.walkSpeedMph > 0) {
      _settings.walkSpeedMph = +data.walkSpeedMph;
    } else if (+data.walkSpeedKmh > 0) {
      // v1 schema migration: saved speed was km/h — convert to mph.
      _settings.walkSpeedMph = +data.walkSpeedKmh / KM_PER_MILE;
    }
    if (+data.maxEdge > 0) _settings.maxEdge = +data.maxEdge;

    if (Array.isArray(data.lastEntries) && data.lastEntries.length) restoreEntries(data.lastEntries);
  }

  // Rebuilds _walkshedCache + _lastEntries from a full-mode save and renders them
  // immediately — no road network or Calculate click needed. Mirrors the tail of
  // runWalkshed()'s success path (map layers first, then the popup DOM behind the
  // usual isPopupVisible() guard). Restored polygons stay in _walkshedCache like any
  // other cache entry, so getPointWalkshed()'s settingsKey check still applies —
  // it naturally falls back to a circular buffer until a live network makes the key
  // match again, rather than trusting a snapshot that may no longer be accurate.
  function restoreEntries(saved) {
    var entries = [];
    saved.forEach(function (s) {
      if (s.failed) {
        entries.push({ failed: true, pointIdx: s.pointIdx, name: s.name, reason: s.reason });
        return;
      }
      var bands = s.bands;
      if (!bands || !bands.length || !bands[0] || !bands[0].polygon) return;
      bands[0].polygon.properties = bands[0].polygon.properties || {};
      bands[0].polygon.properties.pointIdx = s.pointIdx;
      var entry = {
        polygon:           bands[0].polygon,
        reachableSegments: s.reachableSegments || null,
        reachableCount:    bands[0].nodeCount || 0,
        area:              bands[0].area || 0,
        bands:             bands,
        computeMs:         s.computeMs,
        minutes:           bands[0].minutes,
        name:              s.name,
        pointIdx:          s.pointIdx,
        coord:             s.coord,
        settingsKey:       s.settingsKey
      };
      _walkshedCache.set(s.pointIdx, entry);
      entries.push(entry);
    });
    if (!entries.length) return;

    _lastEntries = entries;
    _stale = false;

    renderWalkshedLayers(_lastEntries);
    var ok = _lastEntries.filter(function (e) { return !e.failed; }).length;
    if (ok) showWalkshedLegend();

    if (isPopupVisible()) {
      var resultsEl = document.getElementById("wsResults");
      if (resultsEl) resultsEl.style.display = ok ? "" : "none";
      renderResults();
      setExportEnabled(ok > 0);
      renderInputs(ok > 0);
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode(ok > 0 ? "results" : "setup");
      setStatus(ok ? "Restored " + ok + " walkshed(s) from saved session." : "", ok ? "done" : "");
    }
  }

  // ---- Register ----

  App.getPointWalkshed = getPointWalkshed;
  App.ensurePointWalksheds = ensurePointWalksheds;

  App.registerModule({
    id:         "walkshed",
    name:       "Walkshed Analysis",
    enabled:    true,
    popupWidth: 460,
    panelWidths: { setup: 460, results: 460 },
    popupHTML:  "projects/walkshed-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  async function (core) { await update(core); }
  });

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("walkshed", { collect: collect, apply: apply });
  }

})();
