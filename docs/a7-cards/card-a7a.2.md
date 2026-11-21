# Card A7a.2 — Feed health tab in GTFS Service Analysis [Sonnet]

## 1. Goal
Add a **Feed health** tab to GTFS Service Analysis that runs `GtfsSchedule.feedHealth` on the loaded feed
on a button press and shows the seven checks with their examples and a CSV.

## 2. Read first
- `CLAUDE.md`, `AGENTS.md`, `docs/A7-plan.md`, `docs/a7-cards/card-a7a.1.md` (the engine contract: check ids,
  statuses, example fields — the engine is already written; read it in `js/core/gtfs-schedule.js`, search `function feedHealth`).
- `js/projects/gtfs-service-analysis.js`: `_activeTab`, `function emptyHint`, `function renderState`,
  `function switchTab`, `function runService`, `function checkStale`, `function clearAll`, `var H = {`,
  `function csvButton`, `function sortHead`, `.gsa-caret` / `gsa-detail` (expand-row pattern in
  `renderServiceResults`), `App.cache.registerModule(MODULE_ID`.
- `projects/gtfs-service-analysis-popup.html` (tab bar and panes).
- `js/projects/gtfs.js`: search `App.gtfsSetHealth`, `App.gtfsToday`, `App.gtfsShapeCoords` (hooks written by Opus; use them, do not change them).
- `css/style.css`: the `/* --- GTFS Service Analysis (.gsa-) --- */` block; status tokens `--warn-text`, `--danger`.
- `test/browser/gtfs-service-analysis.test.mjs` (how the mini feed is loaded and the panel opened; copy that setup).

## 3. Files you may change
- `projects/gtfs-service-analysis-popup.html`
- `js/projects/gtfs-service-analysis.js`
- `css/style.css` (only new `.gsa-health*` rules, appended at the end of the `.gsa-` block)
- `test/browser/gtfs-feed-health.test.mjs` (new)
- `docs/reference/modules/gtfs-service-analysis.md` (add a "Feed health" section)

## 4. Contract
- ES5 in `js/`. Modern JS in the test.
- Tab: `<button type="button" class="rf-tab" data-tab="health">Feed health</button>` after the Stops tab button.
  Pane `<div class="rf-tab-content" data-tab="health">` after the Stops pane, containing a short intro line
  `<p class="tiny u-muted">Read-only checks of the loaded feed. They never change the feed or block an analysis.</p>`,
  `<div class="module-input-actions"><button type="button" id="gsaRunHealth" class="rf-action-primary">Check feed</button></div>`
  and `<div id="gsaHealthResults"></div>`.
- `_activeTab` takes `"service" | "stops" | "health"` everywhere (switchTab, renderState, emptyHint, session
  apply: an unknown saved value means `"service"`). Make the per-tab lookups table-driven, not nested ternaries.
- State: `var _healthResult = null; // { feed, checks, today, ms }`. In `checkStale()`, a health result whose
  feed is no longer `feed()` is dropped exactly like the other two results (same `if`, re-render its pane empty);
  there is no health stale state.
- `emptyHint()` for the health tab: `{ need: "No feed check yet.", action: "Press Check feed." }` (no-feed hint unchanged).
- `runHealth()`: no feed → `renderState()` and return. Otherwise `setStatus("Checking feed…", "running")`, then
  in `setTimeout(…, 0)` (so the status paints): `checks = G.feedHealth(f, { today: App.gtfsToday(), shapes: App.gtfsShapeCoords(), maxExamples: 20 }).checks`;
  on throw: `console.error` + `setStatus("Feed check failed: " + message, "error")` and stop. On success store
  `_healthResult`, call `App.gtfsSetHealth(f, checks)`, render, `renderState()`.
- `clearAll()` also resets `_healthResult` and calls `App.gtfsSetHealth(null)`. Session `apply`
  sets `_healthResult = null` like the other results (results are not saved).
