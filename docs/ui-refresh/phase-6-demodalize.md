# Phase 6 — De-modalize the analysis popups

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/analysis-modules.md. This file is historical.

**Goal (approved decision):** the map stays visible and fully interactive while a module
popup is open. Popups become floating panels: draggable (already true), collapsible
(new), no dimmed backdrop, no blocking.

Useful facts discovered during planning:
- The backdrop exists **only** as `<div class="module-popup-backdrop">` in
  `index.html:304`. No JS references it (`popup.js` deliberately never wired
  backdrop-click-to-close). Removal is safe.
- Escape-to-close lives in `app.js`'s keydown listener — keep as-is.
- The in-popup modal overlays (Adjust Weights, Costing Settings, Copy Attributes) are
  positioned within the dialog and are unaffected — they stay modal *inside* the panel,
  which is correct.

## 1. Remove the backdrop, make the container click-through

- Delete the backdrop `<div>` from `index.html`.
- Delete the `.module-popup-backdrop` CSS block.
- `.module-popup { pointer-events: none; }` and
  `.module-popup-dialog { pointer-events: auto; }` — the fullscreen flex container stops
  eating map events; only the dialog is interactive.

## 2. Default position: dock right

With a live map, dead-center is the worst default (covers the analysis area). Change the
container to place the dialog toward the right edge, vertically centered:

```css
.module-popup { justify-content: flex-end; padding-right: 24px; box-sizing: border-box; }
```

Rationale: module results (choropleths, coverage fills, rings) render on the map, and
the right feature panel is collapsible — docking right leaves the largest contiguous map
view. The user can still drag anywhere; drag offset resets on each open (existing
behavior, keep). If the developer dislikes it at checkpoint, reverting to centered is a
one-line change.

Guard: `max-width: 90vw` still applies; on narrow windows the panel must not overflow
left of the viewport (flex-end + max-width handles this — verify at 1100px width).

## 3. Collapse-to-title-bar button

- `index.html`: add a collapse button in `.module-popup-header` before the close button:
  `<button class="module-popup-collapse" aria-label="Collapse panel" title="Collapse">–</button>`
  (use a chevron SVG matching the panel-collapse buttons if trivial).
- `popup.js`: in `wire()`, toggle `module-popup-collapsed` on the **container** element;
  in `open()`, always remove the class (a freshly opened popup is expanded).
- CSS: `.module-popup-collapsed .module-popup-body { display: none; }` and shrink the
  dialog: `.module-popup-collapsed .module-popup-dialog { width: auto !important; min-width: 280px; }`
  (the `!important` overrides the inline per-module width set by `popup.js`; note it in
  a comment). Collapsed panel = just the title bar, draggable, restorable.
- Button flips its glyph/rotation when collapsed.

## 4. Behavior audit (test each, fix only if broken)

- **Transit Travelshed "Pick origin on map":** read the `tsPickOriginBtn` handler in
  `js/projects/transit-travelshed.js` first — it may hide or close the popup before
  arming the one-shot map click (a workaround for the old backdrop). If it does,
  simplify: with a live map the popup can stay open while the user clicks the origin.
  Keep the change minimal and UI-only; run the golden harness after.
- **Drawing while a popup is open:** now possible (toolbar is reachable). Modules already
  handle feature changes via `update()` + stale marking, so this should Just Work —
  verify: open Transit Coverage, draw a line, confirm the checklist refreshes / stale
  pill appears.
- **Hover tooltips on choropleths** (TPI/RF/Corridor Scoring) with popup open: verify
  they appear (they render into the map container, z-index below the dialog — fine
  unless the cursor is over the dialog).
- **Keyboard:** draw-tool shortcut keys are currently suppressed while
  `App.popup.isOpen()` (app.js second keydown listener). **Keep the suppression** for
  now — typing in popup inputs must never trigger tools; revisit later if the developer
  asks.
- **Escape** still closes the popup even when focus is on the map — confirm.

## Verification

- Capture script (update it: screenshots of popups now show map behind — expected;
  the clip to `.module-popup-dialog` keeps popup images comparable).
- Manual flow test (headless or by hand): open popup → pan/zoom map → draw a point →
  collapse panel → expand → run an analysis with seeded fixture if feasible → Escape.
- `node test/run-golden.mjs` → pass (popup.js / travelshed module UI edits).

## Checkpoint

Send the developer a short screen-capture-style sequence (or 3–4 stills): popup open
over live map, docked-right default, collapsed state. Flag the dock-right decision
explicitly as reversible. Review-and-continue.

Commit: `UI refresh phase 6: de-modalize analysis popups (live map, dock right, collapse)`
(with `Verified: node test/run-golden.mjs → N/N`)
