// js/projects/mitigation-needs.js
// Wetland & Channel Mitigation Needs — MOCK analysis module (RFP demonstration).
// Registers as an analysis module, opens a 2-column popup, and scores HUC-6
// watersheds by a composite "mitigation demand" index rendered as a polygon
// choropleth. All data is hardcoded (window.MitigationNeedsData) — this is a
// visual prototype, not a live analysis. No Census/LODES/TPI dependency.
//
// Pattern mirrors corridor-scoring.js (settings | results, weights modal,
// ranked table with expandable factor breakdowns) and the TPI fill-choropleth.
// No public API. No session persistence (throwaway demo branch).

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Data ---------------------------------------------------------------

  function DATA() { return window.MitigationNeedsData || { factors: [], watersheds: [], meta: {} }; }
  function FACTORS() { return DATA().factors || []; }
  function WATERSHEDS() { return DATA().watersheds || []; }

  function getDefaultWeights() {
    var w = {};
    FACTORS().forEach(function (f) { w[f.id] = f.defaultWeight || 0; });
    return w;
  }

  // ---- Module-local state -------------------------------------------------

  var _weights        = getDefaultWeights();
  var _pendingWeights = null;          // temp copy while Adjust Weights modal is open
  var _resourceMode   = "wetland";     // "wetland" | "channel"
  var _selectedHucs   = null;          // Set of huc6 strings, or null = all
  var _lastResult     = null;          // { rows, mode, weights }
  var _stale          = false;
  var _running        = false;
  var _initialized    = false;

  // ---- DOM guard ----------------------------------------------------------

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "mitigation-needs";
  }

  // ---- Small helpers ------------------------------------------------------

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtInt(n) {
    return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
  }
  function fmtScore(n) { return Number.isFinite(n) ? n.toFixed(2) : "—"; }

  // Impact factor reads a mode-specific score; everything else is shared.
  function factorScore(ws, factorId, mode) {
    if (factorId === "impact") {
      return mode === "channel" ? ws.scores.impactChannel : ws.scores.impactWetland;
    }
    return ws.scores[factorId];
  }
  function impactLabel(mode) {
    return mode === "channel" ? "Anticipated Channel Impact" : "Anticipated Wetland Impact";
  }
  function rawImpact(ws, mode) {
    return mode === "channel" ? ws.channelImpactFt : ws.wetlandImpactAcres;
  }
  function rawImpactText(ws, mode) {
    return mode === "channel"
      ? fmtInt(ws.channelImpactFt) + " linear ft"
      : fmtInt(ws.wetlandImpactAcres) + " acres";
  }

  // Weighted 0–5 composite over factors with non-zero weight.
  function computeComposite(ws, weights, mode) {
    var num = 0, den = 0;
    FACTORS().forEach(function (f) {
      var w = weights[f.id] || 0;
      if (w <= 0) return;
      var s = factorScore(ws, f.id, mode);
      if (Number.isFinite(s)) { num += s * w; den += w; }
    });
    return den > 0 ? num / den : 0;
  }

  function classify(score) {
    if (!Number.isFinite(score)) return { label: "N/A",         pill: "pill na" };
    if (score >= 4.0)            return { label: "High",        pill: "pill high" };
    if (score >= 3.25)           return { label: "Medium-High", pill: "pill mh" };
    if (score >= 2.5)            return { label: "Medium",      pill: "pill med" };
    if (score >= 1.75)           return { label: "Low-Medium",  pill: "pill ml" };
    return                              { label: "Low",         pill: "pill low" };
  }

  // ---- Selection helpers --------------------------------------------------

  function selectedWatersheds() {
    var all = WATERSHEDS();
    if (!_selectedHucs) return all.slice();
    return all.filter(function (ws) { return _selectedHucs.has(ws.huc6); });
  }

  function readSelectionFromDOM() {
    var el = document.getElementById("mnWatershedList");
    if (!el) return;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return;
    var set = new Set();
    var allChecked = true;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) set.add(boxes[i].getAttribute("data-huc6"));
      else allChecked = false;
    }
    _selectedHucs = allChecked ? null : set;
  }

  // ---- Watershed checklist ------------------------------------------------

  function buildWatershedChecklist() {
    var el = document.getElementById("mnWatershedList");
    if (!el) return;
    el.innerHTML = "";
    WATERSHEDS().forEach(function (ws) {
      var checked = !_selectedHucs || _selectedHucs.has(ws.huc6);
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.setAttribute("data-huc6", ws.huc6);

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = ws.name;

      var badge = document.createElement("span");
      badge.className = "rf-feature-type-badge";
      badge.textContent = ws.huc6;

      lbl.addEventListener("click", function (e) { e.preventDefault(); cb.checked = !cb.checked; readSelectionFromDOM(); markStale(); });
      cb.addEventListener("change", function () { readSelectionFromDOM(); markStale(); });

      row.appendChild(cb); row.appendChild(lbl); row.appendChild(badge);
      el.appendChild(row);
    });
  }

  // ---- Weight sliders (inside modal) --------------------------------------

  function buildWeightSliders() {
    var container = document.getElementById("mnWeightSliders");
    if (!container) return;
    container.innerHTML = "";
    FACTORS().forEach(function (f) {
      var w = (_weights[f.id] != null) ? _weights[f.id] : (f.defaultWeight || 0);
      var row = document.createElement("div");
      row.className = "tpi-slider-row";
      row.innerHTML =
        '<label class="tpi-slider-label" title="' + escapeHTML(f.description || "") + '">' + escapeHTML(f.label) + '</label>' +
        '<input type="range" class="tpi-slider mn-slider" min="0" max="100" step="5" value="' + w + '" data-factor="' + f.id + '">' +
        '<input type="number" class="tpi-slider-value" id="mnW_' + f.id + '" value="' + w + '" min="0" max="100" step="1" data-factor="' + f.id + '">';
      container.appendChild(row);
      row.querySelector("input[type=range]").addEventListener("input", onModalSliderChange);
      row.querySelector("input[type=number]").addEventListener("change", onModalNumberChange);
    });
    updateModalWeightSum();
  }

  function syncSlidersToWeights(weights) {
    FACTORS().forEach(function (f) {
      var w = (weights[f.id] != null) ? weights[f.id] : 0;
      var slider = document.querySelector('.mn-slider[data-factor="' + f.id + '"]');
      var num    = document.getElementById("mnW_" + f.id);
      if (slider) slider.value = String(w);
      if (num)    num.value    = String(w);
    });
    updateModalWeightSum();
  }

  function onModalSliderChange(e) {
    if (!_pendingWeights) return;
    var id = e.target.getAttribute("data-factor");
    _pendingWeights[id] = parseInt(e.target.value, 10);
    var num = document.getElementById("mnW_" + id);
    if (num) num.value = String(_pendingWeights[id]);
    updateModalWeightSum();
  }
  function onModalNumberChange(e) {
    if (!_pendingWeights) return;
    var id = e.target.getAttribute("data-factor");
    var raw = parseInt(e.target.value, 10);
    var clamped = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
    e.target.value = String(clamped);
    _pendingWeights[id] = clamped;
    var slider = document.querySelector('.mn-slider[data-factor="' + id + '"]');
    if (slider) slider.value = String(clamped);
    updateModalWeightSum();
  }

  function updateModalWeightSum() {
    var weights = _pendingWeights || _weights;
    var sum = 0;
    FACTORS().forEach(function (f) { sum += (weights[f.id] || 0); });
    var sumEl   = document.getElementById("mnWeightSum");
    var warnEl  = document.getElementById("mnWeightWarn");
    var confirm = document.getElementById("mnWeightsConfirm");
    if (sumEl)   { sumEl.textContent = String(sum); sumEl.style.color = sum === 100 ? "" : "#e53e3e"; }
    if (warnEl)  warnEl.style.visibility = sum === 100 ? "hidden" : "visible";
    if (confirm) confirm.disabled = (sum !== 100);
    return sum;
  }

  function openWeightsModal() {
    _pendingWeights = Object.assign({}, _weights);
    syncSlidersToWeights(_pendingWeights);
    var m = document.getElementById("mnWeightsModal");
    if (m) m.style.display = "";
  }
  function closeWeightsModal(confirm) {
    var m = document.getElementById("mnWeightsModal");
    if (m) m.style.display = "none";
    if (confirm && _pendingWeights) {
      var changed = JSON.stringify(_weights) !== JSON.stringify(_pendingWeights);
      _weights = Object.assign({}, _pendingWeights);
      if (changed) {
        if (_lastResult) runScoring();   // instant re-score + recolor
        else markStale();
      }
    }
    _pendingWeights = null;
  }
  function resetModalToDefaults() {
    _pendingWeights = getDefaultWeights();
    syncSlidersToWeights(_pendingWeights);
  }

  // ---- Resource mode (Wetland / Channel toggle) ---------------------------

  function setResourceMode(mode) {
    if (mode !== "wetland" && mode !== "channel") return;
    if (mode === _resourceMode) return;
    _resourceMode = mode;
    var wrap = document.getElementById("mnResourceToggle");
    if (wrap) {
      wrap.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-mode") === mode);
      });
    }
    // Recolor + re-rank instantly from cached data (choropleth on demand).
    if (_lastResult) runScoring(false);
  }

  // ---- Status -------------------------------------------------------------

  function setStatus(msg, kind) {
    // kind: "" | "done" | "error" | "running" (stale is handled by markStale)
    App.renderModuleState({
      statusEl: "mnStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  // Onboarding/empty hint shown when there are no results.
  function emptyHint() {
    return { need: "Select watersheds and click Score.",
             action: "Each selected HUC-6 basin gets a ranked mitigation-demand score." };
  }

  function markStale() {
    _stale = true;
    setExportEnabled(false);
    if (isPopupVisible() && _lastResult) {
      App.renderModuleState({ statusEl: "mnStatus", stale: true, onRerun: function () { runScoring(); } });
    }
  }

  // ---- System factor averages (comparison baseline for breakdown bars) ----

  function computeSystemFactorAverages(rows, mode) {
    var avgs = {};
    FACTORS().forEach(function (f) {
      var sum = 0, n = 0;
      rows.forEach(function (r) {
        var s = factorScore(r.ws, f.id, mode);
        if (Number.isFinite(s)) { sum += s; n++; }
      });
      avgs[f.id] = n > 0 ? sum / n : NaN;
    });
    return avgs;
  }

  function buildFactorBreakdownHTML(row, systemAvgs, mode) {
    var html = '<div class="mn-detail-raw">' +
      escapeHTML(impactLabel(mode)) + ': <strong>' + rawImpactText(row.ws, mode) + '</strong>' +
      ' &nbsp;·&nbsp; HUC-6 ' + escapeHTML(row.ws.huc6) +
      ' &nbsp;·&nbsp; ' + row.ws.countyCount + ' counties</div>';
    html += '<div class="rf-route-factor-list">';
    FACTORS().forEach(function (f) {
      var w = _weights[f.id] || 0;
      if (w <= 0) return;
      var label = (f.id === "impact") ? impactLabel(mode) : f.label;
      var val   = factorScore(row.ws, f.id, mode);
      var sys   = systemAvgs[f.id];
      var vValid = Number.isFinite(val), sValid = Number.isFinite(sys);
      var barPct = vValid ? (val / 5) * 100 : 0;
      var sysPct = sValid ? (sys / 5) * 100 : 0;
      var diff   = (vValid && sValid) ? val - sys : 0;
      var color  = diff > 0.3 ? "#48bb78" : (diff < -0.3 ? "#f56565" : "#a0aec0");
      html += '<div class="rf-route-factor-row">' +
        '<span class="rf-route-factor-name" title="' + escapeHTML(f.description || label) + '">' + escapeHTML(label) + '</span>' +
        '<span class="rf-route-factor-weight tiny">' + Math.round(w) + '%</span>' +
        '<span class="rf-route-factor-bar-wrap">' +
          '<span class="rf-route-factor-bar" style="width:' + barPct.toFixed(0) + '%;background:' + color + ';" ' +
            'title="Watershed: ' + (vValid ? val.toFixed(1) : 'N/A') + ' / System avg: ' + (sValid ? sys.toFixed(1) : 'N/A') + '"></span>' +
          (sValid ? '<span class="rf-route-factor-sys-marker" style="left:' + sysPct.toFixed(0) + '%;" title="System avg: ' + sys.toFixed(1) + '"></span>' : '') +
        '</span>' +
        '<span class="rf-route-factor-score">' + (vValid ? val.toFixed(1) : 'N/A') + '</span>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  // ---- Results table ------------------------------------------------------

  function renderResultsTable(result) {
    var container   = document.getElementById("mnResultsTable");
    var resultsWrap = document.getElementById("mnResults");
    var emptyState  = document.getElementById("mnEmptyState");
    if (!container || !resultsWrap) return;

    var rows = (result && result.rows) || [];
    if (!rows.length) {
      resultsWrap.style.display = "none";
      container.innerHTML = "";
      App.renderModuleState({
        statusEl: "mnStatus", emptyEl: "mnEmptyState", empty: true, hint: emptyHint()
      });
      return;
    }
    if (emptyState) emptyState.style.display = "none";
    resultsWrap.style.display = "";

    var systemAvgs = computeSystemFactorAverages(rows, result.mode);
    var unitHead = result.mode === "channel" ? "Channel" : "Wetland";

    var html = '<table class="cs-results-table">' +
      '<thead><tr>' +
        '<th class="cs-col-rank">#</th>' +
        '<th class="cs-col-name">Watershed (HUC-6)</th>' +
        '<th class="cs-col-score" title="' + unitHead + ' mitigation demand index, 0–5">Demand</th>' +
        '<th class="cs-col-class">Classification</th>' +
        '<th class="cs-col-toggle" aria-label="Expand"></th>' +
      '</tr></thead><tbody>';

    rows.forEach(function (r, i) {
      var c = classify(r.score);
      html +=
        '<tr class="cs-row" data-index="' + i + '">' +
          '<td class="cs-rank">' + (i + 1) + '</td>' +
          '<td class="cs-name">' + escapeHTML(r.ws.name) +
            ' <span class="cs-feature-badge">' + escapeHTML(r.ws.huc6) + '</span></td>' +
          '<td class="cs-score">' + fmtScore(r.score) + '</td>' +
          '<td class="cs-class"><span class="' + c.pill + '">' + escapeHTML(c.label) + '</span></td>' +
          '<td class="cs-toggle"><span class="cs-caret">&#9656;</span></td>' +
        '</tr>' +
        '<tr class="cs-row-details" data-index="' + i + '" style="display:none;">' +
          '<td colspan="5"><div class="cs-details-body">' +
            buildFactorBreakdownHTML(r, systemAvgs, result.mode) +
          '</div></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;

    container.querySelectorAll("tr.cs-row").forEach(function (rowEl) {
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

  // ---- Map choropleth -----------------------------------------------------

  var MN_SOURCE     = "mn-choropleth";
  var MN_FILL_LAYER = "mn-choropleth-fill";
  var MN_LINE_LAYER = "mn-choropleth-line";
  var _hoverWired   = false;

  function buildFeatureCollection(result) {
    var features = (result.rows || []).map(function (r, i) {
      return {
        type: "Feature",
        geometry: r.ws.geometry,
        properties: {
          huc6:        r.ws.huc6,
          name:        r.ws.name,
          demandIndex: Number.isFinite(r.score) ? r.score : null,
          classification: classify(r.score).label,
          rawImpact:   rawImpactText(r.ws, result.mode),
          rank:        i + 1
        }
      };
    });
    return { type: "FeatureCollection", features: features };
  }

  function renderChoropleth(result, fit) {
    var map = App.map;
    if (!map || !result) return;
    var fc = buildFeatureCollection(result);

    var colorExpr = [
      "interpolate", ["linear"], ["coalesce", ["get", "demandIndex"], 0],
      0, "rgba(200,200,200,0.3)",
      1, "#eff3ff",
      2, "#bdd7e7",
      3, "#6baed6",
      4, "#3182bd",
      5, "#08519c"
    ];

    if (!map.getSource(MN_SOURCE)) {
      map.addSource(MN_SOURCE, { type: "geojson", data: fc });
      var beforeLayer = map.getLayer("buffers-fill") ? "buffers-fill" : undefined;
      map.addLayer({
        id: MN_FILL_LAYER, type: "fill", source: MN_SOURCE,
        paint: { "fill-color": colorExpr, "fill-opacity": 0.62 }
      }, beforeLayer);
      map.addLayer({
        id: MN_LINE_LAYER, type: "line", source: MN_SOURCE,
        paint: { "line-color": "#1a202c", "line-width": 0.8, "line-opacity": 0.45 }
      }, beforeLayer);

      if (!_hoverWired) {
        var hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        map.on("mousemove", MN_FILL_LAYER, function (e) {
          map.getCanvas().style.cursor = "default";
          if (!e.features || !e.features.length) return;
          var p = e.features[0].properties;
          var d = p.demandIndex != null ? Number(p.demandIndex).toFixed(2) : "N/A";
          var html = '<div style="font-size:12px;line-height:1.45;">' +
            '<b>#' + p.rank + ' &middot; ' + escapeHTML(p.name) + '</b> ' +
            '<span style="color:#666;">(HUC-6 ' + escapeHTML(p.huc6) + ')</span><br>' +
            '<b>Demand:</b> ' + d + ' / 5 &mdash; ' + escapeHTML(p.classification) + '<br>' +
            '<span style="color:#666;">' + escapeHTML(p.rawImpact) + '</span></div>';
          hover.setLngLat(e.lngLat).setHTML(html).addTo(map);
        });
        map.on("mouseleave", MN_FILL_LAYER, function () {
          map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "default";
          hover.remove();
        });
        _hoverWired = true;
      }
    } else {
      map.getSource(MN_SOURCE).setData(fc);
    }

    if (fit && window.turf && fc.features.length) {
      try {
        var b = turf.bbox(fc);
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 48, duration: 700 });
      } catch (e) { /* ignore */ }
    }
  }

  function clearChoropleth() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer(MN_FILL_LAYER)) map.removeLayer(MN_FILL_LAYER);
    if (map.getLayer(MN_LINE_LAYER)) map.removeLayer(MN_LINE_LAYER);
    if (map.getSource(MN_SOURCE))    map.removeSource(MN_SOURCE);
  }

  function showLegend() {
    if (!(App.popup && App.popup.showFloatingWidget)) return;
    var title = _resourceMode === "channel" ? "Channel Demand" : "Wetland Demand";
    // Remove + re-add so the header title reflects the current resource mode.
    if (App.popup.removeFloatingWidget) App.popup.removeFloatingWidget("mn-legend");
    App.popup.showFloatingWidget("mn-legend", "projects/mitigation-needs-legend.html", {
      position: "bottom-left", width: 188, title: title
    });
  }

  // ---- Exports ------------------------------------------------------------

  function _download(content, mime, filename) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function _stamp() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function _csv(v) {
    var s = String(v == null ? "" : v);
    return (/[",\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    if (!_lastResult) return;
    var mode = _lastResult.mode;
    var head = ["rank", "huc6", "watershed", "resource", "demand_index", "classification",
                "raw_impact_value", "raw_impact_unit"];
    FACTORS().forEach(function (f) { head.push((f.id === "impact" ? "anticipated_impact" : f.id) + "_score"); });
    var lines = ["# Micro Analysis Tool — Wetland & Channel Mitigation Needs (mock)",
                 "# Exported: " + new Date().toISOString(),
                 "# Resource mode: " + mode,
                 head.join(",")];
    _lastResult.rows.forEach(function (r, i) {
      var row = [i + 1, r.ws.huc6, _csv(r.ws.name), mode, fmtScore(r.score), classify(r.score).label,
                 rawImpact(r.ws, mode), (mode === "channel" ? "linear_ft" : "acres")];
      FACTORS().forEach(function (f) { row.push(factorScore(r.ws, f.id, mode)); });
      lines.push(row.join(","));
    });
    _download(lines.join("\n"), "text/csv", "mitigation-needs-" + mode + "-" + _stamp() + ".csv");
  }

  function exportGeoJSON() {
    if (!_lastResult) return;
    var fc = buildFeatureCollection(_lastResult);
    fc.metadata = {
      tool: "Micro Analysis Tool", module: "Wetland & Channel Mitigation Needs (mock)",
      resourceMode: _lastResult.mode, weights: _lastResult.weights, exportedAt: new Date().toISOString()
    };
    _download(JSON.stringify(fc, null, 2), "application/geo+json", "mitigation-needs-" + _lastResult.mode + "-" + _stamp() + ".geojson");
  }

  function setExportEnabled(on) {
    var csv = document.getElementById("mnExportCSV");
    var gj  = document.getElementById("mnExportGeoJSON");
    if (csv) csv.disabled = !on;
    if (gj)  gj.disabled  = !on;
    var toggleRow = document.getElementById("mnChoroplethToggleRow");
    if (toggleRow) toggleRow.style.display = on ? "" : "none";
  }

  // ---- Scoring flow -------------------------------------------------------

  function runScoring(fit) {
    if (_running) return;
    _running = true;
    if (fit === undefined) fit = true;
    var scoreBtn = document.getElementById("mnScoreBtn");
    if (scoreBtn) scoreBtn.disabled = true;

    try {
      readSelectionFromDOM();
      var pool = selectedWatersheds();
      if (!pool.length) {
        clearChoropleth();
        if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("mn-legend");
        // renderResultsTable shows the standardized onboarding/empty hint.
        renderResultsTable({ rows: [], mode: _resourceMode });
        setExportEnabled(false);
        return;
      }

      var rows = pool.map(function (ws) {
        return { ws: ws, score: computeComposite(ws, _weights, _resourceMode) };
      }).sort(function (a, b) { return b.score - a.score; });

      _lastResult = { rows: rows, mode: _resourceMode, weights: Object.assign({}, _weights) };
      _stale = false;

      var resName = _resourceMode === "channel" ? "channel" : "wetland";
      setStatus("Scored " + rows.length + " HUC-6 watershed" + (rows.length === 1 ? "" : "s") +
                " by " + resName + " mitigation demand.", "done");

      renderResultsTable(_lastResult);
      renderChoropleth(_lastResult, fit);
      showLegend();
      setExportEnabled(true);
    } catch (err) {
      console.error("Mitigation Needs error:", err);
      setStatus("Error: " + (err.message || err), "error");
    } finally {
      _running = false;
      if (scoreBtn) scoreBtn.disabled = false;
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    // Resource toggle
    var toggle = document.getElementById("mnResourceToggle");
    if (toggle) {
      toggle.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () { setResourceMode(b.getAttribute("data-mode")); });
      });
    }

    // Select all / clear
    var selAll = document.getElementById("mnSelectAll");
    if (selAll) selAll.addEventListener("click", function (e) {
      e.preventDefault();
      document.querySelectorAll("#mnWatershedList input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
      readSelectionFromDOM(); markStale();
    });
    var selNone = document.getElementById("mnSelectNone");
    if (selNone) selNone.addEventListener("click", function (e) {
      e.preventDefault();
      document.querySelectorAll("#mnWatershedList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
      readSelectionFromDOM(); markStale();
    });

    // Weights modal
    var wBtn = document.getElementById("mnWeightsBtn");
    if (wBtn) wBtn.addEventListener("click", openWeightsModal);
    var wConfirm = document.getElementById("mnWeightsConfirm");
    if (wConfirm) wConfirm.addEventListener("click", function () { closeWeightsModal(true); });
    var wCancel = document.getElementById("mnWeightsCancel");
    if (wCancel) wCancel.addEventListener("click", function () { closeWeightsModal(false); });
    var wReset = document.getElementById("mnResetWeights");
    if (wReset) wReset.addEventListener("click", resetModalToDefaults);

    // Score
    var scoreBtn = document.getElementById("mnScoreBtn");
    if (scoreBtn) scoreBtn.addEventListener("click", function () { runScoring(true); });

    // Exports
    var csv = document.getElementById("mnExportCSV");
    if (csv) csv.addEventListener("click", exportCSV);
    var gj = document.getElementById("mnExportGeoJSON");
    if (gj) gj.addEventListener("click", exportGeoJSON);

    // Hide coloring
    var hide = document.getElementById("mnHideColoring");
    if (hide) hide.addEventListener("change", function () {
      var vis = hide.checked ? "none" : "visible";
      var map = App.map;
      if (map.getLayer(MN_FILL_LAYER)) map.setLayoutProperty(MN_FILL_LAYER, "visibility", vis);
      if (map.getLayer(MN_LINE_LAYER)) map.setLayoutProperty(MN_LINE_LAYER, "visibility", vis);
      if (hide.checked) { if (App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("mn-legend"); }
      else showLegend();
    });

    buildWeightSliders();
  }

  function onOpen(core) {
    // Reflect resource mode + selection in the UI
    var toggle = document.getElementById("mnResourceToggle");
    if (toggle) toggle.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-mode") === _resourceMode);
    });
    buildWatershedChecklist();

    if (_lastResult) {
      renderResultsTable(_lastResult);
      setExportEnabled(!_stale);
      if (_stale) markStale();
    } else {
      setExportEnabled(false);
      App.renderModuleState({
        statusEl: "mnStatus", emptyEl: "mnEmptyState", empty: true, hint: emptyHint()
      });
    }
  }

  function onClose(core) { /* state persists in closure */ }

  function clearAll() {
    clearChoropleth();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("mn-legend");
    _lastResult = null;
    _stale = false;
    _selectedHucs = null;
    if (isPopupVisible()) {
      var results = document.getElementById("mnResults");
      if (results) results.style.display = "none";
      App.renderModuleState({
        statusEl: "mnStatus", emptyEl: "mnEmptyState", empty: true, hint: emptyHint()
      });
      var hide = document.getElementById("mnHideColoring");
      if (hide) hide.checked = false;
      buildWatershedChecklist();
      setExportEnabled(false);
    }
  }

  function update(core) {
    // Mock module — no dependency on drawn features. Nothing to refresh.
  }

  // ---- Register -----------------------------------------------------------

  App.registerModule({
    id:         "mitigation-needs",
    name:       "Wetland & Channel Mitigation Needs",
    enabled:    true,
    popupWidth: 1020,
    popupHTML:  "projects/mitigation-needs-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  function (core) { update(core); }
  });

})();
