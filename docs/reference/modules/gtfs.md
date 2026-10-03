# GTFS

Read the code when this and the code disagree. See `docs/archive/gtfs-route-browser-plan.md`.

## gtfs.js (module `"gtfs"`)

GTFS ZIP viewer (JSZip + PapaParse) plus the route-browser engine. Wires its own Add Data buttons (hidden `#gtfs-file-input`), no `app.js` changes. Styles `.gtfs-*` in `css/style.css`.

**Loading:** `App.loadGTFSFile(file)` unzips, strips a top-level folder prefix, parses each `.txt` into private `_gtfsData` (Map filename → `{headers, rows}`). `App.clearGTFS()` removes the feed, layers and route index, and refreshes the Layers panel. `App.gtfsData` is assigned once at load time (`null`) — **not** a live reference; don't read feed data through it.

**Map layers** (below drawn features, non-editable): `gtfs-shapes`/`gtfs-shapes-layer` (dashed `[4,2]` lines from `shapes.txt`) and `gtfs-stops`/`gtfs-stops-layer` (hollow circles, `location_type` 0/absent). Hover (`.gtfs-hover`) and click detail (`.gtfs-detail`) on both. `buildRouteLookup` joins trips → routes at load into `shape_id → route fields`, merged into shape properties so hover needs no runtime join; without trips/routes only `shape_id` shows. Colors are styleKeys `gtfs-shapes` / `gtfs-stops`.

**Popup:** file list with REQ/OPT badges | CSV table capped at 500 rendered rows (`stop_times.txt` can be millions).

**Persistence:** the feed itself rides only the full session file (`App.serializeGTFSData` / `App.restoreGTFSFromData`, called from `cache.js`), never localStorage. Hidden route/shape sets persist as `moduleState["gtfs-browse"]` and are re-applied only when a feed is restored from a session file.

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

## gtfs-popup.html

Left: file directory + layer visibility checkboxes + Clear. Right: CSV table with row/column count.
