# Network Connectors — Implementation Plan

User-drawn Line features that join the offline walking network, so walksheds and
travelsheds can model planned or hypothetical pedestrian connections (a new
trail, a pedestrian bridge, a mid-block crossing, a path through a campus) that
do not exist in OpenStreetMap.

**Status:** planned, not started.
**Scope owner note:** this plan is written to be executed phase-by-phase by a
smaller model. Each phase is independently shippable and independently
verifiable. Do not merge phases. Do not skip the "Verify" block at the end of
each phase.

---

## 1. Background and the problem being solved

`js/core/road-network.js` downloads OSM roads/paths via Overpass, builds a graph
(`buildGraph`, line ~80), and serves every network consumer in the app:

- Walkshed module (`js/projects/walkshed.js`) → `App.computeWalkshed`
- Transit Travelshed (`js/projects/transit-travelshed.js`) → `App.computeWalkCostMap`
- Every study-area consumer downstream of a walkshed-flagged Point
  (Feature Area Analysis, Census, LODES, TPI, Title VI, FTA, corridor pickers),
  because `points.js rebuildBuffers()` substitutes a cached walkshed for the circle.

Because there is exactly one graph and one `_networkEpoch`, anything injected
into that graph is inherited by all of the above with **no per-module changes**.
That is the central architectural fact this feature relies on.

**The core difficulty.** OSM ways connect only where they share an exact
coordinate. `nodeKey()` (road-network.js:42) quantizes to 6 decimals (~0.1 m). A
Line drawn across a street shares no node with it, so a naively injected
connector is an island: nothing reaches it and it reaches nothing. Making it
connect requires explicitly welding endpoints and splitting segments at
crossings — i.e. local planarization.

**Bridges and underpasses.** The current tool handles these correctly by
construction: OSM models a bridge as a way that shares no node with the road
beneath, so no join exists. Treating "any crossing is a join" would break that
for drawn lines. Mitigation baked into this plan: **never auto-join a connector
to a `pedBlocked` segment** (motorways, trunks, and their ramps — the flag
already exists at road-network.js:104). That covers the catastrophic case
("pedestrians may now cross the freeway here"). Surface-street overpasses remain
a rare, accepted false positive in v1.

**Out of scope (v2).** Subtractive scenarios — closing a crossing, fencing a
cut-through, removing a path. Those need a barrier concept and are not a mirror
image of this work. Do not build toward them here.

---

## 2. Settled design decisions

These were decided in design discussion. Do not re-litigate them mid-implementation.

| Decision | Choice | Why |
|---|---|---|
| Selection mechanism | A **feature attribute** on Lines (`attributes.networkRole`), not a per-module checklist | One graph, one epoch. Per-module selection would let two modules disagree about what the network is while sharing epoch-keyed caches. Also rides the existing session cache with zero new persistence. |
| Which feature types | **Lines only.** Not Routes (they already follow existing streets), not Polygons | Stated requirement. |
| Snap tolerance | **One global value**, surfaced as an input in both Walkshed and Travelshed settings | See "Known conflict" below. |
| Walk-network reference layer | **In v1 scope**, discreet, hideable via the Layers panel | You cannot draw a connector to a sidewalk you cannot see. |
| Join / weld / orphan markers | Discreet, hideable, **part of the same Layers-panel entry** as the walk network | Stated requirement. |
| Units | **Imperial in all new UI.** Internal graph math stays km (it already is) | Stated requirement. Convert at the UI boundary, same as `walkshed.js` already does for mph. |
| Attribute UI | Transit attributes and network attributes must be **visually separated** in the attributes popup | Most line attributes presume a transit route; flexibility needs a visual boundary. |
| Bridges | Never auto-join to a `pedBlocked` segment | See §1. |
| Connector cost | Geometric length only. No delay/penalty model in v1 | Graph weights are km; expressing "45 s of signal delay" as fake distance is workable but deferred. |
| Collinear overlap | Ignored. A connector drawn *along* a street just adds a harmless parallel edge of equal length | `turf.lineIntersect` yields no crossing points for collinear segments; the travel time is identical either way. |

