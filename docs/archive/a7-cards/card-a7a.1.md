# Card A7a.1 — `GtfsSchedule.feedHealth` (pure engine) [Haiku, xhigh]

## 1. Goal
Add a pure function `GtfsSchedule.feedHealth(feed, opts)` that runs seven read-only health checks on a parsed
GTFS feed, with golden cases.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/archive/A7-plan.md` (section "Health check rules").
- `js/core/gtfs-schedule.js`: search `function buildFeed` (feed shape), `function haversine`, `function isRealDate`,
  `function utcDay`, `function addDays`, `function dateRange`, `function wheelchairByRoute` (style to copy),
  `window.GtfsSchedule = {` (export list), `function evaluate(texts, fnName, args)`.
- `test/cases/gtfs-schedule.mjs`: search `const inline =` and `a5-stops-wheelchair-trip-values` (inline case style).
- `test/README.md` (golden runner).

## 3. Files you may change
- `js/core/gtfs-schedule.js` (add the function and private helpers just above the `// ---- test helper`
  comment line `// ---------------------------------------------------------------- test helper`; add
  `feedHealth: feedHealth` to the export object).
- `test/cases/gtfs-schedule.mjs` (append cases just before `export default`).
- `test/golden/gtfs-schedule.json` (only through `node test/run-golden.mjs --update gtfs-schedule`).

## 4. Contract
ES5 only in `js/` (var, function, no arrow functions, no `let`/`const`, no template strings). Tests may use modern JS.

```
feedHealth(feed, opts) -> { checks: [check × 7, fixed order] }
opts: { today: "YYYYMMDD", shapes: { shapeId: [[lon, lat], ...] } | null, maxExamples: number (default 5) }
check: { id, label, status, count, checked, examples: [ ... at most maxExamples ], note: string | null }
status: "ok" | "warning" | "error" | "unknown"
```
Never throws on odd data: skip what cannot be checked and continue. `maxExamples` that is not a finite number ≥ 0
means 5. Examples are in the order found (described per check). Numbers in examples: `kph` rounded to 1 decimal,
`meters` rounded to whole metres.

Checks, in this order:

1. `id "expiry"`, label `"Feed expiry"`.
   - End date: first row of `feed.tables["feed_info.txt"]` (if that table exists) whose `feed_end_date` passes
     `isRealDate` → source `"feed_info"`. Otherwise `dateRange(feed).end` (source `"calendar"`). Otherwise none.
   - If there is no end date, or `opts.today` fails `isRealDate`: status `"unknown"`, count 0, checked 0,
     examples [], note `"No end date in feed_info.txt or the calendar."` (no end date) or `"No valid today date."`
     (bad today; check today first).
   - `daysLeft = utcDay(end) - utcDay(today)`. checked 1.
     `end < today` → `"error"`, `state "expired"`; else `end < addDays(today, 7)` → `"warning"`, `state "7days"`;
     else `end < addDays(today, 30)` → `"warning"`, `state "30days"`; else `"ok"`, `state "ok"`.
     (String comparison of YYYYMMDD is correct.)
   - count 1 unless state is "ok" (then 0). examples always `[{ endDate, source, daysLeft, state }]` when known.
     note null.
2. `id "shapes"`, label `"Trips without a shape"`.
   - Shape set = own keys of `opts.shapes` (null/undefined → empty set).
   - For each trip in `feed._trips` (array order): flagged when `shapeId === ""` or not in the set.
   - checked = `feed._trips.length`; examples `{ tripId, routeId, shapeId }`; status `"warning"` if count > 0 else `"ok"`. note null.
3. `id "wheelchair"`, label `"Stops without wheelchair data"`.
   - Stops = `feed.tables["stops.txt"].rows` order, by `stop_id`, looked up in `feed._stops`, skipping ids
     already seen and those not in `feed._stops`. Only stops with `locationType` `""` or `"0"` are checked.
   - Value = own `wheelchair`; if it is not `"1"` or `"2"` and `parent` is a known stop, the parent's `wheelchair`.
     Flagged when the value is not `"1"` and not `"2"`.
   - checked = number of checked stops; examples `{ stopId }`; status warning/ok. note null.
