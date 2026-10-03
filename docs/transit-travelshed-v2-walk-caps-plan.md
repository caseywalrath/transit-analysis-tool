# Transit Travelshed v2 — Walk-leg caps & cluster-union polygons

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/transit-travelshed.md. This file is historical.

**Status:** Implemented (2026-08-12), all 5 phases + docs. Golden tests pass
129/129 (`node test/run-golden.mjs`), including new hand-verified cases for
each cap and the `alightings` return field. The §8 manual browser smoke test
could **not** be completed in the implementing session: its sandboxed network
policy blocks Overpass/OSRM/the CDN libraries this app loads from `unpkg.com`,
and — confirmed via a control run against unmodified `main` in the same
sandbox — the app's post-map-load init hangs indefinitely under full network
isolation regardless of this plan's changes. A human (or a session with
normal network access) should still run the §8 checklist before treating this
as fully verified end-to-end.
**Goal:** Turn the Transit Travelshed from a *door-to-door multimodal isochrone*
(walking and transit freely share one time budget) into a *transit-served
travel shed* (walking legs are individually capped), while keeping the current
behavior available as an explicit, clearly-labeled mode. Also fix the polygon
step so it can no longer bridge unreachable space between stop clusters.

This plan is self-contained. Implement it phase by phase, in order. Every
"verified fact" below was checked against the code on 2026-08-12 — trust the
described behavior, but re-check exact line numbers before editing (they drift).

---

## 1. Problem statement (why)

A test on the Colorado Springs MMT system produced a catchment that is very
wide around the origin. Three mechanisms cause this, and all three are present
in the current code:

- **A. Walk-only trips consume the entire time budget.** The origin walk flood
  runs at the full max budget (`js/projects/transit-travelshed.js`, `budgetKm`
  computed in `runTravelshed()` and passed to `App.computeWalkCostMap(_origin,
  budgetKm)`), and `computeArrivalTimes()` in `js/core/travelshed.js` seeds
  `nodeTimes` from that flood limited only by `t <= budgetMin`. A 30-minute
  budget at 3.1 mph seeds a ~1.5-mile-radius pure-walking blob before any
  transit is considered.
- **B. Egress (and access, and transfer) walks get the whole remaining
  budget.** `egressMerge()` in `js/core/travelshed.js` caps merged node times
  only at `budgetMin`; `stopArrivalFrom()` has no walk-leg cap at all. So
  "5-min ride + 25-min walk" is fully allowed.
- **C. The polygon step bridges gaps.** `buildWalkshedPolygon()` in
  `js/core/road-network.js` builds ONE concave hull over all of a band's nodes,
  with an auto-relax loop that multiplies `maxEdge` by 1.8 up to 8 times and
  finally falls back to a convex hull. When reachable nodes form disjoint
  clusters (origin blob + separate stop walksheds), the hull relaxes until it
  shrink-wraps everything together, filling space that is not actually
  reachable.

None of these are bugs — they are v1 model choices. v2 makes the model
explicit and fixes C unconditionally.

**What v2 does NOT change:** the transit traversal itself.
`computeArrivalTimes()` already propagates arrival times along every route as
far as the budget allows, through at most one transfer (`propagateRide` + the
round loop). That is the correct architecture (it matches Conveyal, the EPA
accessibility model, and Remix). Do not add any "ride each line to its
endpoint" logic — a terminal has no special meaning; if the budget reaches it,
it is reached.

**Performance side effect (the point of this pass):** today every stop flood
runs at the FULL max-budget radius (see the "Flood budget decision" comment
above `ensureFloods()` in `js/projects/transit-travelshed.js`). With a 45-min
budget that is ~3.7 km of Dijkstra flood per stop; with a 0.25-mi egress cap it
is ~0.4 km. Flood cost scales roughly with area, so capping egress shrinks
per-stop work by roughly 50–90×. No other speedup mechanism is in scope for
this pass — measure first, then revisit (see §8).

---

## 2. Design decisions (pinned — do not re-litigate)

### 2.1 New user settings (module `DEFAULT_SETTINGS`)

