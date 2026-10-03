// js/core/split.js
//
// Feature Split (docs/archive/feature-split-plan.md, Phase 1: "Split here" for lines
// and routes). The reverse of Feature Merge: one cut makes two pieces, one
// undo step, a short confirmation dialog, and merging the pieces back with
// Merge… gives the original geometry.
//
// Three layers, like merge.js:
//   1. App.splitGeom — pure helpers (plain arrays, no turf/DOM/map), loaded by
//      the golden harness (test/cases/split.mjs): cutAt, locate, snapToVertex,
//      partitionWaypoints, splitRunTime, assignStops, isLoop, uniqueName,
//      lengthMi.
//   2. App.split.analyze(type, index, cuts) -> plan (synchronous, no mutation)
//      and App.split.run(...) -> the undoable operation.
//   3. App.split.openDialog(type, index, lngLat | cuts) — the .fm-* dialog,
//      reusing merge.js's App.merge._dialogKit.
//
// Inheritance rules (first piece keeps slot/ID/colorSeq/seq/name; new pieces
// get new IDs, "(2)" names, copied attributes, a length share of runTime, a
// Service choice, and re-linked stops) are documented in the plan's table.
//
// Exports: App.splitGeom, App.split
(function () {
  var App = window.App = window.App || {};

  /* =====================================================================
     Pure geometry helpers
     ===================================================================== */

  var FT_PER_MI = 5280;
  var EPS_T = 1e-9;

  function distMi(a, b) {
    var lat = (a[1] + b[1]) / 2 * Math.PI / 180;
    var dx = (b[0] - a[0]) * Math.cos(lat) * 69.172;
    var dy = (b[1] - a[1]) * 69.172;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function distFt(a, b) { return distMi(a, b) * FT_PER_MI; }

  function lengthMi(coords) {
    var d = 0;
    for (var i = 1; i < (coords || []).length; i++) d += distMi(coords[i - 1], coords[i]);
    return d;
  }

  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function round7(v) { return Math.round(v * 1e7) / 1e7; }
  function cloneCoords(a) { return (a || []).map(function (c) { return c.slice(); }); }

  // Nearest point on segment a-b to p, in an equirectangular projection centred
  // on p (same approach as road-network.js nearestOnSegmentKm). Returns {t, distFt}.
  function nearestOnSegment(p, a, b) {
    var k = Math.cos(p[1] * Math.PI / 180);
    var ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
    var bx = (b[0] - p[0]) * k, by = b[1] - p[1];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var x = ax + dx * t, y = ay + dy * t;
    return { t: t, distFt: Math.sqrt(x * x + y * y) * 69.172 * FT_PER_MI };
  }

  // Position along the line as a scalar: segIndex + t (comparable, sortable).
  function posOf(c) { return c.segIndex + c.t; }

  // Distance along the line (mi) from the start to position {segIndex, t}.
  function alongMi(coords, c) {
    var d = 0;
    for (var i = 0; i < c.segIndex; i++) d += distMi(coords[i], coords[i + 1]);
    return d + distMi(coords[c.segIndex], coords[c.segIndex + 1]) * c.t;
  }

  // Nearest position on the line to lngLat ([lng, lat] or {lng, lat}).
  // hintSegIndex (optional): prefer that segment when it is within 30 ft of the
  // best one (a route passing the same spot twice uses the stretch clicked).
  // opts.fromPos (optional): only consider positions at or after this scalar.
  // Returns {segIndex, t, point, distFt, alongMi, totalMi} | null.
  function locate(coords, lngLat, hintSegIndex, opts) {
    if (!Array.isArray(coords) || coords.length < 2 || !lngLat) return null;
    var p = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
    var from = opts && typeof opts.fromPos === "number" ? opts.fromPos : -1;
    var best = null, hinted = null;
    for (var i = 0; i < coords.length - 1; i++) {
      if (from >= 0 && i + 1 < from) continue;
      var r = nearestOnSegment(p, coords[i], coords[i + 1]);
      var t = r.t, d = r.distFt;
      if (from >= 0 && i + t < from) { // clamp into the allowed range
        t = from - i;
        d = distFt(p, lerp(coords[i], coords[i + 1], t));
      }
      var cand = { segIndex: i, t: t, distFt: d };
      if (!best || d < best.distFt - 1e-9) best = cand;
      if (i === hintSegIndex) hinted = cand;
    }
    if (!best) return null;
    var pick = hinted && hinted.distFt <= best.distFt + 30 ? hinted : best;
    // Normalize a cut at the very end of a segment to the start of the next.
    if (pick.t >= 1 - EPS_T && pick.segIndex < coords.length - 2) pick = { segIndex: pick.segIndex + 1, t: 0, distFt: pick.distFt };
    var pt = lerp(coords[pick.segIndex], coords[pick.segIndex + 1], pick.t);
    return { segIndex: pick.segIndex, t: pick.t, point: [round7(pt[0]), round7(pt[1])],
             distFt: pick.distFt, alongMi: alongMi(coords, pick), totalMi: lengthMi(coords) };
  }

  // Snap a located cut to its segment's nearer vertex when that vertex is within
  // maxFt of the cut point. Returns a new {segIndex, t, point, snapped}.
  function snapToVertex(coords, loc, maxFt) {
    if (!loc) return loc;
    var a = coords[loc.segIndex], b = coords[loc.segIndex + 1];
    var useB = loc.t > 0.5;
    var v = useB ? b : a;
    var cutPt = lerp(a, b, loc.t);
    if (distFt(cutPt, v) > maxFt) return { segIndex: loc.segIndex, t: loc.t, point: loc.point, snapped: false };
    var seg = useB ? loc.segIndex + 1 : loc.segIndex;
    if (seg > coords.length - 2) return { segIndex: coords.length - 2, t: 1, point: v.slice(), snapped: true };
    return { segIndex: seg, t: 0, point: v.slice(), snapped: true };
  }

  // Cut a polyline at cuts = [{segIndex, t}] (any order). Returns the pieces'
  // coordinate arrays. The cut point is the last vertex of one piece and the
  // first of the next; a cut on an existing vertex adds no new vertex. Cuts at
  // the very ends, or duplicates, are ignored (no zero-length pieces).
  function cutAt(coords, cuts) {
    if (!Array.isArray(coords) || coords.length < 2) return [];
    var n = coords.length;
    // Normalize each cut to either a vertex index or an interior (seg, t).
    var norm = [];
    (cuts || []).forEach(function (c) {
      if (!c || !(c.segIndex >= 0) || c.segIndex > n - 2) return;
      var t = Math.max(0, Math.min(1, +c.t || 0));
      if (t <= EPS_T) norm.push({ pos: c.segIndex, vertex: c.segIndex });
      else if (t >= 1 - EPS_T) norm.push({ pos: c.segIndex + 1, vertex: c.segIndex + 1 });
      else norm.push({ pos: c.segIndex + t, seg: c.segIndex, t: t });
    });
    norm = norm.filter(function (c) { return c.pos > EPS_T && c.pos < n - 1 - EPS_T; });
    norm.sort(function (a, b) { return a.pos - b.pos; });
    norm = norm.filter(function (c, i) { return i === 0 || c.pos - norm[i - 1].pos > EPS_T; });

    var pieces = [], cur = [coords[0].slice()], k = 0;
    for (var i = 0; i < n - 1; i++) {
      // interior cuts on segment i
      while (k < norm.length && norm[k].vertex === undefined && norm[k].seg === i) {
        var p = lerp(coords[i], coords[i + 1], norm[k].t);
        p = [round7(p[0]), round7(p[1])];
        cur.push(p); pieces.push(cur); cur = [p.slice()];
        k++;
      }
      cur.push(coords[i + 1].slice());
      if (k < norm.length && norm[k].vertex === i + 1) {
        pieces.push(cur); cur = [coords[i + 1].slice()];
        k++;
      }
    }
    if (cur.length >= 2) pieces.push(cur);
    return pieces;
  }

  // Place route waypoints along the line (searching forward from the previous
  // one so a self-overlapping route keeps them in order) and split them at the
  // cuts. The cut point becomes the end waypoint of one piece and the start of
  // the next; a waypoint within ~3 ft of a cut is replaced by the cut point.
  // Returns one waypoint array per piece (same count as cutAt's pieces).
  function partitionWaypoints(coords, waypoints, cuts) {
    var cutPos = [];
    (cuts || []).forEach(function (c) {
      var pos = c.segIndex + Math.max(0, Math.min(1, +c.t || 0));
      if (pos > EPS_T && pos < coords.length - 1 - EPS_T) {
        var pt = lerp(coords[c.segIndex], coords[c.segIndex + 1], Math.max(0, Math.min(1, +c.t || 0)));
        cutPos.push({ pos: pos, point: [round7(pt[0]), round7(pt[1])] });
      }
    });
    cutPos.sort(function (a, b) { return a.pos - b.pos; });
    cutPos = cutPos.filter(function (c, i) { return i === 0 || c.pos - cutPos[i - 1].pos > EPS_T; });

    var out = [[]];
    var prev = 0, k = 0;
    (waypoints || []).forEach(function (w) {
      var loc = locate(coords, w, undefined, { fromPos: prev });
      var pos = loc ? loc.segIndex + loc.t : prev;
      prev = pos;
      while (k < cutPos.length && pos > cutPos[k].pos + EPS_T) {
        out[k].push(cutPos[k].point.slice());
        out.push([cutPos[k].point.slice()]);
        k++;
      }
      var cp = k < cutPos.length ? cutPos[k] : null;
      var nearCut = (cp && (distFt(w, cp.point) < 3 || Math.abs(pos - cp.pos) < EPS_T)) ||
                    (k > 0 && (distFt(w, cutPos[k - 1].point) < 3 || Math.abs(pos - cutPos[k - 1].pos) < EPS_T));
      if (!nearCut) out[k].push(w.slice());
    });
    while (k < cutPos.length) { out[k].push(cutPos[k].point.slice()); out.push([cutPos[k].point.slice()]); k++; }
    return out;
  }

  // Join two consecutive coordinate (or waypoint) arrays end to start. A
  // duplicate join vertex (within ~1 m / 3.3 ft) is dropped.
  function joinPieces(first, second) {
    var a = cloneCoords(first), b = cloneCoords(second);
    if (a.length && b.length && distFt(a[a.length - 1], b[0]) < 3.3) b.shift();
    return a.concat(b);
  }

  // The stretch of the line between two positions ({segIndex, t}, any order):
  // the first cut point, every vertex strictly between, the second cut point.
  function sectionBetween(coords, c1, c2) {
    if (!Array.isArray(coords) || coords.length < 2 || !c1 || !c2) return [];
    var a = posOf(c1) <= posOf(c2) ? c1 : c2, b = a === c1 ? c2 : c1;
    function pt(c) { var p = lerp(coords[c.segIndex], coords[c.segIndex + 1], Math.max(0, Math.min(1, +c.t || 0))); return [round7(p[0]), round7(p[1])]; }
    var out = [pt(a)];
    for (var i = a.segIndex + 1; i <= b.segIndex; i++) {
      if (i > posOf(a) + EPS_T && i < posOf(b) - EPS_T) out.push(coords[i].slice());
    }
    out.push(pt(b));
    return out;
  }

  // Two-cut "Split out section". Cuts may sit exactly on an end (the caller
  // trims near-end cuts to {segIndex:0,t:0} / {segIndex:n-2,t:1}), giving 2
  // pieces instead of 3. For a LOOP (ends meet) the stretch between the two
  // cuts becomes the section and the rest — the part before the first cut
  // joined through the loop's start to the part after the second — is ONE
  // piece that begins at the second cut. Returns
  // { pieces: [coords…], waypoints: [wp…] | null, sectionPiece }.
  // Non-loop: pieces are in line order; sectionPiece is 0 when the first cut is
  // on the start, else 1. Loop: pieces = [rest, section], sectionPiece = 1.
  function cutSection(coords, waypoints, cuts, loop) {
    var pieces = cutAt(coords, cuts);
    var wps = waypoints ? partitionWaypoints(coords, waypoints, cuts) : null;
    var sorted = (cuts || []).slice().sort(function (a, b) { return posOf(a) - posOf(b); });
    if (loop && pieces.length === 3) {
      pieces = [joinPieces(pieces[2], pieces[0]), pieces[1]];
      if (wps) wps = [joinPieces(wps[2], wps[0]), wps[1]];
      return { pieces: pieces, waypoints: wps, sectionPiece: 1 };
    }
    var startOnEnd = sorted.length > 0 && posOf(sorted[0]) <= EPS_T;
    return { pieces: pieces, waypoints: wps, sectionPiece: pieces.length > 1 && !startOnEnd ? 1 : 0 };
  }

  // The cut for route waypoint k: its position on the geometry, placed exactly
  // as partitionWaypoints places it (searching forward from the previous one).
  function waypointCut(coords, waypoints, k) {
    var prev = 0, loc = null;
    for (var i = 0; i <= k && i < (waypoints || []).length; i++) {
      loc = locate(coords, waypoints[i], undefined, { fromPos: prev });
      if (loc) prev = loc.segIndex + loc.t;
    }
    return loc ? { segIndex: loc.segIndex, t: loc.t } : null;
  }

  // Divide a run time (minutes) between pieces in proportion to their lengths,
  // 0.1-min rounding; the last piece takes the remainder so the sum is exact.
  // A missing/non-positive runTime gives null for every piece.
  function splitRunTime(runTime, lengths) {
    var rt = typeof runTime === "number" ? runTime : parseFloat(runTime);
    var ls = (lengths || []).map(function (l) { return l > 0 ? l : 0; });
    if (!(rt > 0) || !ls.length) return ls.map(function () { return null; });
    var total = 0; ls.forEach(function (l) { total += l; });
    if (!(total > 0)) return ls.map(function (l, i) { return i === 0 ? rt : 0; });
    var out = [], used = 0;
    ls.forEach(function (l, i) {
      if (i === ls.length - 1) out.push(Math.round((rt - used) * 10) / 10);
      else { var v = Math.round(rt * l / total * 10) / 10; out.push(v); used += v; }
    });
    return out;
  }

  // Distance (ft) from p to a polyline.
  function distToLineFt(p, coords) {
    var best = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var d = nearestOnSegment(p, coords[i], coords[i + 1]).distFt;
      if (d < best) best = d;
    }
    return best;
  }

  // stops = [{id, at: [lng, lat]}], pieces = coordinate arrays from cutAt.
  // Each stop goes to its nearest piece; a stop within toleranceFt (default 50)
  // of a cut point (the shared vertex between pieces k and k+1) goes to both.
  // Returns [{id, pieces: [pieceIndex…]}].
  function assignStops(stops, pieces, toleranceFt) {
    var tol = toleranceFt > 0 ? toleranceFt : 50;
    return (stops || []).map(function (s) {
      var bestK = 0, bestD = Infinity;
      pieces.forEach(function (pc, k) {
        var d = distToLineFt(s.at, pc);
        if (d < bestD - 1e-9) { bestD = d; bestK = k; }
      });
      var set = [bestK];
      for (var k = 0; k < pieces.length - 1; k++) {
        var cut = pieces[k][pieces[k].length - 1];
        if (distFt(s.at, cut) <= tol) {
          if (set.indexOf(k) < 0) set.push(k);
          if (set.indexOf(k + 1) < 0) set.push(k + 1);
        }
      }
      set.sort(function (a, b) { return a - b; });
      return { id: s.id, pieces: set };
    });
  }

  // Do the line's ends nearly meet (a loop)? Default 50 ft.
  function isLoop(coords, ft) {
    if (!Array.isArray(coords) || coords.length < 3) return false;
    return distFt(coords[0], coords[coords.length - 1]) <= (ft > 0 ? ft : 50);
  }

  // "<base> (n)" for the first n >= startAt (default 2) not in existing.
  function uniqueName(base, existing, startAt) {
    var used = {};
    (existing || []).forEach(function (k) { if (k != null) used[String(k).trim()] = true; });
    base = String(base == null ? "" : base).trim() || "Feature";
    for (var n = startAt > 1 ? startAt : 2; ; n++) {
      if (!used[base + " (" + n + ")"]) return base + " (" + n + ")";
    }
  }

  // Phase 3: "also split the opposite direction". For each cut point
  // ([lng, lat]) find the nearest position on the opposite feature's line.
  // Rejected (ok:false) when a point is farther than maxFt (default 300) from
  // that line, or lands within endGuardFt (default 30) of one of its ends or of
  // another matched cut (a piece would have no length). Returns
  // { ok, reason: "" | "far" | "end" | "close", cuts: [{segIndex, t, distFt}]
  //   (sorted along the opposite line), worstFt }.
  function matchOppositeCuts(oppCoords, cutPoints, maxFt, endGuardFt) {
    var max = maxFt > 0 ? maxFt : 300, guard = endGuardFt > 0 ? endGuardFt : 30;
    var out = { ok: false, reason: "", cuts: [], worstFt: 0 };
    if (!Array.isArray(oppCoords) || oppCoords.length < 2 || !(cutPoints || []).length) { out.reason = "far"; return out; }
    var total = lengthMi(oppCoords) * FT_PER_MI;
    var locs = [];
    for (var i = 0; i < cutPoints.length; i++) {
      var loc = locate(oppCoords, cutPoints[i]);
      if (!loc) { out.reason = "far"; return out; }
      out.worstFt = Math.max(out.worstFt, loc.distFt);
      locs.push(loc);
    }
    out.worstFt = Math.round(out.worstFt);
    if (out.worstFt > max) { out.reason = "far"; return out; }
    locs.sort(function (a, b) { return posOf(a) - posOf(b); });
    var prev = 0;
    for (var k = 0; k < locs.length; k++) {
      var al = locs[k].alongMi * FT_PER_MI;
      if (al < guard || total - al < guard) { out.reason = "end"; return out; }
      if (k > 0 && al - prev < guard) { out.reason = "close"; return out; }
      prev = al;
    }
    out.cuts = locs.map(function (l) { return { segIndex: l.segIndex, t: l.t, distFt: Math.round(l.distFt * 10) / 10 }; });
    out.ok = true;
    return out;
  }

  // The point halfway along a polyline.
  function midpointOf(coords) {
    var half = lengthMi(coords) / 2, d = 0;
    for (var i = 1; i < coords.length; i++) {
      var s = distMi(coords[i - 1], coords[i]);
      if (d + s >= half && s > 0) { var p = lerp(coords[i - 1], coords[i], (half - d) / s); return [round7(p[0]), round7(p[1])]; }
      d += s;
    }
    return coords[0].slice();
  }

  // Pair each opposite piece with the piece of ours it runs alongside: the one
  // nearest to its midpoint, each of ours used once (greedy, closest pair
  // first). The opposite direction runs the other way, so its piece order is
  // usually reversed. Returns [ourPieceIndex for each opposite piece] (-1 when
  // there are more opposite pieces than ours).
  function pairPieces(ourPieces, oppPieces) {
    var cand = [];
    (oppPieces || []).forEach(function (op, j) {
      var m = midpointOf(op);
      (ourPieces || []).forEach(function (ou, k) { cand.push({ j: j, k: k, d: distToLineFt(m, ou) }); });
    });
    cand.sort(function (a, b) { return a.d - b.d || a.j - b.j || a.k - b.k; });
    var res = (oppPieces || []).map(function () { return -1; }), usedK = {};
    cand.forEach(function (c) {
      if (res[c.j] >= 0 || usedK[c.k]) return;
      res[c.j] = c.k; usedK[c.k] = true;
    });
    return res;
  }

  App.splitGeom = {
    cutAt: cutAt,
    locate: locate,
    snapToVertex: snapToVertex,
    partitionWaypoints: partitionWaypoints,
    splitRunTime: splitRunTime,
    assignStops: assignStops,
    isLoop: isLoop,
    uniqueName: uniqueName,
    lengthMi: lengthMi,
    joinPieces: joinPieces,
    sectionBetween: sectionBetween,
    cutSection: cutSection,
    waypointCut: waypointCut,
    matchOppositeCuts: matchOppositeCuts,
    pairPieces: pairPieces,
    midpointOf: midpointOf
  };

  /* =====================================================================
     Engine
     ===================================================================== */

  var ID_PROP = { line: "lineIdx", route: "routeIdx" };
  var TYPE_LABEL = { line: "Line", route: "Route" };
  var END_GUARD_FT = 30;   // no cut this close to an end (or another cut)
  var LOOP_FT = 50;        // ends this close = a loop
  var STOP_TOL_FT = 50;    // stop this close to a cut links to both pieces
  var SNAP_PX = 10;        // snap the cut to a vertex this close on screen
  var SNAP_FT_FALLBACK = 25;
  var OPP_MAX_FT = 300;    // opposite-direction cut must be this close to ours
  var OPPOSITES = { "NB|SB": true, "EB|WB": true, "Inbound|Outbound": true, "CCW|CW": true };
  function isOppositePair(a, b) { return !!OPPOSITES[[trimStr(a), trimStr(b)].sort().join("|")]; }
  function dirOf(f) { return trimStr(f && f.properties && f.properties.attributes && f.properties.attributes.direction); }

  // Module references (App.describeFeatureUsage) worded for a split: the
  // feature keeps its ID on part 1, so a reference now covers part 1 only.
  function usageForSplit(type, id, name) {
    var out = { warn: [], info: [] };
    if (typeof App.describeFeatureUsage !== "function" || id == null) return out;
    App.describeFeatureUsage(type, id).forEach(function (u) {
      (u.severity === "warn" ? out.warn : out.info).push(u.label + " — after the split this refers to part 1 of '" + name + "' only.");
    });
    return out;
  }

  function arrayFor(type) { return type === "line" ? App.lines : type === "route" ? App.routes : null; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function fmtMi(v) { return (Math.round(v * 100) / 100).toFixed(2) + " mi"; }
  function trimStr(v) { return v == null ? "" : String(v).trim(); }

  // A cut given as a click location -> {segIndex, t}, snapped to a vertex within
  // ~10 px on screen (or ~25 ft when no map is available).
  function resolveCut(coords, c, hintSeg) {
    if (c && typeof c.segIndex === "number") return { segIndex: c.segIndex, t: +c.t || 0 };
    var loc = locate(coords, c, hintSeg);
    if (!loc) return null;
    var map = App.map;
    var snapFt = SNAP_FT_FALLBACK;
    if (map && typeof map.project === "function") {
      try {
        var a = coords[loc.segIndex], b = coords[loc.segIndex + 1];
        var v = loc.t > 0.5 ? b : a;
        var pp = map.project(loc.point), pv = map.project(v);
        var px = Math.sqrt((pp.x - pv.x) * (pp.x - pv.x) + (pp.y - pv.y) * (pp.y - pv.y));
        snapFt = px <= SNAP_PX ? Infinity : 0;
      } catch (e) { snapFt = SNAP_FT_FALLBACK; }
    }
    var s = snapToVertex(coords, loc, snapFt);
    return { segIndex: s.segIndex, t: s.t };
  }

  // Can "Split here" be offered at this map location? (menu visibility)
  function canSplitAt(type, index, lngLat) {
    var arr = arrayFor(type), f = arr && arr[index];
    if (!f || !f.geometry || f.geometry.type !== "LineString") return false;
    var coords = f.geometry.coordinates;
    if (coords.length < 2 || isLoop(coords, LOOP_FT)) return false;
    var c = resolveCut(coords, lngLat);
    if (!c) return false;
    var along = alongMi(coords, c), total = lengthMi(coords);
    return along * FT_PER_MI >= END_GUARD_FT && (total - along) * FT_PER_MI >= END_GUARD_FT;
  }

  function stopsLinkedTo(type, id) {
    var out = [];
    (App.points || []).forEach(function (pt) {
      var list = pt.properties && pt.properties.attributes && pt.properties.attributes.associatedRoutes;
      if (!Array.isArray(list)) return;
      if (list.some(function (r) { return r && r.featureType === type && r.featureId === id; })) out.push(pt);
    });
    return out;
  }

  // Other routes/lines in the same Service.
  function serviceMates(type, index, serviceId) {
    var out = [];
    ["route", "line"].forEach(function (t) {
      (arrayFor(t) || []).forEach(function (f, i) {
        if (t === type && i === index) return;
        var a = f.properties && f.properties.attributes;
        if (a && trimStr(a.serviceId) === serviceId) out.push({ feature: f, type: t, index: i });
      });
    });
    return out;
  }

  function allServiceIds() {
    var ids = [];
    ["route", "line"].forEach(function (t) {
      (arrayFor(t) || []).forEach(function (f) {
        var s = f.properties && f.properties.attributes && trimStr(f.properties.attributes.serviceId);
        if (s) ids.push(s);
      });
    });
    return ids;
  }

  // The "also split the opposite direction" option for a paired Service:
  // the mate's matching cut(s) by nearest position to each of our interior cut
  // points (<= OPP_MAX_FT), its own plan, and which of our pieces each of its
  // pieces runs alongside (its order is usually reversed). ->
  // { available, reason, type, index, featureId, name, direction, plan, pairOf }
  function analyzeOpposite(plan, coords, mate) {
    var mf = mate.feature;
    var o = { available: false, reason: "", type: mate.type, index: mate.index,
              featureId: mf.properties[ID_PROP[mate.type]], name: mf.properties.name || (TYPE_LABEL[mate.type] + " " + (mate.index + 1)),
              direction: dirOf(mf), plan: null, pairOf: [] };
    var mc = mf.geometry && mf.geometry.coordinates;
    if (!Array.isArray(mc) || mc.length < 2) { o.reason = "'" + o.name + "' has no line to split."; return o; }
    if (isLoop(mc, LOOP_FT)) { o.reason = "'" + o.name + "' is a loop, so it can't be split to match."; return o; }
    var n = coords.length;
    var pts = plan.cuts.filter(function (c) { var q = posOf(c); return q > EPS_T && q < n - 1 - EPS_T; })
      .map(function (c) { return cutPoint(coords, c); });
    var m = matchOppositeCuts(mc, pts, OPP_MAX_FT, END_GUARD_FT);
    if (!m.ok) {
      o.reason = m.reason === "far"
        ? "'" + o.name + "' doesn't pass within " + OPP_MAX_FT + " ft of the cut point" + (pts.length > 1 ? "s" : "") + " (nearest " + m.worstFt + " ft)."
        : m.reason === "end"
          ? "The matching point on '" + o.name + "' is too close to one of its ends."
          : "The two matching points on '" + o.name + "' are too close together.";
      return o;
    }
    var op = analyze(mate.type, mate.index, m.cuts.map(function (c) { return { segIndex: c.segIndex, t: c.t }; }), { noOpposite: true });
    if (!op.ok) { o.reason = op.errors[0] || "'" + o.name + "' can't be split there."; return o; }
    if (op.pieces.length !== plan.pieces.length) { o.reason = "'" + o.name + "' would not split into the same number of pieces."; return o; }
    o.plan = op;
    o.pairOf = pairPieces(plan.pieces.map(function (p) { return p.coords; }), op.pieces.map(function (p) { return p.coords; }));
    if (o.pairOf.indexOf(-1) >= 0) { o.reason = "The pieces of '" + o.name + "' could not be matched to these."; o.plan = null; return o; }
    o.available = true;
    return o;
  }

  // Service ids for the opposite feature's pieces: each takes the id of the
  // piece of ours it runs alongside, under the same Service choice.
  function oppositeServiceIds(plan, service) {
    var o = plan.opposite;
    return o.pairOf.map(function (k) {
      if (service === "same" || k === 0) return plan.serviceId;
      return service === "none" ? "" : plan.newServiceIds[k - 1];
    });
  }

  // analyze(type, index, cuts) -> plan. cuts: an array of {segIndex, t} or
  // click locations ([lng, lat] / {lng, lat}); a single cut may be passed bare.
  // Phase 2 passes two cuts for "Split out section…". Never mutates anything.
  // plan = { ok, errors, warnings, type, index, featureId, name, cuts,
  //          pieces: [{coords, waypoints, lengthMi, name, runTime}],
  //          stops: [{pointId, name, pieces}], stopsMoved, stopsBoth,
  //          serviceId, newServiceIds, hasHistory, summary }
  function analyze(type, index, cuts, opts) {
    opts = opts || {};
    var plan = { ok: false, errors: [], warnings: [], summary: [], type: type, index: index, pieces: [], stops: [],
                 stopsMoved: 0, stopsBoth: 0, serviceId: "", newServiceIds: [], hasHistory: false, cuts: [] };
    var arr = arrayFor(type);
    if (!arr) { plan.errors.push("Only lines and routes can be split."); return plan; }
    var f = arr[index];
    if (!f || !f.geometry || f.geometry.type !== "LineString" || f.geometry.coordinates.length < 2) {
      plan.errors.push("That feature could not be found."); return plan;
    }
    var coords = f.geometry.coordinates;
    var props = f.properties || {};
    var attrs = props.attributes || {};
    plan.featureId = props[ID_PROP[type]];
    plan.name = props.name || (TYPE_LABEL[type] + " " + (index + 1));
    if (!Array.isArray(cuts) || (cuts.length === 2 && typeof cuts[0] === "number")) cuts = [cuts];
    var resolved = cuts.map(function (c) { return resolveCut(coords, c); }).filter(Boolean);
    if (!resolved.length) { plan.errors.push("Couldn't find a place to cut on this feature."); return plan; }
    resolved.sort(function (a, b) { return posOf(a) - posOf(b); });
    plan.cuts = resolved;

    var loop = isLoop(coords, LOOP_FT);
    var isSection = resolved.length >= 2;
    if (loop && !isSection) {
      plan.errors.push("'" + plan.name + "' is a loop (its ends meet), so one cut only opens it. Use Split out section… instead.");
      return plan;
    }
    var total = lengthMi(coords), nC = coords.length;
    // Split out section on an open line: a point within ~30 ft of an end counts
    // as that end (the section runs to it), giving 2 pieces instead of 3.
    var atEnd = [];
    if (isSection && !loop) {
      resolved = resolved.map(function (c) {
        var al = alongMi(coords, c) * FT_PER_MI;
        if (al < END_GUARD_FT) { atEnd.push(true); return { segIndex: 0, t: 0 }; }
        if (total * FT_PER_MI - al < END_GUARD_FT) { atEnd.push(true); return { segIndex: nC - 2, t: 1 }; }
        atEnd.push(false); return c;
      });
      plan.cuts = resolved;
    }
    var interior = 0, prevAlong = 0;
    for (var i = 0; i < resolved.length; i++) {
      if (atEnd[i]) continue;
      var along = alongMi(coords, resolved[i]);
      if ((along - prevAlong) * FT_PER_MI < END_GUARD_FT || (total - along) * FT_PER_MI < END_GUARD_FT) {
        var nearOther = interior > 0 && (along - prevAlong) * FT_PER_MI < END_GUARD_FT;
        plan.errors.push(nearOther
          ? "The two points are too close together (or the same spot) on '" + plan.name + "' — the section would have almost no length."
          : "That cut is too close to an end of '" + plan.name + "' — a piece would have almost no length.");
        return plan;
      }
      prevAlong = along; interior++;
    }
    if (isSection && !loop && interior === 0) {
      plan.errors.push(posOf(resolved[0]) === posOf(resolved[1])
        ? "The two points are the same spot — pick two different places."
        : "Those points cover the whole " + type + " — there is nothing to split off.");
      return plan;
    }

    var pieceCoords, pieceWps, sectionPiece = -1;
    if (isSection) {
      var cs = cutSection(coords, type === "route" ? (props.waypoints || []) : null, resolved, loop);
      pieceCoords = cs.pieces; pieceWps = cs.waypoints; sectionPiece = cs.sectionPiece;
      if (pieceCoords.length !== (loop ? 2 : interior + 1)) { plan.errors.push("The cut did not produce separate pieces."); return plan; }
    } else {
      pieceCoords = cutAt(coords, resolved);
      if (pieceCoords.length !== resolved.length + 1) { plan.errors.push("The cut did not produce separate pieces."); return plan; }
      pieceWps = type === "route" ? partitionWaypoints(coords, props.waypoints || [], resolved) : null;
    }
    plan.sectionPiece = sectionPiece;
    plan.loop = loop;
    var lengths = pieceCoords.map(lengthMi);
    var runTimes = splitRunTime(attrs.runTime, lengths);

    var existingNames = arr.map(function (x) { return x.properties && x.properties.name; });
    var names = [plan.name];
    for (var k = 1; k < pieceCoords.length; k++) {
      var nm = uniqueName(plan.name, existingNames.concat(names), k + 1);
      names.push(nm);
    }
    plan.pieces = pieceCoords.map(function (c, k) {
      return { coords: c, waypoints: type === "route" ? pieceWps[k] : c.length, lengthMi: lengths[k],
               name: names[k], runTime: runTimes[k] };
    });

    // Services
    plan.serviceId = trimStr(attrs.serviceId);
    if (plan.serviceId) {
      var used = allServiceIds();
      for (var s = 1; s < plan.pieces.length; s++) {
        var sid = uniqueName(plan.serviceId, used.concat(plan.newServiceIds), s + 1);
        plan.newServiceIds.push(sid);
      }
      var mates = serviceMates(type, index, plan.serviceId);
      if (mates.length) {
        var pairWarn = "'" + plan.name + "' is one pattern of Service '" + plan.serviceId + "' (with " +
          mates.map(function (m) { return "'" + (m.feature.properties.name || "") + "'"; }).join(", ") +
          "). The opposite direction has not been split, so the pair will now cover only part 1.";
        if (!opts.noOpposite && mates.length === 1 && !loop && isOppositePair(dirOf(f), dirOf(mates[0].feature))) {
          plan.opposite = analyzeOpposite(plan, coords, mates[0]);
        }
        if (plan.opposite && plan.opposite.available) plan.pairWarning = pairWarn; // shown only while the option is off
        else plan.warnings.push(pairWarn);
      }
    }

    // Stops
    var linked = plan.featureId != null ? stopsLinkedTo(type, plan.featureId) : [];
    var assign = assignStops(linked.map(function (pt) { return { id: pt.properties.pointIdx, at: pt.geometry.coordinates }; }),
      pieceCoords, STOP_TOL_FT);
    if (loop && pieceCoords.length === 2) { // the second cut is the rest piece's start / section's end
      var c2 = pieceCoords[1][pieceCoords[1].length - 1];
      assign.forEach(function (a, n) {
        if (distFt(linked[n].geometry.coordinates, c2) <= STOP_TOL_FT && a.pieces.length < 2) a.pieces = [0, 1];
      });
    }
    plan.stops = assign.map(function (a, n) { return { pointId: a.id, name: linked[n].properties.name || "", pieces: a.pieces }; });
    plan.stops.forEach(function (st) {
      if (st.pieces.length > 1) plan.stopsBoth++;
      else if (st.pieces[0] !== 0) plan.stopsMoved++;
    });

    // Module references (Phase 3 hook)
    plan.usage = usageForSplit(type, plan.featureId, plan.name);

    // History
    plan.hasHistory = !!props._mergedFrom;
    if (plan.hasHistory) plan.warnings.push("'" + plan.name + "' was made by merging features. Unmerge will no longer be available for it after splitting.");

    // Summary lines
    var rt = attrs.runTime;
    if (runTimes[0] != null) {
      plan.summary.push("Run time " + rt + " min is divided by length: " +
        runTimes.map(function (v) { return v + " min"; }).join(" / ") + " (an estimate).");
    }
    if (linked.length) {
      var bits = [];
      if (plan.stopsMoved) bits.push(plural(plan.stopsMoved, "stop") + " move" + (plan.stopsMoved === 1 ? "s" : "") + " to " +
        (plan.pieces.length === 2 ? "part 2" : "a new piece"));
      if (plan.stopsBoth) bits.push(plural(plan.stopsBoth, "stop") + " at the cut point " + (plan.stopsBoth === 1 ? "is" : "are") + " linked to both");
      var stay = linked.length - plan.stopsMoved - plan.stopsBoth;
      if (stay) bits.push(plural(stay, "stop") + " stay" + (stay === 1 ? "s" : "") + " on part 1");
      plan.summary.push(bits.join("; ") + ".");
    }
    plan.ok = true;
    return plan;
  }

  // Mutate one feature per plan (no undo, no re-render). serviceIds
  // (optional): an explicit serviceId per piece (the opposite-direction split).
  function applyPlan(plan, names, service, serviceIds) {
    var type = plan.type, index = plan.index;
    var arr = arrayFor(type);
    var f = arr[index];
    var idProp = ID_PROP[type];

    var base = clone(f.properties);
    delete base._mergedFrom;

    // First piece: in place.
    delete f.properties._mergedFrom;
    f.properties.name = names[0];
    f.geometry = { type: "LineString", coordinates: plan.pieces[0].coords };
    f.properties.waypoints = plan.pieces[0].waypoints;
    if (plan.pieces[0].runTime != null && f.properties.attributes) f.properties.attributes.runTime = plan.pieces[0].runTime;
    if (serviceIds && f.properties.attributes) f.properties.attributes.serviceId = serviceIds[0];

    var indices = [index], ids = [plan.featureId], newRefs = [null];
    for (var k = 1; k < plan.pieces.length; k++) {
      var p = clone(base);
      delete p.seq;         // stamped fresh by the Features panel
      delete p.colorSeq;
      p[idProp] = App.nextFeatureId(type);
      p.name = names[k];
      p.waypoints = plan.pieces[k].waypoints;
      if (!p.color && typeof App._nextColorSeq === "function") p.colorSeq = App._nextColorSeq();
      if (p.attributes) {
        if (plan.pieces[k].runTime != null) p.attributes.runTime = plan.pieces[k].runTime;
        if (serviceIds) p.attributes.serviceId = serviceIds[k];
        else if (plan.serviceId) {
          if (service === "new") p.attributes.serviceId = plan.newServiceIds[k - 1];
          else if (service === "none") p.attributes.serviceId = "";
        }
      }
      arr.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: plan.pieces[k].coords } });
      indices.push(arr.length - 1);
      ids.push(p[idProp]);
      newRefs.push({ featureType: type, featureId: p[idProp], name: p.name });
    }

    // Stops
    var byPoint = {};
    plan.stops.forEach(function (s) { byPoint[s.pointId] = s.pieces; });
    (App.points || []).forEach(function (pt) {
      var set = byPoint[pt.properties.pointIdx];
      if (!set) return;
      var list = pt.properties.attributes.associatedRoutes, next = [];
      list.forEach(function (r) {
        if (r && r.featureType === type && r.featureId === plan.featureId) {
          set.forEach(function (k) {
            next.push(k === 0 ? { featureType: type, featureId: plan.featureId, name: names[0] } : clone(newRefs[k]));
          });
        } else next.push(r);
      });
      pt.properties.attributes.associatedRoutes = next;
    });
    return { indices: indices, ids: ids };
  }

  // The undoable operation. Call as run(type, index, cuts, choices) or
  // run(plan, choices). choices (optional): { names: [..per piece],
  // service: "new" (default) | "none" | "same", opposite: true (also split the
  // paired opposite-direction feature at the matching point, same undo step;
  // its pieces take the Service id of the piece of ours they run alongside),
  // oppositeNames: [..] }. Synchronous. Returns { ok, type, indices: [first,
  // ...new], ids, opposite: {type, indices, ids} | null, message } | { ok:false, errors }.
  function run(a, b, c, d) {
    var type, index, cuts, choices;
    if (a && typeof a === "object") { type = a.type; index = a.index; cuts = a.cuts; choices = b; }
    else { type = a; index = b; cuts = c; choices = d; }
    choices = choices || {};
    var plan = analyze(type, index, cuts);
    if (!plan.ok) return { ok: false, errors: plan.errors };
    if (a && typeof a === "object" && a.featureId !== plan.featureId) {
      return { ok: false, errors: ["The feature changed. Nothing was split."] };
    }
    var opp = null;
    if (choices.opposite) {
      opp = plan.opposite;
      if (!opp || !opp.available) return { ok: false, errors: [(opp && opp.reason) || "There is no opposite direction to split."] };
      if (a && typeof a === "object" && a.opposite && a.opposite.featureId !== opp.featureId) {
        return { ok: false, errors: ["The opposite direction changed. Nothing was split."] };
      }
    }
    var names = plan.pieces.map(function (p, k) {
      var n = choices.names && trimStr(choices.names[k]);
      return n || p.name;
    });
    var service = choices.service === "none" || choices.service === "same" ? choices.service : "new";

    if (App.undo && !App.undo.isRestoring()) App.undo.push(); // ONE snapshot (both directions)

    var res = applyPlan(plan, names, service, null);
    var oppRes = null;
    if (opp) {
      var oNames = opp.plan.pieces.map(function (p, k) {
        var n = choices.oppositeNames && trimStr(choices.oppositeNames[k]);
        return n || p.name;
      });
      oppRes = applyPlan(opp.plan, oNames, service, plan.serviceId ? oppositeServiceIds(plan, service) : null);
      oppRes.type = opp.type;
    }

    if (typeof App.closeAttrPopup === "function" && typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) App.closeAttrPopup();
    if (typeof App.rerenderForType === "function") {
      App.rerenderForType(type);
      if (opp && opp.type !== type) App.rerenderForType(opp.type);
      if (plan.stops.length || (opp && opp.plan.stops.length)) App.rerenderForType("point");
    }
    if (typeof App.onFeatureDelete === "function") App.onFeatureDelete(); // exit edit, clear selection, panel, notify, save
    var indices = res.indices;
    if (typeof App.selectFeature === "function") {
      if (plan.sectionPiece >= 0) {
        App.selectFeature(type, indices[plan.sectionPiece]); // Split out section: select the section
      } else {
        App.selectFeature(type, indices[0]);
        if (typeof App.toggleMultiSelect === "function") indices.slice(1).forEach(function (i) { App.toggleMultiSelect(type, i); });
      }
    }
    var msg = "Split '" + plan.name + "' into " + indices.length + " " + type + "s" +
      (opp ? " and '" + opp.name + "' into " + oppRes.indices.length : "") + " — Ctrl+Z to undo";
    if (typeof App.setStatus === "function") App.setStatus(msg);
    return { ok: true, type: type, indices: indices, ids: res.ids, opposite: oppRes, message: msg };
  }

  /* =====================================================================
     Dialog
     ===================================================================== */

  var _me = null;

  function closeDialog() {
    var kit = App.merge && App.merge._dialogKit;
    if (kit && _me && kit.isCurrent(_me)) kit.closeDialog();
    _me = null;
  }

  // openDialog(type, index, where): where is a click location or an array of
  // cuts (Phase 2 passes two). Returns the plan shown (or null).
  function openDialog(type, index, where) {
    var kit = App.merge && App.merge._dialogKit;
    if (!kit) return null;
    if (kit.isOpen()) kit.closeDialog();
    if (typeof App.closeContextMenu === "function") App.closeContextMenu();
    var cuts = Array.isArray(where) && where.length && typeof where[0] === "object" ? where : [where];
    var plan = analyze(type, index, cuts);
    var el = kit.el;

    var shell = kit.buildShell("Split '" + (plan.name || TYPE_LABEL[type] || "feature") + "'");
    var overlay = shell.overlay, box = shell.box;
    box.appendChild(el("div", "fm-intro", plan.ok
      ? "'" + plan.name + "' will become " + plan.pieces.length + " " + type + "s. Part 1 keeps its name, color and links; " +
        "the other parts are new " + type + "s with the same attributes."
      : "This " + (type || "feature") + " can't be split here."));
    var body = el("div", "fm-body");
    box.appendChild(body);

    var nameInputs = [], oppNameInputs = [], svcChoice = { value: "new" }, oppChoice = { checked: false };
    var refreshOpp = function () {};
    if (!plan.ok) {
      var eb = el("div", "fm-note fm-note-error");
      eb.setAttribute("role", "alert");
      kit.renderList(eb, plan.errors);
      body.appendChild(eb);
    } else {
      var sec = el("div", "fm-section");
      sec.appendChild(el("div", "fm-section-title", "Pieces"));
      plan.pieces.forEach(function (p, k) {
        var row = el("label", "fs-piece-row");
        var inp = document.createElement("input");
        inp.type = "text"; inp.className = "fp-attr-input"; inp.value = p.name;
        inp.setAttribute("aria-label", "Name of part " + (k + 1));
        nameInputs.push(inp);
        row.appendChild(inp);
        row.appendChild(el("span", "fs-piece-len", fmtMi(p.lengthMi)));
        sec.appendChild(row);
      });
      if (plan.sectionPiece >= 0) {
        sec.appendChild(el("div", "fm-hint", plan.loop
          ? "Part 2 is the section you picked. Part 1 is the rest of the loop, rejoined through its start, so it now begins at the second point."
          : "Part " + (plan.sectionPiece + 1) + " is the section you picked."));
      }
      body.appendChild(sec);

      if (plan.serviceId) {
        var ss = el("div", "fm-section");
        var st = el("div", "fm-section-title", "Service for the new " + (plan.pieces.length > 2 ? "pieces" : "piece") + ":");
        st.id = "fsSvcLabel";
        ss.appendChild(st);
        var grp = el("div", "fm-radio-list");
        grp.setAttribute("role", "radiogroup");
        grp.setAttribute("aria-labelledby", "fsSvcLabel");
        [["new", "New Service '" + plan.newServiceIds.join("', '") + "'"],
         ["none", "No Service (each piece stands alone)"],
         ["same", "Keep in Service '" + plan.serviceId + "' (branches / short-turns)"]].forEach(function (o) {
          var row = el("label", "fm-radio-row");
          var rb = document.createElement("input");
          rb.type = "radio"; rb.name = "fsService"; rb.value = o[0]; rb.checked = o[0] === "new";
          rb.addEventListener("change", function () { if (rb.checked) { svcChoice.value = o[0]; refreshOpp(); } });
          row.appendChild(rb);
          row.appendChild(el("span", "fm-radio-name", o[1]));
          grp.appendChild(row);
        });
        ss.appendChild(grp);
        ss.appendChild(el("div", "fm-hint", "Part 1 keeps Service '" + plan.serviceId + "'."));
        body.appendChild(ss);
      }
      if (plan.opposite) {
        var o = plan.opposite;
        var os = el("div", "fm-section fs-opposite");
        var orow = el("label", "fm-radio-row");
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.id = "fsOpposite"; cb.disabled = !o.available;
        orow.appendChild(cb);
        orow.appendChild(el("span", "fm-radio-name", "Also split the opposite direction ('" + o.name + "', " + o.direction + ") at the matching point"));
        os.appendChild(orow);
        if (!o.available) {
          os.appendChild(el("div", "fm-hint fs-opposite-why", "Not available: " + o.reason));
        }
        var oBody = el("div", "fs-opposite-body");
        oBody.style.display = "none";
        os.appendChild(oBody);
        var pairNote = plan.pairWarning ? el("div", "fm-note fm-note-warn fs-pair-warn", plan.pairWarning) : null;
        if (o.available) {
          o.plan.pieces.forEach(function (p, j) {
            var row = el("label", "fs-piece-row");
            var inp = document.createElement("input");
            inp.type = "text"; inp.className = "fp-attr-input"; inp.value = p.name;
            inp.setAttribute("aria-label", "Name of opposite part " + (j + 1));
            oppNameInputs.push(inp);
            row.appendChild(inp);
            row.appendChild(el("span", "fs-piece-len", fmtMi(p.lengthMi)));
            var sv = el("span", "fm-hint fs-piece-svc");
            row.appendChild(sv);
            oBody.appendChild(row);
          });
          oBody.appendChild(el("div", "fm-hint", "It runs the other way, so each of its parts pairs with the part of '" + plan.name +
            "' it runs alongside (part " + o.pairOf.map(function (k) { return k + 1; }).join(", part ") + ")."));
          if (o.plan.usage) kit.renderUsage(oBody, o.plan.usage, "'" + o.name + "' is also used by");
          refreshOpp = function () {
            oBody.style.display = oppChoice.checked ? "" : "none";
            if (pairNote) pairNote.style.display = oppChoice.checked ? "none" : "";
            var ids = oppositeServiceIds(plan, svcChoice.value);
            oBody.querySelectorAll(".fs-piece-svc").forEach(function (sp, j) { sp.textContent = ids[j] ? "Service '" + ids[j] + "'" : "no Service"; });
          };
          cb.addEventListener("change", function () { oppChoice.checked = cb.checked; refreshOpp(); });
          refreshOpp();
        }
        body.appendChild(os);
        if (pairNote) body.appendChild(pairNote);
      }
      if (plan.summary.length) {
        var rs = el("div", "fm-section");
        rs.appendChild(el("div", "fm-section-title", "Result"));
        kit.renderList(rs, plan.summary, "fm-list");
        body.appendChild(rs);
      }
      if (plan.warnings.length) {
        var wb = el("div", "fm-note fm-note-warn");
        kit.renderList(wb, plan.warnings);
        body.appendChild(wb);
      }
      if (plan.usage && kit.renderUsage) kit.renderUsage(body, plan.usage);
    }
    box.appendChild(el("div", "fm-footnote", "You can undo this with Ctrl+Z until you reload the page."));
    var acts = kit.buildActions(box, "Split");
    acts.okBtn.disabled = !plan.ok;

    function doSplit() {
      if (!plan.ok) return;
      var res = run(plan, { names: nameInputs.map(function (i) { return i.value; }), service: svcChoice.value,
        opposite: oppChoice.checked, oppositeNames: oppNameInputs.map(function (i) { return i.value; }) });
      if (res && res.ok) { closeDialog(); return; }
      var e2 = el("div", "fm-note fm-note-error", "Split failed: " + ((res && res.errors && res.errors.join(" ")) || "unknown error"));
      e2.setAttribute("role", "alert");
      body.insertBefore(e2, body.firstChild);
    }
    acts.cancelBtn.addEventListener("click", closeDialog);
    acts.okBtn.addEventListener("click", doSplit);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeDialog(); });
    _me = kit.installDialog(overlay, box, doSplit);
    (plan.ok ? acts.okBtn : acts.cancelBtn).focus();
    return plan;
  }

  /* =====================================================================
     Split out section… — two-point pick mode (Phase 2)
     ===================================================================== */

  var PICK_MODE = "split-pick";
  var PV_SRC = "split-preview", PV_LINE = "split-preview-line", PV_CUT = "split-preview-cut";
  var _pick = null; // { type, id, cut1, raf, last, onMove, onClick, onCtx, onKey, onDocClick }

  function pickIndex() {
    if (!_pick) return -1;
    var arr = arrayFor(_pick.type) || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].properties && arr[i].properties[ID_PROP[_pick.type]] === _pick.id) return i;
    return -1;
  }

  function previewData(section, cutPt) {
    var feats = [];
    if (section && section.length >= 2) feats.push({ type: "Feature", properties: { kind: "section" }, geometry: { type: "LineString", coordinates: section } });
    if (cutPt) feats.push({ type: "Feature", properties: { kind: "cut" }, geometry: { type: "Point", coordinates: cutPt } });
    return { type: "FeatureCollection", features: feats };
  }

  // Create (or re-create after a basemap/style reload) the preview source+layers
  // on top of everything drawn.
  function ensurePreviewLayers() {
    var map = App.map;
    if (!map) return false;
    if (!map.getSource(PV_SRC)) map.addSource(PV_SRC, { type: "geojson", data: previewData(null, null) });
    if (!map.getLayer(PV_LINE)) map.addLayer({ id: PV_LINE, type: "line", source: PV_SRC, filter: ["==", ["get", "kind"], "section"],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#f97316", "line-width": 7, "line-opacity": 0.9 } });
    if (!map.getLayer(PV_CUT)) map.addLayer({ id: PV_CUT, type: "circle", source: PV_SRC, filter: ["==", ["get", "kind"], "cut"],
      paint: { "circle-radius": 7, "circle-color": "#f97316", "circle-stroke-width": 2.5, "circle-stroke-color": "#ffffff" } });
    return true;
  }

  function removePreviewLayers() {
    var map = App.map;
    if (!map) return;
    try {
      if (map.getLayer(PV_LINE)) map.removeLayer(PV_LINE);
      if (map.getLayer(PV_CUT)) map.removeLayer(PV_CUT);
      if (map.getSource(PV_SRC)) map.removeSource(PV_SRC);
    } catch (e) { /* map mid-teardown */ }
  }

  function cutPoint(coords, c) {
    var p = lerp(coords[c.segIndex], coords[c.segIndex + 1], c.t);
    return [round7(p[0]), round7(p[1])];
  }

  function updatePreview() {
    if (!_pick) return;
    _pick.raf = 0;
    var i = pickIndex();
    if (i < 0) { cancelPick(); return; }
    var coords = arrayFor(_pick.type)[i].geometry.coordinates;
    var c2 = _pick.last ? resolveCut(coords, _pick.last) : null;
    var section = c2 ? sectionBetween(coords, _pick.cut1, c2) : null;
    if (!ensurePreviewLayers()) return;
    App.map.getSource(PV_SRC).setData(previewData(section, cutPoint(coords, _pick.cut1)));
  }

  // Leave pick mode and remove everything it added. Safe to call when idle.
  function cancelPick(silent) {
    var pk = _pick;
    if (!pk) return false;
    _pick = null;
    if (pk.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(pk.raf);
    if (App.map) {
      App.map.off("mousemove", pk.onMove);
      App.map.off("click", pk.onClick);
      App.map.off("contextmenu", pk.onCtx);
    }
    document.removeEventListener("keydown", pk.onKey, true);
    document.removeEventListener("click", pk.onDocClick, true);
    removePreviewLayers();
    if (App.drawMode === PICK_MODE) {
      App.drawMode = null;
      if (App.map) App.map.getCanvas().style.cursor = "grab";
    }
    if (!silent && typeof App.setStatus === "function") App.setStatus("Ready");
    return true;
  }

  // Enter the two-point pick: `where` (the right-click location, or a cut) is
  // the first point; the next map click sets the second and opens the dialog.
  function startSectionPick(type, index, where) {
    var arr = arrayFor(type), f = arr && arr[index];
    if (!f || !f.geometry || f.geometry.type !== "LineString" || f.geometry.coordinates.length < 2 || !App.map) return false;
    cancelPick(true);
    var kit = App.merge && App.merge._dialogKit;
    if (kit && kit.isOpen()) kit.closeDialog();
    var coords = f.geometry.coordinates;
    var cut1 = resolveCut(coords, where);
    if (!cut1) return false;
    if (typeof App.deactivateVertexEdit === "function") App.deactivateVertexEdit(); // hide vertex handles, keep the selection
    var pk = { type: type, id: f.properties[ID_PROP[type]], cut1: cut1, raf: 0, last: null };
    pk.onMove = function (e) {
      pk.last = [e.lngLat.lng, e.lngLat.lat];
      if (!pk.raf) pk.raf = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); })(updatePreview);
    };
    pk.onClick = function (e) {
      if (e.originalEvent && e.originalEvent.button > 0) return;
      var i = pickIndex();
      if (i < 0) { cancelPick(); return; }
      var cuts = [cut1, resolveCut(arrayFor(type)[i].geometry.coordinates, [e.lngLat.lng, e.lngLat.lat])];
      var plan = analyze(type, i, cuts);
      if (!plan.ok) { // stay in the mode so the user can pick a better second point
        if (typeof App.setStatus === "function") App.setStatus(plan.errors[0] + " (Esc to cancel)");
        return;
      }
      cancelPick(true);
      openDialog(type, i, cuts);
    };
    pk.onCtx = function (e) { if (e.preventDefault) e.preventDefault(); cancelPick(); };
    pk.onKey = function (e) {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      cancelPick();
    };
    pk.onDocClick = function (e) { // a toolbar tool button ends the mode (its own handler then runs)
      if (e.target && e.target.closest && e.target.closest(".tool-btn")) cancelPick(true);
    };
    _pick = pk;
    App.drawMode = PICK_MODE;
    App.map.getCanvas().style.cursor = "crosshair";
    App.map.on("mousemove", pk.onMove);
    App.map.on("click", pk.onClick);
    App.map.on("contextmenu", pk.onCtx);
    document.addEventListener("keydown", pk.onKey, true);
    document.addEventListener("click", pk.onDocClick, true);
    if (ensurePreviewLayers()) App.map.getSource(PV_SRC).setData(previewData(null, cutPoint(coords, cut1)));
    if (typeof App.setStatus === "function") App.setStatus("Click the second point of the section to split out (Esc or right-click to cancel)");
    return true;
  }

  // Can "Split at this node" be offered for vertex/waypoint vertexIdx? (vertex-edit menu)
  // Lines: any interior vertex. Routes: any interior waypoint. Never on a loop
  // (one cut on a loop only opens it — use Split out section…).
  function nodeCut(type, index, vertexIdx) {
    var arr = arrayFor(type), f = arr && arr[index];
    if (!f || !f.geometry || f.geometry.type !== "LineString") return null;
    var coords = f.geometry.coordinates;
    if (coords.length < 3 || isLoop(coords, LOOP_FT)) return null;
    if (type === "line") return vertexIdx > 0 && vertexIdx < coords.length - 1 ? { segIndex: vertexIdx, t: 0 } : null;
    var wps = f.properties.waypoints || [];
    if (!(vertexIdx > 0 && vertexIdx < wps.length - 1)) return null;
    return waypointCut(coords, wps, vertexIdx);
  }

  function splitAtNode(type, index, vertexIdx) {
    var c = nodeCut(type, index, vertexIdx);
    if (!c) return null;
    return openDialog(type, index, [c]);
  }

  App.split = {
    analyze: analyze,
    run: run,
    openDialog: openDialog,
    closeDialog: closeDialog,
    canSplitAt: canSplitAt,
    startSectionPick: startSectionPick,
    cancelPick: cancelPick,
    isPicking: function () { return !!_pick; },
    nodeCut: nodeCut,
    splitAtNode: splitAtNode,
    resolveCut: resolveCut,
    isDialogOpen: function () { return !!_me && !!(App.merge && App.merge._dialogKit.isCurrent(_me)); }
  };
})();
