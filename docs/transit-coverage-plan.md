# Transit Coverage Module — Implementation Plan

> **Status:** Shipped (verified 2026-10). Current behavior: docs/reference/modules/transit-coverage.md. This file is historical.

## Context

The app lacks the classic consulting coverage statistic: *"X% of service-area residents are within D miles of transit; Y% are within D miles of service running every N minutes or better."* All the machinery exists — TIGERweb/ACS pipeline, area-weighted aggregation, LODES block-level jobs, per-route time bands with headways, feature checklists, the popup module system — this plan assembles it into a new **Transit Coverage** analysis module.

**This plan is written for execution by a cheaper model (Sonnet 5).** After approval it will be committed to the repo as `docs/transit-coverage-plan.md` and pushed, so an implementation session can read it directly. Steps are small, ordered, and independently verifiable; no design decisions are left open. A "Handoff" section at the end tells the user how to run the implementation session.

## Settled design decisions (from user)

- **Transit sources:** Routes + Lines only (checklist like Corridor Scoring). Points deferred.
- **Peak headway:** per-feature minimum band `frequency` (>0) for a **user-selected day type** (Weekday/Saturday/Sunday, default Weekday), read via `App.getEffectiveServiceBands` (`js/core/service-assembly.js:171`, resolves `sundayMirrorsSaturday`).
- **Headway threshold:** optional numeric input (minutes). Blank = generic "within X of transit" only. When set, results show **both** the generic and threshold-filtered figures in one run.
- **Buffer distance:** module-owned input (miles, default 0.25). The module builds **private buffers** via `turf.buffer(feature, miles, {units:"miles", steps:64})` — it must NOT read/mutate global `App.routeBuffers`/`App.lineBuffers`. First module to own its analysis distance; prototype for the future per-module-buffer convention (out of scope here).
- **Service area:** checklist of drawn `App.polygons`, ≥1 required; union = denominator area. Coverage numerators are **clipped to the service area** with `turf.intersect` so population outside never counts.
- **Metrics v1:** ACS total population (`B01003_001E`) + LODES jobs. Jobs are whole-block (internal-point-in-polygon; apportion toggle does not apply — footnoted). Jobs show "—" + ⚠ icon when LODES absent.
- **UI:** standard 2-column Settings | Results popup (960px), `tc` id prefix, `.tc-` CSS prefix, reuse `rf-`/`tpi-` shared classes. **Template module: `js/projects/corridor-scoring.js` + `projects/corridor-scoring-popup.html`.**
- Standard lifecycle: `App.renderModuleState`, `markStale` on input changes, popup-visibility guards, `clear` hook, `App.cache.registerModule("transit-coverage", …)` schema v1, map overlay + floating legend, CSV/GeoJSON export.
- **Testing:** pure helpers behind `__MAT_TEST__`-guarded `App._tcTest`; new `test/cases/transit-coverage.mjs`; seed with `node test/run-golden.mjs --update`.

## Verified reference points

