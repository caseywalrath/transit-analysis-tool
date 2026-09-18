# Sidewalk Data for Walkshed Analysis — Implementation Plan

Status: **planned, not started.**

## How to use this doc

Phases are grouped into four stages (A–D) separated by **CHECKPOINTS**. A
checkpoint is a hard stop: the implementer finishes the phase, commits, and
reports to the user. The user then decides whether the next stage is worth
building — **every stage after A is genuinely optional**, and Stage D in
particular should only be built if the data in the user's actual study areas
turns out to support it.

Each phase lists goal, files, work, and a **Verify** block. Complete the Verify
block before moving on. Commit at the end of each phase. Work on branch
`claude/wonderful-mayer-yjh6iq`.

Per `CLAUDE.md` → "Testing — golden-value checks": any phase touching a pure
calculation function runs `node test/run-golden.mjs` and records
`Verified: node test/run-golden.mjs → N/N` in the commit message. Any phase
touching markup or the Layers panel runs `node test/ui-screens/capture.mjs` and
**inspects the images**, not just the pass count.

---

## 1. Background — read this before touching anything

Three facts reframe what this feature actually is. Getting them wrong will
produce a plan that builds the wrong thing.

### 1.1 Sidewalk geometry is already in the network

`fetchNetworkForBounds` (`js/core/road-network.js:667-673`) already pulls
`footway|path|steps|cycleway|pedestrian` from Overpass. `buildGraph` tags them
`pedBlocked: false` (`:151`), and `floodDijkstra` (`:921`) already walks them.

**So this is not a "fetch new data" feature.** Separate sidewalk geometry is
already being flooded over today — it is simply not *distinguished* from road
centerlines anywhere in the code or the UI. Stage A adds no new Overpass
elements at all.

Further: Overpass `out geom;` already returns **all** tags on each way. The
parse loop at `:734-743` just doesn't read them — it keeps only `highway`,
`name`, `oneway`, `foot`. Reading three more tags is a parse-side change with
**zero** effect on download size or query time.

### 1.2 `sidewalk=*` and Network Connectors solve different problems

OSM tags sidewalks two ways, and the difference drives this whole plan:

| Tagging | Where it lives | Routable? | Use |
|---|---|---|---|
| `highway=footway` + `footway=sidewalk` | separate parallel way | **yes** — already in the graph | real sidewalk routing |
| `sidewalk=both\|left\|right\|no` | attribute on the road centerline | **no** — it's metadata | coverage signal / ground truth |

Network Connectors add walk-only **edges** — they fix *topology*. But a road
centerline carrying `sidewalk=no` is **already traversable** in the graph. So
`sidewalk=no` creates nothing to draw; a connector laid over it would be a
no-op duplicate edge.

**Therefore: `sidewalk=*` alone is a quality map, not a drawing worklist.**
A phase that renders it and calls it a connector worklist is wrong.

### 1.3 The actual connector worklist comes from two different tests

1. **Topology gaps** (Stage B) — disconnected components and near-miss dead ends
   in the walk graph. Finds unmapped cut-throughs, plazas, parking-lot
   crossings, footpaths ending one node short of a street. Needs **no new data
   at all** and works in today's centerline mode. This is the highest-yield
   test for connector drawing and is why Stage B exists.
2. **Claimed-but-unmapped sidewalks** (Stage C) — `sidewalk=both|left|right` on
   a centerline with **no parallel footway geometry nearby**. Means "a sidewalk
   exists in reality but OSM has no line for it." Only matters if sidewalk-only
   routing (Stage D) is on the table.

---

## 2. Settled design decisions

- **Stage A ships standalone value and changes no numbers.** No routing change,
  no walkshed output change. It is a data-capture + visualization + statistics
  stage only. This is deliberate: it answers "is the full analysis worthwhile"
  *before* any expensive or risky work is committed to.
- **Coverage is its own layer, not a restyle of `walk-network-line`.** They have
  different semantics (walkable segments the flood uses vs. the sidewalk
  attribute on road centerlines) and different subsets. The user must be able to
  toggle them independently.
- **One new file, split-in-two convention.** `js/core/walk-audit.js` carries a
  pure `window.WalkAudit` block (no turf/DOM/Map/App — golden-testable, loads in
  the harness sandbox) followed by an App-level orchestration block that reads
  `App.*` only at call time. This is exactly the `walk-cost.js` /
  `layer-palettes.js` convention documented in `CLAUDE.md`.
