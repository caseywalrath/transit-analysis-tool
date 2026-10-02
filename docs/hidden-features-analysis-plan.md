# Hidden features in analysis checklists — implementation plan

Status: implemented (Phases 1-4 complete). Audience: Sonnet-level implementation agents, orchestrated by
an Opus agent that runs one phase at a time, reviews each diff, and runs the
checks listed per phase before starting the next.

## Problem

A drawn feature can be hidden on the map (`feature.properties.hidden = true`,
set from the Layers tab eye icon, the box-select group menu, or the feature
right-click menu). The shared analysis-buffer builders in
`js/core/module-buffers.js` silently skip hidden features. But every analysis
module's "features to analyze" checklist still shows hidden features as
normal, tickable rows. A selection made only of hidden features runs, builds
no buffers, and fails with "No buffers set". A mixed selection silently drops
the hidden ones.

A first, partial fix already shipped on this branch, in Feature Area Analysis
only (`js/projects/buffer-summary.js`):
- `countHiddenSelected(filter)` and a clearer error message.
- a "(hidden — skipped)" label suffix in its checklist.

This plan replaces the label suffix with the full design below and extends it
to every affected module.

## Decided design

1. **Hidden rows are grayed out and cannot be selected** by default. The
   checkbox is `disabled`, the row gets a muted style, a small "hidden" tag,
   and a tooltip: "Hidden on the map — show it in the Layers tab, or turn on
   Include hidden."
2. **An "Include hidden" toggle**, unchecked by default, sits next to each
   checklist's `Select all | Clear` links. When on, hidden rows are normal
   checkboxes (still tagged "hidden") and hidden features are analyzed.
3. **The user's choices are kept.** Disabling a row never erases its saved
   checked or unchecked state. When a feature is shown again, or the toggle
   is turned on, the row returns to the state the user last gave it. The
   disabled state is applied on top of the saved selection, never written
   into it.
4. **The run-time error message stays** as a fallback (the list can be stale,
   for example after a session restore): when the selection builds nothing
   because everything is hidden, say "Selected features are hidden — show them
   in the Layers tab, or turn on Include hidden."
5. **Results disclose hidden features.** When a run includes hidden features
   (toggle on), the results notes say "Includes N features hidden on the map."
6. **Results go stale** when a feature's hidden state changes, or the toggle
   changes, after a run (the standard `App.renderModuleState()` stale banner).
7. **The toggle is per module, saved in the session** as an additive field in
   each module's own cache payload (`includeHidden`, default `false`, absent
   on older sessions). No schema version bump.

## Facts established during design (do not re-derive)

- Hiding from the Layers tab (`js/core/layers-panel.js` ~line 800–835) and
  `App.bulkFeatures.setHidden` (`js/core/box-select.js` ~line 404) call
  `App.rerenderForType()` + `App.cache.save()` but **not**
  `App.notifyProject()`. Modules therefore never hear about visibility
  changes today. Verify the feature right-click Hide/Show path in
  `js/core/editing.js` / `js/core/features.js` the same way.
- Display buffers (`App.buffers` / `App.lineBuffers` / `App.routeBuffers`,
  rebuilt in `points.js` / `lines.js` / `routes.js`) are index-aligned with
  their feature arrays and are **left empty for hidden features**. So "Use
  Display Buffers" + "Include hidden" would silently drop hidden features
  unless handled (Phase 1, step 3).
- `buildAnalysisBufferSet` and `buildDisplayBufferSet` skip hidden features in
  both the route/line/point paths and the polygon path.

## Affected modules

In scope (all use `module-buffers.js` and a feature checklist):

| Module | File | Checklist(s) | Select all / Clear ids |
|---|---|---|---|
| Feature Area Analysis | `js/projects/buffer-summary.js` | `#basFeatureChecklist` | `basFeatureSelectAll` / `basFeatureSelectNone` |
| Transit Propensity | `js/projects/transit-propensity.js` | TPI feature checklist | `tpiSelectAll` / `tpiSelectNone` |
| Corridor Scoring | `js/projects/corridor-scoring.js` | `#csFeatureList` | `csSelectAll` / `csSelectNone` |
| Transit Coverage | `js/projects/transit-coverage.js` | `#tcFeatureList` and `#tcAreaList` (one toggle covering both) | `tcFeatSelectAll`/`None`, `tcAreaSelectAll`/`None` |
| Ridership Forecasting | `js/projects/ridership-forecasting.js` | Calibrate and Demand checklists (one toggle per checklist) | `rfCalibSelectAll`/`None`, `rfDemandSelectAll`/`None` |

Audit only (Phase 4) — decide per module, do not change without reporting:
Title VI baseline checklist (`title-vi.js`), Walkshed point list (already
filters hidden silently, `walkshed.js` ~line 243–281), Transit Travelshed
route list (`transit-travelshed.js` ~line 296), and
`RidershipModel.buildUnionFromFeatures` in `ridership-scoring.js`.

