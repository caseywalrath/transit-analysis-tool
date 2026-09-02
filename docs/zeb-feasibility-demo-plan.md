# Route Electrification Feasibility — RFP Task 3 demo

Implementation plan. Written to be followed step by step by an implementing
agent; each step names the exact file, function, and pattern to copy. Read
`CLAUDE.md` first — every convention referenced below (module registration,
`App.renderModuleState`, `App.renderModuleInputs`, the `.rf-` shared classes,
golden tests, the screenshot harness) is documented there.

---

## Purpose and non-goals

This builds an **illustrative demo** of the interactive mapping tool described in
Task 3 of the CDOT "Colorado Transit Zero-Emission Route Optimization" RFP. It
exists to produce one or two screenshots for a proposal and to demonstrate that
the team can deliver the tool on this architecture (static site, no backend, no
recurring license, ownership transfers as a folder).

The seven Task 3 requirements and how this plan meets each:

| RFP requirement | How the demo meets it |
|---|---|
| Filter by agency, route, vehicle size | Settings column: Agency, Route, Vehicle class (filter **and** assumption) |
| Route paths color-coded by depot-electrification feasibility tier | `zeb-routes-layer` line layer, 5 tiers via `App.choropleth.buildStepColorExpr` |
| kWh per vehicle block and required battery capacity | Ranked table + expanded rows + Block Detail SoC chart |
| Winter climate overlay reducing depot-only range | "Winter Range Impact" reference overlay + Season toggle that re-tiers instantly |
| Transit provider of each route | Agency badge in the table, hover popup, and Agency filter (from `agency.txt`) |
| Enviroscreen 2.0 Disproportionately Impacted Community layer | "DI Communities" overlay computed live from ACS through the existing census pipeline |
| Utility provider layer | "Utility Service Territories" reference overlay (bundled polygons) |
| CDOT staff can upload future GTFS | The existing Add Data → GTFS Feed path; the demo dataset loads through exactly that path |

**Non-goals.** No statewide scale, no server, no real elevation or weather data,
no ArcGIS. Do not add new CDN libraries. Do not build a separate "Feed Manager"
module. Do not label anything in the UI as synthetic or demo — that is handled
by captions outside the app. Do not touch Route Costing, Trip Builder, or any
existing module's behavior.

**What is real vs. assumed.** Route geometry, stops, agencies, trip times, and
block reconstruction come from the real GTFS feeds. The energy model is a
transparent set of constants in one data file (`data/zeb/zeb-demo-data.js`).
Grade class per route, climate zones, depot locations, and utility territories
are hand-entered approximations in that same file.

---

## Prerequisites

1. **The two GTFS feeds must be in the repo** before Step 0 can run:
   - `data/gtfs/avon-co-us.zip` — **Avon Transit** (Town of Avon, Eagle County).
     Not All Points Transit (Montrose), which is a different agency; if a file
     named `allpointstransit-co-us.zip` turns up, it is the wrong feed. Trillium
     publishes the Avon feed under its own slug; whatever the downloaded file is
     called, commit it at this exact path.
   - `data/gtfs/greeleyevans-co-us.zip` — Greeley-Evans Transit, via Trillium.

   Before Step 0, open each zip's `agency.txt` and confirm `agency_name` reads
   Avon Transit and Greeley-Evans Transit respectively. Stop and report if not.

   The cloud sandbox cannot reach `data.trilliumtransit.com` (proxy returns 403
   on CONNECT). If the files are absent, stop and report that; do not fabricate
   feeds. Every other step except Step 0 and the per-route override map in
   Step 3 can be built and unit-tested without the feeds.
2. Branch: `claude/rfp-task-3-demo-tbwkxg`. Commit after each step with a
   descriptive message. Run `node test/run-golden.mjs` before every commit that
   touches `js/core/zeb-model.js`.
3. Tools available without npm: Node (built-ins only), Python 3 stdlib,
   Playwright's Chromium at `/opt/pw-browsers/chromium` for the harness.

---

## Files

New:

| Path | Purpose |
|---|---|
| `tools/merge-gtfs.py` | Python-stdlib script: merges the two feeds into one prefixed zip |
| `data/gtfs/colorado-demo-gtfs.zip` | Output of the merge script (committed) |
| `data/zeb/zeb-demo-data.js` | `window.ZebDemoData` — vehicle classes, climate zones, agency defaults, depots, per-route overrides, tier definitions |
| `data/zeb/zeb-overlay-data.js` | `window.ZebOverlayData` — climate-zone and utility-territory GeoJSON |
| `js/core/zeb-model.js` | `window.ZEB` — pure calculation engine (no DOM/map/turf), golden-tested |
| `js/projects/zeb-overlays.js` | The three reference overlays (winter, DI, utility) + Add Data wiring |
| `js/projects/zeb-feasibility.js` | The analysis module |
| `projects/zeb-feasibility-popup.html` | Popup body |
| `projects/zeb-feasibility-legend.html` | Tier legend fragment |
| `projects/zeb-winter-legend.html`, `projects/zeb-di-legend.html`, `projects/zeb-utility-legend.html` | Overlay legends |
| `test/cases/zeb-model.mjs` + `test/golden/zeb-model.json` | Golden cases |

Modified:

