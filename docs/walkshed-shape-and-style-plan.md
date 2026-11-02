# Walkshed Shape & Style Plan

Status: **proposed**. Covers the Walkshed module (`js/projects/walkshed.js`) and,
because both modules share one polygon builder, Transit Travelshed
(`js/projects/transit-travelshed.js`).

## Goal

Make walksheds look clean and professional by default, without giving up their use
as study areas.

Today every walk polygon is a **concave hull** around the reachable street
intersections (`buildWalkshedPolygon`, `js/core/road-network.js:1021`). A single
"Hull detail — max edge" number decides the result:

- A low value gives jagged edges and "swiss cheese" holes.
- A high value gives long straight chords.
- Corners are always sharp, because the hull only connects dots with straight lines.
- The edge falls short: a partly walked block at the time limit is not counted.
- The default outline is heavy (`WS_OUTLINE_NORMAL` 2 px / 0.9).

The plan has three phases. Each one leaves the app in a finished, shippable state.

| Phase | What changes | Changes polygons/numbers? | Can stop after? |
|---|---|---|---|
| 1. Styling | Outline modes, soft edge, band fade, more palettes | No (display only) | Yes |
| 2. Cleanup ("Smoothed" shape) | Fill small holes, round edges, smooth; Shape selector + "previous shape" comparison | Yes, only when Smoothed is picked | **Yes, decision gate** |
| 3. Contour shape | Travel-time grid + contour lines, a third Shape option | Yes, only when Contour is picked | End of plan |

**Model assignment.** Each task is tagged **[S]** (fine for a Sonnet-level agent) or
**[O]** (reserve for Opus: delicate UI layout, map-layer interplay, or geometry
judgement). A [S] agent working next to an [O] task must not touch that task's files.

**Ground rules for every phase** (from `CLAUDE.md`):

- Read `docs/reference/modules/walkshed.md`, `docs/reference/modules/transit-travelshed.md`,
  `docs/reference/road-network.md` and `docs/reference/layers-and-styling.md` before editing.
  Trust the code when a doc and the code disagree.
- **Default output must stay byte-identical.** Anyone who doesn't touch a new option
  sees exactly today's map, today's polygons and today's cache keys. Every phase has
  a test that proves this.
- Record the test results in each commit message as `Verified:` lines.
- Update the reference docs in the same commit as the code they describe.

---

## How we compare shapes (the "Shape" toggle)

The comparison has to stay light and not crowd the panel.

1. **One "Boundary shape" dropdown** in the Walkshed panel's main inputs, directly
   under Walk speed, inside `data-input-group="analysis"`:
   - Phase 2 ships `Classic hull` and `Smoothed`.
   - Phase 3 adds `Contour`.
   - Only the selected method's parameters appear, inside **Advanced Settings**.
     Everything else stays hidden.
2. **"Previous shape" ghost outline.** When you recalculate with a *different* shape
   method, the last run's outermost boundary stays on the map as a thin dashed gray
   line.
   - A checkbox under the results table, "Show previous shape (Classic hull)",
     toggles it. It appears only when a previous run of a different method exists.
   - Under the checkbox, a one-line note gives the area change per band, e.g.
     `Area vs Classic hull: 15 min +3.8% · 30 min +2.1%`.
   - It is display-only and not saved. Clear results removes it.
3. **Workflow:** Calculate with Classic → switch to Smoothed → Calculate → read the
   dashed line and the % change → switch to Contour → Calculate → compare again.
   That is one dropdown and one checkbox.

The shape settings are **shared with Transit Travelshed**, the same way crossing
delays are today: one value, shown in both panels and marked "Shared with …".
Changing it marks both modules stale. The comparison overlay lives only in Walkshed.

---

## Phase 1: Styling (display only)

Nothing in this phase changes `bands[]`, study areas, exports or cache keys.

### 1.1 Pure helpers and palettes [S]

File: `js/core/layer-palettes.js`

- Add `LayerPalette.withAlpha(hex, a)`, which returns `"rgba(r,g,b,a)"`. It accepts
  `#rgb` and `#rrggbb`; any other input comes back unchanged.
