# Layers panel density — implementation plan

Brings the Layers tab (`js/core/layers-panel.js`, `.lp-` styles in `css/style.css`) up to the
space efficiency and interaction conventions the Features tab (`js/core/features.js`, `.fp-`
styles) already uses, so the two tabs of the same 208px panel read as one design.

**Read this whole document before starting any phase.** Each phase is independently shippable
and must leave the app fully working. Do not start a later phase before its predecessor is
complete and verified.

---

## Why (context for the implementing model)

Both tabs live in the same right-side panel (`#fp-tab-features` / `#fp-tab-layers`), which is
**208px wide** — roughly 190px of usable content width after panel padding. The Features tab has
been tuned for that budget over several passes. The Layers tab has not, and still uses its
original row model.

The difference is structural, not cosmetic: **Features hides its controls until you hover;
Layers shows all of them, all the time.**

### Where the 190px actually goes

A Layers feature row (`buildFeatureRow`, `js/core/layers-panel.js` ~line 686) builds this,
every control an in-flow flex child of `.lp-row` with `gap: 6px` and `min-width: 24px`:

| Control | Width | Present when |
|---|---|---|
| `.lp-caret` (style drawer toggle) | 24px | type has overrides |
| `.lp-row-btn` eye | 24px | always |
| `.lp-swatch` color | 24px | always |
| `.lp-style-clear` (clear color ×) | ~20px | **only when the feature has a color override** |
| `.lp-row-label` name | remainder | always |

That is 72–92px of controls plus 24–30px of gaps — **roughly half the row** — leaving ~70px for
the name, and the name's share *changes depending on the data* (the clear-× appears and
disappears). Group headers (`buildGroupBlock` ~line 788) are worse: caret + eye + swatch + name
+ `⋯` menu = 96px of controls and four gaps before any text.

The equivalent Features row (`buildItem`, `js/core/features.js` ~line 545) spends **24px**. Its
eye, gear, and trash are `position: absolute` overlay chips (see `.fp-item > .fp-visibility-btn`
/ `.fp-gear-btn` / `.fp-del-btn`, `css/style.css` ~line 2114–2172) pinned at `right: 48px / 24px
/ 0`, held at `opacity: 0; pointer-events: none` until `.fp-item:hover` or `:focus-within`. They
reserve **zero flow width**, so the name gets the full row until you reach for it. Each chip
carries a solid `background: var(--bg)` plus `box-shadow: 0 0 0 1px var(--border)` so it covers
a long name cleanly instead of letting text bleed through — the comment at `css/style.css:1660`
records why that backdrop is real and not `inherit`.

### The seven patterns Layers is missing

| # | Features has | Layers has | Cost |
|---|---|---|---|
| 1 | Hover-reveal absolute overlay chips | Always-visible in-flow buttons | 50–95px per row |
| 2 | Row gap `2px` (`.fp-group-header`) / none (`.fp-item`) | `gap: 6px` on `.lp-row` | up to 30px per row |
| 3 | One 16px indent step (`.fp-group-body .fp-pattern`) | 16 / 34 / 40px, three ad-hoc values | up to 40px in drawers |
| 4 | `.fp-type-icon` — a type-shaped glyph **tinted with the feature's color**, which is also the color-picker button | Separate 24px `.lp-swatch`, and **no type indicator at all** | 24px, plus you can't tell a line from a route in a mixed group |
| 5 | `.fp-item-hidden { opacity: 0.5 }` dims the row, so the eye can stay hover-only | No dimming, so the eye must stay permanently visible to carry the state | forces #1 to be impossible |
| 6 | `border-left: 3px solid <group color>` on `.fp-group-header` | A full 24px swatch button for the same signal | 24px on every group |
| 7 | Right-click `showContextMenu` on rows and headers; inline `.fp-group-name-edit` rename | Always-visible `⋯` button; `window.prompt()` for rename | 24px, plus a modal dialog no other panel uses |

Rows in Layers also have **no hover or selection linkage to the map** — `buildFeatureRow`
attaches no `mouseenter` and no row click handler, so clicking a feature there does nothing,
while the identical row in Features highlights it on the map and selects it.

**End state:** a Layers row at rest is `[type icon] [name .......................]` — the same
silhouette as a Features row — with its actions appearing on hover in the same place, in the
same chip style, at the same offsets.

---

## Global rules (apply to every phase)

