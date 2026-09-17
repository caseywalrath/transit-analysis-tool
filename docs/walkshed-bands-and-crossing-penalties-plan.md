# Walkshed bands + intersection crossing penalties — implementation plan

Three related changes to the Walkshed module and the offline walk engine, in
dependency order. Each phase is independently shippable and independently
committable. **Do not start a phase until the previous one is committed and its
verification steps pass.**

Branch: `claude/wonderful-mayer-yjh6iq`.

---

## 0. Context and settled decisions

Read `CLAUDE.md` first — especially the **Testing — golden-value checks** section
and the **Visual verification** convention. Both apply to this work.

These decisions are already made. Do **not** re-litigate them; implement them as
written.

1. **Reachable-streets visibility moves to the Layers panel.** The
   `#wsShowSegments` checkbox is retired. The Layers tab is the app's single
   surface for layer visibility (see the `layers-panel.js` entry in `CLAUDE.md`),
   and two controls fighting over the same `visibility` property is a live bug —
   `renderWalkshedLayers()` currently reasserts the checkbox's value on every
   run, so hiding the layer from the Layers panel and then pressing Calculate
   makes it reappear.

2. **Walkshed gets three time budgets**, mirroring Transit Travelshed's
   `#tsBudget1/2/3`. Budgets 2 and 3 may be blank.

3. **Budgets are sorted ascending when read.** This makes "first budget" and
   "smallest budget" the same thing by construction, so the study-area label and
   the code can never disagree, and largest-first ring-differencing gets a
   guaranteed ordering for free.

4. **The smallest budget is the study area.** `App.getPointWalkshed(pointIdx)`
   returns exactly one polygon and `points.js rebuildBuffers()` substitutes it
   for the circular buffer, so every downstream consumer (Feature Area Analysis,
   TPI, Census, LODES, Transit Coverage, Title VI) depends on there being one
   study area per point. The other bands are display-only.

5. **Crossing penalties default to 0 seconds.** Shipping them on by default would
   silently move every walkshed, every walkshed-backed study area, and every
   number downstream of both. Zero default = no behavior change, no golden churn,
   opt-in only.

6. **Crossing penalties are node-uniform, not turn-aware.** A strictly correct
   turn cost needs per-(node, arrival-edge) search states, which would multiply
   the node count and slow Transit Travelshed's per-stop floods. Node-uniform
   over-charges travel *along* an arterial; that is a known, accepted
   approximation and the reason the default arterial figure is a blended 20 s
   rather than a true signal wait. Document it in the UI help text; do not try to
   fix it in this plan.

---

## Phase 1 — Split the walkshed layer rows; retire `#wsShowSegments`

**Goal:** the walkshed polygon and the green reachable-streets layer become two
independent rows in the Layers panel, each with its own show/hide and opacity.

### Files

**`js/core/layers-panel.js`** — replace the single `ANALYSIS` entry at line ~82:

```js
    { id: "walkshed-fill", label: "Walkshed", moduleId: "walkshed",
      layers: [{ id: "walkshed-fill", op: "fill-opacity" },
               { id: "walkshed-line", op: "line-opacity" },
               { id: "walkshed-seg", op: "line-opacity" }] },
```

with two entries:

```js
    { id: "walkshed-fill", label: "Walkshed", moduleId: "walkshed",
      layers: [{ id: "walkshed-fill", op: "fill-opacity" },
               { id: "walkshed-line", op: "line-opacity" }] },
    { id: "walkshed-seg", label: "Walkshed — reachable streets", moduleId: "walkshed",
      layers: [{ id: "walkshed-seg", op: "line-opacity" }] },
```

Manifest entries only render when their layer is actually on the map
(`entryPresent`), so the second row auto-hides when segments aren't drawn. No
other change is needed in this file — `_analysisOrder` is derived from `ANALYSIS`
at load time.

**`projects/walkshed-popup.html`** — delete the whole
`data-input-group="display"` block (the `#wsShowSegments` label/checkbox,
currently lines ~30-35).

