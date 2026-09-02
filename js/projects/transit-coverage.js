// js/projects/transit-coverage.js
// Transit Coverage: registers as an analysis module, opens in a 2-column popup,
// computes ACS population + LODES jobs coverage within a buffer distance of
// selected transit routes/lines, clipped to a user-selected service area.
// Depends on: App namespace, App.popup (popup.js), App.cache (cache.js),
//   App.getEffectiveServiceBands (service-assembly.js), census.js, lodes.js, turf (CDN).
// Step 2: checklists + input wiring + stale lifecycle.
// No public API.

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state (persists across popup open/close) ----

  var _lastResult       = null;   // populated in Step 5: { geoLevel, year, ..., coverageClipped, thresholdClipped, serviceAreaUnion }
  var _stale            = false;
  var _running          = false;
  var _initialized       = false;
  var _savedSelections   = null;  // { routeIndices, lineIndices, polygonIndices } restored from session cache (Step 7)
  var _useDisplayBuffers = false;

  // ---- DOM guard: only touch DOM when popup is open for this module ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "transit-coverage";
  }

  // ---- Feature checklist (routes + lines) ----

  function buildFeatureChecklist() {
    var el = document.getElementById("tcFeatureList");
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

    var routes = App.routes || [];
    var lines  = App.lines  || [];

    for (var ri = 0; ri < routes.length; ri++) {
      addRow("route", ri,
        (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1)),
        "R");
    }
    for (var li = 0; li < lines.length; li++) {
      addRow("line", li,
        (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1)),
        "L");
    }

    if (!hasFeatures) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No routes or lines drawn.</div>';
    }
  }

  // ---- Service-area checklist (drawn polygons) ----

  function buildAreaChecklist() {
    var el = document.getElementById("tcAreaList");
    if (!el) return;

    var prevState = {};
    var prev = el.querySelectorAll("input[type=checkbox]");
    for (var pi = 0; pi < prev.length; pi++) {
      prevState[prev[pi].getAttribute("data-idx")] = prev[pi].checked;
    }

    el.innerHTML = "";
    var hasAreas = false;

    function addRow(idx, name) {
      hasAreas = true;
      var key = String(idx);
      var checked = (key in prevState) ? prevState[key] : true;
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", "polygon");
      cb.setAttribute("data-idx", String(idx));
      cb.checked = checked;

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = name;

      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = "P";

      lbl.addEventListener("click", function (e) { e.preventDefault(); cb.checked = !cb.checked; markStale(); });
      cb.addEventListener("change", markStale);

      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(badgeEl);
      el.appendChild(row);
    }

    var polygons = App.polygons || [];
    for (var i = 0; i < polygons.length; i++) {
      addRow(i, (polygons[i].properties && polygons[i].properties.name) || ("Polygon " + (i + 1)));
    }

    if (!hasAreas) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No polygons drawn.</div>';
    }
  }

  // ---- Selection readers/writers (explicit index arrays — never "null = all") ----

  function getSelectedFeatures() {
    var el = document.getElementById("tcFeatureList");
    var routeIndices = [], lineIndices = [];
    if (!el) return { routeIndices: routeIndices, lineIndices: lineIndices };
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      if (!cb.checked) continue;
      var type = cb.getAttribute("data-type");
      var idx  = parseInt(cb.getAttribute("data-idx"), 10);
      if      (type === "route") routeIndices.push(idx);
      else if (type === "line")  lineIndices.push(idx);
    }
    return { routeIndices: routeIndices, lineIndices: lineIndices };
  }

  function getSelectedAreas() {
    var el = document.getElementById("tcAreaList");
    var polygonIndices = [];
    if (!el) return { polygonIndices: polygonIndices };
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      if (!cb.checked) continue;
      polygonIndices.push(parseInt(cb.getAttribute("data-idx"), 10));
    }
    return { polygonIndices: polygonIndices };
  }

  function applySelections(sel) {
    if (!sel) return;
    var routeSet = new Set((sel.routeIndices   || []).map(Number));
    var lineSet  = new Set((sel.lineIndices    || []).map(Number));
    var polySet  = new Set((sel.polygonIndices || []).map(Number));

    var featEl = document.getElementById("tcFeatureList");
    if (featEl) {
      var featBoxes = featEl.querySelectorAll("input[type=checkbox]");
      for (var i = 0; i < featBoxes.length; i++) {
        var cb   = featBoxes[i];
        var type = cb.getAttribute("data-type");
        var idx  = parseInt(cb.getAttribute("data-idx"), 10);
        if (type === "route") cb.checked = routeSet.has(idx);
        if (type === "line")  cb.checked = lineSet.has(idx);
      }
    }

    var areaEl = document.getElementById("tcAreaList");
    if (areaEl) {
      var areaBoxes = areaEl.querySelectorAll("input[type=checkbox]");
      for (var j = 0; j < areaBoxes.length; j++) {
        var acb  = areaBoxes[j];
        var aidx = parseInt(acb.getAttribute("data-idx"), 10);
        acb.checked = polySet.has(aidx);
      }
    }
  }

  // ---- LODES warning icon visibility ----

  function updateLodesWarnings() {
    var warnBtn = document.getElementById("tcLodesWarnBtn");
    if (warnBtn) warnBtn.style.display = App.lodesData ? "none" : "";
  }

  // ---- Status + stale helpers ----

  function setStatus(msg, kind) {
    // kind: "" | "done" | "error" | "running" (stale is handled by markStale)
    App.renderModuleState({
      statusEl: "tcStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  // Context-aware onboarding/empty hint shown when there are no results.
  function emptyHint() {
    var nFeat = (App.routes || []).length + (App.lines || []).length;
    if (!nFeat) {
      return { need: "Draw a route or line to begin.",
               action: "Use the Route or Line tool, then reopen this panel." };
    }
    var nArea = (App.polygons || []).length;
    if (!nArea) {
      return { need: "Draw a service-area polygon to begin.",
               action: "Use the Polygon tool to outline the area to measure coverage within." };
    }
    return { need: "Select transit features and a service area, then click Analyze Coverage.",
             action: "Coverage is measured as the share of the service area's population and jobs within the buffer distance." };
  }

  function setExportButtonsEnabled(enabled) {
    var csvBtn = document.getElementById("tcExportCSV");
    var gjBtn  = document.getElementById("tcExportGeoJSON");
    if (csvBtn) csvBtn.disabled = !enabled;
    if (gjBtn)  gjBtn.disabled  = !enabled;
  }

  // ---- Collapsible inputs (shared helper) ----
  var DAY_LABEL = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };

  function inputsSummary() {
    if (!_lastResult) return "";
    var r = _lastResult;
    var geoLabel = r.geoLevel === "tract" ? "Tracts" : "Block groups";
    var parts = [
      r.useDisplayBuffers ? "display buffers" : r.bufferMiles + " mi",
      geoLabel + " · " + r.year,
      DAY_LABEL[r.dayType] || r.dayType
    ];
    if (r.thresholdMin != null) parts.push("≤ " + r.thresholdMin + " min headway");
    return parts.join(" · ");
  }

  function syncBufferControl() {
    var input = document.getElementById("tcBufferMiles");
    var toggle = document.getElementById("tcUseDisplayBuffers");
    if (input) input.disabled = _useDisplayBuffers;
    if (toggle) toggle.checked = _useDisplayBuffers;
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".tc-body .rf-settings-col"),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastResult ? "results" : "setup", true);
      }
    });
  }

  function markStale() {
    _stale = true;
    setExportButtonsEnabled(false);
    if (!isPopupVisible()) return;
    if (_lastResult) {
      App.renderModuleState({ statusEl: "tcStatus", stale: true, onRerun: runCoverage });
    }
  }

  // ---- Pure helpers (no DOM/App state — testable via App._tcTest) ----

  function computePeakHeadway(service, dayType) {
    var bands = App.getEffectiveServiceBands ? App.getEffectiveServiceBands(service, dayType) : [];
    var min = null;
    for (var i = 0; i < bands.length; i++) {
      var f = parseFloat(bands[i] && bands[i].frequency);
      if (Number.isFinite(f) && f > 0) {
        if (min === null || f < min) min = f;
      }
    }
    return min;
  }

  function formatPct(num, den) {
    if (!Number.isFinite(den) || den <= 0 || !Number.isFinite(num)) return "—";
    return (100 * num / den).toFixed(1) + "%";
  }

  function formatCount(v) {
    if (!Number.isFinite(v)) return "—";
    return Math.round(v).toLocaleString();
  }

  function buildStatSentence(summary) {
    var s = summary || {};
    if (!Number.isFinite(s.popTotal) || s.popTotal <= 0) {
      return "No population found in the selected service area.";
    }
    var sentence = formatPct(s.popCovered, s.popTotal) +
      " of residents are within " + s.bufferMiles + " mi of selected transit";
    if (s.hasThreshold) {
      sentence += "; " + formatPct(s.popThreshold, s.popTotal) +
        " within " + s.bufferMiles + " mi of " + s.headwayThreshold + "-min-or-better service.";
    } else {
      sentence += ".";
    }
    return sentence;
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function _csvField(val) {
    if (val == null) return "";
    var s = String(val);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
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

  // Test-only: expose the pure helpers to the golden harness
  // (test/run-golden.mjs). Guarded by __MAT_TEST__ so it has no effect in the
  // browser. See test/README.md.
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._tcTest = {
      computePeakHeadway: computePeakHeadway,
      formatPct:          formatPct,
      formatCount:        formatCount,
      buildStatSentence:  buildStatSentence,
      _csvField:          _csvField
    };
  }

  // ---- Geometry: private buffers, unions, clipping ----
  // These build the module's OWN buffers via turf (via the shared
  // App.buildAnalysisBuffer/App.foldAnalysisUnion helpers in
  // js/core/module-buffers.js) — they never read or mutate
  // App.routeBuffers / App.lineBuffers (those belong to the shared
  // Feature Settings buffer radius, a different concern).

  function buildCoverageUnions(sel, miles, dayType, thresholdMin, useDisplayBuffers) {
    var headwayRows = [];
    var allBuffers = [];
    var qualifyingBuffers = [];
    var bufferSet = useDisplayBuffers
      ? App.buildDisplayBufferSet(sel)
      : App.buildAnalysisBufferSet(sel, miles);

    function processFeature(type, idx, feature) {
      if (!feature) return;
      var name = (feature.properties && feature.properties.name) ||
        (type.charAt(0).toUpperCase() + type.slice(1) + " " + (idx + 1));
      var attrs = (feature.properties && feature.properties.attributes) || {};
      var peak = computePeakHeadway(attrs.service, dayType);
      var qualifies = thresholdMin != null && peak != null && peak <= thresholdMin;
      headwayRows.push({
        name: name, featureType: type, featureIndex: idx,
        peakHeadway: peak, qualifies: qualifies
      });

      var buf = bufferSet.get(type, idx);
      if (buf) {
        allBuffers.push(buf);
        if (qualifies) qualifyingBuffers.push(buf);
      }
    }

    var routes = App.routes || [];
    var lines  = App.lines  || [];
    var routeIndices = (sel && sel.routeIndices) || [];
    var lineIndices  = (sel && sel.lineIndices)  || [];
    var i;
    for (i = 0; i < routeIndices.length; i++) {
      processFeature("route", routeIndices[i], routes[routeIndices[i]]);
    }
    for (i = 0; i < lineIndices.length; i++) {
      processFeature("line", lineIndices[i], lines[lineIndices[i]]);
    }

    var coverageUnion  = App.foldAnalysisUnion(allBuffers);
    var thresholdUnion = (thresholdMin == null) ? null : App.foldAnalysisUnion(qualifyingBuffers);

    return { coverageUnion: coverageUnion, thresholdUnion: thresholdUnion, headwayRows: headwayRows };
  }

  function clipToServiceArea(unionFeat, serviceAreaUnion) {
    if (!unionFeat || !serviceAreaUnion) return null;
    try { return turf.intersect(unionFeat, serviceAreaUnion); }
    catch (e) { return null; }
  }

  function buildServiceAreaUnion(sel) {
    var polygons = App.polygons || [];
    var idxs = (sel && sel.polygonIndices) || [];
    var polys = [];
    for (var i = 0; i < idxs.length; i++) {
      if (polygons[idxs[i]]) polys.push(polygons[idxs[i]]);
    }
    return App.foldAnalysisUnion(polys);
  }

  // ---- Map overlay (coverage / threshold / service-area fills) ----

  var TC_SOURCE           = "transit-coverage-fill";
  var TC_COVERAGE_LAYER   = "transit-coverage-coverage-layer";
  var TC_THRESHOLD_LAYER  = "transit-coverage-threshold-layer";
  var TC_AREA_LAYER       = "transit-coverage-area-layer";

  function buildOverlayFeatureCollection(result) {
    var features = [];
    if (result.serviceAreaUnion) {
      features.push({ type: "Feature", geometry: result.serviceAreaUnion.geometry, properties: { kind: "area" } });
    }
    if (result.coverageClipped) {
      features.push({ type: "Feature", geometry: result.coverageClipped.geometry, properties: { kind: "coverage" } });
    }
    if (result.thresholdClipped) {
      features.push({ type: "Feature", geometry: result.thresholdClipped.geometry, properties: { kind: "threshold" } });
    }
    return { type: "FeatureCollection", features: features };
  }

  function renderMapOverlay(result) {
    var map = App.map;
    if (!map || !result) return;
    var fc = buildOverlayFeatureCollection(result);

    if (!map.getSource(TC_SOURCE)) {
      map.addSource(TC_SOURCE, { type: "geojson", data: fc });
      map.addLayer({
        id: TC_COVERAGE_LAYER,
        type: "fill",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "coverage"],
        paint: { "fill-color": "#93c5fd", "fill-opacity": 0.35 }
      });
      map.addLayer({
        id: TC_THRESHOLD_LAYER,
        type: "fill",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "threshold"],
        paint: { "fill-color": "#1d4ed8", "fill-opacity": 0.35 }
      });
      map.addLayer({
        id: TC_AREA_LAYER,
        type: "line",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "area"],
        paint: { "line-color": "#374151", "line-width": 2, "line-dasharray": [2, 2] }
      });
    } else {
      map.getSource(TC_SOURCE).setData(fc);
    }
  }

  function clearMapOverlay() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer(TC_COVERAGE_LAYER))  map.removeLayer(TC_COVERAGE_LAYER);
    if (map.getLayer(TC_THRESHOLD_LAYER)) map.removeLayer(TC_THRESHOLD_LAYER);
    if (map.getLayer(TC_AREA_LAYER))      map.removeLayer(TC_AREA_LAYER);
    if (map.getSource(TC_SOURCE))         map.removeSource(TC_SOURCE);
  }

  // ---- Coverage compute flow ----

  async function runCoverage() {
    if (_running) return;
    _running = true;
    var runBtn = document.getElementById("tcRunBtn");
    if (runBtn) runBtn.disabled = true;
    setStatus("Analyzing…", "running");
    clearMapOverlay(); // wipe any prior run so selection changes are visible

    try {
      var geoLevel = document.getElementById("tcGeoLevel").value;
      var year     = document.getElementById("tcYearSelect").value;

      var bufferMiles = App.readAnalysisBufferMiles("tcBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);

      var dayType = document.getElementById("tcDayType").value;

      var thresholdRaw = parseFloat(document.getElementById("tcHeadwayThreshold").value);
      var thresholdMin = (Number.isFinite(thresholdRaw) && thresholdRaw > 0) ? thresholdRaw : null;

      var featSel = getSelectedFeatures();
      if (!featSel.routeIndices.length && !featSel.lineIndices.length) {
        throw new Error("Select at least one route or line.");
      }
      var areaSel = getSelectedAreas();
      if (!areaSel.polygonIndices.length) {
        throw new Error("Select at least one service-area polygon.");
      }

      var serviceAreaUnion = buildServiceAreaUnion(areaSel);
      if (!serviceAreaUnion) {
        throw new Error("Could not build a service area from the selected polygons.");
      }

      _useDisplayBuffers = !!(document.getElementById("tcUseDisplayBuffers") || {}).checked;
      var unions = buildCoverageUnions(featSel, bufferMiles, dayType, thresholdMin, _useDisplayBuffers);
      var coverageUnion  = unions.coverageUnion;
      var thresholdUnion = unions.thresholdUnion;
      var headwayRows     = unions.headwayRows;
      if (!coverageUnion) {
        throw new Error("Could not build buffers for the selected features.");
      }

      var coverageClipped  = clipToServiceArea(coverageUnion, serviceAreaUnion);
      var thresholdClipped = clipToServiceArea(thresholdUnion, serviceAreaUnion);

      setStatus("Fetching geographies…", "running");
      var geos = await App.fetchTigerwebGeos(geoLevel, serviceAreaUnion);
      var geoids = geos.map(function (f) { return f.properties.GEOID; }).filter(Boolean);

      setStatus("Fetching population…", "running");
      var popMap = await App.fetchACSValues(geoLevel, year, "B01003_001E", geoids);
      var opts = { apportionByArea: true };
      var popTotal     = App.aggregateWithinUnion(serviceAreaUnion, geos, popMap, "sum", opts).value;
      var popCovered   = coverageClipped  ? App.aggregateWithinUnion(coverageClipped,  geos, popMap, "sum", opts).value : 0;
      var popThreshold = (thresholdMin == null) ? null
                       : (thresholdClipped ? App.aggregateWithinUnion(thresholdClipped, geos, popMap, "sum", opts).value : 0);

      setStatus("Computing LODES employment…", "running");
      async function sumJobsInUnion(unionFeat) {
        if (!unionFeat) return 0;
        var blocksInside = await App.fetchBlocksInternalPointsInUnion(unionFeat);
        var sum = 0;
        for (var geoid of blocksInside) {
          var v = App.lodesData.get(geoid);
          if (v != null) sum += v;
        }
        return sum;
      }

      var jobsTotal, jobsCovered, jobsThreshold;
      if (!App.lodesData) {
        jobsTotal = null; jobsCovered = null; jobsThreshold = null;
      } else {
        jobsTotal     = await sumJobsInUnion(serviceAreaUnion);
        jobsCovered   = await sumJobsInUnion(coverageClipped);
        jobsThreshold = (thresholdMin == null) ? null : await sumJobsInUnion(thresholdClipped);
      }

      _lastResult = {
        geoLevel: geoLevel, year: year,
        bufferMiles: bufferMiles, useDisplayBuffers: _useDisplayBuffers, dayType: dayType, thresholdMin: thresholdMin,
        popTotal: popTotal, popCovered: popCovered, popThreshold: popThreshold,
        jobsTotal: jobsTotal, jobsCovered: jobsCovered, jobsThreshold: jobsThreshold,
        headwayRows: headwayRows,
        coverageClipped: coverageClipped, thresholdClipped: thresholdClipped,
        serviceAreaUnion: serviceAreaUnion,
        featSel: featSel, areaSel: areaSel
      };
      _stale = false;

      renderResults(_lastResult);
      renderMapOverlay(_lastResult);
      if (App.popup && App.popup.showFloatingWidget) {
        App.popup.showFloatingWidget("tc-legend", "projects/transit-coverage-legend.html", {
          position: "bottom-left",
          width: 200,
          title: "Transit Coverage"
        });
      }
      setExportButtonsEnabled(true);
      setStatus("Analyzed coverage — " + geos.length + " geographies.", "done");
      // Collapse only on success — an error leaves the inputs open.
      renderInputs(true);
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
    } catch (err) {
      console.error("Transit Coverage error:", err);
      setStatus("Error: " + (err.message || err), "error");
    } finally {
      _running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  // ---- Results rendering ----

  function buildResultsRow(label, popValue, jobsValue, popDen, jobsDen) {
    return '<tr>' +
      '<td>' + escapeHTML(label) + '</td>' +
      '<td>' + formatCount(popValue) + '</td>' +
      '<td>' + formatPct(popValue, popDen) + '</td>' +
      '<td>' + (jobsValue == null ? "—" : formatCount(jobsValue)) + '</td>' +
      '<td>' + (jobsValue == null ? "—" : formatPct(jobsValue, jobsDen)) + '</td>' +
    '</tr>';
  }

  function renderResults(result) {
    var container   = document.getElementById("tcResultsTable");
    var resultsWrap = document.getElementById("tcResults");
    var emptyState  = document.getElementById("tcEmptyState");
    if (!container || !resultsWrap) return;

    if (!result) {
      resultsWrap.style.display = "none";
      container.innerHTML = "";
      App.renderModuleState({
        statusEl: "tcStatus", emptyEl: "tcEmptyState", empty: true, hint: emptyHint()
      });
      return;
    }
    if (emptyState) emptyState.style.display = "none";
    resultsWrap.style.display = "";

    var hasThreshold = result.thresholdMin != null;

    var html = '<table class="cs-results-table tc-results-table">' +
      '<thead><tr>' +
        '<th>Row</th>' +
        '<th>Population</th>' +
        '<th>Pop %</th>' +
        '<th>Jobs</th>' +
        '<th>Jobs %</th>' +
      '</tr></thead><tbody>';

    html += buildResultsRow("Service area", result.popTotal, result.jobsTotal, result.popTotal, result.jobsTotal);
    html += buildResultsRow(
      "Within " + result.bufferMiles + " mi of selected transit",
      result.popCovered, result.jobsCovered, result.popTotal, result.jobsTotal);
    if (hasThreshold) {
      html += buildResultsRow(
        "Within " + result.bufferMiles + " mi of ≤" + result.thresholdMin + "-min transit",
        result.popThreshold, result.jobsThreshold, result.popTotal, result.jobsTotal);
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    var statEl = document.getElementById("tcStatSentence");
    if (statEl) {
      statEl.textContent = buildStatSentence({
        bufferMiles:      result.bufferMiles,
        headwayThreshold: result.thresholdMin,
        popTotal:         result.popTotal,
        popCovered:       result.popCovered,
        popThreshold:     result.popThreshold,
        hasThreshold:     hasThreshold
      });
    }

    var headwayListEl = document.getElementById("tcHeadwayList");
    if (headwayListEl) {
      var rows = result.headwayRows || [];
      var itemsHtml = rows.map(function (r) {
        var headwayText = (r.peakHeadway != null) ? (r.peakHeadway + " min") : "no service";
        var meetsText = hasThreshold ? (r.qualifies ? " — meets threshold" : " — does not meet threshold") : "";
        return '<div class="tiny">' + escapeHTML(r.name) + ': ' + headwayText + meetsText + '</div>';
      }).join("");
      headwayListEl.innerHTML =
        '<details><summary>Peak headways (' + rows.length + ' feature' + (rows.length === 1 ? "" : "s") + ')</summary>' +
        itemsHtml +
        '</details>';
    }
  }

  // ---- Exports ----

  function _pctField(num, den) {
    if (!Number.isFinite(den) || den <= 0 || !Number.isFinite(num)) return "";
    return (100 * num / den).toFixed(1);
  }

  function _pctValue(num, den) {
    if (!Number.isFinite(den) || den <= 0 || !Number.isFinite(num)) return null;
    return parseFloat((100 * num / den).toFixed(1));
  }

  function exportCSV() {
    if (!_lastResult) return;
    var r = _lastResult;
    var hasThreshold = r.thresholdMin != null;

    function dataRow(label, popVal, jobsVal, popDen, jobsDen) {
      return [
        _csvField(label),
        Number.isFinite(popVal) ? Math.round(popVal) : "",
        _pctField(popVal, popDen),
        (jobsVal == null) ? "" : Math.round(jobsVal),
        (jobsVal == null) ? "" : _pctField(jobsVal, jobsDen)
      ].join(",");
    }

    var lines = [];
    lines.push("# Micro Analysis Tool — Transit Coverage Export");
    lines.push("# Exported: "              + new Date().toISOString());
    lines.push("# Geography: "             + (r.geoLevel || ""));
    lines.push("# ACS Year: "               + (r.year || ""));
    lines.push("# Buffer distance (mi): "  + r.bufferMiles);
    lines.push("# Day type: "               + r.dayType);
    lines.push("# Headway threshold (min): " + (hasThreshold ? r.thresholdMin : ""));
    lines.push("# Population is apportioned by area; jobs are counted by whole LODES block.");

    lines.push("row,population,pop_pct,jobs,jobs_pct");
    lines.push(dataRow("Service area", r.popTotal, r.jobsTotal, r.popTotal, r.jobsTotal));
    lines.push(dataRow("Within " + r.bufferMiles + " mi of selected transit",
      r.popCovered, r.jobsCovered, r.popTotal, r.jobsTotal));
    if (hasThreshold) {
      lines.push(dataRow("Within " + r.bufferMiles + " mi of ≤" + r.thresholdMin + "-min transit",
        r.popThreshold, r.jobsThreshold, r.popTotal, r.jobsTotal));
    }

    lines.push("");
    lines.push("feature,peak_headway_min,meets_threshold");
    var headwayRows = r.headwayRows || [];
    for (var i = 0; i < headwayRows.length; i++) {
      var hr = headwayRows[i];
      lines.push([
        _csvField(hr.name),
        (hr.peakHeadway != null) ? hr.peakHeadway : "",
        hasThreshold ? (hr.qualifies ? "yes" : "no") : ""
      ].join(","));
    }

    _triggerDownload(lines.join("\n"), "text/csv", "transit-coverage-" + _dateStamp() + ".csv");
  }

  function exportGeoJSON() {
    if (!_lastResult) return;
    var r = _lastResult;
    if (!r.serviceAreaUnion && !r.coverageClipped && !r.thresholdClipped) {
      setStatus("Re-run the analysis to regenerate geometry for export.", "error");
      return;
    }
    var hasThreshold = r.thresholdMin != null;
    var features = [];

    if (r.serviceAreaUnion && r.serviceAreaUnion.geometry) {
      features.push({
        type: "Feature",
        geometry: r.serviceAreaUnion.geometry,
        properties: {
          kind:          "service-area",
          population:    Number.isFinite(r.popTotal) ? r.popTotal : null,
          populationPct: _pctValue(r.popTotal, r.popTotal),
          jobs:          r.jobsTotal,
          jobsPct:       _pctValue(r.jobsTotal, r.jobsTotal)
        }
      });
    }
    if (r.coverageClipped && r.coverageClipped.geometry) {
      features.push({
        type: "Feature",
        geometry: r.coverageClipped.geometry,
        properties: {
          kind:          "coverage",
          population:    Number.isFinite(r.popCovered) ? r.popCovered : null,
          populationPct: _pctValue(r.popCovered, r.popTotal),
          jobs:          r.jobsCovered,
          jobsPct:       _pctValue(r.jobsCovered, r.jobsTotal)
        }
      });
    }
    if (hasThreshold && r.thresholdClipped && r.thresholdClipped.geometry) {
      features.push({
        type: "Feature",
        geometry: r.thresholdClipped.geometry,
        properties: {
          kind:          "threshold",
          population:    Number.isFinite(r.popThreshold) ? r.popThreshold : null,
          populationPct: _pctValue(r.popThreshold, r.popTotal),
          jobs:          r.jobsThreshold,
          jobsPct:       _pctValue(r.jobsThreshold, r.jobsTotal)
        }
      });
    }

    var geojson = {
      type: "FeatureCollection",
      metadata: {
        tool:                "Micro Analysis Tool",
        module:              "Transit Coverage",
        exportedAt:          new Date().toISOString(),
        geoLevel:            r.geoLevel,
        acsYear:             r.year,
        bufferMiles:         r.bufferMiles,
        dayType:             r.dayType,
        headwayThresholdMin: r.thresholdMin
      },
      features: features
    };

    _triggerDownload(
      JSON.stringify(geojson, null, 2),
      "application/geo+json",
      "transit-coverage-" + _dateStamp() + ".geojson"
    );
  }

  // ---- Popup lifecycle ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    // Geography level / ACS year
    var geoLevel = document.getElementById("tcGeoLevel");
    if (geoLevel) geoLevel.addEventListener("change", markStale);

    var yearSel = document.getElementById("tcYearSelect");
    if (yearSel) yearSel.addEventListener("change", markStale);

    // Coverage settings
    var bufferInput = document.getElementById("tcBufferMiles");
    if (bufferInput) bufferInput.addEventListener("change", markStale);
    var displayBuffersInput = document.getElementById("tcUseDisplayBuffers");
    if (displayBuffersInput) displayBuffersInput.addEventListener("change", function () {
      _useDisplayBuffers = displayBuffersInput.checked;
      syncBufferControl();
      markStale();
    });
    syncBufferControl();

    var dayTypeSel = document.getElementById("tcDayType");
    if (dayTypeSel) dayTypeSel.addEventListener("change", markStale);

    var thresholdInput = document.getElementById("tcHeadwayThreshold");
    if (thresholdInput) thresholdInput.addEventListener("change", markStale);

    // Transit features select all / clear
    var featSelectAll = document.getElementById("tcFeatSelectAll");
    if (featSelectAll) {
      featSelectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcFeatureList input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
        markStale();
      });
    }
    var featSelectNone = document.getElementById("tcFeatSelectNone");
    if (featSelectNone) {
      featSelectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcFeatureList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        markStale();
      });
    }

    // Service-area select all / clear
    var areaSelectAll = document.getElementById("tcAreaSelectAll");
    if (areaSelectAll) {
      areaSelectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcAreaList input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
        markStale();
      });
    }
    var areaSelectNone = document.getElementById("tcAreaSelectNone");
    if (areaSelectNone) {
      areaSelectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcAreaList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        markStale();
      });
    }

    // Analyze Coverage
    var runBtn = document.getElementById("tcRunBtn");
    if (runBtn) runBtn.addEventListener("click", runCoverage);

    // Exports
    var csvBtn = document.getElementById("tcExportCSV");
    if (csvBtn) csvBtn.addEventListener("click", exportCSV);
    var gjBtn = document.getElementById("tcExportGeoJSON");
    if (gjBtn) gjBtn.addEventListener("click", exportGeoJSON);
  }

  function onOpen(core) {
    buildFeatureChecklist();
    buildAreaChecklist();
    syncBufferControl();
    if (_savedSelections) applySelections(_savedSelections);
    updateLodesWarnings();
    renderInputs(_lastResult ? undefined : false);

    if (_lastResult) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      renderResults(_lastResult);
      setExportButtonsEnabled(!_stale);
    } else {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      setExportButtonsEnabled(false);
      App.renderModuleState({
        statusEl: "tcStatus", emptyEl: "tcEmptyState", empty: true, hint: emptyHint()
      });
    }
    if (_stale) markStale();
  }

  function onClose(core) {
    // State persists in closure.
  }

  function clearAll() {
    clearMapOverlay();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("tc-legend");
    _lastResult = null;
    _stale = false;
    if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      renderInputs(false);
      var resultsEl = document.getElementById("tcResults");
      if (resultsEl) resultsEl.style.display = "none";
      App.renderModuleState({
        statusEl: "tcStatus", emptyEl: "tcEmptyState", empty: true, hint: emptyHint()
      });
      setExportButtonsEnabled(false);
    }
  }

  async function update(core) {
    var noFeatures = (App.routes || []).length === 0 && (App.lines || []).length === 0;
    var noAreas    = (App.polygons || []).length === 0;
    if (_lastResult && (noFeatures || noAreas)) {
      clearAll();
    }
    if (!isPopupVisible()) return;
    buildFeatureChecklist();
    buildAreaChecklist();
    updateLodesWarnings();
    if (_lastResult) markStale();
  }

  // ---- Session persistence ----

  function saveTcState(mode) {
    var settings = {
      bufferMiles:      null,
      useDisplayBuffers: _useDisplayBuffers,
      dayType:          null,
      headwayThreshold: null,
      geoLevel:         null,
      year:             null
    };

    var bufferEl    = document.getElementById("tcBufferMiles");
    var dayTypeEl   = document.getElementById("tcDayType");
    var thresholdEl = document.getElementById("tcHeadwayThreshold");
    var geoLevelEl  = document.getElementById("tcGeoLevel");
    var yearEl      = document.getElementById("tcYearSelect");

    settings.bufferMiles = bufferEl ? parseFloat(bufferEl.value)
      : (_lastResult ? _lastResult.bufferMiles : null);
    settings.dayType = dayTypeEl ? dayTypeEl.value
      : (_lastResult ? _lastResult.dayType : null);
    if (thresholdEl) {
      var t = parseFloat(thresholdEl.value);
      settings.headwayThreshold = (Number.isFinite(t) && t > 0) ? t : null;
    } else {
      settings.headwayThreshold = _lastResult ? _lastResult.thresholdMin : null;
    }
    settings.geoLevel = geoLevelEl ? geoLevelEl.value
      : (_lastResult ? _lastResult.geoLevel : null);
    settings.year = yearEl ? yearEl.value
      : (_lastResult ? _lastResult.year : null);

    // Prefer the live checklist state if the popup is initialized.
    var selections;
    if (document.getElementById("tcFeatureList")) {
      var featSel = getSelectedFeatures();
      var areaSel = getSelectedAreas();
      selections = {
        routeIndices:   featSel.routeIndices,
        lineIndices:    featSel.lineIndices,
        polygonIndices: areaSel.polygonIndices
      };
    } else {
      selections = _savedSelections || { routeIndices: [], lineIndices: [], polygonIndices: [] };
    }

    var data = {
      version:     1,
      settings:    settings,
      selections:  JSON.parse(JSON.stringify(selections)),
      lastSummary: null
    };

    if (_lastResult) {
      data.lastSummary = {
        geoLevel:        _lastResult.geoLevel,
        year:            _lastResult.year,
        bufferMiles:     _lastResult.bufferMiles,
        useDisplayBuffers: _lastResult.useDisplayBuffers,
        dayType:         _lastResult.dayType,
        thresholdMin:    _lastResult.thresholdMin,
        popTotal:        _lastResult.popTotal,
        popCovered:      _lastResult.popCovered,
        popThreshold:    _lastResult.popThreshold,
        jobsTotal:       _lastResult.jobsTotal,
        jobsCovered:     _lastResult.jobsCovered,
        jobsThreshold:   _lastResult.jobsThreshold,
        headwayRows:     _lastResult.headwayRows || []
      };
    }

    return data;
  }

  function restoreTcState(data) {
    if (!data) return;

    if (data.selections) _savedSelections = data.selections;

    var settings = data.settings || {};

    var bufferEl    = document.getElementById("tcBufferMiles");
    var dayTypeEl   = document.getElementById("tcDayType");
    var thresholdEl = document.getElementById("tcHeadwayThreshold");
    var geoLevelEl  = document.getElementById("tcGeoLevel");
    var yearEl      = document.getElementById("tcYearSelect");

    if (bufferEl && Number.isFinite(settings.bufferMiles)) bufferEl.value = String(settings.bufferMiles);
    if (settings.useDisplayBuffers != null) _useDisplayBuffers = !!settings.useDisplayBuffers;
    syncBufferControl();
    if (dayTypeEl && settings.dayType)                      dayTypeEl.value = settings.dayType;
    if (thresholdEl) {
      thresholdEl.value = (settings.headwayThreshold != null) ? String(settings.headwayThreshold) : "";
    }
    if (geoLevelEl && settings.geoLevel) geoLevelEl.value = settings.geoLevel;
    if (yearEl && settings.year)         yearEl.value     = settings.year;

    if (!data.lastSummary) return;
    var s = data.lastSummary;

    _lastResult = {
      geoLevel:         s.geoLevel,
      year:             s.year,
      bufferMiles:      s.bufferMiles,
      useDisplayBuffers: !!s.useDisplayBuffers,
      dayType:          s.dayType,
      thresholdMin:     s.thresholdMin,
      popTotal:         s.popTotal,
      popCovered:       s.popCovered,
      popThreshold:     s.popThreshold,
      jobsTotal:        s.jobsTotal,
      jobsCovered:      s.jobsCovered,
      jobsThreshold:    s.jobsThreshold,
      headwayRows:      s.headwayRows || [],
      // Geometry is not persisted — Re-run regenerates it.
      coverageClipped:  null,
      thresholdClipped: null,
      serviceAreaUnion: null,
      featSel:          null,
      areaSel:          null
    };
    _stale = false;

    if (isPopupVisible()) {
      renderResults(_lastResult);
      setExportButtonsEnabled(true);
    }
  }

  // ---- Register as analysis module ----

  App.registerModule({
    id:         "transit-coverage",
    name:       "Transit Coverage",
    enabled:    true,
    popupWidth: 1000,
    // One width for both modes, under the 620px @container breakpoint — narrow,
    // stacked task panel in every state, never resizes on run (see the fuller
    // note in buffer-summary.js). 600 gives the coverage results table the most
    // room available without un-stacking.
    panelWidths: { setup: 600, results: 600 },
    popupHTML:  "projects/transit-coverage-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  async function (core) { await update(core); }
  });

  // Register with session cache
  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("transit-coverage", {
      collect: saveTcState,
      apply:   restoreTcState
    });
  }

})();