- Add `LayerPalette.shade(hex, amount)`, which mixes toward black
  (`amount` 0–1, e.g. 0.35) and returns `#rrggbb`.
- Add three sequential presets to `PALETTES`. They are useful for isochrones:
  - `gnbu` "Green–Blue": `["#f0f9e8","#bae4bc","#7bccc4","#43a2ca","#0868ac"]`
  - `purples` "Purples": `["#f2f0f7","#cbc9e2","#9e9ac8","#756bb1","#54278f"]`
  - `ylgnbu` "Yellow–Blue": `["#ffffcc","#a1dab4","#41b6c4","#2c7fb8","#253494"]`

  These are **not** among the seven entries duplicated in `js/core/choropleth.js`
  RAMPS, so do not add them there. Update the comment at `layer-palettes.js:18-20` so
  it still lists exactly which seven entries are duplicated.
- Extend `test/cases/layer-palettes.mjs`:
  - `withAlpha`: 3- and 6-digit hex, and a pass-through case.
  - `shade`: 0, 0.35 and 1.
  - The palette list (the new ids appear in the sequential family).

  Seed with `node test/run-golden.mjs --update`, then confirm only the new cases
  were added.

### 1.2 New style keys [S]

File: `js/core/layer-palettes.js`, `App.setLayerStyle` (`:338`)

Add these keys to the `next` object and to the `isEmpty` test. `null` or absent
always means "today's default".

| Key | Values | Default when null |
|---|---|---|
| `outline` | `"bands"` \| `"tiers"` \| `"outer"` \| `"none"` | `"bands"` |
| `outlineWeight` | `"thin"` (1 px) \| `"normal"` (2 px) \| `"bold"` (3 px) | today's width rule (`outlineStyle()`) |
| `outlineTone` | `"match"` \| `"dark"` \| `"white"` | `"match"` |
| `softEdge` | `true` | off |
| `bandFade` | `true` | off |

Add the spec flags `styleOptions: true` to `LAYER_STYLES["walkshed"]` and
`LAYER_STYLES["transit-travelshed"]`. A single flag opts a layer into all five
controls.

Add one shared resolver to the same file, so the two modules don't each reinvent it:

```js
// Returns the effective outline/fill options for a styleOptions layer.
App.resolveShedStyle = function (styleKey) {
  // -> { outline, widthPx | null, tone, softEdge, bandFade }
};
```

`widthPx: null` means "use the module's existing width rule". This keeps the
default byte-identical.

### 1.3 Layers drawer controls [O]

File: `js/core/layers-panel.js`

Place the new controls right after the existing "Flatten overlaps" row (`:669`),
gated on `spec.styleOptions`. Use the existing `lp-style-row` / `lp-style-label` /
`lp-style-control` markup and add a dark-mode check.

- **Outline**: a `<select>` with Per band / Band edges merged ("tiers") / Outer edge
  only / None. Next to it, a compact weight select (Thin / Normal / Bold) and a tone
  select (Match fill / Darker / White). If three selects in one row is too wide, put
  weight and tone on a second indented row. Judge this from a screenshot.
- **Soft edge**: a checkbox.
- **Fade outer bands**: a checkbox.
- Extend the **Reset** condition at `:694` to include the new keys.
- Keep the drawer within today's drawer width. The Features/Layers panel is 250 px
  (`--fp-width`); nothing may scroll sideways.

### 1.4 Walkshed rendering [O]

File: `js/projects/walkshed.js`, `renderWalkshedLayers` (`:460`) and
`repaintWalkshedLayers` (`:328`)

- **Outline data by mode.** The outline already has its own source,
  `walkshed-line-src`.
  - `bands`: today's `outlineFeatures`, unchanged.
  - `tiers`: the boundary of each distinct minutes tier, unioned across points.
    Reuse the union work in `buildFlattenedFillFeatures`. Factor out a helper that
    returns the per-tier unioned polygons, then use it both for the flattened fill
    and here, so the logic isn't duplicated.
  - `outer`: one dissolved polygon, the union of every point's largest band.
  - `none`: an empty FeatureCollection. **Do not touch `visibility`**: the Layers
    panel owns it.
