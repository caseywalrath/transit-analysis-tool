// js/core/service-equity.js
// Service equity engine (window.ServiceEquity) for the Title VI service test.
// allocateStopTrips spreads each stop's trips over the census geographies that
// hold the population inside its walk radius; evaluate compares trips per
// resident for minority and low-income residents against everyone else, using
// the four-fifths rule.
// Block GEOIDs nest inside block-group and tract GEOIDs, so a geography's blocks
// are a string-prefix match, never a geometry test (as in apportion.js).
// CONSTRAINT: plain-value math only — no App, turf, DOM or map — so the golden
// harness can load it into a bare node:vm sandbox. ES5 syntax, like the rest of js/.

(function () {
  "use strict";

  var EARTH_RADIUS_MI = 3958.7613;

  // Rounded down from the true ~69.09 mi per degree of latitude. A slightly wide
  // scan window only costs a few extra cell lookups; the exact distance test
  // decides membership, so the rounding never changes a result.
  var MI_PER_DEG = 69;

  // Blocks are bucketed into 0.01-degree cells (about 0.7 mi) so a stop scans the
  // handful of cells its radius can reach instead of every block.
  var CELL_DEG = 0.01;

  var DEFAULT_PARENT_LENGTH = 12;
  var DEFAULT_FOUR_FIFTHS = 0.8;

  var GROUPS = [
    { key: "minority", field: "minorityPop", share: "minorityShare", flag: "isMinority" },
    { key: "lowIncome", field: "lowIncomePop", share: "lowIncomeShare", flag: "isLowIncome" }
  ];

  function isFiniteNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function isPositive(x) {
    return isFiniteNum(x) && x > 0;
  }

  // Non-numbers, NaN, Infinity and negatives count as zero. A negative population
  // would shrink the denominator and push every share above its true value.
  function nonNegative(x) {
    return isPositive(x) ? x : 0;
  }

  function cellKey(latCell, lonCell) {
    return latCell + ":" + lonCell;
  }

  // Point on the unit sphere. The dot product of two such vectors is the cosine of
  // the great-circle angle between them, which lets a cheap test reject far blocks
  // without any trigonometry per pair.
  function unitVector(lat, lon) {
    var phi = lat * Math.PI / 180;
    var lam = lon * Math.PI / 180;
    var c = Math.cos(phi);
    return { x: c * Math.cos(lam), y: c * Math.sin(lam), z: Math.sin(phi) };
  }

  // Two low-income definitions. C17002 rows 2-7 are the income-to-poverty bands
  // below 200%, summed; B17001_002E is the single below-poverty count. An
  // unrecognized value falls back to poverty100, so a misspelled setting still
  // yields a usable definition instead of none.
  function lowIncomeSpec(definition) {
    if (definition === "poverty200") {
      return {
        id: "poverty200",
        label: "Below 200% of the poverty level",
        vars: ["C17002_002E", "C17002_003E", "C17002_004E", "C17002_005E", "C17002_006E", "C17002_007E"]
      };
    }
    return { id: "poverty100", label: "Below the poverty level", vars: ["B17001_002E"] };
  }

  // Great-circle distance in miles (haversine). The clamp keeps rounding from
  // pushing h just outside [0, 1], where the square root would be NaN.
  function distanceMi(lat1, lon1, lat2, lon2) {
    var toRad = Math.PI / 180;
    var sLat = Math.sin((lat2 - lat1) * toRad / 2);
    var sLon = Math.sin((lon2 - lon1) * toRad / 2);
    var h = sLat * sLat + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * sLon * sLon;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    return 2 * EARTH_RADIUS_MI * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // stops:  [{ id, lat, lon, radiusMi, trips }]
  // blocks: [{ geoid, lat, lon, pop }]   (geoid is the 15-digit census block GEOID)
  // Bad stops (coordinates, radius or trips not a positive finite number) are
  // skipped entirely: they are neither allocated nor listed as unallocated. A
  // block with no usable GEOID or coordinates is also skipped, and it stays out of
  // each stop's population total, since it could never receive trips.
  // Returns { tripsByGeo, unallocated, unallocatedTrips, allocatedStops }.
  function allocateStopTrips(stops, blocks, opts) {
    var parentLength = opts && isPositive(opts.parentLength) ? opts.parentLength : DEFAULT_PARENT_LENGTH;
    var stopList = Array.isArray(stops) ? stops : [];
    var blockList = Array.isArray(blocks) ? blocks : [];
    var i, j;

    var cells = Object.create(null);
    for (i = 0; i < blockList.length; i++) {
      var b = blockList[i];
      if (!b || typeof b.geoid !== "string" || b.geoid.length === 0) continue;
      if (!isFiniteNum(b.lat) || !isFiniteNum(b.lon)) continue;
      var pop = nonNegative(b.pop);
      if (pop === 0) continue;
      var key = cellKey(Math.floor(b.lat / CELL_DEG), Math.floor(b.lon / CELL_DEG));
      var bucket = cells[key];
      if (!bucket) bucket = cells[key] = [];
      var u = unitVector(b.lat, b.lon);
      bucket.push({ geoid: b.geoid, lat: b.lat, lon: b.lon, pop: pop, x: u.x, y: u.y, z: u.z });
    }

    // Null-prototype map so a parent GEOID can never collide with an Object.prototype key.
    var tripsByGeo = Object.create(null);
    var unallocated = [];
    var unallocatedTrips = 0;
    var allocatedStops = 0;

    for (i = 0; i < stopList.length; i++) {
      var s = stopList[i];
      if (!s || !isFiniteNum(s.lat) || !isFiniteNum(s.lon)) continue;
      if (!isPositive(s.radiusMi) || !isPositive(s.trips)) continue;

      // The latitude window is the radius at 69 mi/deg. The longitude window uses
      // the cosine at the window's poleward edge, not at the stop: a block farther
      // from the equator than the stop spans more longitude per mile, so the
      // stop's own cosine would be too small and could miss it.
      var dLat = s.radiusMi / MI_PER_DEG;
      var latLo = Math.max(-90, s.lat - dLat);
      var latHi = Math.min(90, s.lat + dLat);
      var maxAbsLat = Math.max(Math.abs(latLo), Math.abs(latHi));
      var cosEdge = Math.cos(maxAbsLat * Math.PI / 180);
      // At the pole the cosine is zero, so the longitude window is the whole globe.
      var dLon = cosEdge > 1e-9 ? Math.min(180, s.radiusMi / (MI_PER_DEG * cosEdge)) : 180;
      var lonLo = s.lon - dLon;
      var lonHi = s.lon + dLon;

      var iLo = Math.floor(latLo / CELL_DEG);
      var iHi = Math.floor(latHi / CELL_DEG);
      var jLo = Math.floor(lonLo / CELL_DEG);
      var jHi = Math.floor(lonHi / CELL_DEG);

      // A block is within radius when its angle from the stop is at most radius / R,
      // i.e. when the dot product is at least cos(radius / R). The 1e-12 slack keeps
      // rounding from rejecting a block that is truly inside; only blocks the test
      // clearly rejects skip the exact haversine check below.
      var su = unitVector(s.lat, s.lon);
      var cosLimit = Math.cos(s.radiusMi / EARTH_RADIUS_MI) - 1e-12;

      var hits = [];
      var W = 0;
      for (var ci = iLo; ci <= iHi; ci++) {
        for (var cj = jLo; cj <= jHi; cj++) {
          var cell = cells[cellKey(ci, cj)];
          if (!cell) continue;
          for (j = 0; j < cell.length; j++) {
            var blk = cell[j];
            if (su.x * blk.x + su.y * blk.y + su.z * blk.z < cosLimit) continue;
            if (distanceMi(s.lat, s.lon, blk.lat, blk.lon) > s.radiusMi) continue;
            hits.push(blk);
            W += blk.pop;
          }
        }
      }

      if (W > 0) {
        allocatedStops++;
        for (j = 0; j < hits.length; j++) {
          var parent = hits[j].geoid.slice(0, parentLength);
          tripsByGeo[parent] = (tripsByGeo[parent] || 0) + s.trips * hits[j].pop / W;
        }
      } else {
        unallocated.push(s.id);
        unallocatedTrips += s.trips;
      }
    }

    return {
      tripsByGeo: tripsByGeo,
      unallocated: unallocated,
      unallocatedTrips: unallocatedTrips,
      allocatedStops: allocatedStops
    };
  }

  function emptyGroup() {
    return { geoCount: 0, pop: 0, trips: 0, perCapita: 0 };
  }

  function finishGroup(group) {
    group.perCapita = group.pop > 0 ? group.trips / group.pop : 0;
  }

  // rows: [{ geoid, pop, minorityPop, lowIncomePop, trips }]
  // A geography is "protected" for a group when its share of that group is strictly
  // above the study-wide share; geographies with no population are in neither group.
  // The band compares protected to other trips per resident. A zero-trip or
  // zero-population side has no ratio, so it reads as "insufficient" rather than
  // as a disparity.
  // Returns { totals, minority, lowIncome, geos, fourFifths }.
  function evaluate(rows, opts) {
    var rowList = Array.isArray(rows) ? rows : [];
    var fourFifths = opts && isFiniteNum(opts.fourFifths) ? opts.fourFifths : DEFAULT_FOUR_FIFTHS;
    var i, g;

    // Clean each row once so the passes below never see a raw value. A null row
    // still gets an entry, all zeros, so geos stays one-to-one with the input.
    var clean = [];
    var totalPop = 0;
    var totalTrips = 0;
    var sums = { minorityPop: 0, lowIncomePop: 0 };
    for (i = 0; i < rowList.length; i++) {
      var r = rowList[i] || {};
      var row = {
        geoid: r.geoid,
        pop: nonNegative(r.pop),
        trips: nonNegative(r.trips),
        minorityPop: nonNegative(r.minorityPop),
        lowIncomePop: nonNegative(r.lowIncomePop)
      };
      clean.push(row);
      totalPop += row.pop;
      totalTrips += row.trips;
      sums.minorityPop += row.minorityPop;
      sums.lowIncomePop += row.lowIncomePop;
    }

    var totals = {
      pop: totalPop,
      trips: totalTrips,
      perCapita: totalPop > 0 ? totalTrips / totalPop : 0
    };

    var result = {};
    var memberships = [];
    for (g = 0; g < GROUPS.length; g++) {
      var spec = GROUPS[g];
      var avgShare = totalPop > 0 ? sums[spec.field] / totalPop : 0;
      var protectedGroup = emptyGroup();
      var otherGroup = emptyGroup();
      var flags = [];
      for (i = 0; i < clean.length; i++) {
        var member = clean[i];
        var isProtected = member.pop > 0 && member[spec.field] / member.pop > avgShare;
        flags.push(isProtected);
        if (member.pop === 0) continue;
        var target = isProtected ? protectedGroup : otherGroup;
        target.geoCount++;
        target.pop += member.pop;
        target.trips += member.trips;
      }
      finishGroup(protectedGroup);
      finishGroup(otherGroup);

      var ratio = otherGroup.perCapita > 0 ? protectedGroup.perCapita / otherGroup.perCapita : null;
      if (protectedGroup.pop === 0 || otherGroup.pop === 0) ratio = null;

      result[spec.key] = {
        avgShare: avgShare,
        protected: protectedGroup,
        other: otherGroup,
        ratio: ratio,
        band: ratio === null ? "insufficient" : ratio < fourFifths ? "disparity" : "no-disparity"
      };
      memberships.push(flags);
    }

    var geos = [];
    for (i = 0; i < clean.length; i++) {
      var c = clean[i];
      var geo = {
        geoid: c.geoid,
        pop: c.pop,
        trips: c.trips,
        perCapita: c.pop > 0 ? c.trips / c.pop : 0,
        minorityShare: 0,
        lowIncomeShare: 0,
        isMinority: false,
        isLowIncome: false
      };
      for (g = 0; g < GROUPS.length; g++) {
        geo[GROUPS[g].share] = c.pop > 0 ? c[GROUPS[g].field] / c.pop : 0;
        geo[GROUPS[g].flag] = memberships[g][i];
      }
      geos.push(geo);
    }

    return {
      totals: totals,
      minority: result.minority,
      lowIncome: result.lowIncome,
      geos: geos,
      fourFifths: fourFifths
    };
  }

  window.ServiceEquity = {
    lowIncomeSpec: lowIncomeSpec,
    distanceMi: distanceMi,
    allocateStopTrips: allocateStopTrips,
    evaluate: evaluate
  };

})();
