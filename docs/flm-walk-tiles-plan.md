# Plan B Stage 2 design brief: FLM walk tiles as a street source in the transit analysis tool

Status: **implemented November 13, 2026 (phases 1 to 5); the manual check with real Denver tiles (section 9) is still open.** Sections 13 and 14 record where the build differs from this brief. Originally: approved for hand-off by the project lead, November 13, 2026; folder-location decision recorded in section 6. Written against `transit-analysis-tool` at commit `58abc0f` (merge of PR 38) and the FLM tile contract `contracts/walk-tiles/v0/` in `flm_walkshed_index`. Line numbers below are from those versions and will drift; the search strings will not.

Audience: the Opus-class planner in the `transit-analysis-tool` repository, who turns the phases below into task cards per that repository's `AGENTS.md`, launches Haiku or Sonnet agents, and reviews. Follow `CLAUDE.md` and `AGENTS.md` there; this brief adds the FLM-specific decisions and does not override them.

Nothing in this brief changes the FLM repository.

## 1. Purpose in one paragraph

The tool computes walksheds today from streets it downloads live from OpenStreetMap, or from one GeoJSON file the user imports. The FLM project prepares a more carefully filtered pedestrian network offline and publishes it as a folder of small JSON tiles. Stage 2 adds that folder as a third street source. When a walkshed needs streets for an area, the tool reads the handful of tiles covering that area, converts them into the line collection the network builder already accepts, and sends them through the same entry point a download uses. Snapping, routing, the contour shape, Census summaries and export are untouched.

## 2. What already exists and must be reused

Read these before planning. All paths are in `transit-analysis-tool`.

| Piece | Where | What it does |
|---|---|---|
| Network builder | `js/core/road-network.js`, `function buildGraph(geojson)` | Reads a GeoJSON FeatureCollection of LineString or MultiLineString features. Per feature it reads `properties.highway`, `foot`, `name`, `sidewalk`, `footway`, `wayId`. Every consecutive coordinate pair becomes a graph edge; nodes are coordinates rounded to six decimals (`nodeKey`). Walkability: `isPedForbidden(hwy, foot)` blocks `motorway`, `trunk` and their `_link` classes unless `foot` is `yes`, `designated` or `permissive`. Lengths are recomputed with `turf.distance`. |
| Rebuild choke point | same file, `function rebuildNetwork()` | `buildGraph(_roadGeoJSON)`, re-apply connectors, `_networkEpoch++`. Every base load goes through it. |
| Map refresh choke point | same file, `function updateUI(newNetwork)` | Draws the download-area outline and refreshes the walk-network layer. Must be called after `rebuildNetwork()`. |
| Download path | same file, `async function fetchNetworkForBounds(bounds, extentPolygon)` | Lines starting at `var geojson = { type: "FeatureCollection", features: features };` show the exact tail every load must copy: set `_roadGeoJSON`, `rebuildNetwork()`, set `_downloadedBboxPolygon = extentPolygon`, `updateUI(true)`, `persistNetwork(id, source, label)`, `App.setStatus(...)`, return `true`. |
| File import | same file, `function loadRoadNetworkFromFile(file)` | Same tail, but `_downloadedBboxPolygon = null`. |
| Module entry point | same file, `App.fetchRoadNetworkForExtent = async function (extentPolygon)` | Tries `restoreNetworkCovering(extentPolygon)` from IndexedDB, then downloads the bbox. Both Walkshed and Transit Travelshed call this. **This is where the FLM source plugs in.** |
| Coverage check | `js/projects/walkshed.js`, `function checkNetworkCoverage(targets)` | Three outcomes: no network loaded; `App.getRoadDownloadExtent()` is `null` (file import, soft warning, proceed); extent does not contain `computeRequiredExtent(targets)` (shows `#wsDownloadBtn`, returns false). The required extent is the bbox of circles of radius speed × largest budget around the points. The same pattern is in `js/projects/transit-travelshed.js` near `getRoadDownloadExtent`. |
| Download button | `js/projects/walkshed.js`, `async function downloadNetworkForPendingExtent()` and `projects/walkshed-popup.html`, `id="wsDownloadBtn"` | Button text "Download streets for this area". Calls `App.fetchRoadNetworkForExtent(_pendingDownloadExtent)` then re-runs. |
| Persistence | `js/core/network-store.js`, `App.networkStore` | IndexedDB records `{ id, savedAt, source: "overpass"|"file", label, featureCount, extent, geojson }`. `findCovering(extent)` returns the newest record whose stored extent contains the request. **Opus-only area**; do not change it. |
| Add Data menu | `index.html`, `<div class="add-data-heading">LOCAL</div>` block; `js/app.js`, `var _adClrCfgs = [` | Menu buttons with a × clear icon per source. The GeoPackage entry (`id="ad-gpkg"`) is the pattern to copy for a new local source. |
| Dialog pattern | `index.html`, `<div id="lodes-popup"` | Header, body, footer markup for a small dialog opened from the Add Data menu. |
| Per-browser setting | `js/core/config.js`, `localStorage.getItem("mat-carto-key")` | The one existing per-browser override. `try`/`catch` around every storage access. |
| Shared settings | `js/core/network-connectors.js`, `App.networkSettings = App.networkSettings ||` and `js/core/cache.js`, `networkSnapToleranceFt:` | How a setting is saved into the session file. Stage 2 does **not** put the tile source there (section 6). |
| Tests | `test/run-golden.mjs`, `test/cases/walk-cost.mjs` as the model case file, `test/browser/network-cache.test.mjs` as the model behavior test | Golden tests load app files into a Node sandbox with no turf or DOM; a pure engine must therefore not touch `turf`, `App` or the DOM at load time. |

