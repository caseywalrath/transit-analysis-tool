# Display Settings rework — implementation plan

Replaces the 15-fader Display Settings matrix with per-type style drawers in the Layers panel,
and separates appearance from analysis geometry and from attribute data.

**Read this whole document before starting any phase.** Each phase is independently shippable
and must leave the app fully working. Do not start a later phase before its predecessor is
complete and verified.

---

## Why (context for the implementing model)

Today appearance is edited in three unrelated places with no visible relationship between them:

1. **Display Settings modal** (`js/projects/display-settings.js` + `projects/display-settings-popup.html`) —
   a 3×5 grid of 15 vertical range inputs. Rows are Opacity / Size-Width / Buffer Radius, columns
   are Points / Lines / Routes / Polygons / Buffers.
2. **Per-feature override icons** (`App.buildOverrideIcons` in `js/core/feature-attributes.js`) —
   shown in the per-feature attribute popup **and** in Attribute Summary rows.
3. **Layers panel** (`js/core/layers-panel.js`) — per-type opacity rows and per-feature color swatches.

The underlying data model is already correct and does **not** need redesigning. It is a clean
two-level cascade:

- Type default: `App.featureSettings.<type>Opacity` etc. (`js/app.js`, search `App.featureSettings =`)
- Per-feature override: `feature.properties._opacity` / `_fillOpacity` / `_borderOpacity` /
  `_lineWidth` / `_bufferRadius` / `_offset`
- Resolved in the paint expression as `["case", ["has","_opacity"], ["get","_opacity"], <default>]`

The problem is purely that no UI renders that cascade as a cascade. This plan moves the UI; it
preserves the model except where a phase explicitly says otherwise.

**End state:**

- **Features tab** = what exists and what it measures (feature list, buffer radii, offset toggle).
- **Layers tab** = how everything looks (per-type style drawers, per-feature overrides nested under them).
- **Attribute Summary** = bulk editing of attribute data only, no appearance controls.

---

## Global rules — apply to every phase

### User-facing text

This is a hard requirement, not a style preference.

- **Never surface internal architecture, phase numbers, migration state, or design rationale in
  UI text.** No "new", "legacy", "migrated", "v2", "(moved)", "phase 3", "now in Layers", or
  asterisks/footnotes explaining why something changed.
- **Label controls with plain nouns for what they do**, in the user's vocabulary, not the code's.
  Write `Dot size`, not `pointLineWidth` or `Size / Width`. Write `Fill opacity`, not
  `_fillOpacity` or `Polygon fill alpha`.
- **Do not add explanatory prose to the UI to compensate for a layout.** If a control needs a
  paragraph to explain it, the layout is wrong — fix the layout instead. A short `title=`
  tooltip on an icon-only button is fine; a sentence of body copy in a drawer is not.
- **Do not add "Reset to defaults" copy that explains what a default is.** The button says
  `Reset`; its `title` may say `Reset to defaults`.
- **Do not announce removals.** When Display Settings goes away, nothing in the UI mentions that
  it used to exist.

### Code conventions (from `CLAUDE.md`)

- No build step. Plain `<script>` tags, `var`, IIFE modules assigning onto `window.App`.
- Module-local state stays private inside the IIFE closure. Only intended API goes on `App`.
- **Design tokens only** for chrome: `--space-*`, `--text-*`, `--weight-*`, `--leading-*`,
  `--border`, `--muted`, `--accent`, `--surface*`. No raw hex for chrome. Feature colors and
  swatches are data encodings and keep explicit colors.
- All CSS goes in `css/style.css`. Place new blocks next to the most similar existing block.
- Existing prefixes: `.lp-` (layers panel), `.fp-` (feature panel), `.as-` (attribute summary).
  New style-drawer classes use `.lp-` since they live in the Layers panel.
- After every state mutation call `App.cache.save()`.

### Verification for every phase

