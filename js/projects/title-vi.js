// js/projects/title-vi.js
// Title VI Service Equity Analysis — module registration, popup lifecycle,
// tab switching, CSV import, feature checklists, map overlay, session
// persistence, exports.
// Depends on: App namespace, window.TitleVI (engine), turf (CDN).
// Exports: none (self-registers via App.registerModule)

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var TV  = window.TitleVI;

  // ---- Module-local state ----

  var _policy            = TV.defaultPolicy();
  var _scenarios         = [TV.createScenario("Scenario A")];
  var _activeScenarioIdx = 0;
  var _baseline          = null;
  var _results           = {};  // scenarioId -> analysis result
  var _stale             = false;
  var _running           = false;
  var _initialized       = false;
  var _activeTab         = "policies";
  var _core              = null;   // captured in init() for the stale-banner Re-run button
  var _baselineFeatureFilter = null;

  // Cached demographics per scenario (for instant threshold re-evaluation)
  var _cachedDemographics = {};  // scenarioId -> demographics object
  var _cachedImpactedGeom = {};  // scenarioId -> GeoJSON geometry

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "title-vi";
  }

  // ---- Tab switching ----

  function switchTab(id) {
    _activeTab = id;
    var tabs = document.querySelectorAll(".tvi-tab");
    var panes = document.querySelectorAll(".tvi-tab-content");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-tab") === id) {
        tabs[i].classList.add("tvi-tab-active");
      } else {
        tabs[i].classList.remove("tvi-tab-active");
      }
    }
    for (var j = 0; j < panes.length; j++) {
      if (panes[j].getAttribute("data-tab") === id) {
        panes[j].classList.add("tvi-tab-visible");
      } else {
        panes[j].classList.remove("tvi-tab-visible");
      }
    }
  }

  // ---- Policy read/write from DOM ----

  function readPolicyFromDOM() {
    _policy.majorChange.routeMilesPct.enabled   = !!document.getElementById("tviRuleRouteMiles").checked;
    _policy.majorChange.routeMilesPct.threshold  = parseFloat(document.getElementById("tviThreshRouteMiles").value) || 25;
    _policy.majorChange.revenueHoursPct.enabled  = !!document.getElementById("tviRuleRevHours").checked;
    _policy.majorChange.revenueHoursPct.threshold = parseFloat(document.getElementById("tviThreshRevHours").value) || 25;
    _policy.majorChange.spanHoursPct.enabled     = !!document.getElementById("tviRuleSpan").checked;
    _policy.majorChange.spanHoursPct.threshold   = parseFloat(document.getElementById("tviThreshSpan").value) || 25;
    _policy.majorChange.routeElimination.enabled    = !!document.getElementById("tviRuleElimination").checked;
    _policy.majorChange.eliminatedMilesPct.enabled  = !!document.getElementById("tviRuleEliminatedMiles").checked;
    _policy.majorChange.eliminatedMilesPct.threshold = parseFloat(document.getElementById("tviThreshEliminatedMiles").value) || 25;
    _policy.majorChange.fareChangePct.enabled       = !!document.getElementById("tviRuleFare").checked;
    _policy.majorChange.fareChangePct.threshold  = parseFloat(document.getElementById("tviThreshFare").value) || 10;

    _policy.disparateImpactThresholdPpt       = parseFloat(document.getElementById("tviDiThreshold").value) || 15;
    _policy.disproportionateBurdenThresholdPpt = parseFloat(document.getElementById("tviDbThreshold").value) || 15;

    var geoEl = document.getElementById("tviGeoLevel");
    if (geoEl) _policy.geoLevel = geoEl.value;
    var yearEl = document.getElementById("tviYearSelect");
    if (yearEl) _policy.acsYear = yearEl.value;
  }

  function writePolicyToDOM() {
    document.getElementById("tviRuleRouteMiles").checked   = _policy.majorChange.routeMilesPct.enabled;
    document.getElementById("tviThreshRouteMiles").value    = _policy.majorChange.routeMilesPct.threshold;
    document.getElementById("tviRuleRevHours").checked      = _policy.majorChange.revenueHoursPct.enabled;
    document.getElementById("tviThreshRevHours").value      = _policy.majorChange.revenueHoursPct.threshold;
    document.getElementById("tviRuleSpan").checked          = _policy.majorChange.spanHoursPct.enabled;
    document.getElementById("tviThreshSpan").value          = _policy.majorChange.spanHoursPct.threshold;
    document.getElementById("tviRuleElimination").checked      = _policy.majorChange.routeElimination.enabled;
    document.getElementById("tviRuleEliminatedMiles").checked  = _policy.majorChange.eliminatedMilesPct.enabled;
    document.getElementById("tviThreshEliminatedMiles").value  = _policy.majorChange.eliminatedMilesPct.threshold;
    document.getElementById("tviRuleFare").checked             = _policy.majorChange.fareChangePct.enabled;
    document.getElementById("tviThreshFare").value          = _policy.majorChange.fareChangePct.threshold;

    document.getElementById("tviDiThreshold").value = _policy.disparateImpactThresholdPpt;
    document.getElementById("tviDbThreshold").value = _policy.disproportionateBurdenThresholdPpt;

    var geoEl = document.getElementById("tviGeoLevel");
    if (geoEl) geoEl.value = _policy.geoLevel;
    var yearEl = document.getElementById("tviYearSelect");
    if (yearEl) yearEl.value = _policy.acsYear;
  }

  // ---- Feature checklist helpers ----

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
    badge.textContent = type === "route" ? "R" : type === "line" ? "L" : "P";
    var lbl = document.createElement("label");
    lbl.textContent = name;
    row.appendChild(cb);
    row.appendChild(badge);
    row.appendChild(lbl);
    return row;
  }

  function populateFeatureList(containerId, previousFilter, includePolygons) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";
    var routes = App.routes || [];
    var lines = App.lines || [];
    var polygons = (includePolygons && App.polygons) ? App.polygons : [];
    if (routes.length === 0 && lines.length === 0 && polygons.length === 0) {
      container.innerHTML = '<div class="tiny" style="color:var(--muted);">Draw features on the map first.</div>';
      return;
    }
    for (var ri = 0; ri < routes.length; ri++) {
      var name = (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1));
      var checked = !previousFilter || !previousFilter.routeIndices || previousFilter.routeIndices.indexOf(ri) !== -1;
      container.appendChild(makeFeatureCheckRow("route", ri, name, checked));
    }
    for (var li = 0; li < lines.length; li++) {
      var lname = (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1));
      var lchecked = !previousFilter || !previousFilter.lineIndices || previousFilter.lineIndices.indexOf(li) !== -1;
      container.appendChild(makeFeatureCheckRow("line", li, lname, lchecked));
    }
    for (var pi = 0; pi < polygons.length; pi++) {
      var pname = (polygons[pi].properties && polygons[pi].properties.name) || ("Polygon " + (pi + 1));
      var pchecked = !previousFilter || !previousFilter.polygonIndices || previousFilter.polygonIndices.indexOf(pi) !== -1;
      container.appendChild(makeFeatureCheckRow("polygon", pi, pname, pchecked));
    }
  }

  function readFeatureFilter(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return null;
    var cbs = container.querySelectorAll('input[type="checkbox"]');
    if (cbs.length === 0) return null;
    var routeIndices = [], lineIndices = [], polygonIndices = [];
    var allChecked = true;
    for (var i = 0; i < cbs.length; i++) {
      var type = cbs[i].getAttribute("data-feature-type");
      var idx = parseInt(cbs[i].getAttribute("data-feature-index"), 10);
      if (cbs[i].checked) {
        if (type === "route") routeIndices.push(idx);
        else if (type === "line") lineIndices.push(idx);
        else if (type === "polygon") polygonIndices.push(idx);
      } else {
        allChecked = false;
      }
    }
    if (allChecked) return null;
    return { routeIndices: routeIndices, lineIndices: lineIndices, polygonIndices: polygonIndices };
  }

  function wireFeatureSelectLinks(selectAllId, selectNoneId, containerId) {
    var allLink = document.getElementById(selectAllId);
    var noneLink = document.getElementById(selectNoneId);
    if (allLink) {
      allLink.addEventListener("click", function (e) {
        e.preventDefault();
        var cbs = document.querySelectorAll("#" + containerId + ' input[type="checkbox"]');
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
      });
    }
    if (noneLink) {
      noneLink.addEventListener("click", function (e) {
        e.preventDefault();
        var cbs = document.querySelectorAll("#" + containerId + ' input[type="checkbox"]');
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      });
    }
  }

  // ---- Impact method radio handling ----

  function getSelectedImpactMethod() {
    var radios = document.querySelectorAll('input[name="tviImpactMethod"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) return radios[i].value;
    }
    return "service_loss_area";
  }

  // ---- Route alteration pairing ----

  function fmt(v) {
    return Number.isFinite(v) ? v.toFixed(1) : "\u2014";
  }

  function getActiveScenario() {
    return _scenarios[_activeScenarioIdx] || null;
  }

  function buildFeatureOptions() {
    // Build a list of all drawable features (routes + lines) for dropdown
    var options = [];
    var routes = App.routes || [];
    var lines = App.lines || [];
    for (var ri = 0; ri < routes.length; ri++) {
      var rname = (routes[ri].properties && routes[ri].properties.name) || ("Route " + (ri + 1));
      options.push({ featureType: "route", featureIndex: ri, label: rname });
    }
    for (var li = 0; li < lines.length; li++) {
      var lname = (lines[li].properties && lines[li].properties.name) || ("Line " + (li + 1));
      options.push({ featureType: "line", featureIndex: li, label: lname });
    }
    return options;
  }

  function buildFeatureSelect(selectedRef) {
    var sel = document.createElement("select");
    sel.className = "rf-select";
    sel.style.fontSize = "11px";
    sel.innerHTML = '<option value="">(select feature)</option>';
    var opts = buildFeatureOptions();
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var optEl = document.createElement("option");
      optEl.value = o.featureType + ":" + o.featureIndex;
      optEl.textContent = o.label;
      if (selectedRef && selectedRef.featureType === o.featureType && selectedRef.featureIndex === o.featureIndex) {
        optEl.selected = true;
      }
      sel.appendChild(optEl);
    }
    return sel;
  }

  function parseFeatureRef(selectEl) {
    var val = selectEl.value;
    if (!val) return null;
    var parts = val.split(":");
    var featureType = parts[0];
    var featureIndex = parseInt(parts[1], 10);
    var arr = featureType === "route" ? (App.routes || []) : (App.lines || []);
    var feat = arr[featureIndex];
    var featureName = (feat && feat.properties && feat.properties.name) || (featureType + " " + (featureIndex + 1));
    return { featureType: featureType, featureIndex: featureIndex, featureName: featureName };
  }

  function addAlteration() {
    var scenario = getActiveScenario();
    if (!scenario) return;
    var alt = TV.createAlteration("Adjustment " + (scenario.alterations.length + 1));
    scenario.alterations.push(alt);
    renderAlterationCards();
    markStale();
    saveState();
  }

  function removeAlteration(idx) {
    var scenario = getActiveScenario();
    if (!scenario) return;
    scenario.alterations.splice(idx, 1);
    renderAlterationCards();
    markStale();
    saveState();
  }

  function onAlterationChanged(idx) {
    readPolicyFromDOM();
    var scenario = getActiveScenario();
    if (!scenario || !scenario.alterations[idx]) return;
    var alt = scenario.alterations[idx];
    var card = document.querySelector('[data-alteration-idx="' + idx + '"]');
    if (!card) return;

    // Read change type
    var typeSelect = card.querySelector(".tvi-alt-type");
    if (typeSelect) alt.changeType = typeSelect.value;

    // Read feature refs
    var beforeSelect = card.querySelector(".tvi-alt-before");
    var afterSelect = card.querySelector(".tvi-alt-after");
    if (beforeSelect) alt.before = parseFeatureRef(beforeSelect);
    if (afterSelect) alt.after = parseFeatureRef(afterSelect);

    // Read name
    var nameInput = card.querySelector(".tvi-alt-name");
    if (nameInput) alt.name = nameInput.value;

    // Read manual inputs
    alt.manual = readManualInputs(card);

    // Show/hide before/after rows based on change type
    var beforeRow = card.querySelector(".tvi-before-row");
    var afterRow = card.querySelector(".tvi-after-row");
    if (beforeRow) beforeRow.style.display = alt.changeType === "new_route" ? "none" : "flex";
    if (afterRow) afterRow.style.display = alt.changeType === "elimination" ? "none" : "flex";

    // Compute metrics if sufficient features selected
    var canCompute = false;
    if (alt.changeType === "adjustment" && alt.before && alt.after) canCompute = true;
    if (alt.changeType === "elimination" && alt.before) canCompute = true;
    if (alt.changeType === "new_route" && alt.after) canCompute = true;

    if (canCompute) {
      var bufferMiles = _policy.bufferDistanceMiles || 0.5;
      alt.computed = TV.computeAlterationMetrics(alt, bufferMiles);
      displayComputedMetrics(card, alt);
    } else {
      alt.computed = null;
      clearComputedMetrics(card);
    }

    markStale();
    saveState();
  }

  function readManualInputs(card) {
    function numVal(selector) {
      var el = card.querySelector(selector);
      if (!el) return null;
      var v = parseFloat(el.value);
      return Number.isFinite(v) ? v : null;
    }
    return {
      revenueHours: { before: numVal(".tvi-man-revhrs-before"), after: numVal(".tvi-man-revhrs-after") },
      spanHours:    { before: numVal(".tvi-man-span-before"),    after: numVal(".tvi-man-span-after") },
      fare:         { before: numVal(".tvi-man-fare-before"),    after: numVal(".tvi-man-fare-after") }
    };
  }

  function setMscFlag(card, spanClass, triggered) {
    var el = card.querySelector("." + spanClass);
    if (!el) return;
    if (triggered) {
      el.textContent = "\u26A0";
      el.title = "Qualifies as a Major Service Change";
    } else {
      el.textContent = "";
      el.title = "";
    }
  }

  function displayComputedMetrics(card, alt) {
    var section = card.querySelector(".tvi-computed-section");
    if (!section) return;
    section.style.display = "block";
    var c = alt.computed || {};
    var mc = _policy.majorChange || {};

    section.querySelector(".tvi-cm-before-mi").textContent = fmt(c.beforeMiles) + " mi";
    section.querySelector(".tvi-cm-after-mi").textContent = fmt(c.afterMiles) + " mi";
    section.querySelector(".tvi-cm-miles-pct").textContent = c.routeMilesPct !== null ? (c.routeMilesPct >= 0 ? "+" : "") + fmt(c.routeMilesPct) + "%" : "\u2014";
    var alteredStr = c.alteredPct !== null ? fmt(c.alteredPct) + "% (" + fmt(c.alteredMiles) + " mi)" : "\u2014";
    section.querySelector(".tvi-cm-altered").textContent = alteredStr;

    var revhrsEl = section.querySelector(".tvi-cm-revhrs-pct");
    if (revhrsEl) revhrsEl.textContent = c.revenueHoursPct !== null && Number.isFinite(c.revenueHoursPct) ? (c.revenueHoursPct >= 0 ? "+" : "") + fmt(c.revenueHoursPct) + "%" : "\u2014";
    var spanEl = section.querySelector(".tvi-cm-span-pct");
    if (spanEl) spanEl.textContent = c.spanHoursPct !== null && Number.isFinite(c.spanHoursPct) ? (c.spanHoursPct >= 0 ? "+" : "") + fmt(c.spanHoursPct) + "%" : "\u2014";
    var fareEl = section.querySelector(".tvi-cm-fare-pct");
    if (fareEl) fareEl.textContent = c.farePct !== null && Number.isFinite(c.farePct) ? (c.farePct >= 0 ? "+" : "") + fmt(c.farePct) + "%" : "\u2014";

    // Show loss/gain indicators
    var lossEl = section.querySelector(".tvi-cm-loss");
    var gainEl = section.querySelector(".tvi-cm-gain");
    if (lossEl) lossEl.textContent = c.serviceLossArea ? "Yes" : "None";
    if (gainEl) gainEl.textContent = c.serviceGainArea ? "Yes" : "None";

    // MSC flags
    var milesCfg = mc.routeMilesPct || {};
    setMscFlag(card, "tvi-cm-flag-miles",
      milesCfg.enabled && Number.isFinite(c.routeMilesPct) && Math.abs(c.routeMilesPct) >= milesCfg.threshold);

    var elimCfg = mc.routeElimination || {};
    var elimMilesCfg = mc.eliminatedMilesPct || {};
    var elimFlagTriggered =
      (elimCfg.enabled && alt.changeType === "elimination") ||
      (elimMilesCfg.enabled && Number.isFinite(c.alteredPct) && Math.abs(c.alteredPct) >= elimMilesCfg.threshold);
    setMscFlag(card, "tvi-cm-flag-elim", elimFlagTriggered);

    var revhrsCfg = mc.revenueHoursPct || {};
    setMscFlag(card, "tvi-cm-flag-revhrs",
      revhrsCfg.enabled && Number.isFinite(c.revenueHoursPct) && Math.abs(c.revenueHoursPct) >= revhrsCfg.threshold);

    var spanCfg = mc.spanHoursPct || {};
    setMscFlag(card, "tvi-cm-flag-span",
      spanCfg.enabled && Number.isFinite(c.spanHoursPct) && Math.abs(c.spanHoursPct) >= spanCfg.threshold);

    var fareCfg = mc.fareChangePct || {};
    setMscFlag(card, "tvi-cm-flag-fare",
      fareCfg.enabled && Number.isFinite(c.farePct) && Math.abs(c.farePct) >= fareCfg.threshold);
  }

  function clearComputedMetrics(card) {
    var section = card.querySelector(".tvi-computed-section");
    if (section) section.style.display = "none";
  }

  function renderAlterationCards() {
    var container = document.getElementById("tviAlterationsContainer");
    var emptyEl = document.getElementById("tviAlterationsEmpty");
    if (!container) return;
    container.innerHTML = "";

    var scenario = getActiveScenario();
    if (!scenario || scenario.alterations.length === 0) {
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    for (var i = 0; i < scenario.alterations.length; i++) {
      var alt = scenario.alterations[i];
      var card = buildAlterationCard(i, alt);
      container.appendChild(card);
    }
    // Cards are rebuilt from scratch here (the one choke point every caller
    // goes through), so their loss/gain swatches need re-tinting each time.
    fillSwatchColors();
  }

  function buildAlterationCard(idx, alt) {
    var card = document.createElement("div");
    card.className = "tvi-alteration-card";
    card.setAttribute("data-alteration-idx", String(idx));

    // Header: name input + type dropdown + delete button
    var header = document.createElement("div");
    header.className = "tvi-alteration-header";

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "tvi-alt-name";
    nameInput.value = alt.name || "";
    nameInput.placeholder = "Adjustment name";

    var typeSelect = document.createElement("select");
    typeSelect.className = "tvi-alt-type";
    typeSelect.innerHTML =
      '<option value="adjustment">Adjustment</option>' +
      '<option value="elimination">Elimination</option>' +
      '<option value="new_route">New Route</option>';
    typeSelect.value = alt.changeType || "adjustment";

    var delBtn = document.createElement("button");
    delBtn.className = "tvi-alt-delete";
    delBtn.textContent = "\u00D7";
    delBtn.title = "Remove adjustment";

    header.appendChild(nameInput);
    header.appendChild(typeSelect);
    header.appendChild(delBtn);
    card.appendChild(header);

    // Before feature row
    var beforeRow = document.createElement("div");
    beforeRow.className = "tvi-alt-feature-row tvi-before-row";
    var beforeLabel = document.createElement("label");
    beforeLabel.textContent = "Before:";
    var beforeSel = buildFeatureSelect(alt.before);
    beforeSel.className += " tvi-alt-before";
    beforeRow.appendChild(beforeLabel);
    beforeRow.appendChild(beforeSel);
    if (alt.changeType === "new_route") beforeRow.style.display = "none";
    card.appendChild(beforeRow);

    // After feature row
    var afterRow = document.createElement("div");
    afterRow.className = "tvi-alt-feature-row tvi-after-row";
    var afterLabel = document.createElement("label");
    afterLabel.textContent = "After:";
    var afterSel = buildFeatureSelect(alt.after);
    afterSel.className += " tvi-alt-after";
    afterRow.appendChild(afterLabel);
    afterRow.appendChild(afterSel);
    if (alt.changeType === "elimination") afterRow.style.display = "none";
    card.appendChild(afterRow);

    // Computed metrics section (hidden until computed)
    var computedSection = document.createElement("div");
    computedSection.className = "tvi-computed-section";
    computedSection.style.display = alt.computed ? "block" : "none";
    computedSection.innerHTML =
      '<div class="tvi-computed-grid">' +
        '<div><span class="tvi-metric-label">Before miles:</span> <span class="tvi-metric-value tvi-cm-before-mi">\u2014</span></div>' +
        '<div><span class="tvi-metric-label">After miles:</span> <span class="tvi-metric-value tvi-cm-after-mi">\u2014</span></div>' +
        '<div><span class="tvi-metric-label">Miles change:</span> <span class="tvi-metric-value tvi-cm-miles-pct">\u2014</span><span class="tvi-msc-flag tvi-cm-flag-miles"></span></div>' +
        '<div><span class="tvi-metric-label">Eliminated:</span> <span class="tvi-metric-value tvi-cm-altered">\u2014</span><span class="tvi-msc-flag tvi-cm-flag-elim"></span></div>' +
        '<div><span class="tvi-metric-label"><span class="tvi-loss-swatch"></span>Service loss:</span> <span class="tvi-metric-value tvi-cm-loss">\u2014</span></div>' +
        '<div><span class="tvi-metric-label"><span class="tvi-gain-swatch"></span>Service gain:</span> <span class="tvi-metric-value tvi-cm-gain">\u2014</span></div>' +
        '<div><span class="tvi-metric-label">Rev hours change:</span> <span class="tvi-metric-value tvi-cm-revhrs-pct">\u2014</span><span class="tvi-msc-flag tvi-cm-flag-revhrs"></span></div>' +
        '<div><span class="tvi-metric-label">Span change:</span> <span class="tvi-metric-value tvi-cm-span-pct">\u2014</span><span class="tvi-msc-flag tvi-cm-flag-span"></span></div>' +
        '<div><span class="tvi-metric-label">Fare change:</span> <span class="tvi-metric-value tvi-cm-fare-pct">\u2014</span><span class="tvi-msc-flag tvi-cm-flag-fare"></span></div>' +
      '</div>';
    card.appendChild(computedSection);

    // If already computed, fill in values
    if (alt.computed) displayComputedMetrics(card, alt);

    // Manual inputs section
    var manualSection = document.createElement("div");
    manualSection.className = "tvi-manual-section";
    manualSection.innerHTML =
      '<div class="tiny" style="font-weight:600;margin-bottom:4px;">Service Characteristics</div>' +
      buildManualRow("Rev hours:", "tvi-man-revhrs", alt.manual && alt.manual.revenueHours) +
      buildManualRow("Span (hrs):", "tvi-man-span", alt.manual && alt.manual.spanHours) +
      buildManualRow("Fare:", "tvi-man-fare", alt.manual && alt.manual.fare);
    card.appendChild(manualSection);

    // Wire events
    var capturedIdx = idx;
    nameInput.addEventListener("change", function () { onAlterationChanged(capturedIdx); });
    typeSelect.addEventListener("change", function () { onAlterationChanged(capturedIdx); });
    beforeSel.addEventListener("change", function () { onAlterationChanged(capturedIdx); });
    afterSel.addEventListener("change", function () { onAlterationChanged(capturedIdx); });
    delBtn.addEventListener("click", function () { removeAlteration(capturedIdx); });

    // Manual input change events
    var manInputs = manualSection.querySelectorAll('input[type="number"]');
    for (var m = 0; m < manInputs.length; m++) {
      manInputs[m].addEventListener("change", function () { onAlterationChanged(capturedIdx); });
    }

    return card;
  }

  function buildManualRow(labelText, classPrefix, values) {
    var b = (values && Number.isFinite(values.before)) ? values.before : "";
    var a = (values && Number.isFinite(values.after)) ? values.after : "";
    return '<div class="tvi-manual-row">' +
      '<label>' + labelText + '</label>' +
      '<input type="number" step="any" class="' + classPrefix + '-before" value="' + b + '" placeholder="\u2014">' +
      '<span class="tvi-arrow">\u2192</span>' +
      '<input type="number" step="any" class="' + classPrefix + '-after" value="' + a + '" placeholder="\u2014">' +
      '</div>';
  }

  // ---- Stale detection ----

  function markStale() {
    _stale = true;
    App.renderModuleState({
      statusEl: "tviStaleWarning",
      stale: true,
      onRerun: function () { if (_core) runAnalysis(_core); }
    });
  }

  function clearStale() {
    _stale = false;
    App.renderModuleState({ statusEl: "tviStaleWarning" });
  }

  // ---- Baseline computation ----

  async function runBaseline(core) {
    if (_running) return;
    _running = true;
    var statusEl = document.getElementById("tviAnalysisStatus");
    if (statusEl) statusEl.textContent = "Computing system baseline...";

    try {
      readPolicyFromDOM();
      _baselineFeatureFilter = readFeatureFilter("tviBaselineFeatureList");

      // Build system union polygon from selected features
      var unionGeom = null;
      if (_baselineFeatureFilter) {
        unionGeom = buildUnionFromFilter(_baselineFeatureFilter);
      } else {
        unionGeom = App.bufferUnionPolygon ? App.bufferUnionPolygon() : (core.getUnion ? core.getUnion() : null);
      }

      if (!unionGeom) {
        if (statusEl) statusEl.textContent = "Error: No features drawn. Draw routes/lines on the map first.";
        _running = false;
        return;
      }

      var demographics = await TV.fetchDemographics(core, unionGeom, _policy.geoLevel, _policy.acsYear);

      _baseline = {
        type: "system_population",
        geoLevel: _policy.geoLevel,
        year: _policy.acsYear,
        minorityShare: demographics.minorityShare,
        lowIncomeShare: demographics.lowIncomeShare,
        totalPop: demographics.totalPop,
        minorityPop: demographics.minorityPop,
        lowIncomePop: demographics.lowIncomePop,
        geoCount: demographics.geoCount,
        computedAt: new Date().toISOString()
      };

      displayBaseline();
      if (statusEl) statusEl.textContent = "Baseline computed successfully.";
      saveState();
    } catch (e) {
      if (statusEl) statusEl.textContent = "Error computing baseline: " + e.message;
    }
    _running = false;
  }

  function displayBaseline() {
    if (!_baseline) return;
    var box = document.getElementById("tviBaselineBox");
    if (box) box.style.display = "block";
    var minEl = document.getElementById("tviBaselineMinority");
    if (minEl) minEl.textContent = (_baseline.minorityShare * 100).toFixed(1) + "%";
    var liEl = document.getElementById("tviBaselineLowIncome");
    if (liEl) liEl.textContent = (_baseline.lowIncomeShare * 100).toFixed(1) + "%";
    var geoEl = document.getElementById("tviBaselineGeos");
    if (geoEl) geoEl.textContent = String(_baseline.geoCount);
    var popEl = document.getElementById("tviBaselinePop");
    if (popEl) popEl.textContent = _baseline.totalPop.toLocaleString();
  }

  // ---- Build union from feature filter ----

  function buildUnionFromFilter(filter) {
    var bufs = [];
    var routeBuffers = App.routeBuffers || [];
    var lineBuffers = App.lineBuffers || [];
    if (filter.routeIndices) {
      for (var i = 0; i < filter.routeIndices.length; i++) {
        var ri = filter.routeIndices[i];
        if (routeBuffers[ri]) bufs.push(routeBuffers[ri]);
      }
    }
    if (filter.lineIndices) {
      for (var j = 0; j < filter.lineIndices.length; j++) {
        var li = filter.lineIndices[j];
        if (lineBuffers[li]) bufs.push(lineBuffers[li]);
      }
    }
    if (filter.polygonIndices) {
      var polygons = App.polygons || [];
      for (var k = 0; k < filter.polygonIndices.length; k++) {
        var pi = filter.polygonIndices[k];
        if (polygons[pi]) bufs.push(polygons[pi]);
      }
    }
    if (bufs.length === 0) return null;
    var result = bufs[0];
    for (var u = 1; u < bufs.length; u++) {
      try { result = turf.union(result, bufs[u]); } catch (e) { /* skip */ }
    }
    return result;
  }

  // ---- Run equity analysis ----

  async function runAnalysis(core) {
    if (_running) return;
    if (!_baseline) {
      var statusEl = document.getElementById("tviAnalysisStatus");
      if (statusEl) statusEl.textContent = "Compute a system baseline first.";
      return;
    }
    _running = true;
    var statusEl = document.getElementById("tviAnalysisStatus");
    if (statusEl) statusEl.textContent = "Running equity analysis...";

    try {
      readPolicyFromDOM();
      var scenario = _scenarios[_activeScenarioIdx];

      // Update scenario's impact method from DOM
      scenario.impactMethod = getSelectedImpactMethod();

      // Compute alteration metrics (ensure all are up-to-date)
      var bufferMiles = _policy.bufferDistanceMiles || 0.5;
      for (var ai = 0; ai < scenario.alterations.length; ai++) {
        scenario.alterations[ai].computed = TV.computeAlterationMetrics(scenario.alterations[ai], bufferMiles);
      }

      // 1. Major Change evaluation
      var mcResult = TV.evaluateMajorChange(_policy, scenario);

      // 2. Build impacted area
      var impactedArea = TV.buildImpactedArea(scenario);
      if (!impactedArea.geometry) {
        if (statusEl) statusEl.textContent = "Error: No impacted area geometry. Draw features or select an impact method with available features.";
        _running = false;
        return;
      }

      // 3. Fetch demographics for impacted area
      var demographics = await TV.fetchDemographics(core, impactedArea.geometry, _policy.geoLevel, _policy.acsYear);

      // 4. Evaluate findings
      var findings = TV.evaluateFindings(demographics, _baseline, _policy);

      // 5. Cache for instant re-evaluation
      _cachedDemographics[scenario.id] = demographics;
      _cachedImpactedGeom[scenario.id] = impactedArea.geometry;

      // 6. Store result
      var result = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        scenario: scenario,
        majorChangeResult: mcResult,
        demographics: demographics,
        findings: findings,
        impactedAreaGeometry: impactedArea.geometry,
        computedAt: new Date().toISOString()
      };
      _results[scenario.id] = result;

      // 7. Display
      displayResults(result);
      renderImpactedArea(impactedArea.geometry);
      clearStale();

      if (statusEl) statusEl.textContent = "Analysis complete.";
      saveState();
    } catch (e) {
      if (statusEl) statusEl.textContent = "Error: " + e.message;
    }
    _running = false;
  }

  // ---- Instant re-evaluation (threshold changes only) ----

  function runInstantReevaluation() {
    var scenario = _scenarios[_activeScenarioIdx];
    if (!scenario) return;
    var cached = _cachedDemographics[scenario.id];
    if (!cached || !_baseline) return;

    readPolicyFromDOM();

    var mcResult = TV.evaluateMajorChange(_policy, scenario);
    var findings = TV.evaluateFindings(cached, _baseline, _policy);

    var result = _results[scenario.id];
    if (result) {
      result.majorChangeResult = mcResult;
      result.findings = findings;
      displayResults(result);
    }
  }

  // ---- Display results ----

  function displayResults(result) {
    var emptyEl = document.getElementById("tviResultsEmpty");
    var wrapEl = document.getElementById("tviResultsWrap");
    if (emptyEl) emptyEl.style.display = "none";
    if (wrapEl) wrapEl.style.display = "block";

    // Major Change
    var mcVerdict = document.getElementById("tviMcVerdict");
    if (mcVerdict) {
      if (result.majorChangeResult.triggered) {
        setPill(mcVerdict, "Major Change Triggered", "high");
      } else {
        setPill(mcVerdict, "Not a Major Change", "low");
      }
    }

    var mcRulesEl = document.getElementById("tviMcRules");
    if (mcRulesEl) {
      mcRulesEl.innerHTML = "";
      var rr = result.majorChangeResult.ruleResults || [];
      for (var i = 0; i < rr.length; i++) {
        var rule = rr[i];
        var div = document.createElement("div");
        div.className = "tvi-rule-result";
        var pillClass = rule.triggered ? "high" : "mh";
        var valueStr = typeof rule.metricValue === "number"
          ? (rule.metricValue >= 0 ? "+" : "") + rule.metricValue.toFixed(1) + "%"
          : rule.metricValue;
        div.innerHTML =
          '<span class="pill ' + pillClass + '" style="font-size:11px;">' + (rule.triggered ? "TRIGGERED" : "OK") + '</span> ' +
          '<span class="tiny">' + rule.label + ' — ' + rule.routeName +
          ' (' + valueStr + (rule.threshold ? ' vs ' + rule.threshold + '%' : '') + ')</span>';
        mcRulesEl.appendChild(div);
      }
      if (rr.length === 0) {
        mcRulesEl.innerHTML = '<div class="tiny" style="color:var(--muted);">No route alterations defined. Add alterations in Policies & Inputs tab.</div>';
      }
    }

    // Minority / Disparate Impact
    displayFinding("Di", result.findings.minority);

    // Low-Income / Disproportionate Burden
    displayFinding("Db", result.findings.lowIncome);

    // Summary stats
    var geoEl = document.getElementById("tviSummaryGeos");
    if (geoEl) geoEl.textContent = String(result.demographics.geoCount);
    var popEl = document.getElementById("tviSummaryPop");
    if (popEl) popEl.textContent = result.demographics.totalPop.toLocaleString();

    // Enable export buttons
    var csvBtn = document.getElementById("tviExportCSV");
    if (csvBtn) csvBtn.disabled = false;
    var geoBtn = document.getElementById("tviExportGeoJSON");
    if (geoBtn) geoBtn.disabled = false;

    // Update comparison table
    updateComparisonTable();
  }

  function displayFinding(prefix, finding) {
    var verdict = document.getElementById("tvi" + prefix + "Verdict");
    if (verdict) {
      if (finding.exceedsThreshold) {
        setPill(verdict, finding.finding, "high");
      } else {
        setPill(verdict, finding.finding, "mh");
      }
    }
    var impEl = document.getElementById("tvi" + prefix + "Impacted");
    if (impEl) impEl.textContent = (finding.impactedShare * 100).toFixed(1) + "%";
    var baseEl = document.getElementById("tvi" + prefix + "Baseline");
    if (baseEl) baseEl.textContent = (finding.baselineShare * 100).toFixed(1) + "%";
    var diffEl = document.getElementById("tvi" + prefix + "Diff");
    if (diffEl) diffEl.textContent = (finding.diffPpt >= 0 ? "+" : "") + finding.diffPpt.toFixed(1) + " ppt";
    var threshEl = document.getElementById("tvi" + prefix + "Thresh");
    if (threshEl) threshEl.textContent = finding.thresholdPpt + " ppt";
  }

  function setPill(el, text, cls) {
    el.textContent = text;
    el.className = "pill " + cls;
  }

  // ---- Map overlay for impacted area ----

  // Colors resolve through the layer style cascade (Phase 7 of
  // docs/layer-color-customization-plan.md) — a categorical spec with two
  // classes, [loss, gain]. Both the fill and the outline of each class share
  // one color, so a class is one swatch, not two. The fallback array is
  // byte-identical to the spec's defaultColors so a missing layer-palettes.js
  // degrades to the original red/green rather than throwing.
  var TVI_DEFAULT_COLORS = ["#e53e3e", "#38a169"];
  function tviColors() {
    return (typeof App.resolveLayerColors === "function" &&
            App.resolveLayerColors("title-vi")) || TVI_DEFAULT_COLORS;
  }

  // The loss/gain swatches next to each alteration card's computed metrics
  // are styled by CSS class, so they'd keep showing red/green after a recolor
  // — the in-panel equivalent of a legend lying about the map. There can be
  // one pair per alteration card, so this fills every instance.
  function fillSwatchColors() {
    if (typeof window.LayerPalette === "undefined") return;
    var c = tviColors();
    [[".tvi-loss-swatch", c[0]], [".tvi-gain-swatch", c[1]]].forEach(function (pair) {
      var bg = window.LayerPalette.rgba(pair[1], 0.4);
      var els = document.querySelectorAll(pair[0]);
      for (var i = 0; i < els.length; i++) {
        if (bg) els[i].style.background = bg;
        els[i].style.borderColor = pair[1];
      }
    });
  }

  // Paint-only refresh across whichever of the four layers are on the map,
  // plus the in-panel swatches. No re-analysis — a palette change is instant.
  function repaintOverlay() {
    var map = App.map;
    if (!map) return;
    var c = tviColors();
    var byLayer = [
      ["tvi-impacted-fill", "fill-color", c[0]],
      ["tvi-impacted-outline", "line-color", c[0]],
      ["tvi-gain-fill", "fill-color", c[1]],
      ["tvi-gain-outline", "line-color", c[1]]
    ];
    byLayer.forEach(function (L) {
      if (map.getLayer(L[0])) map.setPaintProperty(L[0], L[1], L[2]);
    });
    fillSwatchColors();
  }

  if (typeof App.registerLayerRepainter === "function") {
    App.registerLayerRepainter("title-vi", repaintOverlay);
  }

  function renderImpactedArea(geometry) {
    clearOverlay();
    var map = App.map;
    if (!map || !geometry) return;
    var geojson = geometry.type === "FeatureCollection" ? geometry
      : geometry.type === "Feature" ? { type: "FeatureCollection", features: [geometry] }
      : { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: geometry }] };

    var c = tviColors();
    map.addSource("tvi-impacted", { type: "geojson", data: geojson });
    map.addLayer({
      id: "tvi-impacted-fill",
      type: "fill",
      source: "tvi-impacted",
      paint: { "fill-color": c[0], "fill-opacity": 0.15 }
    });
    map.addLayer({
      id: "tvi-impacted-outline",
      type: "line",
      source: "tvi-impacted",
      paint: { "line-color": c[0], "line-width": 2, "line-opacity": 0.6 }
    });

    // Also render service gain areas (green) from alterations
    renderServiceGainOverlay();
  }

  function renderServiceGainOverlay() {
    var map = App.map;
    if (!map) return;
    // Clean up previous gain layer
    if (map.getLayer("tvi-gain-fill")) map.removeLayer("tvi-gain-fill");
    if (map.getLayer("tvi-gain-outline")) map.removeLayer("tvi-gain-outline");
    if (map.getSource("tvi-gain")) map.removeSource("tvi-gain");

    var scenario = getActiveScenario();
    if (!scenario) return;
    var gainAreas = [];
    for (var i = 0; i < scenario.alterations.length; i++) {
      var c = scenario.alterations[i].computed;
      if (c && c.serviceGainArea) gainAreas.push(c.serviceGainArea);
    }
    if (gainAreas.length === 0) return;

    var gainUnion = gainAreas[0];
    for (var g = 1; g < gainAreas.length; g++) {
      try { gainUnion = turf.union(gainUnion, gainAreas[g]); } catch (e) { /* skip */ }
    }

    var gainGeojson = gainUnion.type === "Feature"
      ? { type: "FeatureCollection", features: [gainUnion] }
      : { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: gainUnion }] };

    var gc = tviColors();
    map.addSource("tvi-gain", { type: "geojson", data: gainGeojson });
    map.addLayer({
      id: "tvi-gain-fill",
      type: "fill",
      source: "tvi-gain",
      paint: { "fill-color": gc[1], "fill-opacity": 0.15 }
    });
    map.addLayer({
      id: "tvi-gain-outline",
      type: "line",
      source: "tvi-gain",
      paint: { "line-color": gc[1], "line-width": 2, "line-opacity": 0.6 }
    });
    fillSwatchColors();
  }

  function clearOverlay() {
    var map = App.map;
    if (!map) return;
    if (map.getLayer("tvi-impacted-fill")) map.removeLayer("tvi-impacted-fill");
    if (map.getLayer("tvi-impacted-outline")) map.removeLayer("tvi-impacted-outline");
    if (map.getSource("tvi-impacted")) map.removeSource("tvi-impacted");
    if (map.getLayer("tvi-gain-fill")) map.removeLayer("tvi-gain-fill");
    if (map.getLayer("tvi-gain-outline")) map.removeLayer("tvi-gain-outline");
    if (map.getSource("tvi-gain")) map.removeSource("tvi-gain");
  }

  // ---- Scenario management ----

  function populateScenarioDropdown() {
    var sel = document.getElementById("tviScenarioSelect");
    if (!sel) return;
    sel.innerHTML = "";
    for (var i = 0; i < _scenarios.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = _scenarios[i].name;
      if (i === _activeScenarioIdx) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function switchScenario(idx) {
    _activeScenarioIdx = idx;
    var scenario = _scenarios[idx];
    if (!scenario) return;

    // Render alteration cards for this scenario
    renderAlterationCards();

    // Set impact method radio
    var radios = document.querySelectorAll('input[name="tviImpactMethod"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = radios[i].value === (scenario.impactMethod || "service_loss_area");
    }

    // Display results if available
    var result = _results[scenario.id];
    if (result) {
      displayResults(result);
    } else {
      // Clear results display
      var emptyEl = document.getElementById("tviResultsEmpty");
      var wrapEl = document.getElementById("tviResultsWrap");
      if (emptyEl) emptyEl.style.display = "block";
      if (wrapEl) wrapEl.style.display = "none";
    }
  }

  function duplicateScenario() {
    var source = _scenarios[_activeScenarioIdx];
    var newScenario = TV.createScenario(source.name + " (copy)");
    newScenario.type = source.type;
    // Deep-copy alterations, stripping computed geometry (will be recomputed)
    newScenario.alterations = JSON.parse(JSON.stringify(source.alterations || []));
    for (var a = 0; a < newScenario.alterations.length; a++) {
      newScenario.alterations[a].computed = null;
    }
    newScenario.impactMethod = source.impactMethod;
    newScenario.notes = source.notes;
    _scenarios.push(newScenario);
    _activeScenarioIdx = _scenarios.length - 1;
    populateScenarioDropdown();
    switchScenario(_activeScenarioIdx);
    saveState();
  }

  function renameScenario() {
    var scenario = _scenarios[_activeScenarioIdx];
    var newName = prompt("Enter new scenario name:", scenario.name);
    if (newName && newName.trim()) {
      scenario.name = newName.trim();
      populateScenarioDropdown();
      saveState();
    }
  }

  function deleteScenario() {
    if (_scenarios.length <= 1) return;
    var scenario = _scenarios[_activeScenarioIdx];
    if (!confirm("Delete scenario \"" + scenario.name + "\"?")) return;
    delete _results[scenario.id];
    delete _cachedDemographics[scenario.id];
    delete _cachedImpactedGeom[scenario.id];
    _scenarios.splice(_activeScenarioIdx, 1);
    _activeScenarioIdx = Math.min(_activeScenarioIdx, _scenarios.length - 1);
    populateScenarioDropdown();
    switchScenario(_activeScenarioIdx);
    updateComparisonTable();
    saveState();
  }

  // ---- Comparison table ----

  function updateComparisonTable() {
    var analyzedResults = [];
    for (var i = 0; i < _scenarios.length; i++) {
      var r = _results[_scenarios[i].id];
      if (r) analyzedResults.push(r);
    }

    var emptyEl = document.getElementById("tviCompEmpty");
    var tableEl = document.getElementById("tviComparisonTable");
    if (analyzedResults.length === 0) {
      if (emptyEl) emptyEl.style.display = "block";
      if (tableEl) tableEl.style.display = "none";
      var expBtn = document.getElementById("tviExportCompCSV");
      if (expBtn) expBtn.disabled = true;
      var sesBtn = document.getElementById("tviExportSessionJSON");
      if (sesBtn) sesBtn.disabled = true;
      return;
    }

    if (emptyEl) emptyEl.style.display = "none";
    if (tableEl) tableEl.style.display = "table";

    var comparison = TV.compareScenarios(analyzedResults);

    // Build header
    var thead = document.getElementById("tviCompThead");
    if (thead) {
      var headerRow = "<tr><th></th>";
      for (var h = 0; h < comparison.length; h++) {
        headerRow += "<th>" + comparison[h].scenarioName + "</th>";
      }
      headerRow += "</tr>";
      thead.innerHTML = headerRow;
    }

    // Build body
    var tbody = document.getElementById("tviCompTbody");
    if (tbody) {
      var rows = [
        { label: "Major Change", key: "majorChangeTriggered", format: function (v) { return v ? '<span class="pill high" style="font-size:11px;">Yes</span>' : '<span class="pill mh" style="font-size:11px;">No</span>'; } },
        { label: "Routes Affected", key: "routesAffected", format: String },
        { label: "Impacted Pop.", key: "totalPop", format: function (v) { return v.toLocaleString(); } },
        { label: "Minority Share", key: "minorityShare", format: function (v) { return (v * 100).toFixed(1) + "%"; } },
        { label: "Low-Income Share", key: "lowIncomeShare", format: function (v) { return (v * 100).toFixed(1) + "%"; } },
        { label: "DI Finding", key: "minorityFinding", format: function (v, item) { return '<span class="pill ' + (item.minorityExceeds ? "high" : "mh") + '" style="font-size:11px;">' + v + '</span>'; } },
        { label: "DB Finding", key: "lowIncomeFinding", format: function (v, item) { return '<span class="pill ' + (item.lowIncomeExceeds ? "high" : "mh") + '" style="font-size:11px;">' + v + '</span>'; } },
        { label: "Minority Diff (ppt)", key: "minorityDiffPpt", format: function (v) { return (v >= 0 ? "+" : "") + v.toFixed(1); } },
        { label: "Low-Income Diff (ppt)", key: "lowIncomeDiffPpt", format: function (v) { return (v >= 0 ? "+" : "") + v.toFixed(1); } }
      ];

      tbody.innerHTML = "";
      for (var r = 0; r < rows.length; r++) {
        var tr = document.createElement("tr");
        tr.innerHTML = '<td class="tiny" style="font-weight:600;">' + rows[r].label + '</td>';
        for (var c = 0; c < comparison.length; c++) {
          var td = document.createElement("td");
          td.className = "tiny";
          td.style.textAlign = "center";
          td.innerHTML = rows[r].format(comparison[c][rows[r].key], comparison[c]);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    var expBtn = document.getElementById("tviExportCompCSV");
    if (expBtn) expBtn.disabled = false;
    var sesBtn = document.getElementById("tviExportSessionJSON");
    if (sesBtn) sesBtn.disabled = false;
  }

  // ---- Exports ----

  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function dateStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function exportMSCResultsCSV() {
    readPolicyFromDOM();
    var scenario = getActiveScenario();
    if (!scenario) return;
    var mc = _policy.majorChange || {};
    var milesCfg      = mc.routeMilesPct     || {};
    var revhrsCfg     = mc.revenueHoursPct   || {};
    var spanCfg       = mc.spanHoursPct      || {};
    var elimCfg       = mc.routeElimination  || {};
    var elimMilesCfg  = mc.eliminatedMilesPct || {};
    var fareCfg       = mc.fareChangePct     || {};

    function mscVal(enabled, value, threshold) {
      if (!enabled) return "";
      if (!Number.isFinite(value)) return "";
      return Math.abs(value) >= threshold ? "Y" : "N";
    }
    function mscBool(enabled, triggered) {
      if (!enabled) return "";
      return triggered ? "Y" : "N";
    }

    var lines = [];
    lines.push([
      "adjustment_name", "change_type",
      "route_miles_change_pct", "route_miles_msc",
      "rev_hours_before", "rev_hours_after", "rev_hours_change_pct", "rev_hours_msc",
      "span_before", "span_after", "span_change_pct", "span_msc",
      "eliminated", "elimination_msc",
      "eliminated_miles_pct", "eliminated_miles_msc",
      "fare_before", "fare_after", "fare_change_pct", "fare_msc",
      "overall_msc"
    ].join(","));

    var alts = scenario.alterations || [];
    for (var i = 0; i < alts.length; i++) {
      var alt = alts[i];
      var c = alt.computed || {};
      var man = alt.manual || {};
      var rh = man.revenueHours || {};
      var sh = man.spanHours || {};
      var fa = man.fare || {};
      var isElim = alt.changeType === "elimination";

      var overallMsc = (
        mscVal(milesCfg.enabled, c.routeMilesPct, milesCfg.threshold) === "Y" ||
        mscVal(revhrsCfg.enabled, c.revenueHoursPct, revhrsCfg.threshold) === "Y" ||
        mscVal(spanCfg.enabled, c.spanHoursPct, spanCfg.threshold) === "Y" ||
        mscBool(elimCfg.enabled, isElim) === "Y" ||
        mscVal(elimMilesCfg.enabled, c.alteredPct, elimMilesCfg.threshold) === "Y" ||
        mscVal(fareCfg.enabled, c.farePct, fareCfg.threshold) === "Y"
      ) ? "Y" : "N";

      var row = [
        csvEscape(alt.name || ""),
        csvEscape(alt.changeType || ""),
        numOrEmpty(c.routeMilesPct),
        mscVal(milesCfg.enabled, c.routeMilesPct, milesCfg.threshold),
        numOrEmpty(rh.before), numOrEmpty(rh.after),
        numOrEmpty(c.revenueHoursPct),
        mscVal(revhrsCfg.enabled, c.revenueHoursPct, revhrsCfg.threshold),
        numOrEmpty(sh.before), numOrEmpty(sh.after),
        numOrEmpty(c.spanHoursPct),
        mscVal(spanCfg.enabled, c.spanHoursPct, spanCfg.threshold),
        isElim ? "Y" : "N",
        mscBool(elimCfg.enabled, isElim),
        numOrEmpty(c.alteredPct),
        mscVal(elimMilesCfg.enabled, c.alteredPct, elimMilesCfg.threshold),
        numOrEmpty(fa.before), numOrEmpty(fa.after),
        numOrEmpty(c.farePct),
        mscVal(fareCfg.enabled, c.farePct, fareCfg.threshold),
        overallMsc
      ];
      lines.push(row.join(","));
    }

    downloadFile(lines.join("\n"), "title-vi-msc-results-" + dateStamp() + ".csv", "text/csv");
  }

  function exportFindingsCSV() {
    var lines = [];
    lines.push("scenario_name,alteration_name,change_type,major_change_triggered," +
      "before_miles,after_miles,pct_change_miles,altered_pct,altered_miles," +
      "before_rev_hours,after_rev_hours,pct_change_rev_hours," +
      "impacted_total_pop,impacted_minority_share,impacted_lowincome_share," +
      "baseline_minority_share,baseline_lowincome_share," +
      "di_diff_ppt,di_threshold,di_finding," +
      "db_diff_ppt,db_threshold,db_finding,policy_name");

    for (var s = 0; s < _scenarios.length; s++) {
      var sc = _scenarios[s];
      var result = _results[sc.id];
      if (!result) continue;

      var alts = sc.alterations || [{ name: "(system)", changeType: "" }];
      for (var r = 0; r < alts.length; r++) {
        var alt = alts[r];
        var c = alt.computed || {};
        var man = alt.manual || {};
        var f = result.findings || {};
        var fm = f.minority || {};
        var fl = f.lowIncome || {};
        var d = result.demographics || {};
        var row = [
          csvEscape(sc.name),
          csvEscape(alt.name || ""),
          csvEscape(alt.changeType || ""),
          result.majorChangeResult.triggered ? "Yes" : "No",
          numOrEmpty(c.beforeMiles), numOrEmpty(c.afterMiles), numOrEmpty(c.routeMilesPct),
          numOrEmpty(c.alteredPct), numOrEmpty(c.alteredMiles),
          numOrEmpty(man.revenueHours && man.revenueHours.before),
          numOrEmpty(man.revenueHours && man.revenueHours.after),
          numOrEmpty(c.revenueHoursPct),
          d.totalPop || "", pctOrEmpty(d.minorityShare), pctOrEmpty(d.lowIncomeShare),
          pctOrEmpty(_baseline ? _baseline.minorityShare : null),
          pctOrEmpty(_baseline ? _baseline.lowIncomeShare : null),
          numOrEmpty(fm.diffPpt), numOrEmpty(fm.thresholdPpt), csvEscape(fm.finding || ""),
          numOrEmpty(fl.diffPpt), numOrEmpty(fl.thresholdPpt), csvEscape(fl.finding || ""),
          csvEscape(_policy.name)
        ];
        lines.push(row.join(","));
      }
    }

    downloadFile(lines.join("\n"), "title-vi-findings-" + dateStamp() + ".csv", "text/csv");
  }

  function csvEscape(s) {
    if (!s) return "";
    s = String(s);
    if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function numOrEmpty(v) {
    return Number.isFinite(v) ? v.toFixed(2) : "";
  }

  function pctOrEmpty(v) {
    return Number.isFinite(v) ? (v * 100).toFixed(2) + "%" : "";
  }

  function exportImpactedGeoJSON() {
    var scenario = _scenarios[_activeScenarioIdx];
    var result = _results[scenario.id];
    if (!result || !result.impactedAreaGeometry) return;

    var geom = result.impactedAreaGeometry;
    var feature = geom.type === "Feature" ? geom : { type: "Feature", properties: {}, geometry: geom };
    feature.properties = {
      scenario: scenario.name,
      impactMethod: scenario.impactMethod,
      totalPop: result.demographics.totalPop,
      minorityShare: (result.demographics.minorityShare * 100).toFixed(1) + "%",
      lowIncomeShare: (result.demographics.lowIncomeShare * 100).toFixed(1) + "%",
      diFinding: result.findings.minority.finding,
      dbFinding: result.findings.lowIncome.finding,
      generatedAt: new Date().toISOString()
    };

    var fc = { type: "FeatureCollection", features: [feature] };
    downloadFile(JSON.stringify(fc, null, 2), "title-vi-impacted-area-" + dateStamp() + ".geojson", "application/geo+json");
  }

  function exportSessionJSON() {
    var state = collectState("full");
    downloadFile(JSON.stringify(state, null, 2), "title-vi-session-" + dateStamp() + ".json", "application/json");
  }

  function exportComparisonCSV() {
    var analyzedResults = [];
    for (var i = 0; i < _scenarios.length; i++) {
      var r = _results[_scenarios[i].id];
      if (r) analyzedResults.push(r);
    }
    if (analyzedResults.length === 0) return;

    var comparison = TV.compareScenarios(analyzedResults);
    var lines = [];
    lines.push("metric," + comparison.map(function (c) { return csvEscape(c.scenarioName); }).join(","));

    var metrics = [
      { label: "Major Change", key: "majorChangeTriggered", fmt: function (v) { return v ? "Yes" : "No"; } },
      { label: "Routes Affected", key: "routesAffected", fmt: String },
      { label: "Impacted Population", key: "totalPop", fmt: String },
      { label: "Minority Share", key: "minorityShare", fmt: function (v) { return (v * 100).toFixed(1) + "%"; } },
      { label: "Low-Income Share", key: "lowIncomeShare", fmt: function (v) { return (v * 100).toFixed(1) + "%"; } },
      { label: "DI Finding", key: "minorityFinding", fmt: String },
      { label: "DB Finding", key: "lowIncomeFinding", fmt: String },
      { label: "Minority Diff (ppt)", key: "minorityDiffPpt", fmt: function (v) { return v.toFixed(1); } },
      { label: "Low-Income Diff (ppt)", key: "lowIncomeDiffPpt", fmt: function (v) { return v.toFixed(1); } }
    ];

    for (var m = 0; m < metrics.length; m++) {
      var row = csvEscape(metrics[m].label);
      for (var c = 0; c < comparison.length; c++) {
        row += "," + csvEscape(metrics[m].fmt(comparison[c][metrics[m].key]));
      }
      lines.push(row);
    }

    downloadFile(lines.join("\n"), "title-vi-comparison-" + dateStamp() + ".csv", "text/csv");
  }

  // ---- Session import ----

  function importSessionJSON(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);
        applyState(data);
        if (isPopupVisible()) {
          writePolicyToDOM();
          populateScenarioDropdown();
          switchScenario(_activeScenarioIdx);
          displayBaseline();
          updateComparisonTable();
        }
      } catch (err) {
        alert("Failed to import session: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---- Session persistence ----

  function collectState(mode) {
    readPolicyFromDOM();

    // Deep-copy scenarios, stripping computed geometry in light mode
    var scenariosCopy = JSON.parse(JSON.stringify(_scenarios));
    if (mode === "light") {
      for (var si = 0; si < scenariosCopy.length; si++) {
        var alts = scenariosCopy[si].alterations || [];
        for (var ai = 0; ai < alts.length; ai++) {
          if (alts[ai].computed) {
            delete alts[ai].computed.serviceLossArea;
            delete alts[ai].computed.serviceGainArea;
          }
        }
      }
    }

    var state = {
      version: 2,
      policy: JSON.parse(JSON.stringify(_policy)),
      scenarios: scenariosCopy,
      activeScenarioIdx: _activeScenarioIdx,
      baseline: _baseline ? JSON.parse(JSON.stringify(_baseline)) : null,
      stale: _stale,
      activeTab: _activeTab
    };

    // Store results (without geos in light mode)
    var results = {};
    Object.keys(_results).forEach(function (key) {
      var r = JSON.parse(JSON.stringify(_results[key]));
      if (mode === "light") {
        delete r.impactedAreaGeometry;
        if (r.demographics) delete r.demographics.geos;
      }
      results[key] = r;
    });
    state.results = results;
    return state;
  }

  function applyState(data) {
    if (!data || (data.version !== 1 && data.version !== 2)) return;
    if (data.policy) _policy = data.policy;
    if (data.scenarios) {
      _scenarios = data.scenarios;
      // v1 migration: convert affectedRoutes → alterations
      for (var i = 0; i < _scenarios.length; i++) {
        if (!_scenarios[i].alterations) _scenarios[i].alterations = [];
        if (_scenarios[i].impactMethod === "selected_routes") _scenarios[i].impactMethod = "full_route_buffer";
      }
    }
    if (typeof data.activeScenarioIdx === "number") _activeScenarioIdx = data.activeScenarioIdx;
    if (data.baseline) _baseline = data.baseline;
    if (data.results) _results = data.results;
    if (typeof data.stale === "boolean") _stale = data.stale;
    if (data.activeTab) _activeTab = data.activeTab;
  }

  function saveState() {
    if (App.cache && App.cache.save) App.cache.save();
  }

  // ---- Module lifecycle ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;
    _core = core;   // captured for the stale-banner Re-run button

    // Tab switching
    var tabs = document.querySelectorAll(".tvi-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        readPolicyFromDOM();
        switchTab(this.getAttribute("data-tab"));
      });
    }

    // Add alteration button
    var addAltBtn = document.getElementById("tviAddAlteration");
    if (addAltBtn) addAltBtn.addEventListener("click", addAlteration);

    // MSC export button
    var mscExpBtn = document.getElementById("tviExportMSCBtn");
    if (mscExpBtn) mscExpBtn.addEventListener("click", exportMSCResultsCSV);

    // Impact method radios (mark stale on change)
    var radios = document.querySelectorAll('input[name="tviImpactMethod"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener("change", function () { markStale(); });
    }
    wireFeatureSelectLinks("tviBaselineSelectAll", "tviBaselineSelectNone", "tviBaselineFeatureList");

    // Baseline button
    var baselineBtn = document.getElementById("tviComputeBaseline");
    if (baselineBtn) baselineBtn.addEventListener("click", function () { runBaseline(core); });

    // Shared census-cache status line + Re-fetch (policy geo/year)
    if (baselineBtn && typeof App.buildCensusCacheStatus === "function") {
      var ccStatus = App.buildCensusCacheStatus({
        geoSel: document.getElementById("tviGeoLevel"),
        yearSel: document.getElementById("tviYearSelect"),
        onRefetch: function () { baselineBtn.click(); }
      });
      baselineBtn.parentNode.insertBefore(ccStatus, baselineBtn);
    }

    // Analysis button
    var analysisBtn = document.getElementById("tviRunAnalysis");
    if (analysisBtn) analysisBtn.addEventListener("click", function () { runAnalysis(core); });

    // Threshold change -> instant re-evaluation
    var thresholdInputs = ["tviDiThreshold", "tviDbThreshold",
      "tviThreshRouteMiles", "tviThreshRevHours", "tviThreshSpan", "tviThreshFare"];
    var ruleCheckboxes = ["tviRuleRouteMiles", "tviRuleRevHours", "tviRuleSpan", "tviRuleElimination", "tviRuleFare"];
    thresholdInputs.concat(ruleCheckboxes).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", runInstantReevaluation);
    });

    // Scenario management
    var scenarioSelect = document.getElementById("tviScenarioSelect");
    if (scenarioSelect) scenarioSelect.addEventListener("change", function () {
      switchScenario(parseInt(this.value, 10));
    });

    var dupBtn = document.getElementById("tviDuplicateScenario");
    if (dupBtn) dupBtn.addEventListener("click", duplicateScenario);

    var renBtn = document.getElementById("tviRenameScenario");
    if (renBtn) renBtn.addEventListener("click", renameScenario);

    var delBtn = document.getElementById("tviDeleteScenario");
    if (delBtn) delBtn.addEventListener("click", deleteScenario);

    // Export buttons
    var csvExpBtn = document.getElementById("tviExportCSV");
    if (csvExpBtn) csvExpBtn.addEventListener("click", exportFindingsCSV);

    var geoExpBtn = document.getElementById("tviExportGeoJSON");
    if (geoExpBtn) geoExpBtn.addEventListener("click", exportImpactedGeoJSON);

    var compExpBtn = document.getElementById("tviExportCompCSV");
    if (compExpBtn) compExpBtn.addEventListener("click", exportComparisonCSV);

    var sesExpBtn = document.getElementById("tviExportSessionJSON");
    if (sesExpBtn) sesExpBtn.addEventListener("click", exportSessionJSON);

    // Session import
    var importFile = document.getElementById("tviImportSessionFile");
    if (importFile) importFile.addEventListener("change", function () { importSessionJSON(this.files[0]); });
  }

  function onOpen(core) {
    writePolicyToDOM();
    document.querySelectorAll(".cc-status").forEach(function (s) { if (s.refresh) s.refresh(); });
    switchTab(_activeTab);
    populateScenarioDropdown();

    // Populate feature checklists
    populateFeatureList("tviBaselineFeatureList", _baselineFeatureFilter);

    // Restore scenario display
    var scenario = _scenarios[_activeScenarioIdx];
    renderAlterationCards();

    // Set impact method radio
    if (scenario) {
      var radios = document.querySelectorAll('input[name="tviImpactMethod"]');
      for (var i = 0; i < radios.length; i++) {
        radios[i].checked = radios[i].value === (scenario.impactMethod || "service_loss_area");
      }
    }

    // Restore results display
    if (scenario && _results[scenario.id]) {
      displayResults(_results[scenario.id]);
    }

    // Restore baseline display
    displayBaseline();

    // Update comparison table
    updateComparisonTable();

    // Show stale warning if needed
    if (_stale) markStale();
  }

  function onClose() {
    readPolicyFromDOM();
  }

  async function update(core) {
    // Features changed — mark stale
    if (Object.keys(_results).length > 0) {
      markStale();
    }

    if (!isPopupVisible()) return;

    // Refresh feature checklists and alteration cards (feature list may have changed)
    populateFeatureList("tviBaselineFeatureList", _baselineFeatureFilter);
    renderAlterationCards();
  }

  // ---- Register with App.cache ----

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("title-vi", {
      collect: function (mode) { return collectState(mode); },
      apply: function (data) { applyState(data); }
    });
  }

  // ---- Module registration ----

  App.registerModule({
    id: "title-vi",
    name: "Title VI Service Equity",
    enabled: true,
    popupWidth: 1000,
    popupHTML: "projects/title-vi-popup.html",
    init: function (core) { init(core); },
    onOpen: function (core) { onOpen(core); },
    onClose: function () { onClose(); },
    update: async function (core) { await update(core); }
  });

})();
