# Transit Travelshed Engine — Implementation Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/transit-travelshed.md. This file is historical.

Superseded in part by `transit-travelshed-v2-walk-caps-plan.md` for the
walk-cap model and polygonization.

Sequenced build plan for the **Transit Travelshed** feature (`features.md`
"Transit Travelshed Engine"). From a user-clicked origin, compute everywhere
reachable within a total time budget by **walk → wait → ride drawn transit
routes/lines → walk**, with ≤1 transfer, rendered as 1–3 banded isochrones.
It extends the proven walkshed engine (`js/core/road-network.js` flood
Dijkstra + concave-hull polygonization) and is the prerequisite for
Cumulative-Opportunity Accessibility, the Transit/Auto Opportunity Ratio, and
the Title VI job-access matrix (all in `features.md`).

Written for phase-by-phase execution: every phase is small, ordered,
independently committable, and leaves the app working. All design decisions
are settled (agreed with the user 2026-08-12) except the short "Risks" list at
the end — **do not re-litigate them**.

---

## Design summary (settled — do not re-open)

- **Origin = a clicked map point** (probe pattern), NOT an `App.points`
  feature — avoids overloading the Points feature class. An in-popup "Pick
  origin" button arms a one-shot map click via a new
  `App.drawMode === "ts-origin"` value; the origin renders as a temporary
  `maplibregl.Marker` (measure.js precedent), torn down on clear.
- **Wait model = capped half-headway.** Initial wait
  `= min(headway/2, Wmax)`, `Wmax` user-adjustable, **default 10 min**
  (calibration range 8–12 — see Appendix A). **Transfer wait = uncapped
  headway/2** (transfer arrivals are effectively random — riders can't time
  them). A **boarding penalty** knob (default **1 min**) is added at every
  boarding. All three are disclosed in results + methodology.
- **Boarding stops:** Points whose `attributes.associatedRoutes` reference a
  route/line are its **real** stops; a feature with zero real stops gets
  **synthetic** stops sampled along its geometry at the module's "assumed
  stop spacing" setting (**default 0.25 mi**), endpoints always included.
  Results disclose per feature which kind was used.
  (`defaultStopSpacing` in `RidershipModel.SERVICE_TYPES` is dead metadata —
  ignore it.)
- **Banded isochrones:** 1–3 budgets (defaults 15 / 30 / blank). Per-node
  arrival times are computed **once at the max budget**; bands are pure
  thresholds over that one result — never re-flooded per band (3 bands ≈ the
  cost of 1).
- **Network acquisition = prompt-to-download:** on Calculate, compute the
  required extent (origin + selected feature geometries, buffered by max walk
  distance at the budget); if no network is loaded or the recorded download
  extent doesn't cover it, offer a one-click scoped Overpass download. Manual
  file load stays the fallback; file-imported networks (unknown extent)
  degrade to a soft warning.
- **Street-crossing penalties: out of scope v1.** The graph is undirected
  street centerlines — crossing is implicit and free; real crossing friction
  is the deferred arterial-crossing item under "Walkshed sidewalk & access
  refinement" in `features.md`.
- **Transfer cap = 1** (the engine loop generalizes for v2).
- **Time-of-day:** module settings "Analysis day" (Weekday/Sat/Sun) +
  "Analysis time" (HH:MM, default 08:00) select each feature's active band
  via `App.getEffectiveServiceBands`; no active band, or a band with blank/0
  frequency ⇒ the feature is unavailable for the run ("no service at HH:MM"
  in results). The headway is frozen at the analysis-time band for both
  initial and transfer boardings (disclosed).
- **Direction semantics:** `Both` rides both ways along the drawn geometry;
  `Loop`/`CW`/`CCW` ride one-way in drawn coordinate order (wrap-around when
  the geometry is closed); other directions (NB/SB/…) propagate one-way in
  drawn order. Each selected feature is its own pattern — no Service pairing
  in v1.

## Verified reference points (line numbers checked 2026-08-12)

- `js/core/road-network.js` (779 lines): `nodeKey` :42 (`"lng,lat"` @6
  decimals, round-trippable via `keyToCoord` :46), `snapToNetwork(lngLat,
  mode)` :158 (O(all segments) scan — must be cached per stop),
  `fetchRoadNetwork()` :375 (map-view bbox ×1.5, `MAX_AREA_WARN_KM2`=2000
  confirm, streamed Overpass POST, yields every 500 elements, sets
  `_downloadedBboxPolygon`, dashed fuchsia outline via `updateUI()`),
  `floodDijkstra(startKey, budgetKm)` :616 **already returns
  `Map<nodeKey, distKm>`** — `computeWalkshed` :676 discards it,
  `buildWalkshedPolygon` :649 (concave-hull auto-relax ×1.8, ≤8 attempts →
  convex → tiny buffer), `injectSnapNode`/`cleanupTempNodes` :689/:708 (temp
  graph mutation, `finally` cleanup — **not async-safe**; keep
  inject→flood→cleanup atomic). Graph weights = **km**; undirected;
  everything internal is IIFE-private (exports :768–777).
- `js/projects/walkshed.js` (606 lines) — the module template: cache
  `settingsKey = coords|minutes|speed|maxEdge|networkEpoch`; mph→km
  conversion happens in the module; add-once-then-`setData` rendering;
  `#wsNetWarn` disable pattern :523-529; settings-only persistence.