- **Mode changes are geometry changes.** A change of outline mode must re-render
  geometry, not just paint (the same reason flatten does today). The repainter calls
  `renderWalkshedLayers(_lastEntries)` when the resolved `outline` differs from the
  mode last rendered.
- **Weight and tone.**
  - Weight: `widthPx` overrides `outlineStyle().width` when set.
  - Tone `dark`: run the band colors through `LayerPalette.shade(c, 0.35)` before
    `matchExpr`.
  - Tone `white`: the literal `"#ffffff"`.
- **Band fade.** Bake the alpha into the **fill color**, not `fill-opacity`, using
  `withAlpha(color, [1, 0.6, 0.35][bandIdx])`.
  - Reason: the Layers panel opacity slider writes `fill-opacity` and `line-opacity`
    directly (`layers-panel.js:388-392`). Alpha baked into the color multiplies with
    the slider instead of fighting it.
  - Update the legend swatches (`fillWalkshedLegend`, `:363`) to show the faded colors.
- **Soft edge.** Add a new line layer, `walkshed-glow`.
  - Source: the outline source.
  - Order: inserted **below** `walkshed-line` and above `walkshed-fill`.
  - Paint: `line-width: 10`, `line-blur: 8`, `line-opacity: 0.35`, `line-color` = the
    band color expression.
  - Visibility: hidden (`visibility: none`) unless `softEdge` is on, toggled by the
    repainter. *Exception to the "Layers panel owns visibility" rule:* treat it as a
    sub-layer. When the Walkshed row's eye is off, the glow must also be off. Add it
    to the `walkshed-fill` entry's `layers` list at `layers-panel.js:106` with
    `op: "line-opacity"` so the eye and the remove action include it. Then make the
    repainter only ever *hide* it when `softEdge` is off. It may *show* it only when
    `walkshed-fill` is visible.
  - Tune the width and blur from screenshots at zoom 13 and 15.
- **Clearing.** `clearWalkshedLayers` must remove `walkshed-glow`.

### 1.5 Travelshed rendering [O]

File: `js/projects/transit-travelshed.js` (`:760-780`)

- Today the outline layer shares the fill source (`TS_SOURCE`). Give it its own
  source so the outline modes can change its data. Here `bands` and `tiers` are the
  same thing (there is a single origin).
- Apply the same weight, tone, fade and soft-edge logic through
  `App.resolveShedStyle("transit-travelshed")`.
- Add the glow layer to the `ts-travelshed-fill` Layers entry (`layers-panel.js:98`).
- Update `clearTravelshedLayers`.

### 1.6 Tests and docs [S, after 1.3–1.5 land]

- New `test/browser/walkshed-style.test.mjs`. Copy the synthetic grid and setup from
  `walkshed-flatten.test.mjs`. Check:
  1. **Defaults:** fill/line paint and source feature counts equal today's values
     (record them first from `main` with the same script).
  2. **Each outline mode:**
     - `none` → 0 features
     - `outer` → 1 feature
     - `tiers` → one feature per distinct minutes value
     - `bands` → the default
  3. **Weight and tone** change `line-width` / `line-color`.
  4. **Band fade:** the `fill-color` expression contains `rgba(`.
  5. **Soft edge:** `walkshed-glow` exists and is visible only when on, and is hidden
     when the Walkshed eye is off.
  6. **Persistence:** styles survive `App.cache.save()` + restore.
  7. **Clear:** Clear results removes `walkshed-glow`.
- Run `walkshed-flatten`, `layer-remove`, `hidden-features`, `clear-all` and the full
  golden suite.
- Screenshots: `test/ui-screens/capture.mjs`. **Inspect** the Layers drawer images in
  light and dark mode, and add a baseline for the expanded walkshed drawer.
- Docs:
  - `docs/reference/layers-and-styling.md`: the new keys, `styleOptions`, the
    alpha-in-color rule.
  - `docs/reference/modules/walkshed.md` and `transit-travelshed.md`: rendering
    sections.
  - `CLAUDE.md`: only if a public `App.*` name is added (`App.resolveShedStyle`). Run
    `node test/doc-coverage.mjs`.

