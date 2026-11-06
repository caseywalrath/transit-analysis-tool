# GeoPackage (.gpkg) import as reference layers — implementation plan

> **Status:** Not started (written 2026-11-06; revised the same day for Haiku/Opus split).

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
  projection. All supported layers start checked. Raster tile tables and attribute-only
  tables are listed as "not supported" and cannot be checked.
- Each chosen layer appears in the **Layers panel → Reference band** as its own row
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

Two tiers. The orchestrating session (Opus) launches every task with the Agent tool and sets
`model` explicitly. **No task mixes tiers**: a task card is done entirely by one model.

| Marker | Model (`model:` value) | Use for |
|---|---|---|
| **[H]** | Haiku (`"haiku"`) | Fully specified, mechanical work with a pass/fail check: vendoring files, a fixture script with an exact byte recipe, a parser with an exact byte spec and skeleton, golden cases, copying an existing file's structure, static markup/CSS, menu wiring, docs. |
| **[O]** | Opus (`"opus"`, or the orchestrator itself) | Anything needing judgment or touching shared invariants: projection handling, sql.js/proj4 integration under load, map layers + Layers-panel manifest, async dialog flow, map clicks alongside `editing.js`, startup restore order, refactors of existing importers. Also every review gate and the final review. |

### Why Haiku tasks are written the way they are

Haiku follows explicit instructions well but should not be asked to make design decisions,
infer conventions from a large codebase, or debug across files. Every **[H]** task card
therefore contains, in this fixed order:

1. **Goal** — one sentence.
2. **Read first** — exact files and the search string that finds the relevant spot
   (search strings, not line numbers, because line numbers drift between phases).
3. **Files you may change** — a closed list. Creating or editing anything else = stop.
4. **Steps** — numbered, each one small enough to check.
5. **Contract** — exact function signatures, return shapes, ids, strings, byte layouts.
6. **Done when** — exact commands and the exact final line they must print.
7. **Stop and report if** — the situations where Haiku must stop instead of improvising.

If an [H] card seems to need something it does not specify, that is a plan bug: Haiku stops
and reports; the orchestrator fixes the card (or reassigns it to [O]), never Haiku.

### Rules pasted into every agent prompt

The orchestrator copies this block verbatim at the top of each agent prompt, followed by the
task card text verbatim (do not summarize the card — Haiku needs every line of it).

```
RULES
1. Read CLAUDE.md, docs/gpkg-import-plan.md (the "Technical decisions" section and your
   task card), and every file under "Read first" before editing anything.
2. You are on branch claude/stoic-volta-0ts0fp. Do NOT commit, push, switch branches,
   or run git commands other than `git status` and `git diff`.
3. Change only the files listed under "Files you may change". If another file seems to
   need a change, stop and report why.
4. Never edit an existing test, golden file or harness to make it pass, except where the
   card explicitly says to. Never delete or skip a test.
5. If a "Done when" command fails, you may try to fix YOUR code at most twice. If it still
   fails, stop and report the full failing output.
6. Match the surrounding code style: plain ES5-style `var`/`function` in js/ files (no
   import/export, no classes, no arrow functions in js/), IIFE wrapper, 2-space indent,
   comments explain why, not what, and never mention plan phases in code comments.
7. Do not add libraries, CDN tags, npm packages or new test frameworks.
8. Final report, in this order:
   FILES: each file changed with a one-line summary
   COMMANDS: each "Done when" command and its last output line, copied exactly
   DEVIATIONS: anything you did differently from the card, and why ("none" if none)
   QUESTIONS: anything unclear ("none" if none)
```

### Phase boundaries and model switching

Every phase follows the same cycle, so the model switches only at these points:

```
[H] task(s) (parallel where marked) ─► [O] review gate ─► [O] commit + push ─► progress log
```

- **Review gate [O]:** run the `code-review` skill at `high` on the phase's uncommitted
  diff, check it against the task cards and `CLAUDE.md`, re-run every "Done when" command
  personally (never trust the report alone), and inspect any screenshots.
- **Send-back limit:** a problem found in review goes back to a **new** Haiku agent with the
  original card plus a numbered list of exact fixes. If the second Haiku attempt still fails
  review, the orchestrator does that task itself as [O] and notes it in the progress log.
  Record every send-back in the log: that is the experiment's main data.
- **Commit:** one commit per phase (or per task where the card says so), with `Verified:`
  lines, then push. A phase never starts on an uncommitted tree.
- **Progress log:** append to the "Progress log" section at the bottom of this file in the
  same commit: phase, tasks, which model did each, send-backs and why, anything later
  phases must know. This is the hand-off that lets a fresh session (after context
  compaction or a model switch) pick up correctly.

---

## Technical decisions (fixed — do not revisit inside a phase)

**Libraries** (pinned exact versions, from unpkg like the others):

- **sql.js `1.10.3`**: `https://unpkg.com/sql.js@1.10.3/dist/sql-wasm.js` and
  `https://unpkg.com/sql.js@1.10.3/dist/sql-wasm.wasm` (~1.1 MB). **Loaded lazily**, only
  when a `.gpkg` is opened, by injecting a `<script>` tag; `initSqlJs({ locateFile: function
  (f) { return "https://unpkg.com/sql.js@1.10.3/dist/" + f; } })`. Startup cost for users who
  never open a GeoPackage: zero.
- **proj4 `2.11.0`**: `https://unpkg.com/proj4@2.11.0/dist/proj4.js` (~100 KB). Lazy-loaded
  together with sql.js.
- All three URLs go into `VENDOR_MAP` in `test/browser/harness.mjs` and their files into
  `test/ui-screens/vendor/` (the `.wasm` with type `application/wasm`) so tests stay offline.
  No `<script>` tags for them in `index.html`.

**Reading a GeoPackage** (OGC GeoPackage 1.2/1.3):

- Feature layers: `gpkg_contents` rows where `data_type = 'features'`, joined on
  `table_name` to `gpkg_geometry_columns` (`column_name`, `geometry_type_name`, `srs_id`).
- Projection: the `gpkg_spatial_ref_sys` row for that `srs_id` (`srs_id`, `organization`,
  `organization_coordsys_id`, `definition`).
- **Geometry blob layout** (all GeoPackage geometry values):

  | Bytes | Meaning |
  |---|---|
  | 0–1 | ASCII `G` `P` (0x47 0x50). Anything else → not a GeoPackage geometry. |
  | 2 | version (ignore the value) |
  | 3 | flags. bit 0 (`flags & 1`): byte order of the header's srs_id and envelope, 1 = little-endian. bits 1–3 (`(flags >> 1) & 7`): envelope type 0,1,2,3,4 → 0,32,48,48,64 envelope bytes; 5–7 invalid. bit 4 (`flags & 16`): empty geometry. |
  | 4–7 | srs_id (int32, ignore the value) |
  | 8 … 8+E−1 | envelope (E bytes; skip it) |
  | 8+E … end | standard WKB |

- **WKB:** byte 0 = byte order (1 little, 0 big) — **each nested geometry has its own byte
  order byte**. Then uint32 type. Normalize the type: if `type & 0x80000000` or
  `type & 0x40000000` (EWKB Z/M flags) or `type & 0x20000000` (EWKB SRID flag; an int32 SRID
  follows the type and must be skipped), strip those bits and note Z/M from the flags;
  then `base = type % 1000` and `iso = Math.floor(type / 1000)`. `hasZ` = EWKB Z flag or
  `iso === 1` or `iso === 3`; `hasM` = EWKB M flag or `iso === 2` or `iso === 3`;
  `dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0)`. Each coordinate is `dims` float64 values;
  keep the first two. Base types: 1 Point, 2
  LineString, 3 Polygon, 4 MultiPoint, 5 MultiLineString, 6 MultiPolygon, 7
  GeometryCollection (skipped, counted). A Point with both coordinates NaN is empty.