1. `node --check <each edited .js file>` — must print nothing / exit 0.
2. Open `index.html` in a browser. Draw at least one point, one line, one route, and one polygon.
   Exercise every control the phase touched. Confirm no console errors.
3. Reload the page and confirm the session restores with the settings intact.
4. Run `node test/ui-screens/capture.mjs` and **look at the images in `test/ui-screens/out/`**,
   not just the pass count. Update `test/ui-screens/baseline/` only when a diff is an intended
   result of the phase.

`node test/run-golden.mjs` is **not** required for any phase here — no calculation logic changes.

### Commit rules

- One commit per phase, after that phase verifies clean.
- Commit message: a short imperative subject line, then a body explaining what moved and why.
- Do not mention model names or phase numbers from this document in commit messages.
- End every commit message with the attribution footer the session specifies.

---

## Phase 0 — Resizable feature panel

**Goal:** the right panel can be dragged to any width between 200px and 40% of the viewport, and
the width persists across sessions. Nothing else changes.

### Why this is first

Every later phase puts more content into a 208px panel. This unblocks them, and is independently
useful — the Layers tab is already cramped with nested groups and long feature names.

### Files

- `index.html` — add the drag handle element
- `css/style.css` — handle styling; replace the hardcoded panel-width constant
- `js/core/features.js` — drag logic (near the existing collapse-toggle IIFE at the end of the file)
- `js/core/cache.js` — persist the width

### Steps

**0.1 — Introduce a width custom property.**

`#feature-panel` (`css/style.css`, search `#feature-panel {`) currently has `width: 208px`.
`.module-popup` (search `padding-right: 233px`) hardcodes `233px` — that is 208 + 1px border +
24px gutter — so floating analysis panels dock clear of it. There are two override rules chasing
that constant, for `.fp-collapsed` and for `body.present-mode`.

Replace this with a single variable:

- Define `--fp-width: 208px` on `#app`.
- `#feature-panel { width: var(--fp-width); }`
- `.module-popup { padding-right: calc(var(--fp-width) + 25px); }`
- The collapsed and present-mode rules stay as they are — they already force `24px` and can keep
  overriding directly. Do not try to make them set `--fp-width`; the panel width and the popup
  gutter genuinely differ in those two states only by the same constant, and the existing explicit
  rules are clearer.

Keep the existing `transition: width 0.2s ease` on `#feature-panel`, but see 0.3.

**0.2 — Add the drag handle.**

In `index.html`, inside `#feature-panel`, as the first child (before `#fp-collapse-btn`):

```html
<div id="fp-resize-handle" role="separator" aria-orientation="vertical"
     aria-label="Resize panel" tabindex="0"></div>
```

Style it in `css/style.css` next to the `#feature-panel` block: `position: absolute`, `left: 0`,
`top: 0`, `bottom: 0`, `width: 5px`, `cursor: col-resize`, `z-index` above the panel content,
transparent background, and a `--border`-colored background on `:hover` and while dragging. It
must not be visible when the panel is collapsed — add a rule under the existing
`#feature-panel.fp-collapsed` selectors hiding it.

**0.3 — Drag logic.**

Add a new IIFE in `js/core/features.js` alongside the existing collapse-toggle IIFE at the bottom
of the file.

- `mousedown` on the handle: record start X and start width, add a `dragging` class to
  `document.body` (use it to set `user-select: none` and `cursor: col-resize` globally so the
  cursor does not flicker over the map), attach `mousemove`/`mouseup` on `document`.
- `mousemove`: `newWidth = startWidth + (startX - e.clientX)` (dragging left widens).
  Clamp with `Math.max(200, Math.min(newWidth, window.innerWidth * 0.4))`.
  Set `document.getElementById("app").style.setProperty("--fp-width", newWidth + "px")`.
- **Suppress the CSS transition while dragging** — a 0.2s transition on every mousemove makes the
  drag feel laggy. Add a class during drag that sets `transition: none` on `#feature-panel`, and
  remove it on mouseup so the collapse animation still works.
