# GeoPackage (.gpkg) import as reference layers — implementation plan

> **Status:** Not started (written 2026-11-06).

Lets a user open a GeoPackage from **Add Data**, pick which of its layers to show, and see
them on the map as **reference layers** (view-only, like GTFS routes or OSM layers), not as
drawn features. Coordinates in any common projection are converted to latitude/longitude.

**Read this whole document before starting any phase.** Each phase must leave the app fully
working and must be committed separately (with a `Verified:` line, per `CLAUDE.md` § Testing)
before the next phase starts.

---

## Why reference layers, not drawn features

The motivating file (`comparison.gpkg`, 8.7 MB) has four layers, all in **EPSG:26913
(NAD83 / UTM 13N)**:

| Layer | Geometry | Rows |
|---|---|---|
| `full_census_units` | MultiPolygon | 11,511 |
| `reached_source_intervals` | LineString | 3,608 |
| `representative_points` | Point | 189 |
| `polygon_comparisons` | Polygon | 11 |

The existing importers (`js/core/cache.js` `_parseSHPBuffers` → `_applyImportedFeatures`)
**replace every drawn feature** and give each row its own Features-panel row, attribute dock
entry and color. That is unusable at 11,511 polygons and wrong for comparison data the user
only wants to look at. A reference layer is one MapLibre source per GeoPackage layer: cheap
to draw, does not touch `App.points/lines/routes/polygons`, and does not take part in analyses.
An optional later phase (Phase 7) adds "Copy to drawn features" for small layers.

## End state

- **Add Data → "GeoPackage (.gpkg)…"** opens a file picker. The general Import picker
  (`#fp-import-file`) also accepts `.gpkg` and routes it to the same code.
- A **layer picker dialog** lists each feature layer: name, geometry type, row count,
  projection. All layers start checked. Raster tile tables and attribute-only tables are
  listed as "not supported" and cannot be checked.
- Each chosen layer appears in the **Layers panel → Reference/Imported** band as its own row
  ("`<file name>` · `<layer name>`"), with show/hide, opacity, drag-reorder, Zoom to layer,
  Remove layer and a solid-color style drawer.
- **Clicking a GeoPackage feature** on the map shows its attributes in a small popup.
- Imported layers **survive a page refresh** (original file bytes kept in IndexedDB, like
  GTFS). They are **not** written into session JSON files or share links (same as GTFS); the
  docs say so.
- Nothing about drawn features, analyses, undo of drawn features, or existing reference
  layers changes.

---

## Agent model assignment

Work is split between two agent tiers. The orchestrating session (Opus) launches each task
with the Agent tool, passing `model: "sonnet"` or `model: "opus"` as marked.

| Marker | Who | Use for |
|---|---|---|
| **[S]** | Sonnet agent | Well-specified, pattern-following work with a clear test: vendoring, pure parsers with golden tests, menu wiring, dialog markup/CSS, docs, fixtures. |
| **[O]** | Opus agent (or the orchestrator itself) | Delicate work touching shared invariants: projection handling, Layers-panel manifest changes, map click handling alongside `editing.js`, startup/IndexedDB restore order. Also every phase review and the final review. |

**Rules for every agent prompt** (orchestrator copies these into each prompt):

1. Read `CLAUDE.md`, this plan, and the reference docs named in the task before editing.
2. Work on branch `claude/stoic-volta-0ts0fp`. Do not push; the orchestrator pushes after review.
3. Touch only the files the task lists. If another file must change, stop and report why.
4. Run the test tiers the task names and paste the final `PASS — …` line in the report.
5. Report: files changed (with line ranges), tests run and results, open questions.

**Review gate (every phase) [O]:** after the Sonnet task(s) of a phase finish, an Opus agent
reviews the diff against this plan and `CLAUDE.md` (run the `code-review` skill at `high` on
the phase diff), fixes or sends back problems, re-runs the phase's tests, then commits.

---

## Technical decisions (fixed — do not revisit inside a phase)

