# Feature color system — implementation plan

Unifies drawn-feature color into one cascade that resolves at render time, so the Layers tab's
"Style defaults" color swatch behaves like every other control in that drawer.

**Read this whole document before starting any phase.** Each phase is independently shippable
and must leave the app fully working. Do not start a later phase before its predecessor is
complete and verified.

---

## Why (context for the implementing model)

The Layers tab's per-type style drawer (`js/core/layers-panel.js`, search `buildTypeStyleRow`)
holds a color swatch alongside opacity and weight scrubbers. The scrubbers are live type
defaults — change one and every feature of that type follows unless it carries a per-feature
override. **The color swatch is not**, and for three of the four geometry types it does nothing
at all to what is already on the map.

There are currently three unrelated color mechanisms:

| Type | Color at creation | Color at render | Swatch affects existing features? |
|---|---|---|---|
| **Point** | `color: ""` — empty means inherit (`js/core/points.js`, search `pointIdx: idx`) | `["case", has color && ≠ "", get color, sectionColors.point ‖ #2b6cb0]` (search `pointColorExpr`) | **Yes** |
| **Line / Route** | stamped hex: `sectionColors ‖ FEATURE_COLORS[n]` (`lines.js` search `var colorIdx`; `routes.js` same) | `["coalesce", ["get","color"], "#e53e3e"]` — `sectionColors` never reaches here | No |
| **Polygon** | stamped `sectionColors.polygon ‖ #b0c4de` (`polygons.js`, search `var polyColor`) | `["coalesce", ["get","color"], COLOR]` where `COLOR = "#38a169"` | No |

Points are the correct model: color is resolved on every render, and an empty string means
"inherit". Lines, routes, and polygons bake a concrete hex into `properties.color` the moment
the feature is created, so the type default can never reach them again.

Three consequences, all user-visible:

1. **The swatch is mislabelled.** For lines/routes/polygons it is not a default — it is "the
   color the next feature will be stamped with."
2. **The rainbow is a one-way door.** `App.FEATURE_COLORS` (18 colors, `js/core/utils.js`) gives
   each new line/route a distinct color. Set a flat type color and every subsequent feature is
   flat. The drawer's Reset button (search `resetTypeStyle`) does restore rainbow for *future*
   features by setting `sectionColors[type] = null`, but every feature already drawn keeps its
   stamped color forever, and nothing in the UI says so.
3. **`App.sectionColors` is never persisted.** It is declared in `js/core/utils.js` and read in
   six files, but `js/core/cache.js` does not save it. Set a type color, reload, and the setting
   is gone — while every feature drawn while it was set keeps the flat color permanently. This is
   the worst combination available: the transient half survives and the persistent half doesn't.

The polygon path also has dead disagreement worth noticing: creation stamps powder blue
(`App.POLYGON_DEFAULT_COLOR = "#b0c4de"`) while the render fallback is green (`#38a169`). The
fallback is unreachable today because every polygon is stamped at creation. It is evidence that
this path has never been exercised, not a behavior to preserve.

**End state:** one cascade, resolved on every render, identical for all four geometry types.

---

## The model

`properties.color` becomes an **override**, not a value. Empty string (or absent) means inherit.

Resolution order, top wins:

1. **Feature override** — `feature.properties.color`, when non-empty.
2. **Type default** — `App.sectionColors[type]`, when non-empty. A flat color for the whole type.
3. **Automatic** — `App.sectionColors[type] === null`:
   - `line` / `route`: `App.FEATURE_COLORS[feature.properties.colorSeq % FEATURE_COLORS.length]`
   - `point`: `#2b6cb0`
   - `polygon`: `#b0c4de`
   - `label`: `#1a202c`

`null` stops meaning "unset, fall back to a hardcoded literal" and starts meaning an active
choice: *vary them*. That is what makes the rainbow reversible — it is a mode, not a set of
values baked into features.

### Why `colorSeq` is needed

Resolving the rainbow at render time from array position would recolor Lines 3–10 when you delete
Line 2. That is why the current code stamps the hex, and it is a real constraint.

