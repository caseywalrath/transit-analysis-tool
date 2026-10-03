# Module-Owned Analysis Buffer Distance — Implementation Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/analysis-modules.md. This file is historical.

> Follow-up delivered: Feature Area Analysis now uses the same selected-feature
> buffer controls. All five scoped modules also provide a default-off **Use
> Display Buffers** option. It disables the distance field and uses the selected
> Feature Settings buffers; polygons remain unbuffered and cached walksheds are
> preserved in both modes.

## Context

Transit Coverage was built as the first module that owns its own analysis distance: it reads a "Buffer distance (mi)" input and builds **private** buffers with `turf.buffer(...)`, never touching the shared `App.routeBuffers` / `App.lineBuffers` that the Feature Settings panel maintains. Its plan called this "a prototype for the future per-module-buffer convention (out of scope here)."

This plan is that follow-up: give **Transit Propensity (TPI)**, **Ridership Forecasting (RF)**, and **Corridor Scoring (CS)** the same module-owned buffer distance, and factor the buffer-building logic into one shared core helper that all four modules (including Transit Coverage) use.

Today all three modules derive their study area from the *global* buffers, so changing the analysis radius means changing the Feature Settings radius — which also moves every drawn buffer on the map and every other module's study area at the same time. After this change, each module carries its own distance and the global setting only controls what is drawn on the map.

**This plan is written for execution by a cheaper model (Sonnet 5).** Steps are small, ordered, and independently verifiable; no design decisions are left open. A "Handoff" section at the end explains how to run the implementation session.

## Settled design decisions (from user)

- **One shared default, truly global:** a single constant `App.ANALYSIS_BUFFER_DEFAULT_MILES = 0.5` in the shared helper is the default for **all four** modules. **Transit Coverage's current 0.25 default changes to 0.5** as part of this work so the four agree.
  - *Flagged for the record:* ¼ mile is the conventional walk-to-transit standard for the coverage statistic specifically, so Transit Coverage's headline number will read higher at the new 0.5 default than at 0.25. The user asked for one global default; this is easy to revisit later by changing the one constant (or giving Transit Coverage its own default again).
