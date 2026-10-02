# Ridership forecasting

Reference for changing Ridership Forecasting. Read the code when this and the code disagree. Strategy: `docs/ridership-forecasting-plan.md`; user docs: `Ridership_Forecast_Readme.md`.

## ridership-scoring.js (`window.RidershipModel`, not on App)

Pure-ish engine; depends on `window.TPI`. Feature filters here are run-time **index** filters `{ routeIndices, lineIndices }` (null = all); `bufferSet` is an optional `App.buildAnalysisBufferSet()` result.

- `RidershipModel.SERVICE_TYPES` — `local_bus`, `enhanced_bus`, `limited_stop`, `brt`, each with `defaultSpeed/Headway/Span/StopSpacing` and `servicePremium: {low, high}` fractions (mid = average). Defaults: 0/0, 0.05/0.15, 0/0.10, 0.05/0.25. User overrides live in the module's `_servicePremiums` and are passed as `customServicePremium`. `getServiceType(id)`.
- `computeCorridorDemand(options)` — wraps `TPI.computeTPI()`; CDI = population-weighted mean of composite scores → `{ tpiResult, corridorCDI: {value, scored, total}, segments, classification }`. Uncalibrated (legacy) path only.
- `computeSegments(tpiResult, segmentMiles, selectedCorridor, segBufferMiles)` — equal-length chunks with population-weighted CDI against already-fetched geographies (turf only, no Census calls). `selectedCorridor` `"route:N"`/`"line:N"`/`"all"`.
- `classifyCDI(cdi)` → `{label, level}`: High ≥4, Medium ≥3, Low-Medium ≥2, Low; N/A when non-finite.
- `getRouteLength()` — total miles of drawn routes.
- `computeFrequencyEffect(baseHeadway, newHeadway, elasticity)` = `(newFreq/baseFreq)^e`, `freq = 60/headway`. Also used by Calibrate for headway normalization.
- `computeSpanEffect(baseSpan, newSpan, elasticity)` = `(newSpan/baseSpan)^e`; 1 if either span ≤ 0. Base span 14 h; applied only in Scenarios.
- `applyElasticity(baseCDI, params)` → `{low, mid, high, freqEffect, serviceType}`; multiplier `freqEffect × (1 + premium)`. Called with `baseCDI = 1.0` to get pure service multipliers.
- `applyBaselineUncertainty(baseMid, pct)` → `{low: max(0, mid(1−pct)), mid, high: mid(1+pct)}`; zeros if `baseMid` non-finite or ≤ 0.
- `buildScenario(params)` — `vehicles = ceil(2·length/speed/(headway/60))`, rev-hr/day = vehicles × span, annual = × serviceDays, cost = × cost/rev-hr; ridership = baseline band × service multipliers × span effect. `compareScenarios(scenarios)` (≤4), `scenarioToRow`.
- `calibrateRatio(observedData)` → `{factor (mean ratio), n, rSquared}`; `calibrateRegression(observedData)` → `{intercept, slope, rSquared, n, warning}` (needs n ≥ 3). `observedData` = `[{ridership, demandIndex}]`. `exportCoefficients` / `importCoefficients`.
- `computePerRouteCDI(tpiResult, featureFilter, bufferSet)` → `[{ name, featureType, featureIndex (run-time, goes stale), featureId (stable — look up by this), cdi, classification, geoCount, lengthMiles, factorBreakdown {factorId: avgQuintile}, compositeRange {min, max} }]`. Per-feature variation is what makes calibration valid.
- `computeSystemDemand(options)` — one `TPI.computeTPI()` → `{ tpiResult, systemCDI, routeCDIs, geoLevel, year }`; options `geoLevel, year, weights, lodesData, apportionByArea, growthFactors, onProgress, unionPolygon, featureFilter, bufferSet`.
- `buildUnionFromFeatures(featureFilter, bufferSet)` — union of selected buffers or null.
- `matchRoutesToCSV(routeCDIs, csvRows, nameCol)` — trimmed, case-insensitive exact name match → `{matched: [{csvRow, routeCDI, csvRowIndex}], unmatched, duplicateWarnings}`.
- Also exported: `computeCorridorCDI`, `rescoreDemand`.

## ridership-forecasting.js (module `"ridership-forecasting"`, no public API)