**Libraries** (both new CDN `<script>`s, pinned exact versions, from unpkg like the others):

- **sql.js `1.10.3`** (`sql-wasm.js` + `sql-wasm.wasm`, ~1.1 MB). **Loaded lazily**, only when
  a `.gpkg` is opened, by injecting a `<script>` tag; `initSqlJs({ locateFile })` points at
  the same pinned unpkg folder. Startup cost for users who never open a GeoPackage: zero.
- **proj4 `2.11.0`** (`dist/proj4.js`, ~100 KB). Also lazy-loaded with sql.js.
- Both are added to `VENDOR_MAP` in `test/browser/harness.mjs` and to `test/ui-screens/vendor/`
  (the `.wasm` with type `application/wasm`) so browser tests stay offline.

**Reading a GeoPackage** (OGC GeoPackage 1.2/1.3):

- Feature layers: `gpkg_contents` where `data_type = 'features'`, joined to
  `gpkg_geometry_columns` (geometry column name, geometry type, `srs_id`).
- Projection: `gpkg_spatial_ref_sys` row for that `srs_id` (`organization`,
  `organization_coordsys_id`, `definition` WKT).
- Geometry blob = GeoPackage header (`"GP"`, version, flags byte: bit 0 endianness, bits 1–3
  envelope type 0–4 → 0/32/48/48/64 envelope bytes, bit 4 empty) + standard WKB. WKB types
  1–7 plus ISO Z/M/ZM codes (1001–1007, 2001–2007, 3001–3007) and EWKB high-bit flags;
  Z/M values are dropped. GeometryCollection is skipped with a count in the import summary.
- Attributes: every non-geometry column except the primary key; column types from
  `PRAGMA table_info`. `BOOLEAN` 0/1 → `true`/`false`; `DATE`/`DATETIME` kept as text;
  `BLOB` columns skipped. A TEXT value that parses as a JSON object is kept as text (the
  popup pretty-prints it).

**Projection resolution** (`GpkgReader.resolveProjection(srsRow)`), in order:

1. `srs_id` 4326 or EPSG 4326/4269/CRS84 → no transform (4269 is treated as WGS 84).
2. EPSG 3857/900913 → proj4 built-in.
3. EPSG 26901–26923 (NAD83 UTM), 32601–32660 / 32701–32760 (WGS 84 UTM) → proj string
   built from the zone number (no network lookup).
4. Otherwise try `proj4(definition WKT)`; if proj4 accepts it and a test point lands inside
   −180..180 / −90..90, use it.
5. Otherwise the layer is listed in the picker as "Unknown projection (EPSG:xxxx)" and cannot
   be imported. Never guess and never import untransformed coordinates.

Undefined SRS (`srs_id` −1 / 0) → treated as already longitude/latitude **only if** the layer's
envelope (`gpkg_contents.min_x…max_y`) fits inside −180..180 / −90..90; otherwise unsupported.

**Map layers.** Each imported GeoPackage layer gets an import id `gpkgN` (counter per session)
and one GeoJSON source `gpkg-src-gpkgN` with these layers, all inserted below the drawn-feature
layers through `firstUserLayer()`:

- polygons: `gpkg-gpkgN-fill` (+ `gpkg-gpkgN-outline`)
- lines: `gpkg-gpkgN-line`
- points: `gpkg-gpkgN-point` (circle)

Mixed-geometry layers get every layer kind that has features. Colors come from
`window.LayerPalette` (categorical palette, next unused color). Never use these ids in
`points-layer`/`lines-layer` hit-testing helpers; they are reference layers only.

**Scale target.** The 11,511-polygon layer must import (parse + reproject + add to map) in
under ~5 s on a laptop and pan smoothly. If Phase 2 measures more than that, the orchestrator
decides between moving parsing into a Web Worker or simplifying geometry; neither is in scope
unless the measurement requires it.

**State.** Import registry lives in a private closure in `js/core/gpkg-layers.js`:
`{ id, fileName, layerName, geomKinds, featureCount, bbox, color, sourceId, layerIds }`.
Public API (all on `App`):

