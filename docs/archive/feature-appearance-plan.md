# Feature Appearance Plan — shared Appearance popover, Study-area buffer, Line style

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/drawing-and-features.md. This file is historical.


Three phases, each shippable on its own:

| Phase | What the user sees | Risk |
|---|---|---|
| 1 | Clicking any per-feature color swatch opens one **Appearance** popover: color, opacity, width, offset (lines/routes). | Routine (UI consolidation) |
| 2 | Per-feature **buffer radius** moves into a "Study area" section of the Attributes popup. | Routine, but touches the two-surface rule |
| 3 | Per-feature **line style** (solid / dashed / dotted) for Lines and Routes. | **Delicate** — map layer split + hit-testing |

Line references are against the branch head when this plan was written; re-check them before editing.

---

## 0. Current state (what exists today)

**Per-feature appearance overrides** live on `feature.properties`:
`color` (`""` = inherit), `_opacity` (points/lines/routes, 0–1), `_fillOpacity` + `_borderOpacity` (polygons, derived together from one slider by `App._polyOpacityValues`), `_lineWidth` (multiplier), `_offset` + `_offsetManual` (lines/routes, px), `_bufferRadius` (mi; points/lines/routes).

**Edit surfaces, all different:**

| Surface | File / location | Color | Other overrides |
|---|---|---|---|
| Features list row type icon | `js/core/features.js` ~L615-640 (`typeIcon`) | `App.openColorPicker` → `App.updateFeatureColor` | none |
| Attributes popup header swatch | `js/core/feature-attributes.js` `populatePopupBody` ~L1229-1250 | same | icon strip from `buildOverridesContainer` (~L1020-1215) via `_openFpSlider`: opacity / buffer / width / offset / reset |
| Layers tab feature row swatch | `js/core/layers-panel.js` ~L1082 | same | caret → `buildFeatureOverrideDrawer` (L338-440): opacity / width / offset / buffer rows built by `buildOverrideRow` (muted default + × clear) |
| Attribute Summary swatch | `js/projects/attribute-summary.js` `buildSwatchCell` L638-655 | same | none (CLAUDE.md: appearance not editable there) |