Popup `projects/ridership-forecasting-popup.html`, 4 tabs: Calibrate | Demand | Elasticity | Scenarios. Legend widget `projects/ridership-legend.html`. DOM writes guarded by `isPopupVisible()`. One module-owned buffer distance (default 0.5 mi) shared by Calibrate and Demand. LODES warnings (`#rfCalibLodesWarnBtn`, `#rfDemandLodesWarnBtn`) shown when `App.lodesData` is null, refreshed by `updateLodesWarnings()` in `onOpen()`/`update()`. `_weights` is independent of TPI's (defaults `TPI.getDefaultWeights()`; "Copy From TPI" reads `App.getTpiWeights()`).

**Calibrate** (gated 3 steps): (1) Analyze System on the checked features → `computeSystemDemand()` with a custom union; per-route CDI table with factor breakdowns. (2) Upload CSV (`App.guessHeader()` auto-detect) → `matchRoutesToCSV()`. (3) Ratio or OLS fit on matched pairs. If a headway column is mapped, observed ridership is divided by `computeFrequencyEffect(30, routeHeadway, elasticity)` before fitting so the factor isolates demand (`_calibration` then carries `headwayNormalized`, `refHeadway`, `normElasticity`, `headwayNormCount`). Calibration export JSON (`exportCalibJSON`) = `exportCoefficients` output (`version: 2`) plus `normalizationMode`, `baselineUncertaintyPct`, `servicePremiums`, `bufferMiles`, `demandFeatureFilter`, `sharedCalibPerRouteCDI`; import defaults missing `baselineUncertaintyPct` to 0.25.

**Demand:** "Same system as calibration" reuses calibration TPI (no Census calls). Otherwise: shared pool (`_sharedPoolMode`, checkbox `rfSharedPoolMode`, default on when unchecking same-system) — `runSharedPoolAnalysis()` runs ONE TPI over the union of calibration + demand features, partitions `routeCDIs` into `_sharedCalibPerRouteCDI`/`_demandPerRouteCDI`, and auto-refits `_calibration` via `refitCalibrationFromCDI()` (marked `sharedPoolMode: true`); or separate pool — fresh `computeSystemDemand()` on demand features only. With no system run at all, falls back to `computeCorridorDemand()`. Segment analysis uses `computeSegments()` on the active TPI result.

**Elasticity:** `baseMid = max(0, CDI·factor·length, (intercept + CDI·factor)·length)` → `applyBaselineUncertainty(baseMid, _baselineUncertaintyPct)` → × `applyElasticity(1.0, …)` multipliers, aligned low/mid/high. Span elasticity is stored here but not applied. Defaults: frequency elasticity 0.60, span elasticity 0.70, uncertainty 0.25, premium sliders 0–150%.

**Scenarios:** 4 side-by-side columns (input ids suffixed `_0`–`_3`); final = baseline band × service multipliers × `computeSpanEffect(14, span, _spanElasticity)`; `buildScenario()` each. Exports include `baselineUncertaintyPct`.

**`getActiveCDI()`** prefers demand context (`_demandPerRouteCDI`) over calibration (`_perRouteCDI`), then `_demandSystemResult.systemCDI`, `_systemResult.systemCDI`, `_lastResult.corridorCDI` — so Elasticity/Scenarios use the target system's pool when available.

**Stable refs (invariant):** `_selectedCorridor` is `"route:<id>"`/`"line:<id>"` (stable ID), resolved at use time with `findCorridorRow()`/`corridorIndexKey()`. `_calibFeatureFilter`/`_demandFeatureFilter` are `{ routeIds, lineIds }` (null = all), converted to the engine's index filter with `filterToIndices()` only at the point of use. Per-route CDI arrays and `_matchResult` rows are matched by `featureId`.

**Map:** choropleth via `App.choropleth.render({id: "rf", ...})` / `remove("rf")`, `breaks: [1,2,3,4]` on `"blues"`, colors from `App.resolveLayerColors("rf")`; ids `rf-choropleth`/`-fill`/`-line` preserved. `removeChoropleth()` also tears down the separate per-route CDI line overlay `rf-corridor-cdi` / `rf-corridor-cdi-layer` and `_corridorPopup`.

**Persistence:** `App.cache.registerModule("rf", ...)`, `_schemaVersion: 4` (v4 = stable-ID corridor/filters/rows; v1–v3 index data converted in `restoreRfState`; v3 added `sharedPoolMode`). `_spanElasticity`, `_servicePremiums`, `_baselineUncertaintyPct` (default 0.25 when absent) also persist.