**`js/projects/walkshed.js`** — remove every trace of the checkbox:
- delete the `_showSegments` module variable (line ~33)
- delete the `if (map.getLayer(WS_SEG_LAYER)) map.setLayoutProperty(...)` block at
  the end of `renderWalkshedLayers()` (lines ~268-270) — **this is the actual bug
  fix**; nothing may assert `visibility` on `walkshed-seg` any more
- delete the `#wsShowSegments` listener in `init()` (lines ~645-651)
- delete the `var seg = ...` / `if (seg) seg.checked = ...` lines in
  `syncInputsFromSettings()`
- delete `showSegments` from `collect()` and the
  `if (typeof data.showSegments === "boolean")` line in `apply()`

**Do not bump the walkshed session schema version.** It stays at `2`. Dropping a
field is backward compatible — an old session's stored `showSegments` is simply
ignored. A user who had segments hidden in a saved session will see them again on
restore, and hides them from the Layers panel instead. That is the intended
behavior change.

### Verification

- `node --check js/core/layers-panel.js js/projects/walkshed.js`
- `node test/run-golden.mjs` → must still be 163/163 (nothing pure changed)
- `NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs` —
  popup markup changed, so this is required. **Inspect the walkshed popup images**,
  not just the pass count; confirm the Advanced block and the button row still lay
  out correctly with the display group gone.
- Manually confirm: hide "Walkshed — reachable streets" from the Layers tab,
  press Calculate again, and it stays hidden.

### Commit

```
feat: split walkshed reachable-streets into its own Layers panel row

Verified: node test/run-golden.mjs → 163/163
```

Also update `CLAUDE.md`: the `layers-panel.js` File Structure entry, the
`walkshed.js` module entry (drop the "show reachable streets toggle" mention),
and the `walkshed-popup.html` entry.

---

## Phase 2 — Engine support for multiple budgets

**Goal:** `App.computeWalkshed` can return several nested isochrone polygons from
**one** flood instead of one polygon per call.

### File: `js/core/road-network.js`

Extend `computeWalkshed(lngLat, budgetKm, options)` (line ~1020) with an optional
`options.budgetsKm` — an array of km values, **ascending**.

Behavior:
- **`options.budgetsKm` absent** → behave exactly as today. This is a hard
  requirement: `computeForPoint` in `walkshed.js` and any other caller must keep
  working untouched until Phase 3 migrates them.
- **`options.budgetsKm` present** → flood **once** at `max(budgetsKm)`, then for
  each budget `b` collect the coordinates of every `distMap` entry whose distance
  is `<= b` and run `buildWalkshedPolygon(coords, options.maxEdge)` on that
  subset.

Return shape when `budgetsKm` is present — additive, nothing existing changes
meaning:

```js
{
  polygon,            // unchanged: the LARGEST budget's polygon
  polygons: [         // NEW, ascending, one per entry in budgetsKm
    { budgetKm, polygon, nodeCount }
  ],
  reachableSegments,  // unchanged: computed at the largest budget
  reachableCount,     // unchanged: distMap.size at the largest budget
  snap, computeMs, snapMs, floodMs
}
```

A band whose polygon comes back `null` (degenerate/sparse) still gets an entry
with `polygon: null` — the caller decides how to report it. Do not drop entries,
or the caller's index-to-budget mapping breaks.

**Do not reuse `window.Travelshed.bandNodeSets`.** It takes a plain object keyed
by node and returns arrays of keys; `distMap` is a `Map` of tens of thousands of
entries, so converting would cost more than the five-line inline threshold loop.
This was considered and rejected deliberately.

### Verification

`road-network.js` needs `turf` and `App.map`, so the golden harness cannot load
it — there is **no golden coverage for this phase**, by design (see CLAUDE.md:
"The harness pins only *pure* math"). Therefore:

