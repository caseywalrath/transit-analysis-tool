# GeoPackage layer filters, views and fill transparency — plan

**Status:** planned, not started. Branch `claude/stoic-volta-0ts0fp`.

**Goal:** make imported GeoPackage layers inspectable the way a GIS viewer is:

1. **Map filter.** Each layer can show only the features that match one or more conditions ("`polygon_id` is `denver-25ft-blocks_2020`").
2. **Show matching rows on the map.** The attribute table can apply its text search to the map.
3. **Duplicate layer.** A layer can be shown twice, with a different style and filter, without loading the data twice. Duplicates can be renamed.
4. **Fill transparency.** A polygon layer's fill can be made clear while its outline stays solid.

These are general tools for any GeoPackage, not presets for one file. They cover steps 1–7 and 9 of the corridor inspection checklist the user brought (`comparison.gpkg`). Step 8 is a CSV and stays in a spreadsheet.

**Classes** follow `AGENTS.md`: Opus plans, owns the map/registry/persistence work and every review; Haiku (at `high` effort) takes the structural packages, each with a card checked against the code; Sonnet takes one small wiring package.

---

## Fixed technical decisions

Settled here so no card has to make them.

### D1. Where the state lives
- A layer's filter, fill transparency and display name live on its registry record in `js/core/gpkg-layers.js` (`rec.filter`, `rec.fillAlpha`, `rec.label`). They are **not** put in `App.layerStyles`:
  - the color drawer's × calls `App.clearLayerStyle(styleKey)` (`js/core/layer-palettes.js`), which deletes the whole entry, so a filter stored there would vanish when the user resets a color;
  - `App.setLayerStyle` copies only a fixed list of known fields, so unknown fields would be dropped anyway.
- They are saved with the file in the GeoPackage store (D5), the same place colors are saved today.

### D2. Filter object and the pure engine
- New pure file `js/core/gpkg-filter.js`, namespace `window.GpkgFilter`. No `App`, DOM or map use at any time, so the golden harness can load it alone. Loads immediately after `js/core/gpkg-reader.js`.
- A filter is `{ conditions: [ { field, op, value } ] }`. Every condition must match (AND). `value` is always a string.
- Operators (`GpkgFilter.OPS`, in this order):

  | id | label | needs value | meaning |
  |---|---|---|---|
  | `eq` | is | yes | text form equals value exactly (case-sensitive) |
  | `ne` | is not | yes | text form differs from value |
  | `in` | is one of | yes | text form equals one of the comma-separated items |
  | `contains` | contains | yes | text form contains value, ignoring case |
  | `gt` | is greater than | yes | value is a number and greater |
  | `gte` | is at least | yes | number and ≥ |
  | `lt` | is less than | yes | number and less |
  | `lte` | is at most | yes | number and ≤ |
  | `blank` | is blank | no | text form is empty |
  | `notblank` | is not blank | no | text form is not empty |

- **Text form** (`GpkgFilter.textOf`): `null`/`undefined` → `""`; boolean → `"true"`/`"false"`; number → `String(v)`; string → itself; anything else → `JSON.stringify(v)`. This is what MapLibre's `to-string` produces for the same values, so the map and the table agree.
- **Numeric operators compare real numbers only.** A numeric-looking TEXT value (`"125"`) does not match `gt`. This keeps the map expression and the JS matcher identical. Documented as a limitation.
- **Field `"*"`** means "any column" and is valid only with `contains`. It exists for the table's "Show matching on map" button.
- The map filter is `["all", <geometry-type filter>, <GpkgFilter.toExpression(...)>]`. The geometry-type filters are the existing `polyFilter`/`lineFilter`/`pointFilter` in `_addMapLayers`.

### D3. Fill transparency
- `rec.fillAlpha` replaces the constant `FILL_ALPHA` (0.35) inside `_paintColor`. Default 0.35, range 0–1 in steps of 0.05.
- The drawer shows it as **Fill** 0–100 % (polygon layers only). The row's existing opacity slider is unchanged and still scales fill and outline together, so "Fill 0 %, slider 100 %" gives a clear fill with a solid outline.

### D4. Duplicates ("views")
- A duplicate is a new registry record with its own id (`gpkgN`), style key, MapLibre layers, color, filter and fill, that **shares the original's GeoJSON source**.
  - `rec.sourceId` is the shared source.
  - `rec.data` and `rec.ramp` are the same objects as the original's; `_gpkgColor` is already on the shared features.
- `_removeOne` removes the source only when no other record still uses it.
- A duplicate copies the original's filter and fill, gets the next unused color, and is labelled `<table> (2)`, `(3)`… "Rename…" lets the user give any view a display name. Names are display only; the store still keys by table.
- New layers go to the top of the reference band (the existing `App.firstUserLayer()` placement), so a duplicate appears above the layers already there.

