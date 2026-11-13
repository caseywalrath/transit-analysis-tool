# Plan: load FLM tiles per point, not for the whole rectangle between points

Status: **implemented November 13, 2026; the manual check with real Denver tiles (Review gate) is still open.** See the progress log at the end.

Repository `transit-analysis-tool`, branch `claude/jolly-hamilton-64dask` (clean, pushed, at `15efc3d`).
Follow `CLAUDE.md` and `AGENTS.md`. Three Haiku task cards (run at `high` effort), then an Opus review gate.

## Context

Walkshed works out ONE rectangle around the walk circles of all selected points
(`computeRequiredExtent` in `js/projects/walkshed.js`) and the tile loader reads every tile in it
(`loadNetworkFromTiles` in `js/core/road-network.js`). Two points at opposite ends of Denver therefore load
every street between them. Results are right, but loading time, memory and the saved copy are far larger than
needed.

Outcome wanted: with an FLM tile source set, Walkshed reads only the tiles around each point. OpenStreetMap
downloads and Transit Travelshed keep their single rectangle.

## Fixed decisions

1. **Coverage for a tile network is decided by cells, not by a polygon.** `road-network.js` keeps a lookup of
   the cells the live tile load asked for (`_tileCells`). A new `App.roadNetworkCoversExtent(extent, pieces)`
   answers "are the streets for this run loaded"; both modules call it instead of `turf.booleanContains`.
   Reason: a sparse load is several rectangles (a MultiPolygon), and `turf.booleanContains` in turf 6.5 throws
   on a MultiPolygon.
2. **`pieces`** is an array of `[w, s, e, n]` boxes, one per selected point (the bbox of that point's walk
   circle). It is an optional second argument; without it everything behaves as today (one rectangle).
3. **The map outline** (`_downloadedBboxPolygon`) becomes the union of the per-point cell rectangles. It is
   display only for tile networks; a failed union can only make the outline incomplete, never the coverage answer.
4. **Stored copy:** a tile load is saved under id `"tiles:" + release_id` with a new field
   `tileCells: ["col_row", ...]`. Consequences, all intended:
   - one stored slot per release instead of one per area (stops tile loads pushing out stored downloads);
   - `network-store.js` is NOT changed (it stores whatever record it is given);
   - tile records are no longer matched by area (`findCovering` only reads `bbox:` ids), so a sparse record can
     never claim the gap between points. Walkshed reads tiles itself on Calculate, so nothing is lost;
   - a startup restore brings back `tileCells`, so coverage stays correct after a refresh;
   - older tile records saved today (`bbox:` id, no `tileCells`) are true rectangles and keep working through the
     polygon path.
5. **A new load replaces the previous one** (as today). Tiles already read come from the in-memory tile cache.
6. **Transit Travelshed** switches to `App.roadNetworkCoversExtent` (required, see 1) but passes no pieces.
7. Status texts are unchanged.

## Card A (Haiku) — pure functions, fixture tile, golden cases

**Goal:** add three pure helpers to `window.WalkTiles` and a third, far-away fixture tile.

**Read first:** `js/core/walk-tiles.js` (whole file), `test/cases/walk-tiles.mjs`,
`test/fixtures/walk-tiles/fixture-release/` (all three files), `test/README.md`.

**Files you may change (closed list):** `js/core/walk-tiles.js`, `test/cases/walk-tiles.mjs`,
`test/golden/walk-tiles.json` (only via `--update walk-tiles`),
`test/fixtures/walk-tiles/fixture-release/manifest.json`,
NEW `test/fixtures/walk-tiles/fixture-release/network/7505_12975.json`.

**Contract** (ES5, no throw, same file rules as the existing functions; reuse the private `cellKey`,
`cellsForBbox`, `bboxOfCells` already in the file; add all three to the `window.WalkTiles = {…}` export):

