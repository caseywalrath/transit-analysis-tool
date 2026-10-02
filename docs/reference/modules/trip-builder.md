# Trip builder

Read the code when this and the code disagree.

## trip-builder.js (module `"trip-builder"`, no public API)

Generates a high-level trip schedule (Start/End per direction per day type) from each Service's time bands, frequency and run time / avg speed. Not a GTFS-quality schedule (no time points). No Census/LODES/TPI dependency. DOM ids use the `tb` prefix, styles `.tb-` (reusing `.rf-` and `.rc-` pill/badge classes).

**Service assembly** is shared with Route Costing via `App.buildTransitServices()` (`js/core/service-assembly.js`, default runtime mode `"either"`: a pattern needs `runTime` OR `avgSpeed`). Same 1/2/3+-pattern grouping by `attributes.serviceId` and direction-pair validation.

**Service list (`#tbServiceList`):** single-select. A Service with blocking warnings is still selectable and shows an amber "Needs setup" chip (`.tb-svc-setup-chip`, warnings in `title`) instead of the ⚠ badge (every current warning is blocking, so showing both was redundant). Selecting it renders the setup panel (`#tbSetup`, `renderSetupPanel`) listing its warnings with a "Set up this Service" button; `#tbGenerateBtn` is disabled while `App.hasBlockingWarnings(svc)` (backstop for `runGenerate()`'s own guard).

**Header (`#tbHeader`):** summary table (Span / Frequency / Run Time / Avg Speed × Wk/Sa/Su, via `summarizeService`: spans touch-or-overlap merged, wrapping bands shown mod 24; headways unique non-zero `/`-joined; run time `~`-prefixed when derived; mismatched paired values slash-joined), Edit button `#tbEditBtn`, per-pattern details drawer.

**Edit popup (`openEditPopup`):** mounts in the shared `#fp-mini-popup` via `App.openMiniPopup`; per pattern: Service (`serviceId`, binds on `change` not `input` so typing doesn't re-key every keystroke; uses `fp-service-datalist`), Direction, Run time, Avg speed, and `App.buildServiceScheduleEditor(feature)`. Inputs write `feature.properties.attributes` directly. Each edit calls `refreshAfterEdit(anchor)`: save cache, rebuild services, **re-resolve the selection by the anchor pattern's `{featureType, featureId}`** (not by key — editing the Service id can re-key or split the Service), drop `_tripsByService` entries whose key vanished, re-render. `App.notifyProject()` fires on close. Accepted limitation: if a re-key splits the Service while open, the popup's title/blocks go stale until reopened (fields still bind to the right features).

**Generation:** per pattern × day, per band with non-zero `frequency`: trips at `from, from+f, …` while `t < to`; end = start + one-way runtime. Wrapping bands add 1440 to `to`; display is `t mod 1440` (no "+1d"). Trips ending past the band end are still generated (Route Costing convention).

**Runtime:** `oneWayRuntimeMin(pattern)` = `runTime` when > 0, else `lengthMiles / avgSpeed × 60`, else 0 (blocked). `runTime` always wins; no mode setting.

**Columns:** 3+ patterns → one column per pattern (`"<direction> · <pattern name>"` when directions repeat; max 3 per grid row). 2 patterns → one per direction. Solo `Both` → derived `Outbound*` / `Inbound*` with simultaneous trips. Solo Loop/CW/CCW → one column. Order: NB/EB/Outbound/CW/Outbound* first, SB/WB/Inbound/CCW/Inbound* second. Columns colored by feature color.

**Trip deletion:** per-row trash splices one trip; Generate again wipes manual deletions for that Service only. No add-trip UI.

**CSV:** `Service, Day, Direction, Trip #, Start, End, Runtime (min)`; filename `trip-builder_<service-name>_<timestamp>.csv`.

**Persistence:** `App.cache.registerModule("trip-builder", …)` — `selectedKey`, `tripsByService`. Schema **v2** (ID-based solo keys); v1 keys migrate via `App.migrateServiceKey`, unresolvable ones dropped. `getFeatureFromPattern` resolves by `featureId` at use time. `update()` marks state stale when features change.

**Not built:** add-trip, layovers between trips, per-pattern offsets (enter them in bands), blocking, Route Costing integration.

## trip-builder-popup.html

`#tbServiceList`; right: status pill, `#tbHeader`, `#tbGenerateBtn`, `#tbResults` (`.tb-day-section` / `.tb-day-grid`), `#tbExportCSV`, `#tbEmptyState` (points the user at in-module setup).