- Results (`renderHealthResults(el, result)`; empty `el` when result is null):
  - A table `class="gtfs-dt-table gsa-health-table"` inside `.gsa-table-wrap`, header `Check | Result | Found | Checked`,
    one row per check in engine order. Row 1st cell: a `.gsa-caret` button (▸/▾, `aria-expanded`) when
    `examples.length > 0`, then the label. 2nd cell: a pill `<span class="gsa-health-pill gsa-health-<status>">`
    with text `OK` / `Warning` / `Error` / `Not checked`, then the result text. 3rd: `count` (locale number).
    4th: `checked` (locale number; `—` when status is unknown).
  - Result text: expiry → `state "expired"`: `"Ended " + iso(endDate) + ", " + (-daysLeft) + " days ago"`;
    `"7days"`/`"30days"`: `"Ends " + iso + ", in " + daysLeft + " days"`; `"ok"`: `"Ends " + iso + " (" + daysLeft + " days left)"`;
    `"unknown"`: the note. Use "day" when the number is 1. Every other check: `"None found"` when count 0,
    otherwise `count + " found"`; unknown → the note.
  - Expanded row: a `tr.gsa-detail` with one `td colspan=4` holding a `table.gtfs-dt-table.gsa-sub-table` of the
    examples, columns by check id:
    expiry `End date | Date from | Days left` (`Date from` = `feed_info.txt` or `calendar`);
    shapes `Trip | Route | shape_id` (blank shape_id shows `(blank)`); wheelchair `Stop`;
    speed `Trip | Route | From | To | km/h | Limit km/h`; shapeDistance `Stop | shape_id | Metres`;
    times `Trip | Sequence | Stop`; agency `Route`.
    Stops show `H.stopName(id) + " (" + id + ")"`, routes `H.routeName(id)`. Below the sub-table: when
    `count > examples.length`, `"Showing the first " + examples.length + " of " + count + "."`; and the check's note if any.
  - Under the table: `note()` lines: `"Thresholds follow the MobilityData GTFS validator: stops more than 100 m from their shape; speeds above the validator's limit for the route type; arrival before the previous departure."`
    and, when the expiry example's source is `"calendar"`, `"The end date comes from the calendar because feed_info.txt has none."`.
    Then `"Checked " + iso(today) + " in " + ms + " ms."`.
  - A CSV button (`csvButton`) → `feed-health.csv`: header lines `["GTFS feed health", "Checked: " + iso(today)]`,
    columns `check, status, found, checked, examples`; `examples` = the example objects joined by `" | "`, each as
    `key=value` pairs joined by `"; "` in the object's key order.
- CSS: `.gsa-health-pill` (inline-block, small caps-free text, `font-size: var(--text-xs)`, `padding: 0 6px`,
  `border-radius: var(--radius-sm)`, `margin-right: var(--space-1)`, `border: 1px solid var(--border)`);
  `-ok` uses `color: var(--text-secondary)`; `-warning` `color: var(--warn-text); background: var(--warn-bg); border-color: var(--warn-bd)`;
  `-error` `color: var(--danger); background: var(--danger-soft); border-color: var(--danger)`; `-unknown` `color: var(--text-secondary)`.
  Dark mode inherits through the tokens (do not add hex values).

## 5. Edge cases
1. No feed loaded: button press shows the standard no-feed empty hint, no throw.
2. Feed replaced or removed after a check: the result is dropped (empty hint again); the GTFS Overview line hides
   itself (gtfs.js compares the feed).
3. A check with `count > 0` but `maxExamples` reached: the "Showing the first" line appears.
4. Expanding one row does not collapse others; state is kept in `_ui` like the service table's expansions, keyed by check id.
5. Tab switch away and back keeps the rendered result.

## 6. Placement
Popup: as described in §4. JS: `runHealth` next to `runStops`; `renderHealthResults` after the Stops renderers.
Wire the button in `init()` next to `on("gsaRunStops", …)`; render in `onOpen()` next to the other two.

## 7. Steps
1. Markup. 2. Generalise the tab code. 3. State, run, clear, session. 4. Renderer + CSV. 5. CSS. 6. Test. 7. Doc section.

## 8. Done when
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-feed-health.test.mjs` ends `PASS — 9/9 checks passed`:
  1. `tab-present`: three tabs, the third labelled "Feed health".
  2. `empty-hint`: before a run the health tab shows "No feed check yet."
  3. `seven-rows`: after Check feed, 7 rows with labels in engine order.
  4. `counts-match-engine`: each row's Found equals `GtfsSchedule.feedHealth(App.gtfsSchedule(), {today: App.gtfsToday(), shapes: App.gtfsShapeCoords()}).checks[i].count` evaluated in the page.
  5. `expand-examples`: clicking the caret of the first row that has one shows a sub-table with ≥ 1 body row.
  6. `overview-line`: `#gtfsHealth` is not hidden and its text starts with "Feed health:".
  7. `csv`: the CSV text (capture it by stubbing `URL.createObjectURL` or the module's download path the way the existing GSA test does) has 2 `#` lines, a header line and 7 data lines.
  8. `dropped-on-new-feed`: loading the mini feed again (a new feed object) empties `#gsaHealthResults`, shows "No feed check yet." and hides `#gtfsHealth`.
  9. `clear`: after another Check feed, `App.clearGTFS()` empties `#gsaHealthResults`.
  With `GSA_SHOTS_DIR` set, save `feed-health-light.png` and `feed-health-dark.png` of the open panel with one row expanded.
- `NODE_PATH=/opt/node-tools/node_modules node test/browser/gtfs-service-analysis.test.mjs` still ends `PASS — 19/19 checks passed`.
- `node test/run-golden.mjs` ends with `PASS`.

## 9. Stop and report if
- The engine's output differs from card A7a.1's contract.
- The existing GSA test needs any change.
- You need a change in `gtfs.js` or any file not listed.
