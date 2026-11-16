# Plan: OpenStreetMap streets downloaded per point, not for the rectangle between points

Status: planned, not started. Branch `claude/jolly-hamilton-64dask`, base commit `6663b69`.
Follow `CLAUDE.md` and `AGENTS.md`. Two Haiku cards (effort `high`), then an Opus review gate and docs.
Every anchor below was checked against the code at `6663b69`.

## Context (as the code stands)

- Walkshed already computes one box per selected point: `computeRequiredExtent` in
  `js/projects/walkshed.js` fills `_pendingPieces` (`[[w,s,e,n], ...]`, walk reach + `App.ROAD_SNAP_MAX_KM`).
- Walkshed already passes those boxes to every download: `App.fetchRoadNetworkForExtent(_pendingDownloadExtent, _pendingPieces)`
  in `downloadNetworkForPendingExtent`. **`js/projects/walkshed.js` needs no change.**
- `App.fetchRoadNetworkForExtent` (end of `js/core/road-network.js`) ignores `pieces` on the OpenStreetMap path:
  after `restoreNetworkCovering(extentPolygon)` fails it calls `fetchNetworkForBounds({s,w,n,e}, turf.bboxPolygon(bb))`,
  one rectangle.
- `fetchNetworkForBounds(bounds, extentPolygon)` builds one Overpass statement `way[...](s,w,n,e);` inside a
  union `( ... );out geom;`. Overpass returns each way once even when several statements in one union match it,
  so several boxes need no de-duplication.
- CDOT already does per-box coverage with `_cdotBoxes` in `App.roadNetworkCoversExtent`, a box outline with
  `boxesOutline(rects)`, and saves under a non-`bbox:` id so `network-store.js` `findCovering` (which reads only
  `bbox:` ids, `_idBbox`) never area-matches it.
- `network-store.js` keeps `MAX_ENTRIES = 3` records. It is NOT changed.
- Transit Travelshed calls `App.fetchRoadNetworkForExtent(_pendingDownloadExtent)` with no pieces; unchanged.

## Fixed decisions

1. **When to download by pieces.** Only when `pieces` has 2 or more boxes AND the summed area of the boxes is
   less than half the area of the whole rectangle (`turf.bbox(extentPolygon)`). Otherwise the download is
   exactly today's single rectangle (same query, same `bbox:` id, same area reuse). Reason: nearby points gain
   nothing from pieces, and a rectangle can be reused later by area.
2. **One Overpass request**, with one `way[...](s,w,n,e);` statement per box inside the existing union.
3. **Coverage:** `_cdotBoxes` is renamed `_loadedBoxes` and also set by a piecewise OpenStreetMap download.
   The CDOT layers check inside `App.roadNetworkCoversExtent` runs only when `_networkSource === "cdot"`.
4. **Stored copy of a piecewise download:** id `"osm-boxes:" + <the bbox: id's numbers of the whole rectangle>`,
   source `"overpass"`, label `""`, `boxes` = the boxes. Never area-matched; comes back only through the startup
   restore (`App.networkStore.latest()`), exactly like CDOT/tile records. A single-rectangle download keeps its
   `bbox:` id and `boxes: null`.
5. **Area warning** (`MAX_AREA_WARN_KM2`) uses the summed box area for a piecewise download.
6. **Map outline:** `boxesOutline(boxes)` for a piecewise download; the rectangle otherwise (as today).
7. **Status texts unchanged.**

## Card A (Haiku, high) — `js/core/road-network.js`

**Goal:** let the OpenStreetMap download fetch several boxes in one Overpass request and track coverage by box.

**Read first:** `CLAUDE.md`, `AGENTS.md`, this plan; in `js/core/road-network.js` search
`var _cdotBoxes`, `async function fetchNetworkForBounds`, `function boxesOutline`, `function extentCacheId`,
`function loadStoredRecord`, `App.roadNetworkCoversExtent = function`, `App.fetchRoadNetworkForExtent = async function`.

**Files you may change (closed list):** `js/core/road-network.js`. ES5 (`var`, no arrow functions).

**Steps**

1. Rename every `_cdotBoxes` to `_loadedBoxes` (13 occurrences: `grep -c _cdotBoxes` must print 0 afterwards).
   Change its declaration comment to
   `// [[w,s,e,n], ...] the boxes a piecewise load (CDOT, or OpenStreetMap by point) asked for; null otherwise`.
   In the comment above `function boxesOutline`, replace `_tileCells / _cdotBoxes` with `_tileCells / _loadedBoxes`.
2. In `loadStoredRecord`, replace the line
   `_loadedBoxes = (rec.source === "cdot" && Array.isArray(rec.boxes)) ? rec.boxes : null;` with
   `_loadedBoxes = ((rec.source === "cdot" || rec.source === "overpass") && Array.isArray(rec.boxes)) ? rec.boxes : null;`
