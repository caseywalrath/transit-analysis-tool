# Design brief: CDOT road layers as a live street source in the transit analysis tool

Status: approved for hand-off by the project lead, November 13, 2026; the classification table in section 4 is approved as written. Written against `transit-analysis-tool` at commit `58abc0f` (merge of PR 38) plus the Stage 2 brief `plan-b-stage2-design-brief.md` in this folder. The FLM walk-tiles source from that brief has been built locally and is under test but is not on GitHub, so the planner must reconcile sections 5.3 and 5.5 with the tiles code as it actually exists before writing cards. Line numbers are from `58abc0f` and will drift; the search strings will not.

Audience: the Opus-class planner in the `transit-analysis-tool` repository, who turns the phases below into task cards per that repository's `AGENTS.md`, launches Haiku or Sonnet agents, and reviews. Follow `CLAUDE.md` and `AGENTS.md` there; this brief adds the CDOT-specific decisions and does not override them.

Nothing in this brief changes the FLM repository or the FLM tile format.

## 1. Purpose in one paragraph

The tool computes walksheds from streets it downloads live from OpenStreetMap through Overpass, from one imported GeoJSON file, or (Stage 2) from FLM walk tiles. This brief adds a fourth source: the Colorado Department of Transportation's public ArcGIS FeatureServer, queried live for the road centerlines that touch the area a walkshed needs. The purpose is a measured comparison, not a replacement. CDOT's layers are street centerlines only; they contain no sidewalks, paths, trails, pedestrian streets or bridges, and in the downtown Denver test box they hold 306 segments where the FLM OpenStreetMap network holds 10,669. The source exists so the lead can run the same walkshed on both networks, side by side, anywhere in Colorado, and see how much the difference matters. Snapping, routing, the contour shape, Census summaries and export are untouched.

## 2. Measured facts about the CDOT service (November 13, 2026)

Everything in this section was checked by live request from the command line. Treat it as true for this service on that date, not as a promise about the future.

Service: `https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer`. Three line layers matter:

| Layer | Name | Statewide features | Classification field and values | Joins to the other layers? |
|---|---|---|---|---|
| 14 | Local Roads | 183,137 | `FUNCCLASSID`, only `"7  Local"` | Yes, with 17 |
| 17 | Major Roads | 43,464 | `FUNCCLASSID`: `"2  Principal Arterial - Fwys and Expwys"`, `"3  Principal Arterial - Other"`, `"4  Minor Arterial"`, `"5  Major Collector"`, `"6  Minor Collector"` | Yes, with 14 |
| 7 | Highways (state and US routes, interstates) | 81,592 | `FUNCCLASS` (no `ID` suffix), values `"1  Interstate"` through `"7  Local"`; `ACCESS_` with values such as `"F-W: Interstate System, Freeway Facils"`, `"E-X: Expressway, Major Bypass"`, `"NR-B: Non-Rural Arterial"`, `"R-B: Rural Highway"`; `ROUTESIGN` `I`, `U.S.`, `SH` | **No.** In a Fraser test box, 2 of 152 local and major road endpoints coincide with any highway vertex. Highway geometry is a separate route-based line set. |

Layers 4 (Frontage Roads) and 28 (Ramps) returned nothing in the Denver test box and are not part of this brief.

The two parts of each classification string are separated by **two spaces** (`"7  Local"`). Match on the leading digit, not the whole string.

Topology of layers 14 and 17 together, downtown Denver box `-105.015,39.740,-104.995,39.755`: 306 segments, 260 distinct endpoints, 207 shared by two or more segments, 53 dangling (segments that leave the box), 0 dangling endpoints lying on another segment's interior vertex, 0 near-misses within 1 m. Segments are already split at intersections and endpoints match to six decimals. **No intersection-splitting step is needed for 14 and 17.** Layer 7 does not share this property and is therefore off by default (section 4).

Counts for the Plan A areas:

| Box | Layer 14 | Layer 17 | Layer 7 |
|---|---|---|---|
| Denver, Union Station | 90 | 216 | 0 |
| Fraser (`-105.84,39.93,-105.80,39.96`) | 125 | 15 | 29 |
| Greeley (`-104.72,40.41,-104.68,40.44`) | 304 | 114 | not checked |

Query behaviour:

- `f=geojson` with `outSR=4326` returns a FeatureCollection with `LineString` geometries in longitude/latitude; `returnZ=false&returnM=false` yields 2-D coordinates. No `MultiLineString` was seen, but `buildGraph` accepts them anyway.
- `maxRecordCount` is 2,000 per request. When a page is cut short the GeoJSON response carries `"exceededTransferLimit": true` at the top level (and again under `properties`). The final page omits the key. Pages are requested with `orderByFields=OBJECTID&resultOffset=<n>&resultRecordCount=<n>`. Verified: page of 50 then page of 40 for a 90-feature box.
- The server answered a request carrying `Origin: https://caseywalrath.github.io` with `Access-Control-Allow-Origin: https://caseywalrath.github.io` and `Access-Control-Allow-Credentials: true`. Browser fetches from the GitHub Pages app should therefore work. **Not verified from inside a browser; the behaviour test in section 9 is the first time that happens.**
- `SEG_LENGTH` is in miles (a 95 m segment reports 0.06). It is not used for routing; the tool recomputes length.
- `OBJECTID` values are per layer and overlap between layers. `GISID` in layers 14 and 17 is a string such as `"20000WEWATTA  ST  677"`; stability across data refreshes is unknown.
- Not verified: rate limits, terms of use for a public application, service uptime, response time under load. **The lead, not an agent, asks CDOT GIS staff about these.**

Sample responses from the probe are kept outside both repositories; the agent building the fixture (section 9) re-fetches its own with the exact query in section 5.1 and trims it.

## 3. What already exists and must be reused

All paths in `transit-analysis-tool`. The Stage 2 brief's table in its section 2 still applies; these are the rows that matter most here, plus what Stage 2 added.

| Piece | Where | Relevance |
|---|---|---|
| Overpass download | `js/core/road-network.js`, `async function fetchNetworkForBounds(bounds, extentPolygon)` | The model for the CDOT fetch: status text while downloading, feature mapping loop with a `setTimeout(0)` yield every 500 features, then the tail `_roadGeoJSON = geojson; rebuildNetwork(); _downloadedBboxPolygon = extentPolygon; updateUI(true); persistNetwork(extentCacheId(extentPolygon), "overpass", ""); App.setStatus(...)`. The CDOT load copies this tail exactly, changing only the cache id, source and status text. Note it stores the extent polygon as passed, with no buffer; CDOT does the same. |
| Area guard | same function, `MAX_AREA_WARN_KM2 = 2000` and `window.confirm` | Reuse the same guard and the same threshold. |
| Network builder | same file, `function buildGraph(geojson)` | Reads `properties.highway`, `foot`, `name`, `sidewalk`, `footway`, `wayId`. `isPedForbidden(hwy, foot)` blocks `motorway`, `trunk`, `motorway_link`, `trunk_link` unless `foot` is `yes`, `designated` or `permissive`. The CDOT adapter produces these properties and nothing else the graph reads. |
| Street exclusions | same file, `_excludedWays` (a `Set`), `App.setExcludedWays()` | Clicked `wayId` values are compared with `Set.has`. CDOT ids must be numbers (section 5.1) so exclusions behave as they do for Overpass. |
| Module entry point | same file, `App.fetchRoadNetworkForExtent = async function (extentPolygon)` | At `58abc0f`: restore from the store, else download. Stage 2 adds a tiles branch at the top. **The CDOT branch goes beside it (section 5.3).** |
| Store restore | same file, `async function restoreNetworkCovering(extentPolygon)` and `function loadStoredRecord(rec)` | Stage 2 adds a guard on `rec.source`. Section 5.3 generalises that guard. |
| Persistence | `js/core/network-store.js`, `App.networkStore` | Records `{ id, savedAt, source, label, featureCount, extent, geojson }`. **Opus-only area; not changed.** A new `source` value `"cdot"` is just a string in a record. |
| Coverage checks | `js/projects/walkshed.js`, `function checkNetworkCoverage(targets)`; `js/projects/transit-travelshed.js` near `getRoadDownloadExtent` | Unchanged. Because the CDOT load records `_downloadedBboxPolygon = extentPolygon`, exactly like Overpass, both checks work as they do today. |
| Download button | `js/projects/walkshed.js`, `showDownloadBtn(show)`, button `#wsDownloadBtn` "Download streets for this area" | Stage 2 relabels it when tiles are active; section 5.4 adds the CDOT label. |
| Add Data menu, ONLINE block | `index.html`, `<div class="add-data-heading">ONLINE</div>`, `<button id="road-net-download">Area Roads for Street Routing</button>`; `js/app.js`, `_adClrCfgs` entry `btnId: "road-net-download"` | The CDOT entry sits directly under the Overpass entry, in the ONLINE block, not LOCAL. |
| Dialog pattern | `index.html`, `<div id="lodes-popup"` and Stage 2's `#walk-tiles-popup` | Copy whichever Stage 2 ended up shipping. |
| Per-browser setting | `js/core/config.js`, `localStorage.getItem("mat-carto-key")`; Stage 2's `mat-walk-tiles-source` | Same pattern, key `mat-cdot-source`. Not in the session file. |
| Golden tests | `test/run-golden.mjs`; `test/cases/walk-cost.mjs`; Stage 2's `test/cases/walk-tiles.mjs` | A pure engine must not touch `turf`, `App`, `fetch` or the DOM at load time. |
| Browser tests | `test/browser/network-cache.test.mjs`, `harness.mjs` (Playwright) | Playwright `page.route()` can intercept requests to the CDOT host and answer from fixtures, so the behaviour test needs no network. |

