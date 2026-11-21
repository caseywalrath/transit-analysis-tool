# GTFS

Read the code when this and the code disagree. See `docs/archive/gtfs-route-browser-plan.md` and `docs/archive/gtfs-stop-selection-plan.md`.

## gtfs.js (module `"gtfs"`)

GTFS ZIP viewer (JSZip + the `GtfsSchedule` CSV reader) plus the route-browser engine. Wires its own Add Data buttons (hidden `#gtfs-file-input`), no `app.js` changes. Styles `.gtfs-*` in `css/style.css`.

**Loading:** `App.loadGTFSFile(file, opts)` unzips, strips a top-level folder prefix, and parses each `.txt` with `GtfsSchedule.CsvStream`, fed in 256 K-character slices that yield to the page whenever a run of slices has taken over ~40 ms (this keeps the longest freeze on an RTD-size feed near 0.2 s). Results go into private `_gtfsData` (Map filename → `{headers, rows}`), with two exceptions kept compact for memory:
- `stop_times.txt` → `{headers, rows: null, rowCount, columnar: true}`; its rows live only in the schedule store (`_feed.st`, see "Schedule engine" below).
- `shapes.txt` → `{headers, rows: null, rowCount, columnar: true, preview, groups}`: points are grouped per shape while parsing; `groups` is dropped once `addMapLayers()` has built `_shapesFC`; `preview` keeps the first 500 rows for the table viewer.

Any code that reads `_gtfsData.get(name).rows` must handle `columnar`. `App.clearGTFS()` removes the feed, layers and route index, and refreshes the Layers panel. `App.gtfsData` is assigned once at load time (`null`) — **not** a live reference; don't read feed data through it.

**Map layers** (below drawn features, non-editable): `gtfs-shapes`/`gtfs-shapes-layer` (dashed `[4,2]` lines from `shapes.txt`) and `gtfs-stops`/`gtfs-stops-layer` (hollow circles, `location_type` 0/absent). Hover tooltip (`.gtfs-hover`) on both; a click opens the stop or route details in the attributes dock (below). `buildRouteLookup` joins trips → routes at load into `shape_id → route fields`, merged into shape properties so hover needs no runtime join; without trips/routes only `shape_id` shows. Colors are styleKeys `gtfs-shapes` / `gtfs-stops`.

**Popup:** two tabs (`.gtfs-ptab[data-tab]`, `switchTab(id)`, choice kept across opens). **Overview** (default, `renderOverview()`): agency, service dates with days until expiry (warning under 30 days, red once expired), route/stop/station/trip counts, trips on each day type's representative date, the Day to analyze control, the Parts of the day editor, and an empty `#gtfsHealth` for later feed-health flags. **Files:** Day to analyze (`#gtfsDateControls`: `<input type="date" id="gtfsAnalysisDate">` limited to the feed's date range, `#gtfsAnalysisDateDesc` "Fri, Jan 30, 2026 · 31 trips", plus a "special service" note on holiday or added-service dates, and `#gtfsAnalysisDateRange`), then the file list with REQ/OPT badges | CSV table capped at 500 rendered rows. `stop_times.txt` shows the six columns the store keeps (`trip_id, arrival_time, departure_time, stop_id, stop_sequence, timepoint`) in trip and sequence order; `shapes.txt` shows its first 500 rows.

**Persistence:** the feed survives a page refresh through `App.gtfsStore` (below). It also rides the full session file as the original ZIP: `state.gtfsZip = {name, base64}` from `App.serializeGTFSZip()` (a Promise), restored by `App.restoreGTFSFromZip(payload)` through `loadGTFSFile(file, {keepHidden: true})`, so it is identical to an upload and is also written to the store. Session files saved before this carry `state.gtfsData` (parsed tables) and still open through `App.restoreGTFSFromData(serialized)`, which rebuilds the store from the rows; such a feed has no ZIP, so a later session export carries no feed (`serializeGTFSZip()` → null). Never localStorage. `App.serializeGTFSData()` still returns the old parsed-tables shape, rebuilt on each call, for tests and inspection only; it is slow on a big feed. Hidden route/shape sets persist as `moduleState["gtfs-browse"]` and are re-applied when a feed is restored from the cache or a session file, never on a fresh upload.

