# GTFS Service Analysis

Read the code when this and the code disagree. Design record: `docs/archive/A5-plan.md`.

## gtfs-service-analysis.js (module `"gtfs-service-analysis"`, no public API)

Tabbed analysis (`[data-tab]` + `switchTab`, shared `.rf-tab` classes) over the loaded GTFS timetable.
All numbers come from `window.GtfsSchedule` (`gtfs.md`); this file gathers inputs, renders, exports CSV and
owns two map layers. DOM ids `gsa…`, styles `.gsa-`. Loads after `gtfs.js`.

**Scope (both tabs):** the GTFS analysis date (`App.gtfsAnalysisDate`, editable here), hidden routes left
out unless "Include hidden routes" (`App.gtfsScopeRouteIds(includeHidden)`), and on the Stops tab the GTFS
stop selection as an optional filter (`App.gtfsStops.ids()`).

**State:** a normal Run-button module. Each tab keeps its own result and a JSON signature of its inputs;
`App.gtfsOnInputsChange` (feed, date, hidden routes, day parts, stop list) and settings edits re-check the
signature and show the shared stale banner through `App.renderModuleState`. Removing the feed drops both
results and the map layers. Results are not saved in the session; settings, rate overrides, the two
toggles and the active tab are (`App.cache` key `"gtfs-service-analysis"`, `v: 1`).

**Service & Cost:** `GtfsSchedule.serviceYear` on one date per day type (`App.gtfsRepresentativeDates()`:
the analysis date when it is an ordinary day of that type, else the busiest such date) plus
`calendarDayCounts` as the cross-check.
- Settings (Route Costing's defaults): cost per hour 150, basis revenue | platform, deadhead 15 % of
  running hours, layover when there are no blocks (10 min per round trip = 5 per one-way trip, or % of
  running time), longest in-block layover 60 min, days per year 255 / 52 / 58.
- Hours (D6): running = Σ trip run time; revenue = running + layover; platform = revenue + deadhead.
  Layover: a blocked trip takes the gap to the next trip of its block (0 < gap ≤ the in-block limit),
  other trips the setting; each day names its method (block / setting / mixed).
- Peak vehicles (D7): most intervals overlapping, a block being one interval, an unblocked trip its run
  plus layover. The system peak is computed over all trips, never summed from routes.
- Per-route rate overrides keyed by `route_id`; finite and > 0 or ignored (Route Costing's rule). Editing
  one marks the result stale.
- Route details get a **Cost** tab (`App.gtfsAddRouteTab`): that route's weekday / Saturday / Sunday / year
  figures with the current settings, redrawn instantly.
- Cross-check with Route Costing on a Service copied with its schedule: trips equal; running hours equal
  to rounding; revenue, platform and cost differ by the layover method (Route Costing charges per cycle,
  this summary per trip or from blocks) and peak vehicles by method (headway formula vs overlap count).

**Stops:** `stopSpacingStats` (five half-open bands from four editable limits, 600 / 750 / 1,320 /
2,640 ft), `consolidationCandidates` (pairs under the first limit on dominant patterns; the stop with fewer
trips is removed, never a pattern's first or last stop or a station stop; saving = seconds per stop × its
trips per day, labelled an upper bound, with the extra walk), `stopServiceTable` (one pass over the day)
and `wheelchairByRoute`. Each section is a `<details>` with a one-line summary and its own CSV.

**Map layers:** `gsa-stop-service-layer` (circles coloured by trips per day, steps in `RAMP`) and
`gsa-candidates-layer` (red rings on stops a consolidation would remove), both inserted below
`App.firstUserLayer()`, both shown only by their section toggles and removed with the results.

## Feed health

Third tab (`_activeTab` is `"service" | "stops" | "health"`; per-tab hint, result, stale flag and re-run live
in the `TABS` table). **Check feed** runs `GtfsSchedule.feedHealth(feed, { today: App.gtfsToday(), shapes:
App.gtfsShapeCoords(), maxExamples: 20 })` in a `setTimeout` so the "Checking feed…" status paints first, stores
`_healthResult = { feed, checks, today, ms }` and hands the checks to `App.gtfsSetHealth` so the GTFS Overview
shows a one-line summary. The checks are read-only and never block an analysis.

The result is a seven-row table (Check, Result, Found, Checked); rows with examples expand to a sub-table whose
columns depend on the check id (`HEALTH_COLS`), kept in `_ui.health.expanded`. A result has no stale state: it
is dropped (like the other two) when the loaded feed object changes, and `clearAll()` also calls
`App.gtfsSetHealth(null)`. Results are not saved in the session. The CSV (`feed-health.csv`) has one row per
check with its examples as `key=value` pairs. Browser test: `test/browser/gtfs-feed-health.test.mjs`.

## gtfs-service-analysis-popup.html

Scope row (date, include hidden), tab bar, shared status and empty-state slots, per tab a `<details>`
settings block, a Run button in `.module-input-actions` and a results host.
