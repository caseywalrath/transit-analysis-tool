# Removable analysis layers — implementation plan

> **Status:** Complete (Phases 1–7). Deviations: Clear results sits in the collapsible Inputs; Sidewalk coverage returns on the next network load (no Add Data toggle exists); `clearCensusOverlay` now removes its layers; area-matched restore also edits walkshed.js and transit-travelshed.js.

Lets the user remove any module-generated layer from the Layers panel, as they can already
remove reference layers. On the way it fixes the toolbar **Clear** bug, gives every module a working
clear path, and separates "remove from the map" from "delete downloaded street data".

**Read this whole document before starting any phase.** Each phase must leave the app fully
working. Do not start a phase before its predecessors are merged into the working branch and verified.

---

## How this plan is executed

- **Orchestrator (Opus):** reads this plan, confirms the open decisions (§ Decisions) with the
  user before the phases that depend on them, launches one agent per task, reviews every diff before
  it is committed, runs the full test suite between phases, and owns the final docs pass.
- **Sonnet agents** get the tasks marked **[Sonnet]**. Each such task is written so an agent can
  complete it without design judgment. Pass the agent the task section verbatim plus the
  § Global rules section. If a Sonnet agent reports that reality differs from the task (a line
  number moved, a function is missing, a test fails for an unrelated reason), it must **stop and
  report**, not improvise. The orchestrator then decides.
- **Opus agents** (or the orchestrator itself) take tasks marked **[Opus]**. These involve
  cross-module state, persistence or cache behavior where a wrong guess silently corrupts results.
- Tasks inside one phase marked *(parallel)* touch disjoint files and may run concurrently.
  Everything else runs in order.
- Line numbers are from the commit that added this plan. **Always locate code by the quoted
  snippet or function name; treat line numbers as hints.**

---

## Background (context for every agent)

Plain front-end app, no build step. Everything shared lives on `window.App`. Each file is an
IIFE. Read `CLAUDE.md` first.

Facts established by investigation:

1. **Toolbar Clear crashes.** `js/app.js` ~1162-1163 does
   `document.getElementById("nGeos").textContent = "0";` and
   `document.getElementById("summaryStatus").style.display = "none";`. Neither element exists
   anywhere, so the handler throws. `clearModules()`, `notifyProject()` and `App.cache.save()` never
   run. Module outputs stay on screen until a reload, where they vanish only because the light
   autosave leaves out their geometry.
2. **Module clear hooks.** `App.registerModule` stores configs in a private `_modules` Map
   (`js/app.js` ~18-20). The only caller of `config.clear` is the private `clearModules()`
   (`js/app.js` ~268-274), which clears *every* module. It is used by Clear and Reset Session.
3. **Modules without `clear`:** `title-vi` (it has a private `clearOverlay()` ~1028 plus results in
   `_results`), `fta-small-starts` (private `removeLbarLayer()` ~93, `_lastRatings`), and
   `attribute-summary` (no layers, so none is needed).
4. **Layers panel.** `js/core/layers-panel.js` has static arrays `REFERENCE` (~50-71) and `ANALYSIS`
   (~72-106). The row ⋯ menu offers "Remove layer" only when an entry has a `clear` function
   (~760-766). No `ANALYSIS` entry has one. That Remove action skips `notifyProject`,
   `cache.save` and `undo.push`.
5. **Walkshed outputs leak downstream.** "Use as study areas" sets
   `attributes.serviceAreaType = "walkshed"` on points. `js/core/points.js` `rebuildBuffers()`
   (~129-142) then copies walkshed geometry into `App.buffers`, which many modules read.
   `walkshed.js` `clearAll()` (~1086-1100) does not call `App.refreshBuffers()` or
   `App.notifyProject()`, so stale walkshed shapes stay in buffers. Stale detection
   (`App.featureGeomSignature`, `js/core/analysis-checklist.js` ~79-90) does not include walkshed
   results, so re-running Walkshed does not mark dependent modules stale.