- **Stage A does not touch graph edges.** New tags go on `_segmentIndex`
  entries only, never on `addGraphEdge`'s edge objects. Edges are allocated
  twice per segment and a city network has hundreds of thousands of them —
  adding fields nothing reads is pure memory cost in the hot routing path.
  Stage D adds them to edges, when something finally reads them.
- **Legacy imports degrade gracefully.** A road-network file exported before
  this feature has no sidewalk tags. Absent → `"unknown"`, never an error.
  Same convention as the existing "Imported networks may lack a highway/foot
  tag" handling at `:147-150`.
- **`App.networkSettings` is the home for any new shared setting** (Stage D's
  walk mode), matching `snapToleranceFt` / `crossingMajorSec` / `crossingMinorSec`.
  Never per-module state — see `docs/network-connectors-plan.md` §2.
- **Mode is a setting, not a network change.** Stage D folds into Walkshed's
  `settingsKeyFor()` cache key (`js/projects/walkshed.js:113-120`), **not** an
  epoch bump — the precedent set by the crossing-penalty seconds.

---

## 3. Architecture notes

### Script load order

`walk-audit.js` has no load-time dependencies (pure block is App-free; App block
reads `App.*` only at call time). Load it **after** `road-network.js` (it
consumes `App.getWalkNetworkSegments`) and **before** `walkshed.js` /
`transit-travelshed.js`. Slot it directly after `network-connectors.js`.

### Where the single traversal predicate lives

`floodDijkstra` (`js/core/road-network.js:905`) is the **only** flood used by
both `computeWalkshed` and `computeWalkCostMap`, via `runWalkFlood` (`:980`).
Its `if (nb.pedBlocked) continue;` at `:921` is the single edge predicate.

This matters for Stage D: a mode filter added there is picked up by **both**
Walkshed and Transit Travelshed automatically. That is strictly better than how
crossing penalties landed, where `computeWalkCostMap` deliberately opted out and
Transit Travelshed is still out of sync on that feature.

### Pure-engine data shapes

`WalkAudit` follows the `ConnectorGraph` rule — plain values in and out, no live
`Map`, no turf, so `test/run-golden.mjs` can load it directly. Where a function
needs the graph, it takes a plain adjacency object `{nodeKey: [neighborKey, …]}`
and `road-network.js` supplies it. Where it needs spatial candidates, the caller
queries `_segGrid` and passes a candidate array — exactly the contract
`planarizeConnectors(connectors, candidates, opts)` already uses.

The adjacency conversion is one O(nodes) pass. That is fine because these are
**on-demand audit** functions, never called from the flood path.

---

# STAGE A — Sidewalk visibility and coverage statistics

Ships standalone value. Changes no analysis numbers. Low risk.

---

### Phase 1 — Capture sidewalk tags

**Goal:** the three tags reach `_segmentIndex`. No visual change whatsoever.

**Files:** `js/core/road-network.js`, `CLAUDE.md`

**Work:**

1. In the Overpass parse loop (`:734-743`), read three more tags into
   `properties`: `sidewalk`, `footway`, `crossing`. **Do not change the
   `way["highway"~...]` query filter** — `out geom;` already returns all tags,
   so this is parse-side only and adds nothing to the download.
2. In `buildGraph` (`:147-151`), alongside the existing `hwy` /
   `pedBlocked` / `carBlocked` classification, read
   `props.sidewalk` / `props.footway` into locals, defaulting to `""`.
3. Add `sidewalk` and `footway` to the `segments.push({…})` object
   (`:172-181`). **Do not** add them to the `addGraphEdge(…)` call — see §2.
4. Extend `getWalkNetworkSegments()` (`:1169`) to carry `sidewalk`, `footway`
   and `hwy` on each returned record alongside the existing `coords` / `kind`.
   Additive — existing consumers ignore the new fields. The `_walkSegCache`
   epoch keying is unchanged.
5. Update `CLAUDE.md`: the `road-network.js` File Structure entry and its App
   Namespace entry, noting the three captured tags, that segments (not edges)
   carry them, and that legacy imports leave them `""`.

**Verify:**
- `node --check js/core/road-network.js`.
- Download a network in a city with known sidewalk tagging. In the console:
  `App.getWalkNetworkSegments().filter(s => s.sidewalk).length` is > 0, and
  `…filter(s => s.footway === "sidewalk").length` is > 0.