```
WalkTiles.cellsForBboxes(bboxes)
  -> [] when bboxes is not an array.
  -> union of cellsForBbox(b) over every entry b (an invalid entry adds nothing), each cell once,
     sorted by col ascending then row ascending.

WalkTiles.cellRectsForBboxes(bboxes)
  -> [] when bboxes is not an array.
  -> for each entry b in order: cells = cellsForBbox(b); skip when cells is empty; rect = bboxOfCells(cells).
     Return the rects in first-seen order, dropping a rect whose four numbers equal an earlier one
     (compare with rect.join(",")).

WalkTiles.cellKeys(cells)
  -> [] when cells is not an array.
  -> ["<col>_<row>", ...] in the given order, skipping entries that are not objects.
```

**Fixture changes**
- New tile `network/7505_12975.json`: `{ "col": 7505, "row": 12975, "segments": [D] }`, D =
  id `way/4/segment/0`, from `n5`, to `n6`, len_ft `561.5`, dir `both`,
  coords `[[-104.946, 39.755], [-104.944, 39.755]]`, way_id `"4"`, hwy `"residential"`, name `"D Street"`,
  sidewalk `""`, footway `""` (key order and 2-space style as the other tiles, trailing newline).
- `manifest.json`: `coverage.bbox` → `[-105.006, 39.755, -104.944, 39.755]`; append tile entry
  `{col 7505, row 12975, path "network/7505_12975.json", segments 1, bytes <wc -c of the new file>}`;
  `counts`: included 4, nodes 6, directed_arcs 8, tiles 3, segment_copies 5, total_length_ft 3930.8.
  Nothing else changes.

**Golden cases to add** (read the new tile as `tileD` like the others). Expected values:

| id | call | args | expected |
|---|---|---|---|
| `cells-bboxes-two-far` | cellsForBboxes | `[[[-105.0074,39.7516,-104.9986,39.7584],[-104.9494,39.7516,-104.9406,39.7584]]]` | cells `7499_12975`, `7500_12975`, `7505_12975` in that order |
| `cells-bboxes-overlap-deduped` | cellsForBboxes | `[[[-105.005,39.755,-104.995,39.755],[-105.005,39.755,-105.004,39.755]]]` | `7499_12975`, `7500_12975` |
| `cells-bboxes-skips-invalid` | cellsForBboxes | `[[["x",1,2,3],[-105.005,39.755,-105.005,39.755]]]` | `7499_12975` only |
| `cells-bboxes-not-array` | cellsForBboxes | `["nope"]` | `[]` |
| `cell-rects-two-far` | cellRectsForBboxes | same args as `cells-bboxes-two-far` | `[[-105.01,39.75,-104.99,39.76],[-104.95,39.75,-104.94,39.76]]` |
| `cell-rects-duplicates-removed` | cellRectsForBboxes | the first box twice | one rect `[-105.01,39.75,-104.99,39.76]` |
| `cell-keys` | cellKeys | `[[{col:7499,row:12975},{col:7505,row:12975}]]` | `["7499_12975","7505_12975"]` |
| `cell-keys-not-array` | cellKeys | `["nope"]` | `[]` |
| `merge-three-tiles` | mergeTiles | `[[tileA, tileB, tileD]]` | ok, 4 segments (A, B, C, D), `copies: 5` |

**Deliberate golden movement:** `manifest-fixture-ok` and `manifest-extra-field-ok` echo the manifest, so their
stored values change with the fixture. No other existing case may change; if one does, stop and report.

**Done when:** `node test/run-golden.mjs --update walk-tiles`, then every new golden value compared with the table;
`node test/run-golden.mjs walk-tiles` ends `PASS — 34/34 cases passed across 1 module(s)`;
`node test/run-golden.mjs` ends with `PASS —`;
`grep -nE "turf|App\.|document|fetch|=>|\blet\b|\bconst\b" js/core/walk-tiles.js` prints nothing;
`git diff test/golden/walk-tiles.json` shows changes only in the two named cases plus additions.