3. In `App.roadNetworkCoversExtent`, replace
   `if (cdotSourceActive() && _cdotLayers !== App.cdotSource.layersKey()) return false;` with
   `if (_networkSource === "cdot" && cdotSourceActive() && _cdotLayers !== App.cdotSource.layersKey()) return false;`
   and update the comment above `App.roadNetworkCoversExtent` to say a CDOT or piecewise OpenStreetMap network
   answers by its boxes.
4. `async function fetchNetworkForBounds(bounds, extentPolygon)` → `async function fetchNetworkForBounds(bounds, extentPolygon, boxes)`.
   Add to its header comment: `//   boxes         : optional [[w,s,e,n], ...]; when given, one query statement per box replaces bounds`.
   At the top of the body add
   ```js
   var piecewise = Array.isArray(boxes) && boxes.length > 0;
   ```
   Replace `var areaKm2 = turf.area(extentPolygon) / 1e6;` with
   ```js
   var areaKm2 = 0;
   if (piecewise) {
     for (var bi = 0; bi < boxes.length; bi++) areaKm2 += turf.area(turf.bboxPolygon(boxes[bi])) / 1e6;
   } else {
     areaKm2 = turf.area(extentPolygon) / 1e6;
   }
   ```
5. Replace the whole `var query = ...;` statement with:
   ```js
   var wayFilter = 'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|' +
     'residential|unclassified|service|motorway_link|trunk_link|' +
     'primary_link|secondary_link|tertiary_link|' +
     'living_street|pedestrian|footway|path|steps|cycleway)$"]';
   // One statement per box inside one union: Overpass returns a way once even
   // when two boxes both contain it.
   var parts = piecewise
     ? boxes.map(function (b) { return wayFilter + '(' + clampLat(b[1]) + ',' + b[0] + ',' + clampLat(b[3]) + ',' + b[2] + ');'; })
     : [wayFilter + '(' + bounds.s + ',' + bounds.w + ',' + bounds.n + ',' + bounds.e + ');'];
   var query = '[out:json][timeout:60];(' + parts.join('') + ');out geom;';
   ```
   Keep the existing two-line comment about vehicle roads above it.
6. In the success tail of `fetchNetworkForBounds`, replace
   `_downloadedBboxPolygon = extentPolygon; // record the fetched extent for the on-map outline` with
   `_downloadedBboxPolygon = piecewise ? boxesOutline(boxes) : extentPolygon; // on-map outline`,
   replace `_loadedBoxes = null;` (in that tail) with
   `_loadedBoxes = piecewise ? boxes.map(function (b) { return b.slice(); }) : null;`,
   and replace `persistNetwork(extentCacheId(extentPolygon), "overpass", "");` with
   ```js
   // A piecewise download must never be area-matched (it would claim the gap
   // between points), so it is stored under a non-"bbox:" id.
   if (piecewise) {
     persistNetwork("osm-boxes:" + extentCacheId(extentPolygon).slice(5), "overpass", "", null, _loadedBoxes);
   } else {
     persistNetwork(extentCacheId(extentPolygon), "overpass", "");
   }
   ```
7. Directly before `App.fetchRoadNetworkForExtent = async function`, add:
   ```js
   // Pieces only pay off when the points are far apart; otherwise one rectangle
   // is as small and can be reused later by area.
   function usePieces(extentPolygon, pieces) {
     if (!Array.isArray(pieces) || pieces.length < 2) return false;
     var whole = turf.area(turf.bboxPolygon(turf.bbox(extentPolygon)));
     var sum = 0;
     for (var i = 0; i < pieces.length; i++) sum += turf.area(turf.bboxPolygon(pieces[i]));
     return sum < whole / 2;
   }
   ```
8. In `App.fetchRoadNetworkForExtent`, replace its last line
   `return fetchNetworkForBounds({ s: bb[1], w: bb[0], n: bb[3], e: bb[2] }, turf.bboxPolygon(bb));` with
   `return fetchNetworkForBounds({ s: bb[1], w: bb[0], n: bb[3], e: bb[2] }, turf.bboxPolygon(bb), usePieces(extentPolygon, pieces) ? pieces : null);`
   Leave `fetchRoadNetwork()` (the map-view download) unchanged: it passes no boxes.

**Edge cases that must hold**
1. No pieces, or one piece → identical request, id and outline to today.
2. Two close points (box sum ≥ half the rectangle) → identical to today.
3. A piecewise download followed by a single-rectangle download → `_loadedBoxes` back to null.
4. A CDOT network: coverage behaviour unchanged (layers check still applies).
5. A restored old OpenStreetMap record (`boxes: null`) → rectangle coverage as today.
6. Failed or cancelled download → previous network, outline and `_loadedBoxes` untouched (all writes are in the
   success tail after `rebuildNetwork()`).

**Done when**
- `node --check js/core/road-network.js` prints nothing.
- `grep -c _cdotBoxes js/core/road-network.js` prints `0`.
- `node test/run-golden.mjs` ends with `PASS —`.
- Each of these ends `PASS — n/n checks passed`, run one at a time with
  `NODE_PATH=/opt/node-tools/node_modules node test/browser/<f>.test.mjs`:
  `network-cache`, `cdot-source`, `walkshed-stale`, `walkshed-contour`, `walk-tiles`, `street-exclusion`.
