# Card A6b.2 (Sonnet): Title VI "Service Equity" tab and low-income setting

## Files (only these)
- `js/projects/title-vi.js`
- `projects/title-vi-popup.html`
- `css/style.css` (`.tvi-` rules only)
- NEW `test/browser/title-vi-service-equity.test.mjs`
- `docs/reference/modules/title-vi.md`

## Read first
`CLAUDE.md`, `AGENTS.md`, `docs/a6-cards/rules.md`, `docs/A6-plan.md` (Fixed decisions, A6b outline),
`docs/reference/modules/title-vi.md`, `docs/reference/modules/gtfs.md` ("Analysis network"),
`js/core/service-equity.js` (`window.ServiceEquity`), and in `js/projects/title-vi-engine.js` the functions
`defaultPolicy`, `defaultServiceEquity`, `fetchLowIncomeValues`, `fetchDemographics`, `serviceEquityStops`,
`runServiceEquity` (already written; do not change that file — report if it needs a change).
Copy existing patterns: `test/browser/transit-coverage-gtfs.test.mjs` (mini feed loading, Census interception),
`App.renderModuleState` usage already in `title-vi.js`.

## What to build
1. **Low-income definition (Policies tab, beside the other policy settings):** a select
   `#tviLowIncomeDef`: "Below the poverty level (B17001)" = `poverty100` (default) and
   "Below 200% of the poverty level (C17002)" = `poverty200`. Stored as `_policy.lowIncomeDefinition`
   (read/writePolicyToDOM). Pass `{ lowIncomeDefinition: _policy.lowIncomeDefinition }` (with the existing
   `apportionMethod`) to BOTH `TV.fetchDemographics` calls. Changing it marks results stale, like the
   apportion select. Results and CSVs that print the apportion line also print "Low-income: <label>."
   (label from `ServiceEquity.lowIncomeSpec(def).label`).
2. **Fourth tab** `data-tab="service"`, label "Service Equity", after Equity Analysis. Contents:
   - one-line intro: "Scheduled trips per resident in minority and low-income areas, compared with the rest of
     the service area (four-fifths rule)."
   - read-only line: analysis date and day type (from `App.gtfsAnalysisDate.get()` and the result) with
     "Change it in GTFS Feed Attributes."; when no feed is loaded: "No GTFS feed: drawn Services only."
   - inputs (inline `.form-field`s, in a `data-input-group`): bus stop walk distance (mi, default 0.25), rail
     stop walk distance (0.5), checkbox "Use ½ mile at frequent stops" with "peak headway ≤ [15] min" (disabled
     while unchecked), four-fifths threshold (0.8), checkbox "Include hidden routes and Services".
     Stored in `_policy.serviceEquity` (fields of `TV.defaultServiceEquity()`); `_seIncludeHidden` separately.
   - Run button "Run service equity test" in `.module-input-actions`; status through the existing status
     pattern, with `onProgress` text from `TV.runServiceEquity(core, _policy, { includeHidden, onProgress })`.
     Errors thrown by it are shown as the status message.
   - results: two cards, Minority and Low-income. Each: protected group trips per 1,000 residents, the other
     group's, ratio (2 decimals), a pill: `disparity` → "Potential disparity" (red/high class), `no-disparity`
     → "No disparity", `insufficient` → "Not enough data"; plus "N geographies, regional share X%".
     A summary line: stops, GTFS trips + proposal trips, geographies, date. Notes list: every
     `result.notes` entry; "K stops had no residents within their walk distance (T trips not counted)." when
     unallocatedStops > 0; "Skipped: <name> (<reason>)" per proposalsSkipped; "½ mile used at F frequent stops."
     when the switch is on; "Low-income: <label>."; "Residents counted by 2020 census-block population."
   - "Export CSV" button: one row per geography (`result.result.geos`): geoid, residents, trips, trips per
     1,000, minority share %, low-income share %, minority area (yes/no), low-income area (yes/no); first lines
     `# ` comments with date, settings and the two findings.
3. **Stale:** the Service Equity result goes stale (shared banner pattern with Re-run → reruns this test) when
   its inputs change, when the module's `update()` runs because features changed, or when the GTFS analysis date
   / scope changes (compare a signature: settings JSON + `App.gtfsAnalysisDate.get()` +
   `JSON.stringify(App.gtfsScopeRouteIds(includeHidden))` + `App.featureGeomSignature ? App.featureGeomSignature() : ""`,
   taken before the first await of the run).
4. **Persistence:** schema version 4: adds `policy.lowIncomeDefinition`, `policy.serviceEquity`,
   `seIncludeHidden`, and the last Service Equity result WITHOUT `geos`/`region` (keep `result.geos` rows — they
   are plain numbers — so CSV export works after restore). Versions 1–3 load with the defaults
   (`poverty100`, `TV.defaultServiceEquity()`). A restored result shows, marked stale until re-run if its
   signature differs once the feed is loaded. `collectState` must not touch the DOM before the popup opened.
5. **Clear hook:** `clearAll()` also drops the Service Equity result and resets its pane.
6. **Docs:** a "Service Equity tab" section and the low-income setting in `docs/reference/modules/title-vi.md`
   (also mention the block-group poverty rate fix: tract low-income RATE × block-group population).

## Browser test (`title-vi-service-equity.test.mjs`)
Load the app, load the mini GTFS feed (copy loading code from `test/browser/analysis-network.test.mjs`), set
date 20260112. Intercept TigerWeb (tract/block-group layer query → 2 hand-made block-group polygons covering the
mini feed stops; block layer → a handful of blocks with POP100 at known points) and api.census.gov (return
B03002_001E, B03002_003E, B01003_001E, B17001_002E, C17002_002E…007E tables). Work out by hand which stops fall
near which blocks and assert: run succeeds; both cards show; ratio and pill match your hand calculation
(write it in a comment); switching low-income to poverty200 marks stale and the rerun requests C17002; CSV
export content (capture the download or call the export with a stubbed download) has one row per geography;
the frequent-stop switch changes the "½ mile used" note; save → reload state through
`App.cache` collect/apply restores the result; no page errors. Save screenshots of the tab with results in light
and dark mode to `/tmp/claude-0/-home-user/68047e37-e227-5a40-899c-c6aad1308022/scratchpad/a6/shots/`.

## Done when
- `node test/run-golden.mjs` → PASS.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/title-vi-service-equity.test.mjs` → PASS, twice.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/hidden-features.test.mjs` → PASS.
- Any existing Title VI browser test (`ls test/browser | grep -i title`) → PASS.