The fix is to stamp the palette **slot** instead of the **color**: `properties.colorSeq`, a
monotonic integer assigned once at creation. Stable under deletion and reordering, and still
reversible, because the color it resolves to depends on the current mode.

Do **not** reuse the existing `properties.seq` (added for the Features list "Date added" sort).
It is assigned lazily on first panel render rather than at creation, and it is shared across all
four geometry types, so lines and routes would not walk the palette contiguously.

### Group swatches are not a tier

The Layers tab's group swatch (`layers-panel.js`, search `Change color for all in group`) writes
`properties.color` onto each member. That is a **bulk write of tier 1**, and it stays that way.
A real group tier would need a `groupColors` map with its own persistence and lifecycle (rename,
delete, merge) for what is a free-text attribute, and would make the cascade four deep. Out of
scope, deliberately.

---

## Global rules — apply to every phase

### User-facing text

- **Never surface internal architecture, phase numbers, migration state, or design rationale in
  UI text.** No "new", "legacy", "migrated", "v2", "(converted)", "now inherits".
- **Label controls with plain nouns.** The Automatic state reads `Automatic`, not `null`,
  `sectionColors`, `rainbow`, or `auto-assign`.
- **Do not add explanatory prose to compensate for a layout.** A short `title=` tooltip on an
  icon-only button is fine; a sentence of body copy in a drawer is not.
- **Do not announce the migration.** Phase 5 rewrites stored feature data. Nothing in the UI
  mentions that it happened.

### Code conventions (from `CLAUDE.md`)

- No build step. Plain `<script>` tags, `var`, IIFE modules assigning onto `window.App`.
- Module-local state stays private inside the IIFE closure. Only intended API goes on `App`.
- **Design tokens only** for chrome. Feature colors, palette swatches, and the Automatic
  gradient are data encodings and keep explicit colors.
- All CSS goes in `css/style.css`, next to the most similar existing block. New style-drawer
  classes use the `.lp-` prefix.
- After every state mutation call `App.cache.save()`.

### The `_` prefix is reserved

In this codebase a leading underscore on a feature property (`_opacity`, `_lineWidth`,
`_bufferRadius`, `_offset`) means **a persisted per-feature override**. The resolved color
computed in Phase 2 is the opposite — derived and transient. Do not name it `_color`. Use
`resolvedColor`, and never write it onto a feature that the cache will serialize (see Phase 2).

### Verification for every phase

1. `node --check <each edited .js file>` — must print nothing / exit 0.
2. Open `index.html` in a browser. Draw at least two lines, two routes, one point, one polygon.
   Exercise every control the phase touched. Confirm no console errors.
3. Reload the page and confirm the session restores with colors and settings intact.
4. Run `node test/ui-screens/capture.mjs` and **look at the images in `test/ui-screens/out/`**,
   not just the pass count. Update `test/ui-screens/baseline/` only when a diff is an intended
   result of the phase.

`node test/run-golden.mjs` is **not** required for any phase here — no calculation logic changes.

### Commit rules

- One commit per phase, after that phase verifies clean.
- Short imperative subject line, then a body explaining what changed and why.
- Do not mention model names or phase numbers from this document in commit messages.
- End every commit message with the attribution footer the session specifies.

---

## Phase 1 — Persist the type default color

**Goal:** `App.sectionColors` survives a reload, a session export, and a session import. No other
behavior changes.

### Why this is first

Everything later is pointless if the setting evaporates on reload. This is also the smallest
independently useful fix in the plan — it makes the swatch that exists today actually stick.

### Files

- `js/core/cache.js` — save and restore `sectionColors`

### Steps

**1.1 — Save it.** In the state-building object (search `bufferRadius:` inside the save payload,
alongside the `featureSettings` fields), add a `sectionColors` entry. Serialize the whole object
rather than field-by-field — it is four nullable strings and the shape is stable:

```js
sectionColors: App.sectionColors ? {
  point:   App.sectionColors.point   || null,
  line:    App.sectionColors.line    || null,
  route:   App.sectionColors.route   || null,
  polygon: App.sectionColors.polygon || null,
  label:   App.sectionColors.label   || null
} : null,
```