| Path | Change |
|---|---|
| `js/projects/gtfs.js` | Add `App.getGTFSData()` accessor and `App.notifyProject()` on load/clear |
| `index.html` | Script tags; three ONLINE buttons in the Add Data dropdown |
| `js/app.js` | Three `_adClrCfgs` entries for the overlay buttons |
| `js/core/layers-panel.js` | REFERENCE entries for overlays; ANALYSIS entry for the module |
| `css/style.css` | `.zeb-` styles (tier pills, SoC chart, assumptions block) |
| `test/ui-screens/capture.mjs` | Add `zeb-feasibility` to `MODULE_IDS` and `ADAPTIVE_PANEL_WIDTHS` |
| `CLAUDE.md` | File Structure, Script Load Order, Active modules, App namespace entries |

Script load order additions to `index.html`:

```
js/core/travelshed.js        (existing)
js/core/zeb-model.js         (NEW — core block, no deps; defines window.ZEB)
...
js/app.js                    (existing)
data/zeb/zeb-demo-data.js    (NEW — right after app.js, before the modules)
data/zeb/zeb-overlay-data.js (NEW)
js/projects/gtfs.js          (existing — must load BEFORE zeb-feasibility.js)
js/projects/zeb-overlays.js  (NEW — after gtfs.js)
js/projects/zeb-feasibility.js (NEW — after zeb-overlays.js)
```

Note `gtfs.js` currently loads near the end of the module list. Move the two
new module tags to **after** `gtfs.js` rather than moving `gtfs.js`.

---

## Step 0 — Consolidated demo feed (`tools/merge-gtfs.py`)

Python 3, stdlib only (`zipfile`, `csv`, `io`). Usage:

```bash
python3 tools/merge-gtfs.py \
  --feed AVN=data/gtfs/avon-co-us.zip \
  --feed GET=data/gtfs/greeleyevans-co-us.zip \
  --out data/gtfs/colorado-demo-gtfs.zip
```

Behavior:

1. For each `CODE=path`, read every `.txt` in the zip (handle a top-level
   subfolder the same way `gtfs.js loadGTFSFile` does: strip the folder prefix).
2. Prefix every id column with `CODE_`: `route_id`, `trip_id`, `stop_id`,
   `shape_id`, `service_id`, `block_id`, `fare_id`, `zone_id`, `parent_station`,
   `from_stop_id`, `to_stop_id`, `origin_id`, `destination_id`, `contains_id`.
   Only prefix a value when it is non-empty.
3. `agency.txt`: if a feed's `agency_id` is blank, set it to `CODE`; otherwise
   prefix it. Write the same value into every `routes.txt` row's `agency_id`
   (fill blank ones — GTFS allows blank `agency_id` when a feed has one agency).
4. Concatenate rows per filename across feeds, unioning the header columns
   (missing cells blank). Preserve column order of first appearance.
5. Write a single `feed_info.txt`:
   `feed_publisher_name=Colorado Statewide GTFS Database`,
   `feed_publisher_url=https://www.codot.gov`, `feed_lang=en`,
   `feed_version=<YYYYMMDD of run>`. Drop the source feeds' `feed_info.txt`.
6. Print a summary: per feed, the row counts of routes/trips/stops/shapes and
   whether `block_id` is populated in `trips.txt` (count of non-blank values).
   **Record that block_id finding in the commit message** — Step 1's chaining
   fallback depends on it.

Commit the script and the output zip. Then load the zip in the browser via
Add Data → GTFS Feed and confirm both agencies draw (Avon near lon −106.52,
lat 39.63; Greeley near lon −104.71, lat 40.42).

---

## Step 1 — Pure engine (`js/core/zeb-model.js`)

Same file convention as `js/core/travelshed.js`: an IIFE that defines
`window.ZEB`, plain JSON in and out, **no** `App`, `turf`, DOM, or map access.
Every function below is golden-tested in Step 8, so keep them deterministic and
argument-only.

```js
(function () {
  "use strict";
  var ZEB = window.ZEB = window.ZEB || {};
  // ...functions...
})();
```

### 1.1 `ZEB.parseGtfsTime(hhmmss) → minutes | null`

`"25:30:00"` → 1530 (hours past 24 are valid in GTFS). Blank/malformed → null.

### 1.2 `ZEB.pickRepresentativeService(calendarRows, calendarDateRows, tripRows) → { serviceId, tripCount, reason }`

Choose the service day to model:

1. Candidate = every `service_id` with `monday..friday` all `"1"` in
   `calendar.txt`. Among candidates, pick the one with the most trips in
   `tripRows`.
2. If no weekday candidate, pick the `service_id` with the most trips overall
   (`reason: "most-trips"`).
3. If `tripRows` is empty, return `{ serviceId: null, tripCount: 0, reason: "no-trips" }`.

Called **per agency** by the module (it partitions trips by the route's
`agency_id` first), so Avon and Greeley each get their own representative day.

### 1.3 `ZEB.buildBlocks(trips, opts) → Block[]`

Input trips are pre-digested by the module (Step 5.3):

```js
{ tripId, routeId, serviceId, blockId, shapeId,
  startMin, endMin, firstStopId, lastStopId,
  firstStop: [lon, lat], lastStop: [lon, lat], miles }
```

`opts = { maxLayoverMin: 30, terminalToleranceMi: 0.3 }`.

Algorithm:

- If **every** trip has a non-blank `blockId`, group by `serviceId + "|" + blockId`
  (`method: "block_id"`).
