# Features Panel Sorting — Implementation Plan

**Status:** Approved, not yet implemented
**Branch:** `claude/features-menu-sorting-tr9xv8`
**Scope decision:** Tier 1 sort keys only. Labels and Text section is **out of scope**.

---

## 1. Goal

Let the user choose how the right-side **Features** list is ordered, instead of the
current hardcoded alphabetical sort. Four sort keys (Name, Type, Date added, Group),
an ascending/descending toggle, and a show/hide-groups toggle, reachable from a small
sort icon in the panel header and from a right-click on that header.

This is a **display-only** change. It must not reorder the underlying feature arrays.

---

## 2. What already exists (read this before writing code)

The list is already sorted — the sort is just not selectable.

| Location | What it does |
|---|---|
| `js/core/features.js:963` `populateUnifiedList()` | Builds the whole Features list. Splits features into groups (from `attributes.group`) and ungrouped, sorts group names with `naturalSort`, sorts each bucket via `sortItems()`, renders groups first then ungrouped items. |
| `js/core/features.js:935` `sortItems(arr)` | The entire current sort: natural-sort by name. **This is the function being replaced.** |
| `js/core/features.js:929` `featureSortKey(item)` | Returns the name, or `"￿" + type + index` so unnamed features sink to the bottom. Keep this "missing values sink" idea and generalize it. |
| `js/core/features.js:920` `collectAllFeatures()` | Returns `[{ feature, type, index }]` across points/lines/routes/polygons. **This is where `seq` gets stamped** — see §5. |
| `js/core/features.js:243` `naturalSort(a, b)` | Existing natural-sort comparator ("Route 2" before "Route 10"). Reuse it; do not write a second one. |
| `js/core/features.js:289` `showContextMenu(x, y, options)` | Existing floating menu with viewport clamping. Reuse it; see §6 for the small additive extension it needs. |
| `js/core/features.js:1049` `populateLabelGroupedList()` | Separate renderer for the Labels and Text section. **Do not touch this file region.** Labels stay alphabetical. |
| `index.html:255` `.fp-header` | Holds the `Features | Layers` tab bar. The sort button goes here. |

---

## 3. Draw order — confirmed non-issue

Sorting the panel **does not** change map draw order, and the implementation must keep it
that way.

Each geometry type renders as a single MapLibre layer whose source data is built directly
from the `App.points` / `App.lines` / `App.routes` / `App.polygons` arrays (e.g.
`js/core/lines.js:54` `linesGeoJSON()`). Draw order within a type is array order.
`populateUnifiedList()` sorts a *copy* returned by `collectAllFeatures()`, so the arrays are
untouched. Cross-type z-order is fixed by layer stacking and is not reachable from this panel
at all.

**Hard constraint:** the sort must never mutate `App.points` / `App.lines` / `App.routes` /
`App.polygons`, and never call `.sort()` on them. Sort the array returned by
`collectAllFeatures()` only.

### Why manual drag-to-reorder is explicitly out of scope

It was considered and rejected for this pass. It would require reordering the real arrays,
which shifts feature indices, and several consumers key on array index rather than a stable id:

- `js/projects/title-vi.js` — alteration refs store `{ featureType, featureIndex }`. A reorder
  would silently repoint an alteration at a different route.
- `js/projects/route-costing.js` — persisted `selectedKeys`.
- `js/core/feature-attributes.js` — the open-feature tracking in the attribute popup.

(Transit Travelshed is already safe — it keys on the stable `routeIdx` / `lineIdx` counters.)

Do not add drag-to-reorder as a bonus.

---

## 4. Sort keys (Tier 1)

| Menu label | Key id | Comparator |
|---|---|---|
| **Name** (default) | `name` | `naturalSort` on `properties.name` |
| **Type** | `type` | Type rank `point(0) → line(1) → route(2) → polygon(3)`, then name |
| **Date added** | `added` | `properties.seq` ascending (see §5), then name |
| **Group** | `group` | `attributes.group` via `naturalSort`, then name |

Three rules that apply to **every** key:

1. **Name is always the final tiebreaker.** Two features with the same type / seq / group must
   still land in a stable, predictable order.
2. **Missing values always sink to the bottom**, regardless of ascending/descending. A feature
   with no name, or no group, goes last in both directions. This matches the existing
   `featureSortKey` behavior and must be preserved — do not let descending float the blanks
   to the top.
3. **Descending reverses the primary key only**, not the name tiebreaker and not the
   missing-values rule.

### Toggles

- **Ascending / Descending** — flips the primary key per rule 3 above.
- **Show groups** (default on) — when off, groups are flattened: no group headers, all features
  render as one flat sorted list. This is what makes non-name sorts read as a single continuous
  ordering instead of restarting inside every group. When on, behavior matches today: group
  headers first (sorted by the active key applied to group names where meaningful, else
  `naturalSort`), then ungrouped items.

---

## 5. `properties.seq` — the one new data field

"Date added" needs a creation order that works **across** types. Today each type has its own
counter (`pointIdx`, `lineIdx`, `routeIdx`, `polyIdx`), which orders within a type but cannot
interleave a point and a route.

