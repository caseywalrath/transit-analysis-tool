# Card A7b.2 — Compare tab (Build vs No-Build) in GTFS Service Analysis [Sonnet]

## 1. Goal
A **Compare** tab that compares the loaded feed (No-Build) with either a second GTFS ZIP or the loaded feed with
the user's drawn Services (Build), shows the change table with totals and people within reach, exports CSV, and
sends ticked changed routes to Title VI as a new scenario.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A7-plan.md`, `docs/a7-cards/card-a7b.1.md` (the `ServiceCompare` contract;
  the engine is in `js/core/service-compare.js`).
- `js/core/analysis-network-source.js`: section `// ---- Build vs No-Build service summaries` — `App.feedServiceSummary`,
  `App.editedServiceSummary`, `App.serviceSourceRouteId`, `App.countPeopleNearStops` (use them; do not change them).
- `js/projects/gtfs.js`: `App.gtfsReadOtherFeed`. `js/projects/title-vi.js`: `App.titleViMajorChangePolicy`,
  `App.titleViAddScenario`. `js/core/service-assembly.js`: `App.buildTransitServices` (service `key`, `name`, `patterns`).
- `js/projects/gtfs-service-analysis.js` — all of it, especially `TABS`, `serviceInputs`, `checkStale`, `runHealth`,
  `renderHealthResults` (expand-row pattern), `csvButton`, `note`, `H`, the session `collect` / `apply`.
- `projects/gtfs-service-analysis-popup.html`, `.gsa-` CSS block in `css/style.css`.
- `test/browser/gtfs-feed-health.test.mjs` (setup to copy).

## 3. Files you may change
`projects/gtfs-service-analysis-popup.html`, `js/projects/gtfs-service-analysis.js`, `css/style.css` (new
`.gsa-cmp*` rules only, at the end of the `.gsa-` block), `test/browser/gtfs-compare.test.mjs` (new),
`docs/reference/modules/gtfs-service-analysis.md` (a "Compare" section).

## 4. Contract
ES5 in `js/`; modern JS in the test. Reuse `.form-field`, `.rf-select`, `.tpi-toggle-row`, `.gsa-settings`,
`.gsa-tiles`/`.gsa-tile`, `.gsa-table-wrap`, `.gtfs-dt-table`, `.gsa-caret`/`.gsa-detail`, `.rf-btn-sm`, `.rf-action-primary`.

**Markup.** Tab button `data-tab="compare"` labelled `Compare`, placed between Stops and Feed health. Pane contains:
- Radio group `name="gsaCompareMode"`: `value="feed"` "Another GTFS feed (ZIP)" and `value="drawn"` "This feed with my drawn Services".
- `#gsaCompareFeedBox` (shown in feed mode): `<input type="file" id="gsaCompareFile" accept=".zip">` and `#gsaCompareFileName` (tiny, muted).
- `#gsaCompareDrawnBox` (shown in drawn mode): `#gsaCompareServices` — a table built in JS: `Service | Replaces GTFS route`
  with one `<select class="rf-select gsa-cmp-replace" data-key="<service key>">` per drawn Service: first option
  `value=""` "(new route)", then every route of the loaded feed in `H.routeName` order (`value` = route_id). Default:
  the saved choice, else `App.serviceSourceRouteId(key)` when that id is in the feed, else "". With no drawn Services:
  the tiny note "Draw or copy a Service first (Copy route as Service with schedule in the GTFS route menu)."
- Checkbox `#gsaComparePeople` (default checked): "Count residents, jobs and census blocks near stops (downloads Census data)".
- `.module-input-actions` with `#gsaRunCompare` "Compare"; `#gsaCompareResults`.

**State.** `_compareCfg = { mode: "feed" | "drawn", replaced: { key: routeId | "" }, people: true }` (session-saved in
`collect` as `compare`; `apply` validates: unknown mode → "feed", replaced values must be strings, people boolean).
`_compareFile` (the chosen File, never saved). `_compareResult = { feed, sig, cfg, nb, b, result, people, precheck,
notes, ms }`. `TABS.compare` with hint `{ need: "No comparison yet.", action: "Choose what to compare with, then press Compare." }`,
stale = result exists and `result.sig !== compareSig()`, run = `runCompare`. A result whose feed is not `feed()` is
dropped in `checkStale` like the others. `compareSig()` = JSON of `{ cfg: _compareCfg, service: serviceInputs(),
file: _compareFile ? [name, size, lastModified] : null, drawn: mode === "drawn" ? drawnSig() : null }` where
`drawnSig()` = services mapped to `{ k: key, p: patterns.map(p => [p.featureType, p.featureId, p.runTime, p.avgSpeed, p.direction, p.service]) }`.
Re-render `#gsaCompareServices` in `onOpen` and in `update` (drawn Services can change) when the popup is visible.