- `aggregateWithinUnion(unionFeat, geos, valueMap, aggMode, options)` — `js/core/census.js:322`. **Returns `{ value, used, weightSum }` — always extract `.value`.** Apportionment = `options.apportionByArea` (default true); use `aggMode:"sum"`.
- `fetchTigerwebGeos(geoLevel, unionFeat)` — `census.js:83`; bbox-memoized; one fetch against the service-area union covers all numerators (they're clipped subsets of it).
- `fetchACSValues(geoLevel, year, varCode, geoids)` — `census.js:209` → `Map<GEOID, number>`.
- Jobs-in-union inline pattern — `buffer-summary.js:362-367` (`App.fetchBlocksInternalPointsInUnion(union)` → `Set<blockGEOID>`, sum `App.lodesData.get(id)`). Do NOT use `computeEmploymentServedOnly()` (takes no union arg).
- Checklist / select-all / status+stale / emptyHint / cache collect-apply / map layer / legend — all in `corridor-scoring.js` (checklist :107-168, setStatus :282-299, markStale :301, registration :1070-1090, layers :481-536, legend :776-782).
- Band data: `attributes.service = { weekday|saturday|sunday: [{from:"HH:MM", to:"HH:MM", frequency: minutes|null}], sundayMirrorsSaturday }`. Skip bands where `!(frequency > 0)`.
- Buffer/union folding: try/catch `turf.union` loop (`js/core/lines.js:37-45`, `corridor-scoring.js:64-69`).
- ACS years 2024–2021; geo levels `tract`/`bg` (copy from corridor-scoring popup).

---

## Implementation steps

### Step 1 — Skeleton: popup fragment + registration (button + empty popup render)

**Files:** create `projects/transit-coverage-popup.html`, create `js/projects/transit-coverage.js`, edit `index.html`.

1. **Popup HTML** — copy the 2-column shell from `projects/corridor-scoring-popup.html:29-114` (skip the weights modal, lines 1-27). Keep outer class `cs-body`, add `tc-body`. Settings column (`rf-settings-col`), in order:
   - `Geography` section title; `<select id="tcGeoLevel" class="rf-select">` tract / bg (bg selected) — copy lines 36-42.
   - ACS Year label + `<button id="tcLodesWarnBtn" class="rf-info-btn">&#9888;</button>` + `<select id="tcYearSelect">` (2024/2023/2022/2021) — copy lines 44-54; warn title: `"LODES data not loaded — Jobs columns will show — until a LODES file is loaded via Add Data."`
   - Apportion toggle `<input type="checkbox" id="tcApportionByArea">` — copy lines 56-59.
   - Section `Coverage settings`: `<input type="number" id="tcBufferMiles" class="rf-select" value="0.25" min="0.05" max="5" step="0.05">` (label `Buffer distance (mi)`); `<select id="tcDayType" class="rf-select">` weekday (selected) / saturday / sunday (label `Day type (peak headway)`); `<input type="number" id="tcHeadwayThreshold" class="rf-select" min="1" step="1" placeholder="none">` (label `Headway threshold (min)`).
   - Section `Transit routes/lines`: links `tcFeatSelectAll` / `tcFeatSelectNone`; `<div id="tcFeatureList" class="rf-feature-checklist">` — copy lines 61-67.
   - Section `Service area (drawn polygons)`: links `tcAreaSelectAll` / `tcAreaSelectNone`; `<div id="tcAreaList" class="rf-feature-checklist">`.
   - `<button id="tcRunBtn" type="button" class="rf-action-primary">Analyze Coverage</button>`.
   - Results column (`rf-results-col`) — copy lines 85-111, renamed: `tcStatus`/`tcStatusText` (class `rf-status`), `tcResults` (display:none) containing `tcResultsTable`, `<p id="tcStatSentence" class="tiny" style="margin-top:8px;"></p>`, `<div id="tcHeadwayList" style="margin-top:10px;"></div>`, export buttons `tcExportGeoJSON`/`tcExportCSV` (disabled, `rf-btn-sm`), footnote `<p class="tiny" style="color:var(--muted);">Jobs are counted by whole LODES block (apportionment does not apply to jobs).</p>`; empty state `<div id="tcEmptyState" class="rf-info-box">…</div>`.

2. **Module JS skeleton** — new IIFE copying corridor-scoring.js:9-29 (state) and 1068-1091 (registration). State: `_lastResult=null, _stale=false, _running=false, _initialized=false, _apportionByArea=false, _savedSelections=null`. Functions: `isPopupVisible()` (:27-29, compare `"transit-coverage"`), `setStatus(msg,kind)` (:282-288, `statusEl:"tcStatus"`), `emptyHint()` (:291-299 shape — no routes/lines → "Draw a route or line to begin."; no polygons → "Draw a service-area polygon to begin."; else → "Select transit features and a service area, then click Analyze Coverage."), `markStale()` (:301-308, run fn `runCoverage` stub, `setExportButtonsEnabled` from :438-445), stubs `init/onOpen/onClose/clearAll/update`. Register with `id:"transit-coverage", name:"Transit Coverage", enabled:true, popupWidth:960, popupHTML:"projects/transit-coverage-popup.html"`.

3. **index.html** — add `<script src="js/projects/transit-coverage.js"></script>` right after `walkshed.js` (index.html:387) inside the module block (:379-402).

**Verify:** open `index.html`; Analysis dropdown shows "Transit Coverage"; popup opens with all controls and empty-state hint; no console errors.

### Step 2 — Checklists + input wiring + stale lifecycle

**File:** `js/projects/transit-coverage.js`.

- `buildFeatureChecklist()` — copy corridor-scoring.js:107-168 (container `tcFeatureList`, badges R/L, default checked, preserves prior state).
- `buildAreaChecklist()` — same pattern for `tcAreaList` over `App.polygons||[]`, `data-type="polygon"`, badge "P", name fallback `"Polygon "+(i+1)`, empty msg `"No polygons drawn."`.
- `getSelectedFeatures()` → `{routeIndices, lineIndices}` and `getSelectedAreas()` → `{polygonIndices}` — copy the read loop from :83-103 **but DELETE the `allChecked` / `return null` convention (:101). Always return explicit arrays.**
- `applySelections(sel)` — copy :950-963 shape; sets checkboxes in both lists.
- `init(core)` (structure from :795-887): `change`→`markStale` on `tcGeoLevel/tcYearSelect/tcBufferMiles/tcDayType/tcHeadwayThreshold`; apportion checkbox per :807-815; four select-all/none links per :817-833 scoped to their list; `tcRunBtn`→`runCoverage`; export buttons→`exportCSV`/`exportGeoJSON` stubs. Optional: census-cache status block (:853-860) with `tcGeoLevel/tcYearSelect/tcRunBtn` — include only if it copies cleanly.
- `updateLodesWarnings()` — copy :275-278, id `tcLodesWarnBtn`.
- `onOpen(core)` — per :889-913: rebuild both checklists, apply `_savedSelections` if set, `updateLodesWarnings()`, restore apportion checkbox, `renderResults(_lastResult)` if result else empty state, `if (_stale) markStale();`.
- `update(core)` — per :936-946: if `_lastResult` && (no routes+lines OR no polygons) → `clearAll()`; `if (!isPopupVisible()) return;` rebuild checklists; `updateLodesWarnings()`; `markStale()` only when a result exists.

**Verify:** draw 2 routes, 1 line, 1 polygon → both checklists populate checked; select-all/clear work independently; no errors.

### Step 3 — Pure helpers + test hook

**File:** `js/projects/transit-coverage.js`. Pure, no DOM/App state (testable):

- `computePeakHeadway(service, dayType)` → number|null: min `parseFloat(band.frequency)` over `App.getEffectiveServiceBands(service, dayType)` where finite and `> 0`; null if none.
- `formatPct(num, den)` → `"—"` if den not finite/≤0 or num not finite; else `(100*num/den).toFixed(1)+"%"`.
- `formatCount(v)` → `"—"` if not finite; else `Math.round(v).toLocaleString()`.
- `buildStatSentence(summary)` — input `{bufferMiles, headwayThreshold, popTotal, popCovered, popThreshold, hasThreshold}`; output `"X% of residents are within B mi of selected transit"` + (if hasThreshold) `"; Y% within B mi of N-min-or-better service."` else `"."`; zero/non-finite popTotal → `"No population found in the selected service area."`.
- Copy verbatim: `escapeHTML` (corridor-scoring.js:612-616), `_csvField` (:328-335), `_dateStamp`/`_triggerDownload` (:312-326).
- Test hook — copy :622-633 renamed to `App._tcTest = { computePeakHeadway, formatPct, formatCount, buildStatSentence, _csvField }`.

**Verify:** reload; no console errors (hook inert without `__MAT_TEST__`).

### Step 4 — Geometry: private buffers, unions, clipping

**File:** `js/projects/transit-coverage.js`.

- `foldUnion(polys)` — copy corridor-scoring.js:64-69 (try/catch `turf.union` fold; null for empty).
- `buildPrivateBuffer(feature, miles)` — `try { return turf.buffer(feature, miles, {units:"miles", steps:64}); } catch(e) { return null; }`. **Never touch `App.routeBuffers`/`App.lineBuffers`.**
- `buildCoverageUnions(sel, miles, dayType, thresholdMin)` → `{coverageUnion, thresholdUnion, headwayRows}`: for each selected route/line, compute `peak = computePeakHeadway((feature.properties.attributes||{}).service, dayType)` and buffer; push `{name, featureType, featureIndex, peakHeadway: peak, qualifies: thresholdMin!=null && peak!=null && peak<=thresholdMin}` to `headwayRows`; fold all buffers → `coverageUnion`; fold qualifying buffers → `thresholdUnion` (null when no threshold or none qualify).
- `clipToServiceArea(unionFeat, serviceAreaUnion)` — null if either null; `try { return turf.intersect(a,b); } catch(e) { return null; }` — **null = zero coverage, not an error.**
- `buildServiceAreaUnion(sel)` — fold `App.polygons[idx]` over `sel.polygonIndices`; null when none.

### Step 5 — `runCoverage()` compute flow + map overlay + legend

**Files:** `js/projects/transit-coverage.js`, create `projects/transit-coverage-legend.html`, `css/style.css` only if a `.tc-` rule is needed (prefer reusing `.tpi-legend-*` like `projects/walkshed-legend.html`).

Map constants: `TC_SOURCE="transit-coverage-fill"`, layers `transit-coverage-coverage-layer` (fill `#93c5fd`, opacity 0.35, filter kind=`coverage`), `transit-coverage-threshold-layer` (fill `#1d4ed8`, 0.35, kind=`threshold`), `transit-coverage-area-layer` (line `#374151`, width 2, dasharray [2,2], kind=`area`). One geojson source, FeatureCollection of up to 3 features tagged `properties.kind`. `renderMapOverlay(result)` uses add-or-setData (corridor-scoring.js:495-528, no hover popup); `clearMapOverlay()` removes layers **before** source (:531-536), called from `clearAll()` and at the top of `runCoverage`.

Legend fragment: copy `projects/walkshed-legend.html` structure — rows: light-blue "Within buffer of selected transit", dark-blue "Within buffer of ≤ threshold service", dashed "Service area". Show after success: `App.popup.showFloatingWidget("tc-legend", "projects/transit-coverage-legend.html", {position:"bottom-left", width:200, title:"Transit Coverage"})`; hide in `clearAll()`.

`async function runCoverage()` — scaffold from corridor-scoring.js:709-791 (`_running` guard, disable button, `setStatus("Analyzing…","running")`, clear overlay, try/catch/finally):
1. Read inputs; validate `bufferMiles` in [0.05, 5] (else throw); `thresholdMin = finite && >0 ? value : null`.
2. `featSel = getSelectedFeatures()` (throw `"Select at least one route or line."` if both empty); `areaSel = getSelectedAreas()` (throw `"Select at least one service-area polygon."` if empty).
3. `serviceAreaUnion = buildServiceAreaUnion(areaSel)` (throw if null).
4. `{coverageUnion, thresholdUnion, headwayRows} = buildCoverageUnions(...)` (throw `"Could not build buffers for the selected features."` if coverageUnion null).
5. `coverageClipped = clipToServiceArea(coverageUnion, serviceAreaUnion)`; `thresholdClipped = clipToServiceArea(thresholdUnion, serviceAreaUnion)`.
6. Population — **extract `.value` from every aggregation** (`aggregateWithinUnion` returns `{value, used, weightSum}`):
   ```js
   setStatus("Fetching geographies…", "running");
   var geos = await App.fetchTigerwebGeos(geoLevel, serviceAreaUnion);
   var geoids = geos.map(function(f){ return f.properties.GEOID; }).filter(Boolean);
   setStatus("Fetching population…", "running");
   var popMap = await App.fetchACSValues(geoLevel, year, "B01003_001E", geoids);
   var opts = { apportionByArea: _apportionByArea };
   var popTotal     = App.aggregateWithinUnion(serviceAreaUnion, geos, popMap, "sum", opts).value;
   var popCovered   = coverageClipped  ? App.aggregateWithinUnion(coverageClipped,  geos, popMap, "sum", opts).value : 0;
   var popThreshold = (thresholdMin == null) ? null
                    : (thresholdClipped ? App.aggregateWithinUnion(thresholdClipped, geos, popMap, "sum", opts).value : 0);
   ```
7. Jobs — local `async function sumJobsInUnion(unionFeat)` per buffer-summary.js:362-367 (null union → 0). If `App.lodesData` null → all three jobs values `null`; else `jobsTotal = await sumJobsInUnion(serviceAreaUnion)`, `jobsCovered = await sumJobsInUnion(coverageClipped)`, `jobsThreshold = (thresholdMin==null) ? null : await sumJobsInUnion(thresholdClipped)`.
8. `_lastResult = { geoLevel, year, apportionByArea, bufferMiles, dayType, thresholdMin, popTotal, popCovered, popThreshold, jobsTotal, jobsCovered, jobsThreshold, headwayRows, coverageClipped, thresholdClipped, serviceAreaUnion, featSel, areaSel }`; `_stale=false`.
9. `renderResults(_lastResult)`, `renderMapOverlay(_lastResult)`, show legend, `setExportButtonsEnabled(true)`, `setStatus("Analyzed coverage — " + geos.length + " geographies.", "done")`.

**Verify:** route through polygon → light-blue clipped fill + dashed outline + legend; threshold 15 with a qualifying route → dark-blue fill too; delete the polygon → module clears.

### Step 6 — Results rendering + exports

**Files:** `js/projects/transit-coverage.js`, `css/style.css`.

- `renderResults(result)` — shell per corridor-scoring.js:635-705. `<table class="cs-results-table tc-results-table">`, header `Row | Population | Pop % | Jobs | Jobs %`; rows: **Service area** (popTotal, `100.0%` or `—`, jobsTotal or `—`, `100.0%`/`—`); **Within {bufferMiles} mi of selected transit** (popCovered, `formatPct(popCovered, popTotal)`, jobs likewise); **Within {bufferMiles} mi of ≤{thresholdMin}-min transit** only when `thresholdMin != null`. Jobs cells `"—"` when value null. Set `tcStatSentence` via `buildStatSentence`. Fill `tcHeadwayList` with a native `<details><summary>Peak headways (N features)</summary>…</details>` of `tiny` rows: name (escaped), peak headway (`+" min"` or `"no service"`), and `"meets"/"does not meet"` when threshold set.
- CSS (only if needed): `.tc-results-table td:nth-child(n+2) { text-align: right; }` next to the `.cs-results-table` block.
- `exportCSV()` — scaffold :349-397. `#`-comment header (tool name, date, geography, year, buffer, day type, threshold, apportion); data header `row,population,pop_pct,jobs,jobs_pct` (pct empty when denominator invalid); blank line; second block `feature,peak_headway_min,meets_threshold` from `headwayRows`. Filename `"transit-coverage-"+_dateStamp()+".csv"`.
- `exportGeoJSON()` — shape :399-436. FeatureCollection with `metadata` + up to 3 features (`kind:"service-area"|"coverage"|"threshold"` with population/jobs/pct properties); skip null geometries. Filename `"transit-coverage-"+_dateStamp()+".geojson"`.
- `clearAll()` — per :919-934: clear overlay, hide legend, null `_lastResult`, `_stale=false`, hide results / show empty state when visible, disable exports.

**Verify:** table + sentence render sensibly; Jobs "—" without LODES; exports download; changing an input shows the stale banner whose Re-run works.

### Step 7 — Session persistence

**File:** `js/projects/transit-coverage.js`.

- `saveTcState(mode)` — per corridor-scoring.js:967-1017. `{ version:1, settings:{bufferMiles, dayType, headwayThreshold, geoLevel, year, apportionByArea}, selections:{routeIndices, lineIndices, polygonIndices}, lastSummary }`. Settings from DOM when present (guard each getElementById) else defaults/`_lastResult`. `lastSummary` = **numbers + headwayRows only** (no geometry, either mode; no `full` branch needed).
- `restoreTcState(data)` — per :1019-1066: stash selections into `_savedSelections`; write settings to DOM when present + `_apportionByArea`; rebuild `_lastResult` from `lastSummary` with all geometry fields null; when visible, `renderResults` + enable exports. Do NOT redraw the map overlay (geometry not persisted — user re-runs).
- Register: `App.cache.registerModule("transit-coverage", { collect: saveTcState, apply: restoreTcState })` guarded by `if (App.cache && App.cache.registerModule)`.
- Guard `exportGeoJSON` after restore: when all three unions null → `setStatus("Re-run the analysis to regenerate geometry for export.", "error")` and return. `exportCSV` works from numbers.

**Verify:** run, reload page, reopen popup → settings/selections/results restored; Re-run regenerates the overlay.

### Step 8 — Golden tests + documentation (final)

**Files:** create `test/cases/transit-coverage.mjs`, edit `CLAUDE.md`.

1. Test case file per `test/cases/corridor-scoring.mjs`:
   ```js
   export default {
     scripts: ["js/core/service-assembly.js", "js/projects/transit-coverage.js"],
     cases: [ ... ]
   };
   ```
   (`service-assembly.js` first so `App.getEffectiveServiceBands` exists in the vm sandbox — verified safe: its top level only assigns onto `App`.) Cases via `App._tcTest.*`: `computePeakHeadway` (min across `[{frequency:30},{frequency:15},{frequency:60}]` → 15; skips zero/negative/non-numeric; sunday with `sundayMirrorsSaturday:true` uses Saturday; empty day → null; null service → null); `formatPct` (normal / zero denominator / NaN); `formatCount` (12345.6 / NaN); `buildStatSentence` (with threshold / without / zero pop); `_csvField` (plain / comma / quote).
2. Seed `node test/run-golden.mjs --update`, review `test/golden/transit-coverage.json`, then confirm `node test/run-golden.mjs` → `PASS — N/N`. Commit goldens with the code.
3. **CLAUDE.md**: (a) File Structure — add `transit-coverage.js`, `transit-coverage-popup.html`, `transit-coverage-legend.html` entries; (b) Script Load Order — add `transit-coverage.js (needs App.registerModule, App.popup, App.map, App.cache, App.getEffectiveServiceBands, census.js, lodes.js, turf)` after `walkshed.js`; (c) "Active modules" — append Transit Coverage; (d) Testing section "Covered engines" — add Transit Coverage.
4. Commit message ends with `Verified: node test/run-golden.mjs → N/N`.

---

## Risks / edge cases (handle as specified, do not improvise)

- `turf.intersect` null on disjoint/degenerate unions → zero coverage, not an error.
- `turf.union` failure → try/catch fold skips that polygon (matches existing app behavior).
- No polygons/features selected → explicit thrown Errors surface in the status pill.
- Threshold set but nothing qualifies → threshold row 0 / 0.0%; headway list shows "does not meet". Not an error.
- Features with no bands → generic coverage only.
- LODES absent → jobs null → "—", ⚠ visible.
- Restored session has no geometry → GeoJSON export guarded; overlay returns after Re-run.
- localStorage quota: non-issue (numbers only persisted).

## Do-not-do notes (binding for the implementing model)

- Do NOT read/mutate `App.routeBuffers`/`App.lineBuffers` or call `rebuildRouteBuffers`/`rebuildLineBuffers` — private buffers only.
- Do NOT copy corridor-scoring's "null means all selected" `getFeatureFilter` convention — explicit index arrays always.
- Do NOT call `App.computeEmploymentServedOnly()` — inline pattern from buffer-summary.js:362-367.
- Do NOT refactor/rename existing modules, `renderModuleState`, or shared `.rf-`/`.tpi-`/`.cs-` classes (`rf-` status classes are intentionally cross-module).
- Do NOT enable anything currently disabled (Interlines button, dormant mitigation-needs tags).
- Do NOT build bespoke status banners — everything via `setStatus` → `App.renderModuleState`.
- Do NOT hand-edit `test/golden/*.json` — only `--update`, never to paper over an unintended change.
- Do NOT add npm packages, build steps, or ES modules to app code — plain IIFE `<script>` only.

## Verification (end-to-end)

1. `node test/run-golden.mjs` → PASS including the new transit-coverage cases and all 5 pre-existing case files untouched.
2. Browser smoke test (user or Playwright): draw route + polygon → Analyze → table, sentence, map fills, legend; threshold behavior; stale/Re-run; reload-restore; CSV/GeoJSON downloads; LODES "—" state.

## Handoff: implementing with cheaper models

After approval, this plan is committed as `docs/transit-coverage-plan.md` on branch `claude/transit-analysis-brainstorm-xro1di` and pushed. Then, from the Claude desktop app:

1. Start a **new Claude Code session** on `caseywalrath/micro-analysis-tool`, based on branch `claude/transit-analysis-brainstorm-xro1di` (cloud session, same as this one). Select **Sonnet 5** as the session model (model picker at session creation, or `/model` in-session). Sonnet 5 is the right tier for the whole plan; Haiku 4.5 can handle individual steps but should be fed one step at a time.
2. Prompt: *"Implement docs/transit-coverage-plan.md exactly. Work through Steps 1–8 in order, committing after each step with a descriptive message. The 'Do-not-do notes' are binding. Finish with `node test/run-golden.mjs` and include the Verified line in the final commit."*
3. Golden tests run in the cloud session; the **browser smoke tests need you**: after the session pushes, pull the branch locally (or download it) and open `index.html`, then walk the Step 5/6 verify lists. Report anything broken back to the implementation session as plain instructions ("the threshold row shows NaN when…").
4. Keep this planning session available for escalation: if the cheaper model gets stuck on a step, bring the error here rather than letting it improvise outside the plan.