- `js/core/service-assembly.js:171` `getEffectiveServiceBands(service, day)`
  takes the raw `attrs.service` object per feature (may be absent — tolerate
  null; transit-coverage.js:260 is the calling model); band =
  `{from:"HH:MM", to:"HH:MM", frequency: minutes|null}`; blank/0 frequency =
  no service. Midnight-wrap convention: trip-builder.js:164 `parseHHMMtoMin`
  + `if (toMin <= fromMin) toMin += 1440` — reuse, don't invent a third.
- Route/line attrs: `runTime` (min, one-way) wins over `avgSpeed` (mph,
  default 14, may be undefined) — trip-builder priority. Lines'
  `properties.waypoints` is a NUMBER, never touch it. Length via
  `turf.length(feature, {units:"miles"})`.
- `attributes.associatedRoutes` = `[{featureType, featureId, name}]` where
  **featureId is the 1-based draw-time counter `properties.routeIdx` /
  `properties.lineIdx`, NOT the array index** (never renumbered on delete) —
  resolve by scanning (editing.js `findRouteIndexByProp` pattern), drop
  orphans. This engine is the first analytical consumer of
  `associatedRoutes`.
- Probe precedent: `js/core/textboxes.js:340-396` — module-owned map handler
  gated on its own `App.drawMode` value; editing/selection handlers already
  early-return on any truthy `drawMode`, so no extra suppression is needed.
  Popup reopen call: **`App.openModulePopup(id)` (js/app.js:513)** —
  verified.
- Banded rendering precedent: corridor-scoring.js:438-486 (the repo's only
  `step`/classed color expression); layers-panel ANALYSIS manifest
  `{id, label, moduleId, layers:[{id, op}]}` at js/core/layers-panel.js:49-56.
- Golden harness: vm sandbox — **no DOM / no turf / no fetch**,
  `window === sandbox`, `__MAT_TEST__` set. New engine ⇒
  `test/cases/<module>.mjs` + seeded golden + a
  `Verified: node test/run-golden.mjs → N/N` line in the commit message
  (CLAUDE.md testing policy).

## Architecture at a glance

```
road-network.js  (Phase 1-2)      travelshed.js  (Phase 3, PURE)      transit-travelshed.js (Phases 4-8)
├─ computeWalkCostMap(lngLat,km)  ├─ parseHHMMtoMin / selectActiveBand ├─ origin picker (drawMode "ts-origin")
│    → {distMap, snap,            ├─ initialWait / transferWait        ├─ stop resolution (real vs sampled; turf)
│       accessNodes} | null       ├─ rideMinAtDistance                 ├─ snap + flood caches (chunked async)
├─ polygonizeNodeSet(coords, km)  ├─ sampleStopPositions               ├─ adapter: Maps → plain objects
├─ nodeKeyToCoord(key)            ├─ propagateRide                     ├─ calls Travelshed.computeArrivalTimes
├─ snapWalk(lngLat)               ├─ computeArrivalTimes  ◀ THE CORE   ├─ banding → polygonizeNodeSet → rings
├─ getRoadDownloadExtent()        └─ bandNodeSets                      ├─ prompt-to-download extent check
└─ fetchRoadNetworkForExtent(pg)     (window.Travelshed, JSON-only     └─ popup UI, legend, export, persistence
   (window.App)                       in/out — golden-testable)
```

**Pure/impure split rule:** `js/core/travelshed.js` (`window.Travelshed`,
engine-namespace convention like `window.TPI`) contains ONLY plain-JSON math —
no turf, no DOM, no Maps, no App state — so the golden harness loads it
directly. Everything needing turf or the road graph lives in road-network.js
or the module. The module converts road-network `Map`s to plain
`{nodeKey: distKm}` objects once per flood and caches them in that form.

---

## Phase 1 — road-network.js: expose per-node cost maps + primitives

**Files:** `js/core/road-network.js` only.

The highest-leverage change: `floodDijkstra` (:616) already produces
`Map<nodeKey, distKm>`; `computeWalkshed` (:676) discards it. Extract
`computeWalkshed`'s inject→flood→cleanup core into a private
`runWalkFlood(lngLat, budgetKm)` → `{distMap, snap, computeMs} | null`, then
rebuild `computeWalkshed` on top of it (**zero behavior change** for the
Walkshed module). New exports (append near :768):

```js
// {distMap: Map<nodeKey,distKm>, snap, accessNodes: [{nodeKey, extraKm} ×2], computeMs} | null
App.computeWalkCostMap = function (lngLat, budgetKm) { ... };
App.polygonizeNodeSet  = function (coords, maxEdgeKm) { return buildWalkshedPolygon(coords, maxEdgeKm); };
App.nodeKeyToCoord     = keyToCoord;
App.snapWalk           = function (lngLat) { return snapToNetwork(lngLat, "walk"); };
App.getRoadDownloadExtent = function () { return _downloadedBboxPolygon; }; // Feature<Polygon>|null
```

**`accessNodes` (key design detail):** inside `computeWalkCostMap`, after
snapping, compute the straight-line km from the snap coord to each bracketing
segment endpoint (`turf.distance(snap.coord, keyToCoord(snap.segStartKey),
{units:"kilometers"})`, ditto segEnd). These two `{nodeKey, extraKm}` pairs
let the PURE engine compute "time to reach this stop from any other cost map"
as `min(map[k1]+e1, map[k2]+e2) × walkMinPerKm` — no turf, no O(nodes) map
intersections per stop pair.