- **No build step.** Plain `var`, IIFE-scoped, matching the surrounding file's style.
- **Design tokens only for chrome.** Use `--space-*`, `--text-*`, `--border`, `--bg`,
  `--muted`, `--accent`, `--danger`. No raw hex for chrome. Feature/data colors are exempt.
- **`.lp-` prefix for new Layers-only CSS**, per `CLAUDE.md`. The one exception is the shared
  chip class introduced in Phase 1, which is deliberately cross-panel and documented as such —
  the same precedent as `.rf-status` being shared across every analysis module.
- **No new DOM ids.** Existing ids (`fp-tab-layers`, `fp-slider-popover`) stay as they are.
- **Do not change what any control does.** This plan moves, merges, and hides controls; it
  changes no map state, no persistence, and no cascade behavior.
- **Dark mode:** `.lp-*` currently has **zero** `body.dark-mode` overrides and works purely off
  tokens. Keep it that way — if a new rule needs a dark override, it is using the wrong token.
- **One commit per phase**, message describing the behavior change, ending with the attribution
  footer used elsewhere in this repo.
- **No phase-number, "new", "legacy", or "unified" language in any UI string.**

### Verification required for every phase

1. `node --check js/core/layers-panel.js` (and `js/core/features.js` if touched).
2. Open `index.html` in a browser, draw at least: 2 lines, 1 route, 1 polygon, 2 points; put
   two of them in a group via the attributes popup's Group field; give exactly one feature a
   custom color so the override path is exercised; hide one feature.
3. Switch to the Layers tab and confirm the phase's stated behavior at the real 208px width.
4. Reload the page and confirm the Layers tab still renders correctly from the restored session.
5. `node test/ui-screens/capture.mjs`, then **inspect the images**, not just the pass count.
   Layers-tab screenshots are *expected* to change in Phases 1–4; nothing else should.
6. `node test/run-golden.mjs` is **not required** — no phase here touches calculation logic.

---

## Phase 1 — Shared hover-chip recipe and the row spacing scale

Pure groundwork: extract the chip pattern Features already uses into one reusable class, and
put Layers rows on the same spacing scale. No controls move yet.

### 1.1 Extract the chip recipe

In `css/style.css`, three rule blocks currently repeat the same recipe with different `right`
offsets: `.fp-gear-btn` (~1647), `.fp-item > .fp-visibility-btn` (~2114), and `.fp-del-btn`
(~2141). Add **one** shared class near the `.fp-item` block and note in a comment that it is
intentionally shared between the Features and Layers tabs:

```css
/* Hover-reveal action chip — shared by .fp-item (Features tab) and .lp-row
   (Layers tab). Absolute so it reserves no flow width: the row's name gets the
   full panel until the pointer arrives. The solid background is a real backdrop,
   not `inherit` — a long name runs underneath these and would otherwise blend
   with the icon. */
.ui-hover-chip {
  position: absolute;
  z-index: 1;
  background: var(--bg);
  border: none;
  border-radius: 4px;
  box-shadow: 0 0 0 1px var(--border);
  cursor: pointer;
  color: var(--muted);
  padding: 4px;
  min-width: 24px;
  min-height: 24px;
  line-height: var(--leading-none);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s, color 0.15s;
}
.ui-hover-chip:focus-visible { opacity: 1; pointer-events: auto; }
```

Then have the three existing `.fp-*` rules use it: add `ui-hover-chip` to the `className` string
in `js/core/features.js` where each is built (`fp-visibility-btn` ~line 555 and ~821,
`fp-gear-btn` ~line 614, `fp-del-btn` ~line 626 and ~906) and delete the now-duplicated
declarations from those three CSS blocks, **keeping** their `right:` offsets and their
hover/`:hover` color rules. The Features tab must look and behave exactly as before — this step
is a pure refactor and the screenshots for the Features tab must be unchanged.

### 1.2 Put `.lp-row` on the same footing

In `css/style.css`, `.lp-row` (~line 472):

- `gap: 6px` → `gap: var(--space-1)` (4px). The chips in Phase 2 are absolute and don't consume
  gap; 4px is the right spacing for the two or three in-flow children that remain.
- Add `position: relative;` so absolute chips anchor to the row.
- Add `border-radius: 4px;` and a hover background matching `.fp-item:hover`, so rows in both
  tabs give the same feedback:
  ```css
  .lp-row:hover { background: var(--accent-soft); }
  ```