- `node --check js/core/road-network.js`
- `node test/run-golden.mjs` → must still be 163/163, unchanged
- Manual check in the browser: with `budgetsKm` absent, a Walkshed run produces
  the identical polygon it did before this phase. This is the backward-compat
  guarantee and must be confirmed by hand before committing.
- No screenshot run needed — no markup or CSS touched.

### Commit

```
feat: computeWalkshed can return multiple nested budget polygons from one flood

Verified: node test/run-golden.mjs → 163/163
```

Update the `road-network.js` entries in `CLAUDE.md` (both the File Structure
paragraph and the App Namespace section) to describe `options.budgetsKm` and the
`polygons` return field.

---

## Phase 3 — Three time budgets in the Walkshed module

**Goal:** the UI, cache, results table, export, and study-area substitution all
understand up to three budgets.

### `projects/walkshed-popup.html`

Replace the single `#wsMinutes` field with a three-input row modeled on
`projects/transit-travelshed-popup.html`'s `ts-budget-row` (lines 28-33 there).
Keep the id `wsMinutes` for the first input so nothing silently loses its
listener; add `wsMinutes2` and `wsMinutes3`. Inputs 2 and 3 get
`placeholder="—"` and no `value`. Label the row "Time budgets (min)".

Reuse the existing `.ts-budget-row` / `.ts-budget-input` classes rather than
adding walkshed-specific CSS — this is exactly the kind of shared primitive
`CLAUDE.md`'s "Spacing and shared primitives" convention asks you to extend, not
duplicate. If those classes turn out to be scoped under a `.ts-` ancestor in
`css/style.css`, generalize the selector rather than copying the rules.

Also update the `#wsUseStudyArea` button — its label becomes dynamic (below).

### `js/projects/walkshed.js`

**Settings.** `DEFAULT_SETTINGS` becomes
`{ budgets: [15, 30, null], walkSpeedMph: 3.1, maxEdge: 0.3 }`. Remove
`minutes`.

Add a helper used everywhere a budget list is needed:

```js
// Valid budgets only, ascending, deduped, each capped at MAX_MINUTES.
function activeBudgets() { /* ... */ }
```

It must never return an empty array — if every input is blank/invalid, fall back
to `[DEFAULT_SETTINGS.budgets[0]]`.

**`readSettingsFromInputs()`** reads all three inputs, then sorts ascending
before storing. **`syncInputsFromSettings()`** writes them back in order; blank
for a missing budget.

**`pointSettingsFor(pf)`** currently resolves a single `minutes` with an optional
per-point `attributes.walkMinutes` override. Keep the override semantics: when a
point carries `walkMinutes`, that point uses `[walkMinutes]` as its only budget.
Otherwise it uses `activeBudgets()`.

**`settingsKeyFor(pf)`** must include every budget, not just one — otherwise
changing budget 2 won't invalidate the cache. Join the budget array into the key.

**`computeForPoint(pf)`** calls `App.computeWalkshed(coords, maxBudgetKm, { maxEdge, budgetsKm })`.
The cache entry gains:

```js
bands: [{ minutes, polygon, area, nodeCount }]   // ascending
```

Keep `entry.polygon` pointing at the **smallest** band's polygon — that is what
`getPointWalkshed()` returns, and keeping the field name means `getPointWalkshed`
itself needs no change at all. Keep `entry.area`/`entry.reachableCount` as the
smallest band's values for the same reason.

**Rendering.** In `renderWalkshedLayers()`, stamp `bandIdx` (0-based, 0 =
smallest) and `minutes` onto each polygon feature, and push one feature per band
per point. Color by band with a data-driven expression — the
`["match", ["get", "bandIdx"], 0, …]` pattern already used by
`network-joins-point` in `js/core/network-connectors.js` is the precedent:

```js
"fill-color": ["match", ["get", "bandIdx"], 0, "#1e40af", 1, "#3b82f6", "#93c5fd"]
```