- Otherwise greedy chaining (`method: "chained"`): sort trips by `startMin`;
  for each unassigned trip start a block; loop: find the earliest unassigned
  trip with the same `serviceId`, `startMin >= block.endMin`,
  `startMin - block.endMin <= maxLayoverMin`, and whose `firstStop` is within
  `terminalToleranceMi` of the block's current `lastStop` (use an inline
  equirectangular distance — no turf). Append and continue until none found.

Output block:

```js
{ blockId, serviceId, method, tripIds: [], routeIds: [] /* unique, in order */,
  revenueMiles, startMin, endMin, spanHours,
  firstStop: [lon, lat], lastStop: [lon, lat], trips: [ /* the input trips */ ] }
```

Sort output by `startMin` then `blockId`.

### 1.4 `ZEB.deadheadMiles(depot, block, circuity) → { out, back, total }`

Straight-line miles depot→`block.firstStop` and `block.lastStop`→depot, each
multiplied by `circuity` (default 1.3). Inline haversine.

### 1.5 `ZEB.energyForBlock(block, params) → EnergyResult`

```js
params = {
  vehicle:      { id, label, batteryKWh, baseKWhPerMi },
  gradeFactor:  1.0 | 1.12 | 1.30,
  seasonFactor: 1.0 ... 1.45,
  socBuffer:    0.20,
  chargerKW:    150,
  chargerEff:   0.90,
  deadheadMiles: { out, back, total }   // from 1.4
}
```

Compute:

```
totalMiles      = block.revenueMiles + deadheadMiles.total
kWhPerMi        = vehicle.baseKWhPerMi * gradeFactor * seasonFactor
blockKWh        = totalMiles * kWhPerMi
requiredKWh     = blockKWh / (1 - socBuffer)
ratio           = requiredKWh / vehicle.batteryKWh
endSoc          = 1 - blockKWh / vehicle.batteryKWh        // may go negative
rechargeHours   = blockKWh / (chargerKW * chargerEff)
overnightHours  = 24 - block.spanHours
rechargeFits    = rechargeHours <= overnightHours
```

Return all of the above plus `totalMiles`, `kWhPerMi`, and the inputs echoed.
Round nothing here; formatting happens in the module.

### 1.6 `ZEB.tierFor(ratio, rechargeFits, tiers) → { tier, label, reason }`

`tiers` is `ZebDemoData.tiers` (Step 3) — an ordered array of
`{ tier, label, maxRatio, color, reason }`. Walk it: the first entry with
`ratio <= maxRatio` wins; the last entry has `maxRatio: Infinity`. Then, if
`rechargeFits === false` and the chosen tier is better than tier 4, return tier
4 with `reason` set to the tier-4 entry's `rechargeReason`. Default tiers:

| tier | label | maxRatio | meaning |
|---|---|---|---|
| 1 | Ready today | 0.75 | Block uses ≤ 75% of the buffered battery |
| 2 | Feasible with margin | 0.90 | |
| 3 | Marginal | 1.00 | Exactly meets the 20% buffer |
| 4 | Needs midday charging | 1.60 | Depot-only fails; one opportunity charge would close the gap |
| 5 | Not feasible depot-only | ∞ | |

### 1.7 `ZEB.scoreFor(ratio) → integer 0..100`

`clamp(round(100 * (1.5 - ratio)), 0, 100)`. Ratio 0.5 → 100, 1.0 → 50, 1.5 → 0.

### 1.8 `ZEB.summarizeRoute(routeId, blockResults) → RouteSummary`

`blockResults` is the array of `{ block, energy, tier }` for every block whose
`routeIds` contains `routeId`. The route is governed by its **worst block**
(highest `ratio`): return

```js
{ routeId, blockCount, governingBlockId, ratio, tier, label, score,
  blockKWh, requiredKWh, revenueMiles /* governing block */, longestBlockMiles,
  reason }
```

Empty input → `{ routeId, blockCount: 0, tier: null, ... }` (the module shows
"No trips on the modeled service day").

### 1.9 `ZEB.socProfile(block, energy, params) → [{ min, soc, label }]`

Points for the Block Detail chart: start at `{ min: block.startMin - deadhead-out
minutes, soc: 1.0 }` (assume 15 mph deadhead speed for the time axis), then
one point at the end of each trip with SoC reduced by that trip's share
(`trip.miles / totalMiles * blockKWh / batteryKWh`), then the deadhead-back
point. `label` is the trip's `routeId` or `"deadhead"`.

### 1.10 Test hook

Not needed — everything is on `window.ZEB`.

---

## Step 2 — GTFS accessor (`js/projects/gtfs.js`)

Two small additions, nothing else:

1. Next to the `App.gtfsData = _gtfsData;` line at the bottom, add
   `App.getGTFSData = function () { return _gtfsData; };` and
   `App.getGTFSShapesFC = function () { return _shapesFC; };`
   (`_shapesFC` already holds the built LineString FeatureCollection with
   `route_id`/`agency_id` props merged in — reuse it, do not rebuild shapes).
2. At the end of `applyGtfsData()` and `clearGTFS()`, call
   `if (typeof App.notifyProject === "function") App.notifyProject();` so the
   feasibility module's `update()` fires when a feed loads or clears.

Update the `App.gtfsData` note in `CLAUDE.md` to point at the new accessor.

---

## Step 3 — Data files

### 3.1 `data/zeb/zeb-demo-data.js`

