// js/core/module-buffers.js
// Shared analysis-buffer helper. Feature Area Analysis, Transit Coverage,
// Transit Propensity, Ridership Forecasting, and Corridor Scoring can carry a
// module distance, independent of the Feature Settings global
// buffer radius (App.routeBuffers / App.lineBuffers / App.buffers, rebuilt by
// js/core/routes.js / lines.js / points.js). It never mutates those arrays and
// it can build either a private distance-based set or a selected display-buffer
// set for one analysis run.
// Depends on: App namespace, turf (CDN), App.points/lines/routes/polygons,
//   App.getPointWalkshed (walkshed.js, optional — guarded).
// No DOM access.

(function () {
  var App = window.App = window.App || {};

  App.ANALYSIS_BUFFER_DEFAULT_MILES = 0.5;
  App.ANALYSIS_BUFFER_MIN_MILES     = 0.05;
  App.ANALYSIS_BUFFER_MAX_MILES     = 5;

  // Fold an array of polygons into one union. Returns null for an empty array.
  function foldAnalysisUnion(polys) {
    if (!polys || !polys.length) return null;
    var union = polys[0];
    for (var i = 1; i < polys.length; i++) {
      try { union = turf.union(union, polys[i]); } catch (e) { /* skip */ }
    }
    return union;
  }

  // Build a single feature's private buffer polygon at the given distance.
  function buildAnalysisBuffer(feature, miles) {
    try { return turf.buffer(feature, miles, { units: "miles", steps: 64 }); }
    catch (e) { return null; }
  }

  // Return the drawn Feature Settings buffers for an explicit selection. This
  // makes "Use Display Buffers" honor the same per-feature overrides and
  // walkshed substitutions visible on the map. Polygons stay unbuffered.
  //
  // opts.includeHidden (default false): hidden features have no display buffer
  // (the shared arrays leave their slot empty), so one is built on the fly with
  // the radius the map would use — per-feature _bufferRadius, else the Feature
  // Settings type default; points keep the walkshed substitution. It is never
  // written into App.buffers / lineBuffers / routeBuffers.
  // Returns hiddenCount: { included, skipped } for hidden features in the filter.
  function buildDisplayBufferSet(filter, opts) {
    opts = opts || {};
    var includeHidden = !!opts.includeHidden;
    var byType = { route: {}, line: {}, point: {}, polygon: {} };
    var allPolys = [];
    var count = 0;
    var hiddenCount = { included: 0, skipped: 0 };

    function hiddenBuffer(type, feature) {
      var fs = App.featureSettings || {};
      var defKey = { route: "routeBufferRadius", line: "lineBufferRadius", point: "bufferRadius" }[type];
      if (type === "point") {
        var attrs = (feature.properties && feature.properties.attributes) || {};
        if (attrs.serviceAreaType === "walkshed" && typeof App.getPointWalkshed === "function") {
          var ws = App.getPointWalkshed(feature.properties.pointIdx);
          if (ws && (ws.geometry || ws.coordinates)) {
            return { type: "Feature", geometry: ws.geometry || ws, properties: { pointIdx: feature.properties.pointIdx, walkshed: true } };
          }
        }
      }
      var r = (feature.properties && feature.properties._bufferRadius != null)
        ? feature.properties._bufferRadius
        : (fs[defKey] != null ? fs[defKey] : 0);
      if (!(r > 0)) return null;
      try {
        if (type === "point") {
          var c = turf.circle(turf.point(feature.geometry.coordinates), r, { units: "miles", steps: 64 });
          return { type: c.type, geometry: c.geometry, properties: { pointIdx: feature.properties.pointIdx } };
        }
        var b = turf.buffer(feature, r, { units: "miles", steps: 64 });
        return b ? { type: b.type, geometry: b.geometry, properties: {} } : null;
      } catch (e) { return null; }
    }

    function add(type, features, displayBuffers, indices) {
      if (!indices) return;
      for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        var feature = features[idx];
        if (!feature) continue;
        var isHidden = !!(feature.properties && feature.properties.hidden);
        if (isHidden) {
          if (!includeHidden) { hiddenCount.skipped++; continue; }
        }
        var polygon = isHidden ? hiddenBuffer(type, feature) : displayBuffers[idx];
        if (!polygon) continue;
        if (isHidden) hiddenCount.included++;
        byType[type][idx] = polygon;
        allPolys.push(polygon);
        count++;
      }
    }

    filter = filter || {};
    add("route", App.routes || [], App.routeBuffers || [], filter.routeIndices);
    add("line", App.lines || [], App.lineBuffers || [], filter.lineIndices);
    add("point", App.points || [], App.buffers || [], filter.pointIndices);

    var polygons = App.polygons || [];
    var polygonIndices = filter.polygonIndices || [];
    for (var pi = 0; pi < polygonIndices.length; pi++) {
      var pidx = polygonIndices[pi];
      var poly = polygons[pidx];
      if (!poly) continue;
      if (poly.properties && poly.properties.hidden) {
        if (!includeHidden) { hiddenCount.skipped++; continue; }
        hiddenCount.included++;
      }
      byType.polygon[pidx] = poly;
      allPolys.push(poly);
      count++;
    }

    return {
      byType: byType,
      union: foldAnalysisUnion(allPolys),
      get: function (type, idx) { return (byType[type] && byType[type][idx]) || null; },
      count: count,
      hiddenCount: hiddenCount
    };
  }

  // Read + validate a buffer-distance input. Accepts an element id (string),
  // a DOM element, or any object exposing `.value` (so it's testable without
  // a DOM — the golden harness passes a plain { value: "..." } object).
  function readAnalysisBufferMiles(elOrId, fallback) {
    var fb = (fallback != null) ? fallback : App.ANALYSIS_BUFFER_DEFAULT_MILES;
    var el = elOrId;
    if (typeof elOrId === "string") {
      el = (typeof document !== "undefined") ? document.getElementById(elOrId) : null;
    }
    if (!el || el.value == null) return fb;
    var v = parseFloat(el.value);
    if (!Number.isFinite(v)) return fb;
    if (v < App.ANALYSIS_BUFFER_MIN_MILES || v > App.ANALYSIS_BUFFER_MAX_MILES) return fb;
    return v;
  }

  // Build a private buffer set for a filter of drawn features at the given
  // distance. filter = { routeIndices, lineIndices, pointIndices, polygonIndices }
  // — any key may be absent; always explicit arrays, never "null means all".
  //
  // Points: a point flagged attributes.serviceAreaType === "walkshed" with a
  // valid cached walkshed keeps that walkshed polygon regardless of `miles`
  // (a walkshed is a study-area TYPE, not a distance) unless
  // opts.preserveWalksheds === false. Otherwise a plain circle at `miles`.
  //
  // Polygons: passed through unbuffered (already an area).
  //
  // opts.includeHidden (default false): bypass the properties.hidden skip.
  // Returns { byType: {route:{}, line:{}, point:{}, polygon:{}}, union, get(type, idx), count,
  //   hiddenCount: { included, skipped } } — hidden features in the filter that were
  // included (flag on) or skipped (flag off).
  function buildAnalysisBufferSet(filter, miles, opts) {
    opts = opts || {};
    var preserveWalksheds = opts.preserveWalksheds !== false;
    var includeHidden = !!opts.includeHidden;
    var byType = { route: {}, line: {}, point: {}, polygon: {} };
    var allPolys = [];
    var count = 0;
    var hiddenCount = { included: 0, skipped: 0 };

    // True when the feature should be skipped for being hidden; tallies hiddenCount.
    function skipHidden(feat) {
      if (!(feat.properties && feat.properties.hidden)) return false;
      if (includeHidden) { hiddenCount.included++; return false; }
      hiddenCount.skipped++;
      return true;
    }

    function addRouteLike(type, arr, indices) {
      if (!indices) return;
      for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        var feat = arr[idx];
        if (!feat || skipHidden(feat)) continue;
        var buf = buildAnalysisBuffer(feat, miles);
        if (!buf) continue;
        byType[type][idx] = buf;
        allPolys.push(buf);
        count++;
      }
    }

    addRouteLike("route", App.routes || [], filter && filter.routeIndices);
    addRouteLike("line",  App.lines  || [], filter && filter.lineIndices);

    var points = App.points || [];
    var pointIndices = (filter && filter.pointIndices) || null;
    if (pointIndices) {
      for (var pi = 0; pi < pointIndices.length; pi++) {
        var idx = pointIndices[pi];
        var pf = points[idx];
        if (!pf || skipHidden(pf)) continue;
        var attrs = (pf.properties && pf.properties.attributes) || {};
        var buf = null;
        if (preserveWalksheds && attrs.serviceAreaType === "walkshed" &&
            typeof App.getPointWalkshed === "function") {
          var ws = App.getPointWalkshed(pf.properties.pointIdx);
          if (ws) {
            buf = { type: "Feature", geometry: ws.geometry || ws, properties: { pointIdx: pf.properties.pointIdx, walkshed: true } };
          }
        }
        if (!buf) {
          try {
            var pt = turf.point(pf.geometry.coordinates);
            var circle = turf.circle(pt, miles, { units: "miles", steps: 64 });
            buf = { type: circle.type, geometry: circle.geometry, properties: { pointIdx: pf.properties.pointIdx } };
          } catch (e) { buf = null; }
        }
        if (!buf) continue;
        byType.point[idx] = buf;
        allPolys.push(buf);
        count++;
      }
    }

    var polygons = App.polygons || [];
    var polygonIndices = (filter && filter.polygonIndices) || null;
    if (polygonIndices) {
      for (var gi = 0; gi < polygonIndices.length; gi++) {
        var gidx = polygonIndices[gi];
        var gf = polygons[gidx];
        if (!gf || skipHidden(gf)) continue;
        byType.polygon[gidx] = gf;
        allPolys.push(gf);
        count++;
      }
    }

    return {
      byType: byType,
      union: foldAnalysisUnion(allPolys),
      get: function (type, idx) { return (byType[type] && byType[type][idx]) || null; },
      count: count,
      hiddenCount: hiddenCount
    };
  }

  App.foldAnalysisUnion     = foldAnalysisUnion;
  App.buildAnalysisBuffer   = buildAnalysisBuffer;
  App.buildDisplayBufferSet = buildDisplayBufferSet;
  App.readAnalysisBufferMiles = readAnalysisBufferMiles;
  App.buildAnalysisBufferSet  = buildAnalysisBufferSet;
})();