## 4. Decisions fixed by this brief

| Question | Decision | Reason |
|---|---|---|
| Replace Overpass? | No. CDOT is a selectable source; Overpass remains the default when nothing else is active. | Lead's instruction. |
| Which layers by default | 14 and 17 on, 7 off, each a checkbox. | 14 and 17 join cleanly; 7 does not join them and would route nothing across a state highway. Turning 7 on is allowed for inspection, with a warning in the dialog. |
| Walkability | Set `foot` to `""` on every CDOT feature and let `isPedForbidden` decide from the mapped `highway` value. | Keeps one walkability rule in one place. Freeways and interstates map to `trunk`/`motorway` and are blocked; everything else is walkable, which matches what Overpass does for ordinary streets. |
| Buffered extent | None beyond what the caller passes. | Overpass does the same; the walkshed's required extent already includes the full walk radius. |
| Combining CDOT streets with OSM footways | **Deferred, and not promised.** | CDOT and OSM geometries do not share vertices, so concatenating them yields footways disconnected from streets everywhere except by chance. A useful merge needs snapping or connector generation, which is a methodology decision for the lead and an Opus design task. Report this; do not build it in this phase. |
| Identifier for exclusions | `wayId = layerId * 100000000 + OBJECTID` (a safe integer; statewide `OBJECTID` is under 200,000). Keep `cdotId: "<layer>/<OBJECTID>"` and `gisId` as strings for display and export. | Overpass supplies numeric ids; the exclusion set and its session round trip are known to work with numbers. The layer offset prevents collisions between 14 and 17. |
| Setting scope | Per browser (`localStorage`), not the session file. | Same reasoning as Stage 2: the session file is shared with others. |
| Exactly one non-Overpass source | Enabling CDOT disables the tiles source for new loads, and the other way round. The dialog says which is active. | Two live sources with different coverage semantics cannot both answer `fetchRoadNetworkForExtent`. |

Classification mapping (the one methodology table). **Approved by the project lead, November 13, 2026.** Any later change to it needs the lead's approval again and a note in the plan's progress log.

| Layer | Field | Leading digit or value | `highway` |
|---|---|---|---|
| 14 | `FUNCCLASSID` | `7` | `residential` |
| 17 | `FUNCCLASSID` | `2` | `trunk` (blocked) |
| 17 | `FUNCCLASSID` | `3` | `primary` |
| 17 | `FUNCCLASSID` | `4` | `secondary` |
| 17 | `FUNCCLASSID` | `5`, `6` | `tertiary` |
| 7 | `ACCESS_` starts with `F-W` | any | `motorway` (blocked) |
| 7 | `ACCESS_` starts with `E-X` | any | `trunk` (blocked) |
| 7 | `FUNCCLASS` | `1` | `motorway` (blocked) |
| 7 | `FUNCCLASS` | `2` | `trunk` (blocked) |
| 7 | `FUNCCLASS` | `3` | `primary` |
| 7 | `FUNCCLASS` | `4` | `secondary` |
| 7 | `FUNCCLASS` | `5`, `6` | `tertiary` |
| 7 | `FUNCCLASS` | `7` | `residential` |
| any | missing or unrecognised | | `unclassified`, counted in the load report |

