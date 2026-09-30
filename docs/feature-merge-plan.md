# Feature Merge — implementation plan

Status: in progress — Phase 1 (unique, stable feature IDs) and Phase 2 (merge engine, dialog, polygons and lines) are done. Phases are built in order; each phase is one or more commits
on the working branch and must leave the app fully working.

## Goal

Let the user select two or more drawn features in the Features panel, right-click,
choose **Merge…**, review a confirmation dialog, and get one feature. The merge is
undoable (Ctrl+Z) and, from Phase 4, reversible later via **Unmerge**.

## Background (why the phases are ordered this way)

- Multi-select already exists (`js/core/selection.js`, Ctrl/Shift+click in the
  Features panel). The panel right-click menu already acts on multi-selections
  (`js/core/features.js`, the `contextmenu` handler in `buildItem`, next to
  "Group…"). The map right-click menu always single-selects
  (`js/core/editing.js`), so Merge lives in the **Features panel menu only**.
- Undo (`js/core/undo.js`) snapshots the whole session; one `App.undo.push()`
  before a mutation makes it undoable. The `removeX()` functions each push their
  own snapshot, so merge code must NOT call them in a loop (that would create
  several undo steps). Splice the arrays directly after a single push.
- The app is single-part-geometry only: shapefile import explodes Multi*
  geometries (`cache.js`), polygon editing only reads `coordinates[0]`. A merge
  must always produce one `LineString` / one single-ring `Polygon` / one `Point`.
- **Existing bug:** per-type IDs (`pointIdx`, `lineIdx`, `routeIdx`, `polyIdx`)
  are assigned as `array.length + 1`, so they repeat after any delete. They are
  used to (a) map a clicked map feature back to its array index
  (`editing.js findXIndex` / `findXIndexByProp`) and (b) link stops to routes
  (`attributes.associatedRoutes[].featureId`, read by Transit Travelshed and the
  route picker). Imported features (`cache.js _makeFeature`) get no ID at all.
  Merging deletes features, so this must be fixed first.

## Phase 1 — Unique, stable feature IDs

1. In `js/core/utils.js`, next to the `colorSeq` counter, add per-type ID
   counters and:
   - `App.nextFeatureId(type)` — `type` ∈ `point|line|route|polygon`; returns the
     next integer for that type's ID field and advances the counter.
   - `App.FEATURE_ID_PROP = { point: "pointIdx", line: "lineIdx", route: "routeIdx", polygon: "polyIdx" }`.
   - A **pure** `App._assignFeatureIds(arraysByType)` that walks each array in
     order and stamps a fresh ID on any feature whose ID is missing, non-numeric,
     or duplicates an earlier feature of the same type (first occurrence — the
     older feature — keeps it). Returns
     `{ changes: [{type, index, oldId, newId}], maxByType: {...} }`. It must not
     touch DOM/map/turf so the golden harness can load it.
   - `App.ensureFeatureIds()` — runs `_assignFeatureIds` over the live arrays and
     advances the counters past every ID in use. Returns the change list.
2. Call `App.ensureFeatureIds()` in `cache.js applyState()` right after the
   features are pushed (same place the colorSeq counter is advanced). That covers
   session restore, file import, shapefile/CSV/GeoJSON import and undo/redo.
   Stop links that referenced a duplicated ID stay pointing at the first (older)
   feature — the ambiguity can't be resolved retroactively; note this in a code
   comment. No schema version bump is needed (the pass is idempotent).
3. Replace every `length + 1` **ID** assignment with `App.nextFeatureId(type)`
   (`points.js`, `lines.js`, `routes.js`, `polygons.js` — including the
   duplicate functions). Keep the default **names** ("Route 3") as they are.
   Grep for any other code that pushes into `App.points/lines/routes/polygons`
   and make sure new features get an ID.
4. `duplicateLine` / `duplicateRoute` copies must get their own
   `colorSeq: App._nextColorSeq()` when the source has no explicit color
   (today a duplicated route has no colorSeq and falls back to array position).
5. Golden test: `test/cases/feature-ids.mjs` covering `_assignFeatureIds`
   (missing IDs, duplicates, non-numeric, already-unique = no changes, mixed
   types). Seed with `--update`.