### D5. Persistence: `views`
- The store record gains `views`: an array, oldest first, of `{ table, label, base, color, filter, fillAlpha }`.
  - `label` is `null` when the user has not renamed the view.
  - `filter` is `null` when there is none.
- `layers` (table names, including tables without geometry) and `colors` are still written, so a record stays readable by older code.
- **Restore:**
  - With `views`: read each table once per file, add its first view with `_addLayerToMap`, and add later views of the same table as duplicates of it.
  - Without `views` (records written before this change): today's path, unchanged.
- `App.gpkgStore.save(name, bytes, layers, colors, views)` and `App.gpkgStore.update(name, layers, colors, views)` gain the last argument; when it is omitted, the record keeps no `views`.

### D6. Other behavior that follows the filter
- **Badge:**
  - Unfiltered, it shows the feature count as today.
  - Filtered, it shows `N of M`, and its title adds `· filter: <GpkgFilter.describe>`.
- **Zoom to layer** fits the features that match the filter.
  - The manifest entry gains an optional `bbox()` returning `[w, s, e, n]` or `null`; `zoomToEntry` in `js/core/layers-panel.js` uses it when present.
  - When nothing matches, the status reads "No features match this layer's filter".
- **Copy to drawn features** copies only the matching features. The menu label becomes `Copy N shown features to drawn features` when filtered.
- **The layer's attribute table** lists only the rows that pass the map filter. The count line adds `· map filter: <describe>`.
- **Click popup:** unchanged. Hidden features are not rendered, so they cannot be clicked.

### D7. Drawer hook
- `buildLayerStyleDrawer` in `js/core/layers-panel.js` gains one generic hook: after the `spec.kind` branches, `if (typeof spec.extraControls === "function") spec.extraControls(body, rerender);`.
- GeoPackage specs (`App.registerLayerStyle(... { label, kind: "solid", defaultColors, extraControls })`) supply it. No other spec does, so no other drawer changes.

---

## Phases

| Phase | Class | Package | Files |
|---|---|---|---|
| 1 | Haiku | Card A: pure filter engine + golden cases + script tag | new `js/core/gpkg-filter.js`, new `test/cases/gpkg-filter.mjs`, new `test/golden/gpkg-filter.json`, `index.html`, `docs/reference/script-load-order.md` |
| 2 | Opus | Registry: filter, fill, badge, bbox, copy, drawer hook, `views` persistence | `js/core/gpkg-layers.js`, `js/core/layers-panel.js`, `js/core/gpkg-store.js` |
| 3 | Haiku ∥ Haiku | Card B: drawer controls UI. Card C: table-window "Show matching on map" option | B: new `js/core/gpkg-filter-ui.js`, `css/style.css`, `index.html`. C: `js/core/gpkg-table.js`, `test/browser/gpkg-table.test.mjs` |
| 4 | Sonnet | Card D: wire B and C into `gpkg-layers.js` | `js/core/gpkg-layers.js` |
| 5 | Opus | Duplicate, Rename, shared sources, `views` restore of duplicates | `js/core/gpkg-layers.js` |
| 6 | Haiku ∥ Haiku | Card E: browser test of the whole feature. Card F: docs | E: new `test/browser/gpkg-filter.test.mjs`. F: `docs/reference/layers-and-styling.md`, `features.md` (root), `CLAUDE.md` |
| 7 | Opus | Final review, full test run, walkthrough with the user's file, archive plan | — |

Phase 3's two cards touch disjoint files and run in parallel. So do phase 6's.

Every phase ends with the review gate in `AGENTS.md` (code-review at `high`, re-run every "Done when" command, inspect screenshots), one commit with `Verified:` lines, and a progress-log entry.

---

## Phase 1 — Card A (Haiku, `high`): pure filter engine

**Goal:** add `window.GpkgFilter`, a pure module that validates filters, tests a row against a filter, and builds the matching MapLibre expression, plus its golden cases.

**Read first:**
- `CLAUDE.md` (Testing → Golden values; Conventions);
- `test/README.md`;
- `js/core/gpkg-reader.js`, the whole file: it is the pattern to copy (IIFE, `"use strict"`, ES5, one `window.X = {…}` export at the end);
- `test/cases/gpkg-reader.mjs`, the `export default {` block: the case format is `{ id, call: "Namespace.fn", args: [...] }`, with `scripts` listing the files to load;
- this plan, D2.

**Files you may change:**
- new `js/core/gpkg-filter.js`;
- new `test/cases/gpkg-filter.mjs`;
- new `test/golden/gpkg-filter.json` (created only by `--update`, never by hand);
- `index.html`;
- `docs/reference/script-load-order.md`.

**Contract.** ES5 only in `js/` (`var`, `function`, no arrow functions, no `let`/`const`, no template strings, no `Array.prototype.includes`). The file is an IIFE that assigns `window.GpkgFilter` and never reads `window.App`.

