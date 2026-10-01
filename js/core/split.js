// js/core/split.js
//
// Feature Split (docs/feature-split-plan.md, Phase 1: "Split here" for lines
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
      var nearCut = (cp && distFt(w, cp.point) < 3) || (k > 0 && distFt(w, cutPos[k - 1].point) < 3);
      if (!nearCut) out[k].push(w.slice());
    });
    while (k < cutPos.length) { out[k].push(cutPos[k].point.slice()); out.push([cutPos[k].point.slice()]); k++; }
    return out;
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

  App.splitGeom = {
    cutAt: cutAt,
    locate: locate,
    snapToVertex: snapToVertex,
    partitionWaypoints: partitionWaypoints,
    splitRunTime: splitRunTime,
    assignStops: assignStops,
    isLoop: isLoop,
    uniqueName: uniqueName,
    lengthMi: lengthMi
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
        if (a && trimStr(a.serviceId) === serviceId) out.push(f);
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

  // analyze(type, index, cuts) -> plan. cuts: an array of {segIndex, t} or
  // click locations ([lng, lat] / {lng, lat}); a single cut may be passed bare.
  // Phase 2 passes two cuts for "Split out section…". Never mutates anything.
  // plan = { ok, errors, warnings, type, index, featureId, name, cuts,
  //          pieces: [{coords, waypoints, lengthMi, name, runTime}],
  //          stops: [{pointId, name, pieces}], stopsMoved, stopsBoth,
  //          serviceId, newServiceIds, hasHistory, summary }
  function analyze(type, index, cuts) {
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
    if (loop && resolved.length < 2) {
      plan.errors.push("'" + plan.name + "' is a loop (its ends meet), so one cut only opens it. Use Split out section… instead.");
      return plan;
    }
    var total = lengthMi(coords), prevAlong = 0;
    for (var i = 0; i < resolved.length; i++) {
      var along = alongMi(coords, resolved[i]);
      if ((along - prevAlong) * FT_PER_MI < END_GUARD_FT || (total - along) * FT_PER_MI < END_GUARD_FT) {
        plan.errors.push("That cut is too close to " + (i > 0 && (along - prevAlong) * FT_PER_MI < END_GUARD_FT ? "the other cut" : "an end") +
          " of '" + plan.name + "' — a piece would have almost no length.");
        return plan;
      }
      prevAlong = along;
    }

    var pieceCoords = cutAt(coords, resolved);
    if (pieceCoords.length !== resolved.length + 1) { plan.errors.push("The cut did not produce separate pieces."); return plan; }
    var pieceWps = type === "route" ? partitionWaypoints(coords, props.waypoints || [], resolved) : null;
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
        plan.warnings.push("'" + plan.name + "' is one pattern of Service '" + plan.serviceId + "' (with " +
          mates.map(function (m) { return "'" + (m.properties.name || "") + "'"; }).join(", ") +
          "). The opposite direction has not been split, so the pair will now cover only part 1.");
      }
    }

    // Stops
    var linked = plan.featureId != null ? stopsLinkedTo(type, plan.featureId) : [];
    var assign = assignStops(linked.map(function (pt) { return { id: pt.properties.pointIdx, at: pt.geometry.coordinates }; }),
      pieceCoords, STOP_TOL_FT);
    plan.stops = assign.map(function (a, n) { return { pointId: a.id, name: linked[n].properties.name || "", pieces: a.pieces }; });
    plan.stops.forEach(function (st) {
      if (st.pieces.length > 1) plan.stopsBoth++;
      else if (st.pieces[0] !== 0) plan.stopsMoved++;
    });

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

  // The undoable operation. Call as run(type, index, cuts, choices) or
  // run(plan, choices). choices (optional): { names: [..per piece],
  // service: "new" (default) | "none" | "same" }. Synchronous. Returns
  // { ok, type, indices: [first, ...new], ids, message } | { ok:false, errors }.
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
    var arr = arrayFor(type);
    var f = arr[index];
    var idProp = ID_PROP[type];
    var names = plan.pieces.map(function (p, k) {
      var n = choices.names && trimStr(choices.names[k]);
      return n || p.name;
    });
    var service = choices.service === "none" || choices.service === "same" ? choices.service : "new";

    if (App.undo && !App.undo.isRestoring()) App.undo.push(); // ONE snapshot

    var base = clone(f.properties);
    delete base._mergedFrom;

    // First piece: in place.
    delete f.properties._mergedFrom;
    f.properties.name = names[0];
    f.geometry = { type: "LineString", coordinates: plan.pieces[0].coords };
    f.properties.waypoints = plan.pieces[0].waypoints;
    if (plan.pieces[0].runTime != null && f.properties.attributes) f.properties.attributes.runTime = plan.pieces[0].runTime;

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
        if (plan.serviceId) {
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

    if (typeof App.closeAttrPopup === "function" && typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) App.closeAttrPopup();
    if (typeof App.rerenderForType === "function") {
      App.rerenderForType(type);
      if (plan.stops.length) App.rerenderForType("point");
    }
    if (typeof App.onFeatureDelete === "function") App.onFeatureDelete(); // exit edit, clear selection, panel, notify, save
    if (typeof App.selectFeature === "function") {
      App.selectFeature(type, indices[0]);
      if (typeof App.toggleMultiSelect === "function") indices.slice(1).forEach(function (i) { App.toggleMultiSelect(type, i); });
    }
    var msg = "Split '" + plan.name + "' into " + indices.length + " " + type + "s — Ctrl+Z to undo";
    if (typeof App.setStatus === "function") App.setStatus(msg);
    return { ok: true, type: type, indices: indices, ids: ids, message: msg };
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

    var nameInputs = [], svcChoice = { value: "new" };
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
          rb.addEventListener("change", function () { if (rb.checked) svcChoice.value = o[0]; });
          row.appendChild(rb);
          row.appendChild(el("span", "fm-radio-name", o[1]));
          grp.appendChild(row);
        });
        ss.appendChild(grp);
        ss.appendChild(el("div", "fm-hint", "Part 1 keeps Service '" + plan.serviceId + "'."));
        body.appendChild(ss);
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
    }
    box.appendChild(el("div", "fm-footnote", "You can undo this with Ctrl+Z until you reload the page."));
    var acts = kit.buildActions(box, "Split");
    acts.okBtn.disabled = !plan.ok;

    function doSplit() {
      if (!plan.ok) return;
      var res = run(plan, { names: nameInputs.map(function (i) { return i.value; }), service: svcChoice.value });
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

  App.split = {
    analyze: analyze,
    run: run,
    openDialog: openDialog,
    closeDialog: closeDialog,
    canSplitAt: canSplitAt,
    resolveCut: resolveCut,
    isDialogOpen: function () { return !!_me && !!(App.merge && App.merge._dialogKit.isCurrent(_me)); }
  };
})();