Include `label` — `js/core/features.js` (search `sectionColors.label`) already has a live setter
for it in the Labels section, so it is currently just as lossy as the other four.

**1.2 — Restore it.** In the restore path, apply the saved object onto `App.sectionColors`,
field by field with a `null` fallback, so a session saved before this phase restores cleanly.
Do not replace the object wholesale — other modules hold a reference to it.

**1.3 — Re-render after restore.** Restoring a type color must repaint. The existing restore
path already calls the render functions; confirm that `sectionColors` is applied **before**
those calls, not after.

**1.4 — Schema.** This is an additive field, so `SCHEMA_VERSION` (currently `3`) does **not**
change. A v3 file without `sectionColors` restores with all nulls, which is exactly today's
startup state.

### Done when

- Set a Lines color in the Layers tab, reload — the swatch still shows it.
- Export a session, reset, import it — the color comes back.
- Import a session file saved before this change — no error, colors default to automatic.

---

## Phase 2 — One resolver, routed everywhere

**Goal:** a single function is the only place that decides what color a feature is. **No visible
behavior change** — this phase is a pure refactor that makes Phase 3 a two-line switch.

### Files

- `js/core/utils.js` — the resolver, the counter, `colorSeq` stamping helper
- `js/core/features.js` — `getTypeDefaultColor` delegates to the resolver
- `js/core/lines.js`, `js/core/routes.js`, `js/core/polygons.js`, `js/core/points.js` — paint
  expressions and the FeatureCollection builders
- `js/core/service-assembly.js` — one consumer that would otherwise break in Phase 3

### Steps

**2.1 — Add the resolver** to `js/core/utils.js`, next to `App.FEATURE_COLORS`:

```js
App.resolveFeatureColor = function (featureType, feature) { /* tiers 1→3 above */ };
```

Tier 3's line/route branch reads `feature.properties.colorSeq`. When that property is absent
(every feature that exists today), fall back to the feature's current array position using the
same formula the creation sites use now — `App.lines.indexOf(f)` offset by `App.routes.length`
as appropriate — so untouched sessions render byte-identically until Phase 5 stamps real values.

**2.2 — Add the counter.** A module-level integer in `js/core/utils.js` plus
`App._nextColorSeq()`. On cache restore, advance it past the highest `colorSeq` seen across
`App.lines` and `App.routes` so a restored session's next feature does not collide. Do this in
the same restore path Phase 1 touched.

**2.3 — Stamp `colorSeq` at creation**, in addition to (not instead of) the existing `color`
stamp. Three sites: `js/core/lines.js` `saveLine` and `addLineFromCoords` (both search
`var colorIdx`), and the route save in `js/core/routes.js` (same search). Behavior is unchanged
because `color` is still being stamped — this phase only puts the data in place.

**2.4 — Repoint `getTypeDefaultColor`.** `js/core/features.js` (search `function getTypeDefaultColor`)
keeps its signature and its ~9 existing callers, but delegates: it returns what an
un-overridden feature of that type would get. Under Automatic for line/route it has no single
answer, so return `App.FEATURE_COLORS[0]` — callers that need one concrete value (style previews,
color-picker seeds) get something sensible, and Phase 4 gives the swatch itself a truer display.

**2.5 — Fix the paint expressions.** MapLibre's `coalesce` treats only *missing* as absent; an
empty string passes through as a value, and `""` is not a valid color. So the current
`["coalesce", ["get","color"], "#e53e3e"]` in `lines.js` / `routes.js` / `polygons.js` will paint
nothing once Phase 3 lands.

The fallback for line/route under Automatic is per-feature, which a layer-level expression cannot
compute. Resolve it in JS instead: in each module's FeatureCollection builder, **shallow-copy each
feature** and write `resolvedColor` onto the copy, then have the paint expression read
`["get","resolvedColor"]` directly.

Copy, do not mutate — `renderLineLayers` currently passes the live `lines` array straight into
the source, and writing a derived property onto a live feature would leak it into the session
cache. `js/core/selection.js` (search `props.hl_color`) already does exactly this shallow-copy
for the same reason; follow that precedent.

