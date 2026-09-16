// js/core/connector-graph.js
// Network Connectors — pure planarization engine (window.ConnectorGraph), the
// same engine-namespace convention as window.Travelshed / window.TPI.
//
// CONSTRAINT: this file contains ONLY plain-JSON math — no turf, no DOM, no
// Map/Set, no App state. Why: the golden harness (test/run-golden.mjs) loads
// this file directly into a bare node:vm sandbox with no turf and no browser
// globals. Coordinates are plain [lng, lat] pairs throughout. Everything
// needing the live graph (_graph/_segmentIndex/_segGrid, candidate-segment
// lookup) lives in js/core/road-network.js, which supplies this engine's
// `candidates` argument and applies its returned addEdges/removeSegIds.
//
// See docs/network-connectors-plan.md §3 for the architecture and Phase 3
// for this file's design. Exports (all on window.ConnectorGraph):
// segmentIntersection, pointToSegmentKm, splitChain, planarizeConnectors.

(function () {
  "use strict";

  // Same equirectangular-projection constants road-network.js uses for its
  // own point-to-segment math (nearestOnSegmentKm) — kept consistent so the
  // two engines agree on distances at the sub-km scale connectors operate at.
  var KM_PER_DEG_LAT = 110.574;
  function kmPerDegLng(lat) { return 111.32 * Math.cos(lat * Math.PI / 180); }

  // Matches road-network.js's nodeKey() 6-decimal-place quantization (~0.1 m).
  // Two coordinates within this tolerance are treated as "the same node" so
  // we never emit a zero-length edge or a redundant split at a point that
  // already exists.
  var COORD_EPS_DEG = 1e-6;

  function coordsEqual(a, b) {
    return Math.abs(a[0] - b[0]) < COORD_EPS_DEG && Math.abs(a[1] - b[1]) < COORD_EPS_DEG;
  }

  // ---- segmentIntersection: standard 2D segment/segment intersection, done
  // in local km space (projected equirectangularly around segment AB's own
  // start point) so results are metrically meaningful rather than degree-
  // biased at low latitudes. Returns null for parallel/collinear segments
  // (zero cross product) and for intersections that fall outside [0,1] on
  // either parameter — including a small epsilon to avoid excluding a hit
  // that lands almost exactly on an endpoint.
  function segmentIntersection(a, b, c, d) {
    var originLng = a[0], originLat = a[1];
    var kLng = kmPerDegLng(originLat), kLat = KM_PER_DEG_LAT;
    function toXY(p) { return [(p[0] - originLng) * kLng, (p[1] - originLat) * kLat]; }
    var A = toXY(a), B = toXY(b), C = toXY(c), D = toXY(d);
    var rX = B[0] - A[0], rY = B[1] - A[1];
    var sX = D[0] - C[0], sY = D[1] - C[1];
    var denom = rX * sY - rY * sX;
    var PARALLEL_EPS = 1e-9;
    if (Math.abs(denom) < PARALLEL_EPS) return null; // parallel or collinear — see §2 "Collinear overlap"

    var qpX = C[0] - A[0], qpY = C[1] - A[1];
    var t = (qpX * sY - qpY * sX) / denom;
    var u = (qpX * rY - qpY * rX) / denom;

    var RANGE_EPS = 1e-9;
    if (t < -RANGE_EPS || t > 1 + RANGE_EPS || u < -RANGE_EPS || u > 1 + RANGE_EPS) return null;
    t = Math.min(1, Math.max(0, t));
    u = Math.min(1, Math.max(0, u));

    var px = A[0] + t * rX, py = A[1] + t * rY;
    return { point: [originLng + px / kLng, originLat + py / kLat], tAB: t, tCD: u };
  }

  // ---- pointToSegmentKm: nearest point on segment A-B to point p, in local
  // km space around p (the query point is the local origin, so the standard
  // point-segment projection collapses to just A/B/t). Restates
  // road-network.js's nearestOnSegmentKm so this engine is self-contained.
  function pointToSegmentKm(p, a, b) {
    var kLat = KM_PER_DEG_LAT, kLng = kmPerDegLng(p[1]);
    var ax = (a[0] - p[0]) * kLng, ay = (a[1] - p[1]) * kLat;
    var bx = (b[0] - p[0]) * kLng, by = (b[1] - p[1]) * kLat;
    var dx = bx - ax, dy = by - ay;
    var t;
    if (dx === 0 && dy === 0) {
      t = 0;
    } else {
      t = -(ax * dx + ay * dy) / (dx * dx + dy * dy);
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    var nx = ax + t * dx, ny = ay + t * dy;
    return { distKm: Math.sqrt(nx * nx + ny * ny), point: [p[0] + nx / kLng, p[1] + ny / kLat], t: t };
  }

  // ---- splitChain: cuts a polyline at a list of {segIndex, t, point}
  // records (segIndex indexes the coords[i]->coords[i+1] segment being cut).
  // Splits on the same segment are inserted in ascending t order. Returns
  // the resulting ordered 2-point edges, dropping any edge whose endpoints
  // coincide within COORD_EPS_DEG (a split landing exactly on an existing
  // vertex must never produce a zero-length edge).
  function splitChain(coords, splits) {
    if (!coords || coords.length < 2) return [];
    var bySeg = {};
    (splits || []).forEach(function (s) {
      if (!bySeg[s.segIndex]) bySeg[s.segIndex] = [];
      bySeg[s.segIndex].push(s);
    });
    var verts = [coords[0]];
    for (var i = 0; i < coords.length - 1; i++) {
      var segSplits = (bySeg[i] || []).slice().sort(function (x, y) { return x.t - y.t; });
      segSplits.forEach(function (s) { verts.push(s.point); });
      verts.push(coords[i + 1]);
    }
    var edges = [];
    for (var j = 0; j < verts.length - 1; j++) {
      if (coordsEqual(verts[j], verts[j + 1])) continue; // zero-length — drop, never emit
      edges.push([verts[j], verts[j + 1]]);
    }
    return edges;
  }

  // ---- planarizeConnectors: the top-level entry. See
  // docs/network-connectors-plan.md Phase 3 for the full rule set.
  //
  //   connectors : [{ id, coords: [[lng,lat], ...] }]
  //   candidates : [{ segId, coords: [a, b], pedBlocked }] — base segments
  //                near the connectors; the caller (road-network.js) does
  //                the spatial query, this engine does no indexing.
  //   opts       : { snapToleranceKm, weldVertices (default true),
  //                  splitCrossings (default false) }
  //
  // Returns { addEdges, removeSegIds, joins, orphans } — see the plan for
  // the exact shape of each.
  function planarizeConnectors(connectors, candidates, opts) {
    opts = opts || {};
    var snapToleranceKm = opts.snapToleranceKm != null ? opts.snapToleranceKm : 0;
    var weldVertices = opts.weldVertices !== false;
    var splitCrossings = !!opts.splitCrossings;

    var addEdges = [];
    var removeSegIdsSet = {};
    var joins = [];
    var orphans = [];

    // Live candidate pool: base segments plus, as processing proceeds, the
    // (possibly already-split) edges of connectors processed earlier — so a
    // later connector can weld or cross against an earlier one too.
    var pool = (candidates || []).map(function (c) {
      return { id: c.segId, coords: [c.coords[0], c.coords[1]], pedBlocked: !!c.pedBlocked, origin: "base", baseId: c.segId };
    });
    var synthCounter = 0;

    // Replaces `entry` in the pool with the pieces produced by cutting it at
    // `splitPts` ([{t, point}]). Removes any addEdges record this entry was
    // already emitted under (so re-splitting an already-split piece — the
    // "double crossing" case — doesn't leave a stale superseded edge behind)
    // and emits the new pieces under the same kind/srcId. Base-origin entries
    // additionally mark their original segId for removal from the live graph.
    function applySplit(entry, splitPts) {
      var idx = pool.indexOf(entry);
      if (idx < 0 || !splitPts.length) return;
      var edges = splitChain(entry.coords, splitPts.map(function (s) {
        return { segIndex: 0, t: s.t, point: s.point };
      }));
      pool.splice(idx, 1);
      var kind = entry.origin === "base" ? "split" : "connector";
      var srcId = entry.origin === "base" ? entry.baseId : entry.connectorId;
      for (var ai = addEdges.length - 1; ai >= 0; ai--) {
        var ae = addEdges[ai];
        if (ae.kind === kind && ae.srcId === srcId &&
            coordsEqual(ae.coords[0], entry.coords[0]) && coordsEqual(ae.coords[1], entry.coords[1])) {
          addEdges.splice(ai, 1);
          break;
        }
      }
      if (entry.origin === "base") removeSegIdsSet[entry.baseId] = true;
      edges.forEach(function (e) {
        addEdges.push({ coords: e, kind: kind, srcId: srcId });
        pool.push({ id: srcId + "#" + (synthCounter++), coords: e, pedBlocked: false,
          origin: entry.origin, baseId: entry.baseId, connectorId: entry.connectorId });
      });
    }

    // ---- Pass A: crossing splits (connectors processed in order; each
    // connector's finished edges join the pool for subsequent connectors). ----
    (connectors || []).forEach(function (connector) {
      var coords = connector.coords || [];
      if (coords.length < 2) return;

      var ownEdges;
      if (splitCrossings) {
        var ownSplits = [];
        for (var ci = 0; ci < coords.length - 1; ci++) {
          var cA = coords[ci], cB = coords[ci + 1];
          var snapshot = pool.slice(); // frozen for this connector segment's scan
          var poolHits = {}; // pool entry id -> { entry, pts: [{t, point}] }
          for (var pi = 0; pi < snapshot.length; pi++) {
            var seg = snapshot[pi];
            if (seg.pedBlocked) continue; // never auto-join across a bridge/freeway (§1)
            if (seg.origin === "connector" && seg.connectorId === connector.id) continue; // no self-crossing
            var hit = segmentIntersection(cA, cB, seg.coords[0], seg.coords[1]);
            if (!hit) continue;
            ownSplits.push({ segIndex: ci, t: hit.tAB, point: hit.point });
            if (!poolHits[seg.id]) poolHits[seg.id] = { entry: seg, pts: [] };
            poolHits[seg.id].pts.push({ t: hit.tCD, point: hit.point });
            joins.push({
              point: hit.point, kind: "crossing", connectorId: connector.id,
              segId: seg.origin === "base" ? seg.baseId : seg.connectorId
            });
          }
          Object.keys(poolHits).forEach(function (k) { applySplit(poolHits[k].entry, poolHits[k].pts); });
        }
        ownEdges = splitChain(coords, ownSplits);
      } else {
        ownEdges = [];
        for (var oi = 0; oi < coords.length - 1; oi++) {
          if (!coordsEqual(coords[oi], coords[oi + 1])) ownEdges.push([coords[oi], coords[oi + 1]]);
        }
      }

      ownEdges.forEach(function (e) {
        addEdges.push({ coords: e, kind: "connector", srcId: connector.id });
        pool.push({ id: connector.id + "#" + (synthCounter++), coords: e, pedBlocked: false,
          origin: "connector", connectorId: connector.id });
      });
    });

    // ---- Pass B: welding. Runs against the FINAL pool (every base split and
    // every connector's finished chain), so weld order among connectors
    // doesn't matter — only crossing order (Pass A) does. ----
    (connectors || []).forEach(function (connector) {
      var coords = connector.coords || [];
      if (coords.length < 2) return;

      coords.forEach(function (v, vi) {
        var isEndpoint = (vi === 0 || vi === coords.length - 1);

        if (!weldVertices || !(snapToleranceKm > 0)) {
          if (isEndpoint) {
            var alreadyJoined = joins.some(function (j) {
              return j.connectorId === connector.id && coordsEqual(j.point, v);
            });
            if (!alreadyJoined) orphans.push({ connectorId: connector.id, point: v, nearestKm: null });
          }
          return;
        }

        var best = null;
        for (var pi = 0; pi < pool.length; pi++) {
          var seg = pool[pi];
          if (seg.pedBlocked) continue;
          if (seg.origin === "connector" && seg.connectorId === connector.id) continue; // don't weld to own chain
          var np = pointToSegmentKm(v, seg.coords[0], seg.coords[1]);
          if (!best || np.distKm < best.distKm) best = { distKm: np.distKm, point: np.point, t: np.t, entry: seg };
        }

        if (!best || best.distKm > snapToleranceKm) {
          if (isEndpoint) orphans.push({ connectorId: connector.id, point: v, nearestKm: best ? best.distKm : Infinity });
          return;
        }

        var weldPoint = best.point;
        var segId = best.entry.origin === "base" ? best.entry.baseId : best.entry.connectorId;
        var atExistingVertex = coordsEqual(weldPoint, best.entry.coords[0]) || coordsEqual(weldPoint, best.entry.coords[1]);
        if (!atExistingVertex) applySplit(best.entry, [{ t: best.t, point: weldPoint }]);
        if (!coordsEqual(v, weldPoint)) {
          addEdges.push({ coords: [v, weldPoint], kind: "connector", srcId: connector.id });
        }
        joins.push({ point: weldPoint, kind: "weld", connectorId: connector.id, segId: segId });
      });
    });

    return {
      addEdges: addEdges,
      removeSegIds: Object.keys(removeSegIdsSet),
      joins: joins,
      orphans: orphans
    };
  }

  window.ConnectorGraph = {
    segmentIntersection: segmentIntersection,
    pointToSegmentKm: pointToSegmentKm,
    splitChain: splitChain,
    planarizeConnectors: planarizeConnectors
  };

})();