**Run** (`async function runCompare()`; ignore a second press while one is running, `_compareRunning` flag;
the button is disabled while running and re-enabled in `finally`):
1. No feed → `renderState()`; feed mode with no file → `setStatus("Choose a GTFS ZIP to compare with.", "error")`;
   drawn mode with no drawn Services → `setStatus("Draw or copy a Service first.", "error")`.
2. `var inputs = serviceInputs(); var nb = App.feedServiceSummary(f, { label: "No-Build: loaded feed", dates: inputs.dates, routeIds: inputs.routeIds, service: inputs });`
3. Feed mode: `setStatus("Reading the Build feed…", "running")`; `var other = await App.gtfsReadOtherFeed(_compareFile);`
   `b = App.feedServiceSummary(other.feed, { label: "Build: " + other.name, service: inputs });` then `other = null`
   (only the summary is kept). Drawn mode: `b = App.editedServiceSummary({ label: "Build: loaded feed with drawn Services",
   dates: inputs.dates, routeIds: inputs.routeIds, replaced: <_compareCfg.replaced with "" → null>, includeHidden: _includeHidden, service: inputs });`
4. `result = ServiceCompare.compare(nb, b, { pairs: b.pairs })`.
5. If people is on: `setStatus` with each progress text; `people = { a: await App.countPeopleNearStops(nb.stops, { onProgress }), b: await …(b.stops, …) }`;
   a throw here does not fail the run: `people = null` and push note `"Census counts failed: " + message`.
6. `precheck = ServiceCompare.precheck(result.rows, App.titleViMajorChangePolicy ? App.titleViMajorChangePolicy() : null)`.
7. If `feed() !== f` after any await, stop silently (the run was superseded). Any other throw → `setStatus("Comparison failed: " + message, "error")`.
8. Store, render, `renderState()`. Notes: `b.notes`, each skipped Service as `"Not included: " + name + " (" + reason + ")."`, in feed
   mode `"Build dates are the busiest weekday, Saturday and Sunday in the Build feed."`, and the Census note(s).

**Results** (`renderCompareResults(host, r)`):
- Line: `nb.label` + dates (`Weekday YYYY-MM-DD · Saturday … · Sunday …`, "—" for none), then the same for `b`.
- Tiles (`.gsa-tiles`): Trips/yr, Revenue hr/yr, Platform hr/yr, Cost/yr, Peak vehicles from `result.total`, each
  value `a → b` and below it the change (`+1,234 (+5.2%)`, sign always shown, "—" for null pct); when `people`:
  Residents, Jobs (`"—"` when null: "Load LODES jobs to count jobs"), Census blocks, each `a → b` and change.
- Counts line: `"N added · N removed · N changed · N unchanged"`.
- Filter select `#gsaCompareFilter`: "Changed routes" (default; rows whose status is not unchanged) / "All routes".
- Table `Route | Status | Matched by | Trips/yr | Revenue hr/yr | Platform hr/yr | Cost/yr | Peak veh. | Wkdy span hr`:
  numeric cells show the diff with sign; status text `Added / Removed / Changed / Unchanged`, matched-by text
  `pair → "Replaced by drawn Service"`, `id → "route_id"`, `short → "short name"`, `long → "long name"`, null → "".
  Caret expands a `.gsa-detail` sub-table: rows No-Build / Build / Change / Change % across the same seven metrics.
  Row names: `r.name`. Expansion and filter live in `_ui.compare`.
- CSV button → `compare.csv`: header lines `[nb.label, b.label]` plus, with people, `"Residents: a → b"`, `"Jobs: …"`,
  `"Census blocks: …"`; table from `ServiceCompare.csv(result, { a: "No-Build", b: "Build" })`.