Push features **largest band first** so the smallest paints on top. Do not
ring-difference in this phase — stacked translucent fills are acceptable and much
simpler. (Transit Travelshed's `turf.difference` approach is available later if
the stacking reads badly.)

**Results table.** `renderResults()` grows a Band column: one row per point per
band, with the point name shown only on its first row. Failures keep their
existing single-row treatment.

**`inputsSummary()`** becomes e.g. `"15 / 30 min · 3.1 mph · 2 points"`.

**`computeRequiredExtent()`** must size its circles from the **largest** budget,
not the first.

**`exportGeoJSON()`** emits one feature per band per point, each with `minutes`
and `bandIdx` in its properties.

**Study-area button.** Its label is rebuilt from the smallest budget whenever
budgets change and in `syncInputsFromSettings()`:

```
Use 15-min walkshed as study areas
```

Give it a `title` explaining that changing the smallest budget changes the study
area for every downstream module. `useAsStudyAreas()` itself needs no logic
change — it flags `serviceAreaType`, and `getPointWalkshed` already returns the
smallest band.

**Session persistence.** Bump `collect()` to `version: 3`, writing `budgets`.
`apply()` migrates: if `data.budgets` is an array use it; else if
`+data.minutes > 0` (v1/v2) use `[data.minutes]`. Preserve the existing
`walkSpeedKmh` → `walkSpeedMph` v1 migration exactly as it is.

**`init()`** must wire `change` listeners on `wsMinutes2`/`wsMinutes3` alongside
the existing `wsMinutes`.

### Verification

- `node --check js/projects/walkshed.js`
- `node test/run-golden.mjs` → 163/163
- `NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs` —
  required (popup markup changed). **Inspect the images**; the popup is only
  460px wide, so confirm the three-input row doesn't overflow.
- Manual: restore an old session and confirm its single `minutes` becomes
  `budgets[0]`; confirm a point flagged `serviceAreaType: "walkshed"` still
  produces the same study area as before when budget 1 is unchanged.

### Commit

```
feat: Walkshed supports up to three time budgets

Verified: node test/run-golden.mjs → 163/163
```

Update `CLAUDE.md`: the `walkshed.js` module entry (budgets, band rendering,
schema v3, dynamic study-area label) and the `walkshed-popup.html` entry.

---

## Phase 4 — Crossing-penalty engine (pure, golden-tested)

**Goal:** the classification and cost math for intersection crossing penalties,
in a file the golden harness can load.

### New file: `js/core/walk-cost.js`

Follow the `js/core/connector-graph.js` header and namespace convention exactly —
an IIFE defining `window.WalkCost`, with **no turf, no DOM, no Map, no App
state**, plain values in and out. That is the only reason it can be golden-tested
at all; `road-network.js` cannot be, because it needs turf.

Functions:

```js
// OSM highway class -> crossing tier. motorway/trunk are already pedBlocked
// upstream, so they never reach here; treat unknown/absent as "minor".
// major: primary, secondary (+ their _link forms)
// minor: everything else (tertiary, residential, unclassified, service,
//        living_street, footway, path, pedestrian, cycleway, steps)
WalkCost.roadTier(hwy)  // -> "major" | "minor"

// Given the highway classes of every edge meeting at one node, return the tier
// of the crossing penalty that node earns, or null when it earns none.
// Returns null when fewer than 3 edges meet (2 = a shape point on a curve,
// 1 = a dead end) — this is what keeps the penalty off the tens of thousands
// of geometry vertices that are not intersections.
WalkCost.nodeTier(hwyList)  // -> "major" | "minor" | null

// Convert a tier + settings into a distance the flood can subtract from its
// km budget. A fixed S-second delay consumes speedKmh * S / 3600 km, so the
// penalty stays a constant number of SECONDS regardless of walk speed.
// Returns 0 for a null tier or a zero/absent penalty.
WalkCost.penaltyKm(tier, { majorSec, minorSec, speedKmh })  // -> km
```