- `App.getWalkNetworkSegments().length` is unchanged from before this phase
  for the same download extent.
- Import a road-network file exported **before** this change → no console
  errors, walkshed still computes, new fields read `""`.
- `node test/run-golden.mjs` → unchanged pass count (no pure math touched).

---

### Phase 2 — Sidewalk coverage layer

**Goal:** a toggleable map layer showing sidewalk coverage by centerline
attribute, plus separate footway geometry in a distinct style.

**Files:** `js/core/walk-audit.js` (new), `js/core/layers-panel.js`,
`index.html`, `CLAUDE.md`

**Work:**

1. Create `js/core/walk-audit.js` as an IIFE. **Pure block first**
   (`window.WalkAudit`), then the App block, with a comment marking the split —
   follow `js/core/walk-cost.js`'s file shape exactly.

2. Pure: `WalkAudit.classifySidewalk(seg)` → one of
   `"both"` | `"one-side"` | `"none"` | `"footway"` | `"unknown"`.
   - `seg.footway === "sidewalk"` (or `hwy` is a pedestrian class) → `"footway"`
     — this is separate geometry, the attribute doesn't apply.
   - `sidewalk` tag `both` / `yes` → `"both"`; `left` / `right` → `"one-side"`;
     `no` / `none` / `separate` → `"none"`; anything else or absent →
     `"unknown"`.
   - Takes a plain object, returns a string. No App/turf/DOM.

3. App: `App.refreshSidewalkCoverageLayer()` — builds a FeatureCollection from
   `App.getWalkNetworkSegments()`, each feature carrying
   `properties.cov = WalkAudit.classifySidewalk(seg)`. Source
   `sidewalk-coverage`, layer `sidewalk-coverage-line`. Create-once /
   `setData`-after, same pattern as `network-connectors.js`'s walk-network
   layer. Insert below drawn features via the same `firstUserLayer()` approach.

4. Paint: **one** data-driven `["match", ["get","cov"], …]` expression, not five
   layers — the `network-joins-point` precedent. Suggested colors (map data
   symbols, explicitly exempt from the design-token rule per `CLAUDE.md` →
   "Design tokens and colors"): `both` `#16a34a`, `one-side` `#f59e0b`,
   `none` `#dc2626`, `footway` `#2563eb`, `unknown` `#94a3b8`. Give `footway`
   a heavier `line-width` so mapped sidewalk geometry reads distinctly from
   attributed centerlines.

5. Default visibility: **hidden.** Unlike the walk network, this is an audit
   overlay the user opts into, and it would otherwise fight the walk-network
   layer visually on every load.

6. Register in `layers-panel.js` `REFERENCE` (`:54-56`), directly after the
   `walk-network-line` entry — its own row, **not** added to that entry's
   `layers` array (§2: different semantics, independent toggle):
   ```js
   { id: "sidewalk-coverage-line", label: "Sidewalk coverage",
     layers: [{ id: "sidewalk-coverage-line", op: "line-opacity" }],
     clear: callIf("clearRoadNetwork") },
   ```
   No `styleKey` — these are semantic classes, not a ramp.

7. Call `App.refreshSidewalkCoverageLayer()` from `road-network.js`'s
   `updateUI()` behind a `typeof` guard, alongside the existing
   `App.refreshWalkNetworkLayer()` call. That is the documented single choke
   point for download / import / clear.

8. Add the `<script>` tag to `index.html` after `network-connectors.js`.

9. Update `CLAUDE.md`: File Structure entry, Script Load Order, the
   `layers-panel.js` REFERENCE description, App Namespace section.

**Verify:**
- `node --check js/core/walk-audit.js`.
- Download a network; the layer is **off** by default, appears in the Layers
  panel under Reference/Imported, and toggles on to show colored centerlines
  with working opacity.
- In a well-mapped city, green/amber/red/blue are all visibly present.
- In a poorly-mapped area, nearly everything reads gray (`unknown`) — this is
  correct and is the whole point.
- Clearing the network removes the layer with no console errors.
- `node test/ui-screens/capture.mjs` and **inspect the images** — the Layers
  panel gained a row.

---

### Phase 3 — Coverage statistics

**Goal:** turn the visual into a number the user can act on.

**Files:** `js/core/walk-audit.js`, `projects/walkshed-popup.html`,
`js/projects/walkshed.js`, `js/projects/transit-travelshed.js`, `CLAUDE.md`

