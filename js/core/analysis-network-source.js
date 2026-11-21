// js/core/analysis-network-source.js — App.buildAnalysisNetwork: gathers the loaded GTFS feed and the
// drawn Services into the inputs of window.AnalysisNetwork.build (js/core/analysis-network.js).
// Reads App, turf and the feed only at call time.
(function () {
  "use strict";
  var App = window.App;

  var SPACING_MI = 0.25;          // Transit Travelshed's default spacing for a proposal without stops
  var FORWARD = { NB: true, EB: true, Outbound: true, CW: true, Loop: true, Both: true };
  var PROPOSAL_NOTE = "Proposals use evenly spaced trips from their headway bands.";

  function runtimeMin(p) {
    if (p.runTime > 0) return p.runTime;
    if (p.avgSpeed > 0 && p.lengthMiles > 0) return p.lengthMiles / p.avgSpeed * 60;
    return 0;
  }

  function featureOf(p) {
    var arr = p.featureType === "route" ? App.routes : App.lines;
    var prop = App.FEATURE_ID_PROP[p.featureType];
    for (var i = 0; i < (arr || []).length; i++) {
      if (arr[i] && arr[i].properties && arr[i].properties[prop] === p.featureId) return arr[i];
    }
    return null;
  }

  function lineOf(feature) {
    var g = feature && feature.geometry;
    if (!g) return null;
    if (g.type === "LineString") return feature;
    // A MultiLineString runs its parts end to end; distances along it follow that order.
    if (g.type === "MultiLineString") {
      var c = [];
      g.coordinates.forEach(function (part) { c = c.concat(part); });
      return c.length >= 2 ? turf.lineString(c) : null;
    }
    return null;
  }

  // Stops of one pattern with their distance along the line, in miles.
  function patternStops(svcKey, pi, p, feature, includeHidden, stopsOut) {
    var line = lineOf(feature), out = [];
    if (!line) return out;
    var lengthMi = turf.length(line, { units: "miles" });
    var pts = App.associatedStopPoints(p.featureType, feature, { includeHidden: includeHidden });
    pts.forEach(function (pt) {
      var id = "point-" + pt.properties[App.FEATURE_ID_PROP.point];
      var c = pt.geometry.coordinates, d;
      try { d = turf.nearestPointOnLine(line, turf.point(c), { units: "miles" }).properties.location; }
      catch (e) { return; }
      if (!stopsOut[id]) stopsOut[id] = { id: id, name: pt.properties.name || "", lat: c[1], lon: c[0] };
      out.push({ id: id, distMi: Math.max(0, Math.min(lengthMi, d)) });
    });
    if (out.length >= 2) return out;
    out = [];
    var n = Math.max(1, Math.round(lengthMi / SPACING_MI));
    for (var k = 0; k <= n; k++) {
      var dist = lengthMi * k / n, at = turf.along(line, dist, { units: "miles" }).geometry.coordinates;
      var sid = svcKey + "#" + pi + "#" + k;
      stopsOut[sid] = { id: sid, name: "", lat: at[1], lon: at[0] };
      out.push({ id: sid, distMi: dist });
    }
    return out;
  }

  function isHidden(feature) { return !!(feature && feature.properties && feature.properties.hidden); }

  // Drawn Services as proposals. A Service with blocking setup warnings, no run time or (unless
  // includeHidden) a hidden pattern is skipped and named in `skipped`.
  function collectProposals(includeHidden, serviceKeys) {
    var proposals = [], skipped = [];
    var want = Array.isArray(serviceKeys) ? serviceKeys : null;
    (App.buildTransitServices ? App.buildTransitServices() : []).forEach(function (svc) {
      if (want && want.indexOf(svc.key) < 0) return;
      if (App.hasBlockingWarnings(svc)) { skipped.push({ key: svc.key, name: svc.name, reason: "needs setup" }); return; }
      var stops = {}, patterns = [], hidden = false, noRun = false;
      svc.patterns.forEach(function (p, pi) {
        var f = featureOf(p);
        if (!f) return;
        if (isHidden(f) && !includeHidden) { hidden = true; return; }
        var rt = runtimeMin(p);
        if (!(rt > 0)) { noRun = true; return; }
        var line = lineOf(f);
        patterns.push({
          id: String(pi),
          directionId: FORWARD[p.direction] ? "0" : "1",
          both: svc.patterns.length === 1 && p.direction === "Both",
          bands: {
            weekday: App.getEffectiveServiceBands(p.service, "weekday"),
            saturday: App.getEffectiveServiceBands(p.service, "saturday"),
            sunday: App.getEffectiveServiceBands(p.service, "sunday")
          },
          runtimeMin: rt,
          lengthMi: line ? turf.length(line, { units: "miles" }) : 0,
          stops: patternStops(svc.key, pi, p, f, includeHidden, stops)
        });
      });
      if (!patterns.length) {
        skipped.push({ key: svc.key, name: svc.name, reason: hidden ? "hidden" : noRun ? "no run time" : "no line" });
        return;
      }
      var first = svc.patterns[0];
      var firstF = featureOf(first);
      var lineMode = firstF && firstF.properties && firstF.properties.attributes && firstF.properties.attributes.mode;
      proposals.push({
        key: svc.key, name: svc.name, color: first.color || "",
        mode: lineMode && /rail|tram|streetcar|subway|metro|train/i.test(lineMode) ? "rail" : "bus",
        stops: Object.keys(stops).map(function (k) { return stops[k]; }),
        patterns: patterns
      });
    });
    return { proposals: proposals, skipped: skipped };
  }

  // opts: { date (default the GTFS analysis date), includeHidden, gtfs (default true),
  //         proposals (default true; false = none; an array = those Service keys only) }
  // Returns the AnalysisNetwork.build result plus { proposalsSkipped: [{key, name, reason}],
  // notes: [string] }, or null when the engine is missing.
  App.buildAnalysisNetwork = function (opts) {
    opts = opts || {};
    if (!window.AnalysisNetwork) return null;
    var includeHidden = !!opts.includeHidden;
    var feed = opts.gtfs === false ? null : (App.gtfsSchedule ? App.gtfsSchedule() : null);
    var date = opts.date || (App.gtfsAnalysisDate ? App.gtfsAnalysisDate.get() : null);
    var routeIds = feed && App.gtfsScopeRouteIds ? App.gtfsScopeRouteIds(includeHidden) : null;
    var prop = opts.proposals === false ? { proposals: [], skipped: [] }
      : collectProposals(includeHidden, Array.isArray(opts.proposals) ? opts.proposals : null);
    var net = window.AnalysisNetwork.build({
      feed: feed, date: date, routeIds: routeIds, proposals: prop.proposals
    });
    net.proposalsSkipped = prop.skipped;
    net.notes = prop.proposals.length ? [PROPOSAL_NOTE] : [];
    return net;
  };

  // ---- Schedule travelshed (Transit Travelshed's "Schedule" mode) ----

  // Straight line × this factor stands in for the street walk between two stops: a pairwise street flood per
  // stop is too slow for a whole system, and transfers are short (a quarter mile at most).
  var TRANSFER_DETOUR = 1.3;

  function sortedStat(vals, which) {
    var v = vals.slice().sort(function (a, b) { return a - b; }), n = v.length;
    if (!n) return Infinity;
    if (which === "best") return v[0];
    if (which === "worst") return v[Math.ceil(0.9 * n) - 1];
    return v[(n - 1) >> 1];
  }

  // Transfers between stops within maxKm (straight line), on a 0.01° grid.
  function buildTransfers(stops, maxKm, kmPerSec) {
    var grid = Object.create(null), out = [], i;
    var cell = function (lat, lon) { return Math.floor(lat / 0.01) + ":" + Math.floor(lon / 0.01); };
    for (i = 0; i < stops.length; i++) {
      out.push([]);
      var s = stops[i];
      if (!isFinite(s.lat) || !isFinite(s.lon) || s.lat === null) continue;
      (grid[cell(s.lat, s.lon)] || (grid[cell(s.lat, s.lon)] = [])).push(i);
    }
    var span = Math.ceil(maxKm / 1.1) + 1;
    for (i = 0; i < stops.length; i++) {
      var a = stops[i];
      if (a.lat === null || !isFinite(a.lat) || !isFinite(a.lon)) continue;
      var cy = Math.floor(a.lat / 0.01), cx = Math.floor(a.lon / 0.01);
      for (var dy = -span; dy <= span; dy++) for (var dx = -span; dx <= span; dx++) {
        var list = grid[(cy + dy) + ":" + (cx + dx)];
        if (!list) continue;
        for (var k = 0; k < list.length; k++) {
          var j = list[k];
          if (j === i) continue;
          var b = stops[j];
          var km = turf.distance([a.lon, a.lat], [b.lon, b.lat], { units: "kilometers" }) * TRANSFER_DETOUR;
          if (km <= maxKm) out[i].push({ to: j, sec: km / kmPerSec });
        }
      }
    }
    return out;
  }

  // Area reachable from an origin within each budget, on the analysis network's real (and proposal) trips.
  //   opts : { origin: [lng, lat], budgetsMin: [..], fromSec, toSec (default from + 3600), stepSec (120),
  //            statistic "typical" | "best" | "worst", walkMph (3.1), accessMi (0.5), egressMi (0.25),
  //            transferMi (0.25), maxRounds (3), includeHidden, date, onProgress(text) }
  // Typical = median travel time over the departures, best = minimum, worst = 90th percentile.
  App.computeScheduleTravelshed = async function (opts) {
    opts = opts || {};
    if (!window.Raptor) throw new Error("The schedule router did not load.");
    if (!App.roadNetworkLoaded || !App.roadNetworkLoaded()) throw new Error("Load a street network first.");
    var progress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    var budgets = (opts.budgetsMin || []).filter(function (b) { return b > 0; });
    if (!budgets.length || !opts.origin) throw new Error("Pick an origin and at least one time budget.");
    var maxMin = Math.max.apply(null, budgets);
    var kmPerMin = (opts.walkMph > 0 ? opts.walkMph : 3.1) * 1.609344 / 60;
    var MI = 1.609344;
    var accessKm = (opts.accessMi > 0 ? opts.accessMi : 0.5) * MI;
    var egressKm = (opts.egressMi > 0 ? opts.egressMi : 0.25) * MI;
    var transferKm = (opts.transferMi >= 0 ? opts.transferMi : 0.25) * MI;
    var fromSec = isFinite(opts.fromSec) ? opts.fromSec : 7 * 3600;
    var toSec = isFinite(opts.toSec) && opts.toSec > fromSec ? opts.toSec : fromSec + 3600;
    var stepSec = opts.stepSec > 0 ? opts.stepSec : 120;
    var t0 = Date.now();

    progress("Building the network…");
    var netOpts = { includeHidden: !!opts.includeHidden };
    if (opts.date) netOpts.date = opts.date;
    var network = App.buildAnalysisNetwork(netOpts);
    if (!network || !network.trips.length) {
      throw new Error("No service on the analysis date. Load a GTFS feed or draw a Service with a schedule.");
    }

    progress("Walking to stops…");
    var near = [], nearLL = [];
    network.stops.forEach(function (s, i) {
      if (s.lat === null || !isFinite(s.lat)) return;
      if (turf.distance(opts.origin, [s.lon, s.lat], { units: "kilometers" }) <= accessKm) {
        near.push(i); nearLL.push([s.lon, s.lat]);
      }
    });
    var flood = App.computeMultiWalkCostMap([{ lngLat: opts.origin, id: "origin" }], accessKm);
    var walk = flood && flood.snapped ? App.walkKmToPoints(flood.distMap, nearLL) : near.map(function () { return Infinity; });
    var access = [];
    near.forEach(function (idx, k) { if (walk[k] <= accessKm) access.push({ stop: idx, sec: walk[k] / kmPerMin * 60 }); });
    var transfers = buildTransfers(network.stops, transferKm, kmPerMin / 60);

    var prep = window.Raptor.prepare(network);
    var deps = [];
    for (var d = fromSec; d < toSec; d += stepSec) deps.push(d);
    if (!deps.length) deps.push(fromSec);
    var times = network.stops.map(function () { return []; });
    var tr0 = Date.now();
    for (var di = 0; di < deps.length; di++) {
      var r = window.Raptor.route(prep, access, transfers, deps[di],
        { maxRounds: opts.maxRounds > 0 ? opts.maxRounds : 3, maxSec: maxMin * 60 });
      for (var si = 0; si < times.length; si++) times[si].push(r.arrival[si] - deps[di]);
      if (di % 3 === 2) {
        progress("Routing departure " + (di + 1) + " of " + deps.length + "…");
        await new Promise(function (res) { setTimeout(res, 0); });
      }
    }
    var routeMs = Date.now() - tr0;

    progress("Tracing the travelshed…");
    var stat = opts.statistic === "best" || opts.statistic === "worst" ? opts.statistic : "typical";
    var origins = [{ lngLat: opts.origin, offsetKm: 0, capKm: accessKm }];
    var reached = 0;
    times.forEach(function (list, i) {
      var t = sortedStat(list, stat), s = network.stops[i];
      if (!(t <= maxMin * 60) || s.lat === null) return;
      reached++;
      origins.push({ lngLat: [s.lon, s.lat], offsetKm: t / 60 * kmPerMin, capKm: egressKm });
    });
    var budgetsKm = budgets.map(function (b) { return b * kmPerMin; });
    var shed = App.computeOffsetWalkCostMap(origins, maxMin * kmPerMin, { contour: budgetsKm });
    return {
      bands: shed ? shed.bands : budgets.map(function () { return null; }),
      budgetsMin: budgets, statistic: stat, departures: deps.length, fromSec: fromSec, toSec: toSec, stepSec: stepSec,
      accessStops: access.length, stopsReached: reached, originSnapped: !!(flood && flood.snapped),
      date: network.date, dayType: network.dayType,
      gtfsTrips: network.counts.gtfsTrips, proposalTrips: network.counts.proposalTrips,
      proposalsSkipped: network.proposalsSkipped, notes: network.notes,
      gridKmUsed: shed ? shed.gridKmUsed : null, routeMs: routeMs, totalMs: Date.now() - t0
    };
  };
})();