6. **Street network.**
   - One Overpass download yields streets, sidewalks, crossings and paths in one graph.
   - "Sidewalk coverage" (`js/core/walk-audit.js`) is only a colored view of that data.
   - Both the "Walk network" and "Sidewalk coverage" rows' Remove call `App.clearRoadNetwork()`
     (`js/core/road-network.js` ~890-906). That call also wipes the IndexedDB cache
     (`js/core/network-store.js`), with no confirmation.
   - Startup restore picks the newest cached network, not the one for the current area.
   - Excluded streets survive Reset Session.

---

## Global rules — apply to every task

- **Scope:** change only the files the task names. If another file seems to need a change,
  stop and report.
- **Style:** match surrounding code (ES5-style `var`, `function`, `typeof App.x === "function"`
  guards). Comments explain *why*, never plan history ("Phase 2 added…").
- **User-facing text:** plain nouns, no internal terms. "Remove layer", "Clear results",
  "Delete downloaded streets". Never "module", "epoch", "cache", "phase", "legacy".
- **No new globals** except those a task explicitly names. Module state stays in its closure.
- **Tests** (from `CLAUDE.md` § Testing):
  - Browser tests: `bash test/browser/run-browser.sh`, or one file with
    `NODE_PATH=/opt/node-tools/node_modules node test/browser/<file>.test.mjs`. A clean run ends
    `PASS — n/n checks passed`.
  - New browser tests reuse `test/browser/harness.mjs` and poll observable state (no fixed sleeps).
    Use `test/browser/walkshed-flatten.test.mjs` and `test/browser/street-exclusion.test.mjs` as
    templates. Both stub the road network without network access.
  - Run `node test/run-golden.mjs` only if a task touches math (none should).
  - Run screenshots (`node test/ui-screens/capture.mjs`) after markup or CSS changes, and inspect the images.
- **Commits:** one commit per task, with the message ending in a `Verified:` line listing each
  test command and its result. Sonnet agents do **not** push; the orchestrator pushes after review.
- **Docs:** update the matching `docs/reference/` file in the same commit when behavior changes
  (the task names it). Run `node test/doc-coverage.mjs` when adding any public `App.*` name.

---

## Decisions (orchestrator confirms with the user before the dependent phase)

Recommended defaults are shown. Proceed with a default only if the user accepts it.

| # | Question | Recommended default | Needed by |
|---|---|---|---|
| D1 | Does "Remove layer" on an analysis row ask for confirmation? | **No confirm. It is undoable via `App.undo.push()`**, and the status bar says "Removed <label> — Undo to restore". | Phase 4 |
| D2 | When walkshed results are cleared, what happens to points flagged "Use as study areas"? | **Keep the flag. Their buffers fall back to circles until Walkshed is recalculated.** Other modules go stale. (Clearing the flag would silently undo a user choice.) | Phase 3 |
| D3 | Does removing "Walkshed" also remove "Walkshed — reachable streets"? | **Yes.** Removing reachable streets alone leaves the polygons. | Phase 4 |
| D4 | Does removing "Census geographies" also clear Feature Area Analysis results? | **Yes.** It is that module's map output; partial removal would leave a legend with no map. | Phase 4 |
| D5 | Does "Remove" on the Walk network row delete the downloaded copy? | **No.** It removes it from the map and analysis and keeps the stored copy. A separate "Delete downloaded streets" action deletes it. Reset Session also deletes it. | Phase 5 |
| D6 | Does "Remove" on Sidewalk coverage touch the network? | **No.** It only removes the overlay, which comes back when the user turns it on again from Add Data. | Phase 5 |
| D7 | Does Reset Session clear excluded streets and crossing-penalty settings? | **Yes**, back to defaults. | Phase 5 |

---

## Phase 1 — Fix the toolbar Clear crash [Sonnet]

**Goal:** the toolbar Clear button runs to completion and clears all module outputs.

**File:** `js/app.js`.