Known fact from the file-import experiment: `App.loadRoadNetworkFromFile` accepted the FLM quick-look GeoJSON of 71,927 segments without code changes. The converter in this brief produces the same feature shape.

## 3. The input: FLM walk tiles version 0

Full contract: `flm_walkshed_index/contracts/walk-tiles/v0/README.md` and the three schema files beside it. Supply that folder to the agents verbatim. Summary of what the reader needs:

Folder layout:

```text
<release-id>/
  manifest.json
  network/<col>_<row>.json
  size-report.md          (human report, not reader input)
```

Manifest fields the tool uses: `format` (exactly `"walk-tiles"`), `version` (exactly `0`), `release_id`, `grid.cell_size_degrees` (`0.01`), `coverage.bbox` (`[west, south, east, north]`), `tiles` (list of `{ col, row, path, segments, bytes }`, sorted by col then row), `default_speed_mph` (`2.8`), `attribution`, `license`, `license_url`, `attribution_url`, `distribution_status`, `limitations` (list of strings). Unknown manifest fields are a version 0 error per the contract, but the tool should only check what it reads (section 5, edge case 3).

Cell index of a point: `col = floor((lon + 180) / 0.01)`, `row = floor((lat + 90) / 0.01)`, valid `col` 0 to 35999, `row` 0 to 17999. The contract asks for exact decimal arithmetic. In JavaScript use `Math.floor(Math.round((lon + 180) * 1e7) / 1e5)` and the same for latitude; this reproduces the contract for coordinates with up to seven decimals and is good enough for floating-point bbox corners.

Tile file: `{ col, row, segments: [...] }`. Each segment:

```json
{
  "id": "way/1053553372/segment/0",
  "from": "176099653",
  "to": "3286982561",
  "len_ft": 41.774602929756,
  "dir": "both",
  "coords": [[-104.9941572, 39.7503754], [-104.9942639, 39.7504552]],
  "way_id": "1053553372",
  "hwy": "secondary",
  "name": "18th Street",
  "sidewalk": "",
  "footway": ""
}
```

A segment appears whole in every cell it touches, so loading neighbouring tiles yields duplicates: deduplicate by `id`. Copies must agree in every field.

Sizes, Denver release `denver-policy03-walk-tiles-20261111-imperial`: 301 tiles, 82 MB total, median tile roughly 270 KB, largest about 700 KB. A 15-minute walk at 2.8 mph is 0.7 miles, so a required extent is about 1.4 by 1.4 miles, which is 3 by 3 or 4 by 4 cells, roughly 2 to 5 MB of JSON. Loading all 301 tiles at once is not a goal.

## 4. Accepted deviations between the tile contract and the tool

These are deliberate for Stage 2. Record them in the reference doc; do not "fix" them.

| Contract says | Tool does | Decision |
|---|---|---|
| Join segments only where `from`/`to` node IDs match | Joins any two segments whose coordinates match to six decimals | Accept. The FLM quick-look report counted 4 coincident-but-unconnected node locations in the whole Denver network. |
| Use `len_ft` for cost | Recomputes length with `turf.distance` | Accept. Differences are far below a walking-time budget. |
| `dir` restricts walking direction | Walking is undirected | Accept. Denver has 0 segments with `dir` other than `both`. |
| Snap limit 500 ft | 500 m (`SNAP_MAX_KM`), with a 50 ft default in the Walkshed panel | Leave as is. |
| Default speed 2.8 mph | Walkshed panel default 3.1 mph | Show 2.8 in the FLM dialog; do not change the panel default or set it automatically. The lead sets speed per run. |

## 5. Architecture

Three new files, two small edits to existing files, one markup addition. Load order and namespaces follow `CLAUDE.md`.

### 5.1 `js/core/walk-tiles.js`, pure engine, `window.WalkTiles` (Haiku)

No `turf`, `App`, DOM or `fetch` anywhere in the file, so it loads in the golden sandbox. ES5 syntax. IIFE assigning to `window.WalkTiles`.

