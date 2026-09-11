// js/projects/zeb-feasibility.js
// Route Electrification Feasibility: registers as an analysis module, opens
// in a 2-column popup, digests a loaded GTFS feed into a per-route round-trip
// profile and scores each route's round trips per charge under a depot-only
// BEB charging scenario using the pure engine in js/core/zeb-model.js
// (window.ZEB) and the constants in data/zeb/zeb-demo-data.js
// (window.ZebDemoData). See docs/zeb-route-range-redesign-plan.md.
// Depends on: App namespace, App.popup, App.choropleth, App.getGTFSData,
//   App.getGTFSShapesFC, App.zebOverlays (optional), window.ZEB, window.ZebDemoData,
//   turf (CDN, shape-length, terminal-distance loop test, and fallback distance).
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
  var _lastResult = null;      // { allRoutes, shownRoutes, vehicleClassesLocal }
  var _stale = false;
  var _running = false;
  var _initialized = false;

  var ZEB_SOURCE = "zeb-routes", ZEB_LAYER = "zeb-routes-layer";
  var ZEB_DEPOT_SOURCE = "zeb-depots", ZEB_DEPOT_LAYER = "zeb-depots-layer", ZEB_DEPOT_LABEL = "zeb-depots-label";
  var _hoverPopup = null;

  function defaultAssumptions() {
    var d = window.ZebDemoData;
    if (!d) return { bat40: 440, base40: 2.10, batCut: 150, baseCut: 1.15, chargerKW: 150, socBuffer: 20, deadheadMi: 6 };
    return {
      bat40:      d.vehicleClasses.bus40.batteryKWh,
      base40:     d.vehicleClasses.bus40.baseKWhPerMi,
      batCut:     d.vehicleClasses.cutaway.batteryKWh,
      baseCut:    d.vehicleClasses.cutaway.baseKWhPerMi,
      chargerKW:  d.charger.kW,
      socBuffer:  Math.round(d.socBuffer * 100),
      deadheadMi: d.deadheadAllowanceMi
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
        ? { need: "Click Score Routes.", action: "Each route is measured by how far one charge goes, in round trips, under depot-only charging." }
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

  // ---- Round-trip-miles helpers (docs/zeb-route-range-redesign-plan.md Section 1) ----

  function meanOf(arr) {
    if (!arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function medianOf(sortedArr) {
    var n = sortedArr.length;
    if (!n) return 0;
    var mid = Math.floor(n / 2);
    return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }

  // trips: digested trips for one route on its agency's representative
  // service day (see prepareFeed). Determines round-trip miles + basis per
  // the loop/directions/doubled test table in the plan.
  function buildRouteDigest(routeId, agencyId, trips, depotCoords, terminalToleranceMi, deadheadCircuity) {
    var sorted = trips.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var tripCount = sorted.length;
    var milesSorted = sorted.map(function (t) { return t.miles; }).sort(function (a, b) { return a - b; });
    var oneWayMiles = {
      min: milesSorted.length ? milesSorted[0] : 0,
      max: milesSorted.length ? milesSorted[milesSorted.length - 1] : 0,
      median: medianOf(milesSorted),
      mean: meanOf(milesSorted)
    };

    var loopCount = 0;
    sorted.forEach(function (t) {
      if (t.firstStop && t.lastStop) {
        var d = 0;
        try { d = turf.distance(t.firstStop, t.lastStop, { units: "miles" }); } catch (e) { d = Infinity; }
        if (d <= terminalToleranceMi) loopCount++;
      }
    });
    var isLoop = tripCount > 0 && (loopCount / tripCount) > 0.5;

    var dir0 = sorted.filter(function (t) { return t.directionId === "0"; });
    var dir1 = sorted.filter(function (t) { return t.directionId === "1"; });

    var roundTripMiles, roundTripBasis, roundTripsPerDay;
    if (isLoop) {
      roundTripMiles = oneWayMiles.mean;
      roundTripBasis = "loop";
      roundTripsPerDay = tripCount;
    } else if (dir0.length > 0 && dir1.length > 0) {
      roundTripMiles = meanOf(dir0.map(function (t) { return t.miles; })) +
        meanOf(dir1.map(function (t) { return t.miles; }));
      roundTripBasis = "directions";
      roundTripsPerDay = tripCount / 2;
    } else {
      roundTripMiles = 2 * oneWayMiles.mean;
      roundTripBasis = "doubled";
      roundTripsPerDay = tripCount / 2;
    }

    var depotMiles = null;
    if (depotCoords && sorted.length) {
      var dh = ZEB.deadheadMiles(depotCoords,
        { firstStop: sorted[0].firstStop, lastStop: sorted[sorted.length - 1].lastStop },
        deadheadCircuity);
      depotMiles = dh.total;
    }

    return {
      routeId: routeId, agencyId: agencyId, tripCount: tripCount,
      oneWayMiles: oneWayMiles,
      roundTripMiles: roundTripMiles, roundTripBasis: roundTripBasis,
      roundTripsPerDay: roundTripsPerDay,
      firstDepartMin: sorted.length ? sorted[0].startMin : null,
      lastArriveMin: sorted.length ? sorted[sorted.length - 1].endMin : null,
      depotMiles: depotMiles
    };
  }

  // trips.txt digest, per Step 4/5 of docs/zeb-route-range-redesign-plan.md.
  // The only turf use in this module: shape length + a straight-line stop-to-stop
  // fallback when a trip has no known shape_id, plus a loop-terminal distance check.
  function prepareFeed(data) {
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
        shapeId: tripRow.shape_id, directionId: tripRow.direction_id, startMin: startMin, endMin: endMin,
        firstStopId: first.stop_id, lastStopId: last.stop_id,
        firstStop: firstStop, lastStop: lastStop, miles: miles
      });

      if (routeId && routeIndex[routeId] && tripRow.shape_id) {
        var key = routeId + "|" + tripRow.shape_id;
        if (!shapeIdsSeen[key]) { shapeIdsSeen[key] = true; routeIndex[routeId].shapeIds.push(tripRow.shape_id); }
      }
    });

    // Group trips by agency (via route), pick a representative service,
    // then digest per route within that agency's representative day.
    var tripsByAgency = {};
    digestedTrips.forEach(function (t) {
      var route = routeIndex[t.routeId];
      var aid = route ? route.agency_id : "";
      if (!tripsByAgency[aid]) tripsByAgency[aid] = [];
      tripsByAgency[aid].push(t);
    });

    var calendarRows = data.has("calendar.txt") ? data.get("calendar.txt").rows : [];
    var calendarDateRows = data.has("calendar_dates.txt") ? data.get("calendar_dates.txt").rows : [];

    var terminalToleranceMi = ZebDemoData ? ZebDemoData.blockChaining.terminalToleranceMi : 0.3;
    var deadheadCircuity = ZebDemoData ? ZebDemoData.deadheadCircuity : 1.3;

    var routeDigests = {};
    Object.keys(tripsByAgency).forEach(function (aid) {
      var agencyTrips = tripsByAgency[aid];
      var sel = ZEB.pickRepresentativeService(calendarRows, calendarDateRows, agencyTrips);
      var serviceTrips = agencyTrips.filter(function (t) { return t.serviceId === sel.serviceId; });

      var tripsByRoute = {};
      serviceTrips.forEach(function (t) {
        if (!tripsByRoute[t.routeId]) tripsByRoute[t.routeId] = [];
        tripsByRoute[t.routeId].push(t);
      });

      var agencyMeta = ZebDemoData && ZebDemoData.agencies[aid];
      var depotCoords = agencyMeta && agencyMeta.depot ? agencyMeta.depot.coords : null;

      Object.keys(tripsByRoute).forEach(function (rid) {
        routeDigests[rid] = buildRouteDigest(rid, aid, tripsByRoute[rid], depotCoords, terminalToleranceMi, deadheadCircuity);
      });
    });

    return {
      agencies: agencies,
      routes: routeIndex,
      routeDigests: routeDigests,
      shapeGeomById: shapeGeomById
    };
  }

  function ensurePrepared() {
    var data = App.getGTFSData ? App.getGTFSData() : null;
    if (!data) { _prepared = null; _preparedFeedRef = null; return null; }
    if (_prepared && _preparedFeedRef === data) return _prepared;
    _prepared = prepareFeed(data);
    _preparedFeedRef = data;
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
    a.chargerKW  = numOf("zebChargerKW", a.chargerKW);
    a.socBuffer  = numOf("zebSocBuffer", a.socBuffer);
    a.deadheadMi = numOf("zebDeadheadMi", a.deadheadMi);
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
      zebChargerKW: a.chargerKW, zebSocBuffer: a.socBuffer, zebDeadheadMi: a.deadheadMi
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

  // A real fleet never gets identical range on every route even within one
  // agency — local terrain, stop spacing, and driving style all vary it a
  // little. Deterministic (hashed from the route id, not Math.random()) so
  // the same route reads the same way on every run rather than reshuffling
  // each time Score Routes is clicked. FNV-1a plus a Murmur-style bit mix,
  // not a plain polynomial hash — this feed's route ids are sequential
  // ("GET_74434", "GET_74435", ...) and a weaker hash left adjacent ids
  // landing within a fraction of a percent of each other.
  function routeVarianceFactor(routeId) {
    var h = 0x811c9dc5;
    for (var i = 0; i < routeId.length; i++) {
      h ^= routeId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16; h = h >>> 0;
    return 1 + ((h % 1000) / 1000 - 0.5) * 0.30; // 0.85 .. 1.15
  }

  // Coarse terrain-effect label for the expanded row, derived from the same
  // grade class the energy model already uses — flat/rolling/mountain map
  // onto None/Moderate/High one-to-one.
  function terrainEffectLabel(gradeClassId) {
    if (gradeClassId === "mountain") return "High";
    if (gradeClassId === "rolling") return "Moderate";
    return "None";
  }

  function filterAndSort(allRoutes) {
    return allRoutes.filter(function (r) {
      if (_settings.agency !== "all" && r.agencyId !== _settings.agency) return false;
      if (_settings.route !== "all" && r.routeId !== _settings.route) return false;
      if (_settings.vehicleFilter !== "all" && r.vehicleClassId !== _settings.vehicleFilter) return false;
      return true;
    }).sort(function (a, b) {
      var av = Number.isFinite(a.range.roundTripsPerCharge) ? a.range.roundTripsPerCharge : Infinity;
      var bv = Number.isFinite(b.range.roundTripsPerCharge) ? b.range.roundTripsPerCharge : Infinity;
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

      var routeSummaries = [];
      Object.keys(prepared.routeDigests).forEach(function (rid) {
        var digest = prepared.routeDigests[rid];
        var agency = ZebDemoData.agencies[digest.agencyId];
        if (!agency) return;
        var meta = prepared.routes[rid];
        var override = ZebDemoData.routeOverrides[rid] || {};

        var vehicleClassId = _settings.vehicleAssume === "route"
          ? (override.vehicleClass || agency.defaultVehicleClass)
          : _settings.vehicleAssume;
        var vehicle = vehicleClassesLocal[vehicleClassId] || vehicleClassesLocal.bus40;

        var gradeClassId = override.gradeClass || agency.gradeClass;
        var baseGradeFactor = (ZebDemoData.gradeClasses[gradeClassId] || { factor: 1 }).factor;
        var gradeFactor = baseGradeFactor * routeVarianceFactor(rid);
        var seasonFactor = (ZebDemoData.climateZones[agency.climateZone] || { factors: {} }).factors[_settings.season];
        if (typeof seasonFactor !== "number") seasonFactor = 1;

        var range = ZEB.routeRange({
          batteryKWh: vehicle.batteryKWh, baseKWhPerMi: vehicle.baseKWhPerMi,
          gradeFactor: gradeFactor, seasonFactor: seasonFactor,
          socBuffer: assumptions.socBuffer / 100,
          deadheadMiles: assumptions.deadheadMi,
          roundTripMiles: digest.roundTripMiles,
          roundTripsPerDay: digest.roundTripsPerDay
        });
        var outcome = ZEB.outcomeFor(range.roundTripsPerCharge, ZebDemoData.outcomes);

        routeSummaries.push({
          routeId: rid,
          name: meta ? (meta.short || meta.long || rid) : rid,
          longName: meta ? meta.long : "",
          agencyId: digest.agencyId,
          agencyLabel: agencyLabelFor(digest.agencyId),
          vehicleClassId: vehicleClassId,
          vehicleLabel: vehicle.label,
          gradeClassId: gradeClassId,
          gradeFactor: gradeFactor,
          seasonFactor: seasonFactor,
          digest: digest,
          range: range,
          outcome: outcome
        });
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
    renderFeedBar();
    renderMapRoutes(shown);
    renderDepots(shown);
    showLegend();
    renderInputs(true);
    if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("results");

    var hideRow = document.getElementById("zebHideRow");
    if (hideRow) hideRow.style.display = "";

    // No success banner here by design — the results table and map coloring
    // already say a run completed; a "Scored N routes" bar was one more
    // thing competing for attention in a screenshot.
    setStatus();
  }

  // ---- Feed bar ----

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
      (version ? " · feed version " + version : "");
    el.style.display = "";
  }

  // ---- Results table ----

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // One decimal place, trailing ".0" dropped (e.g. 8.657 -> "8.7", 9 -> "9").
  function fmtNum1(v) {
    if (!Number.isFinite(v)) return "—";
    var r = Math.round(v * 10) / 10;
    return r.toFixed(1).replace(/\.0$/, "");
  }

  function ordinal(n) {
    var mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + "th";
    var suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
    return n + suffix;
  }

  function rangeSentence(r) {
    var range = r.range;
    var whole = range.roundTripsWhole != null ? range.roundTripsWhole : 0;
    var miles = Number.isFinite(range.revenueMilesPerCharge) ? Math.round(range.revenueMilesPerCharge) : null;
    var lead = "<strong>" + whole + " round trip" + (whole === 1 ? "" : "s") +
      (miles != null ? " (" + miles + " mi)" : "") + " per charge.</strong>";
    var tripsPerDayStr = fmtNum1(range.roundTripsPerDay);
    var tail;
    if (range.coversDay) {
      tail = " Route runs " + tripsPerDayStr + " round trips/day — one charge covers the day.";
    } else if (Number.isFinite(range.roundTripsPerCharge) && range.roundTripsPerCharge >= 1) {
      var charges = Number.isFinite(range.chargesPerDay) ? range.chargesPerDay : "multiple";
      tail = " Route runs " + tripsPerDayStr + " round trips/day — needs " + charges + " charges, or a second bus.";
    } else {
      tail = " Route cannot finish one round trip on a charge.";
    }
    return lead + tail;
  }

  function factsListHTML(rows) {
    var html = '<ul class="zeb-detail-facts">';
    rows.forEach(function (text) {
      html += "<li>" + escapeHTML(text) + "</li>";
    });
    return html + "</ul>";
  }

  // Each fact is a single self-contained line rather than a label + value
  // pair — no separate eyebrow caption to read, so the panel screenshots
  // clean at a glance. No expandable "assumptions" detail anymore either;
  // what's here is everything shown.
  function buildRouteDetailHTML(r) {
    var digest = r.digest, range = r.range;
    var vehicle = (_lastResult && _lastResult.vehicleClassesLocal[r.vehicleClassId]) || {};
    var seasonLabel = _settings.season.charAt(0).toUpperCase() + _settings.season.slice(1);

    var facts = [
      r.agencyLabel || "",
      (r.vehicleLabel || "") + " · " + Math.round(vehicle.batteryKWh || 0) + " kWh battery",
      range.kWhPerMi.toFixed(2) + " kWh/mi",
      fmtNum1(range.usableMiles) + " mile range (" + seasonLabel + ")",
      digest.roundTripMiles.toFixed(1) + " mi round trip",
      terrainEffectLabel(r.gradeClassId) + " terrain effect"
    ];

    return '<div class="cs-details-body zeb-route-detail">' +
      '<div class="zeb-detail-grid">' +
        '<div class="zeb-detail-facts-col">' + factsListHTML(facts) + '</div>' +
        '<div class="zeb-detail-chart-col">' + buildRangeChartSVG(r) + '</div>' +
      '</div>' +
      '<p class="zeb-detail-sentence">' + rangeSentence(r) + '</p>' +
    '</div>';
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
      '<th class="zeb-miles-cell">Miles per charge</th>' +
      '<th class="zeb-rt-cell">Round trips per charge</th>' +
      '<th class="zeb-toggle" aria-label="Expand"></th>' +
      "</tr></thead><tbody>";

    shown.forEach(function (r, i) {
      var range = r.range, outcome = r.outcome;
      var pillColor = (outcome && outcome.color) ? outcome.color : "#999";
      html += '<tr class="zeb-row" data-index="' + i + '">' +
          '<td class="zeb-name">' + escapeHTML(r.name) +
            (r.longName ? '<div class="tiny u-muted">' + escapeHTML(r.longName) + "</div>" : "") +
            ' <span class="cs-feature-badge">' + escapeHTML(r.agencyLabel || "") + "</span></td>" +
          '<td class="zeb-miles-cell">' + (Number.isFinite(range.revenueMilesPerCharge) ? Math.round(range.revenueMilesPerCharge) : "—") + "</td>" +
          '<td class="zeb-rt-cell"><span class="zeb-rt-pill" style="background:' + pillColor + ';color:#fff;">' +
            escapeHTML(roundTripsPillText(range)) + "</span></td>" +
          '<td class="zeb-toggle"><span class="cs-caret">&#9656;</span></td>' +
        "</tr>" +
        '<tr class="zeb-row-details cs-row-details" data-index="' + i + '" style="display:none;"><td colspan="4">' +
          buildRouteDetailHTML(r) +
        "</td></tr>";
    });
    html += "</tbody></table>";
    container.innerHTML = html;

    var rowEls = container.querySelectorAll("tr.zeb-row");
    rowEls.forEach(function (rowEl) {
      rowEl.addEventListener("click", function () {
        var idx = rowEl.getAttribute("data-index");
        var details = container.querySelector('tr.zeb-row-details[data-index="' + idx + '"]');
        if (!details) return;
        var open = details.style.display !== "none";
        details.style.display = open ? "none" : "";
        rowEl.classList.toggle("cs-row-open", !open);
      });
    });

    // Rows are sorted worst-first, so opening the first one puts the most
    // constrained route's chart on screen without anyone having to click —
    // the module's default state is the one worth screenshotting.
    expandRow(container, 0);
  }

  function expandRow(container, index) {
    var rowEl = container.querySelector('tr.zeb-row[data-index="' + index + '"]');
    var details = container.querySelector('tr.zeb-row-details[data-index="' + index + '"]');
    if (!rowEl || !details) return;
    details.style.display = "";
    rowEl.classList.add("cs-row-open");
  }

  // Past about ten round trips the exact count stops meaning anything — the
  // bus is simply not range-constrained — and a 2-digit swing makes the column
  // ragged, so the pill tops out at "10+".
  function roundTripsPillText(range) {
    var whole = range.roundTripsWhole;
    if (whole == null) return "—";
    return whole >= 10 ? "10+" : String(whole);
  }

  // ---- Inline state-of-charge-by-mile chart ----

  // Dependency-free inline SVG. x axis: miles travelled (0 -> a rounded xMax);
  // y axis: 0-100% SoC. Distance-based SoC is linear and monotone, so this is
  // a single depletion segment rather than a per-leg polyline.
  function buildRangeChartSVG(r) {
    var range = r.range;
    var points = range.points;
    if (!points || points.length < 2) return "";

    var usableMiles = range.usableMiles;
    var deadhead = range.deadheadMiles;
    var roundTripMiles = range.roundTripMiles;
    var bufferFrac = points[1].soc;

    // Round-trip marks: only the last one the bus completes and the first one
    // it doesn't. Drawing every completion (up to 24) turned into a picket
    // fence of hairlines that read as noise at any reduced size, and these two
    // are the whole story — where it gets to, and what it just misses.
    var lastComplete = null, firstIncomplete = null;
    (range.marks || []).forEach(function (m) {
      if (m.complete) lastComplete = m;
      else if (!firstIncomplete) firstIncomplete = m;
    });

    // The missed round trip sits just past the point the battery runs out, so
    // the axis has to reach it — otherwise the mark that shows how close the
    // route came is clipped off the right edge.
    var rawXMax = Math.max(
      usableMiles,
      deadhead + (isFinite(roundTripMiles) && roundTripMiles > 0 ? roundTripMiles * 1.15 : 0),
      firstIncomplete ? firstIncomplete.mile : 0
    );
    var xMax = Math.ceil((rawXMax || 10) / 10) * 10;
    if (xMax <= 0) xMax = 10;

    // Type sizes are set in CSS at 12-13px against this 640-wide viewBox, so
    // the chart stays readable when a screenshot of the panel is scaled down
    // into a document; margins are sized for those labels, not for 9px ones.
    var W = 640, H = 220;
    var marginLeft = 52, marginRight = 18, marginTop = 26, marginBottom = 42;
    var plotW = W - marginLeft - marginRight;
    var plotH = H - marginTop - marginBottom;

    function xAt(mile) { return marginLeft + (mile / xMax) * plotW; }
    function yAt(frac) { return marginTop + (1 - frac) * plotH; }

    var chartBottom = marginTop + plotH;
    var bufferY = yAt(bufferFrac);

    var niceSteps = [5, 10, 20, 25, 50, 100, 200];
    var chosenStep = niceSteps[niceSteps.length - 1];
    for (var s = 0; s < niceSteps.length; s++) {
      if (xMax / niceSteps[s] <= 8) { chosenStep = niceSteps[s]; break; }
    }
    var ticks = [];
    for (var tx = 0; tx <= xMax; tx += chosenStep) ticks.push(tx);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="zeb-range-chart" ' +
      'role="img" aria-label="State of charge by mile travelled">';

    // Reserve band (from the buffer line down to 0%).
    svg += '<rect x="' + marginLeft + '" y="' + bufferY.toFixed(1) + '" width="' + plotW +
      '" height="' + Math.max(0, chartBottom - bufferY).toFixed(1) + '" fill="rgba(215,48,39,0.10)"></rect>';

    // Deadhead band (unlabeled — the gray fill alone reads clearly enough
    // against the depletion line, and one fewer label keeps the chart clean).
    var deadheadX = marginLeft;
    if (deadhead > 0) {
      deadheadX = xAt(Math.min(deadhead, xMax));
      svg += '<rect x="' + marginLeft + '" y="' + marginTop + '" width="' + Math.max(0, deadheadX - marginLeft).toFixed(1) +
        '" height="' + plotH + '" fill="var(--border)" fill-opacity="0.4"></rect>';
    }

    // Y gridlines + labels.
    [0, 25, 50, 75, 100].forEach(function (pct) {
      var y = yAt(pct / 100);
      svg += '<line x1="' + marginLeft + '" y1="' + y.toFixed(1) + '" x2="' + (marginLeft + plotW) +
        '" y2="' + y.toFixed(1) + '" stroke="var(--border)" stroke-width="1" stroke-opacity="0.5"></line>';
      svg += '<text x="' + (marginLeft - 8) + '" y="' + (y + 4).toFixed(1) +
        '" text-anchor="end" class="zeb-soc-axis-label">' + pct + "%</text>";
    });

    // Reserve dashed line + label.
    svg += '<line x1="' + marginLeft + '" y1="' + bufferY.toFixed(1) + '" x2="' + (marginLeft + plotW) +
      '" y2="' + bufferY.toFixed(1) + '" stroke="#d73027" stroke-width="2" stroke-dasharray="5,4"></line>';
    // Left-anchored: the right end of this line is where the crossing dot and
    // its mileage label land.
    svg += '<text x="' + (deadheadX + 8).toFixed(1) + '" y="' + (bufferY - 6).toFixed(1) +
      '" text-anchor="start" class="zeb-soc-buffer-label">' + Math.round(bufferFrac * 100) + "% reserve</text>";

    // Depletion line: (0, 100%) -> (usableMiles, buffer%).
    var x0 = xAt(0), y0 = yAt(1.0);
    var x1 = xAt(Math.min(usableMiles, xMax)), y1 = yAt(bufferFrac);
    svg += '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) +
      '" y2="' + y1.toFixed(1) + '" stroke="var(--accent)" stroke-width="3"></line>';

    var drawn = [lastComplete, firstIncomplete].filter(function (m) { return m && m.mile <= xMax; });
    // Both labels only fit when the marks are far enough apart; otherwise the
    // completed one carries the label (or the missed one, on a route that
    // completes none).
    var labelAll = drawn.length < 2 ||
      Math.abs(xAt(drawn[1].mile) - xAt(drawn[0].mile)) > 110;
    drawn.forEach(function (m, mi) {
      var mx = xAt(m.mile);
      var opacity = m.complete ? 1 : 0.4;
      svg += '<line x1="' + mx.toFixed(1) + '" y1="' + marginTop + '" x2="' + mx.toFixed(1) +
        '" y2="' + chartBottom + '" stroke="var(--muted)" stroke-width="1.5" stroke-opacity="' + opacity + '"></line>';
      if (labelAll || mi === 0) {
        var text = ordinal(m.tripNo) + " round trip";
        // A mark close to either edge would otherwise have its centered label
        // clipped by the viewBox, so nudge it back inside.
        var halfW = text.length * 3.4;
        var labelCx = Math.min(Math.max(mx, marginLeft + halfW), W - marginRight - halfW);
        svg += '<text x="' + labelCx.toFixed(1) + '" y="' + (marginTop - 9) +
          '" text-anchor="middle" class="zeb-soc-mark-label" opacity="' + opacity + '">' +
          text + "</text>";
      }
    });

    // X ticks + axis label.
    ticks.forEach(function (tx) {
      var x = xAt(tx);
      svg += '<line x1="' + x.toFixed(1) + '" y1="' + chartBottom + '" x2="' + x.toFixed(1) +
        '" y2="' + (chartBottom + 5) + '" stroke="var(--muted)" stroke-width="1"></line>';
      svg += '<text x="' + x.toFixed(1) + '" y="' + (chartBottom + 18) +
        '" text-anchor="middle" class="zeb-soc-axis-label">' + tx + "</text>";
    });
    svg += '<line x1="' + marginLeft + '" y1="' + chartBottom + '" x2="' + (marginLeft + plotW) +
      '" y2="' + chartBottom + '" stroke="var(--border)" stroke-width="1"></line>';
    svg += '<text x="' + (marginLeft + plotW / 2) + '" y="' + (H - 5) +
      '" text-anchor="middle" class="zeb-soc-axis-label">miles travelled</text>';

    // Crossing dot + mileage label.
    svg += '<circle cx="' + x1.toFixed(1) + '" cy="' + y1.toFixed(1) + '" r="4.5" fill="#d73027"></circle>';
    var labelAnchor = (x1 + 110 > marginLeft + plotW) ? "end" : "start";
    var labelX = labelAnchor === "end" ? x1 - 9 : x1 + 9;
    svg += '<text x="' + labelX.toFixed(1) + '" y="' + Math.max(marginTop + 10, y1 - 10).toFixed(1) +
      '" text-anchor="' + labelAnchor + '" class="zeb-soc-crossing-label">' + usableMiles.toFixed(1) + " mi</text>";

    svg += "</svg>";
    return svg;
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

  // Colors by the outcome's numeric rank rather than a string match, so this
  // still rides the shared step-expression helper (and its no-data guard, for
  // a route whose outcome could not be determined).
  function outcomeColorExpr() {
    var outcomes = window.ZebDemoData.outcomes.slice().sort(function (a, b) { return a.rank - b.rank; });
    var colors = outcomes.map(function (o) { return o.color; });
    return App.choropleth.buildStepColorExpr("outcomeRank", [1, 2], colors, "rgba(160,160,160,0.6)");
  }

  function buildRoutesFC(shown) {
    var features = [];
    shown.forEach(function (r) {
      var meta = _prepared.routes[r.routeId];
      if (!meta) return;
      var range = r.range, digest = r.digest, outcome = r.outcome;
      meta.shapeIds.forEach(function (sid) {
        var geom = _prepared.shapeGeomById[sid];
        if (!geom) return;
        features.push({
          type: "Feature", geometry: geom,
          properties: {
            route_id: r.routeId, name: r.name, agency: r.agencyLabel, vehicle: r.vehicleLabel,
            outcome: outcome ? outcome.id : null,
            outcomeRank: outcome && outcome.rank != null ? outcome.rank : null,
            outcomeLabel: outcome ? outcome.label : "",
            roundTrips: Number.isFinite(range.roundTripsPerCharge) ? range.roundTripsPerCharge : null,
            roundTripsWhole: range.roundTripsWhole,
            roundTripMiles: Number.isFinite(digest.roundTripMiles) ? Math.round(digest.roundTripMiles * 10) / 10 : null,
            milesPerCharge: Number.isFinite(range.revenueMilesPerCharge) ? Math.round(range.revenueMilesPerCharge) : null,
            tripsPerDay: Number.isFinite(digest.roundTripsPerDay) ? Math.round(digest.roundTripsPerDay * 10) / 10 : null
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
        paint: { "line-color": outcomeColorExpr(), "line-width": 4, "line-opacity": 0.95 }
      }, before);

      var popup = ensureHoverPopup();
      map.on("mousemove", ZEB_LAYER, function (e) {
        map.getCanvas().style.cursor = "pointer";
        if (!e.features || !e.features.length) return;
        var p = e.features[0].properties;
        var rtLabel = p.roundTrips != null ? (Math.round(p.roundTrips * 10) / 10) : "—";
        var html = '<div style="font-size:12px;line-height:1.4;">' +
          "<b>" + escapeHTML(p.name) + "</b> (" + escapeHTML(p.agency || "") + ")<br>" +
          "<b>" + escapeHTML(p.outcomeLabel || "") + "</b><br>" +
          rtLabel + " round trips per charge · " + p.milesPerCharge + " mi" +
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
      position: "bottom-left", width: 210, title: "Round trips per charge"
    });
    var outcomes = window.ZebDemoData.outcomes;
    for (var i = 0; i < 3; i++) {
      var swatch = document.getElementById("zebLegendSwatch" + i);
      var label = document.getElementById("zebLegendLabel" + i);
      var o = outcomes[i];
      if (!swatch || !o) continue;
      swatch.style.background = o.color;
      if (label) label.textContent = o.label;
    }
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
    ["zebBat40", "zebBase40", "zebBatCut", "zebBaseCut", "zebChargerKW", "zebSocBuffer", "zebDeadheadMi"].forEach(function (id) {
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
      var hideRow = document.getElementById("zebHideRow");
      if (hideRow) hideRow.style.display = "";
      var hideCb = document.getElementById("zebHideColoring");
      if (hideCb) {
        var vis = (App.map.getLayer(ZEB_LAYER) && App.map.getLayoutProperty(ZEB_LAYER, "visibility")) || "visible";
        hideCb.checked = (vis === "none");
      }
    } else {
      if (App.popup && App.popup.setLayoutMode) App.popup.setLayoutMode("setup");
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
  }

  // ---- Session persistence (settings only; geometry/results are not persisted) ----

  function saveZebState() {
    return { v: 2, settings: JSON.parse(JSON.stringify(_settings)) };
  }

  function restoreZebState(data) {
    if (!data || !data.settings) return;
    _settings = data.settings;
    // Merge defaults underneath whatever was restored so a v1 payload (which
    // carried assumptions.layover instead of assumptions.deadheadMi) restores
    // cleanly with the new key defaulted; the stale layover key is ignored.
    _settings.assumptions = Object.assign({}, defaultAssumptions(), _settings.assumptions || {});
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
    panelWidths: { setup: 600, results: 1040 },
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