- Attributes: every column except the geometry column and the primary key (`pk = 1` in
  `PRAGMA table_info`). Declared type (upper-cased) decides conversion: `BOOLEAN` 0/1 →
  `false`/`true`; `BLOB` → skipped; everything else as returned. NULL → key omitted. A TEXT
  value that parses as a JSON object stays text (the popup pretty-prints it).

**Projection resolution** (`GpkgReader.resolveProjection(srsRow, envelope)`), first match wins:

1. `srs_id` 4326, or organization `EPSG` (case-insensitive) with code 4326 or 4269, or
   organization `OGC` with `CRS84` → `{ kind: "none", label: "WGS 84 (EPSG:4326)" }` (4269
   labeled "NAD83 (EPSG:4269)").
2. EPSG 3857 or 900913 → `{ kind: "proj4", def: "EPSG:3857", label: "Web Mercator (EPSG:3857)" }`.
3. EPSG 26901–26923 → `def: "+proj=utm +zone=Z +datum=NAD83 +units=m +no_defs"` with
   Z = code − 26900, label `"NAD83 / UTM zone ZN (EPSG:code)"`.
   EPSG 32601–32660 → `"+proj=utm +zone=Z +datum=WGS84 +units=m +no_defs"`, Z = code − 32600,
   label `"WGS 84 / UTM zone ZN (EPSG:code)"`. EPSG 32701–32760 → same plus ` +south`,
   Z = code − 32700, label `"… zone ZS …"`.
4. Otherwise, if `definition` is a non-empty string other than `"undefined"` →
   `{ kind: "wkt", def: definition, label: "<organization>:<code> (from file)" }`.
   `gpkg-layers.js` then tries `proj4(def)`; if proj4 throws or a projected envelope corner
   falls outside −180..180 / −90..90, the layer becomes unsupported with reason
   "Unknown projection (<org>:<code>)".
5. `srs_id` −1 or 0 (undefined SRS) → `kind: "none"` with label "Undefined (treated as
   longitude/latitude)" **only if** the envelope's min/max x lie in −180..180 and y in −90..90;
   otherwise `{ kind: "unsupported", label: "Undefined projection", error: "Undefined
   projection and coordinates are not longitude/latitude" }`.
6. Anything else → `{ kind: "unsupported", label: "<org>:<code>", error: "Unknown projection
   (<org>:<code>)" }`.

Never guess and never import untransformed projected coordinates.

**Map layers.** Each imported GeoPackage layer gets an import id `gpkgN` (counter per page
load) and one GeoJSON source `gpkg-src-gpkgN` with these layers, all inserted below the
drawn-feature layers through `firstUserLayer()`:

- polygons: `gpkg-gpkgN-fill` and `gpkg-gpkgN-outline`
- lines: `gpkg-gpkgN-line`
- points: `gpkg-gpkgN-point` (circle)

Only the kinds that have features are created. Colors come from `window.LayerPalette`
(categorical palette, next unused color). These ids are never passed to the drawn-feature
hit-testing helpers.

**Scale target.** The 11,511-polygon layer must import (parse + reproject + add to map) in
under ~5 s on a laptop and pan smoothly. If Phase 2c measures more, the orchestrator decides
between a Web Worker and geometry simplification; neither is in scope unless measured.

**State.** The import registry lives in a private closure in `js/core/gpkg-layers.js`:
`{ id, fileName, layerName, geomKinds, featureCount, bbox, color, sourceId, layerIds }`.
Public API (all on `App`): `App.gpkgOpenFile(file)`, `App.gpkgReferenceEntries()`,
`App.gpkgRemoveLayer(id)`, `App.gpkgClearAll()`, `App.gpkgLoaded()`.

---

## New and changed files

```
js/core/gpkg-reader.js     window.GpkgReader — pure: blob/WKB → GeoJSON, projection resolution,
                           row → properties. No DOM, map or sql.js access (golden-testable).
js/core/gpkg-layers.js     Lazy library loader, sql.js reading, picker dialog flow, map layers,
                           registry, click popup, App.gpkg* API.
js/core/gpkg-store.js      IndexedDB copy of imported files, modeled on gtfs-store.js.
index.html                 Add Data menu item, picker dialog markup, accept list, script tags.
js/app.js                  .gpkg routing in the import handler; Add Data eye/× config.
js/core/layers-panel.js    Reference band reads App.gpkgReferenceEntries() as dynamic entries.
css/style.css              .gp- namespace (picker dialog, feature popup).
test/cases/gpkg-reader.mjs + test/golden/gpkg-reader.json
test/fixtures/make-gpkg-fixture.py + test/fixtures/sample.gpkg
test/browser/gpkg-import.test.mjs, test/browser/gpkg-cache.test.mjs
docs/reference/layers-and-styling.md (new § gpkg), CLAUDE.md file map + load order,
docs/reference/script-load-order.md, test/ui-screens/README.md vendor table.
```

Script order: `gpkg-reader.js` right after `walk-shape.js`; `gpkg-store.js` right after
`gtfs-store.js`; `gpkg-layers.js` right after `layers-panel.js`. `layers-panel.js` calls
`App.gpkgReferenceEntries` only at render time, guarded with `typeof`, so that order is safe.

---

## Phase 0 — Vendor libraries and build the test fixture

0a and 0b are independent: launch both Haiku agents in parallel.

### 0a [H] Vendor sql.js and proj4

- **Goal:** offline copies of the two libraries for browser tests.
- **Read first:** `test/ui-screens/README.md` (the vendor section and its table);
  `test/browser/harness.mjs`, search `export const VENDOR_MAP`.
- **Files you may change:** `test/ui-screens/vendor/sql-wasm.js`,
  `test/ui-screens/vendor/sql-wasm.wasm`, `test/ui-screens/vendor/proj4.js` (new),
  `test/browser/harness.mjs`, `test/ui-screens/README.md`.
- **Steps:**
  1. In the scratchpad directory (not the repo), run `npm pack sql.js@1.10.3` and
     `npm pack proj4@2.11.0`, then `tar -xzf` each `.tgz`.
  2. Copy `package/dist/sql-wasm.js`, `package/dist/sql-wasm.wasm` (from sql.js) and
     `package/dist/proj4.js` (from proj4) into `test/ui-screens/vendor/`.
  3. Add three entries at the end of the `VENDOR_MAP` array, same style as the others:
     `["https://unpkg.com/sql.js@1.10.3/dist/sql-wasm.js", { file: "sql-wasm.js", type: "application/javascript" }]`,
     `["https://unpkg.com/sql.js@1.10.3/dist/sql-wasm.wasm", { file: "sql-wasm.wasm", type: "application/wasm" }]`,
     `["https://unpkg.com/proj4@2.11.0/dist/proj4.js", { file: "proj4.js", type: "application/javascript" }]`.
     Mind the comma after the current last entry.
  4. Add three rows to the README vendor table, copying an existing row's format.
- **Done when:** `bash test/browser/run-browser.sh` ends with `PASS — n/n checks passed`;
  `ls -l test/ui-screens/vendor/` shows the three files with non-zero sizes;
  `head -c 4 test/ui-screens/vendor/sql-wasm.wasm | od -c` shows `\0 a s m`.
