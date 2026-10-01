// js/core/box-select.js
// Box select (drag a rectangle on the map to select features) —
// docs/box-select-plan.md. Phase 1: pure hit-test helpers only. Phase 2 adds
// the drag tool to this same file.
//
// ---- Pure helpers (App.boxSelectGeom) ----
// No DOM, map, or turf access (so the golden harness loads this file as-is).
// Everything is in SCREEN-PIXEL coordinates: points are [x, y], a rect is
// {minX, minY, maxX, maxY}, a bbox has the same shape. Rect edges are inclusive.
// mode is "touch" (any part of the feature meets the box) or "within"
// (the whole feature is inside the box).

(function () {
  var App = window.App = window.App || {};

  function normRect(x0, y0, x1, y1) {
    return {
      minX: Math.min(x0, x1), minY: Math.min(y0, y1),
      maxX: Math.max(x0, x1), maxY: Math.max(y0, y1)
    };
  }

  function pointInRect(p, r) {
    return p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY;
  }

  // Liang-Barsky clip: does any part of segment a-b lie in or touch r?
  // A zero-length segment degenerates to a point test.
  function segmentIntersectsRect(a, b, r) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return pointInRect(a, r);
    var t0 = 0, t1 = 1;
    var p = [-dx, dx, -dy, dy];
    var q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false; // parallel to this edge and outside it
      } else {
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else          { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return t0 <= t1;
  }

  // Even-odd ray casting. The ring may or may not repeat its first vertex
  // (a repeated closing vertex adds a zero-length edge, which is harmless).
  function pointInRing(p, ring) {
    var inside = false, x = p[0], y = p[1];
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function bboxOf(pts) {
    if (!pts || !pts.length) return null;
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < b.minX) b.minX = p[0];
      if (p[0] > b.maxX) b.maxX = p[0];
      if (p[1] < b.minY) b.minY = p[1];
      if (p[1] > b.maxY) b.maxY = p[1];
    }
    return b;
  }

  // Quick pre-filter: can a feature with this bbox possibly touch r?
  function bboxIntersectsRect(bbox, r) {
    if (!bbox) return false;
    return bbox.minX <= r.maxX && bbox.maxX >= r.minX && bbox.minY <= r.maxY && bbox.maxY >= r.minY;
  }

  function lineHits(pts, r, mode) {
    if (!pts || !pts.length) return false;
    var i;
    if (mode === "within") {
      for (i = 0; i < pts.length; i++) if (!pointInRect(pts[i], r)) return false;
      return true;
    }
    for (i = 0; i < pts.length; i++) if (pointInRect(pts[i], r)) return true;
    for (i = 0; i < pts.length - 1; i++) if (segmentIntersectsRect(pts[i], pts[i + 1], r)) return true;
    return false;
  }

  // rings[0] = outer ring, rest = holes.
  function polygonHits(rings, r, mode) {
    if (!rings || !rings.length || !rings[0].length) return false;
    var outer = rings[0], i, k;
    if (mode === "within") {
      for (i = 0; i < outer.length; i++) if (!pointInRect(outer[i], r)) return false;
      return true;
    }
    // Touch: any ring edge/vertex meets the box (an edge test also closes
    // each ring, in case it does not repeat its first vertex).
    for (k = 0; k < rings.length; k++) {
      var ring = rings[k];
      for (i = 0; i < ring.length; i++) {
        if (pointInRect(ring[i], r)) return true;
        if (segmentIntersectsRect(ring[i], ring[(i + 1) % ring.length], r)) return true;
      }
    }
    // No edge touches: the box is either wholly inside the polygon or wholly
    // outside it (or inside a hole). Test the box centre.
    var c = [(r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2];
    if (!pointInRing(c, outer)) return false;
    for (k = 1; k < rings.length; k++) if (pointInRing(c, rings[k])) return false;
    return true;
  }

  App.boxSelectGeom = {
    normRect: normRect,
    pointInRect: pointInRect,
    segmentIntersectsRect: segmentIntersectsRect,
    pointInRing: pointInRing,
    bboxOf: bboxOf,
    bboxIntersectsRect: bboxIntersectsRect,
    lineHits: lineHits,
    polygonHits: polygonHits
  };

  // ---- Drag tool (Phase 2) goes below this line ----
})();
