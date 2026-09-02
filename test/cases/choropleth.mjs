// Golden cases for the shared choropleth engine (js/core/choropleth.js).
// Only the classification math is pure/DOM-free (computeClassBreaks,
// buildStepColorExpr, buildInterpolateColorExpr, formatBreakLabels — all
// public directly on App.choropleth, no __MAT_TEST__ hook needed).
// render/remove/setVisible/fillLegend touch App.map/maplibregl/the DOM and
// are out of harness scope, same rationale as every other map-facing
// function in this suite — this also covers render()'s "continuous" method
// branch (Phase 3 Step 3.1 of docs/feature-area-choropleth-plan.md), which
// only wires buildInterpolateColorExpr into that map-facing path; the pure
// expression builder itself is what's pinned here.

export default {
  scripts: ["js/core/choropleth.js"],
  cases: [
    // ---- computeClassBreaks ----
    { id: "breaks/quantile-clean-spread", call: "App.choropleth.computeClassBreaks",
      args: [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], "quantile", 5] },
    { id: "breaks/equal-clean-spread", call: "App.choropleth.computeClassBreaks",
      args: [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], "equal", 5] },
    { id: "breaks/quantile-3-classes", call: "App.choropleth.computeClassBreaks",
      args: [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], "quantile", 3] },
    { id: "breaks/heavily-tied-dedup", call: "App.choropleth.computeClassBreaks",
      args: [[5, 5, 5, 5, 5, 5, 10, 10, 20, 100], "quantile", 5] },
    { id: "breaks/all-equal", call: "App.choropleth.computeClassBreaks",
      args: [[7, 7, 7, 7], "quantile", 5] },
    { id: "breaks/single-value", call: "App.choropleth.computeClassBreaks",
      args: [[42], "quantile", 5] },
    { id: "breaks/empty", call: "App.choropleth.computeClassBreaks",
      args: [[], "quantile", 5] },

    // ---- buildStepColorExpr ----
    { id: "stepExpr/5-classes-default-noData", call: "App.choropleth.buildStepColorExpr",
      args: ["value", [10, 20, 30, 40], ["#a", "#b", "#c", "#d", "#e"]] },
    { id: "stepExpr/3-classes-custom-noData", call: "App.choropleth.buildStepColorExpr",
      args: ["pop", [100, 200], ["#x", "#y", "#z"], "#fff"] },
    { id: "stepExpr/1-class-no-breaks", call: "App.choropleth.buildStepColorExpr",
      args: ["value", [], ["#solid"]] },

    // ---- buildInterpolateColorExpr (Phase 3 Step 3.1 — Continuous classes) ----
    { id: "interp/5-color-real-range-default-noData", call: "App.choropleth.buildInterpolateColorExpr",
      args: ["value", 0, 100, ["#a", "#b", "#c", "#d", "#e"]] },
    { id: "interp/3-color-real-range-custom-noData", call: "App.choropleth.buildInterpolateColorExpr",
      args: ["pop", 10, 50, ["#x", "#y", "#z"], "#fff"] },
    { id: "interp/degenerate-min-equals-max-solid-fallback", call: "App.choropleth.buildInterpolateColorExpr",
      args: ["value", 42, 42, ["#a", "#b", "#c", "#d", "#e"]] },
    { id: "interp/degenerate-no-data-solid-fallback", call: "App.choropleth.buildInterpolateColorExpr",
      args: ["value", null, null, ["#a", "#b", "#c", "#d", "#e"]] },

    // ---- formatBreakLabels ----
    { id: "labels/fixed-fmt-4-classes", call: "App.choropleth.formatBreakLabels",
      args: [[10, 20, 30], 0, 40, function (n) { return "V" + Math.round(n); }] },
    { id: "labels/no-fmt-default-stringify", call: "App.choropleth.formatBreakLabels",
      args: [[5], 0, 10] },
    { id: "labels/single-class-min-equals-max", call: "App.choropleth.formatBreakLabels",
      args: [[], 3, 3, function (n) { return "V" + n; }] },
  ],
};