**Concurrency comment for the executor:** `computeWalkCostMap` is synchronous
and atomic (inject/flood/cleanup all inside one call, cleanup in `finally`).
Callers may `await`-yield BETWEEN calls, never during — the temp-node graph
mutation is not async-safe.

**Verify:** the existing Walkshed module produces identical
polygon/area/node-count results after the refactor; console
`App.computeWalkCostMap([lng,lat], 1.2)` returns a populated Map;
`node test/run-golden.mjs` still passes.

**Commit:** `refactor: expose walk cost-map primitives on road-network engine`

---

## Phase 2 — road-network.js: scoped download

**Files:** `js/core/road-network.js` only.

Extract the body of `fetchRoadNetwork()` (:375) into
`async function fetchNetworkForBounds(bounds, extentPolygon)` — the shared
streamed Overpass fetch, `MAX_AREA_WARN_KM2` confirm, buildGraph + epoch bump
+ `updateUI()`; returns `Promise<boolean>` (true = loaded).
`fetchRoadNetwork()` keeps its exact current behavior (map-view bbox ×1.5).
New export:

```js
App.fetchRoadNetworkForExtent = async function (extentPolygon) {
  var bb = turf.bbox(extentPolygon);            // [w, s, e, n]
  return fetchNetworkForBounds({ s: bb[1], w: bb[0], n: bb[3], e: bb[2] }, turf.bboxPolygon(bb));
};
```

Code comment: this **replaces** the loaded network wholesale (same as
`fetchRoadNetwork` today) and bumps `_networkEpoch`, so all module caches
(walkshed, travelshed) invalidate automatically.

**Verify:** console
`App.fetchRoadNetworkForExtent(turf.bboxPolygon([w,s,e,n]))` for a small box
downloads, draws the dashed fuchsia outline, and `App.getRoadDownloadExtent()`
returns that rectangle. The Add Data download button is unchanged.

**Commit:** `feat: road-network — caller-supplied extent download (fetchRoadNetworkForExtent)`

---

## Phase 3 — Pure engine `js/core/travelshed.js` + golden tests

**Files:** create `js/core/travelshed.js` and `test/cases/travelshed.mjs`;
edit `index.html` (script tag after `road-network.js`); seed
`test/golden/travelshed.json` with `--update`.

IIFE defining `window.Travelshed`. The header comment must state the
constraint (no turf/DOM/Maps — plain JSON in/out) and why (the golden harness
has no turf; results must be serializable). Functions (all exported on
`Travelshed`, all golden-tested):

- `parseHHMMtoMin(s)` — same semantics as trip-builder.js:164 (re-implemented
  because a core engine must not depend on a projects/ module; comment
  cross-references trip-builder). `"7:30"` → 450; null on bad input.
- `selectActiveBand(bands, analysisMin)` → `{fromMin, toMin, headwayMin} |
  null` — wrap-aware (`toMin <= fromMin → +1440`; a band matches at `t` or
  `t + 1440`); skips bands with `!(frequency > 0)`.
- `initialWait(headwayMin, maxWaitMin, boardingPenaltyMin)` =
  `min(H/2, Wmax) + penalty`.
- `transferWait(headwayMin, boardingPenaltyMin)` = `H/2 + penalty`
  (uncapped — see Appendix A).
- `rideMinAtDistance(distMi, lengthMi, runTimeMin, avgSpeedMph)` —
  `runTimeMin > 0` wins (distributed proportionally over length), else
  `distMi / avgSpeedMph × 60`. The avgSpeed default (14) is applied by the
  CALLER (module) — the engine trusts its inputs.
- `sampleStopPositions(lengthMi, spacingMi)` → `[0, spacing, 2×spacing, …,
  lengthMi]`; endpoints always included; final gap may be < spacing;
  degenerate `lengthMi <= spacing` yields `[0, lengthMi]`.
- `propagateRide(stops, boardIdx, boardTimeMin, opts)` — `stops` =
  `[{rideMin}]` in drawn order; `opts = {mode: "both"|"forward", loop:
  null|{cycleMin}}`. `"both"` → `arrive[i] = boardTime + |rideMin[i] −
  rideMin[boardIdx]|`; `"forward"` → downstream only; loop set → forward
  with `(Δride + cycleMin) % cycleMin` wrap. Returns `[{stopIdx, arriveMin}]`
  excluding the boarding stop.
- `bandNodeSets(nodeTimes, budgetsMin)` → `[{budgetMin, nodeKeys:[…]}]` —
  each band's set is CUMULATIVE (all nodes with time ≤ budget); ring
  differencing happens in the module.

### The core: `Travelshed.computeArrivalTimes(input)`

```js
input = {
  budgetMin: 45,                 // max of the user's bands — THE single flood budget
  walkSpeedKmh: 4.99,
  maxInitialWaitMin: 10,
  boardingPenaltyMin: 1,
  transferCap: 1,
  originCost: { nodeKey: distKm, ... },        // origin flood (plain object)
  routes: [{
    routeId: "route-3",          // "<type>-<idx>" module-assigned, opaque here
    mode: "both" | "forward",    // from direction attr (Both → "both", else "forward")
    loop: null | { cycleMin },   // closed Loop/CW/CCW geometries only
    headwayMin: 12,              // from selectActiveBand; caller excludes unavailable routes
    stops: [{                    // DRAWN order, ascending distAlong
      stopKey: "<lng>,<lat>",    // cache key, opaque
      rideMin: 4.2,              // rideMinAtDistance from pattern start
      access: [{ nodeKey, extraKm }, { nodeKey, extraKm }]   // snap endpoints
    }]
  }],
  stopCosts: { stopKey: { nodeKey: distKm, ... } }   // per-stop full-budget floods
}

returns = {
  nodeTimes: { nodeKey: minutes },   // best arrival per node, all <= budgetMin
  routeDiags: [{ routeId, boardings, firstBoardMin, usedTransfer }],
  stats: { stopsConsidered, stopsBoarded, transferBoardings, nodesReached }
}
```