### Known conflict, and its resolution

The original request was for snap tolerance to be *a setting in the Walkshed and
Travelshed inputs*. Taken literally as module-local state that is incorrect:
both modules mutate and read the same `_graph`, keyed by the same
`_networkEpoch`. Two different tolerances would mean each module silently
invalidating and re-welding the other's network, producing stale or wrong
walksheds with no visible cause.

**Resolution implemented by this plan:** a single global
`App.networkSettings.snapToleranceFt`, persisted once in the core session cache,
with an input rendered in *both* modules' Advanced blocks. Both inputs read and
write the same global and re-sync their displayed value on popup open. The user
gets the control where they asked for it; the graph stays single-valued.

**Implementer: do not "fix" this into per-module `_settings` fields.**

---

## 3. Architecture

Three layers, mirroring the existing `travelshed.js` (pure engine) /
`transit-travelshed.js` (App module) split:

```
js/core/connector-graph.js        NEW. window.ConnectorGraph. PURE.
                                  No turf, no DOM, no App, no Map.
                                  Plain JSON in / plain JSON out.
                                  Golden-testable (this is why it exists).

js/core/road-network.js           MODIFIED. Thin adapter. Owns _graph /
                                  _segmentIndex / _segGrid; feeds candidate
                                  segments into ConnectorGraph and applies the
                                  returned edge add/remove instructions.

js/core/network-connectors.js     NEW. App-level module. Collects connector
                                  Lines from App.lines, owns the global
                                  settings, the walk-network reference layer,
                                  the join/weld/orphan markers, and the
                                  connection report.
```

**Why `connector-graph.js` must be turf-free:** `CLAUDE.md` → "Testing —
golden-value checks" requires golden tests for new pure calculation functions,
and the harness (`test/run-golden.mjs`) loads modules directly in Node with no
turf, no DOM and no map. `road-network.js` depends on turf and therefore is not
golden-testable. `travelshed.js` exists for exactly this reason and is the
precedent to copy. Segment-segment intersection and chain splitting are simple
2D math; write them, do not reach for turf.

### Script load order

`index.html`, insert after `travelshed.js` and before `points.js`:

```
connector-graph.js   (core block, no deps — turf/DOM/Map/App-free; defines window.ConnectorGraph)
```

and after `road-network.js`:

```
network-connectors.js  (needs App.map, App.lines, road-network.js exports, App.cache, turf)
```

`CLAUDE.md`'s "Script Load Order" section must be updated to match in the phase
that adds each file.

### Rebuild orchestration (read this before Phase 4)

`fetchRoadNetwork()` and `loadRoadNetworkFromFile()` **replace the network
wholesale**. Connectors therefore must never be merged into `_roadGeoJSON`.
They are a separate overlay re-applied after every base build.

The rebuild sequence is:

1. `buildGraph(_roadGeoJSON)` — pristine base
2. `applyConnectorOverlay()` — weld + split
3. `_networkEpoch++` — **once**, at the end

Today `buildGraph()` increments `_networkEpoch` itself (road-network.js:146).
Phase 0 moves that increment out so the combined rebuild bumps exactly once;
otherwise every network load bumps twice and every epoch-keyed cache
(Walkshed, Travelshed) invalidates an extra time.

**Cheap-no-op signature guard.** `App.refreshNetworkConnectors()` computes a
signature string from the connector geometries + tolerance and returns
immediately if it is unchanged. This makes the function safe to call liberally
(from `App.notifyProject()`, from vertex-drag-end, from attribute changes)
without debouncing or careful wiring. Build this guard in Phase 4 *before*
wiring any call sites.

---

## 4. Phases

Each phase lists: goal, files, work, and a Verify block. Complete the Verify
block before moving on. Commit at the end of each phase.

---

### Phase 0 — Prep: epoch refactor + segment accessor

**Goal:** structural groundwork only. Zero behavior change.

**Files:** `js/core/road-network.js`

**Work:**