For layer 7 the `ACCESS_` rows take precedence over `FUNCCLASS`.

## 5. Architecture

Two new files, one small edit set in `road-network.js`, one dialog, one menu entry. No change to `network-store.js`, `buildGraph`, snapping, or any module's analysis code.

### 5.1 `js/core/cdot-roads.js`, pure engine, `window.CdotRoads` (Haiku)

ES5, IIFE assigning to `window.CdotRoads`. No `turf`, `App`, `fetch`, DOM.

```js
CdotRoads.SERVICE = "https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer";
CdotRoads.PAGE_SIZE = 2000;
CdotRoads.LAYERS = {
  14: { name: "Local Roads",  outFields: "OBJECTID,GISID,ROUTENAME,FUNCCLASSID" },
  17: { name: "Major Roads",  outFields: "OBJECTID,GISID,ROUTENAME,FUNCCLASSID" },
  7:  { name: "Highways",     outFields: "OBJECTID,ROUTE,FUNCCLASS,ACCESS_,ROUTESIGN" }
};

// Full GET URL for one page. bbox = [w, s, e, n] in degrees. Parameters, in this
// order, URL-encoded: where=1=1, geometry=<w>,<s>,<e>,<n> (6 decimals),
// geometryType=esriGeometryEnvelope, inSR=4326, spatialRel=esriSpatialRelIntersects,
// outFields=<layer outFields>, outSR=4326, returnGeometry=true, returnZ=false,
// returnM=false, orderByFields=OBJECTID, resultOffset=<offset>,
// resultRecordCount=<PAGE_SIZE>, f=geojson.
// Throws for an unknown layerId or a non-finite bbox.
CdotRoads.pageUrl(layerId, bbox, offset)

// True when the server says more pages follow: page.exceededTransferLimit === true
// or (page.properties && page.properties.exceededTransferLimit === true).
CdotRoads.hasMore(page)

// Returns { ok: true } or { ok: false, error } for one parsed page:
// type === "FeatureCollection"; features is an array; every feature has
// geometry.type "LineString" or "MultiLineString"; every coordinate is a
// [number, number] with |lon| <= 180 and |lat| <= 90 (catches a response that
// came back in EPSG:26913 metres); every feature has properties.OBJECTID.
CdotRoads.validatePage(page)

// { highway, foot: "" } from the mapping table in section 4. Unknown -> "unclassified".
CdotRoads.classify(layerId, properties)

// Input: array of { layerId, features } (all pages of all layers, concatenated per layer).
// Dedupes by layerId + OBJECTID (a feature can appear in two pages if the server
// changes between requests; keep the first). Output:
// {
//   geojson: { type: "FeatureCollection", features: [...] },
//   report: { perLayer: { "14": n, "17": n }, unclassified: n, duplicates: n }
// }
// Each output feature: geometry copied as is; properties exactly:
//   { highway, foot: "", name: <ROUTENAME or ROUTE or "">, sidewalk: "", footway: "",
//     wayId: layerId * 100000000 + OBJECTID, cdotId: layerId + "/" + OBJECTID,
//     gisId: <GISID or "">, cdotClass: <the raw FUNCCLASSID or FUNCCLASS string>, layerId }
CdotRoads.toRoadGeoJSON(layerResults)
```

### 5.2 `js/core/cdot-source.js`, fetch and setting, `App.cdotSource` (Sonnet)

Loads after `network-store.js` and `cdot-roads.js`, before `road-network.js`.

```js
App.cdotSource = {
  isActive(): boolean,                       // setting says CDOT answers street requests
  layers(): number[],                        // e.g. [14, 17]
  setActive(on: boolean): void,              // persists; when turning on, also turns the tiles source off (section 5.3)
  setLayers(ids: number[]): void,            // persists; at least one of 14/17/7

  // Fetches every page of every selected layer for bbox [w,s,e,n].
  // progress(text) is called at least once per page with the text from section 7.
  // Resolves { ok: true, geojson, report } or { ok: false, error }. Never throws.
  // Rules: one AbortController with a 60 s timeout per page; stop on the first
  // non-2xx status, JSON parse error, validatePage failure, or when a layer
  // exceeds 50 pages (100,000 features: the extent is wrong); pages of one layer
  // are sequential; layers may run in parallel.
  fetchExtent(bbox, progress): Promise<{ok, geojson?, report?, error?}>,

  restore(): void   // reads localStorage "mat-cdot-source" {active, layers}; defaults inactive, [14, 17]
};
```