Algorithm (all plain-object loops, deterministic iteration order for golden
pinning):

1. `walkMinPerKm = 60 / walkSpeedKmh`. Seed `nodeTimes` from `originCost`
   (`distKm × walkMinPerKm`, keep only `<= budgetMin`).
2. Helper `stopArrivalFrom(costObj, stop, baseMin)` =
   `baseMin + min over stop.access of (costObj[nodeKey] + extraKm) × walkMinPerKm`
   (Infinity when neither access node is in the map).
3. **Round 0 (initial boardings):** for every route/stop, arrival from
   `originCost` at base 0. If `arrive + initialWait(headway, Wmax, penalty)
   < budgetMin`, board; `propagateRide` from that stop; for each alighting
   `{stopIdx, arriveMin}` under budget, record an *alighting event*
   `{routeId, stopKey, alightMin}` keeping only the best `alightMin` per
   stopKey.
4. **Egress merge (the hot loop):** for each alighting event, sweep
   `stopCosts[stopKey]`: `cand = alightMin + distKm × walkMinPerKm`; improve
   `nodeTimes[k]` when `cand` is smaller and ≤ budget. (The boarding stop's
   own egress flood is deliberately NOT merged — standing at a boarding stop
   is already covered by the flood that reached it.)
5. **Round 1 (single transfer):** for each route B and stop b, best arrival
   via any round-0 alighting event `e`:
   `stopArrivalFrom(stopCosts[e.stopKey], b, e.alightMin)`, skipping
   `B.routeId === e.routeId` (no same-route re-board). Board with
   `transferWait(headway, penalty)`, propagate, egress-merge exactly as round
   0. Structure the rounds as `for (r = 0; r <= transferCap; r++)` so a v2
   cap bump is trivial (v1 passes 1).
6. Return.

### `test/cases/travelshed.mjs` sketch (~15 cases)

```js
export default {
  scripts: ["js/core/travelshed.js"],   // no deps — loads clean in the vm sandbox
  cases: [
    { id: "parse-hhmm-basic",       call: "Travelshed.parseHHMMtoMin", args: ["07:30"] },
    { id: "band-midday",            call: "Travelshed.selectActiveBand",
      args: [[{from:"06:00",to:"09:00",frequency:15},{from:"09:00",to:"15:00",frequency:30}], 600] },
    { id: "band-midnight-wrap",     call: "Travelshed.selectActiveBand",
      args: [[{from:"22:00",to:"01:00",frequency:60}], 30] },          // 00:30 matches via +1440
    { id: "band-skip-no-freq",      call: "Travelshed.selectActiveBand",
      args: [[{from:"06:00",to:"09:00",frequency:null}], 420] },       // → null
    { id: "wait-initial-capped",    call: "Travelshed.initialWait",  args: [30, 10, 1] },  // 11
    { id: "wait-initial-short",     call: "Travelshed.initialWait",  args: [12, 10, 1] },  // 7
    { id: "wait-transfer-uncapped", call: "Travelshed.transferWait", args: [30, 1] },      // 16
    { id: "ride-runtime-priority",  call: "Travelshed.rideMinAtDistance", args: [2, 4, 20, 14] },
    { id: "ride-avgspeed",          call: "Travelshed.rideMinAtDistance", args: [2, 4, 0, 14] },
    { id: "sample-stops",           call: "Travelshed.sampleStopPositions", args: [1.1, 0.25] },
    { id: "propagate-both",         call: "Travelshed.propagateRide",
      args: [[{rideMin:0},{rideMin:5},{rideMin:12}], 1, 10, {mode:"both", loop:null}] },
    { id: "propagate-loop-wrap",    call: "Travelshed.propagateRide",
      args: [[{rideMin:0},{rideMin:5},{rideMin:12}], 1, 10, {mode:"forward", loop:{cycleMin:15}}] },
    { id: "band-node-sets",         call: "Travelshed.bandNodeSets",
      args: [{a:5, b:14, c:29, d:44}, [15, 30, 45]] },
    { id: "arrival-times-tiny",     call: "Travelshed.computeArrivalTimes",
      args: [{ /* 4-node toy network, 1 route, 2 stops — hand-checkable */ }] },
    { id: "arrival-times-transfer", call: "Travelshed.computeArrivalTimes",
      args: [{ /* 2 crossing routes; a node reachable only via 1 transfer */ }] }
  ]
};
```

**Hand-compute the two `computeArrivalTimes` toys before seeding** so the
golden file is verified, not just recorded.

**Verify:** `node test/run-golden.mjs --update` seeds; re-run → PASS.

**Commit:** `feat: Travelshed pure engine (wait model, band selection, ride propagation) + golden cases`
with a `Verified: node test/run-golden.mjs → N/N` line.

---

## Phase 4 — Module skeleton + popup + CSS