1. Remove `_networkEpoch++` from the end of `buildGraph()` (line ~146).
2. Add a private `rebuildNetwork()` that calls `buildGraph(_roadGeoJSON)` then
   (later, in Phase 4) the overlay, then `_networkEpoch++`.
3. Update both current `buildGraph(geojson)` call sites (~line 587 in
   `fetchNetworkForBounds`, ~line 635 in `loadRoadNetworkFromFile`) so the
   epoch still bumps exactly once per load. Simplest form for now:
   `buildGraph(geojson); _roadGeoJSON = geojson; _networkEpoch++;`
   — with a `// see rebuildNetwork()` comment. Confirm `clearRoadNetwork()`
   (~line 663) still bumps the epoch.
4. Add export `App.getWalkNetworkSegments()` → a **plain array** (not a turf
   FeatureCollection) of `{ coords: [[lng,lat],[lng,lat]], kind: "base" }` for
   every `_segmentIndex` entry where `pedBlocked` is false. Returns `[]` when no
   network is loaded. Phase 4 extends `kind` to `"connector"`.
   Cache the result keyed on `_networkEpoch` — it is called on every layer
   refresh and a city network has tens of thousands of segments.

**Verify:**
- Load a road network via Add Data → confirm a Walkshed still computes.
- In the console, `App.roadNetworkEpoch()` increments by exactly 1 per
  network load and per clear.
- `App.getWalkNetworkSegments().length` is > 0 after a load, `0` after a clear,
  and calling it twice in a row returns the identical array reference.

---

### Phase 1 — Walk network reference layer

**Goal:** a discreet, hideable map layer showing the walkable network. Ships
standalone value and is a prerequisite for drawing connectors accurately. No
connector logic yet.

**Files:** `js/core/network-connectors.js` (new), `js/core/layers-panel.js`,
`css/style.css`, `index.html`, `CLAUDE.md`

**Work:**

1. Create `js/core/network-connectors.js` as an IIFE (`var App = window.App;`).
2. `renderWalkNetworkLayer()`:
   - Builds a GeoJSON FeatureCollection from `App.getWalkNetworkSegments()`,
     each feature carrying `properties.kind`.
   - Source `walk-network`, layer `walk-network-line`. Create-once /
     `setData`-after, the same pattern `App.choropleth.render` and
     `census.js renderCensusOverlay` use.
   - Insert **below** drawn features. Use the same `beforeLayer` approach as the
     GTFS layers so user features stay on top.
   - Styling — discreet, following the GTFS shapes precedent
     (`#718096`): `line-color` `#94a3b8`, `line-width` 1, `line-opacity` 0.45.
     Do not add raw hex for app chrome; these are map data symbols, which
     `CLAUDE.md` → "Design tokens and colors" explicitly exempts.
   - Dark mode: bump opacity slightly rather than changing hue.
3. `App.refreshWalkNetworkLayer()` — public; rebuilds from current network
   state; removes the source/layer when no network is loaded.
4. Call it from `updateUI()` in `road-network.js` (~line 708) via a
   `typeof App.refreshWalkNetworkLayer === "function"` guard.
   `updateUI()` is the documented single choke point for download / import /
   clear, so this one call site covers every path that changes the network.
5. Default visibility: **visible** when a network loads (stated requirement:
   shown whenever the user adds street network data, whether via a module's
   download prompt or the Add Data dropdown). Hideable from the Layers panel.
6. Register in `layers-panel.js` `REFERENCE` (line ~44), after the
   `road-dl-area-line` entry:
   ```js
   { id: "walk-network-line", label: "Walk network",
     layers: [{ id: "walk-network-line", op: "line-opacity" }],
     clear: callIf("clearRoadNetwork") },
   ```
   (Phase 6 adds the join-marker layer to this same entry's `layers` array —
   one entry, per the stated requirement.)
7. Add `<script src="js/core/network-connectors.js"></script>` to `index.html`
   after `road-network.js`.
8. Update `CLAUDE.md`: File Structure entry, Script Load Order, the
   `layers-panel.js` REFERENCE description, and the App Namespace section.

