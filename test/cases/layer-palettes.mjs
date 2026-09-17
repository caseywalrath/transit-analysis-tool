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
  ],
};
