# Card A8.1 — GTFS export engine (`window.GtfsExport`) [Haiku, xhigh]

## 1. Goal
Write a pure engine that turns drawn Services (as plain data) into the text of a valid GTFS feed, with golden tests.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A8-plan.md` (whole file).
- `js/core/analysis-network.js`: search `function bandTrips`, `function stopTimesAlong`, `function proposalTrips`,
  `window.AnalysisNetwork =`. You call `window.AnalysisNetwork.proposalTrips` at call time; do not copy it.
- `js/core/service-compare.js`: the whole file, as the pattern for a pure engine (IIFE, `"use strict"`, ES5,
  `evaluate` hook, `window.X = {...}` at the end).
- `test/cases/service-compare.mjs` (case file layout) and `test/run-golden.mjs` lines 1–40 (how cases run).

## 3. Files you may change
- `js/core/gtfs-export.js` (new)
- `test/cases/gtfs-export.mjs` (new)
- `test/golden/gtfs-export.json` (new, written only by `node test/run-golden.mjs gtfs-export --update`)
- `index.html`: one new script tag only (section 6).

## 4. Contract
ES5 only in `js/` (var, function, no arrow functions, no template strings, no `let`/`const`). Reads nothing at load
time except `window`; reads `window.AnalysisNetwork` only inside `build`.

```
window.GtfsExport = { build: build, hms: hms, csvRow: csvRow, evaluate: evaluate };
```

### `hms(sec)` → string
Whole seconds after midnight → `"HH:MM:SS"`, hours two digits or more (`hms(90000)` = `"25:00:00"`,
`hms(21600)` = `"06:00:00"`, `hms(5)` = `"00:00:05"`). Input is rounded with `Math.round` first.

### `csvRow(values)` → string
Joins with `,`. A value is first turned into a string (`null`/`undefined` → `""`). A value containing `,`, `"`, `\r`
or `\n` is wrapped in `"` with each `"` doubled. No trailing newline.

### `build(input)` → `{ files, counts, warnings }`, or throws `Error`
```
input = {
  agency: { id, name, url, timezone, lang, phone },   // id default "A1"; lang, phone optional
  feedVersion: string,                                 // optional, default ""
  startDate: "YYYYMMDD", endDate: "YYYYMMDD",
  frequencies: boolean,                                // true = write eligible bands as frequency windows
  routes: [{ routeId, shortName, longName, routeType, color, proposal }]
}
proposal = { key, stops: [{id, name, lat, lon}],
             patterns: [{ id, directionId, both, bands: {weekday:[...], saturday:[...], sunday:[...]},
                          runtimeMin, lengthMi, stops: [{id, distMi}], shape: [[lon, lat], ...] }] }
band = { from: "HH:MM", to: "HH:MM", frequency: minutes (string or number) }
```

**Validation, in this order (throw `new Error(<exact text>)`; all fields trimmed first):**
1. agency.name empty → `Enter the agency name.`
2. agency.url not matching `/^https?:\/\/\S+$/` → `Agency URL must start with http:// or https://.`
3. agency.timezone not matching `/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+)$/` → `Enter a time zone such as America/Denver.`
4. startDate or endDate not a real calendar date in `YYYYMMDD` (check month 1–12 and the day exists, leap years
   included) → `Enter start and end dates.`
5. endDate < startDate (string compare) → `The end date is before the start date.`
6. routes not a non-empty array → `Choose at least one Service.`

**Day types** (fixed order): `weekday` → service_id `WK` (Mon–Fri 1, Sat 0, Sun 0); `saturday` → `SA` (Sat 1 only);
`sunday` → `SU` (Sun 1 only).

**Trips.** For each route (input order) → each pattern (index `pi`, array order) → each day type (order above) →
each band of `pattern.bands[dayType]` (array order; a missing array = none):
- `list = AnalysisNetwork.proposalTrips({ key: routeId, patterns: [P] }, dayType)` where `P` is a shallow copy of the
  pattern whose `bands` is `{}` with only `[dayType]: [band]`.