Apply the same treatment to the line and route **buffer** layers, which today follow the feature's
own color via `coalesce` — preserve that.

**2.6 — Point buffers stay type-level.** `js/core/points.js` (search `bufFillLayer`) colors
`buffers-fill` / `buffers-line` from the single `pointColor`, not per-feature. Leave that as is.
A buffer is study-area chrome, not feature identity. This is a deliberate asymmetry with line and
route buffers, which do follow their feature — note it, do not "fix" it here.

**2.7 — Route the outside consumers.** `js/core/service-assembly.js` (search `|| "#888"`) reads
`feature.properties.color` with a gray fallback, feeding the color stripes in Trip Builder and
Route Costing. Once colors go empty in Phase 3 every stripe turns gray. Repoint it at
`App.resolveFeatureColor`.

Audit the other `properties.color` readers while here — `js/projects/attribute-summary.js`,
`js/core/feature-attributes.js`, `js/core/layers-panel.js`, `js/core/present-overlays.js`,
`js/core/selection.js`. Most already use the `properties.color || getTypeDefaultColor(type)`
form, and `||` handles `""` correctly, so they need no change. Confirm rather than assume.

**2.8 — Check the serviceId color inheritance.** `js/projects/attribute-summary.js` (search
`existingColor`) copies a paired feature's color when a `serviceId` is set. With empty colors it
would copy `""`, which harmlessly falls through to the resolver. Verify; likely no change needed.

### Done when

- The app looks pixel-identical to before the phase, in light and dark, in every capture.
- Every drawn line and route carries a `colorSeq` in an exported session.
- Grep finds no remaining `["coalesce", ["get","color"]` in `js/core/`.

---

## Phase 3 — Empty means inherit

**Goal:** newly drawn features inherit the type default instead of being stamped with a color.
Changing the swatch retroactively recolors them.

### Files

- `js/core/lines.js`, `js/core/routes.js`, `js/core/polygons.js`

### Steps

**3.1 — Stop stamping.** At the three creation sites Phase 2.3 touched, plus the polygon save
(`js/core/polygons.js`, search `var polyColor`), set `color: ""` instead of a resolved hex. Keep
stamping `colorSeq` for lines and routes.

`addLineFromCoords` takes an `opts.color`. That is an explicit caller-supplied color and must
still be honored when present — only the *fallback* changes from a stamped palette entry to `""`.

**3.2 — Delete the dead polygon fallback.** With the resolver in place, `polygons.js`'s
module-level `COLOR = "#38a169"` is unreachable. Remove it and let tier 3 supply
`App.POLYGON_DEFAULT_COLOR`. Check for other uses of `COLOR` in that file first — the preview and
vertex-handle layers use it too, and those should keep a fixed color rather than follow the type
default.

### Done when

- Draw three lines → three different palette colors, as today.
- Set the Lines type color → **all three** turn that color, including the ones drawn first.
- Individually color one line, then change the type color → that line keeps its own color, the
  others follow.
- Delete the middle line → the remaining two keep the colors they had.
- Reload → everything is exactly as it was.

---

## Phase 4 — The Automatic state in the UI

**Goal:** the swatch can be returned to Automatic, and a per-feature color can be cleared. The
color control gains the same affordance the other controls in the drawer already have.

### Files

- `js/core/layers-panel.js` — the type style drawer and the per-feature override drawer
- `css/style.css` — the Automatic swatch rendering and the clear button

### Steps

**4.1 — Render the Automatic state.** In `buildTypeStyleRow`'s color branch (search
`Change default color`), when `App.sectionColors[t.type]` is null the swatch shows Automatic
rather than a flat color:

- For `line` / `route`: a small multi-stop gradient built from the first several
  `App.FEATURE_COLORS` entries — it reads as "these vary" at a glance without needing a label.
- For `point` / `polygon`: the flat built-in default. There is no rainbow for these types, so
  Automatic and the built-in default look the same, which is correct — the distinction only
  matters for whether a later default change reaches them.

**4.2 — Add the clear affordance.** Once `sectionColors[t.type]` is non-null, the row gains a
small clear button that sets it back to `null`, re-renders, and saves. This is the same
muted-default-then-clear-button pattern the per-feature override drawers already use — reuse
those classes rather than inventing new ones.