**Steps:**
1. In the `document.getElementById("clear").addEventListener("click", …)` handler (~1148),
   delete these two lines and nothing else:
   ```js
   document.getElementById("nGeos").textContent = "0";
   document.getElementById("summaryStatus").style.display = "none";
   ```
2. Grep the repo (excluding `test/`) for `nGeos` and `summaryStatus`. Expect zero matches.
   Report if any remain.

**New test:** `test/browser/clear-all.test.mjs`. It should:
- Load the app with a stubbed road network (copy the stub setup from
  `test/browser/walkshed-flatten.test.mjs`), add one point, run Walkshed so `walkshed-fill`
  exists, then click `#clear` with `page.on("dialog", d => d.accept())`.
- Check that no page error was thrown (collect `page.on("pageerror")`).
- Check that `map.getLayer("walkshed-fill")`, `"walkshed-line"` and `"walkshed-seg"` are all
  undefined.
- Check that `#ws-legend` (or the walkshed legend element the module uses — find it in
  `walkshed.js`) is hidden.

**Verify:** the new test passes, and the full browser suite passes.

---

## Phase 2 — Every module with map output gets a `clear` hook *(parallel)* [Sonnet]

Two independent tasks. They run in parallel because they touch different files.

### 2a. Title VI — `js/projects/title-vi.js`

1. Read `clearOverlay()` (~1028-1037) and find every closure variable holding results, starting
   with `_results`. Also find the stale flag and the legend element. Search for `markStale`,
   `_stale`, `legend`.
2. Add a function `clearAll()` next to `clearOverlay()`. It must:
   - call `clearOverlay()`;
   - reset the result variables to their initial values (copy the initializer from their
     declarations);
   - reset the stale flag;
   - hide the module legend if it has one;
   - re-render the popup body if `App.popup.isOpen("title-vi")` (or the equivalent check used
     elsewhere in this file), using the same function the module calls after a run, so it shows
     its empty state.
3. Do **not** reset scenarios or user inputs, only computed results.
4. Add `clear: clearAll` to the `App.registerModule({...})` config (~1728).

### 2b. FTA Small Starts — `js/projects/fta-small-starts.js`

1. Read `removeLbarLayer()` (~93) and the registration (~952-964).
2. Add `clearAll()`. It must:
   - call `removeLbarLayer()`;
   - reset `_lastRatings` to its initial value;
   - reset any stale flag;
   - re-render the popup if it is open.
3. Leave uploaded site data (`LBAR_SITES`, `CRE_MAP`, `ESS_POINTS`) intact, since it is input data,
   not results. Then make sure `update()` → `refreshLbarLayerVisibility()` does not re-add the
   layer just because the data exists. If it would, add a closure flag `_lbarCleared` that
   `clearAll()` sets and the next run clears. Report what you chose.
4. Add `clear: clearAll` to the registration.

**Test (both):** extend `test/browser/clear-all.test.mjs` only if the module can be driven without
network access. Otherwise call the hook through `App.clearModule` once Phase 4 exists. For now,
verify by calling `App.cache.reset` paths manually in a browser test and checking the layer ids
(`tvi-impacted-fill`, `tvi-gain-fill`, `lbar-sites-layer`) are gone. If neither module can be run
offline, write the check as "inject a dummy source/layer with that id, call Reset Session,
assert it is removed", which proves the hook is wired.

**Docs:** `docs/reference/modules/title-vi.md` and `docs/reference/modules/fta-small-starts.md`.
Add one sentence saying Clear and Reset Session remove the map output and results.

---

## Phase 3 — Walkshed clearing reaches downstream modules

### 3a. Walkshed clear path [Sonnet]

**Files:** `js/projects/walkshed.js`, `projects/walkshed-popup.html`, `docs/reference/modules/walkshed.md`.

1. In `clearAll()` (~1086-1100), after the existing body, add:
   ```js
   if (typeof App.refreshBuffers === "function") App.refreshBuffers();
   if (typeof App.notifyProject === "function") App.notifyProject();
   ```
   Then check `update()` (~1103-1112): `notifyProject` calls every module's `update`, including
   walkshed's own. Confirm this cannot loop: `clearAll` → `notifyProject` → walkshed `update` →
   `clearAll`. If it can, guard with a closure flag `_clearing`. Report which.