4. `id "speed"`, label `"Impossible speeds between stops"`.
   - For each trip in `feed._trips` with `ti >= 0` (array order), rows `r = st.tripStart[ti] … st.tripStart[ti+1]-1`.
     For each consecutive pair (r, r+1): skip when `st.dep[r] < 0` or `st.arr[r+1] < 0`, or either stop
     (`feed._stops[st.stopIds[st.stop[x]]]`) is missing or has non-number `lat`/`lon`.
   - `sec = st.arr[r+1] - st.dep[r]`; if `sec <= 0` → `sec = 60`; else if `st.arr[r+1] % 60 === 0 && st.dep[r] % 60 === 0` → `sec += 60`.
   - `km = haversine(...) / 1000`; `kph = km * 3600 / sec`. Max by `parseInt(feed._routes[routeId].route_type, 10)`:
     0→100; 1, 3, 11, 12→150; 2→500; 4→80; 5→30; 6, 7→50; anything else (missing route, NaN, other codes)→200.
   - Flagged when `kph > max` (strict). checked = pairs that were not skipped.
   - examples `{ tripId, routeId, fromStopId, toStopId, kph, maxKph }`; status warning/ok;
     note `"Frequency-based trips are checked once, on their template times."`
5. `id "shapeDistance"`, label `"Stops far from their shape"`.
   - If the shape set is empty: status `"unknown"`, count 0, checked 0, examples [], note `"No shapes loaded."`
   - Else for each trip (array order) with `ti >= 0` whose `shapeId` is in the set and whose shape has ≥ 1
     point, for each row's stop (row order), the pair key `shapeId + "\u0001" + stopId`: skip pairs already
     seen and stops without number lat/lon. Distance = minimum over the shape's segments (a 1-point shape:
     distance to that point) in a local plane centred on the stop:
     `x = (lon - lon0) * cos(lat0 · π/180) * R · π/180`, `y = (lat - lat0) * R · π/180`, `R = 6371008.8`,
     standard point-to-segment distance (clamp the projection parameter to [0, 1]; a zero-length segment is a point).
   - Flagged when distance > 100 (strict). checked = distinct pairs measured.
   - examples `{ stopId, shapeId, meters }`; status warning/ok; note null.
6. `id "times"`, label `"Times that go backwards"`.
   - For each trip with `ti >= 0` (array order): `prevDep = -1`; for each row in order: if `st.arr[r] >= 0 &&
     prevDep >= 0 && st.arr[r] < prevDep` → flag the row; then if `st.dep[r] >= 0` → `prevDep = st.dep[r]`.
   - checked = number of trips scanned; count = flagged rows; examples `{ tripId, stopSequence: st.seq[r], stopId }`;
     status `"error"` if count > 0 else `"ok"`; note null.
7. `id "agency"`, label `"Routes without agency_id"`.
   - `agencies = feed.tables["agency.txt"] ? rows.length : 0`. Routes = `feed.tables["routes.txt"].rows` order,
     by `route_id` (skip blank and repeated ids). Flagged when `agency_id` is missing or blank after trimming.
   - checked = routes counted; examples `{ routeId }`.
   - status: count 0 → `"ok"`; `agencies > 1` → `"error"`; else `"warning"` with note
     `"One agency: agency_id is recommended (NTD reporting uses it)."` (note null otherwise).

Use the existing private `g(row, key)` helper to read raw row fields if it fits (search `function g(row, key)`).

## 5. Edge cases
1. Empty feed (`feedFromTexts({})`): expiry unknown ("No end date…"); shapes ok checked 0; wheelchair ok checked 0;
   speed ok checked 0; shapeDistance unknown; times ok checked 0; agency ok checked 0. No throw.
2. `opts` missing entirely: today invalid → expiry unknown "No valid today date."; shapes treated as none.
3. A trip whose stop_times are absent (`ti === -1`) is in "shapes" but not in speed / shapeDistance / times.
4. Blank times (−1) never produce a speed pair or a backwards flag.
5. Parent station stops (location_type 1) are not counted in "wheelchair".
6. `maxExamples: 0` → empty example lists, counts unchanged.

## 6. Placement
The new code goes right above the line `// ---------------------------------------------------------------- test helper`
in `js/core/gtfs-schedule.js`; export entry appended after `wheelchairByRoute: wheelchairByRoute,`.

## 7. Steps
1. Write the private helpers (max speed table, point-to-segment metres) and `feedHealth`.
2. Add the export.
3. Append the cases below to `test/cases/gtfs-schedule.mjs`, seed with `node test/run-golden.mjs --update gtfs-schedule`,
   then check the recorded values against the expected numbers below; any mismatch is a bug in your code.