- **Title VI section** (only when `precheck.length`): heading `rf-section-title` "Send changed routes to Title VI";
  a tiny note "Pre-checked against your Title VI major-change rules. Revenue hours are per year; span is the weekday span.";
  table `Send | Route | Change | Revenue hr % | Weekday span % | Rules met`, checkbox checked when `suggested`;
  change text `adjustment → "Changed"`, `elimination → "Removed"`, `new_route → "New"`; rules met = labels
  `revenueHoursPct → "Revenue hours"`, `spanHoursPct → "Span"`, `routeElimination → "Elimination"` joined ", " or "—".
  Button `#gsaSendTitleVi` "Create Title VI scenario" (disabled when `App.titleViAddScenario` is missing or nothing ticked):
  calls `App.titleViAddScenario({ name: "Build vs No-Build " + iso(App.gtfsToday()), alterations: ticked.map(p => ({ name: p.name,
  changeType: p.changeType, revenueHours: { before: row.metrics.revenueHrs.a, after: row.metrics.revenueHrs.b },
  spanHours: { before: row.metrics.spanHrs.a, after: row.metrics.spanHrs.b } })) })` (row = the result row with the same
  aKey/bKey) and shows `note("Added “" + name + "” to Title VI with " + n + " route(s). Open Title VI and pick each route's before / after Lines to run the equity analysis.")`.
- CSS: `.gsa-cmp-mode` (flex column, gap `--space-1`), `.gsa-cmp-pos { color: var(--text-primary) }`, `.gsa-cmp-neg { color: var(--danger) }`
  for negative diffs in the table, `.gsa-cmp-services select { max-width: 280px }`. Tokens only.

## 5. Edge cases
1. Both modes when the feed has no trips on a day type: dates show "—"; no throw.
2. Bad ZIP: the error text from `App.gtfsReadOtherFeed` becomes `"Comparison failed: GTFS error: …"`.
3. Changing the mode, a select, the checkbox or the file marks a shown result stale (Re-run works).
4. A saved `replaced` entry for a Service that no longer exists is ignored (not shown, not sent).
5. `App.lodesData` missing → jobs "—" with the LODES hint; residents and blocks still shown.
6. Precheck empty (nothing changed) → no Title VI section.

## 6. Placement
Pane after the Stops pane and before the Feed health pane. `runCompare` / `renderCompareResults` after the health
code. Wire events in `init()`.

## 7. Steps
Markup → state/session/TABS → run → render → Title VI → CSS → test → doc.

## 8. Done when
`NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-compare.test.mjs` ends `PASS — 10/10 checks passed`
(in the test, stub `App.countPeopleNearStops` with a page function returning `{residents: stops.length * 100, jobs: null,
blocks: stops.length, note: null}` so no network is used; analysis date 20260112 as in the GSA test). Build feed for
feed mode = the mini texts with every `R1` line removed from `trips.txt` and route id `B1` renamed to `B1X` in
`routes.txt` and `trips.txt` (short name stays `B1`).
1. `tab-order`: tabs are Service & Cost, Stops, Compare, Feed health.
2. `feed-mode-needs-file`: Compare with no file shows "Choose a GTFS ZIP to compare with."
3. `feed-rows`: after choosing the Build ZIP (`setInputFiles`) and Compare: the B1 row is matched by "short name" and Unchanged; R1 is Removed.
4. `feed-matches-engine`: the rendered counts line equals `ServiceCompare.compare(App.feedServiceSummary(...), …)` counts computed in the page from the same inputs (re-read the ZIP in the page with `App.gtfsReadOtherFeed`).
5. `people-tiles`: the Residents tile shows the stubbed numbers.
6. `csv`: the CSV has 4 `#` lines, a header, one line per row and a Total line.
7. `stale-on-change`: unticking the people box shows the stale banner; Re-run clears it.
8. `drawn-mode`: after `App.gtfsCopy({ routeId: "B1", mode: "service" })`, drawn mode lists one Service whose select defaults to `B1`; Compare gives a B1 row matched "Replaced by drawn Service".
9. `title-vi`: ticking that row and pressing Create Title VI scenario shows the "Added “Build vs No-Build" note.
10. `no-page-errors`.
With `GSA_SHOTS_DIR` set, save `compare-light.png` / `compare-dark.png` (wait 500 ms after toggling dark mode) with one row expanded.
Also: `gtfs-service-analysis.test.mjs` 19/19, `gtfs-feed-health.test.mjs` 9/9, `node test/run-golden.mjs` PASS.

## 9. Stop and report if
A glue function's output does not match its comment; you need to change a file not listed; an existing test needs a change.
