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

  // ---- Contour shape ----
  // Travel-time surface on a regular grid, traced at each budget. This is how
  // Valhalla / OpenTripPlanner build isochrones: the edge runs partway down the
  // last block instead of stopping at the last intersection.

  var MAX_CELLS = 250000;
  var SPECK_M2 = 0.5 * M2_PER_ACRE;

  // contour(samples, budgets, opts) -> { bands: [Feature|null] (one per budget,
  //   same order), gridKmUsed }
  //   samples : [[lng, lat, cost], ...] — cost in the SAME unit as budgets
  //   opts    : { gridKm, offStreetKm, costPerKm, holeAcres, roundKm }
  // Unit-agnostic: walksheds pass km (costPerKm 1); Transit Travelshed passes
  // minutes (costPerKm = walk minutes per km). A grid point's cost is the
  // cheapest sample within offStreetKm plus the straight-line walk to it;
  // anything farther from every sample is unreachable, so disjoint clusters
  // stay disjoint. The grid coarsens (gridKmUsed > gridKm) rather than exceed
  // MAX_CELLS. Each band is cleaned like the Smoothed shape (refine with
  // roundKm), then clipped to the next larger band so bands stay nested.
  function contour(samples, budgets, opts) {
    opts = opts || {};
    var out = { bands: budgets.map(function () { return null; }), gridKmUsed: opts.gridKm };
    if (!samples || !samples.length || !budgets.length || typeof turf === "undefined") return out;
    var gridKm = opts.gridKm > 0 ? opts.gridKm : 0.025;
    var reach = opts.offStreetKm > 0 ? opts.offStreetKm : 0.1;
    var perKm = opts.costPerKm > 0 ? opts.costPerKm : 1;
    var maxB = Math.max.apply(null, budgets);

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s[0] < minX) minX = s[0]; if (s[0] > maxX) maxX = s[0];
      if (s[1] < minY) minY = s[1]; if (s[1] > maxY) maxY = s[1];
    }
    // Local equirectangular projection (same constants as connector-graph.js).
    var kx = 111.32 * Math.cos(((minY + maxY) / 2) * Math.PI / 180), ky = 110.574;
    function bboxFor(g) {
      var pad = reach + 2 * g;
      return [minX - pad / kx, minY - pad / ky, maxX + pad / kx, maxY + pad / ky];
    }
    var bbox = bboxFor(gridKm);
    while (((bbox[2] - bbox[0]) * kx / gridKm) * ((bbox[3] - bbox[1]) * ky / gridKm) > MAX_CELLS) {
      gridKm *= 1.25;
      bbox = bboxFor(gridKm);
    }
    out.gridKmUsed = gridKm;

    // Hash samples into reach-sized cells so each grid point checks a 3x3 block.
    var H = new Map();
    for (var j = 0; j < samples.length; j++) {
      var sm = samples[j];
      var hk = Math.floor((sm[0] - bbox[0]) * kx / reach) + ":" + Math.floor((sm[1] - bbox[1]) * ky / reach);
      var arr = H.get(hk);
      if (!arr) H.set(hk, arr = []);
      arr.push(sm);
    }

    // turf.pointGrid's own ordering is what turf.isobands expects.
    var grid = turf.pointGrid(bbox, gridKm, { units: "kilometers" });
    var FAR = maxB * 10;
    var feats = grid.features;
    for (var g = 0; g < feats.length; g++) {
      var p = feats[g].geometry.coordinates;
      var gx = Math.floor((p[0] - bbox[0]) * kx / reach), gy = Math.floor((p[1] - bbox[1]) * ky / reach);
      var best = FAR;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var cell = H.get((gx + dx) + ":" + (gy + dy));
          if (!cell) continue;
          for (var c = 0; c < cell.length; c++) {
            var q = cell[c];
            var ex = (q[0] - p[0]) * kx, ey = (q[1] - p[1]) * ky;
            var e = Math.sqrt(ex * ex + ey * ey);
            if (e > reach) continue;
            var t = q[2] + e * perKm;
            if (t < best) best = t;
          }
        }
      }
      feats[g].properties.t = best;
    }

    var raw = budgets.map(function (b) {
      try {
        var fc = turf.isobands(grid, [-1, b], { zProperty: "t" });
        var f0 = fc && fc.features && fc.features[0];
        if (!isAreal(f0)) return null;
        // Drop specks, merge into one (Multi)Polygon, fix ring winding.
        var polys = (f0.geometry.type === "Polygon") ? [f0.geometry.coordinates] : f0.geometry.coordinates;
        polys = polys.filter(function (pp) {
          try { return ringArea(pp[0]) >= SPECK_M2; } catch (e) { return false; }
        });
        if (!polys.length) return null;
        var geom = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
        return turf.rewind({ type: "Feature", properties: {}, geometry: geom });
      } catch (e) { return null; }
    });

    var cleaned = raw.map(function (f) {
      return f ? refine(f, { holeAcres: opts.holeAcres, roundKm: opts.roundKm }) : null;
    });

    // Nesting: clip each band to the smallest larger band that exists.
    var order = budgets.map(function (b, k) { return k; }).sort(function (a, b) { return budgets[a] - budgets[b]; });
    for (var oi = order.length - 2; oi >= 0; oi--) {
      var inner = cleaned[order[oi]], outer = null;
      for (var oj = oi + 1; oj < order.length && !outer; oj++) outer = cleaned[order[oj]];
      if (!inner || !outer) continue;
      try {
        var clipped = turf.intersect(inner, outer);
        if (isAreal(clipped)) cleaned[order[oi]] = clipped;
      } catch (e) { /* keep the unclipped band */ }
    }
    out.bands = cleaned;
    return out;
  }

  window.WalkShape = { refine: refine, fillHoles: fillHoles, contour: contour };
})();