- `mouseup`: remove listeners and classes, then call `App.map.resize()` and `App.cache.save()`.
- Also handle keyboard: `ArrowLeft`/`ArrowRight` on the focused handle adjust width by 16px,
  same clamp, same save. This keeps the control accessible.

MapLibre 4.7.1 observes its container, so the canvas follows automatically during the drag —
the explicit `App.map.resize()` on mouseup is a cheap safeguard, not the mechanism.

**0.4 — Persist.**

In `js/core/cache.js`:

- In the collect function, alongside `featureSortMode` (search `featureSortMode:`), add
  `featurePanelWidth`, read from the computed `--fp-width` on `#app` (parse the px integer).
- In the restore function, in the block that restores sort state (search `restoreFeatureSortState`),
  add a guarded restore: if `state.featurePanelWidth` is a finite number, clamp it with the same
  rule and set the property. An absent field must leave the CSS default untouched.

This is an additive field. Do not bump any schema version.

### Done when

Dragging the panel edge resizes it smoothly, the map fills the remaining space, floating analysis
panels still dock clear of the panel at any width, the collapse button still works, and the width
survives a reload.

---

## Phase 1 — Separate appearance from analysis geometry

**Goal:** buffer radius leaves Display Settings and becomes numeric inputs in the Features tab.
Display Settings is left holding appearance only.

### Why

`ds-bufferRadius` and its siblings call `App.rebuildBuffers()` / `rebuildLineBuffers()` /
`rebuildRouteBuffers()` plus `App.notifyProject()`. Those change the analysis geometry every module
reads as its study area. That is not a display setting, and its presence in the matrix is why the
grid has two `—` cells it cannot fill.

### Files

- `index.html` — add buffer inputs to the Feature Settings section
- `css/style.css` — styling for the new rows
- `js/app.js` — wire the inputs
- `projects/display-settings-popup.html` — remove the Buffer Radius row
- `js/projects/display-settings.js` — remove the three buffer-radius slider configs

### Steps

**1.1 — Add the inputs.**

In `index.html`, in `#fp-settings-section` inside `.fp-settings-body` (search
`id="fp-settings-section"`), add three rows above the existing `offsetOverlap` row, using the
existing `.fp-buffer-row` class:

```html
<div class="fp-buffer-row">
  <label class="fp-buffer-label" for="fp-buf-point">Point buffer</label>
  <input type="number" id="fp-buf-point" min="0" max="2" step="0.125" />
  <span class="fp-buffer-unit">mi</span>
</div>
```

...and the same for `fp-buf-line` (Line buffer) and `fp-buf-route` (Route buffer).

`.fp-buffer-row` and `.fp-buffer-label` already exist (`css/style.css`, search `.fp-buffer-row {`),
and number inputs inside that row are already styled by descendant selectors
(`.fp-buffer-row input[type="number"]`, around line 3622) — so the inputs need no class of their
own. Only `.fp-buffer-unit` is new: add a minimal token-based rule (`--text-xs`, `--muted`) next to
`.fp-buffer-label`.

**1.2 — Wire them.**

In `js/app.js`, near the existing `offsetOverlap` listener (search `getElementById("offsetOverlap")`),
add a small loop over a config array:

```
{ id: "fp-buf-point", key: "bufferRadius",      rebuild: "rebuildBuffers"      }
{ id: "fp-buf-line",  key: "lineBufferRadius",  rebuild: "rebuildLineBuffers"  }
{ id: "fp-buf-route", key: "routeBufferRadius", rebuild: "rebuildRouteBuffers" }
```

For each: seed `el.value` from `App.featureSettings[key]`, and on `change` (not `input` — a
rebuild on every keystroke is expensive and triggers Census-overlay clearing) read and validate
the number, clamp to `[0, 2]`, write it to `App.featureSettings[key]`, call the rebuild function,
call `App.notifyProject()`, and call `App.cache.save()`. A non-numeric or empty value resets the
input to the stored value rather than writing `NaN`.

