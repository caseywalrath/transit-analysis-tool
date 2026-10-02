# Title vi

Reference detail moved verbatim from `CLAUDE.md`. Read the code when this and the code disagree.

## Files

- **`title-vi-engine.js`** — Title VI engine: policy profiles, major-change rules, geometric divergence detection (turf.nearestPointOnLine), service change area computation (turf.difference), alteration metrics orchestration, demographic fetching, finding evaluation, scenario comparison (window.TitleVI namespace)

- **`title-vi.js`** — Title VI Service Equity module: 3-tab popup (Policies & Inputs | Analysis | Scenarios), route alteration pairing UI (before/after feature dropdowns), auto-computed route miles and % altered, service loss/gain map overlay, system baseline vs impacted area demographic comparison, CSV/GeoJSON/JSON export, session persistence

- **`title-vi-popup.html`** — Title VI popup body: 3-tab layout (Policies & Inputs | Analysis | Scenarios); Policies tab has 2-column layout (policy settings left, route alteration cards + impact method right); Analysis tab has baseline computation + equity findings; Scenarios tab has scenario manager + comparison table

## API

### API — title-vi-engine.js (window.TitleVI namespace, not on App)
Pure calculation engine for the Title VI Service Equity module. No DOM access. Depends on `turf` (CDN) and `window.App` (for feature resolution).

`TitleVI.defaultPolicy()` — returns a fresh policy profile object with major-change rules (route miles %, revenue hours %, span %, route elimination, fare %), equity thresholds (disparate impact and disproportionate burden in percentage points), geography level, ACS year, and buffer distance.

`TitleVI.createScenario(name)` — returns a new scenario object with `alterations: []` array and `impactMethod: "service_loss_area"`.

`TitleVI.createAlteration(name)` — returns a new alteration object: `{ name, changeType ("alteration"|"elimination"|"new_route"), before (feature ref or null), after (feature ref or null), computed (filled by computeAlterationMetrics), manual: { revenueHours, spanHours, fare } }`. Feature refs are `{ featureType: "route"|"line", featureId (stable ID), featureName (last known, for the missing-feature label) }`; `featureId: null` marks a legacy ref whose index no longer resolved. `TitleVI.resolveFeature(ref)` resolves by ID at use time (null = deleted); `TitleVI.findMissingRefs(scenario)` → `[{altName, which}]` for the before/after refs each change type needs that no longer exist.

`TitleVI.computeDivergence(beforeFeature, afterFeature, divergenceThresholdMiles, sampleIntervalMiles)` — samples points every ~0.05 mi along the "before" route and measures distance to the nearest point on the "after" route via `turf.nearestPointOnLine()`. Points farther than the threshold (default 0.1 mi / 528 ft) are flagged as divergent. Returns `{ alteredPct, alteredMiles, totalMiles, divergentSegments: [{ startMile, endMile, maxDivergenceFt }] }`.

`TitleVI.computeServiceChangeArea(beforeFeature, afterFeature, bufferMiles)` — buffers both routes at `bufferMiles`, then uses `turf.difference()` to compute service loss area (before minus after) and service gain area (after minus before). Returns `{ serviceLossArea, serviceGainArea, beforeBuffer, afterBuffer }`.

`TitleVI.computeAlterationMetrics(alteration, bufferMiles, divergenceThresholdMiles)` — orchestrates all metric computation for a single alteration. Resolves feature references, computes route miles, divergence (% altered), service change areas, and manual metric % changes. Handles all three change types: `alteration` (both before and after), `elimination` (before only, 100% altered, entire buffer is loss), `new_route` (after only, entire buffer is gain). Returns computed metrics object stored on `alteration.computed`.

`TitleVI.computeRouteMetrics(route)` — legacy CSV-based route metrics (kept for backward compat).

`TitleVI.evaluateMajorChange(policy, scenario)` — evaluates all enabled major-change rules against each alteration's computed metrics. Returns `{ triggered, ruleResults: [...], altMetrics: [...] }`.

`TitleVI.buildImpactedArea(scenario)` — constructs the impacted area geometry based on `scenario.impactMethod`. Methods: `service_loss_area` (default — union of service loss polygons from all alterations), `service_change_area` (union of both loss and gain areas), `full_route_buffer` (all App route/line buffers), `user_polygon` (drawn polygons). Falls back to before-route buffers if no service change areas are computed.

`TitleVI.fetchDemographics(core, unionGeom, geoLevel, year)` — fetches ACS race/ethnicity (B03002) and poverty (B17001) data for census geographies intersecting the union polygon. Includes tract-level fallback for poverty at block-group level. Returns `{ totalPop, minorityPop, minorityShare, lowIncomePop, lowIncomeShare, geoCount, geos }`.

`TitleVI.evaluateFindings(impactedDemographics, baseline, policy)` — compares impacted area demographics against the system baseline. Returns findings for both minority (Disparate Impact) and low-income (Disproportionate Burden) with `diffPpt`, `exceedsThreshold`, and `finding` string.

`TitleVI.compareScenarios(scenarioResults)` — builds a comparison array from multiple analyzed scenarios for the comparison table.

