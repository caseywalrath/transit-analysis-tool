// Test-only fixture for test/cases/module-buffers.mjs (never loaded by the app).
// The golden sandbox has no turf, so this installs a tiny deterministic stand-in
// (a "buffer" is just a tagged record carrying its radius) plus a runner that
// sets up App.points/lines/routes/polygons, calls a real builder from
// js/core/module-buffers.js and returns a plain summary.
(function () {
  window.turf = {
    point: function (c) { return { type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }; },
    circle: function (pt, r) { return { type: "Feature", geometry: { type: "Polygon", r: r, src: "circle" }, properties: {} }; },
    buffer: function (f, r) { return { type: "Feature", geometry: { type: "Polygon", r: r, src: "buffer" }, properties: {} }; },
    union: function (a) { return a; }
  };

  function feat(spec, geomType) {
    var props = { hidden: !!spec.hidden };
    if (spec.radius != null) props._bufferRadius = spec.radius;
    if (spec.id != null) props.pointIdx = spec.id;
    return { type: "Feature", geometry: { type: geomType, coordinates: [0, 0] }, properties: props };
  }

  // scenario = { points:[{hidden,radius}], lines:[], routes:[], polygons:[],
  //   settings:{bufferRadius,lineBufferRadius,routeBufferRadius},
  //   display:{ points:[bool has display buffer], lines:[], routes:[] } }
  // call = { fn: "analysis"|"display", filter, opts, miles }
  window.__mbRun = function (scenario, call) {
    var App = window.App;
    App.points   = (scenario.points   || []).map(function (s) { return feat(s, "Point"); });
    App.lines    = (scenario.lines    || []).map(function (s) { return feat(s, "LineString"); });
    App.routes   = (scenario.routes   || []).map(function (s) { return feat(s, "LineString"); });
    App.polygons = (scenario.polygons || []).map(function (s) { return feat(s, "Polygon"); });
    App.featureSettings = scenario.settings || {};
    var d = scenario.display || {};
    function disp(flags) {
      return (flags || []).map(function (has) {
        return has ? { type: "Feature", geometry: { type: "Polygon", r: -1, src: "display" }, properties: {} } : undefined;
      });
    }
    App.buffers = disp(d.points); App.lineBuffers = disp(d.lines); App.routeBuffers = disp(d.routes);

    var set = call.fn === "display"
      ? App.buildDisplayBufferSet(call.filter, call.opts)
      : App.buildAnalysisBufferSet(call.filter, call.miles, call.opts);
    var out = { count: set.count, hiddenCount: set.hiddenCount, built: {} };
    ["route", "line", "point", "polygon"].forEach(function (t) {
      out.built[t] = Object.keys(set.byType[t]).map(function (k) {
        var g = set.byType[t][k].geometry || {};
        return k + ":" + (g.src || "poly") + (g.r != null ? "@" + g.r : "");
      });
    });
    out.sharedDisplayUntouched = (App.buffers.length === (d.points || []).length) &&
      App.buffers.every(function (b, i) { return !!b === !!(d.points || [])[i]; });
    return out;
  };
})();