**Work:**

1. Pure: `WalkAudit.coverageStats(segments)` → plain object:
   ```js
   { roadKm, footwayKm, crossingCount,
     byClass: { both, oneSide, none, unknown },   // km, road centerlines only
     pctTagged, pctBoth }                         // of roadKm
   ```
   - "road centerline" = `classifySidewalk(seg) !== "footway"`.
   - `crossingCount` counts segments whose `footway === "crossing"` **or**
     `crossing` tag is non-empty.
   - Segment length from the two coords. Keep this turf-free — use the same
     equirectangular approximation `road-network.js` uses for snapping, or take
     a caller-supplied length; do **not** import turf into the pure block.
   - Empty input → all zeros, never `NaN`. Golden-test that case.

2. App: `App.getSidewalkCoverageSummary()` → `{ text, detail, warn }` or `null`
   when no network is loaded. Mirrors `App.getConnectorReportSummary()` exactly
   (`js/core/network-connectors.js`), which is the established pattern for a
   one-line module footer.
   - `text`: e.g. `"Sidewalks: 34% of streets tagged · 18% both sides · 412 crossings"`
   - `warn: true` when `pctTagged` is below a documented threshold (start at
     25%) — the signal that sidewalk-only routing would be unreliable here.

3. Add golden cases to a new `test/cases/walk-audit.mjs`: `classifySidewalk`
   across every tag value including junk and absent, and `coverageStats` over a
   small hand-built segment array plus the empty case. Seed with
   `node test/run-golden.mjs --update` and **hand-verify the recorded numbers
   before committing** (`CLAUDE.md` → golden-value checks).

4. Surface it in the Walkshed popup's existing Advanced `<details>` block (where
   snap tolerance and crossing delays already live) as a read-only line, styled
   like the existing `#wsConnReport` footer. Add the same line to Transit
   Travelshed via its `connectionReportHTML()` neighbor. Both read the same
   global helper — no per-module state.

5. Update `CLAUDE.md`: `walk-audit.js` entry, both module entries, and add
   Sidewalk coverage to the golden-tested "Covered engines" list.

**Verify:**
- `node test/run-golden.mjs` → `PASS — N/N`, with the new case file included and
  its numbers hand-checked.
- The stat line appears in both Walkshed and Transit Travelshed and reads
  plausibly against what the Phase 2 layer shows on screen.
- With no network loaded, the line is absent (not "0%") in both modules.
- `node test/ui-screens/capture.mjs` — inspect both popups.

---

## ⛔ CHECKPOINT 1 — Stop and report

**Report to the user:** the coverage percentages for two or three real study
areas, plus a screenshot of the Phase 2 layer in each.

**The decision this unlocks:**

- **If `pctTagged` is low (< ~25%) in the user's real study areas:** Stage C and
  Stage D are **not worth building** — sidewalk-only routing there would produce
  confidently wrong walksheds. Stage A still stands on its own as a data-quality
  finding. **Stage B is still worth doing** — it needs no sidewalk data at all.
- **If coverage is good:** all remaining stages are live.

**Either way, Stage B is the next recommended phase**, because it delivers the
connector worklist the user actually asked for and does not depend on sidewalk
data quality at all.

---

# STAGE B — Topology gap finder (the actual connector worklist)

Independent of sidewalk data. Works in today's centerline mode. This is the
stage that answers *"where do I need to draw a connector?"*

---

### Phase 4 — Gap analysis engine

**Goal:** pure, golden-tested graph analysis. No UI.

**Files:** `js/core/walk-audit.js`, `js/core/road-network.js`,
`test/cases/walk-audit.mjs`, `CLAUDE.md`

**Work:**

1. Pure additions to `window.WalkAudit`, all taking a plain adjacency object
   `{nodeKey: [neighborKey, …]}`:
   - `labelComponents(adj)` → `{ componentOf: {nodeKey: id}, sizes: [n, …], largestId }`.
     Iterative BFS/DFS — **not recursive**; a city network will blow the stack.
   - `findDeadEnds(adj)` → array of nodeKeys with degree 1. (Degree is
     `adj[key].length`, the same trick `buildNodeTierMap` already uses.)
   - `pairGapCandidates(opts)` → ranked `[{ fromKey, toKey, gapKm, kind }]`
     where `kind` is `"island"` (endpoint of a non-largest component) or
     `"dead-end"` (degree-1 node close to a *different* component). Takes
     caller-supplied coordinates and a `maxGapKm`; returns only pairs in
     **different** components, sorted by `gapKm` ascending — the nearest
     misses are the most likely real gaps.
