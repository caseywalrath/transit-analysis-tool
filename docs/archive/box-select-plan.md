# Box select (drag to select) — plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/drawing-and-features.md. This file is historical.


Notes from implementation:
- The tool intercepts mouse events in the capture phase instead of toggling MapLibre's `dragPan`, so there is no map state to restore.
- Single-feature deletes never removed stop links to a deleted route, and bulk delete matches that (the Phase 5 "stop loses its link" check was dropped).
- Outside the tool, Shift+drag replaces the selection (Shift is the trigger), and Ctrl still removes.
- Fixed along the way: the shared right-click menu could stay open after a fast outside click. It now closes on the next outside mouse press or Escape.

## What the user asked for

- A toolbar button with a dotted-box icon, just right of the Measure ruler.
  While it is on, clicking and dragging on the map draws a rectangle. On
  release, the features in the rectangle become the selection, exactly as if
  they had been Ctrl+clicked in the Features pane.
- Group actions that work from the map for a multi-selection: at least
  **Hide/Show** and **Delete** (not Duplicate or Attributes).
- A clear, predictable rule for which features count as "in" the rectangle.

## Decisions (recommended defaults, change before Phase 1 if wanted)

| # | Question | Decision |
|---|---|---|
| D1 | Which features count as inside? | **Touches the box** (ArcGIS Pro and QGIS default). Hold **Alt** while dragging for **fully inside**. No percentage rule — it is unpredictable for long lines and invisible to the user. |
| D2 | Modifier keys | Plain drag = **replace** the selection. **Shift**+drag = **add**. **Ctrl/Cmd**+drag = **remove**. Same as ArcGIS. |
| D3 | Tool stays on after a drag? | **Yes** (ArcGIS behavior). It turns off with Escape, a second click on the button, its shortcut key, or picking another tool. |
| D4 | Shortcut key | **`A`** ("area select"). `S`, `B`, `M` are taken. |
| D5 | Shift+drag without the tool | **Yes, Phase 4 (optional).** It replaces MapLibre's built-in Shift+drag box zoom, which this app does not advertise. Can be dropped. |
| D6 | Which feature types | Points, lines, routes, polygons. **Not** labels/text boxes (DOM markers, not part of map selection today), not buffers, not GTFS or other reference layers. **Hidden features are skipped.** |
| D7 | Which geometry is tested | The drawn shape itself, never its buffer. |
| D8 | Empty drag (nothing inside) | Plain drag clears the selection; Shift/Ctrl drags change nothing. A tiny drag (< 4 px) is treated as a click, not a box. |

### The rule in detail (D1)

The rectangle is drawn in screen pixels, so the test is done in screen pixels
too (`map.project` each vertex). This is correct at any zoom and avoids
map-projection distortion at high latitudes.

| Type | Touches (default) | Fully inside (Alt) |
|---|---|---|
| Point | dot centre inside the box | same |
| Line / route | any vertex inside **or** any segment crosses a box edge | every vertex inside |
| Polygon | any of the above on any ring, **or** the box lies entirely inside the polygon (box centre inside the outer ring and not in a hole) | every outer-ring vertex inside |

A quick bounding-box check discards features that cannot possibly touch the
box before any segment math runs, so even a few thousand features stay fast.

## How it fits the existing code

- **Selection already supports many features.** `js/core/selection.js` keeps
  `_multiSelected` (`[{type, index}]`), highlights all of them on the map and in
  the Features pane, and exports `selectFeature`, `toggleMultiSelect`,
  `getSelectedFeatures`, `isFeatureSelected` and a clear function. Box select
  only needs one new export to set the whole list at once (see Phase 1).
- **Draw modes.** Tools are `.tool-btn[data-mode]` buttons in `index.html`
  (Measure is `data-mode="measure"`, line ~179). `App.drawMode` holds the active
  mode; `App.exitDrawMode()` clears it. `editing.js` ignores map clicks and
  right-clicks while a draw mode is active, which is what we want while
  dragging.
- **Map right-click menu** (`js/core/editing.js` ~803-891) currently always
  single-selects the clicked feature, so it throws away a multi-selection.
- **Features-pane right-click menu** (`js/core/features.js` ~698-760) offers
  Hide and Delete only for a single selection; a multi-selection gets only
  Merge… and Group…. So bulk Hide/Delete is missing in **both** places. This
  plan adds one shared helper and uses it in both menus.