The setting object: `{ "active": false, "layers": [14, 17] }`. Every storage access in `try`/`catch`.

### 5.3 Integration in `js/core/road-network.js` (Sonnet, Opus review)

Add one private function and one public alias, plus branches. The planner first reads the local Stage 2 code to see where the tiles branch and the store guard ended up, then places these beside them.

```js
// Loads CDOT roads covering extentPolygon (Feature<Polygon>). Returns Promise<boolean>.
async function loadNetworkFromCdot(extentPolygon) {
  // 1. Same MAX_AREA_WARN_KM2 confirm as fetchNetworkForBounds (extract a shared
  //    helper only if trivially safe; otherwise duplicate the five lines).
  // 2. bb = turf.bbox(extentPolygon)
  // 3. res = await App.cdotSource.fetchExtent(bb, App.setStatus)
  //    if !res.ok: App.setStatus(<failure text>); return false
  //    if res.geojson.features.length === 0: App.setStatus(<no roads text>); return false
  // 4. _roadGeoJSON = res.geojson; rebuildNetwork();
  //    _downloadedBboxPolygon = extentPolygon;
  //    updateUI(true);
  //    persistNetwork("cdot:" + layersKey + ":" + extentCacheId(extentPolygon), "cdot", layersKey);
  //      where layersKey = App.cdotSource.layers().slice().sort().join("+"), e.g. "14+17"
  //    App.setStatus(<loaded text>); return true
}
App.loadRoadNetworkFromCdot = loadNetworkFromCdot;
```

Branch in `App.fetchRoadNetworkForExtent`, in this order:

```js
if (App.walkTilesSource && App.walkTilesSource.isActive()) return loadNetworkFromTiles(extentPolygon);   // Stage 2
if (App.cdotSource && App.cdotSource.isActive()) {
  if (await restoreNetworkCovering(extentPolygon)) return true;   // a stored CDOT network for this area is fine
  return loadNetworkFromCdot(extentPolygon);
}
if (await restoreNetworkCovering(extentPolygon)) return true;
// ...unchanged Overpass path
```

Store guard. Stage 2 rejects a stored record when the tiles source is active and `rec.source !== "walk-tiles"`. Generalise it into one rule in `restoreNetworkCovering`, after `findCovering` returns and before `loadStoredRecord`:

```js
// The record must come from the source that would be used for a fresh load.
var want = (App.walkTilesSource && App.walkTilesSource.isActive()) ? "walk-tiles"
         : (App.cdotSource && App.cdotSource.isActive()) ? "cdot" : "overpass";
if (rec && rec.source !== want) return false;
if (rec && want === "cdot" && rec.label !== layersKey) return false;
```

This also means a stored CDOT network is never restored while the user is in Overpass mode, which is new behaviour relative to Stage 2's edge case 10 and is the intended behaviour: the comparison is meaningless if sources swap silently. `loadStoredRecord` already restores the stored extent, so coverage checks keep working. The startup restore `restoreCachedNetwork()` (latest record, any source) is unchanged; its status line already says "restored from cache", and section 5.4 adds the source name.

Mutual exclusion: `App.cdotSource.setActive(true)` calls the tiles source's deactivation (whatever Stage 2 named it; if Stage 2 has only `clear()`, use that and say so in the dialog), and the tiles dialog's activation calls `App.cdotSource.setActive(false)`. The planner owns this edit because it touches both.

### 5.4 Module text (Haiku)