```js
WalkTiles.CELL_DEG = 0.01;

// Cell of a point. Returns { col, row } or null when lon/lat are not finite numbers.
// Clamps col to 0..35999 and row to 0..17999 (a point at exactly +180 or +90).
WalkTiles.cellOf(lon, lat)

// All cells touched by an axis-aligned bbox [w, s, e, n], cells being closed
// (an edge belongs to both neighbours; see test case 4 for the exact rule).
// Returns an array of { col, row } ordered by col then row. Returns [] when any
// value is not finite, when w > e, or when s > n.
WalkTiles.cellsForBbox(bbox)

// Axis-aligned rectangle [w, s, e, n] in degrees covering the listed cells exactly.
// Returns null for an empty list.
WalkTiles.bboxOfCells(cells)

// Validates the parsed manifest object. Returns { ok: true, manifest } with the
// same object, or { ok: false, error: "<text>" } naming the first failing field.
// Checks: format === "walk-tiles"; version === 0; release_id is a non-empty
// string; grid.cell_size_degrees === 0.01; coverage.bbox is four finite numbers
// with w <= e and s <= n; tiles is a non-empty array whose entries have integer
// col and row in range and a path string equal to "network/" + col + "_" + row + ".json";
// attribution is a non-empty string; limitations is an array of strings.
// Does NOT reject unknown extra fields.
WalkTiles.validateManifest(obj)

// Manifest entries whose cells are in `cells`. Uses a lookup built from
// manifest.tiles, not a nested loop. Returns an array of manifest tile entries
// ordered as in the manifest. Returns [] when no cell has a tile.
WalkTiles.tilesForCells(manifest, cells)

// Merges parsed tile objects into one array of unique segments.
// Dedupes by segment.id. When two copies with the same id differ in any field
// (compare JSON.stringify of the record with keys in the contract's order),
// returns { ok: false, error: "conflicting copies of segment <id>" }.
// Also validates each segment: all eleven fields present, len_ft a finite
// number > 0, dir one of both/forward/reverse, coords an array of at least two
// [number, number] pairs. First failure returns { ok: false, error }.
// Success returns { ok: true, segments: [...], copies: <total records read> }.
WalkTiles.mergeTiles(tileObjects)

// Converts unique segments to the FeatureCollection buildGraph accepts.
// One Feature per segment:
//   geometry: { type: "LineString", coordinates: segment.coords }
//   properties: {
//     highway: segment.hwy,
//     foot: "yes",                       // FLM already decided walkability
//     name: segment.name,
//     sidewalk: segment.sidewalk,
//     footway: segment.footway,
//     wayId: <Number(segment.way_id) when Number.isSafeInteger of it, else segment.way_id>,
//     flmId: segment.id,
//     lenFt: segment.len_ft,
//     dir: segment.dir
//   }
// Returns { type: "FeatureCollection", features: [...] }.
WalkTiles.toRoadGeoJSON(segments)
```

`foot: "yes"` is required: `isPedForbidden` would otherwise block an FLM segment whose `hwy` is `trunk`, and the FLM rules have already accepted it.

`wayId` must be a number when possible because the street-exclusion feature stores clicked `wayId` values and compares with `Set.has`; the Overpass path supplies numbers.

### 5.2 `js/core/walk-tiles-source.js`, source backends and setting, `App.walkTilesSource` (Sonnet)

Reads and remembers where the tile folder is, and reads files from it. Knows nothing about graphs. Loads after `network-store.js` and before `road-network.js`.

```js
App.walkTilesSource = {
  // true when a source is configured and its manifest has been read this session.
  isActive(): boolean,

  // The validated manifest or null.
  manifest(): object|null,

  // Short text for status lines: "<release_id>" or "".
  releaseId(): string,

  // Configure from a base URL. Fetches <url>/manifest.json, validates with
  // WalkTiles.validateManifest, stores the setting (section 6), resolves
  // { ok: true } or { ok: false, error }. Never throws.
  useUrl(url: string): Promise<{ok, error?}>,

  // Configure from a picked folder. `handle` is a FileSystemDirectoryHandle
  // (window.showDirectoryPicker) OR `files` is the FileList from an
  // <input type="file" webkitdirectory>. Reads manifest.json from it, validates,
  // resolves as above. The folder picked may be the release folder itself or
  // its parent; see edge case 8.
  useFolder({ handle?, files? }): Promise<{ok, error?}>,

  // Reads one tile by its manifest path, returns the parsed object.
  // Rejects with an Error whose message names the path on any failure.
  readTile(path: string): Promise<object>,

  // Forgets the source for this browser and this session. Does not touch
  // any loaded network.
  clear(): void,

  // Called once at startup after App.cache.restore(): if a URL setting is
  // stored, re-reads its manifest silently; a failure leaves the source
  // inactive and logs one console.warn. A picked folder is never restored
  // in this stage (section 6).
  restore(): Promise<boolean>
};
```