- **Stop and report if:** `npm pack` fails; a `dist/` file named above does not exist; the
  browser suite fails (it should not change at all).

### 0b [H] Fixture generator

- **Goal:** a small deterministic `test/fixtures/sample.gpkg` covering every reading rule.
- **Read first:** "Reading a GeoPackage" and "Projection resolution" above.
- **Files you may change:** `test/fixtures/make-gpkg-fixture.py`, `test/fixtures/sample.gpkg` (both new).
- **Contract:** Python 3 standard library only (`sqlite3`, `struct`, `os`, `json`). Running
  `python3 -I test/fixtures/make-gpkg-fixture.py` deletes and rewrites
  `test/fixtures/sample.gpkg` next to the script (use `os.path.dirname(os.path.abspath(__file__))`).
- **Steps:**
  1. Header comment listing every table below and the rule it exercises.
  2. Helper functions (copy these exactly; `le=True` means little-endian):
     ```python
     def wkb_point(x, y, le=True, z=None):
         bo = '<' if le else '>'
         if z is None:
             return struct.pack(bo + 'BIdd', 1 if le else 0, 1, x, y)
         return struct.pack(bo + 'BIddd', 1 if le else 0, 1001, x, y, z)
     def wkb_line(coords, le=True):
         bo = '<' if le else '>'
         b = struct.pack(bo + 'BII', 1 if le else 0, 2, len(coords))
         for x, y in coords: b += struct.pack(bo + 'dd', x, y)
         return b
     def wkb_polygon(rings, le=True):
         bo = '<' if le else '>'
         b = struct.pack(bo + 'BII', 1 if le else 0, 3, len(rings))
         for ring in rings:
             b += struct.pack(bo + 'I', len(ring))
             for x, y in ring: b += struct.pack(bo + 'dd', x, y)
         return b
     def wkb_multipolygon(polys, le=True):
         bo = '<' if le else '>'
         b = struct.pack(bo + 'BII', 1 if le else 0, 6, len(polys))
         for rings in polys: b += wkb_polygon(rings, le)
         return b
     def gp_blob(wkb, env_type=0, envelope=(), empty=False, le=True):
         flags = (1 if le else 0) | (env_type << 1) | (16 if empty else 0)
         bo = '<' if le else '>'
         return b'GP' + bytes([0, flags]) + struct.pack(bo + 'i', 0) + \
             b''.join(struct.pack(bo + 'd', v) for v in envelope) + wkb
     ```
  3. Create the three required tables exactly:
     `gpkg_spatial_ref_sys(srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT)`,
     `gpkg_contents(table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER)`,
     `gpkg_geometry_columns(table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER)`.
     Use a fixed `last_change` of `'2026-01-01T00:00:00Z'`.
  4. SRS rows: (4326, 'EPSG', 4326, 'GEOGCS["WGS 84"]'), (26913, 'EPSG', 26913,
     'PROJCS["NAD83 / UTM zone 13N"]'), (-1, 'NONE', -1, 'undefined'),
     (0, 'NONE', 0, 'undefined'), (999001, 'NONE', 999001, 'NOT A REAL WKT').
  5. Feature tables (each `fid INTEGER PRIMARY KEY`, `geom BLOB`, plus the listed columns),
     each with a `gpkg_contents` row (`data_type 'features'`, envelope from its coordinates)
     and a `gpkg_geometry_columns` row:
     - `pts_utm` (srs 26913, POINT): columns `name TEXT, flag BOOLEAN, info TEXT, note TEXT`.
       Rows: (500000, 4400000) name 'center' flag 1 info '{"a":1,"b":[2,3]}' note NULL;
       (501000, 4400000) name 'east' flag 0 info 'plain' note 'n';
       (500000, 4401000) name 'north' flag 1 info NULL note 'n'.
     - `lines_wgs` (srs 4326, LINESTRING): column `label TEXT`. Row 1 little-endian
       [(-105.0, 39.7), (-104.9, 39.8)] label 'le'; row 2 written with `le=False` in both
       `wkb_line` and `gp_blob`, [(-105.1, 39.6), (-105.0, 39.65), (-104.95, 39.7)] label 'be'.
     - `polys_utm` (srs 26913, MULTIPOLYGON), `env_type=1` with envelope (minx, maxx, miny,
       maxy): row 1 a Polygon outer ring square 499000..501000 × 4399000..4401000 with a hole
       square 499500..500500 × 4399500..4400500 (rings closed); row 2 a MultiPolygon of two
       separate closed squares 502000..502500 × 4399000..4399500 and 503000..503500 ×
       4399000..4399500.
     - `mixed_z` (srs 4326, GEOMETRY): row 1 `wkb_point(-105.0, 39.75, z=1600.0)`; row 2 a
       LineString [(-105.0, 39.75), (-104.99, 39.76)].
     - `empty_geom` (srs 4326, POINT): row 1 `gp_blob(wkb_point(float('nan'), float('nan')),
       empty=True)`; row 2 geom NULL.
     - `weird_srs` (srs 999001, POINT): one point (1.0, 2.0).
     - `undef_ok` (srs -1, POINT): one point (-105.0, 39.75), contents envelope equal to it.
     - `undef_bad` (srs 0, POINT): one point (500000, 4400000), contents envelope equal to it.
  6. Non-feature rows in `gpkg_contents`: an `attributes` table `notes(id INTEGER PRIMARY
     KEY, text TEXT)` with one row and `data_type 'attributes'`; a `gpkg_contents` row
     `('tiles_tbl', 'tiles', …)` with no actual table needed.
  7. Insert rows in a fixed order; `PRAGMA application_id = 0x47504B47` and
     `PRAGMA user_version = 10300`; `conn.commit()`, then `VACUUM`, then close.
- **Done when:** run the script twice, `sha256sum test/fixtures/sample.gpkg` after each run
  prints the same hash; the file is under 50 KB;
  `python3 -I -c "import sqlite3;c=sqlite3.connect('test/fixtures/sample.gpkg');print(c.execute('select count(*) from gpkg_contents').fetchone())"`
  prints `(10,)`.
- **Stop and report if:** the two hashes differ after you have checked for timestamps and
  random values; you think a rule above is wrong.

### Phase 0 review gate [O]

Confirm the fixture covers every rule in "Reading a GeoPackage" and "Projection resolution"
(open it with `python3 -I` and decode one blob of each kind by hand). Commit `Phase 0`.

---

## Phase 1 — Pure reader engine (`js/core/gpkg-reader.js`)

1a and 1b touch the same file, so run them **in sequence**: 1a [H] first, then 1b [O].

### 1a [H] Geometry and rows

- **Goal:** pure functions that turn GeoPackage blobs and rows into GeoJSON and properties.
- **Read first:** `js/core/walk-cost.js` (whole file — copy its IIFE/namespace shape);
  `test/cases/walk-cost.mjs`; `test/run-golden.mjs` header comment; the "Reading a
  GeoPackage" section above.
- **Files you may change:** `js/core/gpkg-reader.js`, `test/cases/gpkg-reader.mjs`,
  `test/golden/gpkg-reader.json` (all new).