- **Deleting several features.** `App.removePoint/Line/Route/Polygon` each push
  their own undo snapshot and shift later indices. A bulk delete must take ONE
  `App.undo.push()`, then splice from the highest index down within each type,
  then re-render and run `App.onFeatureDelete()` once — the same pattern
  Feature Merge already uses (`merge.js` commit step). `App.undo.batch(fn)`
  (from the GTFS work) is the existing way to fold several pushes into one.

## Phases

Each phase ends with its tests passing and a commit on the session branch.
"Owner" says who should do the work when Opus orchestrates.

### Phase 1 — pure hit-test helpers + selection API (Owner: **Sonnet**)

Small, well-specified, easy to test.

1. New file `js/core/box-select.js` (load after `selection.js` and before
   `features.js` in `index.html`; add it to CLAUDE.md's load order).
   Pure helpers on `App.boxSelectGeom`, no DOM/map/turf, all in screen-pixel
   coordinates:
   - `normRect(x0, y0, x1, y1)` → `{minX, minY, maxX, maxY}`.
   - `pointInRect(p, r)`, `segmentIntersectsRect(a, b, r)` (Liang-Barsky or
     edge tests), `pointInRing(p, ring)`.
   - `lineHits(pts, r, mode)` and `polygonHits(rings, r, mode)`, where
     `mode` is `"touch"` or `"within"`.
2. In `selection.js` add `App.setSelection(list)` (replace `_multiSelected`
   with a de-duplicated list and run the same refresh path as `selectFeature`:
   map highlight, Features pane, vertex-edit rules — one item behaves like a
   single click, so a box around one line still enters vertex-edit exactly as
   clicking it would). Implement add/remove as helpers built on it.
3. Golden test file `test/cases/box-select.mjs`: point inside/outside/on edge;
   a line that crosses the box with no vertex inside; a line entirely inside;
   touch vs within on the same line; a polygon that contains the whole box;
   a polygon whose hole contains the whole box; degenerate (zero-size) box.
   Seed with `--update`; add the module to CLAUDE.md's covered-engine list.

### Phase 2 — the tool and the drag (Owner: **Opus**)

Delicate: it competes with map panning, vertex editing, the other draw tools,
and keyboard shortcuts.

1. Button `data-mode="box-select"` right after Measure in `index.html`, with an
   inline SVG dashed-square icon, `title="Select by box (A)"` and matching
   `aria-label`. Styling uses existing `.tool-btn` rules and design tokens.
2. In `box-select.js`, when the mode is active:
   - Disable `map.dragPan` (restore it on exit and on any error path), set a
     crosshair cursor, and leave vertex-edit mode first if it is active.
   - `mousedown` on the map canvas starts a drag; a fixed-position dashed
     `<div class="box-select-rect">` follows the mouse (cheaper and crisper
     than a MapLibre layer). A small count badge next to the cursor shows how
     many features are currently inside, recomputed at most once per animation
     frame.
   - `mouseup` (listened on `window`, so releasing outside the map still ends
     the drag) runs the hit test against `App.points/lines/routes/polygons`
     (skipping hidden ones) and applies replace/add/remove per D2 through
     `App.setSelection`. Alt is read at release time, so the user can decide
     mid-drag. A status line reports the result ("Selected 6 features").
   - Escape during a drag cancels the drag only; Escape with no drag exits the
     tool.
3. Wire the `A` shortcut in the app.js tool-key listener (same pattern as the
   other tool keys; it already skips inputs, modifier combos and open popups).
4. Make sure every other path that leaves the mode (another tool button,
   `App.exitDrawMode`, Present mode, session reset) restores `dragPan`.
5. CSS in `css/style.css` (`.box-select-*`), tokens only, works in dark mode.

### Phase 3 — group actions in both right-click menus (Owner: **Opus** for the shared helper, **Sonnet** for wiring the menus)

1. Shared helper (Opus), e.g. `App.bulkFeatures` in `box-select.js` or a small
   section of `features.js`:
   - `setHidden(list, hidden)` — one undo snapshot, set
     `properties.hidden` on every feature, re-render each touched type once,
     save, refresh panes. "Hide" if any selected feature is visible,
     otherwise "Show".
   - `remove(list)` — closes the Attributes pop-up if it shows one of them,
     ONE undo snapshot, splice each type from the highest index down, re-render
     each touched type, `App.onFeatureDelete()` once (stops' route links,
     walksheds, module stale flags — the same housekeeping a single delete
     runs; check what `removeX` does beyond the splice, e.g. buffer rebuild and
     point walkshed cleanup, and replicate it), clear the selection.
   - `zoomTo(list)` — fit the map to the selection's combined bounds.
2. Map right-click (`editing.js`, Sonnet): if the clicked feature is already in
   a multi-selection (2+), keep the selection and show the group menu:
   **Zoom to selection**, **Merge…** (only when
   `App.merge.mergeableSelection` accepts it), **Hide N / Show N**,
   **Delete N features…**. Otherwise unchanged (single-select, today's menu).
3. Features-pane right-click (`features.js`, Sonnet): for a multi-selection add
   the same Zoom / Hide / Delete items next to the existing Merge… and Group….
   Labels in a mixed selection are skipped by Hide/Delete with no error.
4. **Delete key**: with no vertex selected and 1+ features selected, Delete /
   Backspace opens the same confirm. The confirm is a small `.fm-*` dialog
   (reuse `App.merge._dialogKit`) listing the count by type, plus any
   `App.describeFeatureUsage` warnings (modules that refer to these features) —
   consistent with Merge and Split.

### Phase 4 — Shift+drag shortcut (Owner: **Sonnet**, optional)

Turn off MapLibre's `boxZoom` in `map.js` and start a box-select drag on
Shift+mousedown even when the tool is off. (Shift then means "add" only inside
the tool, per D2; outside the tool Shift+drag means "select".) Skip this phase
if the user prefers to keep box zoom.

### Phase 5 — tests and documentation (Owner: **Sonnet**, Opus reviews)

1. Browser smoke test `test/box-select-smoke.mjs` (Playwright, same setup as
   `test/feature-color-smoke.mjs`): draw two points, two lines, a route and a
   polygon; drag boxes with real mouse events and check:
   replace / Shift-add / Ctrl-remove; touch vs Alt-within on a long line;
   a polygon containing the whole box; hidden features ignored; the tool stays
   on and `dragPan` is back on after exit; the map still pans normally after
   Escape; group Hide then Show; group Delete then one Ctrl+Z restores
   everything with the same IDs; Delete key confirm; a stop linked to a deleted
   route loses the link.
2. Re-run `node test/run-golden.mjs`, the merge/split/GTFS/color smoke tests,
   and `test/ui-screens/capture.mjs` (toolbar changed — inspect the toolbar
   images in light and dark; re-baseline only the toolbar shots if correct).
3. CLAUDE.md: `box-select.js` File Structure entry, load-order line,
   `App.setSelection` / `App.bulkFeatures` API notes, the `A` shortcut in the
   keyboard-shortcuts paragraph, and the map/Features right-click group menus.

## Delegation summary

| Work | Owner | Why |
|---|---|---|
| Pure hit-test helpers + golden tests | Sonnet | Self-contained math with an exact spec |
| `setSelection` | Sonnet, Opus reviews | Small, but touches vertex-edit behavior |
| Drag interaction, mode lifecycle, dragPan safety | **Opus** | Interacts with panning, editing, other tools; easy to leave the map stuck |
| Bulk delete/hide helper | **Opus** | Index shifting, undo, stop links, walkshed and module housekeeping |
| Menu wiring, Delete-key confirm | Sonnet | Follows existing patterns once the helper exists |
| Shift+drag shortcut | Sonnet | Small |
| Smoke test, docs, screenshot check | Sonnet, Opus reviews | Mechanical; review catches gaps |

Phases 1 and the Opus half of Phase 3 can run in parallel; Phase 2 needs Phase
1; the menu wiring needs the Phase 3 helper.

## Not in scope

- Lasso or polygon-shaped selection (the helpers would extend to it later).
- Selecting labels/text boxes, buffers, or reference/GTFS layers by box.
- Bulk color, bulk attribute edit, bulk Duplicate (Group… and Attribute
  Summary's Copy Attributes already cover attribute edits).
- Remembering the touch/within choice as a setting.