Concurrency: `readTile` for the same path twice in flight must not fetch twice. Keep a `Map<path, Promise>` for in-flight reads and a bounded cache of parsed tiles, at most 64 entries, evicting oldest. Tiles do not change within a release, so no freshness check.

### 5.3 Integration in `js/core/road-network.js` (Sonnet, Opus review)

Add one new private function and one new public function, and a branch in two existing functions. Nothing else in the file changes.

```js
// Loads FLM tiles covering extentPolygon (Feature<Polygon>) and makes them the
// live network. Returns Promise<boolean>. Status text as in section 7.
async function loadNetworkFromTiles(extentPolygon) {
  // 1. bb = turf.bbox(extentPolygon); cells = WalkTiles.cellsForBbox(bb)
  // 2. entries = WalkTiles.tilesForCells(manifest, cells)
  //    if entries.length === 0: App.setStatus(<outside text>); return false
  // 3. tiles = await Promise.all(entries.map(e => App.walkTilesSource.readTile(e.path)))
  //    (a rejected read aborts the whole load: status <read failure text>, return false)
  // 4. merged = WalkTiles.mergeTiles(tiles); if !merged.ok -> status, return false
  // 5. geojson = WalkTiles.toRoadGeoJSON(merged.segments)
  // 6. _roadGeoJSON = geojson; rebuildNetwork();
  //    _downloadedBboxPolygon = turf.bboxPolygon(WalkTiles.bboxOfCells(cells));
  //    updateUI(true);
  //    persistNetwork("tiles:" + releaseId + ":" + extentCacheId(_downloadedBboxPolygon), "walk-tiles", releaseId);
  //    App.setStatus(<loaded text>); return true
}
App.loadRoadNetworkFromTiles = loadNetworkFromTiles;
```

Step 6 is the point of the design: `_downloadedBboxPolygon` is the rectangle of **requested cells**, which always contains the required extent, so `checkNetworkCoverage` in both modules works with no change. Cells with no tile inside that rectangle are treated as having no streets, which is what the contract says they have.

Branch in `App.fetchRoadNetworkForExtent`:

```js
App.fetchRoadNetworkForExtent = async function (extentPolygon) {
  if (App.walkTilesSource && App.walkTilesSource.isActive()) {
    return loadNetworkFromTiles(extentPolygon);   // local and fast: no store restore first
  }
  if (await restoreNetworkCovering(extentPolygon)) return true;
  ...unchanged
};
```

Guard in `restoreNetworkCovering`, after `findCovering` returns: when the tile source is active and `rec.source !== "walk-tiles"`, return `false`. This stops a stored Overpass network from silently replacing the FLM source when the Walkshed module tries a restore before offering the button (`runWalkshed`, search `restoreNetworkCovering`). A release mismatch (`rec.label !== releaseId`) also returns `false`.

### 5.4 Module text in `js/projects/walkshed.js` and `js/projects/transit-travelshed.js` (Haiku)

Only strings and one label, no logic:

- `#wsDownloadBtn` text becomes "Load FLM tiles for this area" while the source is active, else the current text. Set it inside `showDownloadBtn(show)`.
- `setCoverageWarn("Loaded streets don't cover this walk budget.")` becomes, when active, "Loaded FLM tiles don't cover this walk budget."
- After a successful run, if active, `setStatus` appends " Streets: FLM tiles <release_id>." Find the success `setStatus` call in `runWalkshed`'s completion callback.
- Transit Travelshed: the same two coverage strings, no button label change if it has none.

### 5.5 Add Data entry and dialog (Haiku for markup, Sonnet for wiring)

`index.html`: immediately after `<button id="ad-gpkg">GeoPackage (.gpkg)…</button>`, add `<button id="ad-walk-tiles">FLM Walk Tiles…</button>`. Immediately after the `<div id="lodes-popup" …>…</div>` block, add `<div id="walk-tiles-popup" style="display:none;">` copying the lodes-popup structure (`lodes-popup-header`, `lodes-popup-body`, `lodes-popup-footer` classes; reuse them, do not add new CSS unless a row needs it). Body contents, top to bottom:

1. Label "Tile folder address (URL)" and `<input id="wtUrl" type="text" class="rf-number-input" style="width:100%">` with placeholder `http://localhost:8000/walk-tiles/<release-id>`.
2. Button `id="wtUseUrl"` "Use this address".
3. Divider, label "or".
4. Button `id="wtPickFolder"` "Choose folder…" and a hidden `<input id="wtFolderInput" type="file" webkitdirectory style="display:none">`.
5. `<div id="wtInfo" class="lodes-loaded-info"></div>` filled by the wiring with: release id, coverage bbox rounded to 3 decimals, tile count, default speed, attribution with link, distribution status, and the limitations as a bulleted list. Empty when no source.
6. Footer: button `id="wtClear"` "Forget source", button `id="walk-tiles-popup-close"` ×.

