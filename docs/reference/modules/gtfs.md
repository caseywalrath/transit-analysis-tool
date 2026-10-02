# Gtfs

Reference detail moved verbatim from `CLAUDE.md`. Read the code when this and the code disagree.

## Files

- **`gtfs.js`** — GTFS Feed Viewer: loads a GTFS ZIP (JSZip + PapaParse), renders shapes.txt as dashed reference lines (gtfs-shapes-layer) and stops.txt as hollow circles (gtfs-stops-layer) below user-drawn features, hover tooltip + click detail popup on both layers (route name/mode for shapes; stop name/ID for stops), shape_id → route info pre-joined from trips.txt + routes.txt at load time, two-column analysis popup (file directory with REQ/OPT badges | scrollable CSV table, capped at 500 rows), layer visibility toggles, clear-feed button. Also a **route browser engine** (`docs/gtfs-route-browser-plan.md` Phase 1; UI comes in Phase 2): a route index built at layer-add time, per-route/per-shape visibility via one filter on `gtfs-shapes-layer`, a highlight overlay (`gtfs-shapes-hl-casing` + `gtfs-shapes-hl`), zoom, and copy-as-line — see the `### gtfs.js` API section. The feed itself is only persisted in the full session file (not re-uploaded then); hidden route/shape sets persist additively as `moduleState["gtfs-browse"]` and are re-applied only when a feed is restored from a session file. The Layers-tab route browser (Phase 2) is UI over this module's `App.gtfs*` API and lives in `js/core/layers-panel.js`. Wires Add Data dropdown buttons directly (no app.js changes needed).

- **`gtfs-popup.html`** — GTFS Feed popup body: two-column layout (left: scrollable file directory with REQ/OPT badges + layer visibility checkboxes + Clear button; right: scrollable CSV table for the selected file with row/column count)

## API

### API — gtfs.js (GTFS Feed Viewer, limited public API)
Registers module `"gtfs"` as a popup-based analysis. Opens in a 2-column popup (960px wide). All state is private to the IIFE closure. No session persistence — the feed must be re-uploaded each session.

**Entry point:** Add Data (+) dropdown → "GTFS" section → "Load GTFS Feed" triggers a hidden `<input id="gtfs-file-input" type="file" accept=".zip">`. The button wiring is done inside `gtfs.js`, not `app.js`.

**Feed loading:** `loadGTFSFile(file)` uses JSZip to unzip the file, then PapaParse to parse each `.txt` entry. Files inside a top-level subfolder are handled (folder prefix is stripped). All parsed files are stored in `_gtfsData` (Map of filename → `{ headers, rows }`).