Expose a small `App.syncBufferInputs()` that re-seeds all three from `App.featureSettings`, and
call it from `js/core/cache.js` after `restore` finishes applying feature settings, so a restored
session shows the right numbers.

**1.3 — Remove from Display Settings.**

- In `projects/display-settings-popup.html`, delete the entire Buffer Radius row: the
  `.ds-row-hdr` and all five cells including the two `.ds-empty` cells.
- In `js/projects/display-settings.js`, delete the `ds-bufferRadius`, `ds-lineBufferRadius`, and
  `ds-routeBufferRadius` entries from `SLIDERS`.
- In `css/style.css`, the `.ds-cell:not(:nth-child(6n))` and `.ds-empty:not(:nth-child(6n))`
  selectors depend on the cell count per row. With one row removed the `6n` arithmetic still holds
  (6 elements per row: 1 header + 5 cells), so no CSS change is needed — but verify the borders
  still render correctly and delete the now-unused `.ds-empty` rules.

The per-feature buffer override in `buildOverridesContainer` stays exactly as it is in this phase.
It moves in Phase 3.

### Done when

Buffer radii are set from the Features tab, changing one rebuilds buffers and updates dependent
modules, values persist across reload, and Display Settings shows only Opacity and Size / Width.

---

## Phase 2 — Numeric scrubber control

**Goal:** one reusable compact numeric control, used both inline and inside the existing popover,
replacing the vertical range inputs.

### Why

A vertical 80px range input gives roughly one pixel per percent, has no tick marks, and puts its
value in a separate element below it. It is unreadable at a glance and imprecise to set. Every
later phase puts these controls into a narrow panel where a fader is worse still.

### Files

- `js/app.js` — new `App.buildScrubber`; rewrite `_openFpSlider`'s internals
- `index.html` — popover markup
- `css/style.css` — scrubber styling

### Steps

**2.1 — Build the component.**

Add `App.buildScrubber(cfg)` in `js/app.js`, near the existing `_openFpSlider` block.

`cfg` accepts the same shape the existing slider configs use, so call sites need minimal change:

- `{ min, max, step, unit, value, onChange(v) }` for continuous values, **or**
- `{ values: [...], unit, value, onChange(v) }` for a fixed step list (buffer radii, offsets).

It returns a DOM element containing a decrement button, a `<input type="number">` (or a text input
for the `values` variant showing the label), an increment button, and a unit suffix. Behavior:

- Typing a value commits on `change` and on `Enter`; invalid input reverts to the last good value.
- The `−` / `+` buttons step by `step` (or move one position in `values`), clamped to range.
- Dragging horizontally on the input adjusts the value — a scrubber. Implement with
  `mousedown` + `mousemove` on `document`, moving `step` per ~4px of travel, clamped. Set
  `cursor: ew-resize` on the input. This is a progressive enhancement; typing must work without it.
- Every commit path calls `cfg.onChange(v)` once with the resolved numeric value.

Expose `refresh(v)` on the returned element (as a property) so callers can push external updates in.

Keep the component presentation-only — it must not touch `App.featureSettings` or `App.cache`
itself. Callers own persistence. This keeps it reusable for the per-feature override case where
the target is `feature.properties`, not `featureSettings`.

**2.2 — Rewrite the popover to mount it.**

`_openFpSlider(btn, cfg)` in `js/app.js` currently manipulates `#fp-slider-input` (a vertical
range) directly. Change it to clear `#fp-slider-popover` and append `App.buildScrubber(...)`,
preserving all of the existing behavior around it: the toggle-off-when-same-button check, the
`fp-sib-active` class, the outside-mousedown close, and the viewport-clamped positioning.

Two things must be preserved exactly:

- The `cfg.key` path — when `cfg.key` is present the popover writes
  `App.featureSettings[cfg.key]` and calls `App.cache.save()` itself. Several call sites depend
  on this (`layers-panel.js` `buildTypeOpacityRow` passes only a `key`, no `value`).
- The popover's dimensions in the positioning math (`popW`, `popH`) must be updated to match the
  new horizontal layout, or the popover will be positioned wrongly near viewport edges.

In `index.html`, replace the three children of `#fp-slider-popover` with an empty container; the
scrubber is now appended at open time. Update `#fp-slider-popover` in `css/style.css` from a
narrow vertical box to a horizontal one and delete `.fp-slider-vert`.

**2.3 — Update Display Settings to use it inline.**

In `projects/display-settings-popup.html`, replace each `<input type="range">` + `<span class="ds-val">`
with an empty `<div class="ds-cell-control" id="ds-<key>"></div>`. In `js/projects/display-settings.js`,
`wireSliders` mounts a scrubber into each. Keep the `SLIDERS` config array and the reset button
working unchanged.

This is deliberately throwaway work — Display Settings is deleted in Phase 3. Do it anyway: it
proves the component against ten real call sites before the drawers depend on it, and it is about
fifteen lines.

### Done when

Every place that previously opened a vertical fader now opens a horizontal scrubber; values can be
typed, stepped, and dragged; per-feature overrides, layers-panel type opacity, and Display Settings
all still write through correctly and persist.

---

## Phase 3 — Style drawers in the Layers panel

**Goal:** each drawn geometry type gets an expandable style drawer in the Layers tab. Display
Settings is deleted.

### Scope note

This phase concerns **drawn feature** styling only. It is unrelated to
`docs/layers-panel-styling-eval.md`, which evaluated exposing *analysis choropleth* ramp/class
specs in the Layers panel and recommended against it. That decision stands; do not revisit it and
do not add style drawers to `ANALYSIS` or `REFERENCE` manifest entries.

### Files

- `js/core/layers-panel.js` — the drawers
- `js/app.js` — split polygon/buffer opacity; split point size from point stroke
- `js/core/cache.js` — persist the new fields, migrate the old ones
- `css/style.css` — drawer styling; delete the `.ds-*` block
- `index.html` — remove the Display Settings button and script tag
- Delete `js/projects/display-settings.js` and `projects/display-settings-popup.html`
- `test/ui-screens/capture.mjs` — remove `display-settings` from the captured module list
- `CLAUDE.md` — update the affected sections

### Steps

**3.1 — Split the paired opacity values.**

`_polyOpacityValues(S)` and `_bufOpacityValues(S)` in `js/app.js` are piecewise curves mapping one
0–100 input onto a **pair** of values (fill and border), because the matrix had only one cell per
column. The drawer has room for both.

- Add `polygonFillOpacity` (default 15), `polygonLineOpacity` (default 80),
  `bufferFillOpacity` (default 8), `bufferLineOpacity` (default 40) to `App.featureSettings`.
  These defaults are the existing curves evaluated at the current defaults of `polygonOpacity: 50`
  and `bufferOpacity: 50` — verify by running the curves rather than trusting these numbers.
- Rewrite the `polygon` and `buffer` branches of `App.applyFeatureOpacity` to read the new fields
  directly (as `/100`), dropping the curve call.
- **Keep `_polyOpacityValues` exported** — `buildOverridesContainer` in `js/core/feature-attributes.js`
  calls `App._polyOpacityValues` for the per-feature polygon override, and `js/core/cache.js` needs
  it for migration. Its per-feature use is unchanged in this phase.
- Remove `polygonOpacity` and `bufferOpacity` from `App.featureSettings`.

**3.2 — Split point size from point stroke.**

`App.applyLineWidth`'s `point` branch scales both `circle-radius` (base 6) and `circle-stroke-width`
(base 2) from the single `pointLineWidth`. Add `pointStrokeWidth` (default 1), keep
`pointLineWidth` driving the radius only, and have the stroke read the new field. Preserve the
existing `_lineWidth` per-feature override on both properties so overrides keep working.