- `App.buildOverrideIcons` (`feature-attributes.js` L1604) is a thin export of `buildOverridesContainer`. Grep shows **no caller outside feature-attributes.js** (Attribute Summary does not call it, despite CLAUDE.md's load-order note listing it as a dependency).
- Undo: `App.updateFeatureColor` (`features.js` L219) pushes one `App.undo.push()` per call. The Layers drawer's `setValue`/`clearValue` and the Attributes icon sliders **push no undo at all** today — an inconsistency Phase 1 fixes.
- Map paint: `App.applyFeatureOpacity` / `App.applyLineWidth` (`js/app.js` L535-590) set data-driven `case`/`has` expressions on `points-layer`, `lines-layer`, `routes-layer`, `polygons-fill`, `polygons-outlines-layer`. `line-offset` is set at `addLayer` time (`lines.js` L159, `routes.js` L235).

---

## Phase 1 — Shared "Appearance" popover (routine)

### 1.1 Design

One singleton popover, `#fp-appearance-popover`, anchored to the clicked swatch, built by a new core file **`js/core/feature-appearance.js`** (new file rather than growing `feature-attributes.js` past 1,600 lines; it is appearance, not attributes). Load it after `features.js` and before `feature-attributes.js`/`layers-panel.js` in `index.html`.

```
┌ Appearance — Route 3 ───────── × ┐
│ Color    [■ swatch grid / custom]  ×   ← × only when properties.color set
│ Opacity  [− 80% +]   (muted = default)  ×
│ Width    [− 1.0× +]                 ×
│ Offset   [− 0 px +]   (lines/routes)×
│                     [Reset all]        │
└────────────────────────────────────────┘
```

Public API:

- `App.openAppearancePopup(anchorEl, type, index, opts)` — `type` ∈ point/line/route/polygon. `opts.onChange()` lets the caller refresh its own swatch. Re-opening on the same feature toggles closed; a different feature replaces content.
- `App.closeAppearancePopup()`, `App.isAppearancePopupOpen()`.
- `App.buildFeatureOverrideRows(type, feature, {onChange})` — returns the DOM rows (opacity/width/offset; `opts.includeBuffer` for Phase 2 transition). The **Layers drawer and the popover both call this**, so the cascade logic lives once.

**Color row:** reuse the existing picker body rather than writing a new one. `features.js` `openColorPicker` (L178) currently builds a floating picker anchored to an element; refactor its body into `buildColorPickerBody(currentColor, onPick)` and keep `openColorPicker` as a wrapper (it is also used by labels, type defaults, layer-style drawers, gradients — those keep using the floating version). The popover embeds the body inline. Writes go through `App.updateFeatureColor` (unchanged; it already does one undo push + rerender + panel refresh). The × clear calls `App.updateFeatureColor(type, idx, "")`.

**Opacity / Width / Offset rows:** move `buildOverrideRow` + the per-row `hasOverride/getValue/setValue/clearValue` specs out of `layers-panel.js` `buildFeatureOverrideDrawer` (L338-410) into `feature-appearance.js`. Semantics stay byte-identical (polygon opacity via `_polyOpacityValues` / `_invertPolyFill`, offset via `_offset` + `_offsetManual`, offset-clear re-runs `App.computeOverlapOffsets()` when `#offsetOverlap` is checked).

**Undo — one snapshot per change, matching color:** a scrubber fires `onChange` continuously while dragging. Push `App.undo.push()` **once per gesture**: on the first `setValue`/`clearValue` after the popover opened or after a 600 ms idle gap (simple `_lastPushAt` timestamp per open). This matches `updateFeatureColor` (one push per pick) without flooding the stack during a drag. Note this also *adds* undo to the Layers drawer, which has none today — call it out in the commit message.

**Refresh fan-out after any change:** `App.rerenderForType(type)` (already what `_pushFeatureLayer` does), `App.cache.save()`, `App.refreshFeaturePanel()`, `App.refreshLayersPanel()`, and if the Attributes popup shows this feature, update its header swatch (export a tiny `App.refreshAttrPopupSwatch()` from feature-attributes.js). Use a guard so the popover's own DOM is not destroyed by `refreshLayersPanel` (popover lives on `document.body`, not inside `.fp-content`).

**Dismissal:** Escape, outside mousedown, ×. Must not conflict with `#fp-slider-popover` (the popover no longer opens it), `#fp-mini-popup`, or `App.showContextMenu`. Z-index 9150 (above attr popup 9000 and mini-popup 9100). Clamp to viewport like `#fp-attr-popup`. Suppress the global single-key draw shortcuts while focus is inside (the `app.js` shortcut listener already skips inputs; the scrubber's typed field is an input — verify).

### 1.2 Wire-up per surface

| Surface | Change |
|---|---|
| `features.js` ~L625-640 type icon click | replace `openColorPicker` call with `App.openAppearancePopup(btn, ft, fi, {onChange: () => btn.style.color = App.resolveFeatureColor(ft, feat)})`. Labels (L823) and textboxes (L929) **unchanged** — they have no appearance cascade. Update `title` to "Appearance". |
| `feature-attributes.js` `populatePopupBody` L1229-1250 header swatch | open the popover instead of the picker. **Remove** the `buildOverridesContainer` strip (L1252+) from the header. |
| `feature-attributes.js` L1020-1215 `buildOverridesContainer`, `_OVR_*_SVG`, L1604 `App.buildOverrideIcons` | **Retire deliberately.** No external caller exists (verified by grep). Delete the function, the SVG constants, the export, and the `.fp-attr-overrides`/`.fp-sib-has-override` CSS if unused elsewhere (grep `fp-sib` first — Attribute Summary's copy button uses `.fp-sib`, so keep that class). Remove `App.buildOverrideIcons` from CLAUDE.md. |
| `layers-panel.js` ~L1082 feature-row swatch | open the popover. |
| `layers-panel.js` `buildFeatureOverrideDrawer` L338-440 | keep the caret drawer (it's the scan-many-features surface) but build its rows with `App.buildFeatureOverrideRows`. Decide: keep drawer or drop it? **Recommendation: keep** in Phase 1 (zero-regression), revisit in a density pass. |
| `attribute-summary.js` `buildSwatchCell` L638-655 | open the popover. The "attribute data only" rule in CLAUDE.md is about *columns*; a swatch that opens a shared popover adds no column and no duplicated editor, so the two-surface rule is satisfied. Update the CLAUDE.md sentence. L720 (`buildColorSwatchCell` for textbox/label colors) **unchanged**. |
| `feature-attributes.js` L373, L498, L568 | other color fields (attribute-level colors, Service color inheritance) — inspect; leave unchanged unless they are the feature's own `properties.color`. |

### 1.3 Files

- New: `js/core/feature-appearance.js`; `index.html` script tag.
- Edit: `js/core/features.js` (picker refactor + row icon), `js/core/feature-attributes.js` (swatch, retire strip), `js/core/layers-panel.js` (row swatch, drawer rows), `js/projects/attribute-summary.js` (swatch), `css/style.css` (`.fa-*` popover styles using tokens/`--space-*`; reuse `.lp-style-row`/`.lp-style-clear` look).

### 1.4 Risks
- Picker refactor touches every color picker in the app (labels, type defaults, layer palettes, gradient stops) — keep the wrapper signature identical.
- `refreshLayersPanel()` rebuilding while the popover is open → stale feature reference if the feature was deleted/merged meanwhile. Popover holds `{type, id}` (stable ID, `App.featureRef`) and resolves on every write; closes if `-1`.
- Undo restore while open → feature objects are replaced; same resolve-by-ID rule handles it.
- Dark mode + narrow viewport styling.

### 1.5 Tests
- `node test/run-golden.mjs` — no math changes expected; run as a regression check (pure Node, works as-is).
- `bash test/browser/run-browser.sh` — not strictly required (no persistence/lifecycle change) but cheap.
- UI screens: `NODE_PATH=/opt/node-tools/node_modules node test/ui-screens/capture.mjs` (Playwright is installed at `/opt/node-tools/node_modules/playwright` in this environment). Attributes popup header will change → expected diff; re-baseline after inspecting. Add a capture state: `<theme>_appearance-popover.png`.
- Existing smokes (same `NODE_PATH`): `test/feature-color-smoke.mjs` (must still pass — it drives swatches; update selectors if it clicks the type icon expecting the bare picker), `test/feature-merge-smoke.mjs`, `test/feature-split-smoke.mjs`, `test/box-select-smoke.mjs`.
- **New smoke** `test/feature-appearance-smoke.mjs` (copy the harness header from `feature-color-smoke.mjs`): draw a line; open the popover from each of the four surfaces; set opacity → assert `properties._opacity` and the `lines-layer` rendered opacity; × clears it; set width/offset; color pick → `properties.color`; "last action wins" still holds after a Layers type-color change; one undo step per gesture (drag scrubber, undo once → value restored); polygon opacity writes both `_fillOpacity`/`_borderOpacity`; Escape closes.

### 1.6 CLAUDE.md updates
New `feature-appearance.js` File Structure entry + API section; Script Load Order line; remove `App.buildOverrideIcons` (feature-attributes.js API section and attribute-summary.js load-order deps); update `layers-panel.js` entry ("per-feature drawer rows built by `App.buildFeatureOverrideRows`"); Attribute Summary "appearance not editable here" → "swatch opens the shared Appearance popover"; Attributes popup description (no override icon strip).

### 1.7 Done checklist
- [ ] Popover opens from Features row, Attributes header, Layers row, Attribute Summary swatch.
- [ ] Muted default / override / × semantics identical to the Layers drawer.
- [ ] One undo per color pick and per scrub gesture.
- [ ] `buildOverridesContainer` + `App.buildOverrideIcons` removed; no dangling references (`grep -rn buildOverrideIcons`).
- [ ] Labels/textboxes still use the plain picker.
- [ ] Golden PASS, ui-screens re-baselined with inspected diffs, all smokes PASS, new smoke PASS.
- [ ] CLAUDE.md updated in the same commit.

---

## Phase 2 — Buffer radius → "Study area" section (routine; two-surface rule)

### 2.1 Design
Buffer radius is geometry (it changes analysis study areas), not appearance — it belongs with `serviceAreaType` in Attributes.

- **Points:** `ATTR_FIELDS.point` (`feature-attributes.js` ~L78) — tag `serviceAreaType` with `section: "Study area"` and add a new field `bufferRadius` right after it, rendered with a new field `type: "override-number"` (or a custom builder) that shows the type default (`App.featureSettings.bufferRadius`) muted until `properties._bufferRadius` is set, with × clear. **Note: it reads/writes `properties._bufferRadius`, not `attributes.*`** — the field needs a `target: "properties"` flag so the generic renderer doesn't write into `attributes`. Disable (with a hint "Walkshed replaces the buffer") when `serviceAreaType === "walkshed"`, since `points.js rebuildBuffers()` substitutes the walkshed.
- **Lines/Routes:** `LINE_FIELDS` and `ROUTE_FIELDS` get the same field under `section: "Study area"`. Routes currently have no sections — adding one to `ROUTE_FIELDS` means Lines' "Transit service" tagging (done by mapping over ROUTE_FIELDS) must not double-tag; restructure so `ROUTE_FIELDS` itself carries `section: "Transit service"` for the existing fields and a trailing "Study area" section, and `LINE_FIELDS` appends "Walk network". Check the renderer's section-header logic emits headers for routes too.
- Values: same steps list `App.BUFFER_RADIUS_STEPS` scrubber as the Layers drawer. Writes call the existing rebuild (`App.rebuildBuffers` / `rebuildLineBuffers` / `rebuildRouteBuffers` with the type default — see `REBUILD_FNS` in `layers-panel.js` L419-435), then `App.notifyProject()` (study areas changed → analysis modules go stale), `App.cache.save()`, one `App.undo.push()` per gesture (reuse Phase 1's helper).
- Polygons: no field (they're areas).

**Layers per-feature drawer — decision: remove the Buffer row.** Justification: the drawer is now "appearance"; leaving buffer there keeps two editors for one value and the "geometry rather than appearance, but no other home" comment (L414) no longer holds. The Style-defaults *type* drawer keeps the type-level buffer radius (that's the default, a display setting). Also remove `includeBuffer` from `App.buildFeatureOverrideRows`.

**Attribute Summary — decision: add a "Buffer" column** to Points, Lines and Routes (numeric cell showing default muted / override / blank-clears), because it's now an attribute-like, study-area-defining value and the two-surface rule requires the surfaces to match. Not added to Copy Attributes (`COPY_FIELD_DEFS`) in this phase — copying a geometry override is plausible but out of scope; note as follow-up. Implement via a shared `App.buildBufferRadiusControl(type, feature, opts)` exported from `feature-attributes.js` so both surfaces call the same code (the pattern CLAUDE.md asks for).

### 2.2 Files
- `js/core/feature-attributes.js`: ATTR_FIELDS/ROUTE_FIELDS/LINE_FIELDS, renderer support for `target: "properties"` override fields, `App.buildBufferRadiusControl`.
- `js/projects/attribute-summary.js`: `renderPoints`, `renderLineLike` — new cell.
- `css/style.css`: `.as-grid-points` and `.as-grid-routelike` gain one column (header + data rows share the template; order must match).
- `js/core/layers-panel.js`: drop Buffer row from `buildFeatureOverrideDrawer` (L414-438), drop now-unused `BUFFER_KEYS`/`REBUILD_FNS` if nothing else uses them.
- `js/core/merge.js` `APPEARANCE_KEYS` (L657) still includes `_bufferRadius` — fine (it's copied onto the survivor); optionally rename the comment.

### 2.3 Risks
- Writing to `properties` from the attributes renderer — must not lazily create `attributes._bufferRadius`.
- Walkshed-flagged points: buffer is ignored; UI must say so, not silently accept.
- `notifyProject()` on every scrub tick is expensive (modules recompute stale state) — fire on gesture end (`change`), live-rebuild buffers on `input`.
- Grid template mismatch in Attribute Summary → misaligned columns (ui-screens catches it).

### 2.4 Tests
Golden (regression; `test/cases/module-buffers.mjs` should be unchanged); ui-screens (attr popup, attribute summary — expected diffs); `feature-color-smoke`, merge/split smokes. Extend `test/feature-appearance-smoke.mjs`: set point buffer in Attributes → `_bufferRadius` set and `App.buffers[i]` area changes; × clears; Attribute Summary cell reflects the same value live; walkshed point shows disabled control; Layers drawer has no Buffer row; one undo restores.

### 2.5 CLAUDE.md
`feature-attributes.js` entry (Study area section, `bufferRadius` field writing `properties._bufferRadius`, `App.buildBufferRadiusControl`); Attribute Summary column list (Points: + Buffer; Lines/Routes: + Buffer); `layers-panel.js` per-feature drawer field list (buffer removed); `App.featureSettings` note "per-feature `_bufferRadius` edited from the Attributes popup / Attribute Summary".

### 2.6 Done checklist
- [ ] Study area section on points (with service area type), lines, routes.
- [ ] Attribute Summary Buffer column, grid CSS updated, columns aligned in both themes.
- [ ] Layers drawer Buffer row removed.
- [ ] Analysis modules mark stale after a buffer change.
- [ ] Tests as above; CLAUDE.md updated.

---

## Phase 3 — Per-feature line style for Lines and Routes (DELICATE)

### 3.1 Data model
`properties._lineStyle`: `"solid" | "dashed" | "dotted"`; absent/`""` = solid. Per-feature only (no type-level default in this phase; a `featureSettings.lineStyle`/`routeStyle` default is a possible follow-up). Added as a fourth row ("Style", 3-way segmented control) in the Phase 1 popover for lines/routes, with × clear.

### 3.2 Why a layer split
MapLibre `line-dasharray` accepts only a constant or zoom function — not a data expression (same pitfall documented for `walk-network-line` in CLAUDE.md: a `["case", …]` there makes `addLayer` silently fail and the whole layer disappears). So: same source, three layers, each with a `filter`.

| Old id | New ids | filter |
|---|---|---|
| `lines-layer` | `lines-layer` (solid — **keep the id**), `lines-layer-dashed`, `lines-layer-dotted` | solid: `["!", ["in", ["coalesce", ["get","_lineStyle"], ""], ["literal", ["dashed","dotted"]]]]`; dashed: `["==", ["get","_lineStyle"], "dashed"]`; dotted likewise |
| `routes-layer` | `routes-layer`, `routes-layer-dashed`, `routes-layer-dotted` | same |

Keeping the original id as the solid layer means every existing reference keeps working for the common case and only needs *extending*, not renaming. Add `App.LINE_STYLE_LAYERS = { line: [...3 ids], route: [...3 ids] }` (in `app.js` or `utils.js`) and make every consumer iterate it.

**Dash arrays (units are line-widths):** dashed `[3, 2]` (matches the in-progress drawing preview look but at full opacity — consider `[4, 2.5]` to stay distinguishable from the drawing preview, which is `[3,2]` at 0.6 opacity). Dotted: `[0, 2]` with `layout: {"line-cap": "round"}` — a zero-length dash plus round caps renders circles of diameter = line width spaced 2 widths apart. This is a known working MapLibre trick; caveats: (a) `line-cap` is a *layout* property, so it must be set on the dotted layer only; (b) at width ≤ 1.5px dots get faint — acceptable, or clamp with `[0.001, 2]` if a renderer drops zero-length dashes (verify in headless Chromium in the smoke test via a pixel sample). **Dotted is feasible in Phase 3; no Phase 4 needed** unless the pixel check fails.

Dash scaling: dasharray is multiplied by line width, so `_lineWidth` overrides keep the pattern proportional — good, no extra work. `line-offset` must be copied onto all three layers.

### 3.3 Every reference to update (grep-verified)

| File | Lines | Change | Delicacy |
|---|---|---|---|
| `js/core/lines.js` | L153-163 `renderLineLayers` | create 3 layers (create-once), same paint incl. `line-offset`; then call `App.applyFeatureOpacity("line")`/`applyLineWidth("line")` already done by callers? — verify current flow re-applies after first `addLayer` | routine |
| `js/core/routes.js` | L229-239 `renderRouteLayers` | same | routine |
| `js/app.js` | L544-549, L578-583 `applyFeatureOpacity`/`applyLineWidth` | loop over the 3 ids per type | routine |
| `js/app.js` | L456-475 `_withResolvedColorForOffset`/`_pushOffsetSources` | setData onto shared source — no change (props copied incl. `_lineStyle`) | routine |
| `js/core/editing.js` | L410-417, L444-452, L700-716, L766-796, L828-838 | every `safeQuery([...,"lines-layer","routes-layer",...])` must include the dashed/dotted ids, and every `lid === "lines-layer"` comparison becomes `isLineLayer(lid)` / `isRouteLayer(lid)` helpers | **DELICATE** — hit-testing for select, right-click menu, vertex-edit entry, drag; regressions are silent (dashed features just become unclickable) |
| `js/core/editing.js` | L545, L573 drag previews setData onto `lines`/`routes` source | must keep `_lineStyle` in preview props or a dashed line flashes solid during drag | delicate-ish |
| `js/core/box-select.js` | projects from `App.lines/routes` arrays, not layers (grep shows no layer ids) — **confirm**; click-fallback "topmost feature under cursor" may query layers | verify |
| `js/core/selection.js` | L114-124 `hl-line` | highlight is solid on top — decide: keep solid (clear "selected" signal) or match style. **Recommend keep solid** but slightly translucent-casing so the dash pattern underneath is visible; or no change. | routine |
| `js/projects/gtfs.js` L442, `js/core/walk-audit.js` L127, `js/core/network-connectors.js` L153 | `firstUserLayer()` candidate lists for insert-below | add the new ids (or rely on `lines-layer` still existing; but a map with **only** dashed lines would still have `lines-layer` present since layers are create-once regardless of features — verify that holds, then no change needed) | routine |
| `js/core/layers-panel.js` | drawn band — drawn layers aren't in the manifest; visibility uses `properties.hidden`. `applyBandOrder` anchors on the layer above the band — the new layers sit with drawn features, fine | verify |
| `js/core/split.js` | `split-preview-*` added above drawn features; `test/feature-split-smoke.mjs` L300 asserts above `lines-layer` — extend to assert above all 3 | routine |
| `js/core/present-overlays.js` / present mode | no layer ids referenced — verify | verify |
| Appearance copying | `merge.js` `APPEARANCE_KEYS` L657 → add `_lineStyle`; `lines.js`/`routes.js` `duplicateX` (L364+) build fresh props — **decide**: duplicate copies `color` but not overrides today; add `_lineStyle` alongside or leave consistent with other overrides (recommend: copy `_lineStyle`, it's visual identity like color); `split.js` "copied attributes/appearance overrides" — confirm it copies all `_`-prefixed keys or add `_lineStyle` explicitly; `cache.js` exports — `_lineStyle` should be stripped from feature exports like other `_` props? Check what JSON(Features only)/KML do with `_opacity`; follow the same rule. | routine but easy to miss |
| `js/core/layers-panel.js` feature-row swatch / Style-defaults SVG preview | optional: render preview stroke with `stroke-dasharray` | cosmetic |
| `features.js` Features-pane line icon | optional dashed SVG stroke | cosmetic |

Layer order: add dashed/dotted directly after the solid layer (`addLayer(spec, beforeId = next layer after lines-layer)` or add in sequence immediately) so all three sit in the same z-slot; all must remain below vertex/waypoint dot layers and edit handles.

### 3.4 Risks
- **Hit-testing regressions** (biggest): a missed `"lines-layer"` literal leaves dashed features unselectable/undraggable/no right-click menu. Mitigation: introduce helpers first (`App.drawnLineLayerIds()`, `layerToType(lid)`) and replace every literal in one sweep; add a grep check to the done list (`grep -rn '"lines-layer"\|"routes-layer"' js` should show only the helper and the solid-layer creation).
- Silent `addLayer` failure if any data expression slips into `line-dasharray`/`line-cap` — smoke test asserts `map.getLayer(id)` exists for all six.
- Filter coverage gaps — the solid filter must catch `undefined`, `""`, `"solid"` and unknown values, so a feature never vanishes; smoke test asserts rendered-feature counts across the three layers sum to the number of visible lines.
- Overlap offsets and opacity/width overrides must apply on all three.
- ui-screens baselines: unchanged when no feature uses a style (verify zero diff — strong no-op check).

### 3.5 Tests
- Golden: no change expected. If a pure helper (e.g. `App.lineStyleFilter(style)` / `layerToType`) is added in a turf-free spot, add `test/cases/line-style.mjs` and seed with `--update`.
- `bash test/browser/run-browser.sh` — **yes, run it** (map-layer create/update lifecycle is in its scope). Consider adding `test/browser/line-style.test.mjs` here instead of a top-level smoke, per `test/browser/README.md` guidance (import from `harness.mjs`, poll state).
- ui-screens: zero diff with no styles set; add one state with a dashed + dotted line.
- All existing smokes, especially `feature-split-smoke` (layer order assertion), `feature-merge-smoke`, `box-select-smoke`.
- **New behavior test** asserts: six layers exist; setting `_lineStyle` moves a feature between layers (`queryRenderedFeatures` per layer); click-select, right-click menu, vertex-edit entry and drag work on a dashed and a dotted line and route; opacity/width/offset overrides apply on dashed layers (`getPaintProperty`); merge of a dashed primary keeps `_lineStyle`; split pieces keep it; duplicate keeps it; undo restores; session save/reload preserves it; dotted pixel sample shows gaps (non-uniform alpha along the line).

### 3.6 CLAUDE.md
`lines.js`/`routes.js` API sections (three layers, `_lineStyle`); `App.featureSettings` per-feature override list (+ `_lineStyle`); `editing.js` entry (hit-testing via helper); `merge.js` APPEARANCE_KEYS mention; a "Common Issues to Prevent" bullet: *"Drawn lines/routes render in three style layers — never reference `lines-layer`/`routes-layer` literally; use `App.LINE_STYLE_LAYERS`."*

### 3.7 Done checklist
- [ ] Helper + constant introduced; literal grep clean.
- [ ] Six layers created, filters total, dotted renders as dots.
- [ ] Select / right-click / vertex edit / drag / box-select all work on dashed+dotted.
- [ ] Opacity, width, offset, overlap offsets, hidden, highlight all correct.
- [ ] Merge / split / duplicate / undo / session restore preserve `_lineStyle`; feature exports follow the `_`-prop rule.
- [ ] Golden, browser tests, ui-screens (zero diff without styles), smokes all PASS; CLAUDE.md updated.

---

## Open questions
1. **Layers per-feature drawer after Phase 1** — keep it (recommended, Phase 1) or drop it in favor of the popover only?
2. **Undo granularity for scrubbers** — one snapshot per gesture (600 ms idle) acceptable, or strictly one per popover session?
3. **Attribute Summary Buffer column** (Phase 2) — agreed? And should `_bufferRadius` join Copy Attributes?
4. **Type-level default line style** (`featureSettings.lineStyle`) — wanted, or per-feature only?
5. **Duplicate** currently doesn't copy opacity/width/offset overrides — should Phase 3 copy `_lineStyle` only, or fix duplicate to copy all appearance overrides?
6. **Selection highlight** on dashed lines — solid highlight (recommended) or style-matched?

## Decisions on open questions (orchestrator, 2026-10-02)

1. Layers per-feature drawer: **keep** after Phase 1 (it shares the same row builder, so no drift).
2. Undo granularity: **one undo step per slider drag / per discrete change**.
3. Attribute Summary Buffer column: **yes**, and `_bufferRadius` is **copyable** via Copy Attributes.
4. Line style: **per-feature only** for now; no type-wide default.
5. Duplicate: copies **all** per-feature appearance overrides (color, opacity, width, offset, line style, buffer), matching what a user expects from "duplicate".
6. Selection highlight: **stays solid** on dashed/dotted lines.