`js/app.js`: wire `#ad-walk-tiles` to open the dialog (copy how `#lodes-employment-btn` opens `#lodes-popup`); add an `_adClrCfgs` entry `{ btnId: "ad-walk-tiles", isLoaded: () => App.walkTilesSource.isActive(), clear: () => App.walkTilesSource.clear() }` with no eye. Call `App.walkTilesSource.restore()` once at startup right after the existing `App.restoreCachedNetwork()` call (search `restoreCachedNetwork` in `js/app.js`).

Dialog wiring may live in `walk-tiles-source.js` or a small `js/core/walk-tiles-ui.js`; the planner decides, with one owner per file.

## 6. Where the tile folder lives: options for the lead to decide

The app is a static site with no backend, served from GitHub Pages or a local static server. The tiles are 82 MB for Denver, not cleared for public redistribution, so they cannot be committed to the public repository. The design above hides the choice behind `useUrl` and `useFolder`, so more than one option can ship. The lead should pick which to build first.

| Option | How the user sets it | Works where | Persists across reloads | Cost | Notes |
|---|---|---|---|---|---|
| A. URL to a folder | Types a URL in the dialog; stored in `localStorage` key `mat-walk-tiles-source` as `{ "kind": "url", "url": "…" }` | Any browser, any host, provided the browser may fetch it | Yes | Lowest | Same-origin is simplest: put the release folder under the app checkout as `walk-tiles/<release-id>/` (Git-ignored) and run one local server for both. A separate server for the data must send CORS headers, or the browser blocks the fetch. `python -m http.server` does not send them. |
| B. Fixed relative folder | None; the app looks for `walk-tiles/index.json` listing releases and offers them in the dialog | Local server only, never GitHub Pages (data cannot be published) | Yes | Low | A special case of A. Zero typing for the lead. Needs a tiny `index.json` the FLM pipeline would write. |
| C. Folder picker (File System Access API) | Clicks "Choose folder…" and picks the release folder on disk, including OneDrive | Chrome and Edge only; works with the live GitHub Pages app and local data, no server for the data at all | Only if the directory handle is stored in IndexedDB and permission is re-requested on a click after reload. Storing the handle touches an IndexedDB store, an Opus-only area. Without that, re-pick each session. | Medium | `js/core/cache.js` already uses this API for recent files, so there is precedent. Best fit for the lead's "open the site, point at OneDrive" habit. |
| D. Folder input (`webkitdirectory`) | Same button, falls back to the hidden file input when `showDirectoryPicker` is absent | All current browsers | No; re-pick each session | Low | Lists every file in the folder at pick time but reads them lazily, so an 82 MB release is fine. Natural fallback for C in Firefox and Safari. |
| E. Import a zip of the release into IndexedDB | Picks a `.zip`; the app stores the tiles | All browsers | Yes | High | 82 MB per release in browser storage, a new store, JSZip unpacking. Not recommended for Stage 2. |

**Decision, November 13, 2026 (project lead):** build A (URL) and C (folder picker) in Stage 2, with D as C's automatic fallback in browsers without `showDirectoryPicker`. Do not persist C's directory handle in this stage: the folder is re-picked each session, and the dialog says so in one line. The URL setting is remembered in `localStorage` as described in row A. B and E are deferred. The setting is **per browser**, not part of the saved session file: a session file is shared with other people, and a path on the lead's disk means nothing to them.

Phase 3's card therefore covers: `useUrl` with `localStorage` persistence; `useFolder` from a `FileSystemDirectoryHandle` when `window.showDirectoryPicker` exists, else from the hidden `webkitdirectory` input; `restore()` re-reads only a stored URL.

## 7. Exact user-facing text

Use these strings verbatim so the behaviour test can look for them.

| Situation | Status text |
|---|---|
| Tiles loaded | `<n> FLM tile segments loaded from <k> tiles (<release_id>) — local routing enabled` |
| No tile covers the required extent | `Outside the prepared FLM area (<release_id>). Prepared area: <w>, <s> to <e>, <n>.` with coordinates rounded to 3 decimals |
| A tile failed to read | `FLM tile <path> could not be read: <message>` |
| Copies disagree or a record is invalid | `FLM tiles are inconsistent: <error>` |
| Manifest invalid at setup | `This folder is not a walk-tiles release: <error>` |
| URL fetch failed | `Could not read manifest.json at <url>: <message>` |
| Source forgotten | `FLM tile source forgotten. Loaded streets stay until replaced.` |

"Outside the prepared area" and "no streets within snapping distance" are different conditions and must stay different messages; the second one is produced by the existing snap code and is not changed.

## 8. Edge cases the cards must list

