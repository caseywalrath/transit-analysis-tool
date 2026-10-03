// js/core/travelshed.js
// Transit Travelshed — pure calculation engine (window.Travelshed), the same
// engine-namespace convention as window.TPI / window.RidershipModel.
//
// CONSTRAINT: this file contains ONLY plain-JSON math — no turf, no DOM, no
// Map/Set, no App state. Why: the golden harness (test/run-golden.mjs) loads
// this file directly into a bare node:vm sandbox with no turf and no browser
// globals, so every function here must accept and return plain
// numbers/strings/arrays/objects. Everything needing turf or the road graph
// (stop resolution, snap/flood caches, rendering) lives in
// js/core/road-network.js or js/projects/transit-travelshed.js, which convert
// to/from these plain shapes at the boundary.
//
// Exports (all on window.Travelshed): parseHHMMtoMin, selectActiveBand,
// initialWait, transferWait, rideMinAtDistance, sampleStopPositions,
// propagateRide, bandNodeSets, computeArrivalTimes.

(function () {
  "use strict";

  // ---- Time parsing / band selection ----

  // Parse "HH:MM" -> minutes-from-midnight, or null on bad input. Re-implemented
  // rather than imported — a core engine must not depend on a js/projects/
  // module — but the semantics deliberately mirror trip-builder.js:164
  // parseHHMMtoMin (that one returns NaN instead of null; every caller here
  // treats null as "not a number" the same way, via Number.isFinite checks).
  function parseHHMMtoMin(s) {
    if (typeof s !== "string") return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var mn = parseInt(m[2], 10);
    if (h < 0 || h > 24 || mn < 0 || mn >= 60) return null;
    return h * 60 + mn;
  }

  // Find the band active at analysisMin, or null (no band covers that time, or
  // every band has a blank/zero frequency). Wrap-aware: a band whose "to" is
  // <= its "from" is treated as spanning past midnight (toMin += 1440), and a
  // band matches at either analysisMin or analysisMin + 1440 — mirrors the
  // midnight-wrap convention in trip-builder.js:164 generateTripsForPattern
  // (reused, not reinvented, per the plan's verified reference points).
  function selectActiveBand(bands, analysisMin) {
    if (!Array.isArray(bands)) return null;
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      var freq = parseFloat(b && b.frequency);
      if (!(freq > 0)) continue; // blank/0 frequency = no service in this band

      var fromMin = parseHHMMtoMin(b && b.from);
      var toMin = parseHHMMtoMin(b && b.to);
      if (fromMin == null || toMin == null) continue;
      if (toMin <= fromMin) toMin += 1440;

      if (analysisMin >= fromMin && analysisMin < toMin) {
        return { fromMin: fromMin, toMin: toMin, headwayMin: freq };
      }
      var wrapped = analysisMin + 1440;
      if (wrapped >= fromMin && wrapped < toMin) {
        return { fromMin: fromMin, toMin: toMin, headwayMin: freq };
      }
    }
    return null;
  }

  // ---- Wait model (see docs/archive/transit-travelshed-plan.md Appendix A) ----

  // Initial (unlinked) boarding: riders can time their arrival for infrequent
  // service, so physical wait is capped — min(half-headway, Wmax) — plus a
  // fixed boarding penalty applied at every boarding.
  function initialWait(headwayMin, maxWaitMin, boardingPenaltyMin) {
    return Math.min(headwayMin / 2, maxWaitMin) + boardingPenaltyMin;
  }

  // Transfer boarding: the feeder vehicle's schedule dictates the transferring
  // rider's arrival, so schedule-timing does not apply — uncapped half-headway.
  function transferWait(headwayMin, boardingPenaltyMin) {
    return headwayMin / 2 + boardingPenaltyMin;
  }

  // ---- Ride time ----

  // runTimeMin (one-way, minutes) wins when present — distributed proportionally
  // over the pattern's length by distance-along. Otherwise distance / speed.
  // The avgSpeedMph default (14) is applied by the CALLER (module); this
  // function trusts whatever it's given.
  function rideMinAtDistance(distMi, lengthMi, runTimeMin, avgSpeedMph) {
    if (runTimeMin > 0) {
      if (!(lengthMi > 0)) return 0;
      return (distMi / lengthMi) * runTimeMin;
    }
    if (!(avgSpeedMph > 0)) return 0;
    return (distMi / avgSpeedMph) * 60;
  }

  // ---- Synthetic stop sampling ----

  // Evenly spaced positions along a pattern for features with zero real
  // (associatedRoutes) stops. Endpoints are always included; the final gap may
  // be shorter than spacingMi. A pattern shorter than (or equal to) the spacing
  // is degenerate — just its two endpoints.
  function sampleStopPositions(lengthMi, spacingMi) {
    if (!(lengthMi > 0) || !(spacingMi > 0) || lengthMi <= spacingMi) {
      return [0, lengthMi];
    }
    var EPS = 1e-9;
    var positions = [];
    var d = 0;
    while (d < lengthMi - EPS) {
      positions.push(d);
      d += spacingMi;
    }
    positions.push(lengthMi);
    return positions;
  }

  // ---- Ride propagation from a boarding stop ----

  // stops = [{rideMin}] in drawn order. opts = { mode: "both"|"forward",
  // loop: null|{cycleMin} }.
  //   "both"    -> arrive[i] = boardTime + |rideMin[i] - rideMin[boardIdx]|
  //                (undirected — Both rides both ways along the geometry).
  //   "forward" (no loop) -> downstream only (index > boardIdx), in drawn order.
  //   "forward" + loop    -> every OTHER stop, via (delta + cycleMin) % cycleMin
  //                so the ride wraps around a closed Loop/CW/CCW geometry.
  // Returns [{stopIdx, arriveMin}], excluding the boarding stop itself.
  function propagateRide(stops, boardIdx, boardTimeMin, opts) {
    opts = opts || {};
    var loop = opts.loop || null;
    var mode = opts.mode || "forward";
    var boardRideMin = stops[boardIdx].rideMin;
    var results = [];

    for (var i = 0; i < stops.length; i++) {
      if (i === boardIdx) continue;
      var delta = stops[i].rideMin - boardRideMin;
      var arriveMin;

      if (mode === "both") {
        arriveMin = boardTimeMin + Math.abs(delta);
      } else if (loop && loop.cycleMin > 0) {
        var wrapped = ((delta % loop.cycleMin) + loop.cycleMin) % loop.cycleMin;
        arriveMin = boardTimeMin + wrapped;
      } else {
        if (i < boardIdx) continue; // forward, no loop: downstream only
        arriveMin = boardTimeMin + delta;
      }

      results.push({ stopIdx: i, arriveMin: arriveMin });
    }
    return results;
  }

  // ---- Banding ----

  // nodeTimes: { nodeKey: minutes }. Each band's node set is CUMULATIVE (every
  // node whose time is <= that band's budget) — ring differencing (subtracting
  // the previous band's polygon) happens in the module, not here.
  function bandNodeSets(nodeTimes, budgetsMin) {
    var keys = Object.keys(nodeTimes);
    return budgetsMin.map(function (budgetMin) {
      var nodeKeys = keys.filter(function (k) { return nodeTimes[k] <= budgetMin; });
      return { budgetMin: budgetMin, nodeKeys: nodeKeys };
    });
  }

  // ---- The core: layered-flood arrival-time propagation ----

  // input = {
  //   budgetMin, walkSpeedKmh, maxInitialWaitMin, boardingPenaltyMin, transferCap,
  //   originCost: { nodeKey: distKm },
  //   routes: [{ routeId, mode, loop, headwayMin,
  //              stops: [{ stopKey, rideMin, access: [{nodeKey, extraKm}, ...] }] }],
  //   stopCosts: { stopKey: { nodeKey: distKm } }
  // }
  // returns = {
  //   nodeTimes: { nodeKey: minutes },
  //   routeDiags: [{ routeId, boardings, firstBoardMin, usedTransfer }],
  //   stats: { stopsConsidered, stopsBoarded, transferBoardings, nodesReached }
  // }
  //
  // All plain-object loops in a fixed (input) order, so results are
  // deterministic and golden-pinnable. See docs/archive/transit-travelshed-plan.md
  // Phase 3 for the full step-by-step derivation.
  function computeArrivalTimes(input) {
    var budgetMin = input.budgetMin;
    var walkSpeedKmh = input.walkSpeedKmh;
    var maxInitialWaitMin = input.maxInitialWaitMin;
    var boardingPenaltyMin = input.boardingPenaltyMin;
    var transferCap = (input.transferCap != null) ? input.transferCap : 1;
    var originCost = input.originCost || {};
    var routes = input.routes || [];
    var stopCosts = input.stopCosts || {};

    // Walk-leg caps (minutes). null/undefined = uncapped — backward compatible
    // with callers/golden cases that predate v2's shedMode split.
    var accessMax = (input.accessMaxMin != null) ? input.accessMaxMin : Infinity;
    var transferMax = (input.transferMaxMin != null) ? input.transferMaxMin : Infinity;
    var egressMax = (input.egressMaxMin != null) ? input.egressMaxMin : Infinity;

    var walkMinPerKm = 60 / walkSpeedKmh;

    // 1. Seed nodeTimes from the origin flood, capped at the access walk limit.
    var nodeTimes = {};
    Object.keys(originCost).forEach(function (k) {
      var t = originCost[k] * walkMinPerKm;
      if (t <= budgetMin && t <= accessMax) nodeTimes[k] = t;
    });

    // 2. Walk-to-stop time from an arbitrary cost map via a stop's access nodes.
    // walkCapMin bounds the WALK COMPONENT only (never baseMin) — round 0 (access)
    // passes accessMax, rounds >=1 (transfer) pass transferMax.
    function stopArrivalFrom(costObj, stop, baseMin, walkCapMin) {
      if (!costObj) return Infinity;
      var best = Infinity;
      var access = stop.access || [];
      for (var i = 0; i < access.length; i++) {
        var a = access[i];
        var d = costObj[a.nodeKey];
        if (d == null) continue;
        var cand = (d + a.extraKm) * walkMinPerKm;
        if (cand > walkCapMin) continue;
        if (cand < best) best = cand;
      }
      return (best === Infinity) ? Infinity : baseMin + best;
    }

    // 4. Egress merge: sweep an alighting stop's own flood into nodeTimes,
    // capping the walk component at egressMax in addition to the total budget.
    // (The boarding stop's flood is never merged here — propagateRide already
    // excludes the boarding stop from its results.)
    function egressMerge(alightMin, stopKey) {
      var costObj = stopCosts[stopKey];
      if (!costObj) return;
      Object.keys(costObj).forEach(function (nodeKey) {
        var walkMin = costObj[nodeKey] * walkMinPerKm;
        if (walkMin > egressMax) return;
        var cand = alightMin + walkMin;
        if (cand > budgetMin) return;
        if (nodeTimes[nodeKey] == null || cand < nodeTimes[nodeKey]) {
          nodeTimes[nodeKey] = cand;
        }
      });
    }

    var diagByRoute = {};
    routes.forEach(function (r) {
      diagByRoute[r.routeId] = { routeId: r.routeId, boardings: 0, firstBoardMin: null, usedTransfer: false };
    });

    var stats = { stopsConsidered: 0, stopsBoarded: 0, transferBoardings: 0, nodesReached: 0 };
    routes.forEach(function (r) { stats.stopsConsidered += (r.stops || []).length; });

    var priorAlightings = null; // alighting events from the previous round: [{routeId, stopKey, alightMin}]
    var bestAlightings = {}; // stopKey -> best {stopKey, alightMin} across ALL rounds (returned as `alightings`)

    for (var round = 0; round <= transferCap; round++) {
      var newAlightings = {}; // stopKey -> best {routeId, stopKey, alightMin} this round
      var walkCapMin = (round === 0) ? accessMax : transferMax;

      routes.forEach(function (route) {
        var stops = route.stops || [];
        for (var si = 0; si < stops.length; si++) {
          var stop = stops[si];
          var arrive;

          if (round === 0) {
            // 3. Round 0 (initial boardings): arrival from the origin flood.
            arrive = stopArrivalFrom(originCost, stop, 0, walkCapMin);
          } else {
            // 5. Round r>=1 (transfers): best arrival via any alighting event
            // from a DIFFERENT route in the prior round (no same-route re-board).
            arrive = Infinity;
            for (var ei = 0; ei < priorAlightings.length; ei++) {
              var e = priorAlightings[ei];
              if (e.routeId === route.routeId) continue;
              var cand = stopArrivalFrom(stopCosts[e.stopKey], stop, e.alightMin, walkCapMin);
              if (cand < arrive) arrive = cand;
            }
          }
          if (arrive === Infinity) continue;

          var wait = (round === 0)
            ? initialWait(route.headwayMin, maxInitialWaitMin, boardingPenaltyMin)
            : transferWait(route.headwayMin, boardingPenaltyMin);
          var boardTimeMin = arrive + wait;
          if (!(boardTimeMin < budgetMin)) continue; // can't board in time

          var diag = diagByRoute[route.routeId];
          diag.boardings++;
          if (diag.firstBoardMin == null || boardTimeMin < diag.firstBoardMin) diag.firstBoardMin = boardTimeMin;
          if (round > 0) diag.usedTransfer = true;
          stats.stopsBoarded++;
          if (round > 0) stats.transferBoardings++;

          var routeAlightings = propagateRide(stops, si, boardTimeMin, { mode: route.mode, loop: route.loop });
          for (var ai = 0; ai < routeAlightings.length; ai++) {
            var al = routeAlightings[ai];
            if (al.arriveMin > budgetMin) continue;
            var alightStopKey = stops[al.stopIdx].stopKey;

            egressMerge(al.arriveMin, alightStopKey);

            var existing = newAlightings[alightStopKey];
            if (!existing || al.arriveMin < existing.alightMin) {
              newAlightings[alightStopKey] = { routeId: route.routeId, stopKey: alightStopKey, alightMin: al.arriveMin };
            }

            var bestExisting = bestAlightings[alightStopKey];
            if (!bestExisting || al.arriveMin < bestExisting.alightMin) {
              bestAlightings[alightStopKey] = { stopKey: alightStopKey, alightMin: al.arriveMin };
            }
          }
        }
      });

      priorAlightings = Object.keys(newAlightings).map(function (k) { return newAlightings[k]; });
      if (round === transferCap) break;
      if (!priorAlightings.length) break; // nothing to transfer from — stop early
    }

    stats.nodesReached = Object.keys(nodeTimes).length;

    return {
      nodeTimes: nodeTimes,
      routeDiags: Object.keys(diagByRoute).map(function (k) { return diagByRoute[k]; }),
      alightings: Object.keys(bestAlightings).map(function (k) { return bestAlightings[k]; }),
      stats: stats
    };
  }

  // ---- Exports ----

  window.Travelshed = {
    parseHHMMtoMin: parseHHMMtoMin,
    selectActiveBand: selectActiveBand,
    initialWait: initialWait,
    transferWait: transferWait,
    rideMinAtDistance: rideMinAtDistance,
    sampleStopPositions: sampleStopPositions,
    propagateRide: propagateRide,
    bandNodeSets: bandNodeSets,
    computeArrivalTimes: computeArrivalTimes
  };

})();