| Setting key         | UI label                    | Unit  | Default | Range guard |
|---------------------|-----------------------------|-------|---------|-------------|
| `shedMode`          | Travelshed model            | —     | `"transit"` | `"transit"` \| `"door"` |
| `maxAccessWalkMi`   | Max access walk (mi)        | miles | 0.5     | > 0 |
| `maxEgressWalkMi`   | Max egress walk (mi)        | miles | 0.25    | > 0 |
| `maxTransferWalkMi` | Max transfer walk (mi)      | miles | 0.25    | > 0 |

- Miles (not minutes) to match the existing "Assumed stop spacing (mi)" input.
  Convert to minutes for the engine: `capMin = (capMi / walkSpeedMph) * 60`.
  Convert to km for flood radii: `capKm = capMi * KM_PER_MILE`.
- `shedMode: "transit"` (default) applies all three caps. `shedMode: "door"`
  reproduces today's behavior exactly (all caps treated as uncapped, floods at
  full budget). The caps' inputs are disabled (grayed) while `"door"` is
  selected.
- UI copy for the mode control (two radios or a select, id `tsShedMode`):
  - "Transit-served shed (recommended) — walking to, between, and from transit
    is capped; shows the area transit meaningfully serves."
  - "Door-to-door isochrone — walking may use the whole time budget; shows
    everywhere physically reachable."

### 2.2 Engine API changes (`js/core/travelshed.js` — pure, plain JSON only)

`computeArrivalTimes(input)` gains three OPTIONAL input fields, all in
**minutes**, where `null`/`undefined` means uncapped (backward compatible —
existing golden cases must not change):

- `accessMaxMin` — caps (a) the origin-flood seed of `nodeTimes` at
  `min(budgetMin, accessMaxMin)`, and (b) the walk component computed by
  `stopArrivalFrom()` during round 0.
- `transferMaxMin` — caps the walk component in `stopArrivalFrom()` during
  rounds ≥ 1.
- `egressMaxMin` — caps the walk component in `egressMerge()` (the
  `costObj[nodeKey] * walkMinPerKm` term), in addition to the existing
  `cand > budgetMin` total check.

"Walk component" means the walking-time term only — never the accumulated
`baseMin`/`alightMin`.

The return object gains one field:

- `alightings: [{ stopKey, alightMin }]` — the best (minimum) alighting time
  per stopKey across ALL rounds. Accumulate a global best map alongside the
  existing per-round `newAlightings`. `routeDiags` and `stats` are unchanged.

### 2.3 Module flood budgets (`js/projects/transit-travelshed.js`)

In `runTravelshed()`:

- Origin flood radius: `"transit"` mode → `min(budgetKm, accessCapKm)`;
  `"door"` mode → `budgetKm` (unchanged).
- Stop flood radius: `"transit"` mode →
  `min(budgetKm, max(egressCapKm, transferCapKm))` (one flood must serve both
  egress merging and transfer walks); `"door"` mode → `budgetKm` (unchanged).
- The flood cache key already embeds the flood radius
  (`stopKey|epoch|budgetKm.toFixed(3)`), so changing a cap naturally misses the
  cache — no invalidation code needed. Keep passing the STOP flood radius (not
  the origin one) to `ensureFloods()`.

### 2.4 Polygonization: cluster-union replaces the single hull (both modes)

Replace the current per-band flow (collect all `bandNodeSets` nodeKeys → one
`App.polygonizeNodeSet` call) with a **union of per-cluster polygons**:

```
for each band budget B (ascending):
  clusterPolys = []

  # origin/access cluster
  cap = (mode == "transit") ? min(B, accessMaxMin) : B
  coords = [ nodeKeyToCoord(k) for k in originCost
             where originCost[k] * walkMinPerKm <= cap ]
  if coords non-empty: clusterPolys.push(polygonizeNodeSet(coords, maxEdgeKm))

  # one cluster per alighting stop
  for each { stopKey, alightMin } in engineResult.alightings:
    if alightMin >= B: skip
    cap = B - alightMin
    if mode == "transit": cap = min(cap, egressMaxMin)
    coords = [ nodeKeyToCoord(k) for k in stopCosts[stopKey]
               where stopCosts[stopKey][k] * walkMinPerKm <= cap ]
    if coords non-empty: clusterPolys.push(polygonizeNodeSet(coords, maxEdgeKm))

  bandPolygon = App.foldAnalysisUnion(clusterPolys)   # null-safe union
```