**Do not** add a counter to all nine feature-creation sites. Stamp it lazily in one place:
`collectAllFeatures()` in `js/core/features.js:920`.

```js
var _featureSeq = 0;

function collectAllFeatures() {
  var all = [];
  (App.points   || []).forEach(function (f, i) { all.push({ feature: f, type: "point",   index: i }); });
  (App.lines    || []).forEach(function (f, i) { all.push({ feature: f, type: "line",    index: i }); });
  (App.routes   || []).forEach(function (f, i) { all.push({ feature: f, type: "route",   index: i }); });
  (App.polygons || []).forEach(function (f, i) { all.push({ feature: f, type: "polygon", index: i }); });

  // Stamp creation order on anything not yet carrying it. Runs on every panel
  // refresh, so newly added features pick up the next seq automatically, and
  // restored/legacy sessions get stamped in collect order on first render.
  for (var i = 0; i < all.length; i++) {
    var p = all[i].feature.properties;
    if (typeof p.seq === "number") {
      if (p.seq >= _featureSeq) _featureSeq = p.seq + 1;
    }
  }
  for (var j = 0; j < all.length; j++) {
    var q = all[j].feature.properties;
    if (typeof q.seq !== "number") q.seq = _featureSeq++;
  }

  return all;
}
```

Why this works with one touch point:

- Every feature-add path already calls `App.refreshFeaturePanel()` (verified in
  `points.js:108`, `points.js:223`, `lines.js:310`, and the equivalent route/polygon
  save paths), so a new feature is stamped the moment it appears.
- Sessions restored from cache keep whatever `seq` they were saved with — the session cache
  serializes whole features (`js/core/cache.js:64-67` slices the arrays wholesale), so `seq`
  persists for free with **no cache schema version bump**.
- Pre-existing sessions saved before this change have no `seq`. They get stamped on first
  render in collect order (all points, then lines, then routes, then polygons), which is
  exactly the sensible legacy fallback — not a random blob.

Note the two-pass structure: seed `_featureSeq` above the highest existing `seq` **before**
assigning any new ones, or a restored session will hand out duplicate seq values.

`js/core/osm.js` pushes into its own local arrays for the OSM reference layer, not into
`App.points` / `App.lines`. It is not affected and needs no change.

---

## 6. UI

### 6.1 The button

Add a small sort icon button to `.fp-header` (`index.html:255`), right-aligned, as a sibling
**after** `.fp-tabs`:

```html
<div class="fp-header">
  <div class="fp-tabs" role="tablist">
    <button class="fp-tab-btn active" data-fptab="features" ...>Features</button>
    <button class="fp-tab-btn" data-fptab="layers" ...>Layers</button>
  </div>
  <button id="fp-sort-btn" class="fp-sort-btn" type="button"
          title="Sort features" aria-label="Sort features"><!-- icon svg --></button>
</div>
```

**CSS change required:** `.fp-tabs` is currently `width: 100%` (`css/style.css:421`). Change it
to `flex: 1` so the tab bar and the button share the header row instead of the button being
pushed out. `.fp-header` is already `display: flex; align-items: center`, so nothing else
about the layout needs to move. Use an existing icon-button style as the base for
`.fp-sort-btn` (`.fp-gear-btn` is the closest match) and use design tokens per the project
convention — no raw hex.

The button is only meaningful on the Features tab. Hide it when the Layers tab is active,
in the same tab-toggle handler that swaps `#fp-tab-features` / `#fp-tab-layers`.

### 6.2 The menu

Both `#fp-sort-btn` click and `contextmenu` on `.fp-header` open the same menu via the
existing `showContextMenu(x, y, options)`. For the button, pass the button's
`getBoundingClientRect()` bottom-left as `x, y`.

```
┌─────────────────────────────┐
│  Sort by                    │   ← divider/label row
│  ✓ Name                     │
│    Type                     │
│    Date added               │
│    Group                    │
│  ─────────────────────────  │
│  ✓ Ascending                │
│  ✓ Show groups              │
└─────────────────────────────┘
```

`showContextMenu` currently only understands `{ label, action }`. Extend it **additively** with
two optional fields so existing callers are unaffected:

- `opt.checked` (bool) — renders a checkmark; omit or false renders nothing.
- `opt.divider` (bool) — renders a non-clickable separator / section label row instead of a button.

Existing callers (the feature-row context menu in `features.js`, and the Layers panel's
`⋯` menu via `App.showContextMenu`) pass neither, so their behavior must not change.
Verify both still work after the extension.

Selecting a sort key sets it and re-renders. Selecting an already-active key is a no-op — it
does **not** flip direction (direction has its own explicit row, and silent flip-on-reclick is
confusing).

---

## 7. State and persistence

Module-local in the `features.js` IIFE closure, alongside the existing `_expandedGroups` /
`_collapsedSections`:

```js
var _sortMode   = "name";  // "name" | "type" | "added" | "group"
var _sortAsc    = true;
var _showGroups = true;
```

Persist all three in the session cache so the choice survives a reload. Follow the
`featureSettings` pattern in `js/core/cache.js`:

