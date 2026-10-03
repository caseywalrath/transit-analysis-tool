# Route costing

Read the code when this and the code disagree. Design history: `docs/archive/route-costing-plan.md`.

## route-costing.js (module `"route-costing"`, no public API)

Daily/annual operating cost for transit Services assembled from drawn Routes/Lines. Purely attribute-driven (length via turf, `avgSpeed`/`runTime`, `direction`, service bands); no Census/LODES/TPI dependency. DOM ids use the `rc` prefix, styles `.rc-` (reusing `.rf-` layout classes).

**Service assembly** is shared: `App.buildTransitServices({ runtimeMode })`, `App.directionSummary`, `App.hasBlockingWarnings` in `js/core/service-assembly.js`. It walks `App.routes` + `App.lines`; features sharing `attributes.serviceId` form one Service (1, 2 or 3+ patterns); others are 1-pattern Services. Blocking warnings: `Both`/blank direction on any pattern of a 3+-pattern Service; a 2-pattern Service without valid opposites (NB+SB, EB+WB, Inbound+Outbound, CW+CCW); a 1-pattern Service with a cardinal direction; missing speed (speed mode) or run time (runTime mode); no band with a headway. Blocked Services render red and are skipped. `attributes.group` has no costing meaning.

**Runtime mode** (`settings.runtimeMode`): `"speed"` → `lengthMiles / avgSpeed`; `"runTime"` → `pattern.runTime / 60` (minutes attribute). `oneWayRuntimeHrsFromSettings(pattern, settings)` is the single branch point.

**Cost math** (pure; test hook `App._rcTest`, golden-tested incl. `service/three-pattern-*`):
- `computeRoundTrip(svc, settings)` → `{ rtHrs, rtMiles, oneWays[] }`: paired sums both one-ways; solo `Both` doubles; `Loop`/`CW`/`CCW` one-way is the cycle; 3+ returns sums (display only).
- `computeLayoverHrs(rtHrs, settings)`: minutes mode `layoverValue/60`; percent mode `rtHrs × layoverValue/100`.
- `cycleHrs = rtHrs + layoverHrs`; `tripsPerCycle` 2 (paired/Both), 1 (loop), N (3+).
- **3+ patterns** (the only path that differs; 1-2-pattern math is golden-pinned): each pattern is a one-way trip stream, layover per trip = `computeLayoverHrs(2 × oneWay_p) / 2`, daily peak vehicles = `ceil(Σ_p (oneWay_p + layover_p) × 60 / minHeadway_p,day)` over patterns running that day. The list pill reads "Grouped" instead of "Paired".
- Per band: `trips = ceil(hours × 60 / headwayMin)`; blank/0 headway = no service; midnight-wrap bands supported. `platHrs = revHrs + layoverHrs + deadheadHrs`, `deadheadHrs = revHrs × deadheadPct/100`.
- Each day type has its own min headway → peak vehicles; Service peak fleet = max across day types.
- `computeSystemSummary(serviceResults, settings, intGroups)` → per-day and total metrics, `fleetSumRounded`, `fleetSumRaw` (theoretical interline min), `fleetWithSpares`.
- `computeInterlinesEffect(serviceResults, intGroups)`: per group of ≥2, `savings[day] = Σ peaks − max peak`.

**Interlines:** the UI and pooling logic exist but `#rcInterlinesBtn` is `disabled` in the popup HTML. **Do not enable** without reviewing the fleet-pooling logic.

**Results:** Skipped block, Weekday/Saturday/Sunday tables, Total (annualized) table with expandable band breakdown, and a Wk/Sa/Su/Total system summary. CSV export includes Day Type and explicit layover/deadhead.

**Costing Settings modal** (`rcSettingsModal`): cost/platform hr, deadhead %, layover mode (`minutes`/`percent`) + value, days/year Wk/Sa/Su (sum turns red over 366), spare ratio %, cost basis label, runtime mode (`rcRuntimeMode`). Confirm re-validates and marks results stale.

**Persistence:** `App.cache.registerModule("route-costing", …)` — `settings`, `selectedKeys`, `interlineGroups`, `lastSummary` (per-Service `perDay` totals, no band breakdown). Schema **v3** (solo Service keys ID-based, e.g. `"solo-route-id12"`); v2/v1 restore (v1 summaries dropped). `restoreRcState` migrates `"group-…"` → `"service-…"` and index solo keys → ID keys via `App.migrateServiceKey` in selections, interline groups and summary rows (unresolvable keys dropped from selections/groups, kept verbatim in the summary). Checkbox state is re-read by key on every `update()`, so selection survives deletes/merges of earlier features.

**Not built:** fare/revenue, per-Service cost overrides, inflation.

## route-costing-popup.html

Costing Settings modal, Interlines modal (button disabled), Service checklist with Select all / Clear, Cost Services button, results tables, system summary, CSV export.