### 1.3 Collapse the indent values onto one scale

Three different indents exist today. Replace them with two steps built on `--space-4` (16px),
matching `.fp-group-body .fp-pattern`:

| Selector | Now | Change to |
|---|---|---|
| `.lp-row-sub` | `padding-left: 16px` | `padding-left: var(--space-4)` (unchanged value, tokenized) |
| `.lp-subheading` | `padding-left: 16px` | `padding-left: var(--space-4)` |
| `.lp-style-drawer` | `padding-left: 40px` | `padding-left: var(--space-6)` (24px, already in `:root`) |
| `.lp-style-drawer-feature` | `padding-left: 34px` | remove the rule — it inherits the 24px above |

This returns ~16px of width to every control inside a style drawer.

### 1.4 Dim hidden rows

Add, mirroring `.fp-item.fp-item-hidden`:

```css
.lp-row.lp-row-hidden { opacity: 0.5; }
```

In `buildFeatureRow` (`js/core/layers-panel.js` ~line 691), add `lp-row-hidden` to the row's
class list when `it.feature.properties.hidden` is truthy. In `buildGroupBlock` (~line 793), do
the same on the header when `allHidden` is true. This is what lets Phase 2 hide the eye at rest
without losing the information.

**Done when:** the Features tab is pixel-identical to before; Layers rows highlight on hover,
hidden rows are visibly dimmed, style drawers sit 16px further left, and nothing else moved.

---

## Phase 2 — Hover-reveal the Layers action chips

This is the phase that reclaims the width. Every button that is not the row's primary identity
becomes an overlay chip in the same position it occupies on a Features row.

### 2.1 Feature rows (`buildFeatureRow`, ~line 686)

Target at-rest silhouette: `[caret] [swatch] [name ..............................]`.

| Control | Now | Becomes |
|---|---|---|
| `.lp-caret` | in flow, first | **stays in flow** — it is a disclosure affordance and must be visible to be discoverable, same as `.fp-group-toggle` |
| `.lp-swatch` | in flow | stays in flow for now (Phase 3 merges it into the type icon) |
| eye `.lp-row-btn` | in flow | chip at `right: 0` |
| `.lp-style-clear` color × | in flow, conditional | **removed from the row** — moves to the context menu in Phase 4; until then, move it to a chip at `right: 24px` |
| `.lp-row-label` name | in flow, `flex: 1` | unchanged |

Implementation: add `ui-hover-chip` to each moved button's `className`, add a small positioning
rule per button, and **append them after the name** so DOM order matches Features' documented
order (see the comment at `js/core/features.js:708`):

```css
.lp-row > .lp-row-eye   { right: 0; }
.lp-row > .lp-row-clear { right: 24px; }
.lp-row:hover > .ui-hover-chip,
.lp-row:focus-within > .ui-hover-chip { opacity: 0.92; pointer-events: auto; }
.lp-row > .ui-hover-chip:hover { opacity: 1 !important; }
.lp-row-eye:hover { color: var(--accent); }
.lp-row-clear:hover { color: var(--danger); }
```

Add the `lp-row-eye` / `lp-row-clear` class names in the JS alongside the existing ones. Keep
`.lp-eye-off`'s muted color rule — it still applies while the chip is visible on hover.

### 2.2 Group headers (`buildGroupBlock`, ~line 788)

Target: `[caret] [swatch] [name (n) .........................]` with eye and `⋯` as chips at
`right: 24px` and `right: 0` — the same two-chip layout Features group headers use.

Apply the same treatment to the group `eye` (~line 804) and the `⋯` `menu` button (~line 843),
appending both after the `name` span.

**Careful:** `buildGroupBlock` attaches a `toggleOpen` click handler to the whole header that
early-returns unless the click target is the toggle or the name (~line 866). Chips already call
`e.stopPropagation()`, so this keeps working — but verify the eye and `⋯` still do not
accidentally expand the group.

### 2.3 Analysis / Reference layer rows (`buildLayerRow`, ~line 544)

Target: `[grip] [name ..................................]`, with eye at `right: 48px`, opacity at
`right: 24px`, `⋯` at `right: 0`.

The `.lp-grip` drag handle **stays in flow and stays visible** — a drag affordance that only
appears on hover is undiscoverable, and these rows are the only drag-reorderable thing in the
app. Move the eye, the opacity button, and the `⋯` menu to chips, appended after the name.