**3.3 — Migrate the cache.**

In `js/core/cache.js`:

- Collect the five new fields alongside the existing ones.
- On restore, for each new field: if present, use it. If absent **and** the corresponding old
  field (`polygonOpacity` / `bufferOpacity`) is present, seed it by running the old value through
  `App._polyOpacityValues` / `App._bufOpacityValues` and multiplying by 100. Otherwise use the
  default. This is lossless for existing sessions.
- Drop `polygonOpacity` / `bufferOpacity` from collect. Leave the restore-side reads in place
  purely as migration inputs.
- `pointStrokeWidth`: if absent, seed from `pointLineWidth` if present, else 1.

**3.4 — Build the drawer.**

In `js/core/layers-panel.js`, replace `buildTypeOpacityRow(t)` with `buildTypeStyleRow(t)`.

Extend `DRAWN_TYPES` to carry each type's control list. A type entry gains a `controls` array
where each control is `{ label, kind, key, min, max, step, unit }` and `kind` is `"color"` or
`"number"`. The contents per type:

| Type | Controls |
|---|---|
| Points | Color · Dot size (`pointLineWidth`, 0–5, step 0.1, `×`) · Outline width (`pointStrokeWidth`, 0–5, step 0.1, `×`) · Opacity (`pointOpacity`, 0–100, step 5, `%`) |
| Lines | Color · Weight (`lineLineWidth`) · Opacity (`lineOpacity`) |
| Routes | Color · Weight (`routeLineWidth`) · Opacity (`routeOpacity`) |
| Polygons | Color · Fill opacity (`polygonFillOpacity`) · Outline opacity (`polygonLineOpacity`) · Outline width (`polygonLineWidth`) |
| Buffers | Fill opacity (`bufferFillOpacity`) · Outline opacity (`bufferLineOpacity`) · Outline width (`bufferLineWidth`) |

Row structure — a collapsed header row plus a hidden body:

- **Header row** (`.lp-row`): a caret toggle (reuse the existing `.lp-caret` pattern from
  `buildGroupBlock`), a preview element, and the type name. Clicking anywhere on the header
  toggles the drawer. Track open state in a module-local object next to the existing
  `_expandedGroups`, so it survives a `render()` call.
- **Body** (`.lp-style-drawer`): one row per control — a `.lp-style-label` and the control. Number
  controls mount `App.buildScrubber` with `onChange` writing `App.featureSettings[key]`, calling
  the type's apply function, and calling `App.cache.save()`. The color control is a swatch button
  opening `App.openColorPicker`, writing `App.sectionColors[t.type]` and calling
  `App.rerenderForType(t.type)`.
- A `Reset` button at the foot of the body restores that type's controls to their defaults.

**Colour note:** `App.sectionColors` (`js/core/utils.js`, `{ point: null, line: null, route: null, polygon: null }`)
already exists and is already read as the type default by every render function and by
`App.getTypeDefaultColor`. Only `label` currently has a UI to set it (`js/core/features.js`, search
`sectionColors.label`). The other four have no setter — the drawer is that setter. No model change
is needed.

Buffers have no color control: buffer layers are painted with their parent type's color (see
`renderPointLayers` in `js/core/points.js`). Do not add one.

**3.5 — The preview element.**

A small inline SVG (about 40×16) rendering that type at its current settings: a filled circle with
stroke for Points, a stroke for Lines and Routes, a filled rect with outline for Polygons and
Buffers. It reads the same `featureSettings` fields the controls write and re-renders on any
change. Keep it simple — approximate scaling is fine, it is an indicator, not a simulation.

**3.6 — Structure inside the Drawn band.**

The Drawn band currently lists group blocks (nested by `attributes.group`), then appends the
per-type opacity rows at the end. Groups can mix geometry types, so the type defaults cannot
simply become parents of the feature rows.