2. `road-network.js`: add `App.getWalkAdjacency()` → a plain adjacency object
   built from `_graph`, **skipping `pedBlocked` edges**, plus a parallel
   `{nodeKey: [lng,lat]}` coordinate map. One O(nodes) pass. Document clearly
   that this is **on-demand audit only and must never be called from a flood**.
   Cache it by `_networkEpoch`, same as `_walkSegCache`.
3. Golden cases in `test/cases/walk-audit.mjs`: a two-component toy graph, a
   single-component graph, a graph with an isolated node, a dead-end pair inside
   `maxGapKm`, a dead-end pair outside it, two dead ends in the **same**
   component (must **not** pair), and empty input.
4. Update `CLAUDE.md`.

**Verify:**
- `node test/run-golden.mjs` → `PASS — N/N`, new cases hand-verified.
- On a real city network in the console: `labelComponents` returns a dominant
  largest component (typically > 90% of nodes) plus a tail of small ones.
- The whole analysis completes in well under a second on a city-scale network.
  If it doesn't, the adjacency conversion is being redone — check the cache.

---

### Phase 5 — Gap markers and worklist UI

**Goal:** the user can see, on the map, where to draw connectors.

**Files:** `js/core/walk-audit.js`, `js/core/layers-panel.js`,
`projects/walkshed-popup.html`, `js/projects/walkshed.js`, `css/style.css`,
`CLAUDE.md`

**Work:**

1. `App.refreshWalkGapLayer()` — source `walk-gaps`, layers
   `walk-gaps-line` (a dashed hint line spanning each candidate pair) and
   `walk-gaps-point` (markers at candidate endpoints). One data-driven
   `["match", ["get","kind"], …]` expression per layer.
2. Style deliberately distinct from `network-joins-point`'s amber orphan
   circles so "connector end not joined" and "gap you might want to connect"
   are not confused. Suggest magenta/violet for gaps.
3. Register **one** `REFERENCE` row, "Walk network gaps", carrying both layers
   in its `layers` array (the multi-layer-per-row pattern the walk-network row
   already uses). Hidden by default.
4. Add an "Analyze gaps" button to the Walkshed Advanced block. On click: run
   the Phase 4 analysis, show the layer, and write a count line
   (`"14 candidate gaps · 3 disconnected fragments"`). Run **on demand only** —
   never automatically on network load, since it is an O(nodes) pass the vast
   majority of sessions won't want.
5. Clicking a gap marker zooms to it, so the user can draw a connector Line
   there immediately with the existing tooling.
6. Update `CLAUDE.md`.

**Verify:**
- Analyze gaps on a real network; markers appear at plausible locations
  (cul-de-sac cut-throughs, footpaths ending near streets, isolated plaza
  paths). Spot-check three against satellite basemap.
- Draw a connector Line across one flagged gap, set `networkRole = "connector"`,
  re-run the analysis → that gap is **gone** from the list. This is the key
  end-to-end proof that the worklist and the connector system agree.
- Toggle/opacity work from the Layers panel; clearing the network removes both
  layers cleanly.
- `node test/ui-screens/capture.mjs` — inspect.

---

## ⛔ CHECKPOINT 2 — Stop and report

**Report to the user:** the gap count on a real network, three spot-checked
markers with a note on whether each was a real gap or a false positive, and
confirmation that drawing a connector removes a gap from the list.

**The decision this unlocks:**

- **If false positives dominate:** tune `maxGapKm` and the ranking before going
  further. Do not proceed to Stage C/D on a noisy worklist.
- **If the worklist is useful:** the user may reasonably **stop here**. Stages A
  and B together deliver a sidewalk-quality map and a working connector
  worklist. Stage C only matters as a precursor to Stage D, and **Stage D is the
  only stage that changes analysis numbers** — it should be entered
  deliberately, not by momentum.

---

# STAGE C — Claimed-but-unmapped sidewalks

Only build this if Checkpoint 1 showed good coverage **and** the user intends to
pursue Stage D. On its own it produces a worklist for drawing sidewalk geometry
that nothing yet routes on.

---