2. Confirm `getPointWalkshed` returns null once `_walkshedCache` is empty, so `rebuildBuffers`
   falls back to circles (decision D2). Do **not** remove the `serviceAreaType` flag.
3. Add a **Clear results** button to the popup, next to Calculate, in the
   `.module-input-actions` area. Use `class="rf-btn-sm"`, `id="wsClearResults"`, and keep it
   disabled when there are no results. Wire it in `init` to `clearAll()` preceded by
   `App.undo.push()` (guarded with `if (App.undo && !App.undo.isRestoring())`).
4. Update the enabled state wherever results are set or cleared. Find where `_lastEntries` is
   assigned.
5. Run the screenshots and inspect the Walkshed popup image.

**Test:** add to `test/browser/walkshed-flatten.test.mjs`:
- After a run with a point flagged as a walkshed study area, clicking `#wsClearResults` removes all
  three walkshed layers.
- The point's buffer in `App.buffers` is now a circle. Check that the polygon vertex count equals
  turf's default circle steps + 1, or compare against `turf.circle` at the point's radius.

### 3b. Walkshed results in stale detection [Opus]

**Why Opus:** this changes the input signature of every module's stale check. A mistake
causes either false "stale" banners everywhere or missed ones.

**Files:** `js/core/analysis-checklist.js` (`featureGeomSignature`, ~79-90),
`js/projects/walkshed.js`, `js/projects/buffer-summary.js` (`featureGeomSig` ~196-206), and
whichever of `transit-propensity.js`, `transit-coverage.js`, `ridership-forecasting.js` build
`runInputsSig` from it.

1. Expose from walkshed.js `App.walkshedSignature()`. It returns a short string that changes
   whenever any flagged point's walkshed geometry would change: the network epoch, each flagged
   point's settings key (`settingsKey` in walkshed.js), and whether a result exists for it.
2. Fold it into `featureGeomSignature` and into BAS `featureGeomSig` **only when at least one
   point has `serviceAreaType === "walkshed"`**, so sessions without walksheds produce identical
   signatures to today. Saved sessions must not all turn stale on load.
3. Fix the comment at `walkshed.js` ~836-838 that overstates current behavior.
4. Tests:
   - Re-running Walkshed with a different budget marks Feature Area Analysis stale (stub a result
     state if a full run is impractical).
   - A session without walkshed points has an unchanged signature before and after a walkshed run
     on an unflagged point.
   - `hidden-features.test.mjs` still passes.

---

## Phase 4 — "Remove layer" on every analysis row

### 4a. Shared removal path [Opus]

**Why Opus:** it defines the API every later task uses and must get undo, save, notify and
re-render ordering right.

**Files:** `js/app.js`, `js/core/layers-panel.js`, `docs/reference/core-app.md`,
`docs/reference/layers-and-styling.md`, `CLAUDE.md` (only if a new public name must be listed).

1. In `app.js`, export `App.clearModule(id)`. It looks up `_modules.get(id)`, returns false if
   the module or its `clear` is missing, otherwise calls `clear()` and returns true.
2. In `layers-panel.js`, add one private `removeEntry(entry)` used by **both** bands. It runs:
   1. undo push (D1, guarded as in `app.js` Clear);
   2. `entry.clear()`;
   3. `App.notifyProject()`;
   4. `App.cache.save()`;
   5. `App.updateAddDataClearIcons()`;
   6. `render()`;
   7. `App.setStatus("Removed " + entry.label)`.

   Replace the inline Remove action (~760-766) with it. This also fixes reference-row removal,
   which skips save and notify today. Also fold in the muni-boundaries state fix noted at
   `app.js` ~1431-1436: Remove on that row must reset the same flag Add Data's × resets.
