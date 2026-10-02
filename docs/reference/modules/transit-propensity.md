# Transit propensity

Reference detail moved verbatim from `CLAUDE.md`. Read the code when this and the code disagree.

## Files

- **`tpi-scoring.js`** — TPI scoring engine: 9-factor definitions, batch ACS fetch, LODES aggregation, quintile normalization, composite scoring

- **`transit-propensity.js`** — TPI module: popup-based 2-column UI (Settings | Results), weights modal overlay, buffer distance (mi, default 0.5 — module-owned analysis distance via `js/core/module-buffers.js`, independent of the Feature Settings global buffer radius; applies to routes/lines/circular-buffer points, preserves walkshed-flagged points' cached walkshed, leaves drawn polygons unbuffered), feature checklist (normalization pool), analysis corridor dropdown, scrollable geography list with expandable factor breakdowns, choropleth rendering, hover tooltips, floating legend (auto-shown on run), GeoJSON/CSV export, stale detection. **Choropleth rendering (Phase 3 Step 3.2 of `docs/feature-area-choropleth-plan.md`):** `renderChoropleth()`/`removeChoropleth()` delegate to `App.choropleth.render({id: "tpi", ...})`/`App.choropleth.remove("tpi")` — manual `breaks: [1,2,3,4]` on the `"blues"` ramp reproduce the same 5 colors the old inline continuous interpolate used at integer scores, now as discrete classes (pixel-for-pixel parity with the old gradient was explicitly not required); a null/non-numeric score now renders the shared engine's no-data gray via its `typeof` guard rather than the old coalesce-to-0-then-gray trick. Layer/source ids are unchanged (`tpi-choropleth-fill`/`-line`/`tpi-choropleth`, reproduced automatically by the `"<id>-choropleth-*"` convention) since the Layers-panel manifest and ui-screens both depend on them. The hover-popup body moved into a standalone `tpiHoverHTML(props)` passed as `App.choropleth.render()`'s `hoverHTML` callback. The static `tpi-legend.html` is untouched (fixed 1–5 scale, no dynamic labels).

- **`transit-propensity-popup.html`** — TPI popup body: 2-column layout (Settings | Results); Settings column has geography/year selectors, apportion toggle, feature checklist (normalization pool), analysis corridor dropdown, Adjust Weights button (opens modal overlay with 9 factor sliders + Confirm/Cancel/Reset), Analyze System button; Results column has scrollable geography list with expandable per-geo factor breakdowns, summary stats, export buttons; LODES warning icon (⚠) next to ACS Year selector

- **`transit-propensity.html`** — TPI sidebar panel (legacy, replaced by popup version)

- **`tpi-weights.html`** — TPI weight sliders (legacy, merged into popup)

- **`tpi-legend.html`** — TPI legend: 5-class Blues color swatches (reused by floating widget)

## API

### API — tpi-scoring.js (window.TPI namespace, not on App)
`TPI.FACTORS` (9-factor array with id, label, weight, acsCodes, compute functions), `TPI.batchFetchACS(geoLevel, year, geoids)`, `TPI.aggregateLodesToGeo(lodesData, geoLevel, geoids)`, `TPI.computeQuintiles(values)`, `TPI.computeComposite(factorScores, weights)`, `TPI.computeTPI(options)` (full pipeline: fetch → normalize → score; accepts optional `options.unionPolygon` to restrict the study area instead of using `App.bufferUnionPolygon()`), `TPI.rescoreFromRaw(rawValues, weights, geoids)` (instant re-score from cached data)

**Default factor weights** (sum = 100): Population Density 35, Employment Density 35, Zero-Vehicle HH 5, Low-Income % 5, Senior 65+ % 5, Disability % 5, Minority % 5, Youth <18% 0, LEP % 5. These are shared defaults for both TPI and RF modules (each module stores its own independent copy in `_weights`).

**Tract-level fallbacks** (within `TPI.computeTPI()`): When `geoLevel === "bg"` and `apportionByArea` is false, TPI runs two fallback passes: (1) *static* — factors flagged `tractOnly: true` (currently only LEP / C16001) are always fetched at tract level and mapped down to block groups via parent-tract GEOID slicing; (2) *dynamic* — after computing raw values, any ACS factor that produced zero finite values at BG level is automatically re-fetched at tract level and remapped. Both fallbacks are skipped when `apportionByArea: true`. All downstream modules (RF included) benefit automatically since they delegate to `TPI.computeTPI()`.

### API — transit-propensity.js (analysis module)
Registers module `"transit-propensity"` as a popup-based analysis. Opens in a 2-column popup (960px wide): left Settings column (240px fixed) and right Results column (flex). All state is private to the IIFE closure. DOM writes are guarded with `isPopupVisible()` so `update()` can safely fire when the popup is closed. LODES warning icon (`#tpiLodesWarnBtn`, ⚠ button) shows/hides next to the ACS Year selector: shown when `App.lodesData` is null (Employment factor excluded), hidden when LODES is loaded. Visibility updated in `onOpen()` and `update()`.

**Settings column (left):** Geography level dropdown, ACS Year selector (with LODES warning), apportion-by-area toggle, **TPI Features checklist** (checkboxes to select which routes/lines define the normalization pool — only selected features' union polygon is used for quintile computation), **Analysis Corridor dropdown** (filters the geography list display to a specific route/line without re-running the computation), **"Adjust Weights" button** (opens a modal overlay with 9 factor weight sliders; Confirm copies `_pendingWeights` → `_weights` and triggers instant rescore, Cancel discards, Reset to Defaults restores default weights), and "Analyze System" button.

**Results column (right):** Status indicator, scrollable geography list (each row shows geo GEOID + composite TPI score; click to expand and see per-factor quintile bars), aggregate TPI Score for the selected corridor, summary stats (geographies scored, factors included), footnotes (LODES status, apportion mode), GeoJSON and CSV export buttons. Legend auto-shows on the map when analysis runs (no manual "Show Legend" button).

**Internal functions:** `runTPI()`, `runInstantRescore()`, `renderChoropleth(result)`, `clearChoropleth()`, `displayGeographyList(result)`, `updateSummaryStats()`, `updateFootnotes()`, `updateExportButtons()`, `exportGeoJSON()`, `exportCSV()`, `markStale()`, `buildFeatureChecklist()`, `buildCorridorDropdown()`, `getFeatureFilter()`, `buildUnionFromFilter()`, `getGeosInCorridor()`, `openWeightsModal()`, `closeWeightsModal()`, `resetModalToDefaults()`, `syncSlidersToWeights()`, `onModalSliderChange()`, `onModalNumberChange()`, `updateModalWeightSum()`.

**Module-local state:** `_uncheckedRefs` (the normalization-pool checklist remembered as the features the user UNCHECKED, by stable `{type, id}` ref — new features default to checked; updated only by the checkbox handlers via `captureChecklistSelection()`, so a rebuild or restore never reads stale DOM), `_selectedCorridor` ("all" or `"route:<id>"`/`"line:<id>"`/… — a stable feature ID, NOT an array index; the dropdown option values use the same `featureRefKey` form and `result.bufferByRef` maps those keys to the run's buffers so `getGeosInCorridor()` never depends on array positions), `_pendingWeights` (temporary copy while weights modal is open), `_weights`, `_lastResult`, `_stale`, `_running`, `_initialized`, `_apportionByArea`.

**Public API (on `App`):** `App.getTpiWeights()` — returns a shallow copy of TPI's current `_weights` object. Used by the RF module's "Copy From TPI" button to read TPI's live weight settings without tight coupling.