**Stop and report if:** an expected value above looks wrong, or any other file seems to need a change.

## Card B (Haiku) — road network and the two panels

**Goal:** load and track tiles per piece; answer coverage by cells.

**Read first:** `docs/reference/road-network.md` section "FLM walk tiles"; in `js/core/road-network.js` search
`var _tileRelease`, `async function loadNetworkFromTiles`, `function persistNetwork`, `function loadStoredRecord`,
`function unloadRoadNetwork`, `App.walkTilesExtentBeyondPrepared`, `App.fetchRoadNetworkForExtent`;
in `js/projects/walkshed.js` search `function computeRequiredExtent`, `function streetsSuffix`,
`function beyondPreparedWarn`, `function checkNetworkCoverage`, `async function downloadNetworkForPendingExtent`,
`var extent = _pendingDownloadExtent;`; in `js/projects/transit-travelshed.js` search `turf.booleanContains(downloadedExtent`.

**Files you may change (closed list):** `js/core/road-network.js`, `js/projects/walkshed.js`,
`js/projects/transit-travelshed.js`. Style: `var`, no arrow functions. Change only what is listed.

### B1. `js/core/road-network.js`

1. After `var _lastTileError = "";` add
   `var _tileCells = null;  // lookup "col_row" -> true of the cells the live tile load asked for; null for every other network`
2. Immediately before `async function loadNetworkFromTiles` add:
   ```js
   function cellLookup(keys) {
     var o = Object.create(null);
     for (var i = 0; i < keys.length; i++) o[keys[i]] = true;
     return o;
   }

   // Outline of a tile load: the union of each piece's rectangle of cells.
   // Display only. Coverage is answered from _tileCells, so a union that
   // fails can only leave the outline incomplete.
   function tileOutline(boxes) {
     var rects = WalkTiles.cellRectsForBboxes(boxes);
     var out = null;
     for (var i = 0; i < rects.length; i++) {
       var poly = turf.bboxPolygon(rects[i]);
       if (!out) { out = poly; continue; }
       try { out = turf.union(out, poly) || out; } catch (e) { /* keep what we have */ }
     }
     return out;
   }
   ```
3. `loadNetworkFromTiles(extentPolygon)` → `loadNetworkFromTiles(extentPolygon, pieces)`. Replace the line
   `var cells = WalkTiles.cellsForBbox(turf.bbox(extentPolygon));` with
   ```js
   // One box per selected point when the caller supplies them, so two distant
   // points read only their own tiles and not every tile between them.
   var boxes = (Array.isArray(pieces) && pieces.length) ? pieces : [turf.bbox(extentPolygon)];
   var cells = WalkTiles.cellsForBboxes(boxes);
   ```
4. In the success tail replace the three comment lines above `_downloadedBboxPolygon = …` and that line with
   ```js
   // The cells ASKED FOR, not the tiles found: a cell with no tile has no
   // exported streets, per the tile contract, so it still counts as covered.
   _tileCells = cellLookup(WalkTiles.cellKeys(cells));
   _downloadedBboxPolygon = tileOutline(boxes);
   ```
   and replace the two comment lines plus the `persistNetwork(extentCacheId(…), "walk-tiles", rel);` line with
   ```js
   // Not a "bbox:" id: network-store matches those by rectangle, and a load
   // of separate pieces must never claim the gap between them. One slot per release.
   persistNetwork("tiles:" + rel, "walk-tiles", rel, WalkTiles.cellKeys(cells));
   ```
5. `persistNetwork(id, source, label)` → `persistNetwork(id, source, label, tileCells)`; in the saved object add
   `tileCells: tileCells || null` after the `extent:` line. The three existing callers are unchanged.
6. Add `_tileCells = null;` directly after each existing `_tileRelease = "";` (three places: download tail,
   file import, `unloadRoadNetwork`).