**Phase 1 done when:** the default look is unchanged, and a user can produce a
"flatten + tiers + thin + soft edge + fade" map from the Layers drawer alone.

---

## Phase 2: Cleanup ("Smoothed" shape)

### 2.1 Shape settings plumbing [S]

**Storage:** `App.networkSettings.walkShape`, next to the crossing delays.

```js
walkShape: {
  method: "classic" | "smoothed" | "contour",  // contour arrives in Phase 3
  holeAcres: 10,       // fill interior holes smaller than this; 0 = keep all
  roundFt: 150,        // edge rounding radius (Smoothed)
  gridFt: 80,          // Phase 3
  offStreetFt: 330     // Phase 3
}
```

- **Fresh-session default:** `method: "smoothed"`.
- **Migration:** a restored session that has no `walkShape` gets
  `method: "classic"`. Do this in `js/core/cache.js` next to the
  `networkCrossingMajorSec` handling (`:338`). Old studies then keep their exact
  polygons and numbers.
- **Save/restore:** add `networkWalkShape` to the saved state (`cache.js:161-164`)
  and to the restore.
- **Units:** show feet and acres in the UI, store km internally where the code
  computes in km (convert at the UI boundary, the same as `FT_PER_KM` today). Keep
  the field names honest about their unit.

**Cache keys** (this is critical, so read it twice):

- Walkshed `settingsKeyFor` (`walkshed.js:112`): append a shape signature **only when
  `method !== "classic"`**, e.g. `|smoothed:10:150`. Classic keys stay byte-identical
  to today, so saved sessions don't turn stale on upgrade.
- Transit Travelshed: add the same signature to its stale/cache comparison. Find
  where it compares `_settings` against the last run.
- Changing any shape field calls `App.cache.save()` and marks both modules stale.
  Mirror how `crossingMajorSec` changes are wired today in both modules.

### 2.2 The refine engine [S]

New file: `js/core/walk-shape.js` → `window.WalkShape`.

- Pure apart from turf. It reads turf at **call time** only.
- Load it after `connector-graph.js` in `index.html`.
- Update the load order and file map in `CLAUDE.md` and
  `docs/reference/script-load-order.md`.

```js
WalkShape.refine(polygonFeature, { holeAcres, roundKm }) -> Feature<Polygon|MultiPolygon>
```

Steps, in order. Wrap each step in try/catch. If a step fails or produces an
invalid result, keep the previous step's output. `refine` never returns null for a
non-null input.

1. **Fill holes.** Drop every interior ring whose area (`turf.area` of the ring as a
   polygon) is below `holeAcres × 4046.86 m²`. Holes at or above the threshold are
   kept. A lake stays; a block missing its streets is filled.
2. **Close.** `turf.buffer(p, +roundKm)` then `turf.buffer(result, -roundKm)`, both
   with `{units: "kilometers"}`. This fills notches and slivers narrower than about
   2 × roundFt, while keeping the area roughly the same.
3. **Simplify** with `turf.simplify(p, {tolerance: 0.00003, highQuality: false})`,
   about 3 m. This keeps vertex counts sane before smoothing.
4. **Smooth** with `turf.polygonSmooth(p, {iterations: 2})` (Chaikin smoothing; it
   exists in the vendored turf 6.5.0). This rounds the remaining convex corners,
   which gives the "cloudlike" edge. `polygonSmooth` returns a FeatureCollection, so
   take `.features[0]`.
5. **Validate.** If `turf.kinks(p).features.length > 0`, fall back to the step-3
   output.
6. **Fill holes again.** Closing can open new tiny holes.

### 2.3 Wire it into the polygon builder [S]

File: `js/core/road-network.js`

- `buildWalkshedPolygon(coords, maxEdgeKm, shape)`: build the hull exactly as today,
  then `if (shape && shape.method === "smoothed" && window.WalkShape)` return
  `WalkShape.refine(hull, …)`. The <3-node buffer path is left as is.
