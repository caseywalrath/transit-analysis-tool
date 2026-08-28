# Feature Area Analysis Choropleth & Shared Choropleth Engine — Implementation Plan

**Status: Phases 1–3 complete.** The former Phase 4 (a standalone "Imported Geography
Analysis" module for TAZ-style GeoJSON) has been rolled into `features.md` — see that
file's "Imported Geography Analysis module" entry under Data & Analysis — since it's a
net-new module outside this plan's actual scope (building and migrating the shared
choropleth engine itself). This document now covers Phases 1–3 only.

## Context

Feature Area Analysis (`js/projects/buffer-summary.js`) currently answers "what are the totals inside my study area?" — it fetches per-geography ACS values, then `aggregateWithinUnion()` collapses them into one number per variable and the per-geography detail is discarded. The map shows only a flat gray "geographies analyzed" overlay (`census-geos-*` layers).

This plan adds GIS-style, per-geography output: a classed choropleth map colored by any selected census variable, per-geography hover popups, per-geography CSV export, normalization options (percent, density), and curated color ramps.

The critical architectural fact: **the disaggregated data already exists on every run.** `runSummary()` fetches a `Map<GEOID, value>` for every variable before aggregating (`buffer-summary.js:441-455`). No new fetch pipeline is needed — the work is retaining those maps and building display surfaces for them.

The rendering machinery also has a proven in-repo precedent: TPI's choropleth (`transit-propensity.js:660-778`) — GeoJSON source + fill/line layers + color expression + hover popup + floating legend + Layers-panel entry. RF (`ridership-forecasting.js:737-744`) and Corridor Scoring (`corridor-scoring.js:446-478`) carry near-copies. This plan builds the new renderer as a **shared core helper** (`js/core/choropleth.js`) and migrates those three modules onto it in Phase 3, ending the copy-paste lineage.

**This plan is written for execution by a cheaper model (Sonnet 5).** Steps are small, ordered, and independently verifiable; no design decisions are left open. Each phase is a shippable unit — stop at any phase boundary and the app is consistent. A "Handoff" section at the end explains how to run the implementation sessions.

## Settled design decisions (from user)

- **No "disaggregate" analysis mode.** Per-geography values are always retained from the normal run; the choropleth is a *display* of the same run, not a different analysis. The summary table, union math, and golden-tested behavior are unchanged.
- **Shared helper from day one.** The renderer is built as `js/core/choropleth.js` with Feature Area Analysis as its first consumer. TPI, Ridership Forecasting, and Corridor Scoring **must** be migrated onto it in Phase 3 (not optional).
- **Classed maps, 5-class quantile Blues in Phase 1.** Discrete classes with labeled break values in the legend (the consultant-deliverable look), not TPI's continuous interpolation. The helper also supports fixed/manual breaks (needed for the Phase 3 migrations, whose 1–5 score scales are already classed).
- **Curated color ramp presets only.** A ramp dropdown (Phase 3) with professionally chosen ColorBrewer ramps: Blues (default), heat-style YlOrRd, Greens, and diverging RdBu. No custom gradient editor.
- **Styling controls live in the module popup** (results column), not the Layers panel, for now. The Layers panel keeps its standard role: visibility, opacity, ordering. Phase 3 includes an *evaluation item* (not a build item) on promoting ramp/classification to a generic Layers-panel styling affordance.
- **Choropleth colors show whole-geography values.** When "Apportion by area" is on, each geography is colored by its own full ACS value, drawn clipped to the buffer as today. The hover popup *additionally* shows the apportioned share (value × overlap fraction) so the summary-table math stays traceable. Rationale: rates, medians, and densities are only valid on whole-geography values, and a big geography barely clipped by the buffer must not read as "low population."
- **TAZ / custom geographies got their own module, tracked outside this plan** — "Imported Geography Analysis," not an extension of Feature Area Analysis. **GeoJSON import only** (no shapefile dependency); the UI documents free conversion via mapshaper.org / QGIS. See `features.md`'s entry of the same name for the full scope (it was originally drafted here as "Phase 4").

## Recommendations adopted (flagged for the record — easy to revisit)

