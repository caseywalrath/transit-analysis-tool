# Route Costing Module — Resume Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/route-costing.md. This file is historical.

Resuming from archived session. Two commits already on branch
`claude/resume-archived-session-IBiRG` (identical to the prior
`claude/plan-route-costing-module-HXoPP` branch):

- `e140c5e` — `avgSpeed` attribute defaults to 14 mph on routes and lines
- `8203aa6` — `projects/route-costing-popup.html` scaffold (Settings modal + 2-column body)

All subsequent steps below are proposed. Each one is small, committable, and
leaves the app in a working state so we can stop between any two steps.

---

## Design summary (already agreed in prior session)

- **Grouping**: Features with a shared `attributes.group` string form one
  Service (1–2 patterns). No `group` = a standalone 1-pattern Service.
- **Pattern cap**: Max 2 features per group in v1. 3+ refuses with a clear
  error.
- **Direction rules**:
  - 1 feature, `Both` → cycle = 2× one-way + layover.
  - 1 feature, `CW`/`CCW`/`Loop` → one-way loop, cycle = one-way + layover.
  - 2 features — pair must be opposites: NB+SB, EB+WB, Inbound+Outbound,
    CW+CCW. Anything else → warn-and-skip.
- **Cost inputs** (Settings modal, module-wide defaults):
  - Cost per platform hour, default deadhead %, layover (Minutes or % of
    round-trip), days/year for Weekday/Saturday/Sunday, fleet spare ratio,
    cost basis year label.