Add a sub-band heading above the type rows so the two halves of the band read as distinct:
the grouped feature list first, then a `Style defaults` heading, then the type style rows. Keep
the existing grouped list untouched. Only render a type's row when that type has features, as the
current code already does.

Do **not** restructure the Drawn band to nest by geometry type in this phase.

**3.7 — Per-feature override rows.**

In `buildFeatureRow`, add a caret that expands a per-feature style drawer with the same controls
as its type, plus one behavioral difference: each control shows the inherited value in muted text
until the feature has its own override, and gains a clear-to-inherit affordance once it does.

- Inherited state: the control displays the type default and the row carries a muted
  `Inherits` marker. Reading is from `App.featureSettings`, and `feature.properties._*` is absent.
- Overridden state: the control shows the feature's own value, and a small clear button deletes
  the `_*` property and re-renders.
- Writes go to `feature.properties._opacity` / `_fillOpacity` / `_borderOpacity` / `_lineWidth`
  / `_offset` exactly as `buildOverridesContainer` does today. Copy that logic; do not invent new
  property names. The polygon case must keep using `App._polyOpacityValues` to derive the
  `_fillOpacity` / `_borderOpacity` pair from a single input, since the per-feature model is
  unchanged in this phase.
- Lines and Routes additionally get the offset control (`_offset` / `_offsetManual`, steps
  `[-6,-3,0,3,6]`), matching the existing override.
- Per-feature buffer radius (`_bufferRadius`) also moves here. It is geometry rather than
  appearance, but it is a per-feature override with no other home, and Phase 1 only relocated the
  three global radii. Put it last in the drawer.

**3.8 — Delete Display Settings.**

- Delete `js/projects/display-settings.js` and `projects/display-settings-popup.html`.
- Remove the `<script src="js/projects/display-settings.js">` tag from `index.html`.
- Remove the `#open-display-settings` button from `index.html` and its listener in `js/app.js`
  (search `open-display-settings`).
- Delete the `.ds-*` block from `css/style.css` (search `.ds-root`), including the dark-mode
  `.ds-reset-btn` override.
- Remove `"display-settings"` from the module list in `test/ui-screens/capture.mjs`.
- `App._syncDisplaySliders` was only set by the deleted module — grep for callers and remove them.

**3.9 — Update `CLAUDE.md`.**

Update the File Structure entry for `layers-panel.js`, the Layout section's feature-panel
description, and remove `display-settings.js` / `display-settings-popup.html` from the file tree
and the script-load-order list. Document the new `featureSettings` fields.

### Done when

Every appearance property reachable from the old matrix is reachable from a Layers-tab drawer;
per-feature overrides work from the feature rows and clearly show inheritance; Display Settings is
gone with no dangling references (`grep -rn "display-settings\|ds-" index.html js/ css/` is clean);
sessions saved before the change restore with visually identical styling.

---

## Phase 4 — Remove appearance controls from Attribute Summary

**Goal:** Attribute Summary edits attribute data only.

### Why

The override icon column is appearance smuggled into a data table, and it is the third place the
same properties are editable. Once Phase 3 gives them a proper home, it is redundant. The module's
own `COPY_FIELD_DEFS` already excludes every display property, so this brings the visible columns
in line with the module's existing model of its own scope.

Do this only after Phase 3 is verified — it removes the controls' current home.

### Files

- `js/projects/attribute-summary.js`
- `css/style.css` — the `.as-grid-*` templates

### Steps

**4.1 — Remove the column.**

- Delete the `App.buildOverrideIcons` call (search `buildOverrideIcons` — around line 751) and the
  cell it appends.
- Delete the three `{ label: "", cls: "as-col-overrides", title: "Overrides" }` header entries in
  `renderPoints`, `renderLineLike`, and `renderPolygons`.
- In `css/style.css`, delete the trailing overrides column from `.as-grid-points` (96px),
  `.as-grid-routelike` (128px), and `.as-grid-polygons` (76px). Delete the `.as-col-overrides` rule.
