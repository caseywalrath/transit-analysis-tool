// js/projects/transit-propensity.js
// Transit Propensity Index: registers as an analysis module, opens in a 2-column popup,
// renders choropleth + floating legend.
// Depends on: App namespace, TPI namespace (tpi-scoring.js), App.popup (popup.js), turf (CDN).
// Exports: App.getTpiWeights()

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var TPI = window.TPI;

  // ---- Project-local state (persists across popup open/close) ----

  var _lastResult = null;
  var _weights = TPI.getDefaultWeights();
  var _pendingWeights = null;     // temporary copy while Adjust Weights modal is open
  var _tpiFeatureFilter = null;   // { routeIndices, lineIndices, pointIndices, polygonIndices } or null (= all)
  var _selectedCorridor = "all";  // "all" | "route:N" | "line:N" | "point:N" | "polygon:N"
  var _stale = false;
  var _running = false;
  var _rescoreTimer = null;
  var _initialized = false;
  var _apportionByArea = false;
  var _bufferMiles = App.ANALYSIS_BUFFER_DEFAULT_MILES;
  var _useDisplayBuffers = false;

  function getTpiClass(score) {
    if (!Number.isFinite(score)) return "N/A";
    if (score < 2) return "Low";
    if (score < 3) return "Medium-Low";
    if (score < 4) return "Medium";
    if (score < 5) return "Medium-High";
    return "High";
  }

  // ---- DOM guard: only touch DOM when popup is open for this module ----

  function isPopupVisible() {
    return App.popup.isOpen() && App.popup.currentModuleId() === "transit-propensity";
  }

  // ---- Feature filter & union polygon helpers ----

  // Set by buildUnionFromFilter(), consumed immediately by runTPI() and
  // stashed on the result so getGeosInCorridor() can re-filter without a
  // re-run — gives access to the full buffer set (and its .count) without
  // changing buildUnionFromFilter's return type (still just the union polygon).
  var _lastBufferSet = null;

  function buildUnionFromFilter(filter) {
    var set = _useDisplayBuffers
      ? App.buildDisplayBufferSet(filter)
      : App.buildAnalysisBufferSet(filter, _bufferMiles);
    _lastBufferSet = set;
    return set.union;
  }

  function getFeatureFilter() {
    var el = document.getElementById("tpiFeatureChecklist");
    var routeIndices = [], lineIndices = [], pointIndices = [], polygonIndices = [];
    if (!el) {
      return { routeIndices: routeIndices, lineIndices: lineIndices,
               pointIndices: pointIndices, polygonIndices: polygonIndices };
    }
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      var type = cb.getAttribute("data-type");
      var idx  = parseInt(cb.getAttribute("data-idx"), 10);
      if (cb.checked) {
        if      (type === "route")   routeIndices.push(idx);
        else if (type === "line")    lineIndices.push(idx);
        else if (type === "point")   pointIndices.push(idx);
        else if (type === "polygon") polygonIndices.push(idx);
      }
    }
    return { routeIndices: routeIndices, lineIndices: lineIndices,
             pointIndices: pointIndices, polygonIndices: polygonIndices };
  }

  // ---- Feature checklist ----

  function buildFeatureChecklist() {
    var el = document.getElementById("tpiFeatureChecklist");
    if (!el) return;

    // Capture current check state before rebuilding
    var prevState = {};
    var prev = el.querySelectorAll("input[type=checkbox]");
    for (var pi = 0; pi < prev.length; pi++) {
      prevState[prev[pi].getAttribute("data-type") + ":" + prev[pi].getAttribute("data-idx")] = prev[pi].checked;
    }

    el.innerHTML = "";
    var hasFeatures = false;

    function addRow(type, idx, name, badge) {
      hasFeatures = true;
      var key = type + ":" + idx;
      var checked = (key in prevState) ? prevState[key] : true;
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", type);
      cb.setAttribute("data-idx", String(idx));
      cb.checked = checked;

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = name;

      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = badge;

      lbl.addEventListener("click", function (e) { e.preventDefault(); cb.checked = !cb.checked; markStale(); });
      cb.addEventListener("change", markStale);

      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(badgeEl);
      el.appendChild(row);
    }

    var routes   = App.routes   || [];
    var lines    = App.lines    || [];
    var pts      = App.points   || [];
    var polys    = App.polygons || [];

    for (var ri = 0; ri < routes.length; ri++) addRow("route",   ri, (routes[ri].properties && routes[ri].properties.name) || ("Route "   + (ri + 1)), "R");
    for (var li = 0; li < lines.length;  li++) addRow("line",    li, (lines[li].properties  && lines[li].properties.name)  || ("Line "    + (li + 1)), "L");
    for (var si = 0; si < pts.length;    si++) addRow("point",   si, (pts[si].properties    && pts[si].properties.name)    || ("Point " + (si + 1)), "S");
    for (var gi = 0; gi < polys.length;  gi++) addRow("polygon", gi, (polys[gi].properties  && polys[gi].properties.name)  || ("Polygon " + (gi + 1)), "P");

    if (!hasFeatures) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No features drawn.</div>';
    }

    buildCorridorDropdown();
  }

  // ---- Corridor dropdown ----

  function buildCorridorDropdown() {
    var sel = document.getElementById("tpiCorridorSelect");
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '<option value="all">All features (system-wide)</option>';

    var routes   = App.routes   || [];
    var lines    = App.lines    || [];
    var pts      = App.points   || [];
    var polys    = App.polygons || [];
    var opt;

    for (var ri = 0; ri < routes.length; ri++) {
      opt = document.createElement("option");
      opt.value = "route:" + ri;
      opt.textContent = (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1));
      sel.appendChild(opt);
    }
    for (var li = 0; li < lines.length; li++) {
      opt = document.createElement("option");
      opt.value = "line:" + li;
      opt.textContent = (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1));
      sel.appendChild(opt);
    }
    for (var si = 0; si < pts.length; si++) {
      opt = document.createElement("option");
      opt.value = "point:" + si;
      opt.textContent = (pts[si].properties && pts[si].properties.name) || ("Point " + (si + 1));
      sel.appendChild(opt);
    }
    for (var gi = 0; gi < polys.length; gi++) {
      opt = document.createElement("option");
      opt.value = "polygon:" + gi;
      opt.textContent = (polys[gi].properties && polys[gi].properties.name) || ("Polygon " + (gi + 1));
      sel.appendChild(opt);
    }

    // Restore previous selection if still valid
    if (prev && sel.querySelector('option[value="' + prev + '"]')) {
      sel.value = prev;
    } else {
      _selectedCorridor = "all";
      sel.value = "all";
    }
  }

  // ---- Filter geos to selected corridor ----

  function getGeosInCorridor(result, corridor) {
    if (!corridor || corridor === "all") return result.geos;
    var parts = corridor.split(":");
    var type  = parts[0];
    var idx   = parseInt(parts[1], 10);
    var bufferPoly = (result && result.bufferSet) ? result.bufferSet.get(type, idx) : null;
    if (!bufferPoly) return result.geos;
    return result.geos.filter(function (geo) {
      try { return turf.booleanIntersects(geo, bufferPoly); } catch (e) { return false; }
    });
  }

  // ---- Geography list display ----

  function displayGeographyList(result, corridor) {
    if (!isPopupVisible()) return;

    var resultsEl = document.getElementById("tpiResults");
    var emptyEl   = document.getElementById("tpiEmptyState");
    if (resultsEl) resultsEl.style.display = "";
    if (emptyEl)   emptyEl.style.display   = "none";

    // Update corridor label
    var labelEl = document.getElementById("tpiCorridorLabel");
    if (labelEl) {
      if (!corridor || corridor === "all") {
        labelEl.textContent = "";
      } else {
        var sel = document.getElementById("tpiCorridorSelect");
        if (sel) {
          var opt = sel.querySelector('option[value="' + corridor + '"]');
          labelEl.textContent = opt ? "\u2014 " + opt.textContent : "";
        }
      }
    }

    var filteredGeos = getGeosInCorridor(result, corridor);
    var listEl = document.getElementById("tpiGeoList");
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!filteredGeos.length) {
      listEl.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px;">No geographies found in selected corridor.</div>';
      updateSummaryStats(result, []);
      return;
    }

    // Sort by composite TPI descending
    var sorted = filteredGeos.slice().sort(function (a, b) {
      var sa = result.scores.get(a.properties && a.properties.GEOID);
      var sb = result.scores.get(b.properties && b.properties.GEOID);
      var ca = (sa && Number.isFinite(sa.composite)) ? sa.composite : -1;
      var cb2 = (sb && Number.isFinite(sb.composite)) ? sb.composite : -1;
      return cb2 - ca;
    });

    // Active factors (non-zero effective weight)
    var activeFactors = TPI.FACTORS.filter(function (f) {
      return (result.effectiveWeights[f.id] || 0) > 0;
    });

    sorted.forEach(function (geo) {
      var geoid      = geo.properties && geo.properties.GEOID;
      if (!geoid) return;
      var scoreEntry = result.scores.get(geoid);
      var composite  = (scoreEntry && Number.isFinite(scoreEntry.composite)) ? scoreEntry.composite : null;
      var hasScore   = composite !== null;

      // Main row
      var row = document.createElement("div");
      row.className = "rf-route-score-row";

      var expandEl = document.createElement("span");
      expandEl.className = "rf-route-score-expand";
      expandEl.textContent = "\u25b6";

      var nameEl = document.createElement("span");
      nameEl.className = "rf-route-score-name";
      nameEl.textContent = geoid;

      var scoreEl = document.createElement("span");
      scoreEl.className = "rf-route-score-cdi";
      scoreEl.textContent = hasScore ? composite.toFixed(2) : "\u2014";

      var scaleEl = document.createElement("span");
      scaleEl.style.cssText = "font-size:10px;color:var(--muted);margin-left:2px;";
      scaleEl.textContent = "/ 5";

      row.appendChild(expandEl);
      row.appendChild(nameEl);
      row.appendChild(scoreEl);
      row.appendChild(scaleEl);

      // Detail panel
      var detail = document.createElement("div");
      detail.className = "rf-route-score-detail";
      detail.style.display = "none";

      if (hasScore && activeFactors.length) {
        var factorList = document.createElement("div");
        factorList.className = "rf-route-factor-list";

        activeFactors.forEach(function (f) {
          var fScore  = scoreEntry.factors[f.id];
          var hasF    = (fScore != null && Number.isFinite(fScore));
          var barPct  = hasF ? Math.round((fScore - 1) / 4 * 100) : 0;
          var barColor = hasF
            ? (fScore >= 4 ? "#68d391" : fScore >= 3 ? "#63b3ed" : "#fc8181")
            : "#e2e8f0";
          var ew = result.effectiveWeights[f.id] || 0;

          var fr = document.createElement("div");
          fr.className = "rf-route-factor-row";
          fr.innerHTML =
            '<span class="rf-route-factor-name">' + f.label + '</span>' +
            '<span class="rf-route-factor-weight">' + Math.round(ew) + '%</span>' +
            '<div class="rf-route-factor-bar-wrap">' +
              '<div class="rf-route-factor-bar" style="width:' + barPct + '%;background:' + barColor + ';"></div>' +
            '</div>' +
            '<span class="rf-route-factor-score">' + (hasF ? fScore.toFixed(1) : "\u2014") + '</span>';
          factorList.appendChild(fr);
        });
        detail.appendChild(factorList);
      } else {
        detail.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px;">No factor data available.</div>';
      }

      row.addEventListener("click", function () {
        var expanded = detail.style.display !== "none";
        detail.style.display = expanded ? "none" : "";
        expandEl.textContent  = expanded ? "\u25b6" : "\u25bc";
      });

      listEl.appendChild(row);
      listEl.appendChild(detail);
    });

    updateSummaryStats(result, filteredGeos);
    updateFootnotes(result);
    updateExportButtons(true);
  }

  function updateSummaryStats(result, filteredGeos) {
    var scores = filteredGeos.map(function (g) {
      var e = result.scores.get(g.properties && g.properties.GEOID);
      return (e && Number.isFinite(e.composite)) ? e.composite : null;
    }).filter(function (s) { return s !== null; });

    var avg = scores.length
      ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length
      : null;

    var scoreEl = document.getElementById("tpiCorridorScore");
    if (scoreEl) scoreEl.textContent = avg !== null ? avg.toFixed(2) + " / 5" : "\u2014";

    var countEl = document.getElementById("tpiScoredCount");
    if (countEl) countEl.textContent = scores.length + " / " + filteredGeos.length;
  }

  function updateFootnotes(result) {
    var fallbackEl = document.getElementById("tpiFallbackNote");
    if (fallbackEl) {
      var fallbacks = result.tractFallbackFactors || [];
      if (fallbacks.length && !result.apportionByArea) {
        fallbackEl.textContent = "\u2020 Some factors only available at tract level; values applied to all block groups within each tract.";
        fallbackEl.style.display = "";
      } else {
        fallbackEl.style.display = "none";
      }
    }
    var apportionEl = document.getElementById("tpiApportionNote");
    if (apportionEl) {
      if (result.apportionByArea) {
        apportionEl.textContent = "Area apportionment active: values scaled by buffer overlap fraction.";
        apportionEl.style.display = "";
      } else {
        apportionEl.style.display = "none";
      }
    }
  }

  function updateExportButtons(enabled) {
    var gjBtn  = document.getElementById("tpiExportGeoJSON");
    var csvBtn = document.getElementById("tpiExportCSV");
    if (gjBtn)  gjBtn.disabled  = !enabled;
    if (csvBtn) csvBtn.disabled = !enabled;
  }

  // ---- Status + stale indicator (shared module-state UI) ----

  function setTpiStatus(msg, kind) {
    App.renderModuleState({
      statusEl: "tpiStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  // Context-aware onboarding/empty hint shown when there are no results.
  function emptyHint() {
    var n = (App.points || []).length + (App.routes || []).length + (App.lines || []).length;
    if (!n) {
      return { need: "Draw a point, route, or line to begin.",
               action: "Then set a buffer radius and click Analyze System." };
    }
    return { need: "Select features and click Analyze System.",
             action: "Selected features define the normalization pool for scoring." };
  }

  function syncBufferControl() {
    var input = document.getElementById("tpiBufferMiles");
    var toggle = document.getElementById("tpiUseDisplayBuffers");
    if (input) {
      input.value = String(_bufferMiles);
      input.disabled = _useDisplayBuffers;
    }
    if (toggle) toggle.checked = _useDisplayBuffers;
  }

  // ---- Collapsible inputs (shared helper) ----

  function inputsSummary() {
    var geoEl = document.getElementById("tpiGeoLevel");
    var yearEl = document.getElementById("tpiYearSelect");
    var bufferEl = document.getElementById("tpiBufferMiles");
    var corridorEl = document.getElementById("tpiCorridorSelect");
    var count = document.querySelectorAll("#tpiFeatureChecklist input[type=checkbox]:checked").length;
    var geoLabel = geoEl && geoEl.value === "tract" ? "Tracts" : "Block groups";
    var corridorLabel = corridorEl && corridorEl.selectedOptions.length
      ? corridorEl.selectedOptions[0].textContent : "All features";
    return geoLabel + " \u00b7 " + (yearEl ? yearEl.value : "") + " \u00b7 " +
      (bufferEl ? bufferEl.value : _bufferMiles) + " mi \u00b7 " +
      count + " feature" + (count === 1 ? "" : "s") + " \u00b7 " + corridorLabel;
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".tpi-body .rf-settings-col"),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastResult ? "results" : "setup", true);
      }
    });
  }

  function markStale() {
    renderInputs();
    if (!_lastResult) return;
    _stale = true;
    if (!isPopupVisible()) return;
    App.renderModuleState({ statusEl: "tpiStatus", stale: true, onRerun: function () { runTPI(); } });
  }

  // ---- Weight sliders (live inside modal) ----

  function buildWeightSliders() {
    var container = document.getElementById("tpiWeightSliders");
    if (!container) return;
    container.innerHTML = "";

    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (_weights[f.id] != null) ? _weights[f.id] : (f.defaultWeight || 0);

      var row = document.createElement("div");
      row.className = "tpi-slider-row";
      row.innerHTML =
        '<label class="tpi-slider-label" title="' + f.description + '">' + f.label + '</label>' +
        '<input type="range" class="tpi-slider" min="0" max="100" step="5" value="' + w + '" data-factor="' + f.id + '">' +
        '<input type="number" class="tpi-slider-value" id="tpiW_' + f.id + '" value="' + w + '" min="0" max="100" step="1" data-factor="' + f.id + '">';
      container.appendChild(row);

      var slider   = row.querySelector("input[type=range]");
      var numInput = row.querySelector("input[type=number]");
      slider.addEventListener("input",  onModalSliderChange);
      numInput.addEventListener("change", onModalNumberChange);
    }
    updateModalWeightSum();
  }

  function syncSlidersToWeights(weights) {
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (weights[f.id] != null) ? weights[f.id] : 0;
      var slider   = document.querySelector('.tpi-slider[data-factor="' + f.id + '"]');
      var numInput = document.getElementById("tpiW_" + f.id);
      if (slider)   slider.value   = String(w);
      if (numInput) numInput.value = String(w);
    }
    updateModalWeightSum();
  }

  function onModalSliderChange(e) {
    if (!_pendingWeights) return;
    var factorId = e.target.getAttribute("data-factor");
    _pendingWeights[factorId] = parseInt(e.target.value, 10);
    var numInput = document.getElementById("tpiW_" + factorId);
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
    var slider = document.querySelector('.tpi-slider[data-factor="' + factorId + '"]');
    if (slider) slider.value = String(clamped);
    updateModalWeightSum();
  }

  function updateModalWeightSum() {
    var weights = _pendingWeights || _weights;
    var sum = 0;
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) sum += (weights[factors[i].id] || 0);

    var sumEl      = document.getElementById("tpiWeightSum");
    var warnEl     = document.getElementById("tpiWeightWarn");
    var confirmBtn = document.getElementById("tpiWeightsConfirm");
    if (sumEl)      { sumEl.textContent = String(sum); sumEl.style.color = sum === 100 ? "" : "#e53e3e"; }
    if (warnEl)     warnEl.style.visibility = sum === 100 ? "hidden" : "visible";
    if (confirmBtn) confirmBtn.disabled = (sum !== 100);
    return sum;
  }

  function openWeightsModal() {
    _pendingWeights = Object.assign({}, _weights);
    syncSlidersToWeights(_pendingWeights);
    var modal = document.getElementById("tpiWeightsModal");
    if (modal) modal.style.display = "";
  }

  function closeWeightsModal(confirm) {
    var modal = document.getElementById("tpiWeightsModal");
    if (modal) modal.style.display = "none";
    if (confirm && _pendingWeights) {
      var oldJSON = JSON.stringify(_weights);
      _weights    = Object.assign({}, _pendingWeights);
      if (JSON.stringify(_weights) !== oldJSON) {
        var sum = 0;
        TPI.FACTORS.forEach(function (f) { sum += (_weights[f.id] || 0); });
        if (_lastResult && sum === 100) {
          clearTimeout(_rescoreTimer);
          _rescoreTimer = setTimeout(runInstantRescore, 300);
        } else {
          markStale();
        }
      }
    }
    _pendingWeights = null;
  }

  function resetModalToDefaults() {
    _pendingWeights = TPI.getDefaultWeights();
    syncSlidersToWeights(_pendingWeights);
  }

  // ---- Run TPI ----

  async function runTPI() {
    if (_running) return;
    _running = true;

    var runBtn   = document.getElementById("tpiRun");

    if (runBtn)   runBtn.disabled = true;
    setTpiStatus("Computing…", "running");
    var textEl = document.getElementById("tpiStatusText");

    try {
      var geoLevel = document.getElementById("tpiGeoLevel").value;
      var year     = document.getElementById("tpiYearSelect").value;
      _bufferMiles  = App.readAnalysisBufferMiles("tpiBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
      _useDisplayBuffers = !!(document.getElementById("tpiUseDisplayBuffers") || {}).checked;

      var featureFilter = getFeatureFilter();
      var unionPolygon  = buildUnionFromFilter(featureFilter);

      if (!_lastBufferSet || _lastBufferSet.count === 0) {
        throw new Error("Could not build buffers for the selected features.");
      }

      if (!unionPolygon) {
        throw new Error("No features selected. Check at least one feature in the TPI Features list.");
      }

      var result = await TPI.computeTPI({
        geoLevel:       geoLevel,
        year:           year,
        weights:        _weights,
        lodesData:      App.lodesData,
        apportionByArea: _apportionByArea,
        unionPolygon:   unionPolygon,
        growthFactors:  App.projGrowthFactors ? App.projGrowthFactors() : null,
        onProgress: function (msg) {
          if (textEl) textEl.textContent = msg;
          App.setStatus(msg);
        }
      });

      result.geoLevel    = geoLevel;
      result.year        = year;
      result.bufferMiles = _bufferMiles;
      result.bufferSet   = _lastBufferSet;
      _lastResult     = result;
      _stale          = false;

      // Render census overlay (clipped when area apportionment is on)
      App.renderCensusOverlay(result.apportionByArea && result.clippedGeos
        ? result.clippedGeos : result.geos);

      // Render choropleth + auto-show legend
      renderChoropleth(result);
      App.popup.showFloatingWidget("tpi-legend", "projects/tpi-legend.html", {
        position: "bottom-left",
        width: 160,
        title: "TPI Legend"
      });

      // Rebuild corridor dropdown (now has actual geos to pick from)
      buildCorridorDropdown();

      // Display geography list
      displayGeographyList(result, _selectedCorridor);
      renderInputs(true);
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");

      setTpiStatus("TPI computed successfully.", "done");
      App.setStatus("TPI computed");

    } catch (err) {
      console.error("TPI error:", err);
      setTpiStatus("Error: " + (err.message || err), "error");
      App.setStatus("TPI error");
    } finally {
      _running = false;
      // Re-enable run button if weights are valid
      var wsum = 0;
      TPI.FACTORS.forEach(function (f) { wsum += (_weights[f.id] || 0); });
      if (runBtn) runBtn.disabled = (wsum !== 100);
    }
  }

  function runInstantRescore() {
    if (!_lastResult) return;
    var rawToUse = (_apportionByArea && _lastResult.apportionedRawValues)
      ? _lastResult.apportionedRawValues
      : _lastResult.rawValues;
    var rescored = TPI.rescoreFromRaw(rawToUse, _weights, _lastResult.geoids);
    _lastResult.scores           = rescored.scores;
    _lastResult.factorScores     = rescored.factorScores;
    _lastResult.effectiveWeights = rescored.effectiveWeights;
    _stale = false;
    renderChoropleth(_lastResult);
    if (isPopupVisible()) {
      displayGeographyList(_lastResult, _selectedCorridor);
      setTpiStatus("Scores updated from cached data.", "done");
    }
  }

  // ---- Choropleth rendering ----

  // Still referenced by the hide-toggle wiring below — App.choropleth.render()
  // with id: "tpi" produces exactly these ids via its "<id>-choropleth-*"
  // convention (js/core/choropleth.js), so they remain valid without a
  // TPI_SOURCE constant (no longer used now that render()/remove() own the
  // source directly).
  var TPI_FILL_LAYER = "tpi-choropleth-fill";
  var TPI_LINE_LAYER = "tpi-choropleth-line";

  // Hover popup for the "tpi" choropleth (Phase 3 Step 3.2 of
  // docs/feature-area-choropleth-plan.md \u2014 migrated onto App.choropleth).
  function tpiHoverHTML(props) {
    var score  = props.tpiScore;
    var geoid2 = props.GEOID || "\u2014";

    var html = '<div style="font-size:12px;line-height:1.4;">';
    html += "<b>GEOID:</b> " + geoid2 + "<br>";
    html += "<b>TPI Score:</b> " + (score != null ? Number(score).toFixed(2) : "N/A") + " / 5";

    var factorsObj = null;
    try { factorsObj = JSON.parse(props.factors); } catch (_) {}
    if (factorsObj) {
      html += '<br><span style="color:#666;font-size:11px;">';
      var fNames      = TPI.FACTORS;
      var fallbackIds = (_lastResult && _lastResult.tractFallbackFactors) ? _lastResult.tractFallbackFactors : [];
      for (var fi = 0; fi < fNames.length; fi++) {
        var fval = factorsObj[fNames[fi].id];
        if (fval != null) {
          var isFb = fallbackIds.indexOf(fNames[fi].id) !== -1;
          html += fNames[fi].label + ": " + fval + "/5" + (isFb ? ' <span style="color:#aaa">(T)</span>' : "") + "<br>";
        }
      }
      html += "</span>";
    }
    html += "</div>";
    return html;
  }

  // Manual breaks [1,2,3,4] with the "blues" ramp reproduce the same 5 colors
  // TPI's old inline continuous interpolate used at integer scores
  // (#eff3ff/#bdd7e7/#6baed6/#3182bd/#08519c), now as discrete classes rather
  // than a gradient \u2014 the settled Phase 3 Step 3.2 tradeoff (pixel-for-pixel
  // parity with the old continuous ramp is not required). A null/non-numeric
  // tpiScore renders App.choropleth's no-data gray via its typeof guard,
  // replacing the old coalesce-to-0-then-gray hack.
  function renderChoropleth(result) {
    var map = App.map;
    if (!map || !result) return;

    var useClipped    = result.apportionByArea && result.clippedGeos;
    var clippedLookup = null;
    if (useClipped) {
      clippedLookup = {};
      for (var ci = 0; ci < result.clippedGeos.length; ci++) {
        var cg = result.clippedGeos[ci];
        if (cg.properties && cg.properties.GEOID) clippedLookup[cg.properties.GEOID] = cg.geometry;
      }
    }

    var features = [];
    for (var i = 0; i < result.geos.length; i++) {
      var geo       = result.geos[i];
      var geoid     = geo.properties && geo.properties.GEOID;
      var scoreData = geoid ? result.scores.get(geoid) : null;
      var composite = (scoreData && Number.isFinite(scoreData.composite)) ? scoreData.composite : null;
      var geom      = (clippedLookup && geoid && clippedLookup[geoid]) ? clippedLookup[geoid] : geo.geometry;

      features.push({
        type: "Feature",
        properties: {
          GEOID:    geoid,
          tpiScore: composite,
          factors:  JSON.stringify(scoreData ? scoreData.factors : {})
        },
        geometry: geom
      });
    }

    // Layer ids are load-bearing (Layers-panel manifest, ui-screens) and are
    // exactly reproduced by the "<id>-choropleth-*" convention: id: "tpi"
    // yields tpi-choropleth-fill/-line, matching TPI_FILL_LAYER/TPI_LINE_LAYER.
    App.choropleth.render({
      id: "tpi", features: features, valueProp: "tpiScore",
      breaks: [1, 2, 3, 4], ramp: "blues", fillOpacity: 0.55,
      hoverHTML: tpiHoverHTML, beforeLayer: "buffers-fill"
    });

    // Show and reset the hide-choropleth toggle after every successful render
    var toggleRow = document.getElementById("tpiChoroplethToggleRow");
    var hideCb    = document.getElementById("tpiHideChoropleth");
    if (toggleRow) toggleRow.style.display = "";
    if (hideCb)    hideCb.checked = false;
  }

  function removeChoropleth() {
    App.choropleth.remove("tpi");
  }

  function clearChoropleth() {
    removeChoropleth();
    _lastResult = null;
    _stale      = false;
    App.popup.hideFloatingWidget("tpi-legend");
    if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      renderInputs(false);
      var resultsEl = document.getElementById("tpiResults");
      if (resultsEl) resultsEl.style.display = "none";
      App.renderModuleState({
        statusEl: "tpiStatus", emptyEl: "tpiEmptyState", empty: true, hint: emptyHint()
      });
      updateExportButtons(false);
      var toggleRow = document.getElementById("tpiChoroplethToggleRow");
      if (toggleRow) toggleRow.style.display = "none";
      var hideCb = document.getElementById("tpiHideChoropleth");
      if (hideCb) hideCb.checked = false;
    }
    App.setStatus("TPI cleared");
  }

  // ---- Export helpers ----

  function _buildGeoFeatureMap(geos) {
    var allFeatures = [];
    var pts    = App.points   || [];
    var lines  = App.lines    || [];
    var routes = App.routes   || [];
    var polys  = App.polygons || [];

    // "Covered by" annotation checks every drawn feature, not just the ones
    // selected for this run — build a private buffer set (module's own
    // analysis distance) covering all of them rather than reading the
    // shared Feature Settings buffers.
    var allFilter = {
      routeIndices:   routes.map(function (_, i) { return i; }),
      lineIndices:    lines.map(function (_, i) { return i; }),
      pointIndices:   pts.map(function (_, i) { return i; }),
      polygonIndices: polys.map(function (_, i) { return i; })
    };
    var bufferSet = _useDisplayBuffers
      ? App.buildDisplayBufferSet(allFilter)
      : App.buildAnalysisBufferSet(allFilter, _bufferMiles);

    for (var si = 0; si < pts.length; si++) {
      var pb = bufferSet.get("point", si);
      if (pb) allFeatures.push({ name: (pts[si].properties && pts[si].properties.name) || ("Point " + (si + 1)), coverage: pb });
    }
    for (var li = 0; li < lines.length; li++) {
      var lb = bufferSet.get("line", li);
      if (lb) allFeatures.push({ name: (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1)), coverage: lb });
    }
    for (var ri = 0; ri < routes.length; ri++) {
      var rb = bufferSet.get("route", ri);
      if (rb) allFeatures.push({ name: (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1)), coverage: rb });
    }
    for (var pi = 0; pi < polys.length; pi++) {
      if (polys[pi] && polys[pi].geometry)
        allFeatures.push({ name: (polys[pi].properties && polys[pi].properties.name) || ("Polygon " + (pi + 1)), coverage: polys[pi] });
    }

    var map = {};
    for (var gi = 0; gi < geos.length; gi++) {
      var geo   = geos[gi];
      var geoid = geo.properties && geo.properties.GEOID;
      if (!geoid) continue;
      var names = [];
      for (var fi = 0; fi < allFeatures.length; fi++) {
        try { if (turf.booleanIntersects(geo, allFeatures[fi].coverage)) names.push(allFeatures[fi].name); } catch (_) {}
      }
      map[geoid] = names.join("; ");
    }
    return map;
  }

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

  function _buildTpiMetadata() {
    return {
      tool:           "Micro Analysis Tool",
      module:         "Transit Propensity Index",
      exportedAt:     new Date().toISOString(),
      geoLevel:       _lastResult ? _lastResult.geoLevel : null,
      acsYear:        _lastResult ? _lastResult.year : null,
      apportionByArea: _apportionByArea,
      bufferMiles:    _lastResult ? _lastResult.bufferMiles : App.ANALYSIS_BUFFER_DEFAULT_MILES
    };
  }

  function _metadataCSVHeader(meta) {
    var lines = [];
    lines.push("# Micro Analysis Tool \u2014 Transit Propensity Index Export");
    lines.push("# Exported: " + meta.exportedAt);
    if (meta.geoLevel) lines.push("# Geography: " + meta.geoLevel);
    if (meta.acsYear)  lines.push("# ACS Year: "  + meta.acsYear);
    lines.push("# Apportion by Area: " + (meta.apportionByArea ? "yes" : "no"));
    lines.push("# Buffer distance (mi): " + meta.bufferMiles);
    return lines.join("\n");
  }

  function exportGeoJSON() {
    if (!_lastResult) return;
    var factors      = TPI.FACTORS;
    var isApportioned = _lastResult.apportionByArea && _lastResult.apportionedRawValues;
    var featureMap   = _buildGeoFeatureMap(_lastResult.geos);

    var clippedLookup = null;
    if (isApportioned && _lastResult.clippedGeos) {
      clippedLookup = {};
      for (var ci = 0; ci < _lastResult.clippedGeos.length; ci++) {
        var cg = _lastResult.clippedGeos[ci];
        if (cg.properties && cg.properties.GEOID) clippedLookup[cg.properties.GEOID] = cg.geometry;
      }
    }

    var features = _lastResult.geos.map(function (geo) {
      var geoid     = geo.properties && geo.properties.GEOID;
      var sd        = geoid ? _lastResult.scores.get(geoid) : null;
      var composite = (sd && Number.isFinite(sd.composite)) ? sd.composite : null;
      var props = {
        GEOID:    geoid || "",
        Feature:  featureMap[geoid] || "",
        tpiScore: composite != null ? parseFloat(composite.toFixed(4)) : null,
        tpiClass: composite != null ? getTpiClass(composite) : "N/A"
      };
      if (isApportioned && _lastResult.areaFractions) {
        var frac = _lastResult.areaFractions.get(geoid);
        props.areaFraction = frac != null ? parseFloat(frac.toFixed(6)) : null;
      }
      factors.forEach(function (f) {
        var rawMap = _lastResult.rawValues.get(f.id) || new Map();
        var raw    = rawMap.get(geoid);
        props[f.id + "_raw"] = (raw != null && Number.isFinite(raw)) ? parseFloat(raw.toFixed(6)) : null;
        if (isApportioned) {
          var aMap = _lastResult.apportionedRawValues.get(f.id) || new Map();
          var aVal = aMap.get(geoid);
          props[f.id + "_raw_apportioned"] = (aVal != null && Number.isFinite(aVal)) ? parseFloat(aVal.toFixed(6)) : null;
        }
        var scoreMap = _lastResult.factorScores.get(f.id) || new Map();
        var sc       = scoreMap.get(geoid);
        props[f.id + "_score"] = sc != null ? sc : null;
      });
      var geom = (clippedLookup && geoid && clippedLookup[geoid]) ? clippedLookup[geoid] : geo.geometry;
      return { type: "Feature", properties: props, geometry: geom };
    });

    var geojson = {
      type: "FeatureCollection",
      metadata: _buildTpiMetadata(),
      features: features
    };
    _triggerDownload(
      JSON.stringify(geojson, null, 2),
      "application/geo+json",
      "tpi-export-" + _dateStamp() + ".geojson"
    );
  }

  function exportCSV() {
    if (!_lastResult) return;
    var factors      = TPI.FACTORS;
    var isApportioned = _lastResult.apportionByArea && _lastResult.apportionedRawValues;
    var featureMap   = _buildGeoFeatureMap(_lastResult.geos);
    var meta         = _buildTpiMetadata();

    var header = ["GEOID", "Feature", "tpiScore", "tpiClass"];
    if (isApportioned) header.push("areaFraction");
    factors.forEach(function (f) {
      header.push(f.id + "_raw");
      if (isApportioned) header.push(f.id + "_raw_apportioned");
      header.push(f.id + "_score");
    });

    var rows = [_metadataCSVHeader(meta), header.join(",")];
    _lastResult.geoids.forEach(function (geoid) {
      var sd        = _lastResult.scores.get(geoid);
      var composite = (sd && Number.isFinite(sd.composite)) ? sd.composite : null;
      var featVal   = (featureMap[geoid] || "").replace(/"/g, '""');
      var row = [
        geoid,
        '"' + featVal + '"',
        composite != null ? composite.toFixed(4) : "",
        composite != null ? getTpiClass(composite) : ""
      ];
      if (isApportioned && _lastResult.areaFractions) {
        var frac = _lastResult.areaFractions.get(geoid);
        row.push(frac != null ? frac.toFixed(6) : "");
      }
      factors.forEach(function (f) {
        var rawMap = _lastResult.rawValues.get(f.id) || new Map();
        var raw    = rawMap.get(geoid);
        row.push((raw != null && Number.isFinite(raw)) ? raw.toFixed(6) : "");
        if (isApportioned) {
          var aMap = _lastResult.apportionedRawValues.get(f.id) || new Map();
          var aVal = aMap.get(geoid);
          row.push((aVal != null && Number.isFinite(aVal)) ? aVal.toFixed(6) : "");
        }
        var scoreMap = _lastResult.factorScores.get(f.id) || new Map();
        var sc       = scoreMap.get(geoid);
        row.push(sc != null ? String(sc) : "");
      });
      rows.push(row.join(","));
    });
    _triggerDownload(rows.join("\n"), "text/csv", "tpi-export-" + _dateStamp() + ".csv");
  }

  // ---- Init (called once on first popup open) ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    // Analyze System
    var runBtn = document.getElementById("tpiRun");
    if (runBtn) runBtn.addEventListener("click", function () { runTPI(); });

    // Shared census-cache status line + Re-fetch
    if (runBtn && typeof App.buildCensusCacheStatus === "function") {
      var ccStatus = App.buildCensusCacheStatus({
        geoSel: document.getElementById("tpiGeoLevel"),
        yearSel: document.getElementById("tpiYearSelect"),
        onRefetch: function () { runBtn.click(); }
      });
      runBtn.parentNode.insertBefore(ccStatus, runBtn);
    }

    var geoLevelEl = document.getElementById("tpiGeoLevel");
    if (geoLevelEl) geoLevelEl.addEventListener("change", markStale);
    var yearEl = document.getElementById("tpiYearSelect");
    if (yearEl) yearEl.addEventListener("change", markStale);

    // Hide Choropleth toggle
    var hideCb = document.getElementById("tpiHideChoropleth");
    if (hideCb) {
      hideCb.addEventListener("change", function () {
        var vis = hideCb.checked ? "none" : "visible";
        var map = App.map;
        if (map.getLayer(TPI_FILL_LAYER))      map.setLayoutProperty(TPI_FILL_LAYER,      "visibility", vis);
        if (map.getLayer(TPI_LINE_LAYER))      map.setLayoutProperty(TPI_LINE_LAYER,      "visibility", vis);
        if (map.getLayer("census-geos-fill"))  map.setLayoutProperty("census-geos-fill",  "visibility", vis);
        if (map.getLayer("census-geos-line"))  map.setLayoutProperty("census-geos-line",  "visibility", vis);
        if (hideCb.checked) App.popup.hideFloatingWidget("tpi-legend");
        else                App.popup.showFloatingWidget("tpi-legend", "projects/tpi-legend.html", { position: "bottom-left", width: 160, title: "TPI Legend" });
      });
    }

    // Adjust Weights modal
    var adjustBtn = document.getElementById("tpiAdjustWeights");
    if (adjustBtn) adjustBtn.addEventListener("click", openWeightsModal);

    var confirmBtn = document.getElementById("tpiWeightsConfirm");
    if (confirmBtn) confirmBtn.addEventListener("click", function () { closeWeightsModal(true); });

    var cancelBtn = document.getElementById("tpiWeightsCancel");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { closeWeightsModal(false); });

    var resetBtn = document.getElementById("tpiResetWeights");
    if (resetBtn) resetBtn.addEventListener("click", resetModalToDefaults);

    // Select all / clear
    var selectAllLink = document.getElementById("tpiSelectAll");
    if (selectAllLink) {
      selectAllLink.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tpiFeatureChecklist input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
        markStale();
      });
    }
    var selectNoneLink = document.getElementById("tpiSelectNone");
    if (selectNoneLink) {
      selectNoneLink.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tpiFeatureChecklist input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        markStale();
      });
    }

    // Corridor dropdown change
    var corridorSel = document.getElementById("tpiCorridorSelect");
    if (corridorSel) {
      corridorSel.addEventListener("change", function () {
        _selectedCorridor = corridorSel.value;
        renderInputs();
        if (_lastResult && isPopupVisible()) {
          displayGeographyList(_lastResult, _selectedCorridor);
        }
      });
    }

    // Export buttons
    var exportGeoJSONBtn = document.getElementById("tpiExportGeoJSON");
    if (exportGeoJSONBtn) exportGeoJSONBtn.addEventListener("click", exportGeoJSON);
    var exportCSVBtn = document.getElementById("tpiExportCSV");
    if (exportCSVBtn) exportCSVBtn.addEventListener("click", exportCSV);

    // Apportion by area
    var apportionCb = document.getElementById("tpiApportionByArea");
    if (apportionCb) {
      apportionCb.checked = _apportionByArea;
      apportionCb.addEventListener("change", function () {
        _apportionByArea = apportionCb.checked;
        markStale();
      });
    }

    // Buffer distance (mi) — module-owned analysis distance, independent of
    // the Feature Settings global buffer radius.
    var bufferMilesEl = document.getElementById("tpiBufferMiles");
    if (bufferMilesEl) {
      bufferMilesEl.value = String(_bufferMiles);
      bufferMilesEl.addEventListener("change", markStale);
    }
    var displayBuffersEl = document.getElementById("tpiUseDisplayBuffers");
    if (displayBuffersEl) displayBuffersEl.addEventListener("change", function () {
      _useDisplayBuffers = displayBuffersEl.checked;
      syncBufferControl();
      markStale();
    });
    syncBufferControl();

    // Build weight sliders (in modal) with current _weights
    buildWeightSliders();
    renderInputs(_lastResult ? undefined : false);
  }

  // ---- Popup lifecycle hooks ----

  function onOpen(core) {
    document.querySelectorAll(".cc-status").forEach(function (s) { if (s.refresh) s.refresh(); });
    // Sync checkbox
    var apportionCb = document.getElementById("tpiApportionByArea");
    if (apportionCb) apportionCb.checked = _apportionByArea;
    var bufferMilesEl = document.getElementById("tpiBufferMiles");
    if (bufferMilesEl) bufferMilesEl.value = String(_bufferMiles);
    syncBufferControl();

    // Rebuild checklist (features may have changed since last open)
    buildFeatureChecklist();
    renderInputs(false);

    // Refresh results display
    if (_lastResult && isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      displayGeographyList(_lastResult, _selectedCorridor);
    } else if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      App.renderModuleState({
        statusEl: "tpiStatus", emptyEl: "tpiEmptyState", empty: true, hint: emptyHint()
      });
    }
    if (_stale) markStale();

    // Sync hide-choropleth toggle with actual layer visibility
    var toggleRow = document.getElementById("tpiChoroplethToggleRow");
    var hideCb    = document.getElementById("tpiHideChoropleth");
    if (toggleRow) toggleRow.style.display = _lastResult ? "" : "none";
    if (hideCb && _lastResult && App.map.getLayer(TPI_FILL_LAYER)) {
      hideCb.checked = App.map.getLayoutProperty(TPI_FILL_LAYER, "visibility") === "none";
    }

    // LODES warning
    var lodesWarnBtn = document.getElementById("tpiLodesWarnBtn");
    if (lodesWarnBtn) lodesWarnBtn.style.display = App.lodesData ? "none" : "";
  }

  function onClose(core) {
    // State persists in closure
  }

  async function update(core) {
    if (_lastResult && !core.getUnion()) {
      clearChoropleth();
    } else {
      markStale();
    }
    if (isPopupVisible()) {
      buildFeatureChecklist();
      var lodesWarnBtn = document.getElementById("tpiLodesWarnBtn");
      if (lodesWarnBtn) lodesWarnBtn.style.display = App.lodesData ? "none" : "";
    }
  }

  // ---- Session persistence ----

  function saveTpiState(mode) {
    var data = {
      weights:          Object.assign({}, _weights),
      apportionByArea:  _apportionByArea,
      bufferMiles:      _bufferMiles,
      useDisplayBuffers: _useDisplayBuffers,
      selectedCorridor: _selectedCorridor,
      tpiFeatureFilter: _tpiFeatureFilter ? JSON.parse(JSON.stringify(_tpiFeatureFilter)) : null
    };
    if (!_lastResult) return data;
    var tpi = _lastResult;
    data.result = {
      geoLevel:             tpi.geoLevel,
      year:                 tpi.year,
      bufferMiles:          tpi.bufferMiles,
      geoids:               tpi.geoids ? tpi.geoids.slice() : [],
      effectiveWeights:     tpi.effectiveWeights ? Object.assign({}, tpi.effectiveWeights) : {},
      tractFallbackFactors: tpi.tractFallbackFactors ? tpi.tractFallbackFactors.slice() : [],
      apportionByArea:      tpi.apportionByArea || false,
      scores:               App.mapToObj(tpi.scores),
      factorScores:         App.nestedMapToObj(tpi.factorScores),
      rawValues:            App.nestedMapToObj(tpi.rawValues)
    };
    if (mode === "full" && tpi.geos) {
      data.result.geos = tpi.geos.slice();
    }
    return data;
  }

  function restoreTpiState(data) {
    if (!data) return;
    if (data.weights)          _weights          = Object.assign({}, data.weights);
    if (data.apportionByArea != null) _apportionByArea = !!data.apportionByArea;
    if (data.bufferMiles != null) _bufferMiles = data.bufferMiles;
    if (data.useDisplayBuffers != null) _useDisplayBuffers = !!data.useDisplayBuffers;
    if (data.selectedCorridor) _selectedCorridor = data.selectedCorridor;
    if (data.tpiFeatureFilter !== undefined) _tpiFeatureFilter = data.tpiFeatureFilter;

    var bufferMilesEl = document.getElementById("tpiBufferMiles");
    if (bufferMilesEl) bufferMilesEl.value = String(_bufferMiles);
    syncBufferControl();

    if (!data.result) return;
    var r = data.result;
    var restored = {
      geoLevel:             r.geoLevel,
      year:                 r.year,
      bufferMiles:          r.bufferMiles != null ? r.bufferMiles : App.ANALYSIS_BUFFER_DEFAULT_MILES,
      geoids:               r.geoids || [],
      geos:                 r.geos   || [],
      effectiveWeights:     r.effectiveWeights     || {},
      tractFallbackFactors: r.tractFallbackFactors || [],
      apportionByArea:      r.apportionByArea      || false,
      scores:               App.objToMap(r.scores),
      factorScores:         App.nestedObjToMap(r.factorScores),
      rawValues:            App.nestedObjToMap(r.rawValues)
    };
    _lastResult = restored;
    _stale      = false;

    if (restored.geos && restored.geos.length > 0) {
      renderChoropleth(restored);
      App.renderCensusOverlay(restored.geos);
      App.popup.showFloatingWidget("tpi-legend", "projects/tpi-legend.html", {
        position: "bottom-left", width: 160, title: "TPI Legend"
      });
    }
  }

  // ---- Public API ----

  App.getTpiWeights = function () { return Object.assign({}, _weights); };

  // ---- Register as analysis module ----

  App.registerModule({
    id:         "transit-propensity",
    name:       "Transit Propensity Index",
    enabled:    true,
    popupWidth: 1000,
    panelWidths: { setup: 520, results: 520 },
    popupHTML:  "projects/transit-propensity-popup.html",

    floatingWidgets: [
      { id: "tpi-legend", htmlFile: "projects/tpi-legend.html", position: "bottom-left", width: 160 }
    ],

    init:  function (core) { init(core); },
    onOpen: function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:  function ()     { clearChoropleth(); },
    update: async function (core) { await update(core); }
  });

  // Register with session cache
  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("tpi", {
      collect: saveTpiState,
      apply:   restoreTpiState
    });
  }

})();