**Verify:**
- Download a road network; the walk network appears as thin gray lines beneath
  drawn features and is visible but unobtrusive.
- It appears in the Layers panel under Reference/Imported with a working
  show/hide toggle and opacity slider.
- Clearing the network removes the layer with no console errors.
- Motorways/trunks are **absent** from the layer (they are `pedBlocked`).
- Run `node test/ui-screens/capture.mjs` and inspect the images
  (`CLAUDE.md` → "Visual verification") — the Layers panel gained a row.

---

### Phase 2 — `networkRole` attribute + transit/network visual split

**Goal:** the user can mark a Line as a walk connector. No graph effect yet.

**Files:** `js/core/feature-attributes.js`, `js/projects/attribute-summary.js`,
`css/style.css`, `js/core/features.js`, `CLAUDE.md`

Per `CLAUDE.md` → "Common Issues to Prevent", **both** render surfaces and the
CSS grid template must change in this same commit.

**Work:**

1. **Section support in the attributes popup.** `ATTR_FIELDS` entries gain an
   optional `section: "<label>"` string. The field renderer emits a small
   `.fp-attr-section` header row before the first field carrying a new section
   value. Fields with no `section` render exactly as today — this must be fully
   backward compatible, since `point`, `polygon`, `label` and `textbox` field
   sets are untouched.
2. **Split the line field set.** `ROUTE_FIELDS` (feature-attributes.js:30) is
   currently shared verbatim by `route` and `line`. Change to:
   - `route: ROUTE_FIELDS` (unchanged behavior)
   - `line: LINE_FIELDS` where
     `LINE_FIELDS = ROUTE_FIELDS.map(tag with section "Transit service")` plus
     one new field in section `"Walk network"`:
     ```js
     { key: "networkRole", label: "Walk network", type: "select",
       section: "Walk network",
       options: ["", "connector"],
       optionLabels: { "": "Not part of network", "connector": "Walk connector" },
       onChange: onNetworkRoleChange }
     ```
   - Keep `ROUTE_FIELDS` as the shared source so the two stay in step; only
     lines get the extra field and the section headers.
   - `onNetworkRoleChange` is a stub in this phase (`App.refreshNetworkConnectors`
     called behind a `typeof` guard). Phase 4 makes it do work.
3. **Attribute Summary.** Add a "Net" column to `renderLineLike`. Because Lines
   and Routes share `renderLineLike` and the `.as-grid-routelike` CSS template,
   **add the column to both** — render the select for lines and a muted `—` for
   routes. Do not fork the grid template. Update `.as-grid-routelike` in
   `css/style.css` to match the new column count, header and data rows together.
   Add `networkRole` to `COPY_FIELD_DEFS` for the line/route pool as
   `kind: "select"`.
4. **Feature-panel differentiator.** In `js/core/features.js`, render a small
   muted chip (e.g. `walk`) on the row of any Line whose
   `attributes.networkRole === "connector"`, so connectors are distinguishable
   from transit lines at a glance. Keep it to one small `.fp-net-chip` span; do
   not restructure the row.
5. Update `CLAUDE.md`: the `feature-attributes.js` and `attribute-summary.js`
   File Structure entries, and the Copy Attributes field list.

**Verify:**
- Open a Line's attributes popup: fields are visibly grouped under "Transit
  service" and "Walk network" headers.
- Open a Route's attributes popup: unchanged from before (no section headers,
  no Walk network field).
- Point / Polygon / Label / Text Box popups: unchanged.
- Attribute Summary shows the new column for both Lines and Routes, columns stay
  aligned, and routes show `—`.
- Set a Line to "Walk connector", reload the page → the setting survives
  (it rides the existing session cache; no new persistence was added).
- Copy Attributes can copy `networkRole` between lines.
- Re-run `node test/ui-screens/capture.mjs` and inspect.

---

### Phase 3 — `connector-graph.js` pure engine + golden tests

**Goal:** all the planarization math, pure and tested. **No integration.**
Nothing in the app calls this yet.

