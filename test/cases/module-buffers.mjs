// Golden cases for the shared module-owned analysis buffer helper
// (js/core/module-buffers.js). App.readAnalysisBufferMiles is the only pure,
// DOM-optional helper there — buildAnalysisBuffer/buildAnalysisBufferSet/
// foldAnalysisUnion all call turf and read App.points/lines/routes/polygons,
// so they're out of harness scope by design (same rationale as every other
// turf-dependent module in this suite).
//
// The sandbox has no `document`, so readAnalysisBufferMiles must accept a
// plain object exposing `.value` (not just an element id string) to be
// testable headless — confirmed safe: passing a string id here resolves
// through `typeof document !== "undefined"` and falls back cleanly.

export default {
  scripts: ["js/core/module-buffers.js", "test/stubs/module-buffers-harness.js"],
  cases: [
    { id: "readBuffer/valid-value", call: "App.readAnalysisBufferMiles", args: [{ value: "1.5" }] },
    { id: "readBuffer/below-min", call: "App.readAnalysisBufferMiles", args: [{ value: "0.01" }] },
    { id: "readBuffer/above-max", call: "App.readAnalysisBufferMiles", args: [{ value: "99" }] },
    { id: "readBuffer/non-numeric", call: "App.readAnalysisBufferMiles", args: [{ value: "abc" }] },
    { id: "readBuffer/blank", call: "App.readAnalysisBufferMiles", args: [{ value: "" }] },
    { id: "readBuffer/missing-element-string-id", call: "App.readAnalysisBufferMiles", args: ["nonexistent-id"] },
    { id: "readBuffer/null-element", call: "App.readAnalysisBufferMiles", args: [null] },
    { id: "readBuffer/explicit-fallback-honored", call: "App.readAnalysisBufferMiles", args: [{ value: "" }, 0.75] },
    { id: "readBuffer/at-min-boundary", call: "App.readAnalysisBufferMiles", args: [{ value: "0.05" }] },
    { id: "readBuffer/at-max-boundary", call: "App.readAnalysisBufferMiles", args: [{ value: "5" }] },

    // ---- includeHidden / hiddenCount (docs/archive/hidden-features-analysis-plan.md Phase 1) ----
    // Runs the real builders against a stubbed turf (test/stubs/module-buffers-harness.js).
    ...(() => {
      const scen = {
        points: [{ hidden: false }, { hidden: true }, { hidden: true, radius: 0.3 }],
        lines: [{ hidden: false }, { hidden: true }],
        routes: [{ hidden: false }, { hidden: true }],
        polygons: [{ hidden: false }, { hidden: true }],
        settings: { bufferRadius: 0.5, lineBufferRadius: 0.75, routeBufferRadius: 1 },
        display: { points: [true, false, false], lines: [true, false], routes: [true, false] },
      };
      const filter = { pointIndices: [0, 1, 2], lineIndices: [0, 1], routeIndices: [0, 1], polygonIndices: [0, 1] };
      const hiddenOnly = { pointIndices: [1], lineIndices: [1], routeIndices: [1], polygonIndices: [1] };
      const mk = (id, fn, f, opts) => ({ id, call: "__mbRun", args: [scen, { fn, filter: f, opts, miles: 0.5 }] });
      return [
        mk("analysis/hidden-skipped-default", "analysis", filter, undefined),
        mk("analysis/hidden-skipped-flag-false", "analysis", filter, { includeHidden: false }),
        mk("analysis/hidden-included", "analysis", filter, { includeHidden: true }),
        mk("analysis/hidden-only-skipped", "analysis", hiddenOnly, undefined),
        mk("analysis/hidden-only-included", "analysis", hiddenOnly, { includeHidden: true }),
        mk("display/hidden-skipped-default", "display", filter, undefined),
        mk("display/hidden-included-on-the-fly", "display", filter, { includeHidden: true }),
        mk("display/hidden-only-skipped", "display", hiddenOnly, undefined),
        mk("display/hidden-only-included", "display", hiddenOnly, { includeHidden: true }),
      ];
    })(),
  ],
};