- `#wsDownloadBtn` label while CDOT is active: "Download CDOT streets for this area". Stage 2 already switches this label for tiles; extend the same switch.
- Coverage warning while CDOT is active: "Loaded CDOT streets don't cover this walk budget."
- After a successful run while the live network's source is CDOT, append " Streets: CDOT <layersKey>." to the success status, mirroring Stage 2's " Streets: FLM tiles <release_id>." To know the live network's source, `road-network.js` exposes `App.roadNetworkSource()` returning `"overpass" | "file" | "walk-tiles" | "cdot" | null`, set at each load tail and in `loadStoredRecord` from `rec.source`. This one small addition is in scope because both Stage 2 and this brief need it; if Stage 2 already added an equivalent, use that.
- Transit Travelshed: the coverage string only.

### 5.5 Add Data entry and dialog (Haiku markup, Sonnet wiring)

`index.html`, ONLINE block, immediately after `<button id="road-net-download">Area Roads for Street Routing</button>`: `<button id="ad-cdot-roads">CDOT Roads for Street Routing…</button>`.

Dialog `id="cdot-popup"`, same structure and classes as the dialog Stage 2 shipped. Body, top to bottom:

1. One sentence: "Street downloads will come from CDOT's public road layers instead of OpenStreetMap. CDOT layers contain road centerlines only: no sidewalks, paths or pedestrian bridges."
2. Checkbox `id="cdotLayer14"` "Local Roads (layer 14)" checked; `id="cdotLayer17"` "Major Roads (layer 17)" checked; `id="cdotLayer7"` "Highways (layer 7)" unchecked, followed by the line "Highway lines do not connect to local streets in this data. Turn on only to inspect them."
3. Toggle button `id="cdotUse"` with text "Use CDOT for street downloads" when inactive and "Using CDOT — switch back to OpenStreetMap" when active.
4. `<div id="cdotInfo">` showing, when active: the layers in use, "Per browser setting; not saved in the session file.", and if the tiles source was just turned off, "FLM tile source turned off."
5. Footer: × button `id="cdot-popup-close"`.

`js/app.js`: wire `#ad-cdot-roads` to open the dialog; add an `_adClrCfgs` entry `{ btnId: "ad-cdot-roads", isLoaded: () => App.cdotSource.isActive(), clear: () => App.cdotSource.setActive(false) }` with no eye; call `App.cdotSource.restore()` at startup next to Stage 2's `App.walkTilesSource.restore()`. Changing a checkbox calls `setLayers`; it does not reload any network. The next load uses the new layers.

## 6. What the lead sees, step by step

1. Add Data → CDOT Roads for Street Routing… → "Use CDOT for street downloads". The Add Data entry shows its × as active.
2. Walkshed: place a point, Calculate. The coverage check says "No street network loaded." and the button reads "Download CDOT streets for this area". Press it.
3. Status: "Downloading CDOT roads… layer 14 page 1", then "…layer 17 page 1", then "312 CDOT road segments loaded (layers 14+17) — local routing enabled". The dashed download outline appears, as for Overpass.
4. The walkshed runs; its status ends with " Streets: CDOT 14+17."
5. Open the dialog, "switch back to OpenStreetMap", press × on Area Roads, Calculate again: the button reads "Download streets for this area" and Overpass runs. The two walksheds can now be compared on the map or by export.

## 7. Exact user-facing text

| Situation | Text |
|---|---|
| Page in flight | `Downloading CDOT roads… layer <id> page <n>` |
| Loaded | `<n> CDOT road segments loaded (layers <layersKey>) — local routing enabled` |
| Loaded with unclassified features | append ` <u> segments had no recognised class and were treated as unclassified streets.` |
| Zero features | `No CDOT roads found in this area (layers <layersKey>).` |
| HTTP failure | `CDOT road download failed: layer <id> returned HTTP <status>` |
| Network or CORS failure (fetch rejects) | `CDOT road download failed: could not reach dtdapps.codot.gov (<message>)` |
| Bad page | `CDOT road download failed: layer <id> page <n>: <validatePage error>` |
| Page cap | `CDOT road download stopped: layer <id> exceeded 50 pages; the area is too large.` |
| Timeout | `CDOT road download failed: layer <id> page <n> timed out after 60 s` |
| Cancelled at area guard | `Road network download cancelled` (existing text) |
| Source turned on | `CDOT will supply streets for new downloads. Loaded streets stay until replaced.` |
| Source turned off | `OpenStreetMap will supply streets for new downloads.` |
| Restored from cache | existing text plus ` Source: CDOT <layersKey>.` or ` Source: OpenStreetMap.` |

