# GeoPackage importer consolidation — plan

> **Status:** In progress (2026-11-07).

Main's PR #34 added a second GeoPackage viewer (`gpkg-import.js` + `geopackage.js`,
lon/lat only). The merge commit kept this branch's importer (`gpkg-reader.js`,
`gpkg-layers.js`, `gpkg-store.js`) and removed PR #34's files. This plan ports PR #34's
three extra features into the kept importer. Old code for reference:
`git show origin/main:js/core/gpkg-import.js` / `geopackage.js` / `test/cases/geopackage.mjs`.

Features to port:

1. **Time/cost color ramp**: a layer with a numeric column whose name matches
   `/(second|minute|^sec|_sec|time|cost)/i` is colored green → red over its range, gray
   where empty.
2. **Attribute table viewer**: a floating window with a filter box and up to 500 rows
   shown; clicking a row zooms to that feature.
3. **Non-spatial tables**: attribute-only tables open in the same viewer.

Agent rules and card format: `AGENTS.md`.

## Tasks

| Task | Class | Files | Depends on |
|---|---|---|---|
| A. Pure helpers | Haiku (high) | `gpkg-reader.js`, its golden case/json | none |
| B. Table viewer window | Haiku (high) | new `js/core/gpkg-table.js`, `index.html` (one tag), `css/style.css` (rename), new browser test | A |
| C. Ramp, non-spatial tables, wiring | Opus | `gpkg-layers.js`, `gpkg-import.test.mjs`, `gpkg-cache.test.mjs` | A, B |
| D. Docs | Haiku (high) | `layers-and-styling.md`, `CLAUDE.md`, `script-load-order.md`, `features.md` | C |
| E. Review, all tiers, archive | Opus | none | D |

### Card A — pure helpers (Haiku)

- **Goal:** add three pure helpers from PR #34 to `window.GpkgReader`, with identical results.
- **Read first:**
  - `js/core/gpkg-reader.js` (whole file);
  - `git show origin/main:js/core/geopackage.js` (functions `finite`, `numericValue`, `pickColorField`, `formatValue`, and `COLOR_FIELD_RE`);
  - `git show origin/main:test/cases/geopackage.mjs`, lines 70–90;
  - `git show origin/main:test/golden/geopackage.json`.
- **Files you may change:** `js/core/gpkg-reader.js`, `test/cases/gpkg-reader.mjs`, `test/golden/gpkg-reader.json`.
- **Contract:** add these, copied in behavior from PR #34 and exported on `window.GpkgReader`:
  - `numericValue(v)`: returns `v` if it is a finite number. Returns `Number(v)` for a string whose trimmed text is non-empty and gives a finite number. Otherwise returns `null`.
  - `pickColorField(columns, rows)`: returns `{ field, min, max, count }` for the first column in `columns` that matches `/(second|minute|^sec|_sec|time|cost)/i` and has at least one non-null `numericValue` across `rows` (an array of plain objects). Otherwise returns `null`.
  - `formatValue(v)`: `null`/`undefined` → `""`; an integer → `String(v)`; another number → `String(Math.round(v * 1000) / 1000)`; a `Uint8Array` → `"(binary, N bytes)"`; anything else → `String(v)`.
- **Steps:**
  1. Add the three functions in ES5 style (`Number.isInteger` is fine). Put a short "why" comment above `pickColorField`: it chooses the column the map ramp colors by.
  2. Port PR #34's golden cases for `pickColorField` and `formatValue` (lines 73–89 of its case file; skip the `bboxLooksLonLat` ones) into `test/cases/gpkg-reader.mjs`. Change `call` to `GpkgReader.*`, keep the args unchanged, and keep the ids with the prefix `pr34-`. Also add 4 `numericValue` cases: `12.5`, `" 7 "`, `""`, `"abc"`.
  3. Run `node test/run-golden.mjs gpkg-reader --update`.
- **Done when:**
  - Every ported `pr34-*` value in `test/golden/gpkg-reader.json` equals PR #34's value for the same case in `origin/main:test/golden/geopackage.json`. Compare them with a short node script and report the result.
  - No other existing value in `test/golden/gpkg-reader.json` changed.
  - `node test/run-golden.mjs` ends with `PASS`.
- **Stop and report if:** any ported value differs from PR #34's.

### Card B — table viewer window (Haiku)

- **Goal:** a reusable attribute-table window, ported from PR #34's `openTable`, that knows nothing about GeoPackage internals.
- **Read first:**
  - `git show origin/main:js/core/gpkg-import.js`, functions `openTable`, `zoomToRow` and `esc` (around lines 340–470);
  - `js/core/popup.js`: `showFloatingWidget` and `removeFloatingWidget`;
  - `css/style.css`: the block `/* ---- GeoPackage attribute table viewer ---- */`;
  - `js/core/gpkg-reader.js`: `formatValue` (added by card A).
- **Files you may change:**
  - `js/core/gpkg-table.js` (new);
  - `index.html`: one `<script src="js/core/gpkg-table.js"></script>` directly after the `js/core/gpkg-layers.js` tag;
  - `css/style.css`: only the attribute-table block;
  - `test/browser/gpkg-table.test.mjs` (new).
