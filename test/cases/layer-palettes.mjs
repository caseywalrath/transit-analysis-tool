// Golden cases for the layer color palette engine (js/core/layer-palettes.js).
// Only the pure section (rampColors/matchExpr/familyOf/allows/list) is
// covered — App.resolveLayerColors and the rest of the App-level cascade
// (Phase 3 of docs/layer-color-customization-plan.md) touch App.map-adjacent
// state and are out of harness scope, same rationale as every other
// map-facing function in this suite.

export default {
  scripts: ["js/core/layer-palettes.js"],
  cases: [
    // ---- rampColors ----
    { id: "rampColors/blues-n3-forward", call: "LayerPalette.rampColors",
      args: ["blues", 3, false] },
    { id: "rampColors/blues-n3-reversed", call: "LayerPalette.rampColors",
      args: ["blues", 3, true] },
    { id: "rampColors/blues-n4-forward", call: "LayerPalette.rampColors",
      args: ["blues", 4, false] },
    { id: "rampColors/blues-n5-forward", call: "LayerPalette.rampColors",
      args: ["blues", 5, false] },
    { id: "rampColors/blues-n1-middle", call: "LayerPalette.rampColors",
      args: ["blues", 1, false] },
    { id: "rampColors/blues-n0-empty", call: "LayerPalette.rampColors",
      args: ["blues", 0, false] },
    { id: "rampColors/blues-n-greater-than-5", call: "LayerPalette.rampColors",
      args: ["blues", 7, false] },
    { id: "rampColors/unknown-palette-null", call: "LayerPalette.rampColors",
      args: ["nope", 3, false] },

    // ensureVisible() lightness floor: a subsampled ramp's near-white
    // extreme is clamped so it never reads as invisible against a light
    // basemap (reported for Walkshed's Blues/Greens/Grayscale palettes,
    // which all start colors5[0] within a few percent of pure white — see
    // the LIGHTNESS_CEILING comment in layer-palettes.js). "gray" is the
    // most severe case: its unclamped light end (#f7f7f7) is nearly
    // identical to the app's own light basemaps.
    { id: "rampColors/gray-n3-forward-light-end-clamped", call: "LayerPalette.rampColors",
      args: ["gray", 3, false] },
    { id: "rampColors/gray-n3-reversed-light-end-clamped", call: "LayerPalette.rampColors",
      args: ["gray", 3, true] },
    // viridis's extremes are dark purple / saturated yellow, neither of
    // which trips the clamp — pins that the floor only fires when it's
    // actually needed.
    { id: "rampColors/viridis-n3-unaffected", call: "LayerPalette.rampColors",
      args: ["viridis", 3, false] },

    // ---- matchExpr ----
    { id: "matchExpr/3-colors", call: "LayerPalette.matchExpr",
      args: ["bandIdx", ["#1e40af", "#3b82f6", "#93c5fd"]] },
    { id: "matchExpr/1-color", call: "LayerPalette.matchExpr",
      args: ["cdi", ["#16a34a"]] },
    { id: "matchExpr/empty-colors-fallback", call: "LayerPalette.matchExpr",
      args: ["cdi", []] },

    // ---- familyOf ----
    { id: "familyOf/known-sequential", call: "LayerPalette.familyOf",
      args: ["blues"] },
    { id: "familyOf/known-diverging", call: "LayerPalette.familyOf",
      args: ["rdbu"] },
    { id: "familyOf/unknown-null", call: "LayerPalette.familyOf",
      args: ["nope"] },

    // ---- allows ----
    { id: "allows/absent-allow-permits-anything", call: "LayerPalette.allows",
      args: [{}, "blues"] },
    { id: "allows/matching-family", call: "LayerPalette.allows",
      args: [{ allow: ["diverging"] }, "rdbu"] },
    { id: "allows/non-matching-family", call: "LayerPalette.allows",
      args: [{ allow: ["diverging"] }, "blues"] },

    // ---- list ----
    { id: "list/null-allow-everything", call: "LayerPalette.list",
      args: [null] },
    { id: "list/diverging-only", call: "LayerPalette.list",
      args: [["diverging"]] },

    // ---- gradientColors (Phase 7 custom 2-stop gradient) ----
    // list() must keep returning exactly the seven curated presets — "custom"
    // is deliberately not a PALETTES member, so it can never reach the global
    // palette row (see the CUSTOM_ID comment in the engine). The two list
    // cases above pin that.
    { id: "gradientColors/black-to-white-n2-endpoints", call: "LayerPalette.gradientColors",
      args: ["#000000", "#ffffff", 2] },
    { id: "gradientColors/black-to-white-n3-midpoint", call: "LayerPalette.gradientColors",
      args: ["#000000", "#ffffff", 3] },
    { id: "gradientColors/red-to-blue-n5", call: "LayerPalette.gradientColors",
      args: ["#ff0000", "#0000ff", 5] },
    { id: "gradientColors/uneven-channels-n4-rounding", call: "LayerPalette.gradientColors",
      args: ["#1e40af", "#93c5fd", 4] },
    { id: "gradientColors/n1-returns-midpoint", call: "LayerPalette.gradientColors",
      args: ["#000000", "#ffffff", 1] },
    { id: "gradientColors/n0-empty", call: "LayerPalette.gradientColors",
      args: ["#000000", "#ffffff", 0] },
    { id: "gradientColors/shorthand-hex-accepted", call: "LayerPalette.gradientColors",
      args: ["#f00", "#00f", 3] },
    { id: "gradientColors/missing-endpoint-null", call: "LayerPalette.gradientColors",
      args: [null, "#0000ff", 3] },
    { id: "gradientColors/malformed-endpoint-null", call: "LayerPalette.gradientColors",
      args: ["#gg0000", "#0000ff", 3] },

    // ---- rgba (legend fills need the translucent form of a resolved color) ----
    { id: "rgba/opaque-default-alpha", call: "LayerPalette.rgba",
      args: ["#93c5fd"] },
    { id: "rgba/with-alpha", call: "LayerPalette.rgba",
      args: ["#1d4ed8", 0.35] },
    { id: "rgba/shorthand-hex", call: "LayerPalette.rgba",
      args: ["#abc", 0.5] },
    { id: "rgba/malformed-null", call: "LayerPalette.rgba",
      args: ["not-a-color", 0.35] },
  ],
};