Out of scope: Route Costing and Trip Builder (Service lists, not study
areas), the dormant Mitigation Needs module.

## Phases

Each phase is one Sonnet task and one commit. The orchestrator reviews the
diff and runs the listed checks before moving on.

### Phase 1 — Shared plumbing (core only, no module changes)

1. `js/core/module-buffers.js`: add an `opts.includeHidden` flag to
   `buildAnalysisBufferSet(filter, miles, opts)` and a new optional second
   argument `opts` to `buildDisplayBufferSet(filter, opts)`. When true, the
   `properties.hidden` skip is bypassed in every path. Default behavior is
   unchanged.
2. Both builders also return `hiddenCount` — the number of hidden features in
   the filter that were included (flag on) or skipped (flag off). Return it
   as `{ included, skipped }`.
3. `buildDisplayBufferSet` with `includeHidden`: a hidden route/line/point has
   no display buffer, so build one on the fly with the same radius the map
   would use (`properties._bufferRadius` if set, else the type default in
   `App.featureSettings.bufferRadius` / `lineBufferRadius` /
   `routeBufferRadius`; points keep the walkshed substitution via
   `App.getPointWalkshed`). Do not write it into the shared display arrays.
4. Visibility notification: make every hide/show path call
   `App.notifyProject()` after it saves (Layers tab group + feature eye,
   `App.bulkFeatures.setHidden`, the single-feature right-click Hide/Show).
   Check `App.notifyProject()`'s other side effects first (connector refresh,
   Layers panel refresh) and confirm they are safe to fire on a visibility
   change. If any is not, add a lighter hook instead and document why.