- `App.gpkgOpenFile(file)` — entry point from menus.
- `App.gpkgReferenceEntries()` — Layers-panel manifest entries for current imports.
- `App.gpkgRemoveLayer(id)`, `App.gpkgClearAll()`, `App.gpkgLoaded()`.

---

## New and changed files

```
js/core/gpkg-reader.js     window.GpkgReader — pure: blob/WKB → GeoJSON, projection resolution,
                           row → properties. No DOM, map or sql.js access (golden-testable).
js/core/gpkg-layers.js     Lazy library loader, sql.js reading, picker dialog, map layers,
                           registry, click popup, App.gpkg* API.
js/core/gpkg-store.js      IndexedDB copy of imported files (Phase 6), modeled on gtfs-store.js.
index.html                 Add Data menu item, picker dialog markup, accept list, script tags.
js/app.js                  .gpkg routing in the import handler; Add Data eye/× config.
js/core/layers-panel.js    Reference band reads App.gpkgReferenceEntries() as dynamic entries.
css/style.css              .gp- namespace (picker dialog, feature popup).
test/cases/gpkg-reader.mjs + test/golden/gpkg-reader.json
test/fixtures/make-gpkg-fixture.py + test/fixtures/sample.gpkg
test/browser/gpkg-import.test.mjs
docs/reference/layers-and-styling.md (new § gpkg), CLAUDE.md file map + load order,
test/ui-screens/README.md vendor table.
```

Script order: `gpkg-reader.js` after `walk-shape.js` (with the other pure engines);
`gpkg-store.js` after `gtfs-store.js`; `gpkg-layers.js` after `layers-panel.js` and before
`census.js`. `layers-panel.js` only calls `App.gpkgReferenceEntries` at render time, guarded
with `typeof`, so loading after it is safe.

---

## Phase 0 — Vendor libraries and build the test fixture

**0a [S] Vendor sql.js and proj4.** `npm pack sql.js@1.10.3 proj4@2.11.0` (registry, not
unpkg, per `test/ui-screens/README.md`), copy `dist/sql-wasm.js`, `dist/sql-wasm.wasm`,
`dist/proj4.js` into `test/ui-screens/vendor/`, add three `VENDOR_MAP` entries (exact unpkg
URLs from the Technical decisions section) and update the README vendor table. Do **not**
add script tags to `index.html` (they are lazy-loaded later).
*Verify:* `bash test/browser/run-browser.sh` still passes (nothing should change).

**0b [S] Fixture generator.** `test/fixtures/make-gpkg-fixture.py`, using only Python's
standard `sqlite3` and `struct` (no GDAL), writes a deterministic `test/fixtures/sample.gpkg`
(target < 50 KB) with:

- `pts_utm` — 3 Points in EPSG:26913 (one with a NULL attribute, one BOOLEAN column, one TEXT
  column holding a JSON object)
- `lines_wgs` — 2 LineStrings in EPSG:4326, one written big-endian
- `polys_utm` — 1 Polygon with a hole + 1 MultiPolygon in EPSG:26913, envelope type 1
- `mixed_z` — 1 PointZ (WKB 1001) + 1 LineString in EPSG:4326, no envelope
- `empty_geom` — 1 row with the empty flag set, 1 row with NULL geometry
- `weird_srs` — 1 Point in an SRS row with organization `NONE` and a nonsense WKT
- one `attributes` table (no geometry) and one `tiles` row in `gpkg_contents`

Coordinates are around Denver (e.g. UTM 500000, 4400000) so expected lon/lat are known
(about −105.0, 39.75). Commit both the script and the `.gpkg`. Header comment in the script
lists every case and why.
*Verify:* `python3 -I test/fixtures/make-gpkg-fixture.py` twice produces byte-identical files.

**Review gate [O].** Confirm the fixture covers every rule in "Reading a GeoPackage".

---

## Phase 1 — Pure reader engine (`js/core/gpkg-reader.js`)