3. Give `ANALYSIS` entries a `clear`. The default is
   `function () { App.clearModule(entry.moduleId); }` for any entry with `moduleId`. Exceptions
   follow D3/D4:
   - `walkshed-seg`: needs a walkshed-only function (4b).
   - `census-geos-fill`: `App.clearModule("buffer-summary")`, which already clears the census overlay.
4. Remove only when a hook exists. Rows whose module returns false from `clearModule` must
   not show "Remove layer" (keep the existing `typeof entry.clear` check, but make `clear`
   conditional on the module having a hook at build time).
5. Undo check: confirm that undoing a removal brings the results back where the module persists
   them in light mode (Corridor Scoring does; Walkshed/TPI/RF do not). Where it cannot, show the
   status message "Removed <label>" with no "Undo to restore" claim. Report the per-module
   outcome in a table in the commit message.

**Test:** `test/browser/layer-remove.test.mjs`:
- Removing a reference row (OSM POIs stub, or the walk network stub) calls save. Spy on
  `App.cache.save` and check it is called.
- After 4b, removing the Walkshed row removes all walkshed layers and the legend.
- Removing the Walkshed row with a flagged point reverts that point's buffer to a circle.

### 4b. Per-row wiring and the walkshed street-only clear [Sonnet]

Runs after 4a is committed.

1. In `walkshed.js`, add and export `App.clearWalkshedStreets()`. It removes layer `walkshed-seg`
   and source `walkshed-seg-src` only (copy the guarded remove pattern from
   `clearWalkshedLayers()` ~542-547), then refreshes the legend so "Reachable streets" hides.
   Do not touch `_lastEntries`. A re-run recreates the layer hidden, as today.
2. In `layers-panel.js`, set the `walkshed-seg` entry's `clear` to that function, and leave the
   `walkshed-fill` entry on `App.clearModule("walkshed")`.
3. Check the remaining `ANALYSIS` entries against the table below. Each must show "Remove layer"
   and, after removal, have no layer ids left on the map and its legend hidden.

   | Entry | Expected clear |
   |---|---|
   | bas-choropleth-fill | clearModule("buffer-summary") |
   | tpi-choropleth-fill | clearModule("transit-propensity") |
   | corridor-scoring-routes-layer | clearModule("corridor-scoring") |
   | rf-choropleth-fill | clearModule("ridership-forecasting") |
   | ts-travelshed-fill | clearModule("transit-travelshed") |
   | transit-coverage-coverage-layer | clearModule("transit-coverage") |
   | walkshed-fill | clearModule("walkshed") |
   | walkshed-seg | App.clearWalkshedStreets |
   | tvi-impacted-fill | clearModule("title-vi") |
   | lbar-sites-layer | clearModule("fta-small-starts") |
   | census-geos-fill | clearModule("buffer-summary") |