- **The gray `census-geos` overlay is hidden while the Feature Area Analysis choropleth is active** and restored when the choropleth is cleared/hidden. Two polygon layers over the same geographies would visually fight.
- **Session persistence stays settings-only.** Feature Area Analysis already persists only settings (results require re-run after restore); the choropleth follows the same rule — the map-variable and style settings persist, geometry does not, restored sessions re-run to regenerate the map. Matches the Transit Coverage / Transit Travelshed precedent.
- **Feature Area Analysis adopts the standard stale pattern in Phase 1.** Today its `update()` is a no-op and the popup has no status pill. With a persistent map layer, stale results become visible artifacts, so the module gets the standard `App.renderModuleState()` stale banner + Re-run wiring (a `#basStatus` element is added to the popup).
- **Overlap fractions are computed once per run** via a new optional path in the aggregation code (see Step 1.2) instead of per-variable. This is required to show apportioned shares in the hover popup, and incidentally removes today's repeated `turf.intersect` work per variable. The numeric results must be identical (guarded by an unchanged golden run — see each phase's verification).
- **Tract-only fallback variables** (e.g. LEP at block-group level) are mappable: when the selected map variable used the tract fallback, the choropleth renders on the tract geometries already fetched for the fallback, and the map-variable dropdown annotates the entry "(tract level)."
- **LODES is excluded from the map-variable dropdown in Phase 1**, added in Phase 2 via block→geography rollup (reusing `TPI.aggregateLodesToGeo`).

## Verified reference points

Line numbers verified against the tree at the time of writing; re-verify before editing (the implementing model should search by the quoted names, not trust raw numbers).

**Feature Area Analysis internals (`js/projects/buffer-summary.js`)**