`tertiary` counts as **minor** — it is usually a collector and often
unsignalized. This is a deliberate choice; keep it as a documented constant.

### Wire it in

Add `<script src="js/core/walk-cost.js"></script>` to `index.html` in the core
block, **before `road-network.js`** (which will consume it in Phase 5).

### New file: `test/cases/walk-cost.mjs`

Model it on `test/cases/connector-graph.mjs`. `scripts: ["js/core/walk-cost.js"]`.
Cover at minimum:

- `roadTier`: primary → major; secondary_link → major; tertiary → minor;
  residential → minor; `""` → minor; unknown string → minor
- `nodeTier`: 4-way with a primary → major; 4-way all residential → minor;
  2-edge list → null; 1-edge list → null; empty list → null
- `penaltyKm`: major at 20 s / 5 km/h; minor at 5 s; `null` tier → 0;
  `majorSec: 0` → 0; and a speed-sensitivity pair proving that halving
  `speedKmh` halves the returned km (i.e. the same wall-clock delay)

Seed the goldens with `node test/run-golden.mjs --update`, then **read the
recorded JSON and confirm the numbers are what you intended** before committing.
Do not seed and commit blindly.

### Verification

- `node --check js/core/walk-cost.js`
- `node test/run-golden.mjs` → should now be **more than 163** cases across **11**
  modules. Record the exact new total in the commit message.
- No screenshot run — no markup, CSS, popup, or module UI touched.

### Commit

```
feat: pure crossing-penalty engine (window.WalkCost) + golden cases

Verified: node test/run-golden.mjs → N/N
```

Update `CLAUDE.md`: add `walk-cost.js` to File Structure and to Script Load
Order, and add it to the **Covered engines** list in the Testing section.

---

## Phase 5 — Apply crossing penalties in the walk flood

**Goal:** Walkshed can charge a per-intersection delay. Off by default.

### `js/core/road-network.js`

**Carry the road class onto edges and segments.** `buildGraph()` (line ~112)
already computes `var hwy = props.highway || ""` and then discards it. Add `hwy`
to the object pushed by `addGraphEdge()` and to each `segments.push({...})`
record. Give `addGraphEdge` a new trailing `hwy` parameter, defaulting to `""`
so `applyConnectorOverlay()`'s call site keeps working unchanged — connector
edges have no OSM class and should be treated as minor.

**Build a node-penalty index.** After the graph is built (alongside the existing
`_segGrid = buildSegGrid(...)` calls at lines ~170 and ~252), compute a
`_nodeTier` Map of `nodeKey -> "major"|"minor"` by walking `_graph` once: for
each node, collect its edges' `hwy` values and call `WalkCost.nodeTier(...)`.
Skip nodes that return `null` — do not store them. Clear `_nodeTier` in
`clearRoadNetwork()` next to `_segGrid = null`.

Because this is rebuilt inside the same paths that bump `_networkEpoch`, it stays
in sync with connectors and reloads automatically.

**Charge the penalty in the flood.** `floodDijkstra(startKey, budgetKm)` (line
~874) gains a third parameter — a plain `{ major, minor }` object of **km** values,
or null. In the relaxation loop, after `var newDist = current.dist + nb.weight;`,
add the penalty for arriving at `nb.node`:

```js
if (penaltyKm) {
  var tier = _nodeTier.get(nb.node);
  if (tier) newDist += (tier === "major" ? penaltyKm.major : penaltyKm.minor);
}
```

The budget check that follows is unchanged, so an over-budget crossing correctly
prunes.

**Thread it through.** `runWalkFlood(lngLat, budgetKm, opts)` passes
`opts && opts.crossingPenaltyKm` down to `floodDijkstra`.
`computeWalkshed(lngLat, budgetKm, options)` passes
`options.crossingPenaltyKm` into `runWalkFlood`.

**Leave `computeWalkCostMap` alone in this phase.** Transit Travelshed is its
only consumer and is out of scope here; with no penalty passed, its behavior is
bit-identical. Note it in `CLAUDE.md` as a deliberate follow-up.

