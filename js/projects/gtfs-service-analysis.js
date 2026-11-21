// js/projects/gtfs-service-analysis.js
// GTFS Service Analysis: service hours, peak vehicles and cost per route from the loaded GTFS timetable,
// and a stop analysis (spacing, consolidation candidates, service per stop, wheelchair data).
// All figures come from window.GtfsSchedule; this file only gathers inputs, displays results and owns
// the module's map layers. Detail: docs/reference/modules/gtfs-service-analysis.md

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var MODULE_ID = "gtfs-service-analysis";

  // Route Costing's defaults, so the two tools agree until someone changes one of them.
  var DEFAULT_SERVICE = {
    rate: 150, rateBasis: "revenue", deadheadPct: 15,
    layoverMode: "minutes", layoverValue: 10, maxBlockGapMin: 60,
    daysWeekday: 255, daysSaturday: 52, daysSunday: 58
  };
  var DEFAULT_STOPS = { thresholdsFt: [600, 750, 1320, 2640], secondsPerStop: 20 };
  var DAY_TYPES = ["weekday", "saturday", "sunday"];

  // ---- Module-local state ----
  var _service = Object.assign({}, DEFAULT_SERVICE);
  var _stopsCfg = { thresholdsFt: DEFAULT_STOPS.thresholdsFt.slice(), secondsPerStop: DEFAULT_STOPS.secondsPerStop };
  var _includeHidden = false;
  var _useStopList = false;
  var _rateOverrides = {};          // route_id -> $/hr (only values that pass sanitizeRate are kept)
  var _activeTab = "service";       // "service" | "stops" | "health"
  var _serviceResult = null;        // { feed, sig, inputs, year, calendar, dates }
  var _stopsResult = null;          // { feed, sig, inputs, spacing, candidates, service, wheelchair, date }
  var _healthResult = null;         // { feed, checks, today, ms }
  var _serviceStale = false, _stopsStale = false;
  var _ui = {};                     // sort, search, expanded rows and open sections, kept across re-renders
  var _initialized = false;
  var _mapLayers = { ramp: false, candidates: false };

  function S() { return window.GtfsSchedule; }
  function feed() { return typeof App.gtfsSchedule === "function" ? App.gtfsSchedule() : null; }
  function byId(id) { return document.getElementById(id); }

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === MODULE_ID;
  }

  // Same rule as Route Costing: a usable override is a finite number above zero.
  function sanitizeRate(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) && n > 0 ? n : null;
  }

  function num(v, fallback, min) {
    var n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n) || (min != null && n < min)) return fallback;
    return n;
  }

  // ---- Inputs ----

  function analysisDate() {
    return App.gtfsAnalysisDate && typeof App.gtfsAnalysisDate.get === "function" ? App.gtfsAnalysisDate.get() : null;
  }
  function scopeRouteIds() {
    return typeof App.gtfsScopeRouteIds === "function" ? App.gtfsScopeRouteIds(_includeHidden) : null;
  }
  function stopListIds() {
    if (!_useStopList || !App.gtfsStops || typeof App.gtfsStops.ids !== "function") return null;
    return App.gtfsStops.ids();
  }
  function dayParts() {
    return App.gtfsDayParts && typeof App.gtfsDayParts.get === "function" ? App.gtfsDayParts.get() : null;
  }

  function serviceInputs() {
    return {
      dates: typeof App.gtfsRepresentativeDates === "function" ? App.gtfsRepresentativeDates() : {},
      dayCounts: { weekday: _service.daysWeekday, saturday: _service.daysSaturday, sunday: _service.daysSunday },
      routeIds: scopeRouteIds(),
      layover: { mode: _service.layoverMode, value: _service.layoverValue, maxBlockGapMin: _service.maxBlockGapMin },
      deadheadPct: _service.deadheadPct,
      rate: _service.rate, rateBasis: _service.rateBasis,
      rateOverrides: Object.assign({}, _rateOverrides)
    };
  }

  function stopsInputs() {
    return {
      date: analysisDate(),
      routeIds: scopeRouteIds(),
      stopIds: stopListIds(),
      dayParts: dayParts(),
      thresholdsFt: _stopsCfg.thresholdsFt.slice(),
      secondsPerStop: _stopsCfg.secondsPerStop
    };
  }

  // Results are stale when any input differs from the run's, or the feed object changed.
  function serviceSig() { return JSON.stringify(serviceInputs()); }
  function stopsSig() { return JSON.stringify(stopsInputs()); }

  function checkStale() {
    var f = feed();
    if ((_serviceResult && _serviceResult.feed !== f) || (_stopsResult && _stopsResult.feed !== f) ||
        (_healthResult && _healthResult.feed !== f)) {
      // Feed removed or replaced: stop ids and routes in the old results may not exist in the new feed.
      _serviceResult = _stopsResult = _healthResult = null;
      clearMapLayers();
      if (isPopupVisible()) {
        renderServiceResults(byId("gsaServiceResults"), null, _ui);
        renderStopsResults(byId("gsaStopsResults"), null, _ui);
        renderHealthResults(byId("gsaHealthResults"), null);
      }
    }
    _serviceStale = !!_serviceResult && (_serviceResult.feed !== f || _serviceResult.sig !== serviceSig());
    _stopsStale = !!_stopsResult && (_stopsResult.feed !== f || _stopsResult.sig !== stopsSig());
    if (isPopupVisible()) { syncScopeControls(); renderState(); }
  }

  // ---- Settings <-> DOM ----

  function writeSettingsToDOM() {
    var s = _service;
    var set = function (id, v) { var el = byId(id); if (el) el.value = v; };
    set("gsaRate", s.rate);
    set("gsaRateBasis", s.rateBasis);
    set("gsaDeadhead", s.deadheadPct);
    set("gsaLayoverMode", s.layoverMode);
    set("gsaLayoverValue", s.layoverValue);
    set("gsaMaxGap", s.maxBlockGapMin);
    set("gsaDaysWeekday", s.daysWeekday);
    set("gsaDaysSaturday", s.daysSaturday);
    set("gsaDaysSunday", s.daysSunday);
    for (var i = 0; i < 4; i++) set("gsaT" + (i + 1), _stopsCfg.thresholdsFt[i]);
    set("gsaSecPerStop", _stopsCfg.secondsPerStop);
    updateLayoverLabel();
    updateSettingsSummaries();
  }

  function readServiceFromDOM() {
    var v = function (id) { var el = byId(id); return el ? el.value : null; };
    var d = DEFAULT_SERVICE;
    _service = {
      rate: num(v("gsaRate"), d.rate, 0),
      rateBasis: v("gsaRateBasis") === "platform" ? "platform" : "revenue",
      deadheadPct: num(v("gsaDeadhead"), d.deadheadPct, 0),
      layoverMode: v("gsaLayoverMode") === "percent" ? "percent" : "minutes",
      layoverValue: num(v("gsaLayoverValue"), d.layoverValue, 0),
      maxBlockGapMin: num(v("gsaMaxGap"), d.maxBlockGapMin, 1),
      daysWeekday: Math.round(num(v("gsaDaysWeekday"), d.daysWeekday, 0)),
      daysSaturday: Math.round(num(v("gsaDaysSaturday"), d.daysSaturday, 0)),
      daysSunday: Math.round(num(v("gsaDaysSunday"), d.daysSunday, 0))
    };
  }

  // Thresholds must rise strictly; an out-of-order set keeps the previous one.
  function readStopsFromDOM() {
    var t = [], ok = true;
    for (var i = 0; i < 4; i++) {
      var el = byId("gsaT" + (i + 1));
      var n = num(el ? el.value : null, NaN, 1);
      if (!isFinite(n) || (i > 0 && n <= t[i - 1])) ok = false;
      t.push(n);
    }
    if (ok) _stopsCfg.thresholdsFt = t;
    var sp = byId("gsaSecPerStop");
    _stopsCfg.secondsPerStop = num(sp ? sp.value : null, DEFAULT_STOPS.secondsPerStop, 0);
    return ok;
  }

  function updateLayoverLabel() {
    var el = byId("gsaLayoverValueLabel");
    if (el) el.textContent = _service.layoverMode === "percent" ? "Layover (% of running time)" : "Layover (min per round trip)";
  }

  function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

  function updateSettingsSummaries() {
    var a = byId("gsaServiceSettingsSummary");
    if (a) {
      a.textContent = "— " + money(_service.rate) + "/" + (_service.rateBasis === "platform" ? "platform" : "revenue") +
        " hr, " + _service.daysWeekday + " / " + _service.daysSaturday + " / " + _service.daysSunday + " days";
    }
    var b = byId("gsaStopSettingsSummary");
    if (b) b.textContent = "— bands " + _stopsCfg.thresholdsFt.join(" / ") + " ft, " + _stopsCfg.secondsPerStop + " s per stop";
    var days = _service.daysWeekday + _service.daysSaturday + _service.daysSunday;
    ["gsaDaysWeekday", "gsaDaysSaturday", "gsaDaysSunday"].forEach(function (id) {
      var el = byId(id);
      if (el) el.classList.toggle("gsa-invalid", days > 366);
    });
  }

  function onSettingsInput(e) {
    var id = e && e.target ? e.target.id : "";
    if (/^gsaT\d$|^gsaSecPerStop$/.test(id)) {
      var ok = readStopsFromDOM();
      for (var i = 0; i < 4; i++) { var el = byId("gsaT" + (i + 1)); if (el) el.classList.toggle("gsa-invalid", !ok); }
    } else {
      readServiceFromDOM();
      updateLayoverLabel();
    }
    updateSettingsSummaries();
    saveSession();
    refreshCostTab();
    checkStale();
  }

  // An open route Cost tab follows these settings at once.
  function refreshCostTab() { if (typeof App.gtfsRefreshDetails === "function") App.gtfsRefreshDetails(); }

  // ---- Scope controls ----

  function syncScopeControls() {
    var d = analysisDate(), el = byId("gsaDate");
    if (el) {
      el.value = d ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : "";
      el.disabled = !feed();
      var range = feed() && S() ? S().dateRange(feed()) : null;
      if (range) {
        el.min = range.start.slice(0, 4) + "-" + range.start.slice(4, 6) + "-" + range.start.slice(6, 8);
        el.max = range.end.slice(0, 4) + "-" + range.end.slice(4, 6) + "-" + range.end.slice(6, 8);
      }
    }
    var ih = byId("gsaIncludeHidden");
    if (ih) ih.checked = _includeHidden;
    var us = byId("gsaUseStopList");
    if (us) us.checked = _useStopList;
    var cnt = byId("gsaStopListCount");
    if (cnt) {
      var n = App.gtfsStops && typeof App.gtfsStops.ids === "function" ? App.gtfsStops.ids().length : 0;
      cnt.textContent = "(" + n + " selected)";
    }
    var note = byId("gsaScopeNote");
    if (note) {
      var hidden = App.gtfsHiddenState ? App.gtfsHiddenState().routes.length : 0;
      note.textContent = hidden && !_includeHidden ? hidden + " hidden route" + (hidden === 1 ? "" : "s") + " left out" : "";
    }
  }

  // ---- Status, empty hint, stale banner ----

  // Per-tab lookups; a tab id outside this table means "service".
  var TABS = {
    service: { hint: { need: "No service summary yet.", action: "Press Summarize service." },
      result: function () { return _serviceResult; }, stale: function () { return _serviceStale; }, run: function () { runService(); } },
    stops: { hint: { need: "No stop analysis yet.", action: "Press Analyze stops." },
      result: function () { return _stopsResult; }, stale: function () { return _stopsStale; }, run: function () { runStops(); } },
    health: { hint: { need: "No feed check yet.", action: "Press Check feed." },
      result: function () { return _healthResult; }, stale: function () { return false; }, run: function () { runHealth(); } }
  };
  function tabId(id) { return Object.prototype.hasOwnProperty.call(TABS, id) ? id : "service"; }

  function emptyHint() {
    if (!feed()) {
      return { need: "Load a GTFS feed to begin.", action: "Use Add Data → GTFS Feed, then reopen this panel." };
    }
    return TABS[_activeTab].hint;
  }

  function setStatus(msg, kind) {
    if (!isPopupVisible()) return;
    App.renderModuleState({ statusEl: "gsaStatus", status: msg ? { kind: kind || "", message: msg } : null });
  }

  function renderState() {
    if (!isPopupVisible()) return;
    var tab = TABS[_activeTab], res = tab.result(), stale = tab.stale();
    if (!res) {
      App.renderModuleState({ statusEl: "gsaStatus", emptyEl: "gsaEmptyState", empty: true, hint: emptyHint() });
      return;
    }
    var empty = byId("gsaEmptyState");
    if (empty) empty.style.display = "none";
    if (stale) {
      App.renderModuleState({ statusEl: "gsaStatus", stale: true, onRerun: tab.run });
    } else {
      setStatus(null);
    }
  }

  function switchTab(id) {
    _activeTab = tabId(id);
    var tabs = document.querySelectorAll(".gsa-tabs .rf-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("rf-tab-active", tabs[i].getAttribute("data-tab") === _activeTab);
    var panes = document.querySelectorAll(".gsa-body > .rf-tab-content");
    for (var j = 0; j < panes.length; j++) panes[j].classList.toggle("rf-tab-visible", panes[j].getAttribute("data-tab") === _activeTab);
    renderState();
  }

  // ---- Runs ----

  function runService() {
    var f = feed(), G = S();
    if (!f || !G) { renderState(); return; }
    readServiceFromDOM();
    var inputs = serviceInputs();
    var t0 = Date.now();
    try {
      var year = G.serviceYear(f, inputs);
      var cal = G.calendarDayCounts(f, { routeIds: inputs.routeIds });
      _serviceResult = { feed: f, sig: JSON.stringify(inputs), inputs: inputs, year: year, calendar: cal, dates: inputs.dates };
      _serviceStale = false;
    } catch (e) {
      console.error(e);
      setStatus("Service summary failed: " + (e && e.message ? e.message : e), "error");
      return;
    }
    renderServiceResults(byId("gsaServiceResults"), _serviceResult, _ui);
    renderState();
    if (Date.now() - t0 > 1500) console.info("GTFS service summary took " + (Date.now() - t0) + " ms");
  }

  function runStops() {
    var f = feed(), G = S();
    if (!f || !G) { renderState(); return; }
    if (!readStopsFromDOM()) { setStatus("Spacing band limits must rise from left to right.", "error"); return; }
    var inputs = stopsInputs();
    if (!inputs.date) { setStatus("Choose a day to analyze.", "error"); return; }
    if (inputs.stopIds && !inputs.stopIds.length) {
      setStatus("The GTFS stop selection is empty. Select stops first, or untick “Only stops in the GTFS stop selection”.", "error");
      return;
    }
    try {
      var common = { routeIds: inputs.routeIds, stopIds: inputs.stopIds };
      _stopsResult = {
        feed: f, sig: JSON.stringify(inputs), inputs: inputs, date: inputs.date,
        spacing: G.stopSpacingStats(f, inputs.date, Object.assign({ thresholdsFt: inputs.thresholdsFt }, common)),
        candidates: G.consolidationCandidates(f, inputs.date, Object.assign({
          maxFt: inputs.thresholdsFt[0], secondsPerStop: inputs.secondsPerStop }, common)),
        service: G.stopServiceTable(f, inputs.date, Object.assign({ dayParts: inputs.dayParts }, common)),
        wheelchair: G.wheelchairByRoute(f, inputs.date, { routeIds: inputs.routeIds })
      };
      _stopsStale = false;
    } catch (e) {
      console.error(e);
      setStatus("Stop analysis failed: " + (e && e.message ? e.message : e), "error");
      return;
    }
    renderStopsResults(byId("gsaStopsResults"), _stopsResult, _ui);
    renderState();
  }

  function runHealth() {
    var f = feed(), G = S();
    if (!f || !G) { renderState(); return; }
    setStatus("Checking feed…", "running");
    // Deferred so the status paints before the feed-wide scan blocks the page.
    setTimeout(function () {
      if (feed() !== f) { checkStale(); return; }
      var t0 = Date.now(), today = App.gtfsToday(), checks;
      try {
        checks = G.feedHealth(f, { today: today, shapes: App.gtfsShapeCoords(), maxExamples: 20 }).checks;
      } catch (e) {
        console.error(e);
        setStatus("Feed check failed: " + (e && e.message ? e.message : e), "error");
        return;
      }
      _healthResult = { feed: f, checks: checks, today: today, ms: Date.now() - t0 };
      App.gtfsSetHealth(f, checks);
      renderHealthResults(byId("gsaHealthResults"), _healthResult);
      renderState();
    }, 0);
  }

  // ---- Map layers (stop service ramp, consolidation candidates) ----

  var RAMP_SRC = "gsa-stop-service", RAMP_LAYER = "gsa-stop-service-layer";
  var CAND_SRC = "gsa-candidates", CAND_LAYER = "gsa-candidates-layer";
  // Trips per day at a stop. Data encoding, so raw colours are fine.
  var RAMP = [
    { min: 0, color: "#fde0c5", label: "Under 10" },
    { min: 10, color: "#facba6", label: "10–29" },
    { min: 30, color: "#f59e72", label: "30–59" },
    { min: 60, color: "#e0644f", label: "60–119" },
    { min: 120, color: "#b93f53", label: "120–239" },
    { min: 240, color: "#7a1f5c", label: "240 or more" }
  ];

  function rampExpression() {
    var e = ["step", ["get", "trips"], RAMP[0].color];
    for (var i = 1; i < RAMP.length; i++) e.push(RAMP[i].min, RAMP[i].color);
    return e;
  }

  function insertBefore() { return typeof App.firstUserLayer === "function" ? App.firstUserLayer() : undefined; }

  function pointsFC(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.lat !== "number" || typeof it.lon !== "number" || !isFinite(it.lat) || !isFinite(it.lon)) continue;
      out.push({ type: "Feature", properties: it.props, geometry: { type: "Point", coordinates: [it.lon, it.lat] } });
    }
    return { type: "FeatureCollection", features: out };
  }

  function stopLatLon(id) {
    var f = feed(), s = f && f._stops ? f._stops[id] : null;
    return s ? { lat: s.lat, lon: s.lon } : { lat: NaN, lon: NaN };
  }

  function setSource(map, id, data) {
    var src = map.getSource(id);
    if (src) src.setData(data); else map.addSource(id, { type: "geojson", data: data });
  }

  // rows = stopServiceTable rows; null removes the layer.
  function showServiceRamp(rows) {
    var map = App.map;
    if (!map) return;
    if (!rows) { removeLayer(map, RAMP_LAYER, RAMP_SRC); _mapLayers.ramp = false; return; }
    var items = rows.map(function (r) {
      var ll = stopLatLon(r.stopId);
      return { lat: ll.lat, lon: ll.lon, props: { stop_id: r.stopId, trips: r.trips } };
    });
    setSource(map, RAMP_SRC, pointsFC(items));
    if (!map.getLayer(RAMP_LAYER)) {
      map.addLayer({ id: RAMP_LAYER, type: "circle", source: RAMP_SRC, paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 5, 17, 8],
        "circle-color": rampExpression(),
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.6
      } }, insertBefore());
    }
    _mapLayers.ramp = true;
  }

  // ids = stop ids to ring (the stops a consolidation would remove); null removes the layer.
  function showCandidates(ids) {
    var map = App.map;
    if (!map) return;
    if (!ids) { removeLayer(map, CAND_LAYER, CAND_SRC); _mapLayers.candidates = false; return; }
    var items = ids.map(function (id) { var ll = stopLatLon(id); return { lat: ll.lat, lon: ll.lon, props: { stop_id: id } }; });
    setSource(map, CAND_SRC, pointsFC(items));
    if (!map.getLayer(CAND_LAYER)) {
      map.addLayer({ id: CAND_LAYER, type: "circle", source: CAND_SRC, paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 9, 17, 13],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#d62828", "circle-stroke-width": 2.5
      } }, insertBefore());
    }
    _mapLayers.candidates = true;
  }

  function removeLayer(map, layer, src) {
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(src)) map.removeSource(src);
  }

  function clearMapLayers() {
    var map = App.map;
    if (!map) return;
    removeLayer(map, RAMP_LAYER, RAMP_SRC);
    removeLayer(map, CAND_LAYER, CAND_SRC);
    _mapLayers.ramp = _mapLayers.candidates = false;
  }

  // Zoom to one GTFS stop and open its details.
  function focusStop(stopId) {
    var map = App.map, ll = stopLatLon(stopId);
    if (map && isFinite(ll.lat) && isFinite(ll.lon)) map.easeTo({ center: [ll.lon, ll.lat], zoom: Math.max(map.getZoom(), 16) });
    if (typeof App.gtfsOpenDetails === "function") App.gtfsOpenDetails({ kind: "stop", stopId: stopId });
  }

  function focusRoute(routeId) {
    if (typeof App.gtfsZoomTo === "function") App.gtfsZoomTo({ routeId: routeId });
    if (typeof App.gtfsOpenDetails === "function") App.gtfsOpenDetails({ kind: "route", routeId: routeId });
  }

  // ---- Rate overrides (edited in the Service & Cost table) ----

  function setRateOverride(routeId, value) {
    var v = sanitizeRate(value);
    if (v == null) delete _rateOverrides[routeId]; else _rateOverrides[routeId] = v;
    saveSession();
    refreshCostTab();
    checkStale();
  }

  // ---- CSV download ----

  function csvField(v) {
    var s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvText(headerLines, header, rows) {
    var out = headerLines.map(function (l) { return "# " + l; });
    out.push(header.map(csvField).join(","));
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(csvField).join(","));
    return out.join("\n") + "\n";
  }
  function downloadCSV(text, filename) {
    var url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Display name for a route_id from routes.txt.
  function routeName(routeId) {
    var f = feed(), r = f && f._routes ? f._routes[routeId] : null;
    if (!r) return routeId;
    var s = String(r.route_short_name || "").trim(), l = String(r.route_long_name || "").trim();
    return s && l ? s + " — " + l : s || l || routeId;
  }
  function stopName(stopId) {
    var f = feed(), t = f && f.tables ? f.tables["stops.txt"] : null;
    if (!f) return stopId;
    if (!f._gsaStopNames) {
      var m = Object.create(null), rows = (t && t.rows) || [];
      for (var i = 0; i < rows.length; i++) {
        var id = String(rows[i].stop_id || "").trim();
        if (id && !(id in m)) m[id] = String(rows[i].stop_name || "").trim();
      }
      f._gsaStopNames = m;
    }
    return f._gsaStopNames[stopId] || stopId;
  }

  // ---- Renderers (Service & Cost table, Stops sections) ----
  // helpers passed to the renderers: everything they may call on this module.
  var H = {
    routeName: routeName, stopName: stopName, money: money,
    setRateOverride: setRateOverride, rateOverrides: function () { return _rateOverrides; },
    focusStop: focusStop, focusRoute: focusRoute,
    showServiceRamp: showServiceRamp, showCandidates: showCandidates, mapLayers: function () { return _mapLayers; },
    RAMP: RAMP, csvText: csvText, downloadCSV: downloadCSV, DAY_TYPES: DAY_TYPES,
    service: function () { return _service; }, stopsCfg: function () { return _stopsCfg; }
  };

  // ---- Renderer helpers (private) ----

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAY_LABEL = { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday" };
  var LAYOVER_WORDS = {
    block: "from vehicle blocks", setting: "from the layover setting",
    mixed: "blocks where the feed has them, setting elsewhere"
  };
  var PEAK_WORDS = { block: "blocks", sweep: "trip sweep", mixed: "mixed" };
  // Band colours are a data encoding (Target stands out); the bars are plain divs, no library.
  var BAND_COLORS = ["#c0504d", "#e6a04b", "#4c9f70", "#6b8fc7", "#3d5a96"];
  var ROW_CAP = 200;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtN(n, d) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function r2(n) { return n == null || !isFinite(n) ? "" : Math.round(n * 100) / 100; }

  function fmtDate(s) {
    if (!/^\d{8}$/.test(s || "")) return "";
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
    return WEEKDAY_NAMES[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function isoDate(s) { return /^\d{8}$/.test(s || "") ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : ""; }

  // Service-day seconds as HH:MM; times past midnight read 01:10 +1 so a span does not look reversed.
  function fmtHM(sec) {
    if (sec == null || !isFinite(sec)) return "—";
    var m = Math.floor(sec / 60), h = Math.floor(m / 60), days = Math.floor(h / 24);
    var out = ("0" + (h % 24)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2);
    return days > 0 ? out + " +" + days : out;
  }
  function fmtMin(sec) { return sec == null || !isFinite(sec) ? "—" : fmtN(sec / 60, 0) + " min"; }

  function shortRoute(id) {
    var n = H.routeName(id), i = n.indexOf(" — ");
    return i > 0 ? n.slice(0, i) : n;
  }

  function cmpName(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); }

  function note(text, cls) { return el("p", "tiny gsa-note" + (cls ? " " + cls : ""), text); }

  function csvButton(makeText, filename) {
    var b = el("button", "rf-btn-sm gsa-csv", "Download CSV");
    b.type = "button";
    b.addEventListener("click", function () { H.downloadCSV(makeText(), filename); });
    return b;
  }

  // Header row whose cells sort. cols: [{key, label, num, firstDir}]; state: {key, dir}. A click flips the
  // direction of the current key, or switches to a new key in its natural direction (text up, numbers down).
  function sortHead(cols, state, onSort) {
    var thead = el("thead"), tr = el("tr"), ths = [];
    function paint() {
      cols.forEach(function (c, i) {
        if (c.key) ths[i].setAttribute("aria-sort", state.key === c.key ? (state.dir > 0 ? "ascending" : "descending") : "none");
      });
    }
    cols.forEach(function (c) {
      var th = el("th", c.num ? "num" : "");
      th.scope = "col";
      if (c.key) {
        var b = el("button", "gsa-sort", c.label);
        b.type = "button";
        b.setAttribute("data-sort", c.key);
        b.addEventListener("click", function () {
          if (state.key === c.key) state.dir = -state.dir; else { state.key = c.key; state.dir = c.firstDir || -1; }
          paint();
          onSort();
        });
        th.appendChild(b);
      } else {
        th.textContent = c.label;
      }
      ths.push(th);
      tr.appendChild(th);
    });
    paint();
    thead.appendChild(tr);
    return thead;
  }

  function td(text, cls) { return el("td", cls || "", text); }

  // ---- Service & Cost ----

  function serviceTableRows(year) {
    return Object.keys(year.routes).map(function (id) {
      var r = year.routes[id];
      return { id: id, name: H.routeName(id), r: r, trips: r.weekly.trips, rev: r.annual.revenueHrs,
        plat: r.annual.platformHrs, peak: r.peakVehicles, rate: r.rate, cost: r.annual.cost };
    });
  }

  function serviceCSV(result) {
    var yr = result.year, rows = [];
    function dayRow(id, name, t, d, rate, src) {
      return [id, name, DAY_LABEL[t], isoDate(yr.dates[t]), d ? d.trips : 0, d ? r2(d.runningHrs) : 0,
        d ? r2(d.revenueHrs) : 0, d ? r2(d.platformHrs) : 0, d ? fmtHM(d.firstDep) : "", d ? fmtHM(d.lastArr) : "",
        d ? d.peakVehicles : 0, d && d.peakMethod ? d.peakMethod : "", d && d.method ? d.method : "", rate, src, d ? r2(d.cost) : 0];
    }
    function sumRow(id, name, period, s, peak, rate, src) {
      return [id, name, period, "", s.trips, r2(s.runningHrs), r2(s.revenueHrs), r2(s.platformHrs), "", "", peak,
        "", "", rate, src, r2(s.cost)];
    }
    Object.keys(yr.routes).forEach(function (id) {
      var r = yr.routes[id], name = H.routeName(id), src = r.rateIsOverride ? "override" : "default";
      H.DAY_TYPES.forEach(function (t) { rows.push(dayRow(id, name, t, r.perDay[t], r.rate, src)); });
      rows.push(sumRow(id, name, "Weekly", r.weekly, r.peakVehicles, r.rate, src));
      rows.push(sumRow(id, name, "Annual", r.annual, r.peakVehicles, r.rate, src));
    });
    H.DAY_TYPES.forEach(function (t) { rows.push(dayRow("SYSTEM", "System", t, yr.total.perDay[t], "", "")); });
    rows.push(sumRow("SYSTEM", "System", "Weekly", yr.total.weekly, yr.total.peakVehicles, "", ""));
    rows.push(sumRow("SYSTEM", "System", "Annual", yr.total.annual, yr.total.peakVehicles, "", ""));
    var dc = yr.dayCounts;
    var analysis = App.gtfsAnalysisDate && typeof App.gtfsAnalysisDate.get === "function" ? App.gtfsAnalysisDate.get() : null;
    var headers = [
      "Cost basis: rate × " + yr.basis + " hours",
      "Days per year: weekday " + dc.weekday + ", Saturday " + dc.saturday + ", Sunday " + dc.sunday,
      "Analysis date: " + (isoDate(analysis) || ""),
      "Dates used: weekday " + (isoDate(yr.dates.weekday) || "none") + ", Saturday " + (isoDate(yr.dates.saturday) || "none") +
        ", Sunday " + (isoDate(yr.dates.sunday) || "none")
    ];
    return H.csvText(headers, ["Route ID", "Route", "Period", "Date", "Trips", "Running hr", "Revenue hr", "Platform hr",
      "Span start", "Span end", "Peak vehicles", "Peak method", "Layover method", "Rate ($/hr)", "Rate source", "Cost"], rows);
  }

  function serviceHeader(year) {
    var box = el("div", "gsa-basis tiny");
    H.DAY_TYPES.forEach(function (t) {
      var line = el("div");
      line.appendChild(el("strong", "", DAY_LABEL[t] + ": "));
      var d = year.days[t];
      if (!d) { line.appendChild(document.createTextNode("no service")); }
      else {
        line.appendChild(document.createTextNode(fmtDate(d.date) + (d.method ? ", layover " + LAYOVER_WORDS[d.method] : "")));
      }
      box.appendChild(line);
    });
    box.appendChild(el("div", "u-muted", "Cost = rate × " + year.basis + " hours (default " + H.money(year.rate) +
      "/hr; a route's own rate replaces it)."));
    return box;
  }

  function serviceTiles(year) {
    var wrap = el("div", "gsa-tiles");
    [
      [H.money(year.total.annual.cost), "Annual cost"],
      [fmtN(year.total.annual.revenueHrs, 0), "Annual revenue hours"],
      [fmtN(year.total.annual.trips, 0), "Annual trips"],
      [fmtN(year.total.peakVehicles, 0), "Peak vehicles (system peak, not a sum of routes)"]
    ].forEach(function (t) {
      var tile = el("div", "gsa-tile");
      tile.appendChild(el("div", "gsa-tile-val", t[0]));
      tile.appendChild(el("div", "gsa-tile-lbl tiny", t[1]));
      wrap.appendChild(tile);
    });
    return wrap;
  }

  function serviceCrossCheck(result) {
    var cal = result.calendar, dc = result.year.dayCounts;
    if (!cal || cal.start == null) return note("The feed has no calendar dates to compare your day counts with.");
    var p = cal.perYear, b = cal.byType;
    var text = "The feed's own calendar has " + b.weekday + " weekdays, " + b.saturday + " Saturdays, " + b.sunday +
      " Sundays with service between " + fmtDate(cal.start) + " and " + fmtDate(cal.end) + "; scaled to a year: " +
      p.weekday + " / " + p.saturday + " / " + p.sunday + ". This summary uses your day counts: " +
      dc.weekday + " / " + dc.saturday + " / " + dc.sunday + ".";
    var off = Math.abs(p.weekday - dc.weekday) > 0.1 * Math.max(p.weekday, 1);
    var n = note(text, off ? "gsa-note-warn" : "");
    n.setAttribute("data-gsa", "crosscheck");
    return n;
  }

  function serviceHow() {
    var d = el("details", "gsa-how");
    d.appendChild(el("summary", "", "How this is computed"));
    var ul = el("ul", "tiny");
    [
      "Running hours are each trip's first departure to its last arrival, added up for the day; revenue hours add layover, and platform hours add deadhead (a percentage of running hours) on top.",
      "Where the feed has block_id values, layover is the gap until the same vehicle's next trip, up to the longest layover you allow; otherwise the Layover setting is used.",
      "The Layover setting is per round trip, so each one-way trip is charged half of it (or the percentage of its own running time).",
      "Peak vehicles are the most vehicles needed at once on that day type's date, counting each block as one vehicle from its first departure to its last arrival and any other trip from departure to arrival plus layover.",
      "Weekly figures are five weekdays plus one Saturday and one Sunday, and annual figures use the days per year you set in Cost settings.",
      "Cost is the route's rate times its revenue hours (or platform hours, as chosen), and a route's own rate replaces the default.",
      "A route's peak vehicles are counted on its own, so they do not add up to the system peak, where routes can share vehicles and peak at different times."
    ].forEach(function (s) { ul.appendChild(el("li", "", s)); });
    d.appendChild(ul);
    return d;
  }

  function renderServiceResults(host, result, ui) {
    if (!host) return;
    host.textContent = "";
    if (!result) return;
    var st = ui.svc = ui.svc || { sort: { key: "cost", dir: -1 }, search: "", expanded: {} };
    var yr = result.year, rows = serviceTableRows(yr);
    host.appendChild(serviceHeader(yr));
    host.appendChild(serviceTiles(yr));
    if (!rows.length) {
      host.appendChild(note("No route has service on the days used."));
    } else {
      host.appendChild(buildServiceTable(result, rows, st));
    }
    host.appendChild(serviceCrossCheck(result));
    host.appendChild(serviceHow());
  }

  function buildServiceTable(result, rows, st) {
    var yr = result.year, box = el("div", "gsa-svc");
    var controls = el("div", "gsa-controls");
    var search = el("input", "rf-number-input gsa-search");
    search.type = "search";
    search.placeholder = "Search routes";
    search.setAttribute("aria-label", "Search routes by name or id");
    search.value = st.search;
    var count = el("span", "tiny u-muted");
    var csv = csvButton(function () { return serviceCSV(result); },
      "gtfs-service-" + (yr.dates.weekday || yr.dates.saturday || yr.dates.sunday || "feed") + ".csv");
    controls.appendChild(search);
    controls.appendChild(count);
    controls.appendChild(csv);
    box.appendChild(controls);

    var wrap = el("div", "gsa-table-wrap"), tbl = el("table", "gtfs-dt-table gsa-svc-table"), tbody = el("tbody");
    var cols = [
      { key: "name", label: "Route", firstDir: 1 }, { key: "trips", label: "Trips/wk", num: true },
      { key: "rev", label: "Revenue hr/yr", num: true }, { key: "plat", label: "Platform hr/yr", num: true },
      { key: "peak", label: "Peak vehicles", num: true }, { key: "rate", label: "Rate ($/hr)", num: true },
      { key: "cost", label: "Annual cost", num: true }
    ];
    tbl.appendChild(sortHead(cols, st.sort, drawRows));
    tbl.appendChild(tbody);

    var t = yr.total, foot = el("tfoot"), ftr = el("tr", "gsa-total");
    ftr.appendChild(td("Total (all routes)"));
    [fmtN(t.weekly.trips, 0), fmtN(t.annual.revenueHrs, 0), fmtN(t.annual.platformHrs, 0), fmtN(t.peakVehicles, 0), "",
      H.money(t.annual.cost)].forEach(function (v) { ftr.appendChild(td(v, "num")); });
    foot.appendChild(ftr);
    tbl.appendChild(foot);
    wrap.appendChild(tbl);
    box.appendChild(wrap);

    function detailRow(x) {
      var tr = el("tr", "gsa-detail"), cell = td("");
      cell.colSpan = 7;
      var sub = el("table", "gtfs-dt-table gsa-sub-table"), body = el("tbody");
      sub.innerHTML = "<thead><tr><th>Day</th><th class=\"num\">Trips</th><th class=\"num\">Running hr</th>" +
        "<th class=\"num\">Revenue hr</th><th class=\"num\">Platform hr</th><th>Span</th><th class=\"num\">Peak veh.</th>" +
        "<th>Layover</th><th class=\"num\">Daily cost</th></tr></thead>";
      H.DAY_TYPES.forEach(function (day) {
        var d = x.r.perDay[day], r = el("tr", "gsa-subrow");
        r.setAttribute("data-day", day);
        r.appendChild(td(DAY_LABEL[day]));
        if (!d) {
          var none = td("No service on " + (yr.dates[day] ? fmtDate(yr.dates[day]) : "this day type"), "u-muted");
          none.colSpan = 8;
          r.appendChild(none);
        } else {
          r.appendChild(td(fmtN(d.trips, 0), "num"));
          r.appendChild(td(fmtN(d.runningHrs, 1), "num"));
          r.appendChild(td(fmtN(d.revenueHrs, 1), "num"));
          r.appendChild(td(fmtN(d.platformHrs, 1), "num"));
          r.appendChild(td(fmtHM(d.firstDep) + "–" + fmtHM(d.lastArr)));
          r.appendChild(td(fmtN(d.peakVehicles, 0) + (d.peakMethod ? " (" + PEAK_WORDS[d.peakMethod] + ")" : ""), "num"));
          r.appendChild(td(d.method ? LAYOVER_WORDS[d.method] : "—"));
          r.appendChild(td(H.money(d.cost), "num"));
        }
        body.appendChild(r);
      });
      sub.appendChild(body);
      cell.appendChild(sub);
      tr.appendChild(cell);
      return tr;
    }

    function routeRow(x) {
      var tr = el("tr", "gsa-route-row");
      tr.setAttribute("data-route", x.id);
      var c0 = td("", "gsa-route-cell");
      var caret = el("button", "gsa-caret", st.expanded[x.id] ? "▾" : "▸");
      caret.type = "button";
      caret.setAttribute("aria-expanded", st.expanded[x.id] ? "true" : "false");
      caret.setAttribute("aria-label", "Show day types for " + x.name);
      caret.addEventListener("click", function () {
        st.expanded[x.id] = !st.expanded[x.id];
        caret.textContent = st.expanded[x.id] ? "▾" : "▸";
        caret.setAttribute("aria-expanded", st.expanded[x.id] ? "true" : "false");
        var next = tr.nextSibling;
        if (st.expanded[x.id]) tr.parentNode.insertBefore(detailRow(x), next);
        else if (next && next.classList.contains("gsa-detail")) next.parentNode.removeChild(next);
      });
      var link = el("button", "gtfs-dt-link", x.name);
      link.type = "button";
      link.addEventListener("click", function () { H.focusRoute(x.id); });
      c0.appendChild(caret);
      c0.appendChild(link);
      tr.appendChild(c0);
      tr.appendChild(td(fmtN(x.trips, 0), "num"));
      tr.appendChild(td(fmtN(x.rev, 0), "num"));
      tr.appendChild(td(fmtN(x.plat, 0), "num"));
      tr.appendChild(td(fmtN(x.peak, 0), "num"));
      var cr = td("", "num"), input = el("input", "rf-number-input gsa-rate-input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = String(yr.rate);
      input.setAttribute("aria-label", "Rate in dollars per hour for " + x.name);
      var ov = H.rateOverrides()[x.id];
      if (ov != null) { input.value = ov; input.classList.add("gsa-rate-ov"); }
      input.addEventListener("change", function () {
        H.setRateOverride(x.id, input.value);
        var now = H.rateOverrides()[x.id];
        input.value = now == null ? "" : now;
        input.classList.toggle("gsa-rate-ov", now != null);
      });
      cr.appendChild(input);
      tr.appendChild(cr);
      tr.appendChild(td(H.money(x.cost), "num gsa-cost"));
      return tr;
    }

    function drawRows() {
      var q = st.search.trim().toLowerCase();
      var list = rows.filter(function (x) { return !q || x.name.toLowerCase().indexOf(q) >= 0 || x.id.toLowerCase().indexOf(q) >= 0; });
      var k = st.sort.key, dir = st.sort.dir;
      list.sort(function (a, b) {
        var c = k === "name" ? cmpName(a.name, b.name) : a[k] - b[k];
        return c !== 0 ? c * dir : cmpName(a.name, b.name);
      });
      count.textContent = list.length + " of " + rows.length + " routes";
      tbody.textContent = "";
      if (!list.length) {
        var tr = el("tr"), c = td("No routes match.", "u-muted");
        c.colSpan = 7;
        tr.appendChild(c);
        tbody.appendChild(tr);
        return;
      }
      var frag = document.createDocumentFragment();
      list.forEach(function (x) {
        frag.appendChild(routeRow(x));
        if (st.expanded[x.id]) frag.appendChild(detailRow(x));
      });
      tbody.appendChild(frag);
    }
    search.addEventListener("input", function () { st.search = search.value; drawRows(); });
    drawRows();
    return box;
  }

  // ---- Stops ----

  function stopsDateLine(result) {
    return "Analyzed " + fmtDate(result.date) + (result.inputs && result.inputs.stopIds ? ", selected stops only (the wheelchair section covers every stop on the routes)" : "") + ".";
  }

  function section(ui, key, title, summary) {
    var open = ui.stops.open, d = el("details", "gsa-section");
    d.setAttribute("data-section", key);
    d.open = !!open[key];
    var s = el("summary");
    s.appendChild(el("span", "gsa-sec-title", title));
    s.appendChild(el("span", "gsa-sec-sum tiny", summary));
    d.appendChild(s);
    var body = el("div", "gsa-sec-body");
    d.appendChild(body);
    d.addEventListener("toggle", function () { open[key] = d.open; });
    return { root: d, body: body };
  }

  function tableWrap(tbl) {
    var w = el("div", "gsa-table-wrap");
    w.appendChild(tbl);
    return w;
  }

  function bandRange(b, i, n) {
    if (i === 0) return "under " + fmtN(b.maxFt, 0) + " ft";
    if (i === n - 1) return fmtN(b.minFt, 0) + " ft or more";
    return fmtN(b.minFt, 0) + "–" + fmtN(b.maxFt, 0) + " ft";
  }

  function buildSpacing(sec, result, ui) {
    var sp = result.spacing, body = sec.body, f = isoDate(result.date);
    var segs = sp.list;
    body.appendChild(csvButton(function () {
      var rows = segs.map(function (s) {
        return [s.routeId, H.routeName(s.routeId), s.directionId, s.fromStopId, H.stopName(s.fromStopId),
          s.toStopId, H.stopName(s.toStopId), Math.round(s.feet), s.band];
      });
      return H.csvText(["Analysis date: " + f, "Band limits (ft): " + sp.thresholdsFt.join(" / ")],
        ["Route ID", "Route", "Direction", "From stop ID", "From stop", "To stop ID", "To stop", "Feet", "Band"], rows);
    }, "gtfs-spacing-" + result.date + ".csv"));
    if (!sp.segments) {
      body.appendChild(note("No pairs of consecutive stops to measure on this day."));
      return;
    }
    var bars = el("div", "gsa-bands");
    sp.bands.forEach(function (b, i) {
      var row = el("div", "gsa-band-row");
      row.appendChild(el("span", "gsa-band-label tiny", b.label));
      row.appendChild(el("span", "gsa-band-range tiny u-muted", bandRange(b, i, sp.bands.length)));
      var track = el("span", "gsa-bar"), fill = el("span", "gsa-bar-fill");
      fill.style.width = (b.share * 100).toFixed(1) + "%";
      fill.style.background = BAND_COLORS[i];
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "gsa-band-n tiny", fmtN(b.count, 0) + " · " + fmtN(b.share * 100, 0) + "%"));
      bars.appendChild(row);
    });
    body.appendChild(bars);
    var stats = el("div", "gsa-stats tiny");
    [["Median", sp.medianFt], ["Mean", sp.meanFt], ["10th percentile", sp.p10Ft], ["90th percentile", sp.p90Ft]].forEach(function (p) {
      var s = el("span", "", p[0] + " ");
      s.appendChild(el("strong", "", fmtN(p[1], 0) + " ft"));
      stats.appendChild(s);
    });
    body.appendChild(stats);
    body.appendChild(note(fmtN(sp.segments, 0) + " segments on each route's most-used pattern" +
      (sp.skipped ? "; " + sp.skipped + " skipped for missing stop coordinates" : "") + "."));

    var rs = ui.stops.routeSort, tbody = el("tbody"), tbl = el("table", "gtfs-dt-table gsa-route-medians");
    tbl.appendChild(sortHead([{ key: "route", label: "Route", firstDir: 1 }, { key: "segments", label: "Segments", num: true },
      { key: "median", label: "Median spacing", num: true }], rs, draw));
    tbl.appendChild(tbody);
    function draw() {
      var list = sp.routes.slice();
      list.sort(function (a, b) {
        var c = rs.key === "route" ? cmpName(H.routeName(a.routeId), H.routeName(b.routeId))
          : rs.key === "segments" ? a.segments - b.segments : a.medianFt - b.medianFt;
        return c * rs.dir;
      });
      tbody.textContent = "";
      list.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(td(H.routeName(r.routeId)));
        tr.appendChild(td(fmtN(r.segments, 0), "num"));
        tr.appendChild(td(fmtN(r.medianFt, 0) + " ft", "num"));
        tbody.appendChild(tr);
      });
    }
    draw();
    body.appendChild(tableWrap(tbl));
  }

  function buildCandidates(sec, result, ui) {
    var cs = result.candidates, body = sec.body, list = cs.list;
    body.appendChild(csvButton(function () {
      var rows = list.map(function (c) {
        return [c.removeStopId, H.stopName(c.removeStopId), c.keepStopId, H.stopName(c.keepStopId), Math.round(c.feet),
          c.routeIds.join(" "), c.tripsPerDay, r2(c.savedSec / 60), Math.round(c.extraWalkFt)];
      });
      return H.csvText(["Analysis date: " + isoDate(result.date), "Upper bound: assumes every trip stops there.",
        "Seconds saved per removed stop: " + cs.secondsPerStop],
        ["Stop to remove ID", "Stop to remove", "Keep ID", "Keep", "Distance (ft)", "Routes", "Trips/day",
          "Saved vehicle-min/day", "Extra walk up to (ft)"], rows);
    }, "gtfs-consolidation-" + result.date + ".csv"));
    if (!list.length) {
      body.appendChild(note("No stops closer than " + fmtN(cs.maxFt, 0) + " ft qualify for removal."));
    } else {
      body.appendChild(note("Upper bound: assumes every trip stops there.", "gsa-upper"));
    }
    var tog = el("label", "tpi-toggle-row"), cb = el("input");
    cb.type = "checkbox";
    cb.className = "gsa-cand-toggle";
    cb.disabled = !list.length;
    cb.checked = !!list.length && !!H.mapLayers().candidates;
    cb.addEventListener("change", function () {
      H.showCandidates(cb.checked ? list.map(function (c) { return c.removeStopId; }) : null);
    });
    tog.appendChild(cb);
    tog.appendChild(el("span", "tiny", "Show on map"));
    body.appendChild(tog);
    if (!list.length) return;

    var tbl = el("table", "gtfs-dt-table gsa-candidates"), tbody = el("tbody"), all = !!ui.stops.candAll;
    tbl.innerHTML = "<thead><tr><th>Stop to remove</th><th>Keep</th><th class=\"num\">Distance</th><th>Routes</th>" +
      "<th class=\"num\">Trips/day</th><th class=\"num\">Saved vehicle-min/day</th><th class=\"num\">Extra walk (up to)</th></tr></thead>";
    tbl.appendChild(tbody);
    var more = el("button", "rf-btn-sm gsa-show-all");
    more.type = "button";
    function draw() {
      tbody.textContent = "";
      var shown = all ? list : list.slice(0, ROW_CAP);
      shown.forEach(function (c) {
        var tr = el("tr"), c0 = td(""), link = el("button", "gtfs-dt-link", H.stopName(c.removeStopId));
        link.type = "button";
        link.addEventListener("click", function () { H.focusStop(c.removeStopId); });
        c0.appendChild(link);
        tr.appendChild(c0);
        tr.appendChild(td(H.stopName(c.keepStopId)));
        tr.appendChild(td(fmtN(c.feet, 0) + " ft", "num"));
        var rc = td(c.routeIds.map(shortRoute).join(", "));
        rc.title = c.routeIds.map(H.routeName).join("; ");
        tr.appendChild(rc);
        tr.appendChild(td(fmtN(c.tripsPerDay, 0), "num"));
        tr.appendChild(td(fmtN(c.savedSec / 60, 1), "num"));
        tr.appendChild(td(fmtN(c.extraWalkFt, 0) + " ft", "num"));
        tbody.appendChild(tr);
      });
      more.style.display = list.length > ROW_CAP ? "" : "none";
      more.textContent = all ? "Show top " + ROW_CAP : "Show all " + fmtN(list.length, 0);
    }
    more.addEventListener("click", function () { all = ui.stops.candAll = !all; draw(); });
    draw();
    body.appendChild(tableWrap(tbl));
    body.appendChild(more);
  }

  function headwayText(sec) { return sec == null ? "—" : fmtMin(sec); }

  function buildServicePerStop(sec, result, ui) {
    var rows = result.service.slice().sort(function (a, b) {
      return b.trips - a.trips || cmpName(a.stopId, b.stopId);
    });
    var body = sec.body, ss = ui.stops;
    body.appendChild(csvButton(function () {
      var out = rows.map(function (r) {
        return [r.stopId, H.stopName(r.stopId), r.trips, r.routes, fmtHM(r.firstSec), fmtHM(r.lastSec),
          r.peakHeadwaySec == null ? "" : r2(r.peakHeadwaySec / 60), r.offPeakHeadwaySec == null ? "" : r2(r.offPeakHeadwaySec / 60)];
      });
      return H.csvText(["Analysis date: " + isoDate(result.date)],
        ["Stop ID", "Stop", "Trips", "Routes", "First departure", "Last departure", "Peak headway (min)", "Off-peak headway (min)"], out);
    }, "gtfs-stop-service-" + result.date + ".csv"));
    if (!rows.length) {
      body.appendChild(note("No stop has a departure on this day."));
      return;
    }

    var ramp = el("div", "gsa-ramp-row"), tog = el("label", "tpi-toggle-row"), cb = el("input");
    cb.type = "checkbox";
    cb.className = "gsa-ramp-toggle";
    cb.checked = !!H.mapLayers().ramp;
    cb.addEventListener("change", function () { H.showServiceRamp(cb.checked ? result.service : null); });
    tog.appendChild(cb);
    tog.appendChild(el("span", "tiny", "Colour stops by trips per day"));
    ramp.appendChild(tog);
    var legend = el("span", "gsa-legend tiny");
    H.RAMP.forEach(function (r) {
      var item = el("span", "gsa-legend-item"), sw = el("span", "gsa-swatch");
      sw.style.background = r.color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(r.label));
      legend.appendChild(item);
    });
    ramp.appendChild(legend);
    body.appendChild(ramp);

    var controls = el("div", "gsa-controls"), search = el("input", "rf-number-input gsa-search");
    search.type = "search";
    search.placeholder = "Search stops";
    search.setAttribute("aria-label", "Search stops by name or id");
    search.value = ss.svcSearch || "";
    var count = el("span", "tiny u-muted"), more = el("button", "rf-btn-sm gsa-show-all");
    more.type = "button";
    controls.appendChild(search);
    controls.appendChild(count);
    controls.appendChild(more);
    body.appendChild(controls);

    var tbl = el("table", "gtfs-dt-table gsa-stop-service"), tbody = el("tbody");
    tbl.innerHTML = "<thead><tr><th>Stop</th><th class=\"num\">Trips</th><th class=\"num\">Routes</th><th>First</th><th>Last</th>" +
      "<th class=\"num\">Peak headway</th><th class=\"num\">Off-peak headway</th></tr></thead>";
    tbl.appendChild(tbody);
    function draw() {
      var q = (ss.svcSearch || "").trim().toLowerCase();
      var list = !q ? rows : rows.filter(function (r) {
        return r.stopId.toLowerCase().indexOf(q) >= 0 || H.stopName(r.stopId).toLowerCase().indexOf(q) >= 0;
      });
      var shown = ss.svcAll ? list : list.slice(0, ROW_CAP);
      count.textContent = "Showing " + fmtN(shown.length, 0) + " of " + fmtN(list.length, 0) + " stops";
      more.style.display = list.length > ROW_CAP ? "" : "none";
      more.textContent = ss.svcAll ? "Show top " + ROW_CAP : "Show all";
      tbody.textContent = "";
      var frag = document.createDocumentFragment();
      shown.forEach(function (r) {
        var tr = el("tr"), c0 = td(""), link = el("button", "gtfs-dt-link", H.stopName(r.stopId));
        link.type = "button";
        link.addEventListener("click", function () { H.focusStop(r.stopId); });
        c0.appendChild(link);
        c0.appendChild(el("span", "gtfs-dt-id", " " + r.stopId));
        tr.appendChild(c0);
        tr.appendChild(td(fmtN(r.trips, 0), "num"));
        tr.appendChild(td(fmtN(r.routes, 0), "num"));
        tr.appendChild(td(fmtHM(r.firstSec)));
        tr.appendChild(td(fmtHM(r.lastSec)));
        tr.appendChild(td(headwayText(r.peakHeadwaySec), "num"));
        tr.appendChild(td(headwayText(r.offPeakHeadwaySec), "num"));
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
    }
    search.addEventListener("input", function () { ss.svcSearch = search.value; draw(); });
    more.addEventListener("click", function () { ss.svcAll = !ss.svcAll; draw(); });
    draw();
    body.appendChild(tableWrap(tbl));
  }

  function pctKnown(known, total) { return total ? fmtN(known * 100 / total, 0) + "%" : "—"; }

  function buildWheelchair(sec, result) {
    var wc = result.wheelchair, body = sec.body;
    function cells(r) {
      return [r.stops, r.stopsAccessible, r.stopsNotAccessible, r.stopsUnknown,
        r.trips, r.tripsAccessible, r.tripsNotAccessible, r.tripsUnknown];
    }
    function known(r) { return r.stopsAccessible + r.stopsNotAccessible; }
    body.appendChild(csvButton(function () {
      var rows = wc.routes.map(function (r) {
        return [r.routeId, H.routeName(r.routeId)].concat(cells(r), [r.stops ? r2(known(r) * 100 / r.stops) : ""]);
      });
      var t = wc.total;
      rows.push(["ALL", "All routes"].concat(cells(t), [t.stops ? r2(known(t) * 100 / t.stops) : ""]));
      return H.csvText(["Analysis date: " + isoDate(result.date)],
        ["Route ID", "Route", "Stops", "Stops accessible", "Stops not accessible", "Stops unknown", "Trips",
          "Trips accessible", "Trips not accessible", "Trips unknown", "% stops with data"], rows);
    }, "gtfs-wheelchair-" + result.date + ".csv"));
    if (!wc.routes.length) {
      body.appendChild(note("No route has service on this day."));
      return;
    }
    var tbl = el("table", "gtfs-dt-table gsa-wheelchair"), tbody = el("tbody");
    tbl.innerHTML = "<thead><tr><th>Route</th><th class=\"num\">Stops accessible</th><th class=\"num\">Not accessible</th>" +
      "<th class=\"num\">Unknown</th><th class=\"num\">Trips accessible</th><th class=\"num\">Not accessible</th>" +
      "<th class=\"num\">Unknown</th><th class=\"num\">% known (stops)</th></tr></thead>";
    function row(label, r, cls) {
      var tr = el("tr", cls || "");
      tr.appendChild(td(label));
      [r.stopsAccessible, r.stopsNotAccessible, r.stopsUnknown, r.tripsAccessible, r.tripsNotAccessible, r.tripsUnknown]
        .forEach(function (v) { tr.appendChild(td(fmtN(v, 0), "num")); });
      tr.appendChild(td(pctKnown(known(r), r.stops), "num"));
      return tr;
    }
    wc.routes.forEach(function (r) { tbody.appendChild(row(H.routeName(r.routeId), r)); });
    tbody.appendChild(row("All routes", wc.total, "gsa-total"));
    tbl.appendChild(tbody);
    body.appendChild(tableWrap(tbl));
  }

  function renderStopsResults(host, result, ui) {
    if (!host) return;
    host.textContent = "";
    if (!result) return;
    var ss = ui.stops = ui.stops || { open: { spacing: true }, routeSort: { key: "route", dir: 1 } };
    host.appendChild(note(stopsDateLine(result)));

    var sp = result.spacing, cs = result.candidates, wc = result.wheelchair.total;
    var targetPct = sp.segments ? fmtN(sp.bands[2].share * 100, 0) : null;
    var spacing = section(ui, "spacing", "Stop spacing", sp.segments
      ? "Median " + fmtN(sp.medianFt, 0) + " ft · " + targetPct + "% in target band" : "No stop pairs to measure");
    buildSpacing(spacing, result, ui);

    var cand = section(ui, "candidates", "Consolidation candidates", cs.count
      ? fmtN(cs.count, 0) + " candidate" + (cs.count === 1 ? "" : "s") + " · up to " + fmtN(cs.savedSecPerDay / 60, 0) + " vehicle-min/day"
      : "No candidates");
    buildCandidates(cand, result, ui);

    var busiest = null;
    result.service.forEach(function (r) { if (!busiest || r.trips > busiest.trips) busiest = r; });
    var svc = section(ui, "service", "Service per stop", busiest
      ? fmtN(result.service.length, 0) + " stops · busiest: " + H.stopName(busiest.stopId) + " (" + fmtN(busiest.trips, 0) + " trips)"
      : "No stops with service");
    buildServicePerStop(svc, result, ui);

    var wheel = section(ui, "wheelchair", "Wheelchair data", wc.stops
      ? pctKnown(wc.stopsAccessible + wc.stopsNotAccessible, wc.stops) + " of stops have boarding data" : "No stops with service");
    buildWheelchair(wheel, result);

    [spacing, cand, svc, wheel].forEach(function (s) { host.appendChild(s.root); });

    // A re-run replaces the data behind layers that are already on the map.
    var layers = H.mapLayers();
    if (layers.candidates) H.showCandidates(cs.list.length ? cs.list.map(function (c) { return c.removeStopId; }) : null);
    if (layers.ramp) H.showServiceRamp(result.service);
  }

  // ---- Feed health ----

  var HEALTH_PILL = { ok: "OK", warning: "Warning", error: "Error", unknown: "Not checked" };
  function days(n) { return n + (Math.abs(n) === 1 ? " day" : " days"); }
  function stopRef(id) { return H.stopName(id) + " (" + id + ")"; }
  // Example columns per check id: [header, cell(example)].
  var HEALTH_COLS = {
    expiry: [["End date", function (x) { return isoDate(x.endDate); }],
      ["Date from", function (x) { return x.source === "feed_info" ? "feed_info.txt" : "calendar"; }],
      ["Days left", function (x) { return fmtN(x.daysLeft, 0); }]],
    shapes: [["Trip", function (x) { return x.tripId; }], ["Route", function (x) { return H.routeName(x.routeId); }],
      ["shape_id", function (x) { return x.shapeId === "" ? "(blank)" : x.shapeId; }]],
    wheelchair: [["Stop", function (x) { return stopRef(x.stopId); }]],
    speed: [["Trip", function (x) { return x.tripId; }], ["Route", function (x) { return H.routeName(x.routeId); }],
      ["From", function (x) { return stopRef(x.fromStopId); }], ["To", function (x) { return stopRef(x.toStopId); }],
      ["km/h", function (x) { return fmtN(x.kph, 1); }], ["Limit km/h", function (x) { return fmtN(x.maxKph, 0); }]],
    shapeDistance: [["Stop", function (x) { return stopRef(x.stopId); }], ["shape_id", function (x) { return x.shapeId; }],
      ["Metres", function (x) { return fmtN(x.meters, 0); }]],
    times: [["Trip", function (x) { return x.tripId; }], ["Sequence", function (x) { return x.stopSequence; }],
      ["Stop", function (x) { return stopRef(x.stopId); }]],
    agency: [["Route", function (x) { return H.routeName(x.routeId); }]]
  };

  function healthResultText(c) {
    if (c.status === "unknown") return c.note || "";
    if (c.id === "expiry") {
      var x = c.examples[0];
      if (!x) return "";
      if (x.state === "expired") return "Ended " + isoDate(x.endDate) + ", " + days(-x.daysLeft) + " ago";
      if (x.state === "ok") return "Ends " + isoDate(x.endDate) + " (" + days(x.daysLeft) + " left)";
      return "Ends " + isoDate(x.endDate) + ", in " + days(x.daysLeft);
    }
    return c.count === 0 ? "None found" : c.count + " found";
  }

  function healthDetailRow(c) {
    var tr = el("tr", "gsa-detail"), cell = td("");
    cell.colSpan = 4;
    var cols = HEALTH_COLS[c.id] || [], sub = el("table", "gtfs-dt-table gsa-sub-table");
    var head = el("tr");
    cols.forEach(function (col) { head.appendChild(el("th", "", col[0])); });
    var thead = el("thead");
    thead.appendChild(head);
    sub.appendChild(thead);
    var body = el("tbody");
    c.examples.forEach(function (x) {
      var r = el("tr");
      cols.forEach(function (col) { r.appendChild(td(col[1](x))); });
      body.appendChild(r);
    });
    sub.appendChild(body);
    cell.appendChild(sub);
    if (c.count > c.examples.length) {
      cell.appendChild(note("Showing the first " + c.examples.length + " of " + c.count + "."));
    }
    if (c.note) cell.appendChild(note(c.note));
    tr.appendChild(cell);
    return tr;
  }

  function healthCSV(result) {
    var rows = result.checks.map(function (c) {
      var ex = c.examples.map(function (x) {
        return Object.keys(x).map(function (k) { return k + "=" + x[k]; }).join("; ");
      }).join(" | ");
      return [c.label, c.status, c.count, c.checked, ex];
    });
    return H.csvText(["GTFS feed health", "Checked: " + isoDate(result.today)],
      ["check", "status", "found", "checked", "examples"], rows);
  }

  function renderHealthResults(host, result) {
    if (!host) return;
    host.textContent = "";
    if (!result) return;
    var st = _ui.health = _ui.health || { expanded: {} };
    var wrap = el("div", "gsa-table-wrap"), tbl = el("table", "gtfs-dt-table gsa-health-table");
    var thead = el("thead"), hr = el("tr");
    [["Check", ""], ["Result", ""], ["Found", "num"], ["Checked", "num"]].forEach(function (h) {
      var th = el("th", h[1], h[0]);
      th.scope = "col";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var body = el("tbody");
    result.checks.forEach(function (c) {
      var tr = el("tr", "gsa-health-row");
      tr.setAttribute("data-check", c.id);
      var c0 = td("", "gsa-route-cell");
      if (c.examples.length > 0) {
        var open = !!st.expanded[c.id], caret = el("button", "gsa-caret", open ? "▾" : "▸");
        caret.type = "button";
        caret.setAttribute("aria-expanded", open ? "true" : "false");
        caret.setAttribute("aria-label", "Show examples for " + c.label);
        caret.addEventListener("click", function () {
          st.expanded[c.id] = !st.expanded[c.id];
          caret.textContent = st.expanded[c.id] ? "▾" : "▸";
          caret.setAttribute("aria-expanded", st.expanded[c.id] ? "true" : "false");
          var next = tr.nextSibling;
          if (st.expanded[c.id]) tr.parentNode.insertBefore(healthDetailRow(c), next);
          else if (next && next.classList.contains("gsa-detail")) next.parentNode.removeChild(next);
        });
        c0.appendChild(caret);
      }
      c0.appendChild(document.createTextNode(c.label));
      tr.appendChild(c0);
      var c1 = td("");
      c1.appendChild(el("span", "gsa-health-pill gsa-health-" + c.status, HEALTH_PILL[c.status] || c.status));
      c1.appendChild(document.createTextNode(healthResultText(c)));
      tr.appendChild(c1);
      tr.appendChild(td(fmtN(c.count, 0), "num"));
      tr.appendChild(td(c.status === "unknown" ? "—" : fmtN(c.checked, 0), "num"));
      body.appendChild(tr);
      if (c.examples.length > 0 && st.expanded[c.id]) body.appendChild(healthDetailRow(c));
    });
    tbl.appendChild(body);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
    host.appendChild(note("Thresholds follow the MobilityData GTFS validator: stops more than 100 m from their shape; speeds above the validator's limit for the route type; arrival before the previous departure."));
    var expiry = result.checks[0];
    if (expiry && expiry.examples[0] && expiry.examples[0].source === "calendar") {
      host.appendChild(note("The end date comes from the calendar because feed_info.txt has none."));
    }
    host.appendChild(note("Checked " + isoDate(result.today) + " in " + result.ms + " ms."));
    host.appendChild(csvButton(function () { return healthCSV(result); }, "feed-health.csv"));
  }

  // ---- Route details: Cost tab (instant, like the other details tabs) ----

  function renderCostTab(el, routeId) {
    var f = feed(), G = S();
    el.textContent = "";
    if (!f || !G || typeof G.serviceYear !== "function") return;
    var inputs = serviceInputs();
    inputs.routeIds = [routeId];
    var year = G.serviceYear(f, inputs), row = year.routes[routeId];
    var box = document.createElement("div");
    box.className = "gsa-cost-tab";
    if (!row) {
      box.innerHTML = '<p class="tiny u-muted">This route has no trips on the dates used for weekday, Saturday or Sunday.</p>';
      el.appendChild(box);
      return;
    }
    var basisWord = year.basis === "platform" ? "platform" : "revenue";
    var tbl = document.createElement("table");
    tbl.className = "gtfs-dt-table gsa-cost-mini";
    var head = "<thead><tr><th></th><th>Trips</th><th>Revenue hr</th><th>Platform hr</th><th>Vehicles</th><th>Cost</th></tr></thead>";
    var body = "";
    function fmt(n, d) { return n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }); }
    DAY_TYPES.forEach(function (t) {
      var d = row.perDay[t];
      var label = t.charAt(0).toUpperCase() + t.slice(1);
      body += "<tr><th scope=\"row\">" + label + "</th>" + (d
        ? "<td>" + fmt(d.trips, 0) + "</td><td>" + fmt(d.revenueHrs, 1) + "</td><td>" + fmt(d.platformHrs, 1) +
          "</td><td>" + fmt(d.peakVehicles, 0) + "</td><td>" + money(d.cost) + "</td>"
        : "<td colspan=\"5\" class=\"u-muted\">No service</td>") + "</tr>";
    });
    body += "<tr class=\"gsa-cost-total\"><th scope=\"row\">Year</th><td>" + fmt(row.annual.trips, 0) + "</td><td>" +
      fmt(row.annual.revenueHrs, 0) + "</td><td>" + fmt(row.annual.platformHrs, 0) + "</td><td>" +
      fmt(row.peakVehicles, 0) + "</td><td>" + money(row.annual.cost) + "</td></tr>";
    tbl.innerHTML = head + "<tbody>" + body + "</tbody>";
    box.appendChild(tbl);
    var note = document.createElement("p");
    note.className = "tiny u-muted";
    note.textContent = "Cost = " + money(row.rate) + (row.rateIsOverride ? " (route rate)" : "") + " × " + basisWord +
      " hours. Year = " + year.dayCounts.weekday + " weekdays, " + year.dayCounts.saturday + " Saturdays, " +
      year.dayCounts.sunday + " Sundays. Settings are in GTFS Service Analysis.";
    box.appendChild(note);
    el.appendChild(box);
  }

  if (typeof App.gtfsAddRouteTab === "function") {
    App.gtfsAddRouteTab({ id: "cost", label: "Cost", render: renderCostTab });
  }

  // ---- Lifecycle ----

  function init() {
    if (_initialized) return;
    _initialized = true;
    var tabs = document.querySelectorAll(".gsa-tabs .rf-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () { switchTab(this.getAttribute("data-tab")); });
    }
    var body = document.querySelector(".gsa-body");
    if (body) {
      body.addEventListener("change", function (e) {
        if (e.target && e.target.closest && e.target.closest(".gsa-settings")) onSettingsInput(e);
      });
    }
    var on = function (id, ev, fn) { var el = byId(id); if (el) el.addEventListener(ev, fn); };
    on("gsaRunService", "click", runService);
    on("gsaRunStops", "click", runStops);
    on("gsaRunHealth", "click", runHealth);
    on("gsaIncludeHidden", "change", function () { _includeHidden = this.checked; saveSession(); checkStale(); });
    on("gsaUseStopList", "change", function () { _useStopList = this.checked; saveSession(); checkStale(); });
    on("gsaDate", "change", function () {
      var v = String(this.value || "").replace(/-/g, "");
      // A date outside the feed is refused; put the real one back in the box.
      if (!(/^\d{8}$/.test(v) && App.gtfsAnalysisDate && App.gtfsAnalysisDate.set(v))) syncScopeControls();
    });
    on("gsaServiceDefaults", "click", function () {
      _service = Object.assign({}, DEFAULT_SERVICE);
      writeSettingsToDOM(); saveSession(); refreshCostTab(); checkStale();
    });
    on("gsaStopDefaults", "click", function () {
      _stopsCfg = { thresholdsFt: DEFAULT_STOPS.thresholdsFt.slice(), secondsPerStop: DEFAULT_STOPS.secondsPerStop };
      for (var i = 1; i <= 4; i++) { var t = byId("gsaT" + i); if (t) t.classList.remove("gsa-invalid"); }
      writeSettingsToDOM(); saveSession(); refreshCostTab(); checkStale();
    });
  }

  function onOpen() {
    writeSettingsToDOM();
    syncScopeControls();
    switchTab(_activeTab);
    renderServiceResults(byId("gsaServiceResults"), _serviceResult, _ui);
    renderStopsResults(byId("gsaStopsResults"), _stopsResult, _ui);
    renderHealthResults(byId("gsaHealthResults"), _healthResult);
    checkStale();
  }

  function clearAll() {
    _serviceResult = null; _stopsResult = null; _healthResult = null;
    if (typeof App.gtfsSetHealth === "function") App.gtfsSetHealth(null);
    _serviceStale = _stopsStale = false;
    _rateOverrides = {};
    _ui = {};
    clearMapLayers();
    if (isPopupVisible()) onOpen();
  }

  if (typeof App.gtfsOnInputsChange === "function") App.gtfsOnInputsChange(checkStale);

  App.registerModule({
    id: MODULE_ID,
    name: "GTFS Service Analysis",
    enabled: true,
    popupWidth: 900,
    popupHTML: "projects/gtfs-service-analysis-popup.html",
    init: function () { init(); },
    onOpen: function () { onOpen(); },
    onClose: function () {},
    clear: function () { clearAll(); },
    update: async function () { checkStale(); }
  });

  // ---- Session ----

  function saveSession() {
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
  }

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule(MODULE_ID, {
      collect: function () {
        return {
          v: 1, service: Object.assign({}, _service), stops: { thresholdsFt: _stopsCfg.thresholdsFt.slice(),
            secondsPerStop: _stopsCfg.secondsPerStop },
          includeHidden: _includeHidden, useStopList: _useStopList,
          rateOverrides: Object.assign({}, _rateOverrides), activeTab: _activeTab
        };
      },
      apply: function (data) {
        data = data || {};
        var s = data.service || {}, d = DEFAULT_SERVICE;
        _service = {
          rate: num(s.rate, d.rate, 0), rateBasis: s.rateBasis === "platform" ? "platform" : "revenue",
          deadheadPct: num(s.deadheadPct, d.deadheadPct, 0),
          layoverMode: s.layoverMode === "percent" ? "percent" : "minutes",
          layoverValue: num(s.layoverValue, d.layoverValue, 0), maxBlockGapMin: num(s.maxBlockGapMin, d.maxBlockGapMin, 1),
          daysWeekday: Math.round(num(s.daysWeekday, d.daysWeekday, 0)),
          daysSaturday: Math.round(num(s.daysSaturday, d.daysSaturday, 0)),
          daysSunday: Math.round(num(s.daysSunday, d.daysSunday, 0))
        };
        var st = data.stops || {}, t = Array.isArray(st.thresholdsFt) ? st.thresholdsFt.map(Number) : null;
        var tOk = t && t.length === 4 && t.every(function (x, i) { return isFinite(x) && x > 0 && (i === 0 || x > t[i - 1]); });
        _stopsCfg = { thresholdsFt: tOk ? t : DEFAULT_STOPS.thresholdsFt.slice(),
          secondsPerStop: num(st.secondsPerStop, DEFAULT_STOPS.secondsPerStop, 0) };
        _includeHidden = !!data.includeHidden;
        _useStopList = !!data.useStopList;
        _rateOverrides = {};
        var ro = data.rateOverrides || {};
        Object.keys(ro).forEach(function (k) { var v = sanitizeRate(ro[k]); if (v != null) _rateOverrides[k] = v; });
        _activeTab = tabId(data.activeTab);
        // Results are not saved: they are recomputed from the feed with one click.
        _serviceResult = _stopsResult = _healthResult = null;
        clearMapLayers();
        if (isPopupVisible()) onOpen();
      }
    });
  }
})();