- **Contract** (all on `window.GpkgReader`):
  - `parseGeometryBlob(bytes)` — `bytes` is a `Uint8Array`. Returns
    `{ geometry: <GeoJSON geometry object or null>, empty: <bool>, skipped: <null | "collection"> }`.
    Throws `Error("Not a GeoPackage geometry")` if bytes 0–1 are not `GP`, and
    `Error("Bad envelope type")` for envelope type 5–7. Empty flag set → `{ geometry: null,
    empty: true, skipped: null }` without reading WKB.
  - `wkbToGeoJSON(view, offset)` — `view` is a `DataView`. Returns `{ geometry, bytesRead }`;
    geometry is `null` for GeometryCollection (the caller turns that into
    `skipped: "collection"`; still compute `bytesRead` correctly by walking the members).
  - `rowToProperties(columns, values)` — `columns` is an array of
    `{ name, type, pk, isGeom }`, `values` the matching array. Rules per Technical decisions.
  - `parseGeometryHex(hex)` and `rowToPropertiesJSON(columnsJson, valuesJson)` — thin
    wrappers for golden tests only (hex string → `Uint8Array` → `parseGeometryBlob`), since
    golden case arguments must be plain JSON.
  - GeoJSON coordinate arrays are `[x, y]` (two numbers); Polygon is an array of rings;
    Multi* nest one level deeper. A MultiPoint member is a full WKB Point.
- **Steps:**
  1. Write the file using the WKB normalization rules exactly as written above.
  2. Write `test/cases/gpkg-reader.mjs` (`scripts: ["js/core/gpkg-reader.js"]`). Build hex
     strings with small helper functions at the top of the case file (plain JS that
     writes bytes into a `DataView` and hex-encodes them). Cases, one `id` each:
     Point LE no envelope; Point BE; Point with envelope types 1, 2, 3, 4; empty flag;
     LineString; Polygon with hole; MultiPoint; MultiLineString; MultiPolygon with 2 parts;
     MultiPolygon whose second member is big-endian inside a little-endian outer;
     PointZ (1001), PointM (2001), PointZM (3001), LineStringZ (1002); EWKB PointZ
     (type `0x80000001`); EWKB with SRID flag (`0x20000001` + int32 SRID);
     GeometryCollection containing a Point (expect `skipped: "collection"`);
     bad magic (expect the error — wrap with a tiny `{ call: …, expectError: true }` only if
     `run-golden.mjs` supports it; otherwise add `GpkgReader.tryParseGeometryHex` returning
     `{ error: message }` and test that);
     rowToProperties: BOOLEAN 0/1, NULL omitted, BLOB skipped, pk skipped, geom skipped,
     JSON-object text unchanged, lower-case declared type `boolean`.
  3. `node test/run-golden.mjs gpkg-reader --update`, then open
     `test/golden/gpkg-reader.json` and check by eye that every result is what the contract
     says (correct coordinates, no `NaN`, Z dropped). Fix the code — not the expectation —
     for any wrong value, then re-run `--update`.
- **Done when:** `node test/run-golden.mjs` (no filter, no `--update`) ends with
  `PASS — N/N cases passed`.
- **Stop and report if:** a golden result looks wrong and two fixes did not correct it;
  `run-golden.mjs` cannot load the file in its sandbox.

### 1b [O] Projection resolution

Add to `js/core/gpkg-reader.js`:

- `resolveProjection(srsRow, envelope)` → `{ kind: "none" | "proj4" | "wkt" | "unsupported",
  def?, label, error? }`, exactly the rules in "Projection resolution". `srsRow` is
  `{ srs_id, organization, organization_coordsys_id, definition }`; `envelope` is
  `{ minX, minY, maxX, maxY }` or null.
- `transformGeometry(geometry, fn)` → new geometry with `fn([x, y]) → [lon, lat]` applied to
  every coordinate (pure; takes the function so golden tests need no proj4). Golden tests use
  a simple affine `fn` built inside a JSON-friendly wrapper.

Golden cases: every resolution step, 4269 label, 900913, zone 1 and 60, south zones,
26900/26924/32661 out of range → falls to step 4 or 6, WKT step, undefined SRS with lon/lat
and with projected envelope, organization casing. The real-proj4 check of EPSG:26913
`500000, 4400000` → about `−105.0000, 39.7499` happens in the Phase 2 browser test.
*Verify:* `node test/run-golden.mjs` → PASS.

### Phase 1 review gate [O]

Review 1a's diff (the 1b diff is the orchestrator's own work, so review it with the skill
too). Check every golden number in 1a by hand for at least six cases. Commit `Phase 1`.

---

## Phase 2 — Loading a file (`js/core/gpkg-layers.js`, no UI yet)

### 2a [H] Loader and reader

- **Goal:** read the fixture with sql.js into GeoJSON in WGS 84, behind a test hook.
- **Read first:** `js/core/gtfs-store.js` (IIFE shape and comment style); in
  `js/projects/route-costing.js` search `__MAT_TEST__` (test-hook pattern);
  `js/core/gpkg-reader.js` (whole file); in `index.html` search `walk-shape.js` and
  `layers-panel.js`.
- **Files you may change:** `js/core/gpkg-layers.js` (new), `index.html` (two script tags only).
- **Contract** (private functions in the IIFE unless noted):
  - `_loadLibs()` → Promise of `{ SQL, proj4 }`. Cached in a closure variable. Injects
    `<script src>` for the sql.js and proj4 URLs in Technical decisions (one after the
    other; resolve when both `onload` fire), then `window.initSqlJs({ locateFile: … })`.
    On any failure: set the cache back to `null`, and reject with
    `Error("Could not load the GeoPackage reader. Check your internet connection and try again.")`.
  - `_openDb(libs, arrayBuffer)` → `new libs.SQL.Database(new Uint8Array(arrayBuffer))`.
    Then `SELECT count(*) FROM sqlite_master WHERE name = 'gpkg_contents'`; if 0, close the
    db and throw `Error("This file is not a GeoPackage.")`. A sql.js constructor error is
    rethrown as the same message.
  - `_inspect(libs, db)` → `{ layers: [ { table, geomColumn, geomType, srsRow, envelope,
    projection, count, supported, reason } ] }`. Feature layers come from the join in
    Technical decisions; `projection = GpkgReader.resolveProjection(srsRow, envelope)`;
    if `projection.kind === "wkt"`, try `libs.proj4(projection.def, "EPSG:4326")` and
    forward-transform the four envelope corners; on throw or any result outside lon/lat
    range, `supported = false, reason = "Unknown projection (<label>)"`.
    `projection.kind === "unsupported"` → `supported = false, reason = projection.error`.
    `count` from `SELECT count(*) FROM "<table>"` (double-quote the name; double any `"`
    inside it). Every other `gpkg_contents` row is listed with `supported = false` and
    reason `"Raster tiles are not supported"` (`data_type = 'tiles'`) or
    `"Table has no geometry"` (anything else).
  - `_readLayer(libs, db, layer, onProgress)` → `{ featureCollection, skipped: { empty,
    nullGeom, collection } }`. Get columns via `PRAGMA table_info("<table>")`. Use
    `var stmt = db.prepare('SELECT * FROM "<table>"')`, loop `while (stmt.step())` with
    `stmt.get()` (array of values) — never `db.exec` on the whole table — and
    `stmt.free()` in a `finally`. Geometry value `null` → `nullGeom++`; else
    `GpkgReader.parseGeometryBlob(value)`; empty → `empty++`; skipped → `collection++`.
    Transform with `GpkgReader.transformGeometry(g, fn)` where `fn` is identity for
    `kind "none"`, else `function (c) { return converter.forward(c); }` with
    `converter = libs.proj4(def, "EPSG:4326")` built once per layer. Call
    `onProgress(done, total)` every 1,000 rows if given. Each feature's `properties` =
    `GpkgReader.rowToProperties(...)`; set `feature.id` to the row's pk value.
  - Test hook at the end of the IIFE, inside `if (window.__MAT_TEST__) { … }`:
    `App._gpkgTest = { loadLibs: _loadLibs, openDb: _openDb, inspect: _inspect, readLayer: _readLayer };`
