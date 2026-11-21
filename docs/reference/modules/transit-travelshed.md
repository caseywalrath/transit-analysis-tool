# Transit travelshed

Read the code when this and the code disagree. See `docs/archive/transit-travelshed-plan.md` and `docs/archive/transit-travelshed-v2-walk-caps-plan.md`.

## transit-travelshed.js (module `"transit-travelshed"`)

Walk → wait → ride drawn routes/lines → walk isochrones from a clicked origin, at most one transfer, 1-3 banded rings.

**Origin:** a probe, NOT an `App.points` feature — "Pick origin on map" arms a one-shot `App.drawMode === "ts-origin"` click (precedent: `textboxes.js` `_initDrawMode`), shown as one `maplibregl.Marker`.

**Settings (`DEFAULT_SETTINGS`):** budgets 15/30/blank (min); walk speed 3.1 mph; day + time (`App.getEffectiveServiceBands` picks each feature's active band; no band or blank/0 frequency excludes the feature — disclosed, not an error); wait model `maxWaitMin` 10, `boardPenaltyMin` 1 (capped initial wait, uncapped transfer wait); `shedMode` `"transit"` (default, walk legs capped) or `"door"` (walk may use the whole budget; cap inputs disabled); caps `maxAccessWalkMi` 0.5, `maxEgressWalkMi` 0.25, `maxTransferWalkMi` 0.25; `stopSpacingMi` 0.25 (synthetic stops when a feature has no associated stop Points). The Advanced snap tolerance (`#tsSnapTol`) reads/writes the GLOBAL `App.networkSettings.snapToleranceFt`, shared with Walkshed; on change it calls `App.refreshNetworkConnectors()` and marks stale.

**Stops:** real stops are Points whose `attributes.associatedRoutes` reference the feature, resolved by stable `routeIdx`/`lineIdx`, never array index.

**Floods:** per-stop walk-flood cache keyed `stopKey|networkEpoch|budgetKm`, filled chunked-async via `App.computeWalkCostMap`. In `"transit"` mode the origin flood radius is `min(budgetKm, accessCapKm)` and stop floods `min(budgetKm, max(egressCapKm, transferCapKm))`; `"door"` floods at the full max budget. `ensureFloods()` yields every 5 stops or ≥50 ms (yielding per stop cost ~4 ms each across hundreds of stops) but updates the status every stop. `snapMs`/`floodMs` are summed and shown in the results footer — snapping, not flood radius, was the measured bottleneck.

**Engine:** `window.Travelshed.computeArrivalTimes` (`js/core/travelshed.js`) on plain JSON; the three walk caps (minutes) are passed only in `"transit"` mode. `Travelshed.bandNodeSets` drives only per-band node counts. Band **geometry** is a cluster union: the origin/access blob plus one polygon per alighting stop (engine `alightings`), each capped and polygonized via `App.polygonizeNodeSet`, combined with `App.foldAnalysisUnion` — so one hull can't bridge unreachable space between stop clusters. Bands are ring-differenced largest-first (a `turf.difference` failure falls back to the undifferenced polygon).

**Prompt-to-download:** Calculate checks that `App.getRoadDownloadExtent()` contains the required extent (origin walk circle ∪ walk buffer around each selected feature; capped per mode); if not, it offers `App.fetchRoadNetworkForExtent` and re-runs on success. A file-imported network (unknown extent) gets a soft warning, not a block.

**Results:** per-band area + node count table, per-route disclosure panel with a walk-caps footer ("Door-to-door — walk uncapped" in door mode), connector line (`connectionReportHTML()` ← `App.getConnectorReportSummary()`), sidewalk coverage line (`coverageReportHTML()` ← `App.getSidewalkCoverageSummary()`), legend with dynamic band labels, GeoJSON export (rings + origin + metadata incl. `shedMode` and caps).

**Persistence:** settings-only, `v: 3` (origin, budgets, wait model, spacing, shed mode + caps, `selectedRouteIds` keyed by stable routeIdx/lineIdx, and the schedule-mode fields `serviceMode`, `windowFrom`, `windowTo`, `stepMin`, `statistic`, `includeHidden`). v1/v2 payloads restore via `DEFAULT_SETTINGS` fallbacks and always load as headway mode (their schedule fields, if any, are ignored). Geometry is not persisted; export stays disabled until Re-run.

## Schedule mode

`settings.serviceMode` (`"headway"` default | `"schedule"`), chosen in the "Service" select at the top of the inputs (`#tsServiceMode`). Schedule mode ("Schedule (GTFS + proposals)") routes over real timetables: the loaded GTFS feed on its analysis date plus drawn Services with schedules, built by `App.buildAnalysisNetwork` and routed by `App.computeScheduleTravelshed` (`js/core/analysis-network-source.js`; Raptor, up to two transfers). This module only gathers inputs, draws and reports.

**Inputs:** `.ts-headway-only` elements (day/time, wait model, route checklist, stop spacing, shed mode) are hidden and `.ts-schedule-only` ones shown: departure window From/To (`#tsWindowFrom`/`#tsWindowTo`, default 07:00-08:00, To must be after From), "Every N min" (`#tsStepMin`, default 2), statistic (`#tsStatistic`: Typical = median, Best case = minimum time, Worst case = 90th percentile), `#tsIncludeHidden`, and a read-only `#tsDateLine` (the GTFS analysis date and day type, or "No GTFS feed: drawn Services only."). The date itself is changed in GTFS Feed Attributes. Access / egress / transfer caps (0.5 / 0.25 / 0.25 mi) stay and are always on, since door-to-door has no meaning here.

**Calculate:** origin, budgets and the road-network prompt-to-download run through the shared `coverageGate()`. In schedule mode the required extent is the origin's access circle plus each drawn Route/Line buffered by the egress/transfer cap (hidden ones only with Include hidden); GTFS stops outside the loaded streets cannot be known beforehand and are simply left without an egress walk. Bands from `result.bands` go through the same `buildRings` ring differencing, layers, legend and style options as headway mode. With no stop within the access walk the status reads "No stops within walking distance of the origin." and the walk-only band is still drawn. "Stops within reach" counts every stop the router arrived at, including those reached on foot from the origin.

**Results:** the table has Budget and Area only (no node counts) and a timing footer; `#tsRouteDetail` holds the summary line ("D departures 07:00-08:00 every 2 min · typical (median) · S stops within reach · A stops within walk of the origin"; S counts stops reached by a ride under the chosen statistic), the analysis date and day type with GTFS / drawn trip counts (or "drawn Services only"), the network notes, skipped drawn Services, the transfer rule ("walk up to ¼ mi, straight line × 1.3") and, when `result.egressUnsnapped` > 0, "K reached stops are beyond the loaded streets, so no walk is drawn from them." Routing time is in the table footer only. A window whose To is before its From runs past midnight. The legend footnote has the id `#tsLegendNote`. Known gap: the road-network coverage check covers the origin and drawn lines, not GTFS stops elsewhere; reached stops beyond the loaded streets are only counted in the note. The legend footnote (set in `showLegend`) reads "Walk → ride scheduled trips → walk, ≤2 transfers." in this mode. Export metadata adds `serviceMode`, `window`, `stepMin`, `statistic`, `departures`, `analysisDate`, `dayType` and `includeHidden`; band features carry `nodeCount: null`.

**Stale:** the result is stale on any input change, on `App.gtfsAnalysisDate.onChange` (also fired when a feed loads or is cleared), on `update()`, and when the loaded feed object differs from the one the result used (`feedId()`, the same identity idea as Title VI's `seSignature`; checked when the panel opens). Unlike headway results, a schedule result survives having no drawn Routes/Lines (GTFS alone is enough). Test: `test/browser/travelshed-schedule.test.mjs`.

## transit-travelshed-popup.html

Service select (`#tsServiceMode`), schedule inputs (`#tsWindowFrom`/`#tsWindowTo`/`#tsStepMin`/`#tsStatistic`/`#tsIncludeHidden`/`#tsDateLine`, see Schedule mode), origin block (`#tsPickOriginBtn`/`#tsOriginLabel`/`#tsClearOriginBtn`), `#tsBudget1/2/3`, walk speed, day/time, wait inputs + info (`#tsWaitInfoBtn`/`#tsWaitInfoText`), walk limits (`#tsShedMode`, `#tsAccessWalk`/`#tsEgressWalk`/`#tsTransferWalk`, `#tsWalkCapsInfoBtn`/`#tsWalkCapsInfoText`), stop spacing, `#tsRouteList`, Advanced shape fields, network state (`#tsNetWarn`/`#tsCoverageWarn`/`#tsDownloadBtn`), `#tsRunBtn`. Results: `#tsStatus.rf-status`, `#tsResultsTable`, `#tsRouteDetail`, `#tsExportBtn`, `#tsEmptyState.rf-info-box`.

## transit-travelshed-legend.html

3 rows (`#tsLegendRow0/1/2`, `#tsLegendLabel0/1/2`, `.tpi-legend-*`); the module fills "≤ N min" labels and hides unused rows after mount.

## Boundary shape

Same shared `App.networkSettings.walkShape` as Walkshed (fields `#tsHoleAcres`, `#tsGridFt`, `#tsOffStreetFt`, marked "Shared with Walkshed"); a change marks this module stale via `App.onWalkShapeChange`. There is no per-run cache keyed on the shape (only the stale flag), and no comparison overlay (Walkshed only).

Each band is one traced surface from `engineResult.nodeTimes` (minutes; already the fastest path with access/egress walk caps applied): `App.contourSamples(nodeTimes, maxBudgetMin, gridKm × 2, walkMinPerKm, false)` with `gridKm = WalkShape.scaledGridKm(shape.gridKm, maxBudgetMin / 15)`, then `WalkShape.contour(..., {costPerKm: walkMinPerKm})`. `partialEdges` is false so no sample walks past a capped node; the off-street reach can still extend up to 330 ft beyond a cap. Disjoint walk areas stay disjoint (grid points beyond the reach of every sample are unreachable). This replaced a union of per-cluster concave hulls (origin access walk + each alighting stop's egress walk), which drew each stop as a separate small shape; on a stop-heavy test route the traced corridor is ~1.5× that area. Large travelsheds coarsen the grid; `_lastResult.contourGridKm` vs `contourGridAskedKm` (the budget-scaled grid) drives the `#tsGridNote` line, so only cell-cap coarsening is reported. History: `docs/archive/walkshed-simplified-shape.md`. Test: `test/browser/walkshed-contour.test.mjs` (end-to-end run with one route).

## Style options

Same display-only options as Walkshed (`App.resolveShedStyle("transit-travelshed")`; see `layers-and-styling.md`). The outline layer `ts-travelshed-line` has its own source `ts-travelshed-line-src`: empty by default, the band rings' edges when Band outlines is on (one origin set, so the rings already are the merged per-band boundaries). The repainter re-sets that source from the last rendered rings (`_lastRings`), so a style change never recomputes. `clearTravelshedLayers` removes the line source too.
