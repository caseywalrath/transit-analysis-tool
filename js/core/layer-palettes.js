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

  // The custom 2-stop gradient (Phase 7) is stored in the same `palette`
  // slot as a preset id, but is deliberately NOT a member of PALETTES: it has
  // no family, so list()/familyOf()/allows() never see it and the global
  // palette row can never be set to it. That is the point — a custom gradient
  // is a per-layer, deliberate two-color pick (the colorblind and
  // agency-branding cases), while the global palette stays restricted to
  // curated families so it can't make a semantic layer unreadable in one
  // click. See the resolver's custom branch below.
  var CUSTOM_ID = "custom";

  // A subsampled ramp (n < 5) can land on a preset's near-white extreme —
  // "blues"/"greens"/"gray"/"heat" all start colors5[0] within a few percent
  // of pure white. That is a fine, deliberately subtle lowest class for a
  // classed choropleth (TPI/RF always sample n === colors5.length, which
  // bypasses this clamp below and returns colors5 untouched), but it reads
  // as functionally invisible when it is instead the OUTERMOST band of a
  // ring layer (Walkshed/Transit Travelshed, both n:3) painted over a light
  // basemap — reported as "I don't see the outermost/lightest color" for
  // Blues/Greens/Grayscale. Scale any picked color whose average channel
  // exceeds LIGHTNESS_CEILING down to that ceiling, preserving hue/relative
  // saturation (a uniform per-channel scale-down, not a hue shift), so a
  // subsampled ramp never hands back a color indistinguishable from a light
  // map background. Deliberately NOT applied to gradientColors() — a custom
  // gradient's endpoints are the user's own explicit picks (see the
  // CUSTOM_ID comment above) and silently darkening one would be surprising.
  var LIGHTNESS_CEILING = 225;
  function ensureVisible(hex) {
    var c = hexToRgb(hex);
    if (!c) return hex;
    var avg = (c.r + c.g + c.b) / 3;
    if (avg <= LIGHTNESS_CEILING) return hex;
    var factor = LIGHTNESS_CEILING / avg;
    return rgbToHex({ r: c.r * factor, g: c.g * factor, b: c.b * factor });
  }

  // Same sampling arithmetic as js/core/choropleth.js's pickRampColors(),
  // plus the ensureVisible() floor above (choropleth.js's twin does not
  // apply it — see that function's comment for why the two are allowed to
  // diverge here).
  function pickRampColors(colors5, n) {
    if (n >= colors5.length) return colors5.slice(0, n);
    if (n === 1) return [ensureVisible(colors5[Math.floor((colors5.length - 1) / 2)])];
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(ensureVisible(colors5[Math.round(i * (colors5.length - 1) / (n - 1))]));
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

  // ---- Color primitives (Phase 7) -------------------------------------
  // Plain sRGB math on "#rgb"/"#rrggbb" strings. No color-space cleverness:
  // a 2-stop gradient here is a straight channel-wise lerp, which is what
  // MapLibre's own ["interpolate", ["linear"], ...] does between two stops,
  // so a custom gradient looks the same whether it is sampled to N discrete
  // classes here or interpolated continuously by the map.

  function hexToRgb(hex) {
    if (typeof hex !== "string") return null;
    var h = hex.trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(c) {
    function two(v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length === 1 ? "0" + s : s;
    }
    return "#" + two(c.r) + two(c.g) + two(c.b);
  }

  // n colors interpolated from `from` to `to` inclusive. Either endpoint
  // unparseable -> null (callers fall back to defaults, same contract as
  // rampColors on an unknown id). n < 1 -> []. n === 1 -> the midpoint, so a
  // 1-class degenerate case reads as "the middle of this range" exactly the
  // way pickRampColors treats a preset.
  function gradientColors(from, to, n) {
    var a = hexToRgb(from), b = hexToRgb(to);
    if (!a || !b) return null;
    if (n < 1) return [];
    if (n === 1) return [rgbToHex({ r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2 })];
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      out.push(rgbToHex({
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t
      }));
    }
    return out;
  }

  // "rgba(r, g, b, alpha)" for a hex string, or null when unparseable. The
  // static legend fragments paint a translucent fill plus a solid border from
  // one source color (see projects/transit-coverage-legend.html), so their
  // fill functions need the translucent form of whatever the cascade resolved.
  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    if (!c) return null;
    var a = (typeof alpha === "number" && isFinite(alpha)) ? alpha : 1;
    return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + a + ")";
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
    },
    // kind: "categorical" (Phase 7) — independent semantic colors, not a
    // ramp. Each class gets its own swatch; `classes` supplies the drawer's
    // row labels (two words max, per the plan's §3) and `defaultColors` is
    // positional against it. Categorical layers ignore App.mapPalette
    // entirely, for the same reason solid layers do: a global sequential
    // ramp says nothing about which color "service loss" should be.
    "transit-coverage": {
      label: "Transit Coverage", kind: "categorical",
      classes: [
        { key: "coverage",  label: "Coverage" },
        { key: "threshold", label: "Threshold" },
        { key: "area",      label: "Service area" }
      ],
      defaultColors: ["#93c5fd", "#1d4ed8", "#374151"]
    },
    "title-vi": {
      label: "Title VI service change", kind: "categorical",
      classes: [
        { key: "loss", label: "Loss" },
        { key: "gain", label: "Gain" }
      ],
      defaultColors: ["#e53e3e", "#38a169"]
    }
  };

  function specFor(styleKey) {
    return LAYER_STYLES[styleKey] || null;
  }

  window.LayerPalette = {
    PALETTES: PALETTES,
    LAYER_STYLES: LAYER_STYLES,
    CUSTOM_ID: CUSTOM_ID,
    list: list,
    rampColors: rampColors,
    gradientColors: gradientColors,
    rgba: rgba,
    matchExpr: matchExpr,
    familyOf: familyOf,
    allows: allows,
    specFor: specFor
  };

  // ---- App-level cascade (Phase 3 of docs/layer-color-customization-plan.md) ---
  // Reads/writes App state only inside function bodies (never at the top
  // level beyond the two default-init lines below), so this loads safely in
  // the golden sandbox, which stubs window.App with no App.map/App.cache —
  // same rule js/core/choropleth.js follows.

  var App = window.App;

  // Per-layer overrides, keyed by styleKey:
  //   { palette: "<id>"|null, reverse: bool|null, color: "#hex"|null }
  // A null/absent field means "not overridden at this level" — falls through
  // to the global palette (ramp layers) or the module default.
  App.layerStyles = App.layerStyles || {};
  App.mapPalette = App.mapPalette || null; // null = module defaults everywhere

  // Resolves the colors a layer should actually paint right now: per-layer
  // override -> global palette (only when the layer's spec.allow accepts its
  // family) -> the module's own defaultColors. Returns null for an unknown
  // styleKey. Never throws and never resolves to nothing paintable.
  App.resolveLayerColors = function (styleKey) {
    var spec = window.LayerPalette.specFor(styleKey);
    if (!spec) return null;
    var ov = App.layerStyles[styleKey] || {};

    if (spec.kind === "solid") {
      // Solid layers ignore App.mapPalette entirely — a global ramp says
      // nothing about what color a single accent line should be.
      return (ov.color) ? [ov.color] : spec.defaultColors.slice();
    }

    if (spec.kind === "categorical") {
      // Per-class overrides, positional against spec.defaultColors. Also
      // ignores App.mapPalette (see the LAYER_STYLES comment) — these are
      // semantic colors, so each class is overridden on its own or not at all.
      var ovc = ov.colors || [];
      return spec.defaultColors.map(function (def, i) {
        return ovc[i] || def;
      });
    }

    // kind === "ramp"
    var paletteId = ov.palette ||
      (window.LayerPalette.allows(spec, App.mapPalette) ? App.mapPalette : null);
    if (!paletteId) return spec.defaultColors.slice();

    if (paletteId === CUSTOM_ID) {
      // A custom gradient is literal and WYSIWYG: `from` always paints the
      // first class and `to` always the last, so the two swatches in the
      // drawer read exactly as the map does. It therefore ignores both
      // spec.reverseDefault and ov.reverse (reversing a 2-stop gradient is
      // just swapping the two picks, and honoring a stale `reverse` left over
      // from a preset would silently flip the map away from the swatches).
      return window.LayerPalette.gradientColors(ov.from, ov.to, spec.n) ||
        spec.defaultColors.slice();
    }

    var reverse = (ov.reverse != null) ? ov.reverse : spec.reverseDefault;
    var colors = window.LayerPalette.rampColors(paletteId, spec.n, reverse);
    return colors || spec.defaultColors.slice(); // unknown id never paints nothing
  };

  // Shallow-merges patch into App.layerStyles[styleKey]; an entry left with
  // every field null/absent is deleted outright so a defaulted layer leaves
  // no cache residue. Saves and repaints — never call map.setPaintProperty
  // directly from the Layers panel; this is the only sanctioned write path.
  App.setLayerStyle = function (styleKey, patch) {
    var cur = App.layerStyles[styleKey] || {};
    var next = {
      palette: (patch.palette !== undefined) ? patch.palette : cur.palette,
      reverse: (patch.reverse !== undefined) ? patch.reverse : cur.reverse,
      color: (patch.color !== undefined) ? patch.color : cur.color,
      // Phase 7: `from`/`to` are the custom gradient's two endpoints (ramp
      // layers); `colors` is the sparse per-class array (categorical layers).
      from: (patch.from !== undefined) ? patch.from : cur.from,
      to: (patch.to !== undefined) ? patch.to : cur.to,
      colors: (patch.colors !== undefined) ? patch.colors : cur.colors
    };
    var anyClassColor = !!(next.colors && next.colors.some(function (c) { return !!c; }));
    var isEmpty = !next.palette && next.reverse == null && !next.color &&
      !next.from && !next.to && !anyClassColor;
    if (isEmpty) {
      delete App.layerStyles[styleKey];
    } else {
      App.layerStyles[styleKey] = next;
    }
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    App.repaintStyledLayers();
  };

  // Sets (or, with a null/empty color, clears) one class of a categorical
  // layer. Kept here rather than in the Layers panel because the sparse-array
  // bookkeeping — pad to the class count, null out a cleared entry, collapse
  // an all-null array so setLayerStyle can delete the whole entry — is easy
  // to get subtly wrong and should have exactly one implementation.
  App.setLayerClassColor = function (styleKey, idx, color) {
    var spec = window.LayerPalette.specFor(styleKey);
    if (!spec || !spec.defaultColors) return;
    var cur = (App.layerStyles[styleKey] && App.layerStyles[styleKey].colors) || [];
    var next = spec.defaultColors.map(function (_, i) { return cur[i] || null; });
    if (idx < 0 || idx >= next.length) return;
    next[idx] = color || null;
    var anySet = next.some(function (c) { return !!c; });
    App.setLayerStyle(styleKey, { colors: anySet ? next : null });
  };

  App.clearLayerStyle = function (styleKey) {
    delete App.layerStyles[styleKey];
    if (App.cache && typeof App.cache.save === "function") App.cache.save();
    App.repaintStyledLayers();
  };

  // Each module registers a callback here (Phase 4) that re-applies its
  // paint properties from App.resolveLayerColors(...) WITHOUT re-running the
  // analysis, so a palette change is instant. A module whose layer is not
  // currently on the map must no-op rather than throw — the try/catch below
  // is what keeps one absent layer from stopping every later repainter.
  var _repainters = {};
  App.registerLayerRepainter = function (styleKey, fn) {
    _repainters[styleKey] = fn;
  };
  App.repaintStyledLayers = function (only) {
    Object.keys(_repainters).forEach(function (k) {
      if (only && k !== only) return;
      try { _repainters[k](); } catch (e) { /* no live layer for this module right now */ }
    });
  };

})();
