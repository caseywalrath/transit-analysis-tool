# Comment Cleanup Findings

Doc/code disagreements found during docs/comment-cleanup-plan.md. **Bug?** entries need a user decision; **Info** entries were fixed in the docs.

## Phase 1 (CLAUDE.md and docs/reference)

- **Info** — CLAUDE.md (Known Issues) — doc said "See `REVIEW.md`"; the file is `docs/REVIEW.md`; path fixed.
- **Info** — CLAUDE.md (How to run with no modules) — doc said the core app does "ACS summaries" without modules; ACS summaries come from the Feature Area Analysis module (`js/projects/buffer-summary.js`); wording fixed.
- **Info** — CLAUDE.md (Script Load Order) — the old list omitted search, labels, textboxes, measure, osm, osm-pois, selection, undo, projections and service-assembly; the new list is taken from `index.html`.
- **Info** — CLAUDE.md (Conventions) — the CDN list omitted shapefile.js, which `index.html` loads; added.
- **Info** — CLAUDE.md (Common Issues) — the note that the legacy `CHECKBOX_GROUPS`/`DENOM_MAP` "were removed" was history; confirmed absent from `buffer-summary.js` and dropped.

- **Info** — docs/reference/core-app.md:148 — doc said renderModuleInputs is "Wired into walkshed, transit-coverage and transit-travelshed"; code also calls it from transit-propensity.js, corridor-scoring.js, buffer-summary.js, fta-small-starts.js; doc updated.
- **Info** — docs/reference/core-app.md:46 — doc said TPI, RF, Corridor Scoring, Transit Coverage, Feature Area Analysis "still store indices"; code has migrated them to stable-ID refs (e.g. transit-propensity.js schemaVersion 2, RF _schemaVersion 4); stale sentence removed.

- **Info** — docs/reference/drawing-and-features.md:83 (old) — doc said attr popup first opens at left 320px / top 60px; code (js/core/feature-attributes.js:1029-1030, 1340) docks at left 24px / top 60px; fixed doc.
- **Info** — docs/reference/drawing-and-features.md:21 (old) — doc said Layers drawer passes `includeBuffer: true` "until Phase 2"; no `includeBuffer` exists in js/; removed.
- **Info** — docs/reference/drawing-and-features.md:23 (old) — doc said `LINE_FIELDS` = `TRANSIT_FIELDS` + `networkRole` only; code (feature-attributes.js:61+) also appends the buffer field; fixed doc.
- **Info** — docs/reference/drawing-and-features.md:107 (old) — `App.buildOverrideIcons` no longer exists in js/ (doc already said retired); kept only as a "retired" note.

- **Info** — docs/reference/road-network.md:37 — doc said applyConnectorOverlay() uses "welding only — splitCrossings: false — until Phase 5"; code (js/core/road-network.js:268) passes splitCrossings: true; removed the stale claim, doc now states splitCrossings: true once.

- **Info** — docs/reference/script-load-order.md — old list omitted labels.js, textboxes.js, measure.js, osm.js, osm-pois.js, selection.js, undo.js, projections.js, service-assembly.js; index.html loads them (labels..osm-pois after polygons.js, selection.js after editing.js, projections.js after lodes.js, undo.js after cache.js, service-assembly.js after popup.js); added in index.html order.
- **Info** — docs/reference/layers-and-styling.md — doc listed LAYER_STYLES kinds as "ramp"|"solid" and 8 styleKeys; code also has kind "categorical" with `transit-coverage`/`title-vi`; listed all 10 keys and 3 kinds.
- **Info** — docs/reference/layers-and-styling.md — doc said App.layerStyles shape `{palette, reverse, color}` in one place; code also stores from/to/colors/flatten; unified.
- **Info** — docs/reference/layers-and-styling.md — "Walk network" row's layers array also includes `walk-network-excluded-line` (layers-panel.js:55); doc said only walk-network-line + network-joins-point; fixed.
- **Info** — docs/reference/layers-and-styling.md — layers-panel.js also exports `App.gtfsRestoreHighlight` (layers-panel.js:1164); doc said "No other public API"; fixed.

# Findings E