- Per-variable fetch + aggregate loop: `:414-461`. Value maps: `App.fetchACSValues` / `App.fetchACSMultiValues` → `Map<GEOID, value>`; ratio vars fetch numerator + denominator maps (`:441-446`); aggregation via `App.aggregateWithinUnion(...)` (`:443-454`).
- Tract fallback: `useTractFallback` (`:417`), `tractGeosForFallback` fetched once (`:425-432`).
- Geometry fetch + gray overlay: `App.fetchTigerwebGeos` (`:384`), clipped-display pass + `App.renderCensusOverlay` (`:388-403`).
- `MANDATORY_VARS` (`:29`) — always-fetched denominators (`B01003_001E` total population among them), already available per-geography for percent math.
- Results state: `resultsMap` (union-level values, `:300`), `_hasResults` (`:23`), notes footer (`:524-542`).
- Module registration `:609-729` (no `clear` hook today; `update()` is a no-op `:723-728`). Cache registration `:733-759` (settings-only; no schema version field — additive fields default gracefully, per the repo's RF `baselineUncertaintyPct` precedent).
- Popup markup: `projects/buffer-summary-popup.html` — settings col groups `selection`/`geography`/`analysis`/`variables`, results col has `#basResultsProgress`, `#basResultsTable`, `#basResultsNotes`. **No status pill element exists yet.**

**Aggregation + overlay core (`js/core/census.js`)**

- `renderCensusOverlay(geos)` / `clearCensusOverlay()`: `:21-56` (`census-geos` source, `census-geos-fill`/`-line` layers, inserted below `buffers-fill`).
- `aggregateWithinUnion(unionFeat, geos, valueMap, aggMode, options)`: `:322-360` — computes per-geo overlap `frac` internally (apportioned: `turf.intersect` area ratio; else 0/1 via `booleanIntersects`) and discards it.

**The pattern being generalized (`js/projects/transit-propensity.js`)**

- Source/layer ids + `renderChoropleth(result)`: `:662-778` — clipped-geometry lookup (`:670-678`), feature build with score + stringified per-geo payload (`:680-697`), color expression (`:701-709`), layer insertion below `buffers-fill` (`:714-728`), hover popup with per-factor detail (`:731-767`), `setData` on re-render (`:770`).
- `removeChoropleth()` / `clearChoropleth()`: `:780-800`. Legend widget open/hide: `:613-616`, `:792`, restore path `:1248-1252`.
- `TPI.computeQuintiles(values)` exists in `tpi-scoring.js` (rank-based quintiles) — related but **not** what Phase 1 uses; class breaks for arbitrary values need a value-quantile helper (Step 1.1).

**The other two copies to be migrated (Phase 3)**

- RF: `RF_SOURCE`/`RF_FILL_LAYER`/`RF_LINE_LAYER` + `renderChoropleth` at `ridership-forecasting.js:737-744`, `removeChoropleth` `:895-900`.
- Corridor Scoring: `CS_SOURCE`/`CS_LINE_LAYER` + `renderMapChoropleth` at `corridor-scoring.js:446-478`, `clearMapChoropleth` `:528` — a **line** layer colored by CDI, so migration uses only the helper's break/color-expression/legend pieces, not its polygon source management.

**Surrounding integration surfaces**

- Layers panel `ANALYSIS` manifest: `js/core/layers-panel.js:49-82` (declarative entries keyed by layer id; entries render only when present). `census-geos-fill` is listed in the `REFERENCE` band `:79-81`.
- Floating legend widgets: `App.popup.showFloatingWidget(id, htmlFile, { position, width, title })` / `hideFloatingWidget(id)`; the fill-labels-after-mount pattern is `projects/transit-travelshed-legend.html` (module fills `#tsLegendLabel0..2` at runtime). Static-swatch markup precedent: `projects/tpi-legend.html` (`.tpi-legend-panel/-row/-swatch` classes).
- Analysis menu grouping: `buildAnalysisButtonsHTML()` in `js/app.js` — Feature Area Analysis + Walkshed are in **General**, all other non-system modules alphabetize into **Transit Planning**. Phase 4's new module must be added to the General list there.
- Value formatting: `App.formatValue(val, meta)` + `App.getMeta(code)` (`js/core/utils.js`); percent denominators via `App.getDenominator(code)`.
- Golden harness: `node test/run-golden.mjs`; case files in `test/cases/*.mjs` load engine files directly with a `__MAT_TEST__` guard where needed; new pure-math modules get a new case file (`test/README.md`).
- UI regression harness: `test/ui-screens/capture.mjs` — must be run and inspected after popup-markup/shared-CSS changes.

---

# Phase 1 — Choropleth MVP

Deliverable: after Calculate Summary, a "Map by geography" dropdown appears in the results column; picking a variable renders a 5-class quantile Blues choropleth with a labeled floating legend and per-geography hover popups. Layers panel gains the entry; stale/clear behave like the rest of the suite. No new fetches, no change to any computed number.

### Step 1.1 — Shared helper `js/core/choropleth.js`

**Files:** create `js/core/choropleth.js`; edit `index.html` (script tag in the core block, after `module-buffers.js`, before `app.js`); create `projects/choropleth-legend.html`.

Plain IIFE assigning onto `App.choropleth`. Depends on `maplibregl` (implicitly, via `App.map`) and the DOM only inside the render/hover functions; the classification math is pure and exported for the golden harness.

**Pure functions (no DOM, no map — golden-testable):**

```js
App.choropleth.RAMPS = {
  blues: { label: "Blues",           colors5: ["#eff3ff","#bdd7e7","#6baed6","#3182bd","#08519c"] },
  heat:  { label: "Heat (Yl-Or-Rd)", colors5: ["#ffffb2","#fecc5c","#fd8d3c","#f03b20","#bd0026"] },
  greens:{ label: "Greens",          colors5: ["#edf8e9","#bae4b3","#74c476","#31a354","#006d2c"] },
  rdbu:  { label: "Diverging (Rd-Bu)", colors5: ["#ca0020","#f4a582","#f7f7f7","#92c5de","#0571b0"] }
};
```

- `computeClassBreaks(values, method, nClasses)` → `{ breaks, nEffective }`. `values`: array of finite numbers (caller pre-filters null/NaN). `method`: `"quantile"` (Phase 1) or `"equal"` (Phase 3; implement both now — it is ~10 lines and the golden case pins it). Returns `nClasses - 1` **inner** break values (class *i* is `break[i-1] < v ≤ break[i]`). Degenerate handling is part of the contract: duplicate quantile breaks are deduplicated (heavily tied data yields `nEffective < nClasses`); all-equal values yield `breaks: []`, `nEffective: 1`; empty input yields `breaks: []`, `nEffective: 0`.
- `buildStepColorExpr(prop, breaks, colors, noDataColor)` → a MapLibre `["step", ["get", prop], ...]` expression wrapped so `null`/missing renders `noDataColor` (`"rgba(200,200,200,0.35)"`): use `["case", ["==", ["typeof", ["get", prop]], "number"], stepExpr, noDataColor]`. Colors array is sliced from a ramp's `colors5` to match `nEffective` (take evenly spaced entries when fewer classes than 5).
- `formatBreakLabels(breaks, min, max, fmt)` → array of `nEffective` strings, lowest class first, e.g. `"1,204 – 2,410"`; `fmt` is a `(number) => string` callback (Feature Area Analysis passes a wrapper around `App.formatValue`).

**Map-facing instance API (keyed by id — multiple modules may have live choropleths):**

- `App.choropleth.render(opts)` where `opts = { id, features, valueProp, method, classes, ramp, breaks (optional — manual/fixed overrides method), beforeLayer, fillOpacity (default 0.55), lineColor/lineWidth/lineOpacity (TPI-style defaults), hoverHTML (fn(props) → html string, or null for no hover), noDataColor }`. Creates or updates source `"<id>-choropleth"` and layers `"<id>-choropleth-fill"` / `"<id>-choropleth-line"` (create-once/`setData`-after, exactly the TPI pattern including the `buffers-fill` insertion default and the shared hover `maplibregl.Popup` with cursor management copied from `transit-propensity.js:731-767`). Returns `{ breaks, colors, nEffective, min, max }` so the caller can fill its legend.
- `App.choropleth.remove(id)` — removes both layers + source (idempotent).
- `App.choropleth.setVisible(id, bool)` — layout-visibility toggle for "hide choropleth" checkboxes.

**Generic legend fragment** `projects/choropleth-legend.html`: a `.tpi-legend-panel` shell with 5 pre-built rows (`#clLegendRow<id? no — widget HTML is per-widget-instance>`). Because `showFloatingWidget` loads one HTML file per widget id, the fragment uses classed placeholders (`.cl-legend-row`, `.cl-legend-swatch`, `.cl-legend-label`, plus a `.cl-legend-title` line and `.cl-legend-note`), and the helper exports `App.choropleth.fillLegend(containerEl, { title, labels, colors, note })` which the module calls after the widget mounts (the Transit Travelshed fill-after-mount precedent). Unused rows are hidden.

**Verification:** golden case in Step 1.6 passes; no UI change yet.

### Step 1.2 — Expose per-geography overlap fractions (`js/core/census.js`)

**Files:** edit `js/core/census.js`.

Add `App.computeGeoOverlapFractions(unionFeat, geos, apportionByArea)` → `Map<GEOID, frac>` containing exactly the `frac` logic currently inlined in `aggregateWithinUnion` (`census.js:335-349`), including the try/catch skips (a skipped geo is simply absent from the map). Then give `aggregateWithinUnion` an optional `options.fractions` (a precomputed map); when present it uses `fractions.get(geoid)` (absent → skip the geo) instead of recomputing. **Backward compatible: with no `options.fractions`, behavior is byte-identical to today.**

`runSummary()` computes the fraction map once after the geometry fetch (and a second map for `tractGeosForFallback` on first fallback use) and passes it to every `aggregateWithinUnion` call. The maps are retained for the hover popup (Step 1.3).

**Verification:** `node test/run-golden.mjs` → all pass unchanged (no golden case covers this turf path, but run it anyway per convention). Manual check: a summary run before/after this step produces identical table values.

### Step 1.3 — Retain per-geography results in `runSummary()` (`js/projects/buffer-summary.js`)

**Files:** edit `js/projects/buffer-summary.js`.

Add a closure variable `_lastGeoData` (null until a successful run), populated during the existing loop with **no additional fetches**:

```js
_lastGeoData = {
  geoLevel, year, apportionByArea,
  geos,                    // full TIGERweb features (bg or tract per geoLevel)
  clippedGeos,             // the clipped-for-display set when apportioned (already built, :388-399 — lift it out of the if-block into a variable)
  fractions,               // Map<GEOID, frac> from Step 1.2
  tractGeos,               // tractGeosForFallback or null
  tractFractions,          // Map or null
  displayVars,             // user-checked codes, table order
  perGeo: {                // varCode → { level: "geo"|"tract", values: Map<GEOID, number> }
    /* for plain vars: the fetched valueMap as-is.
       for multi-code vars (meta.codes): the summed map fetchACSMultiValues returned.
       for ratio vars: a derived map — per geoid, num/den where den > 0, else null.
       ratio vars ALSO stash numerator/denominator maps under
       perGeoParts[varCode] = { num, den } for the hover popup. */
  },
  perGeoParts: {},
  denomVars: {}            // varCode → denominator spec resolved via App.getDenominator (for hover %)
};
```

Also retain the mandatory-var maps (they are fetched in the same loop; keep them in `perGeo` keyed by code even when not displayed — the hover percent math needs them).

Reset `_lastGeoData = null` at the top of `runSummary()` and in the new clear path (Step 1.5). Memory note: tens-to-hundreds of geographies × ~a dozen Maps of numbers — negligible; the geometry (`geos`) is the same array already held for the map overlay today.

**Verification:** run a summary; in the console, `App`-internal state isn't exposed — verify indirectly in Step 1.4 (dropdown populates, choropleth renders).

### Step 1.4 — Map-variable dropdown, choropleth render, hover, legend

**Files:** edit `js/projects/buffer-summary.js`, `projects/buffer-summary-popup.html`, `css/style.css` (only if a new class is truly needed — prefer existing `.rf-*`/`.form-field` primitives).

**Markup** (results column, between `#basResultsProgress` and the table): a `#basMapRow` block, hidden until a run succeeds:

```html
<div id="basMapRow" class="form-field" style="display:none;">
  <label class="tiny">Map by geography</label>
  <select id="basMapVar" class="rf-select"></select>
  <label class="tpi-toggle-row u-mt-2">
    <input type="checkbox" id="basHideChoropleth">
    <span class="tiny">Hide choropleth</span>
  </label>
</div>
```

**Dropdown population** (after a successful run): first option `"— None (gray outline) —"` (value `""`), then one option per `displayVars` entry that has a `perGeo` map, labeled with `meta.label`, with `" (tract level)"` appended when that entry's `level === "tract"`. LODES codes are skipped in Phase 1. The previous selection is preserved across re-runs when the variable is still present.

**`renderBasChoropleth(varCode)`** (new internal function):

- `varCode === ""` → `App.choropleth.remove("bas")`, hide the legend widget, re-show the gray overlay (call `App.renderCensusOverlay` with the same clipped-or-not set the run used), return.
- Otherwise: pick geometry set — `level === "tract"` ? `_lastGeoData.tractGeos` : (apportioned ? `clippedGeos` : `geos`); **values are always the whole-geography values** from `perGeo` (the settled decision — clipped geometry, uncut values). Build features `{ GEOID, value, ...hover payload props }`; the hover payload embeds, per the TPI stringify pattern, a compact JSON of `{ varLabel, value, frac, apportioned: value*frac (only when apportionByArea), pct (value/denomValue*100 when a denominator resolves per-geo), others: [{label, value} for every other displayVar's per-geo value at this GEOID] }` — this makes the popup show *all* selected variables for the hovered geography, your item (3).
- Call `App.choropleth.render({ id: "bas", method: "quantile", classes: 5, ramp: "blues", valueProp: "value", hoverHTML: basHoverHTML, beforeLayer: "buffers-fill" })`; then `App.renderCensusOverlay`-**clear**: call the existing `clearCensusOverlay` path (export it from census.js if not already on `App` — check; if only internal, add `App.clearCensusOverlay = clearCensusOverlay`) so the gray layer doesn't sit under the choropleth.
- Show legend: `App.popup.showFloatingWidget("bas-legend", "projects/choropleth-legend.html", { position: "bottom-left", width: 190, title: "Map Legend" })`, then `App.choropleth.fillLegend(...)` with `title = meta.label`, labels from `formatBreakLabels(breaks, min, max, v => App.formatValue(v, meta))`, and `note = "Classes: quantile (5). Values are whole-geography estimates."`

**Hover popup (`basHoverHTML(props)`):** GEOID line, bold selected-variable line (`label: formatted value`, plus `· pct%` when available, plus `· apportioned share: X` when apportionByArea), then a muted list of the other selected variables' values (TPI's factor-list styling, `transit-propensity.js:740-759`). Cap the "others" list at 10 entries + "… N more" to keep the popup sane when many variables are checked.

