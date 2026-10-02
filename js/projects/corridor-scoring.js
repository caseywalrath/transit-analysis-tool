// js/projects/corridor-scoring.js
// Corridor Scoring: registers as an analysis module, opens in a 2-column popup,
// produces a ranked composite score per selected corridor using the per-route CDI engine.
// Depends on: App namespace, TPI namespace (tpi-scoring.js), RidershipModel (ridership-scoring.js),
//   App.popup (popup.js), turf (CDN).
// Step 1: scaffolding + static Settings column.
// No public API.

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var TPI = window.TPI;

  // ---- Module-local state (persists across popup open/close) ----

  var _weights           = TPI ? TPI.getDefaultWeights() : {};
  var _pendingWeights    = null;   // temp copy while Adjust Weights modal is open (Step 2)
  // Checklist selection is remembered as the features the user UNCHECKED, by stable
  // { type, id } ref (Phase 4b) — array positions shift when an earlier feature is
  // deleted or merged. Anything not listed (including newly drawn features) is checked.
  var _uncheckedRefs     = [];
  var _lastResult        = null;   // { routeCDIs, geoLevel, year, apportionByArea, unionPolygon, weights } (Step 3+)
  var _stale             = false;
  var _running           = false;
  var _initialized       = false;
  var _apportionByArea   = false;
  var _bufferMiles       = App.ANALYSIS_BUFFER_DEFAULT_MILES;
  var _useDisplayBuffers = false;
  var _includeHidden     = false;  // analyze features hidden on the map (docs/hidden-features-analysis-plan.md)
  // Taken at run time so update() can tell a relevant change from an unrelated
  // hide/show (notifyProject fires on every visibility change).
  var _runSnap           = null;   // { refs: [{type,id}], hidden: string, includeHidden: bool }

  // ---- DOM guard: only touch DOM when popup is open for this module ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "corridor-scoring";
  }

  // ---- Feature filter helpers (routes + lines only per plan) ----

  // Set by buildUnionFromFilter(), consumed immediately by runScoring() —
  // gives access to the full buffer set (and its .count) without changing
  // buildUnionFromFilter's return type (still just the union polygon).
  var _lastBufferSet = null;

  function buildUnionFromFilter(filter) {
    var set = _useDisplayBuffers
      ? App.buildDisplayBufferSet(filter, { includeHidden: _includeHidden })
      : App.buildAnalysisBufferSet(filter, _bufferMiles, { includeHidden: _includeHidden });
    _lastBufferSet = set;
    return set.union;
  }

  function syncBufferControl() {
    var input = document.getElementById("csBufferMiles");
    var toggle = document.getElementById("csUseDisplayBuffers");
    if (input) {
      input.value = String(_bufferMiles);
      input.disabled = _useDisplayBuffers;
    }
    if (toggle) toggle.checked = _useDisplayBuffers;
  }

  // Record which checklist rows are unchecked (by ID). Called from checkbox change
  // handlers only — never from a rebuild, so a restored selection isn't overwritten
  // by stale DOM.
  function captureChecklistSelection() {
    var el = document.getElementById("csFeatureList");
    if (!el) return;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return;
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) continue;
      var id = parseInt(boxes[i].getAttribute("data-feature-id"), 10);
      if (Number.isFinite(id)) out.push({ type: boxes[i].getAttribute("data-type"), id: id });
    }
    _uncheckedRefs = out;
    if (App.cache && App.cache.save) App.cache.save();
  }

  function isRefUnchecked(type, id) {
    for (var i = 0; i < _uncheckedRefs.length; i++) {
      if (_uncheckedRefs[i].type === type && _uncheckedRefs[i].id === id) return true;
    }
    return false;
  }

  // Checked, enabled rows as stable refs (the features a run analyzes). A
  // disabled-but-checked row (hidden, toggle off) stays in the saved selection
  // (_uncheckedRefs) but is not part of a run.
  function getCheckedRefs() {
    var el = document.getElementById("csFeatureList");
    var out = [];
    if (!el) return out;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked || boxes[i].disabled) continue;
      var id = parseInt(boxes[i].getAttribute("data-feature-id"), 10);
      if (Number.isFinite(id)) out.push({ type: boxes[i].getAttribute("data-type"), id: id });
    }
    return out;
  }

  // Run-time index filter from the live checkboxes (indices are only used within
  // the run; nothing stores this).
  function getFeatureFilter() {
    var el = document.getElementById("csFeatureList");
    var routeIndices = [], lineIndices = [];
    if (!el) return { routeIndices: routeIndices, lineIndices: lineIndices };
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      var type = cb.getAttribute("data-type");
      var idx  = parseInt(cb.getAttribute("data-idx"), 10);
      if (cb.checked && !cb.disabled) {
        if      (type === "route") routeIndices.push(idx);
        else if (type === "line")  lineIndices.push(idx);
      }
    }
    return { routeIndices: routeIndices, lineIndices: lineIndices };
  }

  // ---- Feature checklist (routes + lines) ----

  function buildFeatureChecklist() {
    var el = document.getElementById("csFeatureList");
    if (!el) return;

    el.innerHTML = "";
    var hasFeatures = false;

    function addRow(type, idx, name, badge, feature) {
      hasFeatures = true;
      var ref = App.featureRef(type, idx);
      var checked = !(ref && isRefUnchecked(type, ref.id));
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", type);
      cb.setAttribute("data-idx", String(idx));
      if (ref) cb.setAttribute("data-feature-id", String(ref.id));
      cb.checked = checked;

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = name;

      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = badge;

      lbl.addEventListener("click", function (e) { e.preventDefault(); if (cb.disabled) return; cb.checked = !cb.checked; captureChecklistSelection(); markStale(); });
      cb.addEventListener("change", function () { captureChecklistSelection(); markStale(); });

      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(badgeEl);
      el.appendChild(row);
      App.decorateHiddenRow(row, cb, feature, _includeHidden);
    }

    var routes = App.routes || [];
    var lines  = App.lines  || [];

    for (var ri = 0; ri < routes.length; ri++) {
      addRow("route", ri,
        (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1)),
        "R", routes[ri]);
    }
    for (var li = 0; li < lines.length; li++) {
      addRow("line", li,
        (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1)),
        "L", lines[li]);
    }

    if (!hasFeatures) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No routes or lines drawn.</div>';
    }
  }

  // ---- Weight sliders (inside modal) ----

  function buildWeightSliders() {
    var container = document.getElementById("csWeightSliders");
    if (!container || !TPI) return;
    container.innerHTML = "";

    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (_weights[f.id] != null) ? _weights[f.id] : (f.defaultWeight || 0);

      var row = document.createElement("div");
      row.className = "tpi-slider-row";
      row.innerHTML =
        '<label class="tpi-slider-label" title="' + (f.description || "") + '">' + f.label + '</label>' +
        '<input type="range" class="tpi-slider cs-slider" min="0" max="100" step="5" value="' + w + '" data-factor="' + f.id + '">' +
        '<input type="number" class="tpi-slider-value" id="csW_' + f.id + '" value="' + w + '" min="0" max="100" step="1" data-factor="' + f.id + '">';
      container.appendChild(row);

      var slider   = row.querySelector("input[type=range]");
      var numInput = row.querySelector("input[type=number]");
      slider.addEventListener("input",  onModalSliderChange);
      numInput.addEventListener("change", onModalNumberChange);
    }
    updateModalWeightSum();
  }

  function syncSlidersToWeights(weights) {
    if (!TPI) return;
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (weights[f.id] != null) ? weights[f.id] : 0;
      var slider   = document.querySelector('.cs-slider[data-factor="' + f.id + '"]');
      var numInput = document.getElementById("csW_" + f.id);
      if (slider)   slider.value   = String(w);
      if (numInput) numInput.value = String(w);
    }
    updateModalWeightSum();
  }

  function onModalSliderChange(e) {
    if (!_pendingWeights) return;
    var factorId = e.target.getAttribute("data-factor");
    _pendingWeights[factorId] = parseInt(e.target.value, 10);
    var numInput = document.getElementById("csW_" + factorId);
    if (numInput) numInput.value = String(_pendingWeights[factorId]);
    updateModalWeightSum();
  }

  function onModalNumberChange(e) {
    if (!_pendingWeights) return;
    var factorId = e.target.getAttribute("data-factor");
    var raw      = parseInt(e.target.value, 10);
    var clamped  = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
    e.target.value = String(clamped);
    _pendingWeights[factorId] = clamped;
    var slider = document.querySelector('.cs-slider[data-factor="' + factorId + '"]');
    if (slider) slider.value = String(clamped);
    updateModalWeightSum();
  }

  function updateModalWeightSum() {
    if (!TPI) return 0;
    var weights = _pendingWeights || _weights;
    var sum = 0;
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) sum += (weights[factors[i].id] || 0);

    var sumEl      = document.getElementById("csWeightSum");
    var warnEl     = document.getElementById("csWeightWarn");
    var confirmBtn = document.getElementById("csWeightsConfirm");
    if (sumEl)      { sumEl.textContent = String(sum); sumEl.style.color = sum === 100 ? "" : "#e53e3e"; }
    if (warnEl)     warnEl.style.visibility = sum === 100 ? "hidden" : "visible";
    if (confirmBtn) confirmBtn.disabled = (sum !== 100);
    return sum;
  }

  function openWeightsModal() {
    _pendingWeights = Object.assign({}, _weights);
    syncSlidersToWeights(_pendingWeights);
    var modal = document.getElementById("csWeightsModal");
    if (modal) modal.style.display = "";
  }

  function closeWeightsModal(confirm) {
    var modal = document.getElementById("csWeightsModal");
    if (modal) modal.style.display = "none";
    if (confirm && _pendingWeights) {
      var oldJSON = JSON.stringify(_weights);
      _weights    = Object.assign({}, _pendingWeights);
      if (JSON.stringify(_weights) !== oldJSON) markStale();
    }
    _pendingWeights = null;
  }

  function resetModalToDefaults() {
    if (!TPI) return;
    _pendingWeights = TPI.getDefaultWeights();
    syncSlidersToWeights(_pendingWeights);
  }

  // ---- LODES warning icon visibility ----

  function updateLodesWarnings() {
    var warnBtn = document.getElementById("csLodesWarnBtn");
    if (warnBtn) warnBtn.style.display = App.lodesData ? "none" : "";
  }

  // ---- Status + stale helpers ----

  function setStatus(msg, kind) {
    // kind: "" | "done" | "error" | "running" (stale is handled by markStale)
    App.renderModuleState({
      statusEl: "csStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  // Context-aware onboarding/empty hint shown when there are no results.
  function emptyHint() {
    var n = (App.routes || []).length + (App.lines || []).length;
    if (!n) {
      return { need: "Draw a route or line to begin.",
               action: "Use the Route or Line tool, then reopen this panel." };
    }
    return { need: "Select corridors and click Score Corridors.",
             action: "Each selected route or line gets a ranked composite demand score." };
  }

  // ---- Collapsible inputs (shared helper) ----

  function inputsSummary() {
    var geoEl = document.getElementById("csGeoLevel");
    var yearEl = document.getElementById("csYearSelect");
    var bufferEl = document.getElementById("csBufferMiles");
    var count = document.querySelectorAll("#csFeatureList input[type=checkbox]:checked:not(:disabled)").length;
    var geoLabel = geoEl && geoEl.value === "tract" ? "Tracts" : "Block groups";
    return geoLabel + " \u00b7 " + (yearEl ? yearEl.value : "") + " \u00b7 " +
      (bufferEl ? bufferEl.value : _bufferMiles) + " mi \u00b7 " +
      count + " corridor" + (count === 1 ? "" : "s");
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".cs-body .rf-settings-col"),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastResult ? "results" : "setup", true);
      }
    });
  }

  // True when the last run no longer matches the map: the hidden state of a
  // feature in the run's selection changed, or the toggle changed.
  function runIsOutdated() {
    if (!_runSnap) return false;
    if (_runSnap.includeHidden !== _includeHidden) return true;
    return _runSnap.hidden !== App.hiddenSignature(_runSnap.refs);
  }

  function markStale() {
    renderInputs();
    _stale = true;
    setExportButtonsEnabled(false);
    if (!isPopupVisible()) return;
    if (_lastResult) {
      App.renderModuleState({ statusEl: "csStatus", stale: true, onRerun: runScoring });
    }
  }

  // ---- Exports ----

  function _dateStamp() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function _triggerDownload(content, mimeType, filename) {
    var blob = new Blob([content], { type: mimeType });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function _csvField(val) {
    if (val == null) return "";
    var s = String(val);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function _buildMetadata() {
    return {
      tool:            "Micro Analysis Tool",
      module:          "Corridor Scoring",
      exportedAt:      new Date().toISOString(),
      geoLevel:        _lastResult ? _lastResult.geoLevel : null,
      acsYear:         _lastResult ? _lastResult.year     : null,
      apportionByArea: _lastResult ? _lastResult.apportionByArea : false,
      bufferMiles:     _lastResult ? _lastResult.bufferMiles : App.ANALYSIS_BUFFER_DEFAULT_MILES,
      weights:         _lastResult ? _lastResult.weights  : null
    };
  }

  function exportCSV() {
    if (!_lastResult) return;
    var factors = TPI ? TPI.FACTORS : [];
    var rows    = _lastResult.routeCDIs || [];
    var meta    = _buildMetadata();

    var header = [
      "rank", "name", "feature_type", "feature_index",
      "cdi_score", "classification", "length_mi", "geo_count",
      "composite_min", "composite_max"
    ];
    for (var fi = 0; fi < factors.length; fi++) {
      header.push(factors[fi].id + "_avg_quintile");
    }

    var lines = [];
    lines.push("# Micro Analysis Tool — Corridor Scoring Export");
    lines.push("# Exported: "        + meta.exportedAt);
    lines.push("# Geography: "       + (meta.geoLevel || ""));
    lines.push("# ACS Year: "        + (meta.acsYear  || ""));
    lines.push("# Apportion by area: " + (meta.apportionByArea ? "yes" : "no"));
    lines.push(header.join(","));

    for (var i = 0; i < rows.length; i++) {
      var r  = rows[i];
      var cr = r.compositeRange || {};
      var row = [
        i + 1,
        _csvField(r.name),
        r.featureType || "",
        liveIndexOf(r) >= 0 ? liveIndexOf(r) : "",
        Number.isFinite(r.cdi) ? r.cdi.toFixed(4) : "",
        _csvField(r.classification || ""),
        Number.isFinite(r.lengthMiles) ? r.lengthMiles.toFixed(4) : "",
        r.geoCount != null ? r.geoCount : "",
        Number.isFinite(cr.min) ? cr.min.toFixed(4) : "",
        Number.isFinite(cr.max) ? cr.max.toFixed(4) : ""
      ];
      var fb = r.factorBreakdown || {};
      for (var fj = 0; fj < factors.length; fj++) {
        var v = fb[factors[fj].id];
        row.push(Number.isFinite(v) ? v.toFixed(3) : "");
      }
      lines.push(row.join(","));
    }

    _triggerDownload(lines.join("\n"), "text/csv",
      "corridor-scoring-" + _dateStamp() + ".csv");
  }

  function exportGeoJSON() {
    if (!_lastResult) return;
    var rows = _lastResult.routeCDIs || [];
    var features = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var src = getFeatureSourceGeom(r.featureType, r.featureId);
      if (!src || !src.geometry) continue;   // feature deleted since the run
      features.push({
        type: "Feature",
        geometry: src.geometry,
        properties: {
          name:             r.name,
          cdi:              Number.isFinite(r.cdi) ? parseFloat(r.cdi.toFixed(4)) : null,
          classification:   r.classification || "N/A",
          rank:             i + 1,
          featureType:      r.featureType,
          featureIndex:     liveIndexOf(r),
          lengthMiles:      Number.isFinite(r.lengthMiles) ? parseFloat(r.lengthMiles.toFixed(4)) : null,
          geoCount:         r.geoCount != null ? r.geoCount : null,
          compositeRange:   r.compositeRange || null,
          factorBreakdown:  r.factorBreakdown || {}
        }
      });
    }

    var geojson = {
      type: "FeatureCollection",
      metadata: _buildMetadata(),
      features: features
    };
    _triggerDownload(
      JSON.stringify(geojson, null, 2),
      "application/geo+json",
      "corridor-scoring-" + _dateStamp() + ".geojson"
    );
  }

  function setExportButtonsEnabled(enabled) {
    var csvBtn = document.getElementById("csExportCSV");
    var gjBtn  = document.getElementById("csExportGeoJSON");
    if (csvBtn) csvBtn.disabled = !enabled;
    if (gjBtn)  gjBtn.disabled  = !enabled;
    var toggleRow = document.getElementById("csChoroplethToggleRow");
    if (toggleRow) toggleRow.style.display = enabled ? "" : "none";
  }

  // ---- Map choropleth (scored corridors colored by composite CDI) ----

  var CS_SOURCE      = "corridor-scoring-routes";
  var CS_LINE_LAYER  = "corridor-scoring-routes-layer";

  // Source feature for a scored row, resolved by stable ID (null once deleted).
  function getFeatureSourceGeom(featureType, featureId) {
    if (featureType !== "route" && featureType !== "line") return null;
    return App.featureById(featureType, featureId);
  }

  // A row's CURRENT array index (-1 when its feature no longer exists). The
  // row's own featureIndex is only the position at run time and goes stale.
  function liveIndexOf(r) {
    return App.resolveFeatureRef({ type: r.featureType, id: r.featureId });
  }

  function buildScoredFeatureCollection(result) {
    var features = [];
    var rows = (result && result.routeCDIs) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var src = getFeatureSourceGeom(r.featureType, r.featureId);
      if (!src || !src.geometry) continue;
      features.push({
        type: "Feature",
        geometry: src.geometry,
        properties: {
          name:           r.name,
          cdi:            Number.isFinite(r.cdi) ? r.cdi : null,
          classification: r.classification || "N/A",
          rank:           i + 1,
          featureType:    r.featureType,
          featureId:      r.featureId
        }
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  function renderMapChoropleth(result) {
    var map = App.map;
    if (!map || !result) return;
    var fc = buildScoredFeatureCollection(result);

    // Phase 3 Step 3.4 of docs/feature-area-choropleth-plan.md: the step
    // expression itself now comes from the shared engine so the ramp
    // definition has one home, but CS keeps its own fixed red/orange/
    // yellow/green corridor-quality breaks -- not one of App.choropleth's
    // curated sequential ramps, since low/high CDI here is a quality
    // judgment (poor -> excellent), not a plain magnitude gradient.
    // Equivalent to the old inline expression for every real cdi value:
    // a missing/non-numeric cdi now takes buildStepColorExpr's typeof-based
    // noDataColor path instead of the old "coalesce to -1, add a 0 break"
    // sentinel, which drew the same gray for the same case.
    // Colors resolve through the layer color cascade
    // (docs/layer-color-customization-plan.md) — restricted to diverging
    // palettes only by the "corridor-scoring" spec's allow list, so this can
    // never become an unreadable sequential ramp.
    var csColors = (App.resolveLayerColors && App.resolveLayerColors("corridor-scoring")) ||
      ["#C53030", "#C05621", "#D69E2E", "#276749"];
    var colorExpr = App.choropleth.buildStepColorExpr(
      "cdi", [2, 3, 4], csColors, "rgba(180,180,180,0.7)"
    );

    if (!map.getSource(CS_SOURCE)) {
      map.addSource(CS_SOURCE, { type: "geojson", data: fc });
      map.addLayer({
        id: CS_LINE_LAYER,
        type: "line",
        source: CS_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color":  colorExpr,
          "line-width":  5,
          "line-opacity": 0.9
        }
      });

      // Hover tooltip
      var hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mousemove", CS_LINE_LAYER, function (e) {
        map.getCanvas().style.cursor = "pointer";
        if (!e.features || !e.features.length) return;
        var p = e.features[0].properties;
        var cdi = p.cdi != null ? Number(p.cdi).toFixed(2) : "N/A";
        var html = '<div style="font-size:12px;line-height:1.4;">' +
          '<b>#' + p.rank + '</b> &mdash; ' + (p.name || "") + '<br>' +
          '<b>Score:</b> ' + cdi + ' &mdash; ' + (p.classification || "N/A") +
          '</div>';
        hover.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on("mouseleave", CS_LINE_LAYER, function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
        hover.remove();
      });
    } else {
      map.getSource(CS_SOURCE).setData(fc);
      map.setPaintProperty(CS_LINE_LAYER, "line-color", colorExpr); // pick up a palette changed while results were on screen
    }
  }

  function clearMapChoropleth() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer(CS_LINE_LAYER)) map.removeLayer(CS_LINE_LAYER);
    if (map.getSource(CS_SOURCE))    map.removeSource(CS_SOURCE);
  }

  // The legend lists high quality first (>= 4 High at top) while
  // App.resolveLayerColors("corridor-scoring") runs low -> high, so the
  // fill iterates the colors array reversed.
  function fillCsLegendColors() {
    var colors = (App.resolveLayerColors && App.resolveLayerColors("corridor-scoring")) ||
      ["#C53030", "#C05621", "#D69E2E", "#276749"];
    for (var i = 0; i < 4; i++) {
      var sw = document.getElementById("csLegendSw" + i);
      if (sw) sw.style.background = colors[colors.length - 1 - i] || colors[0];
    }
  }

  // Shows (or re-shows) the cs-legend widget and fills its swatch colors
  // once the widget's DOM has actually mounted — showFloatingWidget is
  // async on first creation but synchronous when the widget already
  // exists, so this handles both without forcing every caller to await.
  function showCsLegend() {
    var p = App.popup.showFloatingWidget("cs-legend", "projects/corridor-scoring-legend.html", {
      position: "bottom-left", width: 180, title: "Corridor Score"
    });
    if (p && typeof p.then === "function") p.then(fillCsLegendColors);
    else fillCsLegendColors();
  }

  // Re-renders from the last result (cheap — geometry is already resolved,
  // no Census calls) so a palette change picked up from the Layers panel
  // repaints instantly, and refreshes the legend swatches in place. No-op
  // when nothing has been scored yet.
  if (typeof App.registerLayerRepainter === "function") {
    App.registerLayerRepainter("corridor-scoring", function () {
      if (_lastResult) renderMapChoropleth(_lastResult);
      fillCsLegendColors();
    });
  }

  // ---- Factor breakdown (per-corridor expansion) ----

  // System-wide average quintile per factor — used as comparison baseline.
  function computeSystemFactorAverages(tpiResult) {
    var avgs = {};
    if (!tpiResult || !tpiResult.factorScores) return avgs;
    var iter = tpiResult.factorScores.entries();
    var entry = iter.next();
    while (!entry.done) {
      var factorId = entry.value[0];
      var scoreMap = entry.value[1];
      var sum = 0, count = 0;
      var valIter = scoreMap.values();
      var v = valIter.next();
      while (!v.done) {
        if (Number.isFinite(v.value)) { sum += v.value; count++; }
        v = valIter.next();
      }
      avgs[factorId] = count > 0 ? sum / count : NaN;
      entry = iter.next();
    }
    return avgs;
  }

  function buildFactorBreakdownHTML(routeCDI, systemAvgs, effectiveWeights) {
    if (!TPI) return "";
    var factors = TPI.FACTORS;
    var breakdown = (routeCDI && routeCDI.factorBreakdown) || {};
    var html = '<div class="rf-route-factor-list">';

    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (effectiveWeights && effectiveWeights[f.id] != null) ? effectiveWeights[f.id] : 0;
      if (w === 0) continue;

      var routeAvg = breakdown[f.id];
      var sysAvg   = systemAvgs ? systemAvgs[f.id] : NaN;
      var rValid   = Number.isFinite(routeAvg);
      var sValid   = Number.isFinite(sysAvg);

      var routeBarPct  = rValid ? ((routeAvg - 1) / 4) * 100 : 0;
      var sysMarkerPct = sValid ? ((sysAvg   - 1) / 4) * 100 : 0;

      var diff = (rValid && sValid) ? routeAvg - sysAvg : 0;
      var barColor = diff > 0.3 ? "#48bb78" : (diff < -0.3 ? "#f56565" : "#a0aec0");

      html += '<div class="rf-route-factor-row">' +
        '<span class="rf-route-factor-name" title="' + escapeHTML(f.description || f.label) + '">' + escapeHTML(f.label) + '</span>' +
        '<span class="rf-route-factor-weight tiny">' + Math.round(w) + '%</span>' +
        '<span class="rf-route-factor-bar-wrap">' +
          '<span class="rf-route-factor-bar" style="width:' + routeBarPct.toFixed(0) + '%;background:' + barColor + ';" ' +
            'title="Corridor: ' + (rValid ? routeAvg.toFixed(1) : 'N/A') + ' / System: ' + (sValid ? sysAvg.toFixed(1) : 'N/A') + '"></span>' +
          (sValid ? '<span class="rf-route-factor-sys-marker" style="left:' + sysMarkerPct.toFixed(0) + '%;" title="System avg: ' + sysAvg.toFixed(1) + '"></span>' : '') +
        '</span>' +
        '<span class="rf-route-factor-score">' + (rValid ? routeAvg.toFixed(1) : 'N/A') + '</span>' +
        '</div>';
    }

    html += '</div>';
    return html;
  }

  // ---- Results table ----

  function pillClassFor(label) {
    switch (label) {
      case "High":        return "pill high";
      case "Medium":      return "pill med";
      case "Low-Medium":  return "pill ml";
      case "Low":         return "pill low";
      default:            return "pill na";
    }
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatScore(cdi) {
    return Number.isFinite(cdi) ? cdi.toFixed(2) : "—";
  }

  // Test-only: expose the pure scoring/formatting helpers to the golden harness
  // (test/run-golden.mjs). Guarded by __MAT_TEST__ so it has no effect in the
  // browser. See test/README.md.
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._csTest = {
      computeSystemFactorAverages: computeSystemFactorAverages,
      pillClassFor: pillClassFor,
      formatScore: formatScore,
      escapeHTML: escapeHTML,
      _csvField: _csvField
    };
  }

  function renderResultsTable(result) {
    var container = document.getElementById("csResultsTable");
    var resultsWrap = document.getElementById("csResults");
    var emptyState  = document.getElementById("csEmptyState");
    if (!container || !resultsWrap) return;
    var hiddenNoteEl = document.getElementById("csHiddenNote");
    if (hiddenNoteEl) hiddenNoteEl.textContent = (result && App.hiddenSelectionMessage(result.hiddenIncluded || 0).notes) || "";

    var rows = (result && result.routeCDIs) || [];

    if (!rows.length) {
      resultsWrap.style.display = "none";
      container.innerHTML = "";
      App.renderModuleState({
        statusEl: "csStatus", emptyEl: "csEmptyState", empty: true, hint: emptyHint()
      });
      return;
    }
    if (emptyState) emptyState.style.display = "none";
    resultsWrap.style.display = "";

    var systemAvgs = (result.tpiResult && result.tpiResult.__restoredSystemAverages)
      ? result.tpiResult.__restoredSystemAverages
      : computeSystemFactorAverages(result.tpiResult);
    var effWeights = (result.tpiResult && result.tpiResult.effectiveWeights) || result.weights || _weights;

    var html = '<table class="cs-results-table">' +
      '<thead><tr>' +
        '<th class="cs-col-rank">#</th>' +
        '<th class="cs-col-name">Corridor</th>' +
        '<th class="cs-col-score">Score</th>' +
        '<th class="cs-col-class">Classification</th>' +
        '<th class="cs-col-toggle" aria-label="Expand"></th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var rank = i + 1;
      var pill = pillClassFor(r.classification);
      html +=
        '<tr class="cs-row" data-index="' + i + '">' +
          '<td class="cs-rank">' + rank + '</td>' +
          '<td class="cs-name">' + escapeHTML(r.name) +
            ' <span class="cs-feature-badge">' + (r.featureType === "line" ? "L" : "R") + '</span></td>' +
          '<td class="cs-score">' + formatScore(r.cdi) + '</td>' +
          '<td class="cs-class"><span class="' + pill + '">' + escapeHTML(r.classification || "N/A") + '</span></td>' +
          '<td class="cs-toggle"><span class="cs-caret">&#9656;</span></td>' +
        '</tr>' +
        '<tr class="cs-row-details" data-index="' + i + '" style="display:none;">' +
          '<td colspan="5">' +
            '<div class="cs-details-body">' +
              buildFactorBreakdownHTML(r, systemAvgs, effWeights) +
            '</div>' +
          '</td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Wire row click → toggle details
    var rowEls = container.querySelectorAll("tr.cs-row");
    rowEls.forEach(function (rowEl) {
      rowEl.addEventListener("click", function () {
        var idx = rowEl.getAttribute("data-index");
        var details = container.querySelector('tr.cs-row-details[data-index="' + idx + '"]');
        if (!details) return;
        var open = details.style.display !== "none";
        details.style.display = open ? "none" : "";
        rowEl.classList.toggle("cs-row-open", !open);
      });
    });
  }

  // ---- Scoring flow ----

  async function runScoring() {
    if (_running) return;
    var RM = window.RidershipModel;
    if (!RM || typeof RM.computeSystemDemand !== "function") {
      setStatus("RidershipModel not available.", "stale");
      return;
    }

    // Everything the user ticked is hidden on the map (toggle off): say so.
    if (!getFeatureFilter().routeIndices.length && !getFeatureFilter().lineIndices.length &&
        document.querySelectorAll("#csFeatureList input[type=checkbox]:checked:disabled").length > 0) {
      setStatus(App.hiddenSelectionMessage(0).error, "error");
      return;
    }

    _running = true;
    var scoreBtn = document.getElementById("csScoreBtn");
    if (scoreBtn) scoreBtn.disabled = true;
    setStatus("Scoring…", "running");
    clearMapChoropleth(); // wipe any prior run so selection changes are visible

    try {
      var geoLevel = document.getElementById("csGeoLevel").value;
      var year     = document.getElementById("csYearSelect").value;
      _bufferMiles  = App.readAnalysisBufferMiles("csBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
      _useDisplayBuffers = !!(document.getElementById("csUseDisplayBuffers") || {}).checked;

      var featureFilter = getFeatureFilter();
      var featureRefs   = getCheckedRefs();

      var unionPolygon  = buildUnionFromFilter(featureFilter);
      var hiddenCount   = (_lastBufferSet && _lastBufferSet.hiddenCount) || { included: 0, skipped: 0 };

      if (!_lastBufferSet || _lastBufferSet.count === 0) {
        if (hiddenCount.skipped > 0) throw new Error(App.hiddenSelectionMessage(hiddenCount).error);
        throw new Error("Could not build buffers for the selected corridors.");
      }
      if (!unionPolygon) {
        throw new Error("No corridors selected. Check at least one route or line.");
      }

      var result = await RM.computeSystemDemand({
        geoLevel:        geoLevel,
        year:            year,
        weights:         _weights,
        lodesData:       App.lodesData,
        apportionByArea: _apportionByArea,
        unionPolygon:    unionPolygon,
        featureFilter:   featureFilter,
        bufferSet:       _lastBufferSet,
        onProgress: function (msg) { setStatus(msg, "running"); }
      });

      // Sort ranked corridors by CDI descending
      var ranked = (result.routeCDIs || []).slice().sort(function (a, b) {
        var av = Number.isFinite(a.cdi) ? a.cdi : -Infinity;
        var bv = Number.isFinite(b.cdi) ? b.cdi : -Infinity;
        return bv - av;
      });

      _lastResult = {
        routeCDIs:       ranked,
        tpiResult:       result.tpiResult,
        systemCDI:       result.systemCDI,
        geoLevel:        geoLevel,
        year:            year,
        apportionByArea: _apportionByArea,
        bufferMiles:     _bufferMiles,
        unionPolygon:    unionPolygon,
        featureRefs:     featureRefs,
        hiddenIncluded:  hiddenCount.included || 0,
        weights:         Object.assign({}, _weights)
      };
      _runSnap = { refs: featureRefs, hidden: App.hiddenSignature(featureRefs), includeHidden: _includeHidden };
      _stale = false;

      var geoCount = (result.tpiResult && result.tpiResult.geos) ? result.tpiResult.geos.length : 0;
      setStatus("Scored " + ranked.length + " corridor" + (ranked.length === 1 ? "" : "s") +
                " — " + geoCount + " geographies.", "done");

      renderResultsTable(_lastResult);
      renderInputs(true);
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      renderMapChoropleth(_lastResult);
      if (App.popup && App.popup.showFloatingWidget) {
        showCsLegend();
      }
      setExportButtonsEnabled(true);
    } catch (err) {
      console.error("Corridor Scoring error:", err);
      setStatus("Error: " + (err.message || err), "error");
    } finally {
      _running = false;
      if (scoreBtn) scoreBtn.disabled = false;
    }
  }

  // ---- Popup lifecycle ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    // Geography level change
    var geoLevel = document.getElementById("csGeoLevel");
    if (geoLevel) geoLevel.addEventListener("change", markStale);

    // ACS year change
    var yearSel = document.getElementById("csYearSelect");
    if (yearSel) yearSel.addEventListener("change", markStale);

    // Apportion-by-area checkbox
    var apportionCb = document.getElementById("csApportionByArea");
    if (apportionCb) {
      apportionCb.checked = _apportionByArea;
      apportionCb.addEventListener("change", function () {
        _apportionByArea = apportionCb.checked;
        markStale();
      });
    }

    // Buffer distance (mi) — module-owned analysis distance, independent of
    // the Feature Settings global buffer radius.
    var bufferMilesEl = document.getElementById("csBufferMiles");
    if (bufferMilesEl) {
      bufferMilesEl.value = String(_bufferMiles);
      bufferMilesEl.addEventListener("change", markStale);
    }
    var displayBuffersEl = document.getElementById("csUseDisplayBuffers");
    if (displayBuffersEl) displayBuffersEl.addEventListener("change", function () {
      _useDisplayBuffers = displayBuffersEl.checked;
      syncBufferControl();
      markStale();
    });
    syncBufferControl();

    // Include hidden toggle (next to Select all | Clear)
    var actionsEl = (document.getElementById("csSelectAll") || {}).parentNode;
    if (actionsEl && !document.getElementById("csIncludeHidden")) {
      actionsEl.appendChild(App.buildIncludeHiddenToggle({
        id: "csIncludeHidden", checked: _includeHidden,
        onChange: function (on) {
          _includeHidden = on;
          buildFeatureChecklist();           // re-decorate rows; checked states untouched
          if (App.cache) App.cache.save();
          if (_lastResult && runIsOutdated()) markStale(); else renderInputs();
        }
      }));
    }

    // Select all / clear
    var selectAll = document.getElementById("csSelectAll");
    if (selectAll) {
      selectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#csFeatureList input[type=checkbox]").forEach(function (cb) { if (!cb.disabled) cb.checked = true; });
        captureChecklistSelection();
        markStale();
      });
    }
    var selectNone = document.getElementById("csSelectNone");
    if (selectNone) {
      selectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#csFeatureList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        captureChecklistSelection();
        markStale();
      });
    }

    // Adjust Weights modal
    var weightsBtn = document.getElementById("csWeightsBtn");
    if (weightsBtn) weightsBtn.addEventListener("click", openWeightsModal);

    var confirmBtn = document.getElementById("csWeightsConfirm");
    if (confirmBtn) confirmBtn.addEventListener("click", function () { closeWeightsModal(true); });

    var cancelBtn = document.getElementById("csWeightsCancel");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { closeWeightsModal(false); });

    var resetBtn = document.getElementById("csResetWeights");
    if (resetBtn) resetBtn.addEventListener("click", resetModalToDefaults);

    // Score Corridors
    var scoreBtn = document.getElementById("csScoreBtn");
    if (scoreBtn) scoreBtn.addEventListener("click", runScoring);

    // Shared census-cache status line + Re-fetch
    if (scoreBtn && typeof App.buildCensusCacheStatus === "function") {
      var ccStatus = App.buildCensusCacheStatus({
        geoSel: document.getElementById("csGeoLevel"),
        yearSel: document.getElementById("csYearSelect"),
        onRefetch: function () { scoreBtn.click(); }
      });
      scoreBtn.parentNode.insertBefore(ccStatus, scoreBtn);
    }

    // Exports
    var csvBtn = document.getElementById("csExportCSV");
    if (csvBtn) csvBtn.addEventListener("click", exportCSV);
    var gjBtn = document.getElementById("csExportGeoJSON");
    if (gjBtn) gjBtn.addEventListener("click", exportGeoJSON);

    // Hide Route Coloring toggle
    var hideCb = document.getElementById("csHideRouteColoring");
    if (hideCb) {
      hideCb.addEventListener("change", function () {
        var vis = hideCb.checked ? "none" : "visible";
        var map = App.map;
        if (map.getLayer(CS_LINE_LAYER)) map.setLayoutProperty(CS_LINE_LAYER, "visibility", vis);
        if (hideCb.checked) {
          if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("cs-legend");
        } else {
          if (App.popup && App.popup.showFloatingWidget) {
            showCsLegend();
          }
        }
      });
    }

    // Populate weight sliders (in modal) with current _weights
    buildWeightSliders();
    renderInputs(_lastResult ? undefined : false);
  }

  function onOpen(core) {
    document.querySelectorAll(".cc-status").forEach(function (s) { if (s.refresh) s.refresh(); });
    var apportionCb = document.getElementById("csApportionByArea");
    if (apportionCb) apportionCb.checked = _apportionByArea;
    var bufferMilesEl = document.getElementById("csBufferMiles");
    if (bufferMilesEl) bufferMilesEl.value = String(_bufferMiles);
    syncBufferControl();
    var ihEl = document.getElementById("csIncludeHidden");
    if (ihEl) ihEl.checked = _includeHidden;

    buildFeatureChecklist();
    renderInputs(false);
    updateLodesWarnings();

    if (_lastResult) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      renderResultsTable(_lastResult);
      setExportButtonsEnabled(!_stale);
      var hideCb = document.getElementById("csHideRouteColoring");
      if (hideCb) {
        var vis = (App.map.getLayer(CS_LINE_LAYER) && App.map.getLayoutProperty(CS_LINE_LAYER, "visibility")) || "visible";
        hideCb.checked = (vis === "none");
      }
    } else {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      setExportButtonsEnabled(false);
      App.renderModuleState({
        statusEl: "csStatus", emptyEl: "csEmptyState", empty: true, hint: emptyHint()
      });
    }
    if (_stale) markStale();
  }

  function onClose(core) {
    // State persists in closure
  }

  function clearAll() {
    clearMapChoropleth();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("cs-legend");
    _lastResult = null;
    _runSnap = null;
    _stale = false;
    if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      renderInputs(false);
      var resultsEl = document.getElementById("csResults");
      if (resultsEl) resultsEl.style.display = "none";
      App.renderModuleState({
        statusEl: "csStatus", emptyEl: "csEmptyState", empty: true, hint: emptyHint()
      });
      setExportButtonsEnabled(false);
      var hideCb = document.getElementById("csHideRouteColoring");
      if (hideCb) hideCb.checked = false;
    }
  }

  async function update(core) {
    // If all drawn routes and lines are gone, tear down any choropleth and results.
    // This handles the Clear button and individual feature deletions alike.
    if (_lastResult && (App.routes || []).length === 0 && (App.lines || []).length === 0) {
      clearAll();
    }
    // notifyProject also fires on every hide/show: go stale only when the run's
    // hidden-state inputs really changed (see runIsOutdated()).
    if (_lastResult && !_stale && runIsOutdated()) markStale();
    // Guard all DOM writes — update fires even when the popup is closed.
    if (!isPopupVisible()) return;
    buildFeatureChecklist();
    renderInputs();
    updateLodesWarnings();
  }

  // ---- Session persistence ----

  function saveCsState(mode) {
    // Schema v2: checklist + last-run selection by stable feature ID (v1 = array
    // indices, migrated in restoreCsState). _uncheckedRefs is kept current by the
    // checkbox handlers, so it is the live state even while the popup is open.
    var data = {
      version:         2,
      weights:         Object.assign({}, _weights),
      apportionByArea: _apportionByArea,
      bufferMiles:     _bufferMiles,
      useDisplayBuffers: _useDisplayBuffers,
      includeHidden:   _includeHidden,   // additive, no schema bump
      uncheckedFeatures: _uncheckedRefs.filter(function (r) { return App.resolveFeatureRef(r) >= 0; }),
      geoLevel:        null,
      year:            null,
      lastSummary:     null,
      full:            null
    };
    var geoLevelEl = document.getElementById("csGeoLevel");
    var yearEl     = document.getElementById("csYearSelect");
    if (geoLevelEl) data.geoLevel = geoLevelEl.value;
    if (yearEl)     data.year     = yearEl.value;

    if (_lastResult) {
      data.lastSummary = {
        geoLevel:        _lastResult.geoLevel,
        year:            _lastResult.year,
        apportionByArea: _lastResult.apportionByArea,
        bufferMiles:     _lastResult.bufferMiles,
        weights:         Object.assign({}, _lastResult.weights || {}),
        featureRefs:     (_lastResult.featureRefs || []).slice(),
        hiddenIncluded:  _lastResult.hiddenIncluded || 0,
        routeCDIs:       (_lastResult.routeCDIs || []).map(function (r) {
          return {
            name:            r.name,
            featureType:     r.featureType,
            featureId:       r.featureId,
            cdi:             r.cdi,
            classification:  r.classification,
            geoCount:        r.geoCount,
            lengthMiles:     r.lengthMiles,
            factorBreakdown: r.factorBreakdown || {},
            compositeRange:  r.compositeRange || null
          };
        })
      };

      // Full mode: include system factor averages so the comparison
      // bars in factor breakdowns restore correctly after a file import.
      if (mode === "full" && _lastResult.tpiResult) {
        data.full = {
          systemFactorAverages: computeSystemFactorAverages(_lastResult.tpiResult),
          effectiveWeights:     _lastResult.tpiResult.effectiveWeights || null
        };
      }
    }
    return data;
  }

  function restoreCsState(data) {
    if (!data) return;
    if (data.weights)          _weights         = Object.assign({}, data.weights);
    if (data.apportionByArea != null) _apportionByArea = !!data.apportionByArea;
    if (data.bufferMiles != null) _bufferMiles = data.bufferMiles;
    if (data.useDisplayBuffers != null) _useDisplayBuffers = !!data.useDisplayBuffers;
    if (typeof data.includeHidden === "boolean") _includeHidden = data.includeHidden;
    var ihRestoreEl = document.getElementById("csIncludeHidden");
    if (ihRestoreEl) ihRestoreEl.checked = _includeHidden;

    // v1 sessions saved array indices (checked-filter + per-row featureIndex).
    // Features are restored in saved order and given IDs before module hooks run,
    // so an old index still names the right feature RIGHT NOW — convert to IDs here.
    var legacy = !(data.version >= 2);
    if (legacy) {
      _uncheckedRefs = data.featureFilter
        ? App.uncheckedRefsFromIndexFilter(data.featureFilter, ["route", "line"]) : [];
    } else {
      _uncheckedRefs = Array.isArray(data.uncheckedFeatures) ? data.uncheckedFeatures.filter(function (r) {
        return r && App.featureRefKey(r);
      }) : [];
    }
    if (document.getElementById("csFeatureList")) buildFeatureChecklist();

    var geoLevelEl = document.getElementById("csGeoLevel");
    var yearEl     = document.getElementById("csYearSelect");
    var bufferMilesEl = document.getElementById("csBufferMiles");
    if (geoLevelEl && data.geoLevel) geoLevelEl.value = data.geoLevel;
    if (yearEl     && data.year)     yearEl.value     = data.year;
    if (bufferMilesEl) bufferMilesEl.value = String(_bufferMiles);
    syncBufferControl();

    if (!data.lastSummary) return;
    var s = data.lastSummary;
    // Re-synthesize enough of _lastResult for the table and map layers.
    var fakeTpi = null;
    if (data.full && data.full.effectiveWeights) {
      fakeTpi = { effectiveWeights: data.full.effectiveWeights };
      if (data.full.systemFactorAverages) {
        // Store pre-computed system averages so renderResultsTable can use them
        // without re-deriving from a (missing) factorScores Map.
        fakeTpi.__restoredSystemAverages = data.full.systemFactorAverages;
      }
    }
    var missing = false;
    var restoredRows = (s.routeCDIs || []).map(function (r) {
      var row = Object.assign({}, r);
      if (legacy || !row.featureId) {
        var ref = App.featureRef(row.featureType, row.featureIndex);
        row.featureId = ref ? ref.id : null;
      }
      delete row.featureIndex;
      if (App.resolveFeatureRef({ type: row.featureType, id: row.featureId }) < 0) missing = true;
      return row;
    });
    _lastResult = {
      routeCDIs:       restoredRows,
      tpiResult:       fakeTpi,
      systemCDI:       null,
      geoLevel:        s.geoLevel,
      year:            s.year,
      apportionByArea: s.apportionByArea,
      bufferMiles:     s.bufferMiles != null ? s.bufferMiles : App.ANALYSIS_BUFFER_DEFAULT_MILES,
      unionPolygon:    null,
      featureRefs:     legacy ? App.indexFilterToRefs(s.featureFilter) : (s.featureRefs || []),
      hiddenIncluded:  s.hiddenIncluded || 0,
      weights:         Object.assign({}, s.weights || _weights)
    };
    _runSnap = { refs: _lastResult.featureRefs, hidden: App.hiddenSignature(_lastResult.featureRefs), includeHidden: _includeHidden };
    // A scored corridor whose feature was deleted since the save can't be drawn or
    // exported: show what survives, flagged stale so the user re-scores.
    _stale = missing;

    // Render table + map immediately (popup may or may not be open).
    if (isPopupVisible()) {
      renderResultsTable(_lastResult);
      setExportButtonsEnabled(!_stale);
      if (_stale) markStale();
    }
    renderMapChoropleth(_lastResult);
    if (App.popup && App.popup.showFloatingWidget) {
      showCsLegend();
    }
  }

  // ---- Register as analysis module ----

  // ---- Feature usage (Split / Merge dialogs) ----
  if (typeof App.registerFeatureUsage === "function") {
    App.registerFeatureUsage(function (type, id) {
      var rows = (_lastResult && _lastResult.routeCDIs) || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].featureType === type && rows[i].featureId === id) {
          return ["Corridor Scoring · ranked in the last results (they will show as stale)"];
        }
      }
      return [];
    }, { module: "Corridor Scoring", severity: "info" });
  }

  App.registerModule({
    id:         "corridor-scoring",
    name:       "Corridor Scoring",
    enabled:    true,
    popupWidth: 1000,
    // One width for both modes, under the 620px @container breakpoint — narrow,
    // stacked task panel in every state, never resizes on run (see the fuller
    // note in buffer-summary.js). 600 gives the ranked results table the most
    // room available without un-stacking.
    panelWidths: { setup: 600, results: 600 },
    popupHTML:  "projects/corridor-scoring-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  async function (core) { await update(core); }
  });

  // Register with session cache
  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("corridor-scoring", {
      collect: saveCsState,
      apply:   restoreCsState
    });
  }

})();
