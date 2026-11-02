// js/core/walk-shape.js
// Walkshed boundary cleanup (window.WalkShape): the "Smoothed" shape method.
// Takes the concave-hull polygon road-network.js builds and fills small holes,
// closes narrow notches, and rounds corners, so the outline reads as a clean
// service area instead of a jagged hull. Display/study-area geometry only —
// the flood and its distances are never touched.
// CONSTRAINT: no DOM and no App state; reads `turf` at CALL time only, so the
// file loads before/without turf. Detail: docs/reference/road-network.md.

(function () {
  "use strict";

  var M2_PER_ACRE = 4046.86;

  function isAreal(f) {
    return !!(f && f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      f.geometry.coordinates && f.geometry.coordinates.length);
  }

  function ringArea(ring) {
    return turf.area({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
  }

  function withProps(geom, src) {
    return { type: "Feature", properties: (src && src.properties) || {}, geometry: geom };
  }

  // Drops every interior ring smaller than holeAcres acres (holes at or above
  // the threshold stay: a lake is a real barrier, a block missing its streets
  // is not). holeAcres <= 0 / non-numeric keeps everything. Returns a new
  // Feature; the input is never mutated. Never null for a non-null input.
  function fillHoles(feature, holeAcres) {
    if (!isAreal(feature) || !(holeAcres > 0)) return feature;
    var limit = holeAcres * M2_PER_ACRE;
    function keep(poly) {
      var out = [poly[0]];
      for (var i = 1; i < poly.length; i++) {
        var a;
        try { a = ringArea(poly[i]); } catch (e) { a = Infinity; }
        if (a >= limit) out.push(poly[i]);
      }
      return out;
    }
    var g = feature.geometry;
    var geom = (g.type === "Polygon")
      ? { type: "Polygon", coordinates: keep(g.coordinates) }
      : { type: "MultiPolygon", coordinates: g.coordinates.map(keep) };
    return withProps(geom, feature);
  }

  // Adds vertices along every edge longer than maxSegKm (in place on a copy).
  // Chaikin smoothing cuts each corner back by a quarter of its adjacent edges,
  // so on the long straight edges of a simplified hull it eats whole corners
  // (a plain rectangle loses ~16% of its area in two passes). Capping edge
  // length first confines the rounding to roughly the Edge-rounding distance.
  function densify(feature, maxSegKm) {
    var kmLat = 110.574;
    function ring(r) {
      var out = [];
      for (var i = 0; i < r.length - 1; i++) {
        var a = r[i], b = r[i + 1];
        out.push(a);
        var kmLng = 111.32 * Math.cos(a[1] * Math.PI / 180);
        var len = Math.sqrt(Math.pow((b[0] - a[0]) * kmLng, 2) + Math.pow((b[1] - a[1]) * kmLat, 2));
        var n = Math.ceil(len / maxSegKm);
        for (var k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      }
      out.push(r[r.length - 1]);
      return out;
    }
    var g = feature.geometry;
    var geom = (g.type === "Polygon")
      ? { type: "Polygon", coordinates: g.coordinates.map(ring) }
      : { type: "MultiPolygon", coordinates: g.coordinates.map(function (p) { return p.map(ring); }) };
    return withProps(geom, feature);
  }

  // refine(polygonFeature, { holeAcres, roundKm }) -> Feature<Polygon|MultiPolygon>
  // Steps: fill holes, close (buffer out then in), simplify (~3 m), Chaikin
  // smooth, validate (self-intersections fall back to the simplified shape),
  // fill holes again. Each step is wrapped: a throw or an invalid/empty result
  // keeps the previous step's output, so a non-null input never yields null.
  function refine(feature, opts) {
    if (!isAreal(feature) || typeof turf === "undefined") return feature;
    opts = opts || {};
    var holeAcres = opts.holeAcres, roundKm = opts.roundKm;

    function step(cur, fn) {
      try {
        var next = fn(cur);
        return isAreal(next) ? next : cur;
      } catch (e) { return cur; }
    }

    var p = step(feature, function (c) { return fillHoles(c, holeAcres); });

    if (roundKm > 0) {
      p = step(p, function (c) {
        var grown = turf.buffer(c, roundKm, { units: "kilometers" });
        return turf.buffer(grown, -roundKm, { units: "kilometers" });
      });
    }

    p = step(p, function (c) { return turf.simplify(c, { tolerance: 0.00003, highQuality: false }); });
    var simplified = p;

    p = step(p, function (c) {
      var dense = densify(c, Math.max(roundKm * 1.5, 0.02));
      var sm = turf.polygonSmooth(dense, { iterations: 2 }); // returns a FeatureCollection
      return sm && sm.features && sm.features[0];
    });
    if (p !== simplified) {
      var bad = false;
      try { bad = turf.kinks(p).features.length > 0; } catch (e) { bad = true; }
      if (bad) p = simplified;
    }

    p = step(p, function (c) { return fillHoles(c, holeAcres); });
    p.properties = Object.assign({}, feature.properties || {}, p.properties || {});
    return p;
  }

  window.WalkShape = { refine: refine, fillHoles: fillHoles };
})();