### Schedule engine and day to analyze

`window.GtfsSchedule` (`js/core/gtfs-schedule.js`, pure; golden `test/cases/gtfs-schedule.mjs` against `test/fixtures/gtfs/mini/EXPECTED.md`, whose nine counting conventions the engine follows). Dates are `"YYYYMMDD"`; times are seconds after service-day midnight (past 24:00 allowed); -1 = missing.

- Reading: `CsvStream(onHeader, onRow)` with `.write(chunk)` / `.end()` (BOM, CRLF/CR, RFC 4180 quotes, chunk boundaries anywhere), `parseCSV(text)`, `parseTime`, `formatTime`.
- Store: `StopTimesBuilder` (`.header/.row/.finish`) → `{tripIds, stopIds, trip, stop, seq, arr, dep (Int32Array), tp (Uint8Array, 255 = blank), tripStart, rowCount, badRows, duplicateRows}`, sorted by trip then sequence; a duplicate (trip, sequence) keeps the first row.
- `buildFeed(tables, store)`, `feedFromTexts(texts)`; bad references are counted in `feed.problems`, never thrown.
- Queries (feed first): `dateRange`, `activeServices(date)`, `dayType(date)` → `{weekday, dayType, exception}`, `tripsOnDate(date, {routeIds})` → `{trips, invalid}` (frequency templates expanded; generated ids `template@HH:MM:SS`), `tripStopTimes(tripId, {interpolate})`, `departuresAtStop(date, stopId)` (parent station includes children; a trip's last stop excluded), `medianHeadway(date, stopId, from, to)`, `patterns(date, routeId)` / `dominantPattern(...)`, `routeDaySummary(date)`, `peakVehicles(date, {layoverSec: 600})` (block method when any trip that date has a `block_id`, otherwise trip sweep; both reported, plus `method`), `stopAccessibility()`, `busiestDate(dayType)` (null when no such day has service). Results are plain values. The feed caches the last six dates' trip lists.

Runtime: `App.gtfsSchedule()` → the loaded feed or null. `App.gtfsAnalysisDate.get()` / `.set("YYYYMMDD")` (false when invalid or no feed) / `.onChange(fn)` (returns an unsubscribe function; fires with null on clear). One exact date drives every GTFS analysis. On load it keeps the session's date if the feed covers it, otherwise it starts on the busiest weekday (`busiestDate("weekday")`). Saved additively as `moduleState["gtfs-browse"].analysisDate`.

Details engine (feed first; golden cases `a4-*`): `stopDepartures(date, stopId, {routeIds})` (every visit incl. a trip's last stop, `last` flag, headsign), `stopSummary(date, stopId, {routeIds, dayParts})` → departures, routes, span, per-part median headway, `peakHeadwaySec` (parts `am`+`pm`) and `offPeakHeadwaySec` (`midday`), `stopSpacing(date, stopId, {routeIds})` (great-circle metres to the neighbours on each route/direction's most common pattern), `routeSchedule(date, routeId, {dayParts})` (per direction: trips, running seconds, span, per-part headway, patterns with headsign), `feedOverview({today, dates})`. Headway = median gap between consecutive departures inside one part of the day.

Service and stop engine (feed first; golden cases `a5-*`; used by `gtfs-service-analysis.md`): `routeServiceDay(date, {routeIds, layover:{mode, value, maxBlockGapMin}, deadheadPct})` → per route and total trips, running / layover / revenue / deadhead / platform seconds, span, peak vehicles with method (block, setting, mixed); `serviceYear({dates, dayCounts, routeIds, layover, deadheadPct, rate, rateBasis, rateOverrides})` → per day type, weekly (5 × weekday + Saturday + Sunday) and annual figures with cost; `calendarDayCounts({routeIds})` → service days per day type in the feed's calendar (holidays count under their weekday), scaled to a year; `stopSpacingStats`, `consolidationCandidates`, `stopServiceTable` (same numbers as `stopSummary`, one pass), `wheelchairByRoute`. Trip records carry `wheelchair` (`wheelchair_accessible`).

Hooks for other modules: `App.gtfsRepresentativeDates()` (one date per day type, as used by copies), `App.gtfsScopeRouteIds(includeHidden)` (null = all), `App.gtfsOnInputsChange(fn)` (feed, date, hidden routes, day parts or stop list changed; returns an unsubscribe function), `App.gtfsAddRouteTab({id, label, render(el, routeId, state, refresh)})` (an extra route details tab; `routeId` is the schedule `route_id`), `App.gtfsAddStopTab({id, label, render(el, stopId, state, refresh)})` (the stop-view twin; `stopId` is the schedule `stop_id`; `state` is per view and survives instant redraws, `refresh()` redraws the view), `App.gtfsRefreshDetails()`.

### Parts of the day — `App.gtfsDayParts`

One setting for copied Service bands (`serviceCopyPlan`) and every headway report. `.get()` → six `{id, label, start}` (ids/labels fixed: early, am, midday, pm, evening, night); `.set(starts)` takes six `"HH:MM"`, the first `"00:00"`, strictly increasing, and returns false (no change) otherwise; `.reset()`; `.isDefault()`. Saved as `moduleState["gtfs-browse"].dayParts` only when not the standard parts; a change redraws the open details view and the Overview at once.

### Stop and route details (attributes dock)

Clicking a GTFS stop (preferred) or route with no drawn feature under the cursor opens a read-only dock view (`App.openDockView`, see `drawing-and-features.md`). `editing.js` owns the click: `App.gtfsPickAt(point)` → `{kind:"stop", stopId}` | `{kind:"route", routeId, shapeId}` | null, then `App.gtfsOpenDetails(target)` (also used by the route Stops list). Skipped in presentation mode. View keys: `gtfs:stop:<id>`, `gtfs:route:<routeKey>` (unassigned shapes add `|<shapeId>`).
- Stop tabs: **Details** (every `stops.txt` field plus type and wheelchair access, inherited from the station), **Trips** (departures/arrivals for the day to analyze, by time or route, first 200 rows then "Show all", summary with span, per-part and peak/off-peak headways, routes served, "Show hidden routes" when any route is hidden), **Spacing** (distance to adjacent stops per route and direction), **Coverage** (below). Toolbar: Zoom to, Copy as Point (only with coordinates), Add/Remove stop selection.
- Route tabs: **Details** (`routes.txt` fields, mode, shape count), **Stops** (most common pattern per direction; each stop opens its own view), **Schedule** (per direction trips, span, running hours, per-part headways, patterns; trips by day type). Toolbar: Zoom to, Copy as Service with schedule. The route is highlighted while its view is open.
- Instant (gate G4b): the analysis date, hidden routes and the parts of the day redraw an open view in place (`refreshDetails`); there is no Run button or stale banner. Hidden routes drop out of stop figures unless "Show hidden routes" is ticked. Equity figures for a stop are not here yet.
- **Coverage tab** (stops): the instant part reads the schedule only. Mode is rail when any route serving the stop on the analysis date (hidden routes excluded) has `route_type` 0, 1, 2, 5, 7 or 12 (`AnalysisNetwork.modeOf`), else bus; walk distance is the one coverage analyses use (¼ mi bus, ½ mi rail); trips and combined peak headway come from `GtfsSchedule.stopServiceTable` (the numbers the Trips tab shows); "Frequent" is peak headway ≤ 15 min. The **Count residents** button is the only thing that touches the Census Bureau: it fetches block groups around a circle of that radius (`App.fetchTigerwebGeos("bg", circle)`), then their blocks (`App.fetchBlockPopulations`), and sums `POP100` of blocks whose internal point is within the radius (`ServiceEquity.distanceMi`), showing "About N residents live within ¼ mi (2020 census blocks)." The result lives in the per-view state (`state.coverage`), so instant redraws keep it; it is dropped when the radius changes (a date change flips the mode). While running it reads "Counting…"; a failure shows "Could not count residents: <reason>". Test: `test/browser/gtfs-stop-coverage.test.mjs`.
- RTD (busiest stop, 713 departures): opening a view ≈ 10 ms, Trips tab ≈ 30 ms, Show all ≈ 40 ms.

### Route browser engine

Pure helpers on `App.gtfsBrowse` (no DOM/map/turf; golden-tested in `test/cases/gtfs-browse.mjs`, so load-time `document` access must stay guarded): `naturalCompare(a,b)`, `buildRouteIndex(shapesFC, tripsRows, routesRows)`, `filterRoutes(index, query)`, `representativeShape(route)` (most trips, tie → longest), `buildVisibilityFilter(hiddenRoutes, hiddenShapes)` (MapLibre expression or `null`), `uniqueServiceId`, `shapeDirections`, `UNASSIGNED_KEY` (`"__unassigned__"`).

Index entry: `{ routeKey, route_id, short, long, type, color ("#rrggbb"|""), agency_id, shapes: [{shape_id, lengthMi, tripCount, headsigns}], tripCount }`. Routes sort naturally by short/long/route_id; shapes by trips desc then length desc; route-less shapes go under a synthetic "Unassigned shapes" route (last; hiding it filters on missing `route_id`); routes with no shape are omitted. A shape's map `route_id` comes from the FIRST trip using it, so the route filter hides it only under that route.

Runtime API (index built in `addMapLayers()`, cleared by `clearGTFS()`): `App.gtfsRouteIndex()` (null when no shapes), `App.gtfsHiddenState()`, `App.gtfsSetRouteHidden(routeKey, bool)`, `App.gtfsSetShapeHidden(shapeId, bool)`, `App.gtfsShowOnly(routeKeys|null)`, `App.gtfsShowAll()`, `App.gtfsHighlight({routeId}|{shapeId}|null)` (overlay `gtfs-shapes-hl-casing` + `gtfs-shapes-hl`), `App.gtfsZoomTo({routeId}|{shapeId})`, `App.gtfsCopy({routeId, mode: "representative"|"each"|"shape"|"service", shapeId})` → created `App.lines` indices. Visibility is one filter on `gtfs-shapes-layer`; changes call `App.refreshLayersPanel()` and `App.cache.save()`.

- `copyShapeToLine(props, {multi, group})` (shared with the map right-click copy) returns the new line index or -1; multi-copies are named `"<name> – <shape_id>"` with `attributes.group` = route name.
- Copies of 2+ shapes run inside `App.undo.batch(fn)` → ONE undo step.
- `mode: "service"` also sets a shared `attributes.serviceId` (route name, made unique via `uniqueServiceId`) and per-shape `direction` from `trips.direction_id` when all trips agree (0 → Outbound, 1 → Inbound), else blank — which shows "Needs setup" in Trip Builder / skipped in Route Costing until set.

**Copy as Service with schedule** (`mode: "service"` when `App.gtfsHasSchedule(routeKey)` is true, i.e. the route has timetable trips on a representative date; otherwise the plain grouped copy above runs unchanged):
- Dates: one per day type, the analysis date when it is an ordinary day of that type, else `busiestDate(type)`.
- Plan: `GtfsSchedule.serviceCopyPlan(feed, {routeId, dates, dayParts})` → per shape with trips: Weekday/Saturday/Sunday bands, `runTime` (mean trip minutes, weekday → Saturday → Sunday), `directionId`, dominant stop list, plus `unshaped` counts and a `reconciliation` row per day. Bands come from `headwayBands(departures, dayParts)` over `DEFAULT_DAY_PARTS` (Early 00:00, AM peak 06:00, Midday 09:00, PM peak 15:00, Evening 18:00, Night 21:00): first band starts at the first departure rounded down to 5 min, last ends at the last departure rounded up; headway is the first of 2…120 min (then the largest 1–4-decimal value) for which `bandTripCount(from, to, h)` — Route Costing's own `ceil(minutes / headway)` — equals the real trip count, so trips always match exactly. Sunday mirrors Saturday when the bands are equal.
- Lines: one per plan shape with `service`, `runTime` and `avgSpeed` = shape length ÷ run time (Route Costing's default speed mode then gives the same one-way time); direction from `direction_id` (single shape: Loop when its ends are within 100 m, else Both).
- Stops (default on; `stops: false` skips): one Point per stop with `stopId`, `group` "<route> stops" and `associatedRoutes` → the copied lines. A Point with the same `stopId` within 2 m is reused and only gains links (no new attribute field).
- One undo step. Returns the line indices with `.note` (`GtfsSchedule.reconciliationNote(plan, name)`: trips copy vs timetable per day, running hours flagged beyond 3 %, unshaped trips, stop counts) and `.stops = {created, reused, skipped}`. The Layers-tab route menu ("Copy as Service with schedule") and the map right-click ("Copy route as Service with schedule") show the note with `App.gtfsShowCopyNote(text)` (layers-panel.js; `#gtfs-copy-note`).
- Test: `test/browser/gtfs-copy-service.test.mjs`.

The Layers-tab browser UI (over this `App.gtfs*` API) lives in `js/core/layers-panel.js`, which also exports `App.gtfsRestoreHighlight()`.

**Map right-click on shapes:** entries grouped by route (route heading only when 2+ routes under the cursor), labels like `Copy as line: Red · 177198 · 42 trips`; each item's `onHover` previews `App.gtfsHighlight({shapeId})`, and leaving/closing calls `App.gtfsRestoreHighlight()` (re-applies the pinned Layers highlight or clears).

Tests: `test/gtfs-browser-smoke.mjs` (Playwright, synthetic feed; drives the Layers-tab UI and right-click menu); `test/ui-screens/capture.mjs` → `<theme>_gtfs-route-browser.png`.

### Feed persistence across refresh — `App.gtfsStore` (`js/core/gtfs-store.js`)

Sibling of `network-store.js` (same `_withStore` transaction rule: issue requests synchronously or from another request's `onsuccess`, never after an `await`; same swallow-every-failure stance). Keeps the ORIGINAL ZIP bytes — several times smaller than the parsed tables, and re-parsing goes through the same `loadGTFSFile()` path as an upload, so a restored feed can never differ from an uploaded one. DB `mat-gtfs-cache`, store `feeds`, keyed by file name (`savedAt` index); record `{name, savedAt, size, bytes}`. API: `supported()`, `save(name, arrayBuffer)`, `latest()`, `clear()`, `MAX_ENTRIES` (2 — the last two feeds, e.g. Build and No-Build; only the most recent is restored). Re-loading a stored file name replaces its copy; a failed write retries once after dropping the other feed.

- `loadGTFSFile(file, opts)` resolves `true` when the feed is on the map. After a successful non-restored load, `persistFeed()` writes the ZIP (deferred one tick). `App.restoreCachedGTFS()` (called once from `app.js` after `cache.restore()`, so the stop list and queued hidden sets are already in place) re-parses the latest stored ZIP with `{restored: true}`: a restored load keeps `_pendingHidden`, is not written back, and reports "GTFS feed restored from last session: <name>".
- `_loadSeq` is bumped by every load and every clear, so a slower, older load notices it was superseded: a ZIP picked while the restore is still reading wins, and a feed cleared right after loading is never written back.
- **Build vs No-Build:** only one feed is active; loading a second ZIP replaces it and keeps the stop selection (the list is the bridge between scenarios). Hidden routes reset on a swap.
- `clearGTFS()` (Remove layer, Clear all features, Reset Session) empties the store so a dismissed feed does not resurrect; an unreadable stored copy is dropped after one failed restore. A feed from a session file's embedded ZIP is written to the store like an upload; one from an old-format session file (parsed tables, no ZIP) is not, so it survives a refresh only if that file is loaded again.
- Tests: `test/browser/gtfs-cache.test.mjs`. The session autosave is debounced 500 ms, so wait ~900 ms before reloading.

### Stop selection

A persisted list of `stop_id` strings kept SEPARATELY from the loaded feed, so one list can be checked against several scenario feeds. Highlight layer `gtfs-stops-selected` (blue fill, white outline, radius 6, same source/`before` as the stops layer; visibility and opacity mirrored by `syncHighlightStyle()`).

Pure helpers on `App.gtfsStopList` (golden: `test/cases/gtfs-browse.mjs`): `parseStopIdList(text)` → `{ids, headerFound, blanks, duplicates}` (header row with a `stop_id` column if the first non-empty record has one, else first column; BOM stripped; trimmed, de-duplicated), `reconcile(ids, feedStopIds)` → `{present, missing}`, `stopListCSV(ids, stopsRows, feedFile)` (columns `stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,in_feed,feed_file`; feed rows in `stops.txt` order with `in_feed` 1, then ids absent from the feed with `in_feed` 0; RFC 4180 quoting).

Runtime API `App.gtfsStops`: `ids()`, `count()` → `{total, inFeed}` (`inFeed` counts every `stop_id` in `stops.txt`, stations included, to agree with the CSV), `has(id)`, `set/add/remove/clear`, `feedFileName()`, `isAvailable()` → `{ok, reason}` (needs a loaded feed with a visible stops layer), `candidates()` (drawn stops only: `location_type` 0/blank), `zoomTo()`, `exportCSV()` (download `gtfs-stops-selected-<zip name>-<YYYY-MM-DD>.csv`; the download helper is duplicated locally because `cache.js`'s is private), `importFromFile(file)` (replaces the selection; status reports not-in-feed and duplicate counts).

- **Lifecycle:** every mutation ends in the private `changed()` (highlight filter, `App.cache.save()`, Layers panel, box-select bar), so nothing may write `_selectedStops` directly. Loading another ZIP keeps the selection; `App.clearGTFS()` clears it; an id missing from the feed stays selected and shows as "not in this feed". `_feedFileName` is the name of the feed currently loaded, not the feed the list was made against.
- Ways to build it: box select (target `"gtfs-stops"`, registered with `App.boxSelect.registerTarget`), the stop right-click menu (**Add to / Remove from stop selection**), and list import.
- **Persistence:** `moduleState["gtfs-browse"]` gains additive `stops` (ordered ids) and `feedFile`, collected whether or not a feed is loaded and restored without needing one.
- **Export button:** `#export-gtfs-stops` (hidden by default) in the Export menu is shown with the label `Selected GTFS stops (CSV) · N` only while a feed is loaded and the selection is non-empty; its format handler in `app.js` calls `App.gtfsStops.exportCSV()` before any `App.cache` format.
- **Layers row:** the stops entry carries `badge()` (`"N sel."`, or `"N* sel."` when some ids are missing from the feed) and `menuItems()` (Select stops by box, Select stops from list…, and while stops are selected: Zoom to / Export / Clear); see `layers-and-styling.md`.
- Tests: `test/gtfs-stop-select-smoke.mjs`.

`App.setGtfsLayersVisible(visible)` → shows/hides both the GTFS route and stop map layers.

### Analysis network — `window.AnalysisNetwork` (`js/core/analysis-network.js`) and `App.buildAnalysisNetwork` (`js/core/analysis-network-source.js`)

One network of the GTFS trips of a date plus synthetic trips for drawn Services (gate G6c), the input of the
coverage, equity and travel-time analyses.
- Engine (pure; golden `test/cases/analysis-network.mjs`): `bandTrips(bands, runtimeMin)` (Trip Builder's
  generator, which now calls it), `stopTimesAlong(startMin, runtimeMin, distMi, lengthMi)` (time ∝ distance
  along the line; by index when the length is unusable), `proposalTrips(proposal, dayType)` (`both` adds
  the reversed way with the other direction id), `modeOf(route_type)` (0, 1, 2, 5, 7, 12 → rail, else bus),
  `build({feed, date, routeIds, proposals})`, `stopService(network, dayParts)` (equals `stopServiceTable`
  for a GTFS-only network).
- Network: `{date, dayType, stops [{id, srcId, source, name, lat, lon}] sorted by id, stopIndex, routes
  {key: {key, source, srcId, name, mode, color}} (only routes with trips), routeOrder, trips [{id, routeKey,
  source, directionId, stops: [stop index], arr, dep}] (seconds; sorted by first departure), counts}`. Ids:
  `g:<stop_id>` / `g:<route_id>` / `g:<trip_id>`; drawn `d:point-<pointIdx>`, `d:<serviceKey>#<pattern>#<n>`
  for spaced stops, `d:<serviceKey>`.
- `App.buildAnalysisNetwork({date, includeHidden, gtfs, proposals})`: feed and analysis date from this
  module, scope `App.gtfsScopeRouteIds(includeHidden)`; drawn Services from `App.buildTransitServices()`
  (skipped with a reason in `proposalsSkipped`: needs setup, hidden, no run time, no line). Stops are the
  Service's associated stop Points placed by `turf.nearestPointOnLine`; under two, stops every 0.25 mi. A
  single "Both" pattern runs both ways. `notes` carries "Proposals use evenly spaced trips from their
  headway bands." whenever a proposal is in. Test: `test/browser/analysis-network.test.mjs`.

## gtfs-popup.html

Overview tab (see Popup above). Files tab — left: file directory + layer visibility checkboxes + Clear. Right: CSV table with row/column count.

## Schedule router (`js/core/raptor.js`, `window.Raptor`)

Pure; reads only the analysis network. `Raptor.prepare(network)` sorts trips by first departure.
`Raptor.route(prep, access [{stop, sec}], transfers [stopIdx → [{to, sec}]], departSec, {maxRounds 3, maxSec 7200,
minTransferSec 0})` → `{arrival, rounds}` per stop (Infinity / −1 unreached; round 0 = walk only). Each round scans
every trip, boarding at the first stop labelled in the previous round in time. Walking transfers start from every
stop a ride reached in the round, improved or not: a stop reached earlier on foot cannot transfer again, so its
ride arrival still matters (a brute-force comparison caught this). `Raptor.profile(prep, access, transfers, fromSec,
toSec, stepSec)` → per stop best / typical (lower median) / worst (90th percentile) travel time over the departures
`fromSec, fromSec + step, … < toSec`. Golden: `test/cases/raptor.mjs`. About 50 ms per departure on an 8,000-stop,
25,000-trip synthetic network.

`App.computeScheduleTravelshed(opts)` (`analysis-network-source.js`) runs it for Transit Travelshed: street walk
from the origin to stops within the access cap (`App.walkKmToPoints`), transfers by straight line × 1.3 up to the
transfer cap, one `route` per departure (yielding every 3), the chosen statistic per stop, then
`App.computeOffsetWalkCostMap` walks out from each reached stop (its travel time as a starting cost, egress cap) and
traces the bands.
