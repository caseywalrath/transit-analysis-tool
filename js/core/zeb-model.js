// js/core/zeb-model.js
// Route Electrification Feasibility — pure calculation engine (window.ZEB),
// the same engine-namespace convention as window.Travelshed / window.TPI.
//
// CONSTRAINT: this file contains ONLY plain-JSON math — no turf, no DOM, no
// Map/Set, no App state. The golden harness (test/run-golden.mjs) loads this
// file directly into a bare node:vm sandbox with no turf and no browser
// globals, so every function here must accept and return plain
// numbers/strings/arrays/objects. GTFS parsing, shape-length lookups (turf),
// and map rendering live in js/projects/zeb-feasibility.js, which converts
// to/from these plain shapes at the boundary.
//
// Exports (all on window.ZEB): parseGtfsTime, pickRepresentativeService,
// buildBlocks, deadheadMiles, energyForBlock, tierFor, scoreFor,
// summarizeRoute, socProfile.

(function () {
  "use strict";
  var ZEB = window.ZEB = window.ZEB || {};

  // ---- Time parsing ----

  // "HH:MM:SS" -> minutes-from-midnight (fractional on non-zero seconds), or
  // null on blank/malformed input. Hours past 24 are valid in GTFS (a trip
  // that runs past midnight keeps counting up, e.g. "25:30:00" -> 1530).
  function parseGtfsTime(hhmmss) {
    if (typeof hhmmss !== "string") return null;
    var m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(hhmmss.trim());
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    var s = parseInt(m[3], 10);
    if (mi < 0 || mi >= 60 || s < 0 || s >= 60) return null;
    return h * 60 + mi + s / 60;
  }

  // ---- Representative service day ----

  // calendarRows: raw calendar.txt rows ({service_id, monday..sunday, ...}).
  // calendarDateRows: raw calendar_dates.txt rows (accepted for API symmetry
  // with the GTFS files digested per agency; not consulted by this
  // selection rule — every weekday/most-trips decision here is driven by
  // calendar.txt's weekday flags plus actual trip counts).
  // tripRows: pre-digested trips (see buildBlocks' input shape), each
  // carrying a camelCase serviceId.
  function pickRepresentativeService(calendarRows, calendarDateRows, tripRows) {
    tripRows = Array.isArray(tripRows) ? tripRows : [];
    if (tripRows.length === 0) {
      return { serviceId: null, tripCount: 0, reason: "no-trips" };
    }

    var tripCountByService = {};
    tripRows.forEach(function (t) {
      var sid = t && t.serviceId;
      if (!sid) return;
      tripCountByService[sid] = (tripCountByService[sid] || 0) + 1;
    });

    var WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    var weekdayCandidates = [];
    (Array.isArray(calendarRows) ? calendarRows : []).forEach(function (c) {
      if (!c || !c.service_id) return;
      var isWeekday = WEEKDAYS.every(function (day) { return String(c[day]) === "1"; });
      if (isWeekday) weekdayCandidates.push(c.service_id);
    });

    if (weekdayCandidates.length > 0) {
      var bestWeekday = weekdayCandidates[0];
      var bestWeekdayCount = tripCountByService[bestWeekday] || 0;
      weekdayCandidates.forEach(function (sid) {
        var count = tripCountByService[sid] || 0;
        if (count > bestWeekdayCount) {
          bestWeekday = sid;
          bestWeekdayCount = count;
        }
      });
      return { serviceId: bestWeekday, tripCount: bestWeekdayCount, reason: "weekday" };
    }

    var bestOverall = null;
    var bestOverallCount = -1;
    Object.keys(tripCountByService).forEach(function (sid) {
      if (tripCountByService[sid] > bestOverallCount) {
        bestOverall = sid;
        bestOverallCount = tripCountByService[sid];
      }
    });
    if (bestOverall == null) {
      return { serviceId: null, tripCount: 0, reason: "no-trips" };
    }
    return { serviceId: bestOverall, tripCount: bestOverallCount, reason: "most-trips" };
  }

  // ---- Geometry helper (no turf in this file — see header) ----

  // Straight-line distance in miles between two [lon, lat] points.
  function haversineMi(a, b) {
    if (!a || !b) return Infinity;
    var R = 3958.7613;
    var lat1 = a[1] * Math.PI / 180;
    var lat2 = b[1] * Math.PI / 180;
    var dLat = (b[1] - a[1]) * Math.PI / 180;
    var dLon = (b[0] - a[0]) * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // ---- Block building ----

  // trips: pre-digested trip objects, see docs/zeb-feasibility-demo-plan.md
  // Step 1.3: { tripId, routeId, serviceId, blockId, shapeId, startMin,
  // endMin, firstStopId, lastStopId, firstStop:[lon,lat], lastStop:[lon,lat],
  // miles }. opts: { maxLayoverMin, terminalToleranceMi }.
  function buildBlocks(trips, opts) {
    opts = opts || {};
    var maxLayoverMin = typeof opts.maxLayoverMin === "number" ? opts.maxLayoverMin : 30;
    var terminalToleranceMi = typeof opts.terminalToleranceMi === "number" ? opts.terminalToleranceMi : 0.3;

    trips = Array.isArray(trips) ? trips.filter(function (t) {
      return t && typeof t.startMin === "number" && typeof t.endMin === "number";
    }) : [];
    if (trips.length === 0) return [];

    var allHaveBlockId = trips.every(function (t) {
      return t.blockId != null && String(t.blockId).trim() !== "";
    });

    var groups;
    if (allHaveBlockId) {
      var byKey = {};
      var order = [];
      trips.forEach(function (t) {
        var key = (t.serviceId || "") + "|" + t.blockId;
        if (!byKey[key]) { byKey[key] = []; order.push(key); }
        byKey[key].push(t);
      });
      groups = order.map(function (key) {
        var ts = byKey[key].slice().sort(function (a, b) { return a.startMin - b.startMin; });
        return { blockId: ts[0].blockId, method: "block_id", trips: ts };
      });
    } else {
      groups = chainTrips(trips, maxLayoverMin, terminalToleranceMi);
    }

    var blocks = groups.map(summarizeBlock);
    blocks.sort(function (a, b) {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0;
    });
    return blocks;
  }

  // Greedy chaining: sort by start time; extend each block with the
  // earliest unassigned same-service trip that starts at/after the block's
  // current end within maxLayoverMin, and whose first stop is within
  // terminalToleranceMi of the block's current last stop.
  function chainTrips(trips, maxLayoverMin, terminalToleranceMi) {
    var sorted = trips.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var used = new Array(sorted.length);
    var groups = [];

    for (var i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      var block = [sorted[i]];
      used[i] = true;
      var cursorEnd = sorted[i].endMin;
      var cursorStop = sorted[i].lastStop;
      var cursorService = sorted[i].serviceId;

      var extended = true;
      while (extended) {
        extended = false;
        for (var j = 0; j < sorted.length; j++) {
          if (used[j]) continue;
          var cand = sorted[j];
          if (cand.serviceId !== cursorService) continue;
          if (!(cand.startMin >= cursorEnd)) continue;
          if (!(cand.startMin - cursorEnd <= maxLayoverMin)) continue;
          if (haversineMi(cand.firstStop, cursorStop) > terminalToleranceMi) continue;
          used[j] = true;
          block.push(cand);
          cursorEnd = cand.endMin;
          cursorStop = cand.lastStop;
          extended = true;
          break; // sorted ascending -> first match is the earliest candidate
        }
      }

      groups.push({ blockId: block[0].tripId, method: "chained", trips: block });
    }

    return groups;
  }

  function summarizeBlock(g) {
    var trips = g.trips.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var revenueMiles = 0;
    var routeIds = [];
    var tripIds = [];
    trips.forEach(function (t) {
      revenueMiles += typeof t.miles === "number" ? t.miles : 0;
      tripIds.push(t.tripId);
      if (t.routeId && routeIds.indexOf(t.routeId) === -1) routeIds.push(t.routeId);
    });
    var startMin = trips[0].startMin;
    var endMin = trips[trips.length - 1].endMin;
    return {
      blockId: g.blockId,
      serviceId: trips[0].serviceId,
      method: g.method,
      tripIds: tripIds,
      routeIds: routeIds,
      revenueMiles: revenueMiles,
      startMin: startMin,
      endMin: endMin,
      spanHours: (endMin - startMin) / 60,
      firstStop: trips[0].firstStop,
      lastStop: trips[trips.length - 1].lastStop,
      trips: trips
    };
  }

  // ---- Deadhead + energy ----

  function deadheadMiles(depot, block, circuity) {
    var c = typeof circuity === "number" ? circuity : 1.3;
    var out = haversineMi(depot, block && block.firstStop) * c;
    var back = haversineMi(block && block.lastStop, depot) * c;
    return { out: out, back: back, total: out + back };
  }

  function energyForBlock(block, params) {
    params = params || {};
    var vehicle = params.vehicle || {};
    var gradeFactor = typeof params.gradeFactor === "number" ? params.gradeFactor : 1;
    var seasonFactor = typeof params.seasonFactor === "number" ? params.seasonFactor : 1;
    var socBuffer = typeof params.socBuffer === "number" ? params.socBuffer : 0.2;
    var chargerKW = typeof params.chargerKW === "number" ? params.chargerKW : 150;
    var chargerEff = typeof params.chargerEff === "number" ? params.chargerEff : 0.9;
    var deadhead = params.deadheadMiles || { out: 0, back: 0, total: 0 };

    var revenueMiles = block && typeof block.revenueMiles === "number" ? block.revenueMiles : 0;
    var totalMiles = revenueMiles + (deadhead.total || 0);
    var kWhPerMi = (vehicle.baseKWhPerMi || 0) * gradeFactor * seasonFactor;
    var blockKWh = totalMiles * kWhPerMi;
    var requiredKWh = blockKWh / (1 - socBuffer);
    var batteryKWh = vehicle.batteryKWh;
    var ratio = batteryKWh ? requiredKWh / batteryKWh : Infinity;
    var endSoc = batteryKWh ? 1 - blockKWh / batteryKWh : -Infinity;
    var rechargeHours = blockKWh / (chargerKW * chargerEff);
    var spanHours = block && typeof block.spanHours === "number" ? block.spanHours : 0;
    var overnightHours = 24 - spanHours;
    var rechargeFits = rechargeHours <= overnightHours;

    return {
      totalMiles: totalMiles,
      kWhPerMi: kWhPerMi,
      blockKWh: blockKWh,
      requiredKWh: requiredKWh,
      ratio: ratio,
      endSoc: endSoc,
      rechargeHours: rechargeHours,
      overnightHours: overnightHours,
      rechargeFits: rechargeFits,
      vehicle: vehicle,
      gradeFactor: gradeFactor,
      seasonFactor: seasonFactor,
      socBuffer: socBuffer,
      chargerKW: chargerKW,
      chargerEff: chargerEff,
      deadheadMiles: deadhead
    };
  }

  // ---- Tier / score ----

  // tiers: ordered [{ tier, label, maxRatio, color, reason, rechargeReason? }].
  // The first entry with ratio <= maxRatio wins. If the depot-only recharge
  // does not fit overnight and the chosen tier is better than tier 4 (i.e.
  // tiers 1-3), downgrade to tier 4 with its rechargeReason.
  function tierFor(ratio, rechargeFits, tiers) {
    tiers = Array.isArray(tiers) ? tiers : [];
    var chosen = null;
    for (var i = 0; i < tiers.length; i++) {
      if (ratio <= tiers[i].maxRatio) { chosen = tiers[i]; break; }
    }
    if (!chosen && tiers.length) chosen = tiers[tiers.length - 1];
    if (!chosen) return { tier: null, label: null, reason: null };

    if (rechargeFits === false && chosen.tier < 4) {
      var tier4 = null;
      for (var j = 0; j < tiers.length; j++) {
        if (tiers[j].tier === 4) { tier4 = tiers[j]; break; }
      }
      if (tier4) return { tier: tier4.tier, label: tier4.label, reason: tier4.rechargeReason };
    }

    return { tier: chosen.tier, label: chosen.label, reason: chosen.reason };
  }

  function scoreFor(ratio) {
    var raw = Math.round(100 * (1.5 - ratio));
    return Math.max(0, Math.min(100, raw));
  }

  // ---- Route summary ----

  // blockResults: [{ block, energy, tier }] for every block whose routeIds
  // contains routeId. Governed by the worst (highest-ratio) block.
  function summarizeRoute(routeId, blockResults) {
    blockResults = Array.isArray(blockResults) ? blockResults : [];
    if (blockResults.length === 0) {
      return {
        routeId: routeId, blockCount: 0, governingBlockId: null,
        ratio: null, tier: null, label: null, score: null,
        blockKWh: null, requiredKWh: null, revenueMiles: null,
        longestBlockMiles: null, reason: null
      };
    }

    var governing = blockResults[0];
    var longestBlockMiles = 0;
    blockResults.forEach(function (br) {
      var miles = br.block && typeof br.block.revenueMiles === "number" ? br.block.revenueMiles : 0;
      if (miles > longestBlockMiles) longestBlockMiles = miles;
      if (br.energy.ratio > governing.energy.ratio) governing = br;
    });

    return {
      routeId: routeId,
      blockCount: blockResults.length,
      governingBlockId: governing.block ? governing.block.blockId : null,
      ratio: governing.energy.ratio,
      tier: governing.tier.tier,
      label: governing.tier.label,
      score: scoreFor(governing.energy.ratio),
      blockKWh: governing.energy.blockKWh,
      requiredKWh: governing.energy.requiredKWh,
      revenueMiles: governing.block ? governing.block.revenueMiles : null,
      longestBlockMiles: longestBlockMiles,
      reason: governing.tier.reason
    };
  }

  // ---- Block Detail SoC chart data ----

  // Points: [depot-departure] + [one per revenue trip, at its end] +
  // [depot-return]. Assumes 15 mph for the deadhead legs' time axis. The
  // deadhead-out leg's own energy share is folded into the drop shown at
  // the first trip's point (no separate marker for it) so the final point's
  // soc lands exactly on energy.endSoc — energy conservation across the
  // whole block, not per-leg precision, is what this chart is for.
  function socProfile(block, energy, params) {
    params = params || {};
    var vehicle = params.vehicle || (energy && energy.vehicle) || {};
    var batteryKWh = vehicle.batteryKWh || 0;
    var deadhead = (energy && energy.deadheadMiles) || { out: 0, back: 0, total: 0 };
    var totalMiles = energy && typeof energy.totalMiles === "number" ? energy.totalMiles : 0;
    var blockKWh = energy && typeof energy.blockKWh === "number" ? energy.blockKWh : 0;
    var trips = (block && Array.isArray(block.trips)) ?
      block.trips.slice().sort(function (a, b) { return a.startMin - b.startMin; }) : [];

    var DEADHEAD_MPH = 15;
    var deadheadOutMin = (deadhead.out || 0) / DEADHEAD_MPH * 60;
    var deadheadBackMin = (deadhead.back || 0) / DEADHEAD_MPH * 60;

    function shareOf(miles) {
      return totalMiles > 0 && batteryKWh > 0 ? (miles / totalMiles) * blockKWh / batteryKWh : 0;
    }

    var points = [];
    var soc = 1.0;
    var startMin = (block && typeof block.startMin === "number" ? block.startMin : 0) - deadheadOutMin;
    points.push({ min: startMin, soc: soc, label: "deadhead" });

    var pendingShare = shareOf(deadhead.out || 0);
    trips.forEach(function (t) {
      soc -= pendingShare + shareOf(t.miles || 0);
      pendingShare = 0;
      points.push({ min: t.endMin, soc: soc, label: t.routeId || "deadhead" });
    });

    soc -= pendingShare + shareOf(deadhead.back || 0);
    var endMin = (block && typeof block.endMin === "number" ? block.endMin : 0) + deadheadBackMin;
    points.push({ min: endMin, soc: soc, label: "deadhead" });

    return points;
  }

  // ---- Exports ----

  ZEB.parseGtfsTime = parseGtfsTime;
  ZEB.pickRepresentativeService = pickRepresentativeService;
  ZEB.buildBlocks = buildBlocks;
  ZEB.deadheadMiles = deadheadMiles;
  ZEB.energyForBlock = energyForBlock;
  ZEB.tierFor = tierFor;
  ZEB.scoreFor = scoreFor;
  ZEB.summarizeRoute = summarizeRoute;
  ZEB.socProfile = socProfile;

})();