7. In `loadStoredRecord`, directly after the `_tileRelease = rec.source === "walk-tiles" …` line add
   `_tileCells = (rec.source === "walk-tiles" && Array.isArray(rec.tileCells)) ? cellLookup(rec.tileCells) : null;`
8. Replace the whole `App.walkTilesExtentBeyondPrepared = function (extentPolygon) { … };` with the same function
   taking `(extentPolygon, pieces)`: keep its three guard lines, then
   ```js
   var cb = App.walkTilesSource.manifest().coverage.bbox;
   var boxes = (Array.isArray(pieces) && pieces.length) ? pieces : [turf.bbox(extentPolygon)];
   for (var i = 0; i < boxes.length; i++) {
     var eb = boxes[i];
     if (eb[0] < cb[0] || eb[1] < cb[1] || eb[2] > cb[2] || eb[3] > cb[3]) return true;
   }
   return false;
   ```
9. Directly after it add:
   ```js
   // Are the streets this run needs loaded? A tile network answers by cells
   // (its outline can be several separate rectangles, which
   // turf.booleanContains cannot test); any other network by its rectangle.
   App.roadNetworkCoversExtent = function (extentPolygon, pieces) {
     if (!_graph || !extentPolygon) return false;
     if (_tileCells && typeof WalkTiles !== "undefined") {
       var boxes = (Array.isArray(pieces) && pieces.length) ? pieces : [turf.bbox(extentPolygon)];
       var keys = WalkTiles.cellKeys(WalkTiles.cellsForBboxes(boxes));
       if (!keys.length) return false;
       for (var i = 0; i < keys.length; i++) {
         if (!_tileCells[keys[i]]) return false;
       }
       return true;
     }
     if (!_downloadedBboxPolygon) return false;
     try { return turf.booleanContains(_downloadedBboxPolygon, extentPolygon); } catch (e) { return false; }
   };
   ```
10. `App.fetchRoadNetworkForExtent = async function (extentPolygon)` → `(extentPolygon, pieces)`, and its tile
    line becomes `if (tileSourceActive()) return loadNetworkFromTiles(extentPolygon, pieces);`. Rest unchanged.
11. Update the trailing comment on `App.getRoadDownloadExtent` to `// Feature<Polygon|MultiPolygon>|null — for a tile network, display only; use App.roadNetworkCoversExtent to test coverage`.

### B2. `js/projects/walkshed.js`

1. After `var _pendingDownloadExtent = null; …` add
   `var _pendingPieces = null; // [[w, s, e, n], ...] one box per selected point, set with _pendingDownloadExtent`
2. `computeRequiredExtent`: first line of the body `_pendingPieces = null;`; declare `var boxes = [];` beside
   `var pieces = [];`; in the `forEach`, build the circle into a variable, push it to `pieces` and push
   `turf.bbox(circle)` to `boxes`; immediately before the final `return` add `_pendingPieces = boxes;`.
   (Confirm with grep that `computeRequiredExtent` is called only from `checkNetworkCoverage`; else stop.)
3. Add near `checkNetworkCoverage`:
   ```js
   function networkCovers() {
     if (typeof App.roadNetworkCoversExtent === "function") {
       return App.roadNetworkCoversExtent(_pendingDownloadExtent, _pendingPieces);
     }
     return turf.booleanContains(App.getRoadDownloadExtent(), _pendingDownloadExtent);
   }
   ```
   and change `!turf.booleanContains(downloaded, _pendingDownloadExtent)` to `!networkCovers()`.
4. `downloadNetworkForPendingExtent`: `App.fetchRoadNetworkForExtent(_pendingDownloadExtent)` →
   `App.fetchRoadNetworkForExtent(_pendingDownloadExtent, _pendingPieces)`.
5. `runWalkshed`: after `var extent = _pendingDownloadExtent;` add `var pieces = _pendingPieces;`, and
   `App.fetchRoadNetworkForExtent(extent)` → `App.fetchRoadNetworkForExtent(extent, pieces)`.