### Phase 6 — Attribute-vs-geometry gap detection

**Goal:** find centerlines that *claim* a sidewalk but have no parallel footway.

**Note on precision:** this is deliberately a **crude** proximity test — loose
buffer, no bearing-agreement check. That is a considered decision, not a
shortcut. Used for *routing*, a false match would silently delete real walkable
network from every walkshed and nobody would catch it. Used for a *drawing
worklist*, a false match costs the user ten seconds of looking at a highlighted
street and moving on. Same algorithm, entirely different failure cost. Do not
"improve" this into a routing input without revisiting §2.

**Files:** `js/core/walk-audit.js`, `js/core/road-network.js`,
`test/cases/walk-audit.mjs`, `CLAUDE.md`

**Work:**

1. Pure: `WalkAudit.findUnmappedSidewalks(roadSegs, footwayCandidates, opts)`
   → `[{ segId, side, nearestKm }]` for each road segment where
   `classifySidewalk` is `"both"` or `"one-side"` **and** no footway candidate
   lies within `opts.maxOffsetKm` (default ≈ 25 m). Plain values in and out.
2. `road-network.js` supplies `footwayCandidates` by querying `_segGrid` around
   each road segment — the identical contract `applyConnectorOverlay()` already
   uses to feed `planarizeConnectors`. Reuse that code path; do not add a second
   spatial index.
3. Render these on the Phase 5 gap layer as a third `kind`, so there is one gap
   worklist rather than two competing ones.
4. Golden cases: claimed + nearby footway (no result), claimed + distant footway
   (result), `sidewalk=no` + no footway (**no** result — correctly absent, this
   case is the whole value of the attribute), unknown + no footway (no result —
   do not guess), empty input.

**Verify:**
- `node test/run-golden.mjs` → `PASS — N/N`, hand-verified.
- On a real network, flagged segments genuinely lack footway geometry —
  spot-check three against the Phase 2 layer with `footway` visible.
- `sidewalk=no` streets are **never** flagged.

---

## ⛔ CHECKPOINT 3 — Stop and report

**Report to the user:** how many segments are flagged, and an honest estimate of
the manual drawing effort that represents.

**The decision this unlocks:** if the flagged count is large (thousands of
segments), Stage D is impractical for that study area regardless of how good the
code is — the user would be hand-drawing a sidewalk network. Say so plainly
rather than proceeding.

---

# STAGE D — Sidewalk-only walk mode

**This is the only stage that changes analysis output.** Enter deliberately.

---

### Phase 7 — Sidewalk-only traversal mode

**Goal:** a toggle that floods on pedestrian geometry only.

**Files:** `js/core/road-network.js`, `js/core/network-connectors.js`,
`js/core/cache.js`, `js/projects/walkshed.js`,
`projects/walkshed-popup.html`, `projects/transit-travelshed-popup.html`,
`js/projects/transit-travelshed.js`, `CLAUDE.md`

**Work:**

1. Add `walkNetworkMode: "centerline"` (default) to `App.networkSettings`
   (`js/core/network-connectors.js:44`), with the same defensive backfill the
   crossing fields use at `:45-46`. Valid values `"centerline"` | `"sidewalk"`.
2. Persist as an additive `networkWalkMode` field in `cache.js` `collect()` /
   `restore()` (`:158-160`, `:311-322`), same pattern, no schema bump.
3. **Now** add `sidewalk`/`footway` to `addGraphEdge`'s edge objects (`:96-101`)
   — this is the phase where something finally reads them.
4. Add the predicate at `floodDijkstra:921`, immediately after the existing
   `pedBlocked` check:
   ```js
   if (mode === "sidewalk" && !isPedGeometry(nb)) continue;
   ```
   where `isPedGeometry` is true for `footway`/`path`/`steps`/`pedestrian`/
   `cycleway` classes **and** for connector-derived edges (`hwy === ""`, which
   is how `applyConnectorOverlay` tags them). Connectors must always traverse —
   they are the user's manual patch and the entire escape hatch for sparse data.
   Thread `mode` down through `runWalkFlood(lngLat, budgetKm, opts)` exactly as
   `crossingPenaltyKm` already is.
5. `snapToNetwork(lngLat, mode)` already takes a mode (`:414`). Add a
   `"walk-sidewalk"` mode that additionally rejects non-pedestrian candidates,
   so an origin can't snap onto a centerline the flood then can't leave.