6. Add a browser smoke test `test/feature-merge-smoke.mjs` (Playwright, same
   vendored-CDN interception approach as `test/ui-screens/capture.mjs`; run with
   `NODE_PATH=<playwright install>/node_modules node test/feature-merge-smoke.mjs`).
   It loads the app, drives `window.App` via `page.evaluate`, and asserts. Phase 1
   assertions: draw 3 routes via the API, delete the first, add another — all
   `routeIdx` unique; restore a session containing duplicate IDs — IDs become
   unique; clicking resolution (`findRouteIndexByProp` semantics) is unambiguous.
   Later phases extend this file.

## Phase 2 — Merge engine, dialog, polygons and lines

New file `js/core/merge.js` (IIFE, `App.merge`), loaded after
`feature-attributes.js` in `index.html`. Styles use a new `.fm-` prefix in
`css/style.css`, built from existing tokens/primitives (`--space-*`, `--text-*`,
`.rf-action-primary`, `.rf-btn-sm`, status colors) — no raw hex for chrome.

### Pure geometry helpers (golden-tested, no turf)

`App.mergeGeom.chainLines(coordArrays, opts)` — orders N polylines end to end:
try every segment × orientation as the start, greedily append the remaining
segment whose nearest endpoint is closest, keep the ordering with the smallest
total connector length. Returns
`{ order, reversed, connectorsMi: [...], coords }` where `coords` is the joined
vertex list (a connector is just the straight step between consecutive ends; a
coincident join, < ~1 m, drops the duplicate vertex). Distances use an
equirectangular approximation in miles.

`App.mergeGeom.findBranch(coordArrays, toleranceMi)` — returns a description if
any line's endpoint lies within tolerance (~50 ft) of the **interior** of another
selected line (a Y/T junction), else `null`. A branching selection can't be one
line → the merge is blocked.

### Attribute rules ("primary wins, fill blanks")

- Primary = the right-clicked feature by default; the dialog lets the user pick
  any selected feature.
- The surviving object is the primary itself (same array position, ID, name,
  color, colorSeq, appearance overrides like `_opacity`, `_lineWidth`, etc.).
- For each key in `properties.attributes` across the selection: keep the
  primary's value if it has one; otherwise take the first non-empty value from
  the others in selection order. "Has a value" = non-empty trimmed string, finite
  number, non-empty array, or a `service` object with at least one band — reuse
  the same semantics as Attribute Summary's `copyFieldHasValue` (move that logic
  into a shared helper if that is cleaner, without changing Copy Attributes'
  behavior).
- `notes`: distinct non-empty notes joined with a newline.
- Lines/routes: `runTime` is summed when **every** selected feature has one
  (end-to-end trip), otherwise primary/fill rule plus a dialog warning
  "Run time may need updating". `avgSpeed` becomes the length-weighted average
  when every feature has one and they differ.
- Every value from a non-primary feature that is non-empty and differs from the
  result is listed in the dialog under "Will be discarded".