- **Walksheds are preserved.** The module distance applies to routes, lines, and ordinary circular-buffer points. A Point flagged `attributes.serviceAreaType === "walkshed"` that has a cached walkshed keeps that walkshed polygon, because a walkshed is a study-area *type*, not a distance. (Only TPI has points in its checklist.)
- **Per-feature `_bufferRadius` overrides are ignored** by module buffers — the user's stated goal is a distance "independent from whatever the feature attribute buffer distance is." One module distance applies uniformly to every selected route/line/circular point.
- **Polygons are never buffered** — a drawn polygon is already an area, used as-is (same as Transit Coverage's service-area polygons). Only TPI has polygons in its checklist.
- **Transit Coverage is refactored onto the shared helper**, replacing its private `buildPrivateBuffer` / `foldUnion`.
- **Per-module, not shared between modules:** each module stores and persists its own distance, exactly like Transit Coverage.
- **Backward compatibility:** because the default equals today's global default (0.5), a user who never changed the Feature Settings radius gets identical results after the update. Restored sessions with no persisted buffer value fall back to 0.5.

## Verified reference points

All line numbers verified against the current tree.

**The buffer sources being replaced**

- `App.routeBuffers` / `App.lineBuffers` are rebuilt by `rebuildRouteBuffers` (`js/core/routes.js:90-104`) and `rebuildLineBuffers` (`js/core/lines.js:20-35`). Both honor `feature.properties._bufferRadius` first, else the global radius.
- `App.buffers` (points) is rebuilt by `rebuildBuffers` (`js/core/points.js:115-153`) — same `_bufferRadius` fallback, **plus** the walkshed substitution at `points.js:126-138` (uses `App.getPointWalkshed(pointIdx)`, tags the result `properties.walkshed = true`).
- Module union builders to replace: TPI `buildUnionFromFilter` (`transit-propensity.js:42-80`, covers route/line/**point**/**polygon**), CS `buildUnionFromFilter` (`corridor-scoring.js:33-70`, route/line), RF via `RM.buildUnionFromFeatures` (`ridership-scoring.js:78-101`, route/line).

**The engine coupling (the real work)**

- `RM.computePerRouteCDI(tpiResult, featureFilter)` reads `App.routeBuffers[ri]` / `App.lineBuffers[li]` directly to get each feature's own buffer (`ridership-scoring.js:198-224`). Both RF and CS reach it through `RM.computeSystemDemand` (`ridership-scoring.js:330-360`), which currently has no way to pass buffers in.
- `RM.computeSegments(tpiResult, segmentMiles, selectedCorridor)` buffers each chunk with a **hardcoded `0.5`** at `ridership-scoring.js:449`. Called from `ridership-forecasting.js:565` and internally at `ridership-scoring.js:136` / `:532`.
- `TPI.computeTPI(options)` already accepts `options.unionPolygon` (`tpi-scoring.js:529`) — **no engine change needed there**.
- RF's per-route GeoJSON export pulls buffer geometry from `App.routeBuffers` / `App.lineBuffers` at `ridership-forecasting.js:2560-2572`.
- TPI's corridor filter looks up a single feature's buffer at `transit-propensity.js:232-246` (`getGeosInCorridor`).

**Becomes obsolete**

- `hasBufferIssue` exists in all three modules — `transit-propensity.js:83` (used `:579`), `corridor-scoring.js:72` (used `:729`), `ridership-forecasting.js:1004` (used `:494`, `:1286`). It guards against "no buffers defined for selected features," which cannot happen once the module builds its own buffers from source geometry.

**Patterns to copy**

- The whole module-buffer approach: `transit-coverage.js` — `foldUnion` (`:346-354`), `buildPrivateBuffer` (`:355-358`), `buildCoverageUnions` (`:360-400`), input reading + validation (`:495-499`), stale wiring (`:822-823`), persistence (`:930-1050`).
- The input control markup: `projects/transit-coverage-popup.html:30-31`.
- Existing precedent for a module-owned distance: Title VI's `policy.bufferDistanceMiles` (`title-vi-engine.js:32`, consumed `:175-183`, `:234-246`).
- Session-cache field added without a schema bump (the established precedent in this repo): RF's `baselineUncertaintyPct`, per CLAUDE.md — "added gracefully — defaults to 0.25 when absent, no schema version bump needed."

---

## Implementation steps

### Step 1 — Shared core helper (`js/core/module-buffers.js`)

**Files:** create `js/core/module-buffers.js`, edit `index.html`.

Plain IIFE assigning onto `App`, no DOM access, depends only on `turf` + `App.points/lines/routes/polygons` + `App.getPointWalkshed`.

Constants:
```js
App.ANALYSIS_BUFFER_DEFAULT_MILES = 0.5;
App.ANALYSIS_BUFFER_MIN_MILES     = 0.05;
App.ANALYSIS_BUFFER_MAX_MILES     = 5;
```

Functions:
- `App.foldAnalysisUnion(polys)` → try/catch `turf.union` fold, `null` for empty (copy `transit-coverage.js:345-353` verbatim).
- `App.buildAnalysisBuffer(feature, miles)` → `try { return turf.buffer(feature, miles, { units:"miles", steps:64 }); } catch (e) { return null; }` (copy `transit-coverage.js:355-358`).
- `App.readAnalysisBufferMiles(elOrId, fallback)` → parses the input's value; returns the parsed number when finite and within \[MIN, MAX], else `fallback` (default `ANALYSIS_BUFFER_DEFAULT_MILES`). Pure-ish and testable — **this is the function the golden cases in Step 7 cover.**
- `App.buildAnalysisBufferSet(filter, miles, opts)` → the core builder.
  - `filter` = `{ routeIndices, lineIndices, pointIndices, polygonIndices }` — any key may be absent; **always explicit arrays, never "null means all"**.
  - Returns `{ byType: { route:{}, line:{}, point:{}, polygon:{} }, union, get: function(type, idx){...}, count }` where each `byType[type][idx]` is a polygon Feature and `union` is the folded union of everything.
  - **Routes / lines:** `buildAnalysisBuffer(feature, miles)`.
  - **Points:** if `opts.preserveWalksheds !== false` (default true) **and** `attributes.serviceAreaType === "walkshed"` **and** `App.getPointWalkshed(feature.properties.pointIdx)` returns a polygon → use that walkshed polygon (tag it `properties.walkshed = true`); otherwise `turf.circle(coords, miles, { units:"miles", steps:64 })`.
  - **Polygons:** pass the drawn polygon through **unbuffered**.
  - Skip features with `properties.hidden`, and skip any whose buffer build returns null.

**index.html:** add `<script src="js/core/module-buffers.js"></script>` in the core block, after `service-assembly.js` (`index.html:376`) and before `js/app.js`.

**Verify:** open `index.html`; no console errors; in the console `App.buildAnalysisBufferSet({routeIndices:[0]}, 0.5)` returns a set with one polygon after drawing a route. Nothing else changes yet.

### Step 2 — Thread an optional buffer source through the scoring engine

**File:** `js/projects/ridership-scoring.js`. **All additions are optional trailing parameters — existing call sites keep working unchanged.**

- `buildUnionFromFeatures(featureFilter, bufferSet)` (`:78`) — when `bufferSet` is passed, read `bufferSet.get("route"|"line", idx)` instead of `App.routeBuffers`/`App.lineBuffers`.
- `computePerRouteCDI(tpiResult, featureFilter, bufferSet)` (`:193`) — same substitution in the two feature-collection loops (`:198-224`). When `bufferSet` is absent, behavior is byte-for-byte what it is today.
- `computeSegments(tpiResult, segmentMiles, selectedCorridor, segBufferMiles)` (`:401`) — replace the hardcoded `0.5` at `:449` with `(segBufferMiles > 0 ? segBufferMiles : 0.5)`. **This is a latent inconsistency fix:** segment buffers ignore the global radius today.
- `computeSystemDemand(options)` (`:330`) — accept `options.bufferSet` and forward it to `computePerRouteCDI` (`:349`).
- `computeCorridorDemand(options)` (`:111`) — accept `options.segmentBufferMiles` and forward to its `computeSegments` call (`:136`).

**Verify:** `node test/run-golden.mjs` → still 89/89. Open the app and run TPI / RF / CS once each — results identical to before (nothing passes the new parameters yet).

### Step 3 — Corridor Scoring (simplest consumer)

**Files:** `projects/corridor-scoring-popup.html`, `js/projects/corridor-scoring.js`.

1. **Popup:** add after the apportion toggle (`corridor-scoring-popup.html:56-59`), before the "Corridors to score" section title:
   ```html
   <label class="tiny" style="margin-top:10px;">Buffer distance (mi)</label>
   <input type="number" id="csBufferMiles" class="rf-select" value="0.5" min="0.05" max="5" step="0.05">
   <p class="tiny" style="color:var(--muted);margin-top:2px;">Analysis distance only — map buffers still follow Feature Settings.</p>
   ```
2. **JS:**
   - Module state `var _bufferMiles = App.ANALYSIS_BUFFER_DEFAULT_MILES;`
   - `getFeatureFilter()` (`:83-103`): **delete the `allChecked` / `return null` convention** — always return explicit `{ routeIndices, lineIndices }` arrays (same rule as Transit Coverage). Update `buildUnionFromFilter`'s callers accordingly.
   - Replace `buildUnionFromFilter` (`:33-70`) with a call to `App.buildAnalysisBufferSet(filter, _bufferMiles)`; keep the function name, return `set.union`, and stash the set for the run.
   - **Delete `hasBufferIssue` (`:72-81`) and its call site (`:729-731`).** Replace with: if the built set has `count === 0`, `throw new Error("Could not build buffers for the selected corridors.")`.
   - Pass `bufferSet` into `RM.computeSystemDemand({ ..., bufferSet: set })` (`:739-748`).
   - Wire `#csBufferMiles` `change` → `markStale` in `init` (`:800-805` pattern), and read it in `runScoring` via `App.readAnalysisBufferMiles("csBufferMiles", App.ANALYSIS_BUFFER_DEFAULT_MILES)`.
   - Store `bufferMiles` on `_lastResult`; add it to `_buildMetadata()` (`:337-347`) so CSV/GeoJSON exports record it.
   - Persistence (`saveCsState` `:967`, `restoreCsState` `:1019`): add `bufferMiles`, defaulting to `App.ANALYSIS_BUFFER_DEFAULT_MILES` when absent. **No schema version bump** (graceful-default precedent).

**Verify:** draw 2 routes; score at 0.5 and again at 1.5 — scores/geography counts change; CSV metadata shows the distance; changing the input shows the stale banner; reload restores the value.

### Step 4 — Transit Propensity

**Files:** `projects/transit-propensity-popup.html`, `js/projects/transit-propensity.js`.

Same shape as Step 3, plus the two type-specific behaviors:

1. **Popup:** same input block (id `#tpiBufferMiles`) after the apportion toggle (`transit-propensity-popup.html:56-59`), before the "TPI Features" section (`:61`).
2. **JS:**
   - `buildUnionFromFilter` (`:42-80`) → `App.buildAnalysisBufferSet(filter, _bufferMiles)`; **keep the four feature types** (route/line/point/polygon). The helper already applies the walkshed and unbuffered-polygon rules.
   - `getFeatureFilter()` (`:94`) — explicit arrays, no "null means all".
   - `getGeosInCorridor(result, corridor)` (`:232-246`) — take the single feature's polygon from the run's buffer set (`set.get(type, idx)`) instead of `App.routeBuffers`/`App.lineBuffers`/`App.buffers`/`App.polygons`. Store the set on `_lastResult` so the corridor dropdown can re-filter without a re-run.
   - **Delete `hasBufferIssue` (`:83`) and its call site (`:579`)**; replace with the `count === 0` throw.
   - Note: TPI calls `TPI.computeTPI({ unionPolygon })` directly (no per-route CDI), so **no `bufferSet` plumbing is needed here** — only the union and the corridor filter.
   - Stale wiring, exports metadata, and persistence (`saveTpiState` `:1141`, `restoreTpiState` `:1167`) exactly as Step 3.

**Verify:** draw a route + a point + a polygon, select all three, analyze at 0.25 vs 1.0 — geography count changes. Flag the point as Walkshed (with a road network loaded) and confirm its walkshed area is used regardless of the module distance. Confirm the polygon's own shape is used, never buffered.

### Step 5 — Ridership Forecasting (most complex consumer)

**Files:** `projects/ridership-forecasting-popup.html`, `js/projects/ridership-forecasting.js`.

One module-wide distance, even though RF has two feature checklists (calibration + demand) and several run paths.

1. **Popup:** add the input to the Calibrate tab's Step 1 settings block (near the geography/year selectors, above `#rfCalibFeatureList` at `:58`), id `#rfBufferMiles`. In the Demand tab's target-system section (near `:236`), add a muted read-only note `#rfDemandBufferNote` ("Analysis buffer: 0.5 mi — set on the Calibrate tab") refreshed whenever the value changes or the tab is shown.
2. **JS:**
   - Module state `_bufferMiles`, read via `App.readAnalysisBufferMiles`, `change` → `markStale`/`_calibStale`/`_demandStale` as appropriate.
   - Build a buffer set for whichever filter a given run path uses, and pass it as both `unionPolygon` (`set.union`) and `bufferSet` to `RM.computeSystemDemand` in **all three demand paths**: same-system, shared-pool (`runSharedPoolAnalysis`), and separate-pool — plus the calibration run at `:1286`.
   - `RM.computeSegments` call at `:565` — pass `_bufferMiles` as the new 4th argument so segment buffers match the module distance.
   - **Delete `hasBufferIssue` (`:1004-1013`) and both call sites (`:494`, `:1286`)**; replace with the `count === 0` throw.
   - Per-route GeoJSON export (`:2560-2572`) — take geometry from the run's stored buffer set, falling back to the feature's own geometry as it does today.
   - Add `bufferMiles` to `_buildMetadata()`, to the calibration JSON export/import (default 0.5 when absent on import), and to `collect`/`apply` (`:3545`) — graceful default, **no schema version bump**.

**Verify:** run the 3-step calibration and a demand analysis at two different distances and confirm per-route CDI values move; confirm the Demand tab note tracks the Calibrate input; confirm segment overlay density changes with the distance; export CSV/GeoJSON/JSON and confirm the distance is recorded; reload and confirm restore.

### Step 6 — Converge Transit Coverage onto the shared helper

**Files:** `js/projects/transit-coverage.js`, `projects/transit-coverage-popup.html`.

- Delete the private `foldUnion` (`:346-354`) and `buildPrivateBuffer` (`:355-358`); call `App.foldAnalysisUnion` / `App.buildAnalysisBuffer` instead. `buildCoverageUnions`, `clipToServiceArea`, and `buildServiceAreaUnion` keep their names and behavior — only the two primitives change.
- Change the default from `0.25` to the shared constant: `transit-coverage-popup.html:31` `value="0.25"` → `value="0.5"`, and the module's fallbacks (`:495`, `:939`, `:1008`) → `App.ANALYSIS_BUFFER_DEFAULT_MILES`. Use `App.readAnalysisBufferMiles` for the read + validation at `:495-499`.
- Restored sessions that persisted `0.25` keep `0.25` — only the *default for a fresh session* moves.

**Verify:** re-run the Transit Coverage smoke test — the coverage fill, threshold fill, service-area outline, table, sentence, and exports all behave as before; a fresh session's input reads 0.5.

### Step 7 — Golden tests + documentation (final)

**Files:** create `test/cases/module-buffers.mjs`, edit `CLAUDE.md`.

1. Golden cases for `App.readAnalysisBufferMiles` (the only new pure helper — the buffer builders use turf and are out of harness scope by design):
   ```js
   export default { scripts: ["js/core/module-buffers.js"], cases: [ ... ] };
   ```
   Cover: a valid value; below MIN; above MAX; non-numeric/blank → fallback; missing element → fallback; explicit fallback argument honored. The harness's stub `window` has no DOM, so pass a plain `{ value: "..." }` object rather than an element id — **write `readAnalysisBufferMiles` to accept either an id string, an element, or any object with a `.value`**, so it is testable without a DOM.
2. Seed with `node test/run-golden.mjs --update`, review the diff, then confirm `node test/run-golden.mjs` → `PASS — N/N`.
3. **CLAUDE.md:** (a) File Structure — add `js/core/module-buffers.js`; (b) Script Load Order — add it to the core list before `app.js`; (c) App Namespace — a short `### module-buffers.js` section documenting the constants and four functions, including the walkshed and unbuffered-polygon rules; (d) update the TPI / RF / CS / Transit Coverage module entries to mention the module-owned buffer distance, and Transit Coverage's new 0.5 default; (e) Testing "Covered engines" — add Module Buffers.
4. Final commit message ends with `Verified: node test/run-golden.mjs → N/N`.

---

## Risks / edge cases (handle as specified, do not improvise)

- **The map still draws the global buffers.** After this change the on-map buffer rings can differ from the distance an analysis actually used. That is why every module's input carries the muted "Analysis distance only — map buffers still follow Feature Settings" note. Do **not** try to sync the two or redraw map buffers from a module.
- **`turf.buffer` / `turf.union` failures** → try/catch, skip that polygon (existing app behavior).
- **Zero usable buffers** after filtering → explicit thrown `Error`, surfaced in the module's status pill. Never a silent empty result.
- **Walkshed without a loaded road network** → `App.getPointWalkshed` returns null → the point falls back to a circular buffer at the module distance. Not an error.
- **Hidden features** (`properties.hidden`) are skipped, matching `rebuildBuffers`.
- **Large distances** are clamped to 5 mi by `readAnalysisBufferMiles`; the Census fetch cost scales with area, so do not raise the cap.
- **Restored sessions** predating this change have no `bufferMiles` → default 0.5 → identical results to before the update.
- **RF's shared-pool path** must use one buffer set built from the *combined* filter, not two separately-built sets, or the normalization pool geometry will not match the partitioned per-route results.

## Do-not-do notes (binding for the implementing model)

- Do NOT read or mutate `App.routeBuffers` / `App.lineBuffers` / `App.buffers` from the four analysis modules, and do NOT call `rebuildRouteBuffers` / `rebuildLineBuffers` / `rebuildBuffers` / `refreshBuffers` from them. Module buffers only.
- Do NOT change the Feature Settings global radius UI, its defaults, or `points.js` / `lines.js` / `routes.js` buffer rebuilding. Those still drive what is drawn on the map.
- Do NOT apply the module distance to polygons (already areas) or to walkshed-flagged points that have a cached walkshed.
- Do NOT honor `properties._bufferRadius` in module buffers — the module distance is uniform by design.
- Do NOT keep the "null means all selected" filter convention in any module touched here; always explicit index arrays.
- Do NOT change `TPI.computeTPI`'s signature — it already accepts `unionPolygon`.
- Do NOT make the new engine parameters required; every one is an optional trailing argument so untouched callers behave identically.
- Do NOT change Title VI, FTA, Buffer-Area Summary, or Walkshed in this work — they keep using the shared/global buffers.
- Do NOT hand-edit `test/golden/*.json` — only `--update`, never to paper over an unintended change.
- Do NOT add npm packages, build steps, or ES modules to app code — plain IIFE `<script>` only.

## Verification (end-to-end)

1. `node test/run-golden.mjs` → PASS, including the new `module-buffers` cases and all six pre-existing case files unchanged at their current counts (89 before the new file is added).
2. Browser smoke test per module: draw a route + line (+ point + polygon for TPI), run each of TPI / RF / CS at two clearly different distances, and confirm the geography counts and scores move; confirm the stale banner and its Re-run; confirm CSV/GeoJSON metadata records the distance; reload and confirm settings restore.
3. Confirm the Feature Settings radius no longer affects TPI / RF / CS / Transit Coverage results (change it, re-run, results unchanged), while still redrawing the map buffers.
4. Re-run the Transit Coverage checks from `docs/transit-coverage-plan.md` after Step 6.

## Handoff: implementing with cheaper models

Start a **new Claude Code session** on `caseywalrath/micro-analysis-tool` based on this branch, select **Sonnet 5**, and prompt:

> *"Implement docs/module-buffer-distance-plan.md exactly. Work through Steps 1–7 in order, committing after each step with a descriptive message. The 'Do-not-do notes' are binding. Finish with `node test/run-golden.mjs` and include the Verified line in the final commit."*

Steps 1, 2, and 6 are small and safe; Step 5 (Ridership Forecasting) is the one to review most carefully, since it has three run paths that each need the buffer set. The browser smoke tests need a human — pull the branch, open `index.html`, and walk the per-step Verify lists.