**1a [S] Geometry and rows.** Implement `window.GpkgReader`:

- `parseGeometryBlob(Uint8Array) → { geometry | null, empty: bool, skipped?: "collection" }`
- `wkbToGeoJSON(DataView, offset) → { geometry, bytesRead }`
- `rowToProperties(columns, values) → object` (rules from Technical decisions)

IIFE style like `js/core/walk-cost.js`; no use of `App`, `map`, `turf` or `sql.js`.
Golden cases in `test/cases/gpkg-reader.mjs` build blobs by hand in JS (little/big endian,
each envelope type, empty flag, Z/M codes, every geometry type, GeometryCollection) and seed
`test/golden/gpkg-reader.json` with `--update`.
*Verify:* `node test/run-golden.mjs` → PASS.

**1b [O] Projection resolution.** Add to the same file:

- `resolveProjection(srsRow, envelope) → { kind: "none" | "proj4", def?: string, label, error? }`
- `transformGeometry(geometry, fn) → geometry` (applies `fn([x, y]) → [lon, lat]` to every
  coordinate; pure, takes the transform function as an argument so tests need no proj4)

`resolveProjection` builds proj strings for the UTM ranges itself and only *returns* a WKT for
step 4; calling `proj4` happens in `gpkg-layers.js`. Golden cases: each step of the
resolution order, the undefined-SRS envelope rule, zone 1/60, south zones, out-of-range codes.
Hand-check one known point (EPSG:26913 `500000, 4400000` → about `−105.0000, 39.7496`) against
proj4 in a browser test in Phase 2, not in golden (golden is pure math, no proj4).
*Verify:* `node test/run-golden.mjs` → PASS.

**Review gate [O].**

---

## Phase 2 — Loading a file (`js/core/gpkg-layers.js`, no UI yet)

**2a [S] Loader and reader.** In `gpkg-layers.js`:

- `_loadLibs()` — injects the two pinned script tags once, returns a cached Promise resolving
  to `{ SQL, proj4 }`; a failed load clears the cache so a retry can work, and shows
  "Could not load the GeoPackage reader. Check your internet connection and try again."
- `_inspect(arrayBuffer) → { layers: [{ table, geomColumn, geomType, srs, projection, count,
  supported, reason }] }` — lists feature layers plus unsupported tables with reasons.
- `_readLayer(db, layerInfo) → { featureCollection, skipped: { empty, nullGeom, collection } }`
  — reads rows with a prepared statement (`db.prepare` / `step` / `getAsObject` streaming,
  never `db.exec` on the whole table), converts via `GpkgReader`, transforms via proj4.
- Temporary test hook `App._gpkgTest = { inspect, readLayer }` guarded by `__MAT_TEST__`.

Add `<script src="js/core/gpkg-reader.js">` and `<script src="js/core/gpkg-layers.js">` to
`index.html` at the positions in "New and changed files".

**2b [S] Browser test, part 1.** `test/browser/gpkg-import.test.mjs` (reuse
`harness.mjs`): loads the fixture through the hook, checks the layer list (supported /
unsupported and reasons), feature counts, the known UTM point within 1e-4°, big-endian line
coordinates, hole preserved, Z dropped, booleans, NULL omitted.
*Verify:* that test and `bash test/browser/run-browser.sh` → PASS.

**2c [O] Scale check.** Run the reader against the motivating `comparison.gpkg` if the user
supplies it again (do **not** commit it — it is user data). Record parse + transform time per
layer in the phase report. Apply the scale rule from Technical decisions.

**Review gate [O].**

---

## Phase 3 — Map layers and the Layers panel  **[O]**

Delicate: shared manifest, layer z-order, Add Data icons, clear-all and removal all have
invariants documented in `docs/reference/layers-and-styling.md` and `core-app.md`.

- `_addLayerToMap(id, featureCollection, meta)` — source + layers per Technical decisions,
  inserted with `firstUserLayer()`; color from `LayerPalette`.