**Files:** `js/core/connector-graph.js` (new),
`test/cases/connector-graph.mjs` (new), `test/golden/connector-graph.json`
(generated), `index.html`, `CLAUDE.md`

**Work:**

Define `window.ConnectorGraph` with these pure functions. No turf. No DOM. No
`App`. Plain arrays and objects in and out. Coordinates are `[lng, lat]`.

1. `segmentIntersection(a, b, c, d)` → `{ point: [lng,lat], tAB, tCD } | null`
   Standard 2D segment-segment intersection in **local km space** (project both
   segments equirectangularly around `a`, using the same `kmPerDegLng =
   111.32 * cos(lat)` / `kmPerDegLat = 110.574` constants
   `nearestOnSegmentKm` uses at road-network.js:210). Returns `null` for
   parallel/collinear segments and for intersections outside `[0,1]` on either
   parameter. Use a small epsilon; document it.
2. `pointToSegmentKm(p, a, b)` → `{ distKm, point, t }`
   Same math as `nearestOnSegmentKm`, restated here so the engine is
   self-contained.
3. `splitChain(coords, splits)` → array of coordinate pairs
   Given a polyline and a list of `{ segIndex, t, point }` split records, returns
   the resulting ordered list of 2-point edges, with splits sorted along the
   chain and zero-length edges dropped.
4. `planarizeConnectors(connectors, candidates, opts)` — the top-level entry.
   - `connectors`: `[{ id, coords: [[lng,lat], ...] }]`
   - `candidates`: `[{ segId, coords: [a, b], pedBlocked }]` — the base segments
     near the connectors, supplied by the caller (road-network.js does the
     spatial query; this engine does no indexing).
   - `opts`: `{ snapToleranceKm, weldVertices: bool, splitCrossings: bool }`
   - Returns:
     ```js
     {
       addEdges:    [{ coords: [a,b], kind: "connector"|"split", srcId }],
       removeSegIds: [segId, ...],     // base segments replaced by split chains
       joins:       [{ point, kind: "crossing"|"weld", connectorId, segId }],
       orphans:     [{ connectorId, point, nearestKm }]
     }
     ```
   - **Rules:**
     - Skip any candidate with `pedBlocked === true` for both welding and
       crossing splits (the bridge/freeway mitigation from §1).
     - Connectors are planarized **against each other** as well as against the
       base — process connectors in order, adding each one's resulting edges to
       the candidate pool for subsequent connectors.
     - An intersection or weld point that coincides with an existing coordinate
       (within the nodeKey quantum, 1e-6 degrees) reuses that coordinate instead
       of creating a split — never emit a zero-length edge.
     - `weldVertices: true` welds every connector vertex (not just endpoints)
       that lies within `snapToleranceKm` of a candidate; an endpoint with no
       weld and no crossing is reported in `orphans`.
     - `splitCrossings: false` skips `segmentIntersection` entirely — this is
       what lets Phase 4 ship welding alone.

**Golden tests** (`CLAUDE.md` → "Testing — golden-value checks"):

Create `test/cases/connector-graph.mjs` following the existing case files
(`test/cases/travelshed.mjs` is the closest model). Cover at minimum:

- a connector crossing one street at mid-block → 1 crossing join, base segment
  replaced by 2 edges
- a connector crossing the same street twice → 2 joins, 3 edges from the base
- a connector whose endpoint sits 10 m from a street, tolerance 50 ft → welded
- the same endpoint with tolerance 20 ft → orphan, not welded
- a connector crossing a `pedBlocked` segment → **no** join
- two connectors crossing each other → connector-connector join
- a connector endpoint landing exactly on an existing node → reused, no split,
  no zero-length edge
- collinear overlap → no crossing joins emitted
- empty connectors, empty candidates → empty result, no throw

Seed with `node test/run-golden.mjs --update`, review the recorded numbers, and
commit `test/golden/connector-graph.json` **in the same commit**.

Add `<script src="js/core/connector-graph.js"></script>` to `index.html` after
`travelshed.js`. Update `CLAUDE.md` File Structure, Script Load Order, and the
"Covered engines" list under Testing.