### `js/core/network-connectors.js`

Extend the existing global settings object — these are network-level settings
shared the same way `snapToleranceFt` is:

```js
App.networkSettings = App.networkSettings || {
  snapToleranceFt: 50,
  crossingMajorSec: 0,
  crossingMinorSec: 0
};
```

Note that `|| {}` short-circuits on an already-created object, so also backfill
the two new keys defensively when they're absent.

### `js/core/cache.js`

`collect()` and `restore()` gain `networkCrossingMajorSec` /
`networkCrossingMinorSec`, exactly mirroring the existing
`networkSnapToleranceFt` additive-field pattern. No core schema bump — these are
additive and default gracefully.

### `projects/walkshed-popup.html`

Two inputs inside the existing Advanced `<details>`, next to the snap-tolerance
field:

```
Crossing delay — major street (s)   [0]   min=0 max=120 step=1
Crossing delay — minor street (s)   [0]   min=0 max=60  step=1
```

Followed by a `tiny u-muted` help paragraph. Suggested copy:

> Seconds added each time the walk crosses an intersection. 0 = off. Typical
> signalized arterial is 15–20 s; suburban arterials with long cycles run 30–45 s.
> Shared with Transit Travelshed. Applied at every intersection on the route, so
> walking *along* an arterial is charged too — treat these as blended averages,
> not exact signal waits.

### `js/projects/walkshed.js`

- `syncInputsFromSettings()` reads both values from `App.networkSettings`
  (**not** `_settings` — they are global, same as snap tolerance)
- an `onCrossingChange()` handler mirroring the existing `onSnapTolChange()`:
  write the global, `App.cache.save()`, `markStale()`. It does **not** need to
  call `refreshNetworkConnectors()` — no connector geometry changed.
- `computeForPoint()` builds
  `crossingPenaltyKm: { major: WalkCost.penaltyKm("major", opts), minor: WalkCost.penaltyKm("minor", opts) }`
  from the globals plus the point's own walk speed in km/h, and passes it into
  `App.computeWalkshed`
- **`settingsKeyFor(pf)` must include both penalty values.** They change the
  result but do not bump `_networkEpoch`, so without this the cache serves stale
  polygons after a penalty change. This is the single easiest thing to get wrong
  in this phase.
- guard the `WalkCost` calls with `typeof window.WalkCost !== "undefined"` so a
  missing script tag degrades to no penalty rather than throwing

### Verification

- `node --check` on every changed JS file
- `node test/run-golden.mjs` → same count as Phase 4, unchanged. If it moved,
  something non-pure leaked into a tested module — fix the code, do not
  `--update`.
- `NODE_PATH=/tmp/pw-install/node_modules node test/ui-screens/capture.mjs` —
  required (popup markup changed). Inspect the Advanced block images.
- Manual, and important: with both penalties at **0**, a walkshed must be
  **pixel-identical** to Phase 3's output. Confirm this before anything else.
  Then set major to 20 s and confirm the shed visibly shrinks and shrinks more at
  dense-grid intersections than on long uninterrupted blocks.

### Commit

```
feat: optional intersection crossing penalties in the walk flood

Verified: node test/run-golden.mjs → N/N
```

Update `CLAUDE.md`: `road-network.js` (both File Structure and App Namespace),
`network-connectors.js` (the expanded `App.networkSettings`), `cache.js` (the two
new additive fields), and the `walkshed.js` / `walkshed-popup.html` entries.

---

## Out of scope

Deliberately excluded — do not build these:

- Turn-aware penalties (per-(node, arrival-edge) search states)
- User-placed crossing Points (`networkRole: "crossing"`) — a possible future
  override layer on top of the automatic classification
- Applying penalties to `computeWalkCostMap` / Transit Travelshed
- Ring-differencing the walkshed bands
- Any change to the default penalty values away from 0
