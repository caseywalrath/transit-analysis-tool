# Transit propensity

Reference for changing TPI. Read the code when this and the code disagree.

## tpi-scoring.js (`window.TPI`, not on App)

`TPI.FACTORS` (9 factors: `id`, `label`, `acsVars`, `defaultWeight`, `compute`, optional `tractOnly`), `TPI.getDefaultWeights()`, `TPI.getRequiredAcsVars(weights)`, `TPI.batchFetchACS(geoLevel, year, geoids, varCodes)`, `TPI.aggregateLodesToGeo(lodesData, geoids, geoLevel)`, `TPI.computeQuintiles(values)`, `TPI.computeComposite(factorScores, weights, allGeoids)`, `TPI.computeTPI(options)` (fetch → normalize → score; `options.unionPolygon` restricts the study area instead of `App.bufferUnionPolygon()`), `TPI.rescoreFromRaw(rawValues, weights, geoids)` (instant re-score from cached data), `TPI.recomputeWithGrowthFactors`.

**Default weights** (sum 100): pop density 35, employment 35, zero-car 5, poverty 5, senior 5, disability 5, minority 5, youth 0, LEP 5. Shared defaults for TPI, RF and Corridor Scoring; each module keeps its own `_weights` copy.

**Tract-level fallbacks** in `computeTPI()` when `geoLevel === "bg"`: (1) *static* — factors with `tractOnly: true` (zero_car, poverty, disability, lep) are always fetched at tract level and mapped to block groups by parent-tract GEOID slicing; (2) *dynamic* (skipped when `apportionByArea`) — any ACS factor with missing/non-finite values at some BGs is re-fetched at tract level to fill those BGs. Downstream modules (RF, Corridor Scoring) get this automatically.

## transit-propensity.js (module `"transit-propensity"`)

Popup `projects/transit-propensity-popup.html` (`panelWidths` 520/520). `projects/transit-propensity.html` and `tpi-weights.html` are legacy; `tpi-legend.html` is the static 1–5 legend widget.

- Buffer distance (default 0.5 mi) is module-owned via `js/core/module-buffers.js`; walkshed-flagged points keep their cached walkshed, polygons are unbuffered.
- Feature checklist = normalization pool (only selected features' union feeds quintiles). Analysis Corridor dropdown filters the displayed geography list without re-running. Adjust Weights modal: Confirm copies `_pendingWeights` → `_weights` and instantly rescores.
- `#tpiLodesWarnBtn` shows when `App.lodesData` is null (employment factor excluded); refreshed in `onOpen()`/`update()`. DOM writes guarded by `isPopupVisible()`.
- **Choropleth:** delegates to `App.choropleth.render({id: "tpi", ...})` / `App.choropleth.remove("tpi")` with fixed `breaks: [1,2,3,4]` on `"blues"` (colors via the `"tpi"` layer style); hover body `tpiHoverHTML(props)`. Ids `tpi-choropleth`/`tpi-choropleth-fill`/`-line` must not change — the Layers-panel manifest and ui-screens depend on them.
- **Stable refs:** `_uncheckedRefs` holds the UNCHECKED `{type, id}` refs (new features default to checked), updated only by checkbox handlers via `captureChecklistSelection()`. `_selectedCorridor` is `"all"` or a `featureRefKey` (`"route:<id>"`), never an index; `result.bufferByRef` maps those keys to the run's buffers so `getGeosInCorridor()` never depends on array positions.
- **Persistence:** `App.cache.registerModule("tpi", ...)`, `schemaVersion: 2` (`uncheckedFeatures` refs); v1 `tpiFeatureFilter` index filters migrate via `App.uncheckedRefsFromIndexFilter`.
- **Public:** `App.getTpiWeights()` — shallow copy of `_weights`, used by RF's "Copy From TPI".
