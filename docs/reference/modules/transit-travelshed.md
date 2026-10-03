# Transit travelshed

Read the code when this and the code disagree. See `docs/archive/transit-travelshed-plan.md` and `docs/archive/transit-travelshed-v2-walk-caps-plan.md`.

## transit-travelshed.js (module `"transit-travelshed"`)

Walk → wait → ride drawn routes/lines → walk isochrones from a clicked origin, at most one transfer, 1-3 banded rings.

**Origin:** a probe, NOT an `App.points` feature — "Pick origin on map" arms a one-shot `App.drawMode === "ts-origin"` click (precedent: `textboxes.js` `_initDrawMode`), shown as one `maplibregl.Marker`.

**Settings (`DEFAULT_SETTINGS`):** budgets 15/30/blank (min); walk speed 3.1 mph; day + time (`App.getEffectiveServiceBands` picks each feature's active band; no band or blank/0 frequency excludes the feature — disclosed, not an error); wait model `maxWaitMin` 10, `boardPenaltyMin` 1 (capped initial wait, uncapped transfer wait); `shedMode` `"transit"` (default, walk legs capped) or `"door"` (walk may use the whole budget; cap inputs disabled); caps `maxAccessWalkMi` 0.5, `maxEgressWalkMi` 0.25, `maxTransferWalkMi` 0.25; `stopSpacingMi` 0.25 (synthetic stops when a feature has no associated stop Points); hull `maxEdgeKm` 0.3 stored in **km**, displayed in **feet** (984) via `FT_PER_KM`. The Advanced snap tolerance (`#tsSnapTol`) reads/writes the GLOBAL `App.networkSettings.snapToleranceFt`, shared with Walkshed; on change it calls `App.refreshNetworkConnectors()` and marks stale.

**Stops:** real stops are Points whose `attributes.associatedRoutes` reference the feature, resolved by stable `routeIdx`/`lineIdx`, never array index.

**Floods:** per-stop walk-flood cache keyed `stopKey|networkEpoch|budgetKm`, filled chunked-async via `App.computeWalkCostMap`. In `"transit"` mode the origin flood radius is `min(budgetKm, accessCapKm)` and stop floods `min(budgetKm, max(egressCapKm, transferCapKm))`; `"door"` floods at the full max budget. `ensureFloods()` yields every 5 stops or ≥50 ms (yielding per stop cost ~4 ms each across hundreds of stops) but updates the status every stop. `snapMs`/`floodMs` are summed and shown in the results footer — snapping, not flood radius, was the measured bottleneck.

**Engine:** `window.Travelshed.computeArrivalTimes` (`js/core/travelshed.js`) on plain JSON; the three walk caps (minutes) are passed only in `"transit"` mode. `Travelshed.bandNodeSets` drives only per-band node counts. Band **geometry** is a cluster union: the origin/access blob plus one polygon per alighting stop (engine `alightings`), each capped and polygonized via `App.polygonizeNodeSet`, combined with `App.foldAnalysisUnion` — so one hull can't bridge unreachable space between stop clusters. Bands are ring-differenced largest-first (a `turf.difference` failure falls back to the undifferenced polygon).

**Prompt-to-download:** Calculate checks that `App.getRoadDownloadExtent()` contains the required extent (origin walk circle ∪ walk buffer around each selected feature; capped per mode); if not, it offers `App.fetchRoadNetworkForExtent` and re-runs on success. A file-imported network (unknown extent) gets a soft warning, not a block.

**Results:** per-band area + node count table, per-route disclosure panel with a walk-caps footer ("Door-to-door — walk uncapped" in door mode), connector line (`connectionReportHTML()` ← `App.getConnectorReportSummary()`), sidewalk coverage line (`coverageReportHTML()` ← `App.getSidewalkCoverageSummary()`), legend with dynamic band labels, GeoJSON export (rings + origin + metadata incl. `shedMode` and caps).

**Persistence:** settings-only, `v: 2` (origin, budgets, wait model, spacing, hull, shed mode + caps, `selectedRouteIds` keyed by stable routeIdx/lineIdx). v1 payloads restore via `DEFAULT_SETTINGS` fallbacks. Geometry is not persisted; export stays disabled until Re-run.

## transit-travelshed-popup.html

Origin block (`#tsPickOriginBtn`/`#tsOriginLabel`/`#tsClearOriginBtn`), `#tsBudget1/2/3`, walk speed, day/time, wait inputs + info (`#tsWaitInfoBtn`/`#tsWaitInfoText`), walk limits (`#tsShedMode`, `#tsAccessWalk`/`#tsEgressWalk`/`#tsTransferWalk`, `#tsWalkCapsInfoBtn`/`#tsWalkCapsInfoText`), stop spacing, `#tsRouteList`, Advanced `maxEdge`, network state (`#tsNetWarn`/`#tsCoverageWarn`/`#tsDownloadBtn`), `#tsRunBtn`. Results: `#tsStatus.rf-status`, `#tsResultsTable`, `#tsRouteDetail`, `#tsExportBtn`, `#tsEmptyState.rf-info-box`.

## transit-travelshed-legend.html

3 rows (`#tsLegendRow0/1/2`, `#tsLegendLabel0/1/2`, `.tpi-legend-*`); the module fills "≤ N min" labels and hides unused rows after mount.
