# Feature color sync — plan

Status: **plan only, nothing implemented yet.**
Builds on `docs/feature-color-system-plan.md` (the color cascade).

## What the user asked for

1. The **Features pane** icon for a line or route must always match the color
   the feature has on the map (red line → red icon).
2. The **Layers pane** "Style defaults" preview for Lines and Routes should be a
   rainbow while the type is on Automatic, or the one color the user picked for
   all of that type.
3. The **Attributes pop-up** swatch (and any other swatch for a feature) must
   show the feature's real color.
4. Division of labor: **Layers = color for every feature of a type at once;
   Features = color for one feature.** Whichever was used **last wins**.
   Example: all Lines blue (Layers) → Line 2 red (Features) → all Lines green
   (Layers) = every line, including Line 2, is green.

## What is going wrong today (root causes)

The map itself is right: it colors every line/route through
`App.resolveFeatureColor` in `js/core/utils.js`, which checks, in order, the
feature's own color, then the type-wide color, then the automatic rainbow slot
(`colorSeq`).

The screens that show color swatches mostly do NOT use that function. They use
`feature.properties.color || App.getTypeDefaultColor(type)`. A new line has no
color of its own (empty = "inherit"), so these screens fall to
`getTypeDefaultColor("line")`, which always returns the *first* rainbow color
(red), and `getTypeDefaultColor("route")`, which returns a fixed teal. They
never look at the feature's rainbow slot, so every line looks red and every
route looks green regardless of the map.

Places with this fault:

| File | What it shows |
|---|---|
| `js/core/features.js` ~601, 607 | per-feature icon in the Features pane (the reported bug) |
| `js/core/features.js` ~877, 886 | group header swatch in the Features pane |
| `js/core/layers-panel.js` ~864 | group header color in the Layers pane |
| `js/core/layers-panel.js` ~187-207 (`updateStylePreview`) | the Style defaults preview line (red for Lines, teal for Routes) |
| `js/core/feature-attributes.js` ~1202 | Attributes pop-up swatch (and the picker's starting color, ~1213) |
| `js/projects/attribute-summary.js` ~641, 646 | Attribute Summary swatch |
| `js/core/present-overlays.js` ~114 | the presentation-mode legend |

Already correct (use `resolveFeatureColor`): map rendering, selection highlight,
the Layers-pane per-feature row icon, service assembly, merge dialog.

Second problem — "last wins" is not implemented. Setting a type-wide color in
Layers only changes `App.sectionColors[type]`. A feature that already has its own
color keeps it (tier 1 beats tier 2), so after "all Lines green" the red Line 2
stays red. Also, a change made in Layers repaints the map but never refreshes the
Features pane, and a change in Features never refreshes the Layers pane's
swatches, so the panes can disagree until something else triggers a redraw.

## Design

### A. One rule for "what color is this feature?"

Every swatch/icon that represents a specific feature calls
`App.resolveFeatureColor(type, feature)`. No more
`properties.color || getTypeDefaultColor(...)` for a feature that exists.
`getTypeDefaultColor` stays only for the "no specific feature" cases (e.g. the
Layers-pane Points/Polygons preview, or a color-picker seed with no feature).

Cleanest way to avoid this drifting again: add two tiny helpers in
`js/core/utils.js` next to `resolveFeatureColor`, and use them everywhere:

- `App.featureHasOwnColor(feature)` — true when `properties.color` is non-empty.
- `App.clearFeatureColorOverrides(type)` — see B. (Lives here because it must
  re-render and touch the cache.)

### B. "Last chosen wins"

- **Features-level change** (per-feature icon, Attributes swatch, Attribute
  Summary swatch, Layers-pane row icon): writes `properties.color` on that one
  feature. Already the behavior; unchanged.
- **Layers-level change** (the Style defaults color swatch, and its × "reset to
  Automatic" button): in addition to setting `App.sectionColors[type]`, **clear
  `properties.color` to `""` on every feature of that type**, so they all inherit
  the new setting. This is what makes Line 2 turn green in the user's example.
  - The × (back to Automatic / rainbow) also clears the overrides, so "reset"
    really means every line goes back to its rainbow color. (Recommended; the
    alternative — leaving custom colors in place — would contradict "last
    action wins".)
  - It takes ONE undo snapshot first (`App.undo.push()`; undo snapshots already
    include `sectionColors`), so a surprised user can Ctrl+Z the whole change,
    including the individual colors that were wiped. No confirmation dialog.
  - Applies to all four types (point, line, route, polygon) for consistency —
    the rule is the same everywhere. Labels are out of scope (they have their own
    section color control that already overwrites every label).
- Group swatches (Features pane and Layers pane group headers) keep their
  current meaning: they are a bulk **feature-level** action (write
  `properties.color` on each member), so they win over an earlier Layers choice
  and lose to a later one. No change beyond showing the correct starting color.
- Group/Service color inheritance (a feature joining a group picks up the
  group's existing color — `feature-attributes.js`, `features.js` ~443-486) is
  untouched: it is just a feature-level color set at that moment.

### C. Showing the right thing in the Layers pane

`updateStylePreview(svg, type)` for Lines and Routes:

- Automatic (`sectionColors[type]` empty): draw the preview stroke with an SVG
  `linearGradient` using the same first six `App.FEATURE_COLORS` the swatch
  already uses, so the preview matches the rainbow swatch beside it.
- A flat color chosen: draw it in that color (already works via
  `getTypeDefaultColor`).
- Points and polygons: unchanged.

### D. Keep the panes in sync

- After any Layers-level color change: call `App.refreshFeaturePanel()` in
  addition to the existing map re-render and `render()` of the Layers pane. If
  the Attributes pop-up is open, rebuild its swatch (it re-reads on
  `populatePopupBody`; add a small `App.refreshAttrPopupColor()` or simply
  re-open it in place — decided during implementation).
- After any Features-level color change: refresh the Layers pane
  (`App.refreshLayersPanel()`) so its row icon matches. (Layers already does this
  for its own row; the Features pane's per-feature icon click currently doesn't.)
- Picker open on a swatch: seed it with the resolved color, not the type default.

## Implementation steps

1. `utils.js`: add `App.clearFeatureColorOverrides(type)` (clears
   `properties.color` on every feature of the type; labels excluded; does not
   push undo itself — caller does so it can be one step).
2. Replace the `properties.color || getTypeDefaultColor` pattern with
   `resolveFeatureColor` in the seven places in the table above.
3. `layers-panel.js`: Style defaults color swatch and × button → push undo, set
   `sectionColors`, call `clearFeatureColorOverrides`, re-render the type, save,
   refresh both panes. `updateStylePreview` gets the rainbow gradient.
4. `features.js` per-feature icon click and the Attributes / Attribute Summary
   swatch handlers: after setting the color, refresh the Layers pane too.
5. `CLAUDE.md`: update the "Feature color cascade" paragraph — the Layers type
   default now also clears per-feature overrides ("last action wins"), and every
   swatch must use `resolveFeatureColor`.

## Things deliberately NOT changing

- The cascade itself (override → type default → automatic) and `colorSeq`.
- Saved sessions: no schema change. Existing files render the same; only the
  swatches become accurate.
- Group-level color actions and the Labels color control.

## Testing

- New browser test `test/feature-color-smoke.mjs` (Playwright, same setup as the
  other smoke tests):
  1. Draw 3 lines and 2 routes; for each, the Features-pane icon color, the
     Attributes pop-up swatch and the map's resolved color all agree, and the
     colors differ from one another (rainbow).
  2. Layers preview for Lines/Routes shows the gradient while Automatic.
  3. The user's scenario: Layers → all Lines blue → every line blue; Line 2 red
     via Features → only Line 2 red; Layers → all Lines green → all green,
     including Line 2; Ctrl+Z restores Line 2 red and the others blue.
  4. Layers × (reset to Automatic) → rainbow returns on every line, including
     a previously custom-colored one.
  5. Same last-wins check for points and polygons.
- Re-run the existing smoke tests (merge, split, GTFS) and
  `node test/run-golden.mjs` (no calculation code is touched, so it should be
  unchanged), and `test/ui-screens/capture.mjs` to eyeball the Features and
  Layers panes in light and dark themes.

## Open questions (my recommendations in bold)

1. Should the × "Reset to Automatic" also wipe individual feature colors?
   **Yes** (consistent with last-wins; undoable).
2. Confirmation before a Layers color change overwrites individual colors?
   **No — one Ctrl+Z undoes it**; a dialog every time would be annoying for a
   routine action.