**Verify:**
- `node test/run-golden.mjs` ends with `PASS — N/N cases passed across M module(s)`
  and `M` has increased by one.
- The app still loads with no console errors (the new script is inert).
- Commit message includes the required `Verified: node test/run-golden.mjs → N/N` line.

---

### Phase 4 — Integration: welding, settings, rebuild orchestration

**Goal:** connectors actually change walksheds. **Welding only** —
`splitCrossings: false`. This is the first user-visible behavior change and the
riskiest phase; keeping crossings out makes it debuggable.

**Files:** `js/core/road-network.js`, `js/core/network-connectors.js`,
`projects/walkshed-popup.html`, `projects/transit-travelshed-popup.html`,
`js/projects/walkshed.js`, `js/projects/transit-travelshed.js`,
`js/core/cache.js`, `js/app.js`, `CLAUDE.md`

**Work:**

1. **Global settings.** `App.networkSettings = { snapToleranceFt: 50 }`.
   Persist as an additive field in the core session-cache state (the same
   pattern `featureSortMode` uses — default gracefully when absent; no schema
   version bump). Valid range 5–300 ft.
2. **`road-network.js` adapter.** Add:
   - private `_connectors = []` (plain `[{ id, coords }]`) and
     `_connectorOpts = { snapToleranceKm: ... }`
   - `App.setNetworkConnectors(connectors, opts)` — stores them and triggers a
     full `rebuildNetwork()`. Returns the overlay report (see below).
     road-network.js must **not** read `App.lines` or any attribute; it receives
     plain geometry. That layering is deliberate.
   - private `applyConnectorOverlay()`:
     a. Gather candidate base segments near the connectors using `_segGrid` —
        for each connector segment, the 3×3 cell neighborhood around every cell
        the segment touches (reuse the `gxMin..gxMax` / `gyMin..gyMax` loop
        from `buildSegGrid`, expanded by 1), deduped.
     b. Call `ConnectorGraph.planarizeConnectors(...)`.
     c. Apply `removeSegIds`: delete those entries from `_segmentIndex` and
        remove the corresponding edges from `_graph` in both directions.
     d. Apply `addEdges`: push into `_segmentIndex` with
        `pedBlocked: false, carBlocked: true` (connectors are walk-only and must
        never affect `findLocalRoute`), and add the bidirectional graph edges
        with `weight` = geodesic km.
     e. Rebuild `_segGrid` from the final `_segmentIndex`. (Rebuilding wholesale
        is simpler and correct; the cost is one pass over the segment array,
        which already happens on every network load.)
     f. Stash the report for the caller.
   - Wire `rebuildNetwork()` = `buildGraph(_roadGeoJSON)` →
     `applyConnectorOverlay()` → `_networkEpoch++`, and route every existing
     base-load path through it.
   - If `_roadGeoJSON` is null, `applyConnectorOverlay()` is a no-op. Connectors
     require a base network; document this in the report as
     `{ reason: "no-base-network" }`.
   - Extend `App.getWalkNetworkSegments()` to tag overlay segments
     `kind: "connector"`.
3. **`network-connectors.js` orchestration.**
   - `collectConnectorLines()` — scans `App.lines` for
     `properties.attributes.networkRole === "connector"`, skipping
     `properties.hidden` features. Returns `[{ id: "line:" + idx, coords }]`.
   - `App.refreshNetworkConnectors()`:
     - Computes a **signature** from the collected geometries + tolerance
       (`JSON.stringify` is fine — a handful of lines). Returns the cached
       report unchanged if the signature matches. **Build this guard first**;
       everything else depends on it being safe to call liberally.
     - Otherwise calls `App.setNetworkConnectors(...)`, stores the report,
       refreshes the walk-network layer, and returns the report.
   - `App.getConnectorReport()` → the last report.
