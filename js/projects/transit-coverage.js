// js/projects/transit-coverage.js — Transit Coverage module: ACS population + LODES jobs within a
// buffer of selected transit routes/lines, clipped to a user-selected service area.
// Depends on: App, App.popup, App.cache, App.getEffectiveServiceBands (service-assembly.js), census.js, lodes.js, turf.
// Optional at call time: the GTFS feed (App.gtfsSchedule, window.GtfsSchedule) and the road network (App.multiWalkPolygon).
// No public API (App._tcTest is a test-only hook).  Detail: docs/reference/modules/transit-coverage.md

(function () {
  "use strict";
  var App = window.App = window.App || {};

  // ---- Module-local state (persists across popup open/close) ----

  var _lastResult       = null;   // { geoLevel, year, ..., coverageClipped, thresholdClipped, serviceAreaUnion }
  var _stale            = false;
  var _running          = false;
  var _initialized       = false;
  // Checklist selection (transit features AND service-area polygons) is remembered as
  // the features the user UNCHECKED, by stable { type, id } ref — array
  // positions shift when an earlier feature is deleted or merged. Anything not listed
  // (including newly drawn features) is checked.
  var _uncheckedRefs     = [];
  var _useDisplayBuffers = false;
  var _coverageFrom      = "stops";  // "stops" | "line"; new work defaults to stops, a saved session without the key restores as "line"
  var _apportionMethod   = App.APPORTION_DEFAULT;   // "blockPop" | "area"; a saved session without the key restores as "area"
  var _includeHidden     = false;   // one toggle for BOTH lists (docs/archive/hidden-features-analysis-plan.md)
  // GTFS routes are remembered like the drawn features: the UNCHECKED route_ids, so a route that appears
  // later (new feed, another date) defaults to checked.
  var _gtfsUnchecked     = [];
  var _busBufferMi       = 0.25;
  var _railBufferMi      = 0.5;
  var _distanceMode      = "straight";   // "straight" | "streets"
  // Taken at run time so update() can tell a relevant change from an unrelated
  // hide/show (notifyProject fires on every visibility change).
  var _runSnap           = null;    // { geom, hidden, refs: [{type,id}], includeHidden, gtfs: string|null }

  // ---- DOM guard: only touch DOM when popup is open for this module ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "transit-coverage";
  }

  // ---- Checklist selection memory (by stable ID) ----

  // Record which rows of BOTH checklists are unchecked. Called from checkbox change
  // handlers only — never from a rebuild, so a restored selection isn't overwritten
  // by stale DOM.
  function captureChecklistSelection() {
    var out = [];
    var seen = false;
    ["tcFeatureList", "tcAreaList"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var boxes = el.querySelectorAll("input[type=checkbox]");
      if (boxes.length) seen = true;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) continue;
        var fid = parseInt(boxes[i].getAttribute("data-feature-id"), 10);
        if (Number.isFinite(fid)) out.push({ type: boxes[i].getAttribute("data-type"), id: fid });
      }
    });
    if (!seen) return;
    _uncheckedRefs = out;
    if (App.cache && App.cache.save) App.cache.save();
  }

  function isRefUnchecked(type, id) {
    for (var i = 0; i < _uncheckedRefs.length; i++) {
      if (_uncheckedRefs[i].type === type && _uncheckedRefs[i].id === id) return true;
    }
    return false;
  }

  // Stable refs of the currently checked rows in one checklist.
  function checkedRefsIn(containerId) {
    var el = document.getElementById(containerId);
    var out = [];
    if (!el) return out;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked || boxes[i].disabled) continue;   // disabled = hidden row, toggle off: kept in the saved selection, not analyzed
      var fid = parseInt(boxes[i].getAttribute("data-feature-id"), 10);
      if (Number.isFinite(fid)) out.push({ type: boxes[i].getAttribute("data-type"), id: fid });
    }
    return out;
  }

  // Everything besides the hidden flag that changes a run and arrives via
  // notifyProject: feature edits, LODES, display-buffer radii.
  function runInputsSig() {
    var fs = App.featureSettings || {};
    // Street distances depend on the walk network; straight-line runs do not care about it.
    var net = _distanceMode === "streets" && typeof App.roadNetworkEpoch === "function" ? App.roadNetworkEpoch() : "";
    return App.featureGeomSignature() + "#lodes:" + (App.lodesData ? (App.lodesFileName || "1") : "") + "#net:" + net +
      "#fs:" + JSON.stringify([fs.bufferRadius, fs.lineBufferRadius, fs.routeBufferRadius]);
  }

  // What a run's GTFS routes depend on: the feed, the analysis date, hidden routes and the day parts
  // (the headway threshold reads them). "none" without a feed.
  function gtfsSig() {
    var feed = typeof App.gtfsSchedule === "function" ? App.gtfsSchedule() : null;
    if (!feed) return "none";
    if (!_feedIds.has(feed)) _feedIds.set(feed, ++_feedSeq);
    return _feedIds.get(feed) + "|" + (App.gtfsAnalysisDate.get() || "") + "|" +
      JSON.stringify(App.gtfsHiddenState().routes.slice().sort()) + "|" + JSON.stringify(App.gtfsDayParts.get());
  }
  var _feedIds = new WeakMap(), _feedSeq = 0;

  function makeRunSnap(refs) {
    return { geom: runInputsSig(), refs: refs, hidden: App.hiddenSignature(refs), includeHidden: _includeHidden, gtfs: gtfsSig() };
  }

  // True when the last run no longer matches the map: features changed, the hidden
  // state of a feature in the run's selection changed, or the toggle changed.
  function runIsOutdated() {
    if (!_runSnap) return false;
    if (_runSnap.includeHidden !== _includeHidden) return true;
    if (_runSnap.geom !== runInputsSig()) return true;
    // null = restored from a session: the feed may still be loading, so it says nothing.
    if (_runSnap.gtfs !== null && _runSnap.gtfs !== gtfsSig()) return true;
    return _runSnap.hidden !== App.hiddenSignature(_runSnap.refs);
  }

  // ---- Feature checklist (routes + lines) ----

  function buildFeatureChecklist() {
    var el = document.getElementById("tcFeatureList");
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

  // ---- Service-area checklist (drawn polygons) ----

  function buildAreaChecklist() {
    var el = document.getElementById("tcAreaList");
    if (!el) return;

    el.innerHTML = "";
    var hasAreas = false;

    function addRow(idx, name, feature) {
      hasAreas = true;
      var ref = App.featureRef("polygon", idx);
      var checked = !(ref && isRefUnchecked("polygon", ref.id));
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", "polygon");
      cb.setAttribute("data-idx", String(idx));
      if (ref) cb.setAttribute("data-feature-id", String(ref.id));
      cb.checked = checked;

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = name;

      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = "P";

      lbl.addEventListener("click", function (e) { e.preventDefault(); if (cb.disabled) return; cb.checked = !cb.checked; captureChecklistSelection(); markStale(); });
      cb.addEventListener("change", function () { captureChecklistSelection(); markStale(); });

      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(badgeEl);
      el.appendChild(row);
      App.decorateHiddenRow(row, cb, feature, _includeHidden);
    }

    var polygons = App.polygons || [];
    for (var i = 0; i < polygons.length; i++) {
      addRow(i, (polygons[i].properties && polygons[i].properties.name) || ("Polygon " + (i + 1)), polygons[i]);
    }

    if (!hasAreas) {
      el.innerHTML = '<div style="padding:6px;color:var(--muted);font-size:12px;">No polygons drawn.</div>';
    }
  }

  // ---- GTFS routes checklist ----

  function feedReady() {
    return typeof App.gtfsSchedule === "function" && !!App.gtfsSchedule();
  }

  function isoDate(d) { return d ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : ""; }

  // Routes of the loaded feed that run on the analysis date, hidden ones only with Include hidden.
  // scopeRouteIds is null when nothing is hidden (every route is in scope).
  function gtfsRoutesOnDate() {
    var feed = feedReady() ? App.gtfsSchedule() : null;
    var date = feed ? App.gtfsAnalysisDate.get() : null;
    if (!feed || !date) return [];
    var running = Object.create(null);
    window.GtfsSchedule.tripsOnDate(feed, date).trips.forEach(function (t) { running[t.routeId] = true; });
    var scope = App.gtfsScopeRouteIds(_includeHidden), inScope = null;
    if (scope) { inScope = Object.create(null); scope.forEach(function (id) { inScope[id] = true; }); }
    var out = [];
    Object.keys(running).forEach(function (id) {
      if (inScope && !inScope[id]) return;
      var r = feed._routes[id] || {};
      var short = typeof r.route_short_name === "string" ? r.route_short_name.trim() : "";
      var long = typeof r.route_long_name === "string" ? r.route_long_name.trim() : "";
      var color = typeof r.route_color === "string" ? r.route_color.trim() : "";
      out.push({ id: id, name: short || long || id, title: long, mode: gtfsRouteMode(r.route_type),
        color: /^[0-9a-fA-F]{6}$/.test(color) ? "#" + color : "" });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1); });
    return out;
  }

  function isGtfsUnchecked(id) { return _gtfsUnchecked.indexOf(id) >= 0; }

  // Remember the unchecked boxes, keeping earlier entries for routes not listed right now (hidden ones).
  function captureGtfsSelection() {
    var el = document.getElementById("tcGtfsList");
    if (!el) return;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return;
    var listed = Object.create(null), off = [];
    for (var i = 0; i < boxes.length; i++) {
      var id = boxes[i].getAttribute("data-route-id");
      listed[id] = true;
      if (!boxes[i].checked) off.push(id);
    }
    _gtfsUnchecked = _gtfsUnchecked.filter(function (x) { return !listed[x]; }).concat(off);
    if (App.cache && App.cache.save) App.cache.save();
  }

  function buildGtfsChecklist() {
    var sec = document.getElementById("tcGtfsSection");
    var el = document.getElementById("tcGtfsList");
    if (!sec || !el) return;
    var show = feedReady();
    sec.style.display = show ? "" : "none";
    var bufs = document.getElementById("tcGtfsBuffers");
    if (bufs) bufs.style.display = show ? "" : "none";
    el.innerHTML = "";
    if (!show) return;

    var date = App.gtfsAnalysisDate.get();
    var dateEl = document.getElementById("tcGtfsDate");
    if (dateEl) {
      dateEl.textContent = date ? "Analysis date: " + isoDate(date) + " (change in the GTFS panel)"
        : "This feed has no dates with service.";
    }

    var routes = gtfsRoutesOnDate();
    routes.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "rf-feature-check-row";
      if (r.title) row.title = r.title;

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-type", "gtfs");
      cb.setAttribute("data-route-id", r.id);
      cb.checked = !isGtfsUnchecked(r.id);

      var chip = document.createElement("span");
      chip.className = "tc-route-chip";
      if (r.color) chip.style.background = r.color;

      var lbl = document.createElement("label");
      lbl.style.cssText = "flex:1;cursor:pointer;";
      lbl.textContent = r.name;

      var badgeEl = document.createElement("span");
      badgeEl.className = "rf-feature-type-badge";
      badgeEl.textContent = r.mode;

      lbl.addEventListener("click", function (e) { e.preventDefault(); cb.checked = !cb.checked; captureGtfsSelection(); markStale(); });
      cb.addEventListener("change", function () { captureGtfsSelection(); markStale(); });

      row.appendChild(cb);
      row.appendChild(chip);
      row.appendChild(lbl);
      row.appendChild(badgeEl);
      el.appendChild(row);
    });
    if (!routes.length) {
      el.innerHTML = '<div class="rf-empty-note">No GTFS routes run on this date.</div>';
    }
  }

  function getSelectedGtfsRoutes() {
    var el = document.getElementById("tcGtfsList");
    var out = [];
    if (!el || !feedReady()) return out;
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) out.push(boxes[i].getAttribute("data-route-id"));
    }
    return out;
  }

  // ---- Selection readers/writers (explicit index arrays — never "null = all") ----

  function getSelectedFeatures() {
    var el = document.getElementById("tcFeatureList");
    var routeIndices = [], lineIndices = [];
    if (!el) return { routeIndices: routeIndices, lineIndices: lineIndices };
    var boxes = el.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < boxes.length; i++) {
      var cb = boxes[i];
      if (!cb.checked || cb.disabled) continue;
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
      if (!cb.checked || cb.disabled) continue;
      polygonIndices.push(parseInt(cb.getAttribute("data-idx"), 10));
    }
    return { polygonIndices: polygonIndices };
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
    var nFeat = (App.routes || []).length + (App.lines || []).length + gtfsRoutesOnDate().length;
    if (!nFeat) {
      return { need: "Draw a route or line to begin.",
               action: "Use the Route or Line tool (or load a GTFS feed), then reopen this panel." };
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
      r.useDisplayBuffers ? "display buffers" : (r.bufferLabel || r.bufferMiles + " mi"),
      geoLabel + " · " + r.year,
      DAY_LABEL[r.dayType] || r.dayType
    ];
    if (r.thresholdMin != null) parts.push("≤ " + r.thresholdMin + " min headway");
    if (r.distanceMode === "streets") parts.push("along streets");
    return parts.join(" · ");
  }

  function syncBufferControl() {
    var input = document.getElementById("tcBufferMiles");
    var toggle = document.getElementById("tcUseDisplayBuffers");
    if (input) input.disabled = _useDisplayBuffers;
    if (toggle) toggle.checked = _useDisplayBuffers;
    var from = document.getElementById("tcCoverageFrom");
    var ap = document.getElementById("tcApportionMethod");
    if (ap) ap.value = _apportionMethod;
    var bus = document.getElementById("tcBusBufferMi"), rail = document.getElementById("tcRailBufferMi");
    var dist = document.getElementById("tcDistanceMode");
    if (bus) bus.value = String(_busBufferMi);
    if (rail) rail.value = String(_railBufferMi);
    if (dist) dist.value = _distanceMode;
    if (from) {
      from.value = _coverageFrom;
      from.disabled = _useDisplayBuffers;   // display buffers ignore this setting
    }
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
    // bufferLabel is set when GTFS stops (bus/rail buffers) are part of the run.
    var dist = s.bufferLabel || (s.bufferMiles + " mi");
    var sentence = formatPct(s.popCovered, s.popTotal) +
      " of residents are within " + dist + " of selected transit";
    if (s.hasThreshold) {
      sentence += "; " + formatPct(s.popThreshold, s.popTotal) +
        " within " + dist + " of " + s.headwayThreshold + "-min-or-better service.";
    } else {
      sentence += ".";
    }
    return sentence;
  }

  // ---- GTFS helpers (pure) ----

  var RAIL_ROUTE_TYPES = { "0": true, "1": true, "2": true, "5": true, "7": true, "12": true };

  // "rail" for light rail, subway, rail, cable tram, funicular and the extended rail type; else "bus".
  function gtfsRouteMode(routeType) {
    if (window.AnalysisNetwork && typeof window.AnalysisNetwork.modeOf === "function") {
      return window.AnalysisNetwork.modeOf(routeType);
    }
    var t = routeType === undefined || routeType === null ? "" : String(routeType).trim();
    return RAIL_ROUTE_TYPES[t] === true ? "rail" : "bus";
  }

  function medianOf(nums) {
    if (!nums.length) return null;
    var a = nums.slice().sort(function (x, y) { return x - y; }), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Joins each selected route's stop rows (stopServiceTable rows, one route at a time) into the stops to
  // buffer and one summary row per route. A stop served by any rail route takes the rail buffer.
  // A row without usable coordinates is skipped, so it counts toward nothing.
  //   entries: [{ routeId, name, mode, rows: [{ stopId, lat, lon, peakHeadwaySec }] }]
  function buildGtfsStopPlan(entries, busMi, railMi) {
    var byStop = Object.create(null), routes = [];
    (entries || []).forEach(function (e) {
      var used = 0, peaks = [];
      (e.rows || []).forEach(function (r) {
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
        used++;
        if (Number.isFinite(r.peakHeadwaySec)) peaks.push(r.peakHeadwaySec);
        var cur = byStop[r.stopId];
        if (!cur) cur = byStop[r.stopId] = { stopId: r.stopId, lat: r.lat, lon: r.lon, mode: "bus" };
        if (e.mode === "rail") cur.mode = "rail";
      });
      var med = medianOf(peaks);
      routes.push({ routeId: e.routeId, name: e.name, mode: e.mode, stopCount: used,
        peakHeadwayMin: med === null ? null : Math.round(med / 60 * 10) / 10 });
    });
    var stops = Object.keys(byStop).sort().map(function (id) {
      var st = byStop[id];
      st.miles = st.mode === "rail" ? railMi : busMi;
      return st;
    });
    return { stops: stops, routes: routes };
  }

  // Stops whose combined peak headway (rows from one stopServiceTable call over the selected routes)
  // is at or under the threshold. A stop with no peak departures pair has no headway and never qualifies.
  function gtfsQualifyingStopIds(rows, thresholdMin) {
    var out = [];
    if (!(thresholdMin > 0)) return out;
    (rows || []).forEach(function (r) {
      if (Number.isFinite(r.peakHeadwaySec) && r.peakHeadwaySec <= thresholdMin * 60) out.push(r.stopId);
    });
    return out.sort();
  }

  // Distance wording for rows, the sentence and the summary line.
  //   o: { bufferMiles, drawn: bool, gtfs: bool, busMi, railMi }
  function coverageBufferLabel(o) {
    var g = "bus " + o.busMi + " mi / rail " + o.railMi + " mi";
    if (!o.gtfs) return o.bufferMiles + " mi";
    return o.drawn ? o.bufferMiles + " mi (drawn), " + g : g;
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

  // Test-only: expose the pure helpers to the golden harness (test/run-golden.mjs); guarded by
  // __MAT_TEST__ so it is inert in the browser. See test/README.md.
  if (typeof window !== "undefined" && window.__MAT_TEST__) {
    App._tcTest = {
      computePeakHeadway: computePeakHeadway,
      formatPct:          formatPct,
      formatCount:        formatCount,
      buildStatSentence:  buildStatSentence,
      gtfsRouteMode:      gtfsRouteMode,
      buildGtfsStopPlan:  buildGtfsStopPlan,
      gtfsQualifyingStopIds: gtfsQualifyingStopIds,
      coverageBufferLabel: coverageBufferLabel,
      _csvField:          _csvField
    };
  }

  // ---- Geometry: private buffers, unions, clipping ----
  // These build the module's OWN buffers via turf (via the shared
  // App.buildAnalysisBuffer/App.foldAnalysisUnion helpers in
  // js/core/module-buffers.js) — they never read or mutate
  // App.routeBuffers / App.lineBuffers (those belong to the shared
  // Feature Settings buffer radius, a different concern).

  // Lets the browser paint status text between the heavy synchronous steps.
  function tick() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

  // Spatial sort key so neighbouring circles are merged first (a Morton code of the first vertex).
  function mortonKey(poly) {
    var c = poly.geometry.coordinates;
    var p = poly.geometry.type === "MultiPolygon" ? c[0][0][0] : c[0][0];
    var x = Math.max(0, Math.floor((p[0] + 180) * 200)), y = Math.max(0, Math.floor((p[1] + 90) * 200)), r = 0;
    for (var b = 0; b < 17; b++) r += (((x >> b) & 1) + 2 * ((y >> b) & 1)) * Math.pow(4, b);
    return r;
  }

  // Union of many polygons by pairwise merging of spatial neighbours. foldAnalysisUnion folds one
  // polygon at a time into an ever larger shape, which for a few thousand stop circles takes minutes.
  // Yields between rounds so a large system leaves the page responsive.
  async function unionMany(polys) {
    var a = (polys || []).filter(Boolean);
    if (a.length < 3) return App.foldAnalysisUnion(a);
    var keyed = a.map(function (p) { return { p: p, k: mortonKey(p) }; });
    keyed.sort(function (x, y) { return x.k - y.k; });
    a = keyed.map(function (e) { return e.p; });
    var big = a.length > 200;
    while (a.length > 1) {
      var next = [];
      for (var i = 0; i < a.length; i += 2) {
        if (i + 1 >= a.length) { next.push(a[i]); continue; }
        try { next.push(turf.union(a[i], a[i + 1])); } catch (e) { next.push(a[i]); }
      }
      a = next;
      if (big) await tick();
    }
    return a[0];
  }

  var KM_PER_MILE = 1.609344;

  // Area within `miles` of every item ({ id, lng, lat, miles }): circles, or the walking area along
  // streets when `streets` and a road network is loaded. An item that does not snap to a street gets a
  // circle instead and is counted in `off`. One flood per distinct distance.
  async function unionAround(items, streets) {
    var groups = Object.create(null), keys = [];
    items.forEach(function (it) {
      var k = String(it.miles);
      if (!groups[k]) { groups[k] = []; keys.push(k); }
      groups[k].push(it);
    });
    var parts = [], off = 0;
    for (var g = 0; g < keys.length; g++) {
      var group = groups[keys[g]], miles = group[0].miles, circleItems = group;
      if (streets && typeof App.multiWalkPolygon === "function") {
        var res = App.multiWalkPolygon(group.map(function (it) { return { lngLat: [it.lng, it.lat], id: it.id }; }),
          miles * KM_PER_MILE);
        if (res && res.polygon) {
          parts.push(res.polygon);
          var gone = Object.create(null);
          res.unsnapped.forEach(function (id) { gone[id] = true; });
          circleItems = group.filter(function (it) { return gone[it.id]; });
          off += circleItems.length;
        }
        await tick();
      }
      if (circleItems.length) {
        var circles = [];
        circleItems.forEach(function (it) {
          try { circles.push(turf.circle([it.lng, it.lat], it.miles, { units: "miles", steps: 32 })); } catch (e) { /* skip a bad point */ }
        });
        parts.push(await unionMany(circles));
      }
    }
    return { union: await unionMany(parts), off: off };
  }

  function roundMi(n) { return Math.round(n * 1000) / 1000; }

  // Stops of the selected GTFS routes on the analysis date, buffered by mode (bus / rail), plus the
  // headway-qualifying subset. Everything comes from the schedule (stopServiceTable), one call per route.
  async function buildGtfsCoverage(routeIds, o) {
    var S = window.GtfsSchedule, feed = App.gtfsSchedule(), date = App.gtfsAnalysisDate.get();
    var parts = App.gtfsDayParts.get();
    var meta = Object.create(null);
    gtfsRoutesOnDate().forEach(function (r) { meta[r.id] = r; });
    var entries = routeIds.map(function (id) {
      var m = meta[id] || { name: id, mode: "bus" };
      return { routeId: id, name: m.name, mode: m.mode,
        rows: S.stopServiceTable(feed, date, { routeIds: [id], dayParts: parts }) };
    });
    var plan = buildGtfsStopPlan(entries, o.busMi, o.railMi);
    var items = plan.stops.map(function (st) { return { id: st.stopId, lng: st.lon, lat: st.lat, miles: st.miles }; });
    var qualifyIds = null, qualifyCount = 0;
    if (o.thresholdMin != null) {
      var qset = Object.create(null);
      gtfsQualifyingStopIds(S.stopServiceTable(feed, date, { routeIds: routeIds, dayParts: parts }), o.thresholdMin)
        .forEach(function (id) { qset[id] = true; });
      qualifyIds = qset;
      qualifyCount = items.filter(function (it) { return qset[it.id]; }).length;
    }
    var all = await unionAround(items, o.streets);
    var thr = null, off = all.off;
    if (qualifyIds) {
      var sub = items.filter(function (it) { return qualifyIds[it.id]; });
      thr = sub.length ? await unionAround(sub, o.streets) : { union: null, off: 0 };
    }
    return { union: all.union, thresholdUnion: thr ? thr.union : null, off: off,
      stopCount: items.length, qualifyCount: qualifyCount,
      rows: plan.routes.map(function (r) {
        return { name: r.name, featureType: "gtfs", featureId: null, routeId: r.routeId, mode: r.mode,
          peakHeadway: r.peakHeadwayMin, qualifies: false, coverageSource: "gtfs-stops", stopCount: r.stopCount };
      }) };
  }

  async function buildCoverageUnions(sel, miles, dayType, thresholdMin, useDisplayBuffers, includeHidden, coverageFrom, streets) {
    var headwayRows = [];
    var allBuffers = [];
    var qualifyingBuffers = [];
    var off = 0;
    var bufferSet = useDisplayBuffers
      ? App.buildDisplayBufferSet(sel, { includeHidden: !!includeHidden })
      : App.buildAnalysisBufferSet(sel, miles, { includeHidden: !!includeHidden });

    // Display buffers always win: they are the drawn line buffers, so coverageFrom does not apply.
    var useStops = coverageFrom === "stops" && !useDisplayBuffers;

    function featureIdOf(type, idx) {
      var ref = App.featureRef(type, idx);
      return ref ? ref.id : null;
    }

    async function processFeature(type, idx, feature) {
      if (!feature) return;
      var name = (feature.properties && feature.properties.name) ||
        (type.charAt(0).toUpperCase() + type.slice(1) + " " + (idx + 1));
      var attrs = (feature.properties && feature.properties.attributes) || {};
      var peak = computePeakHeadway(attrs.service, dayType);
      var qualifies = thresholdMin != null && peak != null && peak <= thresholdMin;
      var row = {
        name: name, featureType: type, featureId: featureIdOf(type, idx),
        peakHeadway: peak, qualifies: qualifies,
        coverageSource: "line", stopCount: 0
      };
      headwayRows.push(row);

      var buf = bufferSet.get(type, idx);
      // A hidden feature left out of the buffer set (include-hidden off) stays out
      // even when its stops are visible.
      var excluded = !!(feature.properties && feature.properties.hidden) && !includeHidden;
      if (useStops && !excluded) {
        var stops = App.associatedStopPoints(type, feature, { includeHidden: !!includeHidden });
        if (stops.length >= 1) {
          var circles;
          if (streets) {
            var around = await unionAround(stops.map(function (pt, i) {
              return { id: String(i), lng: pt.geometry.coordinates[0], lat: pt.geometry.coordinates[1], miles: miles };
            }), true);
            circles = around.union;
            off += around.off;
          } else {
            circles = App.buildStopCircleUnion(stops, miles);
          }
          if (circles) {
            buf = circles;
            row.coverageSource = "stops";
            row.stopCount = stops.length;
          }
        }
      }
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
      await processFeature("route", routeIndices[i], routes[routeIndices[i]]);
    }
    for (i = 0; i < lineIndices.length; i++) {
      await processFeature("line", lineIndices[i], lines[lineIndices[i]]);
    }

    return { buffers: allBuffers, qualifyingBuffers: qualifyingBuffers, headwayRows: headwayRows, off: off,
             hiddenCount: bufferSet.hiddenCount || { included: 0, skipped: 0 } };
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

  // Colors resolve through the layer style cascade — a categorical spec, one class per semantic
  // fill. The fallback array equals the spec's defaultColors so a missing layer-palettes.js
  // degrades to the original colors instead of throwing.
  var TC_DEFAULT_COLORS = ["#93c5fd", "#1d4ed8", "#374151"];
  function tcColors() {
    return (typeof App.resolveLayerColors === "function" &&
            App.resolveLayerColors("transit-coverage")) || TC_DEFAULT_COLORS;
  }

  function renderMapOverlay(result) {
    var map = App.map;
    if (!map || !result) return;
    var fc = buildOverlayFeatureCollection(result);
    var c = tcColors();

    if (!map.getSource(TC_SOURCE)) {
      map.addSource(TC_SOURCE, { type: "geojson", data: fc });
      map.addLayer({
        id: TC_COVERAGE_LAYER,
        type: "fill",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "coverage"],
        paint: { "fill-color": c[0], "fill-opacity": 0.35 }
      });
      map.addLayer({
        id: TC_THRESHOLD_LAYER,
        type: "fill",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "threshold"],
        paint: { "fill-color": c[1], "fill-opacity": 0.35 }
      });
      map.addLayer({
        id: TC_AREA_LAYER,
        type: "line",
        source: TC_SOURCE,
        filter: ["==", ["get", "kind"], "area"],
        paint: { "line-color": c[2], "line-width": 2, "line-dasharray": [2, 2] }
      });
    } else {
      map.getSource(TC_SOURCE).setData(fc);
      // Refresh paint too, or a palette changed while results are on screen would only apply on re-run.
      repaintOverlay();
    }
  }

  // Paint-only refresh: re-applies resolved colors to whichever of the three
  // layers are currently on the map, and re-fills the legend swatches. No
  // recompute — this is what makes a palette change instant.
  function repaintOverlay() {
    var map = App.map;
    if (!map) return;
    var c = tcColors();
    if (map.getLayer(TC_COVERAGE_LAYER))  map.setPaintProperty(TC_COVERAGE_LAYER, "fill-color", c[0]);
    if (map.getLayer(TC_THRESHOLD_LAYER)) map.setPaintProperty(TC_THRESHOLD_LAYER, "fill-color", c[1]);
    if (map.getLayer(TC_AREA_LAYER))      map.setPaintProperty(TC_AREA_LAYER, "line-color", c[2]);
    fillLegendColors();
  }

  // The legend fragment paints a translucent fill plus a solid border from
  // one source color, so each swatch needs both forms of the resolved color.
  // The service-area row is an outline-only swatch (dashed border, no fill),
  // matching how that layer renders on the map.
  function fillLegendColors() {
    if (typeof window.LayerPalette === "undefined") return;
    var c = tcColors();
    var fillRows = [
      { id: "tcLegendSw0", color: c[0] },
      { id: "tcLegendSw1", color: c[1] }
    ];
    fillRows.forEach(function (row) {
      var el = document.getElementById(row.id);
      if (!el) return;
      var bg = window.LayerPalette.rgba(row.color, 0.35);
      if (bg) el.style.background = bg;
      el.style.borderColor = row.color;
    });
    var area = document.getElementById("tcLegendSwArea");
    if (area) area.style.borderColor = c[2];
  }

  // showFloatingWidget resolves asynchronously only on first creation (it
  // fetches the fragment); re-showing an existing widget returns an already
  // resolved promise. Branching on thenable keeps every caller synchronous —
  // the same wrapper shape the other module legends use.
  function showCoverageLegend() {
    if (!App.popup || !App.popup.showFloatingWidget) return;
    var p = App.popup.showFloatingWidget("tc-legend", "projects/transit-coverage-legend.html", {
      position: "bottom-left",
      width: 200,
      title: "Transit Coverage"
    });
    if (p && typeof p.then === "function") p.then(fillLegendColors);
    else fillLegendColors();
  }

  if (typeof App.registerLayerRepainter === "function") {
    App.registerLayerRepainter("transit-coverage", repaintOverlay);
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
    // Everything the user ticked in a list is hidden on the map (toggle off): say so.
    var pre = { feat: getSelectedFeatures(), area: getSelectedAreas(), gtfs: getSelectedGtfsRoutes() };
    var hiddenChecked = function (id) { return document.querySelectorAll("#" + id + " input[type=checkbox]:checked:disabled").length; };
    if ((!pre.feat.routeIndices.length && !pre.feat.lineIndices.length && !pre.gtfs.length && hiddenChecked("tcFeatureList") > 0) ||
        (!pre.area.polygonIndices.length && hiddenChecked("tcAreaList") > 0)) {
      setStatus(App.hiddenSelectionMessage(0).error, "error");
      return;
    }
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
      var gtfsSel = getSelectedGtfsRoutes();
      if (!featSel.routeIndices.length && !featSel.lineIndices.length && !gtfsSel.length) {
        throw new Error(feedReady() ? "Select at least one route, line or GTFS route." : "Select at least one route or line.");
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
      var coverageFromEl = document.getElementById("tcCoverageFrom");
      if (coverageFromEl) _coverageFrom = coverageFromEl.value === "stops" ? "stops" : "line";

      var busMi  = _busBufferMi  = App.readAnalysisBufferMiles("tcBusBufferMi", 0.25);
      var railMi = _railBufferMi = App.readAnalysisBufferMiles("tcRailBufferMi", 0.5);
      var distEl = document.getElementById("tcDistanceMode");
      if (distEl) _distanceMode = distEl.value === "streets" ? "streets" : "straight";
      // Street distance needs the walk network; without it the run falls back, and says so.
      var noNetwork = _distanceMode === "streets" && !App.roadNetworkLoaded();
      var streets = _distanceMode === "streets" && !noNetwork;

      var unions = await buildCoverageUnions(featSel, bufferMiles, dayType, thresholdMin, _useDisplayBuffers, _includeHidden, _coverageFrom, streets);
      var gtfsCov = null;
      if (gtfsSel.length) {
        setStatus(streets ? "Measuring GTFS stops along streets…" : "Buffering GTFS stops…", "running");
        await tick();
        gtfsCov = await buildGtfsCoverage(gtfsSel, { busMi: busMi, railMi: railMi, thresholdMin: thresholdMin, streets: streets });
      }
      var snap = makeRunSnap(checkedRefsIn("tcFeatureList").concat(checkedRefsIn("tcAreaList")));
      // Hidden features that took part: route/line from the buffer set, plus hidden service-area polygons.
      var hiddenIncluded = (unions.hiddenCount && unions.hiddenCount.included) || 0;
      if (_includeHidden) {
        areaSel.polygonIndices.forEach(function (pi) {
          var pf = (App.polygons || [])[pi];
          if (pf && pf.properties && pf.properties.hidden) hiddenIncluded++;
        });
      }
      setStatus("Combining buffers…", "running");
      await tick();
      var coverageUnion  = await unionMany(unions.buffers.concat(gtfsCov && gtfsCov.union ? [gtfsCov.union] : []));
      var thresholdUnion = null;
      if (thresholdMin != null) {
        thresholdUnion = await unionMany(unions.qualifyingBuffers.concat(gtfsCov && gtfsCov.thresholdUnion ? [gtfsCov.thresholdUnion] : []));
      }
      var headwayRows     = unions.headwayRows.concat(gtfsCov ? gtfsCov.rows : []);
      var offNetwork = unions.off + (gtfsCov ? gtfsCov.off : 0);
      var distanceNote = noNetwork ? "No street network is loaded, so distance was measured in a straight line."
        : offNetwork > 0 ? offNetwork + (offNetwork === 1 ? " stop is" : " stops are") +
          " off the street network and " + (offNetwork === 1 ? "was" : "were") + " measured in a straight line."
        : null;
      var bufferLabel = coverageBufferLabel({ bufferMiles: bufferMiles, busMi: busMi, railMi: railMi,
        gtfs: !!gtfsCov, drawn: featSel.routeIndices.length + featSel.lineIndices.length > 0 });
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
      var apSel = document.getElementById("tcApportionMethod");
      if (apSel) _apportionMethod = apSel.value === "area" ? "area" : "blockPop";
      var anyFellBack = false, apportionNote = null;
      // The block download is cached by geography bbox, so the three unions share one download.
      async function sumPopInUnion(unionFeat) {
        var ap = await App.computeApportionFractions(unionFeat, geos, _apportionMethod, {
          onProgress: function (m) { setStatus(m, "running"); }
        });
        if (ap.methodUsed !== _apportionMethod) anyFellBack = true;
        if (!apportionNote && ap.note) apportionNote = ap.note;
        return App.aggregateWithinUnion(unionFeat, geos, popMap, "sum", { fractions: ap.fractions }).value;
      }
      var popTotal     = await sumPopInUnion(serviceAreaUnion);
      var popCovered   = coverageClipped ? await sumPopInUnion(coverageClipped) : 0;
      var popThreshold = (thresholdMin == null) ? null
                       : (thresholdClipped ? await sumPopInUnion(thresholdClipped) : 0);
      var apportionMethodUsed = anyFellBack ? "area" : _apportionMethod;

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
        bufferMiles: bufferMiles, useDisplayBuffers: _useDisplayBuffers, coverageFrom: _coverageFrom,
        bufferLabel: bufferLabel, busMi: busMi, railMi: railMi,
        distanceMode: streets ? "streets" : "straight", distanceNote: distanceNote,
        gtfsDate: gtfsCov ? App.gtfsAnalysisDate.get() : null,
        gtfsStopCount: gtfsCov ? gtfsCov.stopCount : 0, gtfsQualifyCount: gtfsCov ? gtfsCov.qualifyCount : 0,
        apportionMethodUsed: apportionMethodUsed, apportionNote: apportionNote,
        dayType: dayType, thresholdMin: thresholdMin,
        popTotal: popTotal, popCovered: popCovered, popThreshold: popThreshold,
        jobsTotal: jobsTotal, jobsCovered: jobsCovered, jobsThreshold: jobsThreshold,
        headwayRows: headwayRows,
        coverageClipped: coverageClipped, thresholdClipped: thresholdClipped,
        serviceAreaUnion: serviceAreaUnion,
        featRefs: checkedRefsIn("tcFeatureList"), areaRefs: checkedRefsIn("tcAreaList"),
        hiddenIncluded: hiddenIncluded
      };
      _runSnap = snap;
      _stale = false;

      renderResults(_lastResult);
      renderMapOverlay(_lastResult);
      showCoverageLegend();
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
    var hiddenNoteEl = document.getElementById("tcHiddenNote");
    if (hiddenNoteEl) hiddenNoteEl.textContent = (result && App.hiddenSelectionMessage(result.hiddenIncluded || 0).notes) || "";

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

    var footEl = document.getElementById("tcApportionFootnote");
    if (footEl) footEl.textContent = "Residents counted by " + Apportion.methodLabel(result.apportionMethodUsed) +
      "; jobs are counted by whole LODES block.";
    var distNoteEl = document.getElementById("tcDistanceNote");
    if (distNoteEl) {
      distNoteEl.textContent = result.distanceNote || "";
      distNoteEl.style.display = result.distanceNote ? "" : "none";
    }
    var distFootEl = document.getElementById("tcDistanceFootnote");
    if (distFootEl) {
      distFootEl.textContent = " Distance measured " + (result.distanceMode === "streets" ? "along streets" : "in a straight line") +
        (result.gtfsDate ? "; GTFS stops use a bus buffer of " + result.busMi + " mi and a rail buffer of " + result.railMi +
          " mi (analysis date " + isoDate(result.gtfsDate) + ")." : ".");
    }
    var apNoteEl = document.getElementById("tcApportionNote");
    if (apNoteEl) {
      apNoteEl.textContent = result.apportionNote || "";
      apNoteEl.style.display = result.apportionNote ? "" : "none";
    }

    var html = '<table class="cs-results-table tc-results-table">' +
      '<thead><tr>' +
        '<th>Row</th>' +
        '<th>Population</th>' +
        '<th>Pop %</th>' +
        '<th>Jobs</th>' +
        '<th>Jobs %</th>' +
      '</tr></thead><tbody>';

    html += buildResultsRow("Service area", result.popTotal, result.jobsTotal, result.popTotal, result.jobsTotal);
    // With GTFS stops the bus / rail distances are long; the footnote below names them.
    var dist = result.bufferLabel ? "stop buffers" : (result.bufferMiles + " mi");
    html += buildResultsRow(
      "Within " + dist + " of selected transit",
      result.popCovered, result.jobsCovered, result.popTotal, result.jobsTotal);
    if (hasThreshold) {
      html += buildResultsRow(
        "Within " + dist + " of ≤" + result.thresholdMin + "-min transit",
        result.popThreshold, result.jobsThreshold, result.popTotal, result.jobsTotal);
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    var statEl = document.getElementById("tcStatSentence");
    if (statEl) {
      statEl.textContent = buildStatSentence({
        bufferMiles:      result.bufferMiles,
        bufferLabel:      result.gtfsDate ? result.bufferLabel : null,
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
        if (r.coverageSource === "gtfs-stops") {
          return '<div class="tiny">' + escapeHTML(r.name) + ' [' + escapeHTML(r.mode || "bus") + '] (from ' + r.stopCount +
            ' stop' + (r.stopCount === 1 ? "" : "s") + '): ' + (r.peakHeadway != null ? r.peakHeadway + " min" : "—") + '</div>';
        }
        var headwayText = (r.peakHeadway != null) ? (r.peakHeadway + " min") : "no service";
        var meetsText = hasThreshold ? (r.qualifies ? " — meets threshold" : " — does not meet threshold") : "";
        var srcText = r.coverageSource === "stops" ? " (from " + r.stopCount + " stop" + (r.stopCount === 1 ? "" : "s") + ")"
                    : r.coverageSource === "line" ? " (from line)" : "";
        return '<div class="tiny">' + escapeHTML(r.name) + srcText + ': ' + headwayText + meetsText + '</div>';
      }).join("");
      var withSource = rows.filter(function (r) { return r.coverageSource === "stops" || r.coverageSource === "line"; });
      var gtfsRows = rows.length - withSource.length;
      var fromStops = withSource.filter(function (r) { return r.coverageSource === "stops"; }).length;
      var sourceNote = withSource.length
        ? '<p class="tiny u-mt-2">Coverage measured around stops for ' + fromStops + ' of ' + withSource.length +
          ' features; along the line for the rest.</p>'
        : "";
      var gtfsLine = gtfsRows
        ? '<p class="tiny u-mt-2">GTFS stops: ' + (result.gtfsStopCount || 0).toLocaleString() +
          (hasThreshold ? ' (' + (result.gtfsQualifyCount || 0).toLocaleString() + ' qualify at ≤ ' + result.thresholdMin + ' min peak headway)' : '') +
          '</p>'
        : "";
      headwayListEl.innerHTML = gtfsLine +
        '<details><summary>Peak headways (' + rows.length + ' feature' + (rows.length === 1 ? "" : "s") + ')</summary>' +
        itemsHtml +
        '</details>' + sourceNote;
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
    lines.push("# Coverage from: "         + (r.useDisplayBuffers ? "display buffers (coverage-from setting ignored)"
      : (r.coverageFrom === "stops" ? "stops when present, else along the line" : "along the whole line")));
    if (r.gtfsDate) {
      lines.push("# GTFS stop buffers (mi): bus " + r.busMi + ", rail " + r.railMi);
      lines.push("# Analysis date: " + isoDate(r.gtfsDate));
    }
    lines.push("# Distance measured: " + (r.distanceMode === "streets" ? "along streets" : "straight line"));
    if (r.distanceNote) lines.push("# " + r.distanceNote);
    lines.push("# Day type: "               + r.dayType);
    lines.push("# Headway threshold (min): " + (hasThreshold ? r.thresholdMin : ""));
    lines.push("# Residents counted by: " + Apportion.methodLabel(r.apportionMethodUsed));
    if (r.apportionNote) lines.push("# " + String(r.apportionNote).replace(/[\r\n]+/g, " "));

    lines.push("row,population,pop_pct,jobs,jobs_pct");
    lines.push(dataRow("Service area", r.popTotal, r.jobsTotal, r.popTotal, r.jobsTotal));
    var dist = r.bufferLabel || (r.bufferMiles + " mi");
    lines.push(dataRow("Within " + dist + " of selected transit",
      r.popCovered, r.jobsCovered, r.popTotal, r.jobsTotal));
    if (hasThreshold) {
      lines.push(dataRow("Within " + dist + " of ≤" + r.thresholdMin + "-min transit",
        r.popThreshold, r.jobsThreshold, r.popTotal, r.jobsTotal));
    }

    lines.push("");
    lines.push("feature,peak_headway_min,meets_threshold,coverage_source,stops_used");
    var headwayRows = r.headwayRows || [];
    for (var i = 0; i < headwayRows.length; i++) {
      var hr = headwayRows[i];
      lines.push([
        _csvField(hr.name),
        (hr.peakHeadway != null) ? hr.peakHeadway : "",
        hasThreshold && hr.coverageSource !== "gtfs-stops" ? (hr.qualifies ? "yes" : "no") : "",
        hr.coverageSource || "",
        hr.coverageSource ? hr.stopCount : ""
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
        distanceMeasured:    r.distanceMode === "streets" ? "along streets" : "straight line",
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

    var geoLevel = document.getElementById("tcGeoLevel");
    if (geoLevel) geoLevel.addEventListener("change", markStale);

    var yearSel = document.getElementById("tcYearSelect");
    if (yearSel) yearSel.addEventListener("change", markStale);

    var bufferInput = document.getElementById("tcBufferMiles");
    if (bufferInput) bufferInput.addEventListener("change", markStale);
    var displayBuffersInput = document.getElementById("tcUseDisplayBuffers");
    if (displayBuffersInput) displayBuffersInput.addEventListener("change", function () {
      _useDisplayBuffers = displayBuffersInput.checked;
      syncBufferControl();
      markStale();
    });
    var coverageFromSel = document.getElementById("tcCoverageFrom");
    if (coverageFromSel) coverageFromSel.addEventListener("change", function () {
      _coverageFrom = coverageFromSel.value === "stops" ? "stops" : "line";
      markStale();
    });
    var apportionSel = document.getElementById("tcApportionMethod");
    if (apportionSel) apportionSel.addEventListener("change", function () {
      _apportionMethod = apportionSel.value === "area" ? "area" : "blockPop";
      markStale();
    });
    var busInput = document.getElementById("tcBusBufferMi");
    if (busInput) busInput.addEventListener("change", function () {
      _busBufferMi = App.readAnalysisBufferMiles(busInput, 0.25);
      markStale();
    });
    var railInput = document.getElementById("tcRailBufferMi");
    if (railInput) railInput.addEventListener("change", function () {
      _railBufferMi = App.readAnalysisBufferMiles(railInput, 0.5);
      markStale();
    });
    var distanceSel = document.getElementById("tcDistanceMode");
    if (distanceSel) distanceSel.addEventListener("change", function () {
      _distanceMode = distanceSel.value === "streets" ? "streets" : "straight";
      markStale();
    });
    syncBufferControl();

    var dayTypeSel = document.getElementById("tcDayType");
    if (dayTypeSel) dayTypeSel.addEventListener("change", markStale);

    var thresholdInput = document.getElementById("tcHeadwayThreshold");
    if (thresholdInput) thresholdInput.addEventListener("change", markStale);

    // Include hidden toggle: one for both lists, beside the first list's Select all | Clear.
    var actionsEl = (document.getElementById("tcFeatSelectAll") || {}).parentNode;
    if (actionsEl && !document.getElementById("tcIncludeHidden")) {
      var toggleEl = App.buildIncludeHiddenToggle({
        id: "tcIncludeHidden", checked: _includeHidden,
        onChange: function (on) {
          _includeHidden = on;
          buildFeatureChecklist();           // re-decorate rows; checked states untouched
          buildAreaChecklist();
          buildGtfsChecklist();
          if (App.cache) App.cache.save();
          if (_lastResult && runIsOutdated()) markStale();
        }
      });
      toggleEl.title = "Applies to both the routes/lines and the service-area polygons.";
      actionsEl.appendChild(toggleEl);
    }

    var featSelectAll = document.getElementById("tcFeatSelectAll");
    if (featSelectAll) {
      featSelectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcFeatureList input[type=checkbox]").forEach(function (cb) { if (!cb.disabled) cb.checked = true; });
        captureChecklistSelection();
        markStale();
      });
    }
    var featSelectNone = document.getElementById("tcFeatSelectNone");
    if (featSelectNone) {
      featSelectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcFeatureList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        captureChecklistSelection();
        markStale();
      });
    }

    var areaSelectAll = document.getElementById("tcAreaSelectAll");
    if (areaSelectAll) {
      areaSelectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcAreaList input[type=checkbox]").forEach(function (cb) { if (!cb.disabled) cb.checked = true; });
        captureChecklistSelection();
        markStale();
      });
    }
    var areaSelectNone = document.getElementById("tcAreaSelectNone");
    if (areaSelectNone) {
      areaSelectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcAreaList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        captureChecklistSelection();
        markStale();
      });
    }

    var gtfsSelectAll = document.getElementById("tcGtfsSelectAll");
    if (gtfsSelectAll) {
      gtfsSelectAll.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcGtfsList input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
        captureGtfsSelection();
        markStale();
      });
    }
    var gtfsSelectNone = document.getElementById("tcGtfsSelectNone");
    if (gtfsSelectNone) {
      gtfsSelectNone.addEventListener("click", function (e) {
        e.preventDefault();
        document.querySelectorAll("#tcGtfsList input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
        captureGtfsSelection();
        markStale();
      });
    }

    // Feed, analysis date, hidden routes and day parts all change what the GTFS rows mean. Subscribed
    // here, not at load, because gtfs.js loads after this file.
    if (typeof App.gtfsOnInputsChange === "function") {
      App.gtfsOnInputsChange(function () {
        if (isPopupVisible()) { buildGtfsChecklist(); }
        if (_lastResult && !_stale && runIsOutdated()) markStale();
      });
    }

    var runBtn = document.getElementById("tcRunBtn");
    if (runBtn) runBtn.addEventListener("click", runCoverage);

    var csvBtn = document.getElementById("tcExportCSV");
    if (csvBtn) csvBtn.addEventListener("click", exportCSV);
    var gjBtn = document.getElementById("tcExportGeoJSON");
    if (gjBtn) gjBtn.addEventListener("click", exportGeoJSON);
  }

  function onOpen(core) {
    var ihEl = document.getElementById("tcIncludeHidden");
    if (ihEl) ihEl.checked = _includeHidden;
    buildFeatureChecklist();
    buildAreaChecklist();
    buildGtfsChecklist();
    syncBufferControl();
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
    // The map, GTFS feed or street network may have changed while the panel was closed.
    if (_lastResult && !_stale && runIsOutdated()) markStale();
    if (_stale) markStale();
  }

  function onClose(core) {
    // State persists in closure.
  }

  function clearAll() {
    clearMapOverlay();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("tc-legend");
    _lastResult = null;
    _runSnap = null;
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
    var noFeatures = (App.routes || []).length === 0 && (App.lines || []).length === 0 && !feedReady();
    var noAreas    = (App.polygons || []).length === 0;
    if (_lastResult && (noFeatures || noAreas)) {
      clearAll();
    }
    // notifyProject also fires on every hide/show: only go stale on a real change.
    if (_lastResult && !_stale && runIsOutdated()) markStale();
    if (!isPopupVisible()) return;
    buildFeatureChecklist();
    buildAreaChecklist();
    buildGtfsChecklist();
    updateLodesWarnings();
  }

  // ---- Session persistence ----

  function saveTcState(mode) {
    var settings = {
      bufferMiles:      null,
      useDisplayBuffers: _useDisplayBuffers,
      coverageFrom:     _coverageFrom,
      apportionMethod:  _apportionMethod,
      includeHidden:    _includeHidden,   // additive, no schema bump
      busBufferMi:      _busBufferMi,
      railBufferMi:     _railBufferMi,
      distanceMode:     _distanceMode,
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

    // Schema v3: selection by stable feature ID (v1 = checked array indices,
    // migrated in restoreTcState); v3 adds the GTFS route selection and stop-buffer settings, which a
    // v2 session lacks and loads as their defaults. _uncheckedRefs is kept current by the checkbox
    // handlers, so it is the live state even while the popup is open.
    var data = {
      version:     3,
      settings:    settings,
      uncheckedFeatures: _uncheckedRefs.filter(function (r) { return App.resolveFeatureRef(r) >= 0; }),
      gtfsUnchecked: _gtfsUnchecked.slice(),
      lastSummary: null
    };

    if (_lastResult) {
      data.lastSummary = {
        geoLevel:        _lastResult.geoLevel,
        year:            _lastResult.year,
        bufferMiles:     _lastResult.bufferMiles,
        useDisplayBuffers: _lastResult.useDisplayBuffers,
        coverageFrom:    _lastResult.coverageFrom,
        bufferLabel:     _lastResult.bufferLabel || null,
        busMi:           _lastResult.busMi,
        railMi:          _lastResult.railMi,
        distanceMode:    _lastResult.distanceMode || "straight",
        distanceNote:    _lastResult.distanceNote || null,
        gtfsDate:        _lastResult.gtfsDate || null,
        gtfsStopCount:   _lastResult.gtfsStopCount || 0,
        gtfsQualifyCount: _lastResult.gtfsQualifyCount || 0,
        apportionMethodUsed: _lastResult.apportionMethodUsed,
        apportionNote:   _lastResult.apportionNote || null,
        dayType:         _lastResult.dayType,
        thresholdMin:    _lastResult.thresholdMin,
        hiddenIncluded:  _lastResult.hiddenIncluded || 0,
        popTotal:        _lastResult.popTotal,
        popCovered:      _lastResult.popCovered,
        popThreshold:    _lastResult.popThreshold,
        jobsTotal:       _lastResult.jobsTotal,
        jobsCovered:     _lastResult.jobsCovered,
        jobsThreshold:   _lastResult.jobsThreshold,
        headwayRows:     (_lastResult.headwayRows || []).map(function (r) {
          return {
            name: r.name, featureType: r.featureType, featureId: r.featureId,
            peakHeadway: r.peakHeadway, qualifies: r.qualifies,
            coverageSource: r.coverageSource, stopCount: r.stopCount,
            routeId: r.routeId, mode: r.mode
          };
        })
      };
    }

    return data;
  }

  function restoreTcState(data) {
    if (!data) return;

    // v1 sessions saved CHECKED array indices (and per-row featureIndex). Features
    // are restored in saved order and given IDs before module hooks run, so an old
    // index still names the right feature RIGHT NOW — convert to IDs here.
    var legacy = !(data.version >= 2);
    if (legacy) {
      _uncheckedRefs = [];
      if (data.selections) {
        var sel = data.selections;
        _uncheckedRefs = App.uncheckedRefsFromIndexFilter({
          routeIndices: sel.routeIndices, lineIndices: sel.lineIndices, polygonIndices: sel.polygonIndices
        }, ["route", "line", "polygon"]);
      }
    } else {
      _uncheckedRefs = Array.isArray(data.uncheckedFeatures) ? data.uncheckedFeatures.filter(function (r) {
        return r && App.featureRefKey(r);
      }) : [];
    }
    if (document.getElementById("tcFeatureList")) { buildFeatureChecklist(); buildAreaChecklist(); }

    var settings = data.settings || {};

    // v3 fields; an older session lacks them and takes the defaults.
    _gtfsUnchecked = Array.isArray(data.gtfsUnchecked) ? data.gtfsUnchecked.filter(function (x) { return typeof x === "string"; }) : [];
    _busBufferMi   = settings.busBufferMi  > 0 ? settings.busBufferMi  : 0.25;
    _railBufferMi  = settings.railBufferMi > 0 ? settings.railBufferMi : 0.5;
    _distanceMode  = settings.distanceMode === "streets" ? "streets" : "straight";
    if (document.getElementById("tcGtfsList")) buildGtfsChecklist();

    var bufferEl    = document.getElementById("tcBufferMiles");
    var dayTypeEl   = document.getElementById("tcDayType");
    var thresholdEl = document.getElementById("tcHeadwayThreshold");
    var geoLevelEl  = document.getElementById("tcGeoLevel");
    var yearEl      = document.getElementById("tcYearSelect");

    if (bufferEl && Number.isFinite(settings.bufferMiles)) bufferEl.value = String(settings.bufferMiles);
    if (settings.useDisplayBuffers != null) _useDisplayBuffers = !!settings.useDisplayBuffers;
    _coverageFrom = settings.coverageFrom === "stops" ? "stops" : "line";   // old sessions measured along the line
    _apportionMethod = settings.apportionMethod === "blockPop" ? "blockPop" : "area";   // old sessions counted by land area
    if (typeof settings.includeHidden === "boolean") _includeHidden = settings.includeHidden;
    var ihRestoreEl = document.getElementById("tcIncludeHidden");
    if (ihRestoreEl) ihRestoreEl.checked = _includeHidden;
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
      coverageFrom:     s.coverageFrom === "stops" ? "stops" : "line",
      bufferLabel:      s.bufferLabel || null,
      busMi:            s.busMi > 0 ? s.busMi : 0.25,
      railMi:           s.railMi > 0 ? s.railMi : 0.5,
      distanceMode:     s.distanceMode === "streets" ? "streets" : "straight",
      distanceNote:     s.distanceNote || null,
      gtfsDate:         s.gtfsDate || null,
      gtfsStopCount:    s.gtfsStopCount || 0,
      gtfsQualifyCount: s.gtfsQualifyCount || 0,
      apportionMethodUsed: s.apportionMethodUsed === "blockPop" ? "blockPop" : "area",
      apportionNote:    s.apportionNote || null,
      dayType:          s.dayType,
      thresholdMin:     s.thresholdMin,
      hiddenIncluded:   s.hiddenIncluded || 0,
      popTotal:         s.popTotal,
      popCovered:       s.popCovered,
      popThreshold:     s.popThreshold,
      jobsTotal:        s.jobsTotal,
      jobsCovered:      s.jobsCovered,
      jobsThreshold:    s.jobsThreshold,
      headwayRows:      (s.headwayRows || []).map(function (r) {
        var row = Object.assign({}, r);
        if (legacy || !row.featureId) {
          var ref = App.featureRef(row.featureType, row.featureIndex);
          row.featureId = ref ? ref.id : null;
        }
        delete row.featureIndex;
        return row;
      }),
      // Geometry is not persisted — Re-run regenerates it.
      coverageClipped:  null,
      thresholdClipped: null,
      serviceAreaUnion: null,
      featRefs:         null,
      areaRefs:         null
    };
    _stale = false;
    // Baseline for update(): the live routes/lines/polygons now, minus what the user unchecked.
    var restoreRefs = [];
    [["route", App.routes], ["line", App.lines], ["polygon", App.polygons]].forEach(function (g) {
      (g[1] || []).forEach(function (f, i) {
        var ref = App.featureRef(g[0], i);
        if (ref && !isRefUnchecked(g[0], ref.id)) restoreRefs.push(ref);
      });
    });
    _runSnap = makeRunSnap(restoreRefs);
    _runSnap.gtfs = null;   // the feed restores on its own schedule; do not call that a change

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
    // One width for both modes, under the 620px @container breakpoint (narrow stacked panel,
    // never resizes on run); see the fuller note in buffer-summary.js.
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
