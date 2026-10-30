# Attributes Dock — Plan

Replace the floating attributes popup (`#fp-attr-popup`) with a docked attributes panel on the
left edge of the map that opens on a normal left click. Status: **Phase 1 done; Phases 2–4 planned.**

### Phase 1 as built (differences from the plan below)

- Picking a draw tool clears the selection, so an open dock closes when drawing starts; finishing the
  drawing reopens it on the new feature. Clicks while drawing never open it.
- The collapsed rail is 32px (`--ad-rail`), not 24px, so one 26px header button fits.
- A 2+ selection already shows a member list (click one to narrow to it); shared-field editing is still Phase 3.
- Clicking the selected feature while the dock is closed opens it rather than adding a vertex
  ("first click" is always the one that shows attributes).
- The old popup API was renamed outright (`openAttrDock` etc.), with no aliases kept.
- Default-positioned bottom-left floating widgets (analysis legends) start from `--ad-inset`; the
  fixed `#status` strip overlays the dock bottom like it does the Features panel, so `.ad-body` has
  extra bottom padding.
- Fixed while here: inserting/deleting a Line vertex read the removed `#lineBufferRadius` input and
  threw; it now rebuilds at the type default.

## 1. Decisions (agreed)

| Topic | Decision |
|---|---|
| Placement | Left edge of the map, full map height, overlays the map (never resizes it). Analysis panels keep their right-side dock. |
| Look | Same family as the Features panel: flush edge, `--bg`, 1px border, no shadow/radius, same header height and type scale. |
| Open | Any plain left click on a drawn feature (map or Features list) selects it **and** opens the dock. |
| Second click | Second click on the already-selected Line/Route adds a vertex (today's behavior). Polygons: outline only; interior click stays a no-op. Points: no-op. |
| Switching | Clicking another feature replaces the dock's contents. |
| Close | X, Escape, or a click on empty map. **A click inside a buffer counts as empty map.** Selection and dock always open/close together. Optional pin keeps the dock open. |
| After drawing | Finishing any new feature **always** opens the dock on it. |
| Overlap | Fixed priority (points → lines/routes → polygons) plus a "N more here" picker in the header. |
| Features list | Row click opens the dock; the gear icon is removed. |
| Multi-select | Rule-based shared editing (§5); fall back to the first-selected feature only where rules cannot express it. |
| Reference features | Not in this plan. Each reference layer is evaluated separately later (§9). |
| Present mode | Dock hidden. |
| Small screens | Collapses to a 24px rail like the Features panel. |
| Keyboard | Escape closes, Tab order through fields, ARIA region. |
| One-copy rule | `ATTR_FIELDS` stays the single schema; dock and Attribute Summary still change together. |
| Attribute Summary | Stays as the table view; dock footer links to it. |

## 2. Today's behavior this builds on

- `js/core/editing.js:708` — map click. Not in edit mode: point hit → `selectFeature`; line/route/polygon-fill hit →
  `enterVertexEditMode` (select + handles). In edit mode: click on the same line/route or polygon outline →
  `insertVertex`; different feature → switch; empty → `exitEditMode`. Buffer hit (`buffers-fill`,
  `line-buffers-fill`, `route-buffers-fill`) → selects the owning feature (lines 786–802). **This last branch changes.**
- `js/core/selection.js:338` — `selectFeature` re-targets an *open* popup. `toggleMultiSelect`,
  `shiftSelectFeature`, `setSelection`, `clearSelection` do not touch it.
- `js/core/points.js:117`, `lines.js:283`, `routes.js:498`, `polygons.js:258`, `labels.js:113` — new features
  follow an open popup but never open it.
- `js/core/features.js:874` — row click selects only; gear and the right-click "Attributes" item open the popup
  (`features.js:849`, `:895`).
- `#fp-attr-popup` (`feature-attributes.js:1022` `buildPopupEl`, `:1155` `populatePopupBody`) already renders
  read-only length/area (`fmtLength`, `fmtArea`), so measurements exist.
- Close calls in `box-select.js:646`, `merge.js:1097/1225`, `split.js:805`.
- Map controls at bottom-left: scale bar and north arrow (`map.js:480-481`).
- Analysis panels: `.module-popup` (`style.css:2685`), z-index 5000, docked right of the map with
  `padding-right: calc(var(--fp-width) + 25px)`.

## 3. Layout

```
+-------------------------------------------------------------------------------+
| Toolbar                                                                       |
+------------+------------------------------------------------+-----------------+
| Attributes |                 Live map                       | Features/Layers |
| dock       |                         [analysis panel card]  | panel           |
| (320px)    |                                                |                 |
+------------+------------------------------------------------+-----------------+
```

- New `#attr-dock`, absolutely positioned inside the map column (`left:0; top:0; bottom:0`), width
  `var(--ad-width)` (new `:root` token, 320px). It does **not** resize the map.
- z-index **below** `.module-popup` (5000), `#fp-mini-popup` (9100), the Appearance popover and context menus,
  so a wide analysis panel on a narrow screen floats over the dock rather than under it.
- Collapsed state: 24px rail (same treatment as `#feature-panel.fp-collapsed`) showing the feature's type icon
  and swatch; click to expand. Collapse state persists in `localStorage` (per-viewer convenience).
- While open, bottom-left map controls shift right:
  `#app.ad-open .maplibregl-ctrl-bottom-left { left: var(--ad-width); }` (collapsed → 24px).
- Audit every other element positioned against the map's left edge (floating legends, measure readout,
  present overlays, search results) and shift the same way.
