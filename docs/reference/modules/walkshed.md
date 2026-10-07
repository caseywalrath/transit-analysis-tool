# Walkshed

Read the code when this and the code disagree. See `docs/archive/walkshed-bands-and-crossing-penalties-plan.md`, `docs/archive/network-connectors-plan.md`, `docs/sidewalk-data-plan.md`.

## walkshed.js (module `"walkshed"`)

Street-network walking isochrones from placed Points via `App.computeWalkshed` (`js/core/road-network.js`) — no external service.

**Public API:**
- `App.getPointWalkshed(pointIdx)` → validated cached walkshed polygon Feature, or null when absent/stale (requires the point to exist and its `settingsKey` to match). Consumed by `points.js rebuildBuffers()`.
- `App.ensurePointWalksheds()` → synchronously computes walkshed-flagged points missing/stale in the cache; returns `{ computed, cached, failed, warnings }`.
- `App.dropPointWalksheds(ids)` → frees cache entries for removed points (`pointIdx` values; called by Feature Merge).

**Settings / units:**
- Up to three budgets (`_settings.budgets`, min, defaults 15/30/blank, cap 60 each). `activeBudgets()` drops blanks, dedupes, sorts ascending, never returns empty (falls back to 15). Sorted storage keeps "first" == "smallest".
- Walk speed in **mph** (default 3.1), converted to km/h at use — graph weights are km.
- Hull `maxEdge`: displayed in **feet** (default 984 ft), stored/persisted as **km** in `_settings.maxEdge` (0.3); `FT_PER_KM` converts at the UI boundary. A hull parameter, not a walking unit.
- A point's `attributes.walkMinutes` / `walkSpeedMph` overrides (data model only, no UI) make it use a single budget / its own speed.

**Global network settings (not module state, shared with Transit Travelshed):** Advanced inputs read/write `App.networkSettings.snapToleranceFt` (on change: `App.refreshNetworkConnectors()` + stale), `crossingMajorSec`/`crossingMinorSec` (on change: `App.cache.save()` + stale; no connector refresh, only the cost function changes), and show `App.networkSettings.excludedWayIds.length` with a Clear that calls `App.setExcludedWays([])`. The excluded count is synced on popup open because exclusions are made on the map layer, outside this popup. Clicking streets only excludes them while **Edit streets** (`#wsEditStreets`, `aria-pressed`) is on — it calls `App.setWayExclusionMode()` (refuses with a status if no network is loaded or a draw tool is active), follows the `wayexclusionmodechange` event, and `onClose` switches it off. See `road-network.md`.

**Cache key** (`settingsKeyFor`): `lng|lat|budgets(all)|speed|maxEdge|networkEpoch|crossMajor|crossMinor`. All budgets and the crossing seconds must be in the key — they change the result without bumping the network epoch, so omitting them served stale polygons.

**Compute:** `computeForPoint` floods once at the largest budget: `App.computeWalkshed(coords, maxBudgetKm, {maxEdge, budgetsKm, crossingPenaltyKm})` → `entry.bands: [{minutes, polygon, area, nodeCount}]` (ascending). `entry.polygon`/`area`/`reachableCount` alias the **smallest** band, which is always the study-area polygon. `crossingPenaltyKm` comes from `window.WalkCost.penaltyKm(...)`, guarded by `typeof window.WalkCost` so a missing script means no penalty; zero/absent penalty is byte-identical to no-penalty output.

**Rendering:**
- Fill (`walkshed-fill`) colored by a `["match", ["get","bandIdx"], …]` expression; per-point bands are ring-differenced largest-first, largest pushed first. Outline `walkshed-line` has its own source `walkshed-line-src`. Green reachable-segments layer (`walkshed-seg`) at the largest budget only.
- `walkshed-seg` (reachable streets) is created with `layout.visibility: "none"`, so it starts hidden after a run; only the creating render sets this, so a re-run's `setData()` keeps the user's choice and clearing the results (which removes the layer) resets it. Visibility is controlled only from the Layers panel (`walkshed-fill` and `walkshed-seg` rows); there is no in-popup toggle (an old one fought the Layers panel over `visibility`). One repainter is registered under both `walkshed` and `walkshed-seg` styleKeys; it hides the legend's "Reachable streets" row (`#wsLegendRowSeg`) when the segment layer is hidden; `layers-panel.js` calls `App.repaintStyledLayers(entry.styleKey)` after every eye toggle so this updates live.
- **Flatten overlaps** (`App.layerStyles.walkshed.flatten`, via `spec.flattenOption` + `App.setLayerStyle`): display-only, re-renders the FILL as one polygon per distinct minutes value (unioned across points, minus all smaller values) so the shortest wins. `bands[]` and all study-area/export consumers are untouched. The outline keeps un-flattened per-point boundaries, drawn faint (`WS_OUTLINE_FLATTENED` `{width:1, opacity:0.12}` vs `WS_OUTLINE_NORMAL` `{width:2, opacity:0.9}`) because they now lie inside the merged fill. The repainter re-renders geometry (`renderWalkshedLayers(_lastEntries)`), not just paint.

**Results:** per-point-per-band table (`#wsResultsTable`); connector footer (`#wsConnReport`, from `App.getConnectorReportSummary()`, only when connectors exist); sidewalk coverage footer (`#wsCoverageReport`, from `App.getSidewalkCoverageSummary()`, only when a network is loaded); GeoJSON export (one feature per band per point with `minutes`/`bandIdx`). `computeRequiredExtent()` sizes download circles from the **largest** budget. The "Use N-min walkshed as study areas" button (`#wsUseStudyArea`) label uses `activeBudgets()[0]`, with a tooltip warning that it changes every downstream study area.

**Study-area integration:** a Point with `attributes.serviceAreaType === "walkshed"` gets its cached walkshed substituted for the circle in `points.js rebuildBuffers()`, so every study-area consumer uses it with no per-module change.

**Persistence:** schema **v3** (`budgets` array; v1/v2 single `minutes` migrates to a one-entry list; v1 `walkSpeedKmh` → `walkSpeedMph`). `collect(mode)` includes `lastEntries` (bands + `reachableSegments`) **only in `"full"` mode** (file save, not autosave, to keep autosaves small); `apply()` re-renders them immediately with no network needed. Restored polygons still pass through the `settingsKey` check, so after a network reload (new epoch) downstream consumers fall back to circles. A plain page reload shows no polygons until Calculate.

## walkshed-popup.html

Settings: three budget inputs `#wsMinutes`/`#wsMinutes2`/`#wsMinutes3` (reusing Transit Travelshed's `.ts-budget-row`/`.ts-budget-input`), walk speed, Advanced details (`maxEdge`, `#wsSnapTol`, `#wsCrossMajor`/`#wsCrossMinor` with help text that the penalty is node-uniform, not turn-aware, `#wsExcludedWaysCount`/`#wsClearExcludedWays`, `#wsEditStreets` toggle for map street-exclusion), point checklist `#wsPointList`, Calculate (disabled + `#wsNetWarn` with no network). Results: `#wsStatus.rf-status`, `#wsResultsTable`, study-area / Export GeoJSON buttons, `#wsEmptyState.rf-info-box`.

## walkshed-legend.html

Fill swatch + reachable-streets swatch (`.tpi-legend-*`).