**Map layers:** Two non-editable reference layers added below user-drawn features:
- Source `gtfs-shapes` / Layer `gtfs-shapes-layer`: dashed gray lines (color #718096, width 2, opacity 0.65, dash [4,2]) built from `shapes.txt`.
- Source `gtfs-stops` / Layer `gtfs-stops-layer`: hollow white circles with gray stroke (radius 4, stroke 1.5) built from `stops.txt` (location_type 0 or absent only).
- Both layers support `mouseenter`/`mousemove`/`mouseleave`/`click` events (identical pattern to `js/core/osm.js`).

**Hover tooltip** (`.gtfs-hover`): Route shapes → route short name + mode label. Stops → stop name + stop_id.

**Click detail popup** (`.gtfs-detail`): Route shapes → colored swatch in title + route_id, long name, mode, agency, shape_id. Stops → stop_id, code, desc, location type, wheelchair status, parent_station, zone_id.

**Route-info join:** `buildRouteLookup(data)` joins `trips.txt → routes.txt` at load time to build a `shape_id → { route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id }` Map. These fields are merged directly into each `shapes.txt` GeoJSON feature's properties by `buildShapesGeoJSON(rows, routeLookup)`, so hover requires no runtime join. Feeds without `trips.txt` or `routes.txt` fall back to displaying `shape_id` only.

**Analysis popup:** Left column — scrollable file directory listing all `.txt` files found in the ZIP with REQ/OPT badges (required files per GTFS spec: agency, stops, routes, trips, stop_times, calendar, calendar_dates). Clicking a file populates the right column. Right column — scrollable CSV table with sticky header, capped at 500 rendered rows with a count note (important for `stop_times.txt` which can have millions of rows). Layer visibility checkboxes and a Clear button appear below the file list once a feed is loaded.

**CSS:** `.gtfs-*` prefix. All styles in `css/style.css` inside the `/* GTFS Feed Viewer module */` block. Includes dark mode overrides.

**Constants:** `ROUTE_TYPE_LABELS` (GTFS route_type integers → readable strings), `LOCATION_TYPE_LABELS` (stop location types), `WHEELCHAIR_LABELS`, `FILE_ORDER` (preferred display order), `REQUIRED` (required-file lookup).

**Public API (on `App`):**
`App.loadGTFSFile(file)` — loads a File object as a GTFS ZIP (same as the file picker flow).
`App.clearGTFS()` — clears the feed, removes map layers, resets UI.
`App.gtfsData` — set at module load time to `null`; note this is a static snapshot, not a live reference to the Map — check `_gtfsData` is not exported live. Future modules needing feed data should call `App.loadGTFSFile` and observe the map layers, or the approach may need revision.

**Route browser engine (Phase 1).** Pure helpers on `App.gtfsBrowse` (no DOM/map/turf; golden-tested in `test/cases/gtfs-browse.mjs`, which loads `gtfs.js` in the sandbox — load-time `document` access is guarded): `naturalCompare(a,b)`, `buildRouteIndex(shapesFC, tripsRows, routesRows)`, `filterRoutes(index, query)`, `representativeShape(route)` (most trips, tie → longest), `buildVisibilityFilter(hiddenRoutes, hiddenShapes)` (MapLibre expression, `null` when nothing hidden), `UNASSIGNED_KEY` (`"__unassigned__"`). Index entry: `{ routeKey, route_id, short, long, type, color ("#rrggbb" or ""), agency_id, shapes: [{ shape_id, lengthMi, tripCount, headsigns }], tripCount }`; routes sorted naturally by short, else long, else route_id; shapes by tripCount desc then length desc; shapes with no known route/trips go under a synthetic "Unassigned shapes" route (always last; hiding it filters on a missing `route_id`); routes with no drawn shape are omitted. Note a shape's `route_id` map property comes from the FIRST trip using it, so the route filter hides such a shape only under that route.

Runtime API on `App` (index built in `addMapLayers()`, cleared by `clearGTFS()`): `gtfsRouteIndex()` (null when no shapes), `gtfsHiddenState()`, `gtfsSetRouteHidden(routeKey, bool)`, `gtfsSetShapeHidden(shapeId, bool)`, `gtfsShowOnly(routeKeys|null)`, `gtfsShowAll()`, `gtfsHighlight({routeId}|{shapeId}|null)`, `gtfsZoomTo({routeId}|{shapeId})`, `gtfsCopy({routeId, mode: "representative"|"each"|"shape"|"service", shapeId})` → array of created `App.lines` indices. Visibility changes call `App.refreshLayersPanel()` and `App.cache.save()`. `copyShapeToLine(props, {multi, group})` is shared with the map right-click copy (which still passes only `props`) and now returns the new line index (or -1); multi-copy names are `"<name> – <shape_id>"` and carry a shared `attributes.group` = route name. `gtfsCopy` with 2+ shapes runs inside `App.undo.batch(fn)` (new in `undo.js`: one snapshot, `push()` calls inside `fn` are no-ops), so "Copy each shape" is ONE undo step; `mode: "service"` ("Copy all as grouped Service", Phase 3) copies every shape like "each" and also sets a shared `attributes.serviceId` = route name (made unique with " (2)", " (3)"… via `App.gtfsBrowse.uniqueServiceId`) and a per-shape `direction` from `trips.direction_id` when every trip on that shape agrees (0 → Outbound, 1 → Inbound; `App.gtfsBrowse.shapeDirections`), else blank — a blank direction in a 3+-pattern Service (or a non-opposite pair) shows "Needs setup" in Trip Builder / a skipped row in Route Costing until set, and a fresh copy has no bands/speed anyway; `clearGTFS()` also refreshes the Layers panel. The Layers-tab UI over this API is described in the `layers-panel.js` entry (Phase 2). Browser smoke test: `test/gtfs-browser-smoke.mjs` (Playwright, synthetic feed zipped in-page; also drives the real Layers-tab browser UI). `test/ui-screens/capture.mjs` adds `<theme>_gtfs-route-browser.png`.

**Map right-click menu (Phase 4):** the shapes `contextmenu` handler groups entries by route (first-seen order, most trips first within a route, trip counts from `_routeIndex`); a route heading divider appears only when 2+ routes are under the cursor. Labels: `Copy as line: Red · 177198 · 42 trips`. Each item uses `onHover` to preview `App.gtfsHighlight({shapeId})`; leaving or closing calls `App.gtfsRestoreHighlight()` (exported by `layers-panel.js`; re-applies the Layers panel's pinned highlight, or clears). Copy behavior (`copyShapeToLine`) and stop entries are unchanged. Covered by `test/gtfs-browser-smoke.mjs`.
