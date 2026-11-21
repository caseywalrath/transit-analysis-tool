# Card A6b.3 (Sonnet): GTFS stop details "Coverage" tab

## Files (only these)
- `js/projects/gtfs.js`
- `css/style.css` (`.gtfs-` rules only, if needed)
- NEW `test/browser/gtfs-stop-coverage.test.mjs`
- `docs/reference/modules/gtfs.md`

## Read first
`CLAUDE.md`, `docs/a6-cards/rules.md`, `docs/reference/modules/gtfs.md`, in `js/projects/gtfs.js` the stop
details tabs (`_stopTabs`, `renderStopTrips`, `renderStopSpacing`, `App.gtfsAddRouteTab`), `js/core/service-equity.js`,
`App.fetchBlockPopulations` and `App.fetchTigerwebGeos` in `js/core/census.js`, `test/browser/gtfs-details.test.mjs`.

## What to build
1. `App.gtfsAddStopTab(tab)`: the stop-view twin of `App.gtfsAddRouteTab` (same shape; render gets the stop_id).
2. A built-in **Coverage** tab on stop details (after Spacing). Instant part (schedule only, redraws like the
   other tabs, no Run button):
   - Mode (bus / rail: rail when any route serving the stop on the analysis date has route_type 0, 1, 2, 5, 7 or 12).
   - Walk distance used by coverage analyses: ¼ mi bus, ½ mi rail.
   - Trips on the analysis date and combined peak headway at this stop (from `GtfsSchedule.stopServiceTable`
     over the current scope, the same source the stop Trips tab uses).
   - "Frequent (peak headway ≤ 15 min)" yes/no.
   On demand: a button "Count residents" → fetches block groups around a circle of that radius
   (`App.fetchTigerwebGeos("bg", circle)` then `App.fetchBlockPopulations(geos)`), sums POP100 of blocks within
   the radius (`ServiceEquity.distanceMi`), and shows "About N residents live within ¼ mi (2020 census blocks)."
   Keep the count in the per-view state so instant redraws do not lose it; show "Counting…" while it runs and the
   error text if it fails. Never fetch automatically.
3. Docs: describe the tab and `App.gtfsAddStopTab` in `docs/reference/modules/gtfs.md`.

## Browser test
Load the mini feed (copy from `test/browser/gtfs-details.test.mjs`), open a stop's details, switch to Coverage:
assert mode, distance, trips and headway match `stopServiceTable`; intercept TigerWeb (block-group layer and
block layer) with hand-made features and assert the resident count equals your hand sum; no Census request
before the button is pressed; no page errors.

## Done when
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-stop-coverage.test.mjs` → PASS.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-details.test.mjs` → PASS.
- `node test/run-golden.mjs` → PASS.