**4.3 — Per-feature clear.** The per-feature row swatch (search `Change color for` in the
feature-row builder) gains the same clear button, shown only when `properties.color` is non-empty,
setting it back to `""`. Feature rows whose color is inherited show the resolved color, exactly as
they do now — the only visible difference is the clear button appearing once you override.

**4.4 — Reset already works.** `resetTypeStyle` (search `resetTypeStyle`) sets
`sectionColors[t.type] = null`, which is now the Automatic state. No change needed, but confirm
it repaints existing features rather than only affecting new ones.

**4.5 — Labels and text boxes are out of scope.** `sectionColors.label` has its own setter in
the Features tab (`js/core/features.js`, search `sectionColors.label`), and labels/text boxes are
DOM markers whose `properties.color` is synced to a background color (`js/core/labels.js`, search
`Sync feature.properties.color`). Phase 1 persists `label`; nothing else in this plan touches it.

### Done when

- Set a Lines color, then clear it → the rainbow comes back for **every** line, including ones
  drawn while the flat color was active.
- The clear button appears only when there is something to clear, on both the type row and the
  feature row.
- Keyboard focus reaches the clear button, and it has an `aria-label`.

---

## Phase 5 — Convert existing sessions

**Goal:** features drawn before this work follow the type default like everything else.

### Why this is last

Phases 3 and 4 leave a real seam: features drawn before the change keep their stamped colors and
ignore the swatch, while new ones follow it. Two lines that look identical behave differently.
That is confusing but not broken, and it is the right dependency order — prove the resolver and
the UI before rewriting stored user data.

### Files

- `js/core/cache.js` — a one-time migration in the restore path

### Steps

**5.1 — Detect auto-assigned colors.** In the restore path, for each line and route: compute what
`App.FEATURE_COLORS[positionalIndex % 18]` would have produced at that feature's position using
the pre-existing formula. If `properties.color` matches it exactly (case-insensitive), the color
was almost certainly auto-assigned — set `color = ""` and stamp a `colorSeq` equal to that
positional index, preserving the exact color it renders today.

For polygons: if `properties.color` equals `App.POLYGON_DEFAULT_COLOR`, clear it to `""`.

For points: no work — they already store `""`.

**5.2 — Leave everything else alone.** A color that does not match the palette slot was chosen by
the user. It stays as a tier-1 override.

**5.3 — Accept the known false positive.** A user who deliberately picked the exact color the
palette would have given that feature loses the override and starts following the type default.
The rendered result is identical until they change the type default, at which point they would
most likely want it to follow anyway. This is the accepted trade; do not build an escape hatch
for it.

**5.4 — Run it once.** Bump `SCHEMA_VERSION` to `4` and migrate v3 → v4 in the existing migration
chain (search `state.version = 3`), so the conversion runs once and is recorded, not on every
restore. A v3 file imported later gets migrated on import by the same code path.

**5.5 — Update the docs.** `CLAUDE.md`: the `App.sectionColors` and `layers-panel.js` entries, and
the `App.featureSettings` cascade description, which should now describe color as part of the same
cascade rather than a separate mechanism. `features.md`: the Layer panel entry mentions per-type
style drawers — extend it to say color is a live default with an Automatic state.

### Done when

- Open a session saved before this work → looks identical.
- Change the Lines type color → the old lines follow.
- Clear it → the old lines return to their original rainbow colors, in their original slots.
- Export, reset, re-import → stable, no second migration.

---

## Out of scope

Named for clarity, so a later phase does not quietly absorb them:

- **Group color as an inheritance tier.** See "Group swatches are not a tier" above.
- **Point buffer color following the point.** Deliberate asymmetry, see Phase 2.6.
- **Label and text box color.** Phase 1 persists `sectionColors.label`; nothing else changes.
- **Choropleth, analysis overlay, and basemap colors.** Different systems entirely.
- **Editing `App.FEATURE_COLORS` itself** — a user-editable palette is a plausible follow-on and
  a natural pairing with the style presets already described in `features.md`, but it is not this.
