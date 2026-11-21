# A5 — GTFS service and cost summary; Stop Analysis (sub-plan)

**Status:** done (2026-11-21); archived. Parent plan: `docs/gtfs-expansion-plan.md` § A5.

## Code facts verified (base commit `9677892`)

- Engine `js/core/gtfs-schedule.js`: `dayEntries(feed, date)` (cached day expansion, frequency runs
  expanded, each trip `{tripId, routeId, directionId, blockId, serviceId, shapeId, start, end, generated}`),
  `routeDaySummary`, `peakVehicles(feed, date, {layoverSec})` (D7, whole feed, fixed 600 s default),
  `dominantPattern`, `patterns`, `stopSummary`, `stopAccessibility`, `busiestDate`, `dateRange`,
  `activeServices`, `dayType`, private `stopMeters`, `maxOverlap`, `medianSec`, `partHeadways`.
- Route Costing (`js/projects/route-costing.js`) settings: `costPerHour 150`, `rateBasis "revenue"`,
  `deadheadPct 15` (of running hours), `layoverMode "minutes"|"percent"`, `layoverValue 10` (minutes per
  **cycle** = round trip, or % of round-trip time), days 255 / 52 / 58. Per-Service rate overrides in module
  state, saved in the session. No public API.
- `js/projects/gtfs.js`: `App.gtfsSchedule()`, `App.gtfsAnalysisDate.get/set/onChange`, `App.gtfsDayParts`,
  `App.gtfsHiddenState`, `App.gtfsStopList`, `App.gtfsHighlight`, `App.gtfsZoomTo`, `App.gtfsOpenDetails`;
  private `representativeDates()` (analysis date if ordinary of that type, else busiest such date),
  `scheduleRouteIds(includeHidden)`, `_routeTabs`.

## Fixed decisions

- **G5a (annual day counts).** Yearly = Σ day-type figure × editable day count (defaults 255 / 52 / 58, the
  Route Costing defaults). Weekly = 5 × weekday + Saturday + Sunday. The feed calendar's own count of
  service days per type, scaled to 365, is shown under it as a cross-check.
- **One date per day type** = `representativeDates()` from A3 (shared, now `App.gtfsRepresentativeDates()`).
- **G5b (one tabbed analysis).** New module `"gtfs-service-analysis"`, "GTFS Service Analysis", tabs
  **Service & Cost** and **Stops** (`[data-tab]` + `switchTab`). Later phases add Compare and Feed health.
  Files `js/projects/gtfs-service-analysis.js`, `projects/gtfs-service-analysis-popup.html`, CSS prefix
  `.gsa-`. It is a normal analysis: Run button, stale banner via `App.renderModuleState` (date, hidden
  routes, day parts, stop list, settings or feed change mark it stale). G4b's instant rule covers only the
  details views; the route **Cost** tab there is instant.
- **G5c (layover).** Per trip: a trip with a `block_id` (not a frequency-generated run) takes the gap to
  the next trip of its block as layover, when 0 < gap ≤ max layover (default 60 min; longer gaps mean the
  bus left service). Trips without a block take the setting: minutes mode = `layoverValue / 2` minutes per
  one-way trip (Route Costing's value is per round trip), percent mode = running × value %. The result
  labels the method: `block`, `setting` or `mixed`.
- **Hours (D6).** Running = Σ (last arrival − first departure) per trip. Revenue = running + layover.
  Platform = revenue + deadhead, deadhead = running × deadhead % (Route Costing's formula).
- **Peak vehicles (D7).** Per route and for the system, on each day type's date: blocked trips are grouped
  by block (system) or by route + block (per route), each group spanning first departure to last
  arrival; unblocked trips are intervals extended by their setting layover; the peak is the most intervals
  overlapping. System peak is not the sum of route peaks (D8). Method named.
- **Cost.** Rate × revenue or platform hours (the chosen basis, named in every header and CSV).
  Per-route rate overrides are keyed by `route_id`, saved in the module's session state; blank, 0 or text
  falls back to the default rate (Route Costing's `sanitizeRate` rule).
- **Settings** are the module's own, with Route Costing's defaults, saved in the session; a "Use Route
  Costing settings" button is not built (Route Costing has no public API and D14 keeps it unchanged).
- **G5d (consolidation).** Candidates are consecutive stops on a route's dominant pattern closer than the
  first spacing threshold (600 ft). The stop removed is never the first or last stop of any route's
  dominant pattern; pairs with a station stop are skipped.
  The stop with fewer trips that day is the one to remove. Saved time = seconds per removed stop
  (default 20) × its trips per day, labelled "upper bound: assumes every trip stops there", shown with the
  extra walk (up to the distance to the kept stop).
- **Spacing bands (F3 fixed).** Five half-open bands from four editable thresholds (600 / 750 / 1,320 /
  2,640 ft): Very close, Close, Target, Wide, Very wide. Every segment lands in exactly one band.
  Percentiles use linear interpolation between ranks.
- **Scope.** Hidden routes excluded unless "Include hidden routes" (D9); the analysis date; the stop
  selection list as an optional filter on the Stops tab (a segment counts when either end is selected).
- **Cross-check.** A route copied as a Service (A3) and costed in Route Costing with the same settings
  agrees with this summary: trips exactly, running hours within 0.1 h; revenue / platform / cost within 2 %
  when the feed has no blocks for that route. Differences come from layover (Route Costing charges per
  cycle from the timetable's headways; this summary charges per trip or from blocks) and peak vehicles
  (Route Costing's headway formula vs the overlap count). Documented in the "How this is computed" note.
- **Not built:** revenue miles, fare revenue, interlining.

## Packages

| Id | Class | Work |
|---|---|---|
| A5.1 | [H] | Engine: `routeServiceDay`, `serviceYear`, `calendarDayCounts` + golden cases |
| A5.2 | [S] | Engine: `stopSpacingStats`, `consolidationCandidates`, `stopServiceTable`, `wheelchairByRoute` + golden cases |
| A5.3 | [O] | Module shell, settings, scope, session state, stale wiring, map layers, `gtfs.js` hooks, route Cost tab |
| A5.4 | [S] | Service & Cost table, Stops sections, CSVs, `test/browser/gtfs-service-analysis.test.mjs` incl. cross-check |
| A5.5 | [O] | Review, RTD performance, screenshots, docs, commit |

## Verification

- Golden: `node test/run-golden.mjs` → PASS, no existing value changed.
- Browser: `gtfs-service-analysis` (new), `gtfs-details`, `gtfs-copy-service`, `gtfs-browser-smoke`,
  `hidden-features`.
- Screenshots light and dark; RTD: Run of each tab under 2 s.

## Progress log

- 2026-11-21: gates answered (G5a annual day counts, G5b one tabbed analysis, G5c blocks if present,
  G5d upper bound + walk). A5.1 to Haiku.
- 2026-11-21: A5.1 Haiku and A5.2 Sonnet passed first time (one A5.2 rule clarified); A5.3 by Opus;
  A5.4 Sonnet; review found 9 issues, all fixed by Opus. Closed; see the parent plan's progress log.
