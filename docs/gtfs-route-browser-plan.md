# GTFS Route Browser — implementation plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/gtfs.md. This file is historical.

## Goal

Make a loaded GTFS feed browsable route-by-route from the **Layers tab**, so the
user can find the right shape among variants, highlight it on the map, show/hide
individual routes or shapes, and copy the right one as an editable feature —
instead of copying every fragment and merging them.

Driving use case: a small agency's circulator ("Red") has several shapes
(`177198`, `177198_A`, `177202`) that differ only by short-turns/deviations. The
user wants one editable "Red Line", or all variants grouped as one Service.

## Current state (read before starting)

- `js/projects/gtfs.js` (≈940 lines, IIFE, `App.loadGTFSFile` / `App.clearGTFS`):
  - `buildRouteLookup(data)` → `Map<shape_id, routeInfo>` from the FIRST trip
    that uses each shape (no trip counts).
  - `buildShapesGeoJSON(rows, lookup)` → one LineString feature per shape,
    route info merged into `properties`; kept in closure `_shapesFC`.
  - `addMapLayers()` → source `gtfs-shapes` / layer `gtfs-shapes-layer` (one
    layer for every shape, colored by `route_color`), plus `gtfs-stops`.
  - `setRouteLayerVisibility(bool)` toggles the whole layer.
  - `copyShapeToLine(props)` → `App.addLineFromCoords(coords, {name, color,
    attributes: {mode, notes}})`. Map right-click (`wireHoverEvents`, the
    `contextmenu` handler) lists "Copy As Line: …" per shape under the cursor
    (`flagDuplicateShapes` appends `[shape_id]` when names collide).
  - A feed can be serialized into the full session file (`serializeGTFSData`)
    and restored (`restoreGTFSFromData`).
- `js/core/layers-panel.js` (≈1240 lines): the `REFERENCE` manifest has one row
  `{ id: "gtfs-shapes-layer", label: "GTFS routes", … }` rendered by
  `buildLayerRow` (show/hide, opacity, drag-reorder, ⋯ menu). The Drawn band
  already renders expandable nested groups (`attributes.group`) — reuse its row
  styling/expand-caret patterns for the GTFS sub-list.
- Feature IDs, Groups, Service IDs: see CLAUDE.md ("Stable feature IDs",
  `attributes.group`, `attributes.serviceId`, `js/core/service-assembly.js`).
  Services currently allow **max 2 patterns**.

## Design principles

1. **One map layer, filters not layers.** Per-route/per-shape visibility and
   highlighting use MapLibre `filter` / paint expressions on the existing
   `gtfs-shapes-layer`, plus ONE extra highlight layer (`gtfs-shapes-hl`,
   source `gtfs-shapes`, filtered to the highlighted ids). Never one layer per
   route — feeds can have thousands of shapes.
2. **Data model built once at load**, in `gtfs.js`, exposed read-only:
   `App.gtfsRouteIndex()` → `[{ routeKey, route_id, short, long, type, color,
   agency_id, shapes: [{ shape_id, lengthMi, tripCount, headsigns: [...] }],
   tripCount }]` sorted naturally (route_short_name, so "2" < "10"; fall back to
   long name, then route_id). Shapes inside a route sorted by tripCount desc,
   then length desc. Shapes with no route (no trips.txt/routes.txt) go under one
   synthetic "Unassigned shapes" route.
3. **Lazy DOM.** Routes collapsed by default; a route's shape rows are built only
   when expanded. A filter box narrows routes by short/long name, route_id or
   shape_id (case-insensitive substring). Render at most ~200 route rows at once;
   if more match, show "Showing 200 of N — refine the filter".
4. **Visibility state lives in `gtfs.js`** (`_hiddenRoutes`, `_hiddenShapes`
   Sets keyed by route_id / shape_id), applied by rebuilding ONE filter
   expression. The layer-wide show/hide row keeps working exactly as today.
   Persist the hidden sets in the session cache only alongside a restored feed
   (additive field; ignored when no feed).
