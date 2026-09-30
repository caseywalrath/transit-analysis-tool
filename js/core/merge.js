// js/core/merge.js
// Feature Merge (docs/feature-merge-plan.md). Phase 2: lines and polygons.
//
// Three layers, each usable on its own:
//   1. Pure helpers (no turf / DOM / map — loaded by the golden harness):
//        App.mergeGeom  — chainLines, findBranch, lengthMi
//        App.mergeAttrs — hasValue, fieldHasValue, mergeAttributes
//   2. Per-type STRATEGIES (line, polygon). A strategy's analyze() inspects a
//      selection and returns a "plan" (errors / warnings / summary / discarded
//      list plus an apply() closure that mutates the survivor). Phase 3 adds
//      route / point / line+route strategies here; analyze() and run() already
//      tolerate a Promise so async street-routing can slot in later.
//   3. App.merge — run() (the undoable operation) and openDialog() (the modal).
//
// Survivor model: the primary feature itself survives (same array position, ID,
// name, color, appearance overrides); every other selected feature is spliced
// out after ONE App.undo.push() (never App.removeX in a loop — each pushes its
// own snapshot).
//
// Depends on: App.lines/polygons/points, App.undo, App.rerenderForType,
//   App.onFeatureDelete, App.selectFeature, App.foldAnalysisUnion (polygons,
//   turf — only touched inside functions, never at load time).
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

  App.mergeGeom = {
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

    return { attributes: attrs, discarded: discarded, warnings: warnings };
  }

  App.mergeAttrs = {
    hasValue: hasValue,
    fieldHasValue: fieldHasValue,
    bandsCount: bandsCount,
    mergeAttributes: mergeAttributes,
    deepEqual: deepEqual
  };

  /* =====================================================================
     Per-type strategies
     ===================================================================== */

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function featName(f, fallback) { return (f && f.properties && f.properties.name) || fallback; }

  // Points whose associatedRoutes reference any of `removedIds` (for one
  // featureType). Returns the repoints that WOULD be made (used for the dialog
  // count and, in Phase 4, the `_mergedFrom` record). dryRun=false applies them.
  function repointStops(featureType, removedIds, survivor, dryRun) {
    var repoints = [];
    var sid = survivor.properties[{ line: "lineIdx", route: "routeIdx" }[featureType]];
    (App.points || []).forEach(function (pt) {
      var list = pt.properties && pt.properties.attributes && pt.properties.attributes.associatedRoutes;
      if (!Array.isArray(list) || !list.length) return;
      var touched = false;
      var next = [];
      list.forEach(function (ref) {
        var hit = ref && ref.featureType === featureType && removedIds.indexOf(ref.featureId) >= 0;
        if (hit) {
          touched = true;
          repoints.push({ pointId: pt.properties.pointIdx, from: { featureType: ref.featureType, featureId: ref.featureId },
                          to: { featureType: featureType, featureId: sid } });
          ref = { featureType: featureType, featureId: sid, name: survivor.properties.name };
        }
        // de-duplicate (the point may already reference the survivor)
        var dup = next.some(function (x) { return x.featureType === ref.featureType && x.featureId === ref.featureId; });
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

  // Shared plan scaffolding used by every strategy.
  function newPlan(strategy, indices, primaryIndex, feats) {
    return { ok: true, type: strategy.type, indices: indices.slice(), primaryIndex: primaryIndex,
             errors: [], warnings: [], summary: [], discarded: [], stopsRepointed: 0, apply: null };
  }

  function resolveFeats(arr, indices, primaryIndex) {
    if (!indices || indices.length < 2) return null;
    if (indices.indexOf(primaryIndex) < 0) return null;
    var feats = indices.map(function (i) { return arr[i]; });
    return feats.every(Boolean) ? feats : null;
  }

  function attrItems(feats, names, withLength) {
    return feats.map(function (f, n) {
      return { name: names[n], attributes: f.properties.attributes || {},
               lengthMi: withLength ? lengthMi(f.geometry.coordinates) : 0 };
    });
  }

  var STRATEGIES = {};

  /* ---- Lines ---- */
  STRATEGIES.line = {
    type: "line", singular: "line", plural: "lines", idProp: "lineIdx",
    array: function () { return App.lines; },

    analyze: function (indices, primaryIndex) {
      var plan = newPlan(this, indices, primaryIndex);
      var feats = resolveFeats(App.lines, indices, primaryIndex);
      if (!feats) { plan.ok = false; plan.errors.push("The selected lines could not be found."); return plan; }
      var names = feats.map(function (f, n) { return featName(f, "Line " + (indices[n] + 1)); });
      var coordArrays = feats.map(function (f) { return f.geometry.coordinates; });

      var branch = findBranch(coordArrays, BRANCH_TOLERANCE_MI);
      if (branch) {
        plan.ok = false;
        plan.errors.push("These lines branch: " + names[branch.lineIndex] + " ends on " + names[branch.onLineIndex] +
          " partway along it, so they can't be joined into a single line.");
      }

      var chain = chainLines(coordArrays);
      var primaryPos = indices.indexOf(primaryIndex);
      var am = mergeAttributes(attrItems(feats, names, true), primaryPos, { kind: "line" });
      plan.discarded = am.discarded;
      plan.warnings = am.warnings.slice();

      // Describe the order and each join.
      var parts = chain.order.map(function (o, k) { return names[o] + (chain.reversed[k] ? " (reversed)" : ""); });
      plan.summary.push("Order: " + parts.join(" → "));
      chain.connectorsMi.forEach(function (d, k) {
        var a = names[chain.order[k]], b = names[chain.order[k + 1]];
        if (d < COINCIDENT_MI) plan.summary.push(a + " → " + b + ": touching");
        else plan.summary.push(a + " → " + b + ": " + d.toFixed(2) + " mi gap, bridged with a straight connector");
        if (d > LONG_CONNECTOR_MI) plan.warnings.push("The gap between " + a + " and " + b + " is " + d.toFixed(2) +
          " mi. Check that these are the lines you meant to join.");
      });
      plan.summary.push("Result: one line with " + chain.coords.length + " vertices" + ".");

      var removed = indices.filter(function (i) { return i !== primaryIndex; });
      var removedIds = removed.map(function (i) { return App.lines[i].properties.lineIdx; });
      plan.stopsRepointed = countRepointedStops(repointStops("line", removedIds, App.lines[primaryIndex], true));
      if (plan.stopsRepointed) plan.summary.push(plural(plan.stopsRepointed, "stop") + " will be re-linked to the merged line.");

      plan.apply = function () {
        var p = App.lines[primaryIndex];
        p.geometry = { type: "LineString", coordinates: chain.coords };
        p.properties.waypoints = chain.coords.length;
        if (Object.keys(am.attributes).length) p.properties.attributes = am.attributes;
      };
      plan.repoint = function (survivor) { return repointStops("line", removedIds, survivor, false); };
      return plan;
    }
  };

  /* ---- Polygons ---- */
  STRATEGIES.polygon = {
    type: "polygon", singular: "polygon", plural: "polygons", idProp: "polyIdx",
    array: function () { return App.polygons; },

    analyze: function (indices, primaryIndex) {
      var plan = newPlan(this, indices, primaryIndex);
      var feats = resolveFeats(App.polygons, indices, primaryIndex);
      if (!feats) { plan.ok = false; plan.errors.push("The selected polygons could not be found."); return plan; }
      var names = feats.map(function (f, n) { return featName(f, "Polygon " + (indices[n] + 1)); });
      var primaryPos = indices.indexOf(primaryIndex);
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

      var removed = indices.filter(function (i) { return i !== primaryIndex; });
      plan.apply = function () {
        var p = App.polygons[primaryIndex];
        p.geometry = { type: "Polygon", coordinates: [ring] }; // holes dropped
        p.properties.vertices = ring.length - 1;
        if (Object.keys(am.attributes).length) p.properties.attributes = am.attributes;
      };
      plan.removedCount = removed.length;
      return plan;
    }
  };

  /* =====================================================================
     Selection eligibility
     ===================================================================== */

  // selected: [{type, index}] (App.getSelectedFeatures). Returns
  // { type, indices } when 2+ features of one mergeable type are selected,
  // else null. Phase 3 widens this (routes, points, line + route).
  function mergeableSelection(selected) {
    if (!selected || selected.length < 2) return null;
    var type = selected[0].type;
    if (!STRATEGIES[type]) return null;
    for (var i = 0; i < selected.length; i++) if (selected[i].type !== type) return null;
    return { type: type, indices: selected.map(function (s) { return s.index; }) };
  }

  /* =====================================================================
     The operation
     ===================================================================== */

  // analyze() may become async in Phase 3 (street routing); callers wrap it in
  // Promise.resolve.
  function analyze(type, indices, primaryIndex) {
    var st = STRATEGIES[type];
    if (!st) return { ok: false, errors: ["This feature type can't be merged yet."], warnings: [], summary: [], discarded: [] };
    return st.analyze(indices, primaryIndex);
  }

  function runSync(type, indices, primaryIndex) {
    var st = STRATEGIES[type];
    var plan = analyze(type, indices, primaryIndex);
    if (!plan.ok) return { ok: false, errors: plan.errors };

    var arr = st.array();
    var removed = indices.filter(function (i) { return i !== primaryIndex; });
    var removedIds = removed.map(function (i) { return arr[i].properties[st.idProp]; });

    if (App.undo && !App.undo.isRestoring()) App.undo.push(); // ONE snapshot for the whole merge

    plan.apply();
    var survivor = arr[primaryIndex];
    var repoints = plan.repoint ? plan.repoint(survivor) : [];

    // Splice the rest out directly (descending so earlier indices stay valid).
    removed.slice().sort(function (a, b) { return b - a; }).forEach(function (i) { arr.splice(i, 1); });
    var newIndex = arr.indexOf(survivor); // removed features may have sat before it

    if (typeof App.closeAttrPopup === "function" && typeof App.isAttrPopupOpen === "function" && App.isAttrPopupOpen()) App.closeAttrPopup();
    if (typeof App.rerenderForType === "function") App.rerenderForType(type);
    if (typeof App.onFeatureDelete === "function") App.onFeatureDelete(); // exit edit, clear selection, refresh panel, notify, save
    if (typeof App.selectFeature === "function") App.selectFeature(type, newIndex);

    var name = survivor.properties.name || "";
    var msg = "Merged " + indices.length + " " + st.plural + " into '" + name + "' — Ctrl+Z to undo";
    if (typeof App.setStatus === "function") App.setStatus(msg);
    return { ok: true, type: type, survivorIndex: newIndex, removedIds: removedIds, repoints: repoints, message: msg };
  }

  // Returns a Promise (Phase 3 makes the body asynchronous for routes).
  function run(type, indices, primaryIndex) {
    return new Promise(function (resolve, reject) {
      try { resolve(runSync(type, indices, primaryIndex)); } catch (e) { reject(e); }
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

  function openDialog(type, indices, primaryIndex) {
    var st = STRATEGIES[type];
    if (!st || !indices || indices.length < 2) return;
    if (_dlg) closeDialog();
    if (typeof App.closeContextMenu === "function") App.closeContextMenu();
    var arr = st.array();
    var state = { primary: indices.indexOf(primaryIndex) >= 0 ? primaryIndex : indices[0], busy: false };

    var overlay = el("div", "fm-overlay");
    var box = el("div", "fm-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "fmTitle");
    overlay.appendChild(box);

    var title = el("div", "rf-weights-modal-title", "Merge " + indices.length + " " + (st.plural.charAt(0).toUpperCase() + st.plural.slice(1)));
    title.id = "fmTitle";
    box.appendChild(title);
    box.appendChild(el("div", "fm-intro", "The " + st.plural + " you selected will become one " + st.singular +
      ". All the others are removed."));

    // Primary picker
    var pickWrap = el("div", "fm-section");
    var pickLabel = el("div", "fm-section-title", "Keep attributes from:");
    pickLabel.id = "fmPrimaryLabel";
    pickWrap.appendChild(pickLabel);
    var group = el("div", "fm-radio-list");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "fmPrimaryLabel");
    indices.forEach(function (i) {
      var f = arr[i];
      var row = el("label", "fm-radio-row");
      var rb = document.createElement("input");
      rb.type = "radio"; rb.name = "fmPrimary"; rb.value = String(i);
      rb.checked = (i === state.primary);
      rb.addEventListener("change", function () { if (rb.checked) { state.primary = i; refresh(); } });
      var dot = el("span", "fm-swatch");
      try { dot.style.background = App.resolveFeatureColor(type, f); } catch (e) { /* neutral swatch */ }
      row.appendChild(rb); row.appendChild(dot);
      row.appendChild(el("span", "fm-radio-name", featName(f, st.singular + " " + (i + 1))));
      group.appendChild(row);
    });
    pickWrap.appendChild(group);
    pickWrap.appendChild(el("div", "fm-hint", "This " + st.singular + " keeps its name, color, and position. Blank attributes are filled in from the others."));
    box.appendChild(pickWrap);

    var body = el("div", "fm-body");
    body.setAttribute("aria-live", "polite");
    box.appendChild(body);

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

    var token = 0;
    function refresh(onDone) {
      var my = ++token;
      body.innerHTML = "";
      body.appendChild(el("div", "fm-hint", "Checking…"));
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
      state.busy = true; mergeBtn.disabled = true; cancelBtn.disabled = true;
      run(type, indices, state.primary).then(function (res) {
        if (res && res.ok) { closeDialog(); return; }
        state.busy = false; cancelBtn.disabled = false; refresh();
      }, function (err) {
        state.busy = false; cancelBtn.disabled = false;
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

    _dlg = { overlay: overlay, onKey: onKey, prevFocus: document.activeElement };
    document.body.appendChild(overlay);
    // Focus the primary button once the analysis enables it (Cancel if blocked).
    refresh(function (plan) { if (_dlg) (plan && plan.ok ? mergeBtn : cancelBtn).focus(); });
  }

  App.merge = {
    mergeableSelection: mergeableSelection,
    analyze: analyze,
    run: run,
    openDialog: openDialog,
    closeDialog: closeDialog,
    isDialogOpen: function () { return !!_dlg; },
    // Phase 3 registers route / point / cross-type strategies here.
    _strategies: STRATEGIES
  };
})();