1. A bbox straddling a cell edge (for example west = -105.00 exactly) includes both cells.
2. A tile listed in the manifest that fails to parse as JSON is a load failure for the whole request, not an empty cell.
3. A manifest with extra unknown fields validates; a manifest missing `tiles` or with an empty `tiles` array fails.
4. Two copies of a segment that differ only in `name` are a conflict.
5. Two different segment ids with identical coordinates are both kept.
6. A segment whose `way_id` is not a safe integer keeps `wayId` as the original string.
7. `hwy` of `trunk` or `motorway` still produces a walkable feature because `foot` is `"yes"`.
8. The picked folder is the parent of the release folder: if `manifest.json` is absent at the top level and exactly one subfolder contains one, use it; if several do, fail with `Pick the release folder itself, not its parent.`
9. The required extent spans more than 36 cells: still load them all, but show progress in `App.setStatus` every 8 tiles. Do not cap.
10. The source is active but a stored Overpass network is already loaded: the next Walkshed run whose extent is covered by the Overpass extent proceeds on that network. This is accepted; the status line after the run says which source was used, and the lead can press × on Area Roads to unload it.
11. `clear()` while a tile network is loaded leaves the network in place; only the source for the next load is forgotten.
12. `localStorage` throws (private mode): the URL setting is simply not remembered; everything else works.
13. A second `readTile` for a path already in flight returns the same promise.
14. Coordinates in a tile beyond the tile's own cell (a segment that extends into a neighbour) are kept whole.

## 9. Tests

Golden, `test/cases/walk-tiles.mjs` with `scripts: ["js/core/walk-tiles.js"]`, and a hand-written fixture release in `test/fixtures/walk-tiles/fixture-release/` committed alongside. Fixture: two cells, `7499_12975` (longitude -105.01 to -105.00, latitude 39.75 to 39.76) and `7500_12975` (longitude -105.00 to -104.99, same latitudes); three segments: `A` inside the first cell only, `B` crossing the shared edge and present in both tiles, `C` inside the second only; node ids `n1` to `n4` so that `A` ends where `B` starts and `B` ends where `C` starts. Cases, each with the expected value written in the card:

1. `cellOf(-105.005, 39.755)` → `{ col: 7499, row: 12975 }`.
2. `cellOf(-180, -90)` → `{ col: 0, row: 0 }`; `cellOf(180, 90)` → `{ col: 35999, row: 17999 }`.
3. `cellsForBbox([-105.005, 39.755, -104.995, 39.755])` → two cells in order.
4. `cellsForBbox([-105.00, 39.755, -105.00, 39.755])` → two cells, `7499` and `7500`, because -105.00 is the shared edge and the contract's cells are closed. Rule for `cellsForBbox`: when the scaled west or south value is an exact multiple of 100,000 and the index is above 0, also include the cell to the west or south; the east and north edges need no adjustment because `floor` already lands in the cell beyond the edge and the loop includes everything from the minimum to the maximum index.
5. `validateManifest` on the fixture manifest → `ok: true`; on a copy with `version: 1` → `ok: false` naming `version`.
6. `tilesForCells` for both cells → two entries; for a cell outside → `[]`.
7. `mergeTiles` on both fixture tiles → three segments, `copies: 4`.
8. `mergeTiles` with `B`'s `name` altered in one copy → `ok: false`.
9. `toRoadGeoJSON` of the merged result → three features; feature for `B` has `properties.foot === "yes"`, `properties.wayId` a number, `properties.flmId === "way/…"`.

Behaviour test, `test/browser/walk-tiles.test.mjs`, modelled on `network-cache.test.mjs` (Opus writes or reviews): serve the fixture release from the static server, configure the source by URL through the dialog, place a point in cell 7499, run Walkshed at 5 minutes and 2.8 mph, assert: no Overpass request was made; `App.roadNetworkLoaded()` is true; the status contains "FLM tile segments loaded"; `App.getRoadDownloadExtent()` is a polygon containing the point; a point far outside produces the "Outside the prepared FLM area" text; after `clear()` and unload, a run offers "Download streets for this area" again.

Manual check with real data, by the lead: Denver release at `data/generated/prototype/walk-tiles/denver-policy03-walk-tiles-20261111-imperial/`; test points from FLM decision 0012: D01 Union Station -105.0004685, 39.7529095 and C01 Commerce City -104.9430570, 39.8263610 at 5, 10 and 15 minutes and 2.8 mph; D02 Sloan's Lake -105.0490000, 39.7480000 must report no streets within snapping distance, not "outside the prepared area". Compare reached streets by eye with the `reached_streets` layer of `walk-reference.gpkg` filtered to the same case and minutes.

## 10. Phases and classes