- Group `list` by `directionId`, groups in order of first appearance, trips in list order.
- For each group: `headSec = parseFloat(band.frequency) * 60`. The group is **eligible** when `input.frequencies` is
  true, `Math.abs(headSec - Math.round(headSec)) < 1e-6`, `Math.round(headSec) >= 60`, and the group has 2 or more
  trips. Eligible → write only the group's first trip (the template) and one frequencies row
  `trip_id, hms(first.dep[0]), hms(last.dep[0] + H), H, 1` with `H = Math.round(headSec)` and `last` the group's
  last trip. Not eligible → write every trip of the group.
- Written trip id: `routeId + "-" + serviceId + "-" + pattern.id + "-" + directionId + "-" + dep[0]`. If that id was
  already written, append `-2`, then `-3`, … (first free).
- `tripsRepresented` counts every trip of every group (eligible groups count all their trips).

**Shapes.** A pattern's shape is its `shape` with points that are not two finite numbers dropped and consecutive
identical points dropped. With fewer than 2 points left the pattern has no shape: its trips get `shape_id` `""` and one
warning `Service "<routeId>" pattern <pattern.id> has no line shape.` (once per pattern). Otherwise the forward shape
id is `routeId + "-" + pattern.id`; when `pattern.both` is true, trips whose `directionId` differs from the pattern's
own `directionId` (missing/blank directionId means `"0"`) use the reversed point list with id `routeId + "-" +
pattern.id + "-r"`. Write each shape id once, only if a written trip uses it, points numbered from 1.

**Stop times.** For each written trip, stop `k` (0-based): `trip_id, hms(arr[k]), hms(dep[k]), stopId, k + 1,
timepoint` with timepoint `1` for the first and last stop and `0` otherwise. `stopId` is the trip's stop id as given
(`proposalTrips` returns the pattern stop ids).

**Stops.** Rows for stop ids used by written trips, in order of first use. Data comes from the first route's
`proposal.stops` entry with that id (search routes in input order). Missing entry or non-finite lat/lon → throw
`Stop "<id>" has no location.` Blank name → `"Stop " + n`, n counting nameless stops from 1 in output order.
Coordinates written with `toFixed(6)`.

**Routes.** A route with zero written trips is left out with warning
`Service "<shortName or longName or routeId>" has no trips in its headway bands and was left out.` If no route has
trips → throw `No trips to export: the selected Services have no headway bands with service.`
Fields: `route_short_name` = shortName trimmed; `route_long_name` = longName trimmed, or routeId when both names are
blank; `route_type` = `parseInt(routeType, 10)`, or 3 when that is not a number; `route_color` = color with a leading
`#` removed, upper-cased, kept only if it matches `/^[0-9A-F]{6}$/`, else `""`; `route_text_color` = `""` when
route_color is `""`, else `"FFFFFF"` when `0.299R + 0.587G + 0.114B < 140` (R, G, B 0–255) and `"000000"` otherwise.

**Calendar.** One row per day type that has at least one written trip, in day-type order, with startDate/endDate.

**Files** (array of `{name, text}`, in this order; each `text` is the header line, then one line per row, lines joined
with `\n`, ending with `\n`; skip `shapes.txt` and `frequencies.txt` when they have no rows):

| File | Columns |
|---|---|
| agency.txt | agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone |
| stops.txt | stop_id,stop_name,stop_lat,stop_lon |
| routes.txt | route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color |
| trips.txt | route_id,service_id,trip_id,direction_id,shape_id |
| stop_times.txt | trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint |
| calendar.txt | service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date |
| shapes.txt | shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence |
| frequencies.txt | trip_id,start_time,end_time,headway_secs,exact_times |
| feed_info.txt | feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version |

agency row: id (default `A1`), name, url, timezone, lang (default `""`), phone (default `""`). Every route's agency_id
is that id. trips.txt direction_id is the trip's directionId. feed_info: agency name, agency url, lang or `en`,
startDate, endDate, feedVersion or `""`.

