# A6 — Coverage, Title VI equity and travel times on real schedules (sub-plan)

**Status:** A6a partly committed; A6a.3 (Transit Coverage) and A6a.5 (review) remain. Parent plan: `docs/gtfs-expansion-plan.md` § A6. Base commit `c6ed9ef`.

A6 ships as three steps, each reviewed and committed on its own: **A6a** analysis network and coverage,
**A6b** Title VI service equity, **A6c** travel times. Each step's cards are written when it starts, from
the code as it then stands.

## Gate answers (2026-11-21)

G6a low-income is a policy setting, default below poverty · G6b travel times over an editable departure
window · G6c drawn proposals mix into the real network · G6d optional ½-mile rule for frequent stops,
off by default. All Option A.

## Code facts verified (base `c6ed9ef`)

- Trip Builder's generator is private: `generateTripsForPattern(pattern, day, runtimeMin)` in
  `js/projects/trip-builder.js` reads `App.getEffectiveServiceBands`, steps `from, from+h, …` while
  `< to`, wraps `to += 1440`, clamps headway ≥ 1, caps 1,500 trips per band. Golden: `test/cases/trip-builder.mjs`
  through `App._tbTest.generateAllTrips`.
- Schedule engine: `tripsOnDate(feed, date, {routeIds})` → trips `{tripId, routeId, directionId, start, end,
  generated, templateId, …}`; `tripStopTimes(feed, tripId, {interpolate})` → rows `{stopId, arr, dep}`
  (−1 when blank); `dayType(feed, date).dayType` → weekday | saturday | sunday; `stopServiceTable` gives
  per-stop trips and peak / off-peak headways in one pass; routes `feed._routes[id].route_type`.
- Walk network (`js/core/road-network.js`, Opus-only): a segment grid already indexes snapping
  (`snapToNetwork`, 3×3 cells, `SNAP_MAX_KM`); floods are single-origin (`runWalkFlood` →
  `floodDijkstra(startKey, budgetKm, penalty)`), contours via `contourSamples` + `WalkShape.contour`
  (`computeWalkshed` shows the full recipe).
- Transit Coverage builds stop circles with `App.associatedStopPoints` + `App.buildStopCircleUnion` and
  apportions with `App.computeApportionFractions`; headway threshold from drawn `attributes.service`
  (`computePeakHeadway`). Feature Area Analysis (`buffer-summary.js`) apportions the same way.
- Travelshed engine (`window.Travelshed`) is headway-based with one transfer; it stays for drawn-only use.

## Fixed decisions

- **Analysis network** is a new pure engine `js/core/analysis-network.js`, `window.AnalysisNetwork`,
  loaded right after `gtfs-schedule.js`. Stop ids are prefixed `g:` (GTFS stop_id) or `d:` (drawn Point
  feature id, or `d:<serviceKey>#<n>` for spaced stops on a proposal with no stops); route keys `g:<route_id>`
  / `d:<serviceKey>`. Trips are compact: `{id, routeKey, source, directionId, stops: [stopIdx], arr: [s],
  dep: [s]}` in seconds after the date's midnight.
