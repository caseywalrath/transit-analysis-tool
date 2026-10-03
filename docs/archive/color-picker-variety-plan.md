# Color Picker Variety Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/drawing-and-features.md. This file is historical.

Goal: more color choice in the shared swatch picker without a materially larger popover.
Single surface: `buildColorPickerBody(currentColor, onPick)` in `js/core/features.js` (~L101-170),
styled by `.fp-cp-*` in `css/style.css` (~L4762). It is used by the floating `App.openColorPicker`
(labels, text boxes, layer-palette swatches, type-default swatches) and inline by the Appearance
popover (`js/core/feature-appearance.js`). Changing the body changes every picker at once.

## Current state
30 colors: 6 hue columns × 4 shades + 1 gray row; 22px cells, 4px gap (~152px wide).
Gaps: no pink/magenta, cyan, or brown; the green column drifts to teal.

## Phase A — Denser 10-hue grid (routine)
- Replace `PICKER_COLORS` with 10 columns × 5 rows = 50:
  hue columns red, orange, yellow, green, teal, cyan, blue, indigo, purple, pink;
  rows: light, medium-light, medium, dark; row 5 = 10 neutrals white→black
  (include one warm brown-gray so a brown is reachable). Each column must be one consistent hue.
- Keep the existing 30 hex values where they still fit a column, so colors users already picked
  remain visibly "in the grid" (current-color outline still works).
- CSS: `.fp-cp-grid` → `repeat(10, 1fr)`, cell ~15px, gap 2px; target total width ≤ 170px.
  Keep hover/focus/selected states legible; keep keyboard focus ring.
- Check the floating picker's positioning math (`openColorPicker` uses `offsetWidth`/fallback 192)
  and the Appearance popover width — nothing may overflow or clip.

## Phase B — "Recent" row (routine)
- A row of up to 10 swatches under the grid labeled "Recent" (muted small label), hidden when empty.
- Source: a module-local MRU list in features.js, updated whenever `onPick` fires from ANY picker
  body (grid, hex, custom); de-duplicated, newest first, max 10.
- Persist per-browser in `localStorage` key `mat-recent-colors` with try/catch (a convenience, not
  session state — do not add to cache.js). Seed on first use with colors already in use on the map
  (`App.resolveFeatureColor` over `App.collectDrawnFeatures()`, unique) when the list is empty.

## Phase C — "Custom…" full-spectrum button (routine)
- In the hex row add a small button wrapping a hidden `<input type="color">`; on `change`, call the
  same apply path as the hex box (validate, lowercase, `onPick`). Seed it with the current color.
- `input` events must not spam onPick/undo — only `change` commits.
- Must not close the floating picker / Appearance popover when the native dialog opens (outside-
  mousedown handlers: verify the native dialog doesn't trigger them; guard if needed).

## Tests
- `node test/run-golden.mjs` (no math change expected; must stay green).
- Extend `test/feature-appearance-smoke.mjs` (NODE_PATH=/opt/node-tools/node_modules):
  50 cells; one consistent picked color appears first in Recent; Recent survives reload;
  custom `change` applies exactly one color and one undo step; floating picker still works
  (label/text box color).
- `test/feature-color-smoke.mjs`, `test/box-select-smoke.mjs`, `bash test/browser/run-browser.sh`.
- `test/ui-screens/capture.mjs`: view popover + attr popup + any floating-picker shots;
  re-record only intentionally changed baselines.
- Update CLAUDE.md (features.js entry: `buildColorPickerBody` grid/recent/custom, the
  `mat-recent-colors` key).

## Done
One commit per phase or one combined commit, each with a `Verified:` line; tree clean; pushed.