## 8. Edge cases the cards must list

1. A page with exactly 2,000 features and `exceededTransferLimit` absent is the last page.
2. `exceededTransferLimit` present only under `properties` still means more pages.
3. The same `OBJECTID` on two pages of one layer is kept once; the report counts the duplicate.
4. A response whose coordinates exceed ±180/±90 fails `validatePage` (the server ignored `outSR`); nothing is loaded.
5. A layer that returns zero features while another returns some is fine; the report shows 0 for it.
6. All layers return zero features: no load, "No CDOT roads found" text, the previous network stays.
7. The user unchecks every layer: `setLayers` refuses and keeps the previous value; the dialog shows "Choose at least one layer."
8. Layer 7 is on: highway features load but join local streets only where endpoints happen to coincide; this is accepted and the dialog warned.
9. `FUNCCLASSID` of `"2  Principal Arterial - Fwys and Expwys"` maps to `trunk` and the feature is not walkable, by the existing rule, with `foot` empty.
10. The area guard fires for a very large extent exactly as for Overpass.
11. CDOT active and a stored Overpass network covers the extent: not restored; a CDOT download runs.
12. CDOT inactive and a stored CDOT network covers the extent: not restored; Overpass runs.
13. `localStorage` throws: the setting lives for the session only.
14. Turning CDOT on while the tiles source is active turns the tiles source off and says so.
15. A page request rejected by the browser for CORS surfaces as a `TypeError` from `fetch`; the text names the host, not "undefined".
16. `MultiLineString` geometry passes through unchanged.

## 9. Tests

Golden, `test/cases/cdot-roads.mjs` with `scripts: ["js/core/cdot-roads.js"]`. Fixture `test/fixtures/cdot/`: `page14-1.json` (3 Local Roads features, trimmed from a real response, with `exceededTransferLimit: true`), `page14-2.json` (2 features, no flag, one of them repeating an `OBJECTID` from page 1), `page17-1.json` (3 Major Roads features covering classes 3, 4 and 2, no flag), `page7-1.json` (2 Highways features, one with `ACCESS_` starting `F-W`). Cases:

1. `pageUrl(14, [-105.015, 39.74, -104.995, 39.755], 0)` → the exact string from section 5.1 with `resultRecordCount=2000`.
2. `pageUrl(14, [...], 2000)` → same with `resultOffset=2000`.
3. `hasMore(page14-1)` → `true`; `hasMore(page14-2)` → `false`; `hasMore({ type: "FeatureCollection", features: [], properties: { exceededTransferLimit: true } })` → `true`.
4. `validatePage(page14-1)` → `ok: true`; a copy with one coordinate `[500000, 4400000]` → `ok: false`.
5. `classify(14, { FUNCCLASSID: "7  Local" })` → `{ highway: "residential", foot: "" }`.
6. `classify(17, { FUNCCLASSID: "2  Principal Arterial - Fwys and Expwys" })` → `trunk`; class 3 → `primary`; 4 → `secondary`; 5 → `tertiary`; 6 → `tertiary`.
7. `classify(7, { FUNCCLASS: "3  Principal Arterial - Other", ACCESS_: "F-W: Interstate System, Freeway Facils" })` → `motorway` (ACCESS_ wins); `classify(7, { FUNCCLASS: "1  Interstate", ACCESS_: "" })` → `motorway`; `classify(7, { FUNCCLASS: "3  Principal Arterial - Other", ACCESS_: "R-B: Rural Highway" })` → `primary`.
8. `classify(14, {})` → `unclassified`.
9. `toRoadGeoJSON([{ layerId: 14, features: page14-1 ∪ page14-2 }, { layerId: 17, features: page17-1 }])` → 7 features (one duplicate dropped), `report.duplicates === 1`, `report.perLayer["14"] === 4`, the first feature has numeric `wayId === 1400000000 + OBJECTID`, `cdotId === "14/<OBJECTID>"`, `foot === ""`, and no `highway` value outside the mapping table.

