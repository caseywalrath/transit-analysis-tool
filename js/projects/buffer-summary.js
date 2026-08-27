// js/projects/buffer-summary.js
// Feature Area Analysis module (formerly Buffer-Area Summary).
// Census variable checkboxes live inside this module's popup.
// Registers as a popup-based module via App.registerModule().
// Depends on: App namespace (utils, census, lodes), App.popup, App.cache.

(function () {
  "use strict";
  var App = window.App;

  // ---- State ----

  var _state = {
    geoLevel: "bg",
    year: "2024",
    apportionByArea: true,
    checkedVars: [], // persisted checkbox values (restored before DOM exists)
    featureFilter: null,
    bufferMiles: App.ANALYSIS_BUFFER_DEFAULT_MILES,
    useDisplayBuffers: false
  };
  var _initialized = false;
  var _hasResults = false; // true once a summary has been computed this session
  var _stale = false; // true when features/walksheds changed since the last run

  // Currently selected #basMapVar value ("" = none / gray outline). Persisted
  // via the cache collect/apply handlers below (Step 1.5) — geometry is not
  // persisted, so the selection is only re-applied once a fresh run repopulates
  // the dropdown (see populateBasMapVarDropdown()).
  var _mapVar = "";

  // Per-geography detail retained from the last successful run (null until
  // then). Populated during runSummary()'s existing fetch/aggregate loop —
  // no additional fetches. Consumed by the choropleth map (Step 1.4) and its
  // hover popup. Shape:
  //   {
  //     geoLevel, year, apportionByArea,
  //     geos,            // full TIGERweb features (bg or tract per geoLevel)
  //     clippedGeos,     // clipped-for-display set when apportioned, else null
  //     fractions,       // Map<GEOID, frac> from App.computeGeoOverlapFractions
  //     tractGeos,       // tractGeosForFallback, or null if no tract-fallback var was fetched
  //     tractFractions,  // Map for tractGeos, or null
  //     displayVars,     // user-checked codes, table order
  //     perGeo,          // varCode -> { level: "geo"|"tract", values: Map<GEOID, number> }
  //                      // (mandatory denominator vars are included too, keyed by code,
  //                      // even though they get no table row)
  //     perGeoParts,     // ratio varCode -> { num: Map, den: Map } (numerator/denominator
  //                      // maps, for a hover popup showing the parts of a ratio)
  //     denomVars        // varCode -> App.getDenominator(varCode) result, for hover %
  //   }
  var _lastGeoData = null;

  // Reusable warning icon for median variables.
  var WARN_ICON = '<span class="var-warn-icon" title="Median estimate \u2014 displayed as an area-weighted average of overlapping geographies\u2019 values. This is not a true median for the buffer area. Use with caution.">\u26A0</span>';

  // Always fetched and always shown in results, regardless of checkbox state.
  var MANDATORY_VARS = ["B01003_001E", "B11001_001E", "B25001_001E", "B25003_003E"];

  // Section order for the checkbox UI. Categories not listed appear after.
  var CATEGORY_ORDER = ["Demographics", "Equity", "Travel", "Housing", "Employment"];

  // Expands group checkbox codes into their member variable codes via the
  // single-source-of-truth helper in utils.js. Non-group codes pass through.
  function expandGroups(codes) {
    var result = [], seen = {};
    for (var i = 0; i < codes.length; i++) {
      var members = App.getCheckboxGroupMembers(codes[i]);
      var list = members.length ? members : [codes[i]];
      for (var j = 0; j < list.length; j++) {
        if (!seen[list[j]]) { seen[list[j]] = true; result.push(list[j]); }
      }
    }
    return result;
  }

  // Builds the variable checkbox markup from VAR_META + GROUP_INFO.
  // Items are grouped by their `category` field; within each section the order
  // follows VAR_META declaration order. Group checkboxes appear once per group
  // at the position of their first member; group-member entries are not rendered
  // individually. Variables with neither `displayInChecklist` nor `group` are
  // hidden (denominator-only / mandatory totals).
  function buildVarChecklistHTML() {
    var meta = App.VAR_META;
    var groupInfo = App.GROUP_INFO;
    var bySection = {};       // category → [{ html, code }]
    var renderedGroup = {};   // groupKey → true once that group's checkbox is emitted

    Object.keys(meta).forEach(function (code) {
      var m = meta[code];
      var category = m.category || "Other";
      if (!bySection[category]) bySection[category] = [];

      if (m.group) {
        if (renderedGroup[m.group]) return;
        renderedGroup[m.group] = true;
        var info = groupInfo[m.group] || { label: m.group };
        bySection[category].push(
          '<label class="var-check"><input type="checkbox" value="' + m.group + '"> ' +
          escapeHtml(info.label) + '</label>'
        );
        return;
      }

      if (!m.displayInChecklist) return;

      var warn = (m.agg === "avg") ? " " + WARN_ICON : "";
      var idAttr = (code === "LODES_WAC_C000") ? ' id="lodesCheckbox"' : '';
      bySection[category].push(
        '<label class="var-check"><input type="checkbox"' + idAttr +
        ' value="' + code + '"> ' + escapeHtml(m.label) + warn + '</label>'
      );
    });

    var out = [];
    var seenCat = {};
    CATEGORY_ORDER.forEach(function (cat) {
      if (!bySection[cat]) return;
      seenCat[cat] = true;
      out.push('<div class="var-group-label">' + escapeHtml(cat) + '</div>');
      out.push(bySection[cat].join(""));
    });
    Object.keys(bySection).forEach(function (cat) {
      if (seenCat[cat]) return;
      out.push('<div class="var-group-label">' + escapeHtml(cat) + '</div>');
      out.push(bySection[cat].join(""));
    });
    return out.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function aggDescription(meta, apportionByArea) {
    if (meta.source === "LODES") return "Sum (block internal points)";
    if (meta.agg === "ratio") return meta.ratioLabel || "Calculated ratio";
    if (meta.agg === "sum") return apportionByArea ? "Sum (area-apportioned)" : "Sum (all overlapping geos)";
    return apportionByArea ? "Area-weighted average" : "Simple average (all overlapping geos)";
  }

  // Context-aware onboarding/empty hint shown until a summary is calculated.
  function emptyHint() {
    var hasFeatures = (App.points || []).length + (App.lines || []).length +
                      (App.routes || []).length + (App.polygons || []).length > 0;
    if (!hasFeatures) {
      return { need: "Draw a point, line, or route to begin.",
               action: "Buffers around your features define the area summarized." };
    }
    return { need: "Select variables and click Calculate Summary.",
             action: "Pick Census/LODES variables above to summarize within your buffers." };
  }

  // ---- Feature selection and analysis-buffer controls ----

  function getFeatureFilter() {
    var el = document.getElementById("basFeatureChecklist");
    var routeIndices = [], lineIndices = [], pointIndices = [], polygonIndices = [];
    if (!el) return { routeIndices: routeIndices, lineIndices: lineIndices,
                      pointIndices: pointIndices, polygonIndices: polygonIndices };
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      if (!cb.checked) continue;
      var type = cb.getAttribute("data-type");
      var idx = parseInt(cb.getAttribute("data-idx"), 10);
      if (type === "route") routeIndices.push(idx);
      else if (type === "line") lineIndices.push(idx);
      else if (type === "point") pointIndices.push(idx);
      else if (type === "polygon") polygonIndices.push(idx);
    }
    return { routeIndices: routeIndices, lineIndices: lineIndices,
             pointIndices: pointIndices, polygonIndices: polygonIndices };
  }

  function filterHas(filter, type, idx) {
    if (!filter) return true;
    var key = type + "Indices";
    return Array.isArray(filter[key]) && filter[key].indexOf(idx) !== -1;
  }

  function applyFeatureFilterToCheckboxes(filter) {
    var boxes = document.querySelectorAll("#basFeatureChecklist input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = filterHas(filter, boxes[i].getAttribute("data-type"),
        parseInt(boxes[i].getAttribute("data-idx"), 10));
    }
  }

  function buildFeatureChecklist() {
    var el = document.getElementById("basFeatureChecklist");
    if (!el) return;
    var previous = {};
    var existing = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < existing.length; i++) {
      previous[existing[i].getAttribute("data-type") + ":" + existing[i].getAttribute("data-idx")] = existing[i].checked;
    }
    el.innerHTML = "";
    var hasFeatures = false;

    function addRow(type, idx, feature, fallback, badge) {
      hasFeatures = true;
      var key = type + ":" + idx;
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", type);
      cb.setAttribute("data-idx", String(idx));
      cb.checked = Object.prototype.hasOwnProperty.call(previous, key)
        ? previous[key] : filterHas(_state.featureFilter, type, idx);
      var label = document.createElement("label");
      label.style.cssText = "flex:1;cursor:pointer;";
      label.textContent = (feature.properties && feature.properties.name) || fallback;
      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = badge;
      label.addEventListener("click", function (event) {
        event.preventDefault();
        cb.checked = !cb.checked;
        _state.featureFilter = getFeatureFilter();
        if (App.cache) App.cache.save();
        renderInputs();
      });
      cb.addEventListener("change", function () {
        _state.featureFilter = getFeatureFilter();
        if (App.cache) App.cache.save();
        renderInputs();
      });
      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(badgeEl);
      el.appendChild(row);
    }

    (App.routes || []).forEach(function (feature, idx) { addRow("route", idx, feature, "Route " + (idx + 1), "R"); });
    (App.lines || []).forEach(function (feature, idx) { addRow("line", idx, feature, "Line " + (idx + 1), "L"); });
    (App.points || []).forEach(function (feature, idx) { addRow("point", idx, feature, "Point " + (idx + 1), "S"); });
    (App.polygons || []).forEach(function (feature, idx) { addRow("polygon", idx, feature, "Polygon " + (idx + 1), "P"); });
    if (!hasFeatures) el.innerHTML = '<div class="rf-empty-note">No features drawn.</div>';
  }

  function syncBufferControl() {
    var input = document.getElementById("basBufferMiles");
    var toggle = document.getElementById("basUseDisplayBuffers");
    if (input) {
      input.value = String(_state.bufferMiles);
      input.disabled = _state.useDisplayBuffers;
    }
    if (toggle) toggle.checked = _state.useDisplayBuffers;
  }

  // ---- Summary runner ----

  async function runSummary() {
    _lastGeoData = null;

    var selectedVars = expandGroups(App.getSelectedVars());
    if (selectedVars.length === 0) {
      App.setStatus("No variables selected");
      App.renderModuleState({ statusEl: "basStatus", emptyEl: "basEmptyState", empty: true, hint: emptyHint() });
      return;
    }

    // displayVars = only what the user checked (these get table rows)
    var displayVars = selectedVars.slice();

    // Always fetch mandatory denominator variables for percent calculations,
    // but do NOT create table rows for them unless the user explicitly selected them.
    var _seen = {};
    for (var mi = 0; mi < selectedVars.length; mi++) _seen[selectedVars[mi]] = true;
    for (var mdi = 0; mdi < MANDATORY_VARS.length; mdi++) {
      if (!_seen[MANDATORY_VARS[mdi]]) { _seen[MANDATORY_VARS[mdi]] = true; selectedVars.push(MANDATORY_VARS[mdi]); }
    }
    // selectedVars now = displayVars + any mandatory denoms not already selected

    var year = document.getElementById("basYearSelect").value;
    var geoLevel = document.getElementById("basGeoLevel").value;
    var apportionByAreaEl = document.getElementById("basApportionByArea");
    var apportionByArea = apportionByAreaEl ? apportionByAreaEl.checked : true;
    var featureFilter = getFeatureFilter();
    var selectedCount = featureFilter.routeIndices.length + featureFilter.lineIndices.length +
      featureFilter.pointIndices.length + featureFilter.polygonIndices.length;
    if (!selectedCount) {
      App.setStatus("No features selected");
      App.renderModuleState({ statusEl: "basStatus", emptyEl: "basEmptyState", empty: true,
        hint: { need: "Select at least one feature to analyze.", action: "Choose a point, line, route, or polygon above." } });
      return;
    }
    _state.bufferMiles = App.readAnalysisBufferMiles("basBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES);
    _state.useDisplayBuffers = !!(document.getElementById("basUseDisplayBuffers") || {}).checked;
    _state.featureFilter = featureFilter;
    var bufferSet = _state.useDisplayBuffers
      ? App.buildDisplayBufferSet(featureFilter)
      : App.buildAnalysisBufferSet(featureFilter, _state.bufferMiles);
    var unionFeat = bufferSet.union;

    // Save state
    _state.year = year;
    _state.geoLevel = geoLevel;
    _state.apportionByArea = apportionByArea;
    if (typeof App.cache !== "undefined") App.cache.save();

    // Separate ACS vs LODES selections
    var acsVars = [];
    var lodesVars = [];
    for (var i = 0; i < selectedVars.length; i++) {
      var meta = App.getMeta(selectedVars[i]);
      if (meta.source === "LODES") {
        lodesVars.push(selectedVars[i]);
      } else {
        acsVars.push(selectedVars[i]);
      }
    }

    // Initialize results table
    var tbody = document.getElementById("basResultsTbody");
    tbody.innerHTML = "";
    var tableEl = document.getElementById("basResultsTable");
    tableEl.style.display = "";
    App.renderModuleState({ statusEl: "basStatus", emptyEl: "basEmptyState" });   // hide onboarding hint + any prior pill
    var progressEl = document.getElementById("basResultsProgress");
    var notesEl = document.getElementById("basResultsNotes");
    notesEl.textContent = "";

    var codeToRows = {};
    var resultsMap = {};
    for (var j = 0; j < displayVars.length; j++) {
      var code = displayVars[j];
      var m = App.getMeta(code);
      var tr = document.createElement("tr");
      tr.className = "result-pending";
      tr.innerHTML =
        "<td>" + (m.category || "\u2014") + "</td>" +
        "<td>" + (m.label || code) + "</td>" +
        "<td>Computing\u2026</td>" +
        "<td>\u2014</td>" +
        "<td>" + aggDescription(m, apportionByArea) + "</td>";
      tbody.appendChild(tr);
      if (!codeToRows[code]) codeToRows[code] = [];
      codeToRows[code].push(tr);
    }

    // Check for the selected analysis union.
    if (!unionFeat) {
      var errMsg = (App.points.length === 0 && App.lines.length === 0 &&
                    App.routes.length === 0 && App.polygons.length === 0)
        ? "No features placed" : "No buffers set";
      for (var k = 0; k < displayVars.length; k++) {
        var errRows = codeToRows[displayVars[k]] || [];
        for (var ei = 0; ei < errRows.length; ei++) {
          errRows[ei].className = "result-error";
          errRows[ei].children[2].textContent = errMsg;
        }
      }
      progressEl.textContent = "";
      App.setStatus("No buffers");
      setStatus(errMsg, "error");
      return;
    }

    // Retain per-geography detail for this run (choropleth map, Step 1.4).
    // Populated below as the existing fetch/aggregate loop runs — no
    // additional fetches happen anywhere in this function because of it.
    _lastGeoData = {
      geoLevel: geoLevel, year: year, apportionByArea: apportionByArea,
      geos: null, clippedGeos: null, fractions: null,
      tractGeos: null, tractFractions: null,
      displayVars: displayVars.slice(),
      perGeo: {}, perGeoParts: {}, denomVars: {}
    };

    // Deduplicate ACS vars so each unique code is only fetched once
    var acsVarsUniq = [];
    var seenAcs = {};
    for (var si = 0; si < acsVars.length; si++) {
      if (!seenAcs[acsVars[si]]) { seenAcs[acsVars[si]] = true; acsVarsUniq.push(acsVars[si]); }
    }
    var lodesVarsUniq = [];
    var seenLodes = {};
    for (var sl = 0; sl < lodesVars.length; sl++) {
      if (!seenLodes[lodesVars[sl]]) { seenLodes[lodesVars[sl]] = true; lodesVarsUniq.push(lodesVars[sl]); }
    }

    var completed = 0;
    var total = acsVarsUniq.length + lodesVarsUniq.length;

    function updateProgress() {
      completed++;
      if (completed < total) {
        progressEl.textContent = "Computing: " + completed + " / " + total + " variables done\u2026";
      } else {
        progressEl.textContent = "All " + total + " variables computed.";
      }
    }

    function updateRows(code, result, varMeta, useTractFallback) {
      resultsMap[code] = result.value;
      var rows = codeToRows[code] || [];
      for (var ri = 0; ri < rows.length; ri++) {
        rows[ri].className = "";
        rows[ri].children[2].textContent = App.formatValue(result.value, varMeta);
        if (useTractFallback) {
          rows[ri].children[4].textContent += " \u2014 Tract-level data (not available at block group)";
        }
      }
    }

    function markRowsError(code, msg) {
      var rows = codeToRows[code] || [];
      for (var ri = 0; ri < rows.length; ri++) {
        rows[ri].className = "result-error";
        rows[ri].children[2].textContent = msg;
      }
    }

    // Shared TIGERweb geometry fetch for all ACS variables
    var geos = null;
    var tractGeosForFallback = null;
    var clippedGeos = null;
    var fractions = null;
    var tractFractions = null;
    if (acsVarsUniq.length > 0) {
      App.setStatus("Querying TIGERweb\u2026");
      progressEl.textContent = "Fetching census geometries\u2026";
      geos = await App.fetchTigerwebGeos(geoLevel, unionFeat);
      _lastGeoData.geos = geos;

      // Overlap fractions computed once per run (not per variable, as the
      // inline version below this step did) \u2014 also needed by the
      // choropleth hover popup's apportioned-share display (Step 1.4).
      fractions = App.computeGeoOverlapFractions(unionFeat, geos, apportionByArea);
      _lastGeoData.fractions = fractions;

      // When apportioning by area, clip each geo to the union so the map
      // display matches the math (same pattern as TPI's computeAreaFractions).
      if (apportionByArea) {
        var clippedForDisplay = [];
        geos.forEach(function (f) {
          try {
            var inter = turf.intersect(f, unionFeat);
            if (inter) clippedForDisplay.push({
              type: "Feature",
              properties: f.properties,
              geometry: inter.geometry
            });
          } catch (_) {}
        });
        clippedGeos = clippedForDisplay.length ? clippedForDisplay : geos;
        _lastGeoData.clippedGeos = clippedGeos;
        App.renderCensusOverlay(clippedGeos);
      } else {
        App.renderCensusOverlay(geos);
      }

      if (geos.length === 0) {
        for (var gi = 0; gi < acsVarsUniq.length; gi++) {
          markRowsError(acsVarsUniq[gi], "No intersecting geographies");
          updateProgress();
        }
      } else {
        var geoids = geos.map(function (f) { return f.properties.GEOID; }).filter(Boolean);

        // Fetch + aggregate each unique ACS variable
        for (var ai = 0; ai < acsVarsUniq.length; ai++) {
          var varCode = acsVarsUniq[ai];
          var varMeta = App.getMeta(varCode);
          var useTractFallback = (geoLevel === "bg" && varMeta.tractOnly);

          try {
            App.setStatus("Fetching ACS: " + (varMeta.label || varCode) + "\u2026");
            progressEl.textContent = "Computing " + (varMeta.label || varCode) +
              " (" + (completed + 1) + "/" + total + ")\u2026";

            var fetchGeoLevel, fetchGeos, fetchGeoids;
            if (useTractFallback) {
              if (!tractGeosForFallback) {
                progressEl.textContent = "Fetching tract geometries for tract-level variables\u2026";
                tractGeosForFallback = await App.fetchTigerwebGeos("tract", unionFeat);
                tractFractions = App.computeGeoOverlapFractions(unionFeat, tractGeosForFallback, apportionByArea);
                _lastGeoData.tractGeos = tractGeosForFallback;
                _lastGeoData.tractFractions = tractFractions;
              }
              fetchGeoLevel = "tract";
              fetchGeos = tractGeosForFallback;
              fetchGeoids = tractGeosForFallback.map(function (f) { return f.properties.GEOID; }).filter(Boolean);
            } else {
              fetchGeoLevel = geoLevel;
              fetchGeos = geos;
              fetchGeoids = geoids;
            }

            var fracsToUse = useTractFallback ? tractFractions : fractions;
            var geoDataLevel = useTractFallback ? "tract" : "geo";

            var result;
            if (varMeta.agg === "ratio") {
              var numMap = await App.fetchACSValues(fetchGeoLevel, year, varMeta.numerator, fetchGeoids);
              var denMap = await App.fetchACSValues(fetchGeoLevel, year, varMeta.denominator, fetchGeoids);
              var numAgg = App.aggregateWithinUnion(unionFeat, fetchGeos, numMap, "sum", { apportionByArea: apportionByArea, fractions: fracsToUse });
              var denAgg = App.aggregateWithinUnion(unionFeat, fetchGeos, denMap, "sum", { apportionByArea: apportionByArea, fractions: fracsToUse });
              var ratioVal = (denAgg.value > 0) ? (numAgg.value / denAgg.value) : NaN;
              result = { value: ratioVal, used: numAgg.used };

              // Per-geo derived ratio (num/den where den > 0), plus the raw
              // parts, for the choropleth hover popup (Step 1.4).
              var ratioMap = new Map();
              numMap.forEach(function (nv, geoid) {
                var dv = denMap.get(geoid);
                if (dv != null && dv > 0) ratioMap.set(geoid, nv / dv);
              });
              _lastGeoData.perGeo[varCode] = { level: geoDataLevel, values: ratioMap };
              _lastGeoData.perGeoParts[varCode] = { num: numMap, den: denMap };
            } else {
              var valueMap;
              if (varMeta.codes && varMeta.codes.length > 0) {
                valueMap = await App.fetchACSMultiValues(fetchGeoLevel, year, varMeta.codes, fetchGeoids);
              } else {
                valueMap = await App.fetchACSValues(fetchGeoLevel, year, varCode, fetchGeoids);
              }
              result = App.aggregateWithinUnion(unionFeat, fetchGeos, valueMap, varMeta.agg, { apportionByArea: apportionByArea, fractions: fracsToUse });
              _lastGeoData.perGeo[varCode] = { level: geoDataLevel, values: valueMap };
            }
            updateRows(varCode, result, varMeta, useTractFallback);
          } catch (e) {
            markRowsError(varCode, "Error: " + (e.message || e));
          }
          updateProgress();
        }
      }
    }

    // LODES variables
    for (var li = 0; li < lodesVarsUniq.length; li++) {
      var lCode = lodesVarsUniq[li];

      if (!App.lodesData) {
        markRowsError(lCode, "LODES file not loaded");
        updateProgress();
        continue;
      }

      try {
        App.setStatus("Computing LODES employment\u2026");
        progressEl.textContent = "Computing LODES employment (" + (completed + 1) + "/" + total + ")\u2026";

        var blocksInside = await App.fetchBlocksInternalPointsInUnion(unionFeat);
        var lodesSum = 0;
        for (var geoid of blocksInside) {
          var v = App.lodesData.get(geoid);
          if (v != null) { lodesSum += v; }
        }

        var lRows = codeToRows[lCode] || [];
        for (var lri = 0; lri < lRows.length; lri++) {
          lRows[lri].className = "";
          lRows[lri].children[2].textContent = lodesSum.toLocaleString(undefined, { maximumFractionDigits: 0 });
        }
      } catch (e) {
        markRowsError(lCode, "Error: " + (e.message || e));
      }
      updateProgress();
    }

    // ---- Percent column pass ----
    var allPctCodes = Object.keys(codeToRows);
    for (var pi = 0; pi < allPctCodes.length; pi++) {
      var pCode = allPctCodes[pi];
      var pDenom = App.getDenominator(pCode);
      if (pDenom) _lastGeoData.denomVars[pCode] = pDenom;
      var pRows = codeToRows[pCode] || [];
      var pct = null;
      if (pDenom && Number.isFinite(resultsMap[pCode])) {
        var den;
        if (pDenom.type === "var") {
          den = resultsMap[pDenom.code];
        } else {
          den = 0;
          for (var dgi = 0; dgi < pDenom.codes.length; dgi++) {
            var gv = resultsMap[pDenom.codes[dgi]];
            if (!Number.isFinite(gv)) { den = null; break; }
            den += gv;
          }
        }
        if (Number.isFinite(den) && den > 0) pct = (resultsMap[pCode] / den) * 100;
      }
      for (var pri = 0; pri < pRows.length; pri++) {
        pRows[pri].children[3].textContent = pct !== null ? pct.toFixed(1) + "%" : "\u2014";
      }
    }

    // Build notes footer
    var geoLabel = (geoLevel === "tract") ? "tracts" : "block groups";
    var notesParts = [];
    if (geos && geos.length > 0) {
      notesParts.push("ACS " + year + " 5-year; " + geos.length + " intersecting " + geoLabel + ".");
    }
    if (tractGeosForFallback && tractGeosForFallback.length > 0) {
      notesParts.push(tractGeosForFallback.length + " tract(s) used for variables not available at block group level.");
    }
    if (lodesVarsUniq.length > 0 && App.lodesData) {
      notesParts.push("LODES file: " + App.lodesFileName + ".");
    }
    var apportionNote = apportionByArea
      ? "counts are area-apportioned (fractional overlap)"
      : "counts include all intersecting geographies in full (no area apportionment)";
    var bufferNote = _state.useDisplayBuffers
      ? "the selected displayed buffers"
      : "a " + _state.bufferMiles + " mi analysis buffer around the selected features";
    var methodNote = 'Summaries are computed within the <b>dissolved union</b> of ' + bufferNote + '. Polygons are included without a buffer. For ACS, ' + apportionNote + '. Medians are shown as an area-weighted average estimate.';
    notesEl.innerHTML = (notesParts.length ? notesParts.join(" ") + "<br>" : "") + methodNote;

    _hasResults = true;
    renderInputs(true);
    if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");

    populateBasMapVarDropdown();

    App.setStatus("Done");
    if (typeof App.notifyProject === "function") await App.notifyProject();
    // This run's own results didn't change — re-assert good state after the
    // broadcast (notifyProject's update() pass would otherwise mark us stale
    // again; same fix as walkshed.js's useAsStudyAreas()).
    _stale = false;
    setStatus("Done", "done");
  }

  // ---- Choropleth (Step 1.4) ----

  // Per-geography percent, mirroring the aggregate percent-column pass
  // (above) but evaluated at a single GEOID using the retained perGeo maps.
  // Returns null whenever the denominator doesn't resolve at this GEOID —
  // including the case where a tract-only variable's own per-geo map (tract
  // GEOIDs) is checked against a non-tract-only denominator's map (bg
  // GEOIDs): the key lookup simply misses, which is the correct "doesn't
  // resolve per-geo" outcome rather than a special case to detect.
  function perGeoPctValue(varCode, geoid) {
    var pDenom = _lastGeoData.denomVars[varCode];
    if (!pDenom) return null;
    var numEntry = _lastGeoData.perGeo[varCode];
    if (!numEntry) return null;
    var numVal = numEntry.values.get(geoid);
    if (typeof numVal !== "number" || !Number.isFinite(numVal)) return null;

    var denVal;
    if (pDenom.type === "var") {
      var denEntry = _lastGeoData.perGeo[pDenom.code];
      if (!denEntry) return null;
      denVal = denEntry.values.get(geoid);
    } else {
      denVal = 0;
      for (var i = 0; i < pDenom.codes.length; i++) {
        var ge = _lastGeoData.perGeo[pDenom.codes[i]];
        if (!ge) return null;
        var gv = ge.values.get(geoid);
        if (typeof gv !== "number" || !Number.isFinite(gv)) return null;
        denVal += gv;
      }
    }
    if (typeof denVal !== "number" || !Number.isFinite(denVal) || denVal <= 0) return null;
    return (numVal / denVal) * 100;
  }

  // Hover popup for the "bas" choropleth. `props.payload` is a JSON string
  // built in renderBasChoropleth() (TPI's stringify-a-nested-object pattern,
  // transit-propensity.js:693) so the source-of-truth formatting lives in one
  // place rather than being re-derived on every mousemove.
  function basHoverHTML(props) {
    if (!props || !props.payload) return null;
    var payload;
    try { payload = JSON.parse(props.payload); } catch (_) { return null; }
    if (!payload) return null;

    var html = '<div style="font-size:12px;line-height:1.4;">';
    html += "<b>GEOID:</b> " + escapeHtml(props.GEOID || "—") + "<br>";
    html += "<b>" + escapeHtml(payload.varLabel) + ":</b> " + escapeHtml(payload.valueFmt);
    var extras = [];
    if (payload.pctFmt) extras.push(escapeHtml(payload.pctFmt));
    if (payload.apportionedFmt) extras.push("apportioned share: " + escapeHtml(payload.apportionedFmt));
    if (extras.length) html += " · " + extras.join(" · ");
    html += "<br>";

    if (payload.others && payload.others.length) {
      html += '<span style="color:#666;font-size:11px;">';
      for (var i = 0; i < payload.others.length; i++) {
        html += escapeHtml(payload.others[i].label) + ": " + escapeHtml(payload.others[i].valueFmt) + "<br>";
      }
      if (payload.moreCount) html += "… " + payload.moreCount + " more<br>";
      html += "</span>";
    }
    html += "</div>";
    return html;
  }

  // varCode === "" removes the choropleth and falls back to the plain gray
  // "geographies analyzed" overlay. Otherwise builds one feature per
  // geography (whole-geography values from _lastGeoData.perGeo — clipped
  // geometry, uncut values, the settled design decision) and renders through
  // the shared App.choropleth engine.
  function renderBasChoropleth(varCode) {
    _mapVar = varCode || "";
    var sel = document.getElementById("basMapVar");
    if (sel && sel.value !== _mapVar) sel.value = _mapVar;

    if (!_mapVar) {
      App.choropleth.remove("bas");
      if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("bas-legend");
      if (_lastGeoData) {
        var overlayGeos = _lastGeoData.apportionByArea
          ? (_lastGeoData.clippedGeos || _lastGeoData.geos)
          : _lastGeoData.geos;
        if (overlayGeos) App.renderCensusOverlay(overlayGeos);
      }
      return;
    }

    if (!_lastGeoData) return;
    var entry = _lastGeoData.perGeo[_mapVar];
    if (!entry) return;
    var meta = App.getMeta(_mapVar);

    var geomSet = (entry.level === "tract")
      ? _lastGeoData.tractGeos
      : (_lastGeoData.apportionByArea ? (_lastGeoData.clippedGeos || _lastGeoData.geos) : _lastGeoData.geos);
    var fracSet = (entry.level === "tract") ? _lastGeoData.tractFractions : _lastGeoData.fractions;
    if (!geomSet) return;

    var features = [];
    for (var gi = 0; gi < geomSet.length; gi++) {
      var geo = geomSet[gi];
      var geoid = geo.properties && geo.properties.GEOID;
      if (!geoid) continue;
      var raw = entry.values.get(geoid);
      var value = (typeof raw === "number" && Number.isFinite(raw)) ? raw : null;

      var payload = { varLabel: meta.label || _mapVar, valueFmt: App.formatValue(value, meta) };

      var frac = fracSet ? fracSet.get(geoid) : null;
      if (typeof frac === "number" && Number.isFinite(frac)) {
        if (_lastGeoData.apportionByArea && value !== null) {
          payload.apportionedFmt = App.formatValue(value * frac, meta);
        }
      }

      var pctVal = perGeoPctValue(_mapVar, geoid);
      if (pctVal !== null) payload.pctFmt = pctVal.toFixed(1) + "%";

      var others = [];
      for (var di = 0; di < _lastGeoData.displayVars.length; di++) {
        var oCode = _lastGeoData.displayVars[di];
        if (oCode === _mapVar) continue;
        var oEntry = _lastGeoData.perGeo[oCode];
        if (!oEntry) continue;
        var oRaw = oEntry.values.get(geoid);
        if (typeof oRaw !== "number" || !Number.isFinite(oRaw)) continue;
        var oMeta = App.getMeta(oCode);
        others.push({ label: oMeta.label || oCode, valueFmt: App.formatValue(oRaw, oMeta) });
      }
      if (others.length > 10) {
        payload.moreCount = others.length - 10;
        others = others.slice(0, 10);
      }
      payload.others = others;

      features.push({
        type: "Feature",
        properties: { GEOID: geoid, value: value, payload: JSON.stringify(payload) },
        geometry: geo.geometry
      });
    }

    var renderResult = App.choropleth.render({
      id: "bas", method: "quantile", classes: 5, ramp: "blues",
      valueProp: "value", features: features, hoverHTML: basHoverHTML, beforeLayer: "buffers-fill"
    });
    if (!renderResult) return;

    // The gray overlay would otherwise sit under the choropleth.
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();

    var hideCb = document.getElementById("basHideChoropleth");
    if (hideCb) hideCb.checked = false;
    App.choropleth.setVisible("bas", true);

    if (App.popup && App.popup.showFloatingWidget) {
      App.popup.showFloatingWidget("bas-legend", "projects/choropleth-legend.html", {
        position: "bottom-left", width: 190, title: "Map Legend"
      }).then(function () {
        var widgetEl = document.querySelector('.floating-widget[data-widget-id="bas-legend"]');
        if (!widgetEl) return;
        var labels = App.choropleth.formatBreakLabels(renderResult.breaks, renderResult.min, renderResult.max,
          function (v) { return App.formatValue(v, meta); });
        App.choropleth.fillLegend(widgetEl, {
          title: meta.label,
          labels: labels,
          colors: renderResult.colors,
          note: "Classes: quantile (5). Values are whole-geography estimates."
        });
      });
    }
  }

  // Populates #basMapVar from _lastGeoData.displayVars after a successful
  // run. LODES codes are skipped in Phase 1 (Step 2.3 adds them). The
  // previous selection is kept when the variable is still present in this
  // run's results; otherwise falls back to "None".
  function populateBasMapVarDropdown() {
    var sel = document.getElementById("basMapVar");
    var rowEl = document.getElementById("basMapRow");
    if (!sel || !rowEl || !_lastGeoData) return;

    var options = ['<option value="">— None (gray outline) —</option>'];
    var validCodes = {};
    for (var i = 0; i < _lastGeoData.displayVars.length; i++) {
      var code = _lastGeoData.displayVars[i];
      var meta = App.getMeta(code);
      if (meta.source === "LODES") continue;
      var entry = _lastGeoData.perGeo[code];
      if (!entry) continue;
      validCodes[code] = true;
      var label = meta.label + (entry.level === "tract" ? " (tract level)" : "");
      options.push('<option value="' + escapeHtml(code) + '">' + escapeHtml(label) + '</option>');
    }
    sel.innerHTML = options.join("");
    rowEl.style.display = "";

    var keep = validCodes[_mapVar] ? _mapVar : "";
    renderBasChoropleth(keep);
  }

  // ---- Apply state to popup DOM ----

  function applyStateToDOM() {
    var geoEl = document.getElementById("basGeoLevel");
    if (geoEl) geoEl.value = _state.geoLevel;
    var yearEl = document.getElementById("basYearSelect");
    if (yearEl) yearEl.value = _state.year;
    var apportionEl = document.getElementById("basApportionByArea");
    if (apportionEl) apportionEl.checked = _state.apportionByArea;
    syncBufferControl();
    applyFeatureFilterToCheckboxes(_state.featureFilter);

    // Restore checkbox selections (LODES checkbox is now inside #varSelect).
    if (_state.checkedVars && _state.checkedVars.length > 0) {
      var checkedSet = {};
      for (var i = 0; i < _state.checkedVars.length; i++) checkedSet[_state.checkedVars[i]] = true;
      var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]');
      for (var j = 0; j < boxes.length; j++) boxes[j].checked = !!checkedSet[boxes[j].value];
    }
  }

  function collectCheckedVars() {
    var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]:checked');
    var codes = [];
    for (var i = 0; i < boxes.length; i++) codes.push(boxes[i].value);
    return codes;
  }

  // ---- Status + stale helpers ----

  function isPopupVisible() {
    return !!(App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "buffer-summary");
  }

  // Local #basStatus pill — distinct from the global App.setStatus(...) toolbar
  // line used throughout runSummary() for fetch-progress messages.
  function setStatus(msg, kind) {
    App.renderModuleState({
      statusEl: "basStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  function showStale() {
    _stale = true;
    if (!isPopupVisible()) return;
    App.renderModuleState({ statusEl: "basStatus", stale: true, onRerun: runSummary });
  }

  // ---- Collapsible inputs (shared helper) ----

  function inputsSummary() {
    var geoEl = document.getElementById("basGeoLevel");
    var yearEl = document.getElementById("basYearSelect");
    var apportionEl = document.getElementById("basApportionByArea");
    var count = collectCheckedVars().length;
    var featureCount = document.querySelectorAll("#basFeatureChecklist input[type=checkbox]:checked").length;
    var geoLabel = geoEl && geoEl.value === "tract" ? "Tracts" : "Block groups";
    return count + " variable" + (count === 1 ? "" : "s") + " \u00b7 " +
      geoLabel + " \u00b7 " + (yearEl ? yearEl.value : _state.year) + " \u00b7 " +
      (apportionEl && apportionEl.checked ? "area apportioned" : "whole geographies") + " \u00b7 " +
      featureCount + " feature" + (featureCount === 1 ? "" : "s");
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".bas-body .rf-settings-col"),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        // Panel width tracks whether there ARE results, not whether the user
        // just collapsed or expanded the inputs — expanding after a run must
        // keep the wide side-by-side layout (collapsed still gets the wide
        // stacked "full-width bar above results" treatment via the
        // .module-inputs-collapsed CSS rule; only pre-run has no results to
        // show wide). Previously this read `isCollapsed && _hasResults`, which
        // shrank the panel back to the narrow "setup" width on re-expand —
        // narrow enough to trip the @container(max-width:620px) stacking rule
        // even with a visible, expanded Inputs column, so results rendered
        // below the Calculate Summary button instead of beside it.
        App.popup.setLayoutMode(_hasResults ? "results" : "setup", true);
      }
    });
  }

  // ---- Clear (Clear / Reset Session lifecycle hook) ----

  // Tears down every trace of a run: the choropleth layers/source, the
  // legend widget, and the gray census overlay all live on the map and must
  // be removed regardless of whether this popup is currently open. Popup-DOM
  // resets (results table, map row, status pill) only run while visible —
  // onOpen() rebuilds that DOM state correctly the next time the popup opens.
  function clearAll() {
    App.choropleth.remove("bas");
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("bas-legend");
    if (typeof App.clearCensusOverlay === "function") App.clearCensusOverlay();
    _lastGeoData = null;
    _hasResults = false;
    _stale = false;
    _mapVar = "";
    if (!isPopupVisible()) return;
    if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
    renderInputs(false);
    var tableEl = document.getElementById("basResultsTable");
    if (tableEl) tableEl.style.display = "none";
    var tbodyEl = document.getElementById("basResultsTbody");
    if (tbodyEl) tbodyEl.innerHTML = "";
    var notesEl = document.getElementById("basResultsNotes");
    if (notesEl) notesEl.textContent = "";
    var progressEl = document.getElementById("basResultsProgress");
    if (progressEl) progressEl.textContent = "";
    var mapRowEl = document.getElementById("basMapRow");
    if (mapRowEl) mapRowEl.style.display = "none";
    var mapVarEl = document.getElementById("basMapVar");
    if (mapVarEl) mapVarEl.innerHTML = "";
    var hideCb = document.getElementById("basHideChoropleth");
    if (hideCb) hideCb.checked = false;
    App.renderModuleState({ statusEl: "basStatus", emptyEl: "basEmptyState", empty: true, hint: emptyHint() });
  }

  // ---- Module registration ----

  App.registerModule({
    id: "buffer-summary",
    name: "Feature Area Analysis",
    enabled: true,
    popupWidth: 1000,
    panelWidths: { setup: 520, results: 900 },
    popupHTML: "projects/buffer-summary-popup.html",

    init: function (core) {
      _initialized = true;

      // Populate the empty #varSelect fieldset from VAR_META.
      // Must run before any querySelectorAll on the checkbox list below.
      var varSelectEl = document.getElementById("varSelect");
      if (varSelectEl) varSelectEl.innerHTML = buildVarChecklistHTML();
      buildFeatureChecklist();

      // Wire Calculate Summary button
      document.getElementById("basRun").addEventListener("click", async function () {
        try {
          await runSummary();
        } catch (e) {
          var msg = "Error: " + (e && e.message ? e.message : e);
          App.setStatus(msg);
          setStatus(msg, "error");
        }
      });

      // Wire Select All / Clear All buttons. LODES is a normal #varSelect
      // checkbox now, so no special-case handling is needed.
      document.getElementById("varSelectAll").addEventListener("click", function () {
        var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
        _state.checkedVars = collectCheckedVars();
        if (typeof App.cache !== "undefined") App.cache.save();
        renderInputs();
      });
      document.getElementById("varClearAll").addEventListener("click", function () {
        var boxes = document.querySelectorAll('#varSelect input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
        _state.checkedVars = [];
        if (typeof App.cache !== "undefined") App.cache.save();
        renderInputs();
      });

      document.getElementById("basFeatureSelectAll").addEventListener("click", function (event) {
        event.preventDefault();
        document.querySelectorAll("#basFeatureChecklist input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
        _state.featureFilter = getFeatureFilter();
        if (App.cache) App.cache.save();
        renderInputs();
      });
      document.getElementById("basFeatureSelectNone").addEventListener("click", function (event) {
        event.preventDefault();
        document.querySelectorAll("#basFeatureChecklist input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        _state.featureFilter = getFeatureFilter();
        if (App.cache) App.cache.save();
        renderInputs();
      });

      var bufferMilesEl = document.getElementById("basBufferMiles");
      if (bufferMilesEl) bufferMilesEl.addEventListener("change", function () {
        _state.bufferMiles = App.readAnalysisBufferMiles(bufferMilesEl, App.ANALYSIS_BUFFER_DEFAULT_MILES);
        syncBufferControl();
        if (App.cache) App.cache.save();
        renderInputs();
      });
      var displayBuffersEl = document.getElementById("basUseDisplayBuffers");
      if (displayBuffersEl) displayBuffersEl.addEventListener("change", function () {
        _state.useDisplayBuffers = displayBuffersEl.checked;
        syncBufferControl();
        if (App.cache) App.cache.save();
        renderInputs();
      });

      var mapVarEl = document.getElementById("basMapVar");
      if (mapVarEl) mapVarEl.addEventListener("change", function () {
        renderBasChoropleth(mapVarEl.value);
        if (App.cache) App.cache.save();
      });
      var hideChoroplethEl = document.getElementById("basHideChoropleth");
      if (hideChoroplethEl) hideChoroplethEl.addEventListener("change", function () {
        App.choropleth.setVisible("bas", !hideChoroplethEl.checked);
        if (hideChoroplethEl.checked) {
          if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("bas-legend");
        } else if (_mapVar) {
          if (App.popup && App.popup.showFloatingWidget) {
            App.popup.showFloatingWidget("bas-legend", "projects/choropleth-legend.html",
              { position: "bottom-left", width: 190, title: "Map Legend" });
          }
        }
      });

      // Auto-save on checkbox change
      document.querySelectorAll('#varSelect input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener("change", function () {
          _state.checkedVars = collectCheckedVars();
          if (typeof App.cache !== "undefined") App.cache.save();
          renderInputs();
        });
      });

      // Apply cached state to DOM
      applyStateToDOM();
      renderInputs(_hasResults ? undefined : false);
      var settingsEl = document.querySelector(".bas-body .rf-settings-col");
      if (settingsEl) settingsEl.addEventListener("change", function () { renderInputs(); });
    },

    onOpen: function (core) {
      // Re-apply state each time popup opens (in case restored from cache)
      buildFeatureChecklist();
      applyStateToDOM();
      renderInputs(false);
      // Show results table if we have results, else a friendly onboarding hint
      var tableEl = document.getElementById("basResultsTable");
      if (tableEl && _hasResults) {
        if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
        tableEl.style.display = "";
        App.renderModuleState({ emptyEl: "basEmptyState" });   // hide hint
        if (_stale) showStale(); else setStatus("Done", "done");
      } else {
        if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
        App.renderModuleState({ statusEl: "basStatus", emptyEl: "basEmptyState", empty: true, hint: emptyHint() });
      }
    },

    onClose: function (core) {
      // Capture current checkbox state on close
      if (document.getElementById("varSelect")) {
        _state.checkedVars = collectCheckedVars();
      }
      if (document.getElementById("basFeatureChecklist")) _state.featureFilter = getFeatureFilter();
    },

    clear: function () { clearAll(); },

    update: function (core) {
      // Features/walksheds changed (this hook only fires via App.notifyProject()).
      // Stale-but-visible with a Re-run banner is the suite convention — the
      // choropleth and results table are left on the map/screen as-is.
      if (isPopupVisible()) buildFeatureChecklist();
      if (_hasResults) showStale();
    }
  });

  // ---- Cache integration ----

  if (typeof App.cache !== "undefined" && typeof App.cache.registerModule === "function") {
    App.cache.registerModule("buffer-summary", {
      collect: function (mode) {
        // If popup is open, read checkboxes from DOM; otherwise use stored state
        var vars = document.getElementById("varSelect") ? collectCheckedVars() : (_state.checkedVars || []);
        return {
          geoLevel: _state.geoLevel,
          year: _state.year,
          apportionByArea: _state.apportionByArea,
          checkedVars: vars,
          featureFilter: document.getElementById("basFeatureChecklist") ? getFeatureFilter() : _state.featureFilter,
          bufferMiles: _state.bufferMiles,
          useDisplayBuffers: _state.useDisplayBuffers,
          mapVar: _mapVar
        };
      },
      apply: function (data) {
        if (data.geoLevel) _state.geoLevel = data.geoLevel;
        if (data.year) _state.year = data.year;
        if (typeof data.apportionByArea === "boolean") _state.apportionByArea = data.apportionByArea;
        if (Array.isArray(data.checkedVars)) _state.checkedVars = data.checkedVars;
        if (data.featureFilter) _state.featureFilter = data.featureFilter;
        if (Number.isFinite(data.bufferMiles)) _state.bufferMiles = data.bufferMiles;
        if (typeof data.useDisplayBuffers === "boolean") _state.useDisplayBuffers = data.useDisplayBuffers;
        // Geometry/results are not persisted (see clearAll()/_lastGeoData) — this
        // only restores which variable the dropdown will re-select on the next
        // successful run (populateBasMapVarDropdown() reads _mapVar as "keep").
        if (typeof data.mapVar === "string") _mapVar = data.mapVar;
        // DOM may not exist yet; applyStateToDOM() is called in onOpen()
      }
    });
  }

})();
