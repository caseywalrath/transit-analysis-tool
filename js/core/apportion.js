// js/core/apportion.js
// Census-geography apportionment (window.Apportion): for each geography, the
// share of its residents who live inside a study area, from 2020 census-block
// populations. Block GEOIDs nest inside block-group and tract GEOIDs, so
// membership is a string-prefix match, never a geometry test.
// CONSTRAINT: plain-value math only — no App, turf, DOM or map — so the golden
// harness can load it into a bare node:vm sandbox.
// Fallback per geography: population share, then housing-unit share when the
// population is all zero, then the caller's land-area fraction when there are
// no blocks to weigh.

(function () {
  "use strict";

  var METHODS = ["blockPop", "area", "whole"];

  var METHOD_LABELS = {
    blockPop: "2020 census-block population",
    area: "land area",
    whole: "whole geographies (no apportionment)"
  };

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // Non-numbers, NaN, Infinity and negatives count as zero. Letting a negative
  // through would shrink the denominator and push a share above its true value.
  function nonNegative(x) {
    return typeof x === "number" && isFinite(x) && x > 0 ? x : 0;
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function blockWeightedFractions(geoids, blocks, insideBlockIds, areaFractions) {
    var fractions = {};
    var basis = {};
    var requested = Array.isArray(geoids) ? geoids : [];
    var blockList = Array.isArray(blocks) ? blocks : [];
    var insideList = Array.isArray(insideBlockIds) ? insideBlockIds : [];
    var areas = areaFractions && typeof areaFractions === "object" ? areaFractions : null;
    var i;

    // Null-prototype lookups so a GEOID can never collide with an
    // Object.prototype key such as "constructor".
    var inside = Object.create(null);
    for (i = 0; i < insideList.length; i++) {
      if (typeof insideList[i] === "string") inside[insideList[i]] = true;
    }

    // First entry wins: a block listed twice must not be counted twice.
    var seen = Object.create(null);
    var unique = [];
    for (i = 0; i < blockList.length; i++) {
      var blk = blockList[i];
      if (!blk || typeof blk.geoid !== "string" || blk.geoid.length === 0) continue;
      if (seen[blk.geoid]) continue;
      seen[blk.geoid] = true;
      unique.push(blk);
    }

    var wanted = [];
    var lengthSeen = Object.create(null);
    var lengthList = [];
    for (i = 0; i < requested.length; i++) {
      var g = requested[i];
      // An empty string would prefix-match every block in the file, so it is
      // treated like any other unusable GEOID.
      if (typeof g !== "string" || g.length === 0) continue;
      wanted.push(g);
      if (!lengthSeen[g.length]) {
        lengthSeen[g.length] = true;
        lengthList.push(g.length);
      }
    }

    // One pass over the blocks per distinct GEOID length, not per geography, so
    // cost is O(blocks x distinct lengths) however many geographies are asked for.
    var totalsByLength = Object.create(null);
    for (var li = 0; li < lengthList.length; li++) {
      var len = lengthList[li];
      var byPrefix = Object.create(null);
      for (var j = 0; j < unique.length; j++) {
        var b = unique[j];
        if (b.geoid.length < len) continue;
        var key = b.geoid.slice(0, len);
        var t = byPrefix[key];
        if (!t) t = byPrefix[key] = { popAll: 0, popIn: 0, huAll: 0, huIn: 0 };
        var pop = nonNegative(b.pop);
        var hu = nonNegative(b.hu);
        t.popAll += pop;
        t.huAll += hu;
        if (inside[b.geoid] === true) {
          t.popIn += pop;
          t.huIn += hu;
        }
      }
      totalsByLength[len] = byPrefix;
    }

    var done = Object.create(null);
    for (i = 0; i < wanted.length; i++) {
      var geoid = wanted[i];
      if (done[geoid]) continue;
      done[geoid] = true;

      var totals = totalsByLength[geoid.length][geoid];
      var frac = 0;
      var how = "none";
      if (totals && totals.popAll > 0) {
        frac = totals.popIn / totals.popAll;
        how = "pop";
      } else if (totals && totals.huAll > 0) {
        frac = totals.huIn / totals.huAll;
        how = "hu";
      } else if (areas && hasOwn(areas, geoid) && typeof areas[geoid] === "number" && isFinite(areas[geoid])) {
        frac = areas[geoid];
        how = "area";
      }
      fractions[geoid] = clamp01(frac);
      basis[geoid] = how;
    }

    return { fractions: fractions, basis: basis };
  }

  // A missing or misspelled method still gets a readable label rather than a blank one.
  function methodLabel(method) {
    return typeof method === "string" && hasOwn(METHOD_LABELS, method)
      ? METHOD_LABELS[method]
      : "land area";
  }

  window.Apportion = {
    METHODS: METHODS,
    blockWeightedFractions: blockWeightedFractions,
    methodLabel: methodLabel
  };

})();