- **Save** — add three fields in `collectState()` (`cache.js:64-85`), next to the
  `pointOpacity` / `lineOpacity` block.
- **Restore** — read them in the feature-settings restore block (`cache.js:148-166`), defaulting
  gracefully when absent: `_sortMode = state.featureSortMode || "name"`, etc. Use the same
  "default gracefully for old sessions" style already used for the opacity fields.
- **No schema version bump.** These are additive optional fields; old sessions restore cleanly
  on the defaults.

Expose a small setter that the menu calls, which sets state, saves the cache, and calls
`refreshFeaturePanel()`.

---

## 8. Code changes summary

| File | Change |
|---|---|
| `js/core/features.js` | The bulk of the work. Add `SORT_MODES` table, `_sortMode` / `_sortAsc` / `_showGroups`, seq stamping in `collectAllFeatures()`, rewrite `sortItems()`, add the flatten path to `populateUnifiedList()`, build the sort menu, extend `showContextMenu` with `checked` / `divider`. |
| `index.html` | Add `#fp-sort-btn` to `.fp-header` (~line 255). |
| `css/style.css` | `.fp-tabs` `width: 100%` → `flex: 1` (line 421). Add `.fp-sort-btn`. Add checkmark / divider styles for `#fp-context-menu` (line 2086). |
| `js/core/cache.js` | Three additive fields in `collectState()` and the restore block. |
| `CLAUDE.md` | Update the `features.js` entry in File Structure and the Feature Panel section of Layout to describe the sort control. |

No other module needs to change. Nothing outside the panel reads panel order.

---

## 9. Suggested build order

1. `SORT_MODES` table + rewritten `sortItems()`, hardcoding `_sortMode = "name"`. Confirm the
   panel looks **identical** to today. This proves the refactor is behavior-neutral before any
   UI exists.
2. Seq stamping in `collectAllFeatures()`. Verify with `App.points[0].properties.seq` in the console.
3. `showContextMenu` `checked` / `divider` extension. Verify the feature-row right-click menu
   and the Layers `⋯` menu still work.
4. Button + menu + wiring. Each key switchable.
5. Ascending/descending and Show groups toggles, including the flatten path.
6. Cache persistence.
7. `CLAUDE.md` update.

---

## 10. Acceptance checks

- [ ] Default state on a fresh session is byte-identical to the current panel: groups first
      (alphabetical), then ungrouped, all natural-sorted by name.
- [ ] Each of the four keys visibly reorders the list; the active key shows a checkmark.
- [ ] "Date added" interleaves types correctly — draw a point, then a route, then a point, and
      confirm the order is point, route, point (not all points then all routes).
- [ ] Descending reverses the primary key; unnamed / ungroupless features stay at the bottom in
      **both** directions.
- [ ] "Show groups" off flattens the list with no group headers; back on restores headers with
      their expand/collapse state intact.
- [ ] Sorting the panel does not change the map. Overlapping lines keep the same
      on-top/underneath relationship in every sort mode.
- [ ] `App.points`, `App.lines`, `App.routes`, `App.polygons` are in the same order before and
      after every sort change.
- [ ] The **Labels and Text** section is unchanged in every sort mode.
- [ ] Sort choice survives a page reload; a session saved before this change restores on the
      defaults without error.
- [ ] Feature-row right-click menu and Layers panel `⋯` menu are unaffected.
- [ ] Selection, hover highlight, gear/attributes, eye toggle, and delete all still act on the
      correct feature after re-sorting (they key on `dataset.featureIndex`, which must keep
      pointing at the real array index, not the display position).

That last one is the most likely place for a subtle bug: `buildItem()` writes
`div.dataset.featureIndex = featureIndex` from `item.index`. As long as `collectAllFeatures()`
captures the true array index and the sort only reorders those objects, it stays correct. Do
not renumber `item.index` to match display position.

---

## 11. Testing

- **Golden-value tests: not required.** This change touches no formula, elasticity, constant,
  or calculation-engine helper. `test/run-golden.mjs` pins pure math only; panel ordering is
  out of its scope by design.
- **UI screenshot harness: required.** This changes app-shell markup and shared CSS. Run
  `node test/ui-screens/capture.mjs` and **inspect the images** in `test/ui-screens/out/`
  against `test/ui-screens/baseline/`, not just the pass count. Expect a diff in the feature
  panel header (the new button) and nowhere else. A diff inside an analysis popup means the
  `.fp-tabs` flex change leaked — investigate before committing.

---

## 12. Explicitly out of scope

- Manual drag-to-reorder / custom order (see §3 for why).
- Any change to map draw order or layer stacking.
- Sorting the Labels and Text section.
- Tier 2 attribute sort keys — **Mode** (`attributes.mode`), **Service** (`attributes.serviceId`),
  **Length** (turf-computed miles). These were designed and deferred, not rejected. The
  `SORT_MODES` table should be shaped so adding one later is a single new entry with a
  comparator, plus a menu row. Do not implement them now.
- Sorting as a filter (e.g. "show only routes"). Different feature.
