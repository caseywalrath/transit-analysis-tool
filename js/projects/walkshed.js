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

  var DEFAULT_SETTINGS = { minutes: 15, walkSpeedMph: 3.1, maxEdge: 0.3 };
  var MAX_MINUTES = 60;
  var KM_PER_MILE = 1.609344; // engine graph weights are in km; UI/attributes are in mph

  var _settings      = Object.assign({}, DEFAULT_SETTINGS);
  var _walkshedCache = new Map();  // pointIdx -> entry (see computeForPoint)
  var _lastEntries   = [];         // entries (+failures) from the last Compute run, for display
  var _showSegments  = true;
  var _stale         = false;
  var _running       = false;
  var _initialized   = false;

  // ---- Map layer ids ----

  var WS_FILL_SRC  = "walkshed-src";
  var WS_FILL_LAYER = "walkshed-fill";
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

  // Per-point walk parameters. Global module settings apply to every point; a
  // point may optionally carry attributes.walkMinutes / walkSpeedMph overrides
  // (data model supports it; the current UI only sets the type, not overrides).
  // `speed` is in mph — converted to km/h at the point of use (computeForPoint).
  function pointSettingsFor(pf) {
    var attrs = (pf.properties && pf.properties.attributes) || {};
    var minutes = (attrs.walkMinutes != null && +attrs.walkMinutes > 0) ? +attrs.walkMinutes : _settings.minutes;
    var speed   = (attrs.walkSpeedMph != null && +attrs.walkSpeedMph > 0) ? +attrs.walkSpeedMph : _settings.walkSpeedMph;
    return { minutes: Math.min(minutes, MAX_MINUTES), speed: speed, maxEdge: _settings.maxEdge };
  }

  // Cache key — a walkshed is a pure function of the origin coords, the walk
  // parameters, and the loaded network (roadNetworkEpoch bumps on (re)load/clear).
  function settingsKeyFor(pf) {
    var c = pf.geometry.coordinates;
    var s = pointSettingsFor(pf);
    var epoch = (typeof App.roadNetworkEpoch === "function") ? App.roadNetworkEpoch() : 0;
    return [c[0].toFixed(6), c[1].toFixed(6), s.minutes, s.speed, s.maxEdge, epoch].join("|");
  }

  // ---- Core compute (shared by the Compute button and ensurePointWalksheds) ----

  // Compute + cache a walkshed for one point. Returns the cache entry, or a
  // { failed:true, reason } sentinel. Reuses a valid cached entry when present.
  function computeForPoint(pf) {
    var pIdx = pf.properties.pointIdx;
    var key = settingsKeyFor(pf);
    var existing = _walkshedCache.get(pIdx);
    if (existing && existing.settingsKey === key && existing.polygon) return existing;

    var s = pointSettingsFor(pf);
    var budgetKm = (s.speed * KM_PER_MILE) * (s.minutes / 60); // s.speed is mph; engine works in km
    var res = App.computeWalkshed ? App.computeWalkshed(pf.geometry.coordinates, budgetKm, { maxEdge: s.maxEdge }) : null;

    if (!res || !res.polygon) {
      _walkshedCache.delete(pIdx);
      return {
        failed: true,
        pointIdx: pIdx,
        name: pf.properties.name,
        reason: res ? "no reachable area (sparse/disconnected network)" : "origin off-network (> 500 m from a road)"
      };
    }

    res.polygon.properties = res.polygon.properties || {};
    res.polygon.properties.pointIdx = pIdx;

    var entry = {
      polygon:           res.polygon,
      reachableSegments: res.reachableSegments,
      reachableCount:    res.reachableCount,
      area:              turf.area(res.polygon),   // m²
      computeMs:         res.computeMs,
      minutes:           s.minutes,
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

  function renderWalkshedLayers(entries) {
    var map = App.map;
    if (!map) return;
    var polyFeatures = [], segFeatures = [];
    entries.forEach(function (e) {
      if (!e || e.failed) return;
      if (e.polygon) {
        var pf = { type: "Feature", properties: { pointIdx: e.pointIdx, name: e.name, minutes: e.minutes }, geometry: e.polygon.geometry };
        polyFeatures.push(pf);
      }
      if (e.reachableSegments && e.reachableSegments.features) {
        segFeatures = segFeatures.concat(e.reachableSegments.features);
      }
    });
    var polyFc = { type: "FeatureCollection", features: polyFeatures };
    var segFc  = { type: "FeatureCollection", features: segFeatures };

    if (!map.getSource(WS_FILL_SRC)) {
      map.addSource(WS_FILL_SRC, { type: "geojson", data: polyFc });
      map.addLayer({
        id: WS_FILL_LAYER, type: "fill", source: WS_FILL_SRC,
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.14 }
      });
      map.addLayer({
        id: WS_LINE_LAYER, type: "line", source: WS_FILL_SRC,
        layout: { "line-join": "round" },
        paint: { "line-color": "#2563eb", "line-width": 2, "line-opacity": 0.9 }
      });
    } else {
      map.getSource(WS_FILL_SRC).setData(polyFc);
    }

    if (!map.getSource(WS_SEG_SRC)) {
      map.addSource(WS_SEG_SRC, { type: "geojson", data: segFc });
      map.addLayer({
        id: WS_SEG_LAYER, type: "line", source: WS_SEG_SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#16a34a", "line-width": 1.5, "line-opacity": 0.85 }
      });
    } else {
      map.getSource(WS_SEG_SRC).setData(segFc);
    }
    if (map.getLayer(WS_SEG_LAYER)) {
      map.setLayoutProperty(WS_SEG_LAYER, "visibility", _showSegments ? "visible" : "none");
    }
  }

  function clearWalkshedLayers() {
    var map = App.map;
    if (!map) return;
    [WS_SEG_LAYER, WS_LINE_LAYER, WS_FILL_LAYER].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    [WS_SEG_SRC, WS_FILL_SRC].forEach(function (id) { if (map.getSource(id)) map.removeSource(id); });
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
    return _settings.minutes + " min · " + _settings.walkSpeedMph + " mph · " +
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
          '</td><td colspan="3" class="ws-warn">skipped — ' + escapeHtml(e.reason) + '</td></tr>';
      } else {
        rows += "<tr><td>" + escapeHtml(e.name || ("Point " + e.pointIdx)) + "</td>" +
          "<td>" + (e.area * M2_TO_MI2).toFixed(3) + " mi&sup2;<span class='ws-sub'> / " + (e.area * M2_TO_KM2).toFixed(3) + " km&sup2;</span></td>" +
          "<td>" + e.reachableCount + "</td>" +
          "<td>" + e.computeMs + " ms</td></tr>";
      }
    });
    host.innerHTML =
      '<table class="ws-table"><thead><tr>' +
      "<th>Point</th><th>Walkshed area</th><th>Nodes</th><th>Time</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    renderConnectionReport();
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
    var budgetKm = _settings.walkSpeedMph * KM_PER_MILE * (_settings.minutes / 60);
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

        if (ok && App.popup && App.popup.showFloatingWidget) {
          App.popup.showFloatingWidget("ws-legend", "projects/walkshed-legend.html",
            { position: "bottom-left", width: 190, title: "Walkshed" });
        }

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
      if (e.failed || !e.polygon) return;
      features.push({
        type: "Feature",
        properties: { pointIdx: e.pointIdx, name: e.name, minutes: e.minutes, areaM2: e.area, reachableNodes: e.reachableCount },
        geometry: e.polygon.geometry
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
    var m = document.getElementById("wsMinutes");
    var s = document.getElementById("wsSpeed");
    var e = document.getElementById("wsMaxEdge");
    if (m && +m.value > 0) _settings.minutes = Math.min(+m.value, MAX_MINUTES);
    if (s && +s.value > 0) _settings.walkSpeedMph = +s.value;
    if (e && +e.value > 0) _settings.maxEdge = +e.value;
    if (App.cache && App.cache.save) App.cache.save();
  }

  function syncInputsFromSettings() {
    var m = document.getElementById("wsMinutes");
    var s = document.getElementById("wsSpeed");
    var e = document.getElementById("wsMaxEdge");
    var seg = document.getElementById("wsShowSegments");
    if (m) m.value = _settings.minutes;
    if (s) s.value = _settings.walkSpeedMph;
    if (e) e.value = _settings.maxEdge;
    if (seg) seg.checked = _showSegments;
    // Snap tolerance reads the GLOBAL App.networkSettings, not _settings — it's
    // shared with Transit Travelshed (docs/network-connectors-plan.md §2), so
    // this module never stores its own copy of the value.
    var tol = document.getElementById("wsSnapTol");
    if (tol && App.networkSettings) tol.value = App.networkSettings.snapToleranceFt;
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

    var seg = document.getElementById("wsShowSegments");
    if (seg) seg.addEventListener("change", function () {
      _showSegments = seg.checked;
      if (App.map && App.map.getLayer(WS_SEG_LAYER)) {
        App.map.setLayoutProperty(WS_SEG_LAYER, "visibility", _showSegments ? "visible" : "none");
      }
    });

    ["wsMinutes", "wsSpeed", "wsMaxEdge"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () { readSettingsFromInputs(); if (_lastEntries.length) markStale(); });
    });

    var snapEl = document.getElementById("wsSnapTol");
    if (snapEl) snapEl.addEventListener("change", onSnapTolChange);
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

  // ---- Session persistence (settings only; polygons recompute cheaply) ----

  function collect() {
    return {
      version: 2,
      minutes: _settings.minutes,
      walkSpeedMph: _settings.walkSpeedMph,
      maxEdge: _settings.maxEdge,
      showSegments: _showSegments
    };
  }

  function apply(data) {
    if (!data) return;
    if (+data.minutes > 0) _settings.minutes = Math.min(+data.minutes, MAX_MINUTES);
    if (+data.walkSpeedMph > 0) {
      _settings.walkSpeedMph = +data.walkSpeedMph;
    } else if (+data.walkSpeedKmh > 0) {
      // v1 schema migration: saved speed was km/h — convert to mph.
      _settings.walkSpeedMph = +data.walkSpeedKmh / KM_PER_MILE;
    }
    if (+data.maxEdge > 0) _settings.maxEdge = +data.maxEdge;
    if (typeof data.showSegments === "boolean") _showSegments = data.showSegments;
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
