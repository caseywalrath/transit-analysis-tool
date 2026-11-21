# Card A6a.3 — Transit Coverage on GTFS routes, with street distance

## 1. Goal
Transit Coverage measures coverage from the loaded GTFS feed's stops as well as drawn routes: a GTFS
routes checklist, stop buffers by mode (bus ¼ mi, rail ½ mi, editable), the headway threshold applied per
GTFS stop from the real schedule, and an option to measure the buffer along streets with the new
multi-origin walk flood.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A6-plan.md` (Fixed decisions: "Transit Coverage on GTFS", "Multi-origin flood").
- `docs/reference/modules/transit-coverage.md`, `js/projects/transit-coverage.js` (whole file),
  `projects/transit-coverage-popup.html`, `projects/transit-coverage-legend.html`.
- `js/core/road-network.js`: `computeMultiWalkCostMap`, `multiWalkPolygon` (new; read their comments),
  `App.roadNetworkLoaded`.
- `js/core/gtfs-schedule.js`: `stopServiceTable` (peak headway per stop), `tripsOnDate`, `patterns` /
  `routeServiceDay` only as needed to find a route's stops on the date, `isStationStop`.
- `js/projects/gtfs.js`: `App.gtfsSchedule`, `App.gtfsAnalysisDate`, `App.gtfsScopeRouteIds`,
  `App.gtfsRouteIndex`, `App.gtfsDayParts`, `App.gtfsOnInputsChange`, `App.gtfsHiddenState`.
- `js/core/module-buffers.js`, `js/core/analysis-checklist.js`, `test/cases/transit-coverage.mjs`,
  `test/browser/gtfs-details.test.mjs`, `test/browser/hidden-features.test.mjs`, `test/browser/harness.mjs`.

## 3. Files you may change (closed list)
- `js/projects/transit-coverage.js`, `projects/transit-coverage-popup.html`.
- `css/style.css` — only `.tc-` rules (another agent may edit other parts of this file at the same time:
  if an edit fails because the file changed, re-read and retry).
- `test/browser/transit-coverage-gtfs.test.mjs` — new.
- `test/cases/transit-coverage.mjs` — append cases only, for any new pure helper you expose on `App._tcTest`.

## 4. Contract
### 4.1 Inputs
- When a feed is loaded, a third checklist **GTFS routes** below the drawn ones: every route in
  `App.gtfsScopeRouteIds(includeHidden)` that has trips on the analysis date (name, mode tag "bus"/"rail",
  colour chip), Select all / Clear, all checked by default. The analysis date is shown above it (read-only;
  "Change in the GTFS panel"). Without a feed the section is absent.
- Mode of a route: rail for `route_type` 0, 1, 2, 5, 7, 12, else bus (a private helper; if
  `window.AnalysisNetwork.modeOf` exists use it).
- Settings (the module's existing settings area): **Bus stop buffer** 0.25 mi, **Rail stop buffer** 0.5 mi,
  both > 0; **Distance measured**: "Straight line" (default) | "Along streets". These apply to GTFS stops
  only; drawn features keep the existing buffer distance. Along streets also applies to drawn routes'
  stops when "Coverage from" is stops (their circles become walk areas at the same distance).
### 4.2 Run
- GTFS stops of a route = stops with a departure of that route on the date (`stopServiceTable` with
  `routeIds: [routeId]` gives them in one call per route; or one call for all selected routes plus a
  per-route stop list from the day's trips — your choice, but RTD's 130 routes must take < 1 s for this step).
  A stop used by bus and rail routes gets the rail buffer.
- Straight line: circles (`App.buildStopCircleUnion`, the stops as point features). Along streets:
  `App.multiWalkPolygon(origins, km)` once per distinct buffer distance (bus group, rail group), unioned;
  stops that do not snap get circles instead, and the results say "N stops are off the street network
  and were measured in a straight line." No road network loaded → the run uses straight line and says
  "No street network is loaded, so distance was measured in a straight line." (not an error).
- Headway threshold: a GTFS stop qualifies when the **combined** peak headway of the selected GTFS routes
  at that stop (`stopServiceTable(feed, date, {routeIds: selected, dayParts: App.gtfsDayParts.get()})`
  `.peakHeadwaySec`) ≤ threshold × 60. Only qualifying stops form the threshold union. Drawn features keep
  today's rule.
- The GTFS union joins the drawn union for coverage; everything downstream (apportionment, jobs, map,
  sentence) is unchanged.
### 4.3 Results
- The per-feature headway list gets one row per selected GTFS route: name, peak headway (the route's
  median peak headway over its stops, minutes, or "—"), stops used, mode, "(from N stops)". Add a line
  "GTFS stops: N (N qualify at ≤ T min peak headway)" when a threshold is set.
- CSV: GTFS rows with `coverage_source` = `gtfs-stops`, plus `# Analysis date:` and `# Distance measured:` lines.
- Footnote names the distance method and the bus / rail buffers.
### 4.4 State
- Staleness: `App.gtfsOnInputsChange` (feed, date, hidden, day parts) and the new settings mark results
  stale through the existing stale banner.
- Session: schema **v3**: add `gtfsUnchecked: [route_id]` (unchecked GTFS routes, so new routes default to
  checked), `busBufferMi`, `railBufferMi`, `distanceMode`. v2 sessions load with the defaults; keep the v1→v2
  migration.

## 5. Test `test/browser/transit-coverage-gtfs.test.mjs`
Mini feed, date 20260112. Stub Census/LODES/block fetches the way existing Transit Coverage browser checks do
(look in `hidden-features.test.mjs`; if there are none, stub `App.computeApportionFractions` and the fetches
it needs and say so). Draw a service-area polygon around the mini feed. Checks: GTFS section absent before
the feed, present after with B1/R1/F1 (mode tags right: check the fixture's route_type values); unchecking
R1 drops its stops from the covered area; rail buffer 0.5 vs bus 0.25 gives a larger area for a rail stop;
threshold 15 keeps only stops whose combined peak headway ≤ 15 min (compare with `stopServiceTable` in the
page); along streets with no network → straight line plus the note; along streets with a small synthetic
road network loaded (find how `walkshed-contour.test.mjs` loads one) → a polygon different from the circles
and the off-network note when a stop is far from it; hiding F1 marks results stale and Re-run drops it;
session v3 round-trip and a v2 payload loads with defaults; no page errors. End `PASS — n/n checks passed`.

## 6. Done when
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/transit-coverage-gtfs.test.mjs` → PASS twice.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs` → PASS.
- `node test/run-golden.mjs transit-coverage` → PASS.
- RTD timing (scratchpad script or a browser run with the RTD zip in
  `/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/feeds/rtd.zip`): the GTFS stop
  gathering + straight-line union for all routes; report ms.
- Screenshots (inputs with the GTFS section; results with GTFS rows; light and dark) under
  `/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots/`; list the paths.