6. In `streetsSuffix` and `beyondPreparedWarn`: `App.walkTilesExtentBeyondPrepared(_pendingDownloadExtent)` →
   `App.walkTilesExtentBeyondPrepared(_pendingDownloadExtent, _pendingPieces)`.

### B3. `js/projects/transit-travelshed.js`

Add near its `setCoverageWarn`:
```js
function networkCovers(extent) {
  if (typeof App.roadNetworkCoversExtent === "function") return App.roadNetworkCoversExtent(extent);
  return turf.booleanContains(App.getRoadDownloadExtent(), extent);
}
```
Replace both `!turf.booleanContains(downloadedExtent, requiredExtent)` with `!networkCovers(requiredExtent)`
(the surrounding `downloadedExtent &&` / `requiredExtent &&` conditions stay).

**Edge cases that must hold:** no pieces → identical to today; a network that is not from tiles → rectangle
test as today; pieces whose cells overlap → each tile read once; one point then a second far point → second
run loads both points' cells and replaces the network; tile source cleared → `_tileCells` stays until the
network is replaced; restored older tile record without `tileCells` → rectangle test.

**Done when:** `node --check` on the three files prints nothing; `node test/run-golden.mjs` ends `PASS —`;
`NODE_PATH=/opt/node-tools/node_modules node test/browser/<f>.test.mjs` ends `PASS —` for `network-cache`,
`street-exclusion`, `walkshed-stale`, `walkshed-contour`. (`walk-tiles.test.mjs` is expected to FAIL two
checks until Card C; report its output, do not edit it.) Paste `git diff js/core/road-network.js` in the report.

**Stop and report if:** an anchor is missing, or `network-store.js`, `index.html` or any test seems to need a change.

## Card C (Haiku) — behaviour test

**Files you may change:** `test/browser/walk-tiles.test.mjs` only. Modern syntax. Reuse its helpers.

1. Check "tile network stored as a walk-tiles record with an area id": rename to "… stored under its release id
   with its cells"; expect `tileRec.id === "tiles:fixture-release"`, label `fixture-release`. Extend
   `storedRecords` to also return `tileCells`; expect `["7499_12975","7500_12975"]`.
2. Outside-extent check: expected text ends `Prepared area: -105.006, 39.755 to -104.944, 39.755.`
3. Check "a stored tile network of the active release restores by area": rename to "a stored tile network is
   never matched by area" and expect `restoreTile.ok === false`.
4. New section directly after the stored-record check (network loaded, panel open, first point present):
   - add a second point `App.addPoint(-104.945, 39.755)`, tick both points if the list needs it (inspect
     `#wsPointList`; report if selection cannot be driven), `window.__statusLog.length = 0`, trigger Calculate
     with `page.evaluate(() => document.getElementById("wsComputeBtn").click())`;
   - wait for status `4 FLM tile segments loaded from 3 tiles (fixture-release)`;
   - `tileRequests.length === 3` (only `7505_12975.json` is new);
   - `App.getRoadDownloadExtent().geometry.type === "MultiPolygon"`;
   - `App.roadNetworkCoversExtent(turf.bboxPolygon([-104.975,39.754,-104.973,39.756])) === false` (the gap);
   - `App.roadNetworkCoversExtent(turf.bboxPolygon([-105.004,39.754,-105.002,39.756])) === true`;
   - no Overpass request.
   Do not assert how many walksheds were produced.
5. In the refresh section: after the "URL source restored after page refresh" check, load two pieces directly
   `App.fetchRoadNetworkForExtent(turf.bboxPolygon([-105.0074,39.7516,-104.9406,39.7584]), [[-105.0074,39.7516,-104.9986,39.7584],[-104.9494,39.7516,-104.9406,39.7584]])`,
   wait for a stored record with 3 `tileCells`, reload, wait for `App.roadNetworkLoaded()`, then check the gap
   is still not covered and the first piece is; then `App.unloadRoadNetwork()` before the unreadable-tile section.