Behaviour test, `test/browser/cdot-source.test.mjs`, modelled on `network-cache.test.mjs` (Opus writes or reviews). Use `page.route("https://dtdapps.codot.gov/**", …)` to answer from the fixture files by `resultOffset` and layer id in the URL. Steps and assertions: open the CDOT dialog, turn CDOT on; place a point inside the fixture's extent; run Walkshed at 5 minutes and 3.1 mph; assert two requests went to layer 14 and one to layer 17 and none to overpass-api.de; `App.roadNetworkLoaded()` is true; the status contains "CDOT road segments loaded (layers 14+17)"; `App.getRoadDownloadExtent()` contains the point; `App.roadNetworkSource() === "cdot"`; turn CDOT off, press × on Area Roads, run again and assert the next request goes to overpass-api.de (routed to a stub). A second test makes the layer 14 route return HTTP 503 and asserts the "returned HTTP 503" text and that no network is loaded.

Manual comparison by the lead, recorded in a table the Phase 5 write-up fills in. Origins and speed from FLM decision 0012 (2.8 mph; 5, 10, 15 minutes):

| Origin | Source | Reached segments | Walkshed area | Notes |
|---|---|---|---|---|
| D01 Union Station -105.0004685, 39.7529095 | OSM / CDOT 14+17 | | | downtown, footway-heavy |
| C01 Commerce City -104.9430570, 39.8263610 | OSM / CDOT 14+17 | | | |
| G01 Greeley | OSM / CDOT 14+17 | | | |
| B01 Broomfield | OSM / CDOT 14+17 | | | |
| F01 Fraser | OSM / CDOT 14+17 / CDOT 14+17+7 | | | US 40 is in layer 7 only |
| D02 Sloan's Lake -105.0490000, 39.7480000 | both | | | must report no streets within snapping distance on both |

Reached-segment counts come from the walkshed's own status or export; the planner names where in the existing UI the lead reads them.

## 10. Phases and classes

| Phase | Class | Content | Done when |
|---|---|---|---|
| 0 | Lead | Classification table approved November 13, 2026 (done). Remaining: send the terms-of-use question to CDOT GIS staff; this does not block Phases 1 to 4 | Question sent and noted in the plan's progress log |
| 1 | Haiku, high effort | `js/core/cdot-roads.js`, fixtures, `test/cases/cdot-roads.mjs`, seeded golden | `node test/run-golden.mjs cdot` PASS; full golden run still passes |
| 2 | Haiku, high effort | Markup only: menu button, dialog, `<script>` tags in load position | Page loads clean; dialog opens and closes with no behaviour |
| 3 | Sonnet | `js/core/cdot-source.js`: setting, `fetchExtent` with paging, progress and timeouts; dialog wiring | Against the live service from `localhost`: a Union Station extent loads 14 and 17 and the status text matches section 7; a 503 simulated with DevTools request blocking produces the failure text |
| 4 | Sonnet, Opus review | `road-network.js` branch, generalised store guard, `App.roadNetworkSource()`, mutual exclusion with tiles, module strings, `app.js` entries | Behaviour tests pass; `network-cache.test.mjs`, `street-exclusion.test.mjs` and Stage 2's `walk-tiles.test.mjs` still pass; the lead completes the section 9 table at D01 and F01 |
| 5 | Opus | `docs/reference/road-network.md` section "CDOT road layers", `CLAUDE.md` file map and load order, progress log, `features.md`, and a one-page comparison write-up with the section 9 table and the Fraser finding | Review gate per `AGENTS.md` |

Phase 4 touches `road-network.js` and the store guard, both importer territory; the planner reviews that diff line by line and re-runs every browser test that loads a network, including from GitHub Pages once deployed, which is the first real check of the CORS behaviour.

## 11. Out of scope

- Splitting or snapping Highways (layer 7) to local streets.
- Merging CDOT streets with OSM footways (section 4 explains why this is a design task of its own).
- Sidewalk inference, crossing rules, or any change to `isPedForbidden`.
- Frontage Roads, Ramps or any other CDOT layer.
- Storing the setting in the session file; storing CDOT networks differently from other networks.
- Any change to `network-store.js`, the walkshed algorithm, or the FLM repository.

## 12. Reporting to the project lead

At the end of each phase: what was built, what the lead should click, what passed, what failed, what was not run, and the one decision needed next, in plain language. Where this brief and the code disagree, the code wins and the disagreement is reported, not silently resolved. The Phase 5 write-up must state plainly which of the section 2 facts were re-confirmed from inside the browser and which were not.
