// js/core/analysis-network.js
// Analysis network — pure engine (window.AnalysisNetwork).
// Merges the GTFS trips of one date with synthetic trips for drawn proposals into one compact network
// (stops, routes, trips with stop times in seconds after the date's midnight, possibly past 86,400).
// CONSTRAINT: plain-JSON math only — no DOM, no turf, no App. It reads window.GtfsSchedule at call time
// only, so the golden harness can load it with gtfs-schedule.js alone. Nothing here throws on empty or
// unknown input; bad pieces are skipped or counted.
// Detail: docs/reference/modules/gtfs.md ("Analysis network")
//
// Exports (all on window.AnalysisNetwork): bandTrips, stopTimesAlong, proposalTrips, modeOf, build,
// stopService, evaluate.

(function () {
  "use strict";

  var RAIL_TYPES = { "0": true, "1": true, "2": true, "5": true, "7": true, "12": true };
  var MAX_TRIPS_PER_BAND = 1500;

  function gs() { return window.GtfsSchedule; }

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  // ---- Synthetic trips ----

  // Private copy of Trip Builder's parser: a core engine must not depend on a js/projects/ module, and the
  // generator below has to read band edges exactly as Trip Builder always has (NaN on bad input).
  function parseHHMMtoMin(s) {
    if (typeof s !== "string") return NaN;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return NaN;
    var h = parseInt(m[1], 10);
    var mn = parseInt(m[2], 10);
    if (h < 0 || h > 24 || mn < 0 || mn >= 60) return NaN;
    return h * 60 + mn;
  }

  // Trips for one pattern x one day type from headway bands: sorted [{ startMin, endMin }] in absolute
  // minutes (may exceed 1440 when a band wraps past midnight). Moved here from Trip Builder with its
  // output unchanged; Trip Builder's golden cases pin that.
  function bandTrips(bands, runtimeMin) {
    var trips = [];
    if (!Array.isArray(bands)) return trips;
    bands.forEach(function (b) {
      var headway = parseFloat(b && b.frequency);
      if (!(headway > 0)) return;             // blank/0 -> "no service in band"
      // Clamp to the UI's minimum (1 min) so a malformed import can't freeze the browser.
      if (headway < 1) headway = 1;
      var fromMin = parseHHMMtoMin(b && b.from);
      var toMin   = parseHHMMtoMin(b && b.to);
      if (!isFinite(fromMin) || !isFinite(toMin)) return;
      // Midnight wrap (e.g. 22:00 -> 02:00).
      if (toMin <= fromMin) toMin += 1440;
      // Generate from the band start, stepping by headway, while < band end.
      // Trips whose end exceeds the band end are still emitted.
      var emitted = 0;
      for (var t = fromMin; t < toMin; t += headway) {
        trips.push({ startMin: t, endMin: t + runtimeMin });
        if (++emitted >= MAX_TRIPS_PER_BAND) break;
      }
    });

    trips.sort(function (a, b) { return a.startMin - b.startMin; });
    return trips;
  }

  // Seconds after midnight at each distance along a line for a trip that starts at startMin and runs
  // runtimeMin end to end. A line with no usable length spreads the stops evenly by index instead, so a
  // proposal drawn with a zero-length or missing geometry still gets increasing times.
  function stopTimesAlong(startMin, runtimeMin, distMi, lengthMi) {
    var out = [], n = Array.isArray(distMi) ? distMi.length : 0, k, frac;
    var byIndex = !(isNum(lengthMi) && lengthMi > 0);
    for (k = 0; k < n; k++) {
      if (byIndex) frac = n > 1 ? k / (n - 1) : 0;
      else {
        frac = isNum(distMi[k]) ? distMi[k] / lengthMi : 0;
        frac = Math.min(1, Math.max(0, frac));
      }
      out.push(Math.round((startMin + runtimeMin * frac) * 60));
    }
    return out;
  }

  // Stops sorted by distance along the line; ties keep the caller's order (Array.sort is not stable
  // everywhere this runs).
  function sortedStops(stops) {
    var list = [], i;
    if (!Array.isArray(stops)) return list;
    for (i = 0; i < stops.length; i++) {
      var s = stops[i] || {};
      list.push({ id: String(s.id), d: isNum(s.distMi) ? s.distMi : 0, i: i });
    }
    list.sort(function (a, b) { return a.d !== b.d ? a.d - b.d : a.i - b.i; });
    return list;
  }

  // One direction's trips: every band trip gets stop times along stopList (already ordered for that way).
  function directionTrips(key, pattern, dirId, stopList, dayBands) {
    var out = [], runtime = pattern.runtimeMin, length = pattern.lengthMi;
    var trips = bandTrips(dayBands, runtime), dist = [], ids = [], k, t;
    for (k = 0; k < stopList.length; k++) { ids.push(stopList[k].id); dist.push(stopList[k].d); }
    for (t = 0; t < trips.length; t++) {
      var times = stopTimesAlong(trips[t].startMin, runtime, dist, length);
      out.push({
        id: key + "|" + pattern.id + "|" + dirId + "|" + trips[t].startMin,
        directionId: dirId, stops: ids.slice(), arr: times, dep: times.slice()
      });
    }
    return out;
  }

  // Trips of one drawn proposal on a day type. A pattern with no positive runtime or under two stops
  // makes none. "both" adds the way back over the reversed stop order.
  function proposalTrips(proposal, dayType) {
    var out = [];
    var p = proposal || {}, pats = Array.isArray(p.patterns) ? p.patterns : [];
    var key = String(p.key), i;
    for (i = 0; i < pats.length; i++) {
      var pat = pats[i];
      if (!pat || !(pat.runtimeMin > 0)) continue;
      var fwd = sortedStops(pat.stops);
      if (fwd.length < 2) continue;
      var dayBands = pat.bands ? pat.bands[dayType] || [] : [];
      var dirId = pat.directionId === undefined || pat.directionId === null || pat.directionId === "" ?
        "0" : String(pat.directionId);
      out = out.concat(directionTrips(key, pat, dirId, fwd, dayBands));
      if (pat.both) {
        var back = [], k, len = isNum(pat.lengthMi) ? pat.lengthMi : 0;
        for (k = fwd.length - 1; k >= 0; k--) back.push({ id: fwd[k].id, d: len - fwd[k].d });
        out = out.concat(directionTrips(key, pat, dirId === "1" ? "0" : "1", back, dayBands));
      }
    }
    out.sort(function (a, b) { return a.dep[0] !== b.dep[0] ? a.dep[0] - b.dep[0] : cmp(a.id, b.id); });
    return out;
  }

  // ---- Modes ----

  // Light rail, subway, rail, funicular, monorail and the extended rail type read as rail; everything
  // else (bus, ferry, ...) is bus.
  function modeOf(routeType) {
    var s = routeType === undefined || routeType === null ? "" : String(routeType).trim();
    return RAIL_TYPES[s] === true ? "rail" : "bus";
  }

  // ---- The network ----

  function stopNames(feed) {
    var m = Object.create(null), t = feed && feed.tables && feed.tables["stops.txt"];
    var rows = t && t.rows ? t.rows : [], i;
    for (i = 0; i < rows.length; i++) {
      var id = typeof rows[i].stop_id === "string" ? rows[i].stop_id.trim() : "";
      if (id !== "" && !(id in m)) m[id] = typeof rows[i].stop_name === "string" ? rows[i].stop_name.trim() : "";
    }
    return m;
  }

  function routeRecord(feed, routeId) {
    var r = feed._routes[routeId] || {};
    function f(k) { return typeof r[k] === "string" ? r[k].trim() : ""; }
    var color = f("route_color");
    return {
      key: "g:" + routeId, source: "gtfs", srcId: routeId,
      name: f("route_short_name") || f("route_long_name") || routeId,
      mode: modeOf(f("route_type")), color: color !== "" ? "#" + color : ""
    };
  }

  // Rows of a GTFS trip as [{stopId, arr, dep}] with times in seconds: a row blank on both sides is
  // dropped (counted), a row blank on one side copies the other. Null when under two rows remain.
  function gtfsRows(feed, tripId, counts) {
    var rows = gs().tripStopTimes(feed, tripId, { interpolate: true }), out = [], i;
    for (i = 0; i < rows.length; i++) {
      var a = rows[i].arr, d = rows[i].dep;
      if (a < 0 && d < 0) { counts.droppedRows++; continue; }
      if (a < 0) a = d;
      if (d < 0) d = a;
      out.push({ stopId: rows[i].stopId, arr: a, dep: d });
    }
    return out.length < 2 ? null : out;
  }

  // Merge GTFS trips of opts.date with the proposals' synthetic trips. Trips are collected with string
  // stop ids first; indices are assigned once the used stops are known and sorted.
  function build(opts) {
    var o = opts || {}, feed = o.feed || null, G = gs();
    var date = typeof o.date === "string" ? o.date : "";
    var counts = { gtfsTrips: 0, proposalTrips: 0, droppedRows: 0 };
    var stopInfo = Object.create(null), routes = Object.create(null), raw = [], i, j;
    var dayType = "weekday";
    if (feed && date !== "") {
      try { dayType = G.dayType(feed, date).dayType || "weekday"; } catch (e) { dayType = "weekday"; }
    } else if (/^\d{8}$/.test(date)) {
      // No feed (proposals only): the calendar weekday still picks the bands.
      var wd = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
      dayType = wd === 0 ? "sunday" : wd === 6 ? "saturday" : "weekday";
    }

    if (feed && date !== "") {
      var names = stopNames(feed);
      var list = G.tripsOnDate(feed, date, Array.isArray(o.routeIds) ? { routeIds: o.routeIds } : undefined).trips;
      for (i = 0; i < list.length; i++) {
        var tr = list[i], rows = gtfsRows(feed, tr.tripId, counts);
        if (!rows) continue;
        var rkey = "g:" + tr.routeId, ids = [], arr = [], dep = [];
        for (j = 0; j < rows.length; j++) {
          var sid = "g:" + rows[j].stopId;
          if (!stopInfo[sid]) {
            var rec = feed._stops[rows[j].stopId];
            stopInfo[sid] = {
              id: sid, srcId: rows[j].stopId, source: "gtfs",
              name: names[rows[j].stopId] || rows[j].stopId,
              lat: rec && rec.lat !== undefined ? rec.lat : null, lon: rec && rec.lon !== undefined ? rec.lon : null
            };
          }
          ids.push(sid); arr.push(rows[j].arr); dep.push(rows[j].dep);
        }
        if (!routes[rkey]) routes[rkey] = routeRecord(feed, tr.routeId);
        counts.gtfsTrips++;
        raw.push({ id: "g:" + tr.tripId, routeKey: rkey, source: "gtfs", directionId: tr.directionId,
          ids: ids, arr: arr, dep: dep });
      }
    }

    var props = Array.isArray(o.proposals) ? o.proposals : [];
    for (i = 0; i < props.length; i++) {
      var p = props[i];
      if (!p) continue;
      var pt = proposalTrips(p, dayType);
      if (pt.length === 0) continue;
      var dkey = "d:" + p.key, byId = Object.create(null), ps = Array.isArray(p.stops) ? p.stops : [];
      for (j = 0; j < ps.length; j++) if (ps[j] && !(String(ps[j].id) in byId)) byId[String(ps[j].id)] = ps[j];
      routes[dkey] = {
        key: dkey, source: "drawn", srcId: String(p.key), name: p.name ? String(p.name) : String(p.key),
        mode: p.mode === "rail" ? "rail" : "bus", color: p.color ? String(p.color) : ""
      };
      for (j = 0; j < pt.length; j++) {
        var t = pt[j], tids = [], k;
        for (k = 0; k < t.stops.length; k++) {
          var did = "d:" + t.stops[k];
          if (!stopInfo[did]) {
            var ds = byId[t.stops[k]] || {};
            stopInfo[did] = {
              id: did, srcId: t.stops[k], source: "drawn", name: ds.name ? String(ds.name) : t.stops[k],
              lat: isNum(ds.lat) ? ds.lat : null, lon: isNum(ds.lon) ? ds.lon : null
            };
          }
          tids.push(did);
        }
        counts.proposalTrips++;
        raw.push({ id: "d:" + t.id, routeKey: dkey, source: "drawn", directionId: t.directionId,
          ids: tids, arr: t.arr, dep: t.dep });
      }
    }

    var stops = [], stopIndex = Object.create(null), sk = Object.keys(stopInfo).sort();
    for (i = 0; i < sk.length; i++) { stops.push(stopInfo[sk[i]]); stopIndex[sk[i]] = i; }
    var trips = [];
    for (i = 0; i < raw.length; i++) {
      var r = raw[i], idx = [];
      for (j = 0; j < r.ids.length; j++) idx.push(stopIndex[r.ids[j]]);
      trips.push({ id: r.id, routeKey: r.routeKey, source: r.source, directionId: r.directionId,
        stops: idx, arr: r.arr, dep: r.dep });
    }
    trips.sort(function (a, b) { return a.dep[0] !== b.dep[0] ? a.dep[0] - b.dep[0] : cmp(a.id, b.id); });
    return { date: date, dayType: dayType, stops: stops, stopIndex: stopIndex,
      routes: routes, routeOrder: Object.keys(routes).sort(), trips: trips, counts: counts };
  }

  // ---- Service at stops ----

  // One row per stop with at least one departure (every row of a trip but its last). Counts, span and
  // headways match GtfsSchedule.stopServiceTable, so the two agree for a GTFS-only network.
  function stopService(network, dayParts) {
    var G = gs(), out = [];
    if (!network || !Array.isArray(network.trips) || !Array.isArray(network.stops)) return out;
    var parts = G.dayPartList(dayParts), deps = [], routes = [], i, j, k;
    for (k = 0; k < network.stops.length; k++) { deps.push(null); routes.push(null); }
    for (i = 0; i < network.trips.length; i++) {
      var t = network.trips[i];
      for (j = 0; j < t.stops.length - 1; j++) {
        k = t.stops[j];
        if (deps[k] === null) { deps[k] = []; routes[k] = Object.create(null); }
        deps[k].push(t.dep[j]);
        routes[k][t.routeKey] = true;
      }
    }
    for (k = 0; k < deps.length; k++) {
      if (deps[k] === null) continue;
      var d = deps[k].sort(function (a, b) { return a - b; });
      var heads = G.partHeadways(d, parts);
      out.push({
        stopId: network.stops[k].id, trips: d.length, routes: Object.keys(routes[k]).length,
        firstSec: d[0], lastSec: d[d.length - 1],
        peakHeadwaySec: G.pooledHeadway(heads, parts, G.isPeakPart),
        offPeakHeadwaySec: G.pooledHeadway(heads, parts, G.isOffPeakPart)
      });
    }
    out.sort(function (a, b) { return cmp(a.stopId, b.stopId); });
    return out;
  }

  // ---- Test helper ----

  // Like GtfsSchedule.evaluate: builds the feed from fixture texts so golden cases stay plain JSON.
  // "build" takes [opts]; "stopService" takes [opts, dayParts]. "stopServiceInvariant" compares a
  // GTFS-only network's rows with stopServiceTable for every non-station stop (mismatches must be empty).
  function evaluate(texts, fnName, args) {
    var G = gs(), feed = G.feedFromTexts(texts), a = args || [];
    var opts = {}, k;
    var given = a[0] || {};
    for (k in given) opts[k] = given[k];
    opts.feed = feed;
    if (fnName === "build") return build(opts);
    if (fnName === "stopService") return stopService(build(opts), a[1]);
    if (fnName === "stopServiceInvariant") {
      opts.proposals = [];
      var rows = stopService(build(opts), a[1]);
      var table = G.stopServiceTable(feed, opts.date, { routeIds: opts.routeIds || undefined, dayParts: a[1] });
      var byId = Object.create(null), checked = 0, bad = [], i;
      for (i = 0; i < table.length; i++) byId[table[i].stopId] = table[i];
      var seen = Object.create(null);
      for (i = 0; i < rows.length; i++) {
        var id = rows[i].stopId.substring(2), ref = byId[id];
        seen[id] = true;
        if (G.isStationStop(feed, id)) continue;
        checked++;
        if (!ref || ref.trips !== rows[i].trips || ref.routes !== rows[i].routes ||
            ref.firstSec !== rows[i].firstSec || ref.lastSec !== rows[i].lastSec ||
            ref.peakHeadwaySec !== rows[i].peakHeadwaySec || ref.offPeakHeadwaySec !== rows[i].offPeakHeadwaySec) {
          bad.push(id);
        }
      }
      for (i = 0; i < table.length; i++) {
        if (!seen[table[i].stopId] && !G.isStationStop(feed, table[i].stopId)) bad.push(table[i].stopId);
      }
      return { checked: checked, mismatches: bad.sort() };
    }
    return null;
  }

  window.AnalysisNetwork = {
    bandTrips: bandTrips, stopTimesAlong: stopTimesAlong, proposalTrips: proposalTrips,
    modeOf: modeOf, build: build, stopService: stopService, evaluate: evaluate
  };
})();