- **Math**:
  - one-way runtime = length / avgSpeed
  - round-trip runtime = 2 × one-way (or sum of both patterns' one-ways)
  - cycle = round-trip + layover
  - trips per band = `ceil(band hours / headway)`
  - daily rev-hrs = Σ (trips × one-way runtime)
  - daily plat-hrs = daily rev-hrs × (1 + deadhead %)
  - daily cost = daily plat-hrs × cost/hr
  - annual totals = daily × days/year per service type
  - peak vehicles (raw) = cycle / peak headway; (rounded) = ceil(raw);
    (with spares) = rounded × (1 + spare ratio)
- **Missing-data handling**: warn-and-skip per Service (missing `avgSpeed`,
  missing bands, mismatched pair, 3+ patterns).
- **Output**: per-Service table (expandable for per-band breakdown) +
  system summary (Σ rounded vs. Σ raw shows interline opportunity gap).
- **Nomenclature**: "Service" = costed entity. "Pattern" = underlying
  Route/Line feature.

## Carryover note — attribute key

Earlier CLAUDE.md documented `routeGroup`, but the current attribute popup
actually writes the key as `attrs.group`. The module will read
`attrs.group` to match what's written today.

---

## Sequenced steps

Each step = one approval + one commit. Order matters.

### Step 1 — Direction options: add CW / CCW

File: `js/core/feature-attributes.js:32`

Replace the direction options array from
`["Both","NB","SB","EB","WB","Inbound","Outbound","Loop"]`
with
`["Both","NB","SB","EB","WB","Inbound","Outbound","Loop","CW","CCW"]`.

No migration needed — old "Loop" values still accepted (treated as one-way
loop by the costing module).

Commit: `feat: add CW/CCW direction options for loop route pairing`

---

### Step 2 — Module skeleton + registration + script wiring

Files:
- `js/projects/route-costing.js` — new file. Minimal IIFE that:
  - Calls `App.registerModule({ id: "route-costing", … })`
  - `init()` wires Settings button (opens modal), Confirm/Cancel/Reset,
    layover-mode radio flipping the unit label, live days-sum display
  - `onOpen()` builds the Service checklist (populated in step 3, for now
    just shows "no routes/lines")
  - "Cost Services" button — stub that sets status to "Not implemented"
- `index.html` — add
  `<script src="js/projects/route-costing.js"></script>` after
  `corridor-scoring.js`.
- `css/style.css` — add a minimal `.rc-` block: `.rc-body`,
  `.rc-settings-grid` (label+input 2-col grid), `.rc-section-label`.

This step leaves a working "Route Costing" button in the Analysis panel
that opens the popup; the Settings modal is fully interactive; costing is
stubbed.

Commit: `feat: Route Costing module skeleton (registration, popup, settings modal)`

---

### Step 3 — Service assembly (left column checklist)

In `js/projects/route-costing.js`:
- `buildServicesFromFeatures()`: walks `App.routes` + `App.lines`, buckets by
  `attributes.group`, produces `[{ name, patterns:[{featureType, index, ref}],
  warnings:[] }]`.
- Renders `#rcServiceList` with one checkbox per Service (name = group name
  or `<route/line name> (solo)` for ungrouped).
- Validates each Service on build:
  - 3+ patterns → `warnings.push("3+ patterns — costing will skip")`
  - 2 patterns with non-opposite directions → `warnings.push("Directions
    not opposites")`
  - Missing `avgSpeed` on any pattern → warning
  - No service bands for any day → warning
- Warnings render as a `⚠` icon next to the checkbox with tooltip.
- Select All / Clear links wired.

Commit: `feat: Route Costing — assemble Services from features, validate pairings`

---

### Step 4 — Costing math engine (pure functions)

In `js/projects/route-costing.js`:
- `computeService(svc, settings)` — returns per-service totals:
  `{ roundTripMiles, cycleMin, dailyTrips:{wk,sa,su}, dailyRevHrs,
  dailyPlatHrs, annualPlatHrs, annualRevHrs, annualCost, peakVehiclesRaw,
  peakVehiclesRounded, fleetWithSpares, bandBreakdown:[…], warnings:[…] }`.
- `computeSystemSummary(serviceResults, settings)` — totals, Σ rounded vs.
  Σ raw (interline gap), annual miles, annual cost, daily trips.
- Rounding per band: `Math.ceil(band.hours / band.headwayMin * 60)` with
  zero/blank headway treated as "no service in that band" (skipped).
- Layover resolution: if mode=minutes, add directly; if mode=percent, add
  `percent × roundTripRuntime`.
- Pure functions — no DOM. Unit-testable by inspection.

Commit: `feat: Route Costing — cost math (runtime → cycle → trips → cost)`

---

### Step 5 — Results rendering

In `js/projects/route-costing.js` + `css/style.css`:
- On "Cost Services" click, iterate selected Services, call
  `computeService()`, render:
  - Per-Service table (columns: Name, Round-trip mi, Cycle min, Peak
    headway, Daily trips Wk/Sa/Su, Daily rev-hr, Daily plat-hr, Annual
    plat-hr, Annual cost, Peak veh raw/rounded/w-spares).
  - Expandable row showing per-band breakdown (trips, rev-hrs, peak veh).
  - System summary table (Services scored, Annual cost, Annual plat-hr,
    Annual rev-hr, Daily trips, Σ rounded fleet, Σ raw fleet, Interline
    opportunity gap).
- Warning rows get a ⚠ badge + skipped-from-totals note.
- Hide empty state, show status pill "Done — N services costed".

Commit: `feat: Route Costing — per-service and system summary tables`

---

### Step 6 — CSV export

In `js/projects/route-costing.js`:
- `exportCSV()` — header lines with settings (cost/hr, days, layover,
  deadhead, spare ratio, cost basis year) + per-service rows +
  system-summary rows. Triggers a browser download.
- Enable `#rcExportCSV` on successful run; disable on clear/stale.

Commit: `feat: Route Costing — CSV export`

---

### Step 7 — Session persistence

In `js/projects/route-costing.js`:
- `App.cache.registerModule("route-costing", { collect, apply })`.
- Persist settings object + last selected service keys + `_lastResult`
  summary. On restore, re-check boxes and re-render the last table if
  present.
- Schema version `1`.

Commit: `feat: Route Costing — session persistence`

---

### Step 8 — CLAUDE.md documentation

Add Route Costing section to `CLAUDE.md`:
- Under File Structure (projects + js/projects entries)
- Under Script Load Order
- Under Active modules
- New sub-section describing public/closure API, module-local state,
  settings, cost math summary.
- Note the `routeGroup` → `group` attribute-key correction flagged during
  this work.

Commit: `docs: document Route Costing module in CLAUDE.md`

---

### Step 9 — Push branch

`git push -u origin claude/resume-archived-session-IBiRG`.

No PR (per instructions — only create PRs on explicit request).

---

## Smoke-test checklist (before pushing)

- Draw 2 routes, set one NB and one SB with same `group`, both 10 mi,
  14 mph, weekday band 6–22 @ 30-min headway. Cost Services. Check that
  round-trip = 20 mi, cycle ≈ 1h 25m + 10m layover, daily trips = 32,
  annual cost ≈ plausible. Export CSV, verify columns.
- Single `Both` route: check cycle = 2× one-way.
- 3-feature group: confirm warn + skip.
- Mismatched pair (NB + EB): confirm warn + skip.
- Missing avgSpeed: confirm warn + skip.
- LODES not loaded — unrelated, no impact expected.
- Reload session: verify settings + selections restore, last table re-renders.

---

## Not in v1 (deferred)

- Interline optimization logic (the summary just shows the raw-vs-rounded
  gap).
- 3+ patterns per Service.
- Fare revenue / net cost.
- Per-service overrides for cost/hr, deadhead, layover (user may request
  later — modal-only for now).
- Inflation adjustment.
- Renaming `attrs.group` ↔ `routeGroup` across the codebase — out of
  scope; fix separately.