- Paste `git diff js/core/road-network.js` in the report.

**Stop and report if:** an anchor is missing; the rename count is not 13; any other file seems to need a change.

## Card B (Haiku, high) — `test/browser/osm-pieces.test.mjs` (new)

**Goal:** prove that two far-apart Walkshed points download two boxes in one Overpass request, and that nearby
points still download one rectangle.

**Read first:** `test/browser/README.md`, `test/browser/walkshed-stale.test.mjs` (whole file: copy its imports,
`check`, `waitFor`, server/browser setup and `overpassPayload()`), `test/browser/cdot-source.test.mjs`
lines that search `__statusLog`, `openModulePopup("walkshed")`, `#wsPointList input[type=checkbox]`.

**Files you may change:** NEW `test/browser/osm-pieces.test.mjs` only. Modern syntax allowed.

**Setup:** copy `walkshed-stale.test.mjs`'s structure. In the Overpass route handler, push
`decodeURIComponent((route.request().postData() || "").replace(/^data=/, ""))` to an array `overpassQueries`,
then fulfill with `overpassPayload()`. Count bbox statements in a query with
`(q.match(/\]\(-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+\);/g) || []).length`.

Default Walkshed settings (15 and 30 min, 3.1 mph) give each point a box of radius ≈ 3.0 km.

**Checks (in order)**
1. "app ready" — `App.fetchRoadNetworkForExtent` and `App.roadNetworkCoversExtent` are functions.
2. Add points `App.addPoint(-105.15, 39.76)` and `App.addPoint(-104.75, 39.76)`, `App.notifyProject()`, open
   `App.openModulePopup("walkshed")`, wait for 2 checkboxes in `#wsPointList` and tick both (as `cdot-source`
   does). Click `#wsComputeBtn`. Wait for `#wsDownloadBtn` to be visible (`style.display !== "none"`), then click it.
   Wait for `App.roadNetworkLoaded() && App.roadNetworkSource() === "overpass"`.
   - "one Overpass request" — `overpassQueries.length === 1`.
   - "two boxes in the request" — bbox statement count of `overpassQueries[0]` is `2`.
   - "outline is two rectangles" — `App.getRoadDownloadExtent().geometry.type === "MultiPolygon"`.
   - "first point covered" — `App.roadNetworkCoversExtent(turf.bboxPolygon([-105.151,39.759,-105.149,39.761]))` is true.
   - "gap not covered" — `App.roadNetworkCoversExtent(turf.bboxPolygon([-104.951,39.759,-104.949,39.761]))` is false.
3. "stored under an osm-boxes id" — poll IndexedDB with `App.networkStore.latest()` until a record exists;
   expect `rec.id.indexOf("osm-boxes:") === 0`, `rec.source === "overpass"`, `rec.boxes.length === 2`.
4. Reload the page; wait for `App.roadNetworkLoaded()`.
   - "restored network still not covering the gap" — same gap call is false.
   - "restored network covers the first point" — same first-point call is true.
5. `App.unloadRoadNetwork()`; clear `overpassQueries`. Call directly
   `App.fetchRoadNetworkForExtent(turf.bboxPolygon([-105.04,39.73,-104.95,39.79]), [[-105.04,39.73,-104.97,39.79],[-105.02,39.73,-104.95,39.79]])`
   and await it.
   - "close boxes use one rectangle" — `overpassQueries.length === 1` and its bbox statement count is `1`.
   - "close boxes outline is a polygon" — `App.getRoadDownloadExtent().geometry.type === "Polygon"`.
6. "no CDOT or tile request" — no request URL contained `dtdapps.codot.gov` during the run.

Do not assert walkshed results or counts (the stub streets do not reach the far points).

**Done when:** the file ends `PASS — n/n checks passed` three runs in a row; paste one run's full output.

**Stop and report if:** the download button never appears; a check fails after two fixes to your own code;
selection of points cannot be driven.

## Review gate (Opus)

- `code-review` at `high` on the diff since `6663b69`; re-run every "Done when" command.
- Confirm: `network-store.js` and `walkshed.js` have no diff; `fetchRoadNetwork()` unchanged; every write of
  `_loadedBoxes` sits after `rebuildNetwork()` or in `unloadRoadNetwork`/file import.
- Full browser suite one file at a time, and `test/ui-screens/capture.mjs`.
- Docs (Opus): `docs/reference/road-network.md` section `## road-network.js` (piecewise Overpass, `_loadedBoxes`,
  `osm-boxes:` id, the half-area rule), `features.md` entry, add `osm-pieces.test.mjs` to `test/browser/README.md`'s list.
- One commit per card with `Verified:` lines, progress-log entry below, push.

## Out of scope

- Automatic OpenStreetMap download on Calculate (still the download button).
- Per-point download for Transit Travelshed and for the Add Data map-view download.
- Adding boxes to a loaded network instead of replacing it.
- Area-matching piecewise records in `network-store.js`.

## Progress log

- 2026-11-16: plan written from the code at `6663b69`.