- Pass `shape` through:
  - `computeWalkshed(lngLat, budgetKm, options)` reads `options.shape`.
  - `App.polygonizeNodeSet(coords, maxEdgeKm, shape)` takes a 3rd argument.
- With no `shape` argument, output must be byte-identical. The doc already promises
  this for `budgetsKm` (`road-network.md:40`); extend that sentence.
- In `walkshed.js computeForPoint` (`:155`), pass `shape: App.networkSettings.walkShape`.
- In `transit-travelshed.js` (`:1162`, `:1182`), pass the same object. After
  `App.foldAnalysisUnion(clusterPolys)`, run only the hole-fill step on the band
  polygon (expose it as `WalkShape.fillHoles(p, holeAcres)`). The union of rounded
  clusters can leave small enclosed gaps, and this removes them.

### 2.4 Shape selector UI [O]

Files: `projects/walkshed-popup.html`, `walkshed.js` init/sync,
`projects/transit-travelshed-popup.html`, `transit-travelshed.js`

**Walkshed panel:**

- Add `<select id="wsShapeMethod" class="rf-select">` under Walk speed, labelled
  "Boundary shape", with an `rf-info-btn` ⓘ explaining the options in one sentence each:
  - **Classic hull:** the original method; tune Hull detail.
  - **Smoothed:** fills small gaps and rounds the edge; recommended.
  - **Contour** (Phase 3): …
- In Advanced Settings, wrap the method-specific fields in
  `<div data-shape-method="classic smoothed">` style containers and show/hide them on
  change:
  - **Hull detail:** Classic and Smoothed.
  - **Fill holes smaller than (acres)** and **Edge rounding (ft):** Smoothed (and,
    in Phase 3, holes for Contour).
- Changing the method marks the result stale (the banner with Re-run). It does
  **not** recalculate automatically.

**Transit Travelshed panel:** the same select and fields, inside its Advanced
section, with the note "Shared with Walkshed".

Sync both panels from `App.networkSettings` on open, the same way the crossing
fields sync today.

### 2.5 "Previous shape" comparison overlay [O]

File: `js/projects/walkshed.js`

- **Closure state:** `_prevShape = { methodLabel, sig, outlineFc, areasByBand }`.
  This is module-private and not persisted.
- **On a successful Calculate:**
  - If the previous run's shape signature differs from this run's, stash the previous
    run's per-point **largest-band** polygons (as an outline FC) and the per-band
    total areas before replacing `_lastEntries`.
  - If the signature is the same, clear `_prevShape`. The comparison only makes sense
    across a method or parameter change.
- **Layer** `walkshed-prev-line`:
  - Paint: `#6b7280`, `line-width: 1.5`, `line-dasharray: [2, 2]`, `line-opacity: 0.9`.
  - Placed on top of `walkshed-line`.
  - Not listed in the Layers panel. It is transient and controlled from the module.
- **Results column**, under `#wsResultsTable`:
  - The checkbox "Show previous shape (⟨method label⟩)", checked by default.
  - The % area line, computed from `areasByBand` against the new run's band areas.
    Show "n/a" for a band that is missing in either run.
  - Hide both when `_prevShape` is null.
- **Cleanup:** Clear results, module clear and Clear All remove the layer and null
  `_prevShape`. Check the `clear-all` and `layer-remove` tests still pass.

### 2.6 Tests and docs [S]

**New `test/browser/walkshed-shape.test.mjs`.**

- **Grid:** start from the `walkshed-flatten` grid, but **remove the streets** for
  - one single block (a small hole, under 10 acres), and
  - a 4×4 block area (a "lake", well over 10 acres).
- **Checks:**
  1. **Classic is unchanged:** `App.computeWalkshed` with `shape: {method: "classic"}`
     and with no `shape` both deep-equal the output of a direct
     `App.polygonizeNodeSet(coords, maxEdge)` call. A restored session lacking
     `networkWalkShape` comes back as classic, and its walkshed `settingsKey` is
     unchanged.
  2. **Smoothed:**
     - the small hole is filled
     - the lake hole remains
     - `turf.kinks` is empty
     - each band's area is within ±12% of Classic's
     - vertex count is under 5,000 per band
  3. **Timing:** log `refine` time per band and fail above 250 ms on the test grid.
  4. **Method change:** switching the method marks Walkshed stale and Transit
     Travelshed stale (when it has a result).
  5. **Comparison:** after Classic → Smoothed recalculation, `walkshed-prev-line`
     exists with one feature per point and the area note is visible. Clear results
     removes both.
  6. **Downstream:** with "Use as study areas" on, `App.getPointWalkshed()` returns the
     smoothed polygon.