5. A shared checklist decorator, new file `js/core/analysis-checklist.js`
   (load it right after `module-buffers.js` in `index.html`, and add it to
   CLAUDE.md's file list and Script Load Order):
   - `App.decorateHiddenRow(rowEl, checkboxEl, feature, includeHidden)` —
     applies or removes `disabled`, the `.ac-hidden` row class, the "hidden"
     tag element, and the tooltip. It must never change `checkboxEl.checked`.
   - `App.buildIncludeHiddenToggle({ id, checked, onChange })` — returns a
     small inline checkbox + label ("Include hidden") meant to sit after the
     `Select all | Clear` links. Use existing shared form styles.
   - `App.hiddenSelectionMessage(hiddenCount)` — the standard error/notes
     strings from the design section, so every module words them the same.
6. CSS in `css/style.css`: `.ac-hidden` (muted text via existing tokens, no
   raw hex) and `.ac-hidden-tag`. Follow "Design tokens and colors" in
   CLAUDE.md.
7. Golden tests: `module-buffers` already has a case file
   (`test/cases/`). Extend it with `includeHidden` true/false cases for each
   feature type and the `hiddenCount` return. `node test/run-golden.mjs
   --update` only for the new cases; existing numbers must not move.

Checks: `node test/run-golden.mjs` all pass, with only new cases added.

### Phase 2 — Feature Area Analysis (reference implementation)

Convert `js/projects/buffer-summary.js` first; later phases copy its pattern.

1. Remove the "(hidden — skipped)" label suffix added earlier. Use
   `App.decorateHiddenRow` in `buildFeatureChecklist`.
2. Add the toggle next to `basFeatureSelectAll` / `basFeatureSelectNone`
   (markup in `projects/buffer-summary-popup.html` or built in `init`). Store
   it in `_state.includeHidden`, save it in the module's cache payload, and
   restore it.
3. **Selection preservation:** `getCheckedRefs()` currently reads only checked
   DOM boxes. A disabled box that is checked still counts as checked, so keep
   the checked state on disabled boxes and make `getFeatureFilter()` (the
   run-time index filter) skip disabled boxes. This way the saved selection
   keeps the user's choice and the run excludes the hidden rows.
4. "Select all" ticks only enabled boxes. "Clear" clears all boxes.
5. `update()` already rebuilds the checklist when the popup is visible. With
   Phase 1 step 4 it now also runs on hide/show. Mark results stale there when
   the hidden state of any selected feature changed since the last run
   (compare against a set of hidden refs captured at run time).
6. Pass `{ includeHidden: _state.includeHidden }` to both buffer builders.
   Replace `countHiddenSelected` with the builder's `hiddenCount`. Use
   `App.hiddenSelectionMessage` for the error and for the results-notes line.

Checks:
- `node test/run-golden.mjs`.
- New browser test `test/browser/hidden-features.test.mjs` (use
  `test/browser/harness.mjs`; the repro pattern is: load a fixture with
  `App.cache.applyState`, open the module with `App.openModulePopup`, click
  Run). Assert: a hidden row is disabled and keeps its checked state; hiding
  a feature while the popup is open grays its row without reopening;
  showing it again restores the previous state; with the toggle off a
  hidden-only selection shows the new message; with it on the run gets past
  the buffer step (the Census fetch will fail in the sandbox — assert on the
  progress/status text, not on results); the toggle survives a reload.
  TIGERweb/Census are unreachable in the sandbox, so stub them with the
  harness's `extraHandler` if a test needs a completed run.
- `test/ui-screens/capture.mjs` — inspect the Feature Area Analysis images.

### Phase 3 — Remaining in-scope modules

One sub-task per module, in this order, each copying the Phase 2 pattern:
Corridor Scoring, Transit Propensity, Transit Coverage (one toggle governs
both lists; the service-area polygons list counts too), Ridership
Forecasting (separate toggle for Calibrate and Demand; check whether
`RidershipModel.buildUnionFromFeatures` or `computePerRouteCDI` filter hidden
features on their own and make them honor the same flag).

Notes for the agent:
- TPI, Corridor Scoring and Transit Coverage store their selection as
  `_uncheckedRefs` (the features the user unchecked). A disabled-but-checked
  row must not be recorded as unchecked. Read each module's
  `captureChecklistSelection()` (or equivalent) before editing.
- Each module's cache payload gets an additive `includeHidden` field. Do not
  bump schema versions.
- Keep existing element ids and listeners; this is additive.

Checks per module: golden tests, extend `test/browser/hidden-features.test.mjs`
with that module's disabled-row, toggle and message assertions, and review
its ui-screens images.

### Phase 4 — Audit and docs

1. Audit Title VI baseline, Walkshed, Transit Travelshed: does each skip
   hidden features, and does its list show them? Report findings to the
   orchestrator; do not change these without approval.
2. Update CLAUDE.md: the new `analysis-checklist.js` entry, the
   `module-buffers.js` API (`includeHidden`, `hiddenCount`), the
   `notifyProject` on hide/show change, and each module's `includeHidden`
   cache field. Add `test/browser/hidden-features.test.mjs` to the browser
   test section.

## Orchestrator checklist

- Run phases strictly in order; Phase 2 is the template for Phase 3.
- After every phase: `node test/run-golden.mjs`, `bash test/browser/run-browser.sh`
  (with `NODE_PATH=/opt/node-tools/node_modules`), and look at the changed
  ui-screens images.
- Reject a diff that writes the disabled state into a module's saved
  selection, adds raw hex chrome colors, or changes default (toggle-off)
  results for visible features.
- Commit messages include the `Verified: node test/run-golden.mjs → N/N` line.

## Phase 4 audit findings (read-only; no code changed)

- **Title VI baseline checklist** (`title-vi.js`). The list shows hidden
  routes/lines/polygons as normal ticked rows (`populateFeatureList`, ~L120-148,
  no hidden check). At run time `buildUnionFromFilter` (~L686) reads
  `App.routeBuffers`/`lineBuffers` by index. Hidden routes/lines have no
  display buffer, so they are silently dropped; hidden polygons are used (raw
  geometry, no hidden check). Result: a hidden route in the baseline is ignored
  with no message, and a hidden-only selection gives a null union ("no
  features" style message at ~L639). Also `TitleVI.buildImpactedArea`
  `full_route_buffer` (`title-vi-engine.js` ~L475-487) unions all
  route/line display buffers, so hidden ones are silently omitted, while
  `user_polygon` (~L488) includes hidden polygons: inconsistent. Alteration
  before/after dropdowns resolve by ID and do not check hidden (a hidden route
  still computes via `computeAlterationMetrics`). Recommendation: highest
  value of the three; adopt the Phase 2 pattern (disable+tag, Include hidden,
  build via `buildAnalysisBufferSet` with `includeHidden`) for the baseline list
  and `full_route_buffer`, and make polygons consistent.
- **Walkshed point list** (`walkshed.js`). Hidden points are removed from the
  list entirely (`buildPointChecklist` ~L281) and skipped at run time
  (`getTargetPoints` ~L260-269, `ensurePointWalksheds` ~L243). Consistent, no
  silent drop of a visible selection; the only gap is that the user cannot see
  why a point is missing. If all points are hidden the list says "No points
  placed", which is misleading. Recommendation: low priority; at most change
  that empty text to mention hidden points, or show hidden points disabled+tagged.
- **Transit Travelshed route list** (`transit-travelshed.js` ~L296). The
  `hidden` check there applies only to the *stop Points* used to find real
  stops, not to the routes/lines themselves. Hidden routes/lines still appear in
  `#tsRouteList` as normal rows and are analyzed (the engine uses feature
  geometry directly, not display buffers). A hidden stop point is silently
  ignored, so the route falls back to sampled stops, changing results without
  notice. Recommendation: medium; decide whether hidden routes should be
  analyzed (currently yes, inconsistent with the other modules) and disclose or
  disable them, and stop silently dropping hidden stop points (or note
  "sampled stops used").
- `RidershipModel.buildUnionFromFeatures` was handled in Phase 3.
- Test review: the "hidden-only selection shows the hidden message" checks were
  not vacuous (the pass condition is an in-page `includes` on the status text).
  The empty text after the dash was because the status text is re-read after it
  changes; the test now captures the matched text in the same read and prints it.
