# GTFS

Read the code when this and the code disagree. See `docs/archive/gtfs-route-browser-plan.md` and `docs/archive/gtfs-stop-selection-plan.md`.

## gtfs.js (module `"gtfs"`)

GTFS ZIP viewer (JSZip + PapaParse) plus the route-browser engine. Wires its own Add Data buttons (hidden `#gtfs-file-input`), no `app.js` changes. Styles `.gtfs-*` in `css/style.css`.

**Loading:** `App.loadGTFSFile(file)` unzips, strips a top-level folder prefix, parses each `.txt` into private `_gtfsData` (Map filename → `{headers, rows}`). `App.clearGTFS()` removes the feed, layers and route index, and refreshes the Layers panel. `App.gtfsData` is assigned once at load time (`null`) — **not** a live reference; don't read feed data through it.

**Map layers** (below drawn features, non-editable): `gtfs-shapes`/`gtfs-shapes-layer` (dashed `[4,2]` lines from `shapes.txt`) and `gtfs-stops`/`gtfs-stops-layer` (hollow circles, `location_type` 0/absent). Hover (`.gtfs-hover`) and click detail (`.gtfs-detail`) on both. `buildRouteLookup` joins trips → routes at load into `shape_id → route fields`, merged into shape properties so hover needs no runtime join; without trips/routes only `shape_id` shows. Colors are styleKeys `gtfs-shapes` / `gtfs-stops`.

**Popup:** file list with REQ/OPT badges | CSV table capped at 500 rendered rows (`stop_times.txt` can be millions).

**Persistence:** the feed survives a page refresh through `App.gtfsStore` (below) and also rides the full session file (`App.serializeGTFSData` / `App.restoreGTFSFromData`, called from `cache.js`), never localStorage. Hidden route/shape sets persist as `moduleState["gtfs-browse"]` and are re-applied when a feed is restored from the cache or a session file, never on a fresh upload.

### Route browser engine

Pure helpers on `App.gtfsBrowse` (no DOM/map/turf; golden-tested in `test/cases/gtfs-browse.mjs`, so load-time `document` access must stay guarded): `naturalCompare(a,b)`, `buildRouteIndex(shapesFC, tripsRows, routesRows)`, `filterRoutes(index, query)`, `representativeShape(route)` (most trips, tie → longest), `buildVisibilityFilter(hiddenRoutes, hiddenShapes)` (MapLibre expression or `null`), `uniqueServiceId`, `shapeDirections`, `UNASSIGNED_KEY` (`"__unassigned__"`).

Index entry: `{ routeKey, route_id, short, long, type, color ("#rrggbb"|""), agency_id, shapes: [{shape_id, lengthMi, tripCount, headsigns}], tripCount }`. Routes sort naturally by short/long/route_id; shapes by trips desc then length desc; route-less shapes go under a synthetic "Unassigned shapes" route (last; hiding it filters on missing `route_id`); routes with no shape are omitted. A shape's map `route_id` comes from the FIRST trip using it, so the route filter hides it only under that route.

Runtime API (index built in `addMapLayers()`, cleared by `clearGTFS()`): `App.gtfsRouteIndex()` (null when no shapes), `App.gtfsHiddenState()`, `App.gtfsSetRouteHidden(routeKey, bool)`, `App.gtfsSetShapeHidden(shapeId, bool)`, `App.gtfsShowOnly(routeKeys|null)`, `App.gtfsShowAll()`, `App.gtfsHighlight({routeId}|{shapeId}|null)` (overlay `gtfs-shapes-hl-casing` + `gtfs-shapes-hl`), `App.gtfsZoomTo({routeId}|{shapeId})`, `App.gtfsCopy({routeId, mode: "representative"|"each"|"shape"|"service", shapeId})` → created `App.lines` indices. Visibility is one filter on `gtfs-shapes-layer`; changes call `App.refreshLayersPanel()` and `App.cache.save()`.

- `copyShapeToLine(props, {multi, group})` (shared with the map right-click copy) returns the new line index or -1; multi-copies are named `"<name> – <shape_id>"` with `attributes.group` = route name.
- Copies of 2+ shapes run inside `App.undo.batch(fn)` → ONE undo step.
- `mode: "service"` also sets a shared `attributes.serviceId` (route name, made unique via `uniqueServiceId`) and per-shape `direction` from `trips.direction_id` when all trips agree (0 → Outbound, 1 → Inbound), else blank — which shows "Needs setup" in Trip Builder / skipped in Route Costing until set.

The Layers-tab browser UI (over this `App.gtfs*` API) lives in `js/core/layers-panel.js`, which also exports `App.gtfsRestoreHighlight()`.

**Map right-click on shapes:** entries grouped by route (route heading only when 2+ routes under the cursor), labels like `Copy as line: Red · 177198 · 42 trips`; each item's `onHover` previews `App.gtfsHighlight({shapeId})`, and leaving/closing calls `App.gtfsRestoreHighlight()` (re-applies the pinned Layers highlight or clears).

Tests: `test/gtfs-browser-smoke.mjs` (Playwright, synthetic feed; drives the Layers-tab UI and right-click menu); `test/ui-screens/capture.mjs` → `<theme>_gtfs-route-browser.png`.

### Feed persistence across refresh — `App.gtfsStore` (`js/core/gtfs-store.js`)

Sibling of `network-store.js` (same `_withStore` transaction rule: issue requests synchronously or from another request's `onsuccess`, never after an `await`; same swallow-every-failure stance). Keeps the ORIGINAL ZIP bytes — several times smaller than the parsed tables, and re-parsing goes through the same `loadGTFSFile()` path as an upload, so a restored feed can never differ from an uploaded one. DB `mat-gtfs-cache`, store `feeds`, keyed by file name (`savedAt` index); record `{name, savedAt, size, bytes}`. API: `supported()`, `save(name, arrayBuffer)`, `latest()`, `clear()`, `MAX_ENTRIES` (2 — the last two feeds, e.g. Build and No-Build; only the most recent is restored). Re-loading a stored file name replaces its copy; a failed write retries once after dropping the other feed.

- `loadGTFSFile(file, opts)` resolves `true` when the feed is on the map. After a successful non-restored load, `persistFeed()` writes the ZIP (deferred one tick). `App.restoreCachedGTFS()` (called once from `app.js` after `cache.restore()`, so the stop list and queued hidden sets are already in place) re-parses the latest stored ZIP with `{restored: true}`: a restored load keeps `_pendingHidden`, is not written back, and reports "GTFS feed restored from last session: <name>".
- `_loadSeq` is bumped by every load and every clear, so a slower, older load notices it was superseded: a ZIP picked while the restore is still reading wins, and a feed cleared right after loading is never written back.
- **Build vs No-Build:** only one feed is active; loading a second ZIP replaces it and keeps the stop selection (the list is the bridge between scenarios). Hidden routes reset on a swap.
- `clearGTFS()` (Remove layer, Clear all features, Reset Session) empties the store so a dismissed feed does not resurrect; an unreadable stored copy is dropped after one failed restore. A feed that arrives via a session JSON is not written to the store (no ZIP), so it survives a refresh only if that file is loaded again.
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

## gtfs-popup.html

Left: file directory + layer visibility checkboxes + Clear. Right: CSV table with row/column count.