- **Info** — docs/reference/modules/fta-small-starts.md:16 — doc said popup "960px wide"; code `popupWidth: 1000`, `panelWidths {setup:520, results:520, workspace:1000}`; doc updated.
- **Info** — docs/reference/modules/transit-propensity.md:29 — doc said 960px popup, 240px settings column; code `popupWidth: 1000`, `panelWidths 520/520`; doc updated.
- **Info** — docs/reference/modules/transit-propensity.md:22 — doc said factor fields `acsCodes`/`weight` and signatures `aggregateLodesToGeo(lodesData, geoLevel, geoids)`, `batchFetchACS(geoLevel, year, geoids)`, `computeComposite(factorScores, weights)`; code uses `acsVars`/`defaultWeight`, `aggregateLodesToGeo(lodesData, geoids, geoLevel)`, `batchFetchACS(..., varCodes)`, `computeComposite(factorScores, weights, allGeoids)`; fixed, added `getDefaultWeights`/`getRequiredAcsVars`/`recomputeWithGrowthFactors`.
- **Info** — docs/reference/modules/transit-propensity.md:26 — doc said only LEP is `tractOnly` and both fallbacks are skipped when `apportionByArea`; code flags zero_car, poverty, disability, lep; static fallback runs for every BG run, only dynamic is skipped under apportionment, and dynamic fills partial misses too; fixed.
- **Info** — transit-propensity.md — cache id not stated; code `App.cache.registerModule("tpi", …)`, schemaVersion 2; added.
- **Info** — docs/reference/modules/corridor-scoring.md:11 — doc said legend is "5-class Blues swatches"; legend html has 4 red/orange/yellow/green swatches (≥4 High, 3–4 Medium, 2–3 Low-Medium, <2 Low); fixed.
- **Info** — docs/reference/modules/corridor-scoring.md:24 — doc said "5-class Blues interpolation" (contradicting its own line 7); code is a 3-break step expression with colors from `App.resolveLayerColors("corridor-scoring")`; fixed.
- **Info** — corridor-scoring.md:16 — doc said 960px popup; code `panelWidths 600/600`; persisted fields also include `bufferMiles`, `useDisplayBuffers`, `includeHidden`; updated.
- **Info** — docs/reference/modules/ridership-forecasting.md:24 — doc premium defaults enhanced 0.15/0.35, limited 0.15/0.30, brt 0.30/0.65; code 0.05/0.15, 0/0.10, 0.05/0.25; fixed.
- **Info** — ridership-forecasting.md:48-50 — doc `calibrateRatio/Regression(rows, demandColKey, ridershipColKey)` returning `method` (and regression `factor`); code takes `(observedData)` of `{ridership, demandIndex}`; ratio → `{factor, n, rSquared}`, regression → `{intercept, slope, rSquared, n, warning}`, no `method`; fixed.
- **Info** — ridership-forecasting.md:32 — doc `classifyCDI` returns `cssClass`; code returns `{label, level}`; fixed.
- **Info** — ridership-forecasting.md:63 — doc "v3 JSON" calibration export; code writes `version: 2` plus extra shared-pool fields; reworded.
- **Info** — ridership-forecasting.md:61 — doc 960px popup; code 1000; removed.
- **Info** — ridership-forecasting.md — engine fns take extra `segBufferMiles`/`bufferSet`/`growthFactors` params not documented; added.

- **Info** — docs/reference/modules/walkshed.md:16 — doc said cache `settingsKey` is `coords|minutes|speed|maxEdge|networkEpoch`; code (walkshed.js:121) is `lng|lat|budgets|speed|maxEdge|epoch|crossMajor|crossMinor`. Doc fixed.
- **Info** — docs/reference/modules/route-costing.md:7 — said schema v2; code `version: 3`. Doc fixed.
- **Info** — docs/reference/modules/route-costing.md:16 — said 960px popup; code `popupWidth: 1240`. Width removed.
- **Info** — docs/reference/modules/route-costing.md:20 — described service assembly/validation as route-costing.js internals; it lives in js/core/service-assembly.js (`App.buildTransitServices`). Doc fixed.
- **Info** — docs/reference/modules/trip-builder.md:7 — said schema v1; code `version: 2`. Doc fixed.
- **Info** — docs/reference/modules/trip-builder.md:18 — said assembly code is duplicated; code uses shared `App.buildTransitServices()`. Doc fixed.
- **Info** — docs/reference/modules/trip-builder.md:14,26 — said 1100px popup (code 1140) and refreshAfterEdit matches `{featureType, featureIndex}` (code matches featureId). Width removed; featureId kept.
- **Info** — docs/reference/modules/title-vi.md:43 — said 960px popup; code 1000. Width removed.
- **Info** — docs/reference/modules/gtfs.md:14 — said "No session persistence — feed must be re-uploaded"; code persists feed in full session files via `App.serializeGTFSData`/`App.restoreGTFSFromData` (cache.js:950,1031). Doc fixed.
- **Info** — docs/reference/modules/gtfs.md:14 — said 960px popup; code 1000. Width removed.

