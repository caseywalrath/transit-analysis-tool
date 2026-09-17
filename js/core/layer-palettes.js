// js/core/layer-palettes.js
// Palette table, ramp sampling, and the per-layer style spec table for
// user-customizable analysis layer colors (window.LayerPalette, the same
// engine-namespace convention as window.WalkCost / window.ConnectorGraph /
// window.Travelshed).
//
// CONSTRAINT: this file's top section contains ONLY plain-value math — no
// turf, no DOM, no App.map at load time — so the golden harness
// (test/run-golden.mjs) loads it directly into a bare node:vm sandbox. The
// App-level cascade (resolver/registry, added in Phase 3 of
// docs/layer-color-customization-plan.md) reads window.App only inside
// function bodies, never at load time, following the same rule
// js/core/choropleth.js already follows.
//
// See docs/layer-color-customization-plan.md for the full design.

(function () {
  "use strict";

  // colors5 always runs LIGHT -> DARK (sequential) or LOW-END -> HIGH-END
  // (diverging). Callers reverse via rampColors(..., reverse). blues/greens/
  // heat/rdbu are byte-identical to js/core/choropleth.js's RAMPS table
  // (Phase 4.7 duplicates these three into that file's own RAMPS for the
  // Feature Area Analysis dropdown — if you change a color here, change it
  // there too).
  var PALETTES = {
    blues:   { label: "Blues",        family: "sequential", colors5: ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"] },
    greens:  { label: "Greens",       family: "sequential", colors5: ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"] },
    heat:    { label: "Heat",         family: "sequential", colors5: ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"] },
    viridis: { label: "Viridis",      family: "sequential", colors5: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
    gray:    { label: "Grayscale",    family: "sequential", colors5: ["#f7f7f7", "#cccccc", "#969696", "#636363", "#252525"] },
    rdbu:    { label: "Red–Blue",   family: "diverging",  colors5: ["#ca0020", "#f4a582", "#f7f7f7", "#92c5de", "#0571b0"] },
    quality: { label: "Red–Green",  family: "diverging",  colors5: ["#C53030", "#C05621", "#D69E2E", "#68A357", "#276749"] }
  };

  // Same sampling arithmetic as js/core/choropleth.js's pickRampColors(), so
  // a palette subsamples identically in both engines.
  function pickRampColors(colors5, n) {
    if (n >= colors5.length) return colors5.slice(0, n);
    if (n === 1) return [colors5[Math.floor((colors5.length - 1) / 2)]];
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(colors5[Math.round(i * (colors5.length - 1) / (n - 1))]);
    }
    return out;
  }

  // allow: array of family names, or null/absent for everything. Returns
  // [{id, label, family}] in the table's declared order.
  function list(allow) {
    var out = [];
    Object.keys(PALETTES).forEach(function (id) {
      var pal = PALETTES[id];
      if (allow && allow.length && allow.indexOf(pal.family) === -1) return;
      out.push({ id: id, label: pal.label, family: pal.family });
    });
    return out;
  }

  // Returns n colors evenly sampled from paletteId's colors5, reversed when
  // reverse is truthy. Unknown id -> null. n < 1 -> [].
  function rampColors(paletteId, n, reverse) {
    var pal = PALETTES[paletteId];
    if (!pal) return null;
    if (n < 1) return [];
    var out = pickRampColors(pal.colors5, n);
    if (reverse) out = out.slice().reverse();
    return out;
  }

  // ["match", ["get", prop], 0, colors[0], 1, colors[1], ..., colors[last]],
  // with the final color as the trailing fallback (not matched by index) —
  // exactly the shape js/projects/walkshed.js's BAND_COLORS and
  // js/projects/transit-travelshed.js's TS_COLOR_EXPR already use.
  // colors.length < 1 returns the plain string "#888888".
  function matchExpr(prop, colors) {
    if (!colors || colors.length < 1) return "#888888";
    var expr = ["match", ["get", prop]];
    for (var i = 0; i < colors.length - 1; i++) {
      expr.push(i, colors[i]);
    }
    expr.push(colors[colors.length - 1]);
    return expr;
  }

  // "sequential" | "diverging" | null for an unknown id.
  function familyOf(paletteId) {
    var pal = PALETTES[paletteId];
    return pal ? pal.family : null;
  }

  // True when spec.allow is absent/empty (no restriction) or includes the
  // family of paletteId. This single function is how the global-palette
  // restriction (e.g. Corridor Scoring accepting only diverging palettes) is
  // enforced — both App.resolveLayerColors (Phase 3) and the Layers-panel UI
  // (Phase 6) call it.
  function allows(spec, paletteId) {
    if (!spec || !spec.allow || !spec.allow.length) return true;
    return spec.allow.indexOf(familyOf(paletteId)) !== -1;
  }

  // ---- Layer style spec table ----------------------------------------
  // One source of truth for which layers are colorable and what they paint
  // by default — the same role VAR_META plays in js/core/utils.js. Every
  // defaultColors array below is byte-identical to what its module paints
  // today; changing a default here without also changing the module's own
  // constant would make Phase 4's "zero visual change" invariant false.
  var LAYER_STYLES = {
    "walkshed": {
      label: "Walkshed", kind: "ramp", n: 3, prop: "bandIdx",
      allow: ["sequential"], reverseDefault: true,
      defaultColors: ["#1e40af", "#3b82f6", "#93c5fd"]
    },
    "walkshed-seg": {
      label: "Walkshed streets", kind: "solid",
      defaultColors: ["#16a34a"]
    },
    "transit-travelshed": {
      label: "Transit Travelshed", kind: "ramp", n: 3, prop: "band",
      allow: ["sequential"], reverseDefault: true,
      defaultColors: ["#1d4ed8", "#3b82f6", "#93c5fd"]
    },
    "tpi": {
      label: "Transit Propensity", kind: "ramp", n: 5,
      allow: ["sequential", "diverging"], reverseDefault: false,
      defaultColors: ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"]
    },
    "rf": {
      label: "Ridership Forecast", kind: "ramp", n: 5,
      allow: ["sequential", "diverging"], reverseDefault: false,
      defaultColors: ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"]
    },
    "corridor-scoring": {
      label: "Corridor Scoring", kind: "ramp", n: 4,
      allow: ["diverging"], reverseDefault: false,
      defaultColors: ["#C53030", "#C05621", "#D69E2E", "#276749"]
    },
    "gtfs-shapes": {
      label: "GTFS routes", kind: "solid",
      defaultColors: ["#718096"]
    },
    "gtfs-stops": {
      label: "GTFS stops", kind: "solid",
      defaultColors: ["#718096"]
    }
  };

  function specFor(styleKey) {
    return LAYER_STYLES[styleKey] || null;
  }

  window.LayerPalette = {
    PALETTES: PALETTES,
    LAYER_STYLES: LAYER_STYLES,
    list: list,
    rampColors: rampColors,
    matchExpr: matchExpr,
    familyOf: familyOf,
    allows: allows,
    specFor: specFor
  };

})();