- `App.gpkgReferenceEntries()` returns one entry per import shaped like the static
  `REFERENCE` entries: `{ id, label, layers: [{id, op}], clear, badge, menuItems }`.
  `badge` shows the feature count; `menuItems` adds "Zoom to layer" (fit `meta.bbox`).
- `js/core/layers-panel.js`: the Reference band iterates `REFERENCE.concat(dynamic)` wherever
  it iterates `REFERENCE` today (render, `entryPresent`, reorder clamping, remove). Search for
  every `REFERENCE` use; do not fork the row builder.
- Solid style drawer: register a `styleKey` per import so color edits go through
  `App.setLayerStyle` (never `map.setPaintProperty`), per the styling invariants.
- Removal: `App.gpkgRemoveLayer(id)` removes layers then source and drops the registry entry;
  the manifest `clear` calls it, so it goes through `removeEntry` (undo push → clear → notify →
  save → icons → render). Undo does **not** restore it (same as GTFS); no "Undo to restore".
- Add Data menu: one `_adClrCfgs` entry for the GeoPackage item (eye toggles all imports, ×
  calls `App.gpkgClearAll()`), so `App.updateAddDataClearIcons()` stays the single path.
- Clear All (`test/browser/clear-all.test.mjs`): decide whether Clear All removes GeoPackage
  layers by matching what it does for GTFS, and document the choice.
- Extend `gpkg-import.test.mjs`: layers exist after import, appear in the Reference band,
  eye hides them, opacity changes, Remove deletes source + layers, drawn features untouched,
  two imports of the same file get distinct ids. Add the dummy-entry case to
  `layer-remove.test.mjs` if that test enumerates manifests.

*Verify:* `bash test/browser/run-browser.sh` → PASS (all files, including `hidden-features`,
`layer-remove`, `clear-all`).

---

## Phase 4 — Menu entry and layer picker dialog

**4a [S] Entry points.** `index.html`: Add Data item "GeoPackage (.gpkg)…" with its own
hidden `<input type="file" accept=".gpkg">`; add `.gpkg` to `#fp-import-file`'s `accept`.
`js/app.js` import handler (search `Route imported file by extension`): `.gpkg` →
`App.gpkgOpenFile(file)`; update the "Supported:" alert text to the full list.

**4b [S] Picker dialog.** Markup in `index.html` beside the LODES popup, styled as a
`.gp-` namespaced floating dialog using design tokens and shared primitives (`.btn-row`,
`.rf-action-primary`, `.rf-btn-sm`). Rows: checkbox, layer name, geometry type, count,
projection label; unsupported rows disabled with the reason in muted text. Buttons: "Add to
map" (disabled when nothing is checked) and "Cancel". Escape closes it (capture-phase stop,
per the attributes-dock rule). While reading, show progress in the status bar
("Reading full_census_units… 4,000 / 11,511") and keep the dialog disabled; on finish, show a
summary status ("Added 4 layers · 2 empty geometries skipped").
`App.gpkgOpenFile` → `_loadLibs` → `_inspect` → dialog → `_readLayer` per checked layer →
`_addLayerToMap`. Files over 200 MB get a confirm() first. A file that is not SQLite or has no
`gpkg_contents` → "This file is not a GeoPackage."

**4c [S] Tests and screenshots.** Extend `gpkg-import.test.mjs` to drive the real menu →
file chooser → dialog flow with the fixture. Add a screenshot of the open dialog to
`test/ui-screens/capture.mjs` (light and dark) and inspect the images.

**Review gate [O].** Check token use, dark mode, phone-narrow width of the dialog, Escape
handling, focus order.

---

## Phase 5 — Click to see attributes  **[O]**

Delicate: `js/core/editing.js` owns map click/right-click for drawn features, and selection
must not change when a reference feature is clicked.

- A map click whose topmost rendered feature is a `gpkg-*` layer (and not a drawn feature
  or an active drawing/measure tool) opens a small MapLibre popup: layer label as title, then
  one row per attribute; JSON-object text values are shown as an indented nested list;
  long values wrap. Max height with scroll.