- Also run `walkshed-stale`, `walkshed-flatten`, `network-cache`, `hidden-features`,
  `clear-all` and golden.
- Screenshots: the panel with each method selected (fields shown/hidden), light and
  dark mode. Inspect them.
- **Docs:**
  - `walkshed.md`: settings, cache key, comparison overlay.
  - `transit-travelshed.md`: shared shape.
  - `road-network.md`: `shape` option, `WalkShape`.
  - `script-load-order.md`.
  - `CLAUDE.md`: the file map line for `walk-shape.js`, the load order, and add
    `window.WalkShape` to the Conventions list of pure-engine namespaces.

### Decision gate (end of Phase 2)

Try it on real study areas, not just the test grid. For each, Calculate with Classic,
then with Smoothed, and look at the dashed comparison line:

- Does Smoothed look professional at the zoom you present at?
- Are real barriers (rivers, lakes, rail yards, freeways) still visible as gaps or edges?
- Is the area change small enough, typically within a few percent, that study-area
  numbers stay defensible?
- Are the 10-acre hole default and the 150 ft rounding default right? Adjust the
  defaults here if not.

**If it is good enough: stop.** Phase 2 is complete on its own. The `contour` value
is simply never offered, and `gridFt`/`offStreetFt` can be removed from the defaults
in a one-line follow-up. Move this plan to `docs/archive/` with a note saying so.

---

## Phase 3: Contour shape

The idea: instead of wrapping a hull around intersections, compute the walk time at
every point on a fine grid, then draw contour lines at each budget. This is how
Valhalla, OpenTripPlanner and Mapbox build isochrones.

### 3.0 Spike first [O]

Before building the full feature, write a throwaway script in the scratchpad (not
committed). It loads the app with the test grid, builds contour polygons with the
algorithm below, and screenshots Classic / Smoothed / Contour side by side.

Confirm, in this order:

- **Input ordering.** `turf.isobands` in 6.5.0 accepts a `turf.pointGrid` output with
  the `z` values filled in. Check that its row/column ordering matches. Building the
  grid with `turf.pointGrid` itself is the safe path.
- **Output.** Check its rings are valid, with holes oriented correctly. Run
  `turf.rewind` if needed.
- **Speed.** A 30-minute walkshed (about 2.5 km radius) at an 80 ft (about 25 m) grid
  is about 200×200 = 40k cells. Target under 300 ms per point.

Report the screenshots to the user before continuing. If isobands misbehaves, the
fallback is a small marching-squares implementation inside `walk-shape.js`. That is a
bigger task, so flag it rather than doing it silently.

### 3.1 Travel-time samples [O]

File: `js/core/road-network.js`, inside `computeWalkshed` when `shape.method === "contour"`

Build a `samples` array of `{lng, lat, km}`:

- Every reached node: `{coord, distMap.get(key)}`.
- **Partial edges.** For every `_segmentIndex` segment that is not `pedBlocked` and
  has at least one endpoint in `distMap`, add points every `gridKm` along it. Each
  point's `km = min(dA + t, dB + (L − t))`, using `Infinity` for an endpoint that
  wasn't reached. `L` is the segment length (`turf.distance` or the module's existing
  length helper). Drop samples above the largest budget.

This is what makes the edge extend partway down the last block, instead of stopping
at the last intersection.

### 3.2 Contour engine [O]

File: `js/core/walk-shape.js`

```js
WalkShape.contour(samples, budgetsKm, { gridKm, offStreetKm, holeAcres }) -> [{budgetKm, polygon}]
```

