// js/core/raptor.js
// Schedule router (window.Raptor): earliest arrivals over the analysis network
// by round-based trip scanning (RAPTOR). Round k means k rides. A walk happens
// only from the origin (access) or once after a ride, never after another walk,
// so every journey is walk, ride, [walk transfer, ride]..., with at most maxRounds
// rides.
// CONSTRAINT: plain-value math only — no App, turf, DOM or map — so the golden
// harness can load it into a bare node:vm sandbox.
// Times are seconds after midnight. Unreached stops hold Infinity in the engine
// output; Raptor.evaluate writes them as null for the golden JSON.

(function () {
  "use strict";

  // Strict comparisons rather than subtraction: Infinity - Infinity is NaN, which
  // would make a sort comparator inconsistent.
  function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function newArray(n, fill) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = fill;
    return out;
  }

  // Sorting a copy keeps the caller's network.trips in its original order.
  // Trips are sorted by first departure so route() can stop scanning at the first
  // trip that leaves after the window closes.
  function prepare(network) {
    var stops = network && network.stops ? network.stops : [];
    var source = network && network.trips ? network.trips : [];
    var trips = source.slice().sort(function (a, b) {
      if (a.dep[0] !== b.dep[0]) return a.dep[0] - b.dep[0];
      return cmp(a.id, b.id);
    });
    var stopTrips = new Array(stops.length);
    for (var s = 0; s < stops.length; s++) stopTrips[s] = [];
    for (var i = 0; i < trips.length; i++) {
      var list = trips[i].stops;
      for (var j = 0; j < list.length; j++) {
        stopTrips[list[j]].push({ trip: i, pos: j });
      }
    }
    return { nStops: stops.length, trips: trips, stopTrips: stopTrips };
  }

  // Round 0 is the origin walk. Round k boards from the labels of round k-1 only,
  // so each round scans just what the previous one improved (standard RAPTOR).
  function route(prep, access, transfers, departSec, opts) {
    var o = opts || {};
    var maxRounds = o.maxRounds === undefined ? 3 : o.maxRounds;
    var maxSec = o.maxSec === undefined ? 7200 : o.maxSec;
    var minTransferSec = o.minTransferSec === undefined ? 0 : o.minTransferSec;
    var limit = departSec + maxSec;
    var n = prep.nStops;
    var trips = prep.trips;
    var best = newArray(n, Infinity);
    var rounds = newArray(n, -1);

    function offer(stop, t, round, label, marked, seen) {
      if (!(t <= limit) || t >= best[stop]) return;
      best[stop] = t;
      rounds[stop] = round;
      label[stop] = t;
      if (!seen[stop]) {
        seen[stop] = true;
        marked.push(stop);
      }
    }

    // Walks start from the stops reached in this step, whether or not that arrival
    // improved best. A walk-only arrival can never transfer again, so a later ride
    // arrival at the same stop must still be allowed to walk on.
    function walkFrom(sources, values, round, label, marked, seen) {
      for (var a = 0; a < sources.length; a++) {
        var legs = transfers ? transfers[sources[a]] : null;
        if (!legs) continue;
        for (var c = 0; c < legs.length; c++) {
          offer(legs[c].to, values[sources[a]] + legs[c].sec, round, label, marked, seen);
        }
      }
    }

    var label = newArray(n, Infinity);
    var marked = [];
    var seen = newArray(n, false);
    var originArr = newArray(n, Infinity);
    var originList = [];
    var i, j, q, p, k, ti, trip, stops, arr, dep, prevLabel, slack, s, t;
    var rideArr, rideList;

    if (access) {
      for (i = 0; i < access.length; i++) {
        s = access[i].stop;
        t = departSec + access[i].sec;
        if (!(t <= limit)) continue;
        if (t < originArr[s]) {
          if (originArr[s] === Infinity) originList.push(s);
          originArr[s] = t;
        }
        offer(s, t, 0, label, marked, seen);
      }
    }
    // No transfer walk straight after the access walk: access already comes from a street walk capped by
    // the caller, and chaining a transfer onto it would stretch that cap.

    for (k = 1; k <= maxRounds && marked.length > 0; k++) {
      prevLabel = label;
      label = newArray(n, Infinity);
      marked = [];
      seen = newArray(n, false);
      rideArr = newArray(n, Infinity);
      rideList = [];
      slack = k >= 2 ? minTransferSec : 0;
      for (ti = 0; ti < trips.length; ti++) {
        trip = trips[ti];
        if (trip.dep[0] > limit) break;
        stops = trip.stops;
        arr = trip.arr;
        dep = trip.dep;
        p = -1;
        for (j = 0; j < stops.length; j++) {
          if (prevLabel[stops[j]] + slack <= dep[j]) {
            p = j;
            break;
          }
        }
        if (p < 0) continue;
        for (q = p + 1; q < stops.length; q++) {
          s = stops[q];
          t = arr[q];
          if (!(t <= limit)) continue;
          if (t < rideArr[s]) {
            if (rideArr[s] === Infinity) rideList.push(s);
            rideArr[s] = t;
          }
          offer(s, t, k, label, marked, seen);
        }
      }
      walkFrom(rideList, rideArr, k, label, marked, seen);
    }

    return { arrival: best, rounds: rounds };
  }

  // Departures run fromSec, fromSec + step, ... while strictly before toSec, so
  // toSec itself is not a departure. The first departure always runs.
  function profile(prep, access, transfers, fromSec, toSec, stepSec, opts) {
    var step = stepSec === undefined ? 120 : stepSec;
    // A zero or negative step would never reach toSec and loop forever.
    if (!(step > 0)) throw new Error("Raptor.profile: stepSec must be positive");
    // Start times are computed from the index, not accumulated, so float error
    // cannot push a departure across toSec.
    var starts = [fromSec];
    for (var i = 1; fromSec + i * step < toSec; i++) starts.push(fromSec + i * step);

    var n = prep.nStops;
    var times = new Array(n);
    var s;
    for (s = 0; s < n; s++) times[s] = [];

    var onDeparture = opts && opts.onDeparture;
    var d, result;
    for (d = 0; d < starts.length; d++) {
      result = route(prep, access, transfers, starts[d], opts);
      for (s = 0; s < n; s++) times[s].push(result.arrival[s] - starts[d]);
      if (onDeparture) onDeparture(d, starts.length);
    }

    var m = starts.length;
    var best = new Array(n);
    var typical = new Array(n);
    var worst = new Array(n);
    for (s = 0; s < n; s++) {
      var sorted = times[s].sort(cmp);
      best[s] = sorted[0];
      // Lower median for an even count, so "typical" never rounds up to a later trip.
      typical[s] = sorted[(m - 1) >> 1];
      worst[s] = sorted[Math.ceil(0.9 * m) - 1];
    }
    return { departures: m, best: best, typical: typical, worst: worst };
  }

  // Test helper: runs route or profile on a freshly prepared network. Infinity
  // becomes null so golden JSON stays plain.
  function withNulls(x) {
    if (x === Infinity) return null;
    if (Array.isArray(x)) return x.map(withNulls);
    if (x !== null && typeof x === "object") {
      var out = {};
      for (var k in x) {
        if (Object.prototype.hasOwnProperty.call(x, k)) out[k] = withNulls(x[k]);
      }
      return out;
    }
    return x;
  }

  function evaluate(network, fnName, args) {
    var callArgs = [prepare(network)].concat(args || []);
    if (fnName === "route") return withNulls(route.apply(null, callArgs));
    if (fnName === "profile") return withNulls(profile.apply(null, callArgs));
    throw new Error("Raptor.evaluate: unknown function " + fnName);
  }

  window.Raptor = {
    prepare: prepare,
    route: route,
    profile: profile,
    evaluate: evaluate
  };

})();