6. Filter the reachable-streets layer (`:1092`) by the same predicate so the
   green correctness overlay matches what was actually flooded.
7. Add `walkNetworkMode` to Walkshed's `settingsKeyFor()`
   (`js/projects/walkshed.js:119`) — **not** an epoch bump.
8. UI: a select in **both** modules' Advanced blocks reading/writing the global,
   following `#wsSnapTol` / `#wsCrossMajor` exactly (`walkshed.js:814-865`).
   On change: `App.cache.save()` + `markStale()`. No connector rebuild needed —
   no geometry changed, only the traversal predicate.
9. **Warning surface:** when mode is `"sidewalk"` and
   `App.getSidewalkCoverageSummary().warn` is true, show a prominent warning in
   the results — a low-coverage sidewalk walkshed under-reports and looks
   authoritative while doing it. This is the single most important safeguard in
   this plan; do not ship Phase 7 without it.
10. Update `CLAUDE.md` thoroughly: `App.networkSettings`, `cache.js`,
    `floodDijkstra`, `snapToNetwork`, both module entries, `settingsKeyFor`.

**Verify:**
- Default `"centerline"` output is **byte-identical** to pre-phase output.
  Compare a walkshed's area and node count before/after on the same point and
  network. This is a hard requirement, not a nicety.
- Switching to `"sidewalk"` produces a visibly smaller, more fragmented
  walkshed; switching back restores the original exactly.
- Transit Travelshed picks the mode up **automatically** with no module-specific
  code — confirm via a re-run. (If it doesn't, the predicate went in the wrong
  place; it belongs in the shared `floodDijkstra`, not a caller.)
- A connector Line still traverses in `"sidewalk"` mode.
- The low-coverage warning fires in a poorly-mapped area.
- Mode change invalidates the Walkshed cache (result changes without a network
  reload); epoch is **unchanged**.
- `node test/run-golden.mjs` → unchanged.

---

### Phase 8 — *(optional)* Crossing penalties from mapped crossings

**Goal:** in sidewalk mode, charge the crossing penalty at **real mapped
crossings** instead of the node-degree heuristic.

**Files:** `js/core/walk-cost.js`, `js/core/road-network.js`,
`test/cases/walk-cost.mjs`, `CLAUDE.md`

**Work:**

1. `WalkCost.nodeTier(hwyList)` currently infers an intersection from ≥3
   incident edges. Add an optional crossing-aware path: when an incident edge
   carries `footway === "crossing"`, the node **is** a crossing regardless of
   degree, and its tier comes from the road class it crosses.
2. Use it in `buildNodeTierMap` only when mode is `"sidewalk"` — centerline mode
   keeps today's heuristic byte-identical.
3. Extend `test/cases/walk-cost.mjs` accordingly.

**Verify:**
- `node test/run-golden.mjs` → centerline-mode cases **unchanged**; new
  crossing-aware cases hand-verified.
- At 0-second penalties, output is identical in both modes (the existing
  "penalties off is byte-identical" guarantee must survive).

---

## 4. Risk register

| Risk | Stage | Mitigation |
|---|---|---|
| Sidewalk-only walkshed under-reports and looks authoritative | D | Phase 7 step 9 warning; Checkpoint 1 gates entry to the stage at all |
| Missing mapped crossings disconnect every block face | D | Connectors always traverse (Phase 7 step 4); Stage B worklist finds the gaps first |
| Recursive component labeling stack-overflows on a city network | B | Iterative BFS/DFS, stated in Phase 4 |
| Adjacency conversion re-run per call, freezing the UI | B | Epoch-keyed cache; on-demand button only, never on load |
| Crude proximity test drifts into routing use | C | Documented in Phase 6 preamble; keep it feeding the worklist only |
| Legacy road-network imports break | A | Absent tags → `""` / `"unknown"`; explicit Verify step in Phase 1 |
| New per-edge fields bloat the hot path | A→D | Segments only until Phase 7, when something reads them |

## 5. Definition of done

Stage A alone is a legitimate stopping point and the **expected** outcome for
most study areas: the user can see sidewalk coverage, has a number for it, and
knows whether deeper work is justified.

Stage B is the recommended second stop and is independent of sidewalk data
quality.

Stages C and D are conditional on the checkpoints above and must not be entered
on momentum. Stage D is done only when centerline-mode output is proven
byte-identical to today's and the low-coverage warning is in place.
