# Corridor scoring

Reference for changing Corridor Scoring. Read the code when this and the code disagree.

## corridor-scoring.js (module `"corridor-scoring"`, no public API)

Surfaces the per-route CDI engine as the final product: a ranked composite score per draft corridor (TPI is geography-focused, RF ridership-focused). The normalization pool is the union of only the selected routes/lines (points/polygons not applicable), so scores compare within the user's working set. `runScoring()` wraps `RidershipModel.buildUnionFromFeatures` + `RidershipModel.computeSystemDemand` and sorts by CDI desc.

Popup `projects/corridor-scoring-popup.html` (`panelWidths` 600/600): geography/year + LODES warning, apportion toggle, routes+lines checklist, buffer distance (default 0.5 mi, module-owned via `js/core/module-buffers.js`), Adjust Weights modal (`_weights` defaults to `TPI.getDefaultWeights()`), ranked table with classification pills and expandable `.cs-row-details` factor breakdowns, CSV/GeoJSON export. Ids use the `cs` prefix; DOM writes guarded by `isPopupVisible()`.

**Map:** line source/layer `corridor-scoring-routes` / `corridor-scoring-routes-layer`. Color is `App.choropleth.buildStepColorExpr("cdi", [2,3,4], colors, "rgba(180,180,180,0.7)")` with colors from `App.resolveLayerColors("corridor-scoring")` (default red/orange/yellow/green `#C53030 #C05621 #D69E2E #276749`). It is a quality scale (poor → excellent), deliberately not a sequential `App.choropleth.RAMPS` preset; the layer spec only allows diverging palettes. Missing `cdi` renders the no-data gray. Legend `projects/corridor-scoring-legend.html` (4 swatches `csLegendSw0–3`: ≥4 High, 3–4 Medium, 2–3 Low-Medium, <2 Low) shows on success; the `clear` hook (`clearAll()`) removes layer and legend on Clear/Reset Session.

**Stable refs:** `_uncheckedRefs` = UNCHECKED `{type, id}` refs (same pattern as TPI). `_lastResult.routeCDIs` rows carry `featureId`; map, exports and re-render resolve geometry (from `App.routes`/`App.lines`) via `App.featureById`, skipping deleted features (`featureIndex` is only the run-time position).

**Persistence** (`App.cache.registerModule("corridor-scoring", ...)`, `version: 2`): `weights`, `apportionByArea`, `bufferMiles`, `useDisplayBuffers`, `includeHidden`, `uncheckedFeatures`, `geoLevel`, `year`, `lastSummary` (ranked `routeCDIs` + run metadata incl. `featureRefs`). Full mode adds `full.systemFactorAverages` + `full.effectiveWeights` so breakdown bars restore without the TPI `factorScores` Map. Restore re-renders map + legend with no Census calls. v1 index filters / `featureIndex` rows migrate in `restoreCsState`; rows whose feature is gone are skipped and results come back stale.

`App._csTest` → `{computeSystemFactorAverages, pillClassFor, formatScore, escapeHTML, _csvField}`. Test-only hook (exists only when `window.__MAT_TEST__`; used by `test/run-golden.mjs`).