`counts = { routes, stops, trips (trips.txt rows), tripsRepresented, stopTimes, shapes (distinct shape ids written),
frequencies (rows) }`. `warnings` = array of strings in the order raised.

### `evaluate(input)`
Returns `build(input)`; if it throws, returns `{ error: e.message }`. (The golden harness fails on a throw.)

## 5. Edge cases
1. Band with blank or 0 frequency, or bad times → `proposalTrips` makes no trips; nothing written, no warning.
2. Band wrapping midnight (`23:30`→`00:30`, 30 min) → times past 24:00 (`24:00:00`); end_time `24:30:00`.
3. Two overlapping bands giving the same start → second trip id gets `-2`.
4. `pattern.both` false with directionId `"1"` → forward shape for its trips (no `-r`).
5. Shape `[[-105, 39.7]]` or `[]` or missing → no shape, warning, `shape_id` blank.
6. Fractional headway that is a whole number of seconds (7.5 min = 450 s) is eligible; one that is not (7.123) is not.
7. A route with only empty bands among others → warning, left out; all routes empty → throw.
8. Stop names with commas or quotes → quoted CSV.
9. The same stop id used by two routes → one stops.txt row, from the first route's entry.

## 6. Placement
`index.html`: add `<script src="js/core/gtfs-export.js"></script>` on the line immediately after
`<script src="js/core/raptor.js"></script>`.

## 7. Steps
1. Write `js/core/gtfs-export.js` to the contract.
2. Write `test/cases/gtfs-export.mjs`: `scripts: ["js/core/gtfs-schedule.js", "js/core/analysis-network.js",
   "js/core/gtfs-export.js"]` and the cases below, each `{ id, call: "GtfsExport.evaluate", args: [input] }`, with the
   EXPECTED comment above each.
3. `node test/run-golden.mjs gtfs-export --update`, then open `test/golden/gtfs-export.json` and check every
   expected value below by eye. Then run the full suite.

### Fixture (put in the case file)
```
AG = { name: "Test Transit", url: "https://example.org", timezone: "America/Denver" }
SHAPE = [[-105, 39.7], [-105, 39.72], [-105, 39.72], [-105, 39.74]]
STOPS = [{id:"s1", name:"First & Main", lat:39.7, lon:-105}, {id:"s2", name:"", lat:39.72, lon:-105},
         {id:"s3", name:'Elm, "North"', lat:39.74, lon:-105}]
PAT = { id:"0", directionId:"0", both:true, runtimeMin:20, lengthMi:2,
        stops:[{id:"s1",distMi:0},{id:"s2",distMi:1},{id:"s3",distMi:2}], shape: SHAPE,
        bands: { weekday:[{from:"06:00",to:"07:00",frequency:"20"}], saturday:[{from:"08:00",to:"08:30",frequency:"30"}], sunday:[] } }
R1 = { routeId:"R1", shortName:"1", longName:"Main St", routeType:3, color:"#0055AA", proposal:{ key:"R1", stops:STOPS, patterns:[PAT] } }
BASE = { agency: AG, startDate:"20270101", endDate:"20271231", frequencies:true, routes:[R1] }
```