**Files:** create `js/projects/transit-travelshed.js`,
`projects/transit-travelshed-popup.html`,
`projects/transit-travelshed-legend.html`; edit `index.html` (script tag
after `walkshed.js`), `css/style.css` (`.ts-` block, typography variables
only — never hardcoded px).

2-column popup (Settings | Results), all ids `ts`-prefixed, structure copied
from `walkshed-popup.html`:

**Settings column:**
- Origin block: `#tsPickOriginBtn` ("Pick origin on map"), `#tsOriginLabel`
  ("Not set" / coords), `#tsClearOriginBtn` (×, hidden until set).
- Budgets row: `#tsBudget1` (15), `#tsBudget2` (30), `#tsBudget3` (blank) —
  minutes, blank = band unused; label "Time budgets (min)".
- `#tsWalkSpeed` (mph, default 3.1 — same as walkshed).
- `#tsDayType` select + `#tsTimeOfDay` (`<input type="time">`, 08:00) —
  "Analysis day & time".
- Wait model: `#tsMaxWait` (min, default 10), `#tsBoardPenalty` (min, default
  1), with an `rf-info-btn` ⓘ explaining capped initial vs uncapped transfer
  wait.
- `#tsStopSpacing` (mi, default 0.25) — "Assumed stop spacing (routes without
  stop points)".
- Routes+lines checklist `#tsRouteList` + Select all / Clear links (copy
  `#tcFeatureList` markup from transit-coverage-popup.html); annotate
  features with no bands ("no schedule").