| Phase | Class | Content | Done when |
|---|---|---|---|
| 1 | Haiku, high effort | `js/core/walk-tiles.js`, fixture release, `test/cases/walk-tiles.mjs`, seeded golden | `node test/run-golden.mjs walk-tiles` prints PASS; `node test/run-golden.mjs` still passes everything |
| 2 | Haiku, high effort | Markup only: `index.html` button, dialog, hidden input; `<script>` tags for the two new files in the stated load position | Page loads with no console error; dialog opens and closes with no behaviour |
| 3 | Sonnet | `js/core/walk-tiles-source.js`: URL backend with `localStorage` persistence, folder backend (C with D fallback, no handle persistence), dialog wiring, `restore()` | Dialog shows release info for the fixture served locally and for a picked folder; `clear()` empties it |
| 4 | Sonnet, Opus review | `road-network.js` integration (5.3), module strings (5.4), `app.js` entries (5.5) | Behaviour test passes; `network-cache.test.mjs` and `street-exclusion.test.mjs` still pass; manual Denver check done by the lead |
| 5 | Opus | `docs/reference/road-network.md` new section "FLM walk tiles", `CLAUDE.md` file map lines for the two files and the load order, progress log, `features.md` entry | Review gate per `AGENTS.md` |

Phase 4 touches `road-network.js`, which `AGENTS.md` lists as an importer; the planner reviews that diff line by line and re-runs every browser test that loads a network.

## 11. Out of scope

- Reading `len_ft` or `dir` into the graph, node-id joins, a 500 ft snap limit, a 2.8 mph default. All recorded in section 4.
- Index scores, Census changes, new polygon methods.
- Changes to the FLM repository or the tile format. If the format is awkward, report it so Plan A can adjust.
- Storing the tile setting in the session file.
- Any change to `network-store.js` beyond what section 5.3 reads from a record.

## 12. Reporting to the project lead

At the end of each phase: what was built, what the lead should click, what passed, what failed, what was not run, and the one decision needed next, in plain language. Where this brief and the code disagree, the code wins and the disagreement is reported, not silently resolved.

## 13. Planner corrections (card check against the code, November 13, 2026)

Where the brief and the code disagreed, the code won. These override the sections named.

1. **Stored-record id (5.3 step 6).** `App.networkStore.findCovering` only considers ids that start with `bbox:`. An id of `tiles:<release>:bbox:…` would never be found, so the guard's `walk-tiles` branch would be dead. The tile load therefore persists with `extentCacheId(_downloadedBboxPolygon)` (a plain `bbox:` id), `source: "walk-tiles"`, `label: <release_id>`. `network-store.js` is unchanged.
2. **Which source the live network came from (5.4, edge case 10).** "Source is active" does not prove the loaded streets are FLM tiles (a stored Overpass network may be live). `road-network.js` tracks the live network's tile release in a private `_tileRelease` and exposes `App.roadNetworkTileRelease()` (`""` unless the live network was built from walk tiles). The " Streets: FLM tiles <release_id>." suffix uses that, not `isActive()`.
3. **Dialog CSS (5.5).** `#lodes-popup` is positioned by an id rule, and `#toolbar button` styles leak into any button inside the toolbar. `#walk-tiles-popup` gets its own id rule (copy of `#lodes-popup`, width 320px, plus dark mode) and every button in the dialog sits in a `.lodes-popup-footer` row, which already neutralises the toolbar rule. The × close button goes in the header (class `lodes-popup-x`) like the LODES dialog.
4. **Transit Travelshed has a download button** (`#tsDownloadBtn`), so it gets the same label switch as Walkshed.
5. **Phase order.** Phases 1 and 2 ran in parallel (disjoint files), then 3 and 4 in parallel against the fixed contracts in section 5; each phase is still its own commit after its review gate.

## 14. Progress log

### Phases 1 and 2 (November 13, 2026)

- **Phase 1, Haiku at high effort:** `js/core/walk-tiles.js`, fixture release, `test/cases/walk-tiles.mjs`, golden file. Passed review first time, no send-back. 25 cases (the nine in section 9 plus edge cases 3 to 7). Agent additions accepted: `bboxOfCells` returns `null` for a malformed cell; `toRoadGeoJSON` skips non-object entries. Planner edit: header comment now points at the reference doc instead of this plan.
- **Phase 2, Haiku at high effort:** markup and CSS exactly as the card gave them; no send-back.
- **Left open from the agent's questions:** `validateManifest` accepts an empty `limitations` list and does not check the `release_id` character pattern (the tool only checks what it reads); `cellsForBbox` has no cap on cell count (section 8 item 9 says do not cap).
- **Brief vs code:** `js/core/cache.js` has no File System Access API precedent (section 6 row C says it does); the folder picker is new code.
- **Hand-off notes:** `window.WalkTiles` = `{ CELL_DEG, cellOf, cellsForBbox, bboxOfCells, validateManifest, tilesForCells, mergeTiles, toRoadGeoJSON }`, signatures as in section 5.1; `validateManifest` errors read `"<field>: <reason>"`. Dialog ids: `ad-walk-tiles`, `walk-tiles-popup`, `walk-tiles-popup-close`, `wtUrl`, `wtUseUrl`, `wtPickFolder`, `wtFolderInput`, `wtInfo`, `wtClear`. Fixture URL in tests: `/test/fixtures/walk-tiles/fixture-release`.

### Phase 3 (November 13, 2026)