- **Contract:**
  - `App.gpkgOpenTable(opts)` returns a Promise.
    - `opts = { title, columns: [names], rows: [plain objects], total, onRowClick: function (rowIndex) | null }`.
    - It replaces any open table window (widget id `"gpkg-table"`, position `"bottom-left"`, width 560, title escaped).
    - The body, with PR #34's structure: a filter input, a count line, then a scrolling table. The table has a `#` column (row index + 1) and one column per entry in `columns`. A hint line "Click a row to zoom to it." appears only when `onRowClick` is set.
    - Cells are filled with `GpkgReader.formatValue`, escaped.
    - At most 500 rows are drawn. The filter matches the row if any formatted cell contains the text (case-insensitive).
    - Count text, copied from PR #34: `"N rows"` or `"N matching rows"`, then `" · showing first 500"` when capped, then `" · file has T, only L loaded"` when `total > rows.length`.
    - Keydown in the filter calls `stopPropagation` (so app shortcuts do not fire).
    - Clicking a data row marks it `gp-row-active` (clearing the others) and calls `onRowClick(index)`.
  - `App.gpkgCloseTable()` removes the window if it is open.
  - CSS: rename every `gpkg-table*` class to `gp-table*` (`.gpkg-table-widget` → `.gp-table-widget`, `.gpkg-row-active` → `.gp-row-active`), and use the same names in the JS.
- **Test** (`gpkg-table.test.mjs`): copy the setup of `test/browser/gpkg-store.test.mjs`. Call `App.gpkgOpenTable` with 600 synthetic rows (`{ id: i, name: "row " + i, secs: i * 1.5 }`), `total` 700, and an `onRowClick` that records its argument on `window`. Checks:
  1. The window exists with 500 body rows.
  2. The count text equals `"600 rows · showing first 500 · file has 700, only 600 loaded"`.
  3. Typing `row 59` in the filter leaves 11 rows (`row 59` and `row 590`–`599`), and the count starts with `"11 matching rows"`.
  4. Clicking the second visible row calls `onRowClick` with that row's index and marks it `gp-row-active`.
  5. Pressing `p` in the filter does not change `App.drawMode`.
  6. A second `App.gpkgOpenTable` call with `onRowClick: null` shows no hint line and leaves only one window.
  7. `App.gpkgCloseTable()` removes the window.
  8. There are no page errors.
- **Done when:**
  - `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-table.test.mjs` passes 8/8.
  - `bash test/browser/run-browser.sh` shows every file PASS and none FAIL. A failing non-gpkg file gets one solo rerun, and both results are reported.
- **Stop and report if:** `showFloatingWidget` does not accept these options.

### C — ramp, non-spatial tables, wiring (Opus)

- **Ramp:** `_addLayerToMap` computes `GpkgReader.pickColorField(columns, properties)` per layer. When there is a field, each feature gets `_gpkgColor`. The paint becomes a `case`/`interpolate` expression (PR #34's `colorExpr`) while no solid override is set; a solid override replaces it. Reset returns to the ramp. The badge title names the field and its range.
- **Non-spatial tables:** they are checkable in the picker as "Table (no map layer)", read up to 20,000 rows, and are kept per file (`fileKey`). Every layer of that file gets "View table: name" in its ⋯ menu. A file with only tables opens the first one directly. They are stored and restored with the file. Clear and remove drop them.
- **Spatial table:** the ⋯ menu gets "View attribute table" (rows = the source features' properties), and clicking a row zooms to that feature and opens its popup.
- **Also from PR #34:**
  - Fit the map to the new layers and switch to the Layers tab after import.
  - Use a 5 px click tolerance.

## Progress log

_Appended per task: model, send-backs, deviations, hand-off notes._

**Merge (Opus, 2026-11-07).** Conflicts resolved toward this branch; PR #34's
`gpkg-import.js`, `geopackage.js`, golden case and `registerReferenceLayer` API removed;
both libraries switched to cdnjs (vendored files byte-identical). Two leftover export
lines from PR #34 broke page load until removed (caught by the browser suite).

**A (Haiku, high).** Accepted first pass: 8 ported values identical to PR #34's golden
file, no existing value changed. It noticed the orchestrator editing `gpkg-layers.js`
concurrently and warned against `git add -A`.

**B (Haiku, high).** Accepted first pass, 8/8. Added a sequence guard so an older async
open cannot fill a newer window (not in the card, correct). It pointed out that check 5
cannot catch a missing `stopPropagation` (app.js already ignores keys typed in inputs).
Review then found the filter rescanned every cell on each keystroke; the orchestrator
added a debounce and per-row text cache directly (eight lines, logged here instead of a
send-back) and made the test wait for the debounced redraw.

**C (Opus).** Ramp (`pickColorField` → `_gpkgColor` → `case`/`interpolate` paint; a
drawer color replaces it, reset restores it; badge title names the field and range),
table-only entries in the picker ("Table (no map layer)"), `_readTableRows` (≤20,000),
per-file `_tables` reachable from every layer's ⋯ menu, "View attribute table" with
row → zoom + popup, stored and restored with the file, fit-to-new-layers + Layers tab,
5 px click retry (GeoPackage features only). Review (high) found 10; fixed 7: table
window left open for a removed layer; tables-only imports kept unreachable tables;
re-import adding only tables not saved; point zoom jumped after padding reset; slow
filter; box retry suppressed by nearby OSM/GTFS; restore kept tables of files whose
layers all failed. Skipped: `_gpkgColor` stored in feature properties (filtered by
`_isInternalKey`), three copies of zoom-to-extent with different padding; docs → D.
- **Behavior to document (D):** a file imported with tables only shows the first table
  once and keeps none (no Layers row could reopen them); the status says so.
  `App.gpkgOpenTable` / `App.gpkgCloseTable` in `js/core/gpkg-table.js`; CSS prefix
  `.gp-table*`.