### API — title-vi.js (analysis module, no public API)
Registers module `"title-vi"` as a popup-based analysis. Opens in a 3-tab popup (960px wide). All state is private to the IIFE closure. DOM writes guarded with `isPopupVisible()`. All DOM element IDs use `tvi` prefix. CSS classes use `.tvi-` prefix.

**Tab 1 – Policies & Inputs**: 2-column layout. Left column: policy name, major service change rules (checkboxes + threshold inputs), equity thresholds (DI and DB in ppt), geography level and ACS year. Right column: route alteration card system ("+&nbsp;Add Alteration" button, cards with name input, change-type dropdown, before/after feature dropdowns, auto-computed metrics display, manual inputs for revenue hours/span/fare), and impacted area method radio group (service loss area, all affected area, full route buffer, drawn polygons).

**Tab 2 – Analysis**: 2-column layout. Left: system baseline section (feature checklist for baseline union, "Compute Baseline" button, baseline results box showing minority/low-income shares), equity analysis section ("Run Equity Analysis" button, shared stale banner via `App.renderModuleState()` rendered into `#tviStaleWarning` (now `.rf-status`, with a Re-run button; the old `.tvi-stale-banner` style was removed), status text). Right: results display (Major Service Change verdict pill + per-rule breakdown, Minority/Disparate Impact card with impacted vs baseline shares and threshold comparison, Low-Income/Disproportionate Burden card, summary stats, export buttons for CSV and GeoJSON).

**Tab 3 – Scenarios**: Scenario manager (dropdown, Duplicate/Rename/Delete buttons), comparison table (all analyzed scenarios side-by-side), export buttons (Comparison CSV, Session JSON), session import file picker.

**Map overlay**: Red semi-transparent fill for service loss / impacted area (`tvi-impacted-*` layers), green semi-transparent fill for service gain area (`tvi-gain-*` layers). Both cleared on popup close or new analysis. **Layer colors (`docs/layer-color-customization-plan.md` Phase 7):** both resolve through `App.resolveLayerColors("title-vi")` — a `kind: "categorical"` spec with two classes, `[loss, gain]`; each class's fill and outline share one color, so a class is one swatch, not two. `repaintOverlay()` is registered as the module's layer repainter. Title VI has no legend, but the `.tvi-loss-swatch` / `.tvi-gain-swatch` chips beside each alteration card's computed metrics are the same "legend lies after a recolor" hazard, so `fillSwatchColors()` re-tints every instance from `renderAlterationCards()` (the single choke point all six callers go through) and from the repainter.

**Alteration data model**: Each scenario has an `alterations[]` array. Each alteration has `{ name, changeType, before, after, computed, manual }`. `before`/`after` are feature references `{ featureType, featureId, featureName }` (stable IDs, resolved fresh at use time) pointing to drawn routes/lines on the map. The dropdowns (`buildFeatureSelect`/`parseFeatureRef`) encode `type:id`; a ref whose feature was deleted renders as a selected `(deleted feature: name)` option plus a red note on the card, and `runAnalysis` refuses to run (status message naming the adjustment) instead of skipping it. `computed` is filled by `TitleVI.computeAlterationMetrics()` and contains `{ beforeMiles, afterMiles, routeMilesPct, alteredPct, alteredMiles, serviceLossArea, serviceGainArea, divergentSegments, revenueHoursPct, spanHoursPct, farePct }`.

**Internal functions**: `addAlteration()`, `removeAlteration(idx)`, `onAlterationChanged(idx)`, `renderAlterationCards()`, `buildAlterationCard(idx, alt)`, `displayComputedMetrics(card, alt)`, `buildFeatureSelect(selectedRef)`, `parseFeatureRef(selectEl)`, `readManualInputs(card)`, `runBaseline(core)`, `runAnalysis(core)`, `runInstantReevaluation()`, `displayResults(result)`, `displayFinding(prefix, finding)`, `renderImpactedArea(geometry)`, `renderServiceGainOverlay()`, `clearOverlay()`, `switchScenario(idx)`, `duplicateScenario()`, `renameScenario()`, `deleteScenario()`, `exportFindingsCSV()`, `exportImpactedGeoJSON()`, `exportSessionJSON()`, `exportComparisonCSV()`, `importSessionJSON(file)`.

**Module-local state**: `_policy` (current policy profile), `_scenarios` (array of scenario objects), `_activeScenarioIdx`, `_baseline` (system-wide demographics), `_results` (scenarioId → analysis result), `_cachedDemographics` (for instant threshold re-evaluation), `_cachedImpactedGeom`, `_baselineFeatureFilter` (`{ routeIds, lineIds, polygonIds }` stable IDs, `null` = all; resolved to indices in `buildUnionFromFilter` at run time; persisted as `baselineFeatureFilter`), `_stale`, `_running`, `_initialized`, `_activeTab`. Session persistence via `App.cache.registerModule("title-vi", ...)` at schema **v3** (v3: ID refs + `baselineFeatureFilter`. v1/v2 restore: v1 adds empty `alterations[]` and maps `selected_routes` impact method to `full_route_buffer`; v1/v2 index refs/filters are converted to IDs in `applyState`, an index that no longer resolves becomes a missing ref with `featureId: null`; a standalone session-file import migrates against the live features). `collectState` no longer throws before the popup has ever been opened (it skips the DOM policy read), which previously dropped the module's state from autosaves after a reload.