- Drawn features above a GeoPackage polygon still win the click. Drawing tools, measure,
  box select and edit mode suppress the popup entirely.
- Hover: pointer cursor only (no hover highlight in this plan).
- Tests: popup appears for a point and a polygon; drawing a point on top of a GeoPackage
  polygon still draws; clicking a drawn feature over a GeoPackage polygon selects the drawn
  feature and shows no popup.

---

## Phase 6 — Keep imports across refresh

**6a [S] `js/core/gpkg-store.js`.** Copy the structure of `js/core/gtfs-store.js` exactly
(same `_withStore` helper rules, swallowed failures). DB `mat-gpkg-cache`, store `files`,
record `{ key, name, savedAt, size, bytes, layers: [table names chosen], colors }`,
`MAX_ENTRIES = 3`, total-size cap 100 MB (oldest dropped first). API on `App.gpkgStore`:
`save(record)`, `list()`, `remove(key)`, `clear()`.

**6b [O] Restore at startup.** Wire restore into the startup sequence after the map style
loads and after GTFS restore, re-running the same `_inspect` / `_readLayer` /
`_addLayerToMap` path as a fresh import (so a restored layer can never differ from an
uploaded one). Removing a layer updates the stored record; removing a file's last layer
deletes the record. Restored layers start visible with their saved colors. A browser test
mirrors `gtfs-cache.test.mjs`: import, reload, layers come back; remove, reload, gone. The
`TransactionInactiveError` rule in `network-store.js` applies.

---

## Phase 7 (optional) — "Copy to drawn features" for small layers

**7a [S] Shared converter.** Extract the body of `_parseSHPBuffers` in `js/core/cache.js`
(GeoJSON feature → drawn feature, name pick, attribute copy, multi-part split) into a private
`_geojsonToDrawn(features)` used by both shapefile import and this action. No behavior change
for shapefiles (prove with the existing tests).

**7b [O] Action.** Layer row ⋯ menu "Copy to drawn features" when the layer has ≤ 2,000
features; **adds** to existing drawn features (never replaces), one undo step, selects
nothing, status "Copied N features to drawn features". Attribute fields copied this way must
work in the attributes dock and Attribute Summary without schema changes (they are free-form
`attributes.*` keys, as with shapefile import).

---

## Phase 8 — Docs and final review

**8a [S] Docs.** `docs/reference/layers-and-styling.md`: new `## gpkg-layers.js /
gpkg-reader.js / gpkg-store.js` section (behavior, ids, API, limitations: not in session JSON
or share links, unknown projections refused, Z/M dropped, collections skipped, rasters not
supported). `CLAUDE.md`: three file-map lines and the load-order line. `docs/reference/
script-load-order.md`. Run `node test/doc-coverage.mjs` and fix any missing public names.
Set this plan's status to Complete.

**8b [O] Final review.**

- `code-review` skill at `high` over the whole branch diff against `main`.
- All tiers: `node test/run-golden.mjs`, `bash test/browser/run-browser.sh`,
  `test/ui-screens/capture.mjs` (inspect images).
- Manual acceptance with the user's `comparison.gpkg` if available: all four layers import,
  land on Denver, census polygons pan smoothly, click popup shows `source_attributes` as a
  nested list, refresh restores them.
- Move this plan to `docs/archive/`.

---

## Order and parallelism

```
0a ─┐
0b ─┴─► 1a ─┐
           1b ─┴─► 2a ─► 2b ─► 2c ─► 3 ─► 4a/4b (parallel) ─► 4c ─► 5 ─► 6a ─► 6b ─► (7) ─► 8a ─► 8b
```

0a/0b and 1a/1b may run in parallel (different files). Everything from Phase 3 on is
sequential: each phase builds on the previous one's map layers and API.

## Out of scope

Writing/exporting GeoPackages; raster tiles; editing GeoPackage features in place;
using GeoPackage layers as analysis inputs (study areas, demand points); styling by attribute
(categorical/graduated); projections that need grid-shift files.