Inline fixture `HEALTH` (add to the test file; ids/values exactly as written):
```
agency.txt:     agency_id,agency_name\nA1,One\nA2,Two\n
routes.txt:     route_id,agency_id,route_short_name,route_type\nR_BUS,A1,10,3\nR_RAIL,,L,0\nR_FERRY, ,F,4\n
stops.txt:      stop_id,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\nP1,40.0,-105.0,1,,1\nS1,40.0,-105.0,0,P1,\nS2,40.0,-104.99,0,,2\nS3,40.0,-104.98,,,\nS4,40.01,-104.98,0,,0\nS5,40.5,-104.98,0,,1\n
calendar.txt:   service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260101,20260131\n
trips.txt:      route_id,service_id,trip_id,shape_id\nR_BUS,SVC,T1,SH1\nR_BUS,SVC,T2,\nR_RAIL,SVC,T3,SH_X\nR_FERRY,SVC,T4,SH1\nR_BUS,SVC,T5,SH1\n
stop_times.txt: trip_id,arrival_time,departure_time,stop_id,stop_sequence
                T1,08:00:00,08:00:00,S1,1 / T1,08:02:00,08:02:00,S2,2 / T1,08:02:00,08:02:00,S3,3
                T2,07:00:00,07:00:00,S1,1 / T2,,,S2,2 / T2,07:04:00,07:04:00,S3,3
                T3,08:10:00,08:10:00,S2,1 / T3,08:20:00,08:20:00,S5,2
                T4,09:00:00,09:00:00,S1,1 / T4,08:59:00,08:59:00,S2,2 / T4,09:05:30,09:05:30,S4,3
```
(T5 has no stop times.) Shapes: `HEALTH_SHAPES = { SH1: [[-105.0, 40.0], [-104.98, 40.0]] }`.

Cases (ids exactly):
- `a7-health-inline` : `inline(HEALTH, "feedHealth", { today: "20260105", shapes: HEALTH_SHAPES })`
- `a7-health-inline-feedinfo` : HEALTH plus `feed_info.txt: feed_publisher_name,feed_end_date\nP,20260110\n`, same opts
- `a7-health-expired` : HEALTH, `{ today: "20260201", shapes: HEALTH_SHAPES }`
- `a7-health-far-future` : HEALTH, `{ today: "20250101", shapes: HEALTH_SHAPES, maxExamples: 1 }`
- `a7-health-no-shapes` : HEALTH, `{ today: "20260105" }`
- `a7-health-zero-examples` : HEALTH, `{ today: "20260105", shapes: HEALTH_SHAPES, maxExamples: 0 }`
- `a7-health-one-agency` : HEALTH with agency.txt `agency_id,agency_name\nA1,One\n`, `{ today: "20260105", shapes: HEALTH_SHAPES }`
- `a7-health-empty-feed` : `inline({}, "feedHealth", { today: "20260105" })`
- `a7-health-no-opts` : `inline(HEALTH, "feedHealth")`
- `a7-health-mini` : `mini("feedHealth", { today: "20260105", shapes: MINI_SHAPES })` where `MINI_SHAPES` is built in the
  test file from `MINI["shapes.txt"]` (group rows by shape_id, sort by shape_pt_sequence numerically, `[lon, lat]` numbers).

## 8. Done when
`node test/run-golden.mjs` ends `PASS — N/N cases passed` and the `a7-health-inline` record shows:
1. expiry: status warning, examples `[{endDate "20260131", source "calendar", daysLeft 26, state "30days"}]`, count 1.
2. shapes: count 2 (T2 shapeId "", T3 "SH_X"), checked 5, status warning.
3. wheelchair: count 2 (S3, S4), checked 5.
4. speed: checked 5, count 1: `{tripId "T3", routeId "R_RAIL", fromStopId "S2", toStopId "S5", maxKph 100}` with kph ≈ 303.3.
5. shapeDistance: checked 4, count 1: `{stopId "S4", shapeId "SH1", meters 1112}`.
6. times: checked 4, count 1: `{tripId "T4", stopSequence 2, stopId "S2"}`, status error.
7. agency: count 2 (R_RAIL, R_FERRY), checked 3, status error, note null.

Also: `a7-health-inline-feedinfo` expiry `{endDate "20260110", source "feed_info", daysLeft 5, state "7days"}`;
`a7-health-expired` expiry error, state "expired", daysLeft −1; `a7-health-far-future` expiry ok count 0 and
every examples list length ≤ 1; `a7-health-no-shapes` shapes count 5 (every trip, T5 included), shapeDistance unknown;
`a7-health-one-agency` agency warning with the note; `a7-health-no-opts` expiry note "No valid today date.".
Every other existing golden case is unchanged.

## 9. Stop and report if
- Any existing golden case changes.
- An expected value above does not match after two fixes (report actual vs expected; do not change the expectation).
- The feed object lacks a field this card names.
