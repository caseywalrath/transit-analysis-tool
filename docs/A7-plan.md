# A7 — Build vs No-Build comparison and feed health (sub-plan)

**Status:** In progress. Parent plan: `docs/gtfs-expansion-plan.md` § A7. Base commit `4e4b446`.

A7 ships as two steps, each reviewed and committed on its own: **A7a** feed health, **A7b** Build vs
No-Build comparison (with the Title VI changed-routes workflow moved here from A6). Cards live in
`docs/a7-cards/`; each step's cards are written when it starts, from the code as it then stands.

## Gate answers (2026-11-21)

- **G7a — Option B:** compare two GTFS feeds, **and** compare the loaded feed with your edited copies of
  its routes (drawn Services standing in for the GTFS routes they replace).
- **G7b — Option A:** the seven listed health checks.

## Code facts verified (base `4e4b446`)

- Feed object (`GtfsSchedule.buildFeed`): `tables[name].rows` (raw rows of every non-stop_times table),
  `st` (columnar stop_times: `tripStart`, `stop`, `seq`, `arr`, `dep`, −1 = blank, rows sorted by trip then
  sequence), `_trips` (`{id, routeId, serviceId, directionId, blockId, shapeId, wheelchair, ti, freq, routeOk}`),
  `_routes[id]` = raw row, `_stops[id]` = `{id, lat, lon, parent, locationType, wheelchair, children}`.
- Private helpers worth reusing inside the engine: `haversine`, `isRealDate`, `utcDay`, `addDays`, `dateRange`.
- Shapes are not on the feed: `gtfs.js` keeps them as GeoJSON line features (`shapeFeature(shapeId)`); the
  parse-time point groups are freed after the GeoJSON is built.
- `#gtfsHealth` (hidden div) is reserved in `projects/gtfs-popup.html` Overview.
- GTFS Service Analysis (`js/projects/gtfs-service-analysis.js`, popup `projects/gtfs-service-analysis-popup.html`)
  has tabs `service`, `stops` via `[data-tab]` + `switchTab`; results `{feed, sig, inputs, ...}`.
- Service figures: `serviceYear(feed, opts)` → `routeServiceDay` per day type; `serviceRow`, `tripLayovers`,
  `vehiclePeak` are private and work on plain trip records `{tripId, routeId, start, end, blockId, generated}`.
- Copied Services record their source only as free text (`attributes.notes` "route_id: X, shape_id: Y").
- Title VI alterations: `{name, changeType: adjustment|elimination|new_route, before, after (feature refs),
  manual: {revenueHours:{before,after}, spanHours:{before,after}, fare:{...}}, computed}`.
- Coverage counting recipe (Transit Coverage): `App.fetchTigerwebGeos` → `App.fetchACSValues(…"B01003_001E")`
  → `App.computeApportionFractions` → `App.aggregateWithinUnion`; jobs `App.fetchBlocksInternalPointsInUnion`
  + `App.lodesData`; stop circles `App.buildStopCircles` + `App.unionManyPolygons`.

## Health check rules (G7b)

Thresholds are from the MobilityData GTFS validator source (master, read 2026-11-21), cited by file:

| Check | Rule | Source |
|---|---|---|
| Feed expiry | `feed_info.feed_end_date`, else the calendar's last date; expired, or end < today + 7 days, or < today + 30 days (strict) | `FeedExpirationDateValidator.java` (feed_info only; the calendar fallback is ours, labelled) |
| Trips without a shape | `shape_id` blank or not in shapes.txt | GTFS reference (shape_id optional, recommended) |
| Stops without wheelchair data | stops (location_type blank/0) whose `wheelchair_boarding` is not 1/2, after inheriting the parent station's | GTFS reference |
| Impossible speeds | consecutive stop times: next arrival − this departure; ≤ 0 → 60 s; both whole minutes → +60 s; speed > max for route_type (km/h: 0→100, 1/3/11/12→150, 2→500, 4→80, 5→30, 6/7→50, else 200) | `StopTimeTravelSpeedValidator.java` (the 10 km "far stops" variant is not reproduced) |
| Stops far from their shape | stop more than 100 m from its trip's shape | `ShapeToStopMatchingValidator.java` notice text (GTFS Best Practices) |
| Times that go backwards | arrival strictly before the most recent earlier departure in the trip | `StopTimeArrivalAndDepartureTimeValidator.java` (error) |
| Routes without agency_id | blank `routes.agency_id`: error with more than one agency, warning with one (NTD reporting) | `RouteAgencyIdValidator.java` |

## Fixed decisions

- **A7a engine:** `GtfsSchedule.feedHealth(feed, {today, shapes, maxExamples})`, pure, in `gtfs-schedule.js`
  (card `docs/a7-cards/card-a7a.1.md`). Shapes come in as `{shapeId: [[lon, lat], …]}`.
- **A7a UI:** a **Feed health** tab in GTFS Service Analysis with a "Check feed" button (feed-wide scans are
  not instant on RTD), a table of the seven checks with expandable examples, and a CSV. The GTFS Overview's
  `#gtfsHealth` shows a one-line summary once checks have run for the loaded feed. `App.gtfsShapeCoords()`
  (Opus, `gtfs.js`) supplies the shapes from the shape features.
- **A7b (outline):** a **Compare** tab in GTFS Service Analysis. No-Build is always the loaded feed. Build is
  either (1) a second GTFS ZIP, parsed with the same reader, reduced to a compact summary and dropped (only
  one full schedule stays in memory), or (2) "the loaded feed with my drawn Services": each drawn Service
  either replaces a GTFS route (pre-filled from its "route_id:" note, editable) or is new. Service figures for
  drawn Services come from their synthetic trips through the same `serviceRow` logic, exported by a
  behavior-preserving split of `serviceYear` (Opus). Routes match by `route_id`, then short name, then long name.
  Rows: added / removed / changed / unchanged with trips, running / revenue / platform hours, span, peak
  vehicles and cost; totals; residents, jobs and census blocks within the stop buffers (¼ mi bus, ½ mi rail)
  on each side; CSV. Changed routes are pre-checked against the Title VI major-change policy; the user ticks
  which to send and the tool creates a Title VI scenario with revenue and span hours filled in.

## Progress log

- 2026-11-21: gates answered (G7a Option B, G7b Option A); sub-plan and card A7a.1 written (Opus).
