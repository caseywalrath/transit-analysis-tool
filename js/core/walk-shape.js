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

  var KM_PER_DEG = 111.32;          // simplify tolerance is in degrees; ~1 deg ≈ 111 km
  var COARSE_ROUND_KM = 0.09;       // ~300 ft: Contour's rounding is above, Smoothed's below

  // True when any two non-adjacent edges of the (Multi)Polygon's rings cross
  // or touch. Same question as turf.kinks, but turf.kinks tests every edge
  // against every other (quadratic: 18 ms on a ~1,400-vertex band, far worse
  // on travelsheds). Edges are bucketed into a uniform grid sized to the
  // average edge length, so only edges sharing a cell are compared. Pure
  // arithmetic on lng/lat (no turf), so the golden harness can pin it.
  function selfIntersects(feature) {
    var g = feature && feature.geometry;
    if (!g) return false;
    var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    var segs = []; // [ax, ay, bx, by, ringId, idxInRing, ringLen]
    var ringId = 0, totalLen = 0;
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        var n = ring.length - 1; // closed ring: last == first
        for (var i = 0; i < n; i++) {
          var a = ring[i], b = ring[i + 1];
          segs.push([a[0], a[1], b[0], b[1], ringId, i, n]);
          totalLen += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
        }
        ringId++;
      });
    });
    if (segs.length < 4) return false;
    var cell = Math.max(totalLen / segs.length, 1e-9);
    var H = new Map();
    for (var s = 0; s < segs.length; s++) {
      var q = segs[s];
      var x0 = Math.floor(Math.min(q[0], q[2]) / cell), x1 = Math.floor(Math.max(q[0], q[2]) / cell);
      var y0 = Math.floor(Math.min(q[1], q[3]) / cell), y1 = Math.floor(Math.max(q[1], q[3]) / cell);
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          var k = x + ":" + y, arr = H.get(k);
          if (!arr) H.set(k, arr = []);
          arr.push(s);
        }
      }
    }
    var seen = new Set();
    var found = false;
    H.forEach(function (arr) {
      if (found) return;
      for (var i = 0; i < arr.length && !found; i++) {
        for (var j = i + 1; j < arr.length; j++) {
          var a = segs[arr[i]], b = segs[arr[j]];
          if (a[4] === b[4]) {
            var d = Math.abs(a[5] - b[5]);
            if (d === 1 || d === a[6] - 1) continue; // neighbours share a vertex by design
          }
          var pk = arr[i] < arr[j] ? arr[i] * 1e7 + arr[j] : arr[j] * 1e7 + arr[i];
          if (seen.has(pk)) continue;
          seen.add(pk);
          if (segmentsTouch(a, b)) { found = true; break; }
        }
      }
    });
    return found;
  }

  function orient(ax, ay, bx, by, cx, cy) {
    var v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
  function onSeg(ax, ay, bx, by, cx, cy) {
    return Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
  }
  function segmentsTouch(p, q) {
    var o1 = orient(p[0], p[1], p[2], p[3], q[0], q[1]), o2 = orient(p[0], p[1], p[2], p[3], q[2], q[3]);
    var o3 = orient(q[0], q[1], q[2], q[3], p[0], p[1]), o4 = orient(q[0], q[1], q[2], q[3], p[2], p[3]);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSeg(p[0], p[1], p[2], p[3], q[0], q[1])) return true;
    if (o2 === 0 && onSeg(p[0], p[1], p[2], p[3], q[2], q[3])) return true;
    if (o3 === 0 && onSeg(q[0], q[1], q[2], q[3], p[0], p[1])) return true;
    if (o4 === 0 && onSeg(q[0], q[1], q[2], q[3], p[2], p[3])) return true;
    return false;
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
      // Large roundings (Contour's 330 ft) erase anything finer than ~1/3 of
      // the radius, so thin the outline to a tenth of it first and draw buffer
      // arcs coarsely: turf.buffer's cost grows with vertex count, and this cut
      // it ~10x on contour bands (thousands of grid-traced vertices). Smoothed's
      // 150 ft rounding stays below the threshold and keeps its exact output.
      var coarse = roundKm >= COARSE_ROUND_KM;
      p = step(p, function (c) {
        var src = coarse ? turf.simplify(c, { tolerance: roundKm * 0.1 / KM_PER_DEG, highQuality: false }) : c;
        var bopts = coarse ? { units: "kilometers", steps: 4 } : { units: "kilometers" };
        var grown = turf.buffer(src, roundKm, bopts);
        return turf.buffer(grown, -roundKm, bopts);
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
      try { bad = selfIntersects(p); } catch (e) { bad = true; }
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
    var out = { bands: budgets.map(function () { return null; }), gridKmUsed: opts.gridKm, gridKmPlanned: opts.gridKm };
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

    // ONE isobands pass for every budget: it returns one annulus per interval
    // ([-1,b1], [b1,b2], ...), and each band is the running union of those.
    // Separate per-budget passes each re-scanned the whole grid.
    var sortedB = budgets.slice().sort(function (a, b) { return a - b; });
    var cumulative = {};
    try {
      var bandsFc = turf.isobands(grid, [-1].concat(sortedB), { zProperty: "t" });
      var running = null;
      sortedB.forEach(function (b, k) {
        var piece = bandsFc && bandsFc.features && bandsFc.features[k];
        if (isAreal(piece)) {
          if (!running) running = piece;
          else {
            try { running = turf.union(running, piece) || running; }
            catch (e) { /* keep the smaller band rather than lose it */ }
          }
        }
        cumulative[b] = running;
      });
    } catch (e) { /* every band stays null */ }

    var raw = budgets.map(function (b) {
      try {
        var f0 = cumulative[b];
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

  // Grid spacing grows with the square root of the walk size: 15 min (ratio 1)
  // keeps the set grid, 30 min ~1.4x, 60 min 2x. Bigger shapes are viewed
  // farther out and the 330 ft edge rounding hides finer detail, while cell
  // count (the cost) grows with area. ratio = maxBudget / the 15-min budget.
  function scaledGridKm(gridKm, ratio) {
    return gridKm * Math.max(1, Math.sqrt(ratio > 0 ? ratio : 1));
  }

  // Street samples every 2 grid cells: each sample already reaches offStreetKm
  // in every direction, so denser samples only add lookups, not shape.
  var SAMPLE_STEP_CELLS = 2;

  window.WalkShape = { refine: refine, fillHoles: fillHoles, contour: contour,
    scaledGridKm: scaledGridKm, SAMPLE_STEP_CELLS: SAMPLE_STEP_CELLS, selfIntersects: selfIntersects };
})();