1. Take the bounding box of the samples, padded by `offStreetKm` + 2 cells.
2. **Cell cap.** If `(w/gridKm)·(h/gridKm) > 250000`, grow `gridKm` until it fits, and
   return `{gridKmUsed}` so the module can note it in the results.
3. Bucket the samples into a hash grid with cell size `offStreetKm`.
4. For each grid point: `t = min over samples within offStreetKm of (s.km + euclidKm)`.
   If no sample is within reach, `t = maxBudget × 10`. Use a local equirectangular
   projection (scale longitude by cos lat) for the distances. This is pure arithmetic,
   with no turf in the inner loop.
5. For each budget `b`: `turf.isobands(grid, [-1, b], {zProperty: "t"})`, which gives
   the "disk" for that budget.
   - Bands are nested by construction, because it's the same grid with higher
     thresholds.
   - Merge the output into one (Multi)Polygon.
6. **Post-process** each disk:
   - Drop parts under 0.5 acre (specks).
   - `fillHoles(holeAcres)`.
   - `polygonSmooth` with 1 iteration.
   - `turf.kinks` check, falling back to the unsmoothed version.

`computeWalkshed` then fills `result.polygon` and `result.polygons[]` from these,
**in exactly the shape it returns today** (`budgetKm`, `polygon`, `nodeCount` where
`nodeCount` = reached nodes within the budget). Nothing in `walkshed.js` downstream
should need to change.

### 3.3 UI additions [S]

- Add `Contour` to both Shape selects.
- Its Advanced fields:
  - **Grid detail (ft)**, default 80, min 30, max 500.
  - **Off-street reach (ft)**, default 330: how far beyond a street the area may
    extend.
  - **Fill holes smaller than (acres)**: the shared field.
- Add `|contour:holes:grid:off` to the shape signature.
- If the cell cap kicked in, add a muted results line: "Grid coarsened to N ft for this
  size."

### 3.4 Transit Travelshed contour [O]

Kept separate from 3.1–3.3 because the travelshed's time surface is assembled from
access, ride and egress pieces.

- **First, verify a time source.** Check whether
  `engineResult.nodeTimes` (`transit-travelshed.js`, from `window.Travelshed`) already
  honours the access and egress walk caps and is the minimum over all paths.
  - **If it does:** samples = nodes with `nodeTimes[k] ≤ maxBudget`, with `km`
    replaced by minutes. Convert the off-street distance to minutes using
    `walkMinPerKm`. Then call `WalkShape.contour` with budgets in minutes. The engine
    is unit-agnostic as long as samples, budgets and off-street cost share a unit, so
    add a `costPerKm` option (1 for walksheds, `walkMinPerKm` here).
  - **If it does not:** build the per-cluster samples inside the existing loop,
    applying the same caps, and take the minimum per node.
- **Large extents.** Travelsheds can span 20–30 km, so the cell cap will coarsen the
  grid. Check that the result still looks acceptable, and that disjoint clusters stay
  disjoint. They should: cells beyond `offStreetKm` from any sample are unreachable.

### 3.5 Tests and docs [S]

Extend `walkshed-shape.test.mjs`:

- **Nesting:** each contour band lies within the next band. Check that
  `turf.area(turf.difference(inner, outer))` is under 0.5% of the inner band's area.
- **Barriers:** the lake hole survives, and the single-block hole is filled.
- **Off-street limit:** no vertex lies farther than `budgetKm + offStreetKm` from the
  origin (straight-line, a loose bound).
- **Partial edges:** the contour band area is at least the Classic band area minus 5%.
- **Cell cap:** a forced tiny `gridFt` triggers coarsening, and the results note
  appears.
- **Speed:** under 600 ms per point on the test grid.
- **Travelshed:** a contour run produces non-null bands, and they are nested.

Docs: the same set as Phase 2. Then move this plan to `docs/archive/`.

---

## Explicitly out of scope

- Changing the default **Classic** algorithm itself, which stays as a reference and
  fallback.
- Per-point shape overrides (one shape per session is enough).
- Persisting the comparison overlay.
- Raster or heatmap rendering of the travel-time surface. It's possible later from
  `WalkShape.contour`'s grid, but it isn't planned here.