- "Zoom to feature" and Features-list Go To use map padding `{left: --ad-width}` while the dock is open, so the
  feature is centered in the visible area.
- Full height; content top-aligned and scrolls inside the dock. The header stays fixed (sticky).

### Dock anatomy

1. **Header (sticky):** Appearance swatch · editable name · type label · action row:
   Zoom to · Duplicate · Hide/Show · Delete · Pin · Collapse · Close (X). "N more here ▾" appears only after an
   overlapping click (§6).
2. **Attributes:** `ATTR_FIELDS` sections ("Transit service", "Walk network", "Study area", …), each collapsible;
   open/closed state remembered per section label in `localStorage`. Fields without a section sit in an
   untitled first section.
3. **Measurements:** length / area / vertex count (moves out of the attribute rows).
4. **Used in:** analyses that reference the feature, from `App.registerFeatureUsage` (`utils.js:304`).
5. **Details:** date added, group, merged-from with an Unmerge link (when `App.merge.hasHistory`), feature id.
6. **Footer link:** "Open in Attribute Summary" (`App.openAttributeSummary()`).

Sections 3–5 fill the space below short attribute lists (polygons have only Group + Notes).

## 4. Click and interaction model

Plain clicks with no draw mode active (`App.drawMode` falsy):

| Click on | Nothing selected / other feature selected | Same feature already selected |
|---|---|---|
| Point | select + open dock | no-op (drag still moves it) |
| Line / Route | select + handles + open dock | insert vertex |
| Polygon outline | select + handles + open dock | insert vertex |
| Polygon interior | select + handles + open dock | no-op |
| Label marker (click without drag) | select + open dock | no-op |
| Text box | focusing it opens the dock (Size / Background / Text color) | — |
| Buffer area | **clear selection + close dock** | same |
| Empty map | clear selection + close dock | same |
| Map drag (pan) | nothing | nothing |

- **Shift-click / Ctrl-click** on the map (via `box-select.js` capture) and in the Features list add/remove from the
  selection; the dock switches to multi mode (§5). Vertex handles only show for a single selection
  (unchanged `syncVertexEditing`).
- **Pin:** while pinned, empty-map and buffer clicks do nothing (selection and dock both stay). Clicking another
  feature still replaces. Pin state persists in `localStorage`.
- **Drawing:** clicks during any draw mode (point, line, route, polygon, label, measure, split picks,
  box-select drags) never open, close or retarget the dock. On finishing a feature, the dock opens on it
  (point: on each placed point).
- **Escape order** (topmost first): mini popup → Appearance popover / context menu → dock → analysis panel.
  One Escape closes one layer. Today `feature-attributes.js:1118`, `:1428` and `app.js:904` each listen
  independently; consolidate so a single press does not close two things.
- **Unsaved typing:** every text/number field commits on `input` (debounced) and again on `blur`. Closing the dock
  for any reason blurs the active field first. A test pins this (§8).