- **Steps:** write the file; add `<script src="js/core/gpkg-reader.js"></script>` right
  after the `walk-shape.js` tag and `<script src="js/core/gpkg-layers.js"></script>` right
  after the `layers-panel.js` tag.
- **Done when:** `bash test/browser/run-browser.sh` ends with `PASS — n/n checks passed`
  (proves the app still starts with the new files loaded).
- **Stop and report if:** `App` is undefined when the file loads; any existing browser test
  fails.

### 2b [H] Browser test, part 1

- **Goal:** prove 2a reads the fixture correctly in a real browser.
- **Read first:** `test/browser/README.md`; `test/browser/gtfs-cache.test.mjs` (whole file
  — copy its setup, `__MAT_TEST__` injection, polling and PASS/FAIL reporting exactly);
  `test/browser/harness.mjs`.
- **Files you may change:** `test/browser/gpkg-import.test.mjs` (new); `test/browser/run-browser.sh`
  only if it lists test files explicitly.
- **Steps:** load the app; in `page.evaluate`, `fetch("/test/fixtures/sample.gpkg")` →
  `arrayBuffer` → `App._gpkgTest.loadLibs()` → `openDb` → `inspect` → `readLayer` for each
  supported layer; return a plain JSON summary; check it in Node. One named check each:
  1. supported tables are exactly `pts_utm, lines_wgs, polys_utm, mixed_z, empty_geom, undef_ok`;
  2. unsupported: `weird_srs` (reason starts `Unknown projection`), `undef_bad`, `notes`
     ("Table has no geometry"), `tiles_tbl` ("Raster tiles are not supported");
  3. `pts_utm` has 3 features; `center` is within 1e-4 of `[-105.0000, 39.7499]`
     (orchestrator confirms the exact value in review);
  4. `lines_wgs` row `be` coordinates equal the fixture's exactly;
  5. `polys_utm` row 1 is a Polygon with 2 rings; row 2 a MultiPolygon with 2 polygons;
  6. `mixed_z` point has exactly 2 coordinates;
  7. `empty_geom`: 0 features, `skipped.empty === 1`, `skipped.nullGeom === 1`;
  8. `pts_utm` `center` has `flag === true`, no `note` key, `info` is the JSON text;
  9. a non-GeoPackage buffer (`new Uint8Array([1,2,3]).buffer`) rejects with
     "This file is not a GeoPackage.".
- **Done when:** `NODE_PATH=/opt/node-tools/node_modules node test/browser/gpkg-import.test.mjs`
  and `bash test/browser/run-browser.sh` both end with `PASS — n/n checks passed`.
- **Stop and report if:** a check fails and the cause looks like it is in `gpkg-layers.js`
  or `gpkg-reader.js` (you may not change those — report the failing values instead); the
  vendored `.wasm` is not served.

### 2c [O] Scale check and review gate

Review 2a/2b. Run the reader against the user's `comparison.gpkg` if they attach it again
(never commit it — it is user data; read it only through the app in the browser harness).
Record parse + transform time per layer in the progress log and apply the scale rule.
Commit `Phase 2`.

---

## Phase 3 — Map layers and the Layers panel  **[O]**

Delicate: shared manifest, layer z-order, Add Data icons, clear-all and removal all have
invariants documented in `docs/reference/layers-and-styling.md` and `core-app.md`. No Haiku
tasks in this phase.

- `_addLayerToMap(id, featureCollection, meta)` — source + layers per Technical decisions,
  inserted with `firstUserLayer()`; color from `LayerPalette`.
- `App.gpkgReferenceEntries()` returns one entry per import shaped like the static
  `REFERENCE` entries in `js/core/layers-panel.js`: `{ id, label, layers: [{id, op}], clear,
  badge, menuItems }`. `badge` shows the feature count; `menuItems` adds "Zoom to layer".
- `js/core/layers-panel.js`: the Reference band iterates `REFERENCE.concat(dynamic)` wherever
  it iterates `REFERENCE` today (render, `entryPresent`, reorder clamping, remove). Search for
  every `REFERENCE` use; do not fork the row builder.
- Solid style drawer: register a `styleKey` per import so color edits go through
  `App.setLayerStyle` (never `map.setPaintProperty`).
- Removal: `App.gpkgRemoveLayer(id)` removes layers then source and drops the registry entry;
  the manifest `clear` calls it, so it goes through `removeEntry`. Undo does not restore it
  (same as GTFS).
- Add Data menu: one `_adClrCfgs` entry in `js/app.js` for the GeoPackage item (eye toggles
  all imports, × calls `App.gpkgClearAll()`).
- Clear All: match what Clear All does for GTFS; document the choice in the progress log.
- Temporary: until Phase 4 exists, the test drives `_addLayerToMap` through an extended
  `App._gpkgTest` hook.
- Extend `gpkg-import.test.mjs`: layers exist after import, appear in the Reference band,
  eye hides them, opacity changes, Remove deletes source + layers, drawn features untouched,
  two imports of the same file get distinct ids.

*Verify:* `bash test/browser/run-browser.sh` → PASS (including `hidden-features`,
`layer-remove`, `clear-all`). Commit `Phase 3`.

Phase 3 also leaves a **"Haiku hand-off notes"** paragraph in the progress log naming the
exact functions Phase 4 calls (`_inspect`, `_readLayer`, `_addLayerToMap` signatures) and the
Add Data menu item's id, so 4a/4b cards can be completed precisely.

---

## Phase 4 — Menu entry and layer picker dialog

Run 4a and 4b **in parallel** (different files), then 4c [O], then 4d [H].

### 4a [H] Entry points

- **Goal:** both import paths hand `.gpkg` files to `App.gpkgOpenFile`.
- **Read first:** `index.html`, search `fp-import-file` and the Add Data menu (search
  `Add Data`); `js/app.js`, search `Route imported file by extension` and `Supported:`;
  the Phase 3 hand-off notes in the progress log.
- **Files you may change:** `index.html`, `js/app.js`.
- **Steps:**
  1. Add `.gpkg` to the end of `#fp-import-file`'s `accept` list.
  2. Add an Add Data menu item "GeoPackage (.gpkg)…" next to the Shapefile item, copying
     that item's markup and classes, with id `ad-gpkg` and its own hidden
     `<input type="file" id="ad-gpkg-file" accept=".gpkg">`.
  3. In `js/app.js`, wire `ad-gpkg` click → `ad-gpkg-file.click()`, and the input's
     `change` → `App.gpkgOpenFile(file)` then reset `value = ""` — copy the Shapefile item's
     wiring.
  4. In the extension router, add `.gpkg` → `App.gpkgOpenFile(file)` before the fallback,
     and add `.gpkg` to the "Supported:" alert text.
  5. Until 4c lands, `App.gpkgOpenFile` may not exist: guard both calls with
     `if (typeof App.gpkgOpenFile === "function")`.
- **Done when:** `bash test/browser/run-browser.sh` → `PASS — n/n checks passed`;
  `grep -n "gpkg" index.html js/app.js` shows only the lines you added.
- **Stop and report if:** the Shapefile item or its wiring cannot be found by those searches.

### 4b [H] Picker dialog markup and CSS (static only)