- **Synthetic trips** (G6c): `AnalysisNetwork.bandTrips(bands, runtimeMin)` is the generator moved out of
  Trip Builder, unchanged in output (Trip Builder calls it; its golden cases must not move). Stop times at
  drawn stops are start + runtime × (distance along the line ÷ line length). A proposal with no stops gets
  stops every 0.25 mi (Travelshed's default spacing). A "Both" pattern runs both ways (reversed stop order);
  a loop runs one way. The date's day type picks the bands. Results that include proposals say "Proposals
  use evenly spaced trips from their headway bands."
- **App glue** `App.buildAnalysisNetwork(opts)` lives in a new file `js/core/analysis-network-source.js`
  (after `module-buffers.js`): it reads the feed and scope (`App.gtfsSchedule()`, `App.gtfsAnalysisDate`,
  `App.gtfsScopeRouteIds`), the drawn Services (`App.buildTransitServices`, stops through
  `App.associatedStopPoints`, distances by `turf.nearestPointOnLine`) at call time. Opus writes it.
- **Multi-origin flood** (F12, Opus): `App.computeMultiWalkCostMap(origins, budgetKm, opts)` seeds every
  snapped origin's two segment ends at their access distance (no temporary graph nodes) →
  `{distMap, originOf, snapped, unsnapped: [ids], snapMs, floodMs}`; `App.multiWalkPolygon(origins, budgetKm)`
  traces it with the `computeWalkshed` contour recipe → a polygon or null. No new spatial index: snapping
  already uses the segment grid.
- **Transit Coverage on GTFS:** a third checklist "GTFS routes" (routes running on the analysis date,
  hidden ones only with Include hidden). Stop buffers by mode: bus ¼ mi, rail ½ mi, both editable
  (rail = route_type 0, 1, 2, 5, 7, 12; everything else bus). The headway threshold applies per stop: a GTFS
  stop qualifies when the combined peak headway of the selected GTFS routes there
  (`stopServiceTable`) is at or under it. A new "Distance measured" setting: straight line (default) or along
  streets (needs a road network; uses `App.multiWalkPolygon`, stops beyond the network fall back to circles
  and are counted in a note).
- **Feature Area Analysis** gains one checklist entry, "GTFS stop selection (N stops)", buffered as circles
  at the module's buffer distance.
- **A6b (outline):** a fourth Title VI tab, Service Equity: trips per capita by block group from the
  analysis network (each stop's day trips spread over block groups by A1 block weighting inside its policy
  buffer; G6d switch ½ mi at ≤ 15-min peak stops), minority vs non-minority and low-income vs not, split at
  the regional average, four-fifths banding. Low-income definition becomes a policy setting (G6a: below
  poverty `B17001` default, below 200 % `C17002` optional). Revenue-hours % and span % fill from
  `serviceYear` when before and after feeds exist; until A7 loads two feeds, that path is the drawn
  "after" vs the GTFS "before" and stays manual otherwise. The GTFS stop details Coverage tab (moved from A4)
  arrives here with `App.gtfsAddStopTab`. The changed-routes workflow moves to A7 (it needs two feeds, G7a).
- **A6c (outline):** pure `window.Raptor` in `js/core/raptor.js` over the analysis network: max 2
  transfers (3 rounds), transfer walks from the multi-origin flood capped at Travelshed's 0.25 mi, access
  0.5 mi, egress 0.25 mi. Departures sampled every 2 min across the window (default 7:00–8:00); per node
  the median arrival is "typical", the minimum "best", the 90th percentile "worst". Drawn with
  `App.contourSamples` + `WalkShape.contour`, as a mode of Transit Travelshed ("Schedule (GTFS +
  proposals)" vs today's "Headways (drawn routes)"). Target: RTD, 30 departures, under 10 s with yielding.

## A6a packages

| Card | Owner | Files | Depends on |
|---|---|---|---|
| A6a.1 engine | Sonnet | `js/core/analysis-network.js` (new), `js/projects/trip-builder.js` (generator calls the engine), `index.html` (one script tag), `test/cases/analysis-network.mjs` (new), golden seed | — |
| A6a.2 flood + glue | Opus | `js/core/road-network.js`, `js/core/analysis-network-source.js` (new), `index.html` (one tag) | A6a.1 contract |
| A6a.3 Transit Coverage | Sonnet | `js/projects/transit-coverage.js`, `projects/transit-coverage-popup.html`, `css/style.css` (`.tc-` only), new browser test | A6a.2 |
| A6a.4 Feature Area Analysis | Sonnet | `js/projects/buffer-summary.js`, its popup | — |
| A6a.5 review, docs | Opus | reference docs, `CLAUDE.md` maps, this plan | all |

## Verification (A6a)

Golden PASS with only added keys (Trip Builder's unchanged); browser tests: new coverage test, `hidden-features`,
`gtfs-details`, `walkshed-contour`; screenshots of Transit Coverage with GTFS routes in light and dark; RTD
timing of `buildAnalysisNetwork` and a whole-system along-streets coverage run (target < 5 s once the
network is loaded).

## Progress log

- 2026-11-21: gates answered; sub-plan written (Opus).
- 2026-11-21: paused at the usage limit (Opus). Committed: A6a.1 engine [Sonnet] (reverse direction id fix by Opus),
  A6a.2 multi-origin flood + `App.buildAnalysisNetwork` [Opus], A6a.4 Feature Area Analysis GTFS stop row [Sonnet],
  docs. Golden 1080/1080; browser multi-walk-flood 10/10, analysis-network 17/17, faa-gtfs-stops 14/14,
  hidden-features 138/138. A6a.3 was stopped mid-edit and its changes discarded: restart it fresh from
  `docs/a6-cards/card-a6a.3.md` with the rules block `docs/a6-cards/rules.md`. Then A6a.5: code review at high,
  screenshots, check FAA's collapsed inputs summary reads well with only GTFS stops ("0 features" seen), archive
  this plan and move the cards out of `docs/a6-cards/`.