- **Header and data rows share the same grid template.** Column count and order must match after
  the edit or every row will be misaligned. Verify visually, not just by reading the CSS.

**4.2 — Keep the color swatch.**

`buildSwatchCell` stays in all four tables. Color reads as identity rather than styling and is
useful mid-bulk-edit.

**4.3 — Consider narrowing the popup.**

Removing 96–128px per row may let `popupWidth` drop from 960. Only change it if the widest table
(`.as-grid-routelike`, still 10 columns) genuinely fits without horizontal overflow at the smaller
width. If in doubt leave it at 960 — an over-wide table is a smaller problem than a clipped one.

**4.4 — `App.buildOverrideIcons` retirement.**

After this phase its only remaining caller is the per-feature attribute popup
(`buildOverridesContainer`'s other call site in `js/core/feature-attributes.js`). Leave both in
place. Whether the attribute popup should also lose its override icons now that the Layers panel
has them is a real question, but it is out of scope here — do not remove it speculatively.

**4.5 — Update `CLAUDE.md`.**

Update the `attribute-summary.js` entry — the Points / Lines / Routes / Polygons row descriptions
list override icons as a column, and the "Layout" paragraph names them.

### Done when

Attribute Summary shows no opacity / width / buffer / offset / reset icons, every table's columns
line up between header and data rows, and all attribute editing still saves and re-renders.

---

## Phase 5 — Record style presets as a future addition

**Goal:** documentation only. No code.

This phase is independent and may be done at any point.

### Steps

Add an entry to `features.md`, in the same section as the other UI entries (near the
"Layer panel" and "Print / presentation mode" entries), following the file's existing
`### <Name> — <Status>` heading convention with a `Not started` status.

Content to convey:

- **What:** named style presets — for example Draft, Presentation, Analysis — that set every drawn
  feature type's color, opacity, and weight at once, with the individual drawers below for tuning.
- **Why:** most users want a coherent look rather than to tune a dozen properties individually.
  A preset is the fastest path to a map that reads well in a deliverable.
- **Where it builds on:** the per-type style drawers in `js/core/layers-panel.js` and the
  `App.featureSettings` fields they write. A preset is a named bundle of those values plus
  `App.sectionColors`; applying one is a batch write followed by the existing apply functions.
- **Natural pairing:** presentation mode (`App.setPresentMode` in `js/app.js` +
  `js/core/present-overlays.js`) could apply a Presentation preset on entry and restore the
  previous values on exit.
- **Prerequisite:** the property set should be settled first — presets over a moving schema mean
  re-recording every preset on each change.

While editing `features.md`, also correct the **"Layer panel — Not started"** entry: the Layers
panel has since been implemented (`js/core/layers-panel.js`) with visibility, opacity, drag-reorder,
and a basemap selector. Update its status and body to match reality rather than leaving a stale
"Not started" for shipped work.

### Done when

`features.md` describes the presets idea accurately enough to be picked up later without this
plan, and no longer describes the Layers panel as unbuilt.

---

## Out of scope

Do not implement these as part of any phase above.

- **Dash / pattern controls.** Drawn features have no dash property today; adding one means new
  paint properties, new cache fields, and new per-feature overrides. It is the obvious next
  styling axis but it is scope growth, not a port of what exists.
- **Restructuring the Drawn band to nest by geometry type.** Noted in 3.6; hold until the drawers
  prove out.
- **Removing the override icons from the per-feature attribute popup.** Noted in 4.4.
- **Analysis-layer (choropleth) style controls in the Layers panel.** Settled against in
  `docs/layers-panel-styling-eval.md`.
- **Label and text box type-level style defaults.** Labels and text boxes are DOM markers, not map
  layers, and sit outside the `featureSettings` / paint-property model this plan works in. A
  Labels drawer is a reasonable later addition but needs its own design.
