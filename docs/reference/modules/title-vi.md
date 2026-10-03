# Title VI

Read the code when this and the code disagree.

## title-vi-engine.js (`window.TitleVI`, not on App)

Pure calculation engine: no DOM. Uses turf and `window.App` (feature resolution only).

- `TitleVI.defaultPolicy()` → policy profile: major-change rules (route miles %, revenue hours %, span %, elimination, fare %), equity thresholds (disparate impact / disproportionate burden, in percentage points), geography level, ACS year, buffer distance.
- `TitleVI.createScenario(name)` → `{ …, alterations: [], impactMethod: "service_loss_area" }`.
- `TitleVI.createAlteration(name)` → `{ name, changeType: "alteration"|"elimination"|"new_route", before, after, computed, manual: { revenueHours, spanHours, fare } }`. `before`/`after` are refs `{ featureType: "route"|"line", featureId, featureName }`; `featureId: null` = a legacy ref whose index no longer resolved. `featureName` is only the label for a missing feature.
- `TitleVI.resolveFeature(ref)` → feature by ID at use time, or null (deleted). `TitleVI.findMissingRefs(scenario)` → `[{altName, which}]` for required refs that no longer exist.
- `TitleVI.computeDivergence(before, after, thresholdMi, sampleIntervalMi)` → samples the before route (~0.05 mi), distance to after via `turf.nearestPointOnLine`; beyond threshold (default 0.1 mi) = divergent. Returns `{ alteredPct, alteredMiles, totalMiles, divergentSegments: [{startMile, endMile, maxDivergenceFt}] }`.
- `TitleVI.computeServiceChangeArea(before, after, bufferMiles)` → `{ serviceLossArea, serviceGainArea, beforeBuffer, afterBuffer }` via `turf.difference`.
- `TitleVI.computeAlterationMetrics(alteration, bufferMiles, thresholdMi)` → fills `alteration.computed` (`beforeMiles, afterMiles, routeMilesPct, alteredPct, alteredMiles, serviceLossArea, serviceGainArea, divergentSegments, revenueHoursPct, spanHoursPct, farePct`). `elimination` = before only, 100% altered, whole buffer is loss; `new_route` = after only, whole buffer is gain.
- `TitleVI.computeRouteMetrics(route)` — legacy CSV metrics, kept for backward compat.
- `TitleVI.evaluateMajorChange(policy, scenario)` → `{ triggered, ruleResults, altMetrics }`.
- `TitleVI.buildImpactedArea(scenario)` by `impactMethod`: `service_loss_area` (default), `service_change_area` (loss + gain), `full_route_buffer`, `user_polygon`; falls back to before-route buffers when no change areas exist.
- `TitleVI.fetchDemographics(core, unionGeom, geoLevel, year)` → ACS B03002 + B17001 (tract fallback for poverty at block-group level) → `{ totalPop, minorityPop, minorityShare, lowIncomePop, lowIncomeShare, geoCount, geos }`.
- `TitleVI.evaluateFindings(impacted, baseline, policy)` → minority (Disparate Impact) and low-income (Disproportionate Burden) findings with `diffPpt`, `exceedsThreshold`, `finding`.
- `TitleVI.compareScenarios(scenarioResults)` → rows for the comparison table.

## title-vi.js (module `"title-vi"`, no public API)

3-tab popup (Major Service Changes | Equity Analysis | Scenarios); DOM ids `tvi` prefix, styles `.tvi-`. Stale state uses the shared `App.renderModuleState()` in `#tviStaleWarning` (with Re-run).

- **Refs:** feature dropdowns (`buildFeatureSelect`/`parseFeatureRef`) encode `type:id`. A ref to a deleted feature shows as a selected `(deleted feature: name)` option plus a red card note, and `runAnalysis` **refuses to run** (naming the adjustment) rather than skipping it.
- **Baseline filter:** `_baselineFeatureFilter` = `{ routeIds, lineIds, polygonIds }` stable IDs (`null` = all), resolved to indices only in `buildUnionFromFilter` at run time.
- **Map:** loss/impacted fill (`tvi-impacted-*`) and gain fill (`tvi-gain-*`), cleared on new analysis. Colors resolve through `App.resolveLayerColors("title-vi")` (categorical, classes `[loss, gain]`, fill and outline share one color); `repaintOverlay()` is the registered repainter. There is no legend, but the `.tvi-loss-swatch`/`.tvi-gain-swatch` chips on alteration cards would lie after a recolor, so `fillSwatchColors()` re-tints them from `renderAlterationCards()` (the single choke point for all callers) and from the repainter.
- **Usage hook:** registers with `App.registerFeatureUsage` (warn) for every alteration ref.
- **Persistence:** `App.cache.registerModule("title-vi", …)`, schema **v3** (ID refs + `baselineFeatureFilter`). v1 adds empty `alterations[]` and maps impact method `selected_routes` → `full_route_buffer`; v1/v2 index refs/filters convert to IDs in `applyState` (unresolvable → missing ref with `featureId: null`); a standalone session-file import migrates against the live features. `collectState` must not touch the DOM before the popup has opened (it once threw there and dropped the module from autosaves).

## title-vi-popup.html

Policies tab: policy settings | alteration cards + impact-method radios. Analysis tab: baseline + equity findings. Scenarios tab: scenario manager + comparison table + session JSON import/export.