- `<details>` Advanced: `#tsMaxEdge` (km, default 0.3 — hull parameter, copy
  walkshed's wording).
- Network block: `#tsNetWarn` (walkshed :523-529 pattern), `#tsCoverageWarn`
  (hidden), `#tsDownloadBtn` (hidden until Phase 7).
- `#tsRunBtn` ("Calculate travelshed").

**Results column:** `#tsStatus` (`.rf-status` — shared cross-module class, do
NOT fork), `#tsResultsTable` (per band: budget, area mi²/km², nodes reached),
`#tsRouteDetail` (collapsible per-route disclosure: band used
("06:00–09:00 @ 12 min"), wait applied ("min(H/2, 10) + 1 = X min"), stops
**real (n)** / **sampled (n @ 0.25 mi)**, direction handling, or exclusion
reason), `#tsExportBtn` (GeoJSON), `#tsEmptyState` (`.rf-info-box`).

**Legend fragment:** 3 rows reusing `.tpi-legend-*` classes; the module fills
labels ("≤ 15 min" etc.) and hides unused rows after mount.

Register `{id: "transit-travelshed", name: "Transit Travelshed",
enabled: true, popupWidth: 900, popupHTML, init, onOpen, onClose, clear,
update}`. `setStatus`/`showStale`/`emptyHint` delegate to
`App.renderModuleState` (`emptyHint`: need "Draw a route or line with service
bands", action "Pick an origin and click Calculate"). Walkshed-style
`refreshNetWarn()` disable for now (Phase 7 relaxes it). `#tsRunBtn` is a
stub until Phase 6.

**Verify:** module appears in the Analysis dropdown; popup renders all
controls; checklist lists routes/lines; no console errors; golden run passes.

**Commit:** `feat: Transit Travelshed module skeleton (popup, checklist, settings)`

---

## Phase 5 — Origin picker (probe pattern)

**Files:** `js/projects/transit-travelshed.js` only.

1. `#tsPickOriginBtn` click → `App.popup.close()`;
   `App.drawMode = "ts-origin"`; crosshair cursor
   (`App.map.getCanvas().style.cursor`); `App.setStatus("Click the map to set
   the travelshed origin (Esc to cancel)")`.
2. A map `click` handler registered ONCE in `init()`: early-return unless
   `App.drawMode === "ts-origin"`; set `_origin = [lng, lat]`; drop/update
   `_originMarker = new maplibregl.Marker({color: "#7c3aed"})` (measure.js
   precedent — single marker, `.remove()` on clear); disarm
   (`App.drawMode = null`, cursor reset); reopen via
   **`App.openModulePopup("transit-travelshed")`** (js/app.js:513); update
   `#tsOriginLabel`; show `#tsClearOriginBtn`; mark results stale.
3. `keydown` Escape while armed → disarm without setting, reopen popup
   (register in `init()`; early-return unless armed).
4. `#tsClearOriginBtn` → remove marker, `_origin = null`, stale.

Editing/selection handlers already early-return on truthy `App.drawMode` —
no other file needs changes.

**Verify:** arm → popup closes, crosshair; click map → violet marker, popup
reopens with coords; Esc cancels cleanly; drawing tools unaffected.

**Commit:** `feat: Transit Travelshed — one-shot origin picker with map marker`

---

## Phase 6 — Compute pipeline + rendering (the core phase)

**Files:** `js/projects/transit-travelshed.js`, `js/core/layers-panel.js`
(ANALYSIS entry).

### 6a. Stop resolution (turf-dependent, module-local)

`resolveRoutes(selected, dayType, analysisMin, spacingMi)` → per feature
`{routeId: "<type>-<idx>", feature, name, lengthMi, mode, loop, headwayMin,
bandLabel, stopSource: "real"|"sampled", stops: [{stopKey, coord,
distAlongMi, rideMin}], excluded: null|"no-service"}`:

- Bands via `App.getEffectiveServiceBands((f.properties.attributes||{}).service,
  dayType)` (tolerate absent `attrs.service`) →
  `Travelshed.selectActiveBand(bands, analysisMin)`; null ⇒
  `excluded: "no-service"` (still listed in `#tsRouteDetail`).
- Real stops: scan `App.points` × `attrs.associatedRoutes || []`, matching
  `featureType` + `featureId` against `properties.routeIdx`/`lineIdx` by
  SCANNING (NOT array index); orphan refs dropped.
  `distAlongMi = turf.nearestPointOnLine(feature, pt,
  {units:"miles"}).properties.location`; sort ascending. A real stop
  projecting far off the geometry is kept (user-associated) but counted in
  diagnostics.
- Sampled stops (zero real): `Travelshed.sampleStopPositions(lengthMi,
  spacingMi)` → `turf.along(feature, d, {units:"miles"})`.
- `rideMin` per stop: `Travelshed.rideMinAtDistance(distAlongMi, lengthMi,
  attrs.runTime > 0 ? attrs.runTime : 0, attrs.avgSpeed || 14)`.
- `mode`: direction `"Both"` (or missing) → `"both"`; everything else →
  `"forward"` in drawn order. `loop`: direction ∈ Loop/CW/CCW AND first/last
  geometry coords within ~15 m (`turf.distance`) →
  `{cycleMin: full-length rideMin}`, else null (an open loop rides linear —
  disclosed).
- `stopKey = coord.join(",")` (raw precision — only a cache key).

### 6b. Snap + flood caches (chunked async)

`_floodCache: Map<`stopKey|epoch|budgetKm.toFixed(3)`, {cost: plainObj,
access: [{nodeKey, extraKm}×2]} | null>`. Per uncached stop:
`App.computeWalkCostMap(stop.coord, budgetKm)`; convert the `distMap` Map →
plain object ONCE and store with `accessNodes`. Null (snap > 0.5 km) cached
as null → stop skipped, counted in diagnostics.

- **Yield after EVERY stop flood** (`await new Promise(r => setTimeout(r, 0))`)
  with `setStatus("Walking from stop i/n…", "running")`
  (transit-propensity onProgress pattern). `_running` re-entrancy guard;
  disable `#tsRunBtn` while running.
- **Flood budget decision (justify in a code comment):** floods run at the
  FULL max budget `budgetKm = walkSpeedKmh × (maxBudgetMin / 60)` — an upper
  bound on any remaining budget, so one flood serves every boarding time,
  every band, and every re-run with unchanged budget/speed; the engine
  thresholds. Never re-flood per remaining budget.

### 6c. `runTravelshed()` orchestration

1. Validate: `_origin`, ≥1 finite budget (sort ascending, dedupe), ≥1 route
   checked, network loaded. `walkSpeedKmh = mph × 1.609344`.
2. (Phase 7 inserts the coverage check here.)
3. `resolveRoutes(...)`; drop excluded from compute (keep for disclosure).
4. Origin flood: `App.computeWalkCostMap(_origin, budgetKm)`; null ⇒
   `setStatus("Origin is more than 0.5 km from a loaded street", "error")`.
5. `ensureFloods` over the union of all stops.
6. Assemble the pure input (plain objects; attach each stop's cached
   `access`); call `Travelshed.computeArrivalTimes(input)` (sync — plain-
   object merge loops, sub-second).
7. `Travelshed.bandNodeSets(nodeTimes, budgets)` → per band:
   `App.polygonizeNodeSet(nodeKeys.map(App.nodeKeyToCoord), maxEdgeKm)`;
   yield between bands.
8. Ring differencing largest-first: `ring_i = turf.difference(poly_i,
   poly_{i-1})` (innermost band stays solid); tag `properties.band = i`,
   `properties.budgetMin`. On `difference` failure, fall back to the
   un-differenced polygon for that band — never discard the run.
9. Render + results + legend + `_lastResult` + `_stale = false`.

### 6d. Rendering

Add-once-then-`setData` (walkshed pattern), source `ts-travelshed`:
- `ts-travelshed-fill`: one fill layer, single FeatureCollection,
  `"fill-color": ["match", ["get", "band"], 0, "#1d4ed8", 1, "#3b82f6", 2,
  "#93c5fd", "#93c5fd"]` (3-class Blues, innermost darkest; `match` on the
  integer band — corridor-scoring classed-color precedent),
  `fill-opacity: 0.35`.
- `ts-travelshed-line`: thin outline, same source, matching colors.
- Insert beneath drawn-feature layers (copy walkshed's beforeId choice).
- Legend: `App.popup.showFloatingWidget("ts-legend",
  "projects/transit-travelshed-legend.html", {position: "bottom-left",
  width: 200, title: "Transit Travelshed"})` — then fill labels, hide unused
  rows (widget options only apply at creation — known behavior).
- `js/core/layers-panel.js` ANALYSIS array: append
  `{id: "ts-travelshed-fill", label: "Transit Travelshed",
  moduleId: "transit-travelshed", layers: [{id: "ts-travelshed-fill",
  op: "fill-opacity"}, {id: "ts-travelshed-line", op: "line-opacity"}]}`.

### 6e. Results + export + staleness

- `#tsResultsTable`: per band — budget, `turf.area(ring)` → mi²/km², node
  count; footer: compute ms, floods cached vs fresh.
- `#tsRouteDetail`: the disclosure fields from 6a per selected feature.
- Export GeoJSON: FeatureCollection of band rings + an origin Point,
  methodology properties on each feature (waitModel, budgets, day/time,
  spacing, network epoch).
- Staleness: `update(core)` → if `_lastResult` then `showStale()` (uniform
  Re-run banner via `App.renderModuleState`, `onRerun: runTravelshed`); all
  settings inputs share a `change` → stale handler. Epoch is embedded in the
  cache keys, so a network re-download recomputes naturally.

**Verify:** 1 route with bands + avgSpeed, network loaded, origin near the
route, budgets 15/30 → two nested rings render, inner darker;
`#tsRouteDetail` shows "sampled (n @ 0.25 mi)"; adding an associated stop
Point flips it to "real (1)"; a band-less route is listed excluded; UI stays
responsive during floods (status pill counts up).

**Commit:** `feat: Transit Travelshed — layered-flood compute pipeline and banded rendering`

---

## Phase 7 — Prompt-to-download extent

**Files:** `js/projects/transit-travelshed.js` only.

```js
// Rectangle covering everything the analysis could touch.
function computeRequiredExtent(originLngLat, selectedFeatures, maxBudgetMin, walkSpeedMph) {
  var maxWalkKm = walkSpeedMph * 1.609344 * (maxBudgetMin / 60);   // upper bound: all-walk
  var pieces = [ turf.circle(originLngLat, maxWalkKm, { units: "kilometers", steps: 16 }) ];
  selectedFeatures.forEach(function (f) {
    var b = null; try { b = turf.buffer(f.feature, maxWalkKm, { units: "kilometers" }); } catch (e) {}
    if (b) pieces.push(b);
  });
  var union = App.foldAnalysisUnion(pieces);          // module-buffers.js helper
  return union ? turf.bboxPolygon(turf.bbox(union)) : null;   // Feature<Polygon>
}
```

(Egress buffer = full-budget walk distance: any egress walk is bounded by the
total budget at walk speed. Coarse but safe; say so in the comment.)

Calculate flow (inserted as step 2 of `runTravelshed`):
- **No network:** `#tsCoverageWarn` "No street network loaded." + show
  `#tsDownloadBtn`; abort run.
- **Network but `App.getRoadDownloadExtent() === null`** (file import —
  extent unknown): soft warning ("Imported network — can't verify it covers
  this analysis; results near the edge may be clipped."), do NOT block.
- **Extent known:** `turf.booleanContains(extent, required)` — rectangle vs
  rectangle only (never pass a raw union). False ⇒ "Loaded streets don't
  cover this analysis area." + download offer; abort. True ⇒ proceed.
- `#tsDownloadBtn` → `await App.fetchRoadNetworkForExtent(required)` (its own
  MAX_AREA confirm + streamed progress apply); on success →
  `runTravelshed()` automatically (caches self-invalidate via epoch).
- From this phase on, `refreshNetWarn()` no longer hard-disables `#tsRunBtn`
  when no network is loaded — Calculate routes into the download offer;
  `#tsNetWarn` becomes informational ("No street network loaded — Calculate
  will offer a scoped download. Or load one via Add Data.").

**Verify:** fresh session, no network: Calculate → download offer sized to
origin+routes (dashed fuchsia rectangle appears after download), auto-runs.
Distant origin → coverage warning + re-download offer. File-imported
network → soft warning only, run proceeds.

**Commit:** `feat: Transit Travelshed — scoped prompt-to-download street acquisition`

---

## Phase 8 — Session persistence + polish

**Files:** `js/projects/transit-travelshed.js` only.

`App.cache.registerModule("transit-travelshed", {collect, apply})`,
settings-only schema v1 (walkshed precedent — polygons recompute cheaply and
the network isn't persisted anyway):

```js
{ v: 1,
  origin: [lng, lat] | null,
  budgets: [15, 30, null], walkSpeedMph: 3.1,
  dayType: "weekday", timeOfDay: "08:00",
  maxWaitMin: 10, boardPenaltyMin: 1, stopSpacingMi: 0.25, maxEdgeKm: 0.3,
  selectedRouteIds: ["route-3", "line-1"] }   // draw-time routeIdx/lineIdx-based ids
```

`apply(data)`: restore inputs; re-place `_originMarker` when `origin` set;
re-check surviving checklist entries (resolve by routeIdx/lineIdx scan —
indices shift, draw counters don't); results stay empty until Re-run
(transit-coverage precedent: geometry not persisted, export disabled until
regenerated). Polish in the same phase: `clearResults()` completeness audit
(layers before sources, legend widget, marker, disarm if armed, pending
extent), Escape-while-armed edge cases, `emptyHint` copy, disable
`#tsExportBtn` until a run exists.

**Verify:** run an analysis, reload → settings + origin marker restored,
stale/empty state prompts Re-run; export disabled until then.

**Commit:** `feat: Transit Travelshed — session persistence (settings + origin, schema v1)`

---

## Phase 9 — Documentation

**Files:** `CLAUDE.md`, `features.md`.

- CLAUDE.md File Structure: entries for `js/core/travelshed.js`,
  `js/projects/transit-travelshed.js`, both HTML fragments (existing
  one-paragraph style: what it does, key ids, persistence shape).
- CLAUDE.md road-network.js API paragraph: add `computeWalkCostMap`,
  `polygonizeNodeSet`, `nodeKeyToCoord`, `snapWalk`, `getRoadDownloadExtent`,
  `fetchRoadNetworkForExtent` with return shapes and the atomicity note.
- CLAUDE.md Script Load Order: `travelshed.js` (core block, no deps) +
  `transit-travelshed.js` (deps: Travelshed, road-network exports,
  `App.getEffectiveServiceBands`, `App.foldAnalysisUnion`, turf, maplibregl).
- CLAUDE.md Active modules sentence + testing "Covered engines" list
  (+ Travelshed).
- `features.md` Transit Travelshed entry: mark implemented; record the
  settled decisions — explicitly answering the DEVELOPER NOTE about
  headway/2 with the capped/uncapped split and its empirical basis
  (Appendix A); note the disclosure behaviors; carry the v2 list below.

**Commit:** `docs: Transit Travelshed — CLAUDE.md + features.md updates`

---

## Performance budget notes

- **One flood per stop per (epoch, budget, speed), ever** — re-runs with only
  wait/time/band changes reuse every flood; only the (sub-second) engine pass
  recomputes.
- **Chunked async everywhere expensive:** yield after every stop flood and
  between band polygonizations; status-pill progress each yield.
- **Snap results ride inside the flood cache** — kills the O(all-segments)
  turf scan per repeated stop across re-runs.
- **Single-flood-threshold banding:** `computeArrivalTimes` runs once at max
  budget; `bandNodeSets` is O(nodes × bands) object reads.
- **Plain objects, not Maps, in the engine** — serializable for golden tests
  and fast in the hot egress-merge loop. Ballpark worst case: ~30 stops ×
  full-budget floods dominates (seconds, chunked); egress merge ~600k object
  ops (sub-second, sync is fine).

## Non-goals / v2

- Street-crossing / sidewalk access penalties (undirected graph stands).
- Transfer cap > 1 (engine loop already generalizes; UI knob is v2).
- Batch/cumulative-opportunity accessibility (many origins) — this engine's
  cache design is its prerequisite; the mode itself is the separate
  features.md entry.
- Schedule-based (timetable) waits; band re-selection at simulated clock time
  for later boardings (v1 freezes the analysis-time band).
- Riding past the drawn end of an OPEN (non-closed) loop; Service-paired
  pattern awareness (each feature propagates independently in v1).
- Opportunity counts inside bands (population/jobs — natural follow-on via
  census.js/lodes.js); departure-time profiles; per-point walk-speed
  overrides.

## Risks (flagged for the implementing session)

1. **Concave hulls on multi-lobed transit node clouds** (origin blob +
   bead-string along routes) may auto-relax into one blobby hull. If Phase 6
   eyeballing shows this, fall back to polygonizing per connected lobe
   (cluster nodes by flood source) and unioning — a contained change inside
   `runTravelshed` step 7.
2. **Loop `cycleMin` when `runTime` is entered:** `runTime` is documented
   one-way; for a closed loop, one-way IS the cycle. Accepted; disclosed in
   `#tsRouteDetail`.

## End-to-end verification

- `node test/run-golden.mjs` green after Phases 1, 3, and at the end (new
  travelshed cases included).
- Manual browser pass per phase's Verify block (open `index.html`; the
  walkshed regression check after Phase 1 is mandatory).
- Commit messages on engine phases carry
  `Verified: node test/run-golden.mjs → N/N` per CLAUDE.md policy.

---

## Appendix A — Empirical basis for the wait model

Classic half-headway (`W = H/2`) assumes riders arrive at stops randomly. The
empirical literature shows that holds only for frequent service; at longer
headways riders time their arrival to the schedule, so observed physical wait
flattens instead of growing linearly:

- **Ingvardson et al. (2018)**, Greater Copenhagen smart-card data, 5–60 min
  scheduled headways: observed average waits of ~2.3 / 4.3 / 7.1 / 7.9 /
  9.8 min at 5 / 10 / 20 / 30 / 60-min headways — i.e. wait as a share of
  headway falls from ~46% to ~16%, with the estimated share of
  randomly-arriving passengers falling from ~57% to ~7%.
- **Lam & Morrall (Calgary)**: below ~10-min headways wait ≈ H/2; above,
  H/2 increasingly overstates waiting, trending toward ~11 min at long
  headways. Explicitly rejected random arrivals for long headways.
- **Salek & Machemehl / Fan & Machemehl (Austin)**: direct observation,
  ~8–60-min headways; wait below H/2, with a structural break at ~11-min
  headway (transition from random toward coordinated arrivals; essentially
  all coordinated by ~38 min).
- **TfL** institutionalizes the same split operationally: ≤12-min headways
  are treated as non-timetabled (random arrivals, wait-time metrics);
  ≥15-min headways as timetabled (schedule-adherence metrics).
- **Chen et al. (2025)** model schedule readers vs neglecters on
  low-frequency suburban bus service and find H/2 materially distorts
  waiting-time results there.

**Model adopted:** `W_initial = min(H/2, Wmax)` with `Wmax` default 10 min
(defensible calibration range 8–12). **Transfers keep uncapped `H/2`**: a
transferring rider's arrival time is dictated by the feeder vehicle, so
schedule-timing does not apply (absent coordinated timed transfers, which the
model does not assume).

**Disclosed limitation ("hidden waiting"):** capping the physical wait does
not capture the schedule-delay/flexibility cost of infrequent service (an
hourly route forces departure-time adjustment even when the stop wait is
short). A travelshed maps *physical reachability*, so the capped physical
wait is the right quantity here — but any future generalized-cost or demand
use of these travel times should add a separate schedule-delay penalty rather
than uncapping H/2. State this in the module's methodology/info text.
