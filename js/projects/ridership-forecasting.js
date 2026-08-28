// js/projects/ridership-forecasting.js
// Ridership Forecasting module: registers as an analysis module,
// opens in a popup with 4-tab layout (Demand, Calibrate, Elasticity, Scenarios).
// Depends on: App namespace, RidershipModel (ridership-scoring.js), TPI (tpi-scoring.js),
//             App.popup (popup.js), turf (CDN).
// Exports: none (self-registers via App.registerModule)

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var RM = window.RidershipModel;
  var TPI = window.TPI;

  // ---- RF-specific default weights (independent from TPI defaults) ----
  // Population and employment density are the primary demand drivers for corridor analysis.
  // Equity/transit-dependence factors are intentionally excluded (weight = 0) by default.
  var RF_DEFAULT_WEIGHTS = {
    pop_density: 50,
    employment:  50,
    zero_car:     0,
    poverty:      0,
    senior:       0,
    disability:   0,
    poc:          0,
    youth:        0,
    lep:          0
  };

  // ---- Module-local state ----

  var _lastResult = null;       // last computeCorridorDemand result
  var _weights = Object.assign({}, RF_DEFAULT_WEIGHTS);
  var _stale = false;
  var _running = false;
  var _initialized = false;
  var _apportionByArea = false;
  var _bufferMiles = App.ANALYSIS_BUFFER_DEFAULT_MILES; // module-owned analysis distance (Calibrate tab, shared with Demand)
  var _useDisplayBuffers = false;
  var _normalizeByLength = false;
  var _baselineUncertaintyPct = 0.25; // ±25% model uncertainty around calibrated baseline
  var _spanElasticity = 0.70; // span-to-ridership elasticity (power curve); applied per-scenario in Scenarios tab
  // User-adjustable service type premiums (low, high per service type; mid = avg)
  var _servicePremiums = {
    local_bus:    { low: 0.00, high: 0.00 },
    enhanced_bus: { low: 0.05, high: 0.15 },
    limited_stop: { low: 0.00, high: 0.10 },
    brt:          { low: 0.05, high: 0.25 }
  };
  var _calibration = null;      // { factor, n, rSquared, ... }
  var _calibData = null;        // parsed CSV rows
  var _scenarios = [{}, {}, {}, {}]; // 4 scenario parameter sets
  var _activeScenario = 0;
  var _activeTab = "calibrate";

  // System-wide calibration state
  var _systemResult = null;      // result from RM.computeSystemDemand() (calibration context)
  var _perRouteCDI = null;       // per-route CDI array (calibration context)
  var _matchResult = null;       // result from RM.matchRoutesToCSV()
  var _selectedCorridor = ""; // "route:N" / "line:N" (specific corridor required)
  var _calibFeatureFilter = null; // { routeIndices: [...], lineIndices: [...] } or null (all)

  // Demand-phase state (independent TPI context when analyzing a different system)
  var _demandSystemResult = null;  // result from demand-phase RM.computeSystemDemand()
  var _demandPerRouteCDI = null;   // per-route CDI array (demand context)
  var _demandFeatureFilter = null; // { routeIndices: [...], lineIndices: [...] } or null
  var _demandUseSameSystem = false; // true = reuse calibration TPI data for demand

  // Shared-pool normalization state
  var _sharedPoolMode = false;          // true = combined calibration+demand normalization pool
  var _sharedCalibPerRouteCDI = null;   // calibration-context CDI from most recent shared run
  var _sharedSystemResult = null;       // full TPI result from most recent shared run

  // Projection state
  var _projectionResults = null; // array of { year, cdi, scenarios } or null
  var _projectionYears = ["2030", "2040", "2050"];

  // Default scenario names
  var SCENARIO_NAMES = ["Scenario A", "Scenario B", "Scenario C", "Scenario D"];
  for (var si = 0; si < 4; si++) {
    _scenarios[si] = {
      name: SCENARIO_NAMES[si],
      serviceTypeId: "local_bus",
      headway: 30,
      span: 14,
      avgSpeed: 15,
      costPerRevenueHour: 150,
      serviceDaysPerYear: 260
    };
  }

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup.isOpen() && App.popup.currentModuleId() === "ridership-forecasting";
  }

  // Sync premium slider values to the stored premiums for a given service type ID.
  function syncPremiumSliders(stId) {
    var prem = _servicePremiums[stId] || { low: 0, high: 0 };
    var lowPct  = Math.round(prem.low  * 100);
    var highPct = Math.round(prem.high * 100);
    var slLow  = document.getElementById("rfServicePremLow");
    var inLow  = document.getElementById("rfServicePremLowVal");
    var slHigh = document.getElementById("rfServicePremHigh");
    var inHigh = document.getElementById("rfServicePremHighVal");
    if (slLow)  slLow.value  = String(lowPct);
    if (inLow)  inLow.value  = String(lowPct);
    if (slHigh) slHigh.value = String(highPct);
    if (inHigh) inHigh.value = String(highPct);
  }

  // ---- Weight modal (Adjust Weights) ----

  var _pendingWeights = null;   // temporary weight copy while modal is open
  var _confirmCallback = null;  // pending analysis to run on modal confirm
  var _calibChartMouseMove  = null; // canvas tooltip listener refs
  var _calibChartMouseLeave = null;

  function buildRFWeightSliders(weights) {
    var container = document.getElementById("rfWeightSliders");
    if (!container) return;
    container.innerHTML = "";

    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = weights[f.id] != null ? weights[f.id] : f.defaultWeight;

      var row = document.createElement("div");
      row.className = "tpi-slider-row";
      row.innerHTML =
        '<label class="tpi-slider-label" title="' + f.description + '">' + f.label + '</label>' +
        '<input type="range" class="tpi-slider rf-w-slider" min="0" max="100" step="5" value="' + w + '" data-factor="' + f.id + '" />' +
        '<input type="number" class="tpi-slider-value" id="rfW_' + f.id + '" value="' + w + '" min="0" max="100" step="1" data-factor="' + f.id + '" />';
      container.appendChild(row);

      var slider = row.querySelector("input[type=range]");
      slider.addEventListener("input", onRFSliderChange);
      var numInput = row.querySelector("input[type=number]");
      numInput.addEventListener("change", onRFNumberChange);
    }

    updateRFWeightSum();
  }

  function onRFSliderChange(e) {
    if (!_pendingWeights) return;
    var factorId = e.target.getAttribute("data-factor");
    _pendingWeights[factorId] = parseInt(e.target.value, 10);
    var numInput = document.getElementById("rfW_" + factorId);
    if (numInput) numInput.value = String(_pendingWeights[factorId]);
    updateRFWeightSum();
  }

  function onRFNumberChange(e) {
    if (!_pendingWeights) return;
    var factorId = e.target.getAttribute("data-factor");
    var raw = parseInt(e.target.value, 10);
    var clamped = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
    e.target.value = String(clamped);
    _pendingWeights[factorId] = clamped;
    var slider = document.querySelector('.rf-w-slider[data-factor="' + factorId + '"]');
    if (slider) slider.value = String(clamped);
    updateRFWeightSum();
  }

  function updateRFWeightSum() {
    if (!_pendingWeights) return;
    var sum = 0;
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      sum += (_pendingWeights[factors[i].id] || 0);
    }
    var sumEl  = document.getElementById("rfWeightSum");
    var warnEl = document.getElementById("rfWeightWarn");
    var confirmBtn = document.getElementById("rfWeightsConfirm");
    if (sumEl) {
      sumEl.textContent = String(sum);
      sumEl.style.color = (sum === 100) ? "" : "#e53e3e";
    }
    var valid = (sum === 100);
    if (warnEl) warnEl.style.visibility = valid ? "hidden" : "visible";
    if (confirmBtn) confirmBtn.disabled = !valid;
    return sum;
  }

  function applyWeightsToModalSliders(weights) {
    var factors = TPI.FACTORS;
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = weights[f.id] != null ? weights[f.id] : f.defaultWeight;
      _pendingWeights[f.id] = w;
      var slider = document.querySelector('.rf-w-slider[data-factor="' + f.id + '"]');
      if (slider) slider.value = String(w);
      var numInput = document.getElementById("rfW_" + f.id);
      if (numInput) numInput.value = String(w);
    }
    updateRFWeightSum();
  }

  function openWeightsModal() {
    _pendingWeights = Object.assign({}, _weights);
    var modal = document.getElementById("rfWeightsModal");
    if (!modal) return;
    // Build sliders if not yet built (first open)
    var container = document.getElementById("rfWeightSliders");
    if (!container || container.innerHTML === "") {
      buildRFWeightSliders(_pendingWeights);
    } else {
      // Sync existing sliders to current _weights
      applyWeightsToModalSliders(_pendingWeights);
    }
    modal.style.display = "";
  }

  function closeWeightsModal() {
    var modal = document.getElementById("rfWeightsModal");
    if (modal) modal.style.display = "none";
    _pendingWeights = null;
  }

  // ---- Analysis confirmation modal ----

  function buildConfirmRow(label, value, warn) {
    var valStyle = warn ? "color:#e53e3e; font-weight:600;" : "";
    return "<tr>" +
      "<td style=\"padding:4px 12px 4px 0; color:var(--muted); white-space:nowrap;" +
            " vertical-align:top; font-size:12px;\">" + label + "</td>" +
      "<td style=\"padding:4px 0; font-size:12px; font-weight:500;" + valStyle + "\">" +
            value + "</td>" +
      "</tr>";
  }

  function countCheckedFeatures(containerId) {
    var cbs = document.querySelectorAll("#" + containerId + " input[type=\"checkbox\"]:checked");
    var r = 0, l = 0;
    for (var i = 0; i < cbs.length; i++) {
      if (cbs[i].getAttribute("data-feature-type") === "route") r++;
      else l++;
    }
    return { routes: r, lines: l, total: r + l };
  }

  function formatFeatLabel(counts) {
    return counts.routes + " route" + (counts.routes !== 1 ? "s" : "") +
      ", " + counts.lines + " line" + (counts.lines !== 1 ? "s" : "");
  }

  function getSelectText(id) {
    var el = document.getElementById(id);
    if (!el || !el.options.length) return "\u2014";
    return el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value;
  }

  function buildCalibConfirmHTML() {
    var counts = countCheckedFeatures("rfCalibFeatureList");
    var lodesLoaded = !!App.lodesData;
    var lodesVal = lodesLoaded
      ? "Loaded (" + (App.lodesFileName || "file") + ")"
      : "Not loaded \u2014 Employment factor will be excluded";
    var apportionEl = document.getElementById("rfCalibApportionByArea");
    var normEl      = document.getElementById("rfCalibNormalizeByLength");

    return "<table style=\"width:100%; border-collapse:collapse;\">" +
      buildConfirmRow("LODES Employment",    lodesVal,                                 !lodesLoaded) +
      buildConfirmRow("Census Geometry",     getSelectText("rfCalibGeoLevel")) +
      buildConfirmRow("ACS Year",            getSelectText("rfCalibYearSelect")) +
      buildConfirmRow("Features Selected",   formatFeatLabel(counts),                  counts.total === 0) +
      buildConfirmRow("Apportion by Area",   apportionEl && apportionEl.checked ? "Yes" : "No") +
      buildConfirmRow("Normalize by Length", normEl      && normEl.checked      ? "Yes" : "No") +
      "</table>";
  }

  function buildDemandConfirmHTML() {
    var sameSystemEl  = document.getElementById("rfDemandUseSameSystem");
    var useSameSystem = sameSystemEl && sameSystemEl.checked;
    var featsVal      = useSameSystem
      ? "Same as calibration system"
      : formatFeatLabel(countCheckedFeatures("rfDemandFeatureList"));

    var lodesLoaded = !!App.lodesData;
    var lodesVal = lodesLoaded
      ? "Loaded (" + (App.lodesFileName || "file") + ")"
      : "Not loaded \u2014 Employment factor will be excluded";

    var apportionEl  = document.getElementById("rfApportionByArea");
    var sharedPoolEl = document.getElementById("rfSharedPoolMode");
    var segLenEl     = document.getElementById("rfSegmentLength");
    var segLen       = segLenEl ? (segLenEl.value + " mi") : "\u2014";

    var html = "<table style=\"width:100%; border-collapse:collapse;\">" +
      buildConfirmRow("LODES Employment",  lodesVal,  !lodesLoaded) +
      buildConfirmRow("Census Geometry",   getSelectText("rfGeoLevel")) +
      buildConfirmRow("ACS Year",          getSelectText("rfYearSelect")) +
      buildConfirmRow("Features Selected", featsVal) +
      buildConfirmRow("Apportion by Area", apportionEl && apportionEl.checked ? "Yes" : "No");

    if (!useSameSystem) {
      html += buildConfirmRow("Shared Pool Normalization",
                              sharedPoolEl && sharedPoolEl.checked ? "Yes" : "No");
    }

    html +=
      buildConfirmRow("Analysis Corridor", getSelectText("rfCorridorSelect")) +
      buildConfirmRow("Segment Length",    segLen) +
      "</table>";

    return html;
  }

  function showAnalysisConfirm(bodyHtml, onConfirm) {
    var modal = document.getElementById("rfAnalysisConfirmModal");
    var body  = document.getElementById("rfConfirmModalBody");
    if (!modal || !body) { onConfirm(); return; } // graceful fallback if modal missing
    body.innerHTML = bodyHtml;
    _confirmCallback = onConfirm;
    modal.style.display = "";
  }

  function closeConfirmModal() {
    var modal = document.getElementById("rfAnalysisConfirmModal");
    if (modal) modal.style.display = "none";
    _confirmCallback = null;
  }

  // ---- Tab management ----

  function switchTab(tabId) {
    _activeTab = tabId;
    if (!isPopupVisible()) return;

    var tabs = document.querySelectorAll(".rf-tab");
    var contents = document.querySelectorAll(".rf-tab-content");

    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute("data-tab") === tabId) {
        t.classList.add("rf-tab-active");
      } else {
        t.classList.remove("rf-tab-active");
      }
    }
    for (var j = 0; j < contents.length; j++) {
      var c = contents[j];
      if (c.getAttribute("data-tab") === tabId) {
        c.classList.add("rf-tab-visible");
      } else {
        c.classList.remove("rf-tab-visible");
      }
    }

    // Refresh active tab content
    if (tabId === "elasticity") refreshElasticity();
  }

  function buildRouteLineBufferSet(filter) {
    return _useDisplayBuffers
      ? App.buildDisplayBufferSet(filter)
      : App.buildAnalysisBufferSet(filter, _bufferMiles);
  }

  function syncBufferControl() {
    var input = document.getElementById("rfBufferMiles");
    var toggle = document.getElementById("rfUseDisplayBuffers");
    if (input) {
      input.value = String(_bufferMiles);
      input.disabled = _useDisplayBuffers;
    }
    if (toggle) toggle.checked = _useDisplayBuffers;
  }

  // ---- Layer 1: Demand ----

  // Run a single combined TPI analysis for both calibration and demand feature sets.
  // Ensures both systems' CDI values are scored from the same normalization pool.
  // Updates _demandPerRouteCDI, _demandSystemResult, _sharedCalibPerRouteCDI, _sharedSystemResult.
  // If match data is available, refits calibration from the new shared-pool CDI values.
  async function runSharedPoolAnalysis(geoLevel, year, textEl) {
    // Read the current demand filter from the UI
    var demandFilter = readFeatureFilter("rfDemandFeatureList");
    _demandFeatureFilter = demandFilter;

    // Buffer set for ALL drawn routes/lines (module's own analysis distance) —
    // computePerRouteCDI needs every feature's buffer so featureFilter:null
    // below can compute CDI for all of them, exactly as before this module
    // carried its own buffer distance; only the geometry source changed.
    var allBufferSet = buildRouteLineBufferSet(allRoutesLinesFilter());

    // Study area union is scoped to the combined calibration+demand selection —
    // fold only that subset's polygons out of the already-built full set.
    var combinedFilter = combineFeatureFilters(_calibFeatureFilter, demandFilter);
    var combinedPolys = [];
    (combinedFilter.routeIndices || []).forEach(function (idx) {
      var b = allBufferSet.get("route", idx); if (b) combinedPolys.push(b);
    });
    (combinedFilter.lineIndices || []).forEach(function (idx) {
      var b = allBufferSet.get("line", idx); if (b) combinedPolys.push(b);
    });
    var sharedUnion = App.foldAnalysisUnion(combinedPolys);

    if (textEl) textEl.textContent = "Running shared pool analysis...";
    App.setStatus("Running shared pool normalization analysis...");

    // One TPI run covering all combined features; featureFilter:null = compute CDI for all routes
    var result = await RM.computeSystemDemand({
      geoLevel: geoLevel,
      year: year,
      weights: _weights,
      lodesData: App.lodesData,
      apportionByArea: _apportionByArea,
      growthFactors: App.projGrowthFactors(),
      unionPolygon: sharedUnion,
      featureFilter: null,
      bufferSet: allBufferSet,
      onProgress: function (msg) {
        if (textEl) textEl.textContent = msg;
        App.setStatus(msg);
      }
    });

    result.bufferMiles = _bufferMiles;
    result.bufferSet   = allBufferSet;

    // Partition result.routeCDIs by filter
    _sharedCalibPerRouteCDI = filterRouteCDIs(result.routeCDIs, _calibFeatureFilter);
    _demandPerRouteCDI      = filterRouteCDIs(result.routeCDIs, demandFilter);
    _sharedSystemResult     = result;
    _demandSystemResult     = result;

    // Refit calibration from shared-pool CDI values if match data exists
    if (_matchResult && _matchResult.matched.length >= 3) {
      var newCalib = refitCalibrationFromCDI(_sharedCalibPerRouteCDI);
      if (newCalib) {
        _calibration = newCalib;
        if (isPopupVisible()) {
          var factorEl = document.getElementById("rfCalibFactor");
          if (factorEl) factorEl.textContent = _calibration.factor.toFixed(4);
          var r2El = document.getElementById("rfCalibRSquared");
          if (r2El) r2El.textContent = _calibration.rSquared != null ? _calibration.rSquared.toFixed(4) : "\u2014";
          var sizeEl = document.getElementById("rfCalibSampleSize");
          if (sizeEl) sizeEl.textContent = String(_calibration.n);
          var spNoteEl = document.getElementById("rfCalibSharedPoolNote");
          if (spNoteEl) {
            spNoteEl.style.display = "";
            spNoteEl.textContent = "Calibration refitted using shared-pool CDI values " +
              "(factor: " + _calibration.factor.toFixed(4) + ", n=" + _calibration.n + ").";
          }
        }
      }
    }

    return result;
  }

  async function runDemand() {
    if (_running) return;
    _running = true;

    var runBtn = document.getElementById("rfRunDemand");
    if (runBtn) runBtn.disabled = true;
    App.renderModuleState({ statusEl: "rfDemandStatus", status: { kind: "running", message: "Running…" } });
    var textEl = document.getElementById("rfDemandStatusText");

    // Show/hide uncalibrated warning
    var uncalibWarn = document.getElementById("rfUncalibratedWarning");
    if (uncalibWarn) uncalibWarn.style.display = _systemResult ? "none" : "";

    try {
      var geoLevel = document.getElementById("rfGeoLevel").value;
      var year = document.getElementById("rfYearSelect").value;
      var segLen = parseFloat(document.getElementById("rfSegmentLength").value) || 0;
      _bufferMiles = App.readAnalysisBufferMiles("rfBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
      _useDisplayBuffers = !!(document.getElementById("rfUseDisplayBuffers") || {}).checked;

      // Warn if demand settings differ from calibration settings
      if (_systemResult) {
        var mismatches = [];
        if (_systemResult.geoLevel && geoLevel !== _systemResult.geoLevel)
          mismatches.push("Geography level: calibration used " + _systemResult.geoLevel + ", demand uses " + geoLevel);
        if (_systemResult.year && year !== _systemResult.year)
          mismatches.push("ACS Year: calibration used " + _systemResult.year + ", demand uses " + year);
        var calibApportioned = _systemResult.tpiResult && _systemResult.tpiResult.apportionByArea;
        if (!!calibApportioned !== !!_apportionByArea)
          mismatches.push("Apportion by Area: calibration " + (calibApportioned ? "on" : "off") + ", demand " + (_apportionByArea ? "on" : "off"));
        if (mismatches.length > 0) {
          var proceed = confirm("Demand settings differ from calibration:\n\n" +
            mismatches.join("\n") +
            "\n\nUsing different settings may make calibration and demand results less comparable.\nProceed anyway?");
          if (!proceed) {
            _running = false;
            if (runBtn) runBtn.disabled = false;
            App.renderModuleState({ statusEl: "rfDemandStatus" });
            return;
          }
        }
      }

      var result;
      var tpiResult;
      var activeRouteCDIs;

      // Determine which path to take for TPI data:
      // Path A: "Same system as calibration" — reuse calibration TPI data
      // Path B: Different system — run a fresh TPI for the demand features
      // Path C: Uncalibrated fallback — run fresh TPI for all features (legacy)

      var sameSystemCb = document.getElementById("rfDemandUseSameSystem");
      var useSameSystem = sameSystemCb && sameSystemCb.checked;
      var useSharedPool = _sharedPoolMode && !useSameSystem && !!_systemResult;

      if (useSameSystem && _systemResult && _systemResult.tpiResult) {
        // Path A: Same system — reuse calibration TPI data (no Census API calls)
        if (textEl) textEl.textContent = "Using calibration system data...";
        App.setStatus("Computing corridor demand from calibration data...");
        tpiResult = _systemResult.tpiResult;
        activeRouteCDIs = _perRouteCDI;
        _demandPerRouteCDI = _perRouteCDI;
        _demandSystemResult = _systemResult;

      } else if (useSharedPool) {
        // Path B-shared: combined normalization pool (one TPI run covers both systems)
        var sharedResult = await runSharedPoolAnalysis(geoLevel, year, textEl);
        tpiResult = sharedResult.tpiResult;
        activeRouteCDIs = _demandPerRouteCDI;
        populateCorridorDropdownFromCheckedFeatures();

      } else if (_systemResult && _systemResult.tpiResult) {
        // Path B: Different system — run fresh TPI for demand features
        var demandFilter = readFeatureFilter("rfDemandFeatureList");
        _demandFeatureFilter = demandFilter;

        var demandBufferSet = buildRouteLineBufferSet(demandFilter);
        if (demandBufferSet.count === 0) {
          throw new Error("Could not build buffers for the selected demand features.");
        }

        var customUnion = demandBufferSet.union;

        if (textEl) textEl.textContent = "Running demand system analysis...";
        App.setStatus("Analyzing demand system...");

        var demandSystemResult = await RM.computeSystemDemand({
          geoLevel: geoLevel,
          year: year,
          weights: _weights,
          lodesData: App.lodesData,
          apportionByArea: _apportionByArea,
          growthFactors: App.projGrowthFactors(),
          unionPolygon: customUnion,
          featureFilter: demandFilter,
          bufferSet: demandBufferSet,
          onProgress: function (msg) {
            if (textEl) textEl.textContent = msg;
            App.setStatus(msg);
          }
        });

        demandSystemResult.bufferMiles = _bufferMiles;
        demandSystemResult.bufferSet   = demandBufferSet;

        _demandSystemResult = demandSystemResult;
        _demandPerRouteCDI = demandSystemResult.routeCDIs;
        tpiResult = demandSystemResult.tpiResult;
        activeRouteCDIs = demandSystemResult.routeCDIs;

        // Populate corridor dropdown with demand system routes
        populateCorridorDropdownFromCheckedFeatures();

      } else {
        // Path C: Uncalibrated — run fresh TPI for all features (legacy behavior).
        // This predates the featureFilter/calibration system and intentionally
        // keeps using TPI's own global-buffer fallback for the study area — only
        // its segment buffering is brought onto the module's own distance.
        result = await RM.computeCorridorDemand({
          geoLevel: geoLevel,
          year: year,
          weights: _weights,
          lodesData: App.lodesData,
          apportionByArea: _apportionByArea,
          growthFactors: App.projGrowthFactors(),
          segmentMiles: segLen,
          segmentBufferMiles: _bufferMiles,
          onProgress: function (msg) {
            if (textEl) textEl.textContent = msg;
            App.setStatus(msg);
          }
        });
      }

      // For Path A and B, build the result object from TPI data
      if (!result && tpiResult) {
        var displayCDI;
        if (_selectedCorridor && activeRouteCDIs) {
          var parts = _selectedCorridor.split(":");
          var selType = parts[0];
          var selIdx = parseInt(parts[1], 10);
          for (var pi = 0; pi < activeRouteCDIs.length; pi++) {
            if (activeRouteCDIs[pi].featureType === selType && activeRouteCDIs[pi].featureIndex === selIdx) {
              displayCDI = { value: activeRouteCDIs[pi].cdi, scored: activeRouteCDIs[pi].geoCount, total: activeRouteCDIs[pi].geoCount };
              break;
            }
          }
        }
        if (!displayCDI) {
          displayCDI = { value: NaN, scored: 0, total: 0 };
        }

        var segments = [];
        if (segLen > 0 && RM.computeSegments) {
          if (textEl) textEl.textContent = "Computing segments...";
          App.setStatus("Computing segments...");
          segments = RM.computeSegments(tpiResult, segLen, _selectedCorridor, _bufferMiles);
        }

        result = {
          tpiResult: tpiResult,
          corridorCDI: displayCDI,
          segments: segments,
          classification: RM.classifyCDI(displayCDI),
          geoLevel: geoLevel,
          year: year,
          bufferMiles: _bufferMiles
        };
      }

      _lastResult = result;
      _stale = false;
      _demandStale = false;

      // Render choropleth
      var tpi = result.tpiResult;
      App.renderCensusOverlay(tpi.apportionByArea && tpi.clippedGeos ? tpi.clippedGeos : tpi.geos);
      renderChoropleth(result);

      // Show legend
      App.popup.showFloatingWidget("rf-legend", "projects/ridership-legend.html", {
        position: "bottom-left",
        width: 170,
        title: "Demand Legend"
      });

      // Render corridor CDI lines (colored by per-route CDI score)
      renderCorridorCDILines(_demandPerRouteCDI || _perRouteCDI);

      displayDemandResults(result);

      App.renderModuleState({ statusEl: "rfDemandStatus", status: { kind: "done", message: "Demand analysis complete." } });
      App.setStatus("Demand analysis complete");

      // Enable exports
      var expGJ = document.getElementById("rfExportDemandGeoJSON");
      var expCSV = document.getElementById("rfExportDemandCSV");
      if (expGJ) expGJ.disabled = false;
      if (expCSV) expCSV.disabled = false;

      // Enable "Include Shared Pool" toggle only when shared pool data exists
      var spToggle = document.getElementById("rfExportIncludeSharedPool");
      if (spToggle) {
        spToggle.disabled = !_sharedCalibPerRouteCDI;
        if (!_sharedCalibPerRouteCDI) spToggle.checked = false;
      }

      // Show next step guidance
      var nextStep = document.getElementById("rfNextStep1");
      if (nextStep) nextStep.style.display = "";

    } catch (err) {
      console.error("Ridership demand error:", err);
      App.renderModuleState({ statusEl: "rfDemandStatus", status: { kind: "error", message: "Error: " + (err.message || err) } });
      App.setStatus("Demand analysis error");
    } finally {
      _running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  function displayDemandResults(result) {
    if (!isPopupVisible()) return;
    var el = document.getElementById("rfDemandResults");
    if (el) el.style.display = "";

    // CDI score
    var cdiVal = document.getElementById("rfCDIValue");
    if (cdiVal) cdiVal.textContent = Number.isFinite(result.corridorCDI.value)
      ? result.corridorCDI.value.toFixed(2) : "\u2014";

    // Classification badge
    var cdiBadge = document.getElementById("rfCDIClass");
    if (cdiBadge) {
      cdiBadge.textContent = result.classification.label;
      cdiBadge.className = "rf-cdi-badge rf-cdi-" + result.classification.label.toLowerCase().replace(/[^a-z]/g, "");
    }

    // Stats
    var geoCount = document.getElementById("rfGeoCount");
    if (geoCount) geoCount.textContent = String(result.corridorCDI.scored);

    var scoredCount = document.getElementById("rfScoredCount");
    if (scoredCount) scoredCount.textContent = result.corridorCDI.scored + " / " + result.corridorCDI.total;

    var routeLen = document.getElementById("rfRouteLength");
    if (routeLen) {
      var len = getTargetCorridorLength();
      routeLen.textContent = len > 0 ? len.toFixed(2) + " mi" : "\u2014";
    }

    var segCount = document.getElementById("rfSegmentCount");
    if (segCount) segCount.textContent = result.segments ? String(result.segments.length) : "\u2014";

    // Corridor comparison: show per-feature CDI from demand system
    var compSection = document.getElementById("rfCorridorComparison");
    var compList = document.getElementById("rfCorridorComparisonList");
    var routeCDIs = _demandPerRouteCDI || _perRouteCDI;
    if (routeCDIs && routeCDIs.length > 0 && compSection && compList) {
      compSection.style.display = "";
      var html = "";
      for (var i = 0; i < routeCDIs.length; i++) {
        var rc = routeCDIs[i];
        var cdi = Number.isFinite(rc.cdi) ? rc.cdi.toFixed(2) : "N/A";
        var cls = RM.classifyCDI({ value: rc.cdi });
        html += '<div class="rf-segment-row">' +
          '<span class="rf-segment-label" style="flex:1;">' + (rc.name || (rc.featureType + " " + (rc.featureIndex + 1))) + '</span>' +
          '<span class="rf-segment-cdi">' + cdi + '</span>' +
          '<span class="rf-segment-class rf-cdi-' + cls.label.toLowerCase().replace(/[^a-z]/g, "") + '">' + cls.label + '</span>' +
          '<span class="rf-segment-geos tiny">' + rc.geoCount + ' geos</span>' +
          '</div>';
      }
      compList.innerHTML = html;
    } else if (compSection) {
      compSection.style.display = "none";
    }

  }

  // ---- Choropleth rendering ----

  var RF_CORRIDOR_SOURCE = "rf-corridor-cdi";
  var RF_CORRIDOR_LAYER = "rf-corridor-cdi-layer";
  var _corridorPopup = null; // MapLibre Popup instance for corridor CDI hover

  // Hover popup for the "rf" choropleth (Phase 3 Step 3.3 of
  // docs/feature-area-choropleth-plan.md \u2014 migrated onto App.choropleth).
  function rfHoverHTML(props) {
    return '<div style="font-size:12px;line-height:1.4;">' +
      '<b>GEOID:</b> ' + (props.GEOID || "\u2014") + '<br>' +
      '<b>CDI Score:</b> ' + (props.cdiScore != null ? Number(props.cdiScore).toFixed(2) : "N/A") + ' / 5' +
      '</div>';
  }

  // Manual breaks [1,2,3,4] with the "blues" ramp reproduce the same 5 colors
  // RF's old inline continuous interpolate used at integer scores, now as
  // discrete classes (same tradeoff as TPI's Step 3.2 migration). Layer ids
  // are exactly reproduced by the "<id>-choropleth-*" convention: id: "rf"
  // yields rf-choropleth-fill/-line.
  function renderChoropleth(result) {
    var map = App.map;
    if (!map || !result || !result.tpiResult) return;
    var tpi = result.tpiResult;

    var useClipped = tpi.apportionByArea && tpi.clippedGeos;
    var clippedLookup = null;
    if (useClipped) {
      clippedLookup = {};
      for (var ci = 0; ci < tpi.clippedGeos.length; ci++) {
        var cg = tpi.clippedGeos[ci];
        if (cg.properties && cg.properties.GEOID) clippedLookup[cg.properties.GEOID] = cg.geometry;
      }
    }

    var features = [];
    for (var i = 0; i < tpi.geos.length; i++) {
      var geo = tpi.geos[i];
      var geoid = geo.properties && geo.properties.GEOID;
      var scoreData = geoid ? tpi.scores.get(geoid) : null;
      var composite = (scoreData && Number.isFinite(scoreData.composite)) ? scoreData.composite : null;
      var geom = (clippedLookup && geoid && clippedLookup[geoid]) ? clippedLookup[geoid] : geo.geometry;

      features.push({
        type: "Feature",
        properties: { GEOID: geoid, cdiScore: composite },
        geometry: geom
      });
    }

    App.choropleth.render({
      id: "rf", features: features, valueProp: "cdiScore",
      breaks: [1, 2, 3, 4], ramp: "blues", fillOpacity: 0.55,
      hoverHTML: rfHoverHTML, beforeLayer: "buffers-fill"
    });
  }

  // Render corridor route lines colored by per-route CDI score.
  // routeCDIs: array from computePerRouteCDI / computeSystemDemand.
  function renderCorridorCDILines(routeCDIs) {
    var map = App.map;
    if (!map || !routeCDIs || routeCDIs.length === 0) return;

    var features = [];
    for (var i = 0; i < routeCDIs.length; i++) {
      var pr = routeCDIs[i];
      var feat = pr.featureType === "route"
        ? (App.routes || [])[pr.featureIndex]
        : (App.lines  || [])[pr.featureIndex];
      if (!feat || !feat.geometry) continue;
      features.push({
        type: "Feature",
        properties: {
          name: pr.name || (pr.featureType + " " + (pr.featureIndex + 1)),
          cdiScore: Number.isFinite(pr.cdi) ? pr.cdi : 0,
          featureType: pr.featureType,
          featureIndex: pr.featureIndex
        },
        geometry: feat.geometry
      });
    }

    var fc = { type: "FeatureCollection", features: features };

    if (map.getSource(RF_CORRIDOR_SOURCE)) {
      map.getSource(RF_CORRIDOR_SOURCE).setData(fc);
      return;
    }

    map.addSource(RF_CORRIDOR_SOURCE, { type: "geojson", data: fc });
    map.addLayer({
      id: RF_CORRIDOR_LAYER,
      type: "line",
      source: RF_CORRIDOR_SOURCE,
      paint: {
        "line-width": 5,
        "line-opacity": 0.85,
        "line-color": [
          "interpolate", ["linear"], ["get", "cdiScore"],
          0, "#d3d3d3",
          1, "#eff3ff",
          2, "#bdd7e7",
          3, "#6baed6",
          4, "#3182bd",
          5, "#08519c"
        ]
      }
    });

    // Move above choropleth polygons
    try { map.moveLayer(RF_CORRIDOR_LAYER); } catch (e) { /* layer order not critical */ }

    // Hover popup showing Feature Name + CDI
    _corridorPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    map.on("mousemove", RF_CORRIDOR_LAYER, function (e) {
      map.getCanvas().style.cursor = "pointer";
      if (e.features && e.features.length > 0) {
        var props = e.features[0].properties;
        var cdiVal = Number.isFinite(props.cdiScore) ? Number(props.cdiScore).toFixed(2) : "N/A";
        _corridorPopup.setLngLat(e.lngLat)
          .setHTML('<div style="font-size:12px;line-height:1.5;"><b>' + props.name + '</b><br>CDI: ' + cdiVal + '</div>')
          .addTo(map);
      }
    });
    map.on("mouseleave", RF_CORRIDOR_LAYER, function () {
      map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
      if (_corridorPopup) _corridorPopup.remove();
    });
  }

  function removeChoropleth() {
    App.choropleth.remove("rf");
    var map = App.map;
    if (!map) return;
    if (map.getLayer(RF_CORRIDOR_LAYER)) map.removeLayer(RF_CORRIDOR_LAYER);
    if (map.getSource(RF_CORRIDOR_SOURCE)) map.removeSource(RF_CORRIDOR_SOURCE);
    if (_corridorPopup) { _corridorPopup.remove(); _corridorPopup = null; }
  }

  function clearAll() {
    removeChoropleth();
    _lastResult = null;
    _stale = false;
    _calibStale = false;
    _demandStale = false;
    _calibration = null;
    _calibData = null;
    _systemResult = null;
    _perRouteCDI = null;
    _matchResult = null;
    _selectedCorridor = "";
    _calibFeatureFilter = null;
    _demandSystemResult = null;
    _demandPerRouteCDI = null;
    _demandFeatureFilter = null;
    _sharedPoolMode = false;
    _sharedCalibPerRouteCDI = null;
    _sharedSystemResult = null;
    _projectionResults = null;
    App.popup.hideFloatingWidget("rf-legend");
    if (isPopupVisible()) {
      var el = document.getElementById("rfDemandResults");
      if (el) el.style.display = "none";
      var statusEl = document.getElementById("rfDemandStatus");
      if (statusEl) statusEl.style.display = "none";
      var sysEl = document.getElementById("rfSystemResults");
      if (sysEl) sysEl.style.display = "none";
      var sysStatusEl = document.getElementById("rfSystemStatus");
      if (sysStatusEl) sysStatusEl.style.display = "none";
      // Reset calibrate step gates
      var step2 = document.getElementById("rfCalibStep2");
      if (step2) { step2.style.opacity = "0.5"; step2.style.pointerEvents = "none"; }
      var step3 = document.getElementById("rfCalibStep3");
      if (step3) { step3.style.opacity = "0.5"; step3.style.pointerEvents = "none"; }
      // Reset shared pool UI
      var spNoteEl = document.getElementById("rfCalibSharedPoolNote");
      if (spNoteEl) spNoteEl.style.display = "none";
      var spCbEl = document.getElementById("rfSharedPoolMode");
      if (spCbEl) { spCbEl.checked = false; spCbEl.disabled = false; }
      // Reset calibration results + chart
      var calibResults = document.getElementById("rfCalibResults");
      if (calibResults) calibResults.style.display = "none";
      var chartWrap = document.getElementById("rfCalibChartWrap");
      if (chartWrap) chartWrap.style.display = "none";
      // Reset projections tab
      var projResults = document.getElementById("rfProjResults");
      if (projResults) projResults.style.display = "none";
      var projExp = document.getElementById("rfExportProjCSV");
      if (projExp) projExp.disabled = true;
      updateProjectionUI();
    }
    App.setStatus("Ridership analysis cleared");
  }

  // ---- Calibration helpers ----

  // Get the CDI value for the currently selected corridor.
  // Prefers demand-context CDI (independent normalization for the target system),
  // then falls back to calibration-context CDI.
  function getActiveCDI() {
    // Determine which per-route CDI array to use (demand context first, then calibration)
    var activeRouteCDIs = _demandPerRouteCDI || _perRouteCDI;

    // Look up per-route CDI for the selected corridor
    if (_selectedCorridor && activeRouteCDIs) {
      var parts = _selectedCorridor.split(":");
      var type = parts[0];
      var idx = parseInt(parts[1], 10);
      for (var i = 0; i < activeRouteCDIs.length; i++) {
        if (activeRouteCDIs[i].featureType === type && activeRouteCDIs[i].featureIndex === idx) {
          return activeRouteCDIs[i].cdi;
        }
      }
    }
    // Legacy fallback for uncalibrated demand (computeCorridorDemand path)
    if (_lastResult && _lastResult.corridorCDI) return _lastResult.corridorCDI.value;
    return NaN;
  }

  function getTargetCorridorLength() {
    // Return length in miles for the currently selected corridor.
    // Prefer demand context, then calibration context.
    var activeRouteCDIs = _demandPerRouteCDI || _perRouteCDI;
    if (_selectedCorridor && activeRouteCDIs) {
      var parts = _selectedCorridor.split(":");
      var type = parts[0];
      var idx = parseInt(parts[1], 10);
      for (var i = 0; i < activeRouteCDIs.length; i++) {
        var r = activeRouteCDIs[i];
        if (r.featureType === type && r.featureIndex === idx) {
          return (Number.isFinite(r.lengthMiles) && r.lengthMiles > 0) ? r.lengthMiles : 1;
        }
      }
    }
    // "all" or no match: total length of all drawn routes
    var total = RM.getRouteLength();
    return (Number.isFinite(total) && total > 0) ? total : 1;
  }

  // ---- Feature selection checklists ----

  // Build a single checkbox row for a feature
  function makeFeatureCheckRow(type, index, name, checked) {
    var row = document.createElement("div");
    row.className = "rf-feature-check-row";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.setAttribute("data-feature-type", type);
    cb.setAttribute("data-feature-index", String(index));
    var badge = document.createElement("span");
    badge.className = "rf-feature-type-badge";
    badge.textContent = type === "route" ? "R" : "L";
    var lbl = document.createElement("label");
    lbl.textContent = name;
    row.appendChild(cb);
    row.appendChild(badge);
    row.appendChild(lbl);
    return row;
  }

  // Populate a feature checklist container with current routes/lines.
  // previousFilter: optional feature filter to restore checkbox state from
  function populateFeatureList(containerId, previousFilter) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";
    var routes = App.routes || [];
    var lines = App.lines || [];
    if (routes.length === 0 && lines.length === 0) {
      container.innerHTML = '<div class="tiny" style="color:var(--muted);">Draw routes/lines on the map first.</div>';
      return;
    }
    for (var ri = 0; ri < routes.length; ri++) {
      var name = (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1));
      var checked = !previousFilter || !previousFilter.routeIndices || previousFilter.routeIndices.indexOf(ri) !== -1;
      container.appendChild(makeFeatureCheckRow("route", ri, name, checked));
    }
    for (var li = 0; li < lines.length; li++) {
      var name = (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1));
      var checked = !previousFilter || !previousFilter.lineIndices || previousFilter.lineIndices.indexOf(li) !== -1;
      container.appendChild(makeFeatureCheckRow("line", li, name, checked));
    }
  }

  // A filter covering every drawn route and line — used by the shared-pool
  // path, which needs a buffer set spanning ALL drawn features (matching the
  // historical featureFilter:null "compute CDI for all routes" behavior),
  // separately from whatever subset defines the study-area union.
  function allRoutesLinesFilter() {
    return {
      routeIndices: (App.routes || []).map(function (_, i) { return i; }),
      lineIndices:  (App.lines  || []).map(function (_, i) { return i; })
    };
  }

  // Read checkbox state from a feature checklist and return a featureFilter
  // object. Always explicit { routeIndices, lineIndices } arrays — never null.
  function readFeatureFilter(containerId) {
    var container = document.getElementById(containerId);
    var routeIndices = [];
    var lineIndices = [];
    if (!container) return { routeIndices: routeIndices, lineIndices: lineIndices };
    var cbs = container.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < cbs.length; i++) {
      var type = cbs[i].getAttribute("data-feature-type");
      var idx = parseInt(cbs[i].getAttribute("data-feature-index"), 10);
      if (cbs[i].checked) {
        if (type === "route") routeIndices.push(idx);
        else if (type === "line") lineIndices.push(idx);
      }
    }
    return { routeIndices: routeIndices, lineIndices: lineIndices };
  }

  // Combine two feature filters by unioning their route/line index sets.
  // A missing/null side is treated as contributing no indices (explicit-array
  // convention — never reinterpreted as "all features").
  function combineFeatureFilters(a, b) {
    a = a || { routeIndices: [], lineIndices: [] };
    b = b || { routeIndices: [], lineIndices: [] };
    var routeSet = {};
    var lineSet = {};
    (a.routeIndices || []).concat(b.routeIndices || []).forEach(function (i) { routeSet[i] = true; });
    (a.lineIndices  || []).concat(b.lineIndices  || []).forEach(function (i) { lineSet[i]  = true; });
    return {
      routeIndices: Object.keys(routeSet).map(Number).sort(function (x, y) { return x - y; }),
      lineIndices:  Object.keys(lineSet).map(Number).sort(function (x, y) { return x - y; })
    };
  }

  // Filter a routeCDIs array to only entries matching the given feature filter.
  // Returns all entries if filter is null.
  function filterRouteCDIs(all, filter) {
    if (!filter || !all) return all;
    return all.filter(function (r) {
      if (r.featureType === "route") return filter.routeIndices.indexOf(r.featureIndex) !== -1;
      if (r.featureType === "line")  return filter.lineIndices.indexOf(r.featureIndex)  !== -1;
      return false;
    });
  }

  // Refit calibration coefficients from existing _matchResult match data,
  // substituting updated CDI values from a shared-pool run.
  // calibPerRouteCDI: shared-pool per-route CDI array for calibration features.
  // Returns an updated calibration object (with sharedPoolMode: true), or null if
  // insufficient data or column mapping is unavailable (import-only flow).
  function refitCalibrationFromCDI(calibPerRouteCDI) {
    if (!_matchResult || _matchResult.matched.length < 3) return null;
    if (!calibPerRouteCDI || calibPerRouteCDI.length === 0) return null;

    var colRidership = (document.getElementById("rfCalibColRidership") || {}).value || "";
    if (!colRidership) return null; // column mapping not available

    var colHeadway = (document.getElementById("rfCalibColHeadway") || {}).value || "";
    var method = document.querySelector('input[name="rfCalibMethod"]:checked');
    var methodVal = method ? method.value : (_calibration ? _calibration.method : "ratio");
    var REF_HEADWAY = 30;
    var normElast = parseFloat((document.getElementById("rfFreqElastValue") || {}).value) || 0.6;

    // Build lookup: (featureType:featureIndex) → shared-pool CDI entry
    var cdiLookup = {};
    for (var k = 0; k < calibPerRouteCDI.length; k++) {
      var r = calibPerRouteCDI[k];
      cdiLookup[r.featureType + ":" + r.featureIndex] = r;
    }

    var obs = [];
    var headwayNormCount = 0;
    for (var i = 0; i < _matchResult.matched.length; i++) {
      var match = _matchResult.matched[i];
      var ridership = parseFloat(match.csvRow[colRidership]);
      if (!Number.isFinite(ridership)) continue;

      // Look up shared-pool CDI by featureType+featureIndex (robust to name edits)
      var key = match.routeCDI.featureType + ":" + match.routeCDI.featureIndex;
      var sharedEntry = cdiLookup[key];
      var routeCDI = sharedEntry ? sharedEntry.cdi : match.routeCDI.cdi;
      if (!Number.isFinite(routeCDI) || routeCDI <= 0) continue;

      if (_normalizeByLength) {
        var len = match.routeCDI.lengthMiles;
        if (!Number.isFinite(len) || len <= 0) continue;
        ridership = ridership / len;
      }

      if (colHeadway) {
        var routeHeadway = parseFloat(match.csvRow[colHeadway]);
        if (Number.isFinite(routeHeadway) && routeHeadway > 0) {
          var freqEffect = RM.computeFrequencyEffect(REF_HEADWAY, routeHeadway, normElast);
          if (freqEffect > 0) { ridership = ridership / freqEffect; headwayNormCount++; }
        }
      }

      obs.push({ ridership: ridership, demandIndex: routeCDI });
    }

    if (obs.length < 2) return null;

    var calibResult;
    var newCalib;
    if (methodVal === "regression") {
      calibResult = RM.calibrateRegression(obs);
      newCalib = {
        factor: calibResult.slope,
        intercept: calibResult.intercept,
        n: calibResult.n,
        rSquared: calibResult.rSquared,
        method: "regression",
        sharedPoolMode: true
      };
    } else {
      calibResult = RM.calibrateRatio(obs);
      newCalib = {
        factor: calibResult.factor,
        n: calibResult.n,
        rSquared: calibResult.rSquared,
        method: "ratio",
        sharedPoolMode: true
      };
    }

    if (headwayNormCount > 0) {
      newCalib.headwayNormalized = true;
      newCalib.refHeadway = REF_HEADWAY;
      newCalib.normElasticity = normElast;
      newCalib.headwayNormCount = headwayNormCount;
    }

    return newCalib;
  }

  // Wire select-all / clear links for a feature checklist
  function wireFeatureSelectLinks(selectAllId, selectNoneId, containerId, afterChange) {
    var allLink = document.getElementById(selectAllId);
    var noneLink = document.getElementById(selectNoneId);
    if (allLink) {
      allLink.addEventListener("click", function (e) {
        e.preventDefault();
        var cbs = document.querySelectorAll("#" + containerId + ' input[type="checkbox"]');
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
        if (afterChange) afterChange();
      });
    }
    if (noneLink) {
      noneLink.addEventListener("click", function (e) {
        e.preventDefault();
        var cbs = document.querySelectorAll("#" + containerId + ' input[type="checkbox"]');
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
        if (afterChange) afterChange();
      });
    }
  }

  // Populate the corridor dropdown from a CDI array.
  // If no routeCDIs param, uses demand context first, then calibration context.
  // Auto-selects the first option and syncs _selectedCorridor.
  function populateCorridorDropdown(routeCDIs) {
    var sel = document.getElementById("rfCorridorSelect");
    if (!sel) return;
    sel.innerHTML = "";
    var data = routeCDIs || _demandPerRouteCDI || _perRouteCDI;
    if (!data || data.length === 0) return;
    for (var i = 0; i < data.length; i++) {
      var pr = data[i];
      var opt = document.createElement("option");
      opt.value = pr.featureType + ":" + pr.featureIndex;
      opt.textContent = pr.name + " (CDI: " + (Number.isFinite(pr.cdi) ? pr.cdi.toFixed(2) : "N/A") + ")";
      sel.appendChild(opt);
    }
    // Restore previous selection if still available; otherwise default to first
    if (_selectedCorridor) {
      sel.value = _selectedCorridor;
    }
    if (!sel.value || sel.selectedIndex < 0) {
      sel.selectedIndex = 0;
    }
    _selectedCorridor = sel.value;
  }

  // Populate corridor dropdown from checked demand feature checkboxes.
  // Show/hide the ⚠ LODES warning buttons based on whether LODES data is loaded.
  // Call from onOpen() and inside isPopupVisible() guard in update().
  function updateLodesWarnings() {
    var hasLodes = !!App.lodesData;
    var calibBtn = document.getElementById("rfCalibLodesWarnBtn");
    var demandBtn = document.getElementById("rfDemandLodesWarnBtn");
    if (calibBtn) calibBtn.style.display = hasLodes ? "none" : "";
    if (demandBtn) demandBtn.style.display = hasLodes ? "none" : "";
  }

  // Shows feature names immediately (before analysis). Enriches with CDI values from
  // _demandPerRouteCDI when available (i.e. after demand analysis has run).
  // Restores _selectedCorridor if still present; falls back to first option if unchecked.
  function populateCorridorDropdownFromCheckedFeatures() {
    var sel = document.getElementById("rfCorridorSelect");
    if (!sel) return;
    var prevValue = _selectedCorridor || "";
    sel.innerHTML = "";

    var container = document.getElementById("rfDemandFeatureList");
    if (!container) return;
    var cbs = container.querySelectorAll('input[type="checkbox"]');

    for (var i = 0; i < cbs.length; i++) {
      if (!cbs[i].checked) continue;
      var type = cbs[i].getAttribute("data-feature-type");
      var idx = parseInt(cbs[i].getAttribute("data-feature-index"), 10);

      // Look up feature name from App.routes / App.lines
      var feat = type === "route" ? (App.routes || [])[idx] : (App.lines || [])[idx];
      var featName = (feat && feat.properties && feat.properties.name) ||
        (type === "route" ? "Route " : "Line ") + (idx + 1);

      // Enrich with CDI if available from demand context
      var cdiStr = "";
      var activeCDIs = _demandPerRouteCDI;
      if (activeCDIs) {
        for (var j = 0; j < activeCDIs.length; j++) {
          if (activeCDIs[j].featureType === type && activeCDIs[j].featureIndex === idx) {
            cdiStr = " (CDI: " + activeCDIs[j].cdi.toFixed(2) + ")";
            break;
          }
        }
      }

      var opt = document.createElement("option");
      opt.value = type + ":" + idx;
      opt.textContent = featName + cdiStr;
      sel.appendChild(opt);
    }

    // Restore previous corridor selection if still present in dropdown; else first option
    if (prevValue) {
      sel.value = prevValue;
    }
    if (!sel.value || sel.selectedIndex < 0) {
      sel.selectedIndex = 0;
    }
    _selectedCorridor = sel.value || "";
  }

  // ---- Layer 2: Calibration (system analysis + CSV matching) ----

  async function runSystemAnalysis() {
    if (_running) return;
    _running = true;

    var runBtn = document.getElementById("rfRunSystemAnalysis");
    if (runBtn) runBtn.disabled = true;
    App.renderModuleState({ statusEl: "rfSystemStatus", status: { kind: "running", message: "Running…" } });
    var textEl = document.getElementById("rfSystemStatusText");

    try {
      var geoLevel = document.getElementById("rfCalibGeoLevel").value;
      var year = document.getElementById("rfCalibYearSelect").value;
      var apportionCb = document.getElementById("rfCalibApportionByArea");
      var apportion = apportionCb ? apportionCb.checked : false;
      _apportionByArea = apportion;
      _bufferMiles = App.readAnalysisBufferMiles("rfBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
      _useDisplayBuffers = !!(document.getElementById("rfUseDisplayBuffers") || {}).checked;

      // Read calibration feature filter from checkboxes
      var featureFilter = readFeatureFilter("rfCalibFeatureList");
      _calibFeatureFilter = featureFilter;

      var calibBufferSet = buildRouteLineBufferSet(featureFilter);
      if (calibBufferSet.count === 0) {
        throw new Error("Could not build buffers for the selected calibration features.");
      }

      var customUnion = calibBufferSet.union;

      var result = await RM.computeSystemDemand({
        geoLevel: geoLevel,
        year: year,
        weights: _weights,
        lodesData: App.lodesData,
        apportionByArea: apportion,
        growthFactors: App.projGrowthFactors(),
        unionPolygon: customUnion,
        featureFilter: featureFilter,
        bufferSet: calibBufferSet,
        onProgress: function (msg) {
          if (textEl) textEl.textContent = msg;
          App.setStatus(msg);
        }
      });
      result.bufferMiles = _bufferMiles;
      result.bufferSet   = calibBufferSet;

      _systemResult = result;
      _perRouteCDI = result.routeCDIs;
      _stale = false;
      _calibStale = false;

      // Clear demand state since calibration changed
      _demandSystemResult = null;
      _demandPerRouteCDI = null;

      // Sync calibration settings to demand tab selectors for apples-to-apples defaults
      var demandGeoEl = document.getElementById("rfGeoLevel");
      if (demandGeoEl) demandGeoEl.value = geoLevel;
      var demandYearEl = document.getElementById("rfYearSelect");
      if (demandYearEl) demandYearEl.value = year;
      // Apportion and NormalizeByLength already synced bidirectionally via shared _apportionByArea/_normalizeByLength

      // Render choropleth
      var tpi = result.tpiResult;
      App.renderCensusOverlay(tpi.apportionByArea && tpi.clippedGeos ? tpi.clippedGeos : tpi.geos);
      renderChoropleth({ tpiResult: tpi, corridorCDI: result.systemCDI });

      // Show legend
      App.popup.showFloatingWidget("rf-legend", "projects/ridership-legend.html", {
        position: "bottom-left",
        width: 170,
        title: "Demand Legend"
      });

      // Display per-route CDI results
      displaySystemResults(result);

      // Render corridor CDI lines on map (colored by per-route CDI)
      renderCorridorCDILines(_perRouteCDI);

      // Populate the Demand tab corridor dropdown (context-aware)
      if (_demandUseSameSystem) {
        populateCorridorDropdown(_perRouteCDI);
      } else {
        populateCorridorDropdownFromCheckedFeatures();
      }

      // Enable Step 2
      var step2 = document.getElementById("rfCalibStep2");
      if (step2) { step2.style.opacity = "1"; step2.style.pointerEvents = "auto"; }

      App.renderModuleState({ statusEl: "rfSystemStatus", status: { kind: "done", message: "System analysis complete." } });
      App.setStatus("System analysis complete");

    } catch (err) {
      console.error("System analysis error:", err);
      App.renderModuleState({ statusEl: "rfSystemStatus", status: { kind: "error", message: "Error: " + (err.message || err) } });
      App.setStatus("System analysis error");
    } finally {
      _running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  // ---- CDI transparency helpers ----

  // Compute system-wide average quintile score per factor (baseline for comparison bars)
  function computeSystemFactorAverages(tpiResult) {
    var avgs = {};
    if (!tpiResult || !tpiResult.factorScores) return avgs;
    var fsIter = tpiResult.factorScores.entries();
    var fsEntry = fsIter.next();
    while (!fsEntry.done) {
      var factorId = fsEntry.value[0];
      var scoreMap = fsEntry.value[1];
      var sum = 0, count = 0;
      var valIter = scoreMap.values();
      var v = valIter.next();
      while (!v.done) {
        if (Number.isFinite(v.value)) { sum += v.value; count++; }
        v = valIter.next();
      }
      avgs[factorId] = count > 0 ? sum / count : NaN;
      fsEntry = fsIter.next();
    }
    return avgs;
  }

  // Build HTML for per-factor breakdown bars for one route
  function buildRouteFactorBreakdownHTML(routeCDI, systemAvgs, effectiveWeights) {
    var factors = TPI.FACTORS;
    var breakdown = routeCDI.factorBreakdown || {};
    var html = '<div class="rf-route-factor-list">';

    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      var w = (effectiveWeights && effectiveWeights[f.id] != null) ? effectiveWeights[f.id] : 0;
      if (w === 0) continue; // Skip inactive factors

      var routeAvg = breakdown[f.id];
      var sysAvg = systemAvgs[f.id];
      var routeValid = Number.isFinite(routeAvg);
      var sysValid = Number.isFinite(sysAvg);

      // Bar widths: scale 1-5 to 0-100%
      var routeBarPct = routeValid ? ((routeAvg - 1) / 4) * 100 : 0;
      var sysMarkerPct = sysValid ? ((sysAvg - 1) / 4) * 100 : 0;

      // Color: green if route > system, red if route < system, neutral if close
      var diff = (routeValid && sysValid) ? routeAvg - sysAvg : 0;
      var barColor = diff > 0.3 ? "#48bb78" : (diff < -0.3 ? "#f56565" : "#a0aec0");

      html += '<div class="rf-route-factor-row">' +
        '<span class="rf-route-factor-name" title="' + (f.description || f.label) + '">' + f.label + '</span>' +
        '<span class="rf-route-factor-weight tiny">' + Math.round(w) + '%</span>' +
        '<span class="rf-route-factor-bar-wrap">' +
          '<span class="rf-route-factor-bar" style="width:' + routeBarPct.toFixed(0) + '%;background:' + barColor + ';" ' +
            'title="Route: ' + (routeValid ? routeAvg.toFixed(1) : 'N/A') + ' / System: ' + (sysValid ? sysAvg.toFixed(1) : 'N/A') + '"></span>' +
          (sysValid ? '<span class="rf-route-factor-sys-marker" style="left:' + sysMarkerPct.toFixed(0) + '%;" title="System avg: ' + sysAvg.toFixed(1) + '"></span>' : '') +
        '</span>' +
        '<span class="rf-route-factor-score">' + (routeValid ? routeAvg.toFixed(1) : 'N/A') + '</span>' +
        '</div>';
    }

    html += '</div>';
    return html;
  }

  // Toggle expand/collapse of a route detail panel
  function toggleRouteDetail(e) {
    var row = e.currentTarget;
    var detailId = row.getAttribute("data-route-detail");
    var detail = document.getElementById(detailId);
    if (!detail) return;

    var expand = row.querySelector(".rf-route-score-expand");
    if (detail.style.display === "none") {
      detail.style.display = "";
      if (expand) expand.innerHTML = "&#9662;"; // down triangle
    } else {
      detail.style.display = "none";
      if (expand) expand.innerHTML = "&#9656;"; // right triangle
    }
  }

  function displaySystemResults(result) {
    if (!isPopupVisible()) return;
    var el = document.getElementById("rfSystemResults");
    if (el) el.style.display = "";

    // Feature count
    var countEl = document.getElementById("rfSystemFeatureCount");
    if (countEl) countEl.textContent = String(result.routeCDIs.length);

    // Compute system-wide factor averages (baseline for comparison bars)
    var systemFactorAvgs = computeSystemFactorAverages(result.tpiResult);

    // Per-route score list with expandable factor details
    var listEl = document.getElementById("rfRouteScoreList");
    if (listEl && result.routeCDIs.length > 0) {
      var html = "";
      for (var i = 0; i < result.routeCDIs.length; i++) {
        var r = result.routeCDIs[i];
        var cdi = Number.isFinite(r.cdi) ? r.cdi.toFixed(2) : "N/A";
        var typeLabel = r.featureType === "route" ? "Route" : "Line";

        // Score range text (min - max composite among overlapping geos)
        var rangeText = "";
        if (r.compositeRange && Number.isFinite(r.compositeRange.min) && Number.isFinite(r.compositeRange.max)) {
          if (r.compositeRange.max - r.compositeRange.min < 0.1) {
            rangeText = "(~" + r.compositeRange.min.toFixed(1) + " uniform)";
          } else {
            rangeText = "(" + r.compositeRange.min.toFixed(1) + " \u2013 " + r.compositeRange.max.toFixed(1) + ")";
          }
        }

        html += '<div class="rf-route-score-item">' +
          '<div class="rf-route-score-row" data-route-detail="rfRouteDetail_' + i + '">' +
          '<span class="rf-route-score-expand">&#9656;</span>' +
          '<span class="rf-route-score-name">' + typeLabel + ': ' + r.name + '</span>' +
          '<span class="rf-route-score-cdi">' + cdi + '</span>' +
          (rangeText ? '<span class="rf-route-score-range tiny">' + rangeText + '</span>' : '') +
          '<span class="rf-cdi-badge rf-cdi-' + r.classification.toLowerCase().replace(/[^a-z]/g, "") + '">' + r.classification + '</span>' +
          '<span class="rf-route-score-geos tiny">' + r.geoCount + ' geos</span>' +
          '</div>';

        // Expandable factor breakdown detail panel
        html += '<div class="rf-route-score-detail" id="rfRouteDetail_' + i + '" style="display:none;">';
        html += buildRouteFactorBreakdownHTML(r, systemFactorAvgs, result.tpiResult.effectiveWeights);
        html += '</div></div>';
      }
      listEl.innerHTML = html;

      // Wire click-to-expand on each row
      var rows = listEl.querySelectorAll(".rf-route-score-row[data-route-detail]");
      for (var ri = 0; ri < rows.length; ri++) {
        rows[ri].addEventListener("click", toggleRouteDetail);
      }
    }
  }

  function handleCalibUpload(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var result = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
      if (!result.data || result.data.length === 0) {
        alert("No data found in CSV.");
        return;
      }
      _calibData = result;
      var nameEl = document.getElementById("rfCalibFileName");
      if (nameEl) nameEl.textContent = file.name + " (" + result.data.length + " rows)";

      // Show column mapping
      var mappingEl = document.getElementById("rfCalibMapping");
      if (mappingEl) mappingEl.style.display = "";

      // Fill column dropdowns
      var headers = result.meta.fields || [];
      var cols = ["rfCalibColName", "rfCalibColRidership", "rfCalibColHeadway", "rfCalibColServiceType"];
      var guesses = [
        ["route", "name", "corridor"],
        ["ridership", "boardings", "riders", "daily"],
        ["headway", "frequency", "freq", "minutes"],
        ["service", "type", "mode"]
      ];

      for (var i = 0; i < cols.length; i++) {
        var sel = document.getElementById(cols[i]);
        if (!sel) continue;
        sel.innerHTML = '<option value="">-- Select --</option>';
        for (var h = 0; h < headers.length; h++) {
          var opt = document.createElement("option");
          opt.value = headers[h];
          opt.textContent = headers[h];
          sel.appendChild(opt);
        }
        // Auto-guess
        var guess = App.guessHeader(headers, guesses[i]);
        if (guess) sel.value = guess;
      }
    };
    reader.readAsText(file);
  }

  function runMatchRoutes() {
    if (!_calibData || !_perRouteCDI) return;

    var colName = document.getElementById("rfCalibColName").value;
    if (!colName) { alert("Please select the Route Name column."); return; }

    _matchResult = RM.matchRoutesToCSV(_perRouteCDI, _calibData.data, colName);

    // Display match results
    var listEl = document.getElementById("rfMatchList");
    var resultsEl = document.getElementById("rfMatchResults");
    if (resultsEl) resultsEl.style.display = "";

    if (listEl) {
      var html = "";
      // Matched rows
      for (var m = 0; m < _matchResult.matched.length; m++) {
        var match = _matchResult.matched[m];
        var csvName = match.csvRow[colName] || "";
        var cdi = Number.isFinite(match.routeCDI.cdi) ? match.routeCDI.cdi.toFixed(2) : "N/A";
        html += '<div class="rf-match-row rf-match-ok">' +
          '<span class="rf-match-icon">&#10003;</span>' +
          '<span class="rf-match-csv-name">' + csvName + '</span>' +
          '<span class="rf-match-arrow">&rarr;</span>' +
          '<span class="rf-match-feature">' + match.routeCDI.name + '</span>' +
          '<span class="rf-match-cdi">CDI: ' + cdi + '</span>' +
          '</div>';
      }
      // Unmatched rows
      for (var u = 0; u < _matchResult.unmatched.length; u++) {
        var unm = _matchResult.unmatched[u];
        var uName = unm.csvRow[colName] || "(empty)";
        html += '<div class="rf-match-row rf-match-fail">' +
          '<span class="rf-match-icon">&#10007;</span>' +
          '<span class="rf-match-csv-name">' + uName + '</span>' +
          '<span class="rf-match-reason tiny">' + unm.reason + '</span>' +
          '</div>';
      }
      listEl.innerHTML = html;
    }

    // Show warnings
    var warnEl = document.getElementById("rfMatchWarnings");
    if (warnEl) {
      var warnings = [];
      if (_matchResult.duplicateWarnings.length > 0) {
        warnings = warnings.concat(_matchResult.duplicateWarnings);
      }
      if (_matchResult.matched.length < 3) {
        warnings.push("Only " + _matchResult.matched.length + " route(s) matched — 3 or more required to run calibration.");
      }
      if (warnings.length > 0) {
        warnEl.style.display = "";
        warnEl.textContent = warnings.join(" ");
      } else {
        warnEl.style.display = "none";
      }
    }

    // Enable Step 3 if we have at least 2 matches
    var step3 = document.getElementById("rfCalibStep3");
    if (step3 && _matchResult.matched.length >= 3) {
      step3.style.opacity = "1";
      step3.style.pointerEvents = "auto";
    }
  }

  function runCalibration() {
    if (!_matchResult || _matchResult.matched.length < 3) {
      alert("Need at least 3 matched routes to calibrate.");
      return;
    }

    var colRidership = document.getElementById("rfCalibColRidership").value;
    if (!colRidership) { alert("Please select the ridership column."); return; }

    var colHeadway = (document.getElementById("rfCalibColHeadway") || {}).value || "";

    var method = document.querySelector('input[name="rfCalibMethod"]:checked');
    var methodVal = method ? method.value : "ratio";

    // Reference headway for normalization (same default as Elasticity tab baseline)
    var REF_HEADWAY = 30;
    // Use the Elasticity tab's current elasticity value if available, else 0.5
    var normElast = parseFloat((document.getElementById("rfFreqElastValue") || {}).value) || 0.6;

    // Build observation array using per-route CDI
    var obs = [];
    var headwayNormCount = 0;
    for (var i = 0; i < _matchResult.matched.length; i++) {
      var match = _matchResult.matched[i];
      var ridership = parseFloat(match.csvRow[colRidership]);
      if (!Number.isFinite(ridership)) continue;
      var routeCDI = match.routeCDI.cdi;
      if (!Number.isFinite(routeCDI) || routeCDI <= 0) continue;
      if (_normalizeByLength) {
        var len = match.routeCDI.lengthMiles;
        if (!Number.isFinite(len) || len <= 0) continue;
        ridership = ridership / len;
      }
      // Headway normalization: strip out frequency effect relative to reference headway
      if (colHeadway) {
        var routeHeadway = parseFloat(match.csvRow[colHeadway]);
        if (Number.isFinite(routeHeadway) && routeHeadway > 0) {
          var freqEffect = RM.computeFrequencyEffect(REF_HEADWAY, routeHeadway, normElast);
          if (freqEffect > 0) {
            ridership = ridership / freqEffect;
            headwayNormCount++;
          }
        }
      }
      obs.push({ ridership: ridership, demandIndex: routeCDI, name: match.routeCDI.name || ("Route " + i) });
    }

    if (obs.length < 2) {
      alert("Not enough valid data points (need 2+ with valid ridership and CDI).");
      return;
    }

    var calibResult;
    if (methodVal === "regression") {
      calibResult = RM.calibrateRegression(obs);
      _calibration = { factor: calibResult.slope, intercept: calibResult.intercept, n: calibResult.n, rSquared: calibResult.rSquared, method: "regression" };
    } else {
      calibResult = RM.calibrateRatio(obs);
      _calibration = { factor: calibResult.factor, n: calibResult.n, rSquared: calibResult.rSquared, method: "ratio" };
    }

    // Record headway normalization metadata so downstream tabs know it was applied
    if (headwayNormCount > 0) {
      _calibration.headwayNormalized = true;
      _calibration.refHeadway = REF_HEADWAY;
      _calibration.normElasticity = normElast;
      _calibration.headwayNormCount = headwayNormCount;
    }

    // Display results
    var resultsEl = document.getElementById("rfCalibResults");
    if (resultsEl) resultsEl.style.display = "";

    // Render fit visualization (must be after resultsEl is shown so canvas has clientWidth)
    renderCalibChart(obs, _calibration);

    var factorEl = document.getElementById("rfCalibFactor");
    if (factorEl) factorEl.textContent = _calibration.factor.toFixed(4);

    var r2El = document.getElementById("rfCalibRSquared");
    if (r2El) r2El.textContent = _calibration.rSquared != null ? _calibration.rSquared.toFixed(4) : "\u2014";

    var sizeEl = document.getElementById("rfCalibSampleSize");
    if (sizeEl) sizeEl.textContent = String(_calibration.n);

    // Headway normalization note
    var normEl = document.getElementById("rfCalibHeadwayNote");
    if (normEl) {
      if (_calibration.headwayNormalized) {
        normEl.style.display = "";
        normEl.textContent = "Headway-normalized (" + _calibration.headwayNormCount +
          " of " + _calibration.n + " routes, ref " + _calibration.refHeadway +
          " min, elasticity " + _calibration.normElasticity.toFixed(2) + ")";
      } else {
        normEl.style.display = "none";
      }
    }

    // Length normalization note
    var lenNoteEl = document.getElementById("rfCalibLengthNormNote");
    if (lenNoteEl) {
      if (_normalizeByLength) {
        lenNoteEl.style.display = "";
        lenNoteEl.textContent = "Length-normalized (ridership scaled by corridor length)";
      } else {
        lenNoteEl.style.display = "none";
      }
    }

    var warnEl = document.getElementById("rfCalibWarning");
    if (warnEl) {
      var warning = calibResult.warning || "";
      if (_calibration.n < 5) warning += (warning ? " " : "") + "Small sample size (" + _calibration.n + " routes).";
      if (warning) {
        warnEl.style.display = "";
        warnEl.textContent = warning;
      } else {
        warnEl.style.display = "none";
      }
    }

    var expBtn = document.getElementById("rfExportCalibJSON");
    if (expBtn) expBtn.disabled = false;

    // Show next step
    var nextStep = document.getElementById("rfCalibNextStep");
    if (nextStep) nextStep.style.display = "";
  }

  // ---- Calibration fit chart ----

  function renderCalibChart(points, calibration) {
    var wrap   = document.getElementById("rfCalibChartWrap");
    var canvas = document.getElementById("rfCalibChart");
    if (!wrap || !canvas) return;

    wrap.style.display = "";
    var dpr  = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth  || 500;
    var cssH = canvas.clientHeight || 260;
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    var PAD = { top: 18, right: 18, bottom: 48, left: 64 };
    var plotW = cssW - PAD.left - PAD.right;
    var plotH = cssH - PAD.top  - PAD.bottom;

    // Axis ranges
    var maxX = 0, maxY = 0;
    for (var i = 0; i < points.length; i++) {
      if (points[i].demandIndex > maxX) maxX = points[i].demandIndex;
      if (points[i].ridership   > maxY) maxY = points[i].ridership;
    }
    maxX = Math.max(maxX * 1.15, 0.5);
    var lineYatMax = (calibration.method === "regression")
      ? (calibration.intercept || 0) + calibration.factor * maxX
      : calibration.factor * maxX;
    maxY = Math.max(maxY, lineYatMax) * 1.15;
    if (maxY <= 0) maxY = 1;

    function toX(v) { return PAD.left + (v / maxX) * plotW; }
    function toY(v) { return PAD.top  + plotH - (v / maxY) * plotH; }

    // Background
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cssW, cssH);

    // Light grid
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 1;
    var xTicks = 5, yTicks = 4;
    for (var xi = 0; xi <= xTicks; xi++) {
      var gx = toX((xi / xTicks) * maxX);
      ctx.beginPath(); ctx.moveTo(gx, PAD.top); ctx.lineTo(gx, PAD.top + plotH); ctx.stroke();
    }
    for (var yi = 0; yi <= yTicks; yi++) {
      var gy = toY((yi / yTicks) * maxY);
      ctx.beginPath(); ctx.moveTo(PAD.left, gy); ctx.lineTo(PAD.left + plotW, gy); ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = "#718096";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + plotH);
    ctx.lineTo(PAD.left + plotW, PAD.top + plotH);
    ctx.stroke();

    // Tick labels — X
    ctx.fillStyle = "#718096";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (var xi2 = 0; xi2 <= xTicks; xi2++) {
      var tvx = (xi2 / xTicks) * maxX;
      ctx.fillText(tvx.toFixed(1), toX(tvx), PAD.top + plotH + 14);
    }
    // Tick labels — Y
    ctx.textAlign = "right";
    for (var yi2 = 0; yi2 <= yTicks; yi2++) {
      var tvy = (yi2 / yTicks) * maxY;
      var lbl = tvy >= 1000 ? (tvy / 1000).toFixed(1) + "k" : Math.round(tvy).toString();
      ctx.fillText(lbl, PAD.left - 6, toY(tvy) + 3.5);
    }

    // Axis titles
    ctx.fillStyle = "#4a5568";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CDI Score", PAD.left + plotW / 2, cssH - 4);
    ctx.save();
    ctx.translate(13, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Ridership", 0, 0);
    ctx.restore();

    // Best-fit line
    var lineX0, lineY0, lineY1;
    if (calibration.method === "regression") {
      var intercept = calibration.intercept || 0;
      lineX0 = (intercept < 0) ? (-intercept / calibration.factor) : 0;
      lineY0 = Math.max(0, intercept + calibration.factor * lineX0);
      lineY1 = intercept + calibration.factor * maxX;
    } else {
      lineX0 = 0;
      lineY0 = 0;
      lineY1 = calibration.factor * maxX;
    }
    ctx.beginPath();
    ctx.moveTo(toX(lineX0), toY(lineY0));
    ctx.lineTo(toX(maxX),   toY(lineY1));
    ctx.strokeStyle = "#e53e3e";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Line equation label
    var lineLabel = (calibration.method === "regression")
      ? "y = " + (calibration.intercept || 0).toFixed(1) + " + " + calibration.factor.toFixed(2) + "x"
      : "y = " + calibration.factor.toFixed(2) + "x";
    ctx.fillStyle = "#e53e3e";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    var labelX = toX(maxX * 0.55);
    var labelY = toY(lineY1 * 0.80);
    // Keep label inside plot area
    if (labelY < PAD.top + 12) labelY = PAD.top + 12;
    ctx.fillText(lineLabel, labelX, labelY);

    // Data points (drawn after line so dots appear on top)
    ctx.fillStyle = "#3182ce";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    for (var pi = 0; pi < points.length; pi++) {
      var ppx = toX(points[pi].demandIndex);
      var ppy = toY(points[pi].ridership);
      ctx.beginPath();
      ctx.arc(ppx, ppy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Tooltip via mousemove (store listener refs so re-renders don't stack)
    var tooltip = document.getElementById("rfCalibChartTooltip");
    if (_calibChartMouseMove)  canvas.removeEventListener("mousemove",  _calibChartMouseMove);
    if (_calibChartMouseLeave) canvas.removeEventListener("mouseleave", _calibChartMouseLeave);

    // Capture cssW/toX/toY in closure via the already-computed values above
    _calibChartMouseMove = function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var hit = null, bestDist = 12;
      for (var ti = 0; ti < points.length; ti++) {
        var tx = toX(points[ti].demandIndex);
        var ty = toY(points[ti].ridership);
        var dist = Math.sqrt((mx - tx) * (mx - tx) + (my - ty) * (my - ty));
        if (dist < bestDist) { bestDist = dist; hit = points[ti]; }
      }
      if (hit && tooltip) {
        tooltip.innerHTML = "<b>" + hit.name + "</b><br>CDI: " + hit.demandIndex.toFixed(2) +
          "&nbsp; Ridership: " + Math.round(hit.ridership).toLocaleString();
        tooltip.style.display = "";
        var tipX = Math.min(mx + 10, cssW - tooltip.offsetWidth - 4);
        tooltip.style.left = tipX + "px";
        tooltip.style.top  = (my - 36) + "px";
      } else if (tooltip) {
        tooltip.style.display = "none";
      }
    };
    _calibChartMouseLeave = function () { if (tooltip) tooltip.style.display = "none"; };
    canvas.addEventListener("mousemove",  _calibChartMouseMove);
    canvas.addEventListener("mouseleave", _calibChartMouseLeave);
  }

  // ---- Layer 3: Elasticity ----

  function refreshElasticity() {
    if (!isPopupVisible()) return;

    var stId = document.getElementById("rfServiceType").value;

    // Sync premium sliders to this service type's stored values
    syncPremiumSliders(stId);

    // Compute elasticity if demand exists
    var noCDI = document.getElementById("rfElasticityNoCDI");
    var resultsEl = document.getElementById("rfElasticityResults");

    if (!Number.isFinite(getActiveCDI())) {
      if (noCDI) noCDI.style.display = "";
      if (resultsEl) resultsEl.style.display = "none";
      return;
    }

    if (noCDI) noCDI.style.display = "none";
    if (resultsEl) resultsEl.style.display = "";

    var baseHeadway = parseFloat(document.getElementById("rfBaseHeadway").value) || 30;
    var newHeadway = parseFloat(document.getElementById("rfNewHeadway").value) || 15;
    var freqElast = parseFloat(document.getElementById("rfFreqElastValue").value) || 0.6;

    var calibFactor = (_calibration && _calibration.factor) ? _calibration.factor : 1;
    var calibIntercept = (_calibration && Number.isFinite(_calibration.intercept)) ? _calibration.intercept : 0;
    var lengthScale = (_normalizeByLength && _calibration) ? getTargetCorridorLength() : 1;
    var corridorCDI = getActiveCDI();
    var baseMid = Math.max(0, corridorCDI * calibFactor * lengthScale,
                              (calibIntercept + corridorCDI * calibFactor) * lengthScale);

    // Apply baseline uncertainty band
    var baseBand = RM.applyBaselineUncertainty(baseMid, _baselineUncertaintyPct);

    // Extract pure service multipliers (pass 1.0 to get multipliers only)
    var mult = RM.applyElasticity(1.0, {
      serviceTypeId: stId,
      baseHeadway: baseHeadway,
      newHeadway: newHeadway,
      freqElasticity: freqElast,
      customServicePremium: _servicePremiums[stId]
    });

    // Combine aligned: uncertainty band × service multiplier band
    var finalLow  = baseBand.low  * mult.low;
    var finalMid  = baseBand.mid  * mult.mid;
    var finalHigh = baseBand.high * mult.high;

    // Display baseline band (before service effects)
    var baseBandEl = document.getElementById("rfBaselineBand");
    if (baseBandEl) baseBandEl.style.display = "";
    var bbLow = document.getElementById("rfBaseBandLow");
    var bbMid = document.getElementById("rfBaseBandMid");
    var bbHigh = document.getElementById("rfBaseBandHigh");
    if (bbLow) bbLow.textContent = fmtNum(baseBand.low);
    if (bbMid) bbMid.textContent = fmtNum(baseBand.mid);
    if (bbHigh) bbHigh.textContent = fmtNum(baseBand.high);

    // Display final ridership band (uncertainty + service)
    var lowEl = document.getElementById("rfElastLow");
    var midEl = document.getElementById("rfElastMid");
    var highEl = document.getElementById("rfElastHigh");
    if (lowEl) lowEl.textContent = fmtNum(finalLow);
    if (midEl) midEl.textContent = fmtNum(finalMid);
    if (highEl) highEl.textContent = fmtNum(finalHigh);

    var freqEffEl = document.getElementById("rfFreqEffect");
    if (freqEffEl) freqEffEl.textContent = mult.freqEffect.toFixed(3) + "x";

    var baseCDIEl = document.getElementById("rfBaseCDI");
    if (baseCDIEl) baseCDIEl.textContent = Number.isFinite(corridorCDI) ? corridorCDI.toFixed(2) : "\u2014";
  }

  function fmtPct(v) { return "+" + Math.round(v * 100) + "%"; }
  function fmtNum(v) { return Number.isFinite(v) ? v.toFixed(1) : "\u2014"; }

  // ---- Layer 4: Scenarios ----

  function saveAllScenarioForms() {
    for (var i = 0; i < 4; i++) {
      var s = _scenarios[i];
      var nameEl = document.getElementById("rfScenName_" + i);
      if (nameEl) s.name = nameEl.value;
      s.serviceTypeId = (document.getElementById("rfScenServiceType_" + i) || {}).value || "local_bus";
      s.headway = parseFloat((document.getElementById("rfScenHeadway_" + i) || {}).value) || 30;
      s.span = parseFloat((document.getElementById("rfScenSpan_" + i) || {}).value) || 14;
      s.avgSpeed = parseFloat((document.getElementById("rfScenSpeed_" + i) || {}).value) || 15;
      s.costPerRevenueHour = parseFloat((document.getElementById("rfScenCostPerHr_" + i) || {}).value) || 150;
      s.serviceDaysPerYear = parseInt((document.getElementById("rfScenServiceDays_" + i) || {}).value, 10) || 260;
    }
  }

  function loadAllScenarioForms() {
    for (var i = 0; i < 4; i++) {
      var s = _scenarios[i];
      var nameEl = document.getElementById("rfScenName_" + i);
      if (nameEl) nameEl.value = s.name || SCENARIO_NAMES[i];
      var stEl = document.getElementById("rfScenServiceType_" + i);
      if (stEl) stEl.value = s.serviceTypeId || "local_bus";
      var hwEl = document.getElementById("rfScenHeadway_" + i);
      if (hwEl) hwEl.value = String(s.headway || 30);
      var spanEl = document.getElementById("rfScenSpan_" + i);
      if (spanEl) spanEl.value = String(s.span || 14);
      var speedEl = document.getElementById("rfScenSpeed_" + i);
      if (speedEl) speedEl.value = String(s.avgSpeed || 15);
      var costEl = document.getElementById("rfScenCostPerHr_" + i);
      if (costEl) costEl.value = String(s.costPerRevenueHour || 150);
      var daysEl = document.getElementById("rfScenServiceDays_" + i);
      if (daysEl) daysEl.value = String(s.serviceDaysPerYear || 260);
    }
  }

  function buildAndCompareScenarios() {
    var activeCDI = getActiveCDI();
    if (!Number.isFinite(activeCDI)) {
      alert("Run Demand or Calibrate analysis first.");
      return;
    }

    var routeLength = getTargetCorridorLength();
    var calibFactor = (_calibration && _calibration.factor) ? _calibration.factor : 1;
    var calibIntercept = (_calibration && Number.isFinite(_calibration.intercept)) ? _calibration.intercept : 0;
    var lengthScale = (_normalizeByLength && _calibration) ? getTargetCorridorLength() : 1;
    var baseMid = Math.max(0, activeCDI * calibFactor * lengthScale,
                              (calibIntercept + activeCDI * calibFactor) * lengthScale);
    var freqElast = parseFloat((document.getElementById("rfFreqElastValue") || {}).value) || 0.6;

    // Apply baseline uncertainty band once for the active corridor
    var baseBand = RM.applyBaselineUncertainty(baseMid, _baselineUncertaintyPct);

    // Baseline span reference (local bus default) for span elasticity comparisons
    var BASELINE_SPAN = 14;

    var builtScenarios = [];

    for (var i = 0; i < 4; i++) {
      var name = (document.getElementById("rfScenName_" + i) || {}).value || SCENARIO_NAMES[i];
      var serviceTypeId = (document.getElementById("rfScenServiceType_" + i) || {}).value || "local_bus";
      var headway = parseFloat((document.getElementById("rfScenHeadway_" + i) || {}).value) || 30;
      var span = parseFloat((document.getElementById("rfScenSpan_" + i) || {}).value) || 14;
      var avgSpeed = parseFloat((document.getElementById("rfScenSpeed_" + i) || {}).value) || 15;
      var costPerRevenueHour = parseFloat((document.getElementById("rfScenCostPerHr_" + i) || {}).value) || 150;
      var serviceDaysPerYear = parseInt((document.getElementById("rfScenServiceDays_" + i) || {}).value, 10) || 260;

      // Extract pure service multipliers (pass 1.0 to get multipliers only)
      var mult = RM.applyElasticity(1.0, {
        serviceTypeId: serviceTypeId,
        baseHeadway: 30, // baseline local bus
        newHeadway: headway,
        customServicePremium: _servicePremiums[serviceTypeId],
        freqElasticity: freqElast
      });

      // Span effect: (scenarioSpan / baselineSpan) ^ spanElasticity
      var spanEffect = RM.computeSpanEffect(BASELINE_SPAN, span, _spanElasticity);

      // Combine aligned: uncertainty band × service multiplier band × span multiplier
      var adjustedElast = {
        low:  baseBand.low  * mult.low  * spanEffect,
        mid:  baseBand.mid  * mult.mid  * spanEffect,
        high: baseBand.high * mult.high * spanEffect,
        freqEffect: mult.freqEffect,
        spanEffect: spanEffect,
        serviceType: mult.serviceType
      };

      var built = RM.buildScenario({
        name: name,
        serviceTypeId: serviceTypeId,
        routeLengthMiles: routeLength,
        headway: headway,
        span: span,
        avgSpeed: avgSpeed,
        costPerRevenueHour: costPerRevenueHour,
        serviceDaysPerYear: serviceDaysPerYear,
        baseDemandCDI: baseMid,
        elasticityResult: adjustedElast,
        calibrationFactor: 1 // already applied above
      });
      built.spanEffect = spanEffect;

      builtScenarios.push(built);
    }

    // Build comparison table
    displayComparisonTable(builtScenarios);

    // Enable exports
    var expCSV = document.getElementById("rfExportScenariosCSV");
    var expJSON = document.getElementById("rfExportScenariosJSON");
    if (expCSV) expCSV.disabled = false;
    if (expJSON) expJSON.disabled = false;
  }

  function displayComparisonTable(scenarios) {
    var noCDI = document.getElementById("rfScenarioNoCDI");
    var tableEl = document.getElementById("rfComparisonTable");
    if (noCDI) noCDI.style.display = "none";
    if (tableEl) tableEl.style.display = "";

    var thead = document.getElementById("rfCompareHead");
    var tbody = document.getElementById("rfCompareBody");
    if (!thead || !tbody) return;

    // Build header
    thead.innerHTML = '<tr>' +
      '<th>Metric</th>' +
      scenarios.map(function (s) { return '<th>' + s.name + '</th>'; }).join("") +
      '</tr>';

    // Build rows
    var metrics = [
      { label: "Service Type", key: function (s) { return RM.getServiceType(s.serviceTypeId).label; } },
      { label: "Headway (min)", key: function (s) { return s.headway; } },
      { label: "Span (hrs/day)", key: function (s) { return s.span; } },
      { label: "Span Effect", key: function (s) { return s.spanEffect != null ? s.spanEffect.toFixed(3) + "x" : "\u2014"; } },
      { label: "Avg Speed (mph)", key: function (s) { return s.avgSpeed; } },
      { label: "Vehicles Needed", key: function (s) { return s.vehiclesNeeded; } },
      { label: "Rev-Hrs / Day", key: function (s) { return s.revenueHoursPerDay.toFixed(1); } },
      { label: "Annual Rev-Hrs", key: function (s) { return Math.round(s.annualRevenueHours).toLocaleString(); } },
      { label: "Annual Op. Cost", key: function (s) { return "$" + Math.round(s.annualOperatingCost).toLocaleString(); } },
      { label: "Daily Ridership (Low)", key: function (s) { return Math.round(s.dailyRidership.low).toLocaleString(); } },
      { label: "Daily Ridership (Mid)", key: function (s) { return Math.round(s.dailyRidership.mid).toLocaleString(); }, highlight: true },
      { label: "Daily Ridership (High)", key: function (s) { return Math.round(s.dailyRidership.high).toLocaleString(); } },
      { label: "Annual Ridership (Mid)", key: function (s) { return Math.round(s.annualRidership.mid).toLocaleString(); }, highlight: true },
      { label: "Boardings / Rev-Hr (Mid)", key: function (s) { return s.boardingsPerRevHr.mid.toFixed(1); } },
      { label: "Cost / Boarding (Mid)", key: function (s) { return "$" + s.costPerBoarding.mid.toFixed(2); } }
    ];

    tbody.innerHTML = metrics.map(function (m) {
      var cls = m.highlight ? ' class="rf-highlight-row"' : '';
      return '<tr' + cls + '><td>' + m.label + '</td>' +
        scenarios.map(function (s) { return '<td>' + m.key(s) + '</td>'; }).join("") +
        '</tr>';
    }).join("");

    // Store for export
    _lastBuiltScenarios = scenarios;
  }

  var _lastBuiltScenarios = null;

  // ---- Projections tab ----

  // Build scenario results for a given CDI value (reuses current scenario form inputs + calibration).
  // Returns array of built scenario objects (same shape as buildAndCompareScenarios output).
  function buildScenariosForCDI(cdi) {
    if (!Number.isFinite(cdi)) return null;

    var routeLength = getTargetCorridorLength();
    var calibFactor = (_calibration && _calibration.factor) ? _calibration.factor : 1;
    var calibIntercept = (_calibration && Number.isFinite(_calibration.intercept)) ? _calibration.intercept : 0;
    var lengthScale = (_normalizeByLength && _calibration) ? routeLength : 1;
    var baseMid = Math.max(0, cdi * calibFactor * lengthScale,
                              (calibIntercept + cdi * calibFactor) * lengthScale);
    var freqElast = parseFloat((document.getElementById("rfFreqElastValue") || {}).value) || 0.6;
    var baseBand = RM.applyBaselineUncertainty(baseMid, _baselineUncertaintyPct);
    var BASELINE_SPAN = 14;

    var builtScenarios = [];
    for (var i = 0; i < 4; i++) {
      var name = (document.getElementById("rfScenName_" + i) || {}).value || SCENARIO_NAMES[i];
      var serviceTypeId = (document.getElementById("rfScenServiceType_" + i) || {}).value || "local_bus";
      var headway = parseFloat((document.getElementById("rfScenHeadway_" + i) || {}).value) || 30;
      var span = parseFloat((document.getElementById("rfScenSpan_" + i) || {}).value) || 14;
      var avgSpeed = parseFloat((document.getElementById("rfScenSpeed_" + i) || {}).value) || 15;
      var costPerRevenueHour = parseFloat((document.getElementById("rfScenCostPerHr_" + i) || {}).value) || 150;
      var serviceDaysPerYear = parseInt((document.getElementById("rfScenServiceDays_" + i) || {}).value, 10) || 260;

      var mult = RM.applyElasticity(1.0, {
        serviceTypeId: serviceTypeId,
        baseHeadway: 30,
        newHeadway: headway,
        customServicePremium: _servicePremiums[serviceTypeId],
        freqElasticity: freqElast
      });

      var spanEffect = RM.computeSpanEffect(BASELINE_SPAN, span, _spanElasticity);

      var adjustedElast = {
        low:  baseBand.low  * mult.low  * spanEffect,
        mid:  baseBand.mid  * mult.mid  * spanEffect,
        high: baseBand.high * mult.high * spanEffect,
        freqEffect: mult.freqEffect,
        spanEffect: spanEffect,
        serviceType: mult.serviceType
      };

      var built = RM.buildScenario({
        name: name,
        serviceTypeId: serviceTypeId,
        routeLengthMiles: routeLength,
        headway: headway,
        span: span,
        avgSpeed: avgSpeed,
        costPerRevenueHour: costPerRevenueHour,
        serviceDaysPerYear: serviceDaysPerYear,
        baseDemandCDI: baseMid,
        elasticityResult: adjustedElast,
        calibrationFactor: 1
      });
      built.spanEffect = spanEffect;
      builtScenarios.push(built);
    }
    return builtScenarios;
  }

  // Compute CDI for the selected corridor from a re-scored TPI result.
  function computeCDIFromResult(tpiResult, featureFilter) {
    var activeRouteCDIs = _demandPerRouteCDI || _perRouteCDI;

    if (_selectedCorridor && activeRouteCDIs) {
      // For corridor-specific CDI, re-run per-route CDI with the projected TPI
      var projRouteCDIs = RM.computePerRouteCDI(tpiResult, featureFilter);
      var parts = _selectedCorridor.split(":");
      var type = parts[0], idx = parseInt(parts[1], 10);
      for (var i = 0; i < projRouteCDIs.length; i++) {
        if (projRouteCDIs[i].featureType === type && projRouteCDIs[i].featureIndex === idx) {
          return projRouteCDIs[i].cdi;
        }
      }
    }

    // System-wide CDI from the re-scored TPI
    var sysCDI = RM.computeCorridorCDI(tpiResult);
    return sysCDI ? sysCDI.value : NaN;
  }

  function runProjections() {
    // Need projection data and a prior TPI result
    if (!App.projData) {
      alert("Upload a population projection CSV first.");
      return;
    }

    // Find a TPI result to re-score from
    var baseTpi = null;
    var featureFilter = null;
    if (_demandSystemResult && _demandSystemResult.tpiResult) {
      baseTpi = _demandSystemResult.tpiResult;
      featureFilter = _demandFeatureFilter;
    } else if (_systemResult && _systemResult.tpiResult) {
      baseTpi = _systemResult.tpiResult;
      featureFilter = _calibFeatureFilter;
    }

    if (!baseTpi || !baseTpi.cachedAcsData) {
      alert("Run Calibrate or Demand analysis first. The Projections tab re-scores cached TPI data.");
      return;
    }

    if (!_calibration) {
      alert("Complete calibration first (Calibrate tab) before running projections.");
      return;
    }

    var statusEl = document.getElementById("rfProjStatus");
    var statusText = document.getElementById("rfProjStatusText");
    if (statusEl) statusEl.style.display = "";

    // Get current (no growth factor) CDI for baseline column
    var currentCDI = getActiveCDI();
    var currentScenarios = buildScenariosForCDI(currentCDI);

    var results = [];
    results.push({ year: "Current", cdi: currentCDI, scenarios: currentScenarios });

    // Re-score for each projection year
    for (var yi = 0; yi < _projectionYears.length; yi++) {
      var year = _projectionYears[yi];
      if (statusText) statusText.textContent = "Re-scoring TPI for " + year + "...";

      var gf = App.projGrowthFactorsForYear(year);
      var reScored = TPI.recomputeWithGrowthFactors(baseTpi, gf);

      // Compute CDI from re-scored result
      var projCDI = computeCDIFromResult(reScored, featureFilter);
      var projScenarios = buildScenariosForCDI(projCDI);
      results.push({ year: year, cdi: projCDI, scenarios: projScenarios });
    }

    _projectionResults = results;
    if (statusEl) statusEl.style.display = "none";

    displayProjectionTimeline(results);

    // Enable export
    var expBtn = document.getElementById("rfExportProjCSV");
    if (expBtn) expBtn.disabled = false;

    if (typeof App.cache !== "undefined") App.cache.save();
  }

  function displayProjectionTimeline(results) {
    var container = document.getElementById("rfProjResults");
    var thead = document.getElementById("rfProjHead");
    var tbody = document.getElementById("rfProjBody");
    if (!container || !thead || !tbody) return;

    container.style.display = "";

    // Header: Metric | Current | 2030 | 2040 | 2050
    thead.innerHTML = '<tr><th></th>' +
      results.map(function (r) { return '<th>' + r.year + '</th>'; }).join("") +
      '</tr>';

    var rows = [];

    // CDI row
    rows.push('<tr class="rf-proj-cdi-row"><td>Corridor CDI</td>' +
      results.map(function (r) {
        return '<td>' + (Number.isFinite(r.cdi) ? r.cdi.toFixed(2) : "\u2014") + '</td>';
      }).join("") + '</tr>');

    // Scenario rows (use scenario names from first result)
    if (results[0] && results[0].scenarios) {
      for (var si = 0; si < results[0].scenarios.length; si++) {
        var scenName = results[0].scenarios[si].name;
        rows.push('<tr' + (si % 2 === 0 ? '' : '') + '><td>' + scenName + '</td>' +
          results.map(function (r) {
            if (!r.scenarios || !r.scenarios[si]) return '<td>\u2014</td>';
            var s = r.scenarios[si];
            var mid = Math.round(s.dailyRidership.mid).toLocaleString();
            var low = Math.round(s.dailyRidership.low).toLocaleString();
            var high = Math.round(s.dailyRidership.high).toLocaleString();
            return '<td>' + mid + '<span class="rf-proj-range">(' + low + ' \u2013 ' + high + ')</span></td>';
          }).join("") + '</tr>');
      }
    }

    tbody.innerHTML = rows.join("");

    // Note about methodology
    var noteEl = container.querySelector(".rf-proj-note");
    if (!noteEl) {
      noteEl = document.createElement("div");
      noteEl.className = "rf-proj-note";
      container.appendChild(noteEl);
    }
    noteEl.textContent = "Growth factors modify Census population (B01003_001E) only. " +
      "Other demographics (income, vehicle ownership, etc.) and employment are held constant.";
  }

  function exportProjectionsCSV() {
    if (!_projectionResults || _projectionResults.length === 0) return;

    var meta = _buildMetadata({ analysis: "Population Growth Projections" });
    var lines = [_metadataCSVHeader(meta)];
    lines.push("");

    // Header
    var header = ["Metric"];
    for (var yi = 0; yi < _projectionResults.length; yi++) {
      header.push(_projectionResults[yi].year);
    }
    lines.push(header.join(","));

    // CDI row
    var cdiRow = ["Corridor CDI"];
    for (var ci = 0; ci < _projectionResults.length; ci++) {
      cdiRow.push(Number.isFinite(_projectionResults[ci].cdi) ? _projectionResults[ci].cdi.toFixed(3) : "");
    }
    lines.push(cdiRow.join(","));

    // Scenario rows (low, mid, high for each)
    var firstScens = _projectionResults[0].scenarios;
    if (firstScens) {
      for (var si = 0; si < firstScens.length; si++) {
        var scenName = firstScens[si].name;
        ["Low", "Mid", "High"].forEach(function (level) {
          var row = [scenName + " (" + level + ")"];
          for (var pi = 0; pi < _projectionResults.length; pi++) {
            var s = _projectionResults[pi].scenarios[si];
            var key = level.toLowerCase();
            row.push(s ? Math.round(s.dailyRidership[key]) : "");
          }
          lines.push(row.join(","));
        });
      }
    }

    _triggerDownload(lines.join("\n"), "text/csv", "projection-timeline_" + _dateStamp() + ".csv");
  }

  function updateProjectionUI() {
    if (!isPopupVisible()) return;
    var hasProj = !!App.projData;
    var hasAnalysis = !!(_systemResult || _demandSystemResult);
    var hasCalib = !!_calibration;

    var infoEl = document.getElementById("rfProjFileInfo");
    var clearBtn = document.getElementById("rfProjClear");
    var readyDiv = document.getElementById("rfProjReady");
    var prereqDiv = document.getElementById("rfProjPrereqs");

    if (hasProj && infoEl) {
      infoEl.textContent = "Loaded: " + App.projFileName +
        " \u2014 " + App.projData.size.toLocaleString() + " tracts";
      infoEl.style.color = "";
    } else if (infoEl) {
      infoEl.textContent = "No projection file loaded";
      infoEl.style.color = "var(--muted)";
    }

    if (clearBtn) clearBtn.style.display = hasProj ? "" : "none";

    // Show Run button only when prerequisites are met
    var canRun = hasProj && hasAnalysis && hasCalib;
    if (readyDiv) readyDiv.style.display = canRun ? "" : "none";
    if (prereqDiv) {
      if (canRun || hasProj) {
        prereqDiv.style.display = "none";
      } else {
        prereqDiv.style.display = "";
        prereqDiv.textContent = !hasAnalysis
          ? "Complete the Calibrate tab first, then upload a projection CSV."
          : !hasCalib
          ? "Complete calibration (Step 3 in Calibrate) first."
          : "Upload a projection CSV to run growth projections.";
      }
    }
  }

  // ---- Export helpers ----

  function _dateStamp() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function _getCorridorLabel() {
    if (!_selectedCorridor) return "No corridor selected";
    var parts = _selectedCorridor.split(":");
    var type = parts[0], idx = parseInt(parts[1], 10);
    var arr = type === "route" ? (App.routes || []) : (App.lines || []);
    var feat = arr[idx];
    var name = (feat && feat.properties && feat.properties.name) || ((type === "route" ? "Route " : "Line ") + (idx + 1));
    return name;
  }

  function _buildMetadata(extra) {
    var sysResult = _demandSystemResult || _systemResult;
    var meta = {
      tool: "Micro Analysis Tool",
      exportedAt: new Date().toISOString(),
      geoLevel: sysResult ? sysResult.geoLevel : null,
      acsYear: sysResult ? sysResult.year : null,
      corridor: _getCorridorLabel(),
      bufferMiles: _bufferMiles
    };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) meta[k] = extra[k]; } }
    return meta;
  }

  function _metadataCSVHeader(meta) {
    var lines = [];
    lines.push("# Micro Analysis Tool — Export");
    lines.push("# Exported: " + meta.exportedAt);
    if (meta.geoLevel) lines.push("# Geography: " + meta.geoLevel);
    if (meta.acsYear) lines.push("# ACS Year: " + meta.acsYear);
    if (meta.corridor) lines.push("# Corridor: " + meta.corridor);
    for (var k in meta) {
      if (meta.hasOwnProperty(k) && ["tool", "exportedAt", "geoLevel", "acsYear", "corridor"].indexOf(k) === -1 && meta[k] != null) {
        lines.push("# " + k + ": " + meta[k]);
      }
    }
    return lines.join("\n");
  }

  function _triggerDownload(content, mimeType, filename) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // Collect per-corridor CDI rows for export. When includeSharedPool is true and
  // shared-pool data exists, also includes the calibration system corridors (labelled
  // with a "System" column so the user can compare calibration vs demand CDI).
  function _collectCorridorExportRows(includeSharedPool) {
    var rows = [];
    var factors = TPI.FACTORS;

    function pushRouteCDIs(cdis, systemLabel) {
      if (!cdis) return;
      for (var i = 0; i < cdis.length; i++) {
        var rc = cdis[i];
        var cls = RM.classifyCDI({ value: rc.cdi });
        var row = {
          system: systemLabel,
          corridor: rc.name || (rc.featureType + " " + (rc.featureIndex + 1)),
          featureType: rc.featureType,
          featureIndex: rc.featureIndex,
          cdi: rc.cdi,
          cdiClass: cls.label,
          geoCount: rc.geoCount,
          lengthMiles: rc.lengthMiles
        };
        // Per-factor breakdown if available
        if (rc.factorBreakdown) {
          for (var fi = 0; fi < factors.length; fi++) {
            var fId = factors[fi].id;
            row[fId + "_avg_quintile"] = rc.factorBreakdown[fId] != null ? rc.factorBreakdown[fId] : null;
          }
        }
        rows.push(row);
      }
    }

    // Demand system corridors
    var demandCDIs = _demandPerRouteCDI || _perRouteCDI;
    pushRouteCDIs(demandCDIs, "Demand");

    // Shared pool calibration corridors (only when toggle is on and data exists)
    if (includeSharedPool && _sharedCalibPerRouteCDI) {
      pushRouteCDIs(_sharedCalibPerRouteCDI, "Calibration");
    }

    return rows;
  }

  function exportDemandGeoJSON() {
    var demandCDIs = _demandPerRouteCDI || _perRouteCDI;
    if (!demandCDIs || demandCDIs.length === 0) return;

    var includeSharedCb = document.getElementById("rfExportIncludeSharedPool");
    var includeShared = includeSharedCb && includeSharedCb.checked;
    var exportRows = _collectCorridorExportRows(includeShared);
    var factors = TPI.FACTORS;

    // Prefer whichever run's own buffer set (module analysis distance) has
    // this feature; fall back to the feature's own drawn geometry (matches
    // the pre-buffer-distance behavior when no set is available, e.g. a
    // restored session where geometry wasn't persisted).
    var geoBufferSet = (_demandSystemResult && _demandSystemResult.bufferSet) ||
                       (_systemResult && _systemResult.bufferSet) || null;

    var features = exportRows.map(function (row) {
      var props = {
        system: row.system,
        corridor: row.corridor,
        featureType: row.featureType,
        cdi: Number.isFinite(row.cdi) ? parseFloat(row.cdi.toFixed(4)) : null,
        cdiClass: row.cdiClass,
        geoCount: row.geoCount,
        lengthMiles: Number.isFinite(row.lengthMiles) ? parseFloat(row.lengthMiles.toFixed(2)) : null
      };
      for (var fi = 0; fi < factors.length; fi++) {
        var key = factors[fi].id + "_avg_quintile";
        props[key] = row[key] != null && Number.isFinite(row[key]) ? parseFloat(row[key].toFixed(4)) : null;
      }
      // Use the feature's buffer geometry for the GeoJSON feature
      var geom = null;
      var buf = geoBufferSet ? geoBufferSet.get(row.featureType, row.featureIndex) : null;
      if (buf) {
        geom = buf.geometry || null;
      } else {
        var arr = row.featureType === "route" ? (App.routes || []) : (App.lines || []);
        if (row.featureIndex < arr.length && arr[row.featureIndex]) {
          geom = arr[row.featureIndex].geometry || null;
        }
      }
      return { type: "Feature", properties: props, geometry: geom };
    });

    var geojson = {
      type: "FeatureCollection",
      metadata: _buildMetadata({ module: "Ridership Forecasting — Corridor CDI" }),
      features: features
    };
    _triggerDownload(
      JSON.stringify(geojson, null, 2),
      "application/geo+json",
      "corridor-cdi-" + _dateStamp() + ".geojson"
    );
  }

  function exportDemandCSV() {
    var demandCDIs = _demandPerRouteCDI || _perRouteCDI;
    if (!demandCDIs || demandCDIs.length === 0) return;

    var includeSharedCb = document.getElementById("rfExportIncludeSharedPool");
    var includeShared = includeSharedCb && includeSharedCb.checked;
    var exportRows = _collectCorridorExportRows(includeShared);
    var factors = TPI.FACTORS;

    var meta = _buildMetadata({ module: "Ridership Forecasting — Corridor CDI" });
    var header = ["System", "Corridor", "CDI", "CDI_Class", "Geo_Count", "Length_Miles"];
    for (var fi = 0; fi < factors.length; fi++) {
      header.push(factors[fi].id + "_avg_quintile");
    }
    var csvRows = [_metadataCSVHeader(meta), header.join(",")];

    for (var ri = 0; ri < exportRows.length; ri++) {
      var row = exportRows[ri];
      var line = [
        '"' + (row.system || "").replace(/"/g, '""') + '"',
        '"' + (row.corridor || "").replace(/"/g, '""') + '"',
        Number.isFinite(row.cdi) ? row.cdi.toFixed(4) : "",
        row.cdiClass || "",
        row.geoCount != null ? String(row.geoCount) : "",
        Number.isFinite(row.lengthMiles) ? row.lengthMiles.toFixed(2) : ""
      ];
      for (var fj = 0; fj < factors.length; fj++) {
        var val = row[factors[fj].id + "_avg_quintile"];
        line.push(val != null && Number.isFinite(val) ? val.toFixed(4) : "");
      }
      csvRows.push(line.join(","));
    }

    _triggerDownload(csvRows.join("\n"), "text/csv", "corridor-cdi-" + _dateStamp() + ".csv");
  }

  function exportScenariosCSV() {
    if (!_lastBuiltScenarios || _lastBuiltScenarios.length === 0) return;
    var cdi = getActiveCDI();
    var meta = _buildMetadata({
      corridorCDI: Number.isFinite(cdi) ? cdi.toFixed(4) : "N/A",
      corridorLengthMiles: getTargetCorridorLength().toFixed(2),
      calibrationFactor: _calibration ? _calibration.factor : "N/A",
      calibrationMethod: _calibration ? _calibration.method : "N/A",
      spanElasticity: _spanElasticity,
      baselineUncertaintyPct: (_baselineUncertaintyPct * 100).toFixed(0) + "%"
    });
    var comp = RM.compareScenarios(_lastBuiltScenarios);
    var rows = [_metadataCSVHeader(meta), comp.headers.join(",")];
    for (var i = 0; i < _lastBuiltScenarios.length; i++) {
      rows.push(RM.scenarioToRow(_lastBuiltScenarios[i]).join(","));
    }
    _triggerDownload(rows.join("\n"), "text/csv", "ridership-scenarios-" + _dateStamp() + ".csv");
  }

  function exportScenariosJSON() {
    if (!_lastBuiltScenarios) return;
    var cdi = getActiveCDI();
    var data = {
      type: "ridership-scenarios",
      version: 2,
      metadata: _buildMetadata(),
      corridorCDI: Number.isFinite(cdi) ? parseFloat(cdi.toFixed(4)) : null,
      corridorLengthMiles: parseFloat(getTargetCorridorLength().toFixed(2)),
      calibrationFactor: _calibration ? _calibration.factor : null,
      calibrationIntercept: (_calibration && _calibration.intercept != null) ? _calibration.intercept : null,
      calibrationMethod: _calibration ? _calibration.method : null,
      calibrationN: _calibration ? _calibration.n : null,
      calibrationRSquared: _calibration ? _calibration.rSquared : null,
      weights: _weights ? Object.assign({}, _weights) : null,
      spanElasticity: _spanElasticity,
      baselineUncertaintyPct: _baselineUncertaintyPct,
      scenarios: _lastBuiltScenarios,
      exportedAt: new Date().toISOString()
    };
    _triggerDownload(
      JSON.stringify(data, null, 2),
      "application/json",
      "ridership-scenarios-" + _dateStamp() + ".json"
    );
  }

  function exportCalibJSON() {
    if (!_calibration) return;
    // Build standard v2 export, then add v3 shared-pool fields
    var baseJson = RM.exportCoefficients(_calibration, {
      weights: _weights ? Object.assign({}, _weights) : null,
      featureFilter: _calibFeatureFilter,
      perRouteCDI: _perRouteCDI,
      geoLevel: _systemResult ? _systemResult.geoLevel : null,
      year: _systemResult ? _systemResult.year : null
    });
    var data = JSON.parse(baseJson);
    data.metadata = _buildMetadata({ module: "Ridership Forecasting — Calibration" });
    data.normalizationMode = _sharedPoolMode ? "shared" : "separate";
    data.baselineUncertaintyPct = _baselineUncertaintyPct;
    data.servicePremiums = Object.assign({}, _servicePremiums);
    data.bufferMiles = _bufferMiles;
    if (_demandFeatureFilter) data.demandFeatureFilter = _demandFeatureFilter;
    if (_sharedCalibPerRouteCDI) data.sharedCalibPerRouteCDI = _sharedCalibPerRouteCDI;
    _triggerDownload(
      JSON.stringify(data, null, 2),
      "application/json",
      "ridership-calibration-" + _dateStamp() + ".json"
    );
  }

  function handleCalibImport(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var result = RM.importCoefficients(e.target.result);
      if (result.error) {
        alert(result.error);
        return;
      }
      _calibration = result.calibration;
      // Restore v2 metadata if present
      if (result.weights) _weights = Object.assign({}, result.weights);
      if (result.perRouteCDI) {
        _perRouteCDI = result.perRouteCDI;
        populateCorridorDropdown(_perRouteCDI);
      }
      if (result.featureFilter) _calibFeatureFilter = result.featureFilter;

      // Restore v3 shared-pool fields from raw JSON (not passed through by importCoefficients)
      try {
        var rawData = JSON.parse(e.target.result);
        if (rawData.normalizationMode === "shared") {
          _sharedPoolMode = true;
          if (rawData.demandFeatureFilter) _demandFeatureFilter = rawData.demandFeatureFilter;
          if (rawData.sharedCalibPerRouteCDI) _sharedCalibPerRouteCDI = rawData.sharedCalibPerRouteCDI;
        } else {
          _sharedPoolMode = false;
        }
        // Restore baseline uncertainty (default 0.25 if absent)
        if (rawData.baselineUncertaintyPct != null && Number.isFinite(rawData.baselineUncertaintyPct)) {
          _baselineUncertaintyPct = rawData.baselineUncertaintyPct;
        }
        // Restore buffer distance (default App.ANALYSIS_BUFFER_DEFAULT_MILES if absent)
        if (rawData.bufferMiles != null && Number.isFinite(rawData.bufferMiles)) {
          _bufferMiles = rawData.bufferMiles;
        }
        // Restore service premiums if present
        if (rawData.servicePremiums && typeof rawData.servicePremiums === "object") {
          for (var spk in rawData.servicePremiums) {
            if (rawData.servicePremiums[spk] && typeof rawData.servicePremiums[spk] === "object") {
              _servicePremiums[spk] = rawData.servicePremiums[spk];
            }
          }
        }
      } catch (_) { _sharedPoolMode = false; }

      // Update UI
      var bufferMilesImportEl = document.getElementById("rfBufferMiles");
      if (bufferMilesImportEl) bufferMilesImportEl.value = String(_bufferMiles);
      updateDemandBufferNote();
      var uncertSlider = document.getElementById("rfBaseUncertSlider");
      var uncertValue = document.getElementById("rfBaseUncertValue");
      var uncertPctInt = Math.round(_baselineUncertaintyPct * 100);
      if (uncertSlider) uncertSlider.value = String(uncertPctInt);
      if (uncertValue) uncertValue.value = String(uncertPctInt);
      var stSelImport = document.getElementById("rfServiceType");
      if (stSelImport) syncPremiumSliders(stSelImport.value);
      var spCb = document.getElementById("rfSharedPoolMode");
      if (spCb) { spCb.checked = _sharedPoolMode; spCb.disabled = _demandUseSameSystem; }
      var resultsEl = document.getElementById("rfCalibResults");
      if (resultsEl) resultsEl.style.display = "";
      var factorEl = document.getElementById("rfCalibFactor");
      if (factorEl) factorEl.textContent = _calibration.factor ? _calibration.factor.toFixed(4) : "\u2014";
      var r2El = document.getElementById("rfCalibRSquared");
      if (r2El) r2El.textContent = _calibration.rSquared != null ? _calibration.rSquared.toFixed(4) : "\u2014";
      var sizeEl = document.getElementById("rfCalibSampleSize");
      if (sizeEl) sizeEl.textContent = String(_calibration.n || "\u2014");
      // Show shared-pool note if imported calibration was refitted
      var spNoteEl = document.getElementById("rfCalibSharedPoolNote");
      if (spNoteEl) {
        if (_calibration.sharedPoolMode) {
          spNoteEl.style.display = "";
          spNoteEl.textContent = "Calibration refitted using shared-pool CDI values " +
            "(factor: " + _calibration.factor.toFixed(4) + ", n=" + _calibration.n + ").";
        } else {
          spNoteEl.style.display = "none";
        }
      }
      App.setStatus("Calibration imported" + (result.perRouteCDI ? " (with per-route CDI)" : ""));
    };
    reader.readAsText(file);
  }

  // ---- Stale indicator ----

  var _calibStale = false;
  var _demandStale = false;

  function markStale() {
    // Mark both contexts stale when features change
    if (_systemResult) _calibStale = true;
    if (_lastResult || _demandSystemResult) _demandStale = true;
    _stale = _calibStale || _demandStale;
    if (!isPopupVisible()) return;
    // Show stale banner (with Re-run) on Demand tab
    if (_demandStale) {
      App.renderModuleState({ statusEl: "rfDemandStatus", stale: true, onRerun: runDemand });
    }
    // Show stale banner (with Re-run) on Calibrate tab
    if (_calibStale) {
      App.renderModuleState({ statusEl: "rfSystemStatus", stale: true, onRerun: runSystemAnalysis });
    }
    // On feature deletion, invalidate feature filters since indices may have shifted
    _calibFeatureFilter = null;
    _demandFeatureFilter = null;
    // Invalidate shared pool derived state (will be recomputed on next demand run)
    _sharedCalibPerRouteCDI = null;
    _sharedSystemResult = null;
    if (isPopupVisible()) {
      var spNoteEl = document.getElementById("rfCalibSharedPoolNote");
      if (spNoteEl) spNoteEl.style.display = "none";
    }
  }

  // Refresh the Demand tab's read-only buffer-distance note to track the
  // Calibrate tab's single #rfBufferMiles input.
  function updateDemandBufferNote() {
    var noteEl = document.getElementById("rfDemandBufferNote");
    if (noteEl) noteEl.textContent = _useDisplayBuffers
      ? "Analysis buffers: Display Buffers — set on the Calibrate tab."
      : "Analysis buffer: " + _bufferMiles + " mi — set on the Calibrate tab.";
  }

  // ---- Module init (called once on first popup open) ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    // Tab navigation
    var tabs = document.querySelectorAll(".rf-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (e) {
        switchTab(e.target.getAttribute("data-tab"));
      });
    }

    // ---- Calibrate tab ----

    // "Adjust Weights" button opens the weight modal
    var adjBtn = document.getElementById("rfAdjustWeights");
    if (adjBtn) adjBtn.addEventListener("click", openWeightsModal);

    // Modal: Confirm saves pending weights
    var confirmBtn = document.getElementById("rfWeightsConfirm");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", function () {
        if (!_pendingWeights) return;
        _weights = Object.assign({}, _pendingWeights);
        closeWeightsModal();
        markStale();
      });
    }

    // Modal: Cancel discards changes
    var cancelBtn = document.getElementById("rfWeightsCancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeWeightsModal);

    // Modal: Reset to defaults
    var resetBtn = document.getElementById("rfResetWeights");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!_pendingWeights) return;
        applyWeightsToModalSliders(Object.assign({}, RF_DEFAULT_WEIGHTS));
      });
    }

    // Modal: Copy From TPI (reads TPI's current live weights)
    var copyBtn = document.getElementById("rfCopyFromTPI");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        if (typeof App.getTpiWeights === "function") {
          applyWeightsToModalSliders(App.getTpiWeights());
        } else {
          alert("Open the Transit Propensity Index tool first to copy its weights.");
        }
      });
    }

    // Analysis confirmation modal: Proceed / Cancel
    var confirmProceedBtn = document.getElementById("rfConfirmModalProceed");
    if (confirmProceedBtn) {
      confirmProceedBtn.addEventListener("click", function () {
        var cb = _confirmCallback;
        closeConfirmModal();
        if (cb) cb();
      });
    }
    var confirmCancelBtn = document.getElementById("rfConfirmModalCancel");
    if (confirmCancelBtn) confirmCancelBtn.addEventListener("click", closeConfirmModal);

    var sysBtn = document.getElementById("rfRunSystemAnalysis");
    if (sysBtn) sysBtn.addEventListener("click", function () {
      showAnalysisConfirm(buildCalibConfirmHTML(), runSystemAnalysis);
    });

    // Shared census-cache status line + Re-fetch (Calibrate context)
    if (sysBtn && typeof App.buildCensusCacheStatus === "function") {
      var ccCalib = App.buildCensusCacheStatus({
        geoSel: document.getElementById("rfCalibGeoLevel"),
        yearSel: document.getElementById("rfCalibYearSelect"),
        onRefetch: function () { sysBtn.click(); }
      });
      sysBtn.parentNode.insertBefore(ccCalib, sysBtn);
    }

    var calibApportionCb = document.getElementById("rfCalibApportionByArea");
    if (calibApportionCb) {
      calibApportionCb.checked = _apportionByArea;
      calibApportionCb.addEventListener("change", function () {
        _apportionByArea = calibApportionCb.checked;
        // Sync to demand tab checkbox
        var demandCb = document.getElementById("rfApportionByArea");
        if (demandCb) demandCb.checked = _apportionByArea;
        markStale();
      });
    }

    var calibNormCb = document.getElementById("rfCalibNormalizeByLength");
    if (calibNormCb) {
      calibNormCb.checked = _normalizeByLength;
      calibNormCb.addEventListener("change", function () {
        _normalizeByLength = calibNormCb.checked;
        var demandNormCb = document.getElementById("rfNormalizeByLength");
        if (demandNormCb) demandNormCb.checked = _normalizeByLength;
        markStale();
      });
    }

    // Buffer distance (mi) — module-owned analysis distance, shared by
    // Calibrate and Demand, independent of the Feature Settings global
    // buffer radius.
    var bufferMilesEl = document.getElementById("rfBufferMiles");
    if (bufferMilesEl) {
      bufferMilesEl.value = String(_bufferMiles);
      bufferMilesEl.addEventListener("change", function () {
        _bufferMiles = App.readAnalysisBufferMiles("rfBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
        updateDemandBufferNote();
        markStale();
      });
    }
    var displayBuffersEl = document.getElementById("rfUseDisplayBuffers");
    if (displayBuffersEl) displayBuffersEl.addEventListener("change", function () {
      _useDisplayBuffers = displayBuffersEl.checked;
      syncBufferControl();
      updateDemandBufferNote();
      markStale();
    });
    syncBufferControl();
    updateDemandBufferNote();

    // Feature selection checklists (Calibrate tab)
    populateFeatureList("rfCalibFeatureList", _calibFeatureFilter);
    wireFeatureSelectLinks("rfCalibSelectAll", "rfCalibSelectNone", "rfCalibFeatureList");

    var uploadBtn = document.getElementById("rfUploadCalibCSV");
    var fileInput = document.getElementById("rfCalibFile");
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        if (fileInput.files.length > 0) handleCalibUpload(fileInput.files[0]);
      });
    }

    var matchBtn = document.getElementById("rfMatchRoutes");
    if (matchBtn) matchBtn.addEventListener("click", runMatchRoutes);

    var calibBtn = document.getElementById("rfRunCalibration");
    if (calibBtn) calibBtn.addEventListener("click", runCalibration);

    // Calibration export/import
    var expCalib = document.getElementById("rfExportCalibJSON");
    if (expCalib) expCalib.addEventListener("click", exportCalibJSON);
    var impCalibBtn = document.getElementById("rfImportCalibJSON");
    var impCalibFile = document.getElementById("rfCalibImportFile");
    if (impCalibBtn && impCalibFile) {
      impCalibBtn.addEventListener("click", function () { impCalibFile.click(); });
      impCalibFile.addEventListener("change", function () {
        if (impCalibFile.files.length > 0) handleCalibImport(impCalibFile.files[0]);
      });
    }

    // Next step link from calibrate
    var goDemand = document.getElementById("rfGoToDemand");
    if (goDemand) goDemand.addEventListener("click", function (e) { e.preventDefault(); switchTab("demand"); });

    // ---- Demand tab ----

    // Feature selection checklists (Demand tab)
    populateFeatureList("rfDemandFeatureList", _demandFeatureFilter);
    wireFeatureSelectLinks("rfDemandSelectAll", "rfDemandSelectNone", "rfDemandFeatureList",
      populateCorridorDropdownFromCheckedFeatures);

    // Wire individual checkbox changes via event delegation
    var demandFeatureListEl = document.getElementById("rfDemandFeatureList");
    if (demandFeatureListEl) {
      demandFeatureListEl.addEventListener("change", function (e) {
        if (e.target && e.target.type === "checkbox") {
          populateCorridorDropdownFromCheckedFeatures();
        }
      });
    }

    // Initial corridor dropdown population from checked demand features
    populateCorridorDropdownFromCheckedFeatures();

    // "Same system as calibration" toggle
    var sameSystemCb = document.getElementById("rfDemandUseSameSystem");
    var sharedPoolCb = document.getElementById("rfSharedPoolMode");
    if (sameSystemCb) {
      sameSystemCb.checked = _demandUseSameSystem;
      sameSystemCb.addEventListener("change", function () {
        _demandUseSameSystem = sameSystemCb.checked;
        var featureSection = document.getElementById("rfDemandFeatureSection");
        if (featureSection) featureSection.style.display = sameSystemCb.checked ? "none" : "";
        // Update corridor dropdown for the new mode
        if (sameSystemCb.checked) {
          populateCorridorDropdown(_perRouteCDI);
        } else {
          populateCorridorDropdownFromCheckedFeatures();
        }
        // Shared pool is redundant when using same system; default it on when going cross-system
        if (sharedPoolCb) {
          sharedPoolCb.disabled = sameSystemCb.checked;
          if (sameSystemCb.checked) {
            sharedPoolCb.checked = false;
            _sharedPoolMode = false;
          } else {
            sharedPoolCb.checked = true;
            _sharedPoolMode = true;
          }
        }
      });
      // Apply initial state
      var featureSection = document.getElementById("rfDemandFeatureSection");
      if (featureSection && _demandUseSameSystem) featureSection.style.display = "none";
    }

    // Shared pool normalization checkbox
    if (sharedPoolCb) {
      sharedPoolCb.checked = _sharedPoolMode;
      sharedPoolCb.disabled = _demandUseSameSystem;
      sharedPoolCb.addEventListener("change", function () {
        _sharedPoolMode = sharedPoolCb.checked;
        _demandStale = true;
        _stale = true;
        if (isPopupVisible()) {
          App.renderModuleState({ statusEl: "rfDemandStatus", stale: true, onRerun: runDemand });
        }
      });
    }

    // Shared pool info button toggles tooltip
    var sharedPoolInfoBtn = document.getElementById("rfSharedPoolInfoBtn");
    var sharedPoolTooltip = document.getElementById("rfSharedPoolTooltip");
    if (sharedPoolInfoBtn && sharedPoolTooltip) {
      sharedPoolInfoBtn.addEventListener("click", function (e) {
        e.preventDefault();
        sharedPoolTooltip.style.display = sharedPoolTooltip.style.display === "none" ? "" : "none";
      });
    }

    var runBtn = document.getElementById("rfRunDemand");
    if (runBtn) runBtn.addEventListener("click", function () {
      showAnalysisConfirm(buildDemandConfirmHTML(), runDemand);
    });

    // Shared census-cache status line + Re-fetch (Demand context)
    if (runBtn && typeof App.buildCensusCacheStatus === "function") {
      var ccDemand = App.buildCensusCacheStatus({
        geoSel: document.getElementById("rfGeoLevel"),
        yearSel: document.getElementById("rfYearSelect"),
        onRefetch: function () { runBtn.click(); }
      });
      runBtn.parentNode.insertBefore(ccDemand, runBtn);
    }

    var apportionCb = document.getElementById("rfApportionByArea");
    if (apportionCb) {
      apportionCb.checked = _apportionByArea;
      apportionCb.addEventListener("change", function () {
        _apportionByArea = apportionCb.checked;
        // Sync to calibrate tab checkbox
        var calibCb = document.getElementById("rfCalibApportionByArea");
        if (calibCb) calibCb.checked = _apportionByArea;
        markStale();
      });
    }

    var corridorSel = document.getElementById("rfCorridorSelect");
    if (corridorSel) {
      corridorSel.addEventListener("change", function () {
        _selectedCorridor = corridorSel.value;
      });
    }

    // CDI info button toggle
    var cdiInfoBtn = document.getElementById("rfCDIInfoBtn");
    var cdiTooltip = document.getElementById("rfCDITooltip");
    if (cdiInfoBtn && cdiTooltip) {
      cdiInfoBtn.addEventListener("click", function () {
        cdiTooltip.style.display = cdiTooltip.style.display === "none" ? "" : "none";
      });
    }

    // Next step links
    var goElast = document.getElementById("rfGoToElasticity");
    if (goElast) goElast.addEventListener("click", function (e) { e.preventDefault(); switchTab("elasticity"); });

    // Export demand
    var expGJ = document.getElementById("rfExportDemandGeoJSON");
    if (expGJ) expGJ.addEventListener("click", exportDemandGeoJSON);
    var expCSV = document.getElementById("rfExportDemandCSV");
    if (expCSV) expCSV.addEventListener("click", exportDemandCSV);

    // Elasticity tab — service type: sync premium sliders then refresh
    var stSelect = document.getElementById("rfServiceType");
    if (stSelect) stSelect.addEventListener("change", function () {
      syncPremiumSliders(stSelect.value);
      refreshElasticity();
    });

    // Service type premium sliders (low/high per service type)
    var premLowSlider = document.getElementById("rfServicePremLow");
    var premLowVal    = document.getElementById("rfServicePremLowVal");
    var premHighSlider = document.getElementById("rfServicePremHigh");
    var premHighVal    = document.getElementById("rfServicePremHighVal");

    function onPremChange() {
      var sid = (document.getElementById("rfServiceType") || {}).value || "local_bus";
      var lo = Math.max(0, Math.min(150, parseInt(premLowVal ? premLowVal.value : 0, 10) || 0));
      var hi = Math.max(0, Math.min(150, parseInt(premHighVal ? premHighVal.value : 0, 10) || 0));
      if (premLowSlider)  premLowSlider.value  = String(lo);
      if (premLowVal)     premLowVal.value     = String(lo);
      if (premHighSlider) premHighSlider.value = String(hi);
      if (premHighVal)    premHighVal.value    = String(hi);
      if (!_servicePremiums[sid]) _servicePremiums[sid] = { low: 0, high: 0 };
      _servicePremiums[sid].low  = lo  / 100;
      _servicePremiums[sid].high = hi / 100;
      refreshElasticity();
    }

    if (premLowSlider) premLowSlider.addEventListener("input", function () {
      if (premLowVal) premLowVal.value = premLowSlider.value;
      onPremChange();
    });
    if (premLowVal) premLowVal.addEventListener("change", onPremChange);
    if (premHighSlider) premHighSlider.addEventListener("input", function () {
      if (premHighVal) premHighVal.value = premHighSlider.value;
      onPremChange();
    });
    if (premHighVal) premHighVal.addEventListener("change", onPremChange);

    var baseHw = document.getElementById("rfBaseHeadway");
    if (baseHw) baseHw.addEventListener("change", refreshElasticity);
    var newHw = document.getElementById("rfNewHeadway");
    if (newHw) newHw.addEventListener("change", refreshElasticity);

    // Frequency elasticity slider
    var freqSlider = document.getElementById("rfFreqElastSlider");
    var freqValue = document.getElementById("rfFreqElastValue");
    if (freqSlider && freqValue) {
      freqSlider.addEventListener("input", function () {
        freqValue.value = freqSlider.value;
        refreshElasticity();
      });
      freqValue.addEventListener("change", function () {
        freqSlider.value = freqValue.value;
        refreshElasticity();
      });
    }

    // Service span elasticity slider
    var spanElastSlider = document.getElementById("rfSpanElastSlider");
    var spanElastValue = document.getElementById("rfSpanElastValue");
    if (spanElastSlider && spanElastValue) {
      spanElastSlider.addEventListener("input", function () {
        spanElastValue.value = spanElastSlider.value;
        _spanElasticity = parseFloat(spanElastSlider.value) || 0.7;
      });
      spanElastValue.addEventListener("change", function () {
        var v = Math.max(0.1, Math.min(1.0, parseFloat(spanElastValue.value) || 0.7));
        spanElastValue.value = v.toFixed(2);
        spanElastSlider.value = String(v);
        _spanElasticity = v;
      });
    }

    // Baseline uncertainty slider (Elasticity tab)
    var uncertSlider = document.getElementById("rfBaseUncertSlider");
    var uncertValue = document.getElementById("rfBaseUncertValue");
    if (uncertSlider && uncertValue) {
      uncertSlider.addEventListener("input", function () {
        uncertValue.value = uncertSlider.value;
        _baselineUncertaintyPct = parseInt(uncertSlider.value, 10) / 100;
        refreshElasticity();
      });
      uncertValue.addEventListener("change", function () {
        var v = Math.max(0, Math.min(60, parseInt(uncertValue.value, 10) || 0));
        uncertValue.value = String(v);
        uncertSlider.value = String(v);
        _baselineUncertaintyPct = v / 100;
        refreshElasticity();
      });
    }

    // Scenarios tab
    var buildBtn = document.getElementById("rfBuildScenarios");
    if (buildBtn) buildBtn.addEventListener("click", buildAndCompareScenarios);

    var expScenCSV = document.getElementById("rfExportScenariosCSV");
    if (expScenCSV) expScenCSV.addEventListener("click", exportScenariosCSV);
    var expScenJSON = document.getElementById("rfExportScenariosJSON");
    if (expScenJSON) expScenJSON.addEventListener("click", exportScenariosJSON);

    // Projections tab
    var projUploadBtn = document.getElementById("rfProjUploadBtn");
    var projFileInput = document.getElementById("rfProjFile");
    if (projUploadBtn && projFileInput) {
      projUploadBtn.addEventListener("click", function () { projFileInput.click(); });
      projFileInput.addEventListener("change", async function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        projFileInput.value = "";
        try {
          var data = await App.parseProjectionsCSV(file);
          App.setProjectionsData(data, file.name);
          App.setStatus("Ready");
          updateProjectionUI();
        } catch (err) {
          App.setStatus("Error");
          var infoEl = document.getElementById("rfProjFileInfo");
          if (infoEl) {
            infoEl.textContent = "Error: " + String(err && err.message ? err.message : err);
            infoEl.style.color = "#e53e3e";
          }
        }
      });
    }

    var projClearBtn = document.getElementById("rfProjClear");
    if (projClearBtn) {
      projClearBtn.addEventListener("click", function () {
        if (!confirm("Remove loaded projection data?")) return;
        App.clearProjectionsData();
        _projectionResults = null;
        updateProjectionUI();
        var resultsEl = document.getElementById("rfProjResults");
        if (resultsEl) resultsEl.style.display = "none";
        var expBtn = document.getElementById("rfExportProjCSV");
        if (expBtn) expBtn.disabled = true;
      });
    }

    var runProjBtn = document.getElementById("rfRunProjections");
    if (runProjBtn) runProjBtn.addEventListener("click", runProjections);

    var expProjCSV = document.getElementById("rfExportProjCSV");
    if (expProjCSV) expProjCSV.addEventListener("click", exportProjectionsCSV);
  }

  // ---- Popup lifecycle hooks ----

  function onOpen(core) {
    document.querySelectorAll(".cc-status").forEach(function (s) { if (s.refresh) s.refresh(); });
    // Sync apportion checkboxes
    var apportionCb = document.getElementById("rfApportionByArea");
    if (apportionCb) apportionCb.checked = _apportionByArea;
    var calibApportionCb = document.getElementById("rfCalibApportionByArea");
    if (calibApportionCb) calibApportionCb.checked = _apportionByArea;

    // Sync buffer distance input + Demand tab note
    var bufferMilesEl = document.getElementById("rfBufferMiles");
    if (bufferMilesEl) bufferMilesEl.value = String(_bufferMiles);
    syncBufferControl();
    updateDemandBufferNote();

    // Sync normalize-by-length checkboxes
    var normCb = document.getElementById("rfNormalizeByLength");
    if (normCb) normCb.checked = _normalizeByLength;
    var calibNormCb = document.getElementById("rfCalibNormalizeByLength");
    if (calibNormCb) calibNormCb.checked = _normalizeByLength;

    // Sync baseline uncertainty slider
    var uncertSlider = document.getElementById("rfBaseUncertSlider");
    var uncertValue = document.getElementById("rfBaseUncertValue");
    var uncertPctInt = Math.round(_baselineUncertaintyPct * 100);
    if (uncertSlider) uncertSlider.value = String(uncertPctInt);
    if (uncertValue) uncertValue.value = String(uncertPctInt);

    // Sync span elasticity slider
    var spanElastSlider = document.getElementById("rfSpanElastSlider");
    var spanElastValue = document.getElementById("rfSpanElastValue");
    if (spanElastSlider) spanElastSlider.value = String(_spanElasticity);
    if (spanElastValue) spanElastValue.value = String(_spanElasticity);

    // Sync service premium sliders for currently selected service type
    var stSelEl = document.getElementById("rfServiceType");
    if (stSelEl) syncPremiumSliders(stSelEl.value);

    // Refresh feature checklists (picks up any features added/removed while popup was closed)
    populateFeatureList("rfCalibFeatureList", _calibFeatureFilter);
    populateFeatureList("rfDemandFeatureList", _demandFeatureFilter);

    // Sync "same system" checkbox and feature section visibility
    var sameSystemCb = document.getElementById("rfDemandUseSameSystem");
    if (sameSystemCb) {
      sameSystemCb.checked = _demandUseSameSystem;
      var featureSection = document.getElementById("rfDemandFeatureSection");
      if (featureSection) featureSection.style.display = _demandUseSameSystem ? "none" : "";
    }

    // Sync shared pool checkbox
    var spCb = document.getElementById("rfSharedPoolMode");
    if (spCb) {
      spCb.checked = _sharedPoolMode;
      spCb.disabled = _demandUseSameSystem;
    }

    // Restore shared-pool refit note if calibration was refitted in shared mode
    var spNoteEl = document.getElementById("rfCalibSharedPoolNote");
    if (spNoteEl) {
      if (_calibration && _calibration.sharedPoolMode) {
        spNoteEl.style.display = "";
        spNoteEl.textContent = "Calibration refitted using shared-pool CDI values " +
          "(factor: " + _calibration.factor.toFixed(4) + ", n=" + _calibration.n + ").";
      } else {
        spNoteEl.style.display = "none";
      }
    }

    // Restore system analysis state
    if (_systemResult) {
      displaySystemResults(_systemResult);
      if (_demandUseSameSystem) {
        populateCorridorDropdown(_perRouteCDI);
      } else {
        populateCorridorDropdownFromCheckedFeatures();
      }
      var step2 = document.getElementById("rfCalibStep2");
      if (step2) { step2.style.opacity = "1"; step2.style.pointerEvents = "auto"; }
    }
    if (_matchResult && _matchResult.matched.length >= 3) {
      var step3 = document.getElementById("rfCalibStep3");
      if (step3) { step3.style.opacity = "1"; step3.style.pointerEvents = "auto"; }
    }

    // Restore demand results
    if (_lastResult) {
      displayDemandResults(_lastResult);
    }

    // Restore corridor dropdown selection
    var corridorSel = document.getElementById("rfCorridorSelect");
    if (corridorSel && _selectedCorridor) corridorSel.value = _selectedCorridor;

    // Show uncalibrated warning if needed
    var uncalibWarn = document.getElementById("rfUncalibratedWarning");
    if (uncalibWarn) uncalibWarn.style.display = _systemResult ? "none" : (_lastResult ? "" : "none");

    if (_stale) markStale();

    // Restore active tab
    switchTab(_activeTab);

    // Restore all scenario form values
    loadAllScenarioForms();

    // LODES warning
    updateLodesWarnings();

    // Projections tab state
    updateProjectionUI();
    if (_projectionResults) displayProjectionTimeline(_projectionResults);
  }

  function onClose(core) {
    // Save all scenario form state
    saveAllScenarioForms();
  }

  async function update(core) {
    if (_lastResult && !core.getUnion()) {
      clearAll();
    } else {
      markStale();
    }
    // Refresh feature checklists if popup is open (picks up added/removed features)
    if (isPopupVisible()) {
      populateFeatureList("rfCalibFeatureList", _calibFeatureFilter);
      populateFeatureList("rfDemandFeatureList", _demandFeatureFilter);
      updateLodesWarnings();
    }
  }

  // ---- Session persistence (cache module hooks) ----

  // Helper: serialize the tpiResult Maps inside a system/demand result.
  function serializeTpiResult(tpi, mode) {
    if (!tpi) return null;
    var obj = {
      geoLevel: tpi.geoLevel,
      year: tpi.year,
      geoids: tpi.geoids ? tpi.geoids.slice() : [],
      effectiveWeights: tpi.effectiveWeights ? Object.assign({}, tpi.effectiveWeights) : {},
      tractFallbackFactors: tpi.tractFallbackFactors ? tpi.tractFallbackFactors.slice() : [],
      apportionByArea: tpi.apportionByArea || false,
      scores: App.mapToObj(tpi.scores),
      factorScores: App.nestedMapToObj(tpi.factorScores),
      rawValues: App.nestedMapToObj(tpi.rawValues)
    };
    if (mode === "full" && tpi.geos) {
      obj.geos = tpi.geos.slice();
    }
    return obj;
  }

  // Helper: reconstruct a tpiResult from serialized data.
  function deserializeTpiResult(r) {
    if (!r) return null;
    return {
      geoLevel: r.geoLevel,
      year: r.year,
      geoids: r.geoids || [],
      geos: r.geos || [],
      effectiveWeights: r.effectiveWeights || {},
      tractFallbackFactors: r.tractFallbackFactors || [],
      apportionByArea: r.apportionByArea || false,
      scores: App.objToMap(r.scores),
      factorScores: App.nestedObjToMap(r.factorScores),
      rawValues: App.nestedObjToMap(r.rawValues)
    };
  }

  function saveRfState(mode) {
    var data = {
      _schemaVersion: 3,
      weights: Object.assign({}, _weights),
      apportionByArea: _apportionByArea,
      bufferMiles: _bufferMiles,
      useDisplayBuffers: _useDisplayBuffers,
      normalizeByLength: _normalizeByLength,
      baselineUncertaintyPct: _baselineUncertaintyPct,
      spanElasticity: _spanElasticity,
      servicePremiums: Object.assign({}, _servicePremiums),
      calibration: _calibration ? Object.assign({}, _calibration) : null,
      scenarios: _scenarios.map(function (s) { return Object.assign({}, s); }),
      selectedCorridor: _selectedCorridor,
      activeTab: _activeTab,
      // Calibration context
      perRouteCDI: _perRouteCDI ? _perRouteCDI.slice() : null,
      calibFeatureFilter: _calibFeatureFilter,
      // Demand context
      demandPerRouteCDI: _demandPerRouteCDI ? _demandPerRouteCDI.slice() : null,
      demandFeatureFilter: _demandFeatureFilter,
      demandUseSameSystem: _demandUseSameSystem,
      // Shared pool normalization (v3)
      sharedPoolMode: _sharedPoolMode,
      // Projection results (lightweight — CDI + scenario objects per year)
      projectionResults: _projectionResults
    };

    if (_systemResult) {
      data.systemResult = {
        systemCDI: _systemResult.systemCDI ? Object.assign({}, _systemResult.systemCDI) : null,
        geoLevel: _systemResult.geoLevel,
        year: _systemResult.year,
        tpiResult: serializeTpiResult(_systemResult.tpiResult, mode)
      };
    }

    if (_demandSystemResult) {
      data.demandSystemResult = {
        systemCDI: _demandSystemResult.systemCDI ? Object.assign({}, _demandSystemResult.systemCDI) : null,
        geoLevel: _demandSystemResult.geoLevel,
        year: _demandSystemResult.year,
        tpiResult: serializeTpiResult(_demandSystemResult.tpiResult, mode)
      };
    }

    return data;
  }

  function restoreRfState(data) {
    if (!data) return;

    if (data.weights) _weights = Object.assign({}, RF_DEFAULT_WEIGHTS, data.weights);
    if (data.apportionByArea != null) _apportionByArea = !!data.apportionByArea;
    if (data.bufferMiles != null && Number.isFinite(data.bufferMiles)) _bufferMiles = data.bufferMiles;
    if (data.useDisplayBuffers != null) _useDisplayBuffers = !!data.useDisplayBuffers;
    if (data.normalizeByLength != null) _normalizeByLength = !!data.normalizeByLength;
    _baselineUncertaintyPct = (data.baselineUncertaintyPct != null && Number.isFinite(data.baselineUncertaintyPct))
      ? data.baselineUncertaintyPct : 0.25;
    _spanElasticity = (data.spanElasticity != null && Number.isFinite(data.spanElasticity))
      ? data.spanElasticity : 0.70;
    if (data.servicePremiums && typeof data.servicePremiums === "object") {
      // Merge stored premiums over defaults (preserves any service types not in saved data)
      for (var spk in data.servicePremiums) {
        if (data.servicePremiums[spk] && typeof data.servicePremiums[spk] === "object") {
          _servicePremiums[spk] = data.servicePremiums[spk];
        }
      }
    }
    if (data.calibration) _calibration = Object.assign({}, data.calibration);
    if (Array.isArray(data.scenarios) && data.scenarios.length === 4) {
      for (var i = 0; i < 4; i++) _scenarios[i] = Object.assign({}, data.scenarios[i]);
    }
    if (data.selectedCorridor && data.selectedCorridor !== "all") _selectedCorridor = data.selectedCorridor;
    if (data.activeTab) _activeTab = data.activeTab;
    if (Array.isArray(data.perRouteCDI)) _perRouteCDI = data.perRouteCDI.slice();

    // v2 fields: feature filters and demand context
    if (data._schemaVersion >= 2) {
      if (data.calibFeatureFilter) _calibFeatureFilter = data.calibFeatureFilter;
      if (Array.isArray(data.demandPerRouteCDI)) _demandPerRouteCDI = data.demandPerRouteCDI.slice();
      if (data.demandFeatureFilter) _demandFeatureFilter = data.demandFeatureFilter;
      if (data.demandUseSameSystem != null) _demandUseSameSystem = !!data.demandUseSameSystem;
    }

    // v3 fields: shared pool mode
    if (data._schemaVersion >= 3) {
      if (data.sharedPoolMode != null) _sharedPoolMode = !!data.sharedPoolMode;
    } else {
      _sharedPoolMode = false; // v1/v2 → v3 migration default
    }

    if (data.systemResult) {
      var tpiRestored = deserializeTpiResult(data.systemResult.tpiResult);
      _systemResult = {
        tpiResult: tpiRestored,
        systemCDI: data.systemResult.systemCDI || null,
        routeCDIs: _perRouteCDI || [],
        geoLevel: data.systemResult.geoLevel,
        year: data.systemResult.year
      };
      _stale = false;

      // If geometry was saved, render RF choropleth and corridor lines immediately
      if (tpiRestored && tpiRestored.geos && tpiRestored.geos.length > 0) {
        var displayCDI = _systemResult.systemCDI ||
          { value: NaN, scored: tpiRestored.geoids.length, total: tpiRestored.geoids.length };
        renderChoropleth({ tpiResult: tpiRestored, corridorCDI: displayCDI });
        App.renderCensusOverlay(tpiRestored.geos);
        if (_perRouteCDI && _perRouteCDI.length > 0) renderCorridorCDILines(_perRouteCDI);
        App.popup.showFloatingWidget("rf-legend", "projects/ridership-legend.html", {
          position: "bottom-left", width: 170, title: "Demand Legend"
        });
      }
    }

    // Restore demand system result (v2)
    if (data.demandSystemResult) {
      var demandTpiRestored = deserializeTpiResult(data.demandSystemResult.tpiResult);
      _demandSystemResult = {
        tpiResult: demandTpiRestored,
        systemCDI: data.demandSystemResult.systemCDI || null,
        routeCDIs: _demandPerRouteCDI || [],
        geoLevel: data.demandSystemResult.geoLevel,
        year: data.demandSystemResult.year
      };
    }

    // Rebuild shared pool derived state from restored data (v3)
    // In shared pool mode, _demandSystemResult IS the shared result; reconstruct calibration CDI.
    if (_sharedPoolMode && _demandSystemResult && Array.isArray(_demandSystemResult.routeCDIs) && _demandSystemResult.routeCDIs.length > 0) {
      _sharedSystemResult = _demandSystemResult;
      _sharedCalibPerRouteCDI = filterRouteCDIs(_demandSystemResult.routeCDIs, _calibFeatureFilter);
    }

    // Restore projection results
    if (Array.isArray(data.projectionResults)) {
      _projectionResults = data.projectionResults;
    }
  }

  // ---- Register module ----

  App.registerModule({
    id: "ridership-forecasting",
    name: "Ridership Forecasting",
    enabled: true,
    popupWidth: 1000,
    popupHTML: "projects/ridership-forecasting-popup.html",

    floatingWidgets: [
      { id: "rf-legend", htmlFile: "projects/ridership-legend.html", position: "bottom-left", width: 170 }
    ],

    init: function (core) { init(core); },
    onOpen: function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear: function () { clearAll(); },
    update: async function (core) { await update(core); }
  });

  // Register with session cache so RF state is saved/restored with features
  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("rf", {
      collect: saveRfState,
      apply: restoreRfState
    });
  }

})();