- **Sonnet:** `js/core/walk-tiles-source.js` (URL backend with `localStorage`, folder backend by directory handle with `webkitdirectory` fallback, tile cache, dialog wiring, `restore()`) and its script tag. No send-back. The agent's 19 scratch checks passed (URL, fallback-input folder, parent folder, two releases, in-flight sharing, clear).
- **Planner fix (direct, about ten lines):** the agent used one counter both for "a newer source choice superseded this manifest read" and for "the source changed, drop in-flight tile reads", so a *failed* `useUrl` cancelled tile reads of the still-active source. Split into `_attempt` and `_gen`.
- **Not exercised by any automated check:** the directory-handle picker (headless Chromium has none), the 64-tile cache cap, a throwing `localStorage`. The handle path needs the lead's manual check in Chrome or Edge.
- **Additions to section 5.2:** `describe()` and `renderInfo()`; `clear()` sets the "forgotten" status itself; `readTile` rejects with the complete user text `FLM tile <path> could not be read: <reason>`; choosing a folder removes a remembered address.

### Phase 4 (November 13, 2026)

- **Sonnet:** `road-network.js` tile branch (card 4A), Walkshed and Transit Travelshed text, `app.js` menu entry, dialog opening and startup restore. No send-back; the `road-network.js` diff was read line by line and matched the card.
- **Planner (Opus-class work):** `test/browser/walk-tiles.test.mjs`, 33 checks.
- **Review gate:** `code-review` at high on everything since `58abc0f`. Fixed directly by the planner:
  1. A load that reaches past the prepared area still records the full rectangle of requested cells (by design, section 5.3), so nothing said results might be clipped. New `App.walkTilesExtentBeyondPrepared(extentPolygon)`; both panels show a soft warning and repeat it in the result status.
  2. Transit Travelshed showed nothing in its panel when a tile load failed; it now shows `App.walkTilesLastError()` like Walkshed.
  3. A remembered address that cannot be read at startup is now said in the status line, and the dialog offers the address back.
  4. The panels' button label did not follow a source change while the button was on screen. The source now fires a `walk-tiles-source-changed` document event; the panels relabel from it (not `notifyProject()`, which marks results stale).
  5. An empty "Use this address" could cancel the startup restore; Enter could start a second read.
  6. `mergeTiles` built canonical text for every record; now only when an id repeats.
  7. Removed a redundant raw-hex dark-mode rule.
- **Found while testing, pre-existing:** `projects/walkshed-popup.html` had no `#wsCoverageWarn` element, so Walkshed's coverage warnings ("No street network loaded.", the imported-network caution) were never visible. Added the element, copied from Transit Travelshed's.
- **Review findings left for the lead (not changed):** no size prompt before a very large tile load (section 8 item 9 says do not cap); every tile load is written to the three-slot network store and can push out stored downloads; the "is a tile source active" test is repeated in four files.
- **Hand-off notes:** `App.loadRoadNetworkFromTiles(extentPolygon)`, `App.roadNetworkTileRelease()`, `App.walkTilesLastError()`, `App.walkTilesExtentBeyondPrepared(extentPolygon)`; stored records use `source: "walk-tiles"`, `label: <release_id>`, id `bbox:…`.
- **Not done here:** the manual Denver check (real tiles are not in either repository) and the directory-handle folder picker in a real Chrome or Edge.

### Phase 5 (November 13, 2026)

- **Planner:** `docs/reference/road-network.md` section "FLM walk tiles", `CLAUDE.md` file map, load order and namespace list, `docs/reference/script-load-order.md`, `features.md` entry. `node test/doc-coverage.mjs` no longer lists any name from this work (the three names still listed predate it).
- **Which class did what well:** both Haiku cards (pure engine with golden cases; verbatim markup) passed review with no send-back, because every decision and expected value was in the card. Both Sonnet cards also passed first time; every later fix came from interactions between files that no single card covered (label refresh across modules, attempt counter vs in-flight reads, a panel element that never existed).
- **Open for the lead:** manual Denver check (section 9); the directory-handle folder picker in Chrome or Edge; the three review findings listed under Phase 4.

### After the lead's first try with real data (November 13, 2026)

- **Report:** the lead chose the Denver folder, ran Walkshed and got "Street network doesn't cover these points — download to continue." That wording appears only when no tile source is active, so the folder choice had failed and the failure (shown only in the status line, which clears after five seconds) was missed. The cause inside the folder is not yet known.
- **Planner changes:** (1) a failed address or folder attempt now stays in the dialog in red, and a folder with no `manifest.json` names the folder and lists what it contains; the dialog also says plainly when no source is set. (2) Walkshed's Calculate now reads the tiles for its area by itself when a source is set, instead of stopping with a message and a second button (differs from section 5.4; the button remains for Transit Travelshed, whose areas can be much larger).
- **Flake noted:** one run of `walk-tiles.test.mjs` timed out on a click; four later runs passed 33/33. Cause not found.