```
GpkgFilter.OPS            array of { id, label, needsValue, numeric } in the D2 table order.
                          numeric is true for gt, gte, lt, lte only; needsValue false for blank, notblank only.
GpkgFilter.textOf(v)      string, per D2 "Text form".
GpkgFilter.normalize(f)   → { conditions: [...] } holding only valid conditions, in input order, or null if none.
GpkgFilter.isActive(f)    → normalize(f) !== null
GpkgFilter.matches(props, f, columns)   → boolean. Inactive filter → true.
GpkgFilter.toExpression(f, columns)     → MapLibre expression array, or null when inactive.
GpkgFilter.describe(f)    → string, or null when inactive.
GpkgFilter.distinctValues(rows, field, limit) → { values: [strings], more: boolean }
```

**normalize** never throws. It returns `null` for a non-object, a missing `conditions` or a non-array `conditions`. A condition is kept only when:
1. it is an object;
2. `field` is a non-empty string after trimming (the kept field is the **untrimmed** original; column names may contain spaces);
3. `op` is one of the `OPS` ids;
4. `field === "*"` only with `op === "contains"`;
5. for `needsValue` ops, `String(value)` trimmed is non-empty (for `null`/`undefined`, treat value as `""`);
6. for `numeric` ops, `Number(trimmed value)` is finite;
7. for `in`, splitting the trimmed value on `,`, trimming each item and dropping empties leaves at least one item.

A kept condition is a **new** object `{ field, op, value }`:
- `value` is the trimmed string;
- for `in`, it is the de-duplicated items (first occurrence order) joined with `", "`;
- for `blank`/`notblank`, it is `""`.

**matches(props, f, columns):** `props` may be `null` (treat as `{}`); `columns` may be missing (treat as `[]`). For each kept condition, with `t = textOf(props[field])`:
- `eq`: `t === value`; `ne`: `t !== value`;
- `in`: `t` equals one of the items (split as in normalize);
- `contains`: `t.toLowerCase().indexOf(value.toLowerCase()) >= 0`; with field `"*"`, true when this holds for any name in `columns`, false for an empty `columns`;
- `gt`/`gte`/`lt`/`lte`: `typeof props[field] === "number" && isFinite(props[field])`, and the comparison against `Number(value)`;
- `blank`: `t === ""`; `notblank`: `t !== ""`.

**toExpression(f, columns):** `["all", c1, c2, …]`, even for one condition. With `G = ["get", field]` and `T = ["to-string", G]`:

| op | expression |
|---|---|
| eq | `["==", T, value]` |
| ne | `["!=", T, value]` |
| in | `["in", T, ["literal", items]]` (items as in normalize) |
| contains | `["in", value.toLowerCase(), ["downcase", T]]` |
| contains, field `"*"` | `["any", e1, e2, …]`, one `["in", value.toLowerCase(), ["downcase", ["to-string", ["get", c]]]]` per column; `false` when `columns` is empty or missing |
| gt | `["case", ["==", ["typeof", G], "number"], [">", ["to-number", G], n], false]` with `n = Number(value)` |
| gte / lt / lte | the same with `">="`, `"<"`, `"<="` |
| blank | `["==", T, ""]` |
| notblank | `["!=", T, ""]` |

Build a fresh `G`/`T` array for every use; never share one array object between two places in the result.

**describe(f):** the kept conditions joined with `" and "`:
- each is `field + " " + label + " " + value`, or `field + " " + label` for `blank`/`notblank`;
- field `"*"` is written `any column`;
- example: `polygon_id is denver-25ft-blocks_2020`.

**distinctValues(rows, field, limit):** `limit` defaults to 200 when not a positive number. Collect `textOf(row[field])` for each row (a `null` row counts as `{}`), skip `""`, keep unique values, sort ascending by plain string comparison (`a < b ? -1 : a > b ? 1 : 0`), and return the first `limit` as `values`; `more` is true when there were more unique values than `limit`.

