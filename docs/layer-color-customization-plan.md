# Layer color customization — implementation plan

Lets a user restyle the colors of analysis output layers (walksheds, travelsheds,
choropleths, scored corridors) and the GTFS reference layers, from one place, with
the choice surviving a re-run and a page reload.

**Read this whole document before starting. Implement one phase at a time. Do not
start a phase until the previous one is committed and its verification steps pass.**

---

## 0. Background — why this is not just "add a dropdown"

Three facts about the current code shape everything below. Verify each for yourself
before you write code; they are the reason the plan is ordered the way it is.

### 0.1 The Layers-panel opacity control is stateless, and color cannot copy it

`js/core/layers-panel.js` `entryOpacity()` reads opacity live off the map with
`map.getPaintProperty()`, and `setEntryOpacity()` writes it straight back. Nothing is
stored anywhere.

So when a module re-runs, `App.choropleth.render()` calls
`map.setPaintProperty(fillLayerId, "fill-opacity", fillOpacity)` and the user's slider
value is silently discarded. Same for every hand-rolled layer.

That is tolerable for opacity. It is **not** tolerable for color — people re-run
analyses constantly, and a color that evaporates on re-run is worse than no control.

**Therefore:** color must be stored in a registry and **resolved by the module at
render time**. The Layers panel writes to the registry; it must never write paint
properties directly. This is the same shape as the existing drawn-feature color
cascade (`App.sectionColors` → `properties.color` → `App.resolveFeatureColor`), which
is persisted in `cache.js` and resolved fresh on every render. Copy that, not the
opacity slider.

### 0.2 Four legends hardcode their swatch colors in HTML

`projects/tpi-legend.html`, `corridor-scoring-legend.html`,
`transit-travelshed-legend.html` and `walkshed-legend.html` all carry inline
`style="background:#08519c"` on their swatches. Only Feature Area Analysis uses the
dynamic `App.choropleth.fillLegend()`.

Change a map color without touching these and the legend quietly lies. Phase 5 exists
solely for this and is **not optional**.

### 0.3 Walkshed bands are stacked, not ring-differenced