4. **Call sites** (all behind `typeof` guards):
   - `App.notifyProject()` in `js/app.js` — covers feature add/delete and cache
     restore.
   - Line vertex edit commit in `js/core/editing.js` — on drag **end**, not
     per-frame.
   - `onNetworkRoleChange` in `feature-attributes.js` (the Phase 2 stub).
   - The snap-tolerance inputs (below).
   - `updateUI()` in `road-network.js` already fires on load/import/clear; the
     rebuild path covers it, but confirm connectors survive a fresh download.
5. **Snap tolerance inputs.** Add to the existing `<details>` Advanced block in
   **both** `projects/walkshed-popup.html` (`#wsSnapTol`, next to `#wsMaxEdge`)
   and `projects/transit-travelshed-popup.html` (`#tsSnapTol`):
   ```html
   <div class="form-field u-mt-2">
     <label class="tiny">Connector snap tolerance (ft)</label>
     <input type="number" id="wsSnapTol" class="rf-number-input" min="5" max="300" step="5" value="50">
   </div>
   <p class="tiny u-mt-1 u-muted">
     How close a drawn walk connector's end must be to an existing street to join it.
     Shared with the Transit Travelshed module.
   </p>
   ```
   Both inputs read/write `App.networkSettings.snapToleranceFt` and re-sync their
   displayed value in the module's `onOpen()`. **Neither module stores the value
   in its own `_settings` object** — see §2 "Known conflict". On change: update
   the global, save the cache, call `App.refreshNetworkConnectors()`, and mark
   the module's results stale.
   Convert at the boundary: `snapToleranceKm = ft * 0.0003048`.
6. Update `CLAUDE.md`: `road-network.js` entry (new exports and the overlay
   behavior), `network-connectors.js` entry, the Walkshed and Transit Travelshed
   module entries (new Advanced input), and the App Namespace section.

**Verify:**
- Draw a Line from a cul-de-sac to a nearby street, set it to Walk connector.
  A walkshed from a point in the cul-de-sac visibly expands across the new path.
- Set the Line back to "Not part of network" → the walkshed returns to its
  previous shape.
- A Transit Travelshed run picks up the same connector with no Travelshed code
  change beyond the shared tolerance input.
- The connector does **not** appear in a driving route
  (`App.findLocalRoute`) — verify `carBlocked` is honored.
- Download a fresh road network for a new area → the connector is re-applied
  automatically (the overlay survives a wholesale base replacement).
- `App.roadNetworkEpoch()` bumps exactly once per connector change and once per
  network load.
- Dragging a connector vertex rebuilds once on release, not per frame.
- `node test/run-golden.mjs` still passes.

---

### Phase 5 — Crossing splits

**Goal:** flip `splitCrossings: true`, so a connector crossing a street
mid-block joins it there.

**Files:** `js/core/road-network.js` (or `network-connectors.js`, wherever
`opts` is assembled), `CLAUDE.md`

**Work:**

1. Pass `splitCrossings: true`.
2. Confirm the `pedBlocked` skip is honored on this path (it is the bridge
   mitigation and the whole reason it exists).
3. Watch for the multiple-splits-per-base-segment case — a connector zigzagging
   across one long street segment. `splitChain` already sorts splits along the
   chain; confirm against the Phase 3 golden case.
4. Update the `CLAUDE.md` `road-network.js` entry to describe crossing joins and
   the freeway exclusion.

**Verify:**
- A connector drawn straight across a residential street joins it at the
  crossing, and a walkshed flows through in both directions.
- A connector drawn across a motorway does **not** join it (the walkshed does
  not leap the freeway).
- A connector crossing two streets creates two joins.
- Two connectors crossing each other join.
- `node test/run-golden.mjs` still passes.

---

### Phase 6 — Join markers and connection report

**Goal:** make connection state legible. Dangling connectors that silently do
nothing are the primary user-facing failure mode of this whole feature.

**Files:** `js/core/network-connectors.js`, `js/core/layers-panel.js`,
`js/projects/walkshed.js`, `js/projects/transit-travelshed.js`,
`css/style.css`, `CLAUDE.md`

**Work:**