5. **Copy reuses `copyShapeToLine`.** Extend it (don't fork) so copies get:
   name `"<short or long name>"` for a single copy, `"<name> – <shape_id>"` when
   copying several shapes of a route; and, for multi-copy, a shared
   `attributes.group` = route name.
6. **Pure logic is golden-testable.** Put trip counting, natural sort, filtering,
   "representative shape" choice, and filter-expression building in pure
   functions exposed on `App.gtfsBrowse` (no DOM/map at load) and add
   `test/cases/gtfs-browse.mjs`.

## Phases

### Phase 1 — Route index + map filtering engine (gtfs.js) · Sonnet

- Count trips per shape (`trips.txt`), collect distinct headsigns, compute
  `lengthMi` (equirectangular sum, no turf needed) per shape; build
  `routeIndex` at `addMapLayers()` time; clear it in `clearGTFS()`.
- Pure helpers on `App.gtfsBrowse`: `naturalCompare(a,b)`,
  `buildRouteIndex(shapesFC, tripsRows, routesRows)`,
  `filterRoutes(index, query)`, `representativeShape(route)` (most trips; tie →
  longest), `buildVisibilityFilter(hiddenRoutes, hiddenShapes)` (returns a
  MapLibre expression or `null` when nothing hidden).
- Public API: `App.gtfsRouteIndex()`, `App.gtfsSetRouteHidden(routeId, bool)`,
  `App.gtfsSetShapeHidden(shapeId, bool)`, `App.gtfsShowOnly(routeIds|null)`,
  `App.gtfsShowAll()`, `App.gtfsHighlight({routeId?|shapeId?}|null)`,
  `App.gtfsZoomTo({routeId?|shapeId?})`, `App.gtfsCopy({routeId, mode:
  "representative"|"each"|"shape", shapeId?})` → returns created line indices.
  Fire `App.refreshLayersPanel()` after visibility changes.
- Highlight layer: thick (≈6px) semi-opaque line in the route color with a
  white casing, above `gtfs-shapes-layer`, below drawn features.
- Golden tests for the pure helpers; smoke checks via a new
  `test/gtfs-browser-smoke.mjs` (Playwright, same vendored-CDN setup as
  `test/feature-merge-smoke.mjs`) that loads a small synthetic GTFS feed
  (build it as a zip in the test with JSZip, or call the restore path with a
  serialized feed) and asserts index contents, filters and copies.

### Phase 2 — Layers tab UI (layers-panel.js) · Sonnet, reviewed by orchestrator

- Under the "GTFS routes" reference row, an expand caret reveals the browser:
  filter box, "Show all / Hide all / Show only filtered", then route rows
  (color dot, short name, long name muted, "(n shapes)", eye, ⋯). Expanding a
  route shows shape rows: shape_id · length · trips · top headsign, eye, ⋯.
- Hover row → `gtfsHighlight`; mouseleave → clear (unless a row is "pinned" by
  click — click toggles a pinned highlight and zooms on double-click).
- ⋯ / right-click menu, route row: Copy as line (representative shape) · Copy
  each shape as a line · Show only this · Zoom to. Shape row: Copy as line ·
  Show only this route · Zoom to.
- Keep expand state, filter text and scroll position across
  `refreshLayersPanel()` rebuilds (it re-renders often).
- Tokens/shared primitives only (CLAUDE.md "Design tokens"), light + dark,
  narrow panel width (208px panel — truncate names with ellipsis, full name in
  `title`). Keyboard: rows focusable, Enter toggles expand, context-menu key opens ⋯.
- Smoke: drive the real UI (expand, filter, hover highlight → highlight layer
  filter set, eye toggles → main layer filter, copy → new line with right name/
  color/attributes). Run `test/ui-screens/capture.mjs`; add a capture of the
  expanded browser (light/dark) and inspect it.

### Phase 3 — "Copy all as grouped Service" + >2 patterns · **Opus** (delicate)

- Raising the Service pattern limit touches `js/core/service-assembly.js`,
  Route Costing (round-trip math assumes 1–2 patterns and opposite-direction
  pairing), Trip Builder (column resolution) and their golden tests. Design
  first: how N patterns cost (each pattern's own bands × runtime, no
  "pair" doubling), which validation warnings still apply, how Trip Builder
  shows N columns. Write the decision into this plan before coding; numbers in
  existing golden cases must not move for 1–2-pattern services.
- Then add route-row action "Copy all as grouped Service": copies every shape,
  sets shared `group` and `serviceId` = route name, direction left blank for the
  user (or GTFS `direction_id` → Outbound/Inbound when present and unambiguous).

#### Phase 3 design (decided before coding)

**Scope rule.** Every 1- and 2-pattern code path stays byte-for-byte the same;
the new math runs only when a Service has **3 or more** patterns (`N ≥ 3`).
Existing golden values must not move; new cases are added only.

**Costing an N ≥ 3 Service (Route Costing `computeService`).** A 2-pattern
Service is costed as one cycle = out + back + one layover, at the minimum
headway. That "cycle" is meaningless for e.g. three variants of a circulator
or two outbound branches + one inbound, so for N ≥ 3 each pattern is costed as
**its own one-way trip stream**, no pair doubling:

- Trips / revenue hours / miles: exactly as today — each pattern's own bands ×
  its own one-way runtime / length (this loop was already per pattern).
- Layover: charged **per one-way trip**, at half of what a cycle of two of that
  pattern's trips would get: `computeLayoverHrs(2 × oneWay_p) / 2` — i.e.
  `oneWay_p × pct` in percent mode and `layoverValue / 2` minutes in minutes
  mode. This is the same per-trip layover a 2-pattern Service effectively pays
  (its cycle layover spread over its 2 trips), so the two models agree.
- Peak vehicles per day: `Σ_p (oneWay_p + layoverPerTrip_p) × 60 / minHeadway_p,day`
  over the patterns that run that day (raw), rounded **once** with `ceil` (same
  rounding as today). For a 2-pattern Service at one headway this sum equals
  today's `cycleHrs × 60 / minHeadway`, so it is a strict generalization.
- Summary fields: `rtMiles` = Σ lengths, `runTimeMin` = Σ one-ways, `layoverMin`
  = Σ per-trip layovers, `cycleMin` = their sum, `tripsPerCycle` = N
  (`cycles` = trips / N, informational only), `peakHeadwayMin` = min headway.
- `computeRoundTrip` for N ≥ 3 returns Σ one-ways / Σ lengths (same shape as
  the 2-pattern branch) for the header columns.

**Validation for N ≥ 3 (`service-assembly.js validateService`).** The
"max 2" hard error is removed. The opposite-direction pair rule cannot apply,
so it is replaced by one honest rule: every pattern must have a **one-way**
direction (NB/SB/EB/WB/Inbound/Outbound/Loop/CW/CCW). `Both` (which is also what
a blank direction reads as) is an error in an N ≥ 3 Service, because each
pattern is costed as one-way and "Both" would silently halve its cost. Repeated
directions (two Outbound variants) are allowed. The runtime and service-band
checks apply unchanged.

**Trip Builder.** N ≥ 3 → one column per pattern, in pattern order (stable
sort by the existing direction rank). Label = the direction; when a direction
appears on more than one pattern the label becomes `"<direction> · <pattern
name>"` so the columns are distinguishable. The day grid shows at most 3
columns per row and wraps the rest.

**"Copy all as grouped Service" (gtfs.js `App.gtfsCopy({routeId, mode:"service"})`).**
Copies every shape of the route in one undo step, sets shared
`attributes.group` and `attributes.serviceId` = route display name (made unique
with " (2)", " (3)" … if a Service id is already in use), and `direction` from
GTFS `trips.direction_id` when every trip on that shape agrees (0 → Outbound,
1 → Inbound), otherwise blank. A blank direction makes the Service show
**"Needs setup"** in Trip Builder / a skipped row in Route Costing until the
user sets directions — honest rather than guessing. No bands/speed are copied,
so a fresh copy always needs setup (bands + speed/run time) anyway.

### Phase 4 — Map right-click improvements · Sonnet

- In the `contextmenu` handler, group the shape entries by route with trip
  counts ("Red · 177198 · 42 trips"), and highlight the corresponding shape
  while a menu item is hovered (needs a small optional `onHover` hook on
  `App.showContextMenu` items — additive, existing callers unaffected).

## Docs & conventions

Each phase updates CLAUDE.md (gtfs.js / layers-panel.js entries, new App API,
new test files) and this file's status line. Commits end with the session's
attribution trailers and a `Verified:` line (golden count + smoke result).