`js/projects/walkshed.js` `renderWalkshedLayers()` pushes all three band polygons as
overlapping fills at `fill-opacity: 0.14` (see its own comment: *"no ring-differencing
in this phase — stacked translucent fills are simpler"*). Three overlapping fills
composite to roughly 0.36 effective opacity in a blended color that is **none of the
three declared colors**.

Give a user a color picker against that and the legend swatch will visibly not match
the map. Phase 1 fixes this first. Transit Travelshed already ring-differences
correctly (`js/projects/transit-travelshed.js` ~line 1150) — copy its approach.

---

## 1. Design

### 1.1 The cascade

Three levels, resolved fresh on every render, mirroring `App.resolveFeatureColor`:

```
1. App.layerStyles[styleKey]   per-layer override chosen by the user   (persisted)
2. App.mapPalette              one global palette for all layers       (persisted)
3. spec.defaultColors          the exact colors the module paints today
```

**Level 3 is an explicit color array, not a palette id.** Every layer declares
`defaultColors` equal to exactly what it paints today. Nothing changes visually until
the user actively picks something. This makes every phase before the UI phase a
provable no-op, which is the whole point of the ordering.

### 1.2 Palette families, and how Corridor Scoring is restricted

Each palette belongs to a family:

- **sequential** — one hue ramp, low→high. `blues`, `greens`, `heat`, `viridis`, `plasma`,
  `inferno`, `magma`, `cividis`, `gray` (`plasma`/`inferno`/`magma`/`cividis` added
  post-ship — see the "Post-ship addition — matplotlib perceptually-uniform presets"
  section below)
- **diverging** — two opposed ends. `rdbu`, `quality`

Each layer declares which families it accepts, via `allow`.

Corridor Scoring's red→green is not decoration — it is the message, read instantly
without a legend. A sequential ramp there produces light-blue and dark-blue corridors
and the reader genuinely cannot tell which is the good one. So Corridor Scoring
declares `allow: ["diverging"]`. Its palette dropdown offers only Diverging (Rd-Bu),
Quality, and Default. Colorblind users can still swap red/green for red/blue; nobody
can accidentally make the map unreadable.

**The global palette only applies to a layer whose `allow` includes that palette's
family.** Setting the global palette to Viridis (sequential) leaves Corridor Scoring
alone. Setting it to Rd-Bu (diverging) reaches it. This one rule is what makes the
restriction meaningful rather than cosmetic.

### 1.3 Ramp direction is not uniform — hence `reverseDefault`

TPI and Ridership Forecast paint **dark = high score**. Walkshed and Travelshed paint
**dark = the smallest band** (most walkable), i.e. dark = *low* minutes. A palette's
`colors5` runs light→dark, so those two need reversing to reproduce their intent.

Each layer declares `reverseDefault`. The drawer exposes a **Reverse** checkbox
seeded from it.

### 1.4 Feature Area Analysis is deliberately excluded from the Layers-panel drawer

It already has `#basMapRamp` in its own popup, and its correct palette depends on what
is being mapped (Count vs Percent vs Density — Rd-Bu is annotated "best for
percent/deviation" there). That is module knowledge and belongs next to the data.

Phase 4 adds the three new palettes to that existing dropdown so the palette set is
uniform app-wide. Its Layers-panel row keeps opacity only, no palette drawer. This is
a deliberate split, not an inconsistency — do not "fix" it.

---

## 2. Scope

**In scope:** Walkshed fill, Walkshed reachable streets, Transit Travelshed fill, TPI
choropleth, Ridership Forecast choropleth, RF corridor CDI line layer, Corridor
Scoring (diverging only), GTFS routes, GTFS stops. Global palette. Persistence.

**Out of scope (do not build unless asked):** Feature Area Analysis's Layers-panel
drawer (§1.4). Walk network, OSM, municipal boundary, road-download-area and
network-joins reference layers — the user reviewed these and decided the current gray
is fine. Per-class individual color pickers. Basemap-aware automatic palette
switching. Changing any layer's default appearance.

**Deferred to Phase 7, which is optional and separable:** Transit Coverage and
Title VI (categorical, not ramps), and the custom 2-stop gradient.

---

## 3. UI rules — read before writing any markup

The Layers panel is a narrow (208 px) navigation surface. It is already dense. Every
control added makes finding the one you wanted slower.

- **Two words maximum per label.** "Palette". "Reverse". "Color". Not "Color palette
  for this layer" or "Reverse the ramp direction".
- **No help text, no info buttons, no explanatory paragraphs anywhere in the panel.**
  If a control needs explaining, put it in the `title` attribute.
- **Reuse the existing style-drawer classes verbatim**: `.lp-style-group`,
  `.lp-style-header`, `.lp-caret`, `.lp-style-drawer`, `.lp-style-row`,
  `.lp-style-label`, `.lp-style-control`, `.lp-style-clear`, `.lp-style-reset`,
  `.lp-swatch`. These are already sized at `--text-2xs` with nowrap + ellipsis. Add no
  new CSS except the one select rule named in Phase 6.
- **At most three rows in any drawer.** Palette, Reverse, Reset. That is the ceiling.
- **The drawer is closed by default** and its open/closed state is per-session only
  (a plain module-local object, like the existing `_expandedTypeStyle`). Do not
  persist it.
- Do not widen the panel. Do not add a second column. Do not add icons beyond the
  caret that already exists on style rows.

---

## Phase 1 — Ring-difference the Walkshed bands (prerequisite)

No color work. This makes Walkshed's painted colors truthful so everything after it
is meaningful.

**File:** `js/projects/walkshed.js`, `renderWalkshedLayers()` (~line 307).

1. Before building `polyFeatures`, for each entry with more than one band, difference
   each band against the next-smaller one so the bands become non-overlapping rings.
   Copy the approach in `js/projects/transit-travelshed.js` ~lines 1150-1169: iterate
   largest-first, `turf.difference(thisBand, nextSmallerBand)`, and on a thrown error
   or null result fall back to the un-differenced polygon for that band rather than
   dropping it.
2. Keep the existing push order (largest first) and the `bandIdx` property exactly as
   they are. Only the geometry changes.
3. Raise `fill-opacity` from `0.14` to `0.30`. The old value was tuned for three
   stacked fills; a single ring at 0.14 is nearly invisible.
4. `entry.polygon` / `entry.area` / `entry.reachableCount` must keep aliasing the
   **smallest, un-differenced** band — they feed `App.getPointWalkshed()` and the
   study-area substitution in `points.js rebuildBuffers()`. Difference only the
   copies used for rendering. **Getting this wrong silently corrupts every downstream
   demographic module.** Verify by reading `getPointWalkshed` before you edit.
5. GeoJSON export must also keep exporting un-differenced polygons — an exported
   15-min walkshed must be a complete walkshed, not a donut.

**Verify:**
- `node --check js/projects/walkshed.js`
- `node test/run-golden.mjs` → must stay **180/180**. Walkshed is not golden-tested;
  any movement means you edited something you should not have.
- Run a walkshed with two budgets. The inner band must be a solid shape; the outer
  must be a ring with a visible hole. Colors must still read as distinct, not muddy.
- Set a point's Service Area to Walkshed and run Feature Area Analysis. The study area
  must be the full inner walkshed, not a ring.

**Commit:** `fix: ring-difference walkshed bands so band colors render true`

---

## Phase 2 — Palette engine (pure, golden-tested)

**New file:** `js/core/layer-palettes.js`, defining `window.LayerPalette`.

No turf, no DOM, no `App.map` at load time — plain values in, plain values out — so
the golden harness loads it directly. Same convention as `window.WalkCost`,
`window.ConnectorGraph`, `window.Travelshed`.

```js
// js/core/layer-palettes.js
(function () {
  "use strict";

  // colors5 always runs LIGHT -> DARK (sequential) or LOW-END -> HIGH-END
  // (diverging). Callers reverse via rampColors(..., reverse).
  var PALETTES = {
    blues:   { label: "Blues",        family: "sequential", colors5: ["#eff3ff","#bdd7e7","#6baed6","#3182bd","#08519c"] },
    greens:  { label: "Greens",       family: "sequential", colors5: ["#edf8e9","#bae4b3","#74c476","#31a354","#006d2c"] },
    heat:    { label: "Heat",         family: "sequential", colors5: ["#ffffb2","#fecc5c","#fd8d3c","#f03b20","#bd0026"] },
    viridis: { label: "Viridis",      family: "sequential", colors5: ["#440154","#3b528b","#21918c","#5ec962","#fde725"] },
    gray:    { label: "Grayscale",    family: "sequential", colors5: ["#f7f7f7","#cccccc","#969696","#636363","#252525"] },
    rdbu:    { label: "Red–Blue",     family: "diverging",  colors5: ["#ca0020","#f4a582","#f7f7f7","#92c5de","#0571b0"] },
    quality: { label: "Red–Green",    family: "diverging",  colors5: ["#C53030","#C05621","#D69E2E","#68A357","#276749"] }
  };
  ...
})();
```

`viridis` is the colorblind-safe option **and** the dark-basemap option — its low end
is dark purple, not near-white, so it stays legible on `carto-dark` where Blues does
not. That is why it earns a slot.

Public API:

- `LayerPalette.PALETTES` — the table above.
- `LayerPalette.list(allow)` — `allow` is an array of family names or null. Returns
  `[{id, label, family}]` filtered to those families, in the table's declared order.
  Null/absent `allow` returns everything.
- `LayerPalette.rampColors(paletteId, n, reverse)` — returns `n` colors evenly
  sampled from that palette's `colors5`, reversed when `reverse` is truthy. Reuse the
  exact sampling arithmetic in `js/core/choropleth.js` `pickRampColors()` so a palette
  subsamples identically in both engines: `n >= 5` returns `colors5.slice(0, n)`,
  `n === 1` returns the middle color, otherwise index
  `Math.round(i * (colors5.length - 1) / (n - 1))`. Unknown id returns `null`.
  `n < 1` returns `[]`.
- `LayerPalette.matchExpr(prop, colors)` — builds
  `["match", ["get", prop], 0, colors[0], 1, colors[1], ..., colors[last]]`, with the
  final color as the trailing fallback. This is exactly the shape
  `js/projects/walkshed.js` `BAND_COLORS` and `transit-travelshed.js` `TS_COLOR_EXPR`
  already use. `colors` of length < 1 returns the string `"#888888"`.
- `LayerPalette.familyOf(paletteId)` — `"sequential"` / `"diverging"` / `null`.
- `LayerPalette.allows(spec, paletteId)` — true when `spec.allow` is absent/empty or
  includes `familyOf(paletteId)`. This single function is how §1.2's global-palette
  restriction is enforced; both the resolver and the UI call it.

Also in this file, the **layer style spec table** — one source of truth, the same role
`VAR_META` plays in `utils.js`:

```js
  var LAYER_STYLES = {
    "walkshed":           { label: "Walkshed",            kind: "ramp", n: 3, prop: "bandIdx",
                            allow: ["sequential"], reverseDefault: true,
                            defaultColors: ["#1e40af","#3b82f6","#93c5fd"] },
    "walkshed-seg":       { label: "Walkshed streets",    kind: "solid",
                            defaultColors: ["#16a34a"] },
    "transit-travelshed": { label: "Transit Travelshed",  kind: "ramp", n: 3, prop: "band",
                            allow: ["sequential"], reverseDefault: true,
                            defaultColors: ["#1d4ed8","#3b82f6","#93c5fd"] },
    "tpi":                { label: "Transit Propensity",  kind: "ramp", n: 5,
                            allow: ["sequential","diverging"], reverseDefault: false,
                            defaultColors: ["#eff3ff","#bdd7e7","#6baed6","#3182bd","#08519c"] },
    "rf":                 { label: "Ridership Forecast",  kind: "ramp", n: 5,
                            allow: ["sequential","diverging"], reverseDefault: false,
                            defaultColors: ["#eff3ff","#bdd7e7","#6baed6","#3182bd","#08519c"] },
    "corridor-scoring":   { label: "Corridor Scoring",    kind: "ramp", n: 4,
                            allow: ["diverging"], reverseDefault: false,
                            defaultColors: ["#C53030","#C05621","#D69E2E","#276749"] },
    "gtfs-shapes":        { label: "GTFS routes",         kind: "solid",
                            defaultColors: ["#718096"] },
    "gtfs-stops":         { label: "GTFS stops",          kind: "solid",
                            defaultColors: ["#718096"] }
  };
```

Every `defaultColors` array above must be verified against the live source before you
commit. Read each and confirm:

| styleKey | source of truth |
|---|---|
| `walkshed` | `js/projects/walkshed.js` `BAND_COLORS` |
| `walkshed-seg` | `js/projects/walkshed.js` `WS_SEG_LAYER` paint |
| `transit-travelshed` | `js/projects/transit-travelshed.js` `TS_COLOR_EXPR` |
| `tpi` | `App.choropleth.RAMPS.blues.colors5` (TPI renders with `ramp:"blues"`, `breaks:[1,2,3,4]` → 5 classes → full ramp, unsubsampled) |
| `rf` | same as TPI |
| `corridor-scoring` | `js/projects/corridor-scoring.js` `renderMapChoropleth()`, the `buildStepColorExpr` colors array |
| `gtfs-shapes` / `gtfs-stops` | `js/projects/gtfs.js` layer paint blocks |

Export `LayerPalette.LAYER_STYLES` and `LayerPalette.specFor(styleKey)` (returns the
spec or `null`).

**Register the script** in `index.html` immediately after
`<script src="js/core/walk-cost.js"></script>` — it has no dependencies and must load
before `layers-panel.js` and before every module.

**Golden tests:** new `test/cases/layer-palettes.mjs` with
`scripts: ["js/core/layer-palettes.js"]`. Cover at minimum: `rampColors` at n=3/4/5
forward and reversed; n=1; n=0; n greater than 5; an unknown palette id; `matchExpr`
with 3 colors and with 1 color; `familyOf` for a known and unknown id; `allows` with
absent `allow`, a matching family, and a non-matching family; `list(null)` and
`list(["diverging"])`. Seed with `node test/run-golden.mjs --update` and **read the
produced JSON to confirm the numbers are what you intended** before committing.

**Verify:**
- `node --check js/core/layer-palettes.js`
- `node test/run-golden.mjs` → count grows from 180 to 180 + your new cases, all passing.
- Nothing else changed; the app must look and behave exactly as before.

**Commit:** `feat: LayerPalette engine — palette table, ramp sampling, layer style specs`
with a `Verified: node test/run-golden.mjs → N/N` line.

---

## Phase 3 — Cascade, registry, persistence

Still zero visual change.

### 3.1 The registry and resolver

In the same `js/core/layer-palettes.js`, below the pure section, add the App-level
half (reading `App.layerStyles` at call time is safe in the golden sandbox — the
harness stubs `window.App`; just never touch `App.map` at load time, same rule
`choropleth.js` follows):

```js
  var App = window.App;

  // Per-layer overrides, keyed by styleKey:
  //   { palette: "<id>"|null, reverse: bool|null, color: "#hex"|null }
  // A null field means "not overridden at this level".
  App.layerStyles = App.layerStyles || {};
  App.mapPalette  = App.mapPalette  || null;   // null = module defaults
```

`App.resolveLayerColors(styleKey)` → an array of hex strings, or `null` when the
styleKey is unknown. Resolution order:

1. `spec = LayerPalette.specFor(styleKey)`; return `null` if absent.
2. `ov = App.layerStyles[styleKey] || {}`.
3. For `kind === "solid"`: return `[ov.color]` when `ov.color` is a non-empty string,
   else `spec.defaultColors.slice()`. **Solid layers ignore `App.mapPalette` entirely**
   — a global ramp says nothing about what color a single accent line should be.
4. For `kind === "ramp"`:
   - `paletteId = ov.palette || (LayerPalette.allows(spec, App.mapPalette) ? App.mapPalette : null)`
   - If `paletteId` is null → return `spec.defaultColors.slice()`.
   - `reverse = (ov.reverse != null) ? ov.reverse : spec.reverseDefault`
   - `colors = LayerPalette.rampColors(paletteId, spec.n, reverse)`
   - Return `colors` if non-null, else `spec.defaultColors.slice()` (unknown id never
     throws and never paints nothing).

Note step 4's first line: an explicit per-layer override wins even if it would be
disallowed by family — but the UI never offers a disallowed option, so the only way to
reach that state is a hand-edited session file. Do not add a guard; falling back
silently on `rampColors` returning null is sufficient.

`App.setLayerStyle(styleKey, patch)` — shallow-merges `patch` into
`App.layerStyles[styleKey]`, deletes the entry entirely when every field is
null/absent (so a defaulted layer leaves no cache residue), calls `App.cache.save()`,
then calls `App.repaintStyledLayers()`.

`App.clearLayerStyle(styleKey)` — deletes the entry, saves, repaints.

`App.repaintStyledLayers()` — a registry of repaint callbacks:

```js
  var _repainters = {};
  App.registerLayerRepainter = function (styleKey, fn) { _repainters[styleKey] = fn; };
  App.repaintStyledLayers = function (only) {
    Object.keys(_repainters).forEach(function (k) {
      if (only && k !== only) return;
      try { _repainters[k](); } catch (e) { /* a module with no live layer is not an error */ }
    });
  };
```

Each module registers a callback in Phase 4 that re-applies its paint properties from
`App.resolveLayerColors(...)` **without re-running the analysis**. This is what makes a
palette change instant instead of requiring a recompute. The `try/catch` matters: a
module whose layer is not currently on the map must be a no-op, not a thrown error
that stops every later repainter.

### 3.2 Persistence

**File:** `js/core/cache.js`. Two additive fields, mirroring the existing
`networkSnapToleranceFt` pattern exactly (read it at ~line 158 and ~line 308 first).

In `collect()`:
```js
      layerStyles: App.layerStyles ? JSON.parse(JSON.stringify(App.layerStyles)) : {},
      mapPalette:  App.mapPalette || null,
```

In `restore()`:
```js
    if (state.layerStyles && typeof state.layerStyles === "object") {
      App.layerStyles = JSON.parse(JSON.stringify(state.layerStyles));
    }
    if (state.mapPalette !== undefined) App.mapPalette = state.mapPalette || null;
```

Additive and defaulting gracefully, so **no core schema version bump** (the schema is
at v4; leave it there). An older session file simply has neither key and lands on
module defaults.

After restore completes, call `App.repaintStyledLayers()` once — guarded with a
`typeof` check, since `cache.js` loads before the modules register.

**Verify:**
- `node --check js/core/layer-palettes.js js/core/cache.js`
- `node test/run-golden.mjs` → unchanged from Phase 2's count.
- In the browser console: `App.resolveLayerColors("walkshed")` returns exactly
  `["#1e40af","#3b82f6","#93c5fd"]`. `App.resolveLayerColors("nope")` returns null.
  Set `App.mapPalette = "viridis"` then re-resolve `"corridor-scoring"` — it must
  still return its four defaults, because `quality`/`rdbu` are diverging and viridis
  is not. That check is the whole restriction rule; do not skip it.
- Export a session to JSON, confirm `layerStyles` and `mapPalette` are present, and
  re-import it cleanly.
- The app looks identical. No layer has changed color.

**Commit:** `feat: layer style registry, cascade resolver and session persistence`

---

## Phase 4 — Modules resolve colors at render time

Still zero visual change, because every `defaultColors` equals what each module paints
today. **This is the invariant to verify at the end of this phase.**

For each module below: replace the hardcoded color literal with a resolved value, and
register a repainter.

### 4.1 `js/core/choropleth.js` — accept explicit colors

Add one optional parameter so callers can supply colors directly instead of a `RAMPS`
key. In `render()`, after `var rampDef = RAMPS[opts.ramp] || RAMPS.blues;`:

- If `opts.colors` is a non-empty array, use it in place of the ramp for both the
  classed and continuous branches — for classed, `colors = opts.colors.slice(0, n)`
  padded from its own last entry if short; for continuous, pass `opts.colors` to
  `buildInterpolateColorExpr` in place of `rampDef.colors5`.
- Otherwise behave exactly as today.

Additive and backward compatible. Every existing caller keeps working untouched.
Update the `opts` comment block above `render()`.

### 4.2 Walkshed

`js/projects/walkshed.js`. Replace the `BAND_COLORS` constant with a function:

```js
  function bandColorExpr() {
    var colors = App.resolveLayerColors("walkshed") || ["#1e40af","#3b82f6","#93c5fd"];
    return window.LayerPalette.matchExpr("bandIdx", colors);
  }
```

Call it in both `addLayer` paint blocks. Then register a repainter that, when the
layers exist, calls `map.setPaintProperty` for `fill-color` on `WS_FILL_LAYER` and
`line-color` on `WS_LINE_LAYER` with a fresh `bandColorExpr()`, plus `line-color` on
`WS_SEG_LAYER` from `App.resolveLayerColors("walkshed-seg")[0]`.

Guard with `typeof window.LayerPalette === "undefined"` so a missing script tag
degrades to the current hardcoded colors rather than throwing — same defensive
pattern `walkshed.js` already uses for `window.WalkCost`.

Also note the `else` branch of `renderWalkshedLayers()` currently only calls
`setData()`. Add the paint refresh there too, so a re-run picks up a palette changed
while results were on screen.

### 4.3 Transit Travelshed

`js/projects/transit-travelshed.js`. Same treatment for `TS_COLOR_EXPR` → a function
over `App.resolveLayerColors("transit-travelshed")`, prop `"band"`. Register a
repainter for `ts-travelshed-fill` / `ts-travelshed-line`.

### 4.4 TPI and Ridership Forecast

`js/projects/transit-propensity.js` (~line 742) and
`js/projects/ridership-forecasting.js` (~line 785). Both call
`App.choropleth.render({..., breaks: [1,2,3,4], ramp: "blues", ...})`.

Replace `ramp: "blues"` with `colors: App.resolveLayerColors("tpi")` (resp. `"rf"`).
Keep `breaks: [1,2,3,4]` exactly as-is. Register repainters that simply re-call each
module's existing `renderChoropleth(_lastResult)` when a last result exists — these
modules already have that function and it is cheap (no Census calls).

RF's separate corridor CDI line layer (`rf-corridor-cdi-layer`) uses the same `"rf"`
styleKey — include it in RF's repainter.

### 4.5 Corridor Scoring

`js/projects/corridor-scoring.js` `renderMapChoropleth()` (~line 493). Replace the
inline `["#C53030","#C05621","#D69E2E","#276749"]` array with
`App.resolveLayerColors("corridor-scoring")`, passed to the same
`App.choropleth.buildStepColorExpr("cdi", [2,3,4], colors, "rgba(180,180,180,0.7)")`
call. Breaks and no-data color unchanged. Register a repainter calling
`renderMapChoropleth(_lastResult)`.

### 4.6 GTFS

`js/projects/gtfs.js` (~line 253). `gtfs-shapes-layer`'s `line-color` is a
`["case", <feed has a usable route_color>, ["concat","#",["get","route_color"]],
"#718096"]` expression. Change **only the final `"#718096"` fallback** to
`App.resolveLayerColors("gtfs-shapes")[0]`, leaving the `case` test and the
`route_color` branch untouched — a feed that ships real route colors must keep using
them, and the palette only governs feeds that do not.

`gtfs-stops-layer`'s `circle-stroke-color` becomes
`App.resolveLayerColors("gtfs-stops")[0]`; leave `circle-color` white (it is the fill
of a hollow marker, not an encoding). Register a repainter for both.

### 4.7 Feature Area Analysis dropdown

`projects/buffer-summary-popup.html`: add three `<option>`s to `#basMapRamp` —
`viridis` "Viridis", `gray` "Grayscale", `quality` "Red–Green". Keep the existing four
and their order. Rename nothing; the persisted `mapRamp` values must keep resolving.

`js/core/choropleth.js`: add the matching three entries to `RAMPS` with the identical
`colors5` arrays used in `LayerPalette.PALETTES`, so the two tables agree. **These are
now duplicated in two files — if you change one you must change the other.** Add a
comment on both saying so.

No Layers-panel drawer for this module (§1.4).

**Verify:**
- `node --check` on every file touched.
- `node test/run-golden.mjs` → unchanged count, all passing.
- `NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs`, then
  **open the images** — not just the pass count.
- Run each of the six modules and confirm every layer renders in exactly its current
  colors. Compare against `test/ui-screens/baseline/` where a baseline exists.
- In the console, set `App.layerStyles.walkshed = {palette:"viridis", reverse:true}`
  then `App.repaintStyledLayers()`. The walkshed must recolor **instantly, without
  re-running the analysis**. Then `App.clearLayerStyle("walkshed")` and confirm it
  returns to the original blues.

**Commit:** `feat: modules resolve layer colors through the style cascade`

---

## Phase 5 — Legends read their colors from the cascade

Still zero visual change at defaults. Without this the legends lie the moment anyone
changes a palette.

For each of the four static legend fragments, give every swatch an id and fill it
after mount, following the existing fill-after-mount precedent in
`transit-travelshed.js` (which already does this for its band *labels* — extend the
same function to also set `style.background`).

| File | Swatch ids to add | Filled by | Colors from |
|---|---|---|---|
| `projects/walkshed-legend.html` | `wsLegendSw0`, `wsLegendSw1`, `wsLegendSw2`, `wsLegendSwSeg` | `walkshed.js` | `"walkshed"`, `"walkshed-seg"` |
| `projects/transit-travelshed-legend.html` | `tsLegendSw0..2` | `transit-travelshed.js` | `"transit-travelshed"` |
| `projects/tpi-legend.html` | `tpiLegendSw0..4` | `transit-propensity.js` | `"tpi"` |
| `projects/corridor-scoring-legend.html` | `csLegendSw0..3` | `corridor-scoring.js` | `"corridor-scoring"` |

Rules:

- Keep the existing inline `style="background:…"` in the HTML as the pre-fill value,
  so the legend is never briefly blank and still reads correctly if JS has not run.
- **Legend row order must match the map's color order.** TPI's legend lists *high
  first* (`5 — High` at top) while its `colors` array runs low→high, so TPI's fill must
  iterate the colors array **reversed**. Corridor Scoring's legend also lists high
  first. Walkshed and Travelshed list smallest band first, matching array order. Get
  this wrong and the legend is inverted — check each one against its rendered map.
- Walkshed's walkshed swatch is currently a translucent fill plus a solid border
  (`rgba(37,99,235,0.25)` / `#2563eb`). With rings it should show the three band
  colors. Replace that single row with three rows labeled by minutes, matching the
  Travelshed legend's shape, and keep the reachable-streets row as-is.
- Each module's legend fill must be called both after the legend widget mounts **and**
  from its repainter, so a palette change updates the legend without a re-run.

**Verify:**
- Open each of the four modules, run it, and confirm the legend swatches match the
  map colors exactly at defaults.
- Change a palette from the console, repaint, and confirm the legend follows.
- Screenshot harness; inspect the legend images.

**Commit:** `feat: analysis legends resolve swatch colors from the style cascade`

---

## Phase 6 — Layers panel UI

The only phase that changes pixels. Re-read §3 (UI rules) before starting.

**File:** `js/core/layers-panel.js`.

### 6.1 Map manifest entries to styleKeys

Add a `styleKey` field to the `ANALYSIS` / `REFERENCE` manifest entries that have one:

| manifest entry id | styleKey |
|---|---|
| `walkshed-fill` | `walkshed` |
| `walkshed-seg` | `walkshed-seg` |
| `ts-travelshed-fill` | `transit-travelshed` |
| `tpi-choropleth-fill` | `tpi` |
| `rf-choropleth-fill` | `rf` |
| `corridor-scoring-routes-layer` | `corridor-scoring` |
| `gtfs-shapes-layer` | `gtfs-shapes` |
| `gtfs-stops-layer` | `gtfs-stops` |

Entries with no `styleKey` (Feature Area Analysis, Transit Coverage, Title VI, walk
network, OSM, census geos, municipal boundaries, road download area, FTA sites) render
exactly as they do today.

### 6.2 Per-layer drawer

In `buildLayerRow()`, when `entry.styleKey` is present and
`LayerPalette.specFor(entry.styleKey)` returns a spec, wrap the row in the same
`.lp-style-group` / caret / `.lp-style-drawer` structure `buildTypeStyleRow()` uses
(~line 1011). The caret goes **first in the row, before the grip** — same position as
the Style-defaults rows. Everything else on the row (eye, opacity, menu) is unchanged.

Drawer contents, in order, for `kind: "ramp"`:

```
Palette   [select ▾]
Reverse   [checkbox]
          [Reset]
```

- The select's first option is `Default` with value `""`. Then
  `LayerPalette.list(spec.allow)` in order. For Corridor Scoring that yields exactly
  three options: Default, Red–Blue, Red–Green.
- Give the select `class="lp-basemap-select"` — it already exists, is already sized
  for this panel, and needs no new CSS.
- The checkbox is seeded from
  `(ov.reverse != null) ? ov.reverse : spec.reverseDefault` and is **disabled while
  the select reads Default** (nothing to reverse).
- `Reset` uses `.lp-style-reset`, calls `App.clearLayerStyle(styleKey)`, re-renders
  the panel. Render it only when an override actually exists.

For `kind: "solid"`:

```
Color     [swatch] [×]
          [Reset]
```

- Swatch is `.lp-swatch`, opens `App.openColorPicker(swatchEl, currentColor, cb)` —
  the same call `buildTypeStyleRow()` makes at ~line 1085.
- The `×` (`.lp-style-clear`) appears only when `App.layerStyles[key].color` is set,
  and clears back to default. With it present, `Reset` is redundant — omit `Reset`
  for solid layers. One row total.

Every change calls `App.setLayerStyle(styleKey, patch)`, which already handles
saving and repainting. **The panel must never call `map.setPaintProperty` itself** —
that is the §0.1 mistake.

### 6.3 Global palette row

One row at the very top of the Analysis band, directly under its header:

```
Palette   [select ▾]
```

- Reuse `.lp-style-row` + `.lp-style-label` + `.lp-style-control`, not a full drawer.
  No caret, no reset — selecting `Default` is the reset.
- Options: `Default` (value `""`) then all seven from `LayerPalette.list(null)`.
- On change: set `App.mapPalette`, `App.cache.save()`, `App.repaintStyledLayers()`,
  re-render the panel.
- `title` on the row: `"Applies to layers that accept this palette type"`. That is the
  only explanatory text anywhere in this phase.

### 6.4 CSS

Add nothing except, if the select overflows the 208 px panel, one rule:

```css
.lp-style-control .lp-basemap-select { max-width: 104px; }
```

Check first — it may already fit.

**Verify:**
- `node --check js/core/layers-panel.js`
- `NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs` and
  **open the Layers-panel images in both light and dark themes.** Confirm: no
  horizontal overflow, no wrapped labels, no row taller than the existing style rows.
- Open Corridor Scoring's drawer and confirm the select offers exactly three options.
- Set the global palette to Viridis. TPI, RF, Walkshed and Travelshed must all change.
  Corridor Scoring and both GTFS layers must **not**.
- Set the global palette to Red–Blue. Corridor Scoring must change too.
- Set a per-layer palette on Walkshed, then change the global palette — Walkshed must
  keep its own choice.
- Reload the page. Every choice must survive. Re-run an analysis. Every choice must
  survive that too — this is the §0.1 bug this whole plan exists to avoid.
- Export a session, reset, re-import. Choices restored.

**Commit:** `feat: layer palette controls in the Layers panel`

Then update `CLAUDE.md`: a File Structure entry for `js/core/layer-palettes.js`, a
Script Load Order line, the `layers-panel.js` entry (styleKey drawers + global palette
row), the `cache.js` entry (two additive fields), an App Namespace section for the
cascade, and add "Layer palettes (`docs/layer-color-customization-plan.md`)" to the
covered-engines list.

---

## Phase 7 — Optional, separable

Do not start without asking.

- **Transit Coverage** and **Title VI** are categorical, not ramps — two or three
  independent semantic colors each (coverage vs threshold; service loss vs gain). They
  need a `kind: "categorical"` spec with one swatch per class, not a palette select.
  Title VI's red/green is semantically loaded in the same way Corridor Scoring's is.
- **Custom 2-stop gradient** — pick two endpoint colors, interpolate to `n`.
  `App.choropleth.buildInterpolateColorExpr` already does N-stop interpolation, so
  this is mostly UI. Covers agency branding with two picks instead of five.

### 7.1 As built

This phase was deliberately underspecified above. The decisions actually taken, and
why — read these before changing any of it:

**`kind: "categorical"`.** A spec carries a `classes: [{key, label}]` array alongside
its positional `defaultColors`; the drawer renders one `label + swatch + ×` row per
class and no palette select. Transit Coverage is three classes (Coverage `#93c5fd` /
Threshold `#1d4ed8` / Service area `#374151`), Title VI is two (Loss `#e53e3e` / Gain
`#38a169`). Title VI's fill and outline share one color per class, so a class is one
swatch, not two. Overrides persist as a **sparse positional array**,
`App.layerStyles[key].colors = [null, "#hex", …]`, written only through
`App.setLayerClassColor(styleKey, idx, color)` — that helper owns the pad/null/collapse
bookkeeping so `setLayerStyle` can still delete an all-default entry outright.

**Categorical ignores `App.mapPalette` entirely**, exactly as `kind: "solid"` does. A
global sequential ramp says nothing about which color "service loss" should be. This is
not the §1.2 family restriction (there is no family here) — it is a category that the
global control simply does not address, so it is left alone rather than filtered.

**The custom gradient is per-layer only, never global.** `"custom"` is stored in the
same `palette` slot as a preset id but is deliberately *not* a member of `PALETTES`, so
`list()` / `familyOf()` / `allows()` never see it and the global palette row cannot be
set to it. That line is the point: a custom gradient is two deliberate picks on one
layer (the colorblind and agency-branding cases, and the reason it is offered on
Corridor Scoring despite its `allow: ["diverging"]` — a two-color pick cannot be made
*by accident*), while the blunt global instrument stays restricted to curated families
so it can never render a semantic layer unreadable in one click.

**The gradient is literal and WYSIWYG.** `from` always paints the first class and `to`
the last; the resolver ignores both `spec.reverseDefault` and any `ov.reverse` left
over from a preset. Reversing a 2-stop gradient is just swapping the two picks, so the
drawer shows a **Colors** row with two swatches *in place of* the Reverse row — keeping
the drawer at the §3 three-row ceiling (Palette, Colors, Reset). Selecting `Custom`
seeds the two endpoints from the layer's currently-resolved first and last colors, so
switching to it is a visual no-op and the swatches open where the map already is.

**Two new pure helpers**, golden-tested in `test/cases/layer-palettes.mjs`:
`gradientColors(from, to, n)` (channel-wise sRGB lerp — the same thing MapLibre's own
`["interpolate", ["linear"], …]` does between two stops, so a custom gradient looks the
same sampled to N classes here or interpolated continuously by the map; `n === 1`
returns the midpoint, matching `pickRampColors`; an unparseable endpoint returns `null`
so the resolver falls back to defaults) and `rgba(hex, alpha)` (the legend fragments
paint a translucent fill plus a solid border from one source color, so their fill
functions need both forms).

**The "legends lie" rule from Phase 5 extends past legends.** Transit Coverage's legend
swatches are filled after mount like the other four. Title VI has no legend, but its
`.tvi-loss-swatch` / `.tvi-gain-swatch` chips next to each alteration card's computed
metrics are the same hazard — CSS-classed, one pair per card — so they are re-tinted
from `renderAlterationCards()` (the single choke point every caller goes through) and
from the repainter.

---

## Appendix — invariants to check at every phase

1. **Phases 2 through 5 must not change a single pixel of any map layer.** If a
   screenshot moves, you have a bug, not a design improvement.
2. **The golden count only moves in Phase 2.** Movement anywhere else means non-pure
   logic leaked into a tested module.
3. **Never call `map.setPaintProperty` from `layers-panel.js`** for a styled layer.
   The panel writes to the registry; modules repaint. Otherwise the next re-run
   silently discards the user's choice.
4. **`getPointWalkshed()` must keep returning an un-differenced polygon** after
   Phase 1, or every downstream demographic module quietly analyzes a donut.
5. **Legend order must match map color order** per module — some legends list high
   first, some list low first.

---

## Post-ship fix — light-end visibility in subsampled ramps

Reported: selecting Blues, Greens, or Grayscale for Walkshed made the outermost
(lightest, largest-budget) band effectively disappear.

**Cause:** `blues`/`greens`/`gray`/`heat`'s `colors5[0]` all sit within a few percent
of pure white (`gray` literally at `#f7f7f7`, nearly identical to the app's own light
basemaps). That is a fine, deliberately subtle lowest class for a 5-class choropleth —
TPI/RF sample `n === colors5.length` and bypass subsampling entirely, returning
`colors5` untouched — but Walkshed/Transit Travelshed both sample `n: 3` from a 5-stop
preset, and with `reverseDefault: true` that near-white extreme lands on the
**outermost** band, painted at low fill-opacity (0.30/0.35) over a light basemap:
functionally invisible, both as a fill and — since the line layer reuses the same
color at 0.9 opacity — as a boundary.

**Fix:** `pickRampColors()` (`js/core/layer-palettes.js`) now runs every subsampled
color through `ensureVisible()`, which scales a color's channels down (preserving
hue/relative saturation, not shifting it) whenever its average channel exceeds
`LIGHTNESS_CEILING`. A first pass at 225 still read too faint against a light basemap
(fine against Carto Dark, where nearly anything short of white shows up), so the
ceiling was lowered to **180** — a solidly visible mid-light tone against both. This
only fires inside the `n < colors5.length` subsampling branch — the `n >=
colors5.length` branch (TPI/RF's `n: 5`) returns `colors5` as-is, so no existing
default changed. `gradientColors()` (the Phase 7 custom 2-stop picker) is deliberately
exempt: a custom gradient's endpoints are the user's own explicit choice,
and silently darkening one would be surprising. `choropleth.js` carries an intentionally
identical copy of `pickRampColors()` for its own classed choropleths (Feature Area
Analysis) and was **not** touched — its low-n case is a rare tied-data degenerate
(dedup), not the everyday few-class-ramp path, so the divergence is acceptable and is
called out where the two functions' parity is documented in `layer-palettes.js`.

Golden-tested in `test/cases/layer-palettes.mjs` (`gray-n3-*-light-end-clamped` pins
the worst case; `viridis-n3-unaffected` pins that the floor only fires when a color
actually needs it). Verified: `node test/run-golden.mjs` → 215/215.

## Post-ship addition — matplotlib perceptually-uniform presets

Requested: more high-contrast options in the spirit of Viridis.

**Added:** `plasma`, `inferno`, `magma`, `cividis` to `PALETTES`
(`js/core/layer-palettes.js`) — the rest of matplotlib's perceptually-uniform
sequential family alongside the existing `viridis`. All four are `family: "sequential"`,
5-stop `colors5` sampled from the standard published colormap at t = 0, 0.25, 0.5, 0.75,
1.0, same shape as every other preset. `cividis` is additionally colorblind-safe
(deuteranopia/protanopia) — the only preset in the table with that property.

No engine change: these are pure table additions, so `pickRampColors()`/`ensureVisible()`
apply automatically (e.g. `inferno`'s and `cividis`'s light ends both exceed
`LIGHTNESS_CEILING` and get clamped like any other preset's would). `list(null)` now
returns 11 entries instead of 7; nothing consumes a hardcoded count. Golden-tested via
the existing `list/null-allow-everything` case, which now includes the four new rows.
Verified: `node test/run-golden.mjs` → 215/215 (only `test/golden/layer-palettes.json`'s
`list()` snapshot changed, by the 4 new rows — no other module's numbers moved).
