# Phase 8 — Multiple analysis panels

> **Status:** Not started (verified 2026-10).
> Remaining:
> - Panel host and template (section 1): index.html still has the single `#module-popup`; no `#module-panel-host` or `module-panel-template`.
> - Panel registry in popup.js (section 2): no `isModuleOpen`, `openModuleIds` or `closeAll` anywhere in js/.
> - Per-panel focus, z-order, drag, collapse (section 3): popup.js keeps one shared shell and `currentModuleId`.
> - Migrate visibility guards (section 4): 27 `currentModuleId` references remain in js/.
> - Ownership audit, a11y/Escape behavior, multi-panel capture sequence (sections 5-7): no sign of them in js/ or test/ui-screens/capture.mjs.

**Status:** planned. Added 2026-08-13 after the Phase 6 behavior checkpoint, when
the new live-map floating panels made it useful to keep inputs and results from more
than one analysis visible for comparison.

**Goal:** allow one floating panel per analysis module to remain open at the same time.
Each panel has independent close, collapse, drag, and focus behavior. The map remains
interactive, and opening a module that is already open brings its existing panel to the
front instead of creating a duplicate.

This phase is a post-refresh feature expansion. It was not part of the original phases
0–7 and should begin only after Phase 7 finishes the shell, accessibility, documentation,
and baseline refresh.

## Scope decisions

1. **One panel instance per module.** Multiple different modules may be open; two copies
   of the same module may not. This preserves each module's closure state, singleton
   registration, and existing fixed map source/layer IDs.
2. **Panels coexist; calculation engines do not change.** This phase changes popup
   lifecycle and UI routing only. It does not change formulas, request logic, or result
   values.
3. **Existing results may coexist on the map.** Closing a panel does not clear that
   module's result layers or legend. Layer visibility and removal continue through the
   Layers panel and each module's existing controls.
4. **One global map interaction mode remains.** Drawing and one-shot map probes such as
   Transit Travelshed's origin picker still use the existing single `App.drawMode`.
   This phase does not introduce concurrent map gestures.
5. **No saved window layout in v1.** Open/closed state, z-order, collapsed state, and
   drag position reset on page reload. Persistence can be considered separately after
   the interaction model is approved.
6. **No tiling/window manager.** New panels use a small, deterministic dock-right
   cascade so earlier title bars remain reachable. Users may drag panels as needed.

## Architecture findings that shape the work

- `index.html` currently contains one `#module-popup` shell.
- `js/core/popup.js` stores one `_currentModuleId`, one drag offset, and one loaded body
  per module inside that shared shell.
- Thirteen project modules use `App.popup.currentModuleId()` in their DOM visibility
  guards. Those guards would incorrectly treat a background-but-open panel as closed.
- The 14 active popup fragments currently contain 495 IDs with **no duplicate IDs
  across fragments**. Because Phase 8 allows only one panel per module, existing
  `document.getElementById(...)` calls can remain valid. Do not mechanically rewrite the
  approximately 734 project-module lookups merely to scope them to a panel.
- Current analysis map source/layer and legend IDs are generally module-prefixed. A
  final ownership audit is still required before implementation so one module never
  removes another module's output.

## 1. Replace the singleton shell with a panel host and template

- In `index.html`, replace the live singleton `#module-popup` dialog with:
  - a click-through `#module-panel-host` that covers the app viewport; and
  - a `<template id="module-panel-template">` containing the Phase 6 dialog header,
    title, collapse button, close button, and body.
- Give every created panel:
  - `class="module-popup"`;
  - `data-module-id="..."`;
  - an accessible title relationship (`aria-labelledby` with a generated unique title
    ID); and
  - a body slot owned by that module only.
- Keep the host click-through and each dialog interactive. Do not restore a backdrop.
- Preserve in-panel modal overlays (weights, costing settings, copy attributes). They
  remain modal only within their owning panel.

## 2. Refactor `popup.js` around a panel registry

Replace the singleton fields with a registry:

```text
Map<moduleId, {
  container, dialog, body, module,
  loaded, loadingPromise,
  open, collapsed,
  offsetX, offsetY,
  zIndex
}>
```

Required public behavior:

- `open(moduleId, modules, buildCore)` creates and initializes a module panel once.
  If it is already open, bring it to front and expand it so clicking a module in the
  Analysis dropdown always reveals that module's content.
- `close(moduleId)` closes that module and calls its `onClose` once. With no argument,
  close the active/topmost panel for backward compatibility and Escape handling.
- `closeAll()` closes every open module cleanly.
- `isOpen()` with no argument means “any module panel is open.”
- `isModuleOpen(moduleId)` reports the requested module's actual open state.
- `activeModuleId()` returns the topmost/focused panel.
- Keep `currentModuleId()` temporarily as an alias of `activeModuleId()` for external
  compatibility, but do not use it for module visibility guards after this phase.
- `openModuleIds()` returns open modules in back-to-front order for testing and future
  shell UI.

Loading must remain race-safe: repeated clicks while a fragment is being fetched share
one `loadingPromise`, `init()` runs once, and closing during load must not reopen the
panel when the fetch completes.

## 3. Independent focus, z-order, dragging, and collapse

- Raise a panel on pointer-down anywhere inside it and on keyboard focus (`focusin`).
- Maintain bounded panel z-indexes below app-level confirmation UI but above map
  overlays and floating legends. Renormalize z-order if the counter grows indefinitely.