**Careful:** `attachDrag` (~line 512) sets `draggable` on the row and listens for
`dragstart`/`dragover`/`drop`. Absolutely-positioned children inside a draggable row can swallow
`dragstart` in some browsers. Verify drag-reorder still works in both the Analysis and
Reference bands after this change, and confirm the `.lp-drop-target` inset shadow still renders
(it is `inset 0 2px 0 var(--accent)` on the row, which the chips must not cover).

**Done when:** at rest, a Layers feature row shows only caret, swatch, and name; a group header
shows only caret, swatch, and name; a layer row shows only grip and name. Every hidden control
reappears on hover or keyboard focus, in the same screen position as its Features-tab
counterpart. Long feature names are fully covered by the chips rather than showing through.
Drag-reorder and group expand/collapse still work.

---

## Phase 3 — Merge the swatch into a tinted type icon

Features solves "what type is this?" and "what color is it?" and "let me change the color" with
a single 24px control: `.fp-type-icon`, a type-shaped SVG whose `style.color` is the feature's
resolved color, clickable to open the color picker
(`js/core/features.js` ~line 568, `css/style.css` ~line 4770). Layers spends 24px on a plain
swatch and still shows no type at all — in a mixed group you cannot tell a line from a route.

### 3.1 Export the icon set

`TYPE_ICON_SVGS` is currently module-private at `js/core/features.js:47`. Export it:

```js
App.TYPE_ICON_SVGS = TYPE_ICON_SVGS;
```

next to the other exports at the bottom of that IIFE. Do not move or restructure the object.

### 3.2 Use it in `buildFeatureRow`

Replace the `.lp-swatch` button (`js/core/layers-panel.js` ~line 731–749) with an
`.fp-type-icon` built the same way Features builds it:

- `innerHTML = (App.TYPE_ICON_SVGS || {})[it.type] || ""` — fall back to keeping the plain
  swatch if the export is somehow missing, so load-order changes can't blank the row.
- `style.color = App.resolveFeatureColor(it.type, it.feature)` — use the Phase 2 resolver from
  `docs/feature-color-system-plan.md`, **not** `properties.color || getTypeDefaultColor(type)`.
  The row must show the same color the map is actually painting, including the Automatic
  rainbow slot.
- Same click handler as today (open `App.openColorPicker`, write `properties.color`,
  `App.rerenderForType`, `App.cache.save()`, `App.refreshFeaturePanel()`, `render()`).
- `title` / `aria-label`: `"Change <Type> color"`, matching Features.

Reuse the existing `.fp-type-icon` CSS as-is — do not fork an `.lp-` copy.

### 3.3 Replace the group swatch with a color stripe

In `buildGroupBlock`, drop the `.lp-swatch` button and instead set a left stripe on the header,
exactly as `buildMixedGroupHeader` does (`js/core/features.js` ~line 840):

```js
header.style.borderLeftColor = firstColor;
```

with matching CSS:

```css
.lp-group-header {
  font-weight: var(--weight-semibold);
  border-left: 3px solid transparent;
  border-radius: 0 4px 4px 0;
}
```

Recovering the group's color-picker action: move it into the `⋯` menu as a **"Change group
color"** entry that calls `App.openColorPicker` anchored to the `⋯` button, running the same
callback the swatch runs today. Net: 24px reclaimed on every group header, and the stripe
carries the color at a glance.

**Done when:** a Layers feature row leads with a colored type glyph that matches both the map
and the same feature's row on the Features tab; group headers carry a 3px colored left stripe;
"Change group color" works from the `⋯` menu; a line and a route in the same group are now
visually distinguishable.

---

## Phase 4 — Context menus and inline rename

### 4.1 Right-click parity

Features rows and group headers open `showContextMenu` on right-click. Add the same to Layers:

- **Feature rows** (`buildFeatureRow`): `contextmenu` listener → `e.preventDefault()` and
  `App.showContextMenu(e.clientX, e.clientY, opts)` with:
  `Zoom to feature`, `Hide`/`Show`, `Clear color override` (only when
  `it.feature.properties.color` is non-empty), `Edit attributes…` (→ `App.openAttrPopup`).
  Once this exists, **delete the `.lp-row-clear` chip added in Phase 2.1** — the override is
  rare enough that a menu entry is the right home for it, and the row's control count stops
  varying with the data.
