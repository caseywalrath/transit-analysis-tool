// js/projects/zeb-feasibility.js
// Route Electrification Feasibility: registers as an analysis module, opens
// in a 2-column popup, digests a loaded GTFS feed into vehicle blocks and
// scores every route's most demanding block against a depot-only BEB
// charging scenario using the pure engine in js/core/zeb-model.js (window.ZEB)
// and the constants in data/zeb/zeb-demo-data.js (window.ZebDemoData).
// Depends on: App namespace, App.popup, App.choropleth, App.getGTFSData,
//   App.getGTFSShapesFC, App.zebOverlays (optional), window.ZEB, window.ZebDemoData,
//   turf (CDN, shape-length + fallback distance only).
// No public API.

(function () {
  "use strict";
  var App = window.App = window.App || {};
  var ZEB = window.ZEB;

  // ---- Module-local state ----

  var _settings = {
    agency: "all",
    route: "all",
    vehicleFilter: "all",
    vehicleAssume: "route",
    season: "winter",
    assumptions: defaultAssumptions(),
    overlays: { winter: false, di: false, utility: false }
  };

  var _prepared = null;        // digest of the loaded feed (see prepareFeed)
  var _preparedFeedRef = null; // App.getGTFSData() identity _prepared was built from
  var _preparedLayover = null; // blockChaining.maxLayoverMin _prepared was built with
  var _lastResult = null;      // { allRoutes, shownRoutes, vehicleClassesLocal }
  var _stale = false;
  var _running = false;
  var _initialized = false;

  var ZEB_SOURCE = "zeb-routes", ZEB_LAYER = "zeb-routes-layer";
  var ZEB_DEPOT_SOURCE = "zeb-depots", ZEB_DEPOT_LAYER = "zeb-depots-layer", ZEB_DEPOT_LABEL = "zeb-depots-label";
  var _hoverPopup = null;

  function defaultAssumptions() {
    var d = window.ZebDemoData;
    if (!d) return { bat40: 440, base40: 2.10, batCut: 150, baseCut: 1.15, chargerKW: 150, socBuffer: 20, layover: 30 };
    return {
      bat40:     d.vehicleClasses.bus40.batteryKWh,
      base40:    d.vehicleClasses.bus40.baseKWhPerMi,
      batCut:    d.vehicleClasses.cutaway.batteryKWh,
      baseCut:   d.vehicleClasses.cutaway.baseKWhPerMi,
      chargerKW: d.charger.kW,
      socBuffer: Math.round(d.socBuffer * 100),
      layover:   d.blockChaining.maxLayoverMin
    };
  }

  // ---- DOM guard ----

  function isPopupVisible() {
    return App.popup && App.popup.isOpen() && App.popup.currentModuleId() === "zeb-feasibility";
  }

  // ---- Status + stale helpers ----

  function setStatus(msg, kind) {
    App.renderModuleState({
      statusEl: "zebStatus",
      status: msg ? { kind: kind || "", message: msg } : null
    });
  }

  function markStale() {
    _stale = true;
    setExportButtonsEnabled(false);
    if (!isPopupVisible()) return;
    if (_lastResult) {
      App.renderModuleState({ statusEl: "zebStatus", stale: true, onRerun: runScoring });
    }
  }

  function renderEmptyState() {
    var emptyEl = document.getElementById("zebEmptyState");
    var hasFeed = !!_prepared;
    App.renderModuleState({
      statusEl: "zebStatus",
      emptyEl: "zebEmptyState",
      empty: true,
      hint: hasFeed
        ? { need: "Click Score Routes.", action: "Each route is graded by its most demanding vehicle block under depot-only charging." }
        : { need: "Load a GTFS feed to begin." }
    });
    if (!hasFeed && emptyEl) {
      var btnRow = document.createElement("div");
      btnRow.className = "btn-row u-mt-2";
      btnRow.innerHTML = '<button id="zebLoadDemoBtn" type="button" class="rf-action-primary">Load statewide GTFS database</button>';
      emptyEl.appendChild(btnRow);
      var stateAction = document.createElement("p");
      stateAction.className = "rf-state-action";
      stateAction.textContent = "or use Add Data (+) → GTFS Feed to load your own.";
      emptyEl.appendChild(stateAction);
      var loadBtn = document.getElementById("zebLoadDemoBtn");
      if (loadBtn) loadBtn.addEventListener("click", onLoadDemoClick);
    }
  }

  function onLoadDemoClick() {
    var btn = document.getElementById("zebLoadDemoBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    fetch("data/gtfs/colorado-demo-gtfs.zip")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) { return App.loadGTFSFile(blob); })
      .catch(function (err) {
        if (typeof App.setStatus === "function") {
          App.setStatus("Could not load the demo GTFS database: " + (err.message || err));
        }
        if (btn) { btn.disabled = false; btn.textContent = "Load statewide GTFS database"; }
      });
  }

  // ---- Collapsible inputs (shared helper) ----

  function inputsSummary() {
    var count = _lastResult && _lastResult.shownRoutes ? _lastResult.shownRoutes.length : 0;
    return _settings.season.charAt(0).toUpperCase() + _settings.season.slice(1) + " · " +
      (_settings.vehicleAssume === "route" ? "per-route vehicles" :
        (_settings.vehicleAssume === "bus40" ? "all 40-ft" : "all cutaway")) + " · " +
      count + " route" + (count === 1 ? "" : "s") + " shown";
  }

  function renderInputs(collapsed) {
    App.renderModuleInputs({
      hostEl: document.querySelector(".zeb-body .rf-settings-col"),
      collapsed: collapsed,
      summary: inputsSummary(),
      onToggle: function (isCollapsed) {
        if (!App.popup || !App.popup.setLayoutMode) return;
        App.popup.setLayoutMode(isCollapsed && _lastResult ? "results" : "setup", true);
      }
    });
  }

  // ---- Feed digest ----

  // trips.txt group-by-block/chain, per Step 5.3 of docs/zeb-feasibility-demo-plan.md.
  // The only turf use in this module: shape length + a straight-line stop-to-stop
  // fallback when a trip has no known shape_id.
  function prepareFeed(data, chainingOpts) {
    if (!data || !data.has("trips.txt") || !data.has("stop_times.txt") || !data.has("routes.txt")) {
      return null;
    }
    var ZebDemoData = window.ZebDemoData;

    var agencyRows = data.has("agency.txt") ? data.get("agency.txt").rows : [];
    var agencies = agencyRows.map(function (r) {
      return { agency_id: r.agency_id || "", agency_name: r.agency_name || "" };
    });

    // Shape miles + geometry lookup
    var shapeMiles = {};
    var shapeGeomById = {};
    var shapesFC = App.getGTFSShapesFC ? App.getGTFSShapesFC() : null;
    if (shapesFC) {
      shapesFC.features.forEach(function (f) {
        var sid = f.properties && f.properties.shape_id;
        if (!sid) return;
        shapeGeomById[sid] = f.geometry;
        try { shapeMiles[sid] = turf.length(f, { units: "miles" }); } catch (e) { /* malformed shape, fall through */ }
      });
    }

    // Stops
    var stopCoord = {};
    if (data.has("stops.txt")) {
      data.get("stops.txt").rows.forEach(function (r) {
        var lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
        if (r.stop_id && isFinite(lat) && isFinite(lon)) stopCoord[r.stop_id] = [lon, lat];
      });
    }

    // Route index
    var routeIndex = {};
    data.get("routes.txt").rows.forEach(function (r) {
      if (!r.route_id) return;
      routeIndex[r.route_id] = {
        route_id: r.route_id,
        short: r.route_short_name || "",
        long: r.route_long_name || "",
        agency_id: r.agency_id || "",
        color: r.route_color ? ("#" + r.route_color) : null,
        shapeIds: []
      };
    });
    if (agencies.length === 1) {
      Object.keys(routeIndex).forEach(function (rid) {
        if (!routeIndex[rid].agency_id) routeIndex[rid].agency_id = agencies[0].agency_id;
      });
    }

    // Per-trip digest from stop_times.txt, grouped by trip_id
    var stopTimesByTrip = {};
    data.get("stop_times.txt").rows.forEach(function (r) {
      var tid = r.trip_id;
      if (!tid) return;
      if (!stopTimesByTrip[tid]) stopTimesByTrip[tid] = [];
      stopTimesByTrip[tid].push(r);
    });

    var tripsById = {};
    data.get("trips.txt").rows.forEach(function (r) { if (r.trip_id) tripsById[r.trip_id] = r; });

    var digestedTrips = [];
    var shapeIdsSeen = {};
    Object.keys(stopTimesByTrip).forEach(function (tid) {
      var tripRow = tripsById[tid];
      if (!tripRow) return;
      var stRows = stopTimesByTrip[tid].slice().sort(function (a, b) {
        return parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10);
      });
      if (!stRows.length) return;

      var first = stRows[0], last = stRows[stRows.length - 1];
      var startMin = ZEB.parseGtfsTime(first.departure_time || first.arrival_time);
      var endMin = ZEB.parseGtfsTime(last.arrival_time || last.departure_time);
      if (startMin == null || endMin == null) return;

      var firstStop = stopCoord[first.stop_id] || null;
      var lastStop = stopCoord[last.stop_id] || null;

      var miles;
      if (tripRow.shape_id && shapeMiles[tripRow.shape_id] != null) {
        miles = shapeMiles[tripRow.shape_id];
      } else {
        miles = 0;
        for (var i = 1; i < stRows.length; i++) {
          var a = stopCoord[stRows[i - 1].stop_id], b = stopCoord[stRows[i].stop_id];
          if (a && b) { try { miles += turf.distance(a, b, { units: "miles" }); } catch (e) { /* skip leg */ } }
        }
      }

      var routeId = tripRow.route_id;
      digestedTrips.push({
        tripId: tid, routeId: routeId, serviceId: tripRow.service_id, blockId: tripRow.block_id,
        shapeId: tripRow.shape_id, startMin: startMin, endMin: endMin,
        firstStopId: first.stop_id, lastStopId: last.stop_id,
        firstStop: firstStop, lastStop: lastStop, miles: miles
      });

      if (routeId && routeIndex[routeId] && tripRow.shape_id) {
        var key = routeId + "|" + tripRow.shape_id;
        if (!shapeIdsSeen[key]) { shapeIdsSeen[key] = true; routeIndex[routeId].shapeIds.push(tripRow.shape_id); }
      }
    });

    // Group trips by agency (via route), pick a representative service, build blocks
    var tripsByAgency = {};
    digestedTrips.forEach(function (t) {
      var route = routeIndex[t.routeId];
      var aid = route ? route.agency_id : "";
      if (!tripsByAgency[aid]) tripsByAgency[aid] = [];
      tripsByAgency[aid].push(t);
    });

    var calendarRows = data.has("calendar.txt") ? data.get("calendar.txt").rows : [];
    var calendarDateRows = data.has("calendar_dates.txt") ? data.get("calendar_dates.txt").rows : [];

    var blocks = [];
    var methodsSeen = {};
    Object.keys(tripsByAgency).forEach(function (aid) {
      var agencyTrips = tripsByAgency[aid];
      var sel = ZEB.pickRepresentativeService(calendarRows, calendarDateRows, agencyTrips);
      var serviceTrips = agencyTrips.filter(function (t) { return t.serviceId === sel.serviceId; });
      var agencyBlocks = ZEB.buildBlocks(serviceTrips, chainingOpts);
      agencyBlocks.forEach(function (b) { b.agencyId = aid; methodsSeen[b.method] = true; });
      blocks = blocks.concat(agencyBlocks);
    });

    var methodLabel = Object.keys(methodsSeen).length === 1 ? Object.keys(methodsSeen)[0] :
      (Object.keys(methodsSeen).length > 1 ? "mixed" : "none");

    return {
      agencies: agencies,
      routes: routeIndex,
      blocks: blocks,
      shapeGeomById: shapeGeomById,
      method: methodLabel
    };
  }

  function ensurePrepared() {
    var data = App.getGTFSData ? App.getGTFSData() : null;
    if (!data) { _prepared = null; _preparedFeedRef = null; _preparedLayover = null; return null; }
    var layover = _settings.assumptions.layover;
    if (_prepared && _preparedFeedRef === data && _preparedLayover === layover) return _prepared;
    var d = window.ZebDemoData;
    _prepared = prepareFeed(data, {
      maxLayoverMin: layover,
      terminalToleranceMi: d ? d.blockChaining.terminalToleranceMi : 0.3
    });
    _preparedFeedRef = data;
    _preparedLayover = layover;
    return _prepared;
  }

  // ---- Filter dropdowns ----

  function agencyLabelFor(aid) {
    var d = window.ZebDemoData;
    return (d && d.agencies[aid] && d.agencies[aid].label) || aid;
  }

  function buildFilterDropdowns() {
    var agencySel = document.getElementById("zebAgency");
    if (!agencySel) return;
    var prevAgency = _settings.agency;

    agencySel.innerHTML = '<option value="all">All agencies</option>';
    (_prepared ? _prepared.agencies : []).forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.agency_id;
      opt.textContent = agencyLabelFor(a.agency_id) || a.agency_name || a.agency_id;
      agencySel.appendChild(opt);
    });
    var agencyStillValid = _prepared && _prepared.agencies.some(function (a) { return a.agency_id === prevAgency; });
    agencySel.value = agencyStillValid ? prevAgency : "all";
    _settings.agency = agencySel.value;

    rebuildRouteDropdown();
  }

  function rebuildRouteDropdown() {
    var routeSel = document.getElementById("zebRoute");
    if (!routeSel) return;
    var prevRoute = _settings.route;

    routeSel.innerHTML = '<option value="all">All routes</option>';
    if (_prepared) {
      Object.keys(_prepared.routes).forEach(function (rid) {
        var meta = _prepared.routes[rid];
        if (_settings.agency !== "all" && meta.agency_id !== _settings.agency) return;
        var opt = document.createElement("option");
        opt.value = rid;
        opt.textContent = meta.short || meta.long || rid;
        routeSel.appendChild(opt);
      });
    }
    var stillValid = Array.prototype.some.call(routeSel.options, function (o) { return o.value === prevRoute; });
    routeSel.value = stillValid ? prevRoute : "all";
    _settings.route = routeSel.value;
  }

  // ---- Settings <-> DOM sync ----

  function valOf(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value : fallback;
  }
  function numOf(id, fallback) {
    var el = document.getElementById(id);
    var v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : fallback;
  }

  function readSettingsFromDOM() {
    _settings.agency = valOf("zebAgency", _settings.agency);
    _settings.route = valOf("zebRoute", _settings.route);
    _settings.vehicleFilter = valOf("zebVehicleFilter", _settings.vehicleFilter);
    _settings.vehicleAssume = valOf("zebVehicleAssume", _settings.vehicleAssume);
    _settings.season = valOf("zebSeason", _settings.season);
    var a = _settings.assumptions;
    a.bat40     = numOf("zebBat40", a.bat40);
    a.base40    = numOf("zebBase40", a.base40);
    a.batCut    = numOf("zebBatCut", a.batCut);
    a.baseCut   = numOf("zebBaseCut", a.baseCut);
    a.chargerKW = numOf("zebChargerKW", a.chargerKW);
    a.socBuffer = numOf("zebSocBuffer", a.socBuffer);
    a.layover   = numOf("zebLayover", a.layover);
  }

  function syncControlsFromSettings() {
    var els = {
      zebVehicleFilter: _settings.vehicleFilter,
      zebVehicleAssume: _settings.vehicleAssume,
      zebSeason: _settings.season
    };
    Object.keys(els).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = els[id];
    });
    syncAssumptionInputs();
  }

  function syncAssumptionInputs() {
    var a = _settings.assumptions;
    var map = {
      zebBat40: a.bat40, zebBase40: a.base40, zebBatCut: a.batCut, zebBaseCut: a.baseCut,
      zebChargerKW: a.chargerKW, zebSocBuffer: a.socBuffer, zebLayover: a.layover
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = String(map[id]);
    });
  }

  function syncOverlayCheckboxes() {
    var winter = document.getElementById("zebOvWinter");
    var di = document.getElementById("zebOvDI");
    var utility = document.getElementById("zebOvUtility");
    if (winter) winter.checked = App.zebOverlays ? App.zebOverlays.isActive("winter") : false;
    if (di) di.checked = App.zebOverlays ? App.zebOverlays.isActive("di") : false;
    if (utility) utility.checked = App.zebOverlays ? App.zebOverlays.isActive("utility") : false;
  }

  // Called by zeb-overlays.js after its own Add Data dropdown buttons toggle
  // an overlay, so the checkbox in an already-open popup follows the button
  // (the reverse direction — checkbox click -> button — is handled inline by
  // wireOverlayCheckbox() below, since that's a direct DOM event on this
  // popup's own control). A no-op while the popup is closed; onOpen() already
  // re-syncs from current state on every open.
  App.zebSyncOverlayCheckboxes = function () {
    if (isPopupVisible()) syncOverlayCheckboxes();
  };

  // ---- Scoring flow ----

  function onControlChange() {
    readSettingsFromDOM();
    if (_lastResult) runScoring();
  }

  function filterAndSort(allRoutes) {
    return allRoutes.filter(function (r) {
      if (_settings.agency !== "all" && r.agencyId !== _settings.agency) return false;
      if (_settings.route !== "all" && r.routeId !== _settings.route) return false;
      if (_settings.vehicleFilter !== "all" && r.vehicleClassId !== _settings.vehicleFilter) return false;
      return true;
    }).sort(function (a, b) {
      var av = Number.isFinite(a.ratio) ? a.ratio : Infinity;
      var bv = Number.isFinite(b.ratio) ? b.ratio : Infinity;
      return av - bv;
    });
  }

  function runScoring() {
    if (_running) return;
    _running = true;
    try {
      readSettingsFromDOM();
      var prepared = ensurePrepared();
      if (!prepared) {
        setStatus("Load a GTFS feed first.", "error");
        return;
      }

      var ZebDemoData = window.ZebDemoData;
      var assumptions = _settings.assumptions;
      var vehicleClassesLocal = {
        bus40:   { id: "bus40",   label: ZebDemoData.vehicleClasses.bus40.label,   batteryKWh: assumptions.bat40,  baseKWhPerMi: assumptions.base40 },
        cutaway: { id: "cutaway", label: ZebDemoData.vehicleClasses.cutaway.label, batteryKWh: assumptions.batCut, baseKWhPerMi: assumptions.baseCut }
      };

      var blocksByRoute = {};
      prepared.blocks.forEach(function (block) {
        var agency = ZebDemoData.agencies[block.agencyId];
        if (!agency) return;
        var firstRouteId = block.routeIds[0];
        var override = ZebDemoData.routeOverrides[firstRouteId] || {};

        var vehicleClassId = _settings.vehicleAssume === "route"
          ? (override.vehicleClass || agency.defaultVehicleClass)
          : _settings.vehicleAssume;
        var vehicle = vehicleClassesLocal[vehicleClassId] || vehicleClassesLocal.bus40;

        var gradeClassId = override.gradeClass || agency.gradeClass;
        var gradeFactor = (ZebDemoData.gradeClasses[gradeClassId] || { factor: 1 }).factor;
        var seasonFactor = (ZebDemoData.climateZones[agency.climateZone] || { factors: {} }).factors[_settings.season];
        if (typeof seasonFactor !== "number") seasonFactor = 1;

        var deadhead = ZEB.deadheadMiles(agency.depot.coords, block, ZebDemoData.deadheadCircuity);
        var energy = ZEB.energyForBlock(block, {
          vehicle: vehicle, gradeFactor: gradeFactor, seasonFactor: seasonFactor,
          socBuffer: assumptions.socBuffer / 100, chargerKW: assumptions.chargerKW,
          chargerEff: ZebDemoData.charger.efficiency, deadheadMiles: deadhead
        });
        var tier = ZEB.tierFor(energy.ratio, energy.rechargeFits, ZebDemoData.tiers);

        var br = { block: block, energy: energy, tier: tier, agencyId: block.agencyId, vehicleClassId: vehicleClassId };
        block.routeIds.forEach(function (rid) {
          if (!blocksByRoute[rid]) blocksByRoute[rid] = [];
          blocksByRoute[rid].push(br);
        });
      });

      var routeSummaries = [];
      Object.keys(blocksByRoute).forEach(function (rid) {
        var brs = blocksByRoute[rid];
        var summary = ZEB.summarizeRoute(rid, brs);
        var meta = prepared.routes[rid];
        summary.name = meta ? (meta.short || meta.long || rid) : rid;
        summary.longName = meta ? meta.long : "";
        summary.agencyId = meta ? meta.agency_id : ((brs[0] && brs[0].agencyId) || "");
        summary.agencyLabel = agencyLabelFor(summary.agencyId);
        summary.vehicleClassId = brs[0] ? brs[0].vehicleClassId : null;
        summary.vehicleLabel = vehicleClassesLocal[summary.vehicleClassId] ? vehicleClassesLocal[summary.vehicleClassId].label : "";
        summary.batteryKWh = vehicleClassesLocal[summary.vehicleClassId] ? vehicleClassesLocal[summary.vehicleClassId].batteryKWh : null;
        summary.blocks = brs;
        routeSummaries.push(summary);
      });

      _lastResult = { allRoutes: routeSummaries, shownRoutes: [], vehicleClassesLocal: vehicleClassesLocal };
      _stale = false;
      finishRender();
    } catch (err) {
      console.error("ZEB Feasibility scoring error:", err);
      setStatus("Error: " + (err.message || err), "error");
    } finally {
      _running = false;
    }
  }

  function finishRender() {
    var shown = filterAndSort(_lastResult.allRoutes);
    _lastResult.shownRoutes = shown;

    renderResultsTable(shown);
    renderSummaryStrip(shown);
    renderFeedBar();
    renderMapRoutes(shown);
    renderDepots(shown);
    showLegend();
    setExportButtonsEnabled(shown.length > 0);
    renderInputs(true);
    if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");

    var hideRow = document.getElementById("zebHideRow");
    if (hideRow) hideRow.style.display = "";

    var total = _lastResult.allRoutes.length;
    setStatus("Scored " + total + " route" + (total === 1 ? "" : "s") +
      " — " + shown.length + " shown.", "done");
  }

  // ---- Feed bar / summary strip ----

  function renderFeedBar() {
    var el = document.getElementById("zebFeedBar");
    if (!el) return;
    if (!_prepared) { el.style.display = "none"; el.textContent = ""; return; }
    var data = App.getGTFSData ? App.getGTFSData() : null;
    var feedName = "GTFS feed";
    var version = "";
    if (data && data.has("feed_info.txt") && data.get("feed_info.txt").rows.length) {
      var fi = data.get("feed_info.txt").rows[0];
      feedName = fi.feed_publisher_name || feedName;
      version = fi.feed_version || "";
    }
    var routeCount = Object.keys(_prepared.routes).length;
    var agencyCount = _prepared.agencies.length;
    el.textContent = feedName + " · " + agencyCount + " agenc" + (agencyCount === 1 ? "y" : "ies") +
      " · " + routeCount + " route" + (routeCount === 1 ? "" : "s") +
      (version ? " · feed version " + version : "") +
      " · blocks: " + _prepared.method;
    el.style.display = "";
  }

  function renderSummaryStrip(shown) {
    var el = document.getElementById("zebSummaryStrip");
    if (!el) return;
    var ZebDemoData = window.ZebDemoData;
    var counts = {};
    ZebDemoData.tiers.forEach(function (t) { counts[t.tier] = 0; });
    shown.forEach(function (r) { if (r.tier != null && counts[r.tier] != null) counts[r.tier]++; });

    var html = "";
    ZebDemoData.tiers.forEach(function (t) {
      html += '<div class="zeb-tile" style="border-left-color:' + t.color + ';">' +
        '<div class="zeb-tile-count" style="color:' + t.color + ';">' + counts[t.tier] + '</div>' +
        '<div class="zeb-tile-label tiny">Tier ' + t.tier + '</div></div>';
    });
    el.innerHTML = html;
  }

  // ---- Results table ----

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtHHMM(min) {
    var m = ((Math.round(min) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function tierMetaFor(tierNum) {
    var ZebDemoData = window.ZebDemoData;
    for (var i = 0; i < ZebDemoData.tiers.length; i++) {
      if (ZebDemoData.tiers[i].tier === tierNum) return ZebDemoData.tiers[i];
    }
    return null;
  }

  function rationaleSentence(br) {
    var block = br.block, energy = br.energy, tier = br.tier;
    var score = ZEB.scoreFor(energy.ratio);
    return (tier.reason || "") + " Governing block " + block.blockId + ": " +
      block.revenueMiles.toFixed(0) + " revenue mi + " + energy.deadheadMiles.total.toFixed(0) + " mi deadhead × " +
      energy.vehicle.baseKWhPerMi.toFixed(2) + " kWh/mi × " + energy.gradeFactor.toFixed(2) + " grade × " +
      energy.seasonFactor.toFixed(2) + " " + _settings.season + " = " + Math.round(energy.blockKWh) + " kWh; required " +
      Math.round(energy.requiredKWh) + " kWh vs " + Math.round(energy.vehicle.batteryKWh) + " kWh available (ratio " +
      energy.ratio.toFixed(2) + "). Score " + score + "/100.";
  }

  function buildRouteDetailHTML(r) {
    var governing = (r.blocks || []).filter(function (b) { return b.block.blockId === r.governingBlockId; })[0];
    var html = '<div class="cs-details-body zeb-route-detail">';
    if (governing) {
      html += "<p>" + escapeHTML(rationaleSentence(governing)) + "</p>";
      html += '<p class="tiny">Recharge at ' + governing.energy.chargerKW + " kW: " +
        governing.energy.rechargeHours.toFixed(1) + " h of " + governing.energy.overnightHours.toFixed(1) + " h available.</p>";
    }
    html += '<table class="zeb-blocks-table"><thead><tr>' +
      "<th>Block</th><th>Trips</th><th>Span</th><th>Miles</th><th>kWh</th><th>Ratio</th><th>Tier</th><th></th>" +
      "</tr></thead><tbody>";
    (r.blocks || []).slice().sort(function (a, b) { return a.block.startMin - b.block.startMin; }).forEach(function (br) {
      html += "<tr>" +
        "<td>" + escapeHTML(br.block.blockId) + "</td>" +
        "<td>" + br.block.tripIds.length + "</td>" +
        "<td>" + fmtHHMM(br.block.startMin) + "–" + fmtHHMM(br.block.endMin) + "</td>" +
        "<td>" + br.block.revenueMiles.toFixed(1) + "</td>" +
        "<td>" + Math.round(br.energy.blockKWh) + "</td>" +
        "<td>" + br.energy.ratio.toFixed(2) + "</td>" +
        "<td>" + escapeHTML(br.tier.label || "") + "</td>" +
        '<td><button type="button" class="rf-btn-sm" data-soc-block="' + escapeHTML(br.block.blockId) +
          '" data-soc-route="' + escapeHTML(r.routeId) + '">View SoC</button></td>' +
        "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function renderResultsTable(shown) {
    var container = document.getElementById("zebResultsTable");
    var resultsWrap = document.getElementById("zebResults");
    if (!container || !resultsWrap) return;

    if (!shown.length) {
      resultsWrap.style.display = "none";
      container.innerHTML = "";
      App.renderModuleState({
        statusEl: "zebStatus", emptyEl: "zebEmptyState", empty: true,
        hint: { need: "No routes match the current filters.", action: "Clear the Agency / Route / Vehicle class filters to see all routes." }
      });
      return;
    }
    var emptyEl = document.getElementById("zebEmptyState");
    if (emptyEl) emptyEl.style.display = "none";
    resultsWrap.style.display = "";

    var html = '<table class="zeb-results-table"><thead><tr>' +
      '<th class="zeb-col-route">Route</th>' +
      "<th>Class</th>" +
      "<th>Blocks</th>" +
      "<th>Worst block mi</th>" +
      "<th>Block kWh</th>" +
      "<th>Req. kWh</th>" +
      "<th>Tier</th>" +
      '<th class="zeb-toggle" aria-label="Expand"></th>' +
      "</tr></thead><tbody>";

    shown.forEach(function (r, i) {
      var tierMeta = tierMetaFor(r.tier);
      var pillStyle = tierMeta ? ("background:" + tierMeta.color + ";color:#fff;") : "";
      html += '<tr class="zeb-row" data-index="' + i + '">' +
          '<td class="zeb-name">' + escapeHTML(r.name) +
            (r.longName ? '<div class="tiny u-muted">' + escapeHTML(r.longName) + "</div>" : "") +
            ' <span class="cs-feature-badge">' + escapeHTML(r.agencyLabel || "") + "</span></td>" +
          "<td>" + escapeHTML(r.vehicleLabel || "") + "</td>" +
          "<td>" + (r.blockCount != null ? r.blockCount : "—") + "</td>" +
          "<td>" + (Number.isFinite(r.revenueMiles) ? r.revenueMiles.toFixed(1) : "—") + "</td>" +
          "<td>" + (Number.isFinite(r.blockKWh) ? Math.round(r.blockKWh) : "—") + "</td>" +
          "<td>" + (Number.isFinite(r.requiredKWh) ? Math.round(r.requiredKWh) : "—") + "</td>" +
          '<td><span class="zeb-pill zeb-tier-' + (r.tier != null ? r.tier : "na") + '" style="' + pillStyle + '">' +
            (tierMeta ? escapeHTML(tierMeta.label) : "N/A") + "</span></td>" +
          '<td class="zeb-toggle"><span class="cs-caret">&#9656;</span></td>' +
        "</tr>" +
        '<tr class="zeb-row-details cs-row-details" data-index="' + i + '" style="display:none;"><td colspan="8">' +
          buildRouteDetailHTML(r) +
        "</td></tr>";
    });
    html += "</tbody></table>";
    container.innerHTML = html;

    var rowEls = container.querySelectorAll("tr.zeb-row");
    rowEls.forEach(function (rowEl) {
      rowEl.addEventListener("click", function (e) {
        if (e.target.closest("button")) return;
        var idx = rowEl.getAttribute("data-index");
        var details = container.querySelector('tr.zeb-row-details[data-index="' + idx + '"]');
        if (!details) return;
        var open = details.style.display !== "none";
        details.style.display = open ? "none" : "";
        rowEl.classList.toggle("cs-row-open", !open);
      });
    });

    container.querySelectorAll("[data-soc-block]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var blockId = btn.getAttribute("data-soc-block");
        var routeId = btn.getAttribute("data-soc-route");
        var r = shown.filter(function (x) { return x.routeId === routeId; })[0];
        if (!r) return;
        var br = (r.blocks || []).filter(function (b) { return b.block.blockId === blockId; })[0];
        if (br) openBlockDetail(br, btn);
      });
    });
  }

  // ---- Block Detail: inline SoC chart ----

  // Builds a 300x170 no-library SVG state-of-charge curve for one block from
  // ZEB.socProfile(). x axis: minutes from first to last point, ticked every
  // 3 hours; y axis: 0-100% SoC (extended below 0 only if the block actually
  // drains past empty, so an infeasible block's dive below the axis is still
  // visible instead of clipped).
  function buildSocChartSVG(br) {
    var block = br.block, energy = br.energy;
    var points = ZEB.socProfile(block, energy, { vehicle: energy.vehicle });
    if (!points.length) return "";

    var W = 300, H = 170;
    var marginLeft = 38, marginRight = 10, marginTop = 12, marginBottom = 26;
    var plotW = W - marginLeft - marginRight;
    var plotH = H - marginTop - marginBottom;

    var firstMin = points[0].min;
    var lastMin = points[points.length - 1].min;
    var totalMin = Math.max(1, lastMin - firstMin);

    var bufferPct = (energy.socBuffer || 0) * 100;
    var minPct = bufferPct;
    points.forEach(function (p) { minPct = Math.min(minPct, p.soc * 100); });
    var yDomainMin = minPct < 0 ? Math.floor(minPct / 10) * 10 : 0;
    var yDomainMax = 100;
    var yRange = (yDomainMax - yDomainMin) || 1;

    function xAt(min) { return marginLeft + (min - firstMin) / totalMin * plotW; }
    function yAt(pct) { return marginTop + (yDomainMax - pct) / yRange * plotH; }

    var chartBottom = marginTop + plotH;
    var baselineY = yAt(0);
    var bufferY = yAt(bufferPct);

    var polyPts = points.map(function (p) {
      return xAt(p.min).toFixed(1) + "," + yAt(p.soc * 100).toFixed(1);
    }).join(" ");
    var areaPts = polyPts + " " + xAt(lastMin).toFixed(1) + "," + baselineY.toFixed(1) +
      " " + xAt(firstMin).toFixed(1) + "," + baselineY.toFixed(1);

    // First downward crossing of the buffer line, linearly interpolated.
    var crossing = null;
    for (var i = 1; i < points.length && !crossing; i++) {
      var pct1 = points[i - 1].soc * 100, pct2 = points[i].soc * 100;
      if (pct1 >= bufferPct && pct2 < bufferPct) {
        var t = (bufferPct - pct1) / (pct2 - pct1);
        var crossMin = points[i - 1].min + t * (points[i].min - points[i - 1].min);
        crossing = { min: crossMin, x: xAt(crossMin), y: bufferY };
      }
    }

    var ticks = [];
    for (var tm = Math.ceil(firstMin / 180) * 180; tm <= lastMin; tm += 180) ticks.push(tm);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" class="zeb-soc-chart" role="img" aria-label="State of charge over the block">';

    svg += '<rect x="' + marginLeft + '" y="' + bufferY.toFixed(1) + '" width="' + plotW +
      '" height="' + Math.max(0, chartBottom - bufferY).toFixed(1) +
      '" fill="#d73027" fill-opacity="0.08"></rect>';

    [0, 50, 100].forEach(function (pct) {
      if (pct < yDomainMin || pct > yDomainMax) return;
      var y = yAt(pct);
      svg += '<line x1="' + marginLeft + '" y1="' + y.toFixed(1) + '" x2="' + (marginLeft + plotW) +
        '" y2="' + y.toFixed(1) + '" stroke="var(--border)" stroke-width="1"></line>';
      svg += '<text x="' + (marginLeft - 6) + '" y="' + (y + 3).toFixed(1) +
        '" text-anchor="end" class="zeb-soc-axis-label">' + pct + "%</text>";
    });

    svg += '<polygon points="' + areaPts + '" fill="var(--accent)" fill-opacity="0.15"></polygon>';

    svg += '<line x1="' + marginLeft + '" y1="' + bufferY.toFixed(1) + '" x2="' + (marginLeft + plotW) +
      '" y2="' + bufferY.toFixed(1) + '" stroke="#d73027" stroke-width="1.5" stroke-dasharray="4,3"></line>';
    svg += '<text x="' + (marginLeft + plotW - 4) + '" y="' + (bufferY - 4).toFixed(1) +
      '" text-anchor="end" class="zeb-soc-buffer-label">' + Math.round(bufferPct) + "% safety buffer</text>";

    svg += '<polyline points="' + polyPts + '" fill="none" stroke="var(--accent)" stroke-width="2"></polyline>';

    ticks.forEach(function (tmv) {
      var x = xAt(tmv);
      svg += '<line x1="' + x.toFixed(1) + '" y1="' + chartBottom + '" x2="' + x.toFixed(1) +
        '" y2="' + (chartBottom + 4) + '" stroke="var(--muted)" stroke-width="1"></line>';
      svg += '<text x="' + x.toFixed(1) + '" y="' + (chartBottom + 15) +
        '" text-anchor="middle" class="zeb-soc-axis-label">' + fmtHHMM(tmv) + "</text>";
    });
    svg += '<line x1="' + marginLeft + '" y1="' + chartBottom + '" x2="' + (marginLeft + plotW) +
      '" y2="' + chartBottom + '" stroke="var(--border)" stroke-width="1"></line>';

    if (crossing) {
      var labelAnchor = (crossing.x + 90 > marginLeft + plotW) ? "end" : "start";
      var labelX = labelAnchor === "end" ? crossing.x - 6 : crossing.x + 6;
      svg += '<circle cx="' + crossing.x.toFixed(1) + '" cy="' + crossing.y.toFixed(1) +
        '" r="3.5" fill="#d73027"></circle>';
      svg += '<text x="' + labelX.toFixed(1) + '" y="' + Math.max(marginTop + 8, crossing.y - 8).toFixed(1) +
        '" text-anchor="' + labelAnchor + '" class="zeb-soc-crossing-label">Below buffer at ' +
        fmtHHMM(crossing.min) + "</text>";
    }

    svg += "</svg>";
    return svg;
  }

  function openBlockDetail(br, anchor) {
    var block = br.block, energy = br.energy, tier = br.tier;
    var tierMeta = tierMetaFor(tier.tier);

    var wrap = document.createElement("div");
    wrap.className = "zeb-soc-popup";

    var chartHTML = buildSocChartSVG(br);
    if (chartHTML) {
      var chartWrap = document.createElement("div");
      chartWrap.className = "zeb-soc-chart-wrap";
      chartWrap.innerHTML = chartHTML;
      wrap.appendChild(chartWrap);
    }

    var summary = document.createElement("div");
    summary.className = "zeb-soc-summary";
    summary.innerHTML =
      '<div class="zeb-soc-summary-col"><div class="tiny u-muted">Block kWh</div><div>' + Math.round(energy.blockKWh) + "</div></div>" +
      '<div class="zeb-soc-summary-col"><div class="tiny u-muted">Required kWh</div><div>' + Math.round(energy.requiredKWh) + "</div></div>" +
      '<div class="zeb-soc-summary-col"><div class="tiny u-muted">Available kWh</div><div>' + Math.round(energy.vehicle.batteryKWh) + "</div></div>";
    wrap.appendChild(summary);

    var pillRow = document.createElement("div");
    pillRow.className = "u-mt-2";
    pillRow.innerHTML = '<span class="zeb-pill" style="background:' + (tierMeta ? tierMeta.color : "#999") +
      ';color:#fff;">' + escapeHTML(tier.label || "") + "</span>";
    wrap.appendChild(pillRow);

    App.openMiniPopup({
      title: "Block " + block.blockId + " — state of charge",
      content: wrap,
      anchor: anchor,
      onClose: function () {}
    });
  }

  // ---- Map ----

  function zebFirstUserLayer() {
    var map = App.map;
    var candidates = ["points-layer", "lines-layer", "routes-layer", "polygons-fill"];
    for (var i = 0; i < candidates.length; i++) {
      if (map.getLayer(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  function ensureHoverPopup() {
    if (!_hoverPopup) _hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "280px" });
    return _hoverPopup;
  }

  function tierColorExpr() {
    var ZebDemoData = window.ZebDemoData;
    var colors = ZebDemoData.tiers.map(function (t) { return t.color; });
    return App.choropleth.buildStepColorExpr("tier", [1.5, 2.5, 3.5, 4.5], colors, "rgba(160,160,160,0.6)");
  }

  function buildRoutesFC(shown) {
    var features = [];
    shown.forEach(function (r) {
      var meta = _prepared.routes[r.routeId];
      if (!meta) return;
      var tierMeta = tierMetaFor(r.tier);
      meta.shapeIds.forEach(function (sid) {
        var geom = _prepared.shapeGeomById[sid];
        if (!geom) return;
        features.push({
          type: "Feature", geometry: geom,
          properties: {
            route_id: r.routeId, name: r.name, agency: r.agencyLabel, vehicle: r.vehicleLabel,
            tier: r.tier, tierLabel: tierMeta ? tierMeta.label : "", score: r.score,
            blockKWh: Number.isFinite(r.blockKWh) ? Math.round(r.blockKWh) : null,
            requiredKWh: Number.isFinite(r.requiredKWh) ? Math.round(r.requiredKWh) : null,
            battery: r.batteryKWh || null
          }
        });
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  function renderMapRoutes(shown) {
    var map = App.map;
    if (!map || !_prepared) return;
    var fc = buildRoutesFC(shown);

    if (!map.getSource(ZEB_SOURCE)) {
      if (map.getLayer("gtfs-shapes-layer")) map.setLayoutProperty("gtfs-shapes-layer", "visibility", "none");
      var before = zebFirstUserLayer();
      map.addSource(ZEB_SOURCE, { type: "geojson", data: fc });
      map.addLayer({
        id: ZEB_LAYER, type: "line", source: ZEB_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": tierColorExpr(), "line-width": 4, "line-opacity": 0.95 }
      }, before);

      var popup = ensureHoverPopup();
      map.on("mousemove", ZEB_LAYER, function (e) {
        map.getCanvas().style.cursor = "pointer";
        if (!e.features || !e.features.length) return;
        var p = e.features[0].properties;
        var html = '<div style="font-size:12px;line-height:1.4;">' +
          "<b>" + escapeHTML(p.name) + "</b> (" + escapeHTML(p.agency || "") + ")<br>" +
          escapeHTML(p.vehicle || "") + "<br>" +
          "<b>Tier " + p.tier + " — " + escapeHTML(p.tierLabel || "") + " (score " + p.score + ")</b><br>" +
          "Worst block " + p.blockKWh + " kWh · requires " + p.requiredKWh + " kWh of " + p.battery +
          "</div>";
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on("mouseleave", ZEB_LAYER, function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
        popup.remove();
      });
    } else {
      map.getSource(ZEB_SOURCE).setData(fc);
    }
  }

  function buildDepotsFC(shown) {
    var ZebDemoData = window.ZebDemoData;
    var aids = {};
    shown.forEach(function (r) { if (r.agencyId) aids[r.agencyId] = true; });
    var features = [];
    Object.keys(aids).forEach(function (aid) {
      var agency = ZebDemoData.agencies[aid];
      if (!agency || !agency.depot) return;
      features.push({
        type: "Feature", geometry: { type: "Point", coordinates: agency.depot.coords },
        properties: { name: agency.depot.name, chargerKW: ZebDemoData.charger.kW }
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  function renderDepots(shown) {
    var map = App.map;
    if (!map) return;
    var fc = buildDepotsFC(shown);

    if (!map.getSource(ZEB_DEPOT_SOURCE)) {
      var before = zebFirstUserLayer();
      map.addSource(ZEB_DEPOT_SOURCE, { type: "geojson", data: fc });
      map.addLayer({
        id: ZEB_DEPOT_LAYER, type: "circle", source: ZEB_DEPOT_SOURCE,
        paint: { "circle-radius": 7, "circle-color": "#1a202c", "circle-stroke-color": "#fff", "circle-stroke-width": 2 }
      }, before);
      map.addLayer({
        id: ZEB_DEPOT_LABEL, type: "symbol", source: ZEB_DEPOT_SOURCE,
        layout: { "text-field": ["get", "name"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.8] },
        paint: { "text-color": "#1a202c", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.2 }
      }, before);

      var popup = ensureHoverPopup();
      map.on("mousemove", ZEB_DEPOT_LAYER, function (e) {
        map.getCanvas().style.cursor = "pointer";
        if (!e.features || !e.features.length) return;
        var p = e.features[0].properties;
        popup.setLngLat(e.lngLat).setHTML(
          '<div style="font-size:12px;">Depot — ' + escapeHTML(p.name) + " · " + p.chargerKW + " kW chargers</div>"
        ).addTo(map);
      });
      map.on("mouseleave", ZEB_DEPOT_LAYER, function () {
        map.getCanvas().style.cursor = App.drawMode ? "crosshair" : "grab";
        popup.remove();
      });
    } else {
      map.getSource(ZEB_DEPOT_SOURCE).setData(fc);
    }
  }

  function clearMapLayers() {
    var map = App.map;
    if (!map) return;
    if (_hoverPopup) _hoverPopup.remove();
    [ZEB_LAYER, ZEB_DEPOT_LABEL, ZEB_DEPOT_LAYER].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    [ZEB_SOURCE, ZEB_DEPOT_SOURCE].forEach(function (id) { if (map.getSource(id)) map.removeSource(id); });
    if (map.getLayer("gtfs-shapes-layer")) map.setLayoutProperty("gtfs-shapes-layer", "visibility", "visible");
  }

  async function showLegend() {
    if (!App.popup || !App.popup.showFloatingWidget) return;
    await App.popup.showFloatingWidget("zeb-legend", "projects/zeb-feasibility-legend.html", {
      position: "bottom-left", width: 210, title: "Electrification feasibility"
    });
    var ZebDemoData = window.ZebDemoData;
    for (var i = 0; i < 5; i++) {
      var swatch = document.getElementById("zebLegendSwatch" + i);
      var label = document.getElementById("zebLegendLabel" + i);
      var t = ZebDemoData.tiers[i];
      if (!swatch || !t) continue;
      swatch.style.background = t.color;
      if (label) label.textContent = "Tier " + t.tier + " — " + t.label;
    }
  }

  // ---- Exports ----

  function _dateStamp() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function _triggerDownload(content, mimeType, filename) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
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

  function setExportButtonsEnabled(enabled) {
    var csvBtn = document.getElementById("zebExportCSV");
    var gjBtn = document.getElementById("zebExportGeoJSON");
    if (csvBtn) csvBtn.disabled = !enabled;
    if (gjBtn) gjBtn.disabled = !enabled;
  }

  function exportCSV() {
    if (!_lastResult || !_lastResult.shownRoutes || !_lastResult.shownRoutes.length) return;
    var header = ["agency", "route_id", "route_short_name", "route_long_name", "vehicle_class", "season",
      "blocks", "governing_block", "revenue_miles", "deadhead_miles", "kwh_per_mile", "block_kwh", "required_kwh",
      "battery_kwh", "ratio", "tier", "tier_label", "score", "recharge_hours", "overnight_hours"];
    var lines = [header.join(",")];
    _lastResult.shownRoutes.forEach(function (r) {
      var governing = (r.blocks || []).filter(function (b) { return b.block.blockId === r.governingBlockId; })[0];
      var energy = governing ? governing.energy : null;
      var meta = (_prepared && _prepared.routes[r.routeId]) || {};
      lines.push([
        _csvField(r.agencyLabel), _csvField(r.routeId), _csvField(meta.short || ""), _csvField(meta.long || ""),
        _csvField(r.vehicleLabel), _csvField(_settings.season),
        r.blockCount != null ? r.blockCount : "", _csvField(r.governingBlockId),
        Number.isFinite(r.revenueMiles) ? r.revenueMiles.toFixed(2) : "",
        energy ? energy.deadheadMiles.total.toFixed(2) : "",
        energy ? energy.kWhPerMi.toFixed(3) : "",
        Number.isFinite(r.blockKWh) ? r.blockKWh.toFixed(1) : "",
        Number.isFinite(r.requiredKWh) ? r.requiredKWh.toFixed(1) : "",
        energy ? energy.vehicle.batteryKWh : "",
        Number.isFinite(r.ratio) ? r.ratio.toFixed(3) : "",
        r.tier != null ? r.tier : "",
        _csvField(r.label || ""),
        r.score != null ? r.score : "",
        energy ? energy.rechargeHours.toFixed(2) : "",
        energy ? energy.overnightHours.toFixed(2) : ""
      ].join(","));
    });
    _triggerDownload(lines.join("\n"), "text/csv", "zeb-feasibility-" + _settings.season + "-" + _dateStamp() + ".csv");
  }

  function exportGeoJSON() {
    if (!_lastResult || !_lastResult.shownRoutes || !_lastResult.shownRoutes.length) return;
    var fc = buildRoutesFC(_lastResult.shownRoutes);
    fc.metadata = {
      tool: "Micro Analysis Tool",
      module: "Route Electrification Feasibility",
      exportedAt: new Date().toISOString(),
      season: _settings.season,
      vehicleAssume: _settings.vehicleAssume,
      assumptions: _settings.assumptions
    };
    _triggerDownload(JSON.stringify(fc, null, 2), "application/geo+json",
      "zeb-feasibility-" + _settings.season + "-" + _dateStamp() + ".geojson");
  }

  // ---- Popup lifecycle ----

  function init(core) {
    if (_initialized) return;
    _initialized = true;

    var agencySel = document.getElementById("zebAgency");
    if (agencySel) agencySel.addEventListener("change", function () {
      _settings.agency = agencySel.value;
      _settings.route = "all";
      rebuildRouteDropdown();
      if (_lastResult) runScoring();
    });

    ["zebRoute", "zebVehicleFilter", "zebVehicleAssume", "zebSeason"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", onControlChange);
    });
    ["zebBat40", "zebBase40", "zebBatCut", "zebBaseCut", "zebChargerKW", "zebSocBuffer", "zebLayover"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", onControlChange);
    });

    var resetLink = document.getElementById("zebResetAssumptions");
    if (resetLink) resetLink.addEventListener("click", function (e) {
      e.preventDefault();
      _settings.assumptions = defaultAssumptions();
      syncAssumptionInputs();
      if (_lastResult) runScoring();
    });

    function wireOverlayCheckbox(id, key) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        _settings.overlays[key] = el.checked;
        if (App.zebOverlays) App.zebOverlays.toggle(key, el.checked);
      });
    }
    wireOverlayCheckbox("zebOvWinter", "winter");
    wireOverlayCheckbox("zebOvDI", "di");
    wireOverlayCheckbox("zebOvUtility", "utility");

    var runBtn = document.getElementById("zebRunBtn");
    if (runBtn) runBtn.addEventListener("click", runScoring);

    var csvBtn = document.getElementById("zebExportCSV");
    if (csvBtn) csvBtn.addEventListener("click", exportCSV);
    var gjBtn = document.getElementById("zebExportGeoJSON");
    if (gjBtn) gjBtn.addEventListener("click", exportGeoJSON);

    var hideCb = document.getElementById("zebHideColoring");
    if (hideCb) hideCb.addEventListener("change", function () {
      var vis = hideCb.checked ? "none" : "visible";
      var map = App.map;
      [ZEB_LAYER, ZEB_DEPOT_LAYER, ZEB_DEPOT_LABEL].forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      });
      if (hideCb.checked) {
        if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("zeb-legend");
      } else {
        showLegend();
      }
    });

    renderInputs(_lastResult ? undefined : false);
  }

  function onOpen(core) {
    ensurePrepared();
    buildFilterDropdowns();
    syncControlsFromSettings();
    syncOverlayCheckboxes();
    renderInputs(_lastResult ? true : false);
    renderFeedBar();

    if (_lastResult) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");
      renderResultsTable(_lastResult.shownRoutes || []);
      renderSummaryStrip(_lastResult.shownRoutes || []);
      setExportButtonsEnabled((_lastResult.shownRoutes || []).length > 0);
      var hideRow = document.getElementById("zebHideRow");
      if (hideRow) hideRow.style.display = "";
      var hideCb = document.getElementById("zebHideColoring");
      if (hideCb) {
        var vis = (App.map.getLayer(ZEB_LAYER) && App.map.getLayoutProperty(ZEB_LAYER, "visibility")) || "visible";
        hideCb.checked = (vis === "none");
      }
    } else {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      setExportButtonsEnabled(false);
      renderEmptyState();
    }
    if (_stale) markStale();
  }

  function onClose(core) {
    // State persists in closure
  }

  function clearAll() {
    clearMapLayers();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("zeb-legend");
    _lastResult = null;
    _stale = false;
    if (isPopupVisible()) {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
      renderInputs(false);
      var resultsEl = document.getElementById("zebResults");
      if (resultsEl) resultsEl.style.display = "none";
      renderEmptyState();
      setExportButtonsEnabled(false);
      var hideCb = document.getElementById("zebHideColoring");
      if (hideCb) hideCb.checked = false;
      var hideRow = document.getElementById("zebHideRow");
      if (hideRow) hideRow.style.display = "none";
    }
  }

  function update(core) {
    var data = App.getGTFSData ? App.getGTFSData() : null;
    if (data === _preparedFeedRef) return;

    _prepared = null;
    _preparedFeedRef = data;
    _preparedLayover = null;
    _lastResult = null;
    _stale = false;
    clearMapLayers();
    if (App.popup && App.popup.hideFloatingWidget) App.popup.hideFloatingWidget("zeb-legend");
    if (data) ensurePrepared();

    if (!isPopupVisible()) return;
    buildFilterDropdowns();
    renderInputs(false);
    renderFeedBar();
    if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
    var resultsEl = document.getElementById("zebResults");
    if (resultsEl) resultsEl.style.display = "none";
    renderEmptyState();
    setExportButtonsEnabled(false);
  }

  // ---- Session persistence (settings only; geometry/results are not persisted) ----

  function saveZebState() {
    return { v: 1, settings: JSON.parse(JSON.stringify(_settings)) };
  }

  function restoreZebState(data) {
    if (!data || !data.settings) return;
    _settings = data.settings;
    if (!_settings.assumptions) _settings.assumptions = defaultAssumptions();
    if (!_settings.overlays) _settings.overlays = { winter: false, di: false, utility: false };
    if (isPopupVisible()) {
      syncControlsFromSettings();
      buildFilterDropdowns();
    }
  }

  // ---- Register as analysis module ----

  App.registerModule({
    id: "zeb-feasibility",
    name: "Route Electrification Feasibility",
    enabled: true,
    popupWidth: 1000,
    panelWidths: { setup: 600, results: 600 },
    popupHTML: "projects/zeb-feasibility-popup.html",

    init:    function (core) { init(core); },
    onOpen:  function (core) { onOpen(core); },
    onClose: function (core) { onClose(core); },
    clear:   function ()     { clearAll(); },
    update:  function (core) { update(core); }
  });

  if (App.cache && App.cache.registerModule) {
    App.cache.registerModule("zeb-feasibility", {
      collect: saveZebState,
      apply: restoreZebState
    });
  }

})();