```js
window.ZebDemoData = {
  vehicleClasses: {
    bus40:   { id: "bus40",   label: "40-ft BEB",   batteryKWh: 440, baseKWhPerMi: 2.10 },
    cutaway: { id: "cutaway", label: "Cutaway BEB", batteryKWh: 150, baseKWhPerMi: 1.15 }
  },
  charger: { kW: 150, efficiency: 0.90 },
  socBuffer: 0.20,
  blockChaining: { maxLayoverMin: 30, terminalToleranceMi: 0.3 },
  deadheadCircuity: 1.3,
  gradeClasses: {
    flat:     { label: "Flat",     factor: 1.00 },
    rolling:  { label: "Rolling",  factor: 1.12 },
    mountain: { label: "Mountain", factor: 1.30 }
  },
  seasons: {
    summer: { label: "Summer" },
    winter: { label: "Winter" }
  },
  climateZones: {
    plains:   { label: "Front Range plains", janMeanLowF: 13, factors: { summer: 1.05, winter: 1.30 } },
    mountain: { label: "Mountain valley",    janMeanLowF: 5,  factors: { summer: 1.00, winter: 1.45 } }
  },
  agencies: {
    // keys = agency_id values written by tools/merge-gtfs.py
    AVN: { label: "Avon Transit", climateZone: "mountain", gradeClass: "mountain",
           defaultVehicleClass: "cutaway",
           depot: { name: "Avon Regional Transit Facility", coords: [-106.505, 39.640] } },
    GET: { label: "Greeley-Evans Transit", climateZone: "plains", gradeClass: "flat",
           defaultVehicleClass: "bus40",
           depot: { name: "GET Operations Center", coords: [-104.700, 40.430] } }
  },
  // Per-route overrides keyed by prefixed route_id (e.g. "AVN_1"). Fill in after
  // the merged feed exists and you have looked at the route list. Any field may
  // be omitted; the agency default applies.
  routeOverrides: {
    // "GET_3": { vehicleClass: "cutaway" },
    // "AVN_2": { gradeClass: "rolling" }
  },
  tiers: [
    { tier: 1, label: "Ready today",              maxRatio: 0.75,     color: "#1a9850", reason: "Worst block uses at most 75% of the battery after the 20% safety buffer." },
    { tier: 2, label: "Feasible with margin",     maxRatio: 0.90,     color: "#91cf60", reason: "Worst block fits within the buffered battery with 10–25% margin." },
    { tier: 3, label: "Marginal",                 maxRatio: 1.00,     color: "#fee08b", reason: "Worst block only just meets the 20% buffer; small changes tip it over." },
    { tier: 4, label: "Needs midday charging",    maxRatio: 1.60,     color: "#fc8d59", reason: "Depot-only charging fails; a single opportunity charge would close the gap.",
      rechargeReason: "Block energy fits, but it cannot be recharged at 150 kW in the overnight window." },
    { tier: 5, label: "Not feasible depot-only",  maxRatio: Infinity, color: "#d73027", reason: "Required capacity exceeds 160% of the available battery." }
  ],
  di: {   // Disproportionately Impacted community proxy (Step 7)
    minorityShareMin: 0.40,
    povertyShareMin:  0.25,   // <100% FPL proxy for Enviroscreen's ≥40% <200% FPL criterion
    acsYear: "2023"
  }
};
```

Depot coordinates are approximations placed near each agency's operations
base; the user may adjust them.

### 3.2 `data/zeb/zeb-overlay-data.js`

`window.ZebOverlayData = { climateZones: FeatureCollection, utilities: FeatureCollection }`.

Climate zone polygons (properties `{ zone: "mountain"|"plains", label }`):

- `mountain`: rectangle lon −107.00…−106.00, lat 39.30…39.90
- `plains`: rectangle lon −105.10…−104.30, lat 40.10…40.70

Utility territory polygons (properties `{ utility, type: "IOU"|"co-op", color }`):

- Holy Cross Energy (co-op, `#805ad5`): lon −106.80…−106.20, lat 39.50…39.80
- Xcel Energy (IOU, `#dd6b20`): lon −104.80…−104.64, lat 40.37…40.47
- Poudre Valley REA (co-op, `#3182ce`): outer ring lon −104.95…−104.50, lat 40.28…40.56 **with the Xcel rectangle as an inner ring (hole)**

Use plain rectangles as `Polygon` coordinates; these are illustrative service
areas, not official boundaries. Coordinates rounded to 3 decimals.

---

## Step 4 — Reference overlays (`js/projects/zeb-overlays.js`)

Pattern: `js/core/map.js toggleMuniBoundaries` for add/remove, `gtfs.js` for
"a module wires its own Add Data buttons". Expose:

```js
App.zebOverlays = {
  toggle(id, show),      // id: "winter" | "utility" | "di"
  isActive(id),          // bool
  setVisible(id, bool),  // layout visibility only
  clearAll()
};
```

Layers (all added **before** `"gtfs-shapes-layer"` when present, else before
`firstUserLayer()` as in gtfs.js, so drawn features and GTFS stay on top):

| id | source | style |
|---|---|---|
| `zeb-winter-fill` | `zeb-winter` | fill; color by `zone` — mountain `#2b6cb0` @0.20, plains `#63b3ed` @0.14 |
| `zeb-winter-line` | same | 1px dashed `#2b6cb0` |
| `zeb-utility-fill` | `zeb-utility` | fill `["get","color"]` @0.10 |
| `zeb-utility-line` | same | 1.5px `["get","color"]` |
| `zeb-utility-label` | same | symbol, `text-field: ["get","utility"]`, size 12 |
| `zeb-di-fill` | `zeb-di` | fill `#6b46c1` @0.35 (Step 7 supplies the data) |
| `zeb-di-line` | same | 0.8px `#6b46c1` @0.6 |