- **Goal:** the dialog's HTML and styles, with no behavior.
- **Read first:** `index.html`, search `lodes` (the LODES popup markup to sit beside);
  `css/style.css`, search `:root`, `body.dark-mode`, `.btn-row`, `.rf-action-primary`,
  `.rf-btn-sm`; CLAUDE.md "Design tokens".
- **Files you may change:** `index.html`, `css/style.css`.
- **Contract:** markup, hidden by default (`hidden` attribute):
  ```html
  <div id="gp-dialog" class="gp-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-title" hidden>
    <h2 id="gp-title" class="gp-title">Add GeoPackage layers</h2>
    <div id="gp-file-name" class="gp-file-name"></div>
    <div id="gp-layer-list" class="gp-layer-list"></div>
    <div id="gp-progress" class="gp-progress" aria-live="polite"></div>
    <div class="btn-row">
      <button id="gp-cancel" class="rf-btn-sm">Cancel</button>
      <button id="gp-add" class="rf-action-primary" disabled>Add to map</button>
    </div>
  </div>
  ```
  Row template (for the CSS and for 4c to generate): `<label class="gp-row">` containing
  `<input type="checkbox">`, `<span class="gp-name">`, `<span class="gp-meta">` (geometry ·
  count · projection); unsupported rows add class `gp-row-disabled` and a
  `<span class="gp-reason">`.
- **Steps:** add the markup; add a `/* GeoPackage import (.gp-) */` CSS block: fixed,
  centered, `max-width: 520px; width: calc(100vw - 32px)`, `max-height: 80vh`, list scrolls,
  only `var(--…)` tokens for color/spacing/radius/shadow, muted text color for `.gp-meta`
  and `.gp-reason`, reduced opacity for `.gp-row-disabled`. Copy token usage from an
  existing dialog rule; no raw hex.
- **Done when:** `bash test/browser/run-browser.sh` → PASS;
  `grep -n "#[0-9a-fA-F]\{3,6\}" css/style.css` shows no new lines inside the `.gp-` block.
- **Stop and report if:** no existing floating dialog rule exists to copy tokens from.

### 4c [O] Dialog flow

`App.gpkgOpenFile(file)`: size > 200 MB → `confirm()`; `_loadLibs` → `_openDb` → `_inspect`
→ fill `#gp-layer-list` → wait for Add/Cancel → `_readLayer` per checked layer with progress
in `#gp-progress` and the status bar ("Reading full_census_units… 4,000 / 11,511"), dialog
controls disabled meanwhile → `_addLayerToMap` → summary status ("Added 4 layers · 2 empty
geometries skipped") → close and `db.close()`. Escape closes (capture-phase stop, per the
attributes-dock rule); focus moves to the first checkbox on open and returns to the menu on
close; "Add to map" disabled when nothing is checked. Remove the `typeof` guards from 4a.

### 4d [H] Tests and screenshots

- **Goal:** drive the real menu → file chooser → dialog flow; add screenshots.
- **Read first:** `test/browser/gpkg-import.test.mjs`; `test/ui-screens/capture.mjs`
  (search for an existing dialog/popup capture to copy); Playwright's
  `page.setInputFiles` usage in any existing test (`grep -rn setInputFiles test/`).
- **Files you may change:** `test/browser/gpkg-import.test.mjs`,
  `test/ui-screens/capture.mjs`, new images under `test/ui-screens/baseline/` produced by
  the capture script.
- **Steps:** add checks: `setInputFiles("#ad-gpkg-file", "test/fixtures/sample.gpkg")` →
  dialog visible with 10 rows, 4 disabled; uncheck all → Add disabled; check `pts_utm` only
  → Add → dialog hidden, one new Reference row; Escape on a reopened dialog closes it with no
  layers added. Add a capture of the open dialog in light and dark mode, copying an existing
  capture's structure.
- **Done when:** the gpkg test and `bash test/browser/run-browser.sh` → PASS; the capture
  script runs and the two new images exist. Attach the two image paths to the report.
- **Stop and report if:** a check fails (do not change app code).

### Phase 4 review gate [O]

Inspect the screenshots: tokens, dark mode, a 360 px-wide viewport, focus order, Escape.
Commit `Phase 4`.

---

## Phase 5 — Click to see attributes  **[O]**

Delicate: `js/core/editing.js` owns map click/right-click for drawn features, and selection
must not change when a reference feature is clicked. No Haiku tasks.

- A map click whose topmost rendered feature is a `gpkg-*` layer (and not a drawn feature
  or an active drawing/measure tool) opens a small MapLibre popup: layer label as title, then
  one row per attribute; JSON-object text values are shown as an indented nested list;
  long values wrap; max height with scroll.
- Drawn features above a GeoPackage polygon still win the click. Drawing tools, measure,
  box select and edit mode suppress the popup entirely.
- Hover: pointer cursor only.
- Tests: popup appears for a point and a polygon; drawing a point on top of a GeoPackage
  polygon still draws; clicking a drawn feature over a GeoPackage polygon selects the drawn
  feature and shows no popup.

*Verify:* full browser suite → PASS; screenshot of the popup inspected. Commit `Phase 5`.

---

## Phase 6 — Keep imports across refresh

### 6a [H] `js/core/gpkg-store.js`

- **Goal:** an IndexedDB store of imported GeoPackage files, structurally identical to the
  GTFS one.
- **Read first:** `js/core/gtfs-store.js` (whole file) and the `_withStore` /
  TransactionInactiveError comment in `js/core/network-store.js`.
- **Files you may change:** `js/core/gpkg-store.js` (new), `index.html` (one script tag
  right after the `gtfs-store.js` tag).
- **Steps:**
  1. Copy `gtfs-store.js` to `gpkg-store.js`. Change only: header comment (describe this
     store: GeoPackage files, why bytes not parsed features, records keyed by file name),
     `IDB_NAME = "mat-gpkg-cache"`, `IDB_STORE = "files"`, `MAX_ENTRIES = 3`, the record
     shape, the `App.` export name, and add the size cap.
  2. Record: `{ name, savedAt, size, bytes, layers: [table names], colors: { table: color } }`.
  3. Size cap: after a save, if the sum of `size` across records exceeds 100 MB
     (`100 * 1024 * 1024`), delete oldest-`savedAt` records until it fits, using the same
     pruning code path the file already uses for `MAX_ENTRIES`.
  4. Export `App.gpkgStore = { supported, save, list, remove, clear }` with the same
     semantics as the GTFS equivalents (`list` returns newest first). If the GTFS store
     names a function differently, keep the GTFS name and report the mapping.
- **Done when:** `bash test/browser/run-browser.sh` → PASS; `diff js/core/gtfs-store.js
  js/core/gpkg-store.js` shows only the changes listed in step 1–4.
- **Stop and report if:** the GTFS store's API differs enough that step 4 would need new
  logic beyond renaming.

### 6b [O] Restore at startup

Wire restore into the startup sequence after the map style loads and after GTFS restore,
re-running the same `_openDb` / `_inspect` / `_readLayer` / `_addLayerToMap` path as a fresh
import. Removing a layer updates the stored record; removing a file's last layer deletes the
record. Restored layers start visible with their saved colors. New
`test/browser/gpkg-cache.test.mjs` mirrors `gtfs-cache.test.mjs`: import, reload, layers come
back; remove, reload, gone. Commit `Phase 6`.

---

## Phase 7 (optional) — "Copy to drawn features" for small layers  **[O]**

Both parts are [O]: 7a is a behavior-preserving refactor of the shapefile importer in
`js/core/cache.js`, which is exactly the kind of change Haiku should not do unsupervised.