4. Extend `layer-remove.test.mjs`. For each entry, inject a dummy GeoJSON source and layers with
   the entry's ids, call the row's Remove through the DOM (open the ⋯ menu, click "Remove
   layer"), and check the ids are gone. This proves the wiring without running each analysis.
   Then run `hidden-features.test.mjs` and the full suite.

**Docs:** `docs/reference/layers-and-styling.md`. Describe the Remove action for analysis rows
and what each removes.

---

## Phase 5 — Street network: remove vs. delete [Opus]

**Why Opus:** it changes IndexedDB cache semantics and startup restore. Bugs here lose user data or
silently restore the wrong area.

**Files:** `js/core/road-network.js`, `js/core/network-store.js`, `js/core/walk-audit.js`,
`js/core/layers-panel.js`, `js/app.js`, `js/core/cache.js`, `docs/reference/road-network.md`.

1. **Split `clearRoadNetwork`** into:
   - `App.unloadRoadNetwork()`: clears the in-memory graph, segments, layers and download area,
     and bumps the epoch. It does **not** touch IndexedDB.
   - `App.clearRoadNetwork()`: unload, then delete the stored copies. Its behavior stays the same
     for existing callers.

   Then re-point the callers:
   - Walk network row Remove → `unloadRoadNetwork` (D5).
   - Add Data × → `unloadRoadNetwork`.
   - "Clear all features" → `unloadRoadNetwork`.
   - Reset Session → `clearRoadNetwork`.
2. **Add "Delete downloaded streets"** as a second ⋯ menu item on the Walk network row. It calls
   `clearRoadNetwork` after a `confirm()`. Generalise the menu builder so an entry can declare
   extra actions; don't special-case it inline.
3. **Sidewalk coverage removal (D6):** add `App.removeSidewalkCoverageLayer()` in `walk-audit.js`.
   It removes only `sidewalk-coverage-line` and its source, and sets a closure flag so
   `refreshSidewalkCoverageLayer` does not re-create it until the user re-enables it. Find
   how it is enabled today; if there is no enable control, add the flag reset to that path and
   report. Point the row's `clear` at this function.
4. **Area-matched restore:**
   - When a walkshed or travelshed needs a network for an extent and none is loaded,
     look in `network-store` for a stored entry whose `extent` contains the required extent
     before prompting a download.
   - Add `networkStore.findCovering(extent)` in `network-store.js`.
   - Startup restore keeps its current newest-entry behavior.
5. **Reset Session (D7):** clear `App.networkSettings.excludedWayIds` via
   `App.setExcludedWays([])` and reset the crossing seconds and snap tolerance to their defaults.
   Find the defaults where `App.networkSettings` is initialised in `network-connectors.js` ~28.
6. **Fix the doc claim** at `docs/reference/road-network.md` ~49 ("confirm-gated").

**Tests:**
- Extend `test/browser/network-cache.test.mjs`:
  - unload keeps the IndexedDB entry;
  - delete removes it;
  - a walkshed run after unload restores from the stored copy without fetching (fail the test on
    any Overpass request);
  - Reset Session empties the store and the exclusions.
- Extend `street-exclusion.test.mjs`: exclusions survive unload and re-load, and Reset clears them.
- Run the full browser suite.

---

## Phase 6 — Delete drawn features from the Layers panel [Sonnet]

**Files:** `js/core/layers-panel.js`, `docs/reference/layers-and-styling.md`.

1. Find how the Features list deletes a feature (search `js/core/features.js` for `removePoint`,
   `removeLine`, `removeRoute`, `removePolygon`, `removeLabel`, `removeTextBox` and
   `onFeatureDelete`). Find the exact sequence, including the undo push and any confirm.
2. In `buildFeatureRow` (~863-981), add a **Delete** item at the bottom of the right-click menu.
   It calls that same sequence: reuse the function `features.js` uses. If that function is
   private, export it from `features.js` as `App.deleteFeature(type, index)` instead of copying
   the logic, and report that.
3. Test in a new `test/browser/layers-delete-feature.test.mjs`: draw a point programmatically,
   delete it via the Layers row menu, and check that `App.points` is shorter, the Features list
   updates, and Undo restores it.

---

## Phase 7 — Final review [Orchestrator]

1. Run every browser test, `node test/run-golden.mjs` (expected unchanged), and screenshots. Inspect
   the Walkshed popup and the Layers panel menus.
2. Run `node test/doc-coverage.mjs` and make sure every new `App.*` name is documented.
3. Do an end-to-end manual pass using the `run` skill. Draw points, run Walkshed, use them as study
   areas, run Feature Area Analysis, remove the Walkshed row, and confirm Feature Area Analysis
   shows stale. Undo. Remove the Walk network row, re-run Walkshed in the same area, and confirm no
   download prompt appears.
4. Move this plan to `docs/archive/` with a status line, per `CLAUDE.md` conventions.

---

## Out of scope (track separately)

- Persisting layer visibility, opacity and band order in the session.
- Route Costing and Trip Builder (no map layers; their in-module Clear is sufficient).
- Listing `mn-choropleth-*` in the Layers panel (dormant module).
- Making TPI's unused `#tpiClearChoropleth` button work (the fragment appears unused; delete it
  in a cleanup pass).