- Use this in BOTH modes (in `"door"` mode the clusters are big and overlap
  heavily; the union is still correct and avoids the hull artifact there too).
- `polygonizeNodeSet` calls may return `null` for degenerate clusters — filter
  nulls before folding. `App.foldAnalysisUnion` (module-buffers.js) already
  handles an empty array by returning `null`.
- Keep `Travelshed.bandNodeSets(engineResult.nodeTimes, budgets)` ONLY for the
  per-band node counts shown in the results table — it no longer drives
  geometry.
- The existing largest-first ring differencing (`turf.difference`) is
  unchanged and works on the MultiPolygons that union produces.
- Yield (`await new Promise(r => setTimeout(r, 0))`) between bands as the
  current code does; also yield every ~15 cluster polygonizations if a band has
  many stops.
- Do NOT modify `buildWalkshedPolygon()` in `road-network.js` — the Walkshed
  module's single-origin use case is exactly what its auto-relax is for. The
  fix is calling it per-cluster, not changing it.

### 2.5 Engine caps + walk-only area semantics

In `"transit"` mode the area around the origin renders only out to the access
cap. That walking is legitimate (it is how you reach the bus), so it is shown —
just capped. There is no separate "include walk-only area" toggle in this
pass; users who want the full walk blob switch to `"door"` mode.

---

## 3. Phase 1 — Engine caps (`js/core/travelshed.js`) + golden cases

1. Add the three optional cap fields to `computeArrivalTimes()` per §2.2.
   Normalize once at the top:
   `var accessMax = (input.accessMaxMin != null) ? input.accessMaxMin : Infinity;`
   (same for the other two). Apply:
   - Seed loop: `if (t <= budgetMin && t <= accessMax) nodeTimes[k] = t;`
   - `stopArrivalFrom(costObj, stop, baseMin, walkCapMin)`: add the 4th
     parameter; skip a candidate when `(d + a.extraKm) * walkMinPerKm >
     walkCapMin`. Round 0 passes `accessMax`; rounds ≥ 1 pass `transferMax`.
   - `egressMerge`: skip a node when
     `costObj[nodeKey] * walkMinPerKm > egressMax`.
2. Accumulate and return `alightings` per §2.2 (best per stopKey across
   rounds; update the global best inside the existing alighting loop).
3. **Golden tests.** Per CLAUDE.md testing policy:
   - Run `node test/run-golden.mjs` FIRST. Existing travelshed cases must pass
     unchanged (caps absent = uncapped). If any existing pin moves, that is a
     regression in your edit — fix the code, do not re-record.
   - Extend `test/cases/travelshed.mjs` with new cases: (a) a
     `computeArrivalTimes` run with tight `accessMaxMin` excluding a far stop
     that an uncapped twin case boards; (b) same input with/without
     `egressMaxMin` showing fewer merged nodes; (c) a transfer scenario where
     `transferMaxMin` blocks a transfer an uncapped twin makes; (d) a case
     asserting the new `alightings` array. Seed with
     `node test/run-golden.mjs --update`, commit the changed
     `test/golden/*.json` in the SAME commit, and note in the commit message
     which numbers are new pins vs. moved (none should move).
   - Add a `Verified: node test/run-golden.mjs → N/N` line to the commit
     message.

## 4. Phase 2 — Module settings, UI, flood budgets

1. `projects/transit-travelshed-popup.html`: add the mode control
   (`tsShedMode`) and three number inputs (`tsAccessWalk`, `tsEgressWalk`,
   `tsTransferWalk`), grouped under a "Walk limits" label near the existing
   wait-model inputs. Add an `rf-info-btn` ⓘ (id `tsWalkCapsInfoBtn`, toggling
   `tsWalkCapsInfoText`) with one sentence per mode from §2.1, following the
   existing `tsWaitInfoBtn` wiring pattern in `init()`.