Hover on `zeb-winter-fill`: popup "Winter range impact — Mountain valley:
≈31% less range (Jan mean low 5 °F)". Compute the percentage as
`1 − 1/winterFactor` from `ZebDemoData.climateZones`.

Each `toggle(id, true)` also calls
`App.popup.showFloatingWidget("zeb-<id>-legend", "projects/zeb-<id>-legend.html", { position: "bottom-right", width: 200, title })`
and `toggle(id, false)` hides it. Legend fragments reuse `.tpi-legend-panel`
/ `.tpi-legend-row` / `.tpi-legend-swatch` exactly like
`projects/corridor-scoring-legend.html`.

**`index.html`** — add three buttons to the ONLINE section of
`#add-data-dropdown`, after `#muni-boundaries-btn`:

```html
<button id="zeb-winter-btn">Winter Range Impact</button>
<button id="zeb-di-btn">Disproportionately Impacted Communities</button>
<button id="zeb-utility-btn">Utility Service Territories</button>
```

Wire clicks inside `zeb-overlays.js` (toggle + `add-data-active` class + hide
dropdown), same as gtfs.js wires `#gtfs-load-btn`.

**`js/app.js`** — add three `_adClrCfgs` entries modeled on the
`muni-boundaries-btn` entry (`isLoaded` → `App.zebOverlays.isActive(id)`,
`clear` → `toggle(id,false)` + remove the button's active class, `hasEye:true`,
`isVisible`/`setVisible` on the `-fill` layer).

**`js/core/layers-panel.js`** — three REFERENCE entries after
`osm-poi-layer`: labels "Winter range impact", "DI communities", "Utility
territories", each listing its fill/line layers and `clear` calling
`App.zebOverlays.toggle(id,false)`.

The DI overlay's `toggle("di", true)` calls `App.zebComputeDI()` (Step 7) and
renders whatever it returns; while the fetch runs, `App.setStatus("Computing DI communities…")`.

---

## Step 5 — The analysis module (`js/projects/zeb-feasibility.js`)

Copy the skeleton of `js/projects/corridor-scoring.js` (module-local state,
`isPopupVisible()`, `setStatus`, `emptyHint`, `markStale`, `inputsSummary`,
`renderInputs`, ranked table with expandable rows, line-layer coloring,
legend, exports, session persistence, `clearAll`) and the popup shell of
`projects/corridor-scoring-popup.html` **minus** the weights modal. Do not
keep any Census/TPI code.

Registration:

```js
App.registerModule({
  id: "zeb-feasibility",
  name: "Route Electrification Feasibility",
  enabled: true,
  popupWidth: 1000,
  panelWidths: { setup: 600, results: 600 },   // must stay equal and ≤ 620
  popupHTML: "projects/zeb-feasibility-popup.html",
  init, onOpen, onClose, clear: clearAll, update
});
```

It lands in the toolbar's **Transit Planning** group automatically
(`buildAnalysisButtonsHTML()` alphabetizes non-system modules).

### 5.1 Popup body (`projects/zeb-feasibility-popup.html`)

All ids use the `zeb` prefix. Settings column, in this order (matches the
"Analysis input order" convention: selection → study parameters → module
settings → advanced):

```
data-input-group="selection"
  Section title: Filter
  Agency        <select id="zebAgency">      All agencies + one per agency.txt row
  Route         <select id="zebRoute">       All routes + routes of the chosen agency
  Vehicle class <select id="zebVehicleFilter">  All classes | 40-ft routes | Cutaway routes
data-input-group="assumptions"
  Section title: Scenario
  Vehicle assumption <select id="zebVehicleAssume">  Per route (assigned) | All routes as 40-ft BEB | All routes as cutaway BEB
  Season        <select id="zebSeason">      Summer | Winter (default Winter)
  <details id="zebAssumptions"> summary "Assumptions"
     40-ft battery (kWh)        #zebBat40      440
     40-ft base kWh/mi          #zebBase40     2.10
     Cutaway battery (kWh)      #zebBatCut     150
     Cutaway base kWh/mi        #zebBaseCut    1.15
     Depot charger (kW)         #zebChargerKW  150
     SoC safety buffer (%)      #zebSocBuffer  20
     Max layover for chaining (min) #zebLayover 30
     <a id="zebResetAssumptions">Reset to defaults</a>
data-input-group="overlays"
  Section title: Map overlays
  [ ] Winter range impact   #zebOvWinter   → App.zebOverlays.toggle("winter", checked)
  [ ] DI communities        #zebOvDI
  [ ] Utility territories   #zebOvUtility
.module-input-actions
  <button id="zebRunBtn" class="rf-action-primary">Score Routes</button>
  <label id="zebHideRow" class="tpi-toggle-row" style="display:none"><input type="checkbox" id="zebHideColoring"> Hide route coloring</label>
```