- Store drag state per panel. Dragging one panel must never move another.
- Clamp dragging so at least the complete title bar and both header buttons remain
  reachable after viewport changes.
- New panels begin expanded and use a small dock-right cascade. Wrap the cascade before
  a title bar would leave the viewport.
- Collapse/expand affects only the selected panel and preserves that panel's position.
- Reopening a closed panel resets it to the current default cascade position, matching
  Phase 6's existing reopen-reset behavior.

## 4. Migrate module visibility guards

- Replace each project module's pattern:

  ```js
  App.popup.isOpen() && App.popup.currentModuleId() === "module-id"
  ```

  with:

  ```js
  App.popup.isModuleOpen("module-id")
  ```

- Audit all registered modules, including system modules such as Attribute Summary and
  Display Settings and dormant Mitigation Needs code.
- Keep `notifyProject()` sequential. Every open module must continue receiving its
  existing `update(core)` call and must be allowed to refresh its own DOM even when a
  different panel is topmost.
- Opening an already-open module from the Analysis dropdown or Layers panel must focus
  the existing panel without rerunning `init()` or duplicating event listeners.
- Preserve each module's current `onOpen`/`onClose` semantics. Focus changes alone must
  not call either lifecycle hook.

## 5. Map output and interaction ownership audit

Before changing behavior, inventory every module's:

- MapLibre source IDs, layer IDs, event handlers, markers, and floating widget IDs.
- `clear*()` paths and `onClose()` behavior.
- global DOM overlays and tooltips.
- asynchronous run/cancel state.

Acceptance policy:

- Different modules' source/layer/widget IDs must remain unique.
- A module may update or remove only the map assets it owns.
- Closing a panel leaves completed results visible, matching current behavior.
- Clear and Reset Session still clear all module results through the existing module
  registry.
- Simultaneous visible overlays are controlled through the Layers panel. This phase does
  not add blending, comparison sliders, or automatic conflict resolution.
- Transit Travelshed origin picking keeps every open panel visible. Setting or cancelling
  the origin updates only the Travelshed panel.
- If the audit finds a genuinely shared map asset, assign explicit ownership or serialize
  that asset; do not duplicate calculations to work around it.

## 6. Keyboard and accessibility behavior

- Escape closes only the active/topmost panel. Repeated Escape presses close panels from
  front to back.
- The close and collapse buttons retain Phase 7 focus treatment, labels, titles, and
  expanded state.
- A panel raised through keyboard focus becomes the active panel.
- Draw-tool shortcut suppression remains active while **any** module panel is open.
- Do not trap focus inside non-modal panels. Tab navigation may move between the toolbar,
  map controls, feature panel, and open analysis panels.
- When the active panel closes, focus the next topmost panel; if none remains, return
  focus to the module-opening control when practical.

## 7. Screenshot harness and automated checks

Extend `test/ui-screens/capture.mjs` with a Phase 8 sequence in both themes:

1. Open Transit Coverage.
2. Open Transit Travelshed without closing Transit Coverage.
3. Confirm two different module panels are visible and IDs remain unique.
4. Drag and collapse one; confirm the other is unchanged.
5. Focus the rear panel; confirm z-order changes.
6. Reopen an already-open module; confirm there are still exactly two panels and the
   requested panel is expanded and topmost.
7. Press Escape twice; confirm front-to-back closure.

Add lightweight popup-manager tests if the repository has an appropriate DOM test
harness by Phase 8. Otherwise, keep the browser assertions in the screenshot harness;
do not add a framework or build step only for this phase.

## Behavior audit

Test at minimum:

- Transit Coverage + Transit Travelshed: live origin picking while both remain open.
- TPI + Corridor Scoring: two result overlays, legends, and hover handlers coexist.
- Route Costing + Trip Builder: dense wide panels remain reachable when cascaded.
- Attribute Summary + Display Settings: system modules follow the same one-instance and
  focus behavior.
- Draw a point and line with two panels open: every relevant checklist/stale state
  refreshes.
- In-panel modal overlay: it stays inside and above only its owner panel.
- 1100px viewport: every open panel retains a reachable title bar and close button.
- Light and dark modes.
- Present mode and Reset Session retain whatever behavior Phase 7 establishes.

## Out of scope

- Multiple instances of one analysis module.
- Calculation, scoring, forecasting, or geometry changes.
- Persisting panel positions or open state.
- Automatic tiling, snapping, docking zones, tabs, or a taskbar.
- Running duplicate scenarios side by side inside the same module.
- New map comparison/blending controls.
- Rewriting all project DOM access to component-scoped selectors while IDs remain unique.

## Verification

- `node test/run-golden.mjs` → pass unchanged; record the result in the commit message.
- `node test/ui-screens/capture.mjs` → all captures pass except documented skips.
- Run the multi-panel browser sequence above in both themes.
- Run `git diff --check` and JavaScript syntax checks for every changed `.js`/`.mjs` file.
- Confirm no duplicate DOM IDs after all active popup fragments have loaded.

## Checkpoint

Send the developer 3–4 representative images: two expanded panels, one collapsed/one
expanded, the 1100px viewport, and dark mode. Report any overlay conflicts found during
the ownership audit. This is a behavior checkpoint; review and continue unless told to
stop.

Commit: `UI refresh phase 8: support multiple analysis panels`
(with `Verified: node test/run-golden.mjs → N/N`)
