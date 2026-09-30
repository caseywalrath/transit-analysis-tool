// js/core/merge.js
// Feature Merge (docs/feature-merge-plan.md). Phases 2-3: lines, polygons,
// routes, points ("combine stops") and line + route (result is a Line).
//
// Three layers, each usable on its own:
//   1. Pure helpers (no turf / DOM / map — loaded by the golden harness):
//        App.mergeGeom  — chainLines, findBranch, lengthMi, routeChain
//                         (planRouteChain / assembleChain: route waypoint +
//                         connector assembly)
//        App.mergeAttrs — hasValue, fieldHasValue, mergeAttributes,
//                         reversalWarnings
//   2. Per-type STRATEGIES (line, route, point, polygon, linemix). A
//      strategy's analyze() inspects a selection SYNCHRONOUSLY and cheaply and
//      returns a "plan": errors / warnings / summary / discarded list, the
//      survivor + removed refs, an apply() closure that mutates the survivor,
//      and optionally prepare(ctx) — an async step that runs only when the
//      user clicks Merge (routes use it to street-route connectors). The undo
//      snapshot is taken after prepare() finishes, right before apply().
//   3. App.merge — run() (the undoable operation, returns a Promise) and
//      openDialog() (the modal).
//
// Refs: a selection member is { type, index } (indices are per type, so a
// line + route selection addresses two arrays). Single-type callers may still
// pass plain numeric indices; "linemix" (line + route) takes refs.
//
// Survivor model: one selected feature survives in place (same array position
// of ITS type, ID, colorSeq); every other selected feature is spliced out
// after ONE App.undo.push() (never App.removeX in a loop — each pushes its own
// snapshot). The survivor is the primary, except for line + route with a route
// primary, where the first selected line survives and takes the primary's
// name, color, appearance overrides and attributes.
//
// Depends on: App.lines/routes/polygons/points, App.undo, App.rerenderForType,
//   App.onFeatureDelete, App.selectFeature, App.fetchRouteGeometry (routes),
//   App.foldAnalysisUnion (polygons, turf), App.ensurePointWalksheds /
//   App.dropPointWalksheds / App.refreshBuffers (points) — all only touched
//   inside functions, never at load time.
// Exports: App.mergeGeom, App.mergeAttrs, App.merge