**Wiring:** `#basMapVar` change → `renderBasChoropleth(value)`; `#basHideChoropleth` change → `App.choropleth.setVisible("bas", !checked)` and hide/show the legend widget (TPI's `tpiHideChoropleth` precedent, `transit-propensity.js:1044-1045`). At the end of a successful `runSummary()`, populate the dropdown and re-render the choropleth if a variable was selected (auto-select nothing on first run — the gray overlay remains the default until the user picks a variable; least surprising, zero behavior change for existing users).

**Verification:** manual — draw a route, run with several variables (include a median ⚠ var and % vars), pick each map variable, check legend labels match hover values, toggle apportionment and confirm colors don't change (whole-geo values) while clipping does, check tract-fallback var renders on tracts.

### Step 1.5 — Lifecycle: stale, clear, Layers panel, persistence

**Files:** edit `js/projects/buffer-summary.js`, `projects/buffer-summary-popup.html`, `js/core/layers-panel.js`.

- **Status pill:** add `<div id="basStatus" class="rf-status" style="display:none;"></div>` at the top of the results column. Add the standard thin `setStatus(msg, kind)`/`showStale()` delegating to `App.renderModuleState({ statusEl: "basStatus", ... , stale, onRerun: runSummary })`.
- **Stale:** in the module's `update()` hook, when `_hasResults` and features/walksheds change (the hook already fires on `App.notifyProject()`), set `_stale = true` and show the banner. Do **not** auto-clear the map — stale-but-visible with a banner is the suite convention.
- **Clear:** register a `clear` lifecycle hook (Corridor Scoring precedent) that removes the choropleth (`App.choropleth.remove("bas")`), hides `bas-legend`, clears `_lastGeoData`/`_hasResults`/`_stale`, resets `#basMapRow`, and calls `App.clearCensusOverlay`. Session reset must leave no orphan layers.
- **Layers panel:** add to the `ANALYSIS` manifest (`layers-panel.js:49`):
  ```js
  { id: "bas-choropleth-fill", label: "Feature Area Analysis", moduleId: "buffer-summary",
    layers: [{ id: "bas-choropleth-fill", op: "fill-opacity" }, { id: "bas-choropleth-line", op: "line-opacity" }] },
  ```
- **Persistence:** additive fields in the existing cache `collect`/`apply` (no schema bump, RF `baselineUncertaintyPct` precedent): `mapVar` (string, `""` = none). Geometry/results are not persisted; on restore the dropdown selection is remembered but the map stays empty until Re-run (matches how the results table already behaves).

**Verification:** run → choropleth on; Layers tab shows the entry with working show/hide + opacity; draw a new point → stale banner with working Re-run; Reset Session → no layers/legend remain; reload → settings restored, map empty until re-run.

### Step 1.6 — Golden case + docs

**Files:** create `test/cases/choropleth.mjs`, run `node test/run-golden.mjs --update` to seed `test/golden/choropleth.json`; edit `CLAUDE.md`.

The case file loads `js/core/choropleth.js` directly (it must therefore guard its map-facing functions so a missing `App.map`/`maplibregl` at load time is fine — pure functions only are exercised; follow the `__MAT_TEST__` export-hook pattern only if the pure functions aren't already public, which they are). Pin: `computeClassBreaks` on a clean spread (quantile + equal), a heavily tied array (dedup → `nEffective < 5`), all-equal, single value, empty; `buildStepColorExpr` output structure for 5 and 3 classes; `formatBreakLabels` with a fixed `fmt`.

CLAUDE.md updates (same commit): File Structure entries for `js/core/choropleth.js` + `projects/choropleth-legend.html`; buffer-summary entry gains the choropleth description; Script Load Order; layers-panel `ANALYSIS` note; the census.js API list gains `computeGeoOverlapFractions` (+ `clearCensusOverlay` if newly exported); Testing section gains the choropleth golden case; "Covered engines" list.

Run `test/ui-screens/capture.mjs` and inspect the Feature Area Analysis panel captures (markup changed).

**Commit message:** notes `Verified: node test/run-golden.mjs → N/N` per convention.

---

# Phase 2 — Analysis depth: per-geography export, normalization, LODES

Deliverable: per-geography CSV export; "Shade by" normalization (count / percent / density); LODES jobs mappable per geography.

### Step 2.1 — Per-geography CSV export

**Files:** edit `js/projects/buffer-summary.js`, `projects/buffer-summary-popup.html`.

An "Export by geography (CSV)" button next to the map row, enabled when `_lastGeoData` exists. One row per geography (union of bg-level GEOIDs; tract-fallback variables emit into their own trailing columns with a `(tract)` header suffix and values repeated per child block group via GEOID-prefix match — the same parent-tract slicing TPI's static fallback uses). Columns: `GEOID`, `geoLevel`, `overlap_fraction` (from `fractions`, 4 decimals), then per displayVar: raw value, `<var>_pct` where a denominator resolves, and `<var>_apportioned` (`value × frac`) when the run was apportioned. Standard blob-download pattern (copy any module's `exportCSV`). Filename `feature-area-by-geography_<timestamp>.csv`.

### Step 2.2 — Normalization ("Shade by")

**Files:** edit `js/projects/buffer-summary.js`, `projects/buffer-summary-popup.html`.

A second select in `#basMapRow`: `Shade by` → `Count (raw value)` (default) / `Percent of denominator` / `Density (per sq mi)`.

- **Percent**: per-geo `value / denom × 100`, where denom resolves via `App.getDenominator(varCode)` against the retained mandatory/denominator maps (`$group` sums the retained group-member maps — they're only retained if fetched, so the option is disabled with a title tooltip when any needed member map is missing). Disabled for ratio/avg variables (already rates).
- **Density**: `value / turf.area(geo)` converted to mi², using the **whole** geography's area (consistent with whole-geo values; note this in the legend note). Cache areas per GEOID on first use in `_lastGeoData.areas`.
- The choropleth re-classifies on the derived values (breaks recomputed); legend title becomes e.g. "Population — density (per mi²)" and labels format with 1 decimal. Hover shows raw + derived.
- Persist the choice (`mapNorm`, additive field).

### Step 2.3 — LODES per geography

**Files:** edit `js/projects/buffer-summary.js`.

When a LODES variable was selected and `App.lodesData` is loaded, build its per-geo map at run time: reuse **`TPI.aggregateLodesToGeo(lodesData, geoLevel, geoids)`** (`tpi-scoring.js` — block GEOID prefix rollup to bg/tract) instead of new math; store in `perGeo` like any ACS map, marked `source: "LODES"` so hover/legend note "whole-block rollup; area apportionment not applied." The union-level summary number keeps using the existing internal-points path — the two methods can differ slightly at buffer edges; the results-notes footer gains one sentence saying so. LODES entries then appear in the map dropdown and the CSV. Guard: `window.TPI` may be absent if module script order ever changes — feature-detect and skip with a console warn (TPI loads before buffer-summary today; verify in `index.html`).

### Step 2.4 — Docs + verification

CLAUDE.md updates; `node test/run-golden.mjs` (should be untouched); ui-screens capture (markup changed); manual QA checklist mirroring Phase 1's, plus: percent map of a `$group` variable, density map sanity (urban core dark), LODES map with/without file loaded.

---

# Phase 3 — Styling controls & suite-wide migration

Deliverable: ramp + classification controls in the Feature Area Analysis popup; TPI, RF, and Corridor Scoring render through `App.choropleth`; one evaluation memo on Layers-panel styling.

### Step 3.1 — Style controls in Feature Area Analysis

**Files:** edit `js/projects/buffer-summary.js`, `projects/buffer-summary-popup.html`.

Two more selects in `#basMapRow`: `Color ramp` (from `App.choropleth.RAMPS`, default Blues; the diverging RdBu option is annotated "best for percent/deviation") and `Classes` → `5-class quantile` (default) / `5-class equal interval` / `Continuous` (the TPI-style `interpolate` expression — the helper gains `method: "continuous"`, which builds an interpolate expression across min→max using the ramp's endpoints + midpoints and returns `breaks: []` with a min/max legend). Persist both (`mapRamp`, `mapClasses`, additive). Legend note reflects the active method.

### Step 3.2 — Migrate TPI

**Files:** edit `js/projects/transit-propensity.js`.

Replace the body of `renderChoropleth` (`:666-778`) with: build the same feature array (unchanged payload), then `App.choropleth.render({ id: "tpi", valueProp: "tpiScore", breaks: [1,2,3,4], colors: RAMPS.blues.colors5, hoverHTML: <current hover body extracted into a function>, fillOpacity: 0.55 })` — **manual breaks reproduce today's visual classing of the 1–5 score**; pixel-for-pixel parity with the old continuous ramp is NOT required, but class colors at integer scores must match the legend. **Layer ids must not change** (`tpi-choropleth-fill`/`-line` are load-bearing: Layers-panel manifest, `removeChoropleth`, ui-screens) — so `App.choropleth.render` must accept `id: "tpi"` yielding exactly those ids (it does, by the `<id>-choropleth-*` convention). `removeChoropleth` becomes `App.choropleth.remove("tpi")`. The static `tpi-legend.html` stays as-is (scores are fixed 1–5; no dynamic labels needed). Delete the now-dead local hover/source code.

### Step 3.3 — Migrate RF

**Files:** edit `js/projects/ridership-forecasting.js`.

Same treatment for `renderChoropleth`/`removeChoropleth` (`:744`, `:895`) with `id: "rf"` → preserves `rf-choropleth-fill`/`-line`. The extra `rf-corridor-cdi-layer` segment layer is untouched (not a polygon choropleth). Static `ridership-legend.html` stays.

### Step 3.4 — Migrate Corridor Scoring (partial by design)

**Files:** edit `js/projects/corridor-scoring.js`.

CS renders a **line** layer (`:446-478`); the helper's polygon source management does not apply. Migrate only the color logic: replace the inline 5-class Blues interpolation with `App.choropleth.buildStepColorExpr` (or the continuous builder) fed by CS's fixed CDI breaks, so the ramp definition has one home. Layer/source ids and everything else unchanged.

### Step 3.5 — Layers-panel styling evaluation (memo, not code)

Write `docs/layers-panel-styling-eval.md` (one page): now that every choropleth flows through one helper with a serializable style spec (`ramp`, `method`, `classes`), assess adding a generic "style…" affordance to Layers-panel `ANALYSIS` entries that reads/writes each module's spec. Recommend go/no-go + rough scope. **No implementation in this phase.**

### Step 3.6 — Docs + verification

CLAUDE.md: TPI/RF/CS entries note the shared renderer; choropleth.js entry gains the new methods. Extend `test/cases/choropleth.mjs` with the continuous-expression builder and manual-breaks path; `--update` and commit goldens with the code. Run ui-screens and **diff the TPI and RF panel/map captures against baseline** — this is the regression gate for the migrations. Manual QA: run TPI and RF end-to-end (scores, hover factor lists, legend, hide-toggle, session restore of a choropleth via full-file import for TPI).

---

## Out of scope (all phases)

- Custom/multi-stop color gradients and per-class color overrides (settled: curated presets only).
- A per-geography results *table* inside the popup (hover + CSV cover it; revisit if users ask).
- Diverging-ramp midpoint anchoring (RdBu classes are computed like any ramp; true zero-anchored diverging classification is a later refinement).
- Layers-panel styling implementation (Step 3.5 is an evaluation memo only).
- Changing any aggregation math, golden-pinned number, or the summary table's behavior.
- A TAZ/custom-geography import module — scoped separately, see `features.md`'s "Imported Geography Analysis module" entry.

## Phase/commit conventions

One commit per step minimum, message noting the step (e.g. `Phase 1 Step 1.4: FAA choropleth render + hover + legend`), with `Verified: node test/run-golden.mjs → N/N` whenever the harness ran. CLAUDE.md is updated **in the same commit** as the change it documents (repo convention). Run `test/ui-screens/capture.mjs` after every step that touches popup markup or shared CSS and inspect the images.

## Handoff

All three phases in this document are complete. This section is retained for historical
reference (how the work was actually sequenced) rather than as a live instruction set.
Each phase ran as its own implementation session (Phase 3 split into two: 3.1 alone, then
3.2–3.4 together since they shared the migration mindset), with the implementing model
given this file plus the instruction to re-verify every cited line number by searching
for the quoted symbol names before editing rather than trusting the doc's own numbers.
The follow-on TAZ/imported-geography module (formerly drafted here as "Phase 4") is now a
standalone `features.md` entry, to be planned and scoped fresh whenever it's picked up
rather than inheriting this plan's phase numbering.
