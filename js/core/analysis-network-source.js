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
      var lineMode = firstF && firstF.properties && firstF.properties.attributes && firstF.properties.attributes.lineMode;
      proposals.push({
        key: svc.key, name: svc.name, color: first.color || "",
        mode: lineMode && /rail|tram|subway|metro|train/i.test(lineMode) ? "rail" : "bus",
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
})();
