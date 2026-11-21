# Feature area analysis

Reference for changing Feature Area Analysis (`js/projects/buffer-summary.js`, popup `projects/buffer-summary-popup.html`). Read the code when this and the code disagree. Choropleth design: `docs/archive/feature-area-choropleth-plan.md`.

## buffer-summary.js (module `"buffer-summary"`)

ACS/LODES summary over a points/lines/routes/polygons checklist: `MANDATORY_VARS`, `expandGroups`, `runSummary`, `buildVarChecklistHTML`. Uses a 0.5-mi module analysis distance or (Use Display Buffers) the selected displayed buffers; polygons pass through unbuffered.

**Feature selection by stable ID.** `_state.featureFilter` is `null` (= all checked) or the CHECKED `{type, id}` refs (`getCheckedRefs()`); checkboxes carry `data-feature-id`. The run-time index filter (`getFeatureFilter()`) is rebuilt from the DOM at run time.

**Choropleth.** `runSummary()` keeps every fetched variable's per-geography values in `_lastGeoData.perGeo` (keyed by var code, `{level: "geo"|"tract", values: Map<GEOID, number>}`) plus geometry, overlap fractions and denominator specs — redisplay needs no further fetches. `#basMapVar` picks a variable; it renders via `App.choropleth.render({id: "bas", ...})` with a hover popup (`basHoverHTML`) and floating legend widget `"bas-legend"` (`projects/choropleth-legend.html`, filled by `App.choropleth.fillLegend`).
- Colors use **whole-geography values** on clipped geometry (settled decision: a large geography barely clipped by the buffer must not read as "low").
- `#basMapNorm` Shade by: Count / Percent (÷ `App.getDenominator(_mapVar)` per geo; disabled via `percentShadeAvailable()` when `agg:"avg"` or any denominator/`$group` member wasn't fetched) / Density (÷ whole-geo area mi², cached on `_lastGeoData.areas` by `"<level>:<GEOID>"`).
- `#basMapRamp` (mirrors `App.choropleth.RAMPS`) and `#basMapClasses` (quantile / equal / continuous). Continuous has no classes, so the legend uses `basLegendLabels()` (point values at the 5 gradient stops) instead of `App.choropleth.formatBreakLabels()`.
- `_mapVar`/`_mapNorm`/`_mapRamp`/`_mapClasses` are re-synced onto their `<select>`s at the top of `renderBasChoropleth()` because the popup DOM persists across close/open (`js/core/popup.js` `_loadedModules`).
- `#basHideChoropleth` toggles visibility; "None" removes the choropleth and restores the plain `census-geos` overlay.
- **LODES:** `runSummary()` also stores a per-geo rollup via `TPI.aggregateLodesToGeo(App.lodesData, geoids, geoLevel)` (feature-detected; warns and skips if `window.TPI` is missing), marked `source: "LODES"` — whole-block, not apportioned, and may differ slightly from the union-level LODES total at buffer edges (notes say so).

**Counting residents of partly covered geographies.** The "Apportion to buffer" checkbox (`#basApportionByArea`) plus the select beside it (`#basApportionMethod`) choose the method; `readApportionMethod()` turns them into `"blockPop"`, `"area"` or `"whole"` (checkbox off), kept in `_state.apportionMethod`.
- **By 2020 census-block population (default):** each geography contributes the share of its residents who live in census blocks whose internal point falls inside the study area, so a block group that is mostly empty land is not over-counted just because a lot of its area is covered.
- **By land area:** each geography contributes the share of its land area inside the study area (the old behavior).
- **Whole geographies (checkbox off):** any geography touching the study area counts in full; no block download happens.
- **Fallback:** if the census block service cannot be reached the run still succeeds using land area, and the results footer shows a warning line (and the CSV a `# ` comment) saying so. `_lastGeoData.methodUsed` / `.apportionNote` carry this; the footer sentence names `Apportion.methodLabel(methodUsed)`.
- Both fractions come from `App.computeApportionFractions` (the tract-fallback fractions use the same method) and are passed to every `aggregateWithinUnion` call. Re-running over the same area reuses the cached blocks. LODES "jobs inside" is unchanged.
- Saved sessions keep their method: `apportionMethod` is saved; older sessions have only `apportionByArea` (still written, = method is not `"whole"`) and load through `App.apportionMethodFromLegacy` (true becomes land area, false becomes whole).

**Export by geography** (`#basExportGeoCsv`, `exportByGeographyCSV()`): one row per base GEOID — `GEOID`, `geoLevel`, `overlap_fraction`, then per variable raw / `_pct` (when a denominator resolves) / `_apportioned` (when apportioned). Tract-fallback variables get `_tract` columns looked up via `geoid.slice(0,11)`, repeated across block groups in that tract. The file starts with `# Apportionment: <label>` (and a `# ` note line when the fallback applied) before the header row.

**State/lifecycle.** `#basStatus` via `App.renderModuleState`; features changing while results are shown give a stale-but-visible banner with Re-run (deliberately no auto-clear on feature deletion). The `clear` hook removes the choropleth, hides the legend and empties the census overlay so Clear/Reset leave no orphaned layers.

**Persistence** (`App.cache.registerModule("buffer-summary", ...)`): `schemaVersion: 2` + `featureRefs` (v1 `featureFilter` index filters migrate in `apply` via `App.indexFilterToRefs`); additive `mapVar`, `mapNorm`, `mapRamp`, `mapClasses`. Geometry/results are not persisted — the choropleth re-renders on the next Calculate Summary.