2. `js/projects/transit-travelshed.js`:
   - Extend `DEFAULT_SETTINGS` per §2.1.
   - Extend `readSettingsFromInputs()` / `syncInputsFromSettings()` for the
     four new fields; wire the new element ids into the existing
     change-listener list in `init()` (they all `markStale()`).
   - Disable/enable the three cap inputs when the mode changes.
   - Apply §2.3 flood radii in `runTravelshed()`. Compute
     `accessCapMin/egressCapMin/transferCapMin` from miles and
     `_settings.walkSpeedMph`; pass them to `computeArrivalTimes` only in
     `"transit"` mode (pass `null` in `"door"` mode).
   - `computeRequiredExtent()` (prompt-to-download): in `"transit"` mode the
     buffer around selected features only needs the stop-flood radius
     (`max(egressCapKm, transferCapKm)`), and the origin circle only the
     access radius — smaller downloads. `"door"` mode keeps the full-budget
     buffers.

## 5. Phase 3 — Cluster-union polygonization

Implement §2.4 inside `runTravelshed()`. Notes:

- `originCost` and `stopCosts` are already in scope where bands are built.
- `engineResult.alightings` comes from Phase 1.
- Keep the results-table node counts driven by `bandNodeSets` as today.
- Keep the `turf.difference` fallback-to-undifferenced behavior verbatim.

## 6. Phase 4 — Disclosure, export, persistence

1. **Route detail panel** (`renderRouteDetail`): append the active caps to the
   footer or each row's sub-line in `"transit"` mode, e.g.
   `Walk caps: access 0.5 mi · egress 0.25 mi · transfer 0.25 mi`. In `"door"`
   mode append `Door-to-door — walk uncapped`.
2. **GeoJSON export metadata** (`exportGeoJSON`): add `shedMode`,
   `maxAccessWalkMi`, `maxEgressWalkMi`, `maxTransferWalkMi`.
3. **Session persistence**: bump `collect()` to `v: 2` adding the four new
   settings. In `apply()`, accept v1 payloads by defaulting the new fields
   (`shedMode: "transit"` + the §2.1 defaults) — geometry is not persisted, so
   a restored session is stale-until-rerun anyway; no migration warning
   needed. Guard numeric restores with the same `+x > 0` pattern used for
   `stopSpacingMi`.

## 7. Phase 5 — Docs

1. **CLAUDE.md**: update the `travelshed.js` core entry (mention the cap
   parameters and the `alightings` return) and the `transit-travelshed.js`
   module entry (shed-mode + walk-cap settings, cluster-union polygonization,
   session schema v2, smaller flood radii). Also update the
   `transit-travelshed-popup.html` line for the new inputs.
2. **features.md**: in the "Transit Travelshed performance & simplification
   brainstorm" section, mark the egress-cap outcome as implemented via this
   plan and note that remaining brainstorm items are deferred pending
   measurement (§8).
3. Cross-link this file from `docs/transit-travelshed-plan.md` (one line near
   the top: "Superseded in part by transit-travelshed-v2-walk-caps-plan.md for
   the walk-cap model and polygonization").

---

## 8. Verification checklist (run before the final commit)

- [ ] `node test/run-golden.mjs` → all pass; new cases pinned; no pre-existing
      pin moved. `Verified:` line in the commit message.
- [ ] Manual smoke test (browser, `index.html`): draw one route with a weekday
      band, place 2–3 stop Points with `associatedRoutes`, download a network,
      pick an origin, Calculate in `"transit"` mode → bands look like
      "beads on a string" (origin blob capped at ~0.5 mi; skinny corridors).
- [ ] Switch to `"door"` mode, re-run → today's wide shape returns; cap inputs
      gray out.
- [ ] Re-run twice in `"transit"` mode → second run reports all floods reused
      (cache hit) in the results footer.
- [ ] Compare the results footer `computeMs` between modes on the same
      network — `"transit"` mode should be dramatically faster. Note both
      numbers in the PR/commit description.
- [ ] Export GeoJSON → metadata carries the mode + caps.
- [ ] Reset Session → origin marker, layers, legend, and download-offer state
      all clear (existing `clearAll()` audit still holds).

## 9. Explicitly deferred (do NOT implement in this pass)

- **Stop clustering / flood dedup for overlapping catchments** — revisit only
  if the capped floods are still too slow in practice.
- **Calculation depth levels (Quick / Standard / Door-to-door selector with a
  circles-only egress mode)** — the two-mode toggle in this plan is the whole
  UI surface for now.
- Transfer cap > 1, schedule-based waits, batch/many-origin accessibility —
  unchanged from the existing v2 notes in features.md.