- **Focus:** opening the dock by a map click does **not** move keyboard focus into it, so map shortcuts keep working.
  Delete/Backspace while focus is in a dock input must edit text, never delete the feature (verify the `app.js`
  key handler's input guard).
- **Right-click menus:** remove the "Attributes" item where left click now opens the dock (map menu, Features list,
  label and text-box menus). The Layers-panel row menu (`layers-panel.js:1108`) keeps it until Layers rows select on
  click.

## 5. Multi-select rules

The goal: every selection, however mixed, is handled by the same few rules instead of a case per combination.

**R1 — Which fields show.** A field appears when **every** selected feature's type has a field with that `key` in
`ATTR_FIELDS`, unless the field is marked `bulk: false`. Because `TRANSIT_FIELDS` and `BUFFER_FIELD` are shared
objects, Routes + Lines get all transit fields + Buffer; Points + Routes get Buffer only; Labels + Text boxes get
Size / Background / Text color; any mix with a Polygon gets only Group.

**R2 — Same or mixed.** For each shown field, read every feature's value, treating unset as the field default
(`App.getAttrFieldDefaults`), and compare. All equal → show the value. Otherwise → **Mixed**.

**R3 — How Mixed looks, per field type.**
- text / number: empty input with placeholder "Mixed"
- select: a disabled first option "Mixed"
- color: split swatch
- buffer-radius: "Mixed" readout, scrubber starts at the type default
- group / service pickers: "Mixed" chip

**R4 — Writing.** A committed value writes to every selected feature. One undo snapshot per gesture covers all of
them. Each field's `onChange` runs **once** after all writes (deduplicated by function). Then one
`App.cache.save()`, one `App.notifyProject()`, one `App.refreshFeaturePanel()`.

**R5 — Per-feature eligibility.** A field may declare `appliesTo(feature)`. Writes skip ineligible features and the row
shows a note, e.g. buffer radius on walkshed points: "Skips 2 walkshed points". If no selected feature is eligible,
the row is disabled.

**R6 — Complex editors** (`associatedRoutes`, service schedule / time bands) are marked `bulk: "replace"`. When
values match, the editor edits all. When Mixed, the row shows "Mixed · Replace all…", which opens the editor
**seeded from the first-selected feature** and, on save, copies the result to all. This is the only place the
"first feature" fallback is used.

**R7 — Identity fields** (`name`, `stopId`) are `bulk: false` and hidden in multi mode.

**R8 — Header in multi mode:** "5 selected" plus type chips ("3 Routes", "2 Lines"). Clicking a chip narrows the
selection to that type, so type-specific fields appear. Below the chips is a compact member list; clicking a member
single-selects it. The action row becomes the existing `App.bulkFeatures.groupMenuItems` (Zoom to selection, Merge…
when mergeable, Hide N, Delete N…). The Appearance swatch shows mixed and is disabled (bulk appearance is out of
scope, §9).

**R9 — Info sections in multi mode:** totals (length of lines + routes, area of polygons, count per type) and the
union of "Used in".

**Implementation:** the comparison and field-intersection logic is pure, so it goes in a new engine file
`js/core/attr-bulk.js` (`window.AttrBulk`). It takes `(fieldsByType, features)` and returns
`[{key, field, state: "same"|"mixed", value, eligibleCount}]`, and has no `App`/DOM use so the golden harness can
load it alone. Load it immediately before `feature-attributes.js`. New field flags (`bulk`, `appliesTo`) are
added to the `ATTR_FIELDS` entries.

## 6. Overlapping features

The hit priority already in `editing.js` (points first, then lines/routes, then polygon fill) picks the winner.
Collect the other drawn-feature hits at the same pixel. If there are any, the header shows "N more here ▾",
listing them by type icon + name; choosing one single-selects it. Buffers are never in the list (§4).

## 7. Code changes by file

- `js/core/feature-attributes.js` — replace `buildPopupEl` / drag / clamp / position code with the dock shell.
  Keep `populatePopupBody` and the field builders as the single renderer, split so it can render a single feature
  or an `AttrBulk` result. New API:
  - `App.openAttrDock()` — opens on the current selection
  - `App.closeAttrDock()`
  - `App.isAttrDockOpen()`
  - `App.syncAttrDock()` — re-render from the selection, or close if it is empty and the dock is unpinned
  - `App.getAttrDockFeatures()` — `[{type, index}]`

  Keep `openAttrPopup` / `closeAttrPopup` / `isAttrPopupOpen` / `getAttrPopupFeature` as thin aliases until every
  call site is moved, then delete them in the same phase. Store dock targets as `{type, id}` refs (utils.js),
  resolved on render, so undo/redo and deletes that shift indices cannot point the dock at the wrong feature.
- `js/core/attr-bulk.js` — new pure engine (§5).
- `js/core/selection.js` — `selectFeature`, `toggleMultiSelect`, `shiftSelectFeature`, `setSelection`,
  `clearSelection` each end with `App.syncAttrDock()`. This replaces the current "re-target if open" block.
  Selection functions never *open* the dock; gestures do.
- `js/core/editing.js` — map click: after a select/enter-edit gesture, call `App.openAttrDock()`. The buffer-hit
  branch becomes clear selection (which closes the dock). Collect overlap hits for §6. Respect pin.
- `js/core/features.js` — row click (no modifier) opens the dock; remove the gear and the context-menu
  "Attributes" item; Go To uses dock padding.
- `js/core/labels.js`, `js/core/textboxes.js` — click-without-drag on a label / focus on a text box selects and opens
  the dock; remove "Attributes" menu items.
- `points.js`, `lines.js`, `routes.js`, `polygons.js`, `labels.js` — "follow if open" becomes "open on finish".
- `box-select.js`, `merge.js`, `split.js` — replace explicit close calls with `App.syncAttrDock()` after the
  selection is updated (verify each: deleted / merged-away features must not stay displayed).
- `js/core/undo.js` — after restore, `App.syncAttrDock()`.
- `js/app.js` — Escape ordering (§4); keyboard handler input guard.
- `index.html` — `#attr-dock` markup in the map column; `attr-bulk.js` script tag.
- `css/style.css` — remove `#fp-attr-popup` chrome rules; add `#attr-dock` / `.ad-*` (new namespace) using design
  tokens; keep `.fp-attr-*` field-row classes; `--ad-width` token; present-mode hide; control shifting; rail.
- `js/projects/attribute-summary.js` — honor the new `bulk` / `appliesTo` flags where relevant (no schema change).
- Docs: `CLAUDE.md` (file map, load order, `.ad-` prefix, a "Common Issues" bullet: the dock follows the selection
  and opening happens only on gestures), `docs/reference/drawing-and-features.md`, `docs/reference/ui-layout.md`,
  `docs/reference/script-load-order.md`.

## 8. Tests

- **Golden:** `test/cases/attr-bulk.mjs` covers field intersection for every type pair, default-aware same/mixed,
  `bulk: false` exclusion, `appliesTo` eligibility counts. Seed with `--update`.
- **Browser, new `test/browser/attr-dock.test.mjs`:**
  - click a route → dock open with its name; click it again → vertex count +1, dock unchanged
  - click another feature → replaced; click empty map → closed + selection empty
  - click inside a buffer → closed; pinned → stays
  - clicks while drawing don't touch the dock; finishing a line opens it on the new line
  - type in Notes then click empty map → note saved (reload and check)
  - Escape closes the dock and only the dock when an analysis panel is also open
  - Features row click opens; present mode hides; undo after delete leaves no stale dock
- **Browser, new `test/browser/attr-dock-multi.test.mjs`:**
  - Route + Line selected → transit fields shown, Mixed avg speed; set 20 → both 20; one undo restores both
  - Point + Route → Buffer only
  - Mixed service schedule "Replace all…" copies from the first-selected feature
- **Existing to update:** `test/browser/point-icons.test.mjs`, `test/feature-appearance-smoke.mjs`,
  `test/feature-color-smoke.mjs`, `test/feature-merge-smoke.mjs`, `test/ui-screens/capture.mjs` (all reference
  the popup API / element). Run `hidden-features.test.mjs` (Hide/Show moves into the dock header) and the full
  `run-browser.sh`.
- **Screenshots:** new baseline captures with the dock open (single route, single polygon, multi-select, collapsed
  rail) in light and dark; inspect images, not only pass counts.

## 9. Phases

1. **Dock shell, single feature.** Dock replaces the popup with today's fields; click / list / draw open rules; close
   rules incl. buffer-as-empty; Escape order; pin; collapse rail; present mode; control shifting and zoom padding;
   remove gear and "Attributes" menu items; aliases removed by phase end. Tests + screenshots.
2. **Header and info sections.** Action row, collapsible sections, Measurements, Used in, Details, overlap
   picker, Attribute Summary link.
3. **Multi-select.** `attr-bulk.js` + golden cases, multi rendering, type chips, member list, bulk actions,
   multi tests.
4. **Panel consistency pass.** Align the dock, Features/Layers panel and analysis-panel headers, section headers,
   field rows and spacing on the shared primitives (`.form-field`, `.form-section`, `.rf-*`); screenshot review.

**Later / separate plans:**
- Reference features in the dock: inventory OSM stops/routes (`osm.js:328`), POIs (`osm-pois.js:246`), walk network
  (`network-connectors.js:362`) and GTFS stops one by one; decide per layer whether the dock beats the current
  map popup.
- Bulk appearance editing.
- Resizable dock width.
- Hover preview tooltip.

## 10. Risks

- **Click-to-close vs. accidental closes.** Mitigated by buffers counting as empty, the pin, and commit-on-blur.
- **Left-side overlays hidden under the dock.** Mitigated by the §3 audit.
- **Stale dock after delete/merge/split/undo.** Mitigated by `{type,id}` refs and `syncAttrDock` from the selection.
- **Escape closing two layers at once.** Mitigated by the single ordered handler.