- Warnings (non-blocking, amber): different non-empty `serviceId`s; two features
  from the same Service (merging a paired Service's patterns collapses it);
  different non-empty `direction`s; connector longer than 0.25 mi.
- Stops: every point whose `associatedRoutes` references a removed line/route is
  repointed to the survivor (`{featureType, featureId, name}` of the survivor),
  de-duplicated.

### Polygons

Union with `App.foldAnalysisUnion`. A `MultiPolygon` result (shapes don't touch)
**blocks** the merge ("These polygons don't touch or overlap"). Interior rings
(holes) are dropped and the dialog says "Enclosed gaps will be filled."
Recompute the `vertices` count property.

### Lines

`chainLines` → new coordinates; blocked if `findBranch` finds a junction.
Recompute the `waypoints` (vertex count) property.

### Operation

`App.merge.run(type, indices, primaryIndex)`:
one `App.undo.push()` → mutate primary → splice the others (descending index)
→ rebuild buffers / re-render that type → repoint stops → close the attributes
popup if open → the same housekeeping as `App.onFeatureDelete()` (exit edit mode,
clear selection, refresh panel, `notifyProject`, `cache.save`) → select the
survivor → status "Merged 3 lines into 'Line 1' — Ctrl+Z to undo".

### UI

- Features panel right-click: "Merge…" appears when 2+ features are selected
  and all are the same mergeable type (Phase 2: `line`, `polygon`). Never for
  labels/text boxes or mixed types.
- Modal dialog (overlay + centered card, Escape/Cancel closes): title
  "Merge 3 Lines"; "Keep attributes from:" radio list; a result summary (joins /
  gap lengths, holes filled); "Will be discarded" list; warnings (amber);
  blocking errors (red — Merge button disabled); footer note "You can undo this
  with Ctrl+Z until you reload the page." Changing the primary radio recomputes
  the discarded list live.

### Tests

Golden `test/cases/merge.mjs` for `chainLines`, `findBranch`, and the pure
attribute-merge helper (make it pure: inputs are plain property objects).
Smoke test: merge two touching polygons, reject two separate polygons, merge
three lines out of order with one reversed, stop repointing, single undo step
restores everything.

## Phase 3 — Routes, points, line + route

- **Routes**: order with `chainLines` on the snapped geometry. Waypoints are
  concatenated in the same order (reversed where the segment was reversed),
  dropping a duplicate waypoint at coincident joins. Each non-zero connector is
  street-routed with the same router routes.js uses (expose it, e.g.
  `App.fetchRouteGeometry(waypoints)`, honoring the local road network when the
  app would use it); on failure use a straight connector and warn. The merge
  becomes async: the dialog shows "Routing connections…" and the undo snapshot
  is taken only after routing finishes, immediately before mutating. Warn when
  a segment with a directional `direction` (NB/SB/EB/WB/Inbound/Outbound/CW/CCW)
  is reversed.
- **Points ("combine stops")**: result keeps the primary's location; attribute
  rules as above; `associatedRoutes` is the de-duplicated union; conflicting
  `stopId`s are a warning. Afterwards refresh walksheds/buffers
  (`App.ensurePointWalksheds`, `App.refreshBuffers`) and drop cached walksheds
  for removed points if the walkshed module exposes a way (add one if needed).
- **Line + Route**: allowed; the result is always a **Line** (the snapped
  geometry is kept exactly; waypoints/snapping are dropped). If the primary is a
  line it survives in place; if the primary is a route, the first selected line
  is the surviving object but takes the primary's name, color and attributes.
  Stops referencing any removed route or line are repointed to the surviving
  line. The dialog says "The result will be a Line with N vertices; street
  snapping will be removed."

## Phase 4 — Unmerge and stable IDs in modules

### 4a Unmerge

- At merge time store on the survivor
  `properties._mergedFrom = { at, originals: [{type, feature}], repoints: [...] }`
  — deep clones of every original **including the primary's pre-merge state**
  (and any `_mergedFrom` it already had, so unmerging goes back one level), plus
  the list of stop repoints made.
- Right-click a single feature that has `_mergedFrom` → "Unmerge". Confirm
  dialog warns that edits made since merging are lost. One undo step. The
  survivor is replaced by the primary's original at the same position; the
  other originals are appended to their type arrays with their original IDs
  (never reused, thanks to Phase 1). Stop repoints are reversed for stops that
  still point at the survivor.
- Every export path (GeoJSON, CSV, shapefile, KML, etc. in `cache.js`) must omit
  `_mergedFrom` (session JSON export keeps it — it's needed to restore).
- Attribute popup / Attribute Summary must not show it.

### 4b Module references by stable ID

Survey every analysis module's persisted or long-lived feature references that
use array positions and convert them to `{type, id}` refs resolved through a
shared helper (`App.featureRef(type, index)` → `{type, id}`,
`App.resolveFeatureRef(ref)` → current index or `-1`), keeping backward
compatibility for sessions saved with indices. Known cases: Title VI alteration
before/after refs and baseline filter; Corridor Scoring, TPI, Ridership
Forecasting, Transit Coverage, Feature Area Analysis saved selections /
corridor dropdowns; `service-assembly.js` solo Service keys
(`"solo-route-<index>"`) used by Route Costing and Trip Builder persisted state.
Run-time index arrays rebuilt from checkboxes at run time can stay as indices.

## Docs

Each phase updates `CLAUDE.md` (file structure, load order, App API) for what it
adds, and this plan's status line.