**Done when:** the file ends `PASS — n/n checks passed` three runs in a row; paste the full output of one run.

## Review gate (Opus)

- Run `code-review` at `high` on the diff since `15efc3d`; re-run every "Done when" command.
- Read the `road-network.js` diff line by line against B1. Specific things to confirm:
  - `_tileCells` is reset at every place the live network is replaced or removed (4 writes + restore);
  - no remaining `turf.booleanContains` on the downloaded extent in either module;
  - `persistNetwork`'s other three callers still save `tileCells: null`;
  - `network-store.js` has no diff;
  - a second tile load after a failed one leaves `_tileCells` and the outline of the previous network intact.
- Full `bash test/browser/run-browser.sh` (run in two halves if the machine is short of memory) and
  `test/ui-screens/capture.mjs`.
- Manual, by the lead with real Denver tiles: two points at opposite ends → two separate dashed rectangles,
  status tile count far below 301; add a third point between them → loads again and covers all three;
  refresh the page → streets come back and a re-run does not reload.
- Then (Opus): update `docs/reference/road-network.md` "FLM walk tiles" (per-piece loading, `_tileCells`,
  `App.roadNetworkCoversExtent`, record id `tiles:<release>` + `tileCells`, three new `WalkTiles` functions) and
  append a progress-log entry to `docs/flm-walk-tiles-plan.md`. One commit per card with `Verified:` lines; push.

## Not in this plan

- Per-point loading for OpenStreetMap downloads or for Transit Travelshed.
- Adding to an already loaded tile network instead of replacing it.
- Any change to `js/core/network-store.js` or the tile format.

## Progress log

### November 13, 2026

- **Card A, Haiku at high effort:** three pure helpers, third fixture tile, nine golden cases (34 in the module). Passed review first time. Two golden cases that echo the manifest were re-recorded on purpose.
- **Card B, Haiku at high effort:** `road-network.js`, `walkshed.js`, `transit-travelshed.js`, code inserted verbatim from the card. Passed review first time. Planner edit: two stale comments.
- **Card C, Haiku at high effort:** behaviour test, nine new checks. The agent found that `App.addPoint` does not rebuild Walkshed's point list (only the drawing path does), so the test calls `App.notifyProject()` after it, as the drawing path does.
- **Review gate (planner):** `code-review` at high; full browser suite, one file at a time, 26 files pass (`walk-tiles` 43/43); golden 778/778. Fixed directly: a superseded attempt could leave a stale red error in the dialog; a failed attempt overwrote the address just typed; a failed startup restore and a failed folder picker are now kept in the dialog; the Walkshed button cannot start a second load while Calculate is loading; `features.md` and Walkshed's empty hint described the old button flow; test for the "not a release folder" message.
- **Test flakes:** `walk-tiles.test.mjs` failed two post-refresh checks once in 14 runs. The failing run overlapped the Card C agent's own last run on a memory-short machine; 13 solo runs passed. The startup-failure check now reads the dialog, not the status log (the log's observer reads text once per batch of changes and can miss a message another status replaces).
- **Left as is, for the lead:** with a tile source set, Calculate replaces whatever street network is loaded with only the tiles this run needs (a large Transit Travelshed network is dropped by a later Walkshed run that needs a cell outside it); Transit Travelshed still loads one rectangle with no size prompt.
- **Hand-off notes:** `App.fetchRoadNetworkForExtent(extent, pieces?)`, `App.loadRoadNetworkFromTiles(extent, pieces?)`, `App.roadNetworkCoversExtent(extent, pieces?)`, `App.walkTilesExtentBeyondPrepared(extent, pieces?)`; `WalkTiles.cellsForBboxes`, `cellRectsForBboxes`, `cellKeys`; stored tile record id `tiles:<release>` with `tileCells`.