**Edge cases** (each is a golden case; ids in brackets):
1. normalize `null` → `null` [norm-null]
2. normalize `{}` → `null` [norm-no-conditions]
3. normalize `{conditions: "x"}` → `null` [norm-conditions-not-array]
4. normalize drops a bad op, an empty field, a `"*"` field with `eq`, a blank `eq` value and a non-numeric `gt` value, and keeps the one good condition [norm-mixed]
5. normalize trims the value: `{field:"a", op:"eq", value:"  x "}` → value `"x"` [norm-trim]
6. normalize `in` `" a, ,b , a "` → value `"a, b"` [norm-in-dedupe]
7. normalize `blank` with value `"zzz"` → value `""` [norm-blank-value-cleared]
8. normalize `gte` `" 10 "` → value `"10"` [norm-numeric-trim]
9. textOf: `null` → `""`, `true` → `"true"`, `0` → `"0"`, `1.5` → `"1.5"`, `{a:1}` → `"{\"a\":1}"` [text-null, text-bool, text-zero, text-float, text-object]
10. matches with an inactive filter → `true` [match-inactive]
11. eq matches the number 600 against `"600"` → `true` [match-eq-number-text]
12. eq is case-sensitive: `"Denver"` vs `"denver"` → `false` [match-eq-case]
13. ne against a missing field with value `"x"` → `true` [match-ne-missing]
14. in `"a, b"` with `"b"` → `true` [match-in]
15. contains `"DEN"` in `"denver-25ft"` → `true` [match-contains-case]
16. contains `"*"` over columns `["a","b"]`, where only `b` holds the text → `true` [match-any-column]
17. contains `"*"` with no columns → `false` [match-any-column-empty]
18. gt `"5"` against the number 6 → `true`; against the text `"6"` → `false` [match-gt-number, match-gt-text]
19. lte `"5"` against 5 → `true` [match-lte-equal]
20. blank against `null`, `""` and a missing field → `true` each [match-blank-null, match-blank-empty, match-blank-missing]
21. notblank against `0` → `true` [match-notblank-zero]
22. two conditions, one failing → `false` [match-and]
23. `props` `null` with blank → `true` [match-null-props]
24. toExpression inactive → `null` [expr-inactive]
25. toExpression for each of `eq`, `in`, `contains`, `contains *` (two columns), `gt`, `blank` [expr-eq, expr-in, expr-contains, expr-any-column, expr-gt, expr-blank]
26. toExpression `contains *` with no columns → `["all", false]` [expr-any-column-empty]
27. toExpression with two conditions → `["all", c1, c2]` [expr-two]
28. describe: one `eq`; `blank`; `"*"` contains; two conditions; inactive → `null` [desc-eq, desc-blank, desc-any, desc-two, desc-inactive]
29. distinctValues: mixed values with duplicates, `null`s and numbers; `limit` 2 giving `more: true`; `limit` 0 defaulting to 200 [distinct-basic, distinct-limit, distinct-default-limit]

Golden arguments must be plain JSON; every case above is.

**Placement:**
- `index.html`: insert `    <script src="js/core/gpkg-filter.js"></script>` on its own line **immediately after** `    <script src="js/core/gpkg-reader.js"></script>`.
- `docs/reference/script-load-order.md`: add one line immediately after the line that starts `gpkg-reader.js`, in the same column format: `gpkg-filter.js       pure window.GpkgFilter; no App, DOM or map use at any time; before gpkg-layers.js, which calls it at call time`.

**Steps:**
1. Write `js/core/gpkg-filter.js` with a short header comment saying what the module is for and why the text form matches MapLibre's `to-string`.
2. Write `test/cases/gpkg-filter.mjs`: `export default { scripts: ["js/core/gpkg-filter.js"], cases: [ … ] }`, one entry per edge-case id above, in order.
3. Run `node test/run-golden.mjs --update`, then open `test/golden/gpkg-filter.json` and check, case by case, that every recorded value equals the value stated in the edge-case list. Where the list gives a structure (cases 25–27), check it against the toExpression table.
4. Add the script tag and the load-order line.