- **7a** Extract the body of `_parseSHPBuffers` (GeoJSON feature → drawn feature, name pick,
  attribute copy, multi-part split) into a private `_geojsonToDrawn(features)` used by both
  shapefile import and this action. No behavior change for shapefiles (prove with a
  before/after comparison on a shapefile fixture).
- **7b** Layer row ⋯ menu "Copy to drawn features" when the layer has ≤ 2,000 features;
  **adds** to existing drawn features (never replaces), one undo step, selects nothing,
  status "Copied N features to drawn features". Copied fields are free-form `attributes.*`
  keys, as with shapefile import, so no attributes-dock / Attribute Summary schema change.

---

## Phase 8 — Docs and final review

### 8a [H] Docs

- **Goal:** document the feature where `CLAUDE.md` says docs live.
- **Read first:** `docs/reference/layers-and-styling.md` (whole file, to copy section
  style); `CLAUDE.md` "File Map" and "Script Load Order"; `docs/reference/script-load-order.md`;
  the whole progress log in this plan.
- **Files you may change:** `docs/reference/layers-and-styling.md`, `CLAUDE.md`,
  `docs/reference/script-load-order.md`, `docs/gpkg-import-plan.md` (status line only).
- **Steps:**
  1. New section `## gpkg-layers.js / gpkg-reader.js / gpkg-store.js`: what it does; map
     source/layer ids; `App.gpkg*` and `window.GpkgReader` API (one line each, from the
     code, not from this plan); limitations — not saved in session JSON or share links,
     unknown projections refused, Z/M dropped, geometry collections skipped, rasters not
     supported; the Clear All decision from the progress log.
  2. `CLAUDE.md` File Map: three lines under `js/core/`, each ≤ one line, each ending with
     `[layers-and-styling]`, placed beside related files. Script Load Order block: insert the
     three names at their real positions.
  3. `script-load-order.md`: one entry per file, copying the neighbors' format.
  4. Run `node test/doc-coverage.mjs`; add any listed `App.gpkg*` / `GpkgReader` name to the
     new section.
  5. Set this plan's status line to `Complete (<date>)`.
- **Done when:** `node test/doc-coverage.mjs` lists no gpkg names;
  `NODE_PATH=/opt/node-tools/node_modules node test/comment-guard.mjs HEAD` passes.
- **Stop and report if:** the code and this plan disagree about an API (document the code,
  and list the disagreement).

### 8b [O] Final review

- `code-review` skill at `high` over the whole branch diff against `main`.
- All tiers: `node test/run-golden.mjs`, `bash test/browser/run-browser.sh`,
  `test/ui-screens/capture.mjs` (inspect images).
- Manual acceptance with the user's `comparison.gpkg` if available: all four layers import,
  land on Denver, census polygons pan smoothly, click popup shows `source_attributes` as a
  nested list, refresh restores them.
- Write the experiment summary at the end of the progress log: Haiku tasks, first-pass
  acceptance rate, send-backs, tasks reassigned to Opus, and which card features helped.
- Move this plan to `docs/archive/`.

---

## Order and parallelism

```
Phase 0:  0a[H] ∥ 0b[H] ─► gate[O]
Phase 1:  1a[H] ─► 1b[O] ─► gate[O]
Phase 2:  2a[H] ─► 2b[H] ─► 2c[O] gate
Phase 3:  3[O]
Phase 4:  4a[H] ∥ 4b[H] ─► 4c[O] ─► 4d[H] ─► gate[O]
Phase 5:  5[O]
Phase 6:  6a[H] ─► 6b[O]
Phase 7:  7[O]  (optional)
Phase 8:  8a[H] ─► 8b[O]
```

Haiku tasks: 0a, 0b, 1a, 2a, 2b, 4a, 4b, 4d, 6a, 8a (10). Opus tasks: 1b, 2c, 3, 4c, 5, 6b,
7, 8b, plus every gate.

## Out of scope

Writing/exporting GeoPackages; raster tiles; editing GeoPackage features in place;
using GeoPackage layers as analysis inputs (study areas, demand points); styling by attribute
(categorical/graduated); projections that need grid-shift files.

---

## Progress log

_Appended by the orchestrator at each phase commit: phase, tasks and the model that did
each, send-backs (count and reason), reassignments, and notes later phases need._

**Phase 0 (2026-11-06).** 0a [H] and 0b [H] ran in parallel; both accepted first pass, 0 send-backs.
- 0a: README has one row covering both sql.js files instead of two (fine). `run-browser.sh`
  prints no overall summary line; "Done when" for browser runs means every file reports
  PASS and none FAIL (20/20 files).
- 0b: added `PRAGMA page_size = 1024` to get under 50 KB (16 KB). `polys_utm` row 1 is a
  plain Polygon inside a MULTIPOLYGON-typed table (deliberate: readers must accept it).
  `empty_geom` and the non-feature rows have NULL envelopes. Fixture sha256 `af3df120…`.
- Gate: decoded blobs by hand (magic, flags, UTM point); code-review skill skipped as the
  diff is vendored files plus a test generator.

**Phase 1 (2026-11-06).** 1a [H] accepted after **1 send-back**; 1b [O] by the orchestrator.
- 1a first pass: clean code and 39 correct golden cases, but `code-review` (high) found gaps
  the card never specified: sized `BLOB(n)` types, curve types (8+) throwing and aborting a
  layer, zero-count bodies not reported empty, Multi* member type not checked, one-NaN
  points, ExtendedGeoPackageBinary flag, loose hex parsing, `bytesRead` untested. Send-back
  with 8 numbered fixes; second Haiku pass did all 8 with no regressions. Lesson: the card's
  contract was the ceiling of what Haiku built; edge cases need to be listed in the card.