1. **Marker layer.** Source `network-joins`, layer `network-joins-point`, built
   from the report's `joins` and `orphans`, each feature carrying
   `properties.kind` = `"crossing" | "weld" | "orphan"`.
   Styling, discreet per the stated requirement:
   - `crossing` / `weld`: small filled circle, radius 3, muted
   - `orphan`: slightly larger hollow circle in a warning color, so an
     unconnected end is findable at a glance
   Use a data-driven `circle-color` / `circle-radius` expression on `kind` —
   one layer, not three.
2. **Layers panel.** Add this layer to the **existing** `walk-network-line`
   REFERENCE entry's `layers` array (per the stated requirement that joins
   belong to the same general network layer), not as a separate row:
   ```js
   layers: [{ id: "walk-network-line", op: "line-opacity" },
            { id: "network-joins-point", op: "circle-opacity" }]
   ```
3. **Connection report line.** In both the Walkshed and Transit Travelshed
   results footers, render one line from `App.getConnectorReport()`:
   > `3 walk connectors · 6 joins · 1 end not connected`
   Only render it when at least one connector exists. When orphans > 0, style
   the line with the existing warning treatment used elsewhere in those footers
   and name the offending Line: `"Path to school" — nearest street is 82 ft away`
   (report `nearestKm` converted to feet).
4. Update `CLAUDE.md`: the `network-connectors.js` entry, the `layers-panel.js`
   REFERENCE description, and both module entries.

**Verify:**
- Joins render as small dots at real crossings and welds.
- A connector drawn ending in a field shows an orphan marker and the results
  footer names it with a distance in feet.
- Raising the snap tolerance past that distance converts the orphan to a weld,
  live, and the walkshed changes accordingly.
- Both marker and line layers toggle together from one Layers panel row.
- Re-run `node test/ui-screens/capture.mjs` and inspect.

---

### Phase 7 — *(optional)* Imperialize existing hull-detail inputs

**Goal:** consistency with the "all units imperial" rule. **Separable — drop
this phase without affecting anything above.**

`#wsMaxEdge` and `#tsMaxEdge` are currently labeled in km. Convert the inputs to
feet, converting to km at the call boundary the same way `walkSpeedMph` already
does. Both modules persist `maxEdge`; keep storing **km** in the cache payload
so no schema version bump is needed (Walkshed is at settings schema v2, Transit
Travelshed at v2) and only the displayed unit changes.

**Verify:** existing saved sessions restore with the same effective hull detail;
`node test/run-golden.mjs` still passes; screenshots re-captured.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Double epoch bump invalidating caches twice per load | Phase 0 moves the increment; Verify block checks it explicitly |
| Connectors lost on network re-download | Overlay is separate from `_roadGeoJSON` and re-applied by `rebuildNetwork()`; Phase 4 Verify checks it |
| False join across a freeway | `pedBlocked` candidates excluded from both welding and crossing splits; golden-tested in Phase 3 |
| Zero-length / degenerate edges corrupting the graph | Coincidence check at the `nodeKey` quantum plus zero-length drop in `splitChain`; golden-tested |
| Per-frame rebuild while dragging a vertex | Signature guard plus drag-**end**-only wiring |
| Snap tolerance drifting into per-module state | Called out in §2 with an explicit "do not fix this" instruction |
| Attribute change breaking the Attribute Summary grid | `CLAUDE.md`'s two-surface rule is restated inline in Phase 2, column added to both grids |
| Connector affecting drive routing | `carBlocked: true` on every overlay segment; Phase 4 Verify checks `findLocalRoute` |

## 6. Definition of done

- A Line marked "Walk connector" measurably changes a Walkshed and a Transit
  Travelshed, and survives save/load and a fresh network download.
- The walk network and its joins are visible, discreet and hideable from one
  Layers panel row.
- Unconnected connector ends are reported in feet, by name, in both modules.
- `node test/run-golden.mjs` passes with the new `connector-graph` module covered.
- `node test/ui-screens/capture.mjs` re-run and images inspected.
- `CLAUDE.md` updated for every surface touched.