### Cases and expected values
1. `freq-on` (BASE). counts `{routes 1, stops 3, trips 4, tripsRepresented 8, stopTimes 12, shapes 2, frequencies 2}`,
   warnings `[]`. Files in order: agency, stops, routes, trips, stop_times, calendar, shapes, frequencies, feed_info.
   trips.txt rows: `R1,WK,R1-WK-0-0-21600,0,R1-0` / `R1,WK,R1-WK-0-1-21600,1,R1-0-r` / `R1,SA,R1-SA-0-0-28800,0,R1-0` /
   `R1,SA,R1-SA-0-1-28800,1,R1-0-r`. stop_times for `R1-WK-0-0-21600`: `06:00:00` s1 1 1, `06:10:00` s2 2 0,
   `06:20:00` s3 3 1; for `R1-WK-0-1-21600`: s3, s2, s1 at the same three times. frequencies.txt:
   `R1-WK-0-0-21600,06:00:00,07:00:00,1200,1` and `R1-WK-0-1-21600,06:00:00,07:00:00,1200,1`. routes.txt row
   `R1,A1,1,Main St,3,0055AA,FFFFFF`. stops.txt: `s1,First & Main,39.700000,-105.000000`, `s2,Stop 1,39.720000,…`,
   `s3,"Elm, ""North""",39.740000,…`. calendar: `WK,1,1,1,1,1,0,0,20270101,20271231` and
   `SA,0,0,0,0,0,1,0,20270101,20271231`. shapes: R1-0 at 39.700000/39.720000/39.740000 seq 1–3; R1-0-r reversed.
   feed_info row `Test Transit,https://example.org,en,20270101,20271231,`.
2. `freq-off` (BASE with frequencies false). counts trips 8, tripsRepresented 8, stopTimes 24, frequencies 0; no
   frequencies.txt; WK trips start 21600, 22800, 24000 in each direction.
3. `wrap` (R1 with weekday `[{from:"23:30",to:"00:30",frequency:30}]`, saturday `[]`). One frequencies row per direction
   `…,23:30:00,24:30:00,1800,1`; template stop times end `23:50:00`; calendar only WK.
4. `dup-ids` (weekday bands `[{06:00,07:00,"20"},{06:00,06:30,"30"}]`, saturday `[]`, frequencies false). trips.txt
   includes `R1-WK-0-0-21600` and `R1-WK-0-0-21600-2`.
5. `non-whole-headway` (weekday `[{06:00,07:00,"7.123"}]`, saturday `[]`): frequencies 0; tripsRepresented 18
   (9 per direction), trips 18. And `half-minute` (`"7.5"`): frequencies 2, trips 2, tripsRepresented 16, headway 450,
   end_time `07:00:00`.
6. `no-shape` (PAT.shape `[[-105, 39.7]]`): warning `Service "R1" pattern 0 has no line shape.` once; shape_id blank on
   all trips; no shapes.txt.
7. `one-way` (PAT.both false, directionId "1"): trips 2 (WK and SA templates/explicit), all direction 1, shape `R1-0`;
   WK trip `R1-WK-0-1-21600` with stops s1, s2, s3.
8. `empty-route` (routes `[R1, R2]`, R2 = R1 with routeId "R2", shortName "", longName "Ghost", all bands `[]`):
   warning `Service "Ghost" has no trips in its headway bands and was left out.`; routes.txt 1 row.
9. `all-empty` (routes `[R2]`): `{error: "No trips to export: the selected Services have no headway bands with service."}`.
10. Validation errors, one case each, expected `{error: …}` with the exact texts of section 4: `err-name` (name ""),
    `err-url` (url "example.org"), `err-tz` (timezone "Denver"), `err-date` (startDate "20270230"),
    `err-order` (startDate "20271231", endDate "20270101"), `err-routes` (routes []).
11. `no-stop-location` (STOPS s2 lat null): `{error: 'Stop "s2" has no location.'}`.
12. `color-light` (color "ffd700"): route_color `FFD700`, route_text_color `000000`. `color-bad` (color "blue"):
    both blank.

## 8. Done when
- `node test/run-golden.mjs gtfs-export` ends `PASS — 19/19 cases passed` (adjust the number only if you count the
  case list above differently; say so in the report).
- `node test/run-golden.mjs` ends `PASS — N/N cases passed` (N = 1159 + your case count).
- Every expected value in section 7 matches the recorded golden file. If one does not, stop and report expected vs
  actual; do not change the expected value.

## 9. Stop and report if
- `AnalysisNetwork.proposalTrips` returns a shape different from section 4's description.
- A hand-expected value disagrees with your output and you cannot find a bug in your code.
- You think any other file needs to change.