- 1b review finding (orchestrator's own bug): undefined SRS was checked before the file's
  WKT; now WKT first, matching the plan order.
- **For Phase 2:** `skipped` can be `null`, `"collection"` or `"unsupported"`; `_readLayer`
  must count `unsupported` too (add `skipped.unsupported`). `wkbToGeoJSON` still throws on
  unknown types; always go through `parseGeometryBlob`. A Polygon whose rings have zero
  points (`[[]]`) is passed through; the loader should drop features whose geometry fails a
  cheap bbox check. Extra wrappers on `GpkgReader` (`*Hex`, `*JSON`, `transformGeometryAffine`,
  `wkbHexToGeoJSON`) exist for golden tests only.

**Phase 2 (2026-11-06).** 2a [H] and 2b [H] accepted after **1 combined send-back**; 2c [O].
- 2a first pass followed the card plus the 12 up-front edge cases (A–L) with no misses; the
  card-listed edge cases worked. Review (high) still found what neither listed: sql.js
  caches a failed init globally (no retry), tiles-only files lacking
  `gpkg_geometry_columns` threw raw SQL errors, one bad layer aborted `_inspect`,
  case-sensitive identifier matching, composite/TEXT primary keys, a double count(*).
  Send-back (6 fixes + 4 tests) passed; Haiku also found and fixed a real hang on its own
  (sql.js never settles when its WASM fetch fails, so the bytes are now fetched first and
  passed as `wasmBinary`).
- Orchestrator fixes: "Unknown projection" reasons drop the "(from file)" suffix; WKT
  `AXIS[...]` clauses are stripped before proj4 (GeoPackage stores x/y regardless of the
  CRS's axis order; proj4 would otherwise swap). WKT2 nested AXIS clauses are not handled.
- **2c scale check** with the user's `comparison.gpkg` (headless Chromium, this
  container): library load 48 ms (vendored), inspect 44 ms; `full_census_units` 11,511
  rows read+reprojected in 310 ms, added to map and idle in ~1.15 s; the other layers
  31 ms / 16 ms / 3 ms read, ~0.4–0.5 s to map. All features kept, all land around
  Denver. Well under the 5 s target: **no Web Worker or simplification needed.**
- **For Phase 4c:** `_readLayer` and `onProgress` are fully synchronous, so a progress
  bar would not repaint mid-layer. At the measured speeds per-layer progress (update
  between layers, yielding with `setTimeout(0)`) is enough; per-1,000-row progress is not
  worth making the loop async.
- Deferred to 8a: CLAUDE.md file map/load order and doc-coverage entries for
  `GpkgReader`, `App._gpkgTest` (test-only, guarded); header comments that point at this
  plan file must be repointed when it moves to `docs/archive/`.

**Phase 3 (2026-11-06).** All [O], by the orchestrator; review (high) found 10 items, 8 fixed.
- Map: one source `gpkg-src-gpkgN`, layers `-fill`/`-outline`/`-line`/`-point` filtered by
  geometry type, added bottom-to-top below drawn features via the new shared
  `App.firstUserLayer()` (exported from `network-connectors.js`, no fourth copy). Colors
  from a fixed 8-color list in `gpkg-layers.js` (LayerPalette has no categorical palette).
  Fill transparency lives in the fill color (`FILL_ALPHA` 0.35) so every opacity starts
  at 1 and the row's single slider reads 100% for "as imported".
- Styling: new `App.registerLayerStyle(key, spec, repaint)` / `App.unregisterLayerStyle(key)`
  in `layer-palettes.js` for run-time styleable layers; each import is a `solid` spec
  `gpkg-gpkgN`. A recolored import's override sits in `App.layerStyles` (so it reaches
  session JSON) until the layer is removed; a new import deletes any stale override for
  its key because ids restart at gpkg1 each page load. Accepted; documented in 8a.
- Panel: `layers-panel.js` `referenceEntries()` = `REFERENCE` + `App.gpkgReferenceEntries()`;
  a new import is slotted into `_refOrder` by its real map position; removed ids pruned.
  "Zoom to layer" and "Remove layer" come from the generic row menu.
- `_addLayerToMap` returns `null` and registers nothing for an empty collection.
- Clear All: toolbar Clear now calls `App.gpkgClearAll()`, matching GTFS (removed through
  `clearModules()`). Undo does not restore imports (as GTFS); the undo step it pushes is
  accepted.
- Add Data: `_adClrCfgs` entry for button id **`ad-gpkg`** (eye = `App.gpkgVisible` /
  `App.gpkgSetVisible`, × = `App.gpkgClearAll`); inert until 4a adds the button.
- **Haiku hand-off notes for Phase 4:** private functions in `gpkg-layers.js`:
  `_loadLibs()` → Promise `{SQL, proj4}`; `_openDb(libs, arrayBuffer)` → db (throws
  "This file is not a GeoPackage."); `_inspect(libs, db)` → `{layers:[{table, geomType,
  projection:{label}, count, supported, reason}]}`; `_readLayer(libs, db, layer,
  onProgress)` → `{featureCollection, skipped:{empty, nullGeom, collection, unsupported,
  invalid}}`; `_addLayerToMap(fc, {fileName, layerName})` → id or null. Menu item id
  `ad-gpkg`, its file input `ad-gpkg-file`.

**Phases 4 and 5 (2026-11-06), one commit** (4c and 5 both live in `gpkg-layers.js`).
4a [H], 4b [H], 4d [H] accepted first pass; **1 send-back** (4b+4d items); 4c and 5 [O].
- 4a's card was wrong (no Shapefile item exists in Add Data); the orchestrator caught it
  before launch and gave exact anchors. Haiku added the item after "Spatial Data".
- 4b's dialog sat inside `#toolbar`, whose square icon-button rule broke its buttons; the
  screenshot review caught it (Haiku was told not to judge images). Send-back moved the
  dialog to the end of `<body>` and removed the override CSS that copied shared
  primitives. Lesson: card placement "beside the LODES popup" was the bug; layout
  instructions need to name the container, not a neighbor.
- 4c: `App.gpkgOpenFile` → libs + file in parallel → `_openDb` → `_inspect` → picker →
  per-layer read with `setTimeout(0)` between layers for progress → summary status.
  Busy guard shows a status message; files over 200 MB confirm first.
- 5: one map click handler (wired at first import) opens a MapLibre popup only when a
  `gpkg-` layer is topmost and no tool is active and no OSM/walk-network layer (which have
  their own click handlers) is under the pointer. JSON-object text renders as nested
  lists. The popup uses `closeOnClick: false` and closes itself on other clicks, because
  MapLibre's close-on-click fires after our handler and closed a popup just moved.
  **Deviation from the plan:** a click on a GeoPackage feature still clears the drawn
  selection (editing.js treats it as an empty-map click); blocking that would leave no
  place to click to deselect when an import covers the whole study area.
- Known limitations (documented in 8a): Escape does not close the picker while the box
  select tool is active (box-select.js stops Escape first on `window`); hiding a layer from
  its Layers-panel eye does not close an open popup (the Add Data eye does); hover pointer
  shows over a GeoPackage layer even where another layer would take the click.

**Phase 7 (2026-11-06).** All [O]; review (high) found 6, fixed 5 (doc entry → 8a).
- 7a: shapefile conversion moved verbatim into `_geojsonToDrawn(features)` in `cache.js`
  (diffed against the old body: identical apart from one blank line).
- 7b: `App.cache.appendGeoJSONFeatures(features)` → `{ added }` or `{ added: 0, error }`.
  Snapshot → append → `validateSessionState` (before the undo push, so a refused copy
  leaves no dead step) → `applyState`; one undo step; deep-copied so drawn edits never
  reach the import. Layer ⋯ menu "Copy to drawn features" appears when the layer
  converts to ≤ 2,000 drawn features (Multi* parts counted); only those layers keep
  their FeatureCollection in memory.

**Phase 6 (2026-11-06).** 6a [H] accepted first pass (card corrected before launch: the
GTFS store has no list/remove, so the contract was rewritten); 6b [O]. Review (high)
found 10: 7 fixed by the orchestrator, including one in 6a's code (a failed trim after a
successful write triggered the drop-everything retry) — fixed directly rather than sent
back because it was three lines.
- `App.gpkgStore = { supported, save(key, bytes, layers, colors), list, update(key,
  layers, colors), remove, clear }`, DB `mat-gpkg-cache`, max 3 files / 100 MB.
- Store key is `"<file name>|<byte size>"` so two different files with the same name
  never merge; the display name drops the suffix. `colors[table] = { base, color }`:
  `base` stays the layer's reset color, `color` is any recolor.
- `App.restoreCachedGpkg()` runs from app.js after the GTFS restore: oldest file first,
  `_yield` between tables, per-table failure skips only that table, an unopenable file is
  dropped from the store, offline startup keeps the files for next time.
- Writes: on import (`save`), on Remove layer (`update`; last layer deletes), on a real
  color change (debounced 400 ms; repainters run on every style change so it compares
  with the last saved color), toolbar Clear empties the store even if nothing is shown.
- Not done (accepted): store records hold bytes and metadata together, so prune/update
  copy file bytes (≤100 MB); a third copy of the IndexedDB helper (gtfs/network/gpkg).