Results column: `#zebStatus.rf-status` pill, a `#zebFeedBar` one-line feed
summary ("Colorado Statewide GTFS Database · 2 agencies · 14 routes · feed
version 20260902" read from `agency.txt`/`routes.txt`/`feed_info.txt`), a
`#zebSummaryStrip` (one small count tile per tier, colored by tier), the
`#zebResultsTable`, export buttons (`#zebExportCSV`, `#zebExportGeoJSON`), a
`tiny u-muted` methods note ("Routes are graded by their most demanding
vehicle block under depot-only charging with a 20% state-of-charge buffer."),
and `#zebEmptyState.rf-info-box`.

Empty state when **no GTFS is loaded** must contain a primary button
`#zebLoadDemoBtn` "Load statewide GTFS database" that does:

```js
fetch("data/gtfs/colorado-demo-gtfs.zip")
  .then(r => r.blob())
  .then(blob => App.loadGTFSFile(blob));   // JSZip accepts a Blob
```

with the `.rf-state-action` line "or use Add Data (+) → GTFS Feed to load your own."
(`loadGTFSFile` uses `App.setStatus`; the module's `update()` will fire via
Step 2's `notifyProject` and re-render.)

### 5.2 Module-local state

```js
var _settings = { agency: "all", route: "all", vehicleFilter: "all",
                  vehicleAssume: "route", season: "winter",
                  assumptions: {...defaults from ZebDemoData...},
                  overlays: { winter: false, di: false, utility: false } };
var _prepared = null;   // digest of the loaded feed (5.3), rebuilt on update()
var _lastResult = null; // { routes: RouteSummary[], blocks, params, settings }
var _stale = false, _running = false, _initialized = false;
```

### 5.3 Feed digest (`prepareFeed()`)

Runs once per loaded feed (cache by `App.getGTFSData()` identity). Uses
`turf.length` for shape miles — this is the only turf use, and it stays in the
module, not the engine.

1. `data = App.getGTFSData()`; bail if null or missing `trips.txt`/`stop_times.txt`/`routes.txt`.
2. Agencies: `agency.txt` rows → `{ agency_id, agency_name }`; if a route's
   `agency_id` is blank and there is exactly one agency, assign it.
3. Shape miles: for each feature in `App.getGTFSShapesFC()`, `turf.length(f, {units:"miles"})` keyed by `shape_id`.
4. Stops: `stop_id → [lon, lat]` from `stops.txt`.
5. Per trip from `stop_times.txt` (group by `trip_id`, min/max by `stop_sequence`
   parsed as int): `startMin` (first `departure_time` or `arrival_time` via
   `ZEB.parseGtfsTime`), `endMin` (last arrival), `firstStopId`, `lastStopId`,
   and `miles` = shape miles if `shape_id` known, else sum of straight-line
   stop-to-stop distances across the trip's stops (turf.distance).
6. Group trips by agency (via route). For each agency,
   `ZEB.pickRepresentativeService(calendar rows, calendar_dates rows, agency trips)`
   and keep only that service's trips.
7. `blocks = ZEB.buildBlocks(agencyTrips, ZebDemoData.blockChaining)` per agency;
   concatenate.
8. Route index: `route_id → { route_id, short, long, agency_id, agency_name, color, shapeIds:Set }`.

Store `_prepared = { agencies, routes, blocks, shapeMiles, method }` and show
in `#zebFeedBar` whether blocks came from `block_id` or were chained.

### 5.4 Scoring (`runScoring()`)

Pure orchestration over the engine:

1. Read settings from the DOM into `_settings`.
2. For each block: agency cfg = `ZebDemoData.agencies[agency_id]`; vehicle =
   per `_settings.vehicleAssume` ("route" → the block's **first** route's
   assigned class: `routeOverrides[route].vehicleClass || agency.defaultVehicleClass`);
   grade = `routeOverrides[route].gradeClass || agency.gradeClass`; season factor
   = `climateZones[agency.climateZone].factors[_settings.season]`; deadhead =
   `ZEB.deadheadMiles(agency.depot.coords, block, circuity)`; energy =
   `ZEB.energyForBlock`; tier = `ZEB.tierFor`.
3. For each route: `ZEB.summarizeRoute(routeId, blocksTouchingRoute)`; attach
   `assignedClass`, `agency`, `score`.
4. Apply the **filters** (agency, route, vehicle class) to decide which routes
   are *shown* in the table and map — scoring always covers everything so
   switching a filter is instant and never re-runs.
5. Sort shown routes by `ratio` ascending (best first), render, color the map,
   show the legend, collapse inputs via `renderInputs(true)` +
   `App.popup.setLayoutMode("results")` — on success only.

Any change to a Filter/Scenario control after a run calls `runScoring()`
directly (it is synchronous and cheap) rather than marking stale; keep
`markStale()` only for `update()` when the feed changes.

### 5.5 Ranked table

Columns (fit 600 px; use a `.zeb-results-table` grid with `overflow-x:auto`):
Route (short name, long name muted below, agency badge `.cs-feature-badge`),
Class (40-ft / Cutaway), Blocks, Worst block mi, Block kWh, Req. kWh, Tier
pill (`.zeb-pill.zeb-tier-N`, colored from `ZebDemoData.tiers`), caret.

Expanded row (`.cs-row-details` pattern):

- Rationale sentence: `tier.reason`, then "Governing block AVN_12: 148 revenue mi + 6 mi deadhead × 1.15 kWh/mi × 1.30 grade × 1.45 winter = 332 kWh; required 415 kWh vs 150 kWh available (ratio 2.77). Score 0/100."
- Overnight recharge line: "Recharge at 150 kW: 2.5 h of 9.8 h available."
- Blocks mini-table: block id, trips, span (HH:MM–HH:MM), miles, kWh, ratio,
  tier, and a **"View SoC"** button → Step 6.

### 5.6 Map

Source `zeb-routes`: one feature per shape of each shown route (dedupe
`shape_id`; geometry from `App.getGTFSShapesFC()`), properties
`{ route_id, name, agency, tier, score, blockKWh, requiredKWh, vehicle }`.
Layer `zeb-routes-layer`: line width 4, opacity 0.95,
`App.choropleth.buildStepColorExpr("tier", [1.5, 2.5, 3.5, 4.5], tierColors, "rgba(160,160,160,0.6)")`.
Add it **above** `gtfs-shapes-layer` (i.e. `map.addLayer(layer, firstUserLayer())`
as gtfs.js does) and set `gtfs-shapes-layer` visibility to `none` while the
module's layer exists; restore it in `clearAll()`.

Source `zeb-depots` / layer `zeb-depots-layer`: circle radius 7, color
`#1a202c`, stroke white 2px, with a `symbol` label layer `zeb-depots-label`
showing the depot name offset below. Hover: "Depot — Avon Regional Transit
Facility · 150 kW chargers".

Hover on `zeb-routes-layer` (copy the Corridor Scoring hover block):
route name, agency, vehicle class, "Tier 2 — Feasible with margin (score 68)",
"Worst block 212 kWh · requires 265 kWh of 440".

Legend: `projects/zeb-feasibility-legend.html`, five `.tpi-legend-row`s
colored from `ZebDemoData.tiers`, widget id `"zeb-legend"`, bottom-left,
title "Electrification feasibility". Fill the row labels after mount from the
data file so colors have one home (see `App.choropleth.fillLegend` for the
fill-after-mount precedent; a plain `querySelectorAll` fill is fine here).

Layers panel: add an ANALYSIS entry
`{ id: "zeb-routes-layer", label: "Electrification feasibility", moduleId: "zeb-feasibility", layers: [{ id: "zeb-routes-layer", op: "line-opacity" }, { id: "zeb-depots-layer", op: "circle-opacity" }] }`.

### 5.7 Exports

CSV: one row per route: `agency, route_id, route_short_name, route_long_name, vehicle_class, season, blocks, governing_block, revenue_miles, deadhead_miles, kwh_per_mile, block_kwh, required_kwh, battery_kwh, ratio, tier, tier_label, score, recharge_hours, overnight_hours`. GeoJSON: the `zeb-routes` FeatureCollection plus a `metadata` object holding the full assumptions block. Filenames `zeb-feasibility-<season>-<YYYY-MM-DD>.*`.

### 5.8 Lifecycle and persistence

- `update(core)`: if `App.getGTFSData()` identity changed → `_prepared = null`,
  `_lastResult = null`, re-render empty state or auto-run if the popup is open
  and a feed is present.
- `onOpen`: sync `_settings` onto controls; if `_lastResult` render it, else
  empty state (`emptyHint()` returns "Load a GTFS feed to begin." when no feed,
  "Click Score Routes." when a feed is present).
- `clearAll()` (the `clear` hook): remove `zeb-routes*`/`zeb-depots*`, restore
  `gtfs-shapes-layer` visibility, hide `zeb-legend`, reset `_lastResult`.
  Do **not** clear the overlays or the GTFS feed — those have their own clear
  paths.
- `App.cache.registerModule("zeb-feasibility", { collect, apply })`: persist
  `_settings` only, schema `v: 1`. Geometry/results are not persisted (same
  precedent as Transit Coverage).

---

## Step 6 — Block Detail SoC chart

`openBlockDetail(blockResult)` builds an inline `<svg>` (width 300, height
170, no library) from `ZEB.socProfile()` and mounts it with
`App.openMiniPopup({ title: "Block " + id + " — state of charge", content, anchor, onClose })`.

Drawing rules:

- x axis: minutes from first point to last, ticks every 3 hours labeled
  `HH:MM` (mod 24). y axis: 0–100 % SoC.
- Polyline through the profile points, stroke `var(--accent)` 2px; a filled
  area under it at 0.15 opacity.
- Horizontal dashed red line at the buffer (20 %) labeled "20% safety buffer";
  the region below it lightly hatched or tinted `#d73027` @0.08.
- If the line crosses below the buffer, mark the crossing with a red dot and a
  label "Below buffer at HH:MM".
- Under the chart, a three-column summary: Block kWh, Required kWh, Available
  kWh; and the tier pill.

Styles under `.zeb-soc-*` in `css/style.css`, using tokens (`--text-muted`,
`--border`) for chrome; the red/tier colors are data encodings.

---

## Step 7 — DI Communities overlay (live ACS)

`App.zebComputeDI()` in `zeb-overlays.js`, async, returns a FeatureCollection
of block groups flagged as DI. Reuses `census.js` and the ACS fetch exactly
as `title-vi-engine.js`'s `TitleVI.fetchDemographics` does (read it first):

1. Study area: for each agency in the loaded feed (or, if no feed, for both
   `ZebDemoData.agencies`), take the bbox of that agency's shapes from
   `App.getGTFSShapesFC()`, expand it 1 mile (`turf.buffer(turf.bboxPolygon(bbox), 1, {units:"miles"})`),
   and `App.fetchTigerwebGeos("bg", areaPolygon)`.
2. Fetch for the collected GEOIDs (year `ZebDemoData.di.acsYear`):
   `B03002_001E`, `B03002_003E`, `B17001_001E`, `B17001_002E` via `App.fetchACSValues("bg", year, code, geoids)`.
3. Flag a block group DI when `minorityShare = 1 − B03002_003/B03002_001 ≥ minorityShareMin`
   **or** `povertyShare = B17001_002/B17001_001 ≥ povertyShareMin`. Skip
   geographies with zero/missing denominators.
4. Attach `properties: { GEOID, minorityShare, povertyShare, criteria: "minority"|"income"|"both" }`
   and render through `zeb-di-fill`/`-line`. Hover: "DI community (income) · 44% below poverty · 31% minority".

If the fetch throws (offline, or the harness's network stub), `App.setStatus("DI communities: Census data unavailable.")`,
leave the layer empty, and keep the checkbox state consistent. No synthetic
fallback.

---

## Step 8 — Tests and harness

### 8.1 Golden cases (`test/cases/zeb-model.mjs`)

`scripts: ["js/core/zeb-model.js"]`. Cases (at minimum):

- `parseGtfsTime`: `"06:05:00"`, `"25:30:00"`, `""`, `"garbage"`.
- `pickRepresentativeService`: weekday wins over a larger Saturday service;
  fallback to most-trips when no weekday service; empty.
- `buildBlocks`: (a) block_id path with two blocks; (b) chained path where
  three trips chain at a shared terminal and a fourth is excluded by a 45-min
  gap; (c) chained path where a terminal mismatch starts a new block;
  (d) empty input.
- `deadheadMiles`: known coordinates, circuity 1.0 and 1.3.
- `energyForBlock`: a 40-ft plains-summer block that lands in tier 1; a
  cutaway mountain-winter block that lands in tier 5; a block whose energy
  fits but whose recharge does not (spanHours 20).
- `tierFor`: boundary values 0.75, 0.9, 1.0, 1.6, 1.61; recharge downgrade.
- `scoreFor`: 0.5, 1.0, 1.5, 2.0, −1.
- `summarizeRoute`: two blocks, worst governs; empty.
- `socProfile`: one two-trip block; check point count and final SoC.

Seed with `node test/run-golden.mjs --update zeb-model`, review the JSON, commit
both files. Add `Verified: node test/run-golden.mjs → N/N` to the commit.

### 8.2 Screenshot harness

In `test/ui-screens/capture.mjs` add `"zeb-feasibility"` to `MODULE_IDS` and
`"zeb-feasibility": { setup: 600, results: 600 }` to `ADAPTIVE_PANEL_WIDTHS`.
The harness stubs all network, so the panel captures in its empty state
(feed-load button visible); that is expected. Run it, inspect
`out/light_zeb-feasibility.png` and the dark one, and confirm the panel matches
the Corridor Scoring chrome. Do not recommit `baseline/`.

### 8.3 Manual browser check (required before the final commit)

Serve the repo (`python3 -m http.server 8000`), open the app, and verify:

1. Analysis → Route Electrification Feasibility → "Load statewide GTFS
   database" loads both agencies; `#zebFeedBar` shows 2 agencies and the
   block method.
2. Score Routes colors routes; Winter → Summer changes at least one tier;
   "All routes as cutaway" pushes Greeley routes down tiers; the Agency filter
   hides the other agency on both map and table.
3. Expanding a row and clicking View SoC opens the chart with the buffer line.
4. Each overlay checkbox and its Add Data button stay in sync (both directions),
   and the Layers panel lists all four new entries.
5. Clear (toolbar) removes the route coloring and restores dashed GTFS shapes.
6. Reload the page: settings restore from the session cache; results do not.

---

## Step 9 — Documentation

`CLAUDE.md`:

- File Structure: entries for every new file (mirror the depth of the
  `transit-coverage.js` entry — what it is, its ids, what it persists).
- Script Load Order: the additions listed above.
- "Active modules": add Route Electrification Feasibility.
- App namespace: `App.getGTFSData`, `App.getGTFSShapesFC`, `App.zebOverlays`,
  `App.zebComputeDI`; note that `App.gtfsData` remains a static null snapshot.
- Testing: add "ZEB model" to the covered engines list.

`features.md`: one paragraph under the analysis modules describing the module
and the three overlays, in the same voice as the surrounding entries.

---

## Step 10 — Screenshot recipe (for the user, in the browser)

1. Load the feed; open the panel; Season = Winter; Vehicle assumption = Per
   route; overlays Winter + DI + Utility on; Score Routes; expand the first
   tier-4 or tier-5 Avon row.
2. Zoom the map so Avon fills the view with the legend at bottom-left. Open
   Present mode (toolbar), set the title to "Route Electrification Feasibility
   — Winter, depot-only charging". Capture.
3. Second capture: click View SoC on the governing block of an Avon route
   under Winter + cutaway. Drag the mini-popup beside the panel; capture.

---

## Acceptance checklist

- [ ] `tools/merge-gtfs.py` runs on the two committed feeds and its zip loads through Add Data → GTFS Feed.
- [ ] `node test/run-golden.mjs` passes with the new `zeb-model` cases included.
- [ ] Every item in Step 8.3 verified in a browser.
- [ ] `test/ui-screens/capture.mjs` runs with the new module id and both images look right.
- [ ] No existing module's behavior changed (Corridor Scoring, GTFS viewer, Layers panel entries for other layers).
- [ ] `CLAUDE.md` and `features.md` updated.
- [ ] No new CDN dependencies; no `npm` anywhere.