(function () {
  var App = window.App = window.App || {};

  /* =====================================================================
     Pure geometry helpers
     ===================================================================== */

  var MI_PER_DEG = Math.PI / 180 * 3958.8;   // miles per degree of latitude
  var COINCIDENT_MI = 0.000621;              // ~1 m: a join this close is "touching"
  var BRANCH_TOLERANCE_MI = 50 / 5280;       // ~50 ft
  var LONG_CONNECTOR_MI = 0.25;

  // Equirectangular distance in miles (fine at city scale).
  function distMi(a, b) {
    var lat = (a[1] + b[1]) / 2 * Math.PI / 180;
    var dx = (a[0] - b[0]) * Math.cos(lat);
    var dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy) * MI_PER_DEG;
  }

  function lengthMi(coords) {
    var t = 0;
    for (var i = 1; i < (coords || []).length; i++) t += distMi(coords[i - 1], coords[i]);
    return t;
  }

  // Order N polylines end to end. Tries every segment x orientation as the
  // start, greedily appends the remaining segment/orientation whose start is
  // nearest the current end, and keeps the ordering with the smallest total
  // connector length (ties: fewer reversed segments, then first found).
  // Returns { order, reversed, connectorsMi, coords }; order[k] is the input
  // index placed k-th, reversed[k] says whether it was flipped, connectorsMi[k]
  // is the straight gap between placed segment k and k+1.
  function chainLines(coordArrays, opts) {
    var n = coordArrays ? coordArrays.length : 0;
    var coincident = opts && opts.coincidentMi != null ? opts.coincidentMi : COINCIDENT_MI;
    if (!n) return { order: [], reversed: [], connectorsMi: [], coords: [] };

    function startOf(i, rev) { var c = coordArrays[i]; return rev ? c[c.length - 1] : c[0]; }
    function endOf(i, rev)   { var c = coordArrays[i]; return rev ? c[0] : c[c.length - 1]; }

    function greedy(s, srev) {
      var order = [s], reversed = [srev], conns = [], used = {};
      used[s] = true;
      var total = 0, nRev = srev ? 1 : 0, cur = endOf(s, srev);
      while (order.length < n) {
        var bu = -1, br = false, bd = Infinity;
        for (var u = 0; u < n; u++) {
          if (used[u]) continue;
          for (var r = 0; r < 2; r++) {
            var d = distMi(cur, startOf(u, r === 1));
            if (d < bd) { bd = d; bu = u; br = (r === 1); }
          }
        }
        used[bu] = true; order.push(bu); reversed.push(br); conns.push(bd);
        total += bd; if (br) nRev++;
        cur = endOf(bu, br);
      }
      return { order: order, reversed: reversed, conns: conns, total: total, nRev: nRev };
    }

    var best = null;
    for (var s = 0; s < n; s++) {
      for (var sr = 0; sr < 2; sr++) {
        var cand = greedy(s, sr === 1);
        if (!best || cand.total < best.total - 1e-9 ||
            (Math.abs(cand.total - best.total) <= 1e-9 && cand.nRev < best.nRev)) best = cand;
      }
    }

    var coords = [];
    for (var k = 0; k < best.order.length; k++) {
      var src = coordArrays[best.order[k]].map(function (c) { return c.slice(); });
      if (best.reversed[k]) src.reverse();
      // A coincident join drops the duplicate vertex; a real gap keeps both
      // ends so the straight connector between them is drawn.
      if (k > 0 && best.conns[k - 1] < coincident) src.shift();
      for (var m = 0; m < src.length; m++) coords.push(src[m]);
    }
    return { order: best.order, reversed: best.reversed, connectorsMi: best.conns, coords: coords };
  }

  // Y/T junction detector: is any line's endpoint within toleranceMi of the
  // INTERIOR of another selected line? (An endpoint near another line's own
  // end is an ordinary end-to-end join and is ignored.) Returns
  // { lineIndex, end: "start"|"end", onLineIndex, distanceMi } or null.
  function findBranch(coordArrays, toleranceMi) {
    var tol = toleranceMi != null ? toleranceMi : BRANCH_TOLERANCE_MI;
    var n = coordArrays ? coordArrays.length : 0;
    for (var i = 0; i < n; i++) {
      var ci = coordArrays[i];
      if (!ci || !ci.length) continue;
      var ends = [{ p: ci[0], name: "start" }, { p: ci[ci.length - 1], name: "end" }];
      for (var e = 0; e < 2; e++) {
        var p = ends[e].p;
        var cosLat = Math.cos(p[1] * Math.PI / 180);
        for (var j = 0; j < n; j++) {
          if (j === i) continue;
          var cj = coordArrays[j];
          if (!cj || cj.length < 2) continue;
          // Local planar miles centred on the endpoint.
          var pts = cj.map(function (c) {
            return [(c[0] - p[0]) * cosLat * MI_PER_DEG, (c[1] - p[1]) * MI_PER_DEG];
          });
          var first = pts[0], last = pts[pts.length - 1];
          for (var s = 0; s < pts.length - 1; s++) {
            var a = pts[s], b = pts[s + 1];
            var vx = b[0] - a[0], vy = b[1] - a[1];
            var len2 = vx * vx + vy * vy;
            var t = len2 > 0 ? Math.max(0, Math.min(1, -(a[0] * vx + a[1] * vy) / len2)) : 0;
            var nx = a[0] + t * vx, ny = a[1] + t * vy;
            var d = Math.sqrt(nx * nx + ny * ny);
            if (d > tol) continue;
            var nearFirst = Math.sqrt((nx - first[0]) * (nx - first[0]) + (ny - first[1]) * (ny - first[1])) <= tol;
            var nearLast  = Math.sqrt((nx - last[0])  * (nx - last[0])  + (ny - last[1])  * (ny - last[1]))  <= tol;
            if (nearFirst || nearLast) continue; // end-to-end join, not a branch
            return { lineIndex: i, end: ends[e].name, onLineIndex: j, distanceMi: d };
          }
        }
      }
    }
    return null;
  }

  function lastOf(a) { return a[a.length - 1]; }
  function cloneCoords(a) { return (a || []).map(function (c) { return c.slice(); }); }

  // Route chaining. items: [{ coords, waypoints }] (snapped geometry + the
  // clicked waypoints). Orders them with chainLines, orients each piece
  // (coords AND waypoints reversed together when the segment is flipped), and
  // concatenates the waypoints, dropping a segment's first waypoint when it
  // sits on the previous segment's last one (a coincident geometry join, or two
  // waypoints within ~1 m) so a touching join never doubles a via-point.
  // `gaps` lists every NON-coincident join as { k, from, to, mi } — k is the
  // connector's position in `connectorsMi` (between placed piece k and k+1) —
  // which the caller may street-route. Returns
  // { order, reversed, connectorsMi, gaps, waypoints, pieces }.
  function planRouteChain(items) {
    var chain = chainLines(items.map(function (it) { return it.coords; }));
    var pieces = chain.order.map(function (o, k) {
      var c = cloneCoords(items[o].coords), w = cloneCoords(items[o].waypoints);
      if (chain.reversed[k]) { c.reverse(); w.reverse(); }
      return { coords: c, waypoints: w };
    });
    var waypoints = [], gaps = [];
    pieces.forEach(function (p, k) {
      var w = p.waypoints;
      if (k > 0) {
        var conn = chain.connectorsMi[k - 1];
        var coincident = conn < COINCIDENT_MI;
        if (!coincident) gaps.push({ k: k - 1, from: lastOf(pieces[k - 1].coords).slice(), to: p.coords[0].slice(), mi: conn });
        if (w.length && waypoints.length && (coincident || distMi(lastOf(waypoints), w[0]) < COINCIDENT_MI)) w = w.slice(1);
      }
      for (var i = 0; i < w.length; i++) waypoints.push(w[i]);
    });
    return { order: chain.order, reversed: chain.reversed, connectorsMi: chain.connectorsMi,
             gaps: gaps, waypoints: waypoints, pieces: pieces };
  }

  // Joined vertex list for a planRouteChain result. connectorGeoms maps a
  // gap's k to the routed connector coordinates (>= 2 points); a gap with no
  // entry keeps the straight step between the two piece ends. A vertex that
  // lands within ~1 m of the one before it is dropped at every join.
  function assembleChain(plan, connectorGeoms) {
    var out = [];
    function push(c, dedupe) {
      if (dedupe && out.length && distMi(lastOf(out), c) < COINCIDENT_MI) return;
      out.push(c.slice());
    }
    plan.pieces.forEach(function (p, k) {
      if (k > 0) {
        var g = connectorGeoms && connectorGeoms[k - 1];
        if (g && g.length >= 2 && plan.connectorsMi[k - 1] >= COINCIDENT_MI) {
          for (var j = 0; j < g.length; j++) push(g[j], j === 0);
        }
      }
      for (var i = 0; i < p.coords.length; i++) push(p.coords[i], i === 0 && k > 0);
    });
    return out;
  }

  // Convenience for tests / one-shot callers: plan + assembled coords.
  function routeChain(items, connectorGeoms) {
    var plan = planRouteChain(items);
    return { order: plan.order, reversed: plan.reversed, connectorsMi: plan.connectorsMi, gaps: plan.gaps,
             waypoints: plan.waypoints, coords: assembleChain(plan, connectorGeoms) };
  }

  App.mergeGeom = {
    planRouteChain: planRouteChain,
    assembleChain: assembleChain,
    routeChain: routeChain,
    chainLines: chainLines,
    findBranch: findBranch,
    lengthMi: lengthMi,
    distMi: distMi,
    BRANCH_TOLERANCE_MI: BRANCH_TOLERANCE_MI,
    LONG_CONNECTOR_MI: LONG_CONNECTOR_MI,
    COINCIDENT_MI: COINCIDENT_MI
  };

  /* =====================================================================
     Pure attribute-merge rules ("primary wins, fill blanks")
     ===================================================================== */

  var KEY_LABELS = {
    group: "Group", direction: "Direction", mode: "Mode", serviceId: "Service",
    avgSpeed: "Avg speed", runTime: "Run time", service: "Service bands",
    notes: "Notes", stopId: "Stop ID", serviceAreaType: "Service area",
    associatedRoutes: "Routes"
  };

  // Total bands across a `service` object (Sunday mirrors Saturday when flagged).
  function bandsCount(v) {
    if (!v || typeof v !== "object") return 0;
    var w = (v.weekday  || []).length;
    var s = (v.saturday || []).length;
    var u = v.sundayMirrorsSaturday ? s : (v.sunday || []).length;
    return w + s + u;
  }

  function isBandsObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v) &&
      (Array.isArray(v.weekday) || Array.isArray(v.saturday) || Array.isArray(v.sunday));
  }

  // Kind-based "has a value" — the exact semantics Attribute Summary's Copy
  // Attributes uses (it delegates here so the two never drift). Note text is
  // NOT trimmed in this variant; that is Copy Attributes' existing behavior.
  function fieldHasValue(kind, v) {
    if (kind === "number")     return v != null && !isNaN(v);
    if (kind === "routearray") return Array.isArray(v) && v.length > 0;
    if (kind === "bands")      return bandsCount(v) > 0;
    return v != null && v !== ""; // text / select
  }

  // Generic "has a value" for merging, inferred from the value's shape:
  // non-empty trimmed string, finite number, non-empty array, service object
  // with at least one band, or non-empty plain object.
  function hasValue(v) {
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (typeof v === "number") return isFinite(v);
    if (typeof v === "boolean") return v === true;
    if (Array.isArray(v)) return fieldHasValue("routearray", v);
    if (typeof v === "object") return isBandsObject(v) ? bandsCount(v) > 0 : Object.keys(v).length > 0;
    return false;
  }

  function positive(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) && n > 0;
  }
  function num(v) { return typeof v === "number" ? v : parseFloat(v); }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
    var na = typeof a === "number" || typeof a === "string" ? parseFloat(a) : NaN;
    var nb = typeof b === "number" || typeof b === "string" ? parseFloat(b) : NaN;
    if (isFinite(na) && isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
    if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // Short human text for the dialog's discard list.
  function displayValue(v) {
    if (isBandsObject(v)) {
      var s = (v.saturday || []).length;
      return (v.weekday || []).length + " weekday / " + s + " Saturday / " +
        (v.sundayMirrorsSaturday ? s : (v.sunday || []).length) + " Sunday bands";
    }
    if (Array.isArray(v)) {
      var names = v.map(function (x) { return x && typeof x === "object" ? (x.name || "") : String(x); })
                   .filter(function (x) { return x; });
      return names.length ? names.join(", ") : v.length + " item" + (v.length === 1 ? "" : "s");
    }
    var t = typeof v === "object" ? JSON.stringify(v) : String(v);
    return t.length > 60 ? t.slice(0, 57) + "..." : t;
  }

  function distinct(list) {
    var out = [];
    list.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  // items: [{ name, attributes, lengthMi }] in selection order (plain objects).
  // primaryPos: index into items of the feature whose values win.
  // opts.kind: "line" (run time / speed / Service rules) | "polygon" | "point".
  // Returns { attributes, discarded: [{key,label,fromIndex,fromName,value,kept}],
  //           warnings: [string] }. Does not mutate its inputs.
  function mergeAttributes(items, primaryPos, opts) {
    var kind = (opts && opts.kind) || "polygon";
    var primary = items[primaryPos];
    var others = [];
    items.forEach(function (it, i) { if (i !== primaryPos) others.push(i); });
    var seq = [primaryPos].concat(others); // primary first, then selection order

    var attrs = clone(primary.attributes || {}) || {};
    var discarded = [], warnings = [];
    function attrOf(i) { return items[i].attributes || {}; }
    function noteDiscard(key, i, v, kept) {
      discarded.push({ key: key, label: KEY_LABELS[key] || key, fromIndex: i, fromName: items[i].name,
                       value: displayValue(v), kept: kept == null ? "" : displayValue(kept) });
    }

    // Union of keys: primary's first, then the others' in selection order.
    var keys = [];
    seq.forEach(function (i) {
      Object.keys(attrOf(i)).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    });

    keys.forEach(function (key) {
      var vals = seq.map(function (i) { return attrOf(i)[key]; });

      if (key === "notes") {
        var ns = distinct(vals.filter(hasValue).map(function (v) { return String(v).trim(); }));
        if (ns.length) attrs.notes = ns.join("\n");
        return;
      }

      if (kind === "point" && key === "associatedRoutes") {
        // Union of every stop's route links, de-duplicated by type + ID.
        var seenRef = {}, union = [];
        seq.forEach(function (i) {
          var list = attrOf(i).associatedRoutes;
          if (!Array.isArray(list)) return;
          list.forEach(function (ref) {
            if (!ref) return;
            var rk = (ref.featureType || "") + ":" + ref.featureId;
            if (seenRef[rk]) return;
            seenRef[rk] = true; union.push(clone(ref));
          });
        });
        if (union.length) attrs.associatedRoutes = union;
        return;
      }

      if (kind === "point" && key === "serviceAreaType") {
        // Primary only: a blank value is the real "circular buffer" choice, so
        // it must not be filled from a walkshed stop. Differing others are listed.
        var pv = attrOf(primaryPos).serviceAreaType;
        others.forEach(function (i) {
          var v = attrOf(i).serviceAreaType;
          if (hasValue(v) && !deepEqual(v, pv)) noteDiscard(key, i, v, hasValue(pv) ? pv : "circular buffer");
        });
        return;
      }

      if (kind === "line" && key === "runTime") {
        var haveAll = seq.every(function (i) { return positive(attrOf(i).runTime); });
        if (haveAll) {
          var sum = 0;
          seq.forEach(function (i) { sum += num(attrOf(i).runTime); });
          attrs.runTime = Math.round(sum * 100) / 100;
          return;
        }
        if (vals.some(hasValue)) warnings.push("Run time may need updating: not every selected feature has one, so the values could not be added together.");
        // fall through to the generic rule
      }

      if (kind === "line" && key === "avgSpeed") {
        var allSpeed = seq.every(function (i) { return positive(attrOf(i).avgSpeed); });
        if (allSpeed) {
          var speeds = seq.map(function (i) { return num(attrOf(i).avgSpeed); });
          if (distinct(speeds).length > 1) {
            var wSum = 0, sSum = 0;
            seq.forEach(function (i, n) { var w = items[i].lengthMi > 0 ? items[i].lengthMi : 0; wSum += w; sSum += w * speeds[n]; });
            var avg;
            if (wSum > 0) avg = sSum / wSum;
            else { avg = 0; speeds.forEach(function (s) { avg += s; }); avg /= speeds.length; }
            attrs.avgSpeed = Math.round(avg * 10) / 10;
          } else {
            attrs.avgSpeed = speeds[0];
          }
          return;
        }
        // fall through
      }

      // Generic: keep the primary's value; otherwise the first non-empty one.
      var resultVal, donor = -1;
      if (hasValue(attrOf(primaryPos)[key])) { resultVal = attrOf(primaryPos)[key]; donor = primaryPos; }
      else {
        for (var q = 0; q < others.length; q++) {
          if (hasValue(attrOf(others[q])[key])) { resultVal = attrOf(others[q])[key]; donor = others[q]; break; }
        }
      }
      if (donor < 0) return; // nobody has a value — leave the primary's (blank) entry alone
      if (donor !== primaryPos) attrs[key] = clone(resultVal);
      others.forEach(function (i) {
        var v = attrOf(i)[key];
        if (hasValue(v) && !deepEqual(v, resultVal)) noteDiscard(key, i, v, resultVal);
      });
    });

    if (kind === "line") {
      var svcNames = seq.map(function (i) { return hasValue(attrOf(i).serviceId) ? String(attrOf(i).serviceId).trim() : ""; });
      var dist = distinct(svcNames.filter(function (s) { return s; }));
      if (dist.length > 1) warnings.push("These features belong to different Services (" + dist.join(", ") + "). The result keeps '" + String(attrs.serviceId).trim() + "'.");
      dist.forEach(function (svc) {
        var members = [];
        seq.forEach(function (i, n) { if (svcNames[n] === svc) members.push(items[i].name); });
        if (members.length >= 2) warnings.push(members.join(" and ") + " are" +
          " patterns of the same Service '" + svc + "'. Merging them collapses that Service into a single pattern.");
      });
      var dirs = distinct(seq.map(function (i) { return hasValue(attrOf(i).direction) ? String(attrOf(i).direction).trim() : ""; })
        .filter(function (d) { return d; }));
      if (dirs.length > 1) warnings.push("These features have different directions (" + dirs.join(", ") + "). The result keeps '" + String(attrs.direction).trim() + "'.");
    }

    if (kind === "point") {
      var stopIds = distinct(seq.map(function (i) { return hasValue(attrOf(i).stopId) ? String(attrOf(i).stopId).trim() : ""; })
        .filter(function (d) { return d; }));
      if (stopIds.length > 1) warnings.push("These stops have different Stop IDs (" + stopIds.join(", ") + "). The result keeps '" + String(attrs.stopId).trim() + "'.");
    }

    return { attributes: attrs, discarded: discarded, warnings: warnings };
  }

  // Directional values whose meaning flips when a segment is reversed.
  var DIRECTIONAL = { NB: 1, SB: 1, EB: 1, WB: 1, Inbound: 1, Outbound: 1, CW: 1, CCW: 1 };

  // items: [{ name, direction }] by input index; chain: { order, reversed } from
  // chainLines. One warning per reversed segment that has a directional value.
  function reversalWarnings(items, chain) {
    var out = [];
    (chain.order || []).forEach(function (o, k) {
      if (!chain.reversed[k]) return;
      var it = items[o] || {};
      var d = typeof it.direction === "string" ? it.direction.trim() : "";
      if (DIRECTIONAL[d] === 1) out.push("'" + it.name + "' (" + d + ") is reversed to line up with the others, so its direction of travel is flipped in the result.");
    });
    return out;
  }

  App.mergeAttrs = {
    hasValue: hasValue,
    fieldHasValue: fieldHasValue,
    bandsCount: bandsCount,
    mergeAttributes: mergeAttributes,
    reversalWarnings: reversalWarnings,
    deepEqual: deepEqual
  };

  /* =====================================================================
     Shared strategy plumbing
     ===================================================================== */

  var ID_PROP = { point: "pointIdx", line: "lineIdx", route: "routeIdx", polygon: "polyIdx" };
  var TYPE_LABEL = { point: "Point", line: "Line", route: "Route", polygon: "Polygon" };
  // Per-feature appearance overrides a surviving line inherits from a route
  // primary (the cascade's per-feature half — see layers-panel.js).
  var APPEARANCE_KEYS = ["_opacity", "_fillOpacity", "_borderOpacity", "_lineWidth", "_bufferRadius", "_offset", "_offsetManual"];

  function arrayFor(type) {
    return { point: App.points, line: App.lines, route: App.routes, polygon: App.polygons }[type] || [];
  }
  function getFeat(ref) { return ref ? arrayFor(ref.type)[ref.index] : undefined; }
  function sameRef(a, b) { return !!a && !!b && a.type === b.type && a.index === b.index; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function featName(f, fallback) { return (f && f.properties && f.properties.name) || fallback; }
  function refName(ref) { return featName(getFeat(ref), TYPE_LABEL[ref.type] + " " + (ref.index + 1)); }

  // Stops whose associatedRoutes reference any removed line/route.
  // removedByType = { line: [ids], route: [ids] }; survivor is a Line or Route
  // (survivorType). Returns the repoints that WOULD be made (dialog count and,
  // in Phase 4, the `_mergedFrom` record); dryRun=false applies them. The list
  // is de-duplicated, and a link to the survivor keeps its cached name fresh.
  function repointStops(removedByType, survivorType, survivor, dryRun) {
    var repoints = [];
    var sid = survivor.properties[ID_PROP[survivorType]];
    var sname = survivor.properties.name;
    (App.points || []).forEach(function (pt) {
      var list = pt.properties && pt.properties.attributes && pt.properties.attributes.associatedRoutes;
      if (!Array.isArray(list) || !list.length) return;
      var touched = false;
      var next = [];
      list.forEach(function (ref) {
        var hit = ref && removedByType[ref.featureType] && removedByType[ref.featureType].indexOf(ref.featureId) >= 0;
        if (hit) {
          touched = true;
          repoints.push({ pointId: pt.properties.pointIdx, from: { featureType: ref.featureType, featureId: ref.featureId },
                          to: { featureType: survivorType, featureId: sid } });
          ref = { featureType: survivorType, featureId: sid, name: sname };
        } else if (ref && ref.featureType === survivorType && ref.featureId === sid && ref.name !== sname) {
          ref = { featureType: ref.featureType, featureId: ref.featureId, name: sname };
          touched = true;
        }
        // de-duplicate (the point may already reference the survivor)
        var dup = ref && next.some(function (x) { return x && x.featureType === ref.featureType && x.featureId === ref.featureId; });
        if (!dup) next.push(ref); else touched = true; // dropped a duplicate
      });
      if (touched && !dryRun) pt.properties.attributes.associatedRoutes = next;
    });
    return repoints;
  }

  function countRepointedStops(repoints) {
    var seen = {};
    repoints.forEach(function (r) { seen[r.pointId] = true; });
    return Object.keys(seen).length;
  }

  // Plan scaffolding. `survivor` and `removed` are refs (index in the feature's
  // own type array, before any splicing). removedIds: { type: [ids] }.
  function newPlan(strategy, refs, primary, survivor) {
    var removed = refs.filter(function (r) { return !sameRef(r, survivor); });
    var removedIds = {};
    removed.forEach(function (r) {
      var f = getFeat(r);
      if (!f) return;
      (removedIds[r.type] = removedIds[r.type] || []).push(f.properties[ID_PROP[r.type]]);
    });
    return { ok: true, type: strategy.type, refs: refs.slice(), primary: primary, survivor: survivor, removed: removed,
             removedIds: removedIds, errors: [], warnings: [], summary: [], discarded: [], stopsRepointed: 0,
             apply: null, prepare: null, repoint: null };
  }

  function membersResolve(refs, primary) {
    if (!refs || refs.length < 2) return false;
    if (!refs.some(function (r) { return sameRef(r, primary); })) return false;
    return refs.every(function (r) { return !!getFeat(r); });
  }

  function attrItems(feats, names, withLength) {
    return feats.map(function (f, n) {
      return { name: names[n], attributes: f.properties.attributes || {},
               lengthMi: withLength ? lengthMi(f.geometry.coordinates) : 0 };
    });
  }

  // Cheap identity + geometry fingerprint: proves the selection is unchanged
  // between analyze() and the commit that follows async routing.
  function fingerprint(refs) {
    try {
      return JSON.stringify(refs.map(function (r) {
        var f = getFeat(r);
        return f ? [r.type, r.index, f.properties[ID_PROP[r.type]], f.geometry, f.properties.waypoints] : null;
      }));
    } catch (e) { return String(Math.random()); }
  }

  var STRATEGIES = {};

  /* ---- Line-like merges: lines, routes, and line + route ---- */

  // One body for all three: they share branch detection, ordering, the
  // attribute rules and the stop repointing. st.mode is "line" | "route" |
  // "mixed". Routes keep street snapping (waypoints concatenated, connectors
  // routed by prepare()); lines and line + route use straight connectors and
  // produce a Line.
  function analyzeLinear(st, refs, primary) {
    var mode = st.mode;
    var feats0 = refs.map(getFeat);
    var survivor = primary;
    if (mode === "mixed" && primary.type === "route") {
      // A route primary lends its identity to the first selected LINE.
      survivor = refs.filter(function (r) { return r.type === "line"; })[0] || primary;
    }
    var plan = newPlan(st, refs, primary, survivor);
    if (!membersResolve(refs, primary) || feats0.some(function (f) { return !f.geometry || f.geometry.type !== "LineString"; })) {
      plan.ok = false; plan.errors.push("The selected " + st.plural + " could not be found."); return plan;
    }
    var feats = feats0;
    var names = refs.map(refName);
    var coordArrays = feats.map(function (f) { return f.geometry.coordinates; });
    var primaryPos = refs.map(function (r) { return sameRef(r, primary); }).indexOf(true);

    var branch = findBranch(coordArrays, BRANCH_TOLERANCE_MI);
    if (branch) {
      plan.ok = false;
      plan.errors.push("These " + st.plural + " branch: " + names[branch.lineIndex] + " ends on " + names[branch.onLineIndex] +
        " partway along it, so they can't be joined into a single " + (mode === "route" ? "route" : "line") + ".");
    }

    var am = mergeAttributes(attrItems(feats, names, true), primaryPos, { kind: "line" });
    plan.discarded = am.discarded;
    plan.warnings = am.warnings.slice();

    // Ordering + (for routes) waypoint assembly.
    var chain, rc = null;
    if (mode === "route") {
      var missingWp = [];
      var items = feats.map(function (f, n) {
        var w = f.properties.waypoints;
        var ok = Array.isArray(w) && w.length >= 2;
        if (!ok) {
          missingWp.push(names[n]);
          var c = f.geometry.coordinates; w = [c[0], c[c.length - 1]];
        }
        return { coords: f.geometry.coordinates, waypoints: w };
      });
      if (missingWp.length) plan.warnings.push(missingWp.join(", ") + " had no waypoints recorded, so its end points were used as waypoints.");
      rc = planRouteChain(items);
      chain = rc;
    } else {
      chain = chainLines(coordArrays);
    }

    var dirWarn = reversalWarnings(feats.map(function (f, n) {
      return { name: names[n], direction: (f.properties.attributes || {}).direction };
    }), chain);
    plan.warnings = plan.warnings.concat(dirWarn);

    // Describe the order and each join.
    var parts = chain.order.map(function (o, k) { return names[o] + (chain.reversed[k] ? " (reversed)" : ""); });
    plan.summary.push("Order: " + parts.join(" → "));
    chain.connectorsMi.forEach(function (d, k) {
      var a = names[chain.order[k]], b = names[chain.order[k + 1]];
      if (d < COINCIDENT_MI) plan.summary.push(a + " → " + b + ": touching");
      else if (mode === "route") plan.summary.push(a + " → " + b + ": " + d.toFixed(2) + " mi gap, will be street-routed when you merge");
      else plan.summary.push(a + " → " + b + ": " + d.toFixed(2) + " mi gap, bridged with a straight connector");
      if (d > LONG_CONNECTOR_MI) plan.warnings.push("The gap between " + a + " and " + b + " is " + d.toFixed(2) +
        " mi. Check that these are the " + st.plural + " you meant to join.");
    });
    var straightCoords = mode === "route" ? null : chain.coords;
    if (mode === "route") plan.summary.push("Result: one route with " + rc.waypoints.length + " waypoints.");
    else if (mode === "mixed") plan.summary.push("The result will be a Line with " + straightCoords.length + " vertices; street snapping will be removed.");
    else plan.summary.push("Result: one line with " + straightCoords.length + " vertices.");

    // Stops that pointed at anything removed follow the survivor.
    plan.stopsRepointed = countRepointedStops(repointStops(plan.removedIds, survivor.type, getFeat(survivor), true));
    if (plan.stopsRepointed) plan.summary.push(plural(plan.stopsRepointed, "stop") + " will be re-linked to the merged " + survivor.type + ".");
    plan.repoint = function (surv) { return repointStops(plan.removedIds, survivor.type, surv, false); };

    var connectorGeoms = null;
    if (rc && rc.gaps.length) {
      plan.routingGaps = rc.gaps.length;
      // Async step, run only on Merge. Sequential to go easy on the public
      // OSRM servers; every failure degrades to a straight connector.
      plan.prepare = function (ctx) {
        var geoms = {}, i = 0;
        plan.routing = { total: rc.gaps.length, routed: 0, failed: 0 };
        function valid(c) {
          return Array.isArray(c) && c.length >= 2 && c.every(function (p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]); });
        }
        function next() {
          if ((ctx && ctx.isCancelled && ctx.isCancelled()) || i >= rc.gaps.length) return Promise.resolve();
          var g = rc.gaps[i++];
          if (ctx && ctx.onProgress) ctx.onProgress(i, rc.gaps.length);
          var p;
          try { p = Promise.resolve(typeof App.fetchRouteGeometry === "function" ? App.fetchRouteGeometry([g.from, g.to]) : null); }
          catch (e) { p = Promise.resolve(null); }
          return p.then(function (coords) {
            if (valid(coords)) { geoms[g.k] = coords; plan.routing.routed++; } else plan.routing.failed++;
          }, function () { plan.routing.failed++; }).then(next);
        }
        return next().then(function () { connectorGeoms = geoms; });
      };
    }

    plan.apply = function () {
      var s = getFeat(plan.survivor), p = getFeat(primary);
      if (mode === "route") {
        s.geometry = { type: "LineString", coordinates: assembleChain(rc, connectorGeoms) };
        s.properties.waypoints = cloneCoords(rc.waypoints);
      } else {
        s.geometry = { type: "LineString", coordinates: straightCoords.map(function (c) { return c.slice(); }) };
        s.properties.waypoints = straightCoords.length;
      }
      if (p !== s) {
        // Route primary, surviving line: take its identity (name, color, appearance).
        s.properties.name = p.properties.name;
        s.properties.color = p.properties.color || "";
        // Lines and routes draw colorSeq from one shared counter, so taking the
        // route's palette slot keeps an Automatic-colored result looking the
        // same as the route did (the route is removed, so the slot stays unique).
        if (typeof p.properties.colorSeq === "number") s.properties.colorSeq = p.properties.colorSeq;
        APPEARANCE_KEYS.forEach(function (k) {
          if (p.properties[k] !== undefined) s.properties[k] = p.properties[k]; else delete s.properties[k];
        });
      }
      if (Object.keys(am.attributes).length) s.properties.attributes = am.attributes;
    };
    return plan;
  }

  STRATEGIES.line = {
    type: "line", mode: "line", singular: "line", plural: "lines", titleNoun: "Lines", survivorType: "line",
    analyze: function (refs, primary) { return analyzeLinear(this, refs, primary); }
  };
  STRATEGIES.route = {
    type: "route", mode: "route", singular: "route", plural: "routes", titleNoun: "Routes", survivorType: "route",
    analyze: function (refs, primary) { return analyzeLinear(this, refs, primary); }
  };
  // Line + route: always produces a Line (selection members are refs).
  STRATEGIES.linemix = {
    type: "linemix", mode: "mixed", singular: "line", plural: "lines and routes", titleNoun: "Lines and Routes", survivorType: "line",
    intro: "The lines and routes you selected will become one line. The result is always a Line: street snapping is removed from any route.",
    hint: "The result is a line. It takes this feature's name, color, and attributes; blank attributes are filled in from the others.",
    analyze: function (refs, primary) { return analyzeLinear(this, refs, primary); }
  };

  /* ---- Points ("combine stops") ---- */
  STRATEGIES.point = {
    type: "point", singular: "point", plural: "points", titleNoun: "Points", survivorType: "point",
    intro: "The points you selected will be combined into one stop. All the others are removed.",
    hint: "This stop keeps its name, color, and location. Blank attributes are filled in from the others; route links from every stop are combined.",

    analyze: function (refs, primary) {
      var plan = newPlan(this, refs, primary, primary);
      if (!membersResolve(refs, primary)) { plan.ok = false; plan.errors.push("The selected points could not be found."); return plan; }
      var feats = refs.map(getFeat);
      var names = refs.map(refName);
      var primaryPos = refs.map(function (r) { return sameRef(r, primary); }).indexOf(true);
      var am = mergeAttributes(attrItems(feats, names, false), primaryPos, { kind: "point" });
      plan.discarded = am.discarded;
      plan.warnings = am.warnings.slice();

      var pf = feats[primaryPos];
      plan.summary.push("Result: one stop, '" + names[primaryPos] + "'. It stays at that stop's location; the others are removed.");
      var nRoutes = (am.attributes.associatedRoutes || []).length;
      if (nRoutes) plan.summary.push("Linked routes are combined: " + plural(nRoutes, "route") + " in total.");
      feats.forEach(function (f, n) {
        if (n === primaryPos) return;
        var d = distMi(pf.geometry.coordinates, f.geometry.coordinates);
        if (d > LONG_CONNECTOR_MI) plan.warnings.push("'" + names[n] + "' is " + d.toFixed(2) + " mi from '" + names[primaryPos] +
          "'. Its location is discarded. Check these are the same stop.");
      });

      plan.apply = function () {
        var p = getFeat(primary);
        if (Object.keys(am.attributes).length) p.properties.attributes = am.attributes;
      };
      return plan;
    }
  };

  /* ---- Polygons ---- */
  STRATEGIES.polygon = {
    type: "polygon", singular: "polygon", plural: "polygons", titleNoun: "Polygons", survivorType: "polygon",

    analyze: function (refs, primary) {
      var plan = newPlan(this, refs, primary, primary);
      if (!membersResolve(refs, primary)) { plan.ok = false; plan.errors.push("The selected polygons could not be found."); return plan; }
      var feats = refs.map(getFeat);
      var names = refs.map(refName);
      var primaryPos = refs.map(function (r) { return sameRef(r, primary); }).indexOf(true);
      var am = mergeAttributes(attrItems(feats, names, false), primaryPos, { kind: "polygon" });
      plan.discarded = am.discarded;
      plan.warnings = am.warnings.slice();

      var ring = null;
      if (feats.some(function (f) { return !f.geometry || f.geometry.type !== "Polygon"; })) {
        plan.ok = false; plan.errors.push("Only simple polygons can be merged.");
      } else if (typeof turf === "undefined" || typeof App.foldAnalysisUnion !== "function") {
        plan.ok = false; plan.errors.push("The geometry library is not available.");
      } else {
        var union = null;
        try {
          union = App.foldAnalysisUnion(feats.map(function (f) { return { type: "Feature", properties: {}, geometry: f.geometry }; }));
        } catch (e) { union = null; }
        // foldAnalysisUnion silently skips a polygon it cannot union, so check
        // every input actually ended up inside the result.
        var complete = !!union && union.geometry && feats.every(function (f) {
          try { return turf.booleanPointInPolygon(turf.pointOnFeature(f).geometry.coordinates, union); }
          catch (e) { return false; }
        });
        if (!union || !union.geometry) {
          plan.ok = false; plan.errors.push("These polygons could not be combined.");
        } else if (union.geometry.type !== "Polygon") {
          plan.ok = false; plan.errors.push("These polygons don't touch or overlap, so they can't be merged into one.");
        } else if (!complete) {
          plan.ok = false; plan.errors.push("These polygons could not be combined (invalid geometry).");
        } else {
          ring = union.geometry.coordinates[0];
          var holes = union.geometry.coordinates.length - 1;
          plan.summary.push("Result: one polygon with " + (ring.length - 1) + " vertices.");
          if (holes > 0) plan.summary.push("Enclosed gaps will be filled.");
        }
      }

      plan.apply = function () {
        var p = getFeat(primary);
        p.geometry = { type: "Polygon", coordinates: [ring] }; // holes dropped
        p.properties.vertices = ring.length - 1;
        if (Object.keys(am.attributes).length) p.properties.attributes = am.attributes;
      };
      plan.removedCount = plan.removed.length;
      return plan;
    }
  };

  /* =====================================================================
     Selection eligibility
     ===================================================================== */

  // selected: [{type, index}] (App.getSelectedFeatures). Returns
  // { type, indices, primaryFor } when the selection can be merged, else null:
  //   - 2+ features of one mergeable type (point, line, route, polygon), or
  //   - a mix of lines and routes only ("linemix": indices are {type,index} refs).
  // primaryFor(featureType, featureIndex) builds the `primary` argument for the
  // right-clicked row (a number for single-type, a ref for linemix).
  function mergeableSelection(selected) {
    if (!selected || selected.length < 2) return null;
    var types = [];
    selected.forEach(function (s) { if (types.indexOf(s.type) < 0) types.push(s.type); });
    if (types.length === 1) {
      var type = types[0];
      if (!STRATEGIES[type] || type === "linemix") return null;
      return { type: type, indices: selected.map(function (s) { return s.index; }),
               primaryFor: function (ft, fi) { return fi; } };
    }
    if (types.length === 2 && types.indexOf("line") >= 0 && types.indexOf("route") >= 0) {
      return { type: "linemix", indices: selected.map(function (s) { return { type: s.type, index: s.index }; }),
               primaryFor: function (ft, fi) { return { type: ft, index: fi }; } };
    }
    return null;
  }

  /* =====================================================================
     The operation
     ===================================================================== */

  // Accept plain numeric indices (single-type) or refs (linemix).
  function toRefs(type, indices) {
    return (indices || []).map(function (i) {
      return typeof i === "object" && i ? { type: i.type, index: i.index } : { type: type, index: i };
    });
  }
  function toPrimary(type, primary) {
    return typeof primary === "object" && primary ? { type: primary.type, index: primary.index } : { type: type, index: primary };
  }

  function analyze(type, indices, primary) {
    var st = STRATEGIES[type];
    if (!st) return { ok: false, errors: ["This feature type can't be merged yet."], warnings: [], summary: [], discarded: [] };
    return st.analyze(toRefs(type, indices), toPrimary(type === "linemix" ? "line" : type, primary));
  }

  // The mutation. Everything here is synchronous: one undo snapshot, apply,
  // repoint, splice, re-render, housekeeping, select the survivor.
  function commit(st, plan) {
    var survivorFeat = getFeat(plan.survivor);
    var removedFeats = plan.removed.map(getFeat);

    if (App.undo && !App.undo.isRestoring()) App.undo.push(); // ONE snapshot for the whole merge

    plan.apply();
    var repoints = plan.repoint ? plan.repoint(survivorFeat) : [];

    // Splice the rest out directly (descending per type so earlier indices stay valid).
    var byType = {};
    plan.removed.forEach(function (r) { (byType[r.type] = byType[r.type] || []).push(r.index); });
    Object.keys(byType).forEach(function (t) {
      var arr = arrayFor(t);
      byType[t].slice().sort(function (a, b) { return b - a; }).forEach(function (i) { arr.splice(i, 1); });
    });
    var survivorType = plan.survivor.type;
    var newIndex = arrayFor(survivorType).indexOf(survivorFeat); // removed features may have sat before it

    if (typeof App.closeAttrPopup === "function" && typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) App.closeAttrPopup();

    // Re-render every type that lost or gained a feature.
    var touched = [survivorType];
    Object.keys(byType).forEach(function (t) { if (touched.indexOf(t) < 0) touched.push(t); });
    touched.forEach(function (t) {
      if (t === "point") {
        // Stops: drop removed points' walkshed cache entries, (re)compute any
        // walkshed-flagged survivor, then rebuild buffers from the cache.
        if (typeof App.dropPointWalksheds === "function") App.dropPointWalksheds(plan.removedIds.point || []);
        if (typeof App.ensurePointWalksheds === "function") App.ensurePointWalksheds();
        if (typeof App.refreshBuffers === "function") App.refreshBuffers();
        else if (typeof App.rerenderForType === "function") App.rerenderForType("point");
      } else if (typeof App.rerenderForType === "function") App.rerenderForType(t);
    });
    if (typeof App.onFeatureDelete === "function") App.onFeatureDelete(); // exit edit, clear selection, refresh panel, notify, save
    if (typeof App.selectFeature === "function") App.selectFeature(survivorType, newIndex);

    var name = survivorFeat.properties.name || "";
    var msg = "Merged " + plan.refs.length + " " + st.plural + " into '" + name + "'";
    var routing = plan.routing || null;
    if (routing && routing.failed) {
      msg += " — " + routing.failed + " of " + plural(routing.total, "connection") + " could not be street-routed (straight connector used)";
    } else if (routing) {
      msg += " — " + plural(routing.routed, "connection") + " street-routed";
    }
    msg += " — Ctrl+Z to undo";
    if (typeof App.setStatus === "function") App.setStatus(msg);
    return { ok: true, type: st.type, survivorType: survivorType, survivorIndex: newIndex, removedIds: plan.removedIds,
             repoints: repoints, routing: routing, message: msg };
  }

  // Returns a Promise. opts (all optional): isCancelled() -> bool (checked
  // after routing; true aborts with nothing changed) and onProgress(i, n).
  // Resolves { ok:true, ... } | { ok:false, errors } | { ok:false, cancelled:true }.
  function run(type, indices, primary, opts) {
    opts = opts || {};
    var st = STRATEGIES[type];
    return new Promise(function (resolve, reject) {
      try {
        var plan = analyze(type, indices, primary);
        if (!plan.ok) { resolve({ ok: false, errors: plan.errors }); return; }
        if (!plan.prepare) { resolve(commit(st, plan)); return; }
        var before = fingerprint(plan.refs);
        Promise.resolve(plan.prepare({ isCancelled: opts.isCancelled || function () { return false; }, onProgress: opts.onProgress }))
          .then(function () {
            try {
              if (opts.isCancelled && opts.isCancelled()) { resolve({ ok: false, cancelled: true, errors: [] }); return; }
              if (fingerprint(plan.refs) !== before) {
                resolve({ ok: false, errors: ["The selected features changed while routing. Nothing was merged."] }); return;
              }
              resolve(commit(st, plan));
            } catch (e) { reject(e); }
          }, reject);
      } catch (e) { reject(e); }
    });
  }

  /* =====================================================================
     Dialog
     ===================================================================== */

  var _dlg = null; // { overlay, onKey, prevFocus, token, ... }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function closeDialog() {
    if (!_dlg) return;
    document.removeEventListener("keydown", _dlg.onKey, true);
    if (_dlg.overlay.parentNode) _dlg.overlay.parentNode.removeChild(_dlg.overlay);
    var prev = _dlg.prevFocus;
    _dlg = null;
    if (prev && typeof prev.focus === "function" && document.body.contains(prev)) { try { prev.focus(); } catch (e) { /* ignore */ } }
  }

  function renderList(container, items, cls) {
    var ul = el("ul", cls);
    items.forEach(function (t) { ul.appendChild(el("li", null, t)); });
    container.appendChild(ul);
  }

  function openDialog(type, indices, primary) {
    var st = STRATEGIES[type];
    if (!st || !indices || indices.length < 2) return;
    if (_dlg) closeDialog();
    if (typeof App.closeContextMenu === "function") App.closeContextMenu();
    var refs = toRefs(type, indices);
    var mixed = type === "linemix";
    var prim0 = toPrimary(mixed ? "line" : type, primary);
    var state = { primary: refs.some(function (r) { return sameRef(r, prim0); }) ? prim0 : refs[0], busy: false };

    var overlay = el("div", "fm-overlay");
    var box = el("div", "fm-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "fmTitle");
    overlay.appendChild(box);

    var title = el("div", "rf-weights-modal-title", "Merge " + refs.length + " " + st.titleNoun);
    title.id = "fmTitle";
    box.appendChild(title);
    box.appendChild(el("div", "fm-intro", st.intro || ("The " + st.plural + " you selected will become one " + st.singular +
      ". All the others are removed.")));

    // Primary picker
    var pickWrap = el("div", "fm-section");
    var pickLabel = el("div", "fm-section-title", "Keep attributes from:");
    pickLabel.id = "fmPrimaryLabel";
    pickWrap.appendChild(pickLabel);
    var group = el("div", "fm-radio-list");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "fmPrimaryLabel");
    var radios = [];
    refs.forEach(function (r) {
      var f = getFeat(r);
      var row = el("label", "fm-radio-row");
      var rb = document.createElement("input");
      rb.type = "radio"; rb.name = "fmPrimary"; rb.value = r.type + ":" + r.index;
      rb.checked = sameRef(r, state.primary);
      rb.addEventListener("change", function () { if (rb.checked) { state.primary = r; refresh(); } });
      radios.push(rb);
      var dot = el("span", "fm-swatch");
      try { dot.style.background = App.resolveFeatureColor(r.type, f); } catch (e) { /* neutral swatch */ }
      row.appendChild(rb); row.appendChild(dot);
      var label = featName(f, TYPE_LABEL[r.type] + " " + (r.index + 1));
      row.appendChild(el("span", "fm-radio-name", mixed ? label + " (" + r.type + ")" : label));
      group.appendChild(row);
    });
    pickWrap.appendChild(group);
    pickWrap.appendChild(el("div", "fm-hint", st.hint || ("This " + st.singular + " keeps its name, color, and position. Blank attributes are filled in from the others.")));
    box.appendChild(pickWrap);

    var body = el("div", "fm-body");
    body.setAttribute("aria-live", "polite");
    box.appendChild(body);

    // Shown while connectors are being street-routed (routes only).
    var busyEl = el("div", "fm-busy");
    busyEl.setAttribute("role", "status");
    busyEl.style.display = "none";
    box.appendChild(busyEl);

    box.appendChild(el("div", "fm-footnote", "You can undo this with Ctrl+Z until you reload the page."));

    var actions = el("div", "rf-weights-modal-actions");
    actions.appendChild(el("span", "rf-modal-spacer"));
    var cancelBtn = el("button", "rf-btn-sm", "Cancel");
    cancelBtn.type = "button";
    var mergeBtn = el("button", "rf-action-primary rf-modal-confirm", "Merge");
    mergeBtn.type = "button";
    mergeBtn.disabled = true;
    actions.appendChild(cancelBtn); actions.appendChild(mergeBtn);
    box.appendChild(actions);

    function section(heading, cls) {
      var s = el("div", "fm-section " + (cls || ""));
      if (heading) s.appendChild(el("div", "fm-section-title", heading));
      body.appendChild(s);
      return s;
    }

    function setBusy(on, text) {
      state.busy = on;
      busyEl.style.display = on ? "" : "none";
      if (text != null) busyEl.textContent = text;
      radios.forEach(function (rb) { rb.disabled = on; });
      mergeBtn.disabled = on || !state.ok;
      // Cancel stays enabled: closing the dialog while routing aborts the merge.
    }

    var token = 0;
    function refresh(onDone) {
      var my = ++token;
      body.innerHTML = "";
      body.appendChild(el("div", "fm-hint", "Checking…"));
      state.ok = false;
      mergeBtn.disabled = true;
      Promise.resolve(analyze(type, indices, state.primary)).then(function (plan) {
        if (my !== token || !_dlg) return;
        body.innerHTML = "";
        if (plan.errors.length) {
          var eb = el("div", "fm-note fm-note-error");
          eb.setAttribute("role", "alert");
          renderList(eb, plan.errors);
          body.appendChild(eb);
        }
        if (plan.summary.length) renderList(section("Result"), plan.summary, "fm-list");
        if (plan.discarded.length) {
          var sec = section("Will be discarded");
          renderList(sec, plan.discarded.map(function (d) {
            return d.fromName + " — " + d.label + ": " + d.value + (d.kept ? " (keeping " + d.kept + ")" : "");
          }), "fm-list");
        } else if (!plan.errors.length) {
          var none = section("Will be discarded");
          none.appendChild(el("div", "fm-hint", "No attribute values will be lost."));
        }
        if (plan.warnings.length) {
          var wb = el("div", "fm-note fm-note-warn");
          renderList(wb, plan.warnings);
          body.appendChild(wb);
        }
        state.ok = !!plan.ok;
        mergeBtn.disabled = !plan.ok || state.busy;
        if (onDone) onDone(plan);
      }, function (err) {
        if (my !== token || !_dlg) return;
        body.innerHTML = "";
        var eb = el("div", "fm-note fm-note-error", "Couldn't prepare the merge: " + (err && err.message ? err.message : err));
        eb.setAttribute("role", "alert");
        body.appendChild(eb);
        if (onDone) onDone(null);
      });
    }

    cancelBtn.addEventListener("click", closeDialog);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeDialog(); });
    mergeBtn.addEventListener("click", function () {
      if (state.busy) return;
      setBusy(true); // the "Routing connections…" line appears once routing actually starts
      run(type, indices, state.primary, {
        isCancelled: function () { return _dlg !== me; },
        onProgress: function (i, n) {
          if (_dlg !== me) return;
          busyEl.style.display = "";
          busyEl.textContent = "Routing connections… (" + i + " of " + n + ")";
        }
      }).then(function (res) {
        if (_dlg !== me) return; // closed while working — nothing was changed
        if (res && res.ok) { closeDialog(); return; }
        setBusy(false);
        var why = res && res.errors && res.errors.length ? res.errors.join(" ") : "";
        refresh(function () {
          if (!why || _dlg !== me) return;
          // refresh() rebuilt the body; say why the merge did not happen.
          var eb = el("div", "fm-note fm-note-error", why);
          eb.setAttribute("role", "alert");
          body.insertBefore(eb, body.firstChild);
        });
      }, function (err) {
        if (_dlg !== me) return;
        setBusy(false);
        body.innerHTML = "";
        var eb = el("div", "fm-note fm-note-error", "Merge failed: " + (err && err.message ? err.message : err));
        eb.setAttribute("role", "alert");
        body.appendChild(eb);
      });
    });

    // Keyboard: Escape closes; Tab stays inside; no key reaches the app's
    // global shortcuts (draw tools, Delete, Ctrl+Z) while the dialog is open.
    function onKey(e) {
      if (!_dlg) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDialog(); return; }
      if (e.key === "Tab") {
        var f = box.querySelectorAll("input:not(:disabled), button:not(:disabled)");
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);

    var me = { overlay: overlay, onKey: onKey, prevFocus: document.activeElement };
    _dlg = me;
    document.body.appendChild(overlay);
    // Focus the primary button once the analysis enables it (Cancel if blocked).
    refresh(function (plan) { if (_dlg === me) (plan && plan.ok ? mergeBtn : cancelBtn).focus(); });
  }

  App.merge = {
    mergeableSelection: mergeableSelection,
    analyze: analyze,
    run: run,
    openDialog: openDialog,
    closeDialog: closeDialog,
    isDialogOpen: function () { return !!_dlg; },
    _strategies: STRATEGIES
  };
})();