- **Group headers** (`buildGroupBlock`): same `opts` array the `⋯` button already builds. Build
  it once in a local `groupMenuOptions()` function and have both the `⋯` click handler and the
  new `contextmenu` handler call it — do not duplicate the array.
- **Layer rows** (`buildLayerRow`): same, reusing the existing `opts` array the `⋯` handler builds.

Keep the `⋯` chips. Right-click is the power path; the hover chip is the discoverable one.

### 4.2 Inline group rename

`renameGroup` (~line 883) uses `window.prompt()` — the only `prompt()` in either panel. Replace
it with the inline editor Features uses (`.fp-group-name-edit`, `css/style.css` ~line 2255):
swap the `.lp-row-label` span for an `<input class="fp-group-name-edit">` seeded with the
current name, `select()` it, and commit on `blur` or `Enter` / cancel on `Escape`. The commit
path is the existing body of `renameGroup` (write `attributes[key]`, save, refresh both panels).
Reuse the `.fp-group-name-edit` class; do not fork an `.lp-` copy.

**Done when:** right-clicking any Layers row opens a menu with the same actions its `⋯` button
offers, plus the feature-row actions listed above; the color-clear × is gone from feature rows
and lives in the menu; renaming a group happens inline with no browser dialog.

---

## Phase 5 — Map linkage and style-drawer density

### 5.1 Hover and selection parity

A Features row highlights its feature on the map on `mouseenter` and selects it on click. The
identical row in Layers is inert. Add to `buildFeatureRow`:

- `mouseenter` → `App.setHoveredFeature(it.type, it.index)` (guard `typeof === "function"`).
- `mouseleave` → `App.clearHover()`.
- `click` on the row (not on a chip, the caret, or the type icon — those all
  `stopPropagation()` already) → `App.selectFeature(it.type, it.index)`.
- Reflect the current selection with `.lp-row-selected`, styled to match `.fp-item.fp-selected`
  but using tokens rather than that rule's raw `#dbeafe` / `#93c5fd`:
  ```css
  .lp-row.lp-row-selected { background: var(--accent-soft); outline: 1px solid var(--accent); }
  ```

`App.selectFeature` already triggers a Features-panel refresh; confirm it also reaches
`App.refreshLayersPanel` (via `App.notifyProject`) so the selected row updates on both tabs.
If it does not, call `refreshLayersPanel()` from the click handler rather than widening
`selectFeature`.

### 5.2 Style drawer rows

`.lp-style-row` is `flex-direction: column` — label on one line, control on the next — so each
control costs two lines of height. With the Phase 1 indent fix there is now room for a
single-line layout matching the rest of the app's dense controls:

```css
.lp-style-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
.lp-style-label { flex: 0 1 auto; }
.lp-style-control { flex: 0 0 auto; }
```

Verify at 208px that the longest label in `DRAWN_TYPES` (check the `controls` arrays near the
top of `js/core/layers-panel.js` — the worst cases are `"Outline opacity"` and `"Outline
width"` on Polygons and Buffers) plus its `App.buildScrubber` control still fit without wrapping or clipping. If any
label cannot fit, shorten **that label's text** in the `DRAWN_TYPES` config rather than
reverting the whole rule to stacked — and keep it a plain noun phrase.

**Done when:** hovering a Layers feature row highlights it on the map, clicking selects it, and
the selection is visible on both tabs; each style-drawer control is one line tall; the drawers
at 208px show no wrapped or clipped labels.

---

## Out of scope

Deliberately excluded — do not build these, and do not let a phase drift into them:

- **Merging the two tabs.** Features and Layers stay separate tabs with separate jobs.
- **Making the Features tab match Layers** anywhere the two disagree — Features is the
  reference implementation in every case in this plan.
- **Widening the 208px panel**, or making it resizable.
- **Drag-reorder for drawn features or groups.** Drawn features of a type share one map layer,
  so there is nothing to reorder (this is already noted in `CLAUDE.md`'s `layers-panel.js` entry).
- **Any change to the appearance cascade** — `App.resolveFeatureColor`, `App.sectionColors`,
  `App.featureSettings`, and the `_`-prefixed per-feature overrides all keep their current
  semantics. This plan only changes where their controls sit.
- **New persistence.** `_expandedGroups`, `_expandedTypeStyle`, and `_expandedFeatureStyle` stay
  per-session in-memory state, as today.
- **Virtualizing long lists.** If a user has 500 features the panel is slow in both tabs; that
  is one problem for both, and not this one.