**Done when:**
- `node test/run-golden.mjs` ends `PASS — N/N cases passed`, with N = the previous total plus the number of new cases;
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-import.test.mjs` ends `PASS — 42/42 checks passed` (the new script tag breaks nothing);
- `grep -c "gpkg-filter.js" index.html` prints `1`.

**Stop and report if:**
- a recorded golden value differs from the edge-case list and you cannot see why in your own code;
- `run-golden.mjs` cannot load the file;
- a case seems to need a non-JSON argument.

---

## Phase 2 — Opus: registry, persistence, hooks

Not a card; the Opus agent implements it directly. Contract for later phases:

**In `js/core/gpkg-layers.js`:**
- **Record fields.** `rec.filter` (normalized or `null`), `rec.fillAlpha` (number), `rec.label` (string or `null`), `rec.columns` (the layer's column names: `meta.columns`, falling back to `_columnsOf`).
- **`_layerFilter(rec, kindFilter)`** returns `kindFilter` when there is no filter, else `["all", kindFilter, GpkgFilter.toExpression(rec.filter, rec.columns)]`. `_addMapLayers` uses it, and `_applyFilter(rec)` calls `map.setFilter` on each of the record's layers.
- **`_paintColor`** uses `rec.fillAlpha` for the `fill` kind.
- **`_matchingFeatures(rec)`** returns `_sourceFeatures(rec)` filtered by `GpkgFilter.matches(f.properties, rec.filter, rec.columns)`. The badge, `bbox`, copy and the table all use it.
- **Public API** (each takes an import id `gpkgN`; an unknown id is a no-op returning `null`/`false`):
  - `App.gpkgGetLayerState(id)` → `{ id, label, table, fileName, columns, filter, fillAlpha, hasPolygons, featureCount, matchCount }`.
  - `App.gpkgSetLayerFilter(id, filter)`: normalizes, applies to the map, refreshes the panel, persists. `null` clears.
  - `App.gpkgSetFillAlpha(id, a)`: clamps to 0–1, rounds to 0.05, repaints, persists.
  - `App.gpkgFieldValues(id, field)` → `GpkgFilter.distinctValues(rows of all features, field, 200)`.
- **Manifest entry** gains `bbox()`. The badge shows `N of M` when filtered.
- **Spec.** `registerLayerStyle` passes `extraControls: function (body, rerender) { … }`. It calls `App.gpkgBuildLayerControls(body, ctx)` when that exists (Card B); `ctx` is defined in Card B.
- **Persistence.**
  - `_fileState` returns `views`, `_saveFile`/`_persist` pass it, and restore follows D5.
  - Filter and fill changes persist through the same 400 ms debounce as colors (`_persistTimers`).

**In `js/core/layers-panel.js`:**
- the `extraControls` call (D7);
- `zoomToEntry` prefers `entry.bbox()` when it is a function:
  - a finite `[w, s, e, n]` is fit the same way as today;
  - `null` sets the status "No features match this layer's filter" and returns.

**In `js/core/gpkg-store.js`:** the `views` argument on `save` and `update` (D5), plus a header-comment update describing the record.

**Tests (Opus):**
- `gpkg-store.test.mjs`: a check that `views` round-trips through save/update/list.
- `gpkg-cache.test.mjs`: a check that a filter and fill set before a reload are back after it.
- Existing gpkg test files pass unchanged.

The progress-log entry must record the exact final names and shapes above, because phases 3–6 depend on them.

---

## Phase 3 — Card B (Haiku, `high`): drawer controls

**Goal:** a DOM builder that adds **Fill** and **Filter** controls to a GeoPackage layer's style drawer and reports changes through callbacks. It holds no state and knows nothing about the map.

**Read first:**
- `CLAUDE.md` Conventions (Design tokens, CSS namespacing, ES5);
- `js/core/layers-panel.js`, searching for:
  - `function buildLayerStyleDrawer`;
  - `spec.styleOptions`: the `mkRow`/`mkSelect`/`mkCheck` helpers there are the row pattern to copy;
  - `function buildSwatchRow`;
- `js/app.js`, searching for `function buildScrubber`. It takes `{ min, max, step, unit, value, onChange }` and returns the element;
- `css/style.css`, searching for `.lp-style-row {`, `.lp-style-control`, `.lp-basemap-select {`, `.lp-select-sm` and `.lp-style-reset {`;
- this plan, D2, D3 and the phase 2 log entry.

**Files you may change:**
- new `js/core/gpkg-filter-ui.js`;
- `css/style.css` (append a block only);
- `index.html` (one script tag).

**Contract.** ES5. The file is an IIFE that assigns `App.gpkgBuildLayerControls = function (body, ctx)`. It reads `window.GpkgFilter` and `App.buildScrubber` only inside that function. `ctx`:

```
{
  styleLabel: string,          // for aria-labels, e.g. "comparison.gpkg · polygon_comparisons"
  hasPolygons: boolean,
  fillAlpha: number,           // 0–1
  columns: [string],           // field choices, in order
  filter: null | { conditions: [{ field, op, value }] },   // already normalized
  matchCount: number, featureCount: number,
  fieldValues: function (field) → { values: [string], more: boolean },
  onFillAlpha: function (alpha0to1),
  onFilter: function (filterOrNull)
}
```

**Markup** (append to `body` in this order; reuse the existing classes exactly):
1. **Fill row**, only when `ctx.hasPolygons`:
   - a `div.lp-style-row` with `span.lp-style-label` text `Fill` and `div.lp-style-control`;
   - the control holds `App.buildScrubber({ min: 0, max: 100, step: 5, unit: "%", value: Math.round(ctx.fillAlpha * 100), onChange: function (v) { ctx.onFillAlpha(v / 100); } })`.
2. **Section label**: `div.gp-filter-head` with text `Filter`, plus `span.gp-filter-count` showing:
   - `"<matchCount> of <featureCount> shown"` when `ctx.filter` is non-null;
   - nothing (empty text) when it is null.
   - Format both numbers with `toLocaleString()`.
3. **One `div.gp-filter-cond` per condition** in `ctx.filter.conditions`, then **one more blank condition row** (field `""`, op `"eq"`, value `""`). Each row holds, in order:
   - **Field select** `select.lp-basemap-select.gp-filter-field`. The first option has value `""` and text `Field…`, then one option per `ctx.columns` (value and text = the name), then, only if the condition's field is `"*"`, an option with value `*` and text `Any column`. The select's value is the condition's field.
   - **Operator select** `select.lp-basemap-select.lp-select-sm.gp-filter-op`, one option per `GpkgFilter.OPS` (value = id, text = label), set to the condition's op.
   - **Value input** `input.gp-filter-value`, type `text`, `autocomplete="off"`, placeholder `value` (or `a, b, c` when op is `in`).
     - It is hidden (`style.display = "none"`) when the op's `needsValue` is false.
     - It has a `list` attribute pointing at a `datalist` with id `gp-filter-values-<n>`, where `<n>` is a counter private to the file that increments on every row built.
     - The datalist holds one `option` per `ctx.fieldValues(field).values` when the field is non-empty and not `"*"`.
   - **Remove button** `button.lp-style-clear` with text `×`, title `Remove condition`, and `aria-label` `Remove filter condition`. It is not added on the blank last row.
4. When `ctx.filter` is non-null: a `button.lp-style-reset` with text `Clear filter`, which calls `ctx.onFilter(null)`.

**Behavior:**
- Every control stops `click` propagation (`e.stopPropagation()`), as the existing drawer controls do.
- **Field change:** refill that row's datalist from `ctx.fieldValues(newField)` (clear it first).
- **Operator change:** show or hide the value input per `needsValue` and update its placeholder.
- **Commit points:**
  - a field or operator `change`;
  - the value input's `change` event (Enter or blur);
  - pressing Enter in the value input. Its `keydown` handler stops propagation for every key, so typing never reaches app shortcuts, and on Enter commits and calls `preventDefault()`.
- **On each commit:** collect every row's `{ field, op, value }` in order, including the blank row, as `list`. Let `n = GpkgFilter.normalize({ conditions: list })` and call `ctx.onFilter(n)`, which is `null` when nothing valid is left. Do not change the DOM afterwards: the caller re-renders the drawer.
- **Remove button:** drop that row from the list and commit as above.

**CSS** (append at the end of `css/style.css` under the comment `/* GeoPackage layer filter controls (gpkg-filter-ui.js) */`; tokens only, no raw hex):

```
.gp-filter-head { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-2xs); color: var(--muted); margin-top: var(--space-2); }
.gp-filter-count { color: var(--text-secondary); }
.gp-filter-cond { display: flex; align-items: center; gap: 3px; min-width: 0; }
.gp-filter-cond .gp-filter-field { flex: 1 1 0; min-width: 0; }
.gp-filter-cond .gp-filter-op { flex: 0 0 auto; }
.gp-filter-value { flex: 1 1 0; min-width: 0; font-size: var(--text-xs); min-height: var(--ctl-height-sm); padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-raised); color: var(--text-primary); }
```

**Placement:** `index.html`, insert `    <script src="js/core/gpkg-filter-ui.js"></script>` immediately after `    <script src="js/core/gpkg-table.js"></script>`.

**Done when:**
1. `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-import.test.mjs` ends `PASS — 42/42 checks passed`.
2. A scratch Playwright script (in the scratchpad, not the repo; copy `test/browser/gpkg-table.test.mjs`'s setup lines down to the `waitForFunction`) calls `App.gpkgBuildLayerControls` on a detached `div` with a stub `ctx` (`hasPolygons: true`, `fillAlpha: 0.35`, `columns: ["a","b"]`, `filter: {conditions:[{field:"a",op:"eq",value:"x"}]}`, `matchCount: 3`, `featureCount: 10`, `fieldValues` returning `{values:["x","y"],more:false}`, recording callbacks). It reports:
   - a. one `.fp-scrubber` whose input value is `35`;
   - b. `.gp-filter-count` text `3 of 10 shown`;
   - c. two `.gp-filter-cond` rows, the second with field `""`;
   - d. the first row's datalist holds options `x` and `y`;
   - e. on the second row, set the field select to `b` and dispatch `change`, then set the op select to `blank` and dispatch `change`. The last `onFilter` call receives exactly `{conditions:[{field:"a",op:"eq",value:"x"},{field:"b",op:"blank",value:""}]}`. The first call, after the field change, receives only the `a` condition, because `b eq ""` is not valid yet;
   - f. clicking the first row's × calls `onFilter` with `null`;
   - g. clicking `Clear filter` calls `onFilter(null)`;
   - h. with `filter: null` and `hasPolygons: false`: no scrubber, empty count text, one `.gp-filter-cond` and no `Clear filter` button.
   - Report each result as `a: PASS` / `a: FAIL <actual>`.

**Stop and report if:**
- `App.buildScrubber` or `window.GpkgFilter` is missing at call time;
- any class named above is not found in `css/style.css`;
- the drawer seems to need a change in `js/core/layers-panel.js`.

## Phase 3 — Card C (Haiku, `high`): "Show matching on map" in the table window

**Goal:** `App.gpkgOpenTable` gains two optional options: a button that hands the current search text to the caller, and an extra note on the count line.

**Read first:**
- `js/core/gpkg-table.js`, the whole file;
- `test/browser/gpkg-table.test.mjs`, the whole file;
- `css/style.css`, searching for `.gp-table-tools {`, `.gp-table-count {` and `.rf-btn-sm,`.

**Files you may change:** `js/core/gpkg-table.js`, `test/browser/gpkg-table.test.mjs` (add checks only; keep existing checks and their expected values unchanged), `css/style.css` (one rule inside the existing `.gp-table` block area).

**Contract:**
- **`opts.onApplyFilter`** is `function (text)` or absent.
  - When present, `buildBody` adds `button.rf-btn-sm.gp-table-apply` with text `Show matching on map` inside `.gp-table-tools`, after the count span.
  - The button is `disabled` whenever the trimmed filter text is empty; re-evaluate this on every `draw()`.
  - A click calls `onApplyFilter(filterEl.value.trim())`.
- **`opts.note`** is a string or absent. When non-empty, the count text is followed by `" · " + note`. Pass `note` into `countText` as a new last parameter and append it there.
- `buildBody(widget, columns, rows, total, onRowClick)` gains two trailing parameters, `onApplyFilter` and `note`, and `gpkgOpenTable` passes them.
- Behavior without these options is byte-identical to today: existing checks must still pass with their current expected strings.
- CSS: `.gp-table-apply { flex: 0 0 auto; white-space: nowrap; }`, placed immediately after the `.gp-table-count` rule.

**Edge cases:**
1. `onApplyFilter` absent → no button.
2. Filter text `"   "` → button disabled.
3. `note` `""` → no separator.
4. A filtered view with a note reads `"11 matching rows · map filter: x is y"`.

**Done when:** `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-table.test.mjs` ends `PASS — 12/12 checks passed`. The 8 existing checks are unchanged, plus these new ones, in a second `App.gpkgOpenTable` call after the existing ones (`rows` of 20 objects `{ id: i, name: "row " + i }`, `onApplyFilter` recording into `window.__applied`, `note: "map filter: id is 3"`):
- 9 `apply button present and disabled when the filter is empty`;
- 10 `count line ends with the note` (`20 rows · map filter: id is 3`);
- 11 `typing 'row 1' enables the button and the count reads '11 matching rows · map filter: id is 3'`;
- 12 `clicking the button reports 'row 1'` (`window.__applied` equals `["row 1"]`).

**Stop and report if:** an existing check fails, or the close-button or `_openSeq` logic seems to need changing.

---

## Phase 4 — Card D (Sonnet): wire B and C into the importer

**Goal:** connect the drawer controls and the table option to the phase 2 API.

**Read first:** the phase 2 and phase 3 progress-log entries; `js/core/gpkg-layers.js`, searching for:
- `extraControls`;
- `function _openLayerTable`;
- `function _tableMenuItems`;
- `App.gpkgGetLayerState`.

**Files you may change:** `js/core/gpkg-layers.js`.

**Contract:**
1. **`extraControls(body, rerender)`.** When `App.gpkgBuildLayerControls` is a function, call it with a `ctx` built from `App.gpkgGetLayerState(rec.id)`:
   - `styleLabel` is the row label;
   - `fieldValues` is `function (f) { return App.gpkgFieldValues(rec.id, f); }`;
   - `onFillAlpha` calls `App.gpkgSetFillAlpha` and does not rerender, because the scrubber keeps its own value;
   - `onFilter` calls `App.gpkgSetLayerFilter` and then `rerender()`.
2. **`_openLayerTable(rec)`:**
   - `rows` and `feats` are `_matchingFeatures(rec)`, not `_sourceFeatures(rec)`;
   - `total` is the length of that list;
   - `note` is `"map filter: " + GpkgFilter.describe(rec.filter)` when filtered, else omitted;
   - `onApplyFilter(text)` appends `{ field: "*", op: "contains", value: text }` to the record's conditions (or starts a filter with it), calls `App.gpkgSetLayerFilter`, then reopens the table with `_openLayerTable(rec)`.
3. **Live table.** When the open table window shows this record (`_openTableRecId === rec.id`), `App.gpkgSetLayerFilter` reopens it so its rows follow the new filter. Put that call inside `App.gpkgSetLayerFilter`, after the filter is applied.

**Edge cases:**
1. A filter applied from the table while the drawer is open: the panel re-renders via `_afterChange`, so the drawer shows the new condition. Verify this.
2. Applying from the table on a record removed meanwhile: guard with `_find(rec.id) >= 0`.
3. Zero matching rows: the table opens with `0 rows · map filter: …`.

**Done when:**
- `gpkg-import`, `gpkg-table`, `gpkg-cache` and `gpkg-store` tests all PASS;
- a scratch script importing `test/fixtures/sample.gpkg` shows that setting the filter `name is east` on `pts_utm` makes `queryRenderedFeatures` (deduplicated by `name`) return only `east`, and the badge reads `1 of 3`.

**Stop and report if:** a phase 2 API is missing or has a different shape than the log says.

---

## Phase 5 — Opus: duplicate and rename

Not a card. Implement D4 and the duplicate half of D5:
- `_duplicateLayer(rec)`;
- the shared-source reference count in `_removeOne`;
- `Duplicate layer` and `Rename…` (`window.prompt`; empty input restores the default name) in `_tableMenuItems`;
- labels in `gpkgReferenceEntries`, the popup title and the table title;
- restore of duplicate views.

Removing the original keeps its duplicates working (they hold the source).

**Tests (Opus):** `gpkg-cache.test.mjs` gains "a duplicate with its own filter and name survives a reload".

The log records the names the tests in Card E rely on.

---

## Phase 6 — Card E (Haiku, `high`): browser test of the whole feature

**Goal:** a new `test/browser/gpkg-filter.test.mjs` that drives the real app with `test/fixtures/sample.gpkg`.

**Read first:**
- `test/browser/README.md`;
- `test/browser/gpkg-import.test.mjs`, searching for `GPKG_FIXTURE` and `setInputFiles`: copy its import steps, picker handling and `check()`/summary pattern;
- the phase 2, 4 and 5 log entries (API names).

**Files you may change:** new `test/browser/gpkg-filter.test.mjs`.

**Checks** (exact names; poll observable state, never fixed sleeps):
1. `pts_utm imports with 3 features`
2. `filter name is east → badge '1 of 3' and one rendered point`
3. `filter survives reopening the drawer` (the drawer's first `.gp-filter-cond` field select reads `name`)
4. `table lists only the matching row and the note names the filter`
5. `Show matching on map with 'nor' on an unfiltered layer → badge '1 of 3'`
6. `boolean column filters by its text form` (set `flag is true`: the reader turns the BOOLEAN 1/0 into `true`/`false`, see `gpkg-reader.js` `type === "BOOLEAN"`, so badge `2 of 3`)
7. `Fill 0% sets fill-color alpha 0 on polys_utm; outline color unchanged`
8. `Duplicate polys_utm → second row, same source id, different color`
9. `filters on the original and the duplicate are independent` (`label is holed` on one, `label is two` on the other: each badge `1 of 2`)
10. `removing the original keeps the duplicate drawn`
11. `Rename the duplicate to 'Two only' → row label ends with 'Two only'`
12. `Zoom to layer with a filter that matches nothing sets the status text`
13. `reload restores filters, fill, the duplicate and its name`
14. `no page errors`

**Done when:** `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-filter.test.mjs` ends `PASS — 14/14 checks passed`, and `bash test/browser/run-browser.sh` runs it (add it nowhere: the runner globs `*.test.mjs`; confirm that with a read before relying on it).

**Stop and report if:** any check fails twice after fixing your own test code. Report actual vs expected; do not change app code.

## Phase 6 — Card F (Haiku, `high`): docs

**Files you may change:**
- `docs/reference/layers-and-styling.md`: in the GeoPackage section, add subsections **Filters**, **Fill transparency**, **Duplicates and names** and **Persistence of views**, from D2–D6 and the phase logs, and add the numeric-text and text-search limitations to the **Known limitations** list;
- `features.md` (repository root): one bullet per user-facing feature;
- `CLAUDE.md`: add `gpkg-filter.js` and `gpkg-filter-ui.js` to the File Map (after `gpkg-reader.js` and after `gpkg-table.js`) and the Script Load Order, and add `window.GpkgFilter` to the pure-engine lists in Script Load Order and Conventions.

**Done when:**
- `NODE_PATH=/opt/node-tools/node_modules node test/comment-guard.mjs HEAD` reports only doc changes;
- `node test/doc-coverage.mjs` lists no new missing names (the 3 existing ones may remain).

---

## Phase 7 — Opus: final gate

1. code-review at `high` on the whole feature diff; fix or log every finding.
2. Full `bash test/browser/run-browser.sh`, `node test/run-golden.mjs`, `node test/doc-coverage.mjs`.
3. Screenshots of a drawer with a filter, the table with its apply button, and a duplicate row, in light and dark mode; inspect them.
4. Walk the user's checklist with their `comparison.gpkg` (user data, never committed):
   - steps 2, 3, 4 (25 ft vs 50 ft as two views with different outlines), 6, 7 (point id → `source_id` lookup) and 9;
   - record what the app shows, and any step still deferred.
5. Move this plan to `docs/archive/` with a summary, and tell the user what changed, in plain language.

---

## Progress log

_(empty — append one entry per phase: tasks and models, send-backs, deviations, hand-off names and signatures)_
